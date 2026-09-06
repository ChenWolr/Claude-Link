import type { CliUsage } from './types/cli';
import type { CliEvent, CliSystemInfoEvent } from './types/cli';

// ─────────────────────────────────────────────────────────────────────────────
// 上下文占用统计契约（Task 7 canonical contract）
//
// 三类 token 语义（黑盒证据 run-2026-08-21-205616 已证实）：
//   1. current context used（当前窗口已用）：
//        - SDK query.getContextUsage().totalTokens（仅 query 存活期可达）
//        - 原生 /context 输出的 used 值（低频对账来源）
//        - 两者数值一致（~24k vs /context 2%，同一会话同口径）
//   2. turn usage（本轮输入）：message/result.usage 的 input_tokens + cache_creation + cache_read。
//        实测 S4 高达 104k 而当前窗口仅 40.1k，二者绝不相等。
//   3. window capacity（窗口容量）：result.modelUsage.contextWindow 或 getContextUsage().rawMaxTokens。
//
// 铁律：turn usage 不得写入当前窗口主值；缺失可信当前窗口时显示 estimated/pending，不得伪造 0% 或 live。
// ─────────────────────────────────────────────────────────────────────────────

export type ContextUsageSource =
  | 'runtime-live'
  | 'native-context'
  | 'reconciled'
  | 'estimated-turn-usage'
  | 'unavailable';

export type ContextUsageFreshness =
  | 'live'
  | 'fresh'
  | 'stale'
  | 'estimated'
  | 'pending'
  | 'unavailable';

export interface CanonicalContextUsage {
  currentContextUsedTokens: number | null;
  contextWindowCapacityTokens: number | null;
  currentContextUsedPercent: number | null;
  currentContextRemainingTokens: number | null;
  currentContextRemainingPercent: number | null;
  turnInputTokens: number | null;
  turnCacheReadTokens: number | null;
  turnCacheCreationTokens: number | null;
  turnOutputTokens: number | null;
  source: ContextUsageSource;
  freshness: ContextUsageFreshness;
  consistency: 'reconciled' | 'mismatch' | 'unavailable';
  diagnostic: string | null;
}

// 原生 /context 输出的解析结果（used/max/percentage/categories）。
export interface NativeContextCategory {
  name: string;
  tokens: number;
  percentage: number | null;
}

export interface NativeContextReport {
  usedTokens: number;
  maxTokens: number;
  percentage: number | null;
  model: string | null;
  categories: NativeContextCategory[];
}

// ─────────────────────────────────────────────────────────────────────────────
// turn usage：本次请求送入的全部 token（input + 两种 cache）。output_tokens 不计入（生成量）。
// 缺字段按 0。**仅限 turn/cumulative usage，禁止作当前窗口主值**（见铁律）。
// ─────────────────────────────────────────────────────────────────────────────
export function extractContextTokens(usage: CliUsage | undefined): number {
  if (!usage) return 0;
  const input = usage.input_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return input + cacheCreate + cacheRead;
}

// ─────────────────────────────────────────────────────────────────────────────
// canonical reducer：从「当前窗口已用候选 + turn usage」推导当前窗口主值。
// 只认 contextUsedTokens（live 当前窗口）；inputTokens/cachedInputTokens 绝不冒充当前窗口。
// ─────────────────────────────────────────────────────────────────────────────
export function deriveCurrentContextUsed(input: {
  contextUsedTokens: number | null | undefined;
  inputTokens: number | null | undefined;
  cachedInputTokens: number | null | undefined;
}): number | null {
  const live = input.contextUsedTokens;
  return typeof live === 'number' && Number.isFinite(live) && live >= 0 ? live : null;
}

// 新鲜度分类：有可信当前窗口 → live/fresh；仅 turn usage → estimated；全无 → pending。
// 说明：本函数只依据「是否有可信当前窗口」做二分类；stale/unavailable 由调用方（带 source 时序）
// 在 reconcile 阶段进一步判定。
export function classifyUsageFreshness(input: {
  contextUsedTokens: number | null | undefined;
  inputTokens: number | null | undefined;
}): ContextUsageFreshness {
  const live = input.contextUsedTokens;
  if (typeof live === 'number' && Number.isFinite(live) && live >= 0) return 'live';
  const turn = input.inputTokens;
  if (typeof turn === 'number' && Number.isFinite(turn) && turn > 0) return 'estimated';
  return 'pending';
}

// ─────────────────────────────────────────────────────────────────────────────
// 原生 /context 输出 parser（Task 10）
//
// 真实格式（run-2026-08-21-205616 采集，脱敏）：
//   ## Context Usage
//   **Model:** deepseek-v4-flash
//   **Tokens:** 19.7k / 1m (2%)
//   ### Estimated usage by category
//   | Category | Tokens | Percentage |
//   | System tools | 14.3k | 1.4% |
//   ...
//
// 兼容紧凑变体：`226.3k/1m tokens (23%)`（used/max tokens (pct%)）。
// 拒绝条件：不完整（无 used 或 max）、多来源冲突、百分比与 used/max 明显不一致。
// ─────────────────────────────────────────────────────────────────────────────

// 解析单个 token 数值：整数或带 k/m 后缀（k=1e3, m=1e6），可带小数。非法返回 null。
export function parseTokenNumber(raw: string | null | undefined): number | null {  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^([0-9]*\.?[0-9]+)\s*([km]?)$/);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base) || base < 0) return null;
  const mult = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1;
  const v = base * mult;
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

// 解析百分比：整数或小数，可带 %。返回数值（0-100），非法返回 null。
function parsePercentage(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  const m = s.match(/^([0-9]*\.?[0-9]+)\s*%?$/);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v < 0 || v > 100) return null;
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// ANSI 清理（review-v4 Medium-1）：native /context 可能经带颜色的 stdout 回传，
// CSI/OSC 控制码插在 **Tokens:** 与数字之间会让正则失配。parser 在结构解析前先归一化；
// 只删明确的控制码（CSI 序列 / OSC 序列 / 回车），不动其它非 ASCII 内容。
// ─────────────────────────────────────────────────────────────────────────────
export function stripAnsi(text: string | null | undefined): string {
  if (text == null) return '';
  return String(text)
    // CSI：ESC [ params中间字节 终止字节（颜色/光标等）
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // OSC：ESC ] ... (BEL 或 ESC \)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // 其它单字符控制（回车等）
    .replace(/\r/g, '');
}

// 从 /context 原文解析当前窗口用量。返回 null 表示无法可信解析（不猜测）。
export function parseNativeContextReport(text: string | null | undefined): NativeContextReport | null {
  if (!text) return null;
  // review-v4 Medium-1：先剥离 ANSI 控制码再进结构正则；rawText 不变（证据层保留原文）。
  const src = stripAnsi(text);

  // 找 tokens 行：`**Tokens:** 19.7k / 1m (2%)` 或 `226.3k/1m tokens (23%)` 等。
  const tokenLineRe =
    /\*\*Tokens:\*\*\s*([0-9]*\.?[0-9]+\s*[km]?)\s*\/\s*([0-9]*\.?[0-9]+\s*[km]?)\s*(?:tokens\s*)?\(\s*([0-9]*\.?[0-9]+)\s*%\s*\)/i;
  const altRe =
    /([0-9]*\.?[0-9]+\s*[km]?)\s*\/\s*([0-9]*\.?[0-9]+\s*[km]?)\s+tokens\s*\(\s*([0-9]*\.?[0-9]+)\s*%\s*\)/i;
  const tokenLineGlobal =
    /\*\*Tokens:\*\*\s*([0-9]*\.?[0-9]+\s*[km]?)\s*\/\s*([0-9]*\.?[0-9]+\s*[km]?)\s*(?:tokens\s*)?\(\s*([0-9]*\.?[0-9]+)\s*%\s*\)/gi;
  const altGlobal =
    /([0-9]*\.?[0-9]+\s*[km]?)\s*\/\s*([0-9]*\.?[0-9]+\s*[km]?)\s+tokens\s*\(\s*([0-9]*\.?[0-9]+)\s*%\s*\)/gi;

  let usedRaw: string | null = null;
  let maxRaw: string | null = null;
  let pctRaw: string | null = null;

  const m1 = src.match(tokenLineRe);
  if (m1) {
    usedRaw = m1[1]; maxRaw = m1[2]; pctRaw = m1[3];
  } else {
    const m2 = src.match(altRe);
    if (m2) {
      usedRaw = m2[1]; maxRaw = m2[2]; pctRaw = m2[3];
    }
  }

  // 多来源冲突：同一文本里出现两个以上不相同的 tokens 行 → 拒绝。
  const allTokenLines = [...src.matchAll(tokenLineGlobal)].map((m) => `${m[1]}/${m[2]}/${m[3]}`)
    .concat([...src.matchAll(altGlobal)].map((m) => `${m[1]}/${m[2]}/${m[3]}`));
  if (allTokenLines.length > 1) {
    const uniq = new Set(allTokenLines);
    if (uniq.size > 1) return null;
  }

  const used = parseTokenNumber(usedRaw);
  const max = parseTokenNumber(maxRaw);
  const pct = parsePercentage(pctRaw);
  if (used == null || max == null || max <= 0) return null;

  // 百分比一致性：|pct - used/max*100| 容忍 1.5 个百分点（k/m 缩写有 ±0.05k 的舍入误差）。
  const computedPct = (used / max) * 100;
  if (pct != null && Math.abs(pct - computedPct) > 1.5) return null;

  // model 行
  const model = (src.match(/\*\*Model:\*\*\s*([^\n*]+)/)?.[1] ?? null)?.trim() ?? null;

  // category 表（| name | tokens | percentage |）
  const categories: NativeContextCategory[] = [];
  const catRe = /^\|\s*([^|\n]+?)\s*\|\s*([0-9]*\.?[0-9]+\s*[km]?)\s*\|\s*([0-9]*\.?[0-9]+)\s*%\s*\|/gm;
  for (const cm of src.matchAll(catRe)) {
    const name = cm[1].trim();
    const tokens = parseTokenNumber(cm[2]);
    const cpct = parsePercentage(cm[3]);
    if (name && tokens != null && !/^-+$/.test(name)) {
      categories.push({ name, tokens, percentage: cpct });
    }
  }

  return { usedTokens: used, maxTokens: max, percentage: pct, model, categories };
}

// ─────────────────────────────────────────────────────────────────────────────
// reconciliation：runtime（getContextUsage）与 native（/context）对账。
// 容差：used/capacity 相对差 ≤ 5%（或绝对差 ≤ 100 tokens）视为一致。
// ─────────────────────────────────────────────────────────────────────────────
export function reconcileContextUsage(opts: {
  runtimeUsedTokens: number | null;
  runtimeCapacityTokens: number | null;
  runtimePercentage: number | null;
  nativeUsedTokens: number | null;
  nativeCapacityTokens: number | null;
  nativePercentage: number | null;
}): {
  consistency: 'reconciled' | 'mismatch' | 'unavailable';
  usedTokens: number | null;
  capacityTokens: number | null;
  percentage: number | null;
  diagnostic: string | null;
} {
  const { runtimeUsedTokens, runtimeCapacityTokens, nativeUsedTokens, nativeCapacityTokens, nativePercentage, runtimePercentage } = opts;
  const hasRuntime = typeof runtimeUsedTokens === 'number' && Number.isFinite(runtimeUsedTokens) && runtimeUsedTokens >= 0;
  const hasNative = typeof nativeUsedTokens === 'number' && Number.isFinite(nativeUsedTokens) && nativeUsedTokens >= 0;
  if (!hasRuntime && !hasNative) {
    return { consistency: 'unavailable', usedTokens: null, capacityTokens: null, percentage: null, diagnostic: 'runtime 与 native 均无可信当前窗口数据' };
  }
  if (!hasRuntime && hasNative) {
    return {
      consistency: 'unavailable',
      usedTokens: nativeUsedTokens,
      capacityTokens: nativeCapacityTokens,
      percentage: nativePercentage,
      diagnostic: 'runtime 快照缺失，仅 native /context 可用',
    };
  }
  if (hasRuntime && !hasNative) {
    return {
      consistency: 'unavailable',
      usedTokens: runtimeUsedTokens,
      capacityTokens: runtimeCapacityTokens,
      percentage: runtimePercentage,
      diagnostic: 'native /context 缺失，仅 runtime 快照可用',
    };
  }
  // 两者都有：对账
  const within = (a: number, b: number) => {
    const diff = Math.abs(a - b);
    const rel = Math.max(a, b) === 0 ? 0 : diff / Math.max(a, b);
    return diff <= 100 || rel <= 0.05;
  };
  const capMatches = nativeCapacityTokens == null || runtimeCapacityTokens == null || within(nativeCapacityTokens, runtimeCapacityTokens);
  const usedMatches = within(runtimeUsedTokens!, nativeUsedTokens!);
  if (usedMatches && capMatches) {
    return {
      consistency: 'reconciled',
      usedTokens: runtimeUsedTokens,
      capacityTokens: runtimeCapacityTokens ?? nativeCapacityTokens,
      percentage: runtimePercentage ?? nativePercentage,
      diagnostic: null,
    };
  }
  return {
    consistency: 'mismatch',
    usedTokens: runtimeUsedTokens,
    capacityTokens: runtimeCapacityTokens ?? nativeCapacityTokens,
    percentage: runtimePercentage,
    diagnostic: `runtime 与 native 不一致：runtime used=${runtimeUsedTokens}/cap=${runtimeCapacityTokens}，native used=${nativeUsedTokens}/cap=${nativeCapacityTokens}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// /context 对账终态映射（review-v2 Blocker，review-v3 §3.6-E 固定契约）：
//   - reconciled：native 与同代 runtime 一致 → reconciled + fresh
//   - mismatch：两者冲突 → unavailable + stale
//   - 仅 native（runtime 缺失/代际不符但 native 解析成功）→ native 即当前窗口权威 → native-context + fresh
//   - 仅 runtime（native 空/解析失败）→ unavailable + stale（保留 last-known，不伪装 fresh）
//   - 两者皆无 → unavailable + pending
// ─────────────────────────────────────────────────────────────────────────────
export function mapContextReconcileTerminal(input: {
  consistency: 'reconciled' | 'mismatch' | 'unavailable';
  hasRuntime: boolean;
  hasNative: boolean;
}): { source: ContextUsageSource; freshness: ContextUsageFreshness } {
  const { consistency, hasRuntime, hasNative } = input;
  if (consistency === 'reconciled') return { source: 'reconciled', freshness: 'fresh' };
  if (consistency === 'mismatch') return { source: 'unavailable', freshness: 'stale' };
  if (!hasRuntime && hasNative) return { source: 'native-context', freshness: 'fresh' };
  if (hasRuntime && !hasNative) return { source: 'unavailable', freshness: 'stale' };
  return { source: 'unavailable', freshness: 'pending' };
}

// ─────────────────────────────────────────────────────────────────────────────
// post-turn 官方 /context 探针（本计划）→ canonical payload 核心字段。
//
// 探针是回合外旁路：回合正常收尾后 fire-and-forget 起 `claude.exe -p "/context"
// --resume <sid> --no-session-persistence` 子进程，拿回合末精确占用。此时 runtime
// 快照已非同代，native 报告本身即权威 —— 与现有 native-only 分支同语义
// （consistency='unavailable'），但 freshness='fresh' + samplePhase='post-turn'，
// 因为它确确实实是回合结束时刻的官方引擎数值。语义单源：主进程 payload 构造
// 与本函数共用，行为测试同源。
// ─────────────────────────────────────────────────────────────────────────────
export interface PostTurnProbeCanonicalFields {
  queryGeneration: number;
  source: 'native-context';
  freshness: 'fresh';
  consistency: 'unavailable';
  diagnostic: null;
  currentContextUsedTokens: number;
  contextWindowCapacityTokens: number;
  currentContextUsedPercent: number | null;
  currentContextRemainingTokens: number | null;
  currentContextRemainingPercent: number | null;
  turnInputTokens: null;
  turnCacheReadTokens: null;
  turnCacheCreationTokens: null;
  turnOutputTokens: null;
  refreshedAt: number;
  samplePhase: 'post-turn';
}

export function derivePostTurnProbePayloadFields(
  report: NativeContextReport,
  queryGeneration: number,
  refreshedAt: number,
): PostTurnProbeCanonicalFields {
  const used = report.usedTokens;
  const capacity = report.maxTokens;
  const percent = report.percentage;
  return {
    queryGeneration,
    source: 'native-context',
    freshness: 'fresh',
    consistency: 'unavailable',
    diagnostic: null,
    currentContextUsedTokens: used,
    contextWindowCapacityTokens: capacity,
    currentContextUsedPercent: percent,
    currentContextRemainingTokens: capacity >= used ? capacity - used : null,
    currentContextRemainingPercent: percent != null ? Math.max(0, 100 - percent) : null,
    turnInputTokens: null,
    turnCacheReadTokens: null,
    turnCacheCreationTokens: null,
    turnOutputTokens: null,
    refreshedAt,
    samplePhase: 'post-turn',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// review-v3 High-1：runtime 快照必须绑定 query 代际。
// snapshot 只有所属 queryInstance 与当前回合一致时，才允许参与 /context reconcile——
// 上一回合的 runtime 数字可以做诊断参考，但绝不能与本回合 native 强行对账出 reconciled。
// ─────────────────────────────────────────────────────────────────────────────
export interface RuntimeContextSnapshot {
  usedTokens: number;
  capacityTokens: number;
  percentage: number | null;
  /** 产生该快照的 query 代际（sdk-backend entry.queryInstance，全局单调递增）。 */
  queryInstance: number;
  /** 快照捕获时间（Date.now()，用于「早于本回合开始」的防御性判定）。 */
  capturedAt: number;
  /**
   * 采样阶段（review-v4 High-1）：query-start 快照不得在回合结束后继续冒充当前值。
   *   - query-start：init 后立即采样（回合开始时的基线）；
   *   - mid-turn：回合进行中（工具结果/assistant 落地后）采样，代表中途最新值（本计划新增）；
   *   - post-turn：result 处理期（query 仍存活）采样，代表回合结束状态；
   *   - post-compaction：compact_result:success 后采样。
   */
  samplePhase: ContextSamplePhase;
}

export type ContextSamplePhase = 'query-start' | 'mid-turn' | 'post-turn' | 'post-compaction';

// review-v4 High-1 方案 B 兜底：post-turn 快照不可得（getContextUsage 超时 / query 已关闭）时，
// 必须显式降级为 stale + diagnostic——禁止 query-start 快照在回合结束后继续伪装 fresh。
// breakerNote（刷新熔断器 2026-09-06）：熔断期借道此兜底时附加退避注记；缺省单参输出与
// 历史文案逐字节一致（契约锁，见 tdd-context-usage-verify §27.6）。
export function postTurnFallbackTerminal(
  lastKnownPhase: ContextSamplePhase | null,
  breakerNote?: string,
): {
  source: 'unavailable';
  freshness: 'stale';
  diagnostic: string;
} {
  return {
    source: 'unavailable',
    freshness: 'stale',
    diagnostic: `post-turn 快照不可得（getContextUsage 超时或 query 已关闭）；上一可信快照采样阶段：${lastKnownPhase ?? '未知'}${breakerNote ? `；${breakerNote}` : ''}`,
  };
}

// 快照是否属于指定 query 代际：null/代际不符/capturedAt 非法一律 false；
// 传入 capturedAfter（本回合开始时间）时还要求 capturedAt ≥ 该时间。
export function isRuntimeSnapshotForQuery(
  snapshot: RuntimeContextSnapshot | null | undefined,
  queryInstance: number,
  opts: { capturedAfter?: number } = {},
): boolean {
  if (snapshot == null) return false;
  if (typeof snapshot.queryInstance !== 'number' || snapshot.queryInstance !== queryInstance) return false;
  if (typeof snapshot.capturedAt !== 'number' || !Number.isFinite(snapshot.capturedAt)) return false;
  if (typeof opts.capturedAfter === 'number' && snapshot.capturedAt < opts.capturedAfter) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// review-v4 Medium-2：canonical payload 字段完整性（运行时协议校验）。
// 发布契约要求所有 canonical 字段必须存在（无数据用 null）；缺字段即协议错误——
// 已知代际下拒收，不得与 prev state 拼接成混合状态。兼容初始化（无代际）时仍拒收：
// 不完整 payload 无论何时都不应进入 canonical state。
// ─────────────────────────────────────────────────────────────────────────────
const CANONICAL_REQUIRED_FIELDS = [
  'queryGeneration',
  'source',
  'freshness',
  'consistency',
  'diagnostic',
  'currentContextUsedTokens',
  'contextWindowCapacityTokens',
  'currentContextUsedPercent',
  'currentContextRemainingTokens',
  'currentContextRemainingPercent',
  'turnInputTokens',
  'turnCacheReadTokens',
  'turnCacheCreationTokens',
  'turnOutputTokens',
  'refreshedAt',
  'samplePhase',
] as const;

export function hasCompleteCanonicalFields(payload: unknown): boolean {
  if (payload == null || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  for (const key of CANONICAL_REQUIRED_FIELDS) {
    if (p[key] === undefined) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// review-v3 High-2：CONTEXT_UPDATE payload 代际门（renderer 拒收旧回合/缺代际迟到事件）。
//   payload gen < known   → 拒收（旧 query 迟到）
//   payload gen 缺失 + 已有 known → 拒收（协议错误，不接受无身份 payload）
//   其余 → 接收；payload 带 gen 时同步推进 known。
// ─────────────────────────────────────────────────────────────────────────────
export function shouldAcceptContextPayload(
  knownGeneration: number | undefined,
  payloadGeneration: number | undefined,
): { accept: boolean; nextKnownGeneration: number | undefined } {
  if (payloadGeneration === undefined) {
    return { accept: knownGeneration === undefined, nextKnownGeneration: knownGeneration };
  }
  if (
    typeof knownGeneration === 'number' &&
    typeof payloadGeneration === 'number' &&
    payloadGeneration < knownGeneration
  ) {
    return { accept: false, nextKnownGeneration: knownGeneration };
  }
  return { accept: true, nextKnownGeneration: payloadGeneration };
}

// ─────────────────────────────────────────────────────────────────────────────
// review-v3 §5.3：压缩成功横幅时序契约（纯逻辑，主进程与 renderer 双侧共用语义）。
// 只有 compact_result:success 之后、**同代 fresh** runtime 快照（compactedJustNow 由
// 主进程在该条件下附加）才显示横幅；pending/failed/timeout/stale 一律不显示。
// ─────────────────────────────────────────────────────────────────────────────
export function shouldShowCompactedBanner(payload: {
  compactedJustNow?: boolean;
  freshness?: ContextUsageFreshness | null;
  source?: ContextUsageSource | null;
}): boolean {
  return (
    payload.compactedJustNow === true &&
    payload.freshness === 'fresh' &&
    (payload.source === 'runtime-live' || payload.source === 'reconciled' ||
      // post-turn 官方探针(本计划):压缩回合的探针 fresh 值也携带 compactedJustNow,
      // 使 SDK 中途快照失败时「已压缩」横幅仍能由探针 fresh 值触发(§5.3 只有 fresh 才带标记)。
      payload.source === 'native-context')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CC 自动压缩事件检测。compactedJustNow=true 表示本次流里发生了压缩。
// compact_boundary 免费附带账单 compact_metadata（F1/F2 实测，两种键名均有）：
//   - snake_case：compact_metadata.{pre_tokens,post_tokens,cumulative_dropped_tokens,duration_ms,trigger}
//     （F1 自动压缩，events.jsonl / timeline.json）
//   - camelCase：compactMetadata.{preTokens,postTokens,cumulativeDroppedTokens,durationMs,trigger}
//     （F2 手动 /compact，manual-compact-meta2 的 jsonl）
// 全部可选（F3：小上下文手动压缩 compact_result:"failed" 且无 boundary → 无账单，
// 必须缺席优雅降级）。解析进可测纯函数 parseCompactMetadata，与事件形状解耦。
// ─────────────────────────────────────────────────────────────────────────────
export interface CompactionResult {
  compactedJustNow: true;
  /** 压缩前 token（pre_tokens / preTokens）。 */
  fromTokens?: number;
  /** 压缩后 token（post_tokens / postTokens）。 */
  toTokens?: number;
  /** 累计清出 token（cumulative_dropped_tokens / cumulativeDroppedTokens）。 */
  droppedTokens?: number;
  /** 压缩耗时 ms（duration_ms / durationMs）。 */
  durationMs?: number;
  /** 触发方式：auto（自动压缩）/ manual（手动 /compact）等。 */
  trigger?: 'auto' | 'manual' | string;
}

// 数值字段读取：必须是有限非负 number，否则丢弃（不报错）。snake_case 优先、camelCase 防御兼容。
function readCompactNumber(m: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const v = m[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}

// 解析 compact_metadata / compactMetadata 原始对象 → 可选账单字段。
// 非法/缺失/负数一律忽略（对应字段缺席），不抛错、不猜测。
export function parseCompactMetadata(raw: unknown): Partial<CompactionResult> {
  if (raw == null || typeof raw !== 'object') return {};
  const m = raw as Record<string, unknown>;
  const fromTokens = readCompactNumber(m, 'pre_tokens', 'preTokens');
  const toTokens = readCompactNumber(m, 'post_tokens', 'postTokens');
  const droppedTokens = readCompactNumber(m, 'cumulative_dropped_tokens', 'cumulativeDroppedTokens');
  const durationMs = readCompactNumber(m, 'duration_ms', 'durationMs');
  const triggerRaw = m.trigger;
  const trigger = typeof triggerRaw === 'string' && triggerRaw.trim() ? triggerRaw.trim() : undefined;
  const out: Partial<CompactionResult> = {};
  if (fromTokens !== undefined) out.fromTokens = fromTokens;
  if (toTokens !== undefined) out.toTokens = toTokens;
  if (droppedTokens !== undefined) out.droppedTokens = droppedTokens;
  if (durationMs !== undefined) out.durationMs = durationMs;
  if (trigger !== undefined) out.trigger = trigger;
  return out;
}

// 检测一个 CliEvent 是否为 CC 压缩事件（system + subtype 'compact_boundary'）。
// 返回 CompactionResult（带 compactedJustNow:true + 可选账单字段）或 null（非压缩事件）。
export function detectCompaction(event: CliEvent): CompactionResult | null {
  if (event.type !== 'system') return null;
  const sys = event as CliSystemInfoEvent;
  if (sys.subtype !== 'compact_boundary') return null;
  const raw = sys as unknown as { compact_metadata?: unknown; compactMetadata?: unknown };
  const metadata = raw.compact_metadata ?? raw.compactMetadata;
  return { compactedJustNow: true, ...parseCompactMetadata(metadata) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 压缩横幅文案单源（主进程/renderer 共用）。
// 有完整数字（from/to/dropped 三值齐且合法）：「已自动压缩上下文：91.0k → 1.6k（清出 89.4k）」
//（trigger==='auto' 才带「自动」）；缺任一数字 → hasNumbers:false + 现有文案。
// 数字格式化与 ContextButton fmt 同风格（>=1000 → x.xk）。
// ─────────────────────────────────────────────────────────────────────────────
export interface CompactionSummaryFormat {
  title: string;
  hasNumbers: boolean;
}

function fmtCompactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function formatCompactionSummary(c: {
  fromTokens?: number;
  toTokens?: number;
  droppedTokens?: number;
  trigger?: string;
}): CompactionSummaryFormat {
  const from = c?.fromTokens;
  const to = c?.toTokens;
  const dropped = c?.droppedTokens;
  const valid = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!valid(from) || !valid(to) || !valid(dropped)) {
    return { title: 'Claude Code 已自动压缩上下文', hasNumbers: false };
  }
  const prefix = c.trigger === 'auto' ? '已自动压缩上下文：' : '已压缩上下文：';
  return {
    title: `${prefix}${fmtCompactTokens(from)} → ${fmtCompactTokens(to)}（清出 ${fmtCompactTokens(dropped)}）`,
    hasNumbers: true,
  };
}
