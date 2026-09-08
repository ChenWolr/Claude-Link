<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session-store';
import { useInteractionStore } from '../stores/interaction-store';

const store = useSessionStore();
const interactionStore = useInteractionStore();
const router = useRouter();
const searchQuery = ref('');
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// 批量管理模式：开启后卡片显示复选框、点击卡片切换选中（不再跳转会话），
// 顶部工具条提供全选/删除所选。删除走 store.deleteSessions → 单个删除同一条
// 物理删除 IPC 链（停 query/队列 → DELETE 级联删库 → 清理附件物理文件）。
const batchMode = ref(false);
const selectedIds = ref(new Set<string>());

const allSelected = computed(
  () =>
    store.displayedSessions.length > 0 &&
    store.displayedSessions.every((s) => selectedIds.value.has(s.id)),
);

function toggleBatchMode() {
  batchMode.value = !batchMode.value;
  selectedIds.value = new Set();
}

function toggleSelected(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

function toggleSelectAll() {
  selectedIds.value = allSelected.value
    ? new Set()
    : new Set(store.displayedSessions.map((s) => s.id));
}

async function confirmBatchDelete() {
  const count = selectedIds.value.size;
  if (!count) return;
  const ok = await interactionStore.requestConfirm({
    title: '批量删除会话',
    message: `确定删除选中的 ${count} 个会话？会话及其全部消息、任务与附件将被永久删除，此操作不可撤销。`,
    confirmText: '删除',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;
  await store.deleteSessions([...selectedIds.value]);
  batchMode.value = false;
  selectedIds.value = new Set();
}

// 单条删除与会话级另外两个入口同守卫（F1）：侧栏单删（AppSidebar confirmDelete）与本页
// 批量删除（confirmBatchDelete）都走 requestConfirm（danger）确认——删除是不可逆物理删除
// （停 query/队列 → DELETE 级联删库 → 清理附件物理文件），卡片直删按钮紧邻点击区，
// 误触面真实存在，不得成为无守卫入口。文案逐字对齐 AppSidebar 单删版。
async function confirmDelete(session: { id: string; name: string }) {
  const ok = await interactionStore.requestConfirm({
    title: '删除会话',
    message: `确定删除会话「${session.name}」？此操作不可撤销。`,
    confirmText: '删除',
    cancelText: '取消',
    danger: true,
  });
  if (ok) await store.deleteSession(session.id);
}

onMounted(() => {
  store.loadSessions();
});

// H2：搜索防抖定时器随卸载清理——250ms 防抖窗口内导航走后，残留定时器触发
// searchSessions('旧词') 会给跨路由存活的 AppSidebar 重新置入「不可见过滤器」
// （聊天页侧栏被静默过滤，直到下一次 loadSessions 才自愈）。对齐 ChatPage noticeTimer 先例。
onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});

function onSearchInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  const q = searchQuery.value.trim();
  // 空查询也走 store.searchSessions('')，由 store 清空搜索态。
  debounceTimer = setTimeout(() => {
    store.searchSessions(q);
  }, 250);
}

function handleSearchClear() {
  searchQuery.value = '';
  store.searchSessions('');
}

function createAndNavigate() {
  // 新会话延迟持久化：与会话管理页入口统一走暂态（首条消息发送才落库）。
  store.startTransientSession();
  router.push('/');
}

async function openSession(session: { id: string }) {
  const found = store.sessions.find((s) => s.id === session.id);
  if (found) {
    await store.switchSession(found);
    router.push('/');
  }
}
</script>

<template>
  <section class="sessions-page">
    <header class="sessions-page__header">
      <div class="sessions-page__actions">
        <button
          type="button"
          class="sessions-page__batch"
          :class="{ 'sessions-page__batch--active': batchMode }"
          @click="toggleBatchMode"
        >
          {{ batchMode ? '退出批量' : '批量删除' }}
        </button>
        <button type="button" class="sessions-page__create" @click="createAndNavigate">
          + 新建会话
        </button>
      </div>
    </header>
    <div v-if="batchMode" class="sessions-page__batchbar">
      <label class="batchbar__select-all">
        <input type="checkbox" :checked="allSelected" @change="toggleSelectAll" />
        全选
      </label>
      <span class="batchbar__count">已选 {{ selectedIds.size }} 个会话</span>
      <button
        type="button"
        class="batchbar__delete"
        :disabled="!selectedIds.size"
        @click="confirmBatchDelete"
      >
        删除所选
      </button>
    </div>
    <input
      v-model="searchQuery"
      class="sessions-page__search"
      type="search"
      placeholder="搜索会话标题"
      @input="onSearchInput"
      @search="handleSearchClear"
    />
    <div class="sessions-list">
      <div
        v-for="session in store.displayedSessions"
        :key="session.id"
        :class="['session-card', { 'session-card--selected': batchMode && selectedIds.has(session.id) }]"
        @click="batchMode ? toggleSelected(session.id) : openSession(session)"
      >
        <input
          v-if="batchMode"
          class="session-card__check"
          type="checkbox"
          :checked="selectedIds.has(session.id)"
          @click.stop="toggleSelected(session.id)"
        />
        <div class="session-card__name">{{ session.name }}</div>
        <div class="session-card__meta">
          {{ session.model }} · {{ new Date(session.updatedAt).toLocaleString() }}
        </div>
        <button
          v-if="!batchMode"
          type="button"
          class="session-card__delete"
          @click.stop="confirmDelete(session)"
        >
          删除
        </button>
      </div>
      <div v-if="!store.displayedSessions.length" class="empty">
        {{ searchQuery.trim() ? '未找到匹配的会话' : '暂无会话' }}
      </div>
    </div>
  </section>
</template>

<style scoped>
.sessions-page {
  /* 独立滚动区：外层 workspace-main overflow hidden，长列表在此自身滚动。
     width:100% + max-width + margin:0 auto 让整块内容在中间工作区内水平居中。 */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 32px;
  width: 100%;
  max-width: 800px;
  margin: 0 auto;
}

.sessions-page__header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  margin-bottom: 24px;
}

.sessions-page__actions {
  display: flex;
  gap: 8px;
}

.sessions-page__create {
  border: 0;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: var(--color-on-accent);
  box-shadow: var(--ring-light-accent);
  padding: 8px 16px;
  font-weight: 700;
}

.sessions-page__batch {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  padding: 8px 16px;
  font-weight: 600;
}

.sessions-page__batch--active {
  border-color: var(--color-danger);
  color: var(--color-danger);
}

.sessions-page__batchbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
}

.batchbar__select-all {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8125rem;
  cursor: pointer;
}

.batchbar__count {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
}

.batchbar__delete {
  margin-left: auto;
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-danger);
  padding: 4px 12px;
  font-size: 0.8125rem;
}

.batchbar__delete:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.sessions-page__search {
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 9px 10px;
  outline: none;
  margin-bottom: 16px;
}

.sessions-list {
  display: grid;
  gap: 12px;
}

.session-card {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  padding: 14px 16px;
  cursor: pointer;
  box-shadow: var(--ring-light), var(--elevation-1);
  transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}

.session-card:hover {
  border-color: var(--color-accent);
  box-shadow: var(--ring-light), var(--elevation-2);
}

.session-card--selected {
  border-color: var(--color-accent);
}

.session-card__check {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.session-card__name {
  font-weight: 600;
}

.session-card__meta {
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

.session-card__delete {
  margin-left: auto;
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-danger);
  padding: 4px 10px;
  font-size: 0.75rem;
}

.empty {
  color: var(--color-text-muted);
  text-align: center;
  padding: 40px;
}
</style>
