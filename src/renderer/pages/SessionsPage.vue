<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session-store';

const store = useSessionStore();
const router = useRouter();
const searchQuery = ref('');
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

onMounted(() => {
  store.loadSessions();
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

async function createAndNavigate() {
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
</script>

<template>
  <section class="sessions-page">
    <header class="sessions-page__header">
      <div>
        <p class="eyebrow">Sessions</p>
        <h1>会话管理</h1>
      </div>
      <button type="button" @click="createAndNavigate">+ 新建会话</button>
    </header>
    <input
      v-model="searchQuery"
      class="sessions-page__search"
      type="search"
      placeholder="搜索会话（名称或对话内容）"
      @input="onSearchInput"
      @search="handleSearchClear"
    />
    <div class="sessions-list">
      <div
        v-for="session in store.displayedSessions"
        :key="session.id"
        class="session-card"
        @click="openSession(session)"
      >
        <div class="session-card__name">{{ session.name }}</div>
        <div class="session-card__meta">
          {{ session.model }} · {{ new Date(session.updatedAt).toLocaleString() }}
        </div>
        <button
          type="button"
          class="session-card__delete"
          @click.stop="store.deleteSession(session.id)"
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
  padding: 32px;
  max-width: 800px;
}

.sessions-page__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}

.eyebrow {
  margin: 0 0 4px;
  color: var(--color-accent-strong);
  font-size: 12px;
  font-weight: 700;
}

.sessions-page__header h1 {
  margin: 0;
  font-size: 24px;
}

.sessions-page__header button {
  border: 0;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: #07120d;
  padding: 8px 16px;
  font-weight: 700;
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
  transition: border-color 0.15s;
}

.session-card:hover {
  border-color: var(--color-accent);
}

.session-card__name {
  font-weight: 600;
}

.session-card__meta {
  color: var(--color-text-muted);
  font-size: 12px;
}

.session-card__delete {
  margin-left: auto;
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-danger);
  padding: 4px 10px;
  font-size: 12px;
}

.empty {
  color: var(--color-text-muted);
  text-align: center;
  padding: 40px;
}
</style>
