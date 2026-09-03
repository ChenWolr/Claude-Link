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
  resolveAliasToActualModel, // 新增
  resolveConfiguredActualModel,
  resolveConfiguredDefaultModel,
  peekEnvValue,
  setContextWindowInAdvancedJson,
} from '../src/shared/settings-parser';
import { extractContextTokens, detectCompaction, type CliUsage } from '../src/shared/context-usage';
import { lookupModelWindow, resolveContextWindow, resolveContextWindowForSession, lookupUserContextWindow } from '../src/shared/model-context-windows';
import { normalizeDbTime } from '../src/shared/time';
import type { CliEvent, CliSystemInfoEvent, CliMessageEvent, CliResultEvent } from '../src/shared/types/cli';
import { isDisplayableSystemInfo, isRedundantSystemProcessKind } from '../src/shared/system-info';
import { classifyStall, DEFAULT_STALL_THRESHOLDS, isBusinessStallActivityKind } from '../src/shared/stall-watchdog';
import { THEME_PALETTES, DEFAULT_THEME_PALETTE_ID } from '../src/shared/constants';
import { resolveThinkingConfig, resolveEffectiveThinkingLevel } from '../src/shared/thinking-resolver';
import { THINKING_LEVELS, isValidThinkingLevel } from '../src/shared/types/thinking';
import { PERMISSION_MODES, isValidPermissionMode, resolveEffectivePermissionMode } from '../src/shared/permission-resolver';

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

// 模拟 cli-shared.buildSpawnEnv 的 env 提取（顶层字符串 + env 块字符串），不依赖 electron。
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

console.log('\n=== 9) 别名→实际模型解析（给 --model 用，CLI 参数压过 settings.json）===');
{
  let adv = setModelMappingInAdvancedJson('{}', 'sonnet', 'glm-5.1');
  adv = setModelMappingInAdvancedJson(adv, 'haiku', 'glm-5.1-flash');
  check('sonnet 别名解析为 glm-5.1', resolveAliasToActualModel('sonnet', adv) === 'glm-5.1', adv);
  check('haiku 别名解析为 glm-5.1-flash', resolveAliasToActualModel('haiku', adv) === 'glm-5.1-flash', adv);
  check('未映射的 opus 原样返回别名', resolveAliasToActualModel('opus', adv) === 'opus', adv);
  check('自定义实际名原样返回', resolveAliasToActualModel('gpt-4o', adv) === 'gpt-4o', adv);
  check('空 requested 回退到首个映射的实际值', resolveAliasToActualModel(null, adv) === 'glm-5.1', adv);
  check('无任何映射时空 requested 回退 sonnet', resolveAliasToActualModel(null, '{}') === 'sonnet');
}

console.log('\n=== 10) API 请求实际模型解析：不得把裸别名直接发给 Messages API ===');
{
  let adv = setModelMappingInAdvancedJson('{}', 'sonnet', 'glm-5.1');
  adv = setModelMappingInAdvancedJson(adv, 'haiku', 'glm-5.1-flash');
  check('默认 API 实际模型取首个映射实际值', resolveConfiguredDefaultModel(adv, 'claude-sonnet-4-6') === 'glm-5.1');
  check('指定 haiku 时解析为实际值', resolveConfiguredActualModel('haiku', adv, 'claude-sonnet-4-6') === 'glm-5.1-flash');
  check('无映射时默认回退 config.defaultModel', resolveConfiguredDefaultModel('{}', 'claude-opus-4-8') === 'claude-opus-4-8');
  check('无映射且默认值是别名时回退标准模型 ID', resolveConfiguredDefaultModel('{}', 'sonnet') === 'claude-sonnet-4-6');
}

console.log('\n=== 11) 上下文 token 用量解析 ===');
{
  const u1: CliUsage = { input_tokens: 9000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 1345, output_tokens: 500 };
  check('input+cache 合计为上下文用量', extractContextTokens(u1) === 12345, String(extractContextTokens(u1)));
  check('空 usage 返回 0', extractContextTokens(undefined) === 0);
  check('缺 cache 字段只算 input', extractContextTokens({ input_tokens: 100 }) === 100);
}

console.log('\n=== 12) 回归：后台标题分析不得硬编码 Haiku，必须走供应商库/配置模型解析 ===');
{
  const source = readRel('src/main/modules/topic-analyzer.ts');
  // 不得出现任何 claude-haiku-4-5 字面量（无论 = 还是 : 写法），否则就是硬编码。
  check('topic-analyzer 不再硬编码 claude-haiku-4-5', !source.includes('claude-haiku-4-5'));
  check('topic-analyzer 使用 resolveSessionModel 解析供应商库模型', source.includes('resolveSessionModel'));
  check('topic-analyzer 保留老链路兜底 resolveConfiguredDefaultModel', source.includes('resolveConfiguredDefaultModel'));
}

console.log('\n=== 13) 回归：聊天发送错误必须在 ChatPage 可见 ===');
{
  const source = readRel('src/renderer/pages/ChatPage.vue');
  check('ChatPage 从 useChat 解构 error', /const \{[^}]*\berror\b[^}]*\} = useChat\(\)/s.test(source));
  check('ChatPage 模板渲染聊天错误', source.includes('chat-error') && source.includes('error'));
}

console.log('\n=== 14) 回归：CLI 子进程异常退出必须推送到聊天界面 ===');
{
  const cliTypes = readRel('src/shared/types/cli.ts');
  const useChat = readRel('src/renderer/composables/use-chat.ts');
  check('CliEvent 包含 error 事件', cliTypes.includes("type: 'error'"));
  check('use-chat 收到 error 事件后 markStopped', useChat.includes("case 'error'") && useChat.includes('markStopped'));
}

// ── 全链路审计修复回归（C1-C3, M1-M8）──────────────────────────────────
function readRel(p: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path');
  // 脚本位于 scripts/，相对路径 ../xxx 解析到项目根下。用 __dirname（cjs 可用）替代
  // import.meta.url（仅 ESM 可用，tsx 以 cjs 输出时不可用）。
  const abs = nodePath.resolve(__dirname, '..', p);
  // 文件尚不存在时返回空串而非抛错：接线契约在对应 Task 完成前文件可能缺失，
  // 此时断言应记为 ❌（红），而非让整个 selftest 崩溃漏掉后续断言与最终汇总。
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8');
}

console.log('\n=== 15) C1: system/init 事件必须被识别并持久化 session_id ===');
{
  const cliTypes = readRel('src/shared/types/cli.ts');
  const cs = readRel('src/main/modules/cli-shared.ts');
  check('CliEvent 联合包含 system 类型', cliTypes.includes("type: 'system'") && cliTypes.includes("subtype"));
  check('cli-shared persistCliEvent 识别 system+init', cs.includes("'system'") && cs.includes('subtype') && cs.includes('init'));
}

console.log('\n=== 16) C2: SDK query 异常结束必须复位前端（防死锁）===');
{
  const sb = readRel('src/main/modules/sdk-backend.ts');
  // SDK 路径：markSessionDeleted 标记会话删除，runQuery 检测 isSessionActive 后 interrupt。
  // 异常结束靠 markStopped（移除 runningSessions，sending getter 自动 false）。
  check('sdk-backend 含 markSessionDeleted', sb.includes('markSessionDeleted'));
  check('sdk-backend runQuery 检测 isSessionActive', sb.includes('isSessionActive'));
}

console.log('\n=== 17) C3: 中断走 SDK Query.interrupt()（跨平台优雅中止）===');
{
  const sb = readRel('src/main/modules/sdk-backend.ts');
  check('sdk-backend 含 Query.interrupt', /interrupt\b/.test(sb));
  check('sdk-backend killProcess 调 interrupt', /killProcess[\s\S]{0,200}interrupt/.test(sb));
}

console.log('\n=== 18) M1: result 错误回合(subtype error/is_error)必须给前端可见提示 ===');
{
  const uc = readRel('src/renderer/composables/use-chat.ts');
  check('use-chat 检查 result.is_error 或 subtype', uc.includes('is_error') || uc.includes("subtype === 'error'") || uc.includes("subtype === \"error\""));
}

console.log('\n=== 19) M2: 切换会话必须重置 sending/error/streaming ===');
{
  const ss = readRel('src/renderer/stores/session-store.ts');
  const sw = ss.match(/switchSession[\s\S]{0,400}/)?.[0] ?? '';
  check('switchSession 清空 streamingContent', sw.includes('streamingContent') || sw.includes('clearStream'));
  check('switchSession 清空 streamingThinking', sw.includes('streamingThinking') || sw.includes('clearThinking'));
}

console.log('\n=== 20) M3: abort 不能立即丢弃尾部 result 元数据 ===');
{
  const uc = readRel('src/renderer/composables/use-chat.ts');
  const abortFn = uc.match(/async function abort[\s\S]{0,400}/)?.[0] ?? '';
  // abort 后需保留监听直到收到结束事件或超时；不能 finally 里立刻 removeChatListener
  check('abort 不立即 stopListening（等结束事件/超时）', !/finally\s*\{[\s\S]{0,120}stopListening\(\)/.test(abortFn) || abortFn.includes('setTimeout'));
}

console.log('\n=== 21) M4: 中断不应被合成 error 误报 ===');
{
  const uc = readRel('src/renderer/composables/use-chat.ts');
  // SDK 路径：中断走 abort() → markStopped，不产生 error 事件。
  // use-chat 的 aborted case 调 markStopped 不设 error。
  check('use-chat aborted case 调 markStopped 不设 error', uc.includes("case 'aborted'") && uc.includes('markStopped'));
}

console.log('\n=== 22) M5: redacted_thinking 必须可识别并占位渲染 ===');
{
  const cliTypes = readRel('src/shared/types/cli.ts');
  const uc = readRel('src/renderer/composables/use-chat.ts');
  check('CliMessageContentPart 包含 redacted_thinking', cliTypes.includes('redacted_thinking'));
  check('use-chat 处理 redacted_thinking', uc.includes('redacted_thinking'));
}

console.log('\n=== 23) M6: tool_result content 数组形态必须提取文本 ===');
{
  const uc = readRel('src/renderer/composables/use-chat.ts');
  check('use-chat 对 tool_result 数组提取文本（非裸 JSON.stringify）', uc.includes('Array.isArray') || uc.includes('.map('));
}

console.log('\n=== 24) M7: 工具调用流式 input_json_delta 必须有反馈 ===');
{
  const uc = readRel('src/renderer/composables/use-chat.ts');
  check('use-chat 处理 input_json_delta', uc.includes('input_json_delta') || uc.includes('partial_json'));
}

console.log('\n=== 25) M8: interruptTask 必须处理 continuing 状态 ===');
{
  const tq = readRel('src/main/modules/task-queue-engine.ts');
  const fn = tq.match(/function interruptTask[\s\S]{0,500}/)?.[0] ?? '';
  check('interruptTask 允许 continuing 状态中断', fn.includes('continuing') || fn.includes('running'));
}

console.log('\n=== 26) Review 修复：中断标记按 query 实例、abort 跨回合串扰 ===');
{
  const sb = readRel('src/main/modules/sdk-backend.ts');
  const uc = readRel('src/renderer/composables/use-chat.ts');
  const ml = readRel('src/renderer/components/chat/MessageList.vue');
  const cp = readRel('src/renderer/pages/ChatPage.vue');
  const us = readRel('src/renderer/composables/use-stream.ts');
  const tq = readRel('src/main/modules/task-queue-engine.ts');
  const sc = readRel('src/shared/session-completion.ts');
  // SDK 路径：中断标记按 query 实例（interruptedQueries WeakSet），非 sessionId。
  check('中断标记按 query 实例（WeakSet）', sb.includes('interruptedQueries') && sb.includes('WeakSet'));
  check('killProcess 调 query.interrupt', /killProcess[\s\S]{0,300}interrupt/.test(sb));
  // M4 + F1：error_during_execution 由共享 isErrorCliResult 显式排除（不弹错误），
  // use-chat 错误展示必须走该统一判定（旧内联 isUserInterrupt 局部变量已移除）。
  check('中断(error_during_execution)不弹错误', sc.includes("event.subtype === 'error_during_execution'") && uc.includes('isErrorCliResult'));
  check('streamingTool 有渲染消费链', ml.includes('streamingTool') && cp.includes('displayTool') && us.includes('displayTool'));
  // try-finally 兜底：abortTimer 单例已改为 per-session Map + ensureAbortFinally。
  // try = 收到结束事件清兜底；finally = 超时强制 markStopped（不依赖 SDK 中断信号是否真生效）。
  check('abort 兜底 per-session + ensureAbortFinally', uc.includes('abortTimers') && uc.includes('ensureAbortFinally'));
  check('abort try-finally：ensureAbortFinally 强制 markStopped（v2-F3 generation 守卫之后）',
    /function ensureAbortFinally[\s\S]{0,900}store\.markStopped\(sid\)/.test(uc) &&
    uc.indexOf('store.markStopped(sid)') > uc.indexOf('(store.turnGeneration[sid] ?? 0) !== generation'));
  check('abort 兜底全部按 sessionId 清理（无单例残留 clearAbortTimer()）', !uc.includes('clearAbortTimer()'));
  check('watch 切会话不清 abort 兜底（中断后切走仍保 finally）', !/activeSession\?\.id[\s\S]{0,120}clearAbortTimer/.test(uc));
  check('continueWithUserMessage exit 守卫 continuing', /status !== 'continuing'/.test(tq));
}

console.log('\n=== 27) 过程分组计划契约：类型/DB/透传/分组/子AgentTab/无诊断日志 ===');
{
  const sess = readRel('src/shared/types/session.ts');
  const ei = readRel('src/shared/types/export-image.ts');
  const mig = readRel('src/main/database/migrations.ts');
  const repo = readRel('src/main/database/repositories/message-repo.ts');
  const cli = readRel('src/shared/types/cli.ts');
  const sb = readRel('src/main/modules/sdk-backend.ts');
  const cs = readRel('src/main/modules/cli-shared.ts');
  const pkShared = readRel('src/shared/process-kind.ts');
  const pkRenderer = readRel('src/renderer/utils/process-kind.ts');
  const gm = readRel('src/renderer/utils/group-messages.ts');
  const ml = readRel('src/renderer/components/chat/MessageList.vue');
  const pg = readRel('src/renderer/components/chat/ProcessGroup.vue');
  const tcb = readRel('src/renderer/components/chat/ToolCallBlock.vue');
  const tqp = readRel('src/renderer/components/task/TaskQueuePanel.vue');
  const ss = readRel('src/renderer/stores/session-store.ts');
  const uc = readRel('src/renderer/composables/use-chat.ts');

  // B2 数据模型 + DB（v3 导出：渲染字段迁入 RenderableMessage，Message extends 它）
  check('RenderableMessage 含 processKind/parentAgentId/toolUseId/title 且 Message 扩展它',
    ei.includes('processKind') && ei.includes('parentAgentId') && ei.includes('toolUseId') && ei.includes('title') && sess.includes('extends RenderableMessage'));
  check('messages 表增量加 4 列迁移（幂等自愈）',
    mig.includes('ALTER TABLE messages ADD COLUMN process_kind') && mig.includes('parent_agent_id') && mig.includes('tool_use_id'));
  check('createMessage 用 options 对象 + 读写 4 列',
    repo.includes('CreateMessageInput') && repo.includes('process_kind') && repo.includes('parent_agent_id'));

  // B1 类型
  check('cli.ts 含 parentToolUseId/CliSystemInfoEvent/CliPermissionEvent/server_tool_use',
    cli.includes('parentToolUseId') && cli.includes('CliSystemInfoEvent') && cli.includes('CliPermissionEvent') && cli.includes('server_tool_use'));

  // B3 主进程透传
  check('convertAssistantMessage 透传 parent_tool_use_id',
    sb.includes('parent_tool_use_id') && sb.includes('parentToolUseId'));
  check('runQuery 转发 system 子类型（informational/permission_denied）',
    sb.includes("'informational'") && sb.includes('permission_denied') && sb.includes('CliPermissionEvent'));
  check('persistMessageParts 计算 processKind + 接收 parentAgentId + 子Agent 标题',
    cs.includes('processKindFromPart') && cs.includes('parentAgentId') && cs.includes('extractSubAgentTitle'));

  // B5 映射
  check('process-kind.ts（shared + renderer）存在',
    pkShared.includes('processKindFromPart') && pkRenderer.includes('getProcessKindMeta'));

  // B6 分组 + 焦点（openhanako 风格：整回合过程合并成居中 fold）
  check('group-messages fold 分组（连续过程合并 + stats + MIN_FOLD）',
    gm.includes('groupMessagesForRender') && gm.includes('FoldStats') && gm.includes('computeStats') && gm.includes('MIN_FOLD'));
  check('MessageList 过滤 parentAgentId + 焦点跟随 activeFoldId',
    ml.includes('!m.parentAgentId') && ml.includes('activeFoldId'));
  check('ProcessGroup 居中摘要 fold（FoldStats + active + 摘要文案）',
    pg.includes('FoldStats') && pg.includes('active') && pg.includes('忙活了一阵子'));
  check('ToolCallBlock 行式（use/result + summarizeToolUse + running）',
    tcb.includes('use:') && tcb.includes('result:') && tcb.includes('summarizeToolUse') && tcb.includes('running'));

  // B7 子Agent Tab
  check('TaskQueuePanel Tab + 子Agent 面板 + 锚点定位',
    tqp.includes('subAgentGroups') && tqp.includes('focusedSubAgentId') && tqp.includes('subagent-group'));
  check('TaskQueuePanel 子Agent 卡片折叠 + 耗时 + 运行动画 + 去跳转条',
    tqp.includes('expandedGroups') && tqp.includes('toggleSubAgentGroup') &&
    tqp.includes('aggregateSubAgentGroups') && tqp.includes('subagent-running-dots') &&
    !tqp.includes('class="subagent-jump"'));
  // 纯逻辑抽到 util（不再内联组件），由 tdd-subagent-verify.ts 行为测试覆盖。
  check('subagent-groups.ts 含耗时/回合过滤/聚合纯逻辑',
    readRel('src/renderer/utils/subagent-groups.ts').includes('computeElapsedSeconds') &&
    readRel('src/renderer/utils/subagent-groups.ts').includes('filterCurrentTurnItems') &&
    readRel('src/renderer/utils/subagent-groups.ts').includes('aggregateSubAgentGroups'));
  check('session-store 右侧 Tab 状态 + focusSubAgent',
    ss.includes('rightTab') && ss.includes('focusSubAgent'));

  // B4 渲染落库（力度②：message 为唯一真相，全量即时落库，多段正文原位，模型无关）
  check('use-chat 力度②：全量落库 + turnHad 兜底去重',
    uc.includes('handleMessagePartsFull') && uc.includes('turnHadText') && uc.includes('turnHadThinking') && uc.includes('turnHadToolUse'));
  check('MessageList turn-boundary 去重（发送中隐藏本回合 text/thinking）',
    ml.includes('turnIds') && ml.includes('turnStartIndex'));

  // B8 清理：无诊断日志残留
  check('无 claude-link-debug.log / [diag 诊断残留',
    !sb.includes('claude-link-debug.log') && !uc.includes('[diag'));
}

console.log('\n=== 28) 问题4: CC 自动压缩事件检测（detectCompaction）===');
{
  // 行为1: 非 system 事件返回 null（message / result / stream_event 都不应被误判为压缩）
  const msgEvent: CliEvent = {
    type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }],
  } as CliMessageEvent;
  check('message 事件不触发压缩检测', detectCompaction(msgEvent) === null,
    `got ${JSON.stringify(detectCompaction(msgEvent))}`);

  const resultEvent: CliEvent = {
    type: 'result', subtype: 'success', result: 'ok',
    total_cost_usd: 0, duration_ms: 0, num_turns: 1, session_id: 's', is_error: false,
  } as CliResultEvent;
  check('result 事件不触发压缩检测', detectCompaction(resultEvent) === null,
    `got ${JSON.stringify(detectCompaction(resultEvent))}`);

  // 行为2: system 但非 compact_boundary 子类型返回 null
  const infoEvent: CliEvent = {
    type: 'system', subtype: 'informational', text: 'some info',
  } as CliSystemInfoEvent;
  check('system/informational 不触发压缩', detectCompaction(infoEvent) === null,
    `got ${JSON.stringify(detectCompaction(infoEvent))}`);

  const pluginEvent: CliEvent = {
    type: 'system', subtype: 'plugin_install', text: 'installed',
  } as CliSystemInfoEvent;
  check('system/plugin_install 不触发压缩', detectCompaction(pluginEvent) === null,
    `got ${JSON.stringify(detectCompaction(pluginEvent))}`);

  // 行为3: system + compact_boundary 返回 { compactedJustNow: true }
  const compactEvent: CliEvent = {
    type: 'system', subtype: 'compact_boundary', text: '上下文已压缩',
  } as CliSystemInfoEvent;
  const r3 = detectCompaction(compactEvent);
  check('system/compact_boundary 触发压缩标记',
    r3 !== null && r3.compactedJustNow === true,
    `got ${JSON.stringify(r3)}`);

  // 行为4: compact_boundary 事件即使无 text 字段也触发（CC 可能不携带 text）
  const compactNoText: CliEvent = {
    type: 'system', subtype: 'compact_boundary',
  } as CliSystemInfoEvent;
  const r4 = detectCompaction(compactNoText);
  check('compact_boundary 无 text 仍触发压缩标记',
    r4 !== null && r4.compactedJustNow === true,
    `got ${JSON.stringify(r4)}`);
}

console.log('\n=== 29) V3-3: 交互历史持久化契约（表/repo/IPC/preload/接线）===');
{
  const mig = readRel('src/main/database/migrations.ts');
  const repo = readRel('src/main/database/repositories/interaction-history-repo.ts');
  const ipc = readRel('src/shared/types/ipc.ts');
  const preload = readRel('src/preload/api.ts');
  const handlers = readRel('src/main/ipc-handlers.ts');
  const ip = readRel('src/renderer/components/chat/InteractionPrompt.vue');

  // 1. 迁移：interaction_history 表（幂等自愈）
  check('migrations 含 interaction_history 表定义',
    mig.includes('interaction_history'));
  check('migrations 幂等检查 interaction_history 表',
    mig.includes('CREATE TABLE IF NOT EXISTS interaction_history'));

  // 2. repo：createInteractionHistory + getInteractionHistory
  check('interaction-history-repo 导出 createInteractionHistory',
    repo.includes('export function createInteractionHistory') || repo.includes('export const createInteractionHistory'));
  check('interaction-history-repo 导出 getInteractionHistory',
    repo.includes('export function getInteractionHistory') || repo.includes('export const getInteractionHistory'));

  // 3. IPC channel + 类型
  check('ipc.ts 含 INTERACTION_HISTORY_GET channel',
    ipc.includes('INTERACTION_HISTORY_GET'));
  check('ipc.ts 含 InteractionHistoryEntry 类型',
    ipc.includes('InteractionHistoryEntry'));

  // 4. preload API
  check('preload/api.ts 含 getInteractionHistory',
    preload.includes('getInteractionHistory'));

  // 5. ipc-handlers 注册
  check('ipc-handlers 注册 INTERACTION_HISTORY_GET',
    handlers.includes('INTERACTION_HISTORY_GET'));

  // 6. InteractionPrompt 接线：pushHistory 落库 + onMounted 加载
  check('InteractionPrompt pushHistory 调落库 IPC',
    ip.includes('createInteractionHistory') || ip.includes('getInteractionHistory') ||
    ip.includes('recordInteractionHistory') || ip.includes('claudeLink.recordInteraction'));
  check('InteractionPrompt 初始化加载历史',
    ip.includes('getInteractionHistory') || ip.includes('loadHistory'));
}

console.log('\n=== 30) 三问题修复：会话切换隔离 / 行间距 / 执行中禁用 ===');
{
  const ss = readRel('src/renderer/stores/session-store.ts');
  const uc = readRel('src/renderer/composables/use-chat.ts');
  const cp = readRel('src/renderer/pages/ChatPage.vue');
  const mb = readRel('src/renderer/components/chat/MessageBubble.vue');
  const sr = readRel('src/renderer/components/chat/StreamRenderer.vue');
  const tb = readRel('src/renderer/components/chat/ThinkingBlock.vue');
  const ml = readRel('src/renderer/components/chat/MessageList.vue');
  const cb = readRel('src/renderer/components/chat/ContextButton.vue');
  const ms = readRel('src/renderer/components/chat/ProviderModelSelector.vue');
  const st = readRel('src/renderer/components/chat/SessionToolbar.vue');

  // 问题 1：会话切换隔离
  check('session-store 含 runningSessions state', ss.includes('runningSessions'));
  check('session-store 含 sessionStreams state', ss.includes('sessionStreams'));
  check('session-store 含 markRunning action', ss.includes('markRunning'));
  check('session-store 含 markStopped action', ss.includes('markStopped'));
  check('session-store 含 appendBackgroundStream action', ss.includes('appendBackgroundStream'));
  check('switchSession 保存旧会话流式快照', ss.includes('sessionStreams[oldId]'));
  check('switchSession 恢复目标会话快照', ss.includes('sessionStreams[session.id]') || ss.includes('snapshot'));
  check('switchSession sending 依 runningSessions（getter 派生）', ss.includes('sending(state)') && ss.includes('runningSessions.includes'));
  check('deleteSession 清理 runningSessions', ss.includes('runningSessions.filter') && ss.includes('sid !== id'));
  check('deleteSession 清理 sessionStreams', ss.includes('delete this.sessionStreams[id]'));

  check('use-chat sending 从 store getter 派生（computed）', uc.includes('computed(() => store.sending)'));
  check('use-chat 含 handleBackgroundEvent', uc.includes('handleBackgroundEvent'));
  check('use-chat handleBackgroundEvent 写快照', uc.includes('appendBackgroundStream'));
  check('use-chat handleBackgroundEvent 调 markStopped', uc.includes('markStopped(sid)'));
  check('use-chat sendMessage 调 markRunning', uc.includes('store.markRunning'));
  check('use-chat result/error/aborted 调 markStopped', uc.includes('markStopped(store.activeSession.id)'));
  check('use-chat startListening 先 removeChatListener', uc.includes('removeChatListener()') && uc.includes('startListening'));
  check('ChatPage onMounted 调 refreshActiveSession', cp.includes('refreshActiveSession') && cp.includes('onMounted'));
  check('ChatPage onUnmounted 不调 stopListening', !/onUnmounted\([\s\S]{0,80}stopListening/.test(cp));

  // 问题 2：行间距
  check('MessageBubble line-height:1.5', mb.includes('line-height: 1.5') || mb.includes('line-height:1.5'));
  check('MessageBubble p margin 0.25rem', mb.includes('0 0 0.25rem'));
  check('StreamRenderer line-height:1.5', sr.includes('line-height: 1.5') || sr.includes('line-height:1.5'));
  check('ThinkingBlock line-height:1.5', tb.includes('line-height: 1.5') || tb.includes('line-height:1.5'));
  check('MessageList gap:0.25rem', ml.includes('gap: 0.25rem') || ml.includes('gap:0.25rem'));

  // 问题 3：执行中禁用
  check('ContextButton 含 disabled prop', cb.includes('disabled') && cb.includes('defineProps'));
  check('ProviderModelSelector 含 disabled prop', ms.includes('disabled') && ms.includes('defineProps'));
  check('SessionToolbar ContextButton :disabled', st.includes('ContextButton :disabled="sending"'));
  check('SessionToolbar 工作空间 button :disabled', /ctl__btn[\s\S]{0,120}:disabled="sending"/.test(st));
  // 批次三（2026-09-03 midrun-settings-unlock）：模型选择器生成中放开 sending 禁用
  // （下一条消息起生效），同批次二 #3 权限按钮先例，改为反向契约：不得再挂 :disabled="sending"。
  check('SessionToolbar ProviderModelSelector 不再 :disabled（生成中可切，下一条生效）', st.includes('<ProviderModelSelector />') && !st.includes('ProviderModelSelector :disabled'));
  // 权限控件已由 <select> 改为卡片式（commit d396477）。批次二 #3 后权限触发按钮放开
  // sending 禁用（运行中切档经 streaming 控制请求即时生效），此处改为反向契约：
  // 权限按钮块（perm-menu 之前）不得再挂 :disabled="sending"。
  check('SessionToolbar 权限触发按钮不再 :disabled（批次二 #3 运行中可切档）', !/:disabled="sending"[\s\S]{0,400}perm-menu/.test(st));
}

console.log('\n=== 31) 根因修复：chat:event 监听全局化 + sending 派生 ===');
{
  const app = readRel('src/renderer/App.vue');
  const ss = readRel('src/renderer/stores/session-store.ts');
  const uc = readRel('src/renderer/composables/use-chat.ts');
  const cp = readRel('src/renderer/pages/ChatPage.vue');

  // 1. 监听在 App.vue 全局注册（不在 ChatPage）
  check('App.vue 含 startListening 全局监听', app.includes('startListening'));
  check('App.vue 含 chat event cleanup（onUnmounted 或 returned cleanup）', app.includes('onBeforeUnmount') || app.includes('onUnmounted') || /return.*cleanup/.test(app));

  // 2. sending 是 store getter（从 runningSessions 派生），不再是 state
  check('session-store sending 是 getter', /getters[\s\S]{0,200}sending/.test(ss));
  check('session-store sending getter 从 runningSessions 派生', /sending[\s\S]{0,100}runningSessions/.test(ss));

  // 3. useChat 是全局单例（监听在 App.vue 注册一次，ChatPage 卸载不影响）
  check('use-chat 含 createChat 内部工厂函数', uc.includes('function createChat'));
  check('use-chat 含 chatSingleton 单例', uc.includes('chatSingleton'));
  check('use-chat useChat 返回单例', /export function useChat[\s\S]{0,80}chatSingleton/.test(uc));

  // 4. useChat 不再含 local sending ref（改为从 store 读）
  check('use-chat 不含 const sending = ref', !uc.includes('const sending = ref(false)') && !uc.includes("const sending = ref<boolean>(false)"));
  check('use-chat 不含 sending.value = ', !/sending\.value\s*=/.test(uc));

  // 5. ChatPage 不再调 startListening/stopListening
  check('ChatPage 不含 startListening', !cp.includes('startListening'));
  check('ChatPage 不含 stopListening', !cp.includes('stopListening'));

  // 6. ChatPage sending 从 useChat 单例读（单例 sending = computed(store.sending)）
  check('ChatPage sending 从 useChat 单例读', cp.includes('useChat') && cp.includes('sending'));

  // 7. store 含 refreshActiveSession（ChatPage 重挂载时重拉 messages + 同步状态）
  check('session-store 含 refreshActiveSession action', ss.includes('refreshActiveSession'));
}

console.log('\n=== 32) CC 回复形态补全：code_execution / is_error / api_retry / 兜底日志 ===');
{
  const cli = readRel('src/shared/types/cli.ts');
  const pkShared = readRel('src/shared/process-kind.ts');
  const pkRenderer = readRel('src/renderer/utils/process-kind.ts');
  const cs = readRel('src/main/modules/cli-shared.ts');
  const uc = readRel('src/renderer/composables/use-chat.ts');
  const mig = readRel('src/main/database/migrations.ts');
  const repo = readRel('src/main/database/repositories/message-repo.ts');
  const sess = readRel('src/shared/types/session.ts');
  const ei = readRel('src/shared/types/export-image.ts');
  const sb = readRel('src/main/modules/sdk-backend.ts');
  const tcb = readRel('src/renderer/components/chat/ToolCallBlock.vue');

  // 1. code_execution_tool_result：服务端代码执行结果不再静默丢弃（类型→分类→双路解析→图标）
  check('cli.ts 含 code_execution_tool_result 类型', cli.includes('code_execution_tool_result'));
  check('processKindFromPart 分类 code_execution_tool_result → tool:code_execution',
    pkShared.includes("case 'code_execution_tool_result'") && pkShared.includes("'tool:code_execution'"));
  check('persistMessageParts 解析 code_execution_tool_result', cs.includes("'code_execution_tool_result'"));
  check('handleMessagePartsFull 解析 code_execution_tool_result', uc.includes("'code_execution_tool_result'"));
  check('TOOL_META 含 code_execution 图标映射', pkRenderer.includes('code_execution'));

  // 2. 未知 content block 兜底日志（协议新形态不再被无声吞掉）
  check('persistMessageParts 兜底日志未知 part', cs.includes('未识别的 content block 类型'));
  check('handleMessagePartsFull 兜底日志未知 part', uc.includes('未识别的 content block 类型'));

  // 3. tool_result.is_error 全链路（类型→DB→repo→双路解析→UI 标红）
  check('cli.ts tool_result 含 is_error 字段', cli.includes('is_error?: boolean'));
  check('Message 含 isError 字段', ei.includes('isError') && sess.includes('extends RenderableMessage'));
  check('messages 表幂等加 is_error 列', mig.includes('ALTER TABLE messages ADD COLUMN is_error'));
  check('repo MessageRow/toMessage/createMessage 贯穿 is_error', repo.includes('is_error') && repo.includes('isError'));
  check('persistMessageParts 提取 is_error 落库', cs.includes('part.is_error === true'));
  check('handleMessagePartsFull 提取 is_error', uc.includes('part.is_error === true'));
  check('ToolCallBlock 失败状态行 ✗ 红色', tcb.includes('result.isError') && tcb.includes('tool-row__fail'));

  // 4. system/api_retry 事件解析与展示（API 重试可见反馈，不再被「未知 subtype」吞掉）
  check('cli.ts CliSystemInfoEvent 含 api_retry subtype', cli.includes("'api_retry'"));
  check('cli.ts api_retry 含应用级权威重试字段',
    cli.includes('retryCount?: number') && cli.includes('retryLimit?: number') &&
    cli.includes('nextRetryAt?: number') && !cli.includes('nextRetryAt?: number | null') &&
    cli.includes('retryDelayMs?: number') && cli.includes('error?: string') &&
    cli.includes('errorStatus?: number | null'));
  check('cli.ts api_retry 保留 SDK 原始重试诊断字段',
    cli.includes('sdkAttempt?: number') && cli.includes('sdkMaxRetries?: number'));
  check('cli.ts api_retry 已移除旧 SDK 字段名',
    !cli.includes('attempt?: number') && !cli.includes('max_retries?: number'));
  check('cli.ts 含持久化消息与 API 重试终态事件',
    cli.includes('CliPersistedMessageEvent') && cli.includes("type: 'persisted_message'") &&
    cli.includes('message: Message') &&
    cli.includes('CliApiRetryTerminalFallbackEvent') && cli.includes("type: 'api_retry_terminal'") &&
    cli.includes('summary: string') && cli.includes('persisted: false'));
  check('cli.ts API 重试终态事件复用 Task 1 详情与种类类型',
    cli.includes('kind: ApiRetryTerminalKind') && cli.includes('details: ApiRetryTerminalDetailsV1'));
  check('cli.ts 新终态事件加入 CliEvent 联合',
    cli.includes('| CliPersistedMessageEvent') && cli.includes('| CliApiRetryTerminalFallbackEvent'));
  check('sdk-backend 转发 api_retry system 事件并保留 SDK 诊断字段',
    sb.includes("infoSubtype === 'api_retry'") &&
    sb.includes("const sdkAttempt = typeof sdkMsg.attempt === 'number' ? sdkMsg.attempt : undefined") &&
    sb.includes("const sdkMaxRetries = typeof sdkMsg.max_retries === 'number' ? sdkMsg.max_retries : undefined") &&
    sb.includes('sdkAttempt,') && sb.includes('sdkMaxRetries,') &&
    !sb.includes("attempt: typeof sdkMsg.attempt === 'number' ? sdkMsg.attempt : undefined") &&
    !sb.includes("max_retries: typeof sdkMsg.max_retries === 'number' ? sdkMsg.max_retries : undefined"));
  check('use-chat 用应用级权威字段驱动 api_retry UI',
    uc.includes('retryCount: event.retryCount') && uc.includes('retryLimit: event.retryLimit') &&
    !uc.includes('r.sdkMaxRetries') && !uc.includes('info.attempt') && !uc.includes('info.max_retries'));
  check('persistSystemEvent 构造 api_retry 诊断文案', uc.includes('API 重试中'));

  // 5. citations 类型字段（web search 引用，未来就绪；当前代理端点不触发）
  check('cli.ts text part 含 citations + stream delta 含 citation', cli.includes('citations?') && cli.includes('citation?'));
}

console.log('\n=== 32b) L6/L7 类型精度：MCP content block + compaction stream delta + status 子类型 ===');
{
  const cli = readRel('src/shared/types/cli.ts');
  const pkShared = readRel('src/shared/process-kind.ts');
  const cs = readRel('src/main/modules/cli-shared.ts');
  const uc = readRel('src/renderer/composables/use-chat.ts');
  const sb = readRel('src/main/modules/sdk-backend.ts');
  const sdkInteractions = readRel('src/main/modules/sdk-interactions.ts');
  const sdkPermissions = readRel('src/main/modules/sdk-permissions.ts');
  const settingsProjection = readRel('src/main/modules/claude-settings-projection.ts');
  const settingsWriter = readRel('src/main/modules/settings-writer.ts');

  // L6：MCP content block 类型 + processKind 分类 + 双路解析（不再静默丢弃）
  check('cli.ts 含 mcp_tool_use / mcp_tool_result 类型', cli.includes('mcp_tool_use') && cli.includes('mcp_tool_result'));
  check('processKindFromPart 分类 mcp_tool_use/mcp_tool_result', pkShared.includes("case 'mcp_tool_use'") && pkShared.includes("case 'mcp_tool_result'"));
  check('persistMessageParts 解析 mcp_tool_use/mcp_tool_result', cs.includes("part.type === 'mcp_tool_use'") && cs.includes("part.type === 'mcp_tool_result'"));
  check('handleMessagePartsFull 解析 mcp_tool_use/mcp_tool_result', uc.includes("part.type === 'mcp_tool_use'") && uc.includes("part.type === 'mcp_tool_result'"));

  // L7：stream delta 枚举补 compaction_content_delta
  check('cli.ts stream delta 含 compaction_content_delta', cli.includes('compaction_content_delta'));

  // M5：status 子类型扩展（compact_result/compact_error/requesting）
  check('cli.ts CliSystemInfoEvent 含 compact_result/compact_error/requesting', cli.includes("'compact_result'") && cli.includes("'compact_error'") && cli.includes("'requesting'"));
  check('sdk-backend 转发 status compact_result/requesting', sb.includes("subtype: 'compact_result'") && sb.includes("sdkMsg.status === 'requesting'"));

  // L2/L3：PermissionUpdate 类型收紧（不再 unknown[]）
  check('sdk-permissions 含 PermissionUpdate 类型定义', sdkPermissions.includes('export type PermissionUpdate'));
  check('sdk-interactions 复用 PermissionUpdate 类型', sdkInteractions.includes("type PermissionUpdate } from './sdk-permissions'") && sdkInteractions.includes('export type { PermissionUpdate }'));
  check('PermissionResult.updatedPermissions 用 PermissionUpdate[]', sdkInteractions.includes('updatedPermissions?: PermissionUpdate[]'));
  check('settings projection 保留 advancedJson 顶层设置', settingsProjection.includes('...advanced') && settingsProjection.includes('buildPermissionSettings'));
  check('settings-writer 复用完整 settings projection', settingsWriter.includes('buildClaudeSettingsProjection(config)'));
  check('sdk-backend 复用完整 settings projection', sb.includes('buildClaudeSettingsProjection(config)') && sb.includes('...settings'));
  // M3/M4：onElicitation 辅助纯函数
  check('sdk-interactions 含 buildElicitationInteractionPayload（url 模式）', sdkInteractions.includes('buildElicitationInteractionPayload') && sdkInteractions.includes("request.mode === 'url'"));
  check('sdk-interactions 含 elicitationResultFromInteraction（submit→accept / 非 submit→cancel）',
    sdkInteractions.includes('elicitationResultFromInteraction') && sdkInteractions.includes("action: 'cancel'"));
}

console.log('\n=== 33) 工具映射补全（A）+ 子 agent 标题扩展（B）===');
{
  const pkRenderer = readRel('src/renderer/utils/process-kind.ts');
  const pkShared = readRel('src/shared/process-kind.ts');

  // A：高频工具补专属图标 + 中文标签（原仅 ⚙️ 原名兜底，照样显示但不美化）
  check('TOOL_META 含 Workflow 工作流', pkRenderer.includes("Workflow: { icon: '🧩'"));
  check('TOOL_META 含 AskUserQuestion 提问', pkRenderer.includes('AskUserQuestion:'));
  check('TOOL_META 含 EnterPlanMode 进入计划', pkRenderer.includes('EnterPlanMode:'));
  check('TOOL_META 含 TaskStop 停止任务', pkRenderer.includes('TaskStop:'));
  check('TOOL_META 含 PowerShell 执行命令', pkRenderer.includes('PowerShell:'));
  check('summarizeToolUse PowerShell 复用 Bash 摘要', pkRenderer.includes("case 'PowerShell':"));
  // 清死映射：MultiEdit 非真实独立工具（已折叠进 Edit 的 replace_all），不应残留
  check('TOOL_META 已清除 MultiEdit 死映射', !pkRenderer.includes('MultiEdit'));

  // B：extractSubAgentTitle 认 Skill(fork)/Workflow，子 agent Tab 标题不再为空/兜底
  check('extractSubAgentTitle 认 Skill', pkShared.includes("case 'Skill':"));
  check('extractSubAgentTitle 认 Workflow', pkShared.includes("case 'Workflow':"));
}

console.log('\n=== 34) 进度状态层（C）：tool_progress / task_* / compacting 接入 ===');
{
  const cli = readRel('src/shared/types/cli.ts');
  const pe = readRel('src/shared/progress-events.ts');
  const sb = readRel('src/main/modules/sdk-backend.ts');
  const ss = readRel('src/renderer/stores/session-store.ts');
  const uc = readRel('src/renderer/composables/use-chat.ts');
  const tcb = readRel('src/renderer/components/chat/ToolCallBlock.vue');
  const pg = readRel('src/renderer/components/chat/ProcessGroup.vue');
  const tqp = readRel('src/renderer/components/task/TaskQueuePanel.vue');
  const cb = readRel('src/renderer/components/chat/ContextButton.vue');

  check('cli.ts 含 CliToolProgressEvent / CliTaskEvent', cli.includes('CliToolProgressEvent') && cli.includes('CliTaskEvent'));
  check('CliSystemInfoEvent.subtype 含 compacting', cli.includes("'compacting'"));
  check('progress-events 含 convertToolProgress / convertTaskEvent', pe.includes('convertToolProgress') && pe.includes('convertTaskEvent'));
  check('sdk-backend 转发 tool_progress（forwardTransient）', sb.includes("type === 'tool_progress'") && sb.includes('forwardTransient'));
  check('sdk-backend 转发 task_*', sb.includes("'task_started'") && sb.includes('convertTaskEvent'));
  check('sdk-backend 转发 status:compacting', sb.includes("sdkMsg.status === 'compacting'"));
  check('session-store 含 toolProgress/backgroundTasks/compacting', ss.includes('toolProgress') && ss.includes('backgroundTasks') && ss.includes('compacting'));
  check('session-store 含 setToolProgress/clearToolProgress/setCompacting', ss.includes('setToolProgress') && ss.includes('clearToolProgress') && ss.includes('setCompacting'));
  check('use-chat applyProgressEvent 接线', uc.includes('applyProgressEvent'));
  check('ToolCallBlock 显示耗时 ⏱', tcb.includes('elapsedSeconds') && tcb.includes('⏱'));
  check('ToolCallBlock 主流程后台运行标注', tcb.includes('backgroundRunning') && tcb.includes('🔁后台'));
  check('ProcessGroup 传 elapsedSeconds', pg.includes('store.toolProgress') && pg.includes('elapsedSeconds'));
  check('TaskQueuePanel 后台任务 Tab', tqp.includes("rightTab === 'background'") && tqp.includes('backgroundTaskList'));
  check('TaskQueuePanel 子Agent 本回合过滤（util 纯逻辑 + 组件接线）',
    tqp.includes('turnStartIndex') && tqp.includes('aggregateSubAgentGroups') &&
    readRel('src/renderer/utils/subagent-groups.ts').includes('currentTurnMessages'));
  // 用户要求：长按圈圈触发压缩后，不再展示「正在压缩上下文…」横幅；store.compacting 状态链路仍保留。
  check('ContextButton 不再展示压缩中横幅', !cb.includes('正在压缩') && !cb.includes('ctx__banner--compacting'));
}

console.log('\n=== 35) system-info 过滤契约（问题 5）：空 informational 不展示 ===');
{
  // 行为契约：informational 必须有非空文本；其余子类型一律放行（有专用文案/语义）。
  check('空文本 informational → 不展示', isDisplayableSystemInfo('informational', undefined) === false);
  check('空白 informational → 不展示', isDisplayableSystemInfo('informational', '   ') === false);
  check('有文本 informational → 展示', isDisplayableSystemInfo('informational', '上下文已压缩') === true);
  check('permission_request 无文本 → 仍展示', isDisplayableSystemInfo('permission_request', undefined) === true);
  check('compact_boundary 无文本 → 仍展示', isDisplayableSystemInfo('compact_boundary', undefined) === true);
  check('api_retry 无文本 → 仍展示', isDisplayableSystemInfo('api_retry', undefined) === true);

  // 结构契约：三处（发射点 / 落库 / 渲染）统一调用同一判定。
  check('sdk-backend 发射点过滤空 informational', readRel('src/main/modules/sdk-backend.ts').includes('isDisplayableSystemInfo'));
  check('cli-shared 落库过滤空 informational', readRel('src/main/modules/cli-shared.ts').includes('isDisplayableSystemInfo'));
  check('use-chat 渲染过滤空 informational', readRel('src/renderer/composables/use-chat.ts').includes('isDisplayableSystemInfo'));
}

console.log('\n=== 36) 实时计时器 + 子 Agent 折叠（问题 1/2/6/7）===');
{
  const ss = readRel('src/renderer/stores/session-store.ts');
  const ml = readRel('src/renderer/components/chat/MessageList.vue');
  const mb = readRel('src/renderer/components/chat/MessageBubble.vue');
  const uc = readRel('src/renderer/composables/use-chat.ts');
  const sg = readRel('src/renderer/utils/subagent-groups.ts');
  const tqp = readRel('src/renderer/components/task/TaskQueuePanel.vue');
  const un = readRel('src/renderer/composables/use-now.ts');
  const pg = readRel('src/renderer/components/chat/ProcessGroup.vue');
  const tt = readRel('src/renderer/components/chat/TurnTimer.vue');
  check('use-now 提供 useNow（100ms 跳动）', un.includes('useNow') && un.includes('setInterval'));
  check('session-store 含 turnStartedAt + activeTurnStartedAt', ss.includes('turnStartedAt') && ss.includes('activeTurnStartedAt'));
  check('markRunning 记录 turnStartedAt', ss.includes('this.turnStartedAt[sessionId] = Date.now()'));
  check('markRunning 全新回合清 toolProgress 残留（第四态配套）', ss.includes('全新回合清空工具进度残留'));
  check('markRunning 清 toolProgress 仅限活动会话（防后台队列跨会话误清）', ss.includes('sessionId === this.activeSession?.id'));
  check('TurnTimer 实时计时器（turn-timer + formatDurationMs + useNow）', tt.includes('turn-timer') && tt.includes('formatDurationMs') && tt.includes('useNow'));
  check('MessageBubble duration 与 cost 解耦', mb.includes('message.costUsd != null || message.durationMs'));
  check('use-chat 客户端时长兜底（clientMs）', uc.includes('clientMs'));
  check('subagent-groups 含 startMs / frozenSeconds', sg.includes('startMs') && sg.includes('frozenSeconds'));
  check('TaskQueuePanel 实时计时 + 运行中可折叠', tqp.includes('subAgentDurationText') && tqp.includes('collapsedGroups'));
  check('ProcessGroup 不再硬编码 ℹ️ 系统提示', pg.includes('ℹ️') === false);
  check('TaskQueuePanel 子Agent body 不再重复显示耗时', !tqp.includes('耗时：{{ subAgentDurationText(g) }}'));
}

console.log('\n=== 37) 二次修复契约（实测根因修正：问题 1/2/5/6/7）===');
{
  const gm = readRel('src/renderer/utils/group-messages.ts');
  const pg = readRel('src/renderer/components/chat/ProcessGroup.vue');
  const uc = readRel('src/renderer/composables/use-chat.ts');
  const tqp = readRel('src/renderer/components/task/TaskQueuePanel.vue');
  const ts = readRel('src/renderer/stores/task-store.ts');
  const tb = readRel('src/renderer/components/chat/ThinkingBlock.vue');
  const ml = readRel('src/renderer/components/chat/MessageList.vue');
  const tt = readRel('src/renderer/components/chat/TurnTimer.vue');

  // R2（问题 5）：渲染层过滤 permission / interaction_response（首轮误诊为空 informational）。
  check('permission 视为冗余（不渲染）', isRedundantSystemProcessKind('permission') === true);
  check('system:interaction_response 视为冗余', isRedundantSystemProcessKind('system:interaction_response') === true);
  check('system:informational 视为冗余（问题 2：彻底删行不渲染）', isRedundantSystemProcessKind('system:informational') === true);
  check('system:api_retry 视为冗余（Bug4：改瞬态，旧库残留行不渲染成「系统」）', isRedundantSystemProcessKind('system:api_retry') === true);
  check('thinking 非冗余（保留渲染）', isRedundantSystemProcessKind('thinking') === false);
  check('tool:* 非冗余', isRedundantSystemProcessKind('tool:bash') === false);
  check('compact_boundary 非冗余', isRedundantSystemProcessKind('system:compact_boundary') === false);
  check('null 非冗余', isRedundantSystemProcessKind(null) === false);
  check('group-messages 渲染层过滤冗余 system', gm.includes('isRedundantSystemProcessKind'));

  // Bug4：api_retry 的第 1～9 次走 forwardTransient（不落库、不进聊天流），不再冒「系统消息」。
  const sb = readRel('src/main/modules/sdk-backend.ts');
  const apiRetryBranch = sb.slice(
    sb.indexOf("if (infoSubtype === 'api_retry')"),
    sb.indexOf('// 权限询问/拒绝事件'),
  );
  check('api_retry 走 forwardTransient（不落库）',
    apiRetryBranch.includes('forwardTransient(sessionId, mainWindow, sysInfo)') &&
    !apiRetryBranch.includes('persistCliEvent(sessionId, sysInfo)'));
  check('MessageList 挂载 ApiRetryBanner', ml.includes('ApiRetryBanner'));
  // Bug2：SDK 转发子 agent text/thinking + stream_event 透传 parent_tool_use_id → 子 Agent Tab 思考中可见。
  check('sdk-backend 开启 forwardSubagentText', sb.includes('forwardSubagentText = true'));
  check('convertStreamEvent 透传 parent_tool_use_id', /convertStreamEvent[\s\S]{0,300}parent_tool_use_id/.test(sb));
  check('TaskQueuePanel 引入 ThinkingBlock（子 agent 实时思考）', tqp.includes('ThinkingBlock'));
  // Task3：重试次数只由 apiRetryStates 维护；StallTracker 仍识别 system/api_retry 并提前返回，避免刷新静默计时。
  check('touchActivityFromEvent 对 api_retry 仅早退且不重复计数',
    /subtype === 'api_retry'\) \{\s*return;\s*\}/.test(sb) &&
    !sb.includes('consecutiveApiRetries'));
  // Bug4（二次）：requesting/compact_result 是 forwardTransient 但原渲染层落到 persistSystemEvent → 无 defaultText → 「系统提示」。
  check('use-chat 把 requesting/compact_result 当瞬态（不再冒「系统提示」）', uc.includes("event.subtype === 'compact_result'") && uc.includes("event.subtype === 'requesting'") && uc.includes('setCompacting(false)'));
  // 计划模式确定按钮点不到：interaction-dialog 改 flex 列布局，body 用 flex:1+min-height:0 取代魔数 max-height，footer 不再被裁。
  const ip = readRel('src/renderer/components/chat/InteractionPrompt.vue');
  check('InteractionPrompt 对话框 flex 列布局（footer 不被裁）', ip.includes('flex-direction: column') && /interaction-dialog__body\s*\{[\s\S]*?flex: 1/.test(ip) && ip.includes('flex-shrink: 0'));

  // R1（问题 2）：sdk-backend 把缺失值补 0，?? 对 0 不生效 → 改真值判断 + clientMs 兜底。
  check('use-chat 时长真值判断（>0 回落 clientMs）', uc.includes('event.duration_ms') && uc.includes('> 0') && uc.includes('clientMs'));

  // R3（问题 6）：子 Agent 实时计时改回合级 sending（首轮仅末组 g.running 实时，非末组冻结）。
  check('TaskQueuePanel 子Agent 计时用回合级 sending', tqp.includes('sessionStore.sending && g.startMs'));
  // 计时偏短根因修正：回合结束冻结在 live 最终值，不回退到偏短的 createdAt 首尾差。
  check('TaskQueuePanel 子Agent 计时回合结束冻结 live（lastLiveByGroup）',
    tqp.includes('lastLiveByGroup') && tqp.includes('frozenLive') && tqp.includes('Date.now()'));

  // R4（问题 7）：内层 ProcessGroup manualClosed 覆盖 active，运行中可折叠。
  check('ProcessGroup manualClosed 运行中可折叠', pg.includes('manualClosed'));

  // R5（问题 1）：阶段徽章工作阶段常驻（方案 A 状态头条：呼吸点 + 计时 + 四态阶段徽章，替代旧 turn-timer__working 脉冲点）。
  check('TurnTimer 阶段徽章四态常驻（思考/调用/执行/生成）', tt.includes('turn-timer__phase') && tt.includes('工具执行中') && tt.includes('streamingTool'));
  check('TurnTimer 工具执行中读 toolProgress（第四态）', tt.includes('toolProgress'));
  check('ThinkingBlock 脉冲动画点', tb.includes('think-dot-pulse'));

  // R6（问题 1+2 健壮性）：队列驱动回合同步执行态（不经 sendMessage → 否则 sending 恒 false）。
  check('task-store 队列事件同步 markRunning/markStopped',
    ts.includes('sessionStore.markRunning(payload.sessionId)') && ts.includes('sessionStore.markStopped(payload.sessionId)'));
}

console.log('\n=== 38) 卡死看门狗契约（stall-watchdog：检测/双区/硬中断）===');
{
  const T = DEFAULT_STALL_THRESHOLDS;
  // 纯函数 classifyStall 行为
  check('MODEL 区刚到阈值判定卡死', classifyStall(0, T.modelGapMs, false).stalled === true);
  check('MODEL 区差 1ms 未到阈值不卡死', classifyStall(0, T.modelGapMs - 1, false).stalled === false);
  check('TOOL 区在 model 阈值上不卡死（用更长阈值）', classifyStall(0, T.modelGapMs, true).stalled === false);
  check('TOOL 区到 tool 阈值判定卡死', classifyStall(0, T.toolPendingMs, true).stalled === true);
  check('MODEL 区到硬中断阈值触发 hardAbort', classifyStall(0, T.hardAutoAbortMs, false).hardAbort === true);
  check('TOOL 区在 model 硬中断阈值不 hardAbort（未到 tool 绝对上限）', classifyStall(0, T.hardAutoAbortMs, true).hardAbort === false);
  check('TOOL 区到 toolHardAbortMs 绝对上限触发 hardAbort（兜死锁/死连接）', classifyStall(0, T.toolHardAbortMs, true).hardAbort === true);
  check('DEFAULT_STALL_THRESHOLDS.toolHardAbortMs 存在且 > toolPendingMs', typeof T.toolHardAbortMs === 'number' && T.toolHardAbortMs > T.toolPendingMs);
  check('MODEL 区未到硬中断阈值不 hardAbort', classifyStall(0, T.modelGapMs, false).hardAbort === false);
  check('classifyStall 报告 zone=model', classifyStall(0, T.modelGapMs, false).zone === 'model');
  check('classifyStall 报告 zone=tool', classifyStall(0, T.toolPendingMs, true).zone === 'tool');
  check('gapMs 恒非负（now 早于 lastActivityAt 时钳为 0）', classifyStall(100, 50, false).gapMs === 0);
  // api_retry 不算业务活动：重试是失败不是进展，否则空/畸形响应重试风暴会持续刷新计时、永判不出卡死。
  check('isBusinessStallActivityKind(api_retry) === false', isBusinessStallActivityKind('api_retry') === false);
  check('isBusinessStallActivityKind(message/stream_event) === true', isBusinessStallActivityKind('message') && isBusinessStallActivityKind('stream_event'));

  // 接线存在性（防止后续 Task 漏接）—— Task 2-6 完成前为红，属预期。
  const cli = readRel('src/shared/types/cli.ts');
  const sb = readRel('src/main/modules/sdk-backend.ts');
  const ss = readRel('src/renderer/stores/session-store.ts');
  const uc = readRel('src/renderer/composables/use-chat.ts');
  const pk = readRel('src/shared/process-kind.ts');
  const pkg = readRel('package.json');
  const banner = readRel('src/renderer/components/chat/StalledBanner.vue');
  const ml = readRel('src/renderer/components/chat/MessageList.vue');
  check('cli.ts 含 stalled 事件类型', cli.includes("type: 'stalled'"));
  check('sdk-backend 接 keep_alive 心跳', sb.includes("'keep_alive'"));
  check('sdk-backend keep_alive 不刷新业务活动', sb.includes('touchKeepAlive(sessionId)') && !sb.includes("touchActivity(sessionId, 'keep_alive')"));
  check('sdk-backend 传 abortController 并 .abort()', sb.includes('abortController') && sb.includes('.abort()'));
  check('sdk-backend 看门狗 setInterval + classifyStall', sb.includes('setInterval') && sb.includes('classifyStall'));
  check('sdk-backend 发 stalled 事件', sb.includes("type: 'stalled'"));
  // api_retry 由独立的 per-Query 状态机权威计数；StallTracker 只负责 model/tool 静默。
  check('sdk backend 使用独立 apiRetryStates 且不再让 StallTracker 重复计数',
    sb.includes('const apiRetryStates = new Map<string, ApiRetryState>()') &&
    !sb.includes('consecutiveApiRetries: number'));
  check('SDK api_retry 使用原始 attempt/max_retries 投影权威 count/limit',
    sb.includes('sdkMsg.retry_delay_ms') &&
    sb.includes('sdkMsg.error_status') &&
    sb.includes('const sdkAttempt = typeof sdkMsg.attempt') &&
    sb.includes('const sdkMaxRetries = typeof sdkMsg.max_retries') &&
    sb.includes('retryAttempt: sdkAttempt') &&
    sb.includes('retryLimit: sdkMaxRetries') &&
    sb.includes('retryCount: next.state.retryCount') &&
    sb.includes('retryLimit: sdkMaxRetries ?? next.state.retryLimit'));
  check('Claude Link 不覆盖 Claude Code 的 API 重试上限，仍转发权威 retry 事件',
    !sb.includes('CLAUDE_CODE_MAX_RETRIES') &&
    sb.includes("infoSubtype === 'api_retry'") &&
    sb.includes('retryAttempt: sdkAttempt') &&
    sb.includes('retryLimit: sdkMaxRetries') &&
    sb.includes('forwardTransient(sessionId, mainWindow, sysInfo)'));
  check('SDK max_retries 缺失时仅用本地回退值维持状态机数值完整',
    sb.includes('const API_RETRY_LIMIT_FALLBACK = 10') &&
    !sb.includes('CLAUDE_LINK_MAX_API_RETRIES') &&
    sb.includes('createApiRetryState(API_RETRY_LIMIT_FALLBACK)'));
  check('assistant 事件按真实结果分别收口 exhausted 或 recovery',
    /if \(type === 'assistant'\)[\s\S]*?typeof sdkMsg\.error === 'string'[\s\S]*?finishApiRetryExhausted\(sessionId, mainWindow, entry\.queryInstance\)[\s\S]*?finishApiRetryRecovery\(sessionId, mainWindow, entry\.queryInstance\)[\s\S]*?const cliEvent = convertAssistantMessage\(sdkMsg\)/.test(sb));

  // Task8：模型恢复必须先持久化唯一 retry 终态，再转发恢复该状态的模型活动。
  const assistantBranch = sb.slice(
    sb.indexOf("if (type === 'assistant')"),
    sb.indexOf("if (type === 'user')"),
  );
  const assistantRecoveryIndex = assistantBranch.indexOf('finishApiRetryRecovery(sessionId, mainWindow, entry.queryInstance)');
  // review-v3 High-2：forwardEvent 增加第 4 参 queryInstance（payload 代际），断言同步新签名。
  const assistantForwardIndex = assistantBranch.indexOf('forwardEvent(sessionId, mainWindow, cliEvent, entry.queryInstance)');
  check('assistant 模型活动先写恢复记录再 forwardEvent',
    assistantRecoveryIndex >= 0 && assistantForwardIndex > assistantRecoveryIndex);
  const streamEventBranch = sb.slice(
    sb.indexOf("if (type === 'stream_event')"),
    sb.indexOf("if (type === 'tool_progress')"),
  );
  const streamRecoveryIndex = streamEventBranch.indexOf('finishApiRetryRecovery(sessionId, mainWindow, entry.queryInstance)');
  const streamForwardIndex = streamEventBranch.indexOf('forwardEvent(sessionId, mainWindow, convertStreamEvent(sdkMsg), entry.queryInstance)');
  check('stream_event 模型活动先写恢复记录再 forwardEvent',
    streamRecoveryIndex >= 0 && streamForwardIndex > streamRecoveryIndex);

  const persistRetryStart = sb.indexOf('function persistApiRetryTerminal(');
  const persistRetryEnd = sb.indexOf('function finishApiRetryRecovery(', persistRetryStart);
  const persistRetryBody = sb.slice(persistRetryStart, persistRetryEnd);
  const createMessageIndex = persistRetryBody.indexOf('messageRepo.createMessage');
  const persistedMessageSendIndex = persistRetryBody.indexOf("type: 'persisted_message'");
  const dbCatchIndex = persistRetryBody.indexOf('catch (err)', createMessageIndex);
  const fallbackEventIndex = persistRetryBody.indexOf("type: 'api_retry_terminal'", dbCatchIndex);
  check('retry 终态 DB catch 发送 persisted:false fallback 且不伪造消息 id',
    dbCatchIndex > createMessageIndex && fallbackEventIndex > dbCatchIndex &&
    persistRetryBody.indexOf('persisted: false', fallbackEventIndex) > fallbackEventIndex &&
    !persistRetryBody.slice(dbCatchIndex, persistRetryEnd).includes("id: '"));
  check('retry 终态 DB create 与 persisted_message IPC send 使用独立 try/catch',
    persistedMessageSendIndex > dbCatchIndex &&
    (persistRetryBody.match(/\btry\s*\{/g)?.length ?? 0) >= 3);

  const markDeletedBody = sb.slice(
    sb.indexOf('export function markSessionDeleted('),
    sb.indexOf('function markSessionActive('),
  );
  const deleteEntryBody = sb.slice(
    sb.indexOf('function deleteEntry('),
    sb.indexOf('// ── 读取初始上下文窗口'),
  );
  check('markSessionDeleted 清理当前会话 apiRetryStates',
    markDeletedBody.includes('apiRetryStates.delete(sessionId)'));
  check('markSessionDeleted 清理 CLI session 与 context 诊断缓存',
    markDeletedBody.includes('sessionCliIds.delete(sessionId)') &&
    markDeletedBody.includes('contextRefreshGeneration.delete(sessionId)'));
  check('deleteEntry 仅 current entry 清理 apiRetryStates',
    /if \(isCurrent\) \{[\s\S]*apiRetryStates\.delete\(sessionId\)[\s\S]*\}/.test(deleteEntryBody) &&
    deleteEntryBody.indexOf('apiRetryStates.delete(sessionId)') > deleteEntryBody.indexOf('if (isCurrent)'));

  const retryBranch = sb.slice(
    sb.indexOf("if (infoSubtype === 'api_retry')"),
    sb.indexOf('// 权限询问/拒绝事件', sb.indexOf("if (infoSubtype === 'api_retry')")),
  );
  check('api_retry 排期通知只瞬态转发，不提前持久化、不提前 terminal、不触发网络中断通知',
    retryBranch.includes('forwardTransient(sessionId, mainWindow, sysInfo)') &&
    !retryBranch.includes('persistApiRetryTerminal(') &&
    !retryBranch.includes('notifySessionNetworkInterrupted(') &&
    !retryBranch.includes("killProcess(sessionId, 'api_retry_exhausted', mainWindow)"));
  check('v2-F2：terminal 后迟到 api_retry 丢弃（仅 phase===retrying 才构造/转发瞬态）',
    retryBranch.includes("next.state.phase !== 'retrying'") &&
    retryBranch.indexOf("next.state.phase !== 'retrying'") < retryBranch.indexOf('forwardTransient(sessionId, mainWindow, sysInfo)') &&
    retryBranch.includes('late_api_retry_dropped') &&
    retryBranch.includes('continue'));
  const exhaustedHelperStart = sb.indexOf('function finishApiRetryExhausted(');
  const exhaustedHelperEnd = sb.indexOf('function isToolResultPart(', exhaustedHelperStart);
  const exhaustedHelper = sb.slice(exhaustedHelperStart, exhaustedHelperEnd);
  check('最终真实错误通过 finishApiRetryExhausted 显式收口',
    exhaustedHelper.includes('recordApiRetryExhausted') &&
    exhaustedHelper.includes('persistApiRetryTerminal'));
  check('finishApiRetryExhausted 中 persistApiRetryTerminal 位于网络中断通知之前',
    exhaustedHelper.includes('persistApiRetryTerminal(sessionId, mainWindow, exhausted.state)') &&
    exhaustedHelper.indexOf('notifySessionNetworkInterrupted(mainWindow, sessionId)') >
      exhaustedHelper.indexOf('persistApiRetryTerminal(sessionId, mainWindow, exhausted.state)'));
  check('网络中断通知只出现在 becameExhausted 唯一边沿',
    /if \(exhausted\.becameExhausted\) \{[\s\S]*?persistApiRetryTerminal\(sessionId, mainWindow, exhausted\.state\)[\s\S]*?notifySessionNetworkInterrupted\(mainWindow, sessionId\)/.test(exhaustedHelper) &&
    sb.split('notifySessionNetworkInterrupted(mainWindow, sessionId)').length - 1 === 1);
  check('finishApiRetryRecovery 与 killProcess（user/watchdog/queue）不调用网络中断通知',
    (() => {
      const recoveryFn = sb.slice(sb.indexOf('function finishApiRetryRecovery('), sb.indexOf('function finishApiRetryExhausted('));
      const killFn = sb.slice(sb.indexOf('export function killProcess('), sb.indexOf('export function killAllProcesses('));
      return !recoveryFn.includes('notifySessionNetworkInterrupted(') && !killFn.includes('notifySessionNetworkInterrupted(');
    })());
  check('普通失败 result 不直接触发网络中断通知（仅经 finishApiRetryExhausted 边沿）',
    (() => {
      const resultOnly = sb.slice(sb.indexOf("if (type === 'result')"), sb.indexOf('// 其它 system 子类型 / hook 等暂不转发'));
      return !resultOnly.includes('notifySessionNetworkInterrupted(');
    })());
  const assistantRetryBranch = sb.slice(
    sb.indexOf("if (type === 'assistant')"),
    sb.indexOf("if (type === 'user')"),
  );
  check('assistant error 耗尽、正常 assistant 恢复',
    assistantRetryBranch.includes("typeof sdkMsg.error === 'string'") &&
    assistantRetryBranch.includes('finishApiRetryExhausted') &&
    assistantRetryBranch.includes('finishApiRetryRecovery'));
  const resultRetryBranch = sb.slice(
    sb.indexOf("if (type === 'result')"),
    sb.indexOf('// 其它 system 子类型 / hook 等暂不转发'),
  );
  check('错误 result 触发 exhausted 收口',
    resultRetryBranch.includes('sdkMsg.is_error === true') &&
    resultRetryBranch.includes('finishApiRetryExhausted'));

  // Task4：回复中断来源必须显式传递，只有用户从聊天页停止才写 user_stopped 终态。
  const ipcHandlers = readRel('src/main/ipc-handlers.ts');
  const queueEngine = readRel('src/main/modules/task-queue-engine.ts');
  check('sdk-backend 导出完整 KillReason 联合',
    /export type KillReason\s*=\s*[\s\S]{0,200}'user'[\s\S]{0,200}'api_retry_exhausted'[\s\S]{0,200}'watchdog'[\s\S]{0,200}'queue'[\s\S]{0,200}'session_cleanup'/.test(sb));
  check('CHAT_ABORT 以 user reason 且携带 mainWindowRef 中断',
    ipcHandlers.includes("killProcess(sessionId, 'user', mainWindowRef)"));
  check('删除会话以 session_cleanup reason 中断',
    ipcHandlers.includes("killProcess(id, 'session_cleanup')"));
  check('任务队列以 queue reason 中断（F5：带 mainWindow）',
    queueEngine.includes("killProcess(sessionId, 'queue', mainWindow)"));
  const killProcessBody = sb.slice(
    sb.indexOf('export function killProcess('),
    sb.indexOf('export function killAllProcesses()'),
  );
  const userStopIndex = killProcessBody.indexOf('recordApiRetryUserStop');
  const persistUserStopIndex = killProcessBody.indexOf('persistApiRetryTerminal');
  const cancelInteractionsIndex = killProcessBody.indexOf('cancelInteractionsForSession');
  const retryStateDeleteIndex = killProcessBody.lastIndexOf('apiRetryStates.delete(sessionId)');
  const userStopBranch = killProcessBody.slice(
    killProcessBody.indexOf("if (reason === 'user' && mainWindow)"),
    cancelInteractionsIndex,
  );
  check('用户停止在取消交互和状态删除前生成并持久化 API retry 终态',
    userStopBranch.includes('recordApiRetryUserStop') &&
    userStopBranch.includes('persistApiRetryTerminal') &&
    userStopIndex >= 0 && persistUserStopIndex > userStopIndex &&
    cancelInteractionsIndex > persistUserStopIndex &&
    retryStateDeleteIndex > cancelInteractionsIndex);
  check('killProcess 仅 user 分支生成 API retry 用户停止终态',
    killProcessBody.match(/recordApiRetryUserStop/g)?.length === 1 &&
    userStopBranch.includes('recordApiRetryUserStop'));
  check('sdk-backend touchActivityFromEvent 识别 api_retry 子类型', sb.includes("subtype === 'api_retry'"));
  check('sdk-backend 读 CLAUDE_LINK_STALL_TOOL_HARD_MS', sb.includes('CLAUDE_LINK_STALL_TOOL_HARD_MS'));
  check('sdk-backend 不读 CLAUDE_LINK_MAX_API_RETRIES', !sb.includes('CLAUDE_LINK_MAX_API_RETRIES'));
  check('sdk-backend toolHardAbortMs 接入 STALL_THRESHOLDS', sb.includes('toolHardAbortMs'));
  check('sdk-backend aborting entry 不算 active', sb.includes('state: \'pending\' | \'running\' | \'aborting\' | \'finished\'') && sb.includes('isEntryActive') && sb.includes("entry.state !== 'aborting'"));
  check('sdk-backend 使用子 Agent tool_use 判断', sb.includes('isSubAgentToolUse(part)'));
  check('process-kind 暴露 isSubAgentToolUse', pk.includes('export function isSubAgentToolUse'));
  check('session-store 含 stalledInfo + activeStalledInfo', ss.includes('stalledInfo') && ss.includes('activeStalledInfo'));
  check('use-chat 处理当前/后台 stalled + retryLastTurn', uc.includes("case 'stalled'") && uc.includes('applyStalledEvent(store, sid, event)') && uc.includes('retryLastTurn'));
  check('StalledBanner 三动作', banner.includes('继续等待') && banner.includes('重试') && banner.includes('中断'));
  check('MessageList 挂载 StalledBanner 且 stalledInfo 可显形', ml.includes('StalledBanner') && ml.includes('activeStalledInfo'));
  check('selftest 串联 tdd-stall-watchdog-verify', pkg.includes('tdd-stall-watchdog-verify.ts'));

  // 静默拒绝根因修复：权限交互 pending 期间必须暂停该会话的 stall 判定，
  // 否则用户在弹窗停留过久会被 toolHardAbortMs 硬杀 → cancelInteractionsForSession
  // 静默 cancel → 中性 deny → is_error tool_result 污染 transcript。
  const ip = readRel('src/main/modules/interaction-prompts.ts');
  check('interaction-prompts 暴露 hasPendingInteractionForSession',
    ip.includes('export function hasPendingInteractionForSession'));
  check('sdk-backend import hasPendingInteractionForSession',
    sb.includes('hasPendingInteractionForSession') && sb.includes("import { cancelInteractionsForSession, requestInteraction, hasPendingInteractionForSession } from './interaction-prompts'"));
  check('看门狗 tick 在 pending 交互时暂停 stall 判定并刷新 lastActivityAt',
    /hasPendingInteractionForSession\(sessionId\)\s*\)\s*\{[\s\S]*?t\.lastActivityAt = now;[\s\S]*?t\.stalledSince = null;[\s\S]*?t\.stallNotified = false;[\s\S]*?continue;/.test(sb));
  check('pending 交互暂停位于 api_retry 暂停之后（两路暂停并列，不遮蔽 retry 逻辑）',
    sb.indexOf('shouldPauseStallWatchdog(apiRetryStates.get(sessionId), now)') <
    sb.indexOf('hasPendingInteractionForSession(sessionId)'));
}

console.log('\n=== 39) 上下文窗口 fallback + fable 映射契约 ===');
{
  // A. fable 映射双向（此前为测试盲区）
  let adv = setModelMappingInAdvancedJson('{}', 'fable', 'glm-5.2');
  let parsed = JSON.parse(adv);
  check('fable 映射写入 env.ANTHROPIC_DEFAULT_FABLE_MODEL', parsed.env?.ANTHROPIC_DEFAULT_FABLE_MODEL === 'glm-5.2', adv);
  const maps = extractModelMappings(adv);
  check('extractModelMappings 反提取 fable', maps.fable === 'glm-5.2', JSON.stringify(maps));
  check('resolveAliasToActualModel(fable) 解析为实际模型', resolveAliasToActualModel('fable', adv) === 'glm-5.2', adv);

  // B. fable 默认模型推导（修复前：只配 fable 时 defaultModel 丢空）
  check('只配 fable 时 resolveDefaultModel=fable', resolveDefaultModel(adv) === 'fable', resolveDefaultModel(adv));
  const onlyFable = JSON.stringify({ env: { ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-5.2' } }, null, 2);
  const pf = parseClaudeSettings(onlyFable);
  check('parseClaudeSettings 只配 fable → defaultModel=fable（不再丢空）', pf.defaultModel === 'fable', `got ${pf.defaultModel}`);
  check('parseClaudeSettings 保留 fable 映射在 advancedJson', pf.advancedJson.includes('ANTHROPIC_DEFAULT_FABLE_MODEL'));

  // C. contextWindowByAlias 按别名双向（setContextWindowInAdvancedJson ↔ parseClaudeSettings peek）
  const advSonnet = setContextWindowInAdvancedJson('{}', 'sonnet', 1000000);
  check('setContextWindowInAdvancedJson(sonnet,1M) 写 env.CLAUDE_LINK_CONTEXT_WINDOW_SONNET',
    JSON.parse(advSonnet).env?.CLAUDE_LINK_CONTEXT_WINDOW_SONNET === '1000000', advSonnet);
  const advCleared = setContextWindowInAdvancedJson(advSonnet, 'sonnet', null);
  check('setContextWindowInAdvancedJson(sonnet,null) 删除该 key',
    JSON.parse(advCleared).env?.CLAUDE_LINK_CONTEXT_WINDOW_SONNET === undefined, advCleared);
  const advTwo = setContextWindowInAdvancedJson(setContextWindowInAdvancedJson('{}', 'sonnet', 200000), 'fable', 1000000);
  check('sonnet 与 fable 各自独立写入', JSON.parse(advTwo).env?.CLAUDE_LINK_CONTEXT_WINDOW_SONNET === '200000' && JSON.parse(advTwo).env?.CLAUDE_LINK_CONTEXT_WINDOW_FABLE === '1000000', advTwo);
  const peeked = parseClaudeSettings(JSON.stringify({ env: { CLAUDE_LINK_CONTEXT_WINDOW_HAIKU: '64000' } }, null, 2));
  check('parseClaudeSettings 反向回填 contextWindowByAlias.haiku=64000', peeked.contextWindowByAlias?.haiku === 64000, JSON.stringify(peeked.contextWindowByAlias));
  check('parseClaudeSettings 未设别名不出现在 contextWindowByAlias', peeked.contextWindowByAlias?.sonnet === undefined);

  // D. lookupModelWindow 内置表（最长前缀匹配 + 标准化）
  check('lookupModelWindow(glm-5.2)=1M', lookupModelWindow('glm-5.2') === 1000000, String(lookupModelWindow('glm-5.2')));
  check('lookupModelWindow 大小写/后缀容错(GLM-5.2-1m)=1M', lookupModelWindow('GLM-5.2-1m') === 1000000);
  check('lookupModelWindow(claude-fable-5)=1M', lookupModelWindow('claude-fable-5') === 1000000);
  check('lookupModelWindow(claude-sonnet-4-6)=200k', lookupModelWindow('claude-sonnet-4-6') === 200000);
  check('lookupModelWindow(deepseek-chat)=64k', lookupModelWindow('deepseek-chat') === 64000);
  check('lookupModelWindow(未知模型)=null', lookupModelWindow('some-unknown-model') === null);
  check('lookupModelWindow(null/空)=null', lookupModelWindow(null) === null && lookupModelWindow('') === null);

  // E. resolveContextWindow 优先级（用户别名设置 > lastContextWindow > 200k）
  check('用户设置优先于 lastContextWindow', resolveContextWindow({ lastContextWindow: 500000, alias: 'sonnet', contextWindowByAlias: { sonnet: 1000000 } }) === 1000000);
  check('无用户设置 走 lastContextWindow', resolveContextWindow({ lastContextWindow: 500000, alias: 'sonnet', contextWindowByAlias: {} }) === 500000);
  check('无用户设置/无 lastContextWindow → 200k', resolveContextWindow({ alias: 'sonnet', contextWindowByAlias: {} }) === 200000);
  check('全无 → 200000 兜底', resolveContextWindow({}) === 200000);
  check('别名未在设置中 走 lastContextWindow', resolveContextWindow({ lastContextWindow: 300000, alias: 'sonnet', contextWindowByAlias: { fable: 1000000 } }) === 300000);
  check('alias 为 null 但有 lastContextWindow → lastContextWindow', resolveContextWindow({ lastContextWindow: 400000, alias: null, contextWindowByAlias: { sonnet: 1000000 } }) === 400000);
  check('alias 为 null 且无 lastContextWindow → 200k', resolveContextWindow({ alias: null, contextWindowByAlias: { sonnet: 1000000 } }) === 200000);

  // F. resolveContextWindowForSession（主进程用：真实模型名按 modelMappings 反查别名）
  const advWithMap = JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2', CLAUDE_LINK_CONTEXT_WINDOW_SONNET: '1000000' } }, null, 2);
  check('别名直传命中', resolveContextWindowForSession({ aliasOrModel: 'sonnet', advancedJson: advWithMap, contextWindowByAlias: { sonnet: 1000000 } }) === 1000000);
  check('真实模型名反查别名命中(glm-5.2→sonnet)', resolveContextWindowForSession({ aliasOrModel: 'glm-5.2', advancedJson: advWithMap, contextWindowByAlias: { sonnet: 1000000 } }) === 1000000);
  check('未知真实模型名 → 200k', resolveContextWindowForSession({ aliasOrModel: 'unknown-model', advancedJson: advWithMap, contextWindowByAlias: { sonnet: 1000000 } }) === 200000);
  check('无 aliasOrModel → 200k', resolveContextWindowForSession({ aliasOrModel: null, advancedJson: advWithMap, contextWindowByAlias: { sonnet: 1000000 } }) === 200000);

  // G. lookupUserContextWindow（注入 MAX_CONTEXT_TOKENS 用：只返用户显式配置，未命中返 undefined）
  check('lookupUserContextWindow 别名直传命中', lookupUserContextWindow({ aliasOrModel: 'sonnet', advancedJson: advWithMap, contextWindowByAlias: { sonnet: 1000000 } }) === 1000000);
  check('lookupUserContextWindow 真实模型名反查命中(glm-5.2→sonnet)', lookupUserContextWindow({ aliasOrModel: 'glm-5.2', advancedJson: advWithMap, contextWindowByAlias: { sonnet: 1000000 } }) === 1000000);
  check('lookupUserContextWindow 未配置别名 → undefined（不注入，避免降级）', lookupUserContextWindow({ aliasOrModel: 'haiku', advancedJson: advWithMap, contextWindowByAlias: { sonnet: 1000000 } }) === undefined);
  check('lookupUserContextWindow 未知真实模型名 → undefined', lookupUserContextWindow({ aliasOrModel: 'unknown-model', advancedJson: advWithMap, contextWindowByAlias: { sonnet: 1000000 } }) === undefined);
  check('lookupUserContextWindow 无 aliasOrModel → undefined', lookupUserContextWindow({ aliasOrModel: null, advancedJson: advWithMap, contextWindowByAlias: { sonnet: 1000000 } }) === undefined);
  check('lookupUserContextWindow 空配置 → undefined', lookupUserContextWindow({ aliasOrModel: 'sonnet', advancedJson: advWithMap, contextWindowByAlias: {} }) === undefined);
  // [1m] 后缀真实模型名反查（用户实际配置 sonnet→glm-5.2[1m]）
  const advWith1m = JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2[1m]', CLAUDE_LINK_CONTEXT_WINDOW_SONNET: '1000000' } }, null, 2);
  check('lookupUserContextWindow [1m]后缀真实名反查命中(glm-5.2[1m]→sonnet)', lookupUserContextWindow({ aliasOrModel: 'glm-5.2[1m]', advancedJson: advWith1m, contextWindowByAlias: { sonnet: 1000000 } }) === 1000000);
}

console.log('\n=== 40) UI 简化（r9 定版）：连接页=供应商库 + 会话内不调字号 ===');
{
  const cp = readRel('src/renderer/pages/ConfigPage.vue');
  const st = readRel('src/renderer/components/chat/SessionToolbar.vue');
  const pm = readRel('src/renderer/components/providers/ProviderManager.vue');
  // 连接页换成供应商可选项库（ProviderManager）；旧别名映射组件已删除。
  check('ConfigPage 连接页挂载 ProviderManager', cp.includes('<ProviderManager />'));
  const cpTemplate = cp.slice(cp.indexOf('<template>')).replace(/<!--[\s\S]*?-->/g, '');
  check('顶部测试连接已删（收敛到模型行内「测试」）', !cpTemplate.includes('测试连接'));
  check('自动检测入口已从多供应商设置页移除', !cpTemplate.includes('自动检测配置') && !cp.includes('handleAutoDetect'));
  check('自动保存成功后才更新快照，失败可重试', /try \{\s*await store\.saveConfig\(\);\s*lastSavedSnapshot = configSnapshot\(\);/.test(cp) && !/lastSavedSnapshot = configSnapshot\(\); \/\/ 以/.test(cp));
  check('保存状态与 tabs 同行显示在右侧', cpTemplate.includes('tabs-row') && /tabs-row[\s\S]*tabs[\s\S]*save-badge/.test(cpTemplate));
  check('保存成功文案为保存成功', cpTemplate.includes("'保存成功'") || cp.includes("=== 'saved' ? '保存成功'"));
  check('高级 JSON 编辑器已删（多供应商化，advancedJson 由自动检测维护）', !cpTemplate.includes('高级 JSON'));
  check('家具块（横幅/存储/操作条）对齐同宽列（--col-w 居中）', cp.includes('.autodetect-bar {') && /banner,\s*\n\s*\.toast,/.test(cp) && cp.includes('max-width: 100%'));
  check('ModelMappingInputs 组件已删除（别名映射 UI 退场）', readRel('src/renderer/components/config/ModelMappingInputs.vue') === '');
  check('ModelSelector 组件已删除（会话选择器换级联）', readRel('src/renderer/components/chat/ModelSelector.vue') === '');
  // r6-r9 版式契约：同宽一列 + 面板内部滚动。
  check('标题/标签/工作区同宽一列（--col-w 居中）', cp.includes('width: var(--col-w)') && cp.includes('margin-inline: auto'));
  check('行为/外观共用 solo 卡 + 内部滚动', cp.includes('workbench--solo') && cp.includes('.solo-card .mscroll'));
  check('设置页不再整页滚动（面板内部滚动）', cp.includes('display: flex') && cp.includes('overflow: hidden') && !cp.includes('overflow-y: auto;\n}'));
  // 库无选用语义（r3）：无「使用中/设为当前使用/默认模型」。
  check('ProviderManager 模板无「使用中」徽章', !pm.slice(pm.indexOf('<template>')).includes('使用中'));
  check('ProviderManager 无「设为当前使用」', !pm.includes('设为当前使用'));
  check('ProviderManager 有职责说明表尾', pm.includes('设置页只维护可选的供应商与模型'));
  check('SessionToolbar 不再导入 FONT_SCALE_SIZES', !st.includes('FONT_SCALE_SIZES'));
  check('SessionToolbar 不再含会话内字号控件', !st.includes('onFontScaleChange') && !st.includes('<span class="ctl__label">字号</span>'));
}

console.log('\n=== 41) DB 时间规范化 normalizeDbTime（治子 Agent 计时 8h 时区偏移）===');
{
  const mr = readRel('src/main/database/repositories/message-repo.ts');
  const tr = readRel('src/main/database/repositories/task-repo.ts');
  const sr = readRel('src/main/database/repositories/session-repo.ts');
  const ih = readRel('src/main/database/repositories/interaction-history-repo.ts');
  // 行为测试（shared/time 纯函数，无 db 依赖，可直接 import）
  check('normalizeDbTime 无 Z SQLite datetime → 补 Z', normalizeDbTime('2026-07-03 04:43:00') === '2026-07-03T04:43:00Z');
  check('normalizeDbTime 已带 Z 原样', normalizeDbTime('2026-07-03T04:43:00.000Z') === '2026-07-03T04:43:00.000Z');
  check('normalizeDbTime 带毫秒补 Z', normalizeDbTime('2026-07-03 04:43:00.123') === '2026-07-03T04:43:00.123Z');
  check('normalizeDbTime null 原样返回', normalizeDbTime(null) === null);
  check('normalizeDbTime 已带偏移原样', normalizeDbTime('2026-07-03T04:43:00+08:00') === '2026-07-03T04:43:00+08:00');
  // 各 repo 读回时间字段统一走 normalizeDbTime
  check('message-repo toMessage 用 normalizeDbTime', /createdAt:\s*normalizeDbTime\(row\.created_at\)/.test(mr));
  check('task-repo toTask 用 normalizeDbTime', tr.includes('normalizeDbTime(row.started_at)') && tr.includes('normalizeDbTime(row.completed_at)'));
  check('session-repo toSession 用 normalizeDbTime', sr.includes('normalizeDbTime(row.created_at)') && sr.includes('normalizeDbTime(row.last_context_updated_at)'));
  check('interaction-history toEntry 用 normalizeDbTime', /createdAt:\s*normalizeDbTime\(row\.created_at\)/.test(ih));
}

console.log('\n=== 42) contextStats getter 化（切模型/改设置即时重算上下文窗口）===');
{
  const ss = readRel('src/renderer/stores/session-store.ts');
  // 防回归：contextStats 不再是写入式 state，而是派生 getter。原先 updateActiveSessionModelOverride
  // 切模型不重算 contextStats，ContextButton「最大上下文」停在旧模型窗口，要等下一回合 CONTEXT_UPDATE 才刷新。
  check('contextStats 已从 state 移除（不再写入式快照）', !/contextStats:\s*null as/.test(ss));
  check('contextStats 改为 getter（派生 windowSize/ratio）', /getters:\s*\{[\s\S]*?\bcontextStats\(state\)/.test(ss));
  // review-v2 证据缺口 3：turn usage 与当前窗口统一收进 canonicalContext，删除旧 contextUsage state。
  check('canonicalContext 单一真相源（替代旧 contextUsage state）', ss.includes('canonicalContext: null as'));
  check('新增 contextLastWindow state（SDK 真实窗口）', ss.includes('contextLastWindow: null as'));
  check('switchSession/onContextUpdate 不再直接赋值 contextStats', !/this\.contextStats\s*=/.test(ss));
  check('switchSession 改写 contextLastWindow', ss.includes('this.contextLastWindow = session.lastContextWindow'));
  check('onContextUpdate 改写 contextLastWindow（payload.windowSize）', ss.includes('this.contextLastWindow = payload.windowSize'));
  check('getter 用 modelOverride||model 作 alias', /contextStats\(state\)[\s\S]*?modelOverride\s*\|\|\s*state\.activeSession\.model/.test(ss));
  check('getter 调 resolveContextWindow', /contextStats\(state\)[\s\S]*?resolveContextWindow\(/.test(ss));
  check('getter 读 configStore.contextWindowByAlias', /contextStats\(state\)[\s\S]*?useConfigStore\(\)\.config\.contextWindowByAlias/.test(ss));
}

console.log('\n=== 43) 浅色主题系统契约（openhanako 真实浅色色板替代深色）===');
{
  // —— 色板数量与结构 ——
  check('色板共 9 套（替代旧 11 套深色）', THEME_PALETTES.length === 9, `实际 ${THEME_PALETTES.length}`);
  check('全部 isDark=false（纯浅色）', THEME_PALETTES.every((p) => p.isDark === false));
  check('默认色板 id 为 warm-paper', DEFAULT_THEME_PALETTE_ID === 'warm-paper', `实际 ${DEFAULT_THEME_PALETTE_ID}`);
  check('第一套色板 id 为 warm-paper', THEME_PALETTES[0]?.id === 'warm-paper');
  check('无旧深色 default-dark 残留', !THEME_PALETTES.some((p) => p.id === 'default-dark'));

  // —— onAccent 新字段 ——
  check('每套色板都有 onAccent 字段', THEME_PALETTES.every((p) => typeof p.colors.onAccent === 'string'));
  check('onAccent 按 accent 亮度选黑/白（中亮度 accent 用深色文字过 AA）', THEME_PALETTES.every((p) => {
    const midAccent = ['grass-aroma', 'contemplation', 'absolutely'];
    return midAccent.includes(p.id) ? p.colors.onAccent === '#1A1A1A' : p.colors.onAccent === '#FFFFFF';
  }));

  // —— 色值原样搬运自 openhanako 源码（抽查 3 套用户指定的）——
  const wp = THEME_PALETTES.find((p) => p.id === 'warm-paper');
  check('暖纸 bg=#F8F4ED', wp?.colors.bg === '#F8F4ED', `实际 ${wp?.colors.bg}`);
  check('暖纸 panel=#F4F0EA', wp?.colors.panel === '#F4F0EA');
  check('暖纸 panelSoft=#FCFAF5', wp?.colors.panelSoft === '#FCFAF5');
  check('暖纸 accent=#537D96 钢蓝', wp?.colors.accent === '#537D96');
  check('暖纸 danger=#8B3A3A', wp?.colors.danger === '#8B3A3A');

  const ga = THEME_PALETTES.find((p) => p.id === 'grass-aroma');
  check('草香 bg=#F5F8F3', ga?.colors.bg === '#F5F8F3');
  check('草香 accent=#5BA88C 鼠尾草绿', ga?.colors.accent === '#5BA88C');

  const co = THEME_PALETTES.find((p) => p.id === 'coral');
  check('珊瑚 bg=#FDF6EC', co?.colors.bg === '#FDF6EC');
  check('珊瑚 accent=#1A3049 墨蓝', co?.colors.accent === '#1A3049');

  // —— variables.css 浅色化 ——
  const vars = readRel('src/renderer/assets/styles/variables.css');
  check('variables.css color-scheme 为 light', /color-scheme:\s*light/.test(vars));
  check('variables.css 无 color-scheme:dark', !/color-scheme:\s*dark/.test(vars));
  check('variables.css 默认 bg 为浅色暖纸', /--color-bg:\s*#F8F4ED/i.test(vars));
  check('影阶 elevation-1 浅色化（alpha<0.15）', /--elevation-1:\s*0 1px 2px rgba\(0,\s*0,\s*0,\s*0\.0[0-9]\)/.test(vars));
  check('ring-light 改为底部暗边（非白色顶光）', /--ring-light:\s*inset 0 -1px 0/.test(vars));

  // —— 主题注入逻辑（v3 抽到共享 apply-theme.ts，App.vue 复用）——
  const app = readRel('src/renderer/App.vue');
  const applyTheme = readRel('src/renderer/utils/apply-theme.ts');
  check('apply-theme 注入 onAccent（App.vue 复用）', applyTheme.includes("setProperty('--color-on-accent'") && app.includes('applyThemePalette'));
  check('apply-theme 绑定 colorScheme 到 isDark', /colorScheme\s*=\s*palette\.isDark/.test(applyTheme));

  // —— ConfigPage.vue 注入逻辑 ——
  const cp = readRel('src/renderer/pages/ConfigPage.vue');
  check('ConfigPage.vue 注入 onAccent', cp.includes("setProperty('--color-on-accent'"));
  check('ConfigPage.vue 绑定 colorScheme 到 isDark', /colorScheme\s*=\s*palette\.isDark/.test(cp));

  // —— main.css 代码块浅色适配 ——
  const mc = readRel('src/renderer/assets/styles/main.css');
  check('main.css 代码块 inset 阴影浅色化（alpha≤0.1）', /inset 0 1px 2px rgba\(0,\s*0,\s*0,\s*0\.0[0-9]\)/.test(mc));

  // —— 状态色 token 化（P1-1）——
  check('variables.css 有 8 个状态色 token', /--color-warn:/.test(vars) && /--color-warn-strong:/.test(vars) && /--color-fail:/.test(vars) && /--color-fail-strong:/.test(vars) && /--color-info:/.test(vars) && /--color-info-strong:/.test(vars) && /--color-success:/.test(vars) && /--color-success-strong:/.test(vars));

  // —— hljs 语法高亮主题（P0-3）——
  check('main.css 有 hljs 浅色主题', mc.includes('.hljs-keyword') && mc.includes('.hljs-string') && mc.includes('.hljs-comment'));

  // —— 全局浅色适配（P2-1）——
  check('main.css 有 ::selection 浅色样式', /::selection/.test(mc));
  check('main.css 有 ::placeholder 样式', /::placeholder/.test(mc));
  check('main.css 有 Markdown 链接样式', /\.markdown-body a/.test(mc));

  // —— 交互弹窗凹陷深底清零（P0-2）——
  const id = readRel('src/renderer/components/chat/InteractionDetails.vue');
  const ip = readRel('src/renderer/components/chat/InteractionPrompt.vue');
  const mm = readRel('src/renderer/components/config/ModelMappingInputs.vue');
  check('InteractionDetails 无 rgba(0,0,0,≥0.14) 背景', !/rgba\(0,\s*0,\s*0,\s*0\.(1[4-9]|[2-9])/.test(id));
  check('InteractionPrompt 无 rgba(0,0,0,≥0.14) 背景', !/rgba\(0,\s*0,\s*0,\s*0\.(1[4-9]|[2-9])/.test(ip));
  check('ModelMappingInputs 无 rgba(0,0,0,≥0.14) 背景', !/rgba\(0,\s*0,\s*0,\s*0\.(1[4-9]|[2-9])/.test(mm));

  // —— 复核报告修复（P1-A/B 选中/聚焦态白字 + P2-D 遮罩 + P2-E 历史底 + textMuted 加深）——
  const iol = readRel('src/renderer/components/chat/InteractionOptionList.vue');
  check('InteractionOptionList 选中态标题用 text（非白字/on-accent，浅底可达性）', /--selected.*?content strong\s*\{[^}]*color:\s*var\(--color-text\)/.test(iol));
  check('InteractionOptionList 聚焦态标题用 accent-strong（非 #fff，键盘导航可见）', /--focused.*?content strong\s*\{[^}]*color:\s*var\(--color-accent-strong\)/.test(iol));
  check('warm-paper textMuted 已加深（#6A6C70 非 #8E9196）', wp?.colors.textMuted === '#6A6C70');
  const it = readRel('src/renderer/assets/styles/interaction-tokens.css');
  check('interaction-history-bg 走 token（非 rgba 黑底）', !/rgba\(0,\s*0,\s*0,\s*0\.1[2-9]/.test(it));
  // TestConnectionModal 已删除（弹框测试退场，行内测试为唯一入口）：
  // interaction-overlay-bg token 仍由 InteractionPrompt 等使用，此处不再断言已删组件。
}

console.log('\n=== 44) 右侧活动栏方案 B：图标轨 + 总览/筛选 + 状态指标网格 ===');
{
  const ss = readRel('src/renderer/stores/session-store.ts');
  const tqp = readRel('src/renderer/components/task/TaskQueuePanel.vue');
  const al = readRel('src/renderer/components/layout/AppLayout.vue');

  // —— 状态字段演进：rightTab 扩展 'all' 默认（保留字段名与旧字面量，既有契约不破）——
  check('rightTab 默认 all（四类总览同屏）', ss.includes("rightTab: 'all'"));
  check('rightTab 枚举五态齐全', ss.includes("'all'") && ss.includes("'queue'") && ss.includes("'subagent'") && ss.includes("'background'") && ss.includes("'changes'"));
  check('setRightTab 入参含 all', /setRightTab\([^)]*'all'/.test(ss));
  check('保留 focusSubAgent（主流程锚点跳子Agent）', ss.includes('focusSubAgent'));

  // —— 图标轨：SVG stroke 结构图标 + badge + 激活态 ——
  check('图标轨容器与按钮', tqp.includes('class="rail"') && tqp.includes('rail__btn'));
  check('轨用 SVG stroke 图标（禁止 emoji 作结构图标）', tqp.includes('<svg') && tqp.includes('stroke="currentColor"'));
  check('轨按钮 aria-pressed 反映筛选态', tqp.includes(':aria-pressed'));
  check('轨 badge 计数', tqp.includes('rail__badge'));

  // —— 筛选交互：点单类、再点同类回 all、清除筛选 pill ——
  check('筛选切换（再点同类回 all）', tqp.includes('setFilter') && tqp.includes("setFilter('all')"));
  check('清除筛选 pill 仅非总览显示', tqp.includes('clear-pill') && tqp.includes('v-if="!isAll"'));
  check('总览态判定 isAll', tqp.includes('isAll'));

  // —— 状态指标条：2×2 网格，禁 · 串句换行 ——
  check('指标网格两列', tqp.includes('status-metrics') && /grid-template-columns:\s*repeat\(2/.test(tqp));
  check('指标格标签/值分行 + tabular-nums', tqp.includes('status-metric__label') && tqp.includes('status-metric__value') && tqp.includes('tabular-nums'));

  // —— 排队 composer 仅 queue 筛选可见（总览/其他类不出现）——
  check('排队控制条/composer 仅 queue 可见', tqp.includes("v-if=\"sessionStore.rightTab === 'queue'\""));
  check('总览排队 section 渲染任务列表（isAll 或 queue）', tqp.includes("isAll || sessionStore.rightTab === 'queue'"));

  // —— 保留既有契约：后台/改动 section 字面量与组件 ——
  check('后台 section 保留 rightTab === background + backgroundTaskList', tqp.includes("rightTab === 'background'") && tqp.includes('backgroundTaskList'));
  check('改动 section 保留 rightTab === changes + ChangesPanel', tqp.includes("rightTab === 'changes'") && tqp.includes('<ChangesPanel'));

  // —— 右侧栏默认宽度补偿图标轨（320→340）——
  check('AppLayout 右侧栏默认 340', /taskWidth\s*=\s*ref\(340\)/.test(al));
}

console.log('\n=== 45) 附件 IPC + preload 桥（Task 3）：通道/方法/ChatSendPayload/安全边界 ===');
{
  const ipc = readRel('src/shared/types/ipc.ts');
  const api = readRel('src/preload/api.ts');
  const handlers = readRel('src/main/ipc-handlers.ts');

  // 通道与入参类型
  check('4 个附件通道', ipc.includes('ATTACHMENT_PICK') && ipc.includes('ATTACHMENT_STAGE_BYTES') && ipc.includes('ATTACHMENT_PREVIEW') && ipc.includes('ATTACHMENT_REMOVE_DRAFT'));
  check('附件入参类型', ipc.includes('StageAttachmentBytesInput') && ipc.includes('AttachmentPreviewRequest'));

  // preload 暴露
  check('preload pickAttachments', api.includes('pickAttachments:'));
  check('preload stageAttachmentBytes', api.includes('stageAttachmentBytes:'));
  check('preload getAttachmentPreview', api.includes('getAttachmentPreview:'));
  check('preload removeDraftAttachment', api.includes('removeDraftAttachment:'));
  check('sendMessage 接收 ChatSendPayload', /sendMessage:\s*\(sessionId:\s*string,\s*payload:\s*ChatSendPayload\)/.test(api));
  check('addTask 接收 ChatSendPayload', /addTask:\s*\(sessionId:\s*string,\s*payload:\s*ChatSendPayload\)/.test(api));
  check('queueUserMessage 接收 ChatSendPayload', /queueUserMessage:\s*\(sessionId:\s*string,\s*payload:\s*ChatSendPayload\)/.test(api));

  // 三发送 handler 共用形状 + 归属/draft 校验
  check('三发送 handler 形状校验', (handlers.match(/validateChatSendPayloadShape\(payload\)/g) || []).length >= 3);
  check('三发送 handler 归属+draft 校验', (handlers.match(/assertAttachmentsReadyForSend\(sessionId, payload\.attachmentIds\)/g) || []).length >= 3);

  // 安全边界：主进程读文件、不泄露路径、魔数探测、受控预览/移除
  check('ATTACHMENT_PICK 用主进程 dialog', handlers.includes('dialog.showOpenDialog'));
  check('只取 basename 不泄露完整路径', /path\.basename\(filePath\)/.test(handlers));
  check('据魔数探测真实图片格式', handlers.includes('detectDirectImageFormat(bytes)'));
  check('preview/remove 作用于受控附件', handlers.includes('getAttachmentPreview(request)') && handlers.includes('removeDraftAttachment(sessionId, attachmentId)'));
}

console.log('\n=== 46) Claude 计划任务状态（TodoWrite / Task 工具）：类型/repo/IPC/store/UI 契约 ===');
{
  const plan = readRel('src/shared/types/claude-plan.ts');
  const repo = readRel('src/main/database/repositories/claude-plan-repo.ts');
  const cli = readRel('src/shared/types/cli.ts');
  const ipc = readRel('src/shared/types/ipc.ts');
  const api = readRel('src/preload/api.ts');
  const handlers = readRel('src/main/ipc-handlers.ts');
  const backend = readRel('src/main/modules/sdk-backend.ts');
  const store = readRel('src/renderer/stores/claude-plan-store.ts');
  const useChat = readRel('src/renderer/composables/use-chat.ts');
  const sessionStore = readRel('src/renderer/stores/session-store.ts');
  const tqPanel = readRel('src/renderer/components/task/TaskQueuePanel.vue');
  const planCard = readRel('src/renderer/components/task/ClaudePlanCard.vue');
  const chatPage = readRel('src/renderer/pages/ChatPage.vue');
  const migrations = readRel('src/main/database/migrations.ts');

  // 类型定义
  check('claude-plan.ts 定义 ClaudePlanState', plan.includes('ClaudePlanState'));
  check('claude-plan.ts 定义 ClaudeTodoItem', plan.includes('ClaudeTodoItem'));
  check('claude-plan.ts 定义 ClaudePlanTask', plan.includes('ClaudePlanTask'));
  check('claude-plan.ts 定义 ClaudePlanEvent', plan.includes('ClaudePlanEvent'));
  check('claude-plan.ts 纯解析 parseTodoWriteInput', plan.includes('export function parseTodoWriteInput'));
  check('claude-plan.ts 纯解析 parseTaskCreateOutput', plan.includes('export function parseTaskCreateOutput'));
  check('claude-plan.ts 纯解析 parseTaskUpdateInput', plan.includes('export function parseTaskUpdateInput'));
  check('claude-plan.ts 纯解析 parseTaskListOutput', plan.includes('export function parseTaskListOutput'));
  check('claude-plan.ts task_updated 解析 parseTaskUpdatedPatch', plan.includes('export function parseTaskUpdatedPatch'));
  check('claude-plan.ts 纯 reducer applyPlanEvent', plan.includes('export function applyPlanEvent'));
  check('claude-plan.ts 纯 reducer createEmptyPlanState', plan.includes('export function createEmptyPlanState'));
  // F7: add/merge 语义类型
  check('claude-plan.ts 定义 ClaudePlanTaskPatch（F7）', plan.includes('ClaudePlanTaskPatch'));
  check('claude-plan.ts 定义 TaskListEntry（F4）', plan.includes('TaskListEntry'));
  check('claude-plan.ts 有 applyTaskPatch helper（F7 add/merge）', plan.includes('export function applyTaskPatch'));
  check('claude-plan.ts tasks_merge 操作（替代 tasks_replace）', plan.includes("operation: 'tasks_merge'"));
  check('claude-plan.ts 无 tasks_replace 操作（已移除）', !plan.includes("operation: 'tasks_replace'"));

  // CLI 事件类型
  check('cli.ts 有 ClaudePlanCliEvent', cli.includes('ClaudePlanCliEvent'));
  check('cli.ts ClaudePlanCliEvent 在 CliEvent 联合中', cli.includes('| ClaudePlanCliEvent'));

  // DB migration + repo
  check('migrations.ts 有 claude_plan_state 表', migrations.includes('claude_plan_state'));
  check('migrations.ts 版本升为 9（V9 tasks.paused 列）', migrations.includes('CURRENT_SCHEMA_VERSION = 9'));
  check('claude-plan-repo.ts 有 getPlanState', repo.includes('export function getPlanState'));
  check('claude-plan-repo.ts 有 replaceTodos', repo.includes('export function replaceTodos'));
  check('claude-plan-repo.ts 有 upsertTask', repo.includes('export function upsertTask'));
  check('claude-plan-repo.ts 有 patchTask', repo.includes('export function patchTask'));
  check('claude-plan-repo.ts 有 mergeTasks（F4 替代 replaceTasks）', repo.includes('export function mergeTasks'));
  check('claude-plan-repo.ts 有 upsertPatch（F5 TaskGet 用）', repo.includes('export function upsertPatch'));
  check('claude-plan-repo.ts 无 replaceTasks（已移除）', !repo.includes('export function replaceTasks'));
  check('claude-plan-repo.ts 有 removeTask', repo.includes('export function removeTask'));

  // IPC 通道 + preload + handler
  check('ipc.ts 有 CLAUDE_PLAN_GET 通道', ipc.includes('CLAUDE_PLAN_GET'));
  check('preload api 有 getClaudePlanState', api.includes('getClaudePlanState'));
  check('ipc-handlers 有 CLAUDE_PLAN_GET handler', handlers.includes('CLAUDE_PLAN_GET'));
  check('ipc-handlers import claude-plan-repo', handlers.includes('claude-plan-repo'));

  // sdk-backend 接入
  check('sdk-backend import claude-plan 解析函数', backend.includes('parseTodoWriteInput'));
  check('sdk-backend import claude-plan-repo', backend.includes('claudePlanRepo'));
  check('sdk-backend import ClaudePlanTaskPatch（F7）', backend.includes('ClaudePlanTaskPatch'));
  check('sdk-backend 有 processAssistantToolUseForPlan', backend.includes('function processAssistantToolUseForPlan'));
  check('sdk-backend 有 processToolResultForPlan', backend.includes('function processToolResultForPlan'));
  check('sdk-backend 有 processTaskUpdatedForPlan', backend.includes('function processTaskUpdatedForPlan'));
  check('sdk-backend 有 forwardClaudePlanState', backend.includes('function forwardClaudePlanState'));
  check('sdk-backend task_updated 在 dispatch 中处理', backend.includes("subtype === 'task_updated'"));
  // F9: parentToolUseId 隔离子 Agent
  check('sdk-backend processAssistantToolUseForPlan 接收 parentToolUseId（F9）', backend.includes('parentToolUseId?: string'));
  check('sdk-backend assistant 调 processAssistantToolUseForPlan 传 parentToolUseId', backend.includes('processAssistantToolUseForPlan(sessionId, mainWindow, cliEvent.content, cliEvent.parentToolUseId)'));
  // F1: tool_use_result 结构化结果
  check('sdk-backend 有 extractStructuredResult（F1）', backend.includes('function extractStructuredResult'));
  check('sdk-backend user 调 processToolResultForPlan 传 toolUseResult', backend.includes('processToolResultForPlan(sessionId, mainWindow, resultParts, sdkMsg.tool_use_result)'));
  // F8: orphan patch 缓存
  check('sdk-backend 有 sessionOrphanPatches（F8）', backend.includes('sessionOrphanPatches'));
  check('sdk-backend 有 replayOrphanPatches（F8）', backend.includes('function replayOrphanPatches'));
  // F2: TaskUpdate 推迟到 result 阶段
  check('sdk-backend processAssistantToolUseForPlan 注释 TaskUpdate 推迟', backend.includes('result 阶段在 processToolResultForPlan 中处理'));
  // F6: patch 非空即转发
  check('sdk-backend patch 转发门禁用 Object.keys（F6）', backend.includes('Object.keys(patch).length'));
  // F13: TodoWrite 幂等标记
  check('sdk-backend cache entry 有 applied 标记（F13）', backend.includes('applied'));
  // F15: markSessionDeleted 清理 toolUseCache
  check('sdk-backend markSessionDeleted 清理 toolUseCache', backend.includes('cleanupToolUseCache(sessionId)'));

  // renderer store
  check('claude-plan-store.ts 有 planBySession', store.includes('planBySession'));
  check('claude-plan-store.ts 有 loadPlan', store.includes('async loadPlan'));
  check('claude-plan-store.ts 有 applyPlanState', store.includes('applyPlanState'));
  check('claude-plan-store.ts 有 clearSession', store.includes('clearSession'));
  check('claude-plan-store.ts 有 activePlan getter', store.includes('activePlan'));
  check('claude-plan-store.ts 有 revision 保护', store.includes('state.revision < existing.revision'));

  // use-chat 接入
  check('use-chat import useClaudePlanStore', useChat.includes('useClaudePlanStore'));
  check('use-chat handleCliEvent 有 claude_plan 分支', useChat.includes("case 'claude_plan'"));
  check('use-chat handleBackgroundEvent 有 claude_plan 分支', useChat.includes('applyPlanState(sid, event.state)'));

  // session-store 接入
  check('session-store rightTab 包含 plan', sessionStore.includes("'plan'"));
  check('session-store deleteSession 调 planStore.clearSession', sessionStore.includes('clearSession(id)'));
  check('session-store setRightTab 包含 plan', sessionStore.includes("'plan'") && sessionStore.includes('setRightTab'));
  // F11: deleteSession 回滚恢复 plan store
  check('session-store deleteSession 保存 prevPlan（F11）', sessionStore.includes('prevPlan'));
  check('session-store deleteSession catch 恢复 planBySession（F11）', sessionStore.includes('planStore.planBySession[id] = prevPlan'));

  // ChatPage 接入
  check('ChatPage import useClaudePlanStore', chatPage.includes('useClaudePlanStore'));
  check('ChatPage onMounted 调 loadPlan', chatPage.includes('planStore.loadPlan'));

  // TaskQueuePanel 接入
  check('TaskQueuePanel RightFilter 包含 plan', tqPanel.includes("'plan'"));
  check('TaskQueuePanel 有 ClaudePlanCard 组件', tqPanel.includes('ClaudePlanCard'));
  check('TaskQueuePanel rail 有 plan 按钮', tqPanel.includes("setFilter('plan')"));
  check('TaskQueuePanel 有 planMetric', tqPanel.includes('planMetric'));
  check('TaskQueuePanel 有 plan section', tqPanel.includes("rightTab === 'plan'"));
  // F10: 计划完成指标包含 task 完成
  check('TaskQueuePanel 有 planTaskCompleted（F10）', tqPanel.includes('planTaskCompleted'));
  check('TaskQueuePanel 有 planDone 合并指标（F10）', tqPanel.includes('planDone'));

  // ClaudePlanCard 只读 + 删除线
  check('ClaudePlanCard 存在', planCard.length > 0);
  check('ClaudePlanCard 只读无 checkbox', !planCard.includes('type="checkbox"'));
  check('ClaudePlanCard 无 v-html', !planCard.includes('v-html'));
  check('ClaudePlanCard 完成项删除线限 text span', planCard.includes('text--done') && planCard.includes('text-decoration: line-through'));
  check('ClaudePlanCard 无 emoji 作结构图标', !planCard.includes('📋') && !planCard.includes('✓'));
  // F3: 设计 token 合规（无废弃 token，用真实 variables.css token）
  check('ClaudePlanCard 无 --color-text-secondary（F3）', !planCard.includes('--color-text-secondary'));
  check('ClaudePlanCard 无 --color-text-tertiary（F3）', !planCard.includes('--color-text-tertiary'));
  check('ClaudePlanCard 无 --color-hover（F3）', !planCard.includes('--color-hover'));
  check('ClaudePlanCard 无 --color-bg-secondary（F3）', !planCard.includes('--color-bg-secondary'));
  check('ClaudePlanCard 无 --color-accent-bg（F3）', !planCard.includes('--color-accent-bg'));
  check('ClaudePlanCard 无 --color-warning（F3）', !planCard.includes('--color-warning'));
  check('ClaudePlanCard 用 --color-text-muted（F3）', planCard.includes('--color-text-muted'));
  check('ClaudePlanCard 用 --color-panel-soft 或 color-mix（F3）', planCard.includes('--color-panel-soft') || planCard.includes('color-mix'));
}

console.log('\n=== 47) 思考强度映射：ThinkingLevel → thinking/effort/settingsPatch ===');
{
  // 类型 + 校验
  check('THINKING_LEVELS 含七档（auto/low/medium/high/xhigh/max/ultracode）',
    THINKING_LEVELS.length === 7 &&
    ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'].every((l) => THINKING_LEVELS.includes(l as never)));
  check('isValidThinkingLevel("ultracode")=true', isValidThinkingLevel('ultracode') === true);
  check('isValidThinkingLevel("max")=true', isValidThinkingLevel('max') === true);
  check('isValidThinkingLevel("invalid")=false', isValidThinkingLevel('invalid') === false);
  check('isValidThinkingLevel(undefined)=false', isValidThinkingLevel(undefined) === false);
  check('isValidThinkingLevel(null)=false', isValidThinkingLevel(null) === false);

  // resolveEffectiveThinkingLevel：null/auto 回落全局默认，否则用会话档
  check('resolveEffective(null,"high")="high"', resolveEffectiveThinkingLevel(null, 'high') === 'high');
  check('resolveEffective("auto","high")="high"', resolveEffectiveThinkingLevel('auto', 'high') === 'high');
  check('resolveEffective("low","high")="low"', resolveEffectiveThinkingLevel('low', 'high') === 'low');
  check('resolveEffective("ultracode","medium")="ultracode"', resolveEffectiveThinkingLevel('ultracode', 'medium') === 'ultracode');

  // resolveThinkingConfig：thinking 一律 adaptive+summarized
  const low = resolveThinkingConfig('low');
  check('low thinking adaptive summarized', low.thinking.type === 'adaptive' && low.thinking.display === 'summarized');
  check('low effort=low', low.effort === 'low');
  check('low settingsPatch 关闭关键字触发器', low.settingsPatch?.workflowKeywordTriggerEnabled === false);
  check('low settingsPatch 开思考摘要', low.settingsPatch?.showThinkingSummaries === true);
  check('low settingsPatch 常驻思考', low.settingsPatch?.alwaysThinkingEnabled === true);

  // medium：只关关键字触发器，不投影思考字段（尊重 ~/.claude）
  const med = resolveThinkingConfig('medium');
  check('medium effort=medium', med.effort === 'medium');
  check('medium settingsPatch 关关键字触发器', med.settingsPatch?.workflowKeywordTriggerEnabled === false);
  check('medium settingsPatch 不投影 showThinkingSummaries', med.settingsPatch?.showThinkingSummaries === undefined);
  check('medium settingsPatch 不投影 alwaysThinkingEnabled', med.settingsPatch?.alwaysThinkingEnabled === undefined);

  // high/xhigh/max：通用 baseSettings
  check('high effort=high', resolveThinkingConfig('high').effort === 'high');
  check('xhigh effort=xhigh', resolveThinkingConfig('xhigh').effort === 'xhigh');
  check('max effort=max（运行时补偿；settings.effortLevel 降级 xhigh 由投影层处理）', resolveThinkingConfig('max').effort === 'max');
  check('high settingsPatch 关关键字触发器', resolveThinkingConfig('high').settingsPatch?.workflowKeywordTriggerEnabled === false);

  // ultracode：effort 锁死 xhigh（非 max），投影 ultracode/enableWorkflows，保留关键字触发器
  const ultra = resolveThinkingConfig('ultracode');
  check('ultracode effort=xhigh（非 max）', ultra.effort === 'xhigh');
  check('ultracode settingsPatch.ultracode=true', ultra.settingsPatch?.ultracode === true);
  check('ultracode settingsPatch.enableWorkflows=true', ultra.settingsPatch?.enableWorkflows === true);
  check('ultracode settingsPatch.alwaysThinkingEnabled=true', ultra.settingsPatch?.alwaysThinkingEnabled === true);
  check('ultracode settingsPatch.showThinkingSummaries=true', ultra.settingsPatch?.showThinkingSummaries === true);
  check('ultracode 保留关键字触发器（未显式关闭）', ultra.settingsPatch?.workflowKeywordTriggerEnabled === undefined);

  // 类型层落位（Task 1 同步改动）
  const configType = readRel('src/shared/types/config.ts');
  const sessionType = readRel('src/shared/types/session.ts');
  check('AppConfig 有 defaultThinkingLevel 字段', configType.includes('defaultThinkingLevel:'));
  check('Session 有 thinkingLevel 字段', sessionType.includes('thinkingLevel:'));
}

console.log('\n=== 48) 思考强度接线：持久化层 + 注入层 + IPC 通道契约 ===');
{
  const migrations = readRel('src/main/database/migrations.ts');
  const repo = readRel('src/main/database/repositories/session-repo.ts');
  const api = readRel('src/preload/api.ts');
  const handlers = readRel('src/main/ipc-handlers.ts');
  const cliShared = readRel('src/main/modules/cli-shared.ts');
  const sdkBackend = readRel('src/main/modules/sdk-backend.ts');
  const taskQueue = readRel('src/main/modules/task-queue-engine.ts');
  const configManager = readRel('src/main/modules/config-manager.ts');
  const projection = readRel('src/main/modules/claude-settings-projection.ts');

  // 持久化层（Task 4）
  check('migrations.ts schema 版本升为 9（V9 tasks.paused 列）', migrations.includes('CURRENT_SCHEMA_VERSION = 9'));
  check('migrations.ts 补 thinking_level 列', migrations.includes("ADD COLUMN thinking_level TEXT DEFAULT NULL"));
  check('session-repo.ts SessionRow 有 thinking_level', repo.includes('thinking_level: string | null'));
  check('session-repo.ts toSession 映射 thinkingLevel（脏值兜底）', repo.includes('isValidThinkingLevel(row.thinking_level)'));
  check('session-repo.ts updateSession 类型联合含 thinkingLevel', repo.includes("'maxTurns' | 'thinkingLevel'"));
  check('session-repo.ts updateSession SQL 分支 thinking_level', repo.includes("'thinking_level = @thinkingLevel'"));

  // IPC 通道（Task 4）
  check('preload api.ts updateSession 类型联合含 thinkingLevel', api.includes("'maxTurns' | 'thinkingLevel'"));
  check('ipc-handlers SESSION_UPDATE 类型联合含 thinkingLevel', handlers.includes("'maxTurns' | 'thinkingLevel'"));
  check('ipc-handlers SESSION_UPDATE 白名单校验 isValidThinkingLevel', handlers.includes('isValidThinkingLevel(data.thinkingLevel)'));
  check('ipc-handlers 非法 thinkingLevel 丢弃', handlers.includes('delete data.thinkingLevel'));

  // 注入层（Task 3）
  check('cli-shared SpawnOptions 有 thinkingLevel', cliShared.includes('thinkingLevel?: ThinkingLevel | null'));
  check('cli-shared buildSpawnEnv 注入 CLAUDE_EFFORT（best-effort）', cliShared.includes('env.CLAUDE_EFFORT'));
  check('sdk-backend import resolveThinkingConfig', sdkBackend.includes('resolveThinkingConfig'));
  check('sdk-backend import resolveEffectiveThinkingLevel', sdkBackend.includes('resolveEffectiveThinkingLevel'));
  check('sdk-backend 用 thinkingConfig.thinking（替换硬编码）', sdkBackend.includes('thinking: thinkingConfig.thinking'));
  check('sdk-backend 经统一核心注入 effort（Task 3 buildNativeSdkOptionsCore）',
    sdkBackend.includes('effort: thinkingConfig.effort') && sdkBackend.includes('buildNativeSdkOptionsCore'));
  check('sdk-backend settingsPatch Object.assign 覆盖全局投影（review-v1 F6 后收口到 buildClaudeLinkSettingsBlock）', sdkBackend.includes('Object.assign(out, thinkingConfig.settingsPatch)'));
  check('task-queue spawnForTask 传 thinkingLevel', taskQueue.includes('thinkingLevel: session?.thinkingLevel ?? null'));
  check('task-queue spawnForChat(续接) 传 thinkingLevel', taskQueue.includes('thinkingLevel: session.thinkingLevel'));
  check('ipc-handlers CHAT_SEND spawnForChat 传 thinkingLevel', handlers.includes('thinkingLevel: session.thinkingLevel'));

  // 配置层 + 投影（Task 2）
  check('config-manager defaultConfig 默认 medium', configManager.includes("defaultThinkingLevel: 'medium'"));
  check('config-manager getConfig 脏值清洗', configManager.includes('isValidThinkingLevel(rawThinkingLevel)'));
  check('claude-settings-projection import resolveThinkingConfig', projection.includes('resolveThinkingConfig'));
  check('projection selector > advancedJson（Object.assign）', projection.includes('Object.assign(projection, result.settingsPatch)'));
  check('projection max 降级 xhigh 持久化', projection.includes("result.effort === 'max' ? 'xhigh'"));
}

console.log('\n=== 49) 思考强度 UI 层：ThinkingLevelSelector + session-store action + 挂载契约 ===');
{
  const selector = readRel('src/renderer/components/chat/ThinkingLevelSelector.vue');
  const sessionStore = readRel('src/renderer/stores/session-store.ts');
  const toolbar = readRel('src/renderer/components/chat/SessionToolbar.vue');
  const configPage = readRel('src/renderer/pages/ConfigPage.vue');

  // ThinkingLevelSelector 组件（Task 5）
  check('ThinkingLevelSelector 调 setActiveSessionThinkingLevel', selector.includes('setActiveSessionThinkingLevel'));
  check('ThinkingLevelSelector 含七档（含 auto/ultracode）', selector.includes("'auto'") && selector.includes("'ultracode'"));
  check('ThinkingLevelSelector ultracode 标 danger', selector.includes('danger: true'));
  check('ThinkingLevelSelector click outside 关闭', selector.includes('handleClickOutside'));
  check('ThinkingLevelSelector Escape 关闭', selector.includes('handleEscape'));
  check('ThinkingLevelSelector 向上展开（bottom: calc(100%）', selector.includes('bottom: calc(100% + 0.25rem)'));
  check('ThinkingLevelSelector 选中勾号', selector.includes('CHECK_PATH') || selector.includes('tl-item__check'));
  // 默认档（auto/跟随全局默认）触发按钮直接展示全局默认档名，而非「自动」中间态。
  check('ThinkingLevelSelector 默认档展示全局默认档名（triggerLabel 回落 globalDefaultLabel）',
    selector.includes('triggerLabel') && selector.includes("activeValue.value === 'auto' ? globalDefaultLabel.value"));
  // 菜单默认档标题动态显示「默认：{全局默认档名}」，其余档 desc 保留。
  check('ThinkingLevelSelector 菜单默认档标题为「默认：全局默认档名」',
    selector.includes("opt.value === 'auto' ? `默认：${globalDefaultLabel}` : opt.label"));
  check('ThinkingLevelSelector 菜单其余档标题保持（低/中/高/超高/极限/工作流）',
    selector.includes("label: '低'") && selector.includes("label: '中'") && selector.includes("label: '高'")
    && selector.includes("label: '超高'") && selector.includes("label: '极限'") && selector.includes("label: '工作流'"));

  // session-store action（Task 5）
  check('session-store 有 setActiveSessionThinkingLevel action', sessionStore.includes('async setActiveSessionThinkingLevel'));
  check('session-store import ThinkingLevel 类型', sessionStore.includes("import type { ThinkingLevel }"));

  // SessionToolbar 挂载（Task 5）
  check('SessionToolbar import ThinkingLevelSelector', toolbar.includes('ThinkingLevelSelector.vue'));
  check('SessionToolbar 挂载 <ThinkingLevelSelector', toolbar.includes('<ThinkingLevelSelector'));

  // ConfigPage 全局默认选择器（Task 2）
  check('ConfigPage PERSISTED_FIELDS 含 defaultThinkingLevel', configPage.includes("'defaultThinkingLevel'"));
  check('ConfigPage 有 handleThinkingLevelChange', configPage.includes('handleThinkingLevelChange'));
  check('ConfigPage 行为 tab 有默认思考强度选择器', configPage.includes('默认思考强度'));
}

console.log('\n=== 50) 批次 B：thinking_tokens 实时思考 token 估算链路契约 ===');
{
  const cli = readRel('src/shared/types/cli.ts');
  const sb = readRel('src/main/modules/sdk-backend.ts');
  const store = readRel('src/renderer/stores/session-store.ts');
  const useChat = readRel('src/renderer/composables/use-chat.ts');
  const ctx = readRel('src/renderer/components/chat/ContextButton.vue');

  // 类型（B-1）
  check('cli.ts CliSystemInfoEvent subtype 含 thinking_tokens', cli.includes("'thinking_tokens'"));
  check('cli.ts CliSystemInfoEvent 有 estimatedTokens 字段', cli.includes('estimatedTokens?: number'));

  // 主进程：分支 + 节流 + 清理（B-2）
  check('sdk-backend 有 thinking_tokens 分支', sb.includes("subtype === 'thinking_tokens'"));
  check('sdk-backend 有 shouldForwardThinkingTokens 节流', sb.includes('function shouldForwardThinkingTokens'));
  check('sdk-backend 有 THINKING_TOKENS_THROTTLE_MS 限频常量', sb.includes('THINKING_TOKENS_THROTTLE_MS'));
  check('sdk-backend thinking_tokens 走 forwardTransient（不落库）', sb.includes("subtype: 'thinking_tokens'") && sb.includes('estimatedTokens: estimated'));
  check('sdk-backend markSessionDeleted 清理节流状态', sb.includes('sessionThinkingTokenThrottle.delete(sessionId)'));

  // store（B-3）
  check('session-store 有 thinkingTokens 瞬态字段', store.includes('thinkingTokens: null as number | null'));
  check('session-store 有 setThinkingTokens action', store.includes('setThinkingTokens(v: number | null)'));
  check('session-store switchSession 复位 thinkingTokens', store.includes('this.thinkingTokens = null'));

  // use-chat（B-4）
  check('use-chat 处理 thinking_tokens → setThinkingTokens', useChat.includes("event.subtype === 'thinking_tokens'") && useChat.includes('store.setThinkingTokens(t.estimatedTokens)'));
  check('use-chat 回合结束清零 setThinkingTokens(null)', useChat.includes('store.setThinkingTokens(null)'));

  // ContextButton（B-5）：保留思考态呼吸提示，但按用户要求移除 hover 数值行
  check('ContextButton 思考态 class ctx__btn--thinking', ctx.includes('ctx__btn--thinking'));
  check('ContextButton 思考态呼吸读 store.thinkingTokens', ctx.includes('store.thinkingTokens'));
  check('ContextButton 已移除 hover 思考 token 数值行', !ctx.includes('（估算）'));
}

console.log('\n=== 51) API 自动重试状态卡：进度/倒计时/停止与流式容器保活 ===');
{
  const banner = readRel('src/renderer/components/chat/ApiRetryBanner.vue');
  const ml = readRel('src/renderer/components/chat/MessageList.vue');

  check('ApiRetryBanner 展示权威 retryCount/retryLimit', banner.includes('info.retryCount') && banner.includes('info.retryLimit'));
  check('ApiRetryBanner 复用共享错误标签映射', banner.includes('apiRetryErrorLabel'));
  check('ApiRetryBanner 有 retry-progress 进度条', banner.includes('retry-progress'));
  check('ApiRetryBanner 展示预计重试倒计时', banner.includes('预计'));
  check('ApiRetryBanner 说明 Claude Code 将发起下一次真实重试请求',
    banner.includes('等待 Claude Code 发起下一次重试请求') &&
    banner.includes('准备第 {{ info.retryCount }}/{{ info.retryLimit }} 次重试'));
  check('ApiRetryBanner 提供立即停止按钮', banner.includes('立即停止'));
  check('ApiRetryBanner 停止前标记 stopping 并保留重试态',
    /markApiRetryStopping\(session\.id\)[\s\S]*?await chat\.abort\(\{ preserveApiRetry: true \}\)/.test(banner));
  check('停止 IPC 失败时清除保留的 retry 卡片',
    /catch[\s\S]*clearApiRetrying\(sid\)/.test(readRel('src/renderer/composables/use-chat.ts')));
  check('ApiRetryBanner 状态区可礼貌播报且逐秒倒计时不进入 live region',
    banner.includes('role="status"') && banner.includes('aria-live="polite"') &&
    /retry-card__countdown" aria-hidden="true"/.test(banner));
  check('ApiRetryBanner 使用原生禁用按钮并尊重减少动画',
    banner.includes(':disabled="info.stopping"') && banner.includes('@click="stopRetrying"') &&
    banner.includes('prefers-reduced-motion: reduce'));
  check('API retry 落库失败 fallback 在运行期可见',
    banner.includes('activeApiRetryTerminalFallback') && banner.includes('fallback.summary') &&
    /v-if="[^"]*activeApiRetryTerminalFallback/.test(ml));
  check('MessageList API 重试期间保持 stream-group',
    /v-if="[^"]*activeApiRetryInfo/.test(ml));
}

console.log('\n=== 52) API 重试终态专用折叠记录 ===');
{
  const processGroup = readRel('src/renderer/components/chat/ProcessGroup.vue');
  const systemInfo = readRel('src/shared/system-info.ts');
  const apiRetryRecordSrc = readRel('src/renderer/components/chat/ApiRetryRecord.vue');

  check('retry 三种终态使用专用折叠记录',
    processGroup.includes("import ApiRetryRecord from './ApiRetryRecord.vue'") &&
    processGroup.includes("type: 'api_retry'") &&
    processGroup.includes("'system:api_retry_recovered'") &&
    processGroup.includes("'system:api_retry_stopped'") &&
    processGroup.includes("'system:api_retry_exhausted'") &&
    processGroup.includes('<ApiRetryRecord'));
  check('retry 终态不被旧噪声过滤规则吞掉',
    systemInfo.includes("processKind === 'system:api_retry'") &&
    !systemInfo.includes("startsWith('system:api_retry')") &&
    !systemInfo.includes("processKind === 'system:api_retry_recovered'") &&
    !systemInfo.includes("processKind === 'system:api_retry_stopped'") &&
    !systemInfo.includes("processKind === 'system:api_retry_exhausted'"));

  check('retry 记录解析 rawEvent 失败或无详情时保留摘要',
    apiRetryRecordSrc.includes('JSON.parse') &&
    apiRetryRecordSrc.includes('catch') &&
    apiRetryRecordSrc.includes('message.content') &&
    apiRetryRecordSrc.includes('open && details'));
  check('retry 记录只显示存在且有限的时间字段',
    apiRetryRecordSrc.includes('Number.isFinite(details.value.elapsedMs)') &&
    apiRetryRecordSrc.includes('Number.isFinite(details.value.accumulatedDelayMs)') &&
    apiRetryRecordSrc.includes('v-if="elapsed"') && apiRetryRecordSrc.includes('v-if="delay"'));
  check('retry 记录包含恢复与仅停止当前回复结果文案',
    apiRetryRecordSrc.includes('上游已恢复，本次回复继续') &&
    apiRetryRecordSrc.includes('仅终止本次回复，会话仍可继续'));
  check('图片导出强制展开过程组以保留 retry 终态摘要',
    processGroup.includes('if (props.exportMode) return true'));
}

console.log('\n=== 53) 权限模式全局默认 + 会话覆盖链路（permission-resolver / 落盘 / 注入 / UI）===');
{
  // 共享 resolver：类型 + 守卫 + 回落。
  check('PERMISSION_MODES 含四档（default/plan/acceptEdits/bypassPermissions）',
    PERMISSION_MODES.length === 4 &&
    ['default', 'plan', 'acceptEdits', 'bypassPermissions'].every((m) => PERMISSION_MODES.includes(m as never)));
  check('isValidPermissionMode("bypassPermissions")=true', isValidPermissionMode('bypassPermissions') === true);
  check('isValidPermissionMode("invalid")=false', isValidPermissionMode('invalid') === false);
  check('isValidPermissionMode(null)=false', isValidPermissionMode(null) === false);
  check('isValidPermissionMode(undefined)=false', isValidPermissionMode(undefined) === false);
  check('resolveEffectivePermissionMode(null,"acceptEdits")="acceptEdits"', resolveEffectivePermissionMode(null, 'acceptEdits') === 'acceptEdits');
  check('resolveEffectivePermissionMode("plan","acceptEdits")="plan"', resolveEffectivePermissionMode('plan', 'acceptEdits') === 'plan');

  // 类型层：AppConfig 全局默认 + Session 可空覆盖。
  const configType = readRel('src/shared/types/config.ts');
  const sessionType = readRel('src/shared/types/session.ts');
  check('AppConfig.permissionMode 是全局默认档', configType.includes('permissionMode: PermissionMode') && configType.includes('全局默认权限'));
  check('Session.permissionMode 可空（null=跟随全局默认）', sessionType.includes('permissionMode: PermissionMode | null'));

  // 落盘层：新会话写 NULL（不钉死 default）；老库列默认改 NULL。
  const migrations = readRel('src/main/database/migrations.ts');
  const repo = readRel('src/main/database/repositories/session-repo.ts');
  check('migrations.ts 新表 permission_mode DEFAULT NULL', migrations.includes('permission_mode TEXT DEFAULT NULL'));
  check('session-repo.ts createSession 显式写 NULL', repo.includes('permission_mode)') && repo.includes('NULL'));
  check('session-repo.ts toSession 脏值兜底 isValidPermissionMode', repo.includes('isValidPermissionMode(row.permission_mode)'));
  // 存量清洗：老库会话 permission_mode='default' 是旧列默认值的幻影显式值，须重置为 NULL 跟随全局。
  check('migrations 存量会话权限清洗（default → NULL 跟随全局默认）',
    migrations.includes("UPDATE sessions SET permission_mode = NULL"));
  check('权限清洗在 currentVersion<1 块之后（老库必须执行到）',
    migrations.indexOf('UPDATE sessions SET permission_mode = NULL') >
      migrations.lastIndexOf('if (currentVersion < 1)'));

  // IPC 层：SESSION_UPDATE 白名单校验非法 permissionMode 丢弃。
  const handlers = readRel('src/main/ipc-handlers.ts');
  check('ipc-handlers SESSION_UPDATE 白名单校验 isValidPermissionMode', handlers.includes('isValidPermissionMode(data.permissionMode)'));
  check('ipc-handlers 非法 permissionMode 丢弃', handlers.includes('delete data.permissionMode'));

  // 注入层：sdk-backend 经 resolver 回落全局默认（query + probe 两条链）。
  const sdkBackend = readRel('src/main/modules/sdk-backend.ts');
  const cliShared = readRel('src/main/modules/cli-shared.ts');
  const sdkPermissions = readRel('src/main/modules/sdk-permissions.ts');
  check('sdk-backend import resolveEffectivePermissionMode', sdkBackend.includes('resolveEffectivePermissionMode'));
  check('sdk-backend buildSdkOptions 用 effectivePermissionMode（两处回落）',
    sdkBackend.split('resolveEffectivePermissionMode(opts.permissionMode ?? null, config.permissionMode)').length - 1 >= 2);
  check('sdk-backend 注入 permissionMode: effectivePermissionMode',
    sdkBackend.includes('permissionMode: effectivePermissionMode as'));
  // 权限通道对齐（角度D 遗漏修复）：settings.permissions.defaultMode 由 buildClaudeSettingsProjection
  // 用全局 config.permissionMode 构造，会话显式选档时须按会话有效档对齐，否则「UI 所见权限档」与
  // 「settings 块注入档」分叉（全局默认=bypassPermissions、会话显式选 default 时越权放行）。
  check('buildClaudeLinkSettingsBlock 接收 effectivePermissionMode 参数',
    sdkBackend.includes('effectivePermissionMode: PermissionMode,') && sdkBackend.includes('override, effectivePermissionMode)'));
  check('会话显式选档时经 alignPermissionDefaultMode 对齐（sdk-backend 接线）',
    sdkBackend.includes('alignPermissionDefaultMode') && sdkBackend.includes("if (opts.permissionMode != null)") && sdkBackend.includes('permissions = alignPermissionDefaultMode(permissions, effectivePermissionMode)'));
  check('alignPermissionDefaultMode 抽为 sdk-permissions 纯函数（default→删 / 非 default→写有效档 / 不 mutate 入参）',
    sdkPermissions.includes('export function alignPermissionDefaultMode') &&
    sdkPermissions.includes("delete next.defaultMode") &&
    sdkPermissions.includes('next.defaultMode = effectivePermissionMode') &&
    sdkPermissions.includes('const next: SdkPermissionSettings = { ...permissions }'));
  check('cli-shared SpawnOptions permissionMode 可空', cliShared.includes('permissionMode?: PermissionMode | null'));

  // UI 层：ConfigPage 全局默认选择器 + SessionToolbar 跟随全局默认(null) 选项。
  const configPage = readRel('src/renderer/pages/ConfigPage.vue');
  const toolbar = readRel('src/renderer/components/chat/SessionToolbar.vue');
  check('ConfigPage PERSISTED_FIELDS 含 permissionMode', configPage.includes("'permissionMode'"));
  check('ConfigPage 有 handlePermissionModeChange', configPage.includes('handlePermissionModeChange'));
  check('ConfigPage 行为 tab 有默认权限选择器', configPage.includes('默认权限'));
  check('SessionToolbar 权限选项含跟随全局默认(null)', toolbar.includes("value: null") && toolbar.includes('跟随全局默认'));
  check('SessionToolbar 显示全局默认档名', toolbar.includes('globalDefaultPermissionLabel'));
  // 默认权限档（null/跟随全局默认）触发按钮直接展示全局默认档名，而非「跟随全局默认」中间态。
  check('SessionToolbar 默认权限档展示全局默认档名（permissionTriggerLabel）',
    toolbar.includes('permissionTriggerLabel') && toolbar.includes('mode === null ? globalDefaultPermissionLabel.value'));
  // 菜单默认档标题动态显示「默认：{全局默认档名}」，其余档 desc 保留。
  check('SessionToolbar 菜单默认档标题为「默认：全局默认档名」',
    toolbar.includes("p.value === null ? `默认：${globalDefaultPermissionLabel}` : p.label"));
  // D8（CDP 实测报告）旧契约「权限按钮 sending 期间 disabled」已被批次二 #3 取代：
  // streaming 迁移后运行中切换经控制请求即时生效，按钮放开禁用。
  // 锚定模板中的权限按钮块（div ref="permissionRef" → perm-menu），避免误捕脚本区的同名 ref
  // 与其它 :disabled="sending" 控件。
  const permTplIdx = toolbar.indexOf('<div ref="permissionRef"');
  const permMenuIdx = toolbar.indexOf('perm-menu', permTplIdx);
  const permBtnBlock2 = toolbar.slice(permTplIdx, permMenuIdx > 0 ? permMenuIdx : permTplIdx + 1500);
  check('SessionToolbar 权限切换按钮放开 sending 禁用（运行中可切档，批次二 #3）',
    /class="ctl__btn"/.test(permBtnBlock2) && !/:disabled="sending"/.test(permBtnBlock2));
}

console.log('\n=== 权限弹窗与 400 遗留修复（批次一）结构契约 ===');
{
  const sdkBackend = readRel('src/main/modules/sdk-backend.ts');
  const sdkPermissions = readRel('src/main/modules/sdk-permissions.ts');
  const cliShared = readRel('src/main/modules/cli-shared.ts');
  const interactionCancel = readRel('src/shared/interaction-cancel.ts');
  const useChat = readRel('src/renderer/composables/use-chat.ts');
  const messageBubble = readRel('src/renderer/components/chat/MessageBubble.vue');
  const toolbar2 = readRel('src/renderer/components/chat/SessionToolbar.vue');
  const systemInfo = readRel('src/shared/system-info.ts');

  // #1 系统取消弹窗可见反馈：killProcess 捕获 hadPending → 取消 → 谓词判定 → 落库 system:interaction_cancelled。
  check('shouldNotifyInteractionCancelled 抽为 shared 纯函数（三 reason 显式枚举 + hadPending）',
    interactionCancel.includes('export function shouldNotifyInteractionCancelled') &&
    interactionCancel.includes("reason === 'watchdog' || reason === 'upstream_fatal' || reason === 'queue'"));
  const killBody = sdkBackend.slice(sdkBackend.indexOf('export function killProcess('), sdkBackend.indexOf('export function killProcess(') + 2500);
  check('killProcess 取消前捕获 hadPending（hasPendingInteractionForSession）',
    /const hadPendingInteraction = hasPendingInteractionForSession\(sessionId\);[\s\S]*?cancelInteractionsForSession\(sessionId\);/.test(killBody));
  check('killProcess 接线 shouldNotifyInteractionCancelled + processKind system:interaction_cancelled + isError',
    sdkBackend.includes('shouldNotifyInteractionCancelled(reason, hadPendingInteraction)') &&
    sdkBackend.includes("'system:interaction_cancelled'") &&
    /processKind: 'system:interaction_cancelled',[\s\S]*?title: '权限弹窗已取消',[\s\S]*?isError: true,/.test(sdkBackend));
  check('killProcess 推送 persisted_message（重开会话仍可见）',
    /system:interaction_cancelled[\s\S]{0,600}?type: 'persisted_message'/.test(sdkBackend));
  check('system:interaction_cancelled 不在冗余集（聊天流默认可见）',
    !/isRedundantSystemProcessKind[\s\S]*?interaction_cancelled/.test(systemInfo) &&
    !systemInfo.includes('interaction_cancelled'));

  // #2/#3：归一化两处对称 + 子 agent 不吃主流程会话放行。
  check('toolName 归一化纯函数（trim+toLowerCase）',
    sdkPermissions.includes('export function normalizeToolNameForMatch') &&
    sdkPermissions.includes('toolName.trim().toLowerCase()'));
  check('withToolSessionAllow 与 isToolSessionAllowed 比较两侧均过归一化（对称）',
    (sdkPermissions.match(/normalizeToolNameForMatch\(rule\.toolName\) === matchTool/g) ?? []).length >= 2);
  check('createPermissionHandler 短路含 agentID 判定（子 agent 不吃主流程会话放行）',
    sdkBackend.includes('options.agentID == null && isToolSessionAllowed(sessionBook, toolName)'));

  // #4 API Error → isError + 红气泡：三处接线。
  check('isApiErrorAssistantText 抽为 shared 纯函数（trim 后前缀匹配）',
    readRel('src/shared/api-error-text.ts').includes("text.trim().startsWith('API Error:')"));
  check('cli-shared 落库 assistant 正文命中谓词即 isError（isAssistantApiError 变量）',
    cliShared.includes("const isAssistantApiError = role === 'assistant' && isApiErrorAssistantText(part.text)") &&
    cliShared.includes('isError: isAssistantApiError'));
  check('use-chat persistMessage 镜像路径同样标 isError（isAssistantApiError 变量）',
    useChat.includes("const isAssistantApiError = isAssistant && isApiErrorAssistantText(part.text)") &&
    useChat.includes('isError: isAssistantApiError'));
  // reasoning_replay 韧性层接线（2026-08-27）：共享谓词 + 结构化标记 + 自动重试 + 气泡建议。
  check('upstream-errors 导出 reasoning_replay 谓词与分类',
    readRel('src/shared/upstream-errors.ts').includes('export function isReasoningReplayApiError') &&
    readRel('src/shared/upstream-errors.ts').includes("'reasoning_replay'"));
  check('cli-shared 命中 reasoning_replay 落 apiErrorKind 并通知自动重试模块',
    cliShared.includes("apiErrorKind: isReasoningReplay ? 'reasoning_replay' : null") &&
    cliShared.includes('noteReasoningReplayError(sessionId)'));
  check('use-chat 镜像路径同谓词打 apiErrorKind 标记',
    useChat.includes("isReasoningReplayApiError(part.text) ? 'reasoning_replay' : null"));
  check('sdk-backend 三个接线点（记录文本/两终态调度/删除清理）',
    readRel('src/main/modules/sdk-backend.ts').includes('recordOutgoingUserText(sessionId, opts.userCommandText)') &&
    (readRel('src/main/modules/sdk-backend.ts').match(/scheduleReasoningReplayRetryForTurn\(sessionId, mainWindow\)/g) ?? []).length === 2 &&
    readRel('src/main/modules/sdk-backend.ts').includes('clearReasoningReplayState(sessionId)'));
  check('配置项 autoRetryReasoningReplay 默认开且持久化映射',
    readRel('src/main/modules/config-manager.ts').includes('autoRetryReasoningReplay: true') &&
    readRel('src/main/modules/config-manager.ts').includes('config.autoRetryReasoningReplay ?? true'));
  check('MessageBubble reasoning_replay 行动建议（手动重试/压缩/换端点）',
    messageBubble.includes('reasoning-replay-advice') &&
    messageBubble.includes('已自动重试一次') &&
    messageBubble.includes('Anthropic 直连'));
  check('MessageBubble 错误气泡（bubble--error + fail 色系）',
    messageBubble.includes("'bubble--error': message.isError === true") &&
    messageBubble.includes('.bubble--error') &&
    messageBubble.includes('var(--color-fail)') &&
    messageBubble.includes('var(--color-fail-strong)'));

  // #5 权限菜单生效提示（F2 验收 review 精确化：只对切换后新发起的工具请求即时生效）。
  // bypass 档 CLI 拒绝中途设置回落下一条生效是 CLI 约束的已知例外，按用户要求不在界面展示。
  check('SessionToolbar perm-menu 底部生效提示（foot 文案，无 bypass 例外行）',
    toolbar2.includes('对切换后新发起的工具请求即时生效') && !toolbar2.includes('自动模式档从下一条消息起生效'));
  check('SessionToolbar 权限触发按钮 title 追加「；运行中切换即时生效」',
    toolbar2.includes('}）；运行中切换即时生效`'));

  // ── 批次二：streaming 迁移 + 权限中途切换 + 两段式中止 ──
  const ipcTypes = readRel('src/shared/types/ipc.ts');
  const ipcHandlers = readRel('src/main/ipc-handlers.ts');
  const preloadApi = readRel('src/preload/api.ts');
  const sessionStore = readRel('src/renderer/stores/session-store.ts');
  const taskStore = readRel('src/renderer/stores/task-store.ts');

  check('toStreamingPrompt 包装器（yield 后挂起 + settle 收口 + 可重复迭代）',
    sdkBackend.includes('export function toStreamingPrompt') &&
    sdkBackend.includes('await done;') &&
    sdkBackend.includes('settle: () =>'));
  check('runQuery 三处 startSdkQuery 均传 streaming iterable（迁移接线）',
    (sdkBackend.match(/startSdkQuery\(streamingPrompt\.iterable, sdkOptions\)/g) ?? []).length === 3);
  // v2（context-circle-v2 D3）：settle 挪至 result 分支内 post-turn 快照 await 之后——
  // 先 settle 会关 stdin，控制通道快照必超时（08-29 审计定案的同款修法）。
  check('result 分支 settle + finally 兜底 settle（防挂起生成器泄漏；settle 在 post-turn 快照 await 后）',
    (() => {
      const resultIdx = sdkBackend.indexOf("if (type === 'result')");
      const settleIdx = sdkBackend.indexOf('streamingPrompt.settle();', resultIdx);
      const refreshIdx = sdkBackend.indexOf("await refreshContextSnapshot(sessionId, mainWindow, entry, query, { samplePhase: 'post-turn' })", resultIdx);
      return resultIdx >= 0 && settleIdx > resultIdx && refreshIdx > resultIdx && refreshIdx < settleIdx;
    })() &&
    /finally \{[\s\S]{0,300}?entry\.streamingPrompt\?\.settle\(\);[\s\S]*?deleteEntry\(sessionId, entry\);/.test(sdkBackend));
  check('SessionEntry 挂 streamingPrompt 句柄 + markEntryAborting settle',
    sdkBackend.includes('streamingPrompt: StreamingPromptHandle | null;') &&
    /markEntryAborting[\s\S]{0,200}?entry\.streamingPrompt\?\.settle\(\);/.test(sdkBackend));
  check('两段式 killProcess：watchdog/upstream_fatal/queue 先 interrupt、有界 5000ms、记账延迟到优雅窗口后',
    sdkBackend.includes("reason === 'watchdog' || reason === 'upstream_fatal' || reason === 'queue'") &&
    /query\.interrupt\(\)[\s\S]{0,900}?finishKill\(\)/.test(sdkBackend) &&
    /const deadline = Date\.now\(\) \+ 5000;/.test(sdkBackend) &&
    sdkBackend.includes('const finishKill = () => {'));
  check('权限中途切换：CHAT_SET_PERMISSION_MODE 通道 + 主进程解析有效档',
    ipcTypes.includes("CHAT_SET_PERMISSION_MODE: 'chat:setPermissionMode'") &&
    ipcHandlers.includes('setRunningQueryPermissionMode(sessionId, effective)') &&
    ipcHandlers.includes('resolveEffectivePermissionMode(mode as PermissionMode | null, getConfig().permissionMode)'));
  check('setRunningQueryPermissionMode：无运行回合 false + 3s ACK 放行 + 拒绝记日志',
    sdkBackend.includes('export async function setRunningQueryPermissionMode') &&
    /return false;[\s\S]{0,700}?setTimeout\(\(\) => finish\(true\), 3000\)/.test(sdkBackend));
  check('preload 暴露 setRunningPermissionMode',
    preloadApi.includes('setRunningPermissionMode: (sessionId, mode) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SET_PERMISSION_MODE'));
  check('session-store setActiveSessionPermissionMode 接运行中切换 + catch 静默回落',
    /setActiveSessionPermissionMode[\s\S]{0,900}?setRunningPermissionMode\(this\.activeSession\.id, mode\)/.test(sessionStore));
  check('task-store 中断收口 task_completed(interrupted) 补 markStopped（sending 不卡死）',
    /task_completed[\s\S]{0,500}?interrupted[\s\S]{0,200}?markStopped\(payload\.sessionId\)/.test(taskStore));

  // ── 验收 review 修复 ──
  // F1：两段式优雅窗口内重发接管——entry.forceKill 句柄 + finishKill 幂等（killClosed）+
  // spawnForChat 遇 forceKill 强制收口而非抛「回合仍在执行」+ getActiveProcess 判否放行队列续接。
  check('F1 两段式 forceKill 句柄（SessionEntry 字段 + 两段式分支挂载 + finishKill 幂等自清）',
    sdkBackend.includes('forceKill: (() => void) | null;') &&
    /entry\.forceKill = finishKill;/.test(sdkBackend) &&
    /let killClosed = false;[\s\S]{0,150}?killClosed = true;[\s\S]{0,80}?entry\.forceKill = null;/.test(sdkBackend));
  check('F1 spawnForChat 优雅窗口重发先 forceKill 接管（不抛误导性错误）',
    /spawnForChat[\s\S]*?blocking\.forceKill\(\);[\s\S]*?当前回合仍在执行/.test(sdkBackend));
  check('F1 getActiveProcess 对 forceKill 优雅窗口判否（队列续接预检放行）',
    /isEntryActive\(entry\) && !entry\.forceKill \? entry\.handle : undefined/.test(sdkBackend));
  // F4：mid-turn context refresh 超时降级 debug（CLI 生成中不回控制 ACK 属常态）。
  // v2（context-circle-v2 D3）：条件降级改为无条件 debug——query-start/post-turn 相位也降，
  // 控制通道死的固有遥测不再 warn 刷屏（stale 降级 payload 语义不变）。
  check('F4 refreshContextSnapshot 失败日志降级 debug（v2：三相位一律 debug，防刷屏误导）',
    /logger\.debug\(`\[\$\{sessionId\}\] refreshContextSnapshot 失败/.test(sdkBackend) &&
    !/logger\.warn\(`\[\$\{sessionId\}\] refreshContextSnapshot 失败/.test(sdkBackend));

  // F5（验收 review 第三轮）：queue 触发点 killProcess 漏传 mainWindow 会使「弹窗被系统
  // 取消」反馈（system:interaction_cancelled）在 queue 路径恒静默——interruptTask 与
  // continueWithUserMessage 回滚路径两处调用都必须带 mainWindow 字面量。
  const taskQueueEngine = readRel('src/main/modules/task-queue-engine.ts');
  check('F5 interruptTask 的 queue killProcess 含 mainWindow（弹窗取消反馈不静默）',
    /export function interruptTask\(taskId: string, sessionId: string, mainWindow: BrowserWindow\): void \{[\s\S]{0,900}?killProcess\(sessionId, 'queue', mainWindow\);/.test(taskQueueEngine));
  check('F5 continueWithUserMessage 回滚路径 queue killProcess 同样含 mainWindow',
    /if \(spawned\) killProcess\(sessionId, 'queue', mainWindow\);/.test(taskQueueEngine) &&
    !/killProcess\(sessionId, 'queue'\)/.test(taskQueueEngine));
  // F5 复验延伸：interaction_cancelled 须独立成条（不折进过程组），红色系统消息才用户可见。
  const groupMessages = readRel('src/renderer/utils/group-messages.ts');
  check('F5 interaction_cancelled 打断 fold 独立展示（红色系统消息可见）',
    /isBreak =[\s\S]{0,400}?msg\.processKind === 'system:interaction_cancelled'/.test(groupMessages));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);