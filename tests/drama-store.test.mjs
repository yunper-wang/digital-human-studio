import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject } from "../lib/drama/schema.mjs";

test("store.get 把进程内执行态的孤儿归一为 failed（frame/clip/audio/compose）", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-store-"));
  const writer = createDramaStore(dataRoot);
  const project = createDramaProject({ title: "t", script: "x".repeat(60) });
  project.status = "videos";
  project.shots = [{
    id: "shot-1", index: 1,
    frame: { status: "generating", file: null, seed: null, attempts: 0, error: null },
    clip: {
      status: "generating", file: null, provider: "comfyui", providerTaskId: null,
      durationSec: 3, attempts: 0, error: null,
      audio: { status: "generating", file: null, provider: "voicebox", error: null }
    }
  }];
  project.compose = { status: "running", file: null, srtFile: null, error: null, startedAt: "2026-01-01", finishedAt: null };
  writer.save(project);

  // 新实例 = 模拟重启（空缓存），触发读盘 + 孤儿归一
  const reader = createDramaStore(dataRoot);
  const loaded = reader.get(project.id);
  assert.equal(loaded.shots[0].frame.status, "failed");
  assert.equal(loaded.shots[0].frame.error.code, "FRAME_INTERRUPTED");
  assert.equal(loaded.shots[0].clip.status, "failed");
  assert.equal(loaded.shots[0].clip.error.code, "CLIP_INTERRUPTED");
  assert.equal(loaded.shots[0].clip.audio.status, "failed");
  assert.equal(loaded.shots[0].clip.audio.error.code, "VOICE_INTERRUPTED");
  assert.equal(loaded.compose.status, "failed");
  assert.equal(loaded.compose.error.code, "COMPOSE_INTERRUPTED");
  rmSync(dataRoot, { recursive: true, force: true });
});
