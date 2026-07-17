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
  const expandedPath = ref<string | null>(null);
  const diffCache = ref<Record<string, ChangesDiffResult>>({});

  const changedCount = computed(() => files.value.length);

  // 本会话触碰的文件路径（raw，主进程负责按仓库根归一比对）：
  // 扫消息流 tool_use 的 {name,input.file_path}，JSON 解析失败/非工具消息直接跳过。
  const touchedPaths = computed<string[]>(() => {
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
    return arr;
  });

  // 代际计数器：切会话时自增。refresh/toggleExpand 在发起 git 请求前抓当前值，
  // await 返回后若已变（期间切了会话）→ 丢弃结果，不把旧会话数据写进新会话状态。
  let sessionGen = 0;

  async function refresh(): Promise<void> {
    const wd = sessionStore.activeSession?.workingDir ?? null;
    if (!wd) {
      files.value = [];
      error.value = '当前没有活动会话或工作目录';
      baselineRef.value = '';
      expandedPath.value = null;
      diffCache.value = {};
      return;
    }
    // 抓代际：await 期间若切会话（sessionGen 自增），本次结果作废，不污染新会话状态。
    const gen = sessionGen;
    loading.value = true;
    try {
      const res = await window.claudeLink.listChanges(wd, touchedPaths.value);
      if (gen !== sessionGen) return; // 期间切会话 → 丢弃陈旧列表
      if (!res.ok) {
        files.value = [];
        error.value = res.message;
        baselineRef.value = '';
        expandedPath.value = null;
        diffCache.value = {};
      } else {
        files.value = res.files;
        baselineRef.value = res.baselineRef;
        error.value = null;
        // 列表已变：丢弃已不在列表的旧 diff 缓存；保留当前展开项的旧值直到新结果到达，
        // 避免刷新期间一闪「无可显示差异」。
        const newPathSet = new Set(res.files.map((f) => f.path));
        const preserved: Record<string, ChangesDiffResult> = {};
        if (expandedPath.value && diffCache.value[expandedPath.value]) {
          preserved[expandedPath.value] = diffCache.value[expandedPath.value];
        }
        diffCache.value = preserved;
        if (expandedPath.value && !newPathSet.has(expandedPath.value)) {
          // 展开的文件已不在列表 → 收起。
          expandedPath.value = null;
          diffCache.value = {};
        } else if (expandedPath.value) {
          // 仍展开的文件 → 重新取它的 diff 并覆盖（旧值在新结果到达前继续显示）。
          // 抓快照键 p：await 期间用户可能点了别的文件使 expandedPath 变化，
          // 必须按「为谁取的」落键，否则会把 A 的 diff 写进 B 的键（持久错显）。
          const p = expandedPath.value;
          const r = await window.claudeLink.getChangeDiff(wd, p);
          if (gen !== sessionGen) return; // 第二段 await 期间切会话 → 同样丢弃
          diffCache.value = { ...diffCache.value, [p]: r };
        }
      }
    } finally {
      // 仅最新一次 refresh 复位 loading，避免陈旧 refresh 提前清掉在途刷新的 spinner。
      if (gen === sessionGen) loading.value = false;
    }
  }

  async function toggleExpand(path: string): Promise<void> {
    if (expandedPath.value === path) {
      expandedPath.value = null;
      return;
    }
    expandedPath.value = path;
    if (diffCache.value[path]) return; // 已缓存直接用
    // 抓代际：await 期间若切会话，丢弃结果——否则旧会话 diff 会被写回新会话已清空的缓存。
    const gen = sessionGen;
    const wd = sessionStore.activeSession?.workingDir ?? null;
    const res = await window.claudeLink.getChangeDiff(wd, path);
    if (gen !== sessionGen) return;
    diffCache.value = { ...diffCache.value, [path]: res };
  }

  // 切会话 → 自增代际（作废所有在途请求）+ 清状态并重拉（workingDir 可能不同）。
  // 首次由组件 onMounted 触发 refresh。
  watch(
    () => sessionStore.activeSession?.id,
    () => {
      sessionGen++;
      loading.value = false; // 切会话即新的 refresh 生命周期；防 null-wd 早返回路径把 loading 孤儿卡死
      // 取消上一会话回合结束遗留的防抖计时器，否则它到点会对新会话多跑一次冗余 refresh。
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      expandedPath.value = null;
      diffCache.value = {};
      void refresh();
    },
  );

  // 回合结束（isRunning true→false）→ 防抖刷新列表，让 Claude 中途的文件改动及时反映。
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  watch(
    () => sessionStore.isRunning,
    (running, prev) => {
      if (prev && !running) {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          void refresh();
        }, 500);
      }
    },
  );

  return { files, loading, error, baselineRef, expandedPath, diffCache, changedCount, refresh, toggleExpand };
});
