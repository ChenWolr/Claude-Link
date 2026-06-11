<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session-store';

const store = useSessionStore();
const router = useRouter();

onMounted(() => {
  store.loadSessions();
});

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
    <div class="sessions-list">
      <div
        v-for="session in store.sessions"
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
      <div v-if="!store.sessions.length" class="empty">暂无会话</div>
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
