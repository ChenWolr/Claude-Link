<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useSessionStore } from '../../stores/session-store';

const emit = defineEmits<{ compress: [] }>();
const store = useSessionStore();

const showPopover = ref(false);
// 问题 4：CC 自动压缩横幅。store.compactedJustNow 变 true 时显示，3 秒后自动消失并复位。
// switchSession 会把 compactedJustNow 置 false——watch 的 false 分支也清横幅，
// 避免切到新会话后旧横幅残留最多 3 秒误导用户。
const showCompactBanner = ref(false);
let bannerTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => store.compactedJustNow,
  (v) => {
    if (!v) {
      // compactedJustNow 被复位（切换会话/手动 clear）→ 立即隐藏横幅
      showCompactBanner.value = false;
      if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
      return;
    }
    showCompactBanner.value = true;
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      showCompactBanner.value = false;
      store.clearCompactedJustNow();
      bannerTimer = null;
    }, 3000);
  },
);

// 组件卸载时清 timer，避免 setTimeout 回调访问已销毁的 ref
onBeforeUnmount(() => {
  if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
});

const stats = computed(() => store.contextStats);
// 始终展示结构化三行；无数据时按 已用 0 / 默认窗口 / 占比 0% 显示，不用"尚未产生上下文"这种空态文案。
const DEFAULT_WINDOW = 200000;
const eff = computed(() =>
  stats.value ?? { inputTokens: 0, outputTokens: 0, windowSize: DEFAULT_WINDOW, ratio: 0 },
);
const pct = computed(() => Math.min(100, Math.round(eff.value.ratio * 100)));

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
</script>

<template>
  <div class="ctx" @mouseenter="showPopover = true" @mouseleave="showPopover = false">
    <button
      type="button"
      class="ctx__btn"
      :class="{ 'ctx__btn--high': pct >= 80 }"
      :title="`上下文已用 ${pct}%，点击压缩`"
      @click="emit('compress')"
    >
      <!-- 圆环可视化：底圈=未占用(整环)，扇形弧=已占用。无数据(pct=0)时只显示空底圈。 -->
      <svg class="ctx__ring" viewBox="0 0 36 36" aria-hidden="true">
        <circle class="ctx__ring-bg" cx="18" cy="18" r="15.915" />
        <circle
          v-if="pct > 0"
          class="ctx__ring-fg"
          cx="18" cy="18" r="15.915"
          :stroke-dasharray="`${pct} ${100 - pct}`"
        />
      </svg>
    </button>

    <div v-if="showPopover" class="ctx__popover">
      <div class="ctx__row"><span>已用上下文</span><code>{{ fmt(eff.inputTokens) }}</code></div>
      <div class="ctx__row"><span>最大上下文</span><code>{{ fmt(eff.windowSize) }}</code></div>
      <div class="ctx__row ctx__row--pct"><span>占比</span><code>{{ pct }}%</code></div>
    </div>

    <!-- 问题 4：CC 自动压缩横幅。收到 compactedJustNow 时弹出，3 秒后自动消失。 -->
    <transition name="ctx-banner">
      <div v-if="showCompactBanner" class="ctx__banner" role="status" aria-live="polite">
        Claude Code 已自动压缩上下文
      </div>
    </transition>
  </div>
</template>

<style scoped>
.ctx { position: relative; }
.ctx__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
  padding: 3px;
  cursor: pointer;
}
.ctx__btn:hover { border-color: var(--color-accent); }
.ctx__btn--high { border-color: rgba(204, 163, 61, 0.5); }
.ctx__ring { width: 22px; height: 22px; display: block; transform: rotate(-90deg); }
/* 周长 ≈ 2*π*15.915 ≈ 100，dasharray 用百分比即可表示扇形占用 */
.ctx__ring-bg {
  fill: none;
  stroke: var(--color-border);
  stroke-width: 3;
  opacity: 0.7;
}
.ctx__ring-fg {
  fill: none;
  stroke: var(--color-accent);
  stroke-width: 3;
  stroke-linecap: round;
  transition: stroke-dasharray 0.3s;
}
.ctx__btn--high .ctx__ring-fg { stroke: #e0c36a; }

.ctx__popover {
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  z-index: 100;
  min-width: 220px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.ctx__row { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; color: var(--color-text-muted); }
.ctx__row code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--color-text); font-variant-numeric: tabular-nums; }
.ctx__btn--high ~ .ctx__popover .ctx__row--pct code,
.ctx__row--pct code { color: var(--color-accent-strong); }
.ctx__row--pct { color: var(--color-text); }
.ctx__nums { font-size: 12px; color: var(--color-text); font-variant-numeric: tabular-nums; }
.ctx__muted { font-size: 12px; color: var(--color-text-muted); }

/* 问题 4：CC 自动压缩横幅 */
.ctx__banner {
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  z-index: 101;
  white-space: nowrap;
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  color: var(--color-text);
  padding: 6px 10px;
  font-size: 12px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
}
.ctx-banner-enter-active, .ctx-banner-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.ctx-banner-enter-from, .ctx-banner-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
