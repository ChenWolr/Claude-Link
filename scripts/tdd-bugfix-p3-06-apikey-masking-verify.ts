// tdd-bugfix-p3-06-apikey-masking-verify.ts
// P3-6 契约钉：CONFIG_GET 向 renderer 下发明文 apiKey。
//
// 修复语义：① 新增 getConfigForRenderer（apiKey 掩码），CONFIG_GET / CONFIG_SAVE 出口改用；
// 主进程内部消费（buildSpawnEnv/settings-writer/connection-tester）继续走 getConfig() 明文不变；
// ② saveConfig 对 apiKey 增加「空或掩码形态=不改动」语义，仅非掩码明文才重新加密——防掩码回写污染。
//
// 运行：npx tsx scripts/tdd-bugfix-p3-06-apikey-masking-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const Module = require('module');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-p306-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = tmpUserData;
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
  // ① 写入真实 key → renderer 视图掩码、内部视图明文。
  cm.saveConfig({ apiKey: 'sk-ant-real-secret-9527' });
  const forRenderer = cm.getConfigForRenderer();
  check('① renderer 视图 apiKey 为掩码（sk-…****9527）', forRenderer.apiKey === 'sk-…****9527', forRenderer.apiKey);
  check('② 内部 getConfig 仍明文（buildSpawnEnv 等消费不变）', cm.getConfig().apiKey === 'sk-ant-real-secret-9527');

  // ② 掩码回写不污染：renderer 带掩码整份保存 → 内部明文保持。
  cm.saveConfig({ ...forRenderer, workingDirectory: 'D:/tmp' });
  check('③ 掩码回写后内部明文不变（防污染）', cm.getConfig().apiKey === 'sk-ant-real-secret-9527');
  check('④ 掩码回写不影响其他字段保存', cm.getConfig().workingDirectory === 'D:/tmp');
  check('⑤ 加密存储仍是真实 key 的密文（getDecryptedApiKey 可解出）', cm.getDecryptedApiKey() === 'sk-ant-real-secret-9527');

  // ③ 空 apiKey = 不改动（保留旧加密值）。
  cm.saveConfig({ apiKey: '' });
  check('⑥ 空串 apiKey=不改动（明文保持）', cm.getDecryptedApiKey() === 'sk-ant-real-secret-9527');

  // ④ 非掩码新明文 = 正常改密。
  cm.saveConfig({ apiKey: 'sk-new-key-0001' });
  check('⑦ 新明文正常改密', cm.getDecryptedApiKey() === 'sk-new-key-0001');

  // ⑤ 结构：IPC 出口接线。
  const handlers = fs.readFileSync(path.join(repoRoot, 'src/main/ipc-handlers.ts'), 'utf8');
  check('⑧ CONFIG_GET/SAVE 出口用 getConfigForRenderer', () => {
    assert.match(handlers, /CONFIG_GET, async \(\) => getConfigForRenderer\(\)/);
    assert.match(handlers, /return getConfigForRenderer\(\);/);
  });

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
