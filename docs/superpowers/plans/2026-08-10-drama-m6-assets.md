# 短剧工作台 M6：资产与版本（场景/道具 + 版本 + 多集）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在单集生产线之上补齐资产与版本：场景/道具英文外观锁注入 Flux 提示词保证一致性、手动版本快照与回滚、轻量多集（剧集分组单集项目）。

**Architecture:** 新增 `series.mjs`（剧集+共享资产库）与 `version.mjs`（快照）两个独立存储模块；`schema.mjs` 加场景/道具外观与 `project.seriesId`；`agents.mjs`/`llm.mjs` 在分析与 prompt 阶段产出并注入场景/道具外观；`routes.mjs` 加剧集/版本/资产端点；前端加资产视图卡片、版本面板、剧集两级切换。

**Tech Stack:** 零框架原生 HTML/CSS/JS；Node 20+；本机 JSON 文件存储；`node:test`。

## Global Constraints

- 零框架、无构建链、不引入新 npm 依赖；本机优先、私密不出本机。
- 中文提交信息（`类型: 简短描述`）；遵循既有 `lib/drama/*` 与 `tests/drama-*.test.mjs` 模式。
- **只借鉴 VOZEB 设计，不复制代码**（AGPL 规避）。
- **轻量多集**：剧集分组多个完整单集项目，共享资产库；**不重写**单集数据模型/流水线。既有单集流程零回归。
- 场景/道具外观注入失败（缺外观）→ 优雅降级为仅角色外观，不阻断分镜生成。
- 版本仅存**文本结构**（script/shots/analysis），手动快照、回滚二次确认；不含媒体文件。
- 资产库内嵌于 series 对象（`series.assetLibrary = {characters,scenes,props}`），不单列文件（YAGNI，对 spec 的 assetLibraryId 做内嵌简化）。

---

## 阶段 A：场景/道具资产 + 提示词注入

### Task 1: schema —— 场景/道具外观 + project.seriesId + snapshot

**Files:**
- Modify: `lib/drama/schema.mjs`
- Test: `tests/drama-schema.test.mjs`

**Interfaces:**
- Consumes: 现有 `normalizeAnalysis`、`normalizeProject`、`createDramaProject`
- Produces: `normalizeProp(raw,index)` → `{id,name,sceneName,appearance}`；`normalizeAnalysis` 返回的 `scenes[]` 含 `appearance`、`props[]` 新增；`normalizeSnapshot(raw)` → `{id,projectId,name,script,analysis,shots,createdAt}`；`normalizeProject`/`createDramaProject` 返回对象新增 `seriesId`（默认 `null`）

- [ ] **Step 1: 写失败测试**

在 `tests/drama-schema.test.mjs` 末尾追加：

```js
test("M6：场景/道具外观锁与 props、project.seriesId、snapshot 归一化", () => {
  const a = normalizeAnalysis({
    synopsis: "s", genre: "g",
    characters: [{ id: "char-1", name: "林晚", appearance: "young woman" }],
    scenes: [{ id: "scene-1", name: "便利店门口", location: "街角", mood: "雨夜", appearance: "convenience store entrance at night, warm signage" }],
    props: [{ id: "prop-1", name: "雨伞", sceneName: "便利店门口", appearance: "black folding umbrella, worn" }]
  });
  assert.equal(a.scenes[0].appearance, "convenience store entrance at night, warm signage");
  assert.equal(a.props[0].name, "雨伞");
  assert.equal(a.props[0].appearance, "black folding umbrella, worn");
  // 缺省：场景 appearance 默认空串、props 默认空数组
  const a2 = normalizeAnalysis({ synopsis: "s", genre: "g", characters: [{ id: "c", name: "x", appearance: "y" }], scenes: [{ id: "s1", name: "n" }] });
  assert.equal(a2.scenes[0].appearance, "");
  assert.deepEqual(a2.props, []);
  // project.seriesId
  assert.equal(normalizeProject({ id: "drama-1", title: "t", script: "s", ratio: "portrait", seriesId: "series-9" }).seriesId, "series-9");
  assert.equal(normalizeProject({ id: "drama-1", title: "t", script: "s", ratio: "portrait" }).seriesId, null);
  // snapshot
  const snap = normalizeSnapshot({ projectId: "drama-1", name: "v1", script: "剧本", analysis: a, shots: [{ id: "shot-1", dialogue: "x", durationSec: 3 }] });
  assert.equal(snap.name, "v1");
  assert.equal(snap.shots.length, 1);
  assert.equal(snap.analysis.scenes[0].appearance, "convenience store entrance at night, warm signage");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-schema.test.mjs`
Expected: FAIL（`a.props` undefined / `normalizeSnapshot is not a function` / `seriesId` undefined）

- [ ] **Step 3: 实现**

`lib/drama/schema.mjs`：
1. `normalizeCharacter` 之后新增 `normalizeProp`：

```js
export function normalizeProp(raw = {}, index = 0) {
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `prop-${index + 1}`,
    name: String(raw.name || `道具${index + 1}`).slice(0, 40),
    sceneName: String(raw.sceneName || "").slice(0, 40),
    appearance: String(raw.appearance || "").slice(0, 400)
  };
}
```

2. `normalizeAnalysis`：scenes 的 map 对象在 `mood:` 行后加 `appearance: String(s?.appearance || "").slice(0, 400)`；并在返回对象 `scenes:` 行后加 `props: (Array.isArray(raw.props) ? raw.props : []).slice(0, 12).map((p, i) => normalizeProp(p, i)),`。

3. 新增 `normalizeSnapshot`（文件尾部）：

```js
export function normalizeSnapshot(raw = {}) {
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `ver-${randomUUID()}`,
    projectId: String(raw.projectId || ""),
    name: String(raw.name || "未命名版本").slice(0, 60),
    script: String(raw.script || ""),
    analysis: raw.analysis ? normalizeAnalysis(raw.analysis) : null,
    shots: (Array.isArray(raw.shots) ? raw.shots : []).map((s, i) => normalizeShot(s, i)),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString()
  };
}
```

4. `normalizeProject` 与 `createDramaProject`：返回对象加 `seriesId: typeof raw.seriesId === "string" && raw.seriesId ? raw.seriesId : null`（createDramaProject 用 `seriesId: null`）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-schema.test.mjs && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/schema.mjs tests/drama-schema.test.mjs
git commit -m "feat: 场景/道具外观锁与版本快照、项目归剧字段（M6 Task1）"
```

---

### Task 2: agents/llm —— 场景/道具外观产出与注入提示词

**Files:**
- Modify: `lib/drama/agents.mjs`
- Modify: `lib/drama/llm.mjs`
- Test: `tests/drama-llm.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `normalizeAnalysis`（含 scenes.appearance/props）
- Produces: `SYSTEM_ANALYZE` 输出结构含 `scenes[].appearance` 与 `props[]`；`SYSTEM_PROMPT` 指示含场景/道具外观；mock `mockAnalysis` 产出场景/道具外观、`mockPrompts` 把场景/道具外观注入 `fluxPrompt`

- [ ] **Step 1: 写失败测试**

在 `tests/drama-llm.test.mjs` 末尾追加（mock 确定性，无需网络）：

```js
test("M6：mock 分析产出场景/道具外观，prompt 注入场景/道具外观", async () => {
  const analysis = await runScriptAnalysis({ script: "雨夜，便利店门口。" }, { config: { mock: true } });
  assert.ok(analysis.scenes.every((s) => typeof s.appearance === "string" && s.appearance.length > 0));
  assert.ok(Array.isArray(analysis.props) && analysis.props.length >= 1);
  assert.ok(analysis.props.every((p) => p.appearance.length > 0));

  const project = {
    analysis,
    shots: [{ id: "shot-1", index: 1, sceneName: analysis.scenes[0].name, characterIds: [analysis.characters[0].id], shotType: "cinematic", camera: "medium", dialogue: "", action: "推门", durationSec: 4, emotion: "失落", fluxPrompt: "", negativePrompt: "", motionPrompt: "" }]
  };
  const shots = await runPromptWriting(project, { config: { mock: true } });
  const fp = shots[0].fluxPrompt;
  assert.ok(fp.includes(analysis.scenes[0].appearance));   // 场景外观已注入
  assert.ok(fp.includes(analysis.props[0].appearance));    // 关联道具外观已注入
});
```

（若该文件未导入 `runScriptAnalysis`/`runPromptWriting`，在既有 import 行加：`import { runScriptAnalysis, runPromptWriting } from "../lib/drama/agents.mjs";`）

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-llm.test.mjs`
Expected: FAIL（`appearance.length > 0` 不成立 / 未注入）

- [ ] **Step 3: 实现**

`lib/drama/agents.mjs`：
1. `SYSTEM_ANALYZE` 的输出结构改为（在 scenes 加 appearance、新增 props）：
```
输出结构：{"synopsis":"一句话梗概","genre":"类型","characters":[{"id":"char-1","name":"角色名","role":"主角|配角","personality":"性格","appearance":"英文外观锁定描述，含年龄感/发型/服装/标志性特征，供图像模型使用"}],"scenes":[{"id":"scene-1","name":"场景名","location":"地点","mood":"氛围","appearance":"英文场景外观锁，含地点/光线/陈设"}],"props":[{"id":"prop-1","name":"道具名","sceneName":"所属场景名","appearance":"英文道具外观锁，含材质/标志物"}]}
要求：characters 覆盖全部有台词或关键动作的角色；appearance 必须是英文、具体、可在不同镜头间保持一致；scenes 与 props 的 appearance 同样是英文、具体、可复用；props 覆盖推动剧情的关键道具。
```
2. `SYSTEM_PROMPT` 的要求改为：
```
要求：fluxPrompt 必须以 "cinematic film still" 开头，包含该镜每个出场角色的 appearance 原文、所在场景的 appearance、相关道具的 appearance、camera 景别、action 画面、emotion 氛围；全英文；80-200 词。
```

`lib/drama/llm.mjs`：
1. `mockAnalysis` 的 scenes 加 appearance、并新增 props：

```js
    scenes: [
      { id: "scene-1", name: "便利店门口", location: "城市街角便利店", mood: "雨夜冷色，灯光温暖", appearance: "convenience store entrance at night, warm glowing signage, wet pavement reflections, glass door" },
      { id: "scene-2", name: "雨夜街道", location: "通往地铁站的路口", mood: "雨幕朦胧", appearance: "rainy city street at night, blurred neon, umbrella silhouettes, mist" }
    ],
    props: [
      { id: "prop-1", name: "雨伞", sceneName: "便利店门口", appearance: "black folding umbrella, slightly worn, metal ribs" },
      { id: "prop-2", name: "挂失回执", sceneName: "便利店门口", appearance: "small white paper receipt with printed text" }
    ]
```

2. `mockPrompts` 注入场景/道具外观（替换整个函数）：

```js
function mockPrompts(payload) {
  const characters = new Map((payload.analysis?.characters || []).map((c) => [c.id, c]));
  const scenesByName = new Map((payload.analysis?.scenes || []).map((s) => [s.name, s]));
  const props = payload.analysis?.props || [];
  const shots = (payload.shots || []).map((shot) => {
    const appearances = (shot.characterIds || [])
      .map((id) => characters.get(id)?.appearance)
      .filter(Boolean)
      .join("; ");
    const sceneAppearance = scenesByName.get(shot.sceneName)?.appearance || "";
    const propAppearances = props.filter((p) => p.sceneName === shot.sceneName).map((p) => p.appearance).filter(Boolean).join("; ");
    return {
      ...shot,
      fluxPrompt: [
        "cinematic film still", `${shot.camera || "medium"} shot`,
        appearances || "single character",
        sceneAppearance,
        propAppearances,
        shot.action || shot.dialogue || "quiet moment",
        `mood: ${shot.emotion || "calm"}`,
        "rainy night city lighting, photorealistic, 85mm lens"
      ].filter(Boolean).join(", "),
      negativePrompt: "low quality, watermark, text, deformed face, extra fingers",
      motionPrompt: "subtle camera push-in, natural micro motion, rain falling"
    };
  });
  return { shots };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-llm.test.mjs && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/agents.mjs lib/drama/llm.mjs tests/drama-llm.test.mjs
git commit -m "feat: 场景/道具外观注入 Flux 提示词（M6 Task2）"
```

---

### Task 3: 前端资产视图 —— 场景/道具卡片

**Files:**
- Modify: `public/drama.html`、`public/drama.js`、`public/drama.css`

**Interfaces:**
- Consumes: 现有 `#viewAssets`、`renderCharacters(project)`、Task 1 的 analysis.scenes/props
- Produces: 资产视图在角色卡之外新增场景卡（名称/地点/氛围/外观锁）与道具卡（名称/所属场景/外观锁）；均可编辑外观锁（编辑后调既有 PATCH 流程）

- [ ] **Step 1: 资产视图 HTML**

`public/drama.html` 的 `#viewAssets` 内、角色卡容器（`#characterList` 所在卡）之后新增两个容器卡：

```html
          <div class="vz-card" style="padding:14px">
            <b style="font-size:13px">场景资产</b>
            <div id="sceneList" style="margin-top:8px"></div>
          </div>
          <div class="vz-card" style="padding:14px">
            <b style="font-size:13px">道具资产</b>
            <div id="propList" style="margin-top:8px"></div>
          </div>
```

- [ ] **Step 2: 渲染函数**

`public/drama.js`：新增 `renderSceneAssets(project)` 与 `renderPropAssets(project)`，并在 `renderProject` 内 `renderCharacters(project)` 之后调用。场景/道具卡用与角色卡一致的结构（名称 + 可编辑外观锁 textarea），编辑外观锁通过既有「保存分析」路径写回（若无现成 PATCH analysis 端点，则本任务场景/道具外观锁**只读展示**，编辑留给后续——见 Step 3 说明）：

```js
function renderSceneAssets(project) {
  const box = $("#sceneList");
  if (!box) return;
  box.innerHTML = "";
  const scenes = project?.analysis?.scenes || [];
  if (!scenes.length) { box.innerHTML = '<p class="muted">解析后生成</p>'; return; }
  for (const s of scenes) {
    const item = document.createElement("div");
    item.className = "vz-char";
    const name = document.createElement("b"); name.textContent = `${s.name} · ${s.location || ""}`;
    const mood = document.createElement("div"); mood.className = "muted"; mood.textContent = s.mood || "";
    const app = document.createElement("div"); app.className = "muted mono"; app.style.fontSize = "10px"; app.textContent = s.appearance || "（无外观锁）";
    item.append(name, mood, app);
    box.append(item);
  }
}

function renderPropAssets(project) {
  const box = $("#propList");
  if (!box) return;
  box.innerHTML = "";
  const props = project?.analysis?.props || [];
  if (!props.length) { box.innerHTML = '<p class="muted">解析后生成</p>'; return; }
  for (const p of props) {
    const item = document.createElement("div");
    item.className = "vz-char";
    const name = document.createElement("b"); name.textContent = `${p.name}${p.sceneName ? ` · ${p.sceneName}` : ""}`;
    const app = document.createElement("div"); app.className = "muted mono"; app.style.fontSize = "10px"; app.textContent = p.appearance || "（无外观锁）";
    item.append(name, app);
    box.append(item);
  }
}
```

- [ ] **Step 3: 编辑能力说明**

M6 资产视图的场景/道具外观锁为**只读展示**（编辑外观锁需要新增 PATCH analysis 端点，属可选增强）。若实现者判断要支持编辑，可新增 `PATCH /api/drama/projects/{id}/analysis` 端点并在卡片上接 `change` 事件；否则保持只读。**默认只读**，把编辑留到后续里程碑，避免 M6 膨胀。

- [ ] **Step 4: 校验 + Commit**

Run: `npm run check`
```bash
git add public/drama.html public/drama.js public/drama.css
git commit -m "feat: 资产视图场景/道具卡片（M6 Task3）"
```

---

## 阶段 B：版本管理

### Task 4: version.mjs —— 快照保存/列表/读取/回滚

**Files:**
- Create: `lib/drama/version.mjs`
- Test: `tests/drama-version.test.mjs`

**Interfaces:**
- Consumes: `store`（`get/dir/update`）、Task 1 的 `normalizeSnapshot`
- Produces: `saveVersion(store, projectId, name)`→snapshot；`listVersions(store, projectId)`→`[{id,name,createdAt,shotCount}]`；`readVersion(store, projectId, versionId)`→snapshot|null；`rollbackVersion(store, projectId, versionId)`→updated project|null

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-version.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject } from "../lib/drama/schema.mjs";
import { saveVersion, listVersions, readVersion, rollbackVersion } from "../lib/drama/version.mjs";

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-ver-"));
  const store = createDramaStore(dataRoot);
  const project = createDramaProject({ title: "t", script: "原始剧本".repeat(20) });
  project.shots = [{ id: "shot-1", index: 1, dialogue: "旧台词", durationSec: 3 }];
  store.save(project);
  return { store, project, dataRoot };
}

test("saveVersion 存快照，listVersions 列出，readVersion 读取", () => {
  const { store, project, dataRoot } = setup();
  const snap = saveVersion(store, project.id, "初版");
  assert.equal(snap.name, "初版");
  assert.equal(snap.script, project.script);
  const list = listVersions(store, project.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "初版");
  assert.equal(list[0].shotCount, 1);
  const read = readVersion(store, project.id, snap.id);
  assert.equal(read.script, project.script);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("rollbackVersion 恢复剧本/分镜并重置衍生状态", () => {
  const { store, project, dataRoot } = setup();
  const snap = saveVersion(store, project.id, "初版");
  // 改剧本+分镜并推进状态
  store.update(project.id, (p) => { p.script = "改动后的剧本"; p.shots = []; p.status = "clips_ready"; p.gateAConfirmedAt = "2026-01-01"; });
  const rolled = rollbackVersion(store, project.id, snap.id);
  assert.equal(rolled.script, project.script); // 回到原始剧本
  assert.equal(rolled.shots.length, 1);
  assert.equal(rolled.status, "draft");
  assert.equal(rolled.gateAConfirmedAt, null);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("readVersion/rollbackVersion 不存在返回 null", () => {
  const { store, project, dataRoot } = setup();
  assert.equal(readVersion(store, project.id, "ver-nope"), null);
  assert.equal(rollbackVersion(store, project.id, "ver-nope"), null);
  rmSync(dataRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-version.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

新建 `lib/drama/version.mjs`：

```js
// lib/drama/version.mjs
// 手动版本快照：仅存文本结构（script/shots/analysis），存于项目目录 versions/
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSnapshot } from "./schema.mjs";

const versionDir = (store, projectId) => join(store.dir(projectId), "versions");

export function saveVersion(store, projectId, name) {
  const project = store.get(projectId);
  if (!project) return null;
  mkdirSync(versionDir(store, projectId), { recursive: true });
  const snapshot = normalizeSnapshot({
    id: `ver-${randomUUID()}`,
    projectId,
    name: name || `版本 ${new Date().toLocaleString("zh-CN")}`,
    script: project.script,
    analysis: project.analysis,
    shots: project.shots,
    createdAt: new Date().toISOString()
  });
  writeFileSync(join(versionDir(store, projectId), `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

export function listVersions(store, projectId) {
  const dir = versionDir(store, projectId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^ver-.*\.json$/.test(f))
    .map((f) => {
      try {
        const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
        return { id: s.id, name: s.name, createdAt: s.createdAt, shotCount: Array.isArray(s.shots) ? s.shots.length : 0 };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function readVersion(store, projectId, versionId) {
  const file = join(versionDir(store, projectId), `${versionId}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export function rollbackVersion(store, projectId, versionId) {
  const snapshot = readVersion(store, projectId, versionId);
  if (!snapshot) return null;
  return store.update(projectId, (p) => {
    p.script = snapshot.script;
    p.analysis = snapshot.analysis;
    p.shots = snapshot.shots;
    // 回滚使衍生状态失效，回到待重跑
    p.review = null;
    p.budget = null;
    p.gateAConfirmedAt = null;
    p.pipeline = { stage: null, error: null, updatedAt: null };
    p.compose = { status: "idle", file: null, srtFile: null, error: null, startedAt: null, finishedAt: null };
    p.status = "draft";
  });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-version.test.mjs && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/version.mjs tests/drama-version.test.mjs
git commit -m "feat: 版本快照保存/列表/回滚（M6 Task4）"
```

---

### Task 5: routes —— 版本端点

**Files:**
- Modify: `lib/drama/routes.mjs`
- Test: `tests/drama-routes-version.test.mjs`

**Interfaces:**
- Consumes: Task 4 的 `saveVersion/listVersions/readVersion/rollbackVersion`
- Produces: 端点 `POST /api/drama/projects/{id}/versions`（存版本）、`GET .../versions`（列表）、`GET .../versions/{verId}`（读取）、`POST .../versions/{verId}/rollback`（回滚）

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-routes-version.test.mjs`（沿用 routes 测试 mock 模式）：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createDramaProject } from "../lib/drama/schema.mjs";
import { createDramaStore } from "../lib/drama/store.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; return res; }

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rv-"));
  const store = createDramaStore(dataRoot);
  const project = createDramaProject({ title: "t", script: "原始剧本".repeat(20) });
  project.shots = [{ id: "shot-1", index: 1, dialogue: "台词", durationSec: 3 }];
  store.save(project);
  const ctx = {
    sendJson: (res, s, b) => res.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store, comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}
  };
  return { store, project, ctx, dataRoot };
}

test("版本：存→列→读→回滚 全链路", async () => {
  const { store, project, ctx, dataRoot } = setup();
  // 存
  let res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ name: "初版" }) }, res, new URL(`http://x/api/drama/projects/${project.id}/versions`), ctx);
  assert.equal(res.statusCode, 201);
  const verId = res.body.data.snapshot.id;
  // 列
  res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/versions`), ctx);
  assert.equal(res.body.data.versions.length, 1);
  // 改后回滚
  store.update(project.id, (p) => { p.script = "改动"; });
  res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: "{}" }, res, new URL(`http://x/api/drama/projects/${project.id}/versions/${verId}/rollback`), ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.project.script, "原始剧本".repeat(20));
  rmSync(dataRoot, { recursive: true, force: true });
});

test("回滚不存在的版本 → 404", async () => {
  const { project, ctx, dataRoot } = setup();
  const res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: "{}" }, res, new URL(`http://x/api/drama/projects/${project.id}/versions/ver-nope/rollback`), ctx);
  assert.equal(res.statusCode, 404);
  rmSync(dataRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-routes-version.test.mjs`
Expected: FAIL（404）

- [ ] **Step 3: 实现**

`lib/drama/routes.mjs`：
1. import 加 `import { saveVersion, listVersions, readVersion, rollbackVersion } from "./version.mjs";`
2. 在 `compose` 端点之后（项目块收尾 `}` 之前）新增：

```js
    // 版本：存
    if (segments.length === 5 && segments[4] === "versions" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      let payload = {};
      try { payload = await readJson(request, 10_000); } catch { return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" })); }
      const snapshot = saveVersion(store, projectId, payload.name);
      if (!snapshot) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "DRAMA_PROJECT_NOT_FOUND", message: "项目不存在" }));
      return sendJson(response, 201, envelope(true, { snapshot }, { requestId }));
    }

    // 版本：列表
    if (segments.length === 5 && segments[4] === "versions" && request.method === "GET") {
      return sendJson(response, 200, envelope(true, { versions: listVersions(store, projectId) }, { requestId }));
    }

    // 版本：读取
    if (segments.length === 6 && segments[4] === "versions" && request.method === "GET") {
      const snapshot = readVersion(store, projectId, segments[5]);
      if (!snapshot) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "VERSION_NOT_FOUND", message: "版本不存在" }));
      return sendJson(response, 200, envelope(true, { snapshot }, { requestId }));
    }

    // 版本：回滚
    if (segments.length === 7 && segments[4] === "versions" && segments[6] === "rollback" && request.method === "POST") {
      const ip = request.socket.remoteAddress || "local";
      if (!allowRequest(ip)) return sendJson(response, 429, envelope(false, null, { requestId, errorCode: "RATE_LIMITED", message: "操作太快，请一分钟后再试", retryable: true }));
      const updated = rollbackVersion(store, projectId, segments[5]);
      if (!updated) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "VERSION_NOT_FOUND", message: "版本不存在" }));
      return sendJson(response, 200, envelope(true, { project: updated }, { requestId }));
    }
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-routes-version.test.mjs && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/routes.mjs tests/drama-routes-version.test.mjs
git commit -m "feat: 版本端点（存/列/读/回滚）（M6 Task5）"
```

---

### Task 6: 前端版本面板

**Files:**
- Modify: `public/drama.html`、`public/drama.js`、`public/drama.css`

**Interfaces:**
- Consumes: Task 5 端点
- Produces: 生成视图或剧本视图加「版本」卡：`#versionList`、`#saveVersionBtn`；存版本、列表、回滚（二次确认）

- [ ] **Step 1: HTML**

`public/drama.html` 在 `#viewGenerate` 的 BGM 卡之后（或剧本视图合适处）加：

```html
          <div class="vz-card" style="padding:14px" id="versionCard">
            <b style="font-size:13px">版本</b>
            <div class="vz-rowline" style="margin-top:8px"><button class="vz-btn" id="saveVersionBtn">存个版本</button></div>
            <div id="versionList" style="margin-top:8px"></div>
          </div>
```

- [ ] **Step 2: 渲染 + 动作**

`public/drama.js` 新增并在 `renderProject` 调用 `renderVersions(project)`：

```js
async function renderVersions(project) {
  const box = $("#versionList");
  if (!box) return;
  box.innerHTML = "";
  if (!project) { box.innerHTML = '<p class="muted">—</p>'; return; }
  let versions = [];
  try { const { data } = await api(`/api/drama/projects/${project.id}/versions`); versions = data.versions || []; } catch {}
  if (!versions.length) { box.innerHTML = '<p class="muted">还没有版本</p>'; return; }
  for (const v of versions) {
    const row = document.createElement("div");
    row.className = "vz-sub-row";
    const label = document.createElement("span"); label.style.flex = "1"; label.textContent = `${v.name} · ${v.shotCount}镜`;
    const rb = document.createElement("button"); rb.className = "vz-btn"; rb.textContent = "回滚";
    rb.addEventListener("click", () => rollbackToVersion(v.id, v.name));
    row.append(label, rb);
    box.appendChild(row);
  }
}

async function saveCurrentVersion() {
  if (!state.project) return;
  const name = window.prompt("版本名称", `版本 ${new Date().toLocaleString("zh-CN")}`);
  if (name === null) return;
  try {
    await api(`/api/drama/projects/${state.project.id}/versions`, { method: "POST", body: JSON.stringify({ name }) });
    toast("已保存版本", name);
    renderVersions(state.project);
  } catch (error) { showError(error.message || error); }
}

async function rollbackToVersion(versionId, name) {
  if (!state.project) return;
  if (!window.confirm(`回滚到「${name}」？\n将恢复剧本/分镜/分析到该版本，首帧/视频/合成需重新生成。`)) return;
  try {
    const { data } = await api(`/api/drama/projects/${state.project.id}/versions/${versionId}/rollback`, { method: "POST", body: "{}" });
    state.project = data.project;
    renderProject();
    toast("已回滚", name);
  } catch (error) { showError(error.message || error); }
}
```

事件绑定区加：`if ($("#saveVersionBtn")) $("#saveVersionBtn").addEventListener("click", saveCurrentVersion);`，并在 `renderProject` 的 `renderBgm(project)` 后加 `renderVersions(project);`。

- [ ] **Step 3: 校验 + Commit**

Run: `npm run check`
```bash
git add public/drama.html public/drama.js public/drama.css
git commit -m "feat: 版本面板（存/列/回滚）（M6 Task6）"
```

---

## 阶段 C：轻量多集

### Task 7: series.mjs —— 剧集 + 共享资产库

**Files:**
- Create: `lib/drama/series.mjs`
- Test: `tests/drama-series.test.mjs`

**Interfaces:**
- Consumes: 无（独立存储 `data/drama-series/`）
- Produces: `createSeriesStore(dataRoot)` → `{ list, get, create, save, remove, addProject, removeProject, upsertAssets }`；series 形状 `{id,title,projectIds[],assetLibrary{characters,scenes,props},createdAt,updatedAt}`

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-series.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSeriesStore } from "../lib/drama/series.mjs";

test("剧集 CRUD 与集成员管理", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-series-"));
  const store = createSeriesStore(dataRoot);
  const s = store.create({ title: "雨夜系列" });
  assert.equal(s.title, "雨夜系列");
  assert.equal(store.list().length, 1);
  store.addProject(s.id, "drama-1");
  store.addProject(s.id, "drama-2");
  store.addProject(s.id, "drama-1"); // 幂等
  assert.deepEqual(store.get(s.id).projectIds, ["drama-1", "drama-2"]);
  store.removeProject(s.id, "drama-1");
  assert.deepEqual(store.get(s.id).projectIds, ["drama-2"]);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("共享资产库 upsertAssets 合并角色/场景/道具", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-series-"));
  const store = createSeriesStore(dataRoot);
  const s = store.create({ title: "x" });
  store.upsertAssets(s.id, { characters: [{ id: "char-1", name: "林晚", appearance: "young woman" }], scenes: [], props: [] });
  store.upsertAssets(s.id, { characters: [{ id: "char-1", name: "林晚", appearance: "young woman, updated" }], scenes: [{ id: "scene-1", name: "便利店", appearance: "store" }], props: [] });
  const lib = store.get(s.id).assetLibrary;
  assert.equal(lib.characters.length, 1);                       // 同 id 合并非重复
  assert.equal(lib.characters[0].appearance, "young woman, updated");
  assert.equal(lib.scenes.length, 1);
  rmSync(dataRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-series.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

新建 `lib/drama/series.mjs`：

```js
// lib/drama/series.mjs
// 轻量多集：剧集分组单集项目 + 共享资产库；存 data/drama-series/，每剧集一个 JSON
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { normalizeCharacter, normalizeProp, normalizeAnalysis } from "./schema.mjs";

export function createSeriesStore(dataRoot) {
  const root = join(dataRoot, "drama-series");
  mkdirSync(root, { recursive: true });
  const file = (id) => join(root, `${id}.json`);

  function normalizeSeries(raw = {}) {
    const lib = raw.assetLibrary || {};
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : `series-${randomUUID()}`,
      title: String(raw.title || "未命名剧集").slice(0, 80),
      projectIds: Array.isArray(raw.projectIds) ? [...new Set(raw.projectIds.map(String))] : [],
      assetLibrary: {
        characters: (Array.isArray(lib.characters) ? lib.characters : []).map((c, i) => normalizeCharacter(c, i)),
        scenes: (Array.isArray(lib.scenes) ? lib.scenes : []).map((s, i) => normalizeAnalysis({ synopsis: "x", genre: "x", characters: [{ id: "c", name: "x", appearance: "y" }], scenes: [s] }).scenes[0]),
        props: (Array.isArray(lib.props) ? lib.props : []).map((p, i) => normalizeProp(p, i))
      },
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString()
    };
  }

  function save(series) {
    series.updatedAt = new Date().toISOString();
    writeFileSync(file(series.id), JSON.stringify(series, null, 2));
    return series;
  }
  function get(id) {
    if (typeof id !== "string" || !/^series-[a-f0-9-]+$/.test(id) || !existsSync(file(id))) return null;
    try { return normalizeSeries(JSON.parse(readFileSync(file(id), "utf8"))); } catch { return null; }
  }
  function list() {
    return readdirSync(root).filter((f) => /^series-.*\.json$/.test(f))
      .map((f) => { try { return normalizeSeries(JSON.parse(readFileSync(join(root, f), "utf8"))); } catch { return null; } })
      .filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  function create({ title } = {}) { return save(normalizeSeries({ title })); }
  function remove(id) { if (existsSync(file(id))) rmSync(file(id)); }
  function addProject(id, projectId) {
    const s = get(id); if (!s) return null;
    if (!s.projectIds.includes(projectId)) s.projectIds.push(projectId);
    return save(s);
  }
  function removeProject(id, projectId) {
    const s = get(id); if (!s) return null;
    s.projectIds = s.projectIds.filter((p) => p !== projectId);
    return save(s);
  }
  function upsertAssets(id, assets = {}) {
    const s = get(id); if (!s) return null;
    const mergeById = (existing, incoming) => {
      const map = new Map(existing.map((x) => [x.id, x]));
      for (const item of incoming || []) map.set(item.id, { ...(map.get(item.id) || {}), ...item });
      return [...map.values()];
    };
    s.assetLibrary.characters = mergeById(s.assetLibrary.characters, assets.characters);
    s.assetLibrary.scenes = mergeById(s.assetLibrary.scenes, assets.scenes);
    s.assetLibrary.props = mergeById(s.assetLibrary.props, assets.props);
    return save(s);
  }

  return { list, get, create, save, remove, addProject, removeProject, upsertAssets };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-series.test.mjs && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/series.mjs tests/drama-series.test.mjs
git commit -m "feat: 剧集存储与共享资产库（M6 Task7）"
```

---

### Task 8: routes —— 剧集端点 + server.mjs 挂载

**Files:**
- Modify: `lib/drama/routes.mjs`、`server.mjs`
- Test: `tests/drama-routes-series.test.mjs`

**Interfaces:**
- Consumes: Task 7 的 `createSeriesStore`
- Produces: 端点 `GET/POST /api/drama/series`、`GET/PATCH/DELETE /api/drama/series/{id}`、`POST .../series/{id}/projects`（归入）、`DELETE .../series/{id}/projects/{projectId}`（移出）、`PUT .../series/{id}/assets`（同步资产库）

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-routes-series.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createSeriesStore } from "../lib/drama/series.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; return res; }

function ctx(dataRoot) {
  return {
    sendJson: (res, s, b) => res.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store: { get: () => null, dir: () => dataRoot, update: (id, fn) => null, list: () => [], save: () => {} },
    seriesStore: createSeriesStore(dataRoot),
    comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}
  };
}

test("剧集：建→列→加集→同步资产→移出", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rs-"));
  const c = ctx(dataRoot);
  let res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ title: "雨夜系列" }) }, res, new URL("http://x/api/drama/series"), c);
  assert.equal(res.statusCode, 201);
  const sid = res.body.data.series.id;

  res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL("http://x/api/drama/series"), c);
  assert.equal(res.body.data.series.length, 1);

  res = mockRes();
  await handleDramaApi({ method: "POST", socket: {}, body: JSON.stringify({ projectId: "drama-1" }) }, res, new URL(`http://x/api/drama/series/${sid}/projects`), c);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.series.projectIds, ["drama-1"]);

  res = mockRes();
  await handleDramaApi({ method: "PUT", socket: {}, body: JSON.stringify({ characters: [{ id: "char-1", name: "林晚", appearance: "young woman" }] }) }, res, new URL(`http://x/api/drama/series/${sid}/assets`), c);
  assert.equal(res.body.data.series.assetLibrary.characters.length, 1);

  res = mockRes();
  await handleDramaApi({ method: "DELETE", socket: {} }, res, new URL(`http://x/api/drama/series/${sid}/projects/drama-1`), c);
  assert.deepEqual(res.body.data.series.projectIds, []);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("操作不存在的剧集 → 404", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-rs-"));
  const c = ctx(dataRoot);
  const res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL("http://x/api/drama/series/series-nope"), c);
  assert.equal(res.statusCode, 404);
  rmSync(dataRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-routes-series.test.mjs`
Expected: FAIL（404/不处理）

- [ ] **Step 3: 实现**

`lib/drama/routes.mjs`：
1. import 加 `import { createSeriesStore } from "./series.mjs";`
2. `handleDramaApi` 开头（`if (segments[0] !== "api" || segments[1] !== "drama") return false;` 之后）新增剧集分支（注意：**这些是 `/api/drama/series...`，在 `segments[2] === "projects"` 项目分支之外**）：

```js
  const { seriesStore } = ctx;
  if (segments[2] === "series" && seriesStore) {
    // POST /series 建剧集；GET /series 列表
    if (segments.length === 3 && request.method === "POST") {
      let payload = {};
      try { payload = await readJson(request, 10_000); } catch { return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" })); }
      return sendJson(response, 201, envelope(true, { series: seriesStore.create({ title: payload.title }) }, { requestId }));
    }
    if (segments.length === 3 && request.method === "GET") {
      return sendJson(response, 200, envelope(true, { series: seriesStore.list() }, { requestId }));
    }
    const series = seriesStore.get(segments[3] || "");
    if (!series) return sendJson(response, 404, envelope(false, null, { requestId, errorCode: "SERIES_NOT_FOUND", message: "剧集不存在" }));
    if (segments.length === 4 && request.method === "GET") return sendJson(response, 200, envelope(true, { series }, { requestId }));
    if (segments.length === 4 && request.method === "PATCH") {
      let payload = {};
      try { payload = await readJson(request, 10_000); } catch { return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" })); }
      if (typeof payload.title === "string") series.title = payload.title.trim().slice(0, 80) || series.title;
      return sendJson(response, 200, envelope(true, { series: seriesStore.save(series) }, { requestId }));
    }
    if (segments.length === 4 && request.method === "DELETE") { seriesStore.remove(series.id); return sendJson(response, 200, envelope(true, { removed: series.id }, { requestId })); }
    if (segments.length === 5 && segments[4] === "projects" && request.method === "POST") {
      let payload = {};
      try { payload = await readJson(request, 10_000); } catch { return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" })); }
      if (!payload.projectId) return sendJson(response, 422, envelope(false, null, { requestId, errorCode: "PROJECT_REQUIRED", message: "缺少 projectId" }));
      return sendJson(response, 200, envelope(true, { series: seriesStore.addProject(series.id, String(payload.projectId)) }, { requestId }));
    }
    if (segments.length === 6 && segments[4] === "projects" && request.method === "DELETE") {
      return sendJson(response, 200, envelope(true, { series: seriesStore.removeProject(series.id, segments[5]) }, { requestId }));
    }
    if (segments.length === 5 && segments[4] === "assets" && request.method === "PUT") {
      let payload = {};
      try { payload = await readJson(request, 100_000); } catch { return sendJson(response, 400, envelope(false, null, { requestId, errorCode: "PAYLOAD_INVALID", message: "请求内容无效" })); }
      return sendJson(response, 200, envelope(true, { series: seriesStore.upsertAssets(series.id, payload) }, { requestId }));
    }
    return false;
  }
```

3. `server.mjs`：`handleDramaApi` 的 ctx 加 `seriesStore: createSeriesStore(dataRoot)`，并 import `import { createSeriesStore } from "./lib/drama/series.mjs";`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-routes-series.test.mjs && npm run test:unit && npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/routes.mjs server.mjs tests/drama-routes-series.test.mjs
git commit -m "feat: 剧集端点与 server 挂载（M6 Task8）"
```

---

### Task 9: 前端剧集两级切换 + 资产库视图

**Files:**
- Modify: `public/drama.html`、`public/drama.js`、`public/drama.css`

**Interfaces:**
- Consumes: Task 8 端点
- Produces: 顶栏项目选择旁加剧集管理（新建剧集、把当前项目归入剧集、按剧集筛选集列表）；资产视图可切换到「共享资产库」（当前项目属剧集时）

- [ ] **Step 1: 顶栏剧集控件 HTML**

`public/drama.html` 顶栏 `#projectSelect` 之前加：

```html
          <select id="seriesSelect" class="vz-select" style="max-width:180px"><option value="">未分组</option></select>
          <button class="vz-btn" id="newSeriesBtn">新建剧集</button>
          <button class="vz-btn hidden" id="assignSeriesBtn">归入剧集</button>
```

- [ ] **Step 2: 渲染与动作**

`public/drama.js` 新增 `loadSeries()`、`renderSeriesSelect()`、`createSeries()`、`assignToSeries()`，并在初始化/`loadProjects` 后调用 `loadSeries()`：

```js
async function loadSeries() {
  try { const { data } = await api("/api/drama/series"); state.series = data.series || []; } catch { state.series = []; }
  renderSeriesSelect();
}
function renderSeriesSelect() {
  const sel = $("#seriesSelect");
  if (!sel) return;
  sel.innerHTML = '<option value="">未分组</option>';
  for (const s of state.series || []) {
    const o = document.createElement("option"); o.value = s.id; o.textContent = `${s.title}（${s.projectIds.length}集）`; sel.append(o);
  }
  const cur = state.project?.seriesId || "";
  sel.value = cur;
  $("#assignSeriesBtn")?.classList.toggle("hidden", !state.project);
}
async function createSeries() {
  const title = window.prompt("剧集名称", "我的短剧系列");
  if (!title) return;
  await api("/api/drama/series", { method: "POST", body: JSON.stringify({ title }) });
  await loadSeries();
  toast("已创建剧集", title);
}
async function assignToSeries() {
  if (!state.project) return;
  const sid = $("#seriesSelect").value;
  if (!sid) { toast("未选择剧集", "先在左侧选择目标剧集", "error"); return; }
  await api(`/api/drama/series/${sid}/projects`, { method: "POST", body: JSON.stringify({ projectId: state.project.id }) });
  // 同步当前项目资产到剧集共享库
  const a = state.project.analysis || {};
  await api(`/api/drama/series/${sid}/assets`, { method: "PUT", body: JSON.stringify({ characters: a.characters || [], scenes: a.scenes || [], props: a.props || [] }) }).catch(() => {});
  state.project.seriesId = sid;
  await loadSeries();
  toast("已归入剧集", "资产已同步到共享库");
}
```

事件绑定区加：
```js
if ($("#newSeriesBtn")) $("#newSeriesBtn").addEventListener("click", createSeries);
if ($("#assignSeriesBtn")) $("#assignSeriesBtn").addEventListener("click", assignToSeries);
```
并在 `state` 对象加 `series: []`，初始化流程调 `loadSeries()`。

- [ ] **Step 3: 校验 + Commit**

Run: `npm run check`
```bash
git add public/drama.html public/drama.js public/drama.css
git commit -m "feat: 剧集两级切换与资产同步（M6 Task9）"
```

---

### Task 10: 验证收尾

**Files:**
- Modify: `package.json`、`scripts/smoke.mjs`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: check 覆盖新模块；smoke 含剧集/版本守卫

- [ ] **Step 1: package.json check 增加新模块**

`check` 脚本在 `node --check lib/drama/compose.mjs` 之后追加 `&& node --check lib/drama/series.mjs && node --check lib/drama/version.mjs`。

- [ ] **Step 2: smoke 守卫**

`scripts/smoke.mjs` 在 M5 合成守卫之后追加（零费用环境）：

```js
  // ---------- M6：剧集 + 版本守卫 ----------
  const seriesRes = await request("/api/drama/series", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "烟雾剧集" }) });
  if (!seriesRes.series?.id) throw new Error("创建剧集失败");
  const verRes = await request(`/api/drama/projects/${created.project.id}/versions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "烟雾版本" }) });
  if (!verRes.snapshot?.id) throw new Error("存版本失败");
  const verList = await request(`/api/drama/projects/${created.project.id}/versions`);
  if (!verList.versions.some((v) => v.id === verRes.snapshot.id)) throw new Error("版本列表未含新版本");
```

并在收尾 `console.log` 对象加 `seriesGuard: seriesRes.series.id, versionGuard: verRes.snapshot.id,`。

- [ ] **Step 3: 全量验证**

Run: `npm run check && npm run test:unit && npm run smoke`
Expected: 全通过；smoke 输出含 `seriesGuard`/`versionGuard`

- [ ] **Step 4: Commit**

```bash
git add package.json scripts/smoke.mjs
git commit -m "test: 剧集与版本冒烟守卫（M6 Task10 收尾）"
```

---

## Self-Review 记录

- **Spec coverage**：场景/道具外观锁+注入(T1/T2)、资产视图(T3)、版本快照/回滚(T4/T5/T6)、轻量多集+共享资产库(T7/T8/T9)、验证(T10)——均有对应任务。
- **Placeholder scan**：无 TBD/TODO；后端代码完整，前端为可运行实现。
- **Type consistency**：`normalizeProp/normalizeSnapshot`(T1)→version(T4)/series(T7) 引用一致；`saveVersion/listVersions/readVersion/rollbackVersion`(T4)→routes(T5) 一致；`createSeriesStore` 的 `{list,get,create,save,remove,addProject,removeProject,upsertAssets}`(T7)→routes(T8)/前端(T9) 一致；端点路径与前端 `api()` 调用一致。
- **已知简化（对 spec 的偏离，均为 YAGNI 且已注明）**：资产库内嵌于 series（不单列 assetLibrary 文件）；分镜关联场景沿用 `sceneName` 名称匹配（不新增 sceneId 字段）；场景/道具外观锁在资产视图只读展示（编辑需 PATCH analysis 端点，留后续）。
