<script setup lang="ts">
// ProviderModelList.vue — 「我的模型」列表（r5：每行右侧「测试」按钮做单模型连接测试；
// 来源标签（查询/手动）+ token 数 + 删除。空状态引导查询/手动添加）。
// 模型行 mtok 与来源标签之间为窗口徽标（方案 E2）：点击在徽标正下方弹出锚定浮层卡，
// 编辑该模型条目的 contextWindow 覆盖；提交以 set-window 事件上抛父组件走串行落库链。
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import type { ProviderModel } from '../../../shared/types/config';
import { providerModelWindowInputError } from '../../../shared/model-context-windows';

const props = defineProps<{
  providerId: string;
  models: ProviderModel[];
}>();

const emit = defineEmits<{
  remove: [model: ProviderModel, index: number];
  toast: [message: string];
  'set-window': [model: ProviderModel, raw: string];
}>();

// 行内测试状态（按模型 ID）：pending（按钮内 spinner）→ ok/fail（按钮态）；切换供应商经 :key 重挂载复位（hb12-PRV-02），同一供应商内重渲染不复位（r5 起接受短暂态）。
type TestState = 'idle' | 'pending' | 'ok' | 'fail';
const testStates = reactive(new Map<string, TestState>());

// hb12-PRV-05：直出原值 + 「out tok」标注（1024 除数取整误导）。
function formatTokens(maxTokens: number): string {
  return maxTokens > 0 ? `${maxTokens} out tok` : '—';
}

// ── 窗口徽标 + 锚定浮层卡（方案 E2）──────────────────────────────────
const WIN_PRESETS: Array<{ label: string; value: string; clear?: boolean }> = [
  { label: '200k', value: '200000' },
  { label: '1M', value: '1000000' },
  { label: '2M', value: '2000000' },
  { label: '清除覆盖', value: '', clear: true },
];

// 受控开合按模型 id（同时只开一张）；draft/error 为卡内瞬态，关闭即弃。
const openWinId = ref<string | null>(null);
const winDraft = ref('');
const winError = ref<string | null>(null);
const shakeTick = ref(false);
const popAbove = ref(false);
const popAnimId = ref<string | null>(null);
const popEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
let anchorEl: HTMLElement | null = null;
let shakeTimer: number | undefined;
let animTimer: number | undefined;

// v-for 内的函数 ref（同一时刻至多一个实例存活，直接指向当前元素）。
function setPopRef(el: unknown): void {
  popEl.value = el instanceof HTMLElement ? el : null;
}
function setInputRef(el: unknown): void {
  inputEl.value = el instanceof HTMLInputElement ? el : null;
}

// ≥1M 显示 x.xM（1M / 1.5M），其余 xk（200k）；E2 原型同式。
function formatWindow(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function windowOf(m: ProviderModel): number | null {
  return typeof m.contextWindow === 'number' && m.contextWindow > 0 ? m.contextWindow : null;
}

function closeWinPop(): void {
  openWinId.value = null;
  winError.value = null;
  anchorEl = null;
}

function toggleWinPop(m: ProviderModel, e: Event): void {
  if (openWinId.value === m.id) {
    closeWinPop();
    return;
  }
  openWinId.value = m.id;
  const w = windowOf(m);
  winDraft.value = w != null ? String(w) : '';
  winError.value = null;
  anchorEl = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  void nextTick(() => {
    positionWinPop();
    inputEl.value?.focus();
    inputEl.value?.select();
  });
}

// 浮层锚定在被点徽标正下方（行容器内 absolute，随列表滚动自然跟随）；水平双向夹紧不出
// 行宽，caret 指向徽标中心；行下方裁切容器空间不足且上方充足时上翻（caret 转底边）。
function positionWinPop(): void {
  const pop = popEl.value;
  const anchor = anchorEl;
  if (!pop || !anchor) return;
  const row = anchor.closest('.mrow');
  if (!(row instanceof HTMLElement)) return;
  const rowR = row.getBoundingClientRect();
  const b = anchor.getBoundingClientRect();
  // 上翻判定的基准不是视口而是最近裁切容器：浮层实际被 .card/.mscroll 的 overflow 裁切，
  // 视口余量充足但卡片内滚出可见区时，下方弹出仍会被裁掉。
  const clipEl = anchor.closest('.mscroll') ?? anchor.closest('.card');
  const clipR = clipEl ? clipEl.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = b.left - rowR.left + b.width / 2 - w / 2;
  left = Math.max(6, Math.min(left, row.clientWidth - w - 6));
  let caret = b.left - rowR.left + b.width / 2 - left;
  caret = Math.max(16, Math.min(caret, w - 16));
  pop.style.left = `${left}px`;
  pop.style.setProperty('--caret-x', `${caret}px`);
  if (clipR.bottom - b.bottom < h + 12 && b.top - clipR.top > h + 12) {
    pop.style.top = `${b.top - rowR.top - 8 - h}px`;
    popAbove.value = true;
  } else {
    pop.style.top = `${b.bottom - rowR.top + 8}px`;
    popAbove.value = false;
  }
}

// 手动绑定（:value + @input）而非 v-model：校验与赋值在同一 handler 内完成，不依赖编译顺序。
function onWinInput(e: Event): void {
  winDraft.value = (e.target as HTMLInputElement).value;
  winError.value = providerModelWindowInputError(winDraft.value.trim());
}

function applyWinPreset(value: string): void {
  winDraft.value = value;
  winError.value = providerModelWindowInputError(value);
  inputEl.value?.focus();
}

// X13-a（R02-F1 分叉显式化）：录入/圆环尊重真实窗口 [1k,2M]，而引擎注入侧
// （sdk-backend computeContextWindowOverrideTokens）按 SDK autoCompactWindow 范围钳制到
// [100k,1M]——草稿值越出引擎区间（> 1M 或 < 100k）时浮层卡就地说明分叉。口径决策：
// 钳制与圆环分母各自语义不动，分叉由本说明弥合；仅对合法草稿（winError 为空且非清除
// 意图）判分叉，恰好 1M/100k 不判（引擎不钳制、无分叉）。
const ENGINE_WINDOW_MIN = 100_000;
const ENGINE_WINDOW_MAX = 1_000_000;
const winForkNotice = computed<string | null>(() => {
  const raw = winDraft.value.trim();
  if (raw === '' || winError.value !== null) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && (n > ENGINE_WINDOW_MAX || n < ENGINE_WINDOW_MIN)) {
    return '引擎压缩窗口按 100k–1M 生效；圆环按此值显示';
  }
  return null;
});

// 卡片轻晃一次：先摘类再下一帧挂回以重放动画；reduced-motion 由 CSS 关动画，定时兜底摘类。
function shakeWinPop(): void {
  window.clearTimeout(shakeTimer);
  shakeTick.value = false;
  requestAnimationFrame(() => {
    shakeTick.value = true;
    shakeTimer = window.setTimeout(() => { shakeTick.value = false; }, 400);
  });
}

function saveWinPop(m: ProviderModel): void {
  const raw = winDraft.value.trim();
  const error = providerModelWindowInputError(raw);
  if (error !== null) {
    winError.value = error;
    shakeWinPop();
    inputEl.value?.focus();
    return;
  }
  popAnimId.value = m.id;
  window.clearTimeout(animTimer);
  animTimer = window.setTimeout(() => { popAnimId.value = null; }, 400);
  emit('set-window', m, raw);
  closeWinPop();
}

// 点外部关闭（= 取消，未提交输入丢弃）。徽标自身 @click.stop，不会到达文档层。
function onDocClick(e: MouseEvent): void {
  if (openWinId.value == null) return;
  const t = e.target;
  if (!(t instanceof Node) || popEl.value?.contains(t)) return;
  if (t instanceof Element && t.closest('.win-badge')) return;
  closeWinPop();
}

// Esc 兜底：焦点在预设胶囊等非输入位时输入框的 @keydown.esc 接管不到。
function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && openWinId.value != null) closeWinPop();
}

// 窗口尺寸变化（含窄容器断点切换）后锚定位置失效，按原型语义直接关闭。
function onWinResize(): void {
  if (openWinId.value != null) closeWinPop();
}

onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKeydown);
  window.addEventListener('resize', onWinResize);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onDocKeydown);
  window.removeEventListener('resize', onWinResize);
  window.clearTimeout(shakeTimer);
  window.clearTimeout(animTimer);
});

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
      <button
        type="button"
        :class="['win-badge', windowOf(m) != null ? 'set' : 'unset', { 'pop-anim': popAnimId === m.id }]"
        :aria-label="windowOf(m) != null ? `编辑 ${m.id} 上下文窗口` : `为 ${m.id} 设置上下文窗口`"
        @click.stop="toggleWinPop(m, $event)"
      >
        <template v-if="windowOf(m) != null">
          {{ formatWindow(windowOf(m) ?? 0) }}
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>
        </template>
        <template v-else>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>设置上下文窗口
        </template>
      </button>
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
      <div
        v-if="openWinId === m.id"
        :ref="setPopRef"
        :class="['pop', 'enter', { shake: shakeTick, above: popAbove }]"
        role="dialog"
        aria-label="配置上下文窗口"
      >
        <div class="pop-head">
          <code class="pop-mid">{{ m.id }}</code>
          <button type="button" class="icon-btn" aria-label="关闭" @click="closeWinPop">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="pop-sec">
          <label class="pop-field-label" for="win-ctx-input">上下文窗口</label>
          <input
            id="win-ctx-input"
            :ref="setInputRef"
            :value="winDraft"
            :class="['pop-input', { invalid: winError !== null }]"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            spellcheck="false"
            placeholder="token 数，留空清除"
            @input="onWinInput"
            @keydown.enter.prevent="saveWinPop(m)"
            @keydown.esc.stop.prevent="closeWinPop"
          >
          <p v-if="winError !== null" class="pop-err">{{ winError }}</p>
          <p v-if="winForkNotice !== null" class="pop-note">{{ winForkNotice }}</p>
          <div class="pop-pills">
            <button
              v-for="preset in WIN_PRESETS"
              :key="preset.label"
              type="button"
              :class="['pill', { 'pill-clear': preset.clear }]"
              @click="applyWinPreset(preset.value)"
            >{{ preset.label }}</button>
          </div>
        </div>
        <div class="pop-foot">
          <button type="button" class="btn" @click="closeWinPop">取消</button>
          <button type="button" class="btn primary" @click="saveWinPop(m)">保存</button>
        </div>
      </div>
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

/* relative：锚定浮层卡的定位容器（浮层随行滚动跟随）。 */
.mrow {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto auto auto;
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
  white-space: nowrap;
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
  white-space: nowrap;
}

/* ── 窗口徽标：已设 = accent 淡底 pill（格式化值 + 铅笔）；未设 = 虚线 muted + 加号 ── */
.win-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  justify-content: center;
  font-size: 0.6875rem;
  font-weight: 600;
  font-family: inherit;
  white-space: nowrap;
  padding: 0.125rem 0.5rem;
  border-radius: var(--radius-pill);
  cursor: pointer;
  font-variant-numeric: tabular-nums;
  border: 1px solid transparent;
  transition: background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}

.win-badge.set {
  color: var(--color-accent-strong);
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  border-color: color-mix(in srgb, var(--color-accent) 32%, transparent);
}

.win-badge.set:hover {
  background: color-mix(in srgb, var(--color-accent) 18%, transparent);
  border-color: color-mix(in srgb, var(--color-accent) 46%, transparent);
}

.win-badge.unset {
  color: var(--color-text-muted);
  background: transparent;
  border: 1px dashed color-mix(in srgb, var(--color-text-muted) 42%, transparent);
}

.win-badge.unset:hover {
  color: var(--color-accent-strong);
  border-color: color-mix(in srgb, var(--color-accent) 50%, transparent);
  background: color-mix(in srgb, var(--color-accent) 7%, transparent);
}

.win-badge.pop-anim {
  animation: scalePop var(--duration-base) var(--ease-spring);
}

@keyframes scalePop {
  0% { transform: scale(1); }
  45% { transform: scale(1.12); }
  100% { transform: scale(1); }
}

/* ── 锚定浮层编辑卡（方案 E2）：行容器内 absolute；max-width 兼窄容器收窄 ── */
.pop {
  position: absolute;
  z-index: 80;
  width: 20rem;
  max-width: calc(100% - 0.75rem);
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--elevation-2), var(--ring-light);
  padding: 0.75rem 0.875rem 0.875rem;
}

.pop.enter {
  animation: popIn var(--duration-fast) var(--ease-out);
}

@keyframes popIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}

/* 顶部小三角 caret 指向徽标（水平位置由 --caret-x 控制）。 */
.pop::before {
  content: '';
  position: absolute;
  top: -5.5px;
  left: var(--caret-x, 50%);
  width: 10px;
  height: 10px;
  background: var(--color-panel-soft);
  border-left: 1px solid var(--color-border);
  border-top: 1px solid var(--color-border);
  transform: translateX(-50%) rotate(45deg);
}

/* 上翻态：caret 移到底边，尖角朝下指向徽标。 */
.pop.above::before {
  top: auto;
  bottom: -5.5px;
  border-left: 0;
  border-top: 0;
  border-right: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
}

.pop.shake {
  animation: shake 320ms var(--ease-in-out);
}

@keyframes shake {
  10%, 90% { transform: translateX(-1px); }
  20%, 80% { transform: translateX(2px); }
  30%, 50%, 70% { transform: translateX(-3px); }
  40%, 60% { transform: translateX(3px); }
}

.pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.pop-head .pop-mid {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.8125rem;
  color: var(--color-text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pop-head .icon-btn {
  width: 1.5rem;
  height: 1.5rem;
  color: var(--color-text-muted);
}

.pop-head .icon-btn:hover {
  background: color-mix(in srgb, var(--color-text) 7%, transparent);
  color: var(--color-text);
}

.pop-sec {
  margin-top: 0.625rem;
  padding-top: 0.625rem;
  border-top: 1px dashed color-mix(in srgb, var(--color-border) 70%, transparent);
}

/* 字段标签（原型 field-label 同规格）：单位提示由占位符承担，标签不带 token 字样。 */
.pop-field-label {
  display: block;
  font-size: 0.8125rem;
  font-weight: 600;
  margin-bottom: 0.375rem;
  color: var(--color-text);
}

.pop-input {
  width: 100%;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.8125rem;
  color: var(--color-text);
  padding: 0.4375rem 0.625rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  outline: none;
  font-variant-numeric: tabular-nums;
  transition: border-color var(--duration-fast) var(--ease-out);
}

.pop-input::placeholder {
  color: var(--color-text-muted);
  font-family: inherit;
}

.pop-input.invalid,
.pop-input.invalid:focus-visible {
  border-color: var(--color-danger);
  outline-color: var(--color-danger);
}

.pop-err {
  margin-top: 0.3125rem;
  font-size: 0.71875rem;
  color: var(--color-danger);
  line-height: 1.5;
}

/* 分叉说明（X13-a）：非错误态的 muted 提示——同 pop-err 规格但不动用 danger 色。 */
.pop-note {
  margin-top: 0.3125rem;
  font-size: 0.71875rem;
  color: var(--color-text-muted);
  line-height: 1.5;
}

.pop-pills {
  display: flex;
  gap: 0.375rem;
  margin-top: 0.5rem;
  flex-wrap: wrap;
}

.pill {
  font-size: 0.6875rem;
  font-weight: 700;
  font-family: inherit;
  color: var(--color-accent-strong);
  padding: 0.1875rem 0.5625rem;
  border-radius: var(--radius-pill);
  cursor: pointer;
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-accent) 32%, transparent);
  font-variant-numeric: tabular-nums;
  transition: background var(--duration-fast) var(--ease-out), border-color var(--duration-fast);
}

.pill:hover {
  background: color-mix(in srgb, var(--color-accent) 18%, transparent);
  border-color: color-mix(in srgb, var(--color-accent) 46%, transparent);
}

.pill.pill-clear {
  color: var(--color-text-muted);
  background: transparent;
  border: 1px dashed color-mix(in srgb, var(--color-text-muted) 42%, transparent);
}

.pill.pill-clear:hover {
  color: var(--color-danger);
  border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
  background: color-mix(in srgb, var(--color-danger) 6%, transparent);
}

.pop-foot {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.75rem;
  padding-top: 0.625rem;
  border-top: 1px solid var(--color-border);
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

.btn:hover {
  border-color: var(--color-border-strong);
  background: color-mix(in srgb, var(--color-text) 4%, var(--color-panel-soft));
}

.btn.sm {
  padding: 0.3125rem 0.625rem;
  font-size: 0.75rem;
}

.btn.primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-on-accent);
}

.btn.primary:hover {
  background: var(--color-accent-strong);
  border-color: var(--color-accent-strong);
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

  .pop.enter,
  .pop.shake,
  .win-badge.pop-anim {
    animation: none;
  }

  .win-badge,
  .pill {
    transition: none;
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

.icon-btn:focus-visible,
.win-badge:focus-visible,
.pill:focus-visible,
.pop-input:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

/* 窄容器（面板容器 .wb-connection ≤460px，与 ProviderManager 折纵向同断点）：模型行从单行 grid 改两行 flex——
   模型名独占一行（完整 ellipsis），token/窗口徽标/来源标签/测试/删除换行到第二行。
   避免 5 个 auto 操作列把 1fr 模型名压到 0、完全看不到。浮层宽度由基类 max-width 随行宽收窄。 */
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
