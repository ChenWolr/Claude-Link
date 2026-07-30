// cli-shared.ts
// 公共工具函数：env 构造 / stream-json 解析 / 落库。
// 被 sdk-backend.ts（默认后端）和 connection-tester.ts 复用。
//
// 这是从 process-manager.ts 提取的纯工具函数。process-manager.ts 的 spawn 入口
// 已删除（SDK 路径完全取代），但工具函数被 SDK 路径复用，故独立到此模块。

import type { CliInitEvent, CliSystemInitEvent, CliSystemInfoEvent, CliPermissionEvent, CliResultEvent, CliEvent, CliMessageEvent, CliMessageContentPart } from '../../shared/types/cli';
import type { ThinkingLevel } from '../../shared/types/thinking';
import { getConfig } from './config-manager';
import { resolveThinkingConfig } from '../../shared/thinking-resolver';
import { logger } from '../utils/logger';
import * as messageRepo from '../database/repositories/message-repo';
import * as sessionRepo from '../database/repositories/session-repo';
import { processKindFromPart, extractSubAgentTitle } from '../../shared/process-kind';
import { isDisplayableSystemInfo } from '../../shared/system-info';
import { resolveContextWindowForSession } from '../../shared/model-context-windows';

export interface SpawnOptions {
  model?: string;
  modelOverride?: string | null;
  workingDir?: string | null;
  maxTurns?: number;
  permissionMode?: string;
  resumeSessionId?: string | null;
  /** 当前会话附件根目录等受控路径；合并进 SDK options.additionalDirectories，不覆盖 cwd。 */
  additionalDirectories?: string[];
  /** 每会话思考强度覆盖；null/未设=回落全局默认（config.defaultThinkingLevel）。 */
  thinkingLevel?: ThinkingLevel | null;
}

// 构造注入子进程/SDK 的 env：apiKey + baseUrl + advancedJson.env 块展开。
// spawn 路径和 SDK 路径都复用此函数，确保第三方端点配置一致。
export function buildSpawnEnv(): Record<string, string> {
  const config = getConfig();
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  if (config.apiKey) {
    env.ANTHROPIC_API_KEY = config.apiKey;
  }

  const baseUrl = config.apiBaseUrl?.trim();
  if (baseUrl && baseUrl !== 'https://api.anthropic.com') {
    env.ANTHROPIC_BASE_URL = baseUrl;
  }

  if (config.advancedJson && config.advancedJson !== '{}') {
    try {
      const advanced = JSON.parse(config.advancedJson) as Record<string, unknown>;
      for (const [key, value] of Object.entries(advanced)) {
        if (typeof value === 'string') {
          env[key] = value;
        }
      }
      const envBlock = advanced.env;
      if (envBlock && typeof envBlock === 'object' && !Array.isArray(envBlock)) {
        for (const [key, value] of Object.entries(envBlock as Record<string, unknown>)) {
          if (typeof value === 'string') {
            env[key] = value;
          }
        }
      }
    } catch {
      logger.warn('Failed to parse advancedJson for env injection');
    }
  }

  // 全局默认思考强度 env 冗余注入（best-effort）：SDK 路径的可靠通道是 inline options.settings +
  // options.effort（buildSdkOptions 内），此处 env 仅服务保留兼容的 spawn CLI fallback，且可能被
  // ~/.claude/settings.json 的 env 块覆盖。medium 不注入以尊重用户配置。effort 值严格匹配 EffortLevel 枚举。
  const level = config.defaultThinkingLevel;
  if (level !== 'medium') {
    const result = resolveThinkingConfig(level);
    if (result.effort) {
      env.CLAUDE_EFFORT = result.effort;
    }
  }

  return env;
}

// 把 CliEvent 持久化到 DB（init 取 session_id；system 子类型分流落库；message 落各 part；result 兜底）。
export function persistCliEvent(sessionId: string, event: CliEvent): void {
  switch (event.type) {
    case 'init': {
      const initEvent = event as CliInitEvent;
      sessionRepo.updateCliSessionId(sessionId, initEvent.session_id);
      break;
    }

    case 'system': {
      const sysEvent = event as CliSystemInitEvent | CliSystemInfoEvent | CliPermissionEvent;
      if (sysEvent.subtype === 'init') {
        if (sysEvent.session_id) {
          sessionRepo.updateCliSessionId(sessionId, sysEvent.session_id);
        }
        break;
      }
      if (sysEvent.subtype === 'permission_denied' || sysEvent.subtype === 'permission_request') {
        const p = event as CliPermissionEvent;
        const toolName = p.tool_name ? `：${p.tool_name}` : '';
        messageRepo.createMessage({
          sessionId,
          role: 'system',
          content: p.message || (p.subtype === 'permission_request' ? `等待权限确认${toolName}` : `权限被拒绝${toolName}`),
          eventType: 'system',
          processKind: 'permission',
          toolUseId: p.tool_use_id ?? null,
        });
        break;
      }
      const info = event as CliSystemInfoEvent;
      // 问题 5：空文本 informational 不落库（每回合噪音「ℹ️ 系统提示」）。
      if (!isDisplayableSystemInfo(info.subtype, info.text)) break;
      const defaultText: Record<string, string> = {
        informational: '系统提示',
        compact_boundary: '上下文已达压缩边界',
        plugin_install: '插件安装',
        interaction_response: '用户已完成交互选择',
      };
      messageRepo.createMessage({
        sessionId,
        role: 'system',
        content: info.text || defaultText[info.subtype] || '系统提示',
        eventType: 'system',
        processKind: `system:${info.subtype}`,
      });
      break;
    }

    case 'message': {
      const msgEvent = event as CliMessageEvent;
      persistMessageParts(
        sessionId,
        msgEvent.content,
        msgEvent.role,
        msgEvent.parentToolUseId ?? null,
      );
      break;
    }

    case 'stream_event':
      break;

    case 'result': {
      const r = event as CliResultEvent;
      const text = r.result?.trim();
      if (!text) break;
      const subtype = r.subtype;
      const isUserInterrupt = subtype === 'error_during_execution';
      const isErrResult = !!r.is_error && !isUserInterrupt && subtype !== 'success' && subtype !== undefined;
      if (isErrResult) break;
      if (currentTurnHasMainFlowText(sessionId)) break;
      messageRepo.createMessage({
        sessionId, role: 'assistant', content: r.result, eventType: 'message', processKind: null,
      });
      break;
    }
  }
}

function currentTurnHasMainFlowText(sessionId: string): boolean {
  const rows = messageRepo.getMessagesBySession(sessionId);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const m = rows[i];
    if (m.role === 'user') break;
    if (m.role === 'assistant' && m.eventType === 'message' && !m.parentAgentId) return true;
  }
  return false;
}

export function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item && typeof item === 'object' && 'text' in item && typeof (item as { text?: unknown }).text === 'string') {
          return (item as { text: string }).text;
        }
        return JSON.stringify(item, null, 2);
      })
      .join('\n');
  }
  if (content === undefined || content === null) return '';
  return JSON.stringify(content, null, 2);
}

export function persistMessageParts(
  sessionId: string,
  parts: CliMessageContentPart[],
  role: 'user' | 'assistant',
  parentAgentId: string | null = null,
): void {
  for (const part of parts) {
    const processKind = processKindFromPart(part);
    if (part.type === 'text' && 'text' in part) {
      messageRepo.createMessage({
        sessionId, role, content: part.text, eventType: 'message',
        processKind, parentAgentId,
      });
    } else if (part.type === 'tool_use') {
      messageRepo.createMessage({
        sessionId,
        role: 'assistant',
        content: JSON.stringify({ name: part.name, input: part.input }, null, 2),
        eventType: 'tool_use',
        processKind,
        parentAgentId,
        // 问题 6：Anthropic ToolUseBlock 主键是 id（非 tool_use_id）；优先取 id，否则 tool_use_id 兜底。
        toolUseId: part.id ?? part.tool_use_id ?? null,
        title: extractSubAgentTitle(part),
      });
    } else if (part.type === 'server_tool_use') {
      messageRepo.createMessage({
        sessionId,
        role: 'assistant',
        content: JSON.stringify({ name: part.name, input: part.input }, null, 2),
        eventType: 'tool_use',
        processKind,
        parentAgentId,
        // 问题 6：标准 server_tool_use 主键是 id；兼容少数代理端点用 tool_use_id。
        toolUseId: part.id ?? part.tool_use_id ?? null,
      });
    } else if (part.type === 'tool_result') {
      const resultText = normalizeToolResultContent((part as { content?: unknown }).content);
      messageRepo.createMessage({
        sessionId, role: 'tool', content: resultText, eventType: 'tool_result',
        processKind, parentAgentId, toolUseId: part.tool_use_id ?? null,
        isError: part.is_error === true,
      });
    } else if (
      part.type === 'web_search_tool_result' ||
      part.type === 'web_fetch_tool_result' ||
      part.type === 'code_execution_tool_result'
    ) {
      const resultText = normalizeToolResultContent((part as { content?: unknown }).content);
      messageRepo.createMessage({
        sessionId, role: 'tool', content: resultText, eventType: 'tool_result',
        processKind, parentAgentId, toolUseId: part.tool_use_id ?? null,
      });
    } else if (part.type === 'mcp_tool_use') {
      // L6：MCP 工具调用（name 形如 mcp__<server>__<tool>）。与 tool_use 同形落库。
      messageRepo.createMessage({
        sessionId,
        role: 'assistant',
        content: JSON.stringify({ name: part.name, input: part.input }, null, 2),
        eventType: 'tool_use',
        processKind,
        parentAgentId,
        // 问题 6：与 tool_use 同理，主键取 id（兼容 tool_use_id）。
        toolUseId: part.id ?? part.tool_use_id ?? null,
        title: extractSubAgentTitle(part),
      });
    } else if (part.type === 'mcp_tool_result') {
      // L6：MCP 工具结果。与 tool_result 同形落库（含 is_error）。
      const resultText = normalizeToolResultContent((part as { content?: unknown }).content);
      messageRepo.createMessage({
        sessionId, role: 'tool', content: resultText, eventType: 'tool_result',
        processKind, parentAgentId, toolUseId: part.tool_use_id ?? null,
        isError: part.is_error === true,
      });
    } else if (part.type === 'thinking' && 'thinking' in part) {
      messageRepo.createMessage({
        sessionId, role: 'assistant', content: part.thinking, eventType: 'thinking',
        processKind, parentAgentId,
      });
    } else if (part.type === 'redacted_thinking') {
      messageRepo.createMessage({
        sessionId, role: 'assistant', content: '（此段思考已被安全策略隐藏）',
        eventType: 'thinking', processKind, parentAgentId,
      });
    } else {
      // 兜底：未识别的 content block 类型不静默丢弃，记日志便于发现协议新形态
      // （当前不会出现；若未来 CC 新增 block 类型，这里留痕而非无声吞掉）。
      logger.warn(`[persistMessageParts] 未识别的 content block 类型，已跳过：${(part as { type: string }).type}`);
    }
  }
}

// 与 sdk-backend.readContextWindow 同逻辑：按别名/真实模型名查用户设的覆盖，否则 200k。
// 本函数当前无调用者（process-manager spawn 路径已移除），保留 export 供未来 spawn CLI 路径复用。
export function readContextWindow(aliasOrModel?: string | null): number {
  try {
    const config = getConfig();
    return resolveContextWindowForSession({
      aliasOrModel: aliasOrModel ?? null,
      advancedJson: config.advancedJson,
      contextWindowByAlias: config.contextWindowByAlias,
    });
  } catch {
    // ignore
  }
  return 200000;
}
