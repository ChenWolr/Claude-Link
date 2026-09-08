// tdd-bugfix-n1-explicit-default-inline-settings-verify.ts
// N1（P1）契约钉：会话显式选「默认模式」被架空且方向为越权放行。
//
// 链路：alignPermissionDefaultMode 只对齐内联 settings 块（会话显式 default 时**删除**
// defaultMode），但工作目录投影文件 settings.local.json 始终按**全局**档写 defaultMode
//（buildPermissionSettings 无会话上下文）；叠加 P2-5「default 不传旗标」，CLI 按层叠回落
// 读到投影文件里的全局档——UI 显示「默认模式」、实际按全局（如自动模式）放行。
//
// 修法（定案）：alignPermissionDefaultMode 的 default 分支由「删除 defaultMode」改为
// 「写 defaultMode:'default'」——该函数仅在会话显式选档（opts.permissionMode != null）时被
// 调用，显式选择写显式值压掉投影文件层是正确语义；投影侧（buildPermissionSettings）与
// P2-5 旗标语义都不动（它们管的是「未选」场景）。
//
// 运行：npx tsx scripts/tdd-bugfix-n1-explicit-default-inline-settings-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  alignPermissionDefaultMode,
  buildPermissionSettings,
  type SdkPermissionSettings,
} from '../src/main/modules/sdk-permissions';

const repoRoot = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

// ── 行为契约 ──
check('① N1 主场景：显式 default + 全局 bypass → 内联块 defaultMode=\'default\'（压掉投影文件层）', () => {
  const next = alignPermissionDefaultMode(
    { defaultMode: 'bypassPermissions', allow: ['Read'] } as SdkPermissionSettings,
    'default',
  );
  assert.equal(next.defaultMode, 'default', `got ${String(next.defaultMode)}`);
  assert.deepEqual(next.allow, ['Read'], '其余字段保留');
});
check('② 显式非 default 档仍写有效档（既有语义不回退）', () => {
  const next = alignPermissionDefaultMode({ defaultMode: 'acceptEdits' } as SdkPermissionSettings, 'bypassPermissions');
  assert.equal(next.defaultMode, 'bypassPermissions');
});
check('③ 不 mutate 入参（调用方可能传原引用）', () => {
  const source: SdkPermissionSettings = { defaultMode: 'bypassPermissions' };
  alignPermissionDefaultMode(source, 'default');
  assert.equal(source.defaultMode, 'bypassPermissions');
});
check('④ 投影侧 buildPermissionSettings「未选」语义不动（default 不强制写，管未选场景）', () => {
  const fromJson = buildPermissionSettings({ permissionMode: 'default', advancedJson: null });
  assert.equal(fromJson.defaultMode, undefined, '未选场景仍不写 defaultMode');
  const explicit = buildPermissionSettings({ permissionMode: 'bypassPermissions', advancedJson: null });
  assert.equal(explicit.defaultMode, 'bypassPermissions', '非 default 仍写档');
});

// ── 结构契约：接线保持 ──
check('⑤ sdk-backend 仍仅在会话显式选档（opts.permissionMode != null）时对齐', () => {
  const backend = read('src/main/modules/sdk-backend.ts');
  assert.ok(backend.includes('if (opts.permissionMode != null)'));
  assert.ok(backend.includes('permissions = alignPermissionDefaultMode(permissions, effectivePermissionMode)'));
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
