// config-store.ts
// 配置状态：AppConfig + advancedJson 单一数据源 + 防循环。
// （settings.json 导入/自动检测回填死链路已于 2026-09-20 删除：导入/自动检测/JSON 回填/
// 抽取值回写四个 action 均无 UI 调用方，随主进程通道一并整链移除。）
//
// 多供应商库上线后，连接字段（供应商/key/url）的真源是 provider-store（主进程 ProviderProfile）；
// 本 store 仍承载行为/外观字段与 advancedJson（全局 Claude 设置）的编辑与自动保存。
// hb12-CFG-09：updatingFromJson 死标志（原历史防循环标志，无读取点）已全链删除；
// 自动保存的防回写循环由 ConfigPage 的 configSnapshot 快照比对承担。

import { defineStore } from 'pinia';
import { ref } from 'vue';

// ModelAlias 类型定义在 shared/types/config（供 shared 层 AppConfig 与渲染层共用）。
import type { ModelAlias } from '../../shared/types/config';
export type { ModelAlias };
import type { AppConfig } from '../../shared/types/config';
import type { CliDetectionResult } from '../../shared/types/cli';
import { DEFAULT_THEME_PALETTE_ID, DEFAULT_FONT_SCALE } from '../../shared/constants';
import { DEFAULT_TASK_DELAY_MINUTES } from '../../shared/queue-config';

// H1（F5 重做）：设置保存失败跨卸载可感知标志。ConfigPage 组件局部 saveStatus 在页面卸载后
// 无渲染、其 watch 随 setup 停止——失败对用户不可见，且重进页被 loadConfig 用主进程旧值
// 回滚。此模块级 ref 与组件生命周期解耦：saveConfig 失败置 true、成功清 false；App.vue 全局
// watch 在 false→true 边沿弹一次 toast，ConfigPage performInit 开头据它用内存值重存一次。
export const lastSaveFailed = ref(false);

// P2-2 漂移补偿定时器（模块级，与组件生命周期解耦）：保存响应落地时内存已被在飞编辑，
// 则不覆写并排一次 700ms 防抖补偿重存；多条防抖合一，持续编辑期间不产生保存风暴。
let driftResaveTimer: ReturnType<typeof setTimeout> | null = null;

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
  // 全局 skill 禁用开关默认全启用（{} = 无禁用项；与主进程 config-manager 默认保持同值）。
  skillOverrides: {},
};

export const useConfigStore = defineStore('config', {
  state: () => ({
    config: { ...defaultConfig } as AppConfig,
    cliStatus: null as CliDetectionResult | null,
    loadingConfig: false,
    savingConfig: false,
    detectingCli: false,
    error: null as string | null,
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
    async saveConfig(): Promise<{ saved: boolean }> {
      // hb10-CFG-08：真互斥——在途保存未落定时重入不丢弃锁，改为返回 {saved:false} 信号
      // （P2-1：调用方据信号重排补存，不再被静默吞掉；锁本身不回退，防双写竞态复活）。
      if (this.savingConfig) return { saved: false };
      this.savingConfig = true;
      this.error = null;
      // P2-2 漂移补偿：漂移分支排 700ms 防抖补偿重存（拨回开场景 watch 已短路、页面不会再排，
      // 必须由 store 自补）；补偿又撞在飞被跳过时按同节奏重排，直至真实落定。
      const scheduleDriftResave = () => {
        if (driftResaveTimer) return;
        driftResaveTimer = setTimeout(() => {
          driftResaveTimer = null;
          void this.saveConfig()
            .then((r) => { if (!r.saved) scheduleDriftResave(); })
            .catch(() => undefined); // 补偿失败已经由 saveConfig 内部置 lastSaveFailed（toast 可见）
        }, 700);
      };
      try {
        // this.config 是 Pinia/Vue 的 reactive proxy，无法被 Electron IPC 结构化克隆，
        // 直接传输会抛 "An object could not be cloned."，保存失败、配置无法持久化。
        // 必须先深拷贝成纯普通对象再过 IPC。
        const plainConfig: AppConfig = JSON.parse(JSON.stringify(this.config));
        // P2-2：发送时快照串。响应回来后与现内存比对——在飞期间的用户编辑不得被回传覆写。
        const sentStr = JSON.stringify(plainConfig);
        const resp = await window.claudeLink.saveConfig(plainConfig);
        // H1：保存成功清失败标志（App.vue 的 toast 只在 false→true 边沿弹，不重复打扰）。
        lastSaveFailed.value = false;
        // 主进程 saveConfig 末尾已把配置投影写入 <工作目录>/.claude/settings.local.json。
        // 刷新诊断使其反映最新的 effective settings（advancedJson/permissionMode/模型等变化后
        // 若只依赖 workingDirectory watcher，页面会继续展示保存前的过期 effectiveKeys/来源）。
        // 复用 loadNativeSettingsDiagnostic 的请求代际校验，避免与目录切换的刷新互相覆盖。
        if (this.config.workingDirectory) {
          await this.loadNativeSettingsDiagnostic(this.config.workingDirectory);
        }
        // P2-2：漂移判定放在锁窗口尾（诊断 await 期间产生的编辑同属在飞编辑）。
        // 无漂移 → 采纳主进程清洗派生态（掩码/投影权威值），并做 hb10-CFG-09 notice 比对；
        // 有漂移 → 不覆写内存（保留用户编辑），排一次补偿重存把最新内存落盘。
        const nowStr = JSON.stringify(JSON.parse(JSON.stringify(this.config)));
        if (nowStr === sentStr) {
          this.config = resp;
          // hb10-CFG-09：主进程拒收非法 workingDirectory（不存在/非目录）时按旧值保存——回传与
          // 所送不一致即给 notice（保存成功非硬失败；不比对 null/空串：清空目录是合法操作）。
          if (
            plainConfig.workingDirectory &&
            plainConfig.workingDirectory !== this.config.workingDirectory
          ) {
            this.error = `工作目录「${plainConfig.workingDirectory}」不存在或不是目录，已保留原值`;
          }
        } else {
          scheduleDriftResave();
        }
        return { saved: true };
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
  },
});
