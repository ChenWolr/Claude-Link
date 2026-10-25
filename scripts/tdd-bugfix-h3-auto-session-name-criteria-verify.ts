// tdd-bugfix-h3-auto-session-name-criteria-verify.ts
// H3（P3，对抗复查 2026-09-08 第二轮）契约钉：F4 守卫判据加固——`startsWith('会话')` 前缀
// 判据可被用户自然命名绕过；附件-only 路径 DB 写无门。
//
// 修复前：主进程 topic-analyzer 的 isAutoNameSlot 与渲染层 session-store 三处（发送触发 /
// LLM 主题视图覆盖 / 附件名视图覆盖）同用前缀判据 startsWith('会话')，而物化自动名的真实
// 格式是 `会话 ${n}`（materializeActiveTransient）。用户在 10s 竞态窗口内改名为「会话备份」
// 等以「会话」开头的名字 → 误判为自动名槽位 → 迟到主题照覆盖（恰是 F4 声称已修复的场景）。
// 次级：附件-only 路径的 updateSession DB 写本身无门槛（只有 .then 视图覆盖有门）。
//
// 修复语义：
// ① 判据抽 shared 纯函数 isAutoSessionName（trim 后全等 /^会话 \d+$/），主进程与渲染层
//    三端同源；四处前缀判据全部替换。
// ② 附件-only 路径 updateSession 写前加同门槛：当前名不是自动形态则跳过写（防御性，
//    与 :981 触发门槛双保险，防未来重构插入 await 打开窗口）。
//
// 契约：'会话备份' 不再被判为自动名槽位；'会话 3' 仍是。
//
// 运行：npx tsx scripts/tdd-bugfix-h3-auto-session-name-criteria-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isAutoSessionName, isMaterializableAutoName } from '../src/shared/auto-session-name';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: (() => void) | boolean): void {
  try {
    if (typeof cond === 'function') cond();
    else if (!cond) throw new Error('断言为假');
    pass += 1; console.log(`  ✅ ${name}`);
  }
  catch (e) { fail += 1; console.log(`  ✗ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

console.log('=== H3-① isAutoSessionName 纯函数行为（三端同源判据）===');
{
  check("'会话 3' 仍是自动名（物化格式）", isAutoSessionName('会话 3') === true);
  check("'会话 12' 多位数仍是自动名", isAutoSessionName('会话 12') === true);
  check("' 会话 3 ' trim 后命中", isAutoSessionName(' 会话 3 ') === true);
  check("'会话备份' 不再被判为自动名（H3 缺陷名）", isAutoSessionName('会话备份') === false);
  check("'会话' 裸前缀不是自动名", isAutoSessionName('会话') === false);
  check("'会话 3 备份' 带后缀不是自动名", isAutoSessionName('会话 3 备份') === false);
  check("'会话 3x' 非纯数字不是自动名", isAutoSessionName('会话 3x') === false);
  check("'会话 abc' 非数字不是自动名", isAutoSessionName('会话 abc') === false);
  check("'会话  3' 双空格不命中（精确单空格形态）", isAutoSessionName('会话  3') === false);
  check("空串/null/undefined 安全回落 false", isAutoSessionName('') === false && isAutoSessionName(null) === false && isAutoSessionName(undefined) === false);
}

console.log('=== H3-① 四处判据替换（接线契约）===');
{
  // [P4 连带同步 2026-10-24]：自动命名主链判据升级为名源判定（计划 2026-10-24-web-sync
  // §3.2.1-8/9：主进程 isAutoNameSlot 走 isUpgradableNameSource、渲染层三门槛走
  // isUpgradableSession——缺省名源对象经 deriveNameSource 按名称形态派生兜底，自然名仍让位）；
  // isAutoSessionName 精确形态判据保留于附件命名双门 + shared 派生函数内部。H3 本意
  // 「判据 shared 同源、精确形态、自然命名不绕过」不变，本节断言随判据源升级同步改钉。
  const analyzer = read('src/main/modules/topic-analyzer.ts');
  const sessionStore = read('src/renderer/stores/session-store.ts');
  const sharedFn = read('src/shared/auto-session-name.ts');

  check('shared 纯函数存在且形态正确', /export function isAutoSessionName\(name: string \| null \| undefined\): boolean \{[\s\S]*\/\^会话 \\d\+\$\/\.test\(name\.trim\(\)\)/.test(sharedFn));

  check('topic-analyzer 从 shared 引入名源判据（isUpgradableNameSource）',
    /import\s*\{\s*isUpgradableNameSource\s*\}\s*from\s*'\.\.\/\.\.\/shared\/auto-session-name'/.test(analyzer));
  check('isAutoNameSlot 重查改走名源判定（isUpgradableNameSource）',
    /isUpgradableNameSource\(\w+\.nameSource\)/.test(analyzer));
  check('topic-analyzer 无残留前缀判据', !analyzer.includes(".startsWith('会话')"));

  check('session-store 从 shared 引入判据（isAutoSessionName + isUpgradableSession）',
    /import\s*\{[^}]*\bisAutoSessionName\b[^}]*\bisUpgradableSession\b[^}]*\}\s*from\s*'(\.\.\/)+shared\/auto-session-name'/.test(sessionStore));
  const upgradableCount = (sessionStore.match(/isUpgradableSession\(/g) || []).length;
  check(`命名门槛走名源判定 ≥3 处（触发+LLM 视图+列表 patch，实际 ${upgradableCount} 处）`, upgradableCount >= 3);
  const gateCount = (sessionStore.match(/isAutoSessionName\(/g) || []).length;
  check(`附件命名双门保留 isAutoSessionName 精确形态（写前+视图，实际 ${gateCount} 处）`, gateCount >= 2);
  check('session-store 无残留前缀判据', !sessionStore.includes(".startsWith('会话')"));
}

console.log('=== H3-② 附件-only 路径 DB 写前门槛 ===');
{
  const sessionStore = read('src/renderer/stores/session-store.ts');
  const branchAt = sessionStore.indexOf('} else if (firstName) {');
  check('附件-only 分支存在', branchAt !== -1);
  if (branchAt !== -1) {
    const branch = sessionStore.slice(branchAt, sessionStore.indexOf('.catch(() => {', branchAt));
    const writeAt = branch.indexOf('window.claudeLink.updateSession(sessionId, { name: topic })');
    check('updateSession DB 写仍在（不误删命名能力）', writeAt !== -1);
    // 写前门槛：guard 形态（带不花括号均可）包住写调用——非自动形态同步跳过 DB 写。
    const gate = /if \(!isAutoSessionName\(this\.activeSession\?\.name\)\)\s*(\{[\s\S]{0,200}return;|return;)/.test(branch);
    check('DB 写前判当前名仍是自动形态，否则跳过写', gate);
    const gateAt = branch.search(/if \(!isAutoSessionName\(this\.activeSession\?\.name\)\)/);
    check('门槛在 DB 写之前（非事后补救）', writeAt !== -1 && gateAt !== -1 && gateAt < writeAt);
  }
}

console.log('=== 回归：F4 竞态守卫语义不弱化 ===');
{
  const analyzer = read('src/main/modules/topic-analyzer.ts');
  const sessionStore = read('src/renderer/stores/session-store.ts');
  // SA-4/P6-乙 同步（2026-10-21）：出口构成变化——首句兜底出口移除、短输入直写出口（≤8 字符
  // 不发起 LLM 直接写库，shorthand 形态 { name }）新增；计数形态泛化以兼容 shorthand。
  // [P4 连带同步 2026-10-24]：两出口追加 nameSource: 'generated'（多键形态），正则放宽为
  // \{ name[^}]*\}（理由同 tdd-bugfix-topic-thinking-leak B 节：计数约束出口数不约束键形状）。
  const writeCount = (analyzer.match(/sessionRepo\.updateSession\(sessionId, \{ name[^}]*\}\)/g) || []).length;
  check('主进程仍保留两处 name 写入出口（SA-4 后构成 = LLM 主题+短输入直写）', writeCount === 2);
  const gateCount = (analyzer.match(/isAutoNameSlot\(sessionId\)/g) || []).length;
  check('主进程两处出口仍各有守卫（实际 %s 处）'.replace('%s', String(gateCount)), gateCount >= 2);
  check('analyzeTopic(sessionId, textContent) 调用形态不变', sessionStore.includes('analyzeTopic(sessionId, textContent)'));
  check('附件名标题素材截断逻辑保留', sessionStore.includes("firstName.replace(/\\s+/g, ' ').slice(0, 15)"));
}

console.log('=== hb13-v A5：物化判定两形态并集 + 物化分支接线 ===');
{
  const sharedFn = read('src/shared/auto-session-name.ts');
  const sessionStore = read('src/renderer/stores/session-store.ts');

  check('isMaterializableAutoName 导出存在（两形态并集）', /export function isMaterializableAutoName\(name: string \| null \| undefined\): boolean \{/.test(sharedFn));
  check('并集行为：暂态默认名「新会话」与「会话 N」均视为自动形态', () => {
    assert.equal(isMaterializableAutoName('新会话'), true, '暂态默认名未并入');
    assert.equal(isMaterializableAutoName('会话 3'), true);
    assert.equal(isMaterializableAutoName(' 会话 3 '), true);
    assert.equal(isMaterializableAutoName(' 会话 '), false);
    assert.equal(isMaterializableAutoName('会话备份'), false, '用户自然命名被误并');
    assert.equal(isMaterializableAutoName('新会话备份'), false);
    assert.equal(isMaterializableAutoName(''), false);
    assert.equal(isMaterializableAutoName(null), false);
  });
  check('materializeActiveTransient 物化分支改用 isMaterializableAutoName', /transient\.name && !isMaterializableAutoName\(transient\.name\)/.test(sessionStore));
  check('session-store 引入 isMaterializableAutoName', /import\s*\{[^}]*\bisMaterializableAutoName\b[^}]*\}\s*from\s*'(\.\.\/)+shared\/auto-session-name'/.test(sessionStore));
  // [P4 连带同步 2026-10-24]：原「isAutoSessionName 判据门 ≥4」（触发+LLM 视图+附件双门）
  // 随主链判据名源化收敛为附件双门 2 处（精确形态判据同时活在 shared deriveNameSource 内），
  // ≥2 与 H3-① 附件双门断言互证。
  const gateCount2 = (sessionStore.match(/isAutoSessionName\(/g) || []).length;
  check(`既有 isAutoSessionName 判据门仍 ≥2 处（附件双门；实际 ${gateCount2} 处）`, gateCount2 >= 2);
}

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
