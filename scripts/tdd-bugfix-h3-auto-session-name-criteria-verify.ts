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
import { isAutoSessionName } from '../src/shared/auto-session-name';

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
  const analyzer = read('src/main/modules/topic-analyzer.ts');
  const sessionStore = read('src/renderer/stores/session-store.ts');
  const sharedFn = read('src/shared/auto-session-name.ts');

  check('shared 纯函数存在且形态正确', /export function isAutoSessionName\(name: string \| null \| undefined\): boolean \{[\s\S]*\/\^会话 \\d\+\$\/\.test\(name\.trim\(\)\)/.test(sharedFn));

  check('topic-analyzer 引入 isAutoSessionName', /import\s*\{\s*isAutoSessionName\s*\}\s*from\s*'\.\.\/\.\.\/shared\/auto-session-name'/.test(analyzer));
  check('isAutoNameSlot 重查改走 isAutoSessionName', /isAutoSessionName\(sessionRepo\.getSession\(sessionId\)\?\.name\)/.test(analyzer));
  check('topic-analyzer 无残留前缀判据', !analyzer.includes(".startsWith('会话')"));

  check('session-store 引入 isAutoSessionName', /import\s*\{\s*isAutoSessionName\s*\}\s*from\s*'(\.\.\/)+shared\/auto-session-name'/.test(sessionStore));
  const gateCount = (sessionStore.match(/isAutoSessionName\(/g) || []).length;
  check(`session-store 判据调用 ≥4 处（触发+LLM 视图+附件写前+附件视图，实际 ${gateCount} 处）`, gateCount >= 4);
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
  const writeCount = (analyzer.match(/sessionRepo\.updateSession\(sessionId, \{ name:/g) || []).length;
  check('主进程仍保留两处 name 写入出口（LLM 主题+首句兜底）', writeCount === 2);
  const gateCount = (analyzer.match(/isAutoNameSlot\(sessionId\)/g) || []).length;
  check('主进程两处出口仍各有守卫（实际 %s 处）'.replace('%s', String(gateCount)), gateCount >= 2);
  check('analyzeTopic(sessionId, textContent) 调用形态不变', sessionStore.includes('analyzeTopic(sessionId, textContent)'));
  check('附件名标题素材截断逻辑保留', sessionStore.includes("firstName.replace(/\\s+/g, ' ').slice(0, 15)"));
}

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
