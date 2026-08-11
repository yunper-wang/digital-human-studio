# 短剧工作台 M7：平台级通用模块（提示词库 + 素材库 + 模型管理）设计文档

- 日期：2026-08-11
- 状态：已评审（脑暴确认）
- 范围：M7 —— 提示词库、素材库、模型管理三个平台级模块
- 前置：M1–M6 已完成（单集生产线 + 编辑器 + 后段生产线 + 资产/版本/多集）

## 背景与目标

M1–M6 把「1 个项目走完全流程」做成了完整生产线，但三个平台级能力仍然缺失：

- **提示词硬编码**：四个流水线阶段（分析/分镜/提示词/审核）的系统提示词写死在 `agents.mjs`，想换导演风格只能改代码。
- **素材散落**：用户上传的参考图/音频/视频没有统一管理，场景/道具想要参考图、角色想要配音参考都无处挂。
- **模型状态分散**：编排 LLM、ComfyUI、Seedance、配音、FFmpeg 五个后端的连接状态要看日志或逐个点开，没有一页总览。

M7 把这三块作为平台级通用模块补齐，前端在 48px 图标栏新增「平台」视图统一承载。

## 已确认决策

| 决策点 | 结论 |
| --- | --- |
| 里程碑范围 | 三个模块**一起做**，按 提示词库 → 素材库 → 模型管理 分阶段交付 |
| 总体架构 | **三模块各自独立**（方案 B）：每模块独立存储/路由/测试，沿用 M6 `series.mjs`/`version.mjs` 模式；不做统一资源注册表（YAGNI） |
| 提示词库深度 | **多模板 + 项目选用**：可存多套模板，项目随时切换，只影响后续重跑阶段，**不追溯**已生成内容 |
| 内置模板 | 现有 4 段提示词固化为「默认模板」，`builtin: true`，**只读不可删**；自定义靠复制副本 |
| 素材库边界 | **仅管用户上传素材**（图片/音频/视频），不含生成产物；支持预览、标签、重命名、删除 |
| 素材引用 | **只做引用记录**，不注入首帧/视频生成（生成注入留后续里程碑） |
| 模型管理粒度 | **只读状态总览**：一页看五个后端状态，改配置仍走 `.env` / config 文件，不碰密钥写入 |

## 核心数据模型（本机 JSON/文件，新增两个顶层存储 + 一个只读聚合）

```
提示词模板 promptTemplate { id:"ptpl-…", name, stages:{analyze,direct,prompt,review}, builtin, createdAt, updatedAt }
素材 material            { id:"mat-…", name, kind:"image|audio|video", file, size, tags[], createdAt }
模型状态 providerStatus  { id, name, required:"required|recommended|optional", status:"ready|degraded|missing", summary, hint }  // 只读聚合，无存储
```

**项目/资产字段增量**：

- 项目 `promptTemplateId`（默认 `null` → 用默认模板）。
- 场景/道具 `refMaterialId`（默认 `null`，参考图引用记录）。
- 角色 `refAudioMaterialId`（默认 `null`，配音参考音频）；角色形象沿用现有 `avatarId` 数字人绑定体系，不另加字段。

## 模块划分

- `lib/drama/prompts.mjs` — 提示词模板存储与 CRUD（`data/prompt-templates/`，一模板一文件），含种子化与逐段回退。
- `lib/drama/materials.mjs` — 素材库（`data/materials/` 文件本体 + `index.json` 元数据索引），上传登记/过滤/重命名/标签/删除。
- `lib/drama/schema.mjs` — `normalizeProject` 加 `promptTemplateId`；场景/道具加 `refMaterialId`；角色加 `refAudioMaterialId`。
- `lib/drama/agents.mjs` / `pipeline.mjs` — 系统提示词从 deps 注入，四段常量改为 export 供种子化。
- `lib/drama/routes.mjs` — 模板/素材/资产引用/providers 端点。
- `server.mjs` — 挂载 `materialStore`、`/materials/` 静态服务。
- 前端 `drama.html`/`drama.js`/`drama.css` — 平台视图三 tab（提示词/素材/模型）、项目模板下拉、资产卡引用选择器。

## 阶段 A：提示词库

**存储** `lib/drama/prompts.mjs` — `createPromptStore(dataRoot)` → `{ list, get, create, save, remove, duplicate, resolveStages(templateId) }`：

- **种子化**：首次启动把 `agents.mjs` 四段常量固化为「默认模板」（`builtin: true`，只读不可删）；种子幂等（已存在不覆盖）。
- **逐段回退**：`resolveStages` 永远返回完整四段——自定义模板某段为空、模板不存在或已删，该段自动回退默认模板。流水线永不因模板问题中断。
- `duplicate(id)`：复制任意模板（含内置）为可编辑副本，名称加「副本」后缀。

**接线（极小改动）**：

- `agents.mjs`：四段常量 `SYSTEM_ANALYZE/DIRECT/PROMPT/REVIEW` 改为 `export`；`callStage` 的 system 参数变为 `deps.prompts?.[stage] || SYSTEM_XXX`。
- `pipeline.mjs`：`runDramaPipeline` 起手从 `deps.promptStore` + `project.promptTemplateId` resolve 四段，挂进 deps 传各阶段。
- `schema.mjs`：`normalizeProject`/`createDramaProject` 加 `promptTemplateId`（默认 `null`）。

**端点**：

- `GET/POST /api/drama/prompt-templates`、`GET/PATCH/DELETE /api/drama/prompt-templates/{id}`、`POST .../prompt-templates/{id}/duplicate`。
- builtin 模板拒绝 PATCH/DELETE → 403。
- 项目切模板：现有 `PATCH /api/drama/projects/{id}` 白名单加 `promptTemplateId`（校验模板存在，不存在 → 422）。

**前端**：平台视图「提示词」tab——左侧模板列表（内置徽标、新建/复制/删除），右侧四段 textarea（analyze/direct/prompt/review）+ 保存；剧本视图加「提示词模板」下拉，随时切换。

**错误处理**：模板名空 / 四段全空 → 422；模板文件损坏 → `get` 返回 null 按已删处理（回退默认）；builtin PATCH/DELETE → 403。

## 阶段 B：素材库

**存储** `lib/drama/materials.mjs` — `createMaterialStore(dataRoot)` → `{ list, get, register, rename, setTags, remove }`：

- 文件本体存 `data/materials/`，元数据索引 `data/materials/index.json`。
- `register({name, kind, dataUrl})`：解析 base64 data-URL → 魔数校验（图 png/jpg/webp、音 mp3/wav/m4a、视频 mp4/webm）→ 落盘 + 登记索引。大小限：图片 ≤8MB、音频 ≤20MB、视频 ≤50MB。
- `list({kind, tag, q})`：按类型/标签/名称过滤。
- `remove(id)`：删文件 + 索引记录，**不级联清理引用**——资产卡引用显示「素材已删」占位。
- 索引损坏 → 重建空索引（文件仍在盘上，可重新登记）。

**端点与静态服务**：

- `GET/POST /api/drama/materials`、`PATCH/DELETE /api/drama/materials/{id}`。
- `/materials/<file>` 静态服务（`server.mjs`，与 `/uploads/` 同模式：文件名白名单校验防穿越 + contentTypes 映射）。

**资产引用（仅记录）**：

- `schema.mjs`：场景/道具加 `refMaterialId`、角色加 `refAudioMaterialId`（均默认 `null`）。
- 新增 `PATCH /api/drama/projects/{id}/analysis/assets`：按场景/道具/角色 id 更新 `refMaterialId`/`refAudioMaterialId` **与外观锁**——顺带落地 M6 计划里预留的可选增强，解锁场景/道具外观锁编辑。
- 校验：`refMaterialId` 必须指向存在的图片素材，`refAudioMaterialId` 必须指向存在的音频素材，否则 → 422；置 `null` 解除引用总是允许。

**前端**：平台视图「素材」tab——顶部类型筛选 + 上传按钮（`input[type=file]` → FileReader → base64）；网格卡片（图片缩略图 / 音频播放器 / 视频播放器），支持重命名、加标签、删除（二次确认）。资产视图场景/道具卡加参考图缩略图 + 素材选择器，角色卡加配音参考音频选择器。

**错误处理**：格式不支持 → 422；超限 → 413；魔数不符 → 422；引用类型不符 → 422。

## 阶段 C：模型管理（只读状态总览）

**不做存储、不做写入**——纯聚合层。

**端点** `GET /api/drama/providers`（挂在 `routes.mjs`），聚合 ctx 现有状态函数：

| 区块 | 数据来源 | 展示内容 |
| --- | --- | --- |
| 编排 LLM | `getDramaLlmConfig()`（脱敏） | 已配置/未配置、端点 host、模型名；未配置 → 「走本机演示编排（mock）」 |
| ComfyUI | `comfyConfig` + 视频模板探测 | 节点地址、Flux 首帧可用性、视频工作流模板已配置/缺失 |
| Seedance | `seedanceStatus()` | 连接状态、适配器摘要 |
| 配音 | `audioDeps` | Voicebox 已检测/未检测、ElevenLabs Key 已配置/未配置（不含明文） |
| FFmpeg | M5 探测结果 | 可用性 + 版本 |

- 统一形状 `{ id, name, required, status, summary, hint }`，`hint` 指回接入说明（复用 `docs/INTEGRATION-CONTRACT.md` 措辞）。
- **密钥只返回布尔「已配置」，永不返回值**——与 `GET /api/integrations` 脱敏纪律一致。
- 单区块探测抛错不拖垮整页：该区块降级 `status:"missing"` + 错误摘要，其余正常。

**前端**：平台视图「模型」tab——状态卡片栅格（名称 + 必需级徽标 + 状态灯绿/黄/灰 + 摘要 + 接入说明链接），进入拉一次 + 手动刷新，不轮询。

## 前端结构

48px 图标栏新增「平台」图标 → `#viewPlatform` 视图，内部三 tab：提示词 / 素材 / 模型。视觉沿用 M4 定下的 VOZEB 浅色 shadcn 令牌与 `vz-card`/`vz-btn` 组件族，不引入新依赖。

## 测试策略

- `tests/drama-prompts.test.mjs`：模板 CRUD、种子幂等、逐段回退、duplicate。
- `tests/drama-routes-prompts.test.mjs`：模板端点、builtin 保护、项目切模板校验。
- `tests/drama-agents.test.mjs`：补一例「deps.prompts 覆盖生效」。
- `tests/drama-materials.test.mjs`：register/list/rename/setTags/remove、损坏索引自愈。
- `tests/drama-routes-materials.test.mjs`：素材端点、`/materials/` 静态服务、大小限与魔数。
- `tests/drama-schema.test.mjs`：补 `promptTemplateId`/`refMaterialId`/`refAudioMaterialId` 归一化。
- `tests/drama-routes-providers.test.mjs`：聚合形状、脱敏（响应体不含 key 明文）、单区块故障隔离。
- `scripts/smoke.mjs` 收尾加 M7 守卫（建模板 → 项目选用 → 跑 mock 流水线断言提示词注入路径未炸；建素材 → 引用 → 删素材引用占位）。

## Global Constraints

- 零框架、无构建链、不引入新 npm 依赖；本机优先、私密不出本机。
- 中文提交信息（`类型: 简短描述`）；遵循既有 `lib/drama/*` 与 `tests/drama-*.test.mjs` 模式。
- 密钥/端点永不入响应体明文；素材上传走魔数校验 + 大小限 + 路径白名单。
- 既有单集流程与 M6 多集/版本能力零回归；模板缺失一律回退默认，流水线不因此中断。
- 素材引用仅记录，M7 不改 `comfyui.mjs` 工作流构建。
