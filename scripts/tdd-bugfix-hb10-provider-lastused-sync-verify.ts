// scripts/tdd-bugfix-hb10-provider-lastused-sync-verify.ts
// hb10 P2-3（PRV-01）契约：lastUsed 变更不广播，触发器显示态与 spawn 生效态漂移。
//
// 病根：recordLastUsedProviderModel 只写主进程配置不发事件；provider-store 的 lastUsed 只在
// load()/PROVIDERS_CHANGED 更新。会话 A 钉 P1/m1（写入全局 lastUsed）→ 切到无 override 的会话 B
// → 触发器仍按旧 lastUsed 解析显示，而实际 spawn 按新 lastUsed——显示态与生效态漂移。
// 修法（主线+兜底都做）：
//   ① provider-store 增 ensureReload()（无条件重拉快照刷新 lastUsed，与 load() 共用实现）；
//   ② session-store 的 setActiveSessionProviderModel（持久化分支）与 switchSession 末尾
//     void providerStore.ensureReload()——渲染层数据自洽；
//   ③ 兜底：ipc-handlers 两处 recordLastUsedProviderModel 调用点后追加 broadcastProvidersChanged()
//     （广播幂等，渲染层 reload 每次至多一次 IPC）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-provider-lastused-sync-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const providerStore = read('src/renderer/stores/provider-store.ts');
const sessionStore = read('src/renderer/stores/session-store.ts');
const handlers = read('src/main/ipc-handlers.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① provider-store.ensureReload。
check('① provider-store：ensureReload action（无条件重拉快照刷新 lastUsed）', () => {
  assert.match(providerStore, /async ensureReload\(\)/, 'provider-store 缺 ensureReload action');
  const idx = providerStore.indexOf('async ensureReload()');
  const body = providerStore.slice(idx, providerStore.indexOf('\n    }', idx));
  assert.match(body, /this\.load\(\)/, 'ensureReload 必须复用 load()（同一实现刷新 providers+lastUsed+loaded）');
  assert.ok(!/if \(!this\.loaded/.test(body), 'ensureReload 不得带 loaded 短路（无条件重拉）');
});

// ② session-store 两个接线点。
check('② session-store：setActiveSessionProviderModel 与 switchSession 末尾接 ensureReload', () => {
  assert.match(sessionStore, /import \{ useProviderStore \} from '\.\/provider-store';/, 'session-store 缺 useProviderStore import');
  const setIdx = sessionStore.indexOf('async setActiveSessionProviderModel(');
  assert.ok(setIdx > -1, '未找到 setActiveSessionProviderModel');
  const setEnd = sessionStore.indexOf('\n    },', setIdx);
  const setBody = sessionStore.slice(setIdx, setEnd);
  assert.match(setBody, /void useProviderStore\(\)\.ensureReload\(\)/, 'setActiveSessionProviderModel 末尾缺 ensureReload（写入侧不刷新=显示态滞后）');

  const swIdx = sessionStore.indexOf('async switchSession(');
  assert.ok(swIdx > -1, '未找到 switchSession');
  const swEnd = sessionStore.indexOf('\n    },', swIdx);
  const swBody = sessionStore.slice(swIdx, swEnd);
  assert.match(swBody, /void useProviderStore\(\)\.ensureReload\(\)/, 'switchSession 末尾缺 ensureReload（读取侧不刷新=触发器显示旧 lastUsed）');
});

// ③ ipc-handlers 两处调用点广播兜底。
check('③ ipc-handlers：两处 recordLastUsedProviderModel 调用点后均 broadcastProvidersChanged', () => {
  const callSites = [...handlers.matchAll(/recordLastUsedProviderModel\((providerOverride|data\.providerOverride), (modelOverride|data\.modelOverride)\);/g)];
  assert.ok(callSites.length === 2, `recordLastUsedProviderModel 调用点应为 2 处（实际 ${callSites.length}）`);
  for (const m of callSites) {
    const after = handlers.slice(m.index! + m[0].length, m.index! + m[0].length + 200);
    assert.match(after, /broadcastProvidersChanged\(\);/, 'recordLastUsed 调用点后缺 broadcastProvidersChanged 兜底广播');
  }
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
