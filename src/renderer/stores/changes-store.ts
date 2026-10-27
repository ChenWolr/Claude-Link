// changes-store.ts
// 会话改动面板的渲染层状态：改动文件列表、按需 diff 缓存、刷新。
//
// diff 真值来自主进程 changes-panel（git 按需算），本 store 只做拉取/缓存/展示。
// touchedPaths 把本会话 tool_use（Edit/Write/MultiEdit）触碰过的 file_path 原样传给主进程，
// 由主进程按仓库根相对路径归一比对并回填 touchedThisSession——渲染层无需知道仓库根。

import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { useSessionStore } from './session-store';
import { TOOL_DIFF_TOOL_NAMES } from '../../shared/process-kind';
import type { ChangedFile, ChangesDiffResult } from '../../shared/types/changes';

export const useChangesStore = defineStore('changes', () => {
  const sessionStore = useSessionStore();
  const files = ref<ChangedFile[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  // round-002（F2）：失败语义标记——error 与 ensureDiff 共享（写入文本/位置契约钉死不动），
  // 且 !wd 分支的「当前没有活动会话或工作目录」是提示态非失败态；面板失败横条改由本标记驱动：
  // 仅 refresh 真实失败（reject catch / res.ok=false）置 true，成功与 !wd 分支复位 false。
  // sessionless 标记 !wd 分支（空态三级化：显「当前没有活动会话或工作目录」而非「工作目录无改动」）。
  const refreshFailed = ref(false);
  const sessionless = ref(false);
  const baselineRef = ref('');
  const diffCache = ref<Record<string, ChangesDiffResult>>({});

  const changedCount = computed(() => files.value.length);

  // 本会话触碰的文件路径（raw，主进程负责按仓库根归一比对）：
  // 扫消息流 tool_use 的 {name,input.file_path}，JSON 解析失败/非工具消息直接跳过。
  // hb10-CHG-V04：touchedPaths 按「消息数」memo——流式期 messages 每秒变多次，
  // 全量 JSON.parse 扫描是纯重复劳动；消息数与上次一致直接复用上次结果。
  let touchedPathsMemo = { count: -1, paths: [] as string[] };
  const touchedPaths = computed<string[]>(() => {
    if (sessionStore.messages.length === touchedPathsMemo.count) return touchedPathsMemo.paths;
    const arr: string[] = [];
    for (const m of sessionStore.messages) {
      const content = m?.content;
      if (typeof content !== 'string' || !content.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(content) as { name?: unknown; input?: { file_path?: unknown } };
        if (
          typeof parsed.name === 'string' &&
          (TOOL_DIFF_TOOL_NAMES as readonly string[]).includes(parsed.name) &&
          typeof parsed.input?.file_path === 'string'
        ) {
          arr.push(parsed.input.file_path);
        }
      } catch {
        /* 非工具消息或格式不符 → 跳过 */
      }
    }
    touchedPathsMemo = { count: sessionStore.messages.length, paths: arr };
    return arr;
  });

  // 代际计数器：切会话时自增。refresh/ensureDiff 在发起 git 请求前抓当前值，
  // await 返回后若已变（期间切了会话）→ 丢弃结果，不把旧会话数据写进新会话状态。
  let sessionGen = 0;

  // P6-R1：refresh 直呼路径的 F-5 同源守卫状态（距上次实际发起拉取的 id/wd）。
  // 与 watch 侧 lastWatchedId/lastWatchedWd 互补：watch 守卫防整对象替换触发会话重置，
  // 本守卫防同 id/wd 直呼 refresh() 的冗余重拉；force / invalidateDiffs 可绕过（见 refresh 注）。
  let lastRefreshedId: string | null | undefined = undefined;
  let lastRefreshedWd: string | null | undefined = undefined;

  async function refresh(invalidateDiffs = false, force = false): Promise<void> {
    const id = sessionStore.activeSession?.id;
    const wd = sessionStore.activeSession?.workingDir ?? null;
    // P6-R1：F-5 同源早退守卫（refresh 直呼路径）——距上次实际拉取 id+wd 均未变且非 force /
    // 非 invalidateDiffs → 跳过（防冗余全量 git 扫描）；force=true 或 invalidateDiffs=true
    //（回合结束刷新 / 重连对齐重拉 / 面板「重试」）绕过守卫强制重拉——断线窗口错过的刷新由
    // onRealigned → refresh(true) 在此自愈。watch 侧 F-5 短路守卫（hb13-v B8）保持原位不动。
    if (!force && !invalidateDiffs && lastRefreshedId !== undefined && id === lastRefreshedId && wd === lastRefreshedWd) return;
    lastRefreshedId = id;
    lastRefreshedWd = wd;
    if (!wd) {
      files.value = [];
      error.value = '当前没有活动会话或工作目录';
      baselineRef.value = '';
      diffCache.value = {};
      refreshFailed.value = false; // round-002 F2：无会话是提示态非失败态——横条不出
      sessionless.value = true; // round-002 F2：空态显「当前没有活动会话或工作目录」
      return;
    }
    // 抓代际：await 期间若切会话（sessionGen 自增），本次结果作废，不污染新会话状态。
    const gen = sessionGen;
    // hb13-v B8（F-1）：refresh 侧「仅最新完成者写」——防抖×在途并发时陈旧 refresh 的
    // 列表/错误态不得覆盖最新一次的结果。
    const reqId = ++refreshRequestId;
    loading.value = true;
    try {
      const res = await window.claudeLink.listChanges(wd, touchedPaths.value);
      if (gen !== sessionGen || reqId !== refreshRequestId) return; // 期间切会话/有更新 refresh → 丢弃陈旧结果
      if (!res.ok) {
        files.value = [];
        error.value = res.message;
        baselineRef.value = '';
        diffCache.value = {};
        refreshFailed.value = true; // round-002 F2：真实失败（明确失败结果）→ 横条
        sessionless.value = false;
        // round-002 F3：失败不留「已拉取」假象——重置 F-5 同源守卫，重挂载 onMounted
        // refresh()（同 id/wd 直呼）不被守卫短路，可自愈重拉。
        lastRefreshedId = undefined;
        lastRefreshedWd = undefined;
      } else {
        files.value = res.files;
        baselineRef.value = res.baselineRef;
        error.value = null;
        refreshFailed.value = false; // round-002 F2：成功复位（横条收起）
        sessionless.value = false;
        if (invalidateDiffs) {
          // hb10 P2-8：回合结束（sending 下降沿）刷新成功=全部 diff 可能变化 → 全清缓存。
          diffCache.value = {};
        } else {
          // 列表已变：只保留仍在 files 列表里的 diff 缓存项（展开态改由 DiffDialog 自管，不再此处收尾）。
          const newPathSet = new Set(res.files.map((f) => f.path));
          const preserved: Record<string, ChangesDiffResult> = {};
          for (const [k, v] of Object.entries(diffCache.value)) {
            if (newPathSet.has(k)) preserved[k] = v;
          }
          diffCache.value = preserved;
        }
      }
    } catch (err) {
      // P6-R1：web 桥断线（重连退避窗口 1-15s）恰逢刷新时 listChanges reject——此前无 catch
      // 成为 unhandled rejection，且 files 停留旧值但 error=null 时面板呈假空态「工作目录无改动」。
      // 现补 catch：落 error 态 + **保留旧 files**（陈旧优于假空态），不重抛（调用方均为
      // void refresh()，吞掉即消灭 unhandled rejection）。陈旧代际（期间已切会话/有更新 refresh）
      // 不写，交给最新一次请求收口。桌面 ipcMain.invoke 无 reject 路径，本分支不触发，行为零变化。
      if (gen === sessionGen && reqId === refreshRequestId) {
        error.value = err instanceof Error ? err.message : '刷新改动列表失败';
        refreshFailed.value = true; // round-002 F2：reject（传输层断线）→ 横条 + 保留旧 files
        sessionless.value = false;
        // round-002 F3：同 !res.ok 分支——失败重置 F-5 同源守卫，重挂载 refresh() 可自愈。
        // 与 error 同置于陈旧代际守卫内：陈旧失败不得清掉最新一次请求已写好的守卫状态。
        lastRefreshedId = undefined;
        lastRefreshedWd = undefined;
      }
    } finally {
      // 仅最新一次 refresh 复位 loading，避免陈旧 refresh 提前清掉在途刷新的 spinner。
      if (gen === sessionGen && reqId === refreshRequestId) loading.value = false;
    }
  }

  // 取（并在缺失时按需拉取）某文件的 diff，带代际守卫 + in-flight 去重：
  // 连续触发同文件（如 watch(state.path) 与侧栏 select 撞一起）复用在途 Promise，只发一次 getChangeDiff。
  // DiffDialog 打开文件时调它按需填充缓存。
  const inflightDiffs = new Map<string, Promise<void>>();
  // hb13-v B8（F-1）：requestId 归位 refresh（hb12 计划 CHG-14 原文）——refresh 的防抖×在途
  // 乱序才需要「仅最新完成者写」（两个列表写目标同为 files/baseline）；ensureDiff 各请求写
  // 各自的 diffCache[p] 键，本无互斥，装 reqId 反而把复用在途 Promise 的结果判死丢弃
  //（A 在途→点 B→回点 A → 弹窗永久「加载中」）。
  let refreshRequestId = 0;
  function ensureDiff(p: string, context: number): Promise<void> {
    const cached = diffCache.value[p];
    if (cached && cached.ok && cached.context === context) return Promise.resolve(); // 同 context 已缓存
    const inflightKey = `${p}@${context}`;
    const existing = inflightDiffs.get(inflightKey);
    if (existing) return existing; // 去重：复用在途请求
    const promise = (async () => {
      // 抓代际：await 期间若切会话，丢弃结果——否则旧会话 diff 会被写回新会话已清空的缓存。
      const gen = sessionGen;
      const wd = sessionStore.activeSession?.workingDir ?? null;
      try {
        const res = await window.claudeLink.getChangeDiff(wd, p, context);
        if (gen !== sessionGen) return;
        diffCache.value = { ...diffCache.value, [p]: res };
      } catch (err) {
        // hb10-CHG-V03：失败更新 error 态（不再 unhandled rejection）。
        // A12（D10-F1）：失败同时写 {ok:false} 错误条目进缓存——cached 消费方（DiffDialog）
        // 呈现错误态而非永久「加载中」（重拉失败分支），值稳定不改写、无循环。
        if (gen === sessionGen) {
          error.value = err instanceof Error ? err.message : '读取 diff 失败';
          diffCache.value = { ...diffCache.value, [p]: { ok: false, reason: 'error', message: error.value } };
        }
      }
    })().finally(() => {
      // hb13-v review 修复（P2）：身份比较清键——上一轮的 `!has` 形态恒空（set 同步先于
      // 异步 finally，!has 恒 false → 自身条目永不清 → 回合结束清 diffCache 后复用已结算
      // Promise，同 diff 永久「加载中」）。身份比较既清自身条目、又不误删后来者
      //（hb10-CHG-13「后来者不被误删」语义保持）。
      if (inflightDiffs.get(inflightKey) === promise) inflightDiffs.delete(inflightKey);
    });
    inflightDiffs.set(inflightKey, promise);
    return promise;
  }

  // 切会话 → 自增代际（作废所有在途请求）+ 清状态并重拉（workingDir 可能不同）。
  // 首次由组件 onMounted 触发 refresh。
  // hb12-CHG-01：watch 源纳入 workingDir——同会话切 wd（session-store 两条写路径）时
  // 旧仓库列表残留 + diffCache 把旧仓库 diff 带进新目录（看错文件内容级误导）。
  // hb13-v B8（F-5）：id+wd 均未变即跳过——模型/权限档/思考强度/改名等 updateSession 往返的
  // activeSession 整对象替换不再触发冗余 sessionGen++ + 全量 git 扫描（hb12-CHG-01 的两条
  // wd 写路径仍正常触发：getter 返回的 id 或 wd 任一变化即放行）。
  let lastWatchedId: string | null | undefined = undefined;
  let lastWatchedWd: string | null | undefined = undefined;
  watch(
    () => [sessionStore.activeSession?.id, sessionStore.activeSession?.workingDir] as const,
    ([id, wd]) => {
      if (lastWatchedId !== undefined && id === lastWatchedId && wd === lastWatchedWd) return;
      lastWatchedId = id;
      lastWatchedWd = wd;
      sessionGen++;
      touchedPathsMemo = { count: -1, paths: [] }; // hb10-CHG-V04：切会话清 memo
      loading.value = false; // 切会话即新的 refresh 生命周期；防 null-wd 早返回路径把 loading 孤儿卡死
      // 取消上一会话回合结束遗留的防抖计时器，否则它到点会对新会话多跑一次冗余 refresh。
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      diffCache.value = {};
      inflightDiffs.clear(); // 清旧会话在途请求引用（其 Promise 自行 finally 丢弃结果）
      void refresh();
    },
  );

  // 回合结束（sending true→false）→ 防抖刷新列表，让 Claude 中途的文件改动及时反映。
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  watch(
    () => sessionStore.sending,
    (running, prev) => {
      if (prev && !running) {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          void refresh(true);
        }, 500);
      }
    },
  );

  // P6-R1：断线重连对齐挂钩——仅网页端注册（web-bridge 安装时置 __claudeLinkWebBridge 标记，
  // 且 main.ts boot 先 await installWebBridge 再 mount，早于任何 store 初始化，时序恒成立）。
  // 重连对齐序列跑完 → 强制重拉当前会话改动（refresh(true)：invalidateDiffs 绕过 F-5 同源守卫，
  // 成功后顺带全清 diff 缓存——断线期间 diff 内容可能已变化，保守重拉）。断线窗口错过的刷新
  //（防抖刷新/切会话刷新撞上 reject）在此自愈；重连风暴下每次通知都重拉，invoke 本身轻量可接受。
  // 桌面端无标记 → 不动态 import，web-bridge chunk 不加载，行为零变化。
  if (typeof window !== 'undefined' && (window as any).__claudeLinkWebBridge === true) {
    void import('../web/web-bridge')
      .then(({ onRealigned }) => onRealigned(() => { void refresh(true); }))
      .catch(() => {
        // web-bridge chunk 加载失败（理论不可达）→ 放弃注册；既有刷新路径不受影响。
      });
  }

  return { files, loading, error, baselineRef, diffCache, changedCount, refreshFailed, sessionless, refresh, ensureDiff };
});
