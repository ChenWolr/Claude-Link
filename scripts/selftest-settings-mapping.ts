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
} from '../src/shared/settings-parser';
import { extractContextTokens, detectCompaction, type CliUsage } from '../src/shared/context-usage';
import { lookupModelWindow, resolveContextWindow } from '../src/shared/model-context-windows';
import type { CliEvent, CliSystemInfoEvent, CliMessageEvent, CliResultEvent } from '../src/shared/types/cli';
import { isDisplayableSystemInfo, isRedundantSystemProcessKind } from '../src/shared/system-info';
import { classifyStall, DEFAULT_STALL_THRESHOLDS, isBusinessStallActivityKind } from '../src/shared/stall-watchdog';

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

console.log('\n=== 12) 回归：后台标题分析不得硬编码 Haiku，必须走配置模型解析 ===');
{
  const source = readRel('src/main/modules/topic-analyzer.ts');
  // 不得出现任何 claude-haiku-4-5 字面量（无论 = 还是 : 写法），否则就是硬编码。
  check('topic-analyzer 不再硬编码 claude-haiku-4-5', !source.includes('claude-haiku-4-5'));
  check('topic-analyzer 使用 resolveConfiguredDefaultModel 解析配置模型', source.includes('resolveConfiguredDefaultModel'));
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
  // SDK 路径：中断标记按 query 实例（interruptedQueries WeakSet），非 sessionId。
  check('中断标记按 query 实例（WeakSet）', sb.includes('interruptedQueries') && sb.includes('WeakSet'));
  check('killProcess 调 query.interrupt', /killProcess[\s\S]{0,300}interrupt/.test(sb));
  check('中断(error_during_execution)不弹错误', uc.includes('error_during_execution') && uc.includes('isUserInterrupt'));
  check('streamingTool 有渲染消费链', ml.includes('streamingTool') && cp.includes('displayTool') && us.includes('displayTool'));
  check('abort 定时器句柄化 + 清理', uc.includes('abortTimer') && uc.includes('clearAbortTimer'));
  check('continueWithUserMessage exit 守卫 continuing', /status !== 'continuing'/.test(tq));
}

console.log('\n=== 27) 过程分组计划契约：类型/DB/透传/分组/子AgentTab/无诊断日志 ===');
{
  const sess = readRel('src/shared/types/session.ts');
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

  // B2 数据模型 + DB
  check('Message 含 processKind/parentAgentId/toolUseId/title',
    sess.includes('processKind') && sess.includes('parentAgentId') && sess.includes('toolUseId') && sess.includes('title'));
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
  const ms = readRel('src/renderer/components/chat/ModelSelector.vue');
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
  check('ModelSelector 含 disabled prop', ms.includes('disabled') && ms.includes('defineProps'));
  check('SessionToolbar ContextButton :disabled', st.includes('ContextButton :disabled="sending"'));
  check('SessionToolbar 工作空间 button :disabled', /ctl__btn[\s\S]{0,120}:disabled="sending"/.test(st));
  check('SessionToolbar ModelSelector :disabled', st.includes('ModelSelector :disabled="sending"'));
  check('SessionToolbar 权限 select :disabled', /<select[\s\S]{0,80}:disabled="sending"/.test(st));
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
  check('Message 含 isError 字段', sess.includes('isError'));
  check('messages 表幂等加 is_error 列', mig.includes('ALTER TABLE messages ADD COLUMN is_error'));
  check('repo MessageRow/toMessage/createMessage 贯穿 is_error', repo.includes('is_error') && repo.includes('isError'));
  check('persistMessageParts 提取 is_error 落库', cs.includes('part.is_error === true'));
  check('handleMessagePartsFull 提取 is_error', uc.includes('part.is_error === true'));
  check('ToolCallBlock 失败状态行 ✗ 红色', tcb.includes('result.isError') && tcb.includes('tool-row__fail'));

  // 4. system/api_retry 事件解析与展示（API 重试可见反馈，不再被「未知 subtype」吞掉）
  check('cli.ts CliSystemInfoEvent 含 api_retry subtype', cli.includes("'api_retry'"));
  check('sdk-backend 转发 api_retry system 事件',
    sb.includes("infoSubtype === 'api_retry'") && sb.includes('attempt') && sb.includes('max_retries'));
  check('persistSystemEvent 构造 api_retry 重试文案', uc.includes('API 重试中'));

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
  check('sdk-interactions 含 PermissionUpdate 类型定义', sdkInteractions.includes('export type PermissionUpdate'));
  check('PermissionResult.updatedPermissions 用 PermissionUpdate[]', sdkInteractions.includes('updatedPermissions?: PermissionUpdate[]'));
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
  check('ContextButton 实时压缩态', cb.includes('store.compacting') && cb.includes('正在压缩'));
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
  check('use-now 提供 useNow（100ms 跳动）', un.includes('useNow') && un.includes('setInterval'));
  check('session-store 含 turnStartedAt + activeTurnStartedAt', ss.includes('turnStartedAt') && ss.includes('activeTurnStartedAt'));
  check('markRunning 记录 turnStartedAt', ss.includes('this.turnStartedAt[sessionId] = Date.now()'));
  check('MessageList 实时计时器（turn-timer + formatElapsed + useNow）', ml.includes('turn-timer') && ml.includes('formatElapsed') && ml.includes('useNow'));
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

  // R2（问题 5）：渲染层过滤 permission / interaction_response（首轮误诊为空 informational）。
  check('permission 视为冗余（不渲染）', isRedundantSystemProcessKind('permission') === true);
  check('system:interaction_response 视为冗余', isRedundantSystemProcessKind('system:interaction_response') === true);
  check('system:informational 视为冗余（问题 2：彻底删行不渲染）', isRedundantSystemProcessKind('system:informational') === true);
  check('thinking 非冗余（保留渲染）', isRedundantSystemProcessKind('thinking') === false);
  check('tool:* 非冗余', isRedundantSystemProcessKind('tool:bash') === false);
  check('compact_boundary 非冗余', isRedundantSystemProcessKind('system:compact_boundary') === false);
  check('null 非冗余', isRedundantSystemProcessKind(null) === false);
  check('group-messages 渲染层过滤冗余 system', gm.includes('isRedundantSystemProcessKind'));

  // R1（问题 2）：sdk-backend 把缺失值补 0，?? 对 0 不生效 → 改真值判断 + clientMs 兜底。
  check('use-chat 时长真值判断（>0 回落 clientMs）', uc.includes('event.duration_ms') && uc.includes('> 0') && uc.includes('clientMs'));

  // R3（问题 6）：子 Agent 实时计时改回合级 sending（首轮仅末组 g.running 实时，非末组冻结）。
  check('TaskQueuePanel 子Agent 计时用回合级 sending', tqp.includes('sessionStore.sending && g.startMs'));
  // 计时偏短根因修正：回合结束冻结在 live 最终值，不回退到偏短的 createdAt 首尾差。
  check('TaskQueuePanel 子Agent 计时回合结束冻结 live（lastLiveByGroup）',
    tqp.includes('lastLiveByGroup') && tqp.includes('frozenLive') && tqp.includes('Date.now()'));

  // R4（问题 7）：内层 ProcessGroup manualClosed 覆盖 active，运行中可折叠。
  check('ProcessGroup manualClosed 运行中可折叠', pg.includes('manualClosed'));

  // R5（问题 1）：动画点工作阶段常驻 + ThinkingBlock 脉冲动画点（首轮 pre-token 一闪即逝 + 静态 ··· ）。
  check('MessageList 动画点工作阶段常驻（turn-timer__working）', ml.includes('turn-timer__working') && ml.includes("v-if=\"!streamingContent\""));
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
  // api_retry 重试风暴快速中断 + tool 区绝对硬中断接线（#1/#4/#6）
  check('sdk-backend 追踪连续 api_retry 次数', sb.includes('consecutiveApiRetries'));
  check('sdk-backend touchActivityFromEvent 识别 api_retry 子类型', sb.includes("subtype === 'api_retry'"));
  check('sdk-backend 读 CLAUDE_LINK_STALL_TOOL_HARD_MS', sb.includes('CLAUDE_LINK_STALL_TOOL_HARD_MS'));
  check('sdk-backend 读 CLAUDE_LINK_MAX_API_RETRIES', sb.includes('CLAUDE_LINK_MAX_API_RETRIES'));
  check('sdk-backend MAX_API_RETRIES 快速中断文案', sb.includes('API 连续重试'));
  check('sdk-backend toolHardAbortMs 接入 STALL_THRESHOLDS', sb.includes('toolHardAbortMs'));
  check('sdk-backend aborting entry 不算 active', sb.includes('state: \'pending\' | \'running\' | \'aborting\' | \'finished\'') && sb.includes('isEntryActive') && sb.includes("entry.state !== 'aborting'"));
  check('sdk-backend 使用子 Agent tool_use 判断', sb.includes('isSubAgentToolUse(part)'));
  check('process-kind 暴露 isSubAgentToolUse', pk.includes('export function isSubAgentToolUse'));
  check('session-store 含 stalledInfo + activeStalledInfo', ss.includes('stalledInfo') && ss.includes('activeStalledInfo'));
  check('use-chat 处理当前/后台 stalled + retryLastTurn', uc.includes("case 'stalled'") && uc.includes('applyStalledEvent(store, sid, event)') && uc.includes('retryLastTurn'));
  check('StalledBanner 三动作', banner.includes('继续等待') && banner.includes('重试') && banner.includes('中断'));
  check('MessageList 挂载 StalledBanner 且 stalledInfo 可显形', ml.includes('StalledBanner') && ml.includes('activeStalledInfo'));
  check('selftest 串联 tdd-stall-watchdog-verify', pkg.includes('tdd-stall-watchdog-verify.ts'));
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

  // C. contextWindowOverride 双向（表单 ↔ env.CLAUDE_LINK_CONTEXT_WINDOW）
  const advWith = syncFormToAdvancedJson('{}', { apiKey: '', apiBaseUrl: 'https://api.anthropic.com', permissionMode: 'default', contextWindowOverride: 1000000 });
  check('contextWindowOverride=1000000 写入 env.CLAUDE_LINK_CONTEXT_WINDOW',
    JSON.parse(advWith).env?.CLAUDE_LINK_CONTEXT_WINDOW === '1000000', advWith);
  const advCleared = syncFormToAdvancedJson(advWith, { apiKey: '', apiBaseUrl: 'https://api.anthropic.com', permissionMode: 'default', contextWindowOverride: null });
  check('contextWindowOverride=null 删除 env.CLAUDE_LINK_CONTEXT_WINDOW',
    JSON.parse(advCleared).env?.CLAUDE_LINK_CONTEXT_WINDOW === undefined, advCleared);
  const peeked = parseClaudeSettings(JSON.stringify({ env: { CLAUDE_LINK_CONTEXT_WINDOW: '1000000' } }, null, 2));
  check('parseClaudeSettings 反向回填 contextWindowOverride=1000000', peeked.contextWindowOverride === 1000000, `got ${peeked.contextWindowOverride}`);

  // D. lookupModelWindow 内置表（最长前缀匹配 + 标准化）
  check('lookupModelWindow(glm-5.2)=1M', lookupModelWindow('glm-5.2') === 1000000, String(lookupModelWindow('glm-5.2')));
  check('lookupModelWindow 大小写/后缀容错(GLM-5.2-1m)=1M', lookupModelWindow('GLM-5.2-1m') === 1000000);
  check('lookupModelWindow(claude-fable-5)=1M', lookupModelWindow('claude-fable-5') === 1000000);
  check('lookupModelWindow(claude-sonnet-4-6)=200k', lookupModelWindow('claude-sonnet-4-6') === 200000);
  check('lookupModelWindow(deepseek-chat)=64k', lookupModelWindow('deepseek-chat') === 64000);
  check('lookupModelWindow(未知模型)=null', lookupModelWindow('some-unknown-model') === null);
  check('lookupModelWindow(null/空)=null', lookupModelWindow(null) === null && lookupModelWindow('') === null);

  // E. resolveContextWindow fallback 优先级
  check('优先 lastContextWindow', resolveContextWindow({ lastContextWindow: 500000, model: 'glm-5.2', override: 200000 }) === 500000);
  check('无 lastContextWindow 走模型查表', resolveContextWindow({ model: 'glm-5.2', override: 200000 }) === 1000000);
  check('无 lastContextWindow/无模型命中 走 override', resolveContextWindow({ model: 'unknown-model', override: 300000 }) === 300000);
  check('全无 → 200000 兜底', resolveContextWindow({ model: 'unknown-model' }) === 200000);
  check('lastContextWindow 非正数跳过', resolveContextWindow({ lastContextWindow: 0, model: 'glm-5.2' }) === 1000000);
}

console.log('\n=== 40) UI 简化：连接配置单卡片 + 会话内不调字号 ===');
{
  const cp = readRel('src/renderer/pages/ConfigPage.vue');
  const mm = readRel('src/renderer/components/config/ModelMappingInputs.vue');
  const st = readRel('src/renderer/components/chat/SessionToolbar.vue');
  const connectionBlock = cp.match(/<div v-show="activeTab === 'connection'"[\s\S]*?<!-- 行为：/)?.[0] ?? '';
  check('ConfigPage 不再导入 ProviderSelect', !cp.includes('ProviderSelect from'));
  check('ConfigPage 不再渲染 ProviderSelect 下拉', !cp.includes('<ProviderSelect'));
  check('连接区标题改为中性的连接配置', cp.includes('连接配置') && !cp.includes('<h3 class="section-title">供应商与端点</h3>'));
  check('连接区只保留一个 section 卡片', (connectionBlock.match(/<div class="section">/g) ?? []).length === 1);
  check('上下文窗口和模型映射不再作为独立标题', !connectionBlock.includes('<h3 class="section-title">上下文窗口和模型映射</h3>'));
  check('高级 JSON 不再作为独立标题', !connectionBlock.includes('<h3 class="section-title">高级 JSON</h3>'));
  check('ModelMappingInputs 不再展示长别名说明', !mm.includes('Claude Code 用 sonnet / haiku / opus / fable'));
  check('SessionToolbar 不再导入 FONT_SCALE_SIZES', !st.includes('FONT_SCALE_SIZES'));
  check('SessionToolbar 不再含会话内字号控件', !st.includes('onFontScaleChange') && !st.includes('<span class="ctl__label">字号</span>'));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
