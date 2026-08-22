import type { RenderableMessage } from './export-image';
import type { ThinkingLevel } from './thinking';

export interface Session {
  id: string;
  name: string;
  cliSessionId: string | null;
  model: string;
  // 会话级供应商选用（ProviderProfile.id）；null = 用全局「最近使用」记忆。
  providerOverride: string | null;
  // 会话当前实际模型 ID（如 glm-4.6）。字段名保留 modelOverride（列已存在），
  // 但取值域已从 sonnet/haiku/opus/fable 别名改为实际模型 ID——别名只作 CC 内部兼容层。
  modelOverride: string | null;
  workingDir: string | null;
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  maxTurns: number;
  // 该会话的思考强度档位。null = 回落全局默认（AppConfig.defaultThinkingLevel）。
  // 'auto' 与 null 同义（UI 用 'auto' 显式表达「跟随默认」，注入层统一按回落处理）。
  thinkingLevel: ThinkingLevel | null;
  createdAt: string;
  updatedAt: string;
  lastContextTokens: number | null;
  lastContextUpdatedAt: string | null;
  // 该会话从 SDK result.modelUsage.contextWindow 拿到的真实上下文窗口（持久化）。
  // 切换会话重建 contextStats 时优先用它，避免回落到 200k 兜底。null 表示尚未连通过。
  lastContextWindow: number | null;
  // post-turn 官方 /context 探针持久化的回合末精确占用（used/capacity/采样时间戳）。
  // 重启/切回会话时预填 stale（诚实标注非实时），不冒充 fresh；与 lastContextTokens
  // （历史累计 turn usage）语义不同，此处是「当前窗口已用」的 last-known。
  lastContextUsed: number | null;
  lastContextUsedCapacity: number | null;
  lastContextUsedAt: number | null;
}

export interface Message extends RenderableMessage {
  // 数据库专用字段（导出图片渲染不需要，不进 RenderableMessage）：
  // 原始 CLI/SDK 事件 JSON（审计用，体积大）。
  rawEvent: string | null;
  // 任务队列发起的消息所属 taskId（任务执行链路用）。
  parentTaskId: string | null;
}
