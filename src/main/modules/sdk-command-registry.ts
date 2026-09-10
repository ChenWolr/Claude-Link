// sdk-command-registry.ts
// 主进程按 Claude Link sessionId 隔离的运行时命令快照注册表。
//
// 职责：
//  ① 把 SDK 原始 SlashCommand（sdk.d.ts:6174，对主进程而言是 unknown）清洗成可结构化克隆的 SdkCommand；
//  ② 按 sessionId 全量替换 / 状态切换 / 清理（commands_changed 全量替换，绝不 concat）；
//  ③ 进程单例 sdkCommandRegistry 供 sdk-backend（发现/清理）与 ipc-handlers（读取/推送）共用同一份快照。
//
// 不依赖 Electron / logger，便于 tsx 行为测试；日志由调用方（sdk-backend）记录。

import type {
  CommandAvailability,
  CommandOrigin,
  CommandOriginContext,
  CommandProvenance,
  CommandSnapshotSource,
  CommandSnapshotStatus,
  SdkCommand,
  SessionCommandSnapshot,
} from '../../shared/types/command';
import {
  createDefaultCommandSnapshot,
  EMPTY_COMMAND_ORIGIN_CONTEXT,
} from '../../shared/types/command';

/** 去除前导 '/'（用户/SDK 偶尔带斜杠），不改大小写；非字符串归空。 */
function normalizeCommandName(value: unknown): string {
  if (typeof value !== 'string') return '';
  let s = value.trim();
  while (s.startsWith('/')) s = s.slice(1);
  return s;
}

/** 来源上下文比较用 canonical key：与 SDK command 清洗同样去斜杠/空白/大小写。 */
function commandNameKey(value: unknown): string {
  return normalizeCommandName(value).toLowerCase();
}

/** 已知 Claude Code builtin 命令名（Task 2：非 Skill、非插件，也不匹配 removed/internal 特征）。 */
export const KNOWN_BUILTIN_NAMES: ReadonlySet<string> = new Set([
  'init', 'clear', 'compact', 'config', 'context', 'heapdump', 'reload-skills', 'review',
  'security-review', 'usage', 'insights', 'recap', 'goal', 'team-onboarding',
]);

const KNOWN_ORIGINS: ReadonlySet<string> = new Set([
  'builtin', 'user-skill', 'project', 'plugin', 'internal', 'removed', 'unknown',
]);

/**
 * 单命令来源分类（Task 2 + review 更新）。分类顺序固定，前序命中即返回：
 *   ① SDK 结构化 provenance（当前 SDK 未提供 → undefined 跳过）；
 *   ② removed 描述（agents 等描述含 (removed)）；
 *   ③ evidence 磁盘证据映射（sdk-command-origin 扫描的用户级/项目级/插件 Skill 与 command 文件）；
 *   ④ 描述 '(user)' 后缀（优先于 skills 集合，SDK 可验证证据）；
 *   ⑤ internal 名称/描述；
 *   ⑥ skills 集合（system.init.skills）；
 *   ⑦ plugins 集合；
 *   ⑧ 已知 builtin 名称集合；
 *   ⑨ unknown（显式差异，不得当作 builtin 完成）。
 * project 来源经 ③ evidence 通道实际生效。
 */
export function classifyOrigin(
  name: string,
  description: string,
  provenance: unknown,
  ctx: CommandOriginContext,
): CommandOrigin {
  if (typeof provenance === 'string' && KNOWN_ORIGINS.has(provenance)) {
    return provenance as CommandOrigin;
  }
  if (description.includes('(removed)')) return 'removed';
  const evidenceKey = commandNameKey(name);
  const evidenceOrigin = ctx.evidence?.origins[evidenceKey];
  if (evidenceOrigin && evidenceOrigin !== 'unknown') return evidenceOrigin;
  // Claude Code 当前 supportedCommands 描述会给用户 Skill 加 '(user)' 标记；这是 SDK
  // 返回的可验证来源证据，优先于 init.skills 的另一套 canonical 名称视图。
  if (/\(user\)\s*$/.test(description)) return 'user-skill';
  if (
    name.startsWith('__') ||
    // P2-15：收窄为词边界/括号形态——裸 'internal' 子串会误伤描述含普通英文单词的用户命令
    //（如 "Audit internal APIs"），被隐藏出菜单。真实内置命令的标记形态是
    // 'server-launched' / 'server session' / 'server-only' / '(internal)'。
    /\bserver-launched\b|\bserver\s+session\b|\bserver-only\b|\(internal\)/i.test(description)
  ) {
    return 'internal';
  }
  const key = commandNameKey(name);
  if (ctx.skills.some((skill) => commandNameKey(skill) === key)) return 'user-skill';
  if (ctx.plugins.some((plugin) => commandNameKey(plugin) === key)) return 'plugin';
  // project 文件来源经 ③ evidence 通道分类生效（sdk-command-origin 磁盘扫描），此处无独立 project 分支。
  if (KNOWN_BUILTIN_NAMES.has(name)) return 'builtin';
  return 'unknown';
}

/** 由来源推导可渲染状态：removed/internal → hidden；unknown → unknown；其余 available。 */
export function availabilityOfOrigin(origin: CommandOrigin): CommandAvailability {
  if (origin === 'removed' || origin === 'internal') return 'hidden';
  if (origin === 'unknown') return 'unknown';
  return 'available';
}

/**
 * 把 SDK 原始 SlashCommand 清洗成 SdkCommand。
 * - name 为空（或去 / 后为空）→ 丢弃（返回 undefined）。
 * - 非字符串 description / argumentHint → 空字符串。
 * - aliases 过滤非字符串、去前导 /、大小写不敏感去重、去掉与 canonical name 同名者。
 * - 强制 source: 'sdk'；构造新对象，不泄漏 SDK 原始私有字段。
 * - 依 CommandOriginContext 分类出 origin / availability（Task 2）。
 */
export function toSdkCommand(
  raw: unknown,
  ctx: CommandOriginContext = EMPTY_COMMAND_ORIGIN_CONTEXT,
): SdkCommand | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const name = normalizeCommandName(r.name);
  if (!name) return undefined;
  const description = typeof r.description === 'string' ? r.description : '';
  const argumentHint = typeof r.argumentHint === 'string' ? r.argumentHint : '';
  const aliases: string[] = [];
  const seen = new Set<string>();
  const nameKey = name.toLowerCase();
  if (Array.isArray(r.aliases)) {
    for (const a of r.aliases) {
      const n = normalizeCommandName(a);
      if (!n) continue;
      const key = n.toLowerCase();
      if (key === nameKey) continue; // alias 与 canonical 同名 → 跳过
      if (seen.has(key)) continue; // 大小写不敏感去重
      seen.add(key);
      aliases.push(n);
    }
  }
  const origin = classifyOrigin(name, description, r.provenance, ctx);
  return {
    name,
    description,
    argumentHint,
    aliases,
    source: 'sdk',
    origin,
    availability: availabilityOfOrigin(origin),
  };
}

/**
 * 全局兜底快照的哨兵 sessionId。启动时与 watcher 热刷新时都会执行「全局命令探测」（无会话绑定），结果写入
 * registry.globalFallback；任何无 per-session 快照的会话经 COMMANDS_GET 取此兜底（复制 + 改 sessionId
 * + source:'cache'），实现「重启后旧会话立即可用 + 探测异常时的容错兜底」。per-session 快照永远优先。
 */
export const GLOBAL_FALLBACK_SESSION_ID = '__global_command_fallback__';

export class SdkCommandRegistry {
  private readonly snapshots = new Map<string, SessionCommandSnapshot>();
  // F4：单调代际号。replace 递增，用于区分「异步旧 probe 结果」与「较新 commands_changed」；
  // 异步 supportedCommands 完成后校验，只有仍是启动时代际才写入，防止旧结果覆盖新列表。
  private readonly revisions = new Map<string, number>();
  // 启动全局兜底快照（无会话绑定）。仅当某 session 无 per-session 快照时作为兜底显现，
  // 被 per-session（probe/init/changed）任意来源覆盖。不分代际（启动探测与 watcher 热刷新共用入口、会被反复重写；不与 per-session 竞争）。
  private globalFallback: SessionCommandSnapshot | null = null;

  /** 当前命令快照的代际号（默认 0）。 */
  getRevision(sessionId: string): number {
    return this.revisions.get(sessionId) ?? 0;
  }

  /** 读取快照；不存在时返回默认 loading 快照（不入库，纯派生值）。 */
  get(sessionId: string): SessionCommandSnapshot {
    return this.snapshots.get(sessionId) ?? createDefaultCommandSnapshot(sessionId);
  }

  /** 是否已存在该 session 的真实快照（区分「从未探测」与「loading 占位」）。 */
  has(sessionId: string): boolean {
    return this.snapshots.has(sessionId);
  }

  /**
   * 全量替换某 session 的命令列表（commands_changed / probe / init 共用入口）。
   * - 不 concat：旧命令完全消失。
   * - 逐条清洗 + 同名（大小写不敏感）去重。
   * - 非空 → ready；空 → empty。
   * - originFingerprint（D5）：用户级来源目录出生指纹，由调用方传 getUserOriginFingerprint() 现值；
   *   watcher 未启动时缺省 → 字段缺省，COMMANDS_GET 不做指纹比对（不误标 stale）。
   * - projectOriginFingerprint（P2-14）：项目级来源目录出生指纹，probe 成功时由调用方传
   *   getProjectOriginFingerprint(session.cwd)；缺省不写，COMMANDS_GET 不做项目级比对（不误标 stale）。
   */
  replace(
    sessionId: string,
    rawCommands: unknown[],
    source: CommandSnapshotSource,
    ctx: CommandOriginContext = EMPTY_COMMAND_ORIGIN_CONTEXT,
    originFingerprint?: string,
    projectOriginFingerprint?: string,
  ): SessionCommandSnapshot {
    const commands = this.cleanCommands(rawCommands, ctx);
    const snapshot: SessionCommandSnapshot = {
      sessionId,
      commands,
      status: commands.length > 0 ? 'ready' : 'empty',
      source,
      updatedAt: new Date().toISOString(),
      ...(originFingerprint !== undefined ? { originFingerprint } : {}),
      // P2-14：项目级出生指纹（probe 成功时附带；缺省不写不比对）。
      ...(projectOriginFingerprint !== undefined ? { projectOriginFingerprint } : {}),
    };
    this.revisions.set(sessionId, (this.revisions.get(sessionId) ?? 0) + 1);
    this.snapshots.set(sessionId, snapshot);
    return snapshot;
  }

  /**
   * 切换状态（probe 失败 → degraded/error；恢复 → ready）。
   * 保留已有 commands：缓存命令不清空，断网/探测失败时仍可本地显示与过滤（计划 §0.2-8）。
   */
  setStatus(sessionId: string, status: CommandSnapshotStatus, error?: string): SessionCommandSnapshot {
    const current = this.snapshots.get(sessionId) ?? createDefaultCommandSnapshot(sessionId);
    const snapshot: SessionCommandSnapshot = {
      ...current,
      status,
      ...(error !== undefined ? { error } : {}),
    };
    this.snapshots.set(sessionId, snapshot);
    return snapshot;
  }
  /**
   * 切换 non-ready 状态（loading / stale / degraded / error）但保留「最佳可用命令」：
   * 优先 per-session 已有命令，否则 fallback 到 globalFallback 命令（全局兜底，启动/watcher 热刷新共用）。
   * N7：避免 0 命令的 loading/degraded 快照覆盖本可用的全局 cache——probe 进行中或失败时，用户仍能看到
   * 兜底命令。ready 用 replace（权威命令），不走此方法。
   */
  setStatusPreservingCommands(sessionId: string, status: CommandSnapshotStatus, error?: string): SessionCommandSnapshot {
    const current = this.snapshots.get(sessionId) ?? createDefaultCommandSnapshot(sessionId);
    const commands = current.commands.length > 0 ? current.commands : (this.globalFallback?.commands ?? []);
    // 命令来源：保留 per-session 既有 source；命令取自 globalFallback 时标 cache（兜底）。
    const source = current.commands.length > 0 ? current.source : this.globalFallback ? 'cache' : current.source;
    const snapshot: SessionCommandSnapshot = {
      sessionId,
      commands,
      status,
      source,
      updatedAt: new Date().toISOString(),
      // D5：保留出生指纹——状态切换重建快照对象，若不带回该字段，首次降级/loading 后指纹丢失，
      // COMMANDS_GET 的过期比对（旧会话惰性刷新）对该会话永久失效。
      ...(current.originFingerprint !== undefined ? { originFingerprint: current.originFingerprint } : {}),
      // P2-14：项目级出生指纹同生命周期保留。
      ...(current.projectOriginFingerprint !== undefined ? { projectOriginFingerprint: current.projectOriginFingerprint } : {}),
      ...(error !== undefined ? { error } : {}),
    };
    this.snapshots.set(sessionId, snapshot);
    return snapshot;
  }

  /** 删除某 session 的快照（markSessionDeleted 收口调用）；只影响指定 session。 */
  clear(sessionId: string): void {
    this.snapshots.delete(sessionId);
    this.revisions.delete(sessionId);
  }

  /** 清洗 SDK 原始命令为 SdkCommand[] + 同名（大小写不敏感）去重；replace 与 setGlobalFallback 共用。 */
  private cleanCommands(
    rawCommands: unknown[],
    ctx: CommandOriginContext = EMPTY_COMMAND_ORIGIN_CONTEXT,
  ): SdkCommand[] {
    const commands: SdkCommand[] = [];
    const seenNames = new Set<string>();
    for (const raw of rawCommands) {
      const c = toSdkCommand(raw, ctx);
      if (!c) continue;
      const key = c.name.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      commands.push(c);
    }
    return commands;
  }

  /**
   * 写入全局兜底快照（无会话绑定）。逐条清洗 + 去重，与 replace 同款；非空→ready / 空→empty。
   * 不参与 per-session 代际号机制（per-session 快照永远优先显现）。启动探测（index.ts whenReady）
   * 与 watcher 指纹热刷新（D4）共用此入口，运行期会被反复重写。sessionId 用哨兵
   * GLOBAL_FALLBACK_SESSION_ID，回填会话时由调用方覆盖。
   */
  setGlobalFallback(
    rawCommands: unknown[],
    source: CommandSnapshotSource,
    ctx: CommandOriginContext = EMPTY_COMMAND_ORIGIN_CONTEXT,
  ): SessionCommandSnapshot {
    const commands = this.cleanCommands(rawCommands, ctx);
    const snapshot: SessionCommandSnapshot = {
      sessionId: GLOBAL_FALLBACK_SESSION_ID,
      commands,
      status: commands.length > 0 ? 'ready' : 'empty',
      source,
      updatedAt: new Date().toISOString(),
    };
    this.globalFallback = snapshot;
    return snapshot;
  }

  /** 读取全局兜底快照；未探测返回 null。 */
  getGlobalFallback(): SessionCommandSnapshot | null {
    return this.globalFallback;
  }

  /** 清空全局兜底（app 退出 / 强制重置时）。不影响任何 per-session 快照。 */
  clearGlobalFallback(): void {
    this.globalFallback = null;
  }

  /**
   * 命令来源诊断（Task 8）：从已清洗快照派生 provenance 摘要——聚合计数 + unknown/hidden 命令名。
   * 只读、无副作用，不触发 probe。优先用 per-session 快照；无则用全局兜底；都没有返回 total=0 的空诊断。
   */
  getCommandProvenance(sessionId: string): CommandProvenance {
    const snapshot = this.snapshots.get(sessionId) ?? this.globalFallback;
    const commands = snapshot?.commands ?? [];
    const byOrigin: Record<CommandOrigin, number> = {
      builtin: 0,
      'user-skill': 0,
      project: 0,
      plugin: 0,
      internal: 0,
      removed: 0,
      unknown: 0,
    };
    const byAvailability = { available: 0, hidden: 0, unknown: 0 };
    const unknownNames: string[] = [];
    const hiddenNames: string[] = [];
    for (const c of commands) {
      byOrigin[c.origin] += 1;
      byAvailability[c.availability] += 1;
      if (c.origin === 'unknown') unknownNames.push(c.name);
      if (c.availability === 'hidden') hiddenNames.push(c.name);
    }
    return {
      sessionId,
      total: commands.length,
      byOrigin,
      byAvailability,
      unknownNames,
      hiddenNames,
      generatedAt: new Date().toISOString(),
    };
  }
}

/** 进程单例：sdk-backend（发现/清理）与 ipc-handlers（读取/推送）共用同一份运行时快照。 */
export const sdkCommandRegistry = new SdkCommandRegistry();

/**
 * 命令来源诊断顶层导出（Task 8）：供 ipc-handlers 经 chat-backend 聚合出口暴露给 renderer。
 * 与 getNativeSettingsDiagnostic 的导出形态对称（顶层函数包装进程单例方法）。
 */
export function getCommandProvenance(sessionId: string): CommandProvenance {
  return sdkCommandRegistry.getCommandProvenance(sessionId);
}
