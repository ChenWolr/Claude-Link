// group-sessions.ts
// 会话管理页「项目分组」的纯聚合逻辑，从 SessionsPage.vue 抽出以便行为测试覆盖
//（项目无 jest/vitest，靠 tdd-*-verify.ts）。分组依据会话的 workingDir（绝对路径）。

import type { Session } from '../../shared/types/session';

export interface SessionGroup {
  key: string;
  label: string;
  dir: string | null;
  sessions: Session[];
}

// 取项目名：workingDir 为绝对路径，展示末段目录名（与 SessionToolbar 的工作空间标签一致）。
// 统一把反斜杠折成正斜杠再切分，兼容 Windows 路径。
export function projectLabel(dir: string): string {
  const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || dir;
}

// 按 workingDir 分组，保持首次出现的顺序；无工作空间的会话归入「未选择工作空间」。
// key 把反斜杠折成正斜杠再比较：Windows 下两种分隔符指向同一目录，须归入同一组。
export function groupSessionsByProject(sessions: Session[]): SessionGroup[] {
  const map = new Map<string, SessionGroup>();
  for (const s of sessions) {
    const dir = s.workingDir;
    const key = dir ? dir.replace(/\\/g, '/') : '__none__';
    let group = map.get(key);
    if (!group) {
      group = { key, label: dir ? projectLabel(dir) : '未选择工作空间', dir, sessions: [] };
      map.set(key, group);
    }
    group.sessions.push(s);
  }
  return [...map.values()];
}
