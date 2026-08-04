<script setup lang="ts">
// 上游 API 重试持续状态卡：只展示主进程下发的权威计数与截止时间。
// renderer 仅负责倒计时和用户停止，不自行累计重试次数。
import { computed } from 'vue';
import { apiRetryErrorLabel } from '../../../shared/api-retry-state';
import { useChat } from '../../composables/use-chat';
import { useNow } from '../../composables/use-now';
import { useSessionStore } from '../../stores/session-store';

const sessionStore = useSessionStore();
const chat = useChat();
const info = computed(() => sessionStore.activeApiRetryInfo);
const fallback = computed(() => sessionStore.activeApiRetryTerminalFallback);
const { now } = useNow(() => !!info.value?.nextRetryAt && !info.value?.stopping);

const errorLabel = computed(() => apiRetryErrorLabel(info.value?.error));
const progress = computed(() => {
  if (!info.value || info.value.retryLimit <= 0) return 0;
  return Math.min(100, Math.max(0, (info.value.retryCount / info.value.retryLimit) * 100));
});
const countdownText = computed(() => {
  const target = info.value?.nextRetryAt;
  if (!target) return '等待 Claude Code 自动重试';
  const remainingMs = target - now.value;
  if (remainingMs <= 0) return '正在再次尝试';
  return `预计 ${Math.ceil(remainingMs / 1000)} 秒后再次尝试`;
});

async function stopRetrying(): Promise<void> {
  const session = sessionStore.activeSession;
  if (!session || info.value?.stopping) return;
  sessionStore.markApiRetryStopping(session.id);
  await chat.abort({ preserveApiRetry: true });
}
</script>

<template>
  <section v-if="info" class="retry-card" role="status" aria-live="polite">
    <span class="retry-card__icon" aria-hidden="true">⟳</span>
    <div class="retry-card__body">
      <strong>上游服务暂时不可达，正在自动重试</strong>
      <span class="retry-card__meta">
        已重试 {{ info.retryCount }}/{{ info.retryLimit }} 次 · {{ errorLabel }}
      </span>
      <div class="retry-progress" aria-hidden="true">
        <span :style="{ width: `${progress}%` }"></span>
      </div>
      <div class="retry-card__footer">
        <span class="retry-card__countdown" aria-hidden="true">{{ countdownText }}</span>
        <button
          type="button"
          class="retry-card__stop"
          :disabled="info.stopping"
          @click="stopRetrying"
        >
          {{ info.stopping ? '正在停止…' : '立即停止' }}
        </button>
      </div>
    </div>
  </section>
  <section
    v-else-if="fallback"
    class="retry-card retry-card--terminal"
    role="status"
    aria-live="polite"
  >
    <span class="retry-card__terminal-icon" aria-hidden="true">!</span>
    <div class="retry-card__body">
      <strong>{{ fallback.summary }}</strong>
      <span class="retry-card__meta">该记录未能保存，重启应用后将不再显示。</span>
    </div>
  </section>
</template>

<style scoped>
.retry-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 8px 0 4px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--color-warn) 38%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-warn) 12%, var(--color-panel-soft));
  color: var(--color-text);
  box-shadow: var(--ring-light), var(--elevation-1);
}
.retry-card__icon,
.retry-card__terminal-icon {
  color: var(--color-warn);
  font-size: 20px;
}
.retry-card__icon {
  animation: retry-spin 1.4s linear infinite;
}
.retry-card__body {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: 5px;
}
.retry-card__meta,
.retry-card__footer {
  color: var(--color-text-muted);
  font-size: 12px;
}
.retry-progress {
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-warn) 18%, transparent);
}
.retry-progress > span {
  display: block;
  height: 100%;
  background: var(--color-warn);
  transition: width var(--duration-fast) var(--ease-out);
}
.retry-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.retry-card__stop {
  padding: 4px 10px;
  border: 1px solid var(--color-warn);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
}
.retry-card__stop:disabled {
  cursor: default;
  opacity: 0.6;
}
@keyframes retry-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .retry-card__icon { animation: none; }
  .retry-progress > span { transition: none; }
}
</style>
