export { IPC_CHANNELS } from './types/ipc';

export const DEFAULT_TASK_DELAY_SECONDS = 60;
export const STREAM_DEBOUNCE_MS = 50;
export const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

export interface SlashCommand {
  name: string;
  description: string;
  example?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/init', description: '初始化项目配置' },
  { name: '/cost', description: '显示当前会话费用' },
  { name: '/compact', description: '压缩对话上下文' },
  { name: '/clear', description: '显示对话历史' },
  { name: '/help', description: '显示帮助信息' },
  { name: '/config', description: '打开配置' },
  { name: '/doctor', description: '检查 CLI 健康状态' },
  { name: '/status', description: '显示当前状态' },
  { name: '/review', description: '审查代码变更' },
];
