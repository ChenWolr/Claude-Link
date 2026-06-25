<script setup lang="ts">
import { ref, computed } from 'vue';
import type { Message } from '../../../shared/types/session';
import ThinkingBlock from './ThinkingBlock.vue';
import ToolCallBlock from './ToolCallBlock.vue';

const props = defineProps<{ messages: Message[] }>();
const open = ref(false);

const thinkingCount = computed(() => props.messages.filter((m) => m.eventType === 'thinking').length);

const toolUseMessages = computed(() => props.messages.filter((m) => m.eventType === 'tool_use'));

// 提取去重的工具名，让摘要更有信息量（如"🔧 3 次调用（Read、Bash、Write）"）。
const toolNames = computed(() => {
  const names: string[] = [];
  for (const m of toolUseMessages.value) {
    try {
      const parsed = JSON.parse(m.content) as { name?: string };
      if (parsed.name && !names.includes(parsed.name)) names.push(parsed.name);
    } catch {
      /* ignore */
    }
  }
  return names;
});

const summary = computed(() => {
  const parts: string[] = [];
  if (thinkingCount.value) parts.push(`💭 ${thinkingCount.value} 段思考`);
  if (toolUseMessages.value.length) {
    const names = toolNames.value.length ? `（${toolNames.value.join('、')}）` : '';
    parts.push(`🔧 ${toolUseMessages.value.length} 次工具调用${names}`);
  }
  return parts.join(' · ') || '中间过程';
});
</script>

<template>
  <div class="process-group">
    <button type="button" class="process-group__header" @click="open = !open">
      <span class="process-group__icon">{{ open ? '▾' : '▸' }}</span>
      <span class="process-group__summary">{{ summary }}</span>
      <span class="process-group__toggle">{{ open ? '收起' : '展开详情' }}</span>
    </button>
    <div v-if="open" class="process-group__body">
      <template v-for="msg in messages" :key="msg.id">
        <ThinkingBlock v-if="msg.eventType === 'thinking'" :content="msg.content" :default-open="true" />
        <ToolCallBlock v-else :message="msg" :default-open="true" />
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 左侧色条 + 低调背景，避免多条独立边框堆叠成"横线"感。 */
.process-group {
  align-self: flex-start;
  width: 100%;
  max-width: 90%;
  border-left: 2px solid var(--color-border);
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  background: var(--color-panel);
  overflow: hidden;
}

.process-group__header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  padding: 8px 12px;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, color 0.15s;
}

.process-group__header:hover {
  background: var(--color-panel-soft);
  color: var(--color-text);
}

.process-group__icon {
  font-size: 10px;
  flex-shrink: 0;
}

.process-group__summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.process-group__toggle {
  flex-shrink: 0;
  font-size: 11px;
  opacity: 0.7;
}

.process-group__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 12px 12px;
}

/* 内部块在过程组内占满宽度，不各自缩窄。 */
.process-group__body :deep(.thinking),
.process-group__body :deep(.tool-call) {
  max-width: 100%;
  align-self: stretch;
}
</style>
