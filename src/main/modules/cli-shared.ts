// cli-shared.ts
// 公共工具函数：env 构造 / stream-json 解析 / 落库。
// 被 sdk-backend.ts（默认后端）和 connection-tester.ts 复用。
//
// 这是从 process-manager.ts 提取的纯工具函数。process-manager.ts 的 spawn 入口
// 已删除（SDK 路径完全取代），但工具函数被 SDK 路径复用，故独立到此模块。

import type { CliInitEvent, CliSystemInitEvent, CliSystemInfoEvent, CliPermissionEvent, CliResultEvent, CliEvent, CliMessageEvent, CliMessageContentPart } from '../../shared/types/cli';
import { getConfig } from './config-manager';
import { logger } from '../utils/logger';
import * as messageRepo from '../database/repositories/message-repo';
import * as sessionRepo from '../database/repositories/session-repo';
import { processKindFromPart, extractSubAgentTitle } from '../../shared/process-kind';

export interface SpawnOptions {
  model?: string;
  modelOverride?: string | null;
  workingDir?: string | null;
  maxTurns?: number;
  permissionMode?: string;
  resumeSessionId?: string | null;
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
        toolUseId: part.tool_use_id ?? null,
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
        toolUseId: part.id ?? null,
      });
    } else if (part.type === 'tool_result') {
      const resultText = normalizeToolResultContent((part as { content?: unknown }).content);
      messageRepo.createMessage({
        sessionId, role: 'tool', content: resultText, eventType: 'tool_result',
        processKind, parentAgentId, toolUseId: part.tool_use_id ?? null,
      });
    } else if (part.type === 'web_search_tool_result' || part.type === 'web_fetch_tool_result') {
      const resultText = normalizeToolResultContent((part as { content?: unknown }).content);
      messageRepo.createMessage({
        sessionId, role: 'tool', content: resultText, eventType: 'tool_result',
        processKind, parentAgentId, toolUseId: part.tool_use_id ?? null,
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
    }
  }
}

export function readContextWindow(): number {
  try {
    const config = getConfig();
    const adv = JSON.parse(config.advancedJson || '{}');
    const w = adv?.env?.CLAUDE_LINK_CONTEXT_WINDOW;
    if (typeof w === 'number' && w > 0) return w;
    if (typeof w === 'string' && Number.isFinite(Number(w))) return Number(w);
  } catch {
    // ignore
  }
  return 200000;
}
