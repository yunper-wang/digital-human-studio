// tests/drama-suggestions.test.mjs
// M12 智能建议存储：独立层不污染 analysis，损坏自愈，写入校验
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuggestionStore } from "../lib/drama/suggestions.mjs";

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-sug-"));
  return { store: createSuggestionStore(dataRoot), dataRoot };
}

test("get 不存在返回 null；save→get→remove", () => {
  const { store, dataRoot } = setup();
  assert.equal(store.get("drama-1"), null);
  const data = { projectId: "drama-1", generatedAt: "2026-08-16T00:00:00.000Z", suggestions: [{ category: "structure", severity: "warn", target: null, message: "高潮缺失" }] };
  store.save("drama-1", data);
  assert.deepEqual(store.get("drama-1"), data);
  assert.equal(store.remove("drama-1"), true);
  assert.equal(store.get("drama-1"), null);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("损坏文件 get 返回 null（自愈）", () => {
  const { store, dataRoot } = setup();
  store.save("drama-1", { projectId: "drama-1", generatedAt: "x", suggestions: [] });
  writeFileSync(join(dataRoot, "drama-suggestions", "drama-1.json"), "{{{");
  assert.equal(store.get("drama-1"), null);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("save 校验 suggestions 数组形状", () => {
  const { store, dataRoot } = setup();
  assert.throws(() => store.save("drama-1", { suggestions: "not-array" }), /SUGGESTION_INVALID/);
  assert.throws(() => store.save("drama-1", { suggestions: [{ category: "bad", severity: "info", target: null, message: "x" }] }), /SUGGESTION_INVALID/);
  rmSync(dataRoot, { recursive: true, force: true });
});
