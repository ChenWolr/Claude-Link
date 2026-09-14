// scripts/tdd-bugfix-hb10-changes-gitcode-verify.ts
// hb10 P2-7（CHG-01+CHG-V01）契约：git 非零退出码当成功 / -U context 未校验。
//
// 病根：runGit 只回 stdout、丢弃退出码——损坏 .git/index 时 status/diff 非零退出被当成功空输出，
// 面板显示「无改动」；CHANGES_DIFF 的 -U${context} 未校验，NaN/负数产生「整文件当新增」假象。
// 修法：runGit 返回 {stdout, code}；status/diff 非 0（--no-index 路径另许 1）判定失败 →
// {ok:false, reason:'git-error'} 新分支；CHANGES_DIFF 对 context 钳制（整数且 0..100000，非法回落 3）。
//
// hb12 §1.2 勘误对齐：runGitRaw 的拒绝分类钉 `typeof err.code === 'number'` 形态——
// maxBuffer 超限的 err.code 是字符串 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'（非 null），timeout 才无 code；
// 契约不得把 maxBuffer 场景钉成 code===null。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-changes-gitcode-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const panel = read('src/main/modules/changes-panel.ts');
const handlers = read('src/main/ipc-handlers.ts');
const types = read('src/shared/types/changes.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① runGit 返回带退出码。
check('① runGit 返回 {stdout, code}（不再丢弃退出码当成功）', () => {
  const idx = panel.indexOf('async function runGit(');
  const body = panel.slice(idx, panel.indexOf('\n}', idx));
  assert.match(body, /Promise<RawGitResult>/, 'runGit 签名未改带 code');
  assert.match(body, /runGitRaw\(cwd, args\)/, 'runGit 未透传 runGitRaw 结果');
  // runGitRaw 拒绝分类保持：err.code 为 number 才 resolve，其余（超时/spawn 失败/maxBuffer 字符串码）reject。
  const raw = panel.slice(panel.indexOf('function runGitRaw'), panel.indexOf('async function runGit('));
  assert.match(raw, /typeof err\.code === 'number'/, "runGitRaw 分类形态被改（hb12 §1.2：不得钉 maxBuffer code 为 null）");
});

// ② status/numstat/diff 非零退出 → git-error 失败分支。
check('② listChanges/getChangeDiff：非 0（no-index 路径另许 1）→ git-error 失败形态', () => {
  const listFn = panel.slice(panel.indexOf('export async function listChanges'), panel.indexOf('export async function getChangeDiff'));
  assert.match(listFn, /git-error/, 'listChanges 缺 git-error 失败分支');
  assert.match(listFn, /\.code !== 0/, 'listChanges status/numstat 未判退出码');
  const diffFn = panel.slice(panel.indexOf('export async function getChangeDiff'), panel.indexOf('export function openWithCommand'));
  assert.match(diffFn, /git-error/, 'getChangeDiff 缺 git-error 失败分支');
  // --no-index 有差异时 exit 1 是合法态：diff 路径须显式允许 1。
  assert.match(diffFn, /code !== 0 && .*!== 1|!== 1 &&|allowOne|code > 1/, 'diff 路径未放行合法 exit 1（no-index 差异态）');
});

// ③ 类型联合加 git-error 分支。
check('③ types/changes.ts：ChangesListResult/ChangesDiffResult 联合加 git-error 分支', () => {
  assert.match(types, /'not-a-repo' \| 'git-unavailable' \| 'git-error' \| 'error'/, 'ChangesListResult 缺 git-error');
  assert.match(types, /'not-a-repo' \| 'no-such-file' \| 'git-error' \| 'error'/, 'ChangesDiffResult 缺 git-error');
});

// ④ context 钳制。
check('④ CHANGES_DIFF handler：context 钳制（整数 0..100000，非法回落默认 3）', () => {
  const idx = handlers.indexOf('IPC_CHANNELS.CHANGES_DIFF');
  assert.ok(idx > -1, '未找到 CHANGES_DIFF handler');
  const body = handlers.slice(idx, idx + 600);
  assert.match(body, /Number\.isInteger/, '缺 Number.isInteger 校验');
  assert.match(body, /100000/, '缺上界钳制（100000）');
  assert.match(body, /\?\s*context\s*:\s*3|\?\s*\w+\s*:\s*3/, '非法值未回落默认 3');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
