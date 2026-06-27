<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type {
  InteractionFormField,
  InteractionPromptOption,
  InteractionPromptPayload,
  InteractionPromptQuestion,
} from '../../../shared/types/ipc';
import InteractionDetails from './InteractionDetails.vue';
import InteractionOptionList from './InteractionOptionList.vue';
import InteractionPreview from './InteractionPreview.vue';
import { useSessionStore } from '../../stores/session-store';
import { useInteractionStore } from '../../stores/interaction-store';

const OTHER_OPTION_ID = '__other__';
const POSITION_KEY = 'claude-link:interaction-prompt-position';
const VIRTUAL_OPTION_THRESHOLD = 60;

type QuestionAnswer = { selectedOptionIds?: string[]; otherText?: string };
type HistoryEntry = {
  id: string;
  title: string;
  kind: InteractionPromptPayload['kind'];
  summary: string;
};

type OptionEntry = InteractionPromptOption & { originalIndex: number };

const interactionStore = useInteractionStore();
// V3-2：requests 改由 interaction-store 统一管理（远程 IPC + 本地 confirm 同一队列）。
// InteractionPrompt 只读 store.requests，UI 副作用（initSelection/restoreFocus）留本地。
const requests = computed<InteractionPromptPayload[]>(() => interactionStore.requests);
const focusedIndex = ref(0);
const selectedIds = ref<Set<string>>(new Set());
const otherText = ref('');
const searchText = ref('');
const wizardIndex = ref(0);
const questionAnswers = ref<Record<string, QuestionAnswer>>({});
const fieldValues = ref<Record<string, string | boolean>>({});
const history = ref<HistoryEntry[]>([]);
const showHistory = ref(false);
const submittingId = ref<string | null>(null);
const otherInput = ref<HTMLInputElement | HTMLTextAreaElement | null>(null);
const dialogRef = ref<HTMLElement | null>(null);
const position = ref(loadPosition());
let cleanupRequest: (() => void) | null = null;
let cleanupCancel: (() => void) | null = null;
let triggerEl: HTMLElement | null = null;
let dragging: { startX: number; startY: number; baseX: number; baseY: number } | null = null;

const activeRequest = computed(() => requests.value[0] ?? null);
const wizardQuestions = computed(() => activeRequest.value?.questions ?? []);
const activeQuestion = computed(() => wizardQuestions.value[wizardIndex.value] ?? null);
const isWizard = computed(() => wizardQuestions.value.length > 0);
const activeOptions = computed(() => activeQuestion.value?.options ?? activeRequest.value?.options ?? []);
const currentMultiSelect = computed(() => Boolean(activeQuestion.value?.multiSelect ?? activeRequest.value?.multiSelect));
const currentAllowOther = computed(() => Boolean(activeQuestion.value?.allowOther ?? activeRequest.value?.allowOther ?? activeOptions.value.some((option) => option.id === OTHER_OPTION_ID)));
const selectedIdList = computed(() => Array.from(selectedIds.value));
const filteredOptionEntries = computed<OptionEntry[]>(() => {
  const needle = searchText.value.trim().toLowerCase();
  return activeOptions.value
    .map((option, originalIndex) => ({ ...option, originalIndex }))
    .filter((option) => {
      if (!needle) return true;
      return option.label.toLowerCase().includes(needle) || option.description?.toLowerCase().includes(needle);
    });
});
const filteredOptions = computed<InteractionPromptOption[]>(() => filteredOptionEntries.value.map(({ originalIndex: _originalIndex, ...option }) => option));
const useVirtualOptions = computed(() => activeOptions.value.length >= VIRTUAL_OPTION_THRESHOLD);
const focusedEntry = computed(() => filteredOptionEntries.value[focusedIndex.value] ?? null);
const focusedOption = computed(() => focusedEntry.value ?? null);
const selectedOption = computed(() => {
  const [id] = selectedIdList.value;
  return activeOptions.value.find((option) => option.id === id) ?? null;
});
const visibleOptionIds = computed(() => filteredOptionEntries.value.map((option) => option.id));
const visibleSelectedIds = computed(() => selectedIdList.value.filter((id) => visibleOptionIds.value.includes(id)));
const selectedVisibleIndex = computed(() => {
  const firstVisibleSelectedId = visibleSelectedIds.value[0];
  if (!firstVisibleSelectedId) return -1;
  return filteredOptionEntries.value.findIndex((option) => option.id === firstVisibleSelectedId);
});
const showOtherInput = computed(() => selectedIds.value.has(OTHER_OPTION_ID));
const hasPreview = computed(() => activeOptions.value.some((option) => Boolean(option.preview)));
const formFields = computed(() => activeRequest.value?.fields ?? []);
const hasStructuredForm = computed(() => Boolean(activeRequest.value?.kind === 'form' && formFields.value.length));
const hasTextInput = computed(() => activeRequest.value?.kind === 'text' || activeRequest.value?.kind === 'long-text');
const eyebrow = computed(() => {
  if (activeRequest.value?.kind === 'permission') return 'Claude Code 需要确认';
  if (isWizard.value) return `Claude Code 需要你选择 · ${wizardIndex.value + 1}/${wizardQuestions.value.length}`;
  if (activeRequest.value?.kind === 'multi-choice') return 'Claude Code 需要你多选';
  if (activeRequest.value?.kind === 'text' || activeRequest.value?.kind === 'long-text') return 'Claude Code 需要你输入';
  if (activeRequest.value?.kind === 'form') return 'Claude Code 需要参数';
  return 'Claude Code 需要你选择';
});
const currentTitle = computed(() => activeQuestion.value?.title ?? activeRequest.value?.title ?? 'Claude Code 需要你选择');
const currentDescription = computed(() => activeQuestion.value?.description ?? activeRequest.value?.description);
const submitLabel = computed(() => {
  if (isWizard.value && wizardIndex.value < wizardQuestions.value.length - 1) return '下一题';
  if (activeRequest.value?.kind === 'permission') return selectedOption.value?.label ?? '提交选择';
  if (activeRequest.value?.kind === 'multi-choice') return '提交选择';
  return '确认';
});
const cancelLabel = computed(() => activeRequest.value?.kind === 'permission' ? '拒绝' : '取消');
const canSubmit = computed(() => {
  const request = activeRequest.value;
  if (!request || submittingId.value === request.id) return false;
  if (hasStructuredForm.value) return formFields.value.every((field) => !field.required || Boolean(fieldValues.value[field.id]));
  if (hasTextInput.value) return otherText.value.trim().length > 0;
  if (showOtherInput.value) return otherText.value.trim().length > 0;
  return selectedIds.value.size > 0 || request.kind === 'confirm';
});

function loadPosition(): { x: number; y: number } {
  try {
    const raw = window.localStorage.getItem(POSITION_KEY);
    if (!raw) return { x: 0, y: 0 };
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    return {
      x: typeof parsed.x === 'number' ? parsed.x : 0,
      y: typeof parsed.y === 'number' ? parsed.y : 0,
    };
  } catch {
    return { x: 0, y: 0 };
  }
}

function savePosition(): void {
  window.localStorage.setItem(POSITION_KEY, JSON.stringify(position.value));
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || Boolean((target as HTMLElement | null)?.isContentEditable);
}

function syncFocusedSelection(): void {
  if (currentMultiSelect.value) return;
  const selectedIndex = selectedVisibleIndex.value;
  if (selectedIndex >= 0) focusedIndex.value = selectedIndex;
}

function applyAnswer(answer?: QuestionAnswer): void {
  selectedIds.value = new Set(answer?.selectedOptionIds ?? []);
  otherText.value = answer?.otherText ?? '';
  syncFocusedSelection();
}

function initFields(request: InteractionPromptPayload): void {
  fieldValues.value = {};
  for (const field of request.fields ?? []) {
    fieldValues.value[field.id] = field.defaultValue ?? (field.type === 'checkbox' ? false : '');
  }
}

function initSelection(request: InteractionPromptPayload): void {
  wizardIndex.value = 0;
  questionAnswers.value = {};
  searchText.value = '';
  focusedIndex.value = 0;
  initFields(request);
  const firstQuestion = request.questions?.[0];
  if (firstQuestion) {
    selectedIds.value = optionDefaults(firstQuestion.options, firstQuestion.defaultOptionIds, firstQuestion.multiSelect);
  } else {
    selectedIds.value = optionDefaults(request.options ?? [], request.defaultOptionIds, request.multiSelect);
  }
  otherText.value = '';
  syncFocusedSelection();
  void nextTick(focusDialogStart);
}

function enqueue(request: InteractionPromptPayload): void {
  const wasEmpty = requests.value.length === 0;
  const enqueued = interactionStore.enqueueRemote(request);
  // 去重跳过（二次入队同 id）时不重置 UI，避免清空用户正在填的选择/表单。
  if (!enqueued) return;
  if (wasEmpty || requests.value[0]?.id === request.id) {
    triggerEl = document.activeElement as HTMLElement | null;
    initSelection(request);
  }
}

function restoreFocus(): void {
  void nextTick(() => {
    if (triggerEl && document.contains(triggerEl) && typeof triggerEl.focus === 'function') {
      triggerEl.focus();
    }
    triggerEl = null;
  });
}

// V3-2：队列前进的 UI 副作用。数据移除已在 store.respondAndRemove 完成，
// 这里只负责初始化下一个请求的选择态或归还焦点。
function advanceQueueUI(): void {
  const next = requests.value[0];
  if (next) initSelection(next);
  else restoreFocus();
}

function updateSelected(next: Set<string>): void {
  selectedIds.value = next;
  if (!next.has(OTHER_OPTION_ID)) otherText.value = '';
}

function focusOption(index: number): void {
  if (!filteredOptionEntries.value.length) return;
  focusedIndex.value = Math.max(0, Math.min(index, filteredOptionEntries.value.length - 1));
}

function toggleOption(optionId: string): void {
  const request = activeRequest.value;
  if (!request) return;
  const optionIndex = filteredOptionEntries.value.findIndex((option) => option.id === optionId);
  if (optionIndex >= 0) focusOption(optionIndex);

  if (currentMultiSelect.value) {
    const next = new Set(selectedIds.value);
    if (next.has(optionId)) next.delete(optionId);
    else next.add(optionId);
    updateSelected(next);
    return;
  }

  updateSelected(new Set([optionId]));
}

function persistCurrentQuestionAnswer(): boolean {
  const id = currentQuestionId();
  if (!id) return true;
  if (selectedIds.value.has(OTHER_OPTION_ID) && !otherText.value.trim()) return false;
  questionAnswers.value = {
    ...questionAnswers.value,
    [id]: {
      selectedOptionIds: Array.from(selectedIds.value),
      otherText: otherText.value.trim() || undefined,
    },
  };
  return true;
}

function loadWizardStep(index: number): void {
  const question = wizardQuestions.value[index];
  if (!question) return;
  wizardIndex.value = index;
  searchText.value = '';
  focusedIndex.value = 0;
  const stored = questionAnswers.value[question.id];
  if (stored) applyAnswer(stored);
  else {
    selectedIds.value = optionDefaults(question.options, question.defaultOptionIds, question.multiSelect);
    otherText.value = '';
  }
  syncFocusedSelection();
}

function buildSummary(request: InteractionPromptPayload, ids: string[]): string {
  if (request.fields?.length) {
    return request.fields.map((field) => `${field.label}: ${String(fieldValues.value[field.id] ?? '')}`).join(' · ');
  }
  if (request.questions?.length) {
    return Object.values(questionAnswers.value)
      .map((answer) => [...(answer.selectedOptionIds ?? []), answer.otherText].filter(Boolean).join(','))
      .filter(Boolean)
      .join(' / ');
  }
  if (otherText.value.trim()) return otherText.value.trim();
  return ids.map((id) => activeOptions.value.find((option) => option.id === id)?.label ?? id).join(', ');
}

function pushHistory(request: InteractionPromptPayload, action: 'submit' | 'cancel', ids: string[]): void {
  const summary = action === 'cancel' ? '已取消' : buildSummary(request, ids);
  history.value = [{
    id: request.id,
    title: request.title,
    kind: request.kind,
    summary,
  }, ...history.value].slice(0, 8);
  // V3-3：落库持久化，切换会话/重启后仍可在"交互历史"区回看。失败静默不影响交互主流程。
  // V3-2：本地 confirm 的 sessionId 为空，不落库（无对应 session 外键）。
  if (request.sessionId) {
    void window.claudeLink.recordInteractionHistory({
      sessionId: request.sessionId,
      title: request.title,
      kind: request.kind,
      summary,
      action,
    }).catch(() => { /* 静默：落库失败不阻塞交互 */ });
  }
}

async function submit(optionId?: string): Promise<void> {
  const request = activeRequest.value;
  if (!request || submittingId.value === request.id) return;
  if (optionId) toggleOption(optionId);
  const ids = optionId && !currentMultiSelect.value ? [optionId] : Array.from(selectedIds.value);
  if (!ids.length && !hasStructuredForm.value && !hasTextInput.value && request.kind !== 'confirm') return;
  if (ids.includes(OTHER_OPTION_ID) && !otherText.value.trim()) {
    await nextTick();
    otherInput.value?.focus();
    return;
  }
  if (hasTextInput.value && !otherText.value.trim()) {
    await nextTick();
    otherInput.value?.focus();
    return;
  }
  if (isWizard.value) {
    if (!persistCurrentQuestionAnswer()) {
      await nextTick();
      otherInput.value?.focus();
      return;
    }
    if (wizardIndex.value < wizardQuestions.value.length - 1) {
      loadWizardStep(wizardIndex.value + 1);
      return;
    }
  }

  submittingId.value = request.id;
  try {
    await interactionStore.respondAndRemove({
      id: request.id,
      action: 'submit',
      selectedOptionIds: isWizard.value ? undefined : ids,
      questionAnswers: isWizard.value ? questionAnswers.value : undefined,
      fieldValues: hasStructuredForm.value ? fieldValues.value : undefined,
      otherText: otherText.value.trim() || undefined,
    });
    pushHistory(request, 'submit', ids);
    advanceQueueUI();
  } catch (err) {
    // IPC 失败：请求已被 respondAndRemove 的 finally 移除，这里复位 UI 让用户能继续操作。
    console.error('Interaction submit failed', err);
    advanceQueueUI();
  } finally {
    submittingId.value = null;
  }
}

async function cancel(): Promise<void> {
  const request = activeRequest.value;
  if (!request || submittingId.value === request.id) return;
  submittingId.value = request.id;
  try {
    await interactionStore.respondAndRemove({ id: request.id, action: 'cancel' });
    pushHistory(request, 'cancel', []);
    advanceQueueUI();
  } catch (err) {
    console.error('Interaction cancel failed', err);
    advanceQueueUI();
  } finally {
    submittingId.value = null;
  }
}

function move(delta: number): void {
  if (!filteredOptionEntries.value.length) return;
  const nextIndex = (focusedIndex.value + delta + filteredOptionEntries.value.length) % filteredOptionEntries.value.length;
  focusOption(nextIndex);
  const nextOption = filteredOptionEntries.value[nextIndex];
  if (!currentMultiSelect.value && nextOption) {
    updateSelected(new Set([nextOption.id]));
  }
}

function focusDialogStart(): void {
  const first = dialogRef.value?.querySelector<HTMLElement>('[data-dialog-initial-focus]');
  first?.focus();
}

function trapTab(event: KeyboardEvent): void {
  const dialog = dialogRef.value;
  if (!dialog) return;
  const focusables = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'));
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (!activeRequest.value) return;
  if (isTextEntryTarget(event.target)) return;
  if (event.key === 'Tab') {
    trapTab(event);
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    move(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    move(-1);
  } else if (event.key === 'Enter' && document.activeElement !== otherInput.value) {
    event.preventDefault();
    void submit();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    // alert 模式（kind:'confirm' 且只有 confirm 一个选项）Esc 视为"知道了"→提交确定，
    // 与原 ConfirmDialog 的 alert 行为一致；其余 confirm/选择题 Esc→取消。
    const isAlert = activeRequest.value.kind === 'confirm'
      && activeRequest.value.options?.length === 1
      && activeRequest.value.options[0]?.id === 'confirm';
    if (isAlert) void submit('confirm');
    else void cancel();
  } else if (event.key === ' ' && currentMultiSelect.value && document.activeElement !== otherInput.value) {
    event.preventDefault();
    const option = focusedOption.value;
    if (option) toggleOption(option.id);
  }
}

function optionPreview(option: InteractionPromptOption | null) {
  return option?.preview;
}

function removeRequest(id: string): void {
  interactionStore.removeRequest(id);
  if (submittingId.value === id) submittingId.value = null;
  const next = requests.value[0];
  if (next) initSelection(next);
}

function previousQuestion(): void {
  if (wizardIndex.value <= 0) return;
  void persistCurrentQuestionAnswer();
  loadWizardStep(wizardIndex.value - 1);
}

function onDragStart(event: PointerEvent): void {
  if (event.button !== 0) return;
  dragging = { startX: event.clientX, startY: event.clientY, baseX: position.value.x, baseY: position.value.y };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd, { once: true });
}

function onDragMove(event: PointerEvent): void {
  if (!dragging) return;
  position.value = {
    x: Math.max(-320, Math.min(320, dragging.baseX + event.clientX - dragging.startX)),
    y: Math.max(-220, Math.min(220, dragging.baseY + event.clientY - dragging.startY)),
  };
}

function onDragEnd(): void {
  dragging = null;
  window.removeEventListener('pointermove', onDragMove);
  savePosition();
}

function resetPosition(): void {
  position.value = { x: 0, y: 0 };
  savePosition();
}

cleanupRequest = window.claudeLink.onInteractionRequest(enqueue);
cleanupCancel = window.claudeLink.onInteractionCancel(({ id }) => removeRequest(id));
void window.claudeLink.getPendingInteractions().then((pending) => {
  for (const request of pending) enqueue(request);
});
window.addEventListener('keydown', handleKeydown);

// V3-3：交互历史持久化——跟随当前会话加载历史，切换会话时刷新。
// 用自增 token 防竞态：快速切会话 A→B 时，若 A 的 IPC 响应晚于 B 返回，
// token 不匹配则丢弃，避免 B 的历史被 A 覆盖。
const sessionStore = useSessionStore();
let historyLoadToken = 0;
async function loadHistory(sessionId: string | null): Promise<void> {
  const token = ++historyLoadToken;
  if (!sessionId) {
    if (token === historyLoadToken) history.value = [];
    return;
  }
  try {
    const entries = await window.claudeLink.getInteractionHistory(sessionId);
    if (token !== historyLoadToken) return; // 已有更新的请求，丢弃过期结果
    history.value = entries.map((e) => ({
      id: e.id,
      title: e.title,
      kind: e.kind as InteractionPromptPayload['kind'],
      summary: e.summary ?? '',
    }));
  } catch {
    if (token === historyLoadToken) {
      // 静默：加载失败保留空历史，不阻塞交互
    }
  }
}
watch(() => sessionStore.activeSession?.id ?? null, (id) => { void loadHistory(id); }, { immediate: true });

watch(filteredOptionEntries, (entries) => {
  if (!entries.length) {
    focusedIndex.value = 0;
    return;
  }
  if (focusedIndex.value >= entries.length) {
    focusedIndex.value = entries.length - 1;
  }
  if (focusedIndex.value < 0) {
    focusedIndex.value = 0;
  }
}, { immediate: true });

watch(searchText, () => {
  focusedIndex.value = 0;
});

onBeforeUnmount(() => {
  cleanupRequest?.();
  cleanupCancel?.();
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('pointermove', onDragMove);
  // V3-2：清理 pending 本地请求（requestConfirm），避免 Promise 永挂。
  interactionStore.cleanupLocalRequests();
});
</script>

<template>
  <Teleport to="body">
    <div v-if="activeRequest" class="interaction-overlay">
      <section
        ref="dialogRef"
        class="interaction-dialog"
        :class="{ 'interaction-dialog--wide': hasPreview }"
        role="dialog"
        aria-modal="true"
        :aria-label="activeRequest.title"
        :style="{ transform: `translate(${position.x}px, ${position.y}px)` }"
      >
        <header class="interaction-dialog__header" @pointerdown="onDragStart" @dblclick="resetPosition">
          <span class="interaction-dialog__eyebrow">{{ eyebrow }}</span>
          <h3>{{ currentTitle }}</h3>
          <p v-if="currentDescription">{{ currentDescription }}</p>
          <div v-if="isWizard" class="interaction-steps" aria-label="问题进度">
            <span
              v-for="(question, index) in wizardQuestions"
              :key="question.id"
              class="interaction-step"
              :class="{ 'interaction-step--active': index === wizardIndex, 'interaction-step--done': index < wizardIndex }"
            >{{ index + 1 }}</span>
          </div>
        </header>

        <div class="interaction-dialog__body" :class="{ 'interaction-dialog__body--preview': hasPreview }">
          <div class="interaction-dialog__choices">
            <label v-if="activeOptions.length > 8" class="interaction-search">
              <span>过滤选项</span>
              <input v-model="searchText" data-dialog-initial-focus type="search" placeholder="输入关键词..." @keydown.stop @keydown.esc.prevent="cancel" />
            </label>

            <InteractionOptionList
              v-if="filteredOptions.length"
              :options="filteredOptions"
              :focused-index="focusedIndex"
              :selected-ids="selectedIdList"
              :multi-select="currentMultiSelect"
              :virtual="useVirtualOptions"
              @focus="focusOption"
              @toggle="toggleOption"
              @submit="submit"
            />
            <div v-else-if="activeOptions.length" class="interaction-empty">没有匹配的选项</div>

            <div v-if="hasStructuredForm" class="interaction-form">
              <label v-for="field in formFields" :key="field.id" class="interaction-field">
                <span>{{ field.label }}<b v-if="field.required">*</b></span>
                <textarea
                  v-if="field.type === 'textarea'"
                  v-model="fieldValues[field.id] as string"
                  :placeholder="field.placeholder"
                  rows="5"
                  @keydown.stop
                  @keydown.esc.prevent="cancel"
                />
                <select v-else-if="field.type === 'select'" v-model="fieldValues[field.id] as string">
                  <option v-for="option in field.options" :key="option.id" :value="option.id">{{ option.label }}</option>
                </select>
                <input v-else-if="field.type === 'checkbox'" v-model="fieldValues[field.id]" type="checkbox" />
                <input v-else v-model="fieldValues[field.id] as string" :placeholder="field.placeholder" type="text" @keydown.stop @keydown.esc.prevent="cancel" />
              </label>
            </div>

            <label v-if="showOtherInput || hasTextInput" class="interaction-other">
              <span>{{ hasTextInput ? '输入内容' : activeQuestion?.otherLabel ?? activeRequest.otherLabel ?? 'Other' }}</span>
              <textarea
                v-if="activeRequest.kind === 'long-text'"
                ref="otherInput"
                v-model="otherText"
                rows="6"
                placeholder="输入内容..."
                @keydown.stop
                @keydown.enter.ctrl.prevent="submit()"
                @keydown.esc.prevent="cancel()"
              />
              <input
                v-else
                ref="otherInput"
                v-model="otherText"
                type="text"
                placeholder="输入自定义答案..."
                @keydown.stop
                @keydown.enter.prevent="submit()"
                @keydown.esc.prevent="cancel()"
              />
            </label>

            <details v-if="history.length" class="interaction-history" :open="showHistory" @toggle="showHistory = ($event.target as HTMLDetailsElement).open">
              <summary>交互历史（{{ history.length }}）</summary>
              <ol>
                <li v-for="item in history" :key="item.id">
                  <strong>{{ item.title }}</strong>
                  <small>{{ item.kind }} · {{ item.summary || '无内容' }}</small>
                </li>
              </ol>
            </details>

            <InteractionDetails v-if="activeRequest.kind === 'permission'" :input="activeRequest.input" />
          </div>

          <InteractionPreview v-if="hasPreview" :preview="optionPreview(focusedOption)" />
        </div>

        <footer class="interaction-dialog__footer">
          <button v-if="isWizard && wizardIndex > 0" type="button" class="interaction-btn interaction-btn--ghost" @click="previousQuestion">上一步</button>
          <button type="button" class="interaction-btn interaction-btn--ghost" @click="cancel">{{ cancelLabel }}</button>
          <button
            type="button"
            class="interaction-btn"
            :class="selectedOption?.danger ? 'interaction-btn--danger' : 'interaction-btn--primary'"
            :disabled="!canSubmit"
            data-dialog-initial-focus
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
  z-index: var(--interaction-z-index);
  display: grid;
  place-items: center;
  padding: 20px;
  background: var(--interaction-overlay-bg);
}

.interaction-dialog {
  width: var(--interaction-panel-width);
  max-height: min(86vh, 760px);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--color-accent-strong) 35%, var(--color-border));
  border-radius: var(--interaction-panel-radius);
  background: var(--color-panel);
  box-shadow: var(--interaction-shadow);
}

.interaction-dialog--wide {
  width: var(--interaction-panel-width-wide);
}

.interaction-dialog__header {
  user-select: none;
  cursor: move;
  padding: var(--interaction-header-pad);
  border-bottom: 1px solid var(--color-border);
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 12%, transparent), transparent 72%);
}

.interaction-dialog__eyebrow {
  display: inline-flex;
  margin-bottom: 8px;
  color: var(--color-accent-strong);
  font-size: 0.6875rem;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.interaction-dialog__header h3 {
  margin: 0;
  font-size: 1rem;
  line-height: 1.4;
}

.interaction-dialog__header p {
  margin: 8px 0 0;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  line-height: 1.55;
}

.interaction-steps {
  display: flex;
  gap: 6px;
  margin-top: 12px;
}

.interaction-step {
  display: grid;
  width: 20px;
  height: 20px;
  place-items: center;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-text-muted);
  font-size: 0.6875rem;
  font-weight: 800;
}

.interaction-step--active,
.interaction-step--done {
  border-color: var(--color-accent-strong);
  background: color-mix(in srgb, var(--color-accent) 20%, transparent);
  color: var(--color-text);
}

.interaction-dialog__body {
  display: grid;
  gap: 12px;
  max-height: calc(86vh - 150px);
  overflow: auto;
  padding: var(--interaction-body-pad);
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

.interaction-search,
.interaction-other,
.interaction-field {
  display: grid;
  gap: 6px;
  padding: 12px;
  border: 1px dashed color-mix(in srgb, var(--color-accent-strong) 45%, var(--color-border));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-panel-soft));
}

.interaction-search span,
.interaction-other span,
.interaction-field span {
  color: var(--color-text-muted);
  font-size: 0.75rem;
  font-weight: 750;
}

.interaction-field b {
  color: var(--color-danger);
  margin-left: 3px;
}

.interaction-search input,
.interaction-other input,
.interaction-other textarea,
.interaction-field input[type='text'],
.interaction-field textarea,
.interaction-field select {
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

.interaction-other textarea,
.interaction-field textarea {
  resize: vertical;
}

.interaction-search input:focus,
.interaction-other input:focus,
.interaction-other textarea:focus,
.interaction-field input:focus,
.interaction-field textarea:focus,
.interaction-field select:focus {
  border-color: var(--color-accent-strong);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 18%, transparent);
}

.interaction-empty {
  padding: 18px 12px;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-muted);
  font-size: 0.75rem;
  text-align: center;
}

.interaction-history {
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

.interaction-history summary {
  cursor: pointer;
}

.interaction-history ol {
  display: grid;
  gap: 8px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.interaction-history li {
  display: grid;
  gap: 2px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--interaction-history-bg);
}

.interaction-history strong {
  color: var(--color-text);
  font-size: 0.75rem;
}

.interaction-history small {
  line-height: 1.45;
}

.interaction-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: var(--interaction-footer-pad);
}

.interaction-btn {
  border: 0;
  border-radius: var(--interaction-btn-radius);
  padding: var(--interaction-btn-pad);
  font-family: inherit;
  font-size: 0.8125rem;
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
