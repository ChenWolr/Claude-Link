// turn-file-git-baseline-repo.ts
// 首改文件 git HEAD 基线的读写（计划 docs/plans/2026-11-02-turn-diff-first-turn-git-baseline-plan.md
// §3/§4-P1）：基线内容在首次解析时一次性冻结（INSERT OR IGNORE）——正基线 = 该时点 HEAD 内容；
// 负结果（非 git/未跟踪/含 \0/超时等）落 content IS NULL 行，同 (session_id, path_key) 永久不再
// 重试。此后用户中途 commit、重启应用、任何时候再看首改 diff，读到的都是冻结值（不重读 git）。
// 三态约定：get 返回 undefined = 无行（尚未试过）；null = 负结果已冻结；string = 正基线。
import { getConnection } from '../connection';

/** 读基线三态：undefined=无行未试过 / null=负结果已冻结 / string=正基线。 */
export function getGitBaseline(sessionId: string, pathKey: string): string | null | undefined {
  const row = getConnection()
    .prepare('SELECT content FROM turn_file_git_baselines WHERE session_id = ? AND path_key = ? LIMIT 1')
    .get(sessionId, pathKey) as { content: string | null } | undefined;
  return row === undefined ? undefined : row.content;
}

/** 一次性冻结（INSERT OR IGNORE：已有行——含负结果行——不覆盖首值）。content=null 表示负结果。 */
export function setGitBaseline(sessionId: string, pathKey: string, content: string | null): void {
  getConnection()
    .prepare('INSERT OR IGNORE INTO turn_file_git_baselines (session_id, path_key, content) VALUES (?, ?, ?)')
    .run(sessionId, pathKey, content);
}
