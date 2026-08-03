// tdd-diff-offsets-verify.ts
// computeOffsets 契约：移植 contrast scrollY 焦点 1/3 对齐算法。
// 运行：npx tsx scripts/tdd-diff-offsets-verify.ts
import { strict as assert } from 'node:assert';
import { computeOffsets, bridgePolygon, resolveSearchScrollTop } from '../src/renderer/utils/diff-render';
import type { SplitChunk } from '../src/renderer/utils/diff-render';

let pass = 0; let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const LH = 22;
const VP = 660; // 视口高

check('焦点在 same chunk（无偏移需求）→ 左右偏移 0', () => {
  const chunks: SplitChunk[] = [
    { kind: 'same', leftStart: 0, rightStart: 0, leftSize: 30, rightSize: 30, size: 30, navIndex: null },
  ];
  // 焦点 = VP/3 ≈ 220 → focalLine ≈ 10，落在 same chunk 内
  const o = computeOffsets(chunks, 0, VP, LH);
  assert.equal(o.left, 0);
  assert.equal(o.right, 0);
});

check('焦点在 add chunk（左栏空）→ 左栏正偏移填补空缺，右栏近 0', () => {
  // 先 10 行 same，再 5 行 add
  const chunks: SplitChunk[] = [
    { kind: 'same', leftStart: 0, rightStart: 0, leftSize: 10, rightSize: 10, size: 10, navIndex: null },
    { kind: 'add', leftStart: 10, rightStart: 10, leftSize: 0, rightSize: 5, size: 5, navIndex: 0 },
  ];
  // 滚到 add chunk 中部：scrollTop 让焦点落进 add（river 行 10..15）
  // focalPoint = VP/3 + scrollTop；要 focalLine 在 12 → focalPoint ≈ 12*22=264 → scrollTop ≈ 264 - 220 = 44
  const o = computeOffsets(chunks, 44, VP, LH);
  // add chunk：riverStart=10, leftStart=10, rightStart=10。riverStart-leftStart=0；但 size-leftSize=5>0
  // 左偏移 = (10-10)*22 + percent*5*22；percent>0 → left>0（左栏下移填补空缺），右偏移≈0
  assert.ok(o.left > 0, `add chunk 左栏须正偏移填补，实际 ${o.left}`);
  assert.ok(Math.abs(o.right) < LH, `add chunk 右栏偏移应近 0，实际 ${o.right}`);
});

check('焦点超出末尾 → 兜底返回 0 不崩', () => {
  const chunks: SplitChunk[] = [
    { kind: 'same', leftStart: 0, rightStart: 0, leftSize: 2, rightSize: 2, size: 2, navIndex: null },
  ];
  const o = computeOffsets(chunks, 99999, VP, LH);
  assert.equal(o.left, 0);
  assert.equal(o.right, 0);
});

check('M:N edit chunk 焦点居中 → 左右偏移方向相反（对齐到 river 中线）', () => {
  // 10 same + edit(左3右1)
  const chunks: SplitChunk[] = [
    { kind: 'same', leftStart: 0, rightStart: 0, leftSize: 10, rightSize: 10, size: 10, navIndex: null },
    { kind: 'edit', leftStart: 10, rightStart: 10, leftSize: 3, rightSize: 1, size: 3, navIndex: 0 },
  ];
  // 焦点落进 edit chunk（river 行 10..13）中部 ≈ 行 11.5
  // focalPoint=11.5*22=253 → scrollTop≈253-220=33
  const o = computeOffsets(chunks, 33, VP, LH);
  // edit：riverStart=10,leftStart=10,rightStart=10。leftSize=3,rightSize=1,size=3。
  // leftOffset=(10-10)*22+percent*(3-3)*22=0；rightOffset=(10-10)*22+percent*(3-1)*22
  // percent>0 → rightOffset>0（右栏下移，把单行对齐到 3 行的中部）
  assert.ok(o.right > 0, `M:N edit 右栏（窄侧）须正偏移，实际 ${o.right}`);
});

check('bridgePolygon: add chunk 三角形（左 size=0 收 2px）+ 上下边线', () => {
  const c: SplitChunk = { kind: 'add', leftStart: 10, rightStart: 10, leftSize: 0, rightSize: 3, size: 3, navIndex: 0 };
  const b = bridgePolygon(c, { left: 0, right: 0 }, LH);
  assert.equal(b.kind, 'add');
  assert.equal(b.top, 219);      // 10×22 - 1（top 减 1 对齐 2px ruler）
  assert.equal(b.height, 68);    // rightBottom(287) - top(219)
  assert.equal(b.points, '0,0 100,0 100,68 0,2');  // 左 2px 尖 / 右 68px → 三角形（非 1 行梯形）
  assert.deepEqual(b.topLine, { y1: 1, y2: 1 });      // 上边线水平（左尖=右顶，同高）
  assert.deepEqual(b.bottomLine, { y1: 1, y2: 67 });  // 下边线斜（左尖 → 右底）
});

check('bridgePolygon: 随 offset 变形（offset 变 → points 变）', () => {
  const c: SplitChunk = { kind: 'edit', leftStart: 0, rightStart: 0, leftSize: 1, rightSize: 1, size: 1, navIndex: 0 };
  const b0 = bridgePolygon(c, { left: 0, right: 0 }, LH);
  const b1 = bridgePolygon(c, { left: 44, right: 0 }, LH);
  assert.notEqual(b0.points, b1.points, 'offset 变化桥须变形');
});

check('computeOffsets: 前置不等 chunk → 后续 same base 非 0（magic scrolling 对齐）', () => {
  const chunks: SplitChunk[] = [
    { kind: 'del', leftStart: 0, rightStart: 0, leftSize: 2, rightSize: 0, size: 2, navIndex: 0 },
    { kind: 'same', leftStart: 2, rightStart: 0, leftSize: 30, rightSize: 30, size: 30, navIndex: null },
  ];
  const o = computeOffsets(chunks, 0, VP, LH);  // focalPoint=220 在 same（river 2..32）
  assert.equal(o.left, 0);    // 左 leftStart=riverStart=2 → base=0
  assert.equal(o.right, 44);  // 右 rightStart=0, riverStart=2 → base=(2-0)×22=44
});

function centerError(
  chunks: SplitChunk[],
  side: 'left' | 'right',
  sideLineIndex: number,
  scrollTop: number,
  viewportH: number,
): number {
  const offsets = computeOffsets(chunks, scrollTop, viewportH, LH);
  return sideLineIndex * LH + offsets[side] - scrollTop + LH / 2 - viewportH / 2;
}

check('搜索定位：前置 same + M:N edit 的短侧首尾从远距离滚动均收敛到中心', () => {
  const chunks: SplitChunk[] = [
    { kind: 'same', leftStart: 0, rightStart: 0, leftSize: 40, rightSize: 40, size: 40, navIndex: null },
    { kind: 'edit', leftStart: 40, rightStart: 40, leftSize: 9, rightSize: 3, size: 9, navIndex: 0 },
    { kind: 'same', leftStart: 49, rightStart: 43, leftSize: 40, rightSize: 40, size: 40, navIndex: null },
  ];
  const viewportH = 220;
  const maxScrollTop = chunks.reduce((sum, chunk) => sum + chunk.size, 0) * LH - viewportH;
  for (const initial of [0, maxScrollTop]) {
    for (const sideLineIndex of [40, 42]) {
      const resolved = resolveSearchScrollTop(
        chunks, 'right', sideLineIndex, viewportH, LH, maxScrollTop, initial,
      );
      const error = centerError(chunks, 'right', sideLineIndex, resolved, viewportH);
      assert.ok(Math.abs(error) < 1, `initial=${initial}, line=${sideLineIndex}, error=${error}, scrollTop=${resolved}`);
    }
  }
});

check('搜索定位：目标无法居中时 clamp 到边界并保持在视口内', () => {
  const chunks: SplitChunk[] = [
    { kind: 'same', leftStart: 0, rightStart: 0, leftSize: 20, rightSize: 20, size: 20, navIndex: null },
  ];
  const viewportH = 220;
  const maxScrollTop = 220;
  for (const [line, expected] of [[0, 0], [19, maxScrollTop]] as const) {
    const resolved = resolveSearchScrollTop(chunks, 'left', line, viewportH, LH, maxScrollTop, expected ? 0 : maxScrollTop);
    const offsets = computeOffsets(chunks, resolved, viewportH, LH);
    const center = line * LH + offsets.left - resolved + LH / 2;
    assert.equal(resolved, expected);
    assert.ok(center >= 0 && center <= viewportH, `line=${line}, center=${center}`);
  }
});

console.log(`\ndiff-offsets: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
