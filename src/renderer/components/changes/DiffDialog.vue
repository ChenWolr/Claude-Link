<script setup lang="ts">
// DiffDialog —— 改动对比弹窗的壳。持有全部视图状态（mode/context/wrap/onlyChanges/curChange）
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
import DiffSidebar from './DiffSidebar.vue';
import DiffBody from './DiffBody.vue';

const { state, close } = useDiffDialog();
const changesStore = useChangesStore();
const sessionStore = useSessionStore();

const STATUS_LABEL: Record<string, string> = { M: '改', A: '增', D: '删', R: '移', '??': '新', U: '冲' };
const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
const CONTEXT_OPTIONS = [3, 5, 10, 20] as const;

// 视图状态
const mode = ref<'split' | 'inline'>('split');
const context = ref(3);
const wrap = ref(false);
const onlyChanges = ref(false);
const curChange = ref(0);

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
const isLoading = computed(() => !!state.value && !cached.value);
const errorMsg = computed(() => (cached.value && !cached.value.ok ? cached.value.message : ''));
const isBinary = computed(() => !!cached.value && cached.value.ok && cached.value.binary);
const isTruncated = computed(() => !!cached.value && cached.value.ok && cached.value.truncated);
const parsed = computed<ParsedDiffFile | null>(() => {
  const c = cached.value;
  if (!c || !c.ok || c.binary) return null;
  return parseUnifiedDiff(c.diff);
});
const counts = computed(() => (parsed.value ? countChanges(parsed.value) : { add: 0, del: 0 }));
const navTotal = computed(() => {
  if (!parsed.value) return 0;
  if (mode.value === 'inline') return countInlineHunks(parsed.value, context.value);
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
    wrap.value = false;
    onlyChanges.value = false;
    curChange.value = 0;
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
    void changesStore.ensureDiff(p, context.value);
  },
);

// nav 总数变化（切模式 / 上下文 / 文件）时钳制 curChange 入界。
watch(navTotal, (n) => {
  if (curChange.value > n - 1) curChange.value = Math.max(0, n - 1);
});
// 切上下文档位 → 按 context 重新拉 diff（git -U=context 直接给 N 行 ctx，避免 inline 二次折叠碎成多个 gap）
watch(context, (c) => {
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
  const focusables = Array.from(dlg.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex]:not([tabindex="-1"])'));
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
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
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
              <div class="diff-eyebrow">
                <span class="dot" :style="{ background: statusColor }"></span>
                {{ statusText }} · 文件对比
              </div>
              <h2 class="diff-title">
                <span v-if="pathParts.dir" class="diff-title__dir">{{ pathParts.dir }}/</span><b>{{ pathParts.name || '—' }}</b>
              </h2>
              <p class="diff-meta">
                <span v-if="baselineShort">对比 <code>HEAD {{ baselineShort }}</code></span>
                <template v-if="currentFile && !isBinary">
                  <span class="stat stat-add">+{{ counts.add }}</span>
                  <span class="stat stat-del">−{{ counts.del }}</span>
                  <span>{{ navTotal }} 处改动</span>
                </template>
                <span v-else-if="isBinary">二进制文件</span>
                <span v-if="isTruncated" class="stat-trunc">· 差异过大仅显示前部分</span>
              </p>
            </div>
            <div class="diff-header__actions">
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
                <button v-for="n in CONTEXT_OPTIONS" :key="n" type="button" :class="{ active: context === n }" @click="context = n">{{ n }}</button>
              </div>
            </div>

            <div class="toolbar__spacer"></div>

            <div class="navchange" title="上一处 / 下一处改动（↑ / ↓）">
              <button class="iconbtn" type="button" aria-label="上一处改动" :disabled="!navTotal" @click="gotoChange(-1)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
              </button>
              <span class="navchange__count">{{ navTotal ? `${curChange + 1} / ${navTotal}` : '0 / 0' }}</span>
              <button class="iconbtn" type="button" aria-label="下一处改动" :disabled="!navTotal" @click="gotoChange(1)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
              </button>
            </div>

            <button v-if="mode === 'inline'" class="tbtn" type="button" :class="{ active: wrap }" title="自动换行" @click="wrap = !wrap">换行</button>
            <button v-if="mode === 'inline'" class="tbtn" type="button" :class="{ active: onlyChanges }" title="仅显示改动（折叠未改动行）" @click="onlyChanges = !onlyChanges">仅改动</button>
          </div>

          <div v-if="mode === 'split'" class="diff-colheads">
            <div class="colhead">改动前 <code>· HEAD</code></div>
            <div class="colhead">改动后 <code>· 工作区</code></div>
          </div>

          <DiffBody
            v-if="!errorMsg && !isBinary && !isLoading"
            :parsed="parsed"
            :mode="mode"
            :context="context"
            :wrap="wrap"
            :only-changes="onlyChanges"
            :cur-change="curChange"
            :language="language"
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
  --add-bg: color-mix(in srgb, var(--color-success) 14%, transparent);
  --add-bg-strong: color-mix(in srgb, var(--color-success) 28%, transparent);
  --add-gutter: color-mix(in srgb, var(--color-success) 22%, var(--color-panel-soft));
  --add-word: color-mix(in srgb, var(--color-success) 34%, transparent);
  --add-edge: var(--color-success);
  --add-text: var(--color-success-strong);
  --del-bg: color-mix(in srgb, var(--color-danger) 11%, transparent);
  --del-bg-strong: color-mix(in srgb, var(--color-danger) 22%, transparent);
  --del-gutter: color-mix(in srgb, var(--color-danger) 19%, var(--color-panel-soft));
  --del-word: color-mix(in srgb, var(--color-danger) 28%, transparent);
  --del-edge: var(--color-danger);
  --del-text: var(--color-danger);
  --mod-bg: color-mix(in srgb, var(--color-warn) 12%, transparent);
  --mod-edge: var(--color-warn-strong);
  --diff-line-h: 22px;
  --diff-font: 12.5px;
  --diff-chunk-border: color-mix(in srgb, var(--color-border-strong) 65%, transparent);

  position: fixed;
  inset: 0;
  z-index: 1200;
  background: var(--interaction-overlay-bg, rgba(0, 0, 0, 0.58));
  backdrop-filter: blur(3px);
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
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.46), var(--ring-light);
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
  padding: 14px 18px 12px;
  border-bottom: 1px solid var(--color-border);
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 12%, transparent), transparent 72%);
  display: flex;
  align-items: flex-start;
  gap: 14px;
}
.diff-header__main {
  flex: 1;
  min-width: 0;
}
.diff-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
  color: var(--color-accent-strong);
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.diff-eyebrow .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
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

/* 列头 */
.diff-colheads {
  flex: 0 0 auto;
  display: flex;
  border-bottom: 1px solid var(--color-border-strong);
  background: var(--color-panel);
}
.colhead {
  flex: 1;
  min-width: 0;
  padding: 7px 14px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
  display: flex;
  align-items: center;
  gap: 7px;
}
.colhead code {
  text-transform: none;
  letter-spacing: 0;
  font-size: 11px;
  color: var(--color-text);
  font-weight: 600;
}
.colhead--gutter {
  flex: 0 0 86px;
  padding: 7px 0;
  justify-content: center;
  font-size: 9px;
  gap: 4px;
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
  width: 12px;
  height: 12px;
  border-radius: 3px;
  display: inline-block;
  border: 1px solid color-mix(in srgb, #000 8%, transparent);
}
.legend .lg-add { background: var(--add-bg-strong); }
.legend .lg-del { background: var(--del-bg-strong); }
.legend .lg-mod { background: var(--mod-bg); }
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
  box-shadow: var(--ring-light-accent);
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
  .split-cell.flash,
  .hunk-block.flash {
    animation: none;
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
