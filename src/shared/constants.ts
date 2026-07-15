export { IPC_CHANNELS } from './types/ipc';

export const DEFAULT_TASK_DELAY_SECONDS = 60;
export const DEFAULT_THEME_PALETTE_ID = 'default-dark';
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
    danger: string;
  };
}

// Theme palettes are curated for this app with tones inspired by openhanako:
// https://github.com/liliMozi/openhanako
// If exact upstream palette files are later vendored, keep this list in sync with that source.
export const THEME_PALETTES: ThemePalette[] = [
  {
    id: 'default-dark',
    name: '分层控制台',
    isDark: true,
    colors: {
      bg: '#0b0e14',
      panel: '#141925',
      panelSoft: '#1c2333',
      border: 'rgba(255,255,255,0.08)',
      text: '#e8edf6',
      textMuted: '#8a94a6',
      accent: '#3ddc84',
      accentStrong: '#5fe89b',
      danger: '#f0616e',
    },
  },
  {
    id: 'midnight',
    name: '午夜',
    isDark: true,
    colors: {
      bg: '#3B4A54',
      panel: '#445560',
      panelSoft: '#4D5E6A',
      border: 'rgba(170,121,141,0.16)',
      text: '#E1EAF0',
      textMuted: '#CCDAE4',
      accent: '#C99AAF',
      accentStrong: '#E6B1C4',
      danger: '#C77070',
    },
  },
  {
    id: 'midnight-contrast',
    name: '午夜高对比',
    isDark: true,
    colors: {
      bg: '#26343D',
      panel: '#30414B',
      panelSoft: '#3C4F5B',
      border: 'rgba(230,177,196,0.26)',
      text: '#F0F6FA',
      textMuted: '#B7C8D3',
      accent: '#E6B1C4',
      accentStrong: '#F0C4D3',
      danger: '#E28B8B',
    },
  },
  {
    id: 'deep-think',
    name: '深思',
    isDark: true,
    colors: {
      bg: '#1a1c2e',
      panel: '#222640',
      panelSoft: '#2a2e4a',
      border: 'rgba(99,106,232,0.20)',
      text: '#e8ecf8',
      textMuted: '#95959c',
      accent: '#636AE8',
      accentStrong: '#8B92F5',
      danger: '#ef6461',
    },
  },
  {
    id: 'grass-aroma',
    name: '草香',
    isDark: true,
    colors: {
      bg: '#1e2a22',
      panel: '#2a3832',
      panelSoft: '#34423a',
      border: 'rgba(91,168,140,0.20)',
      text: '#e8f0ea',
      textMuted: '#8a9e92',
      accent: '#5BA88C',
      accentStrong: '#6FC0A0',
      danger: '#d4716f',
    },
  },
  {
    id: 'warm-paper',
    name: '暖纸',
    isDark: true,
    colors: {
      bg: '#2a2622',
      panel: '#363230',
      panelSoft: '#403c38',
      border: 'rgba(83,125,150,0.20)',
      text: '#f0ece4',
      textMuted: '#a09888',
      accent: '#537D96',
      accentStrong: '#6B98B0',
      danger: '#c74040',
    },
  },
  {
    id: 'hanako',
    name: '花子',
    isDark: true,
    colors: {
      bg: '#1a2830',
      panel: '#243440',
      panelSoft: '#2c3c48',
      border: 'rgba(83,125,150,0.22)',
      text: '#e0ecf0',
      textMuted: '#8aa0b0',
      accent: '#537D96',
      accentStrong: '#6B98B0',
      danger: '#c74040',
    },
  },
  {
    id: 'butter',
    name: '黄油',
    isDark: true,
    colors: {
      bg: '#1e2620',
      panel: '#283430',
      panelSoft: '#2e3c36',
      border: 'rgba(91,168,140,0.18)',
      text: '#e4f0e8',
      textMuted: '#8a9e90',
      accent: '#5BA88C',
      accentStrong: '#70C0A2',
      danger: '#c77070',
    },
  },
  {
    id: 'ming',
    name: '明',
    isDark: true,
    colors: {
      bg: '#1e2630',
      panel: '#283640',
      panelSoft: '#2e4048',
      border: 'rgba(139,164,180,0.18)',
      text: '#e0e8f0',
      textMuted: '#8a9aa4',
      accent: '#8BA4B4',
      accentStrong: '#A0B8C8',
      danger: '#c77070',
    },
  },
  {
    id: 'absolutely',
    name: '绝对',
    isDark: true,
    colors: {
      bg: '#2a2822',
      panel: '#363430',
      panelSoft: '#403c36',
      border: 'rgba(181,132,110,0.20)',
      text: '#f0ece4',
      textMuted: '#9a9488',
      accent: '#B5846E',
      accentStrong: '#D0A088',
      danger: '#c74040',
    },
  },
  {
    id: 'contemplation',
    name: '沉思',
    isDark: true,
    colors: {
      bg: '#1e2830',
      panel: '#283440',
      panelSoft: '#2e3c48',
      border: 'rgba(126,153,168,0.22)',
      text: '#e0e8f0',
      textMuted: '#8a9aa0',
      accent: '#7E99A8',
      accentStrong: '#98B4C0',
      danger: '#c77070',
    },
  },
];

export interface SlashCommand {
  name: string;
  description: string;
  example?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/init', description: '初始化项目配置（生成 CLAUDE.md）' },
  { name: '/cost', description: '显示当前会话的累计费用与 Token 用量' },
  { name: '/compact', description: '压缩对话上下文，释放 Token 占用' },
  { name: '/clear', description: '清空当前对话历史' },
  { name: '/resume', description: '恢复/切换到指定历史会话' },
  { name: '/model', description: '查看或切换当前使用的模型' },
  { name: '/help', description: '显示可用命令与帮助信息' },
  { name: '/config', description: '打开配置界面' },
  { name: '/doctor', description: '检查 Claude Code CLI 健康状态' },
  { name: '/status', description: '显示当前会话与账号状态' },
  { name: '/review', description: '审查代码变更' },
];
