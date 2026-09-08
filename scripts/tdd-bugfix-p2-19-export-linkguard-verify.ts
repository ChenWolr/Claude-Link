// tdd-bugfix-p2-19-export-linkguard-verify.ts
// P2-19 契约钉：导出隐藏窗未挂 will-navigate/will-redirect 守卫（link-guard 未覆盖全部窗）。
//
// 修复语义：导出窗创建处调 setupLinkGuard(exportWindow, ELECTRON_RENDERER_URL)——dev 放行本地
// dev URL，生产全拦；与主窗同一守卫面。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-19-export-linkguard-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

const mgr = read('src/main/modules/export-image-manager.ts');

check('① 导出窗创建处挂 setupLinkGuard', () => {
  const at = mgr.indexOf('const exportWindow = new BrowserWindow');
  const seg = mgr.slice(at, at + 2500);
  assert.ok(seg.includes('setupLinkGuard(exportWindow'), seg.slice(0, 200));
});
check('② dev URL 透传（dev 放行本地、生产全拦）', () => {
  const at = mgr.indexOf('setupLinkGuard(exportWindow');
  assert.ok(mgr.slice(at, at + 200).includes('ELECTRON_RENDERER_URL'));
});
check('③ 既有 setWindowOpenHandler deny 保留（回归）', () => {
  const at = mgr.indexOf('const exportWindow = new BrowserWindow');
  assert.ok(mgr.slice(at, at + 2500).includes('setWindowOpenHandler'));
});
check('④ index 主窗守卫仍在（回归不变）', () => {
  assert.match(read('src/main/index.ts'), /setupLinkGuard\(mainWindow/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
