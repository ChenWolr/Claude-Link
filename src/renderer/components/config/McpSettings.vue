<script setup lang="ts">
// McpSettings.vue — 设置页 MCP tab 内容（计划 §2 P7：p7a UI 骨架 + p7b 弹窗/CRUD/导入/探活接线）。
// 视觉基准：卡片列表区自 2026-10-17 点 C2 起以 docs/prototypes/mcp-tab/round4-slim-c.html
//（风格 C「分组面板」：按传输分组+组头计数+左侧状态色条+实底小方标+自绘深色气泡 tooltip）
// 为唯一基准；左栏 rail 与弹窗 chrome 沿用 round3-g13-hybrid.html（G13 融合稿）。
// px→rem（16 基准）、色值一律 variables.css token（项目紫沿用 ConfigPage skill-md 先例的字面
// #7C5CFC/#5F3DC4，不新增全局 token）、类名统一 mcp- 前缀防冲突、假数据换真实数据流。
// 数据流：管理库 = config store 只读投影 + saveMcpManaged 落盘后 getConfig() 回读刷新（本组件
// 仅回写 mcp 两键镜像（权威值来自专用通道回包/getConfig 回读），不触发自动保存链——
// PERSISTED_FIELDS 不含 mcpServers/mcpOverrides，自动保存链零交集）；
// 用户级/项目级 = getMcpSnapshot()（主进程磁盘直读、env/headers 已脱敏为 key 列表，卡片不展示）。
// 作用域键构造与主进程 §1.1 一致：managed:<name> / user:<name> / project:<normalizeDirKey(dir)>:<name>。
// §1.3 脱敏编辑往返（r3 修复 F2 主进程闭环）：config:get 出口的 env/headers 值已由主进程
// getConfigForRenderer 掩码为哨兵 MASK_SENTINEL（8×U+25CF）；编辑弹窗回显哨兵，提交时哨兵值
// 照传（键改名附 envRenameFrom/headersRenameFrom 瞬态 hint），由主进程 mcp:managedSave 的
// restoreMaskedMcpServers 按已存条目还原——渲染层全程零明文，哨兵绝不落配置。
// P8 双向写入（2026-10-17）：保存位置三作用域全部可真正写入——user/project 走 mcp:writeScoped
// （主进程 mcp-writer.ts：~/.claude.json / <dir>/.mcp.json 整树保留写 + 哨兵按原文件还原 +
// tmp+rename 原子写 + mtime 冲突重试）；保存前 snapshot 预查同名 → requestConfirm 覆盖确认；
// 删除后 setMcpOverride 拨回启用。user/project 编辑回显：env/headers 行 = snapshot 键列表 +
// 哨兵值 + sentinelfor（E0-6，渲染层零明文）；描述字段仅管理库有（ScopedMcpEntry 无此键，E0-1）；
// 「测试连接」探活仍仅管理库（探活器只认管理库明文条目）。
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { useConfigStore } from '../../stores/config-store';
import { useInteractionStore } from '../../stores/interaction-store';
import { ESC_LAYER_PRIORITY, pushEscLayer, type EscLayerHandle } from '../../composables/use-esc-stack';
import { useDialogShell } from '../../composables/use-dialog-shell';
import DialogResizeHandles from '../common/DialogResizeHandles.vue';
import { normalizeDirKey } from '../../../shared/project-skills';
import type { McpManagedServer } from '../../../shared/types/config';
// preload 视图类型（type-only，env.d.ts 同源先例；字段形状以 src/preload/api.ts 为准）。
// McpManagedSaveEntry = managedSave 提交形态（McpManagedServer + 瞬态改名 hint，仅提交方向）。
// McpWriteScopedPayload = writeScoped 提交载荷（P8：user/project 作用域 upsert/remove）。
import type { McpExportScopedPayload, McpManagedSaveEntry, McpProbeReport, McpProjectDirView, McpSnapshot, McpScopedWriteEntry, McpWriteScopedPayload } from '../../../preload/api';

const claude = window.claudeLink;
const configStore = useConfigStore();
const interactionStore = useInteractionStore();

// ── 作用域状态 ──────────────────────────────────────────────────────────────
type ScopeId = { kind: 'managed' } | { kind: 'user' } | { kind: 'project'; path: string };
const activeScope = ref<ScopeId>({ kind: 'managed' });

// ── 数据状态 ────────────────────────────────────────────────────────────────
const snapshot = ref<McpSnapshot | null>(null);
const loading = ref(false);
const loadError = ref('');
// 启停 override 全量（键 → 'off'；键缺失 = 启用）。种子来自 config 投影，此后以
// setMcpOverride 回包为准（主进程权威，可能含并发写入）。
const overrides = ref<Record<string, 'off'>>({});
// 管理库只读投影（config:get 的 mcpServers；env/headers 值不进卡片视图模型，见 McpCard；
// saveMcpManaged 成功后经 getConfig() 回读对齐主进程 sanitize 后的权威态）。
const managedServers = ref<McpManagedServer[]>([]);

// 请求代际守卫（先例 ConfigPage.projectDirsRequestId）：快速切 tab 连续 refresh 时，
// 慢旧快照乱序返回不得覆盖新请求结果。disposed = 组件卸载守卫（p7b：探活等在途异步
// 回调到达时组件可能已卸载，直接丢弃，不写任何 ref）。
let refreshGen = 0;
let disposed = false;

async function refresh(): Promise<void> {
  const gen = ++refreshGen;
  loading.value = true;
  loadError.value = '';
  try {
    // 管理库投影自 config store（App.vue 初始化 loadConfig 后即为最新；本组件不回写）。
    managedServers.value = Array.isArray(configStore.config.mcpServers) ? configStore.config.mcpServers : [];
    overrides.value = { ...(configStore.config.mcpOverrides ?? {}) };
    const snap = await claude.getMcpSnapshot();
    if (gen !== refreshGen || disposed) return; // 已有更新请求在途/组件已卸载，丢弃旧响应
    snapshot.value = snap;
  } catch (e) {
    if (gen !== refreshGen || disposed) return;
    loadError.value = `MCP 服务器清单读取失败：${e instanceof Error ? e.message : String(e)}`;
    // R4：失败即丢弃快照（含此前成功拉到的陈旧投影）——user/project 降态为「快照不可用」
    // 占位、rail 计数归零一致，不残留旧数据假象；管理库不受影响（managedServers 已在
    // try 顶部取自 config store，成功路径零变化）。
    snapshot.value = null;
  } finally {
    if (gen === refreshGen) loading.value = false;
  }
  // 探活批量（p7b）：进 Tab 对管理库 probeMcpServers({target:'all'})；60s 新鲜度由主进程
  // 缓存负责（hasFreshCache 命中直接回缓存报告），UI 每次进 Tab 直接调即可。不阻塞清单渲染。
  void probeAllInView();
}

defineExpose({ refresh });

// ── 探活（p7b）：管理库批量 + 卡片单台「测试连接」────────────────────────────
// 报告按 key（= override 键空间 managed:<name>）映射到卡片；无报告 = 未连接。
const probeReports = ref<Record<string, McpProbeReport>>({});
const probingAll = ref(false);
const probingSingle = ref<Record<string, boolean>>({});
let probeGen = 0;

async function probeAllInView(): Promise<void> {
  if (managedServers.value.length === 0) {
    probeReports.value = {};
    return;
  }
  const gen = ++probeGen;
  probingAll.value = true;
  try {
    const reports = await claude.probeMcpServers({ target: 'all' });
    if (disposed || gen !== probeGen) return; // 卸载/刷新后代际守卫：迟到结果丢弃
    const next: Record<string, McpProbeReport> = {};
    for (const r of reports) next[r.key] = r;
    probeReports.value = next;
  } catch {
    // 探活失败降级为「未连接」全空表，不打断清单展示（§3.7：探活器异常不炸 UI）。
    if (disposed || gen !== probeGen) return;
    probeReports.value = {};
  } finally {
    if (gen === probeGen) probingAll.value = false;
  }
}

function probeReportOf(card: McpCard): McpProbeReport | null {
  return probeReports.value[card.key] ?? null;
}

function isProbing(card: McpCard): boolean {
  return probingSingle.value[card.key] === true;
}

/** 卡片连接状态三态 + 单探测 busy 态（busy 复用未连接样式、文案「测试中…」）。 */
type ConnState = 'none' | 'ok' | 'fail' | 'busy';
function connStateOf(card: McpCard): ConnState {
  if (isProbing(card)) return 'busy';
  // B-13：批量探测在飞时管理库卡片一律「测试中…」（顺带压掉陈旧旧报告的误导显示；
  // 键前缀判定天然隔离 user/project 卡）。单台 busy 优先级在前不变。
  if (probingAll.value && card.key.startsWith('managed:')) return 'busy';
  const report = probeReports.value[card.key];
  if (!report) return 'none';
  return report.status === 'ok' ? 'ok' : 'fail';
}

function connTextOf(card: McpCard): string {
  const state = connStateOf(card);
  if (state === 'busy') return '测试中…';
  if (state === 'ok') return '已连接';
  if (state === 'fail') return '连接失败';
  return '未连接';
}

function toolsTextOf(card: McpCard): string {
  const state = connStateOf(card);
  if (state === 'ok') return `${probeReports.value[card.key]?.toolCount ?? 0} 个工具`;
  if (state === 'fail') return '— 个工具'; // B-16②：fail 无工具数概念，「0 个」有误导，改中性占位
  return '— 个工具';
}

/** 卡片「测试连接」：单台现探（§1.3 零明文：只传 name，主进程按 name 定位已存条目自取明文
 *  env/headers；不走缓存），结果按报告 key 更新该卡。 */
async function handleProbe(card: McpCard): Promise<void> {
  if (isProbing(card)) return;
  probingSingle.value = { ...probingSingle.value, [card.key]: true };
  try {
    const [report] = await claude.probeMcpServers({ target: 'single', name: card.name });
    if (disposed || !report) return;
    probeReports.value = { ...probeReports.value, [report.key || card.key]: report };
  } catch (e) {
    // 单探测 IPC 自身失败也以 fail 报告呈现（⚠ 气泡可见全文），不静默。
    if (disposed) return;
    probeReports.value = {
      ...probeReports.value,
      [card.key]: { key: card.key, status: 'fail', toolCount: 0, error: e instanceof Error ? e.message : String(e), probedAt: Date.now() },
    };
  } finally {
    if (!disposed) {
      const next = { ...probingSingle.value };
      delete next[card.key];
      probingSingle.value = next;
    }
  }
}

// ── 视图模型（三作用域统一卡片；不含任何 env/headers 值材料）──────────────────
interface McpCard {
  key: string; // override 键（managed:/user:/project: 前缀）
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  display: string; // stdio = command + args 单行；remote = url
  description: string;
}

function managedCardOf(s: McpManagedServer): McpCard {
  return {
    key: `managed:${s.name}`,
    name: s.name,
    transport: s.transport,
    display: s.transport === 'stdio' ? [s.command ?? '', ...(s.args ?? [])].join(' ').trim() : s.url ?? '',
    description: s.description,
  };
}

function scopedCardOf(v: { name: string; transport: 'stdio' | 'http' | 'sse'; command?: string; args?: string[]; url?: string }, keyPrefix: string): McpCard {
  // scoped 视图无 description 字段（scanner 视图只带连接侧字段的脱敏形态）——desc 留空。
  return {
    key: `${keyPrefix}${v.name}`,
    name: v.name,
    transport: v.transport,
    display: v.transport === 'stdio' ? [v.command ?? '', ...(v.args ?? [])].join(' ').trim() : v.url ?? '',
    description: '',
  };
}

const projectDirs = computed<McpProjectDirView[]>(() => snapshot.value?.projectDirs ?? []);
const activeProjectDir = computed<McpProjectDirView | null>(() => {
  const scope = activeScope.value; // 局部快照：嵌套回调内 TS 不保 mutable ref 的 union 收窄
  if (scope.kind !== 'project') return null;
  return projectDirs.value.find((d) => d.path === scope.path) ?? null;
});

// R5：项目作用域下「已选中且已消失」的目录判定——activeScope 已钉到具体 path，但该 path
// 不在 snapshot.projectDirs（从最近工作区消失）。仅此形态为真：管理库/user 作用域与未选
// 具体目录的初始态（activeScope 非 project）恒假，消失态文案不误报；快照失败时 snapshot
// 已清且 loadError 占位分支先于空态接管（p4），不会落到本判定。判定数据源 = 快照内列表，
// 渲染层不做磁盘 stat。目录重新出现在 projectDirs 后自动翻假，恢复正常空态。
const isProjectDirGone = computed<boolean>(() => activeScope.value.kind === 'project' && activeProjectDir.value === null);

// 模板用判定（ref 解包在模板内不传非空收窄，discriminated union 判定收敛到 script 侧）。
function isDirActive(dir: McpProjectDirView): boolean {
  return activeScope.value.kind === 'project' && activeScope.value.path === dir.path;
}

const scopeCards = computed<McpCard[]>(() => {
  if (activeScope.value.kind === 'managed') return managedServers.value.map(managedCardOf);
  if (activeScope.value.kind === 'user') return (snapshot.value?.userServers ?? []).map((v) => scopedCardOf(v, 'user:'));
  return (activeProjectDir.value?.servers ?? []).map((v) => scopedCardOf(v, `project:${normalizeDirKey(activeProjectDir.value?.path ?? '')}:`));
});

function isEnabled(card: McpCard): boolean {
  return overrides.value[card.key] !== 'off';
}

/** B-8/B-6：卡片探活呈现形态——'disabled'（禁用中性「已禁用 · 未探测」，禁用条目主进程
 *  批量探测已滤除、无结论可显）/'sse'（管理库 sse 卡中性「未探测 · 会话内自动协商」，
 *  探测协议与 sse 不匹配必显失败，属误报故收敛为中性）/'probe'（正常三态）。
 *  模板连接区/⚠ 气泡/行状态色条/工具数据此收敛；优先级 禁用 > sse > 三态。判定按当前 transport，
 *  sse 卡编辑为 http 后自动恢复探测能力呈现。 */
type ConnMode = 'disabled' | 'sse' | 'probe';
function connModeOf(card: McpCard): ConnMode {
  if (!isEnabled(card)) return 'disabled';
  if (activeScope.value.kind === 'managed' && card.transport === 'sse') return 'sse';
  return 'probe';
}

// ── rail 计数（「共 N · N 启用[ · N 会话]」）────────────────────────────────
function enabledCountOf(cards: McpCard[]): number {
  return cards.filter((c) => overrides.value[c.key] !== 'off').length;
}
const managedCards = computed<McpCard[]>(() => managedServers.value.map(managedCardOf));
const userCards = computed<McpCard[]>(() => (snapshot.value?.userServers ?? []).map((v) => scopedCardOf(v, 'user:')));
function dirCardsOf(dir: McpProjectDirView): McpCard[] {
  return dir.servers.map((v) => scopedCardOf(v, `project:${normalizeDirKey(dir.path)}:`));
}
function mcpJsonPathOf(dir: McpProjectDirView): string {
  const base = dir.path.replace(/[\\/]+$/, '');
  return `${base}\\.mcp.json`;
}

// ── 当前作用域头部（标题行/meta，文案对照定稿 SCOPES）─────────────────────────
const scopeName = computed<string>(() => {
  if (activeScope.value.kind === 'managed') return 'Claude Link 管理';
  if (activeScope.value.kind === 'user') return '用户级';
  return activeProjectDir.value?.name ?? '项目目录';
});
const scopePath = computed<string>(() => {
  if (activeScope.value.kind === 'managed') return '应用配置（claude-link-config.json）';
  if (activeScope.value.kind === 'user') return '~/.claude.json';
  return activeProjectDir.value ? mcpJsonPathOf(activeProjectDir.value) : '';
});
const scopeMeta = computed<string>(() => {
  if (activeScope.value.kind === 'managed') return '对所有项目的会话可用 · 可增删改';
  if (activeScope.value.kind === 'user') return '来自用户级 Claude Code 配置 · 可编辑/启停（写入 ~/.claude.json）';
  const dir = activeProjectDir.value;
  if (!dir) return '';
  return `${dir.sessionCount} 个会话在使用 · ${dir.isDefault ? '默认工作区' : '最近工作区'} · 可编辑/启停（写入 .mcp.json）`;
});

// ── 工具栏：搜索 + 状态 chips + 统计胶囊 ────────────────────────────────────
const search = ref('');
const filter = ref<'all' | 'on' | 'off'>('all');

const visibleCards = computed<McpCard[]>(() => {
  const q = search.value.trim().toLowerCase();
  return scopeCards.value.filter((c) => {
    if (filter.value === 'on' && !isEnabled(c)) return false;
    if (filter.value === 'off' && isEnabled(c)) return false;
    if (q && !`${c.name}\n${c.description}\n${c.display}`.toLowerCase().includes(q)) return false;
    return true;
  });
});

// ── 风格 C 分组面板（round4-slim-c.html）：当前过滤后列表按传输类型分组 ──────
// stdio 一组、http+sse 一组；组头计数=组内卡片数；空组不渲染（搜索/筛选后自然消失）。
interface CardGroup {
  id: 'stdio' | 'remote';
  label: string;
  cards: McpCard[];
}
const cardGroups = computed<CardGroup[]>(() => {
  const stdio = visibleCards.value.filter((c) => c.transport === 'stdio');
  const remote = visibleCards.value.filter((c) => c.transport !== 'stdio');
  const groups: CardGroup[] = [];
  if (stdio.length > 0) groups.push({ id: 'stdio', label: '本地进程 STDIO', cards: stdio });
  if (remote.length > 0) groups.push({ id: 'remote', label: 'HTTP / SSE', cards: remote });
  return groups;
});

/** 行左侧状态色条类（风格 C：ok 绿/none 灰/busy 黄/fail 红；disabled 淡灰+降透明；
 *  sse 中性态与未连接同用灰条——对照效果图组2 webresearch 行 grp__row--none）。 */
function rowStateClass(card: McpCard): string {
  const mode = connModeOf(card);
  if (mode === 'disabled') return 'grp__row--off grp__row--disabled';
  return `grp__row--${mode === 'sse' ? 'none' : connStateOf(card)}`;
}

// ── 启停：乐观更新 + 失败回滚 + toast ───────────────────────────────────────
async function handleToggle(card: McpCard, event: Event): Promise<void> {
  const enabled = (event.target as HTMLInputElement).checked;
  const prev = overrides.value[card.key];
  // 乐观更新（键缺失=启用；'off'=禁用）。
  if (enabled) delete overrides.value[card.key];
  else overrides.value[card.key] = 'off';
  try {
    // 主进程权威全量回包（ipc MCP_OVERRIDE_SET 落盘后返回），以此为准。
    const r = await claude.setMcpOverride(card.key, enabled);
    overrides.value = { ...r.overrides };
    // 回写 store.config.mcpOverrides 镜像为权威态（防重进 Tab 以陈旧镜像播种回跳）；
    // 该键不在 PERSISTED_FIELDS，赋值不触发 ConfigPage 自动保存链。
    configStore.config.mcpOverrides = { ...r.overrides };
  } catch (e) {
    // 回滚到调用前状态。
    if (prev === undefined) delete overrides.value[card.key];
    else overrides.value[card.key] = prev;
    pushToast(`「${card.name}」启停保存失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── 轻量 toast（ProviderManager 同款组件内栈；项目无全局 message store）────────
interface ToastItem {
  key: number;
  message: string;
}
const toasts = ref<ToastItem[]>([]);
let toastSeq = 0;
function pushToast(message: string): void {
  const key = ++toastSeq;
  toasts.value.push({ key, message });
  window.setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.key !== key);
  }, 3200);
}

// ═══ 导入归一 + 哨兵还原纯函数区（p7b；与组件其余部分无闭包耦合）══════════════
// >>>>>>>>>> p7b-pure-begin（scripts/tmp-p7b-smoke.ts 据此切片做交叉比对；勿引入组件闭包状态）
const MASK_SENTINEL = '••••••••'; // §1.3：8 个 U+25CF——env/headers 值字段的编辑回显哨兵；与主进程 mcp-config.ts 的 MCP_MASK_SENTINEL 同源同字面量，两处必须同步改
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/; // §1.1/§3.2：工具名 mcp__<name>__<tool> 的约束

/** 普通对象判定（null/数组/标量均否；与主进程 mcp-config isPlainObject 同语义）。 */
function isPlainObjectLocal(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** URL 路径以 /sse 结尾判定（与主进程 mcp-config:urlPathEndsWithSse 同款：先解析取 pathname，失败回退原串后缀）。 */
function urlPathEndsWithSseLocal(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/sse');
  } catch {
    return url.endsWith('/sse');
  }
}

/**
 * env/headers 值级清洗（与主进程 mcp-config:pickStringRecord 同语义，p6 B-3 导入预览/落库
 * 键级对齐）：入参非普通对象 → undefined（调用方不设该字段，条目仍有效）；仅保留值
 * typeof === 'string' 的条目（键序保持原序；空串是合法 string，保留），清洗后为空 → undefined
 * （字段整体消失，不输出空对象）。值非 string（number/boolean/null/对象/数组）整键丢弃。
 * 载体与主进程同款 Object.create(null)——不可信键（含 __proto__）作普通自有属性保留，
 * 双副本零分歧（round-003 D5）。
 */
function pickStringRecordLocal(v: unknown): Record<string, string> | undefined {
  if (!isPlainObjectLocal(v)) return undefined;
  const out = Object.create(null) as Record<string, string>;
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return Object.keys(out).length > 0 ? out : undefined; // 清洗后空 → 字段不设（与主进程同语义）
}

/** 导入归一单条产物（与主进程 ParsedMcpEntry 同构）。 */
interface ParsedImportEntry {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * 导入条目归一——主进程 src/main/modules/mcp/mcp-config.ts:normalizeMcpEntry
 *（parseMcpServersJson 的条目级归一）规则同步的渲染层本地副本。一期渲染层不可 import
 * 主进程模块，故复制；P8 导入改走主进程统一解析时删除本副本。2026-10-16 p6 起 env/headers
 * 值级清洗已同步（pickStringRecordLocal）；载体与主进程同款 Object.create(null)——不可信键
 *（含 __proto__）作普通自有属性保留，双副本零分歧（round-003 D5）；且导入仅产本组件内
 * 预览/落库映射。规则（逐条同步）：
 *   - rawCfg 非普通对象 → null；
 *   - transport：显式 type 优先（'stdio'→stdio；'http'|'streamable-http'→http；'sse'→sse）；
 *     缺失/不可识别 → command→stdio；否则 url（pathname 以 /sse 结尾→sse 否则 http）；两无线索 → null；
 *   - 字段互斥归一：stdio 只留 command/args/env（args 非全字符串数组→丢字段；env/headers 值级
 *     清洗 pickStringRecordLocal：非普通对象或清洗后无合法 string 值→丢字段；command 空串同
 *     缺失→null）；remote 只留 url/headers（url 空串同缺失→null）。name 取 map 键。
 */
function normalizeImportEntry(name: string, rawCfg: unknown): ParsedImportEntry | null {
  if (!isPlainObjectLocal(rawCfg)) return null;
  const cfg = rawCfg;
  let transport: 'stdio' | 'http' | 'sse' | null = null;
  if (cfg.type === 'stdio') transport = 'stdio';
  else if (cfg.type === 'http' || cfg.type === 'streamable-http') transport = 'http';
  else if (cfg.type === 'sse') transport = 'sse';
  if (transport === null) {
    const command = typeof cfg.command === 'string' && cfg.command !== '' ? cfg.command : null;
    const url = typeof cfg.url === 'string' && cfg.url !== '' ? cfg.url : null;
    if (command !== null) transport = 'stdio';
    else if (url !== null) transport = urlPathEndsWithSseLocal(url) ? 'sse' : 'http';
    else return null; // 无 type 且 command/url 两无线索 → 跳过该条目
  }
  if (transport === 'stdio') {
    const command = typeof cfg.command === 'string' && cfg.command !== '' ? cfg.command : null;
    if (command === null) return null; // stdio 必填 command 缺失/空串 → 跳过该条目
    const entry: ParsedImportEntry = { name, transport, command };
    if (Array.isArray(cfg.args) && cfg.args.every((a) => typeof a === 'string')) entry.args = cfg.args;
    const env = pickStringRecordLocal(cfg.env);
    if (env !== undefined) entry.env = env;
    return entry;
  }
  const url = typeof cfg.url === 'string' && cfg.url !== '' ? cfg.url : null;
  if (url === null) return null; // http/sse 必填 url 缺失/空串 → 跳过该条目
  const entry: ParsedImportEntry = { name, transport, url };
  const headers = pickStringRecordLocal(cfg.headers);
  if (headers !== undefined) entry.headers = headers;
  return entry;
}

/** 导入预览条目：source 为归一产物（确认导入时映射 McpManagedServer），skip/skipReason 供预览标记。 */
interface ImportPreviewEntry {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  skip: boolean;
  skipReason: string;
  source: ParsedImportEntry;
}

/**
 * 导入文本分析（预览与确认导入同源调用）：三形态识别与失败语义与主进程
 * parseMcpServersJson 同构（{"mcpServers":{…}} / {"servers":{…}} / 裸 {名称:配置} map；
 * 保留键存在但值坏 → error）。条目级容错：归一不出 → 静默跳过该条。skip 规则：
 *   - 与现有管理库同名 →「与现有同名 → 将跳过」（§3.3）；
 *   - name 不匹配 §1.1 pattern →「名称非法 → 将跳过」（主进程 sanitize 会丢弃，预览如实标记，
 *     防「预览说导入、实存少一条」）。
 */
function analyzeImportText(text: string, existing: Array<{ name: string }>): { shape: string; entries: ImportPreviewEntry[] } | { error: string } {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return { error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isPlainObjectLocal(root)) {
    return { error: '导入内容根节点必须是 JSON 对象（收到数组/标量/null）' };
  }
  const record = root;
  // 裸 map 形态仅在其不含保留键 mcpServers/servers 时参与（与主进程同款判定，防
  // {"servers":{…}} 被误当裸 map、{"mcpServers":"oops"} 被误判合法空解析）。
  const hasReservedKey =
    Object.prototype.hasOwnProperty.call(record, 'mcpServers') ||
    Object.prototype.hasOwnProperty.call(record, 'servers');
  let map: Record<string, unknown> | null = null;
  let shape = '裸 {名称:配置}';
  if (isPlainObjectLocal(record.mcpServers)) {
    map = record.mcpServers;
    shape = '{"mcpServers":{…}}';
  } else if (!hasReservedKey) {
    map = record;
  } else if (isPlainObjectLocal(record.servers)) {
    map = record.servers;
    shape = '{"servers":{…}}';
  }
  if (!map) {
    return { error: '未找到有效的 MCP 服务器表（支持 {"mcpServers":{…}}、{"servers":{…}} 或裸 {名称:配置} 三种形态）' };
  }
  const existingNames = new Set(existing.map((s) => s.name));
  const entries: ImportPreviewEntry[] = [];
  for (const [name, rawCfg] of Object.entries(map)) {
    const parsed = normalizeImportEntry(name, rawCfg);
    if (!parsed) continue; // 与主进程同款条目级容错：归一不出 → 跳过该条
    if (existingNames.has(parsed.name)) {
      entries.push({ name: parsed.name, transport: parsed.transport, skip: true, skipReason: '与现有同名 → 将跳过', source: parsed });
    } else if (!NAME_PATTERN.test(parsed.name)) {
      entries.push({ name: parsed.name, transport: parsed.transport, skip: true, skipReason: '名称非法 → 将跳过', source: parsed });
    } else {
      entries.push({ name: parsed.name, transport: parsed.transport, skip: false, skipReason: '', source: parsed });
    }
  }
  return { shape, entries };
}

/** KV 行（弹窗 env/headers 编辑行）。sentinelfor = 值回显哨兵所属的已存键（键改名时主进程仍按原键还原原值）。 */
interface KvRow {
  key: string;
  value: string;
  sentinelfor?: string;
}

/** kvRowsToRecord 的提交产物：value = 提交 Record；renameFrom = 键改名映射（仅存在改名行时）。 */
interface KvSubmitRecord {
  value: Record<string, string>;
  renameFrom?: Record<string, string>;
}

/**
 * KV 行数组 → 提交 Record + 键改名映射（§1.3 主进程脱敏闭环，r3 修复 F2）：渲染层不再本地还原
 * 原值——值仍为哨兵的行【照传】（主进程 mcp:managedSave 的 restoreMaskedMcpServers 按已存条目
 * 还原）；值 === 哨兵且 row.sentinelfor 存在且 !== 当前键 → 记改名映射 { [key]: sentinelfor }
 * 供主进程定位已存原键。空键行丢弃；非哨兵新值原样；全空 → undefined（调用方省略该字段）。
 */
function kvRowsToRecord(rows: Array<{ key: string; value: string; sentinelfor?: string }>): KvSubmitRecord | undefined {
  const out: Record<string, string> = {};
  let renameFrom: Record<string, string> | undefined;
  for (const row of rows) {
    const key = row.key.trim();
    if (key === '') continue;
    if (row.value === MASK_SENTINEL) {
      if (row.sentinelfor !== undefined && row.sentinelfor !== key) {
        if (renameFrom === undefined) renameFrom = {};
        renameFrom[key] = row.sentinelfor;
      }
      out[key] = row.value; // 哨兵值本身照传（主进程还原）
      continue;
    }
    out[key] = row.value;
  }
  if (Object.keys(out).length === 0) return undefined;
  return renameFrom === undefined ? { value: out } : { value: out, renameFrom };
}
// >>>>>>>>>> p7b-pure-end

// ── 添加/编辑弹窗（G13 定稿 modal；三作用域均可保存，user/project 走 mcp:writeScoped）───────
type SaveLocation = 'managed' | 'user' | 'project';
const LOCATION_ORDER: SaveLocation[] = ['managed', 'user', 'project'];
const TRANSPORT_ORDER = ['stdio', 'http', 'sse'] as const;

function locationLabel(loc: SaveLocation): string {
  if (loc === 'managed') return 'Claude Link 管理';
  return loc === 'user' ? '用户级' : '项目级';
}

function transportLabel(t: 'stdio' | 'http' | 'sse'): string {
  return t === 'stdio' ? '本地进程 STDIO' : t.toUpperCase();
}

type DialogMode = { kind: 'add' } | { kind: 'edit'; id: string };
const showEditDialog = ref(false);
const dialogMode = ref<DialogMode | null>(null);
const isEditMode = computed<boolean>(() => dialogMode.value?.kind === 'edit');

const formLocation = ref<SaveLocation>('managed');
const formProjectDir = ref('');
const formName = ref('');
const formTransport = ref<'stdio' | 'http' | 'sse'>('stdio');
const formDescription = ref('');
const formCommand = ref('');
const formArgsText = ref(''); // 参数 textarea：每行一个 → string[]
const formUrl = ref('');
const formEnvRows = ref<KvRow[]>([]);
const formHeaderRows = ref<KvRow[]>([]);
const saving = ref(false);
// 校验 touched 门控：错误红字/红框延迟到「字段失焦过或提交尝试过」才展示，
// 弹窗刚打开的全空表单不再满屏红。formValid 判禁用仍用原值（不受门控影响）。
const touchedFields = ref<{ name: boolean; command: boolean; url: boolean }>({ name: false, command: false, url: false });
const submitAttempted = ref(false);

// 保存位置段位：三作用域全部可真正写入（P8 起）。user/project 走 mcp:writeScoped 主进程
// 写入器（哨兵按原文件还原 + 整树保留写 + 原子写）；managed 走 saveMcpManaged 既有链。
const locationHint = computed<string>(() => {
  if (formLocation.value === 'managed') return '存入应用配置库，仅 Claude Link 会话可用（经 SDK 注入，优先级最高，推荐）。';
  if (formLocation.value === 'user') return '写入 ~/.claude.json，全局 Claude Code 共享（所有项目的新会话可用，运行中会话不重载）。';
  if (formProjectDir.value !== '') return `写入 ${formProjectDir.value}\\.mcp.json，随仓库共享（仅该目录下的会话可用）。`;
  return '写入所选项目目录的 .mcp.json，随仓库共享（仅该目录下的会话可用）。';
});

function switchLocation(loc: SaveLocation): void {
  if (formLocation.value === loc) return;
  formLocation.value = loc;
  if (loc === 'project' && formProjectDir.value === '') formProjectDir.value = projectDirs.value[0]?.path ?? '';
}

// 传输类型切换：重置 command/url 的 touched（防切回旧传输类型残留显红）；
// submitAttempted 保留（提交尝试过的「点亮全部」状态不因切换传输而清除）。
function switchTransport(t: 'stdio' | 'http' | 'sse'): void {
  if (formTransport.value === t) return;
  formTransport.value = t;
  touchedFields.value.command = false;
  touchedFields.value.url = false;
}

// §3.2 校验：名称必填 + pattern +（managed 新增时）管理库内唯一——managed 重名在 UI 拦截
// （主进程 sanitize 保留第一条，放行会导致「保存成功但新条目被静默丢弃」）；user/project
// 同名不在 UI 拦截、走保存时覆盖确认（E3：重名查仅对 managed 生效）；pattern 仅拦新增
// （编辑态名称只读，外部文件 pattern 外名称须可原样保存，managed 编辑名经 sanitize 恒合法）。
const nameError = computed<string>(() => {
  const name = formName.value.trim();
  if (name === '') return '名称必填';
  if (!isEditMode.value && !NAME_PATTERN.test(name)) return '名称仅限字母、数字、-、_，长度 1–64';
  if (formLocation.value === 'managed' && !isEditMode.value && managedServers.value.some((s) => s.name === name)) return '与现有服务器重名（管理库内名称唯一）';
  return '';
});
const commandError = computed<string>(() => (formTransport.value === 'stdio' && formCommand.value.trim() === '' ? 'stdio 必填命令' : ''));
const urlError = computed<string>(() => (formTransport.value !== 'stdio' && formUrl.value.trim() === '' ? 'http/sse 必填 URL' : ''));
// P8：project 位置须选定目标项目目录（dir 缺失主进程会拒绝写入）。
const formValid = computed<boolean>(() => !nameError.value && !commandError.value && !urlError.value && (formLocation.value !== 'project' || formProjectDir.value !== ''));
// 展示态错误：touched（失焦过）或提交尝试过才透出原错误，否则为空（不渲染红）。
const nameErrorShown = computed<string>(() => (touchedFields.value.name || submitAttempted.value ? nameError.value : ''));
const commandErrorShown = computed<string>(() => (touchedFields.value.command || submitAttempted.value ? commandError.value : ''));
const urlErrorShown = computed<string>(() => (touchedFields.value.url || submitAttempted.value ? urlError.value : ''));

function emptyKvRow(): KvRow {
  return { key: '', value: '' };
}

function addKvRow(rows: KvRow[]): void {
  rows.push(emptyKvRow());
}

function removeKvRow(rows: KvRow[], index: number): void {
  rows.splice(index, 1);
}

function resetForm(): void {
  formLocation.value = 'managed';
  formProjectDir.value = projectDirs.value[0]?.path ?? '';
  formName.value = '';
  formTransport.value = 'stdio';
  formDescription.value = '';
  formCommand.value = '';
  formArgsText.value = '';
  formUrl.value = '';
  formEnvRows.value = [emptyKvRow()]; // 对照定稿：环境变量区默认一行空 KV 行
  formHeaderRows.value = [emptyKvRow()];
  touchedFields.value = { name: false, command: false, url: false };
  submitAttempted.value = false;
}

/** 表单是否含用户已填内容（全空 KV 行不算）——「关闭不丢已填内容」的保留判定。 */
function formHasContent(): boolean {
  return (
    formName.value !== '' ||
    formDescription.value !== '' ||
    formCommand.value !== '' ||
    formArgsText.value !== '' ||
    formUrl.value !== '' ||
    formEnvRows.value.some((r) => r.key !== '' || r.value !== '') ||
    formHeaderRows.value.some((r) => r.key !== '' || r.value !== '')
  );
}

function openAdd(): void {
  dialogMode.value = { kind: 'add' };
  // esc/遮罩/取消关闭均不清表单（关闭不丢已填内容）；仅在上次以保存收尾或表单为空时重置。
  if (!formHasContent()) resetForm();
  showEditDialog.value = true;
}

function openEdit(card: McpCard): void {
  touchedFields.value = { name: false, command: false, url: false }; // 编辑态预填合法值，不继承上次的 touched
  submitAttempted.value = false;
  // P8：user/project 卡按 card.key 前缀分流预填（E0-5）。§1.3 渲染层零明文：snapshot 视图
  // 只带 maskedEnvKeys/maskedHeaderKeys 键列表——env/headers 行 = 键列表 + 值列固定哨兵 +
  // sentinelfor（E0-6），提交哨兵照传，主进程 writer 从原文件还原。
  if (card.key.startsWith('user:') || card.key.startsWith('project:')) {
    const isUser = card.key.startsWith('user:');
    const view = isUser
      ? (snapshot.value?.userServers ?? []).find((s) => s.name === card.name)
      : (activeProjectDir.value?.servers ?? []).find((s) => s.name === card.name);
    if (!view) return;
    dialogMode.value = { kind: 'edit', id: card.key }; // 作用域编辑不消费 id（分流按 formLocation）
    formLocation.value = isUser ? 'user' : 'project';
    formProjectDir.value = isUser ? '' : (activeProjectDir.value?.path ?? '');
    formName.value = view.name; // 编辑态 name 只读（三作用域统一）
    formTransport.value = view.transport;
    formDescription.value = ''; // ScopedMcpEntry 无 description（E0-1），弹窗内该字段隐藏
    formCommand.value = view.command ?? '';
    formArgsText.value = (view.args ?? []).join('\n');
    formUrl.value = view.url ?? '';
    formEnvRows.value = view.maskedEnvKeys && view.maskedEnvKeys.length > 0
      ? view.maskedEnvKeys.map((k) => ({ key: k, value: MASK_SENTINEL, sentinelfor: k }))
      : [emptyKvRow()];
    formHeaderRows.value = view.maskedHeaderKeys && view.maskedHeaderKeys.length > 0
      ? view.maskedHeaderKeys.map((k) => ({ key: k, value: MASK_SENTINEL, sentinelfor: k }))
      : [emptyKvRow()];
    showEditDialog.value = true;
    return;
  }
  const stored = managedServers.value.find((s) => s.name === card.name);
  if (!stored) return;
  dialogMode.value = { kind: 'edit', id: stored.id };
  formLocation.value = 'managed';
  formProjectDir.value = '';
  formName.value = stored.name; // 编辑态 name 只读（§2 P7/P8 边界）
  formTransport.value = stored.transport;
  formDescription.value = stored.description ?? '';
  formCommand.value = stored.command ?? '';
  formArgsText.value = (stored.args ?? []).join('\n');
  formUrl.value = stored.url ?? '';
  // §1.3：值字段回显哨兵（明文不出现在 UI）；sentinelfor 记录哨兵所属已存键。
  formEnvRows.value = Object.keys(stored.env ?? {}).length > 0 ? Object.entries(stored.env ?? {}).map(([k]) => ({ key: k, value: MASK_SENTINEL, sentinelfor: k })) : [emptyKvRow()];
  formHeaderRows.value = Object.keys(stored.headers ?? {}).length > 0 ? Object.entries(stored.headers ?? {}).map(([k]) => ({ key: k, value: MASK_SENTINEL, sentinelfor: k })) : [emptyKvRow()];
  showEditDialog.value = true;
}

function closeEditDialog(): void {
  showEditDialog.value = false;
}

/** 管理库全量落盘 + getConfig 回读对齐主进程 sanitize 后权威态（回读值同步回写 mcp 两键镜像）。
 *  入参为提交形态 McpManagedSaveEntry[]（含瞬态改名 hint，仅提交方向；本地 ref 仍 McpManagedServer[]），
 *  McpManagedServer[] 调用方（删除/导入）结构兼容直传。 */
async function persistManaged(next: McpManagedSaveEntry[], successMsg: string): Promise<boolean> {
  try {
    await claude.saveMcpManaged(next);
    const fresh = await claude.getConfig();
    if (disposed) return true;
    managedServers.value = Array.isArray(fresh.mcpServers) ? fresh.mcpServers : [];
    // getConfig() 回读 = 主进程 sanitize 后权威态，一并回写 store.config mcp 两键镜像
    //（防专用通道落盘后渲染层镜像陈旧；两键不在 PERSISTED_FIELDS，不触发自动保存链）。
    configStore.config.mcpServers = Array.isArray(fresh.mcpServers) ? fresh.mcpServers : [];
    configStore.config.mcpOverrides = { ...(fresh.mcpOverrides ?? {}) };
    // B-7：主进程 managedSave 落盘已清 managed: 探活缓存，UI 侧旧结论同步失效（增/删/改/导入
    // 均经本函数收口）并自动重探取新结论；busy「测试中」态由点5 补齐；probeAllInView 自带
    // disposed/probeGen 代际守卫，与在飞批量探测并发安全（迟到结果丢弃）。
    for (const k of Object.keys(probeReports.value)) if (k.startsWith('managed:')) delete probeReports.value[k];
    void probeAllInView();
    pushToast(successMsg);
    return true;
  } catch (e) {
    if (!disposed) pushToast(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * P8：user/project 作用域保存（mcp:writeScoped 链）。组装 ScopedMcpEntry（不含 description，
 * E0-1；哨兵值 + rename hint 照传 kvRowsToRecord 产物）→ 保存前按目标作用域 snapshot 预查同名
 * → 命中 requestConfirm 覆盖确认（E0-2，UI 预查为准）→ writeMcpScoped upsert → getMcpSnapshot()
 * 刷新 + toast；失败 toast（「文件损坏，已中止写入」等主进程中文错误直显）。
 */
async function saveScopedForm(): Promise<void> {
  // 局部快照 + 断言收窄：调用方 saveForm 已保证 managed 不进本函数（ref 联合类型 TS 不保跨 await 收窄）。
  const scope = formLocation.value as 'user' | 'project';
  const entry: McpScopedWriteEntry = { name: formName.value.trim(), transport: formTransport.value };
  if (formTransport.value === 'stdio') {
    entry.command = formCommand.value.trim();
    const args = formArgsText.value.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    if (args.length > 0) entry.args = args;
    const env = kvRowsToRecord(formEnvRows.value); // 哨兵值照传（主进程 writer 按原文件还原）
    if (env) {
      entry.env = env.value;
      if (env.renameFrom) entry.envRenameFrom = env.renameFrom;
    }
  } else {
    entry.url = formUrl.value.trim();
    const headers = kvRowsToRecord(formHeaderRows.value);
    if (headers) {
      entry.headers = headers.value;
      if (headers.renameFrom) entry.headersRenameFrom = headers.renameFrom;
    }
  }
  const dir = scope === 'project' ? formProjectDir.value : undefined;
  // 覆盖确认（E0-2）：按目标作用域 snapshot 预查同名；命中 → 非危险确认（可取消）。
  const hasSameName =
    scope === 'user'
      ? (snapshot.value?.userServers ?? []).some((s) => s.name === entry.name)
      : (projectDirs.value.find((d) => d.path === dir)?.servers ?? []).some((s) => s.name === entry.name);
  if (hasSameName) {
    const ok = await interactionStore.requestConfirm({
      title: '覆盖同名服务器',
      message: `将覆盖${scope === 'user' ? '用户级（~/.claude.json）' : '项目级（.mcp.json）'}中现有同名服务器「${entry.name}」，其现有定义将被替换。`,
      confirmText: '覆盖保存',
      cancelText: '取消',
      danger: false,
    });
    if (!ok) return;
  }
  const payload: McpWriteScopedPayload = { scope, entry, mode: 'upsert' };
  if (dir !== undefined) payload.dir = dir;
  try {
    await claude.writeMcpScoped(payload);
    await refresh(); // getMcpSnapshot() 刷新（user/project 清单 + rail 计数）
    pushToast(`已保存「${entry.name}」到${scope === 'user' ? '用户级（~/.claude.json）' : '项目级（.mcp.json）'}`);
    showEditDialog.value = false;
    resetForm();
    dialogMode.value = null;
  } catch (e) {
    pushToast(`保存失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

async function saveForm(): Promise<void> {
  const mode = dialogMode.value;
  if (!mode || saving.value) return;
  if (!formValid.value) {
    submitAttempted.value = true; // 非法提交：点亮全部错误（原为静默 return）
    return;
  }
  saving.value = true;
  try {
    // P8：user/project 分流走 mcp:writeScoped 写入链；managed 维持 saveMcpManaged 既有链。
    if (formLocation.value !== 'managed') {
      await saveScopedForm();
      return;
    }
    const now = Date.now();
    const stored = mode.kind === 'edit' ? managedServers.value.find((s) => s.id === mode.id) : undefined;
    if (mode.kind === 'edit' && stored) {
      // 编辑：by id 替换；显式重建并按 transport 只赋所属侧字段（切换 transport 后异侧残留
      // 自然丢弃，与主进程 sanitize 字段互斥归一双保险）；name/createdAt/id 保持不变。
      // 提交形态 = McpManagedSaveEntry（哨兵值照传 + 键改名瞬态 hint，主进程还原）。
      const updated: McpManagedSaveEntry = {
        id: stored.id,
        name: stored.name,
        description: formDescription.value.trim(),
        transport: formTransport.value,
        createdAt: stored.createdAt,
        updatedAt: now,
      };
      if (formTransport.value === 'stdio') {
        updated.command = formCommand.value.trim();
        const args = formArgsText.value.split('\n').map((l) => l.trim()).filter((l) => l !== '');
        if (args.length > 0) updated.args = args;
        const env = kvRowsToRecord(formEnvRows.value); // 哨兵值照传（主进程按已存条目还原）
        if (env) {
          updated.env = env.value;
          if (env.renameFrom) updated.envRenameFrom = env.renameFrom;
        }
      } else {
        updated.url = formUrl.value.trim();
        const headers = kvRowsToRecord(formHeaderRows.value);
        if (headers) {
          updated.headers = headers.value;
          if (headers.renameFrom) updated.headersRenameFrom = headers.renameFrom;
        }
      }
      const next = managedServers.value.map((s) => (s.id === stored.id ? updated : s));
      if (await persistManaged(next, `已更新「${updated.name}」`)) {
        showEditDialog.value = false;
        resetForm();
        dialogMode.value = null;
      }
    } else {
      // 新增：push；id 缺失时 crypto.randomUUID()，createdAt/updatedAt 维护。
      // 新增无已存条目：明文首存直传；哨兵值照传（主进程按「无已存」丢该键）。
      const created: McpManagedSaveEntry = {
        id: crypto.randomUUID(),
        name: formName.value.trim(),
        description: formDescription.value.trim(),
        transport: formTransport.value,
        createdAt: now,
        updatedAt: now,
      };
      if (formTransport.value === 'stdio') {
        created.command = formCommand.value.trim();
        const args = formArgsText.value.split('\n').map((l) => l.trim()).filter((l) => l !== '');
        if (args.length > 0) created.args = args;
        const env = kvRowsToRecord(formEnvRows.value);
        if (env) created.env = env.value;
      } else {
        created.url = formUrl.value.trim();
        const headers = kvRowsToRecord(formHeaderRows.value);
        if (headers) created.headers = headers.value;
      }
      const next = [...managedServers.value, created];
      if (await persistManaged(next, `已添加「${created.name}」`)) {
        showEditDialog.value = false;
        resetForm();
        dialogMode.value = null;
      }
    }
  } finally {
    saving.value = false;
  }
}

/** 删除：user/project 分支（P8）→ 确认文案含目标文件路径 → writeMcpScoped remove → setMcpOverride
 *  拨回启用（E0-3）→ snapshot 刷新；managed 分支维持既有数组剔除 + saveMcpManaged 链。 */
async function handleDelete(card: McpCard): Promise<void> {
  if (card.key.startsWith('user:') || card.key.startsWith('project:')) {
    const isUser = card.key.startsWith('user:');
    const dir = activeProjectDir.value;
    // 文件路径展示：project 用绝对路径（snapshot 同源）；user 渲染层不知用户根绝对路径，
    // 以 ~/.claude.json 惯用形表示（标题行 scopePath 同口径）。
    const fileLabel = isUser ? '~/.claude.json' : dir ? mcpJsonPathOf(dir) : '.mcp.json';
    const ok = await interactionStore.requestConfirm({
      title: '删除 MCP 服务器',
      message: `确定删除服务器「${card.name}」？将从 ${fileLabel} 移除，此操作不可撤销。`,
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    const payload: McpWriteScopedPayload = {
      scope: isUser ? 'user' : 'project',
      entry: { name: card.name, transport: card.transport },
      mode: 'remove',
    };
    if (!isUser && dir) payload.dir = dir.path;
    try {
      await claude.writeMcpScoped(payload);
      // 删除后拨回 override 键（E0-3）：残留 'off' 键会让未来同名新增默认禁用；拨回即净。
      try {
        const r = await claude.setMcpOverride(card.key, true);
        overrides.value = { ...r.overrides };
        // 同 handleToggle：权威回包一并回写 store.config.mcpOverrides 镜像（不触发自动保存链）。
        configStore.config.mcpOverrides = { ...r.overrides };
      } catch {
        // 拨回失败不影响删除结果；残留 'off' 键仅影响未来同名新增的默认态，开关一次即修正。
      }
      await refresh();
      pushToast(`已删除「${card.name}」`);
    } catch (e) {
      pushToast(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }
  const ok = await interactionStore.requestConfirm({
    title: '删除 MCP 服务器',
    message: `确定删除服务器「${card.name}」？将从 Claude Link 管理库移除，此操作不可撤销（用户级/项目级配置文件不受影响）。`,
    confirmText: '删除',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;
  const next = managedServers.value.filter((s) => s.name !== card.name);
  const saved = await persistManaged(next, `已删除「${card.name}」`);
  if (!saved) return;
  // 同步清理该条 override 键：拨回启用态删除键（键已不存在时主进程 delete 为 no-op）。
  try {
    const r = await claude.setMcpOverride(`managed:${card.name}`, true);
    overrides.value = { ...r.overrides };
    // 同 handleToggle：权威回包一并回写 store.config.mcpOverrides 镜像（不触发自动保存链）。
    configStore.config.mcpOverrides = { ...r.overrides };
  } catch {
    // 拨回失败不影响删除结果；残留 'off' 键仅影响未来同名新增的默认态，开关一次即修正。
  }
}

// ── 导出 JSON（2026-10-18）：当前作用域全部定义 → {"mcpServers":{…}} 文本写系统剪贴板 ──
// 与「导入 JSON」互为逆操作（导入形态①）。明文 env/headers 与 JSON 全程不出主进程（§1.3：
// 主进程取 config store / 磁盘 raw 真值 → clipboard 写剪贴板），渲染层只拿 count 回显 toast。
// 导出含全部定义——启停是 Claude Link 专属 override、非标准字段，不参与导出。
const exporting = ref(false);

async function exportScopeJson(): Promise<void> {
  if (exporting.value || scopeCards.value.length === 0) return;
  exporting.value = true;
  try {
    const payload: McpExportScopedPayload =
      activeScope.value.kind === 'project'
        ? { scope: 'project', dir: activeScope.value.path }
        : { scope: activeScope.value.kind };
    const r = await claude.exportMcpScoped(payload);
    if (r.count === 0) {
      // 防御性兜底：渲染层按 scopeCards 禁用按钮，正常不可达（如导出瞬间全部被删）。
      pushToast('当前作用域暂无可导出的服务器');
      return;
    }
    pushToast(`已复制 ${r.count} 台服务器配置 JSON（mcpServers 形态）到剪贴板`);
  } catch (e) {
    pushToast(`导出失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    exporting.value = false;
  }
}

// ── 导入 JSON 弹窗（§3.3：解析预览 + 同名跳过标记；确认与预览同源解析）─────────
const showImportDialog = ref(false);
const importText = ref('');
const importPreview = ref<ReturnType<typeof analyzeImportText> | null>(null);
const importing = ref(false);
// p3-R3 逐条勾选：name → 是否勾选（预览条目键唯一：JSON map 键不重复）。skip 行也置 true
// （UI disabled 不可交互，计数恒排除）；生命周期与预览同源——每次解析成功（含重开弹窗的
// 重新对齐）重置为默认全选，导入成功清空；取消关闭保留（与「关闭不丢内容」同拍）。
const importChecked = ref<Record<string, boolean>>({});

function openImport(): void {
  showImportDialog.value = true;
  // 关闭不丢内容：重开时若文本已在（上次未完成导入），预览与文本重新对齐。
  if (importText.value.trim() !== '') parseImportPreview();
  else {
    importPreview.value = null;
    importChecked.value = {};
  }
}

function closeImportDialog(): void {
  showImportDialog.value = false;
}

function parseImportPreview(): void {
  const result = analyzeImportText(importText.value, managedServers.value);
  importPreview.value = result;
  // p3-R3：每次（重新）解析 → 勾选重置为默认全选（解析失败无条目可勾，保持现状不动）。
  if (!('error' in result)) {
    const next: Record<string, boolean> = {};
    for (const e of result.entries) next[e.name] = true;
    importChecked.value = next;
  }
}

/** 当前勾选且非 skip 的数量——预览「将导入」计数与导入按钮文案/禁用都以它为准。 */
const selectedImportableCount = computed<number>(() => {
  const p = importPreview.value;
  if (!p || 'error' in p) return 0;
  return p.entries.filter((e) => !e.skip && importChecked.value[e.name] === true).length;
});

async function confirmImport(): Promise<void> {
  if (importing.value || selectedImportableCount.value === 0) return;
  importing.value = true;
  try {
    // 与预览同源解析：预览后文本可能又被改动，以确认瞬间解析为准（§3.3 同名跳过同源）。
    const fresh = analyzeImportText(importText.value, managedServers.value);
    if ('error' in fresh) {
      importPreview.value = fresh;
      pushToast(`导入失败：${fresh.error}`);
      return;
    }
    const now = Date.now();
    // p3-R3：只导入「勾选且非 skip」的条目。勾选集按 name 对齐 fresh；预览后改文本未重新
    // 解析的病态路径下，勾选集里没有的新条目视为未勾选不导入（宁可少导不误导）。
    const created: McpManagedServer[] = fresh.entries
      .filter((e) => !e.skip && importChecked.value[e.name] === true)
      .map((e) => {
        const parsed = e.source;
        const item: McpManagedServer = { id: crypto.randomUUID(), name: parsed.name, description: '', transport: parsed.transport, createdAt: now, updatedAt: now };
        if (parsed.transport === 'stdio') {
          item.command = parsed.command ?? '';
          if (parsed.args && parsed.args.length > 0) item.args = parsed.args;
          if (parsed.env && Object.keys(parsed.env).length > 0) item.env = parsed.env;
        } else {
          item.url = parsed.url ?? '';
          if (parsed.headers && Object.keys(parsed.headers).length > 0) item.headers = parsed.headers;
        }
        return item;
      });
    if (created.length === 0) {
      pushToast('没有可导入的服务器（全部被跳过）');
      return;
    }
    const next = [...managedServers.value, ...created];
    const skipped = fresh.entries.length - created.length;
    const saved = await persistManaged(next, `已导入 ${created.length} 台${skipped > 0 ? `（未导入 ${skipped} 台：同名/名称非法或未勾选）` : ''}`);
    if (saved) {
      showImportDialog.value = false;
      importText.value = ''; // 导入已完成消费，文本与预览清空
      importPreview.value = null;
      importChecked.value = {}; // p3-R3：勾选状态一并清空
    }
  } finally {
    importing.value = false;
  }
}

// ── 弹窗壳（计划 2026-10-14 §2 P8）：两弹窗各自独立 useDialogShell——标题栏拖动 / 8 向缩放 /
// 视口重钳 / 双击复位居中；无 initialSize（打开时测卡片自然尺寸，rect null 帧回退 CSS 静态居中）。
// 两实例 rect 各自独立：交替开关互不污染；纯壳层接线，编辑/导入业务逻辑零触碰。
const editCardRef = ref<HTMLElement | null>(null);
const editShell = useDialogShell(showEditDialog, editCardRef, { minW: 480, minH: 360 });
const editShellStyle = editShell.style; // ComputedRef 须解包为 script 顶层（P4 使用方规范）
const importCardRef = ref<HTMLElement | null>(null);
const importShell = useDialogShell(showImportDialog, importCardRef, { minW: 480, minH: 360 });
const importShellStyle = importShell.style;

// ── 弹窗 Esc（关闭不丢已填内容；关闭为内容保留型操作，与交互弹窗同拍的边缘互不损坏数据）─
// r3-F7/R6：接入 use-esc-stack 全局层级裁决——弹窗在场注册 mcpDialog 层（Esc 层级 1199，低于
// 交互层 1200：与待决交互弹窗并存时 Esc 只关交互层；.mcp-mask CSS z-index 仍为 1200，
// Esc 裁决层级与 CSS z-index 解耦），
// 更高层（diff/灯箱等）在场时 isTopmost 为假、本组件让位，一次 Esc 只关视觉最上层；关闭/卸载释放。
let escBound = false;
let escLayer: EscLayerHandle | null = null;
function onGlobalKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (escLayer && !escLayer.isTopmost()) return;
  if (showImportDialog.value) {
    closeImportDialog();
    return;
  }
  if (showEditDialog.value) closeEditDialog();
}

watch([showEditDialog, showImportDialog], ([edit, imp]) => {
  const any = edit || imp;
  if (any && !escBound) {
    window.addEventListener('keydown', onGlobalKey);
    escBound = true;
  } else if (!any && escBound) {
    window.removeEventListener('keydown', onGlobalKey);
    escBound = false;
  }
  // 层注册与监听绑定同步：任一弹窗在场即注册（去重防重复 push），全部关闭即释放（release 幂等）。
  if (any && !escLayer) escLayer = pushEscLayer(ESC_LAYER_PRIORITY.mcpDialog);
  else if (!any && escLayer) {
    escLayer.release();
    escLayer = null;
  }
});

onBeforeUnmount(() => {
  disposed = true; // 探活/保存在途回调的卸载守卫（探活中切走页面不炸）
  if (escBound) {
    window.removeEventListener('keydown', onGlobalKey);
    escBound = false;
  }
  escLayer?.release();
  escLayer = null;
});

// ── 底部 note（每作用域首段对照定稿 + 三条公共说明：①生效粒度——启停仅新会话、定义增删改
//    下一条消息即时（p6 B-14 修订）②严格模式接管条件与副作用（B-2 门控：Claude Link 侧有
//    服务器或启停设置才接管，两侧全空按 Claude Code 原生行为加载）③库位与编辑口径（user/project 可直接编辑）；
//    管理段补「删除前会弹确认框」句，r3 B-M4 对照定稿逐字）─
const scopeNoteHead = computed<string>(() => {
  if (activeScope.value.kind === 'managed') {
    return '此作用域的服务器由 Claude Link 经 SDK 注入（优先级高于 ~/.claude.json 与 .mcp.json），仅 Claude Link 会话可见。删除前会弹确认框。';
  }
  if (activeScope.value.kind === 'user') {
    return '此作用域为 Claude Code 用户级配置（~/.claude.json，全局共享）。Claude Link 可直接编辑该文件（写入整树保留原字段，新会话生效）；启停仅在 Claude Link 会话内生效，终端裸跑 claude 仍按原配置加载。';
  }
  return '此作用域为项目根 .mcp.json（团队成员共享、随仓库提交，提交由用户自行操作）。Claude Link 可直接编辑该文件；仅在该项目目录下创建的会话才会加载。';
});
</script>

<template>
  <div class="mcp-md-body" data-testid="mcp-manage-section">
    <!-- 左栏：作用域清单（对照定稿 rail：管理/用户级 + 项目目录段） -->
    <nav class="mcp-rail" aria-label="MCP 作用域">
      <div class="mcp-rail__head"><span>作用域</span><span>3 类</span></div>

      <button
        type="button"
        :class="['mcp-rail-item', { 'mcp-rail-item--active': activeScope.kind === 'managed' }]"
        :aria-current="activeScope.kind === 'managed' ? 'true' : 'false'"
        @click="activeScope = { kind: 'managed' }"
      >
        <span class="mcp-rail-item__top">
          <span class="mcp-rail-item__dot"></span>
          <span class="mcp-rail-item__name">Claude Link 管理</span>
        </span>
        <span class="mcp-rail-item__path">应用配置（可增删改）</span>
        <!-- B-18：管理库计数来自 config store 恒在，无条件直显（loading 期不给占位假计数）。 -->
        <span class="mcp-rail-item__meta">共 {{ managedCards.length }} · {{ enabledCountOf(managedCards) }} 启用</span>
      </button>

      <button
        type="button"
        :class="['mcp-rail-item', { 'mcp-rail-item--active': activeScope.kind === 'user' }]"
        :aria-current="activeScope.kind === 'user' ? 'true' : 'false'"
        @click="activeScope = { kind: 'user' }"
      >
        <span class="mcp-rail-item__top">
          <span class="mcp-rail-item__dot mcp-rail-item__dot--user"></span>
          <span class="mcp-rail-item__name">用户级</span>
        </span>
        <span class="mcp-rail-item__path">~/.claude.json</span>
        <span class="mcp-rail-item__meta">
          <!-- B-18：占位仅首拍（与列表加载态同口径 loading && !snapshot），快照在握后直显真值。 -->
          <template v-if="loading && !snapshot">共 … · … 启用</template>
          <template v-else>共 {{ userCards.length }} · {{ enabledCountOf(userCards) }} 启用</template>
        </span>
      </button>

      <div class="mcp-rail__head"><span>项目目录 · 来自最近工作区</span><span>{{ projectDirs.length }} 个</span></div>

      <button
        v-for="dir in projectDirs"
        :key="dir.path"
        type="button"
        :class="['mcp-rail-item', 'mcp-rail-item--project', { 'mcp-rail-item--active': isDirActive(dir), 'mcp-rail-item--active-project': isDirActive(dir) }]"
        :aria-current="isDirActive(dir) ? 'true' : 'false'"
        :title="dir.path"
        @click="activeScope = { kind: 'project', path: dir.path }"
      >
        <span class="mcp-rail-item__top">
          <span class="mcp-rail-item__dot mcp-rail-item__dot--project"></span>
          <span class="mcp-rail-item__name">{{ dir.name }}</span>
          <span v-if="dir.isDefault" class="mcp-rail-item__tag">默认</span>
        </span>
        <span class="mcp-rail-item__path">{{ mcpJsonPathOf(dir) }}</span>
        <span class="mcp-rail-item__meta">
          <!-- B-18：占位仅首拍（与列表加载态同口径 loading && !snapshot）。 -->
          <template v-if="loading && !snapshot">共 … · … 启用 · {{ dir.sessionCount }} 会话</template>
          <template v-else>共 {{ dirCardsOf(dir).length }} · {{ enabledCountOf(dirCardsOf(dir)) }} 启用 · {{ dir.sessionCount }} 会话</template>
        </span>
      </button>

      <div class="mcp-rail__foot">用户级与项目级服务器来自 Claude Code 配置文件，可在此直接编辑（写入对应配置文件，新会话生效）；「Claude Link 管理」存应用配置库、仅经 SDK 注入。</div>
    </nav>

    <!-- 右侧主区（对照定稿 main：标题行+按钮 → meta → 工具栏 → 滚动卡片列 → note） -->
    <section class="mcp-main">
      <div class="mcp-main__head">
        <div class="mcp-title-row">
          <span :class="['mcp-title-row__dot', { 'mcp-title-row__dot--user': activeScope.kind === 'user', 'mcp-title-row__dot--project': activeScope.kind === 'project' }]"></span>
          <span class="mcp-title-row__name">{{ scopeName }}</span>
          <span class="mcp-title-row__path">{{ scopePath }}</span>
          <!-- 风格 C 契约2：原底部大段说明整段删除，由标题行尾部 ⓘ 承接（自绘深色气泡，
               hover 与 :focus-within 双触发、按钮可 Tab 聚焦，键盘可达；对照 round4-slim-c.html）。
               tip--head 变体：Ⓘ 位于标题行右侧（acts 按钮旁），left:0 向右展开会超出窗口右缘
               截断（2026-10-18 实测截图回归）——气泡锚定改为标题行右缘、向左展开（见 CSS）。 -->
          <span class="tip tip--head">
            <button type="button" class="mcp-info-btn" aria-label="作用域说明">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            </button>
            <span class="bubble" role="tooltip">
              <b>{{ scopeNoteHead }}</b>
              <span>启停开关仅对新会话生效（进行中会话保持创建时的启停快照）；服务器定义的增删改对所有会话的下一条消息即时生效。</span>
              <span>Claude Link 侧有 MCP 服务器或启停设置时，以严格模式接管会话 MCP 集合，claude.ai 云端 connectors 与插件 MCP 不再自动加载（禁用真正生效的必要代价）；两侧全空时按 Claude Code 原生行为加载全部 MCP 来源（含 .mcp.json、用户配置、插件与云端 connectors）。</span>
            </span>
          </span>
          <span class="mcp-title-row__acts">
            <!-- 导出 JSON：与「导入 JSON」互逆（作用域全部定义 → mcpServers 形态文本进剪贴板；
                 空作用域禁用；明文不出主进程，见 exportScopeJson）。 -->
            <button
              class="mcp-btn"
              type="button"
              :disabled="exporting || scopeCards.length === 0"
              :title="scopeCards.length === 0 ? '当前作用域暂无服务器可导出' : '把当前作用域全部服务器定义复制为 mcpServers 形态 JSON 文本'"
              @click="exportScopeJson"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              {{ exporting ? '导出中…' : '导出 JSON' }}
            </button>
            <button class="mcp-btn" type="button" @click="openImport">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              导入 JSON
            </button>
            <button class="mcp-btn mcp-btn--primary" type="button" @click="openAdd">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              添加服务器
            </button>
          </span>
        </div>
        <p class="mcp-title-meta">{{ scopeMeta }}</p>
        <!-- 用户级磁盘直读失败提示（快照 userScopeError；非阻断降态）。 -->
        <div v-if="snapshot?.userScopeError" class="mcp-snap-warn" role="status">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path></svg>
          <span>用户级（~/.claude.json）读取失败：{{ snapshot.userScopeError }}</span>
        </div>
        <!-- R4：快照整体拉取失败提示条（非阻断降态，重试入口在此）。列表区不再整体替换为
             错误态：管理库照常由 config store 投影渲染，user/project 降态为「快照不可用」占位。 -->
        <div v-if="loadError" class="mcp-snap-warn" role="status">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path></svg>
          <span>{{ loadError }}</span>
          <button type="button" class="mcp-empty__retry" @click="refresh()">重试</button>
        </div>

        <div class="mcp-toolbar">
          <input
            v-model="search"
            class="mcp-search"
            type="search"
            placeholder="搜索名称 / 描述 / 命令…"
            aria-label="搜索 MCP 服务器"
          />
          <div class="mcp-chips" role="group" aria-label="状态过滤">
            <button type="button" :class="['mcp-chip', { 'mcp-chip--active': filter === 'all' }]" @click="filter = 'all'">全部</button>
            <button type="button" :class="['mcp-chip', { 'mcp-chip--active': filter === 'on' }]" @click="filter = 'on'">已启用</button>
            <button type="button" :class="['mcp-chip', { 'mcp-chip--active': filter === 'off' }]" @click="filter = 'off'">已禁用</button>
          </div>
          <!-- 风格 C 契约3：统计胶囊（N 台/N 启用/N 禁用）移除——左栏 rail 已有同数据；
               仅保留功能性「批量测试中…」在飞指示（B-13）。 -->
          <div v-if="probingAll" class="mcp-statpills" aria-label="统计">
            <span class="mcp-statpill" role="status">批量测试中…</span>
          </div>
        </div>
      </div>

      <div class="mcp-main__scroll">
        <!-- 加载中态（首拍）；代际守卫保证不闪旧数据。 -->
        <div v-if="loading && !snapshot" class="mcp-empty">正在读取 MCP 服务器清单…</div>
        <!-- R4：快照失败不再整体替换列表区——仅 user/project（数据源在 snapshot）降态为
             轻量占位；管理库照常渲染（含管理库空态与错误条并存），重试入口在顶部提示条。 -->
        <div v-else-if="loadError && activeScope.kind !== 'managed'" class="mcp-empty">
          MCP 快照不可用，用户级/项目级清单暂无法读取<br />「Claude Link 管理」不受影响，可点顶部「重试」重新拉取
        </div>
        <template v-else>
          <!-- 风格 C 分组面板（round4-slim-c.html）：按传输类型分组（组头计数+组内发丝行），
               卡片=左状态色条行；行1 徽标+操作+开关 / 行2 命令行 / 行3 描述+连接状态+工具数
               （原 errbar 整行删除，fail 态改为行3 状态文案旁 ⚠ 图标 + 自绘深色气泡看全文） -->
          <div class="mcp-groups">
            <section v-for="grp in cardGroups" :key="grp.id" class="grp" :aria-label="grp.label">
              <div class="grp__head">{{ grp.label }}<span class="cnt">{{ grp.cards.length }} 台</span></div>
              <div v-for="card in grp.cards" :key="card.key" :class="['grp__row', rowStateClass(card)]">
                <div class="row__r1">
                  <span class="row__name">{{ card.name }}</span>
                  <span :class="['mcp-tchip', { 'mcp-tchip--http': card.transport === 'http', 'mcp-tchip--sse': card.transport === 'sse' }]">{{ card.transport.toUpperCase() }}</span>
                  <span :class="['mcp-scope-badge', { 'mcp-scope-badge--user': activeScope.kind === 'user', 'mcp-scope-badge--project': activeScope.kind === 'project' }]">{{ activeScope.kind === 'managed' ? 'Link 管理' : activeScope.kind === 'user' ? '全局' : '项目' }}</span>
                  <span v-if="!isEnabled(card)" class="mcp-off-badge">已禁用</span>
                  <span class="spacer"></span>
                  <!-- 管理库作用域：测试连接/编辑/删除（p7b 接线）。D7：禁用卡「测试连接」按钮
                       置灰——single 探测虽不滤禁用，但 B-8 中性态不渲染结论，允许点击无反馈属
                       交互矛盾，故置灰。 -->
                  <template v-if="activeScope.kind === 'managed'">
                    <button
                      class="mcp-iconbtn"
                      type="button"
                      :disabled="isProbing(card) || card.transport === 'sse' || !isEnabled(card)"
                      :aria-label="`测试连接 ${card.name}`"
                      :title="!isEnabled(card) ? '已禁用 · 启用后可测试连接' : card.transport === 'sse' ? 'SSE 传输暂不支持探测，会话内自动协商' : isProbing(card) ? '探测中…' : `测试连接 ${card.name}`"
                      @click="handleProbe(card)"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                    </button>
                    <button class="mcp-iconbtn" type="button" :aria-label="`编辑 ${card.name}`" title="编辑" @click="openEdit(card)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                    </button>
                    <button class="mcp-iconbtn mcp-iconbtn--danger" type="button" :aria-label="`删除 ${card.name}`" title="删除" @click="handleDelete(card)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  </template>
                  <!-- P8：user/project 卡开放「编辑/删除」（同管理库同款按钮；写入对应配置文件）；
                       「测试连接」仍仅管理库渲染（探活器只认管理库明文条目，E0-4）。 -->
                  <template v-else>
                    <button class="mcp-iconbtn" type="button" :aria-label="`编辑 ${card.name}`" title="编辑" @click="openEdit(card)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                    </button>
                    <button class="mcp-iconbtn mcp-iconbtn--danger" type="button" :aria-label="`删除 ${card.name}`" title="删除" @click="handleDelete(card)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  </template>
                  <input
                    type="checkbox"
                    class="mcp-switch"
                    :checked="isEnabled(card)"
                    :aria-label="`${isEnabled(card) ? '禁用' : '启用'} ${card.name}`"
                    @change="handleToggle(card, $event)"
                  />
                </div>
                <div class="row__cmd">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                  <span><b>{{ card.display.split(' ')[0] }}</b>{{ card.display.slice(card.display.split(' ')[0].length) }}</span>
                </div>
                <div class="row__r3">
                  <span v-if="card.description" class="row__desc" :title="card.description">{{ card.description }}</span>
                  <!-- B-8/B-6：禁用卡/sse 卡中性态（无三态/⚠/工具数/色条按中性灰呈现），其余正常三态。 -->
                  <span v-if="connModeOf(card) === 'disabled'" class="mcp-card__conn mcp-card__conn--off">已禁用 · 未探测</span>
                  <span v-else-if="connModeOf(card) === 'sse'" class="mcp-card__conn mcp-card__conn--off">未探测 · 会话内自动协商</span>
                  <span v-else :class="['mcp-card__conn', { 'mcp-card__conn--off': connStateOf(card) === 'none' || connStateOf(card) === 'busy', 'mcp-card__conn--fail': connStateOf(card) === 'fail' }]">{{ connTextOf(card) }}</span>
                  <!-- 契约1：fail 态 ⚠（errbar 整行删除后，探活错误全文收进自绘深色气泡；
                       hover 与键盘 focus 双触发；与 errbar 同口径仅 probe 形态渲染——禁用卡/sse 卡
                       不显示（sse 旧失败报告属协议不匹配误报）。 -->
                  <span v-if="connModeOf(card) === 'probe' && connStateOf(card) === 'fail' && probeReportOf(card)?.error" class="tip">
                    <button type="button" class="warnico" aria-label="查看探活错误全文">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path></svg>
                    </button>
                    <span class="bubble" role="tooltip"><b>探活错误</b><code>{{ probeReportOf(card)?.error }}</code></span>
                  </span>
                  <span v-if="connModeOf(card) === 'probe'" class="mcp-card__tools">{{ toolsTextOf(card) }}</span>
                </div>
              </div>
            </section>
            <!-- 空态：真零（按作用域分化引导）与筛选零。 -->
            <div v-if="visibleCards.length === 0" class="mcp-empty">
              <template v-if="activeScope.kind === 'managed'">
                <template v-if="scopeCards.length === 0">还没有受管理的 MCP 服务器<br />点右上「添加服务器」添加第一台（经 SDK 注入，仅 Claude Link 会话可见）</template>
                <template v-else>当前筛选下无匹配的 MCP 服务器</template>
              </template>
              <template v-else-if="activeScope.kind === 'user'">
                <template v-if="scopeCards.length === 0">用户级（~/.claude.json）暂无 mcpServers 配置<br />终端 <code>claude mcp add -s user …</code> 写入后自动出现在这里</template>
                <template v-else>当前筛选下无匹配的 MCP 服务器</template>
              </template>
              <template v-else>
                <!-- R5：真零三态互斥——①目录在最近工作区且无 .mcp.json → 正常空态；
                     ②已选目录从最近工作区消失（isProjectDirGone）→ 消失态文案；③快照失败 →
                     上方 p4 占位分支（先于此处接管，不落到空态块）。 -->
                <template v-if="scopeCards.length === 0">
                  <template v-if="isProjectDirGone">该目录已不在最近工作区列表（可在聊天侧切换工作区后回到此处），其 .mcp.json 若仍存在仍会对指向该目录的会话生效</template>
                  <template v-else>该项目目录暂无 .mcp.json 或其中无 mcpServers<br />在项目根放置 <code>.mcp.json</code> 后自动出现在这里</template>
                </template>
                <template v-else>当前筛选下无匹配的 MCP 服务器</template>
              </template>
            </div>
          </div>
          <!-- 风格 C 契约2：底部大段说明整段删除，由标题行 ⓘ 气泡承接（对照 round4-slim-c.html） -->
        </template>
      </div>
    </section>

    <!-- 弹窗（Teleport 到 body；对照定稿 mask/modal：添加/编辑 + 导入 JSON） -->
    <Teleport to="body">
      <!-- 添加 / 编辑弹窗（G13 定稿 form-grid；一期保存位置仅管理库可写入） -->
      <div v-if="showEditDialog" class="mcp-mask" role="presentation" @click.self="closeEditDialog">
        <div ref="editCardRef" class="mcp-modal" role="dialog" aria-modal="true" aria-labelledby="mcp-edit-title" :style="editShellStyle">
          <div class="mcp-modal__head" @pointerdown="editShell.beginDrag" @dblclick="editShell.resetToCenter">
            <h3 id="mcp-edit-title" class="mcp-modal__title">{{ isEditMode ? '编辑服务器' : '添加服务器' }}</h3>
            <button class="mcp-modal__close" type="button" aria-label="关闭弹窗" @click="closeEditDialog">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="mcp-modal__body">
            <div class="mcp-form-grid">
              <div class="mcp-ffield mcp-ffield--full">
                <span class="mcp-ffield__label">保存位置</span>
                <div class="mcp-seg" role="group" aria-label="保存位置">
                  <button
                    v-for="loc in LOCATION_ORDER"
                    :key="loc"
                    type="button"
                    :class="['mcp-seg__btn', { 'mcp-seg__btn--active': formLocation === loc }]"
                    @click="switchLocation(loc)"
                  >{{ locationLabel(loc) }}</button>
                </div>
                <span class="mcp-ffield__hint">{{ locationHint }}</span>
              </div>
              <div v-if="formLocation === 'project'" class="mcp-ffield mcp-ffield--full">
                <span class="mcp-ffield__label">目标项目目录</span>
                <div class="mcp-select-wrap">
                  <select v-model="formProjectDir" class="mcp-select" aria-label="目标项目目录">
                    <option v-for="d in projectDirs" :key="d.path" :value="d.path">{{ d.path }}{{ d.isDefault ? '（默认工作区）' : '' }}</option>
                  </select>
                </div>
                <span v-if="projectDirs.length === 0" class="mcp-ffield__hint">暂无已知项目目录</span>
              </div>
              <label class="mcp-ffield">
                <span class="mcp-ffield__label">名称<span class="req-mark">*</span></span>
                <input
                  v-model="formName"
                  :class="['mcp-input', 'mcp-input--mono', { 'mcp-input--invalid': nameErrorShown !== '' }]"
                  type="text"
                  placeholder="context7"
                  :disabled="isEditMode"
                  aria-required="true"
                  @blur="touchedFields.name = true"
                />
                <span :class="['mcp-ffield__hint', { 'mcp-ffield__hint--danger': nameErrorShown !== '' }]">
                  {{ nameErrorShown !== '' ? nameErrorShown : '工具名形如 mcp__<名称>__<工具>，仅限字母、数字、-、_' }}
                </span>
              </label>
              <div class="mcp-ffield">
                <span class="mcp-ffield__label">传输类型</span>
                <div class="mcp-seg" role="group" aria-label="传输类型">
                  <button
                    v-for="t in TRANSPORT_ORDER"
                    :key="t"
                    type="button"
                    :class="['mcp-seg__btn', { 'mcp-seg__btn--active': formTransport === t }]"
                    @click="switchTransport(t)"
                  >{{ transportLabel(t) }}</button>
                </div>
              </div>
              <!-- 描述字段仅管理库有（ScopedMcpEntry 无此键，P8 E0-1：user/project 条目不落描述）。 -->
              <label v-if="formLocation === 'managed'" class="mcp-ffield mcp-ffield--full">
                <span class="mcp-ffield__label">描述</span>
                <input v-model="formDescription" class="mcp-input" type="text" placeholder="可选，便于识别用途" />
              </label>
              <template v-if="formTransport === 'stdio'">
                <label class="mcp-ffield mcp-ffield--full">
                  <span class="mcp-ffield__label">命令<span class="req-mark">*</span></span>
                  <input
                    v-model="formCommand"
                    :class="['mcp-input', 'mcp-input--mono', { 'mcp-input--invalid': commandErrorShown !== '' }]"
                    type="text"
                    placeholder="npx"
                    aria-required="true"
                    @blur="touchedFields.command = true"
                  />
                  <span v-if="commandErrorShown !== ''" class="mcp-ffield__hint mcp-ffield__hint--danger">{{ commandErrorShown }}</span>
                </label>
                <label class="mcp-ffield mcp-ffield--full">
                  <span class="mcp-ffield__label">参数</span>
                  <textarea v-model="formArgsText" class="mcp-textarea" placeholder="-y&#10;@upstash/context7-mcp"></textarea>
                  <span class="mcp-ffield__hint">每行一个参数，按顺序传入</span>
                </label>
                <div class="mcp-ffield mcp-ffield--full">
                  <span class="mcp-ffield__label">环境变量</span>
                  <div v-for="(row, i) in formEnvRows" :key="i" class="mcp-kvrow">
                    <input v-model="row.key" class="mcp-input mcp-input--mono" type="text" placeholder="API_KEY" aria-label="变量名" />
                    <input v-model="row.value" class="mcp-input mcp-input--mono" type="password" placeholder="值（保存后脱敏存储）" aria-label="变量值" autocomplete="off" />
                    <button class="mcp-kvrow__del" type="button" aria-label="删除此变量" @click="removeKvRow(formEnvRows, i)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                  <button class="mcp-kvadd" type="button" @click="addKvRow(formEnvRows)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    添加变量
                  </button>
                  <!-- 风格 C 契约4：哨兵长句压缩 + ⓘ（自绘深色气泡向上弹出）看完整规则 -->
                  <span class="mcp-ffield__hint hintrow">已存值回显为 {{ MASK_SENTINEL }}，保持不变沿用原值
                    <span class="tip tip--up">
                      <button type="button" class="mcp-info-btn" aria-label="脱敏回显规则说明">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                      </button>
                      <span class="bubble" role="tooltip"><b>脱敏回显规则</b><span>编辑时已存值回显为 {{ MASK_SENTINEL }}；保持不变则沿用已存原值，不会重复保存</span></span>
                    </span>
                  </span>
                </div>
              </template>
              <template v-else>
                <label class="mcp-ffield mcp-ffield--full">
                  <span class="mcp-ffield__label">URL<span class="req-mark">*</span></span>
                  <input
                    v-model="formUrl"
                    :class="['mcp-input', 'mcp-input--mono', { 'mcp-input--invalid': urlErrorShown !== '' }]"
                    type="text"
                    placeholder="https://example.com/mcp"
                    aria-required="true"
                    @blur="touchedFields.url = true"
                  />
                  <span v-if="urlErrorShown !== ''" class="mcp-ffield__hint mcp-ffield__hint--danger">{{ urlErrorShown }}</span>
                </label>
                <div class="mcp-ffield mcp-ffield--full">
                  <span class="mcp-ffield__label">请求头</span>
                  <div v-for="(row, i) in formHeaderRows" :key="i" class="mcp-kvrow">
                    <input v-model="row.key" class="mcp-input mcp-input--mono" type="text" placeholder="Authorization" aria-label="请求头名" />
                    <input v-model="row.value" class="mcp-input mcp-input--mono" type="password" placeholder="值（保存后脱敏存储）" aria-label="请求头值" autocomplete="off" />
                    <button class="mcp-kvrow__del" type="button" aria-label="删除此请求头" @click="removeKvRow(formHeaderRows, i)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                  <button class="mcp-kvadd" type="button" @click="addKvRow(formHeaderRows)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    添加请求头
                  </button>
                  <!-- 风格 C 契约4：哨兵长句压缩 + ⓘ（自绘深色气泡向上弹出）看完整规则 -->
                  <span class="mcp-ffield__hint hintrow">已存值回显为 {{ MASK_SENTINEL }}，保持不变沿用原值
                    <span class="tip tip--up">
                      <button type="button" class="mcp-info-btn" aria-label="脱敏回显规则说明">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                      </button>
                      <span class="bubble" role="tooltip"><b>脱敏回显规则</b><span>编辑时已存值回显为 {{ MASK_SENTINEL }}；保持不变则沿用已存原值，不会重复保存</span></span>
                    </span>
                  </span>
                </div>
              </template>
            </div>
          </div>
          <div class="mcp-modal__foot">
            <button class="mcp-btn" type="button" @click="closeEditDialog">取消</button>
            <button class="mcp-btn mcp-btn--primary" type="button" :disabled="!formValid || saving" @click="saveForm">{{ saving ? '保存中…' : '保存并启用' }}</button>
          </div>
          <DialogResizeHandles :binder="editShell" />
        </div>
      </div>

      <!-- 导入 JSON 弹窗（textarea + 解析预览 + 同名跳过标记；导入目标=Claude Link 管理） -->
      <div v-if="showImportDialog" class="mcp-mask" role="presentation" @click.self="closeImportDialog">
        <div ref="importCardRef" class="mcp-modal" role="dialog" aria-modal="true" aria-labelledby="mcp-import-title" :style="importShellStyle">
          <div class="mcp-modal__head" @pointerdown="importShell.beginDrag" @dblclick="importShell.resetToCenter">
            <h3 id="mcp-import-title" class="mcp-modal__title">导入 JSON</h3>
            <button class="mcp-modal__close" type="button" aria-label="关闭弹窗" @click="closeImportDialog">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="mcp-modal__body">
            <div class="mcp-ffield">
              <span class="mcp-ffield__label">粘贴 MCP 服务器 JSON</span>
              <textarea
                v-model="importText"
                class="mcp-textarea mcp-textarea--tall"
                placeholder='{"mcpServers": { "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] } }}'
              ></textarea>
              <span class="mcp-ffield__hint">支持 {"mcpServers":{…}}（Claude Desktop/Cursor/Windsurf）、{"servers":{…}}（VS Code）与裸 {名称:配置} 三种形态；导入到「Claude Link 管理」。</span>
            </div>
            <button class="mcp-btn" type="button" :disabled="importText.trim() === ''" @click="parseImportPreview">解析预览</button>
            <div v-if="importPreview" class="mcp-imp">
              <div v-if="'error' in importPreview" class="mcp-ffield__hint mcp-ffield__hint--danger">{{ importPreview.error }}</div>
              <template v-else>
                <p class="mcp-imp__sum">识别形态 {{ importPreview.shape }} · 共 {{ importPreview.entries.length }} 台 · 将导入 {{ selectedImportableCount }} 台</p>
                <ul class="mcp-imp__list">
                  <li
                    v-for="e in importPreview.entries"
                    :key="e.name"
                    :class="['mcp-imp__row', { 'mcp-imp__row--unchecked': !e.skip && importChecked[e.name] !== true }]"
                  >
                    <input
                      v-model="importChecked[e.name]"
                      class="mcp-imp__check"
                      type="checkbox"
                      :disabled="e.skip"
                      :aria-label="e.skip ? `不可导入 ${e.name}（${e.skipReason}）` : `导入 ${e.name}`"
                    />
                    <span class="mcp-imp__name">{{ e.name }}</span>
                    <span :class="['mcp-tchip', { 'mcp-tchip--http': e.transport === 'http', 'mcp-tchip--sse': e.transport === 'sse' }]">{{ e.transport.toUpperCase() }}</span>
                    <span v-if="e.skip" class="mcp-off-badge">{{ e.skipReason }}</span>
                    <span v-else class="mcp-scope-badge">将导入</span>
                  </li>
                </ul>
              </template>
            </div>
          </div>
          <div class="mcp-modal__foot">
            <button class="mcp-btn" type="button" @click="closeImportDialog">取消</button>
            <button class="mcp-btn mcp-btn--primary" type="button" :disabled="selectedImportableCount === 0 || importing" @click="confirmImport">{{ importing ? '导入中…' : selectedImportableCount > 0 ? `导入 ${selectedImportableCount} 台` : '导入' }}</button>
          </div>
          <DialogResizeHandles :binder="importShell" />
        </div>
      </div>
    </Teleport>

    <!-- toast 栈（Teleport 到 body；ProviderManager 同款组件内机制） -->
    <Teleport to="body">
      <div class="mcp-toast-wrap" aria-live="polite">
        <div v-for="t in toasts" :key="t.key" class="mcp-toast">{{ t.message }}</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ═══ G13 定稿移植（round3-g13-hybrid.html）：类名 mcp- 前缀；px→rem（16 基准）；
   色值一律 variables.css token（项目紫 #7C5CFC/#5F3DC4 沿用 ConfigPage skill-md 先例字面值，
   不新增全局 token——variables.css 无对应键，避免动全局影响面）。═══ */

.mcp-md-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* ── 左栏 rail ─────────────────────────────────────────────────────────── */
/* 定宽 264px：与同页 .skill-md-rail 对齐（布局骨架恒定 px，迁移决策 D1；= 定稿 16.5rem@16px 基准）。 */
.mcp-rail {
  width: 264px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  padding: 0.875rem 0.625rem;
}

.mcp-rail::-webkit-scrollbar {
  width: 8px;
}

.mcp-rail::-webkit-scrollbar-thumb {
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--color-text-muted) 28%, transparent);
}

.mcp-rail__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.6875rem;
  font-weight: 700;
  color: var(--color-text-muted);
  padding: 0.375rem 0.625rem 0.5625rem;
  letter-spacing: 0.02em;
}

.mcp-rail__head + .mcp-rail__head {
  padding-top: 0.9375rem;
  border-top: 1px solid var(--color-border);
  margin-top: 0.75rem;
}

.mcp-rail-item {
  position: relative;
  display: block;
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  cursor: pointer;
  padding: 0.5625rem 0.625rem 0.625rem 0.875rem;
  margin-bottom: 0.25rem;
  border-radius: var(--radius-md);
  font-family: inherit;
}

.mcp-rail-item:hover {
  background: color-mix(in srgb, var(--color-accent) 5%, transparent);
}

.mcp-rail-item--active {
  background: var(--color-panel-soft);
  box-shadow: var(--ring-light), var(--elevation-1);
}

.mcp-rail-item--active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0.625rem;
  bottom: 0.625rem;
  width: 0.1875rem;
  border-radius: var(--radius-pill);
  background: var(--color-accent);
}

.mcp-rail-item--active-project::before {
  background: #7c5cfc;
}

.mcp-rail-item__top {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.mcp-rail-item__dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-accent);
}

.mcp-rail-item__dot--user {
  background: var(--color-info);
}

.mcp-rail-item__dot--project {
  background: #7c5cfc;
}

.mcp-rail-item__name {
  font-size: 0.8125rem;
  font-weight: 700;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mcp-rail-item__tag {
  font-size: 0.59375rem;
  font-weight: 700;
  color: var(--color-accent-strong);
  padding: 0.0625rem 0.4375rem;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--color-accent) 13%, transparent);
  flex-shrink: 0;
}

.mcp-rail-item__path {
  font-family: var(--font-mono);
  font-size: 0.65625rem;
  color: var(--color-text-muted);
  margin: 0.25rem 0 0 1rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mcp-rail-item__meta {
  font-size: 0.65625rem;
  color: var(--color-text-muted);
  margin: 0.1875rem 0 0 1rem;
  font-variant-numeric: tabular-nums;
}

.mcp-rail__foot {
  margin-top: auto;
  padding: 0.875rem 0.625rem 0.25rem;
  border-top: 1px solid var(--color-border);
  font-size: 0.65625rem;
  color: var(--color-text-muted);
  line-height: 1.6;
}

/* ── 右侧主区 ──────────────────────────────────────────────────────────── */
.mcp-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.mcp-main__head {
  flex: none;
  padding: 0.9375rem 1.25rem 0;
}

.mcp-title-row {
  position: relative; /* tip--head 气泡的定位锚（右缘对齐，防 ⓘ 就近 left:0 展开出屏） */
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.mcp-title-row__dot {
  width: 0.5625rem;
  height: 0.5625rem;
  border-radius: 50%;
  background: var(--color-accent);
}

.mcp-title-row__dot--user {
  background: var(--color-info);
}

.mcp-title-row__dot--project {
  background: #7c5cfc;
}

.mcp-title-row__name {
  font-size: 0.9375rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.mcp-title-row__path {
  font-family: var(--font-mono);
  font-size: 0.71875rem;
  color: var(--color-text-muted);
}

.mcp-title-row__acts {
  margin-left: auto;
  display: inline-flex;
  gap: 0.5rem;
}

.mcp-title-meta {
  font-size: 0.71875rem;
  color: var(--color-text-muted);
  margin: 0.25rem 0 0;
}

/* 用户级读取失败提示行（warn 系，先例 skill-md-rail__status--warn 同族）。 */
.mcp-snap-warn {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin: 0.5rem 0 0;
  font-size: 0.6875rem;
  color: var(--color-warn-strong);
}

.mcp-snap-warn svg {
  width: 0.8125rem;
  height: 0.8125rem;
  flex-shrink: 0;
}

/* 工具栏右侧胶囊（风格 C 契约3：统计胶囊已移除，仅存「批量测试中…」在飞指示）。 */
.mcp-toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0.75rem 0 0;
}

.mcp-statpills {
  display: inline-flex;
  gap: 0.375rem;
  flex-shrink: 0;
}

.mcp-statpill {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.3125rem 0.625rem;
  border-radius: var(--radius-pill);
  font-size: 0.6875rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-text-muted) 7%, transparent);
}

.mcp-search {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0.4375rem 0.75rem;
  font-size: 0.8125rem;
  font-family: inherit;
}

.mcp-search:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 28%, transparent);
}

.mcp-chips {
  display: flex;
  gap: 0.375rem;
}

.mcp-chip {
  border: 1px solid var(--color-border);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
  border-radius: var(--radius-pill);
  padding: 0.3125rem 0.75rem;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}

.mcp-chip--active {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
  color: var(--color-accent-strong);
}

/* ── 滚动区 + 风格 C 分组面板（round4-slim-c.html）：按传输分组 + 组头计数 +
   组内发丝行 + 左侧状态色条（替代圆点信号）────────────────────────────────── */
.mcp-main__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.75rem 1.25rem 0.875rem;
}

.mcp-main__scroll::-webkit-scrollbar {
  width: 8px;
}

.mcp-main__scroll::-webkit-scrollbar-thumb {
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--color-text-muted) 28%, transparent);
}

.mcp-groups {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
  max-width: 52rem;
}

.grp {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
}

.grp__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4375rem 0.875rem;
  background: var(--color-panel);
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  border-bottom: 1px solid var(--color-border);
  font-size: 0.6875rem;
  font-weight: 700;
  color: var(--color-text);
  letter-spacing: 0.02em;
}

.grp__head .cnt {
  margin-left: auto;
  font-size: 0.625rem;
  font-weight: 600;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.grp__row {
  display: flex;
  flex-direction: column;
  gap: 0.1875rem;
  padding: 0.5625rem 0.875rem 0.625rem 1.0625rem;
  transition: background 0.12s var(--ease-out);
}

.grp__row + .grp__row {
  border-top: 1px solid color-mix(in srgb, var(--color-border) 55%, transparent);
}

.grp__row:hover {
  background: color-mix(in srgb, var(--color-accent) 4%, transparent);
}

/* 组末行承担组底部圆角（.grp 无 overflow:hidden，行内 fail ⚠ 气泡不再被裁剪）。 */
.grp__row:last-child {
  border-radius: 0 0 var(--radius-md) var(--radius-md);
}

/* 状态呈现 C：左侧状态色条（ok 绿/none 灰/busy 黄/fail 红/disabled 淡灰+降透明）。 */
.grp__row--ok {
  box-shadow: inset 3px 0 0 var(--color-success);
}

.grp__row--none {
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--color-text-muted) 45%, transparent);
}

.grp__row--busy {
  box-shadow: inset 3px 0 0 var(--color-warn);
}

.grp__row--fail {
  box-shadow: inset 3px 0 0 var(--color-fail);
}

.grp__row--off {
  opacity: 0.6;
}

.grp__row--off:hover {
  opacity: 0.85;
}

.grp__row--disabled {
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--color-text-muted) 25%, transparent);
}

/* 行1：名称 + 徽标 | 操作 + 开关 */
.row__r1 {
  display: flex;
  align-items: center;
  gap: 0.4375rem;
  min-width: 0;
}

.row__name {
  font-size: 0.8125rem;
  font-weight: 700;
  font-family: var(--font-mono);
  letter-spacing: -0.01em;
  white-space: nowrap;
}

.spacer {
  flex: 1;
}

/* 传输 chip——徽标形态 C：实底小方标（stdio 深中性底白字 / http info-strong / sse success-strong）。 */
.mcp-tchip {
  display: inline-flex;
  align-items: center;
  padding: 0.125rem 0.4375rem;
  border-radius: var(--radius-xs);
  font-family: var(--font-mono);
  font-size: 0.5625rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  background: color-mix(in srgb, var(--color-text) 78%, #000);
  color: #fcfaf5;
  flex-shrink: 0;
}

.mcp-tchip--http {
  background: var(--color-info-strong);
  color: #fff;
}

.mcp-tchip--sse {
  background: var(--color-success-strong);
  color: #fff;
}

/* 作用域徽章——形态 C：accent 实底（user info-strong / project 紫，随实底语言延伸；
   效果图仅示 managed 形态，user/project 变体保持既有作用域色相映射）。 */
.mcp-scope-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.125rem 0.5rem;
  border-radius: var(--radius-xs);
  font-size: 0.5625rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  background: var(--color-accent);
  color: var(--color-on-accent);
  flex-shrink: 0;
}

.mcp-scope-badge--user {
  background: var(--color-info-strong);
  color: #fff;
}

.mcp-scope-badge--project {
  background: #7c5cfc;
  color: #fff;
}

.mcp-off-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.125rem 0.5rem;
  border-radius: var(--radius-xs);
  font-size: 0.5625rem;
  font-weight: 700;
  background: var(--color-fail);
  color: #fff;
  flex-shrink: 0;
}

/* 行2：命令行 / url。 */
.row__cmd {
  display: flex;
  align-items: center;
  gap: 0.3125rem;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
}

.row__cmd svg {
  width: 0.6875rem;
  height: 0.6875rem;
  flex-shrink: 0;
  opacity: 0.65;
}

.row__cmd span {
  overflow: hidden;
  text-overflow: ellipsis;
}

.row__cmd b {
  font-weight: 600;
  color: color-mix(in srgb, var(--color-text-muted) 85%, var(--color-text));
}

/* 行3：描述 | 连接状态（fail 态状态文案旁 ⚠ 深色气泡）+ 工具数。 */
.row__r3 {
  display: flex;
  align-items: center;
  gap: 0.5625rem;
}

.row__desc {
  flex: 1;
  min-width: 0;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mcp-card__conn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.65625rem;
  font-weight: 600;
  color: var(--color-success-strong);
  flex-shrink: 0;
}

.mcp-card__conn--off {
  color: var(--color-text-muted);
  font-weight: 500;
}

.mcp-card__conn--fail {
  color: var(--color-danger);
}

.mcp-card__tools {
  font-size: 0.625rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

/* ── 自绘深色气泡 tooltip（风格 C 选型）：--color-text 深底浅字 + elevation-3；
   hover 与 :focus-within 双触发（Ⓘ/⚠ 为可 Tab 聚焦的 button，键盘可达）──────── */
.tip {
  position: relative;
  display: inline-flex;
}

.tip .bubble {
  position: absolute;
  top: calc(100% + 0.5rem);
  left: 0;
  width: max-content;
  max-width: 24rem;
  z-index: 60;
  background: var(--color-text);
  border-radius: var(--radius-md);
  box-shadow: var(--elevation-3);
  padding: 0.6875rem 0.875rem;
  font-size: 0.6875rem;
  line-height: 1.65;
  text-align: left;
  color: color-mix(in srgb, var(--color-panel) 92%, var(--color-text));
  opacity: 0;
  pointer-events: none;
  transform: translateY(0.1875rem);
  transition:
    opacity 0.12s var(--ease-out),
    transform 0.12s var(--ease-out);
}

.tip .bubble b {
  display: block;
  color: #fcfaf5;
  font-weight: 600;
  margin-bottom: 0.3125rem;
}

.tip .bubble span + span {
  display: block;
  margin-top: 0.3125rem;
}

.tip .bubble code {
  font-family: var(--font-mono);
  font-size: 0.65625rem;
  color: #e8c8c8;
}

.tip:hover .bubble,
.tip:focus-within .bubble {
  opacity: 1;
  transform: translateY(0);
}

/* 气泡向上弹出（弹窗 hint 行内用）。 */
.tip--up .bubble {
  top: auto;
  bottom: calc(100% + 0.5rem);
  transform: translateY(-0.1875rem);
}

.tip--up:hover .bubble,
.tip--up:focus-within .bubble {
  transform: translateY(0);
}

/* 标题行 ⓘ 专属变体：Ⓘ 紧邻右侧动作按钮，基础 left:0（自 ⓘ 左缘向右展开 24rem）必超窗口
   右缘截断（2026-10-18 截图回归）。锚定改到 .mcp-title-row（position:relative 锚）右缘、
   向左展开；宽度上限再钳制到行宽（极窄面板下 24rem 也放不下时不溢出）。hover/:focus-within
   触发逻辑不变（bubble 仍是 .tip 的 DOM 子节点）。 */
.tip--head {
  position: static; /* 让位：气泡包含块改为 .mcp-title-row */
}

.tip--head .bubble {
  left: auto;
  right: 0;
  max-width: min(24rem, 100%);
}

/* ⓘ 说明按钮（标题行作用域说明 + 弹窗 hint 行内规则说明共用）。 */
.mcp-info-btn {
  border: 1px solid var(--color-border);
  background: var(--color-panel);
  color: var(--color-text-muted);
  cursor: pointer;
  width: 1.375rem;
  height: 1.375rem;
  border-radius: var(--radius-xs);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 0;
}

.mcp-info-btn svg {
  width: 0.75rem;
  height: 0.75rem;
}

.mcp-info-btn:hover,
.mcp-info-btn:focus-visible {
  color: var(--color-text);
  border-color: var(--color-border-strong);
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
}

.mcp-info-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

/* fail 态 ⚠ 图标（可 Tab 聚焦的 button；气泡见 .tip）。
   契约1：errbar 整行删除后探活错误全文的唯一入口。 */
.warnico {
  border: 0;
  background: transparent;
  display: inline-flex;
  align-items: center;
  color: var(--color-warn-strong);
  cursor: help;
  flex-shrink: 0;
  padding: 0;
  border-radius: var(--radius-xs);
}

.warnico:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.warnico svg {
  width: 0.8125rem;
  height: 0.8125rem;
}

/* 弹窗 hint 行内 ⓘ（小一号）。 */
.hintrow {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.hintrow .mcp-info-btn {
  width: 1.125rem;
  height: 1.125rem;
}

.hintrow .mcp-info-btn svg {
  width: 0.6875rem;
  height: 0.6875rem;
}

/* ── 按钮（导入 JSON / 添加服务器 / iconbtn）──────────────────────────── */
.mcp-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0.5rem 0.875rem;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}

.mcp-btn:hover:not(:disabled) {
  border-color: var(--color-border-strong);
}

.mcp-btn svg {
  width: 0.875rem;
  height: 0.875rem;
}

.mcp-btn--primary {
  background: var(--color-accent);
  border-color: transparent;
  color: var(--color-on-accent);
}

.mcp-btn--primary:hover:not(:disabled) {
  background: var(--color-accent-strong);
}

.mcp-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.mcp-iconbtn {
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  width: 1.6875rem;
  height: 1.6875rem;
  border-radius: var(--radius-xs);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.mcp-iconbtn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  color: var(--color-accent-strong);
}

.mcp-iconbtn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-danger) 9%, transparent);
  color: var(--color-danger);
}

.mcp-iconbtn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.mcp-iconbtn svg {
  width: 0.8125rem;
  height: 0.8125rem;
}

/* ── 开关（定稿 .switch 同值移植）────────────────────────────────────── */
.mcp-switch {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  width: 2.5rem;
  height: 1.375rem;
  margin: 0;
  border-radius: var(--radius-pill);
  background: var(--color-border-strong);
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--duration-base) var(--ease-out);
}

.mcp-switch::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 0.1875rem;
  width: 1.0625rem;
  height: 1.0625rem;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transform: translateY(-50%);
  transition: transform var(--duration-base) var(--ease-spring);
}

.mcp-switch:checked {
  background: var(--color-accent);
}

.mcp-switch:checked::before {
  transform: translateY(-50%) translateX(1.125rem);
}

.mcp-switch:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

/* ── 空态 / note ─────────────────────────────────────────────────────── */
.mcp-empty {
  padding: 1.75rem;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  line-height: 1.8;
}

.mcp-empty code {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--color-accent-strong);
  overflow-wrap: anywhere;
}

.mcp-empty__retry {
  display: inline-block;
  margin-left: 0.5rem;
  border: 1px solid color-mix(in srgb, var(--color-warn-strong) 50%, transparent);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--color-warn-strong);
  padding: 0.125rem 0.5rem;
  font-size: 0.625rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}

.mcp-empty__retry:hover {
  background: color-mix(in srgb, var(--color-warn) 16%, transparent);
}

/* ── 弹窗（定稿 mask/modal/form/seg/select/kvrow 同值移植，mcp- 前缀）────── */
.mcp-mask {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  background: rgba(0, 0, 0, 0.58);
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
}

.mcp-modal {
  position: absolute; /* shell rect 绑定后由 :style 定位；未测量帧（rect null）无 inset，静态位置回退遮罩 flex 居中（P8） */
  width: min(35rem, 94vw);
  max-height: min(44rem, 86vh);
  display: flex;
  flex-direction: column;
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  border-radius: 1rem;
  box-shadow: var(--elevation-3);
  animation: mcp-modal-in var(--duration-slow) var(--ease-spring);
}

@keyframes mcp-modal-in {
  from {
    opacity: 0;
    transform: translateY(0.75rem) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .mcp-modal {
    animation: none;
  }
}

.mcp-modal__head {
  display: flex;
  align-items: center;
  padding: 1rem 1.25rem 0.875rem;
  border-bottom: 1px solid var(--color-border);
  cursor: move; /* 标题栏拖动（P8）；head 内关闭按钮为 button，shell 忽略规则自动豁免 */
  touch-action: none;
}

.mcp-modal__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
}

.mcp-modal__close {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  width: 1.875rem;
  height: 1.875rem;
  border-radius: var(--radius-xs);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.mcp-modal__close:hover {
  color: var(--color-text);
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
}

.mcp-modal__close svg {
  width: 1rem;
  height: 1rem;
}

.mcp-modal__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem 1.25rem;
}

.mcp-modal__body::-webkit-scrollbar {
  width: 8px;
}

.mcp-modal__body::-webkit-scrollbar-thumb {
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--color-text-muted) 28%, transparent);
}

.mcp-modal__foot {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.875rem 1.25rem 1rem;
  border-top: 1px solid var(--color-border);
}

.mcp-form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem 1rem;
}

.mcp-ffield {
  display: flex;
  flex-direction: column;
  gap: 0.3125rem;
}

.mcp-ffield--full {
  grid-column: 1 / -1;
}

.mcp-ffield__label {
  font-size: 0.75rem;
  font-weight: 600;
}

.mcp-ffield__hint {
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  line-height: 1.5;
}

/* 校验红字（name 非法/必填缺失/一期位置不可写提示；派生自 --color-fail token）。 */
.mcp-ffield__hint--danger {
  color: var(--color-fail);
}

.mcp-input,
.mcp-textarea {
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
  font-family: inherit;
}

.mcp-input:focus,
.mcp-textarea:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 28%, transparent);
}

.mcp-input--mono {
  font-family: var(--font-mono);
  font-size: 0.78125rem;
}

/* 校验失败红边框（name/命令/URL 非法时）。 */
.mcp-input--invalid,
.mcp-input--invalid:focus {
  border-color: var(--color-fail);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-fail) 22%, transparent);
}

.mcp-input:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}

.mcp-textarea {
  min-height: 3.5rem;
  resize: vertical;
  font-family: var(--font-mono);
  font-size: 0.78125rem;
  line-height: 1.6;
}

.mcp-textarea--tall {
  min-height: 8rem;
}

.mcp-seg {
  display: inline-flex;
  padding: 0.125rem;
  gap: 0.125rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  width: fit-content;
}

.mcp-seg__btn {
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 0.375rem 0.875rem;
  border-radius: var(--radius-xs);
  font-size: 0.75rem;
  font-weight: 600;
  font-family: inherit;
}

.mcp-seg__btn--active {
  background: var(--color-panel);
  color: var(--color-accent-strong);
  box-shadow: var(--ring-light), var(--elevation-1);
}

.mcp-select-wrap {
  position: relative;
  display: inline-flex;
  width: 100%;
}

.mcp-select {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0.5rem 2rem 0.5rem 0.75rem;
  font-size: 0.8125rem;
  font-family: inherit;
  cursor: pointer;
}

.mcp-select-wrap::after {
  content: '';
  position: absolute;
  right: 0.7rem;
  top: 50%;
  width: 0.5rem;
  height: 0.5rem;
  border-right: 1.5px solid var(--color-text-muted);
  border-bottom: 1.5px solid var(--color-text-muted);
  transform: translateY(-70%) rotate(45deg);
  pointer-events: none;
}

.mcp-kvrow {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto;
  gap: 0.5rem;
  align-items: center;
}

.mcp-kvrow + .mcp-kvrow {
  margin-top: 0.5rem;
}

.mcp-kvrow__del {
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: var(--radius-xs);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.mcp-kvrow__del:hover {
  color: var(--color-danger);
  background: color-mix(in srgb, var(--color-danger) 8%, transparent);
}

.mcp-kvrow__del svg {
  width: 0.875rem;
  height: 0.875rem;
}

.mcp-kvadd {
  border: 0;
  background: transparent;
  color: var(--color-accent-strong);
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-family: inherit;
}

.mcp-kvadd:hover {
  color: var(--color-accent);
}

.mcp-kvadd svg {
  width: 0.75rem;
  height: 0.75rem;
}

/* 导入预览（解析结果清单；复用 tchip/off-badge/scope-badge 徽章族）。 */
.mcp-imp {
  margin-top: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.mcp-imp__sum {
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.mcp-imp__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  max-height: 16rem;
  overflow-y: auto;
}

.mcp-imp__row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3125rem 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
}

.mcp-imp__name {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  font-weight: 700;
  overflow-wrap: anywhere;
}

/* p3-R3 逐条勾选：行首 checkbox（appearance:none 自绘，.mcp-switch 同款写法；现有 token 着色）。 */
.mcp-imp__check {
  appearance: none;
  -webkit-appearance: none;
  width: 0.9375rem;
  height: 0.9375rem;
  margin: 0;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-xs);
  background: var(--color-panel);
  cursor: pointer;
  flex-shrink: 0;
  display: inline-grid;
  place-content: center;
  transition:
    background var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out);
}

.mcp-imp__check::before {
  content: '';
  width: 0.5625rem;
  height: 0.5625rem;
  background: var(--color-on-accent);
  clip-path: polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%);
  transform: scale(0);
  transition: transform 60ms linear;
}

.mcp-imp__check:checked {
  background: var(--color-accent);
  border-color: var(--color-accent);
}

.mcp-imp__check:checked::before {
  transform: scale(1);
}

.mcp-imp__check:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

/* skip 行：disabled 不可交互；disabled+checked 以灰底呈现（不暗示「将导入」）。 */
.mcp-imp__check:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.mcp-imp__check:disabled:checked {
  background: var(--color-border-strong);
  border-color: var(--color-border-strong);
}

/* 未勾选（将不导入）行降透明度提示——对照 .grp__row--off 同值 0.6。 */
.mcp-imp__row--unchecked {
  opacity: 0.6;
}

/* ── toast 栈（ProviderManager 同款布局，类名 mcp- 前缀）────────────────── */
.mcp-toast-wrap {
  position: fixed;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  /* r3-F5：1260 高于弹窗遮罩/交互层 1200 与 diff 层 1250——弹窗在场时保存失败等 toast 仍可见。 */
  z-index: 1260;
  align-items: center;
}

.mcp-toast {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  background: var(--color-text);
  color: var(--color-panel-soft);
  font-size: 0.8125rem;
  padding: 0.5625rem 0.75rem 0.5625rem 1rem;
  border-radius: var(--radius-md);
  box-shadow: var(--elevation-3);
}
</style>
