// tdd-bugfix-g1-credential-projection-filter-verify.ts
// G1（P1）契约钉：凭据明文落盘——头注释与 CLAUDE.md:120 宣称「不投影端点凭据」，但
// stringEnvFrom(advanced.env) 全量拷贝 env 字符串项，存量 advancedJson 里的
// ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL 会被明文写进
// <工作目录>/.claude/settings.local.json（每个会话工作目录一份）。
//
// 修复语义：stringEnvFrom 过滤上述三键——「不投影端点凭据」的文档承诺成真；凭据唯一
// 通道仍是进程 env（buildSpawnEnv）与 SDK Options.settings（最高优先级）。
//
// 运行：npx tsx scripts/tdd-bugfix-g1-credential-projection-filter-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildClaudeSettingsProjection } from '../src/main/modules/claude-settings-projection';

const repoRoot = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(repoRoot, 'src/main/modules/claude-settings-projection.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

const baseConfig = {
  apiKey: 'sk-legacy-global',
  apiBaseUrl: 'https://legacy.example.com',
  permissionMode: 'default',
  advancedJson: JSON.stringify({
    env: {
      ANTHROPIC_API_KEY: 'sk-plaintext-in-advancedjson',
      ANTHROPIC_AUTH_TOKEN: 'tok-plaintext-in-advancedjson',
      ANTHROPIC_BASE_URL: 'https://endpoint.example.com',
      ANTHROPIC_MODEL: 'glm-4.6',
      MY_CUSTOM_FLAG: 'keep-me',
      NUMERIC_IGNORED: 123,
    },
    permissions: { allow: ['Read'] },
  }),
};

check('① 投影 env 排除 ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL 三键', () => {
  const settings = buildClaudeSettingsProjection(baseConfig as never);
  const env = settings.env as Record<string, string>;
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'API Key 不得落盘投影文件');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined, 'AUTH TOKEN 不得落盘投影文件');
  assert.equal(env.ANTHROPIC_BASE_URL, undefined, 'BASE URL 不得落盘投影文件');
});

check('② 用户自己的非凭据 env 项照常保留（过滤不误伤）', () => {
  const settings = buildClaudeSettingsProjection(baseConfig as never);
  const env = settings.env as Record<string, string>;
  assert.equal(env.ANTHROPIC_MODEL, 'glm-4.6');
  assert.equal(env.MY_CUSTOM_FLAG, 'keep-me');
  assert.equal(env.NUMERIC_IGNORED, undefined);
});

check('③ 头注释承诺与实现一致（过滤三键在 stringEnvFrom 区域）', () => {
  const at = src.indexOf('CREDENTIAL_ENV_KEYS');
  const body = src.slice(at, src.indexOf('export function buildClaudeSettingsProjection', at));
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
    assert.ok(body.includes(`'${key}'`), `stringEnvFrom 区域缺过滤键 ${key}`);
  }
});

// B1（D03-F2，2026-09-30 批次 B 扩展）：...advanced spread 为携带 hooks 有意保留全部顶层键，
// 但存量/手改 advancedJson 顶层残留的旧版凭据形态（parseClaudeSettings 历史支持的
// apiKey/apiBaseUrl/baseUrl/apiKeyHelper，导入链 2026-09-20 删除后无人剥离）不得穿透
// 明文落盘——与 G1 env 三键同理由：凭据只走 env+内联。
check('④ B1（D03-F2）：advancedJson 顶层旧版凭据键不穿透投影（spread 前剔除，hooks 不误伤）', () => {
  const config = {
    ...baseConfig,
    advancedJson: JSON.stringify({
      apiKey: 'sk-legacy-toplevel',
      apiBaseUrl: 'https://toplevel.example.com',
      baseUrl: 'https://toplevel-alt.example.com',
      apiKeyHelper: '/usr/local/bin/helper.sh',
      hooks: { PreToolUse: [] },
    }),
  };
  const settings = buildClaudeSettingsProjection(config as never);
  assert.equal(settings.apiKey, undefined, '顶层 apiKey 不得穿透落盘');
  assert.equal(settings.apiBaseUrl, undefined, '顶层 apiBaseUrl 不得穿透落盘');
  assert.equal(settings.baseUrl, undefined, '顶层 baseUrl 不得穿透落盘');
  assert.equal(settings.apiKeyHelper, undefined, '顶层 apiKeyHelper 不得穿透落盘');
  assert.ok(Array.isArray((settings.hooks as Record<string, unknown>)?.PreToolUse), '非凭据顶层键（hooks）不受剔除影响');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
