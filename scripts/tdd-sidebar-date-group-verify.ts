// tdd-sidebar-date-group-verify.ts
// 侧栏 Quiet Console 重设计（2026-09-27 计划 §2.3/§2.4）TDD 验证脚本：
//   G1–G8  groupSessionsByDate——「全部」视图日期分组纯函数（今天/昨天/本周更早/更早）；
//   T1–T7  formatSessionTime——时间列纯格式化（HH:mm/昨天/周X/M月D日/YYYY年M月D日）。
// 周一为 ISO 周起点；本地时区零点为界；updatedAt 非法/缺失归「更早」、时间列空串，不抛错。
// 运行：npx tsx scripts/tdd-sidebar-date-group-verify.ts（已登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import type { Session } from '../src/shared/types/session';
import {
  groupSessionsByDate,
  DATE_GROUP_LABELS,
  type DateSessionGroup,
} from '../src/renderer/utils/group-sessions-by-date';
import { formatSessionTime } from '../src/renderer/utils/format-session-time';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

// 本地墙钟 → ISO（解析回同一时刻，本地零点计算与构造时一致）
function iso(y: number, m: number, d: number, hh = 12, mm = 0): string {
  return new Date(y, m - 1, d, hh, mm, 0).toISOString();
}
function session(id: string, updatedAt: string): Session {
  // 最小 Session 形（分组/格式化只消费 id + updatedAt；其余字段给类型合法的中性值）
  return {
    id,
    name: `会话-${id}`,
    cliSessionId: null,
    model: 'test-model',
    providerOverride: null,
    modelOverride: null,
    workingDir: null,
    permissionMode: null,
    maxTurns: 0,
    thinkingLevel: null,
    skillOverrides: null,
    createdAt: updatedAt,
    updatedAt,
    lastContextTokens: null,
    lastContextUpdatedAt: null,
  } as unknown as Session;
}
function keys(groups: DateSessionGroup[]): string[] {
  return groups.map((g) => g.key);
}

// 固定「现在」：2026-09-23（周三）15:00 本地时间
const NOW = new Date(2026, 8, 23, 15, 0, 0);

console.log('\n=== G1–G8 · groupSessionsByDate 日期分组 ===');

check('G1 空数组 → 空数组', () => {
  assert.deepEqual(groupSessionsByDate([], NOW), []);
});
check('G2 全部今天 → 单「今天」组', () => {
  const groups = groupSessionsByDate(
    [session('a', iso(2026, 9, 23, 9, 15)), session('b', iso(2026, 9, 23, 14, 32))],
    NOW,
  );
  assert.deepEqual(keys(groups), ['today']);
  assert.equal(groups[0].label, '今天');
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['a', 'b']);
});
check('G3 四桶齐 → today/yesterday/week/older 固定顺序 + 标签', () => {
  const groups = groupSessionsByDate(
    [
      session('older', iso(2026, 9, 15, 10, 0)),
      session('week', iso(2026, 9, 21, 10, 0)),
      session('yesterday', iso(2026, 9, 22, 10, 0)),
      session('today', iso(2026, 9, 23, 10, 0)),
    ],
    NOW,
  );
  assert.deepEqual(keys(groups), ['today', 'yesterday', 'week', 'older']);
  assert.deepEqual(groups.map((g) => g.label), ['今天', '昨天', '本周更早', '更早']);
  assert.deepEqual(
    groups.map((g) => g.sessions[0].id),
    ['today', 'yesterday', 'week', 'older'],
  );
});
check('G4 ISO 周边界：now=周三，本周周一的会话 → week', () => {
  const groups = groupSessionsByDate([session('mon', iso(2026, 9, 21, 8, 0))], NOW);
  assert.deepEqual(keys(groups), ['week']);
});
check('G5 ISO 周边界：now=周一，上周日的会话 → older（不落入 week/yesterday）', () => {
  const monday = new Date(2026, 8, 21, 15, 0, 0);
  const groups = groupSessionsByDate([session('lastSun', iso(2026, 9, 13, 20, 0))], monday);
  assert.deepEqual(keys(groups), ['older']);
});
check('G5b now=周一，昨天（上周日）的会话 → yesterday（yesterday 优先于 ISO 周归属）', () => {
  const monday = new Date(2026, 8, 21, 15, 0, 0);
  const groups = groupSessionsByDate([session('yestSun', iso(2026, 9, 20, 20, 0))], monday);
  assert.deepEqual(keys(groups), ['yesterday']);
});
check('G6 updatedAt 非法/空串 → 归 older，不抛错', () => {
  const groups = groupSessionsByDate(
    [session('bad', 'not-a-date'), session('empty', '')],
    NOW,
  );
  assert.deepEqual(keys(groups), ['older']);
  assert.equal(groups[0].sessions.length, 2);
});
check('G7 组内顺序保持传入顺序（today 两会话不重排）', () => {
  const groups = groupSessionsByDate(
    [session('late', iso(2026, 9, 23, 18, 0)), session('early', iso(2026, 9, 23, 8, 0))],
    NOW,
  );
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['late', 'early']);
});
check('G8 now 注入生效（不读真实时钟）', () => {
  // 会话与 now 同一天：若误用真实时钟（2026-09 之后）则会落到 older
  const groups = groupSessionsByDate([session('x', iso(2026, 1, 15, 8, 0))], new Date(2026, 0, 15, 22, 0, 0));
  assert.deepEqual(keys(groups), ['today']);
});
check('G9 DATE_GROUP_LABELS 四键齐全', () => {
  assert.deepEqual(DATE_GROUP_LABELS, { today: '今天', yesterday: '昨天', week: '本周更早', older: '更早' });
});

console.log('\n=== T1–T7 · formatSessionTime 时间列格式化 ===');

check('T1 空/null/非法 → 空串（不抛错）', () => {
  assert.equal(formatSessionTime(null, NOW), '');
  assert.equal(formatSessionTime(undefined, NOW), '');
  assert.equal(formatSessionTime('', NOW), '');
  assert.equal(formatSessionTime('not-a-date', NOW), '');
});
check('T2 今天 → HH:mm 两位补零', () => {
  assert.equal(formatSessionTime(iso(2026, 9, 23, 9, 5), NOW), '09:05');
  assert.equal(formatSessionTime(iso(2026, 9, 23, 14, 32), NOW), '14:32');
});
check('T3 昨天 → 「昨天」', () => {
  assert.equal(formatSessionTime(iso(2026, 9, 22, 9, 5), NOW), '昨天');
});
check('T4 本周更早 → 周一..周日（getDay 0→周日）', () => {
  assert.equal(formatSessionTime(iso(2026, 9, 21, 9, 0), NOW), '周一'); // 本周一
  // now=周日：本周四 → 「周四」
  const sunday = new Date(2026, 8, 27, 12, 0, 0);
  assert.equal(formatSessionTime(iso(2026, 9, 24, 9, 0), sunday), '周四');
});
check('T5 今年更早 → M月D日（无补零）', () => {
  assert.equal(formatSessionTime(iso(2026, 9, 15, 9, 0), NOW), '9月15日');
  assert.equal(formatSessionTime(iso(2026, 1, 5, 9, 0), NOW), '1月5日');
});
check('T6 跨年 → YYYY年M月D日', () => {
  assert.equal(formatSessionTime(iso(2025, 12, 31, 9, 0), NOW), '2025年12月31日');
});
check('T7 now 注入生效 + 今天优先（同时刻换 now 结果随动）', () => {
  const t = iso(2026, 9, 21, 10, 0);
  assert.equal(formatSessionTime(t, NOW), '周一'); // now=周三：本周一
  assert.equal(formatSessionTime(t, new Date(2026, 8, 21, 12, 0, 0)), '10:00'); // now=当天
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
