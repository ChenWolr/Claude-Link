<script setup lang="ts">
// DiffBody —— diff 渲染器。消费 ParsedDiffFile（diff-parser 输出）渲染并排/内联两种视图。
// 所有 UI 状态（mode/context/wrap/curChange/language）由父 DiffDialog 传入，本组件无状态持有
// （仅 fold/gap 展开态这种纯局部 UI 在内部）。改动导航 curChange 变化时滚到中心 + 闪一下。
//
// split（contrast 风格）：消费 buildSplitChunks 的 SplitLayout（左右各自完整行 + 对齐 chunk + SVG 桥），
//   单滚动容器 .diff-scroll；scroll handler rAF 节流调 computeOffsets 算焦点偏移套到 .file-offset
//   translateY（magic scrolling：焦点 chunk 左右对齐，非焦点错位靠桥连接），桥随偏移动态重算。
//   行背景由预计算 leftKindArr/rightKindArr 查所属 chunk kind；curChange 高亮/flash/data-nav 绑在 DiffLine 根。
// inline（cc-haha 风格）：buildInlineRows 摊平 + 上下文规划 + gap 折叠，行号 sticky、三档色。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
  /** 全文开关：inline 路径跳过 inlineVisiblePlan（全部行可见不折叠），展示文件完整内容。 */
  fullText: boolean;
  curChange: number;
  /** hljs language，由 DiffDialog 按扩展名推断下传（Task 1d 接入；未传时 split 不上语法色） */
  language?: string;
}>();
const emit = defineEmits<{ (e: 'goto-nav', nav: number): void }>();

const bodyEl = ref<HTMLElement | null>(null);
const splitScroll = ref<HTMLElement | null>(null);
const leftPane = ref<HTMLElement | null>(null);
const rightPane = ref<HTMLElement | null>(null);

// —— split：chunk 模型（contrast 风格：左右各自完整行 + 对齐块 + SVG 桥）——
const LH = 22; // 与 CSS --diff-line-h 一致
const splitLayout = computed<SplitLayout | null>(() =>
  props.parsed ? buildSplitChunks(props.parsed, LH) : null,
);

// 垂直滚动 JS 化（对齐 contrast）：.diff-scroll overflow:hidden 不原生滚，wheel 驱动 scrollTop，
// .file-offset translateY = -scrollTop + magic 焦点偏移。换来的关键收益：.pane 高度 = 视口高
// （随 .split-track height:100% 而非内容全高）→ 水平滚动条常驻视口底、不盖最后一行、
// 行背景随 .file-offset inline-block 撑满铺到最宽行末尾（滚到最右不露白）。
const scrollTop = ref(0);
// maxScrollTop 用 ref：自定义垂直滚动条的 thumb 几何依赖它（响应式重算）。
const maxScrollTop = ref(0);
const offsets = ref<Offsets>({ left: 0, right: 0 });
let scrollRaf = 0;
function scheduleOffset(): void {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const st = scrollTop.value;
    // 用 .pane 的 clientHeight（已扣除底部水平滚动条高），滚到底时最后一行不被滚动条盖。
    const vh = leftPane.value?.clientHeight ?? splitScroll.value?.clientHeight ?? 0;
    const magic = computeOffsets(splitLayout.value?.chunks ?? [], st, vh, LH);
    offsets.value = { left: magic.left - st, right: magic.right - st };
  });
}
// wheel：水平为主（deltaX 占优）→ 交给 .pane 原生水平滚动；垂直 → JS 驱动 scrollTop。
// preventDefault 需 passive:false，故用 addEventListener（onMounted 注册），不用 @wheel。
function onWheel(e: WheelEvent): void {
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  const next = Math.max(0, Math.min(maxScrollTop.value, scrollTop.value + e.deltaY));
  if (next === scrollTop.value) return;
  e.preventDefault();
  scrollTop.value = next;
  scheduleOffset();
}
// riverHeight 或视口高变化 → 重算 maxScrollTop 并把越界 scrollTop 钳回。
function recomputeMaxScroll(): void {
  const lay = splitLayout.value;
  const vh = leftPane.value?.clientHeight ?? splitScroll.value?.clientHeight ?? 0;
  maxScrollTop.value = lay ? Math.max(0, lay.riverHeight - vh) : 0;
  if (scrollTop.value > maxScrollTop.value) {
    scrollTop.value = maxScrollTop.value;
    scheduleOffset();
  }
}
// 自定义垂直滚动条：.diff-scroll overflow:hidden 无原生条，故自绘 thumb 反映 scrollTop。
const showVscroll = computed(() => maxScrollTop.value > 0);
const vthumbH = computed(() => {
  const lay = splitLayout.value;
  if (!lay || lay.riverHeight === 0) return 100;
  const vh = lay.riverHeight - maxScrollTop.value;
  return Math.max(8, Math.min(100, (vh / lay.riverHeight) * 100));
});
const vthumbTop = computed(() => {
  if (maxScrollTop.value <= 0) return 0;
  return (scrollTop.value / maxScrollTop.value) * (100 - vthumbH.value);
});
// 拖 thumb：thumb 在 track 内可移动 (trackH - thumbPx)，映射到 maxScrollTop 滚动量。
function onVthumbDown(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  const startY = e.clientY;
  const startScroll = scrollTop.value;
  const trackH = (e.currentTarget as HTMLElement).parentElement?.clientHeight ?? 1;
  const thumbPx = (vthumbH.value / 100) * trackH;
  const movable = trackH - thumbPx;
  const move = (ev: MouseEvent): void => {
    if (movable <= 0) return;
    const ratio = (ev.clientY - startY) / movable;
    const next = Math.max(0, Math.min(maxScrollTop.value, startScroll + ratio * maxScrollTop.value));
    if (next !== scrollTop.value) {
      scrollTop.value = next;
      scheduleOffset();
    }
  };
  const up = (): void => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}
// 点 track（非 thumb）：跳到点击位置对齐 thumb 顶。
function onVtrackDown(e: MouseEvent): void {
  if (e.target !== e.currentTarget) return;
  const trackH = (e.currentTarget as HTMLElement).clientHeight;
  const clickY = e.offsetY;
  const thumbPx = (vthumbH.value / 100) * trackH;
  const movable = trackH - thumbPx;
  if (movable <= 0) return;
  const ratio = Math.max(0, Math.min(1, (clickY - thumbPx / 2) / movable));
  scrollTop.value = Math.max(0, Math.min(maxScrollTop.value, ratio * maxScrollTop.value));
  scheduleOffset();
}

// 水平滚动同步：左右栏 .pane 各自 overflow-x，拉一栏另一栏跟随（contrast scrollX master/slave）。
// syncSourceX 标志 + rAF 释放防回环：同步 dst 会触发 dst 的 scroll 事件，此时 syncSourceX 仍是 src，
// dst 侧 onPaneScrollX 早返回（scroll 事件常跨帧，rAF 在下帧释放比 microtask 稳）。
let syncSourceX: 'left' | 'right' | null = null;
function onPaneScrollX(side: 'left' | 'right'): void {
  if (syncSourceX !== null && syncSourceX !== side) return;
  const src = side === 'left' ? leftPane.value : rightPane.value;
  if (!src) return;
  syncSourceX = side;
  const dst = side === 'left' ? rightPane.value : leftPane.value;
  if (dst && dst.scrollLeft !== src.scrollLeft) dst.scrollLeft = src.scrollLeft;
  requestAnimationFrame(() => {
    syncSourceX = null;
  });
}

// 桥随 offsets 重算（动态桥，contrast drawBridge 移植）。
const splitBridges = computed(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  return lay.chunks
    .filter((c) => c.kind !== 'same' && c.kind !== 'skip')
    .map((c) => bridgePolygon(c, offsets.value, LH));
});

// 预计算每行的 navIndex + kind（O(chunks) 一次，splitLayout 变时重算；curChange 变化时 O(1) 查询，
// 避免模板每行 O(chunks) × 3 调用导致的 curChange 卡顿——P1 Step A，Task 1c review-v1）。
const leftNav = computed<(number | null)[]>(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  const out: (number | null)[] = new Array(lay.leftLines.length).fill(null);
  for (const c of lay.chunks) {
    if (c.kind === 'same' || c.kind === 'skip' || c.leftSize === 0) continue;
    for (let i = 0; i < c.leftSize; i++) out[c.leftStart + i] = c.navIndex;
  }
  return out;
});
const leftKindArr = computed<string[]>(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  const out: string[] = new Array(lay.leftLines.length).fill('ctx');
  for (const c of lay.chunks) {
    if (c.kind === 'same') continue;
    if (c.kind === 'skip') { out[c.leftStart] = 'skip'; continue; }
    if (c.leftSize === 0) continue;
    const kind = c.kind === 'del' ? 'del' : c.kind === 'edit' ? 'modl' : 'add';
    for (let i = 0; i < c.leftSize; i++) out[c.leftStart + i] = kind;
  }
  return out;
});
// 哨兵行（skip chunk）的跳过行数，供「⋯ N 行未变更」分隔条显示（与 inline 的 skip 分隔条一致）。
const leftSkipCount = computed<number[]>(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  const out: number[] = new Array(lay.leftLines.length).fill(0);
  for (const c of lay.chunks) {
    if (c.kind === 'skip') out[c.leftStart] = c.skipCount ?? 0;
  }
  return out;
});
const rightNav = computed<(number | null)[]>(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  const out: (number | null)[] = new Array(lay.rightLines.length).fill(null);
  for (const c of lay.chunks) {
    if (c.kind === 'same' || c.kind === 'skip' || c.rightSize === 0) continue;
    for (let i = 0; i < c.rightSize; i++) out[c.rightStart + i] = c.navIndex;
  }
  return out;
});
const rightKindArr = computed<string[]>(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  const out: string[] = new Array(lay.rightLines.length).fill('ctx');
  for (const c of lay.chunks) {
    if (c.kind === 'same') continue;
    if (c.kind === 'skip') { out[c.rightStart] = 'skip'; continue; }
    if (c.rightSize === 0) continue;
    const kind = c.kind === 'add' ? 'add' : c.kind === 'edit' ? 'modr' : 'del';
    for (let i = 0; i < c.rightSize; i++) out[c.rightStart + i] = kind;
  }
  return out;
});
const rightSkipCount = computed<number[]>(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  const out: number[] = new Array(lay.rightLines.length).fill(0);
  for (const c of lay.chunks) {
    if (c.kind === 'skip') out[c.rightStart] = c.skipCount ?? 0;
  }
  return out;
});
// chunk 上下边界标记（contrast chunk-start/chunk-end box-shadow 移植）：
// 改动块首行画上边线、末行画下边线——恰在相邻行之间形成彩色分隔线（未改动行无线，对齐 contrast）。
// 预计算每行是否 chunk 首行/末行，模板 :class 用，CSS 伪元素画线（不碰 box-shadow，与 is-current 零冲突）。
const leftChunkStart = computed<boolean[]>(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  const out = new Array(lay.leftLines.length).fill(false);
  for (const c of lay.chunks) {
    if (c.kind === 'same' || c.kind === 'skip' || c.leftSize === 0) continue;
    out[c.leftStart] = true;
  }
  return out;
});
const leftChunkEnd = computed<boolean[]>(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  const out = new Array(lay.leftLines.length).fill(false);
  for (const c of lay.chunks) {
    if (c.kind === 'same' || c.kind === 'skip' || c.leftSize === 0) continue;
    out[c.leftStart + c.leftSize - 1] = true;
  }
  return out;
});
const rightChunkStart = computed<boolean[]>(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  const out = new Array(lay.rightLines.length).fill(false);
  for (const c of lay.chunks) {
    if (c.kind === 'same' || c.kind === 'skip' || c.rightSize === 0) continue;
    out[c.rightStart] = true;
  }
  return out;
});
const rightChunkEnd = computed<boolean[]>(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  const out = new Array(lay.rightLines.length).fill(false);
  for (const c of lay.chunks) {
    if (c.kind === 'same' || c.kind === 'skip' || c.rightSize === 0) continue;
    out[c.rightStart + c.rightSize - 1] = true;
  }
  return out;
});
// 插入点标记线（contrast 占位侧 box-shadow 移植）：add chunk 在左栏插入位置、del chunk 在右栏
// 插入位置画一条该色横线——三角形桥左尖/右尖在栏内的对应标记（claude-link 无占位行，单独画）。
const leftInserts = computed<number[]>(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  return lay.chunks.filter((c) => c.kind === 'add').map((c) => c.leftStart * LH);
});
const rightInserts = computed<number[]>(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  return lay.chunks.filter((c) => c.kind === 'del').map((c) => c.rightStart * LH);
});
// 点击改动 chunk → 跳转导航（按 chunk navIndex）
function clickChunk(navIndex: number | null): void {
  if (navIndex != null && navIndex !== props.curChange) emit('goto-nav', navIndex);
}
// 桥索引 → 对应改动 chunk 的 navIndex（splitBridges 按 chunks 里非 same 顺序，一一对应）
function bridgeNavIndex(bridgeIdx: number): number | null {
  const lay = splitLayout.value;
  if (!lay) return null;
  const changed = lay.chunks.filter((c) => c.kind !== 'same' && c.kind !== 'skip');
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
  // 全文开关：全部行可见（不折叠 gap），让用户看到文件完整内容。
  const vis = props.fullText ? rows.map(() => true) : inlineVisiblePlan(rows, props.context);
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
  [() => props.mode, () => props.context, () => props.fullText, () => props.parsed],
  () => {
    expandedGaps.value = new Set();
    scrollTop.value = 0;
    offsets.value = { left: 0, right: 0 };
  },
);
// splitLayout（riverHeight）变化 → 重算 maxScrollTop。flush:post 确保 DOM 已更新拿准 clientHeight。
watch(splitLayout, () => nextTick(recomputeMaxScroll));

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
    // split：按 navIndex 找 chunk 的 river 中线行，scrollTop 居中（JS 滚动，无原生 scrollTo）
    const lay = splitLayout.value;
    const sc = splitScroll.value;
    if (!lay || !sc) return;
    let riverLine = 0;
    for (const c of lay.chunks) {
      if (c.navIndex === props.curChange) {
        const midRiverLine = riverLine + c.size / 2;
        const vh = leftPane.value?.clientHeight ?? sc.clientHeight;
        const target = midRiverLine * LH - vh / 2;
        scrollTop.value = Math.max(0, Math.min(maxScrollTop.value, target));
        scheduleOffset();
        break;
      }
      riverLine += c.size;
    }
  },
);

let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  // wheel 需 passive:false 才能 preventDefault（垂直滚动）；水平 wheel 不 prevent，交 .pane 原生。
  splitScroll.value?.addEventListener('wheel', onWheel, { passive: false });
  // 弹窗缩放 → .diff-scroll clientHeight 变 → 重算 maxScrollTop。
  resizeObserver = new ResizeObserver(() => recomputeMaxScroll());
  if (splitScroll.value) resizeObserver.observe(splitScroll.value);
  recomputeMaxScroll();
});
onBeforeUnmount(() => {
  if (flashTimer) clearTimeout(flashTimer);
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  splitScroll.value?.removeEventListener('wheel', onWheel);
  resizeObserver?.disconnect();
});
</script>

<template>
  <div ref="bodyEl" class="diff-body" :class="{ 'is-wrap': wrap }">
    <!-- 并排：左栏 | river(桥) | 右栏。单滚动容器 .diff-scroll 同步垂直滚动；水平各栏独立。 -->
    <div v-if="parsed && mode === 'split'" class="diff-row diff-row--split">
      <div ref="splitScroll" class="diff-scroll">
        <div class="split-track">
          <div ref="leftPane" class="pane pane--left" @scroll.passive="onPaneScrollX('left')">
            <div class="file-offset" :style="{ transform: `translateY(${offsets.left}px)` }">
              <template v-for="(ln, i) in (splitLayout?.leftLines ?? [])" :key="'l' + i">
                <div
                  v-if="leftKindArr[i] === 'skip'"
                  class="ctx-gap ctx-gap--skip"
                  aria-hidden="true"
                ><span class="ctx-gap__label">⋯ {{ leftSkipCount[i] }} 行未变更</span></div>
                <DiffLine
                  v-else
                  variant="split"
                  side="left"
                  :line="ln"
                  :kind="leftKindArr[i] ?? 'ctx'"
                  :language="language"
                  :class="{ 'is-current': leftNav[i] === curChange, flash: leftNav[i] === flashNav, 'chunk-start': leftChunkStart[i], 'chunk-end': leftChunkEnd[i] }"
                  :data-nav="leftNav[i] != null ? leftNav[i] : null"
                  @click="clickChunk(leftNav[i] ?? null)"
                />
              </template>
              <div v-for="(y, i) in leftInserts" :key="'ins-l-' + i" class="insert-line insert-line--add" :style="{ top: y + 'px' }"></div>
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
              :viewBox="'0 0 100 ' + b.height"
              preserveAspectRatio="none"
            >
              <polygon :points="b.points" />
              <line x1="0" :y1="b.topLine.y1" x2="100" :y2="b.topLine.y2" />
              <line x1="0" :y1="b.bottomLine.y1" x2="100" :y2="b.bottomLine.y2" />
            </svg>
          </div>
          <!-- 右栏 -->
          <div ref="rightPane" class="pane pane--right" @scroll.passive="onPaneScrollX('right')">
            <div class="file-offset" :style="{ transform: `translateY(${offsets.right}px)` }">
              <template v-for="(ln, i) in (splitLayout?.rightLines ?? [])" :key="'r' + i">
                <div
                  v-if="rightKindArr[i] === 'skip'"
                  class="ctx-gap ctx-gap--skip"
                  aria-hidden="true"
                ><span class="ctx-gap__label">⋯ {{ rightSkipCount[i] }} 行未变更</span></div>
                <DiffLine
                  v-else
                  variant="split"
                  side="right"
                  :line="ln"
                  :kind="rightKindArr[i] ?? 'ctx'"
                  :language="language"
                  :class="{ 'is-current': rightNav[i] === curChange, flash: rightNav[i] === flashNav, 'chunk-start': rightChunkStart[i], 'chunk-end': rightChunkEnd[i] }"
                  :data-nav="rightNav[i] != null ? rightNav[i] : null"
                  @click="clickChunk(rightNav[i] ?? null)"
                />
              </template>
              <div v-for="(y, i) in rightInserts" :key="'ins-r-' + i" class="insert-line insert-line--del" :style="{ top: y + 'px' }"></div>
            </div>
          </div>
        </div>
        <!-- 自定义垂直滚动条（.diff-scroll overflow:hidden 无原生条，自绘 thumb 反映 scrollTop） -->
        <div v-if="showVscroll" class="vscroll" @mousedown="onVtrackDown">
          <div class="vthumb" :style="{ height: vthumbH + '%', top: vthumbTop + '%' }" @mousedown.stop="onVthumbDown"></div>
        </div>
      </div>
    </div>

    <!-- 内联：摊平 → 上下文规划 → 不可见段折叠成「⋯ K 行」可点开（全文开关开启时不折叠） -->
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
  position: relative; /* 自定义垂直滚动条 .vscroll 绝对定位相对此 */
  flex: 1;
  min-width: 0;
  /* 不原生滚：垂直靠 JS wheel + .file-offset translateY（对齐 contrast），换 .pane 视口高 →
     水平滚动条常驻视口底、不盖最后一行、行背景铺满到最宽行末尾。 */
  overflow: hidden;
}
/* 自定义垂直滚动条：thumb 高度/位置由 vthumbH/vthumbTop（%）驱动，反映 scrollTop/maxScrollTop。
   拖 thumb 或点 track 跳转（onVthumbDown/onVtrackDown）。内容不溢出时 showVscroll=false 隐藏。 */
.vscroll {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 12px;
  z-index: 5;
}
.vthumb {
  position: absolute;
  left: 2px;
  right: 2px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-text) 18%, transparent);
  cursor: grab;
}
.vthumb:hover {
  background: color-mix(in srgb, var(--color-text) 30%, transparent);
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
  /* 视口高（非内容全高）：让 .pane 撑满视口 → 水平滚动条在视口底而非内容底。
     垂直内容（.file-offset 行数×LH）超出视口，靠 translateY = -scrollTop 滚动。 */
  height: 100%;
}
.diff-row--split .pane {
  flex: 1;
  min-width: 0;
  position: relative;
  overflow-x: auto;
  overflow-y: hidden;
  container-type: inline-size;
}
.diff-row--split .pane::-webkit-scrollbar {
  height: 10px;
  width: 0;
}
/* 左右栏内容列：block + width:max-content 取最宽行内容宽（不少于视口宽），与 inline 模式
   .col--inline 同源（已验证铺满不露白）。
   旧方案用 inline-block 期望被 block-level flex 子元素 .line 反向撑开，但 .line 是 block-level
   默认填满父元素、不撑开 inline-block 父元素 → .file-offset 退回 100%视口宽 → 短改动行背景
   只铺到视口宽，横向滚动后右侧掉色（拖动横向滚动条改动行右侧变白；弹窗拉宽 100% 变大又重新上色）。
   改 block+max-content 后 .file-offset 真正取最宽行宽，.line 的 min-width:100% 解析为最宽行宽，
   所有行等宽铺满，背景不再露白。max-content 不考虑子元素 min-width 约束，故无循环依赖。 */
.diff-row--split .file-offset {
  position: relative;
  will-change: transform;
  min-width: 100%;
  display: block;
  width: max-content;
  flex-shrink: 0;
}
.diff-body.is-wrap .diff-row--split .file-offset {
  width: auto;
}
/* river 绝对定位覆盖在左右栏之间（桥的画布；越宽桥越显眼） */
.diff-row--split .diff-river {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 40px;
  margin-left: -20px;
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
.bridge line {
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
  opacity: 0.85;
}
.bridge--add polygon {
  fill: color-mix(in srgb, var(--add-edge) 60%, transparent);
}
.bridge--del polygon {
  fill: color-mix(in srgb, var(--del-edge) 60%, transparent);
}
.bridge--edit polygon {
  fill: color-mix(in srgb, var(--mod-edge) 60%, transparent);
}
.bridge--add line {
  stroke: var(--add-edge);
}
.bridge--del line {
  stroke: var(--del-edge);
}
.bridge--edit line {
  stroke: var(--mod-edge);
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
/* chunk 上下边界线（contrast chunk-start/chunk-end box-shadow 移植）：
   改动块首行画上边线、末行画下边线——恰在相邻行之间形成彩色分隔线（未改动行无线）。
   伪元素画线，不碰 box-shadow，与上方 is-current 左侧 accent 条零冲突。 */
.diff-row--split :deep(.line) {
  position: relative;
}
.diff-row--split :deep(.line.chunk-start)::before,
.diff-row--split :deep(.line.chunk-end)::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  border-top: 1px solid transparent;
  pointer-events: none;
  z-index: 2;
}
.diff-row--split :deep(.line.chunk-start)::before { top: 0; }
.diff-row--split :deep(.line.chunk-end)::after { bottom: 0; }
/* 颜色随 kind：add/modr 用 add 配色；del/modl 用 del 配色（与行背景同源） */
.diff-row--split :deep(.line--add.chunk-start)::before,
.diff-row--split :deep(.line--add.chunk-end)::after,
.diff-row--split :deep(.line--modr.chunk-start)::before,
.diff-row--split :deep(.line--modr.chunk-end)::after {
  border-top-color: var(--add-edge);
}
.diff-row--split :deep(.line--del.chunk-start)::before,
.diff-row--split :deep(.line--del.chunk-end)::after,
.diff-row--split :deep(.line--modl.chunk-start)::before,
.diff-row--split :deep(.line--modl.chunk-end)::after {
  border-top-color: var(--del-edge);
}
/* 插入点标记线：add 左栏 / del 右栏插入位置画该色横线（三角形桥尖在栏内的对应标记） */
.diff-row--split .insert-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  border-top: 2px solid var(--add-edge);
  z-index: 2;
  pointer-events: none;
}
.diff-row--split .insert-line--del {
  border-top-color: var(--del-edge);
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
/* split 上下文：.file-offset 是 width:max-content，.ctx-gap 的 width:100%（百分比）
   在 max-content 父容器内对 block 子元素可能解析为文本宽而非父宽 → 分隔条变窄不可见。
   改 width:max-content（取文本固有宽）+ min-width:100%（至少撑满父宽）修复。
   max-content 计算不考虑子元素 min-width 约束（与 .line 同理），无循环依赖。 */
.diff-row--split .ctx-gap {
  width: max-content;
  min-width: 100%;
  text-align: left;
}
/* 左右栏由各自最长代码行撑成不同的 max-content 宽；直接居中会把较宽一侧文字推到
   pane 可视区外。sticky 标签跟随各自 pane 的水平滚动视口，初始及横向滚动后均可见。 */
.diff-row--split .ctx-gap__label {
  position: sticky;
  left: 0;
  display: inline-block;
  width: min(100%, 100cqw);
  text-align: center;
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
