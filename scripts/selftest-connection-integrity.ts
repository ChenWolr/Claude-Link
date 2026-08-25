// 自测：多供应商连接完整性与稳定性加固（计划 2026-08-24-multi-provider-connection-integrity）。
// 覆盖：连接三元组 env 收口纯函数 / 上游错误分类与快败文案 / 看门狗重试暂停 /
// settings 投影卫生 / 连接测试接线契约。运行：npx tsx scripts/selftest-connection-integrity.ts（不启动 Electron）。

import { applySessionOverrideEnv } from '../src/shared/session-model';
import { shouldPauseStallWatchdog, RETRY_PAUSE_GRACE_MS } from '../src/shared/stall-watchdog';
import {
  classifyUpstreamError,
  isNonRetryableUpstreamError,
  upstreamFatalMessage,
  type UpstreamErrorClassification,
} from '../src/shared/upstream-errors';

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

console.log('\n=== 2) 上游错误分类器 ===');
{
  check(
    '短错误码 model_not_found → kind 命中',
    classifyUpstreamError('model_not_found').kind === 'model_not_found',
  );
  check(
    'authentication_failed → authentication',
    classifyUpstreamError('authentication_failed').kind === 'authentication',
  );
  // 用户实测的原样 JSON（连接测试 stderr / SDK 异常 message 形态）。
  const rawJson = '{"error":{"message":"Model \\"glm-5.2\\" is not supported by any configured account in this group","type":"model_not_found"}}';
  const c = classifyUpstreamError(rawJson);
  check('原始 JSON：type 提取 model_not_found', c.kind === 'model_not_found', JSON.stringify(c));
  check('原始 JSON：modelId 提取 glm-5.2', c.modelId === 'glm-5.2', String(c.modelId));
  check('原始 JSON：detail 含上游 message', c.detail.includes('not supported by any configured account'), c.detail);
  check('model_not_found 是非重试错误', isNonRetryableUpstreamError('model_not_found'));
  check('rate_limit 可重试', !isNonRetryableUpstreamError('rate_limit'));
  check('overloaded 可重试', !isNonRetryableUpstreamError('overloaded'));
  check('404 状态码兜底 → model_not_found', classifyUpstreamError('Not Found', 404).kind === 'model_not_found');
  check('401 状态码兜底 → authentication', classifyUpstreamError('Unauthorized', 401).kind === 'authentication');
  check('网络文本 → network', classifyUpstreamError('fetch failed: ETIMEDOUT').kind === 'network');
  check('空输入 → network', classifyUpstreamError(null).kind === 'network');

  const msg = upstreamFatalMessage({ kind: 'model_not_found', detail: 'not supported', modelId: 'glm-5.2' }, '智谱 GLM', 'glm-5.2');
  check('快败文案含供应商/模型/行动建议', msg.includes('智谱 GLM') && msg.includes('glm-5.2') && msg.includes('更换模型'));
}

console.log('\n=== 3) 确定性上游错误快败接线 ===');
{
  const sb = readRel('src/main/modules/sdk-backend.ts');
  check('KillReason 含 upstream_fatal', /'user'\s*\|\s*'api_retry_exhausted'\s*\|\s*'watchdog'\s*\|\s*'upstream_fatal'/.test(sb) || sb.includes("'upstream_fatal'"));
  check('api_retry 分支接分类器', /infoSubtype === 'api_retry'[\s\S]{0,4000}?classifyUpstreamError\(/.test(sb));
  check('快败收口函数存在且落库 upstream_fatal 消息', sb.includes('function abortNonRetryableUpstream') && sb.includes("processKind: 'system:upstream_fatal'"));
  check('快败调用 killProcess(upstream_fatal)', /killProcess\(sessionId,\s*'upstream_fatal'/.test(sb));
  check('entry 记录供应商名（诊断用）', sb.includes('entry.providerName = override?.providerName ?? null'));
}

console.log('\n=== 4) 看门狗重试暂停 ===');
{
  const now = 1_000_000;
  check('无状态 → 不暂停', shouldPauseStallWatchdog(undefined, now) === false);
  check('idle → 不暂停', shouldPauseStallWatchdog({ phase: 'idle', nextRetryAt: null, lastRetryAt: null }, now) === false);
  check('terminal → 不暂停', shouldPauseStallWatchdog({ phase: 'terminal', nextRetryAt: now + 999_999, lastRetryAt: now }, now) === false);
  check('retrying 且排期在未来 → 暂停', shouldPauseStallWatchdog({ phase: 'retrying', nextRetryAt: now + 5_000, lastRetryAt: now }, now) === true);
  check('retrying 排期已过但仍在宽限内 → 暂停', shouldPauseStallWatchdog({ phase: 'retrying', nextRetryAt: now - 10_000, lastRetryAt: now }, now) === true);
  check('retrying 排期过期超宽限 → 恢复管辖', shouldPauseStallWatchdog({ phase: 'retrying', nextRetryAt: now - RETRY_PAUSE_GRACE_MS - 1, lastRetryAt: now }, now) === false);
  check('retrying 无排期、最近有重试事件 → 暂停', shouldPauseStallWatchdog({ phase: 'retrying', nextRetryAt: null, lastRetryAt: now - 1_000 }, now) === true);
  check('retrying 无排期、久无重试事件 → 恢复管辖', shouldPauseStallWatchdog({ phase: 'retrying', nextRetryAt: null, lastRetryAt: now - RETRY_PAUSE_GRACE_MS - 1 }, now) === false);

  const sb = readRel('src/main/modules/sdk-backend.ts');
  check('watchdogTick 接入暂停判定 + 恢复时重置计时基准', /function watchdogTick[\s\S]*?shouldPauseStallWatchdog\(apiRetryStates\.get\(sessionId\), now\)[\s\S]*?t\.retryPaused = false;[\s\S]*?t\.lastActivityAt = now;/.test(sb));
}

console.log('\n=== 5) 回合快照 / 探针取消 / 漂移可见 ===');
{
  const sb = readRel('src/main/modules/sdk-backend.ts');
  check('回合内连接快照 Map 存在并在 buildSdkOptions 写入', sb.includes('sessionLastTurnOverride') && sb.includes('entry.sessionModelOverride = override;'));
  check('探针优先复用回合快照', /runPostTurnContextProbe[\s\S]*?sessionLastTurnOverride\.has\(sessionId\)/.test(sb));
  check('新回合取消 post-turn 探针', /await cancelCommandProbe\(sessionId\);[\s\S]{0,200}?cancelPostTurnProbe\(sessionId\);/.test(sb));
  check('会话删除收口清理两个新 Map', /markSessionDeleted[\s\S]*?sessionLastTurnOverride\.delete\(sessionId\)[\s\S]*?sessionLastEffective\.delete\(sessionId\)/.test(sb));
  check('漂移落库 system:connection_drift', sb.includes("processKind: 'system:connection_drift'"));
  check('漂移仅在变化时落库（prev 比对）', /function notifyEffectiveConnectionDrift[\s\S]*?if \(!prev\) return;[\s\S]*?providerName === current\.providerName && prev\.modelId === current\.modelId\) return;/.test(sb));
}

console.log(`\n=== 连接完整性自测：${pass} 过 / ${fail} 败 ===`);
if (fail > 0) process.exit(1);
