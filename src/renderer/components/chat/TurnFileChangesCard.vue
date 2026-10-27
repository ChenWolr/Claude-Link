<script setup lang="ts">
// TurnFileChangesCard —— 轮末文件改动折叠卡（计划 §4-P5）：挂在回合最终 assistant 正文气泡
// 之后，默认折叠。头部一眼看出「本回合动了 N 个文件、±多少行」；展开逐文件行，行点击
// emit('open') 交父级（MessageList）打开 TurnDiffDialog 懒加载 patch。
//
// 口径：mode='unavailable' 文件计入 N 但不计入 ±（无可靠计数）；+a/-d 仅 >0 才显示；
// 'unavailable' 行禁用点击（无 patch 可看）。样式 token 复用现有体系：折叠徽标语义对齐
// ToolCallBlock 折叠 +/−（等宽小字 + tabular-nums + 绿/红），容器/行格配色对齐 TaskQueuePanel
// 指标格（panel-soft + border 圆角格）；不引新依赖。
import { computed, ref, useId } from 'vue';
import type { TurnFileDiffItem, TurnFileDiffTurnSummary } from '../../../shared/types/turn-file-diff';

const props = defineProps<{ summary: TurnFileDiffTurnSummary }>();
const emit = defineEmits<{ (e: 'open', item: TurnFileDiffItem): void }>();

const expanded = ref(false);
// 无障碍：折叠头按钮 aria-controls 指向展开区面板 id（对齐 ToolCallBlock.vue 既有水位写法）。
const panelId = useId();
function toggle(): void {
  expanded.value = !expanded.value;
}

const fileCount = computed(() => props.summary.items.length);
// 合计 ±：unavailable 文件显式跳过（其 additions/deletions 恒 0，结果一致，但口径在此显式化）。
const totals = computed(() => {
  let add = 0;
  let del = 0;
  for (const it of props.summary.items) {
    if (it.mode === 'unavailable') continue;
    add += it.additions;
    del += it.deletions;
  }
  return { add, del };
});

// 路径拆分：basename（粗体）+ 目录前缀（浅色 truncate）；兼容 \ / 两种分隔符（Windows 工作目录）。
function basename(path: string): string {
  const segs = path.split(/[\\/]/);
  return segs[segs.length - 1] || path;
}
function dirOf(path: string): string {
  const segs = path.split(/[\\/]/);
  segs.pop();
  return segs.join('/');
}
function onRowClick(item: TurnFileDiffItem): void {
  if (item.mode === 'unavailable') return; // 该行禁用点击（无 patch 可预览）
  emit('open', item);
}
</script>

<template>
  <div class="turn-diff-card">
    <button type="button" class="turn-diff-card__head" :aria-expanded="expanded" :aria-controls="panelId" @click="toggle">
      <svg
        class="turn-diff-card__chev"
        :class="{ 'is-open': expanded }"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
      ><polyline points="9 6 15 12 9 18" /></svg>
      <span class="turn-diff-card__title">{{ fileCount }} 个文件已更改</span>
      <span class="turn-diff-card__counts" title="本回合新增 / 删除行数（无法统计的文件不计入）">
        <span v-if="totals.add > 0" class="turn-diff-card__add">+{{ totals.add }}</span>
        <span v-if="totals.del > 0" class="turn-diff-card__del">−{{ totals.del }}</span>
      </span>
    </button>
    <ul v-if="expanded" :id="panelId" class="turn-diff-card__list">
      <li v-for="item in summary.items" :key="item.path">
        <button
          type="button"
          class="turn-diff-card__row"
          :disabled="item.mode === 'unavailable'"
          :title="item.mode === 'unavailable' ? '二进制或快照缺失，无法对比' : `${dirOf(item.path)}/${basename(item.path)}`"
          @click="onRowClick(item)"
        >
          <span class="turn-diff-card__file">
            <span v-if="dirOf(item.path)" class="turn-diff-card__dir">{{ dirOf(item.path) }}/</span><b class="turn-diff-card__name">{{ basename(item.path) }}</b>
          </span>
          <span class="turn-diff-card__meta">
            <span v-if="item.additions > 0" class="turn-diff-card__add">+{{ item.additions }}</span>
            <span v-if="item.deletions > 0" class="turn-diff-card__del">−{{ item.deletions }}</span>
            <span class="turn-diff-card__writes">{{ item.writeCount }} 次编辑</span>
            <span v-if="item.mode === 'first-change'" class="turn-diff-card__badge">首改</span>
            <span v-else-if="item.mode === 'unavailable'" class="turn-diff-card__badge turn-diff-card__badge--muted">二进制或快照缺失</span>
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.turn-diff-card {
  max-width: 752px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  overflow: hidden;
}

/* 头部：chevron + 标题 + 合计徽标（等宽小字 tabular-nums，对齐 ToolCallBlock 折叠徽标语义） */
.turn-diff-card__head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  font: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.turn-diff-card__head:hover {
  background: color-mix(in srgb, var(--color-text) 4%, transparent);
}
.turn-diff-card__head:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
.turn-diff-card__chev {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  transition: transform var(--duration-fast) var(--ease-out);
}
.turn-diff-card__chev.is-open {
  transform: rotate(90deg);
}
.turn-diff-card__title {
  color: var(--color-text);
}
.turn-diff-card__counts {
  margin-left: auto;
  display: inline-flex;
  gap: 6px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}
/* 绿增 / 红删 token（+A 绿 / -D 红） */
.turn-diff-card__add {
  color: var(--color-success);
  font-weight: 700;
}
.turn-diff-card__del {
  color: var(--color-danger);
  font-weight: 700;
}

/* 展开列表：逐文件行（格配色对齐 TaskQueuePanel 指标格） */
.turn-diff-card__list {
  list-style: none;
  margin: 0;
  padding: 0 6px 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.turn-diff-card__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 5px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--color-panel);
  color: var(--color-text);
  font: inherit;
  font-size: 0.75rem;
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.turn-diff-card__row:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-panel));
}
.turn-diff-card__row:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
.turn-diff-card__row:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}
.turn-diff-card__file {
  min-width: 0;
  flex: 1;
  display: inline-flex;
  align-items: baseline;
  overflow: hidden;
  white-space: nowrap;
}
/* 目录前缀：浅色 truncate（超长时截尾），文件名粗体不截断 */
.turn-diff-card__dir {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
  opacity: 0.8;
}
.turn-diff-card__name {
  flex: 0 0 auto;
  font-weight: 700;
}
.turn-diff-card__meta {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}
.turn-diff-card__writes {
  color: var(--color-text-muted);
}
/* mode 徽标：first-change → 首改（accent）；unavailable → 二进制或快照缺失（muted） */
.turn-diff-card__badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 0.625rem;
  font-weight: 700;
  font-family: var(--font-sans);
  color: var(--color-accent-strong);
  background: color-mix(in srgb, var(--color-accent) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-accent) 35%, transparent);
  white-space: nowrap;
}
.turn-diff-card__badge--muted {
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-text) 5%, transparent);
  border-color: var(--color-border);
}
</style>
