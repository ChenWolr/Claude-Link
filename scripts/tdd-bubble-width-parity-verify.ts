// tdd-bubble-width-parity-verify.ts
// 2026-11-19 UI 五点批次 P3「用户消息行宽对齐 85%」源码契约脚本。
// 对应 docs/plans/2026-11-19-ui-five-points-batch/02-测试用例清单.md P3 组（T1/T4 的 node 源级形态；
//   T2/T3/T5/T6 的 CDP 形态归 test:cdp:layout 链后续收尾点，不在本脚本）：
//   P3-T1 正常向：.bubble--user 与 .bubble--assistant 的 max-width 声明值字面一致（均 85%）；
//                基类 .bubble 75% 与 system/tool 90% 不在本契约——断言其未被本点改动波及（仍在原值）。
//   P3-T4 回归钉：气泡内其它视觉属性不变（契约第 3 条）——user 的 padding（继承自 .bubble 基座
//                `padding: 12px 16px`）、右色条 `border-right: 3px solid var(--color-accent)`、
//                assistant 左色条 `border-left: 3px solid var(--color-accent)`、
//                `border-radius: var(--radius-md)` 及 user/assistant 底色/描边/阴影既有声明逐字保留。
// RED 预期（未实现树）：T1-1/T1-3 红（user 仍 80% vs assistant 85%），退出码 1；
//   T1-2（assistant 本就 85%）、T1-4/T1-5（基座与 system/tool 未触碰）、T4 全卷（回归钉，实现前后均须绿）。
// 运行：npx tsx scripts/tdd-bubble-width-parity-verify.ts（登记 scripts/selftest-static-list.txt 尾部）。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';

const repoRoot = path.resolve(__dirname, '..');
const bubbleSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/components/chat/MessageBubble.vue'), 'utf8');

let pass = 0;
let fail = 0;
/** assert 回调风格用例：抛错即 FAIL，消息首行进失败行（tdd-sidebar-card-outline-verify 同款）。 */
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.split('\n')[0]}`); }
}

/** 从锚点下标起切配平的 {…} 块（tdd-sidebar-card-outline-verify sliceBalanced 同口径）。 */
function blockFrom(src: string, startIdx: number): string {
  const open = src.indexOf('{', startIdx);
  assert.ok(open > -1, '锚点后未找到 { ');
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  assert.fail('样式块花括号不配平');
}

/** 选择器字面 → 配平样式块（首个匹配；本契约的 --user/--assistant 选择器在样式段各自唯一）。 */
function ruleBlock(src: string, selector: string): string {
  const idx = src.indexOf(selector);
  assert.ok(idx > -1, `样式源中未找到选择器字面 ${selector}`);
  return blockFrom(src, idx);
}

/** .bubble 基座块（顶层有两个 .bubble { 块：:221 基座 / :432 复制按钮定位块）——以含 max-width 声明辨认。 */
function baseBubbleBlock(src: string): string {
  let from = 0;
  for (;;) {
    const idx = src.indexOf('.bubble {', from);
    if (idx === -1) assert.fail('未找到含 max-width 的 .bubble 基座块');
    const block = blockFrom(src, idx);
    if (block.includes('max-width')) return block;
    from = idx + 1;
  }
}

/** 块内 max-width 声明值（如 `85%`）。 */
function maxWidthValue(block: string): string {
  const m = block.match(/max-width:\s*([^\s;]+);/);
  assert.ok(m, '块内未找到 max-width 声明');
  return m[1];
}

const userBlock = ruleBlock(bubbleSrc, '.bubble--user {');
const assistantBlock = ruleBlock(bubbleSrc, '.bubble--assistant {');
const systemBlock = ruleBlock(bubbleSrc, '.bubble--system {');
const toolBlock = ruleBlock(bubbleSrc, '.bubble--tool {');
const baseBlock = baseBubbleBlock(bubbleSrc);

console.log('=== P3-T1 · user/assistant max-width 字面一致（85%） ===');
check('T1-1 .bubble--user max-width == 85%（P3 实现点：80% → 85%）', () => {
  assert.equal(maxWidthValue(userBlock), '85%', '.bubble--user max-width 仍为旧口径（非 85%）');
});
check('T1-2 .bubble--assistant max-width == 85%（参照系锚点，本就 85%）', () => {
  assert.equal(maxWidthValue(assistantBlock), '85%', '.bubble--assistant max-width 参照锚点漂移');
});
check('T1-3 user 与 assistant max-width 声明值字面一致（折行点一致的核心契约）', () => {
  const u = maxWidthValue(userBlock);
  const a = maxWidthValue(assistantBlock);
  assert.equal(u, a, `user(${u}) 与 assistant(${a}) max-width 字面不一致，长消息折行点错位`);
});
check('T1-4 .bubble 基座 max-width 仍 75%（不在本契约、未被本点波及）', () => {
  assert.equal(maxWidthValue(baseBlock), '75%', '.bubble 基座 max-width 被本点改动波及');
});
check('T1-5 .bubble--system / .bubble--tool max-width 仍 90%（不在本契约、未被波及）', () => {
  assert.equal(maxWidthValue(systemBlock), '90%', '.bubble--system max-width 被波及');
  assert.equal(maxWidthValue(toolBlock), '90%', '.bubble--tool max-width 被波及');
});

console.log('\n=== P3-T4 · 气泡内其它视觉属性不变（回归钉，逐字面） ===');
check('T4-1 .bubble 基座 padding: 12px 16px 保留（user 气泡 padding 的继承来源）', () => {
  assert.ok(baseBlock.includes('padding: 12px 16px;'), '.bubble 基座 padding 声明被改');
});
check('T4-2 .bubble 基座 border-radius: var(--radius-md) 保留', () => {
  assert.ok(baseBlock.includes('border-radius: var(--radius-md);'), '.bubble 基座 border-radius 声明被改');
});
check('T4-3 .bubble--user 右色条 border-right: 3px solid var(--color-accent) 保留', () => {
  assert.ok(userBlock.includes('border-right: 3px solid var(--color-accent);'), 'user 右色条声明被改');
});
check('T4-4 .bubble--user 底色/描边/阴影既有声明逐字保留', () => {
  assert.ok(
    userBlock.includes('background: color-mix(in srgb, var(--color-accent) 12%, var(--color-panel-soft));'),
    'user 底色 color-mix 配方被改',
  );
  assert.ok(
    userBlock.includes('border: 1px solid color-mix(in srgb, var(--color-accent) 30%, transparent);'),
    'user 描边声明被改',
  );
  assert.ok(userBlock.includes('box-shadow: var(--ring-light), var(--elevation-1);'), 'user 阴影声明被改');
});
check('T4-5 .bubble--assistant padding: 12px 16px 保留', () => {
  assert.ok(assistantBlock.includes('padding: 12px 16px;'), 'assistant padding 声明被改');
});
check('T4-6 .bubble--assistant 左色条 border-left: 3px solid var(--color-accent) 保留', () => {
  assert.ok(assistantBlock.includes('border-left: 3px solid var(--color-accent);'), 'assistant 左色条声明被改');
});
check('T4-7 .bubble--assistant border-radius: var(--radius-md) 保留', () => {
  assert.ok(assistantBlock.includes('border-radius: var(--radius-md);'), 'assistant border-radius 声明被改');
});

console.log(`\n===== tdd-bubble-width-parity-verify: ${pass} pass / ${fail} fail =====`);
if (fail > 0) process.exit(1);
