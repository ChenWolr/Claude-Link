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
  assert.ok(cdpE2eSrc.indexOf('assertDiagAndTitle(ws, !terminalFresh)', s1Idx) > 0, 'S1 应断言 stale title+诊断行');
  assert.ok(/assertDiagAndTitle\(ws, !\(lp3\?\.source/.test(cdpE2eSrc), 'S3 应按终态断言 title 语义');
  assert.ok(/assertDiagAndTitle\(ws, !freshReconcile\)/.test(cdpE2eSrc), 'S9 fresh 对账终态不得标注上次采样');
});

// ── P2 mid-turn：回合中途轮询接线（docs/superpowers/plans/2026-08-22-mid-turn-context-refresh.md Task 5）──
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);