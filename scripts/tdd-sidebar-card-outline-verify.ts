// tdd-sidebar-card-outline-verify.ts
// 2026-11-19 UI 五点批次 P2「会话卡片轮廓可见但浅」源码契约脚本（03 §3 R1 裁决 panelSoft 方案）。
// 对应 docs/plans/2026-11-19-ui-five-points-batch/02-测试用例清单.md P2 组（T3 以 03 §3 R2 修正后的语义钉口径执行）：
//   P2-T1 正常向：.session-card 基座描边不再是 transparent——`border: 1px solid var(--color-border)`；
//                底色声明为 `var(--color-panel-soft)`（R1 panelSoft 方案）；描边仍为 1px 宽度（几何零变化）。
//   P2-T3 回归钉：
//     ① hover 底色微调规则语义保留（R2 修正口径：由「逐字面」改「语义」）——text 4% 混色配方在、
//        混色底与基座底同家族（同为 panel-soft 系）、hover 规则不改描边；
//     ② .session-card.active 的 accent 45% 描边 + accent 8% 底逐字面保留（active 钉仍逐字面）。
//   P2-T6 回归门：内联 spawn 两既有侧栏契约脚本（tdd-sidebar-card-pin-verify.ts 含 T3-I2 零硬编码钉——
//     新描边色走 token 即绿 / tdd-sidebar-structure-verify.ts），退出码均 0。
// RED 预期（未实现树）：T1-1/T1-2/T3-1 红（border transparent / bg panel / hover 混色底仍 panel），
//   退出码 1；T1-3（1px 本就在）、T3-2（hover 本不改描边）、T3-3（active 未触碰）、T6 两 spawn 门现状绿
//   （回归钉，实现后仍须保持绿）。
// spawn 门稳态化沿用 5272e6e 先例：仅非零退出重跑（≤2 次重试）吸收 npx/tsx 冷启动抖动，
//   exit 0 唯一通过判定不变，真回归在重试耗尽后照常红。
// 运行：npx tsx scripts/tdd-sidebar-card-outline-verify.ts（登记 scripts/selftest-static-list.txt 尾部）。
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';

const repoRoot = path.resolve(__dirname, '..');
const sidebar = fs.readFileSync(path.join(repoRoot, 'src/renderer/components/layout/AppSidebar.vue'), 'utf8');

let pass = 0;
let fail = 0;
/** assert 回调风格用例：抛错即 FAIL，消息首行进失败行（tdd-mcp-manual-scan-verify 同款）。 */
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.split('\n')[0]}`); }
}

/** 从锚点下标起切配平的 {…} 块（tdd-sidebar-card-pin-verify sliceBalanced 同口径）。 */
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

/** 选择器字面 → 配平样式块。 */
function ruleBlock(src: string, selector: string): string {
  const idx = src.indexOf(selector);
  assert.ok(idx > -1, `样式源中未找到选择器字面 ${selector}`);
  return blockFrom(src, idx);
}

/** .session-card 基座块（顶层有两个 .session-card { 块：入场动画块 / 基座块）——以含 background 声明辨认。 */
function baseCardBlock(src: string): string {
  let from = 0;
  for (;;) {
    const idx = src.indexOf('.session-card {', from);
    assert.ok(idx > -1, '未找到含 background 声明的 .session-card 基座块');
    const block = blockFrom(src, idx);
    if (/\bbackground\s*:/.test(block)) return block;
    from = idx + 1;
  }
}

const base = baseCardBlock(sidebar);

console.log('\n=== P2-T1 · 基座描边与底色（R1 panelSoft 方案） ===');

check('T1-1 描边声明不再是 transparent：border: 1px solid var(--color-border)', () => {
  assert.match(base, /border:\s*1px solid var\(--color-border\);/, '基座描边未换成 var(--color-border)');
  assert.doesNotMatch(base, /border:[^;]*transparent/, '描边不得回退 transparent（本点主缺陷原样）');
});
check('T1-2 底色声明为 var(--color-panel-soft)（R1：panelSoft 方案，对齐全应用卡片语言）', () => {
  assert.match(base, /background:\s*var\(--color-panel-soft\);/, '基座底未换成 var(--color-panel-soft)');
});
check('T1-3 描边仍为 1px 宽度（1px 占位原本就在，几何零变化）', () => {
  assert.match(base, /border:\s*1px\b/, '描边宽度不是 1px（加宽/补偿会引发卡片列表跳动）');
});

console.log('\n=== P2-T3 · 回归钉（R2 修正后的语义钉口径） ===');

check('T3-1 hover 底色微调规则语义保留：text 4% 混色配方在、混色底与基座底同家族（同为 panel-soft 系）', () => {
  const hover = ruleBlock(sidebar, '.session-card:hover {');
  const m = /background:\s*color-mix\(in srgb,\s*var\(--color-text\)\s*4%,\s*(.+?)\)\s*;/.exec(hover);
  assert.ok(m, 'hover 规则缺 text 4% 混色底色微调配方（悬停反馈行为丢失）');
  const baseBg = /background:\s*([^;]+);/.exec(base);
  assert.ok(baseBg, '基座块缺 background 声明');
  assert.equal(baseBg[1].trim(), 'var(--color-panel-soft)', '基座底应为 panel-soft（R1），实际 ' + baseBg[1].trim());
  assert.equal(m[1].trim(), 'var(--color-panel-soft)', 'hover 混色底应与基座底同家族（同为 panel-soft 系），实际 ' + m[1].trim());
});
check('T3-2 hover 规则不改描边（描边仍由基座声明承担）', () => {
  const hover = ruleBlock(sidebar, '.session-card:hover {');
  assert.doesNotMatch(hover, /border/, 'hover 规则不得改描边');
});
check('T3-3 .session-card.active accent 45% 描边 + accent 8% 底逐字面保留', () => {
  const active = ruleBlock(sidebar, '.session-card.active {');
  assert.ok(
    active.includes('background: color-mix(in srgb, var(--color-accent) 8%, var(--color-panel-soft));'),
    'active 底色 accent 8% 混色逐字面钉失效',
  );
  assert.ok(
    active.includes('border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);'),
    'active 描边 accent 45% 混色逐字面钉失效',
  );
});

console.log('\n=== P2-T6 · 既有侧栏契约链内联回归门（spawn） ===');

/** spawn 门稳态化（5272e6e 先例同款）：仅非零退出重跑 ≤2 次，exit 0 唯一通过判定不变。 */
function spawnGateWithRetry(args: string[]): { status: number | null; error?: Error; tail: string } {
  let lastStatus: number | null = null;
  let lastError: Error | undefined;
  let lastTail = '';
  for (let run = 1; run <= 3; run++) {
    const r = spawnSync('npx', args, { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
    lastStatus = r.status;
    lastError = r.error ?? undefined;
    lastTail = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-300).trim();
    if (r.status === 0) {
      if (run > 1) console.log(`  ⚠️ ${args[1]} 第 ${run} 次运行通过（前 ${run - 1} 次瞬态失败已吸收）`);
      return { status: lastStatus, error: lastError, tail: lastTail };
    }
  }
  return { status: lastStatus, error: lastError, tail: lastTail };
}

{
  const g = spawnGateWithRetry(['tsx', 'scripts/tdd-sidebar-card-pin-verify.ts']);
  check('T6-1 tdd-sidebar-card-pin-verify.ts exit 0（UI13-P3 卡片契约全卷；T3-I2 零硬编码钉自动覆盖新描边色——走 token 即绿；冷启动瞬态重试 ≤2 次）', () => {
    assert.equal(g.status, 0, `退出码 ${g.status}${g.error ? ` err=${String(g.error)}` : ''}\n${g.tail}`);
  });
}
{
  const g = spawnGateWithRetry(['tsx', 'scripts/tdd-sidebar-structure-verify.ts']);
  check('T6-2 tdd-sidebar-structure-verify.ts exit 0（侧栏结构契约不被轮廓改动破坏；冷启动瞬态重试 ≤2 次）', () => {
    assert.equal(g.status, 0, `退出码 ${g.status}${g.error ? ` err=${String(g.error)}` : ''}\n${g.tail}`);
  });
}

console.log(`\n===== tdd-sidebar-card-outline-verify: ${pass} pass / ${fail} fail =====`);
if (fail > 0) process.exit(1);
