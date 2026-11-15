// tdd-tokens-inkstone-verify.ts
// A 令牌层契约脚本 · A1「墨石第 12 套色板接入 + 设为默认 + 存量 warm-paper 一次性迁移」
// ＋ A2「主按钮 ink 语义对静态声明 + 11 旧板回退断言收口」
// （slate-ui-completion-1108-1428 round-001 点 A1/A2；用例正本 = docs/ui-completion/tests/A-tokens-cases.md
//   §A1 A1-1～A1-11 / §A2 A2-1～A2-6，执行侧裁决回填见 docs/plans/2026-11-08-slate-ui-completion-implementation-plan.md §2 A 组）：
//   · A1-1  第 12 套接入：length===12 + 以 name:'墨石' 为锚定位（条目 id 字面与数组位置不钉）；
//   · A1-2  墨石 11 个 --color-* 命名取值逐项钉（isDark=false；9 个必填字面 + textSub/borderStrong
//           经接口可选字段落点，值必须可定位）；
//   · A1-3  裁决改写（计划 §2 A 组①③）：条件断言——墨石生效下 danger=#DC2626 命中自墨石对象字段；
//           旧板下 variables.css 语义四色全局静态保持现状值（不更新、不换族）；
//   · A1-4  DEFAULT_THEME_PALETTE_ID === 墨石条目 id（取锚定条目比对，防常量与条目脱钩）；
//   · A1-6  双映射完整性：apply-theme.ts 与 ConfigPage.vue 本地副本对全部 14 个命名全覆盖
//           （既有 10 命名零删改 + 新增 4 命名两处同步 + ?? 回退形态字面 + 无条件写入）；
//   · A1-7  11 套旧板零改动钉：冻结期望表（由 baseline-A1 快照程序生成后内嵌，见 FROZEN_OLD_PALETTES）
//           deepEqual + terminal-pro isDark 豁免 + variables.css 旧板回退静态值未删改（含色板静态组
//           维持暖纸现状 = 裁决①）；
//   · A1-9  字号三档结构钉（App.vue applyFontScale 接线 + FONT_SCALE_SIZES 14/16/18）；
//   · A1-10 注册存在：selftest-static-list.txt + tsconfig.tdd.json include 两处均在；
//   · A1-11 既有数量契约同步：selftest-settings-mapping 数量钉 12 + 深色豁免分支自洽；
//           tdd-sidebar-structure-verify R3.3/R3.4 同步字面；
//   · 迁移钉（裁决②，A1-8 增补）：config-manager.ts 读路径 warm-paper→默认 内存映射字面（不写回）；
//   · CDP 侧（A1-5/A1-8/A1-9 行为面）落点 scripts/cdp-layout-e2e.mjs 的 A1 场景组
//     （S1 全新配置默认墨石 / S2 预置 warm-paper 迁移 / S3 预置 quiet-console 不被覆盖），
//     本脚本以字面存在钉守护该扩展不被静默拆链。
// A2 小节（点 A2，2026-11-08 增）：
//   · A2-1 ink 语义对静态声明（variables.css :root，var(--color-accent)/var(--color-on-accent) 形态、
//           落点在 --color-danger 组之后）+ 墨石取值（#17181A/#FFFFFF）+ apply-theme.ts 与
//           ConfigPage.vue applyTheme 副本均无条件写入（行首裸语句 + 花括号深度=1 双断言，无 if 包裹）；
//   · A2-2 11 旧板逐板回退解析 = 改版前 accent/onAccent（冻结表逐板比对，btnInk??accent 回退语义）；
//   · A2-3/A2-4 消费方（.new-button / chat-send-button）切片零硬编码 hex 负断言
//           （防倒退钉：E1/B6 ink 化时必须走 var(--color-*) token；现状即满足、转写即绿属预期）；
//   · A2-5 disabled 结构钉（ChatInput button:disabled 含 opacity<1 可计算差异）；
//   · A2-6 纯计算对比度：墨石 onBtnInk on btnInk ≥4.5:1（AA 口径）；
//   · CDP 行为面（A2-1/A2-2/A2-5 裁决口径：断言 documentElement 上 ink 对变量的解析值
//           ——墨石 rgb(23,24,26)/rgb(255,255,255)、切暖纸/静默/终端=各板 accent/onAccent 值且
//           无 #17181A 残留，**不断言**发送钮/新会话钮元素 computed——落点 cdp-layout-e2e.mjs
//     A2 场景组，本脚本以标记存在钉守护该扩展不被静默拆链。
// A3 小节（点 A3，2026-11-08 增；A3-3/A3-4 消费者侧断言原推迟到 C1 点转写，已随 C1 落地补写于本组内）：
//   · A3-1 两值命中：variables.css :root 存在 --color-bubble-user-bg: #D9E9ED 与
//           --color-bubble-user-ink: #17181A 字面值声明（非 var 派生），落点紧随 btn-ink 组，
//           注释注明「不随色板、禁止加入 ThemePalette 接口与 apply-theme 写入链」；
//   · A3-2 机制负断言：12 板对象（THEME_PALETTES 序列化）内无 #D9E9ED、constants.ts 无
//           bubble-user/bubbleUser 字样、apply-theme.ts 与 ConfigPage.vue 写板链不含该 token；
//   · A3-5 导出路径同源：export-runner.ts / 主窗口 App.vue 无独立 #D9E9ED/#17181A 字面、
//           无 bubble-user 本地复制（唯一落点=variables.css token）；
//   · A3-6 #17181A on #D9E9ED 对比度 ≥7:1（AAA，相对亮度公式纯计算，值取自 variables.css 字面）；
//   · CDP 行为面（A3 三板恒定裁决口径：断言 token raw 变量值 + documentElement inline 零写入，
//           **不断言** .bubble--user 元素 computed——C1 落地前仍 accent 派生——落点
//     cdp-layout-e2e.mjs A3 场景组，本脚本以标记存在钉守护该扩展不被静默拆链。
// 形态对齐 tdd-preview-outside-root-verify.ts：check/checkAsync、readRel、头注释、
// `结果：N 通过 / M 失败` 末行、fail>0 则 process.exit(1)。禁改被测模块源码（本脚本自身不含实现）。
// 运行：npx tsx scripts/tdd-tokens-inkstone-verify.ts（已登记 scripts/selftest-static-list.txt）

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_THEME_PALETTE_ID, FONT_SCALE_SIZES, THEME_PALETTES, type ThemePalette } from '../src/shared/constants';

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

// ── A1-7 冻结期望表：由 .plan-loop/.../baseline-A1/src/shared/constants.ts（改版前快照）程序生成
//    （生成器 .plan-loop/.../round-001/gen-stub/gen-frozen.ts，生成于实施前、逐字节未手改）。
//    除墨石外的 11 套旧板 id/name/isDark/colors 与改版前逐字一致——新增/改动旧板任一字段本钉即红。
const FROZEN_OLD_PALETTES: ThemePalette[] = [
  { id: 'warm-paper', name: '暖纸', isDark: false, colors: { bg: '#F8F4ED', panel: '#F4F0EA', panelSoft: '#FCFAF5', border: 'rgba(122,96,88,0.18)', text: '#3B3D3F', textMuted: '#6A6C70', accent: '#537D96', accentStrong: '#456A80', onAccent: '#FFFFFF', danger: '#8B3A3A' } },
  { id: 'grass-aroma', name: '草香', isDark: false, colors: { bg: '#F5F8F3', panel: '#EFF3EC', panelSoft: '#F9FBF7', border: 'rgba(91,168,140,0.22)', text: '#2E3832', textMuted: '#68706D', accent: '#5BA88C', accentStrong: '#4D9179', onAccent: '#1A1A1A', danger: '#8B4A3A' } },
  { id: 'coral', name: '珊瑚', isDark: false, colors: { bg: '#FDF6EC', panel: '#FCF1E4', panelSoft: '#FFFBF3', border: 'rgba(243,126,99,0.18)', text: '#1A3049', textMuted: '#646F78', accent: '#1A3049', accentStrong: '#243A55', onAccent: '#FFFFFF', danger: '#A3483B' } },
  { id: 'contemplation', name: '沉思', isDark: false, colors: { bg: '#F3F5F7', panel: '#ECEFF2', panelSoft: '#F8F9FB', border: 'rgba(126,153,168,0.22)', text: '#2C3238', textMuted: '#676E75', accent: '#7E99A8', accentStrong: '#6B8594', onAccent: '#1A1A1A', danger: '#8B4040' } },
  { id: 'absolutely', name: '绝对', isDark: false, colors: { bg: '#F4F3EE', panel: '#EDEAE2', panelSoft: '#FAF9F5', border: 'rgba(177,173,161,0.28)', text: '#2D2B28', textMuted: '#6E6B68', accent: '#B5846E', accentStrong: '#A27460', onAccent: '#1A1A1A', danger: '#8B3A3A' } },
  { id: 'high-contrast', name: '素白', isDark: false, colors: { bg: '#FAF8F7', panel: '#F3F1F0', panelSoft: '#FDFBFA', border: 'rgba(92,75,70,0.22)', text: '#1A1C1E', textMuted: '#6B6F73', accent: '#3A6B85', accentStrong: '#2E5870', onAccent: '#FFFFFF', danger: '#7A3030' } },
  { id: 'deep-think', name: '深思', isDark: false, colors: { bg: '#FCFCFD', panel: '#F0F0F2', panelSoft: '#F8F8FA', border: 'rgba(0,0,0,0.09)', text: '#1D1D1F', textMuted: '#717176', accent: '#636AE8', accentStrong: '#5158D4', onAccent: '#FFFFFF', danger: '#8B3A3A' } },
  { id: 'delve', name: '纯白', isDark: false, colors: { bg: '#FFFFFF', panel: '#F0F0F0', panelSoft: '#F7F7F8', border: 'rgba(0,0,0,0.10)', text: '#1A1A1A', textMuted: '#727272', accent: '#1A1A1A', accentStrong: '#000000', onAccent: '#FFFFFF', danger: '#8B3A3A' } },
  { id: 'new-warm-paper', name: '新暖纸', isDark: false, colors: { bg: '#F5EFE4', panel: '#EFE8DB', panelSoft: '#FBF7EE', border: '#D8CFBE', text: '#2A2622', textMuted: '#6B6158', accent: '#537D96', accentStrong: '#3F6179', onAccent: '#FFFFFF', danger: '#8B2C1F' } },
  { id: 'quiet-console', name: '静默', isDark: false, colors: { bg: '#F6F7F8', panel: '#FFFFFF', panelSoft: '#FAFBFC', border: 'rgba(0,0,0,0.09)', text: '#1A1D21', textMuted: '#6B7280', accent: '#1A1D21', accentStrong: '#000000', onAccent: '#FFFFFF', danger: '#DC2626' } },
  { id: 'terminal-pro', name: '终端', isDark: true, colors: { bg: '#0F1115', panel: '#14171C', panelSoft: '#1B2027', border: '#23272F', text: '#D3D8E0', textMuted: '#9AA3B2', accent: '#4EA1FF', accentStrong: '#7FBAFF', onAccent: '#0B1220', danger: '#E5484D' } },
];

const ink = THEME_PALETTES.find((p) => p.name === '墨石');

console.log('=== A1 墨石色板令牌层契约（A1-1～A1-11） ===');

// ── A1-1 第 12 套接入（以中文名锚定，不钉 id 字面/数组位置）──
check('A1-1 THEME_PALETTES 恰为 12 套', () => {
  assert.strictEqual(THEME_PALETTES.length, 12, `实际 ${THEME_PALETTES.length} 套`);
});
check('A1-1 存在中文名「墨石」的色板条目', () => {
  assert.ok(ink, '未找到 name === \'墨石\' 的条目');
});

// ── A1-2 墨石 11 个命名取值逐项钉（落点：接口可选字段 textSub/borderStrong）──
check('A1-2 墨石 isDark=false（浅色板）', () => {
  assert.strictEqual(ink?.isDark, false, `实际 ${String(ink?.isDark)}`);
});
check('A1-2 墨石 9 个必填色值逐字命中（bg/panel/panelSoft/border/text/textMuted/accent/accentStrong/onAccent/danger）', () => {
  assert.strictEqual(ink?.colors.bg, '#EFF1F4', `bg 实际 ${ink?.colors.bg}`);
  assert.strictEqual(ink?.colors.panel, '#F6F7F9', `panel 实际 ${ink?.colors.panel}`);
  assert.strictEqual(ink?.colors.panelSoft, '#FFFFFF', `panelSoft 实际 ${ink?.colors.panelSoft}`);
  assert.strictEqual(ink?.colors.border, '#E4E7EC', `border 实际 ${ink?.colors.border}`);
  assert.strictEqual(ink?.colors.text, '#17181A', `text 实际 ${ink?.colors.text}`);
  assert.strictEqual(ink?.colors.textMuted, '#667085', `textMuted 实际 ${ink?.colors.textMuted}`);
  assert.strictEqual(ink?.colors.accent, '#EA580C', `accent 实际 ${ink?.colors.accent}`);
  assert.strictEqual(ink?.colors.accentStrong, '#C2410C', `accentStrong 实际 ${ink?.colors.accentStrong}`);
  assert.strictEqual(ink?.colors.onAccent, '#FFFFFF', `onAccent 实际 ${ink?.colors.onAccent}`);
  assert.strictEqual(ink?.colors.danger, '#DC2626', `danger 实际 ${ink?.colors.danger}`);
});
check('A1-2 text-sub=#5B6779（接口可选字段落点，值可定位）', () => {
  assert.ok('textSub' in (ink?.colors ?? {}), 'colors 上不存在 textSub 字段（落点缺失且无等价落点）');
  assert.strictEqual(ink?.colors.textSub, '#5B6779', `textSub 实际 ${ink?.colors.textSub}`);
});
check('A1-2 border-strong=#D5DAE1（接口可选字段落点，值可定位）', () => {
  assert.ok('borderStrong' in (ink?.colors ?? {}), 'colors 上不存在 borderStrong 字段（落点缺失且无等价落点）');
  assert.strictEqual(ink?.colors.borderStrong, '#D5DAE1', `borderStrong 实际 ${ink?.colors.borderStrong}`);
});
check('A1-2 墨石 btnInk=#17181A / onBtnInk=#FFFFFF（A2 ink 对随板字段）', () => {
  assert.strictEqual(ink?.colors.btnInk, '#17181A', `btnInk 实际 ${ink?.colors.btnInk}`);
  assert.strictEqual(ink?.colors.onBtnInk, '#FFFFFF', `onBtnInk 实际 ${ink?.colors.onBtnInk}`);
});

// ── A1-3 裁决改写：条件断言（墨石生效下 danger 命中自对象字段；旧板下全局静态保持现状）──
check('A1-3a 墨石生效下 danger=#DC2626 命中自墨石对象字段（palette 驱动写入链存在）', () => {
  assert.strictEqual(ink?.colors.danger, '#DC2626');
  const applyTheme = readRel('src/renderer/utils/apply-theme.ts');
  assert.ok(applyTheme.includes("setProperty('--color-danger', c.danger)"), 'apply-theme 未把 c.danger 写入 --color-danger');
});
check('A1-3b 旧板下 variables.css 语义四色全局静态保持现状值（#4A9E5E/#C05656/#C9A227/#3B7DD8，裁决①不更新）', () => {
  const vars = readRel('src/renderer/assets/styles/variables.css');
  assert.match(vars, /--color-success:\s*#4A9E5E/i, 'success 静态值被改动（裁决①要求维持现状）');
  assert.match(vars, /--color-fail:\s*#C05656/i, 'fail 静态值被改动（裁决①要求维持现状）');
  assert.match(vars, /--color-warn:\s*#C9A227/i, 'warn 静态值被改动（裁决①要求维持现状）');
  assert.match(vars, /--color-info:\s*#3B7DD8/i, 'info 静态值被改动（裁决①要求维持现状）');
  // -strong 变体维持现状（裁决③）
  assert.match(vars, /--color-success-strong:\s*#2E7D46/i);
  assert.match(vars, /--color-fail-strong:\s*#8B3A3A/i);
  assert.match(vars, /--color-warn-strong:\s*#8A6D2B/i);
  assert.match(vars, /--color-info-strong:\s*#2563EB/i);
});

// ── A1-4 默认色板指向墨石（与锚定条目 id 比对，防脱钩）──
check('A1-4 DEFAULT_THEME_PALETTE_ID === 墨石条目 id', () => {
  assert.ok(ink, '墨石条目缺失');
  assert.strictEqual(DEFAULT_THEME_PALETTE_ID, ink.id, `实际 ${DEFAULT_THEME_PALETTE_ID}`);
});

// ── A1-6 双映射完整性（14 命名 × apply-theme.ts + ConfigPage.vue；既有 10 命名零删改）──
const FOURTEEN_NAMES = [
  '--color-bg', '--color-panel', '--color-panel-soft', '--color-border', '--color-border-strong',
  '--color-text', '--color-text-muted', '--color-text-sub', '--color-accent', '--color-accent-strong',
  '--color-on-accent', '--color-btn-ink', '--color-on-btn-ink', '--color-danger',
] as const;
check('A1-6 apply-theme.ts setProperty 覆盖全部 14 个命名', () => {
  const src = readRel('src/renderer/utils/apply-theme.ts');
  for (const n of FOURTEEN_NAMES) {
    assert.ok(src.includes(`setProperty('${n}'`), `apply-theme.ts 缺 ${n}`);
  }
});
check('A1-6 ConfigPage.vue 本地 applyTheme 副本同步覆盖全部 14 个命名', () => {
  const cp = readRel('src/renderer/pages/ConfigPage.vue');
  for (const n of FOURTEEN_NAMES) {
    assert.ok(cp.includes(`setProperty('${n}'`), `ConfigPage.vue 缺 ${n}`);
  }
});
check('A1-6 新增 4 命名的 ?? 回退形态字面两处同步（无条件写入，非 if 分支）', () => {
  const applyTheme = readRel('src/renderer/utils/apply-theme.ts');
  const cp = readRel('src/renderer/pages/ConfigPage.vue');
  assert.ok(applyTheme.includes("c.borderStrong ?? 'rgba(0, 0, 0, 0.12)'"), 'apply-theme 缺 borderStrong 回退字面');
  assert.ok(applyTheme.includes('c.textSub ?? c.textMuted'), 'apply-theme 缺 textSub 回退形态');
  assert.ok(applyTheme.includes('c.btnInk ?? c.accent'), 'apply-theme 缺 btnInk 回退形态');
  assert.ok(applyTheme.includes('c.onBtnInk ?? c.onAccent'), 'apply-theme 缺 onBtnInk 回退形态');
  assert.ok(cp.includes("palette.colors.borderStrong ?? 'rgba(0, 0, 0, 0.12)'"), 'ConfigPage 缺 borderStrong 回退字面');
  assert.ok(cp.includes('palette.colors.textSub ?? palette.colors.textMuted'), 'ConfigPage 缺 textSub 回退形态');
  assert.ok(cp.includes('palette.colors.btnInk ?? palette.colors.accent'), 'ConfigPage 缺 btnInk 回退形态');
  assert.ok(cp.includes('palette.colors.onBtnInk ?? palette.colors.onAccent'), 'ConfigPage 缺 onBtnInk 回退形态');
});

// ── A1-7 11 套旧板零改动钉（冻结表 deepEqual，相对顺序保持）──
check('A1-7 除墨石外 11 套旧板 id/name/isDark/colors 与改版前逐字一致（冻结表 deepEqual）', () => {
  const oldPalettes = THEME_PALETTES.filter((p) => p.name !== '墨石');
  assert.strictEqual(oldPalettes.length, 11, `旧板数量 ${oldPalettes.length}（应为 11）`);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(oldPalettes)),
    JSON.parse(JSON.stringify(FROZEN_OLD_PALETTES)),
    '旧板集合与冻结期望表不一致（新增墨石时顺手改了旧板 / 或误删误序）',
  );
});
check('A1-7 深色豁免自洽：terminal-pro isDark=true、其余 11 套 isDark=false', () => {
  for (const p of THEME_PALETTES) {
    if (p.id === 'terminal-pro') assert.strictEqual(p.isDark, true, 'terminal-pro 应为深色');
    else assert.strictEqual(p.isDark, false, `${p.id} 应为浅色`);
  }
});
check('A1-7 variables.css 旧板回退静态值未删改（--color-border-strong rgba(0,0,0,0.12) 等）', () => {
  const vars = readRel('src/renderer/assets/styles/variables.css');
  assert.match(vars, /--color-border-strong:\s*rgba\(0,\s*0,\s*0,\s*0\.12\)/, 'border-strong 静态回退值被删改');
});
check('A1-7 variables.css 色板静态组维持暖纸现状（裁决①：不对齐墨石）', () => {
  const vars = readRel('src/renderer/assets/styles/variables.css');
  assert.match(vars, /--color-bg:\s*#F8F4ED/i, '静态 bg 被改为墨石值（裁决①要求保持暖纸）');
  assert.match(vars, /--color-accent:\s*#537D96/i, '静态 accent 被改为墨石值（裁决①要求保持暖纸）');
  assert.match(vars, /--color-text:\s*#3B3D3F/i, '静态 text 被改为墨石值（裁决①要求保持暖纸）');
});

// ── A1-9 字号三档结构钉（接线与三档表不受墨石接入影响）──
check('A1-9 App.vue 保留 applyFontScale 接线调用', () => {
  const app = readRel('src/renderer/App.vue');
  assert.match(app, /applyFontScale\(/, 'App.vue applyFontScale 调用被删');
});
check('A1-9 FONT_SCALE_SIZES 三档表 small=14px/medium=16px/large=18px 完好', () => {
  assert.strictEqual(FONT_SCALE_SIZES.small, '14px');
  assert.strictEqual(FONT_SCALE_SIZES.medium, '16px');
  assert.strictEqual(FONT_SCALE_SIZES.large, '18px');
});

// ── A1-9/A1-5/A1-8 CDP 侧扩展存在钉（落点 scripts/cdp-layout-e2e.mjs A1 场景组）──
check('A1-5/A1-8/A1-9 cdp-layout-e2e.mjs 含 A1 场景组（S1 默认墨石 / S2 warm-paper 迁移 / S3 quiet-console 保持 / large 档字号）', () => {
  const cdp = readRel('scripts/cdp-layout-e2e.mjs');
  assert.ok(cdp.includes('A1-5'), 'cdp-layout-e2e.mjs 缺 A1-5 场景标记');
  assert.ok(cdp.includes('A1-8'), 'cdp-layout-e2e.mjs 缺 A1-8 场景标记');
  assert.ok(cdp.includes('A1-9'), 'cdp-layout-e2e.mjs 缺 A1-9 场景标记');
  assert.ok(cdp.includes('warm-paper'), 'cdp-layout-e2e.mjs 缺 warm-paper 迁移预置');
  assert.ok(cdp.includes('quiet-console'), 'cdp-layout-e2e.mjs 缺 quiet-console 保持预置');
  assert.ok(cdp.includes('--user-data-dir'), 'cdp-layout-e2e.mjs A1 场景未隔离 user-data-dir');
});

// ── 迁移钉（裁决②：config-manager.ts 读路径 warm-paper→默认，内存映射不写回）──
check('迁移钉 config-manager.ts 读路径 warm-paper 一次性映射到默认（其余存值原样、不写回）', () => {
  const cm = readRel('src/main/modules/config-manager.ts');
  assert.match(cm, /themePaletteId[\s\S]{0,400}?config\.themePaletteId === 'warm-paper'/, '读路径缺 warm-paper 映射判定');
  assert.match(cm, /=== 'warm-paper'[\s\S]{0,200}\? DEFAULT_THEME_PALETTE_ID/, 'warm-paper 命中未映射到 DEFAULT_THEME_PALETTE_ID');
});

// ── A1-10 注册存在（链路失守防护）──
check('A1-10 selftest-static-list.txt 已登记本脚本', () => {
  const list = readRel('scripts/selftest-static-list.txt');
  assert.ok(
    list.split(/\r?\n/).map((l) => l.trim()).includes('scripts/tdd-tokens-inkstone-verify.ts'),
    '清单未登记 scripts/tdd-tokens-inkstone-verify.ts',
  );
});
check('A1-10 tsconfig.tdd.json include 含本脚本', () => {
  const tsconfig = readRel('tsconfig.tdd.json');
  assert.ok(tsconfig.includes('scripts/tdd-tokens-inkstone-verify.ts'), 'tsconfig.tdd.json include 未收纳本脚本');
});

// ── A1-11 既有数量契约同步为 12 ──
check('A1-11 selftest-settings-mapping 数量钉已同步为 12 + 深色豁免分支保留', () => {
  const mapping = readRel('scripts/selftest-settings-mapping.ts');
  assert.match(mapping, /THEME_PALETTES\.length === 12/, '数量钉仍为旧值（未同步 12 套）');
  assert.ok(
    mapping.includes("'terminal-pro' ? p.isDark === true : p.isDark === false"),
    '缺 terminal-pro 深色豁免分支',
  );
});
check('A1-11 tdd-sidebar-structure-verify R3.3/R3.4 同步（墨石居首链 + 数量 regex 12）', () => {
  const sidebar = readRel('scripts/tdd-sidebar-structure-verify.ts');
  assert.match(sidebar, /inkIdx\s*<\s*wpIdx/, 'R3.3 缺 inkIdx<wpIdx 顺序链');
  assert.match(sidebar, /wpIdx\s*<\s*qcIdx\s*&&\s*qcIdx\s*<\s*tpIdx/, 'R3.3 缺 wpIdx<qcIdx<tpIdx 顺序链');
  assert.match(sidebar, /THEME_PALETTES\\.length === 12/, 'R3.4 数量 regex 未同步为 12');
});
check('A1-11 inkstone 对象未染指旧板字段（textSub/borderStrong/btnInk/onBtnInk 仅墨石携带）', () => {
  const oldPalettes = THEME_PALETTES.filter((p) => p.name !== '墨石');
  for (const p of oldPalettes) {
    assert.ok(!('textSub' in p.colors), `${p.id} 误染 textSub`);
    assert.ok(!('borderStrong' in p.colors), `${p.id} 误染 borderStrong`);
    assert.ok(!('btnInk' in p.colors), `${p.id} 误染 btnInk`);
    assert.ok(!('onBtnInk' in p.colors), `${p.id} 误染 onBtnInk`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// A2 主按钮 ink 语义对（slate-ui-completion-1108-1428 点 A2；A-tokens-cases.md §A2 A2-1～A2-6）
// ══════════════════════════════════════════════════════════════════════════════

// 无条件写入断言器：行首裸语句形态 + 花括号深度=1 双断言——任何 `if (...) { setProperty }` 包裹
// 会使深度 ≥2，单行 `if (...) setProperty` 会使行首非 root.style.setProperty，两形态分别被两条子断言命中。
function assertUnconditionalWrite(src: string, fnAnchor: RegExp, token: string, label: string): void {
  const m = fnAnchor.exec(src);
  assert.ok(m, `${label}：函数锚点未命中`);
  const rest = src.slice(m.index);
  const occ = rest.indexOf(`setProperty('${token}'`);
  assert.ok(occ !== -1, `${label}：缺 ${token} 写入`);
  const lineStart = rest.lastIndexOf('\n', occ) + 1;
  const nl = rest.indexOf('\n', occ);
  const line = rest.slice(lineStart, nl === -1 ? rest.length : nl).trim();
  assert.ok(
    line.startsWith(`root.style.setProperty('${token}'`),
    `${label}：${token} 写入行非裸语句（行首=${line.slice(0, 56)}…）`,
  );
  const body = rest.slice(rest.indexOf('{'), occ);
  let depth = 0;
  for (const ch of body) { if (ch === '{') depth++; else if (ch === '}') depth--; }
  assert.strictEqual(depth, 1, `${label}：${token} 写入处于嵌套块内（深度 ${depth} ≠ 1，疑被 if/块包裹）`);
}

console.log('\n=== A2 主按钮 ink 语义对契约（A2-1～A2-6） ===');

// ── A2-1 ink 语义对静态声明（variables.css :root；裁决落点：--color-danger 组之后）──
check('A2-1 variables.css :root 存在 --color-btn-ink: var(--color-accent) 静态声明（落点在 --color-danger 组之后）', () => {
  const vars = readRel('src/renderer/assets/styles/variables.css');
  const idx = vars.indexOf('--color-btn-ink: var(--color-accent)');
  assert.ok(idx !== -1, '缺 --color-btn-ink: var(--color-accent) 静态声明（var 引用形态）');
  const dangerIdx = vars.indexOf('--color-danger:');
  assert.ok(dangerIdx !== -1, 'variables.css 缺 --color-danger 静态组');
  assert.ok(idx > dangerIdx, `btn-ink 落点(idx=${idx})未在 --color-danger 组(idx=${dangerIdx})之后`);
});
check('A2-1 variables.css :root 存在 --color-on-btn-ink: var(--color-on-accent) 静态声明', () => {
  const vars = readRel('src/renderer/assets/styles/variables.css');
  assert.ok(
    vars.includes('--color-on-btn-ink: var(--color-on-accent)'),
    '缺 --color-on-btn-ink: var(--color-on-accent) 静态声明（var 引用形态）',
  );
});
check('A2-1 墨石 ink 对取值：底 #17181A（近黑）/ 字 #FFFFFF（白）', () => {
  assert.ok(ink, '墨石条目缺失');
  assert.strictEqual(ink.colors.btnInk, '#17181A', `btnInk 实际 ${ink.colors.btnInk}`);
  assert.strictEqual(ink.colors.onBtnInk, '#FFFFFF', `onBtnInk 实际 ${ink.colors.onBtnInk}`);
});
check('A2-1 apply-theme.ts 对 btn-ink/on-btn-ink 无条件写入（无 if 包裹：行首裸语句 + 块深度=1）', () => {
  const src = readRel('src/renderer/utils/apply-theme.ts');
  assertUnconditionalWrite(src, /export function applyThemePalette/, '--color-btn-ink', 'apply-theme');
  assertUnconditionalWrite(src, /export function applyThemePalette/, '--color-on-btn-ink', 'apply-theme');
});
check('A2-1 ConfigPage.vue applyTheme 副本对 btn-ink/on-btn-ink 无条件写入（无 if 包裹）', () => {
  const src = readRel('src/renderer/pages/ConfigPage.vue');
  assertUnconditionalWrite(src, /function applyTheme\(paletteId: string\)/, '--color-btn-ink', 'ConfigPage.applyTheme');
  assertUnconditionalWrite(src, /function applyTheme\(paletteId: string\)/, '--color-on-btn-ink', 'ConfigPage.applyTheme');
});

// ── A2-2 11 旧板逐板回退 = 改版前 accent/onAccent（冻结表逐板比对回退解析结果）──
check('A2-2 11 旧板逐板回退解析 = 改版前 accent/onAccent（btnInk??accent / onBtnInk??onAccent 语义，冻结表比对）', () => {
  for (const p of THEME_PALETTES) {
    if (p.name === '墨石') continue;
    const f = FROZEN_OLD_PALETTES.find((x) => x.id === p.id);
    assert.ok(f, `${p.id} 不在冻结期望表`);
    const inkResolved = p.colors.btnInk ?? p.colors.accent;
    const onInkResolved = p.colors.onBtnInk ?? p.colors.onAccent;
    assert.strictEqual(inkResolved, f.colors.accent, `${p.id} ink 回退=${inkResolved} ≠ 改版前 accent=${f.colors.accent}`);
    assert.strictEqual(onInkResolved, f.colors.onAccent, `${p.id} on-ink 回退=${onInkResolved} ≠ 改版前 onAccent=${f.colors.onAccent}`);
  }
});

// ── A2-3 侧栏「新会话」钮：消费 token + 切片零硬编码 hex（防倒退钉，现状即绿属预期）──
check('A2-3 .new-button 样式切片：底/字走 var(--color-*) token 且切片内零硬编码 hex', () => {
  const sb = readRel('src/renderer/components/layout/AppSidebar.vue');
  const from = sb.indexOf('.new-button {');
  assert.ok(from !== -1, '.new-button 样式块不存在');
  const to = sb.indexOf('.update-badge', from);
  assert.ok(to > from, '切片右界（.update-badge）未找到');
  const slice = sb.slice(from, to);
  assert.ok(/background:\s*var\(--color-/.test(slice), '.new-button 底色未走 var(--color-*) token');
  assert.ok(/^[ \t]*color:[ \t]*var\(--color-/m.test(slice), '.new-button 字色未走 var(--color-*) token');
  const hexes = slice.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.strictEqual(hexes.length, 0, `.new-button 切片含硬编码 hex：${hexes.join(',')}（绕过 token 写死色值，切旧板穿帮）`);
});

// ── A2-4 发送钮：消费 token + 切片零硬编码 hex（防倒退钉）──
check('A2-4 发送钮（chat-send-button）样式切片：底/字走 var(--color-*) token 且切片内零硬编码 hex', () => {
  const ci = readRel('src/renderer/components/chat/ChatInput.vue');
  assert.ok(ci.includes('data-testid="chat-send-button"'), '发送钮 testid 锚点缺失');
  const styleIdx = ci.indexOf('<style scoped>');
  assert.ok(styleIdx !== -1, 'ChatInput.vue 无 scoped 样式块');
  const from = ci.indexOf('button {', styleIdx);
  assert.ok(from !== -1, '发送钮 button 样式块不存在');
  const to = ci.indexOf('</style>', from);
  assert.ok(to > from, '</style> 右界未找到');
  const slice = ci.slice(from, to);
  assert.ok(/background:\s*var\(--color-/.test(slice), '发送钮底色未走 var(--color-*) token');
  assert.ok(/^[ \t]*color:[ \t]*var\(--color-/m.test(slice), '发送钮字色未走 var(--color-*) token');
  const hexes = slice.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.strictEqual(hexes.length, 0, `发送钮切片含硬编码 hex：${hexes.join(',')}（绕过 token 写死色值，切旧板穿帮）`);
});

// ── A2-5 disabled 结构钉（可计算差异声明存在；CDP 抽验落 cdp-layout-e2e.mjs A2 场景组）──
check('A2-5 发送钮 disabled 结构钉：button:disabled 块含 opacity<1 可计算差异', () => {
  const ci = readRel('src/renderer/components/chat/ChatInput.vue');
  const m = /button:disabled\s*\{([^}]*)\}/.exec(ci);
  assert.ok(m, 'button:disabled 样式块不存在');
  const om = /opacity:\s*([\d.]+)/.exec(m[1]);
  assert.ok(om, 'disabled 块无 opacity 声明（与 enabled 态无可计算差异）');
  const v = parseFloat(om[1]);
  assert.ok(v > 0 && v < 1, `disabled opacity=${om[1]} 不在 (0,1) 开区间（无可计算差异）`);
});

// ── A2-6 纯计算对比度：墨石 onBtnInk on btnInk ≥4.5:1（AA 口径；值取自墨石对象非硬编码）──
check('A2-6 墨石 #FFFFFF on #17181A 对比度 ≥4.5:1（AA，相对亮度公式纯计算）', () => {
  assert.ok(ink, '墨石条目缺失');
  const lum = (hex: string): number => {
    const n = hex.replace('#', '');
    const lin = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
  };
  const bg = ink.colors.btnInk ?? ink.colors.accent;
  const fg = ink.colors.onBtnInk ?? ink.colors.onAccent;
  const lBg = lum(bg);
  const lFg = lum(fg);
  const ratio = (Math.max(lBg, lFg) + 0.05) / (Math.min(lBg, lFg) + 0.05);
  assert.ok(ratio >= 4.5, `对比度 ${ratio.toFixed(2)}:1 < 4.5:1（${fg} on ${bg}）`);
});

// ── A2 CDP 场景存在钉（裁决口径：断言变量解析值，不断言消费钮元素 computed）──
check('A2 cdp-layout-e2e.mjs 含 A2 场景组（A2-1/A2-2/A2-5 标记 + runA2Scenarios 入口 + 隔离 user-data-dir）', () => {
  const cdp = readRel('scripts/cdp-layout-e2e.mjs');
  assert.ok(cdp.includes('A2-1'), 'cdp-layout-e2e.mjs 缺 A2-1 场景标记');
  assert.ok(cdp.includes('A2-2'), 'cdp-layout-e2e.mjs 缺 A2-2 场景标记');
  assert.ok(cdp.includes('A2-5'), 'cdp-layout-e2e.mjs 缺 A2-5 场景标记');
  assert.ok(cdp.includes('runA2Scenarios'), 'cdp-layout-e2e.mjs 缺 runA2Scenarios 场景组入口');
  assert.ok(cdp.includes('--user-data-dir'), 'cdp-layout-e2e.mjs A2 场景未隔离 user-data-dir');
});

// ══════════════════════════════════════════════════════════════════════════════
// A3 用户气泡固定浅蓝 token（slate-ui-completion-1108-1428 点 A3；A-tokens-cases.md §A3
// A3-1/A3-2/A3-5/A3-6；A3-3/A3-4 消费者侧断言原推迟到 C1 点转写，已随 C1 落地补写（见本组尾部）——
// .bubble--user 现引用固定 token、无 color-mix(...accent...) 派生残留）
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n=== A3 用户气泡固定浅蓝 token 契约（A3-1/2/5/6） ===');

// ── A3-1 两值命中：字面值声明（非 var 派生）、落点紧随 btn-ink 组、注释义务 ──
check('A3-1 variables.css :root 存在 --color-bubble-user-bg: #D9E9ED 字面值声明', () => {
  const vars = readRel('src/renderer/assets/styles/variables.css');
  assert.match(vars, /--color-bubble-user-bg:\s*#D9E9ED/i, '缺 --color-bubble-user-bg: #D9E9ED 字面声明（var 派生或值失配均不命中）');
});
check('A3-1 variables.css :root 存在 --color-bubble-user-ink: #17181A 字面值声明', () => {
  const vars = readRel('src/renderer/assets/styles/variables.css');
  assert.match(vars, /--color-bubble-user-ink:\s*#17181A/i, '缺 --color-bubble-user-ink: #17181A 字面声明（var 派生或值失配均不命中）');
});
check('A3-1 落点紧随 btn-ink 组（在 --color-on-btn-ink 声明之后）', () => {
  const vars = readRel('src/renderer/assets/styles/variables.css');
  const bubbleIdx = vars.indexOf('--color-bubble-user-bg');
  const onBtnInkIdx = vars.indexOf('--color-on-btn-ink:');
  assert.ok(bubbleIdx !== -1, '缺 bubble-user-bg 声明');
  assert.ok(onBtnInkIdx !== -1, '缺 --color-on-btn-ink 声明');
  assert.ok(bubbleIdx > onBtnInkIdx, `bubble-user 落点(idx=${bubbleIdx}) 未在 btn-ink 组(idx=${onBtnInkIdx}) 之后`);
});
check('A3-1 声明前注释注明「不随色板、禁止加入 ThemePalette 接口与 apply-theme 写入链」', () => {
  const vars = readRel('src/renderer/assets/styles/variables.css');
  const idx = vars.indexOf('--color-bubble-user-bg');
  assert.ok(idx !== -1, '缺 bubble-user-bg 声明');
  const before = vars.slice(Math.max(0, idx - 500), idx);
  assert.ok(before.includes('不随色板'), '声明前注释缺「不随色板」字样');
  assert.ok(/禁止加入\s*ThemePalette\s*接口/.test(before), '声明前注释缺「禁止加入 ThemePalette 接口」字样');
  assert.ok(before.includes('apply-theme 写入链'), '声明前注释缺「apply-theme 写入链」字样');
});

// ── A3-2 机制负断言：token 不入 ThemePalette 接口、不入写板链 ──
check('A3-2 12 板对象切片内无 #D9E9ED（THEME_PALETTES 序列化负断言）', () => {
  const dumped = JSON.stringify(THEME_PALETTES);
  assert.ok(!/#D9E9ED/i.test(dumped), 'THEME_PALETTES 内出现 #D9E9ED（token 值被误加入色板，违背「不随色板」）');
});
check('A3-2 constants.ts 无 bubble-user/bubbleUser 字样（token 未接入 ThemePalette 接口）', () => {
  const cst = readRel('src/shared/constants.ts');
  assert.ok(!/bubble[-_]?user/i.test(cst), 'constants.ts 出现 bubble-user/bubbleUser 字样（token 被误接入 ThemePalette 接口）');
});
check('A3-2 apply-theme.ts 写板链不含该 token（setProperty 列表负断言）', () => {
  const applyTheme = readRel('src/renderer/utils/apply-theme.ts');
  assert.ok(!/bubble[-_]?user/i.test(applyTheme), 'apply-theme.ts 出现 bubble-user 写入（token 被误接入 apply-theme 写板链）');
});
check('A3-2 ConfigPage.vue applyTheme 副本不含该 token 写入', () => {
  const cp = readRel('src/renderer/pages/ConfigPage.vue');
  assert.ok(!/bubble[-_]?user/i.test(cp), 'ConfigPage.vue 出现 bubble-user 写入（token 被误接入写板链副本）');
});

// ── A3-5 导出路径同源：export-runner / 主窗口无独立字面、无本地复制 ──
check('A3-5 export-runner.ts 无独立 #D9E9ED/#17181A 字面、无 bubble-user 本地复制', () => {
  const er = readRel('src/renderer/export/export-runner.ts');
  assert.ok(!/#D9E9ED/i.test(er), 'export-runner.ts 出现 #D9E9ED 字面（绕过 token 本地复制）');
  assert.ok(!/#17181A/i.test(er), 'export-runner.ts 出现 #17181A 字面（绕过 token 本地复制）');
  assert.ok(!/bubble[-_]?user/i.test(er), 'export-runner.ts 出现 bubble-user 本地复制');
});
check('A3-5 主窗口 App.vue 无独立 #D9E9ED/#17181A 字面、无 bubble-user 本地复制', () => {
  const app = readRel('src/renderer/App.vue');
  assert.ok(!/#D9E9ED/i.test(app), 'App.vue 出现 #D9E9ED 字面（绕过 token 本地复制）');
  assert.ok(!/#17181A/i.test(app), 'App.vue 出现 #17181A 字面（绕过 token 本地复制）');
  assert.ok(!/bubble[-_]?user/i.test(app), 'App.vue 出现 bubble-user 本地复制');
});

// ── A3-6 纯计算对比度：ink on bg ≥7:1（AAA 口径；值取自 variables.css 字面）──
check('A3-6 #17181A on #D9E9ED 对比度 ≥7:1（AAA，相对亮度公式纯计算，值取自 variables.css 字面）', () => {
  const vars = readRel('src/renderer/assets/styles/variables.css');
  const bgM = /--color-bubble-user-bg:\s*(#[0-9a-fA-F]{6})/.exec(vars);
  const inkM = /--color-bubble-user-ink:\s*(#[0-9a-fA-F]{6})/.exec(vars);
  assert.ok(bgM, '缺 --color-bubble-user-bg 六位 hex 字面');
  assert.ok(inkM, '缺 --color-bubble-user-ink 六位 hex 字面');
  const lum = (hex: string): number => {
    const n = hex.replace('#', '');
    const lin = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
  };
  const bg = bgM[1];
  const fg = inkM[1];
  const lBg = lum(bg);
  const lFg = lum(fg);
  const ratio = (Math.max(lBg, lFg) + 0.05) / (Math.min(lBg, lFg) + 0.05);
  assert.ok(ratio >= 7, `对比度 ${ratio.toFixed(2)}:1 < 7:1（${fg} on ${bg}）`);
});

// ── A3-3/A3-4 消费者侧断言（原按拆点时序推迟到 C1 点；C1 落地后随点补写，2026-11-08）──
check('A3-3 .bubble--user 样式块引用固定 token：background=var(--color-bubble-user-bg) / color=var(--color-bubble-user-ink)', () => {
  const mb = readRel('src/renderer/components/chat/MessageBubble.vue');
  const m = /\.bubble--user\s*\{([^}]*)\}/.exec(mb);
  assert.ok(m, '.bubble--user 样式块不存在');
  const body = m[1];
  assert.ok(/background:\s*var\(--color-bubble-user-bg\)/.test(body), 'background 未引 var(--color-bubble-user-bg)');
  assert.ok(/(^|\n)\s*color:\s*var\(--color-bubble-user-ink\)/.test(body), 'color 未引 var(--color-bubble-user-ink)');
});
check('A3-4 .bubble--user 样式块无 color-mix(...accent...) 派生残留（防倒退钉）', () => {
  const mb = readRel('src/renderer/components/chat/MessageBubble.vue');
  const m = /\.bubble--user\s*\{([^}]*)\}/.exec(mb);
  assert.ok(m, '.bubble--user 样式块不存在');
  const body = m[1];
  assert.ok(!body.includes('color-mix('), '块内残留 color-mix(（accent 派生未除净）');
  assert.ok(!/accent/i.test(body), '块内残留 accent 引用（描边/色条派生未除净）');
});

// ── A3 CDP 场景存在钉（token raw 变量值 + inline 零写入口径不变；.bubble--user 元素 computed 探针已由 C1 点落地于本文件 A3 场景组，另由 tdd-c-chat-stream-verify.ts 尾部存在钉守护）──
check('A3 cdp-layout-e2e.mjs 含 A3 场景组（runA3Scenarios 入口 + bubble 对三板恒定 + 隔离 user-data-dir）', () => {
  const cdp = readRel('scripts/cdp-layout-e2e.mjs');
  assert.ok(cdp.includes('runA3Scenarios'), 'cdp-layout-e2e.mjs 缺 runA3Scenarios 场景组入口');
  assert.ok(cdp.includes("'--color-bubble-user-bg'"), 'cdp-layout-e2e.mjs 缺 bubble-user-bg 恒定断言');
  assert.ok(cdp.includes("'--color-bubble-user-ink'"), 'cdp-layout-e2e.mjs 缺 bubble-user-ink 恒定断言');
  assert.ok(cdp.includes('#D9E9ED'), 'cdp-layout-e2e.mjs A3 场景缺 #D9E9ED 期望值');
  assert.ok(cdp.includes('#17181A'), 'cdp-layout-e2e.mjs A3 场景缺 #17181A 期望值');
  assert.ok(cdp.includes('--user-data-dir'), 'cdp-layout-e2e.mjs A3 场景未隔离 user-data-dir');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
