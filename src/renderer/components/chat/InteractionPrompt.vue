<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { InteractionPromptOption, InteractionPromptPayload } from '../../../shared/types/ipc';
import InteractionDetails from './InteractionDetails.vue';
import InteractionOptionList from './InteractionOptionList.vue';
import InteractionPreview from './InteractionPreview.vue';

const OTHER_OPTION_ID = '__other__';

const requests = ref<InteractionPromptPayload[]>([]);
const focusedIndex = ref(0);
const selectedIds = ref<Set<string>>(new Set());
const otherText = ref('');
const submittingId = ref<string | null>(null);
const otherInput = ref<HTMLInputElement | null>(null);
let cleanupRequest: (() => void) | null = null;
let cleanupCancel: (() => void) | null = null;

const activeRequest = computed(() => requests.value[0] ?? null);
const options = computed(() => activeRequest.value?.options ?? []);
const selectedIdList = computed(() => Array.from(selectedIds.value));
const hasPreview = computed(() => options.value.some((option) => Boolean(option.preview)));
const focusedOption = computed(() => options.value[focusedIndex.value] ?? null);
const selectedOption = computed(() => {
  const [id] = selectedIdList.value;
  return options.value.find((option) => option.id === id) ?? null;
});
const showOtherInput = computed(() => selectedIds.value.has(OTHER_OPTION_ID));
const eyebrow = computed(() => {
  if (activeRequest.value?.kind === 'permission') return 'Claude Code 需要确认';
  if (activeRequest.value?.kind === 'multi-choice') return 'Claude Code 需要你多选';
  if (activeRequest.value?.kind === 'text') return 'Claude Code 需要你输入';
  return 'Claude Code 需要你选择';
});
const submitLabel = computed(() => {
  if (activeRequest.value?.kind === 'permission') return selectedOption.value?.label ?? '提交选择';
  if (activeRequest.value?.kind === 'multi-choice') return '提交选择';
  return '确认选择';
});
const cancelLabel = computed(() => activeRequest.value?.kind === 'permission' ? '拒绝' : '取消');
const canSubmit = computed(() => {
  if (!activeRequest.value || submittingId.value === activeRequest.value.id) return false;
  if (activeRequest.value.kind === 'text') return otherText.value.trim().length > 0;
  if (showOtherInput.value) return otherText.value.trim().length > 0;
  return selectedIds.value.size > 0 || activeRequest.value.kind === 'confirm';
});

function initSelection(request: InteractionPromptPayload): void {
  const requestOptions = request.options ?? [];
  const defaults = request.defaultOptionIds?.filter((id) => requestOptions.some((option) => option.id === id)) ?? [];
  focusedIndex.value = defaults[0] ? Math.max(0, requestOptions.findIndex((option) => option.id === defaults[0])) : 0;
  selectedIds.value = new Set(defaults.length ? defaults : request.multiSelect ? [] : requestOptions[0] ? [requestOptions[0].id] : []);
  otherText.value = '';
}

function enqueue(request: InteractionPromptPayload): void {
  const wasEmpty = requests.value.length === 0;
  requests.value = [...requests.value.filter((item) => item.id !== request.id), request];
  if (wasEmpty || requests.value[0]?.id === request.id) {
    initSelection(request);
  }
}

function shiftQueue(): void {
  requests.value = requests.value.slice(1);
  const next = requests.value[0];
  if (next) initSelection(next);
}

function updateSelected(next: Set<string>): void {
  selectedIds.value = next;
  if (!next.has(OTHER_OPTION_ID)) otherText.value = '';
}

function focusOption(index: number): void {
  if (!options.value.length) return;
  focusedIndex.value = Math.max(0, Math.min(index, options.value.length - 1));
}

function toggleOption(optionId: string): void {
  const request = activeRequest.value;
  if (!request) return;
  const optionIndex = options.value.findIndex((option) => option.id === optionId);
  if (optionIndex >= 0) focusOption(optionIndex);

  if (request.multiSelect) {
    const next = new Set(selectedIds.value);
    if (next.has(optionId)) next.delete(optionId);
    else next.add(optionId);
    updateSelected(next);
    return;
  }

  updateSelected(new Set([optionId]));
}

async function submit(optionId?: string): Promise<void> {
  const request = activeRequest.value;
  if (!request || submittingId.value === request.id) return;
  if (optionId) toggleOption(optionId);
  const ids = optionId && !request.multiSelect ? [optionId] : Array.from(selectedIds.value);
  if (!ids.length && request.kind !== 'text' && request.kind !== 'confirm') return;
  if (ids.includes(OTHER_OPTION_ID) && !otherText.value.trim()) {
    await nextTick();
    otherInput.value?.focus();
    return;
  }
  if (request.kind === 'text' && !otherText.value.trim()) {
    await nextTick();
    otherInput.value?.focus();
    return;
  }

  submittingId.value = request.id;
  try {
    await window.claudeLink.respondInteraction({
      id: request.id,
      action: 'submit',
      selectedOptionIds: ids,
      otherText: otherText.value.trim() || undefined,
    });
    if (activeRequest.value?.id === request.id) shiftQueue();
  } finally {
    submittingId.value = null;
  }
}

async function cancel(): Promise<void> {
  const request = activeRequest.value;
  if (!request || submittingId.value === request.id) return;
  submittingId.value = request.id;
  try {
    await window.claudeLink.respondInteraction({ id: request.id, action: 'cancel' });
    if (activeRequest.value?.id === request.id) shiftQueue();
  } finally {
    submittingId.value = null;
  }
}

function move(delta: number): void {
  if (!options.value.length) return;
  const nextIndex = (focusedIndex.value + delta + options.value.length) % options.value.length;
  focusOption(nextIndex);
  const request = activeRequest.value;
  const nextOption = options.value[nextIndex];
  if (request && !request.multiSelect && nextOption) {
    updateSelected(new Set([nextOption.id]));
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (!activeRequest.value) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    move(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    move(-1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    void submit();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    void cancel();
  } else if (event.key === ' ' && activeRequest.value.multiSelect && document.activeElement !== otherInput.value) {
    event.preventDefault();
    const option = focusedOption.value;
    if (option) toggleOption(option.id);
  }
}

function optionPreview(option: InteractionPromptOption | null): string | undefined {
  return option?.preview;
}

function removeRequest(id: string): void {
  requests.value = requests.value.filter((request) => request.id !== id);
  if (submittingId.value === id) submittingId.value = null;
  const next = requests.value[0];
  if (next) initSelection(next);
}

cleanupRequest = window.claudeLink.onInteractionRequest(enqueue);
cleanupCancel = window.claudeLink.onInteractionCancel(({ id }) => removeRequest(id));
void window.claudeLink.getPendingInteractions().then((pending) => {
  for (const request of pending) enqueue(request);
});
window.addEventListener('keydown', handleKeydown);

watch(showOtherInput, async (visible) => {
  if (visible) {
    await nextTick();
    otherInput.value?.focus();
  }
});

onBeforeUnmount(() => {
  cleanupRequest?.();
  cleanupCancel?.();
  window.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="activeRequest" class="interaction-overlay">
      <section
        class="interaction-dialog"
        :class="{ 'interaction-dialog--wide': hasPreview }"
        role="dialog"
        aria-modal="true"
        :aria-label="activeRequest.title"
      >
        <header class="interaction-dialog__header">
          <span class="interaction-dialog__eyebrow">{{ eyebrow }}</span>
          <h3>{{ activeRequest.title }}</h3>
          <p v-if="activeRequest.description">{{ activeRequest.description }}</p>
        </header>

        <div class="interaction-dialog__body" :class="{ 'interaction-dialog__body--preview': hasPreview }">
          <div class="interaction-dialog__choices">
            <InteractionOptionList
              v-if="options.length"
              :options="options"
              :focused-index="focusedIndex"
              :selected-ids="selectedIdList"
              :multi-select="activeRequest.multiSelect"
              @focus="focusOption"
              @toggle="toggleOption"
              @submit="submit"
            />

            <label v-if="showOtherInput || activeRequest.kind === 'text'" class="interaction-other">
              <span>{{ activeRequest.kind === 'text' ? '输入内容' : activeRequest.otherLabel ?? 'Other' }}</span>
              <input
                ref="otherInput"
                v-model="otherText"
                type="text"
                placeholder="输入自定义答案..."
                @keydown.stop
                @keydown.enter.prevent="submit()"
                @keydown.esc.prevent="cancel()"
              />
            </label>

            <InteractionDetails v-if="activeRequest.kind === 'permission'" :input="activeRequest.input" />
          </div>

          <InteractionPreview v-if="hasPreview" :preview="optionPreview(focusedOption)" />
        </div>

        <footer class="interaction-dialog__footer">
          <button type="button" class="interaction-btn interaction-btn--ghost" @click="cancel">{{ cancelLabel }}</button>
          <button
            type="button"
            class="interaction-btn"
            :class="selectedOption?.danger ? 'interaction-btn--danger' : 'interaction-btn--primary'"
            :disabled="!canSubmit"
            @click="submit()"
          >
            {{ submitLabel }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.interaction-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.58);
}

.interaction-dialog {
  width: min(560px, 94vw);
  max-height: min(86vh, 760px);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--color-accent-strong) 35%, var(--color-border));
  border-radius: var(--radius-lg, 16px);
  background: var(--color-panel);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.46);
}

.interaction-dialog--wide {
  width: min(880px, 94vw);
}

.interaction-dialog__header {
  padding: 18px 22px 12px;
  border-bottom: 1px solid var(--color-border);
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 12%, transparent), transparent 72%);
}

.interaction-dialog__eyebrow {
  display: inline-flex;
  margin-bottom: 8px;
  color: var(--color-accent-strong);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.interaction-dialog__header h3 {
  margin: 0;
  font-size: 16px;
  line-height: 1.4;
}

.interaction-dialog__header p {
  margin: 8px 0 0;
  color: var(--color-text-muted);
  font-size: 13px;
  line-height: 1.55;
}

.interaction-dialog__body {
  display: grid;
  gap: 12px;
  max-height: calc(86vh - 150px);
  overflow: auto;
  padding: 16px 18px;
}

.interaction-dialog__body--preview {
  grid-template-columns: minmax(280px, 0.9fr) minmax(320px, 1.1fr);
  align-items: start;
}

.interaction-dialog__choices {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.interaction-other {
  display: grid;
  gap: 6px;
  padding: 12px;
  border: 1px dashed color-mix(in srgb, var(--color-accent-strong) 45%, var(--color-border));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-panel-soft));
}

.interaction-other span {
  color: var(--color-text-muted);
  font-size: 12px;
  font-weight: 750;
}

.interaction-other input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 9px 10px;
  background: rgba(0, 0, 0, 0.2);
  color: var(--color-text);
  font: inherit;
  outline: none;
}

.interaction-other input:focus {
  border-color: var(--color-accent-strong);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 18%, transparent);
}

.interaction-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 18px 18px;
}

.interaction-btn {
  border: 0;
  border-radius: var(--radius-md);
  padding: 8px 16px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 750;
  cursor: pointer;
}

.interaction-btn:active {
  transform: scale(0.96);
}

.interaction-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.interaction-btn--ghost {
  border: 1px solid var(--color-border);
  background: var(--color-panel-soft);
  color: var(--color-text);
}

.interaction-btn--primary {
  background: var(--color-accent);
  color: #07120d;
}

.interaction-btn--danger {
  background: var(--color-danger);
  color: #fff;
}

@media (max-width: 720px) {
  .interaction-dialog__body--preview {
    grid-template-columns: 1fr;
  }
}
</style>
