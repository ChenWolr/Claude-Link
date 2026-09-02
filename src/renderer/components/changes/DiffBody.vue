<script setup lang="ts">
// DiffBody —— diff 渲染器。消费 ParsedDiffFile（diff-parser 输出）渲染并排/内联两种视图。
// 所有 UI 状态（mode/context/curChange/language）由父 DiffDialog 传入，本组件无状态持有
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
  groupSearchMatchesByLine,
  type DiffSearchMatch,
  type DiffSearchRange,
} from '../../utils/diff-search';
import {
  buildInlineRows,
  buildSplitChunks,
  computeOffsets,
  bridgeRibbon,
  inlineVisiblePlan,
  resolveSearchScrollTop,
  type InlineRow,
  type Offsets,
  type SplitLayout,
} from '../../utils/diff-render';
import DiffLine from './DiffLine.vue';

const props = defineProps<{
  parsed: ParsedDiffFile | null;
  mode: 'split' | 'inline';
  context: number;
  /** 全文开关：inline 路径跳过 inlineVisiblePlan（全部行可见不折叠），展示文件完整内容。 */
  fullText: boolean;
  curChange: number;
  /** hljs language，由 DiffDialog 按扩展名推断下传（Task 1d 接入；未传时 split 不上语法色） */
  language?: string;
  searchMatches?: DiffSearchMatch[];
  currentSearchMatchId?: string | null;
}>();
const emit = defineEmits<{ (e: 'goto-nav', nav: number): void }>();

const bodyEl = ref<HTMLElement | null>(null);
const splitScroll = ref<HTMLElement | null>(null);
const leftPane = ref<HTMLElement | null>(null);
const rightPane = ref<HTMLElement | null>(null);

// —— split：chunk 模型（contrast 风格：左右各自完整行 + 对齐块 + SVG 桥）——
const LH = 22; // 与 CSS --diff-line-h 一致
const RIVER_W = 122; // v9 Δ3：桥画布横穿整个 mid（38+46+38），锚点 cx 0/122 尖端直抵两侧码列（单张 river-svg 无 viewBox，user units = px）
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
  if (scrollTop.value > maxScrollTop.value) scrollTop.value = maxScrollTop.value;
}
function recomputeSplitGeometry(): void {
  if (!splitScroll.value) return;
  recomputeMaxScroll();
  scheduleOffset();
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
// cleanup 句柄跨出闭包保存，切模式或卸载时也能移除 document 监听，不必等待 mouseup。
let stopVthumbDrag: (() => void) | null = null;
function onVthumbDown(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  stopVthumbDrag?.();
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
  const cleanup = (): void => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', cleanup);
    if (stopVthumbDrag === cleanup) stopVthumbDrag = null;
  };
  stopVthumbDrag = cleanup;
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', cleanup);
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

// 桥随 offsets 重算（纸面工坊缎带桥：bridgeRibbon 贝塞尔几何，单张全尺寸 SVG 渲染）。
const splitRibbons = computed(() => {
  const lay = splitLayout.value;
  if (!lay) return [];
  return lay.chunks
    .filter((c) => c.kind !== 'same' && c.kind !== 'skip')
    .map((c) => bridgeRibbon(c, offsets.value, LH, RIVER_W));
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

const searchLineIndex = computed(() => groupSearchMatchesByLine(props.searchMatches ?? []));
function leftSearchRanges(n: number | null): DiffSearchRange[] {
  return n == null ? [] : searchLineIndex.value.left.get(`old:${n}`) ?? [];
}
function rightSearchRanges(n: number | null): DiffSearchRange[] {
  return n == null ? [] : searchLineIndex.value.right.get(`new:${n}`) ?? [];
}
function inlineSearchRanges(row: InlineRow): DiffSearchRange[] {
  if (row.n == null) return [];
  return row.type === 'del' ? leftSearchRanges(row.n) : rightSearchRanges(row.n);
}
function currentSearchForRanges(ranges: DiffSearchRange[]): string | null {
  return ranges.some((range) => range.matchId === props.currentSearchMatchId)
    ? props.currentSearchMatchId ?? null
    : null;
}
function searchMemoKey(ranges: DiffSearchRange[]): string {
  return `${ranges.map((range) => range.matchId).join(',')}|${currentSearchForRanges(ranges) ?? ''}`;
}
// 改动块卡片（D3 卡片化，取代旧整行背景+行号槽+上下边线的三重噪音）：
// 每个改动 chunk 一张圆角卡片（3px 色轨 + tint 底 + 发丝边），几何全部由 chunk 行号×LH 派生，
// 模板直接绑定 c.leftStart/rightStart * LH。纯 add（leftSize=0）左栏无卡片，改渲染插入标记线
// （桥尖对齐：top 恰为前侧末行底边）；纯 del 右栏镜像同理。
const splitCardsL = computed(() => splitLayout.value?.chunks
  .filter((c) => c.kind !== 'same' && c.kind !== 'skip' && (c.leftSize > 0 || c.kind === 'add')) ?? []);
const splitCardsR = computed(() => splitLayout.value?.chunks
  .filter((c) => c.kind !== 'same' && c.kind !== 'skip' && (c.rightSize > 0 || c.kind === 'del')) ?? []);
// v9 Δ4 左栏色轨钉层：左栏卡片内置轨关闭（ccard--norail），改由 pane-col 级钉层绘制——
// 钉层不在横向滚动的 .pane 内（产品 .pane 即滚动容器，与原型 pane/code 分层不同），right:0
// 恒贴可视右缘不随 scrollLeft 跑走；纵向 transform 绑同一 offsets.left 与行/卡片同步。
// 每改动 chunk 一个 crail（有界），tone 与左栏卡片同映射（del/edit→红、add→绿）。
const splitRailL = computed(() => splitLayout.value?.chunks
  .filter((c) => c.kind !== 'same' && c.kind !== 'skip' && c.leftSize > 0) ?? []);
// gutter 行号墨色 tone（D4 行号中性化：槽不染色，仅改动行行号加重）
function gutterTone(kind: string | undefined): string[] {
  if (kind === 'add' || kind === 'modr') return ['gln--add'];
  if (kind === 'del' || kind === 'modl') return ['gln--del'];
  return [];
}
// 点击改动 chunk → 跳转导航（按 chunk navIndex）
function clickChunk(navIndex: number | null): void {
  if (navIndex != null && navIndex !== props.curChange) emit('goto-nav', navIndex);
}
// 桥索引 → 对应改动 chunk 的 navIndex（splitRibbons 按 chunks 里非 same 顺序，一一对应）
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

function rowContainsMatch(row: InlineRow, match: DiffSearchMatch): boolean {
  return (row.type === 'del' && match.side === 'left' && row.n === match.oldLine)
    || (row.type === 'ctx' && match.side === 'both' && row.n === match.newLine)
    || (row.type === 'add' && match.side === 'right' && row.n === match.newLine);
}
function revealInlineMatch(match: DiffSearchMatch): void {
  for (const seg of inlineSegs.value) {
    if (seg.kind !== 'gap' || seg.gapIndex === null || expandedGaps.value.has(seg.gapIndex)) continue;
    if (!seg.rows.some((row) => rowContainsMatch(row, match))) continue;
    const next = new Set(expandedGaps.value);
    next.add(seg.gapIndex);
    expandedGaps.value = next;
    return;
  }
}
function matchSelector(matchId: string): string {
  return `[data-search-match="${CSS.escape(matchId)}"]`;
}
function findSearchTarget(match: DiffSearchMatch): HTMLElement | null {
  if (props.mode === 'inline') {
    return bodyEl.value?.querySelector(matchSelector(match.id)) as HTMLElement | null;
  }
  const pane = match.side === 'left' ? leftPane.value : rightPane.value;
  return pane?.querySelector(matchSelector(match.id)) as HTMLElement | null;
}
function ensureHorizontalVisible(pane: HTMLElement, target: HTMLElement): void {
  const margin = 12;
  const paneRect = pane.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (targetRect.left < paneRect.left + margin) {
    pane.scrollLeft += targetRect.left - paneRect.left - margin;
  } else if (targetRect.right > paneRect.right - margin) {
    pane.scrollLeft += targetRect.right - paneRect.right + margin;
  }
}

let searchScrollRaf = 0;
async function scrollCurrentSearchMatch(): Promise<void> {
  const match = props.searchMatches?.find((candidate) => candidate.id === props.currentSearchMatchId);
  if (!match) return;
  if (searchScrollRaf) {
    cancelAnimationFrame(searchScrollRaf);
    searchScrollRaf = 0;
  }

  if (props.mode === 'inline') revealInlineMatch(match);
  await nextTick();
  const target = findSearchTarget(match);
  if (!target) return;
  const line = target.closest('.line') as HTMLElement | null;
  if (!line) return;

  if (props.mode === 'inline') {
    const pane = line.closest('.pane-scroll') as HTMLElement | null;
    if (!pane) return;
    const paneRect = pane.getBoundingClientRect();
    const lineRect = line.getBoundingClientRect();
    pane.scrollTo({
      top: lineRect.top - paneRect.top + pane.scrollTop - (pane.clientHeight - lineRect.height) / 2,
      behavior: 'smooth',
    });
    ensureHorizontalVisible(pane, target);
    return;
  }

  const pane = line.closest('.pane') as HTMLElement | null;
  const side = match.side === 'left' ? 'left' : 'right';
  const lineNumber = side === 'left' ? match.oldLine : match.newLine;
  const lines = side === 'left' ? splitLayout.value?.leftLines : splitLayout.value?.rightLines;
  const sideLineIndex = lines?.findIndex((candidate) => candidate.n === lineNumber) ?? -1;
  if (!pane || !splitLayout.value || sideLineIndex < 0) return;
  recomputeMaxScroll();
  scrollTop.value = resolveSearchScrollTop(
    splitLayout.value.chunks,
    side,
    sideLineIndex,
    pane.clientHeight,
    LH,
    maxScrollTop.value,
    scrollTop.value,
  );
  scheduleOffset();

  searchScrollRaf = requestAnimationFrame(async () => {
    searchScrollRaf = 0;
    await nextTick();
    if (props.mode !== 'split' || props.currentSearchMatchId !== match.id) return;
    const liveTarget = findSearchTarget(match);
    const liveLine = liveTarget?.closest('.line') as HTMLElement | null;
    const livePane = liveTarget?.closest('.pane') as HTMLElement | null;
    if (!liveTarget || !liveLine || !livePane) return;
    const livePaneRect = livePane.getBoundingClientRect();
    const liveLineRect = liveLine.getBoundingClientRect();
    const correction = liveLineRect.top - livePaneRect.top
      - (livePane.clientHeight - liveLineRect.height) / 2;
    const correctedScrollTop = Math.max(
      0,
      Math.min(maxScrollTop.value, scrollTop.value + correction),
    );
    if (correctedScrollTop !== scrollTop.value) {
      scrollTop.value = correctedScrollTop;
      scheduleOffset();
    }
    ensureHorizontalVisible(livePane, liveTarget);
  });
}
watch(
  [() => props.currentSearchMatchId, () => props.mode, () => props.parsed],
  () => {
    void scrollCurrentSearchMatch();
  },
  { flush: 'post' },
);

// 切规划输入 → 展开 id 失效 + split 偏移复位（防 stale offsets 跨文件残留）
watch(
  [() => props.mode, () => props.context, () => props.fullText, () => props.parsed],
  () => {
    expandedGaps.value = new Set();
    scrollTop.value = 0;
    offsets.value = { left: 0, right: 0 };
  },
);
// splitLayout（riverHeight）变化 → 等 DOM 更新后统一重算滚动范围和 magic offsets。
// inline 模式没有 split DOM，入口守卫避免以 0 视口高写入伪 maxScrollTop。
watch(splitLayout, recomputeSplitGeometry, { flush: 'post' });

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

// .diff-scroll 位于 v-if 分支，切模式会销毁并重建节点；资源必须跟随模板 ref，不能只在组件 onMounted 时绑定一次。
watch(
  splitScroll,
  (el, _oldEl, onCleanup) => {
    if (!el) {
      maxScrollTop.value = 0;
      return;
    }
    // wheel 需 passive:false 才能 preventDefault（垂直滚动）；水平 wheel 不 prevent，交 .pane 原生。
    el.addEventListener('wheel', onWheel, { passive: false });
    const observer = new ResizeObserver(recomputeSplitGeometry);
    observer.observe(el);
    recomputeSplitGeometry();
    onCleanup(() => {
      el.removeEventListener('wheel', onWheel);
      observer.disconnect();
      stopVthumbDrag?.();
      if (scrollRaf) {
        cancelAnimationFrame(scrollRaf);
        scrollRaf = 0;
      }
    });
  },
  { flush: 'post' },
);
onBeforeUnmount(() => {
  if (flashTimer) clearTimeout(flashTimer);
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  if (searchScrollRaf) cancelAnimationFrame(searchScrollRaf);
  stopVthumbDrag?.();
});
</script>

<template>
  <div ref="bodyEl" class="diff-body">
    <!-- 并排：[行号|码] river [行号|码]。单滚动容器 .diff-scroll 同步垂直滚动；水平各栏独立。
         纸面工坊：行号独立成 gutter 列（D4）、改动块圆角卡片层（D3）、river 实列 + 单张 SVG 缎带桥（D2）。 -->
    <div v-if="parsed && mode === 'split'" class="diff-row diff-row--split">
      <div ref="splitScroll" class="diff-scroll">
        <div class="split-track">
          <!-- 左栏（v9 Δ1：行号列移入中廊 .mid，栏内只剩水平滚动码区） -->
          <div class="pane-col">
            <!-- v9 Δ4 色轨钉层：放 pane-col（不滚动）内使 crail 恒贴可视右缘，纵向随 offsets.left 同步 -->
            <div class="raillayer" aria-hidden="true" :style="{ transform: `translateY(${offsets.left}px)` }">
              <div
                v-for="(c, ri) in splitRailL"
                :key="'rl' + ri"
                class="crail"
                :class="'crail--' + (c.kind === 'add' ? 'add' : 'del')"
                :style="{ top: c.leftStart * LH + 'px', height: c.leftSize * LH + 'px' }"
              ></div>
            </div>
            <div ref="leftPane" class="pane pane--left" @scroll.passive="onPaneScrollX('left')">
              <div class="file-offset" :style="{ transform: `translateY(${offsets.left}px)` }">
                <template v-for="(c, ci) in splitCardsL" :key="'cl' + ci">
                  <div
                    v-if="c.leftSize > 0"
                    class="ccard"
                    :class="['ccard--' + (c.kind === 'add' ? 'add' : 'del'), 'ccard--norail', { 'is-current': c.navIndex === curChange, flash: c.navIndex === flashNav }]"
                    :style="{ top: c.leftStart * LH + 'px', height: c.leftSize * LH + 'px' }"
                  ></div>
                  <div
                    v-else
                    class="insert-line insert-line--add"
                    :style="{ top: c.leftStart * LH + 'px' }"
                  ></div>
                </template>
                <template v-for="(ln, i) in (splitLayout?.leftLines ?? [])" :key="'l' + i">
                  <div
                    v-if="leftKindArr[i] === 'skip'"
                    class="ctx-gap ctx-gap--skip"
                    aria-hidden="true"
                  ><span class="ctx-gap__label"><span class="pill">⋯ {{ leftSkipCount[i] }} 行未变更</span></span></div>
                  <DiffLine
                    v-else
                    variant="split"
                    side="left"
                    :line="ln"
                    :kind="leftKindArr[i] ?? 'ctx'"
                    :language="language"
                    :search-ranges="leftSearchRanges(ln.n)"
                    :current-search-match-id="currentSearchForRanges(leftSearchRanges(ln.n))"
                    :data-nav="leftNav[i] != null ? leftNav[i] : null"
                    :data-search-line="ln.n != null ? `old:${ln.n}` : null"
                    @click="clickChunk(leftNav[i] ?? null)"
                  />
                </template>
              </div>
            </div>
          </div>
          <!-- v9 中廊 .mid（Δ1）：gutterL｜river｜gutterR，space-between 把行号列分贴两侧码列边界；
               行号贴码（Δ2）细线在码侧、透明底让缎带从下方横穿；river 改 absolute inset:0 覆盖全 mid
               （Δ3 桥画布 122px=38+46+38，尖端直抵两侧码列边缘） -->
          <div class="mid">
            <div class="gutter gutter-l">
              <div class="g-offset" :style="{ transform: `translateY(${offsets.left}px)` }">
                <template v-for="(ln, i) in (splitLayout?.leftLines ?? [])" :key="'gl' + i">
                  <div v-if="leftKindArr[i] === 'skip'" class="gln" aria-hidden="true"></div>
                  <div v-else class="gln" :class="gutterTone(leftKindArr[i])">{{ ln.n ?? '' }}</div>
                </template>
              </div>
            </div>
            <!-- river：单张全尺寸 SVG 缎带桥（无 viewBox，user units=px；edit 桥经 defs 双色渐变） -->
            <div class="diff-river">
            <svg class="river-svg">
              <defs>
                <template v-for="(r, ri) in splitRibbons" :key="'dg' + ri">
                  <linearGradient v-if="r.kind === 'edit'" :id="`bg-fill-${bridgeNavIndex(ri)}`" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stop-color="var(--del-edge)" stop-opacity="0.16" />
                    <stop offset="1" stop-color="var(--add-edge)" stop-opacity="0.16" />
                  </linearGradient>
                  <linearGradient v-if="r.kind === 'edit'" :id="`bg-edge-${bridgeNavIndex(ri)}`" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stop-color="var(--del-edge)" stop-opacity="0.6" />
                    <stop offset="1" stop-color="var(--add-edge)" stop-opacity="0.6" />
                  </linearGradient>
                </template>
              </defs>
              <g
                v-for="(r, ri) in splitRibbons"
                :key="'br' + ri"
                class="bridge"
                :class="['bridge--' + r.kind, { 'is-current': bridgeNavIndex(ri) === curChange, flash: bridgeNavIndex(ri) === flashNav }]"
                :transform="`translate(0 ${r.top})`"
              >
                <path class="b-fill" :d="r.fillD" :fill="r.kind === 'edit' ? `url(#bg-fill-${bridgeNavIndex(ri)})` : undefined" />
                <path class="b-edge" :d="r.topEdgeD" :stroke="r.kind === 'edit' ? `url(#bg-edge-${bridgeNavIndex(ri)})` : undefined" />
                <path class="b-edge" :d="r.bottomEdgeD" :stroke="r.kind === 'edit' ? `url(#bg-edge-${bridgeNavIndex(ri)})` : undefined" />
                <circle
                  v-for="(d, di) in r.dots"
                  :key="di"
                  class="b-dot"
                  :cx="d.x * RIVER_W"
                  :cy="d.y"
                  r="2.8"
                  :style="r.kind === 'edit' ? { fill: d.x === 0 ? 'color-mix(in srgb, var(--del-edge) 75%, transparent)' : 'color-mix(in srgb, var(--add-edge) 75%, transparent)' } : undefined"
                />
              </g>
            </svg>
          </div>
            <div class="gutter gutter-r">
              <div class="g-offset" :style="{ transform: `translateY(${offsets.right}px)` }">
                <template v-for="(ln, i) in (splitLayout?.rightLines ?? [])" :key="'gr' + i">
                  <div v-if="rightKindArr[i] === 'skip'" class="gln" aria-hidden="true"></div>
                  <div v-else class="gln" :class="gutterTone(rightKindArr[i])">{{ ln.n ?? '' }}</div>
                </template>
              </div>
            </div>
          </div>
          <!-- 右栏（v9 Δ1：行号列已移入中廊，栏内只剩水平滚动码区） -->
          <div class="pane-col">
            <div ref="rightPane" class="pane pane--right" @scroll.passive="onPaneScrollX('right')">
              <div class="file-offset" :style="{ transform: `translateY(${offsets.right}px)` }">
                <template v-for="(c, ci) in splitCardsR" :key="'cr' + ci">
                  <div
                    v-if="c.rightSize > 0"
                    class="ccard"
                    :class="['ccard--' + (c.kind === 'del' ? 'del' : 'add'), { 'is-current': c.navIndex === curChange, flash: c.navIndex === flashNav }]"
                    :style="{ top: c.rightStart * LH + 'px', height: c.rightSize * LH + 'px' }"
                  ></div>
                  <div
                    v-else
                    class="insert-line insert-line--del"
                    :style="{ top: c.rightStart * LH + 'px' }"
                  ></div>
                </template>
                <template v-for="(ln, i) in (splitLayout?.rightLines ?? [])" :key="'r' + i">
                  <div
                    v-if="rightKindArr[i] === 'skip'"
                    class="ctx-gap ctx-gap--skip"
                    aria-hidden="true"
                  ><span class="ctx-gap__label"><span class="pill">⋯ {{ rightSkipCount[i] }} 行未变更</span></span></div>
                  <DiffLine
                    v-else
                    variant="split"
                    side="right"
                    :line="ln"
                    :kind="rightKindArr[i] ?? 'ctx'"
                    :language="language"
                    :search-ranges="rightSearchRanges(ln.n)"
                    :current-search-match-id="currentSearchForRanges(rightSearchRanges(ln.n))"
                    :data-nav="rightNav[i] != null ? rightNav[i] : null"
                    :data-search-line="ln.n != null ? `new:${ln.n}` : null"
                    @click="clickChunk(rightNav[i] ?? null)"
                  />
                </template>
              </div>
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
                    <span class="pill"><svg class="pill__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9" /></svg>⋯ 收起 · {{ seg.rows.length }} 行</span>
                  </button>
                  <DiffLine
                    v-for="(r, i) in seg.rows"
                    :key="i"
                    v-memo="[r.line, r.type, searchMemoKey(inlineSearchRanges(r))]"
                    variant="inline"
                    :line="r.line"
                    :kind="r.type"
                    :search-ranges="inlineSearchRanges(r)"
                    :current-search-match-id="currentSearchForRanges(inlineSearchRanges(r))"
                    :data-search-line="r.n != null ? `${r.type === 'del' ? 'old' : 'new'}:${r.n}` : null"
                  />
                </template>
                <button
                  v-else
                  type="button"
                  class="ctx-gap"
                  @click="seg.gapIndex !== null && toggleGap(seg.gapIndex)"
                >
                  <span class="pill"><svg class="pill__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9" /></svg>⋯ {{ seg.rows.length }} 行未变更<span v-if="seg.firstN != null && seg.lastN != null" class="ctx-gap__range">第 {{ seg.firstN }}–{{ seg.lastN }} 行</span></span>
                </button>
              </template>
              <div
                v-else-if="seg.kind === 'skip'"
                class="ctx-gap ctx-gap--skip"
                aria-hidden="true"
              ><span class="pill">⋯ {{ seg.skipCount }} 行未变更</span></div>
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
                  v-memo="[r.line, r.type, searchMemoKey(inlineSearchRanges(r))]"
                  variant="inline"
                  :line="r.line"
                  :kind="r.type"
                  :search-ranges="inlineSearchRanges(r)"
                  :current-search-match-id="currentSearchForRanges(inlineSearchRanges(r))"
                  :data-search-line="r.n != null ? `${r.type === 'del' ? 'old' : 'new'}:${r.n}` : null"
                />
              </div>
              <template v-else>
                <DiffLine
                  v-for="(r, i) in seg.rows"
                  :key="i"
                  v-memo="[r.line, r.type, searchMemoKey(inlineSearchRanges(r))]"
                  variant="inline"
                  :line="r.line"
                  :kind="r.type"
                  :search-ranges="inlineSearchRanges(r)"
                  :current-search-match-id="currentSearchForRanges(inlineSearchRanges(r))"
                  :data-search-line="r.n != null ? `${r.type === 'del' ? 'old' : 'new'}:${r.n}` : null"
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
  /* 纸面工坊 D1：底色由外层 .paper 纸卡承担，本体透明 */
  background: transparent;
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
/* 悬停显现：与全局滚动条策略一致（默认透明，移入才显示），组件级覆写避免退回常驻。 */
.pane-scroll::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 8px;
  border: 3px solid transparent;
}
.pane-scroll:hover::-webkit-scrollbar-thumb {
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
   拖 thumb 或点 track 跳转（onVthumbDown/onVtrackDown）。内容不溢出时 showVscroll=false 隐藏。
   纸面工坊：内缩 4px 悬浮于纸面右缘（原型同款）。 */
.vscroll {
  position: absolute;
  top: 4px;
  right: 4px;
  bottom: 4px;
  width: 10px;
  z-index: 5;
}
.vthumb {
  position: absolute;
  left: 2px;
  right: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text) 16%, transparent);
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
  background: transparent;
  border-radius: 8px;
  border: 3px solid transparent;
}
.diff-scroll:hover::-webkit-scrollbar-thumb {
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
/* 栏容器：水平滚动代码区（.pane）。v9 Δ1 后行号列不在此，gutter 移入中廊 .mid；
   .pane 仍是水平滚动容器（持有 scrollLeft，搜索横向定位契约依赖）。
   position:relative 供 Δ4 色轨钉层 .raillayer 锚定（钉层在 pane-col 内、pane 外）。 */
.pane-col {
  flex: 1;
  min-width: 0;
  display: flex;
  min-height: 0;
  position: relative;
}
/* v9 中廊（Δ1）：gutterL｜river｜gutterR。space-between 把行号列分贴两侧码列边界，
   河区（absolute）横穿其间；宽 = gutter*2+river = 122px（Δ3）。 */
.diff-row--split .mid {
  flex: 0 0 calc(var(--gutter-w) * 2 + var(--river-w));
  position: relative;
  height: 100%;
  display: flex;
  justify-content: space-between;
}
/* 行号列（v9 Δ2 行号贴码）：透明底让缎带从下方横穿（原型 .gutter 同款），
   细线移到码列边界——gutter-l 左缘贴左码列、gutter-r 右缘贴右码列 */
.diff-row--split .gutter {
  flex: 0 0 var(--gutter-w);
  overflow: hidden;
  position: relative;
  z-index: 2;
  background: transparent;
}
.diff-row--split .gutter-l {
  border-left: 1px solid color-mix(in srgb, var(--color-border) 30%, transparent);
}
.diff-row--split .gutter-r {
  border-right: 1px solid color-mix(in srgb, var(--color-border) 30%, transparent);
}
.g-offset {
  will-change: transform;
}
.gln {
  height: var(--diff-line-h);
  line-height: var(--diff-line-h);
  /* v9 Δ2 行号贴码：左列行号左对齐、紧跟 gutter-l 细线内侧（右列镜像覆写 .gutter-r .gln） */
  padding-left: 8px;
  text-align: left;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--color-text-muted);
  opacity: 0.78;
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.gutter-r .gln {
  padding-left: 0;
  padding-right: 8px;
  text-align: right;
}
.gln--add {
  color: var(--add-text);
  opacity: 1;
  font-weight: 650;
}
.gln--del {
  color: var(--del-text);
  opacity: 1;
  font-weight: 650;
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
/* river（v9 Δ3）：不再独立列，absolute inset:0 覆盖全 mid（122px），桥画布横穿中廊、
   尖端直抵两侧码列边缘；z-index 1 于 gutter(z2) 之下——缎带从行号列下方穿过 */
.diff-row--split .diff-river {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 1;
  background: transparent;
  border: 0;
}
.diff-river::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  background: repeating-linear-gradient(
    to bottom,
    color-mix(in srgb, var(--color-text) 11%, transparent) 0 3px,
    transparent 3px 7px
  );
}
.river-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
/* 缎带桥：低填充 + 细描边 + 端点锚点；edit 桥填充/描边走 defs 双色渐变（模板注入），
   is-current 用 CSS 覆盖（CSS 优先级高于 presentation attribute）。 */
.bridge .b-fill,
.bridge .b-edge,
.bridge .b-dot {
  transition: fill var(--duration-fast) linear, stroke var(--duration-fast) linear;
}
.bridge--add .b-fill { fill: color-mix(in srgb, var(--add-edge) 15%, transparent); }
.bridge--del .b-fill { fill: color-mix(in srgb, var(--del-edge) 15%, transparent); }
.bridge .b-edge { fill: none; stroke-width: 1.2; }
.bridge--add .b-edge { stroke: color-mix(in srgb, var(--add-edge) 62%, transparent); }
.bridge--del .b-edge { stroke: color-mix(in srgb, var(--del-edge) 62%, transparent); }
.bridge .b-dot { stroke: none; }
.bridge--add .b-dot { fill: color-mix(in srgb, var(--add-edge) 75%, transparent); }
.bridge--del .b-dot { fill: color-mix(in srgb, var(--del-edge) 75%, transparent); }
.bridge.is-current .b-fill { fill: color-mix(in srgb, var(--color-accent) 28%, transparent); }
.bridge.is-current .b-edge { stroke: var(--color-accent-strong); stroke-width: 1.6; }
.bridge.is-current .b-dot { fill: var(--color-accent-strong); }
.bridge.flash .b-fill {
  animation: bridge-flash 0.9s var(--ease-out);
}
@keyframes bridge-flash {
  0% { fill: color-mix(in srgb, var(--color-accent) 30%, transparent); }
}

/* 改动块卡片（D3 卡片化）：3px 圆角色轨 + tint 淡底 + 发丝边；行素净叠于其上（z-index:1） */
.diff-row--split :deep(.line) {
  position: relative;
  z-index: 1;
}
.ccard {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 0;
  border-radius: 8px;
}
.ccard::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  border-radius: 3px 0 0 3px;
}
.ccard--add {
  background: var(--add-tint);
  box-shadow: inset 0 0 0 1px var(--add-card-edge);
}
.ccard--add::before {
  background: color-mix(in srgb, var(--add-edge) 78%, transparent);
}
.ccard--del {
  background: var(--del-tint);
  box-shadow: inset 0 0 0 1px var(--del-card-edge);
}
.ccard--del::before {
  background: color-mix(in srgb, var(--del-edge) 78%, transparent);
}
/* v9 Δ4：左栏卡片去内置轨（改由 pane-col 级钉层 .raillayer>.crail 绘制），右栏卡保持内置左轨 */
.ccard--norail::before {
  display: none;
}
/* v9 Δ4 左栏色轨钉层：right:0 恒贴 pane-col（=左栏码区）可视右缘——不在横向滚动的 .pane 内，
   不随 scrollLeft 跑走（B13）；纵向 transform 随 offsets.left 与行/卡片同步。每 chunk 一个 crail（有界）。 */
.raillayer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
}
.crail {
  position: absolute;
  right: 0;
  width: 3px;
  border-radius: 3px 0 0 3px;
}
.crail--add {
  background: color-mix(in srgb, var(--add-edge) 78%, transparent);
}
.crail--del {
  background: color-mix(in srgb, var(--del-edge) 78%, transparent);
}
.ccard.is-current {
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--color-accent) 78%, transparent), 0 0 0 5px color-mix(in srgb, var(--color-accent) 12%, transparent);
  z-index: 2;
}
.ccard::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  opacity: 0;
}
.ccard.flash::after {
  background: color-mix(in srgb, var(--color-accent) 20%, transparent);
  animation: ccard-flash 0.9s var(--ease-out);
}
@keyframes ccard-flash {
  0% { opacity: 1; }
  100% { opacity: 0; }
}
/* 插入点标记线（v9 Δ5 加实）：3px、edge 62%、left/right 0 贴满可视两端——与桥楔形尖端
   连成贯穿线（B15）；top 公式仍为前侧末行底边 leftStart*LH（B11 桥尖对齐不变） */
.diff-row--split .insert-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 3px;
  background: color-mix(in srgb, var(--add-edge) 62%, transparent);
  z-index: 2;
  pointer-events: none;
}
.diff-row--split .insert-line--del {
  background: color-mix(in srgb, var(--del-edge) 62%, transparent);
}

/* inline change 包裹层（D3 卡片化）：圆角容器（无底色，行自带 tint 底）+ 左侧渐变色轨；
   is-current 描边+外晕、flash 两段式渐隐（与 split 卡片同语义，原型 .hunk 同款） */
.hunk-block {
  position: relative;
  border-radius: 9px;
  cursor: pointer;
}
.hunk-block::before {
  content: '';
  position: absolute;
  left: var(--gutter-w);
  top: 2px;
  bottom: 2px;
  width: 3px;
  border-radius: 3px;
  background: linear-gradient(
    in srgb,
    color-mix(in srgb, var(--del-edge) 60%, transparent),
    color-mix(in srgb, var(--add-edge) 60%, transparent)
  );
}
.hunk-block > .line:first-child { border-radius: 9px 9px 0 0; }
.hunk-block > .line:last-child { border-radius: 0 0 9px 9px; }
.hunk-block > .line:first-child:last-child { border-radius: 9px; }
.hunk-block.is-current {
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--color-accent) 72%, transparent), 0 0 0 5px color-mix(in srgb, var(--color-accent) 11%, transparent);
}
.hunk-block::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  opacity: 0;
}
.hunk-block.flash::after {
  background: color-mix(in srgb, var(--color-accent) 18%, transparent);
  animation: ccard-flash 0.9s var(--ease-out);
}

/* inline 上下文折叠条 + skip 分隔（纸面工坊药丸化）：按钮为全宽居中容器，视觉是 .pill 药丸 */
.ctx-gap {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  border: 0;
  cursor: pointer;
  padding: 3px 0;
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-sans);
}
.pill svg {
  width: 11px;
  height: 11px;
  transition: transform var(--duration-fast) var(--ease-out);
}
.ctx-gap--open .pill svg {
  transform: rotate(180deg);
}
.ctx-gap:hover:not(.ctx-gap--skip) .pill {
  color: var(--color-accent-strong);
  border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
  background: color-mix(in srgb, var(--color-accent) 8%, transparent);
}
.ctx-gap__range {
  opacity: 0.65;
  margin-left: 8px;
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
  display: inline-flex;
  justify-content: center;
  width: min(100%, 100cqw);
}
/* 居中药丸（原型 .pill 同款）：skip 哨兵 / inline 折叠条共用形态 */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 18px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  font-family: var(--font-sans);
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-text) 4.5%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-border) 65%, transparent);
  white-space: nowrap;
}
/* hunk 间分隔条（git 跳过的未输出行）：居中药丸，不可展开（内容不在 diff 内） */
.ctx-gap--skip {
  cursor: default;
  pointer-events: none;
  opacity: 0.8;
}
.diff-row--split .ctx-gap--skip {
  /* 覆盖基础 .ctx-gap 的 justify-content:center（那是 inline 全宽条用的）：
     split 的 gap 容器是 max-content 宽（可比视口宽），label 才是 100cqw=视口宽的居中层 */
  justify-content: flex-start;
  display: flex;
  align-items: center;
  height: var(--diff-line-h);
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

/* B8：偏好减弱动效时禁用两段式闪现 */
@media (prefers-reduced-motion: reduce) {
  .ccard.flash::after,
  .hunk-block.flash::after,
  .bridge.flash .b-fill {
    animation: none;
  }
}
</style>
