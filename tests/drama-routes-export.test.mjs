// tests/drama-routes-export.test.mjs
// M11 成片 ZIP 打包导出端点
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject } from "../lib/drama/schema.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null, headers: {} }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; res.writeHead = (s, h) => { res.statusCode = s; res.headers = h; }; res.end = (b) => { res.body = b; }; return res; }

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-re-"));
  const store = createDramaStore(dataRoot);
  const project = store.save(createDramaProject({ title: "t", script: "剧本内容".repeat(15) }));
  const ctx = {
    sendJson: (r, s, b) => r.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store, comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}, materialStore: { get: () => null }, controlnetConfig: null
  };
  return { ctx, project, dataRoot };
}

test("export/zip 未合成 → 409", async () => {
  const { ctx, project, dataRoot } = setup();
  const res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/export/zip`), ctx);
  assert.equal(res.statusCode, 409);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("export/zip 已合成 → 200 ZIP", async () => {
  const { ctx, project, dataRoot } = setup();
  const composeDir = join(dataRoot, "drama-projects", project.id, "compose");
  mkdirSync(composeDir, { recursive: true });
  writeFileSync(join(composeDir, "final.mp4"), Buffer.from("mp4-bytes"));
  writeFileSync(join(composeDir, "film.srt"), "1\n00:00:01 --> 00:00:03\n台词");
  writeFileSync(join(composeDir, "cover.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(composeDir, "meta.json"), JSON.stringify({ title: "t" }));
  ctx.store.update(project.id, (p) => { p.compose = { status: "succeeded", file: "final.mp4", srtFile: "film.srt", cover: "cover.png", meta: "meta.json" }; });
  const res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/export/zip`), ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "application/zip");
  assert.ok(res.body.length > 100); // ZIP buffer
  assert.equal(res.body[0], 0x50); assert.equal(res.body[1], 0x4b); // PK magic
  rmSync(dataRoot, { recursive: true, force: true });
});
