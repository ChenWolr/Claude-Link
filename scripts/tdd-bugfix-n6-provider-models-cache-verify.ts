// tdd-bugfix-n6-provider-models-cache-verify.ts
// N6（P2）契约钉：模型查询缓存不随供应商编辑失效——clearProviderModelsCache 全仓零调用方，
// 缓存键仅 profile.id（TTL 1h）；改 Base URL 后「查询模型」1 小时仍返回旧端点列表，
// 与行内测试（不走缓存）自相矛盾。
//
// 修复语义：config-manager 的 saveProviderProfile / deleteProviderProfile 末尾调
// clearProviderModelsCache(profile.id)（import 自 model-resolver）。
//
// 行为验证手法：Module._load 拦截 model-resolver 注入 spy，驱动真实 saveProviderProfile /
// deleteProviderProfile（electron-store 沙盒），断言两入口都以对应 profile.id 失效缓存。
//
// 运行：npx tsx scripts/tdd-bugfix-n6-provider-models-cache-verify.ts

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const configManagerSrc = fs.readFileSync(path.join(repoRoot, 'src/main/modules/config-manager.ts'), 'utf8');

let spass = 0;
let sfail = 0;
function scheck(name: string, cond: boolean, detail = ''): void {
  if (cond) { spass += 1; console.log(`  ✅ ${name}`); }
  else { sfail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

scheck('结构① config-manager 导入 clearProviderModelsCache（自 model-resolver）',
  /import\s*\{[^}]*clearProviderModelsCache[^}]*\}\s*from\s*'\.\/model-resolver'/.test(configManagerSrc));
scheck('结构② saveProviderProfile 末尾失效缓存', (() => {
  const at = configManagerSrc.indexOf('export function saveProviderProfile');
  const seg = configManagerSrc.slice(at, configManagerSrc.indexOf('export function deleteProviderProfile', at));
  return seg.includes('clearProviderModelsCache(saved.id)');
})());
scheck('结构③ deleteProviderProfile 末尾失效缓存', (() => {
  const at = configManagerSrc.indexOf('export function deleteProviderProfile');
  const seg = configManagerSrc.slice(at, configManagerSrc.indexOf('export function restoreDeletedProvider', at));
  return seg.includes('clearProviderModelsCache(id)');
})());

// ── 行为 seam ──
const Module = require('module');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-n6cache-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = tmpUserData;

const cacheCalls: Array<string | undefined> = [];
const origLoad = Module._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (req: string, parent: NodeJS.Module | undefined, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  if (/[\\/]model-resolver$/.test(req)) {
    return { clearProviderModelsCache: (id?: string) => { cacheCalls.push(id); } };
  }
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cm = require('../src/main/modules/config-manager');

  const saved = cm.saveProviderProfile({
    name: 'N6 供应商',
    apiBaseUrl: 'https://old.example.com',
    apiKey: 'sk-n6-test',
    models: [{ id: 'm-1', name: 'm-1', source: 'manual' }],
  });
  check('行为① saveProviderProfile 以 profile.id 失效缓存',
    cacheCalls.includes(saved.id), `calls=${JSON.stringify(cacheCalls)}`);

  const saved2 = cm.saveProviderProfile({
    id: saved.id,
    name: 'N6 供应商',
    apiBaseUrl: 'https://new.example.com',
    models: [{ id: 'm-2', name: 'm-2', source: 'manual' }],
  });
  const beforeDelete = cacheCalls.length;
  cm.deleteProviderProfile(saved2.id);
  check('行为② deleteProviderProfile 以 profile.id 失效缓存',
    cacheCalls.length === beforeDelete + 1 && cacheCalls[cacheCalls.length - 1] === saved2.id,
    `calls=${JSON.stringify(cacheCalls)}`);

  console.log(`\nverify 结果：结构 ${spass} passed/${sfail} failed，行为 ${pass} passed/${fail} failed`);
  process.exit(sfail + fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
