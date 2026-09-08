// tdd-bugfix-n11-menu-open-commands-get-verify.ts
// N11（P2-14/P3-4 断链接线）契约钉：**打开斜杠菜单的路径必须存在 COMMANDS_GET 调用**。
//
// 背景：P2-14（stale 比对）与 P3-4（degraded 重试）都发生在主进程 COMMANDS_GET 处理器内，
// 但渲染层只有会话生命周期三处（session-store：暂态物化/切回/创建）调 commandStore.load；
// 用户「留在会话内重开 `/` 菜单」不发任何 IPC → stale 重探与 degraded 重试永不触发。
// 修复：ChatInput.handleInput 在菜单打开时经 1.5s 去抖（与 command-source-watcher 同款节流
// 时长）调 commandStore.load(activeSession.id)。既有三处调用点行为不变。
//
// 运行：npx tsx scripts/tdd-bugfix-n11-menu-open-commands-get-verify.ts

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..');
function src(rel: string): string {
  return readFileSync(path.join(root, rel), 'utf8');
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('N11 契约：菜单打开路径触发 COMMANDS_GET');

const chatInput = src('src/renderer/components/chat/ChatInput.vue');

// ① ChatInput 引入 command-store（菜单路径的 load 调用主体）。
check('① ChatInput.vue 引入 useCommandStore',
  /import\s*\{[^}]*useCommandStore[^}]*\}\s*from/.test(chatInput));

// ② 存在 1.5s 去抖常量（与 command-source-watcher 同款节流时长，注释指明来源）。
check('② ChatInput.vue 菜单刷新去抖 = 1500ms',
  /MENU_COMMANDS_REFRESH_DEBOUNCE_MS\s*=\s*1500/.test(chatInput));

// ③ 菜单打开路径调用刷新调度：handleInput 在 showSlashMenu 为真时调用调度函数。
const scheduleCall = /showSlashMenu\.value[^;]*;\s*[^}]*scheduleMenuCommandsRefresh\(\)/.test(chatInput)
  || /if\s*\(\s*showSlashMenu\.value\s*\)\s*\{?\s*scheduleMenuCommandsRefresh\(\)/.test(chatInput);
check('③ handleInput 菜单打开时调用 scheduleMenuCommandsRefresh', scheduleCall);

// ④ 调度函数经 setTimeout 去抖后调 commandStore.load（即 COMMANDS_GET 的 store 入口）。
const loadInSchedule = /scheduleMenuCommandsRefresh[\s\S]{0,900}?\.load\(\s*\w+\.id\s*\)/.test(chatInput)
  || /scheduleMenuCommandsRefresh[\s\S]{0,900}?commandStore\.load/.test(chatInput);
check('④ 去抖后调用 commandStore.load（COMMANDS_GET 用户层入口）', loadInSchedule);

// ⑤ 组件卸载清理菜单刷新定时器（onUnmounted 内经 cancelMenuCommandsRefresh 收口）。
check('⑤ onUnmounted 清理菜单刷新定时器',
  /onUnmounted\(\(\)\s*=>\s*\{[\s\S]{0,400}?cancelMenuCommandsRefresh\(\);[\s\S]{0,200}?\}\);/.test(chatInput));

// ⑥ 命令 store 的 load 仍走 getSessionCommands（COMMANDS_GET 通道，既有契约不回归）。
const commandStore = src('src/renderer/stores/command-store.ts');
check('⑥ command-store.load 仍走 getSessionCommands（COMMANDS_GET）',
  /async load\(sessionId: string\)[\s\S]{0,400}getSessionCommands\(sessionId\)/.test(commandStore));

// ⑦ 既有三处会话生命周期调用点保持不变（暂态物化/切回/创建）。
const sessionStore = src('src/renderer/stores/session-store.ts');
const loadSites = (sessionStore.match(/useCommandStore\(\)\.load\(/g) ?? []).length;
check('⑦ session-store 既有 load 调用点 ≥3（行为不变）', loadSites >= 3, `实测 ${loadSites} 处`);

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
