// tdd-bugfix-p1-11-untracked-dir-verify.ts
// P1-11 契约钉：未跟踪目录在改动面板永远「无可显示差异」。
//
// 根因：status 无 --untracked-files=all → 新目录折叠为 `?? dir/`；--no-index 兜底对目录报错
//（实测 exit 1 "Could not access '...'"）。
//
// 修复语义：① status 加 --untracked-files=all（新文件逐条列出，各走既有单文件 --no-index 兜底）；
// ② 防御性兜底：`dir/` 折叠条目枚举目录内文件逐个 --no-index 拼接（status.showUntrackedFiles=no 时）。
//
// 运行：npx tsx scripts/tdd-bugfix-p1-11-untracked-dir-verify.ts

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { listChanges, getChangeDiff } = require('../src/main/modules/changes-panel');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-11-repo-'));
const g = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
g('init', '-q');
g('config', 'user.email', 'test@example.com');
g('config', 'user.name', 'test');
fs.writeFileSync(path.join(root, 'tracked.txt'), 'line1\nline2\n');
g('add', '.');
g('commit', '-qm', 'init');
// 未跟踪目录（两层嵌套）。
fs.mkdirSync(path.join(root, 'newdir', 'sub'), { recursive: true });
fs.writeFileSync(path.join(root, 'newdir', 'a.txt'), 'new A content\n');
fs.writeFileSync(path.join(root, 'newdir', 'sub', 'b.txt'), 'new B content\n');

(async () => {
  // 场景 1：默认配置（-uall）→ 新文件逐条列出。
  const list = await listChanges(root);
  const paths = (list.files ?? []).map((f: { path: string }) => f.path).sort();
  check('① 未跟踪目录内文件逐条列出（不折叠为 dir/）',
    list.ok === true && paths.includes('newdir/a.txt') && paths.includes('newdir/sub/b.txt'),
    JSON.stringify(paths));
  check('② -uall 后新增未跟踪文件数为 2（不影响 tracked 枚举语义：未改动 tracked 不入列表）',
    list.ok === true && paths.length === 2, JSON.stringify(paths));

  // 场景 2：单文件 --no-index 兜底回归（未跟踪文件可打开 diff）。
  const d1 = await getChangeDiff(root, 'newdir/a.txt');
  check('③ 未跟踪新文件 diff 可显示（整文件新增）',
    d1.ok === true && d1.diff.includes('new A content'), `ok=${d1.ok} message=${d1.message ?? ''}`);

  // 场景 3：status.showUntrackedFiles=no → CLI 的 --untracked-files=all 覆盖用户配置，
  // 折叠条目不再出现（计划前提偏差：git 选项优先级高于该 config）；dir/ 兜底分支保留为
  // 纯防御（历史缓存的折叠条目/未来形态仍可达，⑤ 直接验证其可用性）。
  g('config', 'status.showUntrackedFiles', 'no');
  const list2 = await listChanges(root);
  const dirs = (list2.files ?? []).map((f: { path: string }) => f.path);
  check('④ showUntrackedFiles=no 被 CLI -uall 覆盖（仍逐条列出、无 dir/ 折叠）',
    list2.ok === true && dirs.includes('newdir/a.txt') && !dirs.some((p: string) => p.endsWith('/')),
    JSON.stringify(dirs));
  const d2 = await getChangeDiff(root, 'newdir/');
  check('⑤ 目录折叠条目可显示整目录新增 diff（拼接两文件）',
    d2.ok === true && d2.diff.includes('new A content') && d2.diff.includes('new B content'),
    `ok=${d2.ok} message=${d2.message ?? ''}`);

  // 场景 4：已跟踪文件改动回归。
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'line1\nCHANGED\n');
  const d3 = await getChangeDiff(root, 'tracked.txt');
  check('⑥ 已跟踪文件 diff 回归不变', d3.ok === true && d3.diff.includes('+CHANGED'));

  // 结构：status 参数含 --untracked-files=all。
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/modules/changes-panel.ts'), 'utf8');
  check('⑦ status 参数含 --untracked-files=all',
    src.includes("'--porcelain=v1', '-z', '--ignore-submodules', '--untracked-files=all'"));
  check('⑧ getChangeDiff 有 dir/ 折叠条目兜底分支', src.includes("path.endsWith('/')"));

  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* tmp 残留无害 */ }
  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
