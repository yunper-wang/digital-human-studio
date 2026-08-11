// lib/drama/prompts.mjs
// 提示词模板库：多模板 + 项目选用；存 data/prompt-templates/，一模板一 JSON
// 种子化内置默认（只读不可删）；resolveStages 逐段回退默认，流水线永不因模板问题中断
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_ANALYZE, SYSTEM_DIRECT, SYSTEM_PROMPT, SYSTEM_REVIEW } from "./agents.mjs";

export const PROMPT_STAGES = ["analyze", "direct", "prompt", "review"];
export const BUILTIN_TEMPLATE_ID = "ptpl-builtin-default";

export function createPromptStore(dataRoot) {
  const root = join(dataRoot, "prompt-templates");
  mkdirSync(root, { recursive: true });
  const file = (id) => join(root, `${id}.json`);

  function normalizeTemplate(raw = {}) {
    const stages = raw.stages && typeof raw.stages === "object" ? raw.stages : {};
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : `ptpl-${randomUUID()}`,
      name: String(raw.name || "未命名模板").slice(0, 60),
      stages: {
        analyze: String(stages.analyze || ""),
        direct: String(stages.direct || ""),
        prompt: String(stages.prompt || ""),
        review: String(stages.review || "")
      },
      builtin: raw.builtin === true,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString()
    };
  }

  // 种子化内置默认模板（幂等：已存在不覆盖）
  if (!existsSync(file(BUILTIN_TEMPLATE_ID))) {
    writeFileSync(file(BUILTIN_TEMPLATE_ID), JSON.stringify(normalizeTemplate({
      id: BUILTIN_TEMPLATE_ID,
      name: "默认模板",
      stages: { analyze: SYSTEM_ANALYZE, direct: SYSTEM_DIRECT, prompt: SYSTEM_PROMPT, review: SYSTEM_REVIEW },
      builtin: true
    }), null, 2));
  }

  function save(tpl) {
    tpl.updatedAt = new Date().toISOString();
    writeFileSync(file(tpl.id), JSON.stringify(tpl, null, 2));
    return tpl;
  }
  function get(id) {
    if (typeof id !== "string" || !/^ptpl-[a-z0-9-]+$/.test(id) || !existsSync(file(id))) return null;
    try { return normalizeTemplate(JSON.parse(readFileSync(file(id), "utf8"))); } catch { return null; }
  }
  function list() {
    return readdirSync(root).filter((f) => /^ptpl-.*\.json$/.test(f))
      .map((f) => { try { return normalizeTemplate(JSON.parse(readFileSync(join(root, f), "utf8"))); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => Number(b.builtin) - Number(a.builtin) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  function create({ name, stages } = {}) { return save(normalizeTemplate({ name, stages })); }
  function remove(id) {
    const tpl = get(id);
    if (!tpl || tpl.builtin) return false;
    rmSync(file(id));
    return true;
  }
  function duplicate(id) {
    const src = get(id);
    if (!src) return null;
    return save(normalizeTemplate({ name: `${src.name} 副本`.slice(0, 60), stages: src.stages }));
  }
  // 逐段回退：永远返回完整四段；未选/模板缺失/某段为空 → 该段回退内置默认
  function resolveStages(templateId) {
    const fallback = get(BUILTIN_TEMPLATE_ID).stages;
    const tpl = templateId ? get(templateId) : null;
    if (!tpl) return { ...fallback };
    const out = {};
    for (const stage of PROMPT_STAGES) out[stage] = tpl.stages[stage].trim() ? tpl.stages[stage] : fallback[stage];
    return out;
  }

  return { list, get, create, save, remove, duplicate, resolveStages };
}
