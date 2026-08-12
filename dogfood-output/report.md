# 狗食测试报告 · Digital Human Studio

- 日期：2026-08-16
- 范围：M7–M12 平台级模块端点 + 前端视觉
- 测试方式：本地 server（PORT=4299）+ curl 端点 + 浏览器视觉检查

## 执行摘要

- 总问题数：1
- 按严重度：Medium 1
- 按类别：Visual 1
- 所有 API 端点功能正确、脱敏正确、无 console 错误

## 问题清单

### Issue 1: 平台视图 tab 排列错位

- **严重度**：Medium
- **类别**：Visual
- **URL**：http://127.0.0.1:4299（平台视图）
- **描述**：`#platformTabSeg` 有 3 个 tab（提示词/素材/模型），但 `.vz-seg` CSS 是 `grid-template-columns:1fr 1fr`（2 列），导致第三个 tab（模型）换行到第二行，与提示词/素材 不同行。
- **复现**：点图标栏「平台」(⚙) → 平台视图 → tab 排列：提示词/素材在第一行，模型单独在第二行。
- **预期**：3 个 tab 同行排列。
- **实际**：模型 tab 换行。
- **修复**：`#platformTabSeg` 内联样式覆盖 `grid-template-columns:1fr 1fr 1fr`，宽度调 300px。

## 测试覆盖

### API 端点（全部通过）

| 里程碑 | 端点 | 结果 |
| --- | --- | --- |
| M7 | GET /api/drama/prompt-templates | 1 内置模板 ✓ |
| M7 | POST /api/drama/prompt-templates | 建模板 ✓ |
| M7 | POST .../duplicate | 复制副本 ✓ |
| M7 | PATCH /api/drama/projects/{id}（切模板） | 写入 promptTemplateId ✓ |
| M7 | PATCH ...（不存在模板） | 422 ✓ |
| M7 | PATCH ...（置 null） | 回默认 ✓ |
| M7 | PATCH 内置模板 | 403 ✓ |
| M7 | DELETE 模板 | 200 ✓ |
| M7 | POST /api/drama/materials | 上传 PNG ✓ |
| M7 | GET /materials/{file} | 静态服务 200 ✓ |
| M7 | GET /api/drama/providers | 5 区块状态 ✓ |
| M9 | GET provider-overrides | null（未配置）✓ |
| M9 | PATCH provider-overrides（写 LLM） | configured:true ✓ |
| M9 | 脱敏检查 | 响应体不含 sk-SECRET123/apiKey ✓ |
| M9 | PATCH .../clear | 清除 ✓ |
| M10 | GET /api/drama/queue/status | 三 kind 全 0 ✓ |
| M11 | GET .../export/zip（未合成） | 409 ✓ |
| M12 | GET .../suggestions | null ✓ |
| M12 | POST .../suggestions/regenerate | 202 ✓ |

### 前端视觉

- 首页加载：无 console 错误 ✓
- 演示剧本按钮：点击无错误 ✓
- 平台视图：tab 排列错位（Issue 1）
- 后端覆盖区：输入框与按钮高度不一致（21px vs 37px），视觉对齐稍差——非 bug，记录为打磨项

## 未测试

- 真实 LLM 调用（需配置 DRAMA_LLM_*）
- 真实 ComfyUI 首帧/视频（需本机 ComfyUI）
- 真实 Seedance 口播（需适配器）
- 真实 ElevenLabs 配音（需 Key）
- Electron 桌面版（只测了 web 版）
