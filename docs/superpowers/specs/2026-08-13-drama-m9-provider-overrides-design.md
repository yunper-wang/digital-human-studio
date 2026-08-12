# 短剧工作台 M9：多模型后端编排设计文档

- 日期：2026-08-13
- 状态：已评审（脑暴确认 3 个决策点 A/A/A）
- 范围：M9 —— 项目级 providerOverrides 覆盖 env 默认（LLM + 配音），运行期切换不重启
- 前置：M1–M8 已完成

## 背景与目标

M7 把五个后端状态做成了只读总览，M8 把素材引用注入了生成链路，但所有项目仍共用同一套后端配置（启动期从 env 固定到 ctx）。想换模型只能改 `.env` 重启，多项目并行用不同模型组合做不到。

M9 让项目级可选配置覆盖 env 默认，范围限定在两个最值得覆盖的后端：

- **编排 LLM**：付费云端、最容易想换（Claude / GPT-4o / 本地模型）
- **配音 ElevenLabs**：付费云端、不同项目可能用不同音色库

ComfyUI/Seedance/FFmpeg 三个本机后端不做项目级覆盖（本机各只有一个，覆盖意义不大，YAGNI）。

## 已确认决策与隐含假设

| 决策点 | 结论 |
| --- | --- |
| 配置存储 | **项目级 providerOverrides**：project schema 加 `providerOverrides: { llm?, voice? }` 可选字段，存本机 JSON（沿用 `promptTemplateId` 模式）；有 override 覆盖 env 默认，没有走 env |
| 覆盖范围 | **只做 LLM + 配音**：ComfyUI/Seedance/FFmpeg 本机各一个，不做项目级覆盖 |
| 密钥存储 | **本机文件存 + 永不返回明文**：override 文件存密钥，API 响应只出布尔「已配置」+ host/model 脱敏（同 M7）；前端输入框 type=password、提交后不回显 |

**隐含假设**：override 在流水线/首帧/口播**发起时**读取一次快照进 deps，阶段中途改 override 不影响进行中的任务（同 M7 promptTemplate 切换不追溯纪律）。

## 核心数据模型增量

**项目 schema 增量**（`normalizeProject`）：

```
project { ..., providerOverrides: { llm: null, voice: null } }
// llm: { baseUrl, model, apiKey } | null   —— 覆盖 DRAMA_LLM_*
// voice: { elevenKey } | null               —— 覆盖 ELEVENLABS_API_KEY
```

**providerOverrides 值**：存本机 JSON 文件 `data/provider-overrides/<projectId>.json`，密钥在文件内；project schema 只存「是否已配置」的布尔标记（不存密钥值到 project JSON），密钥只在 override 文件里。

**实际读取**：`createProviderOverrideStore(dataRoot)` → `{ get(projectId), save(projectId, {llm?, voice?}), remove(projectId) }`。

## 模块划分

- `lib/drama/provider-overrides.mjs` — **新建**：`createProviderOverrideStore(dataRoot)` 存取 override 文件；密钥永不进 project JSON。
- `lib/drama/schema.mjs` — `normalizeProject`/`createDramaProject` 加 `providerOverrides: { llm: null, voice: null }`（只存布尔标记，不存密钥）。
- `lib/drama/routes.mjs` — 流水线/首帧/口播发起处：从 `ctx.providerOverrideStore` 按 project.id 取 override，快照进 deps；新增 `GET/PATCH /api/drama/projects/{id}/provider-overrides` 端点（GET 脱敏只出布尔，PATCH 写 override 文件）。
- `lib/drama/llm.mjs` — `getDramaLlmConfig` 已支持 env 参数；新增 `resolveLlmConfig(envConfig, override)` 合并函数（override 优先）。
- `server.mjs` — ctx 挂载 `providerOverrideStore: createProviderOverrideStore(dataRoot)`；流水线发起处传 override 快照。
- 前端 `drama.js`/`drama.css` — 项目设置面板加「编排 LLM 覆盖」「配音 Key 覆盖」输入区（type=password，不回显）。

## 阶段 A：存储与 schema

### provider-overrides.mjs

`createProviderOverrideStore(dataRoot)` → `{ get, save, remove }`：

- **文件**：`data/provider-overrides/<projectId>.json`，形状 `{ projectId, llm?: { baseUrl, model, apiKey }, voice?: { elevenKey } }`。
- `get(projectId)`：文件不存在返回 null；损坏文件返回 null（自愈，不抛错）。
- `save(projectId, override)`：校验 baseUrl/model 非空（llm 覆盖时）、apiKey 非空（voice 覆盖时）；写文件。
- `remove(projectId)`：删文件，文件不存在也返回 true（幂等）。
- **永不**把密钥返回给 project JSON 或 API 响应体。

### schema.mjs

`createDramaProject` / `normalizeProject` 返回对象加：

```js
providerOverrides: raw?.providerOverrides && typeof raw.providerOverrides === "object"
  ? {
      llm: raw.providerOverrides.llm && typeof raw.providerOverrides.llm === "object"
        ? { configured: Boolean(raw.providerOverrides.llm.baseUrl && raw.providerOverrides.llm.model),
            baseUrl: typeof raw.providerOverrides.llm.baseUrl === "string" ? raw.providerOverrides.llm.baseUrl : null,
            model: typeof raw.providerOverrides.llm.model === "string" ? raw.providerOverrides.llm.model : null }
        : null,
      voice: raw.providerOverrides.voice && typeof raw.providerOverrides.voice === "object"
        ? { configured: Boolean(raw.providerOverrides.voice.elevenKey) }
        : null
    }
  : { llm: null, voice: null }
```

**注意**：project JSON 里存的是脱敏标记（baseUrl/model 字符串可存，apiKey 永不存——apiKey 只在 override 文件里）。`configured` 布尔表示密钥是否已在 override 文件配置。

## 阶段 B：配置 resolve 与端点

### llm.mjs resolveLlmConfig

新增 `resolveLlmConfig(envConfig, override)`：

```js
export function resolveLlmConfig(envConfig, override) {
  if (!override?.llm?.baseUrl || !override?.llm?.model || !override?.llm?.apiKey) return envConfig; // override 不完整走 env
  return { ...envConfig, baseUrl: override.llm.baseUrl, model: override.llm.model, apiKey: override.llm.apiKey, mock: false };
}
```

### routes.mjs 注入点

**流水线发起**（`runDramaPipeline` 调用处）：当前 `deps: { ...ctx.llmDeps, promptStore: ctx.promptStore }`。改为按 project override 快照合并：

```js
const override = ctx.providerOverrideStore?.get(projectId);
const llmConfig = resolveLlmConfig(ctx.llmDeps.config, override);
const audioDeps = { ...ctx.audioDeps, ...(override?.voice?.elevenKey ? { elevenKey: override.voice.elevenKey } : {}) };
runDramaPipeline(store, projectId, { fromStage, deps: { ...ctx.llmDeps, config: llmConfig, promptStore: ctx.promptStore }, pricing: ctx.pricing });
```

**首帧发起**（`generateShotFrame`）：同理，override 快照进 `comfyConfig` 不变（ComfyUI 不覆盖），但 LLM 不参与首帧（首帧走 ComfyUI），所以首帧只需保证 `materialStore`/`controlnetConfig` 不受影响——实际首帧不需要 LLM override。

**口播发起**（`generateShotVoice`）：override 的 voice.elevenKey 覆盖 `ctx.audioDeps.elevenKey`。

### 端点

- `GET /api/drama/projects/{id}/provider-overrides` → `{ overrides: { llm: { configured, baseUrl, model } | null, voice: { configured } | null } }`（脱敏：baseUrl/model 可返回，apiKey 永不出）。
- `PATCH /api/drama/projects/{id}/provider-overrides` → 写 override 文件。body `{ llm?: { baseUrl, model, apiKey }, voice?: { elevenKey }, clear?: ["llm"|"voice"] }`。`clear` 字段用于清除某个 override。
- 校验：baseUrl 非空字符串、model 非空、apiKey 非空（提供 llm 时）；提供 voice 时 elevenKey 非空。空值 → 422。
- **密钥写入后只返回布尔**，永不回显。

### server.mjs

ctx 挂载 `providerOverrideStore: createProviderOverrideStore(dataRoot)`。

## 阶段 C：前端

项目设置面板（剧本视图或独立卡）加两区：

- **编排 LLM 覆盖**：base_url / model / api_key 三个输入框（api_key type=password）；显示当前「已配置/未配置」+ host/model（脱敏）；「保存」「清除」按钮。
- **配音 Key 覆盖**：eleven_key 一个输入框（type=password）；显示「已配置/未配置」；「保存」「清除」按钮。
- 未配置时显示「走默认（env 配置）」。

## 错误处理与脱敏纪律

| 场景 | 行为 |
| --- | --- |
| override 文件损坏 | `get` 返回 null，走 env 默认（同 M7 prompt 模板损坏自愈） |
| override 不完整（llm 缺 baseUrl/model/apiKey 任一） | `resolveLlmConfig` 走 env 默认，不报错 |
| GET 端点 | 只返回 `configured` 布尔 + baseUrl/model（脱敏）；apiKey 永不出 |
| PATCH 端点写入 | 密钥写进 override 文件，响应只回 `{ ok: true, configured: true }` |
| 流水线进行中改 override | 不影响进行中的任务（发起时快照） |
| 清除 override | `clear: ["llm"]` 删 override 文件对应字段，project 走 env |

密钥纪律与 M7 providers / `GET /api/integrations` 一致：永不入响应体明文。

## 测试策略

- `tests/drama-provider-overrides.test.mjs`：get/save/remove、损坏自愈、密钥不入 project JSON。
- `tests/drama-schema.test.mjs`：补 `providerOverrides` 归一化（脱敏标记）。
- `tests/drama-llm.test.mjs`：补 `resolveLlmConfig` 合并（override 优先/不完整走 env）。
- `tests/drama-routes-provider-overrides.test.mjs`：GET 脱敏、PATCH 写入+clear、响应体不含 apiKey。
- `tests/drama-pipeline.test.mjs`：补「项目有 override → 流水线用 override config」。
- `tests/drama-routes-video.test.mjs`：补口播 override elevenKey 覆盖。
- `scripts/smoke.mjs` 收尾加 M9 守卫（建 override → 项目 GET 断言脱敏 → 流水线不炸）。

## Global Constraints

- 零框架、无构建链、不引入新 npm 依赖；本机优先、私密不出本机。
- 中文提交信息（`类型: 简短描述`）；遵循既有 `lib/drama/*` 与 `tests/drama-*.test.mjs` 模式。
- 密钥永不入响应体明文，永不入 project JSON；只存 override 文件，只出布尔语义。
- 既有流水线/首帧/口播/合成链路零回归；override 发起时快照，进行中不切换。
- ComfyUI/Seedance/FFmpeg 不做项目级覆盖（本机各一个，YAGNI）。
