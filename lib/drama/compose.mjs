// lib/drama/compose.mjs
// 合成编排：逐镜归一化 → 拼接 → (可选)背景音乐混音 → (可选)软字幕封装 → 成片 final.mp4 + film.srt
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { runFfmpeg, buildNormalizeArgs, buildConcatArgs, buildBgmArgs, buildSubtitleArgs } from "./ffmpeg.mjs";
import { filmSrt } from "./subtitle.mjs";
import { buildMeta } from "./export.mjs";

function safeMessage(error) {
  const code = String(error?.code || "");
  if (!code || /^E[A-Z_0-9]+$/.test(code)) return `本地文件系统错误（${code || "UNKNOWN"}）`;
  return String(error.message || "").slice(0, 300);
}

export async function composeFilm(ctx, projectId) {
  const { store } = ctx;
  const setCompose = (patch) => store.update(projectId, (p) => {
    p.compose = { status: "idle", file: null, srtFile: null, error: null, startedAt: null, finishedAt: null, ...(p.compose || {}), ...patch };
  });
  const project = store.get(projectId);
  if (!project) return;
  const run = async (args) => {
    const doFfmpeg = async () => (ctx.runFfmpeg ? ctx.runFfmpeg(args) : runFfmpeg(args, { ffmpegPath: ctx.ffmpegPath || "ffmpeg" }));
    // M10：合成经队列（ffmpeg kind）；无 jobQueue 回退直接执行
    if (ctx.jobQueue) return ctx.jobQueue.enqueue("ffmpeg", { task: doFfmpeg });
    return doFfmpeg();
  };
  try {
    setCompose({ status: "running", error: null, startedAt: new Date().toISOString() });
    const dir = store.dir(projectId);
    const audioDir = join(dir, "audio");
    const composeDir = join(dir, "compose");
    mkdirSync(audioDir, { recursive: true });
    mkdirSync(composeDir, { recursive: true });

    // 1. 逐镜归一化（配音 ready 用配音，否则静音轨兜底）
    const normFiles = [];
    for (const shot of project.shots) {
      const clipPath = join(dir, "clips", shot.clip.file);
      const shotAudio = shot.clip?.audio;
      const voicePath = shotAudio?.status === "ready" && shotAudio.file ? join(audioDir, shotAudio.file) : null;
      const out = `${shot.id}-norm.mp4`;
      await run(buildNormalizeArgs({ clipPath, audioPath: voicePath, output: join(audioDir, out) }));
      normFiles.push(out);
    }

    // 2. 拼接（流拷贝）
    const listFile = join(composeDir, "concat.txt");
    writeFileSync(listFile, normFiles.map((f) => `file '${join(audioDir, f)}'`).join("\n"));
    await run(buildConcatArgs({ listFile, output: join(composeDir, "merged.mp4") }));
    let current = "merged.mp4";

    // 3. 背景音乐（可选）
    if (project.bgm?.file) {
      await run(buildBgmArgs({ filmPath: join(composeDir, current), bgmPath: join(dir, project.bgm.file), volume: project.bgm.volume, output: join(composeDir, "with-bgm.mp4") }));
      current = "with-bgm.mp4";
    }

    // 4. 软字幕（有台词时）
    const srt = filmSrt(project.shots);
    let srtFile = null;
    if (srt.trim()) {
      srtFile = "film.srt";
      writeFileSync(join(composeDir, srtFile), srt);
      await run(buildSubtitleArgs({ filmPath: join(composeDir, current), srtPath: join(composeDir, srtFile), output: join(composeDir, "final.mp4") }));
      current = "final.mp4";
    }

    // M11：生成封面（首镜 confirmed 首帧 png 复制）+ 元数据；失败不阻塞成片
    let cover = null;
    let meta = null;
    try {
      const firstConfirmed = project.shots.find((s) => s.frame?.status === "confirmed");
      const firstShot = firstConfirmed || project.shots[0];
      if (firstShot?.frame?.file) {
        const coverSrc = join(store.dir(projectId), "frames", firstShot.frame.file);
        if (existsSync(coverSrc)) { copyFileSync(coverSrc, join(composeDir, "cover.png")); cover = "cover.png"; }
      }
      writeFileSync(join(composeDir, "meta.json"), JSON.stringify(buildMeta(project), null, 2));
      meta = "meta.json";
    } catch { /* 封面/元数据失败不阻塞成片 */ }
    setCompose({ status: "succeeded", file: current, srtFile, cover, meta, finishedAt: new Date().toISOString() });
  } catch (error) {
    setCompose({ status: "failed", error: { code: error.code || "COMPOSE_FAILED", message: safeMessage(error) }, finishedAt: new Date().toISOString() });
  }
}
