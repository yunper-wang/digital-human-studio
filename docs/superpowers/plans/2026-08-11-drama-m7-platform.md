# 短剧工作台 M7：平台级通用模块（提示词库 + 素材库 + 模型管理）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐三个平台级模块：多模板提示词库（项目可选用）、上传素材库（图片/音频/视频 + 资产引用记录）、模型管理只读状态总览。

**Architecture:** 三模块各自独立，沿用 M6 `series.mjs`/`version.mjs` 模式：`prompts.mjs`（模板存储，`data/prompt-templates/`）、`materials.mjs`（素材存储，`data/materials/` 文件 + `index.json` 索引）、providers 纯聚合端点（无存储）。`agents.mjs` 四段系统提示词改为 export 并经 `deps.prompts` 注入；前端 48px 图标栏新增「平台」视图，内三 tab。

**Tech Stack:** 零框架原生 HTML/CSS/JS；Node 20+；本机 JSON 文件存储；`node:test`。

**Spec:** `docs/superpowers/specs/2026-08-11-drama-m7-platform-design.md`

## Global Constraints

- 零框架、无构建链、不引入新 npm 依赖；本机优先、私密不出本机。
- 中文提交信息（`类型: 简短描述`）；遵循既有 `lib/drama/*` 与 `tests/drama-*.test.mjs` 模式。
- 密钥/端点永不入响应体明文；素材上传走魔数校验 + 大小限 + 路径白名单。
- 模板缺失一律逐段回退内置默认，流水线永不因模板问题中断；项目切模板不追溯已生成内容。
- 素材引用仅记录，M7 不改 `comfyui.mjs` 工作流构建；既有单集流程与 M6 能力零回归。

---

## 阶段 A：提示词库

### Task 1: prompts.mjs —— 模板存储 + schema promptTemplateId + agents 常量导出

**Files:**
- Create: `lib/drama/prompts.mjs`
- Modify: `lib/drama/agents.mjs`（4 个常量加 export，无行为变化）
- Modify: `lib/drama/schema.mjs`（project 加 `promptTemplateId`）
- Test: `tests/drama-prompts.test.mjs`、`tests/drama-schema.test.mjs`

**Interfaces:**
- Consumes: `agents.mjs` 的 `SYSTEM_ANALYZE/SYSTEM_DIRECT/SYSTEM_PROMPT/SYSTEM_REVIEW`（本任务改为 export）
- Produces: `createPromptStore(dataRoot)` → `{ list, get, create, save, remove, duplicate, resolveStages }`；`BUILTIN_TEMPLATE_ID = "ptpl-builtin-default"`；模板形状 `{id,name,stages:{analyze,direct,prompt,review},builtin,createdAt,updatedAt}`；`normalizeProject`/`createDramaProject` 返回对象新增 `promptTemplateId`（默认 `null`）

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-prompts.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPromptStore, BUILTIN_TEMPLATE_ID } from "../lib/drama/prompts.mjs";

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-pt-"));
  return { store: createPromptStore(dataRoot), dataRoot };
}

test("种子化内置默认模板（幂等），四段齐全", () => {
  const { store, dataRoot } = setup();
  const builtin = store.get(BUILTIN_TEMPLATE_ID);
  assert.ok(builtin);
  assert.equal(builtin.builtin, true);
  for (const s of ["analyze", "direct", "prompt", "review"]) assert.ok(builtin.stages[s].length > 20);
  // 幂等：同目录重建 store 不重复种子
  const again = createPromptStore(dataRoot);
  assert.equal(again.list().length, 1);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("CRUD：建→列→改→builtin 不可删→自定义可删", () => {
  const { store, dataRoot } = setup();
  const tpl = store.create({ name: "悬疑风", stages: { direct: "你是悬疑短剧导演，只输出 JSON。" } });
  assert.equal(tpl.name, "悬疑风");
  assert.equal(tpl.builtin, false);
  assert.equal(store.list().length, 2); // 内置 + 自定义
  store.save({ ...tpl, name: "悬疑风 v2" });
  assert.equal(store.get(tpl.id).name, "悬疑风 v2");
  assert.equal(store.remove(BUILTIN_TEMPLATE_ID), false); // builtin 保护
  assert.equal(store.remove(tpl.id), true);
  assert.equal(store.get(tpl.id), null);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("duplicate 复制内置模板为可编辑副本", () => {
  const { store, dataRoot } = setup();
  const copy = store.duplicate(BUILTIN_TEMPLATE_ID);
  assert.equal(copy.name, "默认模板 副本");
  assert.equal(copy.builtin, false);
  assert.equal(copy.stages.analyze, store.get(BUILTIN_TEMPLATE_ID).stages.analyze);
  assert.equal(store.remove(copy.id), true);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("resolveStages 逐段回退：未选/模板缺失/某段为空 → 内置默认", () => {
  const { store, dataRoot } = setup();
  const fallback = store.get(BUILTIN_TEMPLATE_ID).stages;
  assert.deepEqual(store.resolveStages(null), fallback);
  assert.deepEqual(store.resolveStages("ptpl-00000000-0000-0000-0000-000000000000"), fallback);
  const tpl = store.create({ name: "x", stages: { review: "自定义审核提示词" } });
  const resolved = store.resolveStages(tpl.id);
  assert.equal(resolved.review, "自定义审核提示词");
  assert.equal(resolved.analyze, fallback.analyze);
  store.remove(tpl.id); // 删模板后回退默认
  assert.deepEqual(store.resolveStages(tpl.id), fallback);
  rmSync(dataRoot, { recursive: true, force: true });
});
```

在 `tests/drama-schema.test.mjs` 末尾追加：

```js
test("M7：project.promptTemplateId 归一化", () => {
  assert.equal(normalizeProject({ id: "drama-1", title: "t", script: "s", ratio: "portrait", promptTemplateId: "ptpl-1" }).promptTemplateId, "ptpl-1");
  assert.equal(normalizeProject({ id: "drama-1", title: "t", script: "s", ratio: "portrait" }).promptTemplateId, null);
  assert.equal(createDramaProject({ title: "t", script: "剧本" }).promptTemplateId, null);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-prompts.test.mjs`
Expected: FAIL（模块不存在 `../lib/drama/prompts.mjs`）

- [ ] **Step 3: 实现**

`lib/drama/agents.mjs`：4 个常量声明加 `export`（其余不动）：

```js
export const SYSTEM_ANALYZE = `…`; // 原样
export const SYSTEM_DIRECT = `…`;
export const SYSTEM_PROMPT = `…`;
export const SYSTEM_REVIEW = `…`;
```

新建 `lib/drama/prompts.mjs`：

```js
// lib/drama/prompts.mjs
// 提示词模板库：多模板 + 项目选用；存 data/prompt-templates/，一模板一 JSON
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_ANALYZE, SYSTEM_DIRECT, SYSTEM_PROMPT, SYSTEM_REVIEW } from "./agents.mjs";

export const PROMPT_STAGES = ["analyze", "direct", "prompt", "review"];
export const BUILTIN_TEMPLATE_ID = "ptpl-builtin-default";

export function createPromptStore(dataRoot) {
  const root = join(dataRoot, "prompt-templates");
  mkdirSync(root, { recursive: true });
  const file = (id) => join(root, `${id}.json`);

  function normalizeTemplate(raw = {}) {
    const stages = raw.stages && typeof raw.stages === "object" ? raw.stages : {};
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : `ptpl-${randomUUID()}`,
      name: String(raw.name || "未命名模板").slice(0, 60),
      stages: {
        analyze: String(stages.analyze || ""),
        direct: String(stages.direct || ""),
        prompt: String(stages.prompt || ""),
        review: String(stages.review || "")
      },
      builtin: raw.builtin === true,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString()
    };
  }

  // 种子化内置默认模板（幂等：已存在不覆盖）
  if (!existsSync(file(BUILTIN_TEMPLATE_ID))) {
    writeFileSync(file(BUILTIN_TEMPLATE_ID), JSON.stringify(normalizeTemplate({
      id: BUILTIN_TEMPLATE_ID,
      name: "默认模板",
      stages: { analyze: SYSTEM_ANALYZE, direct: SYSTEM_DIRECT, prompt: SYSTEM_PROMPT, review: SYSTEM_REVIEW },
      builtin: true
    }), null, 2));
  }

  function save(tpl) {
    tpl.updatedAt = new Date().toISOString();
    writeFileSync(file(tpl.id), JSON.stringify(tpl, null, 2));
    return tpl;
  }
  function get(id) {
    if (typeof id !== "string" || !/^ptpl-[a-z0-9-]+$/.test(id) || !existsSync(file(id))) return null;
    try { return normalizeTemplate(JSON.parse(readFileSync(file(id), "utf8"))); } catch { return null; }
  }
  function list() {
    return readdirSync(root).filter((f) => /^ptpl-.*\.json$/.test(f))
      .map((f) => { try { return normalizeTemplate(JSON.parse(readFileSync(join(root, f), "utf8"))); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => Number(b.builtin) - Number(a.builtin) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  function create({ name, stages } = {}) { return save(normalizeTemplate({ name, stages })); }
  function remove(id) {
    const tpl = get(id);
    if (!tpl || tpl.builtin) return false;
    rmSync(file(id));
    return true;
  }
  function duplicate(id) {
    const src = get(id);
    if (!src) return null;
    return save(normalizeTemplate({ name: `${src.name} 副本`.slice(0, 60), stages: src.stages }));
  }
  // 逐段回退：永远返回完整四段；未选/模板缺失/某段为空 → 该段回退内置默认
  function resolveStages(templateId) {
    const fallback = get(BUILTIN_TEMPLATE_ID).stages;
    const tpl = templateId ? get(templateId) : null;
    if (!tpl) return { ...fallback };
    const out = {};
    for (const stage of PROMPT_STAGES) out[stage] = tpl.stages[stage].trim() ? tpl.stages[stage] : fallback[stage];
    return out;
  }

  return { list, get, create, save, remove, duplicate, resolveStages };
}
```

`lib/drama/schema.mjs`：
1. `createDramaProject` 返回对象在 `seriesId: null,` 行后加 `promptTemplateId: null,`。
2. `normalizeProject` 返回对象在 `seriesId: …` 行后加：

```js
    promptTemplateId: typeof raw.promptTemplateId === "string" && raw.promptTemplateId ? raw.promptTemplateId : null,
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-prompts.test.mjs && node --test tests/drama-schema.test.mjs && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/prompts.mjs lib/drama/agents.mjs lib/drama/schema.mjs tests/drama-prompts.test.mjs tests/drama-schema.test.mjs
git commit -m "feat: 提示词模板存储与项目选用字段（M7 Task1）"
```

---

### Task 2: agents/pipeline —— 提示词注入接线

**Files:**
- Modify: `lib/drama/agents.mjs`
- Modify: `lib/drama/pipeline.mjs`
- Test: `tests/drama-agents.test.mjs`、`tests/drama-pipeline.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `createPromptStore.resolveStages`
- Produces: `callStage` 支持 `deps.prompts[stage]` 覆盖系统提示词；`runDramaPipeline` 在 `deps.promptStore` 存在时按 `project.promptTemplateId` resolve 并注入

- [ ] **Step 1: 写失败测试**

在 `tests/drama-agents.test.mjs` 末尾追加：

```js
test("M7：deps.prompts 覆盖阶段系统提示词", async () => {
  let seenSystem = null;
  const deps = {
    config: { mock: false, baseUrl: "http://127.0.0.1:9", model: "m", apiKey: "", timeoutMs: 1000, maxRetries: 0 },
    fetchImpl: async (url, opts) => {
      seenSystem = JSON.parse(opts.body).messages[0].content;
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ synopsis: "s", genre: "g", characters: [{ id: "c1", name: "n", appearance: "a" }], scenes: [{ id: "s1", name: "sc" }] }) } }] }) };
    },
    prompts: { analyze: "自定义分析提示词" }
  };
  await runScriptAnalysis({ script: "x".repeat(60) }, deps);
  assert.equal(seenSystem, "自定义分析提示词");
});
```

在 `tests/drama-pipeline.test.mjs` 末尾追加（文件顶部 import 区加 `import { createPromptStore } from "../lib/drama/prompts.mjs";`）：

```js
test("M7：流水线按项目模板 resolve 提示词注入 deps", async () => {
  const { root, store, project } = fixture();
  try {
    const promptStore = createPromptStore(root);
    const tpl = promptStore.create({ name: "t", stages: { review: "自定义审核提示词" } });
    store.update(project.id, (p) => { p.promptTemplateId = tpl.id; });
    let resolvedWith = undefined;
    const spy = { resolveStages: (id) => { resolvedWith = id; return promptStore.resolveStages(id); } };
    const deps = { config: getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" }), promptStore: spy };
    const result = await runDramaPipeline(store, project.id, { deps });
    assert.equal(result.reused, false);
    assert.equal(resolvedWith, tpl.id);
    assert.equal(store.get(project.id).status, "awaiting_gate_a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-agents.test.mjs && node --test tests/drama-pipeline.test.mjs`
Expected: FAIL（agents 用例 `seenSystem` 不是自定义提示词；pipeline 用例 `resolvedWith` 为 undefined）

- [ ] **Step 3: 实现**

`lib/drama/agents.mjs` `callStage` 内 `const text = await callDramaLlm(stage, { system, user }, deps);` 改为：

```js
    // M7：deps.prompts[stage] 存在时覆盖默认系统提示词（提示词模板注入点）
    const text = await callDramaLlm(stage, { system: deps.prompts?.[stage] || system, user }, deps);
```

`lib/drama/pipeline.mjs` `runDramaPipeline` 在 `if (!project) throw …` 之后、`const stageIndex` 之前插入：

```js
  // M7：按项目所选提示词模板注入四段系统提示词（未选/模板缺失 → 内置默认，永不阻断）
  if (deps.promptStore) deps = { ...deps, prompts: deps.promptStore.resolveStages(project.promptTemplateId) };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-agents.test.mjs && node --test tests/drama-pipeline.test.mjs && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/agents.mjs lib/drama/pipeline.mjs tests/drama-agents.test.mjs tests/drama-pipeline.test.mjs
git commit -m "feat: 流水线按项目模板注入系统提示词（M7 Task2）"
```

---

### Task 3: routes —— 模板端点 + 项目切模板 + server 挂载

**Files:**
- Modify: `lib/drama/routes.mjs`
- Modify: `server.mjs`
- Test: `tests/drama-routes-prompts.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `createPromptStore`
- Produces: 端点 `GET/POST /api/drama/prompt-templates`、`GET/PATCH/DELETE /api/drama/prompt-templates/{id}`、`POST .../prompt-templates/{id}/duplicate`；项目 `PATCH` 白名单加 `promptTemplateId`；ctx 新增 `promptStore`

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-routes-prompts.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createPromptStore, BUILTIN_TEMPLATE_ID } from "../lib/drama/prompts.mjs";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject } from "../lib/drama/schema.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; return res; }

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rp-"));
  const store = createDramaStore(dataRoot);
  const project = store.save(createDramaProject({ title: "t", script: "剧本内容".repeat(15) }));
  const ctx = {
    sendJson: (res, s, b) => res.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store, promptStore: createPromptStore(dataRoot),
    comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}
  };
  return { ctx, project, dataRoot };
}

test("模板：列表含内置→建→改→复制→删", async () => {
  const { ctx, dataRoot } = setup();
  let res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL("http://x/api/drama/prompt-templates"), ctx);
  assert.equal(res.body.data.templates.length, 1);
  assert.equal(res.body.data.templates[0].builtin, true);

  res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ name: "悬疑风", stages: { review: "自定义审核" } }) }, res, new URL("http://x/api/drama/prompt-templates"), ctx);
  assert.equal(res.statusCode, 201);
  const tid = res.body.data.template.id;

  res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ stages: { review: "自定义审核 v2" } }) }, res, new URL(`http://x/api/drama/prompt-templates/${tid}`), ctx);
  assert.equal(res.body.data.template.stages.review, "自定义审核 v2");

  res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: "{}" }, res, new URL(`http://x/api/drama/prompt-templates/${tid}/duplicate`), ctx);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.template.name, "悬疑风 副本");

  res = mockRes();
  await handleDramaApi({ method: "DELETE", socket: {} }, res, new URL(`http://x/api/drama/prompt-templates/${tid}`), ctx);
  assert.equal(res.body.data.removed, tid);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("内置模板 PATCH/DELETE → 403；空名/四段全空 → 422", async () => {
  const { ctx, dataRoot } = setup();
  let res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ name: "x" }) }, res, new URL(`http://x/api/drama/prompt-templates/${BUILTIN_TEMPLATE_ID}`), ctx);
  assert.equal(res.statusCode, 403);
  res = mockRes();
  await handleDramaApi({ method: "DELETE", socket: {} }, res, new URL(`http://x/api/drama/prompt-templates/${BUILTIN_TEMPLATE_ID}`), ctx);
  assert.equal(res.statusCode, 403);
  res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ name: "", stages: { review: "x" } }) }, res, new URL("http://x/api/drama/prompt-templates"), ctx);
  assert.equal(res.statusCode, 422);
  res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ name: "x", stages: {} }) }, res, new URL("http://x/api/drama/prompt-templates"), ctx);
  assert.equal(res.statusCode, 422);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("项目切模板：合法 → 200 写入；不存在 → 422；置 null 回默认", async () => {
  const { ctx, project, dataRoot } = setup();
  const tpl = ctx.promptStore.create({ name: "t", stages: { review: "x" } });
  let res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ promptTemplateId: tpl.id }) }, res, new URL(`http://x/api/drama/projects/${project.id}`), ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.project.promptTemplateId, tpl.id);
  res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ promptTemplateId: "ptpl-00000000-0000-0000-0000-000000000000" }) }, res, new URL(`http://x/api/drama/projects/${project.id}`), ctx);
  assert.equal(res.statusCode, 422);
  res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ promptTemplateId: null }) }, res, new URL(`http://x/api/drama/projects/${project.id}`), ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.project.promptTemplateId, null);
  rmSync(dataRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-routes-prompts.test.mjs`
Expected: FAIL（模板路由未处理 → 404/false；项目 PATCH 忽略 promptTemplateId）

- [ ] **Step 3: 实现**

`lib/drama/routes.mjs`：在 series 分支收尾 `}` 之后、`demo` 分支之前插入：

```js
  const { promptStore } = ctx;
  if (segments[2] === "prompt-templates" && promptStore) {
    const STAGE_KEYS = ["analyze", "direct", "prompt", "review"];
    const stagesNonEmpty = (stages) => STAGE_KEYS.some((s) => String(stages?.[s] || "").trim());
    if (segments.length === 3 && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      let payload = {};
      try { payload = await readJson(request, 100_000); } catch { return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" })); }
      const name = String(payload.name || "").trim();
      if (!name) return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "TEMPLATE_NAME_REQUIRED", message: "模板名称不能为空" }));
      if (!stagesNonEmpty(payload.stages)) return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "TEMPLATE_STAGES_EMPTY", message: "至少填写一个阶段的提示词" }));
      return sendJson(response, 201, envelope(true, { template: promptStore.create({ name, stages: payload.stages }) }, { requestId }));
    }
    if (segments.length === 3 && request.method === "GET") {
      return sendJson(response, 200, envelope(true, { templates: promptStore.list() }, { requestId }));
    }
    const tpl = promptStore.get(segments[3] || "");
    if (!tpl) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "TEMPLATE_NOT_FOUND", message: "模板不存在" }));
    if (segments.length === 4 && request.method === "GET") return sendJson(response, 200, envelope(true, { template: tpl }, { requestId }));
    if (segments.length === 4 && request.method === "PATCH") {
      if (tpl.builtin) return sendJson(response, 403, envelope(false, null, { requestId, errorCode: "TEMPLATE_BUILTIN_READONLY", message: "内置模板为只读，请复制副本后编辑" }));
      let payload = {};
      try { payload = await readJson(request, 100_000); } catch { return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" })); }
      if (typeof payload.name === "string") {
        const name = payload.name.trim();
        if (!name) return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "TEMPLATE_NAME_REQUIRED", message: "模板名称不能为空" }));
        tpl.name = name.slice(0, 60);
      }
      if (payload.stages && typeof payload.stages === "object") {
        for (const s of STAGE_KEYS) {
          if (typeof payload.stages[s] === "string") tpl.stages[s] = payload.stages[s].slice(0, 10_000);
        }
        if (!stagesNonEmpty(tpl.stages)) return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "TEMPLATE_STAGES_EMPTY", message: "至少保留一个阶段的提示词" }));
      }
      return sendJson(response, 200, envelope(true, { template: promptStore.save(tpl) }, { requestId }));
    }
    if (segments.length === 4 && request.method === "DELETE") {
      if (tpl.builtin) return sendJson(response, 403, envelope(false, null, { requestId, errorCode: "TEMPLATE_BUILTIN_READONLY", message: "内置模板为只读" }));
      promptStore.remove(tpl.id); // 引用它的项目由 resolveStages 逐段回退默认
      return sendJson(response, 200, envelope(true, { removed: tpl.id }, { requestId }));
    }
    if (segments.length === 5 && segments[4] === "duplicate" && request.method === "POST") {
      return sendJson(response, 201, envelope(true, { template: promptStore.duplicate(tpl.id) }, { requestId }));
    }
    return false;
  }
```

项目 `PATCH`（`segments.length === 4 && request.method === "PATCH"` 块内）：
1. 在 script 长度校验之后加模板存在性校验（先校验再进 update，与既有纪律一致）：

```js
      if (typeof payload.promptTemplateId !== "undefined" && payload.promptTemplateId !== null) {
        if (!ctx.promptStore?.get(String(payload.promptTemplateId))) {
          return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "TEMPLATE_NOT_FOUND", message: "提示词模板不存在" }));
        }
      }
```

2. `store.update` 的 patcher 内 `if (typeof payload.title === "string") …` 行前加：

```js
        // 切换模板不追溯：只影响后续重跑阶段，已生成内容不动
        if (typeof payload.promptTemplateId !== "undefined") p.promptTemplateId = payload.promptTemplateId;
```

pipeline 发起处（`runDramaPipeline(store, projectId, { fromStage, deps: ctx.llmDeps, pricing: ctx.pricing })`）改为：

```js
      runDramaPipeline(store, projectId, { fromStage, deps: { ...ctx.llmDeps, promptStore: ctx.promptStore }, pricing: ctx.pricing }).catch(() => {});
```

`server.mjs`：
1. import 区加 `import { createPromptStore } from "./lib/drama/prompts.mjs";`
2. `handleDramaApi` 的 ctx 在 `seriesStore: createSeriesStore(dataRoot),` 行后加 `promptStore: createPromptStore(dataRoot),`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-routes-prompts.test.mjs && npm run test:unit && npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/routes.mjs server.mjs tests/drama-routes-prompts.test.mjs
git commit -m "feat: 提示词模板端点与项目选用（M7 Task3）"
```

---

### Task 4: 前端平台视图骨架 + 提示词 tab + 项目模板下拉

**Files:**
- Modify: `public/drama.html`、`public/drama.js`、`public/drama.css`

**Interfaces:**
- Consumes: Task 3 端点；现有 `setView`/`VIEWS`/`api`/`toast`/`showError`/`state` 模式
- Produces: 图标栏「平台」入口 → `#viewPlatform`（三 tab 骨架：提示词/素材/模型，素材与模型 tab 本任务为占位，Task 8/10 填充）；提示词 tab 完整 CRUD；剧本视图 `#promptTemplateSelect` 项目选用下拉

- [ ] **Step 1: 图标栏 + 视图骨架 HTML**

`public/drama.html`：
1. 图标栏 `<button class="vz-ic" data-view="generate" title="生成">▶</button>` 之后加：

```html
      <button class="vz-ic" data-view="platform" title="平台">⚙</button>
```

2. `#viewGenerate` 收尾 `</section>` 之后新增平台视图（素材/模型 tab 为占位，Task 8/10 填充）：

```html
        <!-- 平台视图 -->
        <section class="vz-view hidden" id="viewPlatform">
          <div class="vz-card" style="padding:14px">
            <div class="vz-seg" id="platformTabSeg" style="width:280px">
              <button data-tab="prompts" class="on">提示词</button>
              <button data-tab="materials">素材</button>
              <button data-tab="models">模型</button>
            </div>
          </div>
          <div id="platformPrompts">
            <div class="vz-card" style="padding:14px">
              <div class="vz-rowline">
                <b style="font-size:13px">提示词模板</b>
                <button class="vz-btn" id="newTemplateBtn">新建模板</button>
              </div>
              <div id="templateList" style="margin-top:8px"></div>
            </div>
            <div class="vz-card" style="padding:14px" id="templateEditor"></div>
          </div>
          <div id="platformMaterials" class="hidden"><div class="vz-card" style="padding:14px"><p class="muted">素材库（即将上线）</p></div></div>
          <div id="platformModels" class="hidden"><div class="vz-card" style="padding:14px"><p class="muted">模型状态（即将上线）</p></div></div>
        </section>
```

3. 剧本视图「编排流水线」卡内 `<button class="vz-btn hidden" id="resumeBtn" …>` 行之后加项目模板下拉：

```html
            <div class="vz-rowline" style="margin-top:10px">
              <span class="muted">提示词模板</span>
              <select id="promptTemplateSelect" class="vz-select" style="max-width:220px"></select>
            </div>
```

- [ ] **Step 2: 视图切换 + 状态 + 模板 CRUD**

`public/drama.js`：
1. `VIEWS` 改为 `["script", "assets", "story", "generate", "platform"]`；`state` 加 `platformTab: "prompts", promptTemplates: [], activeTemplateId: null,`。
2. `setView` 内 `$("#viewGenerate").classList.toggle(…)` 行后加：

```js
  $("#viewPlatform").classList.toggle("hidden", name !== "platform");
  if (name === "platform") setPlatformTab(state.platformTab);
```

3. 新增平台区函数（放在 `renderVersions` 之后即可）：

```js
// ---------- 平台视图 ----------
const TEMPLATE_STAGE_LABELS = { analyze: "剧本分析", direct: "导演分镜", prompt: "提示词", review: "文本审核" };

function setPlatformTab(tab) {
  state.platformTab = tab;
  $$("#platformTabSeg [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $("#platformPrompts").classList.toggle("hidden", tab !== "prompts");
  $("#platformMaterials").classList.toggle("hidden", tab !== "materials");
  $("#platformModels").classList.toggle("hidden", tab !== "models");
  if (tab === "prompts") loadPromptTemplates();
}

async function loadPromptTemplates() {
  try {
    const { data } = await api("/api/drama/prompt-templates");
    state.promptTemplates = data.templates || [];
  } catch { state.promptTemplates = []; }
  renderTemplateList();
  renderTemplateEditor();
  renderTemplateSelect();
}

function renderTemplateList() {
  const box = $("#templateList");
  if (!box) return;
  box.innerHTML = "";
  for (const t of state.promptTemplates) {
    const row = document.createElement("div");
    row.className = "vz-sub-row" + (t.id === state.activeTemplateId ? " on" : "");
    const label = document.createElement("span");
    label.style.flex = "1";
    label.textContent = t.name + (t.builtin ? "（内置）" : "");
    const dup = document.createElement("button"); dup.className = "vz-btn"; dup.textContent = "复制";
    dup.addEventListener("click", async (e) => { e.stopPropagation(); await duplicateTemplate(t.id); });
    row.append(label, dup);
    if (!t.builtin) {
      const del = document.createElement("button"); del.className = "vz-btn"; del.textContent = "删除";
      del.addEventListener("click", async (e) => { e.stopPropagation(); await deleteTemplate(t.id, t.name); });
      row.append(del);
    }
    row.addEventListener("click", () => { state.activeTemplateId = t.id; renderTemplateList(); renderTemplateEditor(); });
    box.append(row);
  }
}

function renderTemplateEditor() {
  const box = $("#templateEditor");
  if (!box) return;
  const tpl = state.promptTemplates.find((t) => t.id === state.activeTemplateId);
  if (!tpl) { box.innerHTML = '<p class="muted">选择左侧模板查看或编辑；内置模板只读，可复制副本后编辑。留空的阶段自动回退默认模板。</p>'; return; }
  box.innerHTML = "";
  const title = document.createElement("b"); title.style.fontSize = "13px";
  title.textContent = tpl.name + (tpl.builtin ? "（内置只读）" : "");
  box.append(title);
  const textareas = {};
  for (const stage of ["analyze", "direct", "prompt", "review"]) {
    const lab = document.createElement("div"); lab.className = "muted"; lab.style.marginTop = "8px";
    lab.textContent = `${TEMPLATE_STAGE_LABELS[stage]}（${stage}）`;
    const ta = document.createElement("textarea");
    ta.style.cssText = "width:100%;min-height:90px;margin-top:4px;border:1px solid var(--border);border-radius:9px;padding:8px;font-size:12px";
    ta.value = tpl.stages[stage] || "";
    ta.readOnly = tpl.builtin;
    textareas[stage] = ta;
    box.append(lab, ta);
  }
  if (!tpl.builtin) {
    const save = document.createElement("button"); save.className = "vz-btn vz-btn-primary"; save.style.marginTop = "8px"; save.textContent = "保存模板";
    save.addEventListener("click", () => saveTemplate(tpl.id, textareas));
    box.append(save);
  }
}

async function saveTemplate(id, textareas) {
  try {
    const stages = {};
    for (const s of ["analyze", "direct", "prompt", "review"]) stages[s] = textareas[s].value;
    await api(`/api/drama/prompt-templates/${id}`, { method: "PATCH", body: JSON.stringify({ stages }) });
    toast("模板已保存");
    await loadPromptTemplates();
  } catch (error) { showError(error.message || error); }
}

async function createTemplate() {
  const name = window.prompt("模板名称", "我的模板");
  if (!name) return;
  try {
    // 以内置模板为底稿创建，保证四段齐全
    const builtin = state.promptTemplates.find((t) => t.builtin);
    const stages = builtin ? builtin.stages : { review: "你是短剧内容审核员。只输出 JSON。" };
    const { data } = await api("/api/drama/prompt-templates", { method: "POST", body: JSON.stringify({ name, stages }) });
    state.activeTemplateId = data.template.id;
    await loadPromptTemplates();
  } catch (error) { showError(error.message || error); }
}

async function duplicateTemplate(id) {
  try {
    const { data } = await api(`/api/drama/prompt-templates/${id}/duplicate`, { method: "POST", body: "{}" });
    state.activeTemplateId = data.template.id;
    await loadPromptTemplates();
    toast("已复制模板");
  } catch (error) { showError(error.message || error); }
}

async function deleteTemplate(id, name) {
  if (!window.confirm(`删除模板「${name}」？\n引用它的项目会自动回退到默认模板。`)) return;
  try {
    await api(`/api/drama/prompt-templates/${id}`, { method: "DELETE" });
    if (state.activeTemplateId === id) state.activeTemplateId = null;
    await loadPromptTemplates();
    toast("已删除模板", name);
  } catch (error) { showError(error.message || error); }
}

// 项目选用模板（剧本视图下拉）
function renderTemplateSelect() {
  const sel = $("#promptTemplateSelect");
  if (!sel) return;
  sel.innerHTML = '<option value="">默认模板</option>';
  for (const t of state.promptTemplates) {
    if (t.builtin) continue;
    const o = document.createElement("option");
    o.value = t.id; o.textContent = t.name;
    sel.append(o);
  }
  sel.value = state.project?.promptTemplateId || "";
}

async function changeProjectTemplate() {
  if (!state.project) return;
  const sel = $("#promptTemplateSelect");
  try {
    const { data } = await api(`/api/drama/projects/${state.project.id}`, { method: "PATCH", body: JSON.stringify({ promptTemplateId: sel.value || null }) });
    state.project = data.project;
    toast("已切换提示词模板", "只影响后续重跑的流水线阶段");
  } catch (error) { showError(error.message || error); }
}
```

4. `renderProject` 内 `renderVersions(project);` 行后加 `renderTemplateSelect();`。
5. 事件绑定区（`loadSeries();` 附近）加：

```js
$$("#platformTabSeg [data-tab]").forEach((b) => b.addEventListener("click", () => setPlatformTab(b.dataset.tab)));
if ($("#newTemplateBtn")) $("#newTemplateBtn").addEventListener("click", createTemplate);
if ($("#promptTemplateSelect")) $("#promptTemplateSelect").addEventListener("change", changeProjectTemplate);
```

6. 初始化区 `loadSeries();` 行后加 `loadPromptTemplates();`（剧本视图下拉需要模板列表）。

- [ ] **Step 3: 校验 + Commit**

Run: `npm run check`
```bash
git add public/drama.html public/drama.js public/drama.css
git commit -m "feat: 平台视图骨架与提示词模板面板、项目模板下拉（M7 Task4）"
```

---

## 阶段 B：素材库

### Task 5: materials.mjs —— 素材存储（上传/过滤/改名/标签/删除）

**Files:**
- Create: `lib/drama/materials.mjs`
- Test: `tests/drama-materials.test.mjs`

**Interfaces:**
- Consumes: 无（独立存储 `data/materials/`）
- Produces: `createMaterialStore(dataRoot)` → `{ list, get, register, rename, setTags, remove }`；素材形状 `{id,name,kind:"image|audio|video",file,size,tags[],createdAt}`；`MATERIAL_LIMITS = { image: 8MB, audio: 20MB, video: 50MB }`；错误码 `MATERIAL_FORMAT_INVALID / MATERIAL_TOO_LARGE / MATERIAL_BYTES_INVALID`

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-materials.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMaterialStore } from "../lib/drama/materials.mjs";

// 1x1 PNG（魔数合法）
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const MP3_DATA_URL = `data:audio/mpeg;base64,${Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]).toString("base64")}`;

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-mat-"));
  return { store: createMaterialStore(dataRoot), dataRoot };
}

test("register 图片/音频 → list 过滤 → get", () => {
  const { store, dataRoot } = setup();
  const img = store.register({ name: "街景", dataUrl: PNG_DATA_URL });
  assert.equal(img.kind, "image");
  assert.ok(img.file.endsWith(".png"));
  assert.ok(existsSync(join(dataRoot, "materials", img.file)));
  const audio = store.register({ name: "雨声", dataUrl: MP3_DATA_URL });
  assert.equal(audio.kind, "audio");
  assert.equal(store.list().length, 2);
  assert.equal(store.list({ kind: "image" }).length, 1);
  assert.equal(store.list({ q: "雨声" })[0].id, audio.id);
  assert.equal(store.get(img.id).name, "街景");
  rmSync(dataRoot, { recursive: true, force: true });
});

test("rename/setTags/remove（删文件+索引）", () => {
  const { store, dataRoot } = setup();
  const img = store.register({ name: "a", dataUrl: PNG_DATA_URL });
  store.rename(img.id, "便利店夜景");
  store.setTags(img.id, ["街景", "夜"]);
  const got = store.get(img.id);
  assert.equal(got.name, "便利店夜景");
  assert.deepEqual(got.tags, ["街景", "夜"]);
  assert.equal(store.list({ tag: "夜" }).length, 1);
  assert.equal(store.remove(img.id), true);
  assert.equal(store.get(img.id), null);
  assert.equal(existsSync(join(dataRoot, "materials", img.file)), false);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("格式/魔数/大小校验", () => {
  const { store, dataRoot } = setup();
  assert.throws(() => store.register({ name: "x", dataUrl: "data:text/plain;base64,aGVsbG8=" }), /MATERIAL_FORMAT_INVALID/);
  // png 声明但内容不是 png
  assert.throws(() => store.register({ name: "x", dataUrl: `data:image/png;base64,${Buffer.from("not a png").toString("base64")}` }), /MATERIAL_BYTES_INVALID/);
  // 超 8MB
  const big = Buffer.alloc(9 * 1024 * 1024, 1);
  assert.throws(() => store.register({ name: "x", dataUrl: `data:image/png;base64,${big.toString("base64")}` }), /MATERIAL_TOO_LARGE/);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("索引损坏 → 重建空索引（文件保留）", () => {
  const { store, dataRoot } = setup();
  const img = store.register({ name: "a", dataUrl: PNG_DATA_URL });
  writeFileSync(join(dataRoot, "materials", "index.json"), "{{{");
  assert.deepEqual(store.list(), []);
  assert.ok(existsSync(join(dataRoot, "materials", img.file))); // 文件仍在
  rmSync(dataRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-materials.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

新建 `lib/drama/materials.mjs`：

```js
// lib/drama/materials.mjs
// 素材库：用户上传的图片/音频/视频；data/materials/ 文件本体 + index.json 元数据索引
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const MATERIAL_KINDS = ["image", "audio", "video"];
export const MATERIAL_LIMITS = { image: 8 * 1024 * 1024, audio: 20 * 1024 * 1024, video: 50 * 1024 * 1024 };

// data-URL MIME → { kind, ext }
const MIME_MAP = {
  "image/png": { kind: "image", ext: "png" },
  "image/jpeg": { kind: "image", ext: "jpg" },
  "image/webp": { kind: "image", ext: "webp" },
  "audio/mpeg": { kind: "audio", ext: "mp3" },
  "audio/wav": { kind: "audio", ext: "wav" },
  "audio/mp4": { kind: "audio", ext: "m4a" },
  "audio/x-m4a": { kind: "audio", ext: "m4a" },
  "video/mp4": { kind: "video", ext: "mp4" },
  "video/webm": { kind: "video", ext: "webm" }
};

// 魔数校验：声明格式与文件内容必须一致（m4a/mp4 同为 ftyp 家族，以声明 kind 为准）
function sniffOk(bytes, ext) {
  if (ext === "png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (ext === "jpg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  if (ext === "webp") return bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  if (ext === "mp3") return bytes.subarray(0, 3).toString() === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (ext === "wav") return bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE";
  if (ext === "m4a" || ext === "mp4") return bytes.subarray(4, 8).toString() === "ftyp";
  if (ext === "webm") return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}

export function createMaterialStore(dataRoot) {
  const root = join(dataRoot, "materials");
  mkdirSync(root, { recursive: true });
  const indexFile = join(root, "index.json");

  function loadIndex() {
    try {
      const raw = JSON.parse(readFileSync(indexFile, "utf8"));
      return Array.isArray(raw) ? raw : [];
    } catch { return []; } // 索引损坏/不存在 → 空索引（文件仍在盘上，可重新登记）
  }
  function saveIndex(items) { writeFileSync(indexFile, JSON.stringify(items, null, 2)); }

  function normalizeMaterial(raw = {}) {
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : `mat-${randomUUID()}`,
      name: String(raw.name || "未命名素材").slice(0, 60),
      kind: MATERIAL_KINDS.includes(raw.kind) ? raw.kind : "image",
      file: String(raw.file || ""),
      size: Number.isInteger(raw.size) && raw.size >= 0 ? raw.size : 0,
      tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).slice(0, 20)).slice(0, 8) : [],
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString()
    };
  }

  function register({ name, dataUrl } = {}) {
    const match = String(dataUrl || "").match(/^data:([a-z0-9/+.=-]+);base64,([A-Za-z0-9+/=]+)$/i);
    if (!match) throw Object.assign(new Error("仅支持 base64 data-URL 上传"), { code: "MATERIAL_FORMAT_INVALID" });
    const mapped = MIME_MAP[match[1].toLowerCase()];
    if (!mapped) throw Object.assign(new Error("仅支持 png/jpg/webp 图片、mp3/wav/m4a 音频、mp4/webm 视频"), { code: "MATERIAL_FORMAT_INVALID" });
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > MATERIAL_LIMITS[mapped.kind]) {
      throw Object.assign(new Error(`素材超过大小限制（${mapped.kind} ≤ ${MATERIAL_LIMITS[mapped.kind] / 1024 / 1024}MB）`), { code: "MATERIAL_TOO_LARGE" });
    }
    if (!sniffOk(bytes, mapped.ext)) throw Object.assign(new Error("文件内容与格式不一致"), { code: "MATERIAL_BYTES_INVALID" });
    const material = normalizeMaterial({
      name: String(name || "").trim() || "未命名素材",
      kind: mapped.kind,
      file: `mat-${randomUUID()}.${mapped.ext}`,
      size: bytes.length,
      createdAt: new Date().toISOString()
    });
    writeFileSync(join(root, material.file), bytes);
    const items = loadIndex();
    items.unshift(material);
    saveIndex(items);
    return material;
  }

  function list({ kind, tag, q } = {}) {
    return loadIndex().map((m) => normalizeMaterial(m))
      .filter((m) => !kind || m.kind === kind)
      .filter((m) => !tag || m.tags.includes(tag))
      .filter((m) => !q || m.name.includes(q));
  }
  function get(id) {
    if (typeof id !== "string" || !/^mat-[a-f0-9-]+$/.test(id)) return null;
    const found = loadIndex().find((m) => m.id === id);
    return found ? normalizeMaterial(found) : null;
  }
  function update(id, patch) {
    const items = loadIndex();
    const idx = items.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    const fixed = items[idx];
    items[idx] = normalizeMaterial({ ...patch, id: fixed.id, kind: fixed.kind, file: fixed.file, size: fixed.size, createdAt: fixed.createdAt, name: patch.name ?? fixed.name, tags: patch.tags ?? fixed.tags });
    saveIndex(items);
    return items[idx];
  }
  function rename(id, name) { return update(id, { name: String(name || "").trim().slice(0, 60) || "未命名素材" }); }
  function setTags(id, tags) { return update(id, { tags: Array.isArray(tags) ? tags : [] }); }
  function remove(id) {
    const items = loadIndex();
    const found = items.find((m) => m.id === id);
    if (!found) return false;
    saveIndex(items.filter((m) => m.id !== id));
    const path = join(root, found.file);
    if (existsSync(path)) rmSync(path);
    return true;
  }

  return { list, get, register, rename, setTags, remove };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-materials.test.mjs && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/materials.mjs tests/drama-materials.test.mjs
git commit -m "feat: 素材库存储（上传/过滤/标签/删除）（M7 Task5）"
```

---

### Task 6: routes —— 素材端点 + server 挂载 + /materials/ 静态服务

**Files:**
- Modify: `lib/drama/routes.mjs`、`server.mjs`
- Test: `tests/drama-routes-materials.test.mjs`

**Interfaces:**
- Consumes: Task 5 的 `createMaterialStore`
- Produces: 端点 `GET/POST /api/drama/materials`、`PATCH/DELETE /api/drama/materials/{id}`；`/materials/<file>` 静态服务；ctx 新增 `materialStore`

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-routes-materials.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createMaterialStore } from "../lib/drama/materials.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; return res; }

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function ctx(dataRoot) {
  return {
    sendJson: (res, s, b) => res.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store: { get: () => null, dir: () => dataRoot, update: () => null, list: () => [], save: () => {} },
    materialStore: createMaterialStore(dataRoot),
    comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}
  };
}

test("素材：传→列（kind 过滤）→改名/标签→删", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rm-"));
  const c = ctx(dataRoot);
  let res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ name: "街景", dataUrl: PNG_DATA_URL }) }, res, new URL("http://x/api/drama/materials"), c);
  assert.equal(res.statusCode, 201);
  const mid = res.body.data.material.id;
  assert.equal(res.body.data.material.kind, "image");

  res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL("http://x/api/drama/materials?kind=image"), c);
  assert.equal(res.body.data.materials.length, 1);
  res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL("http://x/api/drama/materials?kind=video"), c);
  assert.equal(res.body.data.materials.length, 0);

  res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ name: "便利店夜景", tags: ["夜"] }) }, res, new URL(`http://x/api/drama/materials/${mid}`), c);
  assert.equal(res.body.data.material.name, "便利店夜景");
  assert.deepEqual(res.body.data.material.tags, ["夜"]);

  res = mockRes();
  await handleDramaApi({ method: "DELETE", socket: {} }, res, new URL(`http://x/api/drama/materials/${mid}`), c);
  assert.equal(res.body.data.removed, mid);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("坏素材 → 422；不存在 → 404", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rm-"));
  const c = ctx(dataRoot);
  let res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ name: "x", dataUrl: "data:text/plain;base64,aGVsbG8=" }) }, res, new URL("http://x/api/drama/materials"), c);
  assert.equal(res.statusCode, 422);
  res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL("http://x/api/drama/materials/mat-00000000-0000-0000-0000-000000000000"), c);
  assert.equal(res.statusCode, 404);
  rmSync(dataRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-routes-materials.test.mjs`
Expected: FAIL（素材路由未处理）

- [ ] **Step 3: 实现**

`lib/drama/routes.mjs`：在 prompt-templates 分支之后（demo 分支之前）插入：

```js
  const { materialStore } = ctx;
  if (segments[2] === "materials" && materialStore) {
    if (segments.length === 3 && request.method === "GET") {
      const materials = materialStore.list({
        kind: url.searchParams.get("kind") || undefined,
        tag: url.searchParams.get("tag") || undefined,
        q: url.searchParams.get("q") || undefined
      });
      return sendJson(response, 200, envelope(true, { materials }, { requestId }));
    }
    if (segments.length === 3 && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      let payload = {};
      try { payload = await readJson(request, 70_000_000); } catch { return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效或超过大小限制" })); }
      try {
        const material = materialStore.register({ name: payload.name, dataUrl: payload.dataUrl });
        return sendJson(response, 201, envelope(true, { material }, { requestId }));
      } catch (error) {
        const status = error.code === "MATERIAL_TOO_LARGE" ? 413 : 422;
        return sendJson(response, status, envelope(false, null, { requestId, errorCode: error.code || "MATERIAL_INVALID", message: error.message }));
      }
    }
    const material = materialStore.get(segments[3] || "");
    if (!material) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "MATERIAL_NOT_FOUND", message: "素材不存在" }));
    if (segments.length === 4 && request.method === "PATCH") {
      let payload = {};
      try { payload = await readJson(request, 10_000); } catch { return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" })); }
      let updated = material;
      if (typeof payload.name === "string") updated = materialStore.rename(material.id, payload.name);
      if (Array.isArray(payload.tags)) updated = materialStore.setTags(material.id, payload.tags);
      return sendJson(response, 200, envelope(true, { material: updated }, { requestId }));
    }
    if (segments.length === 4 && request.method === "DELETE") {
      materialStore.remove(material.id); // 资产引用不级联清理，前端显示「素材已删」
      return sendJson(response, 200, envelope(true, { removed: material.id }, { requestId }));
    }
    return false;
  }
```

`server.mjs`：
1. import 区加 `import { createMaterialStore } from "./lib/drama/materials.mjs";`
2. `handleDramaApi` 的 ctx 在 `promptStore: createPromptStore(dataRoot),` 行后加 `materialStore: createMaterialStore(dataRoot),`。
3. `contentTypes` 映射加 `".webm": "video/webm",`（现有缺 webm，素材库需要）。
4. `serveStatic` 内 `/uploads/` 分支之前加：

```js
  if (pathname.startsWith("/materials/")) {
    const fileName = pathname.slice("/materials/".length);
    if (!/^mat-[a-f0-9-]+\.(png|jpg|webp|mp3|wav|m4a|mp4|webm)$/i.test(fileName)) return false;
    const materialPath = join(dataRoot, "materials", fileName);
    if (!existsSync(materialPath)) return false;
    response.writeHead(200, {
      "Cache-Control": "private, max-age=86400",
      "Content-Type": contentTypes[extname(materialPath)] || "application/octet-stream"
    });
    createReadStream(materialPath).pipe(response);
    return true;
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-routes-materials.test.mjs && npm run test:unit && npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/routes.mjs server.mjs tests/drama-routes-materials.test.mjs
git commit -m "feat: 素材端点、server 挂载与静态服务（M7 Task6）"
```

---

### Task 7: schema 引用字段 + PATCH analysis/assets 端点

**Files:**
- Modify: `lib/drama/schema.mjs`、`lib/drama/routes.mjs`
- Test: `tests/drama-routes-assets.test.mjs`、`tests/drama-schema.test.mjs`

**Interfaces:**
- Consumes: Task 6 的 `materialStore.get`
- Produces: 场景/道具归一化新增 `refMaterialId`（默认 `null`）；角色新增 `refAudioMaterialId`（默认 `null`）；端点 `PATCH /api/drama/projects/{id}/analysis/assets`（更新外观锁 + 素材引用）

- [ ] **Step 1: 写失败测试**

在 `tests/drama-schema.test.mjs` 末尾追加：

```js
test("M7：场景/道具 refMaterialId、角色 refAudioMaterialId 归一化", () => {
  const a = normalizeAnalysis({
    synopsis: "s", genre: "g",
    characters: [{ id: "char-1", name: "林晚", appearance: "y", refAudioMaterialId: "mat-1" }],
    scenes: [{ id: "scene-1", name: "n", refMaterialId: "mat-2" }],
    props: [{ id: "prop-1", name: "伞", refMaterialId: "mat-3" }]
  });
  assert.equal(a.characters[0].refAudioMaterialId, "mat-1");
  assert.equal(a.scenes[0].refMaterialId, "mat-2");
  assert.equal(a.props[0].refMaterialId, "mat-3");
  const a2 = normalizeAnalysis({ synopsis: "s", genre: "g", characters: [{ id: "c", name: "x", appearance: "y" }], scenes: [{ id: "s1", name: "n" }] });
  assert.equal(a2.characters[0].refAudioMaterialId, null);
  assert.equal(a2.scenes[0].refMaterialId, null);
  assert.equal(a2.props.length, 0);
});
```

新建 `tests/drama-routes-assets.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createMaterialStore } from "../lib/drama/materials.mjs";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject, normalizeAnalysis } from "../lib/drama/schema.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; return res; }

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const MP3_DATA_URL = `data:audio/mpeg;base64,${Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]).toString("base64")}`;

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-ra-"));
  const store = createDramaStore(dataRoot);
  const project = store.save(createDramaProject({ title: "t", script: "剧本内容".repeat(15) }));
  store.update(project.id, (p) => {
    p.analysis = normalizeAnalysis({
      synopsis: "s", genre: "g",
      characters: [{ id: "char-1", name: "林晚", appearance: "young woman" }],
      scenes: [{ id: "scene-1", name: "便利店门口", appearance: "store front" }],
      props: [{ id: "prop-1", name: "雨伞", appearance: "black umbrella" }]
    });
  });
  const materialStore = createMaterialStore(dataRoot);
  const ctx = {
    sendJson: (res, s, b) => res.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store, materialStore,
    comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}
  };
  return { ctx, project, materialStore, dataRoot };
}

test("资产引用与外观锁编辑：场景参考图 + 角色配音参考 + 外观锁", async () => {
  const { ctx, project, materialStore, dataRoot } = setup();
  const img = materialStore.register({ name: "街景", dataUrl: PNG_DATA_URL });
  const audio = materialStore.register({ name: "雨声", dataUrl: MP3_DATA_URL });
  const res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({
    scenes: [{ id: "scene-1", refMaterialId: img.id, appearance: "rainy store front, neon" }],
    characters: [{ id: "char-1", refAudioMaterialId: audio.id }]
  }) }, res, new URL(`http://x/api/drama/projects/${project.id}/analysis/assets`), ctx);
  assert.equal(res.statusCode, 200);
  const a = res.body.data.project.analysis;
  assert.equal(a.scenes[0].refMaterialId, img.id);
  assert.equal(a.scenes[0].appearance, "rainy store front, neon");
  assert.equal(a.characters[0].refAudioMaterialId, audio.id);
  // 置 null 解除引用
  const res2 = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ scenes: [{ id: "scene-1", refMaterialId: null }] }) }, res2, new URL(`http://x/api/drama/projects/${project.id}/analysis/assets`), ctx);
  assert.equal(res2.body.data.project.analysis.scenes[0].refMaterialId, null);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("引用校验：类型不符/素材不存在 → 422；无分析 → 409", async () => {
  const { ctx, project, materialStore, dataRoot } = setup();
  const audio = materialStore.register({ name: "雨声", dataUrl: MP3_DATA_URL });
  let res = mockRes();
  // 场景引用音频 → 类型不符
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ scenes: [{ id: "scene-1", refMaterialId: audio.id }] }) }, res, new URL(`http://x/api/drama/projects/${project.id}/analysis/assets`), ctx);
  assert.equal(res.statusCode, 422);
  // 不存在素材
  res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ scenes: [{ id: "scene-1", refMaterialId: "mat-00000000-0000-0000-0000-000000000000" }] }) }, res, new URL(`http://x/api/drama/projects/${project.id}/analysis/assets`), ctx);
  assert.equal(res.statusCode, 422);
  // 无分析项目
  const p2 = ctx.store.save(createDramaProject({ title: "t2", script: "剧本内容".repeat(15) }));
  res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ scenes: [] }) }, res, new URL(`http://x/api/drama/projects/${p2.id}/analysis/assets`), ctx);
  assert.equal(res.statusCode, 409);
  rmSync(dataRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-schema.test.mjs && node --test tests/drama-routes-assets.test.mjs`
Expected: FAIL（字段 undefined / 端点 404）

- [ ] **Step 3: 实现**

`lib/drama/schema.mjs`：
1. `normalizeCharacter` 返回对象在 `voiceId: …` 行后加：

```js
    // M7 新增：配音参考音频素材（仅引用记录，不注入生成）
    ,refAudioMaterialId: typeof raw.refAudioMaterialId === "string" && raw.refAudioMaterialId ? raw.refAudioMaterialId : null
```

（注意调整为合法的对象字面量逗号位置：把 `voiceId` 行尾加逗号，新字段紧随其后。）

2. `normalizeAnalysis` 的 scenes map 在 `appearance: String(s?.appearance || "").slice(0, 400)` 行后加：

```js
      // M7 新增：场景参考图素材（仅引用记录）
      ,refMaterialId: typeof s?.refMaterialId === "string" && s.refMaterialId ? s.refMaterialId : null
```

（同样注意逗号位置。）

3. `normalizeProp` 返回对象在 `appearance: …` 行后加 `refMaterialId`（同场景写法）。

`lib/drama/routes.mjs`：在 characters PATCH 块之后（shots PATCH 块之前）插入：

```js
    // M7：资产引用与外观锁编辑（场景/道具参考图、角色配音参考、外观锁）
    if (segments.length === 6 && segments[4] === "analysis" && segments[5] === "assets" && request.method === "PATCH") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      let payload = {};
      try { payload = await readJson(request, 100_000); } catch { return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" })); }
      if (!project.analysis) return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "ANALYSIS_REQUIRED", message: "请先运行剧本分析" }));
      // 引用校验在 update 前完成：置 null 解除引用总允许；非 null 必须存在且类型匹配
      const checkRef = (id, kind) => {
        if (id === null || typeof id === "undefined") return null;
        const m = ctx.materialStore?.get(String(id));
        if (!m) return "素材不存在";
        if (m.kind !== kind) return kind === "image" ? "参考素材必须是图片" : "配音参考必须是音频";
        return null;
      };
      for (const s of Array.isArray(payload.scenes) ? payload.scenes : []) {
        const err = checkRef(s?.refMaterialId, "image");
        if (err) return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "MATERIAL_REF_INVALID", message: `场景参考图：${err}` }));
      }
      for (const pr of Array.isArray(payload.props) ? payload.props : []) {
        const err = checkRef(pr?.refMaterialId, "image");
        if (err) return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "MATERIAL_REF_INVALID", message: `道具参考图：${err}` }));
      }
      for (const c of Array.isArray(payload.characters) ? payload.characters : []) {
        const err = checkRef(c?.refAudioMaterialId, "audio");
        if (err) return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "MATERIAL_REF_INVALID", message: `角色配音参考：${err}` }));
      }
      const updated = store.update(projectId, (p) => {
        if (!p.analysis) return;
        for (const s of Array.isArray(payload.scenes) ? payload.scenes : []) {
          const scene = p.analysis.scenes.find((x) => x.id === s?.id);
          if (!scene) continue;
          if (typeof s.appearance === "string") scene.appearance = s.appearance.slice(0, 400);
          if (typeof s.refMaterialId !== "undefined") scene.refMaterialId = s.refMaterialId;
        }
        for (const pr of Array.isArray(payload.props) ? payload.props : []) {
          const prop = (p.analysis.props || []).find((x) => x.id === pr?.id);
          if (!prop) continue;
          if (typeof pr.appearance === "string") prop.appearance = pr.appearance.slice(0, 400);
          if (typeof pr.refMaterialId !== "undefined") prop.refMaterialId = pr.refMaterialId;
        }
        for (const c of Array.isArray(payload.characters) ? payload.characters : []) {
          const char = p.analysis.characters.find((x) => x.id === c?.id);
          if (!char) continue;
          if (typeof c.appearance === "string") char.appearance = c.appearance.slice(0, 400);
          if (typeof c.refAudioMaterialId !== "undefined") char.refAudioMaterialId = c.refAudioMaterialId;
        }
      });
      return sendJson(response, 200, envelope(true, { project: updated }, { requestId }));
    }
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-schema.test.mjs && node --test tests/drama-routes-assets.test.mjs && npm run test:unit && npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/schema.mjs lib/drama/routes.mjs tests/drama-schema.test.mjs tests/drama-routes-assets.test.mjs
git commit -m "feat: 资产素材引用与外观锁编辑端点（M7 Task7）"
```

---

### Task 8: 前端素材 tab + 资产卡引用与外观锁编辑

**Files:**
- Modify: `public/drama.html`、`public/drama.js`、`public/drama.css`

**Interfaces:**
- Consumes: Task 6/7 端点；Task 4 的 `setPlatformTab`
- Produces: 素材 tab 完整功能（筛选/上传/预览/改名/删除）；资产视图场景/道具卡加参考图选择与外观锁编辑、角色卡加配音参考选择（仅本项目模式，共享库只读不加）

- [ ] **Step 1: 素材 tab HTML**

`public/drama.html` 的 `#platformMaterials` 占位内容替换为：

```html
          <div id="platformMaterials" class="hidden">
            <div class="vz-card" style="padding:14px">
              <div class="vz-rowline">
                <b style="font-size:13px">素材库</b>
                <div class="vz-seg" id="materialKindSeg" style="width:280px">
                  <button data-kind="" class="on">全部</button>
                  <button data-kind="image">图片</button>
                  <button data-kind="audio">音频</button>
                  <button data-kind="video">视频</button>
                </div>
                <input id="materialFile" type="file" accept="image/png,image/jpeg,image/webp,audio/mpeg,audio/wav,audio/mp4,audio/x-m4a,video/mp4,video/webm" hidden />
                <button class="vz-btn" id="uploadMaterialBtn">上传素材…</button>
              </div>
              <div id="materialGrid" style="margin-top:10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px"></div>
            </div>
          </div>
```

- [ ] **Step 2: 素材 JS**

`public/drama.js`：
1. `state` 加 `materials: [], materialKind: "",`。
2. `setPlatformTab` 内 `if (tab === "prompts") loadPromptTemplates();` 行后加 `if (tab === "materials") loadMaterials();`。
3. 新增（放在平台区函数之后）：

```js
// ---------- 平台：素材库 ----------
async function loadMaterials() {
  try {
    const kind = state.materialKind || "";
    const { data } = await api(`/api/drama/materials${kind ? `?kind=${kind}` : ""}`);
    state.materials = data.materials || [];
  } catch { state.materials = []; }
  renderMaterialGrid();
}

function renderMaterialGrid() {
  const box = $("#materialGrid");
  if (!box) return;
  box.innerHTML = "";
  if (!state.materials.length) { box.innerHTML = '<p class="muted">还没有素材，点击「上传素材」添加图片/音频/视频。</p>'; return; }
  for (const m of state.materials) {
    const card = document.createElement("div");
    card.className = "vz-card";
    card.style.padding = "8px";
    const url = `/materials/${m.file}`;
    let preview;
    if (m.kind === "image") {
      preview = document.createElement("img");
      preview.src = url;
      preview.style.cssText = "width:100%;border-radius:8px;aspect-ratio:1;object-fit:cover";
    } else if (m.kind === "audio") {
      preview = document.createElement("audio");
      preview.src = url; preview.controls = true; preview.style.width = "100%";
    } else {
      preview = document.createElement("video");
      preview.src = url; preview.controls = true; preview.style.cssText = "width:100%;border-radius:8px";
    }
    const name = document.createElement("div");
    name.style.cssText = "font-size:12px;margin-top:6px";
    name.textContent = m.name;
    const ops = document.createElement("div");
    ops.className = "vz-rowline"; ops.style.marginTop = "6px";
    const rn = document.createElement("button"); rn.className = "vz-btn"; rn.textContent = "改名";
    rn.addEventListener("click", () => renameMaterial(m));
    const del = document.createElement("button"); del.className = "vz-btn"; del.textContent = "删除";
    del.addEventListener("click", () => deleteMaterial(m));
    ops.append(rn, del);
    card.append(preview, name, ops);
    box.append(card);
  }
}

async function renameMaterial(m) {
  const next = window.prompt("素材名称", m.name);
  if (!next) return;
  try {
    await api(`/api/drama/materials/${m.id}`, { method: "PATCH", body: JSON.stringify({ name: next }) });
    await loadMaterials();
  } catch (error) { showError(error.message || error); }
}

async function deleteMaterial(m) {
  if (!window.confirm(`删除素材「${m.name}」？引用它的资产会显示「素材已删」。`)) return;
  try {
    await api(`/api/drama/materials/${m.id}`, { method: "DELETE" });
    await loadMaterials();
    toast("已删除素材", m.name);
  } catch (error) { showError(error.message || error); }
}

function pickMaterialFile() {
  const input = $("#materialFile");
  input.value = "";
  input.click();
}

async function onMaterialFilePicked() {
  const file = $("#materialFile").files[0];
  if (!file) return;
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
  try {
    await api("/api/drama/materials", { method: "POST", body: JSON.stringify({ name: file.name.replace(/\.[a-z0-9]+$/i, ""), dataUrl }) });
    toast("已上传素材", file.name);
    await loadMaterials();
  } catch (error) { showError(error.message || error); }
}
```

4. 事件绑定区加：

```js
$$("#materialKindSeg [data-kind]").forEach((b) => b.addEventListener("click", () => {
  state.materialKind = b.dataset.kind;
  $$("#materialKindSeg [data-kind]").forEach((x) => x.classList.toggle("on", x === b));
  loadMaterials();
}));
if ($("#uploadMaterialBtn")) $("#uploadMaterialBtn").addEventListener("click", pickMaterialFile);
if ($("#materialFile")) $("#materialFile").addEventListener("change", onMaterialFilePicked);
```

5. 初始化区 `loadPromptTemplates();` 行后加 `loadMaterials();`（资产视图引用选择器需要素材列表）。

- [ ] **Step 3: 资产卡引用与外观锁编辑**

`public/drama.js`：
1. 新增统一的资产引用保存函数：

```js
// 资产引用/外观锁保存：M7 PATCH analysis/assets（仅本项目模式可编辑）
async function saveAssetPatch(payload) {
  if (!state.project) return;
  try {
    const { data } = await api(`/api/drama/projects/${state.project.id}/analysis/assets`, { method: "PATCH", body: JSON.stringify(payload) });
    state.project = data.project;
    renderProject();
    toast("已更新资产");
  } catch (error) { showError(error.message || error); }
}

// 素材下拉构造器：kind 过滤；引用已删素材时显示占位项
function materialSelectOptions(sel, kind, currentId) {
  const none = document.createElement("option"); none.value = ""; none.textContent = "无";
  sel.append(none);
  const known = new Set((state.materials || []).filter((m) => m.kind === kind).map((m) => m.id));
  for (const m of state.materials || []) {
    if (m.kind !== kind) continue;
    const o = document.createElement("option"); o.value = m.id; o.textContent = m.name;
    sel.append(o);
  }
  if (currentId && !known.has(currentId)) {
    const gone = document.createElement("option"); gone.value = currentId; gone.textContent = "素材已删"; gone.disabled = true;
    sel.append(gone);
  }
  sel.value = currentId || "";
}
```

2. `renderSceneAssets`：外观锁 `app` 从只读 div 改为可编辑 textarea，并加参考图选择（仅 `!analysis` 即本项目模式）。循环体替换为：

```js
  for (const s of scenes) {
    const item = document.createElement("div");
    item.className = "vz-char";
    const name = document.createElement("b"); name.textContent = `${s.name} · ${s.location || ""}`;
    const mood = document.createElement("div"); mood.className = "muted"; mood.textContent = s.mood || "";
    item.append(name, mood);
    if (!analysis) {
      const app = document.createElement("textarea");
      app.className = "muted mono";
      app.style.cssText = "width:100%;min-height:44px;font-size:10px;margin-top:4px;border:1px solid var(--border);border-radius:8px;padding:6px";
      app.value = s.appearance || "";
      app.placeholder = "英文外观锁（重跑提示词阶段后生效）";
      app.addEventListener("change", () => saveAssetPatch({ scenes: [{ id: s.id, appearance: app.value }] }));
      const row = document.createElement("label");
      row.className = "bind-row";
      row.append(document.createTextNode("参考图"));
      const sel = document.createElement("select");
      materialSelectOptions(sel, "image", s.refMaterialId);
      sel.addEventListener("change", () => saveAssetPatch({ scenes: [{ id: s.id, refMaterialId: sel.value || null }] }));
      row.append(sel);
      item.append(app, row);
    } else {
      const app = document.createElement("div"); app.className = "muted mono"; app.style.fontSize = "10px"; app.textContent = s.appearance || "（无外观锁）";
      item.append(app);
    }
    box.append(item);
  }
```

3. `renderPropAssets`：同模式改造（`refMaterialId`、外观锁 textarea，`saveAssetPatch({ props: [{ id: p.id, … }] })`）。
4. `renderCharacters`：在 `voiceRow` 之后加配音参考选择（仅 `!readOnly`）：

```js
    if (!readOnly) {
      const refRow = document.createElement("label");
      refRow.className = "bind-row";
      refRow.append(document.createTextNode("配音参考"));
      const refSel = document.createElement("select");
      materialSelectOptions(refSel, "audio", character.refAudioMaterialId);
      refSel.addEventListener("change", () => saveAssetPatch({ characters: [{ id: character.id, refAudioMaterialId: refSel.value || null }] }));
      refRow.append(refSel);
      card.append(refRow);
    }
```

- [ ] **Step 4: 校验 + Commit**

Run: `npm run check`
```bash
git add public/drama.html public/drama.js public/drama.css
git commit -m "feat: 素材库面板与资产引用、外观锁编辑（M7 Task8）"
```

---

## 阶段 C：模型管理

### Task 9: providers 聚合端点（只读）

**Files:**
- Modify: `lib/drama/routes.mjs`
- Test: `tests/drama-routes-providers.test.mjs`

**Interfaces:**
- Consumes: ctx 的 `llmDeps.config`、`comfyConfig`、`seedanceStatus()`、`audioDeps`、`detectFfmpeg()`；`loadVideoWorkflowTemplate`（routes.mjs 已 import）
- Produces: `GET /api/drama/providers` → `{ providers: [{ id:"llm|comfyui|seedance|voice|ffmpeg", name, required:"required|recommended|optional", status:"ready|degraded|missing", summary, hint }] }`

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-routes-providers.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; return res; }

function baseCtx(overrides = {}) {
  return {
    sendJson: (res, s, b) => res.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store: { get: () => null, dir: () => "", update: () => null, list: () => [], save: () => {} },
    llmDeps: { config: { mock: true } },
    comfyConfig: {},
    seedanceStatus: () => ({ configured: false, connected: false, state: "runtime_missing" }),
    audioDeps: {},
    detectFfmpeg: () => ({ available: false, path: null, version: null }),
    pricing: {}, findAvatar: () => null, findVoice: () => null, seedanceConfig: {},
    ...overrides
  };
}

test("providers 聚合：五区块形状 + 状态枚举合法 + 脱敏", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rpv-"));
  const ctx = baseCtx({
    llmDeps: { config: { mock: false, baseUrl: "https://api.example.com/v1", model: "m-x", apiKey: "sk-SECRET" } },
    comfyConfig: { baseUrl: "http://127.0.0.1:8188" },
    seedanceStatus: () => ({ configured: true, connected: true, state: "connected" }),
    audioDeps: { voiceboxUrl: "http://127.0.0.1:5005", elevenKey: "sk-ELEVEN" },
    detectFfmpeg: () => ({ available: true, version: "7.1" })
  });
  const res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL("http://x/api/drama/providers"), ctx);
  assert.equal(res.statusCode, 200);
  const providers = res.body.data.providers;
  assert.deepEqual(providers.map((p) => p.id), ["llm", "comfyui", "seedance", "voice", "ffmpeg"]);
  for (const p of providers) {
    assert.ok(["ready", "degraded", "missing"].includes(p.status), `${p.id} status 合法`);
    assert.ok(["required", "recommended", "optional"].includes(p.required), `${p.id} required 合法`);
    assert.ok(typeof p.summary === "string" && typeof p.hint === "string");
  }
  assert.equal(providers[0].status, "ready");   // 已配置 LLM
  assert.equal(providers[0].summary.includes("api.example.com"), true);
  assert.equal(providers[2].status, "ready");   // seedance connected
  assert.equal(providers[3].status, "ready");   // voicebox 已检测
  assert.equal(providers[4].status, "ready");   // ffmpeg 可用
  // 脱敏：响应体不得含密钥明文或密钥字段
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes("sk-SECRET") && !raw.includes("sk-ELEVEN") && !raw.includes("apiKey"));
  rmSync(dataRoot, { recursive: true, force: true });
});

test("单区块探测抛错不拖垮整页；mock LLM → degraded", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rpv-"));
  const ctx = baseCtx({
    seedanceStatus: () => { throw new Error("boom"); }
  });
  const res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL("http://x/api/drama/providers"), ctx);
  assert.equal(res.statusCode, 200);
  const providers = res.body.data.providers;
  assert.equal(providers.length, 5);
  assert.equal(providers[0].status, "degraded"); // mock LLM
  const seedance = providers.find((p) => p.id === "seedance");
  assert.equal(seedance.status, "missing");
  assert.equal(seedance.summary, "状态探测失败");
  rmSync(dataRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-routes-providers.test.mjs`
Expected: FAIL（端点未处理 → 404/false，`providers` undefined）

- [ ] **Step 3: 实现**

`lib/drama/routes.mjs`：在 materials 分支之后（demo 分支之前）插入：

```js
  // M7：模型管理只读状态总览（无存储；密钥只出布尔语义，永不返回值）
  if (segments.length === 3 && segments[2] === "providers" && request.method === "GET") {
    const providers = [];
    const probe = (id, name, required, fn) => {
      try { providers.push({ id, name, required, ...fn() }); }
      catch (error) { providers.push({ id, name, required, status: "missing", summary: "状态探测失败", hint: safeErrorMessage(error) }); }
    };
    probe("llm", "编排 LLM", "optional", () => {
      const cfg = ctx.llmDeps?.config || {};
      if (cfg.mock || !cfg.baseUrl || !cfg.model) {
        return { status: "degraded", summary: "未配置，走本机演示编排（mock），不产生费用", hint: "在 .env 配置 DRAMA_LLM_BASE_URL / DRAMA_LLM_MODEL / DRAMA_LLM_API_KEY" };
      }
      let host = "（端点地址异常）";
      try { host = new URL(cfg.baseUrl).host; } catch { /* 保持占位 */ }
      return { status: "ready", summary: `${host} · ${cfg.model}`, hint: "OpenAI 兼容端点" };
    });
    probe("comfyui", "ComfyUI 首帧/视频", "recommended", () => {
      const baseUrl = ctx.comfyConfig?.baseUrl || "";
      if (!baseUrl) return { status: "missing", summary: "未配置本机 ComfyUI 地址", hint: "在 .env 配置 COMFYUI_URL；首帧与剧情镜视频依赖它" };
      let host = baseUrl.slice(0, 40);
      try { host = new URL(baseUrl).host; } catch { /* 回退截断展示 */ }
      const hasTemplate = Boolean(loadVideoWorkflowTemplate(ctx.videoEnv || process.env));
      return {
        status: hasTemplate ? "ready" : "degraded",
        summary: `${host}${hasTemplate ? " · 视频模板已配置" : " · 首帧可用，视频模板缺失"}`,
        hint: hasTemplate ? "" : "配置 DRAMA_VIDEO_WORKFLOW 或 config/drama-video-workflow.json 启用剧情镜视频"
      };
    });
    probe("seedance", "Seedance 口播", "required", () => {
      const s = ctx.seedanceStatus ? ctx.seedanceStatus() : { configured: false, connected: false };
      if (!s.configured) return { status: "missing", summary: "未配置本机适配器", hint: "按接入说明配置 SEEDANCE_PYTHON / TOOL_VAULT_PATH / SEEDANCE_RUNNER" };
      return { status: s.connected ? "ready" : "degraded", summary: s.connected ? "已连接" : `未就绪（${s.state || "unknown"}）`, hint: s.connected ? "" : "检查本机适配器与授权状态" };
    });
    probe("voice", "配音", "optional", () => {
      const deps = ctx.audioDeps || {};
      const voicebox = deps.voiceboxUrl ? "Voicebox 已检测" : "Voicebox 未检测";
      const eleven = deps.elevenKey ? "ElevenLabs 已配置" : "ElevenLabs 未配置";
      const ready = Boolean(deps.voiceboxUrl || deps.elevenKey);
      return { status: ready ? "ready" : "missing", summary: `${voicebox} · ${eleven}`, hint: ready ? "" : "安装 Voicebox 或在 .env 配置 ELEVENLABS_API_KEY" };
    });
    probe("ffmpeg", "FFmpeg 合成", "recommended", () => {
      const ff = ctx.detectFfmpeg ? ctx.detectFfmpeg() : { available: false };
      return ff.available
        ? { status: "ready", summary: `可用 · ${ff.version || "unknown"}`, hint: "" }
        : { status: "missing", summary: "未检测到", hint: "macOS：brew install ffmpeg" };
    });
    return sendJson(response, 200, envelope(true, { providers }, { requestId }));
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-routes-providers.test.mjs && npm run test:unit && npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/routes.mjs tests/drama-routes-providers.test.mjs
git commit -m "feat: 模型状态只读聚合端点（M7 Task9）"
```

---

### Task 10: 前端模型 tab

**Files:**
- Modify: `public/drama.html`、`public/drama.js`、`public/drama.css`

**Interfaces:**
- Consumes: Task 9 端点；Task 4 的 `setPlatformTab`
- Produces: 模型 tab 状态卡片栅格 + 手动刷新

- [ ] **Step 1: 模型 tab HTML**

`public/drama.html` 的 `#platformModels` 占位内容替换为：

```html
          <div id="platformModels" class="hidden">
            <div class="vz-card" style="padding:14px">
              <div class="vz-rowline">
                <b style="font-size:13px">模型与后端状态</b>
                <button class="vz-btn" id="refreshProvidersBtn">刷新</button>
              </div>
              <p class="muted" style="margin-top:6px">配置修改请编辑 .env 或 config 文件后重启服务；此处仅展示状态，密钥永不明文展示。</p>
              <div id="providerGrid" style="margin-top:10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px"></div>
            </div>
          </div>
```

- [ ] **Step 2: 模型 JS**

`public/drama.js`：
1. `setPlatformTab` 内 `if (tab === "materials") loadMaterials();` 行后加 `if (tab === "models") loadProviders();`。
2. 新增：

```js
// ---------- 平台：模型状态 ----------
const PROVIDER_STATUS_LABEL = { ready: "● 就绪", degraded: "● 降级", missing: "● 未配置" };
const PROVIDER_STATUS_COLOR = { ready: "var(--ok, #2a9d5c)", degraded: "#c9a227", missing: "var(--muted)" };
const PROVIDER_REQUIRED_LABEL = { required: "必需", recommended: "推荐", optional: "可选" };

async function loadProviders() {
  const box = $("#providerGrid");
  if (!box) return;
  box.innerHTML = '<p class="muted">探测中…</p>';
  let providers = [];
  try {
    const { data } = await api("/api/drama/providers");
    providers = data.providers || [];
  } catch (error) {
    box.innerHTML = `<p class="muted">状态获取失败：${error.message}</p>`;
    return;
  }
  box.innerHTML = "";
  for (const p of providers) {
    const card = document.createElement("div");
    card.className = "vz-card";
    card.style.padding = "10px";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;justify-content:space-between;align-items:center";
    const name = document.createElement("b"); name.style.fontSize = "13px"; name.textContent = p.name;
    const req = document.createElement("span"); req.className = "muted"; req.style.fontSize = "11px";
    req.textContent = PROVIDER_REQUIRED_LABEL[p.required] || p.required;
    head.append(name, req);
    const status = document.createElement("div");
    status.style.cssText = `margin-top:6px;font-size:12px;color:${PROVIDER_STATUS_COLOR[p.status] || "inherit"}`;
    status.textContent = PROVIDER_STATUS_LABEL[p.status] || p.status;
    const summary = document.createElement("div");
    summary.className = "muted"; summary.style.cssText = "margin-top:4px;font-size:12px";
    summary.textContent = p.summary || "";
    card.append(head, status, summary);
    if (p.hint) {
      const hint = document.createElement("div");
      hint.className = "muted"; hint.style.cssText = "margin-top:4px;font-size:11px";
      hint.textContent = p.hint;
      card.append(hint);
    }
    box.append(card);
  }
}
```

3. 事件绑定区加：`if ($("#refreshProvidersBtn")) $("#refreshProvidersBtn").addEventListener("click", loadProviders);`

- [ ] **Step 3: 校验 + Commit**

Run: `npm run check`
```bash
git add public/drama.html public/drama.js public/drama.css
git commit -m "feat: 模型状态总览面板（M7 Task10）"
```

---

## 收尾

### Task 11: check 脚本 + smoke 守卫 + 全量验证

**Files:**
- Modify: `package.json`、`scripts/smoke.mjs`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: check 覆盖 prompts/materials；smoke 含 M7 三守卫

- [ ] **Step 1: package.json check 增加新模块**

`check` 脚本在 `node --check lib/drama/version.mjs` 之后追加 `&& node --check lib/drama/prompts.mjs && node --check lib/drama/materials.mjs`。

- [ ] **Step 2: smoke 守卫**

`scripts/smoke.mjs` 在 M6 守卫之后（`console.log` 之前）追加：

```js
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
```

并在收尾 `console.log` 对象加 `promptTemplateGuard: tplRes.template.id, materialGuard: matRes.material.id, providersGuard: provRes.providers.length,`。

- [ ] **Step 3: 全量验证**

Run: `npm run check && npm run test:unit && npm run smoke`
Expected: 全通过；smoke 输出含 `promptTemplateGuard`/`materialGuard`/`providersGuard`

- [ ] **Step 4: Commit**

```bash
git add package.json scripts/smoke.mjs
git commit -m "test: 提示词模板、素材与 providers 冒烟守卫（M7 Task11 收尾）"
```

---

## Self-Review 记录

- **Spec coverage**：提示词库多模板+项目选用（T1–T4）、素材库上传+引用记录（T5–T8）、模型管理只读总览（T9–T10）、验证（T11）——spec 各节均有对应任务；builtin 只读、逐段回退、切换不追溯、外观锁编辑解锁（M6 遗留）均已覆盖。
- **Placeholder scan**：无 TBD/TODO；后端代码完整，前端为可运行实现；schema 逗号调整已在任务内注明。
- **Type consistency**：`createPromptStore → {list,get,create,save,remove,duplicate,resolveStages}`（T1）→ routes（T3）/pipeline（T2）一致；`BUILTIN_TEMPLATE_ID`（T1）→ T3 测试一致；`createMaterialStore → {list,get,register,rename,setTags,remove}`（T5）→ routes（T6）/assets 校验（T7）一致；`refMaterialId/refAudioMaterialId`（T7）→ 前端 `saveAssetPatch`（T8）一致；providers 形状（T9）→ 前端 `PROVIDER_*` 映射（T10）一致；端点路径与前端 `api()` 调用逐一核对一致。
- **已知简化（对 spec 无偏离，显式注明）**：m4a/mp4 同为 ftyp 魔数家族，以声明 MIME 的 kind 为准（本机工具可接受）；素材标签编辑 UI 仅后端与改名入口，标签输入留待需要时再加（列表过滤已支持 tag 参数）；模型 tab 手动刷新不轮询。
