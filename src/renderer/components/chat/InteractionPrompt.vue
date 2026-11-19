<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ESC_LAYER_PRIORITY, pushEscLayer, type EscLayerHandle } from '../../composables/use-esc-stack';
import { useDialogShell } from '../../composables/use-dialog-shell';
import type {
  InteractionPromptOption,
  InteractionPromptPayload,
  InteractionPromptQuestion,
} from '../../../shared/types/ipc';
import InteractionDetails from './InteractionDetails.vue';
import InteractionOptionList from './InteractionOptionList.vue';
import InteractionPreview from './InteractionPreview.vue';
import DialogResizeHandles from '../common/DialogResizeHandles.vue';
import { useSessionStore } from '../../stores/session-store';
import { useInteractionStore } from '../../stores/interaction-store';

const OTHER_OPTION_ID = '__other__';
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
// 启动白屏 hotfix（2026-09-13）：sessionStore 声明必须置于 currentRequests 之前——
// hb12-PERM-04 时期 draftCache watch 源含 activeRequest，setup 期求值 getter 链式触达
// currentRequests → sessionStore；若声明留在文件底部（V3-3 历史加载区），TDZ ReferenceError
// 会在 app.mount 期未捕获抛出 → 整树挂载失败 → 白屏。hb13-v A8 后 watch 源已改为仅草稿字段
//（见下方 A8 注记），此声明顺序作为防御保留。
const sessionStore = useSessionStore();
// V3-2：requests 改由 interaction-store 统一管理（远程 IPC + 本地 confirm 同一队列）。
// InteractionPrompt 只读 store.requests，UI 副作用（initSelection/restoreFocus）留本地。
const requests = computed<InteractionPromptPayload[]>(() => interactionStore.requests);
// 交互队列按会话过滤：只显示当前 activeSession 的请求（本地 confirm 的 sessionId='' 视为当前）。
// 防串扰——会话 A 思考时发起的交互不会在会话 B 的界面上弹出，避免「在 B 操作了 A 的弹窗、
// 提交结果回到 A、B 永远轮不到」。
const currentRequests = computed<InteractionPromptPayload[]>(() => {
  const sid = sessionStore.activeSession?.id;
  // 无活动会话时只显示本地 confirm（sessionId=''），不显示任何远程交互——
  // 避免删除 activeSession 时它短暂为 null，别的会话的远程交互冒泡成新弹窗（用户以为"没删又弹窗"）。
  if (!sid) return requests.value.filter((r) => !r.sessionId);
  return requests.value.filter((r) => !r.sessionId || r.sessionId === sid);
});
const focusedIndex = ref(0);
const selectedIds = ref<Set<string>>(new Set());
const otherText = ref('');
const searchText = ref('');
const wizardIndex = ref(0);
// C1 变体 2「左侧题号导航栏」（2026-11-15 用户拍板）wizard 态专属状态：
//  - wizardFlaggedIndex：提交校验（未答齐）命中的左栏红色警示描边题号（瞬态，initSelection 重置）；
//  - discardConfirmVisible / discardCounts：丢弃保护二次确认层（契约 6）——取消/X/Esc（非输入焦点）
//    在有任一作答时先确认再丢弃；
//  - wizardOtherExpanded：Other 行内输入展开态（点击 __other__ 仅展开+聚焦、不写入账本——空文本
//    Other 不得被 isQuestionAnswered 记成已答）。
const wizardFlaggedIndex = ref<number | null>(null);
const discardConfirmVisible = ref(false);
const discardCounts = ref(0);
const wizardOtherExpanded = ref(false);
const wizardOtherInput = ref<HTMLInputElement | null>(null);
const questionAnswers = ref<Record<string, QuestionAnswer>>({});
const fieldValues = ref<Record<string, string | boolean>>({});
// P3-8：已交互过的 checkbox 字段 id（change 事件登记）；required checkbox 据此放行 false 答案。
const touchedCheckboxFields = ref<Set<string>>(new Set());
const history = ref<HistoryEntry[]>([]);
const showHistory = ref(false);
const submittingId = ref<string | null>(null);
// UI13-P6 双击/连点防重：直提短窗时间戳——submittingId 在 finally 清零（IPC 回包可能先于双击
// 第二击），01 边界值「第一次 click 已提交关窗，第二次落空」的完整兑现靠本短窗兜住
//（向导中途前进路径不置 submittingId、换请求换单后第二击落在新请求上下文，同理）。
let lastDirectSubmitAt = 0;
// hb10-PERM-03：IPC 失败提示（请求留队可重试；成功提交/取消后清除）。
const submitError = ref<string | null>(null);
const otherInput = ref<HTMLInputElement | HTMLTextAreaElement | null>(null);
const dialogRef = ref<HTMLElement | null>(null);
let cleanupRequest: (() => void) | null = null;
let cleanupCancel: (() => void) | null = null;
let triggerEl: HTMLElement | null = null;

const activeRequest = computed(() => currentRequests.value[0] ?? null);
// ── 弹窗壳（P7：标题栏拖动 / 8 向缩放 / 双击复位居中）——替换原手写拖动块（transform 偏移 +
// ±320/±220 clamp），拖动范围扩展为全视口。无 initialSize → 打开时测卡片自然尺寸（CSS var 宽度
// 35rem/wide 57.5rem/narrow 24rem + 内容自然高）；visible false→true 边沿自动重置居中（新请求
// 不继承上一单拖放位置）；队列换单（A→B 直切无 null 帧）按计划 P7 文本 resetToCenter 重置居中
// ——FilePicker 队列换单仍保留几何（P5 语义不变），仅本组件按 P7 重置。
const shell = useDialogShell(computed(() => !!activeRequest.value), dialogRef, { minW: 340, minH: 240 });
const shellStyle = shell.style; // ComputedRef 须解包为 script 顶层（P4 使用方规范，模板自动解包）
const wizardQuestions = computed(() => activeRequest.value?.questions ?? []);
const activeQuestion = computed(() => wizardQuestions.value[wizardIndex.value] ?? null);
const isWizard = computed(() => wizardQuestions.value.length > 0);
const activeOptions = computed(() => activeQuestion.value?.options ?? activeRequest.value?.options ?? []);
const currentMultiSelect = computed(() => Boolean(activeQuestion.value?.multiSelect ?? activeRequest.value?.multiSelect));
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
  // C1 变体 2：wizard 态 eyebrow 恒显总题数（题号位置移入右栏 count 行与头部进度 chip）。
  if (isWizard.value) return `Claude Code 需要你回答 ${wizardQuestions.value.length} 个问题`;
  if (activeRequest.value?.kind === 'multi-choice') return 'Claude Code 需要你多选';
  if (activeRequest.value?.kind === 'text' || activeRequest.value?.kind === 'long-text') return 'Claude Code 需要你输入';
  if (activeRequest.value?.kind === 'form') return 'Claude Code 需要参数';
  return 'Claude Code 需要你选择';
});
// C1 变体 2：wizard 态 h3=payload.title（题干移入右栏 wizard-qtext）；非 wizard 维持原逻辑。
const currentTitle = computed(() => {
  if (isWizard.value) return activeRequest.value?.title ?? 'Claude Code 需要你选择';
  return activeQuestion.value?.title ?? activeRequest.value?.title ?? 'Claude Code 需要你选择';
});
const currentDescription = computed(() => {
  if (isWizard.value) return activeRequest.value?.description;
  return activeQuestion.value?.description ?? activeRequest.value?.description;
});
const submitLabel = computed(() => {
  if (isWizard.value && wizardIndex.value < wizardQuestions.value.length - 1) return '下一题';   // UI13-P6：仅 multiSelect 当前题可见（主按钮 v-if=showFooterPrimary）
  if (isWizard.value) return '确认';
  if (activeRequest.value?.kind === 'permission') return selectedOption.value?.label ?? '提交选择';
  if (activeRequest.value?.kind === 'multi-choice') return '提交选择';
  return '确认';
});
// UI13-P6 直选直提后无需主按钮的形态：非向导单选题（未激活 Other）、向导当前单选题（未激活 Other）
// ——单选单击即答，footer 无提交钮；Other 激活时保留「确认」（文本非空守卫在 canSubmit）。
const showFooterPrimary = computed(() => {
  if (hasStructuredForm.value || hasTextInput.value) return true;
  if (activeRequest.value?.kind === 'permission' || activeRequest.value?.kind === 'confirm') return true;
  if (currentMultiSelect.value) return true;              // 多选（含向导 multiSelect 题与 kind multi-choice）
  return showOtherInput.value;                            // 单选激活 Other → 「确认」提交
});
const cancelLabel = computed(() => activeRequest.value?.kind === 'permission' ? '拒绝' : '取消');
const canSubmit = computed(() => {
  const request = activeRequest.value;
  if (!request || submittingId.value === request.id) return false;
  if (hasStructuredForm.value) {
    // P3-8：required checkbox 按「已交互过」判定（false 亦是有效答案）；其余字段维持判空。
    return formFields.value.every((field) => {
      if (!field.required) return true;
      if (field.type === 'checkbox') return touchedCheckboxFields.value.has(field.id);
      return Boolean(fieldValues.value[field.id]);
    });
  }
  if (hasTextInput.value) return otherText.value.trim().length > 0;
  if (showOtherInput.value) return otherText.value.trim().length > 0;
  return selectedIds.value.size > 0 || request.kind === 'confirm';
});

// C1 变体 2（契约 3/4）：wizard 已答数与任一作答门——判据 isQuestionAnswered（多选空数组/空
// Other 文本=未答）；非 wizard 形态恒 0/false（不参与 wizard 提交与丢弃保护面）。
const answeredCount = computed(() => wizardQuestions.value.filter((question) => isQuestionAnswered(questionAnswers.value[question.id])).length);
const hasAnyAnswer = computed(() => answeredCount.value > 0);
// wizard footer 主按钮 label（契约 4）：非最后题=「下一题」恒可点；最后题=答齐「提交」/未答齐
// 「提交（N/M）」（点击走 submitWizard 跳转首个未答题+左栏警示）。
const wizardPrimaryLabel = computed(() => {
  if (wizardIndex.value < wizardQuestions.value.length - 1) return '下一题';
  return answeredCount.value === wizardQuestions.value.length
    ? '提交'
    : `提交（${answeredCount.value}/${wizardQuestions.value.length}）`;
});
// 变体 2 右栏渲染派生：当前题答案账本条目 / 选中集（InteractionOptionList selected-ids）/ Other
// 展开门（__other__ 选中或已有文本，或刚点击 __other__ 尚未输入的瞬态展开）。
const wizardAnswer = computed(() => (activeQuestion.value ? questionAnswers.value[activeQuestion.value.id] : undefined));
const wizardSelectedIds = computed(() => wizardAnswer.value?.selectedOptionIds ?? []);
const wizardShowOther = computed(() => {
  if (!activeQuestion.value) return false;
  return wizardOtherExpanded.value
    || wizardSelectedIds.value.includes(OTHER_OPTION_ID)
    || Boolean(wizardAnswer.value?.otherText?.trim());
});
const wizardOtherText = computed(() => wizardAnswer.value?.otherText ?? '');

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

function initFields(request: InteractionPromptPayload): void {
  fieldValues.value = {};
  // P3-8：required checkbox 的「已交互」登记表——checkbox 默认 false 是合法答案，
  // Boolean(value) 判空会让用户无法提交 false；改按「是否交互过」判定。
  touchedCheckboxFields.value = new Set();
  for (const field of request.fields ?? []) {
    fieldValues.value[field.id] = field.defaultValue ?? (field.type === 'checkbox' ? false : '');
  }
}

// 计算请求/当前问题的默认选中选项集合：
// - 请求方提供 defaultOptionIds 时，取其中在 options 里存在的；
// - 无显式默认则返回空集，由用户主动选择（避免预选导致回车误提交，尤其 permission 类）。
// multiSelect 保留以匹配调用签名，当前不影响默认值（多选本来就不该预选）。
function optionDefaults(
  options: ReadonlyArray<InteractionPromptOption>,
  defaultOptionIds: string[] | undefined,
  multiSelect: boolean | undefined,
): Set<string> {
  void multiSelect;
  const result = new Set<string>();
  const validIds = new Set(options.map((o) => o.id));
  if (defaultOptionIds) {
    for (const id of defaultOptionIds) {
      if (validIds.has(id)) result.add(id);
    }
  }
  return result;
}

// hb12-PERM-04：按 request.id 缓存草稿（表单切换/临时切走后恢复用户已填内容）。
const draftCache = new Map<string, { selectedIds: Set<string>; otherText: string; wizardIndex: number; questionAnswers: Record<string, QuestionAnswer>; fieldValues: Record<string, string | boolean> }>();

function initSelection(request: InteractionPromptPayload): void {
  // hb13-v B9：新请求初始化即清除上次提交失败提示（错误只属于触发它的那一次提交）。
  submitError.value = null;
  // hb13-v A8：入口先刷新「正在展示的请求 id」，再做任何选择态变更——保证草稿 watch flush
  // 时把当前状态写回自身 id（A→B 换位时不得把 A 的状态写进 B 的草稿）。
  displayedRequestId = request.id;
  const cached = draftCache.get(request.id);
  if (cached) {
    // 恢复草稿（不重置 focus 到起点——用户已在填写中）。wizardIndex 一并恢复
    //（C-W1：切走再切回停留在离开时的题号）；非缓存分支维持 wizardIndex.value = 0 不动。
    wizardIndex.value = cached.wizardIndex;
    selectedIds.value = cached.selectedIds;
    otherText.value = cached.otherText;
    questionAnswers.value = cached.questionAnswers;
    fieldValues.value = cached.fieldValues;
    // C1 变体 2：wizardFlaggedIndex/丢弃确认层/Other 展开态为瞬态 UI 面，不跨换单/切会话恢复
    //（02 §3.8「draftCache 恢复后 flagged 残留」边界值处理）。
    wizardFlaggedIndex.value = null;
    discardConfirmVisible.value = false;
    wizardOtherExpanded.value = false;
    searchText.value = '';
    focusedIndex.value = 0;
    syncFocusedSelection();
    return;
  }
  wizardIndex.value = 0;
  questionAnswers.value = {};
  // C1 变体 2（02 §3.3 initSelection wizard 分支）：警示描边/丢弃确认层/Other 展开态随新单清零。
  wizardFlaggedIndex.value = null;
  discardConfirmVisible.value = false;
  wizardOtherExpanded.value = false;
  searchText.value = '';
  focusedIndex.value = 0;
  initFields(request);
  // 变体 2：wizard 无预选——草稿账本即答即写（questionAnswers 空账本起步，defaultOptionIds 不
  // 预选，提交以显式作答为准）；非 wizard 形态维持 optionDefaults 预选（权限/单题语义不变）。
  selectedIds.value = isWizard.value
    ? new Set()
    : optionDefaults(request.options ?? [], request.defaultOptionIds, request.multiSelect);
  otherText.value = '';
  syncFocusedSelection();
  void nextTick(focusDialogStart);
}

// hb12-PERM-04：草稿变化即入缓存（deep watch，触发时机由 Vue 调度器批处理；请求完成时清理由 removeRequestData 消费方不再触发——残留小条目可接受）。
// hb13-v A8：写回自身 id——旧实现把 activeRequest 放进 watch 源且回调读 flush 时的
// activeRequest.value：A→B 弹窗换位时 flush 读到的已是 B，把 A 的选择写进 B 的草稿，
// B 恢复出 A 的预选（权限弹窗预选上一单 allow，误按 Enter 即放行，误授权风险面）。
// 改为 watch 源仅草稿字段，以 initSelection 入口捕获的 displayedRequestId（捕获期 id）
// 为键；null（无已初始化请求）不写。
let displayedRequestId: string | null = null;
watch(
  [selectedIds, otherText, wizardIndex, questionAnswers, fieldValues] as const,
  () => {
    if (!displayedRequestId) return;
    draftCache.set(displayedRequestId, {
      selectedIds: new Set(selectedIds.value),
      otherText: otherText.value,
      wizardIndex: wizardIndex.value,
      questionAnswers: JSON.parse(JSON.stringify(questionAnswers.value)) as Record<string, QuestionAnswer>,
      fieldValues: JSON.parse(JSON.stringify(fieldValues.value)) as Record<string, string | boolean>,
    });
  },
  { deep: true },
);

function enqueue(request: InteractionPromptPayload): void {
  const enqueued = interactionStore.enqueueRemote(request);
  // 去重跳过（二次入队同 id）时不重置 UI，避免清空用户正在填的选择/表单。
  if (!enqueued) return;
  // 只有当新请求属于当前会话（成为 currentRequests[0]）时才弹窗 + 记录触发元素；
  // 非当前会话的请求入队但不显示，切回该会话时由 watch activeRequest.id 初始化 UI。
  if (currentRequests.value[0]?.id === request.id) {
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
  const next = currentRequests.value[0];
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

// UI13-P6 直选直提：单选形态（非向导 single-choice / 向导当前题非 multiSelect）单击普通选项
// = 选中并立即提交；Other 与多选、permission/confirm/form/text 等形态不在此列（裁决 R2：
// 权限/alert 形态保留「拒绝+所选 label 主按钮」现状）。
function isDirectSubmitChoice(): boolean {
  const req = activeRequest.value;
  if (!req || currentMultiSelect.value) return false;
  if (hasStructuredForm.value || hasTextInput.value) return false;
  if (req.kind === 'permission' || req.kind === 'confirm') return false;
  if (isWizard.value) return true;              // kind 'form' + questions，当前题单选
  return req.kind === 'single-choice';
}

function toggleOption(optionId: string): void {
  const request = activeRequest.value;
  if (!request) return;

  if (currentMultiSelect.value) {
    const next = new Set(selectedIds.value);
    if (next.has(optionId)) next.delete(optionId);
    else next.add(optionId);
    updateSelected(next);
    return;
  }

  // UI13-P6 直选直提：普通选项选中即提交（submit 无参走已写回的 selectedIds，无双 toggle）；
  // Other 只展开输入不提交（submit 内 OTHER 空文本守卫天然兜住，但显式跳过更清晰）。
  // 双击/连点防重：短窗守卫必须置于 updateSelected 之前——第二击不得先污染新请求/新题的
  // 选中态（IPC 回包可能先于双击第二击，submittingId 已在 finally 清零；向导中途前进路径
  // 不置 submittingId）。只挡直提点击路径：Enter 提交/多选 toggle/Other 流程不经此分支。
  // P1-A：submit(optionId) 同位加同款守卫（dblclick 直发不经此处即直构 ids），本处保留双保险。
  // P3-1：focusOption 移到守卫之后——被吞的第二击不得污染聚焦态（鼠标路径聚焦由选项
  // @mouseenter 驱动、键盘路径经 move()，此处 focusOption 对两路径均冗余，仅直提放行时补齐）。
  const direct = isDirectSubmitChoice() && optionId !== OTHER_OPTION_ID;
  if (direct && Date.now() - lastDirectSubmitAt < 300) return;
  const optionIndex = filteredOptionEntries.value.findIndex((option) => option.id === optionId);
  if (optionIndex >= 0) focusOption(optionIndex);
  updateSelected(new Set([optionId]));
  if (direct) {
    lastDirectSubmitAt = Date.now();
    void submit();
  }
}

// 单题作答有效性（C-W1）：非空选项 或 非空 Other 文本。多选零选中（空数组）不算已答，
// 防自由跳转后空答案静默提交给模型。
function isQuestionAnswered(answer?: QuestionAnswer): boolean {
  return (answer?.selectedOptionIds?.length ?? 0) > 0 || Boolean(answer?.otherText?.trim());
}

// ── C1 变体 2「左侧题号导航栏」wizard 函数组（2026-11-15 用户拍板；02-impl-details-renderer §3.3）──

// 变体 2 草稿账本唯一写入点（契约 5）：右栏选项点击/Other 输入即时落账 questionAnswers[qid]，
// 无翻页落账中间态——翻页/跳转/切换不丢（结构性保证）；载荷与主进程 questionAnswers 链同形。
function updateAnswer(qid: string, patch: { selectedOptionIds?: string[]; otherText?: string }): void {
  const prev = questionAnswers.value[qid] ?? {};
  questionAnswers.value = { ...questionAnswers.value, [qid]: { ...prev, ...patch } };
}

// 单选作答自动前进（契约 5，守卫放行后执行）：跳到当前题之后的首个未答题；没有则原地停留。
function advanceToNextUnanswered(): void {
  const next = wizardQuestions.value.findIndex(
    (question, index) => index > wizardIndex.value && !isQuestionAnswered(questionAnswers.value[question.id]),
  );
  if (next >= 0) {
    wizardIndex.value = next;
    wizardOtherExpanded.value = false;
    focusedIndex.value = 0; // 备忘(a)：自动前进翻题后焦点环复位首项（防残留 --focused 落在新题中间项）
  }
}

// 变体 2 右栏选项点击入口：多选=勾选切换（守卫之外，不前进）；Other=展开输入+聚焦（守卫之外，
// 不写入账本——空文本 Other 不得被记成已答）；单选普通选项=点击即作答（草稿账本）+ 自动前进，
// 300ms 短窗守卫护「作答+自动前进」边沿（防自动前进后双击把第二击落进下一题；显式导航/多选/
// Other/提交按钮均不经此守卫——C2 口径）。Other 文本让位语义与旧 updateSelected 一致：
// 单选改选普通选项即清 Other 草稿；多选移除 __other__ 即清 Other 草稿。
function wizardToggleOption(optionId: string): void {
  const question = activeQuestion.value;
  if (!question) return;
  const qid = question.id;
  if (question.multiSelect) {
    const prevIds = questionAnswers.value[qid]?.selectedOptionIds ?? [];
    const removing = prevIds.includes(optionId);
    const nextIds = removing ? prevIds.filter((id) => id !== optionId) : [...prevIds, optionId];
    updateAnswer(qid, {
      selectedOptionIds: nextIds,
      ...(removing && optionId === OTHER_OPTION_ID ? { otherText: undefined } : {}),
    });
    wizardOtherExpanded.value = false;
    return;
  }
  if (optionId === OTHER_OPTION_ID) {
    wizardOtherExpanded.value = true;
    void nextTick(() => wizardOtherInput.value?.focus());
    return;
  }
  if (Date.now() - lastDirectSubmitAt < 300) return;
  updateAnswer(qid, { selectedOptionIds: [optionId], otherText: undefined });
  lastDirectSubmitAt = Date.now();
  advanceToNextUnanswered();
}

// Other 行内输入即时暂存（契约 5）：文本非空 → selectedOptionIds 纳入 __other__（未选时补选）；
// 清空 → 移出 __other__（多选其余选择保留）——与主进程 answerFromSelection 消费形对齐
//（otherText 仅在 ids 含 __other__ 时被读取）。
function onWizardOtherInput(event: Event): void {
  const question = activeQuestion.value;
  if (!question) return;
  const text = (event.target as HTMLInputElement).value;
  const prevIds = questionAnswers.value[question.id]?.selectedOptionIds ?? [];
  const hasOther = prevIds.includes(OTHER_OPTION_ID);
  const nextIds = text.trim()
    ? (hasOther ? prevIds : [...prevIds, OTHER_OPTION_ID])
    : prevIds.filter((id) => id !== OTHER_OPTION_ID);
  updateAnswer(question.id, { selectedOptionIds: nextIds, otherText: text || undefined });
}

// 左栏状态行摘要（契约 3）：未答=「未作答」muted；单选普通选项=「已选「label」」；Other=自定义
// 文本截 24 码点；多选=「已选 N 项」（N 含 __other__，对齐原型 answerText 形态）。
function wizardNavSummary(question: InteractionPromptQuestion): string {
  const answer = questionAnswers.value[question.id];
  if (!isQuestionAnswered(answer)) return '未作答';
  const ids = answer?.selectedOptionIds ?? [];
  const otherText = answer?.otherText?.trim() ?? '';
  if (question.multiSelect) return `已选 ${ids.length} 项`;
  if (otherText) {
    const chars = Array.from(otherText);
    const truncated = chars.length > 24 ? `${chars.slice(0, 24).join('')}…` : otherText;
    return `自定义 · ${truncated}`;
  }
  const label = question.options.find((option) => option.id === ids[0])?.label ?? ids[0] ?? '';
  return `已选「${label}」`;
}

function buildSummary(request: InteractionPromptPayload, ids: string[]): string {
  if (request.fields?.length) {
    return request.fields.map((field) => `${field.label}: ${String(fieldValues.value[field.id] ?? '')}`).join(' · ');
  }
  if (request.questions?.length) {
    // C1 变体 2：按题序遍历映射 questionAnswers——翻页落账移除后账本插入序不再等价题序，
    // 历史摘要以载荷题序为准（响应载荷本身即题序）。
    return wizardQuestions.value
      .map((question) => {
        const answer = questionAnswers.value[question.id];
        if (!answer) return '';
        return [...(answer.selectedOptionIds ?? []), answer.otherText].filter(Boolean).join(',');
      })
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
  // P1-A：dblclick 直发 emit('submit', id) 的第二击不经 toggleOption 守卫即按 optionId 直构
  // ids 走全链——多题向导题间/队列下一请求复用同 key DOM 时，会把默认项/recommended 预选
  // 静默落账甚至整单向导带脏答案提交。direct 形态整体早退（守卫上移），toggleOption 内守卫
  // 保留为双保险。
  if (optionId && isDirectSubmitChoice() && optionId !== OTHER_OPTION_ID && Date.now() - lastDirectSubmitAt < 300) return;
  if (optionId) toggleOption(optionId);
  let ids = optionId && !currentMultiSelect.value ? [optionId] : Array.from(selectedIds.value);
  // B5（D06-F2）：Enter 兜底（单选形态，非 wizard）——权限弹窗等刻意不预选（防回车误提交），
  // 但聚焦环明确落在某选项时 Enter 视为对该项的提交意图（listbox 惯例）。除局部 ids 外同步
  // 写回 selectedIds（P2-1，2026-10-02 对抗 review）：落账链读 selectedIds，只写局部 ids 会把
  // 该题记成空集（静默空答案）；「不预选」指初始态不预选（optionDefaults 空集、Esc/取消语义
  // 不变），写回发生在提交路径、不复活误触面；多选维持空集早退（空格才是选择键）。
  // C1 变体 2（2026-11-16）：wizard 态 Enter 由 handleKeydown wizard 分流吞掉（无 Enter 兜底，
  // 契约 7），本函数不再服务 wizard——wizard 作答走 questionAnswers 账本直写、提交走 submitWizard。
  if (
    !ids.length && !optionId && !currentMultiSelect.value &&
    !hasStructuredForm.value && !hasTextInput.value && request.kind !== 'confirm' &&
    focusedOption.value
  ) {
    ids = [focusedOption.value.id];
    selectedIds.value = new Set(ids);
  }
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
  // C1 变体 2：wizard 路径整体移除（原 persist+翻页+末步守卫块）——wizard 作答即时写入
  // questionAnswers 账本（updateAnswer），前进由 wizardToggleOption/advanceToNextUnanswered
  // 承担，整体提交由 footer 主按钮 submitWizard 承担（未答齐时定位跳转+左栏警示）。

  submittingId.value = request.id;
  try {
    await interactionStore.respondAndRemove({
      id: request.id,
      action: 'submit',
      selectedOptionIds: isWizard.value ? undefined : ids,
      // questionAnswers / fieldValues 是 Vue reactive proxy，Electron IPC 结构化克隆不支持 proxy
      // （会抛 "An object could not be cloned"），必须深拷贝成 plain object 再过 IPC。
      questionAnswers: isWizard.value
        ? JSON.parse(JSON.stringify(questionAnswers.value)) as Record<string, QuestionAnswer>
        : undefined,
      fieldValues: hasStructuredForm.value
        ? JSON.parse(JSON.stringify(fieldValues.value)) as Record<string, string | boolean>
        : undefined,
      otherText: otherText.value.trim() || undefined,
    });
    pushHistory(request, 'submit', ids);
    advanceQueueUI();
  } catch (err) {
    // hb10-PERM-03：IPC 失败时请求已留队（store 不再失败移除），不前进队列——用户可重试提交。
    console.error('Interaction submit failed', err);
    submitError.value = '提交失败（连接异常），请重试';
  } finally {
    submittingId.value = null;
  }
}

async function cancel(): Promise<void> {
  const request = activeRequest.value;
  if (!request || submittingId.value === request.id) return;
  submittingId.value = request.id;
  try {
    // reason:'user' 区分「用户主动拒绝」与系统取消（signal abort/窗口关闭/会话删除）。
    // permission 映射据此决定是否记成「用户拒绝该工具」（见 mapPermissionInteractionResponse）。
    await interactionStore.respondAndRemove({ id: request.id, action: 'cancel', reason: 'user' });
    pushHistory(request, 'cancel', []);
    advanceQueueUI();
  } catch (err) {
    // hb10-PERM-03：取消失败同样留队可重试。
    console.error('Interaction cancel failed', err);
    submitError.value = '取消失败（连接异常），请重试';
  } finally {
    submittingId.value = null;
  }
}

// ── C1 变体 2：丢弃保护（契约 6）+ wizard 整体提交（契约 4）──

// 丢弃保护门：取消（footer 最左钮）在有任一作答时先二次确认；零作答直接走既有 cancel 链。
// wizard 态 Esc（非输入焦点）与 X 同语义经本入口（确认层在场时 Esc 由 handleKeydown 分流 dismiss）。
function requestDiscard(): void {
  if (!hasAnyAnswer.value) {
    void cancel();
    return;
  }
  discardCounts.value = answeredCount.value;
  discardConfirmVisible.value = true;
}

function confirmDiscard(): void {
  discardConfirmVisible.value = false;
  void cancel();
}

// 继续作答 / 确认层遮罩点击 / 确认层 Esc（handleKeydown wizard 分流）——只关确认层，不动草稿。
function dismissDiscard(): void {
  discardConfirmVisible.value = false;
}

// wizard 整体提交（契约 4）：未答齐 → 跳转首个未答题 + 左栏警示描边（不弹 toast、不置
// submittingId、不阻断其余操作，主按钮恒可点故本早退可达）；答齐 → 既有 respondAndRemove 链
// 逐题回传（questionAnswers 深拷贝过 IPC，载荷经主进程 buildAskUserQuestionResult 对位）。
async function submitWizard(): Promise<void> {
  const request = activeRequest.value;
  if (!request || submittingId.value === request.id) return;
  const firstUnanswered = wizardQuestions.value.findIndex(
    (question) => !isQuestionAnswered(questionAnswers.value[question.id]),
  );
  if (firstUnanswered >= 0) {
    wizardFlaggedIndex.value = firstUnanswered;
    wizardIndex.value = firstUnanswered;
    wizardOtherExpanded.value = false;
    focusedIndex.value = 0; // 备忘(e)（round-005）：未答齐跳题第四路径焦点环复位首项（同 jumpToQuestion/goNext，防残留 --focused 落在新题中间项）
    return;
  }
  submittingId.value = request.id;
  try {
    await interactionStore.respondAndRemove({
      id: request.id,
      action: 'submit',
      selectedOptionIds: undefined, // wizard 恒走 questionAnswers 逐题账本
      questionAnswers: JSON.parse(JSON.stringify(questionAnswers.value)) as Record<string, QuestionAnswer>,
      otherText: undefined, // 顶层 otherText 恒空（逐题答案在 questionAnswers 内）
    });
    pushHistory(request, 'submit', []);
    advanceQueueUI();
  } catch (err) {
    // hb10-PERM-03：IPC 失败时请求已留队（store 不再失败移除），不前进队列——用户可重试提交。
    console.error('Interaction submit failed', err);
    submitError.value = '提交失败（连接异常），请重试';
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
  // B5 补修（核验·遮挡组合回归）：更高层遮罩（灯箱 9999/diff 弹窗 1250/导出格式 9000）在场时不抢占 DOM
  // 焦点——弹窗渲染于 z-1200 之下被完全遮挡、用户从未见过，抢焦会把键盘焦点从用户当前
  // 所见层（灯箱关闭按钮等）劫进不可见弹窗，后续 Enter 经 submit 兜底会静默提交首项
  // （权限首项=允许本次）。让位判据与 A9 的 Esc 让位同源（escHandle.isTopmost）；
  // 遮罩关闭后打开的新弹窗/队列前进仍走下方正常聚焦。
  if (escHandle && !escHandle.isTopmost()) return;
  // B5（D06-F2）：跳过 disabled 候选——权限弹窗刻意不预选（optionDefaults 空集）时提交按钮
  // 禁用，对禁用按钮 focus() 是 no-op、真实焦点留在遮罩之外（Tab 逃逸 + Enter 无反应）。
  const candidates = dialogRef.value?.querySelectorAll<HTMLElement>('[data-dialog-initial-focus]');
  if (candidates) {
    for (const el of candidates) {
      if (!(el as HTMLButtonElement).disabled) {
        el.focus();
        return;
      }
    }
  }
  // 回落：选项列表第一项获得真实 DOM 焦点（focusedIndex 初始为 0，焦点环与 DOM 焦点一致；
  // listbox 惯例——Enter 由 submit 的 focusedOption 兜底提交该聚焦项）。无选项形态保持现状。
  dialogRef.value?.querySelector<HTMLElement>('.interaction-option')?.focus();
}

function trapTab(event: KeyboardEvent): void {
  const dialog = dialogRef.value;
  if (!dialog) return;
  const focusables = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'));
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  // B5（D06-F2）：收紧为「模态内循环」——初始焦点落空（activeElement 仍在 body/遮罩外）时
  // Tab 直接拉回模态首元素，不再按默认 DOM 序逃出 aria-modal 对话框（WCAG 2.4.3）。
  const active = document.activeElement;
  const outside = !dialog.contains(active);
  if (event.shiftKey && (active === first || outside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || outside)) {
    event.preventDefault();
    first.focus();
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (!activeRequest.value) return;
  // B5 补修（核验·遮挡组合回归）：更高层遮罩在场时操作键整体让位——被遮挡、用户从未见过
  // 的弹窗不得被 Enter（submit 兜底会静默提交聚焦首项，权限首项=允许本次，误授权比 A9
  // 设防的误 deny 危害更大）、箭头/空格（move/toggle 改写隐藏选择）、Tab（trapTab 拉焦）
  // 触碰；判据与 A9 的 Esc 让位同源，Esc 分支守卫保留原位（见下方 Escape 分支）。
  // 无更高层时零行为变化。
  // （C1 变体 2 注：原首行 isTextEntryTarget 早退移至 wizard 分流之后——wizard 输入框内 Esc
  // 须进分域处理（失焦不关单）；两者早退结果等价，非 wizard 行为零变化。）
  if (
    (event.key === 'Tab' || event.key === 'ArrowDown' || event.key === 'ArrowUp'
      || event.key === 'Enter' || event.key === ' ')
    && escHandle && !escHandle.isTopmost()
  ) return;
  // C1 变体 2：Tab trap 先于 wizard 分流执行（wizard 亦困于模态，WCAG 2.4.3）；文本输入内
  // Tab 维持浏览器默认（与旧 textEntry 首行早退等价）。
  if (event.key === 'Tab') {
    if (isTextEntryTarget(event.target)) return;
    trapTab(event);
    return;
  }
  // C1 变体 2（契约 6/7/8）wizard 早退分流：Esc 分域——丢弃确认层在场=关确认层；输入焦点内
  // =失焦不关整单；其余=丢弃保护（有作答→确认层，零作答→直接 cancel）。分流整体 return：
  // ArrowUp/ArrowDown/Enter/Space 全部不拦截——箭头键交还焦点容器原生滚动（不 move、不改写
  // 选中，契约 8），Enter/Space 交还选项钮/左栏项浏览器原生激活（等同点击，无 Enter 兜底，
  // 契约 7）。非 wizard 形态以下各分支逐字不动。
  if (isWizard.value) {
    if (event.key === 'Escape' && (!escHandle || escHandle.isTopmost())) {
      event.preventDefault();
      if (discardConfirmVisible.value) {
        dismissDiscard();
        return;
      }
      if (isTextEntryTarget(event.target)) {
        (event.target as HTMLElement).blur();
        return;
      }
      requestDiscard();
    }
    return;
  }
  if (isTextEntryTarget(event.target)) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    move(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    move(-1);
  } else if (event.key === 'Enter' && document.activeElement !== otherInput.value) {
    // X1（R06-F1）：焦点在本弹窗的真实按钮（footer 上一步/拒绝/提交）或 <summary>（交互历史）上
    // 时让位——不 preventDefault、不 submit，放行浏览器原生激活（Enter→click），防 window 级兜底
    // 把「Tab 到拒绝按 Enter」劫持成 B5 提交聚焦首项（权限选项序 allow 在前 = 误授权）、
    // 「上一步」变推进下一题、<summary> 直接提交整个交互。让位限定 dialogRef 内：焦点在遮罩外
    // 按钮上不放行其原生激活（与 A9/B5「不可见元素不得被键盘触碰」约束同源）；选项按钮
    //（button.interaction-option，InteractionOptionList 两形态）不让位：Enter 维持 submit 兜底
    //（B5 语义），焦点在弹窗空白/body 上同样维持现状。
    const target = event.target as HTMLElement | null;
    if (target && dialogRef.value?.contains(target) && target.closest('button, summary') && !target.closest('.interaction-option')) return;
    event.preventDefault();
    void submit();
  } else if (event.key === 'Escape') {
    // A9（D06-F1）：更高层遮罩（灯箱/导出格式）在场时让位——不 preventDefault、不 cancel，
    // 防被遮挡且用户从未见过的弹窗按「用户拒绝」收口。无更高层时行为与现状一致。
    if (escHandle && !escHandle.isTopmost()) return;
    event.preventDefault();
    // alert 模式（kind:'confirm' 且只有 confirm 一个选项）Esc 视为"知道了"→提交确定，
    // 与原 ConfirmDialog 的 alert 行为一致；其余 confirm/选择题 Esc→取消。
    const isAlert = activeRequest.value.kind === 'confirm'
      && activeRequest.value.options?.length === 1
      && activeRequest.value.options[0]?.id === 'confirm';
    if (isAlert) void submit('confirm');
    else void cancel();
  } else if (event.key === ' ' && currentMultiSelect.value && document.activeElement !== otherInput.value) {
    // X1（R06-F1）：Space 同族让位——多选形态下焦点在 footer 按钮/<summary> 上时 Space 原被
    // preventDefault + toggleOption 劫持（按钮激活被吞、隐藏选择被改写）；判据与 Enter 分支
    // 同款（dialogRef 限定 + 选项按钮除外），选项上 Space 仍 toggleOption（listbox 惯例）。
    const target = event.target as HTMLElement | null;
    if (target && dialogRef.value?.contains(target) && target.closest('button, summary') && !target.closest('.interaction-option')) return;
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
  // r2-P3-1：摘除非当前头请求不得触碰当前单瞬态面（丢弃确认层/警示描边/Other 展开态），00 契约 9。
  if (id !== activeRequest.value?.id) return;
  const next = currentRequests.value[0];
  if (next) initSelection(next);
}

// 左栏题号导航 / 上一步共用的题间跳转入口（C1 变体 2 重设计版）：越界与原地跳转 no-op；
// 自由直达、无翻页落账步骤（草稿账本即答即写，翻页/跳转不丢——契约 5）；跳转命中警示题时
// 清除（原地作答自动前进不清，下次提交校验重定或整单提交消亡）；翻题复位焦点环首项（备忘(a)）。
function jumpToQuestion(index: number): void {
  if (index < 0 || index >= wizardQuestions.value.length || index === wizardIndex.value) return;
  wizardIndex.value = index;
  if (wizardFlaggedIndex.value === index) wizardFlaggedIndex.value = null;
  wizardOtherExpanded.value = false;
  focusedIndex.value = 0; // 备忘(a)：跳题后焦点环复位首项（防残留 --focused 落在新题中间项）
}

// 函数名与模板 @click="previousQuestion" 绑定原样保留（tdd-interaction-prompt-enter-guard.ts 契约钉死）。
function previousQuestion(): void {
  jumpToQuestion(wizardIndex.value - 1);
}

// footer 主按钮非末题分支（R4-1，C1 契约 2 跳过语义）：「下一题」恒可点——前进一格且不校验
// 当前题已答（跳过语义，未答亦可前进）、不触碰 wizardFlaggedIndex（警示仅由末题 submitWizard
// 校验置位/由 jumpToQuestion 命中警示题清除）；末题不进本函数（footer @click 三元分流至
// submitWizard：未答齐定位+警示，答齐整卷提交）。
function goNext(): void {
  if (wizardIndex.value >= wizardQuestions.value.length - 1) return;
  wizardIndex.value += 1;
  wizardOtherExpanded.value = false;
  focusedIndex.value = 0; // 备忘(a)：前进翻题后焦点环复位首项
}

cleanupRequest = window.claudeLink.onInteractionRequest(enqueue);
cleanupCancel = window.claudeLink.onInteractionCancel(({ id }) => removeRequest(id));
void window.claudeLink.getPendingInteractions().then((pending) => {
  for (const request of pending) enqueue(request);
});
window.addEventListener('keydown', handleKeydown);

// A9（D06-F1/D14-F5）：交互弹窗可见期间注册 Esc 层（1200）——更高层遮罩（灯箱 9999/导出格式
// 9000）在场时 Esc 分支让位，Esc 只关最上层，防「用户从未见过的弹窗被按 Esc 误 deny」。
let escHandle: EscLayerHandle | null = null;
watch(activeRequest, (req) => {
  if (req && !escHandle) escHandle = pushEscLayer(ESC_LAYER_PRIORITY.interaction);
  else if (!req && escHandle) {
    escHandle.release();
    escHandle = null;
  }
});

// V3-3：交互历史持久化——跟随当前会话加载历史，切换会话时刷新。
// 用自增 token 防竞态：快速切会话 A→B 时，若 A 的 IPC 响应晚于 B 返回，
// token 不匹配则丢弃，避免 B 的历史被 A 覆盖。
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
// activeRequest 变化（新请求 / 切换会话导致 currentRequests 重算）时的统一 UI 副作用：
//  initSelection 重置选择态——切会话时前一会话的请求被过滤掉、当前会话的请求浮现，
//  必须重置 selectedIds/表单，避免显示上一个请求残留的选择。
//  （P7：旧「position 归零」已删——弹窗几何归 useDialogShell 管，visible false→true 边沿
//  自动重置居中；队列换单连续在场时按计划 P7 文本 resetToCenter 重置居中——保留几何的是 FilePicker 的 P5 队列换单语义，本组件不保留。）
watch(() => activeRequest.value?.id ?? null, (newId, oldId) => {
  if (newId && newId !== oldId && activeRequest.value) {
    initSelection(activeRequest.value);
    shell.resetToCenter(); // 计划 P7：新请求重置居中——A→B 直切无 null 帧，visible 边沿不覆盖（rect null 时本调用为 no-op，首开仍由边沿测量居中）
  }
});
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

// hb10-PERM-03：30s 对账轮询（store.activeRequest 非空即执行——该 getter 取 requests[0] 未按
// 会话过滤，含他会话排队请求，弹窗不可见仍轮询；弹窗可见由按会话过滤的 currentRequests 决定）
// ——死亡/不可见挂起自愈。
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  reconcileTimer = setInterval(() => {
    if (interactionStore.activeRequest) void interactionStore.reconcile();
  }, 30_000);
});

onBeforeUnmount(() => {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  cleanupRequest?.();
  cleanupCancel?.();
  window.removeEventListener('keydown', handleKeydown);
  // A9：卸载兜底出栈（release 幂等）。
  escHandle?.release();
  escHandle = null;
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
        :class="{ 'interaction-dialog--wizard': isWizard, 'interaction-dialog--wide': hasPreview, 'interaction-dialog--narrow': activeRequest.kind === 'confirm' }"
        role="dialog"
        aria-modal="true"
        :aria-label="activeRequest.title"
        :style="shellStyle"
      >
        <header class="interaction-dialog__header" @pointerdown="shell.beginDrag" @dblclick="shell.resetToCenter">
          <span class="interaction-dialog__eyebrow">{{ eyebrow }}</span>
          <!-- C1 变体 2：头部进度 chip 常显「已答 N/M」（对齐原型 .head .chip）——题间三态标识
               移入左栏状态行；旧圆点进度行移除。 -->
          <span v-if="isWizard" class="wizard-progress-chip" data-testid="wizard-progress-chip">已答 {{ answeredCount }}/{{ wizardQuestions.length }}</span>
          <h3>{{ currentTitle }}</h3>
          <p v-if="currentDescription">{{ currentDescription }}</p>
        </header>

        <!-- C1 变体 2（用户 2026-11-15 拍板，基准 prototypes/question-dialog-variant-2-sidenav.html）：
             wizard（kind form 多题）态=宽面板左右分栏——左栏题号导航（三态+状态行+直达）+ 右栏单题
             内容（分页保留，一次一题）；作答即时写入 questionAnswers 账本，无翻页落账。
             单题（非 form）形态走 v-else 原 body，模板与逻辑逐字不动（契约 9 硬约束）。 -->
        <div v-if="isWizard" class="interaction-dialog__body--wizard">
          <nav class="wizard-nav" data-testid="wizard-nav" aria-label="题目导航">
            <button
              v-for="(question, index) in wizardQuestions"
              :key="question.id"
              type="button"
              class="wizard-nav__item"
              :class="{
                answered: isQuestionAnswered(questionAnswers[question.id]),
                current: wizardIndex === index,
                'wizard-nav__item--flagged': wizardFlaggedIndex === index,
              }"
              :title="`跳到第 ${index + 1} 题`"
              :aria-label="`跳到第 ${index + 1} 题：${wizardNavSummary(question)}`"
              data-testid="wizard-nav-item"
              @click="jumpToQuestion(index)"
            >
              <span class="row1">
                <span class="n">{{ isQuestionAnswered(questionAnswers[question.id]) ? '✓' : index + 1 }}</span>
                <span class="t">{{ question.title }}</span>
              </span>
              <span class="row2">{{ wizardNavSummary(question) }}</span>
            </button>
          </nav>
          <div class="wizard-content" data-testid="wizard-content">
            <div class="wizard-qhead">
              <span class="wizard-count">第 {{ wizardIndex + 1 }} 题 / 共 {{ wizardQuestions.length }} 题</span>
              <span class="wizard-qtag">{{ currentMultiSelect ? '多选' : '单选 · 点击即作答' }}</span>
            </div>
            <div class="wizard-qtext">{{ activeQuestion?.title }}</div>
            <p v-if="activeQuestion?.description" class="wizard-qdesc">{{ activeQuestion.description }}</p>
            <InteractionOptionList
              v-if="filteredOptions.length"
              :options="filteredOptions"
              :focused-index="focusedIndex"
              :selected-ids="wizardSelectedIds"
              :multi-select="currentMultiSelect"
              :virtual="useVirtualOptions"
              @focus="focusOption"
              @toggle="wizardToggleOption"
            />
            <div v-else-if="activeOptions.length" class="interaction-empty">没有匹配的选项</div>
            <label v-if="wizardShowOther" class="interaction-other wizard-other">
              <span>{{ activeQuestion?.otherLabel ?? activeRequest.otherLabel ?? 'Other' }}</span>
              <input
                ref="wizardOtherInput"
                :value="wizardOtherText"
                type="text"
                placeholder="输入自定义答案..."
                @input="onWizardOtherInput"
                @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
              />
            </label>
            <p class="wizard-skipnote">可跳过本题稍后再答；提交前需答完全部 {{ wizardQuestions.length }} 题。</p>
          </div>
        </div>
        <div v-else class="interaction-dialog__body" :class="{ 'interaction-dialog__body--preview': hasPreview }">
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
                <input v-else-if="field.type === 'checkbox'" v-model="fieldValues[field.id]" type="checkbox" @change="touchedCheckboxFields.add(field.id)" />
                <!-- G2：number 字段走数值键盘/步进输入；Vue 对 type="number" 的 v-model 会自动转 number（不可解析时保留 string），提交侧 dialogResultFromInteraction 对 string/number 双向兜底统一为数值。 -->
                <input v-else-if="field.type === 'number'" v-model="fieldValues[field.id] as string" :placeholder="field.placeholder" type="number" inputmode="decimal" @keydown.stop @keydown.esc.prevent="cancel" />
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
            <!-- hb10-PERM-07：confirm 类（OAuth/授权）弹窗可核对目标 URL（仅 input.url 存在时） -->
            <div
              v-else-if="activeRequest.kind === 'confirm' && Boolean((activeRequest.input as Record<string, unknown> | undefined)?.url)"
              class="interaction-url"
            >
              <span class="interaction-url__label">URL</span>
              <code class="interaction-url__value">{{ String((activeRequest.input as Record<string, unknown>).url) }}</code>
            </div>
          </div>

          <InteractionPreview v-if="hasPreview" :preview="optionPreview(focusedOption)" />
        </div>

        <p v-if="submitError" class="interaction-dialog__submit-error" role="alert">{{ submitError }}</p>

        <!-- C1 变体 2 footer 重排（契约 4：取消最左，治「取消夹在上下一步中间」）：
             [取消 ghost][进度文本][上一题 ghost][下一题/提交 primary]；主按钮恒可点——非末题点击
             =前进 goNext（跳过语义，R4-1）；末题点击=submitWizard（未答齐定位+警示）。
             单题（非 form）形态 footer 原排布字面不动。 -->
        <footer v-if="isWizard" class="interaction-dialog__footer interaction-dialog__footer--wizard">
          <button type="button" class="interaction-btn interaction-btn--ghost" data-testid="wizard-cancel-btn" @click="requestDiscard">{{ cancelLabel }}</button>
          <span class="wizard-foot-progress">已答 {{ answeredCount }}/{{ wizardQuestions.length }}</span>
          <button type="button" class="interaction-btn interaction-btn--ghost" data-testid="wizard-prev-btn" :disabled="wizardIndex === 0" @click="previousQuestion">上一题</button>
          <button type="button" class="interaction-btn interaction-btn--primary" data-testid="wizard-next-btn" data-dialog-initial-focus @click="wizardIndex < wizardQuestions.length - 1 ? goNext() : submitWizard()">{{ wizardPrimaryLabel }}</button>
        </footer>
        <footer v-else class="interaction-dialog__footer">
          <button v-if="isWizard && wizardIndex > 0" type="button" class="interaction-btn interaction-btn--ghost" @click="previousQuestion">上一步</button>
          <button type="button" class="interaction-btn interaction-btn--ghost" @click="cancel">{{ cancelLabel }}</button>
          <button
            v-if="showFooterPrimary"
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

        <!-- C1 契约 6：丢弃保护二次确认（面板内浮层，对齐原型 .confirm；文案沿用原型 h3，
             已答数 N 落正文——03b §4 差异点①口径）。 -->
        <div v-if="discardConfirmVisible" class="wizard-discard-confirm" data-testid="wizard-discard-confirm" @click.self="dismissDiscard">
          <div class="wizard-discard-confirm__box" role="alertdialog" aria-modal="true" aria-label="丢弃本次作答确认">
            <h3>丢弃本次作答？</h3>
            <p>已作答的 {{ discardCounts }} 题内容将被丢弃，模型不会收到任何回答。</p>
            <div class="wizard-discard-confirm__row">
              <button type="button" class="interaction-btn interaction-btn--ghost" @click="dismissDiscard">继续作答</button>
              <button type="button" class="interaction-btn interaction-btn--danger" @click="confirmDiscard">丢弃</button>
            </div>
          </div>
        </div>

        <DialogResizeHandles :binder="shell" />
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
  padding: 1.25rem;
  background: var(--interaction-overlay-bg);
}

.interaction-dialog {
  /* P7：shell rect 绑定后由 :style（left/top/width/height px）定位；未测量帧（rect null）无
     inset，静态位置回退遮罩 grid place-items:center 居中（无闪烁）。 */
  position: absolute;
  display: flex;
  flex-direction: column;
  width: var(--interaction-panel-width);
  max-height: min(86vh, 47.5rem);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--color-accent-strong) 35%, var(--color-border));
  border-radius: var(--interaction-panel-radius);
  background: var(--color-panel);
  box-shadow: var(--interaction-shadow);
}

.interaction-dialog--wide {
  width: var(--interaction-panel-width-wide);
}

/* 简单确认弹窗（kind:'confirm' / alert）：无预览；选项至多 2 个（取消/确定等选项仍经
   InteractionOptionList 渲染，footer 另有取消/确认按钮），用窄宽度避免「一句话撑满屏宽」。
   24rem 随字号等比缩放（medium=384px / large=432px / small=336px）。 */
.interaction-dialog--narrow {
  width: min(24rem, 94vw);
}

/* C1 变体 2：wizard（kind form 多题）态宽面板分栏——57.5rem 宽档（对齐原型 .panel），
   与 --wide 同值但独立类（wizard 分栏形态专属钉面）。 */
.interaction-dialog--wizard {
  width: var(--interaction-panel-width-wide);
}

.interaction-dialog__header {
  user-select: none;
  cursor: move;
  touch-action: none; /* P7：拖动手柄——防触屏/触控板起滚吞掉 pointermove（与 P5/P6 接入一致） */
  padding: var(--interaction-header-pad);
  border-bottom: 1px solid var(--color-border);
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 12%, transparent), transparent 72%);
}

.interaction-dialog__eyebrow {
  display: inline-flex;
  margin-bottom: 0.5rem;
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
  margin: 0.5rem 0 0;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  line-height: 1.55;
}

/* ── C1 变体 2「左侧题号导航栏」（2026-11-15 用户拍板）：宽面板左右分栏 ──
   全 token 化（00 契约 10）：浅色 warm-paper / 深色 terminal-pro 双板经既有 palette 变量生效，
   无写死色值（实底白字前景共两处用途，均如实：success/accent 实底经 --color-on-success /
   --color-on-accent token 生效（token 值即 #FFFFFF，variables.css）；danger 实底由
   .interaction-btn--danger 直接写死 #fff（拼黑 20% 加深底上的白字先例）。 */

/* 头部进度 chip（对齐原型 .head .chip）：muted 小字 pill，常显「已答 N/M」。 */
.wizard-progress-chip {
  display: inline-flex;
  margin-left: 0.5rem;
  padding: 0.125rem 0.625rem;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-text-muted);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}

/* 左右分栏主体：左栏题号导航（自身滚动）+ 右栏单题内容（分页保留，一次一题）。 */
.interaction-dialog__body--wizard {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.wizard-nav {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 0.375rem;
  width: var(--interaction-wizard-nav-w);
  overflow-y: auto;
  padding: 0.625rem;
  border-right: 1px solid var(--color-border);
  background: var(--color-panel-soft);
}

.wizard-nav__item {
  padding: 0.5rem 0.625rem;
  border: 1.5px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  appearance: none;
  transition: background 0.12s, border-color 0.12s;
}

.wizard-nav__item:hover {
  background: color-mix(in srgb, var(--color-text) 5%, transparent);
}

.wizard-nav__item .row1 {
  display: flex;
  align-items: center;
  gap: 0.4375rem;
}

.wizard-nav__item .n {
  display: grid;
  flex: none;
  width: 1.25rem;
  height: 1.25rem;
  place-items: center;
  border: 1.5px solid currentColor;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 800;
}

.wizard-nav__item .t {
  overflow: hidden;
  font-size: 0.78125rem;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.wizard-nav__item .row2 {
  overflow: hidden;
  margin: 0.25rem 0 0 1.6875rem;
  color: var(--color-text-muted);
  font-size: 0.6875rem;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 三态色彻底分离（契约 3）：已答=绿✓实心+摘要行 success；当前=accent 描边+浅底+accent 实底
   编号圈；未答=空心编号+「未作答」muted；flagged=danger 描边警示（提交校验命中）。 */
.wizard-nav__item.answered {
  color: var(--color-text);
}

.wizard-nav__item.answered .n {
  border-color: var(--color-success);
  background: var(--color-success);
  color: var(--color-on-success);
}

.wizard-nav__item.answered .row2 {
  color: var(--color-success);
}

.wizard-nav__item.current {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-panel));
  color: var(--color-text);
}

.wizard-nav__item.current .n {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-on-accent);
}

.wizard-nav__item--flagged {
  border-color: var(--color-danger);
}

/* 右栏题面（复用单题 body 渲染结构：InteractionOptionList 选项 + Other 行内输入）。 */
.wizard-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 1rem 1.25rem;
}

.wizard-qhead {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}

.wizard-count {
  color: var(--color-text-muted);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}

.wizard-qtag {
  margin-left: auto;
  color: var(--color-text-muted);
  font-size: 0.6875rem;
}

.wizard-qtext {
  margin: 0 0 0.75rem;
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1.45;
}

.wizard-qdesc {
  margin: 0 0 0.75rem;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  line-height: 1.5;
}

.wizard-skipnote {
  margin-top: 0.625rem;
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

/* footer 进度文本（margin-right:auto 把按钮组推右；取消 ghost 最左）。 */
.wizard-foot-progress {
  margin-right: auto;
  align-self: center;
  color: var(--color-text-muted);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}

/* 丢弃确认层（契约 6；对齐原型 .confirm）：面板内浮层 z 10，遮罩点击=继续作答。 */
.wizard-discard-confirm {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: grid;
  place-items: center;
  border-radius: var(--interaction-panel-radius);
  background: var(--interaction-overlay-bg);
}

.wizard-discard-confirm__box {
  width: 20rem;
  padding: 1rem;
  border-radius: var(--radius-md);
  background: var(--color-panel);
  box-shadow: var(--interaction-shadow);
}

.wizard-discard-confirm__box h3 {
  margin: 0 0 0.375rem;
  font-size: 0.875rem;
}

.wizard-discard-confirm__box p {
  margin: 0 0 0.875rem;
  color: var(--color-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.wizard-discard-confirm__row {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.interaction-dialog__body {
  display: grid;
  gap: 0.75rem;
  /* Bug（计划模式确定按钮点不到）：原 max-height: calc(86vh - 150px) 是魔数，header+footer 一旦
   * 超过 150px（长计划标题/描述，或字号缩放放大 chrome），外层 overflow:hidden 就会裁掉 footer 按钮。
   * 改 flex 列布局：body flex:1 + min-height:0 自适应剩余空间并滚动，footer 永远不被裁。 */
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--interaction-body-pad);
}

.interaction-dialog__body--preview {
  /* grid 列宽阈值保留 px（与 @media max-width:720px 折叠联动，属像素级响应断点，不随字号缩放）。 */
  grid-template-columns: minmax(280px, 0.9fr) minmax(320px, 1.1fr);
  align-items: start;
}

.interaction-dialog__choices {
  display: grid;
  gap: 0.625rem;
  min-width: 0;
}

.interaction-search,
.interaction-other,
.interaction-field {
  display: grid;
  gap: 0.375rem;
  padding: 0.75rem;
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
  margin-left: 0.1875rem;
}

/* hb13-v B9：submitError 行内提示（IPC 失败可重试），footer 上方一行红字。 */
.interaction-dialog__submit-error {
  margin: 0 0 0.375rem;
  padding: 0;
  font-size: 0.75rem;
  color: var(--color-danger);
  text-align: right;
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
  padding: 0.5625rem 0.625rem;
  background: var(--color-panel-soft);
  color: var(--color-text);
  font: inherit;
  outline: none;
}

.interaction-other textarea,
.interaction-field textarea {
  resize: vertical;
}

.interaction-empty {
  padding: 1.125rem 0.75rem;
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
  gap: 0.5rem;
  margin: 0.5rem 0 0;
  padding: 0;
  list-style: none;
}

.interaction-history li {
  display: grid;
  gap: 0.125rem;
  padding: 0.5rem 0.625rem;
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
  flex-shrink: 0;
  justify-content: flex-end;
  gap: 0.5rem;
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
  color: var(--color-on-accent);
}

.interaction-btn--danger {
  /* 拼黑 20% 加深实底：终端深色板下白字 3.91:1<AA（O-2 返工），混合后 ≈5.7:1 过；
     danger 本身仍作色板文字色（不能调色板值，深色主题双向无解）。 */
  background: color-mix(in srgb, var(--color-danger) 80%, #000000);
  color: #fff;
}

@media (max-width: 720px) {
  .interaction-dialog__body--preview {
    grid-template-columns: 1fr;
  }
}
</style>

<style scoped>
/* hb10-PERM-07：confirm 类弹窗 URL 核对行 */
.interaction-url {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 4px 8px;
  font-size: 0.75rem;
}
.interaction-url__label {
  flex: none;
  color: var(--color-text-muted);
}
.interaction-url__value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, ui-monospace, monospace);
  color: var(--color-text);
}
</style>
