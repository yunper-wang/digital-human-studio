// lib/drama/comfyui.mjs
// 本机 ComfyUI HTTP 适配器：Flux txt2img 首帧生成（提交 → 轮询 history → 下载图片）
export function getComfyuiConfig(env = process.env) {
  return {
    baseUrl: String(env.COMFYUI_URL || "").replace(/\/+$/, ""),
    unet: env.COMFYUI_FLUX_UNET || "flux1-schnell-fp8.safetensors",
    clip1: env.COMFYUI_CLIP1 || "clip_l.safetensors",
    clip2: env.COMFYUI_CLIP2 || "t5xxl_fp8_e4m3fn.safetensors",
    vae: env.COMFYUI_VAE || "ae.safetensors",
    steps: Number(env.COMFYUI_FLUX_STEPS) || 4,
    timeoutMs: Number(env.COMFYUI_TIMEOUT_MS) || 300_000,
    pollIntervalMs: Number(env.COMFYUI_POLL_INTERVAL_MS) || 1500
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
