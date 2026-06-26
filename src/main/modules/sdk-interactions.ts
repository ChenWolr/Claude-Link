import { randomUUID } from 'crypto';
import type { BrowserWindow } from 'electron';
import type { InteractionPromptPayload, InteractionPromptResponsePayload } from '../../shared/types/ipc';
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

export function buildAskUserQuestionInteractionPayload(
  sessionId: string,
  question: AskUserQuestion,
  index: number,
  toolUseId?: string,
  requestId = randomUUID(),
): InteractionPromptPayload {
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
    options: [
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
    ],
  };
}

function answerFromInteraction(question: AskUserQuestion, response: InteractionPromptResponsePayload): string {
  if (response.action !== 'submit') return '';
  const selectedIds = response.selectedOptionIds ?? [];
  const labels = selectedIds
    .filter((id) => id !== OTHER_INTERACTION_OPTION_ID)
    .map((id) => {
      const match = /^option-(\d+)$/.exec(id);
      if (!match) return null;
      return question.options[Number(match[1])]?.label ?? null;
    })
    .filter((label): label is string => Boolean(label));
  const other = selectedIds.includes(OTHER_INTERACTION_OPTION_ID) ? response.otherText?.trim() : undefined;
  if (other) labels.push(other);
  return labels.join(', ');
}

function previewFromInteraction(question: AskUserQuestion, response: InteractionPromptResponsePayload): string | undefined {
  const selectedId = response.selectedOptionIds?.find((id) => id !== OTHER_INTERACTION_OPTION_ID);
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
    const item = answers[index];
    const answer = item ? answerFromInteraction(question, item.response) : '';
    result.answers[question.question] = answer;

    if (item?.response.selectedOptionIds?.includes(OTHER_INTERACTION_OPTION_ID) && item.response.otherText?.trim()) {
      result.response = item.response.otherText.trim();
    }

    const preview = item ? previewFromInteraction(question, item.response) : undefined;
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

  const answers: AskUserQuestionInteractionAnswer[] = [];
  for (let index = 0; index < input.questions.length; index++) {
    const question = input.questions[index];
    const payload = buildAskUserQuestionInteractionPayload(sessionId, question, index, options.toolUseID);
    const response = await requestInteraction(mainWindow, payload, options.signal);
    if (response.action === 'cancel') return null;
    answers.push({ payload, response });
  }
  return buildAskUserQuestionResult(input.questions, answers);
}

export function createUserDialogHandler(sessionId: string, mainWindow: BrowserWindow) {
  return async (request: UserDialogRequest, options: UserDialogOptions): Promise<UserDialogResult> => {
    const questions = isAskUserQuestionPayload(request.payload)
      ? request.payload.questions
      : buildGenericChoiceQuestion(request.payload)
        ? [buildGenericChoiceQuestion(request.payload) as AskUserQuestion]
        : null;

    if (!questions) {
      const payload: InteractionPromptPayload = {
        id: randomUUID(),
        sessionId,
        kind: 'confirm',
        source: request.dialogKind,
        toolName: request.dialogKind,
        toolUseId: request.toolUseID,
        title: typeof request.payload.title === 'string' ? request.payload.title : `Claude Code 请求交互：${request.dialogKind}`,
        description: typeof request.payload.description === 'string' ? request.payload.description : typeof request.payload.message === 'string' ? request.payload.message : '该交互类型暂不包含结构化选项，确认后将返回空结果。',
        options: [
          { id: 'confirm', label: '确认', description: '继续当前流程。', primary: true },
        ],
        defaultOptionIds: ['confirm'],
        input: request.payload,
      };
      const response = await requestInteraction(mainWindow, payload, options.signal);
      return response.action === 'submit'
        ? { behavior: 'completed', result: { acknowledged: true } }
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
