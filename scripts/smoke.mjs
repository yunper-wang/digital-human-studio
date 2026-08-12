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
    DRAMA_RATE_LIMIT: "60", // 冒烟守卫密集写入，放宽速率限制
    COMFYUI_URL: "",
    DRAMA_VIDEO_WORKFLOW: "",
    COMFYUI_VIDEO_TIMEOUT_MS: ""
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

  // M4 新字段守卫：audioMode/continuity 编辑持久化，且不使闸门 A 确认失效（仅台词/时长变更才失效）
  const patchedProject = await request(`/api/drama/projects/${created.project.id}/shots/${drama.shots[0].id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audioMode: "none", continuity: "回归" })
  });
  const patchedShot = patchedProject.project.shots.find((shot) => shot.id === drama.shots[0].id);
  if (patchedShot.audioMode !== "none" || patchedShot.continuity !== "回归") throw new Error("shot audioMode/continuity edit not persisted");
  if (!patchedProject.project.gateAConfirmedAt || patchedProject.project.gateAConfirmedAt !== confirmed.project.gateAConfirmedAt) {
    throw new Error("audioMode/continuity edit must not invalidate gate A confirmation");
  }

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

  // ---------- M5：合成守卫（干净环境无系统 FFmpeg 时） ----------
  const ffProbe = await request(`/api/drama/projects/${created.project.id}/compose/ffmpeg`);
  if (typeof ffProbe.available !== "boolean") throw new Error("compose/ffmpeg 未返回 available 布尔值");
  const composeTry = await fetch(`http://127.0.0.1:${port}/api/drama/projects/${created.project.id}/compose`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
  });
  const composeBody = await composeTry.json();
  // 无 FFmpeg → 503 FFMPEG_UNAVAILABLE；有 FFmpeg 但视频未确认 → 409 CLIPS_NOT_READY；二者必居其一
  if (composeBody.ok) throw new Error("compose 在守卫场景不应成功");
  if (!["FFMPEG_UNAVAILABLE", "CLIPS_NOT_READY"].includes(composeBody.errorCode)) {
    throw new Error(`compose 守卫异常：${composeBody.errorCode}`);
  }
  if (JSON.stringify(ffProbe).match(/\/Users\/|\/home\//)) throw new Error("compose/ffmpeg 暴露了本机路径");

  // ---------- M6：剧集 + 版本守卫 ----------
  const seriesRes = await request("/api/drama/series", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "烟雾剧集" }) });
  if (!seriesRes.series?.id) throw new Error("创建剧集失败");
  const verRes = await request(`/api/drama/projects/${created.project.id}/versions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "烟雾版本" }) });
  if (!verRes.snapshot?.id) throw new Error("存版本失败");
  const verList = await request(`/api/drama/projects/${created.project.id}/versions`);
  if (!verList.versions.some((v) => v.id === verRes.snapshot.id)) throw new Error("版本列表未含新版本");

  // ---------- M7：提示词模板 + 素材 + providers 守卫 ----------
  const tplList = await request("/api/drama/prompt-templates");
  if (!tplList.templates?.some((t) => t.builtin)) throw new Error("内置提示词模板未种子化");
  const tplRes = await request("/api/drama/prompt-templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "烟雾模板", stages: { review: "你是严格的短剧审核员，只输出 JSON。" } }) });
  if (!tplRes.template?.id) throw new Error("创建提示词模板失败");
  const patchedTpl = await request(`/api/drama/projects/${created.project.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ promptTemplateId: tplRes.template.id }) });
  if (patchedTpl.project.promptTemplateId !== tplRes.template.id) throw new Error("项目选用模板失败");
  const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const matRes = await request("/api/drama/materials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "烟雾素材", dataUrl: `data:image/png;base64,${png1x1}` }) });
  if (matRes.material?.kind !== "image") throw new Error("登记素材失败");
  const matStatic = await fetch(`http://127.0.0.1:${port}/materials/${matRes.material.file}`);
  if (matStatic.status !== 200) throw new Error("素材静态服务失败");
  const provRes = await request("/api/drama/providers");
  if (!Array.isArray(provRes.providers) || provRes.providers.length !== 5) throw new Error("providers 聚合形状异常");
  if (JSON.stringify(provRes).includes("apiKey")) throw new Error("providers 泄露密钥字段");

  // ---------- M8：素材引用注入守卫 ----------
  // smoke 环境 ComfyUI/ElevenLabs 不可用，守卫只验证素材登记 + 挂引用端点不炸（实际注入靠单元测试覆盖）
  const m8Img = await request("/api/drama/materials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "M8参考图", dataUrl: `data:image/png;base64,${png1x1}` }) });
  if (m8Img.material?.kind !== "image") throw new Error("M8 参考图登记失败");
  if (created.project.analysis?.scenes?.length) {
    const m8Patched = await request(`/api/drama/projects/${created.project.id}/analysis/assets`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenes: [{ id: created.project.analysis.scenes[0].id, refMaterialId: m8Img.material.id }] }) });
    if (!m8Patched.project) throw new Error("M8 挂参考图失败");
  }
  const m8Audio = await request("/api/drama/materials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "M8参考音", dataUrl: `data:audio/mpeg;base64,${Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]).toString("base64")}` }) });
  if (m8Audio.material?.kind !== "audio") throw new Error("M8 参考音频登记失败");

  // ---------- M9：项目级后端覆盖守卫 ----------
  const m9Before = await request(`/api/drama/projects/${created.project.id}/provider-overrides`);
  if (m9Before.overrides.llm !== null || m9Before.overrides.voice !== null) throw new Error("M9 初始 override 应为 null");
  const m9Patched = await request(`/api/drama/projects/${created.project.id}/provider-overrides`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ llm: { baseUrl: "https://api.example.com/v1", model: "gpt-4o", apiKey: "sk-M9-SECRET" } }) });
  if (!m9Patched.overrides.llm?.configured) throw new Error("M9 override 写入失败");
  const m9After = await request(`/api/drama/projects/${created.project.id}/provider-overrides`);
  if (JSON.stringify(m9After).includes("sk-M9-SECRET") || JSON.stringify(m9After).includes("apiKey")) throw new Error("M9 override 泄露密钥");
  await request(`/api/drama/projects/${created.project.id}/provider-overrides`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clear: ["llm"] }) });

  // ---------- M10：队列守卫 ----------
  const m10Queue = await request("/api/drama/queue/status");
  if (!m10Queue.queue || !m10Queue.queue.comfyui) throw new Error("M10 队列状态形状异常");
  if (m10Queue.queue.comfyui.running < 0 || m10Queue.queue.comfyui.queued < 0) throw new Error("M10 队列计数非法");

  // ---------- M11：成片导出守卫 ----------
  // compose 在 smoke 环境因 ComfyUI 不可用不会成功，守卫只验证未合成时 export/zip 返回 409 不炸
  const m11Export = await fetch(`http://127.0.0.1:${port}/api/drama/projects/${created.project.id}/export/zip`);
  if (m11Export.status !== 409) throw new Error(`M11 export/zip 未合成应返回 409，实际 ${m11Export.status}`);

  console.log(JSON.stringify({
    ok: true,
    service: health.service,
    providersConnected: false,
    demoAvatars: avatars.avatars.length,
    demoVoices: voices.voices.length,
    integrationRequirements: integrations.integrations.length,
    customAvatarUpload: customImage.status,
    dramaPipeline: drama.status,
    dramaCostGate: dramaGate.errorCode,
    dramaShotEditGuard: `${patchedShot.audioMode}/${patchedShot.continuity}`,
    dramaVideoGate: videoNoBindingBody.errorCode,
    composeGuard: composeBody.errorCode,
    seriesGuard: seriesRes.series.id,
    versionGuard: verRes.snapshot.id,
    promptTemplateGuard: tplRes.template.id,
    materialGuard: matRes.material.id,
    providersGuard: provRes.providers.length,
    m8MaterialGuard: m8Img.material.id,
    m8AudioGuard: m8Audio.material.id,
    m9OverrideGuard: m9Patched.overrides.llm.configured,
    m10QueueGuard: m10Queue.queue.comfyui.queued + m10Queue.queue.comfyui.running,
    m11ExportGuard: m11Export.status
  }, null, 2));
} finally {
  child.kill("SIGTERM");
  rmSync(smokeDataDir, { recursive: true, force: true });
}
