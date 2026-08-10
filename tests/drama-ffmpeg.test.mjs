import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { detectFfmpeg, runFfmpeg, buildNormalizeArgs, buildConcatArgs, buildBgmArgs, buildSubtitleArgs } from "../lib/drama/ffmpeg.mjs";

test("detectFfmpeg 命中系统 ffmpeg 返回 available", () => {
  const r = detectFfmpeg({ execImpl: () => "ffmpeg version 8.1.1 Copyright", env: {}, platform: "darwin" });
  assert.equal(r.available, true);
  assert.equal(r.version, "8.1.1");
});
test("detectFfmpeg 全部失败返回 unavailable", () => {
  const r = detectFfmpeg({ execImpl: () => { throw new Error("not found"); }, env: {}, platform: "darwin" });
  assert.equal(r.available, false);
  assert.equal(r.path, null);
});
test("detectFfmpeg 优先 FFMPEG_PATH", () => {
  const seen = [];
  detectFfmpeg({ execImpl: (cmd) => { seen.push(cmd); return "ffmpeg version 1.0"; }, env: { FFMPEG_PATH: "/custom/ffmpeg" }, platform: "linux" });
  assert.equal(seen[0], "/custom/ffmpeg");
});

test("runFfmpeg 成功 resolve、非零退出 reject", async () => {
  const okChild = () => { const e = new EventEmitter(); e.stderr = new EventEmitter(); process.nextTick(() => e.emit("close", 0)); return e; };
  await assert.doesNotReject(() => runFfmpeg(["-version"], { spawnImpl: okChild, ffmpegPath: "ffmpeg" }));
  const badChild = () => { const e = new EventEmitter(); e.stderr = new EventEmitter(); process.nextTick(() => { e.stderr.emit("data", "boom"); e.emit("close", 2); }); return e; };
  await assert.rejects(() => runFfmpeg(["x"], { spawnImpl: badChild, ffmpegPath: "ffmpeg" }), /退出码 2/);
});

test("buildNormalizeArgs 无配音时注入静音轨", () => {
  const a = buildNormalizeArgs({ clipPath: "c.mp4", audioPath: null, output: "o.mp4" });
  assert.ok(a.includes("anullsrc=r=44100:cl=mono"));
  assert.ok(a.includes("libx264") && a.includes("aac"));
});
test("buildNormalizeArgs 有配音时用第二输入", () => {
  const a = buildNormalizeArgs({ clipPath: "c.mp4", audioPath: "v.mp3", output: "o.mp4" });
  assert.deepEqual(a.slice(0, 5), ["-y", "-i", "c.mp4", "-i", "v.mp3"]);
});
test("buildConcatArgs 流拷贝拼接", () => {
  const a = buildConcatArgs({ listFile: "list.txt", output: "m.mp4" });
  assert.deepEqual(a, ["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "m.mp4"]);
});
test("buildBgmArgs 循环+闪避混音", () => {
  const a = buildBgmArgs({ filmPath: "m.mp4", bgmPath: "b.mp3", volume: 0.3, output: "o.mp4" });
  assert.ok(a.includes("-stream_loop") && a.join(" ").includes("sidechaincompress"));
  assert.ok(a.join(" ").includes("volume=0.3"));
});
test("buildSubtitleArgs 封装 mov_text 软字幕", () => {
  const a = buildSubtitleArgs({ filmPath: "m.mp4", srtPath: "f.srt", output: "o.mp4" });
  assert.ok(a.includes("mov_text") && a.includes("f.srt"));
});
