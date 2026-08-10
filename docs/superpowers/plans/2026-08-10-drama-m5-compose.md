# 短剧工作台 M5：后段生产线（配音/字幕/合成导出）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「生成」视图升级为真正的合成导出阶段：TTS 配音队列 + SRT 软字幕 + BGM 混音 + FFmpeg 合成为可下载成片 MP4 + SRT，含失败定位重试。

**Architecture:** 新增四个后端模块——`subtitle.mjs`（SRT 派生）、`audio.mjs`（TTS 配音）、`ffmpeg.mjs`（探测+执行）、`compose.mjs`（合成编排）；`routes.mjs` 增配音/BGM/合成端点，`server.mjs` 扩展静态服务并接线 ctx；前端重写 `renderGenerate` 并新增配音/BGM/合成动作层。FFmpeg 本地合成、零 API 费用。

**Tech Stack:** 零框架原生 HTML/CSS/JS；Node 20+（`node:child_process` spawn/execFileSync）；系统 FFmpeg（探测）；`node:test`。

## Global Constraints

- 零框架、无构建链、不引入新 npm 依赖；FFmpeg 走系统二进制（探测），**不打进依赖**。
- 中文提交信息（`类型: 简短描述`）；遵循既有 `lib/drama/*` 与 `tests/drama-*.test.mjs` 模式。
- 本机优先、私密不出本机；合成零 API 费用（本地 TTS + 本地 FFmpeg）。
- **FFmpeg 缺失 → 明确「未就绪」提示，不报错崩溃**；配音/合成失败落 `failed` 状态，**不自动重试**，由用户手动重试。
- 配音：对白镜（`shotType==="dialogue"` 且 `audioMode==="voice"`），Voicebox 本地免费优先、ElevenLabs 付费可选、**无 TTS 静默回退**（不阻塞合成）。
- 字幕：从 `shot.dialogue` 派生 SRT，时间轴按 `durationSec` 顺序累计；**校对即编辑该镜 `dialogue`（复用既有 PATCH shot），不新增 shot.subtitles 字段**。
- 音频生命周期 `none|queued|generating|ready|failed`；合成状态 `idle|running|succeeded|failed`。
- 复用 M4 编辑器结构（`#viewGenerate`、步骤条、分镜条、检查器）与既有动作函数层；只借鉴 VOZEB 设计，不复制代码（AGPL 规避）。

---

### Task 1: schema 扩展（clip.audio、project.bgm/compose）

**Files:**
- Modify: `lib/drama/schema.mjs`
- Test: `tests/drama-schema.test.mjs`

**Interfaces:**
- Consumes: 现有 `normalizeClip`、`normalizeProject`、`createDramaProject`
- Produces: `normalizeAudio(raw)` → `{status,file,provider,error}`；`normalizeClip` 返回对象新增 `audio` 字段；`normalizeProject` 与 `createDramaProject` 返回对象新增 `bgm`（`null|{file,name,volume}`）与 `compose`（`{status,file,srtFile,error,startedAt,finishedAt}`）字段

- [ ] **Step 1: 写失败测试**

在 `tests/drama-schema.test.mjs` 末尾追加：

```js
test("clip 增加 audio 生命周期，project 增加 bgm/compose", () => {
  const clip = normalizeClip({ status: "confirmed", audio: { status: "ready", file: "shot-1.mp3", provider: "voicebox" } });
  assert.equal(clip.audio.status, "ready");
  assert.equal(clip.audio.provider, "voicebox");
  // 默认 audio.status 为 none
  assert.equal(normalizeClip({}).audio.status, "none");
  // 非法 audio.status 回退 none
  assert.equal(normalizeClip({ audio: { status: "bogus" } }).audio.status, "none");

  const p = normalizeProject({
    id: "drama-x", title: "t", script: "s", ratio: "portrait",
    bgm: { file: "bgm/song.mp3", name: "song", volume: 0.4 },
    compose: { status: "succeeded", file: "final.mp4", srtFile: "film.srt" }
  });
  assert.equal(p.bgm.name, "song");
  assert.equal(p.bgm.volume, 0.4);
  assert.equal(p.compose.status, "succeeded");
  assert.equal(p.compose.srtFile, "film.srt");
  // 默认：bgm 为 null、compose.status 为 idle
  const d = normalizeProject({ id: "drama-y", title: "t", script: "s", ratio: "portrait" });
  assert.equal(d.bgm, null);
  assert.equal(d.compose.status, "idle");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-schema.test.mjs`
Expected: FAIL（`clip.audio` 为 undefined / `p.compose` 为 undefined）

- [ ] **Step 3: 实现**

`lib/drama/schema.mjs`：
1. 在 `normalizeClip` 之前新增：

```js
const AUDIO_STATUSES = ["none", "queued", "generating", "ready", "failed"];
export function normalizeAudio(raw = {}) {
  return {
    status: AUDIO_STATUSES.includes(raw?.status) ? raw.status : "none",
    file: typeof raw?.file === "string" && raw.file ? raw.file : null,
    provider: typeof raw?.provider === "string" ? raw.provider : null,
    error: raw?.error && typeof raw.error === "object"
      ? { code: String(raw.error.code || "VOICE_FAILED"), message: String(raw.error.message || "").slice(0, 300) }
      : null
  };
}
```

2. `normalizeClip` 返回对象在 `error` 后追加字段：`audio: normalizeAudio(raw?.audio),`（注意原对象字面量末位 `error: ...` 后补逗号）。

3. 新增 bgm/compose 归一化函数，并在 `normalizeProject` 的 `shots:` 行后插入 `bgm: normalizeBgm(raw.bgm),` 与 `compose: normalizeCompose(raw.compose),`：

```js
export function normalizeBgm(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.file !== "string" || !raw.file) return null;
  return {
    file: raw.file,
    name: String(raw.name || "背景音乐").slice(0, 60),
    volume: Math.min(1, Math.max(0, Number(raw.volume) || 0.3))
  };
}

export function normalizeCompose(raw = {}) {
  const STATUSES = ["idle", "running", "succeeded", "failed"];
  return {
    status: STATUSES.includes(raw?.status) ? raw.status : "idle",
    file: typeof raw?.file === "string" && raw.file ? raw.file : null,
    srtFile: typeof raw?.srtFile === "string" && raw.srtFile ? raw.srtFile : null,
    error: raw?.error && typeof raw.error === "object"
      ? { code: String(raw.error.code || "COMPOSE_FAILED"), message: String(raw.error.message || "").slice(0, 300) }
      : null,
    startedAt: typeof raw?.startedAt === "string" ? raw.startedAt : null,
    finishedAt: typeof raw?.finishedAt === "string" ? raw.finishedAt : null
  };
}
```

4. `createDramaProject` 返回对象在 `pipeline:` 行前插入 `bgm: null,`，并在 `pipeline:` 行后插入 `compose: { status: "idle", file: null, srtFile: null, error: null, startedAt: null, finishedAt: null },`。

5. 在测试文件 import 行确认 `normalizeClip`、`normalizeProject` 已引入（沿用既有 import，无需改）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-schema.test.mjs && npm run test:unit`
Expected: PASS；全量通过

- [ ] **Step 5: Commit**

```bash
git add lib/drama/schema.mjs tests/drama-schema.test.mjs
git commit -m "feat: 分镜 clip 增加配音轨、项目增加 BGM/合成字段（M5）"
```

---

### Task 2: subtitle.mjs（SRT 派生与序列化）

**Files:**
- Create: `lib/drama/subtitle.mjs`
- Test: `tests/drama-subtitle.test.mjs`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces: `formatSrtTime(sec)`→`"HH:MM:SS,mmm"`；`deriveSubtitles(shots)`→`[{shotId,start,end,text}]`（仅取有台词镜，时间按 `durationSec` 累计）；`entriesToSrt(entries)`→SRT 文本；`filmSrt(shots)`→整片 SRT 文本（无台词时返回 `"\n"` 之外的空串由 `entriesToSrt([])` 给出 `""`）

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-subtitle.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { formatSrtTime, deriveSubtitles, entriesToSrt, filmSrt } from "../lib/drama/subtitle.mjs";

test("formatSrtTime 输出 HH:MM:SS,mmm", () => {
  assert.equal(formatSrtTime(0), "00:00:00,000");
  assert.equal(formatSrtTime(65.5), "00:01:05,500");
  assert.equal(formatSrtTime(3.042), "00:00:03,042");
});

test("deriveSubtitles 仅取有台词镜并按 durationSec 累计时间", () => {
  const shots = [
    { id: "shot-1", dialogue: "第一句", durationSec: 3 },
    { id: "shot-2", dialogue: "", durationSec: 4 },        // 无台词跳过
    { id: "shot-3", dialogue: "第二句", durationSec: 5 }
  ];
  const subs = deriveSubtitles(shots);
  assert.equal(subs.length, 2);
  assert.deepEqual(subs[0], { shotId: "shot-1", start: 0, end: 3, text: "第一句" });
  // shot-3 起点 = 3 + 4（含无台词镜的时长）
  assert.deepEqual(subs[1], { shotId: "shot-3", start: 7, end: 12, text: "第二句" });
});

test("entriesToSrt 序列化为标准 SRT", () => {
  const srt = entriesToSrt([{ start: 0, end: 2, text: "你好" }]);
  assert.equal(srt, "1\n00:00:00,000 --> 00:00:02,000\n你好\n");
});

test("filmSrt 无台词时返回空串，有台词时含全部对白", () => {
  assert.equal(filmSrt([{ id: "s1", dialogue: "", durationSec: 3 }]), "");
  const srt = filmSrt([{ id: "s1", dialogue: "台词A", durationSec: 2 }, { id: "s2", dialogue: "台词B", durationSec: 3 }]);
  assert.ok(srt.includes("台词A") && srt.includes("台词B"));
  assert.ok(srt.startsWith("1\n"));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-subtitle.test.mjs`
Expected: FAIL（`Cannot find module '../lib/drama/subtitle.mjs'`）

- [ ] **Step 3: 实现**

新建 `lib/drama/subtitle.mjs`：

```js
// lib/drama/subtitle.mjs
// SRT 软字幕：从分镜 dialogue 派生 + 序列化（校对即编辑 dialogue，故无需解析回读）

export function formatSrtTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

// 由分镜派生字幕：仅取有台词镜，时间轴按 durationSec 顺序累计
export function deriveSubtitles(shots = []) {
  const entries = [];
  let cursor = 0;
  for (const shot of shots) {
    const dur = Number(shot?.durationSec) || 0;
    const text = String(shot?.dialogue || "").trim();
    if (text) entries.push({ shotId: shot.id, start: cursor, end: cursor + dur, text });
    cursor += dur;
  }
  return entries;
}

export function entriesToSrt(entries = []) {
  if (!entries.length) return "";
  return entries
    .map((e, i) => `${i + 1}\n${formatSrtTime(e.start)} --> ${formatSrtTime(e.end)}\n${String(e.text || "").trim()}`)
    .join("\n\n") + "\n";
}

// 整片 SRT：直接由分镜派生（校对后的 dialogue 即最新台词）
export function filmSrt(shots = []) {
  return entriesToSrt(deriveSubtitles(shots));
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-subtitle.test.mjs && npm run test:unit`
Expected: PASS；全量通过

- [ ] **Step 5: Commit**

```bash
git add lib/drama/subtitle.mjs tests/drama-subtitle.test.mjs
git commit -m "feat: SRT 软字幕派生与序列化（M5）"
```

---

### Task 3: ffmpeg.mjs（探测 + 命令构造 + 执行）

**Files:**
- Create: `lib/drama/ffmpeg.mjs`
- Test: `tests/drama-ffmpeg.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `detectFfmpeg({execImpl,env,platform})`→`{available,path,version}`；`runFfmpeg(args,{spawnImpl,ffmpegPath})`→Promise；`buildNormalizeArgs({clipPath,audioPath,output})`→string[]；`buildConcatArgs({listFile,output})`→string[]；`buildBgmArgs({filmPath,bgmPath,volume,output})`→string[]；`buildSubtitleArgs({filmPath,srtPath,output})`→string[]

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-ffmpeg.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { detectFfmpeg, runFfmpeg, buildNormalizeArgs, buildConcatArgs, buildBgmArgs, buildSubtitleArgs } from "../lib/drama/ffmpeg.mjs";

test("detectFfmpeg 命中系统 ffmpeg 返回 available", () => {
  const r = detectFfmpeg({ execImpl: () => "ffmpeg version 8.1.1 Copyright", env: {}, platform: "darwin" });
  assert.equal(r.available, true);
  assert.equal(r.version, "8.1.1");
});
test("detectFfmpeg 全部失败返回 unavailable", () => {
  const r = detectFfmpeg({ execImpl: () => { throw new Error("not found"); }, env: {}, platform: "darwin" });
  assert.equal(r.available, false);
  assert.equal(r.path, null);
});
test("detectFfmpeg 优先 FFMPEG_PATH", () => {
  const seen = [];
  detectFfmpeg({ execImpl: (cmd) => { seen.push(cmd); return "ffmpeg version 1.0"; }, env: { FFMPEG_PATH: "/custom/ffmpeg" }, platform: "linux" });
  assert.equal(seen[0], "/custom/ffmpeg");
});

test("runFfmpeg 成功 resolve、非零退出 reject", async () => {
  const okChild = () => { const e = new EventEmitter(); e.stderr = new EventEmitter(); process.nextTick(() => e.emit("close", 0)); return e; };
  await assert.doesNotReject(() => runFfmpeg(["-version"], { spawnImpl: okChild, ffmpegPath: "ffmpeg" }));
  const badChild = () => { const e = new EventEmitter(); e.stderr = new EventEmitter(); process.nextTick(() => { e.stderr.emit("data", "boom"); e.emit("close", 2); }); return e; };
  await assert.rejects(() => runFfmpeg(["x"], { spawnImpl: badChild, ffmpegPath: "ffmpeg" }), /退出码 2/);
});

test("buildNormalizeArgs 无配音时注入静音轨", () => {
  const a = buildNormalizeArgs({ clipPath: "c.mp4", audioPath: null, output: "o.mp4" });
  assert.ok(a.includes("anullsrc=r=44100:cl=mono"));
  assert.ok(a.includes("libx264") && a.includes("aac"));
});
test("buildNormalizeArgs 有配音时用第二输入", () => {
  const a = buildNormalizeArgs({ clipPath: "c.mp4", audioPath: "v.mp3", output: "o.mp4" });
  assert.deepEqual(a.slice(0, 5), ["-y", "-i", "c.mp4", "-i", "v.mp3"]);
});
test("buildConcatArgs 流拷贝拼接", () => {
  const a = buildConcatArgs({ listFile: "list.txt", output: "m.mp4" });
  assert.deepEqual(a, ["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "m.mp4"]);
});
test("buildBgmArgs 循环+闪避混音", () => {
  const a = buildBgmArgs({ filmPath: "m.mp4", bgmPath: "b.mp3", volume: 0.3, output: "o.mp4" });
  assert.ok(a.includes("-stream_loop") && a.join(" ").includes("sidechaincompress"));
  assert.ok(a.join(" ").includes("volume=0.3"));
});
test("buildSubtitleArgs 封装 mov_text 软字幕", () => {
  const a = buildSubtitleArgs({ filmPath: "m.mp4", srtPath: "f.srt", output: "o.mp4" });
  assert.ok(a.includes("mov_text") && a.includes("f.srt"));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-ffmpeg.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

新建 `lib/drama/ffmpeg.mjs`：

```js
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
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-ffmpeg.test.mjs && npm run test:unit`
Expected: PASS；全量通过

- [ ] **Step 5: Commit**

```bash
git add lib/drama/ffmpeg.mjs tests/drama-ffmpeg.test.mjs
git commit -m "feat: FFmpeg 探测与合成命令构造（M5）"
```

---

### Task 4: audio.mjs（TTS 配音）

**Files:**
- Create: `lib/drama/audio.mjs`
- Test: `tests/drama-audio.test.mjs`

**Interfaces:**
- Consumes: `normalizeAudio`（Task 1，来自 schema.mjs，本任务在 routes 用，不在此文件重复）
- Produces: `planVoiceShots(project)`→需配音的对白镜数组；`resolveShotVoice(character, findVoice)`→`null|{kind:"voicebox",profileId}|{kind:"elevenlabs",voiceId}`；`synthesizeShotVoice({voiceTarget,text,language,deps})`→`{bytes,provider}`；`deps={voiceboxUrl,elevenKey,fetchImpl,sleep}`

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-audio.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { planVoiceShots, resolveShotVoice, synthesizeShotVoice } from "../lib/drama/audio.mjs";

test("planVoiceShots 只取有台词且 audioMode=voice 的对白镜", () => {
  const project = { shots: [
    { id: "s1", shotType: "dialogue", audioMode: "voice", dialogue: "说", durationSec: 3 },
    { id: "s2", shotType: "dialogue", audioMode: "none", dialogue: "静音", durationSec: 3 },
    { id: "s3", shotType: "cinematic", audioMode: "voice", dialogue: "", durationSec: 3 },
    { id: "s4", shotType: "dialogue", audioMode: "voice", dialogue: "", durationSec: 3 }
  ]};
  assert.deepEqual(planVoiceShots(project).map((s) => s.id), ["s1"]);
});

test("resolveShotVoice 优先 voicebox，其次 elevenlabs，无音色返回 null", () => {
  const voices = [
    { id: "vb1", provider: "voicebox", profileId: "prof-1", ttsReady: true },
    { id: "el1", provider: "elevenlabs" }
  ];
  const findVoice = (id) => voices.find((v) => v.id === id) || null;
  assert.deepEqual(resolveShotVoice({ voiceId: "vb1" }, findVoice), { kind: "voicebox", profileId: "prof-1" });
  assert.deepEqual(resolveShotVoice({ voiceId: "el1" }, findVoice), { kind: "elevenlabs", voiceId: "el1" });
  assert.equal(resolveShotVoice({ voiceId: "nope" }, findVoice), null);
  assert.equal(resolveShotVoice({ voiceId: null }, findVoice), null);
});

test("synthesizeShotVoice voicebox 走 generate→history→audio", async () => {
  const big = Buffer.alloc(600, 1);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/generate")) return { json: async () => ({ id: "g1" }) };
    if (url.includes("/history/")) return { json: async () => ({ status: "completed" }) };
    if (url.includes("/audio/")) return { arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength) };
    throw new Error("unexpected " + url);
  };
  const out = await synthesizeShotVoice({ voiceTarget: { kind: "voicebox", profileId: "p" }, text: "台词", language: "zh", deps: { voiceboxUrl: "http://127.0.0.1:9", fetchImpl, sleep: async () => {} } });
  assert.equal(out.provider, "voicebox");
  assert.ok(out.bytes.length >= 500);
  assert.ok(calls[0].endsWith("/generate"));
});

test("synthesizeShotVoice 缺配置时报对应错误", async () => {
  await assert.rejects(
    synthesizeShotVoice({ voiceTarget: { kind: "voicebox", profileId: "p" }, text: "x", language: "zh", deps: { fetchImpl: fetch, sleep: async () => {} } }),
    /VOICEBOX|Voicebox/
  );
  await assert.rejects(
    synthesizeShotVoice({ voiceTarget: { kind: "elevenlabs", voiceId: "v" }, text: "x", language: "zh", deps: { fetchImpl: fetch, sleep: async () => {} } }),
    /ElevenLabs|ELEVENLABS/
  );
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-audio.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

新建 `lib/drama/audio.mjs`：

```js
// lib/drama/audio.mjs
// 对白镜 TTS 配音：Voicebox 本地（免费）优先，ElevenLabs（付费）备选；无 TTS 静默回退（不阻塞合成）

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 需要配音的对白镜：dialogue + audioMode=voice + 有台词 + 时长≥2s
export function planVoiceShots(project) {
  return (project?.shots || []).filter((s) =>
    s.shotType === "dialogue" && s.audioMode === "voice" && String(s.dialogue || "").trim() && (Number(s.durationSec) || 0) >= 2);
}

// 解析对白镜可用的 TTS：优先本地 Voicebox（profileId），其次 ElevenLabs（voice id）
export function resolveShotVoice(character, findVoice) {
  if (!character?.voiceId || typeof findVoice !== "function") return null;
  const voice = findVoice(character.voiceId);
  if (!voice) return null;
  if (voice.provider === "voicebox" && voice.profileId && voice.ttsReady !== false) {
    return { kind: "voicebox", profileId: voice.profileId };
  }
  if (voice.id) return { kind: "elevenlabs", voiceId: voice.id };
  return null;
}

async function synthesizeWithElevenlabs({ apiKey, voiceId, text, fetchImpl }) {
  const res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    signal: AbortSignal.timeout(60000),
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.55, similarity_boost: 0.78, style: 0.18, speed: 1 } })
  });
  if (!res.ok) throw Object.assign(new Error(`ElevenLabs 返回 ${res.status}`), { code: `ELEVENLABS_${res.status}` });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 500) throw Object.assign(new Error("配音音频为空"), { code: "VOICE_EMPTY" });
  return bytes;
}

async function synthesizeWithVoicebox({ serviceUrl, profileId, text, language, fetchImpl, sleep }) {
  const gen = await fetchImpl(`${serviceUrl}/generate`, {
    method: "POST", signal: AbortSignal.timeout(30000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, profile_id: profileId, language: language === "en" ? "en" : "zh", model_size: "1.7B" })
  });
  const created = await gen.json().catch(() => ({}));
  const id = created?.id;
  if (!id) throw Object.assign(new Error("Voicebox 未返回配音任务 id"), { code: "VOICEBOX_NO_ID" });
  let done = false;
  for (let attempt = 0; attempt < 120 && !done; attempt += 1) {
    const st = await (await fetchImpl(`${serviceUrl}/history/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) })).json().catch(() => ({}));
    if (["completed", "succeeded"].includes(st.status)) { done = true; break; }
    if (["failed", "cancelled", "canceled"].includes(st.status)) throw Object.assign(new Error(st.error || "Voicebox 配音失败"), { code: "VOICEBOX_FAILED" });
    await sleep(1500);
  }
  if (!done) throw Object.assign(new Error("Voicebox 配音超时"), { code: "VOICEBOX_TIMEOUT" });
  const audio = await fetchImpl(`${serviceUrl}/audio/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30000) });
  const bytes = Buffer.from(await audio.arrayBuffer());
  if (bytes.length < 500) throw Object.assign(new Error("配音音频为空"), { code: "VOICE_EMPTY" });
  return bytes;
}

// 统一入口：按 voiceTarget.kind 路由到对应 TTS
export async function synthesizeShotVoice({ voiceTarget, text, language = "zh", deps = {} }) {
  const fetchImpl = deps.fetchImpl || fetch;
  const sleep = deps.sleep || defaultSleep;
  if (voiceTarget?.kind === "voicebox") {
    if (!deps.voiceboxUrl) throw Object.assign(new Error("未连接本地 Voicebox 服务"), { code: "VOICEBOX_UNAVAILABLE" });
    const bytes = await synthesizeWithVoicebox({ serviceUrl: deps.voiceboxUrl, profileId: voiceTarget.profileId, text, language, fetchImpl, sleep });
    return { bytes, provider: "voicebox" };
  }
  if (voiceTarget?.kind === "elevenlabs") {
    if (!deps.elevenKey) throw Object.assign(new Error("未配置 ElevenLabs Key"), { code: "ELEVENLABS_KEY_MISSING" });
    const bytes = await synthesizeWithElevenlabs({ apiKey: deps.elevenKey, voiceId: voiceTarget.voiceId, text, fetchImpl });
    return { bytes, provider: "elevenlabs" };
  }
  throw Object.assign(new Error("该对白镜角色未绑定可用音色"), { code: "VOICE_UNAVAILABLE" });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-audio.test.mjs && npm run test:unit`
Expected: PASS；全量通过

- [ ] **Step 5: Commit**

```bash
git add lib/drama/audio.mjs tests/drama-audio.test.mjs
git commit -m "feat: 对白镜 TTS 配音（Voicebox 优先/ElevenLabs 备选）（M5）"
```

---

### Task 5: compose.mjs（合成编排）

**Files:**
- Create: `lib/drama/compose.mjs`
- Test: `tests/drama-compose.test.mjs`

**Interfaces:**
- Consumes: `ffmpeg.mjs` 的 `buildNormalizeArgs/buildConcatArgs/buildBgmArgs/buildSubtitleArgs`、`subtitle.mjs` 的 `filmSrt`
- Produces: `composeFilm(ctx, projectId)`→Promise（异步执行，经 `store.update` 落 `project.compose` 状态）；`ctx` 需含 `store`、`runFfmpeg(args)`（可注入，默认真跑）、`ffmpegPath`

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-compose.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeFilm } from "../lib/drama/compose.mjs";

function makeCtx(shots, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "drama-compose-"));
  mkdirSync(join(dir, "clips"), { recursive: true });
  for (const s of shots) writeFileSync(join(dir, "clips", s.clip.file), "fake");
  const project = { id: "drama-c", shots, bgm: null, compose: null, ...extra };
  const store = {
    dir: () => dir,
    get: () => project,
    update: (id, fn) => { fn(project); return project; }
  };
  const ran = [];
  const runFfmpeg = async (args) => { ran.push(args); };
  return { ctx: { store, runFfmpeg, ffmpegPath: "ffmpeg" }, project, dir, ran };
}

test("composeFilm 无 BGM 有台词：归一化+拼接+软字幕，产出 final.mp4", async () => {
  const shots = [{ id: "shot-1", dialogue: "台词", durationSec: 3, audioMode: "voice", audio: { status: "none" }, clip: { status: "confirmed", file: "shot-1-clip-1.mp4" } }];
  const { ctx, project, dir, ran } = makeCtx(shots);
  await composeFilm(ctx, "drama-c");
  assert.equal(project.compose.status, "succeeded");
  assert.equal(project.compose.file, "final.mp4");
  assert.equal(project.compose.srtFile, "film.srt");
  assert.ok(existsSync(join(dir, "compose", "film.srt")));
  // 归一化（无配音→静音轨）+ concat + 字幕 = 至少 3 次 ffmpeg
  assert.ok(ran.length >= 3);
  rmSync(dir, { recursive: true, force: true });
});

test("composeFilm 有 BGM：多一步混音", async () => {
  const shots = [{ id: "shot-1", dialogue: "", durationSec: 3, audioMode: "voice", audio: { status: "none" }, clip: { status: "confirmed", file: "shot-1-clip-1.mp4" } }];
  const { ctx, project, dir, ran } = makeCtx(shots, { bgm: { file: "bgm/song.mp3", name: "song", volume: 0.3 } });
  mkdirSync(join(dir, "bgm"), { recursive: true });
  writeFileSync(join(dir, "bgm", "song.mp3"), "fake");
  await composeFilm(ctx, "drama-c");
  assert.equal(project.compose.status, "succeeded");
  // 无台词 → 无字幕步；有 BGM → merged→with-bgm 作为最终
  assert.equal(project.compose.file, "with-bgm.mp4");
  assert.equal(project.compose.srtFile, null);
  assert.ok(ran.some((a) => a.join(" ").includes("sidechaincompress")));
  rmSync(dir, { recursive: true, force: true });
});

test("composeFilm 某次 ffmpeg 失败 → compose.status=failed 且不抛", async () => {
  const shots = [{ id: "shot-1", dialogue: "x", durationSec: 3, audioMode: "voice", audio: { status: "none" }, clip: { status: "confirmed", file: "shot-1-clip-1.mp4" } }];
  const { ctx, project, dir } = makeCtx(shots);
  ctx.runFfmpeg = async () => { throw Object.assign(new Error("FFmpeg 退出码 2"), { code: "FFMPEG_FAILED" }); };
  await composeFilm(ctx, "drama-c");
  assert.equal(project.compose.status, "failed");
  assert.equal(project.compose.error.code, "FFMPEG_FAILED");
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-compose.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

新建 `lib/drama/compose.mjs`：

```js
// lib/drama/compose.mjs
// 合成编排：逐镜归一化 → 拼接 → (可选)背景音乐混音 → (可选)软字幕封装 → 成片 final.mp4 + film.srt
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runFfmpeg, buildNormalizeArgs, buildConcatArgs, buildBgmArgs, buildSubtitleArgs } from "./ffmpeg.mjs";
import { filmSrt } from "./subtitle.mjs";

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
  const run = (args) => (ctx.runFfmpeg ? ctx.runFfmpeg(args) : runFfmpeg(args, { ffmpegPath: ctx.ffmpegPath || "ffmpeg" }));
  try {
    setCompose({ status: "running", error: null, startedAt: new Date().toISOString() });
    const dir = store.dir(projectId);
    const audioDir = join(dir, "audio");
    const composeDir = join(dir, "compose");
    mkdirSync(audioDir, { recursive: true });
    mkdirSync(composeDir, { recursive: true });

    // 1. 逐镜归一化（配音 ready 用配音，否则静音/原声由 anullsrc 兜底）
    const normFiles = [];
    for (const shot of project.shots) {
      const clipPath = join(dir, "clips", shot.clip.file);
      const voicePath = shot.audio?.status === "ready" && shot.audio.file ? join(audioDir, shot.audio.file) : null;
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

    setCompose({ status: "succeeded", file: current, srtFile, finishedAt: new Date().toISOString() });
  } catch (error) {
    setCompose({ status: "failed", error: { code: error.code || "COMPOSE_FAILED", message: safeMessage(error) }, finishedAt: new Date().toISOString() });
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-compose.test.mjs && npm run test:unit`
Expected: PASS；全量通过

- [ ] **Step 5: Commit**

```bash
git add lib/drama/compose.mjs tests/drama-compose.test.mjs
git commit -m "feat: 合成编排（归一化/拼接/混音/软字幕）（M5）"
```

---

### Task 6: routes（FFmpeg 状态 / 配音 / BGM / 合成端点）

**Files:**
- Modify: `lib/drama/routes.mjs`
- Test: `tests/drama-routes-compose.test.mjs`

**Interfaces:**
- Consumes: Task 1 schema（`normalizeAudio`/`normalizeBgm`）、Task 4 `audio.mjs`（`resolveShotVoice`/`synthesizeShotVoice`）、Task 5 `compose.mjs`（`composeFilm`）、`ffmpeg.mjs` 的 `detectFfmpeg`
- Produces: 端点 `GET /api/drama/projects/{id}/compose/ffmpeg`、`POST .../shots/{shotId}/voice`、`POST .../bgm`、`POST .../compose`；`generateShotVoice(ctx, projectId, shotId)` 执行器；`ctx` 新增 `ffmpegPath`、`audioDeps`（`{voiceboxUrl,elevenKey,fetchImpl,sleep}`）

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-routes-compose.test.mjs`（沿用既有 routes 测试的 mock envelope/sendJson/ctx 模式）：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createDramaProject, normalizeProject } from "../lib/drama/schema.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");

function mockRes() {
  const res = { statusCode: 0, body: null };
  res.sendJson = (status, body) => { res.statusCode = status; res.body = body; };
  return res;
}
function makeCtx(project, dir, over = {}) {
  const store = { dir: () => dir, get: () => project, list: () => [project], save: () => {}, update: (id, fn) => { fn(project); return project; } };
  return {
    sendJson: (res, s, b) => res.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store, comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {},
    ffmpegPath: "ffmpeg", audioDeps: { fetchImpl: fetch, sleep: async () => {} },
    ...over
  };
}
function clipsReady(dir, shots) {
  mkdirSync(join(dir, "clips"), { recursive: true });
  for (const s of shots) writeFileSync(join(dir, "clips", s.clip.file), "fake");
}

test("GET compose/ffmpeg：未配置时按注入探测返回 unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drama-rc-"));
  const project = normalizeProject(createDramaProject({ title: "t", script: "x".repeat(60) }));
  const ctx = makeCtx(project, dir, { detectFfmpeg: () => ({ available: false, path: null, version: null }) });
  const res = mockRes();
  const handled = await handleDramaApi({ method: "GET", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/compose/ffmpeg`), ctx);
  assert.equal(handled, undefined);
  assert.equal(res.body.data.available, false);
  rmSync(dir, { recursive: true, force: true });
});

test("POST compose：FFmpeg 不可用 → 503", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drama-rc-"));
  const shot = { id: "shot-1", index: 1, shotType: "cinematic", dialogue: "", durationSec: 3, audioMode: "voice", audio: { status: "none" }, clip: { status: "confirmed", file: "shot-1-clip-1.mp4" } };
  const project = normalizeProject(createDramaProject({ title: "t", script: "x".repeat(60) }));
  project.status = "clips_ready"; project.shots = [shot]; project.gateAConfirmedAt = "2026-01-01";
  clipsReady(dir, [shot]);
  const ctx = makeCtx(project, dir, { detectFfmpeg: () => ({ available: false, path: null, version: null }) });
  const res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: "{}" }, res, new URL(`http://x/api/drama/projects/${project.id}/compose`), ctx);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.errorCode, "FFMPEG_UNAVAILABLE");
  rmSync(dir, { recursive: true, force: true });
});

test("POST compose：有镜未 confirmed → 409", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drama-rc-"));
  const shot = { id: "shot-1", index: 1, shotType: "cinematic", dialogue: "", durationSec: 3, audioMode: "voice", audio: { status: "none" }, clip: { status: "ready", file: "shot-1-clip-1.mp4" } };
  const project = normalizeProject(createDramaProject({ title: "t", script: "x".repeat(60) }));
  project.status = "videos"; project.shots = [shot]; project.gateAConfirmedAt = "2026-01-01";
  const ctx = makeCtx(project, dir, { detectFfmpeg: () => ({ available: true, path: "ffmpeg", version: "8" }) });
  const res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: "{}" }, res, new URL(`http://x/api/drama/projects/${project.id}/compose`), ctx);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.errorCode, "CLIPS_NOT_READY");
  rmSync(dir, { recursive: true, force: true });
});

test("POST shots/{id}/voice：非对白镜或静音 → 422", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drama-rc-"));
  const shot = { id: "shot-1", index: 1, shotType: "cinematic", dialogue: "", durationSec: 3, audioMode: "voice", characterIds: [], audio: { status: "none" }, clip: { status: "confirmed", file: "c.mp4" } };
  const project = normalizeProject(createDramaProject({ title: "t", script: "x".repeat(60) }));
  project.shots = [shot];
  const ctx = makeCtx(project, dir);
  const res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: "{}" }, res, new URL(`http://x/api/drama/projects/${project.id}/shots/shot-1/voice`), ctx);
  assert.equal(res.statusCode, 422);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-routes-compose.test.mjs`
Expected: FAIL（404 / 端点不存在）

- [ ] **Step 3: 实现**

`lib/drama/routes.mjs`：
1. 顶部 import 追加：
```js
import { detectFfmpeg } from "./ffmpeg.mjs";
import { composeFilm } from "./compose.mjs";
import { resolveShotVoice, synthesizeShotVoice } from "./audio.mjs";
import { normalizeAudio, normalizeBgm } from "./schema.mjs"; // normalizeAudio/normalizeBgm 合并进既有 schema import 行
```
（既有 `from "./schema.mjs"` 的 import 行里合并加入 `normalizeAudio`、`normalizeBgm`。）

2. 在 `generateShotClip` 之后新增配音执行器：

```js
// 对白镜配音执行器：与 generateShotClip 同模式，直接更新分镜 audio 状态
export async function generateShotVoice(ctx, projectId, shotId) {
  const { store } = ctx;
  const setAudio = (patch) => store.update(projectId, (p) => {
    const shot = p.shots.find((s) => s.id === shotId);
    if (shot) shot.audio = { ...normalizeAudio(shot.audio), ...patch };
  });
  const project = store.get(projectId);
  const shot = project?.shots.find((s) => s.id === shotId);
  if (!shot) return;
  try {
    setAudio({ status: "generating", error: null });
    const character = project.analysis?.characters?.find((c) => c.id === shot.characterIds[0]);
    const target = resolveShotVoice(character, ctx.findVoice);
    if (!target) throw Object.assign(new Error("该对白镜角色未绑定可用音色"), { code: "VOICE_UNAVAILABLE" });
    const { bytes, provider } = await synthesizeShotVoice({ voiceTarget: target, text: shot.dialogue, language: "zh", deps: ctx.audioDeps || {} });
    mkdirSync(join(store.dir(projectId), "audio"), { recursive: true });
    const fileName = `${shotId}.mp3`;
    writeFileSync(join(store.dir(projectId), "audio", fileName), bytes);
    setAudio({ status: "ready", file: fileName, provider, error: null });
  } catch (error) {
    setAudio({ status: "failed", error: { code: error.code || "VOICE_FAILED", message: safeErrorMessage(error) } });
  }
}
```
并在文件顶部 `import { copyFileSync, readFileSync, writeFileSync }` 加入 `mkdirSync`。

3. 在 `handleDramaApi` 内、`video-confirm` 分支之后（`segments.length === 7` 区块之后）新增端点（均在 `segments.length >= 4 && segments[2] === "projects"` 块内）：

```js
    // FFmpeg 可用性探测（生成视图载入时调用）
    if (segments.length === 6 && segments[4] === "compose" && segments[5] === "ffmpeg" && request.method === "GET") {
      const detect = ctx.detectFfmpeg || (() => detectFfmpeg({ env: process.env }));
      return sendJson(response, 200, envelope(true, detect(), { requestId }));
    }

    // 对白镜配音（单镜手动/批量复用）
    if (segments.length === 7 && segments[4] === "shots" && segments[6] === "voice" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      const shot = project.shots.find((s) => s.id === segments[5]);
      if (!shot) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_SHOT_NOT_FOUND", message: "分镜不存在" }));
      if (shot.shotType !== "dialogue" || shot.audioMode !== "voice" || !String(shot.dialogue || "").trim()) {
        return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "VOICE_NOT_APPLICABLE", message: "仅对白镜（配音模式且有台词）可生成配音" }));
      }
      if (normalizeAudio(shot.audio).status === "generating") {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "VOICE_BUSY", message: "该分镜正在生成配音" }));
      }
      generateShotVoice(ctx, projectId, shot.id).catch(() => {});
      return sendJson(response, 202, envelope(true, { shotId: shot.id, status: "generating" }, { requestId }));
    }

    // 上传背景音乐（base64 data URL，mp3/wav/m4a，≤20MB）
    if (segments.length === 5 && segments[4] === "bgm" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      let payload;
      try { payload = await readJson(request, 30_000_000); } catch (error) {
        return sendJson(response, 400, envelope(false, null, { requestId, errorCode: error.message, message: "音频内容无效或过大" }));
      }
      const match = String(payload.audioData || "").match(/^data:audio\/(mpeg|mp3|wav|m4a|x-m4a);base64,([A-Za-z0-9+/=]+)$/);
      if (!match) return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "AUDIO_FORMAT_INVALID", message: "仅支持 MP3 / WAV / M4A 音频" }));
      const ext = match[1] === "mpeg" ? "mp3" : match[1] === "x-m4a" ? "m4a" : match[1];
      const bytes = Buffer.from(match[2], "base64");
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) return sendJson(response, 413, envelope(false, null, { requestId, errorCode: "AUDIO_TOO_LARGE", message: "音频不能超过 20MB" }));
      mkdirSync(join(store.dir(projectId), "bgm"), { recursive: true });
      writeFileSync(join(store.dir(projectId), "bgm", `bgm.${ext}`), bytes);
      const updated = store.update(projectId, (p) => {
        p.bgm = normalizeBgm({ file: `bgm/bgm.${ext}`, name: String(payload.name || "背景音乐"), volume: payload.volume });
        if (p.compose?.status === "succeeded") p.compose = { ...p.compose, status: "idle", file: null, srtFile: null }; // 换 BGM 使旧成片失效
      });
      return sendJson(response, 201, envelope(true, { project: updated }, { requestId }));
    }

    // 触发合成（异步，轮询 project.compose 状态）
    if (segments.length === 5 && segments[4] === "compose" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      const detect = ctx.detectFfmpeg || (() => detectFfmpeg({ env: process.env }));
      if (!detect().available) return sendJson(response, 503, envelope(false, null, { requestId, errorCode: "FFMPEG_UNAVAILABLE", message: "未检测到本机 FFmpeg，请先安装（如 brew install ffmpeg）" }));
      const notReady = project.shots.filter((s) => s.clip?.status !== "confirmed" || !s.clip?.file);
      if (notReady.length) return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "CLIPS_NOT_READY", message: `还有 ${notReady.length} 个分镜视频未确认（${notReady.map((s) => `镜${s.index}`).join("、")}）` }));
      if (!project.shots.length) return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "NO_SHOTS", message: "没有可合成的分镜" }));
      if (project.compose?.status === "running") return sendJson(response, 200, envelope(true, { reused: true }, { requestId }));
      composeFilm(ctx, projectId).catch(() => {});
      return sendJson(response, 202, envelope(true, { projectId, status: "running" }, { requestId }));
    }
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-routes-compose.test.mjs && npm run test:unit`
Expected: PASS；全量通过

- [ ] **Step 5: Commit**

```bash
git add lib/drama/routes.mjs tests/drama-routes-compose.test.mjs
git commit -m "feat: FFmpeg 探测/配音/BGM/合成端点（M5）"
```

---

### Task 7: server.mjs 静态服务扩展 + ctx 接线 + smoke 守卫

**Files:**
- Modify: `server.mjs`
- Modify: `scripts/smoke.mjs`
- Test: `scripts/smoke.mjs`（行为守卫）

**Interfaces:**
- Consumes: Task 6 的端点所需 ctx 字段
- Produces: `/drama-files/{id}/[frames|clips|audio|compose/]{file}` 静态服务（含 mp3/wav/m4a/srt/compose 的 mp4）；`handleDramaApi` 的 ctx 新增 `detectFfmpeg`、`ffmpegPath`、`audioDeps`

- [ ] **Step 1: 扩展静态服务**

`server.mjs` 的 `serveStatic` 中，把现有 `dramaFileMatch` 正则与处理替换为支持可选子目录、并覆盖音频/字幕/合成产物：

```js
  const dramaFileMatch = pathname.match(/^\/drama-files\/(drama-[a-f0-9-]+)\/(?:(frames|clips|audio|compose|bgm)\/)?([a-z0-9-]+\.(png|jpg|webp|mp4|webm|mp3|wav|m4a|srt))$/i);
  if (dramaFileMatch) {
    const [, id, sub, file] = dramaFileMatch;
    // 兼容旧两段式（无子目录）：按扩展名推断 frames/clips；新三段式用显式子目录
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
```

并在 `contentTypes` 中补充：`".srt": "application/x-subrip; charset=utf-8",` 与 `".m4a": "audio/mp4",`（mp3/wav/mp4 已有）。

- [ ] **Step 2: ctx 接线**

`server.mjs` 的 `handleDramaApi(...)` 调用处（`if (url.pathname.startsWith("/api/drama/"))`）的 ctx 对象追加三个字段：

```js
      detectFfmpeg: () => detectFfmpeg({ env: process.env }),
      ffmpegPath: detectFfmpeg({ env: process.env }).path || "ffmpeg",
      audioDeps: { voiceboxUrl: discoverVoiceboxServiceUrl(), elevenKey, findVoice: seedanceAccessors.findVoice },
```

并在文件顶部 `import { getDramaPricing } ...` 附近加入：
```js
import { detectFfmpeg } from "./lib/drama/ffmpeg.mjs";
```
注意：`audioDeps` 还需 `fetchImpl`/`sleep`，在 routes/audio 内有默认值（`deps.fetchImpl || fetch`、`deps.sleep || defaultSleep`），故 ctx 可省略；`voiceboxUrl` 用既有 `discoverVoiceboxServiceUrl()`（本服务内已定义）。

- [ ] **Step 3: smoke 守卫**

`scripts/smoke.mjs`：在短剧链路断言之后、收尾 `console.log` 之前追加（干净环境无 FFmpeg 时的合成守卫 + 探测端点脱敏）：

```js
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
```

并在 `console.log(JSON.stringify({...}))` 的对象里加一行 `composeGuard: composeBody.errorCode,`。

注意：smoke 启动子进程的环境未设 `FFMPEG_PATH`，且 CI 干净环境可能无系统 ffmpeg——两种 errorCode 都接受。但若本机恰好有 ffmpeg，则 `FFMPEG_UNAVAILABLE` 不出现、走 `CLIPS_NOT_READY`（此时分镜视频均未生成确认，必然 409），断言仍成立。

- [ ] **Step 4: 运行验证**

Run: `npm run check && npm run smoke`
Expected: `check` 通过；smoke 退出码 0 且输出含 `composeGuard`

- [ ] **Step 5: Commit**

```bash
git add server.mjs scripts/smoke.mjs
git commit -m "feat: 合成产物静态服务与 ctx 接线，冒烟合成守卫（M5）"
```

---

### Task 8: drama.html 生成视图合成面板骨架

**Files:**
- Modify: `public/drama.html`
- Modify: `public/drama.css`
- Modify: `public/drama.js`

**Interfaces:**
- Consumes: 现有 `#viewGenerate`、`#budgetLines/#budgetTotal/#gateABtn`、`#gateBProgress/.../#genAllFramesBtn`
- Produces: 生成视图新增容器 ID（供 Task 9 挂载）：`#ffmpegBanner`、`#composeCard`、`#composeStatus`、`#composeBtn`、`#composePreview`、`#exportBar`、`#exportMp4`、`#exportSrt`、`#subtitleCard`、`#subtitleList`、`#bgmCard`、`#bgmName`、`#bgmFile`、`#bgmVolume`、`#bgmClear`

- [ ] **Step 1: 替换生成视图内容**

`public/drama.html` 中，把 `<section class="vz-view" id="viewGenerate">` 现有三张卡（`#ffmpegPlaceholder` 占位卡、预算卡、闸门卡）整体替换为下列结构（保留预算卡与闸门卡原 ID 与类不变，仅前置合成区）：

```html
      <!-- 生成视图（合成导出） -->
      <section class="vz-view" id="viewGenerate">
        <div class="vz-banner warn hidden" id="ffmpegBanner">⚠ 未检测到本机 FFmpeg，无法合成成片。请先安装（macOS：<code>brew install ffmpeg</code>），字幕校对与分镜编辑不受影响。</div>

        <section class="vz-card" id="composeCard">
          <div class="vz-chead"><span class="eyebrow">COMPOSE</span><h2>合成成片</h2></div>
          <div class="vz-sub" id="composeStatus">尚未合成</div>
          <div class="vz-rowline" style="margin-top:8px">
            <button class="vz-apply" id="composeBtn">⚙ 合成成片</button>
          </div>
          <div id="composePreview" style="margin-top:10px"></div>
          <div class="vz-rowline" id="exportBar" style="margin-top:8px">
            <a class="vz-ghost hidden" id="exportMp4" download>导出 MP4</a>
            <a class="vz-ghost hidden" id="exportSrt" download>导出 SRT</a>
          </div>
        </section>

        <section class="vz-card" id="subtitleCard">
          <div class="vz-chead"><span class="eyebrow">SUBTITLES</span><h2>字幕校对</h2></div>
          <div class="vz-sub">编辑台词文本即更新字幕；时间轴按各镜时长自动累计。</div>
          <div id="subtitleList" style="margin-top:8px"></div>
        </section>

        <section class="vz-card" id="bgmCard">
          <div class="vz-chead"><span class="eyebrow">MUSIC</span><h2>背景音乐</h2></div>
          <div class="vz-rowline">
            <input id="bgmFile" type="file" accept="audio/mpeg,audio/mp3,audio/wav,audio/m4a" hidden />
            <button class="vz-ghost" id="bgmPick">选择音频…</button>
            <span class="vz-sub" id="bgmName">未设置</span>
            <button class="vz-ghost hidden" id="bgmClear">移除</button>
          </div>
          <div class="vz-field"><label>音量 <span id="bgmVolumeVal">30%</span></label><input id="bgmVolume" type="range" min="0" max="100" value="30" /></div>
        </section>

        <section class="vz-card">
          <div class="vz-chead"><span class="eyebrow">BUDGET</span><h2>预算单（预估）</h2></div>
          <div id="budgetLines"></div>
          <div class="vz-btotal"><span>预计付费合计</span><b id="budgetTotal">—</b></div>
          <button class="vz-apply hidden" id="gateABtn">确认预算，进入首帧生成</button>
          <div class="vz-sub" style="margin-top:6px">首帧使用本机算力（¥0）；视频与配音单价为预估值，以供应商扣费为准。</div>
        </section>

        <section class="vz-card">
          <div class="vz-chead"><span class="eyebrow">GATE B</span><h2>首帧与视频确认</h2></div>
          <div class="vz-rowline"><span class="vz-sub">首帧</span><div class="vz-progress"><i id="gateBProgress"></i></div><span class="vz-sub" id="gateBText">0/0</span></div>
          <div class="vz-rowline" style="margin-top:6px"><span class="vz-sub">视频</span><div class="vz-progress"><i id="clipProgress"></i></div><span class="vz-sub" id="clipText">0/0</span></div>
          <div class="vz-banner ok hidden" id="doneBanner">全部确认完成。时间线合成导出属于后续里程碑（M5）。</div>
          <button class="vz-ghost hidden" id="genAllFramesBtn">生成全部首帧</button>
        </section>
      </section>
```

说明：新增 `bgmPick`（触发 `#bgmFile` 选择）；`vz-ghost`/`vz-sub`/`vz-field`/`vz-rowline`/`vz-banner`/`vz-card`/`vz-chead`/`vz-progress`/`vz-apply` 等类在 Task 3 的 drama.css 已存在或本任务 Step 2 补充。

- [ ] **Step 2: 补充缺失样式**

`public/drama.css` 末尾追加（若已有同名类则跳过）：

```css
.vz-ghost { background: #fff; border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; font-size: 12px; font-weight: 600; color: var(--text); cursor: pointer; text-decoration: none; display: inline-block; }
.vz-ghost:hover { background: var(--soft); }
.vz-field input[type="range"] { width: 100%; accent-color: var(--primary); }
.vz-banner code { background: var(--soft); padding: 1px 5px; border-radius: 5px; font-size: 11px; }
#composePreview video, #composePreview img { width: 100%; max-height: 320px; border-radius: 10px; background: #000; }
.vz-sub-row { display: flex; gap: 8px; align-items: center; padding: 8px; border: 1px solid var(--border); border-radius: 10px; margin-top: 6px; }
.vz-sub-row .tm { font: 10px "DM Mono", monospace; color: var(--muted); white-space: nowrap; }
.vz-sub-row input { flex: 1; border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; font-size: 12px; }
.vz-strip-add { flex: 0 0 72px; aspect-ratio: 9/14; border: 1px dashed var(--border); border-radius: 10px; background: var(--soft); color: var(--muted); font-size: 22px; cursor: pointer; }
```

- [ ] **Step 3: 最小化 renderGenerate，消除悬空引用**

`public/drama.js`：现有 `renderGenerate` 引用了本任务已删除的 `#ffmpegPlaceholder`，切到生成视图会抛 `null` 错误。本步先把 `renderGenerate` 改为最小可用版本（合成/字幕/BGM 卡片为静态 HTML，Task 9 再接线交互）：

```js
function renderGenerate(project) {
  renderBudget(project);
  renderGateB(project);
}
```

- [ ] **Step 4: 校验 + Commit**

Run: `npm run check`
然后：
```bash
git add public/drama.html public/drama.css public/drama.js
git commit -m "feat: 生成视图合成导出面板骨架（M5）"
```

---

### Task 9: drama.js 生成视图重写 + 配音/BGM/合成动作层

**Files:**
- Modify: `public/drama.js`

**Interfaces:**
- Consumes: 既有 `api/toast/showError/schedulePoll/setView/renderBudget/renderGateB`、Task 6/7 端点、`state.project`
- Produces: 重写 `renderGenerate(project)`；新增动作 `loadFfmpegStatus()`、`startCompose()`、`renderCompose(project)`、`renderSubtitleEditor(project)`、`uploadBgm(file)`、`clearBgm()`、`generateVoice(shotId)`、`generateAllVoices()`；初始化/事件绑定接线

- [ ] **Step 1: 重写 renderGenerate 并新增渲染函数**

`public/drama.js`：把 Task 8 留下的最小 `renderGenerate`（仅 `renderBudget` + `renderGateB`）替换为下列完整实现；`renderBudget(project)`、`renderGateB(project)` 为既有保留函数，调用不变。

```js
// ===== 生成视图（M5 合成导出） =====
let ffmpegAvailable = null;

async function loadFfmpegStatus() {
  if (!state.project) { ffmpegAvailable = null; return null; }
  try {
    const { data } = await api(`/api/drama/projects/${state.project.id}/compose/ffmpeg`);
    ffmpegAvailable = Boolean(data.available);
  } catch { ffmpegAvailable = false; }
  return ffmpegAvailable;
}

function renderGenerate(project) {
  renderCompose(project);
  renderSubtitleEditor(project);
  renderBgm(project);
  renderBudget(project);
  renderGateB(project);
}

function renderCompose(project) {
  const banner = $("#ffmpegBanner");
  banner.classList.toggle("hidden", ffmpegAvailable !== false);
  const status = $("#composeStatus");
  const compose = project?.compose || { status: "idle" };
  const notReady = (project?.shots || []).filter((s) => s.clip?.status !== "confirmed");
  const btn = $("#composeBtn");
  btn.disabled = !project || ffmpegAvailable === false || compose.status === "running" || notReady.length > 0;
  if (!project) status.textContent = "尚未合成";
  else if (compose.status === "running") status.textContent = "正在合成…";
  else if (compose.status === "succeeded") status.textContent = "已合成，可预览导出";
  else if (compose.status === "failed") status.textContent = `合成失败：${compose.error?.message || "未知错误"}（可重试）`;
  else status.textContent = notReady.length ? `还有 ${notReady.length} 个分镜视频未确认` : "就绪，可合成";

  const preview = $("#composePreview");
  preview.innerHTML = "";
  const mp4 = $("#exportMp4"); const srt = $("#exportSrt");
  if (compose.status === "succeeded" && compose.file) {
    const v = document.createElement("video");
    v.controls = true;
    v.src = `/drama-files/${project.id}/compose/${compose.file}`;
    preview.appendChild(v);
    mp4.href = v.src; mp4.classList.remove("hidden");
    if (compose.srtFile) { srt.href = `/drama-files/${project.id}/compose/${compose.srtFile}`; srt.classList.remove("hidden"); }
    else srt.classList.add("hidden");
  } else {
    mp4.classList.add("hidden"); srt.classList.add("hidden");
  }
}

function renderSubtitleEditor(project) {
  const box = $("#subtitleList");
  box.innerHTML = "";
  const talkShots = (project?.shots || []).filter((s) => String(s.dialogue || "").trim());
  if (!talkShots.length) { box.innerHTML = `<div class="vz-sub">暂无台词分镜</div>`; return; }
  let cursor = 0;
  for (const shot of project.shots) {
    const dur = Number(shot.durationSec) || 0;
    if (String(shot.dialogue || "").trim()) {
      const row = document.createElement("div");
      row.className = "vz-sub-row";
      const tm = document.createElement("span"); tm.className = "tm"; tm.textContent = `镜${shot.index} · ${cursor}s–${cursor + dur}s`;
      const input = document.createElement("input"); input.value = shot.dialogue; input.maxLength = 600;
      input.addEventListener("change", () => saveShot(shot.id, { dialogue: input.value }));
      row.append(tm, input);
      box.appendChild(row);
    }
    cursor += dur;
  }
}

function renderBgm(project) {
  const name = $("#bgmName"); const clear = $("#bgmClear"); const vol = $("#bgmVolume"); const volVal = $("#bgmVolumeVal");
  const bgm = project?.bgm || null;
  name.textContent = bgm ? bgm.name : "未设置";
  clear.classList.toggle("hidden", !bgm);
  const pct = Math.round((bgm?.volume ?? 0.3) * 100);
  vol.value = pct; volVal.textContent = `${pct}%`;
}
```

- [ ] **Step 2: 新增动作函数**

在 `confirmGateA` 附近（动作层区域）新增：

```js
async function startCompose() {
  if (!state.project) return;
  try {
    await api(`/api/drama/projects/${state.project.id}/compose`, { method: "POST", body: "{}" });
    toast("已开始合成", "正在拼接分镜、混音与封装字幕");
    schedulePoll();
  } catch (error) { showError(error); }
}

async function generateVoice(shotId) {
  if (!state.project) return;
  try {
    await api(`/api/drama/projects/${state.project.id}/shots/${shotId}/voice`, { method: "POST", body: "{}" });
    toast("已开始生成配音", "完成后可在合成时使用");
    schedulePoll();
  } catch (error) { showError(error); }
}

async function generateAllVoices() {
  const project = state.project;
  if (!project) return;
  const targets = project.shots.filter((s) => s.shotType === "dialogue" && s.audioMode === "voice" && String(s.dialogue || "").trim() && s.audio?.status !== "ready");
  for (const s of targets) { /* 串行，避免并发压限 */ await api(`/api/drama/projects/${project.id}/shots/${s.id}/voice`, { method: "POST", body: "{}" }).catch(() => {}); }
  if (targets.length) { toast("已排队生成配音", `${targets.length} 个对白镜`); schedulePoll(); }
}

async function uploadBgm(file) {
  if (!state.project || !file) return;
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  try {
    const { data } = await api(`/api/drama/projects/${state.project.id}/bgm`, {
      method: "POST", body: JSON.stringify({ name: file.name.replace(/\.[^.]+$/, ""), audioData: dataUrl, volume: Number($("#bgmVolume").value) / 100 })
    });
    state.project = data.project;
    renderGenerate(state.project);
    toast("背景音乐已设置", "合成时将混入并闪避到台词下");
  } catch (error) { showError(error); }
}

async function clearBgm() {
  if (!state.project) return;
  try {
    const { data } = await api(`/api/drama/projects/${state.project.id}/bgm`, { method: "POST", body: JSON.stringify({ audioData: "", name: "" }) }).catch(() => ({ data: null }));
    // 服务端不接受空音频：改用下方 removeBgm
  } catch {}
}
```

说明：`clearBgm` 需要服务端支持移除。简化为前端只允许「更换」BGM；移除通过上传新文件覆盖即可。删除 `clearBgm` 与 `#bgmClear` 的移除逻辑，改为点击重新选择覆盖（`#bgmClear` 按钮在 Task 8 已加 hidden，本任务不实现移除，保持 hidden）。

修正：删除上面的 `clearBgm`，`#bgmClear` 保持隐藏不接线（M5 不支持移除，仅覆盖）。

- [ ] **Step 3: 事件绑定与初始化接线**

在 `bindEvents`（或既有事件绑定区）追加：

```js
  $("#composeBtn").addEventListener("click", startCompose);
  $("#bgmPick").addEventListener("click", () => $("#bgmFile").click());
  $("#bgmFile").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) uploadBgm(f); e.target.value = ""; });
  $("#bgmVolume").addEventListener("change", (e) => { $("#bgmVolumeVal").textContent = `${e.target.value}%`; if (state.project?.bgm) toast("音量将在下次合成时生效", "重新合成以应用"); });
```

在 `init`（或项目载入完成处）切到生成视图时加载 FFmpeg 状态：在 `setView` 的 `if (view === "generate")` 分支（若无则在 `renderProject`/`renderGenerate` 首次调用处）加：

```js
  if (state.project && ffmpegAvailable === null) loadFfmpegStatus().then(() => { if (state.view === "generate") renderGenerate(state.project); });
```

- [ ] **Step 4: 校验 + Commit**

Run: `npm run check && npm run test:unit && npm run smoke`
Expected: 全通过
```bash
git add public/drama.js
git commit -m "feat: 生成视图合成导出与配音/字幕/BGM 动作层（M5）"
```

---

### Task 10: strip 配音徽标 + 预览字幕开关 + 验证收尾

**Files:**
- Modify: `public/drama.js`
- Modify: `public/drama.html`（预览区加字幕开关）
- Modify: `public/drama.css`（字幕预览样式）
- Modify: `package.json`（check 增加新 lib 文件）

**Interfaces:**
- Consumes: `renderStrip`、`renderPreview`、`currentShot`
- Produces: strip 对白镜配音状态徽标；预览区「字幕」开关（显示当前镜台词字幕）

- [ ] **Step 1: strip 配音徽标**

`renderStrip` 中，对白镜缩略图的 `.vz-bdg` 之后追加配音状态角标（在 `if (shot.shotType === "dialogue")` 块内、`bdg` 之后）：

```js
      const audio = shot.audio || {};
      const vb = document.createElement("span");
      vb.className = "vz-voice";
      vb.textContent = audio.status === "ready" ? "🎙" : audio.status === "generating" ? "…" : shot.audioMode === "none" ? "🔇" : "";
      if (vb.textContent) th.appendChild(vb);
```

- [ ] **Step 2: 预览字幕开关**

`public/drama.html` 分镜视图 `#preview` 内、`.vz-tag` 之后加：
```html
          <button class="vz-subs-toggle on" id="subsToggle" title="字幕">字幕</button>
```
`public/drama.css` 末尾加：
```css
.vz-subs-toggle { position: absolute; top: 10px; right: 12px; z-index: 2; background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 3px 8px; font-size: 11px; color: var(--muted); cursor: pointer; }
.vz-subs-toggle.on { color: var(--text); border-color: var(--primary); }
.vz-stage .cap.hidden { display: none; }
```
`renderPreview` 在设置 `.cap.textContent` 后，根据 `state.showSubs !== false` 切换 `.cap` 的 `hidden`；并在事件绑定加：
```js
  $("#subsToggle").addEventListener("click", () => {
    state.showSubs = state.showSubs === false;
    $("#subsToggle").classList.toggle("on", state.showSubs !== false);
    if (state.project) renderPreview(state.project);
  });
```
（`renderPreview` 现有创建 `.cap` 的逻辑保留；本步在其末尾加 `cap.classList.toggle("hidden", state.showSubs === false)`。需在 state 初始化加 `showSubs: true`。）

- [ ] **Step 3: package.json check 增加新文件**

`package.json` 的 `check` 脚本中，在 `node --check lib/drama/routes.mjs` 之后追加 `&& node --check lib/drama/subtitle.mjs && node --check lib/drama/ffmpeg.mjs && node --check lib/drama/audio.mjs && node --check lib/drama/compose.mjs`。

- [ ] **Step 4: 全量验证 + 手动冒烟**

Run: `npm run check && npm run test:unit && npm run smoke`
Expected: 全通过；smoke 输出含 `composeGuard`
手动（可选）：`npm start` 起服务，生成视图可见 FFmpeg 状态、字幕校对、BGM、合成按钮。

- [ ] **Step 5: Commit**

```bash
git add public/drama.js public/drama.html public/drama.css package.json
git commit -m "feat: 分镜配音徽标与预览字幕开关（M5 收尾）"
```

---

## Self-Review 记录

- **Spec coverage**：FFmpeg 探测(T3/T6/T7)、TTS 配音(T4/T6)、字幕派生+校对(T2/T5/T9，校对=编辑 dialogue)、BGM 混音(T3/T6/T9)、FFmpeg 合成导出(T3/T5/T6/T9)、失败定位重试(T5/T6/T9)、生成视图 UI(T8/T9/T10)——均有对应任务。
- **Placeholder scan**：无 TBD/TODO；代码块均为完整实现。
- **Type consistency**：`normalizeAudio/normalizeBgm/normalizeCompose`(T1) → routes/compose 引用一致；`deriveSubtitles/entriesToSrt/filmSrt`(T2) → compose 引用一致；`build*Args/runFfmpeg/detectFfmpeg`(T3) → compose/routes/server 引用一致；`resolveShotVoice/synthesizeShotVoice/planVoiceShots`(T4) → routes 引用一致；`composeFilm`(T5) → routes 引用一致。端点路径与前端 `api()` 调用一致。
- **已知偏差/简化**：字幕校对复用「编辑 dialogue」（遵循 spec 的「校对即编辑文本（回写该镜 dialogue）」），故不设独立 `shot.subtitles` 字段与保存端点；BGM 不支持「移除」，仅覆盖（YAGNI）。这两点已在对应任务内注明。
