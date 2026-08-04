<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { apiRetryErrorLabel, type ApiRetryTerminalDetailsV1 } from '../../../shared/api-retry-state';
import type { Message } from '../../../shared/types/session';

const props = defineProps<{ message: Message }>();
const panelId = useId();
const open = ref(false);

const details = computed<ApiRetryTerminalDetailsV1 | null>(() => {
  if (!props.message.rawEvent) return null;
  try {
    const parsed = JSON.parse(props.message.rawEvent) as ApiRetryTerminalDetailsV1;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
});
const kind = computed(() => details.value?.kind ?? (
  props.message.processKind === 'system:api_retry_exhausted' ? 'exhausted'
    : props.message.processKind === 'system:api_retry_stopped' ? 'user_stopped'
      : 'recovered'
));
const elapsed = computed(() =>
  typeof details.value?.elapsedMs === 'number' && Number.isFinite(details.value.elapsedMs)
    ? `${(details.value.elapsedMs / 1000).toFixed(1)} 秒`
    : '',
);
const delay = computed(() =>
  typeof details.value?.accumulatedDelayMs === 'number' && Number.isFinite(details.value.accumulatedDelayMs)
    ? `${(details.value.accumulatedDelayMs / 1000).toFixed(1)} 秒`
    : '',
);
</script>

<template>
  <article class="retry-record" :class="`retry-record--${kind}`">
    <button
      type="button"
      class="retry-record__summary"
      :aria-expanded="open"
      :aria-controls="panelId"
      @click="open = !open"
    >
      <span class="retry-record__icon" aria-hidden="true">{{ kind === 'recovered' ? '✓' : kind === 'exhausted' ? '!' : '■' }}</span>
      <strong>{{ message.content }}</strong>
      <span class="retry-record__arrow" :class="{ 'retry-record__arrow--open': open }" aria-hidden="true">›</span>
    </button>
    <dl v-if="open && details" :id="panelId" class="retry-record__details">
      <template v-if="details.lastError">
        <dt>最后错误</dt><dd>{{ apiRetryErrorLabel(details.lastError) }}</dd>
      </template>
      <template v-if="details.lastErrorStatus != null">
        <dt>HTTP 状态</dt><dd>{{ details.lastErrorStatus }}</dd>
      </template>
      <template v-if="elapsed">
        <dt>实际经过</dt><dd>{{ elapsed }}</dd>
      </template>
      <template v-if="delay">
        <dt>累计退避</dt><dd>{{ delay }}</dd>
      </template>
      <dt>处理结果</dt>
      <dd>{{ kind === 'recovered' ? '上游已恢复，本次回复继续' : '仅终止本次回复，会话仍可继续' }}</dd>
    </dl>
  </article>
</template>

<style scoped>
.retry-record {
  --retry-record-color: var(--color-text-muted);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--retry-record-color) 34%, var(--color-border));
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--retry-record-color) 7%, var(--color-panel-soft));
}
.retry-record--recovered { --retry-record-color: var(--color-success-strong); }
.retry-record--exhausted { --retry-record-color: var(--color-danger); }
.retry-record__summary {
  width: 100%;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border: 0;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.retry-record__summary:hover {
  background: color-mix(in srgb, var(--retry-record-color) 8%, transparent);
}
.retry-record__summary strong {
  overflow: hidden;
  font-size: 0.8125rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.retry-record__icon,
.retry-record__arrow {
  color: var(--retry-record-color);
  font-weight: 700;
}
.retry-record__arrow {
  transition: transform var(--duration-fast) var(--ease-out);
}
.retry-record__arrow--open { transform: rotate(90deg); }
.retry-record__details {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 5px 12px;
  margin: 0;
  padding: 8px 10px 10px 30px;
  border-top: 1px solid color-mix(in srgb, var(--retry-record-color) 20%, var(--color-border));
  color: var(--color-text-muted);
  font-size: 0.75rem;
}
.retry-record__details dt,
.retry-record__details dd { margin: 0; }
.retry-record__details dd {
  color: var(--color-text);
  overflow-wrap: anywhere;
}
@media (prefers-reduced-motion: reduce) {
  .retry-record__arrow { transition: none; }
}
</style>
