# 短剧工作台 M11：成片导出发布设计文档

- 日期：2026-08-15
- 状态：已评审（脑暴确认 4 个决策点 A/A/A/A）
- 范围：M11 —— compose 成功后生成封面图 + 元数据 JSON + 一键 ZIP 打包
- 前置：M1–M10 已完成

## 背景与目标

M5 合成产出 `final.mp4` + `film.srt`，前端已有 exportMp4/exportSrt 下载按钮。但成片只有裸 mp4+srt，缺分发所需的封面/元数据/打包。

M11 补齐三块：

- **封面图**：取首镜已确认首帧 png，复制为 `cover.png`，零生成成本。
- **元数据 JSON**：从 project.analysis + shots 派生项目信息快照（标题/角色/镜数/时长/比例/版本）。
- **ZIP 打包**：一键下载 mp4+srt+封面+元数据，store 模式不压缩（mp4/srt 已压缩，零 CPU 开销）。

不转码其他格式（MP4 已是通用分发格式）。

## 已确认决策与隐含假设

| 决策点 | 结论 |
| --- | --- |
| 导出格式 | **维持 MP4 不转码**：加封面/元数据/打包；不引入转码依赖（YAGNI） |
| 封面图来源 | **首镜首帧 png**：取 `shots[0].frame.file`（已确认首帧），复制为 `cover.png`；零生成成本 |
| 元数据字段 | **项目信息快照**：title/synopsis/genre/characters[{name,role}]/shotCount/totalDurationSec/ratio/createdAt/exportedAt；从 analysis+shots 派生，零额外输入 |
| 打包方式 | **ZIP store 模式手写**：零 npm 依赖，~80 行；mp4/srt 已压缩不重复压缩 |

**隐含假设**：compose 成功后自动生成封面+元数据（compose.mjs 收尾加）；ZIP 按需请求触发生成+下载（流式响应，不落盘 zip 文件避免占空间）。

## 核心数据模型

**compose 状态增量**（`normalizeCompose`）：

```
compose { ..., cover: null, meta: null }
// cover: "cover.png" | null   —— 封面图文件名（compose 目录内）
// meta: "meta.json" | null    —— 元数据文件名
```

**meta.json 形状**：

```json
{
  "title": "项目标题",
  "synopsis": "一句话梗概",
  "genre": "都市",
  "characters": [{ "name": "林晚", "role": "主角" }],
  "shotCount": 8,
  "totalDurationSec": 45,
  "ratio": "portrait",
  "createdAt": "2026-08-15T...",
  "exportedAt": "2026-08-15T..."
}
```

## 模块划分

- `lib/drama/export.mjs` — **新建**：`buildMeta(project)` 派生元数据；`buildZipStream(files)` 手写 ZIP store 模式流（用 Readable + CRC32）。
- `lib/drama/compose.mjs` — compose 成功收尾：复制首镜首帧为 `cover.png`、写 `meta.json`、回写 `compose.cover`/`compose.meta`。
- `lib/drama/schema.mjs` — `normalizeCompose` 加 `cover`/`meta` 字段。
- `lib/drama/routes.mjs` — 新增 `GET /api/drama/projects/{id}/export/zip`（流式 ZIP 响应）。
- 前端 `drama.html`/`drama.js` — 导出区加「打包 ZIP」按钮。

## 阶段 A：元数据与封面

### export.mjs

`buildMeta(project)`：

```js
export function buildMeta(project) {
  return {
    title: project.title,
    synopsis: project.analysis?.synopsis || "",
    genre: project.analysis?.genre || "",
    characters: (project.analysis?.characters || []).map((c) => ({ name: c.name, role: c.role })),
    shotCount: project.shots.length,
    totalDurationSec: project.shots.reduce((sum, s) => sum + (Number(s.durationSec) || 0), 0),
    ratio: project.ratio,
    createdAt: project.createdAt,
    exportedAt: new Date().toISOString()
  };
}
```

### compose.mjs 收尾改动

`setCompose({ status: "succeeded", ... })` 前：

```js
  // M11：生成封面（首镜首帧 png 复制）+ 元数据
  let cover = null;
  let meta = null;
  try {
    const firstShot = project.shots.find((s) => s.frame.status === "confirmed") || project.shots[0];
    if (firstShot?.frame?.file) {
      const coverSrc = join(store.dir(projectId), "frames", firstShot.frame.file);
      if (existsSync(coverSrc)) { copyFileSync(coverSrc, join(composeDir, "cover.png")); cover = "cover.png"; }
    }
    const metaObj = buildMeta(project);
    writeFileSync(join(composeDir, "meta.json"), JSON.stringify(metaObj, null, 2));
    meta = "meta.json";
  } catch { /* 封面/元数据失败不阻塞成片 */ }
  setCompose({ status: "succeeded", file: current, srtFile, cover, meta, finishedAt: new Date().toISOString() });
```

### schema.mjs

`normalizeCompose` 加：

```js
    cover: typeof raw?.cover === "string" && raw.cover ? raw.cover : null,
    meta: typeof raw?.meta === "string" && raw.meta ? raw.meta : null,
```

## 阶段 B：ZIP 打包

### export.mjs buildZipStream

手写 ZIP store 模式（不压缩，mp4/srt 已压缩）：

```js
import { Readable } from "node:stream";
import { createHash } from "node:crypto";

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

// files: [{ name, bytes: Buffer }]；返回 Buffer（store 模式，小文件集，内存可承受）
export function buildZipBuffer(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.bytes);
    const size = f.bytes.length;
    // local file header
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);  // version
    local.writeUInt16LE(0, 6);   // flags
    local.writeUInt16LE(0, 8);   // compression: store
    local.writeUInt16LE(0, 10);  // mod time
    local.writeUInt16LE(0, 12);  // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);  // extra length
    chunks.push(local, name, f.bytes);
    // central directory entry
    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(0, 8);
    centralEntry.writeUInt16LE(0, 10);
    centralEntry.writeUInt16LE(0, 12);
    centralEntry.writeUInt16LE(0, 14);
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(size, 20);
    centralEntry.writeUInt32LE(size, 24);
    centralEntry.writeUInt16LE(name.length, 28);
    centralEntry.writeUInt16LE(0, 30);
    centralEntry.writeUInt16LE(0, 32);
    centralEntry.writeUInt16LE(0, 34);
    centralEntry.writeUInt32LE(0, 36);
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry, name);
    offset += local.length + name.length + f.bytes.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) centralSize += c.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
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

### routes.mjs export 端点

`GET /api/drama/projects/{id}/export/zip`：

```js
  if (segments.length === 5 && segments[4] === "export" && request.method === "GET") {
    // segments: api/drama/projects/{id}/export — 实际是 5 段？api=0 drama=1 projects=2 {id}=3 export=4
    const project = store.get(projectId);
    if (!project?.compose || project.compose.status !== "succeeded" || !project.compose.file) {
      return sendJson(response, 409, envelope(false, null, { requestId, errorCode: "COMPOSE_NOT_READY", message: "请先合成成片" }));
    }
    const composeDir = join(store.dir(projectId), "compose");
    const files = [];
    const mp4Path = join(composeDir, project.compose.file);
    if (existsSync(mp4Path)) files.push({ name: `${project.title}.mp4`, bytes: readFileSync(mp4Path) });
    if (project.compose.srtFile) {
      const srtPath = join(composeDir, project.compose.srtFile);
      if (existsSync(srtPath)) files.push({ name: `${project.title}.srt`, bytes: readFileSync(srtPath) });
    }
    if (project.compose.cover) {
      const coverPath = join(composeDir, project.compose.cover);
      if (existsSync(coverPath)) files.push({ name: "cover.png", bytes: readFileSync(coverPath) });
    }
    if (project.compose.meta) {
      const metaPath = join(composeDir, project.compose.meta);
      if (existsSync(metaPath)) files.push({ name: "meta.json", bytes: readFileSync(metaPath) });
    }
    const zip = buildZipBuffer(files);
    response.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(project.title)}.zip"`,
      "Content-Length": zip.length
    });
    response.end(zip);
    return true;
  }
```

注意：segments 数量需确认。`api/drama/projects/{id}/export` 是 5 段（api/drama/projects/{id}/export）。但实际 routes.mjs 的 `parts(url)` 过滤空段后 `segments = ["api","drama","projects","<id>","export"]`，长度 5。端点放在 projects 分支内（`segments[2] === "projects"` 块），用 `segments[4] === "export"` 匹配。

## 阶段 C：前端

导出区 `#exportMp4`/`#exportSrt` 行加「打包 ZIP」按钮：

```html
<a class="vz-btn hidden" id="exportZip" download>打包 ZIP</a>
```

JS：compose 成功后设置 `#exportZip.href = /api/drama/projects/{id}/export/zip`，显示按钮。

## 错误处理

| 场景 | 行为 |
| --- | --- |
| compose 未成功 | export/zip 返回 409 COMPOSE_NOT_READY |
| 首镜首帧不存在 | cover=null，不阻塞成片 |
| meta 写入失败 | meta=null，不阻塞成片 |
| 文件缺失 | zip 跳过该文件，不报错 |

封面/元数据生成永远不阻塞成片——主产物 mp4+srt 优先。

## 测试策略

- `tests/drama-export.test.mjs`：buildMeta 形状、buildZipBuffer 产出合法 zip（local header magic、central dir、end record）。
- `tests/drama-compose.test.mjs`：补 compose 成功后 cover/meta 落盘。
- `tests/drama-schema.test.mjs`：补 normalizeCompose cover/meta 归一化。
- `tests/drama-routes-export.test.mjs`：export/zip 端点 409/200、zip 响应体合法。
- `scripts/smoke.mjs` 收尾加 M11 守卫（compose 成功后断言 cover/meta 存在 + export/zip 200）。

## Global Constraints

- 零框架、无构建链、不引入新 npm 依赖；本机优先、私密不出本机。
- 中文提交信息（`类型: 简短描述`）；遵循既有 `lib/drama/*` 与 `tests/drama-*.test.mjs` 模式。
- 既有 compose 链路零回归；封面/元数据失败不阻塞成片。
- ZIP store 模式不压缩（mp4/srt 已压缩）；手写零依赖。
