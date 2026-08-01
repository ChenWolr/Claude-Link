<script setup lang="ts">
// DiffBody —— diff 渲染器。消费 ParsedDiffFile（diff-parser 输出）渲染并排/内联两种视图。
// 所有 UI 状态（mode/context/wrap/onlyChanges/curChange/language）由父 DiffDialog 传入，本组件无状态持有
// （仅 fold/gap 展开态这种纯局部 UI 在内部）。改动导航 curChange 变化时滚到中心 + 闪一下。
//
// split（contrast 风格）：消费 buildSplitChunks 的 SplitLayout（左右各自完整行 + 对齐 chunk + SVG 桥），
//   单滚动容器 .diff-scroll；scroll handler rAF 节流调 computeOffsets 算焦点偏移套到 .file-offset
//   translateY（magic scrolling：焦点 chunk 左右对齐，非焦点错位靠桥连接），桥随偏移动态重算。
//   行背景由预计算 leftKindArr/rightKindArr 查所属 chunk kind；curChange 高亮/flash/data-nav 绑在 DiffLine 根。
// inline（cc-haha 风格）：buildInlineRows 摊平 + 上下文规划 + gap 折叠，行号 sticky、三档色。
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { ParsedDiffFile } from '../../utils/diff-parser';
import {
  buildInlineRows,
  buildSplitChunks,
  computeOffsets,
  bridgePolygon,
  inlineVisiblePlan,
  type InlineRow,
  type Offsets,
  type SplitLayout,
} from '../../utils/diff-render';
import DiffLine from './DiffLine.vue';

const props = defineProps<{
  parsed: ParsedDiffFile | null;
  mode: 'split' | 'inline';
  context: number;
  wrap: boolean;
  onlyChanges: boolean;
  curChange: number;
  /** hljs language，由 DiffDialog 按扩展名推断下传（Task 1d 接入；未传时 split 不上语法色） */
  language?: string;
}>();
const emit = defineEmits<{ (e: 'goto-nav', nav: number): void }>();

const bodyEl = ref<HTMLElement | null>(null);
const splitScroll = ref<HTMLElement | null>(null);

// —— split：chunk 模型（contrast 风格：左右各自完整行 + 对齐块 + SVG 桥）——
const LH = 22; // 与 CSS --diff-line-h 一致
const splitLayout = computed<SplitLayout | null>(() =>
  props.parsed ? buildSplitChunks(props.parsed, LH) : null,
);

// 焦点对齐偏移（magic scrolling）。scroll handler rAF 节流调 computeOffsets 更新；
// 切文件/切模式时复位 {0,0}。offsets 套到 .file-offset 的 translateY（GPU 合成）。
const offsets = ref<Offsets>({ left: 0, right: 0 });
let scrollRaf = 0;
function onSplitScroll(): void {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const el = splitScroll.value;
    if (!el) return;
    offsets.value = computeOffsets(
      splitLayout.value?.chunks ?? [],
      el.scrollTop,
      el.clientHeight,
      LH,
    );
  });
}

// 桥随 offsets 重算（动态桥，contrast drawBridge 移植）。
const splitBridges = computed(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  return lay.chunks
    .filter((c) => c.kind !== 'same')
    .map((c) => bridgePolygon(c, offsets.value, LH));
});

// 预计算每行的 navIndex + kind（O(chunks) 一次，splitLayout 变时重算；curChange 变化时 O(1) 查询，
// 避免模板每行 O(chunks) × 3 调用导致的 curChange 卡顿——P1 Step A，Task 1c review-v1）。
const leftNav = computed<(number | null)[]>(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  const out: (number | null)[] = new Array(lay.leftLines.length).fill(null);
  for (const c of lay.chunks) {
    if (c.kind === 'same' || c.leftSize === 0) continue;
    for (let i = 0; i < c.leftSize; i++) out[c.leftStart + i] = c.navIndex;
  }
  return out;
});
const leftKindArr = computed<string[]>(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  const out: string[] = new Array(lay.leftLines.length).fill('ctx');
  for (const c of lay.chunks) {
    if (c.kind === 'same' || c.leftSize === 0) continue;
    const kind = c.kind === 'del' ? 'del' : c.kind === 'edit' ? 'modl' : 'add';
    for (let i = 0; i < c.leftSize; i++) out[c.leftStart + i] = kind;
  }
  return out;
});
const rightNav = computed<(number | null)[]>(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  const out: (number | null)[] = new Array(lay.rightLines.length).fill(null);
  for (const c of lay.chunks) {
    if (c.kind === 'same' || c.rightSize === 0) continue;
    for (let i = 0; i < c.rightSize; i++) out[c.rightStart + i] = c.navIndex;
  }
  return out;
});
const rightKindArr = computed<string[]>(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  const out: string[] = new Array(lay.rightLines.length).fill('ctx');
  for (const c of lay.chunks) {
    if (c.kind === 'same' || c.rightSize === 0) continue;
    const kind = c.kind === 'add' ? 'add' : c.kind === 'edit' ? 'modr' : 'del';
    for (let i = 0; i < c.rightSize; i++) out[c.rightStart + i] = kind;
  }
  return out;
});
// 点击改动 chunk → 跳转导航（按 chunk navIndex）
function clickChunk(navIndex: number | null): void {
  if (navIndex != null && navIndex !== props.curChange) emit('goto-nav', navIndex);
}
// 桥索引 → 对应改动 chunk 的 navIndex（splitBridges 按 chunks 里非 same 顺序，一一对应）
function bridgeNavIndex(bridgeIdx: number): number | null {
  const lay = splitLayout.value;
  if (!lay) return null;
  const changed = lay.chunks.filter((c) => c.kind !== 'same');
  return changed[bridgeIdx]?.navIndex ?? null;
}

// —— inline：扁平行流 + 上下文规划 + gap 折叠 ——
interface InlineSeg {
  kind: 'change' | 'ctx' | 'gap' | 'skip';
  rows: InlineRow[];
  navIndex: number | null;
  gapIndex: number | null;
  firstN: number | null;
  lastN: number | null;
  skipCount?: number;
}
const inlineSegs = computed<InlineSeg[]>(() => {
  if (!props.parsed || props.mode !== 'inline') return [];
  const rows = buildInlineRows(props.parsed);
  const vis = inlineVisiblePlan(rows, props.context);
  const out: InlineSeg[] = [];
  let i = 0;
  let nav = 0;
  let gapId = 0;
  while (i < rows.length) {
    if (rows[i].type === 'skip') {
      // 相邻 hunk 间跳过的行 → 独立分隔段（「⋯ N 行」，不可展开：内容不在 diff 内）
      out.push({ kind: 'skip', rows: [rows[i]], navIndex: null, gapIndex: null, firstN: null, lastN: null, skipCount: rows[i].skipCount ?? 0 });
      i++;
      continue;
    }
    const v = vis[i];
    const start = i;
    while (i < rows.length && vis[i] === v && rows[i].type !== 'skip') i++;
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
// 切规划输入 → 展开 id 失效 + split 偏移复位（防 stale offsets 跨文件残留）
watch(
  [() => props.mode, () => props.context, () => props.onlyChanges, () => props.parsed],
  () => {
    expandedGaps.value = new Set();
    offsets.value = { left: 0, right: 0 };
  },
);

// curChange 变化 → 闪一下 + 滚到中心。flash 用响应式 flashNav 驱动（避免直接 classList 与 Vue :class 冲突）。
// split：按 navIndex 找 chunk 的 river 中线行，滚 splitScroll 居中（chunk 模型下行高不齐，querySelector 定位不准）。
// inline：保留原 querySelector([data-nav]) 居中逻辑。
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

    if (props.mode !== 'split') {
      // inline：querySelector([data-nav]) 居中
      const el = bodyEl.value?.querySelector(`[data-nav="${props.curChange}"]`) as HTMLElement | null;
      if (!el) return;
      const pane = el.closest('.pane-scroll') as HTMLElement | null;
      if (!pane) return;
      const pr = pane.getBoundingClientRect(), er = el.getBoundingClientRect();
      pane.scrollTo({ top: er.top - pr.top + pane.scrollTop - (pane.clientHeight - er.height) / 2, behavior: 'smooth' });
      return;
    }
    // split：按 navIndex 找 chunk 的 river 中线行，滚 splitScroll 居中
    const lay = splitLayout.value;
    const sc = splitScroll.value;
    if (!lay || !sc) return;
    let riverLine = 0;
    for (const c of lay.chunks) {
      if (c.navIndex === props.curChange) {
        const midRiverLine = riverLine + c.size / 2;
        const target = midRiverLine * LH - sc.clientHeight / 2;
        sc.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
        break;
      }
      riverLine += c.size;
    }
  },
);

onBeforeUnmount(() => {
  if (flashTimer) clearTimeout(flashTimer);
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
});
</script>

<template>
  <div ref="bodyEl" class="diff-body" :class="{ 'is-wrap': wrap, 'only-changes': onlyChanges }">
    <!-- 并排：左栏 | river(桥) | 右栏。单滚动容器 .diff-scroll 同步垂直滚动；水平各栏独立。 -->
    <div v-if="parsed && mode === 'split'" class="diff-row diff-row--split">
      <div ref="splitScroll" class="diff-scroll" @scroll.passive="onSplitScroll">
        <div class="split-track" :style="{ height: splitLayout ? splitLayout.riverHeight + 'px' : '0' }">
          <!-- 左栏 -->
          <div class="pane pane--left">
            <div class="file-offset" :style="{ transform: `translateY(${offsets.left}px)` }">
              <DiffLine
                v-for="(ln, i) in (splitLayout?.leftLines ?? [])"
                :key="'l' + i"
                variant="split"
                side="left"
                :line="ln"
                :kind="leftKindArr[i] ?? 'ctx'"
                :language="language"
                :class="{ 'is-current': leftNav[i] === curChange, flash: leftNav[i] === flashNav }"
                :data-nav="leftNav[i] != null ? leftNav[i] : null"
                @click="clickChunk(leftNav[i] ?? null)"
              />
            </div>
          </div>
          <!-- river：SVG 桥 -->
          <div class="diff-river">
            <svg
              v-for="(b, bi) in splitBridges"
              :key="'br' + bi"
              class="bridge"
              :class="['bridge--' + b.kind, { 'is-current': bridgeNavIndex(bi) === curChange, flash: bridgeNavIndex(bi) === flashNav }]"
              :style="{ top: b.top + 'px', height: b.height + 'px' }"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
            >
              <polygon :points="b.points" />
            </svg>
          </div>
          <!-- 右栏 -->
          <div class="pane pane--right">
            <div class="file-offset" :style="{ transform: `translateY(${offsets.right}px)` }">
              <DiffLine
                v-for="(ln, i) in (splitLayout?.rightLines ?? [])"
                :key="'r' + i"
                variant="split"
                side="right"
                :line="ln"
                :kind="rightKindArr[i] ?? 'ctx'"
                :language="language"
                :class="{ 'is-current': rightNav[i] === curChange, flash: rightNav[i] === flashNav }"
                :data-nav="rightNav[i] != null ? rightNav[i] : null"
                @click="clickChunk(rightNav[i] ?? null)"
              />
            </div>
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
                v-else-if="seg.kind === 'skip'"
                class="ctx-gap ctx-gap--skip"
                aria-hidden="true"
              >⋯ {{ seg.skipCount }} 行未变更</div>
              <div
                v-else-if="seg.kind === 'change'"
                class="hunk-block"
                :class="{ 'is-current': seg.navIndex === curChange, flash: seg.navIndex === flashNav }"
                :data-nav="seg.navIndex != null ? seg.navIndex : null"
                @click="clickChunk(seg.navIndex)"
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
  /* 垂直滚动下放到 .pane-scroll/.diff-scroll（双向滚动盒）：避免内层水平滚动条被推到内容最末行下方（Bug 1） */
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
.col--inline {
  min-width: 100%;
  /* width:max-content：列扩展到最宽行，行背景/边框铺满内容区——长行水平滚动后右侧不再露白（Bug 2） */
  width: max-content;
  display: block;
}
/* wrap 必须覆盖回 auto：max-content 容器宽=最宽行，pre-wrap 会失去换行边界 → 换行失效 */
.diff-body.is-wrap .col--inline {
  width: auto;
}

/* ===== split chunk 模型（contrast 风格：单滚动容器 + 左右 .file-offset + river 桥）===== */
.diff-row--split { overflow: hidden; }
.diff-scroll {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
.diff-scroll::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}
.diff-scroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text) 18%, transparent);
  border-radius: 8px;
  border: 3px solid var(--color-panel-soft);
}
.diff-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.diff-scroll::-webkit-scrollbar-corner {
  background: var(--color-panel-soft);
}
.split-track {
  position: relative;
  display: flex;
  min-width: 100%;
  /* 让左右栏内容撑开水平滚动：每个 pane 内部 width:max-content */
}
.diff-row--split .pane {
  flex: 1;
  min-width: 0;
  position: relative;
  overflow-x: auto;
  overflow-y: hidden;
}
.diff-row--split .pane::-webkit-scrollbar {
  height: 10px;
  width: 0;
}
/* 左右栏内容列：max-content 撑开，长行水平滚动后右侧不露白 */
.diff-row--split .file-offset {
  position: relative;
  will-change: transform;
  min-width: 100%;
  width: max-content;
}
.diff-body.is-wrap .diff-row--split .file-offset {
  width: auto;
}
/* river 绝对定位覆盖在左右栏之间 */
.diff-row--split .diff-river {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 14px;
  margin-left: -7px;
  pointer-events: none;
  z-index: 3;
  background: transparent;
  border: 0;
}
.bridge {
  position: absolute;
  left: 0;
  width: 100%;
}
.bridge polygon {
  stroke: none;
}
.bridge--add polygon {
  fill: color-mix(in srgb, var(--add-edge) 40%, transparent);
}
.bridge--del polygon {
  fill: color-mix(in srgb, var(--del-edge) 40%, transparent);
}
.bridge--edit polygon {
  fill: color-mix(in srgb, var(--mod-edge) 40%, transparent);
}
.bridge.is-current polygon {
  fill-opacity: 0.7;
}
.bridge.flash polygon {
  animation: diff-flash 0.7s var(--ease-out);
}
/* curChange 高亮 + flash（split：绑在 DiffLine 根 .line 上，:deep 穿透 scoped） */
.diff-row--split :deep(.line.is-current) {
  box-shadow: inset 3px 0 0 var(--color-accent);
}
.diff-row--split :deep(.line.flash) {
  animation: diff-flash 0.7s var(--ease-out);
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

/* inline 上下文断层 + hunk 间 skip 共用折叠条 */
.ctx-gap {
  display: block;
  width: 100%;
  border: 0;
  cursor: pointer;
  text-align: center;
  height: var(--diff-line-h);
  line-height: var(--diff-line-h);
  background: color-mix(in srgb, var(--color-panel) 50%, var(--color-panel-soft));
  color: var(--color-text);
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  font-family: var(--font-sans);
  border-top: 1px solid var(--color-border-strong);
  border-bottom: 1px solid var(--color-border-strong);
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
/* hunk 间分隔条（git 跳过的未输出行）：显示「⋯ N 行」，不可展开（内容不在 diff 内） */
.ctx-gap--skip {
  cursor: default;
  pointer-events: none;
  background: color-mix(in srgb, var(--color-panel) 80%, var(--color-panel-soft));
  border-top: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
}

/* 自动换行：穿透到 DiffLine 的 .line（行高自适应） */
.diff-body.is-wrap :deep(.line) {
  height: auto;
  min-height: var(--diff-line-h);
  white-space: pre-wrap;
  word-break: break-word;
}
.diff-body.is-wrap :deep(.line code) {
  flex: 1 1 auto;
}
.diff-body.is-wrap .pane-scroll,
.diff-body.is-wrap .diff-scroll {
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

@keyframes diff-flash {
  0% {
    background: color-mix(in srgb, var(--color-accent) 18%, transparent);
  }
  100% {
    background: transparent;
  }
}
</style>
