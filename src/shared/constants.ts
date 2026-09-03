export { IPC_CHANNELS } from './types/ipc';

export const DEFAULT_THEME_PALETTE_ID = 'warm-paper';
export const DEFAULT_FONT_SCALE = 'medium';
export const FONT_SCALE_SIZES: Record<string, string> = {
  small: '14px',
  medium: '16px',
  large: '18px',
};
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
];
