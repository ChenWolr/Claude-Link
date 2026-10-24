// group-sessions.ts
// 会话侧栏（AppSidebar.vue）「项目分组」的纯聚合逻辑（曾属会话管理页，后随分组入口移入侧栏），
// 抽出为纯函数以便行为测试覆盖（项目无 jest/vitest，靠 tdd-*-verify.ts）。分组依据会话的 workingDir（绝对路径）。

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
// P2 会话置顶（点 S4）：项目视图不做跨组提取（置顶会话仍留在其项目组内，组数与归属不变）；
// 每个组内部排序改为「置顶优先（pinnedAt DESC，后置顶在前），其余保持传入序」——组序权威
// 仍在 listSessions SQL，此处按字段二次保证。undefined（旧数据缺字段）与 null 一致按未置顶。
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
  for (const group of map.values()) {
    // filter 产出新数组，sort 只重排该副本——不触碰原传入序；rest 保持传入序不变。
    const pinned = group.sessions.filter((s) => s.pinnedAt != null)
      .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
    const rest = group.sessions.filter((s) => s.pinnedAt == null);
    group.sessions = [...pinned, ...rest];
  }
  return [...map.values()];
}
