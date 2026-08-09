// tests/drama-agents.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { runScriptAnalysis, runDirection, runPromptWriting, runReview } from "../lib/drama/agents.mjs";
import { createDramaProject, DEMO_DRAMA_SCRIPT } from "../lib/drama/schema.mjs";
import { getDramaLlmConfig } from "../lib/drama/llm.mjs";

const deps = { config: getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" }) };

async function analyzedProject() {
  const project = createDramaProject({ title: "测试", script: DEMO_DRAMA_SCRIPT });
  project.analysis = await runScriptAnalysis(project, deps);
  return project;
}

test("剧本分析产出合法角色与场景（含英文外观锁）", async () => {
  const project = await analyzedProject();
  assert.ok(project.analysis.synopsis.length > 0);
  assert.ok(project.analysis.characters.length >= 2);
  assert.ok(project.analysis.characters.every((c) => c.appearance.length > 10));
  assert.ok(project.analysis.characters.every((c) => c.avatarId === null));
});

test("导演分镜引用存在的角色并归一化镜头", async () => {
  const project = await analyzedProject();
  const shots = await runDirection(project, deps);
  const knownIds = new Set(project.analysis.characters.map((c) => c.id));
  assert.ok(shots.length >= 3);
  assert.ok(shots.every((s) => s.characterIds.every((id) => knownIds.has(id))));
  assert.ok(shots.every((s) => s.durationSec >= 2 && s.durationSec <= 15));
  assert.ok(shots.some((s) => s.shotType === "dialogue"));
  assert.equal(shots[0].frame.status, "pending");
});

test("提示词阶段注入外观锁并保留已有首帧状态", async () => {
  const project = await analyzedProject();
  project.shots = await runDirection(project, deps);
  project.shots[0].frame = { status: "ready", file: "keep.png", seed: 42, attempts: 1, error: null };
  const shots = await runPromptWriting(project, deps);
  const appearances = project.analysis.characters.map((c) => c.appearance.split(",")[0]);
  assert.ok(shots.every((s) => s.fluxPrompt.length >= 20));
  assert.ok(shots.some((s) => appearances.some((a) => s.fluxPrompt.includes(a))));
  assert.equal(shots[0].frame.file, "keep.png"); // 不丢首帧
});

test("审核阶段产出结构化结论", async () => {
  const project = await analyzedProject();
  project.shots = await runPromptWriting({ ...project, shots: await runDirection(project, deps) }, deps);
  const review = await runReview(project, deps);
  assert.equal(typeof review.pass, "boolean");
  assert.ok(Array.isArray(review.issues));
});
