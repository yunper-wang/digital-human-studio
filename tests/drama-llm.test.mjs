// tests/drama-llm.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { getDramaLlmConfig, callDramaLlm, extractJson, dramaLlmStatus } from "../lib/drama/llm.mjs";
import { runScriptAnalysis, runPromptWriting } from "../lib/drama/agents.mjs";
import { DEMO_DRAMA_SCRIPT } from "../lib/drama/schema.mjs";

test("未配置时落入 mock 模式", () => {
  const config = getDramaLlmConfig({});
  assert.equal(config.mock, true);
  assert.equal(config.baseUrl, "");
});

test("mock 模式各阶段返回确定性 JSON 文本", async () => {
  const config = getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" });
  const analysisText = await callDramaLlm("analyze", { system: "s", user: JSON.stringify({ script: DEMO_DRAMA_SCRIPT }) }, { config });
  const analysis = extractJson(analysisText);
  assert.ok(analysis.characters.length >= 2);
  const directText = await callDramaLlm("direct", { system: "s", user: JSON.stringify({ script: DEMO_DRAMA_SCRIPT, analysis }) }, { config });
  const directed = extractJson(directText);
  assert.ok(directed.shots.length >= 3);
  const promptText = await callDramaLlm("prompt", { system: "s", user: JSON.stringify({ analysis, shots: directed.shots }) }, { config });
  const prompted = extractJson(promptText);
  assert.ok(prompted.shots.every((s) => s.fluxPrompt.length >= 20));
  // 确定性：同输入同输出
  const again = await callDramaLlm("analyze", { system: "s", user: JSON.stringify({ script: DEMO_DRAMA_SCRIPT }) }, { config });
  assert.equal(again, analysisText);
});

test("extractJson 容忍 markdown 围栏并拒绝非 JSON", () => {
  assert.deepEqual(extractJson("```json\n{\"a\":1}\n```"), { a: 1 });
  assert.deepEqual(extractJson("前缀 {\"a\":2} 后缀"), { a: 2 });
  assert.throws(() => extractJson("没有对象"), /DRAMA_LLM_INVALID_JSON/);
});

test("真实模式网络错误重试后抛 DRAMA_LLM_UNREACHABLE", async () => {
  const config = getDramaLlmConfig({
    DRAMA_LLM_BASE_URL: "http://127.0.0.1:9", DRAMA_LLM_MODEL: "demo", DRAMA_LLM_API_KEY: "sk-your-key"
  });
  assert.equal(config.mock, false);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("connection refused"); };
  const sleep = async () => {};
  await assert.rejects(
    callDramaLlm("analyze", { system: "s", user: "{}" }, { config, fetchImpl, sleep }),
    (error) => error.code === "DRAMA_LLM_UNREACHABLE" && error.retryable === true
  );
  assert.equal(calls, 3); // 首次 + 2 次重试
});

test("dramaLlmStatus 在 mock 模式不报 connected（保持纯净环境 smoke 不变量）", async () => {
  const status = await dramaLlmStatus(getDramaLlmConfig({}));
  assert.deepEqual({ configured: status.configured, connected: status.connected, state: status.state, mock: status.mock },
    { configured: false, connected: false, state: "mock", mock: true });
});

test("M6：mock 分析产出场景/道具外观，prompt 注入场景/道具外观", async () => {
  const analysis = await runScriptAnalysis({ script: "雨夜，便利店门口。" }, { config: { mock: true } });
  assert.ok(analysis.scenes.every((s) => typeof s.appearance === "string" && s.appearance.length > 0));
  assert.ok(Array.isArray(analysis.props) && analysis.props.length >= 1);
  assert.ok(analysis.props.every((p) => p.appearance.length > 0));

  const project = {
    analysis,
    shots: [{ id: "shot-1", index: 1, sceneName: analysis.scenes[0].name, characterIds: [analysis.characters[0].id], shotType: "cinematic", camera: "medium", dialogue: "", action: "推门", durationSec: 4, emotion: "失落", fluxPrompt: "", negativePrompt: "", motionPrompt: "" }]
  };
  const shots = await runPromptWriting(project, { config: { mock: true } });
  const fp = shots[0].fluxPrompt;
  assert.ok(fp.includes(analysis.scenes[0].appearance));   // 场景外观已注入
  assert.ok(fp.includes(analysis.props[0].appearance));    // 关联道具外观已注入
});
