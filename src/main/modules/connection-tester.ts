// 测试连接：spawn Claude Code CLI 发送「你好」，解析 stream-json 输出并汇总结果。
//
// 多供应商库后的唯一入口（用户决策：测试收敛到连接页每个模型行内的「测试」按钮，
// 旧顶部「测试连接」弹框与流式通道已删除）：
// - runProviderModelTest(providerId, modelId)：按指定供应商 + 指定模型 spawn，直返汇总结果；
// - 与会话 spawnForChat 共用 buildSpawnEnv（同一套 env 注入），所以测试结果代表真实会话能否跑通。
// Claude Link 不参与 CLI 逻辑，只验证「配置送进去 CLI 认不认」。

import { spawn, type ChildProcess } from 'child_process';
import { getConfig, getStoredProviderProfile, decryptProviderApiKey } from './config-manager';
import { buildSpawnEnv, type SessionModelOverride } from './cli-shared';
import { writeClaudeSettings } from './settings-writer';
import { logger } from '../utils/logger';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_PROMPT = '你好';
// Claude Code CLI 冷启动需加载 skills/MCP/agents，配置多时可达 20-30s；
// 留足余量避免机器稍慢就误报"连接超时"。实际 API 响应通常 2-5s。
const TIMEOUT_MS = 90000;

export interface ProviderModelTestResult {
  success: boolean;
  message: string;
  detail: string;
  durationMs: number;
}

// 当前正在进行的测试进程，供 abort 使用。同一时刻只允许一个测试。
let currentChild: ChildProcess | null = null;
let currentTimer: ReturnType<typeof setTimeout> | null = null;

function clearCurrent(): void {
  if (currentTimer) {
    clearTimeout(currentTimer);
    currentTimer = null;
  }
  currentChild = null;
}

// 取消正在进行的测试（新测试发起前调用，避免并发 spawn）。
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

interface TestTarget {
  override: SessionModelOverride | null;
  apiKey: string;
  baseUrl: string;
  model: string;
}

// 核心：spawn CLI → 逐事件解析 → 汇总直返（无流式推送）。
function executeCliTest(target: TestTarget): Promise<ProviderModelTestResult> {
  const config = getConfig();
  const cliPath = config.cliPath || 'claude';
  const startTime = Date.now();

  if (!target.apiKey) {
    return Promise.resolve({
      success: false,
      message: '未填写 API Key',
      detail: '请先在「连接」页给供应商配置 API Key。',
      durationMs: 0,
    });
  }

  const args = [
    '-p', TEST_PROMPT,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--model', target.model,
    '--verbose',
  ];

  logger.info(
    `testProviderModel: model=${target.model}, baseUrl=${target.override?.apiBaseUrl ?? '(配置投影)'}, ` +
      `SONNET映射=${target.override ? target.override.modelId : '(无)'}, apiKey=SET`,
  );

  // 测试 cwd：优先全局 workingDirectory；否则用专用临时目录，避免污染 process.cwd()。
  let testCwd = config.workingDirectory || '';
  if (!testCwd) {
    testCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-'));
  }
  // 把 claude-link 完整配置写进该目录的 .claude/settings.local.json（项目级 > 用户级）。
  // 行内测试指定非 lastUsed 供应商时，此处投影仍是 lastUsed 组合——模型/端点以
  // CLI 参数 --model 与进程 env（优先级更高）为准，投影只兜底 permissions 等顶层字段。
  try {
    writeClaudeSettings(testCwd, config);
  } catch (e) {
    logger.warn(`测试连接：settings.local.json 投影失败：${e instanceof Error ? e.message : String(e)}`);
  }

  const child = spawn(cliPath, args, {
    cwd: testCwd,
    env: buildSpawnEnv(target.override),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  currentChild = child;

  let buffer = '';
  let stderr = '';
  let assistantText = '';

  const finishWith = (result: ProviderModelTestResult): ProviderModelTestResult => {
    if (currentChild !== child) return result; // 已被新测试取代或 abort，忽略本次回调
    clearCurrent();
    try {
      child.kill();
    } catch {
      // ignore
    }
    return result;
  };

  currentTimer = setTimeout(() => {
    finishWith({
      success: false,
      message: `连接超时（${TIMEOUT_MS / 1000}s 无响应）`,
      detail: '请检查 URL / API Key / 模型名是否正确，以及网络是否可达。',
      durationMs: Date.now() - startTime,
    });
  }, TIMEOUT_MS);

  return new Promise<ProviderModelTestResult>((resolve) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      // 已被新测试取代或 abort 清空：丢弃本次缓冲。
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

        // init：CLI 已启动并连上端点（新版 {type:'system',subtype:'init'} / 老版 {type:'init'}）。
        // 文本只需 stream_event / assistant message 兜底两条路径，此处 continue 即可。
        const isInit =
          evt.type === 'init' ||
          (evt.type === 'system' && (evt as { subtype?: string }).subtype === 'init');
        if (isInit) continue;

        // stream_event：assistant 文本增量（逐字累积）。
        if (evt.type === 'stream_event') {
          const inner = evt.event as { delta?: { type?: string; text?: string } } | undefined;
          const delta = inner?.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            assistantText += delta.text;
          }
          continue;
        }

        // 兜底：某些 CLI 版本不发 stream_event，用完整 assistant message 文本。
        if (evt.type === 'message' && (evt as { role?: string }).role === 'assistant') {
          if (assistantText.length === 0) {
            const content = evt.content;
            if (Array.isArray(content)) {
              for (const part of content) {
                if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
                  const text = (part as { text?: string }).text;
                  if (typeof text === 'string' && text) {
                    assistantText += text;
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
      resolve(finishWith({
        success: false,
        message: `启动 CLI 失败：${err.message}`,
        detail: `请确认 Claude Code CLI 已安装，路径：${cliPath}`,
        durationMs: Date.now() - startTime,
      }));
    });

    child.on('exit', (code) => {
      if (currentChild !== child) return;
      const durationMs = Date.now() - startTime;
      const hasText = assistantText.replace(/\s/g, '').length > 0;

      if (code === 0 && hasText) {
        resolve(finishWith({
          success: true,
          message: '连接成功：已收到 Claude Code 的响应。',
          detail: assistantText.slice(0, 500),
          durationMs,
        }));
      } else {
        const detail = (stderr.trim() || assistantText || `(退出码 ${code})`).slice(0, 500);
        resolve(finishWith({
          success: false,
          message: hasText
            ? 'CLI 返回了内容但可能不完整，请核对响应。'
            : `连接失败（退出码 ${code}）`,
          detail,
          durationMs,
        }));
      }
    });
  });
}

// 设置页模型行内测试（r5 + 用户决策收敛）：按指定供应商 + 指定模型 spawn，直返汇总结果。
export async function runProviderModelTest(providerId: string, modelId: string): Promise<ProviderModelTestResult> {
  abortTestConnection();
  const profile = getStoredProviderProfile(providerId);
  if (!profile) throw new Error('供应商不存在');
  if (!profile.models.some((m) => m.id === modelId)) throw new Error('模型不在该供应商的列表中');
  const apiKey = decryptProviderApiKey(profile);
  if (!apiKey) {
    return { success: false, message: '未填写 API Key', detail: `供应商「${profile.name}」未配置 API Key，无法测试。`, durationMs: 0 };
  }
  const override: SessionModelOverride = { apiBaseUrl: profile.apiBaseUrl, apiKey, modelId };
  return executeCliTest({ override, apiKey, baseUrl: profile.apiBaseUrl, model: modelId });
}
