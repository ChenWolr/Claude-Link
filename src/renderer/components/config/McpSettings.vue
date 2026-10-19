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
// getConfigForRenderer 掩码为哨兵 MCP_VALUE_MASK（8×U+2022，src/shared/mcp-json.ts 唯一字面
// 定义）；编辑弹窗回显哨兵，提交时哨兵值
// 照传（键改名附 envRenameFrom/headersRenameFrom 瞬态 hint），由主进程 mcp:managedSave 的
// restoreMaskedMcpServers 按已存条目还原——渲染层全程零明文，哨兵绝不落配置。
// P8 双向写入（2026-10-17）：保存位置三作用域全部可真正写入——user/project 走 mcp:writeScoped
// （主进程 mcp-writer.ts：~/.claude.json / <dir>/.mcp.json 整树保留写 + 哨兵按原文件还原 +
// tmp+rename 原子写 + mtime 冲突重试）；保存前 snapshot 预查同名 → requestConfirm 覆盖确认；
// 删除后 setMcpOverride 拨回启用。user/project 编辑回显：env/headers 行 = snapshot 键列表 +
// 哨兵值 + sentinelfor（E0-6，渲染层零明文）；描述字段仅管理库有（ScopedMcpEntry 无此键，E0-1）；
// 「测试连接」探活仍仅管理库（探活器只认管理库明文条目）。
import { computed, nextTick, ref, watch, onBeforeUnmount } from 'vue';
import { useConfigStore } from '../../stores/config-store';
import { useInteractionStore } from '../../stores/interaction-store';
import { ESC_LAYER_PRIORITY, pushEscLayer, type EscLayerHandle } from '../../composables/use-esc-stack';
import { useDialogShell } from '../../composables/use-dialog-shell';
import DialogResizeHandles from '../common/DialogResizeHandles.vue';
import { normalizeDirKey } from '../../../shared/project-skills';
// 点5 表单⇄JSON 双模式 + 点6 哨兵常量：「表单 → JSON」方向序列化与哨兵 MCP_VALUE_MASK
// （全仓唯一字面定义）来自 shared 纯模块，renderer 可直接 import；「JSON → 表单」反方向与
// 导入弹窗解析（点6）走主进程 parseMcpServersJson（经 window.claudeLink.parseMcpJson IPC），
// 两侧口径互为往返——见 scripts/selftest-mcp-settings.ts K 组。
import { buildSingleServerExportJson, MCP_VALUE_MASK, type SingleServerExportInput } from '../../../shared/mcp-json';
import type { McpManagedServer } from '../../../shared/types/config';
// preload 视图类型（type-only，env.d.ts 同源先例；字段形状以 src/preload/api.ts 为准）。
// McpManagedSaveEntry = managedSave 提交形态（McpManagedServer + 瞬态改名 hint，仅提交方向）。
// McpWriteScopedPayload = writeScoped 提交载荷（P8：user/project 作用域 upsert/remove）。
// McpParsedJsonEntry = mcp:parseMcpJson 回包条目（点6 导入弹窗预览 source 类型，主进程
// ParsedMcpEntry 同构镜像——渲染层不再自持归一副本类型）。
import type { McpExportScopedPayload, McpManagedSaveEntry, McpParsedJsonEntry, McpProbeReport, McpProjectDirView, McpSnapshot, McpScopedWriteEntry, McpWriteScopedPayload } from '../../../preload/api';

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

// ═══ 哨兵还原 + 导入预览辅助纯函数区（p7b；与组件其余部分无闭包耦合）════════════
// >>>>>>>>>> p7b-pure-begin（scripts/tmp-p7b-smoke.ts 据此切片做交叉比对；勿引入组件闭包状态）
// §1.3 哨兵常量：MCP_VALUE_MASK（8×U+2022，上方 shared import，全仓唯一字面定义；主进程
// mcp-config.ts 内另有其同值 re-export 常量——名字不在渲染层字面引用，selftest O2 钉该主进程
// 名在 src/renderer 零出现；round-002 F5 清除了原注释误写的常量名）——点6 删除了本地字面量副本。
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/; // §1.1/§3.2：工具名 mcp__<name>__<tool> 的约束

/** 普通对象判定（null/数组/标量均否；与主进程 mcp-config isPlainObject 同语义）。 */
function isPlainObjectLocal(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 导入预览条目：source 为主进程解析桥回包条目（McpParsedJsonEntry 镜像类型；确认导入时
 *  映射 McpManagedServer），skip/skipReason 供预览标记。点6 前渲染层自持归一副本类型，
 *  已随导入归一副本函数一并删除。 */
interface ImportPreviewEntry {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  skip: boolean;
  skipReason: string;
  source: McpParsedJsonEntry;
}

/**
 * 导入文本分析（预览与确认导入同源调用；点6 起解析管道收口主进程）：三形态识别与条目归一
 * 全部由主进程 parseMcpServersJson（window.claudeLink.parseMcpJson 桥）完成——渲染层不再
 * 自持任何归一/值级清洗副本（副本链已删，selftest H6/O 组钉）。语义对齐：
 *   - ok:false（坏 JSON/根非对象/三形态都取不到合法 map）→ 原样透传主进程中文 error（判定式
 *     与文案与改前本地解析逐字一致，selftest B 组钉主进程侧行为）；
 *   - IPC 自身异常为防御路径（正常不达：handler 仅拒非 string 入参），同「JSON 解析失败：…」
 *     呈现，不加后缀（对齐改前本地 JSON.parse 失败文案形态）；
 *   - 条目级容错在主进程内（归一不出 → 该条不出现在 servers，等价改前「静默跳过该条」）。
 * 渲染层仅保留两件展示/标记用轻逻辑：
 *   - shape 形态标签（detectImportShapeLabel，仅预览摘要展示文案）；
 *   - skip 规则标记：与现有管理库同名 →「与现有同名 → 将跳过」（§3.3）；name 不匹配 §1.1
 *     pattern →「名称非法 → 将跳过」（主进程 sanitize 会丢弃，预览如实标记，防「预览说导入、
 *     实存少一条」）。
 */
async function analyzeImportText(text: string, existing: Array<{ name: string }>): Promise<{ shape: string; entries: ImportPreviewEntry[] } | { error: string }> {
  let result: Awaited<ReturnType<typeof claude.parseMcpJson>>;
  try {
    result = await claude.parseMcpJson(text);
  } catch (e) {
    return { error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!result.ok) return { error: result.error };
  const existingNames = new Set(existing.map((s) => s.name));
  const entries: ImportPreviewEntry[] = [];
  for (const parsed of result.servers) {
    if (existingNames.has(parsed.name)) {
      entries.push({ name: parsed.name, transport: parsed.transport, skip: true, skipReason: '与现有同名 → 将跳过', source: parsed });
    } else if (!NAME_PATTERN.test(parsed.name)) {
      entries.push({ name: parsed.name, transport: parsed.transport, skip: true, skipReason: '名称非法 → 将跳过', source: parsed });
    } else {
      entries.push({ name: parsed.name, transport: parsed.transport, skip: false, skipReason: '', source: parsed });
    }
  }
  return { shape: detectImportShapeLabel(text), entries };
}

/**
 * 导入形态标签（仅预览摘要「识别形态 …」展示用；点6）：主进程解析成功后本地轻量识别三形态
 * 文案，判定式与主进程 parseMcpServersJson 的保留键逻辑同款（record.mcpServers 普通对象
 * 优先；否则不含保留键 mcpServers/servers → 裸 map；否则 record.servers 普通对象）——主进程
 * ok:true 蕴含本函数可识别出同一形态，末尾裸 map 回退为不可达防御。此处不做任何条目级归一
 * （值级清洗等语义全在主进程）。
 */
function detectImportShapeLabel(text: string): string {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return '裸 {名称:配置}'; // 不可达（主进程 ok:true 已排除坏 JSON），防御回退
  }
  if (!isPlainObjectLocal(root)) return '裸 {名称:配置}';
  const record = root;
  const hasReservedKey =
    Object.prototype.hasOwnProperty.call(record, 'mcpServers') ||
    Object.prototype.hasOwnProperty.call(record, 'servers');
  if (isPlainObjectLocal(record.mcpServers)) return '{"mcpServers":{…}}';
  if (!hasReservedKey) return '裸 {名称:配置}';
  if (isPlainObjectLocal(record.servers)) return '{"servers":{…}}';
  return '裸 {名称:配置}'; // 不可达（主进程 ok:true 已排除取不到 map），防御回退
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
    if (row.value === MCP_VALUE_MASK) {
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
// 方案 A 点4：编辑/新建从 Teleport 弹窗改为主区第二视图（v-show 常挂——表单 state 常驻，
// 取消/面包屑/Esc 返回均不清表单，重开沿用既有「关闭不丢已填内容」规则）；
// 'list'=卡片列表视图，'edit'=页内编辑器视图。rail 切作用域强制回 'list'（防跨作用域残留编辑器）。
const editorView = ref<'list' | 'edit'>('list');
const dialogMode = ref<DialogMode | null>(null);
const isEditMode = computed<boolean>(() => dialogMode.value?.kind === 'edit');

/** rail 切作用域：同拍把编辑器视图拨回列表（编辑态属旧作用域条目，不跨作用域残留）。 */
function switchScope(scope: ScopeId): void {
  activeScope.value = scope;
  editorView.value = 'list';
}

// 页内 Esc（点4）：仅编辑器视图回列表；list 视图无操作（连续 Esc 无副作用）；编辑器不再入
// 全局 esc-stack（导入弹窗仍走原全局链，见 onGlobalKey）。绑定在组件根 @keydown.escape，
// 焦点在组件内时经冒泡触发。
const editorRef = ref<HTMLElement | null>(null);

/** 进入编辑视图后把焦点落到编辑器容器（tabindex="-1"）——列表 v-show 隐藏后浏览器会把焦点
 *  回落到 body，根元素的 @keydown.escape 收不到冒泡；显式落焦保证 Esc 回列表开箱即用。 */
function focusEditor(): void {
  void nextTick(() => editorRef.value?.focus());
}

function onEditorEsc(): void {
  if (editorView.value === 'edit') editorView.value = 'list';
}

/** 进入编辑器视图（新建/编辑共用入口）：切视图 + 落焦（保证 Esc 回列表开箱即用）。
 *  点5：编辑器恒以表单侧进入并清红条——JSON 文本切 JSON 时按当前表单现算，跨条目/跨次
 *  不残留上一视图态（jsonText 本身不清，切入 JSON 即被现算覆盖）；改名 hint 快照同拍清空
 *  （round-002 F1：防上一条目的映射跨条目污染——新建/编辑切换均经本入口）。 */
function openEditor(): void {
  editMode.value = 'form';
  jsonError.value = '';
  jsonRenameHints.value = { env: {}, headers: {} };
  editorView.value = 'edit';
  focusEditor();
}

const formLocation = ref<SaveLocation>('managed');
const formProjectDir = ref('');
const formName = ref('');
const formTransport = ref<'stdio' | 'http' | 'sse'>('stdio');
const formDescription = ref('');
const formCommand = ref('');
const formArgsText = ref(''); // 参数 textarea：每行一个 → string[]
const formUrl = ref('');
const formTimeoutMs = ref(''); // 超时（毫秒）number 输入原值（点5，三作用域共用）：'' = 默认；非空须 1..120000 整数
const formEnvRows = ref<KvRow[]>([]);
const formHeaderRows = ref<KvRow[]>([]);
const saving = ref(false);
// 校验 touched 门控：错误红字/红框延迟到「字段失焦过或提交尝试过」才展示，
// 弹窗刚打开的全空表单不再满屏红。formValid 判禁用仍用原值（不受门控影响）。
const touchedFields = ref<{ name: boolean; command: boolean; url: boolean; timeout: boolean }>({ name: false, command: false, url: false, timeout: false });
const submitAttempted = ref(false);

// 保存位置段位：三作用域全部可真正写入（P8 起）。user/project 走 mcp:writeScoped 主进程
// 写入器（哨兵按原文件还原 + 整树保留写 + 原子写）；managed 走 saveMcpManaged 既有链。
const locationHint = computed<string>(() => {
  if (formLocation.value === 'managed') return '存入应用配置库，仅 Claude Link 会话可用（经 SDK 注入，优先级最高，推荐）。';
  if (formLocation.value === 'user') return '写入 ~/.claude.json，全局 Claude Code 共享（所有项目的新会话可用，运行中会话不重载）。';
  if (formProjectDir.value !== '') return `写入 ${formProjectDir.value}\\.mcp.json，随仓库共享（仅该目录下的会话可用）。`;
  return '写入所选项目目录的 .mcp.json，随仓库共享（仅该目录下的会话可用）。';
});

/** 编辑器副文（对照原型 .mxA-ehead p）：编辑态 `{name} · {作用域名}`；新建态 `保存位置：{作用域名}`。
 *  project 作用域的作用域名 = 项目目录名（round-002 F2，对照原型 round5-final-a :202/:308 的
 *  sc.label=目录名如 'my-app'；目录不在 projectDirs（快照刷新间隙的消失目录）回退「项目级」）；
 *  managed/user 不动。 */
const editorSubline = computed<string>(() => {
  const loc = formLocation.value === 'project' && formProjectDir.value !== ''
    ? projectDirs.value.find((d) => d.path === formProjectDir.value)?.name ?? locationLabel('project')
    : locationLabel(formLocation.value);
  return isEditMode.value ? `${formName.value} · ${loc}` : `保存位置：${loc}`;
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

// §3.2 校验：名称必填 + pattern +（managed，跨作用域另存也拦，编辑中自身条目按 id 豁免）管理库内唯一——managed 重名在 UI 拦截
// （主进程 sanitize 保留第一条，放行会导致「保存成功但新条目被静默丢弃」）；user/project
// 同名不在 UI 拦截、走保存时覆盖确认（E3：重名查仅对 managed 生效）；pattern 仅拦新增
// （编辑态名称只读，外部文件 pattern 外名称须可原样保存，managed 编辑名经 sanitize 恒合法）。
const nameError = computed<string>(() => {
  const name = formName.value.trim();
  if (name === '') return '名称必填';
  if (!isEditMode.value && !NAME_PATTERN.test(name)) return '名称仅限字母、数字、-、_，长度 1–64';
  const mode = dialogMode.value;
  const editingManagedId = mode !== null && mode.kind === 'edit' && !mode.id.startsWith('user:') && !mode.id.startsWith('project:') ? mode.id : null;
  if (formLocation.value === 'managed' && managedServers.value.some((s) => s.name === name && s.id !== editingManagedId)) return '与现有服务器重名（管理库内名称唯一）';
  return '';
});
const commandError = computed<string>(() => (formTransport.value === 'stdio' && formCommand.value.trim() === '' ? 'stdio 必填命令' : ''));
const urlError = computed<string>(() => (formTransport.value !== 'stdio' && formUrl.value.trim() === '' ? 'http/sse 必填 URL' : ''));
// 超时（毫秒）校验（点5，三作用域共用）：空 = 默认合法（提交不带 timeoutMs）；非空须为
// 1..120000 整数（错误文案 en-dash 逐字对齐计划，selftest N5 钉）。
const timeoutError = computed<string>(() => {
  const raw = formTimeoutMs.value.trim();
  if (raw === '') return '';
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 120000) return '超时须为 1–120000 的整数（毫秒）';
  return '';
});
// P8：project 位置须选定目标项目目录（dir 缺失主进程会拒绝写入）。
const formValid = computed<boolean>(() => !nameError.value && !commandError.value && !urlError.value && !timeoutError.value && (formLocation.value !== 'project' || formProjectDir.value !== ''));
// 展示态错误：touched（失焦过）或提交尝试过才透出原错误，否则为空（不渲染红）。
const nameErrorShown = computed<string>(() => (touchedFields.value.name || submitAttempted.value ? nameError.value : ''));
const commandErrorShown = computed<string>(() => (touchedFields.value.command || submitAttempted.value ? commandError.value : ''));
const urlErrorShown = computed<string>(() => (touchedFields.value.url || submitAttempted.value ? urlError.value : ''));
const timeoutErrorShown = computed<string>(() => (touchedFields.value.timeout || submitAttempted.value ? timeoutError.value : ''));

// ── 表单 ⇄ JSON 双模式（方案 A 点5）──────────────────────────────────────────
// 「表单 | JSON」分段胶囊切换的编辑器内双模式：切 JSON = 当前表单 draft 经 shared 纯函数
// buildSingleServerExportJson 序列化（env/headers 行值取当前输入原样——哨兵或明文新值）；renameFrom
// 是主进程还原 hint，不进 JSON 文本，改由 jsonRenameHints 快照承载（round-002 F1：切 JSON 前快照
// 当前 KV 行改名映射，回填时据此还原 sentinelfor——否则「表单改名 → 切 JSON → 切回」会把
// sentinelfor 覆盖成当前键，保存后主进程按错键还原 → 该键值静默丢弃）；切回表单 / JSON 模式
// 保存 = jsonText 经 mcp:parseMcpJson（主进程 parseMcpServersJson 统一解析）回填表单 state，
// 逐步校验任一失败停留 JSON 侧红条并保留用户输入。description 不参与 JSON 往返（导出不带
// 该键、解析产物无此键，表单值往返不动）。
const editMode = ref<'form' | 'json'>('form');
const jsonText = ref('');
const jsonError = ref('');
const jsonParsing = ref(false);
/** JSON 往返键改名 hint 快照（round-002 F1）：{ [当前键]: 原键 }（env/headers 各一表）。
 *  生命周期：切 JSON 前现算快照 → parseJsonDraft 回填消费；openEditor/resetForm 清空（防
 *  跨条目/保存后污染）。仅承载「JSON 文本外」的改名信息——JSON 内键被二次改名时无从推断
 *  （快照查不到该键 → sentinelfor=当前键，维持无 hint 既有语义）。 */
const jsonRenameHints = ref<{ env: Record<string, string>; headers: Record<string, string> }>({ env: {}, headers: {} });

/** 超时输入原值 → 提交值（点5 保存链装填）：'' → undefined（条目不带 timeoutMs=默认）；
 *  非法值防御性返回 undefined（表单侧 formValid 已拦、JSON 解析侧主进程 normalizeMcpEntry
 *  丢字段，三处口径同 isValidMcpTimeoutMs：1..120000 整数）。 */
function timeoutFormValue(): number | undefined {
  const raw = formTimeoutMs.value.trim();
  if (raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 120000 ? n : undefined;
}

/** 当前表单 state → 单服务器导出 JSON 输入（env/headers 行值原样组装 Record——kvRowsToRecord
 *  产物取 value 侧，哨兵照传；renameFrom 是主进程还原 hint，不进 JSON——由调用侧 jsonRenameHints
 *  快照承载（round-002 F1）；description 不导出）。 */
function formDraftToExportInput(): SingleServerExportInput {
  const input: SingleServerExportInput = { name: formName.value.trim(), transport: formTransport.value };
  if (formTransport.value === 'stdio') {
    input.command = formCommand.value.trim();
    const args = formArgsText.value.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    if (args.length > 0) input.args = args;
    const env = kvRowsToRecord(formEnvRows.value);
    if (env) input.env = env.value;
  } else {
    input.url = formUrl.value.trim();
    const headers = kvRowsToRecord(formHeaderRows.value);
    if (headers) input.headers = headers.value;
  }
  const timeoutMs = timeoutFormValue();
  if (timeoutMs !== undefined) input.timeoutMs = timeoutMs;
  return input;
}

/** 分段胶囊切换（jsonParsing 在飞 / saving 落盘在途时拒绝——按钮 disabled 之外的双保险）：
 *  切 JSON 先快照 KV 行改名映射（round-002 F1：renameFrom 不进 JSON 文本，经 jsonRenameHints
 *  跨 JSON 模式存活）再按当前表单序列化（每次切入都现算，不留陈旧文本）；切表单先解析回填，
 *  失败停留 JSON 侧（jsonError 已设），成功才拨 editMode='form'。 */
async function switchEditMode(mode: 'form' | 'json'): Promise<void> {
  if (editMode.value === mode || jsonParsing.value || saving.value) return;
  if (mode === 'json') {
    jsonRenameHints.value = { env: kvRowsRenameHints(formEnvRows.value), headers: kvRowsRenameHints(formHeaderRows.value) };
    jsonText.value = buildSingleServerExportJson(formDraftToExportInput());
    jsonError.value = '';
    editMode.value = 'json';
    return;
  }
  if (await parseJsonDraft()) editMode.value = 'form';
}

/**
 * jsonText → 主进程解析 + 逐步校验 + 回填表单 state（不切视图；「切回表单」与「JSON 模式
 * 保存」两路共用）。失败语义（设 jsonError、返回 false，调用方停留 JSON 侧、textarea 不清空）：
 *   - ok:false（坏 JSON/根非对象/数组根/三形态都取不到，含空文本/纯空白）→「JSON 解析失败：…（已保留你的输入）」；
 *   - servers 空（含 {"名称":{}} 空配置体——主进程 normalizeMcpEntry 跳过后零条）→「未找到有效的服务器配置」；
 *   - servers >1 →「JSON 模式一次只支持编辑一台服务器（识别到 N 台）」；
 *   - 编辑态改名 →「编辑态不可改名：JSON 键名必须与当前服务器名称一致」。
 *   - 原始 JSON 条目内 timeoutMs 存在但非法（非 1..120000 整数）→「超时须为 1–120000 的
 *     整数（毫秒）：JSON 中的 timeoutMs 未生效」（P3 跟进 R9：主进程 normalizeMcpEntry 对
 *     非法值静默丢字段，不拦则保存成功但超时未生效零提示，与表单侧强校验不对称）。
 * 通过 → 回填 transport/command/args/env/url/headers/timeoutMs（args 数组↔textarea 换行互转
 * 沿用现有逻辑；env/headers 值直接作行值，哨兵行 sentinelfor = jsonRenameHints 快照[当前键] ??
 * 当前键（round-002 F1：快照在切 JSON 前现算，键未动时「表单侧改名仍按原键还原」链完整跨
 * JSON 往返；JSON 文本中键被二次改名则快照查不到该键，无从推断原键，退化为无 hint 与既有
 * 无 hint 语义一致）；新建态回填 formName=JSON 键（保存链现有名称校验接管）。
 * 返回 true。IPC 自身异常同「解析失败」呈现（防御路径，正常不达）。
 */
async function parseJsonDraft(): Promise<boolean> {
  if (jsonParsing.value) return false;
  jsonParsing.value = true;
  try {
    // 快照本轮回解析的文本：两次解析同源，IPC 在飞窗口用户改文本不再产生未守卫 SyntaxError，红条对应实际被解析的文本
    const text = jsonText.value;
    let result: Awaited<ReturnType<typeof claude.parseMcpJson>>;
    try {
      result = await claude.parseMcpJson(text);
    } catch (e) {
      jsonError.value = `JSON 解析失败：${e instanceof Error ? e.message : String(e)}（已保留你的输入）`;
      return false;
    }
    if (!result.ok) {
      jsonError.value = `JSON 解析失败：${result.error}（已保留你的输入）`;
      return false;
    }
    if (result.servers.length === 0) {
      jsonError.value = '未找到有效的服务器配置';
      return false;
    }
    if (result.servers.length > 1) {
      jsonError.value = `JSON 模式一次只支持编辑一台服务器（识别到 ${result.servers.length} 台）`;
      return false;
    }
    const server = result.servers[0];
    if (!server) return false; // 不可达防御（length 已 ≥1）
    if (isEditMode.value && server.name !== formName.value.trim()) {
      jsonError.value = '编辑态不可改名：JSON 键名必须与当前服务器名称一致';
      return false;
    }
    // P3 跟进 R9：原始 JSON 条目内 timeoutMs 存在但非法（主进程 normalize 静默丢字段 →
    // 保存成功但超时未生效零提示，与表单侧强校验不对称）→ 红条停留 JSON 侧。
    // 拦截先于下方回填：此处 return false 时表单 state 未被部分回填污染，jsonText 保留。
    const rawRoot = JSON.parse(text) as Record<string, unknown>;
    // 镜像主进程三形态优先级（isPlainObject/hasReservedKey，同 mcp-config.ts parseMcpServersJson）：
    const hasReservedKey = Object.prototype.hasOwnProperty.call(rawRoot, 'mcpServers')
      || Object.prototype.hasOwnProperty.call(rawRoot, 'servers');
    const rawMap = isPlainObjectLocal(rawRoot.mcpServers) ? rawRoot.mcpServers
      : !hasReservedKey && isPlainObjectLocal(rawRoot) ? rawRoot
      : isPlainObjectLocal(rawRoot.servers) ? rawRoot.servers
      : null;
    const rawEntry = rawMap !== null && typeof rawMap === 'object' ? rawMap[server.name] : undefined;
    if (rawEntry !== undefined && typeof rawEntry === 'object' && rawEntry !== null) {
      const rawTimeout = (rawEntry as Record<string, unknown>).timeoutMs;
      if (rawTimeout !== undefined && !(typeof rawTimeout === 'number' && Number.isInteger(rawTimeout) && rawTimeout >= 1 && rawTimeout <= 120000)) {
        jsonError.value = '超时须为 1–120000 的整数（毫秒）：JSON 中的 timeoutMs 未生效';
        return false;
      }
    }
    if (!isEditMode.value) formName.value = server.name; // 新建态：JSON 键即名称
    formTransport.value = server.transport;
    formCommand.value = server.command ?? '';
    formArgsText.value = (server.args ?? []).join('\n');
    formUrl.value = server.url ?? '';
    formEnvRows.value = kvRowsFromParsed(server.env, jsonRenameHints.value.env);
    formHeaderRows.value = kvRowsFromParsed(server.headers, jsonRenameHints.value.headers);
    formTimeoutMs.value = server.timeoutMs !== undefined ? String(server.timeoutMs) : '';
    jsonError.value = '';
    return true;
  } finally {
    jsonParsing.value = false;
  }
}

/** 解析产物 env/headers Record → KV 行（值直接作行值；哨兵值行 sentinelfor = hints[当前键] ??
 *  当前键——round-002 F1：hints 为切 JSON 前的改名快照，键未动时与纯表单路径等价（主进程
 *  哨兵还原/改名还原链不受 JSON 往返损伤）；JSON 内键被二次改名 → 快照查不到 → sentinelfor=
 *  当前键（无 hint 既有语义））。空/缺失 → 默认一行空行（表单默认形态）。 */
function kvRowsFromParsed(record: Record<string, string> | undefined, hints?: Record<string, string>): KvRow[] {
  if (!record || Object.keys(record).length === 0) return [emptyKvRow()];
  return Object.entries(record).map(([k, v]) => (v === MCP_VALUE_MASK ? { key: k, value: v, sentinelfor: hints?.[k] ?? k } : { key: k, value: v }));
}

/** KV 行 → JSON 往返改名 hint 快照（round-002 F1）：{ [trim 后当前键]: 原键 }——仅记值仍为
 *  哨兵且 sentinelfor !== 当前键的行（与 kvRowsToRecord 的 renameFrom 判定同口径：非哨兵值
 *  的行 sentinelfor 不参与改名链；空键行丢弃）。切 JSON 前现算，回填侧经 kvRowsFromParsed
 *  hints 入参消费。 */
function kvRowsRenameHints(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === '' || row.value !== MCP_VALUE_MASK) continue;
    if (row.sentinelfor !== undefined && row.sentinelfor !== key) out[key] = row.sentinelfor;
  }
  return out;
}

/** 「复制 JSON」（点5）：jsonText 写系统剪贴板；toast 沿用组件内现有栈。 */
async function copyJson(): Promise<void> {
  try {
    await navigator.clipboard.writeText(jsonText.value);
    pushToast('已复制 JSON');
  } catch {
    pushToast('复制失败，请手动全选复制');
  }
}

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
  formTimeoutMs.value = '';
  formEnvRows.value = [emptyKvRow()]; // 对照定稿：环境变量区默认一行空 KV 行
  formHeaderRows.value = [emptyKvRow()];
  jsonRenameHints.value = { env: {}, headers: {} }; // 保存完成收尾清快照（round-002 F1：KV 行已重置，防陈旧映射）
  touchedFields.value = { name: false, command: false, url: false, timeout: false };
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
    formTimeoutMs.value.trim() !== '' ||
    formEnvRows.value.some((r) => r.key !== '' || r.value !== '') ||
    formHeaderRows.value.some((r) => r.key !== '' || r.value !== '')
  );
}

function openAdd(): void {
  dialogMode.value = { kind: 'add' };
  // Esc/取消/面包屑返回均不清表单（关闭不丢已填内容）；仅在上次以保存收尾或表单为空时重置。
  if (!formHasContent()) resetForm();
  openEditor();
}

function openEdit(card: McpCard): void {
  touchedFields.value = { name: false, command: false, url: false, timeout: false }; // 编辑态预填合法值，不继承上次的 touched
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
    formTimeoutMs.value = view.timeoutMs !== undefined ? String(view.timeoutMs) : ''; // 点5：编辑回填自 entry.timeoutMs（无键 → 空=默认）
    formEnvRows.value = view.maskedEnvKeys && view.maskedEnvKeys.length > 0
      ? view.maskedEnvKeys.map((k) => ({ key: k, value: MCP_VALUE_MASK, sentinelfor: k }))
      : [emptyKvRow()];
    formHeaderRows.value = view.maskedHeaderKeys && view.maskedHeaderKeys.length > 0
      ? view.maskedHeaderKeys.map((k) => ({ key: k, value: MCP_VALUE_MASK, sentinelfor: k }))
      : [emptyKvRow()];
    openEditor();
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
  formTimeoutMs.value = stored.timeoutMs !== undefined ? String(stored.timeoutMs) : ''; // 点5：编辑回填自 entry.timeoutMs（无键 → 空=默认）
  // §1.3：值字段回显哨兵（明文不出现在 UI）；sentinelfor 记录哨兵所属已存键。
  formEnvRows.value = Object.keys(stored.env ?? {}).length > 0 ? Object.entries(stored.env ?? {}).map(([k]) => ({ key: k, value: MCP_VALUE_MASK, sentinelfor: k })) : [emptyKvRow()];
  formHeaderRows.value = Object.keys(stored.headers ?? {}).length > 0 ? Object.entries(stored.headers ?? {}).map(([k]) => ({ key: k, value: MCP_VALUE_MASK, sentinelfor: k })) : [emptyKvRow()];
  openEditor();
}

/** 编辑器「取消」/面包屑返回：回列表视图；不清表单（关闭不丢已填内容，重开沿用 openAdd 既有规则）。 */
function closeEditDialog(): void {
  editorView.value = 'list';
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
  const scopedTimeout = timeoutFormValue(); // 点5：空 → 不带 timeoutMs；合法 → 带上（主进程 writer isValidMcpTimeoutMs 同口径写键）
  if (scopedTimeout !== undefined) entry.timeoutMs = scopedTimeout;
  const dir = scope === 'project' ? formProjectDir.value : undefined;
  // 覆盖确认（E0-2）：按目标作用域 snapshot 预查同名；命中 → 非危险确认（可取消）。
  // T1（round-3 P2 陈旧快照覆盖）：预查前先 refresh 新鲜化——编辑器长开期间外部并发写入的
  // 同名条目以保存时刻快照判定，不再被进 Tab 时的陈旧快照静默放行。refresh 自带失败降级
  //（getMcpSnapshot 抛错 → loadError + 快照置 null → 预查走空表分支不抛错）与 disposed/代际
  // 守卫，故无需在此 try/catch；失败降级路径由下方 res.overwrote 兜底告知补位。
  await refresh();
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
    const res = await claude.writeMcpScoped(payload);
    // T1（round-3）兜底告知：预查无同名（hasSameName=false）但 writer 命中现有同名 → 保存期间
    // 外部并发写入被 upsert 覆盖，写已发生，至少提示防零提示；hasSameName=true 时覆盖已经
    // 确认对话框明示，不双报。
    if (res.overwrote && !hasSameName) pushToast('注意：已覆盖保存期间外部写入的同名条目');
    await refresh(); // getMcpSnapshot() 刷新（user/project 清单 + rail 计数）
    pushToast(`已保存「${entry.name}」到${scope === 'user' ? '用户级（~/.claude.json）' : '项目级（.mcp.json）'}`);
    editorView.value = 'list';
    editMode.value = 'form'; // T2（round-3）：翻转挪至保存成功点（JSON 侧取消/失败路径停留 JSON 侧）
    resetForm();
    dialogMode.value = null;
  } catch (e) {
    pushToast(`保存失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

async function saveForm(): Promise<void> {
  const mode = dialogMode.value;
  if (!mode || saving.value) return;
  if (editMode.value === 'json') {
    // JSON 模式保存（点5）：先解析回填（失败 → jsonError 红条、停留 JSON 侧）→ 新建态名称
    // 正则/重名校验复用现有 nameError 文案（回填后的表单值直接走现有校验链；失败停留 JSON
    // 侧红条）→ nameError 外的 formValid 项（command/url/timeout/project 目录）失败同样停留
    // JSON 侧红条（验收 R2：不翻回表单侧、不置 submitAttempted）→ 全过后拨回表单侧，走下方
    // 既有保存链（managedSave / writeScoped + 覆盖确认 + toast）。
    if (jsonParsing.value) return;
    const parsed = await parseJsonDraft();
    if (!parsed) return;
    if (nameError.value !== '') {
      jsonError.value = nameError.value;
      return;
    }
    if (!formValid.value) {
      // 停留契约（验收 R2）：JSON 模式保存校验失败 → 红条 + 停留 JSON 侧 + 输入保留；
      // 不翻回表单侧、不置 submitAttempted（「点亮全部错误」只属表单模式路径）。
      const firstMsg = [nameError.value, commandError.value, urlError.value, timeoutError.value].find((m) => m !== '')
        ?? (formLocation.value === 'project' && formProjectDir.value === '' ? '未选择项目目录' : '校验未通过');
      jsonError.value = `表单校验未通过：${firstMsg}`;
      return;
    }
    // T2（round-3）：此处原「翻回表单侧」语句已删——翻转先于落盘链会让覆盖确认「取消」
    // /保存失败路径残留表单侧（JSON 视图丢失）。翻转挪至保存成功点：saveScopedForm 成功块
    // 与下方 managed 成功块各置（保存失败/取消路径停留 JSON 侧，与 R2 停留契约同口径）。
  }
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
    // 双保险（验收 R1）：编辑 user/project 条目另存为管理库（stored===undefined）且管理库已有
    // 同名条目 → 主进程 sanitize 会静默丢弃新条目并谎报成功，UI 层拦截。
    if (mode.kind === 'edit' && stored === undefined && managedServers.value.some((s) => s.name === formName.value.trim())) {
      pushToast('保存失败：与现有服务器重名（管理库内名称唯一）');
      return;
    }
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
      const updatedTimeout = timeoutFormValue(); // 点5：空 → 不带 timeoutMs；合法 → 带上（主进程 sanitize 透传）
      if (updatedTimeout !== undefined) updated.timeoutMs = updatedTimeout;
      const next = managedServers.value.map((s) => (s.id === stored.id ? updated : s));
      if (await persistManaged(next, `已更新「${updated.name}」`)) {
        editorView.value = 'list';
        editMode.value = 'form'; // T2（round-3）：editMode 翻转挪至保存成功点（失败/取消停留原侧）
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
      const createdTimeout = timeoutFormValue(); // 点5：空 → 不带 timeoutMs；合法 → 带上（主进程 sanitize 透传）
      if (createdTimeout !== undefined) created.timeoutMs = createdTimeout;
      const next = [...managedServers.value, created];
      if (await persistManaged(next, `已添加「${created.name}」`)) {
        editorView.value = 'list';
        editMode.value = 'form'; // T2（round-3）：editMode 翻转挪至保存成功点（失败/取消停留原侧）
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

/** 编辑器 footer「删除」用：按当前编辑态重建卡片视图（handleDelete 仅消费 key/name/transport；
 *  managed 编辑态按 id 对位管理库条目；user/project 编辑态 dialogMode.id 即 card.key——见 openEdit）。 */
function currentEditCard(): McpCard | null {
  const mode = dialogMode.value;
  if (mode?.kind !== 'edit') return null;
  if (formLocation.value === 'managed') {
    const stored = managedServers.value.find((s) => s.id === mode.id);
    return stored ? managedCardOf(stored) : null;
  }
  return { key: mode.id, name: formName.value, transport: formTransport.value, display: '', description: '' };
}

/** T3（round-3）编辑器删除可用性门控：条目「原作用域」按 dialogMode.id 前缀判定
 *  （user:/project: 前缀 → user/project；无前缀 → managed），与 formLocation（保存位置）不一致
 *  → 删除语义已分裂（正向 currentEditCard 按 id 查不到条目静默、反向误删原作用域原条目），
 *  footer 删除钮禁用。新建态（mode 非 edit）删除钮本就 v-if 隐藏，恒 false。 */
const deleteBlockedInEditor = computed<boolean>(() => {
  const mode = dialogMode.value;
  if (mode?.kind !== 'edit') return false;
  const originScope: 'user' | 'project' | 'managed' = mode.id.startsWith('user:')
    ? 'user'
    : mode.id.startsWith('project:')
      ? 'project'
      : 'managed';
  return originScope !== formLocation.value;
});

/** 编辑器内删除（方案 A 点4 footer）：复用卡片删除链（确认框/写入/刷新/toast 全不变）；
 *  仅删除真正生效（确认框取消或写入失败时条目仍在当前作用域视图 → 留在编辑器）才回列表。
 *  T3（round-3）：前置「条目原作用域 ≠ formLocation」判定 → 同款 toast 拦截（替换静默）；
 *  一致但 currentEditCard 为 null（如条目已被外部删除）→ 同款 toast 替换原静默 return。 */
async function deleteFromEditor(): Promise<void> {
  const mode = dialogMode.value;
  if (mode?.kind !== 'edit' || saving.value) return;
  const originScope: 'user' | 'project' | 'managed' = mode.id.startsWith('user:')
    ? 'user'
    : mode.id.startsWith('project:')
      ? 'project'
      : 'managed';
  const card = originScope === formLocation.value ? currentEditCard() : null;
  if (!card) {
    pushToast('保存位置已切换，删除不可用：请先保存或返回列表');
    return;
  }
  await handleDelete(card);
  if (disposed || editorView.value !== 'edit') return;
  if (!scopeCards.value.some((c) => c.key === card.key)) {
    editorView.value = 'list';
    resetForm();
    dialogMode.value = null;
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
const importPreview = ref<Awaited<ReturnType<typeof analyzeImportText>> | null>(null);
const importing = ref(false);
// p3-R3 逐条勾选：name → 是否勾选（预览条目键唯一：JSON map 键不重复）。skip 行也置 true
// （UI disabled 不可交互，计数恒排除）；生命周期与预览同源——每次解析成功（含重开弹窗的
// 重新对齐）重置为默认全选，导入成功清空；取消关闭保留（与「关闭不丢内容」同拍）。
const importChecked = ref<Record<string, boolean>>({});

function openImport(): void {
  showImportDialog.value = true;
  // 关闭不丢内容：重开时若文本已在（上次未完成导入），预览与文本重新对齐。
  // （点6：解析走主进程桥为异步，openImport 为同步函数——fire-and-forget，预览态回填由
  // parseImportPreview 自身完成；确认导入侧本就重新解析，陈旧预览不致误导入。）
  if (importText.value.trim() !== '') void parseImportPreview();
  else {
    importPreview.value = null;
    importChecked.value = {};
  }
}

function closeImportDialog(): void {
  showImportDialog.value = false;
}

async function parseImportPreview(): Promise<void> {
  const result = await analyzeImportText(importText.value, managedServers.value);
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
    const fresh = await analyzeImportText(importText.value, managedServers.value);
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
        // T4（round-3）：入库前过滤哨兵值键——「复制 JSON」产出的哨兵文本（值 = MCP_VALUE_MASK）
        // 经导入弹窗回导时不得作为字面密钥静默入库（否则会话注入错误凭据、运行时认证失败难排查）。
        // 过滤后为空对象则不设 env/headers（与原「空则不带键」口径一致）。
        const cleanEnv = Object.fromEntries(Object.entries(parsed.env ?? {}).filter(([, v]) => v !== MCP_VALUE_MASK));
        const cleanHeaders = Object.fromEntries(Object.entries(parsed.headers ?? {}).filter(([, v]) => v !== MCP_VALUE_MASK));
        if (parsed.transport === 'stdio') {
          item.command = parsed.command ?? '';
          if (parsed.args && parsed.args.length > 0) item.args = parsed.args;
          if (Object.keys(cleanEnv).length > 0) item.env = cleanEnv;
        } else {
          item.url = parsed.url ?? '';
          if (Object.keys(cleanHeaders).length > 0) item.headers = cleanHeaders;
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

// ── 导入弹窗壳（计划 2026-10-14 §2 P8）：useDialogShell——标题栏拖动 / 8 向缩放 /
// 视口重钳 / 双击复位居中；无 initialSize（打开时测卡片自然尺寸，rect null 帧回退 CSS 静态居中）。
// 方案 A 点4：编辑器改为页内视图，编辑弹窗壳（卡片 ref / shell 实例 + 8 向缩放）整体移除；
// 仅导入弹窗保留壳层接线（纯壳层，导入业务逻辑零触碰）。
const importCardRef = ref<HTMLElement | null>(null);
const importShell = useDialogShell(showImportDialog, importCardRef, { minW: 480, minH: 360 });
const importShellStyle = importShell.style;

// ── 导入弹窗 Esc（关闭不丢已填内容）───────────────────────────────────────────
// r3-F7/R6：接入 use-esc-stack 全局层级裁决——导入弹窗在场注册 mcpDialog 层（Esc 层级 1199，
// 低于交互层 1200：与待决交互弹窗并存时 Esc 只关交互层；.mcp-mask CSS z-index 仍为 1200，
// Esc 裁决层级与 CSS z-index 解耦），更高层（diff/灯箱等）在场时 isTopmost 为假、本组件让位，
// 一次 Esc 只关视觉最上层；关闭/卸载释放。方案 A 点4：编辑器已页内化，其 Esc 由组件根
// @keydown.escape 就地处理（onEditorEsc，守卫 editorView==='edit'），不再注册本链。
let escBound = false;
let escLayer: EscLayerHandle | null = null;
function onGlobalKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (escLayer && !escLayer.isTopmost()) return;
  if (showImportDialog.value) closeImportDialog();
}

watch(showImportDialog, (imp) => {
  if (imp && !escBound) {
    window.addEventListener('keydown', onGlobalKey);
    escBound = true;
  } else if (!imp && escBound) {
    window.removeEventListener('keydown', onGlobalKey);
    escBound = false;
  }
  // 层注册与监听绑定同步：弹窗在场即注册（去重防重复 push），关闭即释放（release 幂等）。
  if (imp && !escLayer) escLayer = pushEscLayer(ESC_LAYER_PRIORITY.mcpDialog);
  else if (!imp && escLayer) {
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
  <div class="mcp-md-body" data-testid="mcp-manage-section" @keydown.escape="onEditorEsc">
    <!-- 左栏：作用域清单（对照定稿 rail：管理/用户级 + 项目目录段） -->
    <nav class="mcp-rail" aria-label="MCP 作用域">
      <div class="mcp-rail__head"><span>作用域</span><span>3 类</span></div>

      <button
        type="button"
        :class="['mcp-rail-item', { 'mcp-rail-item--active': activeScope.kind === 'managed' }]"
        :aria-current="activeScope.kind === 'managed' ? 'true' : 'false'"
        @click="switchScope({ kind: 'managed' })"
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
        @click="switchScope({ kind: 'user' })"
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
        @click="switchScope({ kind: 'project', path: dir.path })"
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

    <!-- 右侧主区（方案 A 点4 双视图：列表 ⇄ 页内编辑器，v-show 常挂切换——表单 state 常驻
         防重开丢草稿；rail 常驻不受切换影响） -->
    <section class="mcp-main">
      <!-- 列表视图（原有标题行+工具栏+分组卡片列整体搬入） -->
      <div v-show="editorView === 'list'" class="mcp-listview">
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
          <!-- 方案 A 卡片列表（round5-final-a-interactive.html .mxA-card）：按传输类型分组（组头计数），
               条目=独立卡片：36px 图标块+右下状态点 / 中列（名称+中性传输标签+禁用徽章+工具·状态行 /
               命令行 / 描述或错误行）/ 右列操作+开关（原左状态色条/每卡作用域徽章/实底传输徽章删除） -->
          <div class="mcp-groups">
            <section v-for="grp in cardGroups" :key="grp.id" class="grp" :aria-label="grp.label">
              <div class="grp__head">{{ grp.label }}<span class="cnt">{{ grp.cards.length }} 台</span></div>
              <!-- 整卡点击=打开编辑（方案 A 点4）；卡内开关/操作 icon 钮/⚠ 气泡钮均 @click.stop
                   防误触进编辑（原型同款交互约束） -->
              <div v-for="card in grp.cards" :key="card.key" :class="['grp__row', rowStateClass(card)]" @click="openEdit(card)">
                <!-- 图标块：stdio→terminal / http·sse→globe（内联 SVG，stroke=currentColor 惯例）；
                     右下状态点四色：ok 绿 / fail 红 / busy 黄 / 其余（disabled·sse 中性·未连接·未探测）灰 -->
                <div class="row__ic">
                  <svg v-if="card.transport === 'stdio'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                  <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                  <span
                    :class="['row__st', `row__st--${connModeOf(card) === 'probe' && connStateOf(card) !== 'none' ? connStateOf(card) : 'off'}`]"
                    :title="connStateOf(card) === 'ok' ? '已连接' : connStateOf(card) === 'fail' ? '连接失败' : connStateOf(card) === 'busy' ? '测试中' : '未探测'"
                  ></span>
                </div>
                <div class="row__mid">
                  <div class="row__r1">
                    <span class="row__name">{{ card.name }}</span>
                    <!-- 传输中性标签：mono 小写描边 chip（原型 .mxA-t），取代实底三色徽章 -->
                    <span class="row__tt">{{ card.transport }}</span>
                    <span v-if="!isEnabled(card)" class="mcp-off-badge">已禁用</span>
                    <!-- 工具数·状态合并行（判定沿用 connModeOf/connStateOf/connTextOf/toolsTextOf，仅换呈现）：
                         ok=`N 个工具 · 已连接`；busy=spinner+`测试中…`；fail=`连接失败`；
                         sse=`未探测 · 会话内自动协商`；禁用=`已禁用 · 未探测`；其余=`未连接` -->
                    <span v-if="connModeOf(card) === 'disabled'" class="row__stat">已禁用 · 未探测</span>
                    <span v-else-if="connModeOf(card) === 'sse'" class="row__stat">未探测 · 会话内自动协商</span>
                    <span v-else-if="connStateOf(card) === 'busy'" class="row__stat"><span class="row__spin" aria-hidden="true"></span>{{ connTextOf(card) }}</span>
                    <span v-else-if="connStateOf(card) === 'ok'" class="row__stat row__stat--ok">{{ toolsTextOf(card) }} · {{ connTextOf(card) }}</span>
                    <span v-else-if="connStateOf(card) === 'fail'" class="row__stat row__stat--fail">{{ connTextOf(card) }}</span>
                    <span v-else class="row__stat">{{ connTextOf(card) }}</span>
                  </div>
                  <div class="row__cmd">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                    <span><b>{{ card.display.split(' ')[0] }}</b>{{ card.display.slice(card.display.split(' ')[0].length) }}</span>
                  </div>
                  <div class="row__r3">
                    <!-- fail 态：错误行（红+截断）+ 现有 ⚠ 自绘气泡看全文（交互不变）；其余：描述单行省略 -->
                    <template v-if="connModeOf(card) === 'probe' && connStateOf(card) === 'fail' && probeReportOf(card)?.error">
                      <span class="row__errtext">{{ probeReportOf(card)?.error }}</span>
                      <!-- 契约1：fail 态 ⚠（探活错误全文收进自绘深色气泡；hover 与键盘 focus 双触发；
                           仅 probe 形态渲染——禁用卡/sse 卡不显示）。 -->
                      <span class="tip">
                        <button type="button" class="warnico" aria-label="查看探活错误全文" @click.stop>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path></svg>
                        </button>
                        <span class="bubble" role="tooltip"><b>探活错误</b><code>{{ probeReportOf(card)?.error }}</code></span>
                      </span>
                    </template>
                    <span v-else-if="card.description" class="row__desc" :title="card.description">{{ card.description }}</span>
                  </div>
                </div>
                <div class="row__acts">
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
                      @click.stop="handleProbe(card)"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                    </button>
                    <button class="mcp-iconbtn" type="button" :aria-label="`编辑 ${card.name}`" title="编辑" @click.stop="openEdit(card)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                    </button>
                    <button class="mcp-iconbtn mcp-iconbtn--danger" type="button" :aria-label="`删除 ${card.name}`" title="删除" @click.stop="handleDelete(card)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  </template>
                  <!-- P8：user/project 卡开放「编辑/删除」（同管理库同款按钮；写入对应配置文件）；
                       「测试连接」仍仅管理库渲染（探活器只认管理库明文条目，E0-4）。 -->
                  <template v-else>
                    <button class="mcp-iconbtn" type="button" :aria-label="`编辑 ${card.name}`" title="编辑" @click.stop="openEdit(card)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                    </button>
                    <button class="mcp-iconbtn mcp-iconbtn--danger" type="button" :aria-label="`删除 ${card.name}`" title="删除" @click.stop="handleDelete(card)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  </template>
                  <input
                    type="checkbox"
                    class="mcp-switch"
                    :checked="isEnabled(card)"
                    :aria-label="`${isEnabled(card) ? '禁用' : '启用'} ${card.name}`"
                    @click.stop
                    @change="handleToggle(card, $event)"
                  />
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
      </div>

      <!-- 编辑器视图（方案 A 点4：页内化，对照原型 .mxA-crumb/.mxA-ehead/.mxA-seg/.mxA-eform；
           tabindex="-1" + openEditor 落焦，保证根元素 @keydown.escape 可收到 Esc 冒泡） -->
      <div v-show="editorView === 'edit'" ref="editorRef" class="mcp-editor" tabindex="-1">
        <!-- 面包屑行：← 返回列表 / {name} · 编辑 或 新建服务器 -->
        <div class="mcp-editor__crumb">
          <button type="button" class="mcp-editor__back" @click="closeEditDialog">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            返回列表
          </button>
          <span aria-hidden="true">/</span>
          <template v-if="isEditMode"><b class="mcp-editor__crumbname">{{ formName }}</b><span> · 编辑</span></template>
          <b v-else class="mcp-editor__crumbname">新建服务器</b>
        </div>
        <!-- 标题行 + 右侧「表单 | JSON」分段胶囊（点5 实装切换；本点 JSON 项禁用占位） -->
        <div class="mcp-editor__head">
          <div class="mcp-editor__headtext">
            <h3 class="mcp-editor__title">{{ isEditMode ? '编辑 MCP 服务器' : '新建 MCP 服务器' }}</h3>
            <p class="mcp-editor__sub">{{ editorSubline }}</p>
          </div>
          <!-- 「表单 | JSON」分段胶囊（点5 实装切换：切 JSON 序列化 / 切表单解析回填；
               jsonParsing 在飞 / saving 落盘在途时两项禁用，与 switchEditMode 守卫一致化） -->
          <div class="mcp-editor__seg" role="tablist" aria-label="编辑模式">
            <button
              type="button"
              :class="['mcp-editor__segbtn', { 'mcp-editor__segbtn--on': editMode === 'form' }]"
              role="tab"
              :aria-selected="editMode === 'form'"
              :disabled="jsonParsing || saving"
              @click="switchEditMode('form')"
            >表单</button>
            <button
              type="button"
              :class="['mcp-editor__segbtn', { 'mcp-editor__segbtn--on': editMode === 'json' }]"
              role="tab"
              :aria-selected="editMode === 'json'"
              :disabled="jsonParsing || saving"
              @click="switchEditMode('json')"
            >JSON</button>
          </div>
        </div>
        <!-- 表单体（.mcp-form-grid 两列网格/KV 行/label/hint/校验文案自弹窗原样搬入，字段结构与类名不改）
             + footer（删除[仅编辑态]/取消/保存并启用）——点5 双模式：表单栅格与 JSON 视图 v-show 按
             editMode 切换（v-show 常挂，JSON 往返不丢表单 DOM 态），footer 按模式分化（JSON 侧为
             注释行+复制 JSON+取消+保存，对照原型 .mxA-eft JSON 形） -->
        <div class="mcp-editor__form">
          <div v-show="editMode === 'form'" class="mcp-form-grid">
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
            <!-- 超时（毫秒）（点5，三作用域共用）：空 = 默认（提交条目不带 timeoutMs）；
                 blur/touched 校验非空时须为 1..120000 整数，错误呈现沿用 command/url 的 hint--danger 形态 -->
            <label class="mcp-ffield">
              <span class="mcp-ffield__label">超时（毫秒）</span>
              <input
                v-model="formTimeoutMs"
                :class="['mcp-input', { 'mcp-input--invalid': timeoutErrorShown !== '' }]"
                type="number"
                placeholder="10000"
                aria-label="超时（毫秒）"
                @blur="touchedFields.timeout = true"
              />
              <span v-if="timeoutErrorShown !== ''" class="mcp-ffield__hint mcp-ffield__hint--danger">{{ timeoutErrorShown }}</span>
            </label>
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
                <span class="mcp-ffield__hint hintrow">已存值回显为 {{ MCP_VALUE_MASK }}，保持不变沿用原值
                  <span class="tip tip--up">
                    <button type="button" class="mcp-info-btn" aria-label="脱敏回显规则说明">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                    </button>
                    <span class="bubble" role="tooltip"><b>脱敏回显规则</b><span>编辑时已存值回显为 {{ MCP_VALUE_MASK }}；保持不变则沿用已存原值，不会重复保存</span></span>
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
                <span class="mcp-ffield__hint hintrow">已存值回显为 {{ MCP_VALUE_MASK }}，保持不变沿用原值
                  <span class="tip tip--up">
                    <button type="button" class="mcp-info-btn" aria-label="脱敏回显规则说明">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                    </button>
                    <span class="bubble" role="tooltip"><b>脱敏回显规则</b><span>编辑时已存值回显为 {{ MCP_VALUE_MASK }}；保持不变则沿用已存原值，不会重复保存</span></span>
                  </span>
                </span>
              </div>
            </template>
          </div>
          <!-- JSON 模式视图（点5）：黄条提示（解析失败切 fail 红条展示 jsonError）+ mono textarea
               （rows=14、spellcheck=false、宽度撑满表单区）；复制入口在下方 JSON footer。
               round-002 F3：两条前置 14px 状态图标（黄条 info（=lucide info 形）/ 红条 lucide x 裸叉无圆圈，
               stroke=currentColor 随条色，CSS 定尺见 .mcp-jsonbar svg；对齐原型 .mxA-jsonbar width=14）。 -->
          <div v-show="editMode === 'json'" class="mcp-editor__jsonpane">
            <div v-if="jsonError !== ''" class="mcp-jsonbar mcp-jsonbar--fail" role="alert"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>{{ jsonError }}</div>
            <div v-else class="mcp-jsonbar" role="status"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>由当前表单配置实时生成，可直接编辑；保存时解析回写。支持 {"名称":{…}} 与 {"mcpServers":{…}}，一次一台。</div>
            <textarea
              v-model="jsonText"
              class="mcp-jsonarea"
              rows="14"
              spellcheck="false"
              aria-label="服务器 JSON 配置"
            ></textarea>
          </div>
          <!-- 表单模式 footer：删除（仅编辑态）/取消/保存并启用（disabled 条件沿用 !formValid || saving） -->
          <div v-if="editMode === 'form'" class="mcp-editor__foot">
            <button v-if="isEditMode" class="mcp-editor__del" type="button" :disabled="saving || deleteBlockedInEditor" @click="deleteFromEditor">删除</button>
            <span class="mcp-editor__spacer" aria-hidden="true"></span>
            <button class="mcp-btn" type="button" @click="closeEditDialog">取消</button>
            <button class="mcp-btn mcp-btn--primary" type="button" :disabled="!formValid || saving" @click="saveForm">{{ saving ? '保存中…' : '保存并启用' }}</button>
          </div>
          <!-- JSON 模式 footer（点5，对照原型 .mxA-eft JSON 形）：注释行（11px muted）/spacer/复制 JSON/
               取消/保存——保存恒可点（点击时先解析回填校验，失败红条停留），仅 jsonParsing/saving 在飞禁用；
               删除入口在表单侧与列表卡片提供（JSON 侧对照原型不设删除） -->
          <div v-else class="mcp-editor__foot">
            <span class="mcp-jsonnote">已存密钥以 {{ MCP_VALUE_MASK }} 脱敏显示；保持不变则沿用原值</span>
            <span class="mcp-editor__spacer" aria-hidden="true"></span>
            <button class="mcp-btn" type="button" :disabled="jsonParsing" @click="copyJson">复制 JSON</button>
            <button class="mcp-btn" type="button" @click="closeEditDialog">取消</button>
            <button class="mcp-btn mcp-btn--primary" type="button" :disabled="saving || jsonParsing" @click="saveForm">{{ saving ? '保存中…' : '保存并启用' }}</button>
          </div>
        </div>
      </div>
    </section>

    <!-- 弹窗（Teleport 到 body）：方案 A 点4 起仅导入 JSON 弹窗仍走弹窗壳（编辑器已页内化） -->
    <Teleport to="body">
      <!-- 导入 JSON 弹窗（textarea + 解析预览 + 同名跳过标记；导入目标=Claude Link 管理） -->
      <div v-if="showImportDialog" class="mcp-mask" role="presentation" @click.self="closeImportDialog">
        <div ref="importCardRef" class="mcp-import-modal" role="dialog" aria-modal="true" aria-labelledby="mcp-import-title" :style="importShellStyle">
          <div class="mcp-import-modal__head" @pointerdown="importShell.beginDrag" @dblclick="importShell.resetToCenter">
            <h3 id="mcp-import-title" class="mcp-import-modal__title">导入 JSON</h3>
            <button class="mcp-import-modal__close" type="button" aria-label="关闭弹窗" @click="closeImportDialog">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="mcp-import-modal__body">
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
                    <!-- 卡片化收口：徽章改中性传输标签 row__tt + imp__ok「将导入」标（实底 tchip/scope-badge 族删除，L1 零出现钉） -->
                    <span class="row__tt">{{ e.transport.toUpperCase() }}</span>
                    <span v-if="e.skip" class="mcp-off-badge">{{ e.skipReason }}</span>
                    <span v-else class="mcp-imp__ok">将导入</span>
                  </li>
                </ul>
              </template>
            </div>
          </div>
          <div class="mcp-import-modal__foot">
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

/* 列表视图包装层（方案 A 点4 双视图之一，v-show 常挂）：承接 .mcp-main 的纵向 flex 语义，
   __head/__scroll 与页内化前布局零变化。 */
.mcp-listview {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ── 编辑器页内视图（方案 A 点4，对照原型 .mxA-crumb/.mxA-ehead/.mxA-seg/.mxA-eform）── */
.mcp-editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem 1.375rem 1.5rem; /* 原型 #mcpA-edit 16/22/24 */
  outline: none;
}

.mcp-editor::-webkit-scrollbar {
  width: 8px;
}

.mcp-editor::-webkit-scrollbar-thumb {
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--color-text-muted) 28%, transparent);
}

/* 面包屑行（.mxA-crumb）：← 返回列表 / {name} · 编辑 或 新建服务器 */
.mcp-editor__crumb {
  display: flex;
  align-items: center;
  gap: 0.4375rem;
  font-size: 0.78125rem;
  color: var(--color-text-muted);
  margin-bottom: 0.75rem;
}

.mcp-editor__back {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  border: 0;
  background: transparent;
  color: var(--color-accent-strong);
  font-size: 0.78125rem;
  cursor: pointer;
  padding: 0;
  font-family: inherit;
}

.mcp-editor__back:hover {
  text-decoration: underline;
}

.mcp-editor__back svg {
  width: 0.875rem;
  height: 0.875rem;
}

.mcp-editor__crumbname {
  color: var(--color-text);
}

/* 标题行（.mxA-ehead）：左标题+副文，右「表单 | JSON」分段胶囊 */
.mcp-editor__head {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.mcp-editor__headtext {
  flex: 1;
  min-width: 0;
}

.mcp-editor__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
}

.mcp-editor__sub {
  margin: 0.125rem 0 0;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

/* 「表单 | JSON」分段胶囊（.mxA-seg 同值移植：panel 底描边圆角胶囊；激活项 panel-soft 底
   + border + elevation + 600 字重）。点4 仅壳——表单项目标态高亮，JSON 项禁用占位（点5 实装切换）。 */
.mcp-editor__seg {
  display: flex;
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  padding: 0.125rem;
  flex-shrink: 0;
}

.mcp-editor__segbtn {
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: 500;
  padding: 0.25rem 1rem;
  border-radius: var(--radius-pill);
  font-family: inherit;
}

.mcp-editor__segbtn--on {
  background: var(--color-panel-soft);
  color: var(--color-text);
  border-color: var(--color-border);
  box-shadow: var(--elevation-1);
  font-weight: 600;
}

.mcp-editor__segbtn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

/* 表单体容器（.mxA-eform）：页内宽度钳制 50rem */
.mcp-editor__form {
  max-width: 50rem;
}

/* ── JSON 模式（点5，对照原型 .mxA-jsonbar / .mxA-json）────────────────────── */
/* 提示条：warn 10% 底 + warn 35% 描边 + warn-strong 字；解析失败切 fail 红条（--fail 变体同构）。 */
.mcp-jsonbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-radius: var(--radius-sm);
  padding: 0.4375rem 0.75rem;
  font-size: 0.71875rem;
  margin-bottom: 0.625rem;
  background: color-mix(in srgb, var(--color-warn) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-warn) 35%, transparent);
  color: var(--color-warn-strong);
}

/* 前置状态图标（round-002 F3，对齐原型 width=14）：14px 定尺不缩不换行，色随条 currentColor。 */
.mcp-jsonbar svg {
  width: 0.875rem;
  height: 0.875rem;
  flex: none;
}

.mcp-jsonbar--fail {
  background: color-mix(in srgb, var(--color-fail) 10%, transparent);
  border-color: color-mix(in srgb, var(--color-fail) 35%, transparent);
  color: var(--color-fail-strong);
}

/* mono textarea：等宽字体、宽度撑满表单区、rows=14 起步、可纵向拉伸。 */
.mcp-jsonarea {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.7;
  display: block;
  width: 100%;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.875rem 1rem;
  color: var(--color-text);
  white-space: pre;
  resize: vertical;
  outline: none;
}

.mcp-jsonarea:focus {
  border-color: var(--color-accent);
}

/* 底部注释行（11px muted）。 */
.mcp-jsonnote {
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}

/* footer（.mxA-eft）：删除（link 红，仅编辑态）/ spacer / 取消 / 保存并启用 */
.mcp-editor__foot {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
  align-items: center;
}

.mcp-editor__spacer {
  flex: 1;
}

.mcp-editor__del {
  border: 0;
  background: transparent;
  color: var(--color-fail-strong);
  text-decoration: underline;
  font-size: 0.78125rem;
  cursor: pointer;
  padding: 0;
  font-family: inherit;
}

.mcp-editor__del:hover:not(:disabled) {
  color: var(--color-fail);
}

.mcp-editor__del:disabled {
  opacity: 0.55;
  cursor: not-allowed;
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

/* ── 滚动区 + 方案 A 卡片列表（round5-final-a-interactive.html .mxA-card）：按传输分组
   （组头计数），条目=独立卡片（图标块+状态点 / 中列三行 / 右列操作+开关），组容器退为纯排版 ── */
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
  gap: 0;
  max-width: 52rem;
}

/* 组容器退为纯排版节（卡片自带 panel-soft 底+描边，组不再套整体面板盒）；组间距 24px（原型节奏）。 */
.grp {
  min-width: 0;
}

.grp + .grp {
  margin-top: 1.5rem;
}

.grp__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 0.125rem;
  margin-bottom: 0.625rem;
  font-size: 0.71875rem;
  font-weight: 600;
  color: var(--color-text-muted);
  letter-spacing: 0.03em;
}

.grp__head .cnt {
  margin-left: auto;
  font-size: 0.6875rem;
  font-weight: 400;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

/* 条目卡片（.mxA-card 同值移植）：grid [auto 1fr auto]；hover 边框加深+贴面阴影；禁用降透明。 */
.grp__row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 0.8125rem;
  align-items: center;
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.8125rem 0.9375rem;
  margin-bottom: 0.5625rem;
  cursor: pointer;
  transition:
    border-color 0.12s var(--ease-out),
    box-shadow 0.12s var(--ease-out);
}

.grp__row:hover {
  border-color: var(--color-border-strong);
  box-shadow: var(--elevation-1);
}

/* 禁用卡降透明（rowStateClass 仍产出 grp__row--off/--disabled 类名，仅 --off 保留视觉钩子；
   hover 不回升透明——对照原型 .mxA-card.dis）。 */
.grp__row--off {
  opacity: 0.6;
}

/* ── 图标块 + 右下状态点（.mxA-ic/.st）：36px 圆角块 panel 底描边，11px 状态点四色 ── */
.row__ic {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 0.625rem;
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.row__ic svg {
  width: 1rem;
  height: 1rem;
}

.row__st {
  position: absolute;
  right: -0.1875rem;
  bottom: -0.1875rem;
  width: 0.6875rem;
  height: 0.6875rem;
  border-radius: 50%;
  border: 2px solid var(--color-panel-soft);
}

.row__st--ok {
  background: var(--color-success);
}

.row__st--fail {
  background: var(--color-fail);
}

.row__st--busy {
  background: var(--color-warn);
}

.row__st--off {
  background: var(--color-text-muted);
}

/* ── 中列（.mxA-cmid）：r1 名称行 / 命令行 / r3 描述或错误行 ───────────────── */
.row__mid {
  min-width: 0;
}

.row__r1 {
  display: flex;
  align-items: center;
  gap: 0.5625rem;
  flex-wrap: wrap;
  min-width: 0;
}

.row__name {
  font-size: 0.875rem;
  font-weight: 600;
  font-family: var(--font-mono);
  letter-spacing: -0.01em;
  white-space: nowrap;
}

/* 传输中性标签（.mxA-t）：mono 10.5px 小写描边 chip（panel 底/border/muted 字）。 */
.row__tt {
  display: inline-flex;
  align-items: center;
  padding: 0.0625rem 0.375rem;
  border-radius: var(--radius-xs);
  font-family: var(--font-mono);
  font-size: 0.65625rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

/* 工具数·状态合并行（.mxA-toolschip）：11px 弱化文本，ok 绿弱字 / fail 红弱字。 */
.row__stat {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.row__stat--ok {
  color: var(--color-success-strong);
}

.row__stat--fail {
  color: var(--color-fail-strong);
}

.row__spin {
  /* busy 前置 spinner（.spin）：CSS 旋转动画；prefers-reduced-motion 下停用。 */
  width: 0.75rem;
  height: 0.75rem;
  border-radius: 50%;
  border: 2px solid var(--color-warn);
  border-top-color: transparent;
  animation: mcp-spin-rot 0.7s linear infinite;
  display: inline-block;
  flex-shrink: 0;
}

@keyframes mcp-spin-rot {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .row__spin {
    animation: none;
  }
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

/* 命令行 / url（沿用既有结构与类名：terminal 小图标 + 首词加重 + 截断省略）。 */
.row__cmd {
  display: flex;
  align-items: center;
  gap: 0.3125rem;
  margin-top: 0.25rem;
  font-family: var(--font-mono);
  font-size: 0.71875rem;
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

/* 行3：成功态=描述（11px muted 单行省略）| fail 态=错误行（红+截断，全文走 ⚠ 自绘气泡）。 */
.row__r3 {
  display: flex;
  align-items: center;
  gap: 0.4375rem;
  min-width: 0;
  margin-top: 0.125rem;
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

.row__errtext {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  color: var(--color-fail-strong);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 右列操作（.mxA-cright）：icon 钮 + 开关（沿用 .mcp-iconbtn/.mcp-switch 既有形态）。 */
.row__acts {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.row__acts .mcp-switch {
  margin-left: 0.375rem;
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

/* ── 空态 / note（方案 A：统一虚线盒 .mxA-empty；文案沿用既有三态互斥原文）── */
.mcp-empty {
  border: 1.5px dashed var(--color-border);
  border-radius: var(--radius-md);
  padding: 2.125rem;
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

/* ── 导入弹窗（定稿 mask/import-modal/form/seg/select/kvrow 同值移植，mcp- 前缀；
   方案 A 点4 起仅导入 JSON 弹窗仍走弹窗壳，编辑器已页内化）────── */
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

.mcp-import-modal {
  position: absolute; /* shell rect 绑定后由 :style 定位；未测量帧（rect null）无 inset，静态位置回退遮罩 flex 居中（P8） */
  width: min(35rem, 94vw);
  max-height: min(44rem, 86vh);
  display: flex;
  flex-direction: column;
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  border-radius: 1rem;
  box-shadow: var(--elevation-3);
  animation: mcp-import-modal-in var(--duration-slow) var(--ease-spring);
}

@keyframes mcp-import-modal-in {
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
  .mcp-import-modal {
    animation: none;
  }
}

.mcp-import-modal__head {
  display: flex;
  align-items: center;
  padding: 1rem 1.25rem 0.875rem;
  border-bottom: 1px solid var(--color-border);
  cursor: move; /* 标题栏拖动（P8）；head 内关闭按钮为 button，shell 忽略规则自动豁免 */
  touch-action: none;
}

.mcp-import-modal__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
}

.mcp-import-modal__close {
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

.mcp-import-modal__close:hover {
  color: var(--color-text);
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
}

.mcp-import-modal__close svg {
  width: 1rem;
  height: 1rem;
}

.mcp-import-modal__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem 1.25rem;
}

.mcp-import-modal__body::-webkit-scrollbar {
  width: 8px;
}

.mcp-import-modal__body::-webkit-scrollbar-thumb {
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--color-text-muted) 28%, transparent);
}

.mcp-import-modal__foot {
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

/* 导入预览（解析结果清单；徽章=中性传输标签 .row__tt + off-badge + imp__ok「将导入」标）。 */
.mcp-imp {
  margin-top: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

/* 「将导入」标（原每卡作用域徽章位）：accent 弱底描边——卡片化删除实底徽章族后的中性形态。 */
.mcp-imp__ok {
  display: inline-flex;
  align-items: center;
  padding: 0.0625rem 0.375rem;
  border-radius: var(--radius-xs);
  font-size: 0.5625rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-accent) 35%, transparent);
  color: var(--color-accent-strong);
  flex-shrink: 0;
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
