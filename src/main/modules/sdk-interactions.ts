import { randomUUID } from 'crypto';
import type { BrowserWindow } from 'electron';
import type { InteractionFormField, InteractionPromptOption, InteractionPromptPayload, InteractionPromptPreview, InteractionPromptQuestion, InteractionPromptResponsePayload } from '../../shared/types/ipc';
import { requestInteraction } from './interaction-prompts';
import { coercePermissionUpdatesToSession, withToolSessionAllow, type PermissionUpdate } from './sdk-permissions';

export const OTHER_INTERACTION_OPTION_ID = '__other__';
export const SUPPORTED_USER_DIALOG_KINDS = [
  'ask_user_question',
  'AskUserQuestion',
  'user_question',
  'askUserQuestion',
  'plan_mode',
  'planMode',
  'choice',
  // H3：SDK 文档明示的真实 dialog_kind（权限拒答回退对话框）。其余值为历史猜测，待真机抓完整列表后清理。
  'refusal_fallback_prompt',
] as const;

export const VIRTUAL_OPTION_THRESHOLD = 60;

export interface InteractionHistoryEntry {
  promptId: string;
  sessionId: string;
  kind: InteractionPromptPayload['kind'];
  title: string;
  action: InteractionPromptResponsePayload['action'];
  selectedOptionIds?: string[];
  questionAnswers?: InteractionPromptResponsePayload['questionAnswers'];
  fieldValues?: InteractionPromptResponsePayload['fieldValues'];
  otherText?: string;
}

export type PermissionResult = {
  behavior: 'allow';
  updatedInput?: Record<string, unknown>;
  // L2/L3：SDK 的 PermissionUpdate 联合（addRules/replaceRules/removeRules/setMode/addDirectories/removeDirectories）。
  // 这里用宽松记录类型承载。allow-session 场景 claude-link 会构造规则：withToolSessionAllow 在 SDK
  // suggestions 之外补一条本工具裸 allow（addRules, destination:'session'），供 CLI 会话内放行与
  // isToolSessionAllowed 本地短路匹配；其余 suggestions 仅做 destination:'session' 改写后透传。
  updatedPermissions?: PermissionUpdate[];
  toolUseID?: string;
} | {
  behavior: 'deny';
  message: string;
  interrupt?: boolean;
  toolUseID?: string;
};

export type { PermissionUpdate };

export type CanUseToolOptions = {
  signal: AbortSignal;
  suggestions?: unknown[];
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  toolUseID: string;
  agentID?: string;
};

export type UserDialogRequest = {
  dialogKind: string;
  payload: Record<string, unknown>;
  toolUseID?: string;
};

export type UserDialogResult = {
  behavior: 'completed';
  result: unknown;
} | {
  behavior: 'cancelled';
};

export type UserDialogOptions = {
  signal: AbortSignal;
};

export type ElicitationRequest = {
  serverName: string;
  message: string;
  mode?: 'form' | 'url';
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
};

export type ElicitationResult = {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, string | number | boolean | string[]>;
};

export type AskUserQuestionOption = {
  label: string;
  description?: string;
  preview?: string;
};

export type AskUserQuestion = {
  question: string;
  header?: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
};

export type AskUserQuestionPayload = {
  questions?: AskUserQuestion[];
};

type GenericChoicePayload = {
  title?: string;
  question?: string;
  message?: string;
  description?: string;
  options?: AskUserQuestionOption[];
  choices?: AskUserQuestionOption[];
  multiSelect?: boolean;
  inputType?: 'text' | 'long-text' | 'form';
  multiline?: boolean;
  fields?: InteractionFormField[];
  schema?: Record<string, unknown>;
  requestedSchema?: Record<string, unknown>;
};

export interface AskUserQuestionInteractionAnswer {
  payload: InteractionPromptPayload;
  response: InteractionPromptResponsePayload;
}

export interface AskUserQuestionOutput {
  questions: AskUserQuestion[];
  answers: Record<string, string>;
  response?: string;
  annotations?: Record<string, { preview?: string; notes?: string }>;
}

export function normalizeInteractionPreview(
  preview: string | InteractionPromptPreview | undefined,
  fallbackType: InteractionPromptPreview['type'] = 'text',
): InteractionPromptPreview | undefined {
  if (!preview) return undefined;
  if (typeof preview === 'string') return { type: fallbackType, content: preview };
  if (preview.type === 'table') {
    return { type: 'table', headers: preview.headers ?? [], rows: preview.rows ?? [] };
  }
  return {
    type: preview.type,
    content: preview.content ?? '',
    ...(preview.language ? { language: preview.language } : {}),
  };
}

export function shouldUseVirtualOptions(options: InteractionPromptOption[]): boolean {
  return options.length >= VIRTUAL_OPTION_THRESHOLD;
}

export function interactionHistoryEntryFromResponse(
  payload: InteractionPromptPayload,
  response: InteractionPromptResponsePayload,
): InteractionHistoryEntry {
  return {
    promptId: payload.id,
    sessionId: payload.sessionId,
    kind: payload.kind,
    title: payload.title,
    action: response.action,
    selectedOptionIds: response.selectedOptionIds,
    questionAnswers: response.questionAnswers,
    fieldValues: response.fieldValues,
    otherText: response.otherText,
  };
}

export function buildPermissionTitle(
  toolName: string,
  input: Record<string, unknown>,
  options: CanUseToolOptions,
): string {
  if (options.title) return options.title;
  const displayName = options.displayName || toolName;
  const target = typeof input.file_path === 'string'
    ? input.file_path
    : typeof input.path === 'string'
      ? input.path
      : typeof input.command === 'string'
        ? input.command
        : '';
  return target ? `Claude 想要执行 ${displayName}：${target}` : `Claude 想要执行 ${displayName}`;
}

export function buildPermissionInteractionPayload(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  options: CanUseToolOptions,
  requestId = randomUUID(),
): InteractionPromptPayload {
  const askPayload = isAskUserQuestionPayload(input) && input.questions?.[0]
    ? buildAskUserQuestionInteractionPayload(sessionId, input.questions[0], 0, options.toolUseID, requestId)
    : null;
  if (askPayload) return askPayload;

  const sessionSuggestions = withToolSessionAllow(toolName, options.suggestions);

  return {
    id: requestId,
    sessionId,
    kind: 'permission',
    source: 'Claude Code',
    toolName,
    toolUseId: options.toolUseID,
    title: buildPermissionTitle(toolName, input, options),
    description: options.description || options.decisionReason,
    input,
    suggestions: sessionSuggestions,
    defaultOptionIds: [],
    options: [
      { id: 'allow', label: '允许本次', description: '只允许当前这一次工具调用。', primary: true },
      ...(sessionSuggestions.length
        ? [{ id: 'allow-session', label: '本会话总是允许', description: '接受 Claude Code 给出的会话级权限建议。' }]
        : []),
      { id: 'deny', label: '拒绝', description: '拒绝当前工具调用，并把原因反馈给 Claude。', danger: true },
    ],
  };
}

export function mapPermissionInteractionResponse(
  payload: InteractionPromptPayload,
  response: InteractionPromptResponsePayload,
  input: Record<string, unknown>,
): PermissionResult {
  const selectedId = response.action === 'submit' ? response.selectedOptionIds?.[0] : undefined;
  if (selectedId === 'allow') {
    // P0：allow 必须回传 updatedInput（原样 input），否则 SDK 运行时 ZodError 阻断所有工具。
    return { behavior: 'allow', updatedInput: input, toolUseID: payload.toolUseId };
  }
  if (selectedId === 'allow-session') {
    return { behavior: 'allow', updatedInput: input, updatedPermissions: coercePermissionUpdatesToSession(payload.suggestions), toolUseID: payload.toolUseId };
  }
  // cancel 路径按来源分映（见 plan-v1 §3.2 / §5 阶段1）：
  //   reason:'user'  —— 用户主动拒绝（Esc/拒绝按钮），记成 deny「用户拒绝」语义正确。
  //   reason:'abort' / 缺省 —— signal abort/窗口关闭/会话删除/IPC 失败等系统取消，**不是用户意图**。
  // SDK 的 PermissionResult 只有 allow/deny，工具未获授权只能 deny；但 message 必须中性——
  // 否则 CLI 把这条 tool_result(is_error) 记入 transcript，下一回合 resume 时模型读到「用户拒绝」，
  // 会认定用户拒绝过该工具，本会话后续不再调用（并发误 deny 根因）。缺省按中性处理（防御性不指控用户）。
  if (response.reason === 'user') {
    return { behavior: 'deny', message: '用户拒绝了该工具调用', toolUseID: payload.toolUseId };
  }
  return { behavior: 'deny', message: '工具调用已取消', toolUseID: payload.toolUseId };
}

export function isAskUserQuestionPayload(payload: Record<string, unknown>): payload is AskUserQuestionPayload {
  const questions = payload.questions;
  if (!Array.isArray(questions) || questions.length === 0) return false;
  return questions.every((question) => {
    if (!question || typeof question !== 'object') return false;
    const candidate = question as Record<string, unknown>;
    const options = candidate.options;
    return typeof candidate.question === 'string'
      && Array.isArray(options)
      && options.length > 0
      && options.every((option) => Boolean(option)
        && typeof option === 'object'
        && typeof (option as Record<string, unknown>).label === 'string');
  });
}

function findDefaultOptionId(question: AskUserQuestion): string[] {
  if (question.multiSelect) return [];
  const recommendedIndex = question.options.findIndex((option) => /recommended|推荐/i.test(option.label));
  return recommendedIndex >= 0 ? [`option-${recommendedIndex}`] : [];
}

function interactionOptionsFromQuestion(question: AskUserQuestion): InteractionPromptOption[] {
  return [
    ...question.options.map((option, optionIndex) => ({
      id: `option-${optionIndex}`,
      label: option.label,
      description: option.description,
      preview: option.preview,
      value: option.label,
    })),
    {
      id: OTHER_INTERACTION_OPTION_ID,
      label: 'Other',
      description: '输入自定义答案。',
    },
  ];
}

function buildPresentation(overrides: Partial<NonNullable<InteractionPromptPayload['presentation']>> = {}, hasPreview = false): InteractionPromptPayload['presentation'] {
  return {
    layout: hasPreview ? 'sidebar' : 'dialog',
    density: 'default',
    size: hasPreview ? 'xl' : 'md',
    showPreview: hasPreview || undefined,
    ...overrides,
  };
}

export function buildAskUserQuestionInteractionPayload(
  sessionId: string,
  question: AskUserQuestion,
  index: number,
  toolUseId?: string,
  requestId = randomUUID(),
): InteractionPromptPayload {
  const options = interactionOptionsFromQuestion(question);
  return {
    id: requestId,
    sessionId,
    kind: question.multiSelect ? 'multi-choice' : 'single-choice',
    source: question.header || 'Question',
    toolName: 'AskUserQuestion',
    toolUseId,
    title: question.question,
    description: question.multiSelect ? '可选择多个选项，按 Space 切换选择，Enter 提交。' : '请选择一个选项，按 Enter 提交。',
    multiSelect: Boolean(question.multiSelect),
    allowOther: true,
    otherLabel: 'Other',
    defaultOptionIds: findDefaultOptionId(question),
    input: { questionIndex: index, question },
    options,
    presentation: buildPresentation({ size: options.some((option) => option.preview) ? 'xl' : 'md' }, options.some((option) => option.preview)),
  };
}

export function buildWizardAskUserQuestionPayload(
  sessionId: string,
  questions: AskUserQuestion[],
  toolUseId?: string,
  requestId = randomUUID(),
): InteractionPromptPayload {
  return {
    id: requestId,
    sessionId,
    kind: 'form',
    source: 'AskUserQuestion',
    toolName: 'AskUserQuestion',
    toolUseId,
    title: questions.length > 1 ? `Claude Code 需要你回答 ${questions.length} 个问题` : questions[0]?.question ?? 'Claude Code 需要你选择',
    description: '逐题选择，可返回上一步修改答案，最后一次性提交。',
    input: { questions },
    questions: questions.map((question, index): InteractionPromptQuestion => ({
      id: `q${index}`,
      title: question.question,
      source: question.header || `Q${index + 1}`,
      options: interactionOptionsFromQuestion(question),
      multiSelect: Boolean(question.multiSelect),
      allowOther: true,
      otherLabel: 'Other',
      defaultOptionIds: findDefaultOptionId(question),
    })),
  };
}

function answerFromSelection(question: AskUserQuestion, selectedIds: string[] = [], otherText?: string): string {
  const labels = selectedIds
    .filter((id) => id !== OTHER_INTERACTION_OPTION_ID)
    .map((id) => {
      const match = /^option-(\d+)$/.exec(id);
      if (!match) return null;
      return question.options[Number(match[1])]?.label ?? null;
    })
    .filter((label): label is string => Boolean(label));
  const other = selectedIds.includes(OTHER_INTERACTION_OPTION_ID) ? otherText?.trim() : undefined;
  if (other) labels.push(other);
  return labels.join(', ');
}

function answerFromInteraction(question: AskUserQuestion, response: InteractionPromptResponsePayload, questionId?: string): string {
  if (response.action !== 'submit') return '';
  const answer = questionId ? response.questionAnswers?.[questionId] : undefined;
  return answerFromSelection(question, answer?.selectedOptionIds ?? response.selectedOptionIds ?? [], answer?.otherText ?? response.otherText);
}

function previewFromInteraction(question: AskUserQuestion, response: InteractionPromptResponsePayload, questionId?: string): string | undefined {
  const answer = questionId ? response.questionAnswers?.[questionId] : undefined;
  const selectedId = (answer?.selectedOptionIds ?? response.selectedOptionIds)?.find((id) => id !== OTHER_INTERACTION_OPTION_ID);
  const match = selectedId ? /^option-(\d+)$/.exec(selectedId) : null;
  if (!match) return undefined;
  return question.options[Number(match[1])]?.preview;
}

export function buildAskUserQuestionResult(
  questions: AskUserQuestion[],
  answers: AskUserQuestionInteractionAnswer[],
): AskUserQuestionOutput {
  const result: AskUserQuestionOutput = {
    questions,
    answers: {},
  };
  const annotations: Record<string, { preview?: string; notes?: string }> = {};

  for (let index = 0; index < questions.length; index++) {
    const question = questions[index];
    const item = answers[index] ?? answers[0];
    const questionId = item?.payload.questions?.[index]?.id;
    const answer = item ? answerFromInteraction(question, item.response, questionId) : '';
    result.answers[question.question] = answer;

    const questionAnswer = questionId ? item?.response.questionAnswers?.[questionId] : undefined;
    if ((questionAnswer?.selectedOptionIds ?? item?.response.selectedOptionIds)?.includes(OTHER_INTERACTION_OPTION_ID)) {
      const other = questionAnswer?.otherText?.trim() ?? item?.response.otherText?.trim();
      if (other) result.response = other;
    }

    const preview = item ? previewFromInteraction(question, item.response, questionId) : undefined;
    if (preview) {
      annotations[question.question] = { preview };
    }
  }

  if (Object.keys(annotations).length > 0) {
    result.annotations = annotations;
  }
  return result;
}

export function canRenderUserDialog(request: UserDialogRequest): boolean {
  if (isAskUserQuestionPayload(request.payload)) return true;
  return request.dialogKind === 'ask_user_question'
    || request.dialogKind === 'AskUserQuestion'
    || request.dialogKind === 'user_question'
    || request.dialogKind === 'askUserQuestion'
    || request.dialogKind === 'plan_mode'
    || request.dialogKind === 'planMode'
    || request.dialogKind === 'choice'
    || request.dialogKind === 'refusal_fallback_prompt';
}

function isOptionList(value: unknown): value is AskUserQuestionOption[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((option) => Boolean(option)
      && typeof option === 'object'
      && typeof (option as Record<string, unknown>).label === 'string');
}

/** G2：JSON schema → 表单字段。number/integer → 数值输入（numeric 标记；Vue 对 type="number"
 *  的 v-model 自动 looseToNumber——可解析时已是 number、不可解析保留 string，提交侧
 *  dialogResultFromInteraction 对 string/number 双向兜底统一为数值）；array → textarea；
 *  数值 enum 保序透传为 select（String 化选项、numeric 标记）；字符串 enum / boolean 行为不变。 */
export function fieldsFromJsonSchema(schema: Record<string, unknown> | undefined): InteractionFormField[] {
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  const required = Array.isArray(schema?.required) ? new Set(schema.required.filter((item): item is string => typeof item === 'string')) : new Set<string>();
  return Object.entries(properties as Record<string, Record<string, unknown>>).map(([id, spec]) => {
    const rawEnum = Array.isArray(spec.enum) ? spec.enum : [];
    const enumHasValues = rawEnum.length > 0;
    const numericEnum = enumHasValues && rawEnum.every((item) => typeof item === 'number');
    const isNumeric = numericEnum || spec.type === 'number' || spec.type === 'integer';
    const type: InteractionFormField['type'] = enumHasValues
      ? 'select'
      : spec.type === 'boolean'
        ? 'checkbox'
        : isNumeric
          ? 'number'
          : spec.format === 'textarea' || spec.type === 'array'
            ? 'textarea'
            : 'text';
    return {
      id,
      label: typeof spec.title === 'string' ? spec.title : id,
      type,
      required: required.has(id),
      placeholder: typeof spec.description === 'string' ? spec.description : undefined,
      // G2：enum 全量保序透传（数值 enum 不再被字符串过滤清空）；数值 enum 的选项经
      // String 化渲染、提交侧按 numeric 标记转回数值。
      options: rawEnum.map((value) => ({ id: String(value), label: String(value) })),
      numeric: isNumeric || undefined,
    } satisfies InteractionFormField;
  });
}

export function buildGenericInteractionPayload(
  sessionId: string,
  dialogKind: string,
  payload: Record<string, unknown>,
  toolUseId?: string,
): InteractionPromptPayload {
  const candidate = payload as GenericChoicePayload;
  const title = typeof candidate.title === 'string'
    ? candidate.title
    : typeof candidate.question === 'string'
      ? candidate.question
      : typeof candidate.message === 'string'
        ? candidate.message
        : `Claude Code 请求交互：${dialogKind}`;
  const description = typeof candidate.description === 'string'
    ? candidate.description
    : typeof candidate.message === 'string' && candidate.message !== title
      ? candidate.message
      : undefined;
  const fields = candidate.fields?.length ? candidate.fields : fieldsFromJsonSchema(candidate.requestedSchema ?? candidate.schema);
  const kind = fields.length ? 'form' : candidate.inputType === 'long-text' || candidate.multiline ? 'long-text' : candidate.inputType === 'text' ? 'text' : 'confirm';
  return {
    id: randomUUID(),
    sessionId,
    kind,
    source: dialogKind,
    toolName: dialogKind,
    toolUseId,
    title,
    description,
    fields: fields.length ? fields : undefined,
    options: kind === 'confirm' ? [{ id: 'confirm', label: '确认', description: '继续当前流程。', primary: true }] : undefined,
    defaultOptionIds: kind === 'confirm' ? ['confirm'] : undefined,
    input: payload,
    presentation: buildPresentation({ size: fields.length ? 'lg' : 'md', showPreview: false }),
  };
}

/** G2：表单提交结果 → SDK 返回值。numeric 字段（number/integer、数值 enum select）到达时可能
 *  已是 number（Vue 对 type="number" 的 v-model 自动转），也可能仍是 string（不可解析输入），
 *  这里对 string 转回数值、number 原样放行；空串/非有限数值保持原样（校验层兜底）。 */
export function dialogResultFromInteraction(
  response: InteractionPromptResponsePayload,
  payload?: InteractionPromptPayload,
): unknown {
  if (response.fieldValues) {
    const numericIds = new Set(
      (payload?.fields ?? [])
        .filter((field) => field.numeric || field.type === 'number')
        .map((field) => field.id),
    );
    if (numericIds.size === 0) return response.fieldValues;
    const converted: Record<string, unknown> = { ...response.fieldValues };
    for (const [key, value] of Object.entries(converted)) {
      if (!numericIds.has(key) || typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed !== '' && Number.isFinite(Number(trimmed))) converted[key] = Number(trimmed);
    }
    return converted;
  }
  if (response.otherText) return { response: response.otherText };
  return { acknowledged: true };
}

// M4：把 ElicitationRequest 构造成交互 payload。url 模式（浏览器认证）SDK 不带 schema，
// 不回落成文本输入（那会让用户无处完成认证），改成一个纯确认框。注意：URL 仅存于 input.url，
// 当前 confirm 弹窗不渲染 input（InteractionDetails 仅 permission kind 显示），用户无法从弹窗
// 复制 URL，只能依赖 description/message 文本；若要在弹窗内展示可复制 URL，需为 confirm kind
// 增加 input.url 渲染。用户完成 OAuth 后回来点确认。form/text 走通用表单/文本。
//
// 注意：SDK 真实的 url-elicit 完成信号是 elicitation_complete 事件；claude-link 目前简化为
// 「用户点确认即视为完成」（resolve OnElicitation Promise 为 accept）。这是有意的 UX 兜底，
// 未来可改为监听 elicitation_complete 再 resolve。
export function buildElicitationInteractionPayload(
  sessionId: string,
  request: ElicitationRequest,
  requestId = randomUUID(),
): InteractionPromptPayload {
  if (request.mode === 'url' && typeof request.url === 'string') {
    return {
      id: requestId,
      sessionId,
      kind: 'confirm',
      source: 'elicitation',
      toolName: 'elicitation',
      toolUseId: request.elicitationId,
      title: request.title ?? request.displayName ?? `${request.serverName} 请求授权`,
      description: request.description ?? request.message ?? '请在浏览器完成授权后，回到此处确认。',
      input: { url: request.url, mode: 'url', serverName: request.serverName },
      options: [
        { id: 'confirm', label: '已在浏览器完成授权', description: '确认已在外部浏览器完成 OAuth 授权。', primary: true },
      ],
      defaultOptionIds: ['confirm'],
      presentation: buildPresentation({ size: 'md', showPreview: false }),
    };
  }

  return buildGenericInteractionPayload(sessionId, 'elicitation', {
    title: request.title ?? request.displayName,
    message: request.message,
    description: request.description,
    requestedSchema: request.requestedSchema,
    inputType: request.mode === 'form' ? 'form' : 'text',
  }, request.elicitationId);
}

// M3：onElicitation 非 submit → cancel（关闭/中断）。submit → accept（带 content）。
// 注意：SDK 的 OnElicitation 支持返回 decline（明确拒绝，区别于 cancel 中断），但 SDK 的
// ElicitationRequest 不带「是否可拒绝」信号，claude-link 的交互弹窗也无「拒绝」按钮，故
// 当前一律把非 submit 映射为 cancel。若将来 UI 增加「拒绝」按钮，先为此函数补一个先失败
// 的测试（declineable 分支），再放开语义——避免测不可达分支。
export function elicitationResultFromInteraction(
  response: InteractionPromptResponsePayload,
): ElicitationResult {
  if (response.action === 'submit') {
    return {
      action: 'accept',
      content: (response.fieldValues ?? (response.otherText ? { response: response.otherText } : {})) as Record<string, string | number | boolean | string[]>,
    };
  }
  return { action: 'cancel' };
}

function buildGenericChoiceQuestion(payload: Record<string, unknown>): AskUserQuestion | null {
  const candidate = payload as GenericChoicePayload;
  const options = isOptionList(candidate.options) ? candidate.options : isOptionList(candidate.choices) ? candidate.choices : null;
  const question = typeof candidate.question === 'string'
    ? candidate.question
    : typeof candidate.title === 'string'
      ? candidate.title
      : typeof candidate.message === 'string'
        ? candidate.message
        : typeof candidate.description === 'string'
          ? candidate.description
          : null;
  if (!question || !options) return null;
  return {
    question,
    header: typeof candidate.title === 'string' ? candidate.title.slice(0, 12) : 'Choice',
    options,
    multiSelect: Boolean(candidate.multiSelect),
  };
}

/** P2-7：AskUserQuestion 请求结果——回答成功携带 SDK 输出；取消携带来源 reason（文案分映见
 * shared/interaction-cancel.mapAskUserQuestionCancel）。 */
export type AskUserQuestionOutcome =
  | { kind: 'answered'; result: AskUserQuestionOutput }
  | { kind: 'cancel'; reason?: 'user' | 'abort' };

export async function requestAskUserQuestionInteractions(
  sessionId: string,
  mainWindow: BrowserWindow,
  input: AskUserQuestionPayload,
  options: { signal: AbortSignal; toolUseID?: string },
): Promise<AskUserQuestionOutcome> {
  if (!isAskUserQuestionPayload(input) || !input.questions?.length) {
    return { kind: 'cancel', reason: 'abort' };
  }
  const questions = input.questions;

  if (questions.length > 1) {
    const payload = buildWizardAskUserQuestionPayload(sessionId, questions, options.toolUseID);
    const response = await requestInteraction(mainWindow, payload, options.signal);
    // P2-7：cancel 透传 reason，deny 文案由 backend 按 mapAskUserQuestionCancel 分映。
    if (response.action === 'cancel') return { kind: 'cancel', reason: response.reason };
    return { kind: 'answered', result: buildAskUserQuestionResult(questions, [{ payload, response }]) };
  }

  const question = questions[0];
  const payload = buildAskUserQuestionInteractionPayload(sessionId, question, 0, options.toolUseID);
  const response = await requestInteraction(mainWindow, payload, options.signal);
  if (response.action === 'cancel') return { kind: 'cancel', reason: response.reason };
  return { kind: 'answered', result: buildAskUserQuestionResult(questions, [{ payload, response }]) };
}

export function createElicitationHandler(sessionId: string, mainWindow: BrowserWindow) {
  return async (request: ElicitationRequest, options: UserDialogOptions): Promise<ElicitationResult> => {
    const payload = buildElicitationInteractionPayload(sessionId, request);
    const response = await requestInteraction(mainWindow, payload, options.signal);
    return elicitationResultFromInteraction(response);
  };
}

export function createUserDialogHandler(sessionId: string, mainWindow: BrowserWindow) {
  return async (request: UserDialogRequest, options: UserDialogOptions): Promise<UserDialogResult> => {
    const questions = isAskUserQuestionPayload(request.payload)
      ? request.payload.questions
      : buildGenericChoiceQuestion(request.payload)
        ? [buildGenericChoiceQuestion(request.payload) as AskUserQuestion]
        : null;

    if (!questions) {
      const payload = buildGenericInteractionPayload(sessionId, request.dialogKind, request.payload, request.toolUseID);
      const response = await requestInteraction(mainWindow, payload, options.signal);
      return response.action === 'submit'
        ? { behavior: 'completed', result: dialogResultFromInteraction(response, payload) }
        : { behavior: 'cancelled' };
    }

    const result = await requestAskUserQuestionInteractions(sessionId, mainWindow, { questions }, {
      signal: options.signal,
      toolUseID: request.toolUseID,
    });
    // N8：按 kind 分映（P2-7 只修了 canUseTool 路径，此处为同族漏修分支）——
    // answered→completed 携带输出本体；cancel→cancelled（SDK 该路径无文案字段，中性取消
    // 语义与 shared/interaction-cancel.mapAskUserQuestionCancel 同源：不再把 {kind:'cancel'}
    // 杂质对象伪装成「已完成结果」喂给 SDK/transcript）。
    if (result.kind === 'answered') {
      return { behavior: 'completed', result: result.result };
    }
    return { behavior: 'cancelled' };
  };
}
