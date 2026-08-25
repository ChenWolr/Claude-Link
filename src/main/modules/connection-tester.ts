// 测试连接：spawn Claude Code CLI 发送「你好」，解析 stream-json 输出并汇总结果。
//
// 多供应商库后的唯一入口（用户决策：测试收敛到连接页每个模型行内的「测试」按钮，
// 旧顶部「测试连接」弹框与流式通道已删除）：
// - runProviderModelTest(providerId, modelId)：按指定供应商 + 指定模型 spawn，直返汇总结果；
// - 与会话 spawnForChat 共用 buildSpawnEnv（同一套 env 注入），所以测试结果代表真实会话能否跑通。
// Claude Link 不参与 CLI 逻辑，只验证「配置送进去 CLI 认不认」。

import { spawn, execFile, type ChildProcess } from 'child_process';
import { getConfig, getStoredProviderProfile, decryptProviderApiKey } from './config-manager';
import { buildSpawnEnv, type SessionModelOverride } from './cli-shared';
import { classifyUpstreamError, upstreamFatalMessage } from '../../shared/upstream-errors';
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

// 在飞测试按行（providerId::modelId）隔离（连接加固补丁）：不同模型行的测试可并行，
// 只有同一行重复发起（渲染层已拦，IPC 直调兜底）才中止旧的。此前是全局单飞——
// 新测试无条件杀掉所有在飞测试，连点几行时只有最后一行有结果。
interface ActiveTest {
  child: ChildProcess | null;
  timer: ReturnType<typeof setTimeout> | null;
  settle: ((result: ProviderModelTestResult) => void) | null;
}
const activeTests = new Map<string, ActiveTest>();

// Windows 下 spawn 用 shell:true（PATH 解析 claude.cmd），child.kill() 只杀 cmd 包装、
// 遗留 claude.exe 孤儿（曾致后续测试/会话被占用）；taskkill /T 按进程树整杀。
function killTestChild(child: ChildProcess): void {
  try {
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => undefined);
    } else {
      child.kill();
    }
  } catch {
    // ignore
  }
}

// 取消正在进行的测试（新测试发起前调用，避免并发 spawn）。
// 中止指定行的在飞测试：杀进程 + 落定「已被取代」（promise 不悬挂，按钮不卡「测试中」）。
function abortActiveTest(key: string): void {
  const active = activeTests.get(key);
  if (!active) return;
  if (active.child && !active.child.killed) {
    killTestChild(active.child);
  }
  if (active.timer) {
    clearTimeout(active.timer);
  }
  activeTests.delete(key);
  active.settle?.({
    success: false,
    message: '测试已被新的测试取代，请重试',
    detail: '',
    durationMs: 0,
  });
}

interface TestTarget {
  providerId: string;
  override: SessionModelOverride | null;
  apiKey: string;
  baseUrl: string;
  model: string;
  providerName: string;
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
    // 连接加固补丁：完全隔离 settings 文件来源（user/project/local 均不加载）。CC 启动时
    // settings env 块会压过进程 env——用户终端用的 ~/.claude/settings.json 若钉了别的供应商
    // 端点/凭据，会把「测试 A 供应商」的请求劫持到 B（实测 404 model_not_found 冤案）。
    // 空列表 = 不加载任何 settings 文件，连接三元组由下方进程 env（buildSpawnEnv）唯一决定。
    // 注意：Windows 下 spawn 走 shell:true，空字符串参数会被 cmd 吞掉导致 --setting-sources
    // 误吞下一个参数（实测 "Invalid setting source: -p"）；传字面 '""' 经 cmd 解析为空参数。
    '--setting-sources', '""',
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

  // 恒用专用临时目录（连接加固 Task 8）：不碰用户真实工作目录，也隔离老版本投影残留的
  // settings.local.json env。真实会话凭据走 SDK Options.settings（最高优先级）+ 进程 env，
  // 与「临时目录 + 进程 env + --model」语义一致，测试结果仍代表真实会话能否跑通。
  const testCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-'));

  const child = spawn(cliPath, args, {
    cwd: testCwd,
    env: buildSpawnEnv(target.override),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  const key = `${target.providerId}::${target.model}`;
  // 同一行若已有在飞测试（IPC 直调兜底；渲染层同行 pending 已拦截），先中止旧的。
  abortActiveTest(key);
  const active: ActiveTest = { child, timer: null, settle: null };
  activeTests.set(key, active);

  let buffer = '';
  let stderr = '';
  let assistantText = '';

  const finishWith = (result: ProviderModelTestResult): ProviderModelTestResult => {
    if (activeTests.get(key) !== active) return result; // 已被同行新测试取代，忽略本次回调
    if (active.timer) clearTimeout(active.timer);
    activeTests.delete(key);
    killTestChild(child);
    return result;
  };

  return new Promise<ProviderModelTestResult>((resolve) => {
    active.settle = resolve;
    // 超时也必须 resolve：finishWith 清掉本行 active 后，exit 事件的
    // activeTests.get(key) !== active 守卫直接 return，IPC promise 永不落定 → 行按钮永久「测试中」。
    active.timer = setTimeout(() => {
      resolve(finishWith({
        success: false,
        message: `连接超时（${TIMEOUT_MS / 1000}s 无响应）`,
        detail: '请检查 URL / API Key / 模型名是否正确，以及网络是否可达。',
        durationMs: Date.now() - startTime,
      }));
    }, TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      // 已被新测试取代或 abort 清空：丢弃本次缓冲。
      if (activeTests.get(key) !== active) return;
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
      if (activeTests.get(key) !== active) return;
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
        const rawDetail = (stderr.trim() || assistantText || `(退出码 ${code})`).slice(0, 500);
        // 上游确定性错误给精确诊断（model_not_found → 指明令牌分组不支持该模型等），
        // 其余维持原文案。
        const upstream = classifyUpstreamError(rawDetail);
        const message =
          upstream.kind !== 'unknown' && upstream.kind !== 'network'
            ? upstreamFatalMessage(upstream, target.providerName, target.model)
            : hasText
              ? 'CLI 返回了内容但可能不完整，请核对响应。'
              : `连接失败（退出码 ${code}）`;
        resolve(finishWith({
          success: false,
          message,
          detail: rawDetail,
          durationMs,
        }));
      }
    });
  });
}

// 设置页模型行内测试（r5 + 用户决策收敛）：按指定供应商 + 指定模型 spawn，直返汇总结果。
// 行级并发（连接加固补丁）：不同行并行测试互不影响；同行重入由 executeCliTest 内按 key 中止。
export async function runProviderModelTest(providerId: string, modelId: string): Promise<ProviderModelTestResult> {
  const profile = getStoredProviderProfile(providerId);
  if (!profile) throw new Error('供应商不存在');
  if (!profile.models.some((m) => m.id === modelId)) throw new Error('模型不在该供应商的列表中');
  const apiKey = decryptProviderApiKey(profile);
  if (!apiKey) {
    return { success: false, message: '未填写 API Key', detail: `供应商「${profile.name}」未配置 API Key，无法测试。`, durationMs: 0 };
  }
  const override: SessionModelOverride = { apiBaseUrl: profile.apiBaseUrl, apiKey, modelId };
  return executeCliTest({ providerId, override, apiKey, baseUrl: profile.apiBaseUrl, model: modelId, providerName: profile.name });
}
