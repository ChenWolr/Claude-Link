export { IPC_CHANNELS } from './types/ipc';

export const DEFAULT_THEME_PALETTE_ID = 'warm-paper';
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
    text: string;
    textMuted: string;
    accent: string;
    accentStrong: string;
    onAccent: string;
    danger: string;
  };
}

// Theme palettes vendored from openhanako (liliMozi/openhanako) real source CSS:
// desktop/src/themes/*.css + desktop/src/shared/theme-registry-data.json
// 全部 9 套为浅色主题，色值原样搬运，映射关系：
// bg→--color-bg, panel→--color-panel, panelSoft→--color-panel-soft, border→--color-border,
// accent→--color-accent, accentStrong→--color-accent-strong, onAccent→按 accent 亮度选 #FFFFFF/#1A1A1A.
export const THEME_PALETTES: ThemePalette[] = [
  {
    id: 'warm-paper',
    name: '暖纸',
    isDark: false,
    colors: {
      bg: '#F8F4ED',
      panel: '#F4F0EA',
      panelSoft: '#FCFAF5',
      border: 'rgba(122,96,88,0.18)',
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
      border: '#23272F',
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
