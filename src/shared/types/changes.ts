// 会话改动面板（Session Changes）的 IPC 类型。
// 与消息流内联的「片段意图 diff」（tool-diff.ts）分工：
//   面板给「当前文件 vs git 基线」的真实净改动（按需 git diff），不抓改前快照、不受工具执行时序影响。
// 判别联合（ok）让渲染层对「非 git 仓库 / git 缺失 / 无差异」等降级分支类型安全。

export type ChangeStatusCode = 'M' | 'A' | 'D' | 'R' | '??' | 'U';

export interface ChangedFile {
  /** 相对 workingDir/repo 的路径，原样用于显示与 diff 查询。 */
  path: string;
  status: ChangeStatusCode;
  /** 仅重命名（R）有：原始路径。 */
  oldPath?: string;
  /** 来自 git numstat 的 +/- 行数；未跟踪文件未取到时为 null。 */
  additions: number | null;
  deletions: number | null;
  /** numstat 返回 "-\t-" 即二进制。 */
  binary: boolean;
  /** 本会话 tool_use 触碰过该文件（Edit/Write/MultiEdit）；主进程按仓库根相对路径比对标注。 */
  touchedThisSession: boolean;
}

export type ChangesListResult =
  | { ok: true; files: ChangedFile[]; baselineRef: string }
  | { ok: false; reason: 'not-a-repo' | 'git-unavailable' | 'error'; message: string };

export type ChangesDiffResult =
  | { ok: true; diff: string; truncated: boolean; binary: boolean; context: number }
  | { ok: false; reason: 'not-a-repo' | 'no-such-file' | 'error'; message: string };

// 「打开」文件（shell.openPath 走系统默认程序）结果。失败分支类型安全：
// 非 git 仓库 / git 缺失 / 文件不在仓库内（越界） / 打开失败（无默认程序等）。
export type ChangesOpenResult =
  | { ok: true }
  | { ok: false; reason: 'not-a-repo' | 'git-unavailable' | 'no-such-file' | 'error'; message: string };
