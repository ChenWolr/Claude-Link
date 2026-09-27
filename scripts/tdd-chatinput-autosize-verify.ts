// tdd-chatinput-autosize-verify.ts
// 问题①（2026-09-27 六使用问题）输入框两行即出滚动条 TDD 验证脚本，全部为 ChatInput.vue 源码契约：
//   C1–C6  autoResize 边框补偿表达式 + max-height 精确封顶字面 + 注释算式同步 + 既有契约保活。
// 根因：全局 border-box（main.css `* { box-sizing: border-box }`）下 scrollHeight 不含上下
// 边框（各 1px），直接回填则 clientHeight 恒差 2px → 1~2 行即出竖向滚动条；旧 max-height:
// 104px 又漏算 2px 边框，medium/large 字号档实际只容 3 整行。
// 运行：npx tsx scripts/tdd-chatinput-autosize-verify.ts（已登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '../src/renderer/components/chat/ChatInput.vue'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

// autoResize 函数体（函数名起至配对收口的近似窗口）
const fnBody = src.match(/function autoResize\(\): void \{[\s\S]*?\n\}/)?.[0] ?? '';
// textarea 样式规则块（注释含在块内，注释不含 } 不会截断）
const textareaRule = src.match(/textarea \{[^}]*\}/)?.[0] ?? '';

console.log('\n=== 问题① · ChatInput 自适应高度边框补偿契约 ===');

check('C1 autoResize 先置 auto 再读 scrollHeight（既有行为保活）', () => {
  assert.ok(fnBody, '未找到 autoResize 函数体');
  assert.ok(fnBody.includes("el.style.height = 'auto'"), `函数体缺 'auto' 置位：${fnBody}`);
  assert.ok(fnBody.includes('el.scrollHeight'), `函数体未读 scrollHeight：${fnBody}`);
});

check('C2 边框补偿：getComputedStyle 读上下边框宽（vertBorder）', () => {
  assert.ok(fnBody.includes('window.getComputedStyle(el)'), '未取 computed style');
  assert.ok(fnBody.includes('cs.borderTopWidth') && fnBody.includes('cs.borderBottomWidth'), '未补偿上下边框（borderTopWidth/borderBottomWidth）');
  assert.ok(fnBody.includes('parseFloat('), '边框宽度未 parseFloat');
});

check('C3 回填高度 = scrollHeight + vertBorder + 1（+1 覆盖小数行高 18.375/23.625px 的取整误差）', () => {
  assert.ok(
    /el\.style\.height = `\$\{el\.scrollHeight \+ vertBorder \+ 1\}px`/.test(fnBody),
    `回填表达式不符预期：${fnBody}`,
  );
});

check('C4 max-height 按 border-box 精确封顶 4 整行：calc(0.875rem * 1.5 * 4 + 22px)', () => {
  assert.ok(src.includes('max-height: calc(0.875rem * 1.5 * 4 + 22px)'), 'textarea 规则缺精确 4 行 max-height');
  assert.ok(!src.includes('max-height: 104px'), '旧 max-height: 104px 残留（漏 2px 边框）');
});

check('C5 注释算式同步：说明 border-box 含边框与 22px 收尾', () => {
  assert.ok(textareaRule, '未找到 textarea 样式规则块');
  assert.ok(textareaRule.includes('border-box'), 'max-height 注释未说明 border-box 含边框');
  assert.ok(textareaRule.includes('22px'), 'max-height 注释未写 22px 收尾算式');
});

check('C6 既有契约保活：min-height: 42px 与 overflow-y: auto 不动', () => {
  assert.ok(textareaRule.includes('min-height: 42px'), 'min-height: 42px 被动');
  assert.ok(textareaRule.includes('overflow-y: auto'), 'overflow-y: auto 被动');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
