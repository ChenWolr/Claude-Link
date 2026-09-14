import https from 'https';
import http from 'http';
import { getConfig, getProviderModelSources, DECRYPT_FAILED } from './config-manager';
import * as sessionRepo from '../database/repositories/session-repo';
import { logger } from '../utils/logger';
import { buildAnthropicApiUrl, isOfficialAnthropicBaseUrl } from './api-url';
import { resolveConfiguredDefaultModel } from '../../shared/settings-parser';
import { resolveSessionModel } from '../../shared/session-model';
import { isAutoSessionName } from '../../shared/auto-session-name';
import { maskApiKey } from '../../shared/provider-library';
import {
  TOPIC_ATTEMPT_LADDER,
  buildTopicRequestBody,
  extractTopicCandidate,
  nextAttemptSpec,
  type TopicAttemptSpec,
  type TopicResponseShape,
} from '../../shared/topic-analyzer-core';

// 非 2xx 的类型化错误：4xx（疑似 thinking 字段不兼容）与 5xx/超时在网络层走不同升档分支。
// 消息格式与修复前逐字一致（HTTP <status>: <body 前 200 字符>），仅多了 status 字段。
class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
    this.status = status;
  }
}

// F4：自动命名竞态守卫——命名门槛在发送瞬间判定（渲染层 isAutoSessionName），而本模块
// 全流程最多 2 次串行 HTTP 请求（每次超时 10s，窗口最长约 20s）；用户在此窗口手动重命名后，
// 迟到的主题/兜底名不得覆盖（写前重查兜底）。
// 主进程侧收口：每次写 name 前重查当前名仍为「会话 N」自动形态才写（手动名一律让位）。
// H3：判据抽 shared 纯函数（三端同源）并收紧为精确形态——「会话」前缀匹配会被
// 「会话备份」等自然命名绕过，误判为自动名槽位后迟到主题照样覆盖。
function isAutoNameSlot(sessionId: string): boolean {
  return isAutoSessionName(sessionRepo.getSession(sessionId)?.name);
}

// hb10-SMG-02/V01（hb12-SMG-07 同函数）：总 Deadline 30s（复用既有 10s×2 语义上界）——
// 断连/慢滴请求使单请求 10s 超时失效（悬挂 promise），总 Deadline 保证 analyzeTopic 有界返回；
// 响应累积 >1MiB 即 destroy+reject，防恶意/异常端点无限吞内存。
const TOPIC_TOTAL_DEADLINE_MS = 30 * 1000;
const TOPIC_RESPONSE_MAX_BYTES = 1024 * 1024;

export async function analyzeTopic(sessionId: string, firstMessage: string): Promise<string | null> {
  const config = getConfig();

  // 供应商库解析（会话 override > 最近使用 > 库首）；库为空时回落老字段/别名链。
  // 后台标题分析同样遵守「唯一实际模型」与「连接三元组完整性」——端点/密钥/模型必须
  // 来自同一解析结果，不得端点用解析值、凭据用 lastUsed 投影（跨供应商混用）。
  const session = sessionRepo.getSession(sessionId);
  const resolved = resolveSessionModel(
    {
      providerOverride: session?.providerOverride ?? null,
      modelOverride: session?.modelOverride ?? null,
    },
    { providerId: config.lastUsedProviderId, modelId: config.lastUsedModelId },
    getProviderModelSources(),
  );
  // 解析到供应商时凭据/端点一律取该供应商（key 为空即无凭据）；只有库为空（老字段链）
  // 才回落 config 老字段——两者永不交叉。
  const apiKey = resolved.provider ? resolved.provider.apiKey : config.apiKey;
  // hb13-v B2（F-03）：解密哨兵按未配置处理——供应商分支的 apiKey 已由 getProviderModelSources
  // 守卫为空串，此处兜住老字段链；损坏态直接跳过分析走首句兜底（不空耗 HTTP）。
  if (!apiKey || apiKey === DECRYPT_FAILED) {
    logger.warn('No API key configured; skipping topic analysis');
    return null;
  }

  const baseUrl = resolved.provider
    ? resolved.provider.apiBaseUrl
    : (config.apiBaseUrl?.trim() || 'https://api.anthropic.com');
  const isAnthropic = isOfficialAnthropicBaseUrl(baseUrl);
  const url = buildAnthropicApiUrl(baseUrl, 'messages');

  const model = resolved.modelId || resolveConfiguredDefaultModel(config.advancedJson, config.defaultModel);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };

  // 第三方兼容端点（OneAPI/openrouter 等）通常同时需要 Bearer 或保留 x-api-key，
  // 这里两者都带上，避免删掉 x-api-key 导致 401。凭据与上方 baseUrl/model 同源。
  if (!isAnthropic) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // 验收梯（有界，全流程最多 2 次 HTTP）：思考型模型会把思考过程泄漏进 text 块并烧光
  // max_tokens 截断（详见 shared/topic-analyzer-core.ts 头注释），答卷必须先验收再落库。
  // 答卷被拒 → 升预算重试；首梯 4xx → 换 legacy 形态（无 thinking 字段）重试；
  // 超时/5xx/网络错误/JSON 解析失败 → 不重试，直达首句兜底。
  let spec: TopicAttemptSpec | null = TOPIC_ATTEMPT_LADDER[0];
  let specIndex: 0 | 1 = 0;
  // hb10-SMG-02/V01：总 Deadline 竞速——到点按超时路径走首句兜底（与单请求超时同归）。
  let deadlineReject: (e: Error) => void = () => {};
  const overallDeadline = new Promise<never>((_, reject) => { deadlineReject = reject; });
  const deadlineTimer = setTimeout(() => deadlineReject(new Error(`Topic analysis overall deadline (${TOPIC_TOTAL_DEADLINE_MS}ms)`)), TOPIC_TOTAL_DEADLINE_MS);
  try {
    while (spec) {
      const requestBody = buildTopicRequestBody(model, firstMessage, spec);
      try {
        const response = await Promise.race([makeHttpRequest(url, requestBody, headers, 10000), overallDeadline]);
        const verdict = extractTopicCandidate(JSON.parse(response) as TopicResponseShape);
        if (verdict.ok && verdict.topic) {
          // 出口①（LLM 主题）：F4 写前门保留
          if (isAutoNameSlot(sessionId)) {
            sessionRepo.updateSession(sessionId, { name: verdict.topic });
          }
          return verdict.topic;
        }
        logger.warn(`Topic analysis response rejected (${verdict.reason}), escalating thinking budget`);
        spec = nextAttemptSpec(specIndex, 'validation');
        specIndex = 1;
      } catch (error) {
        if (
          error instanceof HttpStatusError && error.status >= 400 && error.status < 500 && specIndex === 0
        ) {
          logger.warn(`Topic analysis got HTTP ${error.status} (thinking param incompatibility suspected), retrying without thinking field`);
          spec = nextAttemptSpec(0, 'http_4xx');
          specIndex = 1;
          continue;
        }
        logger.warn(`Topic analysis failed, using heuristic fallback: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
  } finally {
    // 到点前正常返回/中断时清计时器，防 deadline 拒绝泄漏成 unhandledRejection。
    clearTimeout(deadlineTimer);
  }

  // 兜底：取首句前 15 个字符，压缩空白避免标题里出现换行。
  // 出口②（首句兜底）：与修复前逐字等价（F4/H3 写前门保留）。
  // hb10-SMG-07：fallback 为空串（消息全是空白）时不写库，保持原名并返回 null。
  // hb10-SHL-07：兜底名过 maskApiKey——用户粘贴密钥当首句时不落明文（掩码后再截断）。
  // hb13-v A4：①空白压缩正则必须 /\s+/g（旧实现 /s+/g 反斜杠丢失按字母 s 替换，兜底标题
  // 所有小写 s 变空格且落库）；②无条件掩码降为条件掩码——maskApiKey 把任意非空输入变
  // sk-…**** 形态，正常兜底标题全部被毁，仅首句呈 API key 形态（sk- 前缀+≥8 位键字符）才掩码。
  const rawFallback = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 15);
  const fallback = (/^sk-[A-Za-z0-9_\-]{8,}/.test(rawFallback) ? maskApiKey(rawFallback) : rawFallback).slice(0, 15);
  if (!fallback) {
    return null;
  }
  if (isAutoNameSlot(sessionId)) {
    sessionRepo.updateSession(sessionId, { name: fallback });
  }
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
        let bytes = 0;
        res.on('data', (chunk) => {
          // hb12-SMG-07：响应累积 >1MiB 即断开拒绝（防异常端点无限吞内存）。
          bytes += chunk.length;
          if (bytes > TOPIC_RESPONSE_MAX_BYTES) {
            req.destroy(new Error(`Topic response exceeds ${TOPIC_RESPONSE_MAX_BYTES} bytes`));
            return;
          }
          data += chunk;
        });
        // hb10-SMG-V01：Node22/Electron35 实测断连只 emit 'aborted' 不 emit 'error'——
        // 不监听 aborted 会让 promise 永久悬挂（该请求的 10s 超时挂在 req 上对响应流无效）。
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('response aborted')));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new HttpStatusError(res.statusCode!, data));
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
