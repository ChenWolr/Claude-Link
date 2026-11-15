<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { RenderableMessage } from '../../../shared/types/export-image';
import { renderMarkdown } from '../../utils/markdown';
import { copyTextToClipboard } from '../../utils/clipboard';
import { useFilePreview } from '../../composables/useFilePreview';
import { enrichMarkdown as vEnrich } from '../../directives/enrich-markdown';
import { formatDurationMs, formatEndedAt, formatEndedAtMinute, formatSentAt } from '../../../shared/format-duration';
import { isReasoningReplayApiError } from '../../../shared/upstream-errors';
import MessageAttachments from './MessageAttachments.vue';

const props = defineProps<{ message: RenderableMessage; exportMode?: boolean; interrupted?: boolean }>();

// 导出模式用 export profile：Mermaid 渲染、代码换行、图片 eager、无灯箱按钮化。
// 第五轮方案替换（2026-09-27）：user 气泡不再走 markdown 渲染——CommonMark 把 ≥2 连续空行
// 折叠成一个段距、用户消息中的 markdown 语法（粗体/行内 code/围栏/图片）被渲染成样式，均与
// 输入字面不符。user 气泡纯文本回显见模板分支（插值 + white-space: pre-wrap）。
const renderedContent = computed(() => renderMarkdown(props.message.content, props.exportMode ? 'export' : 'rich'));
const hasContent = computed(() => props.message.content.trim().length > 0);
const attachments = computed(() => props.message.attachments ?? []);

// reasoning_replay（DeepSeek thinking 回传 400）错误气泡：附行动建议。
// 结构化标记优先（落库路径打标）；老消息无标记时用共享谓词兜底，兼容历史数据。
const reasoningReplayAdviceVisible = computed(() => {
  if (props.message.role !== 'assistant' || props.message.isError !== true) return false;
  return props.message.apiErrorKind === 'reasoning_replay' || isReasoningReplayApiError(props.message.content);
});

// 本次回复耗时文案（结束后气泡脚注）；与运行中 TurnTimer 共用 formatDurationMs 保持口径一致。
const durationText = computed(() =>
  props.message.durationMs != null ? formatDurationMs(props.message.durationMs) : '',
);

// B3：回合结束时刻（ended_at 持久化）文案；与 TurnTimer 完成态同口径（zh-CN 24 小时制）。
// 老消息/中断回合无记录时不显示（诚实不造数）。
const endedAtText = computed(() => formatEndedAt(props.message.endedAt));

// C6：中断回合脚注。分钟级结束时刻（正常回合保持 formatEndedAt 的 HH:mm:ss 口径，
// 其签名被 tdd-user-message-time-verify S2 钉死勿动——分钟级走新单源 formatEndedAtMinute）。
// isError 气泡不叠中断脚注（发送失败红条路径不与此混淆——规范 C6 边界）。
const interruptedVisible = computed(() =>
  props.interrupted === true && props.message.role === 'assistant' && props.message.isError !== true,
);
const endedAtMinuteText = computed(() =>
  interruptedVisible.value ? formatEndedAtMinute(props.message.endedAt) : '',
);

// S3：用户消息发送时刻（created_at，DB 带 Z UTC / 内存乐观毫秒级 ISO）文案——UI13-P5 起渲染于
// 气泡正下方 caption 行「你 · 发送于 {HH:mm}」（原气泡内「发送于」脚注已移除）。
// 仅 user 气泡显示；缺失/非法返回空串不渲染（诚实不造数，与 endedAt 同原则）。
const sentAtText = computed(() =>
  props.message.role === 'user' ? formatSentAt(props.message.createdAt) : '',
);

// p3/W2：markdown 正文文件链接点击委托（事件冒泡到内容容器，.md-file-link 由 markdown.ts
// link_open 规则产出、data-clip-path 携带解析后的绝对路径）。非文件链接不拦截，外链照旧。
function onContentClick(e: MouseEvent): void {
  const el = (e.target as HTMLElement | null)?.closest?.('.md-file-link') as HTMLElement | null;
  if (!el) return;
  const p = el.getAttribute('data-clip-path');
  if (p) useFilePreview().open(p);
}

// 复制反馈：点击后「已复制」保持 1.2s 再复位（与 InteractionPreview 一致）。
// 复制内容 = 正文 + 附件文件名列表；不含绝对路径/Base64/附件 ID。
const copied = ref(false);
// hb12-CHR-04：复制失败态（复用 copied 的限时反馈机制）。
const copyFailed = ref(false);
// UI13-P11（条目 9）：复制反馈 1.2s 计时器句柄组件级收敛——重复点击先清旧 timer（反馈窗口
// 不叠加），卸载清除（长会话滚动中气泡销毁后 timer 不再触达 reactive 状态）。
let copyFeedbackTimer: number | null = null;
function scheduleCopyFeedbackReset(reset: () => void): void {
  if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
  copyFeedbackTimer = window.setTimeout(() => {
    copyFeedbackTimer = null;
    reset();
  }, 1200);
}
onBeforeUnmount(() => {
  if (copyFeedbackTimer) {
    clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = null;
  }
});
async function copyMessage(): Promise<void> {
  const text = props.message.content;
  const names = attachments.value.map((a) => a.filename);
  const parts: string[] = [];
  if (text.trim()) parts.push(text);
  if (names.length > 0) parts.push(`[附件] ${names.join('、')}`);
  const out = parts.join('\n');
  if (!out.trim()) return;
  // hb12-CHR-04：复制失败置错误态，不再静默。（SA-2：改走 copyTextToClipboard 统一回退——
  // 网页端非安全上下文 clipboard 为 undefined 时降级 execCommand，仍失败返回 false 进此分支，
  // 不再是 ?. 链静默无操作。）
  const ok = await copyTextToClipboard(out);
  if (!ok) {
    copyFailed.value = true;
    scheduleCopyFeedbackReset(() => {
      copyFailed.value = false;
    });
    return;
  }
  copied.value = true;
  scheduleCopyFeedbackReset(() => {
    copied.value = false;
  });
}
</script>

<template>
  <!-- UI13-P5：根元素包一层 bubble-wrap wrapper（单根保 attrs 透传——MessageList 的 msg-transition
       class 走 fallthrough，多根 fragment 会静默丢类）。对齐方向自 .bubble--* 迁移到 wrap：
       wrap 承接原 align-self，气泡与下方元信息行（caption）经 align-items 同侧对齐。 -->
  <div :class="['bubble-wrap', `bubble-wrap--${message.role}`]"
       :data-testid="message.role === 'user' ? 'user-bubble-wrap' : undefined">
    <div :class="['bubble', `bubble--${message.role}`, { 'bubble--error': message.isError === true }]">
      <!-- UI13-P5：user 的「你」角色头移除（元信息并入气泡下方 caption 行）；system 本无角色头，
           assistant/tool 的「Claude」头保留（渲染逐字节不变）。v-if 排除 user 后 role 类型收窄，
           原 `role === 'user' ? '你' : 'Claude'` 三元成不可达死代码且 vue-tsc 报 TS2367，
           故直书 Claude 字面。 -->
      <div v-if="message.role !== 'system' && message.role !== 'user'" class="bubble__role">
        <span>Claude</span>
      </div>
      <!-- user 气泡纯文本逐字回显（第五轮方案，2026-09-27）：插值自动 HTML 转义防 XSS，
           white-space: pre-wrap 按原文显示——气泡显示文本 === 实际发送文本 === 落库文本。
           不挂 v-enrich（mermaid/灯箱增强仅适用 markdown HTML）、不挂 markdown-body
           （纯文本无子元素，其语义失效）。 -->
      <div v-if="hasContent && message.role === 'user'" class="bubble__content">{{ message.content }}</div>
      <!-- assistant/系统/工具仍走 markdown 渲染（v-html + 灯箱/mermaid 增强），行为零变化。 -->
      <div v-else-if="hasContent" class="bubble__content markdown-body" v-html="renderedContent" v-enrich @click="onContentClick" />
      <!-- S3→UI13-P5：user「发送于」时刻不再渲染为气泡内 .bubble__meta 脚注（原块已删除），
           改为气泡正下方 caption 行「你 · 发送于 {HH:mm}」（见 wrapper 尾部）；caption 门控
           同口径（缺失/非法 sentAtText 空串整行不渲染、无空行残留）。 -->
      <div v-if="reasoningReplayAdviceVisible" class="bubble__advice" data-testid="reasoning-replay-advice">
        <div class="bubble__advice-title">已自动重试一次；若仍失败，可：</div>
        <ul class="bubble__advice-list">
          <li>手动重试（重新发送上一条消息）</li>
          <li>压缩会话后重试（/compact，缩短需回传的思考历史）</li>
          <li>更换供应商：Anthropic 直连或 GLM Anthropic 端点（不经 OpenAI 转换桥）</li>
        </ul>
      </div>
      <MessageAttachments v-if="attachments.length" :attachments="attachments" :export-mode="exportMode" />
      <!-- C6：中断回合脚注——「已中断 · 结束于 {HH:MM}」；endedAt 缺失（老数据）只显「已中断」
           （无数据不造数）。中断回合 durationMs/endedAt 虽照常落库，此处不再显示正常耗时。
           B3：正常块只展示 耗时 + 结束时间（费用不再展示）；门控 durationMs || endedAt（hb13-v 批C
           注释纠偏：原「门控仅 durationMs」漏 B3 扩的 endedAt 半边），老消息无结束时刻只显示耗时。 -->
      <div v-if="interruptedVisible" class="bubble__meta" data-testid="bubble-meta-interrupted">
        <span class="bubble__meta-interrupted">已中断</span>
        <span v-if="endedAtMinuteText" class="bubble__meta-end">· 结束于 {{ endedAtMinuteText }}</span>
      </div>
      <div v-else-if="message.durationMs || message.endedAt" class="bubble__meta">
        <svg v-if="durationText" class="bubble__meta-clock" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3.5 2" />
        </svg>
        <span v-if="durationText" class="bubble__meta-duration">{{ durationText }}</span>
        <span v-if="endedAtText" class="bubble__meta-end">· 结束于 {{ endedAtText }}</span>
      </div>
      <!-- 仅 user / assistant 消息提供复制按钮；tool / system 不需要。
           流式布局放在内容正下方独立一行，避免与正文重叠。 -->
      <button
        v-if="!exportMode && (message.role === 'user' || message.role === 'assistant')"
        type="button"
        class="bubble__copy"
        :title="copyFailed ? '复制失败' : copied ? '已复制' : '复制消息'"
        @click="copyMessage"
      >
        <svg v-if="!copied" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z" />
        </svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
        </svg>
      </button>
    </div>
    <!-- UI13-P5：user 消息元信息行（气泡正下方、随气泡右对齐）——「你 · 发送于 {HH:mm}」
         （formatSentAt 单源：当天 HH:mm、跨天 M/d HH:mm；缺失/非法为空串整行不渲染，诚实不造数）
         +「来自队列」标签（自原角色头迁入，导出快照不含运行态标签）。 -->
    <div v-if="message.role === 'user' && sentAtText" class="bubble-caption">
      你 · 发送于 {{ sentAtText }}
      <!-- 队列任务到点/立即执行发出的消息标（导出快照不含运行态标签） -->
      <span
        v-if="!exportMode && message.parentTaskId"
        class="bubble__queue-tag"
        title="此消息由队列任务到点/立即执行时发送"
      >来自队列</span>
    </div>
  </div>
</template>

<style scoped>
/* UI13-P5：消息根 wrapper（气泡 + 气泡下方元信息行）。原 .bubble--* 的对齐方向迁移至此——
   MessageList 列布局（.message-list__inner flex column）下 wrap 成为直接子项：wrap 承接
   原 align-self，内部气泡与 caption 经 align-items 同侧对齐；TaskQueuePanel 子 agent 域有
   :deep(.bubble-wrap){width:100%;align-self:stretch} 覆盖（wrap 先撑满、气泡 100% 仍成立）。 */
.bubble-wrap {
  display: flex;
  flex-direction: column;
}

.bubble-wrap--user {
  align-self: flex-end;
  align-items: flex-end;
}

.bubble-wrap--assistant,
.bubble-wrap--tool {
  align-self: flex-start;
  align-items: flex-start;
}

/* UI13 评审 r1 P3-2：system 气泡恢复批次前水平居中——原 .bubble--system{align-self:center}
   在收缩 wrap 内成 no-op，居中须由 wrap 承接（align-self: center 使 wrap 在列内水平居中，
   align-items: center 使内部气泡与 caption 行随之居中）。 */
.bubble-wrap--system {
  align-self: center;
  align-items: center;
}

.bubble {
  max-width: 75%;
  padding: 12px 16px;
  border-radius: var(--radius-md);
}

/* 用户气泡：accent 染色卡片——淡彩底 + 右侧 3px accent 色条 + accent 派生描边。
   color-mix 跟随主题变量，9 套主题自动适配；不再写死 accent 实心填充，避免饱和
   纯色块在暖纸/草香等柔和主题上突兀廉价。右色条镜像助手气泡左色条，共享卡片语言。 */
.bubble--user {
  /* UI13-P5：align-self: flex-end 迁移至 .bubble-wrap--user（wrap 承接，气泡经 align-items 同侧） */
  max-width: 80%;
  background: color-mix(in srgb, var(--color-accent) 12%, var(--color-panel-soft));
  color: var(--color-text);
  border: 1px solid color-mix(in srgb, var(--color-accent) 30%, transparent);
  border-right: 3px solid var(--color-accent);
  box-shadow: var(--ring-light), var(--elevation-1);
}

/* 助手消息：左对齐气泡（微信式分层）。panel-soft 底 + 边框与 bg 拉开层次；
   左侧 accent 色条作为「Claude 回复」强标识，让每条回复边界一眼可辨（claude-link
   无头像行，需靠色条+容器替代 openhanako 的头像锚点）。 */
.bubble--assistant {
  /* UI13-P5：align-self: flex-start 迁移至 .bubble-wrap--assistant（wrap 承接，气泡经 align-items 同侧） */
  max-width: 85%;
  padding: 12px 16px;
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-accent);
  border-radius: var(--radius-md);
  box-shadow: var(--ring-light), var(--elevation-1);
}

.bubble--system {
  align-self: center;
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  max-width: 90%;
  font-size: 0.8125rem;
}

.bubble--tool {
  align-self: flex-start;
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  max-width: 90%;
  box-shadow: var(--ring-light), var(--elevation-1);
}

/* 错误消息（isError 标记：API Error 文案 / system:interaction_cancelled 等）：fail 色
   红边红字，与 ChatPage .chat-error 同款 color-mix 配方。置于角色气泡规则之后，
   border-color 覆盖 user/assistant 的 accent 色条，整圈描边归一为红色系。 */
.bubble--error {
  border-color: color-mix(in srgb, var(--color-fail) 50%, transparent);
  background: color-mix(in srgb, var(--color-fail) 12%, transparent);
  color: var(--color-fail-strong);
}

/* reasoning_replay 行动建议：红气泡内的次级列表，边界线分隔正文与建议。 */
.bubble__advice {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--color-fail) 30%, transparent);
  font-size: 0.8125rem;
  line-height: 1.6;
}

.bubble__advice-title {
  font-weight: 600;
}

.bubble__advice-list {
  margin: 4px 0 0;
  padding-left: 1.1em;
  list-style: disc;
}

.bubble__role {
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  margin-bottom: 6px;
  opacity: 0.7;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 队列任务消息标：accent 14% 底、accent-strong 字、pill */
.bubble__queue-tag {
  flex-shrink: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-accent) 14%, transparent);
  color: var(--color-accent-strong);
  padding: 1px 7px;
  font-size: 0.625rem;
  text-transform: none;
  letter-spacing: 0;
}

.bubble--user .bubble__role,
.bubble--assistant .bubble__role,
.bubble--tool .bubble__role {
  color: var(--color-accent-strong);
}

.bubble__content {
  word-break: break-word;
  line-height: 1.5;
}

/* 助手正文行高加大到 1.75，长回复阅读更舒展（对齐 openhanako）。 */
.bubble--assistant .bubble__content {
  line-height: 1.75;
}

.bubble__content :deep(p) {
  margin: 0 0 0.25rem;
}

.bubble__content :deep(p:last-child) {
  margin-bottom: 0;
}

/* user 气泡纯文本逐字回显（第五轮方案）：white-space: pre-wrap 保留原文换行与连续空行，
   长行折行仍靠 .bubble__content 基础规则继承的 word-break: break-word。 */
.bubble--user .bubble__content {
  white-space: pre-wrap;
}

.bubble__content :deep(pre) {
  margin: 0;
}

/* 文件链接（p3/W2）：markdown 正文中的文件链接按钮化样式（对齐效果图 .file-link）——
   accent 色 + 点状下划线标示「可点开预览」，与普通网页外链区分；v-html 内容须 :deep
   穿透。hover 切实线下划线给明确可点反馈。 */
.bubble__content :deep(.md-file-link) {
  color: var(--color-accent-strong);
  font-weight: 500;
  cursor: pointer;
  text-decoration: underline dotted;
  text-decoration-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
  text-underline-offset: 4px;
}

.bubble__content :deep(.md-file-link:hover) {
  text-decoration-style: solid;
  color: var(--color-accent);
}

/* 回复脚注（耗时 + 结束时间，B3 起不再展示费用）：紧贴内容下方，细分隔线不打断正文流；
   muted 色 + 时钟图标，耗时数字 tabular-nums 固定宽度不抖动。 */
.bubble__meta {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--color-border);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

/* C6：中断回合脚注「已中断」字样（fail 语义色 + 加粗，与 ToolCallBlock ✗ 已中断同族）。 */
.bubble__meta-interrupted {
  color: var(--color-fail-strong);
  font-weight: 600;
}

.bubble__meta-clock {
  width: 0.75rem;
  height: 0.75rem;
  fill: none;
  stroke: var(--color-accent-strong);
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.85;
}

.bubble__meta-duration {
  color: var(--color-text);
  font-weight: 600;
}

.bubble__meta-end {
  opacity: 0.8;
}

/* UI13-P5：user 气泡下方元信息行（「你 · 发送于」+「来自队列」标）。muted 色 + tabular-nums
   与 .bubble__meta 同口径；padding-right 让出气泡右下角外侧的复制按钮宽度（按钮 bottom:-26px
   与本行同区域、hover 才现，让位避免视觉重叠）。caption 在文档流占位，不参与 .bubble:hover
   命中区（hover 桥 ::after 在其下层，复制钮 z-index:1 在其上，按钮可达性不受影响）。 */
.bubble-caption {
  margin-top: 4px;
  padding-right: 44px;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

/* 复制按钮：定位到气泡右下角外侧（贴近消息但浮在背景区上）。
   纯图标小尺寸，默认隐藏，hover 气泡才浮现。
   配色全部走主题 token（--color-accent / --color-text-muted / --color-border），
   9 套主题切换时由 App.vue 重写根 CSS 变量，按钮自动跟随，无需逐主题适配。 */
.bubble {
  position: relative;
}

/* hover 命中桥（不可删——删了复制按钮会重新闪退）：
   复制按钮定位在气泡外部（bottom:-26px），与气泡本体之间留有 ~3px 死区；而按钮只在
   .bubble:hover 时才拿到 pointer-events:auto。鼠标从正文移向按钮、越过死区的瞬间
   .bubble:hover 失效 → 按钮在命中前就回退到 opacity:0 / pointer-events:none 而消失（旧 bug）。
   这条全透明 ::after 把命中区从气泡底边连续延伸到按钮下方，鼠标全程都在 .bubble 命中区内，
   按钮稳定可达。无任何视觉影响（全透明、脱离文档流不占布局）。按钮靠 z-index:1 压在桥之上
   保持可点。若改动按钮位置/尺寸，须同步调整此处覆盖范围。 */
.bubble::after {
  content: '';
  position: absolute;
  right: 0;
  bottom: -30px;
  width: 40px;
  height: 30px;
  z-index: 0;
}

.bubble__copy {
  position: absolute;
  right: 0;
  bottom: -26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  z-index: 1;
  transition: opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.bubble__copy svg {
  width: 13px;
  height: 13px;
  fill: currentColor;
  display: block;
}

/* hover 气泡时按钮显现：用主题 panel-soft 做底 + border 做边框，
   保证在 9 套主题的 bg 上都有清晰边界（暖纸/草香/珊瑚等都不会糊在一起）。 */
.bubble:hover .bubble__copy,
.bubble__copy:focus-visible {
  opacity: 0.9;
  pointer-events: auto;
  background: var(--color-panel-soft);
  border-color: var(--color-border);
}

/* hover 按钮自身：切到主题 accent 色，给明确「可点」反馈 */
.bubble__copy:hover {
  opacity: 1;
  color: var(--color-accent-strong);
  background: color-mix(in srgb, var(--color-accent) 12%, var(--color-panel-soft));
  border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-border));
}

/* 复制成功瞬间：accent 强色 + 拉满不透明度，给明确反馈 */
.bubble__copy[title='已复制'] {
  opacity: 1;
  color: var(--color-accent-strong);
  background: color-mix(in srgb, var(--color-accent) 18%, var(--color-panel-soft));
  border-color: color-mix(in srgb, var(--color-accent) 50%, var(--color-border));
}
</style>
