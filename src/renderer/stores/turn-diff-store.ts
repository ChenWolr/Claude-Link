// turn-diff-store.ts
// 轮末文件改动（turn-diff）的渲染层状态：每会话回合摘要缓存、单文件 patch 懒加载缓存、
// 回合结束防抖重拉。真值来自主进程 turn-diff 聚合（SQLite turn_file_checkpoints，P4 已落地），
// 本 store 只做拉取/缓存，不派生任何「进行中」状态——进行中守卫读 session-store 的
// sending（getter）+ turnStartIndex（既有状态源）推导，勿在此新造状态源。
//
// 风格对齐 changes-store：会话激活/切换 watch 重拉、代际守卫丢陈旧结果、sending 下降沿
// 500ms 防抖失效重拉（changes-store:174-187 同款）、patch 懒加载 in-flight 去重 + 可重试错误态。

import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { useSessionStore } from './session-store';
import type { TurnFileDiffMode, TurnFileDiffTurnSummary } from '../../shared/types/turn-file-diff';

/** turnDiff:filePatch 回包（与 preload/api.ts getTurnFilePatch 返回形状一致）。 */
export interface TurnFilePatch {
  mode: TurnFileDiffMode;
  patch: string;
  truncated: boolean;
}

/** 弹窗打开目标（MessageList → TurnDiffDialog）：回合区间 + 文件路径。 */
export interface TurnDiffPatchTarget {
  sessionId: string;
  turnStartMessageId: string;
  endMessageId: string | null;
  path: string;
}

/** patchCache / patchErrors / patchLoading 的键：turnStartMessageId + '|' + path。 */
export function turnDiffPatchKey(turnStartMessageId: string, path: string): string {
  return `${turnStartMessageId}|${path}`;
}

export const useTurnDiffStore = defineStore('turn-diff', () => {
  const sessionStore = useSessionStore();

  // —— 回合摘要（每会话懒缓存；键不存在=未拉取，[]=已拉取且该会话无改动回合）——
  const summariesBySession = ref<Record<string, TurnFileDiffTurnSummary[]>>({});
  const summariesLoading = ref(false);
  const summariesError = ref<string | null>(null);

  // —— 单文件 patch 懒加载（key=turnStart|path；patch 是历史事实，落库后不随回合结束变化）——
  const patchCache = ref(new Map<string, TurnFilePatch>());
  const patchErrors = ref<Record<string, string>>({});
  const patchLoading = ref<Record<string, boolean>>({});

  // 进行中回合守卫（MessageList 卡片抑制用）：sending=true 期间当前回合首条 user 消息 id。
  // 从 session-store 既有状态推导——turnStartIndex 是「最后一条主流程 user 消息的下一位置」
  //（shared/turn-boundary.ts computeTurnStartIndex），故本回合首条 user 消息在 turnStartIndex-1。
  // 用 computed 而非边沿快照：切回运行中会话时 messages 异步重载（turnStartIndex 在其后重算），
  // 派生值天然自洽，不残留陈旧 id。
  const currentTurnStartMessageId = computed<string | null>(() => {
    if (!sessionStore.sending) return null;
    const m = sessionStore.messages[sessionStore.turnStartIndex - 1];
    return m && m.role === 'user' ? m.id : null;
  });

  // 代际计数器：切会话时自增。loadSummaries 发起前抓当前值，await 返回后若已变（期间切了
  // 会话）→ 丢弃结果，不把旧会话数据写进新会话状态（changes-store 同款）。
  let sessionGen = 0;

  // 失效某会话的摘要缓存（回合结束重拉 / 会话切换重拉前调用）。
  function invalidateSummaries(sessionId: string): void {
    if (!(sessionId in summariesBySession.value)) return;
    const next = { ...summariesBySession.value };
    delete next[sessionId];
    summariesBySession.value = next;
  }

  // 懒缓存拉取：已有缓存则跳过（force=true 绕过——重连对齐自愈/失败重试强制重拉）；invalidate 后
  // 由调用方（会话切换 / 回合结束防抖 / 重连对齐回调）触发重拉。
  async function loadSummaries(sessionId: string, force = false): Promise<void> {
    if (!force && summariesBySession.value[sessionId]) return;
    const gen = sessionGen;
    summariesLoading.value = true;
    try {
      const list = await window.claudeLink.listTurnDiffSummaries(sessionId);
      if (gen !== sessionGen) return; // 期间切会话 → 丢弃陈旧结果
      summariesBySession.value = { ...summariesBySession.value, [sessionId]: list };
      summariesError.value = null;
    } catch (err) {
      if (gen !== sessionGen) return;
      // 失败不缓存：下次触发（切回会话/回合结束）自动重试；错误态仅供诊断，不阻塞卡片渲染。
      summariesError.value = err instanceof Error ? err.message : '加载轮末改动摘要失败';
    } finally {
      if (gen === sessionGen) summariesLoading.value = false;
    }
  }

  // patch 懒加载 in-flight 去重（changes-store ensureDiff 同构）：请求各写各自的缓存/错误键，
  // 复用在途 Promise 不装 reqId——错装会把复用 Promise 的结果判死丢弃（见 changes-store:106-110 注）。
  const inflightPatches = new Map<string, Promise<TurnFilePatch | null>>();

  // 缓存命中直接返回；否则 invoke getTurnFilePatch。失败置 patchErrors[key]（可重试：
  // 缓存未写入，再次调用即重试）；'unavailable' 是合法回包（mode 标记 + 空 patch），不是错误。
  async function getPatch(
    sessionId: string,
    turnStartMessageId: string,
    endMessageId: string | null,
    path: string,
  ): Promise<TurnFilePatch | null> {
    const key = turnDiffPatchKey(turnStartMessageId, path);
    const cached = patchCache.value.get(key);
    if (cached) return cached;
    const existing = inflightPatches.get(key);
    if (existing) return existing;
    const promise = (async () => {
      patchLoading.value = { ...patchLoading.value, [key]: true };
      // 重试入口：先清上一轮错误态（spinner 接管展示）。
      if (key in patchErrors.value) {
        const nextErrs = { ...patchErrors.value };
        delete nextErrs[key];
        patchErrors.value = nextErrs;
      }
      try {
        const res = await window.claudeLink.getTurnFilePatch(sessionId, turnStartMessageId, endMessageId, path);
        patchCache.value.set(key, res);
        return res;
      } catch (err) {
        patchErrors.value = { ...patchErrors.value, [key]: err instanceof Error ? err.message : '读取轮末 Diff 失败' };
        return null;
      } finally {
        patchLoading.value = { ...patchLoading.value, [key]: false };
      }
    })().finally(() => {
      // 身份比较清键（changes-store hb13-v review 修复同款）：既清自身条目、又不误删后来者。
      if (inflightPatches.get(key) === promise) inflightPatches.delete(key);
    });
    inflightPatches.set(key, promise);
    return promise;
  }

  // 回合结束防抖计时器（下方两个 watch 共用；须先于 immediate watch 初始化——immediate 首回调
  // 同步执行，声明晚于 watch 会命中 let TDZ 抛 ReferenceError）。
  let summariesTimer: ReturnType<typeof setTimeout> | null = null;

  // 会话激活/切换 → 作废在途 + 重拉（对齐 changes-store：store 首次被组件使用即拉当前会话；
  // id 未变不重入）。摘要按 sessionId 键控，无 workingDir 维度，watch 源只需 id。
  // immediate: true（round-002 M-B5）：不依赖「store 创建时 activeSession 恒为 null」的时序
  // 假设——store 若在已有活动会话后才首次被使用，immediate 首回调即拉当前会话。lastWatchedSessionId
  // 初值 undefined 保证 immediate 首回调必不重入；immediate 时 id 为 null 则安全空转（sessionGen++
  // 与置 lastWatchedSessionId=null 均无副作用）。
  let lastWatchedSessionId: string | null | undefined = undefined;
  watch(
    () => sessionStore.activeSession?.id,
    (id) => {
      if (lastWatchedSessionId !== undefined && id === lastWatchedSessionId) return;
      lastWatchedSessionId = id;
      sessionGen++;
      // 取消上一会话回合结束遗留的防抖计时器，否则它到点会对新会话多跑一次冗余重拉。
      if (summariesTimer) {
        clearTimeout(summariesTimer);
        summariesTimer = null;
      }
      summariesLoading.value = false;
      if (id) {
        // summariesError 非会话键控：切会话即清旧会话错误态，在途窗口不得拿旧会话错误在新会话
        // 误渲染「轮末改动摘要加载失败」行；新会话拉取失败会立即重新置位，语义自洽。
        summariesError.value = null;
        invalidateSummaries(id);
        void loadSummaries(id);
      } else {
        summariesError.value = null;
      }
    },
    { immediate: true },
  );

  // 回合结束（sending true→false）→ 500ms 防抖失效当前会话并重拉（changes-store:175-187 同款；
  // 防抖窗口给主进程留出 turn_ended 后聚合落定的余量）。sending 是 activeSession 派生 getter，
  // 天然只对当前活动会话生效。
  watch(
    () => sessionStore.sending,
    (running, prev) => {
      if (prev && !running) {
        const sid = sessionStore.activeSession?.id;
        if (!sid) return;
        if (summariesTimer) clearTimeout(summariesTimer);
        summariesTimer = setTimeout(() => {
          summariesTimer = null;
          invalidateSummaries(sid);
          void loadSummaries(sid);
        }, 500);
      }
    },
  );

  // R3：断线重连对齐挂钩——仅网页端注册（changes-store P6-R1 同款：web-bridge 安装时置
  // __claudeLinkWebBridge 标记，且 main.ts boot 先 await installWebBridge 再 mount，早于任何
  // store 初始化，时序恒成立）。重连对齐序列跑完 → 失效当前会话摘要缓存并强制重拉
  //（loadSummaries(sid, true) 绕过懒缓存早退）——断线窗口错过的回合结束重拉（loadSummaries
  // 撞 reject 只落错误态不缓存，本就无假缓存，但错过触发时机即不自愈）在此补拉自愈。
  // 桌面端无标记 → 不动态 import，web-bridge chunk 不加载，行为零变化。
  // 注销函数留存（realignedUnsubscribe 非空即已注册）防动态 import 竞态下重复注册。
  let realignedUnsubscribe: (() => void) | null = null;
  if (typeof window !== 'undefined' && (window as any).__claudeLinkWebBridge === true) {
    void import('../web/web-bridge')
      .then(({ onRealigned }) => {
        if (realignedUnsubscribe) return; // 防重复注册
        realignedUnsubscribe = onRealigned(() => {
          const sid = sessionStore.activeSession?.id;
          if (!sid) return;
          invalidateSummaries(sid);
          void loadSummaries(sid, true);
        });
      })
      .catch(() => {
        // web-bridge chunk 加载失败（理论不可达）→ 放弃注册；既有摘要拉取路径不受影响。
      });
  }

  return {
    summariesBySession,
    summariesLoading,
    summariesError,
    patchCache,
    patchErrors,
    patchLoading,
    currentTurnStartMessageId,
    loadSummaries,
    getPatch,
  };
});
