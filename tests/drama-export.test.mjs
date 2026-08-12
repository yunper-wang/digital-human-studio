// tests/drama-export.test.mjs
// M11 成片导出：元数据派生 + ZIP store 模式打包
import test from "node:test";
import assert from "node:assert/strict";
import { buildMeta, buildZipBuffer } from "../lib/drama/export.mjs";

test("buildMeta 从 project 派生元数据", () => {
  const project = {
    title: "雨夜", ratio: "portrait", createdAt: "2026-08-01T00:00:00.000Z",
    analysis: { synopsis: "偶遇", genre: "都市", characters: [{ name: "林晚", role: "主角" }, { name: "阿明", role: "配角" }] },
    shots: [{ durationSec: 3 }, { durationSec: 5 }]
  };
  const m = buildMeta(project);
  assert.equal(m.title, "雨夜");
  assert.equal(m.synopsis, "偶遇");
  assert.equal(m.genre, "都市");
  assert.deepEqual(m.characters, [{ name: "林晚", role: "主角" }, { name: "阿明", role: "配角" }]);
  assert.equal(m.shotCount, 2);
  assert.equal(m.totalDurationSec, 8);
  assert.equal(m.ratio, "portrait");
  assert.equal(m.createdAt, "2026-08-01T00:00:00.000Z");
  assert.ok(m.exportedAt); // ISO 时间戳
});

test("buildZipBuffer 产出合法 ZIP（store 模式）", () => {
  const files = [
    { name: "a.txt", bytes: Buffer.from("hello") },
    { name: "b.bin", bytes: Buffer.from([0, 1, 2, 3]) }
  ];
  const zip = buildZipBuffer(files);
  // local file header magic: PK\x03\x04
  assert.equal(zip[0], 0x50); assert.equal(zip[1], 0x4b); assert.equal(zip[2], 0x03); assert.equal(zip[3], 0x04);
  // end of central directory record magic: PK\x05\x06
  const endSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  assert.ok(zip.slice(-22).includes(endSig));
  // 包含文件名 a.txt
  assert.ok(zip.toString("latin1").includes("a.txt"));
  // 大小合理（header + 数据 + central）
  assert.ok(zip.length > files[0].bytes.length + files[1].bytes.length);
});
