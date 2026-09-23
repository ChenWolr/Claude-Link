// manager.ts — BridgeManager：平台生命周期 / 入站管线（owner 判定 + slash 命令 + debounce
// 缓冲 + 串行 flush）/ 回复分发 / 状态表。零 electron 依赖，全部能力经 deps 注入（生产接线见 init.ts）。
// 管线语义移植自 openhanako (Apache-2.0) lib/bridge/bridge-manager.ts（入站 debounce 2s、
// 回复正交原则 #1607、未知 slash 不拦截防吞消息、busy 有限重试防轰炸）。

import type { BridgeInboundMessage, BridgePlatform, BridgePlatformStatusEntry, BridgeAdapterStatus } from '../../../shared/types/bridge';
import type { BridgeProfilesStored } from './profiles';
import type { BridgeTurnResult } from './dispatcher';
import { isBridgeOwner } from './owner-policy';
import { parseBridgeSessionKey } from '../../../shared/bridge/session-key';

export interface BridgeBindingInput {
  platform: BridgePlatform;
  sessionKey: string;
  userId: string;
  chatId: string;
  displayName: string | null;
  sessionId: string;
}

interface BridgeManagerAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendReply(chatId: string, text: string): Promise<void>;
}

export interface BridgeManagerDeps {
  dispatcher: (sessionId: string, text: string) => Promise<BridgeTurnResult>;
  createSession: (name: string, model: string, workingDir: string | null) => { id: string };
  getBinding: (sessionKey: string) => (BridgeBindingInput & { id?: string }) | null;
  upsertBinding: (b: BridgeBindingInput) => unknown;
  rebind: (sessionKey: string, newSessionId: string) => void;
  touch: (sessionKey: string) => void;
  getSessionRow: (id: string) => unknown | null; // 判绑定悬空（UI 删了会话）
  /** V14 解绑墓碑判定：true=该用户已被解绑，flush 须忽略其消息（不悬空重建）。 */
  isUnbound: (sessionKey: string) => boolean;
  resolveModel: () => string;
  profiles: () => BridgeProfilesStored; // 实时读（owner/workingDir）
  saveFeishuOwner: (openId: string) => void; // 首个私聊用户自动捕获
  interruptTurn: (sessionId: string) => void;
  adapters: {
    feishu: (hooks: { onMessage: (m: BridgeInboundMessage) => void; onStatus: (s: BridgeAdapterStatus) => void }) => BridgeManagerAdapter | null;
    wechat: (hooks: { onMessage: (m: BridgeInboundMessage) => void; onStatus: (s: BridgeAdapterStatus) => void }) => BridgeManagerAdapter | null;
  };
  debounceMs?: number; // 默认 2000（流式合并窗口；batch 模式固定）
  busyRetryMs?: number; // 默认 5000
  afterTurnFlushMs?: number; // 默认 500
  sendRetryMs?: number; // 发送失败重试间隔，默认 2000
  onStatusChanged?: (statuses: BridgePlatformStatusEntry[]) => void;
}

interface SessionBuffer {
  lines: string[];
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  busyRetries: number;
}

const PLATFORM_LABEL: Record<BridgePlatform, string> = { feishu: '飞书', wechat: '微信' };
const SLASH_COMMANDS = new Set(['/new', '/stop']);
const FORCE_FLUSH_LINES = 20;
const FORCE_FLUSH_CHARS = 20_000;
const BUSY_MAX_RETRIES = 3;

export class BridgeManager {
  private readonly deps: BridgeManagerDeps;
  private readonly buffers = new Map<string, SessionBuffer>();
  private readonly adapters = new Map<BridgePlatform, BridgeManagerAdapter>();
  private readonly statuses = new Map<BridgePlatform, { status: string; error?: string }>();
  // P1：/stop 置位的用户中断标记（per sessionKey）。sdk-backend 出口先 deleteEntry 再 emitExit，
  // dispatcher 对中断回合只能兜底判 'error'——flush 处凭此标记把该 'error' 按 interrupted 处理
  //（时序机制钉在 tdd-bridge-dispatcher-verify [8]，行为钉在 tdd-bridge-manager-verify [Q]）。
  private readonly interruptedTurns = new Set<string>();

  constructor(deps: BridgeManagerDeps) {
    this.deps = deps;
  }

  // ── 生命周期 ──

  async startPlatform(p: BridgePlatform): Promise<void> {
    await this.stopPlatform(p);
    const adapter = this.deps.adapters[p]({
      onMessage: (m) => this.handleInbound(m),
      onStatus: (s) => this.handleAdapterStatus(p, s),
    });
    if (!adapter) {
      // B15：凭据未填全 → 不启动 + 状态 error 提示。
      this.setStatus(p, { status: 'error', error: '凭据未配置完整，请先在设置页填写并保存' });
      return;
    }
    this.adapters.set(p, adapter);
    this.setStatus(p, { status: 'connecting' });
    await adapter.start();
  }

  async stopPlatform(p: BridgePlatform, opts?: { clearBuffers?: boolean }): Promise<void> {
    // R1-P3d：clearBuffers=true（禁用平台）时清该平台在途缓冲——否则缓冲照跑、回复因适配器
    // 已移除而静默丢。默认 false：startPlatform 重启路径（保存凭据后 stop→create→start）也先
    // stop，无条件清会让「用户保存一次凭据」丢掉在途缓冲消息。running 中的在途 flush 不打断，
    // 其回复发送时适配器缺失 → 走 reply 的平台已停用日志路径。
    if (opts?.clearBuffers) {
      for (const [key, buf] of this.buffers) {
        if (parseBridgeSessionKey(key)?.platform !== p) continue;
        this.clearBufferTimer(buf);
        buf.lines = [];
        buf.busyRetries = 0;
      }
    }
    const adapter = this.adapters.get(p);
    if (!adapter) return;
    this.adapters.delete(p);
    await adapter.stop();
    this.setStatus(p, { status: 'disconnected' });
  }

  /**
   * 解绑收口（生命周期修复批次1）：清该用户在途缓冲与免消息复活定时器（debounce/busy 重试
   * 定时器；afterTurnFlush 因 lines 清空不再触发），消费残留中断标记。墓碑置位在 binding-repo
   * （init.ts bridgeUnbind 先 DB 后调本方法）；不打断 running 中的在途回合（N4 保留语义）。
   */
  unbind(sessionKey: string): void {
    const buf = this.buffers.get(sessionKey);
    if (buf) {
      this.clearBufferTimer(buf);
      buf.lines = [];
      buf.busyRetries = 0;
    }
    this.interruptedTurns.delete(sessionKey);
  }

  async stopAll(): Promise<void> {
    for (const p of ['feishu', 'wechat'] as const) {
      // 退出全清统一走 clearBuffers：清各平台 pending 定时器与缓冲，防退出后幽灵 flush（B14）。
      await this.stopPlatform(p, { clearBuffers: true });
    }
  }

  getStatus(): BridgePlatformStatusEntry[] {
    const out: BridgePlatformStatusEntry[] = [];
    for (const p of ['feishu', 'wechat'] as const) {
      const s = this.statuses.get(p);
      if (s) out.push({ platform: p, status: s.status as BridgePlatformStatusEntry['status'], error: s.error });
    }
    return out;
  }

  private setStatus(p: BridgePlatform, s: { status: string; error?: string }): void {
    this.statuses.set(p, s);
    this.deps.onStatusChanged?.(this.getStatus());
  }

  private handleAdapterStatus(p: BridgePlatform, s: BridgeAdapterStatus): void {
    this.setStatus(p, s);
  }

  // ── 入站管线（唯一入口，adapter onMessage 接此）──

  handleInbound(m: BridgeInboundMessage): void {
    if (m.isGroup) return; // phase 1 仅私聊
    // B1：空文本/纯空格忽略不派发。
    if (!m.text || !m.text.trim()) return;

    if (m.platform === 'feishu') {
      const ownerOpenId = this.deps.profiles().feishu.ownerOpenId;
      if (!ownerOpenId) {
        // 首个私聊用户自动捕获为 owner 并继续处理。
        this.deps.saveFeishuOwner(m.userId);
      } else if (!isBridgeOwner('feishu', m.userId, ownerOpenId)) {
        return; // 非 owner：无会话创建、无回复（判定唯一事实源：owner-policy，P3c）
      }
    }
    // wechat：任何私聊用户即 owner（owner-policy 语义）。

    // slash 拦截：owner-only 命令；未知 /x 不拦截，当普通文本进 LLM（防吞消息）。
    const trimmed = m.text.trim();
    if (trimmed.startsWith('/') && SLASH_COMMANDS.has(trimmed.split(/\s/)[0] ?? trimmed)) {
      void this.handleSlashCommand(m, trimmed.split(/\s/)[0] ?? trimmed);
      return;
    }

    // 缓冲：running → 仅 push（无定时）；空闲 → push + debounce 定时；超限 force flush。
    const buf = this.buffers.get(m.sessionKey) ?? { lines: [], timer: null, running: false, busyRetries: 0 };
    this.buffers.set(m.sessionKey, buf);
    buf.lines.push(m.text);
    if (buf.running) return;

    const totalLen = buf.lines.reduce((n, l) => n + l.length, 0);
    if (buf.lines.length >= FORCE_FLUSH_LINES || totalLen >= FORCE_FLUSH_CHARS) {
      this.clearBufferTimer(buf);
      void this.flush(m.sessionKey, m);
      return;
    }
    this.clearBufferTimer(buf);
    buf.timer = setTimeout(() => {
      buf.timer = null;
      void this.flush(m.sessionKey, m);
    }, this.deps.debounceMs ?? 2000);
  }

  private clearBufferTimer(buf: SessionBuffer): void {
    if (buf.timer) {
      clearTimeout(buf.timer);
      buf.timer = null;
    }
  }

  private async handleSlashCommand(m: BridgeInboundMessage, cmd: string): Promise<void> {
    const label = PLATFORM_LABEL[m.platform];
    if (cmd === '/new') {
      // 新会话 + 换绑；无旧绑定时直接建绑定。
      const session = this.deps.createSession(`${label} ${m.senderName}`, this.deps.resolveModel(), this.deps.profiles().global.workingDir);
      const existing = this.deps.getBinding(m.sessionKey);
      if (existing) {
        this.deps.rebind(m.sessionKey, session.id);
      } else {
        this.deps.upsertBinding({
          platform: m.platform, sessionKey: m.sessionKey, userId: m.userId,
          chatId: m.chatId, displayName: m.senderName, sessionId: session.id,
        });
      }
      await this.reply(m, '已开启新会话，之后的对话将在此会话中进行。');
      return;
    }
    if (cmd === '/stop') {
      const binding = this.deps.getBinding(m.sessionKey);
      if (binding) {
        // P1：置中断标记再 interrupt——dispatcher 对中断回合只能兜底判 'error'（见 interruptedTurns 注），
        // flush 处凭此标记按 interrupted 处理，不再误发「回复生成失败」。
        // R2-N1：仅在有在途回合（running）时才置标记——空闲 /stop（或 busy 重试间隙）的
        // interruptTurn 本就 no-op，置标记会残留并被下一个无关回合结算消费，误吞其失败提示。
        if (this.buffers.get(m.sessionKey)?.running === true) {
          this.interruptedTurns.add(m.sessionKey);
        }
        this.deps.interruptTurn(binding.sessionId);
      }
      await this.reply(m, '已中断');
    }
  }

  /** 绑定解析 + 悬空重建 + 串行 flush（per sessionKey）。 */
  private async flush(sessionKey: string, lastMsg: BridgeInboundMessage, retryDepth = 0): Promise<void> {
    const buf = this.buffers.get(sessionKey);
    if (!buf || buf.running || buf.lines.length === 0) return;
    const lines = buf.lines;
    buf.lines = [];
    buf.running = true;
    try {
      let binding = this.deps.getBinding(sessionKey);
      // B7：绑定不存在或会话被 UI 删除（悬空）→ 自动重建绑定+新会话；
      // 绑定已被用户解绑（V14 墓碑，getBinding 已过滤不可见）→ 忽略本批（不重建、不派发）。
      if (binding && !this.deps.getSessionRow(binding.sessionId)) {
        binding = null; // 会话被 UI 删除 → 悬空，走下方重建
      }
      if (!binding) {
        if (this.deps.isUnbound(sessionKey)) {
          buf.busyRetries = 0;
          console.info(`[bridge] 已解绑会话的消息被忽略（sessionKey=${sessionKey}，${lines.length} 条）`);
          return; // 在 finally 中 running 复位、lines 已取走清空，不触发积压补发
        }
        const label = PLATFORM_LABEL[lastMsg.platform];
        const session = this.deps.createSession(`[${label}] ${lastMsg.senderName}`, this.deps.resolveModel(), this.deps.profiles().global.workingDir);
        this.deps.upsertBinding({
          platform: lastMsg.platform, sessionKey, userId: lastMsg.userId,
          chatId: lastMsg.chatId, displayName: lastMsg.senderName, sessionId: session.id,
        });
        binding = this.deps.getBinding(sessionKey);
      }
      if (!binding) return; // upsert 后仍取不到（异常），放弃本批
      this.deps.touch(sessionKey);

      const result = await this.deps.dispatcher(binding.sessionId, lines.join('\n'));

      if (result.busy) {
        // B6/B18：互斥拒绝 → 整次 flush 有限重试；内容塞回队首（不丢不重）。
        buf.busyRetries += 1;
        buf.lines = [...lines, ...buf.lines];
        if (buf.busyRetries > BUSY_MAX_RETRIES) {
          buf.lines = [];
          buf.busyRetries = 0;
          // 超出丢弃 + 记录（绝不无限重试，防重复轰炸）；中断标记一并清，防残留误吞后续失败提示（P1）。
          this.interruptedTurns.delete(sessionKey);
          console.error(`[bridge] busy 重试超限（${BUSY_MAX_RETRIES} 次），丢弃本批 ${lines.length} 条缓冲消息（sessionKey=${sessionKey}）`);
          return;
        }
        buf.running = false;
        // 重试定时器入 buf.timer：stopAll 统一清理，防退出后幽灵 flush（B14）。
        buf.timer = setTimeout(() => {
          buf.timer = null;
          void this.flush(sessionKey, lastMsg, retryDepth + 1);
        }, this.deps.busyRetryMs ?? 5000);
        return;
      }
      buf.busyRetries = 0;

      // P1：消费并清除 /stop 中断标记（任何完成结算的回合都清，防残留）。
      const userInterrupted = this.interruptedTurns.delete(sessionKey);
      // 回复正交（openhanako #1607）：error 只进日志；完全没有可见正文才提示失败。
      if (result.outcome === 'interrupted') return; // 用户主动 /stop，不打扰
      if (userInterrupted && result.outcome === 'error') return; // /stop 中断被 exit 兜底误判成 error（P1）：静默
      if (result.replyText && result.replyText.trim()) {
        await this.reply(lastMsg, result.replyText);
      } else if (result.outcome === 'error') {
        await this.reply(lastMsg, '回复生成失败，请稍后重试');
      } else {
        // success + 空正文（B17）：不发任何 IM 消息。
      }
    } finally {
      buf.running = false;
      // R3-N3：清掉活到 finally 的中断标记——标记结算消费点在上方 reply 之前，凡此时仍存在的
      // 标记必为 reply 发送尾窗（running 已 true）置入的陈旧标记，残留会被下一个无关回合结算
      // 消费、误吞其失败提示；mid-turn 置入的标记已在结算处消费（此处 delete 幂等）。
      this.interruptedTurns.delete(sessionKey);
      // 积压补发：回合结束后 afterTurnFlushMs 内 flush（B3）。
      if (buf.lines.length > 0 && !buf.timer) {
        buf.timer = setTimeout(() => {
          buf.timer = null;
          void this.flush(sessionKey, lastMsg);
        }, this.deps.afterTurnFlushMs ?? 500);
      }
    }
  }

  /**
   * 发送回复：失败 2s 后重试 1 次 → 仍失败记日志（B8，绝不无限重试）。
   * 飞书为单条消息整条重试，重复窗口仅「请求到达对端但响应超时」场景，系计划 B8 明示语义；
   * 微信多分段的重复段去重由 wechat-ilink 的断点续传承接（R1-P3h）。
   */
  private async reply(m: BridgeInboundMessage, text: string): Promise<void> {
    const adapter = this.adapters.get(m.platform);
    if (!adapter) {
      // R1-P3d：平台已停用（禁用/重启间隙）时缓冲照跑的回复不再静默丢——留诊断日志。
      console.error(`[bridge] ${m.platform} 回复发送跳过：平台已停用（chatId=${m.chatId}，正文前 50 字=${text.slice(0, 50)}）`);
      return;
    }
    try {
      await adapter.sendReply(m.chatId, text);
      return;
    } catch (firstErr) {
      await new Promise((r) => setTimeout(r, this.deps.sendRetryMs ?? 2000));
      try {
        await adapter.sendReply(m.chatId, text);
        return;
      } catch (secondErr) {
        // 状态事件：log 记录（渲染层状态通道不新增，避免超影响面）。
        console.error(`[bridge] ${m.platform} 回复发送失败（已重试 1 次）：${String(secondErr instanceof Error ? secondErr.message : secondErr)}；首次：${String(firstErr instanceof Error ? firstErr.message : firstErr)}`);
      }
    }
  }
}
