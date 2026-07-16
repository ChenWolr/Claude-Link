import { strict as assert } from 'node:assert';
import MarkdownIt from 'markdown-it';

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
import { buildClaudeSettingsProjection } from '../src/main/modules/claude-settings-projection';
import { isMissingConversationResumeError } from '../src/main/modules/sdk-errors';
import { applyPermissionUpdates, buildPermissionSettings, coercePermissionUpdatesToSession, isToolSessionAllowed, withToolSessionAllow } from '../src/main/modules/sdk-permissions';
import { parseClaudeSettings } from '../src/main/modules/settings-importer';
import { normalizeSearchText } from '../src/main/utils/search-normalizer';
import { applyExternalLinkTarget, renderMarkdown } from '../src/renderer/utils/markdown';
import {
  getNavigationDisposition,
  isAllowedAppNavigation,
  shouldOpenExternally,
} from '../src/shared/external-links';

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

function testClaudeSettingsProjectionPreservesAdvancedSettings(): void {
  const settings = buildClaudeSettingsProjection({
    apiKey: 'sk-test',
    apiBaseUrl: 'https://example.com/v1',
    permissionMode: 'plan',
    advancedJson: JSON.stringify({
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2', NUMERIC_IGNORED: 123 },
      permissions: { allow: ['Read'] },
      hooks: [{ event: 'Stop', command: 'notify' }],
      alwaysThinkingEnabled: true,
    }),
  } as never);

  assert.deepEqual(settings.hooks, [{ event: 'Stop', command: 'notify' }]);
  assert.equal(settings.alwaysThinkingEnabled, true);
  assert.deepEqual(settings.permissions, { defaultMode: 'plan', allow: ['Read'] });
  assert.deepEqual(settings.env, {
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
    ANTHROPIC_API_KEY: 'sk-test',
    ANTHROPIC_BASE_URL: 'https://example.com/v1',
  });
}

function testSearchNormalizer(): void {
  assert.equal(normalizeSearchText('会 话\n1\t'), '会话1');
  assert.ok(normalizeSearchText('会话 1').includes(normalizeSearchText('会话1')));
}

function testMarkdownExternalLinks(): void {
  const markdownLink = renderMarkdown('[Example](https://example.com)');
  assert.ok(markdownLink.includes('target="_blank"'));
  assert.ok(markdownLink.includes('rel="noopener noreferrer"'));

  const linkifiedUrl = renderMarkdown('https://example.com');
  assert.ok(linkifiedUrl.includes('target="_blank"'));
  assert.ok(linkifiedUrl.includes('rel="noopener noreferrer"'));

  // 页内锚点 / mailto / 相对路径不应加 target=_blank：
  // 锚点加 _blank 会被 setWindowOpenHandler 静默 deny，破坏页内滚动；
  // mailto/tel 应走系统协议处理器，而非 window.open 路径。
  const anchorLink = renderMarkdown('[锚点](#section)');
  assert.ok(!anchorLink.includes('target="_blank"'));
  const mailtoLink = renderMarkdown('[联系](mailto:test@example.com)');
  assert.ok(!mailtoLink.includes('target="_blank"'));
  const relativeLink = renderMarkdown('[相对](./other)');
  assert.ok(!relativeLink.includes('target="_blank"'));

  const customMarkdown = new MarkdownIt();
  customMarkdown.core.ruler.after('inline', 'existing-link-attributes', (state) => {
    const linkOpen = state.tokens
      .flatMap((token) => token.children ?? [])
      .find((token) => token.type === 'link_open');
    linkOpen?.attrSet('target', '');
    linkOpen?.attrSet('rel', 'author noopener author');
  });
  customMarkdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
    tokens[index].attrSet('data-existing-rule', 'called');
    return renderer.renderToken(tokens, index, options);
  };
  applyExternalLinkTarget(customMarkdown);
  const customLink = customMarkdown.render('[Example](https://example.com)');
  assert.ok(customLink.includes('target=""'));
  assert.ok(customLink.includes('rel="author noopener noreferrer"'));
  assert.ok(customLink.includes('data-existing-rule="called"'));
}

function testInteractionPreviewMarkdownLinkTargetWiring(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const preview = fs.readFileSync(new URL('../src/renderer/components/chat/InteractionPreview.vue', import.meta.url), 'utf8');

  assert.ok(preview.includes("import { applyExternalLinkTarget } from '../../utils/markdown';"));
  const markdownInstanceIndex = preview.indexOf('const markdown = new MarkdownIt');
  const applyHelperIndex = preview.indexOf('applyExternalLinkTarget(markdown);');
  assert.ok(markdownInstanceIndex >= 0);
  assert.ok(applyHelperIndex > markdownInstanceIndex);
}

function testExternalLinks(): void {
  assert.equal(shouldOpenExternally('https://example.com'), true);
  assert.equal(shouldOpenExternally('http://example.com'), true);
  assert.equal(shouldOpenExternally('mailto:test@example.com'), true);
  assert.equal(shouldOpenExternally('HTTPS://example.com'), true);
  assert.equal(shouldOpenExternally('MAILTO:test@example.com'), true);
  assert.equal(shouldOpenExternally('ftp://example.com/file'), false);
  assert.equal(shouldOpenExternally('custom:payload'), false);
  assert.equal(shouldOpenExternally('javascript:alert(1)'), false);
  assert.equal(shouldOpenExternally('data:text/html,x'), false);
  assert.equal(shouldOpenExternally('file:///D:/secret.txt'), false);
  assert.equal(shouldOpenExternally('not a url'), false);
  assert.equal(shouldOpenExternally('/settings'), false);
  assert.equal(shouldOpenExternally('https://'), false);
  assert.equal(shouldOpenExternally('https://[::1'), false);
  assert.equal(shouldOpenExternally(''), false);

  const devRendererUrl = 'http://localhost:5173/';
  assert.equal(isAllowedAppNavigation('http://localhost:5173/settings', devRendererUrl), true);
  assert.equal(isAllowedAppNavigation('HTTP://LOCALHOST:5173/settings', devRendererUrl), true);
  assert.equal(isAllowedAppNavigation('http://localhost.evil.example:5173/', devRendererUrl), false);
  assert.equal(isAllowedAppNavigation('http://localhost:5174/settings', devRendererUrl), false);
  assert.equal(isAllowedAppNavigation('https://localhost:5173/settings', devRendererUrl), false);
  assert.equal(isAllowedAppNavigation('http://[::1', devRendererUrl), false);
  assert.equal(isAllowedAppNavigation('javascript:alert(1)', devRendererUrl), false);
  assert.equal(isAllowedAppNavigation('blob:http://localhost:5173/id', devRendererUrl), false);
  assert.equal(isAllowedAppNavigation('http://localhost:5173/settings', 'http://[::1'), false);
  assert.equal(isAllowedAppNavigation('http://localhost:5173/settings', ''), false);

  assert.equal(getNavigationDisposition('http://localhost:5173/settings', devRendererUrl), 'allow');
  assert.equal(getNavigationDisposition('https://example.com', devRendererUrl), 'open-external');
  assert.equal(getNavigationDisposition('mailto:test@example.com', devRendererUrl), 'open-external');
  assert.equal(getNavigationDisposition('blob:http://localhost:5173/id', devRendererUrl), 'block');
  assert.equal(getNavigationDisposition('file:///D:/app/index.html'), 'block');
  assert.equal(getNavigationDisposition('javascript:alert(1)', devRendererUrl), 'block');

  const customRendererUrl = 'https://127.0.0.1:4312/';
  assert.equal(isAllowedAppNavigation('https://127.0.0.1:4312/another?x=1#part', customRendererUrl), true);
  assert.equal(isAllowedAppNavigation('http://127.0.0.1:4312/another', customRendererUrl), false);
  assert.equal(isAllowedAppNavigation('file:///D:/app/index.html'), false);
  assert.equal(isAllowedAppNavigation('https://example.com'), false);
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
  const sdkSuggestion = { type: 'addRules' as const, rules: [{ toolName: 'Bash' }], behavior: 'allow' as const, destination: 'localSettings' as const };
  const sessionSuggestion = { ...sdkSuggestion, destination: 'session' as const };
  const payload = buildPermissionInteractionPayload('session-1', 'Bash', { command: 'npm run typecheck' }, {
    toolUseID: 'tool-1',
    signal: new AbortController().signal,
    suggestions: [sdkSuggestion],
    description: '需要运行类型检查',
  });

  assert.equal(payload.kind, 'permission');
  assert.equal(payload.toolName, 'Bash');
  assert.equal(payload.toolUseId, 'tool-1');
  assert.deepEqual(payload.options?.map((option) => option.id), ['allow', 'allow-session', 'deny']);
  assert.deepEqual(payload.suggestions, [sessionSuggestion]);
  assert.deepEqual(payload.defaultOptionIds, []);

  const invalidSuggestionPayload = buildPermissionInteractionPayload('session-1', 'Bash', { command: 'npm run typecheck' }, {
    toolUseID: 'tool-invalid',
    signal: new AbortController().signal,
    suggestions: [{ tool: 'Bash' }],
  });
  assert.deepEqual(invalidSuggestionPayload.options?.map((option) => option.id), ['allow', 'allow-session', 'deny']);
  assert.deepEqual(invalidSuggestionPayload.suggestions, [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }]);

  const noSuggestionPayload = buildPermissionInteractionPayload('session-1', 'WebFetch', { url: 'https://example.com' }, {
    toolUseID: 'tool-webfetch',
    signal: new AbortController().signal,
  });
  assert.deepEqual(noSuggestionPayload.options?.map((option) => option.id), ['allow', 'allow-session', 'deny']);
  assert.deepEqual(noSuggestionPayload.suggestions, [{ type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'allow', destination: 'session' }]);

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
    updatedPermissions: [sessionSuggestion],
    toolUseID: 'tool-1',
  });
  assert.deepEqual(mapPermissionInteractionResponse(noSuggestionPayload, { id: noSuggestionPayload.id, action: 'submit', selectedOptionIds: ['allow-session'] }, { url: 'https://example.com' }), {
    behavior: 'allow',
    updatedInput: { url: 'https://example.com' },
    updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'allow', destination: 'session' }],
    toolUseID: 'tool-webfetch',
  });
  assert.deepEqual(mapPermissionInteractionResponse(payload, { id: payload.id, action: 'cancel' }, permInput), {
    behavior: 'deny',
    message: '用户拒绝了该工具调用',
    toolUseID: 'tool-1',
  });
}

function testPermissionSettingsMergeAndSessionCoercion(): void {
  const base = buildPermissionSettings({
    permissionMode: 'default',
    advancedJson: JSON.stringify({ permissions: { allow: ['Read'], ask: ['Bash(git status)'], additionalDirectories: ['D:/work'] } }),
  });
  assert.deepEqual(base, { defaultMode: 'default', allow: ['Read'], ask: ['Bash(git status)'], additionalDirectories: ['D:/work'] });

  assert.deepEqual(applyPermissionUpdates(base, [
    { type: 'addRules', rules: [{ toolName: 'WebSearch' }], behavior: 'allow', destination: 'localSettings' },
  ]).allow, ['Read']);

  const normalized = coercePermissionUpdatesToSession([
    { type: 'addRules', rules: [{ toolName: 'WebSearch' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push*' }], behavior: 'ask', destination: 'session' },
    { type: 'removeRules', rules: [{ toolName: 'Bash', ruleContent: 'git status' }], behavior: 'ask', destination: 'session' },
    { type: 'setMode', mode: 'dontAsk', destination: 'session' },
    { type: 'addDirectories', directories: ['D:/tmp'], destination: 'session' },
    { type: 'removeDirectories', directories: ['D:/work'], destination: 'session' },
  ]);
  assert.deepEqual(normalized.map((update) => update.destination), ['session', 'session', 'session', 'session', 'session', 'session', 'session']);

  const merged = applyPermissionUpdates(base, normalized);
  assert.equal(merged.defaultMode, 'dontAsk');
  assert.deepEqual(merged.allow, ['Read', 'WebSearch', 'WebFetch(domain:example.com)']);
  assert.deepEqual(merged.ask, ['Bash(git push*)']);
  assert.deepEqual(merged.additionalDirectories, ['D:/tmp']);

  const replaced = applyPermissionUpdates(base, [{ type: 'replaceRules', rules: [{ toolName: 'Glob' }], behavior: 'allow', destination: 'session' }]);
  assert.deepEqual(replaced.allow, ['Glob']);

  assert.deepEqual(withToolSessionAllow('WebFetch', [
    { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow', destination: 'session' },
  ]), [
    { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'allow', destination: 'session' },
  ]);
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
  assert.deepEqual(payload.defaultOptionIds, []);
  assert.equal(payload.allowOther, true);
  assert.equal(payload.options?.at(-1)?.id, OTHER_INTERACTION_OPTION_ID);
  assert.equal(payload.options?.[1].preview, 'Preview B');

  const recommendedPayload = buildAskUserQuestionInteractionPayload('session-1', {
    ...question,
    options: [
      { label: 'A', description: 'First option' },
      { label: 'B (Recommended)', description: 'Second option' },
    ],
  }, 0, 'tool-ask-recommended');
  assert.deepEqual(recommendedPayload.defaultOptionIds, ['option-1']);

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

function testAllowSessionPermissionsSurviveNextSdkQuery(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const sb = fs.readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');

  // allow-session 返回的 updatedPermissions 不能只交给当前 query；claude-link 后续消息会新建 query + resume，
  // 必须按 app session 缓存并在下一次 buildSdkOptions 的 settings.permissions 中重新注入。
  assert.ok(sb.includes('sessionPermissionUpdates'));
  assert.ok(sb.includes('rememberSessionPermissionUpdates(sessionId'));
  assert.ok(sb.includes('applySessionPermissionUpdates(sessionId'));
  assert.ok(sb.includes('sessionPermissionUpdates.delete(sessionId)'));
}

function testToolSessionAllowedShortCircuit(): void {
  // 根因：CLI 在 --permission-prompt-tool stdio（headless）模式下，不据 canUseTool 返回的
  // updatedPermissions(destination:'session') 跳过后续同工具 prompt，导致同一会话同一工具反复弹窗。
  // claude-link 须在 canUseTool 弹窗前本地短路已授权工具。本测试锁定短路判定语义。

  // 1) allow-session 路径（withToolSessionAllow 保证补一条裸 allow + coerce 成 session）产出的规则，
  //    必须能被 isToolSessionAllowed 识别为「整工具已授权」，否则短路永不触发 = bug 复现。
  const allowSessionUpdates = coercePermissionUpdatesToSession(
    withToolSessionAllow('Bash', [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm install:*' }], behavior: 'allow', destination: 'localSettings' },
    ]),
  );
  assert.equal(isToolSessionAllowed(allowSessionUpdates, 'Bash'), true);
  // 未授权的工具不被短路。
  assert.equal(isToolSessionAllowed(allowSessionUpdates, 'Read'), false);

  // 2) 仅细粒度规则（带 ruleContent）不构成整工具放行——避免对同工具其它输入误放行。
  assert.equal(isToolSessionAllowed([
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm install:*' }], behavior: 'allow', destination: 'session' },
  ], 'Bash'), false);

  // 3) 非 session 目的地（如 localSettings）不计入会话短路。
  assert.equal(isToolSessionAllowed([
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' },
  ], 'Bash'), false);

  // 4) deny 规则不算授权。
  assert.equal(isToolSessionAllowed([
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
  ], 'Bash'), false);

  // 5) 空/undefined 不短路。
  assert.equal(isToolSessionAllowed(undefined, 'Bash'), false);
  assert.equal(isToolSessionAllowed([], 'Bash'), false);

  // 6) 短路确实接入 createPermissionHandler（弹窗前调用 isToolSessionAllowed）。
  const fs = require('node:fs') as typeof import('node:fs');
  const sb = fs.readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');
  assert.ok(
    sb.includes('isToolSessionAllowed(sessionBook, toolName)'),
    'createPermissionHandler 必须在弹窗前用 isToolSessionAllowed 短路本会话已授权工具',
  );
}

function testThinkingDisplaySummarizedEnabled(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const sb = fs.readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');

  // 新模型默认可能 omitted；显式 summarized 才能尽可能稳定收到可展示的 thinking 摘要。
  assert.ok(sb.includes("thinking: { type: 'adaptive', display: 'summarized' }"));
}

testApiUrlBuilder();
testSettingsImportPreservesNestedJson();
testClaudeSettingsProjectionPreservesAdvancedSettings();
testSearchNormalizer();
testMarkdownExternalLinks();
testInteractionPreviewMarkdownLinkTargetWiring();
testExternalLinks();
testMissingConversationResumeErrorDetection();
testMigrationsHandlePartiallyAppliedContextColumns();
testPermissionPromptIntegration();
testPermissionInteractionAdapter();
testPermissionSettingsMergeAndSessionCoercion();
testAskUserQuestionInteractionAdapter();
testInteractionPromptV2V3Contracts();
testInteractionPromptWizardAndHistoryContracts();
testGenericDialogTextAndFormContracts();
testAskUserQuestionMultiSelectAndOther();
testElicitationUrlMode();
testElicitationCancelMapping();
testStatusSubtypeCoverage();
testAllowSessionPermissionsSurviveNextSdkQuery();
testToolSessionAllowedShortCircuit();
testThinkingDisplaySummarizedEnabled();
