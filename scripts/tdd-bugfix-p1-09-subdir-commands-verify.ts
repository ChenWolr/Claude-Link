// tdd-bugfix-p1-09-subdir-commands-verify.ts
// P1-9 契约钉：commands 子目录命名空间命令无磁盘证据 → origin=unknown → 从菜单消失。
//
// 修复语义：scanCommandFiles 递归扫描（限深 3、symlink 跳过），证据同时记录
//「目录冒号拼接全名」（真实 SDK probe 确证形态：devtool:buildcmd）与「basename」两键；
// classifyOrigin 命中任一即可正确分类（project/user-skill）。
//
// 运行：npx tsx scripts/tdd-bugfix-p1-09-subdir-commands-verify.ts

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildCommandOriginEvidence, commandOriginKey } from '../src/main/modules/sdk-command-origin';
import { classifyOrigin } from '../src/main/modules/sdk-command-registry';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 构造 tmp 目录树 ──
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-09-cmds-'));
const cmds = path.join(root, '.claude', 'commands');
fs.mkdirSync(path.join(cmds, 'devtool'), { recursive: true });
fs.mkdirSync(path.join(cmds, 'ns', 'deep', 'deeper2', 'more'), { recursive: true });
fs.mkdirSync(path.join(root, '.claude', 'skills', 'some-skill'), { recursive: true });
fs.writeFileSync(path.join(cmds, 'top.md'), '---\ndescription: top\n---\nnoop\n');
fs.writeFileSync(path.join(cmds, 'devtool', 'buildcmd.md'), '---\ndescription: build\n---\nnoop\n');
fs.writeFileSync(path.join(cmds, 'ns', 'deep', 'deepcmd.md'), '---\ndescription: deep\n---\nnoop\n');
fs.writeFileSync(path.join(cmds, 'ns', 'deep', 'deeper2', 'more', 'toodeep.md'), '---\ndescription: beyond\n---\nnoop\n');
// symlink/junction 目录：其中命令不得被采集（防环）。
let junctionCreated = false;
try {
  fs.symlinkSync(path.join(cmds, 'devtool'), path.join(cmds, 'linkdir'), 'junction');
  junctionCreated = true;
} catch {
  junctionCreated = false;
}

const evidence = buildCommandOriginEvidence({ cwd: root });
const origins = evidence.origins;
const k = (s: string) => commandOriginKey(s);

check('① 根层命令证据（回归不变）', origins[k('top')] === 'project');
check('② 子目录命令冒号拼接全名有证据（devtool:buildcmd → project）',
  origins[k('devtool:buildcmd')] === 'project', JSON.stringify(origins[k('devtool:buildcmd')]));
check('③ 子目录命令 basename 也有证据（buildcmd → project）',
  origins[k('buildcmd')] === 'project');
check('④ 二级嵌套（ns:deep:deepcmd）与 basename 均有证据',
  origins[k('ns:deep:deepcmd')] === 'project' && origins[k('deepcmd')] === 'project');
check('⑤ 超限深（4 层目录内 toodeep）不采集（回落 unknown 计数，可见差异状态）',
  origins[k('toodeep')] === undefined && origins[k('ns:deep:deeper2:more:toodeep')] === undefined);
if (junctionCreated) {
  check('⑥ symlink/junction 目录跳过（linkdir:buildcmd 不采集）',
    origins[k('linkdir:buildcmd')] === undefined);
} else {
  console.log('  ⚠️ ⑥ 本环境无 junction 创建权限，跳过（权限受限不影响其余断言）');
}

// classifyOrigin 集成：子目录命令按全名命中（不靠 unknown 降级）。
const origin = classifyOrigin('devtool:buildcmd', 'build', undefined, {
  skills: [],
  plugins: [],
  evidence,
} as never);
check('⑦ classifyOrigin(devtool:buildcmd) → project（菜单可见）', origin === 'project', String(origin));
// basename 命中路径：若系统侧以裸名上报也能分类。
const origin2 = classifyOrigin('buildcmd', 'build', undefined, {
  skills: [],
  plugins: [],
  evidence,
} as never);
check('⑧ classifyOrigin(basename) 亦可命中', origin2 === 'project', String(origin2));

// 清理。
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* tmp 残留无害 */ }

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
