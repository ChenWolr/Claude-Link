<script setup lang="ts">
// ProviderModelList.vue — 「我的模型」列表（r5：每行右侧「测试」按钮做单模型连接测试；
// 来源标签（查询/手动）+ token 数 + 删除。空状态引导查询/手动添加）。
import { reactive } from 'vue';
import type { ProviderModel } from '../../../shared/types/config';

const props = defineProps<{
  providerId: string;
  models: ProviderModel[];
}>();

const emit = defineEmits<{
  remove: [model: ProviderModel, index: number];
  toast: [message: string];
}>();

// 行内测试状态（按模型 ID）：pending（按钮内 spinner）→ ok/fail（按钮态）；重渲染会复位，可接受（r5 备注）。
type TestState = 'idle' | 'pending' | 'ok' | 'fail';
const testStates = reactive(new Map<string, TestState>());

function formatTokens(maxTokens: number): string {
  return maxTokens > 0 ? `${Math.floor(maxTokens / 1024)}k tok` : '—';
}

async function runRowTest(model: ProviderModel): Promise<void> {
  if (testStates.get(model.id) === 'pending') return;
  testStates.set(model.id, 'pending');
  try {
    const result = await window.claudeLink.testProviderModel(props.providerId, model.id);
    testStates.set(model.id, result.success ? 'ok' : 'fail');
    emit('toast', result.success
      ? `模型 ${model.id} 连接测试通过`
      : `模型 ${model.id} 连接失败：${result.message}${result.detail ? `（${result.detail}）` : ''}`);
  } catch (error) {
    testStates.set(model.id, 'fail');
    emit('toast', error instanceof Error ? error.message : `模型 ${model.id} 测试失败`);
  }
}
</script>

<template>
  <div v-if="models.length === 0" class="empty">
    还没有模型。点右上角 <b>「查询模型」</b>从端点拉取并点击添加，<br />或在下拉框中手动输入模型 ID 后点「确认」。
  </div>
  <div v-else class="mlist">
    <div v-for="(m, index) in models" :key="m.id" class="mrow">
      <span class="mid" :title="m.id">{{ m.id }}<span v-if="m.name !== m.id" class="nm">{{ m.name }}</span></span>
      <span class="mtok">{{ formatTokens(m.maxTokens) }}</span>
      <span :class="['tag', m.source]">{{ m.source === 'queried' ? '查询' : '手动' }}</span>
      <button
        type="button"
        :class="['btn', 'sm', 'mtest', testStates.get(m.id) ?? 'idle']"
        :disabled="testStates.get(m.id) === 'pending'"
        :aria-label="`用模型 ${m.id} 测试连接`"
        @click="runRowTest(m)"
      >
        <span v-if="testStates.get(m.id) === 'pending'" class="spinner" aria-hidden="true" />
        <svg v-else-if="testStates.get(m.id) === 'ok'" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
        <svg v-else-if="testStates.get(m.id) === 'fail'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>
        {{ testStates.get(m.id) === 'pending' ? '测试中' : testStates.get(m.id) === 'ok' ? '通过' : testStates.get(m.id) === 'fail' ? '失败' : '测试' }}
      </button>
      <button
        type="button"
        class="icon-btn"
        :aria-label="`删除模型 ${m.id}`"
        title="删除"
        @click="emit('remove', m, index)"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.empty {
  padding: 1.625rem 1.25rem 1.875rem;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  line-height: 1.6;
}

.empty b {
  color: var(--color-text);
}

.mlist {
  display: flex;
  flex-direction: column;
  margin-top: 0.75rem;
}

.mrow {
  display: grid;
  grid-template-columns: 1fr auto auto auto auto;
  align-items: center;
  gap: 0.625rem;
  padding: 0.4375rem 1.25rem;
  border-top: 1px solid color-mix(in srgb, var(--color-border) 55%, transparent);
}

.mrow:hover {
  background: color-mix(in srgb, var(--color-text) 3%, transparent);
}

.mrow .mid {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.8125rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mrow .mid .nm {
  color: var(--color-text-muted);
  font-family: inherit;
  font-size: 0.75rem;
  margin-left: 0.5rem;
}

.tag {
  font-size: 0.6875rem;
  padding: 0.125rem 0.5rem;
  border-radius: var(--radius-pill);
  font-weight: 600;
}

.tag.queried {
  color: var(--color-info-strong);
  background: color-mix(in srgb, var(--color-info) 10%, transparent);
}

.tag.manual {
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-text) 7%, transparent);
}

.mrow .mtok {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.4375rem 0.8125rem;
  font-size: 0.8125rem;
  font-weight: 600;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-panel-soft);
  color: var(--color-text);
  cursor: pointer;
}

.btn.sm {
  padding: 0.3125rem 0.625rem;
  font-size: 0.75rem;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mtest {
  white-space: nowrap;
  min-width: 4.625rem;
  justify-content: center;
}

.mtest.ok {
  color: var(--color-success-strong);
  border-color: color-mix(in srgb, var(--color-success) 45%, transparent);
  background: color-mix(in srgb, var(--color-success) 8%, transparent);
}

.mtest.fail {
  color: var(--color-danger);
  border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
  background: color-mix(in srgb, var(--color-danger) 7%, transparent);
}

.spinner {
  width: 0.875rem;
  height: 0.875rem;
  border: 2px solid color-mix(in srgb, var(--color-accent) 30%, transparent);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
  }
}

.icon-btn {
  width: 1.875rem;
  height: 1.875rem;
  display: inline-grid;
  place-items: center;
  border: 0;
  background: transparent;
  border-radius: var(--radius-xs);
  color: var(--color-text-muted);
  cursor: pointer;
}

.icon-btn:hover {
  background: color-mix(in srgb, var(--color-danger) 9%, transparent);
  color: var(--color-danger);
}

.icon-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

/* 窄容器（详情区 ≤460px，与 ProviderManager 折纵向同断点）：模型行从单行 grid 改两行 flex——
   模型名独占一行（完整 ellipsis），token/来源标签/测试/删除换行到第二行。
   避免 4 个 auto 操作列把 1fr 模型名压到 0、完全看不到。 */
@container (max-width: 460px) {
  .mrow {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem 0.625rem;
  }
  .mrow .mid {
    flex: 1 1 100%;
  }
}
</style>
