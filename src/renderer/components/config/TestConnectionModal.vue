<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { useConfigStore } from '../../stores/config-store';
import { renderMarkdown } from '../../utils/markdown';
import type { TestConnectionEventPayload } from '../../../shared/types/ipc';

// 测试连接弹框：选模型 → 流式显示 Claude Code 响应 → 实时状态（连接中/已连接/响应中/成功/失败）。
type Phase = 'idle' | 'connecting' | 'connected' | 'streaming' | 'done' | 'error';

interface TestResult {
  success: boolean;
  message: string;
  detail: string;
  durationMs?: number;
}

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ 'update:visible': [boolean] }>();

const configStore = useConfigStore();

const selectedModel = ref('sonnet');
const phase = ref<Phase>('idle');
const streamedText = ref('');
const result = ref<TestResult | null>(null);
// 用户点过「取消」：置 true 后忽略一切迟到的流式事件，杜绝取消后仍回显响应内容。
const aborted = ref(false);
let cleanup: (() => void) | null = null;

// —— 问题 3 明文回显（新增）——
const requestedModel = ref('');
const usedBaseUrl = ref('');
const reportedModel = ref('');

// 模型选项：来自当前配置的模型映射（别名 → 实际模型）；无映射时回退到内置别名。
const modelOptions = computed(() => {
  const mappings = configStore.modelMappings;
  const aliases = Object.keys(mappings);
  if (aliases.length > 0) {
    return aliases.map((a) => ({ id: a, label: `${a} → ${mappings[a]}` }));
  }
  return [
    { id: 'sonnet', label: 'sonnet（默认）' },
    { id: 'haiku', label: 'haiku（快速）' },
    { id: 'opus', label: 'opus（强力）' },
  ];
});

const isRunning = computed(
  () => phase.value === 'connecting' || phase.value === 'connected' || phase.value === 'streaming',
);

const statusText = computed(() => {
  switch (phase.value) {
    case 'idle': return '选择模型后点击「开始测试」';
    case 'connecting': return '连接中…（正在启动 Claude Code CLI）';
    case 'connected': return '已连接端点，等待模型响应…';
    case 'streaming': return '正在接收响应…';
    case 'done': return result.value?.success ? '连接成功' : '连接失败';
    case 'error': return result.value?.message || '出错';
    default: return '';
  }
});

const statusTone = computed(() => {
  if (phase.value === 'done') return result.value?.success ? 'success' : 'fail';
  if (phase.value === 'error') return 'fail';
  if (phase.value === 'idle') return 'idle';
  return 'running';
});

const renderedText = computed(() => renderMarkdown(streamedText.value));

const streamedEchoMatches = computed(() => {
  if (!requestedModel.value || !reportedModel.value) return true;
  return requestedModel.value.toLowerCase() === reportedModel.value.toLowerCase();
});

function handleEvent(payload: TestConnectionEventPayload): void {
  // 取消后到达的迟到的 streaming/done 事件一律丢弃。
  if (aborted.value) return;
  switch (payload.phase) {
    case 'connecting':
      phase.value = 'connecting';
      requestedModel.value = payload.requestedModel ?? '';
      usedBaseUrl.value = payload.usedBaseUrl ?? '';
      break;
    case 'connected':
      phase.value = 'connected';
      // payload.model 为 CC init 上报的实际模型（reportedModel）
      reportedModel.value = payload.model ?? reportedModel.value;
      break;
    case 'streaming':
      phase.value = 'streaming';
      if (payload.delta) streamedText.value += payload.delta;
      break;
    case 'done':
      phase.value = 'done';
      result.value = {
        success: payload.success ?? false,
        message: payload.message ?? '',
        detail: payload.detail ?? '',
        durationMs: payload.durationMs,
      };
      break;
    case 'error':
      phase.value = 'error';
      result.value = {
        success: false,
        message: payload.message ?? '出错',
        detail: payload.detail ?? '',
        durationMs: payload.durationMs,
      };
      break;
  }
}

async function startTest(): Promise<void> {
  aborted.value = false;
  phase.value = 'connecting';
  streamedText.value = '';
  result.value = null;
  if (!cleanup) {
    cleanup = window.claudeLink.onTestConnectionEvent(handleEvent);
  }
  await window.claudeLink.testConnection(selectedModel.value);
}

function abortTest(): void {
  // 关键：置标志 + 注销 IPC 监听，迟到的流式事件不再进入弹框。
  aborted.value = true;
  window.claudeLink.abortTestConnection();
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  phase.value = 'idle';
  streamedText.value = '';
  result.value = null;
}

function close(): void {
  if (isRunning.value) abortTest();
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  emit('update:visible', false);
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      phase.value = 'idle';
      streamedText.value = '';
      result.value = null;
      aborted.value = false;
      const valid = modelOptions.value.some((o) => o.id === selectedModel.value);
      if (!valid) selectedModel.value = modelOptions.value[0]?.id ?? 'sonnet';
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  if (cleanup) cleanup();
  window.claudeLink.abortTestConnection();
});
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-overlay" @click.self="close">
      <div class="modal">
        <header class="modal__header">
          <h2>测试连接</h2>
          <button type="button" class="modal__close" @click="close">×</button>
        </header>

        <div class="modal__body">
          <div class="test-controls">
            <label class="control-label">选择要测试的模型</label>
            <div class="test-controls__row">
              <select v-model="selectedModel" :disabled="isRunning" class="model-select">
                <option v-for="opt in modelOptions" :key="opt.id" :value="opt.id">{{ opt.label }}</option>
              </select>
              <button v-if="!isRunning" type="button" class="btn btn--primary" @click="startTest">开始测试</button>
              <button v-else type="button" class="btn btn--danger" @click="abortTest">取消</button>
            </div>
          </div>

          <div :class="['status-bar', `status-bar--${statusTone}`]">
            <span v-if="isRunning" class="spinner" />
            <span class="status-bar__text">{{ statusText }}</span>
            <span v-if="result?.durationMs" class="status-bar__duration">
              （{{ (result.durationMs / 1000).toFixed(1) }}s）
            </span>
          </div>

          <div v-if="requestedModel || usedBaseUrl" class="config-echo">
            <span>本次请求：<code>--model {{ requestedModel }}</code></span>
            <span>端点：<code>{{ usedBaseUrl || '(官方默认)' }}</code></span>
          </div>

          <div v-if="streamedText || isRunning" class="stream-area">
            <div class="stream-area__label">Claude Code 响应</div>
            <div class="stream-area__content markdown-body" v-html="renderedText" />
            <span v-if="phase === 'streaming'" class="cursor">▊</span>
          </div>

          <div v-if="phase === 'done' && result" :class="['config-verdict', result.success && streamedEchoMatches ? 'ok' : 'warn']">
            <template v-if="result.success && streamedEchoMatches">
              ✅ 已用 claude-link 配置：模型 <code>{{ reportedModel || requestedModel }}</code>
            </template>
            <template v-else-if="phase === 'done' && result.success && !streamedEchoMatches">
              ⚠️ CC 上报模型 <code>{{ reportedModel }}</code> 与配置 <code>{{ requestedModel }}</code> 不一致，疑似被 ~/.claude/settings.json 覆盖
            </template>
          </div>

          <div v-if="result && !result.success && result.detail" class="error-detail">
            <div class="error-detail__label">错误详情</div>
            <pre>{{ result.detail }}</pre>
          </div>
        </div>

        <footer class="modal__footer">
          <button type="button" class="btn" @click="close">关闭</button>
          <button
            v-if="phase === 'done' || phase === 'error'"
            type="button"
            class="btn btn--primary"
            @click="startTest"
          >
            重新测试
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--interaction-overlay-bg);
}

.modal {
  /* 固定尺寸（不随内容变长）：宽度 820px、高度 720px 上限；内容在 body 内部滚动。
     overlay 用 flex 双向居中 + margin:auto 双保险。 */
  width: min(820px, 94vw);
  height: min(720px, 88vh);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  overflow: hidden;
  margin: auto;
  box-shadow: var(--elevation-3), var(--ring-light);
}

.modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--color-border);
}

.modal__header h2 {
  margin: 0;
  font-size: 1rem;
}

.modal__close {
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 1.375rem;
  line-height: 1;
  cursor: pointer;
}

.modal__close:hover {
  color: var(--color-text);
}

.modal__body {
  flex: 1;
  min-height: 0;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  overflow: hidden;
}

.control-label {
  display: block;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  margin-bottom: 0.5rem;
}

.test-controls__row {
  display: flex;
  gap: 0.5rem;
}

.model-select {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
}

.btn {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0.5rem 1rem;
  font-size: 0.8125rem;
  cursor: pointer;
  white-space: nowrap;
}

.btn--primary {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-weight: 600;
  box-shadow: var(--ring-light-accent);
}

.btn--danger {
  border-color: var(--color-danger);
  background: transparent;
  color: var(--color-danger);
}

.status-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 0.875rem;
  border-radius: var(--radius-md);
  font-size: 0.8125rem;
}

.status-bar--running {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  color: var(--color-text);
}

.status-bar--success {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  color: var(--color-accent-strong);
}

.status-bar--fail {
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  color: var(--color-danger);
}

.status-bar--idle {
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
}

.status-bar__duration {
  color: var(--color-text-muted);
}

.config-echo {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}
.config-echo code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--color-text);
}
.config-verdict {
  padding: 0.625rem 0.875rem;
  border-radius: var(--radius-md);
  font-size: 0.8125rem;
}
.config-verdict.ok {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  color: var(--color-accent-strong);
}
.config-verdict.warn {
  background: color-mix(in srgb, var(--color-warn) 12%, transparent);
  color: var(--color-warn-strong);
}
.config-verdict code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  opacity: 0.7;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.stream-area {
  flex: 1 1 auto;
  min-height: 7.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  padding: 0.75rem 0.875rem;
  overflow-y: auto;
  box-shadow: var(--ring-light), var(--elevation-1);
}

.stream-area__label {
  font-size: 0.6875rem;
  font-weight: 700;
  color: var(--color-accent-strong);
  text-transform: uppercase;
  margin-bottom: 0.375rem;
  opacity: 0.7;
}

.stream-area__content {
  word-break: break-word;
  line-height: 1.6;
}

.stream-area__content :deep(p) {
  margin: 0 0 0.5rem;
}

.stream-area__content :deep(p:last-child) {
  margin-bottom: 0;
}

.cursor {
  animation: blink 1s step-end infinite;
  color: var(--color-accent-strong);
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

.error-detail {
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-fail) 6%, transparent);
  padding: 0.75rem 0.875rem;
  box-shadow: var(--ring-light), var(--elevation-1);
}

.error-detail__label {
  font-size: 0.6875rem;
  font-weight: 700;
  color: var(--color-danger);
  text-transform: uppercase;
  margin-bottom: 0.375rem;
}

.error-detail pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.75rem;
  color: var(--color-text);
  max-height: 11.25rem;
  overflow-y: auto;
}

.modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.875rem 1.25rem;
  border-top: 1px solid var(--color-border);
}

@media (prefers-reduced-motion: reduce) {
  .spinner { animation: none; }
  .cursor { animation: none; }
}
</style>
