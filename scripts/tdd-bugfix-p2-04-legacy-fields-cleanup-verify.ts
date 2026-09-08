// tdd-bugfix-p2-04-legacy-fields-cleanup-verify.ts
// P2-4 契约钉：删光供应商后 legacy 投影残留已删档案凭据，会话继续静默使用。
//
// 修复语义：projectLegacyFields 的 profile 为空分支补清四个连接字段（providerNote/apiBaseUrl/
// encryptedApiKey/apiKeyEncoding），名称/端点/模型回落 defaultConfig 默认——「老字段 =
// lastUsed 档案投影」不变量在库空时成立为「无凭据」（与首次安装行为一致）。
//
// R2（复查 2026-09-08 增补）：补清收窄到「库从非空变空」——deleteProviderProfile 删光分支置位
// libraryEmptiedByDeletion 旗标后才允许触发；库**从未非空**的老字段直配用户（库一直为空 + 无
// 全局 Key + 自定义端点/模型）的 saveConfig 不再被重置到官方默认（R2-前置①②，置于脚本最前，
// 先于任何 saveProviderProfile 执行）。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-04-legacy-fields-cleanup-verify.ts

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-p204-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = tmpUserData;
process.env.APPDATA = tmpUserData; // electron-store env-paths 回落隔离

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
  // ── R2（复查 2026-09-08）：库**从未非空**（老字段直配用户）+ 无全局 Key：saveConfig 不得重置 ──
  // 补清分支只许在「库从非空变空」的删除链上触发；此处先于任何 saveProviderProfile 执行，
  // 库尚为空（providerProfiles 键不存在），模拟只用老字段的存量用户改设置页触发 saveConfig。
  cm.saveConfig({ apiBaseUrl: 'https://legacy-mine.example.com', defaultModel: 'my-legacy-model' });
  let cfgR2 = cm.getConfig();
  check('R2-前置① 库一直为空+无全局 Key：saveConfig 自定义 apiBaseUrl 不被重置（非删除触发）',
    cfgR2.apiBaseUrl === 'https://legacy-mine.example.com', cfgR2.apiBaseUrl);
  check('R2-前置② defaultModel 不被重置',
    cfgR2.defaultModel === 'my-legacy-model', cfgR2.defaultModel);

  // 建唯一供应商（带自定义 Base URL）→ 老字段投影为该档案。
  const p1 = cm.saveProviderProfile({
    name: '将被删光的供应商',
    apiBaseUrl: 'https://ghost.example.com',
    models: [{ id: 'ghost-model' }],
    apiKey: '',
  });
  cm.recordLastUsedProviderModel(p1.id, 'ghost-model');
  let cfg = cm.getConfig();
  check('前置：删除前老字段投影为该档案（Base URL=ghost）', cfg.apiBaseUrl === 'https://ghost.example.com');

  // 删光。
  cm.deleteProviderProfile(p1.id);
  cfg = cm.getConfig();
  check('① 库空后 apiBaseUrl 回落官方端点（不残留已删档案）', cfg.apiBaseUrl === 'https://api.anthropic.com',
    cfg.apiBaseUrl);
  check('② 库空后加密 Key 清空', cfg.apiKey === '',
    cfg.apiKey);
  check('③ 库空后 lastUsed 双 id 清空', cfg.lastUsedProviderId === null && cfg.lastUsedModelId === null);
  check('④ 库空后 providerName/defaultModel 回落默认', cfg.providerName === 'Anthropic' && cfg.defaultModel === 'claude-sonnet-4-6',
    `${cfg.providerName}/${cfg.defaultModel}`);
  check('⑤ 库为空', cm.getLibrarySnapshot().providers.length === 0);

  // ── P2-4 补口（审计：陈旧快照复活链）——断言在 saveConfig 写入后验证（P3-6 顺序先例）──
  // 渲染层整份 saveConfig（自动保存）可能带回删库前的陈旧 apiBaseUrl/defaultModel；
  // projectLegacyFields 库空分支此前只重置 lastUsed 两 id，复活链完整。
  cm.saveConfig({ apiBaseUrl: 'https://ghost.example.com', defaultModel: 'ghost-model' });
  cfg = cm.getConfig();
  check('⑥ 库空+无全局 Key：saveConfig 带回陈旧 apiBaseUrl/defaultModel 不复活（回落官方默认）',
    cfg.apiBaseUrl === 'https://api.anthropic.com' && cfg.defaultModel === 'claude-sonnet-4-6',
    `${cfg.apiBaseUrl}/${cfg.defaultModel}`);

  // 保护路径（P3-6 先例）：库空+全局 apiKey 的老式用户——saveConfig 刚写入真实 Key/端点，
  // 投影清空分支不得动它们（否则每次 saveConfig 都抹掉用户真实配置）。
  cm.saveConfig({ apiKey: 'sk-real-global-key', apiBaseUrl: 'https://mine.example.com', defaultModel: 'my-model' });
  cfg = cm.getConfig();
  check('⑦ 库空+全局 apiKey 保护路径：老字段不被投影清空', () => {
    if (cfg.apiBaseUrl !== 'https://mine.example.com') throw new Error(`apiBaseUrl=${cfg.apiBaseUrl}`);
    if (cfg.defaultModel !== 'my-model') throw new Error(`defaultModel=${cfg.defaultModel}`);
    if (cfg.apiKey !== 'sk-real-global-key') throw new Error(`apiKey=${cfg.apiKey}`);
  });

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
