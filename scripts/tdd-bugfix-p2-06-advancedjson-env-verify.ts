// tdd-bugfix-p2-06-advancedjson-env-verify.ts
// P2-6 契约钉：buildSpawnEnv 把 advancedJson 顶层字符串键当 env 注入（与投影通道语义分叉，
// 可覆盖 HOME/PATH 级变量）。
//
// 修复语义：删除顶层字符串键展开循环；env 只来自 advancedJson.env 块 + 会话三元组收口
//（applySessionOverrideEnv 不变）。settings 顶层字段投影通道（settings-parser spread）不变。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-06-advancedjson-env-verify.ts

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-p206-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = tmpUserData;
process.env.APPDATA = tmpUserData;

const origLoad = Module._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (req: string, parent: NodeJS.Module | undefined, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { saveConfig, getConfig } = require('../src/main/modules/config-manager');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildSpawnEnv } = require('../src/main/modules/cli-shared');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  saveConfig({
    cliPath: process.execPath,
    advancedJson: JSON.stringify({
      // 顶层危险键（旧实现会当 env 注入）：
      HOME: '/evil/home',
      PATH: '/evil/path',
      ANTHROPIC_BASE_URL: 'https://evil.example.com',
      // 正确通道：env 块。
      env: { MY_TEST_VAR: 'from-env-block' },
      // 非字符串顶层键（投影通道语义，不属 env）：
      permissions: { allow: ['Bash'] },
    }),
  });
  const before = { home: process.env.HOME, path: process.env.PATH };
  const env = buildSpawnEnv(null);

  check('① 顶层字符串键 HOME 不再注入 env', env.HOME === before.home, `env.HOME=${env.HOME}`);
  check('② 顶层字符串键 PATH 不再注入 env', env.PATH === before.path, `env.PATH=${String(env.PATH).slice(0, 60)}`);
  check('③ 顶层 ANTHROPIC_BASE_URL 不再当 env 覆盖端点',
    env.ANTHROPIC_BASE_URL !== 'https://evil.example.com', `env.ANTHROPIC_BASE_URL=${env.ANTHROPIC_BASE_URL}`);
  check('④ env 块内变量照常注入', env.MY_TEST_VAR === 'from-env-block', `MY_TEST_VAR=${env.MY_TEST_VAR}`);
  check('⑤ 非字符串顶层键（permissions 对象）不影响 env', !('permissions' in (env as Record<string, unknown>)));

  // 结构：顶层展开循环已删除（env 只来自 advanced.env 块）。
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/modules/cli-shared.ts'), 'utf8');
  const fnStart = src.indexOf('export function buildSpawnEnv');
  const fnBody = src.slice(fnStart, src.indexOf('\nexport ', fnStart + 10));
  check('⑥ buildSpawnEnv 无「顶层 Object.entries 直接 env[key]=value」循环',
    !/for \(const \[key, value\] of Object\.entries\(advanced\)\)/.test(fnBody));
  check('⑦ env 块展开保留', fnBody.includes('Object.entries(envBlock'));

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
