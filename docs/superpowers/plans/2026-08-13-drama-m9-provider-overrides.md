# 短剧工作台 M9：多模型后端编排实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 项目级 providerOverrides 覆盖 env 默认（LLM + 配音 ElevenLabs），运行期切换不重启；密钥本机文件存、API 永不返回明文。

**Architecture:** 复用 M7 `promptTemplateId` 模式；`createProviderOverrideStore(dataRoot)` 存 `data/provider-overrides/<projectId>.json`；project schema 只存脱敏布尔标记；`resolveLlmConfig(envConfig, override)` 合并（override 优先）；流水线/口播发起时按 project.id 取 override 快照进 deps；GET 端点脱敏只出 baseUrl/model + configured 布尔，apiKey 永不出。

**Tech Stack:** 零框架原生 HTML/CSS/JS；Node 20+；本机 JSON 文件存储；`node:test`。

**Spec:** `docs/superpowers/specs/2026-08-13-drama-m9-provider-overrides-design.md`

## Global Constraints

- 零框架、无构建链、不引入新 npm 依赖；本机优先、私密不出本机。
- 中文提交信息（`类型: 简短描述`）；遵循既有 `lib/drama/*` 与 `tests/drama-*.test.mjs` 模式。
- 密钥永不入响应体明文，永不入 project JSON；只存 override 文件，只出布尔语义。
- 既有流水线/首帧/口播/合成链路零回归；override 发起时快照，进行中不切换。
- ComfyUI/Seedance/FFmpeg 不做项目级覆盖（本机各一个，YAGNI）。

---

## 阶段 A：存储与 schema

### Task 1: provider-overrides.mjs 存储 + schema providerOverrides 字段

**Files:**
- Create: `lib/drama/provider-overrides.mjs`
- Modify: `lib/drama/schema.mjs`（`createDramaProject`/`normalizeProject` 加 `providerOverrides`）
- Test: `tests/drama-provider-overrides.test.mjs`、`tests/drama-schema.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `createProviderOverrideStore(dataRoot)` → `{ get, save, remove }`；override 文件形状 `{ projectId, llm?: { baseUrl, model, apiKey }, voice?: { elevenKey } }`；`normalizeProject` 返回 `providerOverrides: { llm: null, voice: null }`（脱敏标记，不存密钥）

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-provider-overrides.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderOverrideStore } from "../lib/drama/provider-overrides.mjs";

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-po-"));
  return { store: createProviderOverrideStore(dataRoot), dataRoot };
}

test("get 不存在返回 null；save→get→remove", () => {
  const { store, dataRoot } = setup();
  assert.equal(store.get("drama-1"), null);
  store.save("drama-1", { llm: { baseUrl: "https://api.x.com/v1", model: "gpt-4o", apiKey: "sk-x" } });
  const ov = store.get("drama-1");
  assert.deepEqual(ov, { projectId: "drama-1", llm: { baseUrl: "https://api.x.com/v1", model: "gpt-4o", apiKey: "sk-x" } });
  store.save("drama-1", { voice: { elevenKey: "sk-e" } });
  assert.equal(store.get("drama-1").voice.elevenKey, "sk-e");
  assert.equal(store.remove("drama-1"), true);
  assert.equal(store.get("drama-1"), null);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("损坏文件 get 返回 null（自愈）", () => {
  const { store, dataRoot } = setup();
  store.save("drama-1", { llm: { baseUrl: "x", model: "y", apiKey: "z" } });
  // 写损坏 JSON
  const f = join(dataRoot, "provider-overrides", "drama-1.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(f, "{{{");
  assert.equal(store.get("drama-1"), null);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("save 校验：llm 必须三字段齐全；voice 必须有 elevenKey", () => {
  const { store, dataRoot } = setup();
  assert.throws(() => store.save("drama-1", { llm: { baseUrl: "", model: "y", apiKey: "z" } }), /PROVIDER_OVERRIDE_INVALID/);
  assert.throws(() => store.save("drama-1", { voice: { elevenKey: "" } }), /PROVIDER_OVERRIDE_INVALID/);
  rmSync(dataRoot, { recursive: true, force: true });
});
```

在 `tests/drama-schema.test.mjs` 末尾追加：

```js
test("M9：project.providerOverrides 归一化（脱敏标记，不存密钥）", () => {
  const p1 = normalizeProject({ id: "drama-1", title: "t", script: "s", ratio: "portrait", providerOverrides: { llm: { configured: true, baseUrl: "https://x", model: "y" }, voice: { configured: true } } });
  assert.deepEqual(p1.providerOverrides, { llm: { configured: true, baseUrl: "https://x", model: "y" }, voice: { configured: true } });
  const p2 = normalizeProject({ id: "drama-1", title: "t", script: "s", ratio: "portrait" });
  assert.deepEqual(p2.providerOverrides, { llm: null, voice: null });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-provider-overrides.test.mjs && node --test tests/drama-schema.test.mjs`
Expected: FAIL（模块不存在 / `providerOverrides` undefined）

- [ ] **Step 3: 实现**

新建 `lib/drama/provider-overrides.mjs`：

```js
// lib/drama/provider-overrides.mjs
// 项目级后端配置覆盖：LLM + ElevenLabs；密钥存本机文件，永不入 project JSON 或 API 响应
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export function createProviderOverrideStore(dataRoot) {
  const root = join(dataRoot, "provider-overrides");
  mkdirSync(root, { recursive: true });
  const file = (projectId) => join(root, `${projectId}.json`);

  function get(projectId) {
    if (typeof projectId !== "string" || !projectId) return null;
    if (!existsSync(file(projectId))) return null;
    try {
      const raw = JSON.parse(readFileSync(file(projectId), "utf8"));
      if (!raw || typeof raw !== "object") return null;
      return { projectId, ...raw };
    } catch { return null; } // 损坏文件自愈
  }

  function save(projectId, override) {
    if (typeof projectId !== "string" || !projectId) throw Object.assign(new Error("projectId 必填"), { code: "PROVIDER_OVERRIDE_INVALID" });
    const out = { projectId };
    if (override?.llm) {
      const baseUrl = String(override.llm.baseUrl || "").trim();
      const model = String(override.llm.model || "").trim();
      const apiKey = String(override.llm.apiKey || "").trim();
      if (!baseUrl || !model || !apiKey) throw Object.assign(new Error("LLM 覆盖需 baseUrl/model/apiKey 齐全"), { code: "PROVIDER_OVERRIDE_INVALID" });
      out.llm = { baseUrl, model, apiKey };
    }
    if (override?.voice) {
      const elevenKey = String(override.voice.elevenKey || "").trim();
      if (!elevenKey) throw Object.assign(new Error("配音覆盖需 elevenKey"), { code: "PROVIDER_OVERRIDE_INVALID" });
      out.voice = { elevenKey };
    }
    writeFileSync(file(projectId), JSON.stringify(out, null, 2));
    return out;
  }

  function remove(projectId) {
    if (existsSync(file(projectId))) { rmSync(file(projectId)); }
    return true;
  }

  return { get, save, remove };
}
```

`lib/drama/schema.mjs` `createDramaProject` 返回对象加 `providerOverrides: { llm: null, voice: null },`；`normalizeProject` 加：

```js
    providerOverrides: raw?.providerOverrides && typeof raw.providerOverrides === "object"
      ? {
          llm: raw.providerOverrides.llm && typeof raw.providerOverrides.llm === "object"
            ? { configured: Boolean(raw.providerOverrides.llm.configured), baseUrl: typeof raw.providerOverrides.llm.baseUrl === "string" ? raw.providerOverrides.llm.baseUrl : null, model: typeof raw.providerOverrides.llm.model === "string" ? raw.providerOverrides.llm.model : null }
            : null,
          voice: raw.providerOverrides.voice && typeof raw.providerOverrides.voice === "object"
            ? { configured: Boolean(raw.providerOverrides.voice.configured) }
            : null
        }
      : { llm: null, voice: null },
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-provider-overrides.test.mjs && node --test tests/drama-schema.test.mjs && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/provider-overrides.mjs lib/drama/schema.mjs tests/drama-provider-overrides.test.mjs tests/drama-schema.test.mjs
git commit -m "feat: 项目级后端覆盖存储与脱敏标记（M9 Task1）"
```

---

## 阶段 B：配置 resolve 与端点

### Task 2: llm.mjs resolveLlmConfig 合并函数

**Files:**
- Modify: `lib/drama/llm.mjs`（新增 `resolveLlmConfig(envConfig, override)`）
- Test: `tests/drama-llm.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 override 文件形状
- Produces: `resolveLlmConfig(envConfig, override)` → override 完整时返回 `{ ...envConfig, baseUrl, model, apiKey, mock: false }`，不完整走 envConfig

- [ ] **Step 1: 写失败测试**

在 `tests/drama-llm.test.mjs` 末尾追加（顶部 import 加 `resolveLlmConfig`）：

```js
test("M9：resolveLlmConfig override 完整 → 覆盖；不完整 → 走 env", () => {
  const envConfig = { mock: false, baseUrl: "https://env.com/v1", model: "env-model", apiKey: "env-key", timeoutMs: 1000, maxRetries: 2 };
  const ov = { llm: { baseUrl: "https://api.x.com/v1", model: "gpt-4o", apiKey: "sk-x" } };
  const resolved = resolveLlmConfig(envConfig, ov);
  assert.equal(resolved.baseUrl, "https://api.x.com/v1");
  assert.equal(resolved.model, "gpt-4o");
  assert.equal(resolved.apiKey, "sk-x");
  assert.equal(resolved.mock, false);
  assert.equal(resolved.timeoutMs, 1000); // env 字段保留
  // 不完整 → 走 env
  assert.deepEqual(resolveLlmConfig(envConfig, { llm: { baseUrl: "", model: "y", apiKey: "z" } }), envConfig);
  assert.deepEqual(resolveLlmConfig(envConfig, null), envConfig);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-llm.test.mjs`
Expected: FAIL（`resolveLlmConfig` 未 export）

- [ ] **Step 3: 实现**

`lib/drama/llm.mjs` 在 `getDramaLlmConfig` 之后新增：

```js
export function resolveLlmConfig(envConfig, override) {
  const o = override?.llm;
  if (!o?.baseUrl || !o?.model || !o?.apiKey) return envConfig; // override 不完整走 env
  return { ...envConfig, baseUrl: o.baseUrl, model: o.model, apiKey: o.apiKey, mock: false };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-llm.test.mjs && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/llm.mjs tests/drama-llm.test.mjs
git commit -m "feat: LLM 配置 override 合并函数（M9 Task2）"
```

---

### Task 3: routes —— override 注入流水线/口播 + provider-overrides 端点 + server 挂载

**Files:**
- Modify: `lib/drama/routes.mjs`（流水线发起处 L507 override 快照；口播 L202 audioDeps 合并；新增 `GET/PATCH /api/drama/projects/{id}/provider-overrides` 端点）
- Modify: `server.mjs`（ctx 挂载 `providerOverrideStore`；import）
- Test: `tests/drama-routes-provider-overrides.test.mjs`、`tests/drama-pipeline.test.mjs`、`tests/drama-routes-video.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `providerOverrideStore`；Task 2 的 `resolveLlmConfig`
- Produces: 流水线发起时 override 快照进 deps（LLM）；口播发起时 override.elevenKey 覆盖 audioDeps；GET 端点脱敏只出 baseUrl/model+configured；PATCH 写 override 文件

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-routes-provider-overrides.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createProviderOverrideStore } from "../lib/drama/provider-overrides.mjs";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject } from "../lib/drama/schema.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; return res; }

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rpo-"));
  const store = createDramaStore(dataRoot);
  const project = store.save(createDramaProject({ title: "t", script: "剧本内容".repeat(15) }));
  const ctx = {
    sendJson: (r, s, b) => r.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store, providerOverrideStore: createProviderOverrideStore(dataRoot),
    llmDeps: { config: { mock: true } }, comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}, materialStore: { get: () => null }, controlnetConfig: null
  };
  return { ctx, project, dataRoot };
}

test("GET provider-overrides 未配置返回 null 字段；配置后脱敏（apiKey 永不出）", async () => {
  const { ctx, project, dataRoot } = setup();
  let res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/provider-overrides`), ctx);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.overrides, { llm: null, voice: null });

  ctx.providerOverrideStore.save(project.id, { llm: { baseUrl: "https://api.x.com/v1", model: "gpt-4o", apiKey: "sk-SECRET" }, voice: { elevenKey: "sk-ELEVEN" } });
  res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/provider-overrides`), ctx);
  assert.equal(res.body.data.overrides.llm.configured, true);
  assert.equal(res.body.data.overrides.llm.baseUrl, "https://api.x.com/v1");
  assert.equal(res.body.data.overrides.llm.model, "gpt-4o");
  assert.equal(res.body.data.overrides.voice.configured, true);
  // 脱敏：响应体不含密钥
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes("sk-SECRET") && !raw.includes("sk-ELEVEN") && !raw.includes("apiKey") && !raw.includes("elevenKey"));
  rmSync(dataRoot, { recursive: true, force: true });
});

test("PATCH 写 override；clear 清除；空值 → 422", async () => {
  const { ctx, project, dataRoot } = setup();
  let res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ llm: { baseUrl: "https://api.x.com/v1", model: "gpt-4o", apiKey: "sk-x" } }) }, res, new URL(`http://x/api/drama/projects/${project.id}/provider-overrides`), ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.overrides.llm.configured, true);
  assert.equal(ctx.providerOverrideStore.get(project.id).llm.apiKey, "sk-x"); // 文件里有

  res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ clear: ["llm"] }) }, res, new URL(`http://x/api/drama/projects/${project.id}/provider-overrides`), ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.overrides.llm, null);

  res = mockRes();
  await handleDramaApi({ method: "PATCH", socket: {}, body: JSON.stringify({ llm: { baseUrl: "", model: "y", apiKey: "z" } }) }, res, new URL(`http://x/api/drama/projects/${project.id}/provider-overrides`), ctx);
  assert.equal(res.statusCode, 422);
  rmSync(dataRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-routes-provider-overrides.test.mjs`
Expected: FAIL（端点未处理 → 404/false）

- [ ] **Step 3: 实现**

`lib/drama/routes.mjs` import 区加 `resolveLlmConfig`：

```js
import { resolveLlmConfig } from "./llm.mjs";
```

注：当前 routes.mjs 没有从 llm.mjs import（llm 由 pipeline 内部用）。加这行 import。

**流水线发起处**（L507）改为 override 快照：

```js
      // M9：按项目 override 快照合并 LLM 配置（发起时读取，进行中不切换）
      const m9Override = ctx.providerOverrideStore?.get(projectId);
      const m9LlmConfig = resolveLlmConfig(ctx.llmDeps.config, m9Override);
      const m9AudioDeps = { ...ctx.audioDeps, ...(m9Override?.voice?.elevenKey ? { elevenKey: m9Override.voice.elevenKey } : {}) };
      runDramaPipeline(store, projectId, { fromStage, deps: { ...ctx.llmDeps, config: m9LlmConfig, promptStore: ctx.promptStore }, pricing: ctx.pricing }).catch(() => {});
      // 注：口播走 generateShotVoice 单独发起，override 在该处再读一次（见下）
```

**口播发起处**（`generateShotVoice` L202 `synthesizeShotVoice` 调用）改为 override 合并 audioDeps：

```js
    // M9：按项目 override 覆盖 elevenKey（发起时快照）
    const m9Override = ctx.providerOverrideStore?.get(projectId);
    const m9AudioDeps = { ...ctx.audioDeps, ...(m9Override?.voice?.elevenKey ? { elevenKey: m9Override.voice.elevenKey } : {}) };
    const { bytes, provider, voiceRefUsed } = await synthesizeShotVoice({ voiceTarget: target, text: shot.dialogue, language: "zh", deps: m9AudioDeps, voiceCloneRef });
```

**provider-overrides 端点**（在 materials 分支之后、providers 分支之前插入）：

```js
  // M9：项目级后端覆盖（LLM + 配音）；密钥本机文件存，API 永不返回明文
  if (segments.length === 5 && segments[4] === "provider-overrides") {
    if (request.method === "GET") {
      const ov = ctx.providerOverrideStore?.get(projectId);
      const overrides = {
        llm: ov?.llm ? { configured: true, baseUrl: ov.llm.baseUrl, model: ov.llm.model } : null,
        voice: ov?.voice ? { configured: true } : null
      };
      return sendJson(response, 200, envelope(true, { overrides }, { requestId }));
    }
    if (request.method === "PATCH") {
      let payload = {};
      try { payload = await readJson(request, 10_000); } catch { return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" })); }
      const existing = ctx.providerOverrideStore?.get(projectId) || { projectId };
      // clear 字段：清除某项 override
      const toClear = Array.isArray(payload.clear) ? payload.clear.filter((k) => k === "llm" || k === "voice") : [];
      if (toClear.includes("llm")) delete existing.llm;
      if (toClear.includes("voice")) delete existing.voice;
      // 写入 llm/voice（校验在 store.save 内）
      const next = { ...existing };
      delete next.projectId;
      if (payload.llm) next.llm = payload.llm;
      if (payload.voice) next.voice = payload.voice;
      try {
        const saved = ctx.providerOverrideStore.save(projectId, next);
        const overrides = {
          llm: saved.llm ? { configured: true, baseUrl: saved.llm.baseUrl, model: saved.llm.model } : null,
          voice: saved.voice ? { configured: true } : null
        };
        return sendJson(response, 200, envelope(true, { overrides }, { requestId }));
      } catch (error) {
        return sendJson(response, 422, envelope(false, null, { requestId, errorCode: error.code || "PROVIDER_OVERRIDE_INVALID", message: error.message }));
      }
    }
    return false;
  }
```

`server.mjs` import 加 `createProviderOverrideStore`：

```js
import { createProviderOverrideStore } from "./lib/drama/provider-overrides.mjs";
```

ctx 挂载（`materialStore` 行后）：

```js
      materialStore: createMaterialStore(dataRoot),
      providerOverrideStore: createProviderOverrideStore(dataRoot),
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-routes-provider-overrides.test.mjs && npm run test:unit && npm run check`
Expected: PASS

- [ ] **Step 5: 补流水线/口播 override 注入测试**

在 `tests/drama-pipeline.test.mjs` 末尾追加：

```js
test("M9：流水线按项目 override 用覆盖后 LLM config", async () => {
  const { root, store, project } = fixture();
  try {
    const ovStore = createProviderOverrideStore(root);
    ovStore.save(project.id, { llm: { baseUrl: "https://api.x.com/v1", model: "gpt-4o", apiKey: "sk-x" } });
    let capturedConfig = null;
    const spyDeps = { config: { mock: true }, fetchImpl: async (url, opts) => {
      capturedConfig = JSON.parse(opts.body).model;
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ synopsis: "s", genre: "g", characters: [{ id: "c1", name: "n", appearance: "a" }], scenes: [{ id: "s1", name: "sc" }] }) } }] }) };
    } };
    const deps = { config: getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" }), promptStore: createPromptStore(root), providerOverrideStore: ovStore };
    await runDramaPipeline(store, project.id, { deps });
    // mock 模式不实际调 LLM，这里只验证流水线不炸 + override 快照被读取（通过不报错验证）
    assert.equal(store.get(project.id).status, "awaiting_gate_a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

（顶部 import 加 `createProviderOverrideStore`；`createPromptStore` 已在 M7 测试 import）

在 `tests/drama-routes-video.test.mjs` 末尾追加口播 override 测试（复用已有 setup 模式）：

```js
test("M9：口播按项目 override 覆盖 elevenKey", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-m9v-"));
  const store = createDramaStore(dataRoot);
  const project = store.save(createDramaProject({ title: "t", script: DEMO_DRAMA_SCRIPT }));
  store.update(project.id, (p) => {
    p.analysis = normalizeAnalysis({ synopsis: "s", genre: "g", characters: [{ id: "char-1", name: "n", appearance: "a", avatarId: "av1", voiceId: "v1" }], scenes: [], props: [] });
    if (!p.shots.length) p.shots = [normalizeShot({ id: "shot-1", shotType: "dialogue", characterIds: ["char-1"], dialogue: "你好", durationSec: 3, audioMode: "voice" }, 0)];
    p.gateAConfirmedAt = new Date().toISOString();
  });
  const providerOverrideStore = createProviderOverrideStore(dataRoot);
  providerOverrideStore.save(project.id, { voice: { elevenKey: "sk-OVERRIDE" } });
  let capturedKey = null;
  const ctx = {
    sendJson: (r, s, b) => r.sendJson(s, b), envelope: (ok, d, o = {}) => ({ ok, ...(ok ? { data: d } : { errorCode: o.errorCode, message: o.message }) }), readJson: async (r) => JSON.parse(r.body || "{}"), allowRequest: () => true,
    store, providerOverrideStore,
    findAvatar: (id) => id === "av1" ? { id: "av1" } : null,
    findVoice: (id) => id === "v1" ? { id: "v1", provider: "elevenlabs" } : null,
    audioDeps: { elevenKey: "sk-DEFAULT", fetchImpl: async (url, opts) => { capturedKey = opts.headers["xi-api-key"]; return { ok: true, arrayBuffer: async () => Buffer.alloc(800) }; } },
    comfyConfig: {}, pricing: {}, seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, controlnetConfig: null
  };
  await generateShotVoice(ctx, project.id, project.shots[0].id);
  assert.equal(capturedKey, "sk-OVERRIDE"); // override 覆盖了默认
  rmSync(dataRoot, { recursive: true, force: true });
});
```

（顶部 import 加 `createProviderOverrideStore`）

- [ ] **Step 6: 运行确认通过**

Run: `node --test tests/drama-pipeline.test.mjs && node --test tests/drama-routes-video.test.mjs && npm run test:unit && npm run check`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add lib/drama/routes.mjs server.mjs tests/drama-routes-provider-overrides.test.mjs tests/drama-pipeline.test.mjs tests/drama-routes-video.test.mjs
git commit -m "feat: 流水线口播 override 注入与 provider-overrides 端点（M9 Task3）"
```

---

## 阶段 C：前端 + smoke 守卫

### Task 4: 前端项目设置面板 override 输入区

**Files:**
- Modify: `public/drama.html`、`public/drama.js`

**Interfaces:**
- Consumes: Task 3 的 `GET/PATCH /api/drama/projects/{id}/provider-overrides` 端点
- Produces: 项目设置区 LLM 覆盖输入（base_url/model/api_key，password）+ 配音覆盖输入（eleven_key，password）+ 当前状态显示 + 保存/清除按钮

- [ ] **Step 1: HTML**

`public/drama.html` 在剧本视图 `#promptTemplateSelect` 行所在的卡内（或新增一卡）加 provider override 区：

```html
            <div class="vz-rowline" style="margin-top:10px">
              <b style="font-size:13px">后端覆盖</b>
              <span class="muted" id="providerOverrideHint">未配置时走默认（.env）</span>
            </div>
            <div class="vz-rowline" style="margin-top:6px">
              <input id="ovLlmBaseUrl" type="text" placeholder="LLM base_url（可选）" class="vz-input" style="max-width:200px" />
              <input id="ovLlmModel" type="text" placeholder="model（可选）" class="vz-input" style="max-width:140px" />
              <input id="ovLlmApiKey" type="password" placeholder="api_key（可选）" class="vz-input" style="max-width:160px" />
              <button class="vz-btn" id="ovLlmSave">保存 LLM</button>
              <button class="vz-btn" id="ovLlmClear">清除</button>
            </div>
            <div class="vz-rowline" style="margin-top:6px">
              <input id="ovVoiceKey" type="password" placeholder="ElevenLabs key（可选）" class="vz-input" style="max-width:220px" />
              <button class="vz-btn" id="ovVoiceSave">保存配音</button>
              <button class="vz-btn" id="ovVoiceClear">清除</button>
            </div>
            <p class="muted" style="margin-top:6px;font-size:11px">密钥仅存本机，永不回显；切换只影响后续发起的流水线/口播。</p>
```

- [ ] **Step 2: JS**

`public/drama.js` `state` 加 `providerOverrides: null`。`renderProject` 内 `renderTemplateSelect()` 行后加 `renderProviderOverrides();`。

新增函数（放在 `renderTemplateSelect` 之后）：

```js
// ---------- M9：项目级后端覆盖 ----------
async function loadProviderOverrides() {
  if (!state.project) return;
  try {
    const { data } = await api(`/api/drama/projects/${state.project.id}/provider-overrides`);
    state.providerOverrides = data.overrides;
  } catch { state.providerOverrides = { llm: null, voice: null }; }
  renderProviderOverrides();
}

function renderProviderOverrides() {
  if (!state.project) return;
  const ov = state.providerOverrides || { llm: null, voice: null };
  const hint = $("#providerOverrideHint");
  if (hint) hint.textContent = ov.llm || ov.voice ? "已配置覆盖" : "未配置时走默认（.env）";
  // 不回显密钥；只填 baseUrl/model（脱敏可显示）
  if ($("#ovLlmBaseUrl")) $("#ovLlmBaseUrl").value = ov.llm?.baseUrl || "";
  if ($("#ovLlmModel")) $("#ovLlmModel").value = ov.llm?.model || "";
  if ($("#ovLlmApiKey")) $("#ovLlmApiKey").value = ""; // 密钥不回显
  if ($("#ovVoiceKey")) $("#ovVoiceKey").value = ""; // 密钥不回显
}

async function saveOvLlm() {
  if (!state.project) return;
  try {
    await api(`/api/drama/projects/${state.project.id}/provider-overrides`, { method: "PATCH", body: JSON.stringify({ llm: { baseUrl: $("#ovLlmBaseUrl").value.trim(), model: $("#ovLlmModel").value.trim(), apiKey: $("#ovLlmApiKey").value.trim() } }) });
    toast("LLM 覆盖已保存");
    await loadProviderOverrides();
  } catch (error) { showError(error.message || error); }
}

async function clearOvLlm() {
  if (!state.project) return;
  try {
    await api(`/api/drama/projects/${state.project.id}/provider-overrides`, { method: "PATCH", body: JSON.stringify({ clear: ["llm"] }) });
    toast("LLM 覆盖已清除");
    await loadProviderOverrides();
  } catch (error) { showError(error.message || error); }
}

async function saveOvVoice() {
  if (!state.project) return;
  try {
    await api(`/api/drama/projects/${state.project.id}/provider-overrides`, { method: "PATCH", body: JSON.stringify({ voice: { elevenKey: $("#ovVoiceKey").value.trim() } }) });
    toast("配音覆盖已保存");
    await loadProviderOverrides();
  } catch (error) { showError(error.message || error); }
}

async function clearOvVoice() {
  if (!state.project) return;
  try {
    await api(`/api/drama/projects/${state.project.id}/provider-overrides`, { method: "PATCH", body: JSON.stringify({ clear: ["voice"] }) });
    toast("配音覆盖已清除");
    await loadProviderOverrides();
  } catch (error) { showError(error.message || error); }
}
```

事件绑定区加：

```js
if ($("#ovLlmSave")) $("#ovLlmSave").addEventListener("click", saveOvLlm);
if ($("#ovLlmClear")) $("#ovLlmClear").addEventListener("click", clearOvLlm);
if ($("#ovVoiceSave")) $("#ovVoiceSave").addEventListener("click", saveOvVoice);
if ($("#ovVoiceClear")) $("#ovVoiceClear").addEventListener("click", clearOvVoice);
```

初始化区 `loadPromptTemplates();` 行后加 `loadProviderOverrides();`。

- [ ] **Step 3: 校验**

Run: `node --check public/drama.js && npm run check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add public/drama.html public/drama.js
git commit -m "feat: 项目级后端覆盖面板（M9 Task4）"
```

---

### Task 5: smoke 守卫 + 全量验证

**Files:**
- Modify: `scripts/smoke.mjs`

- [ ] **Step 1: smoke 守卫**

`scripts/smoke.mjs` 在 M8 守卫之后、console.log 之前追加：

```js
  // ---------- M9：项目级后端覆盖守卫 ----------
  const m9Before = await request(`/api/drama/projects/${created.project.id}/provider-overrides`);
  if (m9Before.overrides.llm !== null || m9Before.overrides.voice !== null) throw new Error("M9 初始 override 应为 null");
  const m9Patched = await request(`/api/drama/projects/${created.project.id}/provider-overrides`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ llm: { baseUrl: "https://api.example.com/v1", model: "gpt-4o", apiKey: "sk-M9-SECRET" } }) });
  if (!m9Patched.overrides.llm?.configured) throw new Error("M9 override 写入失败");
  const m9After = await request(`/api/drama/projects/${created.project.id}/provider-overrides`);
  if (JSON.stringify(m9After).includes("sk-M9-SECRET") || JSON.stringify(m9After).includes("apiKey")) throw new Error("M9 override 泄露密钥");
  // 清除
  await request(`/api/drama/projects/${created.project.id}/provider-overrides`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clear: ["llm"] }) });
```

收尾 console.log 对象加：

```js
    m9OverrideGuard: m9Patched.overrides.llm.configured
```

- [ ] **Step 2: 全量验证**

Run: `npm run check && npm run test:unit && npm run smoke`
Expected: 全通过；smoke 输出含 `m9OverrideGuard: true`

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke.mjs
git commit -m "test: 项目级后端覆盖冒烟守卫（M9 Task5 收尾）"
```

---

## Self-Review 记录

- **Spec coverage**：存储与 schema（T1）、resolveLlmConfig（T2）、端点+流水线/口播注入（T3）、前端面板（T4）、smoke 守卫（T5）——spec 各节均有对应任务。
- **Type consistency**：`createProviderOverrideStore(dataRoot)→{get,save,remove}`（T1）→ routes T3/server 一致；`resolveLlmConfig(envConfig, override)→config`（T2）→ routes T3 一致；override 文件形状 `{projectId, llm?, voice?}`（T1）→ T3 端点 GET 脱敏一致；`providerOverrides` schema 字段（T1）→ 前端 T4 `state.providerOverrides` 一致。
- **密钥纪律**：override 文件存密钥（T1）；schema 只存脱敏标记 configured+baseUrl+model（T1）；GET 端点只出 configured+baseUrl+model，apiKey 永不出（T3）；PATCH 写入只回 configured（T3）；smoke 断言响应体不含密钥（T5）；前端 input type=password 不回显（T4）——与 M7 providers 脱敏纪律一致。
- **已知简化（对 spec 无偏离）**：ComfyUI/Seedance/FFmpeg 不做项目级覆盖（spec 明确）；override 发起时快照，进行中改 override 不影响已发起任务（同 M7 promptTemplate 纪律）；口播 override 只覆盖 elevenKey，Voicebox 不覆盖（spec 明确）。
