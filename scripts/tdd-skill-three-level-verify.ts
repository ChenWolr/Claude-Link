// tdd-skill-three-level-verify.ts
// E5「Skill 三级收口（文案明示）」契约脚本（docs/plans/2026-11-15-eight-issues-batch/
// 03b-test-cases-renderer.md §12 E5-1/3/4 转写；行为契约唯一事实源 00-behavior-specs.md 域 E
// E5 节；实现细节 02-impl-details-renderer.md §11）。
// 用例→断言映射：
//   E5-1   既有两级扫描行为不变（回归门）：spawn npx tsx scripts/tdd-skill-refresh-verify.ts
//          （①~⑥：skillAutoSync 配置 / COMMANDS_REFRESH_GLOBAL 五处落点 / refreshGlobal action /
//          同步条 UI）+ npx tsx scripts/tdd-skill-per-project-refresh-verify.ts（T8-A~K：项目刷新钮 /
//          目录监听 / 门控切分），两脚本退出码 0；
//   E5-3   link 级文案明示（钉）：ConfigPage .skill-note 段含契约原文句「Claude Link 不存储 Skill，
//          仅管理启停；『清理失效键』即 link 级维护动作。」——关键语「不存储 skill」「清理失效键」
//          命中；位置形态与 MCP managed 说明对齐（双作用域共用 muted 说明段，句在段内文末追加，
//          非独立横幅/弹层）；「清理失效键」入口（skill-stale-row 条件渲染 + cleanupStaleSkillKeys
//          接线）不动；
//   E5-4   skillAutoSync 门控不变 + 手动钮不受门控（负向钉）：
//            ① 「立即刷新」按钮元素切片（<button …</button> 含 disabled 绑定与 @click）与
//              command-store refreshGlobal action 切片内零 skillAutoSync 引用；
//            ② triggerGlobalProbe 的 skillAutoSync 守卫仅存在于 watcher 自动路径——引用
//              tdd-skill-refresh-verify ② 既有钉（E5-1 spawn 门覆盖），本卷不重复出钉；
//            ③ 项目级单目录粒度刷新未实现（规范 E5.4 明文不做，防顺手多做扩大影响面）：
//              「重新枚举」钮零参调 ensureProjectDirs()（整表重拉）+ ensureProjectDirs 签名无目录
//              参数 + preload/ipc 类型面无任何单目录刷新通道标识。
// RED 预期（未实现树）：E5-3b/c/d（契约句）先红；E5-1/E5-4 为回归/负向钉现状即绿。
// 运行：npx tsx scripts/tdd-skill-three-level-verify.ts（登记 scripts/selftest-static-list.txt）。

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readSrc = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const configPageSrc = readSrc('src/renderer/pages/ConfigPage.vue');
const commandStoreSrc = readSrc('src/renderer/stores/command-store.ts');
const preloadSrc = readSrc('src/preload/api.ts');
const ipcTypesSrc = readSrc('src/shared/types/ipc.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

/** spawn 既有契约脚本（退出码 0 = 绿；失败 tail 供定位）。 */
function spawnAssert(script: string): void {
  const r = spawnSync('npx', ['tsx', script], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-8).join('\n');
  assert.equal(r.status, 0, `${script} 退出码 ${r.status}（回归门被波及）\n${tail}`);
}

/** 取 target 首次出现处向前最近的 `<button`、向后最近的 `</button>` 之间的完整按钮元素切片。 */
function buttonSlice(src: string, target: string): string {
  const anchor = src.indexOf(target);
  assert.notEqual(anchor, -1, `锚点未找到：${target}`);
  const open = src.lastIndexOf('<button', anchor);
  const close = src.indexOf('</button>', anchor);
  assert.notEqual(open, -1, `锚点前无 <button：${target}`);
  assert.notEqual(close, -1, `锚点后无 </button>：${target}`);
  return src.slice(open, close + '</button>'.length);
}

/** 段落切片：`<p class="…">` 开标签至其后首个 `</p>`。 */
function pSlice(src: string, classLiteral: string): string {
  const open = src.indexOf(`<p class="${classLiteral}">`);
  assert.notEqual(open, -1, `<p class="${classLiteral}"> 段落未找到`);
  const close = src.indexOf('</p>', open);
  assert.notEqual(close, -1, `<p class="${classLiteral}"> 段落未闭合`);
  return src.slice(open, close + '</p>'.length);
}

console.log('=== E5-1 既有两级扫描行为不变（spawn 回归门） ===');

check('E5-1a spawn npx tsx scripts/tdd-skill-refresh-verify.ts 退出码 0（立即刷新/通道/门控契约不因本点回归）', () => {
  spawnAssert('scripts/tdd-skill-refresh-verify.ts');
});

check('E5-1b spawn npx tsx scripts/tdd-skill-per-project-refresh-verify.ts 退出码 0（项目级重新枚举/目录监听/门控切分契约不因本点回归）', () => {
  spawnAssert('scripts/tdd-skill-per-project-refresh-verify.ts');
});

console.log('=== E5-3 link 级文案明示（钉） ===');

const CONTRACT_SENTENCE = 'Claude Link 不存储 Skill，仅管理启停；『清理失效键』即 link 级维护动作。';

check('E5-3a .skill-note 双作用域共用说明段存在（muted 说明段形态，与 MCP managed 说明对齐的栏内说明位）', () => {
  const note = pSlice(configPageSrc, 'skill-note');
  assert.ok(note.includes('项目目录自动来自'), '既有说明正文缺失（段被整体改写？）');
});

check('E5-3b .skill-note 段内含契约原文句（00-behavior-specs E5.2 / 02 §11.1 逐字）', () => {
  const note = pSlice(configPageSrc, 'skill-note');
  assert.ok(note.includes(CONTRACT_SENTENCE), `契约句未命中。段落现状：${note}`);
});

check('E5-3c 关键语命中：「不存储 skill」（大小写不敏感）+「清理失效键」（规范 E5.2 原文语）', () => {
  const note = pSlice(configPageSrc, 'skill-note');
  assert.match(note, /不存储\s*skill/i, '关键语「不存储 skill」未命中');
  assert.ok(note.includes('清理失效键'), '关键语「清理失效键」未命中');
});

check('E5-3d 契约句为文末追加（位于既有说明尾句「新会话即刻生效。」之后，非插入改写既有句）', () => {
  const note = pSlice(configPageSrc, 'skill-note');
  const tailIdx = note.indexOf('新会话即刻生效。');
  assert.notEqual(tailIdx, -1, '既有说明尾句缺失（段被改写？）');
  const sentIdx = note.indexOf(CONTRACT_SENTENCE);
  assert.notEqual(sentIdx, -1, '契约句未命中');
  assert.ok(sentIdx > tailIdx, `契约句不在尾句之后（sentIdx=${sentIdx} tailIdx=${tailIdx}）`);
});

check('E5-3e 「清理失效键」入口不动：skill-stale-row 条件渲染 + cleanupStaleSkillKeys 接线在位', () => {
  assert.ok(configPageSrc.includes('<div v-if="staleSkillKeys.length > 0" class="skill-stale-row">'), 'skill-stale-row 条件渲染被改动');
  assert.ok(configPageSrc.includes('@click="cleanupStaleSkillKeys()"'), '清理失效键按钮接线被改动');
});

console.log('=== E5-4 skillAutoSync 门控不变 + 手动钮不受门控 + 单目录刷新不做（负向钉） ===');

check('E5-4① 「立即刷新」按钮元素切片内零 skillAutoSync 引用（disabled 绑定不含门控条件——手动通道独立）', () => {
  const btn = buttonSlice(configPageSrc, 'data-testid="skill-refresh-button"');
  assert.ok(btn.includes(':disabled='), 'disabled 绑定缺失（忙态禁用被移除？）');
  assert.ok(btn.includes('commandStore.refreshGlobal()'), '@click 接线缺失');
  assert.ok(!btn.includes('skillAutoSync'), '按钮切片内出现 skillAutoSync（手动钮被挂进门控）');
});

check('E5-4① refreshGlobal action 切片内零 skillAutoSync 引用（action 不读门控，门控仅在 watcher 自动路径）', () => {
  const sigIdx = commandStoreSrc.indexOf('async refreshGlobal(): Promise<void> {');
  assert.notEqual(sigIdx, -1, 'refreshGlobal action 签名未找到');
  const nextMemberIdx = commandStoreSrc.indexOf('resetSkillFreshState(): void {', sigIdx);
  assert.notEqual(nextMemberIdx, -1, 'refreshGlobal 后界锚（resetSkillFreshState 签名）未找到');
  const actionSlice = commandStoreSrc.slice(sigIdx, nextMemberIdx);
  assert.ok(actionSlice.includes('window.claudeLink.refreshGlobalCommands()'), 'action 未调 refreshGlobalCommands（切片错位？）');
  assert.ok(!actionSlice.includes('skillAutoSync'), 'refreshGlobal action 内出现 skillAutoSync');
});

check('E5-4③ 「重新枚举」钮零参调 ensureProjectDirs()（整表重拉，非单目录粒度刷新——规范 E5.4 明文不做）', () => {
  const btn = buttonSlice(configPageSrc, 'data-testid="skill-project-refresh"');
  assert.ok(btn.includes('@click="ensureProjectDirs()"'), '重新枚举钮未零参调 ensureProjectDirs()（被改成按目录传参？）');
  assert.ok(!btn.includes('skillAutoSync'), '重新枚举钮切片内出现 skillAutoSync（手动钮被挂进门控）');
});

check('E5-4③ ensureProjectDirs 签名无目录参数（项目单目录刷新通道未新增）', () => {
  assert.ok(configPageSrc.includes('async function ensureProjectDirs(): Promise<void>'), 'ensureProjectDirs 签名被改动（新增目录参数？）');
});

check('E5-4③ preload/api.ts + shared/types/ipc.ts 无任何单目录刷新通道标识（负向钉：防顺手多做新增 IPC）', () => {
  const perDirChannel = /refreshProjectSkillDir|skill:refreshProjectDir|skillProjectDirRefresh|refreshSkillDir|SKILL_PROJECT_DIR_REFRESH/;
  assert.equal(perDirChannel.test(preloadSrc), false, 'preload 出现疑似单目录刷新通道');
  assert.equal(perDirChannel.test(ipcTypesSrc), false, 'ipc 类型面出现疑似单目录刷新通道');
});

console.log(`\n===== tdd-skill-three-level-verify: ${pass} pass / ${fail} fail =====`);
if (fail > 0) console.log('（存在 FAIL 项：实现缺失或回归——见上方 ❌ 明细）');
process.exit(fail > 0 ? 1 : 0);
