# 短剧工作台 M5：后段生产线（字幕 / BGM / FFmpeg 合成导出）— 设计文档

- 日期：2026-08-10
- 状态：已评审（脑暴确认）
- 范围：仅 M5（把逐镜 clip 合成为可导出成片）
- 前置：M4 编辑器（VOZEB 浅色风 + 剪辑式结构 + 分镜细粒度编辑）已完成

## 背景与目标

M4 之后，短剧工作台能产出**逐镜 clip**：台词镜走 Seedance（已含人声）、剧情镜走 ComfyUI（无声）。但这些 clip 还散落在各分镜里，无法得到一部完整成片。M5 把「生成」视图升级为**合成导出**阶段：逐镜 clip → 加字幕与背景音乐 → 合成可预览、可下载的成片 MP4 + SRT。

## 关键决策（脑暴已定）

| 决策点 | 结论 |
| --- | --- |
| FFmpeg 来源 | **检测系统 FFmpeg**（`FFMPEG_PATH` → 系统 PATH → 常见安装路径），找不到给「未就绪」提示与安装指引；不捆绑二进制 |
| 字幕方案 | **导出 SRT 侧车 + 软字幕**（mov_text 封装进 MP4）；不烧录硬字幕（保持低成本、SRT 可导入剪映精修） |
| 背景音乐 | **支持上传 BGM**，合成时循环铺满全片并闪避到台词之下，音量可调 |
| 费用 | 合成纯本地 FFmpeg 完成，**零 API 费用**，延续费用可控理念 |

## 范围

**做（In scope）**
1. FFmpeg 探测与「未就绪」降级提示。
2. SRT 字幕从分镜派生（文本取 `shot.dialogue`，时间轴按 `durationSec` 累计）+ 逐条校对编辑 + 保存。
3. BGM 上传（本地音频文件）存入项目目录。
4. FFmpeg 合成：逐镜 confirmed clip → concat（统一转码 h264+aac 保证兼容）→ 混入 BGM（循环 + 闪避）→ 封装软字幕 → 成片 `final.mp4` + `film.srt`。
5. 成片预览与导出（下载 MP4 / SRT）。
6. 合成失败定位到具体镜头并提示。

**不做（Out of scope，留 M6+）**
- 硬字幕烧录、音效（SFX）库、多集、版本管理、复杂时间轴编辑、自动 SFX。

## 合成架构（FFmpeg 管线）

台词镜与剧情镜的编码参数可能不一致，故合成时**统一转码**为 h264 + aac（本地 CPU，无 API 成本）：

```
逐镜 confirmed clip
  → [concat 统一转码 h264/aac]
  → [混入 BGM：loop 铺满 + sidechain/音量闪避]
  → [封装软字幕 mov_text]
  → final.mp4 + film.srt
```

## 模块划分

| 文件 | 职责 |
| --- | --- |
| `lib/drama/ffmpeg.mjs`（新增） | 探测 FFmpeg；构造并执行 concat / 混音 / 软字幕封装命令；超时与错误脱敏 |
| `lib/drama/subtitle.mjs`（新增） | 从 shots 派生 SRT；解析/序列化 SRT 供校对保存 |
| `lib/drama/routes.mjs`（修改） | 新增端点：`POST/GET .../compose`、`GET/PUT .../subtitles`、`POST .../bgm`；成片静态服务 |
| `lib/drama/schema.mjs`（修改） | 项目增加 `compose`（status/file/error/updatedAt）与 `bgm`（file/originalName）字段及归一化 |
| `public/drama.js` / `drama.html`（修改） | 「生成」视图四面板：合成（状态+预览+导出）、字幕校对、音乐上传、既有逐镜生成进度 |
| `public/drama.css`（修改） | 生成视图新增面板样式 |

## 数据流

1. 生成视图载入 → 探测 FFmpeg；未就绪则顶部 banner 提示、合成按钮禁用。
2. 「字幕」面板：自动派生 SRT 列表 → 逐条校对 → `PUT .../subtitles` 保存（回写对应镜 dialogue 或独立字幕轨）。
3. 「音乐」面板：上传 BGM → `POST .../bgm` 存项目目录。
4. 点「合成成片」→ `POST .../compose` → 客户端轮询 `GET .../compose` 进度 → 完成后预览 + 「导出 MP4 / 导出 SRT」。

## 字幕与 BGM 细节

- **字幕**：默认取每镜 `dialogue`（空台词镜跳过），时间轴按 `durationSec` 顺序累计；校对即编辑文本/微调；导出 `film.srt`，同时软字幕封装进 MP4。
- **BGM**：上传本地音频；合成时循环铺满全片时长，用 sidechain 压缩或音量压低闪避到台词之下；提供音量调节。

## 错误处理与降级

- **FFmpeg 缺失**：生成视图 banner「FFmpeg 未就绪」+ 安装指引，合成禁用；其余编辑流程不受影响。
- **镜头未就绪**：合成前校验所有镜 clip 均 confirmed，否则 409 并点名缺哪几镜，引导回去补。
- **合成失败**：落 `compose.status=failed` + 脱敏错误信息，**不自动重试**，用户手动重来。
- 沿用统一 JSON envelope（`ok/errorCode/message/retryable`）。

## 测试

- **单测**（`node:test`，沿用 `tests/drama-*.test.mjs` 模式）：
  - `subtitle.mjs`：SRT 派生（时间轴累计、空台词跳过、字幕特殊字符转义）与解析/序列化往返。
  - `ffmpeg.mjs`：探测逻辑（mock `FFMPEG_PATH`/PATH/常见路径）、concat/混音命令构造。
  - schema：`compose`/`bgm` 字段归一化与默认值。
- **检查**：`npm run check` 增加 `lib/drama/ffmpeg.mjs`、`lib/drama/subtitle.mjs`。
- **冒烟**：零费用环境下合成端点守卫（缺 FFmpeg → 未就绪响应；缺 confirmed clip → 409），不触发真实 FFmpeg。

## 验收标准

1. `npm run check`、`npm run test:unit`、`npm run smoke` 全部通过。
2. 生成视图可探测 FFmpeg 并在缺失时给出明确「未就绪」提示。
3. 可从分镜派生字幕、逐条校对并保存、导出 SRT。
4. 可上传 BGM 并在合成时混入（循环 + 闪避）。
5. 合成产出可预览、可下载的成片 MP4 + SRT；缺镜头或缺 FFmpeg 时给出明确守卫提示。
