// scripts/tdd-translate-p1-fix-verify.ts
// P1 翻译引擎修复契约卷（2026-11-21 计划 · 点 p1：P1-A CONNECT 隧道 TLS + P1-C 统一浏览器 UA +
// P1-B 翻译专用代理地址配置；内序 A→C→B 实施）。规格 = 03-实施计划.md §0 裁决（R5：常量名
// BROWSER_UA）+ 点指令「P1 · 翻译引擎修复」自包含版；02-测试用例清单 P1A/P1B/P1C 组的 node 形态。
//
// 用例映射（check 计数，失败 exit 1）：
//   P1A-T1  loopback 假 CONNECT 代理（200 后隧道接本地 TLS server）+ bing-web（loopback TLS
//           域名替换）+ env HTTPS_PROXY 注入 → TLS 握手完成、加密通道收到页面 GET 与
//           ttranslatev3 POST、bing 形态 200 → entry done 且译文正确（P1-A 修复本体）。
//           RB-P1-P1A-T1（p7/W4 载体 re-base，出卷清单 §8.3「推导补充」行）：载体 google-gtx
//           随 W4 整链剔除 → 换 bing-web（域名口径 endpoint 覆盖 + TLS loopback 先例）
//   P1A-T2  假代理对 CONNECT 应答 500；bing-web(useProxy 出厂域) + loopback bing 接管
//           → bing 尝试确实发生（CONNECT 目标 = cn.bing.com:443 捕获）且失败形态结束、组降级
//           loopback bing 接管出译文、done、无 error 推送（T25-a 断言在隧道失败输入下成立）。
//           RB-P1-P1A-T2（p7/W4 载体 re-base）：受害者换 bing-web；接管面因 alibaba/qq/sogou/
//           youdao 均不消费 endpoint（P1-5），真实传输路径下用第二个 bing-web（loopback TLS）——
//           与清单字面「alibaba 接管」的偏差已申报
//   P1A-T2b（F-r1-12 收口钉，载体 bing-web）CONNECT 200 交付后隧道 socket 立即 destroy（失败源
//           = TLS 层，非 CONNECT 层）→ bing 进入隧道内 TLS 握手（代理观测 ClientHello 字节）后
//           以 network 失败形态结束、组降级 loopback bing 出译文、无 error 推送、无未捕获异常；
//           绿态断言 + 注释标注验证手法（见用例体；审查岗已实证分支行为）
//   P1A-T3  env 全空 + resolveProxy 答 DIRECT + 无 config 代理；bing-web 端点 = loopback TLS；
//           假 CONNECT 代理哨兵在场 → resolveOutboundProxy(true)=null、请求直连命中 loopback、
//           哨兵 CONNECT 捕获数 = 0（无代理直连形态回归钉；p7/W4 载体 re-base）
//   P1A-T4  env HTTPS_PROXY 指哨兵 + bing-web（useProxy=false，loopback TLS 域名替换）→ bing
//           照常成功；哨兵 CONNECT = 0；resolveOutboundProxy(false) 恒 null（载体本就是 bing-web，
//           p7 re-base 零改动）
//   P1A-T5  同一装载实例先经代理 A 出站再切 env 代理 B → A 侧 CONNECT 计数冻结、B 侧捕获新
//           CONNECT（T34-b A/B 差分在新隧道行为下保持；p7/W4 载体 re-base：bing 两请求形态——
//           首次出站页面+翻译 2 次 CONNECT、会话缓存后仅翻译 1 次 CONNECT）
//   P1A-T6（F-r1-13 收口钉，分支级形态）createTunnelAgent().createConnection({protocol:'http:',
//           port≠443}) → 非 https 直通分支交付裸 net.Socket（非 TLSSocket）→ 明文 HTTP 经隧道
//           （假 CONNECT 代理 pipe 明文 http 上游）直通命中 loopback 端点（CONNECT 计数=1 且
//           目标 = loopback 端点坐标）。⚠️ 引擎级形态（custom-template http 端点 + useProxy）
//           在 Node http.request×https.Agent 协议门禁（ERR_INVALID_PROTOCOL）下不可达，分支对
//           httpRequest 是死分支——已申报报告待审查岗裁定 src 侧处置；分支在位钉：直通分支被
//           回退成一律 TLS 包裹/不交付则红
//   P1B-T1  config 代理 = 10001 + env HTTPS_PROXY = 10002 → config 赢（href 含 10001）；删
//           config 实参才回落 10002（优先级最高）
//   P1B-T2  config 代理空/缺省 + env 四级逐级注入删除 → 逐级跟随（HTTPS_PROXY > https_proxy >
//           HTTP_PROXY > all_proxy，T34-a 四级序在第二参形态下保持）
//   P1B-T3  config 空 + env 全空 + resolveProxy PROXY 10.9.8.7:7890 → 解析得之；DIRECT → null
//   P1B-T4  translation 节无 proxyUrl 键（p8 字段删除后形态）+ env 空 + DIRECT → resolveOutboundProxy(true)=null
//   P1B-T5  config 代理非法值（not a url / http:// / 纯空白）→ 等同未配置：env 照常生效、
//           不抛异常、不阻断后续链（休眠机械面：第二参显式值解析语义原样保留）
//   P1B-T6  存量 proxyUrl 键的 translation 节经 probeEngines(true) apply 落盘 → 保存链不拒绝且
//           落盘载荷无 proxyUrl 键（RB-P1-P1B-T6 翻转，p8：原「透传」断言与字段删除正面冲突）
//   P1B-T7  translation 节无 proxyUrl 键（夹具随 p8 字段删除重整）+ 哨兵地址仅作
//           resolveOutboundProxy(false, …) 位置实参 → 恒 null、bing 直连成功、哨兵零 CONNECT
//           （原 config 代理哨兵前提整链删除，useProxy=false 机械语义由位置实参承载）
//   P1B-T8  静态钉翻转（RB-P1-P1B-T8，p8）：ConfigPage「代理地址」输入不存在钉——trProxyUrl
//           computed / v-model 绑定 / 代理地址标签与占位文案 / delete t.proxyUrl /
//           t.proxyUrl = trimmed / .tr-proxy-field 全部零命中；无新增 IPC 通道断言保持
//   P1B-T9  承载于 tdd-translation-core-verify.ts sanitize 组（MOD-P1B-1 增钉，p8 翻转落卷）
//   P1B-T10 行为级接线翻转钉（载体 bing-web，p8/W4 P1-B 回撤）：env HTTPS_PROXY + bing-web
//           （useProxy=true，loopback TLS）→ 隧道 TLS 出译文（env→agent→TLS 机械活体，
//           RB-P1-P1B-T10 改写）；config.proxyUrl 接线字面零命中（闭包传参删除）
//   P1C-T1  loopback TLS 捕获 bing 两请求头 → User-Agent = 统一 UA 字面（p7/W4 载体 re-base）
//   P1C-T2  静态钉：BROWSER_UA 常量字面 + BING_UA 清零 + httpRequest 展开序（默认 UA 在前、
//           init.headers 在后 = 用户显式头不被覆盖）+ 全引擎经 httpRequest 消费
//           （p7/W4：调用点计数随适配器集合重定标 9→15）
//   P1C-T3  spawn 门：tdd-translation-core-verify.ts 与 tdd-message-translate-verify.ts 均 exit 0
//           （既有契约全绿不回退；含 MOD-P1A-1 / MOD-P1B-1 修订后形态）
//   P1C-T4  无显式 UA 头的引擎请求仍含统一 UA（载体 alibaba-web 三步协议经 httpsShim 定向重写
//           进环回 TLS；原 custom-template 载体随 W5 p6 死亡——RB-P1-P1C-T4 收口改写）
//
// 夹具手法（沿 tdd-message-translate-verify vm 双 realm 装载）：translation-service 与
// translation-engines 整模块 TS→CJS 转译入 vm，config-manager/logger/push-bus/electron 替为
// stub；真实 HTTP/TLS 路径在本卷不打外网——全部端点/代理为 loopback。TLS 环回 = tls.createServer
// + 自签证书（IP SAN 127.0.0.1，本文件内嵌 PEM 常量，openssl 预生成，测试专用非敏感）+ http.Server
// 经 emit('connection', tlsSocket) 承载解密流（https-proxy 实现通用手法）；TLS 信任经 require 垫片
// 对 node:tls.connect / node:https.request（hostname 环回时）注入 ca 选项——生产代码路径其余 1:1
// 不动（与既有卷 fake electron resolveProxy 同性质的测试注入面）。
//
// MOD-P1A-1 夹具升级在 tdd-message-translate-verify.ts（T34-b 不再 20ms destroy）；本卷
// makeConnectProxy 自带升级后形态（record 应答 200 后不主动销毁，close 时清扫）。
//
// RED 留证：对修复前工作树首跑 → P1A-T1/T5 裸 socket 交付（TLS server 收不到握手/请求挂断）、
// P1B-T1/T5/T6/T10 代理配置面缺失、P1C-T1/T2/T4 UA 缺失 → 断言失败 exit ≠ 0。
// 运行：npx tsx scripts/tdd-translate-p1-fix-verify.ts（登记 scripts/selftest-static-list.txt 尾部）

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import * as net from 'node:net';
import * as translationCore from '../src/shared/translation-core';
import { IPC_CHANNELS } from '../src/shared/constants';
import type { TranslationTarget } from '../src/shared/translation-core';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const serviceSrc = read('src/main/modules/translation-service.ts');
const enginesSrc = read('src/main/modules/translation-engines.ts');
const ipcConst = read('src/shared/types/ipc.ts');
const preloadApi = read('src/preload/api.ts');
const webBridge = read('src/renderer/web/web-bridge.ts');
const configPageSrc = read('src/renderer/pages/ConfigPage.vue');

// T 结构卫生：一次性临时目录（先例 tdd-message-translate-verify 同款）。F-r1-14：路径留存在
// P1_TEMP_DIR，卷尾 teardown rmSync 清理（message 卷沿其先例不清理，本卷顺手收口）。
const P1_TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-p1fix-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = P1_TEMP_DIR;

// ── TLS 环回自签证书（openssl 预生成内嵌；CN=127.0.0.1、SAN=IP:127.0.0.1,DNS:localhost；
//  仅测试卷使用，非敏感材料） ──

const P1_TEST_CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIDJTCCAg2gAwIBAgIUJwWkvz0YNRjKtYy6fVNEeH/UuAIwDQYJKoZIhvcNAQEL',
  'BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTEyMTE1NTgxOFoXDTM2MTEx',
  'ODE1NTgxOFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF',
  'AAOCAQ8AMIIBCgKCAQEA4wMu744DdWvaNjpIic7upRdd1NCLzo4Anf6St/4HJCn0',
  '0GymXIBoW5WSaxVhjjwIkhdJ43EKHtijWOLVMAaDw05Lna8X0xJRzdqEoJfP68R/',
  'bj41fV8dj9KpuiBXJmzkPXSyTN3u19hlzHc1Fch6VihMyT39WZVek/WmmpwVyqHj',
  '6WXVbFwMz8NL40jyHcdFnPZJOSozJ+AIWaUWxdtXvjNiYhMwRA2H8lE2sZJu+ToB',
  '2lqezkznE81p90o5WTwe2RVqdhCWjHEZ8UKqObw411RUX0hSFcMW3O9ZdlvglDk9',
  '2CWyYQ/xUWE5deoKHOKfmRlmCkELZUAyr8ufnO42mwIDAQABo28wbTAdBgNVHQ4E',
  'FgQUo1/snl6nwGOZfBGtvv+1ZJKVaHgwHwYDVR0jBBgwFoAUo1/snl6nwGOZfBGt',
  'vv+1ZJKVaHgwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2Nh',
  'bGhvc3QwDQYJKoZIhvcNAQELBQADggEBAFi66p8KPIocmlklqk8J/5pa71DW1ycZ',
  'E3ExBM6dKBj/Qr4SWpq9VqR/ypjdJeWCvAsvZmsm83CHmYsKKJx0M7XyjNGvLCOg',
  '35Rz72Cw4iyn/TiRmQLgf3mZ7yTdOJ5xMGSH1Dr9o/NK6pcIrtkbaVGaT9etB/qq',
  'iHG9hlHN/8oF/nGsxtFv23MSRKo1ApcC3FWhtQvSbs8FRuRwCft8XJZcJN8NfnNt',
  'mkFcOV2J0BJl8CAPxG6omEMjkRS8o+1ZzhUx8ALT3yd1D9LU/dj8yGLmrB+Olgt4',
  'sxhPUeH9RJQnsje3/ChSgyd9AoXHuL7r67iDaDDbBwk/KFYDPId5BK8=',
  '-----END CERTIFICATE-----',
].join('\n');

const P1_TEST_KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDjAy7vjgN1a9o2',
  'OkiJzu6lF13U0IvOjgCd/pK3/gckKfTQbKZcgGhblZJrFWGOPAiSF0njcQoe2KNY',
  '4tUwBoPDTkudrxfTElHN2oSgl8/rxH9uPjV9Xx2P0qm6IFcmbOQ9dLJM3e7X2GXM',
  'dzUVyHpWKEzJPf1ZlV6T9aaanBXKoePpZdVsXAzPw0vjSPIdx0Wc9kk5KjMn4AhZ',
  'pRbF21e+M2JiEzBEDYfyUTaxkm75OgHaWp7OTOcTzWn3SjlZPB7ZFWp2EJaMcRnx',
  'Qqo5vDjXVFRfSFIVwxbc71l2W+CUOT3YJbJhD/FRYTl16goc4p+ZGWYKQQtlQDKv',
  'y5+c7jabAgMBAAECggEALhQK1mAejpp+N+ybpbFFmmgESTqtbhc/w9IVCNi8rVgA',
  '07+CAxujUxeomSjFXQANg03L1ykuMzWo7lVYjX99BkshqReNv++jgCO/MPOvpf0E',
  'GqXw6IpCb1uEzP1cgzWuHFVQDa8smE5Z12dI9Kt1PYC/mUeGYcUiZekCULam67KP',
  'nWBriBDJ+j9Mx2m+CQ0/96fpYfBQ8OjdjCwC+Hy5XeDrH84P88rQtZ0XP/1ObE3M',
  'rNSjDQkQXoSCMuqpWNw8GaKpeDV1fDyb+XZY5r2Dec80y9NoBLij9z/w+M52Sb+g',
  '2wBbhBgyHalXv9xyOwnVvurMjs9x8fPnEgIh3dYU7QKBgQD8v1y1CvnSeY5emoI+',
  'ViP4dN6svTfzWNCdQdK0AuBGS78hN47BByFQigWvJ0gXwtKDCU5vg5a396eMTT8j',
  'e4h5J0vhjwjsiL2PCphSGFDO+lS+l10zFPL2SEwwgFWGWITEAPQb0g1b8fa5utdD',
  '0vRQk/nFAv7YLYgYPQnW/hSB5QKBgQDl7wp8KGAUzywfPSlmEJuJLpllPG+Dl97n',
  'XRxKo4CqktjEvv6kTEFkf6bvEIAfAb89uDThJ+VpcD+tnyw/jJgeZgQ/a3jT4wDL',
  'qsK9QjusYqNpWEIIQ2pIIVN5T8rFCUHTJt8YohZBxwAWkyqFQJYf+NNQv3AkMwRN',
  'LbG1EZZOfwKBgC2Qtj7xTp6SSYdmpYplbzCwqSBNMJQPc/SV1E2dox8pMrjjUjoc',
  'dfYWG/Y6x7V46wiymdBi0b4yyKLznilgcPcejYCJj9tMv5fVGibauV7HJJYDpcq6',
  'wR6DZDDuQfzpYm4PmfKWCNCFq6xKMdrJYkBQnRvWcWk5tCpifq6iucG9AoGAEwTz',
  '3BNG51G/t5HKk9u50d4d6CbYnoz4bjDgfzgJE5L0BUo7LAH2wsZgW5QE1QvC8usC',
  'zMENE+yqB8WL1nHdv1326fwM0ZIMZcxpMViCMR8znyoixCY3a2H+UqGMB0JdxIaJ',
  'm7MEnkpEsplXwg/2mwxtBlffgc8KgwvNkEm1IicCgYEAwyogRO+redXSGseEXSMT',
  'QHn5UbVv/LWBFjBKVTpz5Nqm50ydnrFmK2SXIGPowql++/q8CfdKpRfl2bLEPhoQ',
  'irYvF2oNPMhQ/a4z6CnxZkbY3+BRgL1Rb00mYZZCeOelDqTpEeJQb9n2pFNxs5Fn',
  'D4lRd8L+B4ltb7l+8NfdVlI=',
  '-----END PRIVATE KEY-----',
].join('\n');

/** 统一浏览器 UA 字面（P1-C 期望值；03 §0 R5 裁决：常量名 BROWSER_UA；2026-11-22 引擎扩容批次
 *  RB-P1-P1C-T2 随 bing 复活配方修订：版本段 126→141，其余段不变——09 报告 §2 差异4）。 */
const BROWSER_UA_LITERAL =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

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

// ── vm 双 realm 装载（沿 tdd-message-translate-verify 手法；engines 的 node:tls / node:https
//  经测试垫片注入环回 TLS 信任，其余依赖映射与既有卷一致） ──

interface ConfigStub {
  apiKey: string;
  apiBaseUrl: string;
  translation?: unknown;
}

interface EnginesExports {
  createWebMtEngineGroup: unknown;
  __setTranslationEnginesTransportForTest(t: Transport | null): void;
  resolveOutboundProxy(useProxy: boolean, explicitProxyUrl?: string | null): Promise<{ href: string } | null>;
  establishConnectTunnel(proxyHref: string, targetHost: string, targetPort: number, timeoutMs: number): Promise<{ destroy(): void; writable: boolean }>;
  createTunnelAgent(proxyHref: string): {
    proxyHref: string;
    createConnection(
      options: http.RequestOptions & { protocol?: string; servername?: string },
      callback?: ((err: Error | null, stream?: unknown) => void) | undefined,
    ): unknown;
  };
}

interface ServiceExports {
  startTranslation(sessionId: string, target: TranslationTarget, sourceText: string): Promise<{ ok: boolean; translationId?: string; error?: string }>;
  stopTranslation(translationId: string): boolean;
  probeEngines(apply: boolean): Promise<{ ok: boolean; engines: Array<{ id: string; kind: string; ok: boolean; latencyMs: number; error?: string }>; appliedOrder?: string[] }>;
  getTranslationStates(sessionId: string): Array<{ status: string; target: TranslationTarget; segments: Array<{ index: number; translated: string | null }>; totalSegments: number; error?: string }>;
  __setTranslationTransportForTest(transport: Transport | null): void;
}

interface LoadedService {
  mod: ServiceExports;
  enginesMod: EnginesExports;
  fakeEnv: Record<string, string | undefined>;
  hooks: { segmentCache: Map<string, Map<string, string>> | null };
  calls: EngineCall[];
  pushes: Array<{ channel: string; payload: { kind: string; segmentIndex?: number; text?: string; error?: string } }>;
  config: ConfigStub;
  saveCalls: Array<Record<string, unknown>>;
}

type AttemptResult = { ok: true; text: string } | { ok: false; error: string };

interface EngineCall {
  engineKind: string;
  segment: string;
  signal: AbortSignal;
  respond(text: string): void;
  fail(error: string): void;
}

type Transport = (req: { engineKind: string; segment: string; signal: AbortSignal }) => Promise<AttemptResult>;

function makeAutoTransport(responder?: (kind: string, segment: string) => string | { ok: false; error: string }): { calls: EngineCall[]; transport: Transport } {
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
      const scripted = responder ? responder(req.engineKind, req.segment) : `【译】${req.segment}`;
      if (typeof scripted === 'string') call.respond(scripted);
      else call.fail(scripted.error);
    });
  return { calls, transport };
}

const HOOKS_SUFFIX = `
; if (typeof __p1hooks === 'function') __p1hooks({
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

/** node:tls 垫片：注入测试 CA（本卷引擎全部环回 TLS 目标；SNI 可能为 ''（IP 直连无 SNI 形态），
 *  故不按 servername 键控，恒注入——本卷无任何非环回 TLS 出站）。 */
const tlsShim: typeof tls = (() => {
  const real = require('node:tls') as typeof tls;
  const shim = { ...real } as { -readonly [K in keyof typeof tls]: typeof tls[K] } & typeof tls;
  (shim as { connect: unknown }).connect = (...args: unknown[]) => {
    const opts = args[0];
    if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
      (opts as Record<string, unknown>).ca = [P1_TEST_CERT];
      return (real.connect as (...a: unknown[]) => tls.TLSSocket)(...(args as Parameters<typeof real.connect>));
    }
    return (real.connect as (...a: unknown[]) => tls.TLSSocket)(...(args as Parameters<typeof real.connect>));
  };
  return shim as unknown as typeof tls;
})();

/** node:https 垫片：hostname 环回时注入测试 ca（真实 https.request 其余 1:1；非环回不动）。
 *  RB-P1-P1C-T4（p7 收口）定向重写：alibaba-web 为固定多主机协议不消费 endpoint（评审 P1-5，
 *  适配器 URL 恒出厂域 translate.alibaba.com）——P1C-T4 载体改 alibaba 后经垫片把该域的请求
 *  重写进环回 TLS 端点（alibabaRedirectPort 非 null 时生效，用例 finally 复位），否则放行原样
 *  （其余用例零影响）。重写后 hostname ∈ 环回集 → CA 注入分支照常生效。 */
let alibabaRedirectPort: number | null = null;
const httpsShim: typeof https = (() => {
  const real = require('node:https') as typeof https;
  const loopback = new Set(['127.0.0.1', 'localhost', '::1']);
  const shim = { ...real } as { -readonly [K in keyof typeof https]: typeof https[K] } & typeof https;
  (shim as { request: unknown }).request = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'object' && first !== null && !(first instanceof URL)) {
      const opts = first as { hostname?: unknown; port?: unknown; ca?: unknown };
      if (alibabaRedirectPort !== null && opts.hostname === 'translate.alibaba.com') {
        opts.hostname = '127.0.0.1';
        opts.port = String(alibabaRedirectPort);
      }
      if (loopback.has(String(opts.hostname ?? '')) && opts.ca === undefined) {
        opts.ca = [P1_TEST_CERT];
      }
    }
    return (real.request as (...a: unknown[]) => http.ClientRequest)(...(args as Parameters<typeof real.request>));
  };
  return shim as unknown as typeof https;
})();

function loadService(opts: {
  config?: Partial<ConfigStub>;
  fakeEnv?: Record<string, string | undefined>;
  electronProxyAnswer?: string;
  /** false = 不注入 seam stub（真实传输路径打 loopback）；默认 true。 */
  stubTransport?: boolean;
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

  const enginesRequire = (spec: string): unknown => {
    switch (spec) {
      case 'node:crypto':
        return require('node:crypto');
      case 'node:https':
        return httpsShim;
      case 'node:http':
        return require('node:http');
      case 'node:tls':
        return tlsShim;
      case 'electron':
        return fakeElectron;
      case '../utils/logger':
        return loggerStub;
      case '../../shared/translation-core':
        return translationCore;
      default:
        throw new Error(`P1 修复卷 engines require 垫片未映射的模块：${spec}`);
    }
  };
  const enginesMod = runInVm(transpile(enginesSrc), { process: fakeProcess }, enginesRequire) as unknown as EnginesExports;

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
        throw new Error(`P1 修复卷 service require 垫片未映射的模块：${spec}（隔离哨兵）`);
    }
  };
  let hooks: LoadedService['hooks'] = { segmentCache: null };
  const mod = runInVm(
    transpile(serviceSrc + HOOKS_SUFFIX),
    {
      process: fakeProcess,
      __p1hooks: (h: LoadedService['hooks']) => {
        hooks = h;
      },
    },
    serviceRequire,
  ) as unknown as ServiceExports;

  const ctl = makeAutoTransport();
  if (opts.stubTransport !== false) {
    mod.__setTranslationTransportForTest(ctl.transport);
  }
  return { mod, enginesMod, fakeEnv, hooks, calls: ctl.calls, pushes, config, saveCalls };
}

async function waitFor(fn: () => boolean, timeoutMs = 5000, label = ''): Promise<void> {
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

// RB-P1 卷随动（2026-11-22 扩容批次 p7/W4 re-base）：夹具种子换终态五序（bing→alibaba→qq→
// sogou→youdao，order 0..4）——google-gtx/baidu-web 死引擎剔除（00 计划 W4），夹具不得残留
// 死 kind；消费面 P1B-T4（resolveOutboundProxy 单测）与 P1B-T6（探测行数/engines 落盘计数断言
// 随动 4→5）。p8（P1-B 代理面回撤）：T6 翻转（落盘载荷无 proxyUrl 键）、T7 夹具 proxyUrl 键删
// （断言随剥离形态改）、T8 翻转不存在钉、T10 env 载体改写 + 接线字面零命中、INV 结构收口翻转；
// T34 机械面用例不动（ConnectTunnelAgent/resolveOutboundProxy 语义未变）。
function seedEngines(): Array<{ id: string; kind: string; enabled: boolean; order: number }> {
  return [
    { id: 'bing-web', kind: 'bing-web', enabled: true, order: 0 },
    { id: 'alibaba-web', kind: 'alibaba-web', enabled: true, order: 1 },
    { id: 'qq-transmart', kind: 'qq-transmart', enabled: true, order: 2 },
    { id: 'sogou-web', kind: 'sogou-web', enabled: true, order: 3 },
    { id: 'youdao-web', kind: 'youdao-web', enabled: true, order: 4 },
  ];
}

// ── 环回夹具 ──

/** loopback HTTP stub（T32 先例同款；不出外网）。 */
async function makeLoopbackServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ port: number; captured: Array<{ path: string | undefined; method: string | undefined; body: string; ua: string | undefined; contentType: string | undefined; headers: http.IncomingHttpHeaders }>; close(): Promise<void> }> {
  const captured: Array<{ path: string | undefined; method: string | undefined; body: string; ua: string | undefined; contentType: string | undefined; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c: string) => {
      data += c;
    });
    req.on('end', () => {
      captured.push({ path: req.url, method: req.method, body: data, ua: req.headers['user-agent'], contentType: req.headers['content-type'], headers: req.headers });
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
  return {
    port,
    captured,
    close: () => {
      server.closeIdleConnections?.();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

/**
 * loopback CONNECT 代理（MOD-P1A-1 升级后形态）：
 * - 默认 record：应答 200 后不主动销毁 socket（原 20ms destroy 行为移除——裸 socket 交付在
 *   P1-A 修复后不再是合法隧道形态，夹具保证握手后连接可用）；close 时统一清扫。
 * - tlsUpstreamPort：应答 200 后把隧道双向 pipe 到本地 TLS server（P1A-T1/T5 的真实隧道形态）。
 * - plainUpstreamPort：同 tlsUpstreamPort 的裸 TCP pipe（F-r1-13 的明文 http 上游形态——
 *   pipe 与 TLS 无关，别名仅为语义显式）。
 * - rejectWithStatus：对 CONNECT 应答该状态码后销毁（P1A-T2 的 CONNECT 层失败输入）。
 * - destroyAfter200：应答 200（CONNECT 层成功）后 200ms 销毁隧道 socket（P1A-T2b 的 TLS 层
 *   失败输入——引擎已进隧道内 TLS 握手；clientHelloBytes 观测面证明 ClientHello 已发出）。
 *   复审 r2 建议：50ms→200ms 放宽防慢机假红（慢机上 tls.connect 未在 50ms 内发出 ClientHello
 *   会被过早销毁、clientHelloBytes=0 假红）；语义仍为即时失败判别（<8s 断言不动）。
 */
async function makeConnectProxy(
  opts: { tlsUpstreamPort?: number; plainUpstreamPort?: number; rejectWithStatus?: number; destroyAfter200?: boolean } = {},
): Promise<{ port: number; connects: string[]; clientHelloBytes: number; close(): Promise<void> }> {
  const connects: string[] = [];
  const clientSockets = new Set<net.Socket>();
  const upstreams = new Set<net.Socket>();
  let clientHelloBytes = 0; // F-r1-12：destroyAfter200 形态下观测到的隧道内首包（ClientHello）字节数
  const server = http.createServer(() => {});
  server.on('connect', (req, clientSocket) => {
    connects.push(req.url ?? '');
    clientSockets.add(clientSocket);
    clientSocket.on('close', () => clientSockets.delete(clientSocket));
    clientSocket.on('error', () => {});
    if (opts.rejectWithStatus) {
      clientSocket.write(`HTTP/1.1 ${opts.rejectWithStatus} Tunnel Denied\r\n\r\n`);
      clientSocket.destroy();
      return;
    }
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (opts.destroyAfter200) {
      // F-r1-12 TLS 层失败输入：200 已交付（CONNECT 层成功）后才销毁——引擎随即在隧道裸
      // socket 上启动 TLS 握手（ClientHello 经 'data' 观测）→ 200ms 后销毁 → TLSSocket
      // 'error' → ConnectTunnelAgent cb(err)（P1-A 修复引入的 TLS 层失败路径，与
      // rejectWithStatus 的 CONNECT 层失败源区分）。复审 r2 建议：50ms→200ms 放宽防慢机
      // 假红（保证 200 解析 + tls.connect 先行；语义仍为即时失败判别）。
      clientSocket.on('data', (chunk: Buffer) => {
        clientHelloBytes += chunk.length;
      });
      setTimeout(() => clientSocket.destroy(), 200);
      return;
    }
    const upstreamPort = opts.tlsUpstreamPort ?? opts.plainUpstreamPort;
    if (upstreamPort) {
      const upstream = net.connect({ port: upstreamPort, host: '127.0.0.1' }, () => {
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      upstreams.add(upstream);
      upstream.on('close', () => upstreams.delete(upstream));
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => upstream.destroy());
    }
    // 默认 record 形态：不主动 destroy（socket 生命周期随对端断开或 close() 清扫）。
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    connects,
    get clientHelloBytes() {
      return clientHelloBytes;
    },
    close: () => {
      for (const s of upstreams) s.destroy();
      for (const s of clientSockets) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

/**
 * loopback TLS 环回端点：tls.createServer（自签证书）+ http.Server 经 emit('connection') 承载
 * 解密流——handler 只经 TLS 通道可达（无明文监听）。「完成 TLS 握手」与「加密通道收到 HTTP 请求」
 * 两个观测面分开计数。
 */
async function makeTlsLoopbackServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ port: number; handshakes: number; captured: Array<{ path: string | undefined; method: string | undefined; body: string; ua: string | undefined; contentType: string | undefined }>; close(): Promise<void> }> {
  const captured: Array<{ path: string | undefined; method: string | undefined; body: string; ua: string | undefined; contentType: string | undefined }> = [];
  let handshakes = 0;
  const httpApp = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c: string) => {
      data += c;
    });
    req.on('end', () => {
      captured.push({ path: req.url, method: req.method, body: data, ua: req.headers['user-agent'], contentType: req.headers['content-type'] });
      try {
        handler(req, res, data);
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
  });
  const rawSockets = new Set<net.Socket>();
  const server = tls.createServer({ key: P1_TEST_KEY, cert: P1_TEST_CERT }, (socket) => {
    handshakes += 1;
    httpApp.emit('connection', socket);
  });
  server.on('connection', (s) => {
    rawSockets.add(s);
    s.on('close', () => rawSockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    get handshakes() {
      return handshakes;
    },
    captured,
    close: () => {
      for (const s of rawSockets) s.destroy();
      server.closeIdleConnections?.();
      return new Promise((r) => server.close(() => r())).then(() => new Promise<void>((r2) => httpApp.close(() => r2())));
    },
  };
}

// RB-P1-P1A/T1-T3-T5-T10/P1C-T1 载体 re-base 留痕（p7/W4）：原 google-gtx 端点模板/响应夹具
// （gtxEndpoint/gtxResponse，T32 先例形态）随载体换 bing-web 删除——google-gtx 整链剔除
// （00 计划 W4），gtx 形态请求/解析面在本卷零消费；bing 载体夹具 = makeBingHandler（下方）。

/** 假 bing 域名替换夹具：/translator 返回带 IG + params_AbusePrevention 数组形态 + data-iid
 *  （W1 bing 复活 2026-11-22 随动：页面会话三件套解析新增 DOM data-iid 要素，缺之 → bing
 *  确定性失败，载体用例全断——夹具页面按新契约补 #tta_outGDCont data-iid）的页面；
 *  /ttranslatev3 返回 translations 形态 JSON。 */
function makeBingHandler(text: string): (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void {
  return (req, res) => {
    if (req.url?.startsWith('/translator')) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': ['MUID=test-cookie; Path=/', 'SRCHD=test2; Path=/'] });
      res.end('<html><script>var IG="IG-P1TEST-1234";params_AbusePrevention=["4999999999999","tok-p1-test","key-p1-test",0,1]</script><div id="tta_outGDCont" data-iid="translator.5026"></div>ok</html>');
      return;
    }
    if (req.url?.startsWith('/ttranslatev3')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ translations: [{ text }] }]));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  };
}

const SRC = '甲'.repeat(80);

async function main(): Promise<void> {
  const SID = 'sess-p1fix';

  // ════ P1-A：CONNECT 隧道 TLS 修复 ════
  // RB-P1-P1A-T1（p7/W4 载体 re-base）：google-gtx 整链剔除（00 计划 W4 用户裁决），载体换
  // bing-web（域名口径 endpoint 覆盖 + TLS loopback 先例 = P1A-T4/P1B-T7 现成范式）。
  console.log('=== P1A-T1 隧道 TLS：假代理接本地 TLS server，bing-web 经隧道完成 TLS 握手出译文 ===');

  await runCheck('P1A-T1（载体 bing-web）TLS 握手 + 加密通道 HTTP + bing 页面/翻译两请求出译文（裸 socket 交付形态在此必挂）', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeBingHandler('TLS隧道译文'));
    const proxy = await makeConnectProxy({ tlsUpstreamPort: tlsFix.port });
    try {
      const engines = [
        { id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${tlsFix.port}`, useProxy: true },
      ];
      const loaded = loadService({
        config: { translation: { engines } },
        fakeEnv: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` },
        stubTransport: false,
      });
      const r = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'p1a1' }, SRC);
      assert.ok(r.ok, `START 应成功：${r.ok ? '' : r.error}`);
      await waitFor(() => firstStatus(loaded, SID) === 'done', 8000, '隧道 TLS 翻译未完成');
      // keepAlive 隧道（ConnectTunnelAgent super({keepAlive:true})）：同代理同目标的页面 GET 与
      // ttranslatev3 POST 复用同一条隧道 socket → 恰 1 次握手、加密通道上两 HTTP 请求。
      assert.ok(tlsFix.handshakes >= 1, '本地 TLS server 未观测到 TLS 握手（隧道交付裸 socket 形态）');
      // 加密通道上的两请求：页面 GET /translator + 翻译 POST /ttranslatev3（bing 两请求形态）
      assert.ok(tlsFix.captured.some((c) => c.path?.startsWith('/translator')), '加密通道缺页面 GET（隧道 TLS 通道未走通）');
      const v3 = tlsFix.captured.find((c) => c.path?.startsWith('/ttranslatev3'));
      assert.ok(v3, '加密通道缺 ttranslatev3 POST');
      assert.equal(v3?.method, 'POST', 'ttranslatev3 应为 POST');
      assert.ok(v3?.body.includes(encodeURIComponent(SRC)), '加密通道请求 body 缺 segment');
      const st = loaded.mod.getTranslationStates(SID)[0];
      assert.ok(st?.segments[0]?.translated === 'TLS隧道译文', `译文不符：${st?.segments[0]?.translated}`);
      assert.ok(!loaded.pushes.some((p) => p.payload.kind === 'error'), '成功路径不得推送 error');
    } finally {
      await proxy.close();
      await tlsFix.close();
    }
  });

  // RB-P1-P1A-T2（p7/W4 载体 re-base）：受害者换 bing-web（useProxy=true、出厂域 cn.bing.com →
  // CONNECT 目标 = cn.bing.com:443 捕获）；接管面按清单语义为「loopback 接管出译文」——alibaba/
  // qq/sogou/youdao 均为固定多主机协议不消费 endpoint（评审 P1-5），真实传输路径下唯一可指向
  // loopback 的存活引擎是 bing-web（域名口径 endpoint），故接管条目用第二个 bing-web（loopback
  // TLS 域名替换）。与清单字面（alibaba 接管）的偏差在此申报，降级语义本身不变。
  await runCheck('P1A-T2（载体 bing-web）假代理 CONNECT 500：bing 尝试确实发生（CONNECT 目标 = cn.bing.com:443）且失败、组降级 loopback bing 接管、done、无 error 推送', async () => {
    const proxy500 = await makeConnectProxy({ rejectWithStatus: 500 });
    const tlsFix = await makeTlsLoopbackServer(makeBingHandler('隧道降级译文'));
    try {
      const engines = [
        { id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, useProxy: true },
        { id: 'bing-loopback', kind: 'bing-web', enabled: true, order: 1, endpoint: `127.0.0.1:${tlsFix.port}` },
      ];
      const loaded = loadService({
        config: { translation: { engines } },
        fakeEnv: { HTTPS_PROXY: `http://127.0.0.1:${proxy500.port}` },
        stubTransport: false,
      });
      const r = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'p1a2' }, SRC);
      assert.ok(r.ok);
      await waitFor(() => firstStatus(loaded, SID) === 'done', 15000, '隧道失败降级未完成');
      // bing 尝试确实发生：假代理捕获 CONNECT 且目标 = 出厂域字面（隧道失败输入下 T26 口径保持；
      // bing 页面抓取失败重抓一次 → 恰 2 次 CONNECT，均指向出厂域）。
      assert.equal(proxy500.connects.length, 2, `bing CONNECT 次数异常（页面抓取 + 失效重抓一次）：${proxy500.connects.join(',')}`);
      assert.ok(proxy500.connects.every((c) => c === 'cn.bing.com:443'), `CONNECT 目标不符（应为出厂域 cn.bing.com:443）：${proxy500.connects.join(',')}`);
      // loopback bing 接管（直连，不经代理；keepAlive 默认 agent 下页面+翻译两请求复用同一条环回连接）
      assert.ok(tlsFix.handshakes >= 1, 'loopback bing 环回 TLS 未握手');
      assert.ok(tlsFix.captured.some((c) => c.path?.startsWith('/translator')), 'bing 页面 GET 未到达环回');
      assert.ok(tlsFix.captured.some((c) => c.path?.startsWith('/ttranslatev3')), 'bing ttranslatev3 POST 未到达环回');
      const st = loaded.mod.getTranslationStates(SID)[0];
      assert.ok(st?.segments[0]?.translated === '隧道降级译文', `降级接管译文不符：${st?.segments[0]?.translated}`);
      assert.ok(!loaded.pushes.some((p) => p.payload.kind === 'error'), '降级吸收后不得呈现 error 推送');
    } finally {
      await proxy500.close();
      await tlsFix.close();
    }
  });

  // F-r1-12 收口钉。绿态断言 + 验证手法注释（申报约束豁免先红后绿：抓目标分支需在 src 上
  // 回退 P1-A 才能红，违反「除两卷外不改任何文件」约束；审查岗已实证该分支行为）。
  // 抓取面：若 ConnectTunnelAgent 的 tlsSocket 'error' → cb(err) 交付（translation-engines.ts
  // TLS 失败路径）回退为挂起/吞错，bing 尝试不会以失败形态结束 → waitFor 超时或进程崩溃红。
  await runCheck('P1A-T2b（F-r1-12，载体 bing-web）CONNECT 200 后隧道 socket 即毁（TLS 层失败源）：bing 进隧道握手后 network 失败、组降级 loopback bing、无未捕获异常', async () => {
    const uncaught: string[] = [];
    const onUncaught = (e: unknown): void => {
      uncaught.push(e instanceof Error ? e.message : String(e));
    };
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);
    const proxyKill = await makeConnectProxy({ destroyAfter200: true });
    const tlsFix = await makeTlsLoopbackServer(makeBingHandler('TLS层降级译文'));
    try {
      const engines = [
        { id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, useProxy: true },
        { id: 'bing-loopback', kind: 'bing-web', enabled: true, order: 1, endpoint: `127.0.0.1:${tlsFix.port}` },
      ];
      const loaded = loadService({
        config: { translation: { engines } },
        fakeEnv: { HTTPS_PROXY: `http://127.0.0.1:${proxyKill.port}` },
        stubTransport: false,
      });
      const t0 = Date.now();
      const r = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'p1a2b' }, SRC);
      assert.ok(r.ok);
      await waitFor(() => firstStatus(loaded, SID) === 'done', 15000, 'TLS 层失败降级未完成');
      // 失败即时性判别：分支闭合时错误经 TLSSocket 'error' → cb(err) 即刻交付（夹具 200ms 毁
      // socket——复审 r2 建议：放宽防慢机假红；语义仍为即时失败判别）→ 全程远小于引擎 try
      // deadline（10s）；若该分支回退为挂起/吞错，bing 尝试只能靠 10s deadline 兜底 →
      // elapsed 落入 ≥10s 量级 → 本断言红。（bing 页面抓取失败重抓一次 → 两轮隧道 TLS 尝试，
      // 每轮 ≈ 200ms，总耗时仍远小于 8s。）
      assert.ok(Date.now() - t0 < 8000, `bing 失败未即时交付（elapsed=${Date.now() - t0}ms ≥ 8s 量级，疑 tlsSocket error 分支未闭合、靠 deadline 兜底）`);
      assert.equal(proxyKill.connects.length, 2, `bing CONNECT 次数异常（页面抓取 + 失效重抓一次）：${proxyKill.connects.join(',')}`);
      assert.ok(proxyKill.connects.every((c) => c === 'cn.bing.com:443'), `CONNECT 目标不符（应为出厂域 cn.bing.com:443）：${proxyKill.connects.join(',')}`);
      // 失败源 = TLS 层：引擎已在隧道内启动 TLS 握手（代理观测到 ClientHello 字节），随后才被毁
      assert.ok(proxyKill.clientHelloBytes > 0, '代理未观测到隧道内 ClientHello（引擎未进入 TLS 握手，失败源非 TLS 层）');
      // bing 以 network 失败形态结束（隧道内无任何 TLS 应答 + socket 被毁，成功不可能）→ loopback bing 接管
      // （keepAlive 默认 agent 下页面+翻译两请求复用同一条环回连接 → 恰 1 次握手）
      assert.ok(tlsFix.handshakes >= 1, 'loopback bing 环回 TLS 未握手');
      assert.ok(tlsFix.captured.some((c) => c.path?.startsWith('/translator')), 'bing 页面 GET 未到达环回');
      assert.ok(tlsFix.captured.some((c) => c.path?.startsWith('/ttranslatev3')), 'bing ttranslatev3 POST 未到达环回');
      const st = loaded.mod.getTranslationStates(SID)[0];
      assert.ok(st?.segments[0]?.translated === 'TLS层降级译文', `降级接管译文不符：${st?.segments[0]?.translated}`);
      assert.ok(!loaded.pushes.some((p) => p.payload.kind === 'error'), '降级吸收后不得呈现 error 推送');
      assert.deepEqual(uncaught, [], `TLS 失败路径产生未捕获异常/未处置拒绝：${uncaught.join(' | ')}`);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      process.removeListener('unhandledRejection', onUncaught);
      await proxyKill.close();
      await tlsFix.close();
    }
  });

  await runCheck('P1A-T3（载体 bing-web）env 全空 + resolveProxy DIRECT + 哨兵代理在场：直连命中 loopback TLS、哨兵零 CONNECT', async () => {
    const sentinel = await makeConnectProxy({});
    const tlsFix = await makeTlsLoopbackServer(makeBingHandler('直连译文'));
    try {
      const engines = [
        { id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${tlsFix.port}`, useProxy: true },
      ];
      const loaded = loadService({
        config: { translation: { engines } },
        fakeEnv: {},
        electronProxyAnswer: 'DIRECT',
        stubTransport: false,
      });
      const resolved = await loaded.enginesMod.resolveOutboundProxy(true);
      assert.equal(resolved, null, 'env 全空 + DIRECT 时 resolveOutboundProxy(true) 应为 null');
      const r = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'p1a3' }, SRC);
      assert.ok(r.ok);
      await waitFor(() => firstStatus(loaded, SID) === 'done', 8000, '直连翻译未完成');
      assert.ok(tlsFix.captured.length >= 1, '请求未直连命中 loopback 端点');
      assert.equal(sentinel.connects.length, 0, `哨兵代理捕获到 CONNECT（不应走代理）：${sentinel.connects.join(',')}`);
      const st = loaded.mod.getTranslationStates(SID)[0];
      assert.ok(st?.segments[0]?.translated === '直连译文', `直连译文不符：${st?.segments[0]?.translated}`);
    } finally {
      await sentinel.close();
      await tlsFix.close();
    }
  });

  await runCheck('P1A-T4 env 指哨兵 + bing(useProxy=false)：bing 照常成功、哨兵零 CONNECT、resolveOutboundProxy(false) 恒 null', async () => {
    const sentinel = await makeConnectProxy({});
    const tlsFix = await makeTlsLoopbackServer(makeBingHandler('直连必应译文'));
    try {
      const engines = [
        { id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${tlsFix.port}` },
      ];
      const loaded = loadService({
        config: { translation: { engines } },
        fakeEnv: { HTTPS_PROXY: `http://127.0.0.1:${sentinel.port}` },
        stubTransport: false,
      });
      assert.equal(await loaded.enginesMod.resolveOutboundProxy(false), null, 'useProxy=false 恒 null');
      assert.equal(await loaded.enginesMod.resolveOutboundProxy(false, 'http://127.0.0.1:9'), null, 'useProxy=false 即使显式代理在场也恒 null');
      const r = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'p1a4' }, SRC);
      assert.ok(r.ok);
      await waitFor(() => firstStatus(loaded, SID) === 'done', 10000, 'useProxy=false bing 翻译未完成');
      assert.equal(sentinel.connects.length, 0, `非 useProxy 引擎走了代理（哨兵捕获 ${sentinel.connects.length}）`);
      const st = loaded.mod.getTranslationStates(SID)[0];
      assert.ok(st?.segments[0]?.translated === '直连必应译文', `bing 译文不符：${st?.segments[0]?.translated}`);
    } finally {
      await sentinel.close();
      await tlsFix.close();
    }
  });

  await runCheck('P1A-T5（载体 bing-web）同实例 A→B 代理切换：A 侧 CONNECT 冻结、B 侧捕获新 CONNECT（差分形态保持）', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeBingHandler('差分译文'));
    const proxyA = await makeConnectProxy({ tlsUpstreamPort: tlsFix.port });
    const proxyB = await makeConnectProxy({ tlsUpstreamPort: tlsFix.port });
    try {
      const engines = [
        { id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${tlsFix.port}`, useProxy: true },
      ];
      const loaded = loadService({
        config: { translation: { engines } },
        fakeEnv: { HTTPS_PROXY: `http://127.0.0.1:${proxyA.port}` },
        stubTransport: false,
      });
      // 两次出站用不同源文本（同会话段缓存按 segHash 命中会让第二次零请求，差分失效）
      const srcA = '甲'.repeat(80);
      const srcB = '乙'.repeat(80);
      const r1 = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'p1a5a' }, srcA);
      assert.ok(r1.ok);
      await waitFor(() => firstStatus(loaded, SID) === 'done', 8000, 'A 代理出站未完成');
      // keepAlive 隧道：首次出站的页面 GET 与 ttranslatev3 POST 复用同一条隧道 socket → A 侧 1 次 CONNECT
      assert.equal(proxyA.connects.length, 1, 'A 代理首次出站 CONNECT 计数 ≠ 1（keepAlive 隧道复用）');
      // env 改指 B，同实例再次出站（新 entry + 新文本；bing 会话缓存命中 → 仅 ttranslatev3 一请求）
      loaded.fakeEnv.HTTPS_PROXY = `http://127.0.0.1:${proxyB.port}`;
      const r2 = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'p1a5b' }, srcB);
      assert.ok(r2.ok);
      await waitFor(() => tlsFix.captured.length >= 3, 8000, 'B 代理出站未完成（环回请求数未增）');
      assert.equal(proxyB.connects.length, 1, 'B 代理未捕获新 CONNECT（新代理新 agent 新隧道）');
      assert.equal(proxyA.connects.length, 1, `切换后 A 侧计数漂移（A 未冻结）：${proxyA.connects.length}`);
      assert.ok(tlsFix.captured.filter((c) => c.path?.startsWith('/translator')).length === 1, '页面 GET 次数异常（会话缓存应恰抓一次）');
      assert.equal(tlsFix.captured.filter((c) => c.path?.startsWith('/ttranslatev3')).length, 2, 'ttranslatev3 请求数异常（两次独立出站各一次）');
    } finally {
      await proxyA.close();
      await proxyB.close();
      await tlsFix.close();
    }
  });

  // F-r1-13 收口钉：非 https 直通分支（ConnectTunnelAgent.createConnection 的
  // `protocol!=='https:' 且 port≠443 → cb(null, 裸 socket)`）此前零用例。
  //
  // ⚠️ 形态声明（与修复指令的偏差，报告同步留痕）：指令原文要求「custom-template 引擎级
  // 端点为 loopback http + useProxy=true → 经隧道出译文」——该引擎级形态在本机 Node 22.16.0
  // 实测不可达：http.request 携带 https.Agent（ConnectTunnelAgent 基类 protocol='https:'）时
  // Node 在调用 agent.createConnection 之前同步抛
  // `TypeError [ERR_INVALID_PROTOCOL]: Protocol "http:" not supported. Expected "https:"`
  // （独立探针：原生 https.Agent 与带 createConnection override 的子类均同步抛；卷内首跑
  // 实证 connects=[]、引擎以 network 失败降级）。直通分支对 httpRequest（唯一 agent 消费入口）
  // 是死分支——src 侧问题超出本卷授权（除两卷外不得改任何文件），已在报告申报节升级为
  // 新发现待审查岗裁定。
  // 故本用例改为「分支级钉」：经 createTunnelAgent()（既有契约卷导出面）直调
  // createConnection({protocol:'http:'})——这正是指令要覆盖的分支本体——断言裸 socket 交付 +
  // 明文 HTTP 经隧道直通命中 loopback 端点。绿态断言 + 注释标注验证手法（申报约束豁免红验；
  // 若分支被回退成一律 TLS 包裹/不交付 → 交付超时或 TLSSocket 断言红）。
  await runCheck('P1A-T6（F-r1-13）非 https 直通分支（分支级钉）：createConnection({protocol:"http:"}) 交付裸 socket、明文 HTTP 经隧道直通命中 loopback', async () => {
    const srv = await makeLoopbackServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { text: '直通译文' } }));
    });
    const proxy = await makeConnectProxy({ plainUpstreamPort: srv.port });
    try {
      const loaded = loadService({ fakeEnv: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` } });
      const resolved = await loaded.enginesMod.resolveOutboundProxy(true);
      assert.ok(resolved, 'env 代理未解析');
      const agent = loaded.enginesMod.createTunnelAgent(resolved.href);
      const delivered = await new Promise<{ err: Error | null; socket: unknown }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('createConnection 未在 5s 内交付（分支未生效或挂起）')), 5000);
        agent.createConnection(
          { host: '127.0.0.1', port: srv.port, protocol: 'http:', servername: '127.0.0.1' },
          (err, socket) => {
            clearTimeout(timer);
            resolve({ err, socket });
          },
        );
      });
      assert.equal(delivered.err, null, `直通分支应交付成功而非报错：${delivered.err}`);
      assert.ok(delivered.socket, '直通分支未交付 socket');
      // 裸 socket 形态判定：net.Socket 且非 TLSSocket（若分支被回退成一律 TLS 包裹 → 红）
      assert.ok(delivered.socket instanceof net.Socket, '交付物不是裸 net.Socket');
      assert.ok(!(delivered.socket instanceof tls.TLSSocket), '直通分支交付了 TLSSocket（裸 socket 直通语义被破坏）');
      // 明文 HTTP 经隧道直通：在交付 socket 上手写 GET → 响应含 loopback 端点的译文 body
      const resp = await new Promise<string>((resolve, reject) => {
        const s = delivered.socket as net.Socket;
        let acc = '';
        s.on('data', (c: Buffer) => {
          acc += c.toString('utf8');
        });
        s.on('error', (e: Error) => reject(e));
        s.on('close', () => resolve(acc));
        s.write(`GET /get?q=ping HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nConnection: close\r\n\r\n`);
        setTimeout(() => reject(new Error('直通请求 5s 未完成（隧道未把明文请求送达端点）')), 5000);
      });
      assert.ok(resp.includes('HTTP/1.1 200'), `直通响应形态异常：${resp.slice(0, 120)}`);
      assert.ok(resp.includes('直通译文'), `直通 body 缺译文（端点未命中）：${resp.slice(0, 200)}`);
      // 指令断言面：假代理捕获 CONNECT 计数=1 且目标 = loopback 端点坐标；端点确实命中
      assert.deepEqual(proxy.connects, [`127.0.0.1:${srv.port}`], `CONNECT 未发生或目标不符：${proxy.connects.join(',')}`);
      assert.equal(srv.captured.length, 1, `loopback 端点请求数异常：${srv.captured.length}`);
      assert.equal(srv.captured[0]?.path, '/get?q=ping', `直通请求路径不符：${srv.captured[0]?.path}`);
    } finally {
      await proxy.close();
      await srv.close();
    }
  });

  // ════ P1-B：翻译专用代理地址配置 ════
  console.log('=== P1B 代理地址配置：config 显式代理优先级/非法值/落盘透传/UI 静态钉 ===');

  await runCheck('P1B-T1 config 显式代理赢过 env；删 config 才回落 env', async () => {
    const loaded = loadService({ fakeEnv: { HTTPS_PROXY: 'http://127.0.0.1:10002' } });
    const p1 = await loaded.enginesMod.resolveOutboundProxy(true, 'http://127.0.0.1:10001');
    assert.ok(p1?.href.includes('127.0.0.1:10001'), `config 显式代理未赢：${p1?.href}`);
    // 单独删 config（第二参缺省/undefined）→ 同输入下回落 env
    const p2 = await loaded.enginesMod.resolveOutboundProxy(true);
    assert.ok(p2?.href.includes('127.0.0.1:10002'), `删 config 后未回落 env：${p2?.href}`);
    const p3 = await loaded.enginesMod.resolveOutboundProxy(true, undefined);
    assert.ok(p3?.href.includes('127.0.0.1:10002'), `显式 undefined 未回落 env：${p3?.href}`);
    // null 同口径（签名允许 null）
    const p4 = await loaded.enginesMod.resolveOutboundProxy(true, null);
    assert.ok(p4?.href.includes('127.0.0.1:10002'), `null 未回落 env：${p4?.href}`);
  });

  await runCheck('P1B-T2 config 空/缺省 + env 四级逐级切换：HTTPS_PROXY > https_proxy > HTTP_PROXY > all_proxy', async () => {
    const loaded = loadService({ fakeEnv: {}, electronProxyAnswer: 'PROXY 10.9.8.7:7890' });
    // config 代理空串形态：等同未配置（不遮蔽 env）
    loaded.fakeEnv.HTTPS_PROXY = 'http://127.0.0.1:10001';
    let p = await loaded.enginesMod.resolveOutboundProxy(true, '');
    assert.ok(p?.href.includes('127.0.0.1:10001'), `空串 config 未按未配置处理：${p?.href}`);
    delete loaded.fakeEnv.HTTPS_PROXY;
    loaded.fakeEnv.https_proxy = 'http://127.0.0.1:10002';
    p = await loaded.enginesMod.resolveOutboundProxy(true, undefined);
    assert.ok(p?.href.includes('127.0.0.1:10002'), 'https_proxy 次级未生效');
    delete loaded.fakeEnv.https_proxy;
    loaded.fakeEnv.HTTP_PROXY = 'http://127.0.0.1:10003';
    p = await loaded.enginesMod.resolveOutboundProxy(true, undefined);
    assert.ok(p?.href.includes('127.0.0.1:10003'), 'HTTP_PROXY 第三级未生效');
    delete loaded.fakeEnv.HTTP_PROXY;
    loaded.fakeEnv.all_proxy = 'http://127.0.0.1:10004';
    p = await loaded.enginesMod.resolveOutboundProxy(true, undefined);
    assert.ok(p?.href.includes('127.0.0.1:10004'), 'all_proxy 兜底未生效');
    delete loaded.fakeEnv.all_proxy;
    p = await loaded.enginesMod.resolveOutboundProxy(true, undefined);
    assert.ok(p?.href.includes('10.9.8.7:7890'), `env 全缺未回落 resolveProxy：${p?.href}`);
  });

  await runCheck('P1B-T3 config 空 + env 全空 + resolveProxy PROXY/DIRECT 差分', async () => {
    const loaded = loadService({ fakeEnv: {}, electronProxyAnswer: 'PROXY 10.9.8.7:7890' });
    const p = await loaded.enginesMod.resolveOutboundProxy(true, undefined);
    assert.ok(p?.href.includes('10.9.8.7:7890'), `resolveProxy PROXY 未生效：${p?.href}`);
    const direct = loadService({ fakeEnv: {}, electronProxyAnswer: 'DIRECT' });
    assert.equal(await direct.enginesMod.resolveOutboundProxy(true, undefined), null, 'resolveProxy DIRECT 未按直连处理');
  });

  await runCheck('P1B-T4 删字段后形态（translation 节无 proxyUrl 键）+ env 空 + DIRECT：resolveOutboundProxy(true, undefined)=null', async () => {
    const loaded = loadService({
      config: { translation: { engines: seedEngines() } }, // 无 proxyUrl 键
      fakeEnv: {},
      electronProxyAnswer: 'DIRECT',
    });
    const p = await loaded.enginesMod.resolveOutboundProxy(true, undefined);
    assert.equal(p, null, '老配置形态不得产生代理');
    assert.equal(await loaded.enginesMod.resolveOutboundProxy(false, undefined), null, 'useProxy=false 恒 null');
  });

  await runCheck('P1B-T5 config 代理非法值（not a url / http:// / 纯空白）：等同未配置、不抛异常、env 照常生效', async () => {
    const loaded = loadService({ fakeEnv: { HTTPS_PROXY: 'http://127.0.0.1:10002' } });
    for (const invalid of ['not a url', 'http://', '   ']) {
      const p = await loaded.enginesMod.resolveOutboundProxy(true, invalid);
      assert.ok(p?.href.includes('127.0.0.1:10002'), `非法值「${invalid}」未按未配置降级到 env：${p?.href}`);
    }
    // env 也全空（DIRECT）时：非法值不抛异常、解析为 null
    const direct = loadService({ fakeEnv: {}, electronProxyAnswer: 'DIRECT' });
    for (const invalid of ['not a url', 'http://', '   ']) {
      const p = await direct.enginesMod.resolveOutboundProxy(true, invalid);
      assert.equal(p, null, `非法值「${invalid}」在无 env 时不为 null（异常阻断链）`);
    }
  });

  await runCheck('P1B-T6 存量 proxyUrl 键经 probeEngines(true) 落盘：保存链不拒绝且落盘载荷无 proxyUrl 键（RB-P1-P1B-T6 p8 翻转）', async () => {
    const loaded = loadService({
      config: { translation: { engines: seedEngines(), proxyUrl: 'not a url' } },
      stubTransport: true,
    });
    const probe = await loaded.mod.probeEngines(true);
    assert.ok(probe.ok, 'probeEngines 对存量 proxyUrl 配置应照常成功');
    // RB-P1-P1B-T6（p8/W4 P1-B 代理面回撤）：translation.proxyUrl 字段删除——apply 落盘载荷
    // 无 proxyUrl 键（原「透传」断言翻转；存量键经 sanitize 读路径剥离，无需 migration）。
    assert.ok(probe.engines.length >= 5, '探测行数异常');
    const patch = loaded.saveCalls.find((p) => 'translation' in p) as { translation?: { proxyUrl?: string; engines?: unknown[] } } | undefined;
    assert.ok(patch?.translation, 'apply 未走 saveConfig 落盘');
    assert.ok(patch.translation && !('proxyUrl' in patch.translation), 'apply 落盘载荷出现 proxyUrl 键（字段已删，透传面必须拆除）');
    assert.ok(Array.isArray(patch?.translation?.engines) && (patch?.translation?.engines?.length ?? 0) === 5, 'engines 重排落盘形态被破坏');
  });

  await runCheck('P1B-T7（p8 重整）translation 节无 proxyUrl 键 + 哨兵仅作位置实参：useProxy=false 恒 null、bing 直连成功、哨兵零 CONNECT', async () => {
    // RB-P1-P1B-T7 留痕（p8/W4 P1-B 代理面回撤）：原「config 代理哨兵在场」前提整链删除
    // （字段已删，夹具不再带 proxyUrl 键）；useProxy=false 恒 null 机械语义改由哨兵地址作
    // resolveOutboundProxy(false, …) 位置实参承载（休眠机械面第二参签名保留）。
    const sentinel = await makeConnectProxy({});
    const tlsFix = await makeTlsLoopbackServer(makeBingHandler('配置代理直连译文'));
    try {
      const engines = [
        { id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${tlsFix.port}` },
      ];
      const loaded = loadService({
        config: { translation: { engines } }, // 无 proxyUrl 键（字段删除后形态）
        fakeEnv: {},
        stubTransport: false,
      });
      assert.equal(
        await loaded.enginesMod.resolveOutboundProxy(false, `http://127.0.0.1:${sentinel.port}`),
        null,
        'useProxy=false 即使显式地址作位置实参在场也恒 null',
      );
      const r = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'p1b7' }, SRC);
      assert.ok(r.ok);
      await waitFor(() => firstStatus(loaded, SID) === 'done', 10000, 'bing 翻译未完成（直连形态）');
      assert.equal(sentinel.connects.length, 0, `哨兵捕获到出站（useProxy=false 直连形态被破坏：${sentinel.connects.length}）`);
      const st = loaded.mod.getTranslationStates(SID)[0];
      assert.ok(st?.segments[0]?.translated === '配置代理直连译文', `bing 译文不符：${st?.segments[0]?.translated}`);
    } finally {
      await sentinel.close();
      await tlsFix.close();
    }
  });

  await runCheck('P1B-T8（p8 翻转）不存在钉：ConfigPage「代理地址」输入整链拆除——trProxyUrl/v-model/标签占位文案/写入字面/.tr-proxy-field 全部零命中，无新增 IPC 通道', () => {
    // RB-P1-P1B-T8（p8/W4 P1-B 代理面回撤）：原「代理输入在位钉」逐字面翻转为不存在钉。
    for (const literal of [
      'const trProxyUrl = computed<string>',
      'v-model="trProxyUrl"',
      '代理地址（可选，仅对勾选「代理」的引擎生效）',
      'placeholder="http://127.0.0.1:7890（留空 = 自动发现）"',
      'delete t.proxyUrl',
      't.proxyUrl = trimmed',
      'class="field tr-proxy-field"',
      'tr-proxy-field',
      'trProxyUrl',
      'proxyUrl',
    ] as const) {
      assert.ok(!configPageSrc.includes(literal), `ConfigPage 代理面残留字面（p8 应删未删）：${literal}`);
    }
    // 持久化：translation 节仍随该 Tab 既有自动保存链（PERSISTED_FIELDS 数组块含 'translation'），
    // 无独立保存按钮/IPC 通道。块解析定位（p8 随动申报：原 [\s\S]{0,400} 距离窗被批外交织条目
    // （skillOverrides/webAccess 注释块）撑破——'translation' 距声明 779 字符，p7 基线绿跑后
    // 被撑破，非本点引入；语义 = translation ∈ PERSISTED_FIELDS 块，窗口化改块化定位更稳）。
    const pfStart = configPageSrc.indexOf('const PERSISTED_FIELDS');
    const pfBlock = pfStart >= 0 ? configPageSrc.slice(pfStart, configPageSrc.indexOf('] as const', pfStart)) : '';
    assert.ok(pfBlock.includes("'translation'"), 'translation 不在自动保存链 PERSISTED_FIELDS 内');
    for (const [name, src] of [['ipc.ts', ipcConst], ['preload/api.ts', preloadApi], ['web-bridge.ts', webBridge]] as const) {
      assert.ok(!/TRANSLATE_[A-Z_]*PROXY/.test(src), `${name} 出现代理专用 IPC 通道（违例：应走既有整节自动保存）`);
    }
  });

  await runCheck('P1B-T10（p8 翻转，载体 bing-web）行为级接线：env HTTPS_PROXY 经 buildEngine → 隧道 agent → TLS 环回观测（config.proxyUrl 接线字面零命中）', async () => {
    // RB-P1-P1B-T10（p8/W4 P1-B 代理面回撤改写）：原「config 显式代理 → 闭包第二参」前提删除
    // （translation.proxyUrl 字段/闭包传参已删）；env→agent→TLS 机械活体改由 env HTTPS_PROXY
    // 载体承载（env 链语义 = P1A-T1 同源；本用例加钉 config.proxyUrl 接线字面零命中）。
    const tlsFix = await makeTlsLoopbackServer(makeBingHandler('配置代理隧道译文'));
    const proxy = await makeConnectProxy({ tlsUpstreamPort: tlsFix.port });
    try {
      const engines = [
        { id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${tlsFix.port}`, useProxy: true },
      ];
      const loaded = loadService({
        config: { translation: { engines } },
        fakeEnv: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` },
        electronProxyAnswer: 'DIRECT',
        stubTransport: false,
      });
      const r = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'p1b10' }, SRC);
      assert.ok(r.ok);
      await waitFor(() => firstStatus(loaded, SID) === 'done', 8000, 'env 显式代理隧道翻译未完成');
      // keepAlive 隧道：页面 GET 与 ttranslatev3 POST 复用同一条 env 代理隧道 socket（1 次 CONNECT）
      assert.equal(proxy.connects.length, 1, `env 显式代理未被隧道消费：${proxy.connects.join(',')}`);
      assert.ok(tlsFix.handshakes >= 1, 'env 显式代理路径未完成 TLS 握手');
      const st = loaded.mod.getTranslationStates(SID)[0];
      assert.ok(st?.segments[0]?.translated === '配置代理隧道译文', `译文不符：${st?.segments[0]?.translated}`);
      // RB-P1-P1B-T10 结构半边：config.proxyUrl 闭包接线字面零命中（传参已删；休眠机械面
      // resolveOutboundProxy 第二参签名保留，显式值改由测试/将来引擎恢复消费时直传）。
      assert.ok(!/resolveOutboundProxy\(true,\s*config\.proxyUrl\)/.test(enginesSrc), 'engines 残留 config.proxyUrl 闭包接线字面（p8 应删未删）');
      assert.ok(!enginesSrc.includes('config.proxyUrl'), 'engines 残留 config.proxyUrl 字面');
    } finally {
      await proxy.close();
      await tlsFix.close();
    }
  });

  // ════ P1-C：引擎 HTTP 统一浏览器 UA ════
  console.log('=== P1C 统一浏览器 UA：行为捕获 + 源码钉 + spawn 门 ===');

  await runCheck('P1C-T1（载体 bing-web，RB-P1-P1C-T1 p7/W4）loopback TLS 捕获 bing 两请求头：User-Agent = 统一 UA 字面', async () => {
    const tlsFix = await makeTlsLoopbackServer(makeBingHandler('UA捕获译文'));
    try {
      const engines = [
        { id: 'bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: `127.0.0.1:${tlsFix.port}`, useProxy: false },
      ];
      const loaded = loadService({ config: { translation: { engines } }, stubTransport: false });
      const r = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'p1c1' }, SRC);
      assert.ok(r.ok);
      await waitFor(() => firstStatus(loaded, SID) === 'done', 8000, 'UA 捕获翻译未完成');
      assert.equal(tlsFix.captured.length, 2, `环回请求数异常（页面+翻译两请求）：${tlsFix.captured.length}`);
      const page = tlsFix.captured.find((c) => c.path?.startsWith('/translator'));
      const v3 = tlsFix.captured.find((c) => c.path?.startsWith('/ttranslatev3'));
      assert.ok(page && v3, '环回两请求形态异常（缺页面 GET 或翻译 POST）');
      assert.equal(page.ua, BROWSER_UA_LITERAL, `bing 页面请求 UA 不符：${page.ua}`);
      assert.equal(v3.ua, BROWSER_UA_LITERAL, `bing 翻译请求 UA 不符：${v3.ua}`);
      assert.ok(v3.contentType?.includes('application/x-www-form-urlencoded'), '既有 Content-Type 头被 UA 注入破坏');
    } finally {
      await tlsFix.close();
    }
  });

  await runCheck('P1C-T2 静态钉：BROWSER_UA 常量字面在位、BING_UA 清零、httpRequest 展开序保用户头、全引擎经 httpRequest', () => {
    assert.ok(
      enginesSrc.includes(`const BROWSER_UA = '${BROWSER_UA_LITERAL}'`),
      'translation-engines.ts 缺 BROWSER_UA 统一 UA 常量（字面须与裁决一致）',
    );
    assert.ok(!enginesSrc.includes('BING_UA'), '旧常量名 BING_UA 残留（R5 裁决更名 BROWSER_UA）');
    // httpRequest 展开序：默认 UA 在前、init.headers 在后（用户显式 UA/自定义模板 headers 不被覆盖）
    assert.match(
      enginesSrc,
      /\{\s*'User-Agent': BROWSER_UA,\s*\.\.\.init\.headers,\s*'Content-Length':/,
      'httpRequest 有 body 分支缺「默认 UA 在前 + init.headers 在后」展开序',
    );
    assert.match(
      enginesSrc,
      /:\s*\{\s*'User-Agent': BROWSER_UA,\s*\.\.\.init\.headers\s*\}/,
      'httpRequest 无 body 分支缺「默认 UA 在前 + init.headers 在后」展开序',
    );
    // bing 两请求上下文一致（fetchBingToken 与 bingOneChunk 均引用统一常量）
    const uaRefs = enginesSrc.match(/'User-Agent': BROWSER_UA/g) ?? [];
    assert.ok(uaRefs.length >= 3, `bing 显式 UA 引用数异常（fetchBingToken + bingOneChunk ≥ 2）：${uaRefs.length}`);
    // 全引擎唯一 HTTP 出口：bing/alibaba/qq/sogou/youdao 五适配器全部经 httpRequest
    // （p7/W4 re-base：google/baidu 删除后 15 个调用点；RB-P1-P1C-T2 调用点计数随适配器集合重定标）
    const callSites = enginesSrc.match(/await httpRequest\(/g) ?? [];
    assert.ok(callSites.length >= 15, `httpRequest 调用点数异常（全引擎唯一 HTTP 出口被旁路）：${callSites.length}`);
    assert.ok(!/fetch\s*\(\s*['"`]https?:/.test(enginesSrc), '出现 fetch 直连旁路（绕过 httpRequest）');
  });

  await runCheck('P1C-T3 spawn 门：tdd-translation-core-verify.ts exit 0（含 MOD-P1B-1 sanitize 扩钉）', () => {
    let status: number | null = null;
    let tail = '';
    for (let run = 1; run <= 3; run++) {
      const r = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/tdd-translation-core-verify.ts'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      status = r.status;
      tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-300).trim();
      if (status === 0) break;
    }
    assert.equal(status, 0, `退出码 ${status}\n${tail}`);
  });

  await runCheck('P1C-T3b spawn 门：tdd-message-translate-verify.ts exit 0（含 MOD-P1A-1 夹具升级）', () => {
    let status: number | null = null;
    let tail = '';
    for (let run = 1; run <= 3; run++) {
      const r = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/tdd-message-translate-verify.ts'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      status = r.status;
      tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-300).trim();
      if (status === 0) break;
    }
    assert.equal(status, 0, `退出码 ${status}\n${tail}`);
  });

  // RB-P1-P1C-T4（p7 收口，载体随 W5/W4 死亡改写）：custom-template（W5 p6 删）与 google-gtx
  // （W4 p7 删）两载体均已整链移除 → 载体换存活引擎 alibaba-web：三步协议（预热/csrf/翻译）
  // 适配器不显式传 User-Agent（httpRequest 默认 UA 注入路径），经 httpsShim 定向重写把出厂域
  // translate.alibaba.com 请求打进环回 TLS 端点（零外网出站）后捕获三请求 UA。
  await runCheck('P1C-T4（载体 alibaba-web）无显式 UA 头的引擎请求：三步协议各请求仍含统一 UA 默认注入 + multipart Content-Type 不被破坏', async () => {
    const tlsFix = await makeTlsLoopbackServer((req, res) => {
      if (req.url === '/' || req.url === '') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': ['JID=p1test; Path=/'] });
        res.end('ok');
        return;
      }
      if (req.url?.startsWith('/api/translate/csrftoken')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ headerName: 'x-csrf-token', token: 'tok-p1c4' }));
        return;
      }
      if (req.url?.startsWith('/api/translate/text')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { translateText: '模板UA译文' } }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    alibabaRedirectPort = tlsFix.port;
    try {
      const engines = [
        { id: 'alibaba-web', kind: 'alibaba-web', enabled: true, order: 0 },
      ];
      const loaded = loadService({ config: { translation: { engines } }, stubTransport: false });
      const r = await loaded.mod.startTranslation(SID, { kind: 'message', messageId: 'p1c4' }, SRC);
      assert.ok(r.ok);
      await waitFor(() => firstStatus(loaded, SID) === 'done', 8000, 'alibaba UA 捕获翻译未完成');
      assert.equal(tlsFix.captured.length, 3, `环回请求数异常（预热+csrf+翻译三步）：${tlsFix.captured.length}`);
      const [warm, csrf, post] = tlsFix.captured;
      assert.equal(warm?.ua, BROWSER_UA_LITERAL, `预热 GET UA 不符：${warm?.ua}`);
      assert.equal(csrf?.ua, BROWSER_UA_LITERAL, `csrf GET UA 不符：${csrf?.ua}`);
      assert.equal(post?.ua, BROWSER_UA_LITERAL, `翻译 POST UA 不符：${post?.ua}`);
      assert.ok(post?.contentType?.includes('multipart/form-data'), 'multipart Content-Type 头被 UA 注入破坏');
      const st = loaded.mod.getTranslationStates(SID)[0];
      assert.ok(st?.segments[0]?.translated === '模板UA译文', `alibaba 译文不符：${st?.segments[0]?.translated}`);
    } finally {
      alibabaRedirectPort = null;
      await tlsFix.close();
    }
  });

  // 结构收口：连接面声明保持（P1-A 引入 node:tls 不改变白名单成员资格）；proxyUrl 面随 p8
  // 代理面回撤翻转（落盘透传/闭包接线字面零命中；双参签名休眠保留）。
  await runCheck('INV 结构收口：engines 连接面声明在位、resolveOutboundProxy 双参签名、probeEngines 落盘无 proxyUrl 键 + 闭包接线零命中（p8 翻转）', () => {
    assert.match(enginesSrc, /【连接面声明】/, 'translation-engines.ts 连接面声明头缺失');
    assert.match(enginesSrc, /export\s+async\s+function\s+resolveOutboundProxy\(\s*useProxy:\s*boolean,\s*explicitProxyUrl\?:\s*string\s*\|\s*null/, 'resolveOutboundProxy 双参签名缺失');
    assert.ok(
      !serviceSrc.includes('...(translationConfig.proxyUrl ? { proxyUrl: translationConfig.proxyUrl } : {})'),
      'probeEngines apply 落盘残留 proxyUrl 透传字面（p8 应删未删）',
    );
    assert.ok(!serviceSrc.includes('proxyUrl'), 'translation-service.ts 残留 proxyUrl 字面（p8 应删未删）');
    assert.ok(
      !/await\s+resolveOutboundProxy\(true,\s*config\.proxyUrl\)/.test(enginesSrc),
      'buildEngine translate 闭包残留 config.proxyUrl 传参（p8 应删未删）',
    );
  });

  await sleep(50);
  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  // F-r1-14 收口：清理本卷自建临时目录（rmSync recursive force + 容错——清理失败不影响卷
  // 结果判定；message 卷沿其先例不清理，本卷不动它）。
  try {
    fs.rmSync(P1_TEMP_DIR, { recursive: true, force: true });
  } catch {
    // 容错：仅清理卫生问题，不阻断结果。
  }
  process.exit(fail > 0 ? 1 : 0);
}

void main();
