// tests/drama-budget.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { getDramaPricing, estimateBudget } from "../lib/drama/budget.mjs";
import { createDramaProject, normalizeShot } from "../lib/drama/schema.mjs";

test("默认单价可被环境变量覆盖", () => {
  const pricing = getDramaPricing({});
  assert.equal(pricing.seedancePerShot, 6);
  assert.equal(pricing.framePerShot, 0);
  const custom = getDramaPricing({ DRAMA_PRICE_SEEDANCE_PER_SHOT: "9.5" });
  assert.equal(custom.seedancePerShot, 9.5);
});

test("按镜头类型汇总预算（无独立 TTS 行）", () => {
  const project = createDramaProject({ title: "t", script: "s" });
  project.shots = [
    normalizeShot({ shotType: "dialogue", dialogue: "你好，世界。", durationSec: 5 }, 0),
    normalizeShot({ shotType: "dialogue", dialogue: "再见。", durationSec: 4 }, 1),
    normalizeShot({ shotType: "cinematic", durationSec: 8 }, 2)
  ];
  const budget = estimateBudget(project, getDramaPricing({}));
  const byId = Object.fromEntries(budget.lines.map((line) => [line.id, line]));
  assert.equal(byId.frames.kind, "local");
  assert.equal(byId.frames.subtotal, 0);
  assert.equal(byId.seedance.count, 2);
  assert.equal(byId.seedance.subtotal, 12);
  assert.equal(byId.h3.count, 8);
  assert.equal(byId.h3.subtotal, 4);
  assert.equal(byId.tts, undefined); // M3 起无独立配音行：Seedance/H3 原生出声
  assert.equal(budget.totalPaid, 16);
  assert.equal(budget.estimated, true);
});
