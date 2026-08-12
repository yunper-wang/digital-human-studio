// tests/drama-queue.test.mjs
// M10 按类型并发度内存队列：FIFO 排队、完成后自动出队、task 抛错不阻塞
import test from "node:test";
import assert from "node:assert/strict";
import { createJobQueue } from "../lib/drama/queue.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("enqueue 并发度内立即跑；超限排队", async () => {
  const q = createJobQueue({ comfyui: 1, voice: 2, ffmpeg: 1 });
  const order = [];
  const a = q.enqueue("comfyui", { id: "a", task: async () => { order.push("a-start"); await sleep(10); order.push("a-end"); } });
  const b = q.enqueue("comfyui", { id: "b", task: async () => { order.push("b-start"); await sleep(10); order.push("b-end"); } });
  assert.equal(q.status().comfyui.running, 1);
  assert.equal(q.status().comfyui.queued, 1);
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});

test("不同 kind 各自独立并发度", async () => {
  const q = createJobQueue({ comfyui: 1, voice: 2, ffmpeg: 1 });
  const done = [];
  const v1 = q.enqueue("voice", { id: "v1", task: async () => { await sleep(10); done.push("v1"); } });
  const v2 = q.enqueue("voice", { id: "v2", task: async () => { await sleep(10); done.push("v2"); } });
  const v3 = q.enqueue("voice", { id: "v3", task: async () => { await sleep(10); done.push("v3"); } });
  assert.equal(q.status().voice.running, 2);
  assert.equal(q.status().voice.queued, 1);
  await Promise.all([v1, v2, v3]);
  assert.equal(done.length, 3);
});

test("完成后自动出队下一个", async () => {
  const q = createJobQueue({ comfyui: 1, voice: 1, ffmpeg: 1 });
  const order = [];
  await q.enqueue("comfyui", { id: "a", task: async () => { order.push("a"); } });
  await q.enqueue("comfyui", { id: "b", task: async () => { order.push("b"); } });
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(q.status().comfyui.running, 0);
  assert.equal(q.status().comfyui.queued, 0);
});

test("task 抛错不阻塞后续任务；promise resolve 不 reject", async () => {
  const q = createJobQueue({ comfyui: 1, voice: 1, ffmpeg: 1 });
  const a = q.enqueue("comfyui", { id: "a", task: async () => { throw new Error("boom"); } });
  const b = q.enqueue("comfyui", { id: "b", task: async () => "ok" });
  await a; // 不 reject
  const result = await b;
  assert.equal(result, "ok");
});

test("status 形状含三 kind", () => {
  const q = createJobQueue({ comfyui: 1, voice: 2, ffmpeg: 1 });
  const s = q.status();
  assert.deepEqual(Object.keys(s).sort(), ["comfyui", "ffmpeg", "voice"]);
  for (const k of Object.keys(s)) assert.deepEqual(s[k], { running: 0, queued: 0 });
});
