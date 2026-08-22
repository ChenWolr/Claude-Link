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
   *   - post-turn：result 处理期（query 仍存活）采样，代表回合结束状态；
   *   - post-compaction：compact_result:success 后采样。
   */
  samplePhase: ContextSamplePhase;
}

export type ContextSamplePhase = 'query-start' | 'post-turn' | 'post-compaction';

// review-v4 High-1 方案 B 兜底：post-turn 快照不可得（getContextUsage 超时 / query 已关闭）时，
// 必须显式降级为 stale + diagnostic——禁止 query-start 快照在回合结束后继续伪装 fresh。
export function postTurnFallbackTerminal(lastKnownPhase: ContextSamplePhase | null): {
  source: 'unavailable';
  freshness: 'stale';
  diagnostic: string;
} {
  return {
    source: 'unavailable',
    freshness: 'stale',
    diagnostic: `post-turn 快照不可得（getContextUsage 超时或 query 已关闭）；上一可信快照采样阶段：${lastKnownPhase ?? '未知'}`,
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
// CC 自动压缩事件检测。compactedJustNow=true 表示本次流里发生了自动压缩。
// fromTokens/toTokens 预留给未来 CC 若在 compact_boundary 事件里携带压缩前后 token 数。
// ─────────────────────────────────────────────────────────────────────────────
export interface CompactionResult {
  compactedJustNow: true;
  fromTokens?: number;
  toTokens?: number;
}

// 检测一个 CliEvent 是否为 CC 自动压缩事件（system + subtype 'compact_boundary'）。
// 返回 CompactionResult（带 compactedJustNow:true）或 null（非压缩事件）。
export function detectCompaction(event: CliEvent): CompactionResult | null {
  if (event.type !== 'system') return null;
  const sys = event as CliSystemInfoEvent;
  if (sys.subtype !== 'compact_boundary') return null;
  return { compactedJustNow: true };
}
