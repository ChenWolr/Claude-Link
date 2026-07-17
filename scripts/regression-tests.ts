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
import { applyExternalLinkTarget, applyImageProtocolFilter, createPreviewMarkdownRenderer, isDiffContent, renderDiffHtml, renderDiffHtmlWithRenderer, renderMarkdown } from '../src/renderer/utils/markdown';
import { synthesizeToolDiff } from '../src/renderer/utils/tool-diff';
import { shouldSkipMermaidErrorRetry, summarizeMermaidAccessibleTitle } from '../src/renderer/directives/enrich-markdown';
import {
  getNavigationDisposition,
  isAllowedAppNavigation,
  isAllowedMarkdownImageUrl,
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

  assert.ok(
    /import\s*\{[^}]*\bcreatePreviewMarkdownRenderer\b[^}]*\}\s*from\s*'[^']*\/utils\/markdown';/.test(preview),
    'InteractionPreview 须从 markdown utils 导入共享 Preview MarkdownIt 工厂',
  );
  assert.ok(preview.includes('createPreviewMarkdownRenderer'), 'InteractionPreview 须使用共享 Preview MarkdownIt 工厂');
}

function testExternalLinks(): void {
  assert.equal(shouldOpenExternally('https://example.com'), true);
  assert.equal(shouldOpenExternally('http://example.com'), true);
  assert.equal(shouldOpenExternally('mailto:test@example.com'), true);
  assert.equal(shouldOpenExternally('tel:+8612345'), true);
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

// ── Markdown 排版契约 ────────────────────────────────────────────────
// P1：解析器对核心块级元素的 HTML 输出回归锁（解析本就正确，锁住防回归）。
function testMarkdownParserEmitsCoreBlocks(): void {
  const table = renderMarkdown('| h1 | h2 |\n|----|----|\n| a | b |');
  assert.ok(table.includes('<table>'));
  assert.ok(table.includes('<th>'));
  assert.ok(renderMarkdown('## 标题').includes('<h2>'));
  assert.ok(renderMarkdown('> 备注').includes('<blockquote>'));
  assert.ok(renderMarkdown('- a\n- b').includes('<ul>'));
  assert.ok(renderMarkdown('1. a\n2. b').includes('<ol>'));
  assert.ok(renderMarkdown('a\n\n---\n\nb').includes('<hr'));
  assert.ok(renderMarkdown('用 `x` 命令').includes('<code>'));
  assert.ok(renderMarkdown('![图](http://x/y.png)').includes('<img'));
}

// P1：.markdown-body 必须为核心元素提供样式。此前仅 a / .code-block / diff 有样式，
// 其余裸奔——顺德天气表格即因缺表格 CSS 而丑陋。读取 main.css 断言关键选择器存在。
// 先红后绿：补 CSS 前这些断言全失败。
function testMarkdownBodyCssCoversCoreElements(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const css = fs.readFileSync(new URL('../src/renderer/assets/styles/main.css', import.meta.url), 'utf8');

  // 表格：必须显式排除 diff 专用表 .d2h-diff-table（它有独立调校，不能被通用表规则覆盖）。
  assert.ok(css.includes('.markdown-body table:not(.d2h-diff-table)'), '缺表格样式（顺德天气 bug 根因）');
  assert.ok(css.includes('.markdown-body table:not(.d2h-diff-table) thead'), '缺表头样式');
  assert.ok(css.includes('.markdown-body blockquote'), '缺引用样式');
  assert.ok(css.includes('.markdown-body h1'), '缺标题样式');
  assert.ok(css.includes('.markdown-body h2'), '缺 h2 样式');
  assert.ok(css.includes('.markdown-body ul'), '缺无序列表样式');
  assert.ok(css.includes('.markdown-body ol'), '缺有序列表样式');
  assert.ok(css.includes('.markdown-body hr'), '缺分割线样式');
  assert.ok(css.includes('.markdown-body code:not(pre code)'), '缺行内 code 样式（须排除 pre 内块级 code）');
  assert.ok(css.includes('.markdown-body img'), '缺图片样式');
}

// P1：工具结果里的 markdown 段落间距必须用 rem（跟 --font-size-base 三档缩放），
// 不能是固定 px——否则 large 档位下不放大。先红后绿。
function testToolCallBlockMarkdownParagraphUsesRem(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const src = fs.readFileSync(new URL('../src/renderer/components/chat/ToolCallBlock.vue', import.meta.url), 'utf8');
  assert.ok(!src.includes('0 0 6px'), 'ToolCallBlock 的 .markdown-body p 间距仍用固定 px，应改 rem');
  assert.ok(src.includes('0 0 0.375rem'), 'ToolCallBlock 的 .markdown-body p 间距应为 0 0 0.375rem');
}

// 任务列表：- [ ] / - [x] 必须渲染成勾选框（当前 markdown-it 无 task-list 插件，输出字面 [ ]）。
function testMarkdownTaskListCheckboxes(): void {
  const out = renderMarkdown('- [ ] todo\n- [x] done');
  assert.ok(out.includes('task-list-item'), '任务列表项需带 task-list-item class');
  assert.ok(out.includes('<input'), '任务列表需渲染 checkbox input');
  assert.ok(out.includes('type="checkbox"'), 'checkbox 需为 type=checkbox');
  assert.ok(out.includes('checked'), '已勾选项 [x] 需渲染为 checked');

  const fs = require('node:fs') as typeof import('node:fs');
  const css = fs.readFileSync(new URL('../src/renderer/assets/styles/main.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.markdown-body .task-list-item'), '缺任务列表项样式（去圆点/对齐勾选框）');
}

// 数学公式：$...$ 行内 / $$...$$ 块级需经 KaTeX 渲染（当前 markdown-it 无数学支持，输出字面 $）。
function testMarkdownMathKatex(): void {
  const inline = renderMarkdown('公式 $E=mc^2$ 在文中');
  assert.ok(inline.includes('katex'), '行内公式需经 KaTeX 渲染（含 katex class）');
  const block = renderMarkdown('$$\\sum_{i=1}^n x_i$$');
  assert.ok(block.includes('katex'), '块级公式需经 KaTeX 渲染');
}

// Mermaid：```mermaid 代码块需产出自定义容器（携带原始源 data-mermaid）供前端懒渲染，
// 而非回落为 plaintext 普通代码块。SVG 实际渲染需 DOM+mermaid 运行时，归 GUI 目视。
function testMarkdownMermaidEmitsContainer(): void {
  const out = renderMarkdown('```mermaid\ngraph TD\nA-->B\n```');
  assert.ok(out.includes('mermaid-block'), 'mermaid 块需产出自定义容器 mermaid-block');
  assert.ok(out.includes('data-mermaid'), '容器需携带原始 mermaid 源 data-mermaid 供前端渲染');
  assert.ok(!out.includes('>plaintext<'), 'mermaid 不应回落为 plaintext 代码块');
}

// 图片灯箱：![alt](url) 的 <img> 需带 md-img 钩子（供前端点击放大），当前是裸 <img>。
// 模态交互需 DOM，归 GUI 目视；契约只锁定钩子注入。
function testMarkdownImageLightboxHook(): void {
  const out = renderMarkdown('![图](http://x/y.png)');
  assert.ok(out.includes('md-img'), '图片需带 md-img 钩子供灯箱识别');
  assert.ok(out.includes('http://x/y.png'), '图片 src 须保留');
}

function testMarkdownFenceStructure(): void {
  const raw = `const value = "<&'";\n`;
  const code = renderMarkdown(`\`\`\`ts\n${raw}\`\`\``);
  assert.equal((code.match(/class="code-block"/g) ?? []).length, 1, '普通 fence 只能有一层 code-block');
  assert.ok(!/<pre><code[^>]*>\s*<div class="code-block"/.test(code), '普通 fence 不能把块级 div 包进 code');
  assert.ok(code.includes('language-ts'), '已知语言须保留高亮语言');
  assert.ok(code.includes('&lt;'), '代码中的 < 须转义');

  const unknown = renderMarkdown('```not-a-language\nhello\n```');
  assert.ok(unknown.includes('language-plaintext'), '未知语言须回退 plaintext');

  const diff = renderMarkdown('```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n```');
  assert.ok(diff.includes('code-block--diff'));
  assert.ok(!/<pre><code[^>]*>\s*<div class="code-block code-block--diff"/.test(diff), 'diff 不能被默认 fence 再包装');
  assert.equal((diff.match(/class="[^"]*\bd2h-wrapper\b[^"]*"/g) ?? []).length, 1, 'diff2html wrapper 只能有一层');

  const patch = renderMarkdown('```patch\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n```');
  assert.ok(patch.includes('code-block--diff'), 'patch 须复用 diff renderer');

  const mermaidSource = `graph TD\nA["<&'\\\""]-->B\n`;
  const mermaid = renderMarkdown(`\`\`\`mermaid\n${mermaidSource}\`\`\``);
  assert.equal((mermaid.match(/class="mermaid-block"/g) ?? []).length, 1);
  assert.ok(!/<pre><code[^>]*>\s*<div class="mermaid-block"/.test(mermaid), 'Mermaid 不能被默认 fence 再包装');
  assert.ok(mermaid.includes('data-mermaid='));
  assert.ok(mermaid.includes('&lt;'));
  assert.ok(mermaid.includes('&#39;'));
  assert.ok(mermaid.includes('&#10;'));
}

function testInvalidDiffFallsBackToText(): void {
  const invalid = '-old\n+new\n';
  const out = renderDiffHtml(invalid);
  assert.ok(out.includes('<pre><code>'), 'diff2html 空输出时须回退可见源码');
  assert.ok(out.includes('-old'));
  assert.ok(out.includes('+new'));

  // 通过注入抛异常的 renderer 直接覆盖产品 catch 分支，不锁死第三方库的异常行为。
  const throwingRenderer = (() => {
    throw new Error('synthetic renderer failure');
  }) as Parameters<typeof renderDiffHtmlWithRenderer>[1];
  const fallback = renderDiffHtmlWithRenderer('<& source', throwingRenderer);
  assert.equal(fallback, '<pre><code>&lt;&amp; source</code></pre>', 'renderer 抛异常时须回退可见源码');
}

function testMarkdownRenderProfiles(): void {
  const source = '```mermaid\ngraph TD\nA-->B\n```\n\n![图](https://example.com/x.png)';
  const rich = renderMarkdown(source, 'rich');
  assert.ok(rich.includes('mermaid-block'), 'rich profile 应启用 Mermaid DOM 增强钩子');
  assert.ok(rich.includes('md-img'), 'rich profile 图片应启用灯箱钩子');

  const staticHtml = renderMarkdown(source, 'static');
  assert.ok(!staticHtml.includes('mermaid-block'), 'static profile 不应生成无法增强的 Mermaid 占位');
  assert.ok(staticHtml.includes('code-block'), 'static profile 应把 Mermaid 保留为可复制代码块');
  assert.ok(!staticHtml.includes('md-img'), 'static profile 图片不应伪装成可打开灯箱');

  const fs = require('node:fs') as typeof import('node:fs');
  const tool = fs.readFileSync(new URL('../src/renderer/components/chat/ToolCallBlock.vue', import.meta.url), 'utf8');
  const thinking = fs.readFileSync(new URL('../src/renderer/components/chat/ThinkingBlock.vue', import.meta.url), 'utf8');
  const testModal = fs.readFileSync(new URL('../src/renderer/components/config/TestConnectionModal.vue', import.meta.url), 'utf8');
  assert.ok(tool.includes("renderMarkdown(resultContent.value, 'static')"));
  assert.ok(thinking.includes("renderMarkdown(props.content, 'static')"));
  assert.ok(testModal.includes("renderMarkdown(streamedText.value, 'static')"));
}

function testMarkdownSecurityAndProtocolContracts(): void {
  const rawHtml = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!rawHtml.includes('<script>'));
  for (const unsafe of ['javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,x', 'file:///D:/secret']) {
    assert.ok(!renderMarkdown(`[x](${unsafe})`).includes('<a '), `危险链接必须拒绝: ${unsafe}`);
  }
  assert.ok(renderMarkdown('![x](data:image/png;base64,AAAA)').includes('<img'), '明确允许栅格 data image');
  assert.ok(!renderMarkdown('![x](data:image/svg+xml,<svg/>)').includes('<img'), '拒绝 SVG data URL');
  assert.equal(shouldOpenExternally('tel:+8612345'), true, 'tel 链接应与 renderer 注释一致走系统协议');
}

function assertTaskListCompletionCss(css: string): void {
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  const completedRoot = '.markdown-body .task-list-item:has(input:checked)';
  const rootDeclarations: string[] = [];
  let childHasLineThrough = false;

  for (const match of css.matchAll(rulePattern)) {
    const selectors = match[1].split(',').map((selector) => selector.trim());
    const declarations = match[2];
    if (selectors.includes(completedRoot)) rootDeclarations.push(declarations);
    if (selectors.some((selector) => selector.startsWith(`${completedRoot} >`))
      && /text-decoration\s*:\s*line-through(?:\s|;|$)/.test(declarations)) {
      childHasLineThrough = true;
    }
  }

  assert.ok(rootDeclarations.length > 0, '须存在 .task-list-item:has(input:checked) 根规则');
  assert.ok(
    rootDeclarations.every((declarations) => !/text-decoration\s*:/.test(declarations)),
    '完成态任一根规则均不得用 text-decoration（会误伤链接/代码）',
  );
  assert.ok(childHasLineThrough, '完成态删除线须限定到直属文本子元素');
}

function testTaskListReadOnlyContract(): void {
  const out = renderMarkdown('- [ ] todo\n- [x] done');
  assert.ok(out.includes('disabled'), '消息中的任务 checkbox 必须只读');
  assert.ok(out.includes('checked'), '完成项须保留 checked');

  const fs = require('node:fs') as typeof import('node:fs');
  const css = fs.readFileSync(new URL('../src/renderer/assets/styles/main.css', import.meta.url), 'utf8');
  assert.doesNotThrow(() => assertTaskListCompletionCss(css));

  const badFixture = `
    .markdown-body .task-list-item:has(input:checked) { color: gray; }
    .markdown-body .task-list-item:has(input:checked) { text-decoration: line-through; }
    .markdown-body .task-list-item:has(input:checked) > label { text-decoration: line-through; }
  `;
  assert.throws(
    () => assertTaskListCompletionCss(badFixture),
    /任一根规则均不得用 text-decoration/,
    '检测器须累积并拒绝任一根规则删除线，不能让后出现的安全根规则覆盖违规证据',
  );
}

// 2.1: 行首未闭合 $$ 不得把后续整段正文吞成 KaTeX 块（@traptitech/markdown-it-katex 的 math_block
// 原实现 found=false 时仍 push math_block 吞到 EOF）。合法单行/多行 $$...$$ 仍须渲染。
function testMarkdownBlockMathDoesNotSwallowUnclosed(): void {
  const legal = [
    renderMarkdown('$$x^2$$'),
    renderMarkdown('$$\nx^2\n$$'),
  ];
  for (const out of legal) assert.ok(out.includes('katex-block'), '合法单行/多行块级公式仍应经 KaTeX 渲染');

  for (const marker of ['$$PID', '$$50', '$$var', '$$']) {
    const out = renderMarkdown(`Line1\n\n${marker}\n\nNew paragraph here.`);
    assert.ok(out.includes('<p>Line1</p>'), `未闭合 ${marker} 前的段落须保留`);
    assert.ok(out.includes('<p>New paragraph here.</p>'), `未闭合 ${marker} 不得吞掉后文独立 p`);
    assert.ok(!out.includes('katex-block'), `未闭合 ${marker} 不应产成 katex-block`);
  }
}

function testImageLightboxAccessibilityWiring(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const lightbox = fs.readFileSync(new URL('../src/renderer/components/chat/ImageLightbox.vue', import.meta.url), 'utf8');
  const state = fs.readFileSync(new URL('../src/renderer/composables/useImageLightbox.ts', import.meta.url), 'utf8');
  const enrich = fs.readFileSync(new URL('../src/renderer/directives/enrich-markdown.ts', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/renderer/assets/styles/main.css', import.meta.url), 'utf8');
  const closeRule = css.match(/\.image-lightbox__close\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(lightbox.includes('role="dialog"'));
  assert.ok(lightbox.includes('aria-modal="true"'));
  assert.ok(lightbox.includes('ref="closeButton"'));
  assert.ok(lightbox.includes(':alt="state.alt"'));
  assert.ok(state.includes('trigger: HTMLElement | null'));
  assert.ok(!state.includes('trigger.focus()'), '焦点恢复应由 ImageLightbox 组件单点负责，composable 只清理状态');
  assert.ok(/value\.trigger\s*\?\?/.test(lightbox), '打开灯箱时须优先保存显式 trigger');
  assert.ok(lightbox.includes('document.activeElement instanceof HTMLElement'), '无 trigger 时须回退当前 activeElement');
  assert.ok(/else\s*\{\s*await nextTick\(\);\s*restoreFocus\(\);/.test(lightbox), '关闭后须等待 Teleport v-if 移除再恢复焦点');
  assert.ok(lightbox.includes('target.focus()'), '关闭灯箱后组件须恢复触发图片焦点');
  assert.match(closeRule, /min-width:\s*(?:44px|2\.75rem)/, '关闭按钮须显式保证最小 44px 宽度');
  assert.match(closeRule, /min-height:\s*(?:44px|2\.75rem)/, '关闭按钮须显式保证最小 44px 高度');
  assert.match(closeRule, /top:\s*calc\([^;]*env\(safe-area-inset-top\)/, '关闭按钮 top 须考虑安全区');
  assert.match(closeRule, /right:\s*calc\([^;]*env\(safe-area-inset-right\)/, '关闭按钮 right 须考虑安全区');
  assert.ok(enrich.includes("image.setAttribute('tabindex', '0')"));
  assert.ok(enrich.includes("image.setAttribute('role', 'button')"));
  assert.ok(enrich.includes("event.key !== 'Enter' && event.key !== ' '"));
}

function testDiffContentDetectionContracts(): void {
  const standard = '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new';
  assert.equal(isDiffContent(standard), true, '标准 unified diff 应识别');
  assert.equal(isDiffContent(`处理说明在前面\n\n${standard}`), true, '带前言的 unified diff 应识别');
  assert.equal(isDiffContent('diff --git a/file.txt b/file.txt\nindex 123..456 100644'), true, 'diff --git 文件头应独立识别');
  assert.equal(isDiffContent('--- a/path with spaces.txt\n+++ b/path with spaces.txt\n@@ -1 +1 @@\n-old\n+new'), true, '文件头路径含空格仍应识别');
  assert.equal(isDiffContent('--- 章节分隔\n这只是普通散文\n+++ 强调内容'), false, '普通 ---/+++ 散文不应误判');
  assert.equal(isDiffContent('--- a/file.txt\n+++ b/file.txt\n没有 hunk'), false, '缺少 @@ hunk 不应识别');
}

function assertReducedMotionCoverage(files: Array<{ name: string; text: string }>): void {
  const required = new Set<string>();
  const covered = new Set<string>();
  const animationRule = /([^{}]+)\{([^{}]*)\}/g;
  const collectMediaBodies = (text: string): string[] => {
    const bodies: string[] = [];
    const mediaStart = /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/g;
    for (const match of text.matchAll(mediaStart)) {
      const open = (match.index ?? 0) + match[0].length - 1;
      let depth = 0;
      for (let i = open; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}' && --depth === 0) {
          bodies.push(text.slice(open + 1, i));
          break;
        }
      }
    }
    return bodies;
  };

  for (const { text } of files) {
    for (const match of text.matchAll(animationRule)) {
      const declarations = match[2];
      if (!/(?:animation\s*:|animation-iteration-count\s*:)\s*[^;}]*\binfinite\b/.test(declarations)) continue;
      for (const selector of match[1].split(',').map((value) => value.trim())) {
        if (selector && !selector.startsWith('@')) required.add(selector);
      }
    }
    for (const body of collectMediaBodies(text)) {
      for (const match of body.matchAll(animationRule)) {
        if (/(?:animation\s*:|animation-iteration-count\s*:)\s*none\b/.test(match[2])) {
          for (const selector of match[1].split(',').map((value) => value.trim())) {
            if (selector && !selector.startsWith('@')) covered.add(selector);
          }
        }
      }
    }
  }
  const missing = [...required].filter((selector) => !covered.has(selector));
  assert.deepEqual(missing, [], `以下 infinite 动画选择器未被 prefers-reduced-motion 覆盖：${missing.join(', ')}`);
}

function testReducedMotionStopsInfiniteAnimations(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const { fileURLToPath } = require('node:url') as typeof import('node:url');
  const root = fileURLToPath(new URL('../src/renderer/', import.meta.url));
  const files: Array<{ name: string; text: string }> = [];
  (function walk(d: string): void {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(css|vue)$/.test(e.name)) files.push({ name: p, text: fs.readFileSync(p, 'utf8') });
    }
  })(root);

  assertReducedMotionCoverage(files);
  assert.throws(
    () => assertReducedMotionCoverage([{ name: 'synthetic.css', text: `
      .compound-a, .compound-b span { animation-iteration-count: infinite; }
      @media (prefers-reduced-motion: reduce) {
        .compound-a { animation: none; }
      }
    ` }]),
    /compound-b/,
    '检测器须覆盖 animation-iteration-count 与复合 selector，不能只扫描 animation 简写',
  );
}

function testMarkdownImageInLinkNotButtonized(): void {
  const out = renderMarkdown('[![alt](https://e.com/i.png)](https://e.com/page)');
  const linkInner = out.match(/<a [^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '';
  assert.ok(linkInner.includes('<img'), '链接内嵌图片应保留 <img>');
  assert.ok(linkInner.includes('loading="lazy"'), '链接内嵌图片仍须懒加载');
  assert.ok(!/\bclass="[^"]*md-img/.test(linkInner), '链接内嵌图片不应带 md-img（避免按钮化嵌套 <a> 且 preventDefault 劫持链接导航）');
  const bare = renderMarkdown('![图](https://e.com/i.png)');
  assert.ok(bare.includes('md-img'), '裸图片仍须带 md-img（灯箱钩子不回归）');
  assert.ok(bare.includes('loading="lazy"'), '裸图片仍须懒加载');
}

function testMarkdownImageProtocolFilter(): void {
  const allowed = [
    'http://e.com/i.png',
    'HTTPS://e.com/i.JPG',
    'data:image/png;base64,AAAA',
    'DATA:IMAGE/JPEG,AAAA',
    'data:image/gif;base64,AAAA',
    'data:image/webp;base64,AAAA',
  ];
  for (const url of allowed) assert.equal(isAllowedMarkdownImageUrl(url), true, `应允许图片 URL: ${url}`);
  for (const mime of ['jpg', 'bmp', 'x-icon']) {
    assert.equal(isAllowedMarkdownImageUrl(`data:image/${mime};base64,AAAA`), false, `markdown-it 不支持的 data:image/${mime} 应拒绝`);
  }

  const rejected = [
    'ftp://e.com/i.png',
    'file:///D:/secret.png',
    'data:text/plain,hello',
    'data:image/svg,<svg/>',
    'data:image/svg+xml,<svg/>',
    'DATA:IMAGE/SVG,<svg/>',
    'DATA:IMAGE/SVG+XML,<svg/>',
    'data:image/png',
    'data:image/png;base64',
    'data:image/png;base64,',
    'not a url',
    'https://',
    '',
  ];
  for (const url of rejected) assert.equal(isAllowedMarkdownImageUrl(url), false, `应拒绝图片 URL: ${url}`);

  assert.ok(!renderMarkdown('![alt](ftp://e.com/i.png)').includes('<img'), '非 http(s)/栅格 data 图片协议须被拦截');
  assert.ok(renderMarkdown('![alt](https://e.com/i.png)').includes('<img'), 'http 图片仍允许');
  const mainImage = renderMarkdown('![alt](data:image/png;base64,AAAA)');
  assert.ok(mainImage.includes('<img'), 'data:image 栅格图仍允许');
  assert.ok(mainImage.includes('loading="lazy"'), '主 renderMarkdown 图片须保留 lazy loading');

  const independentMarkdown = new MarkdownIt();
  applyImageProtocolFilter(independentMarkdown);
  assert.ok(independentMarkdown.render('![ok](data:image/webp;base64,AAAA)').includes('<img'), '独立 MarkdownIt 安装 helper 后应允许栅格 data image');
  assert.ok(!independentMarkdown.render('![blocked](ftp://e.com/i.png)').includes('<img'), '独立 MarkdownIt 安装 helper 后应拒绝 ftp image');
  assert.ok(!independentMarkdown.render('![blocked](data:image/svg+xml,<svg/>)').includes('<img'), '独立 MarkdownIt 安装 helper 后应拒绝 SVG data image');

  const previewMarkdown = createPreviewMarkdownRenderer();
  assert.ok(previewMarkdown.render('![ok](https://e.com/i.png)').includes('<img'), 'Preview renderer 应允许 http 图片');
  assert.ok(!previewMarkdown.render('![blocked](ftp://e.com/i.png)').includes('<img'), 'Preview renderer 应拒绝 ftp 图片');
  assert.ok(!previewMarkdown.render('![blocked](DATA:IMAGE/SVG+XML,<svg/>)').includes('<img'), 'Preview renderer 应拒绝大小写不敏感 SVG+XML data 图片');
  assert.ok(previewMarkdown.render('![ok](data:image/png;base64,AAAA)').includes('<img'), 'Preview renderer 应允许 png data 图片');

  const fs = require('node:fs') as typeof import('node:fs');
  const markdownSource = fs.readFileSync(new URL('../src/renderer/utils/markdown.ts', import.meta.url), 'utf8');
  const previewSource = fs.readFileSync(new URL('../src/renderer/components/chat/InteractionPreview.vue', import.meta.url), 'utf8');
  assert.ok(markdownSource.includes('applyImageProtocolFilter(md);'), '主 renderer 须安装共享图片协议过滤 helper');
  assert.ok(previewSource.includes('createPreviewMarkdownRenderer()'), 'InteractionPreview 须使用共享 Preview MarkdownIt 工厂');
}

function testInteractionPreviewDiffFallback(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const src = fs.readFileSync(new URL('../src/renderer/components/chat/InteractionPreview.vue', import.meta.url), 'utf8');
  assert.ok(src.includes('renderDiffHtml'), 'InteractionPreview 须复用 renderDiffHtml（带空输出回退）');
  assert.ok(!/from\s+'diff2html'/.test(src), 'InteractionPreview 不应直接依赖 diff2html（绕过回退保护）');
  assert.ok(renderDiffHtml('', { matching: 'lines' }).includes('<pre><code>'), '空 diff 经 matching:lines 须回退 <pre><code>');
}

function testMarkdownIndentedCodeUsesContainer(): void {
  const out = renderMarkdown('段落\n\n    let x = 1\n\n后文');
  assert.ok(out.includes('class="code-block"'), '4 空格缩进代码块须走统一 code-block 容器（含 header/复制/高亮）');
  assert.ok(out.includes('code-block__copy'), '缩进代码块须带复制按钮');
  assert.ok(out.includes('language-plaintext'), '缩进代码块无语言信息，须标 plaintext');
  assert.ok(!/<pre><code>let x = 1/.test(out), '缩进代码块不能再是裸 <pre><code>');
}

function testMermaidRendersBlocksSerially(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const src = fs.readFileSync(new URL('../src/renderer/directives/enrich-markdown.ts', import.meta.url), 'utf8');
  assert.ok(!/Promise\.all\s*\(\s*blocks\.map/.test(src), 'mermaid 各 diagram 类型的 db 为单例，并发 clear 会互相覆盖，多块须串行');
  assert.ok(/for\s*\(\s*const\s+block\s+of\s+blocks/.test(src), 'renderMermaidBlocks 须用 for..of 串行 await');
  assert.ok(/let\s+mermaidQueue/.test(src), '须有模块级 mermaid 队列做跨容器互斥');
  assert.ok(/mermaidQueue\s*=\s*mermaidQueue\.then/.test(src), '队列须链式串行（跨容器 mounted 互斥）');
}

function testMermaidErrorRetryAndAccessibleTitleContracts(): void {
  assert.equal(shouldSkipMermaidErrorRetry('error', 'same', 'same'), true);
  assert.equal(shouldSkipMermaidErrorRetry('error', 'old', 'new'), false);
  assert.equal(shouldSkipMermaidErrorRetry('rendered', 'same', 'same'), false);
  assert.equal(summarizeMermaidAccessibleTitle(''), 'Mermaid 图表');
  assert.equal(summarizeMermaidAccessibleTitle('  graph\n TD\tA-->B  '), 'graph TD A-->B');
  const title = summarizeMermaidAccessibleTitle('😀'.repeat(80), 10);
  assert.equal([...title].length, 10);
  assert.ok(!title.includes('\uD800') && !title.includes('\uDC00'));
  const fs = require('node:fs') as typeof import('node:fs');
  const src = fs.readFileSync(new URL('../src/renderer/directives/enrich-markdown.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('createElementNS'), 'Mermaid SVG title 须使用 SVG namespace 创建');
  assert.ok(src.includes('<title>') || src.includes("createElementNS(SVG_NS, 'title')"), 'Mermaid SVG 须注入 title');
  assert.ok(src.includes("setAttribute('role', 'img')"), 'Mermaid SVG 须设置 role=img');
  assert.ok(src.includes("setAttribute('aria-labelledby'"), 'Mermaid SVG 须以 aria-labelledby 接线到 title');
  assert.ok(src.includes('renderCounter') && /renderCounter[\s\S]{0,180}(生命周期|重置|唯一)/.test(src), 'renderCounter 须解释生命周期单调唯一 ID 不重置原因');
}

function testMermaidDeadPreRuleRemoved(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const css = fs.readFileSync(new URL('../src/renderer/assets/styles/main.css', import.meta.url), 'utf8');
  assert.ok(!css.includes('pre:has(> .mermaid-block)'), 'mermaid-block 由 fence 裸输出无 <pre> 祖先，pre:has(> .mermaid-block) 是死规则，须删除');
  assert.ok(!css.includes('中和 markdown-it 在 highlight 返回外层包'), '过时注释须更新');
  assert.ok(css.includes('.markdown-body .mermaid-block'), 'mermaid-block 容器样式须保留');
}

function testTestConnectionCopyFailureResets(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const src = fs.readFileSync(new URL('../src/renderer/components/config/TestConnectionModal.vue', import.meta.url), 'utf8');
  const resets = src.split("button.textContent = '复制'").length - 1;
  assert.ok(resets >= 2, `handleMarkdownCopy 须在成功与失败两分支都复位为「复制」，当前仅 ${resets} 处`);
}

function testImageLightboxZIndexTokenized(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const css = fs.readFileSync(new URL('../src/renderer/assets/styles/main.css', import.meta.url), 'utf8');
  const rule = css.match(/\.image-lightbox\s*\{([^}]*)\}/);
  assert.ok(rule, '.image-lightbox 规则须存在');
  assert.ok(/z-index:\s*var\(--[\w-]*z-index\)/.test(rule![1]), '灯箱 z-index 须接入 overlay token，不得用裸魔法数');
  const tokens = fs.readFileSync(new URL('../src/renderer/assets/styles/interaction-tokens.css', import.meta.url), 'utf8');
  assert.ok(/--[\w-]*overlay[\w-]*z-index\s*:/.test(tokens), '须在 overlay token 体系定义灯箱 z-index');
}

function testChatBlockKeyboardAccessibility(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const tool = fs.readFileSync(new URL('../src/renderer/components/chat/ToolCallBlock.vue', import.meta.url), 'utf8');
  const template = tool.match(/<template>([\s\S]*?)<\/template>/)?.[1] ?? '';
  const extractOpeningTagByClass = (className: string): string => {
    const tags = template.match(/<[^/!][^>]*>/g) ?? [];
    return tags.find(tag => new RegExp(`\\bclass=["'][^"']*\\b${className}\\b[^"']*["']`).test(tag)) ?? '';
  };
  const hasAttribute = (tag: string, name: string, value?: string): boolean => {
    const match = tag.match(new RegExp(`(?:^|\\s)${name}(?:=(?:"([^"]*)"|'([^']*)'))?(?=\\s|/?>)`));
    return !!match && (value === undefined || (match[1] ?? match[2]) === value);
  };
  const headTag = extractOpeningTagByClass('tool-row__head');
  const anchorTag = extractOpeningTagByClass('tool-row__anchor');
  const bodyTag = extractOpeningTagByClass('tool-row__body');
  const controls = template.match(/<div\s+class=["']tool-row__controls["']>([\s\S]*?)<\/div>/)?.[1] ?? '';

  assert.ok(/\bconst\s+bodyId\s*=\s*useId\(\s*\)/.test(tool), 'ToolCallBlock 须调用 useId 生成唯一 body id');
  assert.ok(template.includes('<div class="tool-row__controls">'), 'ToolCallBlock 须用非交互 flex wrapper 包住工具行控件');
  assert.ok(headTag.startsWith('<button'), 'ToolCallBlock head 须是原生 button');
  assert.ok(hasAttribute(headTag, ':aria-expanded', 'expanded'), 'ToolCallBlock head 须暴露 aria-expanded');
  assert.ok(hasAttribute(headTag, ':aria-controls', 'bodyId'), 'ToolCallBlock head 须用 aria-controls 指向 body');
  assert.ok(hasAttribute(headTag, '@click', 'expanded = !expanded'), 'ToolCallBlock head 须切换 expanded');
  assert.ok(anchorTag.startsWith('<button'), '子 Agent anchor 须是原生 button');
  assert.ok(hasAttribute(anchorTag, '@click', 'focusSubAgent'), '子 Agent anchor 须调用 focusSubAgent');
  assert.equal((controls.match(/<button\b/g) ?? []).length, 2, 'ToolCallBlock 控件 wrapper 内须恰有 head 与子 Agent 两个 button');
  assert.ok(/^\s*<button\b[\s\S]*<\/button>\s*<button\b/.test(controls), 'head 与子 Agent anchor 须是不嵌套的兄弟 button');
  assert.ok(!hasAttribute(headTag, 'role', 'button') && !hasAttribute(anchorTag, 'role', 'button'), 'ToolCallBlock 原生按钮不得冗余 role=button');
  assert.ok(!hasAttribute(headTag, 'tabindex') && !hasAttribute(anchorTag, 'tabindex'), 'ToolCallBlock 原生按钮不得手写 tabindex');
  assert.ok(!/@keydown\.(?:enter|space)\b/.test(headTag) && !/@keydown\.(?:enter|space)\b/.test(anchorTag), 'ToolCallBlock 原生按钮不得手写 Enter/Space 模拟');
  assert.ok(bodyTag.startsWith('<div'), 'ToolCallBlock body 须是 div');
  assert.ok(hasAttribute(bodyTag, 'v-show', 'expanded'), 'ToolCallBlock body 须常驻 DOM 并由 expanded 控制显示，避免 aria-controls 悬空');
  assert.ok(hasAttribute(bodyTag, ':id', 'bodyId'), 'ToolCallBlock body 须绑定唯一 id');
  const process = fs.readFileSync(new URL('../src/renderer/components/chat/ProcessGroup.vue', import.meta.url), 'utf8');
  assert.ok(process.includes(':aria-expanded="open"'), 'ProcessGroup 折叠按钮须 aria-expanded');
  assert.ok(process.includes('aria-controls'), 'ProcessGroup 须 aria-controls 指向 panel');
  assert.ok(process.includes('useId'), 'ProcessGroup 须用 useId 生成唯一 panel id');
  assert.ok(process.includes(':id="panelId"'), 'ProcessGroup panel 须绑定唯一 id');
  const thinking = fs.readFileSync(new URL('../src/renderer/components/chat/ThinkingBlock.vue', import.meta.url), 'utf8');
  assert.ok(thinking.includes(':aria-expanded="open"'), 'ThinkingBlock 折叠按钮须 aria-expanded');
  assert.ok(thinking.includes('aria-controls'), 'ThinkingBlock 须 aria-controls 指向 body');
  assert.ok(thinking.includes('useId'), 'ThinkingBlock 须用 useId 生成唯一 body id');
  assert.ok(thinking.includes(':id="bodyId"'), 'ThinkingBlock body 须绑定唯一 id');
  assert.ok(thinking.includes('v-show="open"'), 'ThinkingBlock body 须常驻 DOM，避免 aria-controls 悬空');
}

function testMermaidLifecycleGuards(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const src = fs.readFileSync(new URL('../src/renderer/directives/enrich-markdown.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('mermaidPromise = null'), 'Mermaid import 失败后必须允许后续重试');
  assert.ok(src.includes('root.isConnected'), '异步返回后须检查 root 是否仍在文档中');
  assert.ok(src.includes('root.contains(block)'), '异步返回后须检查 block 是否仍属于当前 root');
  assert.ok(src.includes('data-mermaid-source'), '渲染任务须记录启动时源码');
  assert.ok(src.includes('data-mermaid-state'), 'Mermaid 状态需区分 loading/rendered/error');
  assert.ok(src.includes('bindFunctions'), '须执行 Mermaid 返回的 bindFunctions');
}

function testTestConnectionMarkdownCopyWiring(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const src = fs.readFileSync(new URL('../src/renderer/components/config/TestConnectionModal.vue', import.meta.url), 'utf8');
  assert.ok(src.includes('navigator.clipboard'), '测试连接入口必须绑定代码复制行为');
  assert.ok(src.includes('@click="handleMarkdownCopy"'), '测试连接流式 Markdown 容器应挂复制委托');
}

// Edit/Write/MultiEdit 的 tool_result 只是一句成功提示（无 diff），ToolCallBlock 改为
// 从 tool_use 入参（old_string/new_string 或 content）合成 unified diff 反推显示。
// 这里锁定合成逻辑契约 + ToolCallBlock 接线。
function testToolDiffSynthesisContracts(): void {
  // Edit：old_string→new_string 合成 diff
  const edit = synthesizeToolDiff('Edit', { file_path: 'aaaa.txt', old_string: 'aaaa', new_string: 'bbb' });
  assert.ok(edit, 'Edit 须合成 diff');
  assert.equal(edit!.kind, 'edit');
  assert.ok(edit!.diff.includes('--- a/aaaa.txt'), 'Edit diff 须带 a/ 头');
  assert.ok(edit!.diff.includes('+++ b/aaaa.txt'), 'Edit diff 须带 b/ 头');
  assert.ok(edit!.diff.includes('-aaaa'), 'Edit diff 须含删除的 old_string');
  assert.ok(edit!.diff.includes('+bbb'), 'Edit diff 须含新增的 new_string');
  assert.ok(/@@\s+-1,1\s+\+1,1\s+@@/.test(edit!.diff), 'Edit diff 须带 hunk 头');

  // Edit 含公共行：行级 LCS 把公共行作为 context（前导空格），只标红改动的 aaa→bbb
  const ctx = synthesizeToolDiff('Edit', {
    file_path: 'f.txt',
    old_string: 'line1\naaa\nline3',
    new_string: 'line1\nbbb\nline3',
  });
  assert.ok(ctx!.diff.includes(' line1'), '公共行须作为 context 保留');
  assert.ok(ctx!.diff.includes('-aaa') && ctx!.diff.includes('+bbb'), '只标注改动的行');
  assert.ok(!ctx!.diff.includes('-line1') && !ctx!.diff.includes('+line1'), '公共行不得标成增删');

  // Write：旧侧空（无快照），整段按新增展示，对应 git「新建文件」-0,0 头
  const write = synthesizeToolDiff('Write', { file_path: 'new.txt', content: 'hello\nworld\n' });
  assert.ok(write, 'Write 须合成 diff');
  assert.equal(write!.kind, 'write');
  assert.ok(write!.diff.includes('-0,0'), 'Write 须以空旧侧（-0,0）表示新增');
  assert.ok(write!.diff.includes('+hello') && write!.diff.includes('+world'), 'Write 内容须全为新增行');

  // MultiEdit：多条 edit 各成一段 patch（无文件内偏移无法合并）
  const multi = synthesizeToolDiff('MultiEdit', {
    file_path: 'm.txt',
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'c', new_string: 'd' },
    ],
  });
  assert.ok(multi, 'MultiEdit 须合成 diff');
  assert.equal(multi!.kind, 'multiedit');
  assert.equal((multi!.diff.match(/^--- a\/m\.txt$/gm) ?? []).length, 2, '两条 edit 须各带文件头');
  assert.ok(multi!.diff.includes('-a') && multi!.diff.includes('+b') && multi!.diff.includes('-c') && multi!.diff.includes('+d'));

  // MultiEdit：无变化的 edit 被跳过，仅保留有变化的
  const multiPartial = synthesizeToolDiff('MultiEdit', {
    file_path: 'm.txt',
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'same', new_string: 'same' },
    ],
  });
  assert.equal((multiPartial!.diff.match(/^--- a\/m\.txt$/gm) ?? []).length, 1, '无变化的 edit 须跳过');

  // 无变化 / 空 / 非编辑类工具 → null
  assert.equal(synthesizeToolDiff('Edit', { file_path: 'x', old_string: 'same', new_string: 'same' }), null, 'old===new 须返回 null');
  assert.equal(synthesizeToolDiff('Write', { file_path: 'x', content: '' }), null, '空 content 须返回 null');
  assert.equal(synthesizeToolDiff('Bash', { command: 'ls' }), null, '非编辑工具须返回 null');
  assert.equal(synthesizeToolDiff('Read', { file_path: 'x' }), null, 'Read 须返回 null');
  assert.equal(synthesizeToolDiff('Edit', null), null, '入参为 null 须返回 null');

  // 反斜杠路径归一为正斜杠（diff 头更整洁，diff2html 文件名显示正常）
  const win = synthesizeToolDiff('Edit', { file_path: 'D:\\dir\\f.txt', old_string: 'a', new_string: 'b' });
  assert.ok(win!.diff.includes('a/D:/dir/f.txt'), '反斜杠路径须归一为正斜杠');

  // round-trip：合成 diff 经 renderDiffHtml 须被 diff2html 正常渲染，不回退裸源码
  const html = renderDiffHtml(edit!.diff);
  assert.ok(html.includes('d2h-file-wrapper'), '合成 diff 须被 diff2html 正常渲染');
  assert.ok(!html.includes('<pre><code>'), '合成 diff 不应回退到裸 <pre><code>');

  // ToolCallBlock 接线契约：须导入并调用 synthesizeToolDiff
  const fs = require('node:fs') as typeof import('node:fs');
  const src = fs.readFileSync(new URL('../src/renderer/components/chat/ToolCallBlock.vue', import.meta.url), 'utf8');
  assert.ok(src.includes('synthesizeToolDiff'), 'ToolCallBlock 须导入 synthesizeToolDiff');
  assert.ok(/synthesizeToolDiff\([^)]*\)/.test(src), 'ToolCallBlock 须调用 synthesizeToolDiff');
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
testMarkdownParserEmitsCoreBlocks();
testMarkdownBodyCssCoversCoreElements();
testToolCallBlockMarkdownParagraphUsesRem();
testMarkdownTaskListCheckboxes();
testMarkdownMathKatex();
testMarkdownMermaidEmitsContainer();
testMarkdownImageLightboxHook();
testMarkdownFenceStructure();
testInvalidDiffFallsBackToText();
testMarkdownRenderProfiles();
testMarkdownSecurityAndProtocolContracts();
testTaskListReadOnlyContract();
testMarkdownBlockMathDoesNotSwallowUnclosed();
testImageLightboxAccessibilityWiring();
testDiffContentDetectionContracts();
testToolDiffSynthesisContracts();
testReducedMotionStopsInfiniteAnimations();
testMermaidLifecycleGuards();
testTestConnectionMarkdownCopyWiring();
testMarkdownImageInLinkNotButtonized();
testMarkdownImageProtocolFilter();
testInteractionPreviewDiffFallback();
testMarkdownIndentedCodeUsesContainer();
testMermaidRendersBlocksSerially();
testMermaidErrorRetryAndAccessibleTitleContracts();
testMermaidDeadPreRuleRemoved();
testTestConnectionCopyFailureResets();
testImageLightboxZIndexTokenized();
testChatBlockKeyboardAccessibility();
