// lib/drama/store.mjs
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 项目落盘结构：data/drama-projects/{id}/project.json + frames/
export function createDramaStore(dataRoot) {
  const root = join(dataRoot, "drama-projects");
  mkdirSync(root, { recursive: true });
  const cache = new Map();

  const dir = (id) => join(root, id);
  const projectFile = (id) => join(dir(id), "project.json");

  function persist(project) {
    mkdirSync(join(dir(project.id), "frames"), { recursive: true });
    mkdirSync(join(dir(project.id), "clips"), { recursive: true });
    writeFileSync(projectFile(project.id), JSON.stringify(project, null, 2));
  }

  function save(project) {
    project.updatedAt = new Date().toISOString();
    cache.set(project.id, project);
    persist(project);
    return project;
  }

  function get(id) {
    if (typeof id !== "string" || !/^drama-[a-f0-9-]+$/.test(id)) return null;
    if (!cache.has(id) && existsSync(projectFile(id))) {
      try {
        const project = JSON.parse(readFileSync(projectFile(id), "utf8"));
        // 重启后磁盘上的 generating 必然是孤儿：首帧生成只在进程内执行，进程已死
        for (const shot of project.shots || []) {
          if (shot.frame?.status === "generating") {
            shot.frame = {
              status: "failed",
              file: null,
              seed: shot.frame.seed ?? null,
              attempts: shot.frame.attempts ?? 0,
              error: { code: "FRAME_INTERRUPTED", message: "服务重启导致首帧生成中断，可重新生成" }
            };
          }
          if (shot.clip?.status === "generating") {
            // 与 frame 同理：视频生成是进程内的，磁盘上的 generating 必然是孤儿
            shot.clip = {
              status: "failed",
              file: null,
              provider: shot.clip.provider ?? null,
              providerTaskId: shot.clip.providerTaskId ?? null,
              durationSec: shot.clip.durationSec ?? 0,
              attempts: shot.clip.attempts ?? 0,
              error: { code: "CLIP_INTERRUPTED", message: "服务重启导致视频生成中断，可重新生成" }
            };
          }
        }
        cache.set(id, project);
      } catch {
        return null;
      }
    }
    return cache.get(id) || null;
  }

  function list() {
    const ids = new Set(cache.keys());
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        if (/^drama-[a-f0-9-]+$/.test(name)) ids.add(name);
      }
    }
    return [...ids]
      .map(get)
      .filter(Boolean)
      .map(({ id, title, status, ratio, shots, createdAt, updatedAt }) => ({
        id, title, status, ratio, shotCount: Array.isArray(shots) ? shots.length : 0, createdAt, updatedAt
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function update(id, patcher) {
    const project = get(id);
    if (!project) return null;
    patcher(project);
    return save(project);
  }

  return { root, dir, save, get, list, update };
}
