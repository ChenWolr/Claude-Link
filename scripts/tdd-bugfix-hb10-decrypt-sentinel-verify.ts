// scripts/tdd-bugfix-hb10-decrypt-sentinel-verify.ts
// hb10 P2-4（CFG-01+CFG-V04+PRV-V03）契约：safeStorage 解密失败静默变「未配置」。
//
// 病根：decryptApiKey/decryptProviderApiKey catch 返回 ''——解密失败（系统凭据库换机/重装）
// 与未配置不可区分：面板显示「未设置」误导用户重输；ensureProviderMigration 迁移时把坏 blob
// 当空处理抹掉物证。修法（哨兵）：解密失败返回导出常量 DECRYPT_FAILED——
//   · spawn 注入消费点（buildSpawnEnv / getProviderModelSources）显式判哨兵按空处理（行为不变）；
//   · 面板路径（toProviderView / getConfigForRenderer）判哨兵：hasApiKey 仍 true + apiKeyBroken: true，
//     前端列表行显示「密钥损坏，请重新输入」徽标；
//   · 迁移：legacyApiKey 为哨兵时保留原 blob 原样迁移（不 encrypt），保留物证。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-decrypt-sentinel-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const cm = read('src/main/modules/config-manager.ts');
const cliShared = read('src/main/modules/cli-shared.ts');
const configTypes = read('src/shared/types/config.ts');
const managerVue = read('src/renderer/components/providers/ProviderManager.vue');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① 哨兵常量导出 + 两个 decrypt catch 分支返回哨兵。
check('① DECRYPT_FAILED 哨兵导出；decryptApiKey/decryptProviderApiKey catch 返回哨兵（不再静默变空）', () => {
  assert.match(cm, /export const DECRYPT_FAILED = '__claude_link_decrypt_failed__';/, '缺 DECRYPT_FAILED 哨兵常量导出');
  const d1 = cm.slice(cm.indexOf('function decryptApiKey'), cm.indexOf('// 档案密钥解密'));
  assert.match(d1, /return DECRYPT_FAILED;/, 'decryptApiKey catch 未返回哨兵');
  assert.doesNotMatch(d1, /catch \(error\) \{\s*[\s\S]*?return '';/, "decryptApiKey catch 仍返回 ''（静默变未配置）");
  const d2 = cm.slice(cm.indexOf('export function decryptProviderApiKey'), cm.indexOf('export function getConfig'));
  assert.match(d2, /return DECRYPT_FAILED;/, 'decryptProviderApiKey catch 未返回哨兵');
});

// ② spawn 注入消费点按空处理。
check('② buildSpawnEnv / getProviderModelSources：显式判哨兵按空处理（注入行为不变）', () => {
  const envFn = cliShared.slice(cliShared.indexOf('export function buildSpawnEnv'), cliShared.indexOf('export function buildSpawnEnv') + 1600);
  assert.match(envFn, /!== DECRYPT_FAILED/, 'buildSpawnEnv 未判哨兵（会把哨兵串注入 ANTHROPIC_API_KEY）');
  assert.match(cliShared, /DECRYPT_FAILED/, 'cli-shared 缺哨兵 import');
  const srcFn = cm.slice(cm.indexOf('export function getProviderModelSources'), cm.indexOf('export function getStoredProviderProfile'));
  assert.match(srcFn, /=== DECRYPT_FAILED \? '' : /, 'getProviderModelSources 未把哨兵按空处理');
});

// ③ 面板路径：损坏态可见。
check('③ toProviderView/getConfigForRenderer：损坏态 hasApiKey 仍 true + apiKeyBroken + 掩码不伪造', () => {
  const view = cm.slice(cm.indexOf('function toProviderView'), cm.indexOf('export function getLibrarySnapshot'));
  assert.match(view, /=== DECRYPT_FAILED/, 'toProviderView 未判哨兵');
  assert.match(view, /apiKeyBroken/, 'toProviderView 缺 apiKeyBroken 输出');
  assert.match(configTypes, /apiKeyBroken\?: boolean;/, 'ProviderProfileView 缺可选 apiKeyBroken 字段');
  assert.match(configTypes, /apiKeyBroken\?: boolean;/, 'AppConfig 缺可选 apiKeyBroken 字段') ;
  const gfr = cm.slice(cm.indexOf('export function getConfigForRenderer'), cm.indexOf('export function getConfigForRenderer') + 800);
  assert.match(gfr, /apiKeyBroken/, 'getConfigForRenderer 未透出 apiKeyBroken（全局 Key 损坏不可见）');
});

// ④ 迁移保留坏 blob 物证。
check('④ ensureProviderMigration：legacyApiKey 为哨兵时保留原 blob 原样迁移（不 encrypt）', () => {
  const mig = cm.slice(cm.indexOf('function ensureProviderMigration'), cm.indexOf('function ensureProviderMigration') + 2200);
  const sentIdx = mig.indexOf('DECRYPT_FAILED');
  assert.ok(sentIdx > -1, '迁移未判哨兵（坏 blob 被抹）');
  const keepIdx = mig.indexOf('encryptedApiKey: current.encryptedApiKey');
  assert.ok(keepIdx > sentIdx, '哨兵命中未保留原 blob（encryptedApiKey: current.encryptedApiKey）');
});

// ⑤ 前端损坏徽标。
check('⑤ ProviderManager 列表行：apiKeyBroken 显示「密钥损坏，请重新输入」徽标', () => {
  assert.match(managerVue, /p\.apiKeyBroken/, '列表行缺 apiKeyBroken 判定');
  assert.match(managerVue, /密钥损坏，请重新输入/, '缺损坏徽标文案');
});

// ⑥ hb13-v B2（config-settings F-03）：三处漏防消费点判哨兵——行内连接测试 fail-fast、
// 模型查询不发哨兵串头部、标题分析老字段链排除哨兵。
check('⑥ B2：runProviderModelTest / PROVIDER_QUERY_MODELS / topic-analyzer 三消费点判哨兵', () => {
  const tester = read('src/main/modules/connection-tester.ts');
  const handlers = read('src/main/ipc-handlers.ts');
  const analyzer = read('src/main/modules/topic-analyzer.ts');
  const tIdx = tester.indexOf('export async function runProviderModelTest');
  const tBody = tester.slice(tIdx, tester.indexOf('\n}', tIdx));
  assert.match(tBody, /apiKey === DECRYPT_FAILED/, 'runProviderModelTest 未判哨兵（损坏态带哨兵串真实 spawn 上游）');
  assert.match(tBody, /密钥损坏，请重新输入/, '行内测试缺「密钥损坏，请重新输入」fail-fast 文案');
  const qIdx = handlers.indexOf('IPC_CHANNELS.PROVIDER_QUERY_MODELS');
  assert.ok(qIdx > -1, '未找到 PROVIDER_QUERY_MODELS handler');
  const qBody = handlers.slice(qIdx, qIdx + 700);
  assert.match(qBody, /apiKey === DECRYPT_FAILED/, '模型查询路径未判哨兵（哨兵串进 x-api-key/Bearer 头）');
  const aIdx = analyzer.indexOf('const apiKey = resolved.provider');
  assert.ok(aIdx > -1, '未找到 topic-analyzer 凭据解析');
  const aBody = analyzer.slice(aIdx, aIdx + 400);
  assert.match(aBody, /DECRYPT_FAILED/, 'topic-analyzer 老字段链未排除哨兵（空耗 2 次 HTTP）');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
