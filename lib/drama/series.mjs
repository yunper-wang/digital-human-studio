// lib/drama/series.mjs
// 轻量多集：剧集分组单集项目 + 共享资产库；存 data/drama-series/，每剧集一个 JSON
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { normalizeCharacter, normalizeProp, normalizeAnalysis } from "./schema.mjs";

export function createSeriesStore(dataRoot) {
  const root = join(dataRoot, "drama-series");
  mkdirSync(root, { recursive: true });
  const file = (id) => join(root, `${id}.json`);

  function normalizeSeries(raw = {}) {
    const lib = raw.assetLibrary || {};
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : `series-${randomUUID()}`,
      title: String(raw.title || "未命名剧集").slice(0, 80),
      projectIds: Array.isArray(raw.projectIds) ? [...new Set(raw.projectIds.map(String))] : [],
      assetLibrary: {
        characters: (Array.isArray(lib.characters) ? lib.characters : []).map((c, i) => normalizeCharacter(c, i)),
        scenes: (Array.isArray(lib.scenes) ? lib.scenes : []).map((s, i) => normalizeAnalysis({ synopsis: "x", genre: "x", characters: [{ id: "c", name: "x", appearance: "y" }], scenes: [s] }).scenes[0]),
        props: (Array.isArray(lib.props) ? lib.props : []).map((p, i) => normalizeProp(p, i))
      },
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString()
    };
  }

  function save(series) {
    series.updatedAt = new Date().toISOString();
    writeFileSync(file(series.id), JSON.stringify(series, null, 2));
    return series;
  }
  function get(id) {
    if (typeof id !== "string" || !/^series-[a-f0-9-]+$/.test(id) || !existsSync(file(id))) return null;
    try { return normalizeSeries(JSON.parse(readFileSync(file(id), "utf8"))); } catch { return null; }
  }
  function list() {
    return readdirSync(root).filter((f) => /^series-.*\.json$/.test(f))
      .map((f) => { try { return normalizeSeries(JSON.parse(readFileSync(join(root, f), "utf8"))); } catch { return null; } })
      .filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  function create({ title } = {}) { return save(normalizeSeries({ title })); }
  function remove(id) { if (existsSync(file(id))) rmSync(file(id)); }
  function addProject(id, projectId) {
    const s = get(id); if (!s) return null;
    if (!s.projectIds.includes(projectId)) s.projectIds.push(projectId);
    return save(s);
  }
  function removeProject(id, projectId) {
    const s = get(id); if (!s) return null;
    s.projectIds = s.projectIds.filter((p) => p !== projectId);
    return save(s);
  }
  function upsertAssets(id, assets = {}) {
    const s = get(id); if (!s) return null;
    const mergeById = (existing, incoming) => {
      const map = new Map(existing.map((x) => [x.id, x]));
      for (const item of incoming || []) map.set(item.id, { ...(map.get(item.id) || {}), ...item });
      return [...map.values()];
    };
    s.assetLibrary.characters = mergeById(s.assetLibrary.characters, assets.characters);
    s.assetLibrary.scenes = mergeById(s.assetLibrary.scenes, assets.scenes);
    s.assetLibrary.props = mergeById(s.assetLibrary.props, assets.props);
    return save(s);
  }

  return { list, get, create, save, remove, addProject, removeProject, upsertAssets };
}