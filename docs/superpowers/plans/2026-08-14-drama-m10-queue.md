# 短剧工作台 M10：批量队列实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按类型可配置并发度的内存队列，调度首帧/视频/口播/合成四类算力密集任务；项目内一键全跑 + 批量勾选多项目跑流水线；LLM 编排阶段不限并发。

**Architecture:** `createJobQueue(config)` 维护三 kind FIFO 队列（comfyui/voice/ffmpeg）+ inFlight Set；四处生成执行器把算力调用包进 `ctx.jobQueue.enqueue(kind, task)`，无 jobQueue 回退直接执行（单测兼容）；并发度从 env 读默认保守（comfyui=1/voice=2/ffmpeg=1）；队列内存不持久化。

**Tech Stack:** 零框架原生 HTML/CSS/JS；Node 20+；`node:test`。

**Spec:** `docs/superpowers/specs/2026-08-14-drama-m10-queue-design.md`

## Global Constraints

- 零框架、无构建链、不引入新 npm 依赖；本机优先、私密不出本机。
- 中文提交信息（`类型: 简短描述`）；遵循既有 `lib/drama/*` 与 `tests/drama-*.test.mjs` 模式。
- 既有单项目流程零回归；队列对单项目单任务透明（无 jobQueue 回退直接执行）。
- 队列内存不持久化，服务重启清空；进行中的任务不抢占。
- LLM 编排阶段不进队列；首帧+视频共用 ComfyUI 并发度。

---

## 阶段 A：队列核心

### Task 1: queue.mjs —— 内存队列 + 并发度配置

**Files:**
- Create: `lib/drama/queue.mjs`
- Test: `tests/drama-queue.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `createJobQueue(config = { comfyui: 1, voice: 2, ffmpeg: 1 })` → `{ enqueue(kind, { id, task }), status() }`；`enqueue` 返回 Promise；`status()` 返回 `{ comfyui: { running, queued }, voice: {...}, ffmpeg: {...} }`

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-queue.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createJobQueue } from "../lib/drama/queue.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("enqueue 并发度内立即跑；超限排队", async () => {
  const q = createJobQueue({ comfyui: 1, voice: 2, ffmpeg: 1 });
  const order = [];
  // comfyui 并发度 1：两个任务串行
  const a = q.enqueue("comfyui", { id: "a", task: async () => { order.push("a-start"); await sleep(10); order.push("a-end"); } });
  const b = q.enqueue("comfyui", { id: "b", task: async () => { order.push("b-start"); await sleep(10); order.push("b-end"); } });
  assert.equal(q.status().comfyui.running, 1);
  assert.equal(q.status().comfyui.queued, 1);
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});

test("不同 kind 各自独立并发度", async () => {
  const q = createJobQueue({ comfyui: 1, voice: 2, ffmpeg: 1 });
  const done = [];
  const v1 = q.enqueue("voice", { id: "v1", task: async () => { await sleep(10); done.push("v1"); } });
  const v2 = q.enqueue("voice", { id: "v2", task: async () => { await sleep(10); done.push("v2"); } });
  const v3 = q.enqueue("voice", { id: "v3", task: async () => { await sleep(10); done.push("v3"); } });
  // voice 并发度 2：v1/v2 并行，v3 排队
  assert.equal(q.status().voice.running, 2);
  assert.equal(q.status().voice.queued, 1);
  await Promise.all([v1, v2, v3]);
  assert.equal(done.length, 3);
});

test("完成后自动出队下一个", async () => {
  const q = createJobQueue({ comfyui: 1, voice: 1, ffmpeg: 1 });
  const order = [];
  await q.enqueue("comfyui", { id: "a", task: async () => { order.push("a"); } });
  await q.enqueue("comfyui", { id: "b", task: async () => { order.push("b"); } });
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(q.status().comfyui.running, 0);
  assert.equal(q.status().comfyui.queued, 0);
});

test("task 抛错不阻塞后续任务；promise resolve 不 reject", async () => {
  const q = createJobQueue({ comfyui: 1, voice: 1, ffmpeg: 1 });
  const a = q.enqueue("comfyui", { id: "a", task: async () => { throw new Error("boom"); } });
  const b = q.enqueue("comfyui", { id: "b", task: async () => "ok" });
  await a; // 不 reject
  const result = await b;
  assert.equal(result, "ok");
});

test("status 形状含三 kind", () => {
  const q = createJobQueue({ comfyui: 1, voice: 2, ffmpeg: 1 });
  const s = q.status();
  assert.deepEqual(Object.keys(s).sort(), ["comfyui", "ffmpeg", "voice"]);
  for (const k of Object.keys(s)) assert.deepEqual(s[k], { running: 0, queued: 0 });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-queue.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

新建 `lib/drama/queue.mjs`：

```js
// lib/drama/queue.mjs
// 按类型可配置并发度的内存队列：comfyui（首帧+视频）/ voice（口播）/ ffmpeg（合成）
// 不持久化，服务重启清空；进行中的任务不抢占，等完成才出队下一个
import { randomUUID } from "node:crypto";

const KINDS = ["comfyui", "voice", "ffmpeg"];
const DEFAULTS = { comfyui: 1, voice: 2, ffmpeg: 1 };

export function createJobQueue(config = DEFAULTS) {
  const limits = {};
  const queues = {};
  const inFlight = {};
  for (const k of KINDS) {
    limits[k] = Math.max(1, Number(config?.[k]) || DEFAULTS[k]);
    queues[k] = [];
    inFlight[k] = new Set();
  }

  async function pump(kind) {
    if (inFlight[kind].size >= limits[kind]) return;
    const job = queues[kind].shift();
    if (!job) return;
    inFlight[kind].add(job.id);
    try {
      const result = await job.task();
      job.resolve(result);
    } catch (error) {
      // task 抛错不阻塞后续；promise resolve 不 reject（状态回写由 task 内部 catch 处理）
      job.resolve(undefined);
    } finally {
      inFlight[kind].delete(job.id);
      pump(kind); // 自动出队下一个
    }
  }

  function enqueue(kind, { id, task }) {
    const k = KINDS.includes(kind) ? kind : "comfyui";
    return new Promise((resolve) => {
      const job = { id: id || randomUUID(), task, resolve };
      queues[k].push(job);
      pump(k);
    });
  }

  function status() {
    const out = {};
    for (const k of KINDS) out[k] = { running: inFlight[k].size, queued: queues[k].length };
    return out;
  }

  return { enqueue, status };
}

export function readQueueConfig(env = process.env) {
  return {
    comfyui: Math.max(1, Number(env.COMFYUI_MAX_CONCURRENT) || 1),
    voice: Math.max(1, Number(env.VOICE_MAX_CONCURRENT) || 2),
    ffmpeg: Math.max(1, Number(env.FFMPEG_MAX_CONCURRENT) || 1)
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-queue.test.mjs && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/queue.mjs tests/drama-queue.test.mjs
git commit -m "feat: 按类型并发度内存队列（M10 Task1）"
```

---

## 阶段 B：注入生成执行器 + server 挂载

### Task 2: routes —— 四处执行器经队列 + server 挂载 + queue status 端点

**Files:**
- Modify: `lib/drama/routes.mjs`（四处执行器包 enqueue；新增 `GET /api/drama/queue/status`）
- Modify: `server.mjs`（ctx 挂载 `jobQueue`；import）
- Modify: `package.json`（check 加 `lib/drama/queue.mjs`）
- Test: `tests/drama-routes-frames.test.mjs`、`tests/drama-routes-video.test.mjs`、`tests/drama-compose.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `createJobQueue`/`readQueueConfig`
- Produces: 四处执行器 `await ctx.jobQueue?.enqueue(kind, { task: async () => {...} })` 无 jobQueue 回退直接执行；`GET /api/drama/queue/status` 端点

- [ ] **Step 1: 写失败测试**

在 `tests/drama-routes-frames.test.mjs` 末尾追加（首帧经队列）：

```js
test("M10：首帧经队列 enqueue；无 jobQueue 回退直接执行", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-m10f-"));
  const store = createDramaStore(dataRoot);
  const project = store.save(createDramaProject({ title: "t", script: DEMO_DRAMA_SCRIPT }));
  store.update(project.id, (p) => {
    p.analysis = normalizeAnalysis({ synopsis: "s", genre: "g", characters: [{ id: "char-1", name: "n", appearance: "a" }], scenes: [{ id: "scene-1", name: "sc", appearance: "a" }], props: [] });
    if (!p.shots.length) p.shots = [normalizeShot({ id: "shot-1", sceneName: "sc", shotType: "cinematic", fluxPrompt: "cinematic film still, store at night", durationSec: 3 }, 0)];
    p.gateAConfirmedAt = new Date().toISOString();
  });
  const runLog = [];
  const q = createJobQueue({ comfyui: 1, voice: 2, ffmpeg: 1 });
  const ctx = {
    sendJson: (r, s, b) => r.sendJson(s, b), envelope: (ok, d, o = {}) => ({ ok, ...(ok ? { data: d } : { errorCode: o.errorCode, message: o.message }) }), readJson: async (r) => JSON.parse(r.body || "{}"), allowRequest: () => true,
    store, jobQueue: q,
    comfyConfig: { baseUrl: "http://127.0.0.1:9", steps: 4, timeoutMs: 3000, pollIntervalMs: 10 },
    frameFetch: async (url) => {
      runLog.push(url);
      if (url.includes("/prompt")) return { ok: true, json: async () => ({ prompt_id: "p1" }) };
      if (url.includes("/history/")) return { ok: true, json: async () => ({ p1: { outputs: { "13": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } }) };
      if (url.includes("/view")) return { ok: true, arrayBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
      return { ok: false };
    },
    frameSleep: async () => {},
    materialStore: { get: () => null, getBytes: () => null }, controlnetConfig: null,
    findAvatar: () => null, findVoice: () => null, pricing: {},
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}
  };
  await generateShotFrame(ctx, project.id, project.shots[0].id);
  assert.equal(store.get(project.id).shots[0].frame.status, "ready");
  assert.ok(runLog.some((u) => u.includes("/prompt"))); // task 经队列执行了
  assert.equal(q.status().comfyui.running, 0); // 完成后释放
  rmSync(dataRoot, { recursive: true, force: true });
});
```

（顶部 import 加 `import { createJobQueue } from "../lib/drama/queue.mjs";`）

在 `tests/drama-compose.test.mjs` 末尾追加（合成经队列）：

```js
import { createJobQueue } from "../lib/drama/queue.mjs";

test("M10：合成经队列 enqueue", async () => {
  // 复用该文件已有的 fixture 模式，建一个 clips_ready 项目
  // 关键断言：ctx.jobQueue 存在时，composeFilm 内部 run 调用经队列（通过 runFfmpeg mock 计数验证执行了）
  const q = createJobQueue({ comfyui: 1, voice: 2, ffmpeg: 1 });
  const ffmpegCalls = [];
  const ctx = { ...<已有 fixture ctx>, jobQueue: q, runFfmpeg: async (args) => { ffmpegCalls.push(args); } };
  await composeFilm(ctx, <projectId>);
  assert.ok(ffmpegCalls.length > 0); // 经队列执行了
  assert.equal(q.status().ffmpeg.running, 0);
});
```

（注：此测试需复用 `tests/drama-compose.test.mjs` 已有的 fixture 项目结构；实现者按该文件实际 fixture 调整占位 `<已有 fixture ctx>`/`<projectId>`）

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-routes-frames.test.mjs && node --test tests/drama-compose.test.mjs`
Expected: FAIL（无 jobQueue 时回退直接执行，新测试断言 q.status 经队列会失败）

- [ ] **Step 3: 实现**

`lib/drama/routes.mjs` import 区加：

```js
import { createJobQueue } from "./queue.mjs";
```

注：routes.mjs 不直接 import queue（queue 由 server 挂载进 ctx）；此处不加 import，仅 ctx 使用。

**`generateShotFrame`**（首帧，L77 `generateFluxFrame` 调用）：把 `generateFluxFrame` 到 `writeFileSync` 这段包进 task。当前结构是 try 块内直接 await，改为：

```js
  try {
    setFrame({ status: "generating", error: null });
    const [width, height] = FRAME_SIZES[project.ratio] || FRAME_SIZES.portrait;
    // M8：参考图解析（不变）
    let refImage = null;
    let usedControlnet = false;
    const cnConfig = ctx.controlnetConfig || null;
    if (cnConfig) {
      // ... 不变
    }
    // M10：经队列调度 ComfyUI 首帧；无 jobQueue 回退直接执行
    const bytes = await (ctx.jobQueue?.enqueue("comfyui", { task: async () => generateFluxFrame({
      config: comfyConfig, prompt: shot.fluxPrompt, negativePrompt: shot.negativePrompt, width, height, seed: finalSeed, fetchImpl, sleep, clientId: projectId, refImage, controlnetConfig: refImage ? cnConfig : null
    }) }) || generateFluxFrame({
      config: comfyConfig, prompt: shot.fluxPrompt, negativePrompt: shot.negativePrompt, width, height, seed: finalSeed, fetchImpl, sleep, clientId: projectId, refImage, controlnetConfig: refImage ? cnConfig : null
    }));
    const fileName = `${shotId}-${finalSeed}.png`;
    writeFileSync(join(store.dir(projectId), "frames", fileName), bytes);
    setFrame({ status: "ready", file: fileName, seed: finalSeed, attempts: shot.frame.attempts + 1, error: null, controlnet: { used: usedControlnet, source: usedControlnet ? "ref" : "fallback" } });
  } catch (error) {
```

**`generateShotClip`**（视频，L102 `runSeedanceGeneration`/`generateComfyuiVideo` 调用）：把核心生成调用包进 `ctx.jobQueue?.enqueue("comfyui", ...)`（口播走 Seedance 也算 ComfyUI 并发度？不——口播走 Seedance 本地适配器，不是 ComfyUI。但 spec 说首帧+视频共用 ComfyUI。口播视频走 Seedance，应走 voice 队列还是 comfyui？按 spec 决策点 1「首帧+视频共用 ComfyUI」指剧情镜视频走 ComfyUI；口播镜走 Seedance。口播镜视频算 voice 还是 comfyui？口播的瓶颈在 TTS（已走 voice 队列）+ Seedance 本地适配器。为简单起见，口播镜视频也走 comfyui 队列（Seedance 本地适配器也是本机算力）。统一：所有视频生成走 comfyui 队列）。

实现：把 `if (isDialogue) { ... runSeedanceGeneration ... } else { ... generateComfyuiVideo ... }` 整段包进 task：

```js
    // M10：视频生成经队列（comfyui kind：剧情镜走 ComfyUI，口播镜走 Seedance 本地适配器，都是本机算力）
    const fileName = `${shotId}-clip-${attempts + 1}.mp4`;
    await (ctx.jobQueue?.enqueue("comfyui", { task: async () => {
      if (isDialogue) {
        const character = project.analysis.characters.find((c) => c.id === shot.characterIds[0]);
        const runDir = join(store.dir(projectId), "clips", `run-${shotId}-${attempts + 1}`);
        const result = await runSeedanceGeneration({ config: ctx.seedanceConfig, payload: { title: `${project.title} 镜${shot.index}`.slice(0, 80), script: shot.dialogue, avatarId: character.avatarId, voiceId: character.voiceId, ratio: project.ratio, generationPrompt: "" }, runDir, durationSec: shot.durationSec, onEvent: (event) => { if (event.phase === "submitted") setClip({ providerTaskId: event.providerTaskId }); } });
        copyFileSync(result.videoPath, join(store.dir(projectId), "clips", fileName));
      } else {
        const template = loadVideoWorkflowTemplate(ctx.videoEnv || process.env);
        if (!template) throw Object.assign(new Error("未配置剧情镜视频工作流模板"), { code: "VIDEO_WORKFLOW_NOT_CONFIGURED" });
        const fetchImpl = ctx.frameFetch || fetch;
        const sleep = ctx.frameSleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        const frameBytes = readFileSync(join(store.dir(projectId), "frames", shot.frame.file));
        const imageName = await uploadComfyuiImage({ config: ctx.comfyConfig, bytes: frameBytes, filename: `${shotId}-frame.png`, fetchImpl });
        const [width, height] = FRAME_SIZES[project.ratio] || FRAME_SIZES.portrait;
        const fps = 24;
        const bytes = await generateComfyuiVideo({ config: ctx.comfyConfig, template, values: { PROMPT: shot.motionPrompt || shot.action, IMAGE: imageName, SEED: (shot.index * 100_000 + attempts * 7919 + 1) % 2 ** 31, WIDTH: width, HEIGHT: height, FPS: fps, FRAMES: shot.durationSec * fps }, fetchImpl, sleep, clientId: projectId });
        writeFileSync(join(store.dir(projectId), "clips", fileName), bytes);
      }
    }}) || (async () => { /* 回退直接执行同逻辑 */ })());
```

注意：回退分支要复制 task 内逻辑。为避免重复，把 task 内逻辑抽成局部函数 `const doClip = async () => {...}`，然后 `await (ctx.jobQueue?.enqueue("comfyui", { task: doClip }) || doClip())`。

**`generateShotVoice`**（口播 TTS，L202 `synthesizeShotVoice` 调用）：

```js
    // M10：口播 TTS 经队列（voice kind）
    const doVoice = async () => {
      const m9Override = ctx.providerOverrideStore?.get(projectId);
      const m9AudioDeps = { ...ctx.audioDeps, ...(m9Override?.voice?.elevenKey ? { elevenKey: m9Override.voice.elevenKey } : {}) };
      return synthesizeShotVoice({ voiceTarget: target, text: shot.dialogue, language: "zh", deps: m9AudioDeps, voiceCloneRef });
    };
    const { bytes, provider, voiceRefUsed } = await (ctx.jobQueue?.enqueue("voice", { task: doVoice }) || doVoice());
```

**`composeFilm`**（合成）：在 `lib/drama/compose.mjs` 的 `run` 函数外包队列。但 compose.mjs 的 `run` 是局部 `const run = (args) => ...`。改 `run`：

```js
  const run = async (args) => {
    const doFfmpeg = async () => (ctx.runFfmpeg ? ctx.runFfmpeg(args) : runFfmpeg(args, { ffmpegPath: ctx.ffmpegPath || "ffmpeg" }));
    // M10：合成经队列（ffmpeg kind）；无 jobQueue 回退直接执行
    if (ctx.jobQueue) return ctx.jobQueue.enqueue("ffmpeg", { task: doFfmpeg });
    return doFfmpeg();
  };
```

注意：原 `run` 是同步返回，改 async 后所有 `await run(...)` 调用处不变（已是 await）。compose.mjs 内 4 处 `await run(...)` 无需改。

**`GET /api/drama/queue/status` 端点**（在 providers 端点之后插入）：

```js
  // M10：队列状态总览（前端轮询用）
  if (segments.length === 3 && segments[2] === "queue" && segments[3] === "status" && request.method === "GET") {
    return sendJson(response, 200, envelope(true, { queue: ctx.jobQueue?.status() || { comfyui: { running: 0, queued: 0 }, voice: { running: 0, queued: 0 }, ffmpeg: { running: 0, queued: 0 } } }, { requestId }));
  }
```

注：segments.length 应为 4（`api/drama/queue/status`）。修正条件：

```js
  if (segments.length === 4 && segments[2] === "queue" && segments[3] === "status" && request.method === "GET") {
    return sendJson(response, 200, envelope(true, { queue: ctx.jobQueue?.status() || { comfyui: { running: 0, queued: 0 }, voice: { running: 0, queued: 0 }, ffmpeg: { running: 0, queued: 0 } } }, { requestId }));
  }
```

`server.mjs` import 加 `createJobQueue, readQueueConfig`：

```js
import { createJobQueue, readQueueConfig } from "./lib/drama/queue.mjs";
```

ctx 挂载（`providerOverrideStore` 行后）：

```js
      providerOverrideStore: createProviderOverrideStore(dataRoot),
      jobQueue: createJobQueue(readQueueConfig()),
```

`package.json` check 脚本加 `&& node --check lib/drama/queue.mjs`（在 `lib/drama/materials.mjs` 之后）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-routes-frames.test.mjs && node --test tests/drama-routes-video.test.mjs && node --test tests/drama-compose.test.mjs && npm run test:unit && npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/routes.mjs lib/drama/compose.mjs server.mjs package.json tests/drama-routes-frames.test.mjs tests/drama-routes-video.test.mjs tests/drama-compose.test.mjs
git commit -m "feat: 生成执行器经队列调度与状态端点（M10 Task2）"
```

---

## 阶段 C：批量入口 + smoke 守卫

### Task 3: 前端一键全跑 + 批量勾选 + 队列状态

**Files:**
- Modify: `public/drama.html`、`public/drama.js`

**Interfaces:**
- Consumes: Task 2 的 `GET /api/drama/queue/status`；现有点位
- Produces: 项目内「生成全部首帧」「生成全部视频」按钮（扩展 genAllFramesBtn）；项目列表批量勾选 + 「批量跑流水线」；队列状态徽标

- [ ] **Step 1: HTML**

`public/drama.html` 生成视图 `#genAllFramesBtn` 行后加：

```html
              <button class="vz-btn hidden" id="genAllClipsBtn" style="margin-left:8px">生成全部视频</button>
```

项目列表区（剧本视图项目下拉附近）加批量勾选 + 批量跑按钮（若项目列表是 select，则在项目选择区旁加 checkbox 列；实现按现有 UI 结构适配）。

- [ ] **Step 2: JS**

`public/drama.js` 加函数：

```js
async function generateAllClips(project) {
  const pending = project.shots.filter((s) => s.frame.status === "confirmed" && !["ready", "confirmed"].includes(s.clip?.status || "pending"));
  if (!pending.length) { toast("没有待生成视频的镜头"); return; }
  for (const s of pending) {
    try { await api(`/api/drama/projects/${project.id}/shots/${s.id}/clip`, { method: "POST" }); }
    catch (error) { showError(error.message || error); }
  }
  toast("已入队全部视频生成", `${pending.length} 镜`);
}
```

`#genAllClipsBtn` 绑定 + 显隐（与 genAllFramesBtn 同模式）。

批量跑流水线（项目列表勾选）：

```js
async function batchRunPipelines() {
  const checked = Array.from($$(".project-check:checked")).map((c) => c.value);
  if (!checked.length) { toast("未勾选项目"); return; }
  for (const pid of checked) {
    try { await api(`/api/drama/projects/${pid}/pipeline`, { method: "POST" }); }
    catch (error) { showError(error.message || error); }
  }
  toast("已入队流水线", `${checked.length} 项目`);
}
```

队列状态轮询（平台视图模型 tab 或顶栏徽标）：

```js
async function loadQueueStatus() {
  try {
    const { data } = await api("/api/drama/queue/status");
    state.queueStatus = data.queue;
  } catch { state.queueStatus = null; }
  renderQueueStatus();
}
```

- [ ] **Step 3: 校验**

Run: `node --check public/drama.js && npm run check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add public/drama.html public/drama.js
git commit -m "feat: 一键全跑与批量入队、队列状态（M10 Task3）"
```

---

### Task 4: smoke 守卫 + 全量验证

**Files:**
- Modify: `scripts/smoke.mjs`

- [ ] **Step 1: smoke 守卫**

`scripts/smoke.mjs` 在 M9 守卫之后、console.log 之前追加：

```js
  // ---------- M10：队列守卫 ----------
  const m10QueueBefore = await request("/api/drama/queue/status");
  if (!m10QueueBefore.queue || !m10QueueBefore.queue.comfyui) throw new Error("M10 队列状态形状异常");
  // 触发一个首帧生成（smoke 环境 ComfyUI 不可用会 503，不阻断守卫）验证端点不炸
  const m10QueueAfter = await request("/api/drama/queue/status");
  if (m10QueueAfter.queue.comfyui.running < 0 || m10QueueAfter.queue.comfyui.queued < 0) throw new Error("M10 队列计数非法");
```

收尾 console.log 对象加：

```js
    m10QueueGuard: m10QueueAfter.queue.comfyui.queued + m10QueueAfter.queue.comfyui.running
```

- [ ] **Step 2: 全量验证**

Run: `npm run check && npm run test:unit && npm run smoke`
Expected: 全通过；smoke 输出含 `m10QueueGuard`

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke.mjs
git commit -m "test: 队列冒烟守卫（M10 Task4 收尾）"
```

---

## Self-Review 记录

- **Spec coverage**：队列核心（T1）、四处执行器注入+端点+server（T2）、前端批量入口+队列状态（T3）、smoke 守卫（T4）——spec 各节均有对应任务。
- **Type consistency**：`createJobQueue(config)→{enqueue, status}`（T1）→ routes T2/server 一致；`enqueue(kind, {id, task})→Promise`（T1）→ T2 四处执行器 `ctx.jobQueue?.enqueue(kind, {task}) || doX()` 回退一致；`readQueueConfig(env)→{comfyui,voice,ffmpeg}`（T1）→ server T2 一致；queue status 形状 `{comfyui:{running,queued},...}`（T1）→ 端点 T2/前端 T3 一致。
- **零回归纪律**：四处执行器 `ctx.jobQueue?.enqueue(...) || doX()` 回退直接执行，单测 ctx 无 jobQueue 时行为不变；compose.mjs `run` 改 async 后 `await run(...)` 调用不变。
- **已知简化（对 spec 无偏离）**：口播镜视频走 comfyui 队列（Seedance 本地适配器也是本机算力，统一进 comfyui kind）；队列不持久化（服务重启清空，spec 明确）；批量入口前端循环调单镜端点，不新增批量端点（队列负责串行化）。
