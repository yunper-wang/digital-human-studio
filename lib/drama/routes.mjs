// lib/drama/routes.mjs
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DRAMA_STAGES, SHOT_CAMERAS, DRAMA_RATIOS, createDramaProject, normalizeShot, normalizeClip, normalizeAudio, normalizeBgm, DEMO_DRAMA_SCRIPT } from "./schema.mjs";
import { runDramaPipeline, isPipelineRunning } from "./pipeline.mjs";
import { estimateBudget } from "./budget.mjs";
import { generateFluxFrame, getComfyuiStatus, FRAME_SIZES, loadVideoWorkflowTemplate, uploadComfyuiImage, generateComfyuiVideo } from "./comfyui.mjs";
import { runSeedanceGeneration } from "../seedance.mjs";
import { detectFfmpeg } from "./ffmpeg.mjs";
import { composeFilm } from "./compose.mjs";
import { resolveShotVoice, synthesizeShotVoice } from "./audio.mjs";
import { saveVersion, listVersions, readVersion, rollbackVersion } from "./version.mjs";

const PROJECT_ID_PATTERN = /^drama-[a-f0-9-]+$/;
const EDITABLE_STATUSES = ["awaiting_gate_a", "review_blocked", "frames", "awaiting_gate_b"];
const PIPELINE_STARTABLE = ["draft", "failed", "review_blocked", "awaiting_gate_a"];

// 系统级错误（ENOENT/EACCES 等）的 message 可能含本机绝对路径，落盘前脱敏
function safeErrorMessage(error) {
  const code = String(error?.code || "");
  if (!code || /^E[A-Z_0-9]+$/.test(code)) return `本地文件系统错误（${code || "UNKNOWN"}）`;
  return String(error.message || "").slice(0, 300);
}

function parts(url) {
  return url.pathname.split("/").filter(Boolean);
}

// 首帧生成执行器：与 generateSeedanceVideo 同模式，直接更新项目内分镜状态
export async function generateShotFrame(ctx, projectId, shotId, seed) {
  const { store, comfyConfig } = ctx;
  const fetchImpl = ctx.frameFetch || fetch;
  const sleep = ctx.frameSleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const setFrame = (patch) => store.update(projectId, (p) => {
    const shot = p.shots.find((s) => s.id === shotId);
    if (!shot) return;
    shot.frame = { ...shot.frame, ...patch };
    // 已有任一镜的 clip 进入生成/完成态时，首帧重抽不得把项目状态回退到首帧阶段
    const clipInFlightOrDone = p.shots.some((s) => ["generating", "ready", "confirmed"].includes(normalizeClip(s.clip).status));
    if (!clipInFlightOrDone) {
      if (p.shots.every((s) => s.frame.status === "confirmed")) {
        p.status = "frames_confirmed";
      } else if (p.shots.every((s) => ["ready", "confirmed"].includes(s.frame.status))) {
        p.status = "awaiting_gate_b";
      }
    }
  });
  const project = store.get(projectId);
  const shot = project?.shots.find((s) => s.id === shotId);
  if (!shot) return;
  const finalSeed = Number.isInteger(seed) ? seed : (shot.index * 100_000 + shot.frame.attempts * 7919) % 2 ** 31;
  try {
    setFrame({ status: "generating", error: null });
    const [width, height] = FRAME_SIZES[project.ratio] || FRAME_SIZES.portrait;
    const bytes = await generateFluxFrame({
      config: comfyConfig,
      prompt: shot.fluxPrompt,
      negativePrompt: shot.negativePrompt,
      width, height,
      seed: finalSeed,
      fetchImpl,
      sleep,
      clientId: projectId
    });
    const fileName = `${shotId}-${finalSeed}.png`;
    writeFileSync(join(store.dir(projectId), "frames", fileName), bytes);
    setFrame({ status: "ready", file: fileName, seed: finalSeed, attempts: shot.frame.attempts + 1, error: null });
  } catch (error) {
    // 不自动重试：失败态落盘，由用户决定是否换抽
    setFrame({
      status: "failed",
      error: { code: error.code || "FRAME_FAILED", message: safeErrorMessage(error) }
    });
  }
}

// 视频生成执行器：口播镜走 Seedance（角色形象+音色+台词），剧情镜走 ComfyUI 视频模板（首帧+运动提示词）
export async function generateShotClip(ctx, projectId, shotId) {
  const { store } = ctx;
  const setClip = (patch) => store.update(projectId, (p) => {
    const shot = p.shots.find((s) => s.id === shotId);
    if (!shot) return;
    shot.clip = { ...normalizeClip(shot.clip), ...patch };
    if (p.shots.every((s) => normalizeClip(s.clip).status === "confirmed")) {
      p.status = "clips_ready";
    } else if (p.shots.some((s) => ["generating", "ready"].includes(normalizeClip(s.clip).status))) {
      p.status = "videos";
    }
  });
  const project = store.get(projectId);
  const shot = project?.shots.find((s) => s.id === shotId);
  if (!shot) return;
  const attempts = normalizeClip(shot.clip).attempts;
  const isDialogue = shot.shotType === "dialogue";
  try {
    setClip({ status: "generating", error: null, provider: isDialogue ? "seedance2" : "comfyui" });
    const fileName = `${shotId}-clip-${attempts + 1}.mp4`;
    if (isDialogue) {
      const character = project.analysis.characters.find((c) => c.id === shot.characterIds[0]);
      const runDir = join(store.dir(projectId), "clips", `run-${shotId}-${attempts + 1}`);
      const result = await runSeedanceGeneration({
        config: ctx.seedanceConfig,
        payload: {
          title: `${project.title} 镜${shot.index}`.slice(0, 80),
          script: shot.dialogue,
          avatarId: character.avatarId,
          voiceId: character.voiceId,
          ratio: project.ratio,
          generationPrompt: "" // 走 buildSeedancePrompt 标准口播提示词
        },
        runDir,
        durationSec: shot.durationSec,
        onEvent: (event) => {
          if (event.phase === "submitted") setClip({ providerTaskId: event.providerTaskId });
        }
      });
      copyFileSync(result.videoPath, join(store.dir(projectId), "clips", fileName));
      setClip({ status: "ready", file: fileName, providerTaskId: result.providerTaskId, durationSec: shot.durationSec, attempts: attempts + 1, error: null });
    } else {
      const template = loadVideoWorkflowTemplate(ctx.videoEnv || process.env);
      if (!template) throw Object.assign(new Error("未配置剧情镜视频工作流模板"), { code: "VIDEO_WORKFLOW_NOT_CONFIGURED" });
      const fetchImpl = ctx.frameFetch || fetch;
      const sleep = ctx.frameSleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
      const frameBytes = readFileSync(join(store.dir(projectId), "frames", shot.frame.file));
      const imageName = await uploadComfyuiImage({ config: ctx.comfyConfig, bytes: frameBytes, filename: `${shotId}-frame.png`, fetchImpl });
      const [width, height] = FRAME_SIZES[project.ratio] || FRAME_SIZES.portrait;
      const fps = 24;
      const bytes = await generateComfyuiVideo({
        config: ctx.comfyConfig,
        template,
        values: {
          PROMPT: shot.motionPrompt || shot.action,
          IMAGE: imageName,
          SEED: (shot.index * 100_000 + attempts * 7919 + 1) % 2 ** 31,
          WIDTH: width,
          HEIGHT: height,
          FPS: fps,
          FRAMES: shot.durationSec * fps
        },
        fetchImpl,
        sleep,
        clientId: projectId
      });
      writeFileSync(join(store.dir(projectId), "clips", fileName), bytes);
      setClip({ status: "ready", file: fileName, durationSec: shot.durationSec, attempts: attempts + 1, error: null });
    }
  } catch (error) {
    // 不自动重试：失败态落盘，由用户决定是否付费重生成
    setClip({ status: "failed", error: { code: error.code || "CLIP_FAILED", message: safeErrorMessage(error) } });
  }
}

// 对白镜配音执行器：与 generateShotClip 同模式，直接更新分镜 clip.audio 状态
export async function generateShotVoice(ctx, projectId, shotId) {
  const { store } = ctx;
  const setAudio = (patch) => store.update(projectId, (p) => {
    const shot = p.shots.find((s) => s.id === shotId);
    if (shot) shot.clip = { ...normalizeClip(shot.clip), audio: { ...normalizeAudio(shot.clip?.audio), ...patch } };
  });
  const project = store.get(projectId);
  const shot = project?.shots.find((s) => s.id === shotId);
  if (!shot) return;
  try {
    setAudio({ status: "generating", error: null });
    const character = project.analysis?.characters?.find((c) => c.id === shot.characterIds[0]);
    const target = resolveShotVoice(character, ctx.findVoice);
    if (!target) throw Object.assign(new Error("该对白镜角色未绑定可用音色"), { code: "VOICE_UNAVAILABLE" });
    const { bytes, provider } = await synthesizeShotVoice({ voiceTarget: target, text: shot.dialogue, language: "zh", deps: ctx.audioDeps || {} });
    mkdirSync(join(store.dir(projectId), "audio"), { recursive: true });
    const fileName = `${shotId}.mp3`;
    writeFileSync(join(store.dir(projectId), "audio", fileName), bytes);
    setAudio({ status: "ready", file: fileName, provider, error: null });
  } catch (error) {
    setAudio({ status: "failed", error: { code: error.code || "VOICE_FAILED", message: safeErrorMessage(error) } });
  }
}

export async function handleDramaApi(request, response, url, ctx) {
  const { sendJson, envelope, readJson, allowRequest, store } = ctx;
  const segments = parts(url);
  // segments: ["api", "drama", ...]
  if (segments[0] !== "api" || segments[1] !== "drama") return false;
  const requestId = randomUUID();

  if (request.method === "GET" && segments.length === 3 && segments[2] === "demo") {
    return sendJson(response, 200, envelope(true, { script: DEMO_DRAMA_SCRIPT }, { requestId }));
  }

  if (segments.length === 3 && segments[2] === "projects" && request.method === "GET") {
    return sendJson(response, 200, envelope(true, { projects: store.list() }, { requestId }));
  }

  if (segments.length === 3 && segments[2] === "projects" && request.method === "POST") {
    const ip = request.socket.remoteAddress || "local";
    if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
    let payload;
    try {
      payload = await readJson(request, 200_000);
    } catch (error) {
      return sendJson(response, 400, envelope(false, null, { requestId, errorCode: error.message, message: "请求内容无效" }));
    }
    const script = String(payload.script || "").trim();
    if (script.length < 50 || script.length > 20_000) {
      return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "DRAMA_SCRIPT_INVALID", message: "剧本需为 50–20000 个字符" }));
    }
    const project = createDramaProject({ title: payload.title, script, ratio: payload.ratio });
    store.save(project);
    return sendJson(response, 201, envelope(true, { project }, { requestId }));
  }

  const projectId = segments[3] || "";
  if (segments.length >= 4 && segments[2] === "projects") {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_PROJECT_NOT_FOUND", message: "项目不存在" }));
    }
    const project = store.get(projectId);
    if (!project) {
      return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_PROJECT_NOT_FOUND", message: "项目不存在" }));
    }

    if (segments.length === 4 && request.method === "GET") {
      return sendJson(response, 200, envelope(true, { project }, { requestId }));
    }

    if (segments.length === 4 && request.method === "PATCH") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      let payload;
      try {
        payload = await readJson(request, 200_000);
      } catch (error) {
        return sendJson(response, 400, envelope(false, null, { requestId, errorCode: error.message, message: "请求内容无效" }));
      }
      // 先校验再进 update：在 patcher 里抛错会变成 500，且 title/ratio 可能已污染缓存
      if (typeof payload.script === "string") {
        const script = payload.script.trim();
        if (script.length < 50 || script.length > 20_000) {
          return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "DRAMA_SCRIPT_INVALID", message: "剧本需为 50–20000 个字符" }));
        }
      }
      const updated = store.update(projectId, (p) => {
        if (typeof payload.title === "string") p.title = payload.title.trim().slice(0, 80) || p.title;
        if (typeof payload.ratio === "string" && DRAMA_RATIOS.includes(payload.ratio)) p.ratio = payload.ratio;
        if (typeof payload.script === "string") {
          // 此处 script 已通过上方长度校验
          const script = payload.script.trim();
          if (script !== p.script && p.status !== "draft") {
            // 剧本变更使全部分析产物作废，回到草稿
            p.script = script;
            p.analysis = null;
            p.shots = [];
            p.review = null;
            p.budget = null;
            p.gateAConfirmedAt = null;
            p.pipeline = { stage: null, error: null, updatedAt: null };
            p.status = "draft";
          } else {
            p.script = script;
          }
        }
      });
      return sendJson(response, 200, envelope(true, { project: updated }, { requestId }));
    }

    if (segments.length === 5 && segments[4] === "pipeline" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      let payload = {};
      try {
        payload = await readJson(request, 10_000);
      } catch {
        return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" }));
      }
      const fromStage = payload.fromStage ?? (project.pipeline?.error?.stage || "analyze");
      if (!DRAMA_STAGES.includes(fromStage)) {
        return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "DRAMA_STAGE_INVALID", message: "无效的流水线阶段" }));
      }
      if (!PIPELINE_STARTABLE.includes(project.status)) {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "DRAMA_STATUS_CONFLICT", message: `当前状态（${project.status}）不能发起流水线` }));
      }
      if (isPipelineRunning(projectId)) {
        return sendJson(response, 200, envelope(true, { projectId, reused: true }, { requestId }));
      }
      // 与 generateSeedanceVideo 同模式：异步执行，客户端轮询项目状态
      runDramaPipeline(store, projectId, { fromStage, deps: ctx.llmDeps, pricing: ctx.pricing }).catch(() => {});
      return sendJson(response, 202, envelope(true, { projectId, reused: false }, { requestId }));
    }

    if (segments.length === 5 && segments[4] === "gate-a" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      let payload = {};
      try {
        payload = await readJson(request, 10_000);
      } catch {
        return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" }));
      }
      if (payload.confirmCost !== true) {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "COST_CONFIRMATION_REQUIRED", message: "进入首帧生成前需要确认预算" }));
      }
      if (project.status !== "awaiting_gate_a") {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "DRAMA_STATUS_CONFLICT", message: "当前状态不能确认预算闸门" }));
      }
      const updated = store.update(projectId, (p) => {
        p.budget = estimateBudget(p, ctx.pricing); // 确认时以最新分镜重算
        p.gateAConfirmedAt = new Date().toISOString();
        p.status = "frames";
      });
      return sendJson(response, 200, envelope(true, { project: updated }, { requestId }));
    }

    if (segments.length === 6 && segments[4] === "characters" && request.method === "PATCH") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      let payload;
      try {
        payload = await readJson(request, 10_000);
      } catch (error) {
        return sendJson(response, 400, envelope(false, null, { requestId, errorCode: error.message, message: "请求内容无效" }));
      }
      const character = project.analysis?.characters?.find((c) => c.id === segments[5]);
      if (!character) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_CHARACTER_NOT_FOUND", message: "角色不存在" }));
      if (typeof payload.avatarId === "string" && payload.avatarId && !ctx.findAvatar(payload.avatarId)) {
        return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "AVATAR_NOT_FOUND", message: "找不到所选人物形象" }));
      }
      if (typeof payload.voiceId === "string" && payload.voiceId && !ctx.findVoice(payload.voiceId)) {
        return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "VOICE_NOT_FOUND", message: "该音色没有本地参考音频，仅支持本地/自定义音色" }));
      }
      const updated = store.update(projectId, (p) => {
        const target = p.analysis.characters.find((c) => c.id === segments[5]);
        const avatarChanged = payload.avatarId !== undefined && (payload.avatarId || null) !== target.avatarId;
        const voiceChanged = payload.voiceId !== undefined && (payload.voiceId || null) !== target.voiceId;
        if (payload.avatarId !== undefined) target.avatarId = payload.avatarId || null;
        if (payload.voiceId !== undefined) target.voiceId = payload.voiceId || null;
        if (avatarChanged || voiceChanged) {
          // 换绑形象/音色后，其出演的口播镜成片作废（与 prompt 变更重置 frame 同一纪律）
          for (const shot of p.shots) {
            if (shot.shotType === "dialogue" && shot.characterIds.includes(target.id)
              && ["ready", "confirmed"].includes(shot.clip?.status)) {
              shot.clip = { ...normalizeClip(), attempts: shot.clip.attempts };
            }
          }
          if (p.status === "clips_ready") p.status = "videos";
        }
      });
      return sendJson(response, 200, envelope(true, { project: updated }, { requestId }));
    }

    if (segments.length === 6 && segments[4] === "shots" && request.method === "PATCH") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      if (!EDITABLE_STATUSES.includes(project.status)) {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "DRAMA_STATUS_CONFLICT", message: "当前状态不能编辑分镜" }));
      }
      let payload;
      try {
        payload = await readJson(request, 40_000);
      } catch (error) {
        return sendJson(response, 400, envelope(false, null, { requestId, errorCode: error.message, message: "请求内容无效" }));
      }
      let found = false;
      const updated = store.update(projectId, (p) => {
        const index = p.shots.findIndex((s) => s.id === segments[5]);
        if (index === -1) return;
        found = true;
        const shot = p.shots[index];
        const promptChanged = (typeof payload.fluxPrompt === "string" && payload.fluxPrompt !== shot.fluxPrompt)
          || (typeof payload.negativePrompt === "string" && payload.negativePrompt !== shot.negativePrompt);
        const budgetChanged = (typeof payload.dialogue === "string" && payload.dialogue !== shot.dialogue)
          || (payload.durationSec !== undefined && Number(payload.durationSec) !== shot.durationSec);
        const merged = normalizeShot({ ...shot, ...payload }, index);
        if (promptChanged) {
          merged.frame = { status: "pending", file: null, seed: null, attempts: shot.frame.attempts, error: null };
          if (p.status === "awaiting_gate_b" || p.status === "frames_confirmed") p.status = "frames";
        }
        p.shots[index] = merged;
        if (budgetChanged) {
          p.budget = estimateBudget(p, ctx.pricing);
          if (p.gateAConfirmedAt) {
            // 台词/时长变了预算就变了，费用确认必须重做
            p.gateAConfirmedAt = null;
            p.status = "awaiting_gate_a";
          }
        }
      });
      if (!found) {
        return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_SHOT_NOT_FOUND", message: "分镜不存在" }));
      }
      return sendJson(response, 200, envelope(true, { project: updated }, { requestId }));
    }

    if (segments.length === 7 && segments[4] === "shots" && segments[6] === "frame" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      const shot = project.shots.find((s) => s.id === segments[5]);
      if (!shot) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_SHOT_NOT_FOUND", message: "分镜不存在" }));
      if (!project.gateAConfirmedAt) {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "GATE_A_REQUIRED", message: "请先确认预算闸门，再生成首帧" }));
      }
      if (shot.frame.status === "generating") {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "FRAME_BUSY", message: "该分镜正在生成首帧" }));
      }
      let payload = {};
      try {
        payload = await readJson(request, 10_000);
      } catch {
        return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" }));
      }
      const comfyui = await getComfyuiStatus(ctx.comfyConfig);
      if (!comfyui.connected) {
        return sendJson(response, 503, envelope(false, null, { requestId, errorCode: "COMFYUI_UNAVAILABLE", message: "未连接本机 ComfyUI 服务，请先配置 COMFYUI_URL" }));
      }
      const seed = Number.isInteger(payload.seed) ? payload.seed : null;
      generateShotFrame(ctx, projectId, shot.id, seed).catch(() => {});
      return sendJson(response, 202, envelope(true, { shotId: shot.id, status: "generating" }, { requestId }));
    }

    if (segments.length === 7 && segments[4] === "shots" && segments[6] === "confirm" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      const shot = project.shots.find((s) => s.id === segments[5]);
      if (!shot) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_SHOT_NOT_FOUND", message: "分镜不存在" }));
      if (shot.frame.status !== "ready") {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "FRAME_NOT_READY", message: "首帧尚未生成完成" }));
      }
      const updated = store.update(projectId, (p) => {
        const target = p.shots.find((s) => s.id === shot.id);
        target.frame = { ...target.frame, status: "confirmed" };
        // 已有任一镜的 clip 进入生成/完成态时，确认首帧不得把项目状态回退到首帧阶段
        const clipInFlightOrDone = p.shots.some((s) => ["generating", "ready", "confirmed"].includes(normalizeClip(s.clip).status));
        if (!clipInFlightOrDone && p.shots.every((s) => s.frame.status === "confirmed")) p.status = "frames_confirmed";
      });
      return sendJson(response, 200, envelope(true, { project: updated }, { requestId }));
    }

    if (segments.length === 7 && segments[4] === "shots" && segments[6] === "video" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      const shot = project.shots.find((s) => s.id === segments[5]);
      if (!shot) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_SHOT_NOT_FOUND", message: "分镜不存在" }));
      if (!project.gateAConfirmedAt) {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "GATE_A_REQUIRED", message: "请先确认预算闸门，再生成视频" }));
      }
      const clip = normalizeClip(shot.clip);
      if (clip.status === "generating") {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "CLIP_BUSY", message: "该分镜正在生成视频" }));
      }
      let payload = {};
      try {
        payload = await readJson(request, 10_000);
      } catch {
        return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" }));
      }
      if (["ready", "confirmed"].includes(clip.status) && payload.confirmCost !== true) {
        // 首轮费用已由闸门 A 覆盖；重生成属于额外费用，需要逐镜确认
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "COST_CONFIRMATION_REQUIRED", message: "重新生成视频将产生额外费用，请确认后继续" }));
      }
      if (shot.shotType === "dialogue") {
        const character = project.analysis?.characters?.find((c) => c.id === shot.characterIds[0]);
        if (!character?.avatarId || !character?.voiceId) {
          return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "CHARACTER_BINDING_REQUIRED", message: `请先在角色卡为「${character?.name || "出场角色"}」绑定形象与音色` }));
        }
        if (!String(shot.dialogue || "").trim()) {
          return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "DIALOGUE_REQUIRED", message: "口播镜需要台词" }));
        }
        const seedance = ctx.seedanceStatus();
        if (!seedance.connected) {
          return sendJson(response, 503, envelope(false, null, { requestId, errorCode: seedance.state === "unauthorized" ? "SEEDANCE_UNAUTHORIZED" : "SEEDANCE_UNAVAILABLE", message: "Seedance 2.0 当前不可用" }));
        }
      } else {
        if (shot.frame.status !== "confirmed") {
          return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "FRAME_NOT_CONFIRMED", message: "剧情镜需要先确认首帧" }));
        }
        if (!loadVideoWorkflowTemplate(ctx.videoEnv || process.env)) {
          return sendJson(response, 503, envelope(false, null, { requestId, errorCode: "VIDEO_WORKFLOW_NOT_CONFIGURED", message: "请按接入说明配置剧情镜视频工作流模板（DRAMA_VIDEO_WORKFLOW 或 config/drama-video-workflow.json）" }));
        }
        const comfyui = await getComfyuiStatus(ctx.comfyConfig);
        if (!comfyui.connected) {
          return sendJson(response, 503, envelope(false, null, { requestId, errorCode: "COMFYUI_UNAVAILABLE", message: "未连接本机 ComfyUI 服务" }));
        }
      }
      generateShotClip(ctx, projectId, shot.id).catch(() => {});
      return sendJson(response, 202, envelope(true, { shotId: shot.id, status: "generating" }, { requestId }));
    }

    if (segments.length === 7 && segments[4] === "shots" && segments[6] === "video-confirm" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      const shot = project.shots.find((s) => s.id === segments[5]);
      if (!shot) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_SHOT_NOT_FOUND", message: "分镜不存在" }));
      if (normalizeClip(shot.clip).status !== "ready") {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "CLIP_NOT_READY", message: "视频尚未生成完成" }));
      }
      const updated = store.update(projectId, (p) => {
        const target = p.shots.find((s) => s.id === shot.id);
        target.clip = { ...normalizeClip(target.clip), status: "confirmed" };
        if (p.shots.every((s) => normalizeClip(s.clip).status === "confirmed")) p.status = "clips_ready";
      });
      return sendJson(response, 200, envelope(true, { project: updated }, { requestId }));
    }

    // FFmpeg 可用性探测（生成视图载入时调用）
    if (segments.length === 6 && segments[4] === "compose" && segments[5] === "ffmpeg" && request.method === "GET") {
      const detect = ctx.detectFfmpeg || (() => detectFfmpeg({ env: process.env }));
      return sendJson(response, 200, envelope(true, detect(), { requestId }));
    }

    // 对白镜配音（单镜手动/批量复用）
    if (segments.length === 7 && segments[4] === "shots" && segments[6] === "voice" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      const shot = project.shots.find((s) => s.id === segments[5]);
      if (!shot) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_SHOT_NOT_FOUND", message: "分镜不存在" }));
      if (shot.shotType !== "dialogue" || shot.audioMode !== "voice" || !String(shot.dialogue || "").trim()) {
        return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "VOICE_NOT_APPLICABLE", message: "仅对白镜（配音模式且有台词）可生成配音" }));
      }
      if (normalizeAudio(shot.clip?.audio).status === "generating") {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "VOICE_BUSY", message: "该分镜正在生成配音" }));
      }
      generateShotVoice(ctx, projectId, shot.id).catch(() => {});
      return sendJson(response, 202, envelope(true, { shotId: shot.id, status: "generating" }, { requestId }));
    }

    // 上传背景音乐（base64 data URL，mp3/wav/m4a，≤20MB）
    if (segments.length === 5 && segments[4] === "bgm" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      let payload;
      try { payload = await readJson(request, 30_000_000); } catch (error) {
        return sendJson(response, 400, envelope(false, null, { requestId, errorCode: error.message, message: "音频内容无效或过大" }));
      }
      const match = String(payload.audioData || "").match(/^data:audio\/(mpeg|mp3|wav|m4a|x-m4a);base64,([A-Za-z0-9+/=]+)$/);
      if (!match) return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "AUDIO_FORMAT_INVALID", message: "仅支持 MP3 / WAV / M4A 音频" }));
      const ext = match[1] === "mpeg" ? "mp3" : match[1] === "x-m4a" ? "m4a" : match[1];
      const bytes = Buffer.from(match[2], "base64");
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) return sendJson(response, 413, envelope(false, null, { requestId, errorCode: "AUDIO_TOO_LARGE", message: "音频不能超过 20MB" }));
      mkdirSync(join(store.dir(projectId), "bgm"), { recursive: true });
      writeFileSync(join(store.dir(projectId), "bgm", `bgm.${ext}`), bytes);
      const updated = store.update(projectId, (p) => {
        p.bgm = normalizeBgm({ file: `bgm/bgm.${ext}`, name: String(payload.name || "背景音乐"), volume: payload.volume });
        if (p.compose?.status === "succeeded") p.compose = { ...p.compose, status: "idle", file: null, srtFile: null };
      });
      return sendJson(response, 201, envelope(true, { project: updated }, { requestId }));
    }

    // 触发合成（异步，轮询 project.compose 状态）
    if (segments.length === 5 && segments[4] === "compose" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      const detect = ctx.detectFfmpeg || (() => detectFfmpeg({ env: process.env }));
      if (!detect().available) return sendJson(response, 503, envelope(false, null, { requestId, errorCode: "FFMPEG_UNAVAILABLE", message: "未检测到本机 FFmpeg，请先安装（如 brew install ffmpeg）" }));
      const notReady = project.shots.filter((s) => s.clip?.status !== "confirmed" || !s.clip?.file);
      if (notReady.length) return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "CLIPS_NOT_READY", message: `还有 ${notReady.length} 个分镜视频未确认（${notReady.map((s) => `镜${s.index}`).join("、")}）` }));
      if (!project.shots.length) return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "NO_SHOTS", message: "没有可合成的分镜" }));
      if (project.compose?.status === "running") return sendJson(response, 200, envelope(true, { reused: true }, { requestId }));
      composeFilm(ctx, projectId).catch(() => {});
      return sendJson(response, 202, envelope(true, { projectId, status: "running" }, { requestId }));
    }

    // 版本：存
    if (segments.length === 5 && segments[4] === "versions" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      let payload = {};
      try { payload = await readJson(request, 10_000); } catch { return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" })); }
      const snapshot = saveVersion(store, projectId, payload.name);
      if (!snapshot) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_PROJECT_NOT_FOUND", message: "项目不存在" }));
      return sendJson(response, 201, envelope(true, { snapshot }, { requestId }));
    }

    // 版本：列表
    if (segments.length === 5 && segments[4] === "versions" && request.method === "GET") {
      return sendJson(response, 200, envelope(true, { versions: listVersions(store, projectId) }, { requestId }));
    }

    // 版本：读取
    if (segments.length === 6 && segments[4] === "versions" && request.method === "GET") {
      const snapshot = readVersion(store, projectId, segments[5]);
      if (!snapshot) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "VERSION_NOT_FOUND", message: "版本不存在" }));
      return sendJson(response, 200, envelope(true, { snapshot }, { requestId }));
    }

    // 版本：回滚
    if (segments.length === 7 && segments[4] === "versions" && segments[6] === "rollback" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      const updated = rollbackVersion(store, projectId, segments[5]);
      if (!updated) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "VERSION_NOT_FOUND", message: "版本不存在" }));
      return sendJson(response, 200, envelope(true, { project: updated }, { requestId }));
    }
  }

  return false;
}
