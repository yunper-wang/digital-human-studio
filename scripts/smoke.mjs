import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 4299;
const smokeDataDir = mkdtempSync(join(tmpdir(), "digital-human-studio-smoke-"));
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: smokeDataDir,
    ELEVENLABS_API_KEY: "",
    ELEVENLABS_KEY: "",
    XI_API_KEY: "",
    VOLCENGINE_TTS_APP_ID: "",
    VOLCENGINE_TTS_ACCESS_TOKEN: "",
    VOLCENGINE_TTS_VOICE_TYPE: "",
    VOICEBOX_URL: "",
    VOICEBOX_DISABLE_AUTO_DETECT: "1",
    SEEDANCE_PYTHON: "",
    TOOL_VAULT_PATH: "",
    SEEDANCE_RUNNER: "",
    DRAMA_LLM_BASE_URL: "",
    DRAMA_LLM_MODEL: "",
    DRAMA_LLM_API_KEY: "",
    DRAMA_LLM_MOCK: "",
    COMFYUI_URL: ""
  },
  stdio: ["ignore", "pipe", "pipe"]
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, options) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(`${path}: ${body.message || response.status}`);
  return body.data;
}

try {
  await wait(500);
  const health = await request("/api/health");
  const integrations = await request("/api/integrations");
  const avatars = await request("/api/avatars");
  const voices = await request("/api/voices");
  if (health.providers.seedance2.connected) throw new Error("public smoke test unexpectedly connected to a video provider");
  if (health.providers.elevenlabs.connected) throw new Error("public smoke test unexpectedly connected to a voice provider");
  const requiredIntegrations = ["video-generation", "cloud-voice", "volcengine-seed-tts-2", "volcengine-seed-icl-2", "local-cloned-voice"];
  if (!requiredIntegrations.every((id) => integrations.integrations.some((item) => item.id === id))) throw new Error("integration contract is missing a supported provider");
  if (integrations.integrations.some((item) => item.configured || item.connected)) throw new Error("clean integration contract unexpectedly reports configured providers");
  const localIntegration = integrations.integrations.find((item) => item.id === "local-cloned-voice");
  if (!localIntegration.downloadUrl?.startsWith("https://") || localIntegration.detection?.modelDownloaded) throw new Error("local model fallback is not safe or deterministic");
  const volcengineIntegration = integrations.integrations.find((item) => item.id === "volcengine-seed-tts-2");
  if (!volcengineIntegration.purchaseUrl?.startsWith("https://www.volcengine.com/")) throw new Error("Volcengine purchase link must use the official domain");
  const integrationJson = JSON.stringify(integrations);
  if (/\/Users\/|\/home\/|api[_-]?key["']?\s*[:=]\s*["'][^"']+/i.test(integrationJson)) throw new Error("integration contract exposed a path or secret value");
  if (avatars.avatars.length < 1 || voices.voices.length < 1) throw new Error("demo catalog missing");

  const custom = await request("/api/avatars/custom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Smoke avatar",
      imageData: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2vAAAAABJRU5ErkJggg=="
    })
  });
  const customImage = await fetch(`http://127.0.0.1:${port}${custom.avatar.image}`);
  if (!customImage.ok || !customImage.headers.get("content-type")?.startsWith("image/png")) throw new Error("custom avatar image not served");

  const promptPreview = await request("/api/seedance/prompt-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      script: "这是一条透明可编辑的数字人口播提示词。",
      avatarId: custom.avatar.id,
      avatarName: custom.avatar.name,
      voiceId: voices.voices[0].id,
      voiceName: voices.voices[0].name,
      language: "zh",
      settings: { motion: true }
    })
  });
  if (!promptPreview.prompt.includes(custom.avatar.name)) throw new Error("prompt preview missing selected avatar");

  const costGateResponse = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "final_video",
      confirmCost: false,
      title: "Cost gate",
      script: "这条请求必须在提交付费任务之前被费用门禁拦截。",
      avatarId: custom.avatar.id,
      voiceId: voices.voices[0].id
    })
  });
  const costGate = await costGateResponse.json();
  if (costGateResponse.status !== 409 || costGate.errorCode !== "COST_CONFIRMATION_REQUIRED") throw new Error("cost gate failed");

  const dryRun = await request("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "dry_run",
      title: "Smoke test",
      script: "这是一条不会产生费用的流程检查。",
      idempotencyKey: "smoke-test-v2"
    })
  });
  await wait(1500);
  const task = await request(`/api/tasks/${dryRun.taskId}`);
  if (task.status !== "succeeded") throw new Error(`dry run status=${task.status}`);

  // ---------- 短剧工作台：零费用全链路 ----------
  const dramaScript = "雨夜，林晚抱着纸箱站在便利店门口躲雨。陈默推门出来，把伞塞进她手里转身冲进雨里。林晚低头发现伞柄上贴着一张挂失回执，持卡人姓名写着陈默。她追出去两步，雨幕里已经看不到人影。";
  const created = await request("/api/drama/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "烟雾短剧", script: dramaScript })
  });
  await request(`/api/drama/projects/${created.project.id}/pipeline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  let drama = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(250);
    drama = (await request(`/api/drama/projects/${created.project.id}`)).project;
    if (["awaiting_gate_a", "review_blocked", "failed"].includes(drama.status)) break;
  }
  if (drama.status !== "awaiting_gate_a") throw new Error(`drama pipeline status=${drama.status}`);
  if (!drama.shots.length || !drama.budget || !drama.review) throw new Error("drama pipeline produced incomplete project");
  if (drama.shots.some((shot) => shot.fluxPrompt.length < 20)) throw new Error("drama shot missing flux prompt");

  const dramaGateResponse = await fetch(`http://127.0.0.1:${port}/api/drama/projects/${created.project.id}/gate-a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmCost: false })
  });
  const dramaGate = await dramaGateResponse.json();
  if (dramaGateResponse.status !== 409 || dramaGate.errorCode !== "COST_CONFIRMATION_REQUIRED") throw new Error("drama cost gate failed");

  const confirmed = await request(`/api/drama/projects/${created.project.id}/gate-a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmCost: true })
  });
  if (confirmed.project.status !== "frames") throw new Error("drama gate A confirmation did not unlock frames");

  const frameResponse = await fetch(`http://127.0.0.1:${port}/api/drama/projects/${created.project.id}/shots/${drama.shots[0].id}/frame`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const frameResult = await frameResponse.json();
  if (frameResponse.status !== 503 || frameResult.errorCode !== "COMFYUI_UNAVAILABLE") throw new Error("frame generation should require ComfyUI in clean env");

  const dramaJson = JSON.stringify(drama);
  if (/\/Users\/|\/home\/|api[_-]?key["']?\s*[:=]\s*["'][^"']+/i.test(dramaJson)) throw new Error("drama api exposed a path or secret value");

  // 角色绑定：未绑定口播镜生成视频 → 422；绑定后音色不存在 → 422
  const dialogueShot = drama.shots.find((shot) => shot.shotType === "dialogue") || drama.shots[0];
  const videoNoBinding = await fetch(`http://127.0.0.1:${port}/api/drama/projects/${created.project.id}/shots/${dialogueShot.id}/video`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const videoNoBindingBody = await videoNoBinding.json();
  if (![422, 503].includes(videoNoBinding.status)) throw new Error(`unexpected video gate status ${videoNoBinding.status}`);
  // mock 分镜首镜为 cinematic：frame 未确认时应 409；口播镜未绑定时应 422
  if (dialogueShot.shotType === "dialogue" && videoNoBindingBody.errorCode !== "CHARACTER_BINDING_REQUIRED") {
    throw new Error("dialogue video should require character binding");
  }
  if (dialogueShot.shotType !== "dialogue" && videoNoBindingBody.errorCode !== "FRAME_NOT_CONFIRMED") {
    throw new Error("cinematic video should require confirmed frame");
  }

  const bindBad = await fetch(`http://127.0.0.1:${port}/api/drama/projects/${created.project.id}/characters/char-1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voiceId: "voice-does-not-exist" })
  });
  if (bindBad.status !== 422 || (await bindBad.json()).errorCode !== "VOICE_NOT_FOUND") throw new Error("character binding validation failed");

  console.log(JSON.stringify({
    ok: true,
    service: health.service,
    providersConnected: false,
    demoAvatars: avatars.avatars.length,
    demoVoices: voices.voices.length,
    integrationRequirements: integrations.integrations.length,
    customAvatarUpload: customImage.status,
    promptPreview: promptPreview.prompt.length,
    costGate: costGate.errorCode,
    dryRun: task.status,
    dramaPipeline: drama.status,
    dramaCostGate: dramaGate.errorCode,
    dramaVideoGate: videoNoBindingBody.errorCode
  }, null, 2));
} finally {
  child.kill("SIGTERM");
  rmSync(smokeDataDir, { recursive: true, force: true });
}
