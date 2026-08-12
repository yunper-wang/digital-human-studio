# Architecture

Digital Human Studio uses a deliberately small local-first architecture.

- `server.mjs` serves the UI and owns provider calls, task state and private files.
- `public/` is a credential-free browser client with no Node.js privileges.
- `data/` contains user uploads, task state and generated media and is ignored by Git.
- `config/*.example.json` contains visual demo records only. Private catalogs use the same filenames without `.example`.
- `lib/drama/` contains the short-drama workbench, organized by milestone:
  - **M1–M6 单集生产线**：`schema.mjs`/`store.mjs`（项目与分镜结构）、`agents.mjs`/`pipeline.mjs`（LLM 四阶段编排）、`comfyui.mjs`（Flux 首帧 + 图生视频）、`audio.mjs`（TTS 配音）、`compose.mjs`/`ffmpeg.mjs`（合成成片）、`series.mjs`/`version.mjs`（剧集与版本快照）。
  - **M7 平台级模块**：`prompts.mjs`（提示词模板库）、`materials.mjs`（素材库存储）、`routes.mjs` 内 providers 端点（五区块只读状态总览）。
  - **M8 素材注入**：`comfyui.mjs` 加 ControlNet 工作流分支 + `generateFluxFrame` refImage 参数；`audio.mjs` 加 voiceCloneRef 参数；`materials.mjs` 加 getBytes。
  - **M9 多模型编排**：`provider-overrides.mjs`（项目级 LLM/配音覆盖，密钥本机文件存）；`llm.mjs` 加 resolveLlmConfig。
  - **M10 批量队列**：`queue.mjs`（按类型并发度内存队列 comfyui/voice/ffmpeg）；四处执行器经队列调度。
  - **M11 成片导出**：`export.mjs`（buildMeta 元数据 + buildZipBuffer 手写 ZIP store）。
  - **M12 智能辅助**：`suggestions.mjs`（独立建议存储，不污染 analysis）；`agents.mjs` 加 SYSTEM_SUGGEST/runSuggestions。
  - `lib/seedance.mjs` holds the Seedance generation machinery shared by the talking-head page and drama dialogue shots. Drama state lives in `data/drama-projects/`（项目）、`data/prompt-templates/`（模板）、`data/materials/`（素材）、`data/provider-overrides/`（后端覆盖）、`data/drama-suggestions/`（建议）and follows the same privacy rules as other local data.

The browser never receives API keys. Real generation is protected by an explicit confirmation, a per-request idempotency key and a no-automatic-paid-retry rule.
