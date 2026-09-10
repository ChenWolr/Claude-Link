// config-store.ts
// 配置状态：AppConfig + advancedJson 单一数据源 + 自动检测回填 + 防循环。
//
// 多供应商库上线后，连接字段（供应商/key/url）的真源是 provider-store（主进程 ProviderProfile）；
// 本 store 仍承载行为/外观字段与 advancedJson（全局 Claude 设置）的编辑与自动保存。
// updatingFromJson：历史防循环标志（旧表单 watch 消费），现无任何读取点，仅导入回填时例行
// 置位/释放；自动保存靠 ConfigPage 的 configSnapshot 快照比对防回写循环。可删（连同置位逻辑）。

import { defineStore } from 'pinia';
import { nextTick, ref } from 'vue';

// ModelAlias 类型定义在 shared/types/config（供 shared 层 AppConfig 与渲染层共用）。
import type { ModelAlias } from '../../shared/types/config';
export type { ModelAlias };
import type { AppConfig, DetectedClaudeConfig } from '../../shared/types/config';
import type { CliDetectionResult } from '../../shared/types/cli';
import { DEFAULT_THEME_PALETTE_ID, DEFAULT_FONT_SCALE } from '../../shared/constants';
import { DEFAULT_TASK_DELAY_MINUTES } from '../../shared/queue-config';
import { parseClaudeSettings } from '../../shared/settings-parser';

// H1（F5 重做）：设置保存失败跨卸载可感知标志。ConfigPage 组件局部 saveStatus 在页面卸载后
// 无渲染、其 watch 随 setup 停止——失败对用户不可见，且重进页被 loadConfig 用主进程旧值
// 回滚。此模块级 ref 与组件生命周期解耦：saveConfig 失败置 true、成功清 false；App.vue 全局
// watch 在 false→true 边沿弹一次 toast，ConfigPage performInit 开头据它用内存值重存一次。
export const lastSaveFailed = ref(false);

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
  queueEnabled: false,
  taskDelayMinutes: DEFAULT_TASK_DELAY_MINUTES,
  themePaletteId: DEFAULT_THEME_PALETTE_ID,
  fontScale: DEFAULT_FONT_SCALE,
  contextWindowByAlias: {},
  defaultThinkingLevel: 'medium',
  // 引擎后台请求六开关默认全开（与主进程 config-manager 默认保持同值；UI 已隐藏）。
  disableAutoMemory: true,
  disableBackgroundTasks: true,
  disableCron: true,
  disableFeedbackSurvey: true,
  disableTelemetry: true,
  disableNonessentialTraffic: true,
  lastUsedProviderId: null,
  lastUsedModelId: null,
  notifyOnLeave: true,
  minimizeToTray: false,
  // reasoning_replay 自动重试默认开（与主进程 config-manager 默认保持同值）。
  autoRetryReasoningReplay: true,
};

export const useConfigStore = defineStore('config', {
  state: () => ({
    config: { ...defaultConfig } as AppConfig,
    cliStatus: null as CliDetectionResult | null,
    loadingConfig: false,
    savingConfig: false,
    detectingCli: false,
    error: null as string | null,
    importedFields: new Set<string>(),
    // 历史防循环标志：现无任何读取点（防回写循环由 ConfigPage 的 configSnapshot 快照比对承担）
    updatingFromJson: false,
    // 配置/数据落盘目录（点 4：让用户知道配置存在哪）
    storageInfo: null as { userData: string; config: string; workspaces: string; db: string } | null,
    // Task 3 Step 5：原生 settings 诊断摘要（脱敏视图，供 UI 核验 user/project/local 实际加载来源）
    nativeSettingsDiagnostic: null as import('../../shared/types/ipc').NativeSettingsDiagnostic | null,
    // 诊断请求代际：快速切换工作目录时，旧 IPC 结果不得覆盖新目录诊断。
    nativeSettingsDiagnosticRequestId: 0,
  }),
  getters: {},
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
    // Task 3 Step 5：拉取某工作目录的原生 settings 诊断摘要（脱敏）。失败置 null 不抛到页面——
    // 诊断是可选的核验能力，不能因 SDK resolveSettings 缺失或目录异常阻塞配置页。
    async loadNativeSettingsDiagnostic(workingDir: string) {
      const requestId = ++this.nativeSettingsDiagnosticRequestId;
      try {
        const diagnostic = await window.claudeLink.getNativeSettingsDiagnostic(workingDir);
        // 结果写回前同时校验请求仍是最新代际，且 config 未切换到其它 cwd。
        if (
          requestId === this.nativeSettingsDiagnosticRequestId &&
          this.config.workingDirectory === workingDir
        ) {
          this.nativeSettingsDiagnostic = diagnostic;
        }
      } catch {
        if (
          requestId === this.nativeSettingsDiagnosticRequestId &&
          this.config.workingDirectory === workingDir
        ) {
          this.nativeSettingsDiagnostic = null;
        }
      }
    },
    invalidateNativeSettingsDiagnostic() {
      this.nativeSettingsDiagnosticRequestId++;
      this.nativeSettingsDiagnostic = null;
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
        // H1：保存成功清失败标志（App.vue 的 toast 只在 false→true 边沿弹，不重复打扰）。
        lastSaveFailed.value = false;
        // 主进程 saveConfig 末尾已把配置投影写入 <工作目录>/.claude/settings.local.json。
        // 刷新诊断使其反映最新的 effective settings（advancedJson/permissionMode/模型等变化后
        // 若只依赖 workingDirectory watcher，页面会继续展示保存前的过期 effectiveKeys/来源）。
        // 复用 loadNativeSettingsDiagnostic 的请求代际校验，避免与目录切换的刷新互相覆盖。
        if (this.config.workingDirectory) {
          await this.loadNativeSettingsDiagnostic(this.config.workingDirectory);
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : '保存配置失败';
        // H1：失败置标志。注意 this.config 未被覆写（赋值在成功分支）——内存里仍是失败时
        // 的编辑值，performInit 重存与 App.vue toast 都以此为前提。
        lastSaveFailed.value = true;
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
      contextWindowByAlias?: Partial<Record<ModelAlias, number>>;
    }): void {
      // JSON→表单回填：例行置位/释放（历史防循环标志，现无读取点；防回写循环靠 configSnapshot 快照比对）
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
      if (extracted.contextWindowByAlias !== undefined) {
        this.config.contextWindowByAlias = extracted.contextWindowByAlias;
        this.importedFields.add('contextWindowByAlias');
      }
      void nextTick(() => {
        this.updatingFromJson = false;
      });
    },
  },
});
