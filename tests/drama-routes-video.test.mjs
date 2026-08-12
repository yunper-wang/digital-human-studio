// tests/drama-routes-video.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject, normalizeShot, normalizeCharacter, normalizeClip, normalizeAnalysis, DEMO_DRAMA_SCRIPT } from "../lib/drama/schema.mjs";
import { generateShotClip, generateShotVoice } from "../lib/drama/routes.mjs";
import { getComfyuiConfig } from "../lib/drama/comfyui.mjs";
import { createMaterialStore } from "../lib/drama/materials.mjs";

const MP3_DATA_URL = `data:audio/mpeg;base64,${Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]).toString("base64")}`;

const fixture = fileURLToPath(new URL("./fixtures/fake-seedance-runner.mjs", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function fixtureProject(root, shotPatch = {}, charPatch = {}) {
  const store = createDramaStore(root);
  const project = store.save(createDramaProject({ title: "视频测试", script: DEMO_DRAMA_SCRIPT }));
  store.update(project.id, (p) => {
    p.analysis = { synopsis: "s", genre: "g", characters: [normalizeCharacter({ name: "林晚", appearance: "young woman", avatarId: "a1", voiceId: "v1", ...charPatch }, 0)], scenes: [] };
    p.shots = [normalizeShot({ shotType: "dialogue", dialogue: "这是一句足够长的口播台词内容。", characterIds: ["char-1"], ...shotPatch }, 0)];
    p.gateAConfirmedAt = new Date().toISOString();
    p.status = "frames_confirmed";
  });
  return { store, project: store.get(project.id) };
}

function seedanceCtx(store, root) {
  const avatarFile = join(root, "a.png");
  const voiceFile = join(root, "v.wav");
  writeFileSync(avatarFile, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  writeFileSync(voiceFile, Buffer.alloc(600, 1));
  return {
    store,
    seedanceConfig: {
      python: process.execPath, toolVault: fixture, runner: "ignored", model: "fake", projectRoot,
      accessors: {
        findAvatar: () => ({ id: "a1", name: "林晚", image: "/uploads/a.png", source: "local" }),
        trustedUploadPath: () => avatarFile,
        findVoice: () => ({ id: "v1", name: "音色", previewPath: voiceFile, ttsReady: true })
      }
    }
  };
}

test("口播镜：伪 runner 全链路产出 clip 并推进项目状态", async () => {
  const root = mkdtempSync(join(tmpdir(), "drama-video-dialogue-"));
  try {
    const { store, project } = fixtureProject(root);
    await generateShotClip(seedanceCtx(store, root), project.id, "shot-1");
    const shot = store.get(project.id).shots[0];
    assert.equal(shot.clip.status, "ready");
    assert.equal(shot.clip.provider, "seedance2");
    assert.equal(shot.clip.providerTaskId, "fake-task-1");
    assert.equal(shot.clip.attempts, 1);
    assert.ok(existsSync(join(store.dir(project.id), "clips", shot.clip.file)));
    assert.equal(store.get(project.id).status, "videos"); // 还有 clip 未 confirmed
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("口播镜：runner 失败落 failed 不自动重试", async () => {
  const root = mkdtempSync(join(tmpdir(), "drama-video-fail-"));
  try {
    const { store, project } = fixtureProject(root);
    process.env.FAKE_RUNNER_MODE = "fail";
    await generateShotClip(seedanceCtx(store, root), project.id, "shot-1");
    const clip = store.get(project.id).shots[0].clip;
    assert.equal(clip.status, "failed");
    assert.equal(clip.error.code, "SEEDANCE_GENERATION_FAILED");
    assert.equal(clip.attempts, 0); // 失败不计 attempts
  } finally {
    delete process.env.FAKE_RUNNER_MODE;
    rmSync(root, { recursive: true, force: true });
  }
});

test("剧情镜：模板 + 上传 + 生成 + 落盘", async () => {
  const root = mkdtempSync(join(tmpdir(), "drama-video-cinematic-"));
  try {
    const { store, project } = fixtureProject(root, { shotType: "cinematic", dialogue: "", fluxPrompt: "cinematic still, rain" });
    store.update(project.id, (p) => {
      p.shots[0].frame = { status: "confirmed", file: "shot-1-7.png", seed: 7, attempts: 1, error: null };
      p.shots[0].motionPrompt = "slow push in, rain falling";
    });
    writeFileSync(join(store.dir(project.id), "frames", "shot-1-7.png"), Buffer.from([1, 2, 3]));
    const tplFile = join(root, "tpl.json");
    writeFileSync(tplFile, JSON.stringify({ "1": { class_type: "LoadImage", inputs: { image: "{{IMAGE}}" } } }));
    const fetchImpl = async (url, options = {}) => {
      if (url.endsWith("/upload/image")) return { ok: true, json: async () => ({ name: "uploaded.png" }) };
      if (url.endsWith("/prompt")) return { ok: true, json: async () => ({ prompt_id: "vid-1" }) };
      if (url.includes("/history/")) {
        return { ok: true, json: async () => ({ "vid-1": { outputs: { "9": { videos: [{ filename: "out.mp4", subfolder: "", type: "output" }] } } } }) };
      }
      if (url.includes("/view")) return { ok: true, arrayBuffer: async () => new Uint8Array([5, 5, 5]).buffer };
      throw new Error(`unexpected ${url}`);
    };
    const ctx = {
      store,
      comfyConfig: { ...getComfyuiConfig({ COMFYUI_URL: "http://127.0.0.1:8188" }), pollIntervalMs: 1 },
      videoEnv: { DRAMA_VIDEO_WORKFLOW: tplFile },
      frameFetch: fetchImpl,
      frameSleep: async () => {}
    };
    await generateShotClip(ctx, project.id, "shot-1");
    const shot = store.get(project.id).shots[0];
    assert.equal(shot.clip.status, "ready");
    assert.equal(shot.clip.provider, "comfyui");
    assert.deepEqual([...readFileSync(join(store.dir(project.id), "clips", shot.clip.file))], [5, 5, 5]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("M8：口播注入参考音频→clip.voiceRef.used=true；缺失降级 used=false", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-m8v-"));
  const store = createDramaStore(dataRoot);
  const project = store.save(createDramaProject({ title: "t", script: DEMO_DRAMA_SCRIPT }));
  store.update(project.id, (p) => {
    p.analysis = normalizeAnalysis({ synopsis: "s", genre: "g", characters: [{ id: "char-1", name: "n", appearance: "a", avatarId: "av1", voiceId: "v1" }], scenes: [], props: [] });
    if (!p.shots.length) p.shots = [normalizeShot({ id: "shot-1", shotType: "dialogue", characterIds: ["char-1"], dialogue: "你好世界", durationSec: 3, audioMode: "voice" }, 0)];
    p.gateAConfirmedAt = new Date().toISOString();
  });
  const materialStore = createMaterialStore(dataRoot);
  const audio = materialStore.register({ name: "参考音", dataUrl: MP3_DATA_URL });
  store.update(project.id, (p) => { p.analysis.characters[0].refAudioMaterialId = audio.id; });
  const ctx = {
    sendJson: (r, s, b) => r.sendJson(s, b), envelope: (ok, d, o = {}) => ({ ok, ...(ok ? { data: d } : { errorCode: o.errorCode, message: o.message }) }), readJson: async (r) => JSON.parse(r.body || "{}"), allowRequest: () => true,
    store, materialStore,
    findAvatar: (id) => id === "av1" ? { id: "av1" } : null,
    findVoice: (id) => id === "v1" ? { id: "v1", provider: "elevenlabs" } : null,
    audioDeps: { elevenKey: "sk-x", fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.alloc(800) }) },
    comfyConfig: {}, pricing: {}, seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, controlnetConfig: null
  };
  await generateShotVoice(ctx, project.id, project.shots[0].id);
  const shot = store.get(project.id).shots[0];
  assert.equal(shot.clip.audio.status, "ready");
  assert.equal(shot.clip.voiceRef.used, true);
  assert.equal(shot.clip.voiceRef.materialId, audio.id);
  // 删素材后重生成 → 降级
  materialStore.remove(audio.id);
  await generateShotVoice(ctx, project.id, project.shots[0].id);
  assert.equal(store.get(project.id).shots[0].clip.voiceRef.used, false);
  rmSync(dataRoot, { recursive: true, force: true });
});
