<script setup lang="ts">
import { computed } from 'vue';
import { SLASH_COMMANDS } from '../../../shared/constants';

const emit = defineEmits<{
  sendCommand: [command: string];
  compress: [];
}>();

const quickCommands = computed(() =>
  SLASH_COMMANDS.filter((c) => ['/compact', '/cost', '/init'].includes(c.name)),
);
</script>

<template>
  <div class="command-toolbar">
    <button type="button" class="toolbar-btn toolbar-btn--compress" @click="emit('compress')">
      压缩上下文
    </button>
    <button
      v-for="cmd in quickCommands"
      :key="cmd.name"
      type="button"
      class="toolbar-btn"
      @click="emit('sendCommand', cmd.name)"
    >
      {{ cmd.name }}
    </button>
    <button
      type="button"
      class="toolbar-btn toolbar-btn--more"
      title="更多命令"
      @click="emit('sendCommand', '/help')"
    >
      /更多
    </button>
  </div>
</template>

<style scoped>
.command-toolbar {
  display: flex;
  gap: 6px;
  max-width: 800px;
  margin: 0 auto;
  padding: 4px 24px;
}

.toolbar-btn {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}

.toolbar-btn:hover {
  background: var(--color-panel);
  color: var(--color-text);
}

.toolbar-btn--compress {
  border-color: var(--color-accent);
  color: var(--color-accent-strong);
  background: rgba(58, 166, 117, 0.06);
}

.toolbar-btn--more {
  color: var(--color-text-muted);
}
</style>
