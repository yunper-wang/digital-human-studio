import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSeriesStore } from "../lib/drama/series.mjs";

test("剧集 CRUD 与集成员管理", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-series-"));
  const store = createSeriesStore(dataRoot);
  const s = store.create({ title: "雨夜系列" });
  assert.equal(s.title, "雨夜系列");
  assert.equal(store.list().length, 1);
  store.addProject(s.id, "drama-1");
  store.addProject(s.id, "drama-2");
  store.addProject(s.id, "drama-1"); // 幂等
  assert.deepEqual(store.get(s.id).projectIds, ["drama-1", "drama-2"]);
  store.removeProject(s.id, "drama-1");
  assert.deepEqual(store.get(s.id).projectIds, ["drama-2"]);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("共享资产库 upsertAssets 合并角色/场景/道具", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-series-"));
  const store = createSeriesStore(dataRoot);
  const s = store.create({ title: "x" });
  store.upsertAssets(s.id, { characters: [{ id: "char-1", name: "林晚", appearance: "young woman" }], scenes: [], props: [] });
  store.upsertAssets(s.id, { characters: [{ id: "char-1", name: "林晚", appearance: "young woman, updated" }], scenes: [{ id: "scene-1", name: "便利店", appearance: "store" }], props: [] });
  const lib = store.get(s.id).assetLibrary;
  assert.equal(lib.characters.length, 1);                       // 同 id 合并非重复
  assert.equal(lib.characters[0].appearance, "young woman, updated");
  assert.equal(lib.scenes.length, 1);
  rmSync(dataRoot, { recursive: true, force: true });
});