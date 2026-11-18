// tdd-web-parity-gaps-verify.ts
// 八问题批次 D3 网页版补齐四小项契约脚本
// （docs/plans/2026-11-15-eight-issues-batch/03b-test-cases-renderer.md §9 D3-1/D3-2/D3-3/D3-5；
//   行为契约唯一事实源 = 00-behavior-specs.md 域 D D3 节；实现细节 = 02-impl-details-renderer.md §8。
//   D3-4 同类长通道核查为核查申报型（03b §9 D3-4「断言形态：核查申报（非自动断言）」），
//   核对清单进实施报告，不在本脚本自动断言。）
// 用例意图（03b §9）：
//   D3-1 copyLink 网页端降级（钉 + spawn 护栏）：
//     ①ConfigPage isWebRuntime 常量同式钉（typeof window !== 'undefined' &&
//       (window as any).__claudeLinkWebBridge === true，与 App.vue 同式——web 判定唯一判据）；
//     ②web 分支走 copyTextToClipboard（utils/clipboard 既有降级链 import 锚——ConfigPage 位于
//       renderer/pages/ 一层深，相对路径 ../utils/clipboard；02 §8.1 写 ../../ 系按 components
//       两层深消费者笔误，实施按 vue-tsc 可解析路径落，申报留痕）+ toast——
//       失败文案含「请手动选择地址栏复制」指引（不假报成功=契约本体）；
//     ③桌面链保留钉——copyWebAccessLink 内 window.claudeLink.webAccessCopyLink(url) 仍在
//       （分支共存结构钉，桌面行为不变；web 分支先于桌面 invoke = 早退隔离）；
//     ④护栏：spawn tdd-web-secure-context-verify.ts（§D navigator.clipboard 字面仅
//       utils/clipboard.ts 白名单）退出码 0——本改动不得引入 navigator.clipboard 直调。
//   D3-2 UpdateDialog 立即安装钮网页端隐藏（钉 + spawn 回归门）：
//     ①立即安装钮（data-testid="update-dialog-install"）v-if="!isWebRuntime"（web 隐藏/桌面显示
//       两分支共存；script 新增同式 isWebRuntime 常量）；
//     ②稍后提醒钮（update-dialog-dismiss）不设 web 隐藏 v-if + 状态区（update-dialog-status）仍在
//       （检查/下载/稍后提醒保留）；ConfigPage about-check-btn 检查更新入口仍在；
//     ③回归门：spawn tdd-app-updater-verify.ts（46 钉含 installAppUpdate 接口保留——只藏 UI
//       不删 API）退出码 0。
//     范围申报（维持现状，不设钉）：关于 tab 重启更新入口（about-install-btn）与侧栏可更新徽标
//       不在本点契约文本内。
//   D3-3 CHANNEL_TIMEOUT_MS 两键补齐（行为直测）：import web-bridge 直测
//       CHANNEL_TIMEOUT_MS[IPC_CHANNELS.COMMANDS_REFRESH_GLOBAL] 与 [IPC_CHANNELS.COMMANDS_GET]
//       存在且 > 60_000 下界（具体值由实现定=120_000；03b §9「钉下界」）；既有两键覆盖值不回退。
//   D3-5 文档计数对齐（行为断言）：
//     ①src/preload/api.ts 头注释 N_doc === ClaudeLinkAPI 接口成员实数 N_actual（正则计数，
//       只读文档与头注释、不读实现体——守 03b 隔离纪律）；
//     ②CLAUDE.md 推送行「共 X 路」X === 行内 on* 列举数，且本批落地后 X === 17（15 既有 +
//       onSkillsProjectDirsChanged（UI13-P8 实际已存在）+ onMcpSnapshotChanged（本批 E2 新增）；
//       03b 写 16 系 E2 落地前估算，实落 +2 以实现细节 §8.4/实施指令的 17 为准）。
// 运行：npx tsx scripts/tdd-web-parity-gaps-verify.ts（登记 scripts/selftest-static-list.txt）
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as bridgeMod from '../src/renderer/web/web-bridge';
import { IPC_CHANNELS } from '../src/shared/constants';

const repoRoot = join(__dirname, '..');
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

const configPageSrc = read('src/renderer/pages/ConfigPage.vue');
const updateDialogSrc = read('src/renderer/components/layout/UpdateDialog.vue');
const appVueSrc = read('src/renderer/App.vue');
const apiSrc = read('src/preload/api.ts');
const bridgeSrc = read('src/renderer/web/web-bridge.ts');
const claudeMd = read('CLAUDE.md');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 与 run-selftest-static.ts 同 spawn 形态（npx tsx + win32 shell），退出码即判定。 */
function spawnGate(rel: string): boolean {
  const r = spawnSync('npx', ['tsx', rel], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.log(`  ---- ${rel} 输出（尾部） ----`);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.split(/\r?\n/).slice(-12).join('\n');
    console.log(out);
  }
  return r.status === 0;
}

/** isWebRuntime 常量的唯一合法形态（与 App.vue 既有行逐字同式；02 §8.1「同式」口径）。 */
const WEB_RUNTIME_CONST =
  "const isWebRuntime = typeof window !== 'undefined' && (window as any).__claudeLinkWebBridge === true;";

/** 截取 copyWebAccessLink 函数体（声明行起 → 首个行首 `}` 定界）。 */
function copyLinkBody(): string {
  const start = configPageSrc.indexOf('async function copyWebAccessLink(): Promise<void> {');
  if (start < 0) return '';
  const end = configPageSrc.indexOf('\n}', start);
  return configPageSrc.slice(start, end < 0 ? start + 600 : end);
}

/** 截取指定 data-testid 按钮的完整开标签（<button 起 → '>' 止）。 */
function buttonTag(src: string, testid: string): string {
  const idx = src.indexOf(`data-testid="${testid}"`);
  if (idx < 0) return '';
  const tagStart = src.lastIndexOf('<button', idx);
  const tagEnd = src.indexOf('>', idx);
  if (tagStart < 0 || tagEnd < 0 || tagEnd < idx) return '';
  return src.slice(tagStart, tagEnd + 1);
}

/** ClaudeLinkAPI 接口成员实数（正则计数：接口体内 2 空格缩进的 `name:` 行；跳过注释行）。 */
function countApiMembers(): number {
  const ifaceStart = apiSrc.indexOf('export interface ClaudeLinkAPI');
  const ifaceEnd = apiSrc.indexOf('\n}', ifaceStart);
  const body = ifaceStart < 0 || ifaceEnd < 0 ? '' : apiSrc.slice(ifaceStart, ifaceEnd);
  let count = 0;
  let inComment = false;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t.startsWith('/*')) inComment = true;
    if (inComment) { if (t.includes('*/')) inComment = false; continue; }
    if (t.startsWith('//') || t.startsWith('*') || t === '') continue;
    if (/^  [A-Za-z_$][A-Za-z0-9_$]*\s*:/.test(line)) count += 1;
  }
  return count;
}

console.log('\n=== D3-1a) copyLink：isWebRuntime 常量同式 + clipboard 降级链 import 锚 ===');
check('ConfigPage 模块级 isWebRuntime 常量（__claudeLinkWebBridge===true 同式，与 App.vue 逐字同形）',
  configPageSrc.includes(WEB_RUNTIME_CONST),
  'ConfigPage.vue 需新增 isWebRuntime 常量（判据 __claudeLinkWebBridge === true）');
check('App.vue 既有 isWebRuntime 同式对照（判据来源面未漂移）',
  appVueSrc.includes(WEB_RUNTIME_CONST));
check('ConfigPage import copyTextToClipboard（../utils/clipboard 既有降级链，pages/ 一层深）',
  /import \{ copyTextToClipboard \} from '\.\.\/utils\/clipboard';/.test(configPageSrc),
  "ConfigPage.vue 需 import { copyTextToClipboard } from '../utils/clipboard'");

console.log('\n=== D3-1b) copyWebAccessLink：web 分支降级 + 桌面链保留（分支共存结构钉） ===');
{
  const body = copyLinkBody();
  check('copyWebAccessLink 函数体存在（结构锚）', body.includes('async function copyWebAccessLink(): Promise<void> {'));
  check('web 分支存在（if (isWebRuntime) 门）', body.includes('if (isWebRuntime)'),
    'copyWebAccessLink 需含 isWebRuntime 分支');
  check('web 分支走 copyTextToClipboard(url)（浏览器内剪贴板链路，不写桌面主机剪贴板）',
    body.includes('copyTextToClipboard(url)'));
  check('复制失败给「请手动选择地址栏复制」指引（不假报成功=契约本体）',
    body.includes('请手动选择地址栏复制'));
  check('桌面链保留：webAccessCopyLink(url) 主进程调用仍在（桌面行为不变）',
    body.includes('window.claudeLink.webAccessCopyLink(url)'),
    '桌面分支 webAccessCopyLink 调用不得删除');
  check('web 分支先于桌面 invoke（早退隔离，分支共存）',
    body.indexOf('copyTextToClipboard') >= 0
    && body.indexOf('copyTextToClipboard') < body.indexOf('webAccessCopyLink'),
    'web 分支需早退 return，桌面链在其后');
  check('桌面成功 toast 文案保留（连接链接已复制到剪贴板）',
    body.includes('连接链接已复制到剪贴板'));
}

console.log('\n=== D3-1c) 护栏：tdd-web-secure-context-verify §D（navigator.clipboard 字面收口） ===');
check('spawn tdd-web-secure-context-verify.ts（§D 白名单钉保持全绿）',
  spawnGate('scripts/tdd-web-secure-context-verify.ts'));

console.log('\n=== D3-2a) UpdateDialog：立即安装钮 web 隐藏 ===');
check('UpdateDialog script isWebRuntime 常量（同式）', updateDialogSrc.includes(WEB_RUNTIME_CONST),
  'UpdateDialog.vue script 需新增同式 isWebRuntime 常量');
{
  const installTag = buttonTag(updateDialogSrc, 'update-dialog-install');
  check('立即安装钮 data-testid="update-dialog-install" 仍在（桌面场景不变）',
    installTag !== '');
  check('立即安装钮 v-if="!isWebRuntime"（web 隐藏/桌面显示两分支共存）',
    installTag.includes('v-if="!isWebRuntime"'),
    'update-dialog-install 需补 v-if="!isWebRuntime"');
}

console.log('\n=== D3-2b) 检查/下载/稍后提醒保留（两端不隐藏） ===');
{
  const dismissTag = buttonTag(updateDialogSrc, 'update-dialog-dismiss');
  check('稍后提醒钮保留且不设 web 隐藏 v-if', dismissTag !== '' && !dismissTag.includes('v-if'),
    'update-dialog-dismiss 不得被 web 判定隐藏');
  check('下载/状态区保留（update-dialog-status）',
    updateDialogSrc.includes('data-testid="update-dialog-status"'));
  check('检查更新入口保留（ConfigPage about-check-btn，两端可达）',
    configPageSrc.includes('data-testid="about-check-btn"'));
}

console.log('\n=== D3-2c) 回归门：tdd-app-updater-verify（installAppUpdate 接口保留=只藏 UI 不删 API） ===');
check('spawn tdd-app-updater-verify.ts 退出码 0', spawnGate('scripts/tdd-app-updater-verify.ts'));

console.log('\n=== D3-3) CHANNEL_TIMEOUT_MS 两键补齐（行为直测，>60_000 下界） ===');
{
  const ct = (bridgeMod as Record<string, unknown>).CHANNEL_TIMEOUT_MS as Record<string, number> | undefined;
  check('web-bridge 导出 CHANNEL_TIMEOUT_MS（行为直测可导入）', ct !== undefined);
  const refreshGlobal = ct?.[IPC_CHANNELS.COMMANDS_REFRESH_GLOBAL];
  const commandsGet = ct?.[IPC_CHANNELS.COMMANDS_GET];
  check(`CHANNEL_TIMEOUT_MS[${IPC_CHANNELS.COMMANDS_REFRESH_GLOBAL}] 存在且 > 60_000 下界`,
    typeof refreshGlobal === 'number' && refreshGlobal > 60_000,
    `实际 ${String(refreshGlobal)}（缺失或未超 60s 默认即红：全局重探 spawn CLI 长操作被腰斩）`);
  check(`CHANNEL_TIMEOUT_MS[${IPC_CHANNELS.COMMANDS_GET}] 存在且 > 60_000 下界`,
    typeof commandsGet === 'number' && commandsGet > 60_000,
    `实际 ${String(commandsGet)}（会话级重探同类长通道）`);
  check('既有覆盖不回退：testProviderModel=100_000 / probeMcpServers=130_000',
    ct?.[IPC_CHANNELS.PROVIDER_TEST_MODEL] === 100_000 && ct?.[IPC_CHANNELS.MCP_PROBE] === 130_000);
  const tableComment = bridgeSrc.slice(
    Math.max(0, bridgeSrc.indexOf('通道级超时覆盖表')),
    Math.max(0, bridgeSrc.indexOf('export const CHANNEL_TIMEOUT_MS')),
  );
  check('表头注释同步（覆盖 COMMANDS_REFRESH_GLOBAL / COMMANDS_GET 两键说明）',
    tableComment.includes('COMMANDS_REFRESH_GLOBAL') && tableComment.includes('COMMANDS_GET'),
    'CHANNEL_TIMEOUT_MS 头注释需同步新覆盖键');
  check('表内 D3-3 注释锚（spawn CLI 长操作 + 统一 120s 预算口径）',
    bridgeSrc.includes('D3-3：全局/会话级命令重探为 spawn CLI query 的长操作')
    && bridgeSrc.includes('统一 120s 预算'));
}

console.log('\n=== D3-5a) api.ts 头注释方法数 === 接口成员实数（防漂移对齐） ===');
{
  const nActual = countApiMembers();
  const m = /（(\d+) 个方法/.exec(apiSrc);
  const nDoc = m ? Number(m[1]) : NaN;
  check('api.ts 头注释 N_doc === ClaudeLinkAPI 接口成员实数 N_actual',
    Number.isFinite(nDoc) && nDoc === nActual,
    `N_doc=${String(nDoc)} N_actual=${nActual}（头注释须随接口成员增减同步）`);
  console.log(`  （N_doc=${String(nDoc)} / N_actual=${nActual}）`);
}

console.log('\n=== D3-5b) CLAUDE.md 推送路数行：共 X 路 === 列举数 === 17 ===');
{
  const line = claudeMd.split('\n').find((l) => l.includes('主→渲染推送共'));
  check('CLAUDE.md 含「主→渲染推送共」行', line !== undefined);
  if (line) {
    const xMatch = /主→渲染推送共 (\d+) 路/.exec(line);
    const x = xMatch ? Number(xMatch[1]) : NaN;
    const enumStart = line.indexOf('unsubscribe）：');
    const seg = enumStart >= 0 ? line.slice(enumStart + 'unsubscribe）：'.length).split('。')[0] : '';
    const names: string[] = seg.match(/\bon[A-Z][A-Za-z0-9]*/g) ?? [];
    check(`「共 X 路」X === 行内 on* 列举数（X=${String(x)}，列举=${names.length}）`,
      Number.isFinite(x) && x === names.length,
      '推送路数与列举通道数漂移');
    check('本批落地后共 17 路（15 既有 + onSkillsProjectDirsChanged + onMcpSnapshotChanged）',
      x === 17,
      `实际 ${String(x)}（03b 写 16 系 E2 落地前估算，实落 +2=17，见 02 §8.4）`);
    check('列举含 onSkillsProjectDirsChanged（UI13-P8 既有通道补录）',
      names.includes('onSkillsProjectDirsChanged'));
    check('列举含 onMcpSnapshotChanged（本批 E2 新增推送）',
      names.includes('onMcpSnapshotChanged'));
  }
}

console.log('\n=== 登记）selftest-static-list 含本脚本 ===');
check('scripts/selftest-static-list.txt 登记 tdd-web-parity-gaps-verify',
  read('scripts/selftest-static-list.txt').split(/\r?\n/).map((l) => l.trim())
    .includes('scripts/tdd-web-parity-gaps-verify.ts'));

console.log(`\n[D3 网页版补齐四小项契约] 通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
