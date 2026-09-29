// group-sessions-by-date.ts
// 「全部」视图的日期分组纯函数：今天 / 昨天 / 本周更早 / 更早（本地时区零点为界，
// 「本周」为周一起算的 ISO 周）。组内保持传入顺序（与 groupSessionsByProject 行为一致，
// 依赖 store.displayedSessions 的 updatedAt 倒序）。now 可注入供测试。

import type { Session } from '../../shared/types/session';

export interface DateSessionGroup {
  key: 'today' | 'yesterday' | 'week' | 'older';
  label: string;
  sessions: Session[];
}

export const DATE_GROUP_LABELS: Record<DateSessionGroup['key'], string> = {
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

// 按日期分桶，输出固定 today→yesterday→week→older 顺序，跳过空组。
// 边界：updatedAt 解析为 NaN（缺失/非法）→ older；未来时间（时钟偏差）按今天处理；
// 本周判定 = 不早于本周周一（周一起算的 ISO 周）且非今天/昨天（先被前面分支分流）。
export function groupSessionsByDate(sessions: Session[], now: Date = new Date()): DateSessionGroup[] {
  const buckets: Record<DateSessionGroup['key'], Session[]> = {
    today: [],
    yesterday: [],
    week: [],
    older: [],
  };
  const nowMidnight = localMidnight(now);
  // 本周一零点：getDay() 0=周日..6=周六，折成周一=0..周日=6 再回退。
  const mondayMidnight = nowMidnight - ((now.getDay() + 6) % 7) * DAY_MS;

  for (const s of sessions) {
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

  const order: DateSessionGroup['key'][] = ['today', 'yesterday', 'week', 'older'];
  return order
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: DATE_GROUP_LABELS[key], sessions: buckets[key] }));
}
