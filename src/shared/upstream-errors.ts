// upstream-errors.ts
// 上游（Anthropic 协议网关 / new-api 类中继）错误的统一分类。纯逻辑模块，
// 不依赖 Electron / Vue / SDK。输入可能是三种形态：
//  1. SDK system:api_retry 的短错误码（sdkMsg.error，如 "model_not_found"、"rate_limit"）；
//  2. 上游原始 JSON 错误体（如
//     {"error":{"message":"Model \"glm-5.2\" is not supported ...","type":"model_not_found"}}），
//     常出现在 CLI stderr、连接测试输出或 SDK 异常 message 里；
//  3. 纯文本错误 + 可选 HTTP 状态码。
// 分类决定两件事：是否「重试无意义的确定性错误」（快败）与面向用户的精确文案。

export type UpstreamErrorKind =
  | 'model_not_found'
  | 'authentication'
  | 'permission'
  | 'billing'
  | 'rate_limit'
  | 'overloaded'
  | 'server_error'
  | 'network'
  | 'unknown';

export interface UpstreamErrorClassification {
  kind: UpstreamErrorKind;
  /** 从原始 JSON 提取的 message（无则截断的原文）。 */
  detail: string;
  /** 能提取到的模型 ID（如 glm-5.2）。 */
  modelId: string | null;
}

/** 重试无意义的确定性错误：同供应商+模型+凭据再试 N 次结果相同，应当快败并提示切换。 */
const NON_RETRYABLE: ReadonlySet<UpstreamErrorKind> = new Set([
  'model_not_found',
  'authentication',
  'permission',
  'billing',
]);

export function isNonRetryableUpstreamError(kind: UpstreamErrorKind): boolean {
  return NON_RETRYABLE.has(kind);
}

const KIND_BY_CODE: Record<string, UpstreamErrorKind> = {
  model_not_found: 'model_not_found',
  authentication_failed: 'authentication',
  authentication_error: 'authentication',
  permission_error: 'permission',
  billing_error: 'billing',
  rate_limit: 'rate_limit',
  overloaded: 'overloaded',
  server_error: 'server_error',
  api_error: 'server_error',
};

const TYPE_RE = /"type"\s*:\s*"([a-z_]+)"/;
const MSG_RE = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const MODEL_IN_MSG_RE = /Model\s+\\"?([\w.\-]+)\\"?/;
const MODEL_FIELD_RE = /"model"\s*:\s*"([\w.\-]+)"/;
const NETWORK_RE = /ECONN|ETIMEDOUT|timed?\s*out|fetch failed|network|socket hang up/i;

export function classifyUpstreamError(
  raw: string | null | undefined,
  status?: number | null,
): UpstreamErrorClassification {
  const text = (raw ?? '').trim();
  if (!text && (status === null || status === undefined)) {
    return { kind: 'network', detail: '', modelId: null };
  }
  if (KIND_BY_CODE[text]) {
    return { kind: KIND_BY_CODE[text], detail: '', modelId: null };
  }
  const typeMatch = TYPE_RE.exec(text);
  let kind: UpstreamErrorKind = typeMatch ? (KIND_BY_CODE[typeMatch[1]] ?? 'unknown') : 'unknown';
  if (kind === 'unknown') {
    if (NETWORK_RE.test(text) && !typeMatch) kind = 'network';
    if (typeof status === 'number') {
      if (status === 404) kind = 'model_not_found';
      else if (status === 401 || status === 403) kind = 'authentication';
      else if (status === 402) kind = 'billing';
      else if (status === 429) kind = 'rate_limit';
      else if (status === 500 || status === 502 || status === 503 || status === 504) kind = 'server_error';
    }
  }
  const msgMatch = MSG_RE.exec(text);
  const detail = msgMatch ? msgMatch[1] : text.slice(0, 300);
  const modelMatch = MODEL_IN_MSG_RE.exec(text) ?? MODEL_FIELD_RE.exec(text);
  return { kind, detail, modelId: modelMatch ? modelMatch[1] : null };
}

/** 确定性上游错误的用户文案：供应商 + 模型 + 原因 + 行动建议。会话快败与连接测试共用。 */
export function upstreamFatalMessage(
  c: UpstreamErrorClassification,
  providerName: string | null,
  modelId: string | null,
): string {
  const where = providerName ? `供应商「${providerName}」` : '当前供应商';
  const model = modelId || c.modelId || '';
  const modelText = model ? `模型 ${model}` : '所请求的模型';
  const detail = c.detail ? `上游原文：${c.detail}` : '';
  switch (c.kind) {
    case 'model_not_found':
      return `${where}的访问令牌不支持${modelText}（model_not_found：令牌分组内没有可服务该模型的渠道）。重试不会好转，请更换模型或修正供应商配置。${detail}`;
    case 'authentication':
      return `${where}鉴权失败：API Key 无效或已过期。请到「连接」页核对 Key。${detail}`;
    case 'permission':
      return `${where}的 Key 无权访问${modelText}（permission_error）。请核对令牌权限。${detail}`;
    case 'billing':
      return `${where}账户计费异常（余额不足或额度到期）。请到供应商侧处理后再试。${detail}`;
    default:
      return `${where}请求失败（${c.kind}）。${detail}`;
  }
}
