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
// UI13-P3（条目 4）：置顶跨组提取——置顶会话不再留在各自项目组组内浮顶，而是全部抽出组成
// `__pinned__` 组 unshift 到返回数组最前（仅非空时输出），与日期视图行为对齐：两视图置顶一律
// 浮顶整个列表最前，组内按置顶时刻 DESC（后置顶在前）。组序权威仍在 listSessions SQL
//（置顶前缀 ORDER BY），此处按字段二次保证（防御传入序非权威的调用方）。
// undefined（旧数据缺字段）与 null 一致按未置顶（留在原项目组）。
export function groupSessionsByProject(sessions: Session[]): SessionGroup[] {
  // filter 产出新数组，sort 只重排该副本——不触碰原传入序。
  const pinned = sessions.filter((s) => s.pinnedAt != null)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  const map = new Map<string, SessionGroup>();
  for (const s of sessions) {
    if (s.pinnedAt != null) continue; // UI13-P3：置顶跨组提取，不进项目组
    const dir = s.workingDir;
    const key = dir ? dir.replace(/\\/g, '/') : '__none__';
    let group = map.get(key);
    if (!group) {
      group = { key, label: dir ? projectLabel(dir) : '未选择工作空间', dir, sessions: [] };
      map.set(key, group);
    }
    group.sessions.push(s);
  }
  const groups = [...map.values()];
  // '__pinned__' 不会与真实目录归一键冲突（目录键是 normalize 后的路径或 '__none__'）。
  if (pinned.length > 0) {
    groups.unshift({ key: '__pinned__', label: '置顶', dir: null, sessions: pinned });
  }
  return groups;
}
