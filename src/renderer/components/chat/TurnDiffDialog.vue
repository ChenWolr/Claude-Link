<script setup lang="ts">
// TurnDiffDialog —— 轮末文件改动 diff 弹窗（计划 §4-P5）：数据源是主进程 turnDiff:filePatch
// 懒加载的 unified diff 文本（经 turn-diff-store 缓存/去重/错误态），body 消费
// parseUnifiedDiff(patch) → DiffBody 渲染（与 DiffDialog/ToolDiffDialog 共用同一渲染器全家）。
//
// 结构对齐 ToolDiffDialog.vue：弹窗壳（overlay + role=dialog + Tab trap + ESC/Ctrl+F/↑↓）、
// split/inline 切换、上下文 3/5/10/20、Ctrl+F 搜索 + 结果导航。差异点（本组件职责内新增）：
//  - 异步数据态：懒加载 spinner / invoke 失败错误态+重试按钮 / mode='unavailable' 空态；
//  - 标题 = 文件路径 + mode 徽标，三态（p5 2026-10-27 增 intent）：first-change →
//    「首改（编辑意图）」；intent →「编辑意图（快照缺失）」；其余（full）→「与上一轮的差异」。
// 无侧栏文件列表 / git 状态 / 拖动缩放 / 多段切换——单文件 patch 一次性呈现。
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useTurnDiffStore, turnDiffPatchKey, type TurnDiffPatchTarget } from '../../stores/turn-diff-store';
import { ESC_LAYER_PRIORITY, pushEscLayer, type EscLayerHandle } from '../../composables/use-esc-stack';
import { parseUnifiedDiff } from '../../utils/diff-parser';
import type { ParsedDiffFile } from '../../utils/diff-parser';
import { buildSplitChunks, countChanges, countInlineHunks } from '../../utils/diff-render';
import { extToLang } from '../../utils/diff-highlight';
import { buildDiffSearchMatches, moveSearchIndex } from '../../utils/diff-search';
import DiffBody from '../changes/DiffBody.vue';

const props = defineProps<{ target: TurnDiffPatchTarget | null }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useTurnDiffStore();

// A9 同款：弹窗打开即注册 Esc 层（复用 diff 层 1250，与 z-index 同值），关闭/卸载出栈。
let escHandle: EscLayerHandle | null = null;

const CONTEXT_OPTIONS = [3, 5, 10, 20] as const;

// 视图状态
const mode = ref<'split' | 'inline'>('split');
const context = ref(3);
// 全文开关（与并排/内联独立）：开启后以极大上下文（FULL_CONTEXT）重拉 patch，整文件行全部可见。
const fullText = ref(false);
const FULL_CONTEXT = 100000;
// 实际用于拉取/渲染的上下文：fullText 开启时恒为 FULL_CONTEXT，其余跟随用户选择。
const effectiveContext = computed(() => (fullText.value ? FULL_CONTEXT : context.value));
const curChange = ref(0);
const searchOpen = ref(false);
const searchQuery = ref('');
const currentSearchIndex = ref(0);
const searchInput = ref<HTMLInputElement | null>(null);

const overlayEl = ref<HTMLElement | null>(null);
const dialogEl = ref<HTMLElement | null>(null);
const closeBtn = ref<HTMLButtonElement | null>(null);
let lastFocus: HTMLElement | null = null;

// —— 数据态（turn-diff-store）——
const patchKey = computed(() => (props.target ? turnDiffPatchKey(props.target.turnStartMessageId, props.target.path, effectiveContext.value) : ''));
const entry = computed(() => (props.target ? store.patchCache.get(patchKey.value) ?? null : null));
const loadError = computed(() => store.patchErrors[patchKey.value] ?? null);
const loading = computed(() => !!store.patchLoading[patchKey.value]);
// 优先级：loading > error > unavailable > ready；parsed 为 null（空 patch 等）落 DiffBody 自带空态。
const bodyState = computed<'loading' | 'error' | 'unavailable' | 'ready'>(() => {
  if (loading.value) return 'loading';
  if (entry.value && entry.value.context !== effectiveContext.value) return 'loading'; // 上下文不匹配旧缓存
  if (loadError.value) return 'error';
  if (entry.value?.mode === 'unavailable') return 'unavailable';
  return 'ready';
});

const parsed = computed<ParsedDiffFile | null>(() =>
  entry.value && entry.value.context === effectiveContext.value && entry.value.patch
    ? parseUnifiedDiff(entry.value.patch)
    : null,
);
const filePath = computed(() => props.target?.path ?? '');
const pathParts = computed(() => {
  const segs = filePath.value.split(/[\\/]/);
  const name = segs.pop() ?? filePath.value;
  return { dir: segs.join('/'), name };
});
// mode 徽标文案（p5 2026-10-27 增 intent 态）：first-change → 首改（编辑意图）；
// intent → 编辑意图（快照缺失）；full → 与上一轮的差异。
const modeBadge = computed(() =>
  entry.value?.mode === 'first-change' ? '首改（编辑意图）'
    : entry.value?.mode === 'intent' ? '编辑意图（快照缺失）'
    : '与上一轮的差异');
const SPLIT_HL_MAX_LINES = 1500;
const language = computed(() => {
  const totalLines = parsed.value?.groups.reduce((a, g) => a + g.L.length + g.R.length, 0) ?? 0;
  return totalLines > SPLIT_HL_MAX_LINES ? '' : extToLang(filePath.value);
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
  const lay = buildSplitChunks(parsed.value);
  return lay.chunks.reduce((a, c) => a + (c.navIndex != null ? 1 : 0), 0);
});

// 打开 / 关闭 / 切目标：复位视图、焦点进弹窗、按需拉取 patch；关闭还原焦点。
watch(
  () => props.target,
  async (t) => {
    if (t) {
      if (!escHandle) escHandle = pushEscLayer(ESC_LAYER_PRIORITY.toolDiffDialog);
      mode.value = 'split';
      context.value = 3;
      fullText.value = false;
      curChange.value = 0;
      searchOpen.value = false;
      searchQuery.value = '';
      currentSearchIndex.value = 0;
      lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      await nextTick();
      closeBtn.value?.focus();
      // 懒加载：缓存命中即时返回；失败落 store 错误态（弹窗错误态 + 重试按钮消费）。
      void store.getPatch(t.sessionId, t.turnStartMessageId, t.endMessageId, t.path, effectiveContext.value);
    } else {
      if (escHandle) {
        escHandle.release();
        escHandle = null;
      }
      await nextTick();
      if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
      lastFocus = null;
    }
  },
);

// nav 总数变化（切模式 / 上下文）时钳制 curChange 入界。
watch(navTotal, (n) => {
  if (curChange.value > n - 1) curChange.value = Math.max(0, n - 1);
});
// 切上下文档位 / 开全文 → 按 effectiveContext 重拉 patch；缓存键含 context 维度，
// 各档位缓存互不覆盖，切回旧档位命中旧缓存不重拉。
watch(effectiveContext, (c) => {
  const t = props.target;
  if (t) void store.getPatch(t.sessionId, t.turnStartMessageId, t.endMessageId, t.path, c);
});
watch([searchQuery, patchKey], () => {
  currentSearchIndex.value = 0;
});
watch(searchMatches, (matches) => {
  if (!matches.length) currentSearchIndex.value = 0;
  else if (currentSearchIndex.value >= matches.length) currentSearchIndex.value = matches.length - 1;
});

function setMode(m: 'split' | 'inline'): void {
  if (mode.value === m) return;
  mode.value = m;
  curChange.value = 0;
}
function setContext(n: number): void {
  fullText.value = false;
  context.value = n;
}
function setFullText(): void {
  fullText.value = true;
}
function gotoChange(delta: number): void {
  const n = navTotal.value;
  if (!n) return;
  curChange.value = (curChange.value + delta + n) % n;
}
async function openSearch(): Promise<void> {
  searchOpen.value = true;
  await nextTick();
  searchInput.value?.focus();
  searchInput.value?.select();
}
function closeSearch(): void {
  searchOpen.value = false;
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
function close(): void {
  emit('close');
}
function retry(): void {
  const t = props.target;
  if (!t) return;
  void store.getPatch(t.sessionId, t.turnStartMessageId, t.endMessageId, t.path, effectiveContext.value);
}

// ── 键盘 / 焦点（对齐 ToolDiffDialog：Tab trap、ESC 分层让位、Ctrl+F、↑↓ 导航）──
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
  if (!props.target) return; // 弹窗未开不响应
  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    if (escHandle && !escHandle.isTopmost()) return; // 更高层遮罩在场时让位
    e.preventDefault();
    void openSearch();
    return;
  }
  if (e.key === 'Escape') {
    if (escHandle && !escHandle.isTopmost()) return;
    e.preventDefault();
    if (searchOpen.value) closeSearch();
    else close();
    return;
  }
  if (isTextTarget(e.target)) return;
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && escHandle && !escHandle.isTopmost()) return;
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
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  escHandle?.release(); // 卸载兜底出栈（release 幂等）
  escHandle = null;
});
</script>

<template>
  <Teleport to="body">
    <Transition name="diff-fade">
      <div v-if="target" ref="overlayEl" class="diff-overlay" @click="onOverlayClick">
        <div
          ref="dialogEl"
          class="diff-dialog"
          role="dialog"
          aria-modal="true"
          :aria-label="`轮末改动对比 ${filePath}`"
        >
          <div class="diff-main">
            <header class="diff-header">
              <div class="diff-header__main">
                <div class="diff-eyebrow">
                  <span class="dot"></span>
                  轮末文件改动
                  <span class="diff-eyebrow__badge" :class="{ 'diff-eyebrow__badge--first': entry?.mode === 'first-change' }">{{ modeBadge }}</span>
                </div>
                <h2 class="diff-title">
                  <span v-if="pathParts.dir" class="diff-title__dir">{{ pathParts.dir }}/</span><b>{{ pathParts.name || '—' }}</b>
                </h2>
                <p class="diff-meta">
                  <template v-if="bodyState === 'ready' && parsed">
                    <span class="stat stat-add">+{{ counts.add }}</span>
                    <span class="stat stat-del">−{{ counts.del }}</span>
                    <span>{{ navTotal }} 处改动</span>
                    <span v-if="entry?.truncated">差异过大，仅显示前部分</span>
                  </template>
                  <template v-else-if="bodyState === 'loading'">正在加载…</template>
                  <template v-else-if="bodyState === 'error'">加载失败</template>
                  <template v-else-if="bodyState === 'unavailable'">二进制或快照缺失</template>
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
                  <button v-for="n in CONTEXT_OPTIONS" :key="n" type="button" :class="{ active: context === n && !fullText }" @click="setContext(n)">{{ n }}</button>
                  <button type="button" :class="{ active: fullText }" title="展示文件完整内容" @click="setFullText">全文</button>
                </div>
              </div>

              <div class="toolbar__spacer"></div>

              <button
                class="tbtn"
                type="button"
                :class="{ active: searchOpen }"
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
            </div>

            <div v-if="searchOpen" class="diff-searchbar" role="search">
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

            <!-- 纸面（D1 纸面分层，与 DiffDialog/ToolDiffDialog 同款）：列头 + 渲染器装进留白纸卡 -->
            <div class="paperwrap">
              <div class="paper">
                <div v-if="bodyState === 'ready' && parsed && mode === 'split'" class="diff-colheads">
                  <div class="colhead"><span class="colhead__tick"></span>改动前</div>
                  <div class="colhead colhead--river" aria-hidden="true"></div>
                  <div class="colhead"><span class="colhead__tick colhead__tick--new"></span>改动后</div>
                </div>

                <!-- 懒加载中：spinner -->
                <div v-if="bodyState === 'loading'" class="diff-state">
                  <span class="diff-spinner" aria-hidden="true"></span>
                  <p>正在加载改动对比…</p>
                </div>
                <!-- invoke 失败：错误态 + 重试 -->
                <div v-else-if="bodyState === 'error'" class="diff-state">
                  <h3>加载失败</h3>
                  <p>{{ loadError }}</p>
                  <button type="button" class="tbtn diff-state__retry" @click="retry">重试</button>
                </div>
                <!-- mode='unavailable'：空态 -->
                <div v-else-if="bodyState === 'unavailable'" class="diff-state">
                  <div class="diff-state__icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <path d="M9 12l2 2 4-4" />
                    </svg>
                  </div>
                  <h3>暂时无法预览这份 Diff。</h3>
                  <p>该文件是二进制，或本轮缺少可对比的快照，且编辑意图不可用（入参缺失或被截断）。</p>
                </div>
                <!-- 就绪（parsed 为 null 时 DiffBody 自带「无可显示差异」空态） -->
                <DiffBody
                  v-else
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
              </div>
            </div>

            <footer class="diff-footer">
              <div class="legend">
                <span><i class="lg-add"></i>新增</span>
                <span><i class="lg-del"></i>删除</span>
                <span><i class="lg-mod"></i>修改</span>
              </div>
            </footer>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 衍生 token：与 ToolDiffDialog 同源（绿增 / 红删 / 琥珀改），DiffBody/DiffLine 经 CSS 变量继承拿到。 */
.diff-overlay {
  --add-bg-strong: color-mix(in srgb, var(--color-success) 28%, transparent);
  --add-word: color-mix(in srgb, var(--color-success) 34%, transparent);
  --add-edge: var(--color-success);
  --add-text: var(--color-success-strong);
  --del-bg-strong: color-mix(in srgb, var(--color-danger) 22%, transparent);
  --del-word: color-mix(in srgb, var(--color-danger) 28%, transparent);
  --del-edge: var(--color-danger);
  --del-text: var(--color-danger);
  --mod-bg: color-mix(in srgb, var(--color-warn) 12%, transparent);
  --mod-edge: var(--color-warn-strong);
  --diff-line-h: 22px;
  --diff-font: 12.5px;
  /* 纸面工坊 token 与 DiffDialog 同步（DiffBody/DiffLine 复用，被动传播需要） */
  --add-tint: color-mix(in srgb, var(--color-success) 9%, transparent);
  --del-tint: color-mix(in srgb, var(--color-danger) 8%, transparent);
  --add-card-edge: color-mix(in srgb, var(--color-success) 15%, transparent);
  --del-card-edge: color-mix(in srgb, var(--color-danger) 15%, transparent);
  /* v9 行号贴码 token（与 DiffDialog/ToolDiffDialog 同步，DiffBody 复用） */
  --river-w: 46px;
  --gutter-w: 38px;

  position: fixed;
  inset: 0;
  /* 与 ToolDiffDialog 同层（1250）：diff 在场时恒为视觉最上层（ESC_LAYER_PRIORITY.toolDiffDialog 同值） */
  z-index: 1250;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--interaction-overlay-bg, rgba(0, 0, 0, 0.58));
  backdrop-filter: blur(3px);
}
.diff-fade-enter-active,
.diff-fade-leave-active {
  transition: opacity var(--duration-base) var(--ease-out);
}
.diff-fade-enter-from,
.diff-fade-leave-to {
  opacity: 0;
}

.diff-dialog {
  /* 几何对齐 ToolDiffDialog ensureRect（1280×840 视口内自适应，pad 8） */
  width: min(1280px, calc(100vw - 16px));
  height: min(840px, calc(100vh - 16px));
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
  background: var(--color-warn-strong);
}
/* mode 徽标：首改（编辑意图）/ 与上一轮的差异 */
.diff-eyebrow__badge {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-text) 5%, transparent);
  border: 1px solid var(--color-border);
}
.diff-eyebrow__badge--first {
  color: var(--color-accent-strong);
  background: color-mix(in srgb, var(--color-accent) 14%, transparent);
  border-color: color-mix(in srgb, var(--color-accent) 35%, transparent);
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
.stat {
  font-family: var(--font-sans);
  font-weight: 700;
}
.stat-add { color: var(--add-text); }
.stat-del { color: var(--del-text); }
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
.tbtn svg {
  width: 14px;
  height: 14px;
}
.diff-searchbar {
  flex: 0 0 auto;
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border-bottom: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-panel-soft) 82%, var(--color-accent) 4%);
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

/* 纸面（D1，与 DiffDialog/ToolDiffDialog 同款）：代码区外扩 12px 留白成圆角纸卡 */
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

/* 纸内列头（split 专属）：tick 小方块 + river 占位列 */
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
  flex: 0 0 calc(var(--gutter-w) * 2 + var(--river-w));
  padding: 6px 0;
  justify-content: center;
}

/* 异步/空态（loading spinner / 错误重试 / unavailable） */
.diff-state {
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 6px;
  padding: 40px;
  text-align: center;
}
.diff-state h3 {
  margin: 0 0 2px;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}
.diff-state p {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 13px;
  max-width: 420px;
  line-height: 1.6;
  word-break: break-all;
}
.diff-state__icon {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-lg);
  display: grid;
  place-items: center;
  margin: 0 0 8px;
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  color: var(--color-accent-strong);
}
.diff-state__icon svg {
  width: 28px;
  height: 28px;
}
.diff-state__retry {
  margin-top: 10px;
}
.diff-spinner {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2.5px solid color-mix(in srgb, var(--color-text) 15%, transparent);
  border-top-color: var(--color-accent);
  animation: turn-diff-spin 0.8s linear infinite;
  margin-bottom: 4px;
}
@keyframes turn-diff-spin {
  to {
    transform: rotate(360deg);
  }
}

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
  .diff-spinner {
    animation: none;
  }
}

@media (max-width: 720px) {
  .diff-dialog {
    width: 100vw !important;
    height: 100vh !important;
    border-radius: 0;
  }
}
</style>
