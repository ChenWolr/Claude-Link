<script setup lang="ts">
// ProviderModelSelector.vue — 会话工具栏「供应商 × 模型」二级级联选择器（A2 向上级联，视觉稿
// prototypes/session-model-selector-a2.html 为 1:1 基准）。
// 会话是唯一的模型选用现场；整个会话（主流程 + 全部普通 subagent）统一使用同一个当前实际模型，
// haiku/opus/sonnet/fable 别名不再出现在 UI。切换保留会话历史，从下一条消息起生效。
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../../stores/session-store';
import { useProviderStore } from '../../stores/provider-store';

const props = withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false });

const router = useRouter();
const sessionStore = useSessionStore();
const providerStore = useProviderStore();

const wrapRef = ref<HTMLElement | null>(null);
const open = ref(false);
// 右列当前展示的供应商（点左列切换；打开时初始化为当前解析结果）。
const hoverProviderId = ref<string | null>(null);

let unbindProviders: (() => void) | null = null;
onMounted(() => {
  unbindProviders = providerStore.ensureLoaded();
  document.addEventListener('click', handleClickOutside);
  document.addEventListener('keydown', handleEscape);
});
onUnmounted(() => {
  unbindProviders?.();
  document.removeEventListener('click', handleClickOutside);
  document.removeEventListener('keydown', handleEscape);
});

// 当前会话的解析结果（与主进程 spawn 注入同一 shared 纯函数）。
const resolved = computed(() =>
  providerStore.resolve({
    providerOverride: sessionStore.activeSession?.providerOverride ?? null,
    modelOverride: sessionStore.activeSession?.modelOverride ?? null,
  }),
);

const hasLibrary = computed(() => providerStore.providers.length > 0);

const hoverProvider = computed(() =>
  providerStore.providers.find((p) => p.id === hoverProviderId.value) ?? null,
);
const hoverModelCount = computed(() => hoverProvider.value?.models.length ?? 0);

// 右列标题与当前✓：仅当悬停列就是当前解析供应商时打勾。
const hoverIsCurrent = computed(() => hoverProviderId.value === resolved.value.provider?.id);

function toggleOpen(): void {
  if (!hasLibrary.value) {
    void router.push('/config');
    return;
  }
  open.value = !open.value;
  if (open.value) {
    hoverProviderId.value = resolved.value.provider?.id ?? null;
  }
}

function close(): void {
  open.value = false;
}

function selectProvider(pid: string): void {
  hoverProviderId.value = pid;
}

async function selectModel(modelId: string): Promise<void> {
  const pid = hoverProviderId.value;
  if (!pid) return;
  close();
  await sessionStore.setActiveSessionProviderModel(pid, modelId);
}

function goSettings(): void {
  close();
  void router.push('/config');
}

function handleClickOutside(event: MouseEvent): void {
  if (open.value && wrapRef.value && !wrapRef.value.contains(event.target as Node)) {
    close();
  }
}

function handleEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) close();
}

// 回退一次性 toast：会话 override 指向的供应商/模型已被删（每会话只提示一次）。
const toastText = ref<string | null>(null);
const fallbackToastShownFor = new Set<string>();
let toastTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => [providerStore.loaded, sessionStore.activeSession?.id, resolved.value.invalidOverride] as const,
  () => {
    if (!providerStore.loaded || !sessionStore.activeSession) return;
    const sid = sessionStore.activeSession.id;
    if (!resolved.value.invalidOverride || fallbackToastShownFor.has(sid)) return;
    fallbackToastShownFor.add(sid);
    const name = resolved.value.provider?.name ?? '（无供应商）';
    const model = resolved.value.modelId ?? '（无模型）';
    toastText.value = `原供应商/模型已删除，已回退到 ${name} / ${model}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastText.value = null;
    }, 4000);
  },
);

function formatCtx(maxTokens: number): string {
  return maxTokens > 0 ? `${Math.floor(maxTokens / 1024)}k` : '';
}
</script>

<template>
  <div ref="wrapRef" class="model-wrap">
    <!-- 触发器：a2 model-trigger（accent 描边），显示 供应商名 / 模型ID（mono）+ ⌃ -->
    <button
      type="button"
      class="model-trigger"
      :disabled="props.disabled"
      title="切换本会话使用的供应商与模型（下一条消息起生效）"
      :aria-haspopup="true"
      :aria-expanded="open"
      @click="toggleOpen"
    >
      <template v-if="hasLibrary">
        <span class="model-trigger__provider">{{ resolved.provider?.name ?? '未选择' }}</span>
        <span class="model-trigger__sep">/</span>
        <strong class="model-trigger__model">{{ resolved.modelId ?? '未选择' }}</strong>
        <span class="model-trigger__caret" aria-hidden="true">⌃</span>
      </template>
      <template v-else>
        <span>未配置模型 → 前往设置</span>
      </template>
    </button>

    <!-- 级联菜单：向上弹出；两列各自最多 4 项可见、独立滚动 -->
    <div v-if="open" class="cascade">
      <div class="menu providers">
        <div class="menu-head"><span>供应商</span><b>{{ providerStore.providers.length }} 个</b></div>
        <div class="scroll" role="listbox" aria-label="供应商">
          <button
            v-for="p in providerStore.providers"
            :key="p.id"
            type="button"
            :class="['item', { active: p.id === resolved.provider?.id }]"
            role="option"
            :aria-selected="p.id === resolved.provider?.id"
            @click="selectProvider(p.id)"
          >
            <span class="item-name" :title="p.name">{{ p.name }}</span>
            <span class="count">{{ p.models.length }}</span>
            <span v-if="p.id === resolved.provider?.id" class="check">✓ ›</span>
            <span v-else class="arrow" aria-hidden="true">›</span>
          </button>
        </div>
        <button type="button" class="foot foot--action" @click="goSettings">设置中管理供应商</button>
      </div>

      <div class="menu models">
        <div class="menu-head">
          <span>{{ hoverProvider?.name ?? '—' }}</span>
          <b>{{ hoverModelCount }} 个模型</b>
        </div>
        <div class="scroll" role="listbox" aria-label="模型">
          <button
            v-for="m in hoverProvider?.models ?? []"
            :key="m.id"
            type="button"
            :class="['item', { active: hoverIsCurrent && m.id === resolved.modelId }]"
            role="option"
            :aria-selected="hoverIsCurrent && m.id === resolved.modelId"
            @click="selectModel(m.id)"
          >
            <span class="model-id">{{ m.id }}</span>
            <span v-if="hoverIsCurrent && m.id === resolved.modelId" class="check">✓</span>
            <span v-else class="model-meta">{{ formatCtx(m.maxTokens) }}</span>
          </button>
          <div v-if="!hoverProvider || hoverProvider.models.length === 0" class="models-empty">
            该供应商还没有模型，去设置页添加。
          </div>
        </div>
        <div class="foot">下一条消息起生效<span>全部任务统一当前模型</span></div>
      </div>
    </div>

    <!-- 回退一次性 toast -->
    <Teleport to="body">
      <div v-if="toastText" class="fallback-toast" role="status">{{ toastText }}</div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 尺寸全部 rem（a2 px 值按 16px 基准换算），随 fontScale 等比缩放。 */
.model-wrap {
  position: relative;
}

.model-trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.3125rem;
  max-width: 13.75rem;
  border: 1px solid var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 7%, var(--color-panel-soft));
  border-radius: var(--radius-sm);
  padding: 0.3125rem 0.625rem;
  font-size: 0.75rem;
  color: var(--color-accent-strong);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-trigger:hover {
  background: color-mix(in srgb, var(--color-accent) 12%, var(--color-panel-soft));
}

.model-trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.model-trigger__provider {
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-trigger__sep {
  opacity: 0.5;
}

.model-trigger__model {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.6875rem;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-trigger__caret {
  opacity: 0.6;
  font-size: 0.625rem;
}

/* ── 级联：向上弹出（触发器位于底部工具栏）── */
.cascade {
  position: absolute;
  left: 0;
  bottom: calc(100% + 0.5rem);
  display: flex;
  align-items: flex-end;
  z-index: 110;
  filter: drop-shadow(0 0.75rem 2rem rgba(0, 0, 0, 0.14));
  animation: cascade-up 0.18s var(--ease-out);
}

@keyframes cascade-up {
  from {
    opacity: 0;
    transform: translateY(0.4375rem);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cascade {
    animation: none;
  }
}

.menu {
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.providers {
  width: 11.875rem;
  border-radius: var(--radius-md) 0 0 var(--radius-md);
}

.models {
  width: 14.6875rem;
  border-left: 0;
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  background: var(--color-panel-soft);
}

.menu-head {
  height: 2.375rem;
  padding: 0.625rem 0.75rem 0.5rem;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: none;
}

.menu-head b {
  font-size: 0.625rem;
  font-weight: 500;
  color: var(--color-text-muted);
  text-transform: none;
  letter-spacing: 0;
}

/* 两列各最多 4 项可见，超出后仅本列内部滚动（互不带动）。 */
.scroll {
  max-height: calc(2.625rem * 4);
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--color-text-muted) 42%, transparent) transparent;
}

.scroll::-webkit-scrollbar {
  width: 6px;
}

.scroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text-muted) 40%, transparent);
  border-radius: 999px;
}

.item {
  height: 2.625rem;
  width: 100%;
  border: 0;
  background: transparent;
  padding: 0 0.6875rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  text-align: left;
  color: var(--color-text);
  cursor: pointer;
  font-size: 0.75rem;
}

.item:hover,
.item.active {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
}

.item.active {
  color: var(--color-accent-strong);
  font-weight: 650;
}

.item:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.item-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  margin-left: auto;
  flex: none;
  font-size: 0.625rem;
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-text) 7%, transparent);
  padding: 0.125rem 0.375rem;
  border-radius: 999px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.arrow,
.check {
  margin-left: auto;
  color: var(--color-accent-strong);
  font-weight: 700;
}

.count + .arrow,
.count + .check {
  margin-left: 0;
}

.model-id {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.6875rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-meta {
  margin-left: auto;
  color: var(--color-text-muted);
  font-size: 0.625rem;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.check {
  margin-left: auto;
  font-size: 0.75rem;
}

.models-empty {
  padding: 0.75rem;
  font-size: 0.71875rem;
  color: var(--color-text-muted);
  line-height: 1.5;
}

.foot {
  height: 2.125rem;
  border-top: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  padding: 0 0.6875rem;
  color: var(--color-text-muted);
  font-size: 0.625rem;
  flex: none;
}

.foot span {
  margin-left: auto;
  color: var(--color-success-strong);
  font-weight: 600;
}

.foot--action {
  width: 100%;
  border: 0;
  border-top: 1px solid var(--color-border);
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
}

.foot--action:hover {
  color: var(--color-accent-strong);
}

/* 回退一次性 toast */
.fallback-toast {
  position: fixed;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  background: var(--color-text);
  color: var(--color-panel-soft);
  font-size: 0.8125rem;
  padding: 0.5625rem 0.875rem;
  border-radius: var(--radius-md);
  box-shadow: var(--elevation-3);
}
</style>
