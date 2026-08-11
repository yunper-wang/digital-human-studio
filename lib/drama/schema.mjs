// lib/drama/schema.mjs
import { randomUUID } from "node:crypto";

export const DRAMA_STAGES = ["analyze", "direct", "prompt", "review"];
export const SHOT_CAMERAS = ["close-up", "medium", "wide", "over-shoulder", "low-angle"];
export const DRAMA_RATIOS = ["portrait", "landscape", "square"];
// 与 pipeline.mjs / routes.mjs 的状态字面量保持一致（含 review_blocked），三处需同步维护
export const PROJECT_STATUSES = ["draft", "awaiting_gate_a", "review_blocked", "frames", "frames_confirmed", "awaiting_gate_b", "videos", "clips_ready", "failed"];

export const DEMO_DRAMA_SCRIPT = `雨夜，林晚抱着纸箱站在便利店门口躲雨，纸箱里是她刚被辞退时收拾的全部东西。
陈默推门出来，把伞塞进她手里：「雨太大了，伞给你。」
林晚愣住：「那你怎么办？」
陈默指了指对面的地铁站，转身冲进雨里。
林晚低头，发现伞柄上贴着一张便利店会员卡的挂失回执，持卡人姓名：陈默。
她追出去两步，雨幕里已经看不到人影。`;

const FRAME_STATUSES = ["generating", "ready", "confirmed", "failed"];
export const CLIP_STATUSES = ["generating", "ready", "confirmed", "failed"];
const CLIP_PROVIDERS = ["seedance2", "comfyui"];

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

export function createDramaProject({ title, script, ratio } = {}) {
  const now = new Date().toISOString();
  return {
    id: `drama-${randomUUID()}`,
    title: String(title || "").trim().slice(0, 80) || "未命名短剧",
    script: String(script || "").trim(),
    ratio: DRAMA_RATIOS.includes(ratio) ? ratio : "portrait",
    status: "draft",
    seriesId: null,
    promptTemplateId: null,
    analysis: null,
    shots: [],
    review: null,
    budget: null,
    gateAConfirmedAt: null,
    bgm: null,
    pipeline: { stage: null, error: null, updatedAt: null },
    compose: { status: "idle", file: null, srtFile: null, error: null, startedAt: null, finishedAt: null },
    createdAt: now,
    updatedAt: now
  };
}

export function normalizeFrame(raw = {}) {
  return {
    status: FRAME_STATUSES.includes(raw?.status) ? raw.status : "pending",
    file: typeof raw?.file === "string" && raw.file ? raw.file : null,
    seed: Number.isInteger(raw?.seed) ? raw.seed : null,
    attempts: Number.isInteger(raw?.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
    error: raw?.error && typeof raw.error === "object"
      ? { code: String(raw.error.code || "FRAME_FAILED"), message: String(raw.error.message || "").slice(0, 300) }
      : null
  };
}

const AUDIO_STATUSES = ["none", "queued", "generating", "ready", "failed"];
export function normalizeAudio(raw = {}) {
  return {
    status: AUDIO_STATUSES.includes(raw?.status) ? raw.status : "none",
    file: typeof raw?.file === "string" && raw.file ? raw.file : null,
    provider: typeof raw?.provider === "string" ? raw.provider : null,
    error: raw?.error && typeof raw.error === "object"
      ? { code: String(raw.error.code || "VOICE_FAILED"), message: String(raw.error.message || "").slice(0, 300) }
      : null
  };
}

export function normalizeClip(raw = {}) {
  return {
    status: CLIP_STATUSES.includes(raw?.status) ? raw.status : "pending",
    file: typeof raw?.file === "string" && raw.file ? raw.file : null,
    provider: CLIP_PROVIDERS.includes(raw?.provider) ? raw.provider : null,
    providerTaskId: typeof raw?.providerTaskId === "string" ? raw.providerTaskId : null,
    durationSec: clampNumber(raw?.durationSec, 0, 60, 0),
    attempts: Number.isInteger(raw?.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
    error: raw?.error && typeof raw.error === "object"
      ? { code: String(raw.error.code || "CLIP_FAILED"), message: String(raw.error.message || "").slice(0, 300) }
      : null,
    audio: normalizeAudio(raw?.audio)
  };
}

export function normalizeShot(raw = {}, index = 0) {
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `shot-${index + 1}`,
    index: index + 1,
    sceneName: String(raw.sceneName || "未命名场景").slice(0, 40),
    characterIds: Array.isArray(raw.characterIds) ? raw.characterIds.map(String).slice(0, 6) : [],
    shotType: raw.shotType === "dialogue" ? "dialogue" : "cinematic",
    camera: SHOT_CAMERAS.includes(raw.camera) ? raw.camera : "medium",
    dialogue: String(raw.dialogue || "").slice(0, 600),
    action: String(raw.action || "").slice(0, 600),
    durationSec: clampNumber(raw.durationSec, 2, 15, 5),
    emotion: String(raw.emotion || "平静").slice(0, 20),
    fluxPrompt: String(raw.fluxPrompt || "").slice(0, 2000),
    negativePrompt: String(raw.negativePrompt || "").slice(0, 500),
    motionPrompt: String(raw.motionPrompt || "").slice(0, 500),
    // M4 新增：配音/静音 与 镜头衔接说明（仅提示，不参与生成；M5 才引入"原声"）
    audioMode: ["voice", "none"].includes(raw.audioMode) ? raw.audioMode : "voice",
    continuity: String(raw.continuity || "").slice(0, 120),
    frame: normalizeFrame(raw.frame),
    clip: normalizeClip(raw.clip)
  };
}

export function normalizeCharacter(raw = {}, index = 0) {
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `char-${index + 1}`,
    name: String(raw.name || `角色${index + 1}`).slice(0, 30),
    role: String(raw.role || "配角").slice(0, 20),
    personality: String(raw.personality || "").slice(0, 120),
    // 英文外观锁：注入每条 Flux 提示词，保证跨镜一致性的最小手段
    appearance: String(raw.appearance || "").slice(0, 400),
    avatarId: typeof raw.avatarId === "string" ? raw.avatarId : null,
    voiceId: typeof raw.voiceId === "string" && raw.voiceId ? raw.voiceId : null
  };
}

export function normalizeProp(raw = {}, index = 0) {
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `prop-${index + 1}`,
    name: String(raw.name || `道具${index + 1}`).slice(0, 40),
    sceneName: String(raw.sceneName || "").slice(0, 40),
    appearance: String(raw.appearance || "").slice(0, 400)
  };
}

export function normalizeAnalysis(raw = {}) {
  return {
    synopsis: String(raw.synopsis || "").slice(0, 600),
    genre: String(raw.genre || "剧情").slice(0, 30),
    characters: (Array.isArray(raw.characters) ? raw.characters : []).slice(0, 8).map((c, i) => normalizeCharacter(c, i)),
    scenes: (Array.isArray(raw.scenes) ? raw.scenes : []).slice(0, 12).map((s, i) => ({
      id: typeof s?.id === "string" && s.id ? s.id : `scene-${i + 1}`,
      name: String(s?.name || `场景${i + 1}`).slice(0, 40),
      location: String(s?.location || "").slice(0, 60),
      mood: String(s?.mood || "").slice(0, 60),
      // M6 新增：场景英文外观锁，与角色外观锁同理，保证跨镜一致性
      appearance: String(s?.appearance || "").slice(0, 400)
    })),
    props: (Array.isArray(raw.props) ? raw.props : []).slice(0, 12).map((p, i) => normalizeProp(p, i))
  };
}

export function normalizeBgm(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.file !== "string" || !raw.file) return null;
  return {
    file: raw.file,
    name: String(raw.name || "背景音乐").slice(0, 60),
    volume: Math.min(1, Math.max(0, Number(raw.volume) || 0.3))
  };
}

export function normalizeCompose(raw = {}) {
  const STATUSES = ["idle", "running", "succeeded", "failed"];
  return {
    status: STATUSES.includes(raw?.status) ? raw.status : "idle",
    file: typeof raw?.file === "string" && raw.file ? raw.file : null,
    srtFile: typeof raw?.srtFile === "string" && raw.srtFile ? raw.srtFile : null,
    error: raw?.error && typeof raw.error === "object"
      ? { code: String(raw.error.code || "COMPOSE_FAILED"), message: String(raw.error.message || "").slice(0, 300) }
      : null,
    startedAt: typeof raw?.startedAt === "string" ? raw.startedAt : null,
    finishedAt: typeof raw?.finishedAt === "string" ? raw.finishedAt : null
  };
}

export function normalizeProject(raw = {}) {
  const now = new Date().toISOString();
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `drama-${randomUUID()}`,
    title: String(raw.title || "").trim().slice(0, 80) || "未命名短剧",
    script: String(raw.script || "").trim(),
    ratio: DRAMA_RATIOS.includes(raw.ratio) ? raw.ratio : "portrait",
    status: PROJECT_STATUSES.includes(raw.status) ? raw.status : "draft",
    seriesId: typeof raw.seriesId === "string" && raw.seriesId ? raw.seriesId : null,
    promptTemplateId: typeof raw.promptTemplateId === "string" && raw.promptTemplateId ? raw.promptTemplateId : null,
    analysis: raw.analysis && typeof raw.analysis === "object" ? normalizeAnalysis(raw.analysis) : null,
    shots: (Array.isArray(raw.shots) ? raw.shots : []).map((s, i) => normalizeShot(s, i)),
    bgm: normalizeBgm(raw.bgm),
    compose: normalizeCompose(raw.compose),
    review: raw.review && typeof raw.review === "object" ? raw.review : null,
    budget: raw.budget && typeof raw.budget === "object" ? raw.budget : null,
    gateAConfirmedAt: typeof raw.gateAConfirmedAt === "string" ? raw.gateAConfirmedAt : null,
    pipeline: {
      stage: typeof raw.pipeline?.stage === "string" ? raw.pipeline.stage : null,
      error: raw.pipeline?.error && typeof raw.pipeline.error === "object"
        ? { code: String(raw.pipeline.error.code || "PIPELINE_FAILED"), message: String(raw.pipeline.error.message || "").slice(0, 300) }
        : null,
      updatedAt: typeof raw.pipeline?.updatedAt === "string" ? raw.pipeline.updatedAt : null
    },
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now
  };
}

export function normalizeSnapshot(raw = {}) {
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `ver-${randomUUID()}`,
    projectId: String(raw.projectId || ""),
    name: String(raw.name || "未命名版本").slice(0, 60),
    script: String(raw.script || ""),
    analysis: raw.analysis ? normalizeAnalysis(raw.analysis) : null,
    shots: (Array.isArray(raw.shots) ? raw.shots : []).map((s, i) => normalizeShot(s, i)),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString()
  };
}

export function validateAnalysis(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["analysis 必须是对象"];
  if (!String(value.synopsis || "").trim()) errors.push("缺少 synopsis");
  if (!Array.isArray(value.characters) || value.characters.length < 1) errors.push("characters 至少 1 个角色");
  (value.characters || []).forEach((c, i) => {
    if (!String(c?.name || "").trim()) errors.push(`characters[${i}] 缺少 name`);
    if (!String(c?.appearance || "").trim()) errors.push(`characters[${i}] 缺少 appearance（英文外观锁）`);
  });
  if (!Array.isArray(value.scenes) || value.scenes.length < 1) errors.push("scenes 至少 1 个场景");
  return errors;
}

export function validateDirectedShots(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["direct 输出必须是对象"];
  if (!Array.isArray(value.shots) || value.shots.length < 1) errors.push("shots 至少 1 个分镜");
  if (Array.isArray(value.shots) && value.shots.length > 24) errors.push("shots 最多 24 个分镜");
  (value.shots || []).forEach((s, i) => {
    if (!String(s?.action || "").trim() && !String(s?.dialogue || "").trim()) {
      errors.push(`shots[${i}] 需要 action 或 dialogue`);
    }
  });
  return errors;
}

export function validatePromptedShots(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["prompt 输出必须是对象"];
  if (!Array.isArray(value.shots) || value.shots.length < 1) errors.push("shots 至少 1 个分镜");
  (value.shots || []).forEach((s, i) => {
    if (String(s?.fluxPrompt || "").trim().length < 20) errors.push(`shots[${i}] fluxPrompt 至少 20 个字符`);
  });
  return errors;
}

export function validateReview(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["review 输出必须是对象"];
  if (typeof value.pass !== "boolean") errors.push("pass 必须是布尔值");
  if (!Array.isArray(value.issues)) errors.push("issues 必须是数组");
  (value.issues || []).forEach((issue, i) => {
    if (!["block", "warn"].includes(issue?.severity)) errors.push(`issues[${i}].severity 必须是 block 或 warn`);
    if (!String(issue?.message || "").trim()) errors.push(`issues[${i}] 缺少 message`);
  });
  return errors;
}
