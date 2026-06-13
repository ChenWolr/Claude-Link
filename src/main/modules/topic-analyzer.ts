import https from 'https';
import http from 'http';
import { getConfig } from './config-manager';
import * as sessionRepo from '../database/repositories/session-repo';
import { logger } from '../utils/logger';

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
  const isAnthropic = baseUrl.includes('api.anthropic.com');

  // Build the full API URL using string concatenation to avoid
  // new URL() path resolution that drops /v1 from base URLs.
  let urlStr: string;
  if (isAnthropic) {
    urlStr = 'https://api.anthropic.com/v1/messages';
  } else if (baseUrl.endsWith('/v1') || baseUrl.endsWith('/v1/')) {
    // Third-party endpoint already has /v1 - just append /messages
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    urlStr = base + 'messages';
  } else {
    // Third-party endpoint without /v1 - add /v1/messages
    const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    urlStr = base + '/v1/messages';
  }
  const url = new URL(urlStr);

  const requestBody = JSON.stringify({
    model: 'claude-haiku-4-6',
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

  // For third-party endpoints, might need different auth header
  if (!isAnthropic) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
    delete headers['x-api-key'];
  }

  try {
    const response = await makeHttpRequest(url, requestBody, headers);
    const data = JSON.parse(response) as ClaudeApiResponse;
    const text = data.content?.find((c) => c.type === 'text')?.text;
    if (text) {
      const topic = text.trim().slice(0, 20);
      sessionRepo.updateSession(sessionId, { name: topic });
      return topic;
    }
  } catch (error) {
    logger.warn('Topic analysis failed, using heuristic fallback', error);
  }

  // Heuristic fallback: first 15 chars of message
  const fallback = firstMessage.slice(0, 15).trim();
  sessionRepo.updateSession(sessionId, { name: fallback });
  return fallback;
}

function makeHttpRequest(
  url: URL,
  body: string,
  headers: Record<string, string>,
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

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
