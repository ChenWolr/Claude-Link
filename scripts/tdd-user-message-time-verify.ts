// tdd-user-message-time-verify.ts
// 六问题修 P1「用户消息增加发送时间」（2026-10-22 计划 §2.7，方案 A 气泡内『发送于』脚注，点 S3）
// TDD 验证脚本：
//   S1–S4  源码契约——format-duration.ts 新导出 formatSentAt（ISO 字符串入参、空/NaN 返空串）
//          且 formatEndedAt 签名未变（TurnTimer/气泡脚注在用，epoch ms 入参不动）；
//          MessageBubble.vue 引用 formatSentAt 并渲染「发送于」user 门控脚注（复用 .bubble__meta）。
//   F1–F5  formatSentAt 纯函数用例——空/非法串返空串、当天 HH:mm（两位补零、分钟级无秒）、
//          跨天 M/d HH:mm（月日不补零）、带 Z 的 UTC ISO 本地化显示；
//          F5 formatEndedAt 行为回归钉（当天 HH:mm:ss / 跨天 M/d HH:mm，签名改动即红）。
// 边界自查（计划 §2.4）：createdAt 缺失/非法 → '' → 脚注 v-if 不渲染；跨时区由 normalizeDbTime
// 保证带 Z，函数内 new Date() 本地化；DB 秒级 vs 乐观消息毫秒级 ISO 均可解析。
// 运行：npx tsx scripts/tdd-user-message-time-verify.ts（已登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatSentAt, formatEndedAt } from '../src/shared/format-duration';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const bubbleSrc = readFileSync(join(__dirname, '../src/renderer/components/chat/MessageBubble.vue'), 'utf8');
const fdSrc = readFileSync(join(__dirname, '../src/shared/format-duration.ts'), 'utf8');

// 本地墙钟 → ISO（解析回同一时刻；以真实「今天」为基准构造当天/昨天用例，不依赖具体日期）
const NOW = new Date();
function todayAt(hh: number, mm: number): Date {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), hh, mm, 0);
}
function yesterdayAt(hh: number, mm: number): Date {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1, hh, mm, 0);
}

console.log('\n=== S1–S4 · 源码契约 ===');

check('S1 format-duration.ts 导出 formatSentAt（ISO 字符串入参签名）', () => {
  assert.ok(
    fdSrc.includes('export function formatSentAt(iso: string | null | undefined): string'),
    'format-duration.ts 应含 export function formatSentAt(iso: string | null | undefined): string',
  );
});
check('S2 formatEndedAt 签名未变（epoch ms 入参 + now 注入默认值，TurnTimer 在用）', () => {
  assert.ok(
    fdSrc.includes('export function formatEndedAt(ts: number | null | undefined, now: number = Date.now()): string'),
    'formatEndedAt 签名被改动——TurnTimer.vue/MessageBubble.vue 均在用，禁止动签名',
  );
});
check('S3 MessageBubble.vue 引用 formatSentAt（import/computed）', () => {
  assert.ok(bubbleSrc.includes('formatSentAt'), 'MessageBubble.vue 应引用 formatSentAt');
  assert.ok(
    /sentAtText\s*=\s*computed/.test(bubbleSrc),
    'MessageBubble.vue 应有 sentAtText computed',
  );
});
check('S4 MessageBubble.vue 渲染「发送于」脚注（user 门控 + 复用 bubble__meta）', () => {
  assert.ok(bubbleSrc.includes('发送于 {{ sentAtText }}'), '脚注文案应为「发送于 {{ sentAtText }}」');
  assert.ok(
    bubbleSrc.includes("message.role === 'user' && sentAtText"),
    '脚注应以 message.role === \'user\' && sentAtText 门控',
  );
  // 脚注元素复用既有样式类，零新增 CSS
  assert.ok(/v-if="message\.role === 'user' && sentAtText" class="bubble__meta"/.test(bubbleSrc), '脚注应复用 .bubble__meta');
  assert.ok(/bubble__meta-clock/.test(bubbleSrc), '脚注应复用 .bubble__meta-clock 图标类');
});

console.log('\n=== F1–F5 · formatSentAt 纯函数用例 ===');

check('F1 空串/null/undefined/非法串 → 空串（不抛错，诚实不造数）', () => {
  assert.equal(formatSentAt(''), '');
  assert.equal(formatSentAt(null), '');
  assert.equal(formatSentAt(undefined), '');
  assert.equal(formatSentAt('not-a-date'), '');
});
check('F2 当天 → HH:mm（两位补零、分钟级无秒）', () => {
  assert.equal(formatSentAt(todayAt(9, 5).toISOString()), '09:05');
  assert.equal(formatSentAt(todayAt(14, 32).toISOString()), '14:32');
});
check('F3 跨天 → M/d HH:mm（月日不补零）', () => {
  const y = yesterdayAt(9, 5);
  const expected = `${y.getMonth() + 1}/${y.getDate()} 09:05`;
  assert.equal(formatSentAt(y.toISOString()), expected);
});
check('F4 带 Z 的 UTC ISO（DB normalizeDbTime 形态）→ 本地化显示正确', () => {
  // 本地时刻经 toISOString()（必带 Z、毫秒级）往返，本地化回读应还原同一 HH:mm
  const t = todayAt(14, 5);
  assert.equal(formatSentAt(t.toISOString()), '14:05');
  // 秒级 DB 形态（YYYY-MM-DDTHH:MM:SSZ）同刻可解析；同一天则显示分钟级 HH:mm
  const z = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}T09:05:00Z`;
  const parsed = new Date(z);
  const localSameDay = parsed.toDateString() === new Date().toDateString();
  const expected = localSameDay
    ? `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`
    : `${parsed.getMonth() + 1}/${parsed.getDate()} ${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
  assert.equal(formatSentAt(z), expected);
});
check('F5 formatEndedAt 行为回归钉（当天 HH:mm:ss / 跨天 M/d HH:mm / 无效空串）', () => {
  assert.equal(formatEndedAt(null), '');
  assert.equal(formatEndedAt(undefined), '');
  assert.equal(formatEndedAt(0), '');
  assert.equal(formatEndedAt(Number.NaN), '');
  assert.equal(formatEndedAt(todayAt(9, 5).getTime()), '09:05:00');
  const y = yesterdayAt(9, 5);
  assert.equal(formatEndedAt(y.getTime()), `${y.getMonth() + 1}/${y.getDate()} 09:05`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
