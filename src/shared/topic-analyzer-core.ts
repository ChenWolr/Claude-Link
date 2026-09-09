// topic-analyzer-core.ts
// 自动命名（topic-analyzer）的纯逻辑层：请求体构造、答卷验收、升档策略。
// 零运行时依赖（契约脚本直接 import 单测；先例 shared/auto-session-name.ts）。
// 背景：GLM-5.2/5.3 等思考型模型会把思考过程泄漏进 text 块且 disabled 报错，
// 唯一安全档位是 Anthropic 协议最小思考预算 1024（2026-09-09 实测 7 模型×2 网关）。

export interface TopicResponseShape {
  content?: Array<{ type: string; text?: string; thinking?: string }>;
  stop_reason?: string;
}

export interface TopicAttemptSpec {
  /** null = 不带 thinking 字段（HTTP 4xx 参数不兼容时的 legacy 重试形态） */
  thinking: { type: 'enabled'; budget_tokens: number } | null;
  maxTokens: number;
}

export type TopicRejectReason =
  | 'stop_not_end_turn'
  | 'no_text'
  | 'empty_text'
  | 'text_duplicates_thinking'
  | 'meta_preamble';

export interface TopicCandidateVerdict {
  ok: boolean;
  topic: string | null;
  reason: 'ok' | TopicRejectReason;
}

/** 首梯 = 协议最小思考预算；二梯 = 升预算。全梯 maxTokens 必须 > budget_tokens（官方约束）。 */
export const TOPIC_ATTEMPT_LADDER: readonly TopicAttemptSpec[] = [
  { thinking: { type: 'enabled', budget_tokens: 1024 }, maxTokens: 2000 },
  { thinking: { type: 'enabled', budget_tokens: 4096 }, maxTokens: 8000 },
];

/** 4xx 参数不兼容重试：不带 thinking 字段（部分网关/模型拒绝该字段时的回落形态）。 */
export const TOPIC_ATTEMPT_LEGACY: TopicAttemptSpec = { thinking: null, maxTokens: 2000 };

/** 提示词模板：必须与修复前逐字相同（只改思考参数，不动提示词语义）。 */
export const TOPIC_PROMPT_PREFIX = '用5个字以内概括以下对话的主题，只输出主题，不要解释：\n\n';

const META_PREAMBLE_PATTERNS: readonly RegExp[] = [
  /^(the user|user wants|user is asking)/i,
  /^(i need to|i should|i will|i'll|i'm going to|let me|we need to|we should)/i,
  /^(用户希望|用户想要|用户要求|我需要|我应该|我会|让我|我们需要|我们应该)/,
];

/**
 * 答卷验收（厂商中立）：stop_reason 必须 end_turn；text 非空；
 * text 与 thinking 块不得重复（实测泄漏形态为逐字/前 40 字符相同）；
 * 主题不得以元语言开场（软判据，兜底保险）。
 */
export function extractTopicCandidate(data: TopicResponseShape): TopicCandidateVerdict {
  if (data.stop_reason !== 'end_turn') {
    return { ok: false, topic: null, reason: 'stop_not_end_turn' };
  }
  const textBlock = (data.content ?? []).find((c) => c.type === 'text');
  if (!textBlock) {
    return { ok: false, topic: null, reason: 'no_text' };
  }
  const textTrim = (textBlock.text ?? '').trim();
  if (!textTrim) {
    return { ok: false, topic: null, reason: 'empty_text' };
  }
  const thinkingTrim = ((data.content ?? []).find((c) => c.type === 'thinking')?.thinking ?? '').trim();
  if (thinkingTrim) {
    const a = textTrim.replace(/\s+/g, ' ');
    const b = thinkingTrim.replace(/\s+/g, ' ');
    if (a === b || a.slice(0, 40) === b.slice(0, 40)) {
      return { ok: false, topic: null, reason: 'text_duplicates_thinking' };
    }
  }
  const topic = textTrim.replace(/\s+/g, ' ').slice(0, 20);
  if (META_PREAMBLE_PATTERNS.some((re) => re.test(topic))) {
    return { ok: false, topic: null, reason: 'meta_preamble' };
  }
  return { ok: true, topic, reason: 'ok' };
}

/** 构造请求体：只含 model/max_tokens/[thinking]/messages，禁止任何厂商方言字段。 */
export function buildTopicRequestBody(model: string, firstMessage: string, spec: TopicAttemptSpec): string {
  const body: Record<string, unknown> = {
    model,
    max_tokens: spec.maxTokens,
    messages: [
      {
        role: 'user',
        content: `${TOPIC_PROMPT_PREFIX}${firstMessage.slice(0, 500)}`,
      },
    ],
  };
  if (spec.thinking) {
    body.thinking = spec.thinking;
  }
  return JSON.stringify(body);
}

export type AttemptFailureKind = 'validation' | 'http_4xx' | 'transport';

/**
 * 升档策略（有界，全流程最多 2 次 HTTP 请求）：
 * - 第一梯答卷被拒 → 二梯升预算 4096；
 * - 第一梯 HTTP 4xx（疑似 thinking 字段不兼容）→ legacy 形态（无 thinking）重试；
 * - 第一梯超时/5xx/网络错误 → 不重试，直达首句兜底；
 * - 第二梯任何失败 → 直达首句兜底。
 */
export function nextAttemptSpec(failedIndex: 0 | 1, kind: AttemptFailureKind): TopicAttemptSpec | null {
  if (failedIndex !== 0) return null;
  if (kind === 'validation') return TOPIC_ATTEMPT_LADDER[1];
  if (kind === 'http_4xx') return TOPIC_ATTEMPT_LEGACY;
  return null;
}
