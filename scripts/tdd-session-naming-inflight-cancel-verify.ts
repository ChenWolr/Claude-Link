// scripts/tdd-session-naming-inflight-cancel-verify.ts
// B3 命名 LLM 在飞取消 契约卷（2026-11-15-eight-issues-batch，03-test-cases-main.md §4 B3-01~06 + B3-S1/S2；
// 行为契约 00-behavior-specs.md 域 B B3；实现细节 01-impl-details-main.md §B3-1~B3-5）。
//
// 用例映射：
//   B3-01（行为·条款1 前半）用户中断边沿取消在飞命名 HTTP——abort 信号触发 + abort 不删 Map 键
//     （键删除统一由 finally，防 cancel/finally 竞态双删）+ finally 落键。killProcess('user') 边沿
//     的调用接线由 B3-S1 结构钉钉住；行为面经同一取消收口 cancelSessionTopicAnalysis 驱动。
//   B3-02（行为·条款1 前半·第二边沿）会话删除边沿取消在飞命名 HTTP——markSessionDeleted 边沿接线
//     由 B3-S1 钉；本用例行为面 = 取消 → stub 手动 resolve → 断言无 DB 写（B3-06 联动断言按用例
//     文本并入本卷）。
//   B3-03（行为·条款1 红线）拆三断言组：a) 3 连败每次无 updateSession 写且返回 null；
//     b) 第 4 次调度被预算闸拒绝（HTTP 调用数停在第 3 次）；c) 在飞取消后重新触发仍可满额调度
//     （预算未被取消的那次额外消耗）。
//   B3-04（结构·条款1 红线·deadline）30s deadline 语义不变——结构钉。【无注入面申报】deadline
//     常量为模块级 const（TOPIC_TOTAL_DEADLINE_MS），无注入通道可缩短，行为辅断言不可建，
//     结构钉单独成立（闸门条款明示允许形态）；常量存在性/竞速接线由本钉 +
//     tdd-bugfix-hb10-session-p3-verify（TOPIC_TOTAL_DEADLINE_MS=30_000|30*1000 + Promise.race）双卷守护。
//   B3-05（行为·派生边界）取消落在命名完成后：幂等无副作用（不抛错、已写库名字不回滚、无第二次 HTTP）。
//   B3-06（行为·派生边界·并发）abort 后响应才 resolve：不写库、预算计数不变、无渲染层名字更新事件。
//   INV（行为·§B3-2 不变量）4xx 升档梯行为不变：答卷被拒升档第二次调用携带同一 signal；
//     AbortError 不命中 4xx 升档分支（不引发升档续请求——「取消不占后续预算」的机制兑现点）。
//   B3-S1（结构）用户中断与会话删除两条边沿都必须触达命名 LLM 在飞取消动作；恰两条边沿
//     （watchdog 等系统理由不扩，有意收窄申报）；cancel 本体取 controller→abort 且不删 Map 键。
//   B3-S2（结构）命名写库点之前存在取消闩：signal 透传进 HTTP 调用点（abort → 请求 reject →
//     catch 链 break → return null，写库点不可达）；升档门 = error instanceof HttpStatusError &&
//     status 4xx（AbortError 不匹配）；写库点保留 isAutoNameSlot 重查（resolve 竞态获胜态的
//     一致性兜底，01 §B3-4 边界表）。
//
// 驱动手法（03 §4「若 LLM 客户端无独立模块面，按 vm 抽取降级（头注申报）」申报）：
//   topic-analyzer 的 LLM HTTP 调用面是模块内私有 makeHttpRequest（无独立 LLM 客户端模块面、
//   模块依赖 electron 连接面不可直接 import），故按 vm 整模块装载降级：TS→CJS 转译后入 vm，
//   require 垫片把 https/http 替换为可控 fake（捕获 options.signal、手动 respond/fail、abort
//   监听器内 req.destroy(AbortError) 模拟 Node≥16 原生 signal 语义），electron 面依赖
//   （config-manager/session-repo/message-repo/logger/push-bus）为手写 stub，shared 纯函数走真实模块。
//   模块私有状态（topicAttempts/topicInFlight/topicAbortControllers）经源尾注入 __b3hooks 观测。
//   中断/删除边沿（killProcess/markSessionDeleted，sdk-backend）依赖 electron 全量连接面，按
//   同批 B2 卷先例（tdd-treekill-symmetry-probe-order-verify B2-04）以结构钉钉接线、行为面由
//   导出的取消收口函数直接驱动——两边沿与行为面调用的是同一函数（S1 钉其同一性）。
//
// RED 预期（未改树）：B3-01/02/03c/05/06、INV、S1、S2 FAIL（signal 通道/cancel 导出/两边沿接线
// 全缺）；B3-03a/b、B3-04 对现状本就成立（回归面——红线语义「不变」的既有守护）。
// 运行：npx tsx scripts/tdd-session-naming-inflight-cancel-verify.ts（已登记 scripts/selftest-static-list.txt 尾部）

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import * as apiUrl from '../src/main/modules/api-url';
import { IPC_CHANNELS } from '../src/shared/constants';
import * as settingsParser from '../src/shared/settings-parser';
import * as sessionModel from '../src/shared/session-model';
import * as autoSessionName from '../src/shared/auto-session-name';
import * as providerLibrary from '../src/shared/provider-library';
import * as topicCore from '../src/shared/topic-analyzer-core';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const analyzerSrc = read('src/main/modules/topic-analyzer.ts');
const sdkSrc = read('src/main/modules/sdk-backend.ts');

let pass = 0;
let fail = 0;
async function runCheck(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 300)}`);
  }
}

// ── 可控 fake https/http（模拟 Node≥16 原生 options.signal 语义） ──

/** 模拟 Node abort 错误形态（name='AbortError'，非 HttpStatusError——升档门判定关键）。 */
function abortError(): Error {
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}

class FakeReq extends EventEmitter {
  destroyed = false;
  write(): void {}
  end(): void {}
  setTimeout(_ms: number, _fn: () => void): void {}
  destroy(err?: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (err) this.emit('error', err);
  }
}

interface CapturedRequest {
  options: { signal?: AbortSignal };
  /** 手动完成响应（2xx → resolve(data)；非 2xx → HttpStatusError reject）；req 已销毁则 no-op。 */
  respond(status: number, body: string): void;
  /** 手动注入网络层错误。 */
  fail(err: Error): void;
}

type Hooks = {
  topicAttempts: Map<string, number> | null;
  topicInFlight: Set<string> | null;
  topicAbortControllers: Map<string, AbortController> | null;
  cancel: ((sessionId: string) => void) | null;
};

interface NamingModule {
  mod: {
    analyzeTopic(sessionId: string, firstMessage: string): Promise<string | null>;
    cancelSessionTopicAnalysis?(sessionId: string): void;
  };
  hooks: Hooks;
  captured: CapturedRequest[];
  writes: Array<{ id: string; patch: Record<string, unknown> }>;
  pushes: Array<{ channel: string; payload: unknown }>;
}

const HOOKS_SUFFIX = `
; if (typeof __b3hooks === 'function') __b3hooks({
  topicAttempts: (typeof topicAttempts !== 'undefined') ? topicAttempts : null,
  topicInFlight: (typeof topicInFlight !== 'undefined') ? topicInFlight : null,
  topicAbortControllers: (typeof topicAbortControllers !== 'undefined') ? topicAbortControllers : null,
  cancel: (typeof cancelSessionTopicAnalysis === 'function') ? cancelSessionTopicAnalysis : null,
});
`;

/** 整模块装载一份全新的 topic-analyzer（模块级预算/在飞/登记状态随实例隔离）。 */
function loadNamingModule(sessions: Map<string, { nameSource: string; [k: string]: unknown }>): NamingModule {
  const captured: CapturedRequest[] = [];
  const writes: NamingModule['writes'] = [];
  const pushes: NamingModule['pushes'] = [];

  function fakeRequest(options: { signal?: AbortSignal }, cb?: (res: EventEmitter) => void): FakeReq {
    const req = new FakeReq();
    const entry: CapturedRequest = {
      options,
      respond: (status, body) => {
        if (req.destroyed) return; // 已销毁请求不再有响应（对齐真实 Node destroy 语义）
        const res = new EventEmitter();
        (res as unknown as { statusCode: number }).statusCode = status;
        cb!(res);
        res.emit('data', body);
        res.emit('end');
      },
      fail: (err) => req.destroy(err),
    };
    captured.push(entry);
    const signal = options.signal;
    if (signal) {
      if (signal.aborted) {
        queueMicrotask(() => req.destroy(abortError()));
      } else {
        signal.addEventListener('abort', () => req.destroy(abortError()), { once: true });
      }
    }
    return req;
  }

  const httpsStub = { request: fakeRequest };
  const configStub = {
    getConfig: () => ({
      lastUsedProviderId: null,
      lastUsedModelId: null,
      apiKey: 'sk-test-key',
      apiBaseUrl: 'https://api.testbed.example',
      advancedJson: '',
      defaultModel: 'test-model',
    }),
    getProviderModelSources: () => [],
    DECRYPT_FAILED: '__DECRYPT_FAILED__',
  };
  const sessionRepoStub = {
    getSession: (id: string) => sessions.get(id) ?? null,
    updateSession: (id: string, patch: Record<string, unknown>) => {
      writes.push({ id, patch });
      const s = sessions.get(id);
      if (s) Object.assign(s, patch);
    },
    setFirstInputFallbackName: (_id: string, _text: string) => true,
  };
  const messageRepoStub = { getMessagesBySession: (_id: string) => [] };
  const loggerStub = { logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } };
  const pushBusStub = { pushToMainWindow: (channel: string, payload: unknown) => pushes.push({ channel, payload }) };

  const requireShim = (spec: string): unknown => {
    switch (spec) {
      case 'https':
      case 'http':
        return httpsStub;
      case './config-manager':
        return configStub;
      case '../database/repositories/session-repo':
        return sessionRepoStub;
      case '../database/repositories/message-repo':
        return messageRepoStub;
      case '../utils/logger':
        return loggerStub;
      case './api-url':
        return apiUrl;
      case '../../shared/settings-parser':
        return settingsParser;
      case '../../shared/session-model':
        return sessionModel;
      case '../../shared/auto-session-name':
        return autoSessionName;
      case '../../shared/provider-library':
        return providerLibrary;
      case './push-bus':
        return pushBusStub;
      case '../../shared/constants':
        return { IPC_CHANNELS };
      case '../../shared/topic-analyzer-core':
        return topicCore;
      default:
        throw new Error(`B3 契约卷 require 垫片未映射的模块：${spec}`);
    }
  };

  let hooks: Hooks = { topicAttempts: null, topicInFlight: null, topicAbortControllers: null, cancel: null };
  const js = ts.transpileModule(analyzerSrc + HOOKS_SUFFIX, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const factory = vm.runInNewContext(
    `(function(require, exports, module, __filename, __dirname){ ${js}\n})`,
    vm.createContext({
      setTimeout,
      clearTimeout,
      Buffer,
      console,
      URL,
      AbortController,
      __b3hooks: (h: Hooks) => { hooks = h; },
    }),
  ) as (r: unknown, e: unknown, m: { exports: unknown }, f: string, d: string) => void;
  const moduleObj: { exports: unknown } = { exports: {} };
  factory(requireShim, moduleObj.exports, moduleObj, 'topic-analyzer.ts', path.join(repoRoot, 'src/main/modules'));
  return { mod: moduleObj.exports as NamingModule['mod'], hooks, captured, writes, pushes };
}

const LONG_MSG = '这是一条超过八个字符的首条用户消息，用于触发 LLM 命名链路';
/** 2xx + 答卷验收通过（stop_reason=end_turn、非空 text、无 thinking 重复、非元语言开场）。 */
const okTopicBody = (topic: string): string =>
  JSON.stringify({ content: [{ type: 'text', text: topic }], stop_reason: 'end_turn' });

async function drain(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function namingSession(): Map<string, { nameSource: string; [k: string]: unknown }> {
  return new Map([['default', { nameSource: 'slot', name: '会话 1', providerOverride: null, modelOverride: null }]]);
}

// eslint-disable-next-line @typescript-eslint/require-await
async function main(): Promise<void> {
// ── B3 行为面 ──
console.log('=== B3 行为面（vm 整模块装载 + 可控 fake HTTP） ===');

await runCheck('B3-01 用户中断边沿取消在飞命名 HTTP（信号触发 + abort 不删键 + finally 落键）', async () => {
  const t = loadNamingModule(namingSession());
  const sid = 'default';
  const p = t.mod.analyzeTopic(sid, LONG_MSG);
  assert.equal(t.captured.length, 1, 'HTTP 未在飞（夹具失效）');
  const sig = t.captured[0].options.signal;
  assert.ok(sig, 'abort 信号未传入 lib.request（B3 实现缺失）');
  assert.equal(sig!.aborted, false, '未取消前信号不应已触发');
  t.mod.cancelSessionTopicAnalysis!(sid);
  assert.equal(sig!.aborted, true, '用户中断边沿后 abort 信号未触发');
  assert.ok(t.hooks.topicAbortControllers, 'topicAbortControllers 登记缺失（B3 实现缺失）');
  assert.ok(t.hooks.topicAbortControllers!.has(sid), 'abort 即删 Map 键（键删除统一由 finally，防竞态双删）');
  const r = await p;
  assert.equal(r, null, '被取消的命名应走失败路径 return null');
  assert.ok(!t.hooks.topicAbortControllers!.has(sid), 'finally 未删除登记（登记泄漏）');
  assert.ok(!t.hooks.topicInFlight!.has(sid), 'finally 未清在飞标记');
  assert.equal(t.writes.length, 0, '取消路径不得写库');
});

await runCheck('B3-02 会话删除边沿取消在飞命名 HTTP（取消后手动 resolve 也不写库）', async () => {
  const t = loadNamingModule(namingSession());
  const sid = 'default';
  const p = t.mod.analyzeTopic(sid, LONG_MSG);
  assert.equal(t.captured.length, 1, 'HTTP 未在飞（夹具失效）');
  const sig = t.captured[0].options.signal;
  assert.ok(sig, 'abort 信号未传入 lib.request（B3 实现缺失）');
  t.mod.cancelSessionTopicAnalysis!(sid); // markSessionDeleted 边沿内的同一调用（接线由 B3-S1 钉）
  assert.equal(sig!.aborted, true, '会话删除边沿后 abort 信号未触发');
  t.captured[0].respond(200, okTopicBody('幽灵写入标题')); // 删除后响应才到
  const r = await p;
  assert.equal(r, null, '删除边沿取消后迟到 resolve 不得产出名字');
  assert.equal(t.writes.length, 0, '对已删会话的幽灵写库');
  assert.equal(t.pushes.length, 0, '无渲染层名字更新事件');
});

await runCheck('B3-03a 失败 null 不写库（3 连败每次无 updateSession 写、返回 null）', async () => {
  const t = loadNamingModule(namingSession());
  const sid = 'default';
  for (let i = 1; i <= 3; i++) {
    const p = t.mod.analyzeTopic(sid, LONG_MSG);
    t.captured[i - 1].respond(500, 'boom');
    const r = await p;
    assert.equal(r, null, `第 ${i} 次失败应返回 null`);
    assert.equal(t.writes.length, 0, `第 ${i} 次失败后出现写库（P6-乙 红线）`);
  }
  assert.equal(t.captured.length, 3, '失败路径不得触发升档续请求（5xx 不重试）');
});

await runCheck('B3-03b 第 4 次调度被预算闸拒绝（HTTP 调用数停在第 3 次）', async () => {
  const t = loadNamingModule(namingSession());
  const sid = 'default';
  for (let i = 1; i <= 3; i++) {
    const p = t.mod.analyzeTopic(sid, LONG_MSG);
    t.captured[i - 1].respond(500, 'boom');
    await p;
  }
  const before = t.captured.length;
  const r4 = await t.mod.analyzeTopic(sid, LONG_MSG);
  assert.equal(r4, null, '预算耗尽应返回 null');
  assert.equal(t.captured.length, before, '第 4 次调度仍发起 HTTP（预算闸失效）');
});

await runCheck('B3-03c 在飞取消后重新触发仍可满额调度（取消不额外消耗预算）', async () => {
  const t = loadNamingModule(namingSession());
  const sid = 'default';
  const p1 = t.mod.analyzeTopic(sid, LONG_MSG);
  assert.equal(t.captured.length, 1);
  t.mod.cancelSessionTopicAnalysis!(sid);
  await p1;
  assert.ok(t.hooks.topicAttempts, 'topicAttempts 观测缺失');
  assert.equal(t.hooks.topicAttempts!.get(sid), 1, '被取消的那次应恰计 1 次（入口计数，取消不加不减）');
  const p2 = t.mod.analyzeTopic(sid, LONG_MSG);
  assert.equal(t.captured.length, 2, '取消后重新触发被预算闸拒绝（取消误耗预算）');
  t.captured[1].respond(200, okTopicBody('重试成功标题'));
  const r2 = await p2;
  assert.equal(r2, '重试成功标题', '取消后重新命名应能成功写库');
  assert.equal(t.writes.length, 1, '成功命名应写库一次');
});

await runCheck('B3-04 30s deadline 结构钉（无注入面 → 结构钉单独成立，头注申报）', () => {
  assert.match(analyzerSrc, /const TOPIC_TOTAL_DEADLINE_MS = 30 \* 1000;/, '30s deadline 常量缺失/被改值');
  assert.match(analyzerSrc, /setTimeout\(\(\) => deadlineReject\(new Error\(`Topic analysis overall deadline \(\$\{TOPIC_TOTAL_DEADLINE_MS\}ms\)`\)\), TOPIC_TOTAL_DEADLINE_MS\)/, 'deadline 竞速计时器接线缺失/被改形');
  assert.match(analyzerSrc, /Promise\.race\(\[makeHttpRequest/, 'HTTP 与 deadline 竞速缺失');
});

await runCheck('B3-05 取消落在命名完成后：幂等无副作用', async () => {
  const t = loadNamingModule(namingSession());
  const sid = 'default';
  const p = t.mod.analyzeTopic(sid, LONG_MSG);
  t.captured[0].respond(200, okTopicBody('已落定标题'));
  const r = await p;
  assert.equal(r, '已落定标题');
  assert.equal(t.writes.length, 1, '成功命名应写库一次');
  assert.equal(t.mod.cancelSessionTopicAnalysis!(sid), undefined, '完成后取消不得抛错');
  assert.equal(t.writes.length, 1, '已写库的名字被回滚');
  assert.equal(t.captured.length, 1, '完成后取消触发第二次 HTTP');
  assert.ok(!t.hooks.topicAbortControllers!.has(sid), '完成后登记应已随 finally 清除');
});

await runCheck('B3-06 abort 后响应才 resolve：不写库不占预算（并发）', async () => {
  const t = loadNamingModule(namingSession());
  const sid = 'default';
  const p = t.mod.analyzeTopic(sid, LONG_MSG);
  const sig = t.captured[0].options.signal;
  assert.ok(sig, 'abort 信号未传入 lib.request（B3 实现缺失）');
  t.mod.cancelSessionTopicAnalysis!(sid);
  assert.equal(sig!.aborted, true);
  t.captured[0].respond(200, okTopicBody('竞态迟到标题')); // 取消后响应才到
  const r = await p;
  assert.equal(r, null, 'abort 后迟到 resolve 不得产出名字');
  assert.equal(t.writes.length, 0, '竞态窗口内写库（取消闩失效）');
  assert.equal(t.pushes.length, 0, '竞态窗口内渲染层名字更新事件');
  assert.equal(t.hooks.topicAttempts!.get(sid), 1, '迟到 resolve 不得再扣预算');
  // 预算未被竞态额外消耗：此后仍可调度至满额 3 次
  for (let i = 2; i <= 3; i++) {
    const pi = t.mod.analyzeTopic(sid, LONG_MSG);
    assert.equal(t.captured.length, i, `第 ${i} 次调度被拒（竞态误耗预算）`);
    t.captured[i - 1].respond(500, 'boom');
    await pi;
  }
  const p4 = await t.mod.analyzeTopic(sid, LONG_MSG);
  assert.equal(p4, null);
  assert.equal(t.captured.length, 3, '第 4 次调度未被预算闸拒绝');
});

await runCheck('INV 4xx 升档梯不变：升档第二次调用携带同一 signal；AbortError 不触发升档续请求', async () => {
  // 升档梯（validation reject → 第二梯）：同一 controller.signal 透传（01 §B3-2 不变量 4）。
  const t = loadNamingModule(namingSession());
  const sid = 'default';
  const p = t.mod.analyzeTopic(sid, LONG_MSG);
  assert.equal(t.captured.length, 1);
  const sig1 = t.captured[0].options.signal;
  assert.ok(sig1, 'abort 信号未传入 lib.request（B3 实现缺失）');
  t.captured[0].respond(200, JSON.stringify({ content: [{ type: 'text', text: '标题' }], stop_reason: 'max_tokens' }));
  await drain();
  assert.equal(t.captured.length, 2, '答卷被拒未升档（升档梯被改坏）');
  assert.equal(t.captured[1].options.signal, sig1, '升档第二次调用未携带同一 signal');
  t.captured[1].respond(200, okTopicBody('升档成功标题'));
  const r = await p;
  assert.equal(r, '升档成功标题');
  // AbortError 非 HttpStatusError → 不得走 4xx 升档分支（取消不引发额外 HTTP）。
  const t2 = loadNamingModule(namingSession());
  const p2 = t2.mod.analyzeTopic('default', LONG_MSG);
  assert.equal(t2.captured.length, 1);
  t2.mod.cancelSessionTopicAnalysis!('default');
  await p2;
  assert.equal(t2.captured.length, 1, 'AbortError 触发了升档续请求（取消误耗预算）');
});

// ── B3 结构钉 ──
console.log('=== B3 结构钉（S1 两边沿接线 / S2 写库前取消闩） ===');

await runCheck('B3-S1 两边沿接线：killProcess(user) 与 markSessionDeleted 均触达取消收口；恰两条边沿；cancel 不删登记', () => {
  const kpStart = sdkSrc.indexOf('export function killProcess(');
  assert.ok(kpStart > -1, '未找到 killProcess');
  const kpBody = sdkSrc.slice(kpStart, sdkSrc.indexOf('\nexport ', kpStart));
  const mdStart = sdkSrc.indexOf('export function markSessionDeleted(');
  assert.ok(mdStart > -1, '未找到 markSessionDeleted');
  const mdBody = sdkSrc.slice(mdStart, sdkSrc.indexOf('\nexport ', mdStart));
  const userBranchStart = kpBody.indexOf("if (reason === 'user') {");
  assert.ok(userBranchStart > -1, 'killProcess 缺 user 分支');
  const userBranch = kpBody.slice(userBranchStart, userBranchStart + 900);
  assert.match(userBranch, /cancelSessionTopicAnalysis\(sessionId\);/, 'killProcess user 分支未挂命名取消（边沿 1 缺）');
  assert.ok(mdBody.includes('cancelSessionTopicAnalysis(sessionId);'), 'markSessionDeleted 未挂命名取消（边沿 2 缺）');
  // 恰两条边沿（watchdog 等系统理由不扩——有意收窄，01 §B3-3 影响面表）。
  const callCount = (sdkSrc.match(/cancelSessionTopicAnalysis\(sessionId\);/g) || []).length;
  assert.equal(callCount, 2, `边沿调用点应恰 2 处（killProcess user + markSessionDeleted），实际 ${callCount}`);
  // cancel 本体：取 controller → abort，未在飞 no-op，不删 Map 键（键删除统一由 finally）。
  const cancelIdx = analyzerSrc.indexOf('export function cancelSessionTopicAnalysis');
  assert.ok(cancelIdx > -1, '缺 cancelSessionTopicAnalysis 导出');
  const cancelBody = analyzerSrc.slice(cancelIdx, analyzerSrc.indexOf('\n}', cancelIdx));
  assert.match(cancelBody, /topicAbortControllers\.get\(sessionId\)/, 'cancel 未取登记');
  assert.match(cancelBody, /\.abort\(\)/, 'cancel 未 abort');
  assert.ok(!cancelBody.includes('.delete('), 'cancel 内删除 Map 键（与 finally 竞态双删歧义，01 §B3-4 禁止）');
});

await runCheck('B3-S2 写库前取消闩：signal 透传 HTTP 调用点 + 升档门不含 AbortError + 写库 isAutoNameSlot 重查 + finally 落键', () => {
  assert.match(analyzerSrc, /makeHttpRequest\(url, requestBody, headers, 10000, controller\.signal\)/, 'signal 未透传进 LLM HTTP 调用点');
  assert.match(analyzerSrc, /const topicAbortControllers = new Map<string, AbortController>\(\);/, '缺每会话 AbortController 登记');
  const atIdx = analyzerSrc.indexOf('export async function analyzeTopic');
  const atBody = analyzerSrc.slice(atIdx, analyzerSrc.indexOf('\n}', atIdx));
  assert.match(atBody, /topicInFlight\.add\(sessionId\)/, '在飞互斥标记缺失');
  assert.match(atBody, /topicAbortControllers\.set\(sessionId, controller\)/, '入口未登记 controller（在飞互斥之后）');
  assert.match(atBody, /topicAbortControllers\.delete\(sessionId\)/, 'finally 未删除登记');
  // 升档门：AbortError（非 HttpStatusError 实例）不匹配 → 落入 warn+break → return null（写库点不可达）。
  assert.match(analyzerSrc, /error instanceof HttpStatusError && error\.status >= 400 && error\.status < 500/, '4xx 升档门缺失/被放宽（AbortError 将误入升档续请求）');
  assert.match(analyzerSrc, /logger\.warn\(`Topic analysis failed, keeping auto-name slot \(no fallback write\)[\s\S]{0,220}break;/, '非 4xx 错误（含 AbortError）未走 warn+break 终止');
  // 写库点保留 isAutoNameSlot 重查（resolve 竞态获胜态的一致性兜底，01 §B3-4 边界表）。
  //（if 块与写库行之间的注释行不参与形态判定。）
  assert.match(analyzerSrc, /if \(isAutoNameSlot\(sessionId\)\) \{\s*(?:\/\/[^\n]*\n\s*)*sessionRepo\.updateSession\(sessionId, \{ name: verdict\.topic/, 'LLM 写库点缺 isAutoNameSlot 重查');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
}

void main();
