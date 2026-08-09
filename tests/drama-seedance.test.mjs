import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSeedancePrompt, seedanceDurationTier, runSeedanceGeneration
} from "../lib/seedance.mjs";

const fixture = fileURLToPath(new URL("./fixtures/fake-seedance-runner.mjs", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function makeConfig(root) {
  // 形象/音色均落在临时文件，accessor 与 server.mjs 的真实实现同形
  const avatarFile = join(root, "avatar.png");
  const voiceFile = join(root, "voice.wav");
  writeFileSync(avatarFile, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  writeFileSync(voiceFile, Buffer.alloc(600, 1));
  return {
    python: process.execPath,
    toolVault: fixture,
    runner: "ignored-by-fixture",
    model: "fake-model",
    projectRoot,
    accessors: {
      findAvatar: (id) => (id === "a1" ? { id: "a1", name: "测试人物", image: "/uploads/avatar.png", source: "local" } : null),
      trustedUploadPath: () => avatarFile,
      findVoice: (id) => (id === "v1" ? { id: "v1", name: "测试音色", previewPath: voiceFile, ttsReady: true } : null)
    }
  };
}

const payload = {
  title: "镜1 测试",
  script: "这是一句用于伪 runner 测试的口播台词。",
  avatarId: "a1",
  voiceId: "v1",
  generationPrompt: "x".repeat(30),
  ratio: "portrait"
};

test("seedanceDurationTier 向上取档", () => {
  assert.equal(seedanceDurationTier(2), 5);
  assert.equal(seedanceDurationTier(5), 5);
  assert.equal(seedanceDurationTier(7), 10);
  assert.equal(seedanceDurationTier(11), 15);
});

test("buildSeedancePrompt 保持原有形态（从 server.mjs 迁移）", () => {
  const prompt = buildSeedancePrompt({ script: "你好。", language: "zh", settings: {} }, { name: "林晚" }, { name: "克隆音色" });
  assert.ok(prompt.includes("林晚"));
  assert.ok(prompt.includes("克隆音色"));
  assert.ok(prompt.includes("你好。"));
});

test("runSeedanceGeneration 走通 子进程→事件→报告→成片 全流程", async () => {
  const root = mkdtempSync(join(tmpdir(), "seedance-lib-test-"));
  try {
    const events = [];
    const result = await runSeedanceGeneration({
      config: makeConfig(root),
      payload,
      runDir: join(root, "run"),
      durationSec: 10,
      onEvent: (event) => events.push(event)
    });
    assert.equal(result.providerTaskId, "fake-task-1");
    assert.ok(existsSync(result.videoPath));
    assert.equal(result.report.deducted_points, 1);
    assert.deepEqual(events.map((e) => e.phase), ["prepared", "submitted", "poll", "poll"]);
    assert.equal(events[2].pollCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSeedanceGeneration 失败时抛 SEEDANCE_GENERATION_FAILED 且带 providerTaskId", async () => {
  const root = mkdtempSync(join(tmpdir(), "seedance-lib-fail-"));
  try {
    const config = makeConfig(root);
    const originalExecPath = config.python;
    // 通过 env 让夹具失败：runSeedanceGeneration 需要把 process.env 透传给子进程（spawn 默认行为）
    process.env.FAKE_RUNNER_MODE = "fail";
    await assert.rejects(
      runSeedanceGeneration({ config: { ...config, python: originalExecPath }, payload, runDir: join(root, "run"), durationSec: 5, onEvent: () => {} }),
      (error) => error.code === "SEEDANCE_GENERATION_FAILED" && error.providerTaskId === "fake-task-1"
    );
  } finally {
    delete process.env.FAKE_RUNNER_MODE;
    rmSync(root, { recursive: true, force: true });
  }
});
