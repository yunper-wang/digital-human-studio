// tests/drama-schema.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDramaProject, normalizeShot, normalizeFrame, normalizeClip, normalizeCharacter,
  validateAnalysis, validateDirectedShots, validatePromptedShots, validateReview,
  DEMO_DRAMA_SCRIPT
} from "../lib/drama/schema.mjs";
import { createDramaStore } from "../lib/drama/store.mjs";

test("createDramaProject 生成带安全默认值的草稿项目", () => {
  const project = createDramaProject({ title: "  雨夜便利店  ", script: DEMO_DRAMA_SCRIPT, ratio: "16:9" });
  assert.match(project.id, /^drama-/);
  assert.equal(project.title, "雨夜便利店");
  assert.equal(project.ratio, "portrait"); // 非法比例回退竖屏
  assert.equal(project.status, "draft");
  assert.deepEqual(project.shots, []);
  assert.equal(project.analysis, null);
  assert.equal(project.gateAConfirmedAt, null);
});

test("normalizeShot 收敛非法输入并保留首帧状态", () => {
  const shot = normalizeShot({ camera: "drone", durationSec: 99, shotType: "dialogue", frame: { status: "ready", file: "a.png", seed: 7, attempts: 2 } }, 0);
  assert.equal(shot.id, "shot-1");
  assert.equal(shot.camera, "medium");
  assert.equal(shot.durationSec, 15);
  assert.deepEqual(shot.frame, { status: "ready", file: "a.png", seed: 7, attempts: 2, error: null });
  const bare = normalizeShot({}, 3);
  assert.equal(bare.id, "shot-4");
  assert.equal(bare.shotType, "cinematic");
  assert.equal(bare.frame.status, "pending");
});

test("normalizeFrame 拒绝伪造状态", () => {
  assert.equal(normalizeFrame({ status: "hacked" }).status, "pending");
  assert.equal(normalizeFrame().file, null);
});

test("校验器拒绝结构缺失的 LLM 输出", () => {
  assert.ok(validateAnalysis(null).length > 0);
  assert.ok(validateAnalysis({ synopsis: "x", characters: [], scenes: [] }).length > 0); // 角色为空
  assert.equal(validateAnalysis({
    synopsis: "雨夜偶遇", genre: "都市",
    characters: [{ name: "林晚", appearance: "young woman, short black hair" }],
    scenes: [{ name: "便利店门口" }]
  }).length, 0);
  assert.ok(validateDirectedShots({ shots: [] }).length > 0);
  assert.ok(validatePromptedShots({ shots: [{ fluxPrompt: "太短" }] }).length > 0);
  assert.ok(validateReview({ pass: "yes" }).length > 0);
  assert.equal(validateReview({ pass: true, issues: [] }).length, 0);
});

test("store 持久化项目并可按更新时间列出摘要", () => {
  const root = mkdtempSync(join(tmpdir(), "drama-store-test-"));
  try {
    const store = createDramaStore(root);
    const project = createDramaProject({ title: "测试短剧", script: "雨夜。" });
    store.save(project);
    store.update(project.id, (p) => { p.status = "awaiting_gate_a"; p.shots = [normalizeShot({ dialogue: "你好。" }, 0)]; });
    const fresh = createDramaStore(root); // 新实例从磁盘恢复
    const loaded = fresh.get(project.id);
    assert.equal(loaded.status, "awaiting_gate_a");
    assert.equal(loaded.shots.length, 1);
    const list = fresh.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].shotCount, 1);
    assert.equal(list[0].script, undefined); // 列表只给摘要
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("store 重启恢复时将孤儿 generating 首帧归一为 failed", () => {
  const root = mkdtempSync(join(tmpdir(), "drama-store-test-"));
  try {
    const store = createDramaStore(root);
    const project = createDramaProject({ title: "中断恢复", script: "雨夜。" });
    const shot = normalizeShot({ dialogue: "你好。" }, 0);
    // 模拟进程猝死前落盘的 generating 状态
    shot.frame = { status: "generating", file: null, seed: 42, attempts: 3, error: null };
    project.shots = [shot];
    store.save(project);
    const fresh = createDramaStore(root); // 新实例模拟重启后从磁盘加载
    const loaded = fresh.get(project.id);
    assert.equal(loaded.shots[0].frame.status, "failed");
    assert.equal(loaded.shots[0].frame.error.code, "FRAME_INTERRUPTED");
    assert.equal(loaded.shots[0].frame.attempts, 3); // 抽卡次数保留
    assert.equal(loaded.shots[0].frame.seed, 42);
    assert.equal(loaded.shots[0].frame.file, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeClip 收敛非法输入", () => {
  const bare = normalizeClip();
  assert.deepEqual(bare, { status: "pending", file: null, provider: null, providerTaskId: null, durationSec: 0, attempts: 0, error: null });
  const clip = normalizeClip({ status: "ready", file: "shot-1-clip-1.mp4", provider: "seedance2", providerTaskId: "t1", durationSec: 99, attempts: 2 });
  assert.equal(clip.status, "ready");
  assert.equal(clip.durationSec, 60); // 钳制上限
  assert.equal(normalizeClip({ status: "hacked" }).status, "pending");
  assert.equal(normalizeClip({ provider: "unknown" }).provider, null);
});

test("normalizeShot 携带 clip；normalizeCharacter 携带 voiceId", () => {
  const shot = normalizeShot({ clip: { status: "ready", file: "a.mp4" } }, 0);
  assert.equal(shot.clip.status, "ready");
  assert.equal(normalizeShot({}, 0).clip.status, "pending");
  const character = normalizeCharacter({ name: "林晚", appearance: "young woman", voiceId: "v1" }, 0);
  assert.equal(character.voiceId, "v1");
  assert.equal(normalizeCharacter({ name: "x", appearance: "y" }, 0).voiceId, null);
});

test("store 重启恢复时将孤儿 generating clip 归一为 failed", () => {
  const root = mkdtempSync(join(tmpdir(), "drama-store-clip-"));
  try {
    const store = createDramaStore(root);
    const project = createDramaProject({ title: "t", script: "雨夜。" });
    project.shots = [normalizeShot({}, 0)];
    project.shots[0].clip = { status: "generating", file: null, provider: "comfyui", providerTaskId: null, durationSec: 0, attempts: 2, error: null };
    store.save(project);
    const fresh = createDramaStore(root);
    const loaded = fresh.get(project.id);
    assert.equal(loaded.shots[0].clip.status, "failed");
    assert.equal(loaded.shots[0].clip.error.code, "CLIP_INTERRUPTED");
    assert.equal(loaded.shots[0].clip.attempts, 2);
    assert.ok(existsSync(join(root, "drama-projects", project.id, "clips"))); // clips 目录已建
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
