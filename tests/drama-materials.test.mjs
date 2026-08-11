// tests/drama-materials.test.mjs
// M7 素材库：上传/过滤/改名/标签/删除 + 魔数与大小校验 + 索引损坏自愈
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMaterialStore } from "../lib/drama/materials.mjs";

// 1x1 PNG（魔数合法）
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const MP3_DATA_URL = `data:audio/mpeg;base64,${Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]).toString("base64")}`;

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-mat-"));
  return { store: createMaterialStore(dataRoot), dataRoot };
}

test("register 图片/音频 → list 过滤 → get", () => {
  const { store, dataRoot } = setup();
  const img = store.register({ name: "街景", dataUrl: PNG_DATA_URL });
  assert.equal(img.kind, "image");
  assert.ok(img.file.endsWith(".png"));
  assert.ok(existsSync(join(dataRoot, "materials", img.file)));
  const audio = store.register({ name: "雨声", dataUrl: MP3_DATA_URL });
  assert.equal(audio.kind, "audio");
  assert.equal(store.list().length, 2);
  assert.equal(store.list({ kind: "image" }).length, 1);
  assert.equal(store.list({ q: "雨声" })[0].id, audio.id);
  assert.equal(store.get(img.id).name, "街景");
  rmSync(dataRoot, { recursive: true, force: true });
});

test("rename/setTags/remove（删文件+索引）", () => {
  const { store, dataRoot } = setup();
  const img = store.register({ name: "a", dataUrl: PNG_DATA_URL });
  store.rename(img.id, "便利店夜景");
  store.setTags(img.id, ["街景", "夜"]);
  const got = store.get(img.id);
  assert.equal(got.name, "便利店夜景");
  assert.deepEqual(got.tags, ["街景", "夜"]);
  assert.equal(store.list({ tag: "夜" }).length, 1);
  assert.equal(store.remove(img.id), true);
  assert.equal(store.get(img.id), null);
  assert.equal(existsSync(join(dataRoot, "materials", img.file)), false);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("格式/魔数/大小校验", () => {
  const { store, dataRoot } = setup();
  assert.throws(() => store.register({ name: "x", dataUrl: "data:text/plain;base64,aGVsbG8=" }), /MATERIAL_FORMAT_INVALID/);
  // png 声明但内容不是 png
  assert.throws(() => store.register({ name: "x", dataUrl: `data:image/png;base64,${Buffer.from("not a png").toString("base64")}` }), /MATERIAL_BYTES_INVALID/);
  // 超 8MB
  const big = Buffer.alloc(9 * 1024 * 1024, 1);
  assert.throws(() => store.register({ name: "x", dataUrl: `data:image/png;base64,${big.toString("base64")}` }), /MATERIAL_TOO_LARGE/);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("索引损坏 → 重建空索引（文件保留）", () => {
  const { store, dataRoot } = setup();
  const img = store.register({ name: "a", dataUrl: PNG_DATA_URL });
  writeFileSync(join(dataRoot, "materials", "index.json"), "{{{");
  assert.deepEqual(store.list(), []);
  assert.ok(existsSync(join(dataRoot, "materials", img.file))); // 文件仍在
  rmSync(dataRoot, { recursive: true, force: true });
});
