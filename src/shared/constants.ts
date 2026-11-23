export { IPC_CHANNELS } from './types/ipc';

export const DEFAULT_THEME_PALETTE_ID = 'inkstone';
export const DEFAULT_FONT_SCALE = 'medium';
export const FONT_SCALE_SIZES: Record<string, string> = {
  small: '14px',
  medium: '16px',
  large: '18px',
};
/** 无引用残留（零 import，删除安全）：流式上屏节流间隔真相源在 renderer/composables/use-stream.ts
 *  的 INTERVAL=50 硬编码（hb12-CHR-01 节流，非防抖），改本常量无效。同款死常量另见
 *  src/shared/types/ipc.ts 同名导出，清理时两处一并删除。 */
export const STREAM_DEBOUNCE_MS = 50;
export const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

// 主窗口尺寸（主进程 createWindow 与 window-state 持久化共用，单一真相源）
export const WINDOW_DEFAULT_WIDTH = 1200;
export const WINDOW_DEFAULT_HEIGHT = 800;
export const WINDOW_MIN_WIDTH = 900;
export const WINDOW_MIN_HEIGHT = 640;

export interface ThemePalette {
  id: string;
  name: string;
  isDark: boolean;
  colors: {
    bg: string;
    panel: string;
    panelSoft: string;
    border: string;
    /** 可选：大区分隔线（--color-border-strong）。缺省回退 'rgba(0, 0, 0, 0.12)'（= variables.css 原静态值，11 套旧板观感不变）。 */
    borderStrong?: string;
    text: string;
    textMuted: string;
    /** 可选：弱注小字（--color-text-sub，小字须 ≥4.5:1）。缺省回退 textMuted。 */
    textSub?: string;
    accent: string;
    accentStrong: string;
    onAccent: string;
    /** 可选：主按钮底（--color-btn-ink，00-review-summary K3）。缺省回退 accent（11 套旧板观感=现状）。 */
    btnInk?: string;
    /** 可选：主按钮字/图标（--color-on-btn-ink）。缺省回退 onAccent。 */
    onBtnInk?: string;
    danger: string;
  };
}

// Theme palettes vendored from openhanako (liliMozi/openhanako) real source CSS:
// desktop/src/themes/*.css + desktop/src/shared/theme-registry-data.json
// 全部 9 套为浅色主题，色值原样搬运，映射关系：
// bg→--color-bg, panel→--color-panel, panelSoft→--color-panel-soft, border→--color-border,
// accent→--color-accent, accentStrong→--color-accent-strong, onAccent→按 accent 亮度选 #FFFFFF/#1A1A1A.
// borderStrong 12 板全量显式定值（2026-11-19 P1），缺省回退仅作未来新板的防御。
export const THEME_PALETTES: ThemePalette[] = [
  {
    // 方案C「墨石 Slate」（UI 补全 A1，2026-11-07 裁决）：第 12 套、应用默认、居数组首位
    // （export-image-manager.ts:932 未知 id 兜底取 THEME_PALETTES[0]，首位=默认保证兜底一致）。
    // 色值来源：v8.1 任务书【二】墨石 token 速查 + 10-behavior-specs.md A1。
    id: 'inkstone',
    name: '墨石',
    isDark: false,
    colors: {
      bg: '#EFF1F4',
      panel: '#F6F7F9',
      panelSoft: '#FFFFFF',
      border: '#E4E7EC',
      borderStrong: '#D5DAE1',
      text: '#17181A',
      textMuted: '#667085',
      textSub: '#5B6779', // 对 bg #EFF1F4 ≈5.0:1，过 AA 小字
      accent: '#EA580C',
      accentStrong: '#C2410C', // accent 文字用（白底 ≈5.2:1 过 AA），任务书【二】
      onAccent: '#FFFFFF', // 白 on #EA580C ≈3.58:1（AA 大字号）；主按钮走 btnInk 不走 accent 实底
      btnInk: '#17181A', // A2：主按钮近黑底（K3 裁决）
      onBtnInk: '#FFFFFF', // A2：白 on #17181A ≈17.8:1 AAA
      danger: '#DC2626',
    },
  },
  {
    id: 'warm-paper',
    name: '暖纸',
    isDark: false,
    colors: {
      bg: '#F8F4ED',
      panel: '#F4F0EA',
      panelSoft: '#FCFAF5',
      border: 'rgba(122,96,88,0.18)',
      borderStrong: '#D9D0C6',
      text: '#3B3D3F',
      textMuted: '#6A6C70',
      accent: '#537D96',
      accentStrong: '#456A80',
      onAccent: '#FFFFFF',
      danger: '#8B3A3A',
    },
  },
  {
    id: 'grass-aroma',
    name: '草香',
    isDark: false,
    colors: {
      bg: '#F5F8F3',
      panel: '#EFF3EC',
      panelSoft: '#F9FBF7',
      border: 'rgba(91,168,140,0.22)',
      borderStrong: '#CFDAD1',
      text: '#2E3832',
      textMuted: '#68706D',
      accent: '#5BA88C',
      accentStrong: '#4D9179',
      onAccent: '#1A1A1A',
      danger: '#8B4A3A',
    },
  },
  {
    id: 'coral',
    name: '珊瑚',
    isDark: false,
    colors: {
      bg: '#FDF6EC',
      panel: '#FCF1E4',
      panelSoft: '#FFFBF3',
      border: 'rgba(243,126,99,0.18)',
      borderStrong: '#E0CFC3',
      text: '#1A3049',
      textMuted: '#646F78',
      accent: '#1A3049',
      accentStrong: '#243A55',
      onAccent: '#FFFFFF',
      danger: '#A3483B',
    },
  },
  {
    id: 'contemplation',
    name: '沉思',
    isDark: false,
    colors: {
      bg: '#F3F5F7',
      panel: '#ECEFF2',
      panelSoft: '#F8F9FB',
      border: 'rgba(126,153,168,0.22)',
      borderStrong: '#CBD1D8',
      text: '#2C3238',
      textMuted: '#676E75',
      accent: '#7E99A8',
      accentStrong: '#6B8594',
      onAccent: '#1A1A1A',
      danger: '#8B4040',
    },
  },
  {
    id: 'absolutely',
    name: '绝对',
    isDark: false,
    colors: {
      bg: '#F4F3EE',
      panel: '#EDEAE2',
      panelSoft: '#FAF9F5',
      border: 'rgba(177,173,161,0.28)',
      borderStrong: '#CFCBC2',
      text: '#2D2B28',
      textMuted: '#6E6B68',
      accent: '#B5846E',
      accentStrong: '#A27460',
      onAccent: '#1A1A1A',
      danger: '#8B3A3A',
    },
  },
  {
    id: 'high-contrast',
    name: '素白',
    isDark: false,
    colors: {
      bg: '#FAF8F7',
      panel: '#F3F1F0',
      panelSoft: '#FDFBFA',
      border: 'rgba(92,75,70,0.22)',
      borderStrong: '#D6D0CD',
      text: '#1A1C1E',
      textMuted: '#6B6F73',
      accent: '#3A6B85',
      accentStrong: '#2E5870',
      onAccent: '#FFFFFF',
      danger: '#7A3030',
    },
  },
  {
    id: 'deep-think',
    name: '深思',
    isDark: false,
    colors: {
      bg: '#FCFCFD',
      panel: '#F0F0F2',
      panelSoft: '#F8F8FA',
      border: 'rgba(0,0,0,0.09)',
      borderStrong: '#D3D3DB',
      text: '#1D1D1F',
      textMuted: '#717176',
      accent: '#636AE8',
      accentStrong: '#5158D4',
      onAccent: '#FFFFFF',
      danger: '#8B3A3A',
    },
  },
  {
    id: 'delve',
    name: '纯白',
    isDark: false,
    colors: {
      bg: '#FFFFFF',
      panel: '#F0F0F0',
      panelSoft: '#F7F7F8',
      border: 'rgba(0,0,0,0.10)',
      borderStrong: '#D6D6D6',
      text: '#1A1A1A',
      textMuted: '#727272',
      accent: '#1A1A1A',
      accentStrong: '#000000',
      onAccent: '#FFFFFF',
      danger: '#8B3A3A',
    },
  },
  {
    id: 'new-warm-paper',
    name: '新暖纸',
    isDark: false,
    colors: {
      bg: '#F5EFE4',
      panel: '#EFE8DB',
      panelSoft: '#FBF7EE',
      border: '#D8CFBE',
      borderStrong: '#C8C0B2',
      text: '#2A2622',
      textMuted: '#6B6158',
      accent: '#537D96',
      accentStrong: '#3F6179',
      onAccent: '#FFFFFF',
      danger: '#8B2C1F',
    },
  },
  {
    // 侧栏 Quiet Console 重设计（2026-09-27）新增：冷灰浅色「静默」——近黑墨色作 accent，
    // 主按钮/活动态呈墨色而非彩色的 A 方案语言。
    id: 'quiet-console',
    name: '静默',
    isDark: false,
    colors: {
      bg: '#F6F7F8',
      panel: '#FFFFFF',
      panelSoft: '#FAFBFC',
      border: 'rgba(0,0,0,0.09)',
      borderStrong: '#D7D9DC',
      text: '#1A1D21',
      textMuted: '#6B7280', // 对 #FFFFFF 4.8:1 过 AA
      accent: '#1A1D21', // 近黑主色（A 设计：主按钮/活动态为墨色）
      accentStrong: '#000000',
      onAccent: '#FFFFFF',
      danger: '#DC2626',
    },
  },
  {
    // 同批新增：深色终端「终端」——isDark: true 驱动 apply-theme 的 colorScheme='dark'
    // （深色滚动条/原生控件自动跟随）；亮蓝 accent 用深色文字（中亮度 onAccent 规则）。
    id: 'terminal-pro',
    name: '终端',
    isDark: true,
    colors: {
      bg: '#0F1115',
      panel: '#14171C',
      panelSoft: '#1B2027',
      border: '#30363D',
      borderStrong: '#3D444D',
      text: '#D3D8E0',
      textMuted: '#9AA3B2', // 对 #14171C ≈7:1
      accent: '#4EA1FF',
      accentStrong: '#7FBAFF',
      onAccent: '#0B1220', // 亮蓝 accent 用深色文字（中亮度规则）
      danger: '#E5484D',
    },
  },
];

/** OPT-10：引擎后台请求六开关单一常量（env 变量名 ← AppConfig 布尔字段名）。
 *  cli-shared.buildSpawnEnv（进程 env 通道）与 sdk-backend.buildClaudeLinkSettingsBlock
 *  （settings.env 通道）共用同一份映射，防两份手写列表漂移。 */
export const ENGINE_BACKGROUND_TOGGLE_ENV: ReadonlyArray<readonly [string, string]> = [
  ['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'disableAutoMemory'],
  ['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'disableBackgroundTasks'],
  ['CLAUDE_CODE_DISABLE_CRON', 'disableCron'],
  ['CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY', 'disableFeedbackSurvey'],
  ['DISABLE_TELEMETRY', 'disableTelemetry'],
  ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'disableNonessentialTraffic'],
] as const;
