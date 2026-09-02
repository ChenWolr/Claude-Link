<script setup lang="ts">
// DiffDialog —— 改动对比弹窗的壳。持有全部视图状态（mode/context/curChange）
// 与弹窗几何（rect/sidebarW），组装 DiffSidebar + DiffBody，处理键盘 / 焦点 / 缩放 / 「打开」/ toast。
//
// 显隐由 useDiffDialog 的模块级 state 驱动（openDiffDialog/closeDiffDialog）。组件在 App.vue 单例常驻，
// v-if="state" 挂载。a11y 仿 InteractionPrompt / ImageLightbox：role=dialog、Tab trap、ESC/↑↓/[/]、还原焦点。
// 防残留三层：ensureDiff 的 sessionGen 守卫 + store 切会话清 diffCache + 本组件 watch(files) 当前文件消失即关。
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useDiffDialog } from '../../composables/useDiffDialog';
import { useChangesStore } from '../../stores/changes-store';
import { useSessionStore } from '../../stores/session-store';
import { parseUnifiedDiff } from '../../utils/diff-parser';
import type { ParsedDiffFile } from '../../utils/diff-parser';
import { buildSplitChunks, countChanges, countInlineHunks } from '../../utils/diff-render';
import { extToLang } from '../../utils/diff-highlight';
import { buildDiffSearchMatches, moveSearchIndex } from '../../utils/diff-search';
import DiffSidebar from './DiffSidebar.vue';
import DiffBody from './DiffBody.vue';

const { state, close } = useDiffDialog();
const changesStore = useChangesStore();
const sessionStore = useSessionStore();

const STATUS_LABEL: Record<string, string> = { M: '改', A: '增', D: '删', R: '移', '??': '新', U: '冲' };
const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
const CONTEXT_OPTIONS = [3, 5, 10, 20] as const;
type SearchScope = 'full' | 'context';

// 视图状态
const mode = ref<'split' | 'inline'>('split');
const context = ref(3);
const curChange = ref(0);
// 全文开关（与并排/内联独立）：开启后以极大上下文（FULL_CONTEXT）拉取 diff，
// 让 git 输出整个文件为 context（无 skip 段）。并排/内联各自照常渲染，但全部行可见。
// inline 路径在 DiffBody 跳过 inlineVisiblePlan（不折叠 gap）；split 路径大上下文自然无 skip。
const fullText = ref(false);
const FULL_CONTEXT = 100000;
// 实际用于拉取/渲染的上下文：fullText 开启时恒为 FULL_CONTEXT，其余跟随用户选择。
const effectiveContext = computed(() => (fullText.value ? FULL_CONTEXT : context.value));
const searchOpen = ref(false);
const searchQuery = ref('');
const searchScope = ref<SearchScope>('full');
const currentSearchIndex = ref(0);
const searchInput = ref<HTMLInputElement | null>(null);

// 弹窗几何
const rect = ref<{ l: number; t: number; w: number; h: number } | null>(null);
const sidebarW = ref(212);
const sidebarStyle = computed(() => ({ '--diff-sidebar-w': `${sidebarW.value}px` }) as Record<string, string>);
// dialog 几何走 computed 绑模板 :style（取代命令式 applyRect）：rect 变 → 模板自动响应，无漏调风险。
const dialogStyle = computed<Record<string, string>>(() => {
  if (!rect.value) return {} as Record<string, string>;
  return { left: `${rect.value.l}px`, top: `${rect.value.t}px`, width: `${rect.value.w}px`, height: `${rect.value.h}px` };
});

const overlayEl = ref<HTMLElement | null>(null);
const dialogEl = ref<HTMLElement | null>(null);
const closeBtn = ref<HTMLButtonElement | null>(null);
const splitterEl = ref<HTMLElement | null>(null);
let lastFocus: HTMLElement | null = null;

const files = computed(() => changesStore.files);
const fileIdx = computed(() => files.value.findIndex((f) => f.path === state.value?.path));
const currentFile = computed(() => (fileIdx.value >= 0 ? files.value[fileIdx.value] : null));
// 当前文件语言（split 语法高亮用）。path 变 → extToLang 重新推断。
// 大 diff 降级：>1500 行关高亮（hljs 逐行对大文件必然卡；语言推断仍在但传 '' → DiffLine splitTokens
// 返回 null 走 line.segs/codeText 无 hljs，仅行背景色。Task 2b Step 6 / review-v1 P1）。
const SPLIT_HL_MAX_LINES = 1500;
const language = computed(() => {
  const totalLines = parsed.value?.groups.reduce((a, g) => a + g.L.length + g.R.length, 0) ?? 0;
  return totalLines > SPLIT_HL_MAX_LINES ? '' : extToLang(currentFile.value?.path ?? '');
});
const cached = computed(() => (state.value ? changesStore.diffCache[state.value.path] : undefined));
const isLoading = computed(() => {
  if (!state.value) return false;
  const c = cached.value;
  if (!c) return true; // 无缓存
  if (!c.ok) return false; // 错误态，非加载
  // 上下文不匹配（如开全文，旧缓存 context=3 vs 需要 100000）→ 视为加载中
  return c.context !== effectiveContext.value;
});
const errorMsg = computed(() => (cached.value && !cached.value.ok ? cached.value.message : ''));
const isBinary = computed(() => !!cached.value && cached.value.ok && cached.value.binary);
const isTruncated = computed(() => !!cached.value && cached.value.ok && cached.value.truncated);
const parsed = computed<ParsedDiffFile | null>(() => {
  const c = cached.value;
  if (!c || !c.ok || c.binary || c.context !== effectiveContext.value) return null;
  return parseUnifiedDiff(c.diff);
});
const searchMatches = computed(() => buildDiffSearchMatches(parsed.value, searchQuery.value));
const currentSearchMatch = computed(() => searchMatches.value[currentSearchIndex.value] ?? null);
const searchCountText = computed(() => {
  const total = searchMatches.value.length;
  return total ? `${currentSearchIndex.value + 1} / ${total}` : '0 / 0';
});
const counts = computed(() => (parsed.value ? countChanges(parsed.value) : { add: 0, del: 0 }));
const navTotal = computed(() => {
  if (!parsed.value) return 0;
  if (mode.value === 'inline') return countInlineHunks(parsed.value, effectiveContext.value);
  // split：chunk 模型下改动块数 = navIndex 非 null 的 chunk 数（buildSplitChunks 已编 navIndex）。
  // I1 修复：countSplitHunks 数 groups，相邻 del+add 合并为 1 个 edit chunk 后会偏大 → 导航跳号。
  const lay = buildSplitChunks(parsed.value);
  return lay.chunks.reduce((a, c) => a + (c.navIndex != null ? 1 : 0), 0);
});
const baselineShort = computed(() => (changesStore.baselineRef ? changesStore.baselineRef.slice(0, 7) : ''));
const pathParts = computed(() => {
  const p = currentFile.value?.path ?? '';
  const segs = p.split('/');
  const name = segs.pop() ?? p;
  return { dir: segs.join('/'), name };
});
const statusColor = computed(() => {
  const s = currentFile.value?.status;
  if (s === 'D') return 'var(--color-danger)';
  if (s === 'A' || s === '??') return 'var(--color-success)';
  return 'var(--color-warn-strong)';
});
const statusText = computed(() => {
  const s = currentFile.value?.status;
  return s ? STATUS_LABEL[s] ?? s : '改动';
});
// 打开 / 关闭：复位视图、几何居中、记焦点；关闭还原焦点。
watch(state, async (s) => {
  if (s) {
    mode.value = 'split';
    context.value = 3;
    fullText.value = false;
    curChange.value = 0;
    searchOpen.value = false;
    searchQuery.value = '';
    searchScope.value = 'full';
    currentSearchIndex.value = 0;
    rect.value = null;
    lastFocus = s.trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    await nextTick();
    ensureRect();
    closeBtn.value?.focus();
  } else {
    await nextTick();
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }
});

// path 变化（打开 + 侧栏切换）→ 取 diff + 复位 curChange。
// 用 watch(state.path) 而非 watch(state)：切换文件只改 path 属性不重新赋值 state，避免触发「打开」复位逻辑。
watch(
  () => state.value?.path,
  (p) => {
    if (!p) return;
    curChange.value = 0;
    void changesStore.ensureDiff(p, effectiveContext.value);
  },
);

// nav 总数变化（切模式 / 上下文 / 文件）时钳制 curChange 入界。
watch(navTotal, (n) => {
  if (curChange.value > n - 1) curChange.value = Math.max(0, n - 1);
});
watch([searchQuery, parsed, searchScope], () => {
  currentSearchIndex.value = 0;
});
watch(searchMatches, (matches) => {
  if (!matches.length) {
    currentSearchIndex.value = 0;
  } else if (currentSearchIndex.value >= matches.length) {
    currentSearchIndex.value = matches.length - 1;
  }
});
// 切上下文档位 → 按 effectiveContext 重新拉 diff（fullText 开启时恒为 FULL_CONTEXT，不重复拉）
watch(effectiveContext, (c) => {
  if (state.value?.path) void changesStore.ensureDiff(state.value.path, c);
});

// 防残留：切会话 / 当前文件从列表消失 → 关弹窗（sessionGen 守卫 + 清 diffCache 在 store，此为第三层）。
watch(
  () => sessionStore.activeSession?.id,
  () => {
    if (state.value) close();
  },
);
watch(files, (arr) => {
  if (state.value && !arr.some((f) => f.path === state.value!.path)) close();
});

function selectPath(p: string): void {
  if (state.value) state.value.path = p;
}
function gotoChange(delta: number): void {
  const n = navTotal.value;
  if (!n) return;
  curChange.value = (curChange.value + delta + n) % n;
}
function setMode(m: 'split' | 'inline'): void {
  if (mode.value === m) return;
  mode.value = m;
  curChange.value = 0;
}
function setContext(n: number): void {
  fullText.value = false;
  if (searchOpen.value) searchScope.value = 'context';
  context.value = n;
}
function setFullText(): void {
  fullText.value = true;
  if (searchOpen.value) searchScope.value = 'full';
}
async function openSearch(): Promise<void> {
  searchOpen.value = true;
  if (searchScope.value === 'full') fullText.value = true;
  await nextTick();
  searchInput.value?.focus();
  searchInput.value?.select();
}
function closeSearch(): void {
  searchOpen.value = false;
}
function setSearchScope(scope: SearchScope): void {
  searchScope.value = scope;
  fullText.value = scope === 'full';
}
function gotoSearch(delta: number): void {
  currentSearchIndex.value = moveSearchIndex(currentSearchIndex.value, delta, searchMatches.value.length);
}
function onSearchKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeSearch();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    gotoSearch(e.shiftKey ? -1 : 1);
  }
}
// 「打开」文件：shell.openPath 走系统默认程序；失败时主进程 Windows 降级弹「打开方式」对话框。
async function openExternally(): Promise<void> {
  if (!currentFile.value) return;
  const wd = sessionStore.activeSession?.workingDir ?? null;
  try {
    const res = await window.claudeLink.openChangeFile(wd, currentFile.value.path);
    showToast(res.ok ? `已用默认程序打开 ${pathParts.value.name}` : res.message);
  } catch (e) {
    showToast(`打开失败：${(e as Error).message ?? e}`);
  }
}

const toastText = ref('');
const toastShow = ref(false);
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string): void {
  toastText.value = msg;
  toastShow.value = true;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastShow.value = false;
  }, 4000);
}

// ── 几何 ──
function ensureRect(): void {
  const pad = 8;
  const w = Math.min(1280, window.innerWidth - pad * 2);
  const h = Math.min(840, window.innerHeight - pad * 2);
  rect.value = clampRect({
    l: Math.round((window.innerWidth - w) / 2),
    t: Math.round((window.innerHeight - h) / 2),
    w,
    h,
  });
}
function clampRect(r: { l: number; t: number; w: number; h: number }): { l: number; t: number; w: number; h: number } {
  const pad = 8;
  const MINW = 680;
  const MINH = 360;
  const w = Math.max(MINW, Math.min(r.w, window.innerWidth - pad * 2));
  const h = Math.max(MINH, Math.min(r.h, window.innerHeight - pad * 2));
  return {
    w,
    h,
    l: Math.max(pad, Math.min(r.l, window.innerWidth - w - pad)),
    t: Math.max(pad, Math.min(r.t, window.innerHeight - h - pad)),
  };
}
function clampSidebar(): void {
  const max = Math.max(120, (rect.value ? rect.value.w : 680) - 140);
  sidebarW.value = Math.max(60, Math.min(sidebarW.value, max));
}
function cursorFor(dir: string): string {
  if (dir === 'n' || dir === 's') return 'ns-resize';
  if (dir === 'e' || dir === 'w') return 'ew-resize';
  if (dir === 'ne' || dir === 'sw') return 'nesw-resize';
  return 'nwse-resize';
}

// 缩放 / 分隔条：move/up 挂 document，闭包跟踪；组件卸载兜底（弹窗常驻，主要为 resize/ESC 监听）。
function startResize(e: MouseEvent, dir: string): void {
  if (!rect.value) return;
  e.preventDefault();
  e.stopPropagation();
  const start = { ...rect.value };
  const sx = e.clientX;
  const sy = e.clientY;
  const MINW = 680;
  const MINH = 360;
  document.body.classList.add('rz-busy');
  document.body.style.cursor = cursorFor(dir);
  const move = (ev: MouseEvent): void => {
    const dx = ev.clientX - sx;
    const dy = ev.clientY - sy;
    let l = start.l;
    let t = start.t;
    let w = start.w;
    let h = start.h;
    if (dir.includes('e')) w = start.w + dx;
    if (dir.includes('s')) h = start.h + dy;
    if (dir.includes('w')) {
      l = start.l + dx;
      w = start.w - dx;
    }
    if (dir.includes('n')) {
      t = start.t + dy;
      h = start.h - dy;
    }
    if (w < MINW) {
      if (dir.includes('w')) l = start.l + (start.w - MINW);
      w = MINW;
    }
    if (h < MINH) {
      if (dir.includes('n')) t = start.t + (start.h - MINH);
      h = MINH;
    }
    rect.value = clampRect({ l, t, w, h });
  };
  const up = (): void => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('rz-busy');
    document.body.style.cursor = '';
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}
function startSplitter(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  const startW = sidebarW.value;
  const sx = e.clientX;
  document.body.classList.add('rz-busy');
  document.body.style.cursor = 'col-resize';
  splitterEl.value?.classList.add('is-drag');
  const move = (ev: MouseEvent): void => {
    const max = Math.max(120, (rect.value ? rect.value.w : 680) - 140);
    sidebarW.value = Math.max(60, Math.min(startW + (ev.clientX - sx), max));
  };
  const up = (): void => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('rz-busy');
    document.body.style.cursor = '';
    splitterEl.value?.classList.remove('is-drag');
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

let resizeTimer: ReturnType<typeof setTimeout> | null = null;
function onWindowResize(): void {
  if (!state.value) return;
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (rect.value) rect.value = clampRect(rect.value);
    clampSidebar();
  }, 80);
}

// ── 键盘 / 焦点 ──
function isTextTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}
function trapTab(e: KeyboardEvent): void {
  const dlg = dialogEl.value;
  if (!dlg) return;
  const focusables = Array.from(dlg.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
  ));
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
function onKey(e: KeyboardEvent): void {
  if (!state.value) return; // 弹窗未开不响应，避免与 InteractionPrompt 的 ESC 抢
  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    void openSearch();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (searchOpen.value) closeSearch();
    else close();
    return;
  }
  if (isTextTarget(e.target)) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    gotoChange(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    gotoChange(-1);
  } else if (e.key === 'Tab') {
    trapTab(e);
  }
}
function onOverlayClick(e: MouseEvent): void {
  if (e.target === overlayEl.value) close();
}

window.addEventListener('keydown', onKey);
window.addEventListener('resize', onWindowResize);
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', onWindowResize);
  if (toastTimer) clearTimeout(toastTimer);
  if (resizeTimer) clearTimeout(resizeTimer);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="diff-fade">
    <div v-if="state" ref="overlayEl" class="diff-overlay" @click="onOverlayClick">
      <div
        ref="dialogEl"
        class="diff-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="`文件对比 ${currentFile?.path ?? ''}`"
        :style="[sidebarStyle, dialogStyle]"
      >
        <!-- 八向缩放手柄（四边 + 四角） -->
        <div
          v-for="d in RESIZE_DIRS"
          :key="d"
          :class="`rz rz-${d}`"
          @mousedown="startResize($event, d)"
        ></div>

        <DiffSidebar :files="files" :current-path="state.path" @select="selectPath" />

        <div ref="splitterEl" class="diff-splitter" title="拖动调整列表宽度" @mousedown="startSplitter"></div>

        <div class="diff-main">
          <header class="diff-header">
            <div class="diff-header__main">
              <span
                class="seal"
                :style="{
                  color: statusColor,
                  background: `color-mix(in srgb, ${statusColor} 14%, transparent)`,
                  boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${statusColor} 22%, transparent)`,
                }"
              >{{ statusText }}</span>
              <div class="diff-header__titles">
                <h2 class="diff-title">
                  <span v-if="pathParts.dir" class="diff-title__dir">{{ pathParts.dir }}/</span><b>{{ pathParts.name || '—' }}</b>
                </h2>
                <p class="diff-meta">
                  <span v-if="baselineShort">对比 <code>HEAD {{ baselineShort }}</code></span>
                  <template v-if="currentFile && !isBinary">
                    <span v-if="baselineShort" class="meta-sep">·</span>
                    <span class="stat stat-add">+{{ counts.add }}</span>
                    <span class="stat stat-del">−{{ counts.del }}</span>
                    <span class="meta-sep">·</span>
                    <span>{{ navTotal }} 处改动</span>
                  </template>
                  <span v-else-if="isBinary">二进制文件</span>
                  <span v-if="isTruncated" class="stat-trunc">· 差异过大仅显示前部分</span>
                </p>
              </div>
            </div>
            <div class="diff-header__actions">
              <button
                class="tbtn"
                type="button"
                :class="{ active: searchOpen }"
                :disabled="isBinary"
                title="搜索 diff 内容（Ctrl+F）"
                @click="openSearch"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-4-4" />
                </svg>
                搜索
              </button>

              <div class="navchange" title="上一处 / 下一处改动（↑ / ↓）">
                <button class="iconbtn" type="button" aria-label="上一处改动" :disabled="!navTotal" @click="gotoChange(-1)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
                </button>
                <span class="navchange__count">{{ navTotal ? `${curChange + 1} / ${navTotal}` : '0 / 0' }}</span>
                <button class="iconbtn" type="button" aria-label="下一处改动" :disabled="!navTotal" @click="gotoChange(1)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                </button>
              </div>

              <button ref="closeBtn" class="iconbtn iconbtn--close" type="button" aria-label="关闭" @click="close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
          </header>

          <div class="diff-toolbar">
            <div class="seg" role="tablist" aria-label="视图模式">
              <button type="button" role="tab" :aria-selected="mode === 'split'" :class="{ active: mode === 'split' }" title="并排对比" @click="setMode('split')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="8" height="16" rx="1" /><rect x="13" y="4" width="8" height="16" rx="1" /></svg>并排
              </button>
              <button type="button" role="tab" :aria-selected="mode === 'inline'" :class="{ active: mode === 'inline' }" title="内联合并" @click="setMode('inline')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="14" y2="17" /></svg>内联
              </button>
            </div>

            <div class="ctx-group" title="上下文行数：每处改动周围显示多少未变更行">
              <span class="ctx-group__label">上下文</span>
              <div class="seg">
                <button v-for="n in CONTEXT_OPTIONS" :key="n" type="button" :class="{ active: context === n && !fullText }" @click="setContext(n)">{{ n }}</button>
                <button type="button" :class="{ active: fullText }" title="展示文件完整内容" @click="setFullText">全文</button>
              </div>
            </div>

            <div class="toolbar__spacer"></div>

            <div class="toolbar__hint" aria-hidden="true">
              <span><kbd>↑</kbd><kbd>↓</kbd> 切换改动</span>
              <span><kbd>Ctrl</kbd>+<kbd>F</kbd> 搜索</span>
              <span><kbd>Esc</kbd> 关闭</span>
            </div>
          </div>

          <div class="diff-searchbar" role="search" :class="{ open: searchOpen }" :inert="!searchOpen">
            <label class="diff-searchbar__field">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-4-4" />
              </svg>
              <input
                ref="searchInput"
                v-model="searchQuery"
                type="search"
                autocomplete="off"
                spellcheck="false"
                placeholder="搜索改动内容"
                aria-label="搜索 diff 内容"
                @keydown="onSearchKeydown"
              />
            </label>

            <div class="seg diff-searchbar__scope" aria-label="搜索范围">
              <button type="button" :class="{ active: searchScope === 'full' }" @click="setSearchScope('full')">全文</button>
              <button type="button" :class="{ active: searchScope === 'context' }" @click="setSearchScope('context')">当前上下文</button>
            </div>

            <span v-if="isLoading" class="diff-searchbar__status">正在加载…</span>
            <span v-else-if="isTruncated" class="diff-searchbar__warning">差异过大，仅搜索已加载部分</span>
            <span class="diff-searchbar__count" aria-live="polite">{{ searchCountText }}</span>

            <button class="iconbtn" type="button" aria-label="上一个搜索结果" :disabled="!searchMatches.length" @click="gotoSearch(-1)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15" /></svg>
            </button>
            <button class="iconbtn" type="button" aria-label="下一个搜索结果" :disabled="!searchMatches.length" @click="gotoSearch(1)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            <button class="iconbtn" type="button" aria-label="关闭搜索" @click="closeSearch">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>

          <!-- 纸面（D1 纸面分层）：列头 + 渲染器 + 状态态装进一张留白圆角纸卡 -->
          <div class="paperwrap">
            <div class="paper">
              <div v-if="mode === 'split'" class="diff-colheads">
                <div class="colhead"><span class="colhead__tick"></span>改动前 <code>· HEAD</code></div>
                <div class="colhead colhead--river" aria-hidden="true"></div>
                <div class="colhead"><span class="colhead__tick colhead__tick--new"></span>改动后 <code>· 工作区</code></div>
              </div>

              <DiffBody
                v-if="!errorMsg && !isBinary && !isLoading"
                :parsed="parsed"
                :mode="mode"
                :context="effectiveContext"
                :full-text="fullText"
                :cur-change="curChange"
                :language="language"
                :search-matches="searchMatches"
                :current-search-match-id="currentSearchMatch?.id ?? null"
                @goto-nav="curChange = $event"
              />
              <div v-else-if="errorMsg" class="diff-state">
                <div class="diff-state__icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                </div>
                <h3>读取差异失败</h3>
                <p>{{ errorMsg }}</p>
              </div>
              <div v-else-if="isBinary" class="diff-state">
                <div class="diff-state__icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>
                </div>
                <h3>二进制文件</h3>
                <p>该文件为二进制资源（图片 / 字体 / 压缩包等），无法进行文本行级对比。可点「打开」用外部工具查看。</p>
                <p v-if="currentFile" style="margin-top: 10px"><code>{{ currentFile.path }}</code></p>
              </div>
              <div v-else class="diff-state">
                <div class="diff-state__icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 6v6" /></svg>
                </div>
                <h3>加载中…</h3>
                <p>正在读取该文件相对 HEAD 的差异。</p>
              </div>
            </div>
          </div>

          <footer class="diff-footer">
            <div class="legend">
              <span><i class="lg-add"></i>新增</span>
              <span><i class="lg-del"></i>删除</span>
              <span><i class="lg-mod"></i>修改</span>
            </div>
            <div class="diff-footer__actions">
              <button class="btn btn--primary" type="button" :disabled="!currentFile || currentFile.status === 'D'" :title="currentFile && currentFile.status === 'D' ? '已删除文件无法打开' : ''" @click="openExternally">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>打开
              </button>
            </div>
          </footer>
        </div>
      </div>

      <div class="toast" :class="{ show: toastShow }">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
        <span>{{ toastText }}</span>
      </div>
    </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 衍生 token：绿增 / 红删 / 琥珀改，浅 tint。绿固定 token（9 套主题不换），红用主题 danger，琥珀用主题 warn。
   定义在 .diff-overlay 上，子组件（DiffBody/DiffLine/DiffSidebar）经 CSS 变量继承拿到。 */
.diff-overlay {
  --add-word: color-mix(in srgb, var(--color-success) 34%, transparent);
  --add-edge: var(--color-success);
  --add-text: var(--color-success-strong);
  --del-word: color-mix(in srgb, var(--color-danger) 28%, transparent);
  --del-edge: var(--color-danger);
  --del-text: var(--color-danger);
  --mod-bg: color-mix(in srgb, var(--color-warn) 12%, transparent);
  --mod-edge: var(--color-warn-strong);
  --diff-line-h: 22px;
  --diff-font: 12.5px;
  /* 纸面工坊（D2 river / D3 卡片 / D4 行号列） */
  --add-tint: color-mix(in srgb, var(--color-success) 9%, transparent);
  --del-tint: color-mix(in srgb, var(--color-danger) 8%, transparent);
  --add-card-edge: color-mix(in srgb, var(--color-success) 15%, transparent);
  --del-card-edge: color-mix(in srgb, var(--color-danger) 15%, transparent);
  /* v9 行号贴码（Δ3 中廊收窄 44/64→38/46；中廊全宽 122=38+46+38，桥画布横穿） */
  --river-w: 46px;
  --gutter-w: 38px;

  position: fixed;
  inset: 0;
  z-index: 1200;
  /* 暖色 scrim（D6）：diff 弹窗本地覆盖，不改全局共享的蒙层 token */
  background: color-mix(in srgb, #4A3828 42%, transparent);
  backdrop-filter: blur(9px) saturate(1.04);
}
/* Transition（v-if）淡入淡出蒙层；dialog 内部 animation 进场（spring 抬升）。 */
.diff-fade-enter-active,
.diff-fade-leave-active {
  transition: opacity var(--duration-base) var(--ease-out);
}
.diff-fade-enter-from,
.diff-fade-leave-to {
  opacity: 0;
}

.diff-dialog {
  position: absolute;
  display: flex;
  flex-direction: row;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--color-accent-strong) 35%, var(--color-border));
  border-radius: var(--radius-lg);
  background: var(--color-panel);
  /* 双层柔影 + 纸面顶部高光（D6） */
  box-shadow: 0 24px 64px rgba(64, 48, 32, 0.26), 0 6px 20px rgba(64, 48, 32, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.55);
  animation: diff-dialog-in var(--duration-slow) var(--ease-spring);
}
@keyframes diff-dialog-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* 八向缩放手柄 */
.rz {
  position: absolute;
  z-index: 6;
}
.rz-n { top: 0; left: 12px; right: 12px; height: 7px; cursor: ns-resize; }
.rz-s { bottom: 0; left: 12px; right: 12px; height: 7px; cursor: ns-resize; }
.rz-e { top: 12px; bottom: 12px; right: 0; width: 7px; cursor: ew-resize; }
.rz-w { top: 12px; bottom: 12px; left: 0; width: 7px; cursor: ew-resize; }
.rz-ne { top: 0; right: 0; width: 14px; height: 14px; cursor: nesw-resize; }
.rz-nw { top: 0; left: 0; width: 14px; height: 14px; cursor: nwse-resize; }
.rz-se { bottom: 0; right: 0; width: 16px; height: 16px; cursor: nwse-resize; }
.rz-sw { bottom: 0; left: 0; width: 14px; height: 14px; cursor: nesw-resize; }
.rz-n:hover, .rz-s:hover, .rz-e:hover, .rz-w:hover,
.rz-ne:hover, .rz-nw:hover, .rz-se:hover, .rz-sw:hover {
  background: color-mix(in srgb, var(--color-accent) 24%, transparent);
}
.rz-ne:hover, .rz-nw:hover, .rz-se:hover, .rz-sw:hover {
  border-radius: 3px;
}

.diff-splitter {
  flex: 0 0 7px;
  cursor: col-resize;
  position: relative;
  z-index: 4;
  background: transparent;
}
.diff-splitter::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 1px;
  background: var(--color-border);
}
.diff-splitter:hover::after,
.diff-splitter.is-drag::after {
  background: var(--color-accent);
  left: 2.5px;
  width: 2px;
}

.diff-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.diff-header {
  user-select: none;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 10px 12px 16px;
  border-bottom: 1px solid var(--color-border);
  background: linear-gradient(180deg, color-mix(in srgb, var(--color-panel-soft) 55%, transparent), transparent 80%);
}
.diff-header__main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 11px;
}
/* 状态印章（D5 chrome 重组）：26px 圆角方章；色由模板 :style 用现有 statusColor 派生（tint 底+发丝描边） */
.seal {
  flex: 0 0 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 750;
  color: var(--mod-edge);
  background: color-mix(in srgb, var(--color-warn) 15%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-warn) 22%, transparent);
}
.diff-header__titles {
  min-width: 0;
}
.diff-title {
  display: flex;
  align-items: center;
  gap: 2px;
  margin: 0;
  font-family: var(--font-mono);
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--color-text);
  overflow: hidden;
  /* rtl：文件名(b)靠左保留可见，目录前缀溢出右侧被 ellipsis 截断（保留文件名这一最关键信息） */
  direction: rtl;
  text-align: left;
}
.diff-title__dir {
  direction: ltr;
  unicode-bidi: isolate;
  opacity: 0.55;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.diff-title b {
  direction: ltr;
  unicode-bidi: isolate;
  font-weight: 700;
  flex: 0 0 auto;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.diff-meta {
  margin: 5px 0 0;
  font-size: 12px;
  color: var(--color-text-muted);
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
}
.diff-meta code {
  font-family: var(--font-mono);
  color: var(--color-text);
  font-size: 11.5px;
}
.diff-meta .meta-sep {
  opacity: 0.45;
}
.stat {
  font-family: var(--font-sans);
  font-weight: 700;
}
.stat-add { color: var(--add-text); }
.stat-del { color: var(--del-text); }
.stat-trunc { color: var(--color-warn-strong); }
.diff-header__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.iconbtn {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-out),
    color var(--duration-fast);
}
.iconbtn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
  color: var(--color-text);
}
.iconbtn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
.iconbtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.iconbtn svg {
  width: 16px;
  height: 16px;
}
.iconbtn--close {
  width: 32px;
  height: 32px;
}
/* TOOLBAR */
.diff-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-panel-soft);
  flex-wrap: wrap;
}
.seg {
  display: inline-flex;
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
  border-radius: var(--radius-sm);
  padding: 2px;
}
.seg button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 0;
  cursor: pointer;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-muted);
  background: transparent;
  border-radius: calc(var(--radius-sm) - 2px);
  transition:
    background var(--duration-fast) var(--ease-out),
    color var(--duration-fast);
}
.seg button svg {
  width: 14px;
  height: 14px;
}
.seg button.active {
  background: var(--color-panel);
  color: var(--color-accent-strong);
  box-shadow: var(--ring-light), var(--elevation-1);
}
.seg button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
.ctx-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ctx-group__label {
  font-size: 11px;
  color: var(--color-text-muted);
  font-weight: 600;
}
.ctx-group .seg button {
  min-width: 30px;
  justify-content: center;
  padding: 4px 8px;
}
.toolbar__spacer {
  flex: 1;
}
.toolbar__hint {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 10.5px;
  color: var(--color-text-muted);
  opacity: 0.75;
  white-space: nowrap;
}
.toolbar__hint kbd {
  font-family: var(--font-mono);
  font-size: 9.5px;
  padding: 1px 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-text) 12%, transparent);
  border-bottom-width: 2px;
}
.navchange {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel);
}
.navchange .iconbtn {
  width: 28px;
  height: 28px;
}
.navchange__count {
  font-size: 11.5px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  min-width: 44px;
  text-align: center;
}
.tbtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text);
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast),
    color var(--duration-fast);
}
.tbtn:hover {
  border-color: var(--color-accent-strong);
  color: var(--color-accent-strong);
}
.tbtn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
.tbtn.active {
  background: color-mix(in srgb, var(--color-accent) 16%, transparent);
  border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
  color: var(--color-accent-strong);
}
.tbtn svg {
  width: 14px;
  height: 14px;
}
/* 搜索条（D7 微交互）：max-height/opacity 滑入滑出；closed 时 inert 不参与 Tab/输入 */
.diff-searchbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  padding: 0 14px;
  border-bottom: 1px solid transparent;
  background: color-mix(in srgb, var(--color-panel-soft) 82%, var(--color-accent) 4%);
  transition:
    max-height var(--duration-base) var(--ease-out),
    opacity var(--duration-base) var(--ease-out),
    padding var(--duration-base) var(--ease-out),
    border-color var(--duration-base) var(--ease-out);
}
.diff-searchbar.open {
  max-height: 46px;
  opacity: 1;
  padding: 7px 14px;
  border-bottom-color: var(--color-border);
}
.diff-searchbar__field {
  min-width: 180px;
  max-width: 420px;
  flex: 1 1 320px;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel);
}
.diff-searchbar__field:focus-within {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 18%, transparent);
}
.diff-searchbar__field svg {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  color: var(--color-text-muted);
}
.diff-searchbar__field input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  color: var(--color-text);
  background: transparent;
  font: 12.5px/1.4 var(--font-sans);
}
.diff-searchbar__field input::-webkit-search-cancel-button {
  display: none;
}
.diff-searchbar__scope {
  flex: 0 0 auto;
}
.diff-searchbar__status,
.diff-searchbar__warning {
  font-size: 11.5px;
  white-space: nowrap;
}
.diff-searchbar__status {
  color: var(--color-text-muted);
}
.diff-searchbar__warning {
  color: var(--color-warn-strong);
}
.diff-searchbar__count {
  min-width: 52px;
  margin-left: auto;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.diff-searchbar .iconbtn {
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
}

/* 纸面（D1 纸面分层）：代码区外扩 12px 留白成圆角纸卡，文档感取代 IDE 条纹感 */
.paperwrap {
  flex: 1;
  min-height: 0;
  padding: 12px 14px;
  display: flex;
}
.paper {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6), 0 1px 3px rgba(64, 48, 32, 0.05);
  overflow: hidden;
}

/* 纸内列头（split 专属）：tick 小方块 + river 占位列，padding 补偿 gutter 列宽对齐代码区 */
.diff-colheads {
  flex: 0 0 auto;
  display: flex;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border) 75%, transparent);
}
.colhead {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px 6px calc(var(--gutter-w) + 10px);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}
.colhead code {
  text-transform: none;
  letter-spacing: 0;
  font-size: 10px;
  font-weight: 600;
  font-family: var(--font-mono);
  color: color-mix(in srgb, var(--color-text) 62%, transparent);
}
.colhead__tick {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--color-text) 16%, transparent);
}
.colhead__tick--new {
  background: color-mix(in srgb, var(--color-success) 45%, transparent);
}
.colhead--river {
  /* v9 Δ1：列头占位随中廊（gutterL+river+gutterR 全宽 122），不再是纯 river 列 */
  flex: 0 0 calc(var(--gutter-w) * 2 + var(--river-w));
  padding: 6px 0;
  justify-content: center;
}

/* 状态态（加载 / 错误 / 二进制；空差异态在 DiffBody 内） */
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
.diff-state code {
  font-size: 12px;
  color: var(--color-text);
}

/* FOOTER */
.diff-footer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 16px;
  border-top: 1px solid var(--color-border);
  background: var(--color-panel);
}
.legend {
  display: inline-flex;
  align-items: center;
  gap: 14px;
  font-size: 11.5px;
  color: var(--color-text-muted);
  flex-wrap: wrap;
}
.legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.legend i {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  display: inline-block;
}
/* mini 卡片样本（D3）：tint 底 + 发丝边 + 左侧色轨 */
.legend .lg-add {
  background: var(--add-tint);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--add-edge) 30%, transparent), inset 2.5px 0 0 color-mix(in srgb, var(--add-edge) 70%, transparent);
}
.legend .lg-del {
  background: var(--del-tint);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--del-edge) 30%, transparent), inset 2.5px 0 0 color-mix(in srgb, var(--del-edge) 70%, transparent);
}
.legend .lg-mod {
  background: color-mix(in srgb, var(--color-warn) 10%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-warn) 30%, transparent);
}
.diff-footer__actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 7px 14px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast),
    color var(--duration-fast);
}
.btn svg {
  width: 14px;
  height: 14px;
  opacity: 0.8;
}
.btn:hover:not(:disabled) {
  border-color: var(--color-accent-strong);
  color: var(--color-accent-strong);
}
.btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn--primary {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-on-accent);
  box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.08);
}
.btn--primary:hover:not(:disabled) {
  background: var(--color-accent-strong);
  border-color: var(--color-accent-strong);
  color: var(--color-on-accent);
}

/* TOAST */
.toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%) translateY(20px);
  z-index: 1300;
  opacity: 0;
  pointer-events: none;
  background: color-mix(in srgb, var(--color-text) 92%, #000);
  color: #fff;
  padding: 9px 16px;
  border-radius: var(--radius-md);
  font-size: 12.5px;
  font-weight: 600;
  box-shadow: var(--elevation-3);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-spring);
}
.toast.show {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
.toast svg {
  width: 15px;
  height: 15px;
  color: var(--color-success);
}

@media (prefers-reduced-motion: reduce) {
  .diff-overlay {
    --duration-fast: 0ms;
    --duration-base: 0ms;
    --duration-slow: 0ms;
    --ease-spring: linear;
  }
  .diff-dialog {
    animation: none;
  }
  .ccard.flash::after,
  .hunk-block.flash::after,
  .bridge.flash .b-fill {
    animation: none;
  }
}

@media (max-width: 900px) {
  .diff-searchbar {
    flex-wrap: wrap;
  }
  .diff-searchbar__field {
    max-width: none;
    flex-basis: calc(100% - 8px);
  }
}

@media (max-width: 720px) {
  .diff-dialog {
    width: 100vw !important;
    height: 100vh !important;
    left: 0 !important;
    top: 0 !important;
    border-radius: 0;
  }
}
</style>

<!-- 全局：缩放拖拽时禁选中文本 / 禁手柄命中（scoped 无法作用于 body） -->
<style>
body.rz-busy {
  user-select: none;
}
body.rz-busy .rz {
  pointer-events: none;
}
</style>
