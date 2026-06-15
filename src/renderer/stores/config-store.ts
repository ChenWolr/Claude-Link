// config-store.ts
// 配置状态：AppConfig + 表单↔JSON 双向绑定 + 模型映射 + 防循环。
//
// advancedJson 作为 settings.json 单一数据源；输入框（apiKey/url/permissionMode/模型映射）是其双向视图。
// 表单→JSON：setModelMapping（模型映射）/ syncFormToAdvanced（apiKey/url/permissionMode）；
// JSON→表单：applyExtractedSettings（parseClaudeSettings 后回填，peek 不删保留 env）。
// 防循环：updatingFromJson 标志（JSON→表单期间置 true，阻止表单 watch 反向同步），nextTick 释放。

import { defineStore } from 'pinia';
import { nextTick } from 'vue';

export type ModelAlias = 'sonnet' | 'haiku' | 'opus' | 'fable';
import type { AppConfig, ModelInfo, DetectedClaudeConfig, ConnectionTestResult } from '../../shared/types/config';
import type { CliDetectionResult } from '../../shared/types/cli';
import { DEFAULT_TASK_DELAY_SECONDS, DEFAULT_THEME_PALETTE_ID } from '../../shared/constants';
import { parseClaudeSettings } from '../../shared/settings-parser';

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
    testingConnection: false,
    error: null as string | null,
    importedFields: new Set<string>(),
    // 防循环：setModelMapping 写 advancedJson 期间置 true，ConfigPage 的 watch 检测到则跳过回填
    updatingFromJson: false,
  }),
  getters: {
    // 从 advancedJson 的 env 提取 Claude Code 类型别名 → 实际模型映射
    // （ANTHROPIC_DEFAULT_SONNET_MODEL 等），供 ModelSelector 显示"类型 → 实际模型"。
    modelMappings(state): Record<string, string> {
      try {
        const adv = JSON.parse(state.config.advancedJson || '{}');
        const env = adv && adv.env && typeof adv.env === 'object' ? (adv.env as Record<string, unknown>) : {};
        const out: Record<string, string> = {};
        const pairs: Array<[string, string]> = [
          ['sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
          ['haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
          ['opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
          ['fable', 'ANTHROPIC_DEFAULT_FABLE_MODEL'],
        ];
        for (const [alias, envKey] of pairs) {
          const v = env[envKey];
          if (typeof v === 'string' && v.trim()) out[alias] = v.trim();
        }
        return out;
      } catch {
        return {};
      }
    },
  },
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
        // 无 key 不报错：ModelSelector 有 sonnet/haiku/opus 兜底
        this.models = [];
        return;
      }

      this.fetchingModels = true;
      try {
        this.models = await window.claudeLink.fetchModels(this.config.provider, this.config.apiKey, this.config.apiBaseUrl);
      } catch {
        // 第三方/国产模型端点通常无 /models 接口，失败属正常——ModelSelector 会用 sonnet/haiku/opus 兜底。
        // 整体配置是否可用改由「测试连接」按钮验证，不在这里污染全局 error 误导用户。
        this.models = [];
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
    // 自动扫描系统 Claude Code 配置（settings.json / .claude.json / .credentials.json），
    // 回填 apiKey/apiBaseUrl/defaultModel/advancedJson。OAuth token 绝不读取，只判存在性。
    async autoDetectClaudeConfig(): Promise<DetectedClaudeConfig | null> {
      try {
        const detected = await window.claudeLink.autoDetectClaudeConfig();
        if (!detected.found) {
          this.error = '未找到 Claude Code 配置（请确认已安装 Claude Code 并至少登录/配置过一次）';
          return null;
        }
        this.applyExtractedSettings(detected);
        return detected;
      } catch (error) {
        this.error = error instanceof Error ? error.message : '自动检测失败';
        return null;
      }
    },
    // 测试连接：先保存当前配置，再用它调 CLI 发"你好"验证。返回结果供 UI 展示。
    async testConnection(): Promise<ConnectionTestResult | null> {
      this.testingConnection = true;
      this.error = null;
      try {
        await this.saveConfig();
        return await window.claudeLink.testConnection();
      } catch (error) {
        this.error = error instanceof Error ? error.message : '测试连接失败';
        return null;
      } finally {
        this.testingConnection = false;
      }
    },
    // 直接从高级 JSON 文本框内容解析并回填字段。
    // 复用主进程同一个 parseClaudeSettings，确保规则一致（含 Claude Code 的 env.* 字段）。
    fillFromAdvancedJson(): { ok: boolean; message: string } {
      const raw = this.config.advancedJson?.trim() || '{}';
      try {
        const parsed = parseClaudeSettings(raw);
        this.applyExtractedSettings(parsed);
        return { ok: true, message: '已从 JSON 填充字段' };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : 'JSON 格式错误' };
      }
    },
    applyExtractedSettings(extracted: {
      apiKey?: string;
      apiBaseUrl?: string;
      defaultModel?: string;
      advancedJson?: string;
    }): void {
      // JSON→表单回填：置标志阻止 ConfigPage 表单 watch 反向同步（防循环）
      this.updatingFromJson = true;
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
      void nextTick(() => {
        this.updatingFromJson = false;
      });
    },
    // 表单→JSON 反向同步：设置模型类型别名(sonnet/haiku/opus/fable)→实际模型的映射，
    // 写入 advancedJson.env.ANTHROPIC_DEFAULT_*_MODEL。置 updatingFromJson 阻止
    // ConfigPage 的 watch 把这次程序写入又当成"用户改 JSON"去回填（防循环）。
    setModelMapping(alias: ModelAlias, value: string): void {
      let adv: Record<string, unknown>;
      try {
        adv =
          this.config.advancedJson && this.config.advancedJson.trim()
            ? (JSON.parse(this.config.advancedJson) as Record<string, unknown>)
            : {};
      } catch {
        adv = {};
      }
      if (!adv.env || typeof adv.env !== 'object' || Array.isArray(adv.env)) {
        adv.env = {};
      }
      const env = adv.env as Record<string, unknown>;
      const key = `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`;
      const v = value.trim();
      if (v) env[key] = v;
      else delete env[key];
      if (Object.keys(env).length === 0) delete adv.env;
      this.updatingFromJson = true;
      this.config.advancedJson = JSON.stringify(adv, null, 2);
      void nextTick(() => {
        this.updatingFromJson = false;
      });
    },
    // 表单→JSON：把 apiKey/apiBaseUrl/permissionMode 同步进 advancedJson（settings 结构）。
    // 模型映射走 setModelMapping。JSON→表单回填期间（updatingFromJson）跳过，防循环。
    syncFormToAdvanced(): void {
      if (this.updatingFromJson) return;
      let adv: Record<string, unknown>;
      try {
        adv = this.config.advancedJson && this.config.advancedJson.trim()
          ? (JSON.parse(this.config.advancedJson) as Record<string, unknown>)
          : {};
      } catch {
        adv = {};
      }
      if (!adv.env || typeof adv.env !== 'object' || Array.isArray(adv.env)) {
        adv.env = {};
      }
      const env = adv.env as Record<string, unknown>;
      if (this.config.apiKey) env.ANTHROPIC_API_KEY = this.config.apiKey;
      else delete env.ANTHROPIC_API_KEY;
      const url = this.config.apiBaseUrl?.trim();
      if (url && url !== 'https://api.anthropic.com') env.ANTHROPIC_BASE_URL = url;
      else delete env.ANTHROPIC_BASE_URL;
      const permissions = (adv.permissions && typeof adv.permissions === 'object'
        ? adv.permissions
        : {}) as Record<string, unknown>;
      permissions.defaultMode = this.config.permissionMode;
      adv.permissions = permissions;
      if (Object.keys(env).length === 0) delete adv.env;
      this.updatingFromJson = true;
      this.config.advancedJson = JSON.stringify(adv, null, 2);
      void nextTick(() => {
        this.updatingFromJson = false;
      });
    },
  },
});
