// tdd-bridge-wechat-verify.ts
// 计划 docs/plans/2026-09-21-im-bridge-feishu-wechat-plan.md Task 6 契约钉：微信 iLink 三模块。
//   A. cursor：第二次 getupdates 带第一次响应的 get_updates_buf；落盘后新建客户端首轮带旧 cursor。
//   B. 入站：文本→onMessage(wx_dm_)；@im.bot 回声忽略；voice_item.text 透传；引用拼 [引用: t | b]。
//   C. context_token：收到后 canReply=true；无 token sendText reject；过期(now+25h) canReply=false。
//   D. 发送：9000 字→sendmessage 3 次；item_list/message_type/state/client_id/context_token/headers。
//   E. ret=-14 → isExpired + status error('session expired') + 轮询停止（B10）。
//   F. 连续 3 次 fetch reject → onStatus error；AbortError 静默。
//   G. 登录：qrcode dataURL PNG；status wait→confirmed 返回 botToken/botUserId。
// 零遗留收口追加（2026-09-21 review R1 P3h）：
//   H. 多分段中途失败 → 段级断点续传：失败存断点（text+nextIndex）并 throw（错误注明续发）；
//      同 userId 同 text 重试从断点段起发（不重发已送达段）；换 text 不误命中旧断点，全量重发。
// 生命周期修复计划追加（docs/plans/2026-09-22-im-bridge-lifecycle-ux-fix-plan.md 批次2.3）：
//   J. 微信积压跳过：writeWechatSkipBacklogFlag 落盘 skip-backlog-<hash8>.json；客户端创建时
//      一次性消费（文件删除 + 内部 pending 标志）；首批非空整批丢弃只前进 cursor（不派发）；
//      空批保留标志到下一轮；标志消费后恢复正常派发（症状③：关通信重开消息涌出）。
// 手法：按 URL 片段分派 mock fetch（对照 openhanako tests/wechat-adapter.test.ts）。
// RED 预期（未改树）：三模块不存在 → import 即 FAIL。
// 运行：npx tsx scripts/tdd-bridge-wechat-verify.ts

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createIlinkClient, writeWechatSkipBacklogFlag, type IlinkDeps } from '../src/main/modules/bridge/wechat-ilink';
import { createWechatAdapter } from '../src/main/modules/bridge/wechat-adapter';
import { getWechatQrcode, pollWechatQrcodeStatus } from '../src/main/modules/bridge/wechat-login';
import type { BridgeInboundMessage } from '../src/shared/types/bridge';

let pass = 0;
let fail = 0;
function check(group: string, no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ [${group}] ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ [${group}] ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── mock fetch 基建 ──
interface RecordedRequest { url: string; body: Record<string, unknown>; headers: Record<string, string> }

interface FetchMock {
  requests: RecordedRequest[];
  /** 按 URL 片段 → 响应（JSON 对象或 Error 实例表示 reject）。队列形态：shift 消费。 */
  queue: Array<{ match: string; respond: Record<string, unknown> | Error }>;
  defaultResponse: Record<string, unknown>;
}

function createFetchMock(): FetchMock {
  return { requests: [], queue: [], defaultResponse: { ret: 0, msgs: [], get_updates_buf: '' } };
}

function makeFetch(mock: FetchMock): typeof fetch {
  const fn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const headers = (init?.headers ?? {}) as Record<string, string>;
    mock.requests.push({ url, body, headers });
    const qi = mock.queue.findIndex((q) => url.includes(q.match));
    if (qi >= 0) {
      const [q] = mock.queue.splice(qi, 1);
      if (q!.respond instanceof Error) throw q!.respond;
      return new Response(JSON.stringify(q!.respond), { status: 200 });
    }
    return new Response(JSON.stringify(mock.defaultResponse), { status: 200 });
  }) as unknown as typeof fetch;
  return fn;
}

function okResponse(extra: Record<string, unknown>): Record<string, unknown> {
  return { ret: 0, errcode: 0, ...extra };
}

function makeDeps(fetchFn: typeof fetch, stateDir: string, now?: () => number, intervals?: { pollTimeoutMs?: number; backoffMs?: number[] }): IlinkDeps {
  return { fetchFn, stateDir, now, intervals };
}

async function main(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-wechat-test-'));

  // ── A. cursor ──
  {
    const mock = createFetchMock();
    const stateDir = path.join(tmpRoot, 'cursor');
    mock.queue.push({ match: 'getupdates', respond: okResponse({ msgs: [], get_updates_buf: 'BUF-1' }) });
    const client = createIlinkClient('tok-A', makeDeps(makeFetch(mock), stateDir));
    await client.pollOnce();
    check('A', '①', '首轮 getupdates 发出（空 cursor）', mock.requests[0]?.url.includes('getupdates') === true,
      JSON.stringify(mock.requests.map((r) => r.url)));
    mock.queue.push({ match: 'getupdates', respond: okResponse({ msgs: [], get_updates_buf: '' }) });
    await client.pollOnce();
    check('A', '②', '第二次 getupdates 请求体带第一次响应的 get_updates_buf',
      mock.requests[1]?.body.get_updates_buf === 'BUF-1',
      JSON.stringify(mock.requests[1]?.body));
    client.stop();

    // 同 token 新建客户端：首轮即带旧 cursor（stateDir JSON 落盘）。
    const mock2 = createFetchMock();
    const client2 = createIlinkClient('tok-A', makeDeps(makeFetch(mock2), stateDir));
    mock2.queue.push({ match: 'getupdates', respond: okResponse({ msgs: [] }) });
    await client2.pollOnce();
    check('A', '③', '落盘后新建客户端首轮带旧 cursor',
      mock2.requests[0]?.body.get_updates_buf === 'BUF-1',
      JSON.stringify(mock2.requests[0]?.body));
    client2.stop();
    check('A', '④', 'cursor 落盘为 stateDir 下 sync-*.json',
      fs.readdirSync(stateDir).some((f) => f.startsWith('sync-') && f.endsWith('.json')),
      JSON.stringify(fs.readdirSync(stateDir)));
  }

  // ── B/C. 入站 + context_token（走 adapter）──
  {
    const mock = createFetchMock();
    const stateDir = path.join(tmpRoot, 'inbound');
    const received: BridgeInboundMessage[] = [];
    const adapter = createWechatAdapter({
      botToken: 'tok-B',
      stateDir,
      onMessage: (m) => received.push(m),
      onStatus: () => {},
      fetchFn: makeFetch(mock),
    });
    // 内部 client 从 mock 拿不到——直接再建一个同 stateDir/token 的 client 注入 context_token 断言用。
    mock.queue.push({
      match: 'getupdates',
      respond: okResponse({
        msgs: [
          { from_user_id: 'wxid_alice', context_token: 'CTX-1', item_list: [{ type: 1, text_item: { text: '你好微信' } }] },
          { from_user_id: 'someone@im.bot', context_token: 'CTX-BOT', item_list: [{ type: 1, text_item: { text: 'bot回声' } }] },
          { from_user_id: 'wxid_bob', context_token: 'CTX-2', item_list: [{ type: 3, voice_item: { text: '语音转写内容' } }] },
          { from_user_id: 'wxid_carol', context_token: 'CTX-3', item_list: [{ type: 1, text_item: { text: '正文内容' }, ref_msg: { title: 't', message_item: { type: 1, text_item: { text: 'b' } } } }] },
        ],
        get_updates_buf: 'BUF-B',
      }),
    });
    await adapter.start();
    await sleep(30);
    check('B', '①', '文本消息 → onMessage{platform:wechat, sessionKey:wx_dm_<from>, isGroup:false}',
      received.length === 3 && received[0]?.platform === 'wechat' && received[0]?.sessionKey === 'wx_dm_wxid_alice'
      && received[0]?.isGroup === false && received[0]?.text === '你好微信' && received[0]?.chatId === 'wxid_alice',
      JSON.stringify(received));
    check('B', '②', '@im.bot 结尾 from_user_id → 忽略',
      received.every((m) => !m.userId.endsWith('@im.bot')), JSON.stringify(received.map((m) => m.userId)));
    check('B', '③', 'voice_item.text 透传为文本',
      received.some((m) => m.userId === 'wxid_bob' && m.text === '语音转写内容'),
      JSON.stringify(received.map((m) => m.text)));
    check('B', '④', '引用拼 [引用: t | b]\\n正文',
      received.some((m) => m.userId === 'wxid_carol' && m.text === '[引用: t | b]\n正文内容'),
      JSON.stringify(received.map((m) => m.text)));

    // context_token：内部状态经 adapter.sendReply 验证（成功=有 token；无 token 用户 reject）。
    mock.queue.push({ match: 'sendmessage', respond: okResponse({}) });
    await adapter.sendReply('wxid_alice', '回给alice');
    check('C', '①', '收到过消息的用户可回复（sendmessage 发出）',
      mock.requests.some((r) => r.url.includes('sendmessage') && r.body.msg && (r.body.msg as Record<string, unknown>).to_user_id === 'wxid_alice'),
      JSON.stringify(mock.requests.map((r) => r.url)));
    let errText = '';
    try {
      await adapter.sendReply('wxid_stranger', '回给陌生人');
    } catch (e) {
      errText = e instanceof Error ? e.message : String(e);
    }
    check('C', '②', '无 token 用户 sendReply reject 且 message 含「需要对方最近发过消息」',
      errText.includes('需要对方最近发过消息'), errText);
    await adapter.stop();
  }

  // ── C(续). token 过期（now 注入 +25h）→ canReply=false ──
  {
    let currentTime = 1_000_000;
    const mock = createFetchMock();
    const stateDir = path.join(tmpRoot, 'expiry');
    const client = createIlinkClient('tok-C', makeDeps(makeFetch(mock), stateDir, () => currentTime));
    client.rememberContextToken('wxid_old', 'CTX-OLD', currentTime + 60_000);
    check('C', '③', '未过期 canReply=true', client.canReply('wxid_old') === true);
    currentTime += 25 * 60 * 60 * 1000;
    check('C', '④', 'token 过期（>24h）canReply=false 且 getContextToken=null',
      client.canReply('wxid_old') === false && client.getContextToken('wxid_old') === null);
  }

  // ── D. 发送：分段 + 载荷 + headers ──
  {
    const mock = createFetchMock();
    const stateDir = path.join(tmpRoot, 'send');
    const client = createIlinkClient('tok-D', makeDeps(makeFetch(mock), stateDir));
    client.rememberContextToken('wxid_u9', 'CTX-D', Date.now() + 60_000);
    mock.queue.push({ match: 'sendmessage', respond: okResponse({}) });
    mock.queue.push({ match: 'sendmessage', respond: okResponse({}) });
    mock.queue.push({ match: 'sendmessage', respond: okResponse({}) });
    await client.sendText('wxid_u9', 'a'.repeat(9000));
    const sends = mock.requests.filter((r) => r.url.includes('sendmessage'));
    check('D', '①', '9000 字 → sendmessage 3 次', sends.length === 3, `sends=${sends.length}`);
    const first = sends[0]?.body.msg as Record<string, unknown>;
    const items = first?.item_list as Array<Record<string, unknown>>;
    const shapeOk = sends.every((r) => {
      const msg = r.body.msg as Record<string, unknown>;
      const list = msg.item_list as Array<{ type: number; text_item: { text: string } }>;
      return msg.message_type === 2 && msg.message_state === 2
        && typeof msg.client_id === 'string' && msg.client_id.length >= 32
        && msg.context_token === 'CTX-D'
        && list.length === 1 && list[0]!.type === 1 && typeof list[0]!.text_item?.text === 'string'
        && list[0]!.text_item.text.length <= 4000;
    });
    check('D', '②', '每段 message_type=2/state=2/client_id/context_token/item_list[{type:1,text_item}]',
      shapeOk, JSON.stringify(first));
    check('D', '③', '分段拼接无损（3×≤4000=9000）',
      sends.map((r) => ((r.body.msg as Record<string, unknown>).item_list as Array<{ text_item: { text: string } }>)[0]!.text_item.text).join('').length === 9000);
    check('D', '④', '请求头：AuthorizationType=ilink_bot_token + Bearer token + X-WECHAT-UIN',
      sends[0]?.headers.AuthorizationType === 'ilink_bot_token'
      && sends[0]?.headers.Authorization === 'Bearer tok-D'
      && typeof sends[0]?.headers['X-WECHAT-UIN'] === 'string',
      JSON.stringify(sends[0]?.headers));

    // 业务错误 ret!=0 → sendText reject。
    mock.queue.push({ match: 'sendmessage', respond: { ret: 500, errmsg: '服务器繁忙' } });
    let bizErr = '';
    try { await client.sendText('wxid_u9', '会失败'); } catch (e) { bizErr = e instanceof Error ? e.message : String(e); }
    check('D', '⑤', 'ret!=0 → sendText reject 且 message 含 ret=', bizErr.includes('ret=500'), bizErr);
  }

  // ── H. 多分段断点续传（review R1 P3h）──
  {
    const mock = createFetchMock();
    const stateDir = path.join(tmpRoot, 'resume');
    const client = createIlinkClient('tok-H', makeDeps(makeFetch(mock), stateDir));
    client.rememberContextToken('wxid_resume', 'CTX-H', Date.now() + 60_000);
    const longText = 'a'.repeat(9000); // 无换行 → 3 段：4000/4000/1000
    const segText = (i: number) => longText.slice(i * 4000, i === 2 ? 9000 : (i + 1) * 4000);
    const sendReqs = () => mock.requests.filter((r) => r.url.includes('sendmessage'));

    // ① 第一次：段 1 成功、段 2 失败 → throw 且错误注明续发；请求恰 2 条（段1+段2）。
    mock.queue.push({ match: 'sendmessage', respond: okResponse({}) });
    mock.queue.push({ match: 'sendmessage', respond: { ret: 500, errmsg: '段2失败' } });
    let resumeErr = '';
    try { await client.sendText('wxid_resume', longText); } catch (e) { resumeErr = e instanceof Error ? e.message : String(e); }
    check('H', '①', '第 2/3 段失败 → throw 且错误注明「前 1 段已送达，重试将续发」（保留原 ret=500）',
      resumeErr.includes('第 2/3 段') && resumeErr.includes('前 1 段已送达') && resumeErr.includes('重试将续发')
      && resumeErr.includes('ret=500'), resumeErr);
    check('H', '②', '失败即停：第一次只发出段 1、段 2 两条请求（段 3 未发）',
      sendReqs().length === 2
      && (sendReqs()[0]?.body.msg as Record<string, unknown>) !== undefined
      && ((sendReqs()[0]!.body.msg as Record<string, { text_item: { text: string } }>).item_list[0]!.text_item.text === segText(0)),
      `sends=${sendReqs().length}`);

    // ② 同 userId 同 text 重试（模拟 manager 2s 重试）→ 只发段 2、段 3，无段 1 重发。
    mock.queue.push({ match: 'sendmessage', respond: okResponse({}) });
    mock.queue.push({ match: 'sendmessage', respond: okResponse({}) });
    await client.sendText('wxid_resume', longText);
    const resumed = sendReqs().slice(2);
    check('H', '③', '重试续发：只发段 2、段 3（无段 1 重发），段文本精确续接',
      resumed.length === 2
      && (resumed[0]!.body.msg as Record<string, { item_list: Array<{ text_item: { text: string } }> }>).item_list[0].text_item.text === segText(1)
      && (resumed[1]!.body.msg as Record<string, { item_list: Array<{ text_item: { text: string } }> }>).item_list[0].text_item.text === segText(2),
      `resumed=${resumed.length}`);
    // 全部送达 → 断点清除：同 text 第三次全量重发 3 段（2+2+3=7 累计……此处 5+3=校验增量）。
    mock.queue.push({ match: 'sendmessage', respond: okResponse({}) });
    mock.queue.push({ match: 'sendmessage', respond: okResponse({}) });
    mock.queue.push({ match: 'sendmessage', respond: okResponse({}) });
    await client.sendText('wxid_resume', longText);
    check('H', '④', '全部送达后断点清除（同 text 第三次全量重发 3 段，累计 2+2+3=7）',
      sendReqs().length === 7, `sends=${sendReqs().length}`);

    // ③ 换不同 text → 断点不误命中旧文本：三段全发。
    mock.queue.push({ match: 'sendmessage', respond: okResponse({}) });
    mock.queue.push({ match: 'sendmessage', respond: okResponse({}) });
    mock.queue.push({ match: 'sendmessage', respond: okResponse({}) });
    await client.sendText('wxid_resume', 'b'.repeat(9000));
    const fresh = sendReqs().slice(7); // 前三次累计 2+2+3=7 条，此处为换文本后的增量
    check('H', '⑤', '换文本后全量三段重发（断点不误命中旧文本）',
      fresh.length === 3
      && (fresh[0]!.body.msg as Record<string, { item_list: Array<{ text_item: { text: string } }> }>).item_list[0].text_item.text === 'b'.repeat(4000),
      `fresh=${fresh.length}`);
  }

  // ── E. ret=-14 过期（B10）──
  {
    const mock = createFetchMock();
    const stateDir = path.join(tmpRoot, 'expired14');
    const statuses: Array<{ status: string; error?: string }> = [];
    const adapter = createWechatAdapter({
      botToken: 'tok-E', stateDir,
      onMessage: () => {}, onStatus: (s) => statuses.push(s),
      fetchFn: makeFetch(mock),
      intervalsForTest: { pollTimeoutMs: 50, backoffMs: [0, 0, 0] },
    });
    mock.queue.push({ match: 'getupdates', respond: { ret: -14, errcode: -14, errmsg: 'session expired' } });
    await adapter.start();
    await sleep(60);
    const fetchCountAtExpiry = mock.requests.length;
    await sleep(80);
    check('E', '①', 'ret=-14 → isExpired 语义：轮询停止（不再发请求）',
      mock.requests.length === fetchCountAtExpiry,
      `before=${fetchCountAtExpiry} after=${mock.requests.length}`);
    check('E', '②', 'ret=-14 → onStatus 收 {status:error, error 含 session expired}',
      statuses.some((s) => s.status === 'error' && (s.error ?? '').includes('session expired')),
      JSON.stringify(statuses));
    await adapter.stop();
  }

  // ── F. 连续失败 / AbortError ──
  {
    const mock = createFetchMock();
    const stateDir = path.join(tmpRoot, 'failures');
    const statuses: Array<{ status: string; error?: string }> = [];
    const adapter = createWechatAdapter({
      botToken: 'tok-F', stateDir,
      onMessage: () => {}, onStatus: (s) => statuses.push(s),
      fetchFn: makeFetch(mock),
      intervalsForTest: { pollTimeoutMs: 50, backoffMs: [0, 0, 0] },
    });
    mock.queue.push({ match: 'getupdates', respond: new Error('network down 1') });
    mock.queue.push({ match: 'getupdates', respond: new Error('network down 2') });
    mock.queue.push({ match: 'getupdates', respond: new Error('network down 3') });
    await adapter.start();
    await sleep(80);
    check('F', '①', '连续 3 次 fetch reject → onStatus error',
      statuses.some((s) => s.status === 'error'),
      JSON.stringify(statuses));
    await adapter.stop();
  }
  {
    const mock = createFetchMock();
    const stateDir = path.join(tmpRoot, 'abort');
    const statuses: Array<{ status: string; error?: string }> = [];
    const adapter = createWechatAdapter({
      botToken: 'tok-G', stateDir,
      onMessage: () => {}, onStatus: (s) => statuses.push(s),
      fetchFn: makeFetch(mock),
      intervalsForTest: { pollTimeoutMs: 50, backoffMs: [0, 0, 0] },
    });
    const abortErr = new Error('The operation was aborted');
    (abortErr as Error & { name: string }).name = 'AbortError';
    mock.queue.push({ match: 'getupdates', respond: abortErr });
    mock.queue.push({ match: 'getupdates', respond: okResponse({ msgs: [] }) });
    await adapter.start();
    await sleep(60);
    check('F', '②', 'AbortError → 静默继续（无 error 状态）',
      !statuses.some((s) => s.status === 'error') && mock.requests.filter((r) => r.url.includes('getupdates')).length >= 2,
      `statuses=${JSON.stringify(statuses)} reqs=${mock.requests.length}`);
    await adapter.stop();
  }

  // ── G. 登录 ──
  {
    const mock = createFetchMock();
    const fetchFn = makeFetch(mock);
    mock.queue.push({
      match: 'get_bot_qrcode',
      respond: okResponse({ qrcode: 'QR-ID-1', qrcode_img_content: 'https://x' }),
    });
    const qr = await getWechatQrcode(fetchFn);
    check('G', '①', 'getWechatQrcode → dataUrl PNG dataURL 且 qrcodeId 取自 qrcode 字段',
      qr.qrcodeDataUrl.startsWith('data:image/png;base64,') && qr.qrcodeId === 'QR-ID-1',
      JSON.stringify({ id: qr.qrcodeId, head: qr.qrcodeDataUrl.slice(0, 32) }));

    mock.queue.push({ match: 'get_qrcode_status', respond: okResponse({ status: 'wait' }) });
    const s1 = await pollWechatQrcodeStatus('QR-ID-1', fetchFn);
    mock.queue.push({
      match: 'get_qrcode_status',
      respond: okResponse({ status: 'confirmed', bot_token: 'BT-1', ilink_bot_id: 'IB-1', ilink_user_id: 'IU-1' }),
    });
    const s2 = await pollWechatQrcodeStatus('QR-ID-1', fetchFn);
    check('G', '②', 'status wait→confirmed 序列返回 botToken/botUserId',
      s1.status === 'wait' && s2.status === 'confirmed' && s2.botToken === 'BT-1' && s2.botUserId === 'IU-1',
      JSON.stringify([s1, s2]));
    mock.queue.push({ match: 'get_qrcode_status', respond: okResponse({ status: 'expired' }) });
    const s3 = await pollWechatQrcodeStatus('QR-ID-1', fetchFn);
    check('G', '③', 'expired 状态透传', s3.status === 'expired', JSON.stringify(s3));
  }

  // ── J. 微信积压跳过（生命周期修复批次2.3：症状③）──
  {
    const mock = createFetchMock();
    const stateDir = path.join(tmpRoot, 'skip');
    writeWechatSkipBacklogFlag(stateDir, 'tok-J');
    const flagFile = fs.readdirSync(stateDir).find((f) => f.startsWith('skip-backlog-') && f.endsWith('.json'));
    const flagContent = flagFile
      ? (JSON.parse(fs.readFileSync(path.join(stateDir, flagFile!), 'utf-8')) as { createdAt?: number })
      : null;
    check('J', '①', 'writeWechatSkipBacklogFlag 写 stateDir/skip-backlog-<hash8>.json（含 createdAt）',
      !!flagFile && typeof flagContent?.createdAt === 'number' && flagContent.createdAt > 0,
      `file=${String(flagFile)} content=${JSON.stringify(flagContent)}`);

    // 首批积压消息：整批丢弃只进 cursor。标志在客户端创建时被一次性消费（文件删除）。
    mock.queue.push({
      match: 'getupdates',
      respond: okResponse({
        msgs: [{ from_user_id: 'wxid_backlog', context_token: 'CTX-BL', item_list: [{ type: 1, text_item: { text: '积压消息' } }] }],
        get_updates_buf: 'BUF-J2',
      }),
    });
    const received: BridgeInboundMessage[] = [];
    const client = createIlinkClient('tok-J', {
      fetchFn: makeFetch(mock), stateDir,
      onMessage: (m) => received.push(m),
    });
    check('J', '②', '客户端创建时一次性消费积压标志（skip-backlog 文件删除）',
      !!flagFile && !fs.existsSync(path.join(stateDir, flagFile!)),
      `exists=${flagFile ? fs.existsSync(path.join(stateDir, flagFile)) : 'no-file'}`);
    await client.pollOnce();
    check('J', '③', '标志在途首批非空 → 整批丢弃（onMessage 0 次，不回复不建绑定）',
      received.length === 0, JSON.stringify(received));
    // 再轮询一次（空批）：请求体应携带上轮响应的 BUF-J2——丢弃批 cursor 已前进，不重复拉取积压。
    mock.queue.push({ match: 'getupdates', respond: okResponse({ msgs: [], get_updates_buf: '' }) });
    await client.pollOnce();
    const secondReq = mock.requests.filter((r) => r.url.includes('getupdates'))[1];
    check('J', '④', '丢弃批 cursor 已前进（第二次轮询请求体带 BUF-J2，不重复拉取）',
      secondReq?.body.get_updates_buf === 'BUF-J2', JSON.stringify(secondReq?.body));
    client.stop();

    // 下一轮正常派发：同 token 新客户端（无标志）→ 消息照常 onMessage。
    const mock2 = createFetchMock();
    mock2.queue.push({
      match: 'getupdates',
      respond: okResponse({
        msgs: [{ from_user_id: 'wxid_new', context_token: 'CTX-N', item_list: [{ type: 1, text_item: { text: '重开后的新消息' } }] }],
        get_updates_buf: 'BUF-J3',
      }),
    });
    const received2: BridgeInboundMessage[] = [];
    const client2 = createIlinkClient('tok-J', {
      fetchFn: makeFetch(mock2), stateDir,
      onMessage: (m) => received2.push(m),
    });
    await client2.pollOnce();
    check('J', '⑤', '标志消费后新客户端正常派发（重开后新消息照常服务）',
      received2.length === 1 && received2[0]?.text === '重开后的新消息', JSON.stringify(received2));
    client2.stop();

    // 空批保留标志：写新标志 → 首轮空批 → 标志仍在 → 次轮有消息仍丢弃 → 三轮恢复正常。
    const stateDir3 = path.join(tmpRoot, 'skip-empty');
    writeWechatSkipBacklogFlag(stateDir3, 'tok-K');
    const mock3 = createFetchMock();
    mock3.queue.push({ match: 'getupdates', respond: okResponse({ msgs: [], get_updates_buf: 'B1' }) });
    mock3.queue.push({
      match: 'getupdates',
      respond: okResponse({ msgs: [{ from_user_id: 'wxid_late', item_list: [{ type: 1, text_item: { text: '迟到积压' } }] }], get_updates_buf: 'B2' }),
    });
    mock3.queue.push({
      match: 'getupdates',
      respond: okResponse({ msgs: [{ from_user_id: 'wxid_live', item_list: [{ type: 1, text_item: { text: '新消息' } }] }], get_updates_buf: 'B3' }),
    });
    const received3: BridgeInboundMessage[] = [];
    const client3 = createIlinkClient('tok-K', {
      fetchFn: makeFetch(mock3), stateDir: stateDir3,
      onMessage: (m) => received3.push(m),
    });
    await client3.pollOnce(); // 空批：标志保留
    await client3.pollOnce(); // 有消息：丢弃
    await client3.pollOnce(); // 恢复
    check('J', '⑥', '空批保留标志到下一轮（空批不消费；次轮积压仍丢弃；三轮起恢复派发）',
      received3.length === 1 && received3[0]?.text === '新消息',
      `三轮派发=${JSON.stringify(received3.map((m) => m.text))}`);
    client3.stop();

    // 无标志文件 → 客户端行为完全不变（回归锚）。
    const stateDir4 = path.join(tmpRoot, 'skip-none');
    const mock4 = createFetchMock();
    mock4.queue.push({
      match: 'getupdates',
      respond: okResponse({ msgs: [{ from_user_id: 'wxid_plain', item_list: [{ type: 1, text_item: { text: '正常' } }] }] }),
    });
    const received4: BridgeInboundMessage[] = [];
    const client4 = createIlinkClient('tok-L', {
      fetchFn: makeFetch(mock4), stateDir: stateDir4,
      onMessage: (m) => received4.push(m),
    });
    await client4.pollOnce();
    check('J', '⑦', '无标志文件：首批消息照常派发（既有语义零回归）',
      received4.length === 1 && received4[0]?.text === '正常', JSON.stringify(received4));
    client4.stop();
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
