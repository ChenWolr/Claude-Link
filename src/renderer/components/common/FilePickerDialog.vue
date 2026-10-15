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
import type { FsDirEntry, FsDriveInfo, FsListError, FsListResult, FsMkdirResult, FsQuickLocation, FsRenameResult, FsStatResult, FsTrashResult } from '@shared/types/fs-picker';
import { describeInvalidFsItemName } from '@shared/fs-name-rules';
import { ESC_LAYER_PRIORITY, pushEscLayer, type EscLayerHandle } from '../../composables/use-esc-stack';
import { baseName, joinPath, normalizeAddressInput, parentDir, samePath } from '../../composables/fs-path-utils';
import { useDialogShell } from '../../composables/use-dialog-shell';
import { useFsPickerStore } from '../../stores/fs-picker-store';
import DialogResizeHandles from './DialogResizeHandles.vue';

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

// ── 重命名状态（行内编辑，模式复用 mkdir：Enter 提交 / Esc 或失焦取消 / busy 失焦不取消）──
const renaming = ref<string | null>(null);          // 正在编辑的条目名（null=不在编辑）
const renameInput = ref('');
const renameError = ref('');
let renameBusy = false;                             // 提交在途时失焦不取消
const renameInputRef = ref<HTMLInputElement | null>(null);

// ── 删除状态（inline 确认条：不弹嵌套模态，Esc 层级=确认条 → 弹窗）──
const deletePending = ref<string[] | null>(null);   // 待确认删除的条目名列表
const deleteError = ref('');
const deleteBusy = ref(false);                      // 提交在途时 Esc/取消/重入均守卫（ref 化：确认条按钮禁用/文案需要模板响应）
const delConfirmBtn = ref<HTMLButtonElement | null>(null);

// ── 右键菜单状态（P5：行/空白两形态，name=null 空白菜单；fixed 定位随开随关） ──
const ctxMenu = ref<{ x: number; y: number; name: string | null } | null>(null);

// ── DOM ref ──
const cardRef = ref<HTMLDivElement | null>(null);
const mkdirInput = ref<HTMLInputElement | null>(null);
const filenameInput = ref<HTMLInputElement | null>(null);
const overwriteBackBtn = ref<HTMLButtonElement | null>(null);
const addrInputRef = ref<HTMLInputElement | null>(null);
// 路径小工具（joinPath/parentDir/baseName/samePath）已迁出至 composables/fs-path-utils.ts 单源维护（P3）。

// ── 弹窗壳（P5：标题栏拖动 / 8 向缩放 / 双击复位居中；关闭按钮在 button 忽略规则内自动豁免拖动） ──
// 队列换单时 visible 连续 true → shell 不重置 rect（同一弹窗实体保留用户调好的几何，计划 P5 边界值语义）。
const shell = useDialogShell(computed(() => !!req.value), cardRef, {
  minW: 560,
  minH: 360,
  initialSize: { width: 720, height: 480 },
});
const shellStyle = shell.style; // 顶层 ref 模板自动解包（P4 使用方规范）

// ── 地址栏（P3：面包屑 ⇄ 路径输入切换；Enter 导航 / Esc 或失焦切回面包屑；Ctrl+L 进入） ──
const addrEditing = ref(false);
const addrInput = ref('');
const addrError = ref('');
function startAddrEdit(): void {
  addrEditing.value = true;
  addrInput.value = curDir.value;
  addrError.value = '';
  void nextTick(() => {
    addrInputRef.value?.focus();
    addrInputRef.value?.select();
  });
}
function cancelAddr(): void {
  addrEditing.value = false;                // 失焦/Esc 只切回面包屑展示，不提交不导航（防误触）
  addrError.value = '';
}
function submitAddr(): void {
  const norm = normalizeAddressInput(addrInput.value);
  if (norm === null) {
    addrError.value = '请输入绝对路径（如 D:\\work 或 \\\\server\\share）';
    return;
  }
  addrEditing.value = false;
  addrError.value = '';
  void loadDir(norm);                       // 路径不存在时走列表区既有错误视图（无法访问该文件夹）
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
  renaming.value = null;                    // 导航离开即取消编辑（行内输入随列表卸载，blur 幂等）
  renameError.value = '';
  deletePending.value = null;               // 导航语义变化即取消删除确认条与错误条
  deleteError.value = '';                   // confirmDelete 的部分失败提示在其 loadDir 调用之后置值，不受本清理影响
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
  const invalid = describeInvalidFsItemName(name);
  if (invalid) {
    saveError.value = invalid;              // 文案单源：@shared/fs-name-rules（与旧内联文案逐字一致）
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

// ── 重命名（行内编辑：Enter 提交 / Esc 或失焦取消；与 mkdir 编辑互斥；入口 F2 / 工具栏钮） ──
// 输入框 ref 用函数式绑定：v-for 作用域内的字符串 ref 会被编译器加 ref_for 标记、
// 运行时按数组填充（runtime-core setRef rawRef.f 分支），字符串 ref + .focus() 静默失效。
function setRenameInputRef(el: unknown): void {
  renameInputRef.value = el instanceof HTMLInputElement ? el : null;
}
function startRename(name: string): void {
  if (creating.value) cancelMkdir();        // 两编辑器互斥（重命名开启即收起新建行）
  renaming.value = name;
  renameInput.value = name;
  renameError.value = '';
  void nextTick(() => {
    renameInputRef.value?.focus();
    renameInputRef.value?.select();         // 原生 Windows 行为：进入编辑即全选名称
  });
}
function cancelRename(): void {
  if (renameBusy) return;
  renaming.value = null;
  renameInput.value = '';
  renameError.value = '';
}
function onRenameBlur(): void {
  if (renaming.value && !renameBusy) cancelRename();
}
async function submitRename(): Promise<void> {
  if (!renaming.value || renameBusy) return;
  const oldName = renaming.value;
  const name = renameInput.value.trim();
  if (!name) {
    renameError.value = '请输入名称';       // 空名由调用方提示（与 confirmSave「请输入文件名」平行），不走 IPC
    return;
  }
  const invalid = describeInvalidFsItemName(name);
  if (invalid) {
    renameError.value = invalid;            // 单源文案（与 confirmSave 同源），不发起 IPC
    return;
  }
  if (name === oldName) {
    cancelRename();                         // 未变更：直接退出编辑
    return;
  }
  const dir = curDir.value;                 // await 期间 curDir 可能被导航改写，固定取发起时目录
  const reqId = req.value?.id;              // await 期间换单守卫（同 submitMkdir）
  renameBusy = true;
  let r: FsRenameResult;
  try {
    r = await window.claudeLink.fsRename(joinPath(dir, oldName), name);
  } catch {
    renameBusy = false;
    if (req.value?.id !== reqId) return;
    renameError.value = '重命名失败，请重试';
    return;
  }
  renameBusy = false;
  if (!req.value || req.value.id !== reqId) return; // 弹窗已关或已换单——不再结算/刷新
  if (r.ok) {
    cancelRename();
    pendingSelectName.value = name;         // 刷新完成后选中新名条目
    if (mode.value === 'save-file' && filename.value === oldName) filename.value = name; // save-file 联动
    void loadDir(dir);
  } else if (r.error === 'exists') {
    renameError.value = '同名项已存在';
  } else if (r.error === 'invalid-name') {
    renameError.value = describeInvalidFsItemName(name) ?? '名称含非法字符';
  } else if (r.error === 'not-found') {
    cancelRename();
    void loadDir(dir);                      // loadDir 清理段会清 renameError，故文案在其后置
    renameError.value = '该项已不存在，列表已刷新';
  } else {
    renameError.value = '没有权限重命名';
  }
}

// ── 删除（一律移入回收站：inline 确认条确认后走 fsTrash；入口 Del / 工具栏钮）──
// 目标收集纯函数（无副作用，可被 computed 安全复用）：多选取 选中 ∩ 可选集
// （directory 模式可选集只含目录 → 文件天然不入列）；无多选回落键盘游标单项。
function deleteTargets(): string[] {
  if (overwriteView.value || loading.value || listError.value) return [];
  const selectable = selectableNames.value;
  const sel = [...selectedNames.value].filter((n) => selectable.includes(n));
  if (sel.length) return sel;
  return cursorName.value ? [cursorName.value] : [];
}
const canDelete = computed(() => deleteTargets().length > 0); // computed 化避免模板反复调用
function startDelete(targets?: string[]): void {
  const t = targets ?? deleteTargets();     // 显式目标（右键单条变体）优先，否则按选中/游标收集
  if (!t.length || deleteBusy.value) return;
  if (renaming.value) cancelRename();       // 行内编辑与确认条互斥（开启删除先收起重命名）
  deletePending.value = t;
  deleteError.value = '';
  void nextTick(() => delConfirmBtn.value?.focus());
}
function cancelDelete(): void {
  if (deleteBusy.value) return;
  deletePending.value = null;
  deleteError.value = '';
}
async function confirmDelete(): Promise<void> {
  const names = deletePending.value;
  if (!names || !names.length || deleteBusy.value) return;
  const paths = names.map((n) => joinPath(curDir.value, n));
  const dir = curDir.value;                 // await 期间 curDir 可能被导航改写，固定取发起时目录
  const reqId = req.value?.id;              // await 期间换单守卫（同 confirmSave）
  deleteBusy.value = true;
  let r: FsTrashResult;
  try {
    r = await window.claudeLink.fsTrash(paths);
  } catch {
    deleteBusy.value = false;
    if (req.value?.id !== reqId) return;
    deleteError.value = '删除失败，请重试';  // IPC 异常：确认条保留（deletePending 不清）可重试
    return;
  }
  deleteBusy.value = false;
  if (!req.value || req.value.id !== reqId) return; // 弹窗已关或已换单——不再结算/刷新
  deletePending.value = null;
  if (r.trashed.length > 0) void loadDir(dir);      // 有任何成功即刷新（部分失败只刷已删项）
  if (r.failed.length > 0) {
    deleteError.value = r.failed.length === paths.length
      ? '无法移入回收站（网络位置或权限限制）'
      : `${r.failed.length} 项未能移入回收站（网络位置或权限限制）`;
  }
}

// ── 右键上下文菜单（P5：行/空白两形态；关闭路径=外击/右击/滚轮/滚动/Esc，任一动作后亦关） ──
function openCtxMenu(evt: MouseEvent, en: FsDirEntry | null): void {
  if (en && (en.isDir || mode.value !== 'directory')) setSingle(en.name); // 右键即选中（原生语义；灰置行不选中）
  const x = Math.min(evt.clientX, window.innerWidth - 200); // 视口 clamp 不出屏（宽保守 200）
  const y = Math.min(evt.clientY, window.innerHeight - 220); // 高度按菜单项数取固定保守值
  ctxMenu.value = { x, y, name: en?.name ?? null };
  void nextTick(() => {
    (cardRef.value?.querySelector<HTMLElement>('.fp-ctx__item:not(:disabled)'))?.focus();
  });
}
function closeCtxMenu(): void {
  ctxMenu.value = null;
}
const ctxItems = computed<Array<{ label: string; disabled?: boolean; run: () => void }>>(() => {
  const name = ctxMenu.value?.name;
  if (name === null || name === undefined) {              // 空白（目录背景）菜单
    return [
      { label: '新建文件夹', run: () => { startMkdir(); closeCtxMenu(); } },
      { label: '刷新', run: () => { refreshDir(); closeCtxMenu(); } },
      { label: '在资源管理器中显示', run: () => { void window.claudeLink.fsShowInExplorer(curDir.value); closeCtxMenu(); } },
    ];
  }
  const en = entries.value.find((e) => e.name === name);
  const dead = !en || (!en.isDir && mode.value === 'directory'); // 灰置行或条目已消失（列表刷新后）
  return [
    {
      label: '进入',
      disabled: dead || !en?.isDir,
      run: () => { if (en?.isDir) void loadDir(joinPath(curDir.value, en.name)); closeCtxMenu(); },
    },
    { label: '重命名', disabled: dead, run: () => { startRename(name); closeCtxMenu(); } },
    { label: '删除', disabled: dead, run: () => { startDelete([name]); closeCtxMenu(); } },
    { label: '在资源管理器中显示', run: () => { void window.claudeLink.fsShowInExplorer(joinPath(curDir.value, name)); closeCtxMenu(); } },
  ];
});
function refreshDir(): void {
  void loadDir(curDir.value);               // 清选择刷新（原生语义）
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
    if (ctxMenu.value) {
      e.preventDefault();
      closeCtxMenu();                         // Esc 最先关右键菜单（层级=菜单>删除确认条>地址栏>弹窗）
      return;
    }
    if (deletePending.value) {
      e.preventDefault();
      cancelDelete();                         // Esc 先关删除确认条，再次 Esc 才关弹窗（层级=确认条→弹窗）
      return;
    }
    e.preventDefault();
    cancel();
    return;
  }
  if (e.key === 'Tab') {
    trapTab(e);
    return;
  }
  // Ctrl+L 进入地址栏编辑（在 isTextTarget 早退之前判定，输入框聚焦时也能再次触发重选）。
  if (e.ctrlKey && e.key.toLowerCase() === 'l') {
    if (escHandle && !escHandle.isTopmost()) return;  // 更高层遮罩在场时让位（与列表操作键同款）
    e.preventDefault();
    startAddrEdit();
    return;
  }
  if (isTextTarget(e.target)) return;       // 文件名/新建文件夹输入框内的键由输入框自身处理（Enter/Esc 已 stop）
  // 列表操作键与 Esc 同款让位：更高层遮罩在场时不操作被遮挡的弹窗。
  if (escHandle && !escHandle.isTopmost()) return;
  if (e.key === 'F2') {
    e.preventDefault();
    const name = cursorName.value;
    if (name && !overwriteView.value) startRename(name);
  } else if (e.key === 'Delete') {
    e.preventDefault();
    startDelete();
  } else if (e.key === 'F5') {
    e.preventDefault();
    refreshDir();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveCursor(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveCursor(-1);
  } else if (e.key === 'Enter') {
    // 覆盖确认视图 / 新建行 / 重命名行 / 删除确认条 / 右键菜单在场时 Enter 交给聚焦元素的原生行为（按钮激活/输入框提交）。
    if (overwriteView.value || creating.value || renaming.value || deletePending.value || ctxMenu.value) return;
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
  renaming.value = null;
  renameBusy = false;
  renameInput.value = '';
  renameError.value = '';
  deletePending.value = null;
  deleteError.value = '';
  deleteBusy.value = false;
  ctxMenu.value = null;
  saveError.value = '';
  filename.value = baseName(store.current?.req.filename ?? '');
  addrEditing.value = false;                // 地址栏编辑态随换单清理（P3）
  addrInput.value = '';
  addrError.value = '';
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
          :style="shellStyle"
          role="dialog"
          aria-modal="true"
          aria-labelledby="fp-dlg-title"
          tabindex="-1"
        >
          <!-- 头部（拖动手柄条：关闭按钮在 button 忽略规则内不触发拖动；双击复位居中） -->
          <header class="fp-header" @pointerdown="shell.beginDrag" @dblclick="shell.resetToCenter">
            <h3 id="fp-dlg-title" class="fp-header__title">{{ req.title }}</h3>
            <button type="button" class="fp-btn fp-btn--ghost fp-header__close" aria-label="关闭" @click="cancel">×</button>
          </header>

          <!-- 工具行：上级 / 新建文件夹 / 面包屑（编辑态切换为地址输入） / 路径切换钮 -->
          <div class="fp-toolbar">
            <button type="button" class="fp-btn fp-btn--ghost fp-btn--sm" :disabled="!parentPath" @click="goParent">← 上级</button>
            <button type="button" class="fp-btn fp-btn--ghost fp-btn--sm" @click="startMkdir">新建文件夹</button>
            <button
              type="button"
              class="fp-btn fp-btn--ghost fp-btn--sm"
              :disabled="!cursorName || !!overwriteView"
              title="重命名 (F2)"
              @click="cursorName && startRename(cursorName)"
            >重命名</button>
            <button
              type="button"
              class="fp-btn fp-btn--ghost fp-btn--sm"
              :disabled="!canDelete"
              title="删除 (Del)"
              @click="startDelete()"
            >删除</button>
            <button
              type="button"
              class="fp-btn fp-btn--ghost fp-btn--sm"
              :disabled="loading"
              title="刷新 (F5)"
              @click="refreshDir"
            >刷新</button>
            <nav v-if="!addrEditing" class="fp-crumb" aria-label="当前路径">
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
            <input
              v-else
              ref="addrInputRef"
              v-model="addrInput"
              class="fp-addr__input"
              type="text"
              placeholder="输入绝对路径，如 D:\work 或 \\server\share"
              aria-label="编辑路径"
              spellcheck="false"
              @keydown.enter.stop.prevent="submitAddr"
              @keydown.esc.stop.prevent="cancelAddr"
              @blur="cancelAddr"
            />
            <button
              type="button"
              class="fp-btn fp-btn--ghost fp-btn--sm"
              :title="addrEditing ? '返回面包屑' : '编辑路径 (Ctrl+L)'"
              @mousedown.prevent
              @click="addrEditing ? cancelAddr() : startAddrEdit()"
            >{{ addrEditing ? '面包屑' : '路径' }}</button>
          </div>
          <!-- 地址栏 inline 错误（仅编辑态出现；占工具行下方独立行） -->
          <div v-if="addrError" class="fp-inline-error fp-addr__error" role="alert">{{ addrError }}</div>
          <!-- 删除 inline 确认条（不弹嵌套模态；Esc 先关确认条再关弹窗）与错误行 -->
          <div v-if="deletePending" class="fp-delbar" role="alertdialog" aria-label="删除确认">
            <span class="fp-delbar__text">{{ deletePending.length === 1
              ? `将移入回收站：${deletePending[0]}` : `将把 ${deletePending.length} 项移入回收站` }}</span>
            <span class="fp-delbar__hint">可在回收站恢复</span>
            <button ref="delConfirmBtn" type="button" class="fp-btn fp-btn--primary fp-btn--sm" :disabled="deleteBusy" @click="confirmDelete">{{ deleteBusy ? '删除中…' : '移入回收站' }}</button>
            <button type="button" class="fp-btn fp-btn--ghost fp-btn--sm" :disabled="deleteBusy" @click="cancelDelete">取消</button>
          </div>
          <div v-if="deleteError" class="fp-inline-error fp-ops-error" role="alert">{{ deleteError }}</div>

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
              <!-- 降级提示：listRoots 失败（drives 空或 IPC 异常）→ 小字 + 重试（roots 为 null 即重试在途时禁用） -->
              <div v-if="store.rootsFailed" class="fp-aside__hint fp-aside__hint--retry">
                <span>未检测到其他驱动器</span>
                <button
                  type="button"
                  class="fp-btn fp-btn--ghost fp-btn--sm"
                  :disabled="store.roots === null"
                  @click="store.refreshRoots()"
                >重试</button>
              </div>
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
                <div v-if="renameError" class="fp-inline-error" role="alert">{{ renameError }}</div>

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
                    @contextmenu.prevent="openCtxMenu($event, null)"
                    @scroll="closeCtxMenu()"
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
                      @contextmenu.stop.prevent="openCtxMenu($event, en)"
                    >
                      <span v-if="renaming === en.name" class="fp-entry__rename">
                        <input
                          :ref="setRenameInputRef"
                          v-model="renameInput"
                          class="fp-mkdir__input"
                          type="text"
                          aria-label="重命名"
                          @keydown.enter.stop.prevent="submitRename"
                          @keydown.esc.stop.prevent="cancelRename"
                          @blur="onRenameBlur"
                        />
                      </span>
                      <span v-else class="fp-entry__name">
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

          <!-- 右键上下文菜单（P5 行/空白两形态）：捕层 + 菜单，均 fixed 随开随关；关闭路径=外击/右击/滚轮/滚动/Esc -->
          <template v-if="ctxMenu">
            <div class="fp-ctx-overlay" @click="closeCtxMenu" @contextmenu.prevent="closeCtxMenu" @wheel="closeCtxMenu"></div>
            <div class="fp-ctx" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }" role="menu">
              <button v-for="(it, i) in ctxItems" :key="i" type="button" role="menuitem"
                class="fp-ctx__item" :disabled="it.disabled" @click="it.run">{{ it.label }}</button>
            </div>
          </template>

          <!-- 弹窗壳 8 向缩放手柄（卡片内最后一个子元素，P5） -->
          <DialogResizeHandles :binder="shell" />
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
  position: absolute; /* shell rect 绑定后由 :style 定位；未测量帧（rect null）无 inset，静态位置回退 flex 居中 */
  /* width/height 为 shell 未测量帧回退值——rect 绑定后由 :style 覆盖 */
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

/* 头部（拖动手柄条；关闭按钮自带 cursor:pointer 不受 move 影响） */
.fp-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.7rem 0.9rem 0.5rem;
  cursor: move;
  touch-action: none;
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
.fp-addr__input {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono, ui-monospace, Consolas, monospace);
  font-size: 0.78rem;
  padding: 0.25rem 0.45rem;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--color-accent, #4c9aff);
  background: var(--color-panel, transparent);
  color: inherit;
  outline: none;
}
.fp-addr__input:focus-visible { outline: none; border-color: var(--color-accent, #4c9aff); }
.fp-addr__error { padding: 0 0.9rem 0.35rem; }

/* 删除 inline 确认条（P4：flex 行；名文案可截断；主钮用 --danger 色调示破坏性） */
.fp-delbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.9rem;
}
.fp-delbar__text {
  flex: 1;
  min-width: 0;
  font-size: 0.78rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fp-delbar__hint { flex: 0 0 auto; font-size: 0.72rem; opacity: 0.55; }
.fp-delbar .fp-btn--primary {
  background: var(--color-danger, #c05656);
  color: #fff;
}

/* 右键上下文菜单（P5）：捕层在卡片内容之上、菜单在捕层之上（均 fixed 随开随关，不与 9100 层冲突） */
.fp-ctx-overlay { position: fixed; inset: 0; z-index: 1; }
.fp-ctx {
  position: fixed;
  z-index: 2;
  min-width: 160px;
  background: var(--color-panel, #26262e);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 8px);
  box-shadow: var(--elevation-2, 0 8px 24px rgba(0, 0, 0, 0.4));
  padding: 0.25rem;
  display: flex;
  flex-direction: column;
}
.fp-ctx__item {
  text-align: left;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 0.8rem;
  padding: 0.35rem 0.6rem;
  border-radius: 6px;
  cursor: pointer;
}
.fp-ctx__item:hover:not(:disabled) { background: var(--color-accent-soft); }
.fp-ctx__item:disabled { opacity: 0.45; cursor: not-allowed; }

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
.fp-aside__hint--retry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  opacity: 1;                 /* 复用基底字号/内边距；透明度移到文字上，重试按钮保持全强度可点 */
}
.fp-aside__hint--retry > span { opacity: 0.55; }
.fp-aside__hint--retry .fp-btn { flex: 0 0 auto; }

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
.fp-entry__rename { display: flex; align-items: center; min-width: 0; } /* 行内编辑容器：flex 布局使复用的 .fp-mkdir__input（flex:1）撑满名称列 */
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
