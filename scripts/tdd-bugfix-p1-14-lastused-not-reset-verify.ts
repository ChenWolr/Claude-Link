// tdd-bugfix-p1-14-lastused-not-reset-verify.ts
// P1-14 契约钉：编辑唯一供应商 → lastUsedModelId 被静默重置为 models[0]。
//
// 根因：saveProviderProfile 在 profiles.filter(p => p.id !== saved.id) **之后**判
// wasEmpty = profiles.length === 0 —— 编辑唯一档案也满足过滤后为空 → 强写 lastUsed 两个 id。
//
// 修复语义：空库判定用过滤前的库长度；且仅新建（!existing）才写 lastUsed（编辑永不触碰，
// 与「新建即成为最近选用；编辑保持 lastUsed 不动」的既有注释意图一致）。
//
// 运行：npx tsx scripts/tdd-bugfix-p1-14-lastused-not-reset-verify.ts

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-p114-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = tmpUserData;
// electron-store 在非 Electron 环境回落 env-paths（%APPDATA%/<name>-nodejs/），会跨运行共享
// 一个 store 文件——把 APPDATA 也指到临时目录，保证本脚本每次运行都是全新库。
process.env.APPDATA = tmpUserData;

const origLoad = Module._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (req: string, parent: NodeJS.Module | undefined, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cm = require('../src/main/modules/config-manager');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  // 场景 1：新建首个供应商 → lastUsed 自动指向新档案（保留既有行为）。
  const p1 = cm.saveProviderProfile({
    name: '唯一供应商',
    apiBaseUrl: 'https://api.example.com',
    models: [{ id: 'model-a' }, { id: 'model-b' }],
    apiKey: '',
  });
  let cfg = cm.getConfig();
  check('① 新建首个供应商自动成为 lastUsed',
    cfg.lastUsedProviderId === p1.id && cfg.lastUsedModelId === 'model-a');
  // 手动把选中模型切到 model-b（模拟用户在会话里选过 model-b）。
  cm.recordLastUsedProviderModel(p1.id, 'model-b');
  cfg = cm.getConfig();
  check('前置：lastUsedModelId=model-b', cfg.lastUsedModelId === 'model-b');

  // 场景 2：编辑唯一供应商（只改备注）→ lastUsed 双 id 必须纹丝不动（本项缺陷主场景）。
  cm.saveProviderProfile({ id: p1.id, name: '唯一供应商', note: '改备注', apiBaseUrl: 'https://api.example.com' });
  cfg = cm.getConfig();
  check('② 编辑唯一供应商后 lastUsedProviderId 不变', cfg.lastUsedProviderId === p1.id,
    `lastUsedProviderId=${cfg.lastUsedProviderId}`);
  check('③ 编辑唯一供应商后 lastUsedModelId 不被重置为 models[0]（保持 model-b）',
    cfg.lastUsedModelId === 'model-b', `lastUsedModelId=${cfg.lastUsedModelId}`);

  // 场景 3：新建第二个供应商 → 不动 lastUsed。
  const p2 = cm.saveProviderProfile({
    name: '第二供应商', apiBaseUrl: 'https://api2.example.com', models: [{ id: 'model-c' }], apiKey: '',
  });
  cfg = cm.getConfig();
  check('④ 新建第二个供应商不动 lastUsed',
    cfg.lastUsedProviderId === p1.id && cfg.lastUsedModelId === 'model-b',
    `lastUsedProviderId=${cfg.lastUsedProviderId}`);

  // 场景 4：编辑非唯一供应商 → 同样不动。
  cm.saveProviderProfile({ id: p2.id, name: '第二供应商改名', apiBaseUrl: 'https://api2.example.com' });
  cfg = cm.getConfig();
  check('⑤ 编辑非唯一供应商不动 lastUsed',
    cfg.lastUsedProviderId === p1.id && cfg.lastUsedModelId === 'model-b');

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
