// group-sessions-by-date.ts
// 「全部」视图的日期分组纯函数：置顶（P2 会话置顶，点 S4）/ 今天 / 昨天 / 本周更早 / 更早
// （本地时区零点为界，「本周」为周一起算的 ISO 周）。组内保持传入顺序（与 groupSessionsByProject
// 行为一致，依赖 store.displayedSessions 的 SQL 权威序）。now 可注入供测试。

import type { Session } from '../../shared/types/session';

export interface DateSessionGroup {
  key: 'pinned' | 'today' | 'yesterday' | 'week' | 'older';
  label: string;
  sessions: Session[];
}

export const DATE_GROUP_LABELS: Record<DateSessionGroup['key'], string> = {
  pinned: '置顶',
  today: '今天',
  yesterday: '昨天',
  week: '本周更早',
  older: '更早',
};

const DAY_MS = 86400000;

// 本地时区当日零点的时间戳（new Date(y, m, d) 走本地墙钟）。
function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// 与 now 相差的天数（整数，正 = 过去第 N 天；本地零点对零点，round 抵消潜在 DST 半小时偏移）。
function daysAgo(dateMs: number, nowMidnightMs: number): number {
  return Math.round((nowMidnightMs - dateMs) / DAY_MS);
}

// 按日期分桶，输出固定 pinned→today→yesterday→week→older 顺序，跳过空组。
// 置顶组（点 S4）：pinnedAt != null 的会话不进日期桶，按 pinnedAt DESC 自成一组置于最前
//（组序与排序权威在 listSessions SQL，此处按字段二次保证，防御传入序非权威的调用方）；
// 空置顶无组。其余走原日期分桶：updatedAt 解析为 NaN（缺失/非法）→ older；未来时间（时钟偏差）
// 按今天处理；本周判定 = 不早于本周周一（周一起算的 ISO 周）且非今天/昨天（先被前面分支分流）。
export function groupSessionsByDate(sessions: Session[], now: Date = new Date()): DateSessionGroup[] {
  // P2 置顶：先抽出置顶会话（undefined 与 null 一致按未置顶——旧数据/暂态对象可能缺字段），
  // 其余进日期桶，互不混入。
  const pinned = sessions.filter((s) => s.pinnedAt != null);
  const unpinned = sessions.filter((s) => s.pinnedAt == null);
  const buckets: Record<Exclude<DateSessionGroup['key'], 'pinned'>, Session[]> = {
    today: [],
    yesterday: [],
    week: [],
    older: [],
  };
  const nowMidnight = localMidnight(now);
  // 本周一零点：getDay() 0=周日..6=周六，折成周一=0..周日=6 再回退。
  const mondayMidnight = nowMidnight - ((now.getDay() + 6) % 7) * DAY_MS;

  for (const s of unpinned) {
    const t = Date.parse(s.updatedAt);
    if (Number.isNaN(t)) {
      buckets.older.push(s);
      continue;
    }
    const dateMidnight = localMidnight(new Date(t));
    const ago = daysAgo(dateMidnight, nowMidnight);
    if (ago <= 0) buckets.today.push(s);
    else if (ago === 1) buckets.yesterday.push(s);
    else if (dateMidnight >= mondayMidnight) buckets.week.push(s);
    else buckets.older.push(s);
  }

  const order: Exclude<DateSessionGroup['key'], 'pinned'>[] = ['today', 'yesterday', 'week', 'older'];
  const groups: DateSessionGroup[] = order
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: DATE_GROUP_LABELS[key], sessions: buckets[key] }));
  // 置顶组置于日期分组之上（仅非空时输出）；组内按置顶时刻 DESC（后置顶在前）。
  if (pinned.length > 0) {
    groups.unshift({
      key: 'pinned',
      label: DATE_GROUP_LABELS.pinned,
      sessions: [...pinned].sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)),
    });
  }
  return groups;
}
