// scripts/tdd-bugfix-hb10-quit-flag-verify.ts
// hb10 P2-14（SHL-01）契约：before-quit 不置 quitting（取消退出已先行拆毁）。
//
// 病根：minimizeToTray=true 时 app.quit()（如 Cmd+Q/程序化退出）先触发 mainWindow 的 close 事件，
// close 处理器因 quitting=false 走「隐藏到托盘」分支并 preventDefault——退出被拦截，而
// before-quit 里 killAllProcesses/closeConnection 已执行（取消的退出已先行拆毁运行环境）。
// 修法：before-quit 回调首行 quitting = true（一行修复；close 不再拦，quit 必然走完）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-quit-flag-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const mainIndex = fs.readFileSync(path.join(repoRoot, 'src/main/index.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

check('before-quit 回调首行置 quitting = true（先于 killAllProcesses 等拆毁动作）', () => {
  const idx = mainIndex.indexOf("app.on('before-quit'");
  assert.ok(idx > -1, '未找到 before-quit 处理');
  const body = mainIndex.slice(idx, mainIndex.indexOf('\n});', idx));
  const flagIdx = body.indexOf('quitting = true;');
  assert.ok(flagIdx > -1, 'before-quit 回调缺 quitting = true');
  const killIdx = body.indexOf('killAllProcesses()');
  assert.ok(killIdx > flagIdx, 'quitting 置位必须先于 killAllProcesses（close 处理器看的是它）');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
