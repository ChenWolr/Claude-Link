<script setup lang="ts">
// ProcessGroup —— openhanako 风格的「过程折叠」。
// 一整段连续过程（思考 + 工具）合并成一个 fold：折叠态是一行居中摘要
// 「✨ Claude 忙活了一阵子 · N 个工具 · N 次思考 ›」，展开态是半透明 panel 内的行式列表。
// 少于 MIN_FOLD 条过程不折叠（直接展开行式）。对齐 openhanako ProcessFoldBlock。
import { ref, computed } from 'vue';
import type { Message } from '../../../shared/types/session';
import { isFoldable, type FoldStats } from '../../utils/group-messages';
import { useSessionStore } from '../../stores/session-store';
import ThinkingBlock from './ThinkingBlock.vue';
import ToolCallBlock from './ToolCallBlock.vue';

const store = useSessionStore();

// C：后台任务反查——该 toolUseId 是否有运行中的后台任务（task_* 的 toolUseId 匹配）。
// 主流程工具行据此标注「后台运行中」（后台 Bash 的 tool_result 已回但实际后台仍在跑）。
const backgroundToolUseIds = computed(() => {
  const ids = new Set<string>();
  for (const t of Object.values(store.backgroundTasks)) {
    if (t.toolUseId && !t.status) ids.add(t.toolUseId);
  }
  return ids;
});

const props = defineProps<{
  messages: Message[];
  stats: FoldStats;
  active?: boolean;
}>();

const foldable = computed(() => isFoldable(props.messages.length));
// 焦点跟随：发送中末组 active 自动展开；不可折叠的 fold 强制展开行式。
const manualOpen = ref<null | boolean>(null);
const open = computed(() => manualOpen.value ?? (props.active || !foldable.value));
function toggle(): void {
  manualOpen.value = !open.value;
}

// 居中摘要（对齐 openhanako buildProcessFoldSummary）。
const summary = computed(() => {
  const parts = ['✨ Claude 忙活了一阵子'];
  if (props.stats.toolCount > 0) parts.push(`${props.stats.toolCount} 个工具`);
  if (props.stats.thinkingCount > 0) parts.push(`${props.stats.thinkingCount} 次思考`);
  return parts.join(' · ');
});

interface GroupItem {
  key: string;
  type: 'thinking' | 'tool' | 'system';
  msg?: Message;
  use?: Message | null;
  result?: Message | null;
}

// 按 toolUseId 把 tool_use 与 tool_result 配对成一项（行式合并）；保留原顺序。
const items = computed<GroupItem[]>(() => {
  const resultByToolUseId = new Map<string, Message>();
  for (const m of props.messages) {
    if (m.eventType === 'tool_result' && m.toolUseId) resultByToolUseId.set(m.toolUseId, m);
  }
  const consumed = new Set<string>();
  const out: GroupItem[] = [];
  for (const m of props.messages) {
    if (m.eventType === 'thinking') {
      out.push({ key: m.id, type: 'thinking', msg: m });
    } else if (m.eventType === 'tool_use') {
      const result = m.toolUseId ? resultByToolUseId.get(m.toolUseId) ?? null : null;
      if (result) consumed.add(result.id);
      out.push({ key: m.id, type: 'tool', use: m, result });
    } else if (m.eventType === 'system') {
      out.push({ key: m.id, type: 'system', msg: m });
    }
  }
  for (const m of props.messages) {
    if (m.eventType === 'tool_result' && !consumed.has(m.id)) {
      out.push({ key: m.id, type: 'tool', use: null, result: m });
    }
  }
  return out;
});
</script>

<template>
  <div class="process-fold">
    <button
      v-if="foldable"
      type="button"
      class="process-fold__summary"
      :class="{ 'process-fold__summary--open': open }"
      @click="toggle"
    >
      <span class="process-fold__title">
        <span class="process-fold__text">{{ summary }}</span>
        <span v-if="stats.running" class="process-fold__dots">···</span>
        <span class="process-fold__arrow">›</span>
      </span>
    </button>
    <div v-if="open" class="process-fold__panel">
      <template v-for="item in items" :key="item.key">
        <ThinkingBlock
          v-if="item.type === 'thinking'"
          :content="item.msg!.content"
          :sealed="!stats.running"
        />
        <div v-else-if="item.type === 'system'" class="process-fold__system">
          <span>ℹ️ {{ item.msg!.content }}</span>
        </div>
        <ToolCallBlock
          v-else
          :use="item.use ?? null"
          :result="item.result ?? null"
          :running="stats.running && !item.result"
          :elapsedSeconds="item.use?.toolUseId ? store.toolProgress[item.use.toolUseId] : undefined"
          :backgroundRunning="item.use?.toolUseId ? backgroundToolUseIds.has(item.use.toolUseId) : false"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 居中、轻量的折叠摘要（对齐 openhanako processFoldSummary：justify-content:center）。 */
.process-fold {
  width: 100%;
}

.process-fold__summary {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 8px 0;
  padding: 6px 12px;
  background: transparent;
  border: 0;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  cursor: pointer;
  font-family: inherit;
  border-radius: var(--radius-sm);
  transition: background 0.15s, color 0.15s;
}

.process-fold__summary:hover {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  color: var(--color-text);
}

.process-fold__summary--open {
  margin-bottom: 0;
}

.process-fold__title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  min-width: 0;
}

.process-fold__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
}

.process-fold__dots {
  color: var(--color-accent-strong);
  letter-spacing: 0.12em;
  font-weight: 700;
}

.process-fold__arrow {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  transition: transform 0.15s;
}

.process-fold__summary--open .process-fold__arrow {
  transform: rotate(90deg);
}

/* 展开态 panel：半透明背景（对齐 openhanako processFoldPanel overlay-subtle 62%）。 */
.process-fold__panel {
  width: 100%;
  box-sizing: border-box;
  margin: 0 0 16px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-panel-soft) 62%, transparent);
}

.process-fold__system {
  padding: 4px 8px;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}
</style>
