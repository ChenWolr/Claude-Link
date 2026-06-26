import { strict as assert } from 'node:assert';

import { runMigrations } from '../src/main/database/migrations';
import { buildAnthropicApiUrl } from '../src/main/modules/api-url';
import {
  OTHER_INTERACTION_OPTION_ID,
  SUPPORTED_USER_DIALOG_KINDS,
  buildAskUserQuestionInteractionPayload,
  buildAskUserQuestionResult,
  buildPermissionInteractionPayload,
  mapPermissionInteractionResponse,
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

  assert.deepEqual(mapPermissionInteractionResponse(payload, { id: payload.id, action: 'submit', selectedOptionIds: ['allow'] }), {
    behavior: 'allow',
    toolUseID: 'tool-1',
  });
  assert.deepEqual(mapPermissionInteractionResponse(payload, { id: payload.id, action: 'submit', selectedOptionIds: ['allow-session'] }), {
    behavior: 'allow',
    updatedPermissions: [{ tool: 'Bash' }],
    toolUseID: 'tool-1',
  });
  assert.deepEqual(mapPermissionInteractionResponse(payload, { id: payload.id, action: 'cancel' }), {
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

testApiUrlBuilder();
testSettingsImportPreservesNestedJson();
testSearchNormalizer();
testMissingConversationResumeErrorDetection();
testMigrationsHandlePartiallyAppliedContextColumns();
testPermissionPromptIntegration();
testPermissionInteractionAdapter();
testAskUserQuestionInteractionAdapter();
testAskUserQuestionMultiSelectAndOther();
