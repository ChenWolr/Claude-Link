<script setup lang="ts">
import { computed, ref } from 'vue';
import type { RenderableMessage } from '../../../shared/types/export-image';
import { renderMarkdown } from '../../utils/markdown';
import { enrichMarkdown as vEnrich } from '../../directives/enrich-markdown';
import { formatDurationMs } from '../../../shared/format-duration';
import MessageAttachments from './MessageAttachments.vue';

const props = defineProps<{ message: RenderableMessage; exportMode?: boolean }>();

// 导出模式用 export profile：Mermaid 渲染、代码换行、图片 eager、无灯箱按钮化。
const renderedContent = computed(() => renderMarkdown(props.message.content, props.exportMode ? 'export' : 'rich'));
const hasContent = computed(() => props.message.content.trim().length > 0);
const attachments = computed(() => props.message.attachments ?? []);

// 本次回复耗时文案（结束后气泡脚注）；与运行中 TurnTimer 共用 formatDurationMs 保持口径一致。
const durationText = computed(() =>
  props.message.durationMs != null ? formatDurationMs(props.message.durationMs) : '',
);

// 复制反馈：点击后「已复制」保持 1.2s 再复位（与 InteractionPreview 一致）。
// 复制内容 = 正文 + 附件文件名列表；不含绝对路径/Base64/附件 ID。
const copied = ref(false);
async function copyMessage(): Promise<void> {
  const text = props.message.content;
  const names = attachments.value.map((a) => a.filename);
  const parts: string[] = [];
  if (text.trim()) parts.push(text);
  if (names.length > 0) parts.push(`[附件] ${names.join('、')}`);
  const out = parts.join('\n');
  if (!out.trim()) return;
  await navigator.clipboard?.writeText(out);
  copied.value = true;
  window.setTimeout(() => {
    copied.value = false;
  }, 1200);
}
</script>

<template>
  <div :class="['bubble', `bubble--${message.role}`, { 'bubble--error': message.isError === true }]">
    <div v-if="message.role !== 'system'" class="bubble__role">{{ message.role === 'user' ? '你' : 'Claude' }}</div>
    <div v-if="hasContent" class="bubble__content markdown-body" v-html="renderedContent" v-enrich />
    <MessageAttachments v-if="attachments.length" :attachments="attachments" :export-mode="exportMode" />
    <div v-if="message.costUsd != null || message.durationMs" class="bubble__meta">
      <svg v-if="durationText" class="bubble__meta-clock" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3.5 2" />
      </svg>
      <span v-if="durationText" class="bubble__meta-duration">{{ durationText }}</span>
      <span v-if="message.costUsd != null" class="bubble__meta-cost">{{ durationText ? ' · ' : '' }}${{ message.costUsd.toFixed(4) }}</span>
    </div>
    <!-- 仅 user / assistant 消息提供复制按钮；tool / system 不需要。
         流式布局放在内容正下方独立一行，避免与正文重叠。 -->
    <button
      v-if="!exportMode && (message.role === 'user' || message.role === 'assistant')"
      type="button"
      class="bubble__copy"
      :title="copied ? '已复制' : '复制消息'"
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
</template>

<style scoped>
.bubble {
  max-width: 75%;
  padding: 12px 16px;
  border-radius: var(--radius-md);
}

/* 用户气泡：accent 染色卡片——淡彩底 + 右侧 3px accent 色条 + accent 派生描边。
   color-mix 跟随主题变量，9 套主题自动适配；不再写死 accent 实心填充，避免饱和
   纯色块在暖纸/草香等柔和主题上突兀廉价。右色条镜像助手气泡左色条，共享卡片语言。 */
.bubble--user {
  align-self: flex-end;
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
  align-self: flex-start;
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

.bubble__role {
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  margin-bottom: 6px;
  opacity: 0.7;
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

.bubble__content :deep(pre) {
  margin: 0;
}

/* 回复脚注（耗时 + 费用）：紧贴内容下方，细分隔线不打断正文流；
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

.bubble__meta-cost {
  opacity: 0.8;
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
