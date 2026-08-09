// lib/drama/comfyui.mjs
// 本机 ComfyUI HTTP 适配器：Flux txt2img 首帧生成 + 图生视频工作流模板适配
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
export function getComfyuiConfig(env = process.env) {
  return {
    baseUrl: String(env.COMFYUI_URL || "").replace(/\/+$/, ""),
    unet: env.COMFYUI_FLUX_UNET || "flux1-schnell-fp8.safetensors",
    clip1: env.COMFYUI_CLIP1 || "clip_l.safetensors",
    clip2: env.COMFYUI_CLIP2 || "t5xxl_fp8_e4m3fn.safetensors",
    vae: env.COMFYUI_VAE || "ae.safetensors",
    steps: Number(env.COMFYUI_FLUX_STEPS) || 4,
    timeoutMs: Number(env.COMFYUI_TIMEOUT_MS) || 300_000,
    pollIntervalMs: Number(env.COMFYUI_POLL_INTERVAL_MS) || 1500,
    videoTimeoutMs: Number(env.COMFYUI_VIDEO_TIMEOUT_MS) || 1_200_000
  };
}

export const FRAME_SIZES = {
  portrait: [768, 1344],
  landscape: [1344, 768],
  square: [1024, 1024]
};

export function buildFluxWorkflow({ prompt, negativePrompt = "", width, height, seed, config }) {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed, steps: config.steps, cfg: 1.0,
        sampler_name: "euler", scheduler: "simple", denoise: 1.0,
        model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0]
      }
    },
    "4": { class_type: "UNETLoader", inputs: { unet_name: config.unet, weight_dtype: "fp8_e4m3fn" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["11", 0] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: negativePrompt, clip: ["11", 0] } },
    "10": { class_type: "VAELoader", inputs: { vae_name: config.vae } },
    "11": { class_type: "DualCLIPLoader", inputs: { clip_name1: config.clip1, clip_name2: config.clip2, type: "flux" } },
    "12": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["10", 0] } },
    "13": { class_type: "SaveImage", inputs: { filename_prefix: "drama", images: ["12", 0] } }
  };
}

export async function getComfyuiStatus(config = getComfyuiConfig(), fetchImpl = fetch) {
  if (!config.baseUrl) return { configured: false, connected: false, state: "missing" };
  try {
    const response = await fetchImpl(`${config.baseUrl}/system_stats`, { signal: AbortSignal.timeout(3000) });
    return { configured: true, connected: response.ok, state: response.ok ? "connected" : `http_${response.status}` };
  } catch {
    return { configured: true, connected: false, state: "unreachable" };
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function generateFluxFrame({ config, prompt, negativePrompt = "", width, height, seed, fetchImpl = fetch, sleep = defaultSleep, clientId = "drama-studio" }) {
  if (!config?.baseUrl) {
    throw Object.assign(new Error("未配置本机 ComfyUI 地址（COMFYUI_URL）"), { code: "COMFYUI_UNAVAILABLE" });
  }
  const workflow = buildFluxWorkflow({ prompt, negativePrompt, width, height, seed, config });
  let submit;
  try {
    submit = await fetchImpl(`${config.baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ prompt: workflow, client_id: clientId })
    });
  } catch (error) {
    // 网络层失败同样归类为提交失败，避免未编码错误逃逸到上层
    throw Object.assign(new Error(`ComfyUI 提交失败 (${error.message})`), { code: "COMFYUI_SUBMIT_FAILED" });
  }
  if (!submit.ok) {
    throw Object.assign(new Error(`ComfyUI 提交失败 (${submit.status})`), { code: "COMFYUI_SUBMIT_FAILED" });
  }
  const submitted = await submit.json();
  const promptId = submitted?.prompt_id;
  if (!promptId) {
    throw Object.assign(new Error("ComfyUI 未返回 prompt_id"), { code: "COMFYUI_SUBMIT_FAILED" });
  }

  const deadline = Date.now() + config.timeoutMs;
  let images = null;
  while (Date.now() < deadline) {
    await sleep(config.pollIntervalMs);
    let history;
    try {
      const response = await fetchImpl(`${config.baseUrl}/history/${promptId}`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) continue;
      history = await response.json();
    } catch {
      continue; // 轮询抖动不致命，继续等
    }
    const entry = history?.[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      throw Object.assign(new Error("ComfyUI 执行工作流失败"), { code: "COMFYUI_EXECUTION_FAILED" });
    }
    images = entry.outputs?.["13"]?.images;
    if (images?.length) break;
  }
  if (!images?.length) {
    throw Object.assign(new Error("等待 ComfyUI 首帧超时"), { code: "COMFYUI_TIMEOUT", retryable: true });
  }

  const image = images[0];
  const viewUrl = `${config.baseUrl}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder || "")}&type=${encodeURIComponent(image.type || "output")}`;
  const file = await fetchImpl(viewUrl, { signal: AbortSignal.timeout(60_000) });
  if (!file.ok) {
    throw Object.assign(new Error(`ComfyUI 取图失败 (${file.status})`), { code: "COMFYUI_OUTPUT_MISSING" });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!bytes.length) {
    throw Object.assign(new Error("ComfyUI 返回空图片"), { code: "COMFYUI_OUTPUT_MISSING" });
  }
  return bytes;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

// 剧情镜视频工作流模板：用户从 ComfyUI 导出 API 格式 JSON，程序只做占位符注入
export function getVideoWorkflowPath(env = process.env) {
  return String(env.DRAMA_VIDEO_WORKFLOW || "").trim()
    || join(moduleDir, "..", "..", "config", "drama-video-workflow.json");
}

export function loadVideoWorkflowTemplate(env = process.env) {
  const path = getVideoWorkflowPath(env);
  if (!existsSync(path)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const workflow = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("_")) continue; // 文档键不提交
    workflow[key] = value;
  }
  return Object.keys(workflow).length ? workflow : null;
}

const VIDEO_TOKEN_TYPES = { SEED: "number", FRAMES: "number", WIDTH: "number", HEIGHT: "number", FPS: "number", PROMPT: "string", IMAGE: "string" };

export function buildVideoWorkflow(template, values) {
  const substitute = (text) => {
    let out = text;
    for (const [token, type] of Object.entries(VIDEO_TOKEN_TYPES)) {
      const marker = `{{${token}}}`;
      if (!out.includes(marker)) continue;
      const value = values[token];
      if (out === marker && type === "number") return Number(value) || 0; // 整值替换保持 number 类型
      out = out.split(marker).join(String(value ?? ""));
    }
    return out;
  };
  const walk = (node) => {
    if (typeof node === "string") return substitute(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value)]));
    }
    return node;
  };
  return walk(JSON.parse(JSON.stringify(template))); // 深拷贝，模板复用不被污染
}

export async function uploadComfyuiImage({ config, bytes, filename, fetchImpl = fetch }) {
  if (!config?.baseUrl) throw Object.assign(new Error("未配置本机 ComfyUI 地址（COMFYUI_URL）"), { code: "COMFYUI_UNAVAILABLE" });
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/png" }), filename);
  form.append("overwrite", "true");
  const response = await fetchImpl(`${config.baseUrl}/upload/image`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw Object.assign(new Error(`ComfyUI 图片上传失败 (${response.status})`), { code: "COMFYUI_UPLOAD_FAILED" });
  const payload = await response.json();
  if (!payload?.name) throw Object.assign(new Error("ComfyUI 未返回上传文件名"), { code: "COMFYUI_UPLOAD_FAILED" });
  return payload.name;
}

const VIDEO_FILE_PATTERN = /\.(mp4|webm)$/i;

export async function generateComfyuiVideo({ config, template, values, fetchImpl = fetch, sleep = defaultSleep, clientId = "drama-studio" }) {
  if (!config?.baseUrl) throw Object.assign(new Error("未配置本机 ComfyUI 地址（COMFYUI_URL）"), { code: "COMFYUI_UNAVAILABLE" });
  const workflow = buildVideoWorkflow(template, values);
  const submit = await fetchImpl(`${config.baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ prompt: workflow, client_id: clientId })
  });
  if (!submit.ok) throw Object.assign(new Error(`ComfyUI 提交失败 (${submit.status})`), { code: "COMFYUI_SUBMIT_FAILED" });
  const submitted = await submit.json();
  const promptId = submitted?.prompt_id;
  if (!promptId) throw Object.assign(new Error("ComfyUI 未返回 prompt_id"), { code: "COMFYUI_SUBMIT_FAILED" });

  const deadline = Date.now() + (config.videoTimeoutMs || 1_200_000);
  let videoFile = null;
  while (Date.now() < deadline && !videoFile) {
    await sleep(config.pollIntervalMs);
    let history;
    try {
      const response = await fetchImpl(`${config.baseUrl}/history/${promptId}`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) continue;
      history = await response.json();
    } catch {
      continue;
    }
    const entry = history?.[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      throw Object.assign(new Error("ComfyUI 执行视频工作流失败"), { code: "COMFYUI_EXECUTION_FAILED" });
    }
    // 视频输出形态随保存节点不同：gifs（VHS 等）、videos（原生 SaveVideo）、images 里也可能是 mp4
    for (const output of Object.values(entry.outputs || {})) {
      const candidates = [...(output.gifs || []), ...(output.videos || []), ...(output.images || [])];
      const hit = candidates.find((item) => VIDEO_FILE_PATTERN.test(item?.filename || ""));
      if (hit) { videoFile = hit; break; }
    }
    if (entry.outputs && !videoFile && entry.status?.completed) break; // 已完成但无视频 → 落空
  }
  if (!videoFile) {
    throw Object.assign(new Error("ComfyUI 视频输出缺失或等待超时"), { code: "COMFYUI_OUTPUT_MISSING", retryable: true });
  }
  const viewUrl = `${config.baseUrl}/view?filename=${encodeURIComponent(videoFile.filename)}&subfolder=${encodeURIComponent(videoFile.subfolder || "")}&type=${encodeURIComponent(videoFile.type || "output")}`;
  const file = await fetchImpl(viewUrl, { signal: AbortSignal.timeout(120_000) });
  if (!file.ok) throw Object.assign(new Error(`ComfyUI 取视频失败 (${file.status})`), { code: "COMFYUI_OUTPUT_MISSING" });
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!bytes.length) throw Object.assign(new Error("ComfyUI 返回空视频"), { code: "COMFYUI_OUTPUT_MISSING" });
  return bytes;
}
