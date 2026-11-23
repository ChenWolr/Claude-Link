<script setup lang="ts">
// TranslateButton —— 翻译入口 pill 钮（P5 渲染层三挂载点复用；2026-11-19 UI 五点批次）。
// 形态基准 = prototypes/translate-ui-variant-3-immersive.html .tr-entry :216-226（1:1）：
// --radius-pill、「译」图标 + 文案、min-height/min-width 28px（≥28px 命中）、padding 3px 10px、
// 0.75rem/600；默认 panel-soft 底 + --color-border 描边 + muted 字。
// 四态：idle「翻译」（hover accent-strong 字 + accent 40% 描边 + accent 10% 底）；translating
// 「翻译中… N%」+ refresh 图标 0.9s 旋转（reduced-motion 停转）、cursor: default；
// error「重试」danger 字 + danger 45% 描边 + danger 8% 底、失败原因进 title；done 回落 idle 视觉。
// 点击语义由父级按状态路由（idle→start / translating→stop / done→toggleShowing / error→retry）——
// 本组件只 emit click，不做任何路由判断。
import { computed } from 'vue';

const props = defineProps<{
  state: 'idle' | 'translating' | 'done' | 'error';
  /** 翻译进度百分比（translating 态文案「翻译中… N%」；缺省 0）。 */
  progress?: number;
  /** 失败原因（error 态进 title，用户 hover 可见）。 */
  errorText?: string;
}>();

defineEmits<{ click: [] }>();

const progressPct = computed(() => {
  const p = props.progress;
  return typeof p === 'number' && Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : 0;
});
const label = computed(() => {
  if (props.state === 'translating') return `翻译中… ${progressPct.value}%`;
  if (props.state === 'error') return '重试';
  return '翻译';
});
const titleText = computed(() => {
  if (props.state === 'error' && props.errorText) return props.errorText;
  if (props.state === 'idle' || props.state === 'done') return '翻译这条回复';
  return undefined;
});
</script>

<template>
  <button
    type="button"
    class="tr-entry"
    :class="{
      'tr-entry--loading': state === 'translating',
      'tr-entry--error': state === 'error',
    }"
    :title="titleText"
    :aria-live="state === 'error' ? 'assertive' : 'polite'"
    @click="$emit('click')"
  >
    <svg v-if="state === 'translating'" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
    <svg v-else viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5h7M7.5 3v2c0 4-2.5 7-5.5 8" />
      <path d="M6 10c1.5 2.5 3.5 4.5 6 5.5" />
      <path d="m12 21 4-9 4 9M13.5 17.5h5" />
    </svg>
    <span>{{ label }}</span>
  </button>
</template>

<style scoped>
/* 原型 .tr-entry :216-226 逐项对齐（token 同名直用）。 */
.tr-entry {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  min-width: 28px;
  padding: 3px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
  font-size: 0.75rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition:
    color var(--duration-fast, 120ms) var(--ease-out, ease-out),
    border-color var(--duration-fast, 120ms) var(--ease-out, ease-out),
    background var(--duration-fast, 120ms) var(--ease-out, ease-out);
}

.tr-entry svg {
  width: 13px;
  height: 13px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.tr-entry:hover {
  color: var(--color-accent-strong);
  border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-border));
  background: color-mix(in srgb, var(--color-accent) 10%, var(--color-panel-soft));
}

/* 翻译中：进行态视觉（cursor: default——重复点击语义由父级按状态路由，本钮不再给「可点」暗示）。 */
.tr-entry--loading {
  color: var(--color-accent-strong);
  border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-panel-soft));
  cursor: default;
}

.tr-entry--loading svg {
  animation: tr-entry-spin 0.9s linear infinite;
}

@keyframes tr-entry-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 失败：danger 字 + danger 45% 描边 + danger 8% 底（原型 .tr-entry--error 同配方）。 */
.tr-entry--error {
  color: var(--color-danger);
  border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
  background: color-mix(in srgb, var(--color-danger) 8%, transparent);
}

.tr-entry:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .tr-entry--loading svg {
    animation: none;
  }
}
</style>
