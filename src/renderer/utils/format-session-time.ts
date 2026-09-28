// format-session-time.ts
// 侧栏时间列纯格式化：今天 → 'HH:mm'；昨天 → '昨天'；本周更早 → '周一'..'周日'；
// 今年更早 → 'M月D日'；跨年 → 'YYYY年M月D日'。非法/空 updatedAt → ''（不抛错）。
// now 可注入供测试；周判定与 group-sessions-by-date 同口径（周一起算的 ISO 周）。

const DAY_MS = 86400000;
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function formatSessionTime(isoUpdatedAt: string | null | undefined, now: Date = new Date()): string {
  if (!isoUpdatedAt) return '';
  const t = Date.parse(isoUpdatedAt);
  if (Number.isNaN(t)) return '';

  const date = new Date(t);
  const nowMidnight = localMidnight(now);
  const dateMidnight = localMidnight(date);
  const ago = Math.round((nowMidnight - dateMidnight) / DAY_MS);

  if (ago <= 0) {
    // 今天（含时钟偏差下的未来时间）：HH:mm 两位补零
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  if (ago === 1) return '昨天';
  if (dateMidnight >= nowMidnight - ((now.getDay() + 6) % 7) * DAY_MS) {
    // 本周（不早于本周周一，周一起算）：周X
    return WEEKDAY_LABELS[date.getDay()];
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  const md = `${date.getMonth() + 1}月${date.getDate()}日`;
  return sameYear ? md : `${date.getFullYear()}年${md}`;
}
