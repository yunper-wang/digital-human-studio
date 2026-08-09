// tests/drama-comfyui-video.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getComfyuiConfig, loadVideoWorkflowTemplate, buildVideoWorkflow,
  uploadComfyuiImage, generateComfyuiVideo
} from "../lib/drama/comfyui.mjs";

const config = getComfyuiConfig({ COMFYUI_URL: "http://127.0.0.1:8188" });

const template = {
  "_说明": "文档键，提交前必须被剥离",
  "1": { class_type: "LoadImage", inputs: { image: "{{IMAGE}}" } },
  "2": { class_type: "SomeI2VNode", inputs: { prompt: "前缀 {{PROMPT}} 后缀", image: ["1", 0], seed: "{{SEED}}", num_frames: "{{FRAMES}}" } },
  "3": { class_type: "SomeSaveNode", inputs: { video: ["2", 0], filename_prefix: "drama" } }
};

test("loadVideoWorkflowTemplate 剥离文档键；缺失/非法返回 null", () => {
  const root = mkdtempSync(join(tmpdir(), "drama-tpl-"));
  try {
    assert.equal(loadVideoWorkflowTemplate({ DRAMA_VIDEO_WORKFLOW: join(root, "missing.json") }), null);
    const file = join(root, "tpl.json");
    writeFileSync(file, JSON.stringify(template));
    const loaded = loadVideoWorkflowTemplate({ DRAMA_VIDEO_WORKFLOW: file });
    assert.equal(loaded._说明, undefined);
    assert.equal(loaded["1"].class_type, "LoadImage");
    writeFileSync(file, "{ not json");
    assert.equal(loadVideoWorkflowTemplate({ DRAMA_VIDEO_WORKFLOW: file }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildVideoWorkflow 整值占位符写入类型化值，嵌入串做字符串替换", () => {
  const built = buildVideoWorkflow(template, {
    PROMPT: "slow push in", IMAGE: "shot-1.png", SEED: 42, FRAMES: 96, WIDTH: 768, HEIGHT: 1344, FPS: 24
  });
  assert.equal(built["1"].inputs.image, "shot-1.png");
  assert.equal(built["2"].inputs.prompt, "前缀 slow push in 后缀");
  assert.strictEqual(built["2"].inputs.seed, 42); // number，不是字符串
  assert.strictEqual(built["2"].inputs.num_frames, 96);
  assert.deepEqual(built["2"].inputs.image, ["1", 0]); // 引用不动
  assert.equal(template["2"].inputs.seed, "{{SEED}}"); // 模板不被污染
});

test("uploadComfyuiImage 以 multipart 上传并返回文件名", async () => {
  let seenBody = null;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/upload/image")) {
      seenBody = options.body;
      return { ok: true, json: async () => ({ name: "drama-shot-1.png" }) };
    }
    throw new Error(`unexpected ${url}`);
  };
  const name = await uploadComfyuiImage({ config, bytes: Buffer.from([1, 2, 3]), filename: "drama-shot-1.png", fetchImpl });
  assert.equal(name, "drama-shot-1.png");
  assert.ok(seenBody instanceof FormData); // undici 自动带 boundary
});

test("generateComfyuiVideo 提交→轮询→定位 mp4→下载", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push(url);
    if (url.endsWith("/prompt")) return { ok: true, json: async () => ({ prompt_id: "vid-1" }) };
    if (url.includes("/history/vid-1")) {
      return { ok: true, json: async () => ({ "vid-1": { outputs: { "3": { gifs: [{ filename: "drama_00001.mp4", subfolder: "", type: "output", format: "video/mp4" }] } } } }) };
    }
    if (url.includes("/view")) return { ok: true, arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer };
    throw new Error(`unexpected ${url}`);
  };
  const bytes = await generateComfyuiVideo({
    config, template, values: { PROMPT: "p", IMAGE: "i.png", SEED: 1, FRAMES: 24, WIDTH: 768, HEIGHT: 1344, FPS: 24 },
    fetchImpl, sleep: async () => {}, clientId: "t"
  });
  assert.deepEqual([...bytes], [9, 8, 7]);
  assert.ok(calls.some((u) => u.includes("/history/")));
  assert.ok(calls.some((u) => u.includes("drama_00001.mp4")));
});

test("无视频输出时抛 COMFYUI_OUTPUT_MISSING", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/prompt")) return { ok: true, json: async () => ({ prompt_id: "vid-2" }) };
    if (url.includes("/history/")) {
      return { ok: true, json: async () => ({ "vid-2": { outputs: { "3": { images: [{ filename: "only-image.png", subfolder: "", type: "output" }] } } } }) };
    }
    throw new Error("unexpected");
  };
  const fast = { ...config, videoTimeoutMs: 5, pollIntervalMs: 1 };
  await assert.rejects(
    generateComfyuiVideo({ config: fast, template, values: {}, fetchImpl, sleep: async () => {}, clientId: "t" }),
    (error) => ["COMFYUI_OUTPUT_MISSING", "COMFYUI_TIMEOUT"].includes(error.code)
  );
});
