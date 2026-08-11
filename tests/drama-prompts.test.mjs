// tests/drama-prompts.test.mjs
// M7 提示词模板库：多模板存储 + 项目选用 + 逐段回退默认
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPromptStore, BUILTIN_TEMPLATE_ID } from "../lib/drama/prompts.mjs";

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-pt-"));
  return { store: createPromptStore(dataRoot), dataRoot };
}

test("种子化内置默认模板（幂等），四段齐全", () => {
  const { store, dataRoot } = setup();
  const builtin = store.get(BUILTIN_TEMPLATE_ID);
  assert.ok(builtin);
  assert.equal(builtin.builtin, true);
  for (const s of ["analyze", "direct", "prompt", "review"]) assert.ok(builtin.stages[s].length > 20);
  // 幂等：同目录重建 store 不重复种子
  const again = createPromptStore(dataRoot);
  assert.equal(again.list().length, 1);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("CRUD：建→列→改→builtin 不可删→自定义可删", () => {
  const { store, dataRoot } = setup();
  const tpl = store.create({ name: "悬疑风", stages: { direct: "你是悬疑短剧导演，只输出 JSON。" } });
  assert.equal(tpl.name, "悬疑风");
  assert.equal(tpl.builtin, false);
  assert.equal(store.list().length, 2); // 内置 + 自定义
  store.save({ ...tpl, name: "悬疑风 v2" });
  assert.equal(store.get(tpl.id).name, "悬疑风 v2");
  assert.equal(store.remove(BUILTIN_TEMPLATE_ID), false); // builtin 保护
  assert.equal(store.remove(tpl.id), true);
  assert.equal(store.get(tpl.id), null);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("duplicate 复制内置模板为可编辑副本", () => {
  const { store, dataRoot } = setup();
  const copy = store.duplicate(BUILTIN_TEMPLATE_ID);
  assert.equal(copy.name, "默认模板 副本");
  assert.equal(copy.builtin, false);
  assert.equal(copy.stages.analyze, store.get(BUILTIN_TEMPLATE_ID).stages.analyze);
  assert.equal(store.remove(copy.id), true);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("resolveStages 逐段回退：未选/模板缺失/某段为空 → 内置默认", () => {
  const { store, dataRoot } = setup();
  const fallback = store.get(BUILTIN_TEMPLATE_ID).stages;
  assert.deepEqual(store.resolveStages(null), fallback);
  assert.deepEqual(store.resolveStages("ptpl-00000000-0000-0000-0000-000000000000"), fallback);
  const tpl = store.create({ name: "x", stages: { review: "自定义审核提示词" } });
  const resolved = store.resolveStages(tpl.id);
  assert.equal(resolved.review, "自定义审核提示词");
  assert.equal(resolved.analyze, fallback.analyze);
  store.remove(tpl.id); // 删模板后回退默认
  assert.deepEqual(store.resolveStages(tpl.id), fallback);
  rmSync(dataRoot, { recursive: true, force: true });
});
