import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { arch, homedir, platform } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { createDramaStore } from "./lib/drama/store.mjs";
import { handleDramaApi } from "./lib/drama/routes.mjs";
import { getDramaLlmConfig, dramaLlmStatus } from "./lib/drama/llm.mjs";
import { getComfyuiConfig, getComfyuiStatus } from "./lib/drama/comfyui.mjs";
import { getDramaPricing } from "./lib/drama/budget.mjs";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(projectRoot, "public");
const dataRoot = process.env.DATA_DIR || join(projectRoot, "data");
const outputRoot = join(dataRoot, "outputs");
const uploadRoot = join(dataRoot, "uploads");
const seedanceRunRoot = join(dataRoot, "seedance-runs");
const tasksFile = join(dataRoot, "tasks.json");
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
const tasks = new Map();
const idempotency = new Map();
const rateWindow = new Map();

mkdirSync(outputRoot, { recursive: true });
mkdirSync(uploadRoot, { recursive: true });
mkdirSync(seedanceRunRoot, { recursive: true });

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
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
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

async function ensureVoicebox() {
  const health = await voiceboxHealth();
  if (health.connected) return health;
  throw Object.assign(new Error("本地语音服务未启动"), { code: "VOICEBOX_UNAVAILABLE", retryable: true });
}

async function providerHealth() {
  const seedance2 = getSeedanceStatus();
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
    comfyui: await getComfyuiStatus(comfyuiConfig)
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
      }
    ],
    appApi: [
      { method: "GET", path: "/api/health", purpose: "服务与供应商状态" },
      { method: "GET", path: "/api/integrations", purpose: "接入要求与脱敏状态" },
      { method: "GET", path: "/api/avatars", purpose: "数字人目录" },
      { method: "GET", path: "/api/voices", purpose: "音色目录" },
      { method: "POST", path: "/api/tasks", purpose: "创建生成或检查任务" },
      { method: "GET", path: "/api/tasks/{id}", purpose: "查询长任务状态" },
      { method: "POST", path: "/api/drama/projects", purpose: "创建短剧项目" },
      { method: "GET", path: "/api/drama/projects/{id}", purpose: "查询短剧项目与流水线状态" },
      { method: "POST", path: "/api/drama/projects/{id}/pipeline", purpose: "发起或续跑编排流水线" },
      { method: "POST", path: "/api/drama/projects/{id}/gate-a", purpose: "确认短剧预算闸门" },
      { method: "POST", path: "/api/drama/projects/{id}/shots/{shotId}/frame", purpose: "生成或换抽分镜首帧" }
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

async function downloadReference(url, runDir, stem, kind) {
  if (!/^https:\/\//i.test(String(url || ""))) throw new Error(`${kind === "image" ? "人物图片" : "音色样本"}不是可访问的 HTTPS 地址`);
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${kind === "image" ? "人物图片" : "音色样本"}下载失败 (${response.status})`);
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const allowed = kind === "image"
    ? [["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"]]
    : [["audio/mpeg", "mp3"], ["audio/wav", "wav"], ["audio/x-wav", "wav"], ["audio/mp4", "m4a"], ["audio/aac", "aac"]];
  const match = allowed.find(([mime]) => contentType.startsWith(mime));
  if (!match) throw new Error(`${kind === "image" ? "人物图片" : "音色样本"}格式不受支持`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const maxBytes = kind === "image" ? 12 * 1024 * 1024 : 25 * 1024 * 1024;
  if (!bytes.length || bytes.length > maxBytes) throw new Error(`${kind === "image" ? "人物图片" : "音色样本"}为空或超过大小限制`);
  const path = join(runDir, `${stem}.${match[1]}`);
  writeFileSync(path, bytes);
  return path;
}

async function resolveSeedanceAvatar(payload, runDir) {
  const avatar = avatarById(payload.avatarId);
  if (!avatar) throw Object.assign(new Error("找不到所选人物图片"), { code: "AVATAR_NOT_FOUND" });
  if (avatar.source === "demo") {
    throw Object.assign(new Error("演示形象仅用于界面预览，请添加你自己的人物图片"), { code: "DEMO_AVATAR_NOT_GENERATABLE" });
  }
  const localPath = trustedUploadPath(avatar.image);
  if (localPath) return { avatar, path: localPath };
  const remoteUrl = avatar.remoteUrl || avatar.image;
  return { avatar, path: await downloadReference(remoteUrl, runDir, "character_reference", "image") };
}

async function resolveSeedanceVoice(payload, runDir) {
  const voice = [...loadLocalVoices(), ...loadCustomVoices()].find((item) => item.id === payload.voiceId) || null;
  if (voice?.previewPath && existsSync(voice.previewPath)) return { voice, path: voice.previewPath };
  const previewUrl = voice?.previewUrl || String(payload.voicePreviewUrl || "");
  if (!previewUrl) throw Object.assign(new Error("所选音色没有可用的参考音频"), { code: "VOICE_REFERENCE_MISSING" });
  return { voice: voice || { id: payload.voiceId, name: payload.voiceName || "所选音色" }, path: await downloadReference(previewUrl, runDir, "voice_reference", "audio") };
}

function buildSeedancePrompt(payload, avatar, voice) {
  const language = payload.language === "en" ? "英语" : payload.language === "es" ? "西班牙语" : "普通话中文";
  return [
    "生成一条真实自然的单人口播视频。",
    `人物身份锁定：参考图片中的人物是唯一出镜者，严格保持其面部、发型、肤色、服装和年龄感一致，不换人，不美化成另一张脸。人物名称：${avatar.name}。`,
    `声音锁定：严格参考音频中“${voice.name}”的音色、音高、口音、语速、节奏、情绪温度与停顿方式；只复刻声音特征，不复述参考音频原文。`,
    `口播语言：${language}。人物正面看镜头，准确自然地说出以下台词，嘴型与发音同步：`,
    `“${String(payload.script || "").trim()}”`,
    "镜头以稳定中近景为主，保持直视镜头，自然眨眼和轻微头部、肩部动作，表情与语义一致。",
    payload.settings?.motion === false ? "动作幅度克制，身体基本保持稳定。" : "动作自然克制，不夸张，不突然大幅移动。",
    "背景稳定，无其他人物，无画面文字、乱码、水印或额外旁白。"
  ].join("\n");
}

async function generateSeedanceVideo(taskId, payload) {
  const runDir = join(seedanceRunRoot, taskId);
  mkdirSync(runDir, { recursive: true });
  let child;
  let providerTaskId = "";
  let stderrBuffer = "";
  let lineBuffer = "";
  let pollCount = 0;
  let finished = false;
  let timeout;
  const finish = (patch) => {
    if (finished) return;
    finished = true;
    if (timeout) clearTimeout(timeout);
    setTask(taskId, patch);
  };

  try {
    setTask(taskId, { status: "running", progress: 5, startedAt: new Date().toISOString(), provider: "seedance2" });
    const [{ avatar, path: avatarPath }, { voice, path: voicePath }] = await Promise.all([
      resolveSeedanceAvatar(payload, runDir),
      resolveSeedanceVoice(payload, runDir)
    ]);
    const generationPrompt = String(payload.generationPrompt || "").trim() || buildSeedancePrompt(payload, avatar, voice);
    if (generationPrompt.length < 20 || generationPrompt.length > 10_000) {
      throw Object.assign(new Error("Seedance 生成提示词需为 20–10000 个字符"), { code: "GENERATION_PROMPT_INVALID" });
    }
    const promptPath = join(runDir, "prompt.txt");
    writeFileSync(promptPath, `${generationPrompt}\n`, "utf8");
    setTask(taskId, { progress: 16 });

    const ratio = payload.ratio === "landscape" ? "16:9" : payload.ratio === "square" ? "1:1" : "9:16";
    const resolution = ["480p", "720p"].includes(payload.resolution) ? payload.resolution : "480p";
    const args = [
      toolVaultPath, "run", "seedance2", "--",
      seedancePython, seedanceRunner, "submit",
      "--prompt-file", promptPath,
      "--title", String(payload.title || "数字人口播").slice(0, 80),
      "--out-dir", runDir,
      "--image", avatarPath,
      "--audio-reference", voicePath,
      "--model", seedanceModel,
      "--resolution", resolution,
      "--ratio", ratio,
      "--duration", "15",
      "--poll-interval", "10",
      "--max-polls", "180",
      "--confirm-submit-authorization",
      "--verify"
    ];
    child = spawn(seedancePython, args, { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return finish({
      status: "failed", progress: 100, finishedAt: new Date().toISOString(),
      error: { code: error.code || "SEEDANCE_PREFLIGHT_FAILED", message: error.message, retryable: false }
    });
  }

  const handleLine = (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.phase === "submitted_once") {
      providerTaskId = event.task_id || providerTaskId;
      setTask(taskId, { progress: 35, providerTaskId });
    } else if (event.phase === "poll") {
      pollCount += 1;
      setTask(taskId, { progress: Math.min(92, 42 + pollCount * 2), providerTaskId, providerStatus: event.status || "running" });
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    lineBuffer += chunk;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() || "";
    lines.forEach(handleLine);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderrBuffer = `${stderrBuffer}${chunk}`.slice(-5000); });
  child.on("error", (error) => finish({
    status: "failed", progress: 100, finishedAt: new Date().toISOString(),
    error: { code: "SEEDANCE_PROCESS_FAILED", message: error.message, retryable: true, ...(providerTaskId ? { providerTaskId } : {}) }
  }));
  child.on("close", (code) => {
    if (finished) return;
    if (lineBuffer) handleLine(lineBuffer);
    const reportPath = join(runDir, "final_report.json");
    let report = null;
    try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch {}
    providerTaskId = report?.task_id || providerTaskId;
    if (code === 0 && report?.status === "succeeded" && report.video_path && existsSync(report.video_path)) {
      const fileName = `${taskId}.mp4`;
      copyFileSync(report.video_path, join(outputRoot, fileName));
      return finish({
        status: "succeeded", progress: 100, finishedAt: new Date().toISOString(),
        result: {
          provider: "seedance2",
          providerTaskId,
          providerStatus: "succeeded",
          videoUrl: `/outputs/${fileName}`,
          balanceBefore: report.balance_before?.wallet_balance ?? null,
          balanceAfter: report.balance_after?.wallet_balance ?? null,
          deductedPoints: report.deducted_points ?? null
        }
      });
    }
    let message = report?.status && report.status !== "succeeded" ? `Seedance 任务状态：${report.status}` : "Seedance 生成失败";
    const stderrLine = stderrBuffer.trim().split("\n").filter(Boolean).at(-1);
    if (stderrLine) {
      try { message = JSON.parse(stderrLine).error || message; }
      catch { message = stderrLine.slice(0, 800); }
    }
    finish({
      status: "failed", progress: 100, finishedAt: new Date().toISOString(),
      error: { code: "SEEDANCE_GENERATION_FAILED", message, retryable: false, ...(providerTaskId ? { providerTaskId } : {}) }
    });
  });
  timeout = setTimeout(() => {
    child.kill("SIGTERM");
    finish({
      status: "failed", progress: 100, finishedAt: new Date().toISOString(),
      error: {
        code: "SEEDANCE_WAIT_TIMEOUT",
        message: "Seedance 已等待 30 分钟，本地停止轮询且不会自动重提；可用任务 ID 继续查询",
        retryable: false,
        ...(providerTaskId ? { providerTaskId } : {})
      }
    });
  }, 30 * 60_000);
}

function persistTasks() {
  const safe = [...tasks.values()].slice(-50).map(({ internal, ...task }) => task);
  writeFileSync(tasksFile, JSON.stringify({ updatedAt: new Date().toISOString(), tasks: safe }, null, 2));
}

function setTask(id, patch) {
  const current = tasks.get(id);
  if (!current) return;
  tasks.set(id, { ...current, ...patch, updatedAt: new Date().toISOString() });
  persistTasks();
}

function allowRequest(ip) {
  const now = Date.now();
  const current = (rateWindow.get(ip) || []).filter((stamp) => now - stamp < 60_000);
  if (current.length >= 12) return false;
  current.push(now);
  rateWindow.set(ip, current);
  return true;
}

async function generateElevenAudio(taskId, payload) {
  try {
    setTask(taskId, { status: "running", progress: 20, startedAt: new Date().toISOString() });
    const response = await elevenFetch(`/v1/text-to-speech/${encodeURIComponent(payload.voiceId)}?output_format=mp3_44100_128`, {
      method: "POST",
      timeout: 60_000,
      body: JSON.stringify({
        text: payload.script,
        model_id: payload.modelId || "eleven_multilingual_v2",
        voice_settings: {
          stability: payload.stability ?? 0.55,
          similarity_boost: payload.similarity ?? 0.78,
          style: payload.style ?? 0.18,
          speed: payload.speed ?? 1
        }
      })
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 500) throw new Error("生成音频为空");
    const fileName = `${taskId}.mp3`;
    writeFileSync(join(outputRoot, fileName), bytes);
    setTask(taskId, {
      status: "succeeded",
      progress: 100,
      finishedAt: new Date().toISOString(),
      result: { audioUrl: `/outputs/${fileName}`, bytes: bytes.length }
    });
  } catch (error) {
    setTask(taskId, {
      status: "failed",
      progress: 100,
      finishedAt: new Date().toISOString(),
      error: { code: error.code || "TTS_FAILED", message: error.message, retryable: Boolean(error.retryable) }
    });
  }
}

async function generateVoiceboxAudio(taskId, payload, voice) {
  try {
    setTask(taskId, { status: "running", progress: 8, startedAt: new Date().toISOString() });
    await ensureVoicebox();
    setTask(taskId, { progress: 22 });
    const requestStartedAt = Date.now();
    const requestBody = {
      text: payload.script,
      profile_id: voice.profileId,
      language: payload.language === "en" ? "en" : "zh",
      model_size: "1.7B"
    };
    const serviceUrl = discoverVoiceboxServiceUrl();
    if (!serviceUrl) throw Object.assign(new Error("未检测到本地 Voicebox 服务"), { code: "VOICEBOX_NOT_CONFIGURED" });
    const generated = await fetch(`${serviceUrl}/generate`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });
    let result = null;
    try { result = await generated.json(); } catch {}

    // Voicebox 目前会在首次加载 Qwen 模型时偶发返回 500，但任务已经成功入队。
    // 通过本人音色、原文和创建时间找回这条任务，避免工作台误报失败。
    let generationId = result?.id || null;
    if (!generationId) {
      for (let attempt = 0; attempt < 8 && !generationId; attempt += 1) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          const historyResponse = await voiceboxFetch(`/history?profile_id=${encodeURIComponent(voice.profileId)}&limit=20`, { timeout: 5000 });
          const history = await historyResponse.json();
          const match = (history.items || []).find((item) => {
            const createdAt = Date.parse(item.created_at || "");
            return item.profile_id === voice.profileId
              && item.text === payload.script
              && (!Number.isFinite(createdAt) || createdAt >= requestStartedAt - 15_000);
          });
          generationId = match?.id || null;
        } catch {}
      }
    }
    if (!generationId) {
      const detail = typeof result?.detail === "string" ? result.detail : result?.message;
      throw Object.assign(new Error(detail || `Voicebox 返回 ${generated.status}，且未找到生成任务`), {
        code: `VOICEBOX_${generated.status}`,
        retryable: generated.status >= 500
      });
    }

    let completed = false;
    for (let attempt = 0; attempt < 480; attempt += 1) {
      const statusResponse = await voiceboxFetch(`/history/${encodeURIComponent(generationId)}`, { timeout: 5000 });
      const status = await statusResponse.json();
      if (["completed", "succeeded"].includes(status.status)) {
        completed = true;
        break;
      }
      if (["failed", "cancelled", "canceled"].includes(status.status)) {
        throw Object.assign(new Error(status.error || "Voicebox 本地生成失败"), { code: "VOICEBOX_GENERATION_FAILED" });
      }
      setTask(taskId, { progress: Math.min(90, 24 + Math.floor(attempt / 7)) });
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (!completed) throw Object.assign(new Error("Voicebox 生成超时"), { code: "VOICEBOX_TIMEOUT", retryable: true });

    setTask(taskId, { progress: 92 });
    const audioResponse = await voiceboxFetch(`/audio/${encodeURIComponent(generationId)}`, { timeout: 30_000 });
    const bytes = Buffer.from(await audioResponse.arrayBuffer());
    if (bytes.length < 500) throw new Error("Voicebox 生成音频为空");
    const fileName = `${taskId}.wav`;
    writeFileSync(join(outputRoot, fileName), bytes);
    setTask(taskId, {
      status: "succeeded",
      progress: 100,
      finishedAt: new Date().toISOString(),
      result: { audioUrl: `/outputs/${fileName}`, bytes: bytes.length, provider: "voicebox", profileId: voice.profileId, generationId }
    });
  } catch (error) {
    setTask(taskId, {
      status: "failed",
      progress: 100,
      finishedAt: new Date().toISOString(),
      error: { code: error.code || "VOICEBOX_TTS_FAILED", message: error.message, retryable: Boolean(error.retryable) }
    });
  }
}

function createTask(payload) {
  const requestKey = payload.idempotencyKey || createHash("sha256")
    .update(JSON.stringify({ type: payload.type, script: payload.script, voiceId: payload.voiceId, avatarId: payload.avatarId }))
    .digest("hex");
  const existingId = idempotency.get(requestKey);
  if (existingId && tasks.has(existingId)) return { task: tasks.get(existingId), reused: true };

  const id = randomUUID();
  const task = {
    id,
    type: payload.type,
    title: String(payload.title || "未命名口播").slice(0, 80),
    status: "queued",
    progress: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: null,
    error: null
  };
  tasks.set(id, task);
  idempotency.set(requestKey, id);
  persistTasks();
  return { task, reused: false };
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

  if (request.method === "POST" && url.pathname === "/api/seedance/prompt-preview") {
    let payload;
    try {
      payload = await readJson(request, 40_000);
    } catch (error) {
      return sendJson(response, 400, envelope(false, null, { requestId, errorCode: error.message, message: "提示词预览内容无效" }));
    }
    const avatar = avatarById(payload.avatarId) || { name: payload.avatarName || "所选人物" };
    const voice = [...loadLocalVoices(), ...loadCustomVoices()].find((item) => item.id === payload.voiceId)
      || { name: payload.voiceName || "所选音色" };
    if (!payload.script || String(payload.script).trim().length < 3) {
      return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "SCRIPT_INVALID", message: "脚本至少需要 3 个字符" }));
    }
    const prompt = buildSeedancePrompt(payload, avatar, voice);
    return sendJson(response, 200, envelope(true, { prompt, model: seedanceModel, duration: 15 }, { requestId }));
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

  if (request.method === "GET" && url.pathname.startsWith("/api/tasks/")) {
    const id = url.pathname.split("/").pop();
    const task = tasks.get(id);
    if (!task) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "TASK_NOT_FOUND", message: "任务不存在" }));
    return sendJson(response, 200, envelope(true, task, { requestId }));
  }

  if (request.method === "POST" && url.pathname === "/api/tasks") {
    const ip = request.socket.remoteAddress || "local";
    if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
    let payload;
    try {
      payload = await readJson(request);
    } catch (error) {
      return sendJson(response, 400, envelope(false, null, { requestId, errorCode: error.message, message: "请求内容无效" }));
    }
    if (!payload.script || payload.script.length < 3 || payload.script.length > 5000) {
      return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "SCRIPT_INVALID", message: "脚本需为 3–5000 个字符" }));
    }
    if (payload.type === "dry_run") {
      const { task, reused } = createTask(payload);
      setTimeout(() => setTask(task.id, { status: "running", progress: 46, startedAt: new Date().toISOString() }), 350);
      setTimeout(() => setTask(task.id, {
        status: "succeeded",
        progress: 100,
        finishedAt: new Date().toISOString(),
        result: { simulated: true, message: "流程检查通过，未产生 API 费用" }
      }), 1200);
      return sendJson(response, 202, envelope(true, { taskId: task.id, reused }, { requestId, warnings: ["这是无费用模拟任务"] }));
    }
    if (payload.type === "voice_preview") {
      if (!payload.voiceId) return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "VOICE_REQUIRED", message: "请选择 ElevenLabs 音色" }));
      const localVoice = loadLocalVoices().find((voice) => voice.id === payload.voiceId);
      if (localVoice?.provider === "voicebox" && localVoice.ttsReady) {
        const { task, reused } = createTask(payload);
        if (!reused) generateVoiceboxAudio(task.id, payload, localVoice);
        return sendJson(response, 202, envelope(true, { taskId: task.id, reused }, {
          requestId,
          warnings: ["使用本机 Voicebox / Qwen3-TTS 生成，不消耗 ElevenLabs 额度"]
        }));
      }
      if (localVoice) {
        return sendJson(response, 422, envelope(false, null, {
          requestId,
          errorCode: "VOICE_SAMPLE_ONLY",
          message: "这是本地历史样音，尚未保存进 ElevenLabs Voice Library，不能生成新配音"
        }));
      }
      if (payload.confirmCost !== true) return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "COST_CONFIRMATION_REQUIRED", message: "真实配音需要明确确认费用" }));
      const { task, reused } = createTask(payload);
      if (!reused) generateElevenAudio(task.id, payload);
      return sendJson(response, 202, envelope(true, { taskId: task.id, reused }, { requestId }));
    }
    if (payload.type === "final_video") {
      if (payload.confirmCost !== true) return sendJson(response, 409, envelope(false, null, {
        requestId, errorCode: "COST_CONFIRMATION_REQUIRED", message: "真实视频生成需要明确确认费用"
      }));
      if (!payload.avatarId) return sendJson(response, 422, envelope(false, null, {
        requestId, errorCode: "AVATAR_REQUIRED", message: "请选择人物参考图"
      }));
      if (!avatarById(payload.avatarId)) return sendJson(response, 422, envelope(false, null, {
        requestId, errorCode: "AVATAR_NOT_FOUND", message: "找不到所选人物参考图"
      }));
      if (!payload.voiceId) return sendJson(response, 422, envelope(false, null, {
        requestId, errorCode: "VOICE_REQUIRED", message: "请选择音色参考"
      }));
      const seedance = getSeedanceStatus();
      if (!seedance.connected) return sendJson(response, 503, envelope(false, null, {
        requestId,
        errorCode: seedance.state === "unauthorized" ? "SEEDANCE_UNAUTHORIZED" : "SEEDANCE_UNAVAILABLE",
        message: seedance.state === "unauthorized" ? "Seedance 2.0 账号认证已失效，请重新授权" : "Seedance 2.0 API 当前不可用"
      }));
      const { task, reused } = createTask(payload);
      if (!reused) generateSeedanceVideo(task.id, payload);
      return sendJson(response, 202, envelope(true, { taskId: task.id, reused }, {
        requestId,
        warnings: ["已向 Seedance 2.0 提交 1 条任务；人物图片和所选音色作为参考，不会自动付费重试"]
      }));
    }
    return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "TASK_TYPE_INVALID", message: "不支持的任务类型" }));
  }

  if (url.pathname.startsWith("/api/drama/")) {
    return handleDramaApi(request, response, url, {
      sendJson,
      envelope,
      readJson,
      allowRequest,
      store: dramaStore,
      llmDeps: { config: dramaLlmConfig },
      comfyConfig: comfyuiConfig,
      pricing: dramaPricing
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
  if (pathname.startsWith("/outputs/")) {
    const fileName = pathname.slice("/outputs/".length);
    if (!/^[a-f0-9-]+\.(mp3|wav|mp4)$/i.test(fileName)) return false;
    const outputPath = join(outputRoot, fileName);
    if (!existsSync(outputPath)) return false;
    response.writeHead(200, { "Cache-Control": "private, max-age=3600", "Content-Type": contentTypes[extname(outputPath)] || "application/octet-stream" });
    createReadStream(outputPath).pipe(response);
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
  const dramaFileMatch = pathname.match(/^\/drama-files\/(drama-[a-f0-9-]+)\/([a-z0-9-]+\.(png|jpg|webp))$/i);
  if (dramaFileMatch) {
    const filePath = join(dramaStore.dir(dramaFileMatch[1]), "frames", dramaFileMatch[2]);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
    response.writeHead(200, {
      "Cache-Control": "private, max-age=3600",
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream"
    });
    createReadStream(filePath).pipe(response);
    return true;
  }
  const requestedPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
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
      console.log(`数字人口播工作台：${url}`);
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
