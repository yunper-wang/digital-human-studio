// lib/drama/pipeline.mjs
import { DRAMA_STAGES } from "./schema.mjs";
import { runScriptAnalysis, runDirection, runPromptWriting, runReview } from "./agents.mjs";
import { estimateBudget, getDramaPricing } from "./budget.mjs";
import { generateSuggestions } from "./suggestions.mjs";

export const PIPELINE_STAGE_STATUS = {
  analyze: "analyzing",
  direct: "directing",
  prompt: "prompting",
  review: "reviewing"
};

const running = new Set();

export function isPipelineRunning(projectId) {
  return running.has(projectId);
}

export async function runDramaPipeline(store, projectId, { fromStage = "analyze", deps = {}, pricing } = {}) {
  if (running.has(projectId)) return { reused: true };
  const project = store.get(projectId);
  if (!project) throw Object.assign(new Error("项目不存在"), { code: "DRAMA_PROJECT_NOT_FOUND" });
  // M7：按项目所选提示词模板注入四段系统提示词（未选/模板缺失 → 内置默认，永不阻断）
  if (deps.promptStore) deps = { ...deps, prompts: deps.promptStore.resolveStages(project.promptTemplateId) };
  const stageIndex = DRAMA_STAGES.indexOf(fromStage);
  const stages = DRAMA_STAGES.slice(stageIndex === -1 ? 0 : stageIndex);
  running.add(projectId);
  let currentStage = null;
  try {
    for (const stage of stages) {
      currentStage = stage;
      store.update(projectId, (p) => {
        p.status = PIPELINE_STAGE_STATUS[stage];
        p.pipeline = { stage, error: null, updatedAt: new Date().toISOString() };
      });
      if (stage === "analyze") {
        const analysis = await runScriptAnalysis(store.get(projectId), deps);
        store.update(projectId, (p) => { p.analysis = analysis; });
        // M12：分析后自动生成智能建议（异步、失败不阻塞流水线）
        if (deps.suggestionStore) {
          generateSuggestions(store.get(projectId), deps).then((result) => {
            if (result?.suggestions?.length) deps.suggestionStore.save(projectId, result);
          }).catch(() => {});
        }
      } else if (stage === "direct") {
        const shots = await runDirection(store.get(projectId), deps);
        store.update(projectId, (p) => {
          p.shots = shots;
          // 分镜重排后旧预算与费用确认一律作废
          p.gateAConfirmedAt = null;
          p.budget = null;
        });
      } else if (stage === "prompt") {
        const shots = await runPromptWriting(store.get(projectId), deps);
        store.update(projectId, (p) => { p.shots = shots; });
      } else if (stage === "review") {
        const review = await runReview(store.get(projectId), deps);
        store.update(projectId, (p) => {
          p.review = { ...review, reviewedAt: new Date().toISOString() };
          p.budget = estimateBudget(p, pricing || getDramaPricing());
          const blocked = !review.pass || review.issues.some((issue) => issue.severity === "block");
          p.status = blocked ? "review_blocked" : "awaiting_gate_a";
          p.pipeline = { stage: null, error: null, updatedAt: new Date().toISOString() };
        });
      }
    }
    return { reused: false };
  } catch (error) {
    store.update(projectId, (p) => {
      p.status = "failed";
      p.pipeline = {
        stage: currentStage,
        error: { code: error.code || "DRAMA_PIPELINE_FAILED", message: error.message, stage: currentStage },
        updatedAt: new Date().toISOString()
      };
    });
    return { reused: false };
  } finally {
    running.delete(projectId);
  }
}
