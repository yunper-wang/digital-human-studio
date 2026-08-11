// tests/drama-routes-assets.test.mjs
// M7 资产素材引用与外观锁编辑端点
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createMaterialStore } from "../lib/drama/materials.mjs";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject, normalizeAnalysis } from "../lib/drama/schema.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; return res; }

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const MP3_DATA_URL = `data:audio/mpeg;base64,${Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]).toString("base64")}`;

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-ra-"));
  const store = createDramaStore(dataRoot);
  const project = store.save(createDramaProject({ title: "t", script: "剧本内容".repeat(15) }));
  store.update(project.id, (p) => {
    p.analysis = normalizeAnalysis({
      synopsis: "s", genre: "g",
      characters: [{ id: "char-1", name: "林晚", appearance: "young woman" }],
      scenes: [{ id: "scene-1", name: "便利店门口", appearance: "store front" }],
      props: [{ id: "prop-1", name: "雨伞", appearance: "black umbrella" }]
    });
  });
  const materialStore = createMaterialStore(dataRoot);
  const ctx = {
    sendJson: (res, s, b) => res.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store, materialStore,
    comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}
  };
  return { ctx, project, materialStore, dataRoot };
}

test("资产引用与外观锁编辑：场景参考图 + 角色配音参考 + 外观锁", async () => {
  const { ctx, project, materialStore, dataRoot } = setup();
  const img = materialStore.register({ name: "街景", dataUrl: PNG_DATA_URL });
  const audio = materialStore.register({ name: "雨声", dataUrl: MP3_DATA_URL });
  const res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({
    scenes: [{ id: "scene-1", refMaterialId: img.id, appearance: "rainy store front, neon" }],
    characters: [{ id: "char-1", refAudioMaterialId: audio.id }]
  }) }, res, new URL(`http://x/api/drama/projects/${project.id}/analysis/assets`), ctx);
  assert.equal(res.statusCode, 200);
  const a = res.body.data.project.analysis;
  assert.equal(a.scenes[0].refMaterialId, img.id);
  assert.equal(a.scenes[0].appearance, "rainy store front, neon");
  assert.equal(a.characters[0].refAudioMaterialId, audio.id);
  // 置 null 解除引用
  const res2 = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ scenes: [{ id: "scene-1", refMaterialId: null }] }) }, res2, new URL(`http://x/api/drama/projects/${project.id}/analysis/assets`), ctx);
  assert.equal(res2.body.data.project.analysis.scenes[0].refMaterialId, null);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("引用校验：类型不符/素材不存在 → 422；无分析 → 409", async () => {
  const { ctx, project, materialStore, dataRoot } = setup();
  const audio = materialStore.register({ name: "雨声", dataUrl: MP3_DATA_URL });
  let res = mockRes();
  // 场景引用音频 → 类型不符
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ scenes: [{ id: "scene-1", refMaterialId: audio.id }] }) }, res, new URL(`http://x/api/drama/projects/${project.id}/analysis/assets`), ctx);
  assert.equal(res.statusCode, 422);
  // 不存在素材
  res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ scenes: [{ id: "scene-1", refMaterialId: "mat-00000000-0000-0000-0000-000000000000" }] }) }, res, new URL(`http://x/api/drama/projects/${project.id}/analysis/assets`), ctx);
  assert.equal(res.statusCode, 422);
  // 无分析项目
  const p2 = ctx.store.save(createDramaProject({ title: "t2", script: "剧本内容".repeat(15) }));
  res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ scenes: [] }) }, res, new URL(`http://x/api/drama/projects/${p2.id}/analysis/assets`), ctx);
  assert.equal(res.statusCode, 409);
  rmSync(dataRoot, { recursive: true, force: true });
});
