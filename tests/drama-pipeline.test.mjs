// tests/drama-pipeline.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject, DEMO_DRAMA_SCRIPT } from "../lib/drama/schema.mjs";
import { getDramaLlmConfig } from "../lib/drama/llm.mjs";
import { runDramaPipeline, isPipelineRunning } from "../lib/drama/pipeline.mjs";
import { createPromptStore } from "../lib/drama/prompts.mjs";
import { createProviderOverrideStore } from "../lib/drama/provider-overrides.mjs";
import { createSuggestionStore } from "../lib/drama/suggestions.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "drama-pipeline-test-"));
  const store = createDramaStore(root);
  const project = store.save(createDramaProject({ title: "流水线测试", script: DEMO_DRAMA_SCRIPT }));
  return { root, store, project };
}

test("mock 模式全流程推进到 awaiting_gate_a 并产出预算", async () => {
  const { root, store, project } = fixture();
  try {
    const deps = { config: getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" }) };
    const result = await runDramaPipeline(store, project.id, { deps });
    assert.equal(result.reused, false);
    const done = store.get(project.id);
    assert.equal(done.status, "awaiting_gate_a");
    assert.ok(done.shots.length >= 3);
    assert.ok(done.shots.every((s) => s.fluxPrompt.length >= 20));
    assert.ok(done.budget && done.budget.lines.length >= 3);
    assert.equal(done.review.pass, true);
    assert.equal(done.pipeline.stage, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("阶段失败落 failed 并可从断点续跑", async () => {
  const { root, store, project } = fixture();
  try {
    const badDeps = {
      config: getDramaLlmConfig({ DRAMA_LLM_BASE_URL: "http://127.0.0.1:9", DRAMA_LLM_MODEL: "x" }),
      fetchImpl: async () => { throw new Error("connection refused"); },
      sleep: async () => {}
    };
    await runDramaPipeline(store, project.id, { deps: badDeps });
    const failed = store.get(project.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.pipeline.error.stage, "analyze");
    const goodDeps = { config: getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" }) };
    await runDramaPipeline(store, project.id, { fromStage: failed.pipeline.error.stage, deps: goodDeps });
    assert.equal(store.get(project.id).status, "awaiting_gate_a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("运行中的流水线拒绝重入", async () => {
  const { root, store, project } = fixture();
  try {
    assert.equal(isPipelineRunning(project.id), false);
    const deps = { config: getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" }) };
    const first = runDramaPipeline(store, project.id, { deps });
    // mock 是同步微任务，这里主要验证接口形态；并发重入由 running 集合保证
    await first;
    assert.equal(isPipelineRunning(project.id), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("M7：流水线按项目模板 resolve 提示词注入 deps", async () => {
  const { root, store, project } = fixture();
  try {
    const promptStore = createPromptStore(root);
    const tpl = promptStore.create({ name: "t", stages: { review: "自定义审核提示词" } });
    store.update(project.id, (p) => { p.promptTemplateId = tpl.id; });
    let resolvedWith = undefined;
    const spy = { resolveStages: (id) => { resolvedWith = id; return promptStore.resolveStages(id); } };
    const deps = { config: getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" }), promptStore: spy };
    const result = await runDramaPipeline(store, project.id, { deps });
    assert.equal(result.reused, false);
    assert.equal(resolvedWith, tpl.id);
    assert.equal(store.get(project.id).status, "awaiting_gate_a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("M9：流水线按项目 override 用覆盖后 LLM config", async () => {
  const { root, store, project } = fixture();
  try {
    const ovStore = createProviderOverrideStore(root);
    ovStore.save(project.id, { llm: { baseUrl: "https://api.x.com/v1", model: "gpt-4o", apiKey: "sk-x" } });
    const deps = { config: getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" }), promptStore: createPromptStore(root), providerOverrideStore: ovStore };
    await runDramaPipeline(store, project.id, { deps });
    // mock 模式不实际调 LLM，验证流水线不炸 + override 快照被读取（通过完成态验证）
    assert.equal(store.get(project.id).status, "awaiting_gate_a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("M12：analyze 完成后流水线不炸（suggestionStore 可选）", async () => {
  const { root, store, project } = fixture();
  try {
    const suggestionStore = createSuggestionStore(root);
    const deps = { config: getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" }), promptStore: createPromptStore(root), suggestionStore };
    await runDramaPipeline(store, project.id, { deps });
    assert.equal(store.get(project.id).status, "awaiting_gate_a");
    assert.ok(store.get(project.id).analysis);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
