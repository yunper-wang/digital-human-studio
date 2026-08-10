import test from "node:test";
import assert from "node:assert/strict";
import { formatSrtTime, deriveSubtitles, entriesToSrt, filmSrt } from "../lib/drama/subtitle.mjs";

test("formatSrtTime 输出 HH:MM:SS,mmm", () => {
  assert.equal(formatSrtTime(0), "00:00:00,000");
  assert.equal(formatSrtTime(65.5), "00:01:05,500");
  assert.equal(formatSrtTime(3.042), "00:00:03,042");
});

test("deriveSubtitles 仅取有台词镜并按 durationSec 累计时间", () => {
  const shots = [
    { id: "shot-1", dialogue: "第一句", durationSec: 3 },
    { id: "shot-2", dialogue: "", durationSec: 4 },
    { id: "shot-3", dialogue: "第二句", durationSec: 5 }
  ];
  const subs = deriveSubtitles(shots);
  assert.equal(subs.length, 2);
  assert.deepEqual(subs[0], { shotId: "shot-1", start: 0, end: 3, text: "第一句" });
  assert.deepEqual(subs[1], { shotId: "shot-3", start: 7, end: 12, text: "第二句" });
});

test("entriesToSrt 序列化为标准 SRT", () => {
  const srt = entriesToSrt([{ start: 0, end: 2, text: "你好" }]);
  assert.equal(srt, "1\n00:00:00,000 --> 00:00:02,000\n你好\n");
});

test("filmSrt 无台词时返回空串，有台词时含全部对白", () => {
  assert.equal(filmSrt([{ id: "s1", dialogue: "", durationSec: 3 }]), "");
  const srt = filmSrt([{ id: "s1", dialogue: "台词A", durationSec: 2 }, { id: "s2", dialogue: "台词B", durationSec: 3 }]);
  assert.ok(srt.includes("台词A") && srt.includes("台词B"));
  assert.ok(srt.startsWith("1\n"));
});
