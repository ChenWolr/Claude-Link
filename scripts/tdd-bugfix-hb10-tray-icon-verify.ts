// scripts/tdd-bugfix-hb10-tray-icon-verify.ts
// hb10 P2-15（SHL-03）契约：打包版托盘图标必空白（运行时查找路径与 extraResources 落点错位）。
//
// 病根：trayIcon() 打包分支查 `<resourcesPath>/resources/icon.png`，而 electron-builder
// extraResources 的 to: "icon.png" 相对 resources 根（经 app-builder-lib 源码证实）——实际落点
// `<resourcesPath>/icon.png`，并无 resources/ 子目录 → 打包版 createFromPath 必落 createEmpty()
// → 托盘空白。修法：packaged 分支改查 `join(process.resourcesPath, 'icon.png')`；
// dev 分支保留 `join(app.getAppPath(), 'resources', 'icon.png')`。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-tray-icon-verify.ts

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

check('trayIcon：打包分支查找 resourcesPath/icon.png（与 extraResources 实际落点一致）', () => {
  const idx = mainIndex.indexOf('function trayIcon()');
  assert.ok(idx > -1, '未找到 trayIcon');
  const body = mainIndex.slice(idx, mainIndex.indexOf('\n}', idx));
  assert.match(body, /app\.isPackaged\s*\?\s*process\.resourcesPath/, '打包分支未锚 process.resourcesPath');
  // dev 基准由 base 三元式覆盖：app.isPackaged ? process.resourcesPath : app.getAppPath()。
  assert.match(body, /join\(base, 'icon\.png'\)/, "打包分支缺 join(base, 'icon.png')（resources/ 子目录不存在）");
  // 完整形态钉：打包=resourcesPath/icon.png，dev=resources/icon.png（dev 分支合法保留 resources/ 子目录）。
  assert.match(body, /createFromPath\(app\.isPackaged \? join\(base, 'icon\.png'\) : join\(base, 'resources', 'icon\.png'\)\)/, '查找形态偏离（打包分支须 resourcesPath 根，dev 分支保留 resources/）');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
