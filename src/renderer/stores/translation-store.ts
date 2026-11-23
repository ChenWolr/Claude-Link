// translation-store.ts
// AI 回复翻译（2026-11-19 UI 五点批次 P5）渲染层投影缓存（pinia）。状态源在主进程
//（translation-service translationId→entry 表；GET_STATE 可查、TRANSLATION_EVENT 推送增量），
// 本 store 仅做投影：收录推送、按 target 建索引、维护变体三的纯视图态 showingTranslation。
// 禁做权威源——刷新/重连后经 restore(GET_STATE) 重建（01 §5.4①）。
//
// 变体三视图态（2026-11-20 修订）：
//  - showingTranslation=true → 正文位渲染译文（沉浸替换）；swap pill 切换（toggleShowing，
//    纯视图切换，不 STOP 不发 invoke）；STOP 置 false（回落原文）；restore 重建缺省 true。
//  - 「中止」只由入口钮 translating 态点击（stop 动作）触发——swap 与生命周期严格分离。

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useSessionStore } from './session-store';
import type {
  TranslationEventPayload,
  TranslationStateView,
  TranslationStatus,
  TranslationTarget,
} from '../../shared/translation-core';

/** 渲染层投影条目：主进程状态视图 + 纯渲染层视图态（showingTranslation）+ START 拒绝重试源。 */
export interface TranslationEntryView extends TranslationStateView {
  /** 变体三视图态：true=正文位显示译文（缺省 true）；swap pill 切换；STOP 置 false。 */
  showingTranslation: boolean;
  /** 仅 START 被主进程拒绝（空文本/超长/无凭据，零 HTTP）时存在：拒绝态重试的源文本（渲染层自持——
   *  主进程无此 entry，translateRetry 不可用，重试=同参重发 START）。 */
  lastSource?: string;
}

/** target 渲染层索引键：'msg:<messageId>' / 'think:<messageId>' / 'stream' / 'think-stream'。 */
export function targetKeyOf(target: TranslationTarget): string {
  switch (target.kind) {
    case 'message':
      return `msg:${target.messageId}`;
    case 'thinking':
      return `think:${target.messageId}`;
    case 'stream':
      return 'stream';
    case 'thinking-stream':
      return 'think-stream';
  }
}

// ── showingTranslation 跨刷新持久化（p5c 修正，2026-11-20，契约 T8「收起态刷新后不闪现译文」）──
// 显示态是纯渲染层视图态（toggleShowing 不发 invoke），刷新后 restore 拿不到它、缺省 true 会把
// 用户已收起的译文闪现回来（W-translate-reopen-collapsed 首跑实测）。localStorage 以 translationId
// 为键记用户最后一次显/隐选择（页面刷新主进程不动 → translationId 稳定）；restore 的 liveIds 过滤
// + pruneShowingKeys 兜底清理死键。localStorage 不可用（异常环境）静默回落缺省 true——降级形态
// = 修正前行为，不劣化。web 非安全上下文（http://局域网IP）localStorage 仍可用，双端同源。
const SHOWING_KEY_PREFIX = 'claude-link.tr-showing.';

function showingStorageKey(sessionId: string, translationId: string): string {
  return `${SHOWING_KEY_PREFIX}${sessionId}.${translationId}`;
}

function readShowingPersisted(sessionId: string, translationId: string): boolean | null {
  try {
    const v = window.localStorage.getItem(showingStorageKey(sessionId, translationId));
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

function writeShowingPersisted(sessionId: string, translationId: string, showing: boolean): void {
  try {
    window.localStorage.setItem(showingStorageKey(sessionId, translationId), showing ? '1' : '0');
  } catch {
    /* 尽力而为（不可用环境回落缺省 true） */
  }
}

/** restore 收尾清理：该会话已不在主进程 live 集合的持久化键移除（防无界累积）。 */
function pruneShowingKeys(sessionId: string, liveIds: ReadonlySet<string>): void {
  try {
    const prefix = `${SHOWING_KEY_PREFIX}${sessionId}.`;
    const dead: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k !== null && k.startsWith(prefix) && !liveIds.has(k.slice(prefix.length))) dead.push(k);
    }
    for (const k of dead) window.localStorage.removeItem(k);
  } catch {
    /* 尽力而为 */
  }
}

export const useTranslationStore = defineStore('translation', () => {
  // ── state ──
  const byId = ref<Record<string, TranslationEntryView>>({});
  /** `${sessionId}:${targetKey}` → translationId（forTarget 直查索引）。 */
  const targetIndex = ref<Record<string, string>>({});

  // ── getter ──
  const forTarget = computed(() => {
    return (sessionId: string | undefined | null, target: TranslationTarget): TranslationEntryView | undefined => {
      if (!sessionId) return undefined;
      const id = targetIndex.value[`${sessionId}:${targetKeyOf(target)}`];
      return id ? byId.value[id] : undefined;
    };
  });

  // ── 内部工具 ──
  function indexKeyOf(sessionId: string, target: TranslationTarget): string {
    return `${sessionId}:${targetKeyOf(target)}`;
  }

  /** 删除投影条目并清空指向它的全部索引键（幂等）。 */
  function removeEntry(translationId: string): void {
    if (!(translationId in byId.value)) return;
    const next = { ...byId.value };
    delete next[translationId];
    byId.value = next;
    const nextIndex = { ...targetIndex.value };
    for (const key of Object.keys(nextIndex)) {
      if (nextIndex[key] === translationId) delete nextIndex[key];
    }
    targetIndex.value = nextIndex;
  }

  function registerMapping(key: string, translationId: string): void {
    const prev = targetIndex.value[key];
    // 同键换 id 只发生在渲染层陈旧残留（主进程同 target 的 translationId 稳定复用）：
    // START 拒绝占位条目（rejected:*）被真实条目取代时清掉，防 byId 泄漏。
    if (prev && prev !== translationId && prev.startsWith('rejected:')) removeEntry(prev);
    if (targetIndex.value[key] !== translationId) {
      targetIndex.value = { ...targetIndex.value, [key]: translationId };
    }
  }

  function upsertEntry(entry: TranslationEntryView): void {
    byId.value = { ...byId.value, [entry.translationId]: entry };
    registerMapping(indexKeyOf(entry.sessionId, entry.target), entry.translationId);
  }

  // ── actions ──

  /**
   * START（幂等扩展语义：流式增长重复调安全——主进程同 target 复用同一 entry 续译）。
   * opts.showingTranslation：迁移路径显式承接旧视图态（finalizeStreamTranslation 用）；
   * 缺省时新建条目为 true、已存在条目不动（流式扩展不得清掉用户 swap 后的「查看原文」态），
   * 唯 stopped 态的显式重开（入口钮点击）回到 true（用户重新要求显示译文）。
   * START 被拒（空文本/超长/无凭据，零 HTTP）→ 渲染层建 rejected:* 占位条目（error 态，
   * 视口错误横条 + 入口钮「重试」可见失败原因；重试=同参重发 START）。
   */
  async function start(
    sessionId: string,
    target: TranslationTarget,
    sourceText: string,
    opts?: { showingTranslation?: boolean },
  ): Promise<void> {
    const key = indexKeyOf(sessionId, target);
    try {
      const res = await window.claudeLink.translateStart(sessionId, target, sourceText);
      if (!res.ok) {
        upsertEntry({
          translationId: `rejected:${key}`,
          sessionId,
          target,
          status: 'error',
          segments: [],
          totalSegments: 0,
          error: res.error,
          showingTranslation: opts?.showingTranslation ?? true,
          lastSource: sourceText,
        });
        return;
      }
      const existing = byId.value[res.translationId];
      if (existing) {
        // 主进程复用同一 entry（幂等扩展/重开）：视图态按 opts/重开语义收敛，增量走推送。
        const showing = opts?.showingTranslation ?? (existing.status === 'stopped' ? true : existing.showingTranslation);
        upsertEntry({ ...existing, showingTranslation: showing, target, sessionId });
        writeShowingPersisted(sessionId, res.translationId, showing);
        return;
      }
      upsertEntry({
        translationId: res.translationId,
        sessionId,
        target,
        status: 'translating',
        segments: [],
        totalSegments: 0,
        showingTranslation: opts?.showingTranslation ?? true,
      });
      writeShowingPersisted(sessionId, res.translationId, opts?.showingTranslation ?? true);
    } catch (err) {
      // invoke 失败（网页桥未连接等）：error 态可重试（01 §5.7「刷新/重连」行）。
      upsertEntry({
        translationId: `rejected:${key}`,
        sessionId,
        target,
        status: 'error',
        segments: [],
        totalSegments: 0,
        error: err instanceof Error ? err.message : '翻译请求失败',
        showingTranslation: opts?.showingTranslation ?? true,
        lastSource: sourceText,
      });
    }
  }

  /** STOP：中止 + 回落原文（唯一「中止」路径；缓存与已译段保留）。swap pill 绝不走这里。 */
  async function stop(translationId: string): Promise<void> {
    const entry = byId.value[translationId];
    if (entry) {
      upsertEntry({ ...entry, showingTranslation: false });
    }
    try {
      await window.claudeLink.translateStop(translationId);
    } catch {
      // 中止失败不阻塞 UI：视图已回落原文；主进程终态事件到达后 status 跟随。
    }
  }

  /** RETRY：仅失败段（已完成段走缓存不重复计费）。START 拒绝占位条目重试=同参重发 START。 */
  async function retry(translationId: string): Promise<void> {
    const entry = byId.value[translationId];
    if (!entry) return;
    if (translationId.startsWith('rejected:')) {
      await start(entry.sessionId, entry.target, entry.lastSource ?? '');
      return;
    }
    try {
      await window.claudeLink.translateRetry(translationId);
    } catch {
      // 重试失败不静默改状态：错误横条保留，用户可再次点击。
    }
  }

  /** App.vue 全局订阅回调（TRANSLATION_EVENT）：无脑收录（量小：每翻译 80ms 一帧），UI 按
   *  target 挂载点过滤渲染。started→建/更新 entry（已有条目保留 segments 与 showingTranslation
   *  ——幂等扩展与迁移承接语义）；delta→写 segments[idx]（段内全量替换幂等）；终态→写 status。 */
  function handleEvent(payload: TranslationEventPayload): void {
    const existing = byId.value[payload.translationId];
    const base: TranslationEntryView = existing ?? {
      translationId: payload.translationId,
      sessionId: payload.sessionId,
      target: payload.target,
      status: 'translating',
      segments: [],
      totalSegments: 0,
      // 缺省视图态：stopped 事件缺位重建（双端共享进度流）回落原文；其余缺省显示译文。
      showingTranslation: payload.kind !== 'stopped',
    };
    const totalSegments = payload.totalSegments ?? base.totalSegments;
    switch (payload.kind) {
      case 'started': {
        upsertEntry({ ...base, sessionId: payload.sessionId, target: payload.target, status: 'translating', totalSegments, error: undefined });
        break;
      }
      case 'delta': {
        const idx = payload.segmentIndex ?? -1;
        if (idx < 0) break;
        const segments = base.segments.filter((s) => s.index !== idx);
        segments.push({ index: idx, translated: payload.text ?? '' });
        segments.sort((a, b) => a.index - b.index);
        upsertEntry({ ...base, segments, totalSegments });
        break;
      }
      case 'done': {
        upsertEntry({ ...base, sessionId: payload.sessionId, target: payload.target, status: 'done', totalSegments, error: undefined });
        break;
      }
      case 'error': {
        upsertEntry({ ...base, sessionId: payload.sessionId, target: payload.target, status: 'error', totalSegments, error: payload.error ?? '翻译失败' });
        break;
      }
      case 'stopped': {
        upsertEntry({ ...base, sessionId: payload.sessionId, target: payload.target, status: 'stopped', totalSegments, error: undefined });
        break;
      }
    }
  }

  /**
   * 刷新/重连后重挂载：GET_STATE 重建该会话投影。重挂载 showingTranslation 缺省 true
   * （重挂载即显示译文）；已有条目（既有 entry 直查/双端共享）保留其视图态（缺省语义：
   * 「缺省 true」只作用于缺席者）。主进程已不存在而渲染层残留的该会话条目一并清除。
   */
  async function restore(sessionId: string): Promise<void> {
    let states: TranslationStateView[];
    try {
      states = await window.claudeLink.getTranslationStates(sessionId);
    } catch {
      return; // 网页桥未连接等：静默（翻译本就是伴随功能）
    }
    const liveIds = new Set(states.map((s) => s.translationId));
    for (const id of Object.keys(byId.value)) {
      const entry = byId.value[id];
      if (entry && entry.sessionId === sessionId && !liveIds.has(id)) removeEntry(id);
    }
    for (const state of states) {
      const existing = byId.value[state.translationId];
      upsertEntry({
        ...state,
        segments: [...state.segments].sort((a, b) => a.index - b.index),
        // 用户最后一次显/隐选择优先（p5c 修正：收起态刷新不闪现译文）；无记录回落缺省 true。
        showingTranslation: existing?.showingTranslation ?? (readShowingPersisted(sessionId, state.translationId) ?? true),
      });
    }
    pruneShowingKeys(sessionId, liveIds);
  }

  /** swap pill 专用：纯视图切换（不 STOP、不发 invoke）。切回原文期间翻译在主进程后台继续。
   *  切换结果持久化（p5c 修正）：跨刷新记住用户显/隐选择（T8「收起态刷新不闪现译文」）。 */
  function toggleShowing(translationId: string): void {
    const entry = byId.value[translationId];
    if (!entry) return;
    const showing = !entry.showingTranslation;
    upsertEntry({ ...entry, showingTranslation: showing });
    writeShowingPersisted(entry.sessionId, translationId, showing);
  }

  /**
   * 正文迁移（流式→落库，回合 result/aborted 边沿由 use-chat 调）：stream target entry 在场时，
   * 以落库消息 id + 同文 START 重建 message target entry——段级缓存全命中零重译零重复计费；
   * showingTranslation 承接旧值保持替换态连续（译文在落库气泡正文位继续显示/补齐）。
   * 无流式 entry（用户未开翻译）→ 静默 no-op（绝不凭空为落库消息建翻译）。
   * 找不到消息 id 时调用方（use-chat）静默丢弃（缓存仍保证之后手点零计费）。
   * 迁移 START 后补一次 restore：缓存命中段不发 delta（主进程 fillSegments 预填 done），
   * 仅靠推送渲染层拿不到已译段文本，GET_STATE 拉全量投影补齐。
   */
  async function finalizeStreamTranslation(sessionId: string, messageId: string, finalText: string): Promise<void> {
    const streamEntry = forTarget.value(sessionId, { kind: 'stream' });
    if (!streamEntry) return;
    const inherited = streamEntry.showingTranslation;
    await start(sessionId, { kind: 'message', messageId }, finalText, { showingTranslation: inherited });
    void restore(sessionId);
  }

  /** 思考迁移（thinking-stream → thinking，同法）。 */
  async function finalizeThinkingStreamTranslation(sessionId: string, messageId: string, finalText: string): Promise<void> {
    const streamEntry = forTarget.value(sessionId, { kind: 'thinking-stream' });
    if (!streamEntry) return;
    const inherited = streamEntry.showingTranslation;
    await start(sessionId, { kind: 'thinking', messageId }, finalText, { showingTranslation: inherited });
    void restore(sessionId);
  }

  // F1（2026-11-21 验收报告）：断线重连对齐挂钩——仅网页端注册（形态仿 changes-store：web-bridge
  // 安装时置 __claudeLinkWebBridge 标记，main.ts boot 先 await installWebBridge 再 mount，时序恒成立）。
  // 重连对齐序列收口 → restore(activeSession.id)：断连窗口内完成的段无 delta 重放（WS 无回放），
  // GET_STATE 全量补拉重建投影，覆盖「同 id 重入不触发 id watch」的窗口；无活动会话静默跳过。
  // 桌面端无标记 → 不动态 import，web-bridge chunk 不加载，行为零变化。
  if (typeof window !== 'undefined' && (window as any).__claudeLinkWebBridge === true) {
    void import('../web/web-bridge')
      .then(({ onRealigned }) => onRealigned(() => {
        const id = useSessionStore().activeSession?.id;
        if (id) void restore(id);
      }))
      .catch(() => {
        // web-bridge chunk 加载失败（理论不可达）→ 放弃注册；既有 restore 路径不受影响。
      });
  }

  return {
    byId,
    targetIndex,
    forTarget,
    start,
    stop,
    retry,
    handleEvent,
    restore,
    toggleShowing,
    finalizeStreamTranslation,
    finalizeThinkingStreamTranslation,
  };
});

/** 导出状态类型别名（组件消费态窄化用；TranslationStatus 直出 shared 类型）。 */
export type { TranslationStatus };
