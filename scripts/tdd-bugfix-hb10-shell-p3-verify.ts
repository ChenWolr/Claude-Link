// scripts/tdd-bugfix-hb10-shell-p3-verify.ts
// hb10 P3 SHL 批 + hb12 P2-10 SHL 批契约（SHL-05/07/08/09收窄/10/V02/V01、hb12-SHL-01/02/03/04/05）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-shell-p3-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const mainIndex = read('src/main/index.ts');
const cliDet = read('src/main/modules/cli-detector.ts');
const analyzer = read('src/main/modules/topic-analyzer.ts');
const handlers = read('src/main/ipc-handlers.ts');
const linkGuard = read('src/main/modules/link-guard.ts');
const notifier = read('src/main/modules/session-completion-notifier.ts');
const chat = read('src/renderer/composables/use-chat.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① SHL-07：topic 兜底名过条件掩码（hb13-v A4 必要同步）——旧钉 maskApiKey(rawFallback)
// 文字钉住无条件掩码缺陷形态（任意非空输入变 sk-…****，全部兜底标题被毁）；新谓词仅
// sk- key 形态才掩码（保留原防泄露意图），断言为旧意图的精确化、非弱化。
check('① SHL-07：topic-analyzer fallback 过条件掩码（sk- key 形态才掩码，掩码后截断）', () => {
  assert.match(analyzer, /\^sk-\[A-Za-z0-9_\\-\]\{8,\}\/\.test\(rawFallback\) \? maskApiKey\(rawFallback\) : rawFallback\)\.slice\(0, 15\);/, '兜底名未过条件掩码（sk- 形态判定 ? maskApiKey : 原样）');
  assert.match(analyzer, /maskApiKey/, '缺 maskApiKey import');
});

// ② SHL-08/V01：两个 handler 校验。
check('② SHL-08/V01：CLAUDE_PLAN_GET/MESSAGE_GET_BY_SESSION sessionId 校验', () => {
  const planIdx = handlers.indexOf('IPC_CHANNELS.CLAUDE_PLAN_GET');
  const planBody = handlers.slice(planIdx, planIdx + 500);
  assert.ok(planBody.includes("typeof sessionId !== 'string' || !sessionId.trim()"), 'CLAUDE_PLAN_GET 缺校验');
  const msgIdx = handlers.indexOf('IPC_CHANNELS.MESSAGE_GET_BY_SESSION');
  const msgBody = handlers.slice(msgIdx, msgIdx + 500);
  assert.ok(msgBody.includes("typeof sessionId !== 'string' || !sessionId.trim()"), 'MESSAGE_GET_BY_SESSION 缺校验');
});

// ③ SHL-09/V02/10。
check('③ SHL-09/V02/10：link-guard dev debug + exec 白名单 + smoke 根可配置', () => {
  assert.ok(linkGuard.includes('[link-guard] dev renderer 导航放行'), 'link-guard 缺 debug');
  assert.ok(cliDet.includes('hb10-SHL-V02'), 'exec 壳缺白名单注释');
  assert.ok(cliDet.includes("process.platform === 'win32' && /^["), 'exec 壳缺白名单判据');
  assert.ok(mainIndex.includes('CLAUDE_LINK_SMOKE_ROOT'), 'smoke 根不可配置');
});

// ④ hb12-SHL-01。
check('④ hb12-SHL-01：render-process-gone 计数式 reload（限 2 次）+ cancel 合流 + did-finish-load 复位', () => {
  const idx = mainIndex.indexOf('hb12-SHL-01');
  const body = mainIndex.slice(idx, idx + 2400);
  assert.ok(body.includes('cancelAllPendingInteractions();'), '缺 cancel 合流');
  assert.ok(body.includes('reloadCount >= 2'), '缺计数上限');
  assert.ok(body.includes('clean-exit'), '缺 clean-exit 排除');
  assert.ok(body.includes('webContents.reload()'), '缺 reload');
  assert.ok(mainIndex.includes('reloadCount = 0;'), '缺成功复位');
});

// ⑤ hb12-SHL-02。
check('⑤ hb12-SHL-02：closed 置 null + showMainWindow isDestroyed 短路 + syncTray 防御', () => {
  assert.ok(/mainWindow\.on\('closed', \(\) => \{\s*mainWindow = null;\s*\}\);/.test(mainIndex), '缺 closed 置 null');
  const showIdx = mainIndex.indexOf('function showMainWindow');
  const showBody = mainIndex.slice(showIdx, showIdx + 400);
  assert.ok(showBody.includes('mainWindow.isDestroyed()'), 'showMainWindow 缺 isDestroyed 短路');
  assert.ok(mainIndex.includes('goneOrVisible'), 'syncTrayWithConfig 缺防御');
});

// ⑥ hb12-SHL-03。
check('⑥ hb12-SHL-03：通知点击带 sessionId（notifier 签名 + 主进程导航事件 + 渲染层切换）', () => {
  assert.ok(notifier.includes('focusHook?.(sessionId);'), 'notifier 未透传 sessionId');
  assert.ok(mainIndex.includes('setNotificationFocusHook((sessionId) => {'), '主进程 hook 未带 sessionId');
  assert.ok(mainIndex.includes("type: 'navigate'"), '缺导航事件');
  assert.ok(chat.includes("=== 'navigate'"), '渲染层缺 navigate 处理');
  assert.ok(chat.includes('store.switchSession(target)'), 'navigate 缺会话切换');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
