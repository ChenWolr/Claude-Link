// tdd-bugfix-f3-chat-set-permission-whitelist-verify.ts
// F3（P3 纵深防御，横切复查 2026-09-08）契约钉：CHAT_SET_PERMISSION_MODE 是唯一不做
// 权限档白名单的会话 IPC——mode 直传 resolveEffectivePermissionMode（其契约注释
// 「必为合法四档之一，调用方已过守卫」对本入口不成立）→ setRunningQueryPermissionMode
// → query.setPermissionMode（SDK 流式控制帧）。当前渲染层唯一调用方只传合法值（现网
// 不可达），但未来新增调用方传错值或渲染层被注入时，非法档会直送 SDK 控制帧。
//
// 修复语义：入口加 isValidPermissionMode 白名单（对齐 SESSION_CREATE/SESSION_UPDATE
// 先例）——非法值丢弃按 null（跟随全局默认）处理并 warn；既有契约窗口
// resolveEffectivePermissionMode(mode as PermissionMode | null, ...) 保形不破。
//
// 运行：npx tsx scripts/tdd-bugfix-f3-chat-set-permission-whitelist-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const handlers = fs.readFileSync(path.join(repoRoot, 'src/main/ipc-handlers.ts'), 'utf8');

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

console.log('=== F3 CHAT_SET_PERMISSION_MODE 白名单守卫 ===');
{
  const at = handlers.indexOf('IPC_CHANNELS.CHAT_SET_PERMISSION_MODE');
  const body = handlers.slice(at, handlers.indexOf('IPC_CHANNELS.INTERACTION_RESPOND', at));

  check('handler 存在', at !== -1);
  check('handler 内调 isValidPermissionMode 白名单', body.includes('isValidPermissionMode'));
  check('非法值记 warn 日志（对齐 SESSION_UPDATE 先例）', /isValidPermissionMode[\s\S]{0,200}logger\.warn/.test(body) || /logger\.warn[\s\S]{0,200}isValidPermissionMode/.test(body));
  check('非法值丢弃按 null（跟随全局）处理', body.includes('mode = null;'));
  // 既有契约（selftest-settings-mapping「权限中途切换」段）字面窗口保形
  check('保留 resolveEffectivePermissionMode(mode as PermissionMode | null, ...) 原样调用',
    body.includes('resolveEffectivePermissionMode(mode as PermissionMode | null, getConfig().permissionMode)'));
  check('保留 setRunningQueryPermissionMode(sessionId, effective)', body.includes('setRunningQueryPermissionMode(sessionId, effective)'));

  // 回归：同文件 SESSION_CREATE / SESSION_UPDATE 的白名单先例不受影响
  const createBody = handlers.slice(handlers.indexOf('IPC_CHANNELS.SESSION_CREATE'), handlers.indexOf('IPC_CHANNELS.SESSION_GET'));
  check('SESSION_CREATE 白名单先例仍在', createBody.includes('isValidPermissionMode'));
  const updateBody = handlers.slice(handlers.indexOf('IPC_CHANNELS.SESSION_UPDATE'), handlers.indexOf('IPC_CHANNELS.SESSION_SEARCH'));
  check('SESSION_UPDATE 白名单先例仍在', updateBody.includes('isValidPermissionMode'));
}

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
