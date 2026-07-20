<script setup lang="ts">
// 导出进度遮罩（v3 第 10 节）。仅当活动会话 == 导出源会话时显示，只阻断源会话聊天区交互。
import { computed } from 'vue';
import { useExportImageStore } from '../../stores/export-image-store';
import { useSessionStore } from '../../stores/session-store';

const exportStore = useExportImageStore();
const sessionStore = useSessionStore();

// 只在源会话的活动聊天区显示遮罩；用户切到其他会话时不显示（任务仍在后台跑）。
const visible = computed(
  () =>
    exportStore.phase !== 'idle' &&
    !!exportStore.sessionId &&
    sessionStore.activeSession?.id === exportStore.sessionId,
);

const terminalTone = computed(() => {
  if (exportStore.phase === 'done') return 'ok';
  if (exportStore.phase === 'cancelled') return 'muted';
  if (exportStore.phase === 'error') return 'err';
  return '';
});
</script>

<template>
  <div v-if="visible" class="export-overlay">
    <div class="export-card" :data-tone="terminalTone">
      <div class="export-card__icon">{{ exportStore.phase === 'done' ? '✅' : exportStore.phase === 'error' ? '⚠️' : exportStore.phase === 'cancelled' ? '✕' : '🖼️' }}</div>
      <div class="export-card__body">
        <div class="export-card__message">{{ exportStore.message || '正在导出…' }}</div>
        <div v-if="exportStore.running" class="export-card__progress">
          <div class="export-card__bar">
            <div
              v-if="!exportStore.indeterminate"
              class="export-card__bar-fill"
              :style="{ width: exportStore.percent + '%' }"
            />
            <div v-else class="export-card__bar-indeterminate" />
          </div>
          <span class="export-card__pct">{{ exportStore.indeterminate ? '…' : exportStore.percent + '%' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.export-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--color-bg) 55%, transparent);
  backdrop-filter: blur(2px);
}
.export-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 24px;
  border-radius: var(--radius-lg);
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  box-shadow: var(--elevation-3), var(--ring-light);
  min-width: 320px;
  max-width: 440px;
}
.export-card__icon {
  font-size: 1.5rem;
}
.export-card__body {
  flex: 1;
  min-width: 0;
}
.export-card__message {
  font-size: 0.875rem;
  color: var(--color-text);
  margin-bottom: 8px;
}
.export-card__progress {
  display: flex;
  align-items: center;
  gap: 10px;
}
.export-card__bar {
  position: relative;
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--color-panel-soft);
  overflow: hidden;
}
.export-card__bar-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--color-accent);
  transition: width 0.2s ease;
}
.export-card__bar-indeterminate {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: linear-gradient(90deg, transparent, var(--color-accent), transparent);
  animation: export-indeterminate 1.3s infinite linear;
}
@keyframes export-indeterminate {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

@media (prefers-reduced-motion: reduce) {
  .export-card__bar-indeterminate {
    animation: none !important;
  }
}
.export-card__pct {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  min-width: 36px;
  text-align: right;
}
.export-card[data-tone='ok'] {
  border-color: color-mix(in srgb, var(--color-accent) 50%, var(--color-border));
}
.export-card[data-tone='err'] {
  border-color: color-mix(in srgb, var(--color-fail) 50%, var(--color-border));
}
</style>
