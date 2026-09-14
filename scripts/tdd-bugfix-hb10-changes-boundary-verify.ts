// scripts/tdd-bugfix-hb10-changes-boundary-verify.ts
// hb10 P2-8（CHG-02+CHG-V01/V02）契约：diff 缓存跨回合陈旧 + 路径信任边界 + workingDir 绑定。
//
// 病根：① refresh 成功后只保留「仍在列表」的 diff 缓存——同会话回合 B 修改同文件后打开显示
// 旧 diff（跨回合陈旧）；② getChangeDiff 无路径信任边界——`../x` 与 `.git/config` 可被拉 diff；
// ③ CHANGES_* 三通道 workingDir 任意指定——受损 renderer 可对任意目录跑 git。
// 修法：①sending 下降沿刷新成功后全清 diffCache（回合结束=全部 diff 可能变化）；
// ②getChangeDiff 入口校验：仓库根相对路径、越界拒绝、.git 段拒绝（导出纯函数供行为测试）；
// ③ipc 三通道 workingDir 绑定允许集（配置工作目录 ∪ 会话库工作目录；null 走既有降级链路）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-changes-boundary-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const panel = read('src/main/modules/changes-panel.ts');
const store = read('src/renderer/stores/changes-store.ts');
const handlers = read('src/main/ipc-handlers.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// 行为级：isSafeRepoRelPath 纯函数（直接 import 生产实现）。
// eslint 冲突规避：契约脚本与生产同仓，直接相对导入。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isSafeRepoRelPath, isPathInsideRoot } = require('../src/main/modules/changes-panel') as {
  isSafeRepoRelPath: (rel: string) => boolean;
  isPathInsideRoot: (abs: string, root: string) => boolean;
};

check('① 行为级 isSafeRepoRelPath：`../x`/`.git/config`/`.git`/绝对路径拒绝；正常相对路径放行', () => {
  assert.equal(isSafeRepoRelPath('src/index.ts'), true, '正常相对路径被拒');
  assert.equal(isSafeRepoRelPath('a/b/c.txt'), true, '多层正常路径被拒');
  assert.equal(isSafeRepoRelPath('../x'), false, '../ 逃逸未拒');
  assert.equal(isSafeRepoRelPath('.git/config'), false, '.git/config 未拒');
  assert.equal(isSafeRepoRelPath('.git'), false, '.git 未拒');
  assert.equal(isSafeRepoRelPath('a/.git/config'), false, '嵌套 .git 段未拒');
  assert.equal(isSafeRepoRelPath('C:/Windows/system32'), false, '绝对路径未拒');
  assert.equal(isSafeRepoRelPath(''), false, '空路径未拒');
});

check('② changes-panel：getChangeDiff 入口调用 isSafeRepoRelPath + isPathInsideRoot 越界双保险', () => {
  const fnIdx = panel.indexOf('export async function getChangeDiff');
  const body = panel.slice(fnIdx, panel.indexOf('export function openWithCommand'));
  assert.match(body, /isSafeRepoRelPath\(path\)/, 'getChangeDiff 缺安全路径判定');
  assert.match(body, /isPathInsideRoot\(/, 'getChangeDiff 缺越界判定');
  const safeIdx = body.indexOf('isSafeRepoRelPath(path)');
  const dirIdx = body.indexOf("path.endsWith('/')");
  assert.ok(dirIdx > safeIdx, '安全判定必须先于目录兜底/git 调用（先校验后执行）');
});

check('③ changes-store：sending 下降沿刷新成功后全清 diffCache（跨回合陈旧修复）', () => {
  assert.match(store, /invalidateDiffs/, 'refresh 缺 invalidateDiffs 参数');
  const watchIdx = store.indexOf('() => sessionStore.sending');
  assert.ok(watchIdx > -1, '未找到 sending watch');
  const watchBody = store.slice(watchIdx, store.indexOf('\n  );', watchIdx));
  assert.match(watchBody, /refresh\(true\)/, 'sending 下降沿未以 invalidateDiffs=true 刷新');
  // 成功分支里全清逻辑存在。
  const refreshIdx = store.indexOf('async function refresh(');
  const refreshBody = store.slice(refreshIdx, store.indexOf('\n  }', refreshIdx + 10) + 4);
  assert.match(refreshBody, /if \(invalidateDiffs\)[\s\S]{0,140}diffCache\.value = \{\};/, '成功分支缺全清 diffCache');
});

check('④ ipc 三通道 workingDir 绑定（允许集=配置工作目录 ∪ 会话库工作目录）', () => {
  assert.match(handlers, /isBoundWorkingDir/, 'ipc-handlers 缺 workingDir 绑定谓词');
  assert.match(handlers, /listSessions\(\)/, '绑定允许集未与会话库比对');
  const changesSeg = handlers.slice(handlers.indexOf('IPC_CHANNELS.CHANGES_LIST'), handlers.indexOf('// Config'));
  const binds = changesSeg.match(/isBoundWorkingDir\(/g) ?? [];
  assert.ok(binds.length >= 3, `三通道（LIST/DIFF/OPEN）绑定调用不足（实际 ${binds.length} 处）`);
  assert.match(changesSeg, /工作目录不在允许列表/, '绑定命中缺拒绝文案');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
