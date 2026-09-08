// upstream-errors.ts
// 上游（Anthropic 协议网关 / new-api 类中继）错误的统一分类。纯逻辑模块，
// 不依赖 Electron / Vue / SDK。输入可能是三种形态：
//  1. SDK system:api_retry 的短错误码（sdkMsg.error，如 "model_not_found"、"rate_limit"）；
//  2. 上游原始 JSON 错误体（如
//     {"error":{"message":"Model \"glm-5.2\" is not supported ...","type":"model_not_found"}}），
//     常出现在 CLI stderr、连接测试输出或 SDK 异常 message 里；
//  3. 纯文本错误 + 可选 HTTP 状态码。
// 分类决定两件事：是否「重试无意义的确定性错误」（快败）与面向用户的精确文案。

import { isApiErrorAssistantText } from './api-error-text';

export type UpstreamErrorKind =
  | 'model_not_found'
  | 'authentication'
  | 'permission'
  | 'billing'
  | 'invalid_request'
  | 'rate_limit'
  | 'overloaded'
  | 'server_error'
  | 'network'
  | 'reasoning_replay'
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
  'invalid_request',
]);

export function isNonRetryableUpstreamError(kind: UpstreamErrorKind): boolean {
  return NON_RETRYABLE.has(kind);
}

const KIND_BY_CODE: Record<string, UpstreamErrorKind> = {
  model_not_found: 'model_not_found',
  authentication_failed: 'authentication',
  authentication_error: 'authentication',
  // P2-2：OAuth 组织未被授权使用该端点/模型——鉴权类确定性错误，重试无意义。
  oauth_org_not_allowed: 'authentication',
  permission_error: 'permission',
  billing_error: 'billing',
  // P2-2：请求级确定性错误（参数/表单被上游拒绝），重试结果不变，应快败。
  invalid_request: 'invalid_request',
  // N5：输出上限（SDK 错误枚举含此码；api-retry-state 已备「输出上限异常」标签）。
  // 确定性错误——同请求再试结果不变，快败并给出可行动文案，不再烧满重试误报网络中断。
  max_output_tokens: 'invalid_request',
  rate_limit: 'rate_limit',
  overloaded: 'overloaded',
  server_error: 'server_error',
  api_error: 'server_error',
};

// reasoning_replay（2026-08-27 定案）：DeepSeek V4 thinking 模式对带 tools 的多轮请求强制
// 要求回传 assistant 历史 reasoning_content；sub2api（<0.1.178-reasoning-patch）的
// Anthropic→OpenAI 转换桥丢弃 thinking 块导致上游间歇性 400。错误以 assistant 正文
// `API Error: 400 The \`reasoning_content\` in the thinking mode must be passed back
// to the API.` 形态落库。识别三要素：API Error 前缀（复用 api-error-text 的前缀谓词
// 约定，正文中间引用不误伤）+ reasoning_content + passed back 关键词。
export function isReasoningReplayApiError(text: string): boolean {
  if (!isApiErrorAssistantText(text)) return false;
  const lower = text.toLowerCase();
  return lower.includes('reasoning_content') && lower.includes('passed back');
}

// P2-2：g 标志必须——matchAll 要求非全局正则抛错；matchAll 内部克隆正则，无 exec 的 lastIndex 污染。
const TYPE_RE = /"type"\s*:\s*"([a-z_]+)"/g;
const MSG_RE = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/;
// P3-14：要求模型名带**真实引号**的引号串形态——裸子串不捕获（"Model Context Protocol"
// 不误报）；匹配对象是下方反转义后的 detail 而非原始文本，故 `Model \"Context\"` 这类
// 残留转义引号形态不再被 `\\?` 类宽松正则误捕（N 修复轮）。
const MODEL_IN_MSG_RE = /Model\s+"([^"\\]*(?:\\.[^"\\]*)*)"/;
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
  // reasoning_replay 优先于通用 type/状态码推断：其 JSON 里 type=invalid_request_error
  // 会被误归 server/unknown，专用文案与「重试一次有效」语义需要独立 kind。
  if (isReasoningReplayApiError(text)) {
    return { kind: 'reasoning_replay', detail: text.slice(0, 300), modelId: null };
  }
  // P2-2：嵌套形态 {"type":"error","error":{"type":"model_not_found"}} 的外层 "error" 不是
  // 可分类码——matchAll 取第一个命中 KIND_BY_CODE 的 type 值；无命中仍按 unknown 走状态码兜底。
  const typeMatches = [...text.matchAll(TYPE_RE)].map((m) => m[1]);
  const typedKind = typeMatches.find((t) => KIND_BY_CODE[t]) ?? null;
  let kind: UpstreamErrorKind = typedKind ? KIND_BY_CODE[typedKind] : 'unknown';
  if (kind === 'unknown') {
    if (NETWORK_RE.test(text) && typeMatches.length === 0) kind = 'network';
    if (typeof status === 'number') {
      if (status === 404) kind = 'model_not_found';
      else if (status === 401 || status === 403) kind = 'authentication';
      else if (status === 402) kind = 'billing';
      // N5：400 请求级确定性错误（参数/形态被上游拒绝），重试结果不变。
      // reasoning_replay 的 400 前置特例在本块之前已分流，不受影响。
      else if (status === 400) kind = 'invalid_request';
      else if (status === 429) kind = 'rate_limit';
      else if (status === 500 || status === 502 || status === 503 || status === 504) kind = 'server_error';
    }
  }
  const msgMatch = MSG_RE.exec(text);
  // P3-14：捕获组是 JSON 转义原文（含 \" 与 \n 字面），做一次反转义让用户文案可读；
  // 反转义失败（截断/残缺转义）保持原样。
  let detail = msgMatch ? msgMatch[1] : text.slice(0, 300);
  if (msgMatch) {
    try {
      detail = String(JSON.parse(`"${msgMatch[1]}"`)).slice(0, 300);
    } catch {
      /* 原样 */
    }
  }
  // P3-14：MODEL 提取基于反转义后的 detail（真实引号形态）——原始文本里的 `\"`
  // 转义引号残留不再误捕；"model" 字段仍按原始 JSON 文本提取。
  const modelMatch = MODEL_IN_MSG_RE.exec(detail) ?? MODEL_FIELD_RE.exec(text);
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
    case 'invalid_request':
      return `${where}的请求被上游拒绝（invalid_request：请求参数或形态未被接受）。重试不会好转，请核对模型名/请求格式或修正供应商配置。${detail}`;
    case 'reasoning_replay':
      return `${where}的上游要求回传思考内容（reasoning_content 缺失，网关桥接缺陷）。重发一次通常可恢复；反复出现请压缩会话，或改用 Anthropic 直连 / GLM Anthropic 端点。${detail}`;
    default:
      return `${where}请求失败（${c.kind}）。${detail}`;
  }
}
