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

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
