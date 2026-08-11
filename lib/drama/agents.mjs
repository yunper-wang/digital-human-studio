// lib/drama/agents.mjs
// 四个确定性流水线阶段：结构化提示词 + JSON 校验 + 一次带反馈的重试（仅 LLM 调用，不涉及付费生成）
import { callDramaLlm, extractJson } from "./llm.mjs";
import {
  normalizeAnalysis, normalizeShot,
  validateAnalysis, validateDirectedShots, validatePromptedShots, validateReview
} from "./schema.mjs";

export const SYSTEM_ANALYZE = `你是短剧剧本分析师。只输出 JSON，不要输出任何解释。
输出结构：{"synopsis":"一句话梗概","genre":"类型","characters":[{"id":"char-1","name":"角色名","role":"主角|配角","personality":"性格","appearance":"英文外观锁定描述，含年龄感/发型/服装/标志性特征，供图像模型使用"}],"scenes":[{"id":"scene-1","name":"场景名","location":"地点","mood":"氛围","appearance":"英文场景外观锁，含地点/光线/陈设"}],"props":[{"id":"prop-1","name":"道具名","sceneName":"所属场景名","appearance":"英文道具外观锁，含材质/标志物"}]}
要求：characters 覆盖全部有台词或关键动作的角色；appearance 必须是英文、具体、可在不同镜头间保持一致；scenes 与 props 的 appearance 同样是英文、具体、可复用；props 覆盖推动剧情的关键道具。`;

export const SYSTEM_DIRECT = `你是短剧导演。把剧本拆成 3-12 个分镜，只输出 JSON。
输出结构：{"shots":[{"id":"shot-1","sceneName":"场景名","characterIds":["char-1"],"shotType":"dialogue|cinematic","camera":"close-up|medium|wide|over-shoulder|low-angle","dialogue":"该镜台词，无则空串","action":"画面动作描述","durationSec":2-15的整数,"emotion":"情绪"}]}
要求：有台词的镜头用 dialogue 类型（后续走数字人口播）；纯画面用 cinematic；镜头时长总和控制在 90 秒内；characterIds 只能引用分析结果中的角色 id。`;

export const SYSTEM_PROMPT = `你是 AI 视频提示词工程师。为每个分镜写 Flux 首帧提示词，只输出 JSON。
输出结构：{"shots":[{"id":"shot-1","fluxPrompt":"英文提示词","negativePrompt":"英文负面提示词","motionPrompt":"英文运动提示词"}]}
要求：fluxPrompt 必须以 "cinematic film still" 开头，包含该镜每个出场角色的 appearance 原文、所在场景的 appearance、相关道具的 appearance、camera 景别、action 画面、emotion 氛围；全英文；80-200 词。`;

export const SYSTEM_REVIEW = `你是短剧内容审核员。审核分镜表的文本内容，只输出 JSON。
输出结构：{"pass":true|false,"issues":[{"shotId":"shot-1或null","severity":"block|warn","message":"问题描述"}]}
block 标准：违法违规、露骨色情、仇恨歧视、未成年人风险、明确侵权。warn 标准：台词与画面不符、时长异常、角色缺失。没有问题则 issues 为空数组、pass 为 true。`;

async function callStage(stage, system, payload, validate, deps) {
  let user = JSON.stringify(payload, null, 2);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // M7：deps.prompts[stage] 存在时覆盖默认系统提示词（提示词模板注入点）
    const text = await callDramaLlm(stage, { system: deps.prompts?.[stage] || system, user }, deps);
    try {
      const value = extractJson(text);
      const errors = validate(value);
      if (!errors.length) return value;
      lastError = new Error(errors.join("；"));
    } catch (error) {
      lastError = error;
    }
    user = `${JSON.stringify(payload)}\n\n上次输出不合法：${lastError.message}。请只输出合法 JSON。`;
  }
  throw Object.assign(new Error(`${stage} 阶段输出校验失败：${lastError.message}`), { code: "DRAMA_STAGE_INVALID", stage });
}

export async function runScriptAnalysis(project, deps = {}) {
  const value = await callStage("analyze", SYSTEM_ANALYZE, { script: project.script }, validateAnalysis, deps);
  return normalizeAnalysis(value);
}

export async function runDirection(project, deps = {}) {
  const value = await callStage("direct", SYSTEM_DIRECT,
    { script: project.script, analysis: project.analysis }, validateDirectedShots, deps);
  const knownIds = new Set((project.analysis?.characters || []).map((c) => c.id));
  return value.shots.map((raw, i) => {
    const shot = normalizeShot(raw, i);
    shot.characterIds = shot.characterIds.filter((id) => knownIds.has(id));
    shot.fluxPrompt = "";
    shot.negativePrompt = "";
    shot.motionPrompt = "";
    return shot;
  });
}

export async function runPromptWriting(project, deps = {}) {
  const current = project.shots.map((shot, i) => normalizeShot(shot, i));
  const value = await callStage("prompt", SYSTEM_PROMPT,
    { analysis: project.analysis, shots: current }, validatePromptedShots, deps);
  const prompted = new Map(value.shots.map((s) => [String(s.id), s]));
  return current.map((shot) => {
    const patch = prompted.get(shot.id);
    if (!patch) return shot;
    return normalizeShot({ ...shot, fluxPrompt: patch.fluxPrompt, negativePrompt: patch.negativePrompt, motionPrompt: patch.motionPrompt }, shot.index - 1);
  });
}

export async function runReview(project, deps = {}) {
  const value = await callStage("review", SYSTEM_REVIEW,
    { analysis: project.analysis, shots: project.shots }, validateReview, deps);
  return {
    pass: value.pass,
    issues: value.issues.map((issue) => ({
      shotId: typeof issue.shotId === "string" ? issue.shotId : null,
      severity: issue.severity,
      message: String(issue.message).slice(0, 300)
    }))
  };
}
