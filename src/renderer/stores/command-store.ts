// command-store.ts
// Renderer 按 Claude Link sessionId 缓存原生 Slash Command 快照。
//
// 主进程是命令能力的唯一真相源（sdk-command-registry + SDK probe）；本 store 只缓存 + 按 sessionId 索引，
// 不二次持久化、不自行发现命令。loading/stale/degraded/empty/error 状态驱动 ChatInput `/` 菜单展示。
// 后台（非活动）会话的命令更新也累积于此，切回会话时直接读取，不串扰。

import { defineStore } from 'pinia';
import type { Session } from '../../shared/types/session';
import type { SessionCommandSnapshot, CommandChangedPayload, CommandProvenance } from '../../shared/types/command';
import { createDefaultCommandSnapshot } from '../../shared/types/command';

// M8/D-1：主进程全局兜底快照的哨兵 sessionId（镜像 src/main/modules/sdk-command-registry.ts 的
// GLOBAL_FALLBACK_SESSION_ID 字面量；渲染层不 import 主进程模块、本次亦不改 shared，故镜像于此）。
// 仅用于 load() 暂态分支回填 globalSnapshot 时把被主进程改写的 sessionId 归位。
const GLOBAL_FALLBACK_SESSION_ID = '__global_command_fallback__';

// ensureGlobalSnapshot 的 in-flight 锁（模块级非响应式：只做并发去重，不驱动 UI；单 renderer
// 单 Pinia 实例，模块级可变量即进程级单例）。
let globalEnsureInFlight: Promise<void> | null = null;

export const useCommandStore = defineStore('command', {
  state: () => ({
    snapshotsBySession: {} as Record<string, SessionCommandSnapshot>,
    // Task 8：命令来源 provenance 诊断（按 sessionId 缓存，供 UI 展示来源徽章/unknown 计数）。
    diagnosticsBySession: {} as Record<string, CommandProvenance>,
    // 引擎全局探测的未过滤快照（哨兵 sessionId 兜底快照，COMMANDS_GLOBAL_CHANGED 推送），
    // 配置页「Skill 管理」数据源；与按会话快照不同，不参与 `/` 菜单渲染。
    globalSnapshot: null as SessionCommandSnapshot | null,
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
    // D4：全局兜底快照热刷新广播的消费端（COMMANDS_GLOBAL_CHANGED）。activeSession 由调用方
    // （App.vue）传入，避免 command-store ↔ session-store 的 store 间循环依赖。
    // - 暂态会话：无条件覆盖（暂态天生只有全局兜底，全局即当前最准的命令集）；
    // - 当前活跃的已物化会话：按主进程 N7 同款「commands 空判断」用 cache 回填（保留既有 status，
    //   对齐 setStatusPreservingCommands 语义）；非空不动——per-session 精确集优先，
    //   避免全局 cwd 的命令集覆盖 per-cwd 精确集。非活跃会话不消费（切回时 load 自然拿最新）。
    applyGlobalFallback(snapshot: SessionCommandSnapshot, active: Session | null) {
      if (!snapshot) return;
      if (active?.transient) {
        this.snapshotsBySession[active.id] = { ...snapshot, sessionId: active.id, source: 'cache' };
        return;
      }
      if (!active) return;
      const current = this.snapshotsBySession[active.id];
      if (current && current.commands.length > 0) return; // per-session 优先
      this.snapshotsBySession[active.id] = current
        ? { ...current, commands: snapshot.commands, source: 'cache', updatedAt: snapshot.updatedAt }
        : { ...snapshot, sessionId: active.id, source: 'cache' };
    },
    // 拉取某会话当前快照（新会话创建后、切回会话时）。失败保留既有快照；没有时不抛到页面。
    async load(sessionId: string) {
      try {
        const snapshot = await window.claudeLink.getSessionCommands(sessionId);
        if (snapshot && snapshot.sessionId === sessionId) {
          this.snapshotsBySession[sessionId] = snapshot;
          // S2-P2-2：globalSnapshot 哨兵回填——凡响应为全局兜底派生数据
          //（source==='cache'：兜底副本 / loading 默认 / degraded 克隆，commands 必为未过滤全局集）
          // 即归位哨兵回填，非暂态路径同样回填，修复「启动广播落在订阅前 + 不建暂态会话」时 Skill 页
          // 永停「正在探测」（场景 A）；per-session 权威快照（probe/init/changed）不回填——有钉住
          // 禁用的会话其 probe 快照已被引擎过滤，回填会让 Skill 页丢失禁用项、破坏「未过滤全局快照」
          // 语义。与 App.vue 广播回写同数据源，零新增 IPC。
          if (snapshot.source === 'cache') {
            this.globalSnapshot = { ...snapshot, sessionId: GLOBAL_FALLBACK_SESSION_ID };
          }
        }
      } catch {
        // 拉取失败保留既有 snapshot；UI 用 activeSnapshot 的默认 loading，不抛到页面。
      }
    },
    // 冷启动自愈正式化（2026-09-15）：COMMANDS_GLOBAL_CHANGED 是一次性推送（主进程探测完成即发、
    // 无 replay），落在 App.vue 订阅注册（await loadConfig 之后）之前即永久丢失；而 load() 的全部
    // 既有调用点均由会话交互驱动，零交互直达 Skill 页时 globalSnapshot 唯二写入者双双不可达，
    // 页面永停「正在探测」。本方法把自愈路径（load(哨兵) → COMMANDS_GET 只读分流 → cache 守卫
    // 回填）正式化为显式按需拉取：ConfigPage Skill tab 激活与 App.vue 订阅就绪后调用。
    // - 幂等守卫：已有非 loading 快照（ready/stale/degraded/empty/error）直接返回，防 tab 反复
    //   切换的拉取风暴；null/loading 占位才拉（loading 放行——主进程探测未完时只读分流返回
    //   loading 默认 + D6 节流重探，探测完成后广播照常补位，两路写入同一份未过滤快照）。
    // - in-flight 锁：并发调用共享同一 Promise，防重入重复拉取。
    // 副作用核实（docs/review/2026-09-15-skill-management-coldstart-fix.md §2）：仅多写一个
    // snapshotsBySession 哨兵键（全消费端按键取值、无遍历，惰性无害）；主进程侧无 DB 行走只读
    // 分流（不 markSessionActive/不 per-session probe/不调度 post-turn），D6 重探在兜底已就绪时
    // no-op、未就绪时 60s 节流，均为设计内自愈。
    async ensureGlobalSnapshot(): Promise<void> {
      if (globalEnsureInFlight) return globalEnsureInFlight;
      const current = this.globalSnapshot;
      if (current && current.status !== 'loading') return;
      globalEnsureInFlight = (async () => {
        try {
          await this.load(GLOBAL_FALLBACK_SESSION_ID);
        } finally {
          globalEnsureInFlight = null;
        }
      })();
      return globalEnsureInFlight;
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
