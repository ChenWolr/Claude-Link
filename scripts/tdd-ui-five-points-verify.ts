// tdd-ui-five-points-verify.ts
// 2026-11-19 UI 五点批次 p5c「测试转写·跨点收尾」结构钉组（01-实现细节.md §7 建议形态）：
// P1~P4 实现的**源字面结构钉**——逐字面钉住本批落定的定值与声明，防后续重构静默漂移。
//
// 分层纪律（p5c 硬边界）：本脚本只钉**结构字面**（值级钉 + 声明级钉）；
//   · 数据/对比度契约（P1-T1 可解析性、P1-T2 对比度窗口 [1.10,2.00]）归 tdd-theme-separator-verify.ts；
//   · wiring/通道接线计数归 tdd-web-access-wiring-verify.ts（本脚本零重复）；
//   · active/hover 语义钉与零硬编码钉归 tdd-sidebar-card-outline-verify.ts / tdd-sidebar-card-pin-verify.ts
//     （本脚本对 session-card 只钉 R1 终版两行声明字面 + active 两行字面，与语义钉互补不重复）。
//
// 钉清单（对应 01 §7 建议行）：
//   ① 12 板 colors.borderStrong 字面 12 值逐一断言（含 inkstone #D5DAE1 不变）——值级钉，
//     比 P1-T1「存在且可解析」更严：谁改任一板定值（对比度仍可落窗内）即红。
//   ② 终端板 colors.border === '#30363D' 字面（P1/H1 暗板提亮定值，设计笔记 §1 修正记录）。
//   ③ apply-theme.ts 正式链 --color-border-strong isDark 分流回退字面（#3D444D / rgba(0,0,0,0.12)）。
//   ④ ConfigPage.vue 副本 14 变量键集断言（含 borderStrong/textSub/btnInk/onBtnInk 四个 A1 新增键）。
//   ⑤ .session-card 描边 var(--color-border) + 底 var(--color-panel-soft)（R1 panelSoft 方案）
//     + hover 换底 panel-soft + active 两行字面。
//   ⑥ .bubble--user / .bubble--assistant max-width 均 85% 双声明（P3）。
//   ⑦ ChatInput.vue max-height calc `* 8` 与注释算式一致（P4）。
// 形态对齐 scripts/tdd-chatinput-autosize-verify.ts：check() 计数、失败 exit 1。
// 运行：npx tsx scripts/tdd-ui-five-points-verify.ts（登记 scripts/selftest-static-list.txt 尾部）。

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { THEME_PALETTES } from '../src/shared/constants';

const repoRoot = path.resolve(__dirname, '..');
function readRel(p: string): string {
  return fs.readFileSync(path.join(repoRoot, p), 'utf8');
}

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message.split('\n')[0]}`); }
}

// ── ① 12 板 borderStrong 字面 12 值（定值唯一来源 = prototypes/translate-ui-design-notes.md §1 全表，
//      与 src/shared/constants.ts THEME_PALETTES 逐一对应；值级钉——P1 定稿后任一板字面漂移即红） ──
const BORDER_STRONG_LITERALS: Record<string, string> = {
  inkstone: '#D5DAE1',
  'warm-paper': '#D9D0C6',
  'grass-aroma': '#CFDAD1',
  coral: '#E0CFC3',
  contemplation: '#CBD1D8',
  absolutely: '#CFCBC2',
  'high-contrast': '#D6D0CD',
  'deep-think': '#D3D3DB',
  delve: '#D6D6D6',
  'new-warm-paper': '#C8C0B2',
  'quiet-console': '#D7D9DC',
  'terminal-pro': '#3D444D',
};

console.log('=== ① 12 板 borderStrong 字面 12 值逐一断言（值级钉，含 inkstone #D5DAE1 不变） ===');

check('THEME_PALETTES 恰为 12 套且 id 集合与钉表一致', () => {
  assert.equal(THEME_PALETTES.length, 12, `实际 ${THEME_PALETTES.length} 套`);
  const ids = THEME_PALETTES.map((p) => p.id).sort();
  assert.deepStrictEqual(ids, Object.keys(BORDER_STRONG_LITERALS).sort(), '板 id 集合与钉表漂移（新板须同步钉表）');
});
for (const palette of THEME_PALETTES) {
  const expect = BORDER_STRONG_LITERALS[palette.id]!;
  check(`${palette.id} colors.borderStrong === ${expect}`, () => {
    assert.equal(palette.colors.borderStrong, expect, `${palette.id} borderStrong 漂移（期望钉表值 ${expect}）`);
  });
}
check('inkstone borderStrong === #D5DAE1（官方已定义值不变——P1 唯一保留板）', () => {
  assert.equal(BORDER_STRONG_LITERALS.inkstone, '#D5DAE1', '钉表 inkstone 值被改');
  assert.equal(THEME_PALETTES.find((p) => p.id === 'inkstone')?.colors.borderStrong, '#D5DAE1');
});

console.log('\n=== ② 终端板 colors.border === #30363D 字面（P1/H1 暗板提亮定值） ===');
check("terminal-pro colors.border === '#30363D'（对齐 GitHub Dark border-default 量级）", () => {
  const terminal = THEME_PALETTES.find((p) => p.id === 'terminal-pro');
  assert.ok(terminal, 'terminal-pro 板缺失');
  assert.equal(terminal.colors.border, '#30363D', `终端板 border=${terminal.colors.border} ≠ #30363D（暗板提亮定值漂移）`);
});

console.log('\n=== ③ apply-theme.ts 正式链 isDark 分流回退字面 ===');
check("apply-theme.ts --color-border-strong 回退 = c.borderStrong ?? (isDark ? '#3D444D' : 'rgba(0, 0, 0, 0.12)')", () => {
  const src = readRel('src/renderer/utils/apply-theme.ts');
  assert.ok(
    src.includes("root.style.setProperty('--color-border-strong', c.borderStrong ?? (palette.isDark ? '#3D444D' : 'rgba(0, 0, 0, 0.12)'))"),
    '正式链 border-strong 回退未按 isDark 分流字面（暗板 #3D444D / 浅板 rgba(0,0,0,0.12)）',
  );
});

console.log('\n=== ④ ConfigPage.vue 副本 14 变量键集（含 borderStrong/textSub/btnInk/onBtnInk） ===');
// 从副本函数体提取全部 setProperty 键（tdd-theme-separator-verify extractWrittenTokens 同口径）。
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
const cpBody = extractFnBody(readRel('src/renderer/pages/ConfigPage.vue'), /function applyTheme\(paletteId: string\)/, 'ConfigPage.vue');
const cpTokens = [...cpBody.matchAll(/setProperty\('(--[a-z0-9-]+)'/g)].map((m) => m[1]!);

const FOURTEEN_KEYS = [
  '--color-bg', '--color-panel', '--color-panel-soft', '--color-border', '--color-border-strong',
  '--color-text', '--color-text-muted', '--color-text-sub', '--color-accent', '--color-accent-strong',
  '--color-on-accent', '--color-btn-ink', '--color-on-btn-ink', '--color-danger',
] as const;
check('ConfigPage.vue 副本写入恰 14 个 --color-* 变量键（多写/少写均破双链键集）', () => {
  const colorTokens = [...new Set(cpTokens)].filter((t) => t.startsWith('--color-'));
  assert.equal(colorTokens.length, 14, `副本写入 ${colorTokens.length} 个（≠14）：${colorTokens.join(', ')}`);
});
for (const key of ['--color-border-strong', '--color-text-sub', '--color-btn-ink', '--color-on-btn-ink'] as const) {
  check(`ConfigPage.vue 副本键集含 ${key}`, () => {
    assert.ok(cpTokens.includes(key), `副本缺 ${key}（A1/P1 双链同步漏键）`);
  });
}
check('副本键集与 apply-theme.ts 正式链 14 键逐一对应', () => {
  const applyBody = extractFnBody(readRel('src/renderer/utils/apply-theme.ts'), /export function applyThemePalette/, 'apply-theme.ts');
  const formal = [...new Set([...applyBody.matchAll(/setProperty\('(--[a-z0-9-]+)'/g)].map((m) => m[1]!))].filter((t) => t.startsWith('--color-'));
  const copy = [...new Set(cpTokens)].filter((t) => t.startsWith('--color-'));
  assert.deepStrictEqual([...copy].sort(), [...formal].sort(), `双链键集不一致：副本=${copy.join(',')} 正式链=${formal.join(',')}`);
  assert.deepStrictEqual([...copy].sort(), [...FOURTEEN_KEYS].sort(), '键集 ≠ 14 变量注释清单');
});

console.log('\n=== ⑤ .session-card 描边/底/hover/active 声明字面（R1 panelSoft 方案） ===');
const sidebarSrc = readRel('src/renderer/components/layout/AppSidebar.vue');
// .session-card 基座块（顶层两个 .session-card {：入场动画块/基座块——以含 background 辨认，
// tdd-sidebar-card-outline-verify baseCardBlock 同口径）。
function blockFrom(src: string, startIdx: number): string {
  const open = src.indexOf('{', startIdx);
  assert.ok(open > -1, '锚点后未找到 {');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  assert.fail('花括号不配平');
}
function baseCardBlock(src: string): string {
  let from = 0;
  for (;;) {
    const idx = src.indexOf('.session-card {', from);
    assert.ok(idx > -1, '未找到含 background 的 .session-card 基座块');
    const block = blockFrom(src, idx);
    if (/\bbackground\s*:/.test(block)) return block;
    from = idx + 1;
  }
}
const base = baseCardBlock(sidebarSrc);
check('.session-card 描边 = border: 1px solid var(--color-border)', () => {
  assert.ok(base.includes('border: 1px solid var(--color-border);'), '基座描边字面漂移（透明描边 = P2 主缺陷复活）');
  assert.ok(!/border:[^;]*transparent/.test(base), '描边回退 transparent');
});
check('.session-card 底色 = background: var(--color-panel-soft)', () => {
  assert.ok(base.includes('background: var(--color-panel-soft);'), '基座底色字面漂移（panel 同底 = 轮廓不可见）');
});
check('.session-card:hover 换底 = text 4% 混色 × panel-soft（hover 换底 panel-soft 家族）', () => {
  const idx = sidebarSrc.indexOf('.session-card:hover {');
  assert.ok(idx > -1, 'hover 规则缺失');
  const hover = blockFrom(sidebarSrc, idx);
  assert.ok(
    hover.includes('background: color-mix(in srgb, var(--color-text) 4%, var(--color-panel-soft));'),
    'hover 换底未落在 panel-soft 家族（R1 终版公式漂移）',
  );
});
check('.session-card.active 两行字面：accent 8% 混色底 + accent 45% 混色描边', () => {
  const idx = sidebarSrc.indexOf('.session-card.active {');
  assert.ok(idx > -1, 'active 规则缺失');
  const active = blockFrom(sidebarSrc, idx);
  assert.ok(
    active.includes('background: color-mix(in srgb, var(--color-accent) 8%, var(--color-panel-soft));'),
    'active 底色字面漂移',
  );
  assert.ok(
    active.includes('border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);'),
    'active 描边字面漂移',
  );
});

console.log('\n=== ⑥ .bubble--user / .bubble--assistant max-width 均 85%（P3 双声明） ===');
const bubbleSrc = readRel('src/renderer/components/chat/MessageBubble.vue');
function maxWidthOf(src: string, selector: string): string {
  const idx = src.indexOf(selector);
  assert.ok(idx > -1, `选择器 ${selector} 缺失`);
  const block = blockFrom(src, idx);
  const m = block.match(/max-width:\s*([^\s;]+);/);
  assert.ok(m, `${selector} 缺 max-width 声明`);
  return m[1]!;
}
check('.bubble--user max-width === 85%', () => {
  assert.equal(maxWidthOf(bubbleSrc, '.bubble--user {'), '85%', 'user 气泡宽度漂移（旧 80% 口径复活）');
});
check('.bubble--assistant max-width === 85%', () => {
  assert.equal(maxWidthOf(bubbleSrc, '.bubble--assistant {'), '85%', 'assistant 气泡宽度漂移（参照锚点失守）');
});
check('双声明字面一致（均 85%，折行点对齐的核心契约）', () => {
  const u = maxWidthOf(bubbleSrc, '.bubble--user {');
  const a = maxWidthOf(bubbleSrc, '.bubble--assistant {');
  assert.equal(u, a, `user(${u}) ≠ assistant(${a})`);
});

console.log('\n=== ⑦ ChatInput.vue max-height calc `* 8` 与注释算式一致（P4） ===');
const chatInputSrc = readRel('src/renderer/components/chat/ChatInput.vue');
check('声明字面：max-height: calc(0.875rem * 1.5 * 8 + 22px)', () => {
  assert.ok(chatInputSrc.includes('max-height: calc(0.875rem * 1.5 * 8 + 22px)'), '8 行封顶算式声明缺失/漂移');
  assert.ok(!chatInputSrc.includes('* 4 + 22px'), '旧 4 行字面 `* 4 + 22px` 残留');
});
check('注释算式与声明字面一致（同一 calc 字面在注释中出现）', () => {
  const rule = chatInputSrc.match(/textarea \{[^}]*\}/)?.[0] ?? '';
  assert.ok(rule.includes('calc(0.875rem * 1.5 * 8 + 22px)'), 'textarea 规则块内注释算式与声明字面不一致');
});

console.log(`\n===== tdd-ui-five-points-verify: ${pass} pass / ${fail} fail =====`);
if (fail > 0) process.exit(1);
