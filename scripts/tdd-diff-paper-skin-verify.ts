// tdd-diff-paper-skin-verify.ts
// 「纸面工坊」diff 视觉重设计契约（docs/plans/diff-paper-skin-plan.md P0）：
//   纯函数组：diff-render.bridgeRibbon 贝塞尔缎带几何（对齐退化水平直线 / add 三角兜底 / 无副作用 / bridgePolygon 兼容保留）。
//   源码契约组：DiffBody split 舞台新结构（gutter/卡片/单 SVG river/insert 公式）、
//     DiffLine split 分支去行号、DiffDialog 暖 scrim、--river-w token。
// 运行：npx tsx scripts/tdd-diff-paper-skin-verify.ts
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import type { SplitChunk } from '../src/renderer/utils/diff-render';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message.split('\n')[0]}`);
  }
}

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

// 桥几何纯函数：P1 起由 diff-render 导出（P0 尚不存在 → 动态导入失败逐条记 ❌）。
interface RibbonGeoLike {
  kind: string;
  top: number;
  height: number;
  fillD: string;
  topEdgeD: string;
  bottomEdgeD: string;
  dots: Array<{ x: number; y: number }>;
}
type DiffRenderModule = {
  bridgeRibbon?: (c: SplitChunk, offsets: { left: number; right: number }, lineHeight: number, riverW: number) => RibbonGeoLike;
  bridgePolygon?: unknown;
};
let dr: DiffRenderModule | null = null;
let importError = '';

// 提取 SVG path 里序数为奇偶的坐标：偶数位 x / 奇数位 y（M/C/L 指令符已被过滤，只剩数字）。
function pathCoords(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

async function main(): Promise<void> {
  try {
    dr = (await import('../src/renderer/utils/diff-render')) as DiffRenderModule;
  } catch (e) {
    importError = (e as Error).message;
  }

  const LH = 22;
  const W = 64;

  console.log('\n── 纯函数组：bridgeRibbon ──');
  check('bridgeRibbon 可导入且 bridgePolygon 兼容保留（不删不改）', () => {
    assert.ok(dr, `diff-render 动态导入失败：${importError}`);
    assert.equal(typeof dr!.bridgeRibbon, 'function', 'diff-render 须导出 bridgeRibbon');
    assert.equal(typeof dr!.bridgePolygon, 'function', 'bridgePolygon 须兼容保留');
  });

  check('bridgeRibbon: 对齐同尺寸 chunk（offsets{0,0}，leftSize==rightSize）→ 上下边线水平直线', () => {
    const c: SplitChunk = { kind: 'edit', leftStart: 5, rightStart: 5, leftSize: 2, rightSize: 2, size: 2, navIndex: 0 };
    const r = dr!.bridgeRibbon!(c, { left: 0, right: 0 }, LH, W);
    for (const [label, d] of [['topEdgeD', r.topEdgeD], ['bottomEdgeD', r.bottomEdgeD]] as const) {
      const coords = pathCoords(d);
      assert.ok(coords.length >= 8, `${label} 须含至少 4 个坐标点`);
      const ys: number[] = [];
      for (let i = 1; i < coords.length; i += 2) ys.push(coords[i]!);
      assert.ok(ys.every((y) => Math.abs(y - ys[0]!) < 1e-9), `${label} 各控制点 y 须相等（水平直线），实际 ${ys}`);
    }
  });

  check('bridgeRibbon: add chunk（leftSize=0）→ 高度兜底 ≥2、四锚点、fillD 以 Z 闭合', () => {
    const c: SplitChunk = { kind: 'add', leftStart: 10, rightStart: 10, leftSize: 0, rightSize: 3, size: 3, navIndex: 0 };
    const r = dr!.bridgeRibbon!(c, { left: 0, right: 0 }, LH, W);
    assert.ok(r.height >= 2, `高度兜底须 ≥2，实际 ${r.height}`);
    assert.equal(r.dots.length, 4, '须有 4 个端点锚点（左lt/lb右rt/rb）');
    assert.ok(r.dots.every((d) => d.x === 0 || d.x === 1), `锚点 x 须为 0/1（归一化列），实际 ${JSON.stringify(r.dots)}`);
    assert.ok(r.fillD.trimEnd().endsWith('Z'), 'fillD 须以 Z 闭合');
  });

  check('bridgeRibbon: 无副作用（同输入同输出，不改写 chunk）', () => {
    const c: SplitChunk = { kind: 'del', leftStart: 3, rightStart: 2, leftSize: 2, rightSize: 0, size: 2, navIndex: 1 };
    const snapshot = JSON.stringify(c);
    const r1 = dr!.bridgeRibbon!(c, { left: 12, right: -4 }, LH, W);
    const r2 = dr!.bridgeRibbon!(c, { left: 12, right: -4 }, LH, W);
    assert.equal(JSON.stringify(c), snapshot, 'bridgeRibbon 不得改写 chunk 输入');
    assert.equal(r1.fillD, r2.fillD, '同输入须同输出');
    assert.notEqual(r1.fillD, dr!.bridgeRibbon!(c, { left: 0, right: 0 }, LH, W).fillD, 'offsets 变化须重算几何');
  });

  console.log('\n── 源码契约组 ──');
  const diffRenderSrc = read('../src/renderer/utils/diff-render.ts');
  const diffBodySrc = read('../src/renderer/components/changes/DiffBody.vue');
  const diffLineSrc = read('../src/renderer/components/changes/DiffLine.vue');
  const diffDialogSrc = read('../src/renderer/components/changes/DiffDialog.vue');
  const toolDiffDialogSrc = read('../src/renderer/components/chat/ToolDiffDialog.vue');
  const diffBodyScript = diffBodySrc.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1] ?? '';
  const diffBodyTemplate = diffBodySrc.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? '';
  const diffLineTemplate = diffLineSrc.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? '';

  check('diff-render.ts 须新增 export function bridgeRibbon', () => {
    assert.ok(diffRenderSrc.includes('export function bridgeRibbon'), 'diff-render.ts 缺 bridgeRibbon 导出');
  });

  console.log('  ── split 舞台（P2）──');
  check('DiffBody 须有单张全尺寸 SVG river（river-svg 元素本身不得用 viewBox）', () => {
    assert.ok(diffBodySrc.includes('river-svg'), 'DiffBody 缺 river-svg');
    const riverSvgTag = diffBodyTemplate.match(/<svg[^>]*class="river-svg"[^>]*>/)?.[0] ?? '';
    assert.ok(riverSvgTag, 'DiffBody 缺 river-svg 元素');
    assert.ok(!riverSvgTag.includes('viewBox'), 'river-svg 不应使用 viewBox（user units=px，防圆点拉椭圆）');
  });

  check('DiffBody split 舞台须有独立行号列（class="gutter"）', () => {
    assert.ok(diffBodySrc.includes('class="gutter"'), 'DiffBody 缺 gutter 行号列');
  });

  check('DiffBody 须有改动块卡片层（ccard + splitCardsL/R computed）', () => {
    assert.ok(diffBodySrc.includes('ccard'), 'DiffBody 缺 ccard 卡片');
    assert.match(diffBodyScript, /const splitCardsL = computed/, '须有 splitCardsL 卡片 computed');
    assert.match(diffBodyScript, /const splitCardsR = computed/, '须有 splitCardsR 卡片 computed');
  });

  check('DiffBody 卡片定位须直接绑定 chunk 行号×LH（top: c.leftStart * LH + \'px\'）', () => {
    assert.match(
      diffBodyTemplate,
      /class="ccard"[\s\S]{0,300}top: c\.leftStart \* LH \+ 'px'/,
      'ccard 须以 c.leftStart * LH 直接定位',
    );
  });

  check('DiffBody 不得再 import bridgePolygon（split 桥切到 bridgeRibbon）', () => {
    assert.doesNotMatch(diffBodyScript, /import\s*\{[^}]*bridgePolygon/, 'DiffBody 不得 import bridgePolygon');
  });

  check('DiffBody 不得残留 chunk-start/chunk-end 边线预计算（卡片取代）', () => {
    assert.ok(!diffBodySrc.includes('chunk-start'), 'DiffBody 不得残留 chunk-start');
    assert.ok(!diffBodySrc.includes('chunkStart'), 'DiffBody 不得残留 chunkStart 预计算');
  });

  check('DiffLine split 分支去行号（无裸 <span class="ln">），inline 分支保留', () => {
    assert.doesNotMatch(diffLineTemplate, /<span class="ln"/, 'DiffLine 不得有无条件（split 可见）的行号 span');
    assert.match(diffLineTemplate, /v-if="variant === 'inline'"[^>]*class="ln"/, 'inline 分支须保留行号');
  });

  check('DiffBody insert-line 顶公式须为 leftStart * LH（不含 + LH / 2 偏移回归）', () => {
    assert.match(
      diffBodyTemplate,
      /insert-line[\s\S]{0,300}top: c\.leftStart \* LH \+ 'px'/,
      'insert-line 顶须直接绑定 c.leftStart * LH',
    );
    assert.ok(!diffBodySrc.includes('LH / 2'), 'DiffBody 不得含 LH / 2（插入标记偏移回归）');
  });

  check('.diff-river 须为真实中间列（宽 var(--river-w)）且 DiffDialog 定义 --river-w: 64px', () => {
    assert.match(diffBodySrc, /\.diff-river\s*\{[\s\S]{0,300}var\(--river-w\)/, '.diff-river 宽须走 var(--river-w)');
    assert.ok(diffDialogSrc.includes('--river-w: 64px'), 'DiffDialog 须定义 --river-w: 64px');
  });

  console.log('  ── inline 换皮（P3）──');
  check('DiffLine inline 行号槽须换不透明 tint 底（sticky 遮横向滚动内容）', () => {
    assert.match(
      diffLineSrc,
      /\.line--add \.ln\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--add-edge\) 8%,\s*var\(--color-panel-soft\)\)/,
      'inline add 行号槽须不透明 add-edge 8% 底',
    );
    assert.match(
      diffLineSrc,
      /\.line--del \.ln\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--del-edge\) 7%,\s*var\(--color-panel-soft\)\)/,
      'inline del 行号槽须不透明 del-edge 7% 底',
    );
  });

  check('DiffBody inline hunk 须圆角卡片化（9px 圆角 + 左侧渐变色轨）', () => {
    assert.match(
      diffBodySrc,
      /\.hunk-block\s*\{[^}]*border-radius:\s*9px/,
      '.hunk-block 须 9px 圆角',
    );
    assert.match(
      diffBodySrc,
      /\.hunk-block::before[\s\S]{0,400}linear-gradient\(/,
      '.hunk-block::before 须渐变色轨',
    );
  });

  console.log('  ── chrome 重组（P4）──');
  check('DiffDialog scrim 须为暖色 color-mix 且不再引用共享 token --interaction-overlay-bg', () => {
    assert.match(
      diffDialogSrc,
      /background:\s*color-mix\(in srgb, #4A3828 42%, transparent\)/,
      'DiffDialog scrim 须为暖色 color-mix',
    );
    assert.ok(!diffDialogSrc.includes('--interaction-overlay-bg'), 'DiffDialog 不得引用共享 token --interaction-overlay-bg');
  });

  check('DiffDialog 与 ToolDiffDialog 须有纸面包裹（paperwrap/paper）与 river 占位列', () => {
    for (const [name, src] of [['DiffDialog', diffDialogSrc], ['ToolDiffDialog', toolDiffDialogSrc]] as const) {
      assert.ok(src.includes('class="paperwrap"'), `${name} 缺 paperwrap 纸面留白层`);
      assert.ok(src.includes('class="paper"'), `${name} 缺 paper 纸卡`);
      assert.ok(src.includes('colhead--river'), `${name} 缺 river 占位列`);
    }
  });

  console.log(`\ndiff-paper-skin: ${pass} pass, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
