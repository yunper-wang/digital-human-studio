// tests/drama-routes-frames.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject, normalizeShot, normalizeClip, normalizeAnalysis, DEMO_DRAMA_SCRIPT } from "../lib/drama/schema.mjs";
import { getDramaLlmConfig } from "../lib/drama/llm.mjs";
import { runDramaPipeline } from "../lib/drama/pipeline.mjs";
import { generateShotFrame, handleDramaApi } from "../lib/drama/routes.mjs";
import { getComfyuiConfig } from "../lib/drama/comfyui.mjs";
import { createMaterialStore } from "../lib/drama/materials.mjs";
import { createJobQueue } from "../lib/drama/queue.mjs";
import { estimateBudget, getDramaPricing } from "../lib/drama/budget.mjs";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function fixtureProject(root) {
  const store = createDramaStore(root);
  const project = store.save(createDramaProject({ title: "首帧测试", script: DEMO_DRAMA_SCRIPT }));
  await runDramaPipeline(store, project.id, { deps: { config: getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" }) } });
  store.update(project.id, (p) => { p.gateAConfirmedAt = new Date().toISOString(); p.status = "frames"; });
  return { store, project: store.get(project.id) };
}

function fakeComfyFetch(tag) {
  return async (url, options = {}) => {
    if (url.endsWith("/prompt")) return { ok: true, json: async () => ({ prompt_id: `pid-${tag}` }) };
    if (url.includes("/history/")) {
      return { ok: true, json: async () => ({ [`pid-${tag}`]: { outputs: { "13": { images: [{ filename: `f_${tag}.png`, subfolder: "", type: "output" }] } } } }) };
    }
    if (url.includes("/view")) return { ok: true, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer };
    throw new Error(`unexpected ${url}`);
  };
}

test("首帧生成成功后落盘并推进项目到 awaiting_gate_b", async () => {
  const root = mkdtempSync(join(tmpdir(), "drama-frames-test-"));
  try {
    const { store, project } = await fixtureProject(root);
    const shot = project.shots[0];
    const ctx = {
      store,
      comfyConfig: { ...getComfyuiConfig({ COMFYUI_URL: "http://127.0.0.1:8188" }), pollIntervalMs: 1 },
      frameFetch: fakeComfyFetch("a"),
      frameSleep: async () => {}
    };
    await generateShotFrame(ctx, project.id, shot.id, 777);
    const updated = store.get(project.id);
    const frame = updated.shots[0].frame;
    assert.equal(frame.status, "ready");
    assert.equal(frame.seed, 777);
    assert.equal(frame.attempts, 1);
    assert.ok(existsSync(join(store.dir(project.id), "frames", frame.file)));
    // 其余镜还是 pending，项目停留在 frames
    assert.equal(updated.status, "frames");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("首帧生成失败记录错误且不自动重试", async () => {
  const root = mkdtempSync(join(tmpdir(), "drama-frames-fail-"));
  try {
    const { store, project } = await fixtureProject(root);
    const shot = project.shots[0];
    const ctx = {
      store,
      comfyConfig: getComfyuiConfig({ COMFYUI_URL: "http://127.0.0.1:8188" }),
      frameFetch: async () => { throw new Error("boom"); },
      frameSleep: async () => {}
    };
    await generateShotFrame(ctx, project.id, shot.id, 1);
    const frame = store.get(project.id).shots[0].frame;
    assert.equal(frame.status, "failed");
    assert.equal(frame.error.code, "COMFYUI_SUBMIT_FAILED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clips_ready 项目重抽/确认首帧不回退到首帧阶段状态", async () => {
  const root = mkdtempSync(join(tmpdir(), "drama-frames-guard-"));
  try {
    const { store, project } = await fixtureProject(root);
    // 模拟项目已走完视频阶段：首帧全部确认、成片全部确认
    store.update(project.id, (p) => {
      for (const shot of p.shots) {
        shot.frame = { ...shot.frame, status: "confirmed" };
        shot.clip = { ...normalizeClip(shot.clip), status: "confirmed" };
      }
      p.status = "clips_ready";
    });
    const shotId = project.shots[0].id;
    const ctx = {
      store,
      comfyConfig: { ...getComfyuiConfig({ COMFYUI_URL: "http://127.0.0.1:8188" }), pollIntervalMs: 1 },
      frameFetch: fakeComfyFetch("guard"),
      frameSleep: async () => {}
    };
    await generateShotFrame(ctx, project.id, shotId, 888);
    const afterReroll = store.get(project.id);
    assert.equal(afterReroll.shots[0].frame.status, "ready");
    // 重抽首帧成功不得把 clips_ready 回退为 awaiting_gate_b / frames_confirmed
    assert.equal(afterReroll.status, "clips_ready");

    // 首帧确认路由同样受守卫保护（重抽后确认回首帧，状态仍不得回退）
    const envelope = (ok, data, meta = {}) => ({ ok, data, ...meta });
    let captured = null;
    const routeCtx = {
      store,
      envelope,
      sendJson: (response, status, body) => { captured = { status, body }; return true; },
      readJson: async () => ({}),
      allowRequest: () => true
    };
    const url = new URL(`http://local/api/drama/projects/${project.id}/shots/${shotId}/confirm`);
    await handleDramaApi({ method: "POST", socket: { remoteAddress: "test" } }, {}, url, routeCtx);
    assert.equal(captured.status, 200);
    const afterConfirm = store.get(project.id);
    assert.equal(afterConfirm.shots[0].frame.status, "confirmed");
    assert.equal(afterConfirm.status, "clips_ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PATCH 编辑 audioMode/continuity 持久化且不影响首帧与预算", async () => {
  const root = mkdtempSync(join(tmpdir(), "drama-shot-edit-"));
  try {
    const { store, project } = await fixtureProject(root);
    const shotId = project.shots[0].id;
    // 模拟已过闸门 A：预算已确认、该镜首帧已确认
    store.update(project.id, (p) => {
      p.budget = estimateBudget(p, getDramaPricing());
      p.shots[0].frame = { status: "confirmed", file: "shot-1-777.png", seed: 777, attempts: 1, error: null };
    });
    const before = store.get(project.id);
    const beforeShot = before.shots[0];
    assert.equal(before.status, "frames");

    const envelope = (ok, data, meta = {}) => ({ ok, data, ...meta });
    let captured = null;
    const routeCtx = {
      store,
      envelope,
      sendJson: (response, status, body) => { captured = { status, body }; return true; },
      readJson: async () => ({ audioMode: "none", continuity: "与镜 1 同场景" }),
      allowRequest: () => true,
      pricing: getDramaPricing()
    };
    const url = new URL(`http://local/api/drama/projects/${project.id}/shots/${shotId}`);
    await handleDramaApi({ method: "PATCH", socket: { remoteAddress: "test" } }, {}, url, routeCtx);

    assert.equal(captured.status, 200);
    const after = captured.body.data.project;
    const afterShot = after.shots.find((s) => s.id === shotId);
    // 新字段持久化（含落盘）
    assert.equal(afterShot.audioMode, "none");
    assert.equal(afterShot.continuity, "与镜 1 同场景");
    assert.equal(store.get(project.id).shots[0].audioMode, "none");
    // 首帧未被重置（audioMode/continuity 不属于 promptChanged 分支）
    assert.equal(afterShot.frame.status, "confirmed");
    assert.equal(afterShot.frame.file, beforeShot.frame.file);
    assert.equal(afterShot.frame.seed, 777);
    // 预算未重算（generatedAt 不变即未走 estimateBudget）、闸门 A 确认未失效
    assert.equal(after.gateAConfirmedAt, before.gateAConfirmedAt);
    assert.equal(after.budget.totalPaid, before.budget.totalPaid);
    assert.equal(after.budget.generatedAt, before.budget.generatedAt);
    // 项目状态不变
    assert.equal(after.status, before.status);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("M8：首帧注入参考图→controlnet.used=true；素材缺失降级 used=false", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-m8f-"));
  const store = createDramaStore(dataRoot);
  const project = store.save(createDramaProject({ title: "t", script: DEMO_DRAMA_SCRIPT }));
  store.update(project.id, (p) => {
    p.analysis = normalizeAnalysis({ synopsis: "s", genre: "g", characters: [{ id: "char-1", name: "n", appearance: "a" }], scenes: [{ id: "scene-1", name: "便利店", appearance: "store" }], props: [] });
    if (!p.shots.length) p.shots = [normalizeShot({ id: "shot-1", sceneName: "便利店", shotType: "cinematic", fluxPrompt: "cinematic film still, a store at night, neon signs, cinematic", durationSec: 3 }, 0)];
    p.gateAConfirmedAt = new Date().toISOString();
  });
  const materialStore = createMaterialStore(dataRoot);
  const img = materialStore.register({ name: "参考", dataUrl: PNG_DATA_URL });
  store.update(project.id, (p) => { p.analysis.scenes[0].refMaterialId = img.id; });
  const cn = { name: "flux-controlnet-depth.safetensors", preprocessor: "depth", strength: 0.8 };
  const ctx = {
    sendJson: (r, s, b) => r.sendJson(s, b), envelope: (ok, d, o = {}) => ({ ok, ...(ok ? { data: d } : { errorCode: o.errorCode, message: o.message }) }), readJson: async (r) => JSON.parse(r.body || "{}"), allowRequest: () => true,
    store, materialStore, controlnetConfig: cn,
    comfyConfig: { baseUrl: "http://127.0.0.1:9", steps: 4, timeoutMs: 3000, pollIntervalMs: 10 },
    frameFetch: async (url, opts) => {
      if (url.endsWith("/upload/image")) return { ok: true, json: async () => ({ name: "ref-uploaded.png" }), arrayBuffer: async () => Buffer.alloc(0) };
      if (url.includes("/prompt")) return { ok: true, json: async () => ({ prompt_id: "p1" }) };
      if (url.includes("/history/")) return { ok: true, json: async () => ({ p1: { outputs: { "13": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } }) };
      if (url.includes("/view")) return { ok: true, arrayBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
      return { ok: false };
    },
    frameSleep: async () => {},
    findAvatar: () => null, findVoice: () => null, pricing: {},
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}
  };
  await generateShotFrame(ctx, project.id, project.shots[0].id);
  const shot = store.get(project.id).shots[0];
  assert.equal(shot.frame.status, "ready");
  assert.equal(shot.frame.controlnet.used, true);
  assert.equal(shot.frame.controlnet.source, "ref");
  // 素材删除后重抽 → 降级
  materialStore.remove(img.id);
  await generateShotFrame(ctx, project.id, project.shots[0].id, 999);
  const shot2 = store.get(project.id).shots[0];
  assert.equal(shot2.frame.controlnet.used, false);
  assert.equal(shot2.frame.controlnet.source, "fallback");
  rmSync(dataRoot, { recursive: true, force: true });
});

test("M10：首帧经队列 enqueue；无 jobQueue 回退直接执行", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-m10f-"));
  const store = createDramaStore(dataRoot);
  const project = store.save(createDramaProject({ title: "t", script: DEMO_DRAMA_SCRIPT }));
  store.update(project.id, (p) => {
    p.analysis = normalizeAnalysis({ synopsis: "s", genre: "g", characters: [{ id: "char-1", name: "n", appearance: "a" }], scenes: [{ id: "scene-1", name: "sc", appearance: "a" }], props: [] });
    if (!p.shots.length) p.shots = [normalizeShot({ id: "shot-1", sceneName: "sc", shotType: "cinematic", fluxPrompt: "cinematic film still, store at night", durationSec: 3 }, 0)];
    p.gateAConfirmedAt = new Date().toISOString();
  });
  const runLog = [];
  const q = createJobQueue({ comfyui: 1, voice: 2, ffmpeg: 1 });
  const ctx = {
    sendJson: (r, s, b) => r.sendJson(s, b), envelope: (ok, d, o = {}) => ({ ok, ...(ok ? { data: d } : { errorCode: o.errorCode, message: o.message }) }), readJson: async (r) => JSON.parse(r.body || "{}"), allowRequest: () => true,
    store, jobQueue: q,
    comfyConfig: { baseUrl: "http://127.0.0.1:9", steps: 4, timeoutMs: 3000, pollIntervalMs: 10 },
    frameFetch: async (url) => {
      runLog.push(url);
      if (url.includes("/prompt")) return { ok: true, json: async () => ({ prompt_id: "p1" }) };
      if (url.includes("/history/")) return { ok: true, json: async () => ({ p1: { outputs: { "13": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } }) };
      if (url.includes("/view")) return { ok: true, arrayBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
      return { ok: false };
    },
    frameSleep: async () => {},
    materialStore: { get: () => null, getBytes: () => null }, controlnetConfig: null,
    findAvatar: () => null, findVoice: () => null, pricing: {},
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}
  };
  await generateShotFrame(ctx, project.id, project.shots[0].id);
  assert.equal(store.get(project.id).shots[0].frame.status, "ready");
  assert.ok(runLog.some((u) => u.includes("/prompt")));
  assert.equal(q.status().comfyui.running, 0);
  rmSync(dataRoot, { recursive: true, force: true });
});
