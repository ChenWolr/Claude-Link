// tdd-open-with-fallback-verify.ts
// 「打开」文件降级行为测试：shell.openPath 失败时，Windows 须能弹原生「打开方式」对话框。
// 纯函数 openWithCommand 是降级决策的核心：给定平台返回弹「打开方式」的命令，不支持返回 null。
// 运行：npx tsx scripts/tdd-open-with-fallback-verify.ts
import * as path from 'path';
import { strict as assert } from 'node:assert';
import { openWithCommand, isPathInsideRoot } from '../src/main/modules/changes-panel';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

check('win32 平台返回 rundll32 命令弹打开方式对话框', () => {
  const cmd = openWithCommand('C:\\repo\\file.txt', 'win32');
  assert.ok(cmd, 'win32 须返回命令对象');
  assert.equal(cmd!.command, 'rundll32.exe');
  assert.ok(cmd!.args.includes('shell32.dll,OpenAs_RunDLL'), 'args 须含 shell32.dll,OpenAs_RunDLL');
  assert.ok(cmd!.args.includes('C:\\repo\\file.txt'), 'args 须含传入路径');
});

check('darwin 平台返回 null（暂不支持原生打开方式对话框）', () => {
  assert.equal(openWithCommand('/Users/x/file.txt', 'darwin'), null);
});

check('linux 平台返回 null（暂不支持原生打开方式对话框）', () => {
  assert.equal(openWithCommand('/home/x/file.txt', 'linux'), null);
});

check('不传 platform 时默认用 process.platform', () => {
  const cmd = openWithCommand('C:\\repo\\default.txt');
  if (process.platform === 'win32') {
    assert.ok(cmd, 'win32 默认须返回命令对象');
    assert.equal(cmd!.command, 'rundll32.exe');
  } else {
    assert.equal(cmd, null, `${process.platform} 默认须返回 null`);
  }
});

check('isPathInsideRoot: 正斜杠 root + 规范化 abs 在内 → true（Windows git root 场景）', () => {
  const root = 'D:/software/code/claude-link';
  const abs = path.resolve(root, 'src/main/modules/changes-panel.ts');
  assert.equal(isPathInsideRoot(abs, root), true, 'abs 在 root 内须返回 true');
});

check('isPathInsideRoot: 越界路径 → false', () => {
  const root = 'D:/software/code/claude-link';
  const outside = path.resolve('D:/other/place', 'file.txt');
  assert.equal(isPathInsideRoot(outside, root), false, '越界路径须返回 false');
});

check('isPathInsideRoot: abs === root → true（边界）', () => {
  const root = 'D:/software/code/claude-link';
  assert.equal(isPathInsideRoot(root, root), true, 'abs 等于 root 须返回 true');
});

console.log(`\nopen-with-fallback: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
