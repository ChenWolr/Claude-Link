// tdd-export-mermaid-settle-verify.ts
// X8（R05-F2，P2）契约钉：导出 waitStable 稳定判定必须等待 mermaid 异步渲染 settle。
//
// 根因（复核 CONFIRMED）：export profile 渲染 mermaid（markdown.ts:96-98），v-enrich 的
// mermaid 渲染是异步两段式（enrich-markdown.ts:109-125 动态 import('mermaid') 首次需加载
// code-split chunk + :209-230 模块级串行队列逐块 render），而 waitStable 只等
// fonts.ready + document.images + 8×两帧高度稳定——mermaid SVG 非 document.images 成员、
// chunk 在途期间高度不变，两帧稳定即提前返回 → 截到 .mermaid-block__source 源码回退态
// （markdown.ts:240-249），或 measureItemHeights 按渲染前高度分页、后渲染撑高裁断页尾。
//
// 修复语义：稳定循环每轮检查 pending mermaid 块——
//   document.querySelectorAll('.mermaid-block:not([data-mermaid-state="rendered"]):not([data-mermaid-state="error"])')
// 存在 pending（含无 data-mermaid-state 属性的新占位块、loading 态块）时视为未稳定、
// 不提前返回，继续迭代；沿用既有 8 次迭代上限防死等（渲染失败落 error 终态后不再阻塞
// 导出）。无图会话选择器恒空 → 零行为变化。
//
// 运行：npx tsx scripts/tdd-export-mermaid-settle-verify.ts（已登记 scripts/selftest-static-list.txt）

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const exportRunner = read('../src/renderer/export/export-runner.ts');
const enrichMarkdown = read('../src/renderer/directives/enrich-markdown.ts');
const markdown = read('../src/renderer/utils/markdown.ts');
const selftestList = read('selftest-static-list.txt');

// 提取 ts 文件内指定函数体（顶格 } 结束，内层块均带缩进——与既有代码形态匹配）。
function extractFnBody(src: string, fnName: string): string {
  const m = src.match(new RegExp(`function ${fnName}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `未找到函数 ${fnName}()`);
  return m[1];
}

// 提取 waitStable 内的稳定迭代 for 循环体（8 次上限循环；循环闭括号带两格缩进）。
function extractStableLoop(waitStableBody: string): string {
  const m = waitStableBody.match(/for \(let i = 0; i < \d+; i\+\+\) \{([\s\S]*?)\n  \}/);
  assert.ok(m, '未找到稳定迭代 for 循环');
  return m[1];
}

console.log('\n=== X8-① 修复前提：mermaid 完成态属性名与取值（以 enrich-markdown 实际为准） ===');
check('enrich-markdown 写入的终态取值恰为 rendered / error（选择器排除集与实现一致）', () => {
  assert.ok(
    (enrichMarkdown.match(/setAttribute\('data-mermaid-state', 'rendered'\)/g) || []).length > 0,
    "enrich-markdown 缺 data-mermaid-state='rendered' 写入（选择器排除集漂移，需同步选择器）",
  );
  assert.ok(
    (enrichMarkdown.match(/setAttribute\('data-mermaid-state', 'error'\)/g) || []).length > 0,
    "enrich-markdown 缺 data-mermaid-state='error' 写入（选择器排除集漂移，需同步选择器）",
  );
  // dataset 与 setAttribute 双写之外不得有其它取值（出现新终态须同步导出侧选择器）。
  const states = new Set(enrichMarkdown.match(/data-mermaid-state', '([a-z]+)'/g) ?? []);
  for (const s of states) {
    const v = s.slice("data-mermaid-state', '".length, -1);
    assert.ok(
      v === 'rendered' || v === 'loading' || v === 'error',
      `data-mermaid-state 出现未知取值 '${v}'（若为新终态需同步导出侧选择器）`,
    );
  }
});
check('markdown.ts 占位块初始不携带 data-mermaid-state（新块落入 pending 选择器，不漏等）', () => {
  const m = markdown.match(/function renderMermaidBlock\(code: string\): string \{([\s\S]*?)\n\}/);
  assert.ok(m, '未找到 renderMermaidBlock()（占位容器形态漂移）');
  assert.ok(!m[1].includes('data-mermaid-state'), '占位块自带 data-mermaid-state——若初值非 rendered/error 则仍 pending（本断言需随之复核）');
});

console.log('\n=== X8-② waitStable 稳定循环含 mermaid settle 条件 ===');
const waitStable = extractFnBody(exportRunner, 'waitStable');
const PENDING_SELECTOR = '.mermaid-block:not([data-mermaid-state="rendered"]):not([data-mermaid-state="error"])';
check('waitStable 含 pending 选择器查询（.mermaid-block 非 rendered 非 error）', () => {
  assert.ok(
    waitStable.includes(PENDING_SELECTOR),
    'waitStable 缺 mermaid pending 选择器查询（R05-F2 根因未修：截到源码回退态/按旧高度切页）',
  );
  assert.ok(
    waitStable.includes('pendingMermaid'),
    'pending 计数变量缺失（settle 条件形态漂移）',
  );
});
check('settle 条件与高度稳定共同门控提前返回（pending>0 时不返回，继续迭代）', () => {
  const loop = extractStableLoop(waitStable);
  const ret = loop.match(/if \(([^)]*)\) return;/);
  assert.ok(ret, '稳定循环内缺提前 return（形态漂移）');
  assert.ok(
    ret[1].includes('h === prev'),
    '提前 return 不再依赖高度稳定判定（原有语义漂移）',
  );
  assert.ok(
    ret[1].includes('pendingMermaid === 0'),
    '提前 return 未门控 mermaid settle（pending 存在时仍会提前返回）',
  );
});
check('settle 查询位于迭代循环内（每轮复查，串行队列推进后可观察到 rendered）', () => {
  const loop = extractStableLoop(waitStable);
  assert.ok(
    loop.includes(PENDING_SELECTOR),
    'pending 查询不在稳定迭代循环内（只查一次观察不到异步渲染推进）',
  );
});

console.log('\n=== X8-③ 迭代上限兜底（防死等，渲染失败不阻塞导出） ===');
check('稳定循环保留 8 次迭代上限（pending 永不 settle 时仍按上限返回）', () => {
  assert.ok(
    /for \(let i = 0; i < 8; i\+\+\)/.test(waitStable),
    '8 次迭代上限漂移（防死等兜底缺失或被扩大/缩小，须与计划一致）',
  );
});
check('settle 条件不引入循环外的新增无界等待（无 while(true)/无上限 while）', () => {
  assert.ok(!waitStable.includes('while (true)'), 'waitStable 出现无界等待（违反防死等设计）');
});

console.log('\n=== X8-④ 相邻契约不回归：测量/分页消费点与 waitStable 调用形态 ===');
check('waitStable 仍在测量前（measureItemHeights）与每页捕获前被调用（消费时序不变）', () => {
  const stableIdx = exportRunner.indexOf('await waitStable();');
  const measureIdx = exportRunner.indexOf('const itemHeights = measureItemHeights(');
  const pageLoopIdx = exportRunner.indexOf('runnerState.items = items.slice(page.start, page.end);');
  assert.ok(stableIdx !== -1 && measureIdx !== -1, 'waitStable/measureItemHeights 消费点形态漂移');
  assert.ok(stableIdx < measureIdx, '首次 waitStable 须先于 measureItemHeights（R05-F2 修复的意义所在）');
  const secondStableIdx = exportRunner.indexOf('await waitStable();', measureIdx);
  assert.ok(secondStableIdx > pageLoopIdx, '每页 waitStable 调用缺失或位置漂移');
});

console.log('\n=== X8-⑤ selftest 清单登记 ===');
check('selftest-static-list.txt 已登记本脚本', () => {
  assert.ok(
    selftestList.includes('scripts/tdd-export-mermaid-settle-verify.ts'),
    '清单未登记（尾部追加一行）',
  );
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
