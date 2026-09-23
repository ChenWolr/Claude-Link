// tdd-bridge-feishu-adapter-verify.ts
// 计划 docs/plans/2026-09-21-im-bridge-feishu-wechat-plan.md Task 5 契约钉：飞书适配器。
//   A. region 非法 → 构造即 throw 且不创建任何客户端（B16）。
//   B. text 事件 → onMessage 规范化（platform/userId/sessionKey/isGroup/text/senderName）。
//   C. chat_type=group → 不 onMessage（phase 1 忽略）。
//   D. 自家 bot 回声丢弃；其他 app 消息保留。
//   E. image 类型 → 诊断占位文本（不静默）。
//   F. readyState=1 → start 后 status connected（间隔注入 1ms）。
//   G. sendReply：表格 → interactive；纯文本 → post 且 receive_id=chatId。
//   H. SDK 抛 {response:{data:{code,msg,log_id}}} → sendReply reject 且 message 含 code 与 log_id。
// 零遗留收口追加（2026-09-21 review R1 P3g）：
//   C②③. 群消息忽略补节流日志（60s 1 条，chat_id 透传）——捕获 console.log 断言。
// 生命周期修复计划追加（docs/plans/2026-09-22-im-bridge-lifecycle-ux-fix-plan.md 批次3.1）：
//   L. 错误文案中文化：初始轮询超限 →「连接建立失败，将自动重试」；WSClient.start 抛错 →
//      「连接异常：<msg>」；健康巡检未连接 →「连接已断开，正在重连」。
// 手法：__loadSdkForTest 注入 fake lark 模块（对照 openhanako tests/feishu-adapter.test.ts:22-95）。
// RED 预期（未改树）：适配器模块不存在 → import 即 FAIL。
// 运行：npx tsx scripts/tdd-bridge-feishu-adapter-verify.ts

import * as assert from 'node:assert';
import { createFeishuAdapter, type FeishuAdapterOptions } from '../src/main/modules/bridge/feishu-adapter';
import type { BridgeInboundMessage } from '../src/shared/types/bridge';

let pass = 0;
let fail = 0;
function check(group: string, no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ [${group}] ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ [${group}] ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── fake lark 模块 ──
interface WsInstance {
  opts: Record<string, unknown>;
  started: boolean;
  closed: boolean;
  wsConfig: { wsInstance?: { readyState: number } | null };
}
interface CreateCall { params: Record<string, unknown>; data: Record<string, unknown> }

interface FakeState {
  wsInstances: WsInstance[];
  dispatcherRegistry: Record<string, (data: unknown) => Promise<void> | void>;
  clients: Array<{ opts: Record<string, unknown> }>;
  messageCreates: CreateCall[];
  createReject: unknown;
  nickname: string | null;
  /** [L②] 注入 WSClient.start 抛错（null=正常 resolve）。 */
  wsStartReject: Error | null;
}

function createFakeState(): FakeState {
  return { wsInstances: [], dispatcherRegistry: {}, clients: [], messageCreates: [], createReject: undefined, nickname: '阿明', wsStartReject: null };
}

function createFakeLark(state: FakeState): Record<string, unknown> {
  const Client = class {
    opts: Record<string, unknown>;
    im: { message: { create: (payload: CreateCall) => Promise<unknown> } };
    contact: { user: { get: (args: unknown) => Promise<{ data: { user: { nickname: string | null } } }> } };
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      state.clients.push(this);
      this.im = {
        message: {
          create: async (payload: CreateCall) => {
            state.messageCreates.push(payload);
            if (state.createReject) throw state.createReject;
            return { data: { message: { message_id: 'om_1' } } };
          },
        },
      };
      this.contact = {
        user: {
          get: async (_args: unknown) => ({ data: { user: { nickname: state.nickname } } }),
        },
      };
    }
  };
  const WSClient = class {
    opts: Record<string, unknown>;
    started: boolean;
    closed: boolean;
    wsConfig: { wsInstance?: { readyState: number } | null };
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      this.started = false;
      this.closed = false;
      this.wsConfig = {};
      state.wsInstances.push(this);
    }
    async start(_dispatcher: unknown): Promise<void> {
      if (state.wsStartReject) throw state.wsStartReject;
      this.started = true;
    }
    close(): void {
      this.closed = true;
    }
  };
  const EventDispatcher = class {
    constructor(_opts?: unknown) { /* openhanako 形态：new EventDispatcher({}) */ }
    register(handlers: Record<string, (data: unknown) => Promise<void> | void>): void {
      Object.assign(state.dispatcherRegistry, handlers);
    }
  };
  return {
    Client,
    WSClient,
    EventDispatcher,
    Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
    LoggerLevel: { warn: 'warn' },
  };
}

function baseOpts(state: FakeState, over: Partial<FeishuAdapterOptions> = {}): FeishuAdapterOptions {
  return {
    appId: 'cli_my_app',
    appSecret: 'secret_x',
    region: 'feishu_cn',
    onMessage: () => {},
    onStatus: () => {},
    __loadSdkForTest: async () => createFakeLark(state),
    __intervalsForTest: { initialPollMs: 1, healthIntervalMs: 5 },
    ...over,
  } as FeishuAdapterOptions;
}

async function main(): Promise<void> {
  // ── A. region 非法 → 构造即 throw（B16）──
  {
    const state = createFakeState();
    let threw = '';
    try {
      createFeishuAdapter(baseOpts(state, { region: 'xx' as never }));
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check('A', '①', "region 'xx' → 构造即 throw", threw.length > 0, threw);
    check('A', '②', '非法 region 不创建任何客户端', state.wsInstances.length === 0 && state.clients.length === 0,
      `ws=${state.wsInstances.length} client=${state.clients.length}`);
  }

  // ── B/C/D/E. 入站规范化 ──
  {
    const state = createFakeState();
    const received: BridgeInboundMessage[] = [];
    const adapter = createFeishuAdapter(baseOpts(state, { onMessage: (m) => received.push(m) }));
    await adapter.start();
    assert.ok(state.dispatcherRegistry['im.message.receive_v1'], '事件处理器未注册');
    const handler = state.dispatcherRegistry['im.message.receive_v1']!;

    await handler({
      message: { message_type: 'text', chat_type: 'p2p', chat_id: 'oc_chat9', content: JSON.stringify({ text: '你好飞书' }) },
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_u1' } },
    });
    const m = received[received.length - 1];
    check('B', '①', 'text 事件 → onMessage 收规范化消息',
      !!m && m.platform === 'feishu' && m.userId === 'ou_u1' && m.sessionKey === 'fs_dm_ou_u1'
      && m.isGroup === false && m.text === '你好飞书' && m.chatId === 'oc_chat9',
      JSON.stringify(m));
    check('B', '②', 'senderName 经 contact.user.get 取昵称', m?.senderName === '阿明', String(m?.senderName));

    const before = received.length;
    // F3（review R1 P3g）：群消息忽略须留节流日志（60s 1 条，chat_id 透传）——
    // 捕获 console.log 断言（脚本内临时替换，finally 还原）。
    const ignoreLogs: string[] = [];
    const origConsoleLog = console.log;
    console.log = (...args: unknown[]) => { ignoreLogs.push(args.map((a) => String(a)).join(' ')); };
    try {
      await handler({
        message: { message_type: 'text', chat_type: 'group', chat_id: 'oc_g1', content: JSON.stringify({ text: '群消息' }) },
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_u2' } },
      });
      check('C', '①', 'chat_type=group → 不 onMessage（phase 1 忽略）', received.length === before,
        `received=${received.length}`);
      await handler({
        message: { message_type: 'text', chat_type: 'group', chat_id: 'oc_g1', content: JSON.stringify({ text: '群消息2' }) },
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_u2' } },
      });
    } finally {
      console.log = origConsoleLog;
    }
    check('C', '②', '群消息忽略补节流日志（含「已忽略」与 chat_id，不再无痕静默）',
      ignoreLogs.some((l) => l.includes('群聊消息已忽略') && l.includes('oc_g1')),
      JSON.stringify(ignoreLogs));
    check('C', '③', '忽略日志 60s 节流：连发两条群消息只 1 条日志',
      ignoreLogs.filter((l) => l.includes('群聊消息已忽略')).length === 1,
      JSON.stringify(ignoreLogs));

    await handler({
      message: { message_type: 'text', chat_type: 'p2p', chat_id: 'oc_x', content: JSON.stringify({ text: '回声' }) },
      sender: { sender_type: 'app', sender_id: { app_id: 'cli_my_app', open_id: 'ou_bot' } },
    });
    check('D', '①', '自家 bot 回声（sender_type=app 且 app_id=自身）丢弃', received.length === before,
      `received=${received.length}`);
    await handler({
      // 只有 app_id（无 open_id）：验证 openId/userId 回落 app_id（openhanako :471 同形态）。
      message: { message_type: 'text', chat_type: 'p2p', chat_id: 'oc_y', content: JSON.stringify({ text: '别的 bot 说的' }) },
      sender: { sender_type: 'app', sender_id: { app_id: 'cli_other_app' } },
    });
    const otherBot = received[received.length - 1];
    check('D', '②', '其他 app 的消息保留（userId 回落 app_id）',
      received.length === before + 1 && otherBot?.text === '别的 bot 说的' && otherBot?.userId === 'cli_other_app',
      JSON.stringify(otherBot));

    await handler({
      message: { message_type: 'image', chat_type: 'p2p', chat_id: 'oc_z', content: JSON.stringify({ image_key: 'img_1' }) },
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_u3' } },
    });
    const img = received[received.length - 1];
    check('E', '①', 'image 类型 → 诊断占位文本（不静默）',
      img?.text === '[飞书消息类型: image，当前版本暂不支持]',
      String(img?.text));

    await adapter.stop();
  }

  // ── F. readyState=1 → connected（注入 1ms 轮询）──
  {
    const state = createFakeState();
    const statuses: Array<{ status: string; error?: string }> = [];
    const adapter = createFeishuAdapter(baseOpts(state, { onStatus: (s) => statuses.push(s) }));
    await adapter.start();
    const ws = state.wsInstances[state.wsInstances.length - 1];
    assert.ok(ws, 'WSClient 未创建');
    ws.wsConfig.wsInstance = { readyState: 1 };
    await sleep(40);
    check('F', '①', 'readyState=1 → status connected',
      statuses.some((s) => s.status === 'connected'),
      JSON.stringify(statuses));
    await adapter.stop();
    check('F', '②', 'stop() → status disconnected 且 WSClient close',
      statuses.some((s) => s.status === 'disconnected') && ws.closed,
      JSON.stringify(statuses));
  }

  // ── G/H. sendReply ──
  {
    const state = createFakeState();
    const adapter = createFeishuAdapter(baseOpts(state));
    await adapter.start();
    await adapter.sendReply('oc_r1', '| a | b |\n|---|---|\n| 1 | 2 |');
    const tableCall = state.messageCreates[state.messageCreates.length - 1];
    const tableContent = (() => { try { return JSON.parse(String(tableCall?.data.content)) as { schema?: string }; } catch { return null; } })();
    check('G', '①', '表格文本 → msg_type interactive',
      tableCall?.data.msg_type === 'interactive' && tableContent?.schema === '2.0',
      JSON.stringify(tableCall));
    await adapter.sendReply('oc_r2', '纯文本回复');
    const postCall = state.messageCreates[state.messageCreates.length - 1];
    check('G', '②', '纯文本 → msg_type post 且 receive_id=chatId',
      postCall?.data.msg_type === 'post' && postCall?.data.receive_id === 'oc_r2'
      && postCall?.params.receive_id_type === 'chat_id',
      JSON.stringify(postCall));

    state.createReject = { response: { data: { code: 9499, msg: 'x', log_id: 'L1' } } };
    let errText = '';
    try {
      await adapter.sendReply('oc_r3', '会失败');
    } catch (e) {
      errText = e instanceof Error ? e.message : String(e);
    }
    check('H', '①', 'SDK 业务错误 → reject 且 message 含 code(9499) 与 log_id(L1)',
      errText.includes('9499') && errText.includes('L1'), errText);
    await adapter.stop();
  }

  // ── L. 错误文案中文化（生命周期修复批次3.1）──
  // win32 libuv 定时器欠服务规避：适配器轮询/巡检 timer 经 unrefTimer 去 ref——timer 阶段自旋
  // （setTimeout 链）下欠服务 ~1:15（20 checks 不可达），而 setImmediate 自旋近 1:1 服务
  //（实测 99/100）。生产 500ms×20 初轮轮询 + 真实负载不触发该伪象；此仅为契约环境等待方式
  // 调整，非生产改动。
  const spinSleep = async (ms: number): Promise<void> => {
    const end = Date.now() + ms;
    while (Date.now() < end) await new Promise((r) => setImmediate(r));
  };
  {
    // L①③：readyState 恒 0 → 初始轮询超限（1ms×20）报「连接建立失败，将自动重试」；
    // 随后健康巡检（5ms）未连接报「连接已断开，正在重连」并自动重连（循环）。
    const state = createFakeState();
    const statuses: Array<{ status: string; error?: string }> = [];
    const adapter = createFeishuAdapter(baseOpts(state, { onStatus: (s) => statuses.push(s) }));
    try {
      await adapter.start();
      await spinSleep(60);
      check('L', '①', "初始轮询超限 → error「连接建立失败，将自动重试」",
        statuses.some((s) => (s.error ?? '').includes('连接建立失败，将自动重试')),
        JSON.stringify(statuses));
      check('L', '③', "健康巡检未连接 → error「连接已断开，正在重连」",
        statuses.some((s) => (s.error ?? '').includes('连接已断开，正在重连')),
        JSON.stringify(statuses));
    } finally {
      await adapter.stop();
    }

    // L②：WSClient.start 抛错 → error「连接异常：<原始 message>」。
    const state2 = createFakeState();
    const statuses2: Array<{ status: string; error?: string }> = [];
    state2.wsStartReject = new Error('boom-ws');
    const adapter2 = createFeishuAdapter(baseOpts(state2, { onStatus: (s) => statuses2.push(s) }));
    try {
      await adapter2.start();
      await spinSleep(30);
      check('L', '②', "WSClient.start 抛错 → error「连接异常：boom-ws」（保留原始 detail）",
        statuses2.some((s) => (s.error ?? '').includes('连接异常：') && (s.error ?? '').includes('boom-ws')),
        JSON.stringify(statuses2));
    } finally {
      await adapter2.stop();
    }
  }

  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
