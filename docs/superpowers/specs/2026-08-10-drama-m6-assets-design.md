# 短剧工作台 M6：资产与版本（场景/道具 + 版本 + 多集）设计文档

- 日期：2026-08-10
- 状态：已评审（脑暴确认）
- 范围：M6 —— 场景/道具资产、版本快照、轻量多集
- 前置：M4（编辑器）、M5（后段生产线）已完成
- 参考：`csyqlz/VOZEB-PRO`（AGPL-3.0，只借鉴设计，不复制代码）

## 背景与目标

当前短剧工作台：1 项目 = 1 集，走「剧本 → 流水线 → 分镜 → 闸门 → 首帧 → 逐镜视频 → 合成导出」全流程。但：
- **场景**是「沉睡数据」——分析产出（名称/地点/氛围）却不展示、不参与生成；**道具**完全没有；只有角色 `appearance` 注入 Flux 提示词。
- 无**版本**：项目就地改，改坏无法回滚。
- 无**多集**：短剧通常是多集连播，但 1 项目只能是 1 集。

M6 在单集生产线之上引入「剧集」层，把这三块补齐。

## 已确认决策

| 决策点 | 结论 |
| --- | --- |
| 多集结构 | **轻量**：新增「剧集」分组多个单集项目（每集仍是完整项目），共享资产库；**不**重写单集数据模型 |
| 场景/道具作用 | **注入生成提示词**：场景/道具带英文外观锁，像角色 appearance 一样注入 Flux 首帧提示词，保证跨镜/跨集画面一致 |
| 版本管理 | **手动快照 + 仅文本结构**（剧本/分镜/分析），可查看与回滚；不含大媒体文件 |
| 本期范围 | 三块都做；实现按 场景/道具 → 版本 → 多集 分阶段 |

## 核心数据模型（本机 JSON，新增两个顶层存储）

```
剧集 series        { id:"series-…", title, assetLibraryId, projectIds[], createdAt, updatedAt }
资产库 assetLibrary { id:"lib-…", characters[], scenes[], props[] }     // scenes/props 含英文 appearance 外观锁
版本 snapshot      { id:"ver-…", projectId, name, script, shots, analysis, createdAt }  // 仅文本结构
```

- **场景 scene**：`{ id, name, location, mood, appearance }`（appearance 为新增英文外观锁：地点/光线/陈设）。
- **道具 prop**：`{ id, name, appearance }`（新增实体；appearance 含材质/标志物）。
- **项目（集）**：新增可选 `seriesId`（属某剧集）；未设置即「未分组项目」。既有单集字段与流程完全不变。

## 模块划分

- `lib/drama/series.mjs` — 剧集 + 资产库的存储与 CRUD（`data/drama-series/`，独立于现有项目 store）。
- `lib/drama/version.mjs` — 快照保存/列表/读取/回滚（存于项目目录 `versions/`）。
- `lib/drama/schema.mjs` — 场景/道具加 `appearance`；项目加 `seriesId`；新增 `normalizeProp`/`normalizeSceneWithAppearance`/`normalizeSnapshot` 等归一化。
- `lib/drama/agents.mjs` / `llm.mjs` — 分析产出场景/道具英文外观；prompt 阶段注入出场场景/道具外观。
- `lib/drama/routes.mjs` — 剧集/资产库/版本端点。
- 前端 `drama.html`/`drama.js`/`drama.css` — 资产视图（角色/场景/道具卡）、剧集两级切换、版本面板。

## 资产与提示词注入（一致性关键）

1. **分析阶段**：LLM 除角色 appearance 外，为每个场景产出英文外观锁（地点/光线/陈设）、为关键道具产出外观锁（材质/标志物）。mock（llm.mjs）同步产出确定性外观。
2. **prompt 阶段**：每镜 Flux 提示词 = 出场角色 appearance + **所在场景 appearance + 关键道具 appearance** + 景别/动作/氛围，仍以 `cinematic film still` 开头、全英文、80–200 词。同场景/道具跨镜、跨集复用同一外观锁 → 画面一致。
3. **分镜关联场景**：分镜 `sceneName` 逐步过渡到关联场景 id（`sceneId`），使场景外观可注入；保留 `sceneName` 兜底。
4. **资产视图**：角色/场景/道具以卡片展示（名称/地点/氛围/外观锁），可编辑外观锁；编辑后重跑 prompt 阶段生效。

## 版本管理（手动快照 · 仅文本）

- 项目（集）在任意状态可「存版本」→ 命名快照 `script + shots + analysis`（纯文本结构，不含首帧/视频/成片等媒体）。
- 版本面板：列表（名称/时间/镜数）→ 查看 / **回滚**（二次确认后把 script/shots/analysis 恢复到该快照；首帧/视频/合成等产物按既有「改动失效」规则处理，需重生）。
- 仅手动触发，不自动版本。

## 多集（轻量）

- 顶栏项目选择升级为「剧集 → 集」两级：可新建剧集、在剧集下新建集、把现有项目归入/移出剧集。
- 剧集内各集共享同一资产库（角色/场景/道具一致）；单集仍走完整流水线/合成，互不干扰。
- 未分组项目与剧集并存；不强制归组。

## 错误处理

- 沿用统一 envelope（`ok/errorCode/message/retryable`）。
- 剧集/资产/版本端点：资源不存在 → 404；跨剧集非法引用 → 422；回滚到无快照 → 409；限流沿用 `allowRequest`。
- 外观注入失败（LLM/mock 缺外观）→ 退回仅角色外观，不阻断分镜生成（优雅降级）。

## 测试

- 单测（`node:test`，沿用 `tests/drama-*.test.mjs`）：
  - schema：场景/道具 appearance、project.seriesId、snapshot 归一化。
  - series.mjs / version.mjs：存储 CRUD 与回滚正确性（内存/临时目录）。
  - 提示词注入：断言 prompt 阶段输出含场景/道具外观锁（mock LLM 确定性）。
- 冒烟（`scripts/smoke.mjs`）：零费用环境下剧集/版本/资产端点守卫与脱敏断言。
- 前端：`npm run check` + 冒烟 + 手动核。

## 实施阶段（一个计划内分阶段，各自可测）

- **阶段 A：场景/道具资产**——schema 新字段 + agents/llm 外观产出 + prompt 注入 + 资产视图卡片。
- **阶段 B：版本管理**——version.mjs + 端点 + 版本面板 + 回滚。
- **阶段 C：轻量多集**——series.mjs + 资产库共享 + 两级切换。

## 验收标准

1. `npm run check` / `test:unit` / `smoke` 全过。
2. 资产视图可查看/编辑角色/场景/道具，场景/道具带英文外观锁。
3. 分镜 Flux 提示词含出场场景/道具外观（一致性可验）。
4. 可对手动存版本、查看、回滚，回滚后剧本/分镜/分析恢复。
5. 可建剧集、在剧集下管理多集、共享资产库；既有单集流程无回归。
