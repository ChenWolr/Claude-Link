<script setup lang="ts">
// ChangesPanel —— 右侧「改动」Tab 的面板体。
// 列出 workingDir 的 git 改动文件（状态码 + 路径 + +/- 计数 + 本次会话编辑标注），
// 点文件 → 弹出 DiffDialog 并排对比（取代旧的内联 diff2html 展开）。
import { computed, onMounted } from 'vue';
import { useChangesStore } from '../../stores/changes-store';
import { openDiffDialog } from '../../composables/useDiffDialog';

const store = useChangesStore();

const statusLabel: Record<string, string> = { M: '改', A: '增', D: '删', R: '移', '??': '新', U: '冲' };

// diff 对比基线 HEAD 的短 SHA（明文回显「这 diff 是跟谁比的」，契合项目明文回显偏好）。
const baselineShort = computed(() => (store.baselineRef ? store.baselineRef.slice(0, 7) : ''));

function openFile(path: string, e: MouseEvent): void {
  openDiffDialog(path, e.currentTarget instanceof HTMLElement ? e.currentTarget : null);
}

onMounted(() => {
  void store.refresh();
});
</script>

<template>
  <header class="changes__header">
    <div>
      <p class="eyebrow">Changes</p>
      <h2>改动 <span class="changes__count">{{ store.changedCount }}</span></h2>
      <p v-if="baselineShort" class="changes__baseline" title="diff 对比基线">对比 HEAD {{ baselineShort }}</p>
    </div>
    <button type="button" class="btn" :disabled="store.loading" title="重新扫描工作目录改动" @click="store.refresh()">
      {{ store.loading ? '刷新中…' : '刷新' }}
    </button>
  </header>

  <div v-if="store.error" class="changes__empty">{{ store.error }}</div>
  <div v-else-if="!store.files.length && !store.loading" class="changes__empty">工作目录无改动</div>

  <ul v-else class="changes__list">
    <li
      v-for="f in store.files"
      :key="f.path"
      class="changes__row"
      :class="{ 'changes__row--touched': f.touchedThisSession }"
    >
      <button type="button" class="changes__row-main" :title="`查看 ${f.path} 的对比`" @click="openFile(f.path, $event)">
        <span class="changes__status" :data-status="f.status">{{ statusLabel[f.status] ?? f.status }}</span>
        <span class="changes__path" :title="f.path">{{ f.path }}</span>
        <span v-if="f.additions != null" class="changes__counts">
          <span class="changes__add">+{{ f.additions }}</span>
          <span class="changes__del">−{{ f.deletions }}</span>
        </span>
        <span v-if="f.touchedThisSession" class="changes__touched" title="本次会话编辑过">●</span>
      </button>
    </li>
  </ul>
</template>

<style scoped>
.changes__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px 6px;
}
.changes__header h2 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-text);
}
.changes__count {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
  border-radius: 999px;
  padding: 1px 7px;
}
.changes__baseline {
  margin: 2px 0 0;
  font-size: 0.65rem;
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.eyebrow {
  font-size: 0.625rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
  margin: 0;
}
.btn {
  font: inherit;
  font-size: 0.7rem;
  padding: 3px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  color: var(--color-text);
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  border-color: var(--color-accent-strong);
  color: var(--color-accent-strong);
}
.btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.changes__empty {
  padding: 24px 16px;
  text-align: center;
  font-size: 0.8rem;
  color: var(--color-text-muted);
}

.changes__list {
  list-style: none;
  margin: 0;
  padding: 0 6px 8px;
}
.changes__row {
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
}
.changes__row--touched {
  background: color-mix(in srgb, var(--color-accent) 6%, transparent);
}
.changes__row-main {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  text-align: left;
  border-radius: var(--radius-sm);
}
.changes__row-main:hover {
  background: color-mix(in srgb, var(--color-text) 5%, transparent);
}
.changes__status {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.6875rem;
  font-weight: 700;
  border-radius: 4px;
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
}
.changes__status[data-status='A'],
.changes__status[data-status='??'] {
  color: var(--color-accent-strong);
}
.changes__status[data-status='D'] {
  color: var(--color-danger);
}
.changes__path {
  flex: 1;
  min-width: 0;
  font-size: 0.78rem;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.changes__counts {
  flex-shrink: 0;
  display: inline-flex;
  gap: 6px;
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}
.changes__add {
  color: var(--color-accent-strong);
}
.changes__del {
  color: var(--color-danger);
}
.changes__touched {
  flex-shrink: 0;
  font-size: 0.6rem;
  color: var(--color-accent-strong);
}
</style>
