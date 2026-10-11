<script setup lang="ts">
// FilePickerDialog.vue —— 自绘文件/目录选择弹窗（原生弹窗统一改造 T2 渲染层）。
// 消费 fs-picker-store 的单例队列（current），替换 Windows 原生 file/directory picker：
//   directory（选文件夹）/ save-file（选保存位置+文件名，含覆盖确认）/ open-file（选文件，可多选）。
// 文件系统元数据全部走 window.claudeLink.fs* 只读 IPC（主进程 modules/fs-picker.ts 兜底 3s 预算）。
//
// 视觉/交互基准 1:1 对齐既有弹窗：蒙层与按钮形态取 ExportImageFormatDialog，
// Transition 淡入 + 卡片 spring 进场 / trapTab / 焦点管理取 DiffDialog，Esc 层走 use-esc-stack
//（filePicker 9100：高于导出格式 9000、低于灯箱 9999）。App.vue 单例常驻，v-if 由 store.current 控制。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { FsDirEntry, FsDriveInfo, FsListError, FsListResult, FsMkdirResult, FsQuickLocation, FsStatResult } from '@shared/types/fs-picker';
import { ESC_LAYER_PRIORITY, pushEscLayer, type EscLayerHandle } from '../../composables/use-esc-stack';
import { useFsPickerStore } from '../../stores/fs-picker-store';

const store = useFsPickerStore();

// ── 基础派生态 ──
const req = computed(() => store.current?.req ?? null);
const mode = computed(() => req.value?.mode ?? 'directory');
const roots = computed(() => store.roots);

// ── 列表状态 ──
const curDir = ref('');
const entries = ref<FsDirEntry[]>([]);
const loading = ref(false);
const listError = ref<FsListError | null>(null);
const selectedNames = ref(new Set<string>());
const cursorName = ref<string | null>(null);        // ↑↓ 键盘游标（同步跟随单击选中）
const pendingSelectName = ref('');                  // mkdir 成功后刷新列表要选中的新目录名
let loadToken = 0;                                  // 加载竞态：切目录后旧响应 token 不匹配即丢弃

// ── save-file 状态 ──
const filename = ref('');
const saveError = ref('');
const overwriteView = ref(false);                   // 内嵌覆盖确认视图（替换列表区）
const overwriteName = ref('');

// ── 新建文件夹状态 ──
const creating = ref(false);
const mkdirName = ref('');
const mkdirError = ref('');
let mkdirBusy = false;                              // 提交在途时失焦不取消

// ── DOM ref ──
const cardRef = ref<HTMLDivElement | null>(null);
const mkdirInput = ref<HTMLInputElement | null>(null);
const filenameInput = ref<HTMLInputElement | null>(null);
const overwriteBackBtn = ref<HTMLButtonElement | null>(null);

// ── 路径小工具（渲染层无 node:path，Windows 盘符路径手写；主进程 listDir 会 resolve 归一） ──
function joinPath(dir: string, name: string): string {
  return /[\\/]$/.test(dir) ? dir + name : dir + '\\' + name;
}
/** 上级目录；盘根（C:\）或非盘符路径返回 null（「上一级」置灰依据）。 */
function parentDir(p: string): string | null {
  const m = /^([a-zA-Z]:)([\\/].*)?$/.exec(p);
  if (!m || !m[2] || m[2] === '\\' || m[2] === '/') return null;
  const body = m[2].replace(/[\\/]+$/, '');
  const cut = Math.max(body.lastIndexOf('\\'), body.lastIndexOf('/'));
  const parentBody = cut <= 0 ? '' : body.slice(0, cut);
  return `${m[1]}\\${parentBody}`;
}
function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i === -1 ? p : p.slice(i + 1);
}
function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
}

// ── 面包屑：当前目录祖先链（C: > Users > foo > bar；当前段高亮不可点） ──
const crumb = computed<{ label: string; path: string }[]>(() => {
  const segs: { label: string; path: string }[] = [];
  const m = /^([a-zA-Z]:)([\\/].*)?$/.exec(curDir.value);
  if (!m) {
    segs.push({ label: curDir.value, path: curDir.value });
    return segs;
  }
  segs.push({ label: `${m[1]}\\`, path: `${m[1]}\\` });
  let acc = `${m[1]}\\`;
  for (const part of (m[2] ?? '').split(/[\\/]+/)) {
    if (!part) continue;
    acc = joinPath(acc, part);
    segs.push({ label: part, path: acc });
  }
  return segs;
});
const parentPath = computed(() => parentDir(curDir.value));

// ── 选择集 ──
const selectableNames = computed(() =>
  entries.value.filter((en) => en.isDir || mode.value !== 'directory').map((en) => en.name),
);
const selectedPaths = computed(() =>
  entries.value
    .filter((en) => !en.isDir && selectedNames.value.has(en.name))
    .map((en) => joinPath(curDir.value, en.name)),
);
const activeDescId = computed(() => {
  if (!cursorName.value) return undefined;
  const i = entries.value.findIndex((en) => en.name === cursorName.value);
  return i === -1 ? undefined : `fp-dlg-opt-${i}`;
});
function setSingle(name: string): void {
  selectedNames.value = new Set([name]);
  cursorName.value = name;
}

// ── 列表加载（竞态守卫） ──
async function loadDir(dir: string): Promise<void> {
  const token = ++loadToken;
  loading.value = true;
  listError.value = null;
  entries.value = [];
  selectedNames.value = new Set();
  cursorName.value = null;
  overwriteView.value = false;
  curDir.value = dir;                       // 先置路径：面包屑/底部路径即时跟随（错误视图也显示）
  let r: FsListResult;
  try {
    r = await window.claudeLink.fsListDir(dir);
  } catch {
    if (token !== loadToken) return;
    loading.value = false;
    listError.value = 'not-found';          // IPC 异常归 not-found（主进程 3s 预算兜底超时）
    return;
  }
  if (token !== loadToken) return;          // 旧请求迟到：丢弃
  loading.value = false;
  if (r.ok) {
    curDir.value = r.path;                  // 主进程 path.resolve 归一后的路径
    entries.value = r.entries;
    if (pendingSelectName.value) {
      const name = pendingSelectName.value;
      pendingSelectName.value = '';
      if (r.entries.some((en) => en.name === name)) setSingle(name);
    }
  } else {
    entries.value = [];
    listError.value = r.error;
  }
}

// ── 行交互 ──
function onRowClick(en: FsDirEntry, evt: MouseEvent): void {
  if (en.isDir) {
    setSingle(en.name);
    return;
  }
  if (mode.value === 'directory') return;   // directory 模式文件不可选（降透明度展示）
  if (mode.value === 'save-file') {
    // 原生保存框语义：点已有文件 → 文件名进输入框（覆盖确认在保存链里）。
    setSingle(en.name);
    filename.value = en.name;
    saveError.value = '';
    return;
  }
  if (req.value?.multiSelect && (evt.ctrlKey || evt.metaKey)) {
    const next = new Set(selectedNames.value);
    if (next.has(en.name)) next.delete(en.name);
    else next.add(en.name);
    selectedNames.value = next;
    cursorName.value = en.name;
    return;
  }
  setSingle(en.name);
}
function onRowDblClick(en: FsDirEntry): void {
  if (en.isDir) {
    void loadDir(joinPath(curDir.value, en.name));
    return;
  }
  if (mode.value === 'open-file') {
    // 双击项在多选集内且集非单 → 整集确认（资源管理器语义）；否则只确认该项。
    const sel = selectedNames.value;
    const paths = sel.has(en.name) && sel.size > 1 ? selectedPaths.value : [joinPath(curDir.value, en.name)];
    store.settleCurrent({ kind: 'files', paths });
  } else if (mode.value === 'save-file') {
    filename.value = en.name;
    void confirmSave();
  }
}

// ── 底部确认 ──
function cancel(): void {
  store.settleCurrent({ kind: 'cancel' });
}
function confirmDirectory(): void {
  store.settleCurrent({ kind: 'directory', dir: curDir.value });
}
function confirmOpen(): void {
  if (selectedPaths.value.length === 0) return;
  store.settleCurrent({ kind: 'files', paths: selectedPaths.value });
}

// ── save-file 保存链（校验 → fsStat → 覆盖确认视图 / resolve） ──
async function confirmSave(): Promise<void> {
  const name = filename.value.trim();
  if (!name) {
    saveError.value = '请输入文件名';
    return;
  }
  if (/[\\/:*?"<>|]/.test(name) || name.endsWith('.') || name.endsWith(' ')) {
    saveError.value = '名称含非法字符（\\ / : * ? " < > |），或以点/空格结尾';
    return;
  }
  if (name.length > 255) {
    saveError.value = '名称过长（上限 255 字符）';
    return;
  }
  saveError.value = '';
  const dir = curDir.value;                 // await 期间 curDir 可能被导航改写，固定取发起时目录
  const reqId = req.value?.id;              // await 期间用户取消且队列切下一单时，不得把过期结果结算到新请求
  const target = joinPath(dir, name);
  let st: FsStatResult;
  try {
    st = await window.claudeLink.fsStat(target);
  } catch {
    if (req.value?.id !== reqId) return;
    saveError.value = '无法检查目标文件，请重试';
    return;
  }
  if (!req.value || req.value.id !== reqId) return; // 弹窗已关或已换单——不再结算
  if (!st.exists) {
    store.settleCurrent({ kind: 'save', dir, filename: name });
    return;
  }
  if (st.isDir) {
    saveError.value = '同名文件夹已存在';
    return;
  }
  overwriteName.value = name;
  overwriteView.value = true;
  await nextTick();
  overwriteBackBtn.value?.focus();
}
function overwriteBack(): void {
  overwriteView.value = false;              // 恢复列表视图，输入框内容保留可改
}
function overwriteConfirm(): void {
  store.settleCurrent({ kind: 'save', dir: curDir.value, filename: overwriteName.value });
}

// ── 新建文件夹（列表顶部行内输入；Enter 提交 / Esc 或失焦取消） ──
function startMkdir(): void {
  creating.value = true;
  mkdirName.value = '';
  mkdirError.value = '';
  void nextTick(() => mkdirInput.value?.focus());
}
function cancelMkdir(): void {
  if (mkdirBusy) return;
  creating.value = false;
  mkdirError.value = '';
}
function onMkdirBlur(): void {
  if (creating.value && !mkdirBusy) cancelMkdir();
}
async function submitMkdir(): Promise<void> {
  if (!creating.value || mkdirBusy) return;
  const name = mkdirName.value.trim();
  if (!name) {
    mkdirError.value = '请输入文件夹名称';
    return;
  }
  const dir = curDir.value;
  const reqId = req.value?.id;              // await 期间换单守卫（同 confirmSave）
  mkdirBusy = true;
  let r: FsMkdirResult;
  try {
    r = await window.claudeLink.fsMkdir(dir, name);
  } catch {
    mkdirBusy = false;
    if (req.value?.id !== reqId) return;
    mkdirError.value = '创建失败，请检查权限';
    return;
  }
  mkdirBusy = false;
  if (!req.value || req.value.id !== reqId) return; // 弹窗已关或已换单——不再结算/刷新
  if (r.ok) {
    creating.value = false;
    mkdirError.value = '';
    pendingSelectName.value = name;         // 刷新完成后选中新建目录
    void loadDir(dir);
  } else if (r.error === 'exists') {
    mkdirError.value = '同名文件夹已存在';
  } else if (r.error === 'invalid-name') {
    mkdirError.value = '名称含非法字符';
  } else {
    mkdirError.value = '创建失败，请检查权限';
  }
}

// ── 左栏 / 键盘导航辅助 ──
function isQuickActive(q: FsQuickLocation): boolean {
  return samePath(q.path, curDir.value);
}
function isDriveActive(d: FsDriveInfo): boolean {
  return curDir.value.toUpperCase().startsWith(d.path.toUpperCase());
}
function goParent(): void {
  const p = parentPath.value;
  if (p) void loadDir(p);
}
function moveCursor(delta: 1 | -1): void {
  const arr = selectableNames.value;
  if (!arr.length) return;
  let i = cursorName.value ? arr.indexOf(cursorName.value) : -1;
  if (i === -1) i = delta > 0 ? -1 : arr.length;   // 无游标：↓取首项、↑取末项
  i = Math.max(0, Math.min(arr.length - 1, i + delta));
  setSingle(arr[i]);
  void nextTick(() => {
    const el = cardRef.value?.querySelector<HTMLElement>(
      `[data-fp-name="${CSS.escape(arr[i])}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  });
}
function activateCursor(): void {
  const name = cursorName.value;
  if (!name) return;
  const en = entries.value.find((e) => e.name === name);
  if (!en) return;
  if (en.isDir) {
    void loadDir(joinPath(curDir.value, en.name));
    return;
  }
  if (mode.value === 'open-file') {
    confirmOpen();
  } else if (mode.value === 'save-file') {
    filename.value = en.name;
    void confirmSave();
  }
}

// ── 格式化（mtime 复用 toLocaleString；size 按 1024 进制，目录 — ） ──
function formatMtime(en: FsDirEntry): string {
  return en.mtimeMs > 0 ? new Date(en.mtimeMs).toLocaleString() : '—';
}
function formatSize(en: FsDirEntry): string {
  if (en.isDir) return '—';
  const b = en.size;
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}
const LIST_ERROR_TEXT: Record<FsListError, string> = {
  'access-denied': '没有访问权限',
  'not-found': '文件夹不存在或已被删除',
  'timeout': '访问超时（网络路径可能不可达）',
};

// ── a11y / 键盘（对齐 DiffDialog：Esc 让位 / trapTab / isTextTarget / 卸载兜底） ──
let escHandle: EscLayerHandle | null = null;
let lastFocus: HTMLElement | null = null;

function isTextTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}
function trapTab(e: KeyboardEvent): void {
  const dlg = cardRef.value;
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
  if (!req.value) return; // 弹窗未开不响应，避免与 InteractionPrompt 等的 Esc 抢
  if (e.key === 'Escape') {
    // 更高层遮罩（灯箱）在场时让位——Esc 只关最上层。
    if (escHandle && !escHandle.isTopmost()) return;
    e.preventDefault();
    cancel();
    return;
  }
  if (e.key === 'Tab') {
    trapTab(e);
    return;
  }
  if (isTextTarget(e.target)) return;       // 文件名/新建文件夹输入框内的键由输入框自身处理（Enter/Esc 已 stop）
  // 列表操作键与 Esc 同款让位：更高层遮罩在场时不操作被遮挡的弹窗。
  if (escHandle && !escHandle.isTopmost()) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveCursor(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveCursor(-1);
  } else if (e.key === 'Enter') {
    // 覆盖确认视图 / 新建行在场时 Enter 交给聚焦元素的原生行为（按钮激活/输入框提交）。
    if (overwriteView.value || creating.value) return;
    e.preventDefault();
    activateCursor();
  } else if (e.key === 'Backspace') {
    const p = parentPath.value;
    if (p) {
      e.preventDefault();                   // 防 Backspace 触发历史导航
      void loadDir(p);
    }
  } else if (e.ctrlKey && e.key.toLowerCase() === 'a') {
    if (mode.value === 'open-file' && req.value.multiSelect) {
      e.preventDefault();
      const names = entries.value.filter((en) => !en.isDir).map((en) => en.name);
      selectedNames.value = new Set(names);
      if (names.length) cursorName.value = names[names.length - 1];
    }
  }
}

// ── 打开 / 关闭（含队列换单：current 直接切换，本 watch 重开） ──
function resetView(): void {
  loadToken++;                              // 使在途加载响应全部失效
  entries.value = [];
  loading.value = false;
  listError.value = null;
  selectedNames.value = new Set();
  cursorName.value = null;
  pendingSelectName.value = '';
  overwriteView.value = false;
  overwriteName.value = '';
  creating.value = false;
  mkdirBusy = false;
  mkdirName.value = '';
  mkdirError.value = '';
  saveError.value = '';
  filename.value = baseName(store.current?.req.filename ?? '');
}
watch(() => store.current, async (cur, prev) => {
  if (cur) {
    if (!escHandle) escHandle = pushEscLayer(ESC_LAYER_PRIORITY.filePicker);
    if (!prev) lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    resetView();
    // 初始目录：defaultPath 优先；缺省等 roots（home）；仍无则 C:\ 兜底（listRoots 失败场景）。
    let initial = cur.req.defaultPath?.trim() ?? '';
    if (!initial) {
      await store.ensureRoots();
      initial = store.roots?.cwdHome ?? 'C:\\';
    } else {
      void store.ensureRoots();             // 左栏 roots 异步补齐（响应式）
    }
    await loadDir(initial);
    await nextTick();
    cardRef.value?.focus();
  } else {
    escHandle?.release();
    escHandle = null;
    await nextTick();
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }
});

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  // 卸载兜底出栈（release 幂等）。
  escHandle?.release();
  escHandle = null;
});
</script>

<template>
  <Teleport to="body">
    <Transition name="fp-fade">
      <div v-if="req" class="fp-overlay" role="presentation" @click.self="cancel">
        <div
          ref="cardRef"
          class="fp-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="fp-dlg-title"
          tabindex="-1"
        >
          <!-- 头部 -->
          <header class="fp-header">
            <h3 id="fp-dlg-title" class="fp-header__title">{{ req.title }}</h3>
            <button type="button" class="fp-btn fp-btn--ghost fp-header__close" aria-label="关闭" @click="cancel">×</button>
          </header>

          <!-- 工具行：上级 / 新建文件夹 / 面包屑 -->
          <div class="fp-toolbar">
            <button type="button" class="fp-btn fp-btn--ghost fp-btn--sm" :disabled="!parentPath" @click="goParent">← 上级</button>
            <button type="button" class="fp-btn fp-btn--ghost fp-btn--sm" @click="startMkdir">新建文件夹</button>
            <nav class="fp-crumb" aria-label="当前路径">
              <template v-for="(seg, i) in crumb" :key="seg.path">
                <span v-if="i > 0" class="fp-crumb__sep" aria-hidden="true">›</span>
                <button
                  v-if="i < crumb.length - 1"
                  type="button"
                  class="fp-crumb__seg"
                  :title="seg.path"
                  @click="loadDir(seg.path)"
                >{{ seg.label }}</button>
                <span v-else class="fp-crumb__seg fp-crumb__seg--cur" aria-current="page" :title="seg.path">{{ seg.label }}</span>
              </template>
            </nav>
          </div>

          <!-- 主体：左栏（快捷位置 + 驱动器） + 右列（文件列表） -->
          <div class="fp-body">
            <aside class="fp-aside">
              <button
                v-for="q in roots?.quick ?? []"
                :key="q.id"
                type="button"
                class="fp-aside__item"
                :class="{ 'is-active': isQuickActive(q) }"
                :title="q.path"
                @click="loadDir(q.path)"
              >{{ q.label }}</button>
              <div v-if="(roots?.quick.length ?? 0) > 0 && (roots?.drives.length ?? 0) > 0" class="fp-aside__hr"></div>
              <button
                v-for="d in roots?.drives ?? []"
                :key="d.path"
                type="button"
                class="fp-aside__item"
                :class="{ 'is-active': isDriveActive(d) }"
                :title="d.path"
                @click="loadDir(d.path)"
              >{{ d.letter }}:</button>
              <div v-if="!roots" class="fp-aside__hint">位置加载中…</div>
            </aside>

            <div class="fp-list">
              <!-- 内嵌覆盖确认视图（save-file 目标已存在） -->
              <div v-if="overwriteView" class="fp-state fp-overwrite">
                <p class="fp-overwrite__title">目标已存在，是否覆盖？</p>
                <p class="fp-overwrite__name" :title="overwriteName">{{ overwriteName }}</p>
                <div class="fp-overwrite__actions">
                  <button ref="overwriteBackBtn" type="button" class="fp-btn fp-btn--ghost" @click="overwriteBack">返回</button>
                  <button type="button" class="fp-btn fp-btn--primary" @click="overwriteConfirm">覆盖</button>
                </div>
              </div>

              <!-- 加载态（主进程 3s 预算兜底超时） -->
              <div v-else-if="loading" class="fp-state">正在读取文件夹…</div>

              <!-- 错误态 -->
              <div v-else-if="listError" class="fp-state fp-error">
                <p class="fp-error__title">无法访问该文件夹</p>
                <p class="fp-error__desc">{{ LIST_ERROR_TEXT[listError] }}</p>
                <button type="button" class="fp-btn fp-btn--ghost" :disabled="!parentPath" @click="goParent">返回上级</button>
              </div>

              <!-- 空态 / 列表 -->
              <template v-else>
                <!-- 新建文件夹：列表顶部行内输入（Enter 提交 / Esc 或失焦取消） -->
                <div v-if="creating" class="fp-mkdir">
                  <span class="fp-entry__icon" aria-hidden="true">📁</span>
                  <input
                    ref="mkdirInput"
                    v-model="mkdirName"
                    class="fp-mkdir__input"
                    type="text"
                    placeholder="输入文件夹名称"
                    aria-label="新文件夹名称"
                    @keydown.enter.stop.prevent="submitMkdir"
                    @keydown.esc.stop.prevent="cancelMkdir"
                    @blur="onMkdirBlur"
                  />
                  <button
                    type="button"
                    class="fp-btn fp-btn--ghost fp-btn--sm"
                    @mousedown.prevent
                    @click="submitMkdir"
                  >确定</button>
                </div>
                <div v-if="mkdirError" class="fp-inline-error" role="alert">{{ mkdirError }}</div>

                <div v-if="entries.length === 0" class="fp-state">此文件夹为空</div>
                <template v-else>
                  <div class="fp-list__head" aria-hidden="true">
                    <span>名称</span><span>修改时间</span><span>大小</span>
                  </div>
                  <div
                    class="fp-list__scroll"
                    role="listbox"
                    aria-label="文件列表"
                    tabindex="0"
                    :aria-activedescendant="activeDescId"
                  >
                    <div
                      v-for="(en, idx) in entries"
                      :id="`fp-dlg-opt-${idx}`"
                      :key="en.name"
                      class="fp-entry"
                      :class="{
                        'is-dir': en.isDir,
                        'is-hidden': en.hidden,
                        'is-selected': selectedNames.has(en.name),
                        'is-disabled': !en.isDir && mode === 'directory',
                      }"
                      role="option"
                      :aria-selected="selectedNames.has(en.name)"
                      :data-fp-name="en.name"
                      @click="onRowClick(en, $event)"
                      @dblclick="onRowDblClick(en)"
                    >
                      <span class="fp-entry__name">
                        <span v-if="en.isDir" class="fp-entry__icon" aria-hidden="true">📁</span>{{ en.name }}
                      </span>
                      <span class="fp-entry__mtime">{{ formatMtime(en) }}</span>
                      <span class="fp-entry__size">{{ formatSize(en) }}</span>
                    </div>
                  </div>
                </template>
              </template>
            </div>
          </div>

          <!-- 底部：按模式 -->
          <footer class="fp-footer">
            <div v-if="mode === 'directory'" class="fp-footer__left">
              <div class="fp-curpath" :title="curDir">{{ curDir }}</div>
            </div>
            <div v-else-if="mode === 'save-file'" class="fp-footer__left fp-footer__left--col">
              <input
                ref="filenameInput"
                v-model="filename"
                class="fp-save__input"
                type="text"
                placeholder="文件名"
                aria-label="文件名"
                @keydown.enter.stop.prevent="confirmSave"
              />
              <div v-if="saveError" class="fp-inline-error" role="alert">{{ saveError }}</div>
            </div>
            <div v-else class="fp-footer__left">
              <div class="fp-count">{{ selectedNames.size > 0 ? `已选 ${selectedNames.size} 项` : '未选择' }}</div>
            </div>
            <div class="fp-actions">
              <button type="button" class="fp-btn fp-btn--ghost" @click="cancel">取消</button>
              <button v-if="mode === 'directory'" type="button" class="fp-btn fp-btn--primary" @click="confirmDirectory">选择此文件夹</button>
              <button v-else-if="mode === 'save-file'" type="button" class="fp-btn fp-btn--primary" @click="confirmSave">保存</button>
              <button v-else type="button" class="fp-btn fp-btn--primary" :disabled="selectedNames.size === 0" @click="confirmOpen">选择</button>
            </div>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fp-overlay {
  position: fixed;
  inset: 0;
  background: var(--interaction-overlay-bg, rgba(0, 0, 0, 0.45));
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9100; /* 与 ESC_LAYER_PRIORITY.filePicker 同源 */
  padding: 1rem;
}
.fp-card {
  width: min(720px, 100%);
  height: min(480px, 80vh);
  display: flex;
  flex-direction: column;
  background: var(--color-panel-soft, #1e1e24);
  color: var(--color-text, #e6e6e6);
  border-radius: var(--radius-lg, 14px);
  box-shadow: var(--elevation-3, 0 12px 40px rgba(0, 0, 0, 0.5));
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  outline: none;
  overflow: hidden;
  animation: fp-in var(--duration-slow) var(--ease-spring);
}
@keyframes fp-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.fp-fade-enter-active,
.fp-fade-leave-active {
  transition: opacity var(--duration-base) var(--ease-out);
}
.fp-fade-enter-from,
.fp-fade-leave-to {
  opacity: 0;
}

/* 头部 */
.fp-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.7rem 0.9rem 0.5rem;
}
.fp-header__title { margin: 0; font-size: 1.02rem; font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fp-header__close { flex: 0 0 auto; width: 1.7rem; height: 1.7rem; padding: 0; font-size: 1rem; line-height: 1; }

/* 工具行 */
.fp-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0 0.9rem 0.5rem;
  min-width: 0;
}
.fp-crumb {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.15rem;
  overflow: hidden;
  white-space: nowrap;
  font-size: 0.78rem;
}
.fp-crumb__sep { opacity: 0.45; }
.fp-crumb__seg {
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 0.1rem 0.25rem;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.75;
}
.fp-crumb__seg:hover { background: rgba(128, 128, 128, 0.15); opacity: 1; }
.fp-crumb__seg--cur { cursor: default; font-weight: 600; opacity: 1; }

/* 主体 */
.fp-body {
  flex: 1;
  min-height: 0;
  display: flex;
  border-top: 1px solid var(--color-border, rgba(128, 128, 128, 0.25));
  border-bottom: 1px solid var(--color-border, rgba(128, 128, 128, 0.25));
}
.fp-aside {
  flex: 0 0 180px;
  overflow-y: auto;
  padding: 0.4rem 0.35rem;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  border-right: 1px solid var(--color-border, rgba(128, 128, 128, 0.25));
}
.fp-aside__item {
  text-align: left;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 0.8rem;
  padding: 0.32rem 0.5rem;
  border-radius: var(--radius-md, 8px);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fp-aside__item:hover { background: rgba(128, 128, 128, 0.14); }
.fp-aside__item.is-active {
  background: var(--color-accent-soft, rgba(76, 154, 255, 0.12));
  color: var(--color-accent, #4c9aff);
  font-weight: 600;
}
.fp-aside__hr { height: 1px; margin: 0.35rem 0.4rem; background: var(--color-border, rgba(128, 128, 128, 0.25)); }
.fp-aside__hint { font-size: 0.75rem; opacity: 0.55; padding: 0.3rem 0.5rem; }

/* 右列列表 */
.fp-list { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.fp-list__head,
.fp-entry {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 150px 70px;
  gap: 0.5rem;
  align-items: center;
  padding: 0 0.75rem 0 0.6rem;
}
.fp-list__head {
  flex: 0 0 auto;
  font-size: 0.72rem;
  opacity: 0.6;
  padding-top: 0.4rem;
  padding-bottom: 0.35rem;
  border-bottom: 1px solid var(--color-border, rgba(128, 128, 128, 0.2));
  user-select: none;
}
.fp-list__scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 0.2rem 0; outline: none; }
.fp-entry {
  height: 30px;
  font-size: 0.8rem;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
}
.fp-entry:hover { background: rgba(128, 128, 128, 0.12); }
.fp-entry.is-selected {
  background: var(--color-accent-soft, rgba(76, 154, 255, 0.16));
  box-shadow: inset 2px 0 0 var(--color-accent, #4c9aff);
}
.fp-entry.is-disabled { opacity: 0.45; cursor: default; }
.fp-entry.is-disabled:hover { background: transparent; }
.fp-entry.is-hidden { opacity: 0.55; }
.fp-entry.is-disabled.is-hidden { opacity: 0.3; }
.fp-entry__name { display: flex; align-items: center; gap: 0.35rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fp-entry__icon { flex: 0 0 auto; }
.fp-entry__mtime, .fp-entry__size { font-size: 0.73rem; opacity: 0.65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; }

/* 状态视图（加载/错误/空/覆盖确认） */
.fp-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  opacity: 0.85;
  padding: 1rem;
  text-align: center;
}
.fp-error__title, .fp-overwrite__title { margin: 0; font-weight: 600; font-size: 0.95rem; }
.fp-error__desc, .fp-overwrite__name { margin: 0 0 0.4rem; font-size: 0.8rem; opacity: 0.75; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fp-overwrite__actions { display: flex; gap: 0.5rem; margin-top: 0.4rem; }

/* 新建文件夹行 */
.fp-mkdir {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.6rem 0.15rem;
}
.fp-mkdir__input {
  flex: 1;
  min-width: 0;
  font-size: 0.8rem;
  padding: 0.25rem 0.45rem;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--color-accent, #4c9aff);
  background: var(--color-panel, transparent);
  color: inherit;
  outline: none;
}
.fp-inline-error {
  flex: 0 0 auto;
  font-size: 0.74rem;
  color: var(--color-danger, #c05656);
  padding: 0 0.75rem 0.25rem;
}

/* 底部 */
.fp-footer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 0.9rem;
  min-width: 0;
}
.fp-footer__left { flex: 1; min-width: 0; }
.fp-footer__left--col { display: flex; flex-direction: column; gap: 0.2rem; }
.fp-curpath {
  font-family: var(--font-mono, ui-monospace, Consolas, monospace);
  font-size: 0.75rem;
  opacity: 0.8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fp-count { font-size: 0.78rem; opacity: 0.75; }
.fp-save__input {
  width: 100%;
  box-sizing: border-box;
  font-size: 0.82rem;
  padding: 0.35rem 0.5rem;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--color-border, rgba(128, 128, 128, 0.35));
  background: var(--color-panel, transparent);
  color: inherit;
  outline: none;
}
.fp-save__input:focus-visible { border-color: var(--color-accent, #4c9aff); }
.fp-actions { flex: 0 0 auto; display: flex; gap: 0.5rem; }

/* 按钮（沿用 export-fmt 形态） */
.fp-btn {
  padding: 0.45rem 1rem;
  border-radius: var(--radius-md, 8px);
  border: 1px solid transparent;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 500;
}
.fp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.fp-btn--sm { padding: 0.28rem 0.6rem; font-size: 0.78rem; }
.fp-btn--ghost {
  background: transparent;
  border-color: var(--color-border, rgba(255, 255, 255, 0.15));
  color: inherit;
}
.fp-btn--ghost:hover:not(:disabled) { background: rgba(128, 128, 128, 0.12); }
.fp-btn--primary {
  background: var(--color-accent, #4c9aff);
  color: #fff;
}
.fp-btn--primary:hover:not(:disabled) { filter: brightness(1.08); }
.fp-btn:focus-visible, .fp-crumb__seg:focus-visible, .fp-aside__item:focus-visible {
  outline: 2px solid var(--color-accent, #4c9aff);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .fp-card { animation: none; }
  .fp-fade-enter-active, .fp-fade-leave-active { transition: none; }
  .fp-btn, .fp-crumb__seg, .fp-aside__item, .fp-entry { transition: none; }
}
</style>
