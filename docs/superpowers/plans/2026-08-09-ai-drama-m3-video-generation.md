# AI 短剧工作台 M3（视频生成与角色资产绑定）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已合并的 M1+M2（文本管线 + 首帧管线）之上，为短剧工作台增加逐镜视频生成：口播镜复用 Seedance（角色形象+音色绑定），剧情镜经 ComfyUI 工作流模板做图生视频（MiniMax H3 等），分镜获得 clip 状态机，全部视频确认后项目到达 `clips_ready`。

**Architecture:** 三个原则——(1) **抽取不复制**：把 server.mjs 的 Seedance 机制（参考下载/形象解析/音色解析/提示词/子进程编排）抽为 `lib/seedance.mjs`，口播页行为保持逐字节等价，短剧复用同一实现。(2) **模板不臆造**：剧情镜视频工作流来自用户从 ComfyUI 导出的 API 格式 JSON 模板文件，程序只做占位符注入（`{{PROMPT}}/{{IMAGE}}/{{SEED}}/{{WIDTH}}/{{HEIGHT}}/{{FPS}}/{{FRAMES}}`），不硬编码任何 H3 节点 schema——调研证实 ComfyUI 已有 H3 原生/社区节点，但节点类名随安装版本变化。(3) **费用纪律升级**：闸门 A 预算覆盖首轮全部视频；重新生成已就绪的 clip 需要逐镜二次 `confirmCost`；失败不自动重试。

**Tech Stack:** Node.js 20+（ESM）、内置 `node:test`、原生 fetch/FormData/Blob（ComfyUI multipart 上传）、现有 server.mjs / lib/drama/* / public/drama.*。

## Global Constraints

- **零新 npm 依赖** — Node 20 标准库；package.json dependencies 不变。
- **`npm test` 必须零费用** — 纯净环境全部测试通过；Seedance 未配置 → 503 短路；ComfyUI 视频模板缺失 → 503 短路；单测用伪 runner 夹具与注入式 fake fetch，绝不触达真实供应商。
- **隐私边界** — 任何 API 响应不得包含密钥值或本机绝对路径；`config/drama-video-workflow.json`（用户私有工作流）必须加入 `.gitignore`；`data/drama-projects/` 已在忽略内。
- **CI 密钥扫描红线** — 代码与文档中不得出现本机用户目录绝对路径、GitHub Token、`sk-` 后接 20+ 字符等模式（示例密钥用 `sk-your-key` 这类短占位）。
- **中文注释、英文标识符、中文提交信息** `类型: 简短描述`；每任务一次 commit。
- **不破坏现有功能** — 口播页（index.html）与 `/api/tasks` 的 final_video 行为（进度数值、result 形状、错误码）必须与重构前一致；现有 smoke 断言全部保持。
- **复用现有模式** — envelope/sendJson/readJson/allowRequest、`409 COST_CONFIRMATION_REQUIRED`、`{ configured, connected, state }` 健康形态、`setFrame` 式 store.update 状态机、失败不自动付费重试。
- **测试命令** — `node --test tests/*.test.mjs`（glob 形式，M1 已裁决）。

## 数据模型变更速览

```
Character 增加: voiceId: string|null        // 口播镜配音绑定（本地/自定义音色）
Shot 增加:     clip: { status: "pending"|"generating"|"ready"|"confirmed"|"failed",
                       file: string|null, provider: "seedance2"|"comfyui"|null,
                       providerTaskId: string|null, durationSec: number, attempts: number,
                       error: null|{ code, message } }
Project.status 增加两个值: "videos"（有镜在生成或部分就绪） | "clips_ready"（全部确认，M3 终态）
预算: 移除 tts 行（M3 决策：Seedance/H3 均原生出声，流程内不再单独调用 TTS 供应商）
```

## 关键设计裁决（计划级，执行者无需再决策）

1. **口播镜时长**：Seedance runner 按档位取 `seedanceDurationTier(sec) = sec<=5 ? 5 : sec<=10 ? 10 : 15`（对应 2-15s 分镜向上取档）。
2. **口播镜不需要首帧**：视频前置条件按类型分流——口播镜要角色绑定（avatarId+voiceId）+ 台词非空；剧情镜要首帧 confirmed + 视频模板已配置。
3. **重新生成收费守卫**：`clip.status` 为 ready/confirmed 时再点生成，必须带 `confirmCost: true`，否则 409 `COST_CONFIRMATION_REQUIRED`（"重新生成将产生额外费用"）。
4. **绑定变更作废 clip**：角色换绑形象/音色后，其出演的口播镜 clip 若 ready/confirmed 则重置为 pending（与 prompt 变更重置 frame 同一纪律）；`clips_ready` 回退 `videos`。
5. **服务重启孤儿态**：store 磁盘加载时 `clip.generating → failed`（code `CLIP_INTERRUPTED`），与 M1 末审的 frame 归置同构。
6. **视频模板加载**：每请求懒加载（`existsSync` + 读文件），允许服务运行期间放入模板；文件缺失即未配置。
7. **不提供"生成全部视频"按钮** — 视频逐镜付费，逐镜点击即费用纪律；首帧的 genAll 保留（本机免费）。

---

### Task 1: Seedance 机制抽取为 lib/seedance.mjs（口播行为零变化）

**Files:**
- Create: `lib/seedance.mjs`
- Create: `tests/fixtures/fake-seedance-runner.mjs`
- Test: `tests/drama-seedance.test.mjs`
- Modify: `server.mjs`（删除被抽取的函数，改为 import + 薄封装）
- Modify: `package.json`（check 追加 `lib/seedance.mjs` 与夹具）

**Interfaces:**
- Consumes: server.mjs 现有私有函数 `downloadReference/resolveSeedanceVoice/buildSeedancePrompt/generateSeedanceVideo`（server.mjs:525-747 区域）、`avatarById/trustedUploadPath/loadLocalVoices/loadCustomVoices`。
- Produces:
  - `downloadReference(url, runDir, stem, kind) → Promise<path>`（从 server.mjs 原样迁移）
  - `resolveSeedanceAvatar(payload, runDir, accessors) → Promise<{ avatar, path }>`（accessors: `{ findAvatar, trustedUploadPath }`）
  - `resolveSeedanceVoice(payload, runDir, accessors) → Promise<{ voice, path }>`（accessors: `{ findVoice }`）
  - `buildSeedancePrompt(payload, avatar, voice) → string`（原样迁移，纯函数）
  - `seedanceDurationTier(sec) → 5|10|15`
  - `runSeedanceGeneration({ config, payload, runDir, durationSec, onEvent }) → Promise<{ videoPath, providerTaskId, report }>`
    - `config = { python, toolVault, runner, model, projectRoot, accessors }`
    - onEvent 事件：`{ phase: "prepared" }`（prompt 已落盘）、`{ phase: "submitted", providerTaskId }`、`{ phase: "poll", providerTaskId, status, pollCount }`
    - reject 错误码与现行完全一致：`SEEDANCE_PREFLIGHT_FAILED`（及 preflight 原始码如 `AVATAR_NOT_FOUND`）、`SEEDANCE_PROCESS_FAILED`(retryable)、`SEEDANCE_GENERATION_FAILED`、`SEEDANCE_WAIT_TIMEOUT`(retryable:false)；均带 `providerTaskId`（如有）

- [ ] **Step 1: 写伪 runner 夹具与失败的测试**

```javascript
// tests/fixtures/fake-seedance-runner.mjs
// 伪 Seedance 工具链：模拟 tool-vault 入口，按真实 runner 约定输出事件行并落 final_report.json
// 用法：node fake-seedance-runner.mjs run seedance2 -- <任意参数，含 --out-dir>
// 环境变量 FAKE_RUNNER_MODE=fail 时模拟生成失败（退出码 1 + failed 报告）
import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const outDir = args[args.indexOf("--out-dir") + 1];
const fail = process.env.FAKE_RUNNER_MODE === "fail";
mkdirSync(outDir, { recursive: true });

console.log(JSON.stringify({ phase: "submitted_once", task_id: "fake-task-1" }));
console.log(JSON.stringify({ phase: "poll", status: "running" }));
console.log(JSON.stringify({ phase: "poll", status: "running" }));

if (fail) {
  writeFileSync(`${outDir}/final_report.json`, JSON.stringify({ status: "failed", task_id: "fake-task-1" }));
  process.exit(1);
}

const videoPath = `${outDir}/fake-video.mp4`;
writeFileSync(videoPath, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])); // 伪 mp4 头
writeFileSync(`${outDir}/final_report.json`, JSON.stringify({
  status: "succeeded",
  task_id: "fake-task-1",
  video_path: videoPath,
  balance_before: { wallet_balance: 10 },
  balance_after: { wallet_balance: 9 },
  deducted_points: 1
}));
```

```javascript
// tests/drama-seedance.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSeedancePrompt, seedanceDurationTier, runSeedanceGeneration
} from "../lib/seedance.mjs";

const fixture = fileURLToPath(new URL("./fixtures/fake-seedance-runner.mjs", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function makeConfig(root) {
  // 形象/音色均落在临时文件，accessor 与 server.mjs 的真实实现同形
  const avatarFile = join(root, "avatar.png");
  const voiceFile = join(root, "voice.wav");
  writeFileSync(avatarFile, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  writeFileSync(voiceFile, Buffer.alloc(600, 1));
  return {
    python: process.execPath,
    toolVault: fixture,
    runner: "ignored-by-fixture",
    model: "fake-model",
    projectRoot,
    accessors: {
      findAvatar: (id) => (id === "a1" ? { id: "a1", name: "测试人物", image: "/uploads/avatar.png", source: "local" } : null),
      trustedUploadPath: () => avatarFile,
      findVoice: (id) => (id === "v1" ? { id: "v1", name: "测试音色", previewPath: voiceFile, ttsReady: true } : null)
    }
  };
}

const payload = {
  title: "镜1 测试",
  script: "这是一句用于伪 runner 测试的口播台词。",
  avatarId: "a1",
  voiceId: "v1",
  generationPrompt: "x".repeat(30),
  ratio: "portrait"
};

test("seedanceDurationTier 向上取档", () => {
  assert.equal(seedanceDurationTier(2), 5);
  assert.equal(seedanceDurationTier(5), 5);
  assert.equal(seedanceDurationTier(7), 10);
  assert.equal(seedanceDurationTier(11), 15);
});

test("buildSeedancePrompt 保持原有形态（从 server.mjs 迁移）", () => {
  const prompt = buildSeedancePrompt({ script: "你好。", language: "zh", settings: {} }, { name: "林晚" }, { name: "克隆音色" });
  assert.ok(prompt.includes("林晚"));
  assert.ok(prompt.includes("克隆音色"));
  assert.ok(prompt.includes("你好。"));
});

test("runSeedanceGeneration 走通 子进程→事件→报告→成片 全流程", async () => {
  const root = mkdtempSync(join(tmpdir(), "seedance-lib-test-"));
  try {
    const events = [];
    const result = await runSeedanceGeneration({
      config: makeConfig(root),
      payload,
      runDir: join(root, "run"),
      durationSec: 10,
      onEvent: (event) => events.push(event)
    });
    assert.equal(result.providerTaskId, "fake-task-1");
    assert.ok(existsSync(result.videoPath));
    assert.equal(result.report.deducted_points, 1);
    assert.deepEqual(events.map((e) => e.phase), ["prepared", "submitted", "poll", "poll"]);
    assert.equal(events[2].pollCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSeedanceGeneration 失败时抛 SEEDANCE_GENERATION_FAILED 且带 providerTaskId", async () => {
  const root = mkdtempSync(join(tmpdir(), "seedance-lib-fail-"));
  try {
    const config = makeConfig(root);
    const originalExecPath = config.python;
    // 通过 env 让夹具失败：runSeedanceGeneration 需要把 process.env 透传给子进程（spawn 默认行为）
    process.env.FAKE_RUNNER_MODE = "fail";
    await assert.rejects(
      runSeedanceGeneration({ config: { ...config, python: originalExecPath }, payload, runDir: join(root, "run"), durationSec: 5, onEvent: () => {} }),
      (error) => error.code === "SEEDANCE_GENERATION_FAILED" && error.providerTaskId === "fake-task-1"
    );
  } finally {
    delete process.env.FAKE_RUNNER_MODE;
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/drama-seedance.test.mjs`
Expected: FAIL，`Cannot find module '../lib/seedance.mjs'`

- [ ] **Step 3: 实现 lib/seedance.mjs（从 server.mjs 忠实迁移 + Promise 化）**

```javascript
// lib/seedance.mjs
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
```

- [ ] **Step 4: server.mjs 改为薄封装（口播行为逐字节等价）**

编辑 1 — 顶部 import 区追加：

```javascript
import { buildSeedancePrompt, downloadReference, resolveSeedanceAvatar, resolveSeedanceVoice, runSeedanceGeneration } from "./lib/seedance.mjs";
```

编辑 2 — 删除 server.mjs 内的 `downloadReference`、`resolveSeedanceAvatar`、`resolveSeedanceVoice`、`buildSeedancePrompt` 四个函数定义（约 server.mjs:525-616），替换为 accessor 常量（放在既有 drama 常量块旁）：

```javascript
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
```

注意：`avatarById`/`trustedUploadPath` 仍在 server.mjs 保留（avatars API 与 drama 挂载也用它们）；`buildSeedancePrompt` 的调用点（`/api/seedance/prompt-preview`）改为调用 import 来的同名函数，行为不变。

编辑 3 — `generateSeedanceVideo(taskId, payload)` 整个函数（server.mjs:618-747）替换为薄封装：

```javascript
async function generateSeedanceVideo(taskId, payload) {
  const runDir = join(seedanceRunRoot, taskId);
  setTask(taskId, { status: "running", progress: 5, startedAt: new Date().toISOString(), provider: "seedance2" });
  try {
    const result = await runSeedanceGeneration({
      config: seedanceConfig,
      payload,
      runDir,
      durationSec: 15, // 口播页固定 15 秒，与历史行为一致
      onEvent: (event) => {
        if (event.phase === "prepared") setTask(taskId, { progress: 16 });
        else if (event.phase === "submitted") setTask(taskId, { progress: 35, providerTaskId: event.providerTaskId });
        else if (event.phase === "poll") {
          setTask(taskId, {
            progress: Math.min(92, 42 + event.pollCount * 2),
            providerTaskId: event.providerTaskId,
            providerStatus: event.status
          });
        }
      }
    });
    const fileName = `${taskId}.mp4`;
    copyFileSync(result.videoPath, join(outputRoot, fileName));
    setTask(taskId, {
      status: "succeeded",
      progress: 100,
      finishedAt: new Date().toISOString(),
      result: {
        provider: "seedance2",
        providerTaskId: result.providerTaskId,
        providerStatus: "succeeded",
        videoUrl: `/outputs/${fileName}`,
        balanceBefore: result.report.balance_before?.wallet_balance ?? null,
        balanceAfter: result.report.balance_after?.wallet_balance ?? null,
        deductedPoints: result.report.deducted_points ?? null
      }
    });
  } catch (error) {
    setTask(taskId, {
      status: "failed",
      progress: 100,
      finishedAt: new Date().toISOString(),
      error: {
        code: error.code || "SEEDANCE_GENERATION_FAILED",
        message: error.message,
        retryable: Boolean(error.retryable),
        ...(error.providerTaskId ? { providerTaskId: error.providerTaskId } : {})
      }
    });
  }
}
```

编辑 4 — drama 挂载 ctx（`handleDramaApi(...)` 调用处）追加 `seedanceConfig` 与 `seedanceStatus`，供 Task 3/5 使用（本任务先加上，无副作用）：

```javascript
      seedanceConfig,
      seedanceStatus: getSeedanceStatus,
```

编辑 5 — package.json check 追加 `&& node --check lib/seedance.mjs && node --check tests/fixtures/fake-seedance-runner.mjs`。

- [ ] **Step 5: 运行测试确认通过 + 口播回归**

Run: `node --test tests/*.test.mjs && npm run check && npm run smoke`
Expected: 全部 PASS（smoke 的 promptPreview 断言走过 buildSeedancePrompt 新路径，间接验证迁移正确）

- [ ] **Step 6: Commit**

```bash
git add lib/seedance.mjs tests/fixtures/fake-seedance-runner.mjs tests/drama-seedance.test.mjs server.mjs package.json
git commit -m "refactor: 抽取 Seedance 生成机制为 lib/seedance.mjs 供短剧复用"
```

---

### Task 2: 数据模型扩展（clip 状态机 / voiceId / clips 目录）与成本模型修正

**Files:**
- Modify: `lib/drama/schema.mjs`（`normalizeClip` + normalizeShot 挂 clip + normalizeCharacter 加 voiceId）
- Modify: `lib/drama/store.mjs`（clips 目录 + clip 孤儿归置）
- Modify: `lib/drama/budget.mjs`（移除 tts 行）
- Test: `tests/drama-schema.test.mjs`（追加 clip 用例）
- Test: `tests/drama-budget.test.mjs`（更新断言）

**Interfaces:**
- Consumes: M1 schema/store/budget。
- Produces:
  - `CLIP_STATUSES = ["generating", "ready", "confirmed", "failed"]`
  - `normalizeClip(raw?) → clip`（status 白名单外归 pending；provider 白名单 `["seedance2","comfyui"]` 外归 null；durationSec 0-60 整数钳制默认 0）
  - `normalizeShot` 产出含 `clip: normalizeClip(raw.clip)`
  - `normalizeCharacter` 产出含 `voiceId: string|null`
  - store：`save` 时确保 `clips/` 目录存在；`get` 磁盘加载时 `clip.status==="generating"` → 归置 failed（code `CLIP_INTERRUPTED`）
  - `estimateBudget` lines 只剩 `frames/seedance/h3` 三行（无 tts）

- [ ] **Step 1: 写失败的测试**

`tests/drama-schema.test.mjs` 追加：

```javascript
test("normalizeClip 收敛非法输入", () => {
  const bare = normalizeClip();
  assert.deepEqual(bare, { status: "pending", file: null, provider: null, providerTaskId: null, durationSec: 0, attempts: 0, error: null });
  const clip = normalizeClip({ status: "ready", file: "shot-1-clip-1.mp4", provider: "seedance2", providerTaskId: "t1", durationSec: 99, attempts: 2 });
  assert.equal(clip.status, "ready");
  assert.equal(clip.durationSec, 60); // 钳制上限
  assert.equal(normalizeClip({ status: "hacked" }).status, "pending");
  assert.equal(normalizeClip({ provider: "unknown" }).provider, null);
});

test("normalizeShot 携带 clip；normalizeCharacter 携带 voiceId", () => {
  const shot = normalizeShot({ clip: { status: "ready", file: "a.mp4" } }, 0);
  assert.equal(shot.clip.status, "ready");
  assert.equal(normalizeShot({}, 0).clip.status, "pending");
  const character = normalizeCharacter({ name: "林晚", appearance: "young woman", voiceId: "v1" }, 0);
  assert.equal(character.voiceId, "v1");
  assert.equal(normalizeCharacter({ name: "x", appearance: "y" }, 0).voiceId, null);
});

test("store 重启恢复时将孤儿 generating clip 归一为 failed", () => {
  const root = mkdtempSync(join(tmpdir(), "drama-store-clip-"));
  try {
    const store = createDramaStore(root);
    const project = createDramaProject({ title: "t", script: "雨夜。" });
    project.shots = [normalizeShot({}, 0)];
    project.shots[0].clip = { status: "generating", file: null, provider: "comfyui", providerTaskId: null, durationSec: 0, attempts: 2, error: null };
    store.save(project);
    const fresh = createDramaStore(root);
    const loaded = fresh.get(project.id);
    assert.equal(loaded.shots[0].clip.status, "failed");
    assert.equal(loaded.shots[0].clip.error.code, "CLIP_INTERRUPTED");
    assert.equal(loaded.shots[0].clip.attempts, 2);
    assert.ok(existsSync(join(root, "drama-projects", project.id, "clips"))); // clips 目录已建
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

文件顶部 import 需追加 `normalizeClip, normalizeCharacter` 与 `existsSync`（如尚无）。

`tests/drama-budget.test.mjs` 的"按镜头类型与台词字数汇总预算"用例改为：

```javascript
test("按镜头类型汇总预算（无独立 TTS 行）", () => {
  const project = createDramaProject({ title: "t", script: "s" });
  project.shots = [
    normalizeShot({ shotType: "dialogue", dialogue: "你好，世界。", durationSec: 5 }, 0),
    normalizeShot({ shotType: "dialogue", dialogue: "再见。", durationSec: 4 }, 1),
    normalizeShot({ shotType: "cinematic", durationSec: 8 }, 2)
  ];
  const budget = estimateBudget(project, getDramaPricing({}));
  const byId = Object.fromEntries(budget.lines.map((line) => [line.id, line]));
  assert.equal(byId.frames.kind, "local");
  assert.equal(byId.frames.subtotal, 0);
  assert.equal(byId.seedance.count, 2);
  assert.equal(byId.seedance.subtotal, 12);
  assert.equal(byId.h3.count, 8);
  assert.equal(byId.h3.subtotal, 4);
  assert.equal(byId.tts, undefined); // M3 起无独立配音行：Seedance/H3 原生出声
  assert.equal(budget.totalPaid, 16);
  assert.equal(budget.estimated, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/drama-schema.test.mjs tests/drama-budget.test.mjs`
Expected: FAIL（`normalizeClip is not exported` / tts 断言失败）

- [ ] **Step 3: 实现 schema/store/budget 修改**

schema.mjs — 常量区追加、normalizeClip 新增（放在 normalizeFrame 之后）、normalizeShot 返回值末尾加 `clip: normalizeClip(raw.clip)`、normalizeCharacter 返回值在 avatarId 后加 `voiceId: typeof raw.voiceId === "string" && raw.voiceId ? raw.voiceId : null`：

```javascript
export const CLIP_STATUSES = ["generating", "ready", "confirmed", "failed"];
const CLIP_PROVIDERS = ["seedance2", "comfyui"];

export function normalizeClip(raw = {}) {
  return {
    status: CLIP_STATUSES.includes(raw?.status) ? raw.status : "pending",
    file: typeof raw?.file === "string" && raw.file ? raw.file : null,
    provider: CLIP_PROVIDERS.includes(raw?.provider) ? raw.provider : null,
    providerTaskId: typeof raw?.providerTaskId === "string" ? raw.providerTaskId : null,
    durationSec: clampNumber(raw?.durationSec, 0, 60, 0),
    attempts: Number.isInteger(raw?.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
    error: raw?.error && typeof raw.error === "object"
      ? { code: String(raw.error.code || "CLIP_FAILED"), message: String(raw.error.message || "").slice(0, 300) }
      : null
  };
}
```

store.mjs — 两处修改：(a) `persist` 中 frames mkdir 行旁追加 `mkdirSync(join(dir(project.id), "clips"), { recursive: true });`；(b) `get` 的磁盘加载归一化块（M1 末审加入的 frame 孤儿归置处）在循环内追加：

```javascript
      if (shot.clip?.status === "generating") {
        // 与 frame 同理：视频生成是进程内的，磁盘上的 generating 必然是孤儿
        shot.clip = {
          status: "failed",
          file: null,
          provider: shot.clip.provider ?? null,
          providerTaskId: shot.clip.providerTaskId ?? null,
          durationSec: shot.clip.durationSec ?? 0,
          attempts: shot.clip.attempts ?? 0,
          error: { code: "CLIP_INTERRUPTED", message: "服务重启导致视频生成中断，可重新生成" }
        };
      }
```

budget.mjs — 删除 ttsChars 计算与 tts 行；h3 行 label 改为 `` `剧情镜视频（图生视频约 ${cinematicSeconds} 秒，预估）` ``（去掉 "MiniMax H3" 具体供应商名——模板由用户自配，供应商不一定是 H3）；其余不动。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/*.test.mjs && npm run check && npm run smoke`
Expected: 全部 PASS（smoke 不触预算行级断言）

- [ ] **Step 5: Commit**

```bash
git add lib/drama/schema.mjs lib/drama/store.mjs lib/drama/budget.mjs tests/drama-schema.test.mjs tests/drama-budget.test.mjs
git commit -m "feat: 分镜 clip 状态机与角色音色绑定字段，预算移除独立配音行"
```

---

### Task 3: 角色资产绑定路由（avatar/voice）

**Files:**
- Modify: `lib/drama/routes.mjs`（新增 PATCH characters/:charId）
- Modify: `server.mjs`（drama ctx 追加 findAvatar/findVoice）

**Interfaces:**
- Consumes: server.mjs 的 `avatarById`（作 findAvatar）、Task 1 的 `seedanceAccessors.findVoice` 形态。
- Produces:
  - `PATCH /api/drama/projects/:id/characters/:charId` `{ avatarId?: string|null, voiceId?: string|null }` → `{ project }`
    - avatarId 非 null 时 `ctx.findAvatar(avatarId)` 必须命中，否则 422 `AVATAR_NOT_FOUND`
    - voiceId 非 null 时 `ctx.findVoice(voiceId)` 必须命中（本地+自定义音色），否则 422 `VOICE_NOT_FOUND`，message "该音色没有本地参考音频，仅支持本地/自定义音色"
    - 换绑后：该角色出演的口播镜 clip 为 ready/confirmed 时重置（保留 attempts），项目 `clips_ready` 回退 `videos`
    - 项目不存在 404 `DRAMA_PROJECT_NOT_FOUND`；角色不存在 404 `DRAMA_CHARACTER_NOT_FOUND`
  - server.mjs drama ctx 最终形态：`{ sendJson, envelope, readJson, allowRequest, store, llmDeps, comfyConfig, pricing, seedanceConfig, seedanceStatus, findAvatar: avatarById, findVoice }`

- [ ] **Step 1: 实现 routes.mjs 新分支**

在 shots PATCH 分支之前插入（segments.length === 6 区）：

```javascript
    if (segments.length === 6 && segments[4] === "characters" && request.method === "PATCH") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      let payload;
      try {
        payload = await readJson(request, 10_000);
      } catch (error) {
        return sendJson(response, 400, envelope(false, null, { requestId, errorCode: error.message, message: "请求内容无效" }));
      }
      const character = project.analysis?.characters?.find((c) => c.id === segments[5]);
      if (!character) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_CHARACTER_NOT_FOUND", message: "角色不存在" }));
      if (typeof payload.avatarId === "string" && payload.avatarId && !ctx.findAvatar(payload.avatarId)) {
        return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "AVATAR_NOT_FOUND", message: "找不到所选人物形象" }));
      }
      if (typeof payload.voiceId === "string" && payload.voiceId && !ctx.findVoice(payload.voiceId)) {
        return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "VOICE_NOT_FOUND", message: "该音色没有本地参考音频，仅支持本地/自定义音色" }));
      }
      const updated = store.update(projectId, (p) => {
        const target = p.analysis.characters.find((c) => c.id === segments[5]);
        const avatarChanged = payload.avatarId !== undefined && (payload.avatarId || null) !== target.avatarId;
        const voiceChanged = payload.voiceId !== undefined && (payload.voiceId || null) !== target.voiceId;
        if (payload.avatarId !== undefined) target.avatarId = payload.avatarId || null;
        if (payload.voiceId !== undefined) target.voiceId = payload.voiceId || null;
        if (avatarChanged || voiceChanged) {
          // 换绑形象/音色后，其出演的口播镜成片作废（与 prompt 变更重置 frame 同一纪律）
          for (const shot of p.shots) {
            if (shot.shotType === "dialogue" && shot.characterIds.includes(target.id)
              && ["ready", "confirmed"].includes(shot.clip?.status)) {
              shot.clip = { ...normalizeClip(), attempts: shot.clip.attempts };
            }
          }
          if (p.status === "clips_ready") p.status = "videos";
        }
      });
      return sendJson(response, 200, envelope(true, { project: updated }, { requestId }));
    }
```

routes.mjs 顶部 import 从 schema.mjs 追加 `normalizeClip`。

- [ ] **Step 2: server.mjs ctx 补齐**

drama 挂载的 ctx 对象（Task 1 已加 seedanceConfig/seedanceStatus）追加：

```javascript
      findAvatar: avatarById,
      findVoice: seedanceAccessors.findVoice,
```

- [ ] **Step 3: 手动验证**

```bash
npm run check && node --test tests/*.test.mjs && npm run smoke
PORT=4399 node server.mjs &
# 用 smoke 同款流程建项目跑流水线到 awaiting_gate_a（或复用已有点项目）
curl -s -X PATCH http://127.0.0.1:4399/api/drama/projects/<pid>/characters/char-1 \
  -H 'Content-Type: application/json' -d '{"avatarId":"不存在的id"}'
# 期望 422 AVATAR_NOT_FOUND
curl -s -X PATCH http://127.0.0.1:4399/api/drama/projects/<pid>/characters/char-1 \
  -H 'Content-Type: application/json' -d '{"voiceId":""}'
# 期望 200，voiceId 解绑为 null
kill %1
```

- [ ] **Step 4: Commit**

```bash
git add lib/drama/routes.mjs server.mjs
git commit -m "feat: 角色形象与音色绑定接口（换绑作废旧成片）"
```

---

### Task 4: ComfyUI 视频工作流模板与图生视频适配

**Files:**
- Modify: `lib/drama/comfyui.mjs`（追加模板加载/替换/上传/视频生成）
- Create: `config/drama-video-workflow.example.json`
- Test: `tests/drama-comfyui-video.test.mjs`

**Interfaces:**
- Consumes: Task 7（M1）的 `getComfyuiConfig`。
- Produces:
  - `getVideoWorkflowPath(env = process.env) → string`（`DRAMA_VIDEO_WORKFLOW` 或 `<projectRoot>/config/drama-video-workflow.json`）
  - `loadVideoWorkflowTemplate(env = process.env) → object|null`（文件缺失/非法 → null；剥离 `_` 前缀键；无有效节点 → null）
  - `buildVideoWorkflow(template, values) → object`（深拷贝 + 字符串遍历替换；整值等于占位符时写入类型化值——SEED/FRAMES/WIDTH/HEIGHT/FPS 为 number，PROMPT/IMAGE 为 string）
  - `uploadComfyuiImage({ config, bytes, filename, fetchImpl }) → Promise<string>`（POST /upload/image multipart，返回 ComfyUI 侧文件名；错误码 `COMFYUI_UPLOAD_FAILED`）
  - `generateComfyuiVideo({ config, template, values, fetchImpl, sleep, clientId }) → Promise<Buffer>`（提交→轮询 history→扫描 outputs 的 gifs/videos/images 中首个 .mp4/.webm→/view 下载；错误码复用 COMFYUI_*，视频专用超时 `config.videoTimeoutMs`）
  - `getComfyuiConfig` 追加 `videoTimeoutMs: Number(env.COMFYUI_VIDEO_TIMEOUT_MS) || 1_200_000`（20 分钟）

- [ ] **Step 1: 写失败的测试**

```javascript
// tests/drama-comfyui-video.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getComfyuiConfig, loadVideoWorkflowTemplate, buildVideoWorkflow,
  uploadComfyuiImage, generateComfyuiVideo
} from "../lib/drama/comfyui.mjs";

const config = getComfyuiConfig({ COMFYUI_URL: "http://127.0.0.1:8188" });

const template = {
  "_说明": "文档键，提交前必须被剥离",
  "1": { class_type: "LoadImage", inputs: { image: "{{IMAGE}}" } },
  "2": { class_type: "SomeI2VNode", inputs: { prompt: "前缀 {{PROMPT}} 后缀", image: ["1", 0], seed: "{{SEED}}", num_frames: "{{FRAMES}}" } },
  "3": { class_type: "SomeSaveNode", inputs: { video: ["2", 0], filename_prefix: "drama" } }
};

test("loadVideoWorkflowTemplate 剥离文档键；缺失/非法返回 null", () => {
  const root = mkdtempSync(join(tmpdir(), "drama-tpl-"));
  try {
    assert.equal(loadVideoWorkflowTemplate({ DRAMA_VIDEO_WORKFLOW: join(root, "missing.json") }), null);
    const file = join(root, "tpl.json");
    writeFileSync(file, JSON.stringify(template));
    const loaded = loadVideoWorkflowTemplate({ DRAMA_VIDEO_WORKFLOW: file });
    assert.equal(loaded._说明, undefined);
    assert.equal(loaded["1"].class_type, "LoadImage");
    writeFileSync(file, "{ not json");
    assert.equal(loadVideoWorkflowTemplate({ DRAMA_VIDEO_WORKFLOW: file }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildVideoWorkflow 整值占位符写入类型化值，嵌入串做字符串替换", () => {
  const built = buildVideoWorkflow(template, {
    PROMPT: "slow push in", IMAGE: "shot-1.png", SEED: 42, FRAMES: 96, WIDTH: 768, HEIGHT: 1344, FPS: 24
  });
  assert.equal(built["1"].inputs.image, "shot-1.png");
  assert.equal(built["2"].inputs.prompt, "前缀 slow push in 后缀");
  assert.strictEqual(built["2"].inputs.seed, 42); // number，不是字符串
  assert.strictEqual(built["2"].inputs.num_frames, 96);
  assert.deepEqual(built["2"].inputs.image, ["1", 0]); // 引用不动
  assert.equal(template["2"].inputs.seed, "{{SEED}}"); // 模板不被污染
});

test("uploadComfyuiImage 以 multipart 上传并返回文件名", async () => {
  let seenBody = null;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/upload/image")) {
      seenBody = options.body;
      return { ok: true, json: async () => ({ name: "drama-shot-1.png" }) };
    }
    throw new Error(`unexpected ${url}`);
  };
  const name = await uploadComfyuiImage({ config, bytes: Buffer.from([1, 2, 3]), filename: "drama-shot-1.png", fetchImpl });
  assert.equal(name, "drama-shot-1.png");
  assert.ok(seenBody instanceof FormData); // undici 自动带 boundary
});

test("generateComfyuiVideo 提交→轮询→定位 mp4→下载", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push(url);
    if (url.endsWith("/prompt")) return { ok: true, json: async () => ({ prompt_id: "vid-1" }) };
    if (url.includes("/history/vid-1")) {
      return { ok: true, json: async () => ({ "vid-1": { outputs: { "3": { gifs: [{ filename: "drama_00001.mp4", subfolder: "", type: "output", format: "video/mp4" }] } } } }) };
    }
    if (url.includes("/view")) return { ok: true, arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer };
    throw new Error(`unexpected ${url}`);
  };
  const bytes = await generateComfyuiVideo({
    config, template, values: { PROMPT: "p", IMAGE: "i.png", SEED: 1, FRAMES: 24, WIDTH: 768, HEIGHT: 1344, FPS: 24 },
    fetchImpl, sleep: async () => {}, clientId: "t"
  });
  assert.deepEqual([...bytes], [9, 8, 7]);
  assert.ok(calls.some((u) => u.includes("/history/")));
  assert.ok(calls.some((u) => u.includes("drama_00001.mp4")));
});

test("无视频输出时抛 COMFYUI_OUTPUT_MISSING", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/prompt")) return { ok: true, json: async () => ({ prompt_id: "vid-2" }) };
    if (url.includes("/history/")) {
      return { ok: true, json: async () => ({ "vid-2": { outputs: { "3": { images: [{ filename: "only-image.png", subfolder: "", type: "output" }] } } } }) };
    }
    throw new Error("unexpected");
  };
  const fast = { ...config, videoTimeoutMs: 5, pollIntervalMs: 1 };
  await assert.rejects(
    generateComfyuiVideo({ config: fast, template, values: {}, fetchImpl, sleep: async () => {}, clientId: "t" }),
    (error) => ["COMFYUI_OUTPUT_MISSING", "COMFYUI_TIMEOUT"].includes(error.code)
  );
});
```

注意：最后一个用例两个错误码都可接受——模板若在超时前已出现 outputs 但无视频文件，实现应立刻抛 `COMFYUI_OUTPUT_MISSING`；轮询窗口内还没出现 outputs 则抛 `COMFYUI_TIMEOUT`。两种时序都合法，断言只锁错误码集合。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/drama-comfyui-video.test.mjs`
Expected: FAIL（函数未导出）

- [ ] **Step 3: 实现 comfyui.mjs 追加**

顶部 import 追加 `import { existsSync, readFileSync } from "node:fs"; import { join, dirname } from "node:path"; import { fileURLToPath } from "node:url";`，并在 `getComfyuiConfig` 返回对象中追加 `videoTimeoutMs: Number(env.COMFYUI_VIDEO_TIMEOUT_MS) || 1_200_000,`。然后追加：

```javascript
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
```

- [ ] **Step 4: 创建 config/drama-video-workflow.example.json**

```json
{
  "_说明": [
    "这是短剧剧情镜的视频工作流模板。复制本文件为 config/drama-video-workflow.json 后按下列步骤配置：",
    "1. 在本机 ComfyUI 中调好你的图生视频工作流（推荐 MiniMax H3 原生/社区节点，也可是 Wan 等本机模型）；",
    "2. 用 ComfyUI 的「导出 API 格式」得到 workflow JSON，覆盖本文件除 _ 前缀键以外的内容；",
    "3. 把需要程序注入的输入值替换为下方占位符（整值占位符会按类型写入，例如 SEED 会写成数字）；",
    "4. 首帧图片由程序自动上传到 ComfyUI 并把文件名填入 {{IMAGE}}，你的工作流需要一个 LoadImage 类节点承接。",
    "也可以用环境变量 DRAMA_VIDEO_WORKFLOW 指向任意路径的模板文件。"
  ],
  "_占位符": {
    "{{PROMPT}}": "运动提示词（分镜 motionPrompt，回退 action）",
    "{{IMAGE}}": "首帧图片在 ComfyUI 侧的文件名（程序自动上传）",
    "{{SEED}}": "随机种子（number）",
    "{{WIDTH}}": "画面宽（number，按项目画幅）",
    "{{HEIGHT}}": "画面高（number，按项目画幅）",
    "{{FPS}}": "帧率（number，默认 24）",
    "{{FRAMES}}": "总帧数（number，durationSec × FPS）"
  },
  "_最小骨架示例": {
    "1": { "class_type": "LoadImage", "inputs": { "image": "{{IMAGE}}" } },
    "2": { "class_type": "你的I2V节点类名（如 MiniMax H3 图生视频节点）", "inputs": { "prompt": "{{PROMPT}}", "image": ["1", 0], "seed": "{{SEED}}", "num_frames": "{{FRAMES}}" } },
    "3": { "class_type": "你的视频保存节点类名", "inputs": { "video": ["2", 0], "filename_prefix": "drama" } }
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test tests/*.test.mjs && npm run check && npm run smoke`
Expected: 全部 PASS（check 行已在 M1 覆盖 comfyui.mjs；example.json 无需 check）

- [ ] **Step 6: Commit**

```bash
git add lib/drama/comfyui.mjs config/drama-video-workflow.example.json tests/drama-comfyui-video.test.mjs
git commit -m "feat: ComfyUI 视频工作流模板与图生视频适配"
```

---

### Task 5: 视频生成路由与执行器（口播 Seedance / 剧情 ComfyUI）

**Files:**
- Modify: `lib/drama/routes.mjs`（generateShotClip 执行器 + video / video-confirm 路由）
- Modify: `server.mjs`（/drama-files/ 支持 mp4/webm；providerHealth 与 integrationContract 追加 dramaVideo）
- Test: `tests/drama-routes-video.test.mjs`

**Interfaces:**
- Consumes: Task 1 `runSeedanceGeneration/seedanceDurationTier`、Task 2 `normalizeClip`、Task 4 `loadVideoWorkflowTemplate/buildVideoWorkflow/uploadComfyuiImage/generateComfyuiVideo`。
- Produces:
  - `generateShotClip(ctx, projectId, shotId) → Promise<void>`（导出供单测；按 shotType 分流；状态推进：任一 clip generating/ready → `videos`；全部 confirmed → `clips_ready`）
  - `POST /api/drama/projects/:id/shots/:shotId/video` `{ confirmCost? }` → 202 `{ shotId, status: "generating" }`
    - 守卫顺序：限流 → shot 404 → `gateAConfirmedAt` 缺失 409 `GATE_A_REQUIRED` → clip generating 409 `CLIP_BUSY` → clip ready/confirmed 且 `confirmCost !== true` 409 `COST_CONFIRMATION_REQUIRED`（"重新生成将产生额外费用"）→ 口播镜：角色绑定缺失 422 `CHARACTER_BINDING_REQUIRED`（message 含角色名）、台词空 422 `DIALOGUE_REQUIRED`、`ctx.seedanceStatus()` 未连接 503 `SEEDANCE_UNAVAILABLE` → 剧情镜：frame 未 confirmed 409 `FRAME_NOT_CONFIRMED`、模板缺失 503 `VIDEO_WORKFLOW_NOT_CONFIGURED`、ComfyUI 未连接 503 `COMFYUI_UNAVAILABLE`
  - `POST /api/drama/projects/:id/shots/:shotId/video-confirm` → `{ project }`（非 ready → 409 `CLIP_NOT_READY`；全部 confirmed → `clips_ready`）
  - `/drama-files/` 正则扩展 `mp4|webm`
  - providerHealth 追加 `dramaVideo`；integrationContract 追加 `drama-video-workflow` 条目 + appApi 两条新路由

- [ ] **Step 1: 写失败的测试**

```javascript
// tests/drama-routes-video.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject, normalizeShot, normalizeCharacter, normalizeClip, DEMO_DRAMA_SCRIPT } from "../lib/drama/schema.mjs";
import { generateShotClip } from "../lib/drama/routes.mjs";
import { getComfyuiConfig } from "../lib/drama/comfyui.mjs";

const fixture = fileURLToPath(new URL("./fixtures/fake-seedance-runner.mjs", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function fixtureProject(root, shotPatch = {}, charPatch = {}) {
  const store = createDramaStore(root);
  const project = store.save(createDramaProject({ title: "视频测试", script: DEMO_DRAMA_SCRIPT }));
  store.update(project.id, (p) => {
    p.analysis = { synopsis: "s", genre: "g", characters: [normalizeCharacter({ name: "林晚", appearance: "young woman", avatarId: "a1", voiceId: "v1", ...charPatch }, 0)], scenes: [] };
    p.shots = [normalizeShot({ shotType: "dialogue", dialogue: "这是一句足够长的口播台词内容。", characterIds: ["char-1"], ...shotPatch }, 0)];
    p.gateAConfirmedAt = new Date().toISOString();
    p.status = "frames_confirmed";
  });
  return { store, project: store.get(project.id) };
}

function seedanceCtx(store, root) {
  const avatarFile = join(root, "a.png");
  const voiceFile = join(root, "v.wav");
  writeFileSync(avatarFile, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  writeFileSync(voiceFile, Buffer.alloc(600, 1));
  return {
    store,
    seedanceConfig: {
      python: process.execPath, toolVault: fixture, runner: "ignored", model: "fake", projectRoot,
      accessors: {
        findAvatar: () => ({ id: "a1", name: "林晚", image: "/uploads/a.png", source: "local" }),
        trustedUploadPath: () => avatarFile,
        findVoice: () => ({ id: "v1", name: "音色", previewPath: voiceFile, ttsReady: true })
      }
    }
  };
}

test("口播镜：伪 runner 全链路产出 clip 并推进项目状态", async () => {
  const root = mkdtempSync(join(tmpdir(), "drama-video-dialogue-"));
  try {
    const { store, project } = fixtureProject(root);
    await generateShotClip(seedanceCtx(store, root), project.id, "shot-1");
    const shot = store.get(project.id).shots[0];
    assert.equal(shot.clip.status, "ready");
    assert.equal(shot.clip.provider, "seedance2");
    assert.equal(shot.clip.providerTaskId, "fake-task-1");
    assert.equal(shot.clip.attempts, 1);
    assert.ok(existsSync(join(store.dir(project.id), "clips", shot.clip.file)));
    assert.equal(store.get(project.id).status, "videos"); // 还有 clip 未 confirmed
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("口播镜：runner 失败落 failed 不自动重试", async () => {
  const root = mkdtempSync(join(tmpdir(), "drama-video-fail-"));
  try {
    const { store, project } = fixtureProject(root);
    process.env.FAKE_RUNNER_MODE = "fail";
    await generateShotClip(seedanceCtx(store, root), project.id, "shot-1");
    const clip = store.get(project.id).shots[0].clip;
    assert.equal(clip.status, "failed");
    assert.equal(clip.error.code, "SEEDANCE_GENERATION_FAILED");
    assert.equal(clip.attempts, 0); // 失败不计 attempts
  } finally {
    delete process.env.FAKE_RUNNER_MODE;
    rmSync(root, { recursive: true, force: true });
  }
});

test("剧情镜：模板 + 上传 + 生成 + 落盘", async () => {
  const root = mkdtempSync(join(tmpdir(), "drama-video-cinematic-"));
  try {
    const { store, project } = fixtureProject(root, { shotType: "cinematic", dialogue: "", fluxPrompt: "cinematic still, rain" });
    store.update(project.id, (p) => {
      p.shots[0].frame = { status: "confirmed", file: "shot-1-7.png", seed: 7, attempts: 1, error: null };
      p.shots[0].motionPrompt = "slow push in, rain falling";
    });
    writeFileSync(join(store.dir(project.id), "frames", "shot-1-7.png"), Buffer.from([1, 2, 3]));
    const tplFile = join(root, "tpl.json");
    writeFileSync(tplFile, JSON.stringify({ "1": { class_type: "LoadImage", inputs: { image: "{{IMAGE}}" } } }));
    const fetchImpl = async (url, options = {}) => {
      if (url.endsWith("/upload/image")) return { ok: true, json: async () => ({ name: "uploaded.png" }) };
      if (url.endsWith("/prompt")) return { ok: true, json: async () => ({ prompt_id: "vid-1" }) };
      if (url.includes("/history/")) {
        return { ok: true, json: async () => ({ "vid-1": { outputs: { "9": { videos: [{ filename: "out.mp4", subfolder: "", type: "output" }] } } } }) };
      }
      if (url.includes("/view")) return { ok: true, arrayBuffer: async () => new Uint8Array([5, 5, 5]).buffer };
      throw new Error(`unexpected ${url}`);
    };
    const ctx = {
      store,
      comfyConfig: { ...getComfyuiConfig({ COMFYUI_URL: "http://127.0.0.1:8188" }), pollIntervalMs: 1 },
      videoEnv: { DRAMA_VIDEO_WORKFLOW: tplFile },
      frameFetch: fetchImpl,
      frameSleep: async () => {}
    };
    await generateShotClip(ctx, project.id, "shot-1");
    const shot = store.get(project.id).shots[0];
    assert.equal(shot.clip.status, "ready");
    assert.equal(shot.clip.provider, "comfyui");
    assert.deepEqual([...readFileSync(join(store.dir(project.id), "clips", shot.clip.file))], [5, 5, 5]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/drama-routes-video.test.mjs`
Expected: FAIL，`generateShotClip is not exported`

- [ ] **Step 3: 实现 routes.mjs 执行器与路由**

顶部 import 追加：

```javascript
import { copyFileSync, readFileSync } from "node:fs";
import { runSeedanceGeneration } from "../seedance.mjs";
import { loadVideoWorkflowTemplate, uploadComfyuiImage, generateComfyuiVideo } from "./comfyui.mjs";
```

注意：`lib/drama/routes.mjs` 引用 `lib/seedance.mjs` 的相对路径是 `../seedance.mjs`。schema import 行追加 `normalizeClip`。comfyui import 行追加 `loadVideoWorkflowTemplate, uploadComfyuiImage, generateComfyuiVideo`。`writeFileSync` 已有；`copyFileSync/readFileSync` 合并进既有 `node:fs` import。

在 `generateShotFrame` 之后追加执行器：

```javascript
// 视频生成执行器：口播镜走 Seedance（角色形象+音色+台词），剧情镜走 ComfyUI 视频模板（首帧+运动提示词）
export async function generateShotClip(ctx, projectId, shotId) {
  const { store } = ctx;
  const setClip = (patch) => store.update(projectId, (p) => {
    const shot = p.shots.find((s) => s.id === shotId);
    if (!shot) return;
    shot.clip = { ...normalizeClip(shot.clip), ...patch };
    if (p.shots.every((s) => normalizeClip(s.clip).status === "confirmed")) {
      p.status = "clips_ready";
    } else if (p.shots.some((s) => ["generating", "ready"].includes(normalizeClip(s.clip).status))) {
      p.status = "videos";
    }
  });
  const project = store.get(projectId);
  const shot = project?.shots.find((s) => s.id === shotId);
  if (!shot) return;
  const attempts = normalizeClip(shot.clip).attempts;
  const isDialogue = shot.shotType === "dialogue";
  try {
    setClip({ status: "generating", error: null, provider: isDialogue ? "seedance2" : "comfyui" });
    const fileName = `${shotId}-clip-${attempts + 1}.mp4`;
    if (isDialogue) {
      const character = project.analysis.characters.find((c) => c.id === shot.characterIds[0]);
      const runDir = join(store.dir(projectId), "clips", `run-${shotId}-${attempts + 1}`);
      const result = await runSeedanceGeneration({
        config: ctx.seedanceConfig,
        payload: {
          title: `${project.title} 镜${shot.index}`.slice(0, 80),
          script: shot.dialogue,
          avatarId: character.avatarId,
          voiceId: character.voiceId,
          ratio: project.ratio,
          generationPrompt: "" // 走 buildSeedancePrompt 标准口播提示词
        },
        runDir,
        durationSec: shot.durationSec,
        onEvent: (event) => {
          if (event.phase === "submitted") setClip({ providerTaskId: event.providerTaskId });
        }
      });
      copyFileSync(result.videoPath, join(store.dir(projectId), "clips", fileName));
      setClip({ status: "ready", file: fileName, providerTaskId: result.providerTaskId, durationSec: shot.durationSec, attempts: attempts + 1, error: null });
    } else {
      const template = loadVideoWorkflowTemplate(ctx.videoEnv || process.env);
      if (!template) throw Object.assign(new Error("未配置剧情镜视频工作流模板"), { code: "VIDEO_WORKFLOW_NOT_CONFIGURED" });
      const fetchImpl = ctx.frameFetch || fetch;
      const sleep = ctx.frameSleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
      const frameBytes = readFileSync(join(store.dir(projectId), "frames", shot.frame.file));
      const imageName = await uploadComfyuiImage({ config: ctx.comfyConfig, bytes: frameBytes, filename: `${shotId}-frame.png`, fetchImpl });
      const [width, height] = FRAME_SIZES[project.ratio] || FRAME_SIZES.portrait;
      const fps = 24;
      const bytes = await generateComfyuiVideo({
        config: ctx.comfyConfig,
        template,
        values: {
          PROMPT: shot.motionPrompt || shot.action,
          IMAGE: imageName,
          SEED: (shot.index * 100_000 + attempts * 7919 + 1) % 2 ** 31,
          WIDTH: width,
          HEIGHT: height,
          FPS: fps,
          FRAMES: shot.durationSec * fps
        },
        fetchImpl,
        sleep,
        clientId: projectId
      });
      writeFileSync(join(store.dir(projectId), "clips", fileName), bytes);
      setClip({ status: "ready", file: fileName, durationSec: shot.durationSec, attempts: attempts + 1, error: null });
    }
  } catch (error) {
    // 不自动重试：失败态落盘，由用户决定是否付费重生成
    setClip({ status: "failed", error: { code: error.code || "CLIP_FAILED", message: String(error.message || "").slice(0, 300) } });
  }
}
```

路由分支（加在 confirm 分支之后、`return false` 之前）：

```javascript
    if (segments.length === 7 && segments[4] === "shots" && segments[6] === "video" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      const shot = project.shots.find((s) => s.id === segments[5]);
      if (!shot) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_SHOT_NOT_FOUND", message: "分镜不存在" }));
      if (!project.gateAConfirmedAt) {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "GATE_A_REQUIRED", message: "请先确认预算闸门，再生成视频" }));
      }
      const clip = normalizeClip(shot.clip);
      if (clip.status === "generating") {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "CLIP_BUSY", message: "该分镜正在生成视频" }));
      }
      let payload = {};
      try {
        payload = await readJson(request, 10_000);
      } catch {
        return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" }));
      }
      if (["ready", "confirmed"].includes(clip.status) && payload.confirmCost !== true) {
        // 首轮费用已由闸门 A 覆盖；重生成属于额外费用，需要逐镜确认
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "COST_CONFIRMATION_REQUIRED", message: "重新生成视频将产生额外费用，请确认后继续" }));
      }
      if (shot.shotType === "dialogue") {
        const character = project.analysis?.characters?.find((c) => c.id === shot.characterIds[0]);
        if (!character?.avatarId || !character?.voiceId) {
          return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "CHARACTER_BINDING_REQUIRED", message: `请先在角色卡为「${character?.name || "出场角色"}」绑定形象与音色` }));
        }
        if (!String(shot.dialogue || "").trim()) {
          return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "DIALOGUE_REQUIRED", message: "口播镜需要台词" }));
        }
        const seedance = ctx.seedanceStatus();
        if (!seedance.connected) {
          return sendJson(response, 503, envelope(false, null, { requestId, errorCode: seedance.state === "unauthorized" ? "SEEDANCE_UNAUTHORIZED" : "SEEDANCE_UNAVAILABLE", message: "Seedance 2.0 当前不可用" }));
        }
      } else {
        if (shot.frame.status !== "confirmed") {
          return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "FRAME_NOT_CONFIRMED", message: "剧情镜需要先确认首帧" }));
        }
        if (!loadVideoWorkflowTemplate(ctx.videoEnv || process.env)) {
          return sendJson(response, 503, envelope(false, null, { requestId, errorCode: "VIDEO_WORKFLOW_NOT_CONFIGURED", message: "请按接入说明配置剧情镜视频工作流模板（DRAMA_VIDEO_WORKFLOW 或 config/drama-video-workflow.json）" }));
        }
        const comfyui = await getComfyuiStatus(ctx.comfyConfig);
        if (!comfyui.connected) {
          return sendJson(response, 503, envelope(false, null, { requestId, errorCode: "COMFYUI_UNAVAILABLE", message: "未连接本机 ComfyUI 服务" }));
        }
      }
      generateShotClip(ctx, projectId, shot.id).catch(() => {});
      return sendJson(response, 202, envelope(true, { shotId: shot.id, status: "generating" }, { requestId }));
    }

    if (segments.length === 7 && segments[4] === "shots" && segments[6] === "video-confirm" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      const shot = project.shots.find((s) => s.id === segments[5]);
      if (!shot) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_SHOT_NOT_FOUND", message: "分镜不存在" }));
      if (normalizeClip(shot.clip).status !== "ready") {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "CLIP_NOT_READY", message: "视频尚未生成完成" }));
      }
      const updated = store.update(projectId, (p) => {
        const target = p.shots.find((s) => s.id === shot.id);
        target.clip = { ...normalizeClip(target.clip), status: "confirmed" };
        if (p.shots.every((s) => normalizeClip(s.clip).status === "confirmed")) p.status = "clips_ready";
      });
      return sendJson(response, 200, envelope(true, { project: updated }, { requestId }));
    }
```

- [ ] **Step 4: server.mjs 三处修改**

编辑 1 — `/drama-files/` 正则（server.mjs:1184 区域）扩展视频格式：

```javascript
  const dramaFileMatch = pathname.match(/^\/drama-files\/(drama-[a-f0-9-]+)\/([a-z0-9-]+\.(png|jpg|webp|mp4|webm))$/i);
```

编辑 2 — `providerHealth()`：把 comfyui 的探测提出来复用，并追加 dramaVideo。将 `comfyui: await getComfyuiStatus(comfyuiConfig)` 一行改为：

```javascript
    voicebox: await voiceboxHealth(),
    dramaLlm: await dramaLlmStatus(dramaLlmConfig),
    comfyui: comfyStatus,
    dramaVideo: {
      configured: hasVideoTemplate,
      connected: hasVideoTemplate && comfyStatus.connected,
      state: hasVideoTemplate ? comfyStatus.state : "template_missing"
    }
```

并在 `providerHealth` 函数体开头（`const seedance2 = getSeedanceStatus();` 之后）加：

```javascript
  const comfyStatus = await getComfyuiStatus(comfyuiConfig);
  const hasVideoTemplate = Boolean(loadVideoWorkflowTemplate());
```

server.mjs 顶部 import 从 `./lib/drama/comfyui.mjs` 追加 `loadVideoWorkflowTemplate`。

编辑 3 — `integrationContract` 的 integrations 数组末尾追加：

```javascript
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
```

`appApi` 数组末尾追加：

```javascript
      { method: "PATCH", path: "/api/drama/projects/{id}/characters/{charId}", purpose: "绑定角色形象与音色" },
      { method: "POST", path: "/api/drama/projects/{id}/shots/{shotId}/video", purpose: "生成或重生成分镜视频" }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test tests/*.test.mjs && npm run check && npm run smoke`
Expected: 全部 PASS（纯净环境 smoke 不受影响：dramaVideo configured=false）

- [ ] **Step 6: Commit**

```bash
git add lib/drama/routes.mjs server.mjs tests/drama-routes-video.test.mjs
git commit -m "feat: 分镜视频生成路由与执行器（口播 Seedance / 剧情 ComfyUI）"
```

---

### Task 6: 工作台 UI（角色绑定 + 逐镜视频）

**Files:**
- Modify: `public/drama.js`（角色卡绑定选择、shot 卡 clip 区、轮询条件、状态文案）
- Modify: `public/drama.html`（闸门卡加视频进度行）
- Modify: `public/styles.css`（追加，不改既有规则）

**Interfaces:**
- Consumes: Task 3 角色绑定接口；Task 5 视频接口与 `/drama-files/` mp4；`/api/avatars`、`/api/voices`。
- Produces（行为契约）:
  - 角色卡显示形象下拉（来自 /api/avatars，含自定义）与音色下拉（来自 /api/voices），变更即保存并 toast；口播镜绑定缺失时 shot 卡"生成视频"按钮禁用并提示
  - shot 卡 clip 区：`clip.file` 存在时渲染 `<video controls>`；按钮"生成视频"/"重新生成"（ready/confirmed 时先 `window.confirm("重新生成视频将产生额外费用，继续？")`，确认后带 `confirmCost: true`）；ready 时出现"确认视频"
  - 轮询条件追加任一 `clip.status === "generating"`
  - 状态文案：`videos: "视频生成中"`、`clips_ready: "全部视频已确认"`；闸门卡第二行进度"视频 已确认 N/M"；`clips_ready` 时完成横幅文案改为"全部视频已确认，M3 流程完成。时间线合成导出属于 M4。"
  - 新建项目重置（newProjectBtn）同步清空 clip 进度行

- [ ] **Step 1: drama.js 修改（按下列精确编辑）**

编辑 1 — state 追加资源目录（state 对象处）：

```javascript
const state = {
  project: null,
  projects: [],
  avatars: [],
  voices: [],
  pollTimer: null
};
```

编辑 2 — STATUS_LABEL 追加两个值：

```javascript
  videos: "视频生成中", clips_ready: "全部视频已确认",
```

编辑 3 — 页面加载尾部（`loadHealth(); loadProjects();` 处）追加资源加载：

```javascript
async function loadCatalogs() {
  try {
    const [avatars, voices] = await Promise.all([api("/api/avatars"), api("/api/voices")]);
    state.avatars = avatars.data.avatars || [];
    state.voices = (voices.data.voices || []).filter((v) => v.local || v.custom); // 口播镜只支持本地/自定义音色
  } catch { /* 目录加载失败不阻塞页面 */ }
}

loadHealth();
loadCatalogs();
loadProjects().catch(() => toast("项目列表加载失败", "请检查本地服务", "error"));
```

编辑 4 — `renderCharacters` 整个函数替换为：

```javascript
function renderCharacters(project) {
  const box = $("#characterList");
  box.innerHTML = "";
  const characters = project.analysis?.characters || [];
  if (!characters.length) {
    box.innerHTML = '<p class="muted">解析后生成</p>';
    return;
  }
  for (const character of characters) {
    const card = document.createElement("div");
    card.className = "character-item";
    const name = document.createElement("b");
    name.textContent = `${character.name} · ${character.role}`;
    const appearance = document.createElement("small");
    appearance.textContent = character.appearance;

    const avatarRow = document.createElement("label");
    avatarRow.className = "bind-row";
    avatarRow.append(document.createTextNode("形象"));
    const avatarSelect = document.createElement("select");
    const emptyAvatar = document.createElement("option");
    emptyAvatar.value = "";
    emptyAvatar.textContent = "未绑定";
    avatarSelect.append(emptyAvatar);
    for (const avatar of state.avatars) {
      const option = document.createElement("option");
      option.value = avatar.id;
      option.textContent = avatar.name;
      avatarSelect.append(option);
    }
    avatarSelect.value = character.avatarId || "";
    avatarSelect.addEventListener("change", () => saveCharacter(project, character.id, { avatarId: avatarSelect.value || null }));
    avatarRow.append(avatarSelect);

    const voiceRow = document.createElement("label");
    voiceRow.className = "bind-row";
    voiceRow.append(document.createTextNode("音色"));
    const voiceSelect = document.createElement("select");
    const emptyVoice = document.createElement("option");
    emptyVoice.value = "";
    emptyVoice.textContent = "未绑定";
    voiceSelect.append(emptyVoice);
    for (const voice of state.voices) {
      const option = document.createElement("option");
      option.value = voice.id;
      option.textContent = voice.name;
      voiceSelect.append(option);
    }
    voiceSelect.value = character.voiceId || "";
    voiceSelect.addEventListener("change", () => saveCharacter(project, character.id, { voiceId: voiceSelect.value || null }));
    voiceRow.append(voiceSelect);

    card.append(name, appearance, avatarRow, voiceRow);
    box.append(card);
  }
}

async function saveCharacter(project, charId, patch) {
  try {
    const { data } = await api(`/api/drama/projects/${project.id}/characters/${charId}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
    state.project = data.project;
    renderProject();
    toast("角色绑定已更新", "相关口播镜的旧成片已作废");
  } catch (error) {
    toast("绑定失败", error.message, "error");
    renderProject(); // 回退选择框显示
  }
}
```

编辑 5 — `buildShotCard` 在 `card.append(head, dialogue, action, prompt, frameBox, actions);` 之前插入 clip 区，并改动 append 行：

```javascript
  const clipBox = document.createElement("div");
  clipBox.className = "shot-clip";
  const clip = shot.clip || { status: "pending" };
  if (clip.file) {
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = `/drama-files/${project.id}/${clip.file}`;
    clipBox.append(video);
  }
  const clipActions = document.createElement("div");
  clipActions.className = "shot-actions";
  const videoBtn = document.createElement("button");
  videoBtn.className = "mini-btn";
  videoBtn.textContent = ["ready", "confirmed"].includes(clip.status) ? "重新生成视频" : "生成视频";
  videoBtn.disabled = !canGenerateVideo(project, shot) || clip.status === "generating";
  videoBtn.title = videoBlockReason(project, shot);
  videoBtn.addEventListener("click", () => generateVideo(project, shot));
  clipActions.append(videoBtn);
  if (clip.status === "generating") {
    const busy = document.createElement("small");
    busy.className = "muted";
    busy.textContent = "视频生成中…";
    clipActions.append(busy);
  }
  if (clip.status === "ready") {
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "mini-btn primary-mini";
    confirmBtn.textContent = "确认视频";
    confirmBtn.addEventListener("click", () => confirmVideo(project, shot.id));
    clipActions.append(confirmBtn);
  }
  if (clip.status === "confirmed") {
    const tag = document.createElement("span");
    tag.className = "badge confirmed";
    tag.textContent = "视频已确认";
    clipActions.append(tag);
  }
  if (clip.status === "failed") {
    const error = document.createElement("small");
    error.className = "error-text";
    error.textContent = clip.error?.message || "视频生成失败";
    clipActions.append(error);
  }
  clipBox.append(clipActions);

  card.append(head, dialogue, action, prompt, frameBox, actions, clipBox);
```

编辑 6 — `frameStatusText` 之后追加视频辅助函数：

```javascript
function boundCharacter(project, shot) {
  return project.analysis?.characters?.find((c) => c.id === shot.characterIds[0]) || null;
}

function videoBlockReason(project, shot) {
  if (!project.gateAConfirmedAt) return "请先确认预算闸门";
  if (shot.shotType === "dialogue") {
    const character = boundCharacter(project, shot);
    if (!character?.avatarId || !character?.voiceId) return "请先在角色卡绑定形象与音色";
    if (!String(shot.dialogue || "").trim()) return "口播镜需要台词";
    return "";
  }
  if (shot.frame.status !== "confirmed") return "剧情镜需要先确认首帧";
  return "";
}

function canGenerateVideo(project, shot) {
  return !videoBlockReason(project, shot);
}

async function generateVideo(project, shot) {
  const clip = shot.clip || { status: "pending" };
  const regen = ["ready", "confirmed"].includes(clip.status);
  if (regen && !window.confirm("重新生成视频将产生额外费用，继续？")) return;
  try {
    await api(`/api/drama/projects/${project.id}/shots/${shot.id}/video`, {
      method: "POST",
      body: JSON.stringify(regen ? { confirmCost: true } : {})
    });
    schedulePoll(true);
  } catch (error) {
    toast("视频生成失败", error.message, "error");
  }
}

async function confirmVideo(project, shotId) {
  try {
    const { data } = await api(`/api/drama/projects/${project.id}/shots/${shotId}/video-confirm`, { method: "POST", body: "{}" });
    state.project = data.project;
    renderProject();
  } catch (error) {
    toast("确认失败", error.message, "error");
  }
}
```

编辑 7 — 轮询条件（schedulePoll 内 busy 计算）追加 clip：

```javascript
  const busy = RUNNING_STATUSES.includes(project.status)
    || project.shots.some((s) => s.frame.status === "generating" || s.clip?.status === "generating");
```

编辑 8 — `renderGateB` 追加视频进度（函数末尾）：

```javascript
  const clipTotal = project.shots.length;
  const clipConfirmed = project.shots.filter((s) => s.clip?.status === "confirmed").length;
  $("#clipProgress").style.width = clipTotal ? `${(clipConfirmed / clipTotal) * 100}%` : "0%";
  $("#clipText").textContent = `${clipConfirmed} / ${clipTotal}`;
  if (project.status === "clips_ready") {
    $("#doneBanner").textContent = "全部视频已确认，M3 流程完成。时间线合成导出属于 M4。";
  }
```

（`renderGateB` 原有的 doneBanner toggle 保持不变；clips_ready 时它已因 `frames_confirmed` 逻辑隐藏——把既有 toggle 行的条件改为 `(total > 0 && ["frames_confirmed", "clips_ready"].includes(project.status))`，让横幅在两个终态都显示。）

编辑 9 — newProjectBtn 重置追加：

```javascript
  $("#clipProgress").style.width = "0%";
  $("#clipText").textContent = "0 / 0";
```

- [ ] **Step 2: drama.html 修改**

闸门卡（`gate-card`）内 gate-progress 行之后追加：

```html
            <div class="gate-progress"><span class="gate-label">视频</span><div class="progress"><i id="clipProgress"></i></div><span id="clipText">0 / 0</span></div>
```

并把第一行 gate-progress 改为带标签：

```html
            <div class="gate-progress"><span class="gate-label">首帧</span><div class="progress"><i id="gateBProgress"></i></div><span id="gateBText">0 / 0</span></div>
```

- [ ] **Step 3: styles.css 追加**

```css
.drama-body .shot-clip { display: flex; flex-direction: column; gap: 8px; }
.drama-body .shot-clip video { max-width: 100%; max-height: 320px; border-radius: 10px; background: #000; }
.drama-body .bind-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.drama-body .bind-row select { flex: 1; min-width: 0; }
.drama-body .gate-label { font-size: 12px; opacity: 0.6; width: 28px; }
```

- [ ] **Step 4: 验证**

```bash
npm run check && node --test tests/*.test.mjs && npm run smoke
PORT=4399 node server.mjs &
# 浏览器或 curl 走一遍：演示剧本 → 解析 → 角色卡出现形象/音色下拉
# 口播镜"生成视频"在未绑定时禁用且 title 提示绑定；剧情镜提示先确认首帧
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add public/drama.js public/drama.html public/styles.css
git commit -m "feat: 短剧页角色资产绑定与逐镜视频生成/确认"
```

---

### Task 7: 冒烟扩展与配置/文档收尾

**Files:**
- Modify: `scripts/smoke.mjs`（角色绑定 + 视频路由 503 断言）
- Modify: `.env.example`（视频模板与超时）
- Modify: `.gitignore`（config/drama-video-workflow.json）
- Modify: `docs/INTEGRATION-CONTRACT.md`（视频工作流行 + 两条 API）
- Modify: `docs/ARCHITECTURE.md`（一行更新）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 无新接口；`npm test` 全绿。

- [ ] **Step 1: smoke.mjs 追加（drama 链路内，frame 503 断言之后）**

```javascript
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
```

console.log 对象追加：`dramaVideoGate: videoNoBindingBody.errorCode,`

注意速率预算：smoke 全程写请求约 12 次，已达 allowRequest 60 秒 12 次上限边缘——把这两个新请求计入后若超限，将既有 drama 段的 `wait(250)` 轮询上限保持 40 次不变即可（轮询是 GET 不限流）；如实际运行触发 429，在 drama 段开头加一行 `await wait(1000)` 无妨，但先按不超时实现并实测。

- [ ] **Step 2: .env.example 追加**

```bash
# 短剧工作台：剧情镜视频工作流模板（ComfyUI 导出的 API 格式 JSON）
DRAMA_VIDEO_WORKFLOW=
COMFYUI_VIDEO_TIMEOUT_MS=
```

- [ ] **Step 3: .gitignore 追加（config 私有文件段）**

```gitignore
config/drama-video-workflow.json
```

- [ ] **Step 4: docs 更新**

`docs/INTEGRATION-CONTRACT.md` 表格追加一行：

```markdown
| 剧情镜视频工作流 | ComfyUI 模板（MiniMax H3 等图生视频） | 可选 | `DRAMA_VIDEO_WORKFLOW` | 注入已确认首帧与运动提示词后提交本机 ComfyUI 生成剧情镜视频 |
```

API 表追加：

```markdown
| `PATCH` | `/api/drama/projects/{id}/characters/{charId}` | 绑定角色形象与音色 |
| `POST` | `/api/drama/projects/{id}/shots/{shotId}/video` | 生成或重生成分镜视频（重生成需 confirmCost） |
```

`docs/ARCHITECTURE.md` 的 lib/drama 一行改写为：

```markdown
- `lib/drama/` contains the short-drama workbench: schema/store, LLM pipeline stages, budget estimation, ComfyUI adapters (first-frame and template-based video) and shot-level video orchestration. `lib/seedance.mjs` holds the Seedance generation machinery shared by the talking-head page and drama dialogue shots. Drama state lives in `data/drama-projects/` and follows the same privacy rules as other local data.
```

- [ ] **Step 5: 全量验证**

Run: `npm test`
Expected: 全绿；smoke 输出含 `dramaVideoGate` 字段且退出码 0

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke.mjs .env.example .gitignore docs/INTEGRATION-CONTRACT.md docs/ARCHITECTURE.md
git commit -m "test: 短剧视频生成零费用冒烟与接入文档更新"
```

---

## Self-Review 记录

**Spec 覆盖：**
- 口播镜复用 Seedance（抽取共享库、时长跟随分镜档位）→ Task 1 + Task 5 ✓
- 剧情镜 ComfyUI 模板图生视频（不臆造 H3 节点 schema）→ Task 4 + Task 5 ✓
- 角色卡绑定 avatar+voice → Task 2（字段）+ Task 3（路由）+ Task 6（UI）✓
- clip 状态机 + 重启孤儿归置 → Task 2 + Task 5 ✓
- 取消独立 TTS（Seedance/H3 原生出声；导演时长直接驱动）→ Task 2 预算修正 + 设计裁决 1 ✓
- 零费用红线（伪 runner 夹具、fake fetch、503 短路、smoke 断言）→ 各任务 + Task 7 ✓
- 费用纪律（重生成逐镜 confirmCost、换绑作废、失败不自动重试）→ Task 3/5 ✓

**类型一致性：** `normalizeClip` 白名单（schema/store/routes/UI 一致使用）；`ctx.seedanceConfig/seedanceStatus/findAvatar/findVoice/videoEnv` 键名在 server 挂载、路由、测试夹具三处一致；`generateShotClip(ctx, projectId, shotId)` 在 routes 与测试一致；clip 五态与 frame 五态对齐；`/video` 与 `/video-confirm` 段长（7）与现有 frame/confirm 一致。

**已知取舍（M3 外）：** M4 FFmpeg 时间线合成（clips_ready 后的导出）；H3 参考图视频（reference-to-video 角色一致性增强，模板已支持自定义）；VLM 画面审核（M5）；口播镜多角色同镜（当前取 characterIds[0]）；云端 ElevenLabs 音色绑定（仅本地/自定义，与 Seedance 参考音通道一致）。

**风险提示（给审查者）：** Task 1 是行为保持型重构——口播页 final_video 的进度数值（5/16/35/42+2n）、result 形状、错误码集合必须与重构前一致；无凭据无法端到端回归真实 Seedance，靠伪 runner 单测 + smoke promptPreview 间接覆盖 + diff 逐行核对。

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-09-ai-drama-m3-video-generation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
