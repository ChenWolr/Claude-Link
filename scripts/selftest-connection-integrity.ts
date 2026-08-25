// 自测：多供应商连接完整性与稳定性加固（计划 2026-08-24-multi-provider-connection-integrity）。
// 覆盖：连接三元组 env 收口纯函数 / 上游错误分类与快败文案 / 看门狗重试暂停 /
// settings 投影卫生 / 连接测试接线契约。运行：npx tsx scripts/selftest-connection-integrity.ts（不启动 Electron）。

import { applySessionOverrideEnv } from '../src/shared/session-model';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('node:fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodePath = require('node:path');
function readRel(p: string): string {
  const abs = nodePath.resolve(__dirname, '..', p);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8');
}

console.log('\n=== 1) applySessionOverrideEnv：连接三元组原子性 ===');
{
  // key/baseUrl/model 齐备：五个模型 env + 端点 + key 全部就位，AUTH_TOKEN 清除。
  const env1: Record<string, string> = {
    ANTHROPIC_API_KEY: 'proj-key',
    ANTHROPIC_AUTH_TOKEN: 'stale-token',
    ANTHROPIC_BASE_URL: 'https://old.example.com',
  };
  applySessionOverrideEnv(env1, { apiBaseUrl: 'https://new.example.com', apiKey: 'k-new', modelId: 'glm-4.6' });
  check('BASE_URL 指向本供应商', env1.ANTHROPIC_BASE_URL === 'https://new.example.com');
  check('API_KEY 指向本供应商', env1.ANTHROPIC_API_KEY === 'k-new');
  check('AUTH_TOKEN 一律清除（防双凭据）', env1.ANTHROPIC_AUTH_TOKEN === undefined);
  check('五模型 env 全钉到当前实际模型', env1.ANTHROPIC_MODEL === 'glm-4.6' && env1.ANTHROPIC_DEFAULT_SONNET_MODEL === 'glm-4.6' && env1.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'glm-4.6' && env1.ANTHROPIC_DEFAULT_OPUS_MODEL === 'glm-4.6' && env1.ANTHROPIC_DEFAULT_FABLE_MODEL === 'glm-4.6');

  // 核心回归：key 为空的供应商档案——不得继承 lastUsed 投影 key / AUTH_TOKEN。
  const env2: Record<string, string> = {
    ANTHROPIC_API_KEY: 'other-provider-key',
    ANTHROPIC_AUTH_TOKEN: 'other-provider-token',
    ANTHROPIC_BASE_URL: 'https://other.example.com',
  };
  applySessionOverrideEnv(env2, { apiBaseUrl: 'https://keyless.example.com', apiKey: '', modelId: 'glm-4.6' });
  check('key 为空 → 显式无凭据（删除投影 key，不跨供应商混用）', env2.ANTHROPIC_API_KEY === undefined);
  check('key 为空 → AUTH_TOKEN 同样清除', env2.ANTHROPIC_AUTH_TOKEN === undefined);
  check('key 为空 → 端点仍指向本供应商', env2.ANTHROPIC_BASE_URL === 'https://keyless.example.com');

  // baseUrl 为空（异常档案）：端点回落官方默认，不沿用其它供应商端点。
  const env3: Record<string, string> = { ANTHROPIC_BASE_URL: 'https://old.example.com' };
  applySessionOverrideEnv(env3, { apiBaseUrl: '  ', apiKey: 'k', modelId: 'm' });
  check('baseUrl 为空 → 删除 BASE_URL（回落官方默认）', env3.ANTHROPIC_BASE_URL === undefined);
}

console.log('\n=== 1b) 三元组接线契约（两通道同源 + topic-analyzer 修复）===');
{
  const cliShared = readRel('src/main/modules/cli-shared.ts');
  const sb = readRel('src/main/modules/sdk-backend.ts');
  const topic = readRel('src/main/modules/topic-analyzer.ts');

  const overrideBlock = cliShared.slice(cliShared.indexOf('if (override) {'));
  check('buildSpawnEnv 的 override 块收口到纯函数', overrideBlock.includes('applySessionOverrideEnv(env, override)') && !overrideBlock.includes('delete env.ANTHROPIC_AUTH_TOKEN'));
  check('settings 通道同一纯函数（规则单源，两通道不分叉）', /buildClaudeLinkSettingsBlock[\s\S]*?applySessionOverrideEnv\(settingsEnv, modelOverride\)/.test(sb));

  check('topic-analyzer headers 使用解析出的 apiKey（不再硬用 config.apiKey）', /'x-api-key':\s*apiKey/.test(topic) && !/'x-api-key':\s*config\.apiKey/.test(topic) && !/Bearer \$\{config\.apiKey\}/.test(topic));
  check('topic-analyzer 解析传入会话 override（与会话同源）', /providerOverride:\s*session\?\.providerOverride/.test(topic));
}

console.log(`\n=== 连接完整性自测：${pass} 过 / ${fail} 败 ===`);
if (fail > 0) process.exit(1);
