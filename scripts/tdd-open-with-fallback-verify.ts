// tdd-open-with-fallback-verify.ts
// 「打开」文件降级行为测试：shell.openPath 失败时，Windows 须能弹原生「打开方式」对话框。
// 纯函数 openWithCommand 是降级决策的核心：给定平台返回弹「打开方式」的命令，不支持返回 null。
// p4（2026-10-27 五问题计划）：新增「打开方式…」直达通道——openChangeFile 第三参 mode
// （default=既有默认程序+降级 / choose=直达 rundll32 对话框）+ DiffDialog footer 双按钮 +
// preload 三参签名（静态源钉）。
// 运行：npx tsx scripts/tdd-open-with-fallback-verify.ts
import * as path from 'path';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
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

// ── p4（2026-10-27 五问题计划 §4.4）：「打开方式…」直达通道静态源钉 ───────────────
const changesPanelSrc = readFileSync(new URL('../src/main/modules/changes-panel.ts', import.meta.url), 'utf8');
const diffDialogSrc = readFileSync(new URL('../src/renderer/components/changes/DiffDialog.vue', import.meta.url), 'utf8');
const preloadSrc = readFileSync(new URL('../src/preload/api.ts', import.meta.url), 'utf8');

check('p4: openChangeFile 签名含 mode 默认参（default=既有路径逐字不动）', () => {
  assert.ok(
    changesPanelSrc.includes("mode: 'default' | 'choose' = 'default'"),
    'openChangeFile 缺第三参 mode: \'default\' | \'choose\' = \'default\'',
  );
});

check('p4: openChooseDialog helper 存在且被 choose 分支直达（守卫链之后）', () => {
  assert.ok(changesPanelSrc.includes('async function openChooseDialog('), '缺 openChooseDialog helper');
  assert.ok(
    changesPanelSrc.includes("if (mode === 'choose') return openChooseDialog(abs)"),
    '缺 choose 分支直达 openChooseDialog',
  );
});

check('p4: 非 win32 不支持文案 + 对话框启动失败文案字面', () => {
  assert.ok(changesPanelSrc.includes('当前平台暂不支持选择打开方式'), '缺非 win32 不支持文案');
  assert.ok(changesPanelSrc.includes('打开方式对话框启动失败'), '缺对话框启动失败文案');
});

check('p4: DiffDialog 次级「打开方式…」按钮（class="btn" 非 primary + choose 调用）', () => {
  assert.ok(diffDialogSrc.includes("openExternally('choose')"), '缺 openExternally(\'choose\') 调用');
  assert.ok(diffDialogSrc.includes('>打开方式…'), '缺「打开方式…」按钮文案');
  // 次级按钮 class 恰为 "btn"（非 btn--primary）：抽 class="btn" 的按钮开标验证。
  assert.ok(/<button class="btn" type="button"[^>]*openExternally\('choose'\)/.test(diffDialogSrc.replace(/\n\s*/g, ' ')), 'choose 按钮须用次级 class="btn"');
});

check('p4: 「打开」按钮显式无参调用（防 MouseEvent 误入 mode 形参）', () => {
  assert.ok(/@click="openExternally\(\)"/.test(diffDialogSrc), '「打开」按钮须 @click="openExternally()"（显式括号）');
  assert.ok(!/openExternally"[^>]*>/.test(diffDialogSrc.replace(/\n\s*/g, ' ').replace(/@click="openExternally\(\)"/g, '')), '残留 openExternally 裸引用（MouseEvent 会误入 mode 形参）');
});

check('p4: preload openChangeFile 三参签名（mode 可选）', () => {
  assert.ok(
    preloadSrc.includes("mode?: 'default' | 'choose'"),
    'preload 类型缺 mode?: \'default\' | \'choose\'',
  );
  assert.ok(
    preloadSrc.includes('CHANGES_OPEN_FILE, workingDir, path, mode'),
    'preload 实现未透传第三参 mode',
  );
});

console.log(`\nopen-with-fallback: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
