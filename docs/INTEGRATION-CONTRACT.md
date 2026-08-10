# 接入说明与公开接口

Digital Human Studio 不内置任何个人 API Key、Token 或私人节点地址。接收项目的人只需要知道“要准备什么”，然后在自己的电脑上完成配置。

## 供应商接入

| 能力 | 供应商 | 级别 | 本机配置项 | 用途 |
| --- | --- | --- | --- | --- |
| 视频生成 | Seedance 2.0 | 必需 | `SEEDANCE_PYTHON`、`TOOL_VAULT_PATH`、`SEEDANCE_RUNNER` | 提交数字人口播成片任务 |
| 云端配音 | ElevenLabs | 可选 | `ELEVENLABS_API_KEY` | 加载账号音色、生成配音试听 |
| 火山语音大模型 | Doubao-Seed-TTS 2.0 | 可选 | `VOLCENGINE_TTS_APP_ID`、`VOLCENGINE_TTS_ACCESS_TOKEN`、`VOLCENGINE_TTS_VOICE_TYPE` | 接入豆包语音合成 2.0 公版音色 |
| 火山声音复刻 | Doubao-Seed-ICL 2.0 | 可选 | 同上，按控制台开通的资源填写 | 使用用户自行购买的复刻音色 |
| 本地克隆音色 | Voicebox + Qwen3-TTS | 可选、免费 | 通常自动检测；也可手动填写 `VOICEBOX_URL` | 在本机生成克隆配音 |
| 短剧编排模型 | OpenAI 兼容端点 | 可选 | `DRAMA_LLM_BASE_URL`、`DRAMA_LLM_MODEL`、`DRAMA_LLM_API_KEY` | 驱动剧本分析/导演分镜/提示词/审核四个阶段；不配置时使用本机演示编排 |
| 短剧首帧生成 | ComfyUI (Flux) | 可选 | `COMFYUI_URL` | 为每个分镜生成首帧；本机算力，不产生 API 费用 |
| 剧情镜视频工作流 | ComfyUI 模板（MiniMax H3 等图生视频） | 可选 | `DRAMA_VIDEO_WORKFLOW` | 注入已确认首帧与运动提示词后提交本机 ComfyUI 生成剧情镜视频 |

`SEEDANCE_MODEL` 是可选的视频模型标识。配置项只写入用户自己的 `.env` 或桌面应用数据目录，不应写进源码、截图、日志或 GitHub。

## 官方开通与下载

- [ElevenLabs 官方价格](https://elevenlabs.io/pricing)
- [火山引擎豆包语音产品页](https://www.volcengine.com/products/Audio-editing-and-sound-processing)
- [火山引擎声音复刻 2.0 开通与购买指南](https://www.volcengine.com/docs/6561/1167802?lang=zh)
- [Voicebox 官方下载](https://voicebox.sh/download)
- [Voicebox 安装与模型说明](https://docs.voicebox.sh/overview/installation)

Voicebox 推荐使用 Qwen3-TTS 1.7B。工作台会检查 Voicebox 应用、本地 Hugging Face 模型缓存和正在运行的本机服务；如果模型已存在就提示启动或已连接，如果未发现才展示官方下载按钮。下载 Voicebox 后，首次使用对应引擎时由 Voicebox 自行下载模型。

## 工作台公开 API

所有响应使用统一 JSON 信封：成功时返回 `ok: true`、`requestId` 和 `data`；失败时返回 `errorCode`、`message` 与 `retryable`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 服务和供应商健康状态 |
| `GET` | `/api/integrations` | 接入要求及脱敏后的配置/连接布尔状态 |
| `GET` | `/api/avatars` | 数字人目录 |
| `GET` | `/api/voices` | 音色目录 |
| `POST` | `/api/seedance/prompt-preview` | 生成可编辑的 Seedance 提示词 |
| `POST` | `/api/tasks` | 创建流程检查、配音或视频任务 |
| `GET` | `/api/tasks/{id}` | 轮询长任务状态 |
| `PATCH` | `/api/drama/projects/{id}/characters/{charId}` | 绑定角色形象与音色 |
| `POST` | `/api/drama/projects/{id}/shots/{shotId}/confirm` | 确认分镜首帧 |
| `POST` | `/api/drama/projects/{id}/shots/{shotId}/video` | 生成或重生成分镜视频（重生成需 confirmCost） |
| `POST` | `/api/drama/projects/{id}/shots/{shotId}/video-confirm` | 确认分镜视频 |

## 对接约定

- 外部供应商调用只发生在本机 Node.js 服务端，浏览器界面不接触密钥。
- 真实付费生成必须明确确认，失败不会自动付费重试。
- 长任务使用 `taskId` 轮询；重复提交由幂等键保护。
- `/api/integrations` 只返回配置项名称和布尔状态，绝不返回配置值或本机路径。
- 本地检测只返回 `appInstalled/modelDownloaded/modelLoaded/autoDetected` 布尔值，不公开本机端口或目录。
