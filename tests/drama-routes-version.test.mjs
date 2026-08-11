import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createDramaProject } from "../lib/drama/schema.mjs";
import { createDramaStore } from "../lib/drama/store.mjs";
import { runDramaPipeline, isPipelineRunning } from "../lib/drama/pipeline.mjs";
import { getDramaLlmConfig } from "../lib/drama/llm.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; return res; }

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rv-"));
  const store = createDramaStore(dataRoot);
  const project = createDramaProject({ title: "t", script: "原始剧本".repeat(20) });
  project.shots = [{ id: "shot-1", index: 1, dialogue: "台词", durationSec: 3 }];
  store.save(project);
  const ctx = {
    sendJson: (res, s, b) => res.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store, comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}
  };
  return { store, project, ctx, dataRoot };
}

test("版本：存→列→读→回滚 全链路", async () => {
  const { store, project, ctx, dataRoot } = setup();
  // 存
  let res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ name: "初版" }) }, res, new URL(`http://x/api/drama/projects/${project.id}/versions`), ctx);
  assert.equal(res.statusCode, 201);
  const verId = res.body.data.snapshot.id;
  // 列
  res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/versions`), ctx);
  assert.equal(res.body.data.versions.length, 1);
  // 改后回滚
  store.update(project.id, (p) => { p.script = "改动"; });
  res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: "{}" }, res, new URL(`http://x/api/drama/projects/${project.id}/versions/${verId}/rollback`), ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.project.script, "原始剧本".repeat(20));
  rmSync(dataRoot, { recursive: true, force: true });
});

test("回滚不存在的版本 → 404", async () => {
  const { project, ctx, dataRoot } = setup();
  const res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: "{}" }, res, new URL(`http://x/api/drama/projects/${project.id}/versions/ver-nope/rollback`), ctx);
  assert.equal(res.statusCode, 404);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("流水线运行中回滚 → 409", async () => {
  const { store, project, ctx, dataRoot } = setup();
  // 先存一个可回滚的版本
  let res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ name: "v1" }) }, res, new URL(`http://x/api/drama/projects/${project.id}/versions`), ctx);
  assert.equal(res.statusCode, 201);
  const verId = res.body.data.snapshot.id;
  // 构造流水线运行中：非 mock 配置 + 永不 resolve 的 fetch，使流水线悬挂在 analyze 阶段
  const hangDeps = {
    config: getDramaLlmConfig({ DRAMA_LLM_BASE_URL: "http://127.0.0.1:9", DRAMA_LLM_MODEL: "x" }),
    fetchImpl: () => new Promise(() => {}),
    sleep: async () => {}
  };
  runDramaPipeline(store, project.id, { deps: hangDeps }).catch(() => {});
  assert.equal(isPipelineRunning(project.id), true);
  res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: "{}" }, res, new URL(`http://x/api/drama/projects/${project.id}/versions/${verId}/rollback`), ctx);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.errorCode, "ROLLBACK_CONFLICT");
  rmSync(dataRoot, { recursive: true, force: true });
});

test("合成运行中回滚 → 409", async () => {
  const { store, project, ctx, dataRoot } = setup();
  let res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ name: "v1" }) }, res, new URL(`http://x/api/drama/projects/${project.id}/versions`), ctx);
  assert.equal(res.statusCode, 201);
  const verId = res.body.data.snapshot.id;
  store.update(project.id, (p) => { p.compose = { ...p.compose, status: "running" }; });
  res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: "{}" }, res, new URL(`http://x/api/drama/projects/${project.id}/versions/${verId}/rollback`), ctx);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.errorCode, "ROLLBACK_CONFLICT");
  rmSync(dataRoot, { recursive: true, force: true });
});