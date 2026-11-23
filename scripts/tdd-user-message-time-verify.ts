// tdd-user-message-time-verify.ts
// 六问题修 P1「用户消息增加发送时间」（2026-10-22 计划 §2.7，点 S3）
// UI13-P5 改钉（2026-11-14）：「发送于」自气泡内 .bubble__meta 脚注迁至气泡正下方 caption 行
// 「你 · 发送于 {HH:mm}」——S4 重写为新位置钉（含负向断言防双时间戳/双「你」回退），
// S1/S2/S3 与 F1–F5 原样保留（formatSentAt 单源与口径未变）。
// TDD 验证脚本：
//   S1–S4  源码契约——format-duration.ts 新导出 formatSentAt（ISO 字符串入参、空/NaN 返空串）
//          且 formatEndedAt 签名未变（TurnTimer/气泡脚注在用，epoch ms 入参不动）；
//          MessageBubble.vue 引用 formatSentAt 并把「你 · 发送于 {{ sentAtText }}」渲染于
//          气泡正下方 bubble-caption 行（user 门控；气泡内不再含「你」角色头与「发送于」脚注）。
//   F1–F5  formatSentAt 纯函数用例——空/非法串返空串、当天 HH:mm:ss（P3 2026-11-21 批次升秒级，
//          三段两位补零）、跨天 M/d HH:mm:ss（月日不补零、秒位补零）、带 Z 的 UTC ISO 本地化显示；
//          F5 formatEndedAt 行为回归钉（当天 HH:mm:ss / 跨天 M/d HH:mm，签名改动即红）。
//   P3-T5~T7（2026-11-21 批次）caption 对齐②样式钉——caption 块内时钟 svg 同形（bubble-caption-clock）、
//          .bubble-caption 与 .bubble__meta 视觉同系（font-size/color/tabular-nums）、文案单源无旁路。
// 边界自查（计划 §2.4）：createdAt 缺失/非法 → '' → caption 行 v-if 不渲染；跨时区由 normalizeDbTime
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
function todayAt(hh: number, mm: number, ss = 0): Date {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), hh, mm, ss);
}
function yesterdayAt(hh: number, mm: number, ss = 0): Date {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1, hh, mm, ss);
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
check('S4 MessageBubble.vue 渲染「你 · 发送于」caption 行（气泡正下方，user 门控；UI13-P5 新位置钉）', () => {
  // 新位置：气泡正下方一行「你 · 发送于 {HH:mm}」（bubble-caption），随 user 气泡右对齐。
  assert.ok(bubbleSrc.includes('你 · 发送于 {{ sentAtText }}'), 'caption 行文案应为「你 · 发送于 {{ sentAtText }}」');
  assert.ok(
    bubbleSrc.includes("message.role === 'user' && sentAtText"),
    'caption 应以 message.role === \'user\' && sentAtText 门控',
  );
  assert.ok(
    /v-if="message\.role === 'user' && sentAtText" class="bubble-caption"/.test(bubbleSrc),
    'caption 应挂 bubble-caption 类（气泡下方独立行，非气泡内脚注）',
  );
  // 负向断言：user 气泡内部不再渲染「你」角色头与「发送于」脚注（防双时间戳/双「你」回退）。
  // 契约同步（2026-11-19 UI 五点批次 P5 挂载点 A，MessageBubble.vue 同名注释申报）：.bubble__role
  // 包进 .bubble__role-row flex 行（role 文本右侧挂 TranslationChrome swap pill）——角色头元素
  // div→div.bubble__role-row+span.bubble__role 形态变化，本钉同步锚 role-row 行；「排除 user」
  // 语义不变（v-if 原样保留 message.role !== 'user'），另补角色头元素 span 形态在位钉。
  const roleMatch = bubbleSrc.match(/<div v-if="([^"]+)" class="bubble__role-row">/);
  assert.ok(
    roleMatch !== null && roleMatch[1].includes("message.role !== 'user'"),
    '.bubble__role 角色头必须排除 user（user 气泡内不再渲染「你」角色头）',
  );
  assert.ok(bubbleSrc.includes('<span class="bubble__role">'), '.bubble__role 角色头元素（span）应仍在 role-row 行内');
  assert.ok(
    !bubbleSrc.includes('<span>发送于 {{ sentAtText }}</span>'),
    '气泡内「发送于 {{ sentAtText }}」脚注应已删除（时间戳只在气泡下方 caption 行）',
  );
  assert.ok(
    !/v-if="message\.role === 'user' && sentAtText" class="bubble__meta"/.test(bubbleSrc),
    '旧「user 门控 + bubble__meta」脚注块应已删除',
  );
});

console.log('\n=== P3-T5~T7 · caption 对齐②样式钉（2026-11-21 批次 P3） ===');
check('P3-T5 caption 块在「你 · 发送于」之前存在时钟 svg（与②同形字面：viewBox 0 0 24 24 + circle cx=12 cy=12 r=9 + path M12 7v5l3.5 2，类 bubble-caption-clock）', () => {
  const capStart = bubbleSrc.indexOf('class="bubble-caption"');
  assert.ok(capStart >= 0, 'caption 行未实现');
  const capOpen = bubbleSrc.lastIndexOf('<div', capStart);
  const capEnd = bubbleSrc.indexOf('</div>', capStart);
  const capBlock = bubbleSrc.slice(capOpen, capEnd);
  const svgIdx = capBlock.indexOf('<svg');
  const textIdx = capBlock.indexOf('你 · 发送于');
  assert.ok(svgIdx >= 0 && textIdx > svgIdx, 'caption 缺时钟 svg 或 svg 不在「你 · 发送于」之前');
  assert.ok(capBlock.includes('class="bubble-caption-clock"'), 'caption svg 缺 bubble-caption-clock 类');
  assert.ok(capBlock.includes('viewBox="0 0 24 24"'), 'caption svg viewBox 漂移（应 0 0 24 24）');
  assert.ok(capBlock.includes('cx="12"') && capBlock.includes('cy="12"') && capBlock.includes('r="9"'), 'caption svg circle 同形缺失（cx=12 cy=12 r=9）');
  assert.ok(capBlock.includes('M12 7v5l3.5 2'), 'caption svg path 同形缺失（M12 7v5l3.5 2）');
});
check('P3-T6 .bubble-caption 与 .bubble__meta 视觉同系：font-size/color/font-variant-numeric 同值或同 token', () => {
  const styleStart = bubbleSrc.indexOf('<style scoped>');
  const style = bubbleSrc.slice(styleStart);
  const capMatch = style.match(/\.bubble-caption\s*\{([^}]*)\}/);
  const metaMatch = style.match(/\.bubble__meta\s*\{([^}]*)\}/);
  assert.ok(capMatch, '缺 .bubble-caption 规则块');
  assert.ok(metaMatch, '缺 .bubble__meta 规则块');
  for (const prop of ['font-size', 'color', 'font-variant-numeric']) {
    const re = new RegExp(`${prop}:\\s*([^;]+);`);
    const capVal = (capMatch[1].match(re) || [])[1]?.trim();
    const metaVal = (metaMatch[1].match(re) || [])[1]?.trim();
    assert.ok(
      capVal != null && metaVal != null && capVal === metaVal,
      `.bubble-caption 与 .bubble__meta 的 ${prop} 不同值（caption=${capVal ?? '缺失'} vs meta=${metaVal ?? '缺失'}）`,
    );
  }
});
check('P3-T7 caption 文案仍「你 · 发送于 {{ sentAtText }}」单源无旁路格式化', () => {
  assert.ok(bubbleSrc.includes('你 · 发送于 {{ sentAtText }}'), 'caption 文案漂移（应「你 · 发送于 {{ sentAtText }}」）');
  assert.ok(
    /sentAtText = computed\(\(\) =>\s*props\.message\.role === 'user' \? formatSentAt\(props\.message\.createdAt\) : ''/.test(bubbleSrc),
    'sentAtText 非单源直读 createdAt（旁路格式化面）',
  );
});

console.log('\n=== F1–F5 · formatSentAt 纯函数用例 ===');

check('F1 空串/null/undefined/非法串 → 空串（不抛错，诚实不造数）', () => {
  assert.equal(formatSentAt(''), '');
  assert.equal(formatSentAt(null), '');
  assert.equal(formatSentAt(undefined), '');
  assert.equal(formatSentAt('not-a-date'), '');
});
check('F2 当天 → HH:mm:ss（三段两位补零；P3 升秒级，含秒位补零 07 形态）', () => {
  assert.equal(formatSentAt(todayAt(9, 5).toISOString()), '09:05:00');
  assert.equal(formatSentAt(todayAt(14, 32).toISOString()), '14:32:00');
  // 秒位补零钉：秒数 <10 补零（07 而非 7）。
  assert.equal(formatSentAt(todayAt(14, 5, 7).toISOString()), '14:05:07');
});
check('F3 跨天 → M/d HH:mm:ss（月日不补零、时分秒三段补零）', () => {
  const y = yesterdayAt(9, 5, 3);
  const expected = `${y.getMonth() + 1}/${y.getDate()} 09:05:03`;
  assert.equal(formatSentAt(y.toISOString()), expected);
});
check('F4 带 Z 的 UTC ISO（DB normalizeDbTime 形态）→ 本地化显示正确', () => {
  // 本地时刻经 toISOString()（必带 Z、毫秒级）往返，本地化回读应还原同一 HH:mm:ss
  const t = todayAt(14, 5);
  assert.equal(formatSentAt(t.toISOString()), '14:05:00');
  // 秒级 DB 形态（YYYY-MM-DDTHH:MM:SSZ）同刻可解析；同一天则显示秒级 HH:mm:ss
  const z = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}T09:05:03Z`;
  const parsed = new Date(z);
  const localSameDay = parsed.toDateString() === new Date().toDateString();
  const expected = localSameDay
    ? `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}:${String(parsed.getSeconds()).padStart(2, '0')}`
    : `${parsed.getMonth() + 1}/${parsed.getDate()} ${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}:${String(parsed.getSeconds()).padStart(2, '0')}`;
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
