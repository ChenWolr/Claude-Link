<script setup lang="ts">
// ApiRetryBanner.vue
// Bug4/Bug5：API 重试瞬态指示器。api_retry 事件改走 forwardTransient（不落库、不进聊天流）后，
// 由它承载「API 重试中（第 N 次）」。计数来自 session-store 的本回合累计（每条 api_retry 自增，
// 真实业务事件清零），不再用 SDK 单次 attempt 字段（第三方端点常恒为 1）——故能正确显示 1→2→3。
// 自包含：直接读 session-store.activeApiRetryInfo，无需父组件传 props。无动作按钮——它是信息性
// 指示；若重试风暴持续触发卡死，StalledBanner 会接管并提供「继续等待/重试/中断」。
import { computed } from 'vue';
import { useSessionStore } from '../../stores/session-store';

const sessionStore = useSessionStore();
const info = computed(() => sessionStore.activeApiRetryInfo);

// 给 SDK 报的 error 一个简短中文（限流/过载/鉴权失败等），无则空。
const errorLabel = computed(() => {
  const e = info.value?.error;
  if (!e) return '';
  const map: Record<string, string> = {
    rate_limit: '限流',
    overloaded: '过载',
    authentication_failed: '鉴权失败',
    invalid_request: '请求非法',
    server_error: '服务端错误',
  };
  return map[e] ? `（${map[e]}）` : `（${e}）`;
});
</script>

<template>
  <div v-if="info" class="retry-banner" role="status" aria-live="polite">
    <span class="retry-banner__icon">⟳</span>
    <span class="retry-banner__text">
      API 重试中（第 {{ info.attempt }}<template v-if="info.max">/{{ info.max }}</template> 次）{{ errorLabel }}
    </span>
  </div>
</template>

<style scoped>
.retry-banner {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0 2px;
  padding: 4px 10px;
  border-radius: var(--radius-md);
  /* 信息性指示（非告警）：用 color-mix 把强调色淡混入面板，随 ThemePalette 自适应。 */
  background: color-mix(in srgb, var(--color-accent-strong) 10%, var(--color-panel-soft));
  border: 1px solid color-mix(in srgb, var(--color-accent-strong) 28%, transparent);
  color: var(--color-text);
  font-size: 12px;
  box-shadow: var(--ring-light);
}
.retry-banner__icon {
  font-size: 13px;
  color: var(--color-accent-strong);
  animation: retry-spin 1.4s linear infinite;
}
.retry-banner__text {
  font-variant-numeric: tabular-nums;
}
@keyframes retry-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .retry-banner__icon { animation: none; }
}
</style>
