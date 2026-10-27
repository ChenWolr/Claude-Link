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
    <!-- round-002 F1：force=true 绕 F-5 同源守卫——这是用户唯一的手动强制重扫入口，
         同 id/wd 点击不得被直呼守卫短路；不 invalidateDiffs，保留 diffCache 收窄逻辑。 -->
    <button type="button" class="btn" :disabled="store.loading" title="重新扫描工作目录改动" @click="store.refresh(false, true)">
      {{ store.loading ? '刷新中…' : '刷新' }}
    </button>
  </header>

  <!-- P6-R1 + round-002 F2：失败横条 keyed on refreshFailed（非失败态 error——如 !wd 的
       「无会话」提示、ensureDiff 的共享写入——不再被误渲染成「刷新失败…已保留上次列表」）；
       「已保留上次列表」仅 files 非空（reject 保留旧列表，陈旧优于假空态）时拼接，not-ok
       清空后不误述。「重试」refresh(true)：invalidateDiffs 绕过 F-5 同源守卫强制重拉。
       error 写入文本与位置一律不动（既有契约，ensureDiff 兼容）。 -->
  <div v-if="store.refreshFailed" class="changes__error">
    <span class="changes__error-text">刷新失败：{{ store.error }}{{ store.files.length > 0 ? '，已保留上次列表' : '' }}</span>
    <button type="button" class="btn" :disabled="store.loading" title="重新拉取改动列表" @click="store.refresh(true)">重试</button>
  </div>
  <!-- 空态三级化（round-002 F2）：无会话/无 wd → 「当前没有活动会话或工作目录」；
       失败且列表空 → 横条已示错，不再叠加「工作目录无改动」假象；
       仅非失败、非加载且确无改动才显「工作目录无改动」。 -->
  <div v-if="store.sessionless" class="changes__empty">当前没有活动会话或工作目录</div>
  <div v-else-if="!store.refreshFailed && !store.files.length && !store.loading" class="changes__empty">工作目录无改动</div>

  <ul v-if="store.files.length" class="changes__list">
    <!-- hb10-CHG-11：万级文件截断——前 500 条 + 汇总行（列表冻结防护） -->
    <li
      v-for="f in store.files.slice(0, 500)"
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
    <!-- hb10-CHG-11：截断汇总行 -->
    <li v-if="store.files.length > 500" class="changes__row changes__row--more">
      <span class="changes__path">其余 {{ store.files.length - 500 }} 条未显示（请缩小改动范围）</span>
    </li>
  </ul>
</template>

<style scoped>
/* hb13-v 批C：原文件尾部游离死注释「截断行样式」已删；changes__row--more 沿用
   changes__row 既有行样式（scoped 内无独立规则，如需差异化样式再补）。 */
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

/* P6-R1：刷新失败横条——对齐面板既有 token（--color-danger / --radius-sm / color-mix），
   横条形态对齐 changes__baseline 等顶部信息行的紧凑密度；重试按钮复用 .btn。 */
.changes__error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 12px 6px;
  padding: 6px 10px;
  border: 1px solid color-mix(in srgb, var(--color-danger) 35%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-danger) 8%, transparent);
}
.changes__error-text {
  flex: 1;
  min-width: 0;
  font-size: 0.75rem;
  line-height: 1.4;
  color: var(--color-danger);
  word-break: break-word;
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
