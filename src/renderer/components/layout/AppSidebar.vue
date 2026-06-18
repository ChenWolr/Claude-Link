<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../../stores/session-store';

const store = useSessionStore();
const router = useRouter();
const searchQuery = ref('');

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

onMounted(() => {
  store.loadSessions();
});

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});

async function handleNewSession() {
  const session = await store.createSession(`会话 ${store.sessions.length + 1}`);
  if (session) {
    await store.switchSession(session);
    router.push('/');
  }
}

async function openSession(session: { id: string }) {
  const found = store.sessions.find((s) => s.id === session.id);
  if (found) {
    await store.switchSession(found);
    router.push('/');
  }
}

// 恢复 IPC 内容搜索：主进程 searchSessions 同时匹配会话名与消息内容，
// 客户端只搜 name 会丢失"按对话内容找会话"的能力。250ms 防抖避免每键一次 IPC。
function onSearchInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  const q = searchQuery.value.trim();
  if (!q) {
    store.loadSessions();
    return;
  }
  debounceTimer = setTimeout(() => {
    store.searchSessions(q);
  }, 250);
}

function handleSearchClear() {
  searchQuery.value = '';
  store.loadSessions();
}

// 删除会话：用浏览器原生确认，避免误删。会话及消息由主进程级联清理。
async function confirmDelete(session: { id: string; name: string }) {
  if (!window.confirm(`确定删除会话「${session.name}」？此操作不可撤销。`)) return;
  await store.deleteSession(session.id);
}

const sessionList = computed(() => store.sessions);
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar__brand">
      <div class="brand-mark">CL</div>
      <div>
        <h1>Claude Link</h1>
        <p>Task Console</p>
      </div>
    </div>

    <input
      v-model="searchQuery"
      class="sidebar__search"
      type="search"
      placeholder="搜索会话"
      @input="onSearchInput"
      @search="handleSearchClear"
    />

    <nav class="sidebar__sessions">
      <div
        v-for="session in sessionList"
        :key="session.id"
        :class="['session-link', { active: store.activeSession?.id === session.id }]"
        @click="openSession(session)"
      >
        <span class="session-link__name">{{ session.name }}</span>
        <button
          type="button"
          class="session-link__delete"
          title="删除会话"
          @click.stop="confirmDelete(session)"
        >
          ×
        </button>
      </div>
      <div v-if="!sessionList.length" class="sidebar__empty">
        {{ searchQuery ? '未找到匹配的会话' : '暂无会话' }}
      </div>
    </nav>

    <div class="sidebar__footer">
      <button class="new-button" type="button" @click="handleNewSession">+ 新会话</button>
      <RouterLink class="settings-link" to="/config">配置</RouterLink>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  width: var(--sidebar-width);
  min-width: var(--sidebar-width);
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  background: #11151d;
  padding: 16px 12px;
}

.sidebar__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
}

.brand-mark {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: #07120d;
  font-size: 13px;
  font-weight: 800;
}

.sidebar__brand h1 {
  margin: 0;
  font-size: 15px;
}

.sidebar__brand p {
  margin: 2px 0 0;
  color: var(--color-text-muted);
  font-size: 12px;
}

.sidebar__search {
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 9px 10px;
  outline: none;
}

.sidebar__sessions {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  margin-top: 16px;
  overflow-y: auto;
}

.session-link {
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius-md);
  padding: 10px 11px;
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;
}

.session-link__name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-link__delete {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}

.session-link:hover .session-link__delete {
  opacity: 0.8;
}

.session-link__delete:hover {
  opacity: 1;
  background: rgba(239, 100, 97, 0.18);
  color: var(--color-danger);
}

.session-link:hover {
  background: var(--color-panel-soft);
}

.session-link.active {
  background: var(--color-panel-soft);
  border-left: 3px solid var(--color-accent);
  padding-left: 8px;
}

.sidebar__empty {
  color: var(--color-text-muted);
  font-size: 13px;
  padding: 12px;
  text-align: center;
}

.sidebar__footer {
  display: grid;
  gap: 8px;
}

.new-button,
.settings-link {
  border-radius: var(--radius-md);
  padding: 10px 11px;
  color: var(--color-text);
}

.new-button {
  border: 0;
  background: var(--color-accent);
  color: #07120d;
  font-weight: 700;
}

.settings-link {
  display: block;
  border: 1px solid var(--color-border);
  text-align: center;
}
</style>
