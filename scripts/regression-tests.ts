import { strict as assert } from 'node:assert';

import { buildAnthropicApiUrl } from '../src/main/modules/api-url';
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

testApiUrlBuilder();
testSettingsImportPreservesNestedJson();
testSearchNormalizer();
