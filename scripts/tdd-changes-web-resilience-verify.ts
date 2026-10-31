// scripts/tdd-changes-web-resilience-verify.ts
// 计划 docs/plans/2026-10-26-turn-file-changes-diff-and-web-changes-fix-plan.md §4-P6 契约脚本：
// 网页版改动面板断线不自愈（R1）修复钉。
//
// 病根（计划 §2.2-R1，已核实）：stores/changes-store.ts refresh() 只有 try/finally 没有 catch——
// web 桥断线（重连退避窗口 1-15s）恰逢回合结束 500ms 防抖刷新或切会话刷新时，listChanges
// reject（'Web 桥未连接'）成为 unhandled rejection → files 被清空且 error=null → 面板假空态
// 「工作目录无改动」；且 web-bridge 的 runRealignSequence 重连对齐序列不含 changes、watch 侧
// F-5 短路守卫使同 id/workingDir 重入不重拉 → 断线窗口错过即永不自愈。
// 修法：①refresh 补 catch（落 error 态 + 保留旧 files，陈旧优于假空态，不重抛）；
// ②refresh 直呼路径加 F-5 同源守卫（同 id/wd 且非 force / 非 invalidateDiffs → 跳过），
//   force=true 或 invalidateDiffs=true（回合结束刷新/重连对齐/面板重试）绕过强制重拉；
// ③web-bridge 导出 onRealigned(cb)/notifyRealigned()，runRealignSequence 收口时依次通知
//   （单个回调异常不阻断后续）；④changes-store 于初始化时注册 onRealigned → refresh(true)；
// ⑤ChangesPanel 顶部 error 横条 +「重试」按钮（refresh(true)），空态仅在 !error 时显示。
//
// round-002（review F1/F2/F3）补钉：
// ⑥ChangesPanel 头部「刷新」按钮改 refresh(false, true)（force 绕 F-5 同源守卫，保手动强制重扫入口）；
// ⑦失败横条改 keyed on refreshFailed（error 与 ensureDiff 共享、!wd 的「无会话」error 非失败态，
//   不再误渲染「刷新失败…已保留上次列表」）；「已保留上次列表」仅 files 非空（reject 保留旧列表）时拼接；
//   空态三级化（sessionless：「当前没有活动会话或工作目录」）；
// ⑧失败路径（!res.ok / reject catch）重置 lastRefreshedId/Wd——失败不留「已拉取」假象，
//   重挂载 onMounted refresh() 同 id/wd 直呼可自愈（不被同源守卫短路）。
//
// 测试形态：§1–§5 行为级（tsx/Node + pinia 真跑 changes-store；web-bridge 导出函数最小桩），
// §6 静态钉（源码文本断言，钉住 catch 形态 / watch F-5 原位 / 挂钮接线）。
//
// 运行：npx tsx scripts/tdd-changes-web-resilience-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function settle(name: string, err: unknown): void {
  if (err === null) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name} — ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
  }
}
function check(name: string, fn: () => void): void {
  try {
    fn();
    settle(name, null);
  } catch (e) {
    settle(name, e);
  }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    settle(name, null);
  } catch (e) {
    settle(name, e);
  }
}

// unhandledRejection 收集器：R1 修复的核心契约之一就是「不再产生 unhandled rejection」——
// 全程收集、末尾断言为空（修复前 reject 直穿 → 此处非空 + error 未落态，双红）。
const unhandled: string[] = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(reason instanceof Error ? reason.message : String(reason));
});

const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 行为级依赖装载：必须走 CJS require——tsx 将本脚本按 CJS 编译，require 拿到的 pinia 与
// store 图内（changes-store 静态 import 'pinia'）是同一模块实例；若用动态 import() 会解析到
// ESM 副本 → setActivePinia 跨实例失效（getActivePinia 无 active Pinia 报错）。
// eslint 冲突规避与 tdd-bugfix-hb10-changes-boundary-verify.ts 同款。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const req = require as NodeRequire;
const { createPinia, setActivePinia } = req('pinia') as typeof import('pinia');
const { useSessionStore } = req('../src/renderer/stores/session-store') as any;
const { useChangesStore } = req('../src/renderer/stores/changes-store') as any;
const { useTurnDiffStore } = req('../src/renderer/stores/turn-diff-store') as any;
const webBridge = req('../src/renderer/web/web-bridge') as any;

// ── 行为级测试座驾：每节独立 pinia + 独立 mock bridge，互不污染 ──

interface ChangedFileMock {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  touchedThisSession: boolean;
}

const OK_FILES: ChangedFileMock[] = [
  { path: 'src/a.ts', status: 'M', additions: 3, deletions: 1, binary: false, touchedThisSession: true },
  { path: 'docs/b.md', status: '??', additions: null, deletions: null, binary: false, touchedThisSession: false },
];

type BridgeMode = 'ok' | 'reject' | 'notok';

async function freshHarness(marker: boolean): Promise<{
  store: any;
  sessionStore: any;
  calls: Array<{ wd: string | null; touched: string[] }>;
  setMode: (m: BridgeMode) => void;
}> {
  const calls: Array<{ wd: string | null; touched: string[] }> = [];
  let mode: BridgeMode = 'ok';
  const claudeLink = {
    listChanges: async (wd: string | null, touched: string[]) => {
      calls.push({ wd, touched: [...touched] });
      if (mode === 'reject') throw new Error('Web 桥未连接');
      if (mode === 'notok') return { ok: false, reason: 'git-error', message: 'git 炸了' };
      return { ok: true, files: OK_FILES, baselineRef: 'abcdef1234567' };
    },
  };
  (globalThis as any).window = { claudeLink, __claudeLinkWebBridge: marker };
  setActivePinia(createPinia());
  const sessionStore = useSessionStore() as any;
  const store = useChangesStore() as any;
  return { store, sessionStore, calls, setMode: (m: BridgeMode) => { mode = m; } };
}

// ── turn-diff-store 测试座驾（R3 §7 用）：独立 pinia + listTurnDiffSummaries mock，互不污染 ──

const TD_SUMMARIES: Array<{ turnStartMessageId: string; items: Array<{ path: string; mode: string; additions: number; deletions: number; writeCount: number }> }> = [
  { turnStartMessageId: 'u1', items: [{ path: 'src/a.ts', mode: 'full', additions: 3, deletions: 1, writeCount: 2 }] },
];

type TdBridgeMode = 'ok' | 'reject';

async function freshTurnDiffHarness(marker: boolean, mode: TdBridgeMode = 'ok'): Promise<{
  store: any;
  sessionStore: any;
  calls: string[];
  setMode: (m: TdBridgeMode) => void;
}> {
  const calls: string[] = [];
  let m: TdBridgeMode = mode;
  const claudeLink = {
    listTurnDiffSummaries: async (sid: string) => {
      calls.push(sid);
      if (m === 'reject') throw new Error('Web 桥未连接');
      return TD_SUMMARIES;
    },
    getTurnFilePatch: async () => ({ mode: 'full', patch: '', truncated: false }),
  };
  (globalThis as any).window = { claudeLink, __claudeLinkWebBridge: marker };
  setActivePinia(createPinia());
  const sessionStore = useSessionStore() as any;
  const store = useTurnDiffStore() as any;
  return { store, sessionStore, calls, setMode: (n: TdBridgeMode) => { m = n; } };
}

async function main(): Promise<void> {
  console.log('=== 1) 行为级：断线 reject → error 落态 + files 保留旧值（不清空、不 unhandled） ===');
  await checkAsync('①-1 首拉成功基线：files/baselineRef 落态、error 空', async () => {
    const { store, sessionStore, calls } = await freshHarness(false);
    sessionStore.activeSession = { id: 's1', workingDir: '/repo/w1' };
    await tick();
    assert.equal(calls.length, 1, `首拉应恰发一次 listChanges，实际 ${calls.length}`);
    assert.equal(store.error, null, '成功后 error 应为 null');
    assert.equal(store.files.length, 2, '成功后 files 应为 mock 两文件');
    assert.equal(store.baselineRef, 'abcdef1234567', '成功后 baselineRef 应落态');
    assert.equal(store.loading, false, '完成后 loading 应复位');
  });
  await checkAsync('①-2 直呼 refresh(true) 撞 reject：不抛出、error 落态、files 保留旧值（陈旧优于假空态）', async () => {
    const { store, sessionStore, calls, setMode } = await freshHarness(false);
    sessionStore.activeSession = { id: 's1', workingDir: '/repo/w1' };
    await tick();
    setMode('reject');
    await store.refresh(true); // 回合结束刷新同参形态（invalidateDiffs=true）；修复前此处 reject 直穿
    assert.match(String(store.error), /Web 桥未连接/, `error 应含 reject 消息，实际 ${String(store.error)}`);
    assert.equal(store.files.length, 2, 'reject 后 files 必须保留旧值（假空态根因）');
    assert.equal(store.loading, false, '失败路径 loading 也要收尾');
    assert.ok(calls.length >= 2, 'reject 路径应真实发起过第二次请求');
  });
  await checkAsync('①-3 not-ok 降级分支（res.ok=false）行为不变：files 清空 + message 落 error', async () => {
    const { store, sessionStore, setMode } = await freshHarness(false);
    sessionStore.activeSession = { id: 's1', workingDir: '/repo/w1' };
    await tick();
    setMode('notok');
    await store.refresh(true);
    assert.equal(store.error, 'git 炸了', 'not-ok 分支 error 应为 message');
    assert.equal(store.files.length, 0, 'not-ok（明确失败结果）仍清空列表——与 reject（传输层断线）区分');
  });

  await checkAsync('①-4 三态标记（round-002 F2）：!wd 直呼不出横条（refreshFailed=false+sessionless=true）；成功双 false；not-ok → refreshFailed=true', async () => {
    const { store, sessionStore, calls, setMode } = await freshHarness(false);
    // 无会话直呼：error 提示落态（文本契约不变）但非失败态——横条不出，空态显「无会话」文案。
    await store.refresh();
    assert.equal(calls.length, 0, '无 wd 不得发起 listChanges');
    assert.equal(store.error, '当前没有活动会话或工作目录', '!wd 分支 error 文本契约不变');
    assert.equal(store.refreshFailed, false, '!wd 分支不得置 refreshFailed（横条不出）');
    assert.equal(store.sessionless, true, '!wd 分支应置 sessionless（空态显无会话文案）');
    // 成功路径：双标记复位 false。
    sessionStore.activeSession = { id: 's1', workingDir: '/repo/w1' };
    await tick();
    assert.equal(store.refreshFailed, false, '成功路径 refreshFailed 应为 false');
    assert.equal(store.sessionless, false, '成功路径 sessionless 应复位 false');
    // not-ok（res.ok=false）：真实失败 → refreshFailed=true + files 清空（横条据此不拼「已保留上次列表」）。
    setMode('notok');
    await store.refresh(true);
    assert.equal(store.refreshFailed, true, 'not-ok 失败分支应置 refreshFailed');
    assert.equal(store.sessionless, false, 'not-ok 分支 sessionless 应为 false');
    assert.equal(store.files.length, 0, 'not-ok 清空 files——横条文案不含「已保留上次列表」的状态据点');
  });

  console.log('=== 2) 行为级：refresh 直呼 F-5 同源守卫（同 id/wd 短路；force / invalidateDiffs 绕过） ===');
  await checkAsync('②-1 同 id/wd 直呼 refresh() 短路；refresh(false, true)（force）绕过重拉', async () => {
    const { store, sessionStore, calls } = await freshHarness(false);
    sessionStore.activeSession = { id: 's1', workingDir: '/repo/w1' };
    await tick();
    assert.equal(calls.length, 1);
    await store.refresh(); // 同 id/wd、非 force 非 invalidateDiffs → 守卫短路
    assert.equal(calls.length, 1, '同 id/wd 直呼 refresh() 应被守卫短路');
    await store.refresh(false, true); // force=true → 绕过守卫强制重拉
    assert.equal(calls.length, 2, 'force=true 必须绕过 F-5 同源守卫重拉');
    await store.refresh(true); // invalidateDiffs=true（回合结束刷新形态）→ 绕过守卫
    assert.equal(calls.length, 3, 'invalidateDiffs=true（回合结束刷新）必须绕过守卫重拉');
  });
  await checkAsync('②-2 切 workingDir 仍必重拉（hb12-CHG-01 不弱化）；同 id/wd 整对象替换 watch 仍短路（F-5 原位）', async () => {
    const { store, sessionStore, calls } = await freshHarness(false);
    sessionStore.activeSession = { id: 's1', workingDir: '/repo/w1' };
    await tick();
    assert.equal(calls.length, 1);
    sessionStore.activeSession = { id: 's1', workingDir: '/repo/w2' };
    await tick();
    assert.equal(calls.length, 2, '同会话切 wd 必须重拉（hb12-CHG-01）');
    assert.equal(calls[1].wd, '/repo/w2', '第二次拉取应携带新 workingDir');
    // updateSession 往返形态：activeSession 整对象替换但 id+wd 均未变 → watch F-5 短路（原位保留）。
    sessionStore.activeSession = { id: 's1', workingDir: '/repo/w2', model: 'm1' };
    await tick();
    assert.equal(calls.length, 2, 'id+wd 未变的整对象替换不得触发冗余全量扫描（F-5 语义不弱化）');
  });

  await checkAsync('②-3 失败重置 lastRefreshed（round-002 F3）：失败后同 id/wd 直呼 refresh() 必须真实重拉（重挂载自愈）', async () => {
    const { store, sessionStore, calls, setMode } = await freshHarness(false);
    sessionStore.activeSession = { id: 's1', workingDir: '/repo/w1' };
    await tick();
    assert.equal(calls.length, 1, '前置：首拉完成');
    setMode('reject');
    await store.refresh(true);
    assert.equal(calls.length, 2, '前置：失败重拉已发起');
    assert.ok(store.refreshFailed, '前置：失败已落 refreshFailed');
    setMode('ok');
    await store.refresh(); // 同 id/wd 直呼——失败若未重置 lastRefreshed 将被守卫短路（calls 不增）
    assert.equal(calls.length, 3, '失败后必须重置 lastRefreshed：同 id/wd 直呼不得被守卫短路（重挂载 refresh() 自愈）');
    assert.equal(store.refreshFailed, false, '自愈成功后 refreshFailed 复位');
    assert.equal(store.files.length, 2, '自愈成功后列表恢复');
  });

  console.log('=== 3) 行为级：成功路径 error 清空（d） ===');
  await checkAsync('③ 失败落 error 后再次成功 → error 清空、列表刷新、baseline 恢复', async () => {
    const { store, sessionStore, setMode } = await freshHarness(false);
    sessionStore.activeSession = { id: 's1', workingDir: '/repo/w1' };
    await tick();
    setMode('reject');
    await store.refresh(true);
    assert.ok(store.error, '前置：失败已落 error');
    setMode('ok');
    await store.refresh(true);
    assert.equal(store.error, null, '成功路径必须清空 error');
    assert.equal(store.files.length, 2, '成功后列表恢复');
    assert.equal(store.baselineRef, 'abcdef1234567', 'baseline 恢复');
  });

  console.log('=== 4) 行为级：web-bridge onRealigned/notifyRealigned 注册/解绑/依次通知（c-桩验证） ===');
  await checkAsync('④-1 notifyRealigned 依次通知；单个回调抛错不阻断后续；返回解绑函数生效', async () => {
    const wb = webBridge;
    assert.equal(typeof wb.onRealigned, 'function', 'web-bridge 缺 onRealigned 导出');
    assert.equal(typeof wb.notifyRealigned, 'function', 'web-bridge 缺 notifyRealigned 导出');
    const order: string[] = [];
    const un1 = wb.onRealigned(() => {
      order.push('cb1');
      throw new Error('cb1 炸了');
    });
    assert.equal(typeof un1, 'function', 'onRealigned 必须返回解绑函数');
    const un2 = wb.onRealigned(() => {
      order.push('cb2');
    });
    wb.notifyRealigned(); // cb1 抛错 → 不得阻断 cb2
    assert.deepEqual(order, ['cb1', 'cb2'], `通知序错或不阻断失效：${JSON.stringify(order)}`);
    un2();
    wb.notifyRealigned();
    assert.deepEqual(order, ['cb1', 'cb2', 'cb1'], '解绑后不应再通知 cb2');
    un1();
    wb.notifyRealigned();
    assert.equal(order.length, 3, '解绑后不应再通知 cb1');
  });

  console.log('=== 5) 行为级：changes-store 注册 onRealigned → 通知触发强制重拉（端到端最小桩） ===');
  await checkAsync('⑤ notifyRealigned 触发 store 强制重拉（绕过同 id/wd 守卫）', async () => {
    const wb = webBridge;
    const { store, sessionStore, calls } = await freshHarness(true); // marker=true → store 应注册挂钩
    sessionStore.activeSession = { id: 's1', workingDir: '/repo/w1' };
    await tick();
    assert.equal(calls.length, 1, '前置：首拉完成');
    // 注册经动态 import 异步完成 → 轮询通知直至触发（注册前通知为 no-op），上限 20 轮。
    let fired = false;
    for (let i = 0; i < 20 && !fired; i++) {
      const before = calls.length;
      wb.notifyRealigned();
      await tick(20);
      fired = calls.length > before;
    }
    assert.ok(fired, 'notifyRealigned 未触发 changes 强制重拉（注册链路断）');
    assert.equal(store.error, null, '重拉成功后 error 保持空');
    assert.equal(store.files.length, 2, '重拉后列表为最新');
  });

  console.log('=== 6) 静态钉：catch 形态 / watch F-5 原位 / runRealignSequence 收口 / 面板横条接线 ===');
  const storeSrc = read('src/renderer/stores/changes-store.ts');
  const bridgeSrc = read('src/renderer/web/web-bridge.ts');
  const panelSrc = read('src/renderer/components/changes/ChangesPanel.vue');

  check('⑥-1 refresh 签名含 invalidateDiffs + force 双可选参', () => {
    assert.match(storeSrc, /async function refresh\(invalidateDiffs = false, force = false\)/, 'refresh 签名缺 force 可选参');
  });
  check('⑥-2 refresh 直呼 F-5 同源守卫存在且 !force / !invalidateDiffs 可绕过', () => {
    assert.match(
      storeSrc,
      /if \(!force && !invalidateDiffs && lastRefreshedId !== undefined && id === lastRefreshedId && wd === lastRefreshedWd\) return;/,
      '缺同源早退守卫（同 id/wd 且非 force / 非 invalidateDiffs → 跳过）',
    );
  });
  check('⑥-3 refresh 补 catch：error 落态 + 不清 files + 陈旧代际不写 + finally 收尾保留', () => {
    const refreshIdx = storeSrc.indexOf('async function refresh(');
    assert.ok(refreshIdx > -1, '未定位到 refresh');
    const finallyIdx = storeSrc.indexOf('} finally {', refreshIdx);
    assert.ok(finallyIdx > -1, 'refresh 缺 finally');
    const tryBody = storeSrc.slice(refreshIdx, finallyIdx);
    const catchIdx = tryBody.indexOf('} catch (err) {');
    assert.ok(catchIdx > -1, 'refresh 缺 catch (err)——reject 仍将直穿成 unhandled rejection');
    const catchBody = tryBody.slice(catchIdx);
    assert.ok(!/files\.value = \[\]/.test(catchBody), 'catch 内不得清空 files（陈旧优于假空态）');
    assert.match(catchBody, /error\.value = /, 'catch 未落 error 态');
    assert.match(catchBody, /gen === sessionGen && reqId === refreshRequestId/, 'catch 缺陈旧代际守卫（不得覆盖最新请求的状态）');
  });
  check('⑥-4 watch 侧 F-5 短路守卫原位保留（tdd-bugfix-hb10-changes-p3-verify ⑩ 兼容，不弱化）', () => {
    const wIdx = storeSrc.indexOf('sessionStore.activeSession?.id, sessionStore.activeSession?.workingDir');
    assert.ok(wIdx > -1, '未找到切会话 watch 源');
    const wSeg = storeSrc.slice(wIdx, wIdx + 900);
    assert.match(wSeg, /lastWatchedId/, 'watch 回调缺 id+wd 短路守卫');
    assert.match(wSeg, /lastWatchedWd/, 'watch 守卫缺 workingDir 维度');
    assert.match(wSeg, /if \(lastWatchedId !== undefined && id === lastWatchedId && wd === lastWatchedWd\) return;/, 'watch F-5 守卫文本形态被改动');
  });
  check('⑥-5 changes-store 初始化注册 onRealigned → refresh(true)，且仅在网页桥标记下动态 import', () => {
    assert.match(storeSrc, /__claudeLinkWebBridge/, '注册缺网页桥标记守卫（桌面将误加载 web-bridge chunk）');
    assert.match(storeSrc, /onRealigned\(\(\) => \{ void refresh\(true\); \}\)/, '未按 refresh(true) 形态注册重连对齐回调');
    assert.match(storeSrc, /import\('\.\.\/web\/web-bridge'\)/, '未动态 import web-bridge（静态 import 会污染桌面 chunk）');
  });
  check('⑥-6 web-bridge 导出 onRealigned(cb): () => void 与 notifyRealigned（回调逐个 try 包裹）', () => {
    assert.match(bridgeSrc, /export function onRealigned\(cb: \(\) => void\): \(\) => void \{/, 'onRealigned 导出形态不符');
    assert.match(bridgeSrc, /export function notifyRealigned\(\): void \{/, 'notifyRealigned 导出形态不符');
    const notifyIdx = bridgeSrc.indexOf('export function notifyRealigned(');
    const notifyBody = bridgeSrc.slice(notifyIdx, bridgeSrc.indexOf('\n}', notifyIdx));
    assert.match(notifyBody, /try \{[\s\S]*cb\(\);[\s\S]*\} catch \{/, 'notifyRealigned 回调未逐个 try 包裹（单回调异常将阻断后续）');
  });
  check('⑥-7 runRealignSequence 收尾调用 notifyRealigned()', () => {
    const start = bridgeSrc.indexOf('async function runRealignSequence(');
    assert.ok(start > -1, '未定位到 runRealignSequence');
    const end = bridgeSrc.indexOf('\n}', start);
    const seg = bridgeSrc.slice(start, end);
    assert.match(seg, /notifyRealigned\(\);/, 'runRealignSequence 收尾未通知重连对齐回调');
  });
  check('⑥-8 ChangesPanel：失败横条 keyed on refreshFailed（「已保留上次列表」仅 files 非空拼接）+ 空态三级化（round-002 F2）', () => {
    assert.match(panelSrc, /v-if="store\.refreshFailed"/, '失败横条未 keyed on refreshFailed（非失败态 error 仍被误渲染成刷新失败）');
    assert.match(panelSrc, /刷新失败：\{\{ store\.error \}\}/, '横条缺「刷新失败：{{ store.error }}」文案');
    assert.match(
      panelSrc,
      /\{\{ store\.files\.length > 0 \? '，已保留上次列表' : '' \}\}/,
      '「已保留上次列表」必须仅在 files 非空时条件拼接（not-ok 清空后不得误述）',
    );
    assert.match(panelSrc, /@click="store\.refresh\(true\)"[\s\S]{0,80}>重试</, '重试按钮未接 refresh(true)');
    assert.match(panelSrc, /v-if="store\.sessionless"/, '缺无会话空态（sessionless 分支）');
    assert.match(panelSrc, />当前没有活动会话或工作目录</, '缺无会话空态文案');
    assert.match(
      panelSrc,
      /v-else-if="!store\.refreshFailed && !store\.files\.length && !store\.loading"/,
      '「工作目录无改动」空态条件不符（须 !refreshFailed 且列表空且非加载）',
    );
  });
  check('⑥-9 不动面：ensureDiff 既有 catch 原样保留；changes-panel.ts / DiffDialog.vue 未改', () => {
    assert.match(
      storeSrc,
      /hb10-CHG-V03：失败更新 error 态（不再 unhandled rejection）/,
      'ensureDiff 既有 catch 注释锚点丢失（不应被本次改动触碰）',
    );
    const panel = read('src/main/modules/changes-panel.ts');
    assert.ok(panel.includes('export async function getChangeDiff'), 'changes-panel.ts 被意外改动');
  });

  // 全程零 unhandled rejection（R1 修复契约之一）。
  check('⑥-10 全程零 unhandledRejection', () => {
    assert.deepEqual(unhandled, [], `出现 unhandled rejection：${JSON.stringify(unhandled)}`);
  });

  check('⑥-11 ChangesPanel 头部「刷新」按钮 wiring 必须为 force 形态（round-002 F1：绕 F-5 同源守卫保手动强制重扫入口）', () => {
    assert.match(panelSrc, /@click="store\.refresh\(false, true\)"/, '头部刷新按钮未接 refresh(false, true)（force）——同 id/wd 点击将被同源守卫短路');
    assert.ok(!/@click="store\.refresh\(\)"/.test(panelSrc), '面板仍存在无参 refresh() 直呼 wiring（守卫短路形态残留）');
  });

  check('⑥-12 store 失败语义标记（refreshFailed/sessionless）+ 失败路径重置 lastRefreshed（round-002 F2/F3）', () => {
    assert.match(storeSrc, /const refreshFailed = ref\(false\);/, '缺 refreshFailed 失败标记');
    assert.match(storeSrc, /const sessionless = ref\(false\);/, '缺 sessionless 标记');
    assert.match(storeSrc, /refreshFailed, sessionless/, 'refreshFailed/sessionless 未从 store 导出（面板无法 keyed）');
    // !wd 分支：error 写入文本与位置契约钉死不动，只叠加双标记。
    const wdIdx = storeSrc.indexOf('if (!wd) {');
    assert.ok(wdIdx > -1, '未定位到 !wd 分支');
    const wdBody = storeSrc.slice(wdIdx, storeSrc.indexOf('\n    }', wdIdx));
    assert.match(wdBody, /error\.value = '当前没有活动会话或工作目录';/, '!wd 分支 error 写入文本/位置不得变动（既有契约）');
    assert.match(wdBody, /sessionless\.value = true;/, '!wd 分支未置 sessionless=true');
    assert.match(wdBody, /refreshFailed\.value = false;/, '!wd 分支未复位 refreshFailed=false');
    // 失败路径（!res.ok + reject catch）：置 refreshFailed=true + 重置 lastRefreshedId/Wd（F3）。
    const notOkIdx = storeSrc.indexOf('if (!res.ok) {');
    assert.ok(notOkIdx > -1, '未定位到 !res.ok 分支');
    const notOkBody = storeSrc.slice(notOkIdx, storeSrc.indexOf('\n      } else {', notOkIdx));
    assert.match(notOkBody, /refreshFailed\.value = true;/, '!res.ok 失败分支未置 refreshFailed=true');
    assert.match(notOkBody, /lastRefreshedId = undefined;/, '!res.ok 失败分支未重置 lastRefreshedId（F3）');
    assert.match(notOkBody, /lastRefreshedWd = undefined;/, '!res.ok 失败分支未重置 lastRefreshedWd（F3）');
    assert.match(notOkBody, /sessionless\.value = false;/, '!res.ok 失败分支未复位 sessionless');
    const resetCount = (storeSrc.match(/lastRefreshedId = undefined;/g) ?? []).length;
    assert.ok(resetCount >= 2, `失败路径（!res.ok + catch）均须重置 lastRefreshedId，实际 ${resetCount} 处`);
    const failMarkCount = (storeSrc.match(/refreshFailed\.value = true;/g) ?? []).length;
    assert.ok(failMarkCount >= 2, `失败路径（!res.ok + catch）均须置 refreshFailed=true，实际 ${failMarkCount} 处`);
  });

  console.log('=== 7) 行为级 + 静态钉：turn-diff-store 断线自愈（onRealigned → force 重拉）+ 摘要失败可见（R3） ===');
  await checkAsync('⑦-1 onRealigned 回调触发后 loadSummaries(force) 绕过缓存早退（首拉与强制重拉两次 invoke 均被调用）', async () => {
    const { store, sessionStore, calls } = await freshTurnDiffHarness(true); // marker=true → store 应注册挂钩
    sessionStore.activeSession = { id: 's1', workingDir: '/repo/w1' };
    await tick();
    assert.equal(calls.length, 1, '前置：watch immediate 首拉完成');
    await store.loadSummaries('s1'); // 有缓存 → 早退，不得 invoke
    assert.equal(calls.length, 1, `有缓存时直呼 loadSummaries() 应被缓存早退短路，实际 invoke ${calls.length} 次`);
    // 注册经动态 import 异步完成 → 轮询通知直至触发（注册前通知为 no-op），上限 20 轮（⑤ 同款）。
    let fired = false;
    for (let i = 0; i < 20 && !fired; i++) {
      const before = calls.length;
      webBridge.notifyRealigned();
      await tick(20);
      fired = calls.length > before;
    }
    assert.ok(fired, 'notifyRealigned 未触发 turn-diff 强制重拉（注册链路断）');
    assert.ok(store.summariesBySession['s1'], '强制重拉后摘要缓存应在位（失效→重拉→落态闭环）');
    assert.equal(store.summariesError, null, '重拉成功后 summariesError 保持空');
  });
  await checkAsync('⑦-2 summariesError 置位后成功 loadSummaries(force) 清空（error 复位语义）', async () => {
    const { store, sessionStore, setMode } = await freshTurnDiffHarness(true, 'reject');
    sessionStore.activeSession = { id: 's1', workingDir: '/repo/w1' };
    await tick();
    assert.match(String(store.summariesError), /Web 桥未连接/, '前置：失败已落 summariesError');
    assert.ok(!store.summariesBySession['s1'], '前置：失败不缓存（摘要缺席）');
    setMode('ok');
    await store.loadSummaries('s1', true);
    assert.equal(store.summariesError, null, '成功路径必须清空 summariesError');
    assert.ok(store.summariesBySession['s1'], '成功后摘要缓存落态');
  });
  const turnDiffStoreSrc = read('src/renderer/stores/turn-diff-store.ts');
  check('⑦-3 turn-diff-store：onRealigned 注册文本（标记守卫 + 动态 import + 失效当前会话 + force 重拉 + 注销函数留存）', () => {
    assert.match(turnDiffStoreSrc, /__claudeLinkWebBridge/, '注册缺网页桥标记守卫（桌面将误加载 web-bridge chunk）');
    assert.match(turnDiffStoreSrc, /import\('\.\.\/web\/web-bridge'\)/, '未动态 import web-bridge（静态 import 会污染桌面 chunk）');
    assert.match(turnDiffStoreSrc, /onRealigned\(/, '未注册 onRealigned 重连对齐回调');
    assert.match(turnDiffStoreSrc, /invalidateSummaries\(sid\);[\s\S]{0,80}loadSummaries\(sid, true\)/, '回调未按「失效当前会话摘要 + force 重拉」形态注册');
    assert.match(turnDiffStoreSrc, /realignedUnsubscribe/, '注销函数未留存（防重复注册守卫缺失）');
  });
  check('⑦-4 loadSummaries 第二参 force：缓存早退仅在 !force 生效', () => {
    assert.match(turnDiffStoreSrc, /async function loadSummaries\(sessionId: string, force = false\)/, 'loadSummaries 缺 force 可选参');
    assert.match(turnDiffStoreSrc, /if \(!force && summariesBySession\.value\[sessionId\]\) return;/, '缓存早退未按 !force 守卫（force 将被短路）');
  });
  check('⑦-5 MessageList：摘要失败轻提示行（v-else-if 挂载分支 + 文案 + 重试接 loadSummaries(sid, true)）', () => {
    const msgListSrc = read('src/renderer/components/chat/MessageList.vue');
    assert.match(msgListSrc, /v-else-if="item\.type === 'message' && turnDiffErrorRows\.has\(item\.message\.id\)"/, '缺摘要失败轻提示 v-else-if 分支');
    assert.match(msgListSrc, />轮末改动摘要加载失败</, '缺「轮末改动摘要加载失败」文案');
    assert.match(msgListSrc, /@click="retryTurnDiffSummaries"/, '重试按钮未接线');
    assert.match(msgListSrc, /loadSummaries\(sid, true\)/, '重试未走 force 形态 loadSummaries(sid, true)');
  });
  await checkAsync('⑦-6 切会话清旧错误态（summariesError 非会话键控）：上一会话 reject 置位后切新会话 → watch if(id) 分支清空，在途窗口不得用旧错误误渲染新会话失败行', async () => {
    const { store, sessionStore, calls } = await freshTurnDiffHarness(false, 'reject');
    sessionStore.activeSession = { id: 's1', workingDir: '/repo/w1' };
    await tick();
    assert.match(String(store.summariesError), /Web 桥未连接/, '前置：s1 首拉失败已置 summariesError');
    // s2 拉取改为可控挂起，把「新会话在途窗口」钉成可断言的确定性状态（若直接放行 reject，
    // 失败会在窗口后立即重新置位错误——语义自洽，但终态与修复前不可区分，测不到本修复）。
    const w = (globalThis as any).window;
    let releaseS2: () => void = () => {};
    const s2Gate = new Promise<void>((resolve) => { releaseS2 = resolve; });
    const origList = w.claudeLink.listTurnDiffSummaries;
    w.claudeLink.listTurnDiffSummaries = async (sid: string) => {
      if (sid === 's2') {
        calls.push(sid); // 挂起包装不直呼 origList（reject 模式会抛），调用计数须自行记账
        await s2Gate;
        return TD_SUMMARIES;
      }
      return origList(sid);
    };
    try {
      sessionStore.activeSession = { id: 's2', workingDir: '/repo/w1' };
      await tick(); // watch 已跑：清旧错误 + 发起 s2 拉取（仍在途）
      assert.ok(calls.includes('s2'), '前置：切会话已发起 s2 拉取');
      assert.equal(store.summariesLoading, true, '前置：s2 拉取在途（loading 在位）');
      assert.equal(store.summariesError, null, '切会话必须清空上一会话的陈旧 summariesError（在途窗口不得误渲染新会话失败行）');
    } finally {
      w.claudeLink.listTurnDiffSummaries = origList;
      releaseS2();
    }
    await tick();
    assert.ok(store.summariesBySession['s2'], '放行后 s2 摘要缓存落态（清错误 → 重拉 → 成功闭环）');
    assert.equal(store.summariesError, null, 's2 成功后 summariesError 仍为空');
  });
}

main()
  .catch((e) => {
    fail += 1;
    console.log(`  ❌ 异步驱动异常：${e instanceof Error ? e.stack : String(e)}`);
  })
  .then(() => {
    console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
    if (fail > 0) {
      process.exit(1);
    }
    console.log('OK');
  });
