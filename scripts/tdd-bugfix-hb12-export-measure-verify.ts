// scripts/tdd-bugfix-hb12-export-measure-verify.ts
// hb12 P1-1（EXP-01）契约：导出分页测量适配 .message-list__inner 包裹层 + 测量数量守卫。
//
// 病根（2026-09-12 审计）：0be1cdb（09-08，OPT-6 回底按钮修复）在 scroller 与消息项之间加了
// .message-list__inner 包裹（MessageList.vue，inner 是 scroller 唯一元素子节点），
// 而 export-runner.ts measureItemHeights 仍迭代 scroller.children → itemHeights 恒为
// [整文档高] 一项。后果链：①分页退化为「首条单独一页+其余全部一页」；②长会话第二页
// 超预算 → page-over-budget/png-over-budget 整单失败；③MAX_PAGES 与 hb10-P2-11 的
// oversize 预检全部失真。短会话（单页）无感掩盖回归。
//
// 修复：measureItemHeights 迭代下沉到 scroller.querySelector('.message-list__inner')?.children
// （保留 scroller 兜底）；迭代后加数量守卫——测量项数 ≠ items 数时返回 null，调用方走
// measurement-mismatch 快速失败（文案独立于 hb10-P2-11 的 item-over-budget，防混淆）。
//
// 本契约锁四件事：
// ① MessageList.vue 确有 .message-list__inner 包裹层（选择器前提）；
// ② measureItemHeights 迭代 .message-list__inner（不再裸迭代 scroller.children）；
// ③ 数量守卫（!== expectedCount → null）+ runExport 的 measurement-mismatch 失败出口；
// ④ 既有导出契约仍在 selftest:static 链中（不弱化）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb12-export-measure-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const exportRunner = read('src/renderer/export/export-runner.ts');
const messageList = read('src/renderer/components/chat/MessageList.vue');
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① 前提：MessageList.vue 确有 .message-list__inner 包裹层（scroller 的直接元素子节点）。
check('① MessageList.vue：.message-list__scroller 内含 .message-list__inner 包裹层', () => {
  const scrollerIdx = messageList.indexOf('class="message-list__scroller"');
  assert.ok(scrollerIdx > -1, '未找到 message-list__scroller 模板节点');
  const innerIdx = messageList.indexOf('class="message-list__inner"', scrollerIdx);
  assert.ok(innerIdx > -1, 'scroller 之后未找到 message-list__inner 包裹层（选择器前提失效）');
});

// ② measureItemHeights：迭代下沉到 .message-list__inner（带 scroller 兜底），不得裸迭代 scroller.children。
check('② measureItemHeights：querySelector(\'.message-list__inner\') 迭代 + 兜底；不含裸 scroller.children 直迭代', () => {
  const fnIdx = exportRunner.indexOf('function measureItemHeights');
  assert.ok(fnIdx > -1, '未找到 measureItemHeights');
  const fnEnd = exportRunner.indexOf('\n}', fnIdx);
  const body = exportRunner.slice(fnIdx, fnEnd > -1 ? fnEnd : undefined);
  assert.match(body, /querySelector\('\.message-list__inner'\)/, 'measureItemHeights 未下沉到 .message-list__inner 迭代');
  // 兜底形态：inner 取不到时回退 scroller 自身（?? 形态）。
  assert.match(body, /\?\?/, 'measureItemHeights 缺 inner 取不到时的兜底（?? scroller）');
  // 反断言：不得出现裸 scroller.children 直迭代（迭代目标必须是 inner 兜底后的容器变量）。
  assert.doesNotMatch(body, /scroller\.children\.length/, 'measureItemHeights 仍在裸迭代 scroller.children（OPT-6 回归未修）');
  assert.doesNotMatch(body, /scroller\.children\[i\]/, 'measureItemHeights 仍按下标裸取 scroller.children');
  // 迭代对象应为容器变量（container/inner 层），且期望数守卫位于函数体内。
  assert.match(body, /expectedCount/, 'measureItemHeights 缺期望数量参数（数量守卫前提）');
  assert.match(body, /!==\s*expectedCount/, 'measureItemHeights 缺测量数≠期望数守卫');
  assert.match(body, /return null/, '守卫命中未返回 null（应交由调用方走 measurement-mismatch 出口）');
});

// ③ runExport：measurement-mismatch 快速失败出口（code + 独立文案，区别于 item-over-budget）。
check('③ runExport：measurement-mismatch 失败出口（code + 「测量」文案 + 独立于 item-over-budget）', () => {
  assert.match(exportRunner, /code: 'measurement-mismatch'/, "runExport 缺 code: 'measurement-mismatch' 失败出口");
  assert.match(exportRunner, /导出测量失败：消息项数量与测量结果不一致/, '缺测量失配独立文案');
  const callIdx = exportRunner.indexOf('measureItemHeights(items.length)');
  assert.ok(callIdx > -1, 'runExport 未把 items.length 传入 measureItemHeights（守卫失效）');
  const mmIdx = exportRunner.indexOf("code: 'measurement-mismatch'");
  assert.ok(mmIdx > callIdx, 'measurement-mismatch 出口必须位于测量调用之后（同一调用链）');
  // hb13-v 批C 改钉：原断言「item-over-budget 不在 mmIdx 前 || mmIdx 在其后」两支同义恒真，
  // 只制造覆盖假象（两出口时序已由 snapshot-verify 覆盖）——改钉唯一性有效断言。
  assert.equal((exportRunner.match(/code: 'measurement-mismatch'/g) ?? []).length, 1, 'measurement-mismatch 出口应唯一');
});

// ④ 既有导出契约不弱化：p1-12-13 / export-image / export-image-codec 仍在 selftest 清单。
check('④ selftest 清单：既有导出契约脚本仍在（不弱化）', () => {
  // hb12 最小同步：链改 runner 清单执行（scripts/selftest-static-list.txt），入链断言改查清单。
  const chain = fs.readFileSync(path.join(repoRoot, 'scripts', 'selftest-static-list.txt'), 'utf8');
  assert.ok(chain, '未找到 selftest 清单');
  assert.ok(chain.includes('tdd-bugfix-p1-12-13-export-verify.ts'), '清单缺 tdd-bugfix-p1-12-13-export-verify');
  assert.ok(chain.includes('export-image-verify.ts'), '清单缺 export-image-verify');
  assert.ok(chain.includes('export-image-codec-verify.ts'), '清单缺 export-image-codec-verify');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
