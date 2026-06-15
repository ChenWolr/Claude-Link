// 测试连接：用当前配置（apiKey/apiBaseUrl/defaultModel/advancedJson）调用
// Claude Code CLI，发送一条简单消息「你好」，有正常响应文本代表配置可用。
//
// 本质上和 spawnForChat 用同一套 env 注入（buildSpawnEnv），所以测试结果
// 能代表真实会话能否跑通。这是"配置输送器"定位下的诊断能力——
// Claude Link 不参与 CLI 逻辑，只验证"配置送进去 CLI 认不认"。

import { spawn } from 'child_process';
import type { ConnectionTestResult } from '../../shared/types/config';
import { getConfig } from './config-manager';
import { buildSpawnEnv } from './process-manager';
import { logger } from '../utils/logger';

const TEST_PROMPT = '你好';
const TIMEOUT_MS = 45000;

export async function testConnection(): Promise<ConnectionTestResult> {
  const config = getConfig();
  const cliPath = config.cliPath || 'claude';

  if (!config.apiKey?.trim()) {
    return { success: false, message: '未填写 API Key' };
  }
  if (!config.apiBaseUrl?.trim()) {
    return { success: false, message: '未填写请求地址（API Base URL）' };
  }

  const model = config.defaultModel?.trim() || 'sonnet';
  const startTime = Date.now();

  // print 模式单次调用：claude -p "你好" --output-format json --model X --verbose
  const args = ['-p', TEST_PROMPT, '--output-format', 'json', '--model', model, '--verbose'];

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: ConnectionTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const spawnEnv = buildSpawnEnv();
    logger.info(`testConnection: model=${model}, baseUrl=${spawnEnv.ANTHROPIC_BASE_URL || '(官方默认)'}, SONNET映射=${spawnEnv.ANTHROPIC_DEFAULT_SONNET_MODEL || '(无)'}, apiKey=${spawnEnv.ANTHROPIC_API_KEY ? 'SET' : '(无)'}`);
    const child = spawn(cliPath, args, {
      cwd: config.workingDirectory || process.cwd(),
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows 上 claude 通常是 claude.cmd，需要 shell 解析
      shell: process.platform === 'win32',
    });

    const timer = setTimeout(() => {
      finish({
        success: false,
        message: `连接超时（${TIMEOUT_MS / 1000}s 无响应）。请检查 URL / API Key / 模型名是否正确，以及网络是否可达。`,
        durationMs: Date.now() - startTime,
      });
    }, TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      logger.warn(`Connection test spawn error: ${err.message}`);
      finish({
        success: false,
        message: `启动 CLI 失败：${err.message}（请确认 Claude Code CLI 已安装，路径：${cliPath}）`,
        durationMs: Date.now() - startTime,
      });
    });

    child.on('exit', (code) => {
      const durationMs = Date.now() - startTime;
      const trimmedStdout = stdout.trim();

      if (code === 0 && trimmedStdout) {
        // claude --output-format json：
        //   新版(2.x)输出事件数组 [{type:system,init},{type:assistant,message:{content:[{type:text}]}},{type:result,result}]
        //   老版输出单个 {type:result, result:"..."}
        // 两种都要能取到实际回复文本，而不是把 init 事件当预览。
        let responseText = '';
        try {
          const parsed: unknown = JSON.parse(trimmedStdout);
          if (Array.isArray(parsed)) {
            for (const evt of parsed) {
              if (!evt || typeof evt !== 'object') continue;
              const e = evt as Record<string, unknown>;
              if (e.type === 'result' && typeof e.result === 'string') { responseText = e.result; break; }
              if (e.type === 'assistant') {
                const content = (e.message as { content?: unknown[] } | undefined)?.content;
                const textPart = Array.isArray(content)
                  ? content.find(
                      (c): c is { type: string; text: string } =>
                        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'text' && typeof (c as { text?: string }).text === 'string',
                    )
                  : undefined;
                if (textPart) { responseText = textPart.text; break; }
              }
              if (e.type === 'text' && typeof e.text === 'string') { responseText = e.text; break; }
            }
            if (!responseText) responseText = trimmedStdout;
          } else if (parsed && typeof parsed === 'object') {
            const r = (parsed as { result?: unknown }).result;
            if (typeof r === 'string') responseText = r;
            else if (typeof (parsed as { text?: unknown }).text === 'string') responseText = (parsed as { text: string }).text;
            else responseText = trimmedStdout;
          } else {
            responseText = trimmedStdout;
          }
        } catch {
          responseText = trimmedStdout;
        }

        if (responseText.replace(/\s/g, '').length > 0) {
          finish({
            success: true,
            message: '✅ 配置成功！Claude Code CLI 已正常响应。',
            responsePreview: responseText.slice(0, 200),
            durationMs,
          });
        } else {
          finish({
            success: false,
            message: 'CLI 返回为空内容，可能模型名不被端点识别。请检查模型映射（sonnet/haiku/opus → 实际模型）。',
            durationMs,
          });
        }
      } else {
        const errorDetail = (stderr.trim() || trimmedStdout).slice(0, 300);
        finish({
          success: false,
          message: `❌ CLI 调用失败（退出码 ${code}）${errorDetail ? '：' + errorDetail : '。请检查 API Key、URL、模型配置。'}`,
          durationMs,
        });
      }
    });
  });
}
