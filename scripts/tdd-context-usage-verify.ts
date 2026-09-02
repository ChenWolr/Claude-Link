// tdd-context-usage-verify.ts
// 上下文占用统计契约行为测试（Task 7 / Task 10）。
// 运行：npx tsx scripts/tdd-context-usage-verify.ts
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  deriveCurrentContextUsed,
  classifyUsageFreshness,
  parseTokenNumber,
  parseNativeContextReport,
  reconcileContextUsage,
  extractContextTokens,
  detectCompaction,
  parseCompactMetadata,
  formatCompactionSummary,
  isRuntimeSnapshotForQuery,
  shouldAcceptContextPayload,
  shouldShowCompactedBanner,
  mapContextReconcileTerminal,
  stripAnsi,
  postTurnFallbackTerminal,
  hasCompleteCanonicalFields,
  derivePostTurnProbePayloadFields,
} from '../src/shared/context-usage';
import { applySessionOverrideEnv } from '../src/shared/session-model';
import type { RuntimeContextSnapshot } from '../src/shared/context-usage';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

console.log('=== 1) Task 7: deriveCurrentContextUsed — 当前窗口主值不被 turn usage 伪装 ===');
check('contextUsedTokens 存在时优先返回它（忽略 inputTokens）', () => {
  assert.equal(deriveCurrentContextUsed({ contextUsedTokens: 1234, inputTokens: 9999, cachedInputTokens: 8888 }), 1234);
});
check('contextUsedTokens 缺失时返回 null（不回落 input+cache）', () => {
  assert.equal(deriveCurrentContextUsed({ contextUsedTokens: null, inputTokens: 9999, cachedInputTokens: 8888 }), null);
});
check('contextUsedTokens undefined 返回 null', () => {
  assert.equal(deriveCurrentContextUsed({ contextUsedTokens: undefined, inputTokens: 9999, cachedInputTokens: 8888 }), null);
});
check('contextUsedTokens 非法（负数/NaN）返回 null', () => {
  assert.equal(deriveCurrentContextUsed({ contextUsedTokens: -1, inputTokens: 9999, cachedInputTokens: 8888 }), null);
  assert.equal(deriveCurrentContextUsed({ contextUsedTokens: Number.NaN, inputTokens: 9999, cachedInputTokens: 8888 }), null);
});

console.log('=== 2) Task 7: classifyUsageFreshness — 新鲜度分类 ===');
check('仅 turn usage → estimated', () => {
  assert.equal(classifyUsageFreshness({ contextUsedTokens: null, inputTokens: 9999 }), 'estimated');
});
check('有当前窗口 → live', () => {
  assert.equal(classifyUsageFreshness({ contextUsedTokens: 1234, inputTokens: 9999 }), 'live');
});
check('全无 → pending', () => {
  assert.equal(classifyUsageFreshness({ contextUsedTokens: null, inputTokens: null }), 'pending');
});

console.log('=== 3) Task 10: parseTokenNumber — k/m 后缀解析 ===');
check('k 后缀', () => assert.equal(parseTokenNumber('19.7k'), 19700));
check('m 后缀', () => assert.equal(parseTokenNumber('1m'), 1000000));
check('整数', () => assert.equal(parseTokenNumber('211'), 211));
check('小数无后缀', () => assert.equal(parseTokenNumber('226.3'), 226));
check('非法返回 null', () => {
  assert.equal(parseTokenNumber('abc'), null);
  assert.equal(parseTokenNumber(''), null);
  assert.equal(parseTokenNumber(null), null);
});

console.log('=== 4) Task 10: parseNativeContextReport — 真实 /context 原文 ===');
check('真实格式（**Tokens:** 19.7k / 1m (2%)）解析 used/max/pct', () => {
  const r = parseNativeContextReport('## Context Usage\n\n**Model:** deepseek-v4-flash  \n**Tokens:** 19.7k / 1m (2%)\n');
  assert.ok(r, '应解析成功');
  assert.equal(r!.usedTokens, 19700);
  assert.equal(r!.maxTokens, 1000000);
  assert.equal(r!.percentage, 2);
  assert.equal(r!.model, 'deepseek-v4-flash');
});
check('紧凑变体（226.3k/1m tokens (23%)）', () => {
  const r = parseNativeContextReport('226.3k/1m tokens (23%)');
  assert.ok(r, '应解析成功');
  assert.equal(r!.usedTokens, 226300);
  assert.equal(r!.maxTokens, 1000000);
  assert.equal(r!.percentage, 23);
});
check('完整 category 表解析（System tools/Memory/Skills/Messages）', () => {
  const r = parseNativeContextReport(
    '**Tokens:** 40.1k / 1m (4%)\n' +
    '| Category | Tokens | Percentage |\n| System tools | 14.3k | 1.4% |\n| Memory files | 211 | 0.0% |\n| Skills | 5.2k | 0.5% |\n| Messages | 20.4k | 2.0% |\n| Free space | 926.9k | 92.7% |\n| Autocompact buffer | 33k | 3.3% |\n',
  );
  assert.ok(r);
  assert.equal(r!.categories.length, 6);
  assert.equal(r!.categories[0].name, 'System tools');
  assert.equal(r!.categories[0].tokens, 14300);
  assert.equal(r!.categories[3].tokens, 20400);
});
check('不完整（无 tokens 行）返回 null', () => {
  assert.equal(parseNativeContextReport('hello world'), null);
  assert.equal(parseNativeContextReport(''), null);
  assert.equal(parseNativeContextReport(null), null);
});
check('百分比与 used/max 不一致返回 null', () => {
  assert.equal(parseNativeContextReport('**Tokens:** 50k / 1m (90%)'), null);
});
check('多来源冲突返回 null', () => {
  assert.equal(parseNativeContextReport('**Tokens:** 10k / 1m (1%)\n**Tokens:** 20k / 1m (2%)'), null);
});
check('[synthetic] 不支持的网关响应返回 null（不猜测）', () => {
  // 真实观察到网关 502：Upstream service temporarily unavailable / JSON error，必须返回 null。
  assert.equal(parseNativeContextReport('Upstream service temporarily unavailable'), null);
  assert.equal(parseNativeContextReport('{"error":{"type":"upstream_error"}}'), null);
});

console.log('=== 5) Task 7: reconcileContextUsage — runtime/native 对账 ===');
check('两者一致 → reconciled', () => {
  const r = reconcileContextUsage({
    runtimeUsedTokens: 24047, runtimeCapacityTokens: 1000000, runtimePercentage: 2,
    nativeUsedTokens: 24000, nativeCapacityTokens: 1000000, nativePercentage: 2,
  });
  assert.equal(r.consistency, 'reconciled');
  assert.equal(r.usedTokens, 24047);
});
check('runtime 缺失 native 可用 → unavailable + 保留 native', () => {
  const r = reconcileContextUsage({
    runtimeUsedTokens: null, runtimeCapacityTokens: null, runtimePercentage: null,
    nativeUsedTokens: 19700, nativeCapacityTokens: 1000000, nativePercentage: 2,
  });
  assert.equal(r.consistency, 'unavailable');
  assert.equal(r.usedTokens, 19700);
});
check('两者都缺失 → unavailable + null', () => {
  const r = reconcileContextUsage({
    runtimeUsedTokens: null, runtimeCapacityTokens: null, runtimePercentage: null,
    nativeUsedTokens: null, nativeCapacityTokens: null, nativePercentage: null,
  });
  assert.equal(r.consistency, 'unavailable');
  assert.equal(r.usedTokens, null);
});
check('明显不一致 → mismatch', () => {
  const r = reconcileContextUsage({
    runtimeUsedTokens: 104474, runtimeCapacityTokens: 1000000, runtimePercentage: 10,
    nativeUsedTokens: 40100, nativeCapacityTokens: 1000000, nativePercentage: 4,
  });
  assert.equal(r.consistency, 'mismatch');
});

console.log('=== 6) extractContextTokens 语义（turn usage，非当前窗口）===');
check('input+cache 求和 = turn usage', () => {
  assert.equal(extractContextTokens({ input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 300 }), 1500);
});
check('缺字段按 0', () => {
  assert.equal(extractContextTokens(undefined), 0);
  assert.equal(extractContextTokens({}), 0);
});

console.log('=== 7) detectCompaction 回归 ===');
check('compact_boundary 检测', () => {
  const r = detectCompaction({ type: 'system', subtype: 'compact_boundary' } as never);
  assert.ok(r);
  assert.equal(r!.compactedJustNow, true);
});
check('非压缩事件返回 null', () => {
  assert.equal(detectCompaction({ type: 'system', subtype: 'informational' } as never), null);
  assert.equal(detectCompaction({ type: 'message' } as never), null);
});

console.log('=== 8) 结构接线契约（Task 9/12）===');
const sdkBackendSrc = readFileSync(resolve('src/main/modules/sdk-backend.ts'), 'utf8');
const sessionStoreSrc = readFileSync(resolve('src/renderer/stores/session-store.ts'), 'utf8');
const contextButtonSrc = readFileSync(resolve('src/renderer/components/chat/ContextButton.vue'), 'utf8');

check('sdk-backend 使用 getContextUsage 刷新 runtime 快照（refreshContextSnapshot）', () => {
  assert.ok(/refreshContextSnapshot/.test(sdkBackendSrc), '缺 refreshContextSnapshot');
  assert.ok(/query\.getContextUsage\(\)/.test(sdkBackendSrc), '缺 query.getContextUsage() 调用');
});
check('sdk-backend 不再用 extractContextTokens 生成当前窗口主值（只作 turn usage）', () => {
  // 仅允许 extractContextTokens 出现在 turn usage 赋值处（turnInputTokens = extractContextTokens）。
  const matches = [...sdkBackendSrc.matchAll(/extractContextTokens/g)];
  assert.ok(matches.length >= 1, 'extractContextTokens 应仍被用于 turn usage');
  // currentContextUsedTokens 必须来自 deriveCurrentContextUsed(getContextUsage)，不是 extractContextTokens。
  assert.ok(/currentContextUsedTokens:\s*used/.test(sdkBackendSrc) || /deriveCurrentContextUsed/.test(sdkBackendSrc), '当前窗口主值应来自 deriveCurrentContextUsed');
});
check('session-store 单一 canonical 真相源（canonicalContext，非并行 contextSnapshots/nativeReports）', () => {
  assert.ok(/canonicalContext/.test(sessionStoreSrc), '缺 canonicalContext');
  assert.ok(!/contextSnapshots/.test(sessionStoreSrc), '不应有并行 contextSnapshots');
  assert.ok(!/contextNativeReports/.test(sessionStoreSrc), '不应有并行 contextNativeReports');
});
check('session-store 无遗留 contextUsage 旧 state（review-v2 证据缺口 3）', () => {
  // contextUsage 旧字段已删除，turn usage 只经 canonicalContext；残留只允许出现在注释文本。
  const noCodeRef = !/contextUsage:\s*null/.test(sessionStoreSrc) && !/this\.contextUsage\s*=/.test(sessionStoreSrc);
  assert.ok(noCodeRef, '仍存在 contextUsage state 字段或其赋值');
});
check('ContextButton 不默认 200000/0%（pending 而非伪造）', () => {
  assert.ok(!/DEFAULT_WINDOW\s*=\s*200000/.test(contextButtonSrc), '不应硬编码 200000');
  assert.ok(/hasTrustedCurrent/.test(contextButtonSrc), '应有可信当前窗口判定');
  assert.ok(/待刷新/.test(contextButtonSrc), '无数据应显示待刷新');
});
check('CDP 复用共享 parser runner（.mjs 不复制 used/max regex）', () => {
  const cdp = readFileSync(resolve('scripts/cdp-context-e2e.mjs'), 'utf8');
  assert.ok(/native-context-parser-runner/.test(cdp), 'cdp-context-e2e.mjs 应引用共享 runner');
  assert.ok(!/\*\*Tokens:\*\*/.test(cdp), 'cdp-context-e2e.mjs 不得复制 used/max 正则');
});

console.log('=== 9) review-v2 修复的结构契约 ===');
check('refreshContextSnapshot 绑定 query identity 守卫（entries.get + entry.query + queryInstance）', () => {
  // High#2：迟到快照必须同时校验 entries.get(sessionId)===entry、entry.query===query、queryInstance 不变。
  assert.ok(/entries\.get\(sessionId\) !== entry/.test(sdkBackendSrc), '缺 entry identity 校验');
  assert.ok(/entry\.query !== query/.test(sdkBackendSrc), '缺 query identity 校验');
  assert.ok(/queryInstance/.test(sdkBackendSrc), '缺 queryInstance 守卫');
});
check('compact_boundary 不再携带 compactedJustNow（成功标记延迟到 fresh 快照）', () => {
  // High#3：detectCompaction 分支的 payload 不得有 compactedJustNow:true；
  // 只有 refreshContextSnapshot 的 opts.compactedJustNow && used!=null 才附加。
  const compactStart = sdkBackendSrc.indexOf('const compaction = detectCompaction(event);');
  const refreshStart = sdkBackendSrc.indexOf('// ── runtime 当前窗口快照');
  const compactBranch = sdkBackendSrc.slice(compactStart, refreshStart);
  assert.ok(compactStart >= 0 && refreshStart > compactStart, '切片边界异常');
  assert.ok(!/compactedJustNow:\s*true/.test(compactBranch), 'compact_boundary payload 仍携带 compactedJustNow');
  assert.ok(/opts\.compactedJustNow && used != null/.test(sdkBackendSrc), '成功标记应延迟到 fresh 快照');
});
check('renderer compactedJustNow 双保险（共享 shouldShowCompactedBanner 单源）', () => {
  // review-v3：双保险语义移入 shared/context-usage.ts 的 shouldShowCompactedBanner
  // （行为测试见 §13 四时序），store 只调用不复制；严格判等条件在共享函数内。
  const sharedSrc = readFileSync(resolve('src/shared/context-usage.ts'), 'utf8');
  assert.ok(/shouldShowCompactedBanner\(payload\)/.test(sessionStoreSrc), 'renderer 应调用共享纯函数');
  assert.ok(/compactedJustNow === true/.test(sharedSrc), '共享函数缺 compactedJustNow 严格判等');
  assert.ok(/freshness === 'fresh'/.test(sharedSrc), '共享函数缺 freshness fresh 守卫');
  assert.ok(/source === 'runtime-live' \|\| payload\.source === 'reconciled'|source === 'runtime-live' \|\| .*source === 'reconciled'/.test(sharedSrc), '共享函数缺 source 可信守卫');
});
check('生产链路接通 /context 解析 + reconcile（isContextCommand/emitNativeContextReconcile）', () => {
  // Blocker：/context 原生输出必须 parse + reconcile，不能只落库不解析。
  assert.ok(/isContextCommand/.test(sdkBackendSrc), '缺 isContextCommand');
  assert.ok(/emitNativeContextReconcile/.test(sdkBackendSrc), '缺 emitNativeContextReconcile');
  assert.ok(/parseNativeContextReport/.test(sdkBackendSrc), '缺 parseNativeContextReport 调用');
  assert.ok(/reconcileContextUsage/.test(sdkBackendSrc), '缺 reconcileContextUsage 调用');
});

console.log('=== 10) review-v3 High-1: isRuntimeSnapshotForQuery — 快照代际判定 ===');
const snapOf = (over: Partial<RuntimeContextSnapshot>): RuntimeContextSnapshot => ({
  usedTokens: 24047,
  capacityTokens: 1000000,
  percentage: 2,
  queryInstance: 2,
  capturedAt: 200,
  ...over,
});
check('旧回合快照（queryInstance=1）不得判给新回合（queryInstance=2）', () => {
  assert.equal(isRuntimeSnapshotForQuery(snapOf({ queryInstance: 1 }), 2), false);
});
check('同代快照判 true', () => {
  assert.equal(isRuntimeSnapshotForQuery(snapOf({ queryInstance: 2 }), 2), true);
});
check('null/undefined 快照判 false', () => {
  assert.equal(isRuntimeSnapshotForQuery(null, 2), false);
  assert.equal(isRuntimeSnapshotForQuery(undefined, 2), false);
});
check('capturedAt 早于本回合开始（capturedAfter）判 false（防御性）', () => {
  assert.equal(isRuntimeSnapshotForQuery(snapOf({ queryInstance: 2, capturedAt: 100 }), 2, { capturedAfter: 150 }), false);
  assert.equal(isRuntimeSnapshotForQuery(snapOf({ queryInstance: 2, capturedAt: 150 }), 2, { capturedAfter: 150 }), true);
});
check('capturedAt 缺失/非法判 false', () => {
  assert.equal(isRuntimeSnapshotForQuery(snapOf({ capturedAt: Number.NaN }), 2), false);
  assert.equal(isRuntimeSnapshotForQuery({ ...snapOf(), capturedAt: undefined as unknown as number }, 2), false);
});

console.log('=== 11) review-v3 High-1: 旧 runtime 不参与新 /context 对账（终态语义）===');
const nativeText = '## Context Usage\n\n**Tokens:** 24.0k / 1m (2%)\n';
check('旧 runtime + 新 /context native → 不得 reconciled（走 native-only fresh）', () => {
  // 调用方按代际筛选：旧快照 → null。reconcile 收不到 runtime → 不可能 reconciled。
  const oldSnapshot = snapOf({ queryInstance: 1, usedTokens: 24000 });
  const filtered = isRuntimeSnapshotForQuery(oldSnapshot, 2) ? oldSnapshot : null;
  assert.equal(filtered, null);
  const native = parseNativeContextReport(nativeText);
  assert.ok(native);
  const rec = reconcileContextUsage({
    runtimeUsedTokens: filtered?.usedTokens ?? null,
    runtimeCapacityTokens: filtered?.capacityTokens ?? null,
    runtimePercentage: filtered?.percentage ?? null,
    nativeUsedTokens: native!.usedTokens,
    nativeCapacityTokens: native!.maxTokens,
    nativePercentage: native!.percentage,
  });
  assert.notEqual(rec.consistency, 'reconciled');
  const terminal = mapContextReconcileTerminal({ consistency: rec.consistency, hasRuntime: false, hasNative: true });
  assert.equal(terminal.source, 'native-context');
  assert.equal(terminal.freshness, 'fresh');
});
check('同代 runtime + 当前 native → 允许 reconciled + fresh', () => {
  const native = parseNativeContextReport(nativeText);
  assert.ok(native);
  const rec = reconcileContextUsage({
    runtimeUsedTokens: 24047, runtimeCapacityTokens: 1000000, runtimePercentage: 2,
    nativeUsedTokens: native!.usedTokens, nativeCapacityTokens: native!.maxTokens, nativePercentage: native!.percentage,
  });
  assert.equal(rec.consistency, 'reconciled');
  const terminal = mapContextReconcileTerminal({ consistency: rec.consistency, hasRuntime: true, hasNative: true });
  assert.equal(terminal.source, 'reconciled');
  assert.equal(terminal.freshness, 'fresh');
});
check('同代但数值冲突 → mismatch → unavailable + stale', () => {
  const terminal = mapContextReconcileTerminal({ consistency: 'mismatch', hasRuntime: true, hasNative: true });
  assert.equal(terminal.source, 'unavailable');
  assert.equal(terminal.freshness, 'stale');
});
check('runtime 缺失 + native 也缺失 → unavailable + pending', () => {
  const terminal = mapContextReconcileTerminal({ consistency: 'unavailable', hasRuntime: false, hasNative: false });
  assert.equal(terminal.source, 'unavailable');
  assert.equal(terminal.freshness, 'pending');
});
check('仅 runtime（native 空/解析失败）→ unavailable + stale（不伪装 fresh）', () => {
  const terminal = mapContextReconcileTerminal({ consistency: 'unavailable', hasRuntime: true, hasNative: false });
  assert.equal(terminal.source, 'unavailable');
  assert.equal(terminal.freshness, 'stale');
});

console.log('=== 12) review-v3 High-2: shouldAcceptContextPayload — renderer 代际门 ===');
check('known=2 收 gen=1（旧回合迟到）→ 拒收且 known 不变', () => {
  const r = shouldAcceptContextPayload(2, 1);
  assert.equal(r.accept, false);
  assert.equal(r.nextKnownGeneration, 2);
});
check('known=2 收 gen=2（同回合）→ 接收', () => {
  const r = shouldAcceptContextPayload(2, 2);
  assert.equal(r.accept, true);
  assert.equal(r.nextKnownGeneration, 2);
});
check('known=2 收缺代际 payload → 拒收（已知代际时缺失即拒）', () => {
  const r = shouldAcceptContextPayload(2, undefined);
  assert.equal(r.accept, false);
  assert.equal(r.nextKnownGeneration, 2);
});
check('known=2 收 gen=3（新回合）→ 接收且 known=3', () => {
  const r = shouldAcceptContextPayload(2, 3);
  assert.equal(r.accept, true);
  assert.equal(r.nextKnownGeneration, 3);
});
check('无 known 收缺代际 → 仅允许兼容初始化（接收，不建立 known）', () => {
  const r = shouldAcceptContextPayload(undefined, undefined);
  assert.equal(r.accept, true);
  assert.equal(r.nextKnownGeneration, undefined);
});
check('无 known 收 gen=5 → 接收并建立 known=5', () => {
  const r = shouldAcceptContextPayload(undefined, 5);
  assert.equal(r.accept, true);
  assert.equal(r.nextKnownGeneration, 5);
});
check('[乱序模型] A-start→B-start→A-late：最终代际仍属于 B', () => {
  // A-start：首包建立 known=1；B-start：gen=2 接收推进；A-late：gen=1 拒收。
  let known: number | undefined = undefined;
  const a1 = shouldAcceptContextPayload(known, 1);
  assert.equal(a1.accept, true);
  known = a1.nextKnownGeneration;
  const b1 = shouldAcceptContextPayload(known, 2);
  assert.equal(b1.accept, true);
  known = b1.nextKnownGeneration;
  const aLate = shouldAcceptContextPayload(known, 1);
  assert.equal(aLate.accept, false);
  known = aLate.nextKnownGeneration;
  assert.equal(known, 2, '最终 canonical 状态应停留在 B 的代际');
});

console.log('=== 13) review-v3 §5.3: shouldShowCompactedBanner — 压缩成功横幅四时序 ===');
check('时序1 compact_boundary pending（无 compactedJustNow）→ 不显示成功', () => {
  assert.equal(shouldShowCompactedBanner({ freshness: 'pending', source: 'unavailable' }), false);
});
check('时序2 compact_result failed（无 fresh payload）→ 不显示成功', () => {
  assert.equal(shouldShowCompactedBanner({ freshness: 'stale', source: 'unavailable' }), false);
});
check('时序3 compact_result success + refresh timeout（无 payload）→ 不显示成功', () => {
  assert.equal(shouldShowCompactedBanner({}), false);
});
check('时序4 success + 同代 fresh snapshot（runtime-live）→ 显示成功', () => {
  assert.equal(shouldShowCompactedBanner({ compactedJustNow: true, freshness: 'fresh', source: 'runtime-live' }), true);
});
check('时序4 变体：reconciled + fresh 也显示成功', () => {
  assert.equal(shouldShowCompactedBanner({ compactedJustNow: true, freshness: 'fresh', source: 'reconciled' }), true);
});
check('防御：compactedJustNow 但 freshness 非 fresh / source 不可信 → 不显示', () => {
  assert.equal(shouldShowCompactedBanner({ compactedJustNow: true, freshness: 'stale', source: 'runtime-live' }), false);
  assert.equal(shouldShowCompactedBanner({ compactedJustNow: true, freshness: 'fresh', source: 'estimated-turn-usage' }), false);
  // Step 3b：native-context 已扩入可信 source 集合（post-turn 探针 fresh 值可触发横幅）。
  assert.equal(shouldShowCompactedBanner({ compactedJustNow: true, freshness: 'fresh', source: 'native-context' }), true);
});

console.log('=== 14) review-v3 结构契约 ===');
const ipcSrc = readFileSync(resolve('src/shared/types/ipc.ts'), 'utf8');
check('ContextStatsPayload 声明必填 queryGeneration', () => {
  assert.ok(/queryGeneration:\s*number;/.test(ipcSrc), 'ContextStatsPayload 缺必填 queryGeneration');
  assert.ok(/refreshedAt\??:\s*number \| null/.test(ipcSrc), '缺 refreshedAt 采样时间字段');
});
check('sdk-backend 所有 CONTEXT_UPDATE payload 构造路径都填 queryGeneration', () => {
  const sites = [...sdkBackendSrc.matchAll(/payload: ContextStatsPayload = \{/g)];
  assert.ok(sites.length >= 4, `payload 构造点应 ≥4（turn usage/compact pending/runtime/native），实际 ${sites.length}`);
  for (const site of sites) {
    const segment = sdkBackendSrc.slice(site.index!, sdkBackendSrc.indexOf('};', site.index!));
    assert.ok(/queryGeneration:/.test(segment), `payload 构造点（offset ${site.index}）缺 queryGeneration`);
  }
});
check('runtime 快照写入必须带 queryInstance + capturedAt（sessionRuntimeSnapshot.set）', () => {
  const setIdx = sdkBackendSrc.indexOf('sessionRuntimeSnapshot.set(sessionId, {');
  assert.ok(setIdx >= 0, '缺 sessionRuntimeSnapshot.set');
  const segment = sdkBackendSrc.slice(setIdx, sdkBackendSrc.indexOf('});', setIdx));
  assert.ok(/queryInstance/.test(segment), '快照写入缺 queryInstance');
  assert.ok(/capturedAt/.test(segment), '快照写入缺 capturedAt');
});
check('emitNativeContextReconcile 不再无条件读 session-wide Map（签名收 runtimeSnapshot + 防御复查）', () => {
  assert.ok(/function emitNativeContextReconcile\([\s\S]*?runtimeSnapshot: RuntimeContextSnapshot \| null/.test(sdkBackendSrc), '签名应显式接收筛选后的快照');
  assert.ok(/isRuntimeSnapshotForQuery\(runtimeSnapshot, entry\.queryInstance\) \? runtimeSnapshot : null/.test(sdkBackendSrc), '函数内部应防御性复查代际');
  // 函数体内不得再出现直接读 Map 的旧逻辑（sessionRuntimeSnapshot.get 只允许在调用方筛选处）。
  const fnStart = sdkBackendSrc.indexOf('function emitNativeContextReconcile(');
  const fnEnd = sdkBackendSrc.indexOf('\n}', fnStart);
  const fnBody = sdkBackendSrc.slice(fnStart, fnEnd);
  assert.ok(!/sessionRuntimeSnapshot\.get/.test(fnBody), '函数体内不得自行读 session-wide Map');
});
check('renderer 代际门接线（contextQueryGenerations + shouldAcceptContextPayload + 删除清理）', () => {
  assert.ok(/contextQueryGenerations:\s*\{\}/.test(sessionStoreSrc), '缺 contextQueryGenerations state');
  assert.ok(/shouldAcceptContextPayload\(this\.contextQueryGenerations\[payload\.sessionId\], payload\.queryGeneration\)/.test(sessionStoreSrc), '缺代际门调用');
  assert.ok(/if \(!gate\.accept\) return;/.test(sessionStoreSrc), '缺拒收分支');
  assert.ok(/delete this\.contextQueryGenerations\[id\]/.test(sessionStoreSrc), 'deleteSession 未清理代际记录');
});
check('压缩横幅双保险改用共享 shouldShowCompactedBanner（语义单源）', () => {
  assert.ok(/shouldShowCompactedBanner\(payload\)/.test(sessionStoreSrc), 'renderer 应调用共享纯函数');
});
check('终态映射共享单源（mapContextReconcileTerminal，主进程不在函数内复制 if 链）', () => {
  assert.ok(/mapContextReconcileTerminal/.test(sdkBackendSrc), '主进程应使用共享映射');
  assert.ok(!/source = 'native-context';\s*\n\s*freshness = 'fresh';/.test(sdkBackendSrc), '不得残留内联映射分支');
});

console.log('=== 15) review-v4 Medium-1: stripAnsi + ANSI fixture 解析 ===');
check('stripAnsi 剥离 CSI/OSC/回车控制码', () => {
  assert.equal(stripAnsi('\u001b[1m**Tokens:**\u001b[0m 19.7k / 1m (2%)'), '**Tokens:** 19.7k / 1m (2%)');
  assert.equal(stripAnsi('\u001b]0;title\u0007plain'), 'plain');
  assert.equal(stripAnsi('a\rb'), 'ab');
  assert.equal(stripAnsi(null), '');
});
check('[observed 格式 + ANSI] Tokens 行带控制码仍可解析', () => {
  const r = parseNativeContextReport('\u001b[1m**Tokens:**\u001b[0m \u001b[32m19.7k\u001b[0m / \u001b[33m1m\u001b[0m (2%)');
  assert.ok(r, 'ANSI 包裹的 tokens 行应解析成功');
  assert.equal(r!.usedTokens, 19700);
  assert.equal(r!.maxTokens, 1000000);
  assert.equal(r!.percentage, 2);
});
check('[synthetic + ANSI] model 行与 category 表带控制码仍可解析', () => {
  const r = parseNativeContextReport(
    '## Context Usage\n\n\u001b[1m**Model:**\u001b[0m deepseek-v4-flash  \n\u001b[1m**Tokens:**\u001b[0m 40.1k / 1m (4%)\n' +
    '| Category | Tokens | Percentage |\n| \u001b[36mSystem tools\u001b[0m | 14.3k | 1.4% |\n| Memory files | 211 | 0.0% |',
  );
  assert.ok(r);
  assert.equal(r!.model, 'deepseek-v4-flash');
  assert.equal(r!.categories[0].name, 'System tools');
  assert.equal(r!.categories[0].tokens, 14300);
});
check('无 ANSI 的既有 fixture 不回归 + 不可解析响应仍保守 null', () => {
  assert.ok(parseNativeContextReport('**Tokens:** 19.7k / 1m (2%)'));
  assert.equal(parseNativeContextReport('Upstream service temporarily unavailable'), null);
  assert.equal(parseNativeContextReport('\u001b[31mUpstream service temporarily unavailable\u001b[0m'), null);
});

console.log('=== 16) review-v4 Medium-2: hasCompleteCanonicalFields 字段完整性 ===');
const completePayload = {
  queryGeneration: 3,
  source: 'runtime-live',
  freshness: 'fresh',
  consistency: 'unavailable',
  diagnostic: null,
  currentContextUsedTokens: 24000,
  contextWindowCapacityTokens: 1000000,
  currentContextUsedPercent: 2,
  currentContextRemainingTokens: 976000,
  currentContextRemainingPercent: 98,
  turnInputTokens: null,
  turnCacheReadTokens: null,
  turnCacheCreationTokens: null,
  turnOutputTokens: null,
  refreshedAt: 123,
  samplePhase: 'post-turn',
};
check('全字段 payload → true', () => {
  assert.equal(hasCompleteCanonicalFields(completePayload), true);
});
check('缺任一 canonical 字段（undefined）→ false（不与 prev 拼接）', () => {
  for (const key of Object.keys(completePayload)) {
    const partial = { ...completePayload };
    delete (partial as Record<string, unknown>)[key];
    assert.equal(hasCompleteCanonicalFields(partial), false, `缺 ${key} 应判不完整`);
  }
});
check('null 是合法值（≠缺字段）→ true；非对象 → false', () => {
  const nullHeavy = Object.fromEntries(Object.entries(completePayload).map(([k, v]) => [k, v ?? null]));
  assert.equal(hasCompleteCanonicalFields(nullHeavy), true);
  assert.equal(hasCompleteCanonicalFields(null), false);
  assert.equal(hasCompleteCanonicalFields('x'), false);
});

console.log('=== 17) review-v4 High-1: postTurnFallbackTerminal 采样时点语义 ===');
check('post-turn 不可得 → unavailable + stale + diagnostic 含采样阶段（不得 fresh）', () => {
  const t = postTurnFallbackTerminal('query-start');
  assert.equal(t.source, 'unavailable');
  assert.equal(t.freshness, 'stale');
  assert.ok(t.diagnostic.includes('query-start'), 'diagnostic 应包含上一采样阶段');
  assert.notEqual(t.freshness, 'fresh');
  const unknown = postTurnFallbackTerminal(null);
  assert.equal(unknown.freshness, 'stale');
  assert.ok(unknown.diagnostic.includes('未知'));
});
check('同代 post-turn 快照可通过代际判定（阶段标记在快照上）', () => {
  const snap = snapOf({ queryInstance: 7, samplePhase: 'post-turn' });
  assert.ok(isRuntimeSnapshotForQuery(snap, 7));
  assert.equal(snap.samplePhase, 'post-turn');
});

console.log('=== 18) review-v4 结构契约（E2E 门禁可信度 + 采样接线）===');
const cdpE2eSrc = readFileSync(resolve('scripts/cdp-context-e2e.mjs'), 'utf8');
check('CDP 连接失败 → PreconditionError（exit 2），不落 FATAL', () => {
  assert.ok(/CDP \$\{CDP_PORT\} 无法连接/.test(cdpE2eSrc), 'fetch 失败应转 PreconditionError');
  assert.ok(/CDP WebSocket 无法建立/.test(cdpE2eSrc), 'WebSocket 失败应转 PreconditionError');
  assert.ok(/process\.env\.CDP_PORT/.test(cdpE2eSrc), '应支持 CDP_PORT 环境变量覆盖（供无 app 协议测试）');
});
check('setWorkingDir 两参调用（修复 sid 错位）+ 设置后复核 workingDir', () => {
  assert.ok(!/setWorkingDir\(ws,\s*s(id|idB),/.test(cdpE2eSrc), '不得残留三参错位调用');
  assert.ok(/setWorkingDir\(ws, CWD\)/.test(cdpE2eSrc), '应按 (ws, CWD) 两参调用');
  assert.ok(/assertWorkingDir\(ws,\s*s(id|idB),\s*CWD\)/.test(cdpE2eSrc), '设置后应从 session 记录复核 workingDir');
});
check('工具场景前置 ensurePermissionMode(bypassPermissions)（S3 前设置）', () => {
  assert.ok(/ensurePermissionMode\(ws, sid, 'bypassPermissions', '自动模式'\)/.test(cdpE2eSrc), 'S3 前应经真实 UI 切自动模式');
  assert.ok(cdpE2eSrc.indexOf("ensurePermissionMode(ws, sid, 'bypassPermissions'") < cdpE2eSrc.indexOf("'S3 小文件"), '权限设置应先于 S3 场景');
  assert.ok(/permissionMode: sess\?\.permissionMode/.test(cdpE2eSrc), '场景证据应记录 permissionMode');
});
check('S12/S7 未执行 → checkSkipped 不计 pass + envLimited（exit 3）', () => {
  assert.ok(/function checkSkipped/.test(cdpE2eSrc), '应有 skipped 语义');
  assert.ok(cdpE2eSrc.includes("checkSkipped('S12 restart/resume"), 'S12 未执行应走 skipped');
  assert.ok(/envLimited = envLimited \?\? reason/.test(cdpE2eSrc), '未执行场景应设 envLimited → exit 3');
  assert.ok(/skipped\+\+/.test(cdpE2eSrc) && !/pass\+\+;\s*\n\s*log\(`  ⏭/.test(cdpE2eSrc), 'skipped 不得计入 pass');
});
check('result 分支在 deleteEntry 前 awaited post-turn 刷新（方案A）且失败走方案B', () => {
  const resultIdx = sdkBackendSrc.indexOf("if (type === 'result')");
  const refreshIdx = sdkBackendSrc.indexOf("await refreshContextSnapshot(sessionId, mainWindow, entry, query, { samplePhase: 'post-turn' })");
  const deleteIdx = sdkBackendSrc.indexOf('deleteEntry(sessionId, entry);', resultIdx);
  assert.ok(resultIdx >= 0 && refreshIdx > resultIdx && deleteIdx > refreshIdx, 'post-turn 刷新必须在 result 分支内、deleteEntry 之前 await');
  assert.ok(/samplePhase: 'query-start'/.test(sdkBackendSrc), 'init 采样应标记 query-start');
  assert.ok(/samplePhase: 'post-compaction'/.test(sdkBackendSrc), '压缩后采样应标记 post-compaction');
  assert.ok(/postTurnFallbackTerminal\(/.test(sdkBackendSrc), '失败路径应走 postTurnFallbackTerminal（方案B 显式降级）');
});
check('快照写入带 samplePhase + renderer 完整性门接线', () => {
  const setIdx = sdkBackendSrc.indexOf('sessionRuntimeSnapshot.set(sessionId, {');
  const segment = sdkBackendSrc.slice(setIdx, sdkBackendSrc.indexOf('});', setIdx));
  assert.ok(/samplePhase: opts\.samplePhase/.test(segment), '快照写入缺 samplePhase');
  assert.ok(/hasCompleteCanonicalFields\(payload\)/.test(sessionStoreSrc), 'renderer 应有字段完整性拒收门');
  assert.ok(/samplePhase: payload\.samplePhase \?\? null/.test(sessionStoreSrc), 'canonical state 应透传 samplePhase');
});
check('parser runner 直调 node+tsx cli（Windows spawnSync(npx) ENOENT 修复）', () => {
  assert.ok(/process\.execPath, \[tsxCli, 'scripts\/native-context-parser-runner\.ts'\]/.test(cdpE2eSrc), '应优先 node 直调仓库内 tsx cli');
  assert.ok(/fs\.existsSync\(tsxCli\)/.test(cdpE2eSrc), '应有 tsx cli 存在性判定（缺失才回退 npx）');
  const npxFallback = cdpE2eSrc.match(/spawnSync\('npx',\s*\[[^\]]+\],\s*\{[^}]*shell: true/s);
  assert.ok(npxFallback, 'npx 回退路径必须带 shell:true（.cmd 需要 shell 才能 spawn）');
});
check('runTurnWithEvidence 在回合空闲后重读本回合终态消息', () => {
  assert.ok(/const msgs = \(await getMessages\(ws, sid\)\)\.slice\(baseCount\);/.test(cdpE2eSrc), '应以 baseCount 截取本回合消息');
  assert.ok(/\[\.\.\.msgs\]\.reverse\(\)\.find\(/.test(cdpE2eSrc), '应从后向前找最后一条终态消息（工具回合叙述消息先落库）');
  const idleIdx = cdpE2eSrc.indexOf('await waitQueryIdle(ws, timeoutS);', cdpE2eSrc.indexOf('async function runTurnWithEvidence'));
  const rereadIdx = cdpE2eSrc.indexOf('const msgs = (await getMessages(ws, sid)).slice(baseCount);');
  assert.ok(idleIdx >= 0 && rereadIdx > idleIdx, '终态消息重读必须发生在 waitQueryIdle 之后');
});
// ── review-v5：显示层最后一公里 ──
check('ContextButton popover 渲染具体 diagnostic（Medium-1）', () => {
  assert.ok(/eff\.diagnostic.*ctx__row--diag|ctx__row--diag[\s\S]{0,200}eff\.diagnostic/.test(contextButtonSrc), 'popover 应有渲染 eff.diagnostic 的诊断行');
  assert.ok(/data-testid="ctx-diag-row"/.test(contextButtonSrc), '诊断行应有 testid（供 CDP DOM 断言定位）');
  assert.ok(/diagPreview/.test(contextButtonSrc) && /d\.length > 80/.test(contextButtonSrc), '诊断文本应截断展示（全文放 title）');
});
check('stale 态 title 标注「上次采样」（Low-1）', () => {
  assert.ok(/isStaleTrusted/.test(contextButtonSrc) && /eff\.value\.freshness !== 'fresh'/.test(contextButtonSrc), 'title 计算应引用 freshness 区分 fresh/stale');
  assert.ok(/上次采样/.test(contextButtonSrc), 'stale 态 title 文案应含「上次采样」');
  assert.ok(/ctx__btn--stale/.test(contextButtonSrc) && /stroke-opacity/.test(contextButtonSrc), 'stale 态圆环应降透明度与 fresh 区分');
});
check('shouldPreserve 优先透传 payload.diagnostic（Medium-1 配套）', () => {
  const m = sessionStoreSrc.match(/diagnostic: hasLive[\s\S]{0,220}/);
  assert.ok(m != null, '应存在 diagnostic 的 hasLive/shouldPreserve 三元链');
  assert.ok(m![0].includes("payload.diagnostic ?? '上次快照已过期，等待刷新'"), 'shouldPreserve 分支应优先 payload.diagnostic，缺省才用兜底文案');
});
check('S10 断言：顺序校验 + 禁 vacuous pass（Low-2）', () => {
  assert.ok(/vacuous pass 已禁止/.test(cdpE2eSrc), '/compact 回合零 payload 必须 fail');
  assert.ok(/pendingIdx > bannerIdx/.test(cdpE2eSrc), '应校验 pending 先于 banner 的顺序');
});
check('CDP DOM 断言接线：诊断行 + stale title（Medium-1/Low-1 验收）', () => {
  assert.ok(/function assertDiagAndTitle/.test(cdpE2eSrc), '应有 samplePopover/assertDiagAndTitle 断言助手');
  const s1Idx = cdpE2eSrc.indexOf("check('S1 ");
  // post-turn 官方探针（本计划 Task 5 S1 增强）：S1 回合结束探针 fresh 到达后，title 不得标
  // 「上次采样」——assertDiagAndTitle(ws, false) 断言 fresh 终态语义（不再用 !terminalFresh）。
  assert.ok(cdpE2eSrc.indexOf('assertDiagAndTitle(ws, false)', s1Idx) > 0, 'S1 探针 fresh 后应断言 title 不含上次采样');
  assert.ok(/waitForPostTurnProbe\(ws, sid, 10\)/.test(cdpE2eSrc), 'S1 应等待 post-turn 探针 fresh payload');
  assert.ok(/assertDiagAndTitle\(ws, !\(lp3\?\.source/.test(cdpE2eSrc), 'S3 应按终态断言 title 语义');
  assert.ok(/assertDiagAndTitle\(ws, !freshReconcile\)/.test(cdpE2eSrc), 'S9 fresh 对账终态不得标注上次采样');
});

// ── P2 mid-turn：回合中途轮询接线（docs/superpowers/plans/2026-08-22-mid-turn-context-refresh.md Task 5）──
console.log('=== 19) P2 mid-turn：回合中途轮询接线 ===');
check('mid-turn 触发接线：assistant 与 tool_result 落地后调用 maybeMidTurnRefresh', () => {
  const assistantIdx = sdkBackendSrc.indexOf("if (type === 'assistant')");
  const userIdx = sdkBackendSrc.indexOf("if (type === 'user')");
  assert.ok(assistantIdx >= 0 && userIdx > assistantIdx, '应存在 assistant/user 事件分支');
  assert.ok(/maybeMidTurnRefresh\(sessionId, mainWindow, entry, query\)/.test(sdkBackendSrc), '缺 maybeMidTurnRefresh 调用');
  const assistantCall = sdkBackendSrc.indexOf('maybeMidTurnRefresh(sessionId, mainWindow, entry, query)', assistantIdx);
  assert.ok(assistantCall > 0 && assistantCall < userIdx, 'assistant 分支内应调用 maybeMidTurnRefresh');
  assert.ok(sdkBackendSrc.indexOf('maybeMidTurnRefresh(sessionId, mainWindow, entry, query)', userIdx) > userIdx, 'user(tool_result) 分支内应调用 maybeMidTurnRefresh');
});
check('mid-turn 复用 refreshContextSnapshot(samplePhase: mid-turn)', () => {
  assert.ok(/samplePhase: 'mid-turn'/.test(sdkBackendSrc), 'mid-turn 采样应调用 refreshContextSnapshot 带 samplePhase');
});
check('mid-turn 节流 helper + 值变化门限常量存在', () => {
  assert.ok(/function maybeMidTurnRefresh/.test(sdkBackendSrc), '缺 maybeMidTurnRefresh helper');
  assert.ok(/MID_TURN_THROTTLE_MS\s*=\s*8000/.test(sdkBackendSrc), '缺 MID_TURN_THROTTLE_MS=8000');
  assert.ok(/MID_TURN_USED_DELTA_THRESHOLD\s*=\s*1000/.test(sdkBackendSrc), '缺 MID_TURN_USED_DELTA_THRESHOLD=1000');
  assert.ok(/MID_TURN_PCT_DELTA_THRESHOLD\s*=\s*0\.5/.test(sdkBackendSrc), '缺 MID_TURN_PCT_DELTA_THRESHOLD=0.5');
});
check('mid-turn 值变化门限：更新快照但跳过 payload 发送', () => {
  assert.ok(/samplePhase === 'mid-turn'/.test(sdkBackendSrc), '缺 mid-turn 值变化门限判定');
  assert.ok(/MID_TURN_USED_DELTA_THRESHOLD/.test(sdkBackendSrc) && /MID_TURN_PCT_DELTA_THRESHOLD/.test(sdkBackendSrc), '门限应引用常量');
});

// ── §20 post-turn 官方 /context 探针（docs/.../2026-08-22-post-turn-context-probe.md Task 4）──
console.log('=== 20) post-turn 官方 /context 探针：payload 纯函数 + 接线契约 ===');
// observed fixture：摘自 p2-probe-nopersist.jsonl（run-2026-08-2213290），真实报告原文。
const PROBE_FIXTURE =
  '## Context Usage\n\n**Model:** glm-5.2[1m]  \n**Tokens:** 22.1k / 1m (2%)\n\n### Estimated usage by category\n' +
  '| Category | Tokens | Percentage |\n| System prompt | 1.5k | 0.2% |\n| Messages | 2.1k | 0.2% |\n';
check('探针 markdown → parser → used=22100/max=1000000/pct=2（F1 数字，observed）', () => {
  const r = parseNativeContextReport(PROBE_FIXTURE);
  assert.ok(r, '应解析成功');
  assert.equal(r!.usedTokens, 22100);
  assert.equal(r!.maxTokens, 1000000);
  assert.equal(r!.percentage, 2);
});
check('derivePostTurnProbePayloadFields：16 canonical 字段齐全 + source/freshness/samplePhase 正确', () => {
  const r = parseNativeContextReport(PROBE_FIXTURE)!;
  const f = derivePostTurnProbePayloadFields(r, 7, 123);
  assert.equal(hasCompleteCanonicalFields(f), true, '应满足 16 canonical 字段完整性契约');
  assert.equal(f.source, 'native-context');
  assert.equal(f.freshness, 'fresh');
  assert.equal(f.samplePhase, 'post-turn');
  assert.equal(f.consistency, 'unavailable');
  assert.equal(f.diagnostic, null);
  assert.equal(f.queryGeneration, 7);
  assert.equal(f.currentContextUsedTokens, 22100);
  assert.equal(f.contextWindowCapacityTokens, 1000000);
  assert.equal(f.currentContextUsedPercent, 2);
  assert.equal(f.currentContextRemainingTokens, 977900);
  assert.equal(f.turnInputTokens, null);
});
check('shouldShowCompactedBanner：native-context + fresh + compactedJustNow=true → true（Step 3b 扩展）', () => {
  assert.equal(shouldShowCompactedBanner({ compactedJustNow: true, freshness: 'fresh', source: 'native-context' }), true);
});
check('shouldShowCompactedBanner：native-context + stale → 仍 false（§5.3 只有 fresh 才带标记，不回归）', () => {
  assert.equal(shouldShowCompactedBanner({ compactedJustNow: true, freshness: 'stale', source: 'native-context' }), false);
  assert.equal(shouldShowCompactedBanner({ compactedJustNow: false, freshness: 'fresh', source: 'native-context' }), false);
});
check('sdk-backend spawn 参数含 --no-session-persistence 与 --resume（字符串级，防回归）', () => {
  assert.ok(/'--no-session-persistence'/.test(sdkBackendSrc), 'spawn 参数缺 --no-session-persistence（漏掉即污染会话）');
  assert.ok(/'--resume'/.test(sdkBackendSrc), 'spawn 参数缺 --resume');
  assert.ok(/'-p',\s*'\/context'/.test(sdkBackendSrc) || /-p'?\s*,\s*'\/context'/.test(sdkBackendSrc), 'spawn 参数应为 -p /context');
});
check('result 分支 deleteEntry 后调用探针（顺序：deleteEntryIdx < probeCallIdx）', () => {
  const resultIdx = sdkBackendSrc.indexOf("if (type === 'result')");
  const deleteIdx = sdkBackendSrc.indexOf('deleteEntry(sessionId, entry);', resultIdx);
  const probeIdx = sdkBackendSrc.indexOf('schedulePostTurnProbe(sessionId, mainWindow, probeInstance', resultIdx);
  assert.ok(resultIdx >= 0 && deleteIdx > resultIdx && probeIdx > deleteIdx, '探针调度必须在 result 分支 deleteEntry 之后');
});
check('兜底挂点全覆盖（F9 表）：出口②③④⑤ 含 schedulePostTurnProbe；出口⑥ 与 !isCurrentEntry 出口不含', () => {
  // 出口②：合成 aborted（流丢 result）
  const abortSynthIdx = sdkBackendSrc.indexOf("forwardEvent(sessionId, mainWindow, { type: 'aborted', message: '回合已结束' })");
  const abortSynthSeg = sdkBackendSrc.slice(abortSynthIdx, sdkBackendSrc.indexOf('emitExit(null);', abortSynthIdx));
  assert.ok(abortSynthIdx >= 0 && /schedulePostTurnProbe/.test(abortSynthSeg), '出口②（合成 aborted）缺探针');
  // 出口④：真实 SDK 执行出错（catch 段调度）。review-v1 High-1：出口③（用户中断）的探针已迁移
  // 到 killProcess 调度——真实中断流在 removeEntryIfCurrent 后走 !isCurrentEntry 分支提前退出，
  // catch 段此调用仅服务 SDK 错误路径。
  const interruptedIdx = sdkBackendSrc.indexOf('interruptedQueries.has(query)');
  const catchSeg = sdkBackendSrc.slice(interruptedIdx, sdkBackendSrc.indexOf('break;', sdkBackendSrc.indexOf('SDK 执行出错', interruptedIdx)) + 6);
  assert.ok(interruptedIdx >= 0 && /schedulePostTurnProbe/.test(catchSeg), '出口④（SDK 执行出错）缺探针');
  // 出口⑤：resume 重试失败
  const resumeRetryIdx = sdkBackendSrc.indexOf('SDK 执行出错：${msg}` });', sdkBackendSrc.indexOf('isMissingConversationResumeError(err)'));
  assert.ok(resumeRetryIdx >= 0 && /schedulePostTurnProbe/.test(sdkBackendSrc.slice(resumeRetryIdx, sdkBackendSrc.indexOf('break;', resumeRetryIdx) + 6)), '出口⑤（resume 重试失败）缺探针');
  // 出口⑥：启动阶段外层 catch 不含探针
  const outerCatchIdx = sdkBackendSrc.indexOf('// 出口⑥（启动阶段外层 catch）不探');
  const outerCatchEnd = sdkBackendSrc.indexOf('finally {', outerCatchIdx);
  assert.ok(outerCatchIdx >= 0 && outerCatchEnd > outerCatchIdx, '缺出口⑥ 标注');
  assert.ok(!/schedulePostTurnProbe/.test(sdkBackendSrc.slice(outerCatchIdx, outerCatchEnd)), '出口⑥ 不得调度探针');
  // 探针调用总数 ≥ 6（result 分支 + 出口②④⑤ + killProcess 中断挂点），且出口⑥ 区段排除后仍覆盖。
  const totalProbeCalls = [...sdkBackendSrc.matchAll(/schedulePostTurnProbe\(/g)].length;
  assert.ok(totalProbeCalls >= 6, `schedulePostTurnProbe 调用点应 ≥6（实际 ${totalProbeCalls}）`);
});
check('review-v1 High-1：killProcess(user/watchdog) 分支含 schedulePostTurnProbe（中断兜底真实挂点）', () => {
  // 中断探针在 killProcess 的 reason==='user'||'watchdog' 且 mainWindow 分支内调度——这是唯一可达的
  // 中断路径（removeEntryIfCurrent 后 runQuery catch 段到不了）。契约：catch 段调用仅服务 SDK 错误。
  const killIdx = sdkBackendSrc.indexOf('export function killProcess(');
  const killSeg = sdkBackendSrc.slice(killIdx, sdkBackendSrc.indexOf('// killProcess 会先移除当前 entry', killIdx));
  const userWatchdogIdx = killSeg.indexOf("(reason === 'user' || reason === 'watchdog') && mainWindow");
  assert.ok(userWatchdogIdx >= 0, 'killProcess 缺 reason===user||watchdog 分支');
  const branchSeg = killSeg.slice(userWatchdogIdx, killSeg.indexOf('if (entry.query) {', userWatchdogIdx));
  assert.ok(/schedulePostTurnProbe\(sessionId, mainWindow, entry\.queryInstance/.test(branchSeg), 'killProcess 中断分支缺 schedulePostTurnProbe 调度（High-1 死代码未修）');
});
check('探针失败路径无 payload 发送（失败只 logger.debug，不发 CONTEXT_UPDATE）', () => {
  const probeFnStart = sdkBackendSrc.indexOf('async function runPostTurnContextProbe(');
  const probeFnEnd = sdkBackendSrc.indexOf('export function schedulePostTurnProbe(', probeFnStart);
  const probeFn = sdkBackendSrc.slice(probeFnStart, probeFnEnd);
  // 失败路径（解析失败/守卫拒绝/超时）在 return 前都不得出现 webContents.send。
  const sendSites = [...probeFn.matchAll(/webContents\.send\(IPC_CHANNELS\.CONTEXT_UPDATE/g)];
  assert.equal(sendSites.length, 1, '探针函数应只有成功路径一处 CONTEXT_UPDATE 发送点');
});
check('renderer 预填只写 stale 不写 fresh（buildPersistedCanonical）', () => {
  assert.ok(/buildPersistedCanonical/.test(sessionStoreSrc), '缺 buildPersistedCanonical 预填函数');
  assert.ok(/freshness:\s*'stale'/.test(sessionStoreSrc), '预填应写 stale');
  assert.ok(/diagnostic:\s*'上次会话记录值，等待刷新'/.test(sessionStoreSrc), '预填诊断应为「上次会话记录值，等待刷新」');
  assert.ok(/source:\s*'native-context'/.test(sessionStoreSrc), '预填 source 应为 native-context');
  assert.ok(/samplePhase:\s*'post-turn'/.test(sessionStoreSrc), '预填 samplePhase 应为 post-turn');
  // 预填函数体内不得出现 freshness:'fresh'（诚实标注非实时）。
  const fnStart2 = sessionStoreSrc.indexOf('function buildPersistedCanonical(');
  const fnEnd2 = sessionStoreSrc.indexOf('\n}', fnStart2);
  const fnBody2 = sessionStoreSrc.slice(fnStart2, fnEnd2);
  assert.ok(!/freshness:\s*'fresh'/.test(fnBody2), '预填不得写 fresh');
});

// ── §21 compact metadata display：压缩账单解析 + 文案 + 接线契约 ──
console.log('=== 21) compact metadata display：账单解析 + 文案单源 + 接线 ===');
// F1（自动压缩，snake_case）与 F2（手动 /compact，camelCase）真实事件形态（证据见 §0）。
const F1_AUTO = {
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: {
    trigger: 'auto',
    pre_tokens: 91043,
    post_tokens: 1650,
    cumulative_dropped_tokens: 89393,
    duration_ms: 32506,
    preserved_segment: { head_uuid: 'h', anchor_uuid: 'a', tail_uuid: 't' },
  },
};
const F2_MANUAL = {
  type: 'system',
  subtype: 'compact_boundary',
  compactMetadata: {
    trigger: 'manual',
    preTokens: 47672,
    postTokens: 1398,
    cumulativeDroppedTokens: 46274,
    durationMs: 25119,
  },
};
check('parseCompactMetadata：F1 snake_case 逐字段解析', () => {
  const r = parseCompactMetadata(F1_AUTO.compact_metadata);
  assert.equal(r.fromTokens, 91043);
  assert.equal(r.toTokens, 1650);
  assert.equal(r.droppedTokens, 89393);
  assert.equal(r.durationMs, 32506);
  assert.equal(r.trigger, 'auto');
});
check('parseCompactMetadata：F2 camelCase 逐字段解析', () => {
  const r = parseCompactMetadata(F2_MANUAL.compactMetadata);
  assert.equal(r.fromTokens, 47672);
  assert.equal(r.toTokens, 1398);
  assert.equal(r.droppedTokens, 46274);
  assert.equal(r.durationMs, 25119);
  assert.equal(r.trigger, 'manual');
});
check('parseCompactMetadata：非法/缺失/负数/空 → 空对象（不抛错）', () => {
  assert.deepEqual(parseCompactMetadata(null), {});
  assert.deepEqual(parseCompactMetadata(undefined), {});
  assert.deepEqual(parseCompactMetadata('x'), {});
  assert.deepEqual(parseCompactMetadata({ pre_tokens: -1, post_tokens: NaN, cumulative_dropped_tokens: 'abc' }), {});
  assert.deepEqual(parseCompactMetadata({ trigger: '  ' }), {});
  assert.deepEqual(parseCompactMetadata({ pre_tokens: 100 }), { fromTokens: 100 });
});
check('detectCompaction：F1/F2 事件解析出账单 + compactedJustNow', () => {
  const a = detectCompaction(F1_AUTO as never);
  assert.ok(a && a.compactedJustNow === true);
  assert.equal(a!.fromTokens, 91043);
  assert.equal(a!.trigger, 'auto');
  const m = detectCompaction(F2_MANUAL as never);
  assert.ok(m && m.compactedJustNow === true);
  assert.equal(m!.fromTokens, 47672);
  assert.equal(m!.trigger, 'manual');
});
check('detectCompaction：无账单 boundary 仍返回 compactedJustNow（账单字段缺席）', () => {
  const r = detectCompaction({ type: 'system', subtype: 'compact_boundary' } as never);
  assert.ok(r && r.compactedJustNow === true);
  assert.equal(r!.fromTokens, undefined);
});
check('formatCompactionSummary：完整数字 → 含 → 与清出；auto → 含自动', () => {
  const auto = formatCompactionSummary({ fromTokens: 91043, toTokens: 1650, droppedTokens: 89393, trigger: 'auto' });
  assert.equal(auto.hasNumbers, true);
  assert.ok(auto.title.includes('自动'), 'auto 应含「自动」');
  assert.ok(auto.title.includes('91.0k') && auto.title.includes('1.6k') && auto.title.includes('89.4k'), `数字格式化不符：${auto.title}`);
  assert.ok(auto.title.includes('→') && auto.title.includes('清出'));
  const manual = formatCompactionSummary({ fromTokens: 47672, toTokens: 1398, droppedTokens: 46274, trigger: 'manual' });
  assert.equal(manual.hasNumbers, true);
  assert.ok(!manual.title.includes('自动'), 'manual 不应含「自动」');
  assert.ok(manual.title.includes('47.7k → 1.4k'));
});
check('formatCompactionSummary：缺任一数字 → hasNumbers:false + 现有文案（无 undefined/NaN）', () => {
  const noDrop = formatCompactionSummary({ fromTokens: 100, toTokens: 50, trigger: 'auto' });
  assert.equal(noDrop.hasNumbers, false);
  assert.equal(noDrop.title, 'Claude Code 已自动压缩上下文');
  const noFrom = formatCompactionSummary({ toTokens: 50, droppedTokens: 10 });
  assert.equal(noFrom.hasNumbers, false);
  const empty = formatCompactionSummary({});
  assert.equal(empty.hasNumbers, false);
  assert.equal(empty.title, 'Claude Code 已自动压缩上下文');
  assert.ok(!/undefined|NaN/.test(empty.title));
});
check('formatCompactionSummary：<1000 整数不缩 k', () => {
  const r = formatCompactionSummary({ fromTokens: 900, toTokens: 100, droppedTokens: 800, trigger: 'auto' });
  assert.equal(r.hasNumbers, true);
  assert.ok(r.title.includes('900 → 100（清出 800）'));
});
check('结构：payload 两处挂载点含 5 字段 + 代际比对（sessionCompactMeta + compactMetaPayloadFields）', () => {
  assert.ok(/sessionCompactMeta/.test(sdkBackendSrc), '缺 sessionCompactMeta Map');
  assert.ok(/sessionCompactMeta\.delete\(sessionId\)/.test(sdkBackendSrc), 'markSessionDeleted 未清理压缩账单');
  assert.ok(/function resolveCompactMetaForQuery/.test(sdkBackendSrc) && /queryInstance !== queryInstance|meta\.queryInstance !== queryInstance/.test(sdkBackendSrc), '缺代际比对');
  assert.ok(/function compactMetaPayloadFields/.test(sdkBackendSrc), '缺 compactMetaPayloadFields helper');
  assert.ok(/compactFromTokens/.test(sdkBackendSrc) && /compactToTokens/.test(sdkBackendSrc) && /compactDroppedTokens/.test(sdkBackendSrc) && /compactDurationMs/.test(sdkBackendSrc) && /compactTrigger/.test(sdkBackendSrc), '5 字段挂载不全');
  // 两处挂载点：refreshContextSnapshot 的 compactedJustNow 分支 + runPostTurnContextProbe payload。
  assert.ok(/compactedJustNow: true, \.\.\.compactMetaPayloadFields/.test(sdkBackendSrc), 'refresh 挂载点缺 compactMetaPayloadFields');
  assert.ok(/\.\.\.compactMetaPayloadFields\(sessionId, probeInstance, opts\)/.test(sdkBackendSrc), '探针挂载点缺 compactMetaPayloadFields');
  // 写入：boundary 到达即存（含当时代际）。
  assert.ok(/sessionCompactMeta\.set\(sessionId, \{/.test(sdkBackendSrc), 'boundary 未写入账单');
});
check('结构：CANONICAL_REQUIRED_FIELDS 不含新字段（16 canonical 契约不变）', () => {
  const sharedSrc = readFileSync(resolve('src/shared/context-usage.ts'), 'utf8');
  assert.ok(!/compactFromTokens|compactToTokens|compactDroppedTokens|compactDurationMs|compactTrigger/.test(sharedSrc.split('const CANONICAL_REQUIRED_FIELDS')[1].split('] as const')[0]), 'canonical 必填字段不得加入新字段');
});
check('结构：ContextStatsPayload 新增 5 个可选字段（不进 CANONICAL）', () => {
  assert.ok(/compactFromTokens\?:\s*number/.test(ipcSrc), '缺 compactFromTokens?');
  assert.ok(/compactToTokens\?:\s*number/.test(ipcSrc), '缺 compactToTokens?');
  assert.ok(/compactDroppedTokens\?:\s*number/.test(ipcSrc), '缺 compactDroppedTokens?');
  assert.ok(/compactDurationMs\?:\s*number/.test(ipcSrc), '缺 compactDurationMs?');
  assert.ok(/compactTrigger\?:\s*string/.test(ipcSrc), '缺 compactTrigger?');
});
check('结构：renderer 接线（lastCompactionSummary 显示态 + 横幅调 formatCompactionSummary）', () => {
  assert.ok(/lastCompactionSummary/.test(sessionStoreSrc), 'session-store 缺 lastCompactionSummary');
  assert.ok(/this\.lastCompactionSummary = null/.test(sessionStoreSrc), 'switchSession 未清空压缩账单显示态');
  assert.ok(/formatCompactionSummary/.test(contextButtonSrc), 'ContextButton 未调用 formatCompactionSummary');
  assert.ok(/compactBannerTitle/.test(contextButtonSrc), '横幅未读 compactBannerTitle');
});
check('结构：sdk-backend 透传 compact_metadata/compactMetadata 原始事件字段', () => {
  assert.ok(/sdkMsg\.compact_metadata/.test(sdkBackendSrc) && /sdkMsg\.compactMetadata/.test(sdkBackendSrc), 'informational/compact_boundary 透传缺 compact_metadata/compactMetadata');
});
check('结构：E2E S10 增强——探针 payload 断言 compactFromTokens + 横幅 DOM 匹配 /→|清出/', () => {
  assert.ok(/probe\.compactFromTokens/.test(cdpE2eSrc), 'S10 未断言探针 compactFromTokens');
  assert.ok(/→\|清出/.test(cdpE2eSrc), 'S10 未断言横幅 DOM 含 →/清出');
});

// ── §26 上下文圆圈 v2（docs/plans/context-circle-v2-plan.md §7）──────────
// D1 探针设置拼接（fallback 形态）/ D2 预算 45s / D3 settle 顺序 + 日志降级 / D4 弹层三行化。
console.log('=== 26) 上下文圆圈 v2：探针 env 补全 + 预算 + settle 顺序 + 弹层三行 ===');
{
  const sessionModelSrc = readFileSync(resolve('src/shared/session-model.ts'), 'utf8');

  // D1.1：applySessionOverrideEnv 补 SMALL_FAST/SUBAGENT 两键——全局 settings.json 的
  // SMALL_FAST/SUBAGENT env 泄漏（此前 env 通道无人覆盖→文件值生效）从此被会话模型压制。
  check('D1.1 applySessionOverrideEnv 源码含 SMALL_FAST/SUBAGENT 赋值', () => {
    assert.ok(/env\.ANTHROPIC_SMALL_FAST_MODEL\s*=\s*override\.modelId;/.test(sessionModelSrc), '缺 ANTHROPIC_SMALL_FAST_MODEL = override.modelId 赋值');
    assert.ok(/env\.CLAUDE_CODE_SUBAGENT_MODEL\s*=\s*override\.modelId;/.test(sessionModelSrc), '缺 CLAUDE_CODE_SUBAGENT_MODEL = override.modelId 赋值');
  });

  // D1.3-3：行为断言——BASE_URL/KEY/AUTH_TOKEN 三元组语义不变 + 7 类模型键全钉会话模型。
  check('D1.3 applySessionOverrideEnv 行为：BASE_URL/KEY/7 模型键钉会话模型 + AUTH_TOKEN 删除', () => {
    const env: Record<string, string> = {
      ANTHROPIC_AUTH_TOKEN: 'legacy-token',
      ANTHROPIC_SMALL_FAST_MODEL: 'leak-small',
      CLAUDE_CODE_SUBAGENT_MODEL: 'leak-subagent',
    };
    applySessionOverrideEnv(env, { apiBaseUrl: 'https://p.example/v1', apiKey: 'sk-p', modelId: 'm-1' });
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://p.example/v1');
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-p');
    assert.equal(env.ANTHROPIC_MODEL, 'm-1');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'm-1');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'm-1');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'm-1');
    assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'm-1');
    assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'm-1', 'SMALL_FAST 应被会话模型压制');
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'm-1', 'SUBAGENT 应被会话模型压制');
    assert.ok(!('ANTHROPIC_AUTH_TOKEN' in env), 'AUTH_TOKEN 应删除');
  });
  check('D1.3 applySessionOverrideEnv 空 baseUrl/key 回归：删除键 + 模型键仍钉（不破旧语义）', () => {
    const env: Record<string, string> = { ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://old/v1', ANTHROPIC_API_KEY: 'sk-old' };
    applySessionOverrideEnv(env, { apiBaseUrl: '  ', apiKey: '', modelId: 'm-2' });
    assert.ok(!('ANTHROPIC_BASE_URL' in env), '空 baseUrl 应删除 BASE_URL');
    assert.ok(!('ANTHROPIC_API_KEY' in env), '空 key 应删除 API_KEY');
    assert.ok(!('ANTHROPIC_AUTH_TOKEN' in env), 'AUTH_TOKEN 应删除');
    assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'm-2');
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'm-2');
  });

  // D1-fallback（P0-b/b2/c 实测定案，证据 D:/software/Cache/claude-link/probe-ctx/v2-20260902/）：
  // flag --settings 的 env 与用户文件 env 同键对撞时文件赢（P0-b SONNET 键），且 flag 组合会使
  // 探针工具集失真（P0-c System tools 14.7k→2.9k）——探针不传 --settings，走 env 单通道
  // （buildSpawnEnv(override) 含 7 键全钉：ANTHROPIC_MODEL+4 别名+SMALL_FAST/SUBAGENT）。
  check('D1-fallback 探针段不传 --settings（P0-b 证伪 flag 优先级，env 单通道定案）', () => {
    const probeFnStart = sdkBackendSrc.indexOf('async function runPostTurnContextProbe(');
    const probeFnEnd = sdkBackendSrc.indexOf('export function schedulePostTurnProbe(', probeFnStart);
    assert.ok(probeFnStart >= 0 && probeFnEnd > probeFnStart, '探针函数切片失败');
    const probeFn = sdkBackendSrc.slice(probeFnStart, probeFnEnd);
    assert.ok(!probeFn.includes("'--settings'"), '探针段出现 --settings——P0-b 已证伪 flag 优先级（同键对撞文件赢）且 P0-c 证其使工具集失真，不得回退主方案');
    assert.ok(/env = buildSpawnEnv\(override\)/.test(probeFn), '探针 env 应来自 buildSpawnEnv(override)（env 单通道）');
  });

  // D2：探针预算 ≥45s（实测地板 13-21s，10s 必然超时——圆圈长期空/不更新的第一主因）。
  check('D2 POST_TURN_PROBE_TIMEOUT_MS >= 45_000（对齐实测地板 13-21s）', () => {
    const m = sdkBackendSrc.match(/const POST_TURN_PROBE_TIMEOUT_MS\s*=\s*(\d[\d_]*);/);
    assert.ok(m, '缺 POST_TURN_PROBE_TIMEOUT_MS 常量');
    const v = Number(m![1].replace(/_/g, ''));
    assert.ok(v >= 45_000, `探针预算应 ≥45_000（实际 ${v}）`);
  });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);