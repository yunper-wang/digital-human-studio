# 短剧工作台 UI 重设计 —— 「宣纸墨色」设计文档

日期：2026-08-12
状态：已获用户逐屏视觉确认（visual companion 四轮：三方向选型 → 分镜旗舰页 v1/v2 → 四视图全览）
范围：`public/drama.html` 单页工作台（剧本/资产/分镜/生成/平台 5 视图 + 预算弹窗 + toast）

---

## 1. 背景与问题

当前界面（`public/drama.css`，"VOZEB 浅色风"）被用户判定为「配色布局 LOW」。逐屏走查后的客观诊断：

1. **无品牌色**：全灰白 + 纯黑按钮，像内部工具原型，无记忆点。
2. **图标廉价**：导航用 Unicode 字符画（▤◉▦▶⚙），粗细不一、无风格。
3. **文字层级弱、对比度低**：灰字 `#8a93a0` 级小字（10–12px）大面积使用；步骤条未激活态 `#8a93a0` 近不可读；分镜空态灰字压深底对比不足。
4. **banner 突兀**：高亮米黄（`#fffbe6/#ffe58f`）与灰白界面脱节。
5. **布局稀疏**：生成视图 6 张卡片单列堆叠，右侧大片空白；资产视图角色卡全宽单行，浪费横向空间。
6. **分镜预览区与浅色界面打架**：深色渐变舞台 `#171b22` 孤立存在，与周围白卡无任何视觉关联。
7. **细节随意**：暖色/冷色阴影混用、缩略图徽标蓝黄双色编码过跳、滑块/进度条黑块生硬。

## 2. 设计方向（已锁定）

**B「宣纸墨色」**——暖纸白底 + 墨色文字与主按钮 + 朱砂红点缀 + 衬线（宋体系）展示标题。参考气质：Notion / Things 的编辑室质感 + 一点东方纸本感。

用户在 A（暗夜工作室·深底琥珀金）/ B / C（霓虹剧场·深底荧光绿）三方向视觉稿中选定 B。

### 已锁定决策（视觉稿迭代中确认）

| 决策 | 内容 | 来源 |
|---|---|---|
| 画廊式预览区 | 深色预览框不再裸放：暖灰卡纸衬底（带宣纸肌理）+ 白边画框 + 底部墨色铭牌 | 分镜稿 v1 通过 |
| 对比度底线 | 辅助灰字从 `#8a93a0` 档加深到 `#6f6e66` 档；9px 小字消灭（最小 10px，正文 ≥11px） | 用户反馈 v1「看不清」 |
| 检查器宽度 | 268px 档 → **320px**，字段字号 11.5px、间距 13px、内边距 16–18px | 用户反馈 v1「太挤」 |
| 朱砂红收敛 | 只给：主 CTA（开始解析/应用修改/确认预算/合成）、导航/步骤/缩略图的选中态、预算总额。徽标、进度条、状态点一律不用红 | 分镜稿 v2 自述收敛 |
| 生成视图双栏 | ≥1100px 时 `1.55fr : 1fr` 双栏网格，消灭右侧空白 | 四视图全览通过 |
| 零 JS 逻辑变更 | 纯 CSS 换肤 + HTML 图标替换 + 1 行 JS（步骤条 done class）。不重命名任何 class/ID | 本文档 §4 |

## 3. 设计令牌（Design Tokens）

写入 `body.drama-body` 的 `:root` 作用域。**保留全部旧变量名并赋予新值**（drama.html 内联样式引用了 `var(--border)` 等，见 §4 兼容策略）。

```css
body.drama-body {
  /* —— 新令牌 —— */
  --paper:#f7f5f1;              /* 页面底·暖纸 */
  --line-strong:#ddd8cc;        /* 输入框等较强边 */
  --ink:#24272b;                /* 主文字 / 主按钮 */
  --ink-2:#3a3b36;              /* 次文字 */
  --red:#c0452f;                /* 朱砂：主 CTA / 选中态 */
  --red-hover:#a83a26;
  --red-soft:#f4e8e4;           /* 朱砂浅底（锁定徽标等） */
  --ok:#357a55;                 /* 松绿：成功 / 在线 / 完成 */
  --ok-soft:#e4efe8;
  --warn:#9a6b2f;               /* 琥珀纸：提示 banner */
  --warn-bg:#fdf3e7;
  --warn-line:#f0dfc2;
  --demo:#c99a3a;               /* 演示态点 */
  --off:#c9c5b8;                /* 未配置/离线点 */
  --mono:ui-monospace,"DM Mono",monospace;
  --faint:#8f8e85;              /* 最弱 meta 文字（仅 ≥10px 非关键信息） */
  --serif:"Songti SC","Noto Serif SC","STSong",serif;
  --r-card:14px;                /* 卡片圆角 */
  --r-ctl:9px;                  /* 控件圆角 */
  --sh-card:0 1px 2px rgba(60,50,30,.05), 0 8px 24px rgba(60,50,30,.06);
  --sh-pop:0 18px 45px rgba(60,50,30,.18);
  --focus:0 0 0 3px rgba(192,69,47,.22);

  /* —— 旧变量名兼容层（值已换新）—— */
  --bg:var(--paper);
  --card:#ffffff;
  --border:#e6e2d9;
  --text:var(--ink);
  --soft:#f2efe9;
  --muted:#6f6e66;
  --primary:var(--ink);         /* 旧"黑按钮"语义 → 墨 */
  --danger:#b3392b;
}
```

### 对比度核验（白底 / 纸底，WCAG 参照）

| 用途 | 颜色 | 对比度 | 结论 |
|---|---|---|---|
| 正文/主按钮文字 | `--ink #24272b` | ≈14:1 | AA+ |
| 辅助文字（≥11px） | `--muted #6f6e66` | ≈5.9:1 | AA |
| 最弱文字（仅 ≥10px 的 meta/placeholder） | `#8f8e85` | ≈3.6:1 | 限非关键信息 |
| 朱砂 CTA/选中 | `--red #c0452f` | ≈5.9:1 | AA |
| 松绿 成功 | `--ok #357a55` | ≈5.4:1 | AA |
| 琥珀 banner 文字 on `--warn-bg` | `--warn #9a6b2f` | ≈5.3:1 | AA |
| 空态文字 on 深色画框内 | `#b9b4a6` on `#151310` | ≈7:1 | AA |

### 字体与字号阶梯

- 正文/控件：`-apple-system, "PingFang SC"` 体系；正文 12–13px；辅助 ≥11px；meta ≥10px。
- 展示标题（衬线）：`.vz-projhead h1`、`vz-card` 标题级、向导大标题用 `var(--serif)`；数字/金额/时间用 `var(--mono)`。
- 阶梯：页头 h1 17px / 卡标题 14.5–15px / 正文 12px / 字段标签 11px / 辅助 10.5–11px。

## 4. 隔离与兼容策略（核心工程决策）

**目标：视觉全换，逻辑零动。**

1. **不重命名任何 class / ID**。`drama.js`（1575 行）以 innerHTML 模板 + className 写入全部视图；drama.html 内联样式引用 `var(--border)` 等旧变量。全部保留。
2. **改动面**：
   - `public/drama.css` —— 整体重写（唯一主战场）。
   - `public/drama.html` —— 仅两类小编辑：① 导航/顶栏的字符画 glyph 换成内联 SVG（§7）；② 给生成视图两张匿名卡片加语义 class（`vz-g-budget`、`vz-g-gate`）以便双栏网格定位。
   - `public/drama.js` —— **仅 1 行**：`renderStepper` 给激活步骤之前的步骤加 `done` class（现有 CSS 有 `.done` 选择器但 JS 从未写入）。除此之外零 JS 变更。
3. **不碰**：`public/styles.css`（旧深色主题，已无页面引用）、`server.mjs`、全部 `lib/`、全部测试。
4. 回归验证：`npm run check` + `npm test`（unit + smoke）必须原样通过；实施后用 grep 证明 drama.js 无 class 字符串改动。

## 5. 全局骨架

### 5.1 左侧 rail（`.vz-rail`）
- 背景 `--soft`，右边线 `--border`；宽度维持 96px（含文字标签，M-UI 已定）。
- logo `.vz-logo`：墨底纸字。
- 导航项 `.vz-ic`：SVG 图标 17px stroke 1.8 + 10.5px 标签；常态 `--muted` 档（`#5f5e57`）；hover 白底；`.on` 白底 + 朱砂图标文字 + 600 字重 + `--sh-card` 轻影。

### 5.2 顶栏（`.vz-topbar`）
- 底 `#fbfaf7`，下边线 `--border`。
- `.t` 的「▦」字符画换成胶片 SVG（§7），文字 600。
- 服务商胶囊 `.vz-provider`：白底 + `--border` 边 + 11px 文字；状态点三色：在线 `--ok` / 演示 `--demo` / 未配置 `--off`。

### 5.3 通知条（`.vz-banner`）
- 默认（演示提示）：`--warn-bg` 底 + `--warn-line` 边 + `--warn` 字，圆角 9px，去掉旧亮黄。
- `.error`：底 `#faeceb`、边 `#ecc8c4`、字 `--danger`。

### 5.4 项目头（`.vz-projhead`）
- padding 16px 18px；`h1` 改 `var(--serif)` 17px；描述与 tags 用 `--muted` 11.5px。

### 5.5 步骤条（`.vz-stepper` / `.vz-step`）
- 每步 12px，padding 8px 0；常态文字 `#8f8e85`、序号 mono `#9d9c93`。
- `.on`：墨底纸字 600。
- `.done`（新增 JS 写入）：文字 `--ink-2` 500；序号隐藏，CSS `::before` 注入「✓」`--ok` 色。

### 5.6 卡片基类（`.vz-card`）
- 白底、`--border` 1px、`--r-card` 14px、`--sh-card`（暖色阴影，替换旧冷灰阴影）。

### 5.7 控件
- `.vz-btn`：白底 `--border` 边、`--ink-2` 字、radius 9；hover `--soft` 底。
- `.vz-btn-primary`：墨底纸字；hover 纯黑 `#000`。
- 朱砂 CTA 类 `.vz-btn-red`：`--red` 底白字；hover `--red-hover`。规则置于 `.vz-btn-primary` 之后定义。红色**只**给主行动按钮：
  - HTML 中 5 个按钮的 class 由 `vz-btn-primary` 替换为 `vz-btn-red`：`#runPipelineBtn`（开始解析）、`#runPipelineBtn2`（重新解析）、`#composeBtn`（合成成片）、`#gateABtn`（确认预算）、`#gateAConfirm`（弹窗·确认并继续）。
  - 检查器底部「生成视频 / 重新生成视频」是 JS 渲染的 `.vz-apply`（drama.js:630，class 已存在）——**纯 CSS** 置红，零 JS 改动。其下的「确认视频」保持 `.vz-btn-primary` 墨色。
  - 其余按钮（生成全部首帧/视频、导出、回滚等）一律 ghost / 墨，不用红。
- `.vz-input` / `.vz-select` / `textarea`：底 `#fbfaf7`、边 `--line-strong`、radius var(--r-ctl)；`:focus-visible` 边 `--ink` + `box-shadow: var(--focus)`。
- 所有可交互元素 `:focus-visible`：`outline:2px solid var(--red); outline-offset:2px`（键盘可达性）。
- `input[type=range]`：`accent-color: var(--ink)`。

## 6. 五个视图改动清单

### 6.1 剧本（`#viewScript`）
- 向导卡 `.vz-wizard`：`wiz-num` 圆徽墨底纸字；`wiz-title` 衬线 24px（纯墨色，不加红）；`wiz-input`/`wiz-script` 走 §5.7 控件规范；`wiz-foot` 辅助文字 11.5px。
- 阶段列表 `.stage-list li`：左侧 16px 状态圆点按 `renderStages` **实际写入的 class** 映射（drama.js:309–310 只有两种）：完成（`.done`）`--ok` 底「✓」/ 运行中（`.active`）`--red` 底「●」带脉冲 / 等待（无 class）`--soft` 底灰序号；**失败态无 class 钩子，不加状态点**，仅排版（零 JS 约束）。右侧 `<em>` 元信息 `--muted` 10.5px。
- 智能建议 `#suggestionList`：条目虚线分隔；若 `renderSuggestions` 输出严重级标识，按 高=朱砂 / 中=琥珀 / 低=灰 圆点映射，否则统一左缘 2px `--border` 竖条。按钮「重新分析」ghost 小按钮。

### 6.2 资产（`#viewAssets`）
- `#characterList`：≥1100px 双列网格（`grid-template-columns:1fr 1fr; gap:10px`），<1100px 单列。
- 角色卡选择器为 **`#characterList .character-item`**（drama.js:325；注意 `.vz-char` 是**场景/道具**条目，drama.js:396/432，二者不可混用）。现有 CSS 无 `.character-item` 规则，本期新建。
- **设计让步（零 JS 约束驱动）**：角色卡 DOM 无 `<img>`（只有 `b`/`span`/`small` + `.bind-row` selects），视觉稿中的真人头像照片需 JS 解析「绑定形象 → 图片」，超出零 JS 约束。降级为 **CSS `::before` 装饰头像**：56×72、radius 9、`--soft` 底 + 人形剪影 SVG data-URI（`--ink` 20% 透明度），全卡统一。真人照片头像列为后续增强（需 JS 改动，不在本期）。
- 卡内排版：`b`（`名字 · 角色` 同行文本）12.5px 700；`span`（性格）10.5px `--muted`；`small`（外貌）10px `--faint`；`.bind-row` label 10.5px `--muted` + select 全宽；卡片 grid `56px 装饰列 + 内容列`，gap 12。
- 场景/道具（`#sceneList .vz-char, #propList .vz-char`）：chip 风——圆角 8、`#fbfaf7` 底、`--border` 边、11px；使用次数等 meta `--faint` 9.5px。

### 6.3 分镜（`#viewStory`，旗舰）
- `.vz-story` 网格维持 `1fr 320px`。
- **画廊舞台 `.vz-stage`**：暖灰衬底 `radial-gradient(circle at 50% 0%, #f4f0e7, #e9e4d6 78%)` + 宣纸肌理（内联 SVG feTurbulence data-URI，opacity .5，rect opacity .05）；边框 `#e0dbcd`；radius 12；padding 16。
- **画框 `.frm`**：内底 `#151310`；`border:7px solid #fff`（白卡装裱）+ `box-shadow: 0 1px 2px rgba(60,50,30,.14), 0 12px 30px rgba(60,50,30,.24)`；radius 6；空态文字 `#b9b4a6`。
- **铭牌 `.stagetag`**：从左上挪到底部居中——`left:50%; transform:translateX(-50%); bottom:0`（`.vz-stage` overflow:hidden，不用 -1px 防裁切）；墨底纸字 10px，radius 7px 7px 0 0。
- 字幕 `.cap`（drama.js:580；现有规则 `#preview .cap`）：13px 700 白字，`text-shadow: 0 1px 4px rgba(0,0,0,.85), 0 0 2px rgba(0,0,0,.6)`。
- 预览卡标题 `.ph b`：衬线 15px；`#previewMeta` 11px `--muted`。
- **胶片条**：缩略图 `.vz-th` 84px 高；选中 `border-color: var(--red); box-shadow: 0 0 0 2px rgba(192,69,47,.28)`；徽标 `.bdg` 改中性（白底 92% 墨字），镜型区分改用 1.5px 左竖条（台词=朱砂 / 画面=墨色）；`.dur` 10px 600 白字带影；`.ok` 确认圆点改 `--ok` 底白「✓」；失败边 `--danger`。
- **检查器 `.vz-insp`**：padding 16px 18px；字段间距 13px；`top:66px` sticky 保持；标题 13.5px 700；`.vz-tabs` 槽式（`--soft` 底，激活白底+轻影）；`.vz-field label` 11px 500 `#5f5e57`；`.vz-seg` 激活墨底；「应用修改」改 `.vz-btn-red`，12.5px 700 radius 10；hint 10.5px `--muted`。

### 6.4 生成（`#viewGenerate`）
- **双栏网格**（≥1100px）：`#viewGenerate { display:grid; grid-template-columns:1.55fr 1fr; gap:12px; align-items:start }`；`#ffmpegBanner` 跨整行；`#composeCard`、`#subtitleCard` 左列；`#bgmCard`、`#versionCard`、`.vz-g-budget`、`.vz-g-gate` 右列。<1100px 退化单列。
- 成片预览 `#composePreview video`：白边装裱（6px 白边 + 暖阴影 + radius 10），与画廊画框同语言。
- 合成 CTA `.vz-btn-red`；导出按钮 ghost。
- 进度条 `.vz-progress`：轨道 `#eceae2`；首帧填充 `--ok`，**视频填充 `--ink`**（视觉稿中红色视频条是有意收敛——红只留 CTA/选中/总额）。
- 预算单：行 11.5px；合计行上边线 `--border`，金额 mono 700 **`--red`**（视觉稿已确认的红色例外）。
- 版本行：虚线分隔；「回滚」ghost 小按钮。
- 字幕行 `.vz-sub-row`（drama.js:1062）：`#fbfaf7` 底 + `--border` 边 + radius 9；时间码 mono 10px `--muted`。

### 6.5 平台（`#viewPlatform`）
- tab 段控 `#platformTabSeg`：槽式，激活墨底。
- 模板行：虚线分隔；徽标——内置只读 `--red-soft` 底朱砂字 / 使用中 `--soft` 底 `--muted` 字。
- 素材网格 tile：radius 10 + `--border` 边，hover 上浮 1px + `--sh-card`。
- **模型状态卡 `#providerGrid .vz-card`**（由 `loadProviders` 渲染，drama.js:1463，非 renderProviderOverrides）：状态文字色由 JS 内联 `PROVIDER_STATUS_COLOR` 设置——`ready` 用 `var(--ok)`、`missing` 用 `var(--muted)`，均随新令牌自动换色；`degraded` 为硬编码 `#c9a227`，纸底下可读，保留。状态文本自带「●」glyph，无独立圆点/胶囊 DOM 钩子（零 JS 约束下不新增）。本期范围 = **仅卡片外壳**：以一条 `#providerGrid .vz-card { padding:12px !important }` 覆盖其内联 `style.padding`，标题 12.5px、meta 10px `--muted` 1.6 行高。（状态胶囊/状态点为已记录降级；若未来允许 1 行 JS——`card.dataset.status = p.status`——可再启用。）
- 模板行（`renderTemplateList`）：虚线分隔；「内置」是 label 内文本后缀、「使用中」是行级 `.on` class，均无独立徽标元素——映射为行级样式：`.on` 行左侧 2px `--red` 竖条 + 文本 `--muted`，不新增 DOM。

### 6.6 弹窗与 toast
- `.vz-modal` 遮罩：`rgba(36,39,43,.4)`（暖墨遮罩）。
- `.vz-modal-card`：radius 16、padding 24、`--sh-pop`；标题衬线 17px。
- `.vz-toast`：白卡 + 左缘 3px 状态色（成功 `--ok` / 失败 `--danger`），radius 11，`--sh-pop`。

## 7. 图标系统（替换字符画）

内联 SVG，`stroke="currentColor"`，`stroke-width:1.8`，`fill="none"`，17px。路径已在视觉稿中验证渲染：

| 位置 | 现字符 | 新图标 |
|---|---|---|
| 导航·剧本 | ▤ | document（折角 + 三行） |
| 导航·资产 | ◉ | person（头肩） |
| 导航·分镜 | ▦ | film（胶片格 + 竖齿孔） |
| 导航·生成 | ▶ | sparkle（双星芒） |
| 导航·平台 | ⚙ | gear（齿轮简化：圆 + 八辐条） |
| 顶栏标题 | ▦ | film（同分镜，14px） |

HTML 中将 `.ic-glyph` 的文本内容替换为 SVG 标记（class 保留，尺寸由 CSS 控制）。

## 8. 响应式与降级

- 桌面工具定位不变，不设移动端断点；内容区 `min-width` 行为保持现状。
- `@media (max-width:1100px)`：`.vz-story` 单列 + `.vz-insp` 取消 sticky（现状保留）；新增 `#viewGenerate` 单列退化、`#characterList` 单列退化。
- 宣纸肌理发既有 SVG data-URI 实现，无网络字体、无新依赖、无构建步骤。

## 9. 验证方案

1. **回归**：`npm run check`（含 `public/drama.js` 语法检查）+ `npm test`（unit + smoke）原样通过。
2. **隔离证明**：`git diff public/drama.js` 仅含步骤条 done class 一行；`git diff public/drama.html` 仅含：6 处字符画→SVG 替换、2 个语义 class 追加（`vz-g-budget`、`vz-g-gate`）、5 处按钮 class 替换（`vz-btn-primary` → `vz-btn-red`，清单见 §5.7）。
3. **视觉走查**（浏览器截图 @1440×900，与已确认视觉稿比对）：
   - 空态向导 / 有项目剧本态 / 资产双列 / 分镜画廊（空态+有镜+选中+确认勾）/ 生成双栏 / 平台三 tab / 预算弹窗 / toast（成功+失败）/ banner（演示+错误）。
4. **对比度抽测**：§3 表格中每行的前景/背景对在浏览器取实际计算值核验。

## 10. 明确不做（YAGNI）

- 不做暗色模式/主题切换；不做多主题系统。
- 不引入任何字体文件、图标库、CSS 框架或构建工具。
- 不改任何交互逻辑、路由、状态管理；不动 `styles.css`、`server.mjs`、`lib/`。
- 不做移动端适配；不做视图信息架构重组（五视图 rail 结构维持）。
- 不为「阶段列表状态点 / 建议严重级 / 模型状态胶囊」新增 JS——JS 已有对应 class/结构则映射，没有则只改排版（§6.1/6.5 括号条款）。

## 11. 实施顺序（供计划阶段拆解）

1. 令牌 + 兼容层 + 基类（body/卡片/按钮/输入/焦点态）
2. 骨架：rail SVG 图标 + 顶栏 + banner + 项目头 + 步骤条（含 JS 1 行 done class）
3. 剧本视图
4. 分镜视图（画廊舞台 + 胶片条 + 检查器）
5. 资产视图
6. 生成视图（双栏网格 + 两张卡片加 class + 5 处按钮 class 替换为 `.vz-btn-red`）
7. 平台视图
8. 弹窗 / toast / 状态收尾
9. §9 验证全跑 + 截图比对
