// lib/drama/ffmpeg.mjs
// 本机 FFmpeg：探测（FFMPEG_PATH > 系统 PATH > 常见路径）+ 命令构造 + 执行；零 API 费用
import { execFileSync, spawn } from "node:child_process";

export function detectFfmpeg({ execImpl = execFileSync, env = process.env, platform = process.platform } = {}) {
  const candidates = [];
  if (env.FFMPEG_PATH) candidates.push(env.FFMPEG_PATH);
  candidates.push("ffmpeg");
  if (platform === "darwin") candidates.push("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg");
  else if (platform === "win32") candidates.push("C:\\ffmpeg\\bin\\ffmpeg.exe");
  else candidates.push("/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg");
  for (const cmd of candidates) {
    try {
      const out = execImpl(cmd, ["-version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      const m = String(out).match(/ffmpeg version (\S+)/);
      return { available: true, path: cmd, version: m ? m[1] : "unknown" };
    } catch { /* 尝试下一个候选 */ }
  }
  return { available: false, path: null, version: null };
}

export function runFfmpeg(args, { spawnImpl = spawn, ffmpegPath = "ffmpeg" } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      reject(Object.assign(new Error(`FFmpeg 启动失败：${err.message}`), { code: "FFMPEG_SPAWN_FAILED" }));
      return;
    }
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => reject(Object.assign(new Error(`FFmpeg 启动失败：${err.message}`), { code: "FFMPEG_SPAWN_FAILED" })));
    child.on("close", (code) => {
      if (code === 0) resolve({ stderr });
      else {
        const err = new Error(`FFmpeg 退出码 ${code}`);
        err.code = "FFMPEG_FAILED";
        err.stderr = String(stderr).slice(-1500);
        reject(err);
      }
    });
  });
}

// 逐镜归一化：统一 h264/aac；配音(第二输入)/静音(anullsrc)二选一，apad+shortest 使音频与视频等长
export function buildNormalizeArgs({ clipPath, audioPath, output }) {
  const args = ["-y", "-i", clipPath];
  if (audioPath) args.push("-i", audioPath);
  else args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono");
  args.push("-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "44100", "-af", "apad", "-shortest", output);
  return args;
}

// 拼接（归一化后同码流，可流拷贝，零重编码）
export function buildConcatArgs({ listFile, output }) {
  return ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", output];
}

// 混背景音乐：循环铺满 + sidechain 闪避到人声之下 + amix 合并
export function buildBgmArgs({ filmPath, bgmPath, volume, output }) {
  const vol = Math.min(1, Math.max(0, Number(volume) || 0.3));
  const filter = `[1:a]volume=${vol}[bgm];[bgm][0:a]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=250[duck];[0:a][duck]amix=inputs=2:duration=first:normalize=0[a]`;
  return ["-y", "-i", filmPath, "-stream_loop", "-1", "-i", bgmPath,
    "-filter_complex", filter, "-map", "0:v:0", "-map", "[a]",
    "-c:v", "copy", "-c:a", "aac", "-shortest", output];
}

// 封装软字幕轨（mov_text，播放器可开关）
export function buildSubtitleArgs({ filmPath, srtPath, output }) {
  return ["-y", "-i", filmPath, "-i", srtPath,
    "-map", "0:v:0", "-map", "0:a:0?", "-map", "1:0",
    "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text",
    "-metadata:s:s:0", "language=chi", output];
}
