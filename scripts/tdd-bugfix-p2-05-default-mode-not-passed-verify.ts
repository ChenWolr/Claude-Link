// tdd-bugfix-p2-05-default-mode-not-passed-verify.ts
// P2-5 契约钉：Options.permissionMode 恒传 'default' → CLI 旗标压过用户原生 permissions.defaultMode。
//
// 修复语义：有效档解析为 'default' 时不设置 options.permissionMode（保持 undefined），让原生
// settings 级联自决；非 default 档照传；bypassPermissions 的 allowDangerouslySkipPermissions
// 附加开关不受影响。运行时 CHAT_SET_PERMISSION_MODE 控制通道不在本项范围（勿动）。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-05-default-mode-not-passed-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildNativeSdkOptionsCore } = require('../src/main/modules/sdk-command-options');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

const exported = require('../src/main/modules/sdk-command-options');
const build = exported.buildNativeSdkOptionsCore ?? exported.default ?? null;
if (!build) {
  console.error('导出名核对失败：', Object.keys(exported).join(','));
  process.exit(1);
}

check('① permissionMode=default → options.permissionMode 保持 undefined', () => {
  const o = build({ env: {}, permissionMode: 'default' });
  assert.ok(!('permissionMode' in o), `permissionMode=${JSON.stringify(o.permissionMode)}`);
});
check('② permissionMode=acceptEdits 照传', () => {
  const o = build({ env: {}, permissionMode: 'acceptEdits' });
  assert.equal(o.permissionMode, 'acceptEdits');
});
check('③ permissionMode=bypassPermissions 照传 + 附 allowDangerouslySkipPermissions', () => {
  const o = build({ env: {}, permissionMode: 'bypassPermissions' });
  assert.equal(o.permissionMode, 'bypassPermissions');
  assert.equal(o.allowDangerouslySkipPermissions, true);
});
check('④ permissionMode=plan 照传', () => {
  const o = build({ env: {}, permissionMode: 'plan' });
  assert.equal(o.permissionMode, 'plan');
});
check('⑤ permissionMode 未传 → 不设置（回归不变）', () => {
  const o = build({ env: {} });
  assert.ok(!('permissionMode' in o));
});

// 结构：default 短路在源码中存在。
const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/modules/sdk-command-options.ts'), 'utf8');
check('⑥ 源码含 default 短路注释/条件', () => {
  assert.ok(/input\.permissionMode !== 'default'/.test(src));
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
