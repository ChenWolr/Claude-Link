import https from 'https';
import http from 'http';
import { getConfig } from './config-manager';
import * as sessionRepo from '../database/repositories/session-repo';
import { logger } from '../utils/logger';
import { buildAnthropicApiUrl, isOfficialAnthropicBaseUrl } from './api-url';
import { resolveConfiguredDefaultModel } from '../../shared/settings-parser';

interface ClaudeApiResponse {
  content: Array<{ type: string; text?: string }>;
}

export async function analyzeTopic(sessionId: string, firstMessage: string): Promise<string | null> {
  const config = getConfig();

  if (!config.apiKey) {
    logger.warn('No API key configured; skipping topic analysis');
    return null;
  }

  const baseUrl = config.apiBaseUrl?.trim() || 'https://api.anthropic.com';
  const isAnthropic = isOfficialAnthropicBaseUrl(baseUrl);
  const url = buildAnthropicApiUrl(baseUrl, 'messages');

  const model = resolveConfiguredDefaultModel(config.advancedJson, config.defaultModel);

  const requestBody = JSON.stringify({
    model,
    max_tokens: 50,
    messages: [
      {
        role: 'user',
        content: `用5个字以内概括以下对话的主题，只输出主题，不要解释：\n\n${firstMessage.slice(0, 500)}`,
      },
    ],
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey,
    'anthropic-version': '2023-06-01',
  };

  // 第三方兼容端点（OneAPI/openrouter 等）通常同时需要 Bearer 或保留 x-api-key，
  // 这里两者都带上，避免删掉 x-api-key 导致 401。
  if (!isAnthropic) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  try {
    const response = await makeHttpRequest(url, requestBody, headers, 10000);
    const data = JSON.parse(response) as ClaudeApiResponse;
    const text = data.content?.find((c) => c.type === 'text')?.text;
    if (text) {
      const topic = text.trim().replace(/\s+/g, ' ').slice(0, 20);
      sessionRepo.updateSession(sessionId, { name: topic });
      return topic;
    }
  } catch (error) {
    logger.warn('Topic analysis failed, using heuristic fallback', error);
  }

  // 兜底：取首句前 15 个字符，压缩空白避免标题里出现换行
  const fallback = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 15);
  sessionRepo.updateSession(sessionId, { name: fallback });
  return fallback;
}

function makeHttpRequest(
  url: URL,
  body: string,
  headers: Record<string, string>,
  timeoutMs = 10000,
): Promise<string> {
  const lib = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      },
    );

    // 超时保护：避免慢请求导致标题永久不更新
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
