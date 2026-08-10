import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeFilm } from "../lib/drama/compose.mjs";

function makeCtx(shots, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "drama-compose-"));
  mkdirSync(join(dir, "clips"), { recursive: true });
  for (const s of shots) writeFileSync(join(dir, "clips", s.clip.file), "fake");
  const project = { id: "drama-c", shots, bgm: null, compose: null, ...extra };
  const store = {
    dir: () => dir,
    get: () => project,
    update: (id, fn) => { fn(project); return project; }
  };
  const ran = [];
  const runFfmpeg = async (args) => { ran.push(args); };
  return { ctx: { store, runFfmpeg, ffmpegPath: "ffmpeg" }, project, dir, ran };
}

test("composeFilm 无 BGM 有台词：归一化+拼接+软字幕，产出 final.mp4", async () => {
  const shots = [{ id: "shot-1", index: 1, dialogue: "台词", durationSec: 3, audioMode: "voice", clip: { status: "confirmed", file: "shot-1-clip-1.mp4", audio: { status: "none" } } }];
  const { ctx, project, dir, ran } = makeCtx(shots);
  await composeFilm(ctx, "drama-c");
  assert.equal(project.compose.status, "succeeded");
  assert.equal(project.compose.file, "final.mp4");
  assert.equal(project.compose.srtFile, "film.srt");
  assert.ok(existsSync(join(dir, "compose", "film.srt")));
  assert.ok(ran.length >= 3);
  rmSync(dir, { recursive: true, force: true });
});

test("composeFilm 有 BGM：多一步混音，无台词则无字幕", async () => {
  const shots = [{ id: "shot-1", index: 1, dialogue: "", durationSec: 3, audioMode: "voice", clip: { status: "confirmed", file: "shot-1-clip-1.mp4", audio: { status: "none" } } }];
  const { ctx, project, dir, ran } = makeCtx(shots, { bgm: { file: "bgm/bgm.mp3", name: "song", volume: 0.3 } });
  mkdirSync(join(dir, "bgm"), { recursive: true });
  writeFileSync(join(dir, "bgm", "bgm.mp3"), "fake");
  await composeFilm(ctx, "drama-c");
  assert.equal(project.compose.status, "succeeded");
  assert.equal(project.compose.file, "with-bgm.mp4");
  assert.equal(project.compose.srtFile, null);
  assert.ok(ran.some((a) => a.join(" ").includes("sidechaincompress")));
  rmSync(dir, { recursive: true, force: true });
});

test("composeFilm 用 ready 配音作为该镜音轨", async () => {
  const shots = [{ id: "shot-1", index: 1, dialogue: "台词", durationSec: 3, audioMode: "voice", clip: { status: "confirmed", file: "shot-1-clip-1.mp4", audio: { status: "ready", file: "shot-1.mp3" } } }];
  const { ctx, project, dir, ran } = makeCtx(shots);
  mkdirSync(join(dir, "audio"), { recursive: true });
  writeFileSync(join(dir, "audio", "shot-1.mp3"), "fake");
  await composeFilm(ctx, "drama-c");
  assert.equal(project.compose.status, "succeeded");
  const normalize = ran.find((a) => a.includes("-map"));
  assert.ok(normalize.join(" ").includes("shot-1.mp3"));
  rmSync(dir, { recursive: true, force: true });
});

test("composeFilm 某次 ffmpeg 失败 → compose.status=failed 且不抛", async () => {
  const shots = [{ id: "shot-1", index: 1, dialogue: "x", durationSec: 3, audioMode: "voice", clip: { status: "confirmed", file: "shot-1-clip-1.mp4", audio: { status: "none" } } }];
  const { ctx, project, dir } = makeCtx(shots);
  ctx.runFfmpeg = async () => { throw Object.assign(new Error("FFmpeg 退出码 2"), { code: "FFMPEG_FAILED" }); };
  await composeFilm(ctx, "drama-c");
  assert.equal(project.compose.status, "failed");
  assert.equal(project.compose.error.code, "FFMPEG_FAILED");
  rmSync(dir, { recursive: true, force: true });
});
