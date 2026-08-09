// Seedance 2.0 生成机制（自 server.mjs 抽取，口播页与短剧工作台共用）
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function downloadReference(url, runDir, stem, kind) {
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

export async function resolveSeedanceAvatar(payload, runDir, accessors) {
  const avatar = accessors.findAvatar(payload.avatarId);
  if (!avatar) throw Object.assign(new Error("找不到所选人物图片"), { code: "AVATAR_NOT_FOUND" });
  if (avatar.source === "demo") {
    throw Object.assign(new Error("演示形象仅用于界面预览，请添加你自己的人物图片"), { code: "DEMO_AVATAR_NOT_GENERATABLE" });
  }
  const localPath = accessors.trustedUploadPath(avatar.image);
  if (localPath) return { avatar, path: localPath };
  const remoteUrl = avatar.remoteUrl || avatar.image;
  return { avatar, path: await downloadReference(remoteUrl, runDir, "character_reference", "image") };
}

export async function resolveSeedanceVoice(payload, runDir, accessors) {
  const voice = accessors.findVoice(payload.voiceId) || null;
  if (voice?.previewPath && existsSync(voice.previewPath)) return { voice, path: voice.previewPath };
  const previewUrl = voice?.previewUrl || String(payload.voicePreviewUrl || "");
  if (!previewUrl) throw Object.assign(new Error("所选音色没有可用的参考音频"), { code: "VOICE_REFERENCE_MISSING" });
  return { voice: voice || { id: payload.voiceId, name: payload.voiceName || "所选音色" }, path: await downloadReference(previewUrl, runDir, "voice_reference", "audio") };
}

export function buildSeedancePrompt(payload, avatar, voice) {
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

// Seedance 时长档位：分镜时长向上取到供应商支持的档位
export function seedanceDurationTier(sec) {
  const value = Number(sec) || 5;
  if (value <= 5) return 5;
  if (value <= 10) return 10;
  return 15;
}

// Promise 化生成编排：事件经 onEvent 透出，结果/错误经返回值传递；错误码与历史实现完全一致
export function runSeedanceGeneration({ config, payload, runDir, durationSec = 15, onEvent = () => {} }) {
  return new Promise((resolve, reject) => {
    mkdirSync(runDir, { recursive: true });
    let child;
    let providerTaskId = "";
    let stderrBuffer = "";
    let lineBuffer = "";
    let pollCount = 0;
    let finished = false;
    let timeout;
    const fail = (error) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    };
    const done = (result) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };

    (async () => {
      const [{ path: avatarPath }, { path: voicePath }] = await Promise.all([
        resolveSeedanceAvatar(payload, runDir, config.accessors),
        resolveSeedanceVoice(payload, runDir, config.accessors)
      ]);
      const avatar = config.accessors.findAvatar(payload.avatarId);
      const voice = config.accessors.findVoice(payload.voiceId) || { name: payload.voiceName || "所选音色" };
      const generationPrompt = String(payload.generationPrompt || "").trim() || buildSeedancePrompt(payload, avatar, voice);
      if (generationPrompt.length < 20 || generationPrompt.length > 10_000) {
        throw Object.assign(new Error("Seedance 生成提示词需为 20–10000 个字符"), { code: "GENERATION_PROMPT_INVALID" });
      }
      const promptPath = join(runDir, "prompt.txt");
      writeFileSync(promptPath, `${generationPrompt}\n`, "utf8");
      onEvent({ phase: "prepared" });

      const ratio = payload.ratio === "landscape" ? "16:9" : payload.ratio === "square" ? "1:1" : "9:16";
      const resolution = ["480p", "720p"].includes(payload.resolution) ? payload.resolution : "480p";
      const args = [
        config.toolVault, "run", "seedance2", "--",
        config.python, config.runner, "submit",
        "--prompt-file", promptPath,
        "--title", String(payload.title || "数字人口播").slice(0, 80),
        "--out-dir", runDir,
        "--image", avatarPath,
        "--audio-reference", voicePath,
        "--model", config.model,
        "--resolution", resolution,
        "--ratio", ratio,
        "--duration", String(seedanceDurationTier(durationSec)),
        "--poll-interval", "10",
        "--max-polls", "180",
        "--confirm-submit-authorization",
        "--verify"
      ];
      child = spawn(config.python, args, { cwd: config.projectRoot, stdio: ["ignore", "pipe", "pipe"] });
      wireChild();
    })().catch((error) => fail(Object.assign(error, {
      code: error.code || "SEEDANCE_PREFLIGHT_FAILED",
      retryable: false
    })));

    const handleLine = (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.phase === "submitted_once") {
        providerTaskId = event.task_id || providerTaskId;
        onEvent({ phase: "submitted", providerTaskId });
      } else if (event.phase === "poll") {
        pollCount += 1;
        onEvent({ phase: "poll", providerTaskId, status: event.status || "running", pollCount });
      }
    };

    function wireChild() {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        lineBuffer += chunk;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() || "";
        lines.forEach(handleLine);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderrBuffer = `${stderrBuffer}${chunk}`.slice(-5000); });
      child.on("error", (error) => fail(Object.assign(new Error(error.message), {
        code: "SEEDANCE_PROCESS_FAILED", retryable: true, ...(providerTaskId ? { providerTaskId } : {})
      })));
      child.on("close", (code) => {
        if (finished) return;
        if (lineBuffer) handleLine(lineBuffer);
        const reportPath = join(runDir, "final_report.json");
        let report = null;
        try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch {}
        providerTaskId = report?.task_id || providerTaskId;
        if (code === 0 && report?.status === "succeeded" && report.video_path && existsSync(report.video_path)) {
          return done({ videoPath: report.video_path, providerTaskId, report });
        }
        let message = report?.status && report.status !== "succeeded" ? `Seedance 任务状态：${report.status}` : "Seedance 生成失败";
        const stderrLine = stderrBuffer.trim().split("\n").filter(Boolean).at(-1);
        if (stderrLine) {
          try { message = JSON.parse(stderrLine).error || message; }
          catch { message = stderrLine.slice(0, 800); }
        }
        fail(Object.assign(new Error(message), {
          code: "SEEDANCE_GENERATION_FAILED", retryable: false, ...(providerTaskId ? { providerTaskId } : {})
        }));
      });
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        fail(Object.assign(new Error("Seedance 已等待 30 分钟，本地停止轮询且不会自动重提；可用任务 ID 继续查询"), {
          code: "SEEDANCE_WAIT_TIMEOUT", retryable: false, ...(providerTaskId ? { providerTaskId } : {})
        }));
      }, 30 * 60_000);
    }
  });
}
