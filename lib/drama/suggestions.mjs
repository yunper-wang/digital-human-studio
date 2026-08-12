// lib/drama/suggestions.mjs
// 剧本智能建议：独立存储层，不污染 analysis 结构；剧情结构/角色弧光/台词润色三类
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runSuggestions } from "./agents.mjs";

const CATEGORIES = ["structure", "arc", "dialogue"];
const SEVERITIES = ["info", "warn"];

function normalizeSuggestion(raw = {}) {
  return {
    category: CATEGORIES.includes(raw?.category) ? raw.category : "structure",
    severity: SEVERITIES.includes(raw?.severity) ? raw.severity : "info",
    target: typeof raw?.target === "string" && raw.target ? raw.target.slice(0, 60) : null,
    message: String(raw?.message || "").slice(0, 300)
  };
}

export function createSuggestionStore(dataRoot) {
  const root = join(dataRoot, "drama-suggestions");
  mkdirSync(root, { recursive: true });
  const file = (projectId) => join(root, `${projectId}.json`);

  function get(projectId) {
    if (typeof projectId !== "string" || !projectId) return null;
    if (!existsSync(file(projectId))) return null;
    try {
      const raw = JSON.parse(readFileSync(file(projectId), "utf8"));
      if (!raw || typeof raw !== "object") return null;
      return {
        projectId,
        generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : new Date().toISOString(),
        suggestions: Array.isArray(raw.suggestions) ? raw.suggestions.map(normalizeSuggestion).slice(0, 8) : []
      };
    } catch { return null; }
  }

  function save(projectId, data) {
    if (typeof projectId !== "string" || !projectId) throw Object.assign(new Error("projectId 必填"), { code: "SUGGESTION_INVALID" });
    if (!data || !Array.isArray(data.suggestions)) throw Object.assign(new Error("suggestions 必须是数组（SUGGESTION_INVALID）"), { code: "SUGGESTION_INVALID" });
    for (const s of data.suggestions) {
      if (!CATEGORIES.includes(s?.category)) throw Object.assign(new Error("建议 category 非法（SUGGESTION_INVALID）"), { code: "SUGGESTION_INVALID" });
    }
    const out = {
      projectId,
      generatedAt: typeof data.generatedAt === "string" ? data.generatedAt : new Date().toISOString(),
      suggestions: data.suggestions.map(normalizeSuggestion).slice(0, 8)
    };
    writeFileSync(file(projectId), JSON.stringify(out, null, 2));
    return out;
  }

  function remove(projectId) {
    if (existsSync(file(projectId))) { rmSync(file(projectId)); }
    return true;
  }

  return { get, save, remove };
}

// 生成建议：调 LLM，失败返回空建议不抛错
export async function generateSuggestions(project, deps = {}) {
  try {
    const result = await runSuggestions(project, deps);
    return { suggestions: result.suggestions || [], generatedAt: new Date().toISOString() };
  } catch {
    return { suggestions: [], generatedAt: new Date().toISOString() };
  }
}
