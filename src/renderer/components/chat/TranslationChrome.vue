<script setup lang="ts">
// TranslationChrome —— 变体三 chrome 行内联件（角色行/思考头部/stream chrome 行复用）。
// 基准 = prototypes/translate-ui-variant-3-immersive.html（1:1）：徽标 .tr-tag :181-191 +
// ghost pill .swap-pill :192-199。
// 徽标：translating=「翻译中 N%」+ 6px pulse 圆点、accent 14% 底 + accent-strong 字、
// aria-live polite；done=「已翻译」、success 12% 底 + success 字；error=danger 字「翻译失败」
//（错误详情由视口错误横条承担，徽标只给终态信号）。stopped 态由父级 v-if 排除（回落原文，
// chrome 不残留）。
// ghost pill：margin-left auto、min-height 26px、透明底 + --color-border 描边 + muted 字；
// hover accent-strong 字 + accent 40% 描边 + accent 8% 底；文案随视图态「查看原文/返回译文」、
// aria-pressed；emit swap——父级调 toggleShowing（纯视图切换，绝不 STOP）。
import { computed } from 'vue';
import type { TranslationStatus } from '../../../shared/translation-core';

const props = defineProps<{
  status: TranslationStatus;
  /** 翻译进度百分比（translating 徽标文案；缺省 0）。 */
  progress?: number;
  /** 当前是否显示译文（沉浸替换视图态）：true→pill「查看原文」；false→pill「返回译文」。 */
  showingTranslation: boolean;
}>();

defineEmits<{ swap: [] }>();

const progressPct = computed(() => {
  const p = props.progress;
  return typeof p === 'number' && Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : 0;
});
</script>

<template>
  <!-- display:contents：徽标与 pill 直接参与父级 flex 行（role-row/headrow/chrome 行）布局，
       swap-pill 的 margin-left:auto 才能把自身推到行右端（原型 :161 role-row + :193 同构）。 -->
  <span class="tr-chrome">
    <span v-if="status === 'translating'" class="tr-tag tr-tag--live" aria-live="polite">
      <i aria-hidden="true"></i>
      <span>翻译中 {{ progressPct }}%</span>
    </span>
    <span v-else-if="status === 'done'" class="tr-tag tr-tag--done">已翻译</span>
    <span v-else-if="status === 'error'" class="tr-tag tr-tag--error">翻译失败</span>
    <button type="button" class="swap-pill" :aria-pressed="!showingTranslation" @click="$emit('swap')">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M17 3h4v4M21 3l-7 7" />
        <path d="M7 21H3v-4M3 21l7-7" />
      </svg>
      <span>{{ showingTranslation ? '查看原文' : '返回译文' }}</span>
    </button>
  </span>
</template>

<style scoped>
.tr-chrome {
  display: contents;
}

/* 原型 .tr-tag :181-191。 */
.tr-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.tr-tag--live {
  background: color-mix(in srgb, var(--color-accent) 14%, transparent);
  color: var(--color-accent-strong);
}

.tr-tag--live i {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--color-accent);
  animation: tr-tag-pulse 1.2s ease-in-out infinite;
}

@keyframes tr-tag-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

.tr-tag--done {
  background: color-mix(in srgb, var(--color-success) 12%, transparent);
  color: var(--color-success-strong);
}

.tr-tag--error {
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  color: var(--color-danger);
}

/* 原型 .swap-pill :192-199。 */
.swap-pill {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 26px;
  padding: 2px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--color-text-muted);
  font-size: 0.6875rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition:
    color var(--duration-fast, 120ms) var(--ease-out, ease-out),
    border-color var(--duration-fast, 120ms) var(--ease-out, ease-out),
    background var(--duration-fast, 120ms) var(--ease-out, ease-out);
}

.swap-pill:hover {
  color: var(--color-accent-strong);
  border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-border));
  background: color-mix(in srgb, var(--color-accent) 8%, transparent);
}

.swap-pill svg {
  width: 12px;
  height: 12px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.swap-pill:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .tr-tag--live i {
    animation: none;
  }
}
</style>
