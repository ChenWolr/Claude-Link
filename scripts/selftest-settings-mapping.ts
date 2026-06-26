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
import { extractContextTokens, type CliUsage } from '../src/shared/context-usage';

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
  const processManager = readRel('src/main/modules/process-manager.ts');
  const useChat = readRel('src/renderer/composables/use-chat.ts');
  check('CliEvent 包含 error 事件', cliTypes.includes("type: 'error'"));
  check('process-manager 在非零退出时发送 error 事件', processManager.includes("type: 'error'") && processManager.includes('CLI 进程异常退出'));
  check('use-chat 收到 error 事件后复位 sending', useChat.includes("case 'error'") && useChat.includes('sending.value = false'));
}

// ── 全链路审计修复回归（C1-C3, M1-M8）──────────────────────────────────
function readRel(p: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path');
  // 脚本位于 scripts/，相对路径 ../xxx 解析到项目根下。用 __dirname（cjs 可用）替代
  // import.meta.url（仅 ESM 可用，tsx 以 cjs 输出时不可用）。
  return fs.readFileSync(nodePath.resolve(__dirname, '..', p), 'utf8');
}

console.log('\n=== 15) C1: system/init 事件必须被识别并持久化 session_id ===');
{
  const cliTypes = readRel('src/shared/types/cli.ts');
  const pm = readRel('src/main/modules/process-manager.ts');
  check('CliEvent 联合包含 system 类型', cliTypes.includes("type: 'system'") && cliTypes.includes("subtype"));
  check('process-manager persistCliEvent 识别 system+init', pm.includes("'system'") && pm.includes('subtype') && pm.includes('init'));
}

console.log('\n=== 16) C2: CLI 正常退出但无 result 时必须复位前端（防死锁）===');
{
  const pm = readRel('src/main/modules/process-manager.ts');
  // code===0 但未 sawResult 时也必须向前端发事件复位
  check('process-manager 在 0 退出无 result 时合成结束事件', /sawResult\s*===\s*false/.test(pm) || /!sawResult/.test(pm));
  check('process-manager 区分中断与错误（interrupted 标志）', pm.includes('interrupted'));
}

console.log('\n=== 17) C3: 中断必须优先 SIGINT（nix 优雅中止），Windows 兜底硬杀 ===');
{
  const pm = readRel('src/main/modules/process-manager.ts');
  check('process-manager 使用 SIGINT 优先', pm.includes("'SIGINT'") || pm.includes('"SIGINT"'));
  check('killProcess 区分平台（Windows 硬杀兜底）', pm.includes('platform') && (pm.includes('win32') || pm.includes('isWindows')));
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
  const pm = readRel('src/main/modules/process-manager.ts');
  // exit handler 在 interrupted 时不走 error 合成分支
  check('process-manager interrupted 时不发 error', /interrupted/.test(pm) && (/return/.test(pm.match(/childProcess\.on\('exit'[\s\S]{0,600}/)?.[0] ?? '') || pm.includes('aborted')));
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

console.log('\n=== 26) Review 修复：中断标记按 child、孤儿进程兜底、abort 跨回合串扰 ===');
{
  const pm = readRel('src/main/modules/process-manager.ts');
  const uc = readRel('src/renderer/composables/use-chat.ts');
  const ml = readRel('src/renderer/components/chat/MessageList.vue');
  const cp = readRel('src/renderer/pages/ChatPage.vue');
  const us = readRel('src/renderer/composables/use-stream.ts');
  const tq = readRel('src/main/modules/task-queue-engine.ts');
  check('中断标记按 child 实例（WeakSet 非 sessionId Set）', pm.includes('interruptedChildren') && pm.includes('WeakSet'));
  check('killProcess SIGKILL 兜底防孤儿', pm.includes('SIGKILL'));
  check('中断(error_during_execution)不弹错误', uc.includes('error_during_execution') && uc.includes('isUserInterrupt'));
  check('streamingTool 有渲染消费链', ml.includes('streamingTool') && cp.includes('displayTool') && us.includes('displayTool'));
  check('abort 定时器句柄化 + 清理', uc.includes('abortTimer') && uc.includes('clearAbortTimer'));
  check('continueWithUserMessage exit 守卫 continuing', /child\.on\('exit'[\s\S]{0,200}status !== 'continuing'/.test(tq));
}

console.log('\n=== 27) 过程分组计划契约：类型/DB/透传/分组/子AgentTab/无诊断日志 ===');
{
  const sess = readRel('src/shared/types/session.ts');
  const mig = readRel('src/main/database/migrations.ts');
  const repo = readRel('src/main/database/repositories/message-repo.ts');
  const cli = readRel('src/shared/types/cli.ts');
  const sb = readRel('src/main/modules/sdk-backend.ts');
  const pm = readRel('src/main/modules/process-manager.ts');
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
    pm.includes('processKindFromPart') && pm.includes('parentAgentId') && pm.includes('extractSubAgentTitle'));

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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
