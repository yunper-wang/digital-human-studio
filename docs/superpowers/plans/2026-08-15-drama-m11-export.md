# 短剧工作台 M11：成片导出发布实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** compose 成功后生成封面图（首镜首帧）+ 元数据 JSON + 一键 ZIP 打包（mp4+srt+封面+元数据，store 模式不压缩，手写零依赖）。

**Architecture:** `buildMeta(project)` 派生元数据；`buildZipBuffer(files)` 手写 ZIP store 模式（CRC32+local header+central dir+end record）；compose.mjs 收尾复制首帧为 cover.png + 写 meta.json；`GET /api/drama/projects/{id}/export/zip` 流式响应；前端加「打包 ZIP」按钮。

**Tech Stack:** 零框架原生 HTML/CSS/JS；Node 20+；`node:test`；零 npm 依赖（ZIP 手写）。

**Spec:** `docs/superpowers/specs/2026-08-15-drama-m11-export-design.md`

## Global Constraints

- 零框架、无构建链、不引入新 npm 依赖；本机优先、私密不出本机。
- 中文提交信息（`类型: 简短描述`）；遵循既有 `lib/drama/*` 与 `tests/drama-*.test.mjs` 模式。
- 既有 compose 链路零回归；封面/元数据失败不阻塞成片。
- ZIP store 模式不压缩（mp4/srt 已压缩）；手写零依赖。

---

## 阶段 A：元数据与 ZIP 核心

### Task 1: export.mjs —— buildMeta + buildZipBuffer

**Files:**
- Create: `lib/drama/export.mjs`
- Test: `tests/drama-export.test.mjs`

**Interfaces:**
- Consumes: project 对象（analysis/shots/title/ratio/createdAt）
- Produces: `buildMeta(project)` → `{ title, synopsis, genre, characters[{name,role}], shotCount, totalDurationSec, ratio, createdAt, exportedAt }`；`buildZipBuffer(files)` → Buffer（files: `[{ name, bytes }]`，store 模式合法 zip）

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-export.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildMeta, buildZipBuffer } from "../lib/drama/export.mjs";

test("buildMeta 从 project 派生元数据", () => {
  const project = {
    title: "雨夜", ratio: "portrait", createdAt: "2026-08-01T00:00:00.000Z",
    analysis: { synopsis: "偶遇", genre: "都市", characters: [{ name: "林晚", role: "主角" }, { name: "阿明", role: "配角" }] },
    shots: [{ durationSec: 3 }, { durationSec: 5 }]
  };
  const m = buildMeta(project);
  assert.equal(m.title, "雨夜");
  assert.equal(m.synopsis, "偶遇");
  assert.equal(m.genre, "都市");
  assert.deepEqual(m.characters, [{ name: "林晚", role: "主角" }, { name: "阿明", role: "配角" }]);
  assert.equal(m.shotCount, 2);
  assert.equal(m.totalDurationSec, 8);
  assert.equal(m.ratio, "portrait");
  assert.equal(m.createdAt, "2026-08-01T00:00:00.000Z");
  assert.ok(m.exportedAt); // ISO 时间戳
});

test("buildZipBuffer 产出合法 ZIP（store 模式）", () => {
  const files = [
    { name: "a.txt", bytes: Buffer.from("hello") },
    { name: "b.bin", bytes: Buffer.from([0, 1, 2, 3]) }
  ];
  const zip = buildZipBuffer(files);
  // local file header magic: PK\x03\x04
  assert.equal(zip[0], 0x50); assert.equal(zip[1], 0x4b); assert.equal(zip[2], 0x03); assert.equal(zip[3], 0x04);
  // end of central directory record magic: PK\x05\x06
  const endSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  assert.ok(zip.slice(-22).includes(endSig));
  // 包含文件名 a.txt
  assert.ok(zip.toString("latin1").includes("a.txt"));
  // 大小合理（header + 数据 + central）
  assert.ok(zip.length > files[0].bytes.length + files[1].bytes.length);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-export.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

新建 `lib/drama/export.mjs`：

```js
// lib/drama/export.mjs
// 成片导出：元数据派生 + ZIP store 模式打包（零依赖手写）
import { writeFileSync } from "node:fs";

export function buildMeta(project) {
  return {
    title: String(project.title || "未命名"),
    synopsis: project.analysis?.synopsis || "",
    genre: project.analysis?.genre || "",
    characters: (project.analysis?.characters || []).map((c) => ({ name: c.name, role: c.role })),
    shotCount: (project.shots || []).length,
    totalDurationSec: (project.shots || []).reduce((sum, s) => sum + (Number(s.durationSec) || 0), 0),
    ratio: project.ratio || "portrait",
    createdAt: project.createdAt || new Date().toISOString(),
    exportedAt: new Date().toISOString()
  };
}

// CRC32 表（运行期生成一次）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// 手写 ZIP store 模式（不压缩，mp4/srt 已压缩）；返回 Buffer
export function buildZipBuffer(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.bytes);
    const size = f.bytes.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(0, 8);           // compression: store
    local.writeUInt16LE(0, 10);          // mod time
    local.writeUInt16LE(0, 12);          // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);       // compressed size
    local.writeUInt32LE(size, 22);       // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);          // extra length
    chunks.push(local, name, f.bytes);
    const ce = Buffer.alloc(46);
    ce.writeUInt32LE(0x02014b50, 0); // central dir entry signature
    ce.writeUInt16LE(20, 4);
    ce.writeUInt16LE(0, 8);
    ce.writeUInt16LE(0, 10);
    ce.writeUInt16LE(0, 12);
    ce.writeUInt16LE(0, 14);
    ce.writeUInt32LE(crc, 16);
    ce.writeUInt32LE(size, 20);
    ce.writeUInt32LE(size, 24);
    ce.writeUInt16LE(name.length, 28);
    ce.writeUInt16LE(0, 30);
    ce.writeUInt16LE(0, 32);
    ce.writeUInt16LE(0, 34);
    ce.writeUInt32LE(0, 36);
    ce.writeUInt32LE(offset, 42); // local header offset
    central.push(ce, name);
    offset += local.length + name.length + f.bytes.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) centralSize += c.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central dir record
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, end]);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-export.test.mjs && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/export.mjs tests/drama-export.test.mjs
git commit -m "feat: 元数据派生与 ZIP store 打包（M11 Task1）"
```

---

## 阶段 B：compose 收尾 + schema + 端点

### Task 2: schema normalizeCompose cover/meta + compose 收尾生成

**Files:**
- Modify: `lib/drama/schema.mjs`（normalizeCompose 加 cover/meta）
- Modify: `lib/drama/compose.mjs`（收尾复制首帧 cover.png + 写 meta.json + 回写）
- Test: `tests/drama-schema.test.mjs`、`tests/drama-compose.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `buildMeta`
- Produces: `normalizeCompose` 返回含 `cover`/`meta` 字段；compose 成功后 `compose.cover`/`compose.meta` 落盘文件名

- [ ] **Step 1: 写失败测试**

在 `tests/drama-schema.test.mjs` 末尾追加：

```js
test("M11：normalizeCompose cover/meta 归一化", () => {
  const c = normalizeCompose({ status: "succeeded", file: "final.mp4", srtFile: "film.srt", cover: "cover.png", meta: "meta.json" });
  assert.equal(c.cover, "cover.png");
  assert.equal(c.meta, "meta.json");
  const c2 = normalizeCompose({ status: "idle" });
  assert.equal(c2.cover, null);
  assert.equal(c2.meta, null);
});
```

在 `tests/drama-compose.test.mjs` 末尾追加（复用该文件已有 fixture 模式；实现者按实际 fixture 调整）：

```js
test("M11：compose 成功后生成 cover.png + meta.json", async () => {
  // 复用该文件已建好的 clips_ready fixture 项目
  // 关键断言：compose 成功后 project.compose.cover/meta 非空 + 文件存在
  // 实现者按 drama-compose.test.mjs 现有 fixture 结构补全 ctx/project
  const dir = mkdtempSync(join(tmpdir(), "drama-m11c-"));
  try {
    const store = { /* mock store with dir/get/update */ dir: (id) => join(dir, id), get: () => project, update: (id, fn) => { fn(project); } };
    // ... 建项目 + shots[0].frame.file + compose mock runFfmpeg
    // await composeFilm(ctx, projectId)
    // assert project.compose.cover === "cover.png"
    // assert existsSync(join(dir, projectId, "compose", "cover.png"))
    // assert existsSync(join(dir, projectId, "compose", "meta.json"))
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

（注：此测试需复用 `tests/drama-compose.test.mjs` 已有的 fixture 项目结构；实现者按该文件实际 fixture 补全 mock，关键断言是 cover/meta 落盘）

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-schema.test.mjs && node --test tests/drama-compose.test.mjs`
Expected: FAIL（cover/meta undefined）

- [ ] **Step 3: 实现**

`lib/drama/schema.mjs` `normalizeCompose` 返回对象加（在 `finishedAt` 后）：

```js
    cover: typeof raw?.cover === "string" && raw.cover ? raw.cover : null,
    meta: typeof raw?.meta === "string" && raw.meta ? raw.meta : null
```

`lib/drama/compose.mjs` import 区加：

```js
import { existsSync, copyFileSync } from "node:fs";
import { buildMeta } from "./export.mjs";
```

注：`writeFileSync` 已 import，加 `existsSync, copyFileSync`。

compose 收尾（`setCompose({ status: "succeeded", ... })` 前，L68 之前）加：

```js
    // M11：生成封面（首镜 confirmed 首帧 png 复制）+ 元数据；失败不阻塞成片
    let cover = null;
    let meta = null;
    try {
      const firstConfirmed = project.shots.find((s) => s.frame?.status === "confirmed");
      const firstShot = firstConfirmed || project.shots[0];
      if (firstShot?.frame?.file) {
        const coverSrc = join(store.dir(projectId), "frames", firstShot.frame.file);
        if (existsSync(coverSrc)) { copyFileSync(coverSrc, join(composeDir, "cover.png")); cover = "cover.png"; }
      }
      writeFileSync(join(composeDir, "meta.json"), JSON.stringify(buildMeta(project), null, 2));
      meta = "meta.json";
    } catch { /* 封面/元数据失败不阻塞成片 */ }
    setCompose({ status: "succeeded", file: current, srtFile, cover, meta, finishedAt: new Date().toISOString() });
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-schema.test.mjs && node --test tests/drama-compose.test.mjs && npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/schema.mjs lib/drama/compose.mjs tests/drama-schema.test.mjs tests/drama-compose.test.mjs
git commit -m "feat: compose 收尾生成封面与元数据（M11 Task2）"
```

---

### Task 3: routes export/zip 端点 + 前端打包按钮

**Files:**
- Modify: `lib/drama/routes.mjs`（新增 `GET /api/drama/projects/{id}/export/zip`）
- Modify: `package.json`（check 加 `lib/drama/export.mjs`）
- Modify: `public/drama.html`、`public/drama.js`（打包 ZIP 按钮）
- Test: `tests/drama-routes-export.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `buildZipBuffer`；compose 产出的 mp4/srt/cover/meta
- Produces：`GET /api/drama/projects/{id}/export/zip` 流式响应 ZIP（200/409）；前端按钮

- [ ] **Step 1: 写失败测试**

新建 `tests/drama-routes-export.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDramaApi } from "../lib/drama/routes.mjs";
import { createDramaStore } from "../lib/drama/store.mjs";
import { createDramaProject } from "../lib/drama/schema.mjs";

const envelope = (ok, data = null, options = {}) => ({ ok, ...(ok ? { data } : { errorCode: options.errorCode, message: options.message }) });
const readJson = async (req) => JSON.parse(req.body || "{}");
function mockRes() { const res = { statusCode: 0, body: null, headers: {} }; res.sendJson = (s, b) => { res.statusCode = s; res.body = b; }; res.writeHead = (s, h) => { res.statusCode = s; res.headers = h; }; res.end = (b) => { res.body = b; }; return res; }

function setup() {
  const dataRoot = mkdtempSync(join(tmpdir(), "drama-re-"));
  const store = createDramaStore(dataRoot);
  const project = store.save(createDramaProject({ title: "t", script: "剧本内容".repeat(15) }));
  const ctx = {
    sendJson: (r, s, b) => r.sendJson(s, b), envelope, readJson, allowRequest: () => true,
    store, comfyConfig: {}, pricing: {}, findAvatar: () => null, findVoice: () => null,
    seedanceStatus: () => ({ connected: false }), seedanceConfig: {}, audioDeps: {}, materialStore: { get: () => null }, controlnetConfig: null
  };
  return { ctx, project, dataRoot };
}

test("export/zip 未合成 → 409", async () => {
  const { ctx, project, dataRoot } = setup();
  const res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/export/zip`), ctx);
  assert.equal(res.statusCode, 409);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("export/zip 已合成 → 200 ZIP", async () => {
  const { ctx, project, dataRoot } = setup();
  // 模拟 compose 成功：建 compose 目录 + final.mp4/film.srt/cover.png/meta.json
  const composeDir = join(dataRoot, project.id, "compose");
  mkdirSync(composeDir, { recursive: true });
  writeFileSync(join(composeDir, "final.mp4"), Buffer.from("mp4-bytes"));
  writeFileSync(join(composeDir, "film.srt"), "1\n00:00:01 --> 00:00:03\n台词");
  writeFileSync(join(composeDir, "cover.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(composeDir, "meta.json"), JSON.stringify({ title: "t" }));
  ctx.store.update(project.id, (p) => { p.compose = { status: "succeeded", file: "final.mp4", srtFile: "film.srt", cover: "cover.png", meta: "meta.json" }; });
  const res = mockRes();
  await handleDramaApi({ method: "GET", socket: {} }, res, new URL(`http://x/api/drama/projects/${project.id}/export/zip`), ctx);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "application/zip");
  assert.ok(res.body.length > 100); // ZIP buffer
  // ZIP magic
  assert.equal(res.body[0], 0x50); assert.equal(res.body[1], 0x4b);
  rmSync(dataRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/drama-routes-export.test.mjs`
Expected: FAIL（端点未处理）

- [ ] **Step 3: 实现**

`lib/drama/routes.mjs` import 区加 `buildZipBuffer`：

```js
import { buildZipBuffer } from "./export.mjs";
import { existsSync, readFileSync } from "node:fs";
```

注：`existsSync`/`readFileSync` 可能已 import（routes.mjs 顶部已有 fs import），确认后只加 buildZipBuffer。

export 端点（在 compose POST 端点之后，projects 分支内）插入：

```js
    // M11：成片打包导出（ZIP store 模式）
    if (segments.length === 5 && segments[4] === "export" && request.method === "GET") {
      const project2 = store.get(projectId);
      if (!project2?.compose || project2.compose.status !== "succeeded" || !project2.compose.file) {
        return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "COMPOSE_NOT_READY", message: "请先合成成片" }));
      }
      const composeDir = join(store.dir(projectId), "compose");
      const files = [];
      const mp4Path = join(composeDir, project2.compose.file);
      if (existsSync(mp4Path)) files.push({ name: `${project2.title}.mp4`, bytes: readFileSync(mp4Path) });
      if (project2.compose.srtFile) {
        const srtPath = join(composeDir, project2.compose.srtFile);
        if (existsSync(srtPath)) files.push({ name: `${project2.title}.srt`, bytes: readFileSync(srtPath) });
      }
      if (project2.compose.cover) {
        const coverPath = join(composeDir, project2.compose.cover);
        if (existsSync(coverPath)) files.push({ name: "cover.png", bytes: readFileSync(coverPath) });
      }
      if (project2.compose.meta) {
        const metaPath = join(composeDir, project2.compose.meta);
        if (existsSync(metaPath)) files.push({ name: "meta.json", bytes: readFileSync(metaPath) });
      }
      const zip = buildZipBuffer(files);
      response.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(project2.title)}.zip"`,
        "Content-Length": zip.length
      });
      response.end(zip);
      return true;
    }
```

`package.json` check 脚本加 `&& node --check lib/drama/export.mjs`（在 queue.mjs 之后）。

前端 `public/drama.html` 导出区 `#exportSrt` 行后加：

```html
              <a class="vz-btn hidden" id="exportZip" download>打包 ZIP</a>
```

`public/drama.js` renderCompose 内（设置 exportMp4/exportSrt href 的地方）加 exportZip：

```js
  const zip = $("#exportZip");
  if (zip) {
    zip.classList.toggle("hidden", !(project.compose?.status === "succeeded"));
    zip.href = project.compose?.status === "succeeded" ? `/api/drama/projects/${project.id}/export/zip` : "";
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/drama-routes-export.test.mjs && npm run test:unit && npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/drama/routes.mjs package.json public/drama.html public/drama.js tests/drama-routes-export.test.mjs
git commit -m "feat: 成片 ZIP 打包导出端点与按钮（M11 Task3）"
```

---

## 阶段 C：smoke 守卫 + 全量验证

### Task 4: smoke 守卫 + 全量验证

**Files:**
- Modify: `scripts/smoke.mjs`、`package.json`（check 加 export.mjs）

- [ ] **Step 1: smoke 守卫**

`scripts/smoke.mjs` 在 M10 守卫之后、console.log 之前追加：

```js
  // ---------- M11：成片导出守卫 ----------
  // compose 在 smoke 环境因 ComfyUI 不可用不会成功，守卫只验证未合成时 export/zip 返回 409 不炸
  const m11Export = await fetch(`http://127.0.0.1:${port}/api/drama/projects/${created.project.id}/export/zip`);
  if (m11Export.status !== 409) throw new Error(`M11 export/zip 未合成应返回 409，实际 ${m11Export.status}`);
```

收尾 console.log 对象加：

```js
    m11ExportGuard: m11Export.status
```

- [ ] **Step 2: 全量验证**

Run: `npm run check && npm run test:unit && npm run smoke`
Expected: 全通过；smoke 输出含 `m11ExportGuard: 409`

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke.mjs package.json
git commit -m "test: 成片导出冒烟守卫（M11 Task4 收尾）"
```

---

## Self-Review 记录

- **Spec coverage**：buildMeta+buildZipBuffer（T1）、schema cover/meta+compose 收尾（T2）、export/zip 端点+前端按钮（T3）、smoke 守卫（T4）——spec 各节均有对应任务。
- **Type consistency**：`buildMeta(project)→meta对象`（T1）→ compose T2 一致；`buildZipBuffer(files)→Buffer`（T1）→ routes T3 一致；`normalizeCompose` cover/meta 字段（T2）→ routes T3 读取一致。
- **零回归纪律**：compose 收尾 cover/meta 生成包 try-catch，失败不阻塞成片（main mp4+srt 优先）；export 端点文件缺失跳过不报错。
- **已知简化（对 spec 无偏离）**：ZIP store 模式不压缩（mp4/srt 已压缩）；封面取首镜 confirmed 首帧 png 复制（零生成）；元数据从 project 派生不可编辑；smoke 环境不验证实际 ZIP 内容（ComfyUI 不可用 compose 不成功），实际打包靠单元测试覆盖。
