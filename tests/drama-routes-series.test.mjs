import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createSeriesStore } from "../lib/drama/series.mjs";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject } from "../lib/drama/schema.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; return res; }

function ctx(dataRoot) {
  return {
    sendJson: (res, s, b) => res.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store: { get: () => null, dir: () => dataRoot, update: (id, fn) => null, list: () => [], save: () => {} },
    seriesStore: createSeriesStore(dataRoot),
    comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}
  };
}

test("剧集：建→列→加集→同步资产→移出", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rs-"));
  const c = ctx(dataRoot);
  let res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ title: "雨夜系列" }) }, res, new URL("http://x/api/drama/series"), c);
  assert.equal(res.statusCode, 201);
  const sid = res.body.data.series.id;

  res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL("http://x/api/drama/series"), c);
  assert.equal(res.body.data.series.length, 1);

  res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ projectId: "drama-1" }) }, res, new URL(`http://x/api/drama/series/${sid}/projects`), c);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.series.projectIds, ["drama-1"]);

  res = mockRes();
  await handleDramaApi({ method: "PUT", socket: {}, body: JSON.stringify({ characters: [{ id: "char-1", name: "林晚", appearance: "young woman" }] }) }, res, new URL(`http://x/api/drama/series/${sid}/assets`), c);
  assert.equal(res.body.data.series.assetLibrary.characters.length, 1);

  res = mockRes();
  await handleDramaApi({ method: "DELETE", socket: {} }, res, new URL(`http://x/api/drama/series/${sid}/projects/drama-1`), c);
  assert.deepEqual(res.body.data.series.projectIds, []);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("归入剧集写 project.seriesId、移出回 null", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rs-"));
  const store = createDramaStore(dataRoot);
  const project = store.save(createDramaProject({ title: "单集", script: "剧本内容".repeat(15) }));
  const c = { ...ctx(dataRoot), store };

  let res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ title: "系列" }) }, res, new URL("http://x/api/drama/series"), c);
  assert.equal(res.statusCode, 201);
  const sid = res.body.data.series.id;

  // 归入剧集 → project.seriesId 落盘
  res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ projectId: project.id }) }, res, new URL(`http://x/api/drama/series/${sid}/projects`), c);
  assert.equal(res.statusCode, 200);
  assert.equal(store.get(project.id).seriesId, sid);

  // 移出剧集 → project.seriesId 回 null
  res = mockRes();
  await handleDramaApi({ method: "DELETE", socket: {} }, res, new URL(`http://x/api/drama/series/${sid}/projects/${project.id}`), c);
  assert.equal(res.statusCode, 200);
  assert.equal(store.get(project.id).seriesId, null);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("操作不存在的剧集 → 404", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rs-"));
  const c = ctx(dataRoot);
  const res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL("http://x/api/drama/series/series-nope"), c);
  assert.equal(res.statusCode, 404);
  rmSync(dataRoot, { recursive: true, force: true });
});
