# 短剧编辑器 M4 重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把短剧编辑器重构为 VOZEB 浅色 shadcn 风 + 剪辑式结构（图标栏/步骤条/分镜工作区/检查器），并为分镜新增 `audioMode`、`continuity` 细粒度字段。

**Architecture:** 前端零框架重写 `drama.html/css/js` 三件套；后端仅 `schema.mjs` 的 `normalizeShot` 增加两个字段，路由/流水线/存储全部复用。舞台化单视图：图标栏 + 步骤条切换 剧本/资产/分镜/生成 四个工作区视图，分镜为旗舰视图（大预览 + 分镜条 + 检查器）。

**Tech Stack:** 原生 HTML/CSS/JS（无构建链）、Node 20+ `node:test`、`lib/drama/*`（schema/routes/store/budget/comfyui/llm）。

**Spec:** `docs/superpowers/specs/2026-08-10-drama-editor-m4-design.md`

**视觉参考稿（已确认）：** `.superpowers/brainstorm/18827-1786331412/content/layout-v7.html`（VOZEB 浅色风分镜编辑器）。

## Global Constraints

- 零框架、本机优先；不引入 React/构建链/任何新依赖。
- VOZEB-PRO 为 AGPL-3.0，本项目 MIT：**只借鉴设计，不复制其代码**。
- 浅色主题令牌（来自 VOZEB `global-foundation.css`，逐项照抄）：`--bg:#fafbfc`、`--card:#ffffff`、`--border:#e5e8ec`、`--text:#20242a`、`--soft:#f1f3f5`、`--muted:#697381`、主按钮近黑 `#20242a`、基础圆角 10px、卡片圆角 14px。
- 后端 `lib/drama/routes.mjs`、`pipeline.mjs`、`store.mjs`、`budget.mjs`、`comfyui.mjs`、`llm.mjs`、`agents.mjs` 与 `server.mjs` **不改**（仅 `schema.mjs` 加字段）。
- 中文提交信息，格式 `类型: 简短描述`（feat/fix/refactor/docs/test/chore）。
- 每个 task 完成后按用户偏好 `git push origin main`（fork 远端）。
- 现有可复用的前端动作函数（见 Task 5「保留清单」）逐字保留，不得重写。

---

### Task 1: schema — normalizeShot 增加 audioMode / continuity

**Files:**
- Modify: `lib/drama/schema.mjs:70-88`（`normalizeShot`）
- Test: `tests/drama-schema.test.mjs`

**Interfaces:**
- Consumes: 现有 `normalizeShot(raw, index)`。
- Produces: `normalizeShot` 返回的 shot 新增 `audioMode: "voice"|"none"`（默认 `"voice"`）与 `continuity: string`（≤120 字，默认 `""`）。后续 Task 5/6 的前端检查器与 Task 2 的 PATCH 依赖这两个字段名。

- [ ] **Step 1: 写失败测试**

在 `tests/drama-schema.test.mjs` 末尾追加（沿用该文件现有 `test`/`assert` 导入）：

```js
test("normalizeShot 收敛 audioMode 与 continuity", () => {
  const def = normalizeShot({}, 0);
  assert.equal(def.audioMode, "voice");       // 默认配音
  assert.equal(def.continuity, "");
  const custom = normalizeShot({ audioMode: "none", continuity: "与镜 2 同场景" }, 0);
  assert.equal(custom.audioMode, "none");
  assert.equal(custom.continuity, "与镜 2 同场景");
  const bad = normalizeShot({ audioMode: "loud" }, 0);
  assert.equal(bad.audioMode, "voice");        // 非法值回退默认
  const long = normalizeShot({ continuity: "x".repeat(200) }, 0);
  assert.equal(long.continuity.length, 120);   // 截断到 120
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/drama-schema.test.mjs`
Expected: FAIL，`audioMode` 为 `undefined`（normalizeShot 尚未返回该字段）。

- [ ] **Step 3: 实现 normalizeShot 新字段**

在 `lib/drama/schema.mjs` 的 `normalizeShot` 返回对象中，`motionPrompt` 一行之后、`frame` 之前插入：

```js
    motionPrompt: String(raw.motionPrompt || "").slice(0, 500),
    // M4 新增：配音/静音 与 镜头衔接说明（仅提示，不参与生成；M5 才引入"原声"）
    audioMode: ["voice", "none"].includes(raw.audioMode) ? raw.audioMode : "voice",
    continuity: String(raw.continuity || "").slice(0, 120),
    frame: normalizeFrame(raw.frame),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/drama-schema.test.mjs`
Expected: PASS（含既有断言不回归）。

- [ ] **Step 5: Commit + push**

```bash
git add lib/drama/schema.mjs tests/drama-schema.test.mjs
git commit -m "feat: 分镜新增 audioMode/continuity 字段（M4）"
git push origin main
```

---

### Task 2: routes — PATCH 持久化新字段且不误伤预算/首帧

**Files:**
- Test: `tests/drama-routes-frames.test.mjs`（追加；若无合适挂载点则新建 `tests/drama-routes-shot-edit.test.mjs`）

**Interfaces:**
- Consumes: Task 1 的 `normalizeShot`（PATCH 处理器内部 `normalizeShot({ ...shot, ...payload }, index)`，见 `lib/drama/routes.mjs:343`）。
- Produces: 行为保证——PATCH `{ audioMode, continuity }` 会持久化，但**不**重置 `frame`、**不**重算预算、**不**使 `gateAConfirmedAt` 失效。

说明：`lib/drama/routes.mjs` 的 PATCH shot 处理器用 `normalizeShot({ ...shot, ...payload })` 合并，Task 1 后新字段自动被接受持久化，无需改 routes 代码；本任务只**补测试锁定这一行为**（防止误把新字段纳入 promptChanged/budgetChanged 分支）。

- [ ] **Step 1: 写失败/锁定测试**

先读 `tests/drama-routes-frames.test.mjs` 复用其起服务/建项目的辅助模式，新增测试：

```js
test("PATCH 编辑 audioMode/continuity 持久化且不影响首帧与预算", async () => {
  // 复用该文件既有 helper 建一个处于 awaiting_gate_a 且已确认预算的项目，
  // 对其某个 shot 先确认首帧（frame.status = "confirmed"），记录 budget.totalPaid 与 gateAConfirmedAt
  const before = /* 取项目快照 */ null;
  // PATCH 该 shot：{ audioMode: "none", continuity: "与镜 1 同场景" }
  // 断言：返回项目的该 shot.audioMode === "none"、continuity 已存；
  //       shot.frame.status 仍为 "confirmed"（未被重置）；
  //       project.gateAConfirmedAt 未变（预算未失效）。
});
```

> 注：该测试在 Task 1 前会因字段未持久化而失败；Task 1 后应直接通过。若该文件 helper 不易复用，则在测试内用 `handleDramaApi` 直接构造（参考 `tests/drama-routes-video.test.mjs` 的直接调用方式）。

- [ ] **Step 2: 跑测试确认通过**

Run: `node --test tests/drama-routes-frames.test.mjs`
Expected: PASS。

- [ ] **Step 3: Commit + push**

```bash
git add tests/drama-routes-frames.test.mjs
git commit -m "test: 锁定分镜新字段 PATCH 不误伤预算/首帧（M4）"
git push origin main
```

---

### Task 3: 新增 public/drama.css（VOZEB 浅色主题）

**Files:**
- Create: `public/drama.css`

**Interfaces:**
- Produces: 一套 `.vz-*` 作用域样式类，供 Task 4 的 `drama.html` 使用。类名以此文件为准，Task 4/5/6 的 HTML/JS 必须引用同名类。

- [ ] **Step 1: 写 drama.css**

新建 `public/drama.css`，包含：设计令牌、整体骨架（图标栏/顶栏/内容）、卡片、步骤条、分镜工作区（预览/分镜条）、检查器、表单控件、徽章、按钮、弹窗、toast、banner。完整样式如下（作用域统一挂在 `body.drama-body` 下，避免污染其它页面）：

```css
/* public/drama.css — VOZEB 浅色风（仅短剧编辑器使用） */
body.drama-body {
  --bg:#fafbfc; --card:#ffffff; --border:#e5e8ec; --text:#20242a;
  --soft:#f1f3f5; --muted:#697381; --primary:#20242a; --ok:#2fa46a; --danger:#d6453d;
  margin:0; background:var(--bg); color:var(--text);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
}
body.drama-body * { box-sizing:border-box; }
body.drama-body button { font:inherit; cursor:pointer; color:inherit; }
body.drama-body .mono { font-family:ui-monospace,"DM Mono",monospace; }
body.drama-body .hidden { display:none !important; }
body.drama-body .muted { color:var(--muted); font-size:12px; }

/* 骨架 */
.vz-app { display:grid; grid-template-columns:52px 1fr; min-height:100vh; }
.vz-rail { background:#fff; border-right:1px solid var(--border); display:flex; flex-direction:column; align-items:center; padding:10px 0; gap:6px; position:sticky; top:0; height:100vh; }
.vz-logo { width:32px; height:32px; border-radius:9px; background:var(--primary); color:#fff; display:grid; place-items:center; font-weight:800; margin-bottom:8px; }
.vz-ic { width:36px; height:36px; border:0; border-radius:9px; background:transparent; color:#8a93a0; font-size:16px; display:grid; place-items:center; }
.vz-ic.on { background:var(--soft); color:var(--text); }
.vz-ic:hover { background:var(--soft); }
.vz-main { display:flex; flex-direction:column; min-width:0; }
.vz-topbar { height:52px; background:#fff; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; padding:0 16px; gap:12px; position:sticky; top:0; z-index:5; }
.vz-topbar .t { display:flex; align-items:center; gap:8px; font-weight:600; font-size:14px; }
.vz-topbar .r { display:flex; align-items:center; gap:10px; }
.vz-content { padding:16px 18px 40px; display:flex; flex-direction:column; gap:14px; max-width:1240px; width:100%; margin:0 auto; }
.vz-card { background:var(--card); border:1px solid var(--border); border-radius:14px; }

/* 顶栏控件 */
.vz-provider { display:flex; align-items:center; gap:5px; background:#fff; border:1px solid var(--border); border-radius:8px; padding:3px 8px 3px 4px; font-size:11px; }
.vz-provider .lg { width:16px; height:16px; border-radius:5px; display:grid; place-items:center; font:700 8px ui-monospace,monospace; background:var(--soft); color:var(--text); }
.vz-provider i { width:5px; height:5px; border-radius:50%; background:#c3c9d1; }
.vz-provider[data-mode="on"] i { background:var(--ok); }
.vz-provider[data-mode="demo"] i { background:#e6b800; }
.vz-provider[data-mode="off"] i { background:#c3c9d1; }
.vz-btn { border:1px solid var(--border); background:#fff; border-radius:9px; padding:7px 13px; font-size:12px; font-weight:600; }
.vz-btn:hover { background:var(--soft); }
.vz-btn-primary { background:var(--primary); color:#fff; border-color:var(--primary); }
.vz-btn-primary:hover { background:#000; }
.vz-btn-primary:disabled { opacity:.45; cursor:not-allowed; }
.vz-select { border:1px solid var(--border); background:#fff; border-radius:9px; padding:7px 10px; font-size:12px; max-width:220px; }

/* 项目头 + 步骤条 */
.vz-projhead { padding:14px 16px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.vz-projhead h1 { font-size:16px; margin:0; }
.vz-projhead p { font-size:11px; color:var(--muted); margin:2px 0 0; }
.vz-projhead .tags { display:flex; align-items:center; gap:12px; color:var(--muted); font-size:11px; }
.vz-stepper { display:flex; gap:8px; padding:12px; list-style:none; margin:0; }
.vz-step { flex:1; display:flex; align-items:center; justify-content:center; gap:7px; padding:11px; border-radius:10px; color:#9aa3af; font-size:12px; border:1px solid transparent; background:transparent; }
.vz-step .no { font:10px ui-monospace,monospace; color:#b6bdc7; }
.vz-step.on { background:var(--primary); color:#fff; font-weight:600; }
.vz-step.on .no { color:#cbd3dc; }
.vz-step.done { color:var(--text); }

/* banner */
.vz-banner { padding:10px 14px; border-radius:10px; font-size:12px; background:#fff8e6; border:1px solid #f0e0a8; color:#7a5d00; }
.vz-banner.error { background:#fdeceb; border-color:#f3c1be; color:var(--danger); }

/* 工作区：视图切换 */
.vz-view { display:flex; flex-direction:column; gap:14px; }
/* 分镜工作区 */
.vz-story { display:grid; grid-template-columns:1fr 320px; gap:14px; align-items:start; }
.vz-preview { padding:14px; }
.vz-preview .ph { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
.vz-preview .ph b { font-size:13px; } .vz-preview .ph span { font-size:11px; color:var(--muted); }
.vz-stage { position:relative; height:420px; border-radius:12px; background:linear-gradient(150deg,#2a3140,#161a22); display:flex; align-items:center; justify-content:center; overflow:hidden; }
.vz-stage .frm { position:relative; height:88%; aspect-ratio:9/16; border-radius:10px; overflow:hidden; background:#0d1017; border:1px solid rgba(255,255,255,.15); display:flex; align-items:center; justify-content:center; }
.vz-stage .frm img, .vz-stage .frm video { width:100%; height:100%; object-fit:cover; display:block; }
.vz-stage .frm .empty { color:#8a93a0; font-size:12px; }
.vz-stage .stagetag { position:absolute; top:10px; left:11px; font-size:11px; color:#fff; background:rgba(0,0,0,.45); padding:2px 8px; border-radius:6px; }
/* 分镜条 */
.vz-strip { margin-top:12px; }
.vz-strip .sl { display:flex; justify-content:space-between; margin-bottom:7px; font-size:11px; color:var(--muted); }
.vz-film { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; }
.vz-th { position:relative; flex:0 0 84px; aspect-ratio:9/12; border-radius:10px; overflow:hidden; border:1px solid var(--border); background:#eef0f3; cursor:pointer; padding:0; }
.vz-th img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
.vz-th .num { position:absolute; left:5px; top:5px; font:700 9px ui-monospace,monospace; color:#fff; background:rgba(0,0,0,.45); padding:1px 4px; border-radius:4px; }
.vz-th .bdg { position:absolute; right:4px; top:4px; font-size:8px; padding:1px 4px; border-radius:4px; background:rgba(255,255,255,.9); color:#5a6470; }
.vz-th .bdg.dialogue { color:#2f6fd0; } .vz-th .bdg.cinematic { color:#7a5d00; }
.vz-th .ok { position:absolute; right:5px; bottom:5px; width:14px; height:14px; border-radius:50%; background:var(--primary); color:#fff; display:grid; place-items:center; font-size:8px; }
.vz-th .dur { position:absolute; left:5px; bottom:6px; font-size:9px; color:#fff; text-shadow:0 1px 2px #000; }
.vz-th.sel { border-color:var(--primary); box-shadow:0 0 0 2px rgba(32,36,42,.18); }
.vz-th.failed { border-color:var(--danger); }
/* 检查器 */
.vz-insp { padding:14px; position:sticky; top:66px; }
.vz-tabs { display:flex; gap:4px; background:var(--soft); border-radius:9px; padding:3px; }
.vz-tabs button { flex:1; border:0; background:transparent; font-size:12px; padding:6px 0; border-radius:7px; color:#8a93a0; }
.vz-tabs button.on { background:#fff; color:var(--text); font-weight:600; box-shadow:0 1px 3px rgba(0,0,0,.08); }
.vz-field { margin-top:12px; }
.vz-field > label { display:block; font-size:11px; color:#6a727e; margin-bottom:5px; font-weight:500; }
.vz-field textarea, .vz-field select, .vz-field input { width:100%; background:#fff; border:1px solid var(--border); border-radius:9px; padding:8px; font-size:12px; color:var(--text); }
.vz-field textarea { resize:vertical; line-height:1.6; }
.vz-rowline { display:flex; align-items:center; gap:8px; }
.vz-minithumb { width:44px; height:62px; border-radius:8px; border:1px solid var(--border); object-fit:cover; background:#eef0f3; }
.vz-seg { display:grid; grid-template-columns:1fr 1fr; gap:4px; }
.vz-seg button { text-align:center; font-size:11px; padding:7px 0; border:1px solid var(--border); border-radius:8px; color:#8a93a0; background:#fff; }
.vz-seg button.on { color:#fff; background:var(--primary); border-color:var(--primary); font-weight:600; }
.vz-apply { width:100%; margin-top:14px; background:var(--primary); color:#fff; border:0; border-radius:10px; padding:11px; font-size:12px; font-weight:700; }
.vz-hint { font-size:10px; color:var(--muted); text-align:center; margin-top:7px; }
/* 角色卡 / 预算 */
.vz-char { border:1px solid var(--border); border-radius:10px; padding:10px; margin-top:8px; }
.vz-char .bind-row { display:flex; align-items:center; gap:8px; font-size:11px; margin-top:6px; }
.vz-char .bind-row select { flex:1; min-width:0; }
.vz-budget-row { display:flex; justify-content:space-between; font-size:12px; padding:6px 0; }
.vz-budget-row span { color:var(--muted); }
.vz-budget-total { display:flex; justify-content:space-between; margin-top:10px; padding-top:10px; border-top:1px solid var(--border); font-size:14px; }
.vz-progress { flex:1; height:6px; border-radius:99px; background:var(--soft); overflow:hidden; }
.vz-progress i { display:block; height:100%; background:var(--primary); }
/* 弹窗 / toast */
.vz-modal { position:fixed; inset:0; display:none; align-items:center; justify-content:center; background:rgba(15,17,20,.45); z-index:50; }
.vz-modal.open { display:flex; }
.vz-modal-card { width:min(480px,92vw); background:#fff; border:1px solid var(--border); border-radius:16px; padding:22px; }
.vz-modal-actions { display:flex; justify-content:flex-end; gap:10px; margin-top:18px; }
.vz-toast-wrap { position:fixed; right:18px; bottom:18px; z-index:80; display:grid; gap:8px; }
.vz-toast { width:300px; padding:12px 14px; border:1px solid var(--border); border-radius:11px; background:#fff; box-shadow:0 18px 45px rgba(0,0,0,.18); }
.vz-toast b { display:block; font-size:12px; } .vz-toast span { color:var(--muted); font-size:11px; }
.vz-toast.error { border-color:#f3c1be; } .vz-toast.success { border-color:#b7e2c8; }
@media (max-width:1100px) { .vz-story { grid-template-columns:1fr; } .vz-insp { position:static; } }
```

- [ ] **Step 2: 校验文件存在且可被服务**

Run: `node --check public/drama.css 2>/dev/null || echo "css 无语法检查，跳过"; ls -la public/drama.css`
Expected: 文件存在。（CSS 无 node 语法检查，靠 Task 6 手动视觉核对。）

- [ ] **Step 3: Commit + push**

```bash
git add public/drama.css
git commit -m "feat: 新增短剧编辑器 VOZEB 浅色主题样式（M4）"
git push origin main
```

---

### Task 4: 重构 public/drama.html（舞台化骨架）

**Files:**
- Modify: `public/drama.html`（整体重写）

**Interfaces:**
- Produces: 一组容器元素 ID 供 drama.js 渲染：`#projHead`、`#stepper`、`#viewScript`、`#viewAssets`、`#viewStory`、`#viewGenerate`、`#preview`、`#strip`、`#inspector`、`#gateAModal`、`#toastWrap`、`#errorBanner`、`#mockBanner`，以及顶栏 `#llmStatus`、`#comfyStatus`、`#projectSelect`、`#newProjectBtn`、`#demoBtn`、`#runPipelineBtn`。所有 ID 是 Task 5/6 的渲染挂载点。

- [ ] **Step 1: 重写 drama.html**

完整替换 `public/drama.html` 为：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>短剧工作台 · Digital Human Studio</title>
  <link rel="stylesheet" href="drama.css" />
</head>
<body class="drama-body">
  <div class="vz-app">
    <aside class="vz-rail">
      <div class="vz-logo">剧</div>
      <button class="vz-ic on" data-view="script" title="剧本">▤</button>
      <button class="vz-ic" data-view="assets" title="资产">◉</button>
      <button class="vz-ic" data-view="story" title="分镜">▦</button>
      <button class="vz-ic" data-view="generate" title="生成">▶</button>
    </aside>

    <div class="vz-main">
      <header class="vz-topbar">
        <div class="t">▦ 短剧项目</div>
        <div class="r">
          <span class="vz-provider" id="llmStatus"><span class="lg">LL</span>编排模型<i></i></span>
          <span class="vz-provider" id="comfyStatus"><span class="lg">C</span>ComfyUI<i></i></span>
          <select id="projectSelect" class="vz-select"></select>
          <button class="vz-btn" id="newProjectBtn">新建</button>
          <button class="vz-btn" id="demoBtn">演示剧本</button>
          <button class="vz-btn vz-btn-primary" id="runPipelineBtn">开始解析</button>
        </div>
      </header>

      <div class="vz-content">
        <div class="vz-banner hidden" id="mockBanner">演示编排模式：未配置 DRAMA_LLM_*，由本机确定性 mock 驱动，不产生费用。</div>
        <div class="vz-banner error hidden" id="errorBanner"></div>

        <section class="vz-card vz-projhead" id="projHead"></section>
        <ol class="vz-card vz-stepper" id="stepper"></ol>

        <!-- 剧本视图 -->
        <section class="vz-view" id="viewScript">
          <div class="vz-card" style="padding:14px">
            <input id="dramaTitle" class="vz-select" style="width:100%;max-width:none" maxlength="80" placeholder="短剧标题" />
            <textarea id="dramaScript" spellcheck="false" placeholder="粘贴或输入短剧剧本（50–20000 字）…" style="width:100%;min-height:260px;margin-top:10px;border:1px solid var(--border);border-radius:9px;padding:10px"></textarea>
            <div style="display:flex;justify-content:space-between;margin-top:8px"><span class="muted" id="dramaCharCount">0 字</span><span class="muted" id="projectStatus">未开始</span></div>
          </div>
          <div class="vz-card" style="padding:14px">
            <b style="font-size:13px">编排流水线</b>
            <ol class="stage-list" id="stageList" style="list-style:none;padding:0;margin:10px 0 0;display:flex;flex-direction:column;gap:6px">
              <li data-stage="analyze">剧本分析 <em class="muted"></em></li>
              <li data-stage="direct">导演分镜 <em class="muted"></em></li>
              <li data-stage="prompt">提示词 <em class="muted"></em></li>
              <li data-stage="review">文本审核 <em class="muted"></em></li>
            </ol>
            <button class="vz-btn hidden" id="resumeBtn" style="margin-top:10px">从失败阶段续跑</button>
          </div>
        </section>

        <!-- 资产视图 -->
        <section class="vz-view hidden" id="viewAssets">
          <div class="vz-card" style="padding:14px"><b style="font-size:13px">角色资产卡</b><div id="characterList"></div></div>
        </section>

        <!-- 分镜视图（旗舰） -->
        <section class="vz-view hidden" id="viewStory">
          <div class="vz-story">
            <div class="vz-card vz-preview">
              <div class="ph"><b>分镜预览</b><span id="previewMeta">未选镜</span></div>
              <div class="vz-stage" id="preview"><div class="frm"><span class="empty">运行流水线后展示分镜</span></div></div>
              <div class="vz-strip">
                <div class="sl"><span>STORYBOARD</span><span id="stripMeta"></span></div>
                <div class="vz-film" id="strip"></div>
              </div>
            </div>
            <aside class="vz-card vz-insp" id="inspector"></aside>
          </div>
        </section>

        <!-- 生成视图 -->
        <section class="vz-view hidden" id="viewGenerate">
          <div class="vz-card" style="padding:14px">
            <b style="font-size:13px">预算单（预估）</b>
            <div id="budgetLines"></div>
            <div class="vz-budget-total"><span>预计付费合计</span><b id="budgetTotal">—</b></div>
            <button class="vz-btn vz-btn-primary hidden" id="gateABtn" style="margin-top:10px">确认预算，进入首帧生成</button>
            <p class="muted" style="margin-top:8px">首帧使用本机算力（¥0）。视频单价为预估值，实际以供应商扣费为准。</p>
          </div>
          <div class="vz-card" style="padding:14px">
            <b style="font-size:13px">首帧与视频确认</b>
            <div class="vz-rowline" style="margin-top:8px"><span class="muted" style="width:40px">首帧</span><div class="vz-progress"><i id="gateBProgress"></i></div><span class="muted" id="gateBText">0/0</span></div>
            <div class="vz-rowline" style="margin-top:8px"><span class="muted" style="width:40px">视频</span><div class="vz-progress"><i id="clipProgress"></i></div><span class="muted" id="clipText">0/0</span></div>
            <div class="vz-banner hidden" id="doneBanner" style="margin-top:10px"></div>
            <button class="vz-btn hidden" id="genAllFramesBtn" style="margin-top:10px">生成全部首帧</button>
          </div>
        </section>
      </div>
    </div>
  </div>

  <div class="vz-modal" id="gateAModal" aria-hidden="true">
    <div class="vz-modal-card">
      <h3>确认短剧预算</h3>
      <div id="modalBudgetLines"></div>
      <div class="vz-budget-total"><span>预计付费合计</span><b id="modalBudgetTotal"></b></div>
      <p class="muted" style="margin-top:8px">确认后才会开始进一步操作；首帧生成不产生费用。台词或时长变更会使确认失效。</p>
      <div class="vz-modal-actions">
        <button class="vz-btn" id="gateACancel">再改改</button>
        <button class="vz-btn vz-btn-primary" id="gateAConfirm">确认预算</button>
      </div>
    </div>
  </div>

  <div id="toastWrap" class="vz-toast-wrap"></div>
  <script src="drama.js"></script>
</body>
</html>
```

- [ ] **Step 2: 校验语法**

Run: `node --check public/drama.html 2>/dev/null || echo "html 无 node 检查"; grep -c 'id="' public/drama.html`
Expected: 文件包含上述容器 ID。

> 注意：此时 drama.js 仍指向旧 ID，页面会报错——这是预期，Task 5/6 会重写 drama.js 对齐。本步只提交骨架。

- [ ] **Step 3: Commit + push**

```bash
git add public/drama.html
git commit -m "refactor: 短剧编辑器舞台化骨架（图标栏/步骤条/四视图，M4）"
git push origin main
```

---

### Task 5: drama.js — 基础设施 + 视图切换 + 步骤条 + 剧本/资产/生成视图

**Files:**
- Modify: `public/drama.js`（重写渲染层，保留动作层）

**Interfaces:**
- Consumes: Task 4 的容器 ID；Task 1 的 shot 新字段。
- Produces: 视图切换 `setView(name)`、渲染函数 `renderStepper/renderProjHead/renderStages/renderCharacters/renderBudget/renderGateB/renderProject`，以及状态 `state.view`、`state.selectedShotId`。Task 6 依赖 `state.selectedShotId` 与 `setView`。

**保留清单（逐字保留现有函数，不得重写）：** `api`、`toast`、`showError`、`loadHealth`、`setProvider`、`loadProjects`、`loadProject`、`createProject`、`saveCharacter`、`frameUrl`、`isEditable`、`frameStatusText`、`boundCharacter`、`videoBlockReason`、`canGenerateVideo`、`generateVideo`、`confirmVideo`、`saveShot`、`runPipeline`、`generateFrame`、`generateAllFrames`、`confirmFrame`、`openGateAModal`、`closeGateAModal`、`confirmGateA`、`schedulePoll`、`loadCatalogs`。其中 `loadHealth`/`setProvider` 需适配：`setProvider` 操作 `data-mode` 与文本，顶栏供应商节点结构变为 `<span class="vz-provider"><span class="lg">..</span>名称<i></i></span>`，无 `small` 元素——把 `setProvider` 改为只在 `title` 上显示文案：

```js
function setProvider(node, mode, label) {
  node.dataset.mode = mode;
  node.title = label;
}
```

- [ ] **Step 1: 改 state 加视图与选中镜**

把 `state` 改为：

```js
const state = {
  project: null,
  projects: [],
  avatars: [],
  voices: [],
  pollTimer: null,
  view: "script",          // script | assets | story | generate
  selectedShotId: null
};
```

- [ ] **Step 2: 新增视图切换与步骤条/项目头渲染**

```js
const VIEWS = ["script", "assets", "story", "generate"];
const STEPPER = [
  { key: "script", no: "01", label: "剧本" },
  { key: "assets", no: "03", label: "视觉资产" },
  { key: "story", no: "04", label: "分镜" },
  { key: "generate", no: "05", label: "镜头生成" }
];

function setView(name) {
  if (!VIEWS.includes(name)) return;
  state.view = name;
  $$(".vz-ic[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
  $("#viewScript").classList.toggle("hidden", name !== "script");
  $("#viewAssets").classList.toggle("hidden", name !== "assets");
  $("#viewStory").classList.toggle("hidden", name !== "story");
  $("#viewGenerate").classList.toggle("hidden", name !== "generate");
  renderStepper();
}

function currentStageKey(project) {
  if (!project || !project.analysis) return "script";
  if (["analyzing", "directing", "prompting", "reviewing"].includes(project.status)) return "script";
  if (!project.gateAConfirmedAt) return "assets";
  if (!project.shots.every((s) => s.frame.status === "confirmed")) return "story";
  return "generate";
}

function renderStepper() {
  const project = state.project;
  const active = currentStageKey(project);
  const box = $("#stepper");
  box.innerHTML = "";
  for (const s of STEPPER) {
    const li = document.createElement("li");
    li.className = "vz-step" + (s.key === active ? " on" : "");
    li.innerHTML = `<span class="no">${s.no}</span>${s.label}`;
    li.addEventListener("click", () => setView(s.key));
    box.append(li);
  }
}

function renderProjHead(project) {
  const box = $("#projHead");
  const shotCount = project ? project.shots.length : 0;
  box.innerHTML = "";
  const left = document.createElement("div");
  left.innerHTML = `<h1>${project ? project.title : "新建短剧"}</h1><p>完善剧本与角色后，再逐镜头生成视频。</p>`;
  const tags = document.createElement("div");
  tags.className = "tags";
  tags.innerHTML = `<span>${project ? (project.ratio === "portrait" ? "9:16" : project.ratio) : "9:16"}</span><span>${shotCount} 个镜头</span>`;
  box.append(left, tags);
}
```

- [ ] **Step 3: renderProject 改为驱动新视图**

保留现有 `renderCharacters`、`renderBudget`、`renderGateB`、`renderStages` 逻辑（仅适配新容器 ID，见下），并把 `renderProject` 改为：

```js
function renderProject() {
  const project = state.project;
  if (!project) return;
  showError(null);
  $("#dramaTitle").value = project.title;
  if (document.activeElement !== $("#dramaScript")) $("#dramaScript").value = project.script;
  $("#dramaCharCount").textContent = `${project.script.replace(/\s/g, "").length} 字`;
  $("#projectStatus").textContent = STATUS_LABEL[project.status] || project.status;
  renderProjHead(project);
  renderStepper();
  renderStages(project);
  renderCharacters(project);
  renderStory(project);   // Task 5 先实现 strip+preview；Task 6 加 inspector
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
```

`renderStages` 适配：旧选择器 `$$("#stageList li")` 不变，`em` 文案逻辑不变（旧 HTML 已保留 `#stageList li[data-stage]` 结构）。

- [ ] **Step 4: 事件绑定（视图切换 + 保留既有绑定）**

在文件底部事件绑定区，新增视图切换；保留 runPipeline/resume/gateA/genAllFrames/projectSelect/newProject/demo/charCount 等既有绑定；删除旧的 `$$("[data-anchor]")` 滚动绑定：

```js
$$(".vz-ic[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
```

- [ ] **Step 5: 校验 + 手动核对**

Run: `node --check public/drama.js && npm run smoke 2>&1 | tail -5`
Expected: 语法通过；smoke 通过（后端未变）。手动 `npm start` 打开 `/`：浅色骨架、图标栏可切换 剧本/资产/生成 视图，步骤条可见。分镜视图暂由 Task 6 补 `renderStory`，本任务先给占位：

```js
function renderStory(project) {
  $("#stripMeta").textContent = `${project.shots.length} 镜`;
  $("#strip").innerHTML = '<p class="muted">分镜条见下一任务</p>';
  $("#inspector").innerHTML = '<p class="muted">检查器见下一任务</p>';
}
```

- [ ] **Step 6: Commit + push**

```bash
git add public/drama.js
git commit -m "refactor: 编辑器视图切换与步骤条，迁移剧本/资产/生成视图（M4）"
git push origin main
```

---

### Task 6: drama.js — 分镜条 + 大预览 + 检查器（细粒度编辑）

**Files:**
- Modify: `public/drama.js`（替换 Task 5 的 `renderStory` 占位，新增 `renderStrip/renderPreview/renderInspector/selectShot`）

**Interfaces:**
- Consumes: Task 5 的 `state.selectedShotId`、`setView`、`renderStory` 挂载点；Task 1 的 `audioMode/continuity`；保留动作函数 `saveShot/generateFrame/confirmFrame/generateVideo/confirmVideo`。
- Produces: `renderStory(project)`（编排 strip+preview+inspector）、`selectShot(shotId)`、`renderInspector(project, shot)`。

- [ ] **Step 1: 选中态 + renderStory 编排**

```js
function selectShot(shotId) {
  state.selectedShotId = shotId;
  renderStory(state.project);
}

function currentShot(project) {
  if (!project || !project.shots.length) return null;
  return project.shots.find((s) => s.id === state.selectedShotId) || project.shots[0];
}

function renderStory(project) {
  renderStrip(project);
  const shot = currentShot(project);
  renderPreview(project, shot);
  renderInspector(project, shot);
}
```

- [ ] **Step 2: 分镜条 renderStrip**

```js
function renderStrip(project) {
  const box = $("#strip");
  box.innerHTML = "";
  $("#stripMeta").textContent = `${project.shots.length} 镜 · 点击选镜`;
  if (!project.shots.length) { box.innerHTML = '<p class="muted">运行流水线后展示分镜</p>'; return; }
  for (const shot of project.shots) {
    const th = document.createElement("button");
    th.className = "vz-th" + (shot.id === (currentShot(project)?.id) ? " sel" : "") + (shot.frame.status === "failed" ? " failed" : "");
    const url = frameUrl(project, shot);
    if (url) { const img = document.createElement("img"); img.src = url; img.alt = `镜${shot.index}`; th.append(img); }
    const num = document.createElement("span"); num.className = "num"; num.textContent = shot.index; th.append(num);
    const bdg = document.createElement("span"); bdg.className = `bdg ${shot.shotType}`; bdg.textContent = shot.shotType === "dialogue" ? "词" : "画"; th.append(bdg);
    const dur = document.createElement("span"); dur.className = "dur"; dur.textContent = `${shot.durationSec}s`; th.append(dur);
    if (shot.frame.status === "confirmed") { const ok = document.createElement("span"); ok.className = "ok"; ok.textContent = "✓"; th.append(ok); }
    th.addEventListener("click", () => selectShot(shot.id));
    box.append(th);
  }
}
```

- [ ] **Step 3: 大预览 renderPreview**

```js
function renderPreview(project, shot) {
  const stage = $("#preview");
  const meta = $("#previewMeta");
  if (!shot) { stage.innerHTML = '<div class="frm"><span class="empty">运行流水线后展示分镜</span></div>'; meta.textContent = "未选镜"; return; }
  meta.textContent = `镜 ${shot.index} / ${project.shots.length} · ${shot.shotType === "dialogue" ? "口播镜" : "剧情镜"} · ${shot.durationSec}s`;
  stage.innerHTML = "";
  const tag = document.createElement("span"); tag.className = "stagetag"; tag.textContent = `镜 ${shot.index}`; stage.append(tag);
  const frm = document.createElement("div"); frm.className = "frm";
  const clip = shot.clip || { status: "pending" };
  if (clip.file) {
    const v = document.createElement("video"); v.controls = true; v.preload = "metadata"; v.src = `/drama-files/${project.id}/${clip.file}`; frm.append(v);
  } else if (frameUrl(project, shot)) {
    const img = document.createElement("img"); img.src = frameUrl(project, shot); img.alt = `镜${shot.index}首帧`; frm.append(img);
  } else {
    const s = document.createElement("span"); s.className = "empty"; s.textContent = frameStatusText(shot) || "待生成首帧"; frm.append(s);
  }
  stage.append(frm);
}
```

- [ ] **Step 4: 检查器 renderInspector（细粒度编辑 + 新字段）**

```js
function renderInspector(project, shot) {
  const box = $("#inspector");
  box.innerHTML = "";
  if (!shot) { box.innerHTML = '<p class="muted">选中一个分镜以编辑</p>'; return; }
  const tabs = document.createElement("div"); tabs.className = "vz-tabs";
  const tabShot = document.createElement("button"); tabShot.className = "on"; tabShot.textContent = "分镜";
  tabs.append(tabShot); box.append(tabs);

  const editable = isEditable(project);
  const mkField = (label, node) => { const f = document.createElement("div"); f.className = "vz-field"; const l = document.createElement("label"); l.textContent = label; f.append(l, node); return f; };

  const dialogue = document.createElement("textarea"); dialogue.value = shot.dialogue; dialogue.placeholder = "台词（口播镜必填）"; dialogue.disabled = !editable;
  dialogue.addEventListener("change", () => saveShot(project, shot.id, { dialogue: dialogue.value }));
  box.append(mkField(`台词（镜 ${shot.index}）`, dialogue));

  const prompt = document.createElement("textarea"); prompt.value = shot.fluxPrompt; prompt.disabled = !editable; prompt.style.minHeight = "70px";
  prompt.addEventListener("change", () => saveShot(project, shot.id, { fluxPrompt: prompt.value }));
  box.append(mkField("Flux 首帧提示词", prompt));

  const cam = document.createElement("select"); ["close-up","medium","wide","over-shoulder","low-angle"].forEach((c) => { const o = document.createElement("option"); o.value = c; o.textContent = c; cam.append(o); });
  cam.value = shot.camera; cam.disabled = !editable;
  cam.addEventListener("change", () => saveShot(project, shot.id, { camera: cam.value }));
  const dur = document.createElement("input"); dur.type = "number"; dur.min = "2"; dur.max = "15"; dur.value = shot.durationSec; dur.disabled = !editable;
  dur.addEventListener("change", () => saveShot(project, shot.id, { durationSec: Number(dur.value) }));
  const row = document.createElement("div"); row.className = "vz-rowline"; row.append(cam, dur);
  box.append(mkField("运镜 · 时长(s)", row));

  const seg = document.createElement("div"); seg.className = "vz-seg";
  [["voice","配音"],["none","静音"]].forEach(([val,label]) => { const b = document.createElement("button"); b.textContent = label; b.className = shot.audioMode === val ? "on" : ""; b.disabled = !editable; b.addEventListener("click", () => saveShot(project, shot.id, { audioMode: val })); seg.append(b); });
  box.append(mkField("音频模式", seg));

  const cont = document.createElement("input"); cont.type = "text"; cont.value = shot.continuity || ""; cont.placeholder = "如：与镜 2 同场景"; cont.maxLength = 120; cont.disabled = !editable;
  cont.addEventListener("change", () => saveShot(project, shot.id, { continuity: cont.value }));
  box.append(mkField("连续性 / 衔接", cont));

  const frameRow = document.createElement("div"); frameRow.className = "vz-rowline";
  if (frameUrl(project, shot)) { const t = document.createElement("img"); t.className = "vz-minithumb"; t.src = frameUrl(project, shot); frameRow.append(t); }
  const genBtn = document.createElement("button"); genBtn.className = "vz-btn"; genBtn.textContent = ["ready","confirmed"].includes(shot.frame.status) ? "↻ 换抽" : "生成首帧";
  genBtn.disabled = !project.gateAConfirmedAt || shot.frame.status === "generating";
  genBtn.addEventListener("click", () => generateFrame(project, shot.id)); frameRow.append(genBtn);
  if (shot.frame.status === "ready") { const c = document.createElement("button"); c.className = "vz-btn vz-btn-primary"; c.textContent = "确认首帧"; c.addEventListener("click", () => confirmFrame(project, shot.id)); frameRow.append(c); }
  box.append(mkField("首帧", frameRow));

  const reason = videoBlockReason(project, shot);
  const clip = shot.clip || { status: "pending" };
  const vBtn = document.createElement("button"); vBtn.className = "vz-apply";
  vBtn.textContent = ["ready","confirmed"].includes(clip.status) ? "重新生成视频" : "生成视频";
  vBtn.disabled = !canGenerateVideo(project, shot) || clip.status === "generating"; vBtn.title = reason;
  vBtn.addEventListener("click", () => generateVideo(project, shot)); box.append(vBtn);
  if (clip.status === "ready") { const c = document.createElement("button"); c.className = "vz-btn vz-btn-primary"; c.style.marginTop = "8px"; c.style.width = "100%"; c.textContent = "确认视频"; c.addEventListener("click", () => confirmVideo(project, shot.id)); box.append(c); }
  if (reason) { const h = document.createElement("div"); h.className = "vz-hint"; h.textContent = reason; box.append(h); }
}
```

- [ ] **Step 5: 校验 + 手动核对**

Run: `node --check public/drama.js && npm run smoke 2>&1 | tail -5`
Expected: 通过。手动 `npm start`：分镜条可点选、大预览联动、检查器可编辑台词/提示词/运镜/时长/音频模式/连续性、换抽与生成视频按钮按闸门/绑定正确禁用。

- [ ] **Step 6: Commit + push**

```bash
git add public/drama.js
git commit -m "feat: 分镜条 + 大预览 + 检查器细粒度编辑（M4）"
git push origin main
```

---

### Task 7: check / smoke / 全量验证与手动验收

**Files:**
- Modify: `package.json`（`check` 脚本）、`scripts/smoke.mjs`

**Interfaces:**
- Consumes: 前面所有任务。

- [ ] **Step 1: check 脚本纳入新前端文件**

`package.json` 的 `check` 已是 `node --check public/drama.js`（无需新增 css/html）；确认 `public/drama.js` 在内即可。

- [ ] **Step 2: smoke 增加新字段守卫断言**

在 `scripts/smoke.mjs` 的短剧链路中，对某个 shot PATCH `{ audioMode: "none", continuity: "回归" }` 后断言返回项目该 shot 字段已存且 `gateAConfirmedAt` 未因此次编辑单独失效（仅台词/时长才失效）。参考既有 `bindBad` 断言写法。

- [ ] **Step 3: 全量验证**

Run: `npm run check && npm run test:unit && npm run smoke`
Expected: 全部通过。

- [ ] **Step 4: 手动验收（对照验收标准）**

`npm start` 打开 `/`：①浅色 VOZEB 风 + 图标栏/步骤条/四视图；②分镜条可点选、大预览联动；③检查器可编辑并保存，改台词/时长预算失效；④首帧换抽、闸门 A/B、逐镜视频生成/确认照常。

- [ ] **Step 5: Commit + push**

```bash
git add package.json scripts/smoke.mjs
git commit -m "test: 短剧编辑器 M4 冒烟与检查更新"
git push origin main
```

---

## Self-Review 记录

- **规格覆盖**：视觉主题(T3)、舞台骨架(T4)、视图/步骤条(T5)、分镜条/预览/检查器(T6)、新字段(T1/T2)、验证(T7)——覆盖 spec 全部 M4 范围。M5+ 明确不做。
- **占位符**：T2 测试含项目构造 helper 需按既有测试文件模式落地（已注明参考文件），其余步骤均含真实代码。
- **类型一致**：`audioMode:"voice"|"none"`、`continuity:string`、`state.selectedShotId`、`setView`、`renderStory/renderStrip/renderPreview/renderInspector/selectShot` 在 T5/T6 间一致；`frameUrl/isEditable/videoBlockReason/canGenerateVideo/saveShot/generateFrame/confirmFrame/generateVideo/confirmVideo` 为保留的既有函数，签名不变。
