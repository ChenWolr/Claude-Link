// claude-plan-store.ts
// Claude 计划任务状态：按会话隔离的只读快照。独立于手动排队 task-store，
// 不复用 tasks 表或 Task 类型。
//
// 数据来源：
//  - 实时：主进程通过 CHAT_EVENT 推送 ClaudePlanCliEvent（TodoWrite/TaskCreate/... 的快照更新）
//  - 持久化：主进程 claude_plan_state 表，经 preload getClaudePlanState 读取
//
// 竞态保护：
//  - applyPlanState 仅允许更高 revision 覆盖（防旧事件回退）
//  - loadPlan 用 generation 保护，旧请求结果不覆盖新请求
//  - 后台会话事件按 sessionId 写入对应 plan，切回时可见最新

import { defineStore } from 'pinia';
import type { ClaudePlanState } from '../../shared/types/claude-plan';
import { useSessionStore } from './session-store';

export const useClaudePlanStore = defineStore('claude-plan', {
  state: () => ({
    // 按会话隔离的计划快照。
    planBySession: {} as Record<string, ClaudePlanState>,
    // loadPlan 的 generation 计数器，防止旧请求覆盖新请求。
    loadGenerationBySession: {} as Record<string, number>,
  }),

  getters: {
    // 当前活动会话的计划快照（无则 null）。
    activePlan(state): ClaudePlanState | null {
      const sessionStore = useSessionStore();
      const sid = sessionStore.activeSession?.id;
      if (!sid) return null;
      return state.planBySession[sid] ?? null;
    },
  },

  actions: {
    /**
     * 从 DB 异步读取计划快照。generation 保护：旧请求结果不覆盖新请求。
     * 只有 generation 没过期且读取 revision 不落后于 live revision 时才 hydrate。
     */
    async loadPlan(sessionId: string): Promise<void> {
      const gen = (this.loadGenerationBySession[sessionId] ?? 0) + 1;
      this.loadGenerationBySession[sessionId] = gen;
      let result: ClaudePlanState | null = null;
      try {
        result = await window.claudeLink.getClaudePlanState(sessionId);
      } catch {
        // IPC 失败：保持已有 live 状态，不覆盖
        return;
      }
      // generation 过期：丢弃旧请求结果
      if (this.loadGenerationBySession[sessionId] !== gen) return;
      // revision 保护：不因旧 hydrate 回退 live 状态
      const existing = this.planBySession[sessionId];
      if (existing && result && result.revision < existing.revision) return;
      if (result) {
        this.planBySession[sessionId] = result;
      } else if (!existing) {
        // 无 DB 记录且无 live 状态：初始化空快照，让 UI 有数据可读
        this.planBySession[sessionId] = {
          sessionId,
          todos: [],
          tasks: [],
          revision: 0,
          updatedAt: new Date().toISOString(),
        };
      }
    },

    /**
     * 应用实时计划快照（来自 CHAT_EVENT）。
     * 仅允许更高 revision 覆盖；无 revision 的即时事件按序应用。
     */
    applyPlanState(sessionId: string, state: ClaudePlanState): void {
      const existing = this.planBySession[sessionId];
      // revision 保护：旧事件不覆盖新状态
      if (existing && state.revision < existing.revision) return;
      this.planBySession[sessionId] = state;
    },

    /** 会话删除时清理 renderer 状态。 */
    clearSession(sessionId: string): void {
      delete this.planBySession[sessionId];
      delete this.loadGenerationBySession[sessionId];
    },
  },
});
