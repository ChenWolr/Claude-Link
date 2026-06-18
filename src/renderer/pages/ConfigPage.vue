<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useConfigStore } from '../stores/config-store';
import ProviderSelect from '../components/config/ProviderSelect.vue';
import ApiKeyInput from '../components/config/ApiKeyInput.vue';
import ModelMappingInputs from '../components/config/ModelMappingInputs.vue';
import ThemeSelector from '../components/config/ThemeSelector.vue';
import { THEME_PALETTES } from '../../shared/constants';
import { parseClaudeSettings } from '../../shared/settings-parser';

const store = useConfigStore();
const router = useRouter();
const toast = ref<string | null>(null);
const toastType = ref<'success' | 'error'>('success');
const showAdvanced = ref(false);
const advancedJsonError = ref<string | null>(null);

onMounted(async () => {
  await store.loadConfig();
  await store.detectCli();
});

// 监听高级 JSON 文本框：粘贴 Claude Code settings.json 后自动回填字段（防抖 600ms）。
// applyExtractedSettings 只在 JSON 含对应字段时覆盖，空字段不会清掉用户手填的值。
let autoFillTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => store.config.advancedJson,
  (val) => {
    if (store.updatingFromJson) return;
    if (autoFillTimer) clearTimeout(autoFillTimer);
    if (!val || val.trim() === '' || val.trim() === '{}') return;
    autoFillTimer = setTimeout(() => {
      try {
        const parsed = parseClaudeSettings(val);
        store.applyExtractedSettings(parsed);
      } catch {
        // 静默：用户可能正在编辑不完整的 JSON
      }
    }, 600);
  },
);

// 表单→JSON：apiKey/apiBaseUrl/permissionMode 改动同步进 advancedJson（完整双向）
watch(
  () => [store.config.apiKey, store.config.apiBaseUrl, store.config.permissionMode],
  () => {
    if (!store.updatingFromJson) store.syncFormToAdvanced();
  },
);

const advancedJsonValid = computed(() => {
  if (!store.config.advancedJson || store.config.advancedJson === '{}') return true;
  try {
    JSON.parse(store.config.advancedJson);
    return true;
  } catch {
    return false;
  }
});

const urlValidation = computed(() => {
  const url = store.config.apiBaseUrl?.trim() || '';
  if (!url) return { status: 'empty', message: '' };

  // Check basic format
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { status: 'error', message: 'URL 必须以 http:// 或 https:// 开头' };
  }

  // Check double slashes in path
  const pathPart = url.replace(/^https?:\/\//, '');
  if (pathPart.includes('//')) {
    return { status: 'error', message: 'URL 中包含多余的双斜杠' };
  }

  // Official endpoint doesn't need /v1
  if (url === 'https://api.anthropic.com' || url === 'http://api.anthropic.com') {
    return { status: 'ok', message: '官方端点，CLI 自动处理路径' };
  }

  if (url === 'https://api.anthropic.com/v1' || url === 'http://api.anthropic.com/v1') {
    return { status: 'warn', message: '官方端点不需要 /v1 后缀，CLI 会自动添加' };
  }

  // Third-party endpoints usually need /v1
  if (!url.includes('anthropic.com') && !url.endsWith('/v1') && !url.endsWith('/v1/')) {
    return { status: 'warn', message: '第三方端点通常需要 /v1 后缀（如 https://example.com/v1）' };
  }

  // Trailing slash
  if (url.endsWith('/') && !url.endsWith('/v1/')) {
    return { status: 'warn', message: 'URL 末尾有多余斜杠，建议去掉' };
  }

  return { status: 'ok', message: 'URL 格式正常' };
});

async function handleSave() {
  // Auto-trim trailing slashes from apiBaseUrl
  const baseUrl = store.config.apiBaseUrl?.trim();
  if (baseUrl && baseUrl.endsWith('/') && !baseUrl.endsWith('/v1/')) {
    store.config.apiBaseUrl = baseUrl.slice(0, -1);
  }

  try {
    await store.saveConfig();
    toastType.value = 'success';
    toast.value = '配置已保存';
  } catch {
    toastType.value = 'error';
    toast.value = store.error ?? '保存失败';
  }

  setTimeout(() => {
    toast.value = null;
  }, 3000);
}

function formatJson() {
  try {
    const parsed = JSON.parse(store.config.advancedJson || '{}');
    store.config.advancedJson = JSON.stringify(parsed, null, 2);
    advancedJsonError.value = null;
  } catch (e) {
    advancedJsonError.value = e instanceof Error ? e.message : 'JSON 格式错误';
  }
}

async function handleImportSettings() {
  const filePath = await window.claudeLink.pickSettingsFile();
  if (filePath) {
    await store.importSettings(filePath);
  }
}

const autoDetectInfo = ref<string | null>(null);

async function handleAutoDetect() {
  const detected = await store.autoDetectClaudeConfig();
  if (!detected) {
    autoDetectInfo.value = store.error;
    return;
  }
  const parts = [`检测来源：${detected.sources.join('、') || '无'}`];
  if (detected.hasOAuthCredentials) parts.push('检测到 OAuth 登录态（claude.ai 订阅）');
  if (detected.oauthAccount?.email) parts.push(`账号：${detected.oauthAccount.email}`);
  if (detected.apiKeyHelper) parts.push('检测到 apiKeyHelper（Claude Link 不执行动态密钥脚本，请改用静态 API Key）');
  autoDetectInfo.value = parts.join('；');
}

const testResult = ref<{ success: boolean; message: string; responsePreview?: string } | null>(null);

async function handleTestConnection() {
  testResult.value = null;
  const result = await store.testConnection();
  if (result) {
    testResult.value = { success: result.success, message: result.message, responsePreview: result.responsePreview };
  } else {
    testResult.value = { success: false, message: store.error ?? '测试连接失败' };
  }
}

function handleFillFromJson() {
  const result = store.fillFromAdvancedJson();
  toastType.value = result.ok ? 'success' : 'error';
  toast.value = result.message;
  setTimeout(() => {
    toast.value = null;
  }, 3000);
}

function handleThemeSelect(paletteId: string) {
  store.config.themePaletteId = paletteId;
  applyTheme(paletteId);
}

function applyTheme(paletteId: string) {
  const palette = THEME_PALETTES.find((p) => p.id === paletteId);
  if (!palette) return;
  const root = document.documentElement;
  root.style.setProperty('--color-bg', palette.colors.bg);
  root.style.setProperty('--color-panel', palette.colors.panel);
  root.style.setProperty('--color-panel-soft', palette.colors.panelSoft);
  root.style.setProperty('--color-border', palette.colors.border);
  root.style.setProperty('--color-text', palette.colors.text);
  root.style.setProperty('--color-text-muted', palette.colors.textMuted);
  root.style.setProperty('--color-accent', palette.colors.accent);
  root.style.setProperty('--color-accent-strong', palette.colors.accentStrong);
  root.style.setProperty('--color-danger', palette.colors.danger);
}
</script>

<template>
  <section class="config-scroll">
    <section class="config-page">
    <header class="config-page__header">
      <div>
        <p class="eyebrow">Settings</p>
        <h1>配置</h1>
      </div>
      <button class="back-button" type="button" @click="router.push('/')">← 返回会话</button>
    </header>

    <!-- CLI Status Banner -->
    <div v-if="store.detectingCli" class="banner banner--info">正在检测 Claude Code CLI...</div>
    <div v-else-if="store.cliStatus?.installed" class="banner banner--ok">
      ✅ Claude Code CLI 已安装 — {{ store.cliStatus.version }} ({{ store.cliStatus.path }})
    </div>
    <div v-else class="banner banner--warn">
      ⚠️ 未检测到 Claude Code CLI。请先安装：npm install -g @anthropic-ai/claude-code
    </div>

    <div v-if="toast" :class="['toast', `toast--${toastType}`]">{{ toast }}</div>
    <div v-if="store.error && !toast" class="toast toast--error">{{ store.error }}</div>

    <!-- Config actions: auto-detect + test connection -->
    <div class="autodetect-bar">
      <button type="button" class="autodetect-btn" @click="handleAutoDetect">自动检测配置</button>
      <button type="button" class="test-btn" :disabled="store.testingConnection" @click="handleTestConnection">
        {{ store.testingConnection ? '测试中…' : '测试连接' }}
      </button>
      <p v-if="autoDetectInfo" class="autodetect-info">{{ autoDetectInfo }}</p>
    </div>
    <div v-if="testResult" :class="['test-result', testResult.success ? 'test-result--ok' : 'test-result--fail']">
      <p class="test-result__msg">{{ testResult.message }}</p>
      <p v-if="testResult.responsePreview" class="test-result__preview">CLI 响应：{{ testResult.responsePreview }}</p>
    </div>

    <form class="config-form" @submit.prevent="handleSave">
      <!-- Provider Section -->
      <div class="section">
        <h3 class="section-title">供应商设置</h3>

        <label class="field">
          <span>供应商名称 <span class="required">*</span></span>
          <input v-model="store.config.providerName" type="text" placeholder="例如：sub2Api" />
        </label>

        <label class="field">
          <span>备注</span>
          <input v-model="store.config.providerNote" type="text" placeholder="可选" />
        </label>

        <ProviderSelect v-model="store.config.provider" />
        <ApiKeyInput v-model="store.config.apiKey" />
        <div v-if="store.importedFields.has('apiKey')" class="imported-mark">✓ 已从 settings.json 导入</div>

        <label class="field">
          <span>请求地址（API Base URL） <span class="required">*</span></span>
          <input
            v-model="store.config.apiBaseUrl"
            type="text"
            placeholder="https://api.anthropic.com"
          />
          <small class="field-hint">
            填写兼容 Claude API 的服务端点。官方直连模式应使用 https://api.anthropic.com
          </small>
          <div v-if="store.importedFields.has('apiBaseUrl')" class="imported-mark">✓ 已从 settings.json 导入</div>
          <div v-if="urlValidation.message" :class="['url-validation', `url-validation--${urlValidation.status}`]">
            {{ urlValidation.message }}
          </div>
        </label>

        <ModelMappingInputs />
      </div>

      <!-- Advanced JSON -->
      <div class="section">
        <button type="button" class="accordion-toggle" @click="showAdvanced = !showAdvanced">
          <span>{{ showAdvanced ? '▼' : '▶' }}</span>
          <span>高级 JSON</span>
        </button>
        <div v-if="showAdvanced" class="advanced-panel">
          <p class="advanced-hint">
            直接粘贴 Claude Code 的 settings.json 内容，点击"从 JSON 填充字段"即可自动回填 API Key / 请求地址 / 模型；其余字段保留在此处。运行 CLI 时仅字符串字段会作为环境变量注入。
          </p>
          <div class="advanced-actions">
            <button type="button" class="import-btn" @click="handleImportSettings">导入 settings.json 文件</button>
            <button type="button" class="fill-btn" @click="handleFillFromJson">从 JSON 填充字段</button>
          </div>
          <div v-if="store.importedFields.has('advancedJson')" class="imported-mark">✓ 已从 settings.json 导入</div>
          <button type="button" class="format-btn" @click="formatJson">格式化</button>
          <textarea
            v-model="store.config.advancedJson"
            class="json-editor"
            rows="8"
            placeholder='{"key": "value"}'
          />
          <div v-if="advancedJsonError" class="json-error">{{ advancedJsonError }}</div>
          <div v-if="!advancedJsonValid" class="json-error">JSON 格式错误</div>
        </div>
      </div>

      <!-- General Settings -->
      <div class="section">
        <h3 class="section-title">通用设置</h3>
        <label class="field">
          <span>权限模式</span>
          <select v-model="store.config.permissionMode">
            <option value="default">default</option>
            <option value="acceptEdits">acceptEdits</option>
            <option value="plan">plan</option>
            <option value="bypassPermissions">bypassPermissions</option>
          </select>
        </label>

        <label class="field">
          <span>任务间延迟（秒）</span>
          <input v-model.number="store.config.taskDelaySeconds" type="number" min="0" />
        </label>

        <label class="field">
          <span>最大轮次</span>
          <input v-model.number="store.config.maxTurns" type="number" min="1" />
        </label>
      </div>

      <!-- Appearance Settings -->
      <div class="section">
        <h3 class="section-title">外观设置</h3>
        <ThemeSelector :selected-id="store.config.themePaletteId" @select="handleThemeSelect" />
      </div>

      <button class="save-button" type="submit" :disabled="store.savingConfig">
        {{ store.savingConfig ? '保存中...' : '保存配置' }}
      </button>
    </form>
    </section>
  </section>
</template>

<style scoped>
.config-scroll {
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
  overflow-y: auto;
}

.config-page {
  max-width: 640px;
  margin: 0 auto;
  padding: 32px 32px 64px;
}

.config-page__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}

.config-page__header h1 {
  margin: 4px 0 0;
  font-size: 24px;
}

.back-button {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.back-button:hover {
  background: var(--color-panel-soft);
}

.eyebrow {
  margin: 0;
  color: var(--color-accent-strong);
  font-size: 12px;
  font-weight: 700;
}

.banner {
  border-radius: var(--radius-md);
  padding: 12px 16px;
  margin-bottom: 20px;
  font-size: 13px;
}

.banner--ok {
  border: 1px solid #2a6e4a;
  background: rgba(58, 166, 117, 0.12);
  color: #5fd6a0;
}

.banner--warn {
  border: 1px solid #8a6d2b;
  background: rgba(204, 163, 61, 0.12);
  color: #e0c36a;
}

.banner--info {
  border: 1px solid var(--color-border);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
}

.toast {
  border-radius: var(--radius-md);
  padding: 10px 14px;
  margin-bottom: 16px;
  font-size: 13px;
}

.toast--success {
  border: 1px solid #2a6e4a;
  background: rgba(58, 166, 117, 0.12);
  color: #5fd6a0;
}

.toast--error {
  border: 1px solid #8a3b3b;
  background: rgba(239, 100, 97, 0.12);
  color: #f08887;
}

.autodetect-bar {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
}

.autodetect-btn {
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: #07120d;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.autodetect-info {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.5;
}

.autodetect-bar {
  flex-wrap: wrap;
}

.test-btn {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.test-btn:disabled {
  cursor: wait;
  opacity: 0.6;
}

.test-result {
  margin-bottom: 16px;
  padding: 12px 14px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  font-size: 13px;
}

.test-result--ok {
  border-color: #2a6e4a;
  background: rgba(58, 166, 117, 0.12);
  color: #5fd6a0;
}

.test-result--fail {
  border-color: #8a3b3b;
  background: rgba(239, 100, 97, 0.12);
  color: #f08887;
}

.test-result__msg {
  margin: 0;
  line-height: 1.5;
}

.test-result__preview {
  margin: 8px 0 0;
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.5;
  word-break: break-all;
}

.config-form {
  display: grid;
  gap: 20px;
}

.section {
  display: grid;
  gap: 16px;
  padding: 20px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
}

.section-title {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 650;
  color: var(--color-text);
}

.field {
  display: grid;
  gap: 8px;
}

.field span {
  color: var(--color-text-muted);
  font-size: 13px;
}

.field .required {
  color: var(--color-danger);
}

.field-hint {
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.5;
}

select,
input[type='text'],
input[type='number'] {
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 10px 12px;
  font-size: 13px;
}

.accordion-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 13px;
  cursor: pointer;
  padding: 0;
}

.advanced-panel {
  display: grid;
  gap: 12px;
  margin-top: 12px;
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
}

.advanced-hint {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.5;
}

.format-btn {
  justify-self: start;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}

.json-editor {
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  color: var(--color-text);
  padding: 10px 12px;
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Consolas, monospace;
  font-size: 13px;
  resize: vertical;
  min-height: 120px;
}

.json-error {
  color: var(--color-danger);
  font-size: 13px;
}

.save-button {
  margin-top: 8px;
  border: 0;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: #07120d;
  padding: 12px;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
}

.save-button:disabled {
  cursor: wait;
  opacity: 0.7;
}

.url-validation {
  font-size: 12px;
  line-height: 1.5;
}

.url-validation--ok {
  color: #5fd6a0;
}

.url-validation--warn {
  color: #e0c36a;
}

.url-validation--error {
  color: var(--color-danger);
}

.url-validation--empty {
  color: var(--color-text-muted);
}

.import-btn {
  justify-self: start;
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: rgba(58, 166, 117, 0.08);
  color: var(--color-accent-strong);
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}

.advanced-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.fill-btn {
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: var(--color-accent);
  color: #07120d;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.imported-mark {
  color: var(--color-accent-strong);
  font-size: 12px;
}
</style>
