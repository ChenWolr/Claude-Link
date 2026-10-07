// tdd-changes-empty-repo-verify.ts
// X5（R10-F2）契约钉：空仓库（unborn HEAD，`git init` 后零提交）下改动面板整体不可用——
// `diff HEAD` exit 128（fatal: ambiguous argument 'HEAD'）被 listChanges/getChangeDiff 一票
// 否决成「git 异常退出」，全新 `git init` 仓库在面板上表现为错误态而非新文件列表。
//
// 修复语义（2026-10-06 隐藏缺陷修复第二轮 X5）：
// ① listChanges：baselineRef===''（空仓库）时跳过 `diff HEAD --numstat`，列表以 status 为准，
//    全部条目 ± 计数 null（与未跟踪文件现状一致）；
// ② getChangeDiff 已跟踪分支：基线 ref 取 `baselineRef || EMPTY_TREE_HASH`，空仓库下 exit 0
//    正常出全新增 diff（未跟踪文件出空 diff → 走既有 --no-index /dev/null 兜底出整文件新增）。
//    空树哈希取 4b825dc642cb6eb9a060e54bf8d69288fbee4904（git 内置虚拟对象，本机
//    `git hash-object -t tree /dev/null` 实算值；修复计划原文尾段 ...ea87e33f90602730b0af 有误——
//    rev-parse 对任意 40-hex 原样回显不校验存在性，错误哈希在空仓库 `fatal: bad object` exit 128）。
//
// 运行：npx tsx scripts/tdd-changes-empty-repo-verify.ts

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

const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x5-empty-repo-'));
const normalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x5-normal-repo-'));
const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

// 空仓库：init 后零提交（unborn HEAD），1 个未跟踪 + 1 个已暂存（git add 后未 commit）。
g(emptyRoot, 'init', '-q');
fs.writeFileSync(path.join(emptyRoot, 'untracked.txt'), 'hello\nworld\n');
fs.writeFileSync(path.join(emptyRoot, 'staged.txt'), 'staged\ncontent\n');
g(emptyRoot, 'add', 'staged.txt');

// 正常仓库：有 HEAD（回归基线，验证「正常仓库路径零改动」影响面承诺）。
g(normalRoot, 'init', '-q');
g(normalRoot, 'config', 'user.email', 'test@example.com');
g(normalRoot, 'config', 'user.name', 'test');
fs.writeFileSync(path.join(normalRoot, 'base.txt'), 'line1\n');
g(normalRoot, 'add', '.');
g(normalRoot, 'commit', '-qm', 'init');
fs.writeFileSync(path.join(normalRoot, 'base.txt'), 'line1\nline2\n');

(async () => {
  // ── 场景 1：空仓库 listChanges ────────────────────────────────
  const list = await listChanges(emptyRoot);
  const files = list.ok ? list.files : [];
  const paths = files.map((f: { path: string }) => f.path).sort();
  check('① 空仓库 listChanges ok（不再「扫描改动失败：git 异常退出」）',
    list.ok === true,
    `ok=${list.ok} reason=${list.ok ? '' : list.reason} message=${list.ok ? '' : list.message}`);
  check('② 空仓库列出全部新文件（未跟踪 + 已暂存）',
    paths.includes('staged.txt') && paths.includes('untracked.txt'), JSON.stringify(paths));
  check('③ 空仓库 baselineRef 为空串',
    list.ok === true && list.baselineRef === '');
  check('④ 空仓库跳过 numstat：条目 ± 计数 null（与未跟踪文件现状一致）',
    files.length === 2 && files.every((f: { additions: number | null }) => f.additions === null),
    JSON.stringify(files));

  // ── 场景 2：空仓库单文件 diff ─────────────────────────────────
  const d1 = await getChangeDiff(emptyRoot, 'untracked.txt');
  check('⑤ 空仓库未跟踪文件 diff 可显示（整文件新增）',
    d1.ok === true && d1.diff.includes('+hello') && d1.diff.includes('+world'),
    `ok=${d1.ok} message=${d1.ok ? '' : d1.message}`);
  const d2 = await getChangeDiff(emptyRoot, 'staged.txt');
  check('⑥ 空仓库已暂存文件 diff 可显示（空树基线全新增）',
    d2.ok === true && d2.diff.includes('+staged'),
    `ok=${d2.ok} message=${d2.ok ? '' : d2.message}`);

  // ── 场景 3：正常仓库回归（有 HEAD 路径零改动）─────────────────
  const list2 = await listChanges(normalRoot);
  const base = list2.ok ? (list2.files ?? []).find((f: { path: string }) => f.path === 'base.txt') : undefined;
  check('⑦ 正常仓库 listChanges 回归：numstat 计数照常（additions=1）',
    list2.ok === true && !!base && base.additions === 1, JSON.stringify(list2.ok ? list2.files : list2));
  const d3 = await getChangeDiff(normalRoot, 'base.txt');
  check('⑧ 正常仓库已跟踪文件 diff 回归不变（相对 HEAD 的净改动）',
    d3.ok === true && d3.diff.includes('+line2'));

  // ── 结构断言 ──────────────────────────────────────────────────
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/modules/changes-panel.ts'), 'utf8');
  check('⑨ 结构：numstat 的 diff HEAD 调用被 if (baselineRef) 守卫（baselineRef==\'\' 时不发起）',
    /if \(baselineRef\) \{\s*const ns = await runGit\(root, \['--no-pager', 'diff', 'HEAD', '--numstat'/.test(src));
  check('⑩ 结构：EMPTY_TREE_HASH 常量为正确空树哈希',
    src.includes("const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'"));
  check('⑪ 结构：getChangeDiff 基线取 baselineRef || EMPTY_TREE_HASH',
    src.includes("'diff', baselineRef || EMPTY_TREE_HASH, `-U${context}`"));

  for (const root of [emptyRoot, normalRoot]) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* tmp 残留无害 */ }
  }
  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
