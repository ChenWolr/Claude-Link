# 聊天输入框 zcode 风格改版 · 三变体设计说明

> 产出日期：2026-11-22 ｜ 产出人：UI设计审美 agent（p7a）
> ui-ux-pro-max skill 调用留痕：2026-11-22 经 Skill 工具加载 ui-ux-pro-max（SKILL.md 全文），应用其规则（SVG stroke 图标纪律 / 语义 token / 对比度 ≥4.5:1 / 动效 token / reduced-motion）。
> **申报**：skill 附带的 search.py 检索脚本因本机无 Python 3 运行时（WindowsApps stub，exit 49；无 py 启动器）未能执行，设计依据为 SKILL.md 内建规则表（fallback），未虚构任何检索结果。

## 产出文件

| 文件 | 变体 |
|---|---|
| `prototypes/input-variant-1-zcode-faithful.html` | 变体一 · zcode 忠实复刻 |
| `prototypes/input-variant-2-minimal.html` | 变体二 · 极简 |
| `prototypes/input-variant-3-hybrid-dock.html` | 变体三 · 混合收纳 |

三图均为自包含单文件 HTML（内联 CSS，无 JS、无外部资源、无外部字体引用），可直接双击打开。每图含 7-8 个状态帧（默认态 / 激活态多行 / 斜杠菜单 / 权限下拉 / 模型下拉 / 「+」弹层 / 发送钮双态对照 / 窄窗降级），主视角容器 ≥900px 并内置真实 `@media (max-width: 899px)` 降级规则 + 显式 560px 窄窗示意帧。

## 一、三变体差异点（布局结构 / 视觉语言 / 信息密度，三维各至少一变）

### 变体一 · zcode 忠实复刻
- **布局结构**：卡片双行——textarea 区在上、底部工具栏在下（+ 附件 ｜ 权限 pill ｜ 模型 pill ｜ 右端圆形发送钮）。斜杠菜单从卡片上方弹出（`bottom:100%`，对齐现状 `.slash-menu` ChatInput.vue:413）；附件 chip 列表在卡内顶部（对齐现状 AttachmentDraftList 位置 ChatPage.vue:605）。
- **视觉语言**：大圆角卡片（`calc(var(--radius-lg) + 4px)` = 20px，卡片感最强）+ pill 化工具栏（`var(--radius-pill)`，沿用现状 `.ctl__btn` 边框 + `--color-panel-soft` 底 + hover accent 描边语义）+ 44px 圆形 ink 发送钮（`--color-btn-ink` / `--color-on-btn-ink`）。
- **信息密度**：全量外露——权限 pill 完整显示「默认模式（需手动确认危险操作）」（ConfigPage.vue:1190 逐字），模型 pill 完整显示「sub2api / gpt-5.6-sol」+「默认」tag。
- 取形依据：现状浮岛 `.chat-composer` 的双行结构（ChatPage.vue:601-624）+ ZCode CLI 输入卡的「透明输入面 + 底部 pill 工具栏 + 圆形发送」形态；textarea 改为透明无内框（卡片即输入面），是「忠实复刻 zcode」的核心改动，testid 保留在 textarea 元素上。

### 变体二 · 极简
- **布局结构**：卡片单区——默认态仅「+」图标钮与 36px 小圆形发送钮行内嵌于卡片右下；权限/模型不外露，收进「+」弹出菜单（附件区 / 权限区含二级四档展开 / 模型区含二级展开）。
- **视觉语言**：中圆角卡片（`var(--radius-md)` 12px）+ 无框工具（图标裸钮：常态无边框无底色，hover 才显 `--color-panel-soft` 底色）+ 小圆形 ink 发送钮；浮起降为 `--elevation-2`（比现状浮岛 `--elevation-3` 更轻，呼应极简）。
- **信息密度**：最低——默认视野只有 + 与发送两个控件。
- 取舍说明：权限四档文案硬约束（逐字 ConfigPage.vue:1190-1193）在「+」弹层的权限二级展开帧中满足；权限 pill 的「盾牌 + 当前模式 + 箭头」形态以菜单内行项形式存在（pill 不占默认视野是本变体的布局定义）。

### 变体三 · 混合收纳
- **布局结构**：卡片双区——左侧竖向工具 dock（自上而下：+ ／ 权限缩写 pill「默认」／ 模型截断 pill「gpt-5…」／ dock 底端圆形发送钮 40px），右侧输入区保持「附件行在上 + textarea 在下」双行内容。指令规格「卡片双行 + 左侧竖向工具 dock」的组合取形：内容侧双行、工具侧竖向 dock，dock 即工具栏。模型 pill 折叠为二级弹层（点权限/模型 pill 弹下拉）。
- **视觉语言**：分区卡片——输入区与 dock 以 1px `var(--color-border)` 细分隔线分区，配合表面台阶（dock=`--color-panel`、输入区=`--color-panel-soft`）；pill 与图标混排（权限=pill、模型=截断 pill、+=图标钮）。
- **信息密度**：中——权限缩写 pill 外露（「默认」），模型名截断显示（「gpt-5…」），完整名进弹层。
- 斜杠菜单挂载点随布局调整为「输入区容器」（弹出宽度=输入区而非整卡），`bottom:100%` 位置语义与现状一致。

## 二、token 引用清单（三图一致遵守）

全部色值/圆角/阴影在组件 CSS 中以 `var(--…)` 字面引用，未硬编码 hex；各文件 `:root` 镜像块逐值镜像 `src/renderer/assets/styles/variables.css` 并注释真源变量名（主题九板经 apply-theme 运行时覆写即可自动适配）。派生色一律 `color-mix(in srgb, var(--token) N%, transparent/var(--token))`。

| 用途 | 引用 |
|---|---|
| 背景/面板/输入面 | `--color-bg` `--color-panel` `--color-panel-soft` |
| 边框（含分区线） | `--color-border` `--color-border-strong` |
| 文字/弱字 | `--color-text` `--color-text-muted` `--color-text-sub` |
| 强调/ink 对 | `--color-accent` `--color-accent-strong` `--color-on-accent` `--color-btn-ink` `--color-on-btn-ink` |
| 语义色 | `--color-danger` `--color-warn` `--color-warn-strong` `--color-success` |
| 用户气泡固定对 | `--color-bubble-user-bg` `--color-bubble-user-ink` |
| 圆角阶梯 | `--radius-xs/sm/md/lg/pill`（变体一卡片 = `calc(var(--radius-lg) + 4px)`） |
| 阴影/边缘光 | `--elevation-1/2/3` `--ring-light`（变体一/三卡片 = `--elevation-3` 对齐现状浮岛；变体二 = `--elevation-2`） |
| 动效 | `--ease-out` `--ease-spring` `--duration-fast/base/slow`（reduced-motion 由 token 层兜底） |
| 字体 | `--font-sans` `--font-mono` `--font-size-base` |
| 布局 | `--chat-bottom-max-width`（800px）`--chat-bottom-pad-x`（1.5rem） |

## 三、与现状结构的对齐说明

1. **testid 逐字保留**：`chat-input-textarea`（ChatInput.vue:386）、`chat-send-button`（ChatInput.vue:396）、`slash-menu` / `slash-menu-item` / `slash-menu-origin`（ChatInput.vue:335/351/362）以真实属性写在三图对应元素上。
2. **placeholder**：现状「输入消息；输入 / 联想命令（↑↓ 选择，回车确认）」基础上按硬约束补 `@` 引用语义 →「输入消息；输入 / 联想命令、@ 引用文件（↑↓ 选择，回车确认）」。`@ 引用文件` 为本改版新增语义（现状实现仅有 `/` 联想），后续实现需配套开发。
3. **斜杠菜单位置**：三图均从卡片/输入区上方弹出（`bottom:100%`），与现状 `.slash-menu` 一致；每页 5 项（`COMMANDS_PAGE_SIZE`，ChatInput.vue:35）；origin 徽章四类文案逐字对齐 `ORIGIN_LABELS`（74-79）；stale 提示「可能不是最新」与 provenance「N 个命令来源未知（待分类，未作为内置命令验证）· N 个隐藏命令（已移除/内部）」逐字对齐 369-379。
4. **附件状态两帧齐备**：附件 chip 列表（卡内顶部，image 缩略 chip 2.5rem + 文件 badge chip + 移除 ×，形态对齐 AttachmentDraftList）与斜杠菜单弹出态各占独立帧；「+」弹层帧示意附件选择入口（title 文案对齐 SessionToolbar.vue:298；实际选择链路 onPickAttachments，ChatPage.vue:324-346）。
5. **权限四档文案逐字**（ConfigPage.vue:1190-1193）：默认模式（需手动确认危险操作）／ 规划模式（只规划，审批后执行）／ 代理模式（自动提交文件编辑）／ 自动模式（越过所有权限检查，谨慎使用）；菜单 foot 逐字 SessionToolbar.vue:286「对切换后新发起的工具请求即时生效；bypass 需下一条消息生效」。
6. **发送钮双态**：三图均含「空输入 disabled（opacity .5，对齐 ChatInput.vue:574-577）+ 有内容/附件 active」两种渲染，并有显式双态对照帧；hover 手法 `filter: brightness(0.92)` 对齐现状（ChatInput.vue:571）。
7. **多行自增**：激活帧为 3 行示意；`max-height` 计算式 `calc(0.875rem * 1.5 * 8 + 22px)` 逐字保留（8 行封顶，ChatInput.vue:545）。
8. **禁用元素自查**：全文不含 worktree/分支选择入口，不含麦克风/mic/microphone（本仓无语音功能，不造假按钮）。
9. **范围外现状控件**（工作空间 pill / 思考强度 / 上下文环 / TurnTimer / 中断钮）：不在本批指令的变体规格内，未画入（最小影响面；后续实现批次另行处理）。
   - **更新（返图 v2）**：变体一已补入上述五项现状控件（见返图记录节）；本节『未画入』仅对变体二/三成立，P7-B 若选它们需先决策这些控件去处。

## 四、审美自查（ui-ux-pro-max 规则逐条）

- **视觉层级**：每帧一眼分清 输入面（主）→ 工具 pill（辅）→ 弹层（浮）；页头/图注为元信息层，不与画面争级。
- **留白与呼吸感**：卡内 padding 沿用 `--chat-bottom-pad-x`（1.5rem）节奏；图与图之间 34px；弹层与触发点统一 `+6px` 间距（工艺修复轮备注：现状 perm-menu 为 `calc(100% + 0.25rem)`=4px、slash-menu 为 0px，P7-B 统一时以现状值为准或有意改距并留痕）。
- **对比与焦点**：发送钮为唯一 ink 实底元素（焦点自然落位）；disabled 态 opacity .5 与现状一致。
- **一致性**：三图共享同一套 token 镜像、同一套图标 stroke 风格（24 viewBox / stroke-width 2 / round cap）、同一套菜单结构（head/scroll/foot）。
- **字体系统**：层级 3 级（正文 14px / 控件 12px / 注脚 10-11px）+ mono 仅用于模型 id 与命令名（对齐现状 `.model-trigger__model` 用 mono 的先例）；行高正文 1.5、控件 1.3-1.4。
- **信息密度与栅格**：变体一全量（≈3 pill + 发送）、变体三中密度（2 缩略 pill）、变体二最低（2 钮），真实分层而非装饰性差异。
- **装饰克制**：附件缩略图的渐变块仅为「无外部图片」约束下的占位示意（真实实现走 Blob URL 缩略图）；无多余渐变/阴影堆砌，阴影全部来自 token 阶。
- **可访问性**：`--color-text-muted`（#6A6C70）对 `--color-bg` 4.80 / 对 `--color-panel`（#F4F0EA）4.63（均过 AA 正文档）；ink 钮白字对 accent 4.43（过 3:1 图形/大字号档，现状 ink 语义对既有取值，与 ChatInput.vue 现状一致）；图标钮均带 aria-label/title；触达目标 44/40/36px（变体二 36px 为指令「小圆形」规格的取舍，已在报告申报；V3 40px 同低于 44px 建议值，与 V2 36px 同为极简/紧凑取舍）。

## 五、返图记录：变体一补现状控件清单（v2，2026-11-22）

> 缘由：用户选定【变体一 · zcode 忠实复刻】进入 P7-B 后返图反馈——效果图漏画现状输入区的「上下文环」（圆形进度环控件），并要求把现状 composer 其余被略去的常驻控件一并补入。仅更新 `input-variant-1-zcode-faithful.html`（变体二/三不动），补入控件均以现状 DOM 1:1 为准，不造假、不新增功能。

### 补入控件清单（五项，全部先读现状源码再画）

| # | 控件 | 现状真源（读取行段） | 补画形态 | 位次 |
|---|---|---|---|---|
| 1 | **上下文环** | `ContextButton.vue`（按钮/环 svg:142-173；popover:179-183；样式:199-251） | svg 圆环 viewBox 36、r 15.915，底圈 stroke=`--color-border` w3 op.7、扇形 stroke=`--color-accent` w3 round cap `stroke-dasharray="46 54"`、svg `rotate(-90deg)`、环体 1.375rem；hover popover 三行逐字（已用上下文 91.0k / 全部上下文 200.0k / 占比 46%，mono tabular-nums）；title 逐字「上下文已用 46%，长按 1 秒压缩」；思考呼吸态（accent 55% 描边 + 1.6s halo）画入运行帧；长按 1 秒压缩红色 danger 进度环在 CSS 留形（`.ctx-ring__progress`） | **工具栏最左第一项**（现状 SessionToolbar 第一个 ctl） |
| 2 | **工作空间 pill** | `SessionToolbar.vue:179-228`（`data-testid="workspace-trigger"`；label=目录尾段） | 文件夹图标（现状 path `M3 6l2-2h5l2 2h9v12H3z`）+「claude-link」；未选择时 warn 态未画帧（title 注明口径） | 上下文环右侧（现状第 2 项） |
| 3 | **思考强度 pill** | `ThinkingLevelSelector.vue`（trigger:100-113；LEVELS:25-33；foot:140-142；custom 态:189-193） | 灯泡图标（现状 path）+ 档名（默认帧「中」=跟随全局默认档名口径；运行帧「极限」=自定义态 accent 描边+accent-strong 文字）；下拉展开帧七档逐字（自动/低/中/高/超高/极限/工作流），「自动」档菜单行显示「默认：中」（:124 逐字）、「工作流」带 Beta chip（fail 语义族）、foot 两行逐字（下一条消息起生效 / 上回合实际生效：极限） | 模型 pill 右侧（现状第 4 项） |
| 4 | **TurnTimer** | `TurnTimer.vue`（运行态:57-67；完成态:68-75；样式:80-198）+ ChatPage.vue:603（浮岛第一行） | 运行中：呼吸点（8px accent + ping 扩散动画）+「正在回复」+ tabular 计时「12.4s」（formatDurationMs 口径）+ 阶段徽章 pill「工具执行中」（info 点脉冲；四阶段文案逐字）；完成态：静态绿点 +「本次回复」+「2.4s」（success 色）+「· 结束于 14:32:07」（formatEndedAt 同日 HH:mm:ss 口径）；整行 header 带底部细分隔线 | 卡片第一行（附件行/textarea 之上） |
| 5 | **中断钮** | `SessionToolbar.vue:309-327`（仅 sending 显示；danger 实底= `color-mix(danger 80%, #000)`；进度填充白色 30%；holding 光环 danger 35%） | danger 实底 pill「■ 中断」+ holding 45% 进度填充示意 + holding 光环；仅出现在运行态帧（图⑨） | 运行态帧中位于 spacer 右侧组、发送钮左侧（现状 ctl--right 推至最右的语义在 V1 圆形发送钮布局下的对应位） |

### 位次决策与申报

- **位次改为现状 DOM 序 1:1**：v1 首版按 GOAL 规格把「+ 附件」放工具栏首位；返图要求上下文环按现状位次「最左第一项」画入、其余控件「以现状 DOM 为准」——v2 工具栏整体改为现状 DOM 序：上下文环 → 工作空间 → 模型 → 思考强度 → 权限 → + 附件 →（运行态：中断钮）→ 右端圆形发送钮。「+ 附件」随现状移至权限右侧，已在文件头注与各图注留痕。
- **ctx 按钮圆角申报**：现状 `.ctx__btn` 为 radius-md 方形钮；为保持变体一 pill 化视觉语言，容器升级为 radius-pill（stadium 形），环体 svg（viewBox/半径/描边/dasharray/rotate）1:1 未动。
- **中断钮混黑申报**：现状混黑基准 `#000000`（SessionToolbar.vue:421 color-mix 第二色）非 variables.css token，镜像为 `--abort-mix-black`（镜像块内注释标现状真源行号），避免组件 CSS 出现裸 hex；进度填充的白 30% 用 `var(--color-on-accent)`（语义等价，token 纯净）。
- **镜像块新增 token**：`--color-fail` `--color-fail-strong`（Beta chip 用）、`--color-info` `--color-info-strong`（工具执行中阶段点用）、`--abort-mix-black`（中断钮混黑，现状源申报）——均带真源注释。
- **运行态列全 disabled**：现状 sending 时 ContextButton/各 pill/添加文件均收 `:disabled="sending"`、textarea 收 `chatInputDisabled`、发送钮 disabled——图⑨ 按此画全，补 `.ctl:disabled`/`.plus-btn:disabled` 样式对齐现状 `.ctl__btn:disabled`。
- **TurnTimer 无 lastMeta 时不渲染**：图②（激活态）不画 TurnTimer 行，图注注明现状 v-if/v-else-if 逻辑；图①/图⑪（窄窗）画完成态行。
- **九条硬约束复核**：补入后重跑 grep 自查（见 p7a-impl-report.md 返图 v2 小节）——testid 齐备、四档/七档文案逐字、无 worktree/分支/麦克风、hex 仅在 ：root 镜像块，全部通过，无回退。

