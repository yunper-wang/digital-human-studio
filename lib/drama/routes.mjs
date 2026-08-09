// lib/drama/routes.mjs
import { randomUUID } from "node:crypto";
import { DRAMA_STAGES, SHOT_CAMERAS, DRAMA_RATIOS, createDramaProject, normalizeShot, DEMO_DRAMA_SCRIPT } from "./schema.mjs";
import { runDramaPipeline, isPipelineRunning } from "./pipeline.mjs";
import { estimateBudget } from "./budget.mjs";

const PROJECT_ID_PATTERN = /^drama-[a-f0-9-]+$/;
const EDITABLE_STATUSES = ["awaiting_gate_a", "review_blocked", "frames", "awaiting_gate_b"];
const PIPELINE_STARTABLE = ["draft", "failed", "review_blocked", "awaiting_gate_a"];

function parts(url) {
  return url.pathname.split("/").filter(Boolean);
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
      const updated = store.update(projectId, (p) => {
        if (typeof payload.title === "string") p.title = payload.title.trim().slice(0, 80) || p.title;
        if (typeof payload.ratio === "string" && DRAMA_RATIOS.includes(payload.ratio)) p.ratio = payload.ratio;
        if (typeof payload.script === "string") {
          const script = payload.script.trim();
          if (script.length < 50 || script.length > 20_000) {
            throw Object.assign(new Error("剧本需为 50–20000 个字符"), { code: "DRAMA_SCRIPT_INVALID" });
          }
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
  }

  return false;
}
