# 短剧工作台 M12：剧本智能辅助设计文档

- 日期：2026-08-16
- 状态：已评审（脑暴确认 4 个决策点 A/A/A/A）
- 范围：M12 —— 独立 suggestions 层，分析后自动+手动生成三类建议（剧情结构/角色弧光/台词润色），只展示不自动改
- 前置：M1–M11 已完成

## 背景与目标

分析阶段产出结构化 analysis（synopsis/genre/characters/scenes/props），但只是「拆解」没有「反馈」——用户拿到结构后，缺剧情结构问题、角色弧光缺陷、台词润色建议。

M12 加独立建议层：

- **剧情结构建议**：节奏/转折/冲突是否到位。
- **角色弧光建议**：主角是否有成长线、配角是否工具人。
- **台词润色建议**：生硬/重复/口语化问题。

不污染 analysis 结构（被分镜/提示词/审核/快照依赖），suggestions 是独立层，用户看了可采纳或忽略。

## 已确认决策与隐含假设

| 决策点 | 结论 |
| --- | --- |
| 建议层存储 | **独立 suggestions 存储，不进 analysis**：`createSuggestionStore` 存 `data/drama-suggestions/<projectId>.json`；analysis 结构完全不动 |
| 建议类型 | **三类**：剧情结构（节奏/转折/冲突）、角色弧光（成长线/工具人）、台词润色（生硬/重复/口语化） |
| 触发方式 | **分析后自动触发 + 手动刷新**：pipeline analyze 阶段完成后自动跑一次；平台视图加「重新分析建议」按钮 |
| 采纳落地 | **只展示建议文本，不自动改剧本**：建议是「这里台词生硬，建议改为XX」的文本，用户自己回剧本改；不自动改任何产物 |

**隐含假设**：建议生成走独立 LLM 调用（SYSTEM_SUGGEST 提示词），与 analyze 阶段不阻塞（失败不中断流水线）；suggestions 是项目级独立存储。

## 核心数据模型

**suggestions 文件形状**（`data/drama-suggestions/<projectId>.json`）：

```
suggestion { projectId, generatedAt, suggestions: [{ category: "structure|arc|dialogue", severity: "info|warn", target: "角色名|场景名|镜号|null", message: "建议文本" }] }
```

**category 枚举**：
- `structure`：剧情结构（节奏/转折/冲突）
- `arc`：角色弧光（成长线/工具人）
- `dialogue`：台词润色（生硬/重复/口语化）

**severity 枚举**：`info`（改进建议）、`warn`（明显问题）。无 `block`（建议不阻断，审核阶段已有 block 纪律）。

**target**：指向具体对象（角色名/场景名/镜号），或 null（整体建议）。

## 模块划分

- `lib/drama/suggestions.mjs` — **新建**：`createSuggestionStore(dataRoot)` → `{ get, save, remove }`；`generateSuggestions(project, deps)` 调 LLM 产出建议。
- `lib/drama/agents.mjs` — 新增 `SYSTEM_SUGGEST` 常量 + `runSuggestions(project, deps)` 函数（callStage 模式）。
- `lib/drama/pipeline.mjs` — analyze 阶段完成后自动触发建议生成（异步、不阻塞）。
- `lib/drama/routes.mjs` — 新增 `GET /api/drama/projects/{id}/suggestions`、`POST /api/drama/projects/{id}/suggestions/regenerate`。
- `server.mjs` — ctx 挂载 `suggestionStore`。
- 前端 `drama.html`/`drama.js` — 剧本视图加「智能建议」面板（三类分组 + 重新分析按钮）。

## 阶段 A：存储与建议生成

### suggestions.mjs

`createSuggestionStore(dataRoot)` → `{ get, save, remove }`：

- 文件 `data/drama-suggestions/<projectId>.json`。
- `get(projectId)`：文件不存在/损坏返回 null。
- `save(projectId, data)`：校验 suggestions 数组形状，写文件。
- `remove(projectId)`：删文件，幂等。

`generateSuggestions(project, deps)`：

- 调 `runSuggestions(project, deps)`（agents.mjs）。
- 返回 `{ suggestions: [...], generatedAt }`。
- LLM 失败返回 `{ suggestions: [], generatedAt, error }`，不抛错。

### agents.mjs runSuggestions

`SYSTEM_SUGGEST` 提示词：

```
你是短剧剧本顾问。基于剧本与分析结果，给出可执行的改进建议，只输出 JSON。
输出结构：{"suggestions":[{"category":"structure|arc|dialogue","severity":"info|warn","target":"角色名|场景名|镜号|null","message":"具体建议"}]}
三类建议：
- structure：剧情结构（节奏拖沓/转折生硬/冲突不足/高潮缺失）
- arc：角色弧光（主角无成长线/配角工具人化/角色动机不清）
- dialogue：台词润色（生硬/重复/过于书面化/不符合角色性格）
要求：每类至少 1 条（若无明显问题则 message 写「无明显问题」severity=info）；message 具体可执行，指向 target；不超过 8 条。
```

`runSuggestions(project, deps)`：调 `callStage("suggest", SYSTEM_SUGGEST, { script: project.script, analysis: project.analysis }, validateSuggestions, deps)`。

`validateSuggestions` 校验：suggestions 是数组、每项 category/severity/target/message 合法。

### pipeline.mjs 自动触发

analyze 阶段完成后（`p.analysis = analysis` 之后）：

```js
// M12：分析后自动生成智能建议（异步、失败不阻塞流水线）
if (deps.suggestionStore) {
  generateSuggestions(store.get(projectId), deps).then((result) => {
    if (result?.suggestions?.length) deps.suggestionStore.save(projectId, result);
  }).catch(() => {});
}
```

## 阶段 B：端点

### routes.mjs

- `GET /api/drama/projects/{id}/suggestions` → `{ suggestions: {...} | null }`。
- `POST /api/drama/projects/{id}/suggestions/regenerate` → 异步触发生成 + 202。

### server.mjs

ctx 挂载 `suggestionStore: createSuggestionStore(dataRoot)`。

## 阶段 C：前端

剧本视图加「智能建议」面板：

- 三类分组（剧情结构/角色弧光/台词润色）。
- 每条建议：severity 图标（info=蓝/warn=黄）+ target（若有）+ message。
- 「重新分析建议」按钮。
- 无建议时显示「分析后生成」占位。

## 错误处理

| 场景 | 行为 |
| --- | --- |
| suggestions 文件损坏 | get 返回 null，前端显示占位 |
| LLM 建议生成失败 | 返回空 suggestions，不抛错，不阻塞流水线 |
| 无 analysis（未跑分析） | 生成建议时 LLM 收到 analysis=null，仍可基于 script 给建议 |
| 建议超出 8 条 | validate 截断 |

建议生成永不阻断——与 M7 promptTemplate 逐段回退、M8 素材缺失降级纪律一致。

## 测试策略

- `tests/drama-suggestions.test.mjs`：get/save/remove、损坏自愈、generateSuggestions mock LLM。
- `tests/drama-agents.test.mjs`：补 runSuggestions 一例（deps.prompts 覆盖 + 结构校验）。
- `tests/drama-pipeline.test.mjs`：补 analyze 完成后 suggestions 自动落盘。
- `tests/drama-routes-suggestions.test.mjs`：GET/POST 端点。
- `scripts/smoke.mjs` 收尾加 M12 守卫（跑完流水线后 GET suggestions 断言不炸）。

## Global Constraints

- 零框架、无构建链、不引入新 npm 依赖；本机优先、私密不出本机。
- 中文提交信息（`类型: 简短描述`）；遵循既有 `lib/drama/*` 与 `tests/drama-*.test.mjs` 模式。
- analysis 结构零污染（被分镜/提示词/审核/快照依赖）；suggestions 独立存储。
- 建议只展示不自动改；建议生成失败不阻塞流水线。
