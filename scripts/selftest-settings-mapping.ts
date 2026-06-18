// 自测：高级 JSON ↔ 表单字段（apiKey / apiBaseUrl / 模型映射）双向映射的往返稳定性。
// 直接覆盖用户最关心的第 5 点："输入 baseUrl/apiKey/模型 → 自动生成对应 JSON"及其反向。
//
// 运行：npx tsx scripts/selftest-settings-mapping.ts

import {
  parseClaudeSettings,
  syncFormToAdvancedJson,
  setModelMappingInAdvancedJson,
  stripConnectionFromAdvancedJson,
  extractModelMappings,
  resolveDefaultModel,
  peekEnvValue,
} from '../src/shared/settings-parser';

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

console.log('\n=== 1) JSON → 字段：env 块里的 key/url/模型映射应被提取 ===');
{
  const json = JSON.stringify(
    {
      env: {
        ANTHROPIC_API_KEY: 'sk-test-123',
        ANTHROPIC_BASE_URL: 'https://api.example.com/v1',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.2-flash',
      },
      permissions: { defaultMode: 'acceptEdits' },
    },
    null,
    2,
  );
  const r = parseClaudeSettings(json);
  check('提取 apiKey', r.apiKey === 'sk-test-123', `got ${r.apiKey}`);
  check('提取 apiBaseUrl', r.apiBaseUrl === 'https://api.example.com/v1', `got ${r.apiBaseUrl}`);
  check('advancedJson 仍保留 env（peek 式不删除）', peekEnvValue(r.advancedJson, 'ANTHROPIC_API_KEY') === 'sk-test-123');
  const maps = extractModelMappings(r.advancedJson);
  check('sonnet→glm-5.2 映射保留', maps.sonnet === 'glm-5.2', JSON.stringify(maps));
  check('haiku 映射保留', maps.haiku === 'glm-5.2-flash', JSON.stringify(maps));
}

console.log('\n=== 2) 字段 → JSON：从空开始，输入 key/url/权限应生成 env ===');
{
  const adv = syncFormToAdvancedJson('{}', {
    apiKey: 'sk-test-123',
    apiBaseUrl: 'https://api.example.com/v1',
    permissionMode: 'plan',
  });
  const env = JSON.parse(adv);
  check('env.ANTHROPIC_API_KEY 已生成', env.env?.ANTHROPIC_API_KEY === 'sk-test-123', adv);
  check('env.ANTHROPIC_BASE_URL 已生成', env.env?.ANTHROPIC_BASE_URL === 'https://api.example.com/v1', adv);
  check('permissions.defaultMode=plan', env.permissions?.defaultMode === 'plan', adv);
  // 官方端点不应写入 BASE_URL
  const adv2 = syncFormToAdvancedJson('{}', {
    apiKey: 'k',
    apiBaseUrl: 'https://api.anthropic.com',
    permissionMode: 'default',
  });
  const env2 = JSON.parse(adv2);
  check('官方端点不写入 ANTHROPIC_BASE_URL', env2.env?.ANTHROPIC_BASE_URL === undefined, adv2);
}

console.log('\n=== 3) 模型映射 → JSON：输入模型名应生成对应 env 键（用户最关心）===');
{
  let adv = '{}';
  adv = setModelMappingInAdvancedJson(adv, 'sonnet', 'glm-5.2');
  adv = setModelMappingInAdvancedJson(adv, 'opus', 'glm-5.2-max');
  const parsed = JSON.parse(adv);
  check('sonnet 映射写入 env', parsed.env?.ANTHROPIC_DEFAULT_SONNET_MODEL === 'glm-5.2', adv);
  check('opus 映射写入 env', parsed.env?.ANTHROPIC_DEFAULT_OPUS_MODEL === 'glm-5.2-max', adv);
  // 清空映射应删除键
  adv = setModelMappingInAdvancedJson(adv, 'opus', '');
  const parsed2 = JSON.parse(adv);
  check('清空 opus 映射后键被删除', parsed2.env?.ANTHROPIC_DEFAULT_OPUS_MODEL === undefined, adv);
}

console.log('\n=== 4) 往返稳定性：字段→JSON→字段→JSON 第二次应不变（idempotent）===');
{
  const form = { apiKey: 'sk-rt-1', apiBaseUrl: 'https://api.rt.com/v1', permissionMode: 'default' };
  let adv1 = syncFormToAdvancedJson('{}', form);
  adv1 = setModelMappingInAdvancedJson(adv1, 'sonnet', 'glm-5.2');
  const adv2 = syncFormToAdvancedJson(adv1, form);
  check('二次 sync 稳定不变', adv1 === adv2);
  const adv3 = setModelMappingInAdvancedJson(adv2, 'sonnet', 'glm-5.2');
  check('二次 setModelMapping 稳定不变', adv2 === adv3);
}

console.log('\n=== 5) 端到端：JSON→字段→JSON 回写后，关键字段一致 ===');
{
  const src = JSON.stringify(
    {
      env: {
        ANTHROPIC_API_KEY: 'sk-e2e',
        ANTHROPIC_BASE_URL: 'https://e2e.com/v1',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
      },
    },
    null,
    2,
  );
  const parsed = parseClaudeSettings(src);
  const regen = syncFormToAdvancedJson(parsed.advancedJson, {
    apiKey: parsed.apiKey ?? '',
    apiBaseUrl: parsed.apiBaseUrl ?? '',
    permissionMode: 'default',
  });
  const regenMaps = extractModelMappings(regen);
  check('回写后 sonnet 映射仍在', regenMaps.sonnet === 'glm-5.2', JSON.stringify(regenMaps));
  check('回写后 apiKey 仍在 env', peekEnvValue(regen, 'ANTHROPIC_API_KEY') === 'sk-e2e');
  check('默认模型解析为 sonnet（首个映射）', resolveDefaultModel(regen) === 'sonnet', resolveDefaultModel(regen));
}

// 模拟 process-manager.buildSpawnEnv 的 env 提取（顶层字符串 + env 块字符串），不依赖 electron。
function simulateSpawnEnv(advancedJson: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const adv = JSON.parse(advancedJson || '{}');
    if (adv && typeof adv === 'object' && !Array.isArray(adv)) {
      for (const [k, v] of Object.entries(adv)) if (typeof v === 'string') env[k] = v;
      if (adv.env && typeof adv.env === 'object' && !Array.isArray(adv.env)) {
        for (const [k, v] of Object.entries(adv.env)) if (typeof v === 'string') env[k] = v;
      }
    }
  } catch {
    // ignore
  }
  return env;
}

console.log('\n=== 6) 改映射后 CLI 真用新值（用户最担心：5.2 改 5.1 后别还是 5.2）===');
{
  let adv = setModelMappingInAdvancedJson('{}', 'sonnet', 'glm-5.2');
  // 用户把 sonnet 映射从 glm-5.2 改成 glm-5.1
  adv = setModelMappingInAdvancedJson(adv, 'sonnet', 'glm-5.1');
  const env = simulateSpawnEnv(adv);
  check('改映射后 env 用新值 glm-5.1', env.ANTHROPIC_DEFAULT_SONNET_MODEL === 'glm-5.1', String(env.ANTHROPIC_DEFAULT_SONNET_MODEL));
  check('env 不残留旧值 glm-5.2', env.ANTHROPIC_DEFAULT_SONNET_MODEL !== 'glm-5.2');
  check('advancedJson 内只剩 5.1 一条 sonnet 键（无重复）', (adv.match(/glm-5\.[12]/g) || []).length === 1, adv);
}

console.log('\n=== 7) 清空连接字段后，JSON 对应 env 键也被删除（点 2）===');
{
  let adv = syncFormToAdvancedJson('{}', { apiKey: 'sk-x', apiBaseUrl: 'https://x.com/v1', permissionMode: 'default' });
  // 用户清空 apiKey 与 baseUrl
  adv = syncFormToAdvancedJson(adv, { apiKey: '', apiBaseUrl: '', permissionMode: 'default' });
  const env = JSON.parse(adv);
  check('清空 apiKey 后 env 键被删除', env.env?.ANTHROPIC_API_KEY === undefined, adv);
  check('清空 baseUrl 后 env 键被删除', env.env?.ANTHROPIC_BASE_URL === undefined, adv);
  // 清空后 env 为空应整体移除
  check('env 清空后对象被移除', env.env === undefined, adv);
}

console.log('\n=== 8) 一键清空连接：env 里 key/url/模型映射全删，其它 env 保留（点 2）===');
{
  const adv = JSON.stringify(
    {
      env: {
        ANTHROPIC_API_KEY: 'sk-x',
        ANTHROPIC_BASE_URL: 'https://x.com/v1',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
        CLAUDE_CODE_SUBAGENT_MODEL: 'should-keep', // 非连接相关，应保留
      },
      permissions: { defaultMode: 'default' },
    },
    null,
    2,
  );
  const cleared = stripConnectionFromAdvancedJson(adv);
  const env = JSON.parse(cleared).env || {};
  check('清空后 ANTHROPIC_API_KEY 删除', env.ANTHROPIC_API_KEY === undefined, cleared);
  check('清空后 ANTHROPIC_BASE_URL 删除', env.ANTHROPIC_BASE_URL === undefined, cleared);
  check('清空后 sonnet 模型映射删除', env.ANTHROPIC_DEFAULT_SONNET_MODEL === undefined, cleared);
  check('保留非连接相关 env', env.CLAUDE_CODE_SUBAGENT_MODEL === 'should-keep', cleared);
  check('permissions 不受影响', JSON.parse(cleared).permissions?.defaultMode === 'default', cleared);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
