// tdd-bubble-meta-clock-format-verify.ts
// P4「气泡脚注② 恒时钟格式」（2026-11-21 批次）契约脚本。
// ②气泡脚注与中断/失败脚注的耗时数字恒为时钟格式 m:ss（<60s 补零 0:07）、≥1h H:MM:SS（2:05:03），
// 秒数向下取整，不再出现 6.8s 小数秒形态；④TurnTimer 与工具行耗时维持 formatDurationMs 口径不动。
// TDD 验证脚本：
//   P4-T1~T5  formatDurationClock 纯函数行为——m:ss 补零/分秒/小时档/floor 截断不进位/非有限与
//             非正数兜底 0:00（不抛错）。
//   P4-T6     静态钉 MessageBubble.vue ②块：②块内/其 computed 无 formatDurationMs 消费 +
//             存在 formatDurationClock 消费（双向钉）。
//   P4-T7     静态钉 MessageList.vue interrupted/error 分支：耗时数字与②同一时钟格式入口
//             （formatDurationClock）+ 无耗时降级半句保留；组合回读 7000ms →「已中断 · 运行 0:07」。
//   P4-T8     静态钉 TurnTimer.vue：④完成态耗时仍消费 formatDurationMs；formatDurationMs 本体
//             行为零变化（fd(3700)==='3.7s' 等——hb10 ⑩ 同源钉）。
//   P4-T9     静态钉 ToolCallBlock.vue：工具行内联耗时格式化字面零变化。
//   P4-T10    静态钉 MessageBubble.vue 样式区：bubble__meta-duration（weight 600 + 前景色）与
//             bubble__meta-end（opacity 0.8）类分工声明保持。
//   P4-T12    静态钉 MessageBubble.vue：formatEndedAt 单源消费与「结束于」文案字面不变。
//   spawn 门：tdd-bugfix-b3-turn-endtime-bubble-verify.ts + tdd-bugfix-hb10-engine-turnmeta-p3-verify.ts
//             两脚本退出码 0（均不改动）。
// 运行：npx tsx scripts/tdd-bubble-meta-clock-format-verify.ts（已登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatDurationClock, formatDurationMs } from '../src/shared/format-duration';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${repoRoot}/${rel}`, 'utf8');

const bubbleSrc = read('src/renderer/components/chat/MessageBubble.vue');
const messageList = read('src/renderer/components/chat/MessageList.vue');
const turnTimer = read('src/renderer/components/chat/TurnTimer.vue');
const toolCallBlock = read('src/renderer/components/chat/ToolCallBlock.vue');
const fdSrc = read('src/shared/format-duration.ts');
const selftestList = read('scripts/selftest-static-list.txt');

console.log('\n=== P4-T1~T5 · formatDurationClock 纯函数行为 ===');

check('P4-T1 短回复补零：formatDurationClock(7000) === "0:07"', () => {
  assert.equal(formatDurationClock(7000), '0:07');
});
check('P4-T2 分钟档：formatDurationClock(482000) === "8:02"', () => {
  assert.equal(formatDurationClock(482000), '8:02');
});
check('P4-T3 小时档：formatDurationClock(7503000) === "2:05:03"；formatDurationClock(3600000) === "1:00:00"', () => {
  assert.equal(formatDurationClock(7503000), '2:05:03');
  assert.equal(formatDurationClock(3600000), '1:00:00');
});
check('P4-T4 floor 截断不进位：6800→"0:06"、59900→"0:59"、60000→"1:00"', () => {
  assert.equal(formatDurationClock(6800), '0:06');
  assert.equal(formatDurationClock(59900), '0:59');
  assert.equal(formatDurationClock(60000), '1:00');
});
check('P4-T5 非有限/非正数兜底 0:00（不抛错）：0/-5/NaN/Infinity → "0:00"', () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(formatDurationClock(bad), '0:00', `formatDurationClock(${String(bad)}) 底`);
  }
});

console.log('\n=== P4-T6/T7 · ②气泡脚注与中断/失败脚注入口（双向钉） ===');

check('P4-T6 MessageBubble.vue ②块：durationText computed 无 formatDurationMs 消费 + formatDurationClock 消费在场（双向钉）', () => {
  // ②入口 = durationText computed（本次回复耗时文案，bubble__meta-duration 唯一数据源）。
  const computedStart = bubbleSrc.indexOf('const durationText = computed');
  assert.ok(computedStart >= 0, 'MessageBubble 缺 durationText computed');
  const computedEnd = bubbleSrc.indexOf(');', computedStart);
  const body = bubbleSrc.slice(computedStart, computedEnd);
  assert.ok(body.includes('formatDurationClock'), '②块 computed 缺 formatDurationClock 消费（时钟格式入口未接）');
  assert.ok(!body.includes('formatDurationMs'), '②块 computed 仍消费 formatDurationMs（小数秒形态残留面）');
  // import 行同步：MessageBubble 的 format-duration import 行含 formatDurationClock。
  const importLine = bubbleSrc.split(/\r?\n/).find((l) => l.includes("from '../../../shared/format-duration'"));
  assert.ok(importLine && importLine.includes('formatDurationClock'), 'MessageBubble import 行缺 formatDurationClock');
});

check('P4-T7 MessageList.vue interrupted/error 分支：耗时与②同一时钟格式入口 + 无耗时降级半句保留；7000ms →「已中断 · 运行 0:07」', () => {
  const computedStart = messageList.indexOf('const turnFootnote');
  const computedEnd = messageList.indexOf('\n});', computedStart);
  const body = messageList.slice(computedStart, computedEnd);
  assert.ok(body.includes('formatDurationClock'), 'MessageList turnFootnote 分支缺 formatDurationClock（与②不同源=格式分叉）');
  assert.ok(body.includes("'已中断'") && body.includes("'失败'"), '无耗时降级半句「已中断/失败」缺失');
  // 组合回读（与②同一入口的文案形态）：7000ms → 已中断 · 运行 0:07。
  const dur = formatDurationClock(7000);
  assert.equal(`已中断 · 运行 ${dur}`, '已中断 · 运行 0:07', '中断脚注组合文案漂移');
  // MessageList 的 turnFootnote 分支不再有 formatDurationMs 消费（P2 后 interrupted/error 是唯一耗时消费点）。
  assert.ok(!body.includes('formatDurationMs'), 'turnFootnote 分支仍消费 formatDurationMs（小数秒形态残留面）');
});

console.log('\n=== P4-T8/T9 · 不改面回归钉（④TurnTimer + 工具行耗时） ===');

check('P4-T8 TurnTimer.vue ④完成态仍消费 formatDurationMs + formatDurationMs 本体行为零变化（hb10 ⑩ 同源）', () => {
  assert.ok(turnTimer.includes('{{ formatDurationMs(elapsedMs) }}'), 'TurnTimer 运行中展示格式被牵动');
  assert.ok(turnTimer.includes('{{ formatDurationMs(lastMeta.durationMs) }}'), 'TurnTimer 完成态展示格式被牵动');
  // 本体行为钉（regression-tests 75-83 同源）：不得被新函数挤占/改动。
  assert.equal(formatDurationMs(3700), '3.7s', '<60s 一位小数秒漂移（hb10 ⑩）');
  assert.equal(formatDurationMs(0), '0.0s', '0 兜底漂移');
  assert.equal(formatDurationMs(60000), '1:00', '60s 分:秒漂移');
  assert.equal(formatDurationMs(83000), '1:23', '分:秒漂移');
  assert.equal(formatDurationMs(3600000), '1:00:00', '小时档漂移');
  // 本体函数体在位（export function formatDurationMs( 未被改名/移除）。
  assert.ok(fdSrc.includes('export function formatDurationMs('), 'formatDurationMs 导出丢失');
});

check('P4-T9 ToolCallBlock.vue 工具行内联耗时格式化字面零变化', () => {
  assert.ok(toolCallBlock.includes('⏱{{ elapsedSeconds.toFixed(1) }}s'), '工具行运行中耗时字面被牵动');
  assert.ok(toolCallBlock.includes('{{ (metaMsg.durationMs / 1000).toFixed(1) }}s'), '工具行 meta 秒级耗时字面被牵动');
});

console.log('\n=== P4-T10/T12 · ②样式分工与 formatEndedAt 单源回归钉 ===');

check('P4-T10 MessageBubble.vue 样式区：bubble__meta-duration（weight 600 + 前景色）与 bubble__meta-end（opacity 0.8）分工声明保持', () => {
  const styleStart = bubbleSrc.indexOf('<style scoped>');
  const style = bubbleSrc.slice(styleStart);
  const durMatch = style.match(/\.bubble__meta-duration\s*\{([^}]*)\}/);
  assert.ok(durMatch, '缺 .bubble__meta-duration 规则块');
  assert.ok(durMatch[1].includes('font-weight: 600'), '.bubble__meta-duration 缺 font-weight: 600');
  assert.ok(durMatch[1].includes('var(--color-text)'), '.bubble__meta-duration 缺前景色 var(--color-text)');
  const endMatch = style.match(/\.bubble__meta-end\s*\{([^}]*)\}/);
  assert.ok(endMatch, '缺 .bubble__meta-end 规则块');
  assert.ok(endMatch[1].includes('opacity: 0.8'), '.bubble__meta-end 缺 opacity: 0.8');
});

check('P4-T12 MessageBubble.vue formatEndedAt 单源消费与「结束于」文案字面不变', () => {
  assert.ok(bubbleSrc.includes('formatEndedAt(props.message.endedAt)'), 'endedAtText 缺 formatEndedAt 单源调用');
  assert.ok(bubbleSrc.includes('· 结束于 {{ endedAtText }}'), '「· 结束于 {{ endedAtText }}」文案字面丢失');
});

check('selftest 清单登记：selftest-static-list.txt 含本脚本', () => {
  assert.ok(
    selftestList.split(/\r?\n/).map((l) => l.trim()).includes('scripts/tdd-bubble-meta-clock-format-verify.ts'),
    'selftest-static-list.txt 未登记 scripts/tdd-bubble-meta-clock-format-verify.ts',
  );
});

console.log('\n=== spawn 门（双脚本退出码 0，均不改动） ===');
const spawnGate = (script: string, name: string) => check(name, () => {
  const r = spawnSync('npx', ['tsx', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-6).join('\n');
  assert.equal(r.status, 0, `${script} 退出码 ${r.status}（②/④ 呈现层回归门被波及）\n${tail}`);
});
void spawnGate('scripts/tdd-bugfix-b3-turn-endtime-bubble-verify.ts', 'spawn tdd-bugfix-b3-turn-endtime-bubble-verify.ts 退出码 0（endedAt 链+气泡脚注钉）');
void spawnGate('scripts/tdd-bugfix-hb10-engine-turnmeta-p3-verify.ts', 'spawn tdd-bugfix-hb10-engine-turnmeta-p3-verify.ts 退出码 0（fd(3700)=3.7s 本体钉）');

const summary = `\n结果：${pass} 通过 / ${fail} 失败`;
console.log(summary);
process.exit(fail === 0 ? 0 : 1);
