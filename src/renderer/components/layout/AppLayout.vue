<script setup lang="ts">
import { ref } from 'vue';
import AppHeader from './AppHeader.vue';
import AppSidebar from './AppSidebar.vue';

const isTaskPanelOpen = ref(true);
</script>

<template>
  <div class="app-shell">
    <AppSidebar />
    <section class="workspace">
      <AppHeader />
      <main class="workspace-main">
        <slot />
      </main>
    </section>
    <aside v-if="isTaskPanelOpen" class="task-panel">
      <header class="task-panel__header">
        <div>
          <p class="eyebrow">Queue</p>
          <h2>任务队列</h2>
        </div>
        <button class="icon-button" type="button" @click="isTaskPanelOpen = false">×</button>
      </header>
      <div class="task-panel__empty">等待添加任务</div>
    </aside>
    <button v-else class="reopen-task-panel" type="button" @click="isTaskPanelOpen = true">队列</button>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  width: 100vw;
  height: 100vh;
  background: var(--color-bg);
}

.workspace {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
}

.workspace-main {
  min-height: 0;
  flex: 1;
  overflow: auto;
}

.task-panel {
  width: var(--task-panel-width);
  min-width: var(--task-panel-width);
  background: var(--color-panel);
  border-left: 1px solid var(--color-border);
}

.task-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 72px;
  padding: 0 16px;
  border-bottom: 1px solid var(--color-border);
}

.task-panel__header h2 {
  margin: 2px 0 0;
  font-size: 16px;
  font-weight: 650;
}

.eyebrow {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 11px;
  letter-spacing: 0;
  text-transform: uppercase;
}

.icon-button,
.reopen-task-panel {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  color: var(--color-text);
}

.icon-button {
  width: 30px;
  height: 30px;
}

.reopen-task-panel {
  position: fixed;
  right: 12px;
  top: 84px;
  padding: 8px 10px;
}

.task-panel__empty {
  padding: 18px 16px;
  color: var(--color-text-muted);
  font-size: 13px;
}
</style>
