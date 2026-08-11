// command-store.ts
// Renderer 按 Claude Link sessionId 缓存原生 Slash Command 快照。
//
// 主进程是命令能力的唯一真相源（sdk-command-registry + SDK probe）；本 store 只缓存 + 按 sessionId 索引，
// 不二次持久化、不自行发现命令。loading/stale/degraded/empty/error 状态驱动 ChatInput `/` 菜单展示。
// 后台（非活动）会话的命令更新也累积于此，切回会话时直接读取，不串扰。

import { defineStore } from 'pinia';
import type { SessionCommandSnapshot, CommandChangedPayload, CommandProvenance } from '../../shared/types/command';
import { createDefaultCommandSnapshot } from '../../shared/types/command';

export const useCommandStore = defineStore('command', {
  state: () => ({
    snapshotsBySession: {} as Record<string, SessionCommandSnapshot>,
    // Task 8：命令来源 provenance 诊断（按 sessionId 缓存，供 UI 展示来源徽章/unknown 计数）。
    diagnosticsBySession: {} as Record<string, CommandProvenance>,
  }),
  getters: {
    // 返回函数的 getter（sessionId 入参）。未加载时返回默认 loading 快照——不抛错、不阻塞 UI。
    activeSnapshot:
      (state) =>
      (sessionId: string): SessionCommandSnapshot =>
        state.snapshotsBySession[sessionId] ?? createDefaultCommandSnapshot(sessionId),
    // Task 8：未加载时返回 total=0 的空诊断（不抛错）；UI 据此决定是否展示来源/unknown 徽章。
    activeDiagnostics:
      (state) =>
      (sessionId: string): CommandProvenance =>
        state.diagnosticsBySession[sessionId] ?? {
          sessionId,
          total: 0,
          byOrigin: { builtin: 0, 'user-skill': 0, project: 0, plugin: 0, internal: 0, removed: 0, unknown: 0 },
          byAvailability: { available: 0, hidden: 0, unknown: 0 },
          unknownNames: [],
          hiddenNames: [],
          generatedAt: new Date(0).toISOString(),
        },
  },
  actions: {
    setSnapshot(snapshot: SessionCommandSnapshot) {
      this.snapshotsBySession[snapshot.sessionId] = snapshot;
    },
    // 主进程 COMMANDS_CHANGED 推送的快照全量替换（registry 已清洗 + 去重）。
    replaceFromEvent(payload: CommandChangedPayload) {
      this.snapshotsBySession[payload.sessionId] = payload.snapshot;
    },
    // 拉取某会话当前快照（新会话创建后、切回会话时）。失败保留既有快照；没有时不抛到页面。
    async load(sessionId: string) {
      try {
        const snapshot = await window.claudeLink.getSessionCommands(sessionId);
        if (snapshot && snapshot.sessionId === sessionId) {
          this.snapshotsBySession[sessionId] = snapshot;
        }
      } catch {
        // 拉取失败保留既有 snapshot；UI 用 activeSnapshot 的默认 loading，不抛到页面。
      }
    },
    // Task 8：拉取命令来源诊断（按需，UI 展示来源徽章时调）。失败静默保留既有诊断，不抛到页面。
    async loadDiagnostics(sessionId: string) {
      try {
        const diag = await window.claudeLink.getCommandDiagnostics(sessionId);
        if (diag && diag.sessionId === sessionId) {
          this.diagnosticsBySession[sessionId] = diag;
        }
      } catch {
        // 诊断拉取失败保留既有值；UI 用 activeDiagnostics 的空默认，不抛到页面。
      }
    },
    clear(sessionId: string) {
      delete this.snapshotsBySession[sessionId];
      delete this.diagnosticsBySession[sessionId];
    },
  },
});
