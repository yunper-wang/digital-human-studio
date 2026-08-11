// lib/drama/version.mjs
// 手动版本快照：仅存文本结构（script/shots/analysis），存于项目目录 versions/
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSnapshot } from "./schema.mjs";

const versionDir = (store, projectId) => join(store.dir(projectId), "versions");

export function saveVersion(store, projectId, name) {
  const project = store.get(projectId);
  if (!project) return null;
  mkdirSync(versionDir(store, projectId), { recursive: true });
  const snapshot = normalizeSnapshot({
    id: `ver-${randomUUID()}`,
    projectId,
    name: name || `版本 ${new Date().toLocaleString("zh-CN")}`,
    script: project.script,
    analysis: project.analysis,
    shots: project.shots,
    createdAt: new Date().toISOString()
  });
  writeFileSync(join(versionDir(store, projectId), `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

export function listVersions(store, projectId) {
  const dir = versionDir(store, projectId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^ver-.*\.json$/.test(f))
    .map((f) => {
      try {
        const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
        return { id: s.id, name: s.name, createdAt: s.createdAt, shotCount: Array.isArray(s.shots) ? s.shots.length : 0 };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function readVersion(store, projectId, versionId) {
  const file = join(versionDir(store, projectId), `${versionId}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export function rollbackVersion(store, projectId, versionId) {
  const snapshot = readVersion(store, projectId, versionId);
  if (!snapshot) return null;
  return store.update(projectId, (p) => {
    p.script = snapshot.script;
    p.analysis = snapshot.analysis;
    p.shots = snapshot.shots;
    // 回滚使衍生状态失效，回到待重跑
    p.review = null;
    p.budget = null;
    p.gateAConfirmedAt = null;
    p.pipeline = { stage: null, error: null, updatedAt: null };
    p.compose = { status: "idle", file: null, srtFile: null, error: null, startedAt: null, finishedAt: null };
    p.status = "draft";
  });
}