// tdd-bugfix-f6-ipc-register-idempotent-guard-verify.ts
// F6（P3 仅 macOS，代码级推演，横切复查 2026-09-08）契约钉：关掉全部窗口后从 Dock 重开——
// window-all-closed 已 stopCommandSourceWatcher（darwin 不退出），Dock 重开 → activate →
// createWindow → registerIpcHandlers 在第一个重复通道上同步抛 "Attempted to register a
// second handler"（全仓 removeHandler 零调用、无注册守卫）→ trackWindowSize 被跳过；
// 命令源监视与全局兜底探测也无重启点，永久失效。
//
// 修复语义（仅实现幂等守卫与重启点，真机验证不在本轮范围）：
// ① ipc-handlers registerIpcHandlers 入口加模块级 registered 守卫——重复调用先更新模块级
//    mainWindow（事件仍可达新窗）再 return，不再抛「second handler」；
// ② index.ts activate 路径 createWindow 后补 startGlobalCommandPipeline()（全局兜底探测 +
//    startCommandSourceWatcher 重启，依赖注入与 whenReady 首启共用同一 helper）。
//
// 运行：npx tsx scripts/tdd-bugfix-f6-ipc-register-idempotent-guard-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const handlers = fs.readFileSync(path.join(repoRoot, 'src/main/ipc-handlers.ts'), 'utf8');
const mainIndex = fs.readFileSync(path.join(repoRoot, 'src/main/index.ts'), 'utf8');

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

console.log('=== F6-① registerIpcHandlers 幂等守卫 ===');
{
  check('模块级 registered 守卫标志存在', /let ipcHandlersRegistered = false;/.test(handlers));
  const fnAt = handlers.indexOf('export function registerIpcHandlers');
  const fnBody = handlers.slice(fnAt, handlers.indexOf('ipcMain.handle', fnAt));
  check('守卫在函数入口', fnBody.includes('if (ipcHandlersRegistered) return;'));
  check('重复调用仍先更新模块级 mainWindow（mainWindow = mainWindowRef 在守卫前）',
    fnBody.indexOf('mainWindow = mainWindowRef;') !== -1 &&
    fnBody.indexOf('mainWindow = mainWindowRef;') < fnBody.indexOf('if (ipcHandlersRegistered) return;'));
  check('首次调用置位标志', fnBody.includes('ipcHandlersRegistered = true;'));
}

console.log('=== F6-② activate 路径恢复命令管线 ===');
{
  check('startGlobalCommandPipeline helper 存在（首启/重启共用依赖注入）', /function startGlobalCommandPipeline\(\)/.test(mainIndex));
  const helperAt = mainIndex.indexOf('function startGlobalCommandPipeline()');
  const helperBody = mainIndex.slice(helperAt, mainIndex.indexOf('}', mainIndex.indexOf('startCommandSourceWatcher({', helperAt)) + 1);
  check('helper 内启动全局兜底探测', helperBody.includes('runGlobalCommandProbe('));
  check('helper 内启动命令源监视', helperBody.includes('startCommandSourceWatcher({'));
  check('helper 注入 getUserHome/workingDirectory/onConfigSaved',
    helperBody.includes('getUserHome: effectiveUserHome') &&
    helperBody.includes('getWorkingDirectory: () => getConfig().workingDirectory') &&
    helperBody.includes('onConfigSaved,'));

  const activateAt = mainIndex.indexOf("app.on('activate'");
  const activateBody = mainIndex.slice(activateAt, mainIndex.indexOf('});', activateAt));
  check('activate 在 createWindow 后重启命令管线', /createWindow\(\);[\s\S]{0,300}startGlobalCommandPipeline\(\);/.test(activateBody));

  // 依赖注入去重：whenReady 首启与 activate 共用 helper，注入对象全文件只出现一份
  const injectionCount = (mainIndex.match(/getUserHome: effectiveUserHome/g) || []).length;
  check(`依赖注入对象唯一（实际 ${injectionCount} 份，应为 1）`, injectionCount === 1);

  // 回归：window-all-closed / before-quit 的停机链不受影响
  const wacAt = mainIndex.indexOf("app.on('window-all-closed'");
  const wacBody = mainIndex.slice(wacAt, mainIndex.indexOf('});', wacAt));
  check('window-all-closed 仍停 watcher', wacBody.includes('stopCommandSourceWatcher()'));
}

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
