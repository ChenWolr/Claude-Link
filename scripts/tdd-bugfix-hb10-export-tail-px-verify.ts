// scripts/tdd-bugfix-hb10-export-tail-px-verify.ts
// hb10 P2-12（EXP-15·升P2）契约：分数 DPR 尾段 ±1px 越界容差——worker 钳制 + finalize 放宽拒绝条件。
//
// 病根（复核数值实验复现）：placeSegment 对 sourceStartPx/destStartPx/destEndPx 三处独立 round，
// 分数 scaleY 下尾段可产生 source 恰好越界 1 物理像素：sourceEndPx = 1499 + 2 = 1501 > bitmap 1500
// → worker source-overflow / finalize 「source 越界」整单失败。整数 DPR 命中率为 0（实验实证）。
//
// 修法（hb12 附录 C 澄清版）：
//   · 派生值（drawHeightPx/destEndPx/sourceStartPx）一律不改——finalize 的
//     `destEndPx - destStartPx !== drawHeightPx` 自洽断言对 placeSegment 产物恒真；
//   · finalize 只把 source 越界拒绝条件放宽至 +1（>1px 仍拒）；
//   · 钳制只发生在 worker：越界 ≤1 时 drawHeightPx 收口为 bitmap 高度（dest 连续性不变）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-export-tail-px-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { placeSegment, finalizeSegmentCopyGeometry, buildSegmentCopyGeometry } from '../src/shared/export-image';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const worker = read('src/main/modules/export-image-codec-worker.ts');
const shared = read('src/shared/export-image.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// 复核实验构造用例：pageH=1001、cursor=1000、scrollY clamp=1、scale=1.5（896×1000 视口）。
const TAIL_INPUT = {
  cursorCss: 1000,
  actualScrollYCss: 1,
  viewportWidthCss: 896,
  viewportHeightCss: 1000,
  totalHeightCss: 1001,
  bitmapWidthPx: 1344, // 896 × 1.5
  bitmapHeightPx: 1500, // 1000 × 1.5
};

check('① 派生值不变（hb12 附录 C）：placeSegment 三处 round 产物仍为 sourceStart=1499 / dest=[1500,1502) / drawH=2', () => {
  const p = placeSegment(TAIL_INPUT);
  assert.ok(p.ok, `placeSegment 应成功：${'reason' in p ? p.reason : ''}`);
  assert.equal(p.sourceStartPx, 1499, 'sourceStartPx = round(999×1.5)');
  assert.equal(p.destStartPx, 1500, 'destStartPx = round(1000×1.5)');
  assert.equal(p.destEndPx, 1502, 'destEndPx = round(1001×1.5)');
  assert.equal(p.drawHeightPx, 2, 'drawHeightPx = destEnd - destStart');
  // finalize 自洽断言（原 :531）对 placeSegment 产物恒真——派生未被动过。
  assert.equal(p.destEndPx - p.destStartPx, p.drawHeightPx, 'destEnd-destStart != drawHeightPx 自洽被破坏');
});

check('② 行为级：尾段 ±1px 构造用例通过（pageH=1001/cursor=1000/scale=1.5，旧实现报「source 越界」）', () => {
  const r = buildSegmentCopyGeometry(TAIL_INPUT);
  assert.ok(r.ok, `尾段 ±1px 用例仍失败（回归未修）：${r.ok ? '' : (r as { reason: string }).reason}`);
  if (r.ok) {
    assert.equal(r.geometry.sourceEndPx, 1501, 'sourceEndPx 派生不得被改（=1501 > bitmap 1500，靠容差放行+worker 钳制）');
  }
  // finalize 单独喂同样放行。
  const p = placeSegment(TAIL_INPUT);
  const f = finalizeSegmentCopyGeometry(p, TAIL_INPUT.bitmapWidthPx, TAIL_INPUT.bitmapHeightPx);
  assert.ok(f.ok, `finalize 放宽后仍拒绝：${f.ok ? '' : (f as { reason: string }).reason}`);
});

check('③ finalize 边界：恰好 +1px 放行、+2px 拒绝（直喂构造 placement——finalize 导出即为测试通道）', () => {
  // 与 ② 同产物的 placement（sourceEnd = 1499+2 = 1501）：
  const p = placeSegment(TAIL_INPUT);
  assert.ok(p.ok, 'placeSegment 应成功');
  // bitmapHeight=1500：sourceEnd 1501 = bitmap+1 → 恰好 +1px，放行。
  const atPlus1 = finalizeSegmentCopyGeometry(p, TAIL_INPUT.bitmapWidthPx, 1500);
  assert.ok(atPlus1.ok, '恰好 +1px 越界应放行（容差边界）');
  // bitmapHeight=1499：sourceEnd 1501 = bitmap+2 → 拒绝。
  const atPlus2 = finalizeSegmentCopyGeometry(p, TAIL_INPUT.bitmapWidthPx, 1499);
  assert.ok(!atPlus2.ok, '+2px 越界必须仍被拒（容差不得变成无界）');
  if (!atPlus2.ok) assert.match(atPlus2.reason, /source 越界/, `拒绝理由应仍为 source 越界：${atPlus2.reason}`);
});

check('④ worker：±1px 容差 + 钳制形态（decoded.height + 1 拒绝门 + drawHeightPx 收口 + dest 连续性不变）', () => {
  assert.match(worker, /g\.sourceStartPx \+ g\.drawHeightPx > decoded\.height \+ 1/, "worker 缺 '+1' 容差拒绝门");
  assert.match(worker, /decoded\.height - g\.sourceStartPx/, 'worker 缺钳制（drawHeightPx = bitmapHeight - sourceStartPx）');
  const segFnIdx = worker.indexOf('export function codecSegment');
  assert.ok(segFnIdx > -1, '未找到 codecSegment');
  const segBody = worker.slice(segFnIdx, worker.indexOf('export function', segFnIdx + 10));
  assert.match(segBody, /copySegmentRows\(state\.full, decoded\.data, copyGeom\)/, '拷贝必须使用钳制后的几何（copyGeom），不得仍直传 g');
  assert.match(segBody, /state\.nextDestEndPx = g\.destEndPx/, '钳制后 dest 连续性游标仍须按原 destEndPx 推进（页连续性不变）');
});

check('⑤ finalize：只放宽 source 越界拒绝条件至 +1（shared/export-image.ts 含 bitmapHeightPx + 1）', () => {
  const fnIdx = shared.indexOf('export function finalizeSegmentCopyGeometry');
  const fnEnd = shared.indexOf('\n}', fnIdx);
  const body = shared.slice(fnIdx, fnEnd > -1 ? fnEnd : undefined);
  assert.match(body, /sourceEndPx > bitmapHeightPx \+ 1/, 'finalize 缺 +1 容差拒绝条件');
  assert.match(body, /sourceEndPx = sourceStartPx \+ drawHeightPx/, 'sourceEndPx 派生形态被改（hb12 附录 C：派生值不动）');
  assert.match(body, /sourceStartPx < 0/, '负向守卫仍在（对称容差由 worker -1 门承担）');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
