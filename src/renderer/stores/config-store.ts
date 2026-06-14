import { defineStore } from 'pinia';
import type { AppConfig, ModelInfo } from '../../shared/types/config';
import type { CliDetectionResult } from '../../shared/types/cli';
import { DEFAULT_TASK_DELAY_SECONDS, DEFAULT_THEME_PALETTE_ID } from '../../shared/constants';

const defaultConfig: AppConfig = {
  provider: 'anthropic',
  providerName: 'Anthropic',
  providerNote: '',
  apiKey: '',
  apiBaseUrl: 'https://api.anthropic.com',
  defaultModel: 'claude-sonnet-4-6',
  advancedJson: '{}',
  cliPath: null,
  cliVersion: null,
  workingDirectory: null,
  permissionMode: 'default',
  maxTurns: 200,
  taskDelaySeconds: DEFAULT_TASK_DELAY_SECONDS,
  themePaletteId: DEFAULT_THEME_PALETTE_ID,
};

export const useConfigStore = defineStore('config', {
  state: () => ({
    config: { ...defaultConfig } as AppConfig,
    cliStatus: null as CliDetectionResult | null,
    models: [] as ModelInfo[],
    loadingConfig: false,
    savingConfig: false,
    detectingCli: false,
    fetchingModels: false,
    error: null as string | null,
    importedFields: new Set<string>(),
  }),
  actions: {
    async loadConfig() {
      this.loadingConfig = true;
      this.error = null;
      try {
        this.config = await window.claudeLink.getConfig();
      } catch (error) {
        this.error = error instanceof Error ? error.message : '加载配置失败';
      } finally {
        this.loadingConfig = false;
      }
    },
    async saveConfig() {
      this.savingConfig = true;
      this.error = null;
      try {
        this.config = await window.claudeLink.saveConfig(this.config);
      } catch (error) {
        this.error = error instanceof Error ? error.message : '保存配置失败';
        throw error;
      } finally {
        this.savingConfig = false;
      }
    },
    async detectCli() {
      this.detectingCli = true;
      this.error = null;
      try {
        this.cliStatus = await window.claudeLink.detectCli();
        this.config.cliPath = this.cliStatus.path;
        this.config.cliVersion = this.cliStatus.version;
      } catch (error) {
        this.error = error instanceof Error ? error.message : '检测 Claude Code CLI 失败';
      } finally {
        this.detectingCli = false;
      }
    },
    async fetchModels() {
      if (!this.config.apiKey.trim()) {
        this.error = '请先填写 API Key';
        return;
      }

      this.fetchingModels = true;
      this.error = null;
      try {
        this.models = await window.claudeLink.fetchModels(this.config.provider, this.config.apiKey, this.config.apiBaseUrl);
      } catch (error) {
        this.error = error instanceof Error ? error.message : '获取模型列表失败';
      } finally {
        this.fetchingModels = false;
      }
    },
    async importSettings(filePath: string) {
      try {
        const extracted = await window.claudeLink.importSettings(filePath);
        this.applyExtractedSettings(extracted);
      } catch (error) {
        this.error = error instanceof Error ? error.message : '导入失败';
      }
    },
    // 直接从高级 JSON 文本框内容解析并回填字段。
    // 与主进程 parseClaudeSettings 保持相同的字段提取规则。
    fillFromAdvancedJson(): { ok: boolean; message: string } {
      const raw = this.config.advancedJson?.trim() || '{}';
      let settings: Record<string, unknown>;
      try {
        settings = JSON.parse(raw) as Record<string, unknown>;
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : 'JSON 格式错误' };
      }

      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return { ok: false, message: 'settings.json 必须是一个 JSON 对象' };
      }

      const remaining: Record<string, unknown> = { ...settings };
      const extracted: { apiKey?: string; apiBaseUrl?: string; defaultModel?: string; advancedJson?: string } = {};

      if (typeof remaining.apiKey === 'string') {
        extracted.apiKey = remaining.apiKey;
        delete remaining.apiKey;
      }
      if (typeof remaining.apiBaseUrl === 'string') {
        extracted.apiBaseUrl = remaining.apiBaseUrl;
        delete remaining.apiBaseUrl;
      } else if (typeof remaining.baseUrl === 'string') {
        extracted.apiBaseUrl = remaining.baseUrl;
        delete remaining.baseUrl;
      }
      if (typeof remaining.model === 'string') {
        extracted.defaultModel = remaining.model;
        delete remaining.model;
      }
      if (Object.keys(remaining).length > 0) {
        extracted.advancedJson = JSON.stringify(remaining, null, 2);
      }

      this.applyExtractedSettings(extracted);
      return { ok: true, message: '已从 JSON 填充字段' };
    },
    applyExtractedSettings(extracted: {
      apiKey?: string;
      apiBaseUrl?: string;
      defaultModel?: string;
      advancedJson?: string;
    }): void {
      if (extracted.apiKey) {
        this.config.apiKey = extracted.apiKey;
        this.importedFields.add('apiKey');
      }
      if (extracted.apiBaseUrl) {
        this.config.apiBaseUrl = extracted.apiBaseUrl;
        this.importedFields.add('apiBaseUrl');
      }
      if (extracted.defaultModel) {
        this.config.defaultModel = extracted.defaultModel;
        this.importedFields.add('defaultModel');
      }
      if (extracted.advancedJson && extracted.advancedJson !== '{}') {
        this.config.advancedJson = extracted.advancedJson;
        this.importedFields.add('advancedJson');
      }
    },
  },
});
