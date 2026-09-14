// scripts/tdd-bugfix-hb12-engine-misc-verify.ts
// hb12 P2-3【引擎批】契约（hb12-ENG-02收窄 / ENG-04 / ENG-05 / ENG-03 卫生）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb12-engine-misc-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const backend = read('src/main/modules/sdk-backend.ts');
const engine = read('src/main/modules/task-queue-engine.ts');
const chat = read('src/renderer/composables/use-chat.ts');
const tester = read('src/main/modules/connection-tester.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① hb12-ENG-02：resend 占坑收口 + 归零守卫 standby。
check('① ENG-02：resendUserText spawn 后 beginUserTurn；归零守卫占坑命中收口 standby', () => {
  const rsIdx = backend.indexOf('hb12-ENG-02（收窄）：resend 绕过 CHAT_SEND');
  const rsBody = backend.slice(rsIdx, rsIdx + 400);
  assert.match(rsBody, /beginUserTurn\(sessionId, mainWindow\);/, 'resend 缺 beginUserTurn');
  const sendIdx = backend.indexOf('sendMessage(sessionId, text);', rsIdx);
  const beginIdx = backend.indexOf('beginUserTurn(sessionId, mainWindow);', rsIdx);
  assert.ok(beginIdx < sendIdx, 'beginUserTurn 必须先于 sendMessage');
  assert.match(engine, /hb12-ENG-02（收窄）：重发占坑（beginUserTurn 置 running）/, '归零守卫缺收口注释');
  assert.match(engine, /if \(getActiveProcess\(sessionId\)\) \{\s*\/\/[^\r\n]*\r?\n\s*state\.status = 'standby';/, '占坑命中缺 standby 收口');
});

// ② hb12-ENG-04：api_retry 不清 stalled。
check('② ENG-04：isStallRecoveryEvent 排除 api_retry（与主进程口径一致）', () => {
  const idx = chat.indexOf('function isStallRecoveryEvent');
  const body = chat.slice(idx, chat.indexOf('\n  }', idx));
  assert.match(body, /event\.subtype !== 'api_retry'/, 'system 分支未排除 api_retry');
});

// ③ hb12-ENG-05：windowsHide 两处。
check('③ ENG-05：post-turn 探针与 connection-tester spawn 带 windowsHide', () => {
  assert.match(backend, /spawn\(exe, args, \{ cwd, env, stdio: \['ignore', 'pipe', 'pipe'\], windowsHide: true \}\);/, '探针缺 windowsHide');
  assert.match(tester, /windowsHide: true,/, 'tester 缺 windowsHide');
});

// ④ hb12-CFG-03：测试 spawn stdin ignore。
check('④ CFG-03：connection-tester spawn stdio ignore（prompt 走 argv）', () => {
  assert.match(tester, /stdio: \['ignore', 'pipe', 'pipe'\],/, 'tester stdin 非 ignore');
});

// ⑤ hb12-ENG-03：breaker 清口。
check('⑤ ENG-03：markSessionDeleted 清 contextRefreshBreaker', () => {
  const idx = backend.indexOf('export function markSessionDeleted');
  const body = backend.slice(idx, idx + 400);
  assert.match(body, /contextRefreshBreaker\.delete\(sessionId\);/, '缺 breaker 清口');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
