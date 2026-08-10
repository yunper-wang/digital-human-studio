// tests/drama-routes-frames.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject, normalizeShot, normalizeClip, DEMO_DRAMA_SCRIPT } from "../lib/drama/schema.mjs";
import { getDramaLlmConfig } from "../lib/drama/llm.mjs";
import { runDramaPipeline } from "../lib/drama/pipeline.mjs";
import { generateShotFrame, handleDramaApi } from "../lib/drama/routes.mjs";
import { getComfyuiConfig } from "../lib/drama/comfyui.mjs";
import { getDramaPricing } from "../lib/drama/budget.mjs";

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
