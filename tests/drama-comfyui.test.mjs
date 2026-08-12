// tests/drama-comfyui.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { getComfyuiConfig, buildFluxWorkflow, generateFluxFrame, getComfyuiStatus, FRAME_SIZES } from "../lib/drama/comfyui.mjs";

const config = getComfyuiConfig({ COMFYUI_URL: "http://127.0.0.1:8188" });

test("buildFluxWorkflow 注入提示词/尺寸/种子且结构合法", () => {
  const workflow = buildFluxWorkflow({ prompt: "a rainy night", negativePrompt: "blur", width: 768, height: 1344, seed: 1234, config });
  assert.equal(workflow["6"].inputs.text, "a rainy night");
  assert.equal(workflow["7"].inputs.text, "blur");
  assert.equal(workflow["5"].inputs.width, 768);
  assert.equal(workflow["5"].inputs.height, 1344);
  assert.equal(workflow["3"].inputs.seed, 1234);
  assert.equal(workflow["3"].class_type, "KSampler");
  assert.equal(workflow["13"].class_type, "SaveImage");
  // 引用完整性：每个数组引用都指向存在的节点
  for (const node of Object.values(workflow)) {
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value)) assert.ok(workflow[value[0]], `missing node ${value[0]}`);
    }
  }
});

test("generateFluxFrame 走完 提交→轮询→取图 全流程", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push(`${options.method || "GET"} ${url}`);
    if (url.endsWith("/prompt")) {
      return { ok: true, json: async () => ({ prompt_id: "pid-1" }) };
    }
    if (url.includes("/history/pid-1")) {
      return { ok: true, json: async () => ({ "pid-1": { outputs: { "13": { images: [{ filename: "drama_00001_.png", subfolder: "", type: "output" }] } } } }) };
    }
    if (url.includes("/view")) {
      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }
    throw new Error(`unexpected ${url}`);
  };
  const bytes = await generateFluxFrame({
    config, prompt: "p", negativePrompt: "n", width: 768, height: 1344, seed: 1,
    fetchImpl, sleep: async () => {}, clientId: "test-client"
  });
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.ok(calls[0].startsWith("POST"));
  assert.ok(calls.some((c) => c.includes("/history/")));
  assert.ok(calls.some((c) => c.includes("/view")));
});

test("轮询超时抛 COMFYUI_TIMEOUT", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/prompt")) return { ok: true, json: async () => ({ prompt_id: "pid-2" }) };
    if (url.includes("/history/")) return { ok: true, json: async () => ({}) };
    throw new Error("unexpected");
  };
  const fastConfig = { ...config, timeoutMs: 5, pollIntervalMs: 1 };
  await assert.rejects(
    generateFluxFrame({ config: fastConfig, prompt: "p", negativePrompt: "", width: 1, height: 1, seed: 1, fetchImpl, sleep: async () => {}, clientId: "t" }),
    (error) => error.code === "COMFYUI_TIMEOUT" && error.retryable === true
  );
});

test("未配置时不发请求直接报 COMFYUI_UNAVAILABLE；状态检查保持纯净环境不变量", async () => {
  const empty = getComfyuiConfig({});
  assert.equal(empty.baseUrl, "");
  await assert.rejects(
    generateFluxFrame({ config: empty, prompt: "p", negativePrompt: "", width: 1, height: 1, seed: 1 }),
    (error) => error.code === "COMFYUI_UNAVAILABLE"
  );
  const status = await getComfyuiStatus(empty);
  assert.deepEqual(status, { configured: false, connected: false, state: "missing" });
});

test("画幅尺寸表覆盖三种比例", () => {
  assert.deepEqual(FRAME_SIZES.portrait, [768, 1344]);
  assert.deepEqual(FRAME_SIZES.landscape, [1344, 768]);
  assert.deepEqual(FRAME_SIZES.square, [1024, 1024]);
});

import { loadControlnetConfig } from "../lib/drama/comfyui.mjs";

test("M8 loadControlnetConfig 未配置返回 null；配置完整返回三字段", () => {
  assert.equal(loadControlnetConfig({}), null);
  assert.equal(loadControlnetConfig({ COMFYUI_CONTROLNET_NAME: "" }), null);
  const cfg = loadControlnetConfig({ COMFYUI_CONTROLNET_NAME: "flux-controlnet-depth.safetensors", COMFYUI_CONTROLNET_PREPROCESSOR: "canny", COMFYUI_CONTROLNET_STRENGTH: "0.9" });
  assert.deepEqual(cfg, { name: "flux-controlnet-depth.safetensors", preprocessor: "canny", strength: 0.9 });
  assert.equal(loadControlnetConfig({ COMFYUI_CONTROLNET_NAME: "x.safetensors" }).strength, 0.8); // 默认 0.8
  assert.equal(loadControlnetConfig({ COMFYUI_CONTROLNET_NAME: "x.safetensors" }).preprocessor, "depth"); // 默认 depth
});

test("M8 buildFluxWorkflow 无 refImage/controlnetConfig → 原工作流（无 ControlNet 节点）", () => {
  const wf = buildFluxWorkflow({ prompt: "p", width: 768, height: 1344, seed: 1, config });
  assert.ok(!wf["20"]);
  assert.equal(wf["3"].inputs.positive[0], "6"); // positive 仍直连 CLIPTextEncode
});

test("M8 buildFluxWorkflow 有 refImage+controlnetConfig → 含 ControlNet 节点且 positive 重连", () => {
  const cn = { name: "flux-controlnet-depth.safetensors", preprocessor: "depth", strength: 0.8 };
  const wf = buildFluxWorkflow({ prompt: "p", width: 768, height: 1344, seed: 1, config, refImage: "uploaded.png", controlnetConfig: cn });
  assert.ok(wf["20"], "含 LoadImage 节点");
  assert.equal(wf["20"].inputs.image, "uploaded.png");
  assert.ok(wf["21"], "含 ControlNet 预处理器节点");
  assert.ok(wf["22"], "含 ControlNetApply 节点");
  assert.equal(wf["3"].inputs.positive[0], "22"); // positive 重连到 ControlNetApply 输出
  for (const node of Object.values(wf)) {
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value)) assert.ok(wf[value[0]], `missing node ${value[0]}`);
    }
  }
});

test("M8 buildFluxWorkflow 有 refImage 但 controlnetConfig=null → 降级原工作流", () => {
  const wf = buildFluxWorkflow({ prompt: "p", width: 768, height: 1344, seed: 1, config, refImage: "x.png", controlnetConfig: null });
  assert.ok(!wf["20"]);
  assert.equal(wf["3"].inputs.positive[0], "6");
});
