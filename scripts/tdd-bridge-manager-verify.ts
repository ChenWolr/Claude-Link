// tdd-bridge-manager-verify.ts
// 计划 docs/plans/2026-09-21-im-bridge-feishu-wechat-plan.md Task 7 契约钉：BridgeManager 管线。
//   A. 非 owner feishu 忽略（dispatcher 0 次）；B. 首个 feishu 用户自动捕获 owner；
//   C. debounce 合并（2 条 → 1 次 dispatcher，'\n' 连接）；D. running 中新消息只入缓冲、
//      回合结束后 afterTurnFlushMs 内补发；E. /new 换绑 + 确认回复；F. 未知 /foo 进 dispatcher 原文；
//   G. error+空文本 → sendReply('回复生成失败，请稍后重试')；H. interrupted → 不回复；
//   I. busy → 整次 flush 重试（≤3 次计数）；J. 绑定悬空 → 重建绑定+新会话；
//   K. ≥20000 字符 force flush（不等 debounce）；L. 空白文本忽略（B1）；
//   M. 工厂返回 null（凭据缺）→ status error（B15）；N. stopAll → disconnected；
//   O. /stop → interruptTurn + 已中断；P. wechat 成功回复 → adapter.sendReply(replyText)。
// 返工追加（2026-09-21 review）：
//   A④. owner 判定收敛到 isBridgeOwner 纯函数，manager 不留内联比较（P3c 防两处漂移）；
//   I④. busy 超限丢弃补 logger 日志（P3a：丢弃不得无诊断痕迹）；
//   Q.  /stop 时序真实化（P1）：真实管线中 sdk-backend 出口先 deleteEntry 再 emitExit →
//       dispatcher exit 回调读 known 恒 null、kill 出口 code=null → 中断回合被兜底判 'error'
//       （时序机制钉在 tdd-bridge-dispatcher-verify [8]）。fake dispatcher 按此真实产出返回
//       {outcome:'error'}，钉死 manager 须按 interrupted 处理、不得向 IM 发「回复生成失败」。
// 收尾追加（2026-09-21 review R2 N1）：
//   R.  空闲 /stop 不置中断标记：仅该 sessionKey 有在途回合（buffer.running=true）才置
//       interruptedTurns；空闲 /stop（无 buffer / busy 重试间隙）置标记必残留，被下一个
//       无关回合结算消费，该回合 error 时失败提示与部分回复被误吞（R2 review 本轮新发现）。
// 零遗留收口追加（2026-09-21 review R3 N3 + R1 P3d）：
//   S.  reply 发送尾窗 /stop 残留标记：结算消费点在 reply 之前，reply 挂起期间（running 仍
//       true）到达的 /stop 置入陈旧标记活过 finally → 下一个无关回合失败提示被误吞。
//       flush finally 须清该 sessionKey 标记。
//   T.  stopPlatform 缓冲语义：禁用平台（clearBuffers:true）清在途缓冲（dispatcher 0 次）；
//       重启路径（不带参，startPlatform 内部 stop）缓冲跨重启保留照常 flush。
// 生命周期修复计划追加（docs/plans/2026-09-22-im-bridge-lifecycle-ux-fix-plan.md 批次1）：
//   U.  解绑墓碑：flush B7 凭 deps.isUnbound 拦截已解绑会话的消息（不重建、不派发）；
//   V.  manager.unbind(sessionKey)：清该 key 的 pending debounce 定时器（免消息复活定时器消灭）；
//   W.  startPlatform adapter.start() 抛错 → 状态 error 含「平台启动失败」、不抛 unhandled rejection；
//   X.  off 语义：stopPlatform silent 早退不写状态 / 非静默早退写 off / markPlatformOff 与
//       markPlatformError 显式写 / 禁用链（clearBuffers+silent+markPlatformOff）终态 off。
// 生命周期修复计划追加（docs/plans/2026-09-22-im-bridge-lifecycle-ux-fix-plan.md 批次4）：
//   E④. /new 会话名统一 `[平台] 昵称`（与 B7 重建一致）；
//   H①② 语义升级：无中断标记的 interrupted（桌面端中断）→ 回「本轮已被桌面端中断」；
//         IM /stop 置标记的 interrupted → 保持静默（原 H① 全量静默作废）；
//   O①③ /stop 空闲（无绑定或无 running）→ 回「当前没有进行中的回合」且不 interruptTurn；
//   I⑤. busy 超限丢弃前向 IM 发丢弃通知（文案含「已丢弃」）。
// 生命周期修复计划追加（批次5.2）：微信 owner 收窄——
//   A②. owner-policy wechat 不再「任何私聊用户即 owner」，与 feishu 统一 userId 精确匹配；
//   W.  manager.handleInbound wechat 段：ownerUserId 空 → 首捕获 saveWechatOwner；非 owner 忽略。
// 第二轮计划追加（docs/plans/2026-09-23-im-config-ux-round2-plan.md 批次A）：
//   Y.  A1 /help（注册即拦截/回复帮助/不建会话不建绑定）；A2 处理中回执（默认开/false 不发/
//       busy 重试不重发/超限丢弃复位再发/回执失败不阻塞回合）；A3 error+部分正文追加
//       「（回复中断，以上内容可能不完整）」（success 不加；error 无正文维持失败提示）。
// 第二轮计划追加（同计划批次C C2）：
//   Z.  入站活动性：connectedAt/lastInboundAt 记录与清零 / handleInbound 更新 /
//       5s 节流广播（连续两条只广播一次）/ getStatus 带出两字段。
// 2026-09-23 微信扫码重连修复计划追加：U② 语义升级——墓碑吞批改为送达 /new 引导提示
//   （原『无回复送达』作废，行为随本计划 Commit 2 变更）；新增 UU 组
//   （wechat 侧同场景 + 提示失败兜底）。
// RED 预期（未改树）：manager/owner-policy 模块不存在 → import 即 FAIL。
// 运行：npx tsx scripts/tdd-bridge-manager-verify.ts

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BridgeManager, type BridgeManagerDeps } from '../src/main/modules/bridge/manager';
import { isBridgeOwner } from '../src/main/modules/bridge/owner-policy';
import type { BridgeInboundMessage } from '../src/shared/types/bridge';
import type { BridgeTurnResult } from '../src/main/modules/bridge/dispatcher';

let pass = 0;
let fail = 0;
function check(group: string, no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ [${group}] ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ [${group}] ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── fake deps ──

interface FakeAdapter {
  started: boolean;
  stopped: boolean;
  sentReplies: Array<{ chatId: string; text: string }>;
  /** 发送尝试记录（含失败）：A2 fire-and-forget 断言用（回执抛错也留痕）。 */
  attempted: string[];
}

interface World {
  dispatcherCalls: Array<{ sessionId: string; text: string }>;
  dispatcherResults: BridgeTurnResult[];
  /** 手动放行 pending dispatcher（D 组用）。 */
  gate: { open: () => void } | null;
  createdSessions: Array<{ name: string; model: string; workingDir: string | null }>;
  bindings: Map<string, { platform: 'feishu' | 'wechat'; sessionKey: string; userId: string; chatId: string; displayName: string | null; sessionId: string }>;
  sessionRows: Map<string, unknown>;
  rebound: Array<{ sessionKey: string; newSessionId: string }>;
  touched: string[];
  savedOwners: string[];
  savedWechatOwners: string[];
  interrupted: string[];
  feishuAdapter: FakeAdapter;
  wechatAdapter: FakeAdapter;
  feishuFactoryReturnsNull: boolean;
  statusChanges: number;
  /** sendReply 挂起钩子（[S] 组用）：feishu sendReply text 命中即挂起，replyGate.open() 放行。 */
  hangFeishuReply: string | null;
  replyGate: { open: () => void } | null;
  /** [U] 组：墓碑 sessionKey 集合（deps.isUnbound 事实源）。 */
  unbound: Set<string>;
  /** [W] 组：注入 adapter.start 抛错（null=正常）。 */
  feishuStartError: Error | null;
  /** [Y] A2⑤：命中此文案的 sendReply 抛错（回执 fire-and-forget 断言用）。 */
  failReplyText: string | null;
}

function createWorld(): { world: World; deps: BridgeManagerDeps } {
  const world: World = {
    dispatcherCalls: [],
    dispatcherResults: [],
    gate: null,
    createdSessions: [],
    bindings: new Map(),
    sessionRows: new Map(),
    rebound: [],
    touched: [],
    savedOwners: [],
    savedWechatOwners: [],
    interrupted: [],
    feishuAdapter: { started: false, stopped: false, sentReplies: [], attempted: [] },
    wechatAdapter: { started: false, stopped: false, sentReplies: [], attempted: [] },
    feishuFactoryReturnsNull: false,
    statusChanges: 0,
    hangFeishuReply: null,
    replyGate: null,
    unbound: new Set<string>(),
    feishuStartError: null,
    failReplyText: null,
  };

  let sessionCounter = 0;
  const deps: BridgeManagerDeps = {
    debounceMs: 10,
    busyRetryMs: 20,
    afterTurnFlushMs: 20,
    sendRetryMs: 5,
    dispatcher: async (sessionId, text) => {
      world.dispatcherCalls.push({ sessionId, text });
      const result = world.dispatcherResults.shift() ?? { outcome: 'success', replyText: '默认回复' };
      if ((result as { __gate?: boolean }).__gate) {
        // 手动放行：挂起直到 world.gate.open()
        await new Promise<void>((resolve) => { world.gate = { open: resolve }; });
      }
      return result;
    },
    createSession: (name, model, workingDir) => {
      sessionCounter += 1;
      const id = `new-sess-${sessionCounter}`;
      world.createdSessions.push({ name, model, workingDir });
      world.sessionRows.set(id, { model });
      return { id };
    },
    getBinding: (sessionKey) => world.bindings.get(sessionKey) ?? null,
    upsertBinding: (b) => {
      const binding = { id: 'ignored', createdAt: 0, lastActiveAt: 0, ...b } as never;
      world.bindings.set(b.sessionKey, b as never);
      return binding;
    },
    rebind: (sessionKey, newSessionId) => {
      const b = world.bindings.get(sessionKey);
      world.rebound.push({ sessionKey, newSessionId });
      if (b) b.sessionId = newSessionId;
    },
    touch: (sessionKey) => world.touched.push(sessionKey),
    getSessionRow: (id) => world.sessionRows.get(id) ?? null,
    resolveModel: () => 'test-model',
    profiles: () => ({
      global: { workingDir: 'D:/bridge-work', receiptEnabled: true },
      feishu: { enabled: true, appId: 'a', appSecretEnc: null, region: 'feishu_cn', ownerOpenId: 'ou_owner' },
      wechat: { enabled: true, botTokenEnc: null, botUserId: null, ownerUserId: 'wxid_owner' },
    }),
    saveFeishuOwner: (openId) => world.savedOwners.push(openId),
    saveWechatOwner: (userId) => world.savedWechatOwners.push(userId),
    interruptTurn: (sessionId) => world.interrupted.push(sessionId),
    isUnbound: (sessionKey) => world.unbound.has(sessionKey),
    adapters: {
      feishu: (hooks) => {
        if (world.feishuFactoryReturnsNull) return null;
        return {
          start: async () => {
            if (world.feishuStartError) throw world.feishuStartError;
            world.feishuAdapter.started = true; hooks.onStatus({ status: 'connected' });
          },
          stop: async () => { world.feishuAdapter.stopped = true; },
          sendReply: async (chatId, text) => {
            world.feishuAdapter.attempted.push(text);
            if (world.failReplyText !== null && text.includes(world.failReplyText)) {
              throw new Error('injected sendReply failure');
            }
            if (world.hangFeishuReply !== null && text === world.hangFeishuReply) {
              // 手动放行：挂起直到 world.replyGate.open()（参照 dispatcher __gate 手法）。
              await new Promise<void>((resolve) => { world.replyGate = { open: resolve }; });
            }
            world.feishuAdapter.sentReplies.push({ chatId, text });
          },
        };
      },
      wechat: (hooks) => {
        return {
          start: async () => { world.wechatAdapter.started = true; hooks.onStatus({ status: 'connected' }); },
          stop: async () => { world.wechatAdapter.stopped = true; },
          sendReply: async (chatId, text) => { world.wechatAdapter.sentReplies.push({ chatId, text }); },
        };
      },
    },
  };
  return { world, deps };
}

const fsMsg = (over: Partial<BridgeInboundMessage>): BridgeInboundMessage => ({
  platform: 'feishu', chatId: 'oc_c', userId: 'ou_owner', sessionKey: 'fs_dm_ou_owner',
  text: '默认文本', senderName: '测试用户', isGroup: false, ...over,
});

async function main(): Promise<void> {
  // ── A/B. owner 策略（isBridgeOwner 纯函数 + manager 集成）──
  {
    check('A', '①', 'isBridgeOwner：feishu ownerOpenId 匹配 → true；不匹配 → false；null → false',
      isBridgeOwner('feishu', 'ou_owner', 'ou_owner') === true
      && isBridgeOwner('feishu', 'ou_x', 'ou_owner') === false
      && isBridgeOwner('feishu', 'ou_x', null) === false);
    // 批次5.2：wechat owner 收窄——不再任何用户即 owner，与 feishu 统一精确匹配。
    check('A', '②', 'isBridgeOwner：wechat 与 feishu 统一 userId 精确匹配（空 owner → false）',
      isBridgeOwner('wechat', 'wxid_1', 'wxid_1') === true
      && isBridgeOwner('wechat', 'wxid_2', 'wxid_1') === false
      && isBridgeOwner('wechat', 'wxid_2', null) === false);

    const { world, deps } = createWorld();
    const mgr = new BridgeManager(deps);
    mgr.handleInbound(fsMsg({ userId: 'ou_stranger', sessionKey: 'fs_dm_ou_stranger' }));
    await sleep(40);
    check('A', '③', '非 owner feishu 消息：dispatcher 0 次', world.dispatcherCalls.length === 0,
      JSON.stringify(world.dispatcherCalls));

    // B. 首个 feishu 用户自动捕获（ownerOpenId=null 场景）
    const worldB = createWorld();
    const profilesB = worldB.deps.profiles;
    worldB.deps.profiles = () => {
      const p = profilesB();
      return { ...p, feishu: { ...p.feishu, ownerOpenId: null } };
    };
    const mgrB = new BridgeManager(worldB.deps);
    mgrB.handleInbound(fsMsg({ userId: 'ou_first', sessionKey: 'fs_dm_ou_first' }));
    await sleep(40);
    check('B', '①', 'ownerOpenId=null → 自动捕获当前用户为 owner',
      worldB.world.savedOwners.includes('ou_first'), JSON.stringify(worldB.world.savedOwners));
    check('B', '②', '捕获后消息继续处理（binding 创建 + dispatcher 1 次）',
      worldB.world.createdSessions.length === 1 && worldB.world.dispatcherCalls.length === 1,
      `sessions=${worldB.world.createdSessions.length} disp=${worldB.world.dispatcherCalls.length}`);
    check('B', '③', '新会话名 [飞书] 昵称 + workingDir 取 profiles().global',
      worldB.world.createdSessions[0]?.name === '[飞书] 测试用户'
      && worldB.world.createdSessions[0]?.workingDir === 'D:/bridge-work'
      && worldB.world.createdSessions[0]?.model === 'test-model',
      JSON.stringify(worldB.world.createdSessions[0]));

    // A④（review P3c）：owner 判定的唯一事实源是 owner-policy.isBridgeOwner——
    // manager.handleInbound 不得再留内联比较（两处逻辑易漂移）。
    const repoRootA = path.resolve(__dirname, '..');
    const mgrSrcA = fs.readFileSync(path.join(repoRootA, 'src/main/modules/bridge/manager.ts'), 'utf8');
    check('A', '④', 'manager.handleInbound owner 判定走 isBridgeOwner（无内联 ownerOpenId 比较）',
      mgrSrcA.includes('isBridgeOwner(') && !mgrSrcA.includes('ownerOpenId !== m.userId'),
      'manager.ts 未接 owner-policy 或仍含内联判定');
  }

  // ── C. debounce 合并 ──
  {
    const { world, deps } = createWorld();
    const mgr = new BridgeManager(deps);
    mgr.handleInbound(fsMsg({ text: '第一句' }));
    mgr.handleInbound(fsMsg({ text: '第二句' }));
    await sleep(40);
    check('C', '①', '2 条消息 debounce 合并 1 次 dispatcher',
      world.dispatcherCalls.length === 1, JSON.stringify(world.dispatcherCalls));
    check('C', '②', "合并文本 '\\n' 连接", world.dispatcherCalls[0]?.text === '第一句\n第二句',
      JSON.stringify(world.dispatcherCalls[0]?.text));
  }

  // ── D. running 中新消息缓冲 + 回合后补发 ──
  {
    const { world, deps } = createWorld();
    world.dispatcherResults.push({ outcome: 'success', replyText: '首回合回复', __gate: true } as never);
    const mgr = new BridgeManager(deps);
    mgr.handleInbound(fsMsg({ text: '首条' }));
    await sleep(30); // flush 进入 dispatcher 且挂起
    const gateOpen = world.gate;
    mgr.handleInbound(fsMsg({ text: '回合中第二句' }));
    await sleep(30);
    check('D', '①', 'running 中新消息不触发 dispatcher（仍 1 次调用）',
      world.dispatcherCalls.length === 1, JSON.stringify(world.dispatcherCalls.length));
    gateOpen?.open();
    await sleep(80); // afterTurnFlushMs=20 内补发
    check('D', '②', '回合结束后补发缓冲（第 2 次 dispatcher，文本为缓冲内容）',
      world.dispatcherCalls.length === 2 && world.dispatcherCalls[1]?.text === '回合中第二句',
      JSON.stringify(world.dispatcherCalls));
  }

  // ── E/O. slash 命令 ──
  {
    const { world, deps } = createWorld();
    world.bindings.set('fs_dm_ou_owner', {
      platform: 'feishu', sessionKey: 'fs_dm_ou_owner', userId: 'ou_owner',
      chatId: 'oc_c', displayName: null, sessionId: 'old-sess',
    });
    world.sessionRows.set('old-sess', { model: 'm' });
    const mgr = new BridgeManager(deps);
    await mgr.startPlatform('feishu');
    mgr.handleInbound(fsMsg({ text: '/new' }));
    await sleep(40);
    check('E', '①', '/new 换绑新 sessionId',
      world.rebound.length === 1 && world.rebound[0]?.newSessionId === 'new-sess-1'
      && world.bindings.get('fs_dm_ou_owner')?.sessionId === 'new-sess-1',
      JSON.stringify(world.rebound));
    check('E', '②', '/new sendReply 收到确认',
      world.feishuAdapter.sentReplies.some((r) => r.text.includes('新会话')),
      JSON.stringify(world.feishuAdapter.sentReplies));
    check('E', '③', '/new 不进 dispatcher',
      world.dispatcherCalls.length === 0, JSON.stringify(world.dispatcherCalls));
    check('E', '④', '/new 会话名 `[飞书] 昵称`（与 B7 悬空重建命名统一，批次4.4）',
      world.createdSessions.some((s) => s.name === '[飞书] 测试用户'),
      JSON.stringify(world.createdSessions.map((s) => s.name)));

    const worldO = createWorld();
    worldO.world.bindings.set('fs_dm_ou_owner', {
      platform: 'feishu', sessionKey: 'fs_dm_ou_owner', userId: 'ou_owner',
      chatId: 'oc_c', displayName: null, sessionId: 'old-sess',
    });
    worldO.world.sessionRows.set('old-sess', { model: 'm' });
    const mgrO = new BridgeManager(worldO.deps);
    await mgrO.startPlatform('feishu');
    // 批次4.2：空闲 /stop（有绑定、无 running）→ 撒谎修正：回「当前没有进行中的回合」，
    // 不 interruptTurn、不置标记、不回「已中断」（原 O①/O② 的「一律 interruptTurn+已中断」作废）。
    mgrO.handleInbound(fsMsg({ text: '/stop' }));
    await sleep(40);
    check('O', '①', '空闲 /stop（有绑定无 running）→ 回「当前没有进行中的回合」且不 interruptTurn',
      worldO.world.interrupted.length === 0
      && worldO.world.feishuAdapter.sentReplies.some((r) => r.text === '当前没有进行中的回合'),
      JSON.stringify({ interrupted: worldO.world.interrupted, replies: worldO.world.feishuAdapter.sentReplies }));
    check('O', '②', '空闲 /stop 不回「已中断」',
      !worldO.world.feishuAdapter.sentReplies.some((r) => r.text.includes('已中断')),
      JSON.stringify(worldO.world.feishuAdapter.sentReplies));

    // O③：无绑定 /stop 同语义（binding null → 提示无进行中回合）。
    const worldO2 = createWorld();
    const mgrO2 = new BridgeManager(worldO2.deps);
    await mgrO2.startPlatform('feishu');
    mgrO2.handleInbound(fsMsg({ text: '/stop' }));
    await sleep(40);
    check('O', '③', '无绑定 /stop → 回「当前没有进行中的回合」且不 interruptTurn',
      worldO2.world.interrupted.length === 0
      && worldO2.world.feishuAdapter.sentReplies.some((r) => r.text === '当前没有进行中的回合'),
      JSON.stringify({ interrupted: worldO2.world.interrupted, replies: worldO2.world.feishuAdapter.sentReplies }));
  }

  // ── Q. /stop 中断时序真实化（review P1）：真实管线中 sdk-backend 出口先 deleteEntry 再
  // emitExit → dispatcher 的 exit 回调读 getKnownTurnOutcome 恒 null、kill 出口 code=null →
  // 中断回合被兜底判 'error'。fake dispatcher 按该真实产出返回 {outcome:'error', replyText:null}，
  // 钉死 manager：/stop 后不得再向 IM 发「回复生成失败，请稍后重试」（interrupted 分支由此可达）。
  {
    const { world, deps } = createWorld();
    world.bindings.set('fs_dm_ou_owner', {
      platform: 'feishu', sessionKey: 'fs_dm_ou_owner', userId: 'ou_owner',
      chatId: 'oc_c', displayName: null, sessionId: 'old-sess',
    });
    world.sessionRows.set('old-sess', { model: 'm' });
    // 回合在跑：首个 flush 挂起在 dispatcher；放行后按真实时序结算为 error（中断被误判）。
    world.dispatcherResults.push({ outcome: 'error', replyText: null, __gate: true } as never);
    const mgr = new BridgeManager(deps);
    await mgr.startPlatform('feishu');
    mgr.handleInbound(fsMsg({ text: '正在生成的回合' }));
    await sleep(30); // flush 进入 dispatcher 且挂起
    const gate = world.gate;
    mgr.handleInbound(fsMsg({ text: '/stop' }));
    await sleep(30);
    check('Q', '①', '/stop 生效：interruptTurn + 「已中断」回复（先于回合结算送达）',
      world.interrupted.includes('old-sess')
      && world.feishuAdapter.sentReplies.some((r) => r.text.includes('已中断')),
      JSON.stringify({ interrupted: world.interrupted, replies: world.feishuAdapter.sentReplies }));
    gate?.open(); // 回合按真实时序落 error（中断误判形态）
    await sleep(60);
    check('Q', '②', '/stop 后中断回合不发「回复生成失败，请稍后重试」',
      !world.feishuAdapter.sentReplies.some((r) => r.text.includes('回复生成失败')),
      JSON.stringify(world.feishuAdapter.sentReplies));
  }

  // ── R. 空闲 /stop 不置中断标记（review R2 N1）：/stop 在无在途回合时到达（回合已结束随手发、
  // 或 busy 重试间隙）时，interruptTurn 本就 no-op，置标记只会残留到下一个无关回合——该回合若
  // error 结算，标记在结算处被消费（userInterrupted=true），失败提示与部分回复被整体静默。
  // 钉死：仅 running=true 的在途回合才置标记；空闲 /stop 后的 error+空正文回合必须照常发
  // 「回复生成失败，请稍后重试」（与 [Q] 互补：[Q] 是 running=true 时发 /stop，标记必须生效）。
  {
    const { world, deps } = createWorld();
    world.bindings.set('fs_dm_ou_owner', {
      platform: 'feishu', sessionKey: 'fs_dm_ou_owner', userId: 'ou_owner',
      chatId: 'oc_c', displayName: null, sessionId: 'old-sess',
    });
    world.sessionRows.set('old-sess', { model: 'm' });
    world.dispatcherResults.push({ outcome: 'error', replyText: null }); // /stop 之后的那个回合
    const mgr = new BridgeManager(deps);
    await mgr.startPlatform('feishu');
    mgr.handleInbound(fsMsg({ text: '/stop' })); // 空闲（无 buffer、running 未定义）时发 /stop
    await sleep(40); // 「空闲 /stop 本身仍生效」（interruptTurn + 已中断）已由 [O] 组钉死，此处不重复
    mgr.handleInbound(fsMsg({ text: '随后的无关回合' }));
    await sleep(40);
    check('R', '①', '空闲 /stop 不置中断标记：随后 error+空正文回合仍发「回复生成失败，请稍后重试」',
      world.feishuAdapter.sentReplies.some((r) => r.text === '回复生成失败，请稍后重试'),
      JSON.stringify(world.feishuAdapter.sentReplies));
  }

  // ── S. reply 发送尾窗 /stop 的残留标记清理（review R3 N3）：flush 的中断标记结算消费点
  //（interruptedTurns.delete）在 reply 调用之前——回合 error 有正文时 reply 挂在 sendReply
  // 期间 running 仍 true，此刻到达的 /stop 会再置入一个「结算已消费过」的陈旧标记并活过
  // finally，被下一个无关回合结算消费、误吞其失败提示。钉死：flush finally 收尾时清理该
  // sessionKey 的标记（凡活到 finally 的标记必为结算后置入的陈旧标记；mid-turn 置入的已在
  // 结算处消费）。
  {
    const { world, deps } = createWorld();
    world.bindings.set('fs_dm_ou_owner', {
      platform: 'feishu', sessionKey: 'fs_dm_ou_owner', userId: 'ou_owner',
      chatId: 'oc_c', displayName: null, sessionId: 'old-sess',
    });
    world.sessionRows.set('old-sess', { model: 'm' });
    world.dispatcherResults.push({ outcome: 'error', replyText: '错误但有正文照发' });
    // A3 最小同步：error+正文的实发文本带「（回复中断…）」suffix，挂起匹配实发全文。
    world.hangFeishuReply = '错误但有正文照发\n\n（回复中断，以上内容可能不完整）'; // sendReply 挂在此条上
    const mgr = new BridgeManager(deps);
    await mgr.startPlatform('feishu');
    mgr.handleInbound(fsMsg({ text: '触发回合' }));
    await sleep(30); // flush 进入 sendReply 且挂起（running=true）
    mgr.handleInbound(fsMsg({ text: '/stop' })); // 尾窗 /stop：陈旧标记置位
    await sleep(30);
    check('S', '①', 'reply 尾窗 /stop 生效：interruptTurn + 「已中断」回复送达',
      world.interrupted.includes('old-sess')
      && world.feishuAdapter.sentReplies.some((r) => r.text.includes('已中断')),
      JSON.stringify({ interrupted: world.interrupted, replies: world.feishuAdapter.sentReplies }));
    world.replyGate?.open(); // 放行 reply → flush finally 收尾
    await sleep(60);
    world.dispatcherResults.push({ outcome: 'error', replyText: null });
    mgr.handleInbound(fsMsg({ text: '后续无关回合' }));
    await sleep(40);
    check('S', '②', '尾窗 /stop 标记不残留：后续 error+空正文回合仍发「回复生成失败，请稍后重试」',
      world.feishuAdapter.sentReplies.some((r) => r.text === '回复生成失败，请稍后重试'),
      JSON.stringify(world.feishuAdapter.sentReplies));
  }

  // ── F/G/H/P. 回复正交与未知命令 ──
  {
    const { world, deps } = createWorld();
    world.bindings.set('fs_dm_ou_owner', {
      platform: 'feishu', sessionKey: 'fs_dm_ou_owner', userId: 'ou_owner',
      chatId: 'oc_c', displayName: null, sessionId: 'old-sess',
    });
    world.sessionRows.set('old-sess', { model: 'm' });
    world.dispatcherResults.push({ outcome: 'success', replyText: null }); // /foo 消耗
    world.dispatcherResults.push({ outcome: 'success', replyText: null }); // G①
    world.dispatcherResults.push({ outcome: 'error', replyText: null });   // G②
    world.dispatcherResults.push({ outcome: 'interrupted', replyText: null }); // H①
    world.dispatcherResults.push({ outcome: 'success', replyText: '正常回复' }); // P①
    const mgr = new BridgeManager(deps);
    await mgr.startPlatform('feishu');
    mgr.handleInbound(fsMsg({ text: '/foo 未知命令' }));
    await sleep(40);
    check('F', '①', "未知 /foo 不拦截，原文进 dispatcher",
      world.dispatcherCalls.length === 1 && world.dispatcherCalls[0]?.text === '/foo 未知命令',
      JSON.stringify(world.dispatcherCalls));
    mgr.handleInbound(fsMsg({ text: '普通消息1' }));
    await sleep(40);
    // A2 最小同步：回合先发「（正在处理…）」回执，B17「无正文不发」收窄为无正文回复（回执除外）。
    check('G', '①', "success+replyText=null → 无正文 IM 消息（B17；A2 回执除外）",
      world.feishuAdapter.sentReplies.every((r) => r.text === '（正在处理…）'),
      JSON.stringify(world.feishuAdapter.sentReplies));
    mgr.handleInbound(fsMsg({ text: '普通消息2' }));
    await sleep(40);
    check('G', '②', "error+空文本 → sendReply('回复生成失败，请稍后重试')",
      world.feishuAdapter.sentReplies.some((r) => r.text === '回复生成失败，请稍后重试'),
      JSON.stringify(world.feishuAdapter.sentReplies));
    mgr.handleInbound(fsMsg({ text: '普通消息3' }));
    await sleep(40);
    // 批次4.3 语义升级：无中断标记的 interrupted = 桌面端中断（非 IM /stop）→ 通知 IM。
    check('H', '①', "无中断标记的 interrupted（桌面端中断）→ 回「本轮已被桌面端中断」",
      world.feishuAdapter.sentReplies.some((r) => r.text === '本轮已被桌面端中断'),
      JSON.stringify(world.feishuAdapter.sentReplies));
    mgr.handleInbound(fsMsg({ text: '普通消息4' }));
    await sleep(40);
    check('P', '①', "success+replyText → adapter.sendReply(原文，渲染在 adapter 内部)",
      world.feishuAdapter.sentReplies.some((r) => r.text === '正常回复' && r.chatId === 'oc_c'),
      JSON.stringify(world.feishuAdapter.sentReplies));
  }

  // ── H②. IM /stop 置标记 → dispatcher interrupted 结算 → 保持静默（批次4.3 互补面）：
  // 结算时 userInterrupted=true（/stop 置入），不得发「本轮已被桌面端中断」误报桌面中断。
  {
    const { world, deps } = createWorld();
    world.bindings.set('fs_dm_ou_owner', {
      platform: 'feishu', sessionKey: 'fs_dm_ou_owner', userId: 'ou_owner',
      chatId: 'oc_c', displayName: null, sessionId: 'old-sess',
    });
    world.sessionRows.set('old-sess', { model: 'm' });
    world.dispatcherResults.push({ outcome: 'interrupted', replyText: null, __gate: true } as never);
    const mgr = new BridgeManager(deps);
    await mgr.startPlatform('feishu');
    mgr.handleInbound(fsMsg({ text: '进行中的回合' }));
    await sleep(30);
    mgr.handleInbound(fsMsg({ text: '/stop' })); // running → 置标记 + interruptTurn + 回「已中断」
    await sleep(30);
    world.gate?.open(); // 回合按 interrupted 结算（标记在结算处消费 → 静默）
    await sleep(60);
    check('H', '②', 'IM /stop 中断（interrupted 结算 + 标记消费）→ 不误报「本轮已被桌面端中断」',
      world.feishuAdapter.sentReplies.some((r) => r.text.includes('已中断'))
      && !world.feishuAdapter.sentReplies.some((r) => r.text.includes('本轮已被桌面端中断')),
      JSON.stringify(world.feishuAdapter.sentReplies));
  }

  // ── I. busy 重试 ──
  {
    const { world, deps } = createWorld();
    world.bindings.set('fs_dm_ou_owner', {
      platform: 'feishu', sessionKey: 'fs_dm_ou_owner', userId: 'ou_owner',
      chatId: 'oc_c', displayName: null, sessionId: 'old-sess',
    });
    world.sessionRows.set('old-sess', { model: 'm' });
    world.dispatcherResults.push({ outcome: 'error', replyText: null, busy: true });
    world.dispatcherResults.push({ outcome: 'error', replyText: null, busy: true });
    world.dispatcherResults.push({ outcome: 'success', replyText: '第三次成功' });
    const mgr = new BridgeManager(deps);
    await mgr.startPlatform('feishu');
    mgr.handleInbound(fsMsg({ text: 'busy 场景' }));
    await sleep(120); // busyRetryMs=20 × 2 次重试 + flush
    check('I', '①', 'busy → 整次 flush 重试直至成功（dispatcher 3 次调用）',
      world.dispatcherCalls.length === 3, JSON.stringify(world.dispatcherCalls.length));
    check('I', '②', 'busy 重试最终回复送达',
      world.feishuAdapter.sentReplies.some((r) => r.text === '第三次成功'),
      JSON.stringify(world.feishuAdapter.sentReplies));

    const worldI2 = createWorld();
    worldI2.world.bindings.set('fs_dm_ou_owner', {
      platform: 'feishu', sessionKey: 'fs_dm_ou_owner', userId: 'ou_owner',
      chatId: 'oc_c', displayName: null, sessionId: 'old-sess',
    });
    worldI2.world.sessionRows.set('old-sess', { model: 'm' });
    for (let i = 0; i < 5; i++) worldI2.world.dispatcherResults.push({ outcome: 'error', replyText: null, busy: true });
    const mgrI2 = new BridgeManager(worldI2.deps);
    await mgrI2.startPlatform('feishu');
    // I④（review P3a）：超限丢弃必须留 logger 痕迹——捕获 console.error 断言。
    const errLog: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: unknown[]) => { errLog.push(args.map((a) => String(a)).join(' ')); };
    try {
      mgrI2.handleInbound(fsMsg({ text: '一直 busy' }));
      await sleep(160);
    } finally {
      console.error = origConsoleError;
    }
    check('I', '③', 'busy 超过 3 次 → 丢弃不再重试（dispatcher 4 次=首次+3 重试）',
      worldI2.world.dispatcherCalls.length === 4, JSON.stringify(worldI2.world.dispatcherCalls.length));
    check('I', '④', 'busy 超限丢弃补 logger 日志（含丢弃条数，不留无诊断痕迹的静默丢弃）',
      errLog.some((l) => l.includes('busy') && l.includes('丢弃')),
      JSON.stringify(errLog));
    check('I', '⑤', 'busy 超限丢弃前向 IM 发丢弃通知（文案含「已丢弃」，批次4.1 消息黑洞修复）',
      worldI2.world.feishuAdapter.sentReplies.some((r) => r.text.includes('已丢弃')),
      JSON.stringify(worldI2.world.feishuAdapter.sentReplies));
  }

  // ── J. 绑定悬空重建 ──
  {
    const { world, deps } = createWorld();
    world.bindings.set('fs_dm_ou_owner', {
      platform: 'feishu', sessionKey: 'fs_dm_ou_owner', userId: 'ou_owner',
      chatId: 'oc_c', displayName: null, sessionId: 'ghost-sess',
    });
    // getSessionRow 不含 ghost-sess → 悬空
    const mgr = new BridgeManager(deps);
    mgr.handleInbound(fsMsg({ text: '悬空后的第一条' }));
    await sleep(40);
    check('J', '①', '绑定悬空 → 重建绑定（新建会话 + upsertBinding）',
      world.createdSessions.length === 1 && world.rebound.length === 0,
      `sessions=${world.createdSessions.length} rebound=${world.rebound.length}`);
    check('J', '②', '重建后 dispatcher 用新 sessionId',
      world.dispatcherCalls[0]?.sessionId === 'new-sess-1', JSON.stringify(world.dispatcherCalls[0]));
  }

  // ── K. force flush + L. 空白忽略 ──
  {
    const { world, deps } = createWorld();
    const mgr = new BridgeManager(deps);
    mgr.handleInbound(fsMsg({ text: 'x'.repeat(20_001) }));
    await sleep(5); // 不等 debounce(10)
    check('K', '①', '≥20000 字符 force flush（5ms 内已派发）',
      world.dispatcherCalls.length === 1, JSON.stringify(world.dispatcherCalls.length));

    const worldL = createWorld();
    const mgrL = new BridgeManager(worldL.deps);
    mgrL.handleInbound(fsMsg({ text: '   ' }));
    mgrL.handleInbound(fsMsg({ text: '' }));
    await sleep(40);
    check('L', '①', '空文本/纯空格忽略不派发（B1）',
      worldL.world.dispatcherCalls.length === 0, JSON.stringify(worldL.world.dispatcherCalls));
  }

  // ── M/N. 生命周期 ──
  {
    const { world, deps } = createWorld();
    const statuses: Array<{ platform: string; status: string; error?: string }>[] = [];
    const mgr = new BridgeManager({ ...deps, onStatusChanged: (s) => statuses.push(s) });
    await mgr.startPlatform('feishu');
    check('M', '①', 'startPlatform → adapter.start', world.feishuAdapter.started === true);
    check('M', '②', 'getStatus 返回 feishu 条目',
      mgr.getStatus().some((s) => s.platform === 'feishu' && s.status === 'connected'),
      JSON.stringify(mgr.getStatus()));

    const worldM = createWorld();
    worldM.world.feishuFactoryReturnsNull = true;
    const mgrM = new BridgeManager({ ...worldM.deps, onStatusChanged: (s) => statuses.push(s) });
    await mgrM.startPlatform('feishu');
    check('M', '③', '凭据缺（工厂 null）→ 不启动 + status error（B15）',
      worldM.world.feishuAdapter.started === false
      && mgrM.getStatus().some((s) => s.platform === 'feishu' && s.status === 'error'),
      JSON.stringify(mgrM.getStatus()));

    const worldN = createWorld();
    const mgrN = new BridgeManager(worldN.deps);
    await mgrN.startPlatform('feishu');
    await mgrN.startPlatform('wechat');
    await mgrN.stopAll();
    check('N', '①', 'stopAll → 两平台 adapter stop + 状态 disconnected（B14/B20）',
      worldN.world.feishuAdapter.stopped && worldN.world.wechatAdapter.stopped
      && mgrN.getStatus().every((s) => s.status === 'disconnected'),
      JSON.stringify(mgrN.getStatus()));
  }

  // ── T. stopPlatform 缓冲语义（review R1 P3d）：禁用平台须清该平台在途缓冲（否则缓冲照跑、
  // 回复静默丢）；重启路径（startPlatform 内部 stop，不带参）不得清——无条件清会让「用户保存
  // 一次凭据」丢掉在途缓冲消息（新回归）。
  {
    const { world, deps } = createWorld();
    const mgr = new BridgeManager(deps);
    await mgr.startPlatform('feishu');
    mgr.handleInbound(fsMsg({ text: '禁用前的在途缓冲' })); // debounce(10ms) 排程中
    await mgr.stopPlatform('feishu', { clearBuffers: true });
    await sleep(40); // ≥3×debounceMs
    check('T', '①', '禁用平台（clearBuffers:true）→ 在途缓冲丢弃，debounce 到点不 flush（dispatcher 0 次）',
      world.dispatcherCalls.length === 0, JSON.stringify(world.dispatcherCalls));

    const worldT2 = createWorld();
    const mgrT2 = new BridgeManager(worldT2.deps);
    await mgrT2.startPlatform('feishu');
    mgrT2.handleInbound(fsMsg({ text: '重启跨保存的缓冲' }));
    await mgrT2.stopPlatform('feishu'); // 不带参：重启语义，缓冲与 debounce 定时器原样跨重启
    await mgrT2.startPlatform('feishu');
    await sleep(40);
    check('T', '②', '重启路径（stop 不带参）缓冲跨重启保留：startPlatform 后照常 flush（防回归锚）',
      worldT2.world.dispatcherCalls.length === 1, JSON.stringify(worldT2.world.dispatcherCalls));
  }

  // ── U. 解绑墓碑（生命周期修复批次1）：已解绑（deps.isUnbound=true）会话的消息在 flush 被
  // B7 拦截——不重建绑定、不派发 dispatcher、不回复。普通消息照常进缓冲，flush 时丢弃。
  {
    const { world, deps } = createWorld();
    world.unbound.add('fs_dm_ou_owner');
    const mgr = new BridgeManager(deps);
    await mgr.startPlatform('feishu');
    mgr.handleInbound(fsMsg({ text: '解绑后仍发来的消息' }));
    await sleep(40);
    check('U', '①', '已解绑会话消息：dispatcher 0 次 + 不重建绑定（createdSessions 0）',
      world.dispatcherCalls.length === 0 && world.createdSessions.length === 0,
      `disp=${JSON.stringify(world.dispatcherCalls)} sessions=${world.createdSessions.length}`);
    check('U', '②', '已解绑会话消息：送达一条墓碑引导提示（含 /new）且无 LLM 回复',
      world.feishuAdapter.sentReplies.length === 1
        && world.feishuAdapter.sentReplies[0]!.text.includes('/new')
        && world.feishuAdapter.sentReplies[0]!.text.includes('已解除'),
      JSON.stringify(world.feishuAdapter.sentReplies));
  }

  // ── UU. 墓碑吞批提示（2026-09-23 微信扫码重连修复）：wechat 平台同场景送达引导提示；
  // 提示发送失败不逃逸（flush 不 reject，吞批语义不受影响——对齐 A2⑤ failReplyText 手法）。──
  {
    // UU①：wechat 墓碑场景 → wechat adapter 恰 1 条含 /new 的提示、dispatcher 0 次。
    // userId 须等于 profiles.wechat.ownerUserId（批次5.2 owner 收窄门先于 flush；计划字面
    // 'wx_owner' 会被非 owner 忽略分支拦截，对齐 W③ 既有 wechat owner 消息形态）。
    const worldUU = createWorld();
    worldUU.world.unbound.add('wx_dm_wx_owner');
    const mgrUU = new BridgeManager(worldUU.deps);
    await mgrUU.startPlatform('wechat');
    mgrUU.handleInbound(fsMsg({ platform: 'wechat', chatId: 'wxid_owner', userId: 'wxid_owner', sessionKey: 'wx_dm_wx_owner', text: '解绑后的微信消息', senderName: '微信用户', isGroup: false }));
    await sleep(40); // ≥3×debounceMs(10)
    check('UU', '①', 'wechat 墓碑吞批：送达一条含 /new 引导提示（恰 1 条）且 dispatcher 0 次',
      worldUU.world.wechatAdapter.sentReplies.length === 1
      && worldUU.world.wechatAdapter.sentReplies[0]!.text.includes('/new')
      && worldUU.world.dispatcherCalls.length === 0,
      `replies=${JSON.stringify(worldUU.world.wechatAdapter.sentReplies)} disp=${worldUU.world.dispatcherCalls.length}`);

    // UU②：提示发送失败不逃逸——failReplyText 以稳定子串 '/new' 命中提示文案（提示文案将来
    // 微调时钩子不失配），flush promise 不 reject、无 unhandled、吞批语义保持。
    const worldUF = createWorld();
    worldUF.world.unbound.add('fs_dm_ou_owner');
    worldUF.world.failReplyText = '/new';
    const mgrUF = new BridgeManager(worldUF.deps);
    const unhandledUF: unknown[] = [];
    const onUnhandledUF = (err: unknown): void => { unhandledUF.push(err); };
    process.on('unhandledRejection', onUnhandledUF);
    void mgrUF.startPlatform('feishu');
    await sleep(10);
    void mgrUF.handleInbound(fsMsg({ text: '提示会发送失败的消息' }));
    await sleep(120); // 含 sendRetryMs=5 重试窗口
    process.off('unhandledRejection', onUnhandledUF);
    check('UU', '②', '提示发送失败不逃逸：flush 不 reject（无 unhandled）且失败路径真实触发（attempted 恰 2）且吞批语义保持（dispatcher 0 次）',
      unhandledUF.length === 0
      && worldUF.world.feishuAdapter.attempted.length === 2
      && worldUF.world.dispatcherCalls.length === 0,
      `unhandled=${JSON.stringify(unhandledUF)} attempted=${JSON.stringify(worldUF.world.feishuAdapter.attempted)} disp=${worldUF.world.dispatcherCalls.length}`);
  }

  // ── V. manager.unbind 清缓冲定时器（生命周期修复批次1）：解绑时该 key 的 pending debounce
  // 定时器被清 + lines 清空——三条免消息复活定时器路径（debounce/busy 重试/afterTurnFlush）消灭。
  {
    const { world, deps } = createWorld();
    const mgr = new BridgeManager(deps);
    await mgr.startPlatform('feishu');
    mgr.handleInbound(fsMsg({ text: '排程中的消息' })); // debounce(10ms) 定时器排程中
    mgr.unbind('fs_dm_ou_owner');
    await sleep(40); // ≥3×debounceMs
    check('V', '①', 'unbind 后 pending debounce 定时器不再触发 flush（dispatcher 0 次）',
      world.dispatcherCalls.length === 0, JSON.stringify(world.dispatcherCalls));
  }

  // ── W. startPlatform 异常兜底（生命周期修复批次1）：adapter.start() 抛错 → 状态 error 含
  // 「平台启动失败」、startPlatform 不再向外抛（initBridge 的 void startPlatform 不产生
  // unhandled rejection）、adapters 残骸被移除。
  {
    const { world, deps } = createWorld();
    world.feishuStartError = new Error('invalid app credentials');
    const mgr = new BridgeManager(deps);
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => { unhandled.push(err); };
    process.on('unhandledRejection', onUnhandled);
    let threw = '';
    try { await mgr.startPlatform('feishu'); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    await sleep(30);
    process.off('unhandledRejection', onUnhandled);
    check('W', '①', 'startPlatform 吞掉 adapter.start 异常不外抛', threw === '', threw);
    check('W', '②', '启动失败 → 状态 error 且文案含「平台启动失败」',
      mgr.getStatus().some((s) => s.platform === 'feishu' && s.status === 'error'
        && (s.error ?? '').includes('平台启动失败')),
      JSON.stringify(mgr.getStatus()));
    check('W', '③', '启动失败无 unhandled rejection', unhandled.length === 0, JSON.stringify(unhandled));
  }

  // ── X. off 语义（生命周期修复批次1.4）：silent 早退不写状态；非静默早退写 off；
  // markPlatformOff / markPlatformError 显式写；禁用链终态 off（非 disconnected）。
  {
    const worldX1 = createWorld();
    const mgrX1 = new BridgeManager(worldX1.deps);
    await mgrX1.stopPlatform('feishu', { silent: true });
    check('X', '①', 'stopPlatform silent 早退（无 adapter）不写状态条目',
      !mgrX1.getStatus().some((s) => s.platform === 'feishu'), JSON.stringify(mgrX1.getStatus()));

    const worldX2 = createWorld();
    const mgrX2 = new BridgeManager(worldX2.deps);
    await mgrX2.stopPlatform('feishu'); // 非静默：早退写 off
    check('X', '②', 'stopPlatform 非静默早退（无 adapter）写 off',
      mgrX2.getStatus().some((s) => s.platform === 'feishu' && s.status === 'off'),
      JSON.stringify(mgrX2.getStatus()));

    const worldX3 = createWorld();
    const mgrX3 = new BridgeManager(worldX3.deps);
    mgrX3.markPlatformError('wechat', 'App ID 格式非法');
    check('X', '③', 'markPlatformError 显式写 error+文案',
      mgrX3.getStatus().some((s) => s.platform === 'wechat' && s.status === 'error'
        && s.error === 'App ID 格式非法'),
      JSON.stringify(mgrX3.getStatus()));
    mgrX3.markPlatformOff('wechat');
    check('X', '④', 'markPlatformOff 显式写 off',
      mgrX3.getStatus().some((s) => s.platform === 'wechat' && s.status === 'off'),
      JSON.stringify(mgrX3.getStatus()));

    const worldX4 = createWorld();
    const mgrX4 = new BridgeManager(worldX4.deps);
    await mgrX4.startPlatform('feishu');
    await mgrX4.stopPlatform('feishu', { clearBuffers: true, silent: true });
    mgrX4.markPlatformOff('feishu');
    check('X', '⑤', '禁用链（clearBuffers+silent stop + markPlatformOff）终态 off 非 disconnected',
      worldX4.world.feishuAdapter.stopped
      && mgrX4.getStatus().some((s) => s.platform === 'feishu' && s.status === 'off'),
      `stopped=${worldX4.world.feishuAdapter.stopped} statuses=${JSON.stringify(mgrX4.getStatus())}`);
  }

  // ── W. 微信 owner 收窄（批次5.2）：ownerUserId 空 → 首捕获；非 owner 私聊忽略；
  // owner 消息照常处理（对齐 feishu 捕获/判定逻辑，isBridgeOwner 唯一事实源）。
  {
    const worldW = createWorld();
    const profilesW = worldW.deps.profiles;
    worldW.deps.profiles = () => {
      const p = profilesW();
      return { ...p, wechat: { ...p.wechat, ownerUserId: null } };
    };
    const mgrW = new BridgeManager(worldW.deps);
    mgrW.handleInbound(fsMsg({ platform: 'wechat', chatId: 'wxid_first', userId: 'wxid_first', sessionKey: 'wx_dm_wxid_first', text: '微信首条', senderName: '微信用户' }));
    await sleep(40);
    check('W', '①', 'wechat ownerUserId=null → 首捕获 saveWechatOwner 且消息继续处理',
      worldW.world.savedWechatOwners.includes('wxid_first') && worldW.world.dispatcherCalls.length === 1,
      `owners=${JSON.stringify(worldW.world.savedWechatOwners)} disp=${worldW.world.dispatcherCalls.length}`);

    const worldW2 = createWorld(); // profiles 默认 wechat.ownerUserId='wxid_owner'
    const mgrW2 = new BridgeManager(worldW2.deps);
    await mgrW2.startPlatform('wechat');
    mgrW2.handleInbound(fsMsg({ platform: 'wechat', chatId: 'wxid_stranger', userId: 'wxid_stranger', sessionKey: 'wx_dm_wxid_stranger', text: '陌生人的私聊', senderName: '陌生人' }));
    await sleep(40);
    check('W', '②', 'wechat 非 owner 私聊 → 忽略（dispatcher 0 次，不捕获不回复）',
      worldW2.world.dispatcherCalls.length === 0 && worldW2.world.savedWechatOwners.length === 0
      && worldW2.world.wechatAdapter.sentReplies.length === 0,
      `disp=${worldW2.world.dispatcherCalls.length} owners=${JSON.stringify(worldW2.world.savedWechatOwners)}`);

    const worldW3 = createWorld();
    const mgrW3 = new BridgeManager(worldW3.deps);
    await mgrW3.startPlatform('wechat');
    mgrW3.handleInbound(fsMsg({ platform: 'wechat', chatId: 'wxid_owner', userId: 'wxid_owner', sessionKey: 'wx_dm_wxid_owner', text: 'owner 的私聊', senderName: 'owner' }));
    await sleep(40);
    check('W', '③', 'wechat owner 私照常处理（dispatcher 1 次 + 回复送达；A2 回执不计）',
      worldW3.world.dispatcherCalls.length === 1
      && worldW3.world.wechatAdapter.sentReplies.filter((r) => r.text !== '（正在处理…）').length === 1,
      `disp=${worldW3.world.dispatcherCalls.length} replies=${JSON.stringify(worldW3.world.wechatAdapter.sentReplies)}`);
  }

  // ── Y. 第二轮批A（2026-09-23）：A1 /help / A2 处理中回执 / A3 中断标注 ──
  {
    // A1：/help 注册 + 回复帮助 + 不建会话不建绑定不派发。
    const worldY = createWorld();
    const mgrY = new BridgeManager(worldY.deps);
    await mgrY.startPlatform('feishu');
    mgrY.handleInbound(fsMsg({ text: '/help' }));
    await sleep(40);
    check('Y', '①', '/help 回复帮助文案（含「可用命令」与 /new /stop /help 三条）',
      worldY.world.feishuAdapter.sentReplies.some((r) => r.text.includes('可用命令')
        && r.text.includes('/new') && r.text.includes('/stop') && r.text.includes('/help')),
      JSON.stringify(worldY.world.feishuAdapter.sentReplies));
    check('Y', '②', '/help 不建会话不建绑定不派发（createSession 0 + upsertBinding 0 + dispatcher 0）',
      worldY.world.createdSessions.length === 0 && worldY.world.dispatcherCalls.length === 0
      && worldY.world.bindings.size === 0,
      `sessions=${worldY.world.createdSessions.length} disp=${worldY.world.dispatcherCalls.length} bindings=${worldY.world.bindings.size}`);

    // A2①：默认开 → 回合先回「（正在处理…）」再回正文。
    const worldA2 = createWorld();
    worldA2.world.bindings.set('fs_dm_ou_owner', {
      platform: 'feishu', sessionKey: 'fs_dm_ou_owner', userId: 'ou_owner',
      chatId: 'oc_c', displayName: null, sessionId: 'old-sess',
    });
    worldA2.world.sessionRows.set('old-sess', { model: 'm' });
    worldA2.world.dispatcherResults.push({ outcome: 'success', replyText: '正文来了' });
    const mgrA2 = new BridgeManager(worldA2.deps);
    await mgrA2.startPlatform('feishu');
    mgrA2.handleInbound(fsMsg({ text: '触发回合' }));
    await sleep(60);
    const r2 = worldA2.world.feishuAdapter.sentReplies;
    check('Y', '③', 'A2 默认开：flush 发「（正在处理…）」且回执先于正文',
      r2.some((r) => r.text === '（正在处理…）')
      && r2.findIndex((r) => r.text === '（正在处理…）') < r2.findIndex((r) => r.text === '正文来了'),
      JSON.stringify(r2));

    // A2②：receiptEnabled=false → 零回执。
    const worldA2b = createWorld();
    const profilesA2b = worldA2b.deps.profiles;
    worldA2b.deps.profiles = () => {
      const p = profilesA2b();
      return { ...p, global: { ...p.global, receiptEnabled: false } };
    };
    worldA2b.world.bindings.set('fs_dm_ou_owner', {
      platform: 'feishu', sessionKey: 'fs_dm_ou_owner', userId: 'ou_owner',
      chatId: 'oc_c', displayName: null, sessionId: 'old-sess',
    });
    worldA2b.world.sessionRows.set('old-sess', { model: 'm' });
    worldA2b.world.dispatcherResults.push({ outcome: 'success', replyText: '无回执正文' });
    const mgrA2b = new BridgeManager(worldA2b.deps);
    await mgrA2b.startPlatform('feishu');
    mgrA2b.handleInbound(fsMsg({ text: '关开关的回合' }));
    await sleep(60);
    check('Y', '④', 'A2 receiptEnabled=false：零「（正在处理…）」且正文照发',
      !worldA2b.world.feishuAdapter.sentReplies.some((r) => r.text === '（正在处理…）')
      && worldA2b.world.feishuAdapter.sentReplies.some((r) => r.text === '无回执正文'),
      JSON.stringify(worldA2b.world.feishuAdapter.sentReplies));

    // A2③④：busy 塞回重试不重发；超限丢弃后复位，下一回合可再发。
    const worldA2c = createWorld();
    worldA2c.world.bindings.set('fs_dm_ou_owner', {
      platform: 'feishu', sessionKey: 'fs_dm_ou_owner', userId: 'ou_owner',
      chatId: 'oc_c', displayName: null, sessionId: 'old-sess',
    });
    worldA2c.world.sessionRows.set('old-sess', { model: 'm' });
    worldA2c.world.dispatcherResults.push({ outcome: 'error', replyText: null, busy: true });
    worldA2c.world.dispatcherResults.push({ outcome: 'success', replyText: '重试后成功' });
    const mgrA2c = new BridgeManager(worldA2c.deps);
    await mgrA2c.startPlatform('feishu');
    mgrA2c.handleInbound(fsMsg({ text: 'busy 合并回合' }));
    await sleep(120);
    const receipts = worldA2c.world.feishuAdapter.sentReplies.filter((r) => r.text === '（正在处理…）');
    check('Y', '⑤', 'A2 busy 塞回重试不重发回执（「（正在处理…）」恰 1 条）',
      receipts.length === 1, JSON.stringify(worldA2c.world.feishuAdapter.sentReplies));

    const worldA2d = createWorld();
    worldA2d.world.bindings.set('fs_dm_ou_owner', {
      platform: 'feishu', sessionKey: 'fs_dm_ou_owner', userId: 'ou_owner',
      chatId: 'oc_c', displayName: null, sessionId: 'old-sess',
    });
    worldA2d.world.sessionRows.set('old-sess', { model: 'm' });
    for (let i = 0; i < 5; i++) worldA2d.world.dispatcherResults.push({ outcome: 'error', replyText: null, busy: true });
    worldA2d.world.dispatcherResults.push({ outcome: 'success', replyText: '丢弃后新回合' });
    const mgrA2d = new BridgeManager(worldA2d.deps);
    await mgrA2d.startPlatform('feishu');
    const errLogD: string[] = [];
    const origErrD = console.error;
    console.error = (...args: unknown[]) => { errLogD.push(args.map((a) => String(a)).join(' ')); };
    try {
      mgrA2d.handleInbound(fsMsg({ text: '一直 busy 直到丢弃' }));
      await sleep(180); // busy 超限丢弃（含丢弃通知）
    } finally {
      console.error = origErrD;
    }
    mgrA2d.handleInbound(fsMsg({ text: '丢弃后的下一回合' }));
    await sleep(60);
    check('Y', '⑥', 'A2 busy 超限丢弃后 receiptSent 复位：下一回合回执可再发（恰 2 条）',
      worldA2d.world.feishuAdapter.sentReplies.filter((r) => r.text === '（正在处理…）').length === 2
      && worldA2d.world.feishuAdapter.sentReplies.some((r) => r.text === '丢弃后新回合'),
      JSON.stringify(worldA2d.world.feishuAdapter.sentReplies));

    // A2⑤：回执发送失败不阻塞回合（fire-and-forget：dispatcher 已被调用、正文照发）。
    const worldA2e = createWorld();
    worldA2e.world.failReplyText = '（正在处理…）';
    worldA2e.world.bindings.set('fs_dm_ou_owner', {
      platform: 'feishu', sessionKey: 'fs_dm_ou_owner', userId: 'ou_owner',
      chatId: 'oc_c', displayName: null, sessionId: 'old-sess',
    });
    worldA2e.world.sessionRows.set('old-sess', { model: 'm' });
    worldA2e.world.dispatcherResults.push({ outcome: 'success', replyText: '回执失败也照发' });
    const mgrA2e = new BridgeManager(worldA2e.deps);
    await mgrA2e.startPlatform('feishu');
    mgrA2e.handleInbound(fsMsg({ text: '回执会失败的回合' }));
    await sleep(120); // 含 sendRetryMs=5 重试窗口
    check('Y', '⑦', 'A2 回执发送失败不阻塞回合（dispatcher 1 次 + 正文照发）',
      worldA2e.world.dispatcherCalls.length === 1
      && worldA2e.world.feishuAdapter.sentReplies.some((r) => r.text === '回执失败也照发'),
      `disp=${worldA2e.world.dispatcherCalls.length} replies=${JSON.stringify(worldA2e.world.feishuAdapter.sentReplies)}`);

    // A3：error+部分正文追加标注；success 不加；error 无正文维持失败提示。
    const worldA3 = createWorld();
    worldA3.world.bindings.set('fs_dm_ou_owner', {
      platform: 'feishu', sessionKey: 'fs_dm_ou_owner', userId: 'ou_owner',
      chatId: 'oc_c', displayName: null, sessionId: 'old-sess',
    });
    worldA3.world.sessionRows.set('old-sess', { model: 'm' });
    worldA3.world.dispatcherResults.push({ outcome: 'error', replyText: '中断前的部分输出' });
    worldA3.world.dispatcherResults.push({ outcome: 'success', replyText: '正常完整输出' });
    worldA3.world.dispatcherResults.push({ outcome: 'error', replyText: null });
    const mgrA3 = new BridgeManager(worldA3.deps);
    await mgrA3.startPlatform('feishu');
    mgrA3.handleInbound(fsMsg({ text: '回合1' }));
    await sleep(60);
    mgrA3.handleInbound(fsMsg({ text: '回合2' }));
    await sleep(60);
    mgrA3.handleInbound(fsMsg({ text: '回合3' }));
    await sleep(60);
    check('Y', '⑧', 'A3 error+部分正文 → 正文尾部带「（回复中断，以上内容可能不完整）」',
      worldA3.world.feishuAdapter.sentReplies.some((r) => r.text.includes('中断前的部分输出')
        && r.text.includes('（回复中断，以上内容可能不完整）')),
      JSON.stringify(worldA3.world.feishuAdapter.sentReplies));
    check('Y', '⑨', 'A3 success+正文不含中断标注',
      worldA3.world.feishuAdapter.sentReplies.some((r) => r.text === '正常完整输出'),
      JSON.stringify(worldA3.world.feishuAdapter.sentReplies));
    check('Y', '⑩', 'A3 error 无正文维持「回复生成失败，请稍后重试」',
      worldA3.world.feishuAdapter.sentReplies.some((r) => r.text === '回复生成失败，请稍后重试'),
      JSON.stringify(worldA3.world.feishuAdapter.sentReplies));
  }

  // ── Z. C2 入站活动性（2026-09-23 批次C）：connectedAt/lastInboundAt 记录清零 + 5s 节流广播。──
  {
    const worldZ = createWorld();
    const snapshots: Array<Array<{ platform: string; status: string; lastInboundAt?: number; connectedAt?: number }>> = [];
    const mgrZ = new BridgeManager({ ...worldZ.deps, onStatusChanged: (s) => snapshots.push(JSON.parse(JSON.stringify(s))) });
    await mgrZ.startPlatform('feishu'); // → connected（connectedAt 记录）
    const afterConnect = mgrZ.getStatus().find((s) => s.platform === 'feishu');
    check('Z', '①', 'connected 转换记录 connectedAt 且清 lastInboundAt',
      typeof afterConnect?.connectedAt === 'number' && afterConnect?.lastInboundAt === undefined,
      JSON.stringify(afterConnect));
    check('Z', '②', 'getStatus 带出 connectedAt（诊断字段透传）',
      typeof afterConnect?.connectedAt === 'number', JSON.stringify(afterConnect));

    mgrZ.handleInbound(fsMsg({ text: '第一条入站' }));
    await sleep(10);
    const afterInbound = mgrZ.getStatus().find((s) => s.platform === 'feishu');
    check('Z', '③', 'handleInbound 更新 lastInboundAt（≥connectedAt）',
      typeof afterInbound?.lastInboundAt === 'number'
      && (afterInbound?.lastInboundAt ?? 0) >= (afterInbound?.connectedAt ?? 0),
      JSON.stringify(afterInbound));
    const broadcastsAfterFirst = snapshots.length;
    mgrZ.handleInbound(fsMsg({ text: '第二条入站' }));
    await sleep(10);
    check('Z', '④', '5s 节流：紧接着第二条只改内存不广播（onStatusChanged 不新增）',
      snapshots.length === broadcastsAfterFirst,
      `before=${broadcastsAfterFirst} after=${snapshots.length}`);

    // 非 connected 状态 → 两字段清空。
    await mgrZ.stopPlatform('feishu', { clearBuffers: true });
    const afterStop = mgrZ.getStatus().find((s) => s.platform === 'feishu');
    check('Z', '⑤', '非 connected（disconnected）清 lastInboundAt/connectedAt',
      afterStop?.lastInboundAt === undefined && afterStop?.connectedAt === undefined,
      JSON.stringify(afterStop));
  }

  assert.ok(true);
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
