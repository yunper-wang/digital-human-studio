// lib/drama/queue.mjs
// 按类型可配置并发度的内存队列：comfyui（首帧+视频）/ voice（口播）/ ffmpeg（合成）
// 不持久化，服务重启清空；进行中的任务不抢占，等完成才出队下一个
import { randomUUID } from "node:crypto";

const KINDS = ["comfyui", "voice", "ffmpeg"];
const DEFAULTS = { comfyui: 1, voice: 2, ffmpeg: 1 };

export function createJobQueue(config = DEFAULTS) {
  const limits = {};
  const queues = {};
  const inFlight = {};
  for (const k of KINDS) {
    limits[k] = Math.max(1, Number(config?.[k]) || DEFAULTS[k]);
    queues[k] = [];
    inFlight[k] = new Set();
  }

  async function pump(kind) {
    if (inFlight[kind].size >= limits[kind]) return;
    const job = queues[kind].shift();
    if (!job) return;
    inFlight[kind].add(job.id);
    try {
      const result = await job.task();
      job.resolve(result);
    } catch {
      // task 抛错不阻塞后续；promise resolve 不 reject（状态回写由 task 内部 catch 处理）
      job.resolve(undefined);
    } finally {
      inFlight[kind].delete(job.id);
      pump(kind); // 自动出队下一个
    }
  }

  function enqueue(kind, { id, task }) {
    const k = KINDS.includes(kind) ? kind : "comfyui";
    return new Promise((resolve) => {
      const job = { id: id || randomUUID(), task, resolve };
      queues[k].push(job);
      pump(k);
    });
  }

  function status() {
    const out = {};
    for (const k of KINDS) out[k] = { running: inFlight[k].size, queued: queues[k].length };
    return out;
  }

  return { enqueue, status };
}

export function readQueueConfig(env = process.env) {
  return {
    comfyui: Math.max(1, Number(env.COMFYUI_MAX_CONCURRENT) || 1),
    voice: Math.max(1, Number(env.VOICE_MAX_CONCURRENT) || 2),
    ffmpeg: Math.max(1, Number(env.FFMPEG_MAX_CONCURRENT) || 1)
  };
}
