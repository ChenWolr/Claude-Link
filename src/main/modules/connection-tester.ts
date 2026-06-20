// 测试连接（流式版）：spawn Claude Code CLI 发送「你好」，用 stream-json 输出，
// 逐事件解析后通过 IPC 推送给渲染进程的测试弹框，实时展示「连接中→已连接→响应中→成功/失败」。
//
// 与会话 spawnForChat 共用 buildSpawnEnv（同一套 env 注入），所以测试结果代表真实会话能否跑通。
// Claude Link 不参与 CLI 逻辑，只验证「配置送进去 CLI 认不认」。

import { spawn, type ChildProcess } from 'child_process';
import type { BrowserWindow } from 'electron';
import type { TestConnectionEventPayload } from '../../shared/types/ipc';
import { IPC_CHANNELS } from '../../shared/constants';
import { getConfig } from './config-manager';
import { buildSpawnEnv } from './process-manager';
import { writeClaudeSettings } from './settings-writer';
import { resolveDefaultModel, resolveAliasToActualModel, peekEnvValue } from '../../shared/settings-parser';
import { logger } from '../utils/logger';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_PROMPT = '你好';
// Claude Code CLI 冷启动需加载 skills/MCP/agents，配置多时可达 20-30s；
// 留足余量避免机器稍慢就误报"连接超时"。实际 API 响应通常 2-5s。
const TIMEOUT_MS = 90000;

// 当前正在进行的测试进程，供 abort 使用。同一时刻只允许一个测试。
let currentChild: ChildProcess | null = null;
let currentTimer: ReturnType<typeof setTimeout> | null = null;

function emit(mainWindow: BrowserWindow, payload: TestConnectionEventPayload): void {
  try {
    mainWindow.webContents.send(IPC_CHANNELS.TEST_CONNECTION_EVENT, payload);
  } catch (e) {
    logger.warn('Failed to send test connection event', e);
  }
}

function clearCurrent(): void {
  if (currentTimer) {
    clearTimeout(currentTimer);
    currentTimer = null;
  }
  currentChild = null;
}

// 取消正在进行的测试（用户点"取消"或关闭弹框时调用）。
export function abortTestConnection(): void {
  if (currentChild && !currentChild.killed) {
    try {
      currentChild.kill();
    } catch {
      // ignore
    }
  }
  clearCurrent();
}

// 流式测试连接。modelAlias 为用户在弹框里选择的别名（sonnet/haiku/opus/fable），
// 为空时自动从映射推导。结果通过 TEST_CONNECTION_EVENT 事件推送，不通过返回值。
export function runTestConnectionStream(modelAlias: string | null, mainWindow: BrowserWindow): void {
  // 若上一个测试还在跑，先终止，避免并发 spawn。
  abortTestConnection();

  const config = getConfig();
  const cliPath = config.cliPath || 'claude';

  // apiKey / baseUrl 都允许从高级 JSON 的 env 块兜底，不依赖 UI 字段是否已回填。
  const apiKey =
    config.apiKey?.trim() ||
    peekEnvValue(config.advancedJson, 'ANTHROPIC_API_KEY') ||
    peekEnvValue(config.advancedJson, 'ANTHROPIC_AUTH_TOKEN');
  if (!apiKey) {
    emit(mainWindow, {
      phase: 'error',
      message: '未填写 API Key',
      detail: '请在 API Key 字段或高级 JSON 的 env.ANTHROPIC_API_KEY 中至少填一个。',
    });
    return;
  }
  const baseUrl = config.apiBaseUrl?.trim() || peekEnvValue(config.advancedJson, 'ANTHROPIC_BASE_URL');
  if (!baseUrl) {
    emit(mainWindow, { phase: 'error', message: '未填写请求地址（API Base URL）' });
    return;
  }

  const requestedAlias = modelAlias?.trim() || resolveDefaultModel(config.advancedJson);
  const model = resolveAliasToActualModel(requestedAlias, config.advancedJson);
  const startTime = Date.now();

  // print + stream-json：逐事件输出 init / message / stream_event / result。
  const args = [
    '-p', TEST_PROMPT,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--model', model,
    '--verbose',
  ];

  emit(mainWindow, {
    phase: 'connecting',
    model,
    requestedModel: model,
    usedBaseUrl: config.apiBaseUrl?.trim() || peekEnvValue(config.advancedJson, 'ANTHROPIC_BASE_URL') || '',
  });

  const spawnEnv = buildSpawnEnv();
  logger.info(
    `testConnection(stream): model=${model}, baseUrl=${spawnEnv.ANTHROPIC_BASE_URL || '(官方默认)'}, ` +
      `SONNET映射=${spawnEnv.ANTHROPIC_DEFAULT_SONNET_MODEL || '(无)'}, apiKey=${spawnEnv.ANTHROPIC_API_KEY ? 'SET' : '(无)'}`,
  );

  // 测试 cwd：优先全局 workingDirectory；否则用专用临时目录，避免污染 process.cwd()。
  let testCwd = config.workingDirectory || '';
  if (!testCwd) {
    testCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-'));
  }
  // 把 claude-link 完整配置写进该目录的 .claude/settings.local.json（项目级 > 用户级）。
  try {
    writeClaudeSettings(testCwd, config);
  } catch (e) {
    logger.warn('测试连接：settings.local.json 投影失败', e);
  }

  const child = spawn(cliPath, args, {
    cwd: testCwd,
    env: spawnEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  currentChild = child;

  let buffer = '';
  let stderr = '';
  let assistantText = '';
  let connected = false;

  const finishWith = (payload: TestConnectionEventPayload): void => {
    if (currentChild !== child) return; // 已被新测试取代或 abort，忽略本次回调
    clearCurrent();
    try {
      child.kill();
    } catch {
      // ignore
    }
    emit(mainWindow, payload);
  };

  currentTimer = setTimeout(() => {
    finishWith({
      phase: 'error',
      message: `连接超时（${TIMEOUT_MS / 1000}s 无响应）`,
      detail: '请检查 URL / API Key / 模型名是否正确，以及网络是否可达。',
      durationMs: Date.now() - startTime,
    });
  }, TIMEOUT_MS);

  child.stdout?.on('data', (chunk: Buffer) => {
    // 已被新测试取代或 abort 清空：丢弃本次缓冲，避免取消后仍向弹框推送 streaming 增量。
    if (currentChild !== child) return;
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      // init：CLI 已启动并连上端点。新版 stream-json 输出 {type:'system',subtype:'init'}，
      // 类型定义/老版是 {type:'init'}，两种都兼容，用于驱动"已连接"状态。
      const isInit =
        evt.type === 'init' ||
        (evt.type === 'system' && (evt as { subtype?: string }).subtype === 'init');
      if (isInit) {
        if (!connected) {
          connected = true;
          const evtModel = (evt as { model?: string }).model || model;
          emit(mainWindow, { phase: 'connected', model: evtModel });
        }
        continue;
      }

      // stream_event：assistant 文本增量（逐字推送）
      if (evt.type === 'stream_event') {
        const inner = evt.event as { delta?: { type?: string; text?: string } } | undefined;
        const delta = inner?.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          assistantText += delta.text;
          emit(mainWindow, { phase: 'streaming', delta: delta.text });
        }
        continue;
      }

      // 兜底：某些 CLI 版本不发 stream_event，用完整 assistant message 文本。
      // 仅在尚未累积到文本时推送，避免与 stream_event 重复。
      if (evt.type === 'message' && (evt as { role?: string }).role === 'assistant') {
        if (assistantText.length === 0) {
          const content = evt.content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
                const text = (part as { text?: string }).text;
                if (typeof text === 'string' && text) {
                  assistantText += text;
                  emit(mainWindow, { phase: 'streaming', delta: text });
                }
              }
            }
          }
        }
        continue;
      }
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  child.on('error', (err) => {
    logger.warn(`Connection test spawn error: ${err.message}`);
    finishWith({
      phase: 'error',
      message: `启动 CLI 失败：${err.message}`,
      detail: `请确认 Claude Code CLI 已安装，路径：${cliPath}`,
      durationMs: Date.now() - startTime,
    });
  });

  child.on('exit', (code) => {
    if (currentChild !== child) return;
    const durationMs = Date.now() - startTime;
    const hasText = assistantText.replace(/\s/g, '').length > 0;

    if (code === 0 && hasText) {
      finishWith({
        phase: 'done',
        success: true,
        message: '连接成功：已收到 Claude Code 的响应。',
        detail: assistantText.slice(0, 500),
        durationMs,
      });
    } else {
      const detail = (stderr.trim() || assistantText || `(退出码 ${code})`).slice(0, 500);
      finishWith({
        phase: 'done',
        success: false,
        message: hasText
          ? 'CLI 返回了内容但可能不完整，请核对下方响应。'
          : `连接失败（退出码 ${code}）`,
        detail,
        durationMs,
      });
    }
  });
}
