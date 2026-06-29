import { strict as assert } from 'node:assert';

import { runMigrations } from '../src/main/database/migrations';
import { buildAnthropicApiUrl } from '../src/main/modules/api-url';
import {
  OTHER_INTERACTION_OPTION_ID,
  SUPPORTED_USER_DIALOG_KINDS,
  buildAskUserQuestionInteractionPayload,
  buildAskUserQuestionResult,
  buildElicitationInteractionPayload,
  buildPermissionInteractionPayload,
  buildGenericInteractionPayload,
  buildWizardAskUserQuestionPayload,
  dialogResultFromInteraction,
  elicitationResultFromInteraction,
  interactionHistoryEntryFromResponse,
  mapPermissionInteractionResponse,
  normalizeInteractionPreview,
  shouldUseVirtualOptions,
} from '../src/main/modules/sdk-interactions';
import { isMissingConversationResumeError } from '../src/main/modules/sdk-errors';
import { parseClaudeSettings } from '../src/main/modules/settings-importer';
import { normalizeSearchText } from '../src/main/utils/search-normalizer';

function testApiUrlBuilder(): void {
  assert.equal(buildAnthropicApiUrl('https://api.anthropic.com', 'models').toString(), 'https://api.anthropic.com/v1/models');
  assert.equal(buildAnthropicApiUrl('https://api.anthropic.com/v1', 'models').toString(), 'https://api.anthropic.com/v1/models');
  assert.equal(buildAnthropicApiUrl('https://example.com/', '/messages').toString(), 'https://example.com/v1/messages');
  assert.equal(buildAnthropicApiUrl('https://example.com/v1/', 'messages').toString(), 'https://example.com/v1/messages');
}

function testSettingsImportPreservesNestedJson(): void {
  const imported = parseClaudeSettings(JSON.stringify({
    apiKey: 'sk-test',
    apiBaseUrl: 'https://example.com/v1',
    model: 'claude-opus-4-8',
    permissions: { allow: ['Bash(npm run typecheck)'] },
    hooks: [{ event: 'Stop', command: 'notify' }],
    alwaysThinkingEnabled: true,
  }));

  assert.equal(imported.apiKey, 'sk-test');
  assert.equal(imported.apiBaseUrl, 'https://example.com/v1');
  assert.equal(imported.defaultModel, 'claude-opus-4-8');
  assert.deepEqual(JSON.parse(imported.advancedJson), {
    permissions: { allow: ['Bash(npm run typecheck)'] },
    hooks: [{ event: 'Stop', command: 'notify' }],
    alwaysThinkingEnabled: true,
  });
}

function testSearchNormalizer(): void {
  assert.equal(normalizeSearchText('会 话\n1\t'), '会话1');
  assert.ok(normalizeSearchText('会话 1').includes(normalizeSearchText('会话1')));
}

function testMissingConversationResumeErrorDetection(): void {
  assert.equal(
    isMissingConversationResumeError(
      new Error('Claude Code returned an error result: No conversation found with session ID: 026eb341-6b20-4c1e-a3f9-2fe659d37a6f'),
    ),
    true,
  );
  assert.equal(isMissingConversationResumeError(new Error('No active SDK query for session abc')), false);
}

function testMigrationsHandlePartiallyAppliedContextColumns(): void {
  const sessionColumns = new Set([
    'id',
    'name',
    'cli_session_id',
    'model',
    'working_dir',
    'permission_mode',
    'max_turns',
    'model_override',
    'last_context_tokens',
    'created_at',
    'updated_at',
  ]);
  const messageColumns = new Set([
    'id',
    'session_id',
    'role',
    'content',
    'raw_event',
    'event_type',
    'cost_usd',
    'duration_ms',
    'parent_task_id',
    'created_at',
  ]);
  let schemaVersion = 2;

  const addColumn = (table: string, column: string): void => {
    const columns = table === 'sessions' ? sessionColumns : messageColumns;
    if (columns.has(column)) {
      throw new Error(`duplicate column name: ${column}`);
    }
    columns.add(column);
  };

  const db = {
    exec(sql: string) {
      for (const [, table, column] of sql.matchAll(/ALTER TABLE (sessions|messages) ADD COLUMN (\w+)/g)) {
        addColumn(table, column);
      }
    },
    prepare(sql: string) {
      return {
        get() {
          if (sql.includes('SELECT version FROM schema_version')) {
            return { version: schemaVersion };
          }
          throw new Error(`Unexpected get SQL: ${sql}`);
        },
        all() {
          if (sql.includes('PRAGMA table_info(sessions)')) {
            return Array.from(sessionColumns, (name) => ({ name }));
          }
          if (sql.includes('PRAGMA table_info(messages)')) {
            return Array.from(messageColumns, (name) => ({ name }));
          }
          throw new Error(`Unexpected all SQL: ${sql}`);
        },
        run(version: number) {
          schemaVersion = version;
        },
      };
    },
  };

  assert.doesNotThrow(() => runMigrations(db as never));
  assert.equal(schemaVersion, 3);
  assert.ok(sessionColumns.has('last_context_tokens'));
  assert.ok(sessionColumns.has('last_context_updated_at'));
}

function testPermissionPromptIntegration(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const sdkBackend = fs.readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');
  const ipcTypes = fs.readFileSync(new URL('../src/shared/types/ipc.ts', import.meta.url), 'utf8');
  const cliTypes = fs.readFileSync(new URL('../src/shared/types/cli.ts', import.meta.url), 'utf8');
  const preloadApi = fs.readFileSync(new URL('../src/preload/api.ts', import.meta.url), 'utf8');
  const ipcHandlers = fs.readFileSync(new URL('../src/main/ipc-handlers.ts', import.meta.url), 'utf8');
  const appVue = fs.readFileSync(new URL('../src/renderer/App.vue', import.meta.url), 'utf8');

  assert.ok(ipcTypes.includes('PERMISSION_REQUEST'));
  assert.ok(ipcTypes.includes('PERMISSION_RESPOND'));
  assert.ok(ipcTypes.includes('PermissionRequestPayload'));
  assert.ok(ipcTypes.includes('INTERACTION_REQUEST'));
  assert.ok(ipcTypes.includes('INTERACTION_RESPOND'));
  assert.ok(ipcTypes.includes('INTERACTION_CANCEL'));
  assert.ok(ipcTypes.includes('InteractionPromptPayload'));
  assert.ok(cliTypes.includes("'permission_request' | 'permission_denied'"));
  assert.ok(preloadApi.includes('onPermissionRequest'));
  assert.ok(preloadApi.includes('respondPermission'));
  assert.ok(preloadApi.includes('onInteractionRequest'));
  assert.ok(preloadApi.includes('onInteractionCancel'));
  assert.ok(preloadApi.includes('respondInteraction'));
  assert.ok(ipcHandlers.includes('respondToInteractionPrompt'));
  assert.ok(sdkBackend.includes('canUseTool: createPermissionHandler(sessionId, mainWindow)'));
  assert.ok(sdkBackend.includes('supportedDialogKinds'));
  assert.ok(sdkBackend.includes('onUserDialog'));
  assert.ok(sdkBackend.includes('requestInteraction'));
  assert.ok(appVue.includes('<InteractionPrompt />'));
}

function testPermissionInteractionAdapter(): void {
  const payload = buildPermissionInteractionPayload('session-1', 'Bash', { command: 'npm run typecheck' }, {
    toolUseID: 'tool-1',
    signal: new AbortController().signal,
    suggestions: [{ tool: 'Bash' }],
    description: '需要运行类型检查',
  });

  assert.equal(payload.kind, 'permission');
  assert.equal(payload.toolName, 'Bash');
  assert.equal(payload.toolUseId, 'tool-1');
  assert.deepEqual(payload.options?.map((option) => option.id), ['allow', 'allow-session', 'deny']);

  const permInput = { command: 'npm run typecheck' };
  // P0：allow/allow-session 必须回传 updatedInput（原样 input），否则 SDK 运行时 ZodError 阻断所有工具。
  assert.deepEqual(mapPermissionInteractionResponse(payload, { id: payload.id, action: 'submit', selectedOptionIds: ['allow'] }, permInput), {
    behavior: 'allow',
    updatedInput: permInput,
    toolUseID: 'tool-1',
  });
  assert.deepEqual(mapPermissionInteractionResponse(payload, { id: payload.id, action: 'submit', selectedOptionIds: ['allow-session'] }, permInput), {
    behavior: 'allow',
    updatedInput: permInput,
    updatedPermissions: [{ tool: 'Bash' }],
    toolUseID: 'tool-1',
  });
  assert.deepEqual(mapPermissionInteractionResponse(payload, { id: payload.id, action: 'cancel' }, permInput), {
    behavior: 'deny',
    message: '用户拒绝了该工具调用',
    toolUseID: 'tool-1',
  });
}

function testAskUserQuestionInteractionAdapter(): void {
  const question = {
    question: 'Which approach should we use?',
    header: 'Approach',
    multiSelect: false,
    options: [
      { label: 'A', description: 'First option' },
      { label: 'B', description: 'Second option', preview: 'Preview B' },
    ],
  };
  const payload = buildAskUserQuestionInteractionPayload('session-1', question, 0, 'tool-ask');

  assert.equal(payload.kind, 'single-choice');
  assert.equal(payload.source, 'Approach');
  assert.equal(payload.defaultOptionIds?.[0], 'option-0');
  assert.equal(payload.allowOther, true);
  assert.equal(payload.options?.at(-1)?.id, OTHER_INTERACTION_OPTION_ID);
  assert.equal(payload.options?.[1].preview, 'Preview B');

  const result = buildAskUserQuestionResult([question], [{
    payload,
    response: { id: payload.id, action: 'submit', selectedOptionIds: ['option-1'] },
  }]);

  assert.deepEqual(result.answers, { 'Which approach should we use?': 'B' });
  assert.deepEqual(result.annotations, { 'Which approach should we use?': { preview: 'Preview B' } });
}

function testInteractionPromptV2V3Contracts(): void {
  const markdown = normalizeInteractionPreview('**Plan**\n\n- Ship it', 'markdown');
  assert.deepEqual(markdown, { type: 'markdown', content: '**Plan**\n\n- Ship it' });
  const code = normalizeInteractionPreview({ type: 'code', content: 'const x = 1;', language: 'ts' });
  assert.deepEqual(code, { type: 'code', content: 'const x = 1;', language: 'ts' });
  const table = normalizeInteractionPreview({ type: 'table', headers: ['A'], rows: [['B']] });
  assert.deepEqual(table, { type: 'table', headers: ['A'], rows: [['B']] });

  assert.equal(shouldUseVirtualOptions(Array.from({ length: 30 }, (_, index) => ({ id: String(index), label: String(index) }))), false);
  assert.equal(shouldUseVirtualOptions(Array.from({ length: 80 }, (_, index) => ({ id: String(index), label: String(index) }))), true);
}

function testInteractionPromptWizardAndHistoryContracts(): void {
  const questions = [
    {
      question: 'Pick a runtime?',
      header: 'Runtime',
      multiSelect: false,
      options: [
        { label: 'Node', description: 'Use Node.js' },
        { label: 'Bun', description: 'Use Bun' },
      ],
    },
    {
      question: 'Pick checks?',
      header: 'Checks',
      multiSelect: true,
      options: [
        { label: 'Types', description: 'Run typecheck' },
        { label: 'Tests', description: 'Run tests' },
      ],
    },
  ];
  const wizard = buildWizardAskUserQuestionPayload('session-1', questions, 'tool-wizard', 'fixed-id');
  assert.equal(wizard.kind, 'form');
  assert.equal(wizard.questions?.length, 2);
  assert.equal(wizard.questions?.[1].multiSelect, true);
  assert.equal(wizard.questions?.[0].options.at(-1)?.id, OTHER_INTERACTION_OPTION_ID);

  const result = buildAskUserQuestionResult(questions, [{
    payload: wizard,
    response: {
      id: wizard.id,
      action: 'submit',
      questionAnswers: {
        q0: { selectedOptionIds: ['option-1'] },
        q1: { selectedOptionIds: ['option-0', OTHER_INTERACTION_OPTION_ID], otherText: 'Lint' },
      },
    },
  }]);
  assert.deepEqual(result.answers, {
    'Pick a runtime?': 'Bun',
    'Pick checks?': 'Types, Lint',
  });

  const history = interactionHistoryEntryFromResponse(wizard, {
    id: wizard.id,
    action: 'submit',
    fieldValues: { note: 'approved', urgent: true },
  });
  assert.equal(history.promptId, 'fixed-id');
  assert.equal(history.kind, 'form');
  assert.equal(history.action, 'submit');
  assert.deepEqual(history.fieldValues, { note: 'approved', urgent: true });
}

function testGenericDialogTextAndFormContracts(): void {
  const textPayload = buildGenericInteractionPayload('session-1', 'free_text', {
    title: 'Explain why?',
    inputType: 'text',
  }, 'tool-text');
  assert.equal(textPayload.kind, 'text');
  assert.equal(textPayload.title, 'Explain why?');
  assert.deepEqual(dialogResultFromInteraction({ id: textPayload.id, action: 'submit', otherText: 'Because it is safer' }), {
    response: 'Because it is safer',
  });

  const formPayload = buildGenericInteractionPayload('session-1', 'collect_params', {
    title: 'Collect params',
    requestedSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', title: 'Name' },
        dryRun: { type: 'boolean', title: 'Dry run' },
        mode: { type: 'string', title: 'Mode', enum: ['fast', 'safe'] },
      },
    },
  });
  assert.equal(formPayload.kind, 'form');
  assert.deepEqual(formPayload.fields?.map((field) => [field.id, field.type, field.required]), [
    ['name', 'text', true],
    ['dryRun', 'checkbox', false],
    ['mode', 'select', false],
  ]);
  assert.deepEqual(dialogResultFromInteraction({ id: formPayload.id, action: 'submit', fieldValues: { name: 'Chen', dryRun: true, mode: 'safe' } }), {
    name: 'Chen',
    dryRun: true,
    mode: 'safe',
  });
}

function testAskUserQuestionMultiSelectAndOther(): void {
  const questions = [
    {
      question: 'Which features do you want to enable?',
      header: 'Features',
      multiSelect: true,
      options: [
        { label: 'Logs', description: 'Enable logs' },
        { label: 'Metrics', description: 'Enable metrics' },
      ],
    },
    {
      question: 'Which library should we use?',
      header: 'Library',
      multiSelect: false,
      options: [
        { label: 'Built-in', description: 'Use platform APIs' },
        { label: 'Package', description: 'Install dependency' },
      ],
    },
  ];
  const firstPayload = buildAskUserQuestionInteractionPayload('session-1', questions[0], 0);
  const secondPayload = buildAskUserQuestionInteractionPayload('session-1', questions[1], 1);
  const result = buildAskUserQuestionResult(questions, [
    { payload: firstPayload, response: { id: firstPayload.id, action: 'submit', selectedOptionIds: ['option-0', 'option-1'] } },
    { payload: secondPayload, response: { id: secondPayload.id, action: 'submit', selectedOptionIds: [OTHER_INTERACTION_OPTION_ID], otherText: 'Use local helper' } },
  ]);

  assert.equal(result.answers['Which features do you want to enable?'], 'Logs, Metrics');
  assert.equal(result.answers['Which library should we use?'], 'Use local helper');
  assert.equal(result.response, 'Use local helper');

  const combined = buildAskUserQuestionResult([questions[0]], [
    { payload: firstPayload, response: { id: firstPayload.id, action: 'submit', selectedOptionIds: ['option-0', OTHER_INTERACTION_OPTION_ID], otherText: 'Tracing' } },
  ]);
  assert.equal(combined.answers['Which features do you want to enable?'], 'Logs, Tracing');
  assert.ok(SUPPORTED_USER_DIALOG_KINDS.includes('plan_mode'));
}

// T13/M4：onElicitation 的 url 模式（MCP 浏览器 OAuth）。
function testElicitationUrlMode(): void {
  // url 模式 → confirm 框，input 带 url，用户复制去浏览器完成授权。
  const urlPayload = buildElicitationInteractionPayload('session-1', {
    serverName: 'github',
    message: 'Authorize GitHub',
    mode: 'url',
    url: 'https://github.com/login/oauth/authorize?client_id=abc',
    elicitationId: 'elicit-1',
  });
  assert.equal(urlPayload.kind, 'confirm');
  assert.equal(urlPayload.toolUseId, 'elicit-1');
  assert.equal((urlPayload.input as { url?: string }).url, 'https://github.com/login/oauth/authorize?client_id=abc');
  assert.deepEqual(urlPayload.options?.map((option) => option.id), ['confirm']);

  // form 模式 → 通用表单（不退化为 url 确认框）。
  const formPayload = buildElicitationInteractionPayload('session-1', {
    serverName: 'db',
    message: 'Configure DB',
    mode: 'form',
    requestedSchema: {
      type: 'object',
      required: ['host'],
      properties: { host: { type: 'string', title: 'Host' } },
    },
  });
  assert.equal(formPayload.kind, 'form');
  assert.deepEqual(formPayload.fields?.map((field) => [field.id, field.required]), [['host', true]]);

  // text 模式（无 mode）→ 通用文本输入。
  const textPayload = buildElicitationInteractionPayload('session-1', {
    serverName: 'notes',
    message: 'Enter a note',
  });
  assert.equal(textPayload.kind, 'text');
}

// T12/M3：onElicitation submit → accept，非 submit → cancel。
// （decline 语义保留给将来 UI 增加「拒绝」按钮时再放开——先写失败测试再放开，不测不可达分支。）
function testElicitationCancelMapping(): void {
  // submit → accept（带 content：fieldValues 优先，否则 otherText）。
  const accepted = elicitationResultFromInteraction({ id: 'r1', action: 'submit', fieldValues: { answer: 'yes' } });
  assert.equal(accepted.action, 'accept');
  assert.deepEqual(accepted.content, { answer: 'yes' });

  const acceptedOther = elicitationResultFromInteraction({ id: 'r1b', action: 'submit', otherText: 'typed' });
  assert.deepEqual(acceptedOther.content, { response: 'typed' });

  // 非 submit（用户关闭/中断）→ cancel。
  assert.equal(elicitationResultFromInteraction({ id: 'r3', action: 'cancel' }).action, 'cancel');
}

// T14/M5：status 子类型扩展（compact_result/compact_error/requesting 不再静默丢弃）。
function testStatusSubtypeCoverage(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const cliTypes = fs.readFileSync(new URL('../src/shared/types/cli.ts', import.meta.url), 'utf8');
  const sb = fs.readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');

  // cli.ts 类型覆盖新增三个 status 相关 subtype。
  assert.ok(cliTypes.includes("'compact_result'"));
  assert.ok(cliTypes.includes("'compact_error'"));
  assert.ok(cliTypes.includes("'requesting'"));
  assert.ok(cliTypes.includes('compactResult?'));
  assert.ok(cliTypes.includes('compactError?'));

  // sdk-backend 转发 compact_result / compact_error / requesting。
  assert.ok(sb.includes("subtype: 'compact_result'"));
  assert.ok(sb.includes('compact_result !== undefined'));
  assert.ok(sb.includes("sdkMsg.status === 'requesting'"));
}

testApiUrlBuilder();
testSettingsImportPreservesNestedJson();
testSearchNormalizer();
testMissingConversationResumeErrorDetection();
testMigrationsHandlePartiallyAppliedContextColumns();
testPermissionPromptIntegration();
testPermissionInteractionAdapter();
testAskUserQuestionInteractionAdapter();
testInteractionPromptV2V3Contracts();
testInteractionPromptWizardAndHistoryContracts();
testGenericDialogTextAndFormContracts();
testAskUserQuestionMultiSelectAndOther();
testElicitationUrlMode();
testElicitationCancelMapping();
testStatusSubtypeCoverage();
