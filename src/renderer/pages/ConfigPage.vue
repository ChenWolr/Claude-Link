<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useConfigStore } from '../stores/config-store';
import ProviderSelect from '../components/config/ProviderSelect.vue';
import ApiKeyInput from '../components/config/ApiKeyInput.vue';
import ModelMappingInputs from '../components/config/ModelMappingInputs.vue';
import ThemeSelector from '../components/config/ThemeSelector.vue';
import TestConnectionModal from '../components/config/TestConnectionModal.vue';
import { useInteractionStore } from '../stores/interaction-store';
import { THEME_PALETTES } from '../../shared/constants';
import { parseClaudeSettings } from '../../shared/settings-parser';

const store = useConfigStore();
const router = useRouter();
const interactionStore = useInteractionStore();
const toast = ref<string | null>(null);
const toastType = ref<'success' | 'error'>('success');
const advancedJsonError = ref<string | null>(null);

// 分类标签页：连接（含供应商/端点/模型映射/高级 JSON）/ 行为 / 外观。
// 连接、模型、高级同属"如何接入 API"，合并在一页用子卡片分隔。
type TabId = 'connection' | 'behavior' | 'appearance';
const activeTab = ref<TabId>('connection');

// 自动保存：监听所有用户可编辑的持久化字段，700ms 防抖落盘，确保所有配置都永久保存。
// 用快照字符串比对建立基线，避免 saveConfig 回写 config 时触发死循环；
// cliPath/cliVersion/workingDirectory 由系统维护（自动检测/未开放编辑），不纳入快照。
const PERSISTED_FIELDS = [
  'provider', 'providerName', 'providerNote', 'apiKey', 'apiBaseUrl',
  'defaultModel', 'advancedJson', 'permissionMode', 'maxTurns', 'taskDelaySeconds', 'themePaletteId',
] as const;
const saveStatus = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
let initialized = false;
let lastSavedSnapshot = '';
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let savedIndicatorTimer: ReturnType<typeof setTimeout> | null = null;

function configSnapshot(): string {
  return JSON.stringify(PERSISTED_FIELDS.map((f) => store.config[f]));
}

function scheduleAutoSave(): void {
  saveStatus.value = 'saving';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!initialized) return;
    lastSavedSnapshot = configSnapshot(); // 以"将保存的值"为基线，防回写循环
    try {
      await store.saveConfig();
      saveStatus.value = 'saved';
      if (savedIndicatorTimer) clearTimeout(savedIndicatorTimer);
      savedIndicatorTimer = setTimeout(() => { saveStatus.value = 'idle'; }, 2000);
    } catch {
      saveStatus.value = 'error';
    }
  }, 700);
}

watch(configSnapshot, (snap) => {
  if (!initialized) return; // 初次加载期间不自动保存
  if (snap === lastSavedSnapshot) return; // 回写或无变化不触发
  scheduleAutoSave();
});

async function performInit() {
  await store.loadConfig();
  await store.detectCli();
  await store.loadStorageInfo();
  // 建立基线：此后任何字段变化才视为"用户改动"触发自动保存。
  lastSavedSnapshot = configSnapshot();
  initialized = true;
}

onMounted(performInit);

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
  // 立即落盘（不等防抖），并修正 URL 尾部斜杠
  const baseUrl = store.config.apiBaseUrl?.trim();
  if (baseUrl && baseUrl.endsWith('/') && !baseUrl.endsWith('/v1/')) {
    store.config.apiBaseUrl = baseUrl.slice(0, -1);
  }
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    await store.saveConfig();
    lastSavedSnapshot = configSnapshot();
    saveStatus.value = 'saved';
    toastType.value = 'success';
    toast.value = '配置已保存';
  } catch {
    saveStatus.value = 'error';
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

const showTestModal = ref(false);

async function handleTestConnection() {
  // 测试前先回填字段并持久化，确保测试用的是最新配置（消除贴 JSON 未保存的竞态）。
  try {
    store.fillFromAdvancedJson();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await store.saveConfig();
    lastSavedSnapshot = configSnapshot();
    saveStatus.value = 'saved';
  } catch {
    // 保存失败不阻塞测试——测试连接会从 advancedJson 兜底取 key/url。
  }
  showTestModal.value = true;
}

function handleFillFromJson() {
  const result = store.fillFromAdvancedJson();
  toastType.value = result.ok ? 'success' : 'error';
  toast.value = result.message;
  setTimeout(() => {
    toast.value = null;
  }, 3000);
}

// 一键清空连接配置：供应商/API Key/请求地址字段 + 高级 JSON 对应 env 键 + 模型映射。
// 用 interaction 队列的 requestConfirm 确认，避免 window.confirm 导致 Electron 焦点丢失。
async function handleClearConnection() {
  const ok = await interactionStore.requestConfirm({
    title: '清空连接配置',
    message: '确定清空连接配置？供应商、API Key、请求地址会重置，高级 JSON 里对应的 env 键（含模型映射）也会一并移除。',
    confirmText: '清空',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;
  store.clearConnectionConfig();
  toastType.value = 'success';
  toast.value = '已清空连接配置';
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

    <!-- 配置/数据存储目录（点 4：让用户知道配置信息存在哪）-->
    <details v-if="store.storageInfo" class="storage-info">
      <summary>配置与数据存储目录</summary>
      <div class="storage-info__body">
        <div><span>根目录</span><code>{{ store.storageInfo.userData }}</code></div>
        <div><span>配置文件</span><code>{{ store.storageInfo.config }}</code></div>
        <div><span>工作空间历史</span><code>{{ store.storageInfo.workspaces }}</code></div>
        <div><span>会话数据库</span><code>{{ store.storageInfo.db }}</code></div>
      </div>
    </details>

    <!-- 顶部操作：自动检测 / 测试连接 / 保存状态 -->
    <div class="autodetect-bar">
      <button type="button" class="autodetect-btn" @click="handleAutoDetect">自动检测配置</button>
      <button type="button" class="test-btn" @click="handleTestConnection">测试连接</button>
      <span v-if="saveStatus !== 'idle'" :class="['save-badge', `save-badge--${saveStatus}`]">
        <span v-if="saveStatus === 'saving'" class="save-badge__dot" />
        {{ saveStatus === 'saving' ? '保存中…' : saveStatus === 'saved' ? '已自动保存' : '保存失败' }}
      </span>
      <p v-if="autoDetectInfo" class="autodetect-info">{{ autoDetectInfo }}</p>
    </div>
    <TestConnectionModal v-model:visible="showTestModal" />

    <!-- 分类标签页 -->
    <nav class="tabs">
      <button type="button" :class="['tab', { 'tab--active': activeTab === 'connection' }]" @click="activeTab = 'connection'">连接</button>
      <button type="button" :class="['tab', { 'tab--active': activeTab === 'behavior' }]" @click="activeTab = 'behavior'">行为</button>
      <button type="button" :class="['tab', { 'tab--active': activeTab === 'appearance' }]" @click="activeTab = 'appearance'">外观</button>
    </nav>

    <form class="config-form" @submit.prevent="handleSave">
      <!-- 连接：供应商与端点 / 模型映射 / 高级 JSON（同属"如何接入 API"，合并一页）-->
      <div v-show="activeTab === 'connection'" class="connection-stack">
        <div class="section">
          <div class="section-head">
            <h3 class="section-title">供应商与端点</h3>
            <button type="button" class="clear-btn" @click="handleClearConnection">清空连接配置</button>
          </div>
          <ProviderSelect v-model="store.config.provider" />
          <label class="field">
            <span>供应商名称 <span class="required">*</span></span>
            <input v-model="store.config.providerName" type="text" placeholder="例如：sub2Api" />
          </label>
          <label class="field">
            <span>备注</span>
            <input v-model="store.config.providerNote" type="text" placeholder="可选" />
          </label>
          <ApiKeyInput v-model="store.config.apiKey" />
          <div v-if="store.importedFields.has('apiKey')" class="imported-mark">✓ 已从 settings.json 导入</div>
          <label class="field">
            <span>请求地址（API Base URL） <span class="required">*</span></span>
            <input v-model="store.config.apiBaseUrl" type="text" placeholder="https://api.anthropic.com" />
            <small class="field-hint">填写兼容 Claude API 的服务端点。官方直连模式应使用 https://api.anthropic.com</small>
            <div v-if="store.importedFields.has('apiBaseUrl')" class="imported-mark">✓ 已从 settings.json 导入</div>
            <div v-if="urlValidation.message" :class="['url-validation', `url-validation--${urlValidation.status}`]">
              {{ urlValidation.message }}
            </div>
          </label>
        </div>

        <div class="section">
          <h3 class="section-title">模型映射</h3>
          <small class="field-hint">这就是"模型"配置：填入实际模型名（如 glm-5.2），会自动写入下方高级 JSON 的 env（ANTHROPIC_DEFAULT_*_MODEL）并双向同步。会话里选 sonnet/haiku 等别名，CLI 自动走映射。</small>
          <ModelMappingInputs />
        </div>

        <div class="section">
          <h3 class="section-title">高级 JSON</h3>
          <div class="advanced-panel">
            <p class="advanced-hint">直接粘贴 Claude Code 的 settings.json，点"从 JSON 填充字段"可自动回填 API Key / 请求地址 / 模型；反之，改上面的字段也会实时同步回这里的 env。运行 CLI 时仅字符串字段会作为环境变量注入。</p>
            <div class="advanced-actions">
              <button type="button" class="import-btn" @click="handleImportSettings">导入 settings.json 文件</button>
              <button type="button" class="fill-btn" @click="handleFillFromJson">从 JSON 填充字段</button>
            </div>
            <div v-if="store.importedFields.has('advancedJson')" class="imported-mark">✓ 已从 settings.json 导入</div>
            <button type="button" class="format-btn" @click="formatJson">格式化</button>
            <textarea v-model="store.config.advancedJson" class="json-editor" rows="8" placeholder='{"key": "value"}' />
            <div v-if="advancedJsonError" class="json-error">{{ advancedJsonError }}</div>
            <div v-if="!advancedJsonValid" class="json-error">JSON 格式错误</div>
          </div>
        </div>
      </div>

      <!-- 行为：轮次 / 队列间隔（权限模式已移至会话内调整）-->
      <div v-show="activeTab === 'behavior'" class="section">
        <h3 class="section-title">行为</h3>
        <label class="field">
          <span>最大轮次 <small class="field-hint">对应 Claude Code <code>--max-turns</code>：限制单次会话的最大工具调用轮数。</small></span>
          <input v-model.number="store.config.maxTurns" type="number" min="1" />
        </label>
        <label class="field">
          <span>队列任务间隔（秒） <small class="field-hint">Claude Link 自身功能：任务队列里两条任务之间的等待时间。<strong>非</strong> Claude Code 配置。</small></span>
          <input v-model.number="store.config.taskDelaySeconds" type="number" min="0" />
        </label>
        <p class="field-hint">权限模式（default / acceptEdits / plan / bypassPermissions）已改为在<strong>会话内</strong>按需调整，不再放在这里。</p>
      </div>

      <!-- 外观：主题 -->
      <div v-show="activeTab === 'appearance'" class="section">
        <h3 class="section-title">外观</h3>
        <ThemeSelector :selected-id="store.config.themePaletteId" @select="handleThemeSelect" />
      </div>

      <!-- 保存：始终可见，与所在标签页无关 -->
      <div class="save-bar">
        <span class="save-bar__status">
          <span v-if="saveStatus === 'saving'" class="save-badge__dot" />
          {{ saveStatus === 'saving' ? '保存中…' : saveStatus === 'saved' ? '已自动保存' : saveStatus === 'error' ? '有未保存的更改（保存失败）' : '所有配置自动保存到本地' }}
        </span>
        <button class="save-button" type="submit" :disabled="store.savingConfig">
          {{ store.savingConfig ? '保存中...' : '立即保存' }}
        </button>
      </div>
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

.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--color-border);
}

.tab {
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  padding: 10px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color 0.15s, border-color 0.15s;
}

.tab:hover {
  color: var(--color-text);
}

.tab--active {
  color: var(--color-accent-strong);
  border-bottom-color: var(--color-accent);
}

.save-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--radius-md);
  font-size: 12px;
}

.save-badge--saving {
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
}

.save-badge--saved {
  background: rgba(58, 166, 117, 0.12);
  color: #5fd6a0;
}

.save-badge--error {
  background: rgba(239, 100, 97, 0.12);
  color: #f08887;
}

.save-badge__dot {
  width: 8px;
  height: 8px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  opacity: 0.7;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.save-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.save-bar__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--color-text-muted);
  font-size: 12px;
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

.connection-stack {
  display: grid;
  gap: 20px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.clear-btn {
  justify-self: end;
  border: 1px solid rgba(239, 100, 97, 0.4);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-danger);
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
}

.clear-btn:hover {
  background: rgba(239, 100, 97, 0.12);
}

.storage-info {
  margin-bottom: 20px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  padding: 10px 14px;
  font-size: 12px;
}

.storage-info summary {
  cursor: pointer;
  color: var(--color-text-muted);
}

.storage-info__body {
  display: grid;
  gap: 4px;
  margin-top: 10px;
}

.storage-info__body div {
  display: flex;
  gap: 10px;
  align-items: baseline;
}

.storage-info__body span {
  color: var(--color-text-muted);
  min-width: 96px;
  flex-shrink: 0;
}

.storage-info__body code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  color: var(--color-text);
  word-break: break-all;
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
