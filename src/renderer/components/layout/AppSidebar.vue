<script setup lang="ts">
import { onMounted } from 'vue';
import { useSessionStore } from '../../stores/session-store';

const store = useSessionStore();

onMounted(() => {
  store.loadSessions();
});

async function handleNewSession() {
  await store.createSession(`会话 ${store.sessions.length + 1}`);
}

async function openSession(session: { id: string }) {
  const found = store.sessions.find((s) => s.id === session.id);
  if (found) {
    await store.switchSession(found);
  }
}
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

    <input class="sidebar__search" type="search" placeholder="搜索会话" />

    <nav class="sidebar__sessions">
      <div
        v-for="session in store.sessions"
        :key="session.id"
        :class="['session-link', { active: store.activeSession?.id === session.id }]"
        @click="openSession(session)"
      >
        {{ session.name }}
      </div>
      <div v-if="!store.sessions.length" class="sidebar__empty">暂无会话</div>
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
  border-radius: var(--radius-md);
  padding: 10px 11px;
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
