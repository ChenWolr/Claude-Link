// tdd-memleak-fixes-verify.ts
// UI13 批次 P11「内存泄漏修复包」（2026-11-14 计划，用例正本 03-test-cases.md §P11）。
// TDD 验证脚本：T11-A~K 十一条用例，行为直测（headless pinia store / 注入 fake timer 的
// invoke 超时包装）+ 结构钉：
//   T11-A  patchCache LRU ≤32——灌 33 条容量恒 ≤32 且逐出最旧、保留最近使用（LRU 语义）；
//   T11-B  恰 32 条不逐出（上限边界精确性；RED 期「无上限=不逐出」同样全留属预期绿，
//          本条的判定意义依赖 T11-A 的淘汰逻辑先行落地——GREEN 期验证）；
//   T11-C  切会话三清（R8 裁决：patchCache + patchErrors + 在飞 inflightPatches，patchLoading
//          同拍清防脏键）——33 缓存 + 1 错误 + 1 加载旗标 + 1 在飞 Promise → 切 activeSession
//          → 四面全空；在飞清空经「同键再拉必发新后端请求」间接观测；
//   T11-D  invoke 超时表驱动钉（UI13-P2-C 适配）——默认 60s（INVOKE_TIMEOUT_MS 保持）+
//          CHANNEL_TIMEOUT_MS 四长操作通道覆盖值（testProviderModel 100s / probeMcpServers
//          130s；COMMANDS_REFRESH_GLOBAL / COMMANDS_GET 120s 两键系 2026-11-15 eight-issues
//          批次 D3-3 扩键同步——精确键集断言随实际键集扩展，见 T11-D-1 处留痕），未列通道
//          回落 60s；无回包按时窗 reject「invoke 超时」且条目从 Map 删除
//          （注入 fake timer 直测 armPendingInvoke + 结构钉 表值/表接线/invokeOverWire 兜底）；
//   T11-E  回包/断线既有语义回归——回包 resolve 删条目；断线批量 reject「Web 桥未连接」+
//          clear 全清（结构钉）；已删条目的超时回调到期 no-op 不抛错不误删（行为直测）；
//   T11-F  回包-超时竞态不双结——回包路径 clearTimeout（fake timer 记录 cleared）+ 超时回调
//          到期无二次动作（无未处理 reject、无定时器泄漏）；
//   T11-G  票据消费即删——consumeTicket 命中分支 rec.used = true 后紧跟 tickets.delete(ticket)
//          （结构钉·契约面）+ 二次消费 null 行为回归（与 T10-J 互证）；
//   T11-H  AppSidebar 卸载钩子清 debounceTimer（结构钉：onUnmounted 内 clearTimeout）；
//   T11-I  MessageBubble copied/copyFailed 1200ms setTimeout 句柄收敛 + 卸载清理（结构钉）；
//   T11-J  MessageList（两处 1500ms）与 McpSettings（pushToast 3200ms）计时器卸载清理（结构钉）；
//   T11-K  零用户可见行为回归钉——①复制反馈仍 1.2s；②WEB_DOWNLOAD_TTL_MS 仍 10min（导入直测）；
//          ③搜索去抖 250ms 不变；④≤32 内补丁缓存照常命中（同键两次 getPatch 后端仅 1 次）。
// RED 先行：未实现树 T11-A/C/D/G/H/I/J 先红；T11-B/K 现状即绿（B 依赖 A 实现，见上注）；
// T11-E 行为半（armPendingInvoke 依赖新导出）随 D 红、结构半现状绿。
// 运行：npx tsx scripts/tdd-memleak-fixes-verify.ts（已登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import * as diffStoreMod from '../src/renderer/stores/turn-diff-store';
import * as bridgeMod from '../src/renderer/web/web-bridge';
import { consumeTicket, createTicketForContent, reset as resetTickets, WEB_DOWNLOAD_TTL_MS } from '../src/main/modules/export-web-tickets';
import { turnDiffPatchKey, useTurnDiffStore } from '../src/renderer/stores/turn-diff-store';
import { useSessionStore } from '../src/renderer/stores/session-store';
import { IPC_CHANNELS } from '../src/shared/constants';
import type { TurnFilePatch } from '../src/renderer/stores/turn-diff-store';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void | Promise<void>): void {
  const run = async (): Promise<void> => {
    try { await fn(); pass++; console.log(`  ✅ ${name}`); }
    catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
  };
  queue.push(run);
}
const queue: Array<() => Promise<void>> = [];
function group(title: string): void {
  queue.push(async () => console.log(`\n${title}`));
}

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const storeSrc = read('../src/renderer/stores/turn-diff-store.ts');
const bridgeSrc = read('../src/renderer/web/web-bridge.ts');
const ticketsSrc = read('../src/main/modules/export-web-tickets.ts');
const sidebarSrc = read('../src/renderer/components/layout/AppSidebar.vue');
const bubbleSrc = read('../src/renderer/components/chat/MessageBubble.vue');
const listSrc = read('../src/renderer/components/chat/MessageList.vue');
const mcpSrc = read('../src/renderer/components/config/McpSettings.vue');

const evictLruToLimit = (diffStoreMod as Record<string, unknown>).evictLruToLimit as
  | ((map: Map<string, unknown>, limit: number) => void)
  | undefined;
const PATCH_CACHE_LIMIT = (diffStoreMod as Record<string, unknown>).PATCH_CACHE_LIMIT as number | undefined;
const armPendingInvoke = (bridgeMod as Record<string, unknown>).armPendingInvoke as
  | ((
      id: string,
      map: Pick<Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>, 'get' | 'delete'>,
      resolve: (value: unknown) => void,
      reject: (error: Error) => void,
      timeoutMs?: number,
      timers?: { setTimeout: (cb: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void },
    ) => { resolve: (v: unknown) => void; reject: (e: Error) => void })
  | undefined;

/** 取函数体源码（function name … 到首个顶格收敛的 "\n}"；结构钉用）。 */
function fnSrc(src: string, name: string): string {
  const start = src.indexOf(`function ${name}`);
  assert.ok(start >= 0, `未找到 function ${name}`);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `function ${name} 体边界异常`);
  return src.slice(start, end);
}

/** 取 hook 块源码（hookName(() => { … })；P11 钉卸载清理用；取最后一个匹配块）。 */
function hookBlocks(src: string, hookName: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`${hookName}\\(\\(\\)\\s*=>\\s*\\{`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    const end = src.indexOf('});', start);
    if (end > start) blocks.push(src.slice(start, end));
  }
  return blocks;
}

// ── 行为直测 harness（headless pinia + window.claudeLink mock；probe 已验证 watch/懒加载可跑）──

interface Harness {
  store: ReturnType<typeof useTurnDiffStore>;
  sessions: ReturnType<typeof useSessionStore>;
  state: { summariesCalls: number; patchCalls: number; holdInflight: boolean };
  flush(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const state = { summariesCalls: 0, patchCalls: 0, holdInflight: false };
  (globalThis as unknown as { window: unknown }).window = {
    claudeLink: {
      listTurnDiffSummaries: async () => { state.summariesCalls++; return []; },
      getTurnFilePatch: async () => {
        state.patchCalls++;
        if (state.holdInflight) return new Promise<TurnFilePatch>(() => { /* 在飞挂起（永不 resolve） */ });
        return { mode: 'unified' as const, patch: 'p', truncated: false };
      },
    },
  };
  setActivePinia(createPinia());
  const store = useTurnDiffStore();
  const sessions = useSessionStore();
  const flush = async (): Promise<void> => {
    await nextTick();
    await new Promise((r) => setTimeout(r, 25));
  };
  return { store, sessions, state, flush };
}

function setSession(h: Harness, id: string): void {
  (h.sessions as unknown as { activeSession: unknown }).activeSession = {
    id, name: `sess-${id}`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

const fakePatch = (patch: string): TurnFilePatch => ({ mode: 'unified', patch, truncated: false, context: 1 });

// ═══ T11-A patchCache LRU ≤32 ═══

group('=== T11-A 补丁缓存 LRU ≤32 ===');
check('T11-A-1 结构钉：PATCH_CACHE_LIMIT=32 导出 + evictLruToLimit 导出 + getPatch 写入路径淘汰 + 命中路径 delete+set 重插', () => {
  assert.ok(PATCH_CACHE_LIMIT !== undefined, 'turn-diff-store 未导出 PATCH_CACHE_LIMIT');
  assert.equal(PATCH_CACHE_LIMIT, 32, `PATCH_CACHE_LIMIT=${String(PATCH_CACHE_LIMIT)}，应为 32`);
  assert.ok(typeof evictLruToLimit === 'function', 'turn-diff-store 未导出 evictLruToLimit 纯函数');
  assert.ok(
    storeSrc.includes('evictLruToLimit(patchCache.value, PATCH_CACHE_LIMIT)'),
    'getPatch 写入路径未调用 evictLruToLimit(patchCache.value, PATCH_CACHE_LIMIT)——写入后无上限淘汰',
  );
  const hitIdx = storeSrc.indexOf('const cached = patchCache.value.get(key);');
  assert.ok(hitIdx >= 0, 'getPatch 缓存命中读取缺失');
  const hitRegion = storeSrc.slice(hitIdx, hitIdx + 300);
  assert.ok(
    /patchCache\.value\.delete\(key\);\s*\n\s*patchCache\.value\.set\(key, cached\);/.test(hitRegion),
    'getPatch 命中路径未做 delete+set 重插（LRU 语义：命中应置为最近使用）',
  );
});
check('T11-A-2 行为直测：灌 33 条 → 容量恒 32 且逐出最旧、保留最近', async () => {
  assert.ok(typeof evictLruToLimit === 'function', 'evictLruToLimit 未导出（前置）');
  const h = await makeHarness();
  for (let i = 0; i < 33; i++) await h.store.getPatch('sa', `t${String(i).padStart(2, '0')}`, null, 'p.ts', 1);
  assert.equal(h.store.patchCache.size, 32, `灌 33 条后 patchCache.size=${h.store.patchCache.size}，应为 32`);
  assert.ok(!h.store.patchCache.has(turnDiffPatchKey('t00', 'p.ts', 1)), '最旧条目 t00 未被逐出');
  assert.ok(h.store.patchCache.has(turnDiffPatchKey('t32', 'p.ts', 1)), '最新条目 t32 被误逐');
});
check('T11-A-3 行为直测 LRU 语义：命中重插 → 热点键不被误逐', async () => {
  const h = await makeHarness();
  for (let i = 0; i < 33; i++) await h.store.getPatch('sa', `t${String(i).padStart(2, '0')}`, null, 'p.ts', 1);
  // 触达 t01（命中重插 → 变为最近使用），再写 t33 → 被逐出的应为新的最旧 t02，而非热点 t01
  await h.store.getPatch('sa', 't01', null, 'p.ts', 1);
  await h.store.getPatch('sa', 't33', null, 'p.ts', 1);
  assert.ok(h.store.patchCache.has(turnDiffPatchKey('t01', 'p.ts', 1)), '热点键 t01 命中重插后仍被误逐（LRU 语义缺失）');
  assert.ok(!h.store.patchCache.has(turnDiffPatchKey('t02', 'p.ts', 1)), '命中重插未生效：t02 未按新插入序被逐出');
  assert.equal(h.store.patchCache.size, 32, `touch+写入后 size=${h.store.patchCache.size}，应为 32`);
});

// ═══ T11-B 恰 32 条不逐出 ═══

group('=== T11-B 恰 32 条不逐出（上限边界精确性） ===');
check('T11-B 行为直测：恰灌 32 条 → 全部仍命中（不提前逐出）', async () => {
  const h = await makeHarness();
  for (let i = 0; i < 32; i++) await h.store.getPatch('sb', `t${String(i).padStart(2, '0')}`, null, 'p.ts', 1);
  assert.equal(h.store.patchCache.size, 32, `恰 32 条后 size=${h.store.patchCache.size}，不得提前逐出`);
  for (let i = 0; i < 32; i++) {
    assert.ok(h.store.patchCache.has(turnDiffPatchKey(`t${String(i).padStart(2, '0')}`, 'p.ts', 1)), `条目 t${i} 在 32 上限内被误逐`);
  }
  assert.equal(h.state.patchCalls, 32, `后端请求数=${h.state.patchCalls}，恰 32 条应恰好 32 次`);
  // 注：RED 期「无上限」树 32 条同样全留（本条现状即绿属预期）——B 的判定意义依赖 T11-A
  // 的淘汰逻辑先行落地（A-1 结构钉已钉 evict 调用存在），GREEN 期在本条复核边界精确性。
});

// ═══ T11-C 切会话三清 ═══

group('=== T11-C 切会话三清（R8：patchCache+patchErrors+在飞） ===');
check('T11-C-1 行为直测：33 缓存 + 1 错误 + 1 加载旗标 → 切 activeSession → 全空', async () => {
  const h = await makeHarness();
  setSession(h, 's1');
  await h.flush();
  assert.equal(h.state.summariesCalls, 1, `flush 后 summariesCalls=${h.state.summariesCalls}（watch 前置自检未过）`);
  for (let i = 0; i < 33; i++) h.store.patchCache.set(`k${i}`, fakePatch(String(i)));
  h.store.patchErrors = { 'k-inflight|p.ts|1': 'boom' };
  h.store.patchLoading = { 'k-inflight|p.ts|1': true };
  setSession(h, 's2');
  await h.flush();
  assert.equal(h.store.patchCache.size, 0, `切会话后 patchCache.size=${h.store.patchCache.size}，应清空`);
  assert.equal(Object.keys(h.store.patchErrors).length, 0, '切会话后 patchErrors 残留（三清漏错误键）');
  assert.equal(Object.keys(h.store.patchLoading).length, 0, '切会话后 patchLoading 残留（三清漏加载旗标键）');
});
check('T11-C-2 行为直测：在飞 inflightPatches 清空——同键再拉必发新后端请求（不复用旧会话在飞）', async () => {
  const h = await makeHarness();
  setSession(h, 's1');
  await h.flush();
  h.state.holdInflight = true;
  const p1 = h.store.getPatch('s1', 'turn-inflight', null, 'p.ts', 1);
  assert.equal(h.state.patchCalls, 1, '首拉应发出后端请求（前置自检）');
  setSession(h, 's2');
  await h.flush();
  h.state.holdInflight = false;
  const guard = new Promise((r) => setTimeout(() => r('TIMEOUT_GUARD'), 500));
  const p2 = await Promise.race([h.store.getPatch('s1', 'turn-inflight', null, 'p.ts', 1), guard]);
  assert.notEqual(p2, 'TIMEOUT_GUARD', '切会话后同键再拉复用了旧在飞 Promise（inflightPatches 未清）→ 永挂');
  await Promise.race([p1, guard]); // 旧在飞仍挂起属预期，不阻塞
  assert.equal(h.state.patchCalls, 2, `patchCalls=${h.state.patchCalls}，切会话后同键应发新请求（=2）`);
});

// ═══ T11-D invoke 60s 超时 ═══

group('=== T11-D invoke 超时（表驱动钉，UI13-P2-C） ===');
// T11-D-1 同步留痕（2026-11-15 eight-issues 批次 D3-3）：CHANNEL_TIMEOUT_MS 精确键集断言由
// 「两长操作通道」（testProviderModel/probeMcpServers）扩为四键——新增 COMMANDS_REFRESH_GLOBAL /
// COMMANDS_GET 两键（全局/会话级命令重探 spawn CLI 长操作，统一 120s 预算；实现细节 02 §8.3，
// 用例 03b §9 D3-3「T11-D-1 必须同步扩键，否则 selftest 必红」）。原两键断言逐字保留不反转。
check('T11-D-1 结构钉（表驱动）：INVOKE_TIMEOUT_MS=60_000 默认保持 + CHANNEL_TIMEOUT_MS 导出且四长操作通道覆盖值恰为 testProviderModel 100s / probeMcpServers 130s / COMMANDS_REFRESH_GLOBAL 120s / COMMANDS_GET 120s（D3-3 扩键）+ invokeOverWire 表查询兜底接线', () => {
  const timeoutMs = (bridgeMod as Record<string, unknown>).INVOKE_TIMEOUT_MS;
  assert.ok(timeoutMs !== undefined, 'web-bridge 未导出 INVOKE_TIMEOUT_MS');
  assert.equal(timeoutMs, 60_000, `INVOKE_TIMEOUT_MS=${String(timeoutMs)}，默认应为 60_000`);
  assert.ok(typeof armPendingInvoke === 'function', 'web-bridge 未导出 armPendingInvoke');
  const channelTable = (bridgeMod as Record<string, unknown>).CHANNEL_TIMEOUT_MS as
    | Record<string, number>
    | undefined;
  assert.ok(channelTable !== undefined, 'web-bridge 未导出 CHANNEL_TIMEOUT_MS（通道超时覆盖表）');
  assert.equal(
    channelTable[IPC_CHANNELS.PROVIDER_TEST_MODEL], 100_000,
    `CHANNEL_TIMEOUT_MS[${IPC_CHANNELS.PROVIDER_TEST_MODEL}]=${channelTable[IPC_CHANNELS.PROVIDER_TEST_MODEL]}，testProviderModel 应为 100_000（上游 90s 封顶 + 余量）`,
  );
  assert.equal(
    channelTable[IPC_CHANNELS.MCP_PROBE], 130_000,
    `CHANNEL_TIMEOUT_MS[${IPC_CHANNELS.MCP_PROBE}]=${channelTable[IPC_CHANNELS.MCP_PROBE]}，probeMcpServers 应为 130_000（合法可配 120s + 余量）`,
  );
  // D3-3 扩键（2026-11-15 eight-issues）：全局/会话级命令重探统一 120s 预算（低于 probeMcpServers
  // 130s 封顶口径；sdk-command-registry 幂等锁在飞去重，重放无害）。
  assert.equal(
    channelTable[IPC_CHANNELS.COMMANDS_REFRESH_GLOBAL], 120_000,
    `CHANNEL_TIMEOUT_MS[${IPC_CHANNELS.COMMANDS_REFRESH_GLOBAL}]=${channelTable[IPC_CHANNELS.COMMANDS_REFRESH_GLOBAL]}，refreshGlobalCommands 应为 120_000（D3-3 spawn CLI 长重探）`,
  );
  assert.equal(
    channelTable[IPC_CHANNELS.COMMANDS_GET], 120_000,
    `CHANNEL_TIMEOUT_MS[${IPC_CHANNELS.COMMANDS_GET}]=${channelTable[IPC_CHANNELS.COMMANDS_GET]}，COMMANDS_GET 会话级重探应为 120_000（D3-3 同类长通道）`,
  );
  assert.deepEqual(
    Object.keys(channelTable).sort(),
    [IPC_CHANNELS.PROVIDER_TEST_MODEL, IPC_CHANNELS.MCP_PROBE, IPC_CHANNELS.COMMANDS_REFRESH_GLOBAL, IPC_CHANNELS.COMMANDS_GET].sort(),
    `CHANNEL_TIMEOUT_MS 键集=${Object.keys(channelTable).join(',')}，应恰为四条长操作通道（D3-3 扩键；其余通道维持 60s 默认）`,
  );
  assert.ok(bridgeSrc.includes("'invoke 超时'"), "web-bridge 缺超时文案「invoke 超时」");
  assert.ok(
    bridgeSrc.includes('pendingInvokes.set(id, armPendingInvoke(id, pendingInvokes'),
    'invokeOverWire 未以 armPendingInvoke(id, pendingInvokes, …) 注册 pending 条目（无超时接线）',
  );
  assert.ok(
    bridgeSrc.includes('CHANNEL_TIMEOUT_MS[channel] ?? INVOKE_TIMEOUT_MS'),
    'invokeOverWire 未按通道取超时窗（应 CHANNEL_TIMEOUT_MS[channel] ?? INVOKE_TIMEOUT_MS，未列通道兜底 60s）',
  );
});
check('T11-D-2 行为直测（fake timer）：60s 无回包 → 超时回调删键 + reject「invoke 超时」（身份比较命中）', () => {
  assert.ok(typeof armPendingInvoke === 'function', 'armPendingInvoke 未导出（前置）');
  const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const timers = {
    setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; scheduled.push(t); return t; },
    clearTimeout: (handle: unknown) => { (handle as { cleared: boolean }).cleared = true; },
  };
  const map = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const rejections: Error[] = [];
  const resolved: unknown[] = [];
  const wrapped = armPendingInvoke('id1', map, (v) => resolved.push(v), (e) => rejections.push(e), undefined, timers);
  map.set('id1', wrapped);
  assert.equal(scheduled.length, 1, '注册 pending 应布防恰 1 个超时定时器');
  assert.equal(scheduled[0].ms, 60_000, `超时定时器窗口=${scheduled[0].ms}，应为 60_000`);
  scheduled[0].fn();
  assert.equal(map.has('id1'), false, '超时后条目未从 Map 删除');
  assert.equal(rejections.length, 1, '超时未 reject');
  assert.ok(rejections[0].message.includes('超时'), `超时错误文案=${rejections[0].message}，应含「超时」义`);
  assert.equal(resolved.length, 0, '超时误走 resolve');
});
check('T11-D-3 行为直测（fake timer）：显式 timeoutMs 按传入值布防（100_000 / 130_000 两覆盖档各自生效，接线传参通道覆盖值即走此路径）', () => {
  assert.ok(typeof armPendingInvoke === 'function', 'armPendingInvoke 未导出（前置）');
  for (const overrideMs of [100_000, 130_000]) {
    const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const timers = {
      setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; scheduled.push(t); return t; },
      clearTimeout: (handle: unknown) => { (handle as { cleared: boolean }).cleared = true; },
    };
    const map = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const rejections: Error[] = [];
    const wrapped = armPendingInvoke(`id-ov-${overrideMs}`, map, () => { /* 不resolve */ }, (e) => rejections.push(e), overrideMs, timers);
    map.set(`id-ov-${overrideMs}`, wrapped);
    assert.equal(scheduled.length, 1, `overrideMs=${overrideMs}：注册 pending 应布防恰 1 个超时定时器`);
    assert.equal(scheduled[0].ms, overrideMs, `overrideMs=${overrideMs}：超时定时器窗口=${scheduled[0].ms}，应按显式传入值布防`);
    scheduled[0].fn();
    assert.equal(map.has(`id-ov-${overrideMs}`), false, `overrideMs=${overrideMs}：超时后条目未从 Map 删除`);
    assert.equal(rejections.length, 1, `overrideMs=${overrideMs}：覆盖档时窗超时未 reject`);
    assert.ok(rejections[0].message.includes('超时'), `overrideMs=${overrideMs}：超时文案=${rejections[0].message}`);
  }
});

// ═══ T11-E 回包/断线既有语义回归 ═══

group('=== T11-E 回包/断线既有语义回归 ===');
check('T11-E-1 行为直测：回包 resolve 删条目；已删条目的超时回调到期 no-op 不抛错不误删', () => {
  assert.ok(typeof armPendingInvoke === 'function', 'armPendingInvoke 未导出（前置）');
  const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const timers = {
    setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; scheduled.push(t); return t; },
    clearTimeout: (handle: unknown) => { (handle as { cleared: boolean }).cleared = true; },
  };
  const map = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const rejections: Error[] = [];
  const resolved: unknown[] = [];
  const wrapped = armPendingInvoke('id2', map, (v) => resolved.push(v), (e) => rejections.push(e), undefined, timers);
  map.set('id2', wrapped);
  // 模拟 dispatchServerFrame 回包路径：先删条目再走包装 resolve
  map.delete('id2');
  wrapped.resolve('ok');
  assert.deepEqual(resolved, ['ok'], '回包未送达 outer resolve');
  assert.equal(rejections.length, 0, '回包路径误 reject');
  // 超时回调到期（回包后）：条目已删 → 身份比较不命中 → no-op（不抛错不误删）
  scheduled[0].fn();
  assert.equal(rejections.length, 0, '已回包条目的超时回调误 reject');
  assert.equal(map.size, 0, '已回包条目的超时回调误增键');
});
check('T11-E-2 结构钉：断线批量 fail 语义保留（failAllPendingInvokes reject「Web 桥未连接」+ clear）+ 回包路径删条目不变', () => {
  const failSrc = fnSrc(bridgeSrc, 'failAllPendingInvokes');
  assert.ok(failSrc.includes("new Error('Web 桥未连接')"), 'failAllPendingInvokes 的「Web 桥未连接」reject 丢失');
  assert.ok(failSrc.includes('pendingInvokes.clear()'), 'failAllPendingInvokes 的全清丢失');
  const dispatchSrc = fnSrc(bridgeSrc, 'dispatchServerFrame');
  assert.ok(dispatchSrc.includes('pendingInvokes.delete(frame.id)'), 'dispatchServerFrame 回包路径删条目语义丢失');
});
check('T11-E-3 行为直测：wrapped.reject 路径（断线批量 fail 视角）→ outer reject + clearTimeout 记录', () => {
  assert.ok(typeof armPendingInvoke === 'function', 'armPendingInvoke 未导出（前置）');
  const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const timers = {
    setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; scheduled.push(t); return t; },
    clearTimeout: (handle: unknown) => { (handle as { cleared: boolean }).cleared = true; },
  };
  const map = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const rejections: Error[] = [];
  const wrapped = armPendingInvoke('id3', map, () => { /* 不会被调用 */ }, (e) => rejections.push(e), undefined, timers);
  map.set('id3', wrapped);
  wrapped.reject(new Error('Web 桥未连接'));
  assert.equal(rejections.length, 1, '断线批量 fail 未送达 outer reject');
  assert.equal(scheduled[0].cleared, true, '断线批量 fail 未清超时定时器（fail 后定时器悬挂泄漏）');
});

// ═══ T11-F 回包-超时竞态不双结 ═══

group('=== T11-F 回包-超时竞态不双结 ===');
check('T11-F 行为直测：回包在超时临界前到达 → clearTimeout 记录 cleared；超时回调再触发无二次动作', () => {
  assert.ok(typeof armPendingInvoke === 'function', 'armPendingInvoke 未导出（前置）');
  const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const timers = {
    setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; scheduled.push(t); return t; },
    clearTimeout: (handle: unknown) => { (handle as { cleared: boolean }).cleared = true; },
  };
  const map = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const rejections: Error[] = [];
  const resolved: unknown[] = [];
  const wrapped = armPendingInvoke('id4', map, (v) => resolved.push(v), (e) => rejections.push(e), undefined, timers);
  map.set('id4', wrapped);
  map.delete('id4');
  wrapped.resolve('v');
  assert.equal(scheduled[0].cleared, true, '回包路径未 clearTimeout（定时器悬挂泄漏）');
  scheduled[0].fn(); // 竞态窗口后定时器仍触发（理论不可达，防御性 no-op 判定）
  assert.equal(rejections.length, 0, '回包后超时回调仍 reject（已 resolve 再 reject 的双结）');
  assert.deepEqual(resolved, ['v'], '回包值被竞态回调污染');
  assert.equal(map.size, 0, '竞态回调误增键');
});

// ═══ T11-G 票据消费即删 ═══

group('=== T11-G 票据消费即删 ===');
check('T11-G-1 结构钉：consumeTicket 命中分支 rec.used = true 后紧跟 tickets.delete(ticket)', () => {
  const body = fnSrc(ticketsSrc, 'consumeTicket');
  assert.ok(
    /rec\.used = true;[\s\S]{0,300}?tickets\.delete\(ticket\);/.test(body),
    'consumeTicket 命中分支未在 rec.used = true 后立即 tickets.delete(ticket)（消费后条目仍驻留等 TTL）',
  );
});
check('T11-G-2 行为回归：consume 命中返回内容；二次消费 null（与 T10-J 互证）', () => {
  resetTickets();
  const { url } = createTicketForContent('a.txt', 'hello', 'text/plain');
  const ticket = new URL(url, 'http://x').searchParams.get('ticket') ?? '';
  const hit = consumeTicket(ticket);
  assert.ok(hit && hit.content === 'hello' && hit.filename === 'a.txt', `首次消费应命中 content（得 ${JSON.stringify(hit)}）`);
  assert.equal(consumeTicket(ticket), null, '二次消费应为 null（一次性语义）');
  resetTickets();
});

// ═══ T11-H 侧栏去抖计时器清理 ═══

group('=== T11-H AppSidebar 去抖计时器清理 ===');
check('T11-H 结构钉：AppSidebar 卸载钩子内同时含 keydown 反注册与 clearTimeout(debounceTimer)', () => {
  const blocks = hookBlocks(sidebarSrc, 'onUnmounted');
  assert.ok(blocks.length > 0, 'AppSidebar 无 onUnmounted 卸载钩子');
  const last = blocks[blocks.length - 1];
  assert.ok(
    last.includes("removeEventListener('keydown'"),
    '卸载钩子的 keydown 反注册丢失（现状行为回退）',
  );
  assert.ok(
    /if\s*\(debounceTimer\)\s*\{\s*clearTimeout\(debounceTimer\);/.test(last),
    '卸载钩子未清 debounceTimer（设置页↔聊天往返累积悬挂计时器）',
  );
});

// ═══ T11-I 气泡反馈计时器清理 ═══

group('=== T11-I MessageBubble 反馈计时器清理 ===');
check('T11-I 结构钉：copied/copyFailed 1200ms setTimeout 句柄收敛 + onBeforeUnmount 清除', () => {
  assert.ok(
    /import\s*\{[^}]*onBeforeUnmount[^}]*\}\s*from\s*'vue'/.test(bubbleSrc),
    'MessageBubble 未从 vue 导入 onBeforeUnmount（无卸载清理钩子）',
  );
  assert.ok(
    /let\s+copyFeedbackTimer\s*:\s*number\s*\|\s*null\s*=\s*null;/.test(bubbleSrc),
    'MessageBubble 缺组件级反馈计时器句柄 copyFeedbackTimer（setTimeout 散置无跟踪）',
  );
  const unmountBlocks = hookBlocks(bubbleSrc, 'onBeforeUnmount');
  assert.ok(
    unmountBlocks.some((b) => b.includes('clearTimeout(copyFeedbackTimer)')),
    'onBeforeUnmount 未清 copyFeedbackTimer（气泡卸载后计时器仍触发）',
  );
  const copySrc = fnSrc(bubbleSrc, 'copyMessage');
  const trackerCalls = copySrc.match(/scheduleCopyFeedbackReset\(/g);
  assert.ok(
    trackerCalls !== null && trackerCalls.length === 2,
    `copyMessage 的两处反馈复位应统一走 scheduleCopyFeedbackReset 跟踪（得 ${trackerCalls ? trackerCalls.length : 0} 处）`,
  );
  assert.ok(
    !/window\.setTimeout\(/.test(copySrc),
    'copyMessage 仍存在裸 window.setTimeout（反馈计时器未收敛进句柄跟踪）',
  );
});

// ═══ T11-J 消息列表 / MCP 设置页计时器清理 ═══

group('=== T11-J MessageList / McpSettings 计时器清理 ===');
check('T11-J-1 结构钉：MessageList 两处 1500ms timer 句柄 Set 收敛 + 卸载全清', () => {
  assert.ok(
    /const\s+copyResetTimers\s*=\s*new Set<ReturnType<typeof setTimeout>>\(\);/.test(listSrc),
    'MessageList 缺 copyResetTimers 句柄 Set（setTimeout 散置无跟踪）',
  );
  const copySrc = fnSrc(listSrc, 'handleCopyClick');
  assert.equal(
    (copySrc.match(/copyResetTimers\.add\(timer\);/g) ?? []).length, 2,
    'handleCopyClick 两处 timer 应成对 copyResetTimers.add（成功/失败两路）',
  );
  assert.equal(
    (copySrc.match(/copyResetTimers\.delete\(timer\);/g) ?? []).length, 2,
    'handleCopyClick 到点回调应成对 copyResetTimers.delete（add/delete 成对）',
  );
  const unmountBlocks = hookBlocks(listSrc, 'onBeforeUnmount');
  assert.ok(
    unmountBlocks.some((b) => b.includes('copyResetTimers')),
    'onBeforeUnmount 未全清 copyResetTimers（列表卸载后反馈计时器仍触发）',
  );
});
check('T11-J-2 结构钉：McpSettings pushToast 3200ms timer 按 key 记 Map + 卸载遍历清', () => {
  assert.ok(
    /const\s+toastTimers\s*=\s*new Map<number, number>\(\);/.test(mcpSrc),
    'McpSettings 缺 toastTimers 句柄 Map（pushToast setTimeout 无跟踪）',
  );
  const toastSrc = fnSrc(mcpSrc, 'pushToast');
  assert.ok(toastSrc.includes('toastTimers.set(key, timer)'), 'pushToast 未把 timer 记入 toastTimers');
  assert.ok(toastSrc.includes('toastTimers.delete(key)'), 'pushToast 到点回调未从 toastTimers 摘除（add/delete 不成对）');
  const unmountBlocks = hookBlocks(mcpSrc, 'onBeforeUnmount');
  assert.ok(
    unmountBlocks.some((b) => b.includes('toastTimers')),
    'onBeforeUnmount 未遍历清 toastTimers（设置页卸载后 toast 计时器仍触发）',
  );
});

// ═══ T11-K 零用户可见行为变化（回归钉） ═══

group('=== T11-K 零用户可见行为回归钉 ===');
check('T11-K-1 票据 TTL 不变：WEB_DOWNLOAD_TTL_MS === 10min（导入直测）', () => {
  assert.equal(WEB_DOWNLOAD_TTL_MS, 10 * 60_000, `WEB_DOWNLOAD_TTL_MS=${WEB_DOWNLOAD_TTL_MS}，应为 600_000`);
});
check('T11-K-2 反馈/去抖时长字面不变：复制反馈 1200 / 代码块复制 1500 / toast 3200 / 搜索去抖 250', () => {
  assert.ok(/\},\s*1200\);/.test(bubbleSrc), 'MessageBubble 复制反馈 1200ms 时长字面变化');
  assert.equal((listSrc.match(/\},\s*1500\);/g) ?? []).length, 2, 'MessageList 代码块复制 1500ms 时长字面变化（应两处）');
  assert.ok(/\},\s*3200\);/.test(mcpSrc), 'McpSettings toast 3200ms 时长字面变化');
  assert.ok(sidebarSrc.includes('}, 250);'), 'AppSidebar 搜索去抖 250ms 窗口字面变化');
});
check('T11-K-3 行为直测：≤32 内补丁缓存照常命中（同键两次 getPatch 后端仅 1 次、值一致）', async () => {
  const h = await makeHarness();
  const first = await h.store.getPatch('sk', 't0', null, 'p.ts', 1);
  const second = await h.store.getPatch('sk', 't0', null, 'p.ts', 1);
  assert.equal(h.state.patchCalls, 1, `同键两次 getPatch 后端请求数=${h.state.patchCalls}，应命中缓存仅 1 次`);
  assert.deepEqual(second, first, '缓存命中返回值与首拉不一致');
});

// ── 汇总 ──

(async (): Promise<void> => {
  for (const run of queue) await run();
  console.log(`\n=== P11 汇总：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('脚本本身异常：', e);
  process.exit(2);
});
