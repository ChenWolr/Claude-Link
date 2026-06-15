<script setup lang="ts">
import { useSessionStore } from '../../stores/session-store';

const sessionStore = useSessionStore();
</script>

<template>
  <header class="app-header">
    <div>
      <p class="app-header__label">当前会话</p>
      <h2>{{ sessionStore.activeSession?.name ?? '未选择会话' }}</h2>
    </div>
  </header>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  height: 56px;
  padding: 0 24px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-panel);
}

.app-header__label {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 12px;
}

.app-header h2 {
  margin: 2px 0 0;
  font-size: 18px;
  font-weight: 650;
}
</style>
