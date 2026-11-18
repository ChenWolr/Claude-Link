// mcp-snapshot-service.ts
// E2（2026-11-15 eight-issues）MCP 快照服务：① collectMcpSnapshotWithAppDeps()——MCP_SNAPSHOT_GET
// handler 的 heavy deps 装配单一收口（原 ipc-handlers 内联装配迁入；recentWorkspaces 换 E4 统一
// 目录源 listRecentAndSessionProjectDirs(20)，其余取法逐字等价）；② warmMcpSnapshot()——ready 后
// 启动预热（契约 #1「静默失败，不阻塞启动窗口」，fire-and-forget 由调用方 void 消费）；③
// broadcastMcpSnapshotInvalidated()——mcp:snapshotChanged 空载荷 {} 失效信号广播（watcher 指纹
// 实变 / E3 WORKSPACE_ADD_RECENT 锚点共用的发射点）。
// overrides 参数为契约测试注入面（行为测试全量钉临时目录，默认装配面在测试中不执行）；
// 生产调用（ipc-handlers / index.ts）一律零参走 app 取现链。
// 本模块是主进程装配点（非纯 node 模块）：import config-manager / sdk-backend / session-repo /
// push-bus 属收口语义本体；纯 node 纪律由 mcp-source-watcher.ts 单独承担。

import * as os from 'node:os';
import { collectMcpSnapshot, type CollectMcpSnapshotDeps, type McpSnapshot } from './mcp-scanner';
import { listRecentAndSessionProjectDirs } from '../project-dir-set';
import { badDirCacheHas, badDirCacheMark } from '../project-skills';
import { normalizeDirKey } from '../../../shared/project-skills';
import { IPC_CHANNELS } from '../../../shared/constants';
import { pushToMainWindow } from '../push-bus';
import { effectiveUserHome } from '../sdk-backend';
import { getConfig } from '../config-manager';
import * as sessionRepo from '../../database/repositories/session-repo';

/** collectMcpSnapshotWithAppDeps 的测试注入面（全字段可选；缺省走 app 取现链=生产形态）。 */
export interface McpSnapshotOverrides {
  /** 缺省 effectiveUserHome() ?? os.homedir()（子进程实际生效 USERPROFILE/HOME）。 */
  userHome?: string | null;
  /** 缺省 E4 统一目录源 listRecentAndSessionProjectDirs(20)。 */
  recentWorkspaces?: string[];
  /** 缺省 getConfig().workingDirectory ?? null。 */
  defaultWorkingDir?: string | null;
  /** 缺省 sessionRepo.listWorkingDirCounts()。 */
  listWorkingDirCounts?: () => Map<string, number>;
  /** 缺省 project-skills.badDirCacheHas（同实例注入）。 */
  badDirHas?: (dir: string) => boolean;
  /** 缺省 project-skills.badDirCacheMark（同实例注入）。 */
  badDirMark?: (dir: string) => void;
}

/**
 * MCP 快照 heavy deps 装配收口（原 ipc-handlers.ts MCP_SNAPSHOT_GET 内联装配迁入本函数；
 * 取法逐字等价——userHome 取现、isDefaultDir 按 defaultWorkingDir 归一判真、recentWorkspaces
 * 为 E4 统一目录源（E4 有意扩集=契约本体）、默认目录独立传参由 scanner 内 mergeProjectDirs
 * 并入、坏目录负缓存与 Skill 共用同一实例）。
 */
export function assembleMcpSnapshotDeps(overrides?: McpSnapshotOverrides): CollectMcpSnapshotDeps {
  const defaultWorkingDir =
    overrides?.defaultWorkingDir !== undefined ? overrides.defaultWorkingDir : (getConfig().workingDirectory ?? null);
  return {
    userHome: overrides?.userHome !== undefined ? overrides.userHome : (effectiveUserHome() ?? os.homedir()),
    isDefaultDir: (dir) => defaultWorkingDir !== null && normalizeDirKey(dir) === normalizeDirKey(defaultWorkingDir),
    recentWorkspaces: overrides?.recentWorkspaces ?? listRecentAndSessionProjectDirs(20),
    defaultWorkingDir,
    listWorkingDirCounts: overrides?.listWorkingDirCounts ?? (() => sessionRepo.listWorkingDirCounts()),
    badDirHas: overrides?.badDirHas ?? badDirCacheHas,
    badDirMark: overrides?.badDirMark ?? badDirCacheMark,
  };
}

/** MCP_SNAPSHOT_GET 数据源：装配 + 收集一体的单一收口（handler 与预热共用）。 */
export function collectMcpSnapshotWithAppDeps(overrides?: McpSnapshotOverrides): Promise<McpSnapshot> {
  return collectMcpSnapshot(assembleMcpSnapshotDeps(overrides));
}

/**
 * 启动预热（契约 #1「主进程 ready 后对默认工作目录+最近工作区集做一次后台快照预热（静默失败，
 * 不阻塞启动窗口）」）：调用方 `void warmMcpSnapshot();` fire-and-forget（index.ts 无 await）；
 * 内部 3s 项目预算 + 负缓存写入由 scanner 既有链承担，任何异常吞掉返回 null（下次进 tab/信号
 * 触发重拉兜底，01 §E2-5 warm-up 失败边界）。
 */
export async function warmMcpSnapshot(overrides?: McpSnapshotOverrides): Promise<McpSnapshot | null> {
  try {
    return await collectMcpSnapshotWithAppDeps(overrides);
  } catch {
    // 静默失败（01 §E2-5：try/catch 静默，logger.debug 级旁路——启动链不打扰，预热失败由
    // 渲染层既有 4 触发时机现查兜底，无状态锁死面）。
    return null;
  }
}

/** E2/E3 失效信号广播发射点：mcp:snapshotChanged 空载荷 {}（§E2-2 形态，渲染层拉取式重拉）。 */
export function broadcastMcpSnapshotInvalidated(): void {
  pushToMainWindow(IPC_CHANNELS.MCP_SNAPSHOT_CHANGED, {});
}
