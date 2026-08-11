// tests/drama-routes-materials.test.mjs
// M7 素材库端点 + 静态服务
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createMaterialStore } from "../lib/drama/materials.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; return res; }

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function ctx(dataRoot) {
  return {
    sendJson: (res, s, b) => res.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store: { get: () => null, dir: () => dataRoot, update: () => null, list: () => [], save: () => {} },
    materialStore: createMaterialStore(dataRoot),
    comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}
  };
}

test("素材：传→列（kind 过滤）→改名/标签→删", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rm-"));
  const c = ctx(dataRoot);
  let res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ name: "街景", dataUrl: PNG_DATA_URL }) }, res, new URL("http://x/api/drama/materials"), c);
  assert.equal(res.statusCode, 201);
  const mid = res.body.data.material.id;
  assert.equal(res.body.data.material.kind, "image");

  res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL("http://x/api/drama/materials?kind=image"), c);
  assert.equal(res.body.data.materials.length, 1);
  res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL("http://x/api/drama/materials?kind=video"), c);
  assert.equal(res.body.data.materials.length, 0);

  res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ name: "便利店夜景", tags: ["夜"] }) }, res, new URL(`http://x/api/drama/materials/${mid}`), c);
  assert.equal(res.body.data.material.name, "便利店夜景");
  assert.deepEqual(res.body.data.material.tags, ["夜"]);

  res = mockRes();
  await handleDramaApi({ method: "DELETE", socket: {} }, res, new URL(`http://x/api/drama/materials/${mid}`), c);
  assert.equal(res.body.data.removed, mid);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("坏素材 → 422；不存在 → 404", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rm-"));
  const c = ctx(dataRoot);
  let res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ name: "x", dataUrl: "data:text/plain;base64,aGVsbG8=" }) }, res, new URL("http://x/api/drama/materials"), c);
  assert.equal(res.statusCode, 422);
  res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL("http://x/api/drama/materials/mat-00000000-0000-0000-0000-000000000000"), c);
  assert.equal(res.statusCode, 404);
  rmSync(dataRoot, { recursive: true, force: true });
});
