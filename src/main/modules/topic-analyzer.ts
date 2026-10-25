// 【连接面声明】本模块是主进程 HTTP 直连白名单成员（契约：scripts/regression-tests.ts 连接面白名单）。
// 直连绕过 SDK 属设计内（后台轻量任务：会话自动命名/主题分析）；不读任何 settings.json——
// 与生产 SDK 链路的已知语义分叉：生产会话受原生 user/project/local settings env 影响，本直连不受。
// 凭据/端点/模型经 resolveSessionModel 与生产同源（连接三元组完整性）。
import https from 'https';
import http from 'http';
import { getConfig, getProviderModelSources, DECRYPT_FAILED } from './config-manager';
import * as sessionRepo from '../database/repositories/session-repo';
import * as messageRepo from '../database/repositories/message-repo';
import { logger } from '../utils/logger';
import { buildAnthropicApiUrl, isOfficialAnthropicBaseUrl } from './api-url';
import { resolveConfiguredDefaultModel } from '../../shared/settings-parser';
import { resolveSessionModel } from '../../shared/session-model';
import { isUpgradableNameSource } from '../../shared/auto-session-name';
import { maskApiKey } from '../../shared/provider-library';
import { pushToMainWindow } from './push-bus';
import { IPC_CHANNELS } from '../../shared/constants';
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

// F4：自动命名竞态守卫——命名门槛在发送瞬间判定（渲染层名源门槛），而本模块
// 全流程最多 2 次串行 HTTP 请求（每次超时 10s，正常窗口上界约 20s；总 Deadline 30s 兜底，
// 见下方 hb10-SMG-02）；用户在此窗口手动重命名后，
// 迟到的主题/短输入名不得覆盖（写前重查兜底；SA-4 后出口 = LLM 主题 + 短输入直写）。
// 主进程侧收口：每次写 name 前重查当前名源仍可升级（slot/first_input）才写——
// custom（用户命名，含存量派生）与 generated（已概括）一律让位。
// H3：判据抽 shared 纯函数（三端同源）——P4 升级为 nameSource 判定（计划 §3.2.1-8）。
function isAutoNameSlot(sessionId: string): boolean {
  const s = sessionRepo.getSession(sessionId);
  return !!s && isUpgradableNameSource(s.nameSource);
}

// P4-A（计划 §3.2.2-1）：每会话每进程的命名尝试预算与在飞互斥——LLM 失败（限流/超时/
// 验收两连拒）后由回复结束边沿（maybeRetrySessionNaming）与渲染层后续轮次触发共同重试；
// attempts 达 3（含首发与短输入直写，直写也是一次「命名尝试」）后本进程内永不重试，
// 防无限重试烧配额；重启进程计数清零（可接受，计划 §3.3）。topicInFlight 拦多端并发 /
// 双边沿重入（同会话同刻只允许一次分析在跑）。
const topicAttempts = new Map<string, number>();
const topicInFlight = new Set<string>();
const TOPIC_MAX_ATTEMPTS = 3;

// hb10-SMG-02/V01（hb12-SMG-07 同函数）：总 Deadline 30s（复用既有 10s×2 语义上界）——
// 慢滴（持续低速流入使 socket idle 型 10s 超时永不触发）等异常令 promise 长期悬挂（干净断连
// 已由下方 aborted 监听即时 reject，不再依赖 Deadline），总 Deadline 保证 analyzeTopic 有界返回；
// 响应累积 >1MiB 即 destroy+reject，防恶意/异常端点无限吞内存。
const TOPIC_TOTAL_DEADLINE_MS = 30 * 1000;
const TOPIC_RESPONSE_MAX_BYTES = 1024 * 1024;

export async function analyzeTopic(sessionId: string, firstMessage: string): Promise<string | null> {
  // P4-A（计划 §3.2.2-1）：入口统一收口——在飞互斥（同会话重入直接 null）+ 尝试预算计数
  // （短输入直用分支同计数，含首发）+ finally 必清在飞标记（异常路径不泄漏）。主体逻辑在
  // analyzeTopicAttempt（原 analyzeTopic 主体原样迁移，P6-乙 失败 return null 不写库契约不变）。
  if (topicInFlight.has(sessionId)) return null;
  topicInFlight.add(sessionId);
  try {
    const n = (topicAttempts.get(sessionId) ?? 0) + 1;
    topicAttempts.set(sessionId, n);
    if (n > TOPIC_MAX_ATTEMPTS) return null;
    return await analyzeTopicAttempt(sessionId, firstMessage);
  } finally {
    topicInFlight.delete(sessionId);
  }
}

async function analyzeTopicAttempt(sessionId: string, firstMessage: string): Promise<string | null> {
  // SA-4/P6-乙（短输入跳过）：首条消息 trim 后 ≤8 字符不值得 LLM 概括——直接以原文为名写库
  // 返回，不发起 LLM 请求。写前门与既有写点一致（F4 惯例：用户已手动改名则让位）；sk- 前缀
  // 形态条件掩码为边界加固（防密钥碎片入标题）。空串（trim 后 0 字）不走本路径（>0 守卫，
  // IPC 入口已对空白消息拦截，此处为防御性重复）。
  const trimmed = firstMessage.trim();
  if (trimmed.length > 0 && trimmed.length <= 8) {
    const name = /^sk-[A-Za-z0-9_\-]{8,}/.test(trimmed) ? maskApiKey(trimmed) : trimmed;
    if (isAutoNameSlot(sessionId)) {
      // P4（计划 §3.2.1-8）：写库带 nameSource='generated'（短输入直写也是一次命名升级）。
      sessionRepo.updateSession(sessionId, { name, nameSource: 'generated' });
      // P6-乙（写库后补推送）：与 SESSION_UPDATE 路径同形态——写库成功即广播 upsert（跨端
      // 列表同步标题变更）；推送失败由 push-bus 内部吞噬，不阻塞写库结果。
      pushToMainWindow(IPC_CHANNELS.SESSIONS_CHANGED, { kind: 'upsert', sessionId });
    }
    return name;
  }

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
  // 守卫为空串，此处兜住老字段链；损坏态直接跳过分析返回 null（不空耗 HTTP）。
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
  // 超时/5xx/网络错误/JSON 解析失败 → 不重试，直达失败返回（P6-乙：兜底不再写库）。
  let spec: TopicAttemptSpec | null = TOPIC_ATTEMPT_LADDER[0];
  let specIndex: 0 | 1 = 0;
  // hb10-SMG-02/V01：总 Deadline 竞速——到点按超时路径走失败返回（与单请求超时同归）。
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
            // P4（计划 §3.2.1-8）：写库带 nameSource='generated'（已概括，此后自动写让位）。
            sessionRepo.updateSession(sessionId, { name: verdict.topic, nameSource: 'generated' });
            // P6-乙（写库后补推送）：同短输入点——写库成功即广播 upsert（跨端列表同步）；
            // 推送失败由 push-bus 内部吞噬，不阻塞写库结果。
            pushToMainWindow(IPC_CHANNELS.SESSIONS_CHANGED, { kind: 'upsert', sessionId });
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
        logger.warn(`Topic analysis failed, keeping auto-name slot (no fallback write): ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
  } finally {
    // 到点前正常返回/中断时清计时器，防 deadline 拒绝泄漏成 unhandledRejection。
    clearTimeout(deadlineTimer);
  }

  // SA-4/P6-乙（兜底不落库，2026-10-21）：失败路径不再截断首句写库——原「首句前 15 字符」
  // 兜底名质量差（跨句截断/复制原文碎片），且覆盖「会话 N」槽位后回补链不再重试。改为
  // return null：DB 保留「会话 N」槽位 → 既有 switchSession 回补链可重试；渲染层
  // .then(topic => { if (topic) ... }) 与 catch 已对 null 静默，零渲染层改动。
  // [P4 修订] 「槽位」在名源语义下含 slot 与 first_input（兜底名）两态，均仍可升级。
  return null;
}

/** P4-A（计划 §3.2.2-1）：回复结束自动重试命名——sdk-backend forwardEvent 成功 result 边沿
 *  调用（与 notifySessionCompleted 同点位、同「不阻塞业务」原则），覆盖无渲染层触发者的
 *  桥接回合与「首轮 LLM 失败后用户继续对话」的桌面会话。闸序：会话存在且名源可升级
 *  （slot/first_input）→ 预算未耗尽（attempts < 3）→ 无在飞分析 → 取 DB 首条 user 消息文本
 *  （无/空则放弃）；slot 先落首输入兜底名（桥接会话无渲染层触发者替它调兜底通道），再发起
 *  LLM 升级。任何异常静默——命名失败不影响回合业务。 */
export function maybeRetrySessionNaming(sessionId: string): void {
  try {
    const s = sessionRepo.getSession(sessionId);
    if (!s || !isUpgradableNameSource(s.nameSource)) return;
    if ((topicAttempts.get(sessionId) ?? 0) >= TOPIC_MAX_ATTEMPTS || topicInFlight.has(sessionId)) return;
    const first = messageRepo.getMessagesBySession(sessionId).find((m) => m.role === 'user');
    if (!first || !first.content.trim()) return;
    const text = first.content.trim();
    if (s.nameSource === 'slot') void sessionRepo.setFirstInputFallbackName(sessionId, text);
    void analyzeTopic(sessionId, text);
  } catch {
    /* 命名重试失败静默 */
  }
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
