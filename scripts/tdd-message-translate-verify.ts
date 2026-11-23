// scripts/tdd-message-translate-verify.ts
// P5 翻译主进程行为组契约卷（2026-11-19 UI 五点批次 · 第三轮 R6 引擎层置换后的引擎形态；
// 规格 = 01-实现细节.md §5.1/§5.2（含 §5.2.1 引擎组/§5.2.4 探测/§5.2.7 seam 新契约）/§5.5/§5.7、
// 03-实施计划.md 裁决 R3/R5/R6；02-测试用例清单 P5-T2/T3/T4/T5/T6/T7/T11/T12/T13/T16/T19/T20/
// T23 + 引擎组 T24~T35 的 node 形态）。
//
// 用例映射（check 计数，失败 exit 1）：
//   T2  三处同步（既有 5 通道现状钉）+ 探测通道预留断言（probeEngines 导出存在性承载——
//       TRANSLATE_PROBE 通道字面断言留 p5b wiring 点，本点拆分已申报）
//   T3  引擎隔离：聊天 LLM 材料（x-api-key/Bearer/buildAnthropicApiUrl/resolveSessionModel/
//       session-repo）零残留（源码级）+ 差分（聊天配置在/不在，翻译行为一致）+ 聊天端点零请求
//   T4  缓存：同一输入重复打开，上游请求次数 = 1
//   T5  流式增量：只译定稿段 / 幂等 START 续译 / 迁移补齐完整
//   T6  abort：stub 挂起时 STOP → signal aborted + 无重发
//   T7  全组耗尽口径：全部引擎失败 → error 态；重试 = 重新走组（首位起）；尝试数 = N+1 无放大
//   T11 目标语言：内置引擎 target 参数 zh 语义字面（源码级；原「模板 {target} 实参 zh 线上验证」
//       半边随 T31 删除——RB-MT 留痕见下）
//   T12 空正文零请求
//   T13 内联 spawn 既有契约回归钉（见 T13 声明段）
//   T16 按需门：正文翻译时思考零请求、载荷不含思考文本
//   T19 思考缓存（与正文共用会话级段缓存）
//   T20 显示切换 ≠ 中止（abort 观测 = 0）
//   T23 超长思考/正文共用同一上限（拒绝形态一致、拒绝零请求）
//   T24 零配置开箱：CLAUDE_LINK_TEST_USERDATA 临时目录 + 出厂种子直接可译 + 首位 = bing-web
//   T25 降级链：bing 败→alibaba 成；bing/alibaba/qq/sogou 败→youdao 成；尝试序严格沿优先序；
//       失败引擎恰 1 次尝试；429 冷却表翻译与探测共享（探测 bing 429 → 翻译跳过 bing）
//   T26 代理缺失无感降级：bing 网络不可达形态 → alibaba 接管、错误态零呈现、bing 尝试确实发生
//   W2a alibaba-web stub 契约组（2026-11-22 扩容批次 p2）：W2a-1 零配置探测 5 行且
//       alibaba-web 行绿（出厂种子成员面）/ W2a-2 bing 失败 → alibaba-web 接管（组语义零
//       变化、新成员面）。注：seam stub 先于 kind 分发（transportOverride 短路），W2a-2 经
//       seam 对任意 kind 同形——本组钉「新成员经组语义流转」，真实适配器协议面在 E1 卷
//       （纯函数固定向量）与已落 E1 卷的 loopback 行为组（round-002 收口）；W2a-1/T24 数据级面 red-first。
//   W2b qq-transmart stub 契约组（2026-11-22 扩容批次 p3）：W2b-1 零配置探测 6 行且
//       qq-transmart 行绿（出厂种子成员面、id=seed-qq-transmart）/ W2b-2 alibaba 失败 →
//       qq-transmart 接管（EX-P2A-3 组语义面：组降级新引擎接管）。同 W2a 口径：seam stub
//       先于 kind 分发，对任意 kind 同形——真实适配器协议面在 E1 卷（qq 纯函数固定向量组）
//       与已落 E1 卷的 loopback 行为组（EX-P2B-1/8/9/10，round-002 收口）；W2b-1 数据级面 red-first。
//       种子随动（p3）：T24 种子 5→6、T7-1 尝试序补 qq-transmart（零配置用例走出厂种子）、
//       W2a-1 行数 5→6。
//   W2c sogou-web stub 契约组（2026-11-22 扩容批次 p4）：W2c-1 零配置探测 7 行且
//       sogou-web 行绿（出厂种子成员面、id=seed-sogou-web）/ W2c-2 qq-transmart 失败 →
//       sogou-web 接管（组语义面续链）。同 W2a/W2b 口径：seam stub 先于 kind 分发，对任意
//       kind 同形——真实适配器协议面在 E1 卷（sogou 纯函数固定向量组，EX-P2C-2/3/4/5/6）
//       与已落 E1 卷的 loopback 行为组（EX-P2C-1/7/8/9，round-002 收口）；W2c-1 数据级面 red-first。
//       种子随动（p4）：T24 种子 6→7、T7-1 尝试序补 sogou-web（零配置用例走出厂种子）、
//       W2a-1/W2b-1 行数 6→7。
//   W2d youdao-web V2 重写（2026-11-22 扩容批次 p5）：kind/id/种子零变化（kind 保留、适配器
//       整函数重写为 V2 协议——00 计划 W2d 契约钉）→ 本卷 stub 契约组零断言随动（seam stub
//       kind-blind，适配器协议面对 stub 不可见；44 用例基线绿跑留证）。T11 'zh-CHS' 目标字面
//       随 V2 装配函数续存；T2-4 'translate_o' 禁入面随 V1 删除收紧（engines 源零命中）；
//       V1 零残留结构钉落 E1 卷 EX-P2D-13；RB-MT re-base 行（E3）归后续清理点。
//   RB-MT-SEED 全卷 re-base（2026-11-22 扩容批次 p7/W4，出卷清单 §7.4）：出厂种子终态重排为五种子
//       序 bing-web(0)/alibaba-web(1)/qq-transmart(2)/sogou-web(3)/youdao-web(4)（google-gtx/baidu-web
//       死引擎剔除，P3-4 直书五元序）——SEED_IDS/种子夹具/降级链/链终点/重试首位/冷却载体/
//       网络失败不预跳过/零配置首位/T28 混合 stub/T29 apply 期望序全部按新五序重出；
//       T32（google endpoint loopback）删除留痕（见上）；组语义（降级/冷却/粘性/段缓存/并发）
//       零变化——仅成员集与序变。
//   RB-MT-T7 计数式文案（2026-11-22 扩容批次 p8，评审 P2-1 并入）：T7-1 终态断言升级「全部引擎
//       不可用（N/M 引擎失败，首错：…）」5/5 子形态 + 新增 T7-1b 部分启用 3 引擎全败 3/3 子形态
//       （同一断言面两子形态；渲染层 entry.error 消费面为透传展示，无字面耦合断言随动）。
//   T27 代码块零送翻：围栏段零请求 + 译文 = 原文 + 进度不悬挂
//   T28 探测结果表：probeEngines(false) 混合 stub → 逐引擎 ok/latencyMs/error 对应；
//       未启用零请求；载荷 = TRANSLATION_PROBE_TEXT
//   T29 探测 apply 落盘：ok 引擎按 latency 升序重写 order（saveConfig 链）、失败殿后不禁用、
//       appliedOrder 返回、重载配置后新序保持（新 START 尝试序首位 = 重排首位）
//   T30 探测零翻译副作用：不写段缓存、消息翻译态零变化、同输入请求次数口径不被污染
//   RB-MT-T31/T33 删除留痕（2026-11-22 扩容批次 p6/W5——出卷清单 §6 RB 行）：原 T31（模板引擎
//       loopback：GET 三占位实例化 URL + responsePath 取值 + POST bodyTemplate 实例化）与
//       T33（tencent 凭据缺省半边：引擎不可用不阻塞组 + 探测报「未配置凭据」零请求）删除——
//       前提整链移除（W5：custom-template 适配器/字段 + tencent-tmt 引擎/凭据链已删，两个
//       kind 均不在白名单，前提不复存在）；不留替身断言（删净面由 E1 卷 EX-P6-1..4 结构钉承载）。
//   T32 （删除留痕，2026-11-22 扩容批次 p7/W4 re-base）：原 T32「google-gtx endpoint 换 loopback
//       （POST q 走 body、gtx 形态解析）」整块删除——google-gtx 引擎已随 W4 用户裁决（「谷歌先剔除
//       掉」）整链剔除（适配器/kind/端点常量/种子全删），载体死亡、前提不复存在；不留替身断言。
//   T34 代理尊重（loopback + env 注入单测形态，禁真连外网）：HTTPS_PROXY 优先序差分切换、
//       useProxy=false 不走代理、env 缺失回落 resolveProxy、CONNECT 隧道握手 A/B 差分捕获
//   T35 并发竞态：分引擎分段差异化 stub（G 对段1/3失败段2成功）→ 每段独立降级、段间零串扰、
//       同段同引擎恰 1 次尝试
//   INV 全组禁用拒绝（零 HTTP）/ clearSessionTranslations 三表清理 + abort / 并发 START 幂等 /
//       推送字面收口 + 连接面声明 + seam/env 钩子形态钉
//
// stub 纪律（硬约束）：一切引擎尝试经 transport seam（R3 裁决 __setTranslationTransportForTest，
// 契约 = §5.2.7 引擎尝试形态 {engineKind, segment, signal} → {ok,text}|{ok,error}）注入；
// T34 的端点用 loopback 127.0.0.1 本地 stub/代理（真实传输路径，零外网出站；T32 已随 p7/W4
// google-gtx 剔除删除——见卷头 RB-MT-T32 删除留痕）。
// 默认 transport（真实 HTTP）在 seam 注入后不可达。
//
// 驱动手法（沿第二轮申报形态）：translation-service 与 translation-engines 依赖 electron 连接面，
// npx tsx 直 import 不可行 → TS→CJS 转译整模块入 vm，require 垫片把 config-manager/logger/
// push-bus/electron 替为手写 stub（push-bus 捕获推送帧；electron 提供 resolveProxy fake），
// node:crypto/node:http/node:https 与 shared/translation-core 走真实模块。模块私有三表
// （translations/bySession/segmentCache）经源尾注入 __p5hooks 观测。每例独立装载一份全新模块
// （模块级三表 + 引擎 token 缓存 + 冷却表隔离）。vm context 注入 fake process（env 可控——
// T34 代理 env 注入 / env stub 钩子 per-instance 开关）。
//
// T13 声明（2026-11-20 实施期事实核对，留证申报）：02 P5-T13 钉的另一脚本 tdd-c-chat-stream-verify.ts
// 基线即「53 通过 / 35 失败」（其结构钉面向从未落地的 UI 形态：.msg 外置标签行 / ai-card /
// msg-enter 进场动画——git 历史零命中；未登记 selftest-static-list.txt）。本轮开工首查复核：
// 基线红与第二轮申报一致（exit 1），属批次外陈旧死红，不在本点文件圈内（无权修复）。处置：
// spawn 钉 = tdd-user-bubble-plaintext-verify.ts exit 0（基线 13 过/0 败）+ c-chat-stream 以
// 「通过数 ≥ 53 基线」作不回退观测钉（不钉 exit 0），基线证据交主会话裁决修复或换钉。
//
// RED 留证：对第二轮 LLM 形态工作树首跑（translation-engines.ts 不存在、seam 契约仍为
// {url,body,headers,onDelta} SSE 形态、probeEngines 未导出）→ 装载失败或断言失败，exit ≠ 0。
// 运行：npx tsx scripts/tdd-message-translate-verify.ts（登记 scripts/selftest-static-list.txt 尾部）

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import * as http from 'node:http';
import type { Socket } from 'node:net';
import * as translationCore from '../src/shared/translation-core';
import { IPC_CHANNELS } from '../src/shared/constants';
import type {
  TranslationStartResult,
  TranslationStateView,
  TranslationTarget,
} from '../src/shared/translation-core';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const serviceSrc = read('src/main/modules/translation-service.ts');
const enginesSrc = read('src/main/modules/translation-engines.ts');
const ipcConst = read('src/shared/types/ipc.ts');
const preloadApi = read('src/preload/api.ts');
const webBridge = read('src/renderer/web/web-bridge.ts');
const handlersSrc = read('src/main/ipc-handlers.ts');
const configManagerSrc = read('src/main/modules/config-manager.ts');

// T24 结构卫生：CLAUDE_LINK_TEST_USERDATA 指向一次性临时目录（先例 tdd-bugfix-opt2 等同款）。
process.env.CLAUDE_LINK_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-p5a-ud-'));

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

// ── R3 seam（§5.2.7 引擎尝试契约）：可控 transport ──

type AttemptResult = { ok: true; text: string } | { ok: false; error: string };

interface EngineCall {
  engineKind: string;
  segment: string;
  signal: AbortSignal;
  /** 手动成功（整段译文）。 */
  respond(text: string): void;
  /** 手动失败（{ok:false} 形态——引擎组按降级处理）。 */
  fail(error: string): void;
}

type Transport = (req: { engineKind: string; segment: string; signal: AbortSignal }) => Promise<AttemptResult>;

interface TransportCtl {
  calls: EngineCall[];
  /** 手动模式：调用挂起，等待用例 respond/fail。 */
  transport: Transport;
}

/** 手动 transport：每次调用即挂起（deferred），覆盖挂起/abort 观测形态。 */
function makeManualTransport(): TransportCtl {
  const calls: EngineCall[] = [];
  const transport: Transport = (req) =>
    new Promise<AttemptResult>((resolve) => {
      calls.push({
        engineKind: req.engineKind,
        segment: req.segment,
        signal: req.signal,
        respond: (text) => resolve({ ok: true, text }),
        fail: (error) => resolve({ ok: false, error }),
      });
    });
  return { calls, transport };
}

/**
 * 自动 transport：responder(kind, segment) 决定应答——string = 成功译文；
 * {ok:false, error} = 失败形态；undefined = 挂起（回落手动观测）。可选 delayMs 控制应答延迟
 * （T29 探测 latency 差分）。
 */
function makeAutoTransport(
  responder?: (kind: string, segment: string, call: EngineCall) => string | { ok: false; error: string } | undefined,
  delayMs = 0,
): TransportCtl {
  const calls: EngineCall[] = [];
  const transport: Transport = (req) =>
    new Promise<AttemptResult>((resolve) => {
      const call: EngineCall = {
        engineKind: req.engineKind,
        segment: req.segment,
        signal: req.signal,
        respond: (text) => resolve({ ok: true, text }),
        fail: (error) => resolve({ ok: false, error }),
      };
      calls.push(call);
      const scripted = responder ? responder(req.engineKind, req.segment, call) : `【译】${req.segment}`;
      const settle = (): void => {
        if (typeof scripted === 'string') call.respond(scripted);
        else if (scripted) call.fail(scripted.error);
        // undefined → 保持挂起（手动）
      };
      if (delayMs > 0) setTimeout(settle, delayMs);
      else settle();
    });
  return { calls, transport };
}

// ── vm 整模块装载（engines + service 各自全新实例，模块级状态隔离） ──

interface ConfigStub {
  // 聊天老字段（T3 隔离差分的对照面——翻译实现不得读它们）
  apiKey: string;
  apiBaseUrl: string;
  // 引擎配置节（undefined = 不注入 → service 走出厂种子 DEFAULT_TRANSLATION_ENGINES）
  translation?: unknown;
}

interface EnginesExports {
  createWebMtEngineGroup: unknown;
  __setTranslationEnginesTransportForTest(t: Transport | null): void;
  resolveOutboundProxy(useProxy: boolean, explicitProxyUrl?: string | null): Promise<{ href: string } | null>;
  establishConnectTunnel(proxyHref: string, targetHost: string, targetPort: number, timeoutMs: number): Promise<{ destroy(): void; writable: boolean }>;
  createTunnelAgent(proxyHref: string): { proxyHref: string };
}

interface ServiceExports {
  startTranslation(sessionId: string, target: TranslationTarget, sourceText: string): Promise<TranslationStartResult>;
  stopTranslation(translationId: string): boolean;
  retryTranslation(translationId: string): boolean;
  getTranslationStates(sessionId: string): TranslationStateView[];
  clearSessionTranslations(sessionId: string): void;
  probeEngines(apply: boolean): Promise<{ ok: true; engines: Array<{ id: string; kind: string; ok: boolean; latencyMs: number; error?: string }>; appliedOrder?: string[] }>;
  __setTranslationTransportForTest(transport: Transport | null): void;
}

interface LoadedService {
  mod: ServiceExports;
  enginesMod: EnginesExports;
  fakeEnv: Record<string, string | undefined>;
  hooks: {
    translations: Map<string, { id: string; sessionId: string; status: string }> | null;
    bySession: Map<string, Set<string>> | null;
    segmentCache: Map<string, Map<string, string>> | null;
  };
  calls: EngineCall[];
  pushes: Array<{ channel: string; payload: { kind: string; translationId: string; sessionId: string; segmentIndex?: number; text?: string; translatedSegments?: number; totalSegments?: number; error?: string } }>;
  config: ConfigStub;
  saveCalls: Array<Record<string, unknown>>;
}

const HOOKS_SUFFIX = `
; if (typeof __p5hooks === 'function') __p5hooks({
  translations: (typeof translations !== 'undefined') ? translations : null,
  bySession: (typeof bySession !== 'undefined') ? bySession : null,
  segmentCache: (typeof segmentCache !== 'undefined') ? segmentCache : null,
});
`;

function transpile(src: string): string {
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
}

function runInVm(js: string, extraGlobals: Record<string, unknown>, requireShim: (spec: string) => unknown): Record<string, unknown> {
  const moduleObj: { exports: unknown } = { exports: {} };
  const factory = vm.runInNewContext(
    `(function(require, exports, module, __filename, __dirname){ ${js}\n})`,
    vm.createContext({
      // 只注入宿主侧需要跨 realm 一致的实现（Promise/Date/Error 等内建走 vm 内建，
      // 避免 instanceof/原型链跨 realm 失配——第二轮脚本同款口径）；Buffer/URL/AbortController
      // 供 shared 纯函数与 signal 跨 realm 复用；process 为 fake（env 可控）。
      setTimeout,
      clearTimeout,
      Buffer,
      console,
      URL,
      URLSearchParams,
      AbortController,
      ...extraGlobals,
    }),
  ) as (r: unknown, e: unknown, m: { exports: unknown }, f: string, d: string) => void;
  factory(requireShim, moduleObj.exports, moduleObj, 'm.ts', path.join(repoRoot, 'src/main/modules'));
  return moduleObj.exports as Record<string, unknown>;
}

/** 装载一份全新 translation-engines + translation-service（stub 依赖 + 真实 shared）。 */
function loadService(opts: {
  config?: Partial<ConfigStub>;
  fakeEnv?: Record<string, string | undefined>;
  electronProxyAnswer?: string;
  /** false = 不注入 seam stub（T32 真实传输路径打 loopback）；默认 true。 */
  stubTransport?: boolean;
  /** 预建的手动 transport（T6 挂起观测）；默认新建。 */
  manual?: TransportCtl;
} = {}): LoadedService {
  const config: ConfigStub = {
    apiKey: '',
    apiBaseUrl: '',
    ...opts.config,
  };
  const fakeEnv: Record<string, string | undefined> = { ...opts.fakeEnv };
  const fakeProcess = {
    env: fakeEnv,
    getBuiltinModule: (name: string) => require(name),
  };
  const fakeElectron = {
    session: {
      defaultSession: {
        resolveProxy: async () => opts.electronProxyAnswer ?? 'DIRECT',
      },
    },
  };
  const pushes: LoadedService['pushes'] = [];
  const saveCalls: Array<Record<string, unknown>> = [];
  const configStub = {
    getConfig: () => config,
    saveConfig: (partial: Record<string, unknown>) => {
      saveCalls.push(partial);
      Object.assign(config, partial as Partial<ConfigStub>);
      return config;
    },
  };
  const loggerStub = { logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } };
  const pushBusStub = {
    pushToMainWindow: (channel: string, payload: unknown) =>
      pushes.push({ channel, payload: payload as LoadedService['pushes'][number]['payload'] }),
  };

  // ── 1) 装载 translation-engines（全新实例） ──
  let hooks: LoadedService['hooks'] = { translations: null, bySession: null, segmentCache: null };
  const enginesRequire = (spec: string): unknown => {
    switch (spec) {
      case 'node:crypto':
        return require('node:crypto');
      case 'node:https':
        return require('node:https');
      case 'node:http':
        return require('node:http');
      case 'node:tls':
        // P1-A 起 engines 引入（createConnection TLS 包裹；本卷 T34-b 不经该路径，纯透传）。
        return require('node:tls');
      case 'electron':
        return fakeElectron;
      case '../utils/logger':
        return loggerStub;
      case '../../shared/translation-core':
        return translationCore;
      default:
        throw new Error(`P5 行为卷 engines require 垫片未映射的模块：${spec}`);
    }
  };
  const enginesMod = runInVm(
    transpile(enginesSrc),
    { process: fakeProcess },
    enginesRequire,
  ) as unknown as EnginesExports;

  // ── 2) 装载 translation-service（./translation-engines → 上面那份全新实例） ──
  const serviceRequire = (spec: string): unknown => {
    switch (spec) {
      case 'node:crypto':
        return require('node:crypto');
      case './config-manager':
        return configStub;
      case '../utils/logger':
        return loggerStub;
      case './push-bus':
        return pushBusStub;
      case './translation-engines':
        return enginesMod;
      case '../../shared/constants':
        return { IPC_CHANNELS };
      case '../../shared/translation-core':
        return translationCore;
      default:
        throw new Error(`P5 行为卷 service require 垫片未映射的模块：${spec}（隔离哨兵：出现未映射 import 即装载失败）`);
    }
  };
  const mod = runInVm(
    transpile(serviceSrc + HOOKS_SUFFIX),
    {
      process: fakeProcess,
      __p5hooks: (h: LoadedService['hooks']) => {
        hooks = h;
      },
    },
    serviceRequire,
  ) as unknown as ServiceExports;

  // ── 3) R3 seam 注入（引擎尝试契约；真实 HTTP 路径自此不可达） ──
  const ctl = opts.manual ?? makeManualTransport();
  if (opts.stubTransport !== false) {
    mod.__setTranslationTransportForTest(ctl.transport);
  }
  return {
    mod,
    enginesMod,
    fakeEnv,
    hooks,
    calls: ctl.calls,
    pushes,
    config,
    saveCalls,
  };
}

async function waitFor(fn: () => boolean, timeoutMs = 4000, label = ''): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时(${timeoutMs}ms): ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function firstStatus(loaded: LoadedService, sessionId: string): string | undefined {
  return loaded.mod.getTranslationStates(sessionId)[0]?.status;
}

function kindsOf(calls: EngineCall[]): string[] {
  return calls.map((c) => c.engineKind);
}

// RB-MT-SEED（p7/W4 re-base）：终态五种子序（出厂序 bing→alibaba→qq→sogou→youdao，order 0..4）。
const SEED_IDS = ['bing-web', 'alibaba-web', 'qq-transmart', 'sogou-web', 'youdao-web'] as const;

/** 出厂种子引擎配置（id 取 kind 同名短 id，供 T25/T29 等以 kind 字面断言）。 */
function seedEngines(): Array<{ id: string; kind: string; enabled: boolean; order: number }> {
  return [
    { id: 'bing-web', kind: 'bing-web', enabled: true, order: 0 },
    { id: 'alibaba-web', kind: 'alibaba-web', enabled: true, order: 1 },
    { id: 'qq-transmart', kind: 'qq-transmart', enabled: true, order: 2 },
    { id: 'sogou-web', kind: 'sogou-web', enabled: true, order: 3 },
    { id: 'youdao-web', kind: 'youdao-web', enabled: true, order: 4 },
  ];
}

/** loopback HTTP stub 服务器（T32；不出外网）。listen 竞态防御：await listening 后返回。 */
async function makeLoopbackServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c: string) => {
      data += c;
    });
    req.on('end', () => {
      try {
        handler(req, res, data);
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * loopback CONNECT 代理（T34；握手应答 200，不建真实隧道）。
 * MOD-P1A-1 夹具升级（P1 修复批次 2026-11-21）：原「应答 200 后 20ms destroy」移除——P1-A 修复后
 * 隧道裸 socket 交付语义被 TLS 包裹取代，夹具保证握手后连接不再被代理侧定时掐断（T34-b 断言语义
 * 不变：CONNECT 目标字面捕获、socket 可写、A/B 差分；socket 生命周期随对端断开或 close 清扫）。
 */
async function makeConnectProxy(): Promise<{ port: number; connects: string[]; close(): Promise<void> }> {
  const connects: string[] = [];
  const clientSockets = new Set<Socket>();
  const server = http.createServer(() => {});
  server.on('connect', (req, clientSocket) => {
    connects.push(req.url ?? '');
    clientSockets.add(clientSocket);
    clientSocket.on('close', () => clientSockets.delete(clientSocket));
    clientSocket.on('error', () => {});
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    connects,
    close: () => {
      for (const s of clientSockets) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

async function main(): Promise<void> {
  const SID = 'sess-p5';

  // ── T2 结构组 ──
  console.log('=== T2 三处同步（既有 5 通道现状钉）+ 探测预留断言 ===');

  await runCheck('T2-1 四 invoke 通道三处同步（ipc 常量字面 + preload 成员实现 + web 表键 + handler 注册）', () => {
    const invokeChannels: Array<[string, string]> = [
      ["TRANSLATE_START: 'translate:start'", 'translateStart'],
      ["TRANSLATE_STOP: 'translate:stop'", 'translateStop'],
      ["TRANSLATE_RETRY: 'translate:retry'", 'translateRetry'],
      ["TRANSLATE_GET_STATE: 'translate:getState'", 'getTranslationStates'],
    ];
    for (const [literal, member] of invokeChannels) {
      const chName = literal.split(':')[0].trim();
      assert.ok(ipcConst.includes(literal), `IPC_CHANNELS 缺 ${literal}`);
      assert.ok(webBridge.includes(`${member}: IPC_CHANNELS.${chName}`), `WEB_CHANNEL_TABLE 缺 ${member} 表键`);
      assert.ok(handlersSrc.includes(`regInvokeHandler(IPC_CHANNELS.${chName}`), `ipc-handlers 未注册 ${chName}`);
      assert.ok(preloadApi.includes(`${member}: (`), `preload 缺 ${member} 成员实现`);
    }
  });

  await runCheck('T2-2 推送通道 TRANSLATION_EVENT 三处同步（ipc 常量 + web 双表键 + preload 双成员实现）', () => {
    assert.ok(ipcConst.includes("TRANSLATION_EVENT: 'translation:event'"), 'IPC_CHANNELS 缺 TRANSLATION_EVENT');
    assert.ok(webBridge.includes('onTranslationEvent: IPC_CHANNELS.TRANSLATION_EVENT'), 'web 表缺 onTranslationEvent 键');
    assert.ok(webBridge.includes('removeTranslationListener: IPC_CHANNELS.TRANSLATION_EVENT'), 'web 表缺 removeTranslationListener 键');
    assert.ok(preloadApi.includes('onTranslationEvent: (callback) =>'), 'preload 缺 onTranslationEvent 实现');
    assert.ok(
      preloadApi.includes('removeTranslationListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.TRANSLATION_EVENT)'),
      'preload 缺 removeTranslationListener 实现',
    );
  });

  await runCheck('T2-3 探测通道预留断言：probeEngines 导出存在（TRANSLATE_PROBE 通道字面断言留 p5b wiring 点——本点拆分申报）', () => {
    assert.ok(/export\s+(async\s+)?function\s+probeEngines/.test(serviceSrc), 'translation-service 缺 probeEngines 导出（一键探测服务面）');
    assert.ok(serviceSrc.includes('TRANSLATION_PROBE_TEXT'), 'service 未消费探测固定短文本常量');
  });

  await runCheck('T2-4 渲染层/preload 出站边界：src/renderer/** + src/preload/** 零直连引擎端点/凭据头字面', () => {
    const forbidden = ['x-api-key', 'anthropic-version', 'buildAnthropicApiUrl', "Authorization'] = `Bearer", 'translate.googleapis.com', 'ttranslatev3', 'v2transapi', 'translate_o'];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(rel);
          continue;
        }
        if (!/\.(ts|vue)$/.test(entry.name)) continue;
        const src = read(rel);
        for (const f of forbidden) {
          if (src.includes(f)) offenders.push(`${rel} 含 ${f}`);
        }
      }
    };
    walk('src/renderer');
    walk('src/preload');
    assert.deepEqual(offenders, [], '渲染层/preload 出现直连引擎端点或凭据字面');
  });

  // ── T3 引擎隔离 ──
  console.log('=== T3 引擎隔离（与聊天 LLM 链路完全隔离） ===');

  await runCheck('T3-1 源码级：service+engines 零聊天 LLM 材料残留（x-api-key/Bearer/解析链/会话仓库/端点构建）', () => {
    const forbidden = ['x-api-key', "'Bearer", 'buildAnthropicApiUrl', 'resolveSessionModel', 'getProviderModelSources', 'session-repo', "from './api-url'", 'anthropic-version'];
    for (const [name, src] of [['translation-service.ts', serviceSrc], ['translation-engines.ts', enginesSrc]] as const) {
      for (const f of forbidden) {
        assert.ok(!src.includes(f), `${name} 残留聊天 LLM 材料：${f}`);
      }
    }
  });

  await runCheck('T3-2 行为差分：聊天 provider 配置在/不在，翻译行为完全一致（引擎尝试序与译文一致、聊天端点零请求）', async () => {
    const rich = loadService({
      config: { apiKey: 'sk-chat-key', apiBaseUrl: 'https://api.chat-provider.example', translation: { engines: seedEngines() } },
      manual: makeAutoTransport((kind) => `译@${kind}`),
    });
    const bare = loadService({
      config: { translation: { engines: seedEngines() } },
      manual: makeAutoTransport((kind) => `译@${kind}`),
    });
    const src = '甲'.repeat(100);
    for (const [label, loaded] of [['rich', rich], ['bare', bare]] as const) {
      const r = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: `m3-${label}` }, src);
      assert.ok(r.ok, `${label} START 应成功：${r.ok ? '' : r.error}`);
    }
    await waitFor(() => rich.calls.length >= 1 && bare.calls.length >= 1, 4000, 'transport 未被调用');
    await waitFor(() => firstStatus(rich, SID) === 'done' && firstStatus(bare, SID) === 'done', 4000, '两实例翻译未完成');
    assert.deepEqual(kindsOf(rich.calls), kindsOf(bare.calls), '聊天配置差异改变了引擎尝试序（隔离违约）');
    assert.deepEqual(
      rich.calls.map((c) => c.segment),
      bare.calls.map((c) => c.segment),
      '聊天配置差异改变了引擎载荷',
    );
    assert.equal(kindsOf(rich.calls)[0], 'bing-web', '首位尝试引擎应为出厂序 bing-web');
    await sleep(120);
    assert.equal(rich.calls.length, bare.calls.length, '聊天配置在/不在导致请求次数漂移');
    // 聊天端点零请求：transport 只见引擎 kind，无任何 URL 级聊天端点痕迹（引擎尝试契约不含 url/headers）
    for (const c of [...rich.calls, ...bare.calls]) {
      assert.ok(SEED_IDS.includes(c.engineKind as (typeof SEED_IDS)[number]), `transport 收到非引擎请求：${c.engineKind}`);
    }
  });

  // ── T4 缓存 ──
  console.log('=== T4 缓存：同一输入重复请求 = 1 ===');

  await runCheck('T4-1 打开→完成→收起→再打开：第二次对同一输入零引擎请求（重复请求次数 = 1）', async () => {
    const ctl = makeAutoTransport();
    const loaded = loadService({ manual: ctl });
    const src = '甲'.repeat(100);
    const first = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm4' }, src);
    assert.ok(first.ok);
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, '首次翻译未完成');
    assert.equal(loaded.calls.length, 1, '首次翻译请求数 ≠ 1（夹具失效）');
    assert.equal(loaded.mod.stopTranslation(first.translationId), true, '收起应返回 true');
    const second = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm4' }, src);
    assert.ok(second.ok && first.ok && second.translationId === first.translationId, '同 target 再 START 应复用同一 entry');
    await sleep(150);
    assert.equal(loaded.calls.length, 1, '第二次打开重复发引擎请求（缓存失效，请求次数放大）');
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, '缓存命中后未直达 done');
    await sleep(150);
    const deltaFrames = loaded.pushes.filter((p) => p.channel === IPC_CHANNELS.TRANSLATION_EVENT && p.payload.kind === 'delta');
    assert.ok(deltaFrames.some((p) => p.payload.text === `【译】${src}` && p.payload.segmentIndex === 0), '推送缺段级整段译文 delta 帧（payload 形态不变）');
  });

  // ── T5 流式增量 ──
  console.log('=== T5 流式增量跟随 ===');

  await runCheck('T5-1 流式：末段不定稿不译 → 原文增长幂等 START 只译已定稿段 → 迁移 START 补齐至完整', async () => {
    const loaded = loadService();
    const p1 = '甲'.repeat(100);
    const p2 = '乙'.repeat(100);
    const streamStart = await loaded.mod.startTranslation(SID, { kind: 'stream' }, p1);
    assert.ok(streamStart.ok);
    await sleep(80);
    assert.equal(loaded.calls.length, 0, '单段未定稿即发起引擎请求（末段不定稿不译被破坏）');
    const extend = await loaded.mod.startTranslation(SID, { kind: 'stream' }, `${p1}\n\n${p2}`);
    assert.ok(extend.ok && extend.translationId === streamStart.translationId, '流式增长再 START 应复用同一 entry');
    await waitFor(() => loaded.calls.length === 1, 4000, '已定稿段未被翻译');
    assert.equal(loaded.calls[0]?.segment, p1, '引擎载荷不是已定稿段原文（全量重译形态）');
    loaded.calls[0]?.respond('译甲');
    await waitFor(() => firstStatus(loaded, SID) === 'translating', 4000, '已定稿段未完成');
    await sleep(120);
    assert.equal(loaded.calls.length, 1, '未定稿末段被提前请求（请求次数放大）');
    const migrate = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm5' }, `${p1}\n\n${p2}`);
    assert.ok(migrate.ok && migrate.translationId !== streamStart.translationId, '迁移应产生 message target 新 entry');
    await waitFor(() => loaded.calls.length === 2, 4000, '补齐段未发请求');
    assert.equal(loaded.calls[1]?.segment, p2, '补齐请求不是增量范围（全量重译形态）');
    loaded.calls[1]?.respond('译乙');
    await waitFor(() => {
      const st = loaded.mod.getTranslationStates(SID).find((s) => s.target.kind === 'message');
      return st?.status === 'done';
    }, 4000, '迁移 entry 未完成');
    const msgState = loaded.mod.getTranslationStates(SID).find((s) => s.target.kind === 'message');
    assert.equal(msgState?.totalSegments, 2);
    assert.equal(msgState?.segments.length, 2, '已译段缺席（段缓存未贯通两 target）');
    assert.equal(loaded.calls.length, 2, '流式跟随出现重复请求（请求次数放大）');
  });

  await runCheck('T5-2 单段超长硬切增量跟随：1200 块即时定稿即译，余量等流结束补齐（不重复请求）', async () => {
    const loaded = loadService();
    const full = 'x'.repeat(1300);
    const s = await loaded.mod.startTranslation(SID, { kind: 'stream' }, full);
    assert.ok(s.ok);
    await waitFor(() => loaded.calls.length === 1, 4000, '1200 硬切块未即时定稿翻译');
    assert.equal(loaded.calls[0]?.segment, 'x'.repeat(1200), '硬切块载荷不是 1200 前缀');
    loaded.calls[0]?.respond('块译');
    await sleep(120);
    assert.equal(loaded.calls.length, 1, '尾部余量被提前请求');
    const migrate = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm5b' }, full);
    assert.ok(migrate.ok);
    await waitFor(() => loaded.calls.length === 2, 4000, '余量补齐未发请求');
    assert.equal(loaded.calls[1]?.segment, 'x'.repeat(100), '补齐载荷不是增量余量');
    loaded.calls[1]?.respond('补齐译文');
    await waitFor(() => {
      const st = loaded.mod.getTranslationStates(SID).find((x) => x.target.kind === 'message');
      return st?.status === 'done';
    }, 4000, '迁移 entry 未完成');
    assert.equal(loaded.calls.length, 2, '硬切跟随出现重复请求（放大）');
  });

  // ── T6 abort ──
  console.log('=== T6 收起=中止在飞引擎尝试 ===');

  await runCheck('T6-1 stub 挂起时 STOP：transport 观测 abort signal aborted，中止后无该请求重发', async () => {
    const loaded = loadService();
    const s = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm6' }, '甲'.repeat(100));
    assert.ok(s.ok);
    await waitFor(() => loaded.calls.length === 1, 4000, '请求未在飞');
    const call = loaded.calls[0];
    assert.ok(call);
    assert.equal(call.signal.aborted, false, '未 STOP 前信号不应已触发');
    assert.equal(loaded.mod.stopTranslation(s.translationId), true, 'STOP 应返回 true');
    assert.equal(call.signal.aborted, true, 'STOP 后 transport 未观测到 abort');
    assert.equal(firstStatus(loaded, SID), 'stopped', 'entry 未进入 stopped');
    assert.ok(loaded.pushes.some((p) => p.payload.kind === 'stopped'), '推送缺 stopped 终态帧（直发不节流）');
    await sleep(150);
    assert.equal(loaded.calls.length, 1, '中止后出现该请求的重发');
    call.fail('aborted');
    await sleep(120);
    assert.equal(loaded.calls.length, 1, 'abort 排水期间出现续请求');
    assert.equal(firstStatus(loaded, SID), 'stopped');
  });

  // ── T7 全组耗尽 ──
  console.log('=== T7 全组耗尽口径（失败 = 全组耗尽；重试 = 重新走组） ===');

  await runCheck('T7-1 全部 5 引擎失败一轮 → error 态（尝试数 = N）；重试首位成功（总尝试 = N+1 无放大）——RB-MT-SEED p7/W4 re-base：终态五种子序（bing 殿前→youdao 殿后）', async () => {
    const ctl = makeAutoTransport((_kind, segment, call) => {
      void segment;
      void call;
      return { ok: false, error: '引擎不可达' };
    });
    const loaded = loadService({ manual: ctl });
    const s = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm7' }, '甲'.repeat(100));
    assert.ok(s.ok);
    await waitFor(() => firstStatus(loaded, SID) === 'error', 6000, '全组耗尽后未进入 error 态');
    assert.deepEqual(kindsOf(loaded.calls), ['bing-web', 'alibaba-web', 'qq-transmart', 'sogou-web', 'youdao-web'], '尝试序未严格沿优先序');
    assert.equal(loaded.calls.length, 5, `失败轮尝试数 ≠ 启用引擎数 N=5（放大/缺失：${loaded.calls.length}）`);
    const st = loaded.mod.getTranslationStates(SID)[0];
    // RB-MT-T7（2026-11-22 扩容批次 p8，评审 P2-1 并入）：终态文案升级计数式
    // 「全部引擎不可用（N/M 引擎失败，首错：…）」——5/5 子形态（全部启用全败）。
    assert.ok(st?.error?.includes('第 1 段翻译失败'), `错误文案前缀口径不符：${st?.error}`);
    assert.ok(
      st?.error?.includes('全部引擎不可用（5/5 引擎失败，首错：引擎不可达）'),
      `计数式终态文案不符（P2-1，应含 N/M 计数与首错摘要）：${st?.error}`,
    );
    // 重试 = 重新走组（首位起）；stub 改为 bing 成功
    ctl.calls.length = 0;
    const autoOk = makeAutoTransport();
    loaded.mod.__setTranslationTransportForTest(autoOk.transport);
    assert.equal(loaded.mod.retryTranslation(s.translationId), true, 'RETRY 应返回 true');
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, '重试后未到 done');
    assert.deepEqual(kindsOf(autoOk.calls), ['bing-web'], '重试未从优先序首位重新走组');
    assert.equal(autoOk.calls.length, 1, `总尝试数 ≠ N+1=6（放大：失败轮 5 + 重试 ${autoOk.calls.length}）`);
  });

  await runCheck('T7-1b 部分启用 3 引擎全败 → 计数式 3/3 子形态（RB-MT-T7 同一断言面两子形态之二；P2-1）', async () => {
    const ctl = makeAutoTransport(() => ({ ok: false, error: '引擎不可达' }));
    const engines = seedEngines()
      .filter((e) => ['bing-web', 'alibaba-web', 'qq-transmart'].includes(e.kind))
      .map((e, i) => ({ ...e, order: i }));
    const loaded = loadService({ manual: ctl, config: { translation: { engines } } });
    const s = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm7b' }, '甲'.repeat(100));
    assert.ok(s.ok);
    await waitFor(() => firstStatus(loaded, SID) === 'error', 6000, '3 引擎全败后未进入 error 态');
    assert.equal(loaded.calls.length, 3, `失败轮尝试数 ≠ 启用引擎数 3（实际 ${loaded.calls.length}）`);
    const st = loaded.mod.getTranslationStates(SID)[0];
    assert.ok(
      st?.error?.includes('全部引擎不可用（3/3 引擎失败，首错：引擎不可达）'),
      `部分启用计数式终态文案不符（应 3/3）：${st?.error}`,
    );
  });

  // ── T11 / T12 ──
  console.log('=== T11 目标语言 / T12 空正文 ===');

  await runCheck('T11 内置引擎 target 参数 zh 语义（各适配器目标语言字面在位；RB-MT-T31 留痕：模板 {target} 线上验证半边随 W5 p6 custom-template 整链移除删除）', () => {
    assert.ok(enginesSrc.includes("'zh-Hans'"), 'bing 适配器缺 to=zh-Hans（简中）目标字面');
    assert.ok(enginesSrc.includes("'zh-CHS'"), 'youdao 适配器缺 to=zh-CHS（简中）目标字面');
    // RB-MT-T11 随动（W5 p6）：原「Target=zh 目标字面」断言的命中面是 tencent-tmt 适配器
    // （Target: 'zh'），适配器随 W5 整链移除 → 断言删除留痕。
    // RB-MT-T11 随动（p7/W4 re-base）：google tl={target}/sl={source} 端点占位断言与 baidu
    // to=zh 字面断言删除——google-gtx/baidu-web 两死引擎整链剔除（00 计划 W4），载体消失；
    // 存活引擎四字面钉重出（alibaba/qq/sogou 随 p2/p3/p4 补齐，youdao/bing 续存）。
    assert.ok(/'tgtLang',\s*'zh'/.test(enginesSrc), 'alibaba 适配器缺 tgtLang=zh 目标字面');
    assert.ok(/target:\s*\{\s*lang:\s*'zh'\s*\}/.test(enginesSrc), 'qq 适配器缺 target.lang=zh 目标字面');
    assert.ok(/'to',\s*'zh-CHS'/.test(enginesSrc), 'sogou/youdao 适配器缺 to=zh-CHS 目标字面');
  });

  await runCheck('T12 空正文/纯空白：{ok:false,消息没有可翻译的文本}，零引擎请求', async () => {
    const loaded = loadService();
    const r1 = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm12' }, '   \n\t  ');
    assert.equal(r1.ok, false);
    assert.ok(!r1.ok && r1.error === '消息没有可翻译的文本', `拒绝文案不符：${r1.ok ? '' : r1.error}`);
    const r2 = await loaded.mod.startTranslation(SID, { kind: 'stream' }, '');
    assert.ok(!r2.ok && r2.error === '消息没有可翻译的文本');
    await sleep(120);
    assert.equal(loaded.calls.length, 0, '空正文发起了引擎请求');
  });

  // ── T13 内联 spawn 既有契约回归钉 ──
  console.log('=== T13 内联 spawn 既有消息渲染契约 ===');

  await runCheck('T13 tdd-user-bubble-plaintext-verify.ts exit 0（翻译挂入消息区不得破坏消息渲染既有契约）', () => {
    let status: number | null = null;
    let tail = '';
    for (let run = 1; run <= 3; run++) {
      const r = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/tdd-user-bubble-plaintext-verify.ts'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      status = r.status;
      tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-300).trim();
      if (status === 0) break;
    }
    assert.equal(status, 0, `退出码 ${status}\n${tail}`);
  });

  await runCheck('T13-b tdd-c-chat-stream-verify.ts 不回退观测：通过数 ≥ 基线 53（基线红申报见头注；exit 0 断言留主会话裁决）', () => {
    const r = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/tdd-c-chat-stream-verify.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const m = /结果：(\d+) 通过/.exec(out);
    const passed = m ? Number(m[1]) : -1;
    assert.ok(
      passed >= 53,
      `c-chat-stream 通过数 ${passed} < 基线 53（既有契约回退）——退出码 ${r.status}\n${out.slice(-300)}`,
    );
  });

  // ── T16 / T19 / T20 / T23（增补组） ──
  console.log('=== T16/T19/T20/T23 增补组（思考对象/显示切换/共用上限） ===');

  await runCheck('T16 按需门：仅开启正文翻译——思考内容零请求，正文载荷不含思考文本', async () => {
    const loaded = loadService();
    const msg = '甲'.repeat(100);
    const think = '乙'.repeat(100);
    const s = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm16' }, msg);
    assert.ok(s.ok);
    await waitFor(() => loaded.calls.length === 1, 4000, '正文翻译未发请求');
    loaded.calls[0]?.respond('译');
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, '正文翻译未完成');
    await sleep(120);
    assert.equal(loaded.calls.length, 1, '请求数 ≠ 1（思考被自动翻译——按需门失效/请求放大）');
    for (const c of loaded.calls) {
      assert.equal(c.segment, msg, '正文载荷混入了思考文本（两翻译对象边界被打破）');
      assert.ok(!c.segment.includes(think), '载荷含思考文本');
    }
  });

  await runCheck('T19 思考缓存：同一思考文本两次查看零重复请求（与正文共用会话级段缓存）', async () => {
    const loaded = loadService();
    const think = '乙'.repeat(100);
    const first = await loaded.mod.startTranslation(SID, { kind: 'thinking', messageId: 't19' }, think);
    assert.ok(first.ok);
    await waitFor(() => loaded.calls.length === 1, 4000, '思考首次翻译未发请求');
    loaded.calls[0]?.respond('思译');
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, '思考首次翻译未完成');
    loaded.mod.stopTranslation(first.translationId);
    const second = await loaded.mod.startTranslation(SID, { kind: 'thinking', messageId: 't19' }, think);
    assert.ok(second.ok && second.translationId === first.translationId, '同 target 再 START 应复用 entry');
    await sleep(120);
    assert.equal(loaded.calls.length, 1, '思考第二次查看重发引擎请求（思考侧缓存缺失/分家）');
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, '缓存命中后未直达 done');
  });

  await runCheck('T20 显示切换 ≠ 中止：无 STOP invoke 时在飞请求不被 abort、entry 不进 stopped、响应照常消费至 done', async () => {
    const loaded = loadService();
    const s = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm20' }, '甲'.repeat(100));
    assert.ok(s.ok);
    await waitFor(() => loaded.calls.length === 1, 4000, '请求未在飞');
    // 渲染层 toggleShowing = 纯视图操作（无 invoke）——主进程侧等价观测：什么都不发生。
    await sleep(200);
    const call = loaded.calls[0];
    assert.ok(call);
    assert.equal(call.signal.aborted, false, '显示切换路径误触发了 abort（切回原文被当中止）');
    assert.notEqual(firstStatus(loaded, SID), 'stopped', 'entry 误进入 stopped');
    call.respond('译己');
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, '在飞请求未被继续消费至 done');
    assert.equal(loaded.calls.length, 1);
  });

  await runCheck('T23 超长思考与正文共用同一上限：两 target 拒绝形态一致、拒绝零请求；正常思考照常翻译', async () => {
    const loaded = loadService();
    const overlong = 'x'.repeat(100_001);
    const rThink = await loaded.mod.startTranslation(SID, { kind: 'thinking', messageId: 't23' }, overlong);
    const rMsg = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm23' }, overlong);
    assert.ok(!rThink.ok && !rMsg.ok, '超长思考/正文应拒绝');
    assert.ok(!rThink.ok && rThink.error === '消息过长，暂不支持翻译（上限 10 万字符）');
    assert.ok(!rThink.ok && !rMsg.ok && rThink.error === rMsg.error, '两 target 拒绝形态不一致（思考另设上限）');
    assert.equal(loaded.calls.length, 0, '超长拒绝仍发起了引擎请求');
    const normal = await loaded.mod.startTranslation(SID, { kind: 'thinking', messageId: 't23b' }, '乙'.repeat(100));
    assert.ok(normal.ok, '正常长度思考被误拒');
    // 精确等待 t23b entry（firstStatus[0] 是 error 态的 t23 entry——按 messageId 定位目标 entry）
    await waitFor(() => loaded.calls.length === 1, 4000, '正常思考翻译未发请求');
    loaded.calls[0]?.respond('思译');
    await waitFor(() => {
      const st = loaded.mod
        .getTranslationStates(SID)
        .find((s) => s.target.kind === 'thinking' && (s.target as { messageId?: string }).messageId === 't23b');
      return st?.status === 'done';
    }, 4000, '正常思考翻译未完成');
  });

  // ── T24 零配置开箱 ──
  console.log('=== T24 零配置开箱可译 ===');

  await runCheck('T24 零配置：出厂种子直接可译 + 尝试序首位 = bing-web + 种子进 defaults/sanitize（数据级；RB-MT-SEED p7/W4 re-base）', async () => {
    const loaded = loadService({ config: { apiKey: '', apiBaseUrl: '' }, manual: makeAutoTransport() }); // 无 translation 键 → 出厂种子
    const src = '甲'.repeat(100);
    const r = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm24' }, src);
    assert.ok(r.ok, `零配置 START 应成功：${r.ok ? '' : r.error}`);
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, '零配置翻译未完成');
    assert.equal(kindsOf(loaded.calls)[0], 'bing-web', '零配置首位尝试引擎 ≠ bing-web（出厂优先序被改）');
    // 数据级：出厂种子五引擎在册、顺序正确（核心断言在纯函数卷 RB-CORE-T-种-1/2，此处钉 defaults/sanitize 接线；
    // 2026-11-22 扩容批次 p7/W4 re-base：种子 7→5，出厂终序 bing(0)→alibaba(1)→qq(2)→sogou(3)→youdao(4)）
    assert.equal(translationCore.DEFAULT_TRANSLATION_ENGINES.length, 5);
    assert.equal(translationCore.DEFAULT_TRANSLATION_ENGINES[0]?.kind, 'bing-web');
    assert.ok(configManagerSrc.includes('DEFAULT_TRANSLATION_ENGINES'), 'config-manager defaults 未引用出厂种子');
    assert.ok(configManagerSrc.includes('sanitizeTranslationConfig'), 'config-manager getConfig 未接 translation sanitize');
    assert.ok(process.env.CLAUDE_LINK_TEST_USERDATA && fs.existsSync(process.env.CLAUDE_LINK_TEST_USERDATA), 'CLAUDE_LINK_TEST_USERDATA 临时目录未建立');
  });

  // ── T25 降级链 ──
  console.log('=== T25 降级链 + 429 冷却共享 ===');

  await runCheck('T25-a bing 失败 → alibaba 接管：尝试序 [bing,alibaba]、失败引擎恰 1 次尝试、译文 = alibaba 产物（RB-MT-SEED p7/W4 re-base）', async () => {
    const auto = makeAutoTransport((kind) =>
      kind === 'bing-web' ? { ok: false, error: 'HTTP 503: bing down' } : `译@${kind}`,
    );
    const loaded = loadService({ config: { translation: { engines: seedEngines() } }, manual: auto });
    const s = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm25a' }, '甲'.repeat(100));
    assert.ok(s.ok);
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, '降级后未到 done');
    assert.deepEqual(kindsOf(auto.calls), ['bing-web', 'alibaba-web'], `尝试序不符：${kindsOf(auto.calls).join(',')}`);
    assert.equal(auto.calls.filter((c) => c.engineKind === 'bing-web').length, 1, '失败引擎被反复锤（恰 1 次尝试被破坏）');
    const st = loaded.mod.getTranslationStates(SID)[0];
    assert.ok(st?.segments[0]?.translated === '译@alibaba-web', `译文非降级接管引擎产物：${st?.segments[0]?.translated}`);
    assert.ok(!loaded.pushes.some((p) => p.payload.kind === 'error'), '单引擎失败不得呈现错误态（降级吸收）');
  });

  await runCheck('T25-b bing/alibaba/qq/sogou 全失败 → youdao 接管：尝试序全五 [bing,alibaba,qq,sogou,youdao]、链终点正确（RB-MT-T25-b p7/W4 re-base）', async () => {
    const auto = makeAutoTransport((kind) =>
      kind === 'youdao-web' ? '译@youdao' : { ok: false, error: '引擎失败' },
    );
    const loaded = loadService({ config: { translation: { engines: seedEngines() } }, manual: auto });
    const s = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm25b' }, '甲'.repeat(100));
    assert.ok(s.ok);
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, 'youdao 接管后未到 done');
    assert.deepEqual(kindsOf(auto.calls), ['bing-web', 'alibaba-web', 'qq-transmart', 'sogou-web', 'youdao-web'], `尝试序不符：${kindsOf(auto.calls).join(',')}`);
    const st = loaded.mod.getTranslationStates(SID)[0];
    assert.ok(st?.segments[0]?.translated === '译@youdao', '链终点译文错误');
    for (const k of SEED_IDS) {
      assert.equal(auto.calls.filter((c) => c.engineKind === k).length, 1, `引擎 ${k} 尝试次数 ≠ 1`);
    }
  });

  await runCheck('T25-c 429 冷却（翻译与探测共享表）：探测 bing 遇 429 入冷却 → 翻译跳过 bing 首位起 alibaba（RB-MT-T25-c p7/W4 载体 re-base）', async () => {
    const probeAuto = makeAutoTransport((kind, segment) =>
      kind === 'bing-web' && segment === translationCore.TRANSLATION_PROBE_TEXT
        ? { ok: false, error: '限频 429' }
        : `探@${kind}`,
    );
    const loaded = loadService({ config: { translation: { engines: seedEngines() } }, manual: probeAuto });
    const probe = await loaded.mod.probeEngines(false);
    assert.ok(probe.ok);
    const bingRow = probe.engines.find((e) => e.kind === 'bing-web');
    assert.ok(bingRow && bingRow.ok === false, '探测 bing 应红（stub 429）');
    // 翻译：bing 应被冷却跳过（共享冷却表），首位尝试 = alibaba
    const trAuto = makeAutoTransport();
    loaded.mod.__setTranslationTransportForTest(trAuto.transport);
    const s = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm25c' }, '甲'.repeat(100));
    assert.ok(s.ok);
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, '冷却期翻译未完成');
    assert.equal(trAuto.calls.filter((c) => c.engineKind === 'bing-web').length, 0, '冷却期内 bing 仍被尝试（冷却表未生效）');
    assert.equal(kindsOf(trAuto.calls)[0], 'alibaba-web', '冷却跳过后首位尝试引擎 ≠ alibaba');
  });

  // ── T26 代理缺失无感降级 ──
  console.log('=== T26 代理缺失无感降级 ===');

  await runCheck('T26 bing 网络不可达形态 → alibaba 接管、错误态零呈现、bing 尝试确实发生（非预判跳过；RB-MT-T26 p7/W4 载体 re-base）', async () => {
    const auto = makeAutoTransport((kind) =>
      kind === 'bing-web' ? { ok: false, error: 'getaddrinfo ENOTFOUND cn.bing.com' } : `译@${kind}`,
    );
    const loaded = loadService({ config: { translation: { engines: seedEngines() } }, manual: auto });
    const s = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm26' }, '甲'.repeat(100));
    assert.ok(s.ok);
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, '无代理降级后未到 done');
    assert.ok(auto.calls.some((c) => c.engineKind === 'bing-web'), 'bing 尝试未发生（实现预判跳过 = 降级链失效）');
    assert.equal(kindsOf(auto.calls)[0], 'bing-web', 'bing 居首被破坏');
    const st = loaded.mod.getTranslationStates(SID)[0];
    assert.equal(st?.status, 'done', '无感降级后不得停留错误态');
    assert.ok(!loaded.pushes.some((p) => p.payload.kind === 'error'), '无代理场景出现错误弹面（无感被破坏）');
    assert.ok(st?.segments[0]?.translated?.startsWith('译@'), 'alibaba 未接管出译文');
  });

  // ── W2a alibaba-web stub 契约组（2026-11-22 扩容批次 p2；新 kind 经组语义流转面） ──
  console.log('=== W2a alibaba-web stub 契约组（p2 扩容） ===');

  await runCheck('W2a-1 零配置 alibaba-web 在册：零配置探测 5 行且 alibaba-web 行绿、id = seed-alibaba-web（出厂种子成员面；p7/W4 re-base：行数 7→5）', async () => {
    const auto = makeAutoTransport(); // 无 translation 键 → 出厂种子（p7/W4 起终态五种子）
    const loaded = loadService({ manual: auto });
    const probe = await loaded.mod.probeEngines(false);
    assert.ok(probe.ok);
    const rows = probe.engines;
    assert.equal(rows.length, 5, `零配置探测行数 ≠ 5（种子成员面漂移）：${rows.length}`);
    const row = rows.find((r) => r.kind === 'alibaba-web');
    assert.ok(row, 'alibaba-web 探测行缺席（出厂种子未进组）');
    assert.equal(row.id, 'seed-alibaba-web', `alibaba-web 行 id ≠ 出厂种子 id：${row.id}`);
    assert.ok(row.ok === true && typeof row.latencyMs === 'number' && row.latencyMs >= 0, 'alibaba-web 探测行应绿（stub 应答）');
    assert.ok(!probe.appliedOrder, 'apply=false 不得返回 appliedOrder（契约随动面）');
  });

  await runCheck('W2a-2 组内降级接管：bing-web 失败 → alibaba-web 接管出译文（尝试序 [bing,alibaba]、失败引擎恰 1 次、零 error 推送）', async () => {
    const engines = [
      { id: 'bing-web', kind: 'bing-web', enabled: true, order: 0 },
      { id: 'alibaba-web', kind: 'alibaba-web', enabled: true, order: 1 },
    ];
    const auto = makeAutoTransport((kind) =>
      kind === 'bing-web' ? { ok: false, error: 'HTTP 503: bing down' } : `译@${kind}`,
    );
    const loaded = loadService({ config: { translation: { engines } }, manual: auto });
    const s = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'mw2a2' }, '甲'.repeat(100));
    assert.ok(s.ok);
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, 'alibaba 接管后未到 done');
    assert.deepEqual(kindsOf(auto.calls), ['bing-web', 'alibaba-web'], `尝试序不符：${kindsOf(auto.calls).join(',')}`);
    assert.equal(auto.calls.filter((c) => c.engineKind === 'alibaba-web').length, 1, 'alibaba-web 尝试次数 ≠ 1');
    const st = loaded.mod.getTranslationStates(SID)[0];
    assert.equal(st?.segments[0]?.translated, '译@alibaba-web', `译文非接管引擎产物：${st?.segments[0]?.translated}`);
    assert.ok(!loaded.pushes.some((p) => p.payload.kind === 'error'), '单引擎失败不得呈现错误态（降级吸收）');
  });

  // ── W2b qq-transmart stub 契约组（2026-11-22 扩容批次 p3；新 kind 经组语义流转面） ──
  console.log('=== W2b qq-transmart stub 契约组（p3 扩容） ===');

  await runCheck('W2b-1 零配置 qq-transmart 在册：零配置探测 5 行且 qq-transmart 行绿、id = seed-qq-transmart（出厂种子成员面；p7/W4 re-base：行数 7→5）', async () => {
    const auto = makeAutoTransport(); // 无 translation 键 → 出厂种子（p7/W4 起终态五种子）
    const loaded = loadService({ manual: auto });
    const probe = await loaded.mod.probeEngines(false);
    assert.ok(probe.ok);
    const rows = probe.engines;
    assert.equal(rows.length, 5, `零配置探测行数 ≠ 5（种子成员面漂移）：${rows.length}`);
    const row = rows.find((r) => r.kind === 'qq-transmart');
    assert.ok(row, 'qq-transmart 探测行缺席（出厂种子未进组）');
    assert.equal(row.id, 'seed-qq-transmart', `qq-transmart 行 id ≠ 出厂种子 id：${row.id}`);
    assert.ok(row.ok === true && typeof row.latencyMs === 'number' && row.latencyMs >= 0, 'qq-transmart 探测行应绿（stub 应答）');
    assert.ok(!probe.appliedOrder, 'apply=false 不得返回 appliedOrder（契约随动面）');
  });

  await runCheck('W2b-2 组内降级接管（EX-P2A-3 组语义面）：alibaba 失败 → qq-transmart 接管出译文（尝试序 [alibaba,qq]、失败引擎恰 1 次、零 error 推送）', async () => {
    const engines = [
      { id: 'alibaba-web', kind: 'alibaba-web', enabled: true, order: 0 },
      { id: 'qq-transmart', kind: 'qq-transmart', enabled: true, order: 1 },
    ];
    const auto = makeAutoTransport((kind) =>
      kind === 'alibaba-web' ? { ok: false, error: 'csrf HTTP 500' } : `译@${kind}`,
    );
    const loaded = loadService({ config: { translation: { engines } }, manual: auto });
    const s = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'mw2b2' }, '甲'.repeat(100));
    assert.ok(s.ok);
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, 'qq-transmart 接管后未到 done');
    assert.deepEqual(kindsOf(auto.calls), ['alibaba-web', 'qq-transmart'], `尝试序不符：${kindsOf(auto.calls).join(',')}`);
    assert.equal(auto.calls.filter((c) => c.engineKind === 'qq-transmart').length, 1, 'qq-transmart 尝试次数 ≠ 1');
    const st = loaded.mod.getTranslationStates(SID)[0];
    assert.equal(st?.segments[0]?.translated, '译@qq-transmart', `译文非接管引擎产物：${st?.segments[0]?.translated}`);
    assert.ok(!loaded.pushes.some((p) => p.payload.kind === 'error'), '单引擎失败不得呈现错误态（降级吸收）');
  });

  // ── W2c sogou-web stub 契约组（2026-11-22 扩容批次 p4；新 kind 经组语义流转面） ──
  console.log('=== W2c sogou-web stub 契约组（p4 扩容） ===');

  await runCheck('W2c-1 零配置 sogou-web 在册：零配置探测 5 行且 sogou-web 行绿、id = seed-sogou-web（出厂种子成员面；p7/W4 re-base：行数 7→5）', async () => {
    const auto = makeAutoTransport(); // 无 translation 键 → 出厂种子（p7/W4 起终态五种子）
    const loaded = loadService({ manual: auto });
    const probe = await loaded.mod.probeEngines(false);
    assert.ok(probe.ok);
    const rows = probe.engines;
    assert.equal(rows.length, 5, `零配置探测行数 ≠ 5（种子成员面漂移）：${rows.length}`);
    const row = rows.find((r) => r.kind === 'sogou-web');
    assert.ok(row, 'sogou-web 探测行缺席（出厂种子未进组）');
    assert.equal(row.id, 'seed-sogou-web', `sogou-web 行 id ≠ 出厂种子 id：${row.id}`);
    assert.ok(row.ok === true && typeof row.latencyMs === 'number' && row.latencyMs >= 0, 'sogou-web 探测行应绿（stub 应答）');
    assert.ok(!probe.appliedOrder, 'apply=false 不得返回 appliedOrder（契约随动面）');
  });

  await runCheck('W2c-2 组内降级接管（组语义面续链）：qq-transmart 失败 → sogou-web 接管出译文（尝试序 [qq,sogou]、失败引擎恰 1 次、零 error 推送）', async () => {
    const engines = [
      { id: 'qq-transmart', kind: 'qq-transmart', enabled: true, order: 0 },
      { id: 'sogou-web', kind: 'sogou-web', enabled: true, order: 1 },
    ];
    const auto = makeAutoTransport((kind) =>
      kind === 'qq-transmart' ? { ok: false, error: 'ret_code≠succ：auto_translation 缺失' } : `译@${kind}`,
    );
    const loaded = loadService({ config: { translation: { engines } }, manual: auto });
    const s = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'mw2c2' }, '甲'.repeat(100));
    assert.ok(s.ok);
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, 'sogou-web 接管后未到 done');
    assert.deepEqual(kindsOf(auto.calls), ['qq-transmart', 'sogou-web'], `尝试序不符：${kindsOf(auto.calls).join(',')}`);
    assert.equal(auto.calls.filter((c) => c.engineKind === 'sogou-web').length, 1, 'sogou-web 尝试次数 ≠ 1');
    const st = loaded.mod.getTranslationStates(SID)[0];
    assert.equal(st?.segments[0]?.translated, '译@sogou-web', `译文非接管引擎产物：${st?.segments[0]?.translated}`);
    assert.ok(!loaded.pushes.some((p) => p.payload.kind === 'error'), '单引擎失败不得呈现错误态（降级吸收）');
  });

  // ── T27 代码块零送翻 ──
  console.log('=== T27 代码块段零送翻 ===');

  await runCheck('T27 围栏段零请求 + 译文 = 原文 + 进度不悬挂（代码块段计入完成）', async () => {
    const auto = makeAutoTransport();
    const loaded = loadService({ manual: auto });
    const text = '甲'.repeat(80);
    const fence = ['```js', 'const a = 1; // keep', '```'].join('\n');
    const s = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm27' }, `${text}\n\n${fence}`);
    assert.ok(s.ok);
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, '含代码块翻译未完成');
    assert.equal(auto.calls.length, 1, `引擎请求次数 ≠ 1（围栏段被送翻：${auto.calls.length}）`);
    assert.equal(auto.calls[0]?.segment, text, '引擎载荷含围栏内容');
    const st = loaded.mod.getTranslationStates(SID)[0];
    assert.equal(st?.totalSegments, 2, '进度总段数未计入代码块段');
    assert.equal(st?.segments.length, 2, '进度悬挂：代码块段未入已译账');
    const codeSeg = st?.segments.find((x) => x.index === 1);
    assert.equal(codeSeg?.translated, fence, '代码块段译文 ≠ 原文（被翻译/丢失）');
  });

  // ── T28 探测结果表 ──
  console.log('=== T28 探测结果表（probeEngines 直接调用） ===');

  await runCheck('T28 混合 stub（RB-MT-T28 p7/W4 re-base：五启用引擎 bing/alibaba 绿、qq/sogou/youdao 红）：逐引擎 ok/latencyMs/error 对应；未启用零行零请求；载荷 = TRANSLATION_PROBE_TEXT', async () => {
    const auto = makeAutoTransport((kind) => {
      if (kind === 'bing-web') return '探@bing';
      if (kind === 'alibaba-web') return '探@alibaba';
      if (kind === 'qq-transmart') return { ok: false, error: 'ret_code≠succ: auto_translation 缺失' };
      if (kind === 'sogou-web') return { ok: false, error: 'HTTP 403: sign 校验失败' };
      return { ok: false, error: 'getaddrinfo ENOTFOUND dict.youdao.com' };
    });
    const engines = [
      ...seedEngines(),
      { id: 'bing-off', kind: 'bing-web', enabled: false, order: 9 },
    ];
    const loaded = loadService({ config: { translation: { engines } }, manual: auto });
    const probe = await loaded.mod.probeEngines(false);
    assert.ok(probe.ok);
    // 启用的 5 条（bing/alibaba 绿、qq/sogou/youdao 红）；禁用 bing-off 零行零请求
    const rows = probe.engines;
    assert.equal(rows.length, 5, `结果表行数 ≠ 启用引擎数（未启用引擎漏行/多行：${rows.length}）`);
    const b = rows.find((r) => r.kind === 'bing-web');
    const a = rows.find((r) => r.kind === 'alibaba-web');
    const q = rows.find((r) => r.kind === 'qq-transmart');
    const s = rows.find((r) => r.kind === 'sogou-web');
    const y = rows.find((r) => r.kind === 'youdao-web');
    assert.ok(b?.ok === true && typeof b.latencyMs === 'number' && b.latencyMs >= 0, 'bing 行绿/延迟字段异常');
    assert.ok(a?.ok === true && typeof a.latencyMs === 'number' && a.latencyMs >= 0, 'alibaba 行绿/延迟字段异常');
    assert.ok(q?.ok === false && q.error?.includes('ret_code'), `qq 行红/错误摘要异常：${q?.error}`);
    assert.ok(s?.ok === false && s.error?.includes('403'), `sogou 行红/错误摘要异常：${s?.error}`);
    assert.ok(y?.ok === false && y.error?.includes('ENOTFOUND'), `youdao 行红/错误摘要异常：${y?.error}`);
    assert.ok(!rows.some((r) => r.id === 'bing-off'), '禁用引擎出现在结果表');
    assert.equal(auto.calls.length, 5, '未启用引擎被探测（多余请求）');
    for (const c of auto.calls) {
      assert.equal(c.segment, translationCore.TRANSLATION_PROBE_TEXT, '探测载荷 ≠ 固定短测试文本（拿消息内容当测试文本）');
    }
    assert.ok(!probe.appliedOrder, 'apply=false 不得返回 appliedOrder');
  });

  // ── T29 探测 apply 落盘 ──
  console.log('=== T29 探测 apply 落盘（saveConfig 链） ===');

  await runCheck('T29 apply=true（RB-MT-T29 p7/W4 re-base）：ok 引擎按 latency 升序重写 order、失败殿后不禁用、appliedOrder 返回、重载后新序保持', async () => {
    // alibaba 延迟 10ms、bing 延迟 60ms、qq/sogou/youdao 失败 → 新序 [alibaba, bing, qq, sogou, youdao]
    const auto = makeAutoTransport((kind) => {
      if (kind === 'alibaba-web') return '探@a';
      if (kind === 'bing-web') return '探@b';
      return { ok: false, error: '引擎失败' };
    }, 0);
    const engines = seedEngines();
    const loaded = loadService({ config: { translation: { engines } }, manual: auto });
    // 延迟差分：手动包裹应答延迟（bing 慢、alibaba 快）
    const raw = auto.transport;
    loaded.mod.__setTranslationTransportForTest((req) =>
      new Promise<AttemptResult>((resolve) => {
        const delay = req.engineKind === 'bing-web' ? 60 : req.engineKind === 'alibaba-web' ? 10 : 0;
        setTimeout(() => raw(req).then(resolve), delay);
      }),
    );
    const probe = await loaded.mod.probeEngines(true);
    assert.ok(probe.ok);
    // 跨 realm 陷阱：appliedOrder 是 vm 侧数组（原型 ≠ 宿主 Array.prototype，deepStrictEqual
    // 跨 realm 必败）——用 join 字面比对。
    assert.equal(
      (probe.appliedOrder ?? []).join(','),
      'alibaba-web,bing-web,qq-transmart,sogou-web,youdao-web',
      `appliedOrder 不符：${probe.appliedOrder?.join(',')}`,
    );
    // 落盘：saveConfig 链捕获到 translation 补丁，order 重写、失败引擎未禁用
    const patch = loaded.saveCalls.find((p) => 'translation' in p) as { translation?: { engines: Array<{ id: string; order: number; enabled: boolean }> } } | undefined;
    assert.ok(patch?.translation, 'apply 未走 saveConfig 落盘');
    const saved = patch?.translation?.engines ?? [];
    const orderOf = (id: string): number => saved.find((e) => e.id === id)?.order ?? -1;
    assert.ok(orderOf('alibaba-web') < orderOf('bing-web'), 'ok 引擎未按 latency 升序');
    assert.ok(orderOf('qq-transmart') > orderOf('bing-web') && orderOf('sogou-web') > orderOf('bing-web') && orderOf('youdao-web') > orderOf('bing-web'), '失败引擎未殿后');
    assert.ok(saved.every((e) => e.enabled === true), '失败引擎被自动禁用（超出最小影响面）');
    // 重载配置（stub 已合并）后新序保持：新 START 尝试序首位 = alibaba
    const trAuto = makeAutoTransport();
    loaded.mod.__setTranslationTransportForTest(trAuto.transport);
    const s = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm29' }, '甲'.repeat(100));
    assert.ok(s.ok);
    await waitFor(() => trAuto.calls.length >= 1, 4000, '重排后翻译未发请求');
    assert.equal(kindsOf(trAuto.calls)[0], 'alibaba-web', '重排落盘后新 START 未按新序尝试');
    trAuto.calls[0]?.respond('译');
  });

  // ── T30 探测零翻译副作用 ──
  console.log('=== T30 探测零翻译副作用 ===');

  await runCheck('T30 探测不写段缓存、消息翻译态零变化、同输入请求次数 = 1 口径不被污染', async () => {
    const auto = makeAutoTransport();
    const loaded = loadService({ manual: auto });
    const probe = await loaded.mod.probeEngines(false);
    assert.ok(probe.ok);
    const probeCalls = auto.calls.length;
    assert.ok(probeCalls >= 5, '探测未逐引擎发请求（p7/W4 re-base：零配置五引擎）');
    await sleep(100);
    // 零翻译副作用：无 entry、无段缓存
    assert.equal(loaded.mod.getTranslationStates(SID).length, 0, '探测产生了消息翻译态');
    assert.ok(!loaded.hooks.segmentCache?.get(SID) || loaded.hooks.segmentCache.get(SID)?.size === 0, '探测写入了段缓存');
    // 首次打开翻译：对同一输入的请求次数仍 = 1
    const src = '甲'.repeat(100);
    const s = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm30' }, src);
    assert.ok(s.ok);
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, '探测后翻译未完成');
    const trCalls = auto.calls.filter((c) => c.segment === src);
    assert.equal(trCalls.length, 1, '探测污染请求计数口径（同输入请求次数 ≠ 1）');
    for (const c of auto.calls.slice(0, probeCalls)) {
      assert.equal(c.segment, translationCore.TRANSLATION_PROBE_TEXT, '探测载荷混入消息正文');
    }
  });

  // ── RB-MT-T31 删除留痕（2026-11-22 扩容批次 p6/W5）：原 T31「模板引擎（loopback 真实传输
  // 路径）：GET 三占位实例化 URL + responsePath 取值出译文 + POST bodyTemplate 实例化」整块
  // 删除——前提（custom-template 引擎 + customTemplates 字段）已随 W5 整链移除、kind 不在白名单；
  // 不留替身断言（出卷清单 §6 RB 行），删净面由 E1 卷 EX-P6-4 结构钉承载。 ──

  // ── RB-MT-T32 删除留痕（2026-11-22 扩容批次 p7/W4）：原 T32「google-gtx endpoint 换 loopback：
  // POST q 走 body 打新端点、gtx 形态解析出译文、出厂端点零命中」整块删除——前提（google-gtx
  // 引擎：适配器/kind/端点常量/种子）已随 W4 用户裁决（「谷歌先剔除掉」）整链剔除，载体死亡、
  // 前提不复存在；不留替身断言（endpoint 数据面收窄 bing-web 域名口径，loopback 行为面由
  // p1 修复卷 P1A/P1B bing 载体用例承载）。 ──

  // ── RB-MT-T33 删除留痕（2026-11-22 扩容批次 p6/W5）：原 T33「tencent 凭据缺省（本点半边）：
  // 引擎不可用不阻塞组 + 探测报「未配置凭据」零请求」整块删除——前提（tencent-tmt 引擎与
  // 凭据链）已随 W5 整链移除、kind 不在白名单；不留替身断言（出卷清单 §6 RB 行），unavailable
  // 机械面保留休眠（评审 P2-7）零行为可断、删净面由 E1 卷 EX-P6-1/2/3 结构钉承载。 ──

  // ── T34 代理尊重（loopback + env 注入单测形态） ──
  console.log('=== T34 出站代理尊重（env 注入 + CONNECT 隧道 loopback，禁真连外网） ===');

  await runCheck('T34-a env 优先序差分：HTTPS_PROXY > https_proxy > HTTP_PROXY > all_proxy；useProxy=false 直连；env 缺失回落 resolveProxy', async () => {
    const loaded = loadService({ fakeEnv: {}, electronProxyAnswer: 'PROXY 10.9.8.7:7890' });
    const { resolveOutboundProxy } = loaded.enginesMod;
    // useProxy=false → 恒直连（env 在场也不走）
    loaded.fakeEnv.HTTPS_PROXY = 'http://127.0.0.1:10001';
    assert.equal(await resolveOutboundProxy(false), null, 'useProxy=false 不得走代理');
    // 优先序差分切换
    let p = await resolveOutboundProxy(true);
    assert.ok(p?.href.includes('127.0.0.1:10001'), `HTTPS_PROXY 未生效：${p?.href}`);
    delete loaded.fakeEnv.HTTPS_PROXY;
    loaded.fakeEnv.https_proxy = 'http://127.0.0.1:10002';
    p = await resolveOutboundProxy(true);
    assert.ok(p?.href.includes('127.0.0.1:10002'), 'https_proxy 次级未生效');
    delete loaded.fakeEnv.https_proxy;
    loaded.fakeEnv.HTTP_PROXY = 'http://127.0.0.1:10003';
    p = await resolveOutboundProxy(true);
    assert.ok(p?.href.includes('127.0.0.1:10003'), 'HTTP_PROXY 第三级未生效');
    delete loaded.fakeEnv.HTTP_PROXY;
    loaded.fakeEnv.all_proxy = 'http://127.0.0.1:10004';
    p = await resolveOutboundProxy(true);
    assert.ok(p?.href.includes('127.0.0.1:10004'), 'all_proxy 兜底未生效');
    // env 全缺 → resolveProxy 回落（fake electron PROXY 10.9.8.7:7890）
    delete loaded.fakeEnv.all_proxy;
    p = await resolveOutboundProxy(true);
    assert.ok(p?.href.includes('10.9.8.7:7890'), `env 缺失未回落 resolveProxy：${p?.href}`);
    // resolveProxy DIRECT → 直连
    const directLoaded = loadService({ fakeEnv: {}, electronProxyAnswer: 'DIRECT' });
    assert.equal(await directLoaded.enginesMod.resolveOutboundProxy(true), null, 'resolveProxy DIRECT 未按直连处理');
  });

  await runCheck('T34-b CONNECT 隧道握手 A/B 差分捕获（直调机械钉，目标域为任意字面）', async () => {
    const proxyA = await makeConnectProxy();
    const proxyB = await makeConnectProxy();
    const loaded = loadService({ fakeEnv: { HTTPS_PROXY: `http://127.0.0.1:${proxyA.port}` } });
    try {
      const socketA = await loaded.enginesMod.establishConnectTunnel(`http://127.0.0.1:${proxyA.port}`, 'translate.googleapis.com', 443, 3000);
      assert.ok(socketA.writable, 'A 代理 CONNECT 握手未建立可用 socket');
      assert.deepEqual(proxyA.connects, ['translate.googleapis.com:443'], `A 代理捕获的 CONNECT 目标不符：${proxyA.connects.join(',')}`);
      socketA.destroy();
      // 差分切换：env 改指 B
      loaded.fakeEnv.HTTPS_PROXY = `http://127.0.0.1:${proxyB.port}`;
      const socketB = await loaded.enginesMod.establishConnectTunnel(`http://127.0.0.1:${proxyB.port}`, 'translate.googleapis.com', 443, 3000);
      assert.ok(socketB.writable, 'B 代理 CONNECT 握手未建立');
      assert.deepEqual(proxyB.connects, ['translate.googleapis.com:443'], 'B 代理未捕获出站');
      assert.equal(proxyA.connects.length, 1, '切换后 A 代理仍捕获到新请求（A 侧未冻结）');
      socketB.destroy();
      // agent 构造单测形态：createTunnelAgent 携带代理坐标（https.Agent 形态）
      const agent = loaded.enginesMod.createTunnelAgent(`http://127.0.0.1:${proxyA.port}`);
      assert.ok(agent && typeof agent.proxyHref === 'string' && agent.proxyHref.includes(`${proxyA.port}`), 'tunnel agent 未携带代理坐标');
    } finally {
      await proxyA.close();
      await proxyB.close();
    }
  });

  // ── T35 并发竞态 ──
  console.log('=== T35 多段并发降级竞态隔离 ===');

  await runCheck('T35 bing 对段1/3失败段2成功（RB-MT-SEED p7/W4 载体 re-base：G→B、B→A）：每段独立降级、段间零串扰、同段同引擎恰 1 次尝试', async () => {
    const p1 = `段落1${'甲'.repeat(100)}`;
    const p2 = `段落2${'乙'.repeat(100)}`;
    const p3 = `段落3${'丙'.repeat(100)}`;
    const auto = makeAutoTransport((kind, segment) => {
      const n = segment.startsWith('段落1') ? 1 : segment.startsWith('段落2') ? 2 : 3;
      if (kind === 'bing-web') return n === 2 ? `B译${n}` : { ok: false, error: `B down for seg${n}` };
      return `A译${n}`;
    });
    const loaded = loadService({ config: { translation: { engines: seedEngines() } }, manual: auto });
    const s = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm35' }, `${p1}\n\n${p2}\n\n${p3}`);
    assert.ok(s.ok);
    await waitFor(() => firstStatus(loaded, SID) === 'done', 6000, '并发降级翻译未完成');
    const st = loaded.mod.getTranslationStates(SID)[0];
    assert.equal(st?.totalSegments, 3);
    assert.equal(st?.segments.find((x) => x.index === 0)?.translated, 'A译1', '段1 未独立降级到 alibaba');
    assert.equal(st?.segments.find((x) => x.index === 1)?.translated, 'B译2', '段2 未由 bing 直接成功');
    assert.equal(st?.segments.find((x) => x.index === 2)?.translated, 'A译3', '段3 未独立降级到 alibaba');
    // 每段对同一引擎恰 1 次尝试（并发下无重复请求；段2 bing 直接成功、段1/3 bing 败后 alibaba 接管）
    const countOf = (kind: string, p: string): number => auto.calls.filter((c) => c.engineKind === kind && c.segment === p).length;
    assert.equal(countOf('bing-web', p1), 1, `bing 对段1 尝试次数 ≠ 1`);
    assert.equal(countOf('bing-web', p2), 1, `bing 对段2 尝试次数 ≠ 1`);
    assert.equal(countOf('bing-web', p3), 1, `bing 对段3 尝试次数 ≠ 1`);
    assert.equal(countOf('alibaba-web', p1), 1, `alibaba 对段1 尝试次数 ≠ 1`);
    assert.equal(countOf('alibaba-web', p3), 1, `alibaba 对段3 尝试次数 ≠ 1`);
    assert.equal(auto.calls.length, 5, `总请求数异常（放大/缺失）：${auto.calls.length}`);
  });

  // ── INV 组（边界值表逐条） ──
  console.log('=== INV 边界值组（§5.7） ===');

  await runCheck('INV-1 全组禁用：START 拒绝 {ok:false,未启用任何翻译引擎}，零 HTTP', async () => {
    const loaded = loadService({
      config: { translation: { engines: seedEngines().map((e) => ({ ...e, enabled: false })) } },
    });
    const r = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm-i1' }, '甲'.repeat(100));
    assert.ok(!r.ok && r.error === '未启用任何翻译引擎，请在设置中启用', `拒绝文案不符：${r.ok ? '' : r.error}`);
    await sleep(100);
    assert.equal(loaded.calls.length, 0, '全禁用仍发起了 HTTP');
  });

  await runCheck('INV-2 clearSessionTranslations：在飞 abort + 三表该会话键全清', async () => {
    const loaded = loadService();
    const done1 = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm-i2' }, '甲'.repeat(100));
    assert.ok(done1.ok);
    await waitFor(() => loaded.calls.length === 1, 4000, '请求未在飞');
    loaded.calls[0]?.respond('译甲');
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, '第一翻译未完成（缓存未落）');
    const pending2 = await loaded.mod.startTranslation(SID, { kind: 'thinking', messageId: 't-i2' }, '乙'.repeat(100));
    assert.ok(pending2.ok);
    await waitFor(() => loaded.calls.length === 2, 4000, '第二翻译未在飞');
    loaded.mod.clearSessionTranslations(SID);
    assert.equal(loaded.calls[1]?.signal.aborted, true, '清理未 abort 在飞请求');
    assert.equal(loaded.hooks.translations?.size, 0, 'translations 表未清');
    assert.ok(!loaded.hooks.bySession?.has(SID), 'bySession 未清该会话键');
    assert.ok(!loaded.hooks.segmentCache?.has(SID), 'segmentCache 未清该会话键（跨会话残留）');
    // 跨 realm 比较陷阱：getTranslationStates 返回 vm 侧数组（原型 ≠ 宿主 Array.prototype，
    // deepStrictEqual 跨 realm 必败）——用 length 判空。
    assert.equal(loaded.mod.getTranslationStates(SID).length, 0, '清理后 GET_STATE 仍返回条目');
    await sleep(100);
    assert.equal(loaded.calls.length, 2, '清理后出现续请求');
  });

  await runCheck('INV-3 并发 START 幂等：同 target 双 START 复用同一 entry，请求不放大', async () => {
    const loaded = loadService();
    const [r1, r2] = await Promise.all([
      loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm-i3' }, '甲'.repeat(100)),
      loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'm-i3' }, '甲'.repeat(100)),
    ]);
    assert.ok(r1.ok && r2.ok && r1.translationId === r2.translationId, '并发 START 产生两个 entry（幂等索引失效）');
    await waitFor(() => loaded.calls.length === 1, 4000, '请求未在飞');
    loaded.calls[0]?.respond('译');
    await waitFor(() => firstStatus(loaded, SID) === 'done', 4000, '翻译未完成');
    await sleep(120);
    assert.equal(loaded.calls.length, 1, '并发 START 造成重复请求（running 守卫失效）');
    assert.equal(loaded.mod.getTranslationStates(SID).length, 1, '同 target 出现多 entry');
  });

  await runCheck('INV-4 结构收口：推送字面/webContents.send 禁入 + 连接面声明 + seam 与 env 钩子形态钉', () => {
    assert.ok(!serviceSrc.includes('webContents.send('), 'translation-service 出现 webContents.send 字面（wiring §③ 违例）');
    assert.ok(serviceSrc.includes('pushToMainWindow(IPC_CHANNELS.TRANSLATION_EVENT'), '发射未统一走 pushToMainWindow(TRANSLATION_EVENT)');
    assert.ok(serviceSrc.includes('__setTranslationTransportForTest'), 'R3 seam 导出缺失');
    assert.ok(enginesSrc.includes('__setTranslationEnginesTransportForTest'), 'engines seam 安装点缺失');
    assert.ok(serviceSrc.includes('CLAUDE_LINK_TRANSLATE_STUB'), 'env stub 钩子缺失（CDP 禁网纪律挂点）');
    assert.ok(serviceSrc.includes('CLAUDE_LINK_TRANSLATE_STUB_LOG'), 'JSONL 请求计数日志钩子缺失');
    assert.match(enginesSrc, /【连接面声明】/, 'translation-engines.ts 缺连接面白名单声明头注释（topic-analyzer.ts:1 先例）');
  });

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
