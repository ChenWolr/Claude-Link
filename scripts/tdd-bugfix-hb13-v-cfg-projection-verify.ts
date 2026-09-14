// scripts/tdd-bugfix-hb13-v-cfg-projection-verify.ts
// hb13-v B3【配置】契约：投影失败可见性端到端接线（config-settings F-04）。
//
// 病根：saveConfig 返回值带 projectionOk，但 CONFIG_SAVE 回传 getConfigForRenderer()（不含
// 该字段）→ config-store.config.projectionOk 恒 undefined → ConfigPage「已保存（投影失败）」
// 徽标条件恒 false——hb10-CFG-04 端到端死代码。
// 修法：CONFIG_SAVE 回传 {...getConfigForRenderer(), projectionOk: saved.projectionOk}。
//
// 运行：npx tsx scripts/tdd-bugfix-hb13-v-cfg-projection-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const handlers = read('src/main/ipc-handlers.ts');
const configTypes = read('src/shared/types/config.ts');
const configStore = read('src/renderer/stores/config-store.ts');
const configPage = read('src/renderer/pages/ConfigPage.vue');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① CONFIG_SAVE 回传带 projectionOk（IPC 传递链闭合）。
check('① CONFIG_SAVE 回传 {...getConfigForRenderer(), projectionOk: saved.projectionOk}', () => {
  const idx = handlers.indexOf('IPC_CHANNELS.CONFIG_SAVE');
  assert.ok(idx > -1, '未找到 CONFIG_SAVE handler');
  const body = handlers.slice(idx, handlers.indexOf('\n  });', idx));
  assert.match(body, /\{\s*\.\.\.getConfigForRenderer\(\),\s*projectionOk: saved\.projectionOk\s*\}/, 'CONFIG_SAVE 回传未携带 projectionOk（F-04 传递链断裂形态）');
});

// ② 渲染层消费链：store 赋值 + 页面绑定 + 类型字段（既有半边保持）。
check('② 渲染层消费链：config-store 赋值 + ConfigPage 徽标绑定 + 类型字段', () => {
  assert.match(configStore, /this\.config = await window\.claudeLink\.saveConfig\(plainConfig\);/, 'config-store 未以回传值整体替换 config');
  assert.match(configPage, /store\.config\.projectionOk === false \? 'projection-failed' : 'saved'/, 'ConfigPage 徽标绑定缺失');
  assert.match(configTypes, /projectionOk\?: boolean;/, 'AppConfig 缺 projectionOk 字段');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
