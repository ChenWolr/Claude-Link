// tdd-theme-separator-verify.ts
// 2026-11-19 UI 五点批次 P1「大区分隔线 token（含 H1 暗板定值 + H2 副本补齐）」契约脚本
// （用例正本 = docs/plans/2026-11-19-ui-five-points-batch/02-测试用例清单.md P1 组；
//   实现规格 = 同目录 01-实现细节.md §1；定值唯一来源 = prototypes/translate-ui-design-notes.md §1 全表。
//   P1-T5~T7 落 CDP layout 链、P1-T8 人工目测，不在本脚本。）
//   · P1-T1（正常向·数据契约）：import 真实 THEME_PALETTES，遍历全部 12 套，
//     断言每套 colors.borderStrong 字段存在且为可解析颜色字面（hex/rgba 均可）——不依赖运行时回退。
//   · P1-T2（边界向·量化判据）：对每套板算 borderStrong 对 panel 与对 bg 两底色的 WCAG 相对亮度
//     对比度（脚本内置公式），12 套 × 2 参照 = 24 个值全部 ∈ [1.10, 2.00]，逐板逐参照输出实测值。
//     （02 出卷定标：下限 1.10 严格可辨、上限 2.00 远弱于正文 4.5:1；inkstone 现值 ≈1.24/1.32 居中锚定。）
//   · P1-T3（回归钉·正常向）：三分隔消费点样式源仍引用 var(--color-border-strong)、
//     无硬编码色值替换、无整行 border 声明删除（钉现状已成立的对外消费契约）：
//     AppSidebar.vue .sidebar border-right / AppHeader.vue .app-header border-bottom /
//     TaskQueuePanel.vue .task-panel border-left。
//   · P1-T4（异常向·H2）：ConfigPage.vue 本地 applyTheme 副本写入的变量集合包含 --color-border-strong，
//     且取值口径与 apply-theme.ts 同一（同字段 borderStrong、同 isDark 分流回退字面等价：
//     暗板 #3D444D / 浅板 rgba(0,0,0,0.12)），双链键集一致（14 变量全集，对齐 apply-theme.ts:4-7 注释清单）。
// 形态对齐 scripts/tdd-tokens-inkstone-verify.ts：check() 计数、readRel、`结果：N 通过 / M 失败` 末行、
// fail>0 则 process.exit(1)。禁改被测模块源码（本脚本自身不含实现）。
// 运行：npx tsx scripts/tdd-theme-separator-verify.ts（已登记 scripts/selftest-static-list.txt 尾部）

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { THEME_PALETTES } from '../src/shared/constants';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
function readRel(p: string): string {
  const abs = path.resolve(__dirname, '..', p);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8');
}

// ── 颜色解析与 WCAG 相对亮度对比度（纯计算，供 T1 可解析判定与 T2 量化判据）──
interface Rgba { r: number; g: number; b: number; a: number }
function parseColorLiteral(literal: string): Rgba | null {
  const s = literal.trim();
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(s);
  if (hex) {
    const n = hex[1];
    if (n.length === 3 || n.length === 4) {
      const [r, g, b] = [0, 1, 2].map((i) => parseInt(n[i]! + n[i]!, 16));
      return { r, g, b, a: n.length === 4 ? parseInt(n[3]! + n[3]!, 16) / 255 : 1 };
    }
    if (n.length === 6 || n.length === 8) {
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
      const a = n.length === 8 ? parseInt(n.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return null;
  }
  const fn = /^rgba?\(\s*([^)]+)\)$/.exec(s);
  if (fn) {
    const parts = fn[1]!.split(/[\s,]+/).filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4) return null;
    const pct = (v: string, max: number) => v.endsWith('%') ? (parseFloat(v) / 100) * max : parseFloat(v);
    const r = pct(parts[0]!, 255), g = pct(parts[1]!, 255), b = pct(parts[2]!, 255);
    if ([r, g, b].some((v) => !Number.isFinite(v))) return null;
    const a = parts.length === 4 ? parseFloat(parts[3]!) : 1;
    if (!Number.isFinite(a)) return null;
    return { r, g, b, a };
  }
  return null;
}
function relLuminance(c: Rgba): number {
  const lin = [c.r, c.g, c.b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}
/** WCAG 对比度；fg 含 alpha 时按 bg 底色合成（分隔线横跨底色的漂移在数据层即消除）。 */
function contrastRatio(fgLiteral: string, bgLiteral: string): number {
  const bg = parseColorLiteral(bgLiteral);
  assert.ok(bg, `底色字面不可解析：${bgLiteral}`);
  const fg = parseColorLiteral(fgLiteral);
  assert.ok(fg, `前景字面不可解析：${fgLiteral}`);
  const comp = fg.a < 1
    ? {
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      }
    : fg;
  const l1 = relLuminance(comp), l2 = relLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ── CSS 块提取（T3 结构钉用）：按选择器字面定位 `sel {` 起始的声明块（浅层花括号配平）──
function extractCssBlock(src: string, selector: RegExp, label: string): string {
  const m = selector.exec(src);
  assert.ok(m, `${label}：选择器 ${selector} 未命中`);
  const open = src.indexOf('{', m.index);
  assert.ok(open !== -1, `${label}：选择器后无 {`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  assert.fail(`${label}：花括号未配平`);
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('=== P1-T1 12 套色板 borderStrong 全显式（数据契约） ===');

check('P1-T1 THEME_PALETTES 恰为 12 套', () => {
  assert.strictEqual(THEME_PALETTES.length, 12, `实际 ${THEME_PALETTES.length} 套`);
});
for (const p of THEME_PALETTES) {
  check(`P1-T1 ${p.id}（${p.name}）colors.borderStrong 存在且为可解析颜色字面`, () => {
    assert.ok('borderStrong' in p.colors, 'colors 上不存在 borderStrong 字段（回退到运行时缺省 = H1 病灶形态）');
    assert.strictEqual(typeof p.colors.borderStrong, 'string', 'borderStrong 非字符串');
    assert.ok(parseColorLiteral(p.colors.borderStrong!) !== null, `borderStrong=${p.colors.borderStrong} 非可解析颜色字面（hex/rgba）`);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n=== P1-T2 对比度窗口 [1.10, 2.00]（12 套 × panel/bg = 24 值） ===');
const WINDOW_MIN = 1.10, WINDOW_MAX = 2.00;
for (const p of THEME_PALETTES) {
  check(`P1-T2 ${p.id} borderStrong 对 panel 与 bg 对比度均 ∈ [1.10, 2.00]`, () => {
    assert.ok('borderStrong' in p.colors, '缺 borderStrong 定值（无法量化判定）');
    const vsPanel = contrastRatio(p.colors.borderStrong!, p.colors.panel);
    const vsBg = contrastRatio(p.colors.borderStrong!, p.colors.bg);
    console.log(`       ↳ ${p.id}: vs panel ${vsPanel.toFixed(2)} ${vsPanel >= WINDOW_MIN && vsPanel <= WINDOW_MAX ? '∈' : '∉'} / vs bg ${vsBg.toFixed(2)} ${vsBg >= WINDOW_MIN && vsBg <= WINDOW_MAX ? '∈' : '∉'} [${WINDOW_MIN}, ${WINDOW_MAX}]`);
    assert.ok(vsPanel >= WINDOW_MIN && vsPanel <= WINDOW_MAX, `对 panel 对比度 ${vsPanel.toFixed(2)} 越窗（${vsPanel < WINDOW_MIN ? '不可见' : '压内容'}）`);
    assert.ok(vsBg >= WINDOW_MIN && vsBg <= WINDOW_MAX, `对 bg 对比度 ${vsBg.toFixed(2)} 越窗（${vsBg < WINDOW_MIN ? '不可见' : '压内容'}）`);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n=== P1-T3 三分隔消费点结构钉（token 接线契约面） ===');

check('P1-T3 AppSidebar.vue .sidebar 的 border-right 仍引 var(--color-border-strong)（1px 实线、无硬编码色）', () => {
  const src = readRel('src/renderer/components/layout/AppSidebar.vue');
  const block = extractCssBlock(src, /^\.sidebar \{/m, 'AppSidebar .sidebar');
  const m = /border-right:\s*([^;]+);/.exec(block);
  assert.ok(m, '.sidebar 内整行 border-right 声明被删（分隔线契约面被拆）');
  assert.match(m[1]!, /1px\s+solid\s+var\(--color-border-strong\)/, `border-right 值漂移：${m[1]!.trim()}`);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(m[1]!) && !/rgba?\(/.test(m[1]!), 'border-right 被替换为硬编码色值');
});
check('P1-T3 AppHeader.vue .app-header 的 border-bottom 仍引 var(--color-border-strong)（1px 实线、无硬编码色）', () => {
  const src = readRel('src/renderer/components/layout/AppHeader.vue');
  const block = extractCssBlock(src, /^\.app-header \{/m, 'AppHeader .app-header');
  const m = /border-bottom:\s*([^;]+);/.exec(block);
  assert.ok(m, '.app-header 内整行 border-bottom 声明被删（分隔线契约面被拆）');
  assert.match(m[1]!, /1px\s+solid\s+var\(--color-border-strong\)/, `border-bottom 值漂移：${m[1]!.trim()}`);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(m[1]!) && !/rgba?\(/.test(m[1]!), 'border-bottom 被替换为硬编码色值');
});
check('P1-T3 TaskQueuePanel.vue .task-panel 的 border-left 仍引 var(--color-border-strong)（1px 实线、无硬编码色）', () => {
  const src = readRel('src/renderer/components/task/TaskQueuePanel.vue');
  const block = extractCssBlock(src, /^\.task-panel \{/m, 'TaskQueuePanel .task-panel');
  const m = /border-left:\s*([^;]+);/.exec(block);
  assert.ok(m, '.task-panel 内整行 border-left 声明被删（分隔线契约面被拆）');
  assert.match(m[1]!, /1px\s+solid\s+var\(--color-border-strong\)/, `border-left 值漂移：${m[1]!.trim()}`);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(m[1]!) && !/rgba?\(/.test(m[1]!), 'border-left 被替换为硬编码色值');
});

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n=== P1-T4 双链键集一致 + isDark 分流回退字面等价（H2） ===');

// 提取函数体内全部 setProperty('--color-*') 写入键（双链键集一致断言用）。
function extractWrittenTokens(fnBody: string): string[] {
  const tokens: string[] = [];
  const re = /setProperty\('(--[a-z0-9-]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fnBody)) !== null) tokens.push(m[1]!);
  return tokens;
}
/** 从源码截取自锚点行起的整个函数体（花括号配平；不跨入下一顶层声明）。 */
function extractFnBody(src: string, anchor: RegExp, label: string): string {
  const m = anchor.exec(src);
  assert.ok(m, `${label}：函数锚点未命中`);
  const open = src.indexOf('{', m.index);
  assert.ok(open !== -1, `${label}：锚点后无 {`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  assert.fail(`${label}：花括号未配平`);
}

const applyThemeBody = extractFnBody(readRel('src/renderer/utils/apply-theme.ts'), /export function applyThemePalette/, 'apply-theme.ts');
const cpBody = extractFnBody(readRel('src/renderer/pages/ConfigPage.vue'), /function applyTheme\(paletteId: string\)/, 'ConfigPage.vue');

// apply-theme.ts:4-7 注释清单规定的 14 变量全集（ConfigPage 副本强制同步口径）。
const FOURTEEN_NAMES = [
  '--color-bg', '--color-panel', '--color-panel-soft', '--color-border', '--color-border-strong',
  '--color-text', '--color-text-muted', '--color-text-sub', '--color-accent', '--color-accent-strong',
  '--color-on-accent', '--color-btn-ink', '--color-on-btn-ink', '--color-danger',
] as const;

check('P1-T4 apply-theme.ts 正式链回退为 isDark 分流形态（暗板 #3D444D / 浅板 rgba(0,0,0,0.12)，字段 borderStrong）', () => {
  assert.match(
    applyThemeBody,
    /setProperty\('--color-border-strong',\s*c\.borderStrong\s*\?\?\s*\(palette\.isDark\s*\?\s*'#3D444D'\s*:\s*'rgba\(0,\s*0,\s*0,\s*0\.12\)'\)\)/,
    '回退未按 isDark 分流（暗板缺省仍落黑上黑 = H1 防御失效）',
  );
});
check('P1-T4 ConfigPage.vue 本地副本写入集包含 --color-border-strong', () => {
  const tokens = extractWrittenTokens(cpBody);
  assert.ok(tokens.includes('--color-border-strong'), `副本写入集缺 --color-border-strong（实际 ${tokens.length} 个：${tokens.join(', ')}）`);
});
check('P1-T4 ConfigPage.vue 副本 border-strong 取值口径与正式链字面等价（同字段 + isDark 分流同两端点）', () => {
  assert.match(
    cpBody,
    /setProperty\('--color-border-strong',\s*palette\.colors\.borderStrong\s*\?\?\s*\(palette\.isDark\s*\?\s*'#3D444D'\s*:\s*'rgba\(0,\s*0,\s*0,\s*0\.12\)'\)\)/,
    '副本回退与正式链不同口径（缺 isDark 分流 / 字段或两端点字面漂移）',
  );
});
check('P1-T4 双链键集一致：副本 14 变量全集与 apply-theme.ts:4-7 注释清单一一对应', () => {
  const formal = [...new Set(extractWrittenTokens(applyThemeBody))].filter((t) => t.startsWith('--color-'));
  const copy = [...new Set(extractWrittenTokens(cpBody))].filter((t) => t.startsWith('--color-'));
  for (const n of FOURTEEN_NAMES) {
    assert.ok(formal.includes(n), `apply-theme.ts 正式链缺 ${n}`);
    assert.ok(copy.includes(n), `ConfigPage.vue 副本缺 ${n}（A1 起的同性质漏同步）`);
  }
  assert.strictEqual(copy.length, 14, `副本 --color-* 写入数 ${copy.length} ≠ 14（多写/少写均破双链键集一致）`);
  assert.deepStrictEqual([...copy].sort(), [...formal].sort(), `双链键集不一致：副本=${copy.join(',')} 正式链=${formal.join(',')}`);
});

// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
