<script setup lang="ts">
// DiffSidebar —— 弹窗内左侧改动文件列表（与右侧 ChangesPanel 列表视觉同源，可点选切换当前文件）。
import { computed } from 'vue';
import type { ChangedFile } from '../../../shared/types/changes';

const props = defineProps<{
  files: ChangedFile[];
  currentPath: string;
}>();
const emit = defineEmits<{ (e: 'select', path: string): void }>();

const STATUS_LABEL: Record<string, string> = { M: '改', A: '增', D: '删', R: '移', '??': '新', U: '冲' };

// 路径拆 dir/name：尾部文件名加粗，前缀目录淡化（原型 sf-path 结构）。
const items = computed(() =>
  props.files.map((f) => {
    const segs = f.path.split('/');
    const name = segs.pop() ?? f.path;
    return { f, dir: segs.join('/'), name };
  }),
);
function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s;
}
</script>

<template>
  <aside class="diff-sidebar" aria-label="改动文件列表">
    <div class="diff-sidebar__header">
      <p class="diff-sidebar__eyebrow">Changes</p>
      <h3 class="diff-sidebar__title">改动文件 <span class="diff-sidebar__count">{{ files.length }}</span></h3>
    </div>
    <ul class="diff-sidebar__list">
      <li v-for="it in items" :key="it.f.path">
        <button
          type="button"
          class="sf-row"
          :class="{ 'is-active': it.f.path === currentPath }"
          :title="it.f.path"
          @click="emit('select', it.f.path)"
        >
          <span class="sf-status" :data-status="it.f.status">{{ statusLabel(it.f.status) }}</span>
          <span class="sf-path"><span v-if="it.dir" class="sf-path__dir">{{ it.dir }}/</span><b>{{ it.name }}</b></span>
          <span v-if="!it.f.binary && it.f.additions != null" class="sf-counts">
            <span class="sf-add">+{{ it.f.additions }}</span>
            <span class="sf-del">−{{ it.f.deletions }}</span>
          </span>
          <span v-if="it.f.touchedThisSession" class="sf-dot" title="本次会话编辑过">●</span>
        </button>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
/* 列表宽度由父 DiffDialog 经 --diff-sidebar-w 控制（拖分隔条实时改） */
.diff-sidebar {
  flex: 0 0 var(--diff-sidebar-w, 212px);
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--color-panel);
}
.diff-sidebar__header {
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--color-border);
  flex: 0 0 auto;
}
.diff-sidebar__eyebrow {
  margin: 0;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}
.diff-sidebar__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 3px 0 0;
  font-size: 13px;
  font-weight: 600;
}
.diff-sidebar__count {
  font-size: 11px;
  color: var(--color-text-muted);
  font-weight: 600;
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
  border-radius: var(--radius-pill);
  padding: 1px 8px;
}
.diff-sidebar__list {
  list-style: none;
  margin: 0;
  padding: 6px 8px;
  overflow-x: hidden;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.diff-sidebar__list li {
  padding: 1px 0;
}
.sf-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  /* 纸面工坊 D5：行高微调对齐原型 .sfile（7px），侧栏唯一改动 */
  padding: 7px 8px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  font: inherit;
  overflow: hidden;
  transition: background var(--duration-fast) var(--ease-out);
}
.sf-row:hover {
  background: color-mix(in srgb, var(--color-text) 5%, transparent);
}
.sf-row:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
.sf-row.is-active {
  background: color-mix(in srgb, var(--color-accent) 14%, transparent);
  box-shadow: inset 2px 0 0 var(--color-accent);
}
.sf-row.is-active .sf-path b {
  color: var(--color-accent-strong);
}
.sf-status {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: inline-grid;
  place-items: center;
  font-size: 11px;
  font-weight: 700;
  border-radius: var(--radius-xs);
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
}
.sf-status[data-status='M'] {
  color: var(--color-warn-strong);
  background: color-mix(in srgb, var(--color-warn) 18%, transparent);
}
.sf-status[data-status='A'],
.sf-status[data-status='??'] {
  color: var(--add-text);
  background: color-mix(in srgb, var(--color-success) 16%, transparent);
}
.sf-status[data-status='D'] {
  color: var(--del-text);
  background: color-mix(in srgb, var(--color-danger) 14%, transparent);
}
.sf-path {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: row-reverse; /* HTML(dir,b) → 视觉：文件名(b)靠左，路径(dir)靠右 */
  align-items: baseline;
  justify-content: flex-end;
  gap: 6px; /* 文件名与路径间空隙 */
  font-size: 11.5px;
  font-family: var(--font-mono);
  color: var(--color-text);
  overflow: hidden;
}
.sf-path__dir {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.6;
}
.sf-path b {
  flex-shrink: 0; /* 文件名不收缩，溢出时路径截断、文件名始终完整可见 */
  font-weight: 600;
  white-space: nowrap;
}
.sf-counts {
  flex-shrink: 0;
  display: inline-flex;
  gap: 5px;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
.sf-add {
  color: var(--add-text);
}
.sf-del {
  color: var(--del-text);
}
.sf-dot {
  flex-shrink: 0;
  font-size: 8px;
  color: var(--color-accent-strong);
}
</style>
