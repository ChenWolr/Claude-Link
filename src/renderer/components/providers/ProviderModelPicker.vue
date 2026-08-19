<script setup lang="ts">
// ProviderModelPicker.vue — 「查询模型」组合框（r2 定版交互契约）：
// - 位于「我的模型」卡头右侧；点击 → 查询（首开自动拉取，异步骨架屏）→ 下拉展开
// - 下拉头 = 搜索框（兼手动输入）+「确认」按钮（在拉框内）+ 刷新图标（强制重新查询）
// - 列表点击即添加，已添加置灰打勾；下拉保持展开可连续添加；ESC/点外部关闭
// - 输入过滤只刷列表区（IME 安全：输入框节点不因过滤重建）；无匹配时提示「点确认手动添加」
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useProviderStore } from '../../stores/provider-store';
import type { ModelInfo, ProviderProfileView } from '../../../shared/types/config';

const props = defineProps<{
  provider: ProviderProfileView;
}>();

const emit = defineEmits<{
  add: [info: ModelInfo];
  'manual-add': [id: string];
  toast: [message: string];
}>();

const store = useProviderStore();

const open = ref(false);
const filter = ref('');
// idle：尚未查询（首次展开自动发起）；loading：查询中（骨架屏）；
// done：已加载；error：失败（就地报错 + 重试）。
const phase = ref<'idle' | 'loading' | 'done' | 'error'>('idle');
const queried = ref<ModelInfo[]>([]);
const errorMsg = ref('');

const wrapRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const addedSet = computed(() => new Set(props.provider.models.map((m) => m.id)));

const filtered = computed(() => {
  const f = filter.value.trim().toLowerCase();
  const list = queried.value;
  if (!f) return list;
  return list.filter((x) => x.id.toLowerCase().includes(f) || x.name.toLowerCase().includes(f));
});

async function runQuery(force: boolean): Promise<void> {
  phase.value = 'loading';
  errorMsg.value = '';
  try {
    queried.value = await store.queryModels(props.provider.id, force);
    phase.value = 'done';
  } catch (error) {
    phase.value = 'error';
    errorMsg.value = error instanceof Error ? error.message : '查询失败';
  }
}

function toggleOpen(): void {
  open.value = !open.value;
  if (open.value && phase.value === 'idle') {
    void runQuery(false);
  }
  if (open.value) {
    window.setTimeout(() => inputRef.value?.focus(), 30);
  }
}

function close(): void {
  open.value = false;
  filter.value = '';
}

function confirmManual(): void {
  const id = filter.value.trim();
  if (!id) {
    emit('toast', '请输入模型 ID');
    inputRef.value?.focus();
    return;
  }
  if (addedSet.value.has(id)) {
    emit('toast', `「${id}」已在列表中，不可重复添加`);
    inputRef.value?.focus();
    return;
  }
  // 输入恰好命中查询结果 → 按查询添加（带 display_name/token）。
  const exact = queried.value.find((x) => x.id === id);
  if (exact) {
    emit('add', exact);
  } else {
    emit('manual-add', id);
  }
  filter.value = '';
  inputRef.value?.focus();
}

function handleInputKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    confirmManual();
  } else if (event.key === 'Escape') {
    close();
  }
}

function handleClickOutside(event: MouseEvent): void {
  if (open.value && wrapRef.value && !wrapRef.value.contains(event.target as Node)) {
    close();
  }
}

function handleEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) close();
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
  document.addEventListener('keydown', handleEscape);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  document.removeEventListener('keydown', handleEscape);
});

function formatTokens(maxTokens: number): string {
  return maxTokens > 0 ? `${Math.floor(maxTokens / 1024)}k` : '—';
}
</script>

<template>
  <div ref="wrapRef" class="cbx">
    <button
      class="btn primary"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="toggleOpen"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>查询模型
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>
    </button>

    <div v-if="open" class="dd">
      <div class="cbx-head">
        <div class="searchbox">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
          <input
            ref="inputRef"
            v-model="filter"
            placeholder="搜索模型，或输入自定义模型 ID"
            autocomplete="off"
            spellcheck="false"
            @keydown="handleInputKeydown"
          />
        </div>
        <button class="btn sm primary" type="button" @click="confirmManual">确认</button>
        <button class="icon-btn plain" type="button" title="重新查询" aria-label="重新查询" @click="runQuery(true)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>
        </button>
      </div>

      <!-- 骨架屏（>300ms 视觉占位；此处查询全阶段显示，防闪跳）-->
      <div v-if="phase === 'loading'" class="skel" aria-label="查询中">
        <div class="bar" /><div class="bar" /><div class="bar" /><div class="bar" />
      </div>
      <div v-else-if="phase === 'idle'" class="dd-note">正在从 {{ host(provider.apiBaseUrl) }}/v1/models 拉取…</div>
      <div v-else-if="phase === 'error'" class="dd-note dd-note--error">
        {{ errorMsg }}
        <button class="btn sm" type="button" @click="runQuery(true)">重试</button>
      </div>
      <div v-else class="dd-list">
        <template v-if="filtered.length > 0">
          <button
            v-for="x in filtered"
            :key="x.id"
            type="button"
            class="qrow"
            :disabled="addedSet.has(x.id)"
            @click.stop="emit('add', x); filter = ''; inputRef?.focus()"
          >
            <span class="qid" :title="x.id">{{ x.id }}<span class="nm">{{ x.name }}</span></span>
            <span class="mtok">{{ formatTokens(x.maxTokens) }}</span>
            <span v-if="addedSet.has(x.id)" class="qok">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>已添加
            </span>
            <span v-else class="qadd">＋ 点击添加</span>
          </button>
        </template>
        <div v-else class="dd-note">
          列表中没有「{{ filter }}」。<br />如果这是网关自定义模型，直接点右侧「确认」手动添加。
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cbx {
  position: relative;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.4375rem 0.8125rem;
  font-size: 0.8125rem;
  font-weight: 600;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-panel-soft);
  color: var(--color-text);
  cursor: pointer;
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

.btn.sm {
  padding: 0.3125rem 0.625rem;
  font-size: 0.75rem;
}

.btn:focus-visible,
.icon-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
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

.icon-btn.plain:hover {
  background: color-mix(in srgb, var(--color-text) 7%, transparent);
  color: var(--color-text);
}

.dd {
  position: absolute;
  top: calc(100% + 0.375rem);
  right: 0;
  width: 28.75rem;
  max-width: min(28.75rem, calc(100vw - 6rem));
  z-index: 60;
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--elevation-2);
  overflow: hidden;
}

.cbx-head {
  display: flex;
  gap: 0.5rem;
  padding: 0.625rem;
  border-bottom: 1px solid var(--color-border);
  align-items: center;
}

.searchbox {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 0;
  background: transparent;
  padding: 0 0.25rem;
  color: var(--color-text-muted);
}

.searchbox input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  padding: 0.375rem 0;
  font-size: 0.8125rem;
  outline: none;
  font-family: var(--font-mono, ui-monospace, monospace);
  color: var(--color-text);
}

/* 查询面板已经提供统一外框；输入获得键盘焦点时不再叠加全局 focus ring。 */
.searchbox input:focus-visible {
  outline: none;
  border-color: transparent;
  box-shadow: none;
}

.dd-list {
  max-height: 18.75rem;
  overflow-y: auto;
}

.qrow {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.5rem 0.875rem;
  border: 0;
  background: transparent;
  text-align: left;
  transition: background var(--duration-fast) var(--ease-out);
  cursor: pointer;
}

.qrow + .qrow {
  border-top: 1px solid color-mix(in srgb, var(--color-border) 40%, transparent);
}

.qrow:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-accent) 9%, transparent);
}

.qrow:disabled {
  opacity: 0.55;
  cursor: default;
}

.qrow .qid {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.8125rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}

.qrow .qid .nm {
  color: var(--color-text-muted);
  font-family: inherit;
  font-size: 0.71875rem;
  margin-left: 0.5rem;
}

.qrow .mtok {
  font-size: 0.71875rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.qrow .qadd {
  font-size: 0.71875rem;
  font-weight: 700;
  color: var(--color-accent-strong);
  white-space: nowrap;
}

.qrow .qok {
  font-size: 0.71875rem;
  font-weight: 700;
  color: var(--color-success-strong);
  display: inline-flex;
  gap: 0.25rem;
  align-items: center;
  white-space: nowrap;
}

.skel {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem 0.875rem;
}

.skel .bar {
  height: 2.125rem;
  border-radius: var(--radius-xs);
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--color-text) 6%, transparent) 25%,
    color-mix(in srgb, var(--color-text) 10%, transparent) 50%,
    color-mix(in srgb, var(--color-text) 6%, transparent) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.2s infinite linear;
}

@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .skel .bar {
    animation: none;
  }
}

.dd-note {
  padding: 0.625rem 0.875rem 0.75rem;
  font-size: 0.75rem;
  color: var(--color-text-muted);
  line-height: 1.6;
}

.dd-note--error {
  color: var(--color-danger);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
</style>
