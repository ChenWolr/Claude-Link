// src/main/modules/project-dir-set.ts
// MCP/Skill 项目目录集单一真相源（E4，2026-11-15 eight-issues）：
// 最近工作区（workspace-history MAX_ENTRIES=12 内建封顶）∪ 会话 distinct 工作目录
// （listRecentWorkingDirs，normalizeDirKey 去重、保序 recent 在前）→ 并集封顶 dirCap（20）。
// 默认工作目录不入本函数——各消费方按既有形态经 mergeProjectDirs(recent, default) 并入/
// 或 concat 尾巴（保持两处消费点的既有默认目录处理逐字等价）。
// 行为契约：docs/plans/2026-11-15-eight-issues-batch/00-behavior-specs.md §E4；
// 契约脚本：scripts/tdd-mcp-skill-dirset-unify-verify.ts（seam 行为测试 + 结构钉）。
// r2-P3-2（2026-11-19 验收 r2）：sessionDirs 边遍历边归一去重——会话目录相互间的大小写/斜杠变体不再双入集（此前仅对 recent 段去重）。
import { listRecentWorkspaces } from './workspace-history';
import { listRecentWorkingDirs } from '../database/repositories/session-repo';
import { normalizeDirKey } from '../../shared/project-skills';

export function listRecentAndSessionProjectDirs(dirCap = 20): string[] {
  const recent = listRecentWorkspaces();
  const seen = new Set(recent.map(normalizeDirKey));
  const sessionDirs = listRecentWorkingDirs(dirCap).filter((d) => {
    const key = normalizeDirKey(d);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...recent, ...sessionDirs].slice(0, dirCap);
}
