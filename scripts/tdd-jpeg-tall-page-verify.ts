// tdd-jpeg-tall-page-verify.ts
// A15（D13-F1，P2）契约钉：JPEG 单条超限消息动态抬升为「变高页」，不再整单失败。
//
// 根因：JPEG 单页高固定 1500 CSS px（保守取值）且消息/fold 为不可分割原子——单条超限
//（约 60+ 行文本/代码）splitPages 即置 oversizeItem 整单失败 item-over-budget，长回复会话
// 默认格式导出直接不可用；错误文案不提示可改用 PNG（页上限 ~3 万 px），用户无从自救。
// 而像素预算本可支撑远更高（deriveMaxPageHeightCss(1.25, 896)：物理高 24M/1120 ≈ 21428，
// P2-2 修复后按 CSS 计 ≈ 17142 = 21428÷1.25）。
//
// 修复语义：splitPages 增加 hardCap（像素预算反推的硬上限）——超常规页高（1500）但未超
// hardCap 的消息自成「变高页」（JPEG 各页独立成图、无跨页拼接，天然兼容变高页；捕获期
// checkPixelBudget 仍逐页兜底），前后内容维持 1500 切页；仅超 hardCap 才快速失败（保留
// hb10-P2-11 的 oversizeItem 预检机制），文案区分：JPEG 分支提示改用 PNG，PNG 分支维持
// 原文案。JPEG 仅在存在超限消息时才 probeSelf 反推 hardCap（常规导出零新增 IPC 往返）。
//
// 核验后追加修复（2026-10-01）：① 跨进程接线——主进程 pngProbeSelfImpl 原 PNG-only 门禁
// （wrong-format「probe 仅 PNG 模式」）放开为 JPEG 亦可用（probe 只读 DOM 几何 + capturePage
// 测比例，与导出格式无关；不放开则 JPEG 超限导出在 planning 即整单失败，变高页路径生产
// 不可达）；② 硬上限预检计入页固定 overhead（overhead+h>hardCap 才 oversize）——压线变高页
// 实际渲染高含 export-header 等固定开销，原 h>hardCap 判定会漏到捕获期才报 page-over-budget。
//
// P2-2 追加（2026-10-02 对抗 review）：deriveMaxPageHeightCss 返回的是物理像素高却被消费方
// （export-runner hardCap）当 CSS 上限——DPR>1 屏（1.25/2.0 主流）放行页物理像素 = 24M×scaleY
// 超预算，恰漏到捕获期 checkPixelBudget 迟失败（A15 要消除的「压线项漏到捕获期」）。修复：
// min(heightByPixels, heightByDim) 后 ÷scaleY 转 CSS（与 deriveMaxPageHeightByMemory 末行同法）；
// DPR=1 两值一致零回归。
//
// X6 追加（2026-10-06 R13-F1 回归修复）：硬上限预检收窄为仅变高页候选——JPEG tallest≤1500
// 的会话不 probe、hardCap 停默认 1500，全员「overhead+h>hardCap」预检会误杀 h∈(1310,1500]
// 的常规消息整单失败（v0.4.2 之前可导出的回归）；修法 `h > maxHeight && overhead + h >
// hardCap`（h≤maxHeight 恢复旧行为永不预检失败；变高页候选仍受反推后真实预算保护）。
//
// 运行：npx tsx scripts/tdd-jpeg-tall-page-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { deriveMaxPageHeightCss, PIXEL_COUNT_MAX } from '../src/shared/export-image';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const runner = readFileSync(new URL('../src/renderer/export/export-runner.ts', import.meta.url), 'utf8');

// 与实施后 splitPages 同构的复刻（export-runner 未导出该函数且含 vue/别名副作用，行为级
// 复刻 + 组2 结构钉双保险）。
type OversizeItem = { index: number; heightPx: number } | null;
function splitPagesImpl(itemHeights: number[], overhead: number, maxHeight: number, hardCap: number): { pages: Array<{ start: number; end: number }>; oversize: OversizeItem } {
  let oversize: OversizeItem = null;
  const pages: Array<{ start: number; end: number }> = [];
  let start = 0;
  let acc = 0;
  for (let i = 0; i < itemHeights.length; i++) {
    const h = itemHeights[i] ?? 0;
    // X6（R13-F1）：预检仅对变高页候选（h > maxHeight）生效——未探测会话 hardCap 停默认
    // 1500，全员预检会误杀 h∈(1310,1500] 的常规消息（overhead≈190 计入即超默认 hardCap）。
    if (h > maxHeight && overhead + h > hardCap) {
      oversize = { index: i, heightPx: h };
      return { pages, oversize };
    }
    if (h > maxHeight) {
      if (i > start) pages.push({ start, end: i });
      pages.push({ start: i, end: i + 1 });
      start = i + 1;
      acc = 0;
      continue;
    }
    if (i > start && overhead + acc + h > maxHeight) {
      pages.push({ start, end: i });
      start = i;
      acc = 0;
    }
    acc += h;
  }
  if (start < itemHeights.length) pages.push({ start, end: itemHeights.length });
  return { pages, oversize };
}

console.log('\n=== A15（D13-F1）：JPEG 超限消息变高页 ===');
console.log('\n=== 组1 行为级（splitPages 同构复刻） ===');
check('① 无超限消息：全按 1500 切页（现状兼容，页数与旧行为一致）', () => {
  const heights = Array.from({ length: 20 }, () => 100); // 总 2000+overhead 50 → 2 页
  const r = splitPagesImpl(heights, 50, 1500, 21428);
  assert.equal(r.oversize, null);
  assert.equal(r.pages.length, 2);
  assert.deepEqual(r.pages[0], { start: 0, end: 14 });
  assert.deepEqual(r.pages[1], { start: 14, end: 20 });
});
check('② 单条超高（5000px < hardCap）：自成变高页，前后内容正常 1500 切页', () => {
  const heights = [100, 100, 5000, 100, 100];
  const r = splitPagesImpl(heights, 50, 1500, 21428);
  assert.equal(r.oversize, null, '预算内超限不再整单失败');
  assert.deepEqual(r.pages, [
    { start: 0, end: 2 },   // 前两个正常项一页
    { start: 2, end: 3 },   // 超高项变高页
    { start: 3, end: 5 },   // 后两个正常项一页
  ]);
});
check('③ 多条超高：各自成变高页（互不相邻）', () => {
  const heights = [2000, 50, 3000];
  const r = splitPagesImpl(heights, 0, 1500, 21428);
  assert.deepEqual(r.pages, [
    { start: 0, end: 1 },
    { start: 1, end: 2 },
    { start: 2, end: 3 },
  ]);
});
check('④ 恰好压线（=1500）不触发变高；1501 触发', () => {
  const r1 = splitPagesImpl([1500], 0, 1500, 21428);
  assert.deepEqual(r1.pages, [{ start: 0, end: 1 }]);
  const r2 = splitPagesImpl([1501], 0, 1500, 21428);
  assert.deepEqual(r2.pages, [{ start: 0, end: 1 }], '1501 自成变高页（仍单页）');
});
check('⑤ 超像素预算硬上限（h > hardCap）：置 oversizeItem 快速失败（hb10-P2-11 机制保留）', () => {
  const r = splitPagesImpl([100, 30000], 50, 1500, 21428);
  assert.deepEqual(r.oversize, { index: 1, heightPx: 30000 });
});
check('⑥ 末条超高自成页后不产空页（start === itemCount 边界）', () => {
  const r = splitPagesImpl([100, 5000], 0, 1500, 21428);
  assert.deepEqual(r.pages, [{ start: 0, end: 1 }, { start: 1, end: 2 }]);
  assert.ok(!r.pages.some((p) => p.start >= p.end), '不得产出空页');
});
check('⑦ overhead 计入硬上限：h=hardCap−overhead 压线自成变高页（渲染高恰在预算内）', () => {
  const r = splitPagesImpl([21428 - 50], 50, 1500, 21428);
  assert.equal(r.oversize, null, 'overhead+h=hardCap 不得误杀压线变高页');
  assert.deepEqual(r.pages, [{ start: 0, end: 1 }]);
});
check('⑧ overhead 计入硬上限：h=hardCap−overhead+1 即 oversize（压线不漏到捕获期）', () => {
  const r = splitPagesImpl([100, 21428 - 49], 50, 1500, 21428);
  assert.deepEqual(r.oversize, { index: 1, heightPx: 21428 - 49 }, 'overhead+h>hardCap 须预检收口（原 h>hardCap 会漏判 1px 带宽）');
});

console.log('\n=== 组2 结构契约（export-runner 接线 + 文案） ===');
check('⑨ JPEG 存在超限消息才 probeSelf 反推 hardCap（常规导出零新增 IPC）', () => {
  const fnIdx = runner.indexOf('function splitPages');
  assert.ok(fnIdx > -1, '缺 splitPages');
  assert.match(runner, /tallest > PAGE_HEIGHT_CSS/, '缺超限预判（tallest 扫描）');
  assert.match(runner, /hardCap = deriveMaxPageHeightCss\(probe\.scaleY, probe\.viewportWidthCss\)/, '缺 JPEG 预算反推 hardCap');
  const tallestIdx = runner.indexOf('tallest > PAGE_HEIGHT_CSS');
  const probeIdx = runner.indexOf('api.probeSelf', tallestIdx);
  assert.ok(tallestIdx > -1 && probeIdx > tallestIdx, 'probe 须在超限预判之后（条件触发）');
});
check('⑩ splitPages 签名含 hardCap 且变高页分支在位（h > maxHeight 自成页；硬上限计入 overhead）', () => {
  const fnIdx = runner.indexOf('function splitPages');
  const body = runner.slice(fnIdx, runner.indexOf('\n}', fnIdx));
  assert.match(body, /hardCap: number/, '缺 hardCap 参数');
  assert.match(body, /if \(h > maxHeight && overhead \+ h > hardCap\)/, '缺硬上限判定（X6 收窄为仅变高页候选判定，须计入页固定 overhead）');
  assert.match(body, /if \(h > maxHeight\)/, '常规上限判定保留（hb10-P2-11 契约形态）');
  assert.match(body, /pages\.push\(\{ start: i, end: i \+ 1 \}\);/, '缺变高页自成形态');
  assert.match(body, /if \(start < itemCount\) pages\.push/, '缺末尾空页守卫');
});
check('⑪ PNG hardCap = maxPageHeight（内存预算即硬上限，原行为不回归）', () => {
  const pngIdx = runner.indexOf("job.format === 'png'");
  const region = runner.slice(pngIdx, pngIdx + 800);
  assert.match(region, /maxPageHeight = deriveMaxPageHeightByMemory/, 'PNG 预算反推保留');
  assert.match(runner, /hardCap = maxPageHeight;/, 'PNG 路径 hardCap 绑定（格式分支内）');
});
check('⑫ 失败文案：JPEG 分支提示改用 PNG；PNG 分支维持原文案（hb10-P2-11 形态）', () => {
  assert.match(runner, /请改用 PNG 导出（单页上限更高）或精简会话后重试/, 'JPEG 分支缺 PNG 建议');
  assert.match(runner, /条消息高度超过单页上限，无法导出/, 'PNG 分支原文案须保留');
  assert.match(runner, /code: 'item-over-budget'/, '失败 code 保留');
});
check('⑬ 跨进程接线：probe 主进程门禁放开（JPEG 反推预算可达），beginPage 仍仅 PNG', () => {
  const manager = readFileSync(new URL('../src/main/modules/export-image-manager.ts', import.meta.url), 'utf8');
  const probeIdx = manager.indexOf('async function pngProbeSelfImpl');
  assert.ok(probeIdx > -1, '缺 pngProbeSelfImpl');
  const probeBody = manager.slice(probeIdx, manager.indexOf('\n}', probeIdx));
  assert.ok(!probeBody.includes("active.format !== 'png'"), 'probe 不得按 format 拒绝（JPEG 超限反推 hardCap 亦经此，否则 planning 即 wrong-format 整单失败）');
  assert.match(probeBody, /readExportDomGeometry/, 'probe 实质工作（DOM 几何读取）须在位');
  const beginIdx = manager.indexOf('async function pngBeginPageImpl');
  const beginBody = manager.slice(beginIdx, manager.indexOf('\n}', beginIdx));
  assert.match(beginBody, /active\.format !== 'png'/, 'beginPage 须维持仅 PNG 门禁（页协议不回退）');
  const handlerIdx = manager.indexOf('IPC_CHANNELS.EXPORT_RENDER_PROBE_SELF');
  const handlerRegion = manager.slice(handlerIdx, handlerIdx + 500);
  assert.match(handlerRegion, /pngProbeSelfImpl/, 'PROBE_SELF handler 须路由 pngProbeSelfImpl');
  const preload = readFileSync(new URL('../src/preload/api.ts', import.meta.url), 'utf8');
  assert.match(preload, /probeSelf: \(request\) => ipcRenderer\.invoke\(IPC_CHANNELS\.EXPORT_RENDER_PROBE_SELF, request\)/, 'preload probeSelf 须直连 invoke（无格式分流，分流责任在主进程）');
});

console.log('\n=== 组3 P2-2（2026-10-02 对抗 review）：hardCap 反推须 ÷scaleY 转 CSS ===');
check('⑭ DPR=1.25：scaleY=1.25、contentWidthCss=1000 → CSS 上限 ≈ (24M/1250)/1.25 = 15360（非物理值 19200）', () => {
  const h = deriveMaxPageHeightCss(1.25, 1000);
  const physicalWidth = Math.round(1000 * 1.25); // 1250
  const expectedCss = Math.floor(Math.floor(PIXEL_COUNT_MAX / physicalWidth) / 1.25); // floor(19200/1.25)=15360
  assert.ok(Math.abs(h - expectedCss) <= 1, `期望约 ${expectedCss}，得到 ${h}`);
  assert.ok(h < Math.floor(PIXEL_COUNT_MAX / physicalWidth), '不得把物理高当 CSS 上限返回（DPR>1 捕获期迟失败根因）');
});
check('⑮ DPR=2.0：scaleY=2、contentWidthCss=1000 → CSS 上限 ≈ (24M/2000)/2 = 6000', () => {
  const h = deriveMaxPageHeightCss(2, 1000);
  const physicalWidth = Math.round(1000 * 2); // 2000
  const expectedCss = Math.floor(Math.floor(PIXEL_COUNT_MAX / physicalWidth) / 2); // floor(12000/2)=6000
  assert.ok(Math.abs(h - expectedCss) <= 1, `期望约 ${expectedCss}，得到 ${h}`);
});
check('⑯ DPR=1 不回归：物理高与 CSS 一致（24M/896 ≈ 26785 原行为保留）', () => {
  const h = deriveMaxPageHeightCss(1, 896);
  const expectedCss = Math.floor(PIXEL_COUNT_MAX / 896); // 26785（< 30000 维度上限，min 不截）
  assert.ok(Math.abs(h - expectedCss) <= 1, `期望约 ${expectedCss}，得到 ${h}`);
});
check('⑰ 迟失败消除判据：CSS 上限 × scaleY 反推物理像素 ≤ 24M（1.25/2/1.5/1 全过）', () => {
  for (const [scaleY, width] of [[1.25, 1000], [2, 1000], [1.5, 896], [1, 896]] as const) {
    const css = deriveMaxPageHeightCss(scaleY, width);
    const physicalWidth = Math.round(width * scaleY);
    const physicalHeight = Math.round(css * scaleY);
    assert.ok(
      physicalWidth * physicalHeight <= PIXEL_COUNT_MAX,
      `scaleY=${scaleY} width=${width}：css=${css} → 物理 ${physicalWidth}×${physicalHeight} 超像素预算（将漏到捕获期 checkPixelBudget 迟失败）`,
    );
  }
});

console.log('\n=== 组4 X6（R13-F1，2026-10-06）：硬上限预检收窄为变高页候选 ===');
check('⑱ 未探测默认 hardCap=1500：h=1400（≤maxHeight）即使 overhead190+h=1590>1500 也不置 oversizeItem（R13-F1 误杀带回归修复）', () => {
  const r = splitPagesImpl([1400], 190, 1500, 1500);
  assert.equal(r.oversize, null, 'h≤maxHeight 的常规消息永不触发预检失败（恢复 5dbcdb9 前旧行为）');
  assert.deepEqual(r.pages, [{ start: 0, end: 1 }], '正常按常规页切页');
});
check('⑲ 变高页候选仍受预算保护：h=1501（>maxHeight）且 overhead190+h=1691>hardCap1600（反推后仍不够）→ 置 oversizeItem', () => {
  const r = splitPagesImpl([1501], 190, 1500, 1600);
  assert.deepEqual(r.oversize, { index: 0, heightPx: 1501 }, '变高页候选超反推后预算仍须预检收口（不漏到捕获期）');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
