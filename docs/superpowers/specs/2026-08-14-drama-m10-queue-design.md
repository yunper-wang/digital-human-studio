# 短剧工作台 M10：批量队列设计文档

- 日期：2026-08-14
- 状态：已评审（脑暴确认 4 个决策点 A/A/A/A）
- 范围：M10 —— 按类型可配置并发度的内存队列，调度首帧/视频/口播/合成四类算力密集任务；批量入口
- 前置：M1–M9 已完成

## 背景与目标

M9 让多项目能用不同模型组合，但生成阶段仍是「用户手动一个个跑」：

- 首帧/视频/口播/合成都是单个 shot 单独触发，没有批量调度。
- 跨项目同时触发会真并行跑，本机 ComfyUI（首帧+视频）和 FFmpeg（合成）算力受限会互相拖慢。
- LLM 编排阶段走云端 API，瓶颈不在本机，不需要限并发。

M10 引入按类型可配置并发度的内存队列：

- **首帧/视频**（都走 ComfyUI）共用 `COMFYUI_MAX_CONCURRENT`（默认 1）
- **口播**走 `VOICE_MAX_CONCURRENT`（默认 2，云端瓶颈小）
- **合成**走 `FFMPEG_MAX_CONCURRENT`（默认 1）
- LLM 编排阶段不限并发（云端，不进队列）

## 已确认决策与隐含假设

| 决策点 | 结论 |
| --- | --- |
| 队列粒度 | **只管算力瓶颈的生成阶段**：首帧/视频/口播/合成四类进队列；LLM 编排阶段不限并发 |
| 并发度 | **按类型 env 可配置**：COMFYUI_MAX_CONCURRENT（首帧+视频）、FFMPEG_MAX_CONCURRENT、VOICE_MAX_CONCURRENT；默认保守 |
| 队列存储 | **内存队列不持久化**：运行期调度状态，服务重启清空，与现有 running Set 同模式 |
| 批量入口 | **项目内一键全跑 + 视图批量勾选**：项目内「生成所有未完成首帧/视频」（已有 genAllFramesBtn 雏形扩展）；项目列表批量勾选 + 批量跑流水线 |

**隐含假设**：进行中的任务不抢占，等完成才出队下一个；队列对单项目透明（单项目单任务走队列不阻塞，等价于直接执行）。

## 核心数据模型

**无新顶层存储**。队列是内存状态。

**队列状态**（`createJobQueue(config)` 返回的实例内部）：

```
queue { comfyui: [job...], voice: [job...], ffmpeg: [job...], inFlight: { comfyui: Set, voice: Set, ffmpeg: Set } }
job { id, kind, projectId, shotId?, task: () => Promise }
```

**job 状态查询**（供前端轮询）：

```
GET /api/drama/queue/status → { comfyui: { running: N, queued: M }, voice: {...}, ffmpeg: {...} }
```

## 模块划分

- `lib/drama/queue.mjs` — **新建**：`createJobQueue(config)` → `{ enqueue(kind, job), status() }`；按 kind 维护 FIFO 队列 + inFlight Set，并发度达上限时排队，完成后自动出队。
- `lib/drama/routes.mjs` — `generateShotFrame`/`generateShotClip`/`generateShotVoice`/`composeFilm` 四处触发改为经队列调度（ctx.jobQueue.enqueue）；新增批量端点 + queue status 端点。
- `lib/drama/pipeline.mjs` — 流水线本身不进队列（LLM 阶段不限并发），但首帧/视频触发的子任务经队列。
- `server.mjs` — ctx 挂载 `jobQueue: createJobQueue(...)`；并发度从 env 读。
- 前端 `drama.js`/`drama.css` — 项目内「生成全部」按钮扩展到首帧+视频；项目列表批量勾选 + 批量跑流水线；队列状态徽标。

## 阶段 A：队列核心

### queue.mjs

`createJobQueue(config)` → `{ enqueue, status }`：

- **config**：`{ comfyui: 1, voice: 2, ffmpeg: 1 }`（并发度上限）。
- **queues**：`{ comfyui: [], voice: [], ffmpeg: [] }`（FIFO 待跑）。
- **inFlight**：`{ comfyui: Set, voice: Set, ffmpeg: Set }`（运行中 job id）。
- `enqueue(kind, { id, task })`：返回 Promise。若 inFlight[kind].size < limit，立即跑；否则入队，等前面完成自动出队。
- `status()`：返回每 kind 的 `{ running, queued }`。
- **kind 合法值**：`comfyui | voice | ffmpeg`。

### 并发度配置（env）

| env | 默认 | 管 |
| --- | --- | --- |
| `COMFYUI_MAX_CONCURRENT` | 1 | 首帧 + 视频（都走 ComfyUI） |
| `VOICE_MAX_CONCURRENT` | 2 | 口播 TTS |
| `FFMPEG_MAX_CONCURRENT` | 1 | 合成 |

未配置走默认；非法值走默认。

## 阶段 B：注入生成执行器

### routes.mjs 改动

四处生成执行器当前直接 `await`，改为 `await ctx.jobQueue?.enqueue(kind, { task: async () => {...} }) || 直接执行`（队列不存在时回退直接执行，兼容单测 ctx 不传 jobQueue）。

- **`generateShotFrame`**（首帧）：kind=`comfyui`，把 `generateFluxFrame` 调用包进 task。
- **`generateShotClip`**（视频）：kind=`comfyui`（与首帧共用 ComfyUI 并发度），把 `generateComfyuiVideo`/`runSeedanceGeneration` 调用包进 task。
- **`generateShotVoice`**（口播）：kind=`voice`，把 `synthesizeShotVoice` 调用包进 task。
- **`composeFilm`**（合成）：kind=`ffmpeg`，把 `runFfmpeg` 调用包进 task。

**重要**：task 内部的 `setFrame`/`setClip`/`setAudio`/`setCompose` 状态回写不变，仍直接写 project store——队列只包「实际算力调用」这一段，状态机逻辑不动。

### 单测兼容

单测 ctx 不传 jobQueue 时，`ctx.jobQueue?.enqueue(...)` 返回 undefined，`||` 回退直接 `await task()`——单测行为不变，零回归。

## 阶段 C：批量入口

### 项目内「一键全跑」

现有 `#genAllFramesBtn`（生成所有 pending/failed 首帧）。扩展为：
- 生成全部首帧（已有，经队列逐个入队）
- 生成全部视频（对所有 frame.confirmed 且 clip 未完成的镜，逐个入队口播/视频）

两个按钮或一个「全流程推进」按钮（跑完首帧后自动跑视频）。M10 做两个独立按钮更清晰。

### 项目列表批量勾选

平台视图或项目列表加 checkbox 列 + 「批量跑流水线」按钮：勾选的 N 个项目各自 `POST /api/drama/projects/{id}/pipeline`，后端经队列逐个入队（pipeline 本身不限并发，LLM 阶段真并行；首帧/视频子任务按 ComfyUI 并发度排队）。

### 端点

- `GET /api/drama/queue/status` → `{ comfyui: { running, queued }, voice: {...}, ffmpeg: {...} }`。
- 项目内批量触发现有点位（首帧/视频 POST），M10 不新增批量端点——前端循环调单镜端点即可，队列负责串行化。

## 错误处理与降级纪律

| 场景 | 行为 |
| --- | --- |
| ctx 无 jobQueue（单测） | 回退直接执行，零回归 |
| 并发度 env 非法 | 走默认值，不报错 |
| 队列溢出 | 内存队列无上限（本机场景不会千任务），不设 hard limit |
| task 抛错 | 队列捕获，job resolve（不 reject），状态回写由 task 内部 catch 处理（现有纪律不变） |
| 服务重启 | 队列清空，进行中的 task 由 ComfyUI/FFmpeg 侧自然完成或超时，用户重新提交 |

队列永不阻断生成——只是限流，task 最终都会跑。

## 测试策略

- `tests/drama-queue.test.mjs`：enqueue 立即跑/排队等待/并发度限制/完成后自动出队/status 形状。
- `tests/drama-routes-frames.test.mjs`：补「无 jobQueue 回退直接执行」+「有队列经 enqueue」。
- `tests/drama-routes-video.test.mjs`：补视频/口播经队列。
- `tests/drama-compose.test.mjs`：补合成经队列。
- `scripts/smoke.mjs` 收尾加 M10 守卫（建队列 → enqueue sleep 任务 → 断言并发度限制 + status）。

## Global Constraints

- 零框架、无构建链、不引入新 npm 依赖；本机优先、私密不出本机。
- 中文提交信息（`类型: 简短描述`）；遵循既有 `lib/drama/*` 与 `tests/drama-*.test.mjs` 模式。
- 既有单项目流程零回归；队列对单项目单任务透明（无 jobQueue 回退直接执行）。
- 队列内存不持久化，服务重启清空；进行中的任务不抢占。
- LLM 编排阶段不进队列（云端瓶颈不在本机）；首帧+视频共用 ComfyUI 并发度。
