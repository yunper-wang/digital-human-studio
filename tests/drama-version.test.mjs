import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject } from "../lib/drama/schema.mjs";
import { saveVersion, listVersions, readVersion, rollbackVersion } from "../lib/drama/version.mjs";

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-ver-"));
  const store = createDramaStore(dataRoot);
  const project = createDramaProject({ title: "t", script: "原始剧本".repeat(20) });
  project.shots = [{ id: "shot-1", index: 1, dialogue: "旧台词", durationSec: 3 }];
  store.save(project);
  return { store, project, dataRoot };
}

test("saveVersion 存快照，listVersions 列出，readVersion 读取", () => {
  const { store, project, dataRoot } = setup();
  const snap = saveVersion(store, project.id, "初版");
  assert.equal(snap.name, "初版");
  assert.equal(snap.script, project.script);
  const list = listVersions(store, project.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "初版");
  assert.equal(list[0].shotCount, 1);
  const read = readVersion(store, project.id, snap.id);
  assert.equal(read.script, project.script);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("rollbackVersion 恢复剧本/分镜并重置衍生状态", () => {
  const { store, project, dataRoot } = setup();
  const snap = saveVersion(store, project.id, "初版");
  // 改剧本+分镜并推进状态
  store.update(project.id, (p) => { p.script = "改动后的剧本"; p.shots = []; p.status = "clips_ready"; p.gateAConfirmedAt = "2026-01-01"; });
  const rolled = rollbackVersion(store, project.id, snap.id);
  assert.equal(rolled.script, project.script); // 回到原始剧本
  assert.equal(rolled.shots.length, 1);
  assert.equal(rolled.status, "draft");
  assert.equal(rolled.gateAConfirmedAt, null);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("readVersion/rollbackVersion 不存在返回 null", () => {
  const { store, project, dataRoot } = setup();
  assert.equal(readVersion(store, project.id, "ver-nope"), null);
  assert.equal(rollbackVersion(store, project.id, "ver-nope"), null);
  rmSync(dataRoot, { recursive: true, force: true });
});