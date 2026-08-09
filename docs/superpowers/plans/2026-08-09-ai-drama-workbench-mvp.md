# AI 短剧工作台 MVP（M1 文本管线 + M2 首帧管线）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 digital-human-studio 底座上新增"短剧工作台"模块：剧本 → 四阶段 Agent 流水线（剧本分析→导演分镜→提示词→文本审核）→ 分镜表 → 剧集级预算闸门（闸门 A）→ ComfyUI/Flux 批量首帧 → 首帧确认闸门（闸门 B）。

**Architecture:** 纯 Node.js 原生流水线（无 Agent 框架、无新 npm 依赖）。四个 Agent 实现为"结构化提示词 + JSON 校验 + 有限重试"的确定性阶段函数；LLM 走 OpenAI 兼容端点，未配置时自动落入确定性 mock（演示编排模式），保证 `npm test` 零费用。ComfyUI 通过 HTTP API 接入，Flux 工作流 JSON 由代码模板生成。全部状态落在 `data/drama-projects/{id}/`，复用现有任务轮询、费用闸门（409 COST_CONFIRMATION_REQUIRED）、隐私边界模式。

**Tech Stack:** Node.js 20+（ESM,.mjs）、内置 `node:test`（测试）、原生 `fetch`、现有 `server.mjs`（裸 node:http）、现有 `public/` 无框架前端。

## Global Constraints

- **零新 npm 依赖** — 只用 Node 20 标准库；`package.json` 的 dependencies 保持不变。
- **`npm test` 必须零费用** — 不配置任何凭据时全部测试通过；LLM 未配置自动使用 mock；ComfyUI 未配置时相关接口返回 503 而不是发起调用。
- **隐私边界** — LLM API Key、ComfyUI 地址只存在于服务端 `.env`；任何 API 响应不得包含密钥值、本机绝对路径；`data/drama-projects/` 必须加入 `.gitignore`。
- **中文注释、中文提交信息** — 格式 `类型: 简短描述`（feat/fix/refactor/docs/test/chore）；代码标识符保持英文。
- **复用现有模式** — `envelope/sendJson/readJson` 响应约定、`createTask/setTask` 式状态机、`409 COST_CONFIRMATION_REQUIRED` 费用闸门、供应商健康检查形态（`{ configured, connected, state }`）。
- **不破坏现有功能** — 现有 `/api/tasks`、`/api/avatars` 等行为与 smoke 测试断言（纯净环境无任何 provider connected）必须保持通过。
- **CI 密钥扫描红线** — 代码与文档中不得出现 `/Users/`、`/home/`、`sk-` 后接 20+ 字符等模式（示例密钥用 `sk-your-key` 这类短占位）。
- **每个任务完成后提交一次 commit。**

## 文件结构

| 文件 | 职责 |
|---|---|
| `lib/drama/schema.mjs` | 项目/分镜/首帧数据模型、归一化、各阶段 LLM 输出校验器、演示剧本 |
| `lib/drama/store.mjs` | 项目持久化（`data/drama-projects/{id}/project.json`），内存缓存 + 列表 |
| `lib/drama/llm.mjs` | OpenAI 兼容 LLM 客户端、状态检查、JSON 提取、确定性 mock |
| `lib/drama/agents.mjs` | 四个流水线阶段：剧本分析 / 导演分镜 / 提示词 / 文本审核 |
| `lib/drama/pipeline.mjs` | 阶段编排、项目状态机推进、断点续跑 |
| `lib/drama/budget.mjs` | 剧集级预算估算（首帧 ¥0 本机 + Seedance/H3/TTS 预估） |
| `lib/drama/comfyui.mjs` | ComfyUI 状态检查、Flux 工作流模板、提交/轮询/取图 |
| `lib/drama/routes.mjs` | 全部 `/api/drama/*` 路由 + 首帧生成异步执行器 |
| `server.mjs` | 挂载 drama 路由、健康检查与接入契约扩展、`/drama-files/` 静态服务 |
| `public/drama.html` / `public/drama.js` | 短剧工作台页面（三栏：剧本与流水线 / 分镜表 / 角色与预算） |
| `public/styles.css` | 追加短剧页面样式（不改动既有规则） |
| `public/index.html` | 侧边栏加"短剧工作台"入口链接（一行） |
| `tests/drama-*.test.mjs` | `node:test` 单元测试 |
| `scripts/smoke.mjs` | 追加短剧全链路零费用冒烟 |
| `.env.example` / `.gitignore` / `package.json` / `docs/INTEGRATION-CONTRACT.md` / `docs/ARCHITECTURE.md` | 配置与文档更新 |

## 数据模型速览（供所有任务对照）

```
Project: { id: "drama-<uuid>", title, script, ratio: "portrait"|"landscape"|"square",
  status: "draft"|"analyzing"|"directing"|"prompting"|"reviewing"|"awaiting_gate_a"
        |"review_blocked"|"failed"|"frames"|"awaiting_gate_b"|"frames_confirmed",
  analysis: null | { synopsis, genre, characters: Character[], scenes: [{ id, name, location, mood }] },
  shots: Shot[], review: null | { pass, issues: [{ shotId|null, severity: "block"|"warn", message }], reviewedAt },
  budget: null | Budget, gateAConfirmedAt: null | ISO string,
  pipeline: { stage: null | "analyze"|"direct"|"prompt"|"review", error: null | { code, message, stage }, updatedAt },
  createdAt, updatedAt }

Character: { id: "char-N", name, role, personality, appearance (英文外观锁), avatarId: null }

Shot: { id: "shot-N", index, sceneName, characterIds: string[], shotType: "dialogue"|"cinematic",
  camera: "close-up"|"medium"|"wide"|"over-shoulder"|"low-angle",
  dialogue, action, durationSec: 2-15, emotion,
  fluxPrompt, negativePrompt, motionPrompt,
  frame: { status: "pending"|"generating"|"ready"|"confirmed"|"failed", file: string|null,
           seed: int|null, attempts: int, error: null | { code, message } } }

Budget: { currency: "CNY", estimated: true, totalShots, totalPaid,
  lines: [{ id: "frames"|"seedance"|"h3"|"tts", label, count, unitPrice, subtotal, kind: "local"|"paid" }],
  generatedAt }
```

---

### Task 1: 短剧数据模型与持久化

**Files:**
- Create: `lib/drama/schema.mjs`
- Create: `lib/drama/store.mjs`
- Test: `tests/drama-schema.test.mjs`
- Modify: `.gitignore`（追加 `data/drama-projects/`）
- Modify: `package.json`（check 脚本追加新文件；新增 `test:unit`）

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces（后续任务依赖的确切签名）:
  - `DRAMA_STAGES: string[]` = `["analyze","direct","prompt","review"]`
  - `SHOT_CAMERAS: string[]` = `["close-up","medium","wide","over-shoulder","low-angle"]`
  - `DRAMA_RATIOS: string[]` = `["portrait","landscape","square"]`
  - `DEMO_DRAMA_SCRIPT: string`
  - `createDramaProject({ title, script, ratio }) → project`
  - `normalizeFrame(raw?) → frame`
  - `normalizeShot(raw, index) → shot`
  - `validateAnalysis(value) → string[]`（空数组 = 合法，下同）
  - `validateDirectedShots(value) → string[]`
  - `validatePromptedShots(value) → string[]`
  - `validateReview(value) → string[]`
  - `createDramaStore(dataRoot) → { root, dir(id), save(project), get(id), list(), update(id, patcher) }`

- [ ] **Step 1: 写失败的测试**

```javascript
// tests/drama-schema.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDramaProject, normalizeShot, normalizeFrame,
  validateAnalysis, validateDirectedShots, validatePromptedShots, validateReview,
  DEMO_DRAMA_SCRIPT
} from "../lib/drama/schema.mjs";
import { createDramaStore } from "../lib/drama/store.mjs";

test("createDramaProject 生成带安全默认值的草稿项目", () => {
  const project = createDramaProject({ title: "  雨夜便利店  ", script: DEMO_DRAMA_SCRIPT, ratio: "16:9" });
  assert.match(project.id, /^drama-/);
  assert.equal(project.title, "雨夜便利店");
  assert.equal(project.ratio, "portrait"); // 非法比例回退竖屏
  assert.equal(project.status, "draft");
  assert.deepEqual(project.shots, []);
  assert.equal(project.analysis, null);
  assert.equal(project.gateAConfirmedAt, null);
});

test("normalizeShot 收敛非法输入并保留首帧状态", () => {
  const shot = normalizeShot({ camera: "drone", durationSec: 99, shotType: "dialogue", frame: { status: "ready", file: "a.png", seed: 7, attempts: 2 } }, 0);
  assert.equal(shot.id, "shot-1");
  assert.equal(shot.camera, "medium");
  assert.equal(shot.durationSec, 15);
  assert.deepEqual(shot.frame, { status: "ready", file: "a.png", seed: 7, attempts: 2, error: null });
  const bare = normalizeShot({}, 3);
  assert.equal(bare.id, "shot-4");
  assert.equal(bare.shotType, "cinematic");
  assert.equal(bare.frame.status, "pending");
});

test("normalizeFrame 拒绝伪造状态", () => {
  assert.equal(normalizeFrame({ status: "hacked" }).status, "pending");
  assert.equal(normalizeFrame().file, null);
});

test("校验器拒绝结构缺失的 LLM 输出", () => {
  assert.ok(validateAnalysis(null).length > 0);
  assert.ok(validateAnalysis({ synopsis: "x", characters: [], scenes: [] }).length > 0); // 角色为空
  assert.equal(validateAnalysis({
    synopsis: "雨夜偶遇", genre: "都市",
    characters: [{ name: "林晚", appearance: "young woman, short black hair" }],
    scenes: [{ name: "便利店门口" }]
  }).length, 0);
  assert.ok(validateDirectedShots({ shots: [] }).length > 0);
  assert.ok(validatePromptedShots({ shots: [{ fluxPrompt: "太短" }] }).length > 0);
  assert.ok(validateReview({ pass: "yes" }).length > 0);
  assert.equal(validateReview({ pass: true, issues: [] }).length, 0);
});

test("store 持久化项目并可按更新时间列出摘要", () => {
  const root = mkdtempSync(join(tmpdir(), "drama-store-test-"));
  try {
    const store = createDramaStore(root);
    const project = createDramaProject({ title: "测试短剧", script: "雨夜。" });
    store.save(project);
    store.update(project.id, (p) => { p.status = "awaiting_gate_a"; p.shots = [normalizeShot({ dialogue: "你好。" }, 0)]; });
    const fresh = createDramaStore(root); // 新实例从磁盘恢复
    const loaded = fresh.get(project.id);
    assert.equal(loaded.status, "awaiting_gate_a");
    assert.equal(loaded.shots.length, 1);
    const list = fresh.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].shotCount, 1);
    assert.equal(list[0].script, undefined); // 列表只给摘要
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/drama-schema.test.mjs`
Expected: FAIL，报 `Cannot find module '../lib/drama/schema.mjs'`

- [ ] **Step 3: 实现 schema.mjs**

```javascript
// lib/drama/schema.mjs
import { randomUUID } from "node:crypto";

export const DRAMA_STAGES = ["analyze", "direct", "prompt", "review"];
export const SHOT_CAMERAS = ["close-up", "medium", "wide", "over-shoulder", "low-angle"];
export const DRAMA_RATIOS = ["portrait", "landscape", "square"];

export const DEMO_DRAMA_SCRIPT = `雨夜，林晚抱着纸箱站在便利店门口躲雨，纸箱里是她刚被辞退时收拾的全部东西。
陈默推门出来，把伞塞进她手里：「雨太大了，伞给你。」
林晚愣住：「那你怎么办？」
陈默指了指对面的地铁站，转身冲进雨里。
林晚低头，发现伞柄上贴着一张便利店会员卡的挂失回执，持卡人姓名：陈默。
她追出去两步，雨幕里已经看不到人影。`;

const FRAME_STATUSES = ["generating", "ready", "confirmed", "failed"];

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

export function createDramaProject({ title, script, ratio } = {}) {
  const now = new Date().toISOString();
  return {
    id: `drama-${randomUUID()}`,
    title: String(title || "").trim().slice(0, 80) || "未命名短剧",
    script: String(script || "").trim(),
    ratio: DRAMA_RATIOS.includes(ratio) ? ratio : "portrait",
    status: "draft",
    analysis: null,
    shots: [],
    review: null,
    budget: null,
    gateAConfirmedAt: null,
    pipeline: { stage: null, error: null, updatedAt: null },
    createdAt: now,
    updatedAt: now
  };
}

export function normalizeFrame(raw = {}) {
  return {
    status: FRAME_STATUSES.includes(raw?.status) ? raw.status : "pending",
    file: typeof raw?.file === "string" && raw.file ? raw.file : null,
    seed: Number.isInteger(raw?.seed) ? raw.seed : null,
    attempts: Number.isInteger(raw?.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
    error: raw?.error && typeof raw.error === "object"
      ? { code: String(raw.error.code || "FRAME_FAILED"), message: String(raw.error.message || "").slice(0, 300) }
      : null
  };
}

export function normalizeShot(raw = {}, index = 0) {
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `shot-${index + 1}`,
    index: index + 1,
    sceneName: String(raw.sceneName || "未命名场景").slice(0, 40),
    characterIds: Array.isArray(raw.characterIds) ? raw.characterIds.map(String).slice(0, 6) : [],
    shotType: raw.shotType === "dialogue" ? "dialogue" : "cinematic",
    camera: SHOT_CAMERAS.includes(raw.camera) ? raw.camera : "medium",
    dialogue: String(raw.dialogue || "").slice(0, 600),
    action: String(raw.action || "").slice(0, 600),
    durationSec: clampNumber(raw.durationSec, 2, 15, 5),
    emotion: String(raw.emotion || "平静").slice(0, 20),
    fluxPrompt: String(raw.fluxPrompt || "").slice(0, 2000),
    negativePrompt: String(raw.negativePrompt || "").slice(0, 500),
    motionPrompt: String(raw.motionPrompt || "").slice(0, 500),
    frame: normalizeFrame(raw.frame)
  };
}

export function normalizeCharacter(raw = {}, index = 0) {
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `char-${index + 1}`,
    name: String(raw.name || `角色${index + 1}`).slice(0, 30),
    role: String(raw.role || "配角").slice(0, 20),
    personality: String(raw.personality || "").slice(0, 120),
    // 英文外观锁：注入每条 Flux 提示词，保证跨镜一致性的最小手段
    appearance: String(raw.appearance || "").slice(0, 400),
    avatarId: typeof raw.avatarId === "string" ? raw.avatarId : null
  };
}

export function normalizeAnalysis(raw = {}) {
  return {
    synopsis: String(raw.synopsis || "").slice(0, 600),
    genre: String(raw.genre || "剧情").slice(0, 30),
    characters: (Array.isArray(raw.characters) ? raw.characters : []).slice(0, 8).map((c, i) => normalizeCharacter(c, i)),
    scenes: (Array.isArray(raw.scenes) ? raw.scenes : []).slice(0, 12).map((s, i) => ({
      id: typeof s?.id === "string" && s.id ? s.id : `scene-${i + 1}`,
      name: String(s?.name || `场景${i + 1}`).slice(0, 40),
      location: String(s?.location || "").slice(0, 60),
      mood: String(s?.mood || "").slice(0, 60)
    }))
  };
}

export function validateAnalysis(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["analysis 必须是对象"];
  if (!String(value.synopsis || "").trim()) errors.push("缺少 synopsis");
  if (!Array.isArray(value.characters) || value.characters.length < 1) errors.push("characters 至少 1 个角色");
  (value.characters || []).forEach((c, i) => {
    if (!String(c?.name || "").trim()) errors.push(`characters[${i}] 缺少 name`);
    if (!String(c?.appearance || "").trim()) errors.push(`characters[${i}] 缺少 appearance（英文外观锁）`);
  });
  if (!Array.isArray(value.scenes) || value.scenes.length < 1) errors.push("scenes 至少 1 个场景");
  return errors;
}

export function validateDirectedShots(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["direct 输出必须是对象"];
  if (!Array.isArray(value.shots) || value.shots.length < 1) errors.push("shots 至少 1 个分镜");
  if (Array.isArray(value.shots) && value.shots.length > 24) errors.push("shots 最多 24 个分镜");
  (value.shots || []).forEach((s, i) => {
    if (!String(s?.action || "").trim() && !String(s?.dialogue || "").trim()) {
      errors.push(`shots[${i}] 需要 action 或 dialogue`);
    }
  });
  return errors;
}

export function validatePromptedShots(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["prompt 输出必须是对象"];
  if (!Array.isArray(value.shots) || value.shots.length < 1) errors.push("shots 至少 1 个分镜");
  (value.shots || []).forEach((s, i) => {
    if (String(s?.fluxPrompt || "").trim().length < 20) errors.push(`shots[${i}] fluxPrompt 至少 20 个字符`);
  });
  return errors;
}

export function validateReview(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["review 输出必须是对象"];
  if (typeof value.pass !== "boolean") errors.push("pass 必须是布尔值");
  if (!Array.isArray(value.issues)) errors.push("issues 必须是数组");
  (value.issues || []).forEach((issue, i) => {
    if (!["block", "warn"].includes(issue?.severity)) errors.push(`issues[${i}].severity 必须是 block 或 warn`);
    if (!String(issue?.message || "").trim()) errors.push(`issues[${i}] 缺少 message`);
  });
  return errors;
}
```

- [ ] **Step 4: 实现 store.mjs**

```javascript
// lib/drama/store.mjs
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 项目落盘结构：data/drama-projects/{id}/project.json + frames/
export function createDramaStore(dataRoot) {
  const root = join(dataRoot, "drama-projects");
  mkdirSync(root, { recursive: true });
  const cache = new Map();

  const dir = (id) => join(root, id);
  const projectFile = (id) => join(dir(id), "project.json");

  function persist(project) {
    mkdirSync(join(dir(project.id), "frames"), { recursive: true });
    writeFileSync(projectFile(project.id), JSON.stringify(project, null, 2));
  }

  function save(project) {
    project.updatedAt = new Date().toISOString();
    cache.set(project.id, project);
    persist(project);
    return project;
  }

  function get(id) {
    if (typeof id !== "string" || !/^drama-[a-f0-9-]+$/.test(id)) return null;
    if (!cache.has(id) && existsSync(projectFile(id))) {
      try {
        cache.set(id, JSON.parse(readFileSync(projectFile(id), "utf8")));
      } catch {
        return null;
      }
    }
    return cache.get(id) || null;
  }

  function list() {
    const ids = new Set(cache.keys());
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        if (/^drama-[a-f0-9-]+$/.test(name)) ids.add(name);
      }
    }
    return [...ids]
      .map(get)
      .filter(Boolean)
      .map(({ id, title, status, ratio, shots, createdAt, updatedAt }) => ({
        id, title, status, ratio, shotCount: Array.isArray(shots) ? shots.length : 0, createdAt, updatedAt
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function update(id, patcher) {
    const project = get(id);
    if (!project) return null;
    patcher(project);
    return save(project);
  }

  return { root, dir, save, get, list, update };
}
```

- [ ] **Step 5: 更新 .gitignore 与 package.json**

`.gitignore` 追加（放在 `data/seedance-runs/*` 那段之后）：

```gitignore
data/drama-projects/*
!data/drama-projects/.gitkeep
```

新建空文件 `data/drama-projects/.gitkeep`。

`package.json` 的 scripts 改为（保持现有条目，只追加）：

```json
"check": "node --check server.mjs && node --check desktop.mjs && node --check public/app.js && node --check public/drama.js && node --check lib/drama/schema.mjs && node --check lib/drama/store.mjs && node --check lib/drama/llm.mjs && node --check lib/drama/agents.mjs && node --check lib/drama/pipeline.mjs && node --check lib/drama/budget.mjs && node --check lib/drama/comfyui.mjs && node --check lib/drama/routes.mjs",
"test:unit": "node --test tests/",
"test": "npm run check && npm run test:unit && npm run smoke",
```

注意：`node --check public/drama.js` 与 lib 文件在对应任务创建前会失败——本任务先只把 `lib/drama/schema.mjs`、`lib/drama/store.mjs` 加入 check，其余文件在各创建任务中追加进 check 脚本。最终形态如上。

本任务的 check 行临时写为：
```json
"check": "node --check server.mjs && node --check desktop.mjs && node --check public/app.js && node --check lib/drama/schema.mjs && node --check lib/drama/store.mjs",
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test tests/drama-schema.test.mjs && npm run check`
Expected: 5 个测试全部 PASS；check 无输出退出码 0

- [ ] **Step 7: Commit**

```bash
git add lib/drama/schema.mjs lib/drama/store.mjs tests/drama-schema.test.mjs .gitignore package.json data/drama-projects/.gitkeep
git commit -m "feat: 新增短剧项目数据模型与本地持久化"
```

---

### Task 2: LLM 客户端与确定性 mock

**Files:**
- Create: `lib/drama/llm.mjs`
- Test: `tests/drama-llm.test.mjs`
- Modify: `package.json`（check 追加 `lib/drama/llm.mjs`）

**Interfaces:**
- Consumes: Task 1 的 `DEMO_DRAMA_SCRIPT`。
- Produces:
  - `getDramaLlmConfig(env = process.env) → { baseUrl, apiKey, model, mock, timeoutMs, maxRetries }`
    - `mock = env.DRAMA_LLM_MOCK === "1" || !baseUrl || !model`（`apiKey` 可空，兼容本机 Ollama）
  - `dramaLlmStatus(config, fetchImpl = fetch) → Promise<{ configured, connected, state, mock, model }>`
  - `callDramaLlm(stage, { system, user }, deps = {}) → Promise<string>`（deps: `{ config, fetchImpl, sleep }`；mock 时返回确定性内容；5xx/网络错误重试 `config.maxRetries` 次，默认 2）
  - `extractJson(text) → any`（剥 ```json 围栏，截取首个 `{` 到末个 `}`；失败抛 `DRAMA_LLM_INVALID_JSON`）

- [ ] **Step 1: 写失败的测试**

```javascript
// tests/drama-llm.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { getDramaLlmConfig, callDramaLlm, extractJson, dramaLlmStatus } from "../lib/drama/llm.mjs";
import { DEMO_DRAMA_SCRIPT } from "../lib/drama/schema.mjs";

test("未配置时落入 mock 模式", () => {
  const config = getDramaLlmConfig({});
  assert.equal(config.mock, true);
  assert.equal(config.baseUrl, "");
});

test("mock 模式各阶段返回确定性 JSON 文本", async () => {
  const config = getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" });
  const analysisText = await callDramaLlm("analyze", { system: "s", user: JSON.stringify({ script: DEMO_DRAMA_SCRIPT }) }, { config });
  const analysis = extractJson(analysisText);
  assert.ok(analysis.characters.length >= 2);
  const directText = await callDramaLlm("direct", { system: "s", user: JSON.stringify({ script: DEMO_DRAMA_SCRIPT, analysis }) }, { config });
  const directed = extractJson(directText);
  assert.ok(directed.shots.length >= 3);
  const promptText = await callDramaLlm("prompt", { system: "s", user: JSON.stringify({ analysis, shots: directed.shots }) }, { config });
  const prompted = extractJson(promptText);
  assert.ok(prompted.shots.every((s) => s.fluxPrompt.length >= 20));
  // 确定性：同输入同输出
  const again = await callDramaLlm("analyze", { system: "s", user: JSON.stringify({ script: DEMO_DRAMA_SCRIPT }) }, { config });
  assert.equal(again, analysisText);
});

test("extractJson 容忍 markdown 围栏并拒绝非 JSON", () => {
  assert.deepEqual(extractJson("```json\n{\"a\":1}\n```"), { a: 1 });
  assert.deepEqual(extractJson("前缀 {\"a\":2} 后缀"), { a: 2 });
  assert.throws(() => extractJson("没有对象"), /DRAMA_LLM_INVALID_JSON/);
});

test("真实模式网络错误重试后抛 DRAMA_LLM_UNREACHABLE", async () => {
  const config = getDramaLlmConfig({
    DRAMA_LLM_BASE_URL: "http://127.0.0.1:9", DRAMA_LLM_MODEL: "demo", DRAMA_LLM_API_KEY: "sk-your-key"
  });
  assert.equal(config.mock, false);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("connection refused"); };
  const sleep = async () => {};
  await assert.rejects(
    callDramaLlm("analyze", { system: "s", user: "{}" }, { config, fetchImpl, sleep }),
    (error) => error.code === "DRAMA_LLM_UNREACHABLE" && error.retryable === true
  );
  assert.equal(calls, 3); // 首次 + 2 次重试
});

test("dramaLlmStatus 在 mock 模式不报 connected（保持纯净环境 smoke 不变量）", async () => {
  const status = await dramaLlmStatus(getDramaLlmConfig({}));
  assert.deepEqual({ configured: status.configured, connected: status.connected, state: status.state, mock: status.mock },
    { configured: false, connected: false, state: "mock", mock: true });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/drama-llm.test.mjs`
Expected: FAIL，报 `Cannot find module '../lib/drama/llm.mjs'`

- [ ] **Step 3: 实现 llm.mjs**

```javascript
// lib/drama/llm.mjs
// OpenAI 兼容端点客户端；未配置时返回确定性 mock，保证零费用演示与测试
export function getDramaLlmConfig(env = process.env) {
  const baseUrl = String(env.DRAMA_LLM_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = String(env.DRAMA_LLM_API_KEY || "");
  const model = String(env.DRAMA_LLM_MODEL || "");
  const mock = env.DRAMA_LLM_MOCK === "1" || !baseUrl || !model;
  return {
    baseUrl,
    apiKey,
    model,
    mock,
    timeoutMs: Number(env.DRAMA_LLM_TIMEOUT_MS) || 120_000,
    maxRetries: Number.isInteger(Number(env.DRAMA_LLM_MAX_RETRIES)) ? Number(env.DRAMA_LLM_MAX_RETRIES) : 2
  };
}

export async function dramaLlmStatus(config = getDramaLlmConfig(), fetchImpl = fetch) {
  if (config.mock) {
    return { configured: false, connected: false, state: "mock", mock: true, model: config.model || null };
  }
  try {
    const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
    const response = await fetchImpl(`${config.baseUrl}/models`, { headers, signal: AbortSignal.timeout(4000) });
    return { configured: true, connected: response.ok, state: response.ok ? "connected" : `http_${response.status}`, mock: false, model: config.model };
  } catch {
    return { configured: true, connected: false, state: "unreachable", mock: false, model: config.model };
  }
}

export function extractJson(text) {
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw Object.assign(new Error("DRAMA_LLM_INVALID_JSON: 输出中找不到 JSON 对象"), { code: "DRAMA_LLM_INVALID_JSON" });
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (error) {
    throw Object.assign(new Error(`DRAMA_LLM_INVALID_JSON: ${error.message}`), { code: "DRAMA_LLM_INVALID_JSON" });
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function callDramaLlm(stage, { system, user }, deps = {}) {
  const config = deps.config || getDramaLlmConfig();
  if (config.mock) return mockStageResponse(stage, user);
  const fetchImpl = deps.fetchImpl || fetch;
  const sleep = deps.sleep || defaultSleep;
  let lastError = null;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (attempt) await sleep(500 * attempt);
    try {
      const headers = { "Content-Type": "application/json" };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(config.timeoutMs),
        body: JSON.stringify({
          model: config.model,
          temperature: 0.4,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ]
        })
      });
      if (!response.ok) {
        const retryable = response.status >= 500 || response.status === 429;
        lastError = Object.assign(new Error(`编排模型返回 ${response.status}`), { code: `DRAMA_LLM_HTTP_${response.status}`, retryable });
        if (retryable) continue;
        throw lastError;
      }
      const payload = await response.json();
      const text = payload?.choices?.[0]?.message?.content;
      if (!text) throw Object.assign(new Error("编排模型返回为空"), { code: "DRAMA_LLM_EMPTY", retryable: true });
      return text;
    } catch (error) {
      if (error.code && !String(error.code).startsWith("DRAMA_LLM_UNREACHABLE")) {
        if (!error.retryable) throw error;
        lastError = error;
        continue;
      }
      lastError = Object.assign(new Error(`编排模型不可达：${error.message}`), { code: "DRAMA_LLM_UNREACHABLE", retryable: true });
    }
  }
  throw lastError;
}

// ---------------- 确定性 mock：从用户 payload 中提取剧本并启发式生成 ----------------

function mockPayload(user) {
  try {
    const start = String(user).indexOf("{");
    const end = String(user).lastIndexOf("}");
    return JSON.parse(String(user).slice(start, end + 1));
  } catch {
    return {};
  }
}

function mockSentences(script) {
  return String(script || "").split(/[。！？!?\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
}

function mockAnalysis(payload) {
  const sentences = mockSentences(payload.script);
  return {
    synopsis: sentences[0] ? `${sentences[0]}（演示梗概）` : "演示短剧梗概",
    genre: "都市情感",
    characters: [
      { id: "char-1", name: "林晚", role: "主角", personality: "外柔内刚，刚经历挫折", appearance: "young Chinese woman, shoulder-length black hair, tired gentle eyes, beige coat" },
      { id: "char-2", name: "陈默", role: "主角", personality: "沉默寡言，体贴", appearance: "young Chinese man, short black hair, dark gray jacket, calm expression" }
    ],
    scenes: [
      { id: "scene-1", name: "便利店门口", location: "城市街角便利店", mood: "雨夜冷色，灯光温暖" },
      { id: "scene-2", name: "雨夜街道", location: "通往地铁站的路口", mood: "雨幕朦胧" }
    ]
  };
}

function mockDirection(payload) {
  const sentences = mockSentences(payload.script);
  const picked = sentences.length ? sentences : ["演示画面一", "演示画面二", "演示画面三"];
  const cameras = ["medium", "close-up", "wide"];
  const shots = picked.slice(0, 6).map((sentence, i) => {
    const isDialogue = /[「『"]/.test(sentence) || i % 2 === 1;
    return {
      id: `shot-${i + 1}`,
      sceneName: i < picked.length / 2 ? "便利店门口" : "雨夜街道",
      characterIds: isDialogue ? ["char-1", "char-2"] : ["char-1"],
      shotType: isDialogue ? "dialogue" : "cinematic",
      camera: cameras[i % cameras.length],
      dialogue: isDialogue ? sentence.replace(/[「『"]|[」』"]/g, "") : "",
      action: sentence,
      durationSec: 4 + (i % 3),
      emotion: ["失落", "意外", "温暖"][i % 3]
    };
  });
  return { shots };
}

function mockPrompts(payload) {
  const characters = new Map((payload.analysis?.characters || []).map((c) => [c.id, c]));
  const shots = (payload.shots || []).map((shot) => {
    const appearances = (shot.characterIds || [])
      .map((id) => characters.get(id)?.appearance)
      .filter(Boolean)
      .join("; ");
    return {
      ...shot,
      fluxPrompt: [
        "cinematic film still", `${shot.camera || "medium"} shot`,
        appearances || "single character",
        shot.action || shot.dialogue || "quiet moment",
        `mood: ${shot.emotion || "calm"}`,
        "rainy night city lighting, photorealistic, 85mm lens"
      ].join(", "),
      negativePrompt: "low quality, watermark, text, deformed face, extra fingers",
      motionPrompt: "subtle camera push-in, natural micro motion, rain falling"
    };
  });
  return { shots };
}

function mockReview() {
  return { pass: true, issues: [{ shotId: null, severity: "warn", message: "演示编排模式：未接入真实审核模型，仅做结构校验" }] };
}

function mockStageResponse(stage, user) {
  const payload = mockPayload(user);
  if (stage === "analyze") return JSON.stringify(mockAnalysis(payload));
  if (stage === "direct") return JSON.stringify(mockDirection(payload));
  if (stage === "prompt") return JSON.stringify(mockPrompts(payload));
  if (stage === "review") return JSON.stringify(mockReview(payload));
  return JSON.stringify({});
}
```

- [ ] **Step 4: 更新 package.json check**

check 脚本追加 `&& node --check lib/drama/llm.mjs`。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test tests/drama-llm.test.mjs && npm run check`
Expected: 5 个测试全部 PASS

- [ ] **Step 6: Commit**

```bash
git add lib/drama/llm.mjs tests/drama-llm.test.mjs package.json
git commit -m "feat: 新增短剧编排 LLM 客户端与确定性 mock"
```

---

### Task 3: 四个 Agent 流水线阶段

**Files:**
- Create: `lib/drama/agents.mjs`
- Test: `tests/drama-agents.test.mjs`
- Modify: `package.json`（check 追加 `lib/drama/agents.mjs`）

**Interfaces:**
- Consumes: `callDramaLlm / extractJson / getDramaLlmConfig`（Task 2）；`validateAnalysis / validateDirectedShots / validatePromptedShots / validateReview / normalizeAnalysis / normalizeShot`（Task 1）。
- Produces（deps 均为 `{ config, fetchImpl, sleep }`，与 callDramaLlm 相同）:
  - `runScriptAnalysis(project, deps) → Promise<analysis>`（已 normalize）
  - `runDirection(project, deps) → Promise<shot[]>`（normalizeShot 后，无提示词；characterIds 过滤为 analysis 中存在的角色）
  - `runPromptWriting(project, deps) → Promise<shot[]>`（基于 `project.shots` 现状补提示词，保留 frame）
  - `runReview(project, deps) → Promise<{ pass, issues }>`
  - 阶段输出连续两次校验失败抛 `{ code: "DRAMA_STAGE_INVALID", stage }`

- [ ] **Step 1: 写失败的测试**

```javascript
// tests/drama-agents.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { runScriptAnalysis, runDirection, runPromptWriting, runReview } from "../lib/drama/agents.mjs";
import { createDramaProject, getDramaLlmConfigForTest } from "./helpers.mjs";
```

等等——为避免 helper 文件，直接在每个测试文件内联 config：

```javascript
// tests/drama-agents.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { runScriptAnalysis, runDirection, runPromptWriting, runReview } from "../lib/drama/agents.mjs";
import { createDramaProject, DEMO_DRAMA_SCRIPT } from "../lib/drama/schema.mjs";
import { getDramaLlmConfig } from "../lib/drama/llm.mjs";

const deps = { config: getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" }) };

async function analyzedProject() {
  const project = createDramaProject({ title: "测试", script: DEMO_DRAMA_SCRIPT });
  project.analysis = await runScriptAnalysis(project, deps);
  return project;
}

test("剧本分析产出合法角色与场景（含英文外观锁）", async () => {
  const project = await analyzedProject();
  assert.ok(project.analysis.synopsis.length > 0);
  assert.ok(project.analysis.characters.length >= 2);
  assert.ok(project.analysis.characters.every((c) => c.appearance.length > 10));
  assert.ok(project.analysis.characters.every((c) => c.avatarId === null));
});

test("导演分镜引用存在的角色并归一化镜头", async () => {
  const project = await analyzedProject();
  const shots = await runDirection(project, deps);
  const knownIds = new Set(project.analysis.characters.map((c) => c.id));
  assert.ok(shots.length >= 3);
  assert.ok(shots.every((s) => s.characterIds.every((id) => knownIds.has(id))));
  assert.ok(shots.every((s) => s.durationSec >= 2 && s.durationSec <= 15));
  assert.ok(shots.some((s) => s.shotType === "dialogue"));
  assert.equal(shots[0].frame.status, "pending");
});

test("提示词阶段注入外观锁并保留已有首帧状态", async () => {
  const project = await analyzedProject();
  project.shots = await runDirection(project, deps);
  project.shots[0].frame = { status: "ready", file: "keep.png", seed: 42, attempts: 1, error: null };
  const shots = await runPromptWriting(project, deps);
  const appearances = project.analysis.characters.map((c) => c.appearance.split(",")[0]);
  assert.ok(shots.every((s) => s.fluxPrompt.length >= 20));
  assert.ok(shots.some((s) => appearances.some((a) => s.fluxPrompt.includes(a))));
  assert.equal(shots[0].frame.file, "keep.png"); // 不丢首帧
});

test("审核阶段产出结构化结论", async () => {
  const project = await analyzedProject();
  project.shots = await runPromptWriting({ ...project, shots: await runDirection(project, deps) }, deps);
  const review = await runReview(project, deps);
  assert.equal(typeof review.pass, "boolean");
  assert.ok(Array.isArray(review.issues));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/drama-agents.test.mjs`
Expected: FAIL，报 `Cannot find module '../lib/drama/agents.mjs'`

- [ ] **Step 3: 实现 agents.mjs**

```javascript
// lib/drama/agents.mjs
// 四个确定性流水线阶段：结构化提示词 + JSON 校验 + 一次带反馈的重试（仅 LLM 调用，不涉及付费生成）
import { callDramaLlm, extractJson } from "./llm.mjs";
import {
  normalizeAnalysis, normalizeShot,
  validateAnalysis, validateDirectedShots, validatePromptedShots, validateReview
} from "./schema.mjs";

const SYSTEM_ANALYZE = `你是短剧剧本分析师。只输出 JSON，不要输出任何解释。
输出结构：{"synopsis":"一句话梗概","genre":"类型","characters":[{"id":"char-1","name":"角色名","role":"主角|配角","personality":"性格","appearance":"英文外观锁定描述，含年龄感/发型/服装/标志性特征，供图像模型使用"}],"scenes":[{"id":"scene-1","name":"场景名","location":"地点","mood":"氛围"}]}
要求：characters 覆盖全部有台词或关键动作的角色；appearance 必须是英文、具体、可在不同镜头间保持一致。`;

const SYSTEM_DIRECT = `你是短剧导演。把剧本拆成 3-12 个分镜，只输出 JSON。
输出结构：{"shots":[{"id":"shot-1","sceneName":"场景名","characterIds":["char-1"],"shotType":"dialogue|cinematic","camera":"close-up|medium|wide|over-shoulder|low-angle","dialogue":"该镜台词，无则空串","action":"画面动作描述","durationSec":2-15的整数,"emotion":"情绪"}]}
要求：有台词的镜头用 dialogue 类型（后续走数字人口播）；纯画面用 cinematic；镜头时长总和控制在 90 秒内；characterIds 只能引用分析结果中的角色 id。`;

const SYSTEM_PROMPT = `你是 AI 视频提示词工程师。为每个分镜写 Flux 首帧提示词，只输出 JSON。
输出结构：{"shots":[{"id":"shot-1","fluxPrompt":"英文提示词","negativePrompt":"英文负面提示词","motionPrompt":"英文运动提示词"}]}
要求：fluxPrompt 必须以 "cinematic film still" 开头，包含该镜每个出场角色的 appearance 原文、camera 景别、action 画面、emotion 氛围；全英文；80-200 词。`;

const SYSTEM_REVIEW = `你是短剧内容审核员。审核分镜表的文本内容，只输出 JSON。
输出结构：{"pass":true|false,"issues":[{"shotId":"shot-1或null","severity":"block|warn","message":"问题描述"}]}
block 标准：违法违规、露骨色情、仇恨歧视、未成年人风险、明确侵权。warn 标准：台词与画面不符、时长异常、角色缺失。没有问题则 issues 为空数组、pass 为 true。`;

async function callStage(stage, system, payload, validate, deps) {
  let user = JSON.stringify(payload, null, 2);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await callDramaLlm(stage, { system, user }, deps);
    try {
      const value = extractJson(text);
      const errors = validate(value);
      if (!errors.length) return value;
      lastError = new Error(errors.join("；"));
    } catch (error) {
      lastError = error;
    }
    user = `${JSON.stringify(payload)}\n\n上次输出不合法：${lastError.message}。请只输出合法 JSON。`;
  }
  throw Object.assign(new Error(`${stage} 阶段输出校验失败：${lastError.message}`), { code: "DRAMA_STAGE_INVALID", stage });
}

export async function runScriptAnalysis(project, deps = {}) {
  const value = await callStage("analyze", SYSTEM_ANALYZE, { script: project.script }, validateAnalysis, deps);
  return normalizeAnalysis(value);
}

export async function runDirection(project, deps = {}) {
  const value = await callStage("direct", SYSTEM_DIRECT,
    { script: project.script, analysis: project.analysis }, validateDirectedShots, deps);
  const knownIds = new Set((project.analysis?.characters || []).map((c) => c.id));
  return value.shots.map((raw, i) => {
    const shot = normalizeShot(raw, i);
    shot.characterIds = shot.characterIds.filter((id) => knownIds.has(id));
    shot.fluxPrompt = "";
    shot.negativePrompt = "";
    shot.motionPrompt = "";
    return shot;
  });
}

export async function runPromptWriting(project, deps = {}) {
  const current = project.shots.map((shot, i) => normalizeShot(shot, i));
  const value = await callStage("prompt", SYSTEM_PROMPT,
    { analysis: project.analysis, shots: current }, validatePromptedShots, deps);
  const prompted = new Map(value.shots.map((s) => [String(s.id), s]));
  return current.map((shot) => {
    const patch = prompted.get(shot.id);
    if (!patch) return shot;
    return normalizeShot({ ...shot, fluxPrompt: patch.fluxPrompt, negativePrompt: patch.negativePrompt, motionPrompt: patch.motionPrompt }, shot.index - 1);
  });
}

export async function runReview(project, deps = {}) {
  const value = await callStage("review", SYSTEM_REVIEW,
    { analysis: project.analysis, shots: project.shots }, validateReview, deps);
  return {
    pass: value.pass,
    issues: value.issues.map((issue) => ({
      shotId: typeof issue.shotId === "string" ? issue.shotId : null,
      severity: issue.severity,
      message: String(issue.message).slice(0, 300)
    }))
  };
}
```

注意：测试 Step 1 中第一个代码块（引用 `./helpers.mjs` 的 import 草案）是错误草稿，以第二个完整代码块为准——实现者请直接使用第二个代码块。

- [ ] **Step 4: 更新 package.json check 并运行测试**

check 追加 `&& node --check lib/drama/agents.mjs`。

Run: `node --test tests/ && npm run check`
Expected: Task 1-3 全部测试 PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/agents.mjs tests/drama-agents.test.mjs package.json
git commit -m "feat: 实现剧本分析/导演分镜/提示词/审核四个流水线阶段"
```

---

### Task 4: 流水线编排器

**Files:**
- Create: `lib/drama/pipeline.mjs`
- Test: `tests/drama-pipeline.test.mjs`
- Modify: `package.json`（check 追加 `lib/drama/pipeline.mjs`）

**Interfaces:**
- Consumes: Task 3 四个阶段函数；Task 1 store；`estimateBudget / getDramaPricing`（Task 5——**先实现 Task 5 再跑本任务测试**，或在本任务内按 Task 5 的签名先行导入；建议执行顺序：Task 5 提前到本任务之前）。
- Produces:
  - `PIPELINE_STAGE_STATUS = { analyze: "analyzing", direct: "directing", prompt: "prompting", review: "reviewing" }`
  - `isPipelineRunning(projectId) → boolean`
  - `runDramaPipeline(store, projectId, { fromStage = "analyze", deps = {}, pricing } = {}) → Promise<{ reused: boolean }>`
    - 推进顺序 analyze→direct→prompt→review；每阶段先置状态再执行；review 后写入 `review + budget`，按 block 情况置 `awaiting_gate_a` 或 `review_blocked`
    - direct 阶段重跑会重置 `gateAConfirmedAt = null`（分镜变了预算作废）
    - 任何阶段失败：项目置 `failed`，`pipeline.error = { code, message, stage }`，不抛出（错误经项目状态透出）

> **执行顺序调整：** Task 5（预算）体量小且被本任务依赖，执行时先做 Task 5 再回到 Task 4。计划文档保持原编号以便引用。

- [ ] **Step 1: 写失败的测试**

```javascript
// tests/drama-pipeline.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject, DEMO_DRAMA_SCRIPT } from "../lib/drama/schema.mjs";
import { getDramaLlmConfig } from "../lib/drama/llm.mjs";
import { runDramaPipeline, isPipelineRunning } from "../lib/drama/pipeline.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "drama-pipeline-test-"));
  const store = createDramaStore(root);
  const project = store.save(createDramaProject({ title: "流水线测试", script: DEMO_DRAMA_SCRIPT }));
  return { root, store, project };
}

test("mock 模式全流程推进到 awaiting_gate_a 并产出预算", async () => {
  const { root, store, project } = fixture();
  try {
    const deps = { config: getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" }) };
    const result = await runDramaPipeline(store, project.id, { deps });
    assert.equal(result.reused, false);
    const done = store.get(project.id);
    assert.equal(done.status, "awaiting_gate_a");
    assert.ok(done.shots.length >= 3);
    assert.ok(done.shots.every((s) => s.fluxPrompt.length >= 20));
    assert.ok(done.budget && done.budget.lines.length >= 3);
    assert.equal(done.review.pass, true);
    assert.equal(done.pipeline.stage, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("阶段失败落 failed 并可从断点续跑", async () => {
  const { root, store, project } = fixture();
  try {
    const badDeps = {
      config: getDramaLlmConfig({ DRAMA_LLM_BASE_URL: "http://127.0.0.1:9", DRAMA_LLM_MODEL: "x" }),
      fetchImpl: async () => { throw new Error("connection refused"); },
      sleep: async () => {}
    };
    await runDramaPipeline(store, project.id, { deps: badDeps });
    const failed = store.get(project.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.pipeline.error.stage, "analyze");
    const goodDeps = { config: getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" }) };
    await runDramaPipeline(store, project.id, { fromStage: failed.pipeline.error.stage, deps: goodDeps });
    assert.equal(store.get(project.id).status, "awaiting_gate_a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("运行中的流水线拒绝重入", async () => {
  const { root, store, project } = fixture();
  try {
    assert.equal(isPipelineRunning(project.id), false);
    const deps = { config: getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" }) };
    const first = runDramaPipeline(store, project.id, { deps });
    // mock 是同步微任务，这里主要验证接口形态；并发重入由 running 集合保证
    await first;
    assert.equal(isPipelineRunning(project.id), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/drama-pipeline.test.mjs`
Expected: FAIL，报 `Cannot find module '../lib/drama/pipeline.mjs'`（或预算模块）

- [ ] **Step 3: 实现 pipeline.mjs**

```javascript
// lib/drama/pipeline.mjs
import { DRAMA_STAGES } from "./schema.mjs";
import { runScriptAnalysis, runDirection, runPromptWriting, runReview } from "./agents.mjs";
import { estimateBudget, getDramaPricing } from "./budget.mjs";

export const PIPELINE_STAGE_STATUS = {
  analyze: "analyzing",
  direct: "directing",
  prompt: "prompting",
  review: "reviewing"
};

const running = new Set();

export function isPipelineRunning(projectId) {
  return running.has(projectId);
}

export async function runDramaPipeline(store, projectId, { fromStage = "analyze", deps = {}, pricing } = {}) {
  if (running.has(projectId)) return { reused: true };
  const project = store.get(projectId);
  if (!project) throw Object.assign(new Error("项目不存在"), { code: "DRAMA_PROJECT_NOT_FOUND" });
  const stageIndex = DRAMA_STAGES.indexOf(fromStage);
  const stages = DRAMA_STAGES.slice(stageIndex === -1 ? 0 : stageIndex);
  running.add(projectId);
  let currentStage = null;
  try {
    for (const stage of stages) {
      currentStage = stage;
      store.update(projectId, (p) => {
        p.status = PIPELINE_STAGE_STATUS[stage];
        p.pipeline = { stage, error: null, updatedAt: new Date().toISOString() };
      });
      if (stage === "analyze") {
        const analysis = await runScriptAnalysis(store.get(projectId), deps);
        store.update(projectId, (p) => { p.analysis = analysis; });
      } else if (stage === "direct") {
        const shots = await runDirection(store.get(projectId), deps);
        store.update(projectId, (p) => {
          p.shots = shots;
          // 分镜重排后旧预算与费用确认一律作废
          p.gateAConfirmedAt = null;
          p.budget = null;
        });
      } else if (stage === "prompt") {
        const shots = await runPromptWriting(store.get(projectId), deps);
        store.update(projectId, (p) => { p.shots = shots; });
      } else if (stage === "review") {
        const review = await runReview(store.get(projectId), deps);
        store.update(projectId, (p) => {
          p.review = { ...review, reviewedAt: new Date().toISOString() };
          p.budget = estimateBudget(p, pricing || getDramaPricing());
          const blocked = !review.pass || review.issues.some((issue) => issue.severity === "block");
          p.status = blocked ? "review_blocked" : "awaiting_gate_a";
          p.pipeline = { stage: null, error: null, updatedAt: new Date().toISOString() };
        });
      }
    }
    return { reused: false };
  } catch (error) {
    store.update(projectId, (p) => {
      p.status = "failed";
      p.pipeline = {
        stage: currentStage,
        error: { code: error.code || "DRAMA_PIPELINE_FAILED", message: error.message, stage: currentStage },
        updatedAt: new Date().toISOString()
      };
    });
    return { reused: false };
  } finally {
    running.delete(projectId);
  }
}
```

- [ ] **Step 4: 更新 package.json check 并运行测试**

check 追加 `&& node --check lib/drama/pipeline.mjs`。

Run: `node --test tests/ && npm run check`
Expected: 全部 PASS（Task 5 的 budget.mjs 必须先存在）

- [ ] **Step 5: Commit**

```bash
git add lib/drama/pipeline.mjs tests/drama-pipeline.test.mjs package.json
git commit -m "feat: 新增短剧流水线编排器与断点续跑"
```

---

### Task 5: 剧集级预算估算

**Files:**
- Create: `lib/drama/budget.mjs`
- Test: `tests/drama-budget.test.mjs`
- Modify: `package.json`（check 追加 `lib/drama/budget.mjs`）

**Interfaces:**
- Consumes: 项目 shots（Task 1 模型）。
- Produces:
  - `getDramaPricing(env = process.env) → { currency: "CNY", seedancePerShot, h3PerSecond, ttsPerThousandChars, framePerShot: 0 }`
    - 默认：`DRAMA_PRICE_SEEDANCE_PER_SHOT=6`、`DRAMA_PRICE_H3_PER_SECOND=0.5`、`DRAMA_PRICE_TTS_PER_KCHAR=2`
  - `estimateBudget(project, pricing = getDramaPricing()) → Budget`
    - lines: `frames`（本机 ¥0, kind "local"）、`seedance`（dialogue 镜 × 单价）、`h3`（cinematic 镜总秒数 × 秒价）、`tts`（台词总字数/1000 × 单价）
    - `totalPaid` = paid 行小计之和；`estimated: true`

- [ ] **Step 1: 写失败的测试**

```javascript
// tests/drama-budget.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { getDramaPricing, estimateBudget } from "../lib/drama/budget.mjs";
import { createDramaProject, normalizeShot } from "../lib/drama/schema.mjs";

test("默认单价可被环境变量覆盖", () => {
  const pricing = getDramaPricing({});
  assert.equal(pricing.seedancePerShot, 6);
  assert.equal(pricing.framePerShot, 0);
  const custom = getDramaPricing({ DRAMA_PRICE_SEEDANCE_PER_SHOT: "9.5" });
  assert.equal(custom.seedancePerShot, 9.5);
});

test("按镜头类型与台词字数汇总预算", () => {
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
  assert.equal(byId.h3.count, 8); // 8 秒剧情镜
  assert.equal(byId.h3.subtotal, 4);
  assert.equal(byId.tts.count, 8); // 8 个非空白字符
  assert.ok(Math.abs(byId.tts.subtotal - 0.016) < 1e-9);
  assert.ok(Math.abs(budget.totalPaid - 16.016) < 1e-9);
  assert.equal(budget.estimated, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/drama-budget.test.mjs`
Expected: FAIL，报 `Cannot find module '../lib/drama/budget.mjs'`

- [ ] **Step 3: 实现 budget.mjs**

```javascript
// lib/drama/budget.mjs
// 剧集级预算单：首帧走本机 ComfyUI 记 ¥0；视频与配音为预估价，单价可用环境变量校准
export function getDramaPricing(env = process.env) {
  return {
    currency: "CNY",
    seedancePerShot: Number(env.DRAMA_PRICE_SEEDANCE_PER_SHOT ?? 6),
    h3PerSecond: Number(env.DRAMA_PRICE_H3_PER_SECOND ?? 0.5),
    ttsPerThousandChars: Number(env.DRAMA_PRICE_TTS_PER_KCHAR ?? 2),
    framePerShot: 0
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

export function estimateBudget(project, pricing = getDramaPricing()) {
  const shots = Array.isArray(project.shots) ? project.shots : [];
  const dialogueShots = shots.filter((s) => s.shotType === "dialogue");
  const cinematicShots = shots.filter((s) => s.shotType !== "dialogue");
  const ttsChars = dialogueShots.reduce((sum, s) => sum + String(s.dialogue || "").replace(/\s/g, "").length, 0);
  const cinematicSeconds = cinematicShots.reduce((sum, s) => sum + (Number(s.durationSec) || 0), 0);
  const lines = [
    {
      id: "frames",
      label: `首帧生成（本机 ComfyUI ×${shots.length} 镜）`,
      count: shots.length,
      unitPrice: pricing.framePerShot,
      subtotal: 0,
      kind: "local"
    },
    {
      id: "seedance",
      label: `口播镜视频（Seedance ×${dialogueShots.length} 镜，预估）`,
      count: dialogueShots.length,
      unitPrice: pricing.seedancePerShot,
      subtotal: round(dialogueShots.length * pricing.seedancePerShot),
      kind: "paid"
    },
    {
      id: "h3",
      label: `剧情镜视频（MiniMax H3 约 ${cinematicSeconds} 秒，预估）`,
      count: cinematicSeconds,
      unitPrice: pricing.h3PerSecond,
      subtotal: round(cinematicSeconds * pricing.h3PerSecond),
      kind: "paid"
    },
    {
      id: "tts",
      label: `台词配音（约 ${ttsChars} 字，预估）`,
      count: ttsChars,
      unitPrice: pricing.ttsPerThousandChars,
      subtotal: round((ttsChars / 1000) * pricing.ttsPerThousandChars),
      kind: "paid"
    }
  ];
  return {
    currency: pricing.currency,
    estimated: true,
    totalShots: shots.length,
    totalPaid: round(lines.filter((line) => line.kind === "paid").reduce((sum, line) => sum + line.subtotal, 0)),
    lines,
    generatedAt: new Date().toISOString()
  };
}
```

- [ ] **Step 4: 更新 package.json check 并运行测试**

check 追加 `&& node --check lib/drama/budget.mjs`。

Run: `node --test tests/ && npm run check`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/budget.mjs tests/drama-budget.test.mjs package.json
git commit -m "feat: 新增剧集级预算估算"
```

---

### Task 6: 短剧 API 路由（项目/流水线/分镜编辑/闸门 A）与 server 挂载

**Files:**
- Create: `lib/drama/routes.mjs`
- Modify: `server.mjs`（import、store 初始化、providerHealth、integrationContract、handleApi 挂载）
- Modify: `.env.example`（追加短剧配置段）
- Modify: `package.json`（check 追加 `lib/drama/routes.mjs`）

**Interfaces:**
- Consumes: Task 1-5 全部；server.mjs 的 `envelope/sendJson/readJson/allowRequest`。
- Produces:
  - `handleDramaApi(request, response, url, ctx) → false | undefined`（false = 未命中，交给后续路由）
  - `ctx = { sendJson, envelope, readJson, allowRequest, store, llmDeps, comfyConfig, pricing }`
  - 路由表：
    - `GET /api/drama/demo` → `{ script }`（演示剧本）
    - `POST /api/drama/projects` `{ title, script, ratio? }` → 201 `{ project }`；script 50–20000 字符，否则 422 `DRAMA_SCRIPT_INVALID`
    - `GET /api/drama/projects` → `{ projects }`（摘要列表）
    - `GET /api/drama/projects/:id` → `{ project }`；404 `DRAMA_PROJECT_NOT_FOUND`
    - `PATCH /api/drama/projects/:id` `{ title?, script?, ratio? }`；script 变化且 status ≠ draft 时重置 analysis/shots/review/budget/gateAConfirmedAt 并回到 `draft`
    - `POST /api/drama/projects/:id/pipeline` `{ fromStage? }` → 202 `{ projectId, reused }`；fromStage 非法 422 `DRAMA_STAGE_INVALID`；项目状态仅允许 draft/failed/review_blocked/awaiting_gate_a 发起，否则 409 `DRAMA_STATUS_CONFLICT`
    - `PATCH /api/drama/projects/:id/shots/:shotId` `{ dialogue?, action?, camera?, durationSec?, emotion?, fluxPrompt?, negativePrompt? }`；仅 awaiting_gate_a/review_blocked/frames/awaiting_gate_b 可编辑；fluxPrompt/negativePrompt 变化 → 该镜 frame 重置为 pending；dialogue/durationSec 变化 → 重算预算，若已确认闸门 A 则作废确认并回到 `awaiting_gate_a`
    - `POST /api/drama/projects/:id/gate-a` `{ confirmCost: true }`；否则 409 `COST_CONFIRMATION_REQUIRED`；要求 status `awaiting_gate_a`，否则 409 `DRAMA_STATUS_CONFLICT`；成功置 `gateAConfirmedAt` + status `frames`
  - 所有写路由过 `allowRequest` 限流；projectId 必须匹配 `/^drama-[a-f0-9-]+$/`

- [ ] **Step 1: 实现 routes.mjs（本任务先不含首帧生成，Task 8 追加）**

```javascript
// lib/drama/routes.mjs
import { DRAMA_STAGES, SHOT_CAMERAS, DRAMA_RATIOS, createDramaProject, normalizeShot, DEMO_DRAMA_SCRIPT } from "./schema.mjs";
import { runDramaPipeline, isPipelineRunning } from "./pipeline.mjs";
import { estimateBudget } from "./budget.mjs";

const PROJECT_ID_PATTERN = /^drama-[a-f0-9-]+$/;
const EDITABLE_STATUSES = ["awaiting_gate_a", "review_blocked", "frames", "awaiting_gate_b"];
const PIPELINE_STARTABLE = ["draft", "failed", "review_blocked", "awaiting_gate_a"];

function parts(url) {
  return url.pathname.split("/").filter(Boolean);
}

export async function handleDramaApi(request, response, url, ctx) {
  const { sendJson, envelope, readJson, allowRequest, store } = ctx;
  const segments = parts(url);
  // segments: ["api", "drama", ...]
  if (segments[0] !== "api" || segments[1] !== "drama") return false;
  const requestId = crypto.randomUUID();

  if (request.method === "GET" && segments.length === 3 && segments[2] === "demo") {
    return sendJson(response, 200, envelope(true, { script: DEMO_DRAMA_SCRIPT }, { requestId }));
  }

  if (segments.length === 3 && segments[2] === "projects" && request.method === "GET") {
    return sendJson(response, 200, envelope(true, { projects: store.list() }, { requestId }));
  }

  if (segments.length === 3 && segments[2] === "projects" && request.method === "POST") {
    const ip = request.socket.remoteAddress || "local";
    if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
    let payload;
    try {
      payload = await readJson(request, 200_000);
    } catch (error) {
      return sendJson(response, 400, envelope(false, null, { requestId, errorCode: error.message, message: "请求内容无效" }));
    }
    const script = String(payload.script || "").trim();
    if (script.length < 50 || script.length > 20_000) {
      return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "DRAMA_SCRIPT_INVALID", message: "剧本需为 50–20000 个字符" }));
    }
    const project = createDramaProject({ title: payload.title, script, ratio: payload.ratio });
    store.save(project);
    return sendJson(response, 201, envelope(true, { project }, { requestId }));
  }

  const projectId = segments[3] || "";
  if (segments.length >= 4 && segments[2] === "projects") {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_PROJECT_NOT_FOUND", message: "项目不存在" }));
    }
    const project = store.get(projectId);
    if (!project) {
      return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_PROJECT_NOT_FOUND", message: "项目不存在" }));
    }

    if (segments.length === 4 && request.method === "GET") {
      return sendJson(response, 200, envelope(true, { project }, { requestId }));
    }

    if (segments.length === 4 && request.method === "PATCH") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      let payload;
      try {
        payload = await readJson(request, 200_000);
      } catch (error) {
        return sendJson(response, 400, envelope(false, null, { requestId, errorCode: error.message, message: "请求内容无效" }));
      }
      const updated = store.update(projectId, (p) => {
        if (typeof payload.title === "string") p.title = payload.title.trim().slice(0, 80) || p.title;
        if (typeof payload.ratio === "string" && DRAMA_RATIOS.includes(payload.ratio)) p.ratio = payload.ratio;
        if (typeof payload.script === "string") {
          const script = payload.script.trim();
          if (script.length < 50 || script.length > 20_000) {
            throw Object.assign(new Error("剧本需为 50–20000 个字符"), { code: "DRAMA_SCRIPT_INVALID" });
          }
          if (script !== p.script && p.status !== "draft") {
            // 剧本变更使全部分析产物作废，回到草稿
            p.script = script;
            p.analysis = null;
            p.shots = [];
            p.review = null;
            p.budget = null;
            p.gateAConfirmedAt = null;
            p.pipeline = { stage: null, error: null, updatedAt: null };
            p.status = "draft";
          } else {
            p.script = script;
          }
        }
      });
      return sendJson(response, 200, envelope(true, { project: updated }, { requestId }));
    }

    if (segments.length === 5 && segments[4] === "pipeline" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      let payload = {};
      try {
        payload = await readJson(request, 10_000);
      } catch {
        return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" }));
      }
      const fromStage = payload.fromStage ?? (project.pipeline?.error?.stage || "analyze");
      if (!DRAMA_STAGES.includes(fromStage)) {
        return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "DRAMA_STAGE_INVALID", message: "无效的流水线阶段" }));
      }
      if (!PIPELINE_STARTABLE.includes(project.status)) {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "DRAMA_STATUS_CONFLICT", message: `当前状态（${project.status}）不能发起流水线` }));
      }
      if (isPipelineRunning(projectId)) {
        return sendJson(response, 200, envelope(true, { projectId, reused: true }, { requestId }));
      }
      // 与 generateSeedanceVideo 同模式：异步执行，客户端轮询项目状态
      runDramaPipeline(store, projectId, { fromStage, deps: ctx.llmDeps, pricing: ctx.pricing }).catch(() => {});
      return sendJson(response, 202, envelope(true, { projectId, reused: false }, { requestId }));
    }

    if (segments.length === 5 && segments[4] === "gate-a" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      let payload = {};
      try {
        payload = await readJson(request, 10_000);
      } catch {
        return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" }));
      }
      if (payload.confirmCost !== true) {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "COST_CONFIRMATION_REQUIRED", message: "进入首帧生成前需要确认预算" }));
      }
      if (project.status !== "awaiting_gate_a") {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "DRAMA_STATUS_CONFLICT", message: "当前状态不能确认预算闸门" }));
      }
      const updated = store.update(projectId, (p) => {
        p.budget = estimateBudget(p, ctx.pricing); // 确认时以最新分镜重算
        p.gateAConfirmedAt = new Date().toISOString();
        p.status = "frames";
      });
      return sendJson(response, 200, envelope(true, { project: updated }, { requestId }));
    }

    if (segments.length === 6 && segments[4] === "shots" && request.method === "PATCH") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      if (!EDITABLE_STATUSES.includes(project.status)) {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "DRAMA_STATUS_CONFLICT", message: "当前状态不能编辑分镜" }));
      }
      let payload;
      try {
        payload = await readJson(request, 40_000);
      } catch (error) {
        return sendJson(response, 400, envelope(false, null, { requestId, errorCode: error.message, message: "请求内容无效" }));
      }
      let found = false;
      const updated = store.update(projectId, (p) => {
        const index = p.shots.findIndex((s) => s.id === segments[5]);
        if (index === -1) return;
        found = true;
        const shot = p.shots[index];
        const promptChanged = (typeof payload.fluxPrompt === "string" && payload.fluxPrompt !== shot.fluxPrompt)
          || (typeof payload.negativePrompt === "string" && payload.negativePrompt !== shot.negativePrompt);
        const budgetChanged = (typeof payload.dialogue === "string" && payload.dialogue !== shot.dialogue)
          || (payload.durationSec !== undefined && Number(payload.durationSec) !== shot.durationSec);
        const merged = normalizeShot({ ...shot, ...payload }, index);
        if (promptChanged) {
          merged.frame = { status: "pending", file: null, seed: null, attempts: shot.frame.attempts, error: null };
          if (p.status === "awaiting_gate_b" || p.status === "frames_confirmed") p.status = "frames";
        }
        p.shots[index] = merged;
        if (budgetChanged) {
          p.budget = estimateBudget(p, ctx.pricing);
          if (p.gateAConfirmedAt) {
            // 台词/时长变了预算就变了，费用确认必须重做
            p.gateAConfirmedAt = null;
            p.status = "awaiting_gate_a";
          }
        }
      });
      if (!found) {
        return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_SHOT_NOT_FOUND", message: "分镜不存在" }));
      }
      return sendJson(response, 200, envelope(true, { project: updated }, { requestId }));
    }
  }

  return false;
}
```

注意：`crypto.randomUUID()` 在 Node 20 全局可用（server.mjs 顶部已从 `node:crypto` import `randomUUID`，routes.mjs 直接用全局 `crypto` 即可；若想保持一致，可在文件顶部 `import { randomUUID } from "node:crypto";` 并替换 `crypto.randomUUID()` 为 `randomUUID()`——采用后者）。

在 routes.mjs 顶部加：
```javascript
import { randomUUID } from "node:crypto";
```
并把 `const requestId = crypto.randomUUID();` 改为 `const requestId = randomUUID();`。

- [ ] **Step 2: 挂载到 server.mjs**

编辑 1 — 顶部 import 区（第 7 行 `import { createServer } from "node:http";` 之后）：

```javascript
import { createDramaStore } from "./lib/drama/store.mjs";
import { handleDramaApi } from "./lib/drama/routes.mjs";
import { getDramaLlmConfig, dramaLlmStatus } from "./lib/drama/llm.mjs";
import { getComfyuiConfig, getComfyuiStatus } from "./lib/drama/comfyui.mjs";
import { getDramaPricing } from "./lib/drama/budget.mjs";
```

注意：`lib/drama/comfyui.mjs` 在 Task 7 才创建——本任务先注释掉 comfyui 相关 import 与使用，或先建一个只含 `getComfyuiConfig/getComfyuiStatus` 的占位实现。**执行约定：Task 7 的 comfyui.mjs 提前创建（只做该文件的两个函数），本任务直接 import。** 顺序：Task 7 Step 3 的 comfyui.mjs 完整实现可以后置，但文件与这两个导出必须先存在。

编辑 2 — 常量区（第 38 行 `mkdirSync(seedanceRunRoot, { recursive: true });` 之后）：

```javascript
const dramaStore = createDramaStore(dataRoot);
const dramaLlmConfig = getDramaLlmConfig();
const comfyuiConfig = getComfyuiConfig();
const dramaPricing = getDramaPricing();
```

编辑 3 — `providerHealth()` 返回对象（在 `voicebox: await voiceboxHealth()` 之后追加两个键）：

```javascript
    voicebox: await voiceboxHealth(),
    dramaLlm: await dramaLlmStatus(dramaLlmConfig),
    comfyui: await getComfyuiStatus(comfyuiConfig)
```

编辑 4 — `integrationContract(providers)` 的 `integrations` 数组末尾（`local-cloned-voice` 条目之后）追加：

```javascript
      {
        id: "drama-llm",
        name: "短剧编排模型",
        provider: "OpenAI 兼容端点",
        requirement: "optional",
        requirementLabel: "可选",
        configured: Boolean(providers.dramaLlm?.configured),
        connected: Boolean(providers.dramaLlm?.connected),
        configKeys: ["DRAMA_LLM_BASE_URL", "DRAMA_LLM_MODEL", "DRAMA_LLM_API_KEY"],
        optionalConfigKeys: ["DRAMA_LLM_MOCK", "DRAMA_LLM_TIMEOUT_MS"],
        description: "驱动剧本分析、导演分镜、提示词与审核四个阶段；不配置时使用本机演示编排，不产生费用。"
      },
      {
        id: "comfyui-local",
        name: "短剧首帧生成",
        provider: "ComfyUI (Flux)",
        requirement: "optional",
        requirementLabel: "可选",
        configured: Boolean(providers.comfyui?.configured),
        connected: Boolean(providers.comfyui?.connected),
        configKeys: ["COMFYUI_URL"],
        optionalConfigKeys: ["COMFYUI_FLUX_UNET", "COMFYUI_CLIP1", "COMFYUI_CLIP2", "COMFYUI_VAE", "COMFYUI_FLUX_STEPS"],
        description: "连接你本机的 ComfyUI 服务，用 Flux 为每个分镜生成首帧；本机算力不产生 API 费用。"
      }
```

编辑 5 — `integrationContract` 的 `appApi` 数组末尾追加：

```javascript
      { method: "POST", path: "/api/drama/projects", purpose: "创建短剧项目" },
      { method: "GET", path: "/api/drama/projects/{id}", purpose: "查询短剧项目与流水线状态" },
      { method: "POST", path: "/api/drama/projects/{id}/pipeline", purpose: "发起或续跑编排流水线" },
      { method: "POST", path: "/api/drama/projects/{id}/gate-a", purpose: "确认短剧预算闸门" },
      { method: "POST", path: "/api/drama/projects/{id}/shots/{shotId}/frame", purpose: "生成或换抽分镜首帧" }
```

编辑 6 — `handleApi` 末尾（第 1096 行 `return false;` 之前）：

```javascript
  if (url.pathname.startsWith("/api/drama/")) {
    return handleDramaApi(request, response, url, {
      sendJson,
      envelope,
      readJson,
      allowRequest,
      store: dramaStore,
      llmDeps: { config: dramaLlmConfig },
      comfyConfig: comfyuiConfig,
      pricing: dramaPricing
    });
  }
```

- [ ] **Step 3: 更新 .env.example**

追加：

```bash
# 短剧工作台：编排 LLM（OpenAI 兼容端点；不配置则使用本机演示编排）
DRAMA_LLM_BASE_URL=
DRAMA_LLM_MODEL=
DRAMA_LLM_API_KEY=
# 短剧工作台：本机 ComfyUI（Flux 首帧生成）
COMFYUI_URL=
# 短剧预算单价校准（人民币，预估）
DRAMA_PRICE_SEEDANCE_PER_SHOT=6
DRAMA_PRICE_H3_PER_SECOND=0.5
DRAMA_PRICE_TTS_PER_KCHAR=2
```

- [ ] **Step 4: 更新 package.json check 并手动验证**

check 追加 `&& node --check lib/drama/routes.mjs`。

验证（comfyui.mjs 的两个函数已按上面执行约定就位后）：

```bash
npm run check && node --test tests/
PORT=4399 node server.mjs &
curl -s -X POST http://127.0.0.1:4399/api/drama/projects -H 'Content-Type: application/json' \
  -d '{"title":"手动验证","script":"雨夜，林晚抱着纸箱站在便利店门口躲雨。陈默把伞塞进她手里转身冲进雨里。林晚发现伞柄上的挂失回执写着一个陌生又熟悉的名字，她追出去却已看不到人影。"}'
# 记录返回的 project.id
curl -s -X POST http://127.0.0.1:4399/api/drama/projects/<id>/pipeline -H 'Content-Type: application/json' -d '{}'
sleep 2
curl -s http://127.0.0.1:4399/api/drama/projects/<id> | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d).data.project;console.log(p.status, p.shots.length, p.budget.totalPaid)})"
# 期望输出：awaiting_gate_a <镜数> <预算>
curl -s -X POST http://127.0.0.1:4399/api/drama/projects/<id>/gate-a -H 'Content-Type: application/json' -d '{}'
# 期望：409 COST_CONFIRMATION_REQUIRED
kill %1
```

Expected: 状态机推进与费用闸门行为如注释所示。

- [ ] **Step 5: Commit**

```bash
git add lib/drama/routes.mjs server.mjs .env.example package.json
git commit -m "feat: 新增短剧项目/流水线/预算闸门 API 并挂载到本地服务"
```

---

### Task 7: ComfyUI 适配器

**Files:**
- Create: `lib/drama/comfyui.mjs`
- Test: `tests/drama-comfyui.test.mjs`
- Modify: `package.json`（check 追加 `lib/drama/comfyui.mjs`）

**Interfaces:**
- Consumes: 无（独立 HTTP 适配器）。
- Produces:
  - `getComfyuiConfig(env = process.env) → { baseUrl, unet, clip1, clip2, vae, steps, timeoutMs, pollIntervalMs }`
  - `FRAME_SIZES = { portrait: [768,1344], landscape: [1344,768], square: [1024,1024] }`
  - `buildFluxWorkflow({ prompt, negativePrompt, width, height, seed, config }) → workflow 对象`（纯函数，ComfyUI API 格式）
  - `getComfyuiStatus(config, fetchImpl = fetch) → Promise<{ configured, connected, state }>`
  - `generateFluxFrame({ config, prompt, negativePrompt, width, height, seed, fetchImpl, sleep, clientId }) → Promise<Buffer>`
    - 错误码：`COMFYUI_UNAVAILABLE`（未配置）、`COMFYUI_SUBMIT_FAILED`、`COMFYUI_TIMEOUT`（retryable）、`COMFYUI_OUTPUT_MISSING`

- [ ] **Step 1: 写失败的测试**

```javascript
// tests/drama-comfyui.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { getComfyuiConfig, buildFluxWorkflow, generateFluxFrame, getComfyuiStatus, FRAME_SIZES } from "../lib/drama/comfyui.mjs";

const config = getComfyuiConfig({ COMFYUI_URL: "http://127.0.0.1:8188" });

test("buildFluxWorkflow 注入提示词/尺寸/种子且结构合法", () => {
  const workflow = buildFluxWorkflow({ prompt: "a rainy night", negativePrompt: "blur", width: 768, height: 1344, seed: 1234, config });
  assert.equal(workflow["6"].inputs.text, "a rainy night");
  assert.equal(workflow["7"].inputs.text, "blur");
  assert.equal(workflow["5"].inputs.width, 768);
  assert.equal(workflow["5"].inputs.height, 1344);
  assert.equal(workflow["3"].inputs.seed, 1234);
  assert.equal(workflow["3"].class_type, "KSampler");
  assert.equal(workflow["13"].class_type, "SaveImage");
  // 引用完整性：每个数组引用都指向存在的节点
  for (const node of Object.values(workflow)) {
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value)) assert.ok(workflow[value[0]], `missing node ${value[0]}`);
    }
  }
});

test("generateFluxFrame 走完 提交→轮询→取图 全流程", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push(`${options.method || "GET"} ${url}`);
    if (url.endsWith("/prompt")) {
      return { ok: true, json: async () => ({ prompt_id: "pid-1" }) };
    }
    if (url.includes("/history/pid-1")) {
      return { ok: true, json: async () => ({ "pid-1": { outputs: { "13": { images: [{ filename: "drama_00001_.png", subfolder: "", type: "output" }] } } } }) };
    }
    if (url.includes("/view")) {
      return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }
    throw new Error(`unexpected ${url}`);
  };
  const bytes = await generateFluxFrame({
    config, prompt: "p", negativePrompt: "n", width: 768, height: 1344, seed: 1,
    fetchImpl, sleep: async () => {}, clientId: "test-client"
  });
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.ok(calls[0].startsWith("POST"));
  assert.ok(calls.some((c) => c.includes("/history/")));
  assert.ok(calls.some((c) => c.includes("/view")));
});

test("轮询超时抛 COMFYUI_TIMEOUT", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/prompt")) return { ok: true, json: async () => ({ prompt_id: "pid-2" }) };
    if (url.includes("/history/")) return { ok: true, json: async () => ({}) };
    throw new Error("unexpected");
  };
  const fastConfig = { ...config, timeoutMs: 5, pollIntervalMs: 1 };
  await assert.rejects(
    generateFluxFrame({ config: fastConfig, prompt: "p", negativePrompt: "", width: 1, height: 1, seed: 1, fetchImpl, sleep: async () => {}, clientId: "t" }),
    (error) => error.code === "COMFYUI_TIMEOUT" && error.retryable === true
  );
});

test("未配置时不发请求直接报 COMFYUI_UNAVAILABLE；状态检查保持纯净环境不变量", async () => {
  const empty = getComfyuiConfig({});
  assert.equal(empty.baseUrl, "");
  await assert.rejects(
    generateFluxFrame({ config: empty, prompt: "p", negativePrompt: "", width: 1, height: 1, seed: 1 }),
    (error) => error.code === "COMFYUI_UNAVAILABLE"
  );
  const status = await getComfyuiStatus(empty);
  assert.deepEqual(status, { configured: false, connected: false, state: "missing" });
});

test("画幅尺寸表覆盖三种比例", () => {
  assert.deepEqual(FRAME_SIZES.portrait, [768, 1344]);
  assert.deepEqual(FRAME_SIZES.landscape, [1344, 768]);
  assert.deepEqual(FRAME_SIZES.square, [1024, 1024]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/drama-comfyui.test.mjs`
Expected: FAIL，报 `Cannot find module '../lib/drama/comfyui.mjs'`

- [ ] **Step 3: 实现 comfyui.mjs**

```javascript
// lib/drama/comfyui.mjs
// 本机 ComfyUI HTTP 适配器：Flux txt2img 首帧生成（提交 → 轮询 history → 下载图片）
export function getComfyuiConfig(env = process.env) {
  return {
    baseUrl: String(env.COMFYUI_URL || "").replace(/\/+$/, ""),
    unet: env.COMFYUI_FLUX_UNET || "flux1-schnell-fp8.safetensors",
    clip1: env.COMFYUI_CLIP1 || "clip_l.safetensors",
    clip2: env.COMFYUI_CLIP2 || "t5xxl_fp8_e4m3fn.safetensors",
    vae: env.COMFYUI_VAE || "ae.safetensors",
    steps: Number(env.COMFYUI_FLUX_STEPS) || 4,
    timeoutMs: Number(env.COMFYUI_TIMEOUT_MS) || 300_000,
    pollIntervalMs: Number(env.COMFYUI_POLL_INTERVAL_MS) || 1500
  };
}

export const FRAME_SIZES = {
  portrait: [768, 1344],
  landscape: [1344, 768],
  square: [1024, 1024]
};

export function buildFluxWorkflow({ prompt, negativePrompt = "", width, height, seed, config }) {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed, steps: config.steps, cfg: 1.0,
        sampler_name: "euler", scheduler: "simple", denoise: 1.0,
        model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0]
      }
    },
    "4": { class_type: "UNETLoader", inputs: { unet_name: config.unet, weight_dtype: "fp8_e4m3fn" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["11", 0] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: negativePrompt, clip: ["11", 0] } },
    "10": { class_type: "VAELoader", inputs: { vae_name: config.vae } },
    "11": { class_type: "DualCLIPLoader", inputs: { clip_name1: config.clip1, clip_name2: config.clip2, type: "flux" } },
    "12": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["10", 0] } },
    "13": { class_type: "SaveImage", inputs: { filename_prefix: "drama", images: ["12", 0] } }
  };
}

export async function getComfyuiStatus(config = getComfyuiConfig(), fetchImpl = fetch) {
  if (!config.baseUrl) return { configured: false, connected: false, state: "missing" };
  try {
    const response = await fetchImpl(`${config.baseUrl}/system_stats`, { signal: AbortSignal.timeout(3000) });
    return { configured: true, connected: response.ok, state: response.ok ? "connected" : `http_${response.status}` };
  } catch {
    return { configured: true, connected: false, state: "unreachable" };
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function generateFluxFrame({ config, prompt, negativePrompt = "", width, height, seed, fetchImpl = fetch, sleep = defaultSleep, clientId = "drama-studio" }) {
  if (!config?.baseUrl) {
    throw Object.assign(new Error("未配置本机 ComfyUI 地址（COMFYUI_URL）"), { code: "COMFYUI_UNAVAILABLE" });
  }
  const workflow = buildFluxWorkflow({ prompt, negativePrompt, width, height, seed, config });
  const submit = await fetchImpl(`${config.baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ prompt: workflow, client_id: clientId })
  });
  if (!submit.ok) {
    throw Object.assign(new Error(`ComfyUI 提交失败 (${submit.status})`), { code: "COMFYUI_SUBMIT_FAILED" });
  }
  const submitted = await submit.json();
  const promptId = submitted?.prompt_id;
  if (!promptId) {
    throw Object.assign(new Error("ComfyUI 未返回 prompt_id"), { code: "COMFYUI_SUBMIT_FAILED" });
  }

  const deadline = Date.now() + config.timeoutMs;
  let images = null;
  while (Date.now() < deadline) {
    await sleep(config.pollIntervalMs);
    let history;
    try {
      const response = await fetchImpl(`${config.baseUrl}/history/${promptId}`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) continue;
      history = await response.json();
    } catch {
      continue; // 轮询抖动不致命，继续等
    }
    const entry = history?.[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      throw Object.assign(new Error("ComfyUI 执行工作流失败"), { code: "COMFYUI_EXECUTION_FAILED" });
    }
    images = entry.outputs?.["13"]?.images;
    if (images?.length) break;
  }
  if (!images?.length) {
    throw Object.assign(new Error("等待 ComfyUI 首帧超时"), { code: "COMFYUI_TIMEOUT", retryable: true });
  }

  const image = images[0];
  const viewUrl = `${config.baseUrl}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder || "")}&type=${encodeURIComponent(image.type || "output")}`;
  const file = await fetchImpl(viewUrl, { signal: AbortSignal.timeout(60_000) });
  if (!file.ok) {
    throw Object.assign(new Error(`ComfyUI 取图失败 (${file.status})`), { code: "COMFYUI_OUTPUT_MISSING" });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!bytes.length) {
    throw Object.assign(new Error("ComfyUI 返回空图片"), { code: "COMFYUI_OUTPUT_MISSING" });
  }
  return bytes;
}
```

- [ ] **Step 4: 更新 package.json check 并运行测试**

check 追加 `&& node --check lib/drama/comfyui.mjs`。

Run: `node --test tests/ && npm run check`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/comfyui.mjs tests/drama-comfyui.test.mjs package.json
git commit -m "feat: 新增 ComfyUI Flux 首帧生成适配器"
```

---

### Task 8: 首帧生成路由与闸门 B

**Files:**
- Modify: `lib/drama/routes.mjs`（追加首帧生成、首帧确认两条路由 + 异步执行器）
- Modify: `server.mjs`（`serveStatic` 追加 `/drama-files/` 分支）
- Test: `tests/drama-routes-frames.test.mjs`（生成器状态机单测：直接测 `generateShotFrame` 注入 fake fetch）

**Interfaces:**
- Consumes: Task 6 routes 骨架、Task 7 `generateFluxFrame / FRAME_SIZES / getComfyuiStatus`。
- Produces:
  - `POST /api/drama/projects/:id/shots/:shotId/frame` `{ seed? }` → 202 `{ shotId, status: "generating" }`
    - 前置：`gateAConfirmedAt` 必须存在，否则 409 `GATE_A_REQUIRED`；frame.status 为 `generating` 时 409 `FRAME_BUSY`；ComfyUI 未连接 503 `COMFYUI_UNAVAILABLE`
  - `POST /api/drama/projects/:id/shots/:shotId/confirm` → `{ project }`；frame.status 必须 `ready`，否则 409 `FRAME_NOT_READY`；全部 confirmed → 项目 `frames_confirmed`
  - `generateShotFrame(ctx, projectId, shotId, seed)`（routes.mjs 内部异步函数，导出供单测）
    - 成功：`frame = { status: "ready", file, seed, attempts+1 }`；所有镜 ready/confirmed → 项目 `awaiting_gate_b`
    - 失败：`frame.status = "failed"` + error；**不自动重试**
  - `GET /drama-files/{projectId}/{filename}`（server.mjs 静态分支，仅 png/jpg/webp，路径防穿越）

- [ ] **Step 1: 写失败的测试**

```javascript
// tests/drama-routes-frames.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject, normalizeShot, DEMO_DRAMA_SCRIPT } from "../lib/drama/schema.mjs";
import { getDramaLlmConfig } from "../lib/drama/llm.mjs";
import { runDramaPipeline } from "../lib/drama/pipeline.mjs";
import { generateShotFrame } from "../lib/drama/routes.mjs";
import { getComfyuiConfig } from "../lib/drama/comfyui.mjs";
import { getDramaPricing } from "../lib/drama/budget.mjs";

async function fixtureProject(root) {
  const store = createDramaStore(root);
  const project = store.save(createDramaProject({ title: "首帧测试", script: DEMO_DRAMA_SCRIPT }));
  await runDramaPipeline(store, project.id, { deps: { config: getDramaLlmConfig({ DRAMA_LLM_MOCK: "1" }) } });
  store.update(project.id, (p) => { p.gateAConfirmedAt = new Date().toISOString(); p.status = "frames"; });
  return { store, project: store.get(project.id) };
}

function fakeComfyFetch(tag) {
  return async (url, options = {}) => {
    if (url.endsWith("/prompt")) return { ok: true, json: async () => ({ prompt_id: `pid-${tag}` }) };
    if (url.includes("/history/")) {
      return { ok: true, json: async () => ({ [`pid-${tag}`]: { outputs: { "13": { images: [{ filename: `f_${tag}.png`, subfolder: "", type: "output" }] } } } }) };
    }
    if (url.includes("/view")) return { ok: true, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer };
    throw new Error(`unexpected ${url}`);
  };
}

test("首帧生成成功后落盘并推进项目到 awaiting_gate_b", async () => {
  const root = mkdtempSync(join(tmpdir(), "drama-frames-test-"));
  try {
    const { store, project } = await fixtureProject(root);
    const shot = project.shots[0];
    const ctx = {
      store,
      comfyConfig: { ...getComfyuiConfig({ COMFYUI_URL: "http://127.0.0.1:8188" }), pollIntervalMs: 1 },
      frameFetch: fakeComfyFetch("a"),
      frameSleep: async () => {}
    };
    await generateShotFrame(ctx, project.id, shot.id, 777);
    const updated = store.get(project.id);
    const frame = updated.shots[0].frame;
    assert.equal(frame.status, "ready");
    assert.equal(frame.seed, 777);
    assert.equal(frame.attempts, 1);
    assert.ok(existsSync(join(store.dir(project.id), "frames", frame.file)));
    // 其余镜还是 pending，项目停留在 frames
    assert.equal(updated.status, "frames");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("首帧生成失败记录错误且不自动重试", async () => {
  const root = mkdtempSync(join(tmpdir(), "drama-frames-fail-"));
  try {
    const { store, project } = await fixtureProject(root);
    const shot = project.shots[0];
    const ctx = {
      store,
      comfyConfig: getComfyuiConfig({ COMFYUI_URL: "http://127.0.0.1:8188" }),
      frameFetch: async () => { throw new Error("boom"); },
      frameSleep: async () => {}
    };
    await generateShotFrame(ctx, project.id, shot.id, 1);
    const frame = store.get(project.id).shots[0].frame;
    assert.equal(frame.status, "failed");
    assert.equal(frame.error.code, "COMFYUI_SUBMIT_FAILED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/drama-routes-frames.test.mjs`
Expected: FAIL，`generateShotFrame is not exported`

- [ ] **Step 3: 在 routes.mjs 追加首帧逻辑**

顶部 import 追加：

```javascript
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateFluxFrame, getComfyuiStatus, FRAME_SIZES } from "./comfyui.mjs";
```

在 `handleDramaApi` 之前追加异步执行器（导出供单测）：

```javascript
// 首帧生成执行器：与 generateSeedanceVideo 同模式，直接更新项目内分镜状态
export async function generateShotFrame(ctx, projectId, shotId, seed) {
  const { store, comfyConfig } = ctx;
  const fetchImpl = ctx.frameFetch || fetch;
  const sleep = ctx.frameSleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const setFrame = (patch) => store.update(projectId, (p) => {
    const shot = p.shots.find((s) => s.id === shotId);
    if (!shot) return;
    shot.frame = { ...shot.frame, ...patch };
    if (p.shots.every((s) => s.frame.status === "confirmed")) {
      p.status = "frames_confirmed";
    } else if (p.shots.every((s) => ["ready", "confirmed"].includes(s.frame.status))) {
      p.status = "awaiting_gate_b";
    }
  });
  const project = store.get(projectId);
  const shot = project?.shots.find((s) => s.id === shotId);
  if (!shot) return;
  const finalSeed = Number.isInteger(seed) ? seed : (shot.index * 100_000 + shot.frame.attempts * 7919) % 2 ** 31;
  try {
    setFrame({ status: "generating", error: null });
    const [width, height] = FRAME_SIZES[project.ratio] || FRAME_SIZES.portrait;
    const bytes = await generateFluxFrame({
      config: comfyConfig,
      prompt: shot.fluxPrompt,
      negativePrompt: shot.negativePrompt,
      width, height,
      seed: finalSeed,
      fetchImpl,
      sleep,
      clientId: projectId
    });
    const fileName = `${shotId}-${finalSeed}.png`;
    writeFileSync(join(store.dir(projectId), "frames", fileName), bytes);
    setFrame({ status: "ready", file: fileName, seed: finalSeed, attempts: shot.frame.attempts + 1, error: null });
  } catch (error) {
    // 不自动重试：失败态落盘，由用户决定是否换抽
    setFrame({
      status: "failed",
      error: { code: error.code || "FRAME_FAILED", message: String(error.message || "").slice(0, 300) }
    });
  }
}
```

在 `handleDramaApi` 内、`return false;` 之前（即 Task 6 的 shots PATCH 分支之后）追加两个分支：

```javascript
    if (segments.length === 7 && segments[4] === "shots" && segments[6] === "frame" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      const shot = project.shots.find((s) => s.id === segments[5]);
      if (!shot) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_SHOT_NOT_FOUND", message: "分镜不存在" }));
      if (!project.gateAConfirmedAt) {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "GATE_A_REQUIRED", message: "请先确认预算闸门，再生成首帧" }));
      }
      if (shot.frame.status === "generating") {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "FRAME_BUSY", message: "该分镜正在生成首帧" }));
      }
      let payload = {};
      try {
        payload = await readJson(request, 10_000);
      } catch {
        return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" }));
      }
      const comfyui = await getComfyuiStatus(ctx.comfyConfig);
      if (!comfyui.connected) {
        return sendJson(response, 503, envelope(false, null, { requestId, errorCode: "COMFYUI_UNAVAILABLE", message: "未连接本机 ComfyUI 服务，请先配置 COMFYUI_URL" }));
      }
      const seed = Number.isInteger(payload.seed) ? payload.seed : null;
      generateShotFrame(ctx, projectId, shot.id, seed).catch(() => {});
      return sendJson(response, 202, envelope(true, { shotId: shot.id, status: "generating" }, { requestId }));
    }

    if (segments.length === 7 && segments[4] === "shots" && segments[6] === "confirm" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      const shot = project.shots.find((s) => s.id === segments[5]);
      if (!shot) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_SHOT_NOT_FOUND", message: "分镜不存在" }));
      if (shot.frame.status !== "ready") {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "FRAME_NOT_READY", message: "首帧尚未生成完成" }));
      }
      const updated = store.update(projectId, (p) => {
        const target = p.shots.find((s) => s.id === shot.id);
        target.frame = { ...target.frame, status: "confirmed" };
        if (p.shots.every((s) => s.frame.status === "confirmed")) p.status = "frames_confirmed";
      });
      return sendJson(response, 200, envelope(true, { project: updated }, { requestId }));
    }
```

- [ ] **Step 4: server.mjs 追加 /drama-files/ 静态分支**

在 `serveStatic` 的 `/uploads/` 分支之后（约第 1129 行后）插入：

```javascript
  const dramaFileMatch = pathname.match(/^\/drama-files\/(drama-[a-f0-9-]+)\/([a-z0-9-]+\.(png|jpg|webp))$/i);
  if (dramaFileMatch) {
    const filePath = join(dramaStore.dir(dramaFileMatch[1]), "frames", dramaFileMatch[2]);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
    response.writeHead(200, {
      "Cache-Control": "private, max-age=3600",
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream"
    });
    createReadStream(filePath).pipe(response);
    return true;
  }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test tests/ && npm run check`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add lib/drama/routes.mjs server.mjs tests/drama-routes-frames.test.mjs
git commit -m "feat: 新增分镜首帧生成/确认与闸门 B 路由"
```

---

### Task 9: 短剧工作台 UI

**Files:**
- Create: `public/drama.html`
- Create: `public/drama.js`
- Modify: `public/styles.css`（追加，不改既有规则）
- Modify: `public/index.html`（侧边栏加入口链接，一行）
- Modify: `package.json`（check 追加 `public/drama.js`——若 Task 1 的临时 check 未含它，本任务补上）

**Interfaces:**
- Consumes: Task 6/8 全部 API；`/api/health`（providers.dramaLlm / providers.comfyui）；`/drama-files/` 静态图。
- Produces: 无代码接口（页面）。行为契约：
  - 项目选择/新建 → 剧本编辑 → 「开始解析」→ 四阶段进度 → 分镜表编辑 → 预算弹窗确认（闸门 A）→ 逐镜生成/换抽首帧 → 确认首帧（闸门 B）→ 全部确认后显示 MVP 完成态
  - LLM 为 mock 时顶部显示"演示编排模式"标识
  - 轮询策略：项目处于 `analyzing/directing/prompting/reviewing` 或任一 frame 为 `generating` 时每 800ms 拉取一次项目

- [ ] **Step 1: 创建 public/drama.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>短剧工作台 · Digital Human Studio</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body class="drama-body">
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">剧</span>
        <div><small>Digital Human Studio</small><b>短剧工作台</b></div>
      </div>
      <nav class="steps" aria-label="短剧流程">
        <button class="step" data-anchor="scriptCard"><i>1</i><span><b>剧本</b><small>输入与解析</small></span></button>
        <button class="step" data-anchor="shotsPanel"><i>2</i><span><b>分镜表</b><small>导演决策结果</small></span><em id="shotCountBadge">—</em></button>
        <button class="step" data-anchor="budgetPanel"><i>3</i><span><b>预算与首帧</b><small>两道确认闸门</small></span></button>
      </nav>
      <div class="side-links">
        <a class="side-link" href="/"><span>⌂</span>返回口播工作台</a>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div class="providers">
          <button class="provider" id="llmStatus"><span class="provider-logo">LL</span><b>编排模型</b><i></i><small>检查中</small></button>
          <button class="provider" id="comfyStatus"><span class="provider-logo">C</span><b>ComfyUI</b><i></i><small>检查中</small></button>
        </div>
        <div class="top-actions">
          <select id="projectSelect" class="project-select"></select>
          <button class="ghost" id="newProjectBtn">新建项目</button>
          <button class="ghost" id="demoBtn">演示剧本</button>
          <button class="primary" id="runPipelineBtn">开始解析</button>
        </div>
      </header>

      <div class="banner hidden" id="mockBanner">演示编排模式：未配置 DRAMA_LLM_*，当前由本机确定性 mock 驱动，不产生任何费用。</div>
      <div class="banner error hidden" id="errorBanner"></div>

      <div class="drama-grid">
        <section class="editor-column">
          <section class="script-card" id="scriptCard">
            <div class="card-head"><span class="eyebrow">SCRIPT</span><h2>剧本</h2></div>
            <input id="dramaTitle" class="title-input" maxlength="80" placeholder="短剧标题" />
            <textarea id="dramaScript" spellcheck="false" placeholder="粘贴或输入短剧剧本（50–20000 字）…"></textarea>
            <div class="card-foot"><span id="dramaCharCount">0 字</span><span id="projectStatus">未开始</span></div>
          </section>

          <section class="pipeline-card">
            <div class="card-head"><span class="eyebrow">PIPELINE</span><h2>编排流水线</h2></div>
            <ol class="stage-list" id="stageList">
              <li data-stage="analyze"><b>剧本分析</b><small>角色 / 场景 / 梗概</small><em></em></li>
              <li data-stage="direct"><b>导演分镜</b><small>镜头类型与运镜</small><em></em></li>
              <li data-stage="prompt"><b>提示词</b><small>Flux 首帧提示词</small><em></em></li>
              <li data-stage="review"><b>文本审核</b><small>安全与结构</small><em></em></li>
            </ol>
            <button class="ghost hidden" id="resumeBtn">从失败阶段续跑</button>
          </section>

          <section class="character-card">
            <div class="card-head"><span class="eyebrow">CAST</span><h2>角色资产卡</h2></div>
            <div id="characterList" class="character-list"><p class="muted">解析后生成</p></div>
          </section>
        </section>

        <section class="shots-column" id="shotsPanel">
          <div class="section-head"><div><span class="eyebrow">STORYBOARD</span><h2>分镜表</h2></div>
            <button class="mini-btn hidden" id="genAllFramesBtn">生成全部首帧</button>
          </div>
          <div id="shotList" class="shot-list"><p class="muted">运行流水线后展示分镜</p></div>
        </section>

        <aside class="settings-column" id="budgetPanel">
          <section class="budget-card">
            <div class="card-head"><span class="eyebrow">BUDGET</span><h2>预算单（预估）</h2></div>
            <div id="budgetLines" class="budget-lines"><p class="muted">流水线完成后生成</p></div>
            <div class="budget-total"><span>预计付费合计</span><b id="budgetTotal">—</b></div>
            <button class="primary hidden" id="gateABtn">确认预算，进入首帧生成</button>
            <p class="fine-print">首帧使用本机算力（¥0）。视频与配音单价为预估值，可在 .env 中校准，实际以供应商扣费为准。</p>
          </section>
          <section class="gate-card">
            <div class="card-head"><span class="eyebrow">GATE B</span><h2>首帧确认</h2></div>
            <div class="gate-progress"><div class="progress"><i id="gateBProgress"></i></div><span id="gateBText">0 / 0</span></div>
            <div class="banner success hidden" id="doneBanner">首帧全部确认，MVP 流程完成。视频生成与合成属于后续里程碑。</div>
          </section>
        </aside>
      </div>
    </main>
  </div>

  <div class="modal" id="gateAModal" aria-hidden="true">
    <div class="modal-card">
      <h3>确认短剧预算</h3>
      <div id="modalBudgetLines" class="budget-lines"></div>
      <div class="budget-total"><span>预计付费合计</span><b id="modalBudgetTotal"></b></div>
      <p class="fine-print">确认后才会开始任何进一步操作；首帧生成本身不产生费用。台词或时长变更会使确认失效，需要重新确认。</p>
      <div class="modal-actions">
        <button class="ghost" id="gateACancel">再改改</button>
        <button class="primary" id="gateAConfirm">确认预算</button>
      </div>
    </div>
  </div>

  <div id="toastWrap" class="toast-wrap"></div>
  <script src="drama.js"></script>
</body>
</html>
```

- [ ] **Step 2: 创建 public/drama.js**

```javascript
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  project: null,
  projects: [],
  pollTimer: null
};

const RUNNING_STATUSES = ["analyzing", "directing", "prompting", "reviewing"];
const STAGE_ORDER = ["analyze", "direct", "prompt", "review"];
const STATUS_LABEL = {
  draft: "草稿", analyzing: "剧本分析中", directing: "导演分镜中", prompting: "提示词生成中",
  reviewing: "审核中", awaiting_gate_a: "待确认预算", review_blocked: "审核未通过",
  failed: "流水线失败", frames: "首帧生成中", awaiting_gate_b: "待确认首帧", frames_confirmed: "首帧已确认"
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    const error = new Error(payload.message || `请求失败 (${response.status})`);
    error.code = payload.errorCode;
    throw error;
  }
  return payload;
}

function toast(titleText, detail = "", type = "") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  const strong = document.createElement("b");
  const span = document.createElement("span");
  strong.textContent = titleText;
  span.textContent = detail;
  node.append(strong, span);
  $("#toastWrap").append(node);
  setTimeout(() => node.remove(), 3600);
}

function showError(message) {
  const banner = $("#errorBanner");
  if (!message) {
    banner.classList.add("hidden");
    return;
  }
  banner.textContent = message;
  banner.classList.remove("hidden");
}

// ---------- 健康状态 ----------

async function loadHealth() {
  try {
    const { data } = await api("/api/health");
    const llm = data.providers.dramaLlm || {};
    const comfy = data.providers.comfyui || {};
    setProvider($("#llmStatus"), llm.connected ? "on" : llm.mock ? "demo" : "off", llm.connected ? "已连接" : llm.mock ? "演示编排" : "未配置");
    setProvider($("#comfyStatus"), comfy.connected ? "on" : "off", comfy.connected ? "已连接" : "未连接");
    $("#mockBanner").classList.toggle("hidden", !llm.mock);
  } catch {
    setProvider($("#llmStatus"), "off", "检查失败");
    setProvider($("#comfyStatus"), "off", "检查失败");
  }
}

function setProvider(node, mode, label) {
  node.dataset.mode = mode;
  node.querySelector("small").textContent = label;
}

// ---------- 项目加载 ----------

async function loadProjects(selectId) {
  const { data } = await api("/api/drama/projects");
  state.projects = data.projects;
  const select = $("#projectSelect");
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.projects.length ? "选择项目…" : "暂无项目";
  select.append(placeholder);
  for (const item of state.projects) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.title}（${STATUS_LABEL[item.status] || item.status}）`;
    select.append(option);
  }
  const target = selectId || localStorage.getItem("dramaCurrentProjectId") || "";
  if (target && state.projects.some((p) => p.id === target)) {
    select.value = target;
    await loadProject(target);
  }
}

async function loadProject(id) {
  const { data } = await api(`/api/drama/projects/${id}`);
  state.project = data.project;
  localStorage.setItem("dramaCurrentProjectId", id);
  renderProject();
  schedulePoll();
}

async function createProject() {
  const title = $("#dramaTitle").value.trim() || "未命名短剧";
  const script = $("#dramaScript").value.trim();
  if (script.length < 50) {
    toast("剧本太短", "至少需要 50 个字符", "error");
    return null;
  }
  const { data } = await api("/api/drama/projects", {
    method: "POST",
    body: JSON.stringify({ title, script })
  });
  await loadProjects(data.project.id);
  return data.project;
}

// ---------- 渲染 ----------

function renderProject() {
  const project = state.project;
  if (!project) return;
  showError(null);
  $("#dramaTitle").value = project.title;
  if (document.activeElement !== $("#dramaScript")) $("#dramaScript").value = project.script;
  $("#dramaCharCount").textContent = `${project.script.replace(/\s/g, "").length} 字`;
  $("#projectStatus").textContent = STATUS_LABEL[project.status] || project.status;
  $("#shotCountBadge").textContent = project.shots.length || "—";
  renderStages(project);
  renderCharacters(project);
  renderShots(project);
  renderBudget(project);
  renderGateB(project);
  $("#resumeBtn").classList.toggle("hidden", project.status !== "failed");
  $("#genAllFramesBtn").classList.toggle("hidden", !project.gateAConfirmedAt || !project.shots.some((s) => ["pending", "failed"].includes(s.frame.status)));
  if (project.status === "failed" && project.pipeline?.error) {
    showError(`流水线在「${project.pipeline.error.stage}」阶段失败：${project.pipeline.error.message}`);
  }
  if (project.status === "review_blocked" && project.review) {
    showError(`审核未通过：${project.review.issues.filter((i) => i.severity === "block").map((i) => i.message).join("；") || "请检查分镜内容"}`);
  }
}

function renderStages(project) {
  const activeStage = project.pipeline?.stage;
  const doneIndex = project.analysis ? (project.shots.length ? (project.shots[0]?.fluxPrompt ? (project.review ? 4 : 3) : 2) : 1) : 0;
  for (const item of $$("#stageList li")) {
    const stage = item.dataset.stage;
    const index = STAGE_ORDER.indexOf(stage);
    item.classList.toggle("active", stage === activeStage);
    item.classList.toggle("done", index < doneIndex && stage !== activeStage);
    item.querySelector("em").textContent = stage === activeStage ? "进行中" : index < doneIndex ? "完成" : "";
  }
}

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
    const personality = document.createElement("span");
    personality.textContent = character.personality || "—";
    const appearance = document.createElement("small");
    appearance.textContent = character.appearance;
    card.append(name, personality, appearance);
    box.append(card);
  }
}

function frameUrl(project, shot) {
  return shot.frame.file ? `/drama-files/${project.id}/${shot.frame.file}` : null;
}

function renderShots(project) {
  const box = $("#shotList");
  box.innerHTML = "";
  if (!project.shots.length) {
    box.innerHTML = '<p class="muted">运行流水线后展示分镜</p>';
    return;
  }
  for (const shot of project.shots) {
    box.append(buildShotCard(project, shot));
  }
}

function buildShotCard(project, shot) {
  const card = document.createElement("article");
  card.className = "shot-card";
  card.dataset.shotId = shot.id;

  const head = document.createElement("div");
  head.className = "shot-head";
  const title = document.createElement("b");
  title.textContent = `镜 ${shot.index} · ${shot.sceneName}`;
  const badge = document.createElement("span");
  badge.className = `badge ${shot.shotType}`;
  badge.textContent = shot.shotType === "dialogue" ? "口播镜" : "剧情镜";
  const meta = document.createElement("small");
  meta.textContent = `${shot.camera} · ${shot.durationSec}s · ${shot.emotion}`;
  head.append(title, badge, meta);

  const dialogue = document.createElement("textarea");
  dialogue.className = "shot-dialogue";
  dialogue.value = shot.dialogue;
  dialogue.placeholder = "台词（口播镜必填）";
  dialogue.disabled = !isEditable(project);
  dialogue.addEventListener("change", () => saveShot(project, shot.id, { dialogue: dialogue.value }));

  const action = document.createElement("textarea");
  action.className = "shot-action";
  action.value = shot.action;
  action.placeholder = "画面描述";
  action.disabled = !isEditable(project);
  action.addEventListener("change", () => saveShot(project, shot.id, { action: action.value }));

  const prompt = document.createElement("textarea");
  prompt.className = "shot-prompt";
  prompt.value = shot.fluxPrompt;
  prompt.placeholder = "Flux 首帧提示词";
  prompt.disabled = !isEditable(project);
  prompt.addEventListener("change", () => saveShot(project, shot.id, { fluxPrompt: prompt.value }));

  const frameBox = document.createElement("div");
  frameBox.className = "shot-frame";
  const url = frameUrl(project, shot);
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = `镜 ${shot.index} 首帧`;
    frameBox.append(img);
  } else {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = frameStatusText(shot);
    frameBox.append(empty);
  }

  const actions = document.createElement("div");
  actions.className = "shot-actions";
  const genBtn = document.createElement("button");
  genBtn.className = "mini-btn";
  genBtn.textContent = shot.frame.status === "ready" || shot.frame.status === "confirmed" ? "换抽" : "生成首帧";
  genBtn.disabled = !project.gateAConfirmedAt || shot.frame.status === "generating";
  genBtn.addEventListener("click", () => generateFrame(project, shot.id));
  actions.append(genBtn);
  if (shot.frame.status === "ready") {
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "mini-btn primary-mini";
    confirmBtn.textContent = "确认首帧";
    confirmBtn.addEventListener("click", () => confirmFrame(project, shot.id));
    actions.append(confirmBtn);
  }
  if (shot.frame.status === "confirmed") {
    const tag = document.createElement("span");
    tag.className = "badge confirmed";
    tag.textContent = "已确认";
    actions.append(tag);
  }
  if (shot.frame.status === "failed") {
    const error = document.createElement("small");
    error.className = "error-text";
    error.textContent = shot.frame.error?.message || "生成失败";
    actions.append(error);
  }

  card.append(head, dialogue, action, prompt, frameBox, actions);
  return card;
}

function isEditable(project) {
  return ["awaiting_gate_a", "review_blocked", "frames", "awaiting_gate_b"].includes(project.status);
}

function frameStatusText(shot) {
  return {
    pending: "待生成首帧",
    generating: "首帧生成中…",
    ready: "",
    confirmed: "",
    failed: "生成失败，可重试"
  }[shot.frame.status] || shot.frame.status;
}

function renderBudget(project) {
  const box = $("#budgetLines");
  box.innerHTML = "";
  if (!project.budget) {
    box.innerHTML = '<p class="muted">流水线完成后生成</p>';
    $("#budgetTotal").textContent = "—";
    $("#gateABtn").classList.add("hidden");
    return;
  }
  for (const line of project.budget.lines) {
    const row = document.createElement("div");
    row.className = "budget-row";
    const label = document.createElement("span");
    label.textContent = line.label;
    const value = document.createElement("b");
    value.textContent = line.kind === "local" ? "¥0（本机）" : `¥${line.subtotal}`;
    row.append(label, value);
    box.append(row);
  }
  $("#budgetTotal").textContent = `¥${project.budget.totalPaid}`;
  $("#gateABtn").classList.toggle("hidden", project.status !== "awaiting_gate_a");
}

function renderGateB(project) {
  const total = project.shots.length;
  const confirmed = project.shots.filter((s) => s.frame.status === "confirmed").length;
  $("#gateBProgress").style.width = total ? `${(confirmed / total) * 100}%` : "0%";
  $("#gateBText").textContent = `${confirmed} / ${total}`;
  $("#doneBanner").classList.toggle("hidden", !(total > 0 && project.status === "frames_confirmed"));
}

// ---------- 动作 ----------

async function saveShot(project, shotId, patch) {
  try {
    const { data } = await api(`/api/drama/projects/${project.id}/shots/${shotId}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
    state.project = data.project;
    renderProject();
    if (data.project.status === "awaiting_gate_a" && project.gateAConfirmedAt) {
      toast("预算已变更", "台词或时长变化使费用确认失效，请重新确认", "error");
    }
  } catch (error) {
    toast("保存失败", error.message, "error");
  }
}

async function runPipeline() {
  try {
    showError(null);
    let project = state.project;
    const scriptDirty = !project || $("#dramaScript").value.trim() !== project.script;
    if (!project) {
      project = await createProject();
      if (!project) return;
    } else if (scriptDirty) {
      const { data } = await api(`/api/drama/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: $("#dramaTitle").value.trim(), script: $("#dramaScript").value.trim() })
      });
      project = data.project;
      state.project = project;
    }
    const fromStage = project.status === "failed" ? project.pipeline?.error?.stage : undefined;
    await api(`/api/drama/projects/${project.id}/pipeline`, {
      method: "POST",
      body: JSON.stringify(fromStage ? { fromStage } : {})
    });
    schedulePoll(true);
  } catch (error) {
    toast("流水线启动失败", error.message, "error");
  }
}

async function generateFrame(project, shotId) {
  try {
    await api(`/api/drama/projects/${project.id}/shots/${shotId}/frame`, { method: "POST", body: "{}" });
    schedulePoll(true);
  } catch (error) {
    toast("首帧生成失败", error.message, "error");
  }
}

async function generateAllFrames() {
  const project = state.project;
  if (!project) return;
  for (const shot of project.shots) {
    if (["pending", "failed"].includes(shot.frame.status)) {
      await generateFrame(project, shot.id); // 串行：本机 GPU 一次一镜
    }
  }
}

async function confirmFrame(project, shotId) {
  try {
    const { data } = await api(`/api/drama/projects/${project.id}/shots/${shotId}/confirm`, { method: "POST", body: "{}" });
    state.project = data.project;
    renderProject();
  } catch (error) {
    toast("确认失败", error.message, "error");
  }
}

function openGateAModal() {
  const project = state.project;
  if (!project?.budget) return;
  const box = $("#modalBudgetLines");
  box.innerHTML = "";
  for (const line of project.budget.lines) {
    const row = document.createElement("div");
    row.className = "budget-row";
    const label = document.createElement("span");
    label.textContent = line.label;
    const value = document.createElement("b");
    value.textContent = line.kind === "local" ? "¥0（本机）" : `¥${line.subtotal}`;
    row.append(label, value);
    box.append(row);
  }
  $("#modalBudgetTotal").textContent = `¥${project.budget.totalPaid}`;
  $("#gateAModal").classList.add("open");
  $("#gateAModal").setAttribute("aria-hidden", "false");
}

function closeGateAModal() {
  $("#gateAModal").classList.remove("open");
  $("#gateAModal").setAttribute("aria-hidden", "true");
}

async function confirmGateA() {
  const project = state.project;
  if (!project) return;
  try {
    const { data } = await api(`/api/drama/projects/${project.id}/gate-a`, {
      method: "POST",
      body: JSON.stringify({ confirmCost: true })
    });
    state.project = data.project;
    closeGateAModal();
    renderProject();
    toast("预算已确认", "现在可以逐镜生成首帧（本机算力，¥0）");
  } catch (error) {
    closeGateAModal();
    toast("确认失败", error.message, "error");
  }
}

// ---------- 轮询 ----------

function schedulePoll(immediate = false) {
  clearTimeout(state.pollTimer);
  const project = state.project;
  if (!project) return;
  const busy = RUNNING_STATUSES.includes(project.status)
    || project.shots.some((s) => s.frame.status === "generating");
  if (immediate || busy) {
    state.pollTimer = setTimeout(async () => {
      try {
        const { data } = await api(`/api/drama/projects/${project.id}`);
        state.project = data.project;
        renderProject();
      } catch { /* 下一次轮询再试 */ }
      schedulePoll();
    }, immediate ? 0 : 800);
  }
}

// ---------- 事件绑定 ----------

$("#runPipelineBtn").addEventListener("click", runPipeline);
$("#resumeBtn").addEventListener("click", runPipeline);
$("#gateABtn").addEventListener("click", openGateAModal);
$("#gateAConfirm").addEventListener("click", confirmGateA);
$("#gateACancel").addEventListener("click", closeGateAModal);
$("#genAllFramesBtn").addEventListener("click", generateAllFrames);
$("#projectSelect").addEventListener("change", (event) => {
  if (event.target.value) loadProject(event.target.value);
});
$("#newProjectBtn").addEventListener("click", () => {
  state.project = null;
  localStorage.removeItem("dramaCurrentProjectId");
  $("#projectSelect").value = "";
  $("#dramaTitle").value = "";
  $("#dramaScript").value = "";
  $("#dramaCharCount").textContent = "0 字";
  $("#projectStatus").textContent = "未开始";
  $("#shotList").innerHTML = '<p class="muted">运行流水线后展示分镜</p>';
  $("#characterList").innerHTML = '<p class="muted">解析后生成</p>';
  $("#budgetLines").innerHTML = '<p class="muted">流水线完成后生成</p>';
  $("#budgetTotal").textContent = "—";
  $("#shotCountBadge").textContent = "—";
  showError(null);
});
$("#demoBtn").addEventListener("click", async () => {
  const { data } = await api("/api/drama/demo");
  $("#dramaScript").value = data.script;
  $("#dramaTitle").value = "雨夜便利店";
  $("#dramaCharCount").textContent = `${data.script.replace(/\s/g, "").length} 字`;
});
$("#dramaScript").addEventListener("input", () => {
  $("#dramaCharCount").textContent = `${$("#dramaScript").value.replace(/\s/g, "").length} 字`;
});
$$("[data-anchor]").forEach((button) => {
  button.addEventListener("click", () => {
    document.getElementById(button.dataset.anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

loadHealth();
loadProjects();
```

- [ ] **Step 3: 追加样式到 public/styles.css（文件末尾，不改既有规则）**

```css
/* ---------- 短剧工作台 ---------- */
.drama-body .drama-grid {
  display: grid;
  grid-template-columns: minmax(280px, 360px) 1fr minmax(260px, 320px);
  gap: 20px;
  padding: 20px;
  align-items: start;
}
.drama-body .script-card textarea {
  min-height: 260px;
  width: 100%;
  resize: vertical;
}
.drama-body .banner {
  margin: 12px 20px 0;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(216, 255, 62, 0.08);
  border: 1px solid rgba(216, 255, 62, 0.25);
  font-size: 13px;
}
.drama-body .banner.error {
  background: rgba(255, 92, 92, 0.08);
  border-color: rgba(255, 92, 92, 0.3);
}
.drama-body .banner.success {
  background: rgba(80, 220, 140, 0.1);
  border-color: rgba(80, 220, 140, 0.3);
}
.drama-body .hidden { display: none !important; }
.drama-body .muted { opacity: 0.55; font-size: 13px; }
.drama-body .project-select { max-width: 220px; }
.drama-body .stage-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.drama-body .stage-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  opacity: 0.6;
}
.drama-body .stage-list li.active { opacity: 1; border-color: rgba(216, 255, 62, 0.5); }
.drama-body .stage-list li.done { opacity: 0.9; }
.drama-body .stage-list li em { margin-left: auto; font-style: normal; font-size: 12px; }
.drama-body .character-list { display: flex; flex-direction: column; gap: 10px; }
.drama-body .character-item { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; }
.drama-body .character-item small { opacity: 0.6; word-break: break-all; }
.drama-body .shot-list { display: flex; flex-direction: column; gap: 16px; }
.drama-body .shot-card {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.drama-body .shot-head { display: flex; align-items: center; gap: 10px; }
.drama-body .shot-head small { margin-left: auto; opacity: 0.6; }
.drama-body .badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.2);
}
.drama-body .badge.dialogue { border-color: rgba(108, 165, 255, 0.6); color: #9cc2ff; }
.drama-body .badge.cinematic { border-color: rgba(216, 255, 62, 0.5); color: #d8ff3e; }
.drama-body .badge.confirmed { border-color: rgba(80, 220, 140, 0.6); color: #50dc8c; }
.drama-body .shot-card textarea { width: 100%; resize: vertical; font-size: 13px; }
.drama-body .shot-dialogue { min-height: 44px; }
.drama-body .shot-action { min-height: 44px; }
.drama-body .shot-prompt { min-height: 64px; font-family: ui-monospace, monospace; opacity: 0.85; }
.drama-body .shot-frame {
  min-height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
  border-radius: 10px;
  overflow: hidden;
}
.drama-body .shot-frame img { max-width: 100%; max-height: 320px; display: block; }
.drama-body .shot-actions { display: flex; align-items: center; gap: 10px; }
.drama-body .error-text { color: #ff8a8a; }
.drama-body .budget-lines { display: flex; flex-direction: column; gap: 8px; }
.drama-body .budget-row { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
.drama-body .budget-row span { opacity: 0.75; }
.drama-body .budget-total {
  display: flex;
  justify-content: space-between;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 15px;
}
.drama-body .fine-print { font-size: 12px; opacity: 0.5; margin-top: 10px; }
.drama-body .gate-progress { display: flex; align-items: center; gap: 10px; }
.drama-body .gate-progress .progress { flex: 1; height: 6px; border-radius: 999px; background: rgba(255,255,255,0.1); overflow: hidden; }
.drama-body .gate-progress .progress i { display: block; height: 100%; background: #d8ff3e; width: 0; transition: width 0.3s; }
.drama-body .modal { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,0.6); z-index: 50; }
.drama-body .modal.open { display: flex; }
.drama-body .modal-card {
  width: min(480px, 92vw);
  background: #17181c;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 16px;
  padding: 22px;
}
.drama-body .modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
.drama-body .provider[data-mode="on"] i { background: #50dc8c; }
.drama-body .provider[data-mode="demo"] i { background: #ffd23e; }
.drama-body .provider[data-mode="off"] i { background: #666; }
@media (max-width: 1100px) {
  .drama-body .drama-grid { grid-template-columns: 1fr; }
}
```

- [ ] **Step 4: index.html 加入口链接**

在侧边栏 `接入说明` 按钮（第 34 行 `<button class="side-link" id="openIntegrations">…</button>`）之后追加：

```html
          <a class="side-link" href="/drama.html"><span>▦</span>短剧工作台</a>
```

- [ ] **Step 5: 验证**

check 脚本确认已包含 `public/drama.js`。

```bash
npm run check
PORT=4399 node server.mjs &
open http://127.0.0.1:4399/drama.html
# 手动路径：演示剧本 → 开始解析 → 四阶段进度推进 → 分镜表出现 → 预算单出现
#   → 确认预算（弹窗）→ 未配置 ComfyUI 时"生成首帧"toast 报 COMFYUI_UNAVAILABLE
kill %1
```

Expected: 页面可用；mock 编排下零费用走通到闸门 A 之后；首帧在无 ComfyUI 时给出明确错误。

- [ ] **Step 6: Commit**

```bash
git add public/drama.html public/drama.js public/styles.css public/index.html package.json
git commit -m "feat: 新增短剧工作台页面（剧本/流水线/分镜/预算/首帧确认）"
```

---

### Task 10: 冒烟测试扩展与文档收尾

**Files:**
- Modify: `scripts/smoke.mjs`（追加短剧全链路零费用断言）
- Modify: `docs/INTEGRATION-CONTRACT.md`（追加两个集成条目）
- Modify: `docs/ARCHITECTURE.md`（追加 lib/drama 一行说明）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 无新接口；`npm test` 全绿。

- [ ] **Step 1: 扩展 smoke.mjs**

env 块追加（与现有清空风格一致）：

```javascript
    DRAMA_LLM_BASE_URL: "",
    DRAMA_LLM_MODEL: "",
    DRAMA_LLM_API_KEY: "",
    DRAMA_LLM_MOCK: "",
    COMFYUI_URL: "",
```

在 `console.log(JSON.stringify({...}))` 之前追加短剧链路：

```javascript
  // ---------- 短剧工作台：零费用全链路 ----------
  const dramaScript = "雨夜，林晚抱着纸箱站在便利店门口躲雨。陈默推门出来，把伞塞进她手里转身冲进雨里。林晚低头发现伞柄上贴着一张挂失回执，持卡人姓名写着陈默。她追出去两步，雨幕里已经看不到人影。";
  const created = await request("/api/drama/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "烟雾短剧", script: dramaScript })
  });
  await request(`/api/drama/projects/${created.project.id}/pipeline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  let drama = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(250);
    drama = (await request(`/api/drama/projects/${created.project.id}`)).project;
    if (["awaiting_gate_a", "review_blocked", "failed"].includes(drama.status)) break;
  }
  if (drama.status !== "awaiting_gate_a") throw new Error(`drama pipeline status=${drama.status}`);
  if (!drama.shots.length || !drama.budget || !drama.review) throw new Error("drama pipeline produced incomplete project");
  if (drama.shots.some((shot) => shot.fluxPrompt.length < 20)) throw new Error("drama shot missing flux prompt");

  const dramaGateResponse = await fetch(`http://127.0.0.1:${port}/api/drama/projects/${created.project.id}/gate-a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmCost: false })
  });
  const dramaGate = await dramaGateResponse.json();
  if (dramaGateResponse.status !== 409 || dramaGate.errorCode !== "COST_CONFIRMATION_REQUIRED") throw new Error("drama cost gate failed");

  const confirmed = await request(`/api/drama/projects/${created.project.id}/gate-a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmCost: true })
  });
  if (confirmed.project.status !== "frames") throw new Error("drama gate A confirmation did not unlock frames");

  const frameResponse = await fetch(`http://127.0.0.1:${port}/api/drama/projects/${created.project.id}/shots/${drama.shots[0].id}/frame`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const frameResult = await frameResponse.json();
  if (frameResponse.status !== 503 || frameResult.errorCode !== "COMFYUI_UNAVAILABLE") throw new Error("frame generation should require ComfyUI in clean env");

  const dramaJson = JSON.stringify(drama);
  if (/\/Users\/|\/home\/|api[_-]?key["']?\s*[:=]\s*["'][^"']+/i.test(dramaJson)) throw new Error("drama api exposed a path or secret value");
```

并在最终 `console.log` 的对象里追加两个字段：

```javascript
    dramaPipeline: drama.status,
    dramaCostGate: dramaGate.errorCode,
```

- [ ] **Step 2: 更新 docs/INTEGRATION-CONTRACT.md**

在集成表格末尾追加两行（保持现有表格风格）：

```markdown
| 短剧编排模型 | OpenAI 兼容端点（`DRAMA_LLM_BASE_URL` / `DRAMA_LLM_MODEL` / `DRAMA_LLM_API_KEY`） | 可选；不配置时使用本机演示编排 |
| 短剧首帧生成 | 本机 ComfyUI（`COMFYUI_URL`，Flux 工作流由程序生成） | 可选；本机算力，不产生 API 费用 |
```

- [ ] **Step 3: 更新 docs/ARCHITECTURE.md**

在文件列表段落后追加一行：

```markdown
- `lib/drama/` contains the short-drama workbench: schema/store, LLM pipeline stages, budget estimation and the ComfyUI adapter. Drama state lives in `data/drama-projects/` and follows the same privacy rules as other local data.
```

- [ ] **Step 4: 全量验证**

Run: `npm test`
Expected: check 通过 → 全部 node:test 通过 → smoke 输出含 `dramaPipeline: "awaiting_gate_a"` 与 `dramaCostGate: "COST_CONFIRMATION_REQUIRED"`，退出码 0

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke.mjs docs/INTEGRATION-CONTRACT.md docs/ARCHITECTURE.md
git commit -m "test: 短剧全链路零费用冒烟与接入文档更新"
```

---

## Self-Review 记录

**Spec 覆盖：**
- Node 原生四阶段流水线（分析/导演/提示词/审核）→ Task 3 ✓
- 分镜表中心实体 + 编辑 → Task 1 + Task 6 PATCH ✓
- 双后端并存：ComfyUI Flux 首帧（Task 7/8）+ Seedance 口播镜路由依据（`shotType: "dialogue"` 已入模型与预算行；Seedance 视频生成属 M3，MVP 仅在预算单与类型标记中体现）✓（MVP 范围声明）
- 两道人工闸门：闸门 A 预算确认（Task 6）+ 闸门 B 首帧确认（Task 8）✓
- 剧集级预算单 → Task 5 ✓
- 角色资产卡/外观锁 → Task 1 schema + Task 3 提示词注入 ✓（参考图注入 ComfyUI 属 M3+，MVP 用外观锁字符串）
- 零费用测试红线 → mock LLM + 503 短路 + smoke 断言 ✓
- 隐私边界 → .gitignore + 响应脱敏 + smoke 泄漏断言 ✓

**类型一致性检查：** `estimateBudget(project, pricing)` 签名在 budget/pipeline/routes 三处一致；`generateShotFrame(ctx, projectId, shotId, seed)` 在 routes 与测试一致；`ctx` 键名（`llmDeps / comfyConfig / pricing / frameFetch / frameSleep`）在 server 挂载与测试夹具一致；frame 状态机五态（pending/generating/ready/confirmed/failed）在 schema/routes/UI 一致。

**已知取舍（MVP 外）：** H3/Seedance 视频生成、TTS 时长回填、FFmpeg 合成（M3/M4）；VLM 画面审核（M5）；角色参考图注入 ComfyUI（M3+，MVP 用外观锁字符串）；真实审核模型（mock 审核仅结构校验 + warn 提示）。

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-09-ai-drama-workbench-mvp.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
