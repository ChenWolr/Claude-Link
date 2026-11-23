# AI 回复点击翻译 · UI 设计定值说明

配套效果图：`translate-ui-variant-1-inline.html`（内联跟随式）/ `translate-ui-variant-2-tabbed.html`（原文/译文切换式）/ `translate-ui-variant-3-immersive.html`（沉浸替换式）。
三图均内嵌同一份 12 色板切换器（映射写法对齐 `src/renderer/utils/apply-theme.ts`），本文表格中的 borderStrong 建议值已直接编入三图的 JS 色板数据，切换「墨石 ↔ 终端」即可验收「边界线两板下均可见且浅」。

---

## 1. 12 套色板 `--color-border-strong` 建议值全表

现状：只有墨石显式定义（`#D5DAE1`），其余 11 套经 `apply-theme.ts` 回退 `rgba(0,0,0,0.12)`；暗色板终端是黑上黑（12% 黑叠在 `#14171C` 上几乎不可见）。

| # | 色板 | isDark | panel 底 | 现值 | 建议值 | 说明 |
|---|------|--------|----------|------|--------|------|
| 1 | 墨石 inkstone | 否 | #F6F7F9 | #D5DAE1 | **#D5DAE1（保留）** | 官方已定义，冷灰、与 border #E4E7EC 恰差一档 |
| 2 | 暖纸 warm-paper | 否 | #F4F0EA | rgba(0,0,0,0.12) | **#D9D0C6** | 暖棕灰（掺板色相），比回退值深半档 |
| 3 | 草香 grass-aroma | 否 | #EFF3EC | rgba(0,0,0,0.12) | **#CFDAD1** | 灰绿调，与 border rgba(91,168,140,.22) 同相 |
| 4 | 珊瑚 coral | 否 | #FCF1E4 | rgba(0,0,0,0.12) | **#E0CFC3** | 暖陶土灰，压住奶油底 |
| 5 | 沉思 contemplation | 否 | #ECEFF2 | rgba(0,0,0,0.12) | **#CBD1D8** | 蓝灰，随 accent #7E99A8 色相 |
| 6 | 绝对 absolutely | 否 | #EDEAE2 | rgba(0,0,0,0.12) | **#CFCBC2** | 暖灰褐（板 border 本就是 rgba(177,173,161,.28)） |
| 7 | 素白 high-contrast | 否 | #F3F1F0 | rgba(0,0,0,0.12) | **#D6D0CD** | 暖中性灰，稍深以贴该板高对比定位 |
| 8 | 深思 deep-think | 否 | #F0F0F2 | rgba(0,0,0,0.12) | **#D3D3DB** | 微紫灰，随 accent #636AE8 |
| 9 | 纯白 delve | 否 | #F0F0F0 | rgba(0,0,0,0.12) | **#D6D6D6** | 纯中性（该板 accent 即近黑，边界不染相） |
| 10 | 新暖纸 new-warm-paper | 否 | #EFE8DB | rgba(0,0,0,0.12) | **#C8C0B2** | 比该板 border #D8CFBE 深一档（板底偏深，值相应加深） |
| 11 | 静默 quiet-console | 否 | #FFFFFF | rgba(0,0,0,0.12) | **#D7D9DC** | 冷灰（随近黑 accent 的冷调），白底上清晰 |
| 12 | 终端 terminal-pro | 是 | #14171C | rgba(0,0,0,0.12) | **#3D444D**（border 建议值 **#30363D**） | 对齐 GitHub Dark 描边可见性量级（见下方修正记录） |

### 取值逻辑

**浅色板（1–11）**：以各板 panel 底为基取 **13%~18% 黑量**的实色（回退值 12% 黑在上两者间几乎不可辨），并把该板 accent / 文本的色相以极低饱和掺入（如草香掺绿、沉思掺蓝、暖纸掺棕）——色相掺入让分隔线「属于这块色板」而不是通用灰条；刻意与各板 `--color-border` 拉开一档：`--color-border` 是卡内细线/描边，`--color-border-strong` 是大区分隔（侧栏缘、顶栏缘、表头缘），两者层级必须可辨。实色（hex）而非 rgba：分隔线横跨 bg/panel 两种底，alpha 混色会在两种底上深浅漂移，实色行为可预期。

**暗色板（终端）**：方向相反——不是加深而是**提亮**：`--color-border` 提到 **#30363D**、`--color-border-strong` 提到 **#3D444D**（对齐 GitHub Dark 的 border-default #30363D 落在 #0D1117 上的公认「可见但浅」量级——本板底色 #0F1115/#14171C 与 GitHub 底几乎相同，直接借用其标定），远低于 text（#D3D8E0）不抢正文。黑上叠黑在物理上不可能可见，任何暗板的「可见但浅」都是提亮问题。若未来新增暗板，按同一规则取 GitHub Dark border 量级（亮于底一档、暗于 text 三档以上）标定。

### 暗板可见性修正记录（2026-11-19 验收回打）

- **病灶**：首版效果图终端板沿用 `prototypes/sidebar-card-variant-a.html` 先例值——`--color-border-strong: #2E3440`、`--color-border: #23272F`。用户浏览器实测判定：右栏分隔线（#2E3440 落在 #14171C 上）与会话卡描边（#23272F 落在同底色卡片上）均「看不见」，仅达「勉强可辨」以下。判定基准失误原因：先例值当初标定在 #0F1115 大底上勉强成立，落到更深的 panel 底 #14171C 与卡片自身同底描边场景后亮度差不足。
- **修正（旧值 → 新值）**：
  - `--color-border-strong`：#2E3440 → **#3D444D**（侧栏右缘 / 右栏分隔线 / 顶栏底缘 / 表头缘）
  - `--color-border`：#23272F → **#30363D**（会话卡描边 / 气泡描边 / 表格线 / 页内细线）
  - 暗板卡片底提亮：初版效果图曾用新增演示变量 `--color-card-panel` #1A1E26；P2 终版裁决收敛为零新 token——直接用各板既有 `panelSoft`（终端 **#1B2027**，与 #1A1E26 仅差 1 个色阶），浅色板卡片底随之变 panelSoft 微浮起（有意为之，对齐 SessionsPage/TaskItem 卡片语言）。
- **判定标准**：1px 线在真实屏上**清晰可辨、但不抢内容**——即一眼能找到分隔线/卡片边界（GitHub Dark #30363D on #0D1117 的观感档位），同时线色与正文 text #D3D8E0 保持三档以上亮度差、不形成第二条「文字行」。对照物：GitHub Dark border-default 量级。
- **效果图落地方式（P2 终版）**：三个 HTML 的色板数据同步为上值；卡片底色直接消费既有 `panelSoft`（终端 #1B2027），零新增变量，`applyPalette` 保持 apply-theme.ts 同构 14 变量。正式落地零新 token：只改 `.session-card` 的 border/background 两行 + hover 公式换底（见第 2 节）。

---

## 2. 会话卡片静止态描边与底色的 token 用法（P2 终版裁决：零新 token）

**终版口径：静止卡 = `--color-panel-soft` 底 + `--color-border` 1px 描边，零新增 token。**

理由：

1. **语义已就位**：12 套色板都各自调好了 `--color-border` 与 `panelSoft`，「静止态弱边界 + 微浮起底」正好由这两个既有 token 承担；active 卡的 accent 45% 描边与之天然分层（弱边界 → 强边界两级）。
2. **影响面最小**：任何新 token 需要同步四处——`constants.ts` ThemePalette 字段、`apply-theme.ts` 映射与回退、`ConfigPage.vue` 的副本清单、`variables.css` 静态层；零新 token 只改 `AppSidebar.vue` 的 `.session-card` 两行（`border: 1px solid transparent` → `var(--color-border)`；`background: var(--color-panel)` → `var(--color-panel-soft)`）+ hover 公式换底。
3. **卡片语言对齐全应用**：panelSoft 底 + border 描边与 SessionsPage / TaskItem 卡片同语言；浅色板从「与侧栏同底」变为「panelSoft 微浮起」（墨石=白卡落 #F6F7F9 上），有意为之、不回退。
4. **已有搭配不用动**：卡片已有 `box-shadow: var(--ring-light), var(--elevation-1)`，与 panelSoft 底叠加为「浅浮起」层次，与气泡、工具卡的卡片语言一致。

暗板可见性：终端板 `--color-border` 已按第 1 节修正记录提到 #30363D，描边单独即达「清晰可辨」档；卡片底 panelSoft=#1B2027 比 panel #14171C 亮一档，底色浮起为第二重可见性——两重叠加，不再引入任何变量。hover 底色公式同步换底：`color-mix(in srgb, var(--color-text) 4%, var(--color-panel-soft))`。

---

## 3. 三变体差异对比与推荐

| 维度 | 变体一 · 内联跟随式 | 变体二 · 原文/译文切换式 | 变体三 · 沉浸替换式 |
|------|----------------------|--------------------------|---------------------|
| 布局结构 | 气泡正文 + 底部追加浅底引用块（同宽对齐） | 气泡重构为「卡片头（角色+分段页签）+ 单内容视口」 | 译文原位替换正文，无追加块/页签；角色行徽标 + ghost pill 切换 |
| 视觉语言 | 引用块（accent 6% 底 + 左 3px 色条 + 2px 细进度线） | 分段控件 pill 页签 + 头部 1px 分隔线 | 段级 fadeIn 渐显 + shimmer 占位行 |
| 信息密度 | 双语同屏，最高 | 单语视口（页签常驻），中 | 单语、chrome 最少，最低 |
| 对照阅读 | 直接上下对照，表格类内容价值最大 | 需点击切换，但原文滚动位置保留、往返零成本 | 需切换，无同屏对照 |
| 流式期滚动稳定性 | 译文视口独立滚动（>240px 内部滚），原文区高度恒定 | 双视口预渲染，切换零重排；译文视口独立钉底 | 单视口跟底（与原生流式一致）；切换有 min-height 防塌陷 |
| 实现成本 | 中：新增一个附着于 MessageBubble 的 v-if 子块，不动气泡结构 | 中高：需重构气泡为卡片头布局，role header 区改动外溢 | 低：内容替换 + 原文暂存 + pill，结构改动最小 |
| 风险 | 长回复纵向变长（被引用块 max-height 封顶兜住） | 页签语言与侧栏「全部/项目」页签重叠，双 tab 语义易混淆 | 「这条回复其实是英文」来源意识弱，需徽标/按钮补偿 |

**推荐：变体一（内联跟随式）。**

- **性能**：双语同屏但各自独立滚动，追加只发生在译文视口内部（超 240px 后转内部滚动钉底），CLS 影响被限制在单块内；没有 V2 的双视口高度同步、也没有 V3 的整气泡高度跳变。
- **信息密度**：点击翻译的核心诉求是「对照读」，双语同屏直击诉求；天气表这类结构化内容双语文本错位时，同屏对照价值最大。
- **实现成本**：新增块完全附着在 `MessageBubble.vue` 内部（v-if 引用块），不触碰气泡既有结构（V2 要重构卡片头、改动外溢到 role header；V3 结构改动最小但牺牲对照能力与来源意识）。

---

## 4. 翻译按钮入口位置与三态建议

**位置（按消息状态分流）**

- **已落库消息**：复制按钮同排——气泡右下角外侧（`.bubble__copy` 所在行，复用其 hover 命中桥 `.bubble::after`），与复制钮并排、`gap: 8px`。显隐机制与复制钮一致（hover / focus-within 显现），保持「气泡操作都在右下角外一行」的既有语言；成功翻译后按钮就地转终态（见下），不迁移位置。
- **流式中消息**：`stream-group` 尾部（StalledBanner / ApiRetryBanner / StreamRenderer 之后、独立一行，即本图 `.stream-tail` 的位置）。理由：流式气泡内容每次 flush 重排，按钮不能进内容流；该位置同时是 turn-footnote 载体位——回合落库后 stream-group 卸载、按钮迁移到气泡 copy 行，位置感知连续。

**形态**

- pill（`border-radius: 999px`）+「译」象形图标（A/文 转换符号）+ 文案「翻译」；`min-height/min-width: 28px`（桌面最小命中口径，带文案按钮一步到位），`padding: 3px 10px`，`font-size: 0.75rem; font-weight: 600`；默认 `panel-soft` 底 + `--color-border` 描边 + muted 字。

**三态**

1. **hover**：`accent-strong` 字 + accent 40% 描边 + accent 10% 底（复用 `.bubble__copy:hover` 的 color-mix 配方），120ms ease-out。
2. **进行态**：refresh 图标旋转（0.9s linear infinite）+ 文案「翻译中… N%」（N 为已译段落比例），accent 45% 描边 + accent 8% 底；`cursor: default` 且重复点击无效；`aria-live="polite"` 播报进度；reduced-motion 下停转、只留文案。
3. **错误态**：`--color-danger` 字 + danger 45% 描边 + danger 8% 底，文案「重试」（点击即重试）；`aria-live="assertive"`；失败原因进 tooltip（如「翻译服务超时」）。终态（完成）：quiet 化为「已翻译 ✓」成功色 pill 或直接回落为可重译的静止态，由实现按信息噪音取舍（效果图一取后者：完成即回落静止态，译文块自身有「翻译完成」标签承担状态表达）。

---

## 附：三图共用的基准实现快照（供实现对照）

- 布局：左栏 240px（`.sidebar` border-right）、主区 800px 居中列（`padding: 20px max(24px, calc((100% - 800px)/2))`）、右轨 48px（`.rail` border-left）；左缘/右缘/顶栏底缘统一 `--color-border-strong`。
- 气泡：user/assistant 统一 `max-width: 85%`（基准修复 D）；user = accent 12% 淡彩底 + 右 3px accent 色条；assistant = panel-soft 底 + 左 3px accent 色条 + 1px `--color-border`。
- 流式光标：`▊`，`animation: blink 1s step-end infinite`（镜像 StreamRenderer.vue）。
- markdown 表格：镜像 `main.css` 的 `.markdown-body table` 规则（block、max-content、cell 0.4rem/0.75rem padding、thead 用 border-strong、偶数行 accent 5% 混色）。
- 输入框：8 行展开态高度 `calc(0.875rem * 1.5 * 8 + 22px)`（与真实 4 行 max-height 公式同构），右下滚动条暗示 + 底部「8 行封顶后内部滚动」提示（基准修复 E）。
- 双流模拟：原文 300ms/段、译文滞后 2 段 340ms/段（batch 段级追加）；所有 DOM 追加经 50ms rAF 节流合帧（对齐 use-stream 节流口径）；scroller 仅 nearBottom(<80px) 跟底（镜像 MessageList OPT-6 纪律）；纯 JS、零外部资源，双击即开。
