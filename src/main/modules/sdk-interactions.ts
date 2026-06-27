import { randomUUID } from 'crypto';
import type { BrowserWindow } from 'electron';
import type { InteractionFormField, InteractionPromptOption, InteractionPromptPayload, InteractionPromptPreview, InteractionPromptQuestion, InteractionPromptResponsePayload } from '../../shared/types/ipc';
import { requestInteraction } from './interaction-prompts';

export const OTHER_INTERACTION_OPTION_ID = '__other__';
export const SUPPORTED_USER_DIALOG_KINDS = [
  'ask_user_question',
  'AskUserQuestion',
  'user_question',
  'askUserQuestion',
  'plan_mode',
  'planMode',
  'choice',
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
  updatedPermissions?: unknown[];
  toolUseID?: string;
} | {
  behavior: 'deny';
  message: string;
  interrupt?: boolean;
  toolUseID?: string;
};

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
  const askPayload = isAskUserQuestionPayload(input) ? buildAskUserQuestionInteractionPayload(sessionId, input.questions[0], 0, options.toolUseID, requestId) : null;
  if (askPayload) return askPayload;

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
    suggestions: options.suggestions,
    defaultOptionIds: ['allow'],
    options: [
      { id: 'allow', label: '允许本次', description: '只允许当前这一次工具调用。', primary: true },
      ...(options.suggestions?.length
        ? [{ id: 'allow-session', label: '本会话总是允许', description: '接受 Claude Code 给出的会话级权限建议。' }]
        : []),
      { id: 'deny', label: '拒绝', description: '拒绝当前工具调用，并把原因反馈给 Claude。', danger: true },
    ],
  };
}

export function mapPermissionInteractionResponse(
  payload: InteractionPromptPayload,
  response: InteractionPromptResponsePayload,
): PermissionResult {
  const selectedId = response.action === 'submit' ? response.selectedOptionIds?.[0] : undefined;
  if (selectedId === 'allow') {
    return { behavior: 'allow', toolUseID: payload.toolUseId };
  }
  if (selectedId === 'allow-session') {
    return { behavior: 'allow', updatedPermissions: payload.suggestions, toolUseID: payload.toolUseId };
  }
  return { behavior: 'deny', message: '用户拒绝了该工具调用', toolUseID: payload.toolUseId };
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
  return [`option-${recommendedIndex >= 0 ? recommendedIndex : 0}`];
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
    || request.dialogKind === 'choice';
}

function isOptionList(value: unknown): value is AskUserQuestionOption[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((option) => Boolean(option)
      && typeof option === 'object'
      && typeof (option as Record<string, unknown>).label === 'string');
}

function fieldsFromJsonSchema(schema: Record<string, unknown> | undefined): InteractionFormField[] {
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  const required = Array.isArray(schema?.required) ? new Set(schema.required.filter((item): item is string => typeof item === 'string')) : new Set<string>();
  return Object.entries(properties as Record<string, Record<string, unknown>>).map(([id, spec]) => {
    const enumValues = Array.isArray(spec.enum) ? spec.enum.filter((item): item is string => typeof item === 'string') : [];
    const type = enumValues.length ? 'select' : spec.type === 'boolean' ? 'checkbox' : spec.format === 'textarea' ? 'textarea' : 'text';
    return {
      id,
      label: typeof spec.title === 'string' ? spec.title : id,
      type,
      required: required.has(id),
      placeholder: typeof spec.description === 'string' ? spec.description : undefined,
      options: enumValues.map((value) => ({ id: value, label: value })),
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

export function dialogResultFromInteraction(response: InteractionPromptResponsePayload): unknown {
  if (response.fieldValues) return response.fieldValues;
  if (response.otherText) return { response: response.otherText };
  return { acknowledged: true };
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

export async function requestAskUserQuestionInteractions(
  sessionId: string,
  mainWindow: BrowserWindow,
  input: AskUserQuestionPayload,
  options: { signal: AbortSignal; toolUseID?: string },
): Promise<AskUserQuestionOutput | null> {
  if (!isAskUserQuestionPayload(input)) return null;

  if (input.questions.length > 1) {
    const payload = buildWizardAskUserQuestionPayload(sessionId, input.questions, options.toolUseID);
    const response = await requestInteraction(mainWindow, payload, options.signal);
    if (response.action === 'cancel') return null;
    return buildAskUserQuestionResult(input.questions, [{ payload, response }]);
  }

  const question = input.questions[0];
  const payload = buildAskUserQuestionInteractionPayload(sessionId, question, 0, options.toolUseID);
  const response = await requestInteraction(mainWindow, payload, options.signal);
  if (response.action === 'cancel') return null;
  return buildAskUserQuestionResult(input.questions, [{ payload, response }]);
}

export function createElicitationHandler(sessionId: string, mainWindow: BrowserWindow) {
  return async (request: ElicitationRequest, options: UserDialogOptions): Promise<ElicitationResult> => {
    const payload = buildGenericInteractionPayload(sessionId, 'elicitation', {
      title: request.title ?? request.displayName,
      message: request.message,
      description: request.description,
      requestedSchema: request.requestedSchema,
      inputType: request.mode === 'form' ? 'form' : 'text',
    }, request.elicitationId);
    const response = await requestInteraction(mainWindow, payload, options.signal);
    if (response.action !== 'submit') return { action: 'cancel' };
    return {
      action: 'accept',
      content: (response.fieldValues ?? (response.otherText ? { response: response.otherText } : {})) as Record<string, string | number | boolean | string[]>,
    };
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
        ? { behavior: 'completed', result: dialogResultFromInteraction(response) }
        : { behavior: 'cancelled' };
    }

    const result = await requestAskUserQuestionInteractions(sessionId, mainWindow, { questions }, {
      signal: options.signal,
      toolUseID: request.toolUseID,
    });
    return result
      ? { behavior: 'completed', result }
      : { behavior: 'cancelled' };
  };
}
