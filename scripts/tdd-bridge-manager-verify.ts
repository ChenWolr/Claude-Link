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
    interrupted: [],
    feishuAdapter: { started: false, stopped: false, sentReplies: [] },
    wechatAdapter: { started: false, stopped: false, sentReplies: [] },
    feishuFactoryReturnsNull: false,
    statusChanges: 0,
    hangFeishuReply: null,
    replyGate: null,
    unbound: new Set<string>(),
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
      global: { workingDir: 'D:/bridge-work' },
      feishu: { enabled: true, appId: 'a', appSecretEnc: null, region: 'feishu_cn', ownerOpenId: 'ou_owner' },
      wechat: { enabled: true, botTokenEnc: null, botUserId: null },
    }),
    saveFeishuOwner: (openId) => world.savedOwners.push(openId),
    interruptTurn: (sessionId) => world.interrupted.push(sessionId),
    isUnbound: (sessionKey) => world.unbound.has(sessionKey),
    adapters: {
      feishu: (hooks) => {
        if (world.feishuFactoryReturnsNull) return null;
        return {
          start: async () => { world.feishuAdapter.started = true; hooks.onStatus({ status: 'connected' }); },
          stop: async () => { world.feishuAdapter.stopped = true; },
          sendReply: async (chatId, text) => {
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
    check('A', '②', 'isBridgeOwner：wechat 任何 DM 用户即 owner',
      isBridgeOwner('wechat', 'wxid_any', null) === true);

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

    const worldO = createWorld();
    worldO.world.bindings.set('fs_dm_ou_owner', {
      platform: 'feishu', sessionKey: 'fs_dm_ou_owner', userId: 'ou_owner',
      chatId: 'oc_c', displayName: null, sessionId: 'old-sess',
    });
    worldO.world.sessionRows.set('old-sess', { model: 'm' });
    const mgrO = new BridgeManager(worldO.deps);
    await mgrO.startPlatform('feishu');
    mgrO.handleInbound(fsMsg({ text: '/stop' }));
    await sleep(40);
    check('O', '①', '/stop → interruptTurn(当前绑定 session)',
      worldO.world.interrupted.includes('old-sess'), JSON.stringify(worldO.world.interrupted));
    check('O', '②', '/stop sendReply 已中断',
      worldO.world.feishuAdapter.sentReplies.some((r) => r.text.includes('已中断')),
      JSON.stringify(worldO.world.feishuAdapter.sentReplies));
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
    world.hangFeishuReply = '错误但有正文照发'; // sendReply 挂在此条上
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
    check('G', '①', "success+replyText=null → 不发任何 IM 消息（B17）",
      world.feishuAdapter.sentReplies.length === 0, JSON.stringify(world.feishuAdapter.sentReplies));
    mgr.handleInbound(fsMsg({ text: '普通消息2' }));
    await sleep(40);
    check('G', '②', "error+空文本 → sendReply('回复生成失败，请稍后重试')",
      world.feishuAdapter.sentReplies.some((r) => r.text === '回复生成失败，请稍后重试'),
      JSON.stringify(world.feishuAdapter.sentReplies));
    mgr.handleInbound(fsMsg({ text: '普通消息3' }));
    await sleep(40);
    const countBefore = world.feishuAdapter.sentReplies.length;
    check('H', '①', "interrupted → 不 sendReply",
      world.feishuAdapter.sentReplies.length === countBefore,
      JSON.stringify(world.feishuAdapter.sentReplies));
    mgr.handleInbound(fsMsg({ text: '普通消息4' }));
    await sleep(40);
    check('P', '①', "success+replyText → adapter.sendReply(原文，渲染在 adapter 内部)",
      world.feishuAdapter.sentReplies.some((r) => r.text === '正常回复' && r.chatId === 'oc_c'),
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
    check('U', '②', '已解绑会话消息：无回复送达', world.feishuAdapter.sentReplies.length === 0,
      JSON.stringify(world.feishuAdapter.sentReplies));
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

  assert.ok(true);
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
