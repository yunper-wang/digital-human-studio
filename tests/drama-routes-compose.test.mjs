import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createDramaProject, normalizeProject } from "../lib/drama/schema.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");

function mockRes() {
  const res = { statusCode: 0, body: null };
  res.sendJson = (status, body) => { res.statusCode = status; res.body = body; };
  return res;
}
function makeCtx(project, dir, over = {}) {
  const store = { dir: () => dir, get: () => project, list: () => [project], save: () => {}, update: (id, fn) => { fn(project); return project; } };
  return {
    sendJson: (res, s, b) => res.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store, comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {},
    ffmpegPath: "ffmpeg", audioDeps: { fetchImpl: fetch, sleep: async () => {} },
    detectFfmpeg: () => ({ available: false, path: null, version: null }),
    ...over
  };
}
function makeProject(shots, status = "clips_ready") {
  const project = normalizeProject(createDramaProject({ title: "t", script: "x".repeat(60) }));
  project.status = status;
  project.shots = shots;
  project.gateAConfirmedAt = "2026-01-01";
  return project;
}

test("GET compose/ffmpeg：按注入探测返回 unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drama-rc-"));
  const project = makeProject([]);
  const ctx = makeCtx(project, dir);
  const res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/compose/ffmpeg`), ctx);
  assert.equal(res.body.data.available, false);
  rmSync(dir, { recursive: true, force: true });
});

test("POST compose：FFmpeg 不可用 → 503 FFMPEG_UNAVAILABLE", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drama-rc-"));
  const shot = { id: "shot-1", index: 1, shotType: "cinematic", dialogue: "", durationSec: 3, audioMode: "voice", clip: { status: "confirmed", file: "shot-1-clip-1.mp4", audio: { status: "none" } } };
  const project = makeProject([shot]);
  const ctx = makeCtx(project, dir, { detectFfmpeg: () => ({ available: false, path: null, version: null }) });
  const res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: "{}" }, res, new URL(`http://x/api/drama/projects/${project.id}/compose`), ctx);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.errorCode, "FFMPEG_UNAVAILABLE");
  rmSync(dir, { recursive: true, force: true });
});

test("POST compose：FFmpeg 可用但有镜未确认 → 409 CLIPS_NOT_READY", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drama-rc-"));
  const shot = { id: "shot-1", index: 1, shotType: "cinematic", dialogue: "", durationSec: 3, audioMode: "voice", clip: { status: "ready", file: "shot-1-clip-1.mp4", audio: { status: "none" } } };
  const project = makeProject([shot], "videos");
  const ctx = makeCtx(project, dir, { detectFfmpeg: () => ({ available: true, path: "ffmpeg", version: "8" }) });
  const res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: "{}" }, res, new URL(`http://x/api/drama/projects/${project.id}/compose`), ctx);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.errorCode, "CLIPS_NOT_READY");
  rmSync(dir, { recursive: true, force: true });
});

test("POST shots/{id}/voice：非对白镜 → 422 VOICE_NOT_APPLICABLE", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drama-rc-"));
  const shot = { id: "shot-1", index: 1, shotType: "cinematic", dialogue: "", durationSec: 3, audioMode: "voice", characterIds: [], clip: { status: "confirmed", file: "c.mp4", audio: { status: "none" } } };
  const project = makeProject([shot]);
  const ctx = makeCtx(project, dir);
  const res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: "{}" }, res, new URL(`http://x/api/drama/projects/${project.id}/shots/shot-1/voice`), ctx);
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.errorCode, "VOICE_NOT_APPLICABLE");
  rmSync(dir, { recursive: true, force: true });
});

test("POST bgm：非法音频格式 → 422 AUDIO_FORMAT_INVALID", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drama-rc-"));
  const project = makeProject([]);
  const ctx = makeCtx(project, dir);
  const res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ name: "x", audioData: "data:text/plain;base64,aGk=" }) }, res, new URL(`http://x/api/drama/projects/${project.id}/bgm`), ctx);
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.errorCode, "AUDIO_FORMAT_INVALID");
  rmSync(dir, { recursive: true, force: true });
});
