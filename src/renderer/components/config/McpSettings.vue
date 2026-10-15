<script setup lang="ts">
// McpSettings.vue — 设置页 MCP tab 内容（计划 §2 P7：p7a UI 骨架 + p7b 弹窗/CRUD/导入/探活接线）。
// 视觉唯一基准：docs/prototypes/mcp-tab/round3-g13-hybrid.html（G13 融合稿）逐区块移植——
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
// 一期边界（P8 前）：添加/编辑弹窗「保存位置」仅 Claude Link 管理可真正写入，用户级/项目级
// 段位呈现但选即提示（toast + inline hint，交互不死锁可切回）；导入 JSON 在渲染层本地归一
//（normalizeImportEntry 与主进程 normalizeMcpEntry 规则同步，P8 改走主进程统一解析）。
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
import type { McpManagedSaveEntry, McpProbeReport, McpProjectDirView, McpSnapshot } from '../../../preload/api';

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
  if (state === 'fail') return '0 个工具';
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
    // 单探测 IPC 自身失败也以 fail 报告呈现（错误条可见），不静默。
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
  if (activeScope.value.kind === 'user') return '来自用户级 Claude Code 配置 · 只读展示，仅可启停';
  const dir = activeProjectDir.value;
  if (!dir) return '';
  return `${dir.sessionCount} 个会话在使用 · ${dir.isDefault ? '默认工作区' : '最近工作区'} · 只读展示，仅可启停`;
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
 * 主进程模块，故复制；P8 导入改走主进程统一解析时删除本副本。规则（逐条同步）：
 *   - rawCfg 非普通对象 → null；
 *   - transport：显式 type 优先（'stdio'→stdio；'http'|'streamable-http'→http；'sse'→sse）；
 *     缺失/不可识别 → command→stdio；否则 url（pathname 以 /sse 结尾→sse 否则 http）；两无线索 → null；
 *   - 字段互斥归一：stdio 只留 command/args/env（args 非全字符串数组→丢字段；env 非普通对象→
 *     丢字段；command 空串同缺失→null）；remote 只留 url/headers（url 空串同缺失→null）。name 取 map 键。
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
    if (isPlainObjectLocal(cfg.env)) entry.env = cfg.env as Record<string, string>;
    return entry;
  }
  const url = typeof cfg.url === 'string' && cfg.url !== '' ? cfg.url : null;
  if (url === null) return null; // http/sse 必填 url 缺失/空串 → 跳过该条目
  const entry: ParsedImportEntry = { name, transport, url };
  if (isPlainObjectLocal(cfg.headers)) entry.headers = cfg.headers as Record<string, string>;
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

// ── 添加/编辑弹窗（G13 定稿 modal；一期仅「Claude Link 管理」可真正保存）───────
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

// 一期保存位置段位：user/project 呈现但不可真正写入（P8 开放）。选即 toast + inline
// hint + 保存按钮阻断；段位停留可选、可切回（交互不死锁）。
const PHASE1_LOCATION_TIP = '一期暂不支持写入用户级/项目级文件（P8 开放），请选择 Claude Link 管理';
const locationSupported = computed<boolean>(() => formLocation.value === 'managed');
const locationHint = computed<string>(() => (locationSupported.value ? '存入应用配置库，仅 Claude Link 会话可用（经 SDK 注入，优先级最高，推荐）。' : PHASE1_LOCATION_TIP));

function switchLocation(loc: SaveLocation): void {
  if (formLocation.value === loc) return;
  formLocation.value = loc;
  if (loc !== 'managed') pushToast(PHASE1_LOCATION_TIP);
}

// §3.2 校验：名称必填 + pattern +（新增时）管理库内唯一——重名在 UI 拦截（主进程 sanitize
// 保留第一条，放行会导致「保存成功但新条目被静默丢弃」）。
const nameError = computed<string>(() => {
  const name = formName.value.trim();
  if (name === '') return '名称必填';
  if (!NAME_PATTERN.test(name)) return '名称仅限字母、数字、-、_，长度 1–64';
  if (!isEditMode.value && managedServers.value.some((s) => s.name === name)) return '与现有服务器重名（管理库内名称唯一）';
  return '';
});
const commandError = computed<string>(() => (formTransport.value === 'stdio' && formCommand.value.trim() === '' ? 'stdio 必填命令' : ''));
const urlError = computed<string>(() => (formTransport.value !== 'stdio' && formUrl.value.trim() === '' ? 'http/sse 必填 URL' : ''));
const formValid = computed<boolean>(() => locationSupported.value && !nameError.value && !commandError.value && !urlError.value);

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
  const stored = managedServers.value.find((s) => s.name === card.name);
  if (!stored) return;
  dialogMode.value = { kind: 'edit', id: stored.id };
  formLocation.value = 'managed'; // 一期编辑仅支持管理库（P8 开放作用域迁移）
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
    pushToast(successMsg);
    return true;
  } catch (e) {
    if (!disposed) pushToast(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function saveForm(): Promise<void> {
  const mode = dialogMode.value;
  if (!mode || !formValid.value || saving.value) return; // 空表单/非法 name/非管理位置提交拦截
  saving.value = true;
  try {
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

/** 删除：requestConfirm（danger，文案含服务器名）→ 数组剔除 → saveMcpManaged → 清 override 键。 */
async function handleDelete(card: McpCard): Promise<void> {
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

// ── 底部 note（每作用域首段对照定稿 + 三条公共说明：①仅影响新会话 ②严格模式副作用 ③库位与只读；
//    管理段补「删除前会弹确认框」句，r3 B-M4 对照定稿逐字）─
const scopeNoteHead = computed<string>(() => {
  if (activeScope.value.kind === 'managed') {
    return '此作用域的服务器由 Claude Link 经 SDK 注入（优先级高于 ~/.claude.json 与 .mcp.json），仅 Claude Link 会话可见。删除前会弹确认框。';
  }
  if (activeScope.value.kind === 'user') {
    return '此作用域为 Claude Code 用户级配置（终端 claude mcp add -s user 写入），Claude Link 不会修改该文件。禁用仅在 Claude Link 会话内生效；终端裸跑 claude 仍按原配置加载。';
  }
  return '此作用域为项目根 .mcp.json（团队成员共享、随仓库提交），Claude Link 不会修改该文件。仅在该项目目录下创建的会话才会加载。';
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
        <span class="mcp-rail-item__meta">
          <template v-if="loading">共 … · … 启用</template>
          <template v-else>共 {{ managedCards.length }} · {{ enabledCountOf(managedCards) }} 启用</template>
        </span>
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
          <template v-if="loading">共 … · … 启用</template>
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
          <template v-if="loading">共 … · … 启用 · {{ dir.sessionCount }} 会话</template>
          <template v-else>共 {{ dirCardsOf(dir).length }} · {{ enabledCountOf(dirCardsOf(dir)) }} 启用 · {{ dir.sessionCount }} 会话</template>
        </span>
      </button>

      <div class="mcp-rail__foot">用户级与项目级服务器来自 Claude Code 配置文件（磁盘直读，只读展示）；仅「Claude Link 管理」可增删改。</div>
    </nav>

    <!-- 右侧主区（对照定稿 main：标题行+按钮 → meta → 工具栏 → 滚动卡片列 → note） -->
    <section class="mcp-main">
      <div class="mcp-main__head">
        <div class="mcp-title-row">
          <span :class="['mcp-title-row__dot', { 'mcp-title-row__dot--user': activeScope.kind === 'user', 'mcp-title-row__dot--project': activeScope.kind === 'project' }]"></span>
          <span class="mcp-title-row__name">{{ scopeName }}</span>
          <span class="mcp-title-row__path">{{ scopePath }}</span>
          <span class="mcp-title-row__acts">
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
          <div class="mcp-statpills" aria-label="统计">
            <template v-if="!loading">
              <span class="mcp-statpill">{{ scopeCards.length }} 台</span>
              <span class="mcp-statpill mcp-statpill--on">{{ enabledCountOf(scopeCards) }} 启用</span>
              <span v-if="scopeCards.length - enabledCountOf(scopeCards) > 0" class="mcp-statpill mcp-statpill--off">{{ scopeCards.length - enabledCountOf(scopeCards) }} 禁用</span>
            </template>
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
          <div class="mcp-grid">
            <!-- 卡片（G13 无字母块版）：行1 徽标+操作+开关 / 行2 命令行 / 行2.5 errbar（探活失败）
                 / 行3 描述+连接三态+工具数 -->
            <div
              v-for="card in visibleCards"
              :key="card.key"
              :class="['mcp-card', { 'mcp-card--off': !isEnabled(card), 'mcp-card--fail': connStateOf(card) === 'fail' }]"
            >
              <div class="mcp-card__r1">
                <span class="mcp-card__name">{{ card.name }}</span>
                <span :class="['mcp-tchip', { 'mcp-tchip--http': card.transport === 'http', 'mcp-tchip--sse': card.transport === 'sse' }]">{{ card.transport.toUpperCase() }}</span>
                <span :class="['mcp-scope-badge', { 'mcp-scope-badge--user': activeScope.kind === 'user', 'mcp-scope-badge--project': activeScope.kind === 'project' }]">{{ activeScope.kind === 'managed' ? 'Link 管理' : activeScope.kind === 'user' ? '全局' : '项目' }}</span>
                <span v-if="!isEnabled(card)" class="mcp-off-badge">已禁用</span>
                <span class="mcp-spacer"></span>
                <!-- 管理库作用域：测试连接/编辑/删除（p7b 接线）；其余作用域只读（P8 开放编辑）。 -->
                <template v-if="activeScope.kind === 'managed'">
                  <button
                    class="mcp-iconbtn"
                    type="button"
                    :disabled="isProbing(card)"
                    :aria-label="`测试连接 ${card.name}`"
                    :title="isProbing(card) ? '探测中…' : `测试连接 ${card.name}`"
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
                <span v-else class="mcp-readonly-hint">定义只读</span>
                <input
                  type="checkbox"
                  class="mcp-switch"
                  :checked="isEnabled(card)"
                  :aria-label="`${isEnabled(card) ? '禁用' : '启用'} ${card.name}`"
                  @change="handleToggle(card, $event)"
                />
              </div>
              <div class="mcp-card__cmd">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                <span><b>{{ card.display.split(' ')[0] }}</b>{{ card.display.slice(card.display.split(' ')[0].length) }}</span>
              </div>
              <!-- 行2.5 errbar：探活失败红边框 + 错误条（error 单行截断，悬停 title 看全文）。 -->
              <div v-if="connStateOf(card) === 'fail' && probeReportOf(card)?.error" class="mcp-card__err">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                <span>连接失败：<code :title="probeReportOf(card)?.error ?? ''">{{ probeReportOf(card)?.error }}</code></span>
              </div>
              <div class="mcp-card__r3">
                <span class="mcp-card__desc" :title="card.description">{{ card.description }}</span>
                <span :class="['mcp-card__conn', { 'mcp-card__conn--off': connStateOf(card) === 'none' || connStateOf(card) === 'busy', 'mcp-card__conn--fail': connStateOf(card) === 'fail' }]">
                  <span class="dot"></span>{{ connTextOf(card) }}
                </span>
                <span class="mcp-card__tools">{{ toolsTextOf(card) }}</span>
              </div>
            </div>
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

          <p class="mcp-note">
            {{ scopeNoteHead }}
            <b>本页启停仅影响新会话，进行中的会话不受影响。</b>
            Claude Link 以严格模式接管会话 MCP 集合，claude.ai 云端 connectors 与插件 MCP 不再自动加载（禁用真正生效的必要代价）。管理库存于 claude-link 应用配置；用户级与项目级来自磁盘文件，只读展示、仅可启停。
          </p>
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
                <span :class="['mcp-ffield__hint', { 'mcp-ffield__hint--danger': !locationSupported }]">{{ locationHint }}</span>
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
                <span class="mcp-ffield__label">名称<span class="req">*</span></span>
                <input
                  v-model="formName"
                  :class="['mcp-input', 'mcp-input--mono', { 'mcp-input--invalid': nameError !== '' }]"
                  type="text"
                  placeholder="context7"
                  :disabled="isEditMode"
                />
                <span :class="['mcp-ffield__hint', { 'mcp-ffield__hint--danger': nameError !== '' }]">
                  {{ nameError !== '' ? nameError : '工具名形如 mcp__<名称>__<工具>，仅限字母、数字、-、_' }}
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
                    @click="formTransport = t"
                  >{{ transportLabel(t) }}</button>
                </div>
              </div>
              <label class="mcp-ffield mcp-ffield--full">
                <span class="mcp-ffield__label">描述</span>
                <input v-model="formDescription" class="mcp-input" type="text" placeholder="可选，便于识别用途" />
              </label>
              <template v-if="formTransport === 'stdio'">
                <label class="mcp-ffield mcp-ffield--full">
                  <span class="mcp-ffield__label">命令<span class="req">*</span></span>
                  <input
                    v-model="formCommand"
                    :class="['mcp-input', 'mcp-input--mono', { 'mcp-input--invalid': commandError !== '' }]"
                    type="text"
                    placeholder="npx"
                  />
                  <span v-if="commandError !== ''" class="mcp-ffield__hint mcp-ffield__hint--danger">{{ commandError }}</span>
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
                  <span class="mcp-ffield__hint">编辑时已存值回显为 {{ MASK_SENTINEL }}；保持不变则沿用已存原值，不会重复保存</span>
                </div>
              </template>
              <template v-else>
                <label class="mcp-ffield mcp-ffield--full">
                  <span class="mcp-ffield__label">URL<span class="req">*</span></span>
                  <input
                    v-model="formUrl"
                    :class="['mcp-input', 'mcp-input--mono', { 'mcp-input--invalid': urlError !== '' }]"
                    type="text"
                    placeholder="https://example.com/mcp"
                  />
                  <span v-if="urlError !== ''" class="mcp-ffield__hint mcp-ffield__hint--danger">{{ urlError }}</span>
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
                  <span class="mcp-ffield__hint">编辑时已存值回显为 {{ MASK_SENTINEL }}；保持不变则沿用已存原值，不会重复保存</span>
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

/* 统计并入工具栏的胶囊组（取自定稿 G3，省一整行高度）。 */
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

.mcp-statpill--on {
  color: var(--color-accent-strong);
  background: color-mix(in srgb, var(--color-accent) 11%, transparent);
}

.mcp-statpill--off {
  color: var(--color-fail);
  background: color-mix(in srgb, var(--color-fail) 9%, transparent);
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

/* ── 滚动区 + 卡片（G3 三行密度 × G1 边框质感）────────────────────────── */
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

.mcp-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.5rem;
}

.mcp-card {
  display: flex;
  flex-direction: column;
  gap: 0.1875rem;
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.6875rem 0.8125rem;
  transition:
    border-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}

.mcp-card:hover {
  border-color: color-mix(in srgb, var(--color-accent) 38%, transparent);
  box-shadow: var(--elevation-2);
  transform: translateY(-1px);
}

.mcp-card--off {
  opacity: 0.6;
  background: transparent;
}

.mcp-card--off:hover {
  opacity: 0.85;
}

/* 行2.5 errbar 卡片态（探活失败红边框）。 */
.mcp-card--fail {
  border-color: color-mix(in srgb, var(--color-danger) 40%, transparent);
}

/* 行1：名称 + 徽标 | 操作 + 开关 */
.mcp-card__r1 {
  display: flex;
  align-items: center;
  gap: 0.4375rem;
  min-width: 0;
}

.mcp-card__name {
  font-size: 0.875rem;
  font-weight: 700;
  font-family: var(--font-mono);
  letter-spacing: -0.01em;
  white-space: nowrap;
}

.mcp-card__r1 .mcp-spacer {
  flex: 1;
}

/* 传输 chip（stdio 默认描边 / http info / sse success 三色）。 */
.mcp-tchip {
  display: inline-flex;
  align-items: center;
  padding: 0.09375rem 0.4375rem;
  border-radius: var(--radius-xs);
  font-family: var(--font-mono);
  font-size: 0.59375rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.mcp-tchip--http {
  color: var(--color-info-strong);
  border-color: color-mix(in srgb, var(--color-info) 35%, transparent);
  background: color-mix(in srgb, var(--color-info) 8%, transparent);
}

.mcp-tchip--sse {
  color: var(--color-success-strong);
  border-color: color-mix(in srgb, var(--color-success) 35%, transparent);
  background: color-mix(in srgb, var(--color-success) 8%, transparent);
}

/* 作用域徽章（managed accent / user info / project 紫）。 */
.mcp-scope-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.09375rem 0.5rem;
  border-radius: var(--radius-pill);
  font-size: 0.59375rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--color-accent-strong);
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  flex-shrink: 0;
}

.mcp-scope-badge--user {
  color: var(--color-info-strong);
  background: color-mix(in srgb, var(--color-info) 12%, transparent);
}

.mcp-scope-badge--project {
  color: #5f3dc4;
  background: color-mix(in srgb, #7c5cfc 13%, transparent);
}

.mcp-off-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.09375rem 0.5rem;
  border-radius: var(--radius-pill);
  font-size: 0.59375rem;
  font-weight: 700;
  color: var(--color-fail);
  background: color-mix(in srgb, var(--color-fail) 10%, transparent);
  flex-shrink: 0;
}

/* 行2：命令行 / url。 */
.mcp-card__cmd {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-family: var(--font-mono);
  font-size: 0.71875rem;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
}

.mcp-card__cmd svg {
  width: 0.75rem;
  height: 0.75rem;
  flex-shrink: 0;
  opacity: 0.65;
}

.mcp-card__cmd span {
  overflow: hidden;
  text-overflow: ellipsis;
}

.mcp-card__cmd b {
  font-weight: 600;
  color: color-mix(in srgb, var(--color-text-muted) 85%, var(--color-text));
}

/* 行2.5 errbar（探活失败错误条）：文本单行截断，悬停 title 看全文。 */
.mcp-card__err {
  display: flex;
  gap: 0.3125rem;
  font-size: 0.6875rem;
  color: var(--color-danger);
  line-height: 1.45;
  min-width: 0;
}

.mcp-card__err svg {
  width: 0.8125rem;
  height: 0.8125rem;
  flex-shrink: 0;
  margin-top: 0.0625rem;
}

.mcp-card__err span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcp-card__err code {
  font-family: var(--font-mono);
  font-size: 0.65625rem;
}

/* 行3：描述 | 连接 + 工具。 */
.mcp-card__r3 {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  margin-top: 0.0625rem;
}

.mcp-card__desc {
  flex: 1;
  min-width: 0;
  font-size: 0.71875rem;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mcp-card__conn {
  display: inline-flex;
  align-items: center;
  gap: 0.3125rem;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--color-success-strong);
  flex-shrink: 0;
}

.mcp-card__conn .dot {
  width: 0.4375rem;
  height: 0.4375rem;
  border-radius: 50%;
  background: var(--color-success);
}

.mcp-card__conn--off {
  color: var(--color-text-muted);
  font-weight: 500;
}

.mcp-card__conn--off .dot {
  background: var(--color-border-strong);
}

.mcp-card__conn--fail {
  color: var(--color-danger);
}

.mcp-card__conn--fail .dot {
  background: var(--color-fail);
}

.mcp-card__tools {
  font-size: 0.65625rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.mcp-readonly-hint {
  font-size: 0.625rem;
  color: var(--color-text-muted);
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
  width: 1.75rem;
  height: 1.75rem;
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
  width: 0.875rem;
  height: 0.875rem;
}

/* ── 开关（定稿 .switch 同值移植）────────────────────────────────────── */
.mcp-switch {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  width: 2.75rem;
  height: 1.5rem;
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
  width: 1.125rem;
  height: 1.125rem;
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
  transform: translateY(-50%) translateX(1.25rem);
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

.mcp-note {
  margin: 0.875rem 0 0;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  line-height: 1.65;
}

.mcp-note b {
  color: var(--color-text);
  font-weight: 600;
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

.mcp-ffield__label .req {
  color: var(--color-fail);
  margin-left: 0.125rem;
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

/* 未勾选（将不导入）行降透明度提示——对照 .mcp-card--off 同值 0.6。 */
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
