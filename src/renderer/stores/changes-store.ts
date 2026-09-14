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

  async function refresh(invalidateDiffs = false): Promise<void> {
    const wd = sessionStore.activeSession?.workingDir ?? null;
    if (!wd) {
      files.value = [];
      error.value = '当前没有活动会话或工作目录';
      baselineRef.value = '';
      diffCache.value = {};
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
      } else {
        files.value = res.files;
        baselineRef.value = res.baselineRef;
        error.value = null;
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
        if (gen === sessionGen) {
          error.value = err instanceof Error ? err.message : '读取 diff 失败';
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

  // 回合结束（isRunning true→false）→ 防抖刷新列表，让 Claude 中途的文件改动及时反映。
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

  return { files, loading, error, baselineRef, diffCache, changedCount, refresh, ensureDiff };
});
