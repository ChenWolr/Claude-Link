// tdd-config-core-g1-g5-verify.ts
// G 配置页核心（G1~G5）共用契约脚本 · G1 小节「CLI 横幅移连接 tab 首位+图标化+路径截断+重新检测钮」
// （slate-ui-completion-1108-1428 round-001 点 G1；用例正本 = docs/ui-completion/tests/G-config-core-cases.md
//   G1 节 G1-01~G1-08；行为规范 = docs/ui-completion/10-behavior-specs.md §G1；实现细节 =
//   docs/ui-completion/impl/G-config-core-impl.md §1）。
// 全部为纯 node 读文件 + 字面/正则断言，不 import Electron、不跑 DB。
//
// 覆盖（G1）：
//   G1-01 横幅三分支渲染块整体位于 wb-connection（v-show connection 面板）内且为其首个元素子节点
//         （ProviderManager 之前）；页面级顶部不再存在无条件横幅块；三态 v-if 链与
//         banner banner--in-panel banner--info/ok/warn 类名保持；.banner--ok 既有配色口径不变；
//         页面级共宽组 .banner,.toast,.storage-info 一行不动（selftest-settings-mapping L1236 同源钉）。
//   G1-02 （CDP 面）其他 7 tab 激活/深链 ?tab= 直达时横幅不可见——落点 scripts/cdp-layout-e2e.mjs
//         配置页组（本组 CDP 挂载点），本脚本只钉其挂载接线存在（静态半边）。
//         转写裁决（申报留痕）：tab 面板按 G3-02 须保持 v-show 常挂（IM 扫码链/探测态不重置），
//         横幅随容器 display:none 隐藏——「无横幅」按行为规范 §G1「其他 tab 不显示 / 深链直达无横幅」
//         的用户可见语义断言为「DOM 缺席或不可见（offsetParent === null）」，非 DOM 缺席单判；
//         横幅永居 wb-connection 之内（结构性兜底）一并断言。
//   G1-03 三态图标化：检测中=线性 loader（banner__spin 旋转类）/已安装=check-circle/未检测到=
//         alert-triangle；全部内联 SVG stroke=currentColor；✅/⚠️ emoji 字面全文件归零（负断言）。
//   G1-04 三态文案逐字保留 + 安装命令 <code class="banner-code"> 包裹 + 路径 <code class="banner-path">。
//   G1-05 路径 mono 渲染 + 单行截断样式组合（overflow hidden + ellipsis + nowrap + max-width:100%）
//         + :title 全路径绑定。
//   G1-06 「重新检测」钮：:disabled="store.detectingCli" 防重入 + @click 直调既有 store.detectCli()
//         （无 showToast 包装=成功零 toast）+ 失败走既有 store.error 页级 toast 通道（钉通道在场）。
//   G1-07 spin 旋转动画有 reduced-motion 降级（@media (prefers-reduced-motion: reduce) 块内
//         .banner__spin { animation: none; }——回归 assertReducedMotionCoverage 同源语义）。
//   G1-08 检测状态源与进页时机不变（保全钉，转写即绿属预期）：config-store detectCli 形态不重写
//         （detectingCli 置位/error 置 null/finally 复位/error 兜底）；performInit 链内
//         await store.detectCli() 保持；store.detectingCli/cliStatus 消费点仅横幅分支。
//
// G2 小节（点 G2，2026-11-09 增；用例正本 = 同卷 G2 节 G2-01~G2-08；实现细节 = impl §2）：
//   G2-01 色板卡原生 button[type=button] + :aria-pressed 与选中态同源 + 点击仍 emit select
//         （负断言：不再有 div 形态 palette-card；aria-pressed 不得写死恒值）。
//   G2-02 swatch 四格=bg/panel/panelSoft/accent 依次绑定（负断言：text/textMuted 格消失）；
//         数据半边（行为组）：THEME_PALETTES 每套四键均非空 string（转写即绿属预期）。
//   G2-03 名称行条件徽章：默认板「默认」muted / 暗板「暗色」accent，两条件独立 v-if 可并存；
//         徽章三块样式在场且全 token（无硬编码 hex）。
//   G2-04 CDP 挂载半边：cdp-layout-e2e.mjs 存在 runG2Scenario 定义与 main 流程挂载（静态钉）。
//   G2-05 focus-visible 焦点环：outline 形态 + var(--color-accent) + outline-offset，块内零硬编码 hex。
//   G2-06 active 态 accent 描边 + auto-fill 网格保持（保全钉，转写即绿属预期）。
//   G2-07 12 套自动渲染：数据面 length===12（与 A1 selftest-settings-mapping #43 同源一致）；
//         模板 v-for 遍历（负断言：组件文件零色板 id 字面=无手工写死卡；「当前·本方案」「当前使用」
//         类自注徽章字面归零）。
//   G2-08 切换即时生效链路不变（保全钉）：ConfigPage 绑定形态保持；handleThemeSelect→applyTheme
//         链不重写；组件内不自建选中态（script 仅 defineProps.selectedId 一处引用）。
//   附：A1 一致性核对——默认板 id=inkstone、首位=inkstone、isDark 白名单仅 terminal-pro、
//         默认板恰 1 套（徽章语义良定义），与 selftest-settings-mapping L1298-1301 四钉对齐。
//
// G4 小节（点 G4，2026-11-09 增；用例正本 = 同卷 G4 节 G4-01~G4-06；实现细节 = impl/G-config-core-impl.md
//   §4；裁决：C-G4-1 IME 守卫先行再 preventDefault、G4-6 N=归一后条数 + 两路径共用归一化函数）：
//   G4-01 端口 Enter 通道（静态半边）：端口 input @keydown.enter="onWaEnter" 接线在场（无 .prevent
//         修饰符）且 handler 内 preventDefault + blur()（等效失焦——blur 后走既有 @blur="clampWaPort"
//         夹取链，Enter 零新逻辑）。
//   G4-02 Host Enter 通道（静态半边）：Host input @keydown.enter="onWaEnter" 接线在场且与
//         @blur="normalizeWaAllowedHosts" 同一归一化函数（两路径共用，裁决 G4-6）。
//   G4-03 Host 归一化 toast：值确实改变分支内才 showToast（JSON.stringify 前后比较→未变 return）；
//         文案逐字模板「Host 白名单已保存 · 共 N 条（已归一化）」且 N 取 next（sanitize 后）条数
//         （负断言：不得取 before）；clampWaPort / onWaEnter 零 showToast（端口无 toast 负断言）。
//   G4-04 IME 守卫（与 ChatPage onGlobalKeydown 同口径）：onWaEnter 入口处
//         `if (e.isComposing || e.keyCode === 229) return;` 字面在场，且守卫先于 preventDefault/blur
//         （C-G4-1：组合态不 preventDefault，防部分引擎组词上屏被拦）。
//   G4-05 500ms 去重：lastWaHostsToastAt 时间戳变量 + `now - lastWaHostsToastAt < 500` 常量窗
//         + 时间戳更新先于 toast（防连按重复弹）。
//   G4-06 失焦通道保全（Enter 是叠加不是替换）：@blur="clampWaPort"/@blur="normalizeWaAllowedHosts"
//         字面各恰一在场；端口 type="number" min/max 与 Host placeholder 逐字保持；
//         @keydown.enter="onWaEnter" 全模板恰两处（端口+Host）。
//   附：CDP 挂载半边（同 G2-04 形态）——cdp-layout-e2e.mjs 存在 runG4Scenario 定义与 main 流程挂载。
//
// 运行：npx tsx scripts/tdd-config-core-g1-g5-verify.ts（已登记 scripts/selftest-static-list.txt 尾部
//   ＋ tsconfig.tdd.json include 类型闸门）。G2 数据半边 import shared/constants（纯数据，无
//   Electron 依赖；tdd-tokens-inkstone-verify.ts 同型先例），其余仍为纯 node 读文件＋字面/正则断言。

import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_THEME_PALETTE_ID, FONT_SCALE_SIZES, THEME_PALETTES } from '../src/shared/constants';

const repoRoot = join(__dirname, '..');
// 读取统一折叠 CRLF→LF：G1 含跨行模板块与 CSS 块切片断言，折叠后对行尾不敏感。
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');

const cp = read('src/renderer/pages/ConfigPage.vue');
const configStore = read('src/renderer/stores/config-store.ts');
const staticList = read('scripts/selftest-static-list.txt');
const tsconfigTdd = read('tsconfig.tdd.json');
const cdpLayout = read('scripts/cdp-layout-e2e.mjs');
// G2：ThemeSelector 组件三切片（script/template/style，折叠 CRLF 后按字面与正则断言）。
const tsFile = read('src/renderer/components/config/ThemeSelector.vue');
const tsScript = tsFile.slice(0, tsFile.indexOf('<template>'));
const tsTemplate = tsFile.slice(tsFile.indexOf('<template>'), tsFile.lastIndexOf('</template>'));
const tsStyle = tsFile.slice(tsFile.indexOf('<style'));

const tplStart = cp.indexOf('<template>');
const template = cp.slice(tplStart, cp.lastIndexOf('</template>'));
const style = cp.slice(cp.indexOf('<style'));

// wb-connection 面板切片：自容器开标签起到 ProviderManager 挂载点止（横幅应整体落在其中）。
// G3② 同步（2026-11-09）：面板容器追加 role="tabpanel"/aria-labelledby 属性（在 class 之后），
// 切片锚去掉闭合 `>` 放宽到属性前缀——切片语义（横幅落位/首元素子节点）不变。
const wbOpen = template.indexOf('<div v-show="activeTab === \'connection\'" class="wb-connection"');
const pmIdx = template.indexOf('<ProviderManager />');

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i > -1) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

// CSS 单层规则块切片：自选择器起至首个 `}`（本文件样式无嵌套）。
function cssBlock(src: string, selector: string): string {
  const start = src.indexOf(selector);
  assert.ok(start !== -1, `未找到样式选择器 ${selector}`);
  return src.slice(start, src.indexOf('}', start));
}

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ❌ ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log('\n=== G 配置页核心契约（G1 小节）===\n');

console.log('── G1-01 横幅仅渲染于连接 tab 内容区且为其第一个元素 ──');
check('G1-01a wb-connection 容器与 ProviderManager 挂载点在场（切片锚有效）', () => {
  assert.ok(wbOpen !== -1, 'wb-connection 容器开标签未找到');
  assert.ok(pmIdx !== -1, '<ProviderManager /> 挂载点未找到');
  assert.ok(pmIdx > wbOpen, 'ProviderManager 位于 wb-connection 开标签之前（切片失效）');
});
check('G1-01b 横幅三分支渲染块整体位于 wb-connection 内且在 ProviderManager 之前', () => {
  const slice = template.slice(wbOpen, pmIdx);
  assert.ok(slice.includes('v-if="store.detectingCli"'), '检测中分支不在 wb-connection 切片内');
  assert.ok(slice.includes("v-else-if=\"store.cliStatus?.installed\""), '已安装分支不在 wb-connection 切片内');
  assert.ok(slice.includes('v-else'), '未检测到分支不在 wb-connection 切片内');
  assert.ok(slice.includes('banner--info') && slice.includes('banner--ok') && slice.includes('banner--warn'), '三态 class 不全在切片内');
});
check('G1-01c 横幅为 wb-connection 首个元素子节点（开标签到首个 banner 元素间仅空白/注释）', () => {
  const firstBannerEl = template.indexOf('<div v-if="store.detectingCli"', wbOpen);
  assert.ok(firstBannerEl !== -1 && firstBannerEl < pmIdx, 'wb-connection 切片内未找到首个 banner 元素（v-if=detectingCli）');
  const head = template.slice(template.indexOf('>', wbOpen) + 1, firstBannerEl);
  const stripped = head.replace(/<!--[\s\S]*?-->/g, '').trim();
  assert.strictEqual(stripped, '', `首个 banner 之前存在非注释内容：${JSON.stringify(stripped.slice(0, 80))}`);
});
check('G1-01d 页面级顶部（page-head 后至 tabs-row 前）不再存在横幅渲染块', () => {
  const pageLevel = template.slice(0, wbOpen);
  assert.ok(!pageLevel.includes('class="banner'), 'wb-connection 之前仍有横幅渲染块（未移位或残留副本）');
  const afterPanel = template.slice(template.indexOf('<ProviderManager />') + '<ProviderManager />'.length);
  assert.ok(!afterPanel.includes('class="banner'), 'wb-connection 之后仍有横幅渲染块（残留副本）');
});
check('G1-01e 三态 class 名保持「banner banner--in-panel + info/ok/warn」', () => {
  assert.ok(template.includes('class="banner banner--in-panel banner--info"'), 'info 态 class 形态漂移');
  assert.ok(template.includes('class="banner banner--in-panel banner--ok"'), 'ok 态 class 形态漂移');
  assert.ok(template.includes('class="banner banner--in-panel banner--warn"'), 'warn 态 class 形态漂移');
});
check('G1-01f .banner--ok 既有配色口径不变（accent 系三件）', () => {
  const blk = cssBlock(style, '.banner--ok {');
  assert.ok(blk.includes('border: 1px solid var(--color-accent);'), 'ok 态描边漂移');
  assert.ok(blk.includes('background: color-mix(in srgb, var(--color-accent) 12%, transparent);'), 'ok 态底色漂移');
  assert.ok(blk.includes('color: var(--color-accent-strong);'), 'ok 态文字色漂移');
});
check('G1-01g 页面级共宽组 .banner,.toast,.storage-info 一行不动（selftest L1236 同源钉）', () => {
  assert.ok(/\.banner,\s*\n\s*\.toast,\s*\n\s*\.storage-info\s*\{/.test(style), '共宽组选择器形态漂移');
  const blk = cssBlock(style, '.banner,\n.toast,');
  assert.ok(blk.includes('width: var(--col-w);') && blk.includes('max-width: 100%;') && blk.includes('margin-inline: auto;') && blk.includes('flex: none;'), '共宽组声明被改动');
});
check('G1-01h 面板内通栏覆盖 .banner--in-panel 在场（width:100% + margin 收窄）', () => {
  const blk = cssBlock(style, '.banner--in-panel {');
  assert.ok(blk.includes('width: 100%;'), '缺 width:100%（覆盖共宽组 var(--col-w)）');
  assert.ok(blk.includes('margin: 0 0 0.875rem;'), '缺 margin 收窄（覆盖 margin-inline:auto/margin-bottom:1.25rem）');
});

console.log('\n── G1-02 CDP 挂载接线（运行时断言落点 cdp-layout-e2e.mjs 配置页组）──');
check('G1-02 cdp-layout-e2e.mjs 配置页组在场（G 组 runner 已挂入 main 流程）', () => {
  assert.ok(/runG(?:1|Group)?Scenarios?\s*\(/.test(cdpLayout), 'cdp-layout-e2e.mjs 缺 G 组 runner 定义/挂载');
});

console.log('\n── G1-03 三态图标化（emoji 归零）──');
check('G1-03a 检测中分支=线性 loader 图标 + banner__spin 旋转类', () => {
  const iInfo = template.indexOf('banner--in-panel banner--info');
  const branch = template.slice(iInfo, template.indexOf('</div>', iInfo));
  assert.ok(branch.includes('<svg class="banner__icon banner__spin"'), '检测中分支缺 svg.loader + spin 类');
  assert.ok(branch.includes('viewBox="0 0 24 24"') && branch.includes('stroke="currentColor"') && branch.includes('aria-hidden="true"'), 'loader 图标线性形态漂移');
  assert.ok(branch.includes('M21 12a9 9 0 1 1-2.64-6.36') && branch.includes('M21 3v6h-6'), 'loader path 与本文件既有 fallback 图标不同形');
});
check('G1-03b 已安装分支=check-circle 图标（circle-check 同形）', () => {
  const iOk = template.indexOf('banner--in-panel banner--ok');
  const branch = template.slice(iOk, template.indexOf('</div>', iOk));
  assert.ok(branch.includes('<svg class="banner__icon"'), 'ok 分支缺 svg 图标');
  assert.ok(branch.includes('<circle cx="12" cy="12" r="10"/>') && branch.includes('m9 12 2 2 4-4'), 'check-circle path 漂移');
  assert.ok(!branch.includes('banner__spin'), 'ok 分支误带旋转类（图标错位）');
});
check('G1-03c 未检测到分支=alert-triangle 图标（triangle-alert 同形）', () => {
  const iWarn = template.indexOf('banner--in-panel banner--warn');
  const branch = template.slice(iWarn, template.indexOf('</button>', iWarn));
  assert.ok(branch.includes('<svg class="banner__icon"'), 'warn 分支缺 svg 图标');
  assert.ok(branch.includes('m21.73 18-8-14') && branch.includes('M12 9v4') && branch.includes('M12 17h.01'), 'triangle-alert path 漂移');
  assert.ok(!branch.includes('banner__spin'), 'warn 分支误带旋转类（图标错位）');
});
check('G1-03d ✅/⚠️ emoji 字面全文件归零（负断言）', () => {
  assert.strictEqual(countOccurrences(cp, '✅'), 0, '✅ emoji 残留');
  assert.strictEqual(countOccurrences(cp, '⚠️'), 0, '⚠️ emoji 残留');
});
check('G1-03e .banner__spin 旋转动画声明在场（复用既有 @keyframes spin）', () => {
  const blk = cssBlock(style, '.banner__spin {');
  assert.ok(blk.includes('animation: spin 0.9s linear infinite;'), 'spin 动画声明漂移');
  assert.ok(style.includes('@keyframes spin {'), '既有 @keyframes spin 被删');
});

console.log('\n── G1-04 文案逐字保留 + 安装命令 code 包裹 ──');
check('G1-04a 三态文案字面逐字', () => {
  assert.ok(template.includes('正在检测 Claude Code CLI...'), '①检测中文案漂移');
  assert.ok(template.includes('Claude Code CLI 已安装 — {{ store.cliStatus.version }}'), '②已安装文案骨架漂移');
  assert.ok(template.includes('未检测到 Claude Code CLI。请先安装：'), '③未检测到文案漂移');
});
check('G1-04b 安装命令 <code class="banner-code"> 包裹', () => {
  assert.ok(template.includes('<code class="banner-code">npm install -g @anthropic-ai/claude-code</code>'), '安装命令未以 banner-code code 元素包裹');
});
check('G1-04c 路径 <code class="banner-path"> 包裹且括号留在文本流', () => {
  assert.ok(template.includes('(<code class="banner-path" :title="store.cliStatus?.path ?? undefined">{{ store.cliStatus.path }}</code>)'), '路径 code 包裹/括号位置漂移');
});

console.log('\n── G1-05 路径 mono 渲染 + 截断 + title 全路径 ──');
check('G1-05a .banner-path mono + 单行截断样式组合', () => {
  const blk = cssBlock(style, '.banner-path {');
  assert.ok(blk.includes('font-family: var(--font-mono);'), '缺 mono 字体');
  assert.ok(blk.includes('overflow: hidden;') && blk.includes('text-overflow: ellipsis;') && blk.includes('white-space: nowrap;'), '缺单行截断三件套');
  assert.ok(blk.includes('max-width: 100%;'), '缺 max-width:100%（截断宽度上限）');
});
check('G1-05b :title 绑定全路径（store.cliStatus.path；null→undefined 归一是 CliDetectionResult.path: string|null 的类型闸门要求）', () => {
  assert.ok(template.includes(':title="store.cliStatus?.path ?? undefined"'), 'title 全路径绑定丢失');
});

console.log('\n── G1-06 「重新检测」钮（防重入 + 零新 toast + 既有错误通道）──');
check('G1-06a 钮存在 + disabled 绑 detectingCli + 直调 store.detectCli()', () => {
  const iWarn = template.indexOf('banner--in-panel banner--warn');
  const branch = template.slice(iWarn, template.indexOf('</div>', template.indexOf('banner-code', iWarn)));
  assert.ok(/<button type="button" class="banner-link" :disabled="store\.detectingCli" @click="store\.detectCli\(\)">重新检测<\/button>/.test(branch), '钮形态/绑定/文案漂移');
});
check('G1-06b 横幅区零 showToast（成功态由 v-if 链自动切换，无 toast 包装）', () => {
  const slice = template.slice(wbOpen, pmIdx);
  assert.ok(!slice.includes('showToast'), '横幅切片内出现 showToast（旁路 toast）');
});
check('G1-06c 失败走既有错误通道：store.error 页级 toast 展示位保持在场', () => {
  assert.ok(template.includes('<div v-if="store.error && !toast" class="toast toast--error">{{ store.error }}</div>'), '既有 store.error 通道展示位被移除/改形');
});
check('G1-06d .banner-link 钮样式与 disabled/focus-visible 态在场', () => {
  const blk = cssBlock(style, '.banner-link {');
  assert.ok(blk.includes('cursor: pointer;') && blk.includes('color: inherit;'), '链接钮基础样式漂移');
  assert.ok(style.includes('.banner-link:disabled {') && cssBlock(style, '.banner-link:disabled {').includes('cursor: not-allowed;'), 'disabled 态缺失');
  assert.ok(style.includes('.banner-link:focus-visible {') && cssBlock(style, '.banner-link:focus-visible {').includes('outline: 2px solid currentColor;'), 'focus-visible 缺失或硬编码色');
});

console.log('\n── G1-07 spin 旋转动画 reduced-motion 降级 ──');
check('G1-07 @media (prefers-reduced-motion: reduce) 块内 .banner__spin { animation: none; }', () => {
  const mediaRe = /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/g;
  let found = false;
  for (const m of style.matchAll(mediaRe)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < style.length; i += 1) {
      if (style[i] === '{') depth += 1;
      else if (style[i] === '}' && --depth === 0) {
        const body = style.slice(open + 1, i);
        if (/\.banner__spin\s*\{\s*animation:\s*none;\s*\}/.test(body)) found = true;
        break;
      }
    }
  }
  assert.ok(found, 'reduced-motion 块内缺 .banner__spin { animation: none; }（assertReducedMotionCoverage 同源语义）');
});

console.log('\n── G1-08 检测状态源与进页时机不变（保全钉，转写即绿属预期）──');
check('G1-08a config-store detectCli 形态不重写', () => {
  const blk = configStore.slice(configStore.indexOf('async detectCli()'), configStore.indexOf('async detectCli()') + 700);
  assert.ok(blk.includes('this.detectingCli = true;'), 'detectingCli 置位漂移');
  assert.ok(blk.includes('this.error = null;'), '入口 error 清理漂移');
  assert.ok(blk.includes('await window.claudeLink.detectCli();'), 'IPC 调用漂移');
  assert.ok(blk.includes('finally {') && blk.includes('this.detectingCli = false;'), 'finally 复位漂移');
  assert.ok(blk.includes("error instanceof Error ? error.message : '检测 Claude Code CLI 失败'"), 'error 兜底漂移');
});
check('G1-08b performInit 进页检测链不动（loadConfig → detectCli 顺序保持）', () => {
  assert.ok(/await store\.loadConfig\(\);\s*\n\s*await store\.detectCli\(\);/.test(cp), '进页检测调用链漂移');
});
check('G1-08c store.detectingCli 消费点仅横幅三分支体系（v-if + 钮 disabled，恰 2 处）', () => {
  assert.strictEqual(countOccurrences(template, 'store.detectingCli'), 2, `detectingCli 模板消费点 ${countOccurrences(template, 'store.detectingCli')} 处 ≠ 2`);
});
check('G1-08d store.cliStatus 消费点仅 ok 分支（恰 4 处：installed 判定/version/path title/path 文本）', () => {
  assert.strictEqual(countOccurrences(template, 'store.cliStatus'), 4, `cliStatus 模板消费点 ${countOccurrences(template, 'store.cliStatus')} 处 ≠ 4`);
});

console.log('\n=== G 配置页核心契约（G2 小节：ThemeSelector button 化 + swatch 四格 + 徽章 + focus 环）===\n');

console.log('── G2-01 色板卡原生 button + aria-pressed 同源（含负断言）──');
check('G2-01a 卡容器为 <button v-for>（div 形态归零，负断言）', () => {
  assert.ok(/<button\s*\n\s*v-for="palette in THEME_PALETTES"/.test(tsTemplate), '卡容器不是 <button v-for="palette in THEME_PALETTES">');
  assert.ok(!/<div[^>]*palette-card/.test(tsTemplate), '仍存在 div 形态 palette-card（键盘不可达）');
});
check('G2-01b button 带 type="button"', () => {
  const openEnd = tsTemplate.indexOf('>', tsTemplate.indexOf('<button'));
  const open = tsTemplate.slice(tsTemplate.indexOf('<button'), openEnd);
  assert.ok(/\btype="button"/.test(open), 'button 开标签缺 type="button"');
});
check('G2-01c :aria-pressed 与选中态同源（palette.id === selectedId）', () => {
  assert.ok(tsTemplate.includes(':aria-pressed="palette.id === selectedId"'), 'aria-pressed 绑定缺失或与 active 判定不同源');
});
check('G2-01d aria-pressed 不得写死恒值（负断言）', () => {
  assert.ok(!tsTemplate.includes('aria-pressed="true"'), 'aria-pressed 写死 "true"');
  assert.ok(!tsTemplate.includes('aria-pressed="false"'), 'aria-pressed 写死 "false"');
});
check('G2-01e 点击仍 emit select（接线保持）', () => {
  assert.ok(tsTemplate.includes('@click="emit(\'select\', palette.id)"'), '@click emit select 接线漂移');
});

console.log('\n── G2-02 swatch 四格=bg/panel/panelSoft/accent（模板 + 数据半边）──');
check('G2-02a 恰 4 个 swatch 且 :style 依次取 colors.bg/panel/panelSoft/accent', () => {
  assert.strictEqual(countOccurrences(tsTemplate, 'class="swatch"'), 4, `swatch 元素 ${countOccurrences(tsTemplate, 'class="swatch"')} 个 ≠ 4`);
  const idx = [
    tsTemplate.indexOf('{ background: palette.colors.bg }'),
    tsTemplate.indexOf('{ background: palette.colors.panel }'),
    tsTemplate.indexOf('{ background: palette.colors.panelSoft }'),
    tsTemplate.indexOf('{ background: palette.colors.accent }'),
  ];
  idx.forEach((v, i) => assert.ok(v !== -1, `第 ${i + 1} 格绑定缺失（期望序：bg/panel/panelSoft/accent）`));
  for (let i = 1; i < idx.length; i += 1) {
    assert.ok(idx[i] > idx[i - 1], `swatch 绑定顺序漂移（${['bg', 'panel', 'panelSoft', 'accent'][i]} 不在第 ${i - 1} 格之后）`);
  }
});
check('G2-02b 旧 text 格消失（负断言：swatch 不再引用 colors.text/textMuted）', () => {
  assert.ok(!tsTemplate.includes('palette.colors.text }'), 'text 格残留');
  assert.ok(!tsTemplate.includes('palette.colors.textMuted'), 'textMuted 误入 swatch');
});
check('G2-02c 数据半边：每套色板 bg/panel/panelSoft/accent 均为非空 string（转写即绿属预期）', () => {
  for (const p of THEME_PALETTES) {
    for (const k of ['bg', 'panel', 'panelSoft', 'accent'] as const) {
      const v = p.colors[k];
      assert.ok(typeof v === 'string' && v.length > 0, `色板 ${p.id}.${k} 非非空 string`);
    }
  }
});

console.log('\n── G2-03 名称行条件徽章（默认 muted / 暗色 accent，独立可并存）──');
check('G2-03a 默认色板「默认」徽章（muted 语义 class，v-if 按 DEFAULT_THEME_PALETTE_ID）', () => {
  assert.ok(tsTemplate.includes('<span v-if="palette.id === DEFAULT_THEME_PALETTE_ID" class="palette-badge palette-badge--muted">默认</span>'), '默认徽章字面/条件/class 漂移');
});
check('G2-03b 暗色板「暗色」徽章（accent 语义 class，v-if 按 isDark）', () => {
  assert.ok(tsTemplate.includes('<span v-if="palette.isDark" class="palette-badge palette-badge--accent">暗色</span>'), '暗色徽章字面/条件/class 漂移');
});
check('G2-03c 两条件相互独立（各自 v-if，非 else-if 链；未来默认板为暗色可并存）', () => {
  assert.strictEqual(countOccurrences(tsTemplate, 'v-if="palette.id === DEFAULT_THEME_PALETTE_ID"'), 1, '默认徽章条件出现次数漂移');
  assert.strictEqual(countOccurrences(tsTemplate, 'v-if="palette.isDark"'), 1, '暗色徽章条件出现次数漂移');
  assert.ok(!tsTemplate.includes('v-else-if="palette.isDark"'), '暗色徽章被写成 else-if（条件耦合，违背独立语义）');
});
check('G2-03d 徽章位于名称行（palette-name 切片内，名称插值在前）', () => {
  const nameStart = tsTemplate.indexOf('<span class="palette-name">');
  assert.ok(nameStart !== -1, 'palette-name 行缺失');
  const nameZone = tsTemplate.slice(nameStart, tsTemplate.indexOf('</button>', nameStart));
  assert.ok(nameZone.includes('{{ palette.name }}'), '名称插值不在名称行');
  assert.ok(nameZone.includes('palette-badge--muted') && nameZone.includes('palette-badge--accent'), '徽章不在名称行切片内');
});
check('G2-03e 徽章三块样式在场且全 token（无硬编码 hex）', () => {
  const base = cssBlock(tsStyle, '.palette-badge {');
  assert.ok(base.includes('padding:') && base.includes('font-size:') && base.includes('border-radius: var(--radius-pill);'), '徽章基础样式漂移');
  const muted = cssBlock(tsStyle, '.palette-badge--muted {');
  assert.ok(muted.includes('var(--color-text-muted)'), 'muted 变体未引用 token');
  const accent = cssBlock(tsStyle, '.palette-badge--accent {');
  assert.ok(accent.includes('var(--color-accent'), 'accent 变体未引用 token');
  for (const [n, blk] of [['base', base], ['muted', muted], ['accent', accent]] as const) {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(blk), `.palette-badge${n === 'base' ? '' : '--' + n} 块内出现硬编码 hex`);
  }
});

console.log('\n── G2-04 CDP 挂载半边（运行时断言落点 cdp-layout-e2e.mjs 配置页组）──');
check('G2-04 cdp-layout-e2e.mjs 存在 runG2Scenario 定义且已挂入 main 流程', () => {
  assert.ok(cdpLayout.includes('async function runG2Scenario()'), 'runG2Scenario 定义缺失');
  assert.ok(cdpLayout.includes('await runG2Scenario();'), 'runG2Scenario 未挂入 main 流程');
});

console.log('\n── G2-05 focus-visible 焦点环（token 引用，禁硬编码）──');
check('G2-05 .palette-card:focus-visible 焦点环：outline + var(--color-accent) + offset，零硬编码 hex', () => {
  const blk = cssBlock(tsStyle, '.palette-card:focus-visible {');
  assert.ok(/outline:\s*2px solid/.test(blk), '缺 outline 焦点环');
  assert.ok(blk.includes('var(--color-accent)'), '焦点环未引用 --color-accent');
  assert.ok(blk.includes('outline-offset:'), '缺 outline-offset');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(blk), '焦点环块内硬编码 hex');
});

console.log('\n── G2-06 active 态 accent 描边 + auto-fill 网格（保全钉，转写即绿属预期）──');
check('G2-06a .palette-card.active 描边仍 var(--color-accent)（禁硬编码）', () => {
  const blk = cssBlock(tsStyle, '.palette-card.active {');
  assert.ok(blk.includes('border-color: var(--color-accent);'), 'active 描边漂移');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(blk), 'active 块内硬编码 hex');
});
check('G2-06b 网格 auto-fill 形态不动（裁决 D5-⑤）', () => {
  const blk = cssBlock(tsStyle, '.theme-selector {');
  assert.ok(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(120px,\s*1fr\)\);/.test(blk), 'grid auto-fill 形态漂移');
});

console.log('\n── G2-07 12 套自动渲染 + 自注徽章归零（行为组 + 结构钉 + 负断言）──');
check('G2-07a 数据面 THEME_PALETTES.length === 12（与 A1 selftest-settings-mapping #43 同源）', () => {
  assert.strictEqual(THEME_PALETTES.length, 12, `色板 ${THEME_PALETTES.length} 套 ≠ 12`);
});
check('G2-07b 模板 v-for 遍历 THEME_PALETTES 自动渲染', () => {
  assert.ok(tsTemplate.includes('v-for="palette in THEME_PALETTES"'), '卡片未由 v-for 遍历 THEME_PALETTES 渲染');
});
check('G2-07c 负断言：组件文件零色板 id 字面（无手工写死固定卡）', () => {
  for (const p of THEME_PALETTES) {
    assert.ok(!tsFile.includes(`'${p.id}'`), `组件文件出现色板 id 字面 '${p.id}'（手工写死卡或旁路默认判定）`);
  }
});
check('G2-07d 负断言：「当前·本方案」「当前使用」类自注徽章字面归零', () => {
  assert.ok(!tsFile.includes('当前·本方案'), '「当前·本方案」自注徽章回归');
  assert.ok(!tsFile.includes('当前使用'), '「当前使用」自注字面残留');
  assert.ok(!tsFile.includes('当前方案'), '「当前方案」自注字面残留');
});

console.log('\n── G2-08 切换即时生效链路不变（保全钉）──');
check('G2-08a ConfigPage 绑定形态保持（:selected-id + @select 接线不动）', () => {
  assert.ok(cp.includes('<ThemeSelector :selected-id="store.config.themePaletteId" @select="handleThemeSelect" />'), 'ThemeSelector 接线形态漂移');
});
check('G2-08b handleThemeSelect → store 赋值 + applyTheme 链不重写', () => {
  const start = cp.indexOf('function handleThemeSelect(');
  assert.ok(start !== -1, 'handleThemeSelect 缺失');
  const blk = cp.slice(start, cp.indexOf('}', start) + 1);
  assert.ok(blk.includes('store.config.themePaletteId = paletteId;'), '选中真相源写入链漂移');
  assert.ok(blk.includes('applyTheme(paletteId);'), 'applyTheme 调用链漂移');
});
check('G2-08c 组件内不自建选中态（script 切片零 ref/reactive，selectedId 仅 defineProps 一处）', () => {
  assert.ok(!/const\s+\w+\s*=\s*ref</.test(tsScript), '组件内出现 ref 选中态（真相源旁路）');
  assert.ok(!tsScript.includes('reactive('), '组件内出现 reactive 选中态（真相源旁路）');
  assert.strictEqual(countOccurrences(tsScript, 'selectedId'), 1, `script 切片 selectedId 出现 ${countOccurrences(tsScript, 'selectedId')} 次 ≠ 1（仅 defineProps）`);
});

console.log('\n── A1 一致性核对（12 卡断言与 selftest-settings-mapping L1298-1301 四钉同源）──');
check('A1-一致 · DEFAULT_THEME_PALETTE_ID === inkstone', () => {
  assert.strictEqual(DEFAULT_THEME_PALETTE_ID, 'inkstone', `默认板 id=${DEFAULT_THEME_PALETTE_ID} ≠ inkstone`);
});
check('A1-一致 · 首套色板 id 为 inkstone（居首=未知 id 兜底同源默认）', () => {
  assert.strictEqual(THEME_PALETTES[0]?.id, 'inkstone', `首套色板 id=${THEME_PALETTES[0]?.id} ≠ inkstone`);
});
check('A1-一致 · isDark 白名单仅 terminal-pro', () => {
  assert.ok(THEME_PALETTES.every((p) => (p.id === 'terminal-pro' ? p.isDark === true : p.isDark === false)), 'isDark 集合与 A1 mapping 白名单脱钩');
});
check('A1-一致 · 默认板恰 1 套（徽章语义良定义）', () => {
  assert.strictEqual(THEME_PALETTES.filter((p) => p.id === DEFAULT_THEME_PALETTE_ID).length, 1, '默认板 id 命中数 ≠ 1');
});

console.log('\n=== G 配置页核心契约（G3 小节）===\n');

// G3 切片：nav.tabs / 行为 tab / 外观 tab（含字号 field）/ 脚本区。
const cpScript = cp.slice(0, tplStart);
const navStart = template.indexOf('<nav class="tabs"');
const navEnd = template.indexOf('</nav>', navStart);
const navSlice = template.slice(navStart, navEnd);
const behaviorStart = template.indexOf("v-show=\"activeTab === 'behavior'\"");
const appearanceStart = template.indexOf("v-show=\"activeTab === 'appearance'\"");
const imStart = template.indexOf("v-show=\"activeTab === 'im'\"");
const behaviorSlice = behaviorStart >= 0 && appearanceStart > behaviorStart ? template.slice(behaviorStart, appearanceStart) : '';
const appearanceSlice = appearanceStart >= 0 && imStart > appearanceStart ? template.slice(appearanceStart, imStart) : '';

const G3_TAB_IDS = ['connection', 'behavior', 'appearance', 'skill', 'mcp', 'im', 'web', 'about'] as const;

console.log('── G3-01 返回钮列左置（取消 margin-left:auto 右推；静态半边）──');
check('G3-01s .back-button 规则不含 margin-left: auto（右推形态负断言）', () => {
  const blk = cssBlock(style, '.back-button {');
  assert.ok(!blk.includes('margin-left: auto'), '.back-button 仍含 margin-left: auto（右推回归）');
});
check('G3-01s .back-button 规则主体声明保全（border/padding 未随删行丢失）', () => {
  const blk = cssBlock(style, '.back-button {');
  assert.ok(blk.includes('border: 1px solid var(--color-border)'), '.back-button border 声明丢失');
  assert.ok(blk.includes('padding:'), '.back-button padding 声明丢失');
});

console.log('── G3-02 tab 导航语义三件套 + v-show 面板形态保持 ──');
check('G3-02a nav.tabs 加 role="tablist"（aria-label 既有文案不动）', () => {
  assert.ok(navStart !== -1 && navEnd > navStart, 'nav.tabs 未找到');
  assert.ok(template.includes('<nav class="tabs" aria-label="设置分类" role="tablist">'), 'nav.tabs 缺 role="tablist" 或 aria-label 文案漂移');
});
check('G3-02b 8 个 tab button 均有 id="cfg-tab-*" + role="tab" + :aria-selected 动态绑定', () => {
  assert.strictEqual(countOccurrences(navSlice, 'role="tab"'), 8, `nav 内 role="tab" 计数 ${countOccurrences(navSlice, 'role="tab"')} ≠ 8`);
  assert.strictEqual(countOccurrences(navSlice, ':aria-selected="activeTab ==='), 8, ':aria-selected 动态绑定计数 ≠ 8');
  for (const id of G3_TAB_IDS) {
    assert.ok(navSlice.includes(`id="cfg-tab-${id}"`), `缺 id="cfg-tab-${id}"`);
  }
});
check('G3-02c 负断言：aria-selected 不得写死（无静态 aria-selected="true"/"false"）', () => {
  assert.strictEqual(countOccurrences(navSlice, 'aria-selected="true"'), 0, '存在写死 aria-selected="true"');
  assert.strictEqual(countOccurrences(navSlice, 'aria-selected="false"'), 0, '存在写死 aria-selected="false"');
});
check('G3-02d 8 个 tab 面板均有 role="tabpanel" + aria-labelledby="cfg-tab-{id}"（配对）', () => {
  for (const id of G3_TAB_IDS) {
    assert.ok(template.includes(`role="tabpanel" aria-labelledby="cfg-tab-${id}"`), `缺 tabpanel 配对（${id}）`);
  }
  assert.strictEqual(countOccurrences(template, 'role="tabpanel"'), 8, `role="tabpanel" 计数 ≠ 8`);
});
check('G3-02e 面板仍为 v-show 常挂（负断言：不得改 v-if——IM 扫码链/Skill-MCP 探测态不重置）', () => {
  assert.strictEqual(countOccurrences(template, 'v-show="activeTab ==='), 8, `v-show="activeTab === 计数 ${countOccurrences(template, 'v-show="activeTab ===')} ≠ 8`);
  assert.strictEqual(countOccurrences(template, 'v-if="activeTab ==='), 0, '面板被改为 v-if（tab 切换会重置常挂态）');
});
check('G3-02f tab 按钮文案逐字保全（含 app-updater 锚 >关于</button>）', () => {
  for (const label of ['连接', '行为', '外观', 'Skill', 'MCP', 'IM', '网页访问', '关于']) {
    assert.ok(navSlice.includes(`>${label}</button>`), `tab 按钮文案「${label}」漂移`);
  }
});

console.log('── G3-03 字号控件 seg 三档（radiogroup + 方向键可选 + 即时生效；静态半边）──');
check('G3-03a 负断言：字号 <select> 移除、旧 handleFontScaleChange 删除', () => {
  assert.strictEqual(countOccurrences(appearanceSlice, '<select'), 0, '外观 tab 残留 <select>（字号未 seg 化）');
  assert.ok(!cpScript.includes('handleFontScaleChange'), '旧 handler handleFontScaleChange 残留');
});
check('G3-03b 外层 label 改 div（裁决 C-G3-2：label 隐式激活 bug 消除）+ label span 加 id', () => {
  assert.ok(appearanceSlice.includes('<span id="cfg-font-scale-label" class="field-label">字号</span>'), '字号 label span 缺 id 或文案漂移');
  assert.strictEqual(countOccurrences(appearanceSlice, '<label class="field'), 0, '外观 tab 仍有 label.field 包裹（隐式激活 bug 未除）');
});
check('G3-03c seg 容器 role="radiogroup" + aria-labelledby + 方向键接线', () => {
  assert.ok(appearanceSlice.includes('<div class="font-seg" role="radiogroup" aria-labelledby="cfg-font-scale-label" @keydown="onFontScaleKeydown">'), 'seg 容器形态漂移（role/aria-labelledby/@keydown）');
});
check('G3-03d 三档 radio：v-for FONT_SCALE_OPTIONS + :aria-checked 动态 + roving tabindex', () => {
  assert.ok(appearanceSlice.includes('v-for="opt in FONT_SCALE_OPTIONS"'), '三档未由 v-for FONT_SCALE_OPTIONS 渲染');
  assert.ok(appearanceSlice.includes('role="radio"'), '缺 role="radio"');
  assert.ok(appearanceSlice.includes(':aria-checked="store.config.fontScale === opt.value"'), ':aria-checked 绑定漂移或写死');
  assert.ok(appearanceSlice.includes(':tabindex="store.config.fontScale === opt.value ? 0 : -1"'), 'roving tabindex 绑定漂移');
  assert.ok(appearanceSlice.includes('@click="selectFontScale(opt.value)"'), '点击接线漂移');
});
check('G3-03e 数值运行时派生自 FONT_SCALE_SIZES（裁决；常量三键值 14/16/18 不重定义）', () => {
  assert.strictEqual(FONT_SCALE_SIZES.small, '14px', `FONT_SCALE_SIZES.small=${FONT_SCALE_SIZES.small} ≠ 14px（常量被重定义）`);
  assert.strictEqual(FONT_SCALE_SIZES.medium, '16px', `FONT_SCALE_SIZES.medium=${FONT_SCALE_SIZES.medium} ≠ 16px（常量被重定义）`);
  assert.strictEqual(FONT_SCALE_SIZES.large, '18px', `FONT_SCALE_SIZES.large=${FONT_SCALE_SIZES.large} ≠ 18px（常量被重定义）`);
  assert.ok(cpScript.includes("(['small', 'medium', 'large'] as const).map((value) => ({"), 'FONT_SCALE_OPTIONS 未从固定档序派生');
  assert.ok(cpScript.includes('parseInt(FONT_SCALE_SIZES[value] ?? \'\', 10)'), '档位数值未由 parseInt(FONT_SCALE_SIZES…) 派生（硬编码漂移）');
  assert.ok(cpScript.includes('${FONT_SCALE_LABELS[value]} ${parseInt(FONT_SCALE_SIZES[value] ?? \'\', 10)}'), '按钮文案未按「小 14」形态派生');
});
check('G3-03f selectFontScale：写 store + applyFontScale（切换即时生效链，与旧 @change 链等价）', () => {
  const start = cpScript.indexOf('function selectFontScale(');
  assert.ok(start !== -1, 'selectFontScale 缺失');
  const blk = cpScript.slice(start, cpScript.indexOf('}', start) + 1);
  assert.ok(blk.includes('store.config.fontScale = scale;'), '真相源写入链漂移');
  assert.ok(blk.includes('applyFontScale(scale);'), '即时应用链漂移');
});
check('G3-03g onFontScaleKeydown：四方向键可选 + preventDefault + 焦点跟随', () => {
  const start = cpScript.indexOf('function onFontScaleKeydown(');
  assert.ok(start !== -1, 'onFontScaleKeydown 缺失');
  const blk = cpScript.slice(start, cpScript.indexOf('}', start) + 1);
  for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    assert.ok(blk.includes(`'${k}'`), `方向键 ${k} 未接线`);
  }
  assert.ok(blk.includes('e.preventDefault()'), '方向键未 preventDefault（页面滚动/焦点逃逸风险）');
  assert.ok(blk.includes('.focus()'), '焦点未跟随（roving tabindex 断裂）');
});
check('G3-03h 方向键到端点停不循环（Owner 裁决；impl §3.2 样例 % 循环按裁决修正）', () => {
  const start = cpScript.indexOf('function onFontScaleKeydown(');
  const blk = cpScript.slice(start, cpScript.indexOf('}', start) + 1);
  assert.ok(blk.includes('Math.min') && blk.includes('Math.max'), '端点未用 clamp 收敛（Math.min/Math.max 缺失）');
  assert.ok(!blk.includes('% opts.length'), '存在 % 循环回绕（违背端点停裁决）');
});
check('G3-03i .font-seg 组样式就近 hairline 规则之后 + 配色走 token（无硬编码 hex）', () => {
  const segPos = style.indexOf('.font-seg {');
  const hairlinePos = style.indexOf('.section .theme-selector + .field {');
  assert.ok(segPos > hairlinePos, '.font-seg 组样式未插在 theme-selector+field hairline 规则之后');
  // 组块 = 自 .font-seg { 起至 .font-seg__opt:focus-visible 规则闭合（G3 组连续规则段）。
  const fvPos = style.indexOf('.font-seg__opt:focus-visible', segPos);
  assert.ok(fvPos !== -1, '缺 .font-seg__opt:focus-visible 规则');
  const segBlk = style.slice(segPos, style.indexOf('}', fvPos) + 1);
  assert.ok(segBlk.includes('display: flex;'), '.font-seg 缺 flex 形制');
  assert.ok(segBlk.includes('color-mix(in srgb, var(--color-accent) 12%, transparent)'), 'active 底色非 accent 12% color-mix');
  assert.ok(segBlk.includes('var(--color-accent-strong)'), 'active 文字色非 accent-strong');
  const hex = segBlk.match(/#[0-9a-fA-F]{3,8}\b/g);
  assert.ok(!hex, `.font-seg 组样式出现硬编码色值：${hex?.join(', ')}`);
});

console.log('── G3-04 行为 tab 8 字段顺序与全部文案逐字保持（防倒退钉）──');
check('G3-04a 切片锚有效（behavior→appearance 之间）', () => {
  assert.ok(behaviorStart !== -1 && appearanceStart > behaviorStart, '行为/外观切片边界失效');
});
check('G3-04b 8 个 field-label 依序恰为既定清单（禁按原型重排）', () => {
  const labels = ['最大轮次', '开启队列任务', '队列任务间隔（分钟）', '默认思考强度', '默认权限', '离开会话后通知', '后台运行', '上游错误自动重试'];
  let pos = 0;
  for (const l of labels) {
    const at = behaviorSlice.indexOf(`>${l}</span>`, pos);
    assert.ok(at !== -1, `field-label「${l}」缺失或次序前移`);
    pos = at + l.length;
  }
});
check('G3-04c 8 条 field-desc 逐字锚保全', () => {
  const descs = [
    '单次会话最大工具调用轮数',
    '回复生成中可在会话框继续输入并发送',
    '回复结束 / 上一队列任务完成后，等待多少分钟执行下一个队列任务。手填 1-60，最低 1 分钟。',
    '新会话默认档；「工作流」档成本最高（Beta）。会话内可单独调整。',
    '新会话默认档；会话内可单独调整。',
    '窗口失焦时，任务完成/网络中断弹系统通知并闪烁任务栏',
    '开启后托盘图标常驻右下角',
    '命中 reasoning_replay 等上游错误时自动原样重试一次',
  ];
  for (const d of descs) {
    assert.ok(behaviorSlice.includes(d), `desc 字面漂移/丢失：「${d.slice(0, 18)}…」`);
  }
});
check('G3-04d desc code 标记保持（--max-turns <code> 包裹）+ section-title「行为」不动', () => {
  assert.ok(behaviorSlice.includes('<code>--max-turns</code>'), '--max-turns code 标记漂移');
  assert.ok(behaviorSlice.includes('<h3 class="section-title">行为</h3>'), '行为 section-title 漂移');
});
check('G3-04e 负断言：切片内「分组方式」归零（勿按原型新增分组项）+ select option 计数 10', () => {
  assert.strictEqual(countOccurrences(behaviorSlice, '分组方式'), 0, '出现「分组方式」项（原型重排污染）');
  assert.strictEqual(countOccurrences(behaviorSlice, '<option'), 10, `select option 计数 ${countOccurrences(behaviorSlice, '<option')} ≠ 10（思考 6 + 权限 4）`);
  assert.ok(behaviorSlice.includes('>中（平衡，默认）</option>'), '思考档 option 文案漂移');
  assert.ok(behaviorSlice.includes('>工作流（xhigh + 动态工作流，Beta）</option>'), '工作流 option 文案漂移');
});

console.log('── G3-05 保存徽标五态/自动保存/立即保存/存储与诊断/深链保全（防倒退钉）──');
check('G3-05a save-badge 五态映射与文案逐字', () => {
  assert.ok(template.includes("save-badge--${saveStatus === 'projection-failed' ? 'saved' : saveStatus}"), 'projection-failed→saved class 映射漂移');
  for (const t of ['保存中…', '保存成功', '已保存（投影失败）', '保存失败']) {
    assert.ok(template.includes(t), `徽标文案缺失：「${t}」`);
  }
  assert.ok(template.includes('save-badge__dot'), 'saving 态 spinner 圆点丢失');
});
check('G3-05b PERSISTED_FIELDS 自动保存链含 fontScale/themePaletteId', () => {
  const m = cpScript.match(/const PERSISTED_FIELDS = \[[\s\S]*?\] as const;/);
  assert.ok(m, 'PERSISTED_FIELDS 形态漂移');
  assert.ok(m[0].includes("'fontScale'"), 'PERSISTED_FIELDS 缺 fontScale');
  assert.ok(m[0].includes("'themePaletteId'"), 'PERSISTED_FIELDS 缺 themePaletteId');
});
check('G3-05c 「立即保存」钮保持（handleSave 接线）', () => {
  assert.ok(template.includes('@click="handleSave"'), 'handleSave 接线漂移');
  assert.ok(template.includes('>立即保存</button>'), '立即保存钮文案漂移');
});
check('G3-05d 存储目录 details + 原生 settings 诊断 details 保持', () => {
  assert.ok(template.includes('>配置与数据存储目录</summary>'), '存储目录 details 漂移');
  assert.ok(template.includes('>Claude Code 原生 settings 诊断</summary>'), '诊断 details 漂移');
});
check('G3-05e ?tab= 深链解析保持（TabId 八值有序 + query.tab 白名单链）', () => {
  assert.ok(/type TabId = 'connection' \| 'behavior' \| 'appearance' \| 'skill' \| 'mcp' \| 'im' \| 'web' \| 'about';/.test(cpScript), 'TabId 八值有序字面漂移');
  assert.ok(cpScript.includes('route.query.tab'), '深链解析 route.query.tab 漂移');
  assert.ok(cpScript.includes('(TAB_IDS as readonly string[]).includes(q)'), '非法 tab 白名单忽略链漂移');
});

console.log('── G3-06 数字输入保留 type=number 与夹取链不变（保全钉）──');
check('G3-06a maxTurns：v-model.number + type=number + @blur 夹取（f2 同源字面）', () => {
  assert.ok(/v-model\.number="store\.config\.maxTurns"[^>]*@blur="clampMaxTurns"/.test(behaviorSlice), 'maxTurns 夹取链漂移');
  assert.ok(behaviorSlice.includes('type="number"'), 'maxTurns 输入 type=number 漂移');
});
check('G3-06b taskDelayMinutes：type=number + @blur 夹取保持', () => {
  assert.ok(behaviorSlice.includes('@blur="clampTaskDelayMinutes"'), 'taskDelayMinutes 夹取链漂移');
  const at = behaviorSlice.indexOf('v-model.number="store.config.taskDelayMinutes"');
  assert.ok(at !== -1, 'taskDelayMinutes 绑定漂移');
  assert.ok(behaviorSlice.slice(at, at + 220).includes('type="number"'), 'taskDelayMinutes 输入 type=number 漂移');
});
check('G3-06c 负断言：两数字输入未被改 select（骨架重做不得换控件）', () => {
  const mtAt = behaviorSlice.indexOf('v-model.number="store.config.maxTurns"');
  const tdAt = behaviorSlice.indexOf('v-model.number="store.config.taskDelayMinutes"');
  assert.ok(mtAt !== -1 && tdAt !== -1, '两数字输入绑定缺失');
  assert.ok(!behaviorSlice.slice(mtAt, mtAt + 220).includes('<select'), 'maxTurns 被改 select');
  assert.ok(!behaviorSlice.slice(tdAt, tdAt + 220).includes('<select'), 'taskDelayMinutes 被改 select');
});

// ════════ G4 小节（点 G4：端口/Host Enter 通道 + Host 变化 toast + 500ms 去重）════════
// 函数体切片：深度计数（模板串 ${…} 的花括号成对平衡，无需字符串态机——函数体含嵌套块时深度
// 正确归零）。锚缺失返回空串落为单条 ❌（G3 behaviorSlice 同款安全切片口径），不让模块加载期
// 崩溃吞掉其余小节结果。
function jsFnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return '';
  const open = src.indexOf('{', start);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

const onWaEnterBody = jsFnBody(cpScript, 'onWaEnter');
const clampWaPortBody = jsFnBody(cpScript, 'clampWaPort');
const normalizeWaBody = jsFnBody(cpScript, 'normalizeWaAllowedHosts');

// 端口/Host 两个 input 标签切片（以 v-model 绑定为锚取 ±240 字符窗，覆盖属性追加形态）。
const waPortTag = (() => {
  const at = template.indexOf('v-model.number="waPort"');
  return at === -1 ? '' : template.slice(Math.max(0, at - 60), at + 240);
})();
const waHostTag = (() => {
  const at = template.indexOf('v-model="waAllowedHostsText"');
  return at === -1 ? '' : template.slice(Math.max(0, at - 60), at + 240);
})();

console.log('\n=== G 配置页核心契约（G4 小节）===\n');
console.log('── G4-01/G4-02 Enter 等效失焦通道（接线在两输入、handler 内 preventDefault+blur）──');
check('G4-01 端口 input @keydown.enter="onWaEnter" 接线在场（无 .prevent 修饰符，C-G4-1）', () => {
  assert.ok(waPortTag.includes('@keydown.enter="onWaEnter"'), '端口 input 缺 @keydown.enter="onWaEnter" 接线');
  assert.ok(!waPortTag.includes('@keydown.enter.prevent'), '端口 Enter 不得用 .prevent 修饰符（守卫必须先行）');
  assert.ok(!/@keydown\.enter\.[a-z]/.test(waPortTag), '端口 Enter 不得携带任何修饰符');
});
check('G4-01 onWaEnter 内 preventDefault + blur()（等效失焦：blur 后走既有 @blur="clampWaPort" 夹取链）', () => {
  assert.ok(onWaEnterBody.includes('e.preventDefault()'), 'onWaEnter 未 preventDefault（Enter 默认行为未拦）');
  assert.ok(onWaEnterBody.includes('.blur()'), 'onWaEnter 未触发 blur（等效失焦语义缺失，Enter 通道未走夹取链）');
  assert.ok(clampWaPortBody.includes('sanitizeWebAccessConfig'), 'clampWaPort 夹取链漂移（Enter 等效目标不在场）');
});
check('G4-02 Host input @keydown.enter="onWaEnter" 接线在场（与 @blur 同一归一化函数，裁决 G4-6 两路径共用）', () => {
  assert.ok(waHostTag.includes('@keydown.enter="onWaEnter"'), 'Host input 缺 @keydown.enter="onWaEnter" 接线');
  assert.ok(!/@keydown\.enter\.[a-z]/.test(waHostTag), 'Host Enter 不得携带任何修饰符');
  assert.ok(waHostTag.includes('@blur="normalizeWaAllowedHosts"'), 'Host @blur 归一化接线漂移');
  assert.ok(normalizeWaBody.includes('sanitizeWebAccessConfig'), 'normalizeWaAllowedHosts 归一化链漂移');
});

console.log('── G4-03 Host 归一化 toast（值变才弹 / 文案逐字 / N=归一后条数 / 端口零 toast）──');
check('G4-03① toast 在「归一化前后值确实不同」分支内（值未变 return 在 toast 之前）', () => {
  const cmpAt = normalizeWaBody.indexOf('JSON.stringify(next.allowedHosts) === JSON.stringify(before)');
  assert.ok(cmpAt !== -1, '值变化判定缺失（未比较归一化前后 allowedHosts）');
  const showToastAt = normalizeWaBody.indexOf('showToast(');
  assert.ok(showToastAt !== -1, 'normalizeWaAllowedHosts 未接 showToast');
  assert.ok(showToastAt > cmpAt, 'showToast 位于值比较之前（无条件弹）');
  // 值未变的提前返回：比较分支成立的 return 必须存在且先于 toast。
  assert.ok(/\)\s*return;/.test(normalizeWaBody.slice(cmpAt, showToastAt)), '值未变分支未提前 return（会无条件弹 toast）');
});
check('G4-03② 文案逐字模板「Host 白名单已保存 · 共 N 条（已归一化）」且 N=归一后（next）条数', () => {
  assert.ok(
    normalizeWaBody.includes('`Host 白名单已保存 · 共 ${next.allowedHosts.length} 条（已归一化）`'),
    'toast 文案模板漂移（须逐字 `Host 白名单已保存 · 共 ${next.allowedHosts.length} 条（已归一化）`）',
  );
  assert.ok(!normalizeWaBody.includes('before.allowedHosts.length'), 'N 取了归一化前条数（违反裁决 G4-6）');
  const nextAt = normalizeWaBody.indexOf('const next = sanitizeWebAccessConfig(waRaw())');
  assert.ok(nextAt !== -1, '归一化结果未存 next（N=归一后条数的数据源缺失）');
});
check('G4-03④ 端口零 toast 负断言：clampWaPort 与 onWaEnter 体均无 showToast', () => {
  assert.ok(!clampWaPortBody.includes('showToast'), '端口夹取路径出现 toast（行为规范明示端口无 toast）');
  assert.ok(!onWaEnterBody.includes('showToast'), 'onWaEnter 通道出现 toast（toast 只归 normalize 值变分支）');
});

console.log('── G4-04 IME 守卫（isComposing / keyCode 229 先行；与 ChatPage onGlobalKeydown 同口径）──');
check('G4-04a onWaEnter 入口守卫字面与 ChatPage 同口径（isComposing || keyCode === 229 → return）', () => {
  const chatPage = read('src/renderer/pages/ChatPage.vue');
  const guardAt = chatPage.indexOf('if (e.isComposing || e.keyCode === 229) return;');
  assert.ok(guardAt !== -1, '同口径锚失效：ChatPage onGlobalKeydown 守卫字面缺失（基准漂移）');
  assert.ok(
    onWaEnterBody.includes('if (e.isComposing || e.keyCode === 229) return;'),
    'onWaEnter 缺 IME 守卫（组词确认回车会误触发夹取/归一化/保存）',
  );
});
check('G4-04b 守卫先于 preventDefault 与 blur（C-G4-1：组合态不 preventDefault）', () => {
  const guardAt = onWaEnterBody.indexOf('if (e.isComposing || e.keyCode === 229) return;');
  const pdAt = onWaEnterBody.indexOf('e.preventDefault()');
  const blurAt = onWaEnterBody.indexOf('.blur()');
  assert.ok(guardAt !== -1 && pdAt !== -1 && blurAt !== -1, '守卫/preventDefault/blur 三要素缺失');
  assert.ok(guardAt < pdAt, '守卫未先于 preventDefault（组合态组词上屏可能被拦）');
  assert.ok(guardAt < blurAt, '守卫未先于 blur');
});

console.log('── G4-05 两次归一 500ms 内去重（防连按重复弹）──');
check('G4-05a lastWaHostsToastAt 时间戳变量在场（脚本级 let，非 ref）', () => {
  assert.ok(/let lastWaHostsToastAt = 0;/.test(cpScript), '去重时间戳变量缺失');
  assert.ok(!cpScript.includes('const lastWaHostsToastAt = ref'), '去重时间戳不得为 ref（非渲染态）');
});
check('G4-05b 500ms 常量窗比较 + 时间戳更新先于 toast（去重分支形态）', () => {
  assert.ok(/now - lastWaHostsToastAt < 500/.test(normalizeWaBody), '去重窗常量漂移（须 500；改大吞正常提示/改小去重失效）');
  const winAt = normalizeWaBody.indexOf('now - lastWaHostsToastAt < 500');
  const stampAt = normalizeWaBody.indexOf('lastWaHostsToastAt = now');
  const toastAt = normalizeWaBody.indexOf('showToast(');
  assert.ok(winAt !== -1 && stampAt !== -1 && toastAt !== -1, '去重分支三要素缺失');
  assert.ok(stampAt > winAt, '时间戳更新未在去重判定之后');
  assert.ok(toastAt > stampAt, 'toast 弹出未在时间戳更新之后（连按去重失效）');
  const nowAt = normalizeWaBody.indexOf('const now = Date.now()');
  assert.ok(nowAt !== -1 && nowAt < winAt, 'Date.now() 取值缺失或未先于窗口比较');
});

console.log('── G4-06 失焦既有通道保全（Enter 是叠加不是替换；转写即绿属预期）──');
check('G4-06a @blur="clampWaPort" 与 @blur="normalizeWaAllowedHosts" 字面各恰一在场', () => {
  assert.strictEqual(countOccurrences(template, '@blur="clampWaPort"'), 1, '@blur="clampWaPort" 保全失败');
  assert.strictEqual(countOccurrences(template, '@blur="normalizeWaAllowedHosts"'), 1, '@blur="normalizeWaAllowedHosts" 保全失败');
});
check('G4-06b 端口 type="number" min/max 与 Host placeholder 逐字保持', () => {
  assert.ok(waPortTag.includes('type="number" min="1024" max="65535"'), '端口 input type/min/max 漂移');
  assert.ok(waHostTag.includes('placeholder="隧道/反代域名，如 link.example.top"'), 'Host placeholder 漂移');
});
check('G4-06c @keydown.enter="onWaEnter" 全模板恰两处（端口+Host，不外溢）', () => {
  assert.strictEqual(countOccurrences(template, '@keydown.enter="onWaEnter"'), 2, 'Enter 接线数量 ≠ 2（替换了别的输入的既有行为或漏接一处）');
});
check('G4 附 CDP 挂载半边：cdp-layout-e2e.mjs 存在 runG4Scenario 定义与 main 流程挂载（静态钉）', () => {
  assert.ok(cdpLayout.includes('async function runG4Scenario()'), 'cdp-layout-e2e.mjs 缺 runG4Scenario 定义');
  assert.ok(cdpLayout.includes('await runG4Scenario();'), 'cdp-layout-e2e.mjs main 流程未挂载 runG4Scenario');
});

console.log('\n=== G 配置页核心契约（G5 小节）===\n');

// G5 小节（点 G5，2026-11-10 增；用例正本 = docs/ui-completion/tests/G-config-core-cases.md
//   G5 节 G5-01~G5-03；实现细节 = impl/G-config-core-impl.md §5（L484-501）；裁决：fallback
//   行号 591；--color-danger 变量定义于 variables.css（#8B3A3A）且 applyTheme 按板覆写，
//   fallback 永不生效——仅删 fallback 段，渲染零变化）：
//   G5-01 待删组件全仓删除且零引用残留：文件不存在 + src/ scripts/ 全树 + 根级 *.json /
//         tsconfig*.json 字面归零（负断言，防删文件留 import / 删一半）。
//   G5-02 3 处带 fallback 的 danger 引用清理：#d64545 字面归零 + var(--color-danger, 形态
//         归零 + 三目标选择器块仍保留 color: var(--color-danger);（防整条 color 声明删除的
//         过度清理）+ bare 引用计数快照钉 === 6 + 全文件无 , #hex fallback 形态 --color-* 引用。
//   G5-03 typecheck 验收门 = npm run typecheck（命令形态，见点测试命令，不在本脚本内断言）。
//   注意：本小节自身位于 scripts/ 树内且树扫描覆盖本文件——目标字面量必须以 join 构造，
//   本文件任何位置（含注释）不得出现拼接后的完整字面量。
const G5_NAME = ['Api', 'Key', 'Input'].join('');

function listTextFiles(dirAbs: string): string[] {
  const out: string[] = [];
  if (!existsSync(dirAbs)) return out;
  for (const e of readdirSync(dirAbs, { withFileTypes: true })) {
    const p = join(dirAbs, e.name);
    if (e.isDirectory()) out.push(...listTextFiles(p));
    else if (/\.(ts|tsx|vue|js|mjs|cjs|json|txt|md|css|scss|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

const pmFile = read('src/renderer/components/providers/ProviderManager.vue');
const pmStyle = pmFile.slice(pmFile.indexOf('<style'));

check('G5-01a 待删组件文件不存在（清理已执行）', () => {
  assert.ok(!existsSync(join(repoRoot, 'src/renderer/components/config', `${G5_NAME}.vue`)), '组件文件仍存在（未删除或删一半）');
});
check('G5-01b src/ scripts/ 全树 + 根级 *.json / tsconfig*.json 目标字面归零（零引用残留）', () => {
  const scanRoots = [
    join(repoRoot, 'src'),
    join(repoRoot, 'scripts'),
    join(repoRoot, 'package.json'),
    join(repoRoot, 'package-lock.json'),
    join(repoRoot, 'tsconfig.json'),
    join(repoRoot, 'tsconfig.node.json'),
    join(repoRoot, 'tsconfig.scripts.json'),
    join(repoRoot, 'tsconfig.tdd.json'),
    join(repoRoot, 'tsconfig.web.json'),
  ];
  const files: string[] = [];
  for (const r of scanRoots) {
    if (existsSync(r) && statSync(r).isDirectory()) files.push(...listTextFiles(r));
    else if (existsSync(r)) files.push(r);
  }
  const hits: string[] = [];
  for (const f of files) {
    let s: string;
    try { s = readFileSync(f, 'utf8'); } catch { continue; }
    if (s.includes(G5_NAME)) hits.push(f);
  }
  assert.strictEqual(hits.length, 0, `目标字面残留 ${hits.length} 处：${hits.slice(0, 5).map((h) => h.replace(repoRoot, '.')).join(' ; ')}`);
});
check('G5-02a 硬编码 fallback 字面 #d64545 归零（负断言）', () => {
  assert.strictEqual(countOccurrences(pmFile, '#d64545'), 0, '残留 #d64545 fallback 字面');
});
check('G5-02b var(--color-danger, 带 fallback 形态归零（负断言，全文件）', () => {
  assert.strictEqual(countOccurrences(pmFile, 'var(--color-danger,'), 0, '残留带 fallback 段的 danger 引用');
});
check('G5-02c 三目标选择器块仍保留无 fallback 形态 color: var(--color-danger);（防整条删除的过度清理）', () => {
  for (const sel of ['.pitem .meta .key-broken {', '.plist-empty--error {', '.empty--error {']) {
    const blk = cssBlock(pmStyle, sel);
    assert.ok(blk.includes('color: var(--color-danger);'), `${sel} 块内 var 引用丢失或形态漂移`);
    assert.ok(!blk.includes('#'), `${sel} 块内出现硬编码色值`);
  }
});
check('G5-02d bare var(--color-danger) 引用计数快照钉 === 6（清理位 3 + 既有 color-mix/color 3）', () => {
  assert.strictEqual(countOccurrences(pmFile, 'var(--color-danger)'), 6, 'bare 引用计数漂移（过度清理或新增未申报改动）');
});
check('G5-02e 负断言：全文件无 , #hex fallback 形态的 --color-* 引用（通用红线落点）', () => {
  assert.ok(!/--color-[a-z-]+,\s*#/.test(pmFile), '存在 --color-* 带 #hex fallback 的引用');
});
console.log('  ℹ️ G5-03 typecheck 验收门 = npm run typecheck（node+web+scripts+tdd 四段，命令形态，见点测试命令）');

console.log('\n── 契约脚本注册（两处）──');
check('注册 · scripts/selftest-static-list.txt 尾部含本脚本', () => {
  assert.ok(staticList.includes('scripts/tdd-config-core-g1-g5-verify.ts'), 'static list 未登记');
});
check('注册 · tsconfig.tdd.json include 含本脚本', () => {
  assert.ok(tsconfigTdd.includes('scripts/tdd-config-core-g1-g5-verify.ts'), 'tsconfig.tdd.json include 未登记');
});

console.log(`\n[G 配置页核心契约 · G1+G2+G3+G4+G5] 通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
