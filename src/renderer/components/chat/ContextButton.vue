<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useSessionStore } from '../../stores/session-store';

const props = withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false });
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
// Task 9：圆环只读可信当前窗口。无可信当前窗口 → pending（空底圈 + 待刷新提示），不得显示 0%。
const hasTrustedCurrent = computed(
  () => stats.value != null && stats.value.currentUsedTokens != null,
);
// 圆环百分比：只读可信 currentPercent；否则 0（只画空底圈）。
const pct = computed(() => {
  const p = stats.value?.currentPercent;
  return typeof p === 'number' && Number.isFinite(p) ? Math.min(100, Math.max(0, Math.round(p))) : 0;
});
// popover 数值：可信当前窗口时显示 current；否则显示「待刷新」。
const eff = computed(() => ({
  currentUsedTokens: stats.value?.currentUsedTokens ?? null,
  windowSize: stats.value?.windowSize ?? null,
  turnInputTokens: stats.value?.turnInputTokens ?? null,
  turnCacheReadTokens: stats.value?.turnCacheReadTokens ?? null,
  turnCacheCreationTokens: stats.value?.turnCacheCreationTokens ?? null,
  source: stats.value?.source ?? null,
  freshness: stats.value?.freshness ?? null,
  consistency: stats.value?.consistency ?? null,
  diagnostic: stats.value?.diagnostic ?? null,
  // review-v4 High-1：采样阶段透出（query-start=回合开始基线 / post-turn=回合末 / post-compaction=压缩后），
  // 用户可区分「当前值」与「回合开始时的采样」。
  samplePhase: stats.value?.samplePhase ?? null,
}));
// 批次 B：思考进行中时按钮加克制 accent 呼吸提示（thinking_tokens.estimated_tokens > 0 即触发）。
// 仅作「正在思考」可视提示，不在 hover popover 展示数值（按用户要求移除）。
const thinking = computed(() => typeof store.thinkingTokens === 'number' && store.thinkingTokens > 0);
// review-v4 §3.5 方案 B / review-v5 Low-1：stale 态（post-turn 兜底是普通回合结束后的常态）下
// 数字保留 last-known 可以接受，但 title 必须标明不是当前实时值。
const isStaleTrusted = computed(() => hasTrustedCurrent.value && eff.value.freshness !== 'fresh');
const btnTitle = computed(() => {
  if (!hasTrustedCurrent.value) return '上下文待刷新，点击压缩';
  return isStaleTrusted.value
    ? `上下文约已用 ${pct.value}%（上次采样，待刷新），点击压缩`
    : `上下文已用 ${pct.value}%，点击压缩`;
});
// review-v5 Medium-1：diagnostic 最后一公里——popover 截断展示 + title 放全文。
const diagPreview = computed(() => {
  const d = eff.value.diagnostic ?? '';
  return d.length > 80 ? d.slice(0, 80) + '…' : d;
});

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

</script>

<template>
  <div class="ctx" @mouseenter="showPopover = true" @mouseleave="showPopover = false">
    <button
      type="button"
      class="ctx__btn"
      :class="{ 'ctx__btn--high': pct >= 80, 'ctx__btn--thinking': thinking, 'ctx__btn--stale': isStaleTrusted }"
      :disabled="props.disabled"
      :title="btnTitle"
      @click="emit('compress')"
    >
      <!-- 圆环可视化：底圈=未占用(整环)，扇形弧=已占用。无可信当前窗口(pct=0)时只显示空底圈。 -->
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
      <div class="ctx__row"><span>已用上下文</span><code>{{ hasTrustedCurrent ? fmt(eff.currentUsedTokens ?? 0) : '待刷新' }}</code></div>
      <div class="ctx__row"><span>最大上下文</span><code>{{ eff.windowSize != null ? fmt(eff.windowSize) : '—' }}</code></div>
      <div v-if="eff.turnInputTokens != null" class="ctx__row"><span>本轮输入</span><code>{{ fmt(eff.turnInputTokens) }}</code></div>
      <div v-if="eff.turnCacheReadTokens != null" class="ctx__row"><span>缓存读取</span><code>{{ fmt(eff.turnCacheReadTokens) }}</code></div>
      <div v-if="eff.turnCacheCreationTokens != null" class="ctx__row"><span>缓存写入</span><code>{{ fmt(eff.turnCacheCreationTokens) }}</code></div>
      <div class="ctx__row ctx__row--pct"><span>占比</span><code>{{ hasTrustedCurrent ? pct + '%' : '待刷新' }}</code></div>
      <div v-if="eff.source || eff.freshness" class="ctx__row"><span>来源</span><code>{{ eff.source }} / {{ eff.freshness }}</code></div>
      <div v-if="eff.samplePhase" class="ctx__row"><span>采样阶段</span><code>{{ { 'query-start': '回合开始', 'mid-turn': '回合中', 'post-turn': '回合结束', 'post-compaction': '压缩后' }[eff.samplePhase] ?? eff.samplePhase }}</code></div>
      <div v-if="eff.consistency === 'mismatch' || eff.consistency === 'unavailable'" class="ctx__row"><span>状态</span><code>{{ eff.consistency === 'mismatch' ? '对账不一致' : '暂不可对账' }}</code></div>
      <!-- review-v5 Medium-1：主进程四条 unavailable/mismatch 路径构造的具体诊断在此落地（含上一采样阶段）。 -->
      <div v-if="eff.diagnostic" class="ctx__row ctx__row--diag" data-testid="ctx-diag-row"><span>诊断</span><code :title="eff.diagnostic">{{ diagPreview }}</code></div>
      <!-- compact metadata display：压缩明细行（三值齐时才显示，样式与诊断行同级 muted）。 -->
    </div>

    <!-- C：实时压缩进行中（status:compacting） -->
    <transition name="ctx-banner">
      <div v-if="store.compacting" class="ctx__banner ctx__banner--compacting" role="status" aria-live="polite">
        正在压缩上下文…
      </div>
    </transition>

    <!-- 问题 4：CC 自动压缩横幅。收到 compactedJustNow 时弹出，3 秒后自动消失。 -->
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
  padding: 0.1875rem;
  cursor: pointer;
}
.ctx__btn:hover { border-color: var(--color-accent); }
.ctx__btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ctx__btn:disabled:hover { border-color: var(--color-border); }
.ctx__btn--high { border-color: color-mix(in srgb, var(--color-warn) 50%, transparent); }
.ctx__btn--thinking {
  border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
  animation: ctx-thinking 1.6s ease-in-out infinite;
}
@keyframes ctx-thinking {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-accent) 0%, transparent); }
  50% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 22%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  .ctx__btn--thinking {
    animation: none;
  }
}
.ctx__ring { width: 1.375rem; height: 1.375rem; display: block; transform: rotate(-90deg); }
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
.ctx__btn--high .ctx__ring-fg { stroke: var(--color-warn-strong); }
/* review-v5 Low-1：stale 态圆环降透明度，与 thinking 呼吸态区分（数字为上次采样非实时） */
.ctx__btn--stale .ctx__ring-fg { stroke-opacity: 0.55; }

.ctx__popover {
  position: absolute;
  left: 0;
  bottom: calc(100% + 0.375rem);
  z-index: 100;
  min-width: 13.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  box-shadow: var(--elevation-3), var(--ring-light);
}
.ctx__row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; font-size: 0.75rem; color: var(--color-text-muted); }
.ctx__row code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--color-text); font-variant-numeric: tabular-nums; }
.ctx__btn--high ~ .ctx__popover .ctx__row--pct code,
.ctx__row--pct code { color: var(--color-accent-strong); }
.ctx__row--pct { color: var(--color-text); }
.ctx__nums { font-size: 0.75rem; color: var(--color-text); font-variant-numeric: tabular-nums; }
.ctx__muted { font-size: 0.75rem; color: var(--color-text-muted); }

/* 问题 4：CC 自动压缩横幅 */
.ctx__banner {
  position: absolute;
  left: 0;
  bottom: calc(100% + 0.375rem);
  z-index: 101;
  white-space: nowrap;
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  color: var(--color-text);
  padding: 0.375rem 0.625rem;
  font-size: 0.75rem;
  box-shadow: var(--elevation-2), var(--ring-light);
}
/* C：实时压缩态强调色 */
.ctx__banner--compacting {
  border-color: var(--color-accent-strong);
  color: var(--color-accent-strong);
}
.ctx-banner-enter-active, .ctx-banner-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.ctx-banner-enter-from, .ctx-banner-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
