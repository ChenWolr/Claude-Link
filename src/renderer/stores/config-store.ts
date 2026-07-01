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
import type { AppConfig, ModelInfo, DetectedClaudeConfig } from '../../shared/types/config';
import type { CliDetectionResult } from '../../shared/types/cli';
import { DEFAULT_TASK_DELAY_SECONDS, DEFAULT_THEME_PALETTE_ID, DEFAULT_FONT_SCALE } from '../../shared/constants';
import {
  parseClaudeSettings,
  extractModelMappings,
  syncFormToAdvancedJson,
  setModelMappingInAdvancedJson,
  stripConnectionFromAdvancedJson,
} from '../../shared/settings-parser';

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
  fontScale: DEFAULT_FONT_SCALE,
  contextWindowOverride: null,
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
    // 防循环：setModelMapping 写 advancedJson 期间置 true，ConfigPage 的 watch 检测到则跳过回填
    updatingFromJson: false,
    // 配置/数据落盘目录（点 4：让用户知道配置存在哪）
    storageInfo: null as { userData: string; config: string; workspaces: string; db: string } | null,
  }),
  getters: {
    // 从 advancedJson 的 env 提取 Claude Code 类型别名 → 实际模型映射
    // （ANTHROPIC_DEFAULT_SONNET_MODEL 等），供 ModelSelector 显示"类型 → 实际模型"。
    modelMappings(state): Record<string, string> {
      return extractModelMappings(state.config.advancedJson);
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
    async loadStorageInfo() {
      try {
        this.storageInfo = await window.claudeLink.getStorageInfo();
      } catch {
        // 静默
      }
    },
    // 一键清空"连接"相关：重置供应商字段 + 从 advancedJson 移除 key/url/模型映射 env。
    // 字段与 JSON 同步清空，确保连接 tab 全部可清。
    clearConnectionConfig() {
      this.updatingFromJson = true;
      this.config.provider = 'anthropic';
      this.config.providerName = '';
      this.config.providerNote = '';
      this.config.apiKey = '';
      this.config.apiBaseUrl = 'https://api.anthropic.com';
      this.config.advancedJson = stripConnectionFromAdvancedJson(this.config.advancedJson);
      this.importedFields.delete('apiKey');
      this.importedFields.delete('apiBaseUrl');
      void nextTick(() => {
        this.updatingFromJson = false;
      });
    },
    async saveConfig() {
      this.savingConfig = true;
      this.error = null;
      try {
        // this.config 是 Pinia/Vue 的 reactive proxy，无法被 Electron IPC 结构化克隆，
        // 直接传输会抛 "An object could not be cloned."，保存失败、配置无法持久化。
        // 必须先深拷贝成纯普通对象再过 IPC。
        const plainConfig: AppConfig = JSON.parse(JSON.stringify(this.config));
        this.config = await window.claudeLink.saveConfig(plainConfig);
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
      contextWindowOverride?: number | null;
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
      if (extracted.contextWindowOverride !== undefined) {
        this.config.contextWindowOverride = extracted.contextWindowOverride;
        this.importedFields.add('contextWindowOverride');
      }
      void nextTick(() => {
        this.updatingFromJson = false;
      });
    },
    // 表单→JSON 反向同步：设置模型类型别名(sonnet/haiku/opus/fable)→实际模型的映射，
    // 写入 advancedJson.env.ANTHROPIC_DEFAULT_*_MODEL。置 updatingFromJson 阻止
    // ConfigPage 的 watch 把这次程序写入又当成"用户改 JSON"去回填（防循环）。
    setModelMapping(alias: ModelAlias, value: string): void {
      this.updatingFromJson = true;
      this.config.advancedJson = setModelMappingInAdvancedJson(this.config.advancedJson, alias, value);
      void nextTick(() => {
        this.updatingFromJson = false;
      });
    },
    // 表单→JSON：把 apiKey/apiBaseUrl/permissionMode 同步进 advancedJson（settings 结构）。
    // 模型映射走 setModelMapping。JSON→表单回填期间（updatingFromJson）跳过，防循环。
    syncFormToAdvanced(): void {
      if (this.updatingFromJson) return;
      this.updatingFromJson = true;
      this.config.advancedJson = syncFormToAdvancedJson(this.config.advancedJson, {
        apiKey: this.config.apiKey,
        apiBaseUrl: this.config.apiBaseUrl,
        permissionMode: this.config.permissionMode,
        contextWindowOverride: this.config.contextWindowOverride,
      });
      void nextTick(() => {
        this.updatingFromJson = false;
      });
    },
  },
});
