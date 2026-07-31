<script setup lang="ts">
// DiffBody —— diff 渲染器。消费 ParsedDiffFile（diff-parser 输出）渲染并排/内联两种视图。
// 所有 UI 状态（mode/context/ignoreWs/wrap/onlyChanges/curChange）由父 DiffDialog 传入，本组件无状态持有
// （仅 fold/gap 展开态这种纯局部 UI 在内部）。改动导航 curChange 变化时滚到中心 + 闪一下。
//
// split（contrast 风格）：消费 buildSplitRows 的成对行数组（左右等长，数据层对齐，无运行时偏移），
//   单层 v-for splitVisible；box-shadow 画 chunk 上下边框（split-cell 伪元素，不影响行高）；
//   null 占位侧渲染 .line--placeholder。移除了原中缝 ghunk+SVG 三角标记（wrap 下会漂移）。
// inline（cc-haha 风格）：buildInlineRows 摊平 + 上下文规划 + gap 折叠，行号 sticky、三档色。
//
// 性能：不再用 bodyKey + :key 整体重挂；DiffLine 用 v-memo 锁 line 对象 identity——curChange 变化时
//   line 引用不变，命中 v-memo 跳过重渲，仅外层包裹层的 is-current/flash class 变。
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { ParsedDiffFile } from '../../utils/diff-parser';
import type { SplitRow, SplitVisibleItem } from '../../utils/diff-render';
import {
  buildInlineRows,
  buildSplitRows,
  inlineVisiblePlan,
  planSplitVisible,
  type InlineRow,
} from '../../utils/diff-render';
import DiffLine from './DiffLine.vue';

const props = defineProps<{
  parsed: ParsedDiffFile | null;
  mode: 'split' | 'inline';
  context: number;
  ignoreWs: boolean;
  wrap: boolean;
  onlyChanges: boolean;
  curChange: number;
}>();
const emit = defineEmits<{ (e: 'goto-nav', nav: number): void }>();

const bodyEl = ref<HTMLElement | null>(null);
const leftScroll = ref<HTMLElement | null>(null);
const rightScroll = ref<HTMLElement | null>(null);

// —— split：成对行数组 + onlyChanges 折叠 ——
const splitRows = computed(() => (props.parsed ? buildSplitRows(props.parsed, props.ignoreWs) : []));
const expandedSplitFolds = ref<Set<number>>(new Set());
const splitVisible = computed<SplitVisibleItem[]>(() =>
  planSplitVisible(splitRows.value, props.onlyChanges, expandedSplitFolds.value),
);
function toggleSplitFold(id: number): void {
  const next = new Set(expandedSplitFolds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedSplitFolds.value = next;
}
// split 行左右栏 kind 映射（add 左占位、del 右占位由模板的 null 分支处理）
function leftKind(row: SplitRow): string {
  return row.kind === 'del' ? 'del' : row.kind === 'mod' ? 'modl' : 'ctx';
}
function rightKind(row: SplitRow): string {
  return row.kind === 'add' ? 'add' : row.kind === 'mod' ? 'modr' : 'ctx';
}
// 点击改动行 → 跳转导航
function clickRow(navIndex: number | null): void {
  if (navIndex != null && navIndex !== props.curChange) emit('goto-nav', navIndex);
}

// —— inline：扁平行流 + 上下文规划 + gap 折叠 ——
interface InlineSeg {
  kind: 'change' | 'ctx' | 'gap';
  rows: InlineRow[];
  navIndex: number | null;
  gapIndex: number | null;
  firstN: number | null;
  lastN: number | null;
}
const inlineSegs = computed<InlineSeg[]>(() => {
  if (!props.parsed || props.mode !== 'inline') return [];
  const rows = buildInlineRows(props.parsed, props.ignoreWs);
  const vis = inlineVisiblePlan(rows, props.context);
  const out: InlineSeg[] = [];
  let i = 0;
  let nav = 0;
  let gapId = 0;
  while (i < rows.length) {
    const v = vis[i];
    const start = i;
    while (i < rows.length && vis[i] === v) i++;
    const slice = rows.slice(start, i);
    if (v) {
      const hasChange = slice.some((r) => r.changed);
      out.push({
        kind: hasChange ? 'change' : 'ctx',
        rows: slice,
        navIndex: hasChange ? nav++ : null,
        gapIndex: null,
        firstN: null,
        lastN: null,
      });
    } else {
      out.push({
        kind: 'gap',
        rows: slice,
        navIndex: null,
        gapIndex: gapId++,
        firstN: slice[0]?.n ?? null,
        lastN: slice[slice.length - 1]?.n ?? null,
      });
    }
  }
  return out;
});
const expandedGaps = ref<Set<number>>(new Set());
function toggleGap(idx: number): void {
  const next = new Set(expandedGaps.value);
  if (next.has(idx)) next.delete(idx);
  else next.add(idx);
  expandedGaps.value = next;
}
// 切规划输入 → 展开 id 失效，清空（防 stale）
watch(
  [() => props.mode, () => props.context, () => props.ignoreWs, () => props.onlyChanges, () => props.parsed],
  () => {
    expandedGaps.value = new Set();
    expandedSplitFolds.value = new Set();
  },
);

// —— 同步左右栏滚动（水平 + 垂直）——
// 用「源标志 + rAF 释放」防回环：程序化同步 dst 会触发 dst 的 scroll 事件，此时 syncSource 仍是原 src，
// dst 侧 onPaneScroll 早返回。rAF 释放比 queueMicrotask 稳（scroll 事件常跨帧，microtask 在当前任务尾释放过早）。
let syncSource: 'left' | 'right' | null = null;
function onPaneScroll(side: 'left' | 'right'): void {
  if (syncSource !== null && syncSource !== side) return;
  const src = side === 'left' ? leftScroll.value : rightScroll.value;
  const dst = side === 'left' ? rightScroll.value : leftScroll.value;
  if (!src || !dst) return;
  syncSource = side;
  dst.scrollLeft = src.scrollLeft;
  dst.scrollTop = src.scrollTop;
  requestAnimationFrame(() => {
    syncSource = null;
  });
}

// curChange 变化 → 闪一下 + 滚到中心。flash 用响应式 flashNav 驱动（避免直接 classList 与 Vue :class 冲突）。
const flashNav = ref<number | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => props.curChange,
  async () => {
    await nextTick();
    flashNav.value = props.curChange;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashNav.value = null;
    }, 700);
    // scrollIntoView 只滚一个祖先、split 两栏会错位 → 手动算居中并同步两栏（Bug 1 联动）
    const el = bodyEl.value?.querySelector(`[data-nav="${props.curChange}"]`) as HTMLElement | null;
    if (!el) return;
    const pane = el.closest('.pane-scroll') as HTMLElement | null;
    if (!pane) return;
    const paneRect = pane.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const target = elRect.top - paneRect.top + pane.scrollTop - (pane.clientHeight - elRect.height) / 2;
    pane.scrollTo({ top: target, behavior: 'smooth' });
    const otherPane =
      pane === leftScroll.value ? rightScroll.value : pane === rightScroll.value ? leftScroll.value : null;
    if (otherPane) otherPane.scrollTo({ top: target, behavior: 'smooth' });
  },
);

onBeforeUnmount(() => {
  if (flashTimer) clearTimeout(flashTimer);
});
</script>

<template>
  <div ref="bodyEl" class="diff-body" :class="{ 'is-wrap': wrap, 'only-changes': onlyChanges }">
    <!-- 并排：左栏 | 右栏（成对行数组，数据层对齐；行号在各 pane 左侧） -->
    <div v-if="parsed && mode === 'split'" class="diff-row diff-row--split">
      <div class="pane pane--left">
        <div ref="leftScroll" class="pane-scroll" @scroll.passive="onPaneScroll('left')">
          <div class="col col--split">
            <template v-for="(item, vi) in splitVisible" :key="vi">
              <button
                v-if="item.kind === 'fold'"
                type="button"
                class="ctx-gap"
                @click="toggleSplitFold(item.foldId)"
              >
                ⋯ {{ item.count }} 行未变更<span class="ctx-gap__range">第 {{ item.firstN }}–{{ item.lastN }} 行</span>
              </button>
              <div
                v-else
                class="split-cell"
                :class="{ 'is-current': item.row.navIndex === curChange, flash: item.row.navIndex === flashNav }"
                :data-chunk-start="item.row.chunkStart ? 'true' : null"
                :data-chunk-end="item.row.chunkEnd ? 'true' : null"
                :data-nav="item.row.navIndex != null ? item.row.navIndex : null"
                @click="clickRow(item.row.navIndex)"
              >
                <DiffLine
                  v-if="item.row.left"
                  v-memo="[item.row.left, leftKind(item.row)]"
                  variant="split"
                  side="left"
                  :line="item.row.left"
                  :kind="leftKind(item.row)"
                />
                <div v-else class="line line--placeholder"></div>
              </div>
            </template>
          </div>
        </div>
      </div>

      <div class="pane pane--right">
        <div ref="rightScroll" class="pane-scroll" @scroll.passive="onPaneScroll('right')">
          <div class="col col--split">
            <template v-for="(item, vi) in splitVisible" :key="vi">
              <button
                v-if="item.kind === 'fold'"
                type="button"
                class="ctx-gap"
                @click="toggleSplitFold(item.foldId)"
              >
                ⋯ {{ item.count }} 行未变更
              </button>
              <div
                v-else
                class="split-cell"
                :class="{ 'is-current': item.row.navIndex === curChange, flash: item.row.navIndex === flashNav }"
                :data-chunk-start="item.row.chunkStart ? 'true' : null"
                :data-chunk-end="item.row.chunkEnd ? 'true' : null"
                @click="clickRow(item.row.navIndex)"
              >
                <DiffLine
                  v-if="item.row.right"
                  v-memo="[item.row.right, rightKind(item.row)]"
                  variant="split"
                  side="right"
                  :line="item.row.right"
                  :kind="rightKind(item.row)"
                />
                <div v-else class="line line--placeholder"></div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 内联：摊平 → 上下文规划 → 不可见段折叠成「⋯ K 行」可点开 -->
    <div v-else-if="parsed && mode === 'inline'" class="diff-row">
      <div class="pane" style="flex: 1">
        <div class="pane-scroll">
          <div class="col col--inline">
            <template v-for="(seg, si) in inlineSegs" :key="si">
              <template v-if="seg.kind === 'gap'">
                <template v-if="seg.gapIndex !== null && expandedGaps.has(seg.gapIndex)">
                  <button type="button" class="ctx-gap ctx-gap--open" @click="toggleGap(seg.gapIndex)">
                    ⋯ 收起 · {{ seg.rows.length }} 行
                  </button>
                  <DiffLine
                    v-for="(r, i) in seg.rows"
                    :key="i"
                    v-memo="[r.line, r.type]"
                    variant="inline"
                    :line="r.line"
                    :kind="r.type"
                  />
                </template>
                <button
                  v-else
                  type="button"
                  class="ctx-gap"
                  @click="seg.gapIndex !== null && toggleGap(seg.gapIndex)"
                >
                  ⋯ {{ seg.rows.length }} 行未变更<span v-if="seg.firstN != null && seg.lastN != null" class="ctx-gap__range">第 {{ seg.firstN }}–{{ seg.lastN }} 行</span>
                </button>
              </template>
              <div
                v-else-if="seg.kind === 'change'"
                class="hunk-block"
                :class="{ 'is-current': seg.navIndex === curChange, flash: seg.navIndex === flashNav }"
                :data-nav="seg.navIndex != null ? seg.navIndex : null"
                @click="clickRow(seg.navIndex)"
              >
                <DiffLine
                  v-for="(r, i) in seg.rows"
                  :key="i"
                  v-memo="[r.line, r.type]"
                  variant="inline"
                  :line="r.line"
                  :kind="r.type"
                />
              </div>
              <template v-else>
                <DiffLine
                  v-for="(r, i) in seg.rows"
                  :key="i"
                  v-memo="[r.line, r.type]"
                  variant="inline"
                  :line="r.line"
                  :kind="r.type"
                />
              </template>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 空态：无差异 / 无可显示 -->
    <div v-else class="diff-state">
      <div class="diff-state__icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      </div>
      <h3>无可显示差异</h3>
      <p>该文件相对 HEAD 没有可显示的文本差异（可能是纯空白、已被识别为二进制，或差异为空）。</p>
    </div>
  </div>
</template>

<style scoped>
.diff-body {
  flex: 1;
  min-height: 0;
  /* 垂直滚动下放到 .pane-scroll（双向滚动盒）：避免内层水平滚动条被推到内容最末行下方（Bug 1） */
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--color-panel-soft);
  position: relative;
}

.diff-row {
  display: flex;
  align-items: stretch;
  min-width: 100%;
  flex: 1;
  min-height: 0;
}
.pane {
  flex: 1;
  min-width: 0;
  display: flex;
  min-height: 0;
}
.pane-scroll {
  flex: 1;
  min-width: 0;
  /* 双向滚动：高度被 flex 链（.diff-body column → .diff-row/pane flex:1 min-height:0）夹在视口内，
     水平滚动条常驻视口底部（Bug 1 修复） */
  overflow: auto;
}
.pane-scroll::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}
.pane-scroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text) 18%, transparent);
  border-radius: 8px;
  border: 3px solid var(--color-panel-soft);
}
.pane-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.pane-scroll::-webkit-scrollbar-corner {
  background: var(--color-panel-soft);
}
.col--split,
.col--inline {
  min-width: 100%;
  /* width:max-content：列扩展到最宽行，行背景/边框铺满内容区——长行水平滚动后右侧不再露白（Bug 2） */
  width: max-content;
  display: block;
}
/* wrap 必须覆盖回 auto：max-content 容器宽=最宽行，pre-wrap 会失去换行边界 → 换行失效 */
.diff-body.is-wrap .col--split,
.diff-body.is-wrap .col--inline {
  width: auto;
}

/* split 行包裹：伪元素画 chunk 上下边框（不影响行高，contrast 风格）；is-current 左侧 accent 条 */
.split-cell {
  position: relative;
  cursor: default;
}
.split-cell[data-chunk-start='true']::before,
.split-cell[data-chunk-end='true']::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  pointer-events: none;
  z-index: 2;
}
.split-cell[data-chunk-start='true']::before {
  top: 0;
  border-top: 1px solid var(--diff-chunk-border);
}
.split-cell[data-chunk-end='true']::after {
  bottom: 0;
  border-top: 1px solid var(--diff-chunk-border);
}
.split-cell.is-current {
  box-shadow: inset 3px 0 0 var(--color-accent);
}
.split-cell.flash {
  animation: diff-flash 0.7s var(--ease-out);
}
.split-cell:has(.line--placeholder) {
  cursor: default;
}
@keyframes diff-flash {
  0% {
    background: color-mix(in srgb, var(--color-accent) 18%, transparent);
  }
  100% {
    background: transparent;
  }
}

/* 占位框：一侧 null（纯增的左 / 纯删的右）。浅灰提示此处无对应行 */
.line--placeholder {
  display: flex;
  min-width: 100%;
  height: var(--diff-line-h);
  background: color-mix(in srgb, var(--color-text) 2.5%, transparent);
}

/* inline change 包裹层 */
.hunk-block {
  position: relative;
}
.hunk-block.is-current {
  box-shadow: inset 2px 0 0 var(--color-accent);
}
.hunk-block.flash {
  animation: diff-flash 0.7s var(--ease-out);
}

/* inline 上下文断层 + split onlyChanges fold 共用折叠条 */
.ctx-gap {
  display: block;
  width: 100%;
  border: 0;
  cursor: pointer;
  text-align: center;
  height: var(--diff-line-h);
  line-height: var(--diff-line-h);
  background: color-mix(in srgb, var(--color-panel) 65%, var(--color-panel-soft));
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: var(--font-sans);
  border-top: 1px solid color-mix(in srgb, var(--color-border) 45%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 45%, transparent);
}
.ctx-gap:hover {
  color: var(--add-text);
  background: color-mix(in srgb, var(--color-success) 7%, transparent);
}
.ctx-gap__range {
  opacity: 0.65;
  margin-left: 8px;
}
.ctx-gap--open {
  color: var(--add-text);
}

/* 自动换行：穿透到 DiffLine 的 .line（行高自适应；split 无三角标记，不再有漂移问题） */
.diff-body.is-wrap :deep(.line) {
  height: auto;
  min-height: var(--diff-line-h);
  white-space: pre-wrap;
  word-break: break-word;
}
.diff-body.is-wrap :deep(.line code) {
  flex: 1 1 auto;
}
.diff-body.is-wrap .pane-scroll {
  overflow-x: hidden;
}

/* 空态 */
.diff-state {
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  padding: 40px;
  text-align: center;
}
.diff-state__icon {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-lg);
  display: grid;
  place-items: center;
  margin: 0 0 14px;
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  color: var(--color-accent-strong);
}
.diff-state__icon svg {
  width: 28px;
  height: 28px;
}
.diff-state h3 {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
}
.diff-state p {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 13px;
  max-width: 420px;
  line-height: 1.6;
}
</style>
