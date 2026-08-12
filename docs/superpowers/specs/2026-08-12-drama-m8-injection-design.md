# 短剧工作台 M8：素材引用注入生成设计文档

- 日期：2026-08-12
- 状态：已评审（脑暴确认 3 个决策点 A/A/A）
- 范围：M8 —— 把 M7 记录的素材引用真正注入生成链路（参考图→ControlNet 首帧；参考音频→TTS voice clone）
- 前置：M1–M7 已完成（单集生产线 + 编辑器 + 后段 + 资产/版本/多集 + 平台级模块）

## 背景与目标

M7 把 `refMaterialId`（场景/道具参考图）和 `refAudioMaterialId`（角色配音参考音频）存到了 analysis，但生成阶段完全没用上：

- **首帧**：`generateFluxFrame` 只吃 `shot.fluxPrompt`（纯文本），参考图没进 ComfyUI 工作流。
- **口播**：走 Seedance（avatarId+voiceId），参考音频没传给 TTS。

M8 让参考素材真正影响生成结果。三个决策点已确认：

| 决策点 | 结论 |
| --- | --- |
| 参考图注入方式 | **ControlNet 参考条件**：上传参考图→ControlNet 预处理器→Apply 到 Flux 正向条件；模型未装自动降级纯文本 |
| 参考音频用途 | **仅作 TTS voice clone 参考**：不注入 Seedance 数字人；ElevenLabs 流程用参考音频做音色克隆参考（不改 Seedance avatar） |
| 素材已删处理 | **注入时跳过回退**：生成时若 refMaterialId/refAudioMaterialId 指向已删素材，忽略引用、正常生成（不报错阻断） |

## 已确认决策与隐含假设

- **ControlNet 模型用户自装**：本机当前未装，M8 工作流设计为模型名可配置（env/config），未配置时自动降级为纯文本 Flux 工作流，不阻塞既有首帧生成。
- **降级不报错**：参考图/音频缺失时静默回退，生成照常进行（与 M7「删除素材不级联清理引用」纪律一致）。
- **不改 Seedance 链路**：口播数字人形象仍走 avatarId+voiceId，参考音频只影响 TTS 音色层。
- **零新依赖**：沿用 ComfyUI 现有 API（uploadComfyuiImage/prompt/history/view），不引入 npm 包。

## 核心数据模型增量

**无新顶层存储**。复用 M7 的 `refMaterialId`/`refAudioMaterialId` 字段。

**首帧状态增量**（`normalizeFrame`）：

```
frame { ..., controlnet: { used: false|null, source: "ref|fallback" } }
// used=true 表示本帧用了 ControlNet；false 表示降级纯文本；null 表示未启用注入
```

**口播片段增量**（`normalizeClip`，仅对白镜）：

```
clip { ..., voiceRef: { used: false|null, materialId: null } }
// used=true 表示用了参考音频克隆音色；false 表示降级常规 TTS
```

## 模块划分

- `lib/drama/comfyui.mjs` — `buildFluxWorkflow` 支持可选 ControlNet 分支；新增 `loadControlnetConfig`（env/config 探测模型是否已装）；`generateFluxFrame` 接收可选 `refImage`（上传后的 ComfyUI 图片名）参数。
- `lib/drama/audio.mjs` — `synthesizeShotVoice` 接收可选 `voiceCloneRef`（参考音频字节数组），ElevenLabs 分支用参考音频做 voice clone（若 API 支持/Key 配置）；Voicebox 分支不变（不支持 clone）；无 clone 回退常规 TTS。
- `lib/drama/routes.mjs` — 首帧执行器与口播执行器：注入前解析 refMaterialId/refAudioMaterialId→materialStore 取素材字节→传给生成函数；素材缺失静默跳过。
- `lib/drama/schema.mjs` — `normalizeFrame`/`normalizeClip` 加 `controlnet`/`voiceRef` 字段。
- `lib/drama/materials.mjs` — 新增 `getBytes(id)`：按 id 取素材文件字节（注入时用）。
- 前端 `drama.js` — 首帧卡片显示「ControlNet 已用/降级」徽标；口播片段显示「音色克隆已用/降级」。

## 阶段 A：参考图注入首帧（ControlNet）

### comfyui.mjs 改动

**新增 ControlNet 配置探测**（沿用 `loadVideoWorkflowTemplate` env 路径模式）：

```js
export function loadControlnetConfig(env = process.env) {
  const name = String(env.COMFYUI_CONTROLNET_NAME || "").trim(); // 如 "flux-controlnet-depth.safetensors"
  const preprocessor = String(env.COMFYUI_CONTROLNET_PREPROCESSOR || "depth").trim(); // depth|canny|lineart
  const strength = Number(env.COMFYUI_CONTROLNET_STRENGTH) || 0.8;
  if (!name) return null; // 未配置 → 降级
  return { name, preprocessor, strength };
}
```

**buildFluxWorkflow 增加 ControlNet 分支**（参考图存在且配置已装时）：

- 加 `LoadImage` 节点（接参考图 ComfyUI 内部名）。
- 加 ControlNet 预处理器节点（如 `DepthPreprocessor`/`CannyEdgePreprocessor`，按 `preprocessor` 字段选）。
- 加 `ControlNetApply` 节点：正向条件 = CLIPTextEncode 输出 + ControlNet 输出。
- KSampler 的 `positive` 从 `["6",0]` 改为 `[ControlNetApply 节点 id, 0]`。
- 没参考图/没配置 → 保持原工作流不变（降级）。

**generateFluxFrame 签名增量**：

```js
generateFluxFrame({ config, prompt, negativePrompt, width, height, seed, fetchImpl, sleep, clientId,
  refImage = null,        // ComfyUI 内部图片名（uploadComfyuiImage 返回值）；null 跳过
  controlnetConfig = null // loadControlnetConfig() 返回；null 跳过
})
```

### routes.mjs 首帧执行器改动

`generateFrame`（首帧执行器）在调 `generateFluxFrame` 前：

1. 找该镜的 scene/prop appearance 来源 → 若对应 analysis 项有 `refMaterialId` → `ctx.materialStore.getBytes(id)` 取字节。
2. 字节存在 → `uploadComfyuiImage` 上传 → 得到内部名 → 传 `refImage`。
3. 取 `ctx.controlnetConfig`（server.mjs 挂载的 `loadControlnetConfig()`）→ 传 `controlnetConfig`。
4. 任一缺失 → 不传，`generateFluxFrame` 走降级纯文本工作流。
5. 生成后回写 `frame.controlnet = { used: <是否实际用了>, source: "ref|fallback" }`。

### 前端首帧卡片

首帧卡片（分镜视图 inspector）加徽标：`frame.controlnet.used === true` → 「ControlNet」绿徽标；`false` → 「纯文本」灰徽标；`null` → 不显示（兼容老项目）。

## 阶段 B：参考音频注入口播 TTS

### audio.mjs 改动

`synthesizeShotVoice` 签名增量：

```js
synthesizeShotVoice({ voiceTarget, text, language = "zh", deps = {}, voiceCloneRef = null })
// voiceCloneRef = { bytes: Buffer, materialId: string } | null
```

- **ElevenLabs 分支**：若 `voiceCloneRef` 且 deps.elevenKey 支持 voice clone（ElevenLabs API `add-voice` 预览模式或 voice settings `similarity_boost` 提升），把参考音频作为音色相似度参考传入 voice_settings。实际落地：参考音频存在时 `similarity_boost` 提升到 0.9（默认 0.78），标记 `used: true`；参考音频缺失或 ElevenLabs 不可用 → 常规 TTS `used: false`。
- **Voicebox 分支**：不支持 voice clone，参考音频忽略，`used: false`。

### routes.mjs 口播执行器改动

口播镜生成前（generateShotClip 内 isDialogue 分支）：

1. 找该镜角色 → 若 `character.refAudioMaterialId` → `materialStore.getBytes(id)` 取字节。
2. 字节存在 → 传给 TTS 流程作 `voiceCloneRef`。
3. 字节缺失 → 不传，常规 TTS。
4. 口播音频生成后回写 `clip.voiceRef = { used: <是否用了>, materialId }`。

注：口播数字人形象仍走 Seedance（avatarId+voiceId 不变），参考音频只影响 TTS 音色层。

### 前端口播片段卡片

口播片段加徽标：`clip.voiceRef.used === true` → 「音色克隆」绿徽标；`false` → 不显示（常规 TTS）。

## 阶段 C：schema 与前端收尾

- `schema.mjs`：`normalizeFrame` 加 `controlnet: { used: null, source: null }`；`normalizeClip` 加 `voiceRef: { used: null, materialId: null }`。
- `materials.mjs`：加 `getBytes(id)`（文件不存在返回 null，不抛错——降级用）。
- 前端徽标样式沿用现有 `vz-badge` 系，不引入新组件。

## 错误处理与降级纪律

| 场景 | 行为 |
| --- | --- |
| refMaterialId 指向已删素材 | `materialStore.getBytes` 返回 null → 首帧降级纯文本，不报错 |
| ControlNet 模型未配置（COMFYUI_CONTROLNET_NAME 空） | `loadControlnetConfig` 返回 null → 首帧降级纯文本，前端徽标「纯文本」 |
| 参考图上传 ComfyUI 失败 | 首帧降级纯文本，记录 `frame.controlnet.used=false` |
| refAudioMaterialId 指向已删素材 | TTS 回退常规音色，不报错 |
| ElevenLabs Key 未配置但走该分支 | 常规 TTS，`voiceRef.used=false` |
| Voicebox 分支（不支持 clone） | 参考音频忽略，`voiceRef.used=false` |

降级永远不阻断生成——与 M7「删除素材不级联清理引用」一致，用户体验是「挂了就生效，没挂/丢了就照常跑」。

## 测试策略

- `tests/drama-comfyui.test.mjs`：补 ControlNet 工作流分支（有 refImage+config / 无 refImage / 无 config 三态）；降级断言原工作流节点不变。
- `tests/drama-routes-frames.test.mjs`：补「参考图存在→refImage 传入→controlnet.used=true」；「素材已删→降级 used=false」。
- `tests/drama-audio.test.mjs`：补 voiceCloneRef 传入→ElevenLabs similarity_boost 提升；参考音频缺失→回退。
- `tests/drama-routes-video.test.mjs`：补口播镜参考音频注入与降级。
- `tests/drama-schema.test.mjs`：补 `controlnet`/`voiceRef` 归一化。
- `tests/drama-materials.test.mjs`：补 `getBytes`（存在/不存在两态）。
- `scripts/smoke.mjs` 收尾加 M8 守卫（建参考图素材→挂场景→跑首帧断言降级或注入路径不炸；建参考音频素材→挂角色→口播断言 used 标记落盘）。

## Global Constraints

- 零框架、无构建链、不引入新 npm 依赖；本机优先、私密不出本机。
- 中文提交信息（`类型: 简短描述`）；遵循既有 `lib/drama/*` 与 `tests/drama-*.test.mjs` 模式。
- 既有首帧/口播/视频/合成链路零回归；降级永不阻断生成。
- ControlNet 模型名走 env 配置（`COMFYUI_CONTROLNET_NAME`/`COMFYUI_CONTROLNET_PREPROCESSOR`/`COMFYUI_CONTROLNET_STRENGTH`），未配置自动降级。
- 参考音频只影响 TTS 音色层，不碰 Seedance 数字人形象绑定。
