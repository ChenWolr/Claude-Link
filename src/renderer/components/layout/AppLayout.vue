<script setup lang="ts">
import { ref } from 'vue';
import AppHeader from './AppHeader.vue';
import AppSidebar from './AppSidebar.vue';
import TaskQueuePanel from '../task/TaskQueuePanel.vue';

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
    <TaskQueuePanel v-if="isTaskPanelOpen" />
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
}

.workspace-main {
  min-height: 0;
  flex: 1;
  overflow: hidden;
}

.reopen-task-panel {
  position: fixed;
  right: 12px;
  top: 84px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 8px 10px;
}
</style>
