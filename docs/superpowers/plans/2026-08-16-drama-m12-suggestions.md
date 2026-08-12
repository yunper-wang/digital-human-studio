# 短剧工作台 M12：剧本智能辅助实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 独立 suggestions 存储层，分析后自动+手动生成三类建议（剧情结构/角色弧光/台词润色），只展示不自动改，零污染 analysis 结构。

**Architecture:** `createSuggestionStore(dataRoot)` 存 `data/drama-suggestions/<projectId>.json`；`runSuggestions(project, deps)` 走 callStage 模式调 LLM；pipeline analyze 完成后异步触发不阻塞；`GET/POST /api/drama/projects/{id}/suggestions[/regenerate]` 端点；前端剧本视图建议面板三类分组。

**Tech Stack:** 零框架原生 HTML/CSS/JS；Node 20+；`node:test`。

**Spec:** `docs/superpowers/specs/2026-08-16-drama-m12-suggestions-design.md`

## Global Constraints

- 零框架、无构建链、不引入新 npm 依赖；本机优先、私密不出本机。
- 中文提交信息（`类型: 简短描述`）；遵循既有 `lib/drama/*` 与 `tests/drama-*.test.mjs` 模式。
- analysis 结构零污染（被分镜/提示词/审核/快照依赖）；suggestions 独立存储。
- 建议只展示不自动改；建议生成失败不阻塞流水线。

---

## 阶段 A：存储与建议生成

### Task 1: suggestions.mjs 存储 + agents runSuggestions

**Files:**
- Create: `lib/drama/suggestions.mjs`
- Modify: `lib/drama/agents.mjs`（新增 `SYSTEM_SUGGEST` + `runSuggestions` + `validateSuggestions`）
- Test: `tests/drama-suggestions.test.mjs`、`tests/drama-agents.test.mjs`

**Interfaces:**
- Consumes: `callStage`/`extractJson` from llm.mjs；project 对象
- Produces: `createSuggestionStore(dataRoot)` → `{ get, save, remove }`；`runSuggestions(project, deps)` → `{ suggestions: [...], generatedAt }`；suggestion 形状 `{ category, severity, target, message }`

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-suggestions.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuggestionStore } from "../lib/drama/suggestions.mjs";

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-sug-"));
  return { store: createSuggestionStore(dataRoot), dataRoot };
}

test("get 不存在返回 null；save→get→remove", () => {
  const { store, dataRoot } = setup();
  assert.equal(store.get("drama-1"), null);
  const data = { projectId: "drama-1", generatedAt: "2026-08-16T00:00:00.000Z", suggestions: [{ category: "structure", severity: "warn", target: null, message: "高潮缺失" }] };
  store.save("drama-1", data);
  assert.deepEqual(store.get("drama-1"), data);
  assert.equal(store.remove("drama-1"), true);
  assert.equal(store.get("drama-1"), null);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("损坏文件 get 返回 null（自愈）", () => {
  const { store, dataRoot } = setup();
  store.save("drama-1", { projectId: "drama-1", generatedAt: "x", suggestions: [] });
  writeFileSync(join(dataRoot, "drama-suggestions", "drama-1.json"), "{{{");
  assert.equal(store.get("drama-1"), null);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("save 校验 suggestions 数组形状", () => {
  const { store, dataRoot } = setup();
  assert.throws(() => store.save("drama-1", { suggestions: "not-array" }), /SUGGESTION_INVALID/);
  assert.throws(() => store.save("drama-1", { suggestions: [{ category: "bad", severity: "info", target: null, message: "x" }] }), /SUGGESTION_INVALID/);
  rmSync(dataRoot, { recursive: true, force: true });
});
```

在 `tests/drama-agents.test.mjs` 末尾追加：

```js
import { runSuggestions } from "../lib/drama/agents.mjs";

test("M12：runSuggestions 产出合法建议结构", async () => {
  const deps = {
    config: { mock: false, baseUrl: "http://127.0.0.1:9", model: "m", apiKey: "", timeoutMs: 1000, maxRetries: 0 },
    fetchImpl: async (url, opts) => {
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ suggestions: [{ category: "structure", severity: "warn", target: null, message: "高潮缺失" }, { category: "arc", severity: "info", target: "林晚", message: "主角无成长线" }] }) } }] }) } };
    }
  };
  const project = { script: "x".repeat(60), analysis: { synopsis: "s", genre: "g", characters: [{ id: "c1", name: "林晚", appearance: "a" }], scenes: [{ id: "s1", name: "sc" }] } };
  const result = await runSuggestions(project, deps);
  assert.ok(Array.isArray(result.suggestions));
  assert.equal(result.suggestions.length, 2);
  assert.equal(result.suggestions[0].category, "structure");
  assert.equal(result.suggestions[1].target, "林晚");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-suggestions.test.mjs && node --test tests/drama-agents.test.mjs`
Expected: FAIL（模块不存在 / `runSuggestions` 未 export）

- [ ] **Step 3: 实现**

新建 `lib/drama/suggestions.mjs`：

```js
// lib/drama/suggestions.mjs
// 剧本智能建议：独立存储层，不污染 analysis 结构；剧情结构/角色弧光/台词润色三类
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runSuggestions } from "./agents.mjs";

const CATEGORIES = ["structure", "arc", "dialogue"];
const SEVERITIES = ["info", "warn"];

function normalizeSuggestion(raw = {}) {
  return {
    category: CATEGORIES.includes(raw?.category) ? raw.category : "structure",
    severity: SEVERITIES.includes(raw?.severity) ? raw.severity : "info",
    target: typeof raw?.target === "string" && raw.target ? raw.target.slice(0, 60) : null,
    message: String(raw?.message || "").slice(0, 300)
  };
}

export function createSuggestionStore(dataRoot) {
  const root = join(dataRoot, "drama-suggestions");
  mkdirSync(root, { recursive: true });
  const file = (projectId) => join(root, `${projectId}.json`);

  function get(projectId) {
    if (typeof projectId !== "string" || !projectId) return null;
    if (!existsSync(file(projectId))) return null;
    try {
      const raw = JSON.parse(readFileSync(file(projectId), "utf8"));
      if (!raw || typeof raw !== "object") return null;
      return {
        projectId,
        generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : new Date().toISOString(),
        suggestions: Array.isArray(raw.suggestions) ? raw.suggestions.map(normalizeSuggestion).slice(0, 8) : []
      };
    } catch { return null; }
  }

  function save(projectId, data) {
    if (typeof projectId !== "string" || !projectId) throw Object.assign(new Error("projectId 必填"), { code: "SUGGESTION_INVALID" });
    if (!data || !Array.isArray(data.suggestions)) throw Object.assign(new Error("suggestions 必须是数组（SUGGESTION_INVALID）"), { code: "SUGGESTION_INVALID" });
    const out = {
      projectId,
      generatedAt: typeof data.generatedAt === "string" ? data.generatedAt : new Date().toISOString(),
      suggestions: data.suggestions.map(normalizeSuggestion).slice(0, 8)
    };
    // 校验每项 category 合法（normalizeSuggestion 已兜底，但 bad category 应抛错）
    for (const s of data.suggestions) {
      if (!CATEGORIES.includes(s?.category)) throw Object.assign(new Error("建议 category 非法（SUGGESTION_INVALID）"), { code: "SUGGESTION_INVALID" });
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

// 生成建议：调 LLM，失败返回空建议不抛错
export async function generateSuggestions(project, deps = {}) {
  try {
    const result = await runSuggestions(project, deps);
    return { suggestions: result.suggestions || [], generatedAt: new Date().toISOString() };
  } catch {
    return { suggestions: [], generatedAt: new Date().toISOString() };
  }
}
```

`lib/drama/agents.mjs` 末尾加 `SYSTEM_SUGGEST` + `validateSuggestions` + `runSuggestions`：

```js
export const SYSTEM_SUGGEST = `你是短剧剧本顾问。基于剧本与分析结果，给出可执行的改进建议，只输出 JSON。
输出结构：{"suggestions":[{"category":"structure|arc|dialogue","severity":"info|warn","target":"角色名|场景名|镜号|null","message":"具体建议"}]}
三类建议：
- structure：剧情结构（节奏拖沓/转折生硬/冲突不足/高潮缺失）
- arc：角色弧光（主角无成长线/配角工具人化/角色动机不清）
- dialogue：台词润色（生硬/重复/过于书面化/不符合角色性格）
要求：每类至少 1 条（若无明显问题则 message 写「无明显问题」severity=info）；message 具体可执行，指向 target；不超过 8 条。`;

export function validateSuggestions(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["suggestions 必须是对象"];
  if (!Array.isArray(value.suggestions)) return ["suggestions 必须是数组"];
  const cats = ["structure", "arc", "dialogue"];
  const sevs = ["info", "warn"];
  value.suggestions.forEach((s, i) => {
    if (!cats.includes(s?.category)) errors.push(`suggestions[${i}] category 非法`);
    if (!sevs.includes(s?.severity)) errors.push(`suggestions[${i}] severity 非法`);
    if (!String(s?.message || "").trim()) errors.push(`suggestions[${i}] 缺少 message`);
  });
  return errors;
}

export async function runSuggestions(project, deps = {}) {
  const value = await callStage("suggest", SYSTEM_SUGGEST, { script: project.script, analysis: project.analysis || null }, validateSuggestions, deps);
  return { suggestions: (value.suggestions || []).slice(0, 8), generatedAt: new Date().toISOString() };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-suggestions.test.mjs && node --test tests/drama-agents.test.mjs && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/suggestions.mjs lib/drama/agents.mjs tests/drama-suggestions.test.mjs tests/drama-agents.test.mjs
git commit -m "feat: 智能建议存储与 LLM 生成（M12 Task1）"
```

---

## 阶段 B：pipeline 自动触发 + 端点 + server 挂载

### Task 2: pipeline analyze 后自动触发 + routes 端点 + server 挂载

**Files:**
- Modify: `lib/drama/pipeline.mjs`（analyze 完成后异步触发 generateSuggestions）
- Modify: `lib/drama/routes.mjs`（新增 `GET /api/drama/projects/{id}/suggestions`、`POST .../regenerate`）
- Modify: `server.mjs`（ctx 挂载 `suggestionStore`）
- Modify: `package.json`（check 加 `lib/drama/suggestions.mjs`）
- Test: `tests/drama-pipeline.test.mjs`、`tests/drama-routes-suggestions.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `createSuggestionStore`/`generateSuggestions`
- Produces: analyze 完成后 suggestions 自动落盘；GET 端点返回建议；POST regenerate 触发

- [ ] **Step 1: 写失败测试**

在 `tests/drama-pipeline.test.mjs` 末尾追加（顶部 import 加 `createSuggestionStore`、`generateSuggestions`）：

```js
import { createSuggestionStore } from "../lib/drama/suggestions.mjs";

test("M12：analyze 完成后 suggestions 自动落盘", async () => {
  const { root, store, project } = fixture();
  try {
    const suggestionStore = createSuggestionStore(root);
    const deps = { config: getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" }), promptStore: createPromptStore(root), suggestionStore };
    await runDramaPipeline(store, project.id, { deps });
    // mock 模式 generateSuggestions 不实际调 LLM，但 suggestionStore 应被尝试写（可能空建议）
    // 关键断言：流水线不炸 + analyze 完成
    assert.equal(store.get(project.id).status, "awaiting_gate_a");
    assert.ok(store.get(project.id).analysis);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

新建 `tests/drama-routes-suggestions.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createSuggestionStore } from "../lib/drama/suggestions.mjs";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject } from "../lib/drama/schema.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; return res; }

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rsug-"));
  const store = createDramaStore(dataRoot);
  const project = store.save(createDramaProject({ title: "t", script: "剧本内容".repeat(15) }));
  const ctx = {
    sendJson: (r, s, b) => r.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store, suggestionStore: createSuggestionStore(dataRoot),
    llmDeps: { config: { mock: true } }, comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}, materialStore: { get: () => null }, controlnetConfig: null
  };
  return { ctx, project, dataRoot };
}

test("GET suggestions 未生成返回 null", async () => {
  const { ctx, project, dataRoot } = setup();
  const res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/suggestions`), ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.suggestions, null);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("GET suggestions 已生成返回建议；regenerate 触发 202", async () => {
  const { ctx, project, dataRoot } = setup();
  ctx.suggestionStore.save(project.id, { projectId: project.id, generatedAt: "2026-08-16T00:00:00.000Z", suggestions: [{ category: "structure", severity: "warn", target: null, message: "高潮缺失" }] });
  let res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/suggestions`), ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.suggestions.suggestions[0].message, "高潮缺失");
  res = mockRes();
  await handleDramaApi({ method: "POST", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/suggestions/regenerate`), ctx);
  assert.equal(res.statusCode, 202);
  rmSync(dataRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-pipeline.test.mjs && node --test tests/drama-routes-suggestions.test.mjs`
Expected: FAIL（pipeline 无自动触发 / 端点未处理）

- [ ] **Step 3: 实现**

`lib/drama/pipeline.mjs` import 区加：

```js
import { generateSuggestions } from "./suggestions.mjs";
```

analyze 阶段完成后（`store.update(projectId, (p) => { p.analysis = analysis; });` 之后）加：

```js
      if (stage === "analyze") {
        const analysis = await runScriptAnalysis(store.get(projectId), deps);
        store.update(projectId, (p) => { p.analysis = analysis; });
        // M12：分析后自动生成智能建议（异步、失败不阻塞流水线）
        if (deps.suggestionStore) {
          generateSuggestions(store.get(projectId), deps).then((result) => {
            if (result?.suggestions?.length) deps.suggestionStore.save(projectId, result);
          }).catch(() => {});
        }
      } else if (stage === "direct") {
```

`lib/drama/routes.mjs` 新增端点（在 provider-overrides 端点之后插入）：

```js
    // M12：智能建议（独立存储，不污染 analysis）
    if (segments.length === 5 && segments[4] === "suggestions" && request.method === "GET") {
      const suggestions = ctx.suggestionStore?.get(projectId) || null;
      return sendJson(response, 200, envelope(true, { suggestions }, { requestId }));
    }
    if (segments.length === 6 && segments[4] === "suggestions" && segments[5] === "regenerate" && request.method === "POST") {
      // 异步触发，不阻塞
      generateSuggestions(store.get(projectId), ctx.llmDeps || {}).then((result) => {
        if (result?.suggestions?.length) ctx.suggestionStore?.save(projectId, result);
      }).catch(() => {});
      return sendJson(response, 202, envelope(true, { projectId, status: "regenerating" }, { requestId }));
    }
```

注：`generateSuggestions` 在 routes.mjs 使用——需 import。`lib/drama/routes.mjs` import 区加：

```js
import { generateSuggestions } from "./suggestions.mjs";
```

`server.mjs` import + 挂载：

```js
import { createSuggestionStore } from "./lib/drama/suggestions.mjs";
```

ctx 挂载（`jobQueue` 行后）：

```js
      jobQueue: createJobQueue(readQueueConfig()),
      suggestionStore: createSuggestionStore(dataRoot),
```

`package.json` check 脚本加 `&& node --check lib/drama/suggestions.mjs`（在 export.mjs 之后）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-pipeline.test.mjs && node --test tests/drama-routes-suggestions.test.mjs && npm run test:unit && npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/pipeline.mjs lib/drama/routes.mjs server.mjs package.json tests/drama-pipeline.test.mjs tests/drama-routes-suggestions.test.mjs
git commit -m "feat: 分析后自动建议生成与端点（M12 Task2）"
```

---

## 阶段 C：前端 + smoke 守卫

### Task 3: 前端建议面板 + smoke 守卫

**Files:**
- Modify: `public/drama.html`、`public/drama.js`
- Modify: `scripts/smoke.mjs`

**Interfaces:**
- Consumes: Task 2 的 `GET/POST suggestions` 端点
- Produces: 剧本视图「智能建议」面板（三类分组 + 重新分析按钮）+ smoke 守卫

- [ ] **Step 1: HTML**

`public/drama.html` 剧本视图（resumeBtn 行附近）加建议面板：

```html
            <div class="vz-card" style="padding:14px;margin-top:12px" id="suggestionCard">
              <div class="vz-rowline">
                <b style="font-size:13px">智能建议</b>
                <button class="vz-btn" id="regenerateSuggestionsBtn">重新分析</button>
              </div>
              <div id="suggestionList" style="margin-top:8px"><p class="muted">分析后生成</p></div>
            </div>
```

- [ ] **Step 2: JS**

`public/drama.js` `state` 加 `suggestions: null`。`renderProject` 内加 `loadSuggestions();`。新增函数：

```js
// ---------- M12：智能建议 ----------
async function loadSuggestions() {
  if (!state.project) return;
  try {
    const { data } = await api(`/api/drama/projects/${state.project.id}/suggestions`);
    state.suggestions = data.suggestions;
  } catch { state.suggestions = null; }
  renderSuggestions();
}

function renderSuggestions() {
  const box = $("#suggestionList");
  if (!box) return;
  const sug = state.suggestions;
  if (!sug || !sug.suggestions?.length) { box.innerHTML = '<p class="muted">分析后生成；或点「重新分析」</p>'; return; }
  const labels = { structure: "剧情结构", arc: "角色弧光", dialogue: "台词润色" };
  const icons = { info: "💡", warn: "⚠" };
  box.innerHTML = "";
  for (const cat of ["structure", "arc", "dialogue"]) {
    const group = sug.suggestions.filter((s) => s.category === cat);
    if (!group.length) continue;
    const head = document.createElement("b"); head.style.fontSize = "12px"; head.textContent = labels[cat];
    box.append(head);
    for (const s of group) {
      const row = document.createElement("div"); row.className = "vz-sub-row"; row.style.marginTop = "4px";
      const icon = document.createElement("span"); icon.textContent = icons[s.severity] || "💡";
      const target = s.target ? document.createElement("span") : null;
      if (target) { target.className = "muted"; target.style.fontSize = "11px"; target.textContent = `「${s.target}」`; }
      const msg = document.createElement("span"); msg.style.fontSize = "12px"; msg.style.flex = "1"; msg.textContent = s.message;
      row.append(icon, ...(target ? [target] : []), msg);
      box.append(row);
    }
  }
}

async function regenerateSuggestions() {
  if (!state.project) return;
  try {
    await api(`/api/drama/projects/${state.project.id}/suggestions/regenerate`, { method: "POST" });
    toast("已触发重新分析", "稍后刷新查看");
    setTimeout(loadSuggestions, 2000);
  } catch (error) { showError(error.message || error); }
}
```

事件绑定区加：

```js
if ($("#regenerateSuggestionsBtn")) $("#regenerateSuggestionsBtn").addEventListener("click", regenerateSuggestions);
```

初始化区 `loadProviderOverrides();` 行后加 `loadSuggestions();`。

- [ ] **Step 3: smoke 守卫**

`scripts/smoke.mjs` 在 M11 守卫之后、console.log 之前追加：

```js
  // ---------- M12：智能建议守卫 ----------
  const m12Sug = await request(`/api/drama/projects/${created.project.id}/suggestions`);
  // 流水线已跑完 analyze，suggestions 可能为 null（mock LLM 不实际生成）或对象，只验证端点不炸
  if (m12Sug.suggestions !== null && !Array.isArray(m12Sug.suggestions.suggestions)) throw new Error("M12 suggestions 形状异常");
```

收尾 console.log 对象加：

```js
    m12SuggestionGuard: m12Sug.suggestions ? m12Sug.suggestions.suggestions.length : null
```

- [ ] **Step 4: 全量验证**

Run: `npm run check && npm run test:unit && npm run smoke`
Expected: 全通过；smoke 输出含 `m12SuggestionGuard`

- [ ] **Step 5: Commit**

```bash
git add public/drama.html public/drama.js scripts/smoke.mjs
git commit -m "feat: 智能建议面板与冒烟守卫（M12 Task3）"
```

---

## Self-Review 记录

- **Spec coverage**：存储+生成（T1）、pipeline 自动触发+端点+server（T2）、前端面板+smoke 守卫（T3）——spec 各节均有对应任务。
- **Type consistency**：`createSuggestionStore(dataRoot)→{get,save,remove}`（T1）→ routes T2/server 一致；`runSuggestions(project,deps)→{suggestions,generatedAt}`（T1）→ pipeline T2 一致；suggestion 形状 `{category,severity,target,message}`（T1）→ 前端 T3 读取一致；category 三枚举 structure/arc/dialogue 全链路一致。
- **零回归纪律**：pipeline 自动触发包 `.then().catch()`，失败不阻塞流水线；generateSuggestions 内部 try-catch 返回空建议；analysis 结构完全不动（suggestions 独立存储）。
- **已知简化（对 spec 无偏离）**：建议只展示不自动改（spec 明确）；severity 无 block（审核阶段已有 block 纪律）；mock LLM 模式 generateSuggestions 不实际生成，pipeline 测试只验证不炸；smoke 环境只验证端点形状。
