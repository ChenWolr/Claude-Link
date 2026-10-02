// tdd-skill-home-anchor-verify.ts
// A10（D07-F2，P2）契约钉：SKILL_PROJECT_DIRS_GET 用户根映射与全链 effectiveUserHome() 同口径。
//
// 根因：证据扫描（sdk-backend）与 command-source-watcher（index.ts）的用户根已统一
// effectiveUserHome()（取 buildSpawnEnv 的 USERPROFILE/HOME，子进程实际生效口径），而
// SKILL_PROJECT_DIRS_GET 的 fm 名→目录名映射扫描仍用宿主 os.homedir()——advancedJson.env
// 覆盖 USERPROFILE/HOME 时映射扫错根（合法空 resolve），X-2 开关禁用门控不生效、无效键
// 写入、有效禁用键被误标失效可被清理。
//
// 修复语义：handler 改 effectiveUserHome() ?? os.homedir()（从 sdk-backend 导入，与 watcher
// 同源）；env 无覆盖时 effectiveUserHome 返回 process.env 同值，行为与现状一致。
//
// 运行：npx tsx scripts/tdd-skill-home-anchor-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const ipc = readFileSync(new URL('../src/main/ipc-handlers.ts', import.meta.url), 'utf8');
const sdkBackend = readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');
const index = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');

console.log('\n=== A10（D07-F2）：Skill 映射用户根锚点与引擎同源 ===');
check('SKILL_PROJECT_DIRS_GET 用户根改 effectiveUserHome() ?? os.homedir()', () => {
  const at = ipc.indexOf('ipcMain.handle(IPC_CHANNELS.SKILL_PROJECT_DIRS_GET');
  assert.ok(at > -1, '缺 handler 注册');
  const region = ipc.slice(at, at + 900);
  assert.match(region, /collectUserSkillDirNames\(path\.join\(\s*effectiveUserHome\(\) \?\? os\.homedir\(\),\s*'\.claude',\s*'skills'\s*\)\)/, '映射扫描未改用 effectiveUserHome 同源口径');
});
check('ipc-handlers 导入 effectiveUserHome（与 watcher 同源），无循环依赖', () => {
  assert.match(ipc, /import \{ effectiveUserHome \} from '\.\/modules\/sdk-backend';/, '缺 sdk-backend 导入');
  assert.ok(!sdkBackend.includes("from '../ipc-handlers'") && !sdkBackend.includes("from './ipc-handlers'"), 'sdk-backend 反向依赖 ipc-handlers（循环）');
});
check('watcher 同源注入不回退（index.ts getUserHome: effectiveUserHome）', () => {
  assert.match(index, /getUserHome:\s*effectiveUserHome/, 'watcher 锚点被破坏');
});
check('effectiveUserHome 语义钉保留（USERPROFILE || HOME，导出）', () => {
  const at = sdkBackend.indexOf('export function effectiveUserHome');
  assert.ok(at > -1, 'effectiveUserHome 导出缺失');
  const body = sdkBackend.slice(at, at + 300);
  assert.match(body, /env\.USERPROFILE \|\| env\.HOME/, '口径语义变化');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
