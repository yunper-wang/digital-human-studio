import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { arch, homedir, platform } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { createDramaStore } from "./lib/drama/store.mjs";
import { handleDramaApi } from "./lib/drama/routes.mjs";
import { createSeriesStore } from "./lib/drama/series.mjs";
import { createPromptStore } from "./lib/drama/prompts.mjs";
import { createMaterialStore } from "./lib/drama/materials.mjs";
import { createProviderOverrideStore } from "./lib/drama/provider-overrides.mjs";
import { getDramaLlmConfig, dramaLlmStatus } from "./lib/drama/llm.mjs";
import { getComfyuiConfig, getComfyuiStatus, loadVideoWorkflowTemplate, loadControlnetConfig } from "./lib/drama/comfyui.mjs";
import { getDramaPricing } from "./lib/drama/budget.mjs";
import { detectFfmpeg } from "./lib/drama/ffmpeg.mjs";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(projectRoot, "public");
const dataRoot = process.env.DATA_DIR || join(projectRoot, "data");
const uploadRoot = join(dataRoot, "uploads");
const privateAvatarFile = join(projectRoot, "config", "avatars.json");
const exampleAvatarFile = join(projectRoot, "config", "avatars.example.json");
const customAvatarFile = join(dataRoot, "custom-avatars.json");
const privateLocalVoiceFile = join(projectRoot, "config", "local-voices.json");
const exampleLocalVoiceFile = join(projectRoot, "config", "local-voices.example.json");
const customVoiceFile = join(dataRoot, "custom-voices.json");
const port = Number(process.env.PORT || 4199);
const host = process.env.HOST || "127.0.0.1";
const configuredVoiceboxUrl = String(process.env.VOICEBOX_URL || "").replace(/\/$/, "");
const voiceboxAutoDetectEnabled = process.env.VOICEBOX_DISABLE_AUTO_DETECT !== "1";
const volcengineTtsAppId = process.env.VOLCENGINE_TTS_APP_ID || "";
const volcengineTtsAccessToken = process.env.VOLCENGINE_TTS_ACCESS_TOKEN || "";
const volcengineTtsResourceId = process.env.VOLCENGINE_TTS_RESOURCE_ID || "seed-tts-2.0";
const volcengineTtsVoiceType = process.env.VOLCENGINE_TTS_VOICE_TYPE || "";
const voiceboxOfficialUrl = "https://voicebox.sh/download";
const voiceboxDocsUrl = "https://docs.voicebox.sh/overview/installation";
const rateWindow = new Map();

mkdirSync(uploadRoot, { recursive: true });

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = raw.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    const value = match[2].replace(/^['"]|['"]$/g, "");
    process.env[match[1]] = value;
  }
}

if (process.env.APP_CONFIG_FILE) loadEnv(process.env.APP_CONFIG_FILE);
loadEnv(join(projectRoot, ".env"));

const elevenKey = process.env.ELEVENLABS_API_KEY || process.env.ELEVENLABS_KEY || process.env.XI_API_KEY || "";
const seedancePython = process.env.SEEDANCE_PYTHON || "";
const toolVaultPath = process.env.TOOL_VAULT_PATH || "";
const seedanceRunner = process.env.SEEDANCE_RUNNER || "";
const seedanceModel = process.env.SEEDANCE_MODEL || "provider-model";
// 短剧工作台：必须在 loadEnv 之后读取，否则 .env 中的配置不会生效
const dramaStore = createDramaStore(dataRoot);
const dramaLlmConfig = getDramaLlmConfig();
const comfyuiConfig = getComfyuiConfig();
const dramaPricing = getDramaPricing();

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".srt": "application/x-subrip; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".webm": "video/webm"
};

function envelope(ok, data = null, options = {}) {
  return {
    ok,
    requestId: options.requestId || randomUUID(),
    ...(ok ? { data } : {
      errorCode: options.errorCode || "UNKNOWN",
      message: options.message || "请求失败",
      retryable: Boolean(options.retryable)
    }),
    warnings: options.warnings || [],
    usage: options.usage || null
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

async function readJson(request, maxBytes = 120_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function getSeedanceStatus() {
  if (!existsSync(seedancePython) || !existsSync(toolVaultPath) || !existsSync(seedanceRunner)) {
    return { configured: false, connected: false, state: "runtime_missing", walletBalance: null, maxConcurrent: null };
  }
  if (process.env.SEEDANCE_SKIP_ONLINE_CHECK === "1") {
    return { configured: true, connected: true, state: "test_ready", walletBalance: null, maxConcurrent: 50 };
  }
  try {
    const output = execFileSync(seedancePython, [toolVaultPath, "status", "seedance2", "--online"], {
      encoding: "utf8",
      timeout: 45_000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const provider = JSON.parse(output)?.providers?.[0] || {};
    const connected = provider.ready === true && provider.authenticated === true;
    return {
      configured: provider.configured === true,
      connected,
      state: connected ? "connected" : "unauthorized",
      walletBalance: provider.wallet_balance ?? null,
      maxConcurrent: provider.max_concurrent ?? null
    };
  } catch (error) {
    let provider = {};
    try { provider = JSON.parse(String(error.stdout || ""))?.providers?.[0] || {}; } catch {}
    return {
      configured: provider.configured === true,
      connected: false,
      state: provider.authenticated === false ? "unauthorized" : "check_failed",
      walletBalance: provider.wallet_balance ?? null,
      maxConcurrent: provider.max_concurrent ?? null
    };
  }
}

function loadCustomAvatars() {
  if (!existsSync(customAvatarFile)) return [];
  try {
    const data = JSON.parse(readFileSync(customAvatarFile, "utf8"));
    return Array.isArray(data.avatars) ? data.avatars : [];
  } catch {
    return [];
  }
}

function loadAvatarCatalog() {
  const path = existsSync(privateAvatarFile) ? privateAvatarFile : exampleAvatarFile;
  if (!existsSync(path)) return { source: "empty", avatars: [] };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return { ...data, avatars: Array.isArray(data.avatars) ? data.avatars : [] };
  } catch {
    return { source: "invalid", avatars: [] };
  }
}

function saveCustomAvatars(avatars) {
  writeFileSync(customAvatarFile, JSON.stringify({ updatedAt: new Date().toISOString(), avatars }, null, 2));
}

function loadVoiceFile(path) {
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(data.voices) ? data.voices : [];
  } catch {
    return [];
  }
}

function loadLocalVoices() {
  const path = existsSync(privateLocalVoiceFile) ? privateLocalVoiceFile : exampleLocalVoiceFile;
  return loadVoiceFile(path)
    .filter((voice) => voice.id)
    .map((voice) => ({
      ...voice,
      previewUrl: voice.previewPath && existsSync(voice.previewPath)
        ? `/local-voice-samples/${encodeURIComponent(voice.id)}.${voice.previewFormat || "mp3"}`
        : (voice.previewUrl || null),
      local: true,
      ttsReady: voice.ttsReady !== false
    }));
}

function loadCustomVoices() {
  return loadVoiceFile(customVoiceFile).map((voice) => ({ ...voice, custom: true, ttsReady: true }));
}

function saveCustomVoices(voices) {
  writeFileSync(customVoiceFile, JSON.stringify({ updatedAt: new Date().toISOString(), voices }, null, 2));
}

function sanitizeElevenVoice(voice, overrides = {}) {
  return {
    id: voice.voice_id,
    name: overrides.name || voice.name,
    category: voice.category,
    description: voice.description || voice.labels?.description || "",
    labels: voice.labels || {},
    previewUrl: voice.preview_url || null,
    owned: Boolean(voice.is_owner),
    ttsReady: true,
    ...overrides
  };
}

function mergeVoices(cloudVoices) {
  const merged = new Map();
  for (const voice of [...loadLocalVoices(), ...loadCustomVoices(), ...cloudVoices]) {
    if (!merged.has(voice.id)) merged.set(voice.id, voice);
  }
  return [...merged.values()].sort((a, b) => {
    const rank = (voice) => voice.local ? 0 : voice.custom ? 1 : voice.owned ? 2 : 3;
    return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name), "zh-CN");
  });
}

function validImageBytes(buffer, extension) {
  if (extension === "png") return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === "jpg") return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
  if (extension === "webp") return buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP";
  return false;
}

async function elevenFetch(path, options = {}) {
  if (!elevenKey) throw Object.assign(new Error("未找到 ElevenLabs 凭据"), { code: "ELEVENLABS_KEY_MISSING" });
  const response = await fetch(`https://api.elevenlabs.io${path}`, {
    ...options,
    signal: AbortSignal.timeout(options.timeout || 20_000),
    headers: {
      "xi-api-key": elevenKey,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    let message = `ElevenLabs 返回 ${response.status}`;
    try {
      const payload = await response.json();
      message = payload?.detail?.message || payload?.detail?.status || message;
    } catch {}
    throw Object.assign(new Error(message), { code: `ELEVENLABS_${response.status}`, retryable: response.status >= 500 });
  }
  return response;
}

function voiceboxDownloadUrl() {
  if (platform() === "darwin" && arch() === "arm64") {
    return "https://github.com/jamiepine/voicebox/releases/download/v0.5.0/Voicebox_0.5.0_aarch64.dmg";
  }
  if (platform() === "darwin") {
    return "https://github.com/jamiepine/voicebox/releases/download/v0.5.0/Voicebox_0.5.0_x64.dmg";
  }
  if (platform() === "win32") {
    return "https://github.com/jamiepine/voicebox/releases/download/v0.5.0/Voicebox_0.5.0_x64-setup.exe";
  }
  return voiceboxOfficialUrl;
}

let voiceboxDiscoveryCache = { expiresAt: 0, serviceUrl: "" };
function discoverVoiceboxServiceUrl() {
  if (configuredVoiceboxUrl) return configuredVoiceboxUrl;
  if (!voiceboxAutoDetectEnabled) return "";
  if (voiceboxDiscoveryCache.expiresAt > Date.now()) return voiceboxDiscoveryCache.serviceUrl;
  let serviceUrl = "";
  if (platform() === "darwin" && existsSync("/usr/sbin/lsof")) {
    try {
      const output = execFileSync("/usr/sbin/lsof", ["-nP", "-a", "-c", "voicebox-server", "-iTCP", "-sTCP:LISTEN", "-Fn"], {
        encoding: "utf8",
        timeout: 1800,
        stdio: ["ignore", "pipe", "ignore"]
      });
      const match = output.match(/^n127\.0\.0\.1:(\d+)$/m);
      if (match) serviceUrl = `http://127.0.0.1:${match[1]}`;
    } catch {}
  }
  voiceboxDiscoveryCache = { expiresAt: Date.now() + 5000, serviceUrl };
  return serviceUrl;
}

function detectVoiceboxInstallation() {
  if (!voiceboxAutoDetectEnabled) return { appInstalled: false, modelDownloaded: false, dataDetected: false, serviceUrl: "", autoDetected: false };
  const home = homedir();
  const appCandidates = platform() === "darwin"
    ? ["/Applications/Voicebox.app", join(home, "Applications", "Voicebox.app")]
    : platform() === "win32"
      ? [join(process.env.LOCALAPPDATA || "", "Programs", "Voicebox", "Voicebox.exe")]
      : [];
  const huggingFaceRoot = process.env.HUGGINGFACE_HUB_CACHE
    || join(process.env.HF_HOME || join(home, ".cache", "huggingface"), "hub");
  const modelCandidates = [
    join(huggingFaceRoot, "models--mlx-community--Qwen3-TTS-12Hz-1.7B-Base-bf16"),
    join(huggingFaceRoot, "models--Qwen--Qwen3-TTS-12Hz-1.7B-Base"),
    join(huggingFaceRoot, "models--Qwen--Qwen3-TTS-12Hz-0.6B-Base")
  ];
  const dataCandidates = platform() === "darwin"
    ? [join(home, "Library", "Application Support", "sh.voicebox.app")]
    : platform() === "win32"
      ? [join(process.env.APPDATA || "", "sh.voicebox.app")]
      : [join(home, ".config", "sh.voicebox.app")];
  const serviceUrl = discoverVoiceboxServiceUrl();
  return {
    appInstalled: appCandidates.some((path) => path && existsSync(path)),
    modelDownloaded: modelCandidates.some((path) => existsSync(path)),
    dataDetected: dataCandidates.some((path) => path && existsSync(path)),
    serviceUrl,
    autoDetected: !configuredVoiceboxUrl && Boolean(serviceUrl)
  };
}

async function voiceboxFetch(path, options = {}) {
  const serviceUrl = discoverVoiceboxServiceUrl();
  if (!serviceUrl) throw Object.assign(new Error("未检测到本地 Voicebox 服务"), { code: "VOICEBOX_NOT_CONFIGURED" });
  const response = await fetch(`${serviceUrl}${path}`, {
    ...options,
    signal: AbortSignal.timeout(options.timeout || 15_000),
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    let message = `Voicebox 返回 ${response.status}`;
    try {
      const payload = await response.json();
      message = payload?.detail || payload?.message || message;
    } catch {}
    throw Object.assign(new Error(String(message)), { code: `VOICEBOX_${response.status}`, retryable: response.status >= 500 });
  }
  return response;
}

async function voiceboxHealth() {
  const detected = detectVoiceboxInstallation();
  if (!detected.serviceUrl) {
    return {
      configured: Boolean(configuredVoiceboxUrl),
      connected: false,
      state: detected.modelDownloaded ? "model_ready" : detected.appInstalled ? "app_installed" : "missing",
      appInstalled: detected.appInstalled,
      modelDownloaded: detected.modelDownloaded,
      modelLoaded: false,
      autoDetected: false,
      recommendedModel: "Voicebox + Qwen3-TTS 1.7B",
      downloadUrl: voiceboxDownloadUrl(),
      officialUrl: voiceboxOfficialUrl,
      docsUrl: voiceboxDocsUrl
    };
  }
  try {
    const response = await voiceboxFetch("/health", { timeout: 2500 });
    const health = await response.json();
    return {
      configured: Boolean(configuredVoiceboxUrl),
      connected: true,
      state: "connected",
      appInstalled: detected.appInstalled,
      modelDownloaded: Boolean(health.model_downloaded) || detected.modelDownloaded,
      modelLoaded: Boolean(health.model_loaded),
      autoDetected: detected.autoDetected,
      recommendedModel: "Voicebox + Qwen3-TTS 1.7B",
      downloadUrl: voiceboxDownloadUrl(),
      officialUrl: voiceboxOfficialUrl,
      docsUrl: voiceboxDocsUrl
    };
  } catch (error) {
    return {
      configured: Boolean(configuredVoiceboxUrl),
      connected: false,
      state: error.code || "not_running",
      appInstalled: detected.appInstalled,
      modelDownloaded: detected.modelDownloaded,
      modelLoaded: false,
      autoDetected: detected.autoDetected,
      recommendedModel: "Voicebox + Qwen3-TTS 1.7B",
      downloadUrl: voiceboxDownloadUrl(),
      officialUrl: voiceboxOfficialUrl,
      docsUrl: voiceboxDocsUrl
    };
  }
}

async function providerHealth() {
  const seedance2 = getSeedanceStatus();
  const comfyStatus = await getComfyuiStatus(comfyuiConfig);
  const hasVideoTemplate = Boolean(loadVideoWorkflowTemplate());
  let elevenlabs = { configured: Boolean(elevenKey), connected: false, state: elevenKey ? "checking" : "missing" };
  if (elevenKey) {
    try {
      await elevenFetch("/v1/user", { timeout: 12_000 });
      elevenlabs = { configured: true, connected: true, state: "connected" };
    } catch (error) {
      elevenlabs = { configured: true, connected: false, state: error.code || "invalid" };
    }
  }
  return {
    seedance2,
    elevenlabs,
    volcengineSpeech: {
      configured: Boolean(volcengineTtsAppId && volcengineTtsAccessToken && volcengineTtsVoiceType),
      connected: false,
      state: volcengineTtsAppId && volcengineTtsAccessToken && volcengineTtsVoiceType ? "configured_unverified" : "missing",
      resourceId: volcengineTtsResourceId
    },
    voicebox: await voiceboxHealth(),
    dramaLlm: await dramaLlmStatus(dramaLlmConfig),
    comfyui: comfyStatus,
    dramaVideo: {
      configured: hasVideoTemplate,
      connected: hasVideoTemplate && comfyStatus.connected,
      state: hasVideoTemplate ? comfyStatus.state : "template_missing"
    }
  };
}

function integrationContract(providers) {
  return {
    privacy: {
      localOnly: true,
      message: "请只在自己的电脑上配置凭据。不要把 API Key、Token 或私人节点地址发给别人，也不要提交到 GitHub。"
    },
    integrations: [
      {
        id: "video-generation",
        name: "视频生成接口",
        provider: "Seedance 2.0",
        requirement: "required",
        requirementLabel: "必需",
        configured: Boolean(providers.seedance2?.configured),
        connected: Boolean(providers.seedance2?.connected),
        configKeys: ["SEEDANCE_PYTHON", "TOOL_VAULT_PATH", "SEEDANCE_RUNNER"],
        optionalConfigKeys: ["SEEDANCE_MODEL"],
        description: "用于提交数字人口播视频生成任务；需要你自己的生成权限与本机适配器。"
      },
      {
        id: "cloud-voice",
        name: "云端配音接口",
        provider: "ElevenLabs",
        requirement: "optional",
        requirementLabel: "可选",
        configured: Boolean(providers.elevenlabs?.configured),
        connected: Boolean(providers.elevenlabs?.connected),
        configKeys: ["ELEVENLABS_API_KEY"],
        optionalConfigKeys: [],
        officialUrl: "https://elevenlabs.io/pricing",
        purchaseUrl: "https://elevenlabs.io/pricing",
        description: "用于加载账号音色与生成配音试听；不配置也可以浏览演示音色。"
      },
      {
        id: "volcengine-seed-tts-2",
        name: "火山语音大模型",
        provider: "Doubao-Seed-TTS 2.0",
        requirement: "optional",
        requirementLabel: "可选",
        configured: Boolean(providers.volcengineSpeech?.configured),
        connected: false,
        configKeys: ["VOLCENGINE_TTS_APP_ID", "VOLCENGINE_TTS_ACCESS_TOKEN", "VOLCENGINE_TTS_VOICE_TYPE"],
        optionalConfigKeys: ["VOLCENGINE_TTS_RESOURCE_ID"],
        officialUrl: "https://www.volcengine.com/products/Audio-editing-and-sound-processing",
        purchaseUrl: "https://www.volcengine.com/docs/6561/1167802?lang=zh",
        description: "支持豆包语音合成大模型、Doubao-Seed-TTS 2.0 公版音色与官方 API。"
      },
      {
        id: "volcengine-seed-icl-2",
        name: "火山声音复刻 2.0",
        provider: "Doubao-Seed-ICL 2.0",
        requirement: "optional",
        requirementLabel: "可选",
        configured: Boolean(providers.volcengineSpeech?.configured),
        connected: false,
        configKeys: ["VOLCENGINE_TTS_APP_ID", "VOLCENGINE_TTS_ACCESS_TOKEN", "VOLCENGINE_TTS_VOICE_TYPE"],
        optionalConfigKeys: ["VOLCENGINE_TTS_RESOURCE_ID"],
        officialUrl: "https://www.volcengine.com/product/voicecloning",
        purchaseUrl: "https://www.volcengine.com/docs/6561/1167802?lang=zh",
        description: "支持在火山引擎官方控制台购买音色槽位并接入声音复刻模型 2.0。"
      },
      {
        id: "local-cloned-voice",
        name: "本地克隆音色",
        provider: "Voicebox",
        requirement: "optional",
        requirementLabel: "可选",
        configured: Boolean(providers.voicebox?.configured),
        connected: Boolean(providers.voicebox?.connected),
        configKeys: ["VOICEBOX_URL"],
        optionalConfigKeys: [],
        detection: {
          appInstalled: Boolean(providers.voicebox?.appInstalled),
          modelDownloaded: Boolean(providers.voicebox?.modelDownloaded),
          modelLoaded: Boolean(providers.voicebox?.modelLoaded),
          autoDetected: Boolean(providers.voicebox?.autoDetected)
        },
        recommendedModel: "Voicebox + Qwen3-TTS 1.7B",
        downloadUrl: providers.voicebox?.downloadUrl || voiceboxDownloadUrl(),
        officialUrl: voiceboxOfficialUrl,
        description: "用于连接你自己的本地语音服务，适合私密音色与离线工作流。"
      },
      {
        id: "drama-llm",
        name: "短剧编排模型",
        provider: "OpenAI 兼容端点",
        requirement: "optional",
        requirementLabel: "可选",
        configured: Boolean(providers.dramaLlm?.configured),
        connected: Boolean(providers.dramaLlm?.connected),
        configKeys: ["DRAMA_LLM_BASE_URL", "DRAMA_LLM_MODEL", "DRAMA_LLM_API_KEY"],
        optionalConfigKeys: ["DRAMA_LLM_MOCK", "DRAMA_LLM_TIMEOUT_MS"],
        description: "驱动剧本分析、导演分镜、提示词与审核四个阶段；不配置时使用本机演示编排，不产生费用。"
      },
      {
        id: "comfyui-local",
        name: "短剧首帧生成",
        provider: "ComfyUI (Flux)",
        requirement: "optional",
        requirementLabel: "可选",
        configured: Boolean(providers.comfyui?.configured),
        connected: Boolean(providers.comfyui?.connected),
        configKeys: ["COMFYUI_URL"],
        optionalConfigKeys: ["COMFYUI_FLUX_UNET", "COMFYUI_CLIP1", "COMFYUI_CLIP2", "COMFYUI_VAE", "COMFYUI_FLUX_STEPS"],
        description: "连接你本机的 ComfyUI 服务，用 Flux 为每个分镜生成首帧；本机算力不产生 API 费用。"
      },
      {
        id: "drama-video-workflow",
        name: "剧情镜视频工作流",
        provider: "ComfyUI 模板（MiniMax H3 等图生视频）",
        requirement: "optional",
        requirementLabel: "可选",
        configured: Boolean(providers.dramaVideo?.configured),
        connected: Boolean(providers.dramaVideo?.connected),
        configKeys: ["DRAMA_VIDEO_WORKFLOW"],
        optionalConfigKeys: ["COMFYUI_VIDEO_TIMEOUT_MS"],
        description: "把你调好的图生视频工作流导出为 API 格式 JSON；程序注入已确认首帧与运动提示词后提交本机 ComfyUI。"
      }
    ],
    appApi: [
      { method: "GET", path: "/api/health", purpose: "服务与供应商状态" },
      { method: "GET", path: "/api/integrations", purpose: "接入要求与脱敏状态" },
      { method: "GET", path: "/api/avatars", purpose: "数字人目录" },
      { method: "GET", path: "/api/voices", purpose: "音色目录" },
      { method: "POST", path: "/api/drama/projects", purpose: "创建短剧项目" },
      { method: "GET", path: "/api/drama/projects/{id}", purpose: "查询短剧项目与流水线状态" },
      { method: "POST", path: "/api/drama/projects/{id}/pipeline", purpose: "发起或续跑编排流水线" },
      { method: "POST", path: "/api/drama/projects/{id}/gate-a", purpose: "确认短剧预算闸门" },
      { method: "POST", path: "/api/drama/projects/{id}/shots/{shotId}/frame", purpose: "生成或换抽分镜首帧" },
      { method: "POST", path: "/api/drama/projects/{id}/shots/{shotId}/confirm", purpose: "确认分镜首帧" },
      { method: "PATCH", path: "/api/drama/projects/{id}/characters/{charId}", purpose: "绑定角色形象与音色" },
      { method: "POST", path: "/api/drama/projects/{id}/shots/{shotId}/video", purpose: "生成或重生成分镜视频" },
      { method: "POST", path: "/api/drama/projects/{id}/shots/{shotId}/video-confirm", purpose: "确认分镜视频" }
    ]
  };
}

function avatarById(id) {
  const presets = loadAvatarCatalog().avatars;
  return [...loadCustomAvatars(), ...presets].find((avatar) => avatar.id === id) || null;
}

function trustedUploadPath(value) {
  if (!String(value || "").startsWith("/uploads/")) return "";
  const fileName = String(value).slice("/uploads/".length);
  if (!/^[a-f0-9-]+\.(jpg|png|webp)$/i.test(fileName)) return "";
  const path = join(uploadRoot, fileName);
  return existsSync(path) ? path : "";
}

const seedanceAccessors = {
  findAvatar: avatarById,
  trustedUploadPath,
  findVoice: (id) => [...loadLocalVoices(), ...loadCustomVoices()].find((item) => item.id === id)
};
const seedanceConfig = {
  python: seedancePython,
  toolVault: toolVaultPath,
  runner: seedanceRunner,
  model: seedanceModel,
  projectRoot,
  accessors: seedanceAccessors
};

function allowRequest(ip) {
  const now = Date.now();
  const limit = Number(process.env.DRAMA_RATE_LIMIT) || 12;
  const current = (rateWindow.get(ip) || []).filter((stamp) => now - stamp < 60_000);
  if (current.length >= limit) return false;
  current.push(now);
  rateWindow.set(ip, current);
  return true;
}

async function handleApi(request, response, url) {
  const requestId = randomUUID();
  if (request.method === "GET" && url.pathname === "/api/health") {
    const providers = await providerHealth();
    return sendJson(response, 200, envelope(true, {
      service: "digital-human-studio",
      version: "0.4.3",
      providers,
      costGuard: { enabled: true, realGenerationRequiresConfirmation: true }
    }, { requestId }));
  }

  if (request.method === "GET" && url.pathname === "/api/integrations") {
    const providers = await providerHealth();
    return sendJson(response, 200, envelope(true, integrationContract(providers), { requestId }));
  }

  if (request.method === "GET" && url.pathname === "/api/avatars") {
    const data = loadAvatarCatalog();
    return sendJson(response, 200, envelope(true, { ...data, avatars: [...loadCustomAvatars(), ...(data.avatars || [])] }, { requestId }));
  }

  if (request.method === "POST" && url.pathname === "/api/avatars/custom") {
    let payload;
    try {
      payload = await readJson(request, 12_000_000);
    } catch (error) {
      return sendJson(response, 400, envelope(false, null, { requestId, errorCode: error.message, message: "图片内容无效或超过大小限制" }));
    }
    const name = String(payload.name || "我的数字人").trim().slice(0, 40) || "我的数字人";
    const remoteUrl = String(payload.remoteUrl || "").trim();
    if (remoteUrl && !/^https:\/\//i.test(remoteUrl)) {
      return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "HTTPS_URL_REQUIRED", message: "公网图片必须使用 HTTPS 地址" }));
    }
    let image = remoteUrl;
    let source = remoteUrl ? "remote" : "local";
    if (payload.imageData) {
      const match = String(payload.imageData).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (!match) return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "IMAGE_FORMAT_INVALID", message: "仅支持 JPG、PNG 或 WebP 图片" }));
      const extension = match[1] === "jpeg" ? "jpg" : match[1];
      const bytes = Buffer.from(match[2], "base64");
      if (!bytes.length || bytes.length > 8 * 1024 * 1024) return sendJson(response, 413, envelope(false, null, { requestId, errorCode: "IMAGE_TOO_LARGE", message: "图片不能超过 8MB" }));
      if (!validImageBytes(bytes, extension)) return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "IMAGE_BYTES_INVALID", message: "图片文件内容与格式不一致" }));
      const fileName = `${randomUUID()}.${extension}`;
      writeFileSync(join(uploadRoot, fileName), bytes);
      image = `/uploads/${fileName}`;
    }
    if (!image) return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "IMAGE_REQUIRED", message: "请选择图片或输入 HTTPS 图片地址" }));
    const avatar = {
      id: `custom-${randomUUID()}`,
      name,
      image,
      remoteUrl: remoteUrl || null,
      source,
      readyForSeedance: true,
      createdAt: new Date().toISOString()
    };
    const avatars = [avatar, ...loadCustomAvatars()].slice(0, 30);
    saveCustomAvatars(avatars);
    return sendJson(response, 201, envelope(true, { avatar }, {
      requestId,
      warnings: ["人物图片已加入；生成时由服务端安全上传给 Seedance 2.0"]
    }));
  }

  if (request.method === "GET" && url.pathname === "/api/voices") {
    if (!elevenKey) {
      const voices = mergeVoices([]);
      return sendJson(response, 200, envelope(true, { voices, total: voices.length }, {
        requestId,
        warnings: ["当前显示脱敏演示音色；配置你自己的服务后会加载真实音色。"]
      }));
    }
    try {
      const upstream = await elevenFetch("/v2/voices?page_size=40&sort=name&sort_direction=asc&include_total_count=true");
      const data = await upstream.json();
      const voices = mergeVoices((data.voices || []).map((voice) => sanitizeElevenVoice(voice)));
      return sendJson(response, 200, envelope(true, { voices, total: voices.length }, { requestId }));
    } catch (error) {
      return sendJson(response, 502, envelope(false, null, {
        requestId,
        errorCode: error.code || "VOICE_LIST_FAILED",
        message: error.message,
        retryable: Boolean(error.retryable)
      }));
    }
  }

  if (request.method === "POST" && url.pathname === "/api/voices/custom") {
    let payload;
    try {
      payload = await readJson(request, 8_000);
    } catch (error) {
      return sendJson(response, 400, envelope(false, null, { requestId, errorCode: error.message, message: "音色内容无效" }));
    }
    const voiceId = String(payload.voiceId || "").trim();
    const customName = String(payload.name || "").trim().slice(0, 50);
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(voiceId)) {
      return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "VOICE_ID_INVALID", message: "请输入有效的 ElevenLabs Voice ID" }));
    }
    try {
      const upstream = await elevenFetch(`/v1/voices/${encodeURIComponent(voiceId)}`);
      const source = await upstream.json();
      const voice = sanitizeElevenVoice(source, { name: customName || source.name, custom: true, owned: true });
      const saved = [voice, ...loadCustomVoices().filter((item) => item.id !== voice.id)].slice(0, 30);
      saveCustomVoices(saved);
      return sendJson(response, 201, envelope(true, { voice }, { requestId }));
    } catch (error) {
      const missing = error.code === "ELEVENLABS_404";
      return sendJson(response, missing ? 422 : 502, envelope(false, null, {
        requestId,
        errorCode: missing ? "VOICE_NOT_FOUND" : (error.code || "VOICE_LOOKUP_FAILED"),
        message: missing ? "这个 Voice ID 不在当前 ElevenLabs 账号中，请确认已保存到 Voice Library" : error.message,
        retryable: Boolean(error.retryable)
      }));
    }
  }

  if (url.pathname.startsWith("/api/drama/")) {
    return handleDramaApi(request, response, url, {
      sendJson,
      envelope,
      readJson,
      allowRequest,
      store: dramaStore,
      seriesStore: createSeriesStore(dataRoot),
      promptStore: createPromptStore(dataRoot),
      materialStore: createMaterialStore(dataRoot),
      providerOverrideStore: createProviderOverrideStore(dataRoot),
      llmDeps: { config: dramaLlmConfig },
      comfyConfig: comfyuiConfig,
      controlnetConfig: loadControlnetConfig(),
      pricing: dramaPricing,
      seedanceConfig,
      seedanceStatus: getSeedanceStatus,
      findAvatar: avatarById,
      findVoice: seedanceAccessors.findVoice,
      detectFfmpeg: () => detectFfmpeg({ env: process.env }),
      ffmpegPath: detectFfmpeg({ env: process.env }).path || "ffmpeg",
      audioDeps: { voiceboxUrl: discoverVoiceboxServiceUrl(), elevenKey, fetchImpl: fetch }
    });
  }

  return false;
}

function serveStatic(response, pathname) {
  const localVoiceSampleMatch = pathname.match(/^\/local-voice-samples\/(.+)\.(mp3|wav)$/);
  if (localVoiceSampleMatch) {
    const id = decodeURIComponent(localVoiceSampleMatch[1]);
    const voice = loadLocalVoices().find((item) => item.id === id);
    if (!voice) return false;
    response.writeHead(200, { "Cache-Control": "private, max-age=3600", "Content-Type": contentTypes[extname(voice.previewPath)] || "application/octet-stream" });
    createReadStream(voice.previewPath).pipe(response);
    return true;
  }
  if (pathname.startsWith("/materials/")) {
    const fileName = pathname.slice("/materials/".length);
    if (!/^mat-[a-f0-9-]+\.(png|jpg|webp|mp3|wav|m4a|mp4|webm)$/i.test(fileName)) return false;
    const materialPath = join(dataRoot, "materials", fileName);
    if (!existsSync(materialPath)) return false;
    response.writeHead(200, {
      "Cache-Control": "private, max-age=86400",
      "Content-Type": contentTypes[extname(materialPath)] || "application/octet-stream"
    });
    createReadStream(materialPath).pipe(response);
    return true;
  }
  if (pathname.startsWith("/uploads/")) {
    const fileName = pathname.slice("/uploads/".length);
    if (!/^[a-f0-9-]+\.(jpg|png|webp)$/i.test(fileName)) return false;
    const uploadPath = join(uploadRoot, fileName);
    if (!existsSync(uploadPath)) return false;
    response.writeHead(200, {
      "Cache-Control": "private, max-age=86400",
      "Content-Type": contentTypes[extname(uploadPath)] || "application/octet-stream"
    });
    createReadStream(uploadPath).pipe(response);
    return true;
  }
  const dramaFileMatch = pathname.match(/^\/drama-files\/(drama-[a-f0-9-]+)\/(?:(frames|clips|audio|compose|bgm)\/)?([a-z0-9-]+\.(png|jpg|webp|mp4|webm|mp3|wav|m4a|srt))$/i);
  if (dramaFileMatch) {
    const [, id, sub, file] = dramaFileMatch;
    // 兼容旧两段式（无子目录）：按扩展名推断 frames/clips；M5 三段式用显式子目录（audio/compose/bgm）
    const subdir = sub || (/\.(mp4|webm)$/i.test(file) ? "clips" : "frames");
    const filePath = join(dramaStore.dir(id), subdir, file);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
    response.writeHead(200, {
      "Cache-Control": "private, max-age=3600",
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream"
    });
    createReadStream(filePath).pipe(response);
    return true;
  }
  const requestedPath = pathname === "/" ? "/drama.html" : decodeURIComponent(pathname);
  const safePath = normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(publicRoot, safePath);
  if (!filePath.startsWith(publicRoot) || !existsSync(filePath) || !statSync(filePath).isFile()) return false;
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream"
  });
  createReadStream(filePath).pipe(response);
  return true;
}

export const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(request, response, url);
      if (handled !== false) return;
    }
    if (serveStatic(response, url.pathname)) return;
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    sendJson(response, 500, envelope(false, null, { errorCode: "INTERNAL_ERROR", message: error.message, retryable: true }));
  }
});

export function startServer() {
  if (server.listening) {
    const address = server.address();
    return Promise.resolve({ server, url: `http://${host}:${address.port}` });
  }
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const url = `http://${host}:${address.port}`;
      console.log(`短剧工作台：${url}`);
      resolve({ server, url });
    });
  });
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryPath) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
