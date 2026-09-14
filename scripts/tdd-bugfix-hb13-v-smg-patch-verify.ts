// scripts/tdd-bugfix-hb13-v-smg-patch-verify.ts
// hb13-v B10.1【会话】契约：LLM 主题回调 patchSessionInLists 条件写（session-mgmt F4）。
//
// 病根：analyzeTopic 回调里 activeSession 覆盖有 isAutoSessionName 门，但列表 patch 无条件
// 执行——主进程写前门（isAutoNameSlot）拒绝（用户已改名）时仍返回 topic，旧实现把 LLM 主题
// 名写进侧栏列表/搜索视图，与 DB/activeSession 的用户名分叉到下次整表 reload。
// 修法：patch 前比对列表项现名仍是自动形态（与 activeSession 分支同门槛）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb13-v-smg-patch-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const store = fs.readFileSync(path.join(repoRoot, 'src/renderer/stores/session-store.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

check('B10.1：LLM 主题回调列表 patch 前判列表项现名仍是自动形态', () => {
  const cbIdx = store.indexOf("window.claudeLink.analyzeTopic(sessionId, textContent)");
  assert.ok(cbIdx > -1, '未找到 analyzeTopic 回调');
  const cbBody = store.slice(cbIdx, cbIdx + 900);
  const patchIdx = cbBody.indexOf('this.patchSessionInLists(sessionId, { name: topic })');
  assert.ok(patchIdx > -1, 'patch 调用丢失（命名能力被误删）');
  const seg = cbBody.slice(0, patchIdx);
  assert.match(seg, /listItem && isAutoSessionName\(listItem\.name\)/, '列表 patch 前缺「列表项现名仍是自动形态」门槛（F4 显示分叉形态）');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
