// dispatcher.ts — bridge 回合调度器（同构 CHAT_SEND 管线，依赖注入化）。
// 不 import sdk-backend（仅 type 导入 SdkQueryHandle，编译期擦除）——引擎原语全部经
// TurnEngineDeps 注入，生产侧由 bridge/init.ts 绑定真函数，契约脚本注入 fake 独立测试。
// 语句序与 CHAT_SEND（ipc-handlers.ts :569-711）严格同构：互斥检查 → 加锁 → 落库 user 行
// → spawn 占坑 → beginUserTurn → sendMessage 喂首 prompt → await 回合终态 → finally 释放锁。

// sdk-backend 的 SdkQueryHandle 未导出且本计划禁改该文件——按其真实形状（sdk-backend.ts :696-701）
// 本地声明结构化等价类型：TypeScript 结构化类型下与真句柄互通，契约脚本 fake 同形即可。
interface BridgeQueryHandle {
  killed: boolean;
  on(event: 'exit', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  interrupt(): void;
}

export interface TurnEngineDeps {
  spawnForChat(sessionId: string, opts: unknown): BridgeQueryHandle;
  sendMessage(sessionId: string, prompt: string): void;
  getActiveProcess(sessionId: string): BridgeQueryHandle | undefined;
  getKnownTurnOutcome(sessionId: string): 'success' | 'error' | 'interrupted' | null;
  beginUserTurn(sessionId: string): void;
  noteTurnOutcome(sessionId: string, outcome: 'success' | 'error' | 'interrupted'): void;
  isChatSendLocked(sessionId: string): boolean;
  acquireChatSendLock(sessionId: string): void;
  releaseChatSendLock(sessionId: string): void;
  getConfigMaxTurns(): number;
  getSessionRow(sessionId: string): {
    model: string;
    modelOverride: string | null;
    providerOverride: string | null;
    workingDir: string | null;
    permissionMode: string | null;
    thinkingLevel: string | null;
    cliSessionId: string | null;
  } | null;
}

export interface TurnPersistenceDeps {
  persistUserMessage(sessionId: string, text: string): void;
  /** findLastTurnMainFlowAssistantId + getRecentMessagesForTurnCheck 取 content（生产形态见 init.ts）。 */
  findReplyText(sessionId: string): string | null;
}

export interface BridgeTurnResult {
  outcome: 'success' | 'error' | 'interrupted';
  replyText: string | null;
  busy?: boolean;
}

export async function dispatchBridgeTurn(
  engine: TurnEngineDeps,
  persistence: TurnPersistenceDeps,
  sessionId: string,
  text: string,
): Promise<BridgeTurnResult> {
  const session = engine.getSessionRow(sessionId);
  if (!session) return { outcome: 'error', replyText: null }; // 调用方负责重建绑定后重试一次
  if (engine.isChatSendLocked(sessionId) || engine.getActiveProcess(sessionId)) {
    return { outcome: 'error', replyText: null, busy: true }; // 同构 CHAT_SEND :589 互斥
  }
  let locked = false;
  try {
    engine.acquireChatSendLock(sessionId);
    locked = true;
    persistence.persistUserMessage(sessionId, text);
    const child = engine.spawnForChat(sessionId, {
      model: session.model,
      modelOverride: session.modelOverride,
      providerOverride: session.providerOverride,
      workingDir: session.workingDir,
      maxTurns: engine.getConfigMaxTurns(), // F2：第四路执行链同源全局设置
      permissionMode: session.permissionMode,
      thinkingLevel: session.thinkingLevel,
      resumeSessionId: session.cliSessionId,
      userCommandText: text,
      hasAttachments: false,
    });
    // exitPromise 在 spawn 后立即构造（回调先于 sendMessage 注册，不丢首回合事件）。
    const exitPromise = new Promise<'success' | 'error' | 'interrupted'>((resolve) => {
      child.on('exit', (code) => {
        const active = engine.getActiveProcess(sessionId);
        if (active && active !== child) {
          // 代际守卫（同构 CHAT_SEND :655）：旧回合迟到 exit 不做队列记账；
          // 本 Promise 仍以已知终态结算，不能悬挂（否则 bridge 侧回合永远等不到）。
          resolve(engine.getKnownTurnOutcome(sessionId) ?? 'error');
          return;
        }
        const known = engine.getKnownTurnOutcome(sessionId);
        if (known) {
          resolve(known); // 显式终态优先（hb12-P2-2）
          return;
        }
        // 已知 limitation（2026-09-21 review P1）：sdk-backend 所有出口先 deleteEntry 再 emitExit，
        // 故走到此兜底时 getKnownTurnOutcome 恒为 null（entry 已从 entries 移除），只能按退出码分类：
        // ① /stop kill 与流丢 result 的合成 aborted 出口均 emitExit(null) → 中断回合被误判 'error'——
        //    bridge/manager 在 /stop 时对本 sessionKey 置中断标记并在 flush 消费（按 interrupted 静默，
        //    行为钉在 tdd-bridge-manager-verify [Q]，时序钉在 tdd-bridge-dispatcher-verify [8]）；
        // ② error-result 出口同样 emitExit(0) → 真实错误回合被误判 'success'。接受现状：有 partial
        //    文本时 replyText 取持久层真实文本、行为仍正确；空正文则按 B17 静默不发。dispatcher 层
        //    无中断信息可辨，不在本层猜测终态。
        const fallback = code === 0 ? 'success' : 'error';
        engine.noteTurnOutcome(sessionId, fallback); // result 丢失兜底，防僵尸 running（B5）
        resolve(fallback);
      });
      child.on('error', () => {
        resolve(engine.getKnownTurnOutcome(sessionId) ?? 'error');
      });
    });
    engine.beginUserTurn(sessionId);
    // 与 CHAT_SEND 同步序列：spawn 占坑后立即喂首 prompt（sendMessage 只把 pending 交给
    // runQuery，真正的 exit 回调要等 SDK 流结束才触发，先后不影响终态时序）。
    engine.sendMessage(sessionId, text);
    const outcome = await exitPromise;
    return { outcome, replyText: outcome === 'success' ? persistence.findReplyText(sessionId) : null };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { outcome: 'error', replyText: null, busy: msg.includes('仍在执行') }; // B18：spawn 同步拒 → busy
  } finally {
    if (locked) engine.releaseChatSendLock(sessionId);
  }
}
