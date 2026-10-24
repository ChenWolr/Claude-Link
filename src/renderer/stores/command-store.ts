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
import { filterCommandsBySkillOverrides } from '../../shared/command-filter';
import { useConfigStore } from './config-store';

// M8/D-1：主进程全局兜底快照的哨兵 sessionId（镜像 src/main/modules/sdk-command-registry.ts 的
// GLOBAL_FALLBACK_SESSION_ID 字面量；渲染层不 import 主进程模块、本次亦不改 shared，故镜像于此）。
// 用于两处：① load() 内 source==='cache' 响应回填 globalSnapshot 时把被主进程改写的 sessionId
// 归位（S2-P2-2 起不限暂态分支，暂态/非暂态路径均回填）；② ensureGlobalSnapshot() 以哨兵 id
// 调 load() 走只读分流自愈。
const GLOBAL_FALLBACK_SESSION_ID = '__global_command_fallback__';

// ensureGlobalSnapshot 的 in-flight 锁（模块级非响应式：只做并发去重，不驱动 UI；单 renderer
// 单 Pinia 实例，模块级可变量即进程级单例）。
let globalEnsureInFlight: Promise<void> | null = null;

// ── S5（2026-10-22 six-issues §7.1）：全局 user-skill 命名集 diff（「本次刷新 +N」/卡片「新增」徽标数据源）──

/** 快照中 origin==='user-skill' 的命名集合（diff 基底；null 快照容错为空集）。 */
function userSkillNameSet(snapshot: SessionCommandSnapshot | null): Set<string> {
  const names = new Set<string>();
  for (const c of snapshot?.commands ?? []) {
    if (c.origin === 'user-skill') names.add(c.name);
  }
  return names;
}

/** 对比刷新前后 globalSnapshot 的 user-skill 命名集合，返回新增名列表（去重、发现序）。 */
function diffUserSkills(before: SessionCommandSnapshot | null, after: SessionCommandSnapshot | null): string[] {
  const prev = userSkillNameSet(before);
  const added: string[] = [];
  for (const c of after?.commands ?? []) {
    if (c.origin === 'user-skill' && !prev.has(c.name) && !added.includes(c.name)) added.push(c.name);
  }
  return added;
}

// F3（round-002 review）：基线可用性——仅定态成功快照（ready/stale/empty，与 ensureGlobalSnapshot
// 的「定态」集一致）可作 diff 基线；null/loading/degraded/error 一律视为「无基线」（首拍=建基线，
// 不计 delta）。loading/degraded 占位快照（只读分流：探测在飞返回默认 loading、CLI 缺失/探测失败
// 返回 degraded，commands 必为空集）会经 load() 哨兵回填写入基线槽位——若当作基线 diff，会把
// 全部既有 Skill 误标「新增」。
function hasUsableBaseline(snapshot: SessionCommandSnapshot | null): boolean {
  return (
    snapshot !== null &&
    snapshot.status !== 'loading' &&
    snapshot.status !== 'degraded' &&
    snapshot.status !== 'error'
  );
}

// 广播消费的 before 基线（模块级非响应式，与 globalEnsureInFlight 同款进程级单例）。App.vue 在调用
// applyGlobalFallback 前已把 globalSnapshot 覆写为新快照，故「上一拍」快照只能由此模块级变量承载：
// 每个快照写入点（applyGlobalFallback / load 哨兵回填 / refreshGlobal）落定即同步，广播 diff 各以自己
// 记录的 before 集计算，与手动刷新并发安全（快照幂等 REPLACE）。
let prevGlobalUserSkillSnapshot: SessionCommandSnapshot | null = null;

export const useCommandStore = defineStore('command', {
  state: () => ({
    snapshotsBySession: {} as Record<string, SessionCommandSnapshot>,
    // Task 8：命令来源 provenance 诊断（按 sessionId 缓存，供 UI 展示来源徽章/unknown 计数）。
    diagnosticsBySession: {} as Record<string, CommandProvenance>,
    // 引擎全局探测的未过滤快照（哨兵 sessionId 兜底快照，COMMANDS_GLOBAL_CHANGED 推送），
    // 配置页「Skill 管理」数据源；与按会话快照不同，不参与 `/` 菜单渲染。
    globalSnapshot: null as SessionCommandSnapshot | null,
    // M8 配套：暂态会话登记表（sessionId → 创建时的全局 skillOverrides）。startTransientSession
    // 登记、物化/clear 注销；load() 据键存在与否识别暂态身份——覆盖 ChatInput 斜杠菜单去抖重拉
    //（N11，该文件禁触）等未显式传参的按需拉取入口。S2-P2-1 起「过滤取值」不再读本表冻结值，
    // 改读当前全局配置（useConfigStore()）；登记值仅存档，不再被消费。内存态，不持久化。
    transientOverridesBySession: {} as Record<string, Record<string, 'off'> | null>,
    // R-1（review 2026-09-18 验收 §3 R-1）：全局作用域（~/.claude/skills）skill 的 fm 名→目录名
    // 映射。ConfigPage 进 Skill tab 现查 SKILL_PROJECT_DIRS_GET 时随载荷写入；ChatInput '/'
    // 菜单过滤按目录名键消费（引擎 skillOverrides 键空间=目录名）。内存态不持久化；未进过
    // Skill 页为空对象——菜单过滤拿不到映射时回退 slash 名口径（fm==dir 公共形态同键，
    // fm≠dir 且映射不可得的残面由引擎键入本地拦截兜底，登记已知限制）。
    userSkillDirNames: {} as Record<string, string>,
    // S5：Skill 页「立即刷新」进行中态（短时操作态，跟随快照应用即复位，无跨端同步需求）。
    globalRefreshing: false,
    // S5：最近一次刷新新增 user-skill 数（同步条 delta 徽标 + rail「全局 Skill」条目徽标；
    // v-if > 0 渲染；重进 Skill tab 清零防陈旧常驻）。
    globalSkillDelta: 0,
    // S5：最近一次刷新新增 user-skill 名列表（卡片「新增」徽标判属；仅全局作用域消费，
    // 项目作用域卡片不受影响——磁盘现查语义）。
    lastAddedSkillNames: [] as string[],
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
    // （App.vue）传入，避免 command-store ↔ session-store 的 store 间循环依赖；
    // skillOverrides 同样由调用方传入（App.vue 读 configStore.config.skillOverrides），广播路径
    // 现读现传。load() 按需拉取路径则经 useConfigStore() 现读当前配置（S2-P2-1）——config-store
    // 不依赖 command-store，Pinia action 内运行期才跨 store 解析（house 既有
    // config-store→interaction-store→session-store→config-store 同构环先例，无初始化顺序问题）。
    // - 暂态会话：无条件覆盖（暂态天生只有全局兜底，全局即当前最准的命令集），
    //   写入前按 skillOverrides 过滤（Skill 管理：禁用项不出现在暂态 `/` 菜单）；
    // - 当前活跃的已物化会话：按主进程 N7 同款「commands 空判断」用 cache 回填（保留既有 status，
    //   对齐 setStatusPreservingCommands 语义）；非空不动——per-session 精确集优先，
    //   避免全局 cwd 的命令集覆盖 per-cwd 精确集。非活跃会话不消费（切回时 load 自然拿最新）。
    applyGlobalFallback(snapshot: SessionCommandSnapshot, active: Session | null, skillOverrides?: Record<string, 'off'> | null) {
      // S5：watcher 自动同步的发现同样计入「本次刷新 +N」（同步条 delta 徽标 / 卡片「新增」徽标）。
      // App.vue 在调用本方法前已把 globalSnapshot 覆写为新快照，故 before 取模块级
      // prevGlobalUserSkillSnapshot（上一拍同步点），不读 this.globalSnapshot；watcher 重探已被主进程
      // skillAutoSync 门控，渲染层无需重复判断。diff 与基线同步在既有早退分支之前执行——无活跃会话/
      // 无快照的广播同样推进基线，不产生跨拍假新增；失败终态不经此路径（setGlobalFallback 只产
      // ready/empty）。首拍/无基线时 diff 结果被丢弃（见下方 F3 守卫），有基线才消费。
      const added = diffUserSkills(prevGlobalUserSkillSnapshot, snapshot);
      // F3（round-002 review）：首拍/无基线只建基线不计 delta——下方 delta/lastAdded 写入被守卫跳过，
      // 全部既有 Skill 不标「新增」；有基线才消费 diff 结果。
      const firstShot = !hasUsableBaseline(prevGlobalUserSkillSnapshot);
      if (snapshot) prevGlobalUserSkillSnapshot = snapshot;
      if (!firstShot) {
        this.lastAddedSkillNames = added;
        this.globalSkillDelta = added.length;
      }
      if (!snapshot) return;
      if (active?.transient) {
        // 暂态会话菜单按当前全局禁用配置过滤（物化后由引擎 per-session probe 接管，
        // 引擎级剔除为准）。回填分支（已物化空命令会话）不过滤——那些会话有自己的钉住值。
        const filtered = {
          ...snapshot,
          commands: filterCommandsBySkillOverrides(snapshot.commands, skillOverrides),
        };
        this.snapshotsBySession[active.id] = { ...filtered, sessionId: active.id, source: 'cache' };
        return;
      }
      if (!active) return;
      const current = this.snapshotsBySession[active.id];
      if (current && current.commands.length > 0) return; // per-session 优先
      this.snapshotsBySession[active.id] = current
        ? { ...current, commands: snapshot.commands, source: 'cache', updatedAt: snapshot.updatedAt }
        : { ...snapshot, sessionId: active.id, source: 'cache' };
    },
    // M8 配套：登记暂态会话（见 transientOverridesBySession 注释）。overrides 缺省归一为 null
    // （与显式入参 null 同义：不剔除任何 skill，仅保留暂态识别与 globalSnapshot 回填语义）。
    markTransientSession(sessionId: string, skillOverrides?: Record<string, 'off'> | null) {
      this.transientOverridesBySession[sessionId] = skillOverrides ?? null;
    },
    // M8 配套：注销暂态登记（物化后该 id 恢复普通会话语义，load() 不再过滤）。
    unmarkTransientSession(sessionId: string) {
      delete this.transientOverridesBySession[sessionId];
    },
    // 拉取某会话当前快照（新会话创建后、切回会话时）。失败保留既有快照；没有时不抛到页面。
    // M8+S2-P2-1：暂态会话（登记表在册）的按需拉取入口写入前必须按 skillOverrides 过滤——
    // COMMANDS_GET 对暂态（无 DB 行）走主进程只读分流，返回的是未过滤全局兜底副本，原样写入
    // 会让被禁 skill 回到 `/` 菜单。过滤取值读 useConfigStore() 的「当前」全局配置（与 App.vue
    // 广播路径同源），修复登记表冻结值在暂态存活期间拨开关后被去抖重拉倒退覆盖；登记表仅判
    // 暂态身份。已物化/非暂态路径原样入店不过滤（引擎 per-session probe 接管，钉死语义）。
    // 签名保持单参（N11 契约钉住 `async load(sessionId: string)`）。
    // S2-P2-2：globalSnapshot 哨兵回填移出暂态分支——凡响应为全局兜底派生数据
    //（source==='cache'：兜底副本 / loading 默认 / degraded 克隆，commands 必为未过滤全局集）
    // 即归位哨兵回填，非暂态路径同样回填，修复「启动广播落在订阅前 + 不建暂态会话」时 Skill 页
    // 永停「正在探测」（场景 A）；per-session 权威快照（probe/init/changed）不回填——有钉住
    // 禁用的会话其 probe 快照已被引擎过滤，回填会让 Skill 页丢失禁用项、破坏「未过滤全局快照」
    // 语义。与 App.vue 广播回写同数据源，零新增 IPC。
    async load(sessionId: string) {
      try {
        const snapshot = await window.claudeLink.getSessionCommands(sessionId);
        if (snapshot && snapshot.sessionId === sessionId) {
          if (this.transientOverridesBySession[sessionId] !== undefined) {
            // 暂态：按当前全局配置过滤（配置清空 {} 时过滤为空 = 原快照引用返回）。
            this.snapshotsBySession[sessionId] = {
              ...snapshot,
              commands: filterCommandsBySkillOverrides(snapshot.commands, useConfigStore().config.skillOverrides),
            };
          } else {
            // 非暂态（未登记）：原样入店，行为与改动前一致。
            this.snapshotsBySession[sessionId] = snapshot;
          }
          if (snapshot.source === 'cache') {
            this.globalSnapshot = { ...snapshot, sessionId: GLOBAL_FALLBACK_SESSION_ID };
          }
          // S5：cache 派生响应已回填哨兵快照 → 同步广播 before 基线（'/' 菜单拉取路径刷新快照后，
          // 下一次广播 diff 不把更早已落定条目误报为「本次新增」）。同步语句放 cache 块外，保住既有
          // tdd-skill-overrides-verify ⑳ 的邻接契约钉（cache 块内仅允许哨兵回填赋值一条语句）。
          if (snapshot.source === 'cache' && this.globalSnapshot) {
            prevGlobalUserSkillSnapshot = this.globalSnapshot;
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
    // - 幂等守卫：已有「定态」快照（ready/stale/empty）直接返回，防 tab 反复切换的拉取风暴；
    //   null/loading/degraded/error 放行——loading 是启动空窗占位（主进程探测未完时只读分流返回
    //   loading 默认 + D6 节流重探，探测完成后广播照常补位，两路写入同一份未过滤快照）；
    //   degraded/error 是失败出口（B-1，review 2026-09-18）：Skill 页纯被动消费 globalSnapshot、
    //   无「重开菜单」旁路，守卫若对其早退即永久封死自重试——放行让 ensure 成为显式重试通道。
    // - in-flight 锁：并发调用共享同一 Promise，防重入重复拉取。
    // 副作用核实（docs/review/2026-09-15-skill-management-coldstart-fix.md §2）：仅多写一个
    // snapshotsBySession 哨兵键（全消费端按键取值、无遍历，惰性无害）；主进程侧无 DB 行走只读
    // 分流（不 markSessionActive/不 per-session probe/不调度 post-turn），D6 重探在兜底已就绪时
    // no-op、未就绪时 60s 节流，均为设计内自愈。
    async ensureGlobalSnapshot(): Promise<void> {
      if (globalEnsureInFlight) return globalEnsureInFlight;
      const current = this.globalSnapshot;
      if (
        current &&
        current.status !== 'loading' &&
        current.status !== 'degraded' &&
        current.status !== 'error'
      ) return;
      globalEnsureInFlight = (async () => {
        try {
          await this.load(GLOBAL_FALLBACK_SESSION_ID);
        } finally {
          globalEnsureInFlight = null;
        }
      })();
      return globalEnsureInFlight;
    },
    // S5（2026-10-22 six-issues §7.1）：Skill 页「立即刷新」——经 COMMANDS_REFRESH_GLOBAL 绕过主进程
    // 60s 节流与「仅空时生效」条件直接重探全局兜底快照（主进程在飞去重：探测中等待同一 promise）。
    // 记录刷新前 user-skill 名集合（before）→ invoke → 应用快照 → diff 出本次新增写入 delta/lastAdded
    // （同步条与卡片徽标数据源）。F3：无基线（before 为 null/loading/degraded/error 占位）时成功只写
    // 快照与基线、不写 delta/lastAdded（首拍=基线建立，不视为「本次刷新发现」）。失败两路均沿
    // globalSnapshot status='error'/'degraded' 既有 snap-status
    // 错误条通道呈现，按钮恢复可点（globalRefreshing finally 复位）；失败时 delta/lastAdded 不更新
    //（沿用上次值，不误报 +0）。重置时机：下一次刷新覆盖；重进 Skill tab 由 ConfigPage 调
    // resetSkillFreshState() 清零（防陈旧徽标常驻）。
    async refreshGlobal(): Promise<void> {
      if (this.globalRefreshing) return; // UI disabled + 在飞守卫双保险
      this.globalRefreshing = true;
      const before = this.globalSnapshot;
      try {
        const snapshot = await window.claudeLink.refreshGlobalCommands();
        if (snapshot && snapshot.status !== 'degraded' && snapshot.status !== 'error') {
          // 成功：registry 哨兵快照 REPLACE（幂等），基线同步供下一次广播 diff。
          this.globalSnapshot = snapshot;
          prevGlobalUserSkillSnapshot = snapshot;
          // F3（round-002 review）：无基线（before 为 null/loading/degraded/error 占位）时成功只写
          // 快照与基线、不写 delta/lastAdded（保持默认 0/[]）——首拍=基线建立，不视为「本次刷新发现」。
          if (hasUsableBaseline(before)) {
            this.lastAddedSkillNames = diffUserSkills(before, snapshot);
            this.globalSkillDelta = this.lastAddedSkillNames.length;
          }
        } else {
          // 失败终态（degraded=CLI 缺失 / error=探测失败）：快照不整体 REPLACE——旧命令集保留展示
          //（status/error 取失败终态），错误条呈现；delta/lastAdded 不动（不误报 +0）。
          this.globalSnapshot = {
            ...(this.globalSnapshot ?? createDefaultCommandSnapshot(GLOBAL_FALLBACK_SESSION_ID)),
            status: snapshot?.status ?? 'error',
            error: snapshot?.error ?? 'Global Skill 刷新失败，请稍后重试',
          };
        }
      } catch (e) {
        // invoke 本身失败（web 桥未连接等）：同走错误条通道，快照不 REPLACE。
        this.globalSnapshot = {
          ...(this.globalSnapshot ?? createDefaultCommandSnapshot(GLOBAL_FALLBACK_SESSION_ID)),
          status: 'error',
          error: e instanceof Error ? e.message : 'Global Skill 刷新失败',
        };
      } finally {
        this.globalRefreshing = false;
      }
    },
    // S5：重进 Skill tab 清零 delta/lastAdded（ConfigPage watch(activeTab) skill 分支调用）——
    // 徽标只在「停留在 Skill 页期间发生刷新」的窗口内可见，防陈旧徽标常驻；下一次刷新覆盖重算。
    resetSkillFreshState(): void {
      this.globalSkillDelta = 0;
      this.lastAddedSkillNames = [];
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
      // M8 配套：随会话清理注销暂态登记（防登记表残留；暂态正常路径由物化注销，此处兜底）。
      delete this.transientOverridesBySession[sessionId];
    },
  },
});
