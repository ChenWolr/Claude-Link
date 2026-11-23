<script setup lang="ts">
// TranslationViewport —— 变体三「沉浸替换式」译文视口（P5 渲染层，2026-11-19 UI 五点批次）。
// 挂载点 A（MessageBubble assistant 正文位）/ B（MessageList stream-group 正文位）复用；
// 挂载点 C（ThinkingBlock）不使用本组件——思考块沿用自身滚动窗（01 §5.4-C）。
//
// 结构（01 §5.4⑤ + prototypes/translate-ui-variant-3-immersive.html 呈现语言 1:1）：
//  - 译文区：段级渲染 renderMarkdown + v-enrich（照 StreamRenderer.vue:9/26 形态）；已译段
//    fadeIn 渐显（.fade-seg 260ms ease-out both，原型 :207-208——以「本次新增的已译段」为渐显
//    单位：段按 index 独立成块，新块挂载即动画，已译段就地更新文本不重放）；未译余量 shimmer
//    占位（.tr-shimmer 0.875rem 高圆角条 + 240% 渐变 1.3s 流动，宽度按剩余段数 86%/52%，
//    原型 :210-211；reduced-motion 停止动画只留静态浅条）。
//  - 视口约束（契约 P5.5）：max-height 240px（指令收口值；原型 280px，差异已在 01 修订记录
//    留痕）+ overflow-y auto + 内部滚动 nearBottom<80px 钉底（镜像 MessageList OPT-6）；
//    挂载即 rAF 钉到最新进度（swap pill 切回译文重挂载场景，原型 :569 同款）；min-height
//    120px 防原文/译文二选一切换塌陷。
//  - 进度指示：视口顶部 2px 细进度线（translatedSegments/totalSegments 百分比宽）。
//  - error 态（契约 P5.6）：视口内 danger 横条 + 错误文案 + 「重试」钮（emit 给父级调
//    translationStore.retry）；不整块消失（用户须看见失败原因）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { renderMarkdown } from '../../utils/markdown';
// P6-B（2026-11-21）：译文视口文件链接右键委托（左键零动作，右键菜单为唯一交互入口）。
import { useFileLinkMenuStore } from '../../stores/file-link-menu-store';
import { enrichMarkdown as vEnrich } from '../../directives/enrich-markdown';
import { useTranslationStore } from '../../stores/translation-store';
import { useTranslationDisplay } from '../../composables/use-translation-display';

const props = defineProps<{ translationId: string }>();

defineEmits<{ retry: [] }>();

const translationStore = useTranslationStore();
const entry = computed(() => translationStore.byId[props.translationId]);

// 50ms 独立节流文本/段快照（工厂 = use-stream makeThrottle；正文与思考各自实例化互不串流）。
const { blocks } = useTranslationDisplay(computed(() => props.translationId));

const status = computed(() => entry.value?.status ?? 'translating');
const errorText = computed(() => entry.value?.error ?? '翻译失败');

// 进度：已译段数 / 总段数（segments 仅含已译段——未译段缺席，见 translation-core TranslationStateView）。
const translatedCount = computed(() => entry.value?.segments.length ?? 0);
const totalSegments = computed(() => entry.value?.totalSegments ?? 0);
const progressPct = computed(() =>
  totalSegments.value > 0 ? Math.round((translatedCount.value / totalSegments.value) * 100) : 0,
);

// shimmer 占位：仅 translating 且确有未译余量；宽度按剩余段数（原型 :707 同款 86%/52%）。
const remaining = computed(() => Math.max(0, totalSegments.value - translatedCount.value));
const shimmerVisible = computed(() => status.value === 'translating' && remaining.value > 0);
const shimmerWidth = computed(() => (totalSegments.value === 0 || remaining.value > 1 ? '86%' : '52%'));

function renderBlockHtml(block: { text: string }): string {
  return renderMarkdown(block.text);
}

// P6-B（2026-11-21）同款：markdown 正文文件链接右键委托（文件内自含，与
// StreamRenderer.onContentContextMenu 同实现；左键零动作，非文件链接不拦截）。
function onContentContextMenu(e: MouseEvent): void {
  const el = (e.target as HTMLElement | null)?.closest?.('.md-file-link') as HTMLElement | null;
  if (!el) return;
  e.preventDefault();
  const p = el.getAttribute('data-clip-path');
  if (p) useFileLinkMenuStore().open(p, e.clientX, e.clientY);
}

// —— 内部滚动钉底（镜像 MessageList OPT-6：nearBottom<80px 跟底；rAF 批处理 hb10-CHR-10 同款）——
const scrollEl = ref<HTMLElement | null>(null);
const nearBottom = ref(true);
let scrollRafId: number | null = null;

function onScroll(): void {
  const el = scrollEl.value;
  if (!el) return;
  nearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function pinToLatest(): void {
  if (scrollRafId !== null) return; // 本帧已排程
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = null;
    const el = scrollEl.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  });
}

// 译文增长：贴底用户跟最新进度；上滚阅读（nearBottom=false）不抢滚动。
watch(blocks, async () => {
  if (!nearBottom.value) return;
  await nextTick();
  pinToLatest();
});

// 挂载即钉到最新进度：swap pill 切回译文（组件重挂载）落在最新进度（原型 :569 同款）。
onMounted(() => {
  pinToLatest();
});

onBeforeUnmount(() => {
  if (scrollRafId !== null) {
    cancelAnimationFrame(scrollRafId);
    scrollRafId = null;
  }
});
</script>

<template>
  <div class="tr-viewport" data-testid="translation-viewport">
    <div class="tr-viewport__progress-track" aria-hidden="true">
      <div class="tr-viewport__progress" :style="{ width: `${progressPct}%` }"></div>
    </div>
    <div ref="scrollEl" class="tr-viewport__scroll" @scroll.passive="onScroll">
      <div
        v-for="block in blocks"
        :key="block.key"
        class="tr-viewport__seg fade-seg"
        v-html="renderBlockHtml(block)"
        v-enrich
        @contextmenu="onContentContextMenu"
      />
      <div v-if="shimmerVisible" class="tr-shimmer" :style="{ width: shimmerWidth }" aria-hidden="true"></div>
    </div>
    <div v-if="status === 'error'" class="tr-viewport__error" data-testid="translation-error">
      <span class="tr-viewport__error-text">{{ errorText }}</span>
      <button type="button" class="tr-viewport__error-retry" title="仅重译失败段（已完成段不重复计费）" @click="$emit('retry')">重试</button>
    </div>
  </div>
</template>

<style scoped>
/* 防切换塌陷 + 约束收口：max-height 240px（01 修订记录：原型 280px，指令收口 240px）。 */
.tr-viewport {
  min-height: 120px;
  display: flex;
  flex-direction: column;
  font-size: 0.875rem;
  line-height: 1.75;
  word-break: break-word;
}

/* 视口顶部 2px 细进度线（translatedSegments/totalSegments 百分比宽）。 */
.tr-viewport__progress-track {
  flex: none;
  height: 2px;
  margin-bottom: 6px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  overflow: hidden;
}

.tr-viewport__progress {
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--color-accent);
  transition: width 0.3s var(--ease-out, ease-out);
}

.tr-viewport__scroll {
  flex: 1;
  min-height: 0;
  max-height: 240px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.tr-viewport__seg {
  min-width: 0;
}

.tr-viewport__seg :deep(p) {
  margin: 0 0 0.25rem;
}

.tr-viewport__seg :deep(p:last-child) {
  margin-bottom: 0;
}

.tr-viewport__seg :deep(.md-file-link) {
  color: var(--color-accent-strong);
  font-weight: 500;
  cursor: pointer;
  text-decoration: underline dotted;
  text-decoration-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
  text-underline-offset: 4px;
}

.tr-viewport__seg :deep(.md-file-link:hover) {
  text-decoration-style: solid;
  color: var(--color-accent);
}

/* 已译段渐显（原型 .fade-seg :207-208）：以「本次新增的已译段」为渐显单位——段按 index
   独立成块，新块挂载即动画；已译段就地更新（节流合帧下段内增长）不重挂载不重放。 */
.fade-seg {
  animation: tr-fade-in 260ms var(--ease-out, ease-out) both;
}

@keyframes tr-fade-in {
  from {
    opacity: 0;
    transform: translateY(2px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* 未译余量 shimmer 占位（原型 .tr-shimmer :210-211）。 */
.tr-shimmer {
  flex: none;
  height: 0.875rem;
  margin: 0.5rem 0;
  border-radius: 4px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--color-text) 8%, transparent) 25%,
    color-mix(in srgb, var(--color-text) 14%, transparent) 45%,
    color-mix(in srgb, var(--color-text) 8%, transparent) 65%
  );
  background-size: 240% 100%;
  animation: tr-shimmer-flow 1.3s linear infinite;
}

@keyframes tr-shimmer-flow {
  from {
    background-position: 120% 0;
  }
  to {
    background-position: -120% 0;
  }
}

/* error 态：视口内 danger 横条（不整块消失）。 */
.tr-viewport__error {
  flex: none;
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid color-mix(in srgb, var(--color-danger) 35%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-danger) 8%, transparent);
}

.tr-viewport__error-text {
  flex: 1;
  min-width: 0;
  font-size: 0.75rem;
  line-height: 1.4;
  color: var(--color-danger);
  word-break: break-word;
}

.tr-viewport__error-retry {
  flex: none;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel);
  color: var(--color-text);
  font-size: 0.75rem;
  font-family: inherit;
  padding: 2px 10px;
  cursor: pointer;
}

.tr-viewport__error-retry:hover {
  border-color: var(--color-danger);
  color: var(--color-danger);
}

@media (prefers-reduced-motion: reduce) {
  .fade-seg,
  .tr-shimmer {
    animation: none;
  }

  .tr-viewport__progress {
    transition: none;
  }
}
</style>
