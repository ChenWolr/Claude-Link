// claude-plan.ts
// Claude 计划任务状态类型：TodoWrite（无状态快照）与 TaskCreate/Update/List/Get（ID-keyed 任务）
// 的独立数据模型。与手动排队任务（src/shared/types/task.ts）完全隔离，不复用其类型或表。
//
// 设计要点：
//  - TodoWrite 是完整替换快照（无服务端 task ID），按数组位置渲染只读项。
//  - TaskCreate 使用 SDK 返回的正式 task.id，不伪造 ID。
//  - status 跨子系统归一化：SDK task_updated.patch.status 的 'running' → 'in_progress'。
//  - 'deleted' 只作为 TaskUpdate 输入动作，不进入可见列表。
//  - addBlocks/addBlockedBy 是追加去重语义（SDK 是 add），metadata 是按 key 合并（null = 删 key）。
//  - 所有模型输入在纯函数边界做类型校验；非法 status/空 ID/过长文本一律静默忽略
//    （无日志，非法快照不覆盖旧状态）。

/** TodoWrite 三态（与 SDK TodoWriteInput.todos[].status 一致）。 */
export type ClaudeTodoStatus = 'pending' | 'in_progress' | 'completed';

/** Task 工具状态（归一化后）。SDK task_updated 的 'running' 归一化为 'in_progress'。 */
export type ClaudePlanTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'paused';

/** TodoWrite 单条 todo（完整替换快照的一项）。 */
export interface ClaudeTodoItem {
  content: string;
  activeForm: string;
  status: ClaudeTodoStatus;
}

/** TaskCreate/TaskUpdate/TaskList/TaskGet 的单条任务（ID-keyed）。 */
export interface ClaudePlanTask {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: ClaudePlanTaskStatus;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Task patch（增量更新）。
 * - subject/description/activeForm/status/owner：直接替换。
 * - blocks/blockedBy：整体替换。
 * - addBlocks/addBlockedBy：追加去重（SDK 语义是 add，不是 replace）。
 * - metadata：按 key 合并，值为 null 的 key 删除。
 */
export type ClaudePlanTaskPatch = {
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: ClaudePlanTaskStatus;
  owner?: string;
  blocks?: string[];
  addBlocks?: string[];
  blockedBy?: string[];
  addBlockedBy?: string[];
  metadata?: Record<string, unknown>;
};

/** TaskList 输出条目：只含 SDK 实际返回的可见字段（不含 description/activeForm/metadata/blocks）。 */
export interface TaskListEntry {
  id: string;
  subject: string;
  status: ClaudePlanTaskStatus;
  owner?: string;
  blockedBy: string[];
}

/** 按会话隔离的完整计划快照。 */
export interface ClaudePlanState {
  sessionId: string;
  todos: ClaudeTodoItem[];
  tasks: ClaudePlanTask[];
  revision: number;
  updatedAt: string;
}

/**
 * Claude 计划事件：由 SDK 工具调用和 system/task_updated 消息经纯函数解析产生。
 * 主进程解析校验后经 repo 原子更新（事务内递增 revision），再由 forwardClaudePlanState
 * 通过 CHAT_EVENT 推送完整快照。
 */
export type ClaudePlanEvent =
  | { type: 'claude_plan'; operation: 'todos_replace'; sessionId: string; todos: ClaudeTodoItem[]; sourceToolUseId?: string; revision?: number }
  | { type: 'claude_plan'; operation: 'task_upsert'; sessionId: string; task: ClaudePlanTask; sourceToolUseId?: string; revision?: number }
  | { type: 'claude_plan'; operation: 'task_patch'; sessionId: string; taskId: string; patch: ClaudePlanTaskPatch; sourceToolUseId?: string; revision?: number }
  | { type: 'claude_plan'; operation: 'tasks_merge'; sessionId: string; entries: TaskListEntry[]; sourceToolUseId?: string; revision?: number }
  | { type: 'claude_plan'; operation: 'task_delete'; sessionId: string; taskId: string; sourceToolUseId?: string; revision?: number };

// ── 纯解析函数（无 electron/DB 依赖，可 tsx 测试） ──────────────────

/** 最大允许的 todo/task 数量上限，防止模型异常输出炸内存。 */
const MAX_ITEMS = 200;
/** 单条文本字段最大长度。 */
const MAX_TEXT_LEN = 5000;

function clampText(val: unknown): string {
  if (typeof val !== 'string') return '';
  return val.length > MAX_TEXT_LEN ? val.slice(0, MAX_TEXT_LEN) : val;
}

/** 校验并解析 TodoWrite input.todos 数组。返回 null 表示非法快照（不覆盖旧状态）。 */
export function parseTodoWriteInput(
  input: Record<string, unknown>,
): ClaudeTodoItem[] | null {
  const rawTodos = input.todos;
  if (!Array.isArray(rawTodos)) return null;
  if (rawTodos.length > MAX_ITEMS) return null;
  const result: ClaudeTodoItem[] = [];
  for (const item of rawTodos) {
    if (!item || typeof item !== 'object') return null;
    const obj = item as Record<string, unknown>;
    const status = obj.status;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null;
    const content = clampText(obj.content);
    const activeForm = clampText(obj.activeForm);
    if (!content && !activeForm) return null;
    result.push({ content, activeForm, status });
  }
  return result;
}

/** 校验并解析 TodoWriteOutput.newTodos（tool result 确认用）。 */
export function parseTodoWriteOutput(
  output: Record<string, unknown>,
): ClaudeTodoItem[] | null {
  const rawTodos = output.newTodos;
  if (!Array.isArray(rawTodos)) return null;
  if (rawTodos.length > MAX_ITEMS) return null;
  const result: ClaudeTodoItem[] = [];
  for (const item of rawTodos) {
    if (!item || typeof item !== 'object') return null;
    const obj = item as Record<string, unknown>;
    const status = obj.status;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null;
    const content = clampText(obj.content);
    const activeForm = clampText(obj.activeForm);
    if (!content && !activeForm) return null;
    result.push({ content, activeForm, status });
  }
  return result;
}

/** 校验并解析 TaskCreate input。返回 null 表示非法。 */
export function parseTaskCreateInput(
  input: Record<string, unknown>,
): { subject: string; description: string; activeForm?: string; metadata?: Record<string, unknown> } | null {
  const subject = clampText(input.subject);
  const description = clampText(input.description);
  if (!subject) return null;
  const result: { subject: string; description: string; activeForm?: string; metadata?: Record<string, unknown> } = {
    subject,
    description,
  };
  if (typeof input.activeForm === 'string' && input.activeForm) {
    result.activeForm = clampText(input.activeForm);
  }
  if (input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)) {
    result.metadata = input.metadata as Record<string, unknown>;
  }
  return result;
}

/** 校验并解析 TaskCreateOutput（tool result），提取正式 task.id。 */
export function parseTaskCreateOutput(
  output: Record<string, unknown>,
): { id: string; subject: string } | null {
  const task = output.task;
  if (!task || typeof task !== 'object') return null;
  const t = task as Record<string, unknown>;
  const id = typeof t.id === 'string' ? t.id : '';
  const subject = clampText(t.subject);
  if (!id) return null;
  return { id, subject: subject || id };
}

/** 校验并解析 TaskUpdate input。返回 patch 对象或 null。 */
export function parseTaskUpdateInput(
  input: Record<string, unknown>,
): { taskId: string; patch: ClaudePlanTaskPatch } | { taskId: string; delete: true } | null {
  const taskId = typeof input.taskId === 'string' ? input.taskId : '';
  if (!taskId) return null;
  // status: deleted 是删除动作
  if (input.status === 'deleted') {
    return { taskId, delete: true };
  }
  const patch: ClaudePlanTaskPatch = {};
  if (typeof input.subject === 'string') patch.subject = clampText(input.subject);
  if (typeof input.description === 'string') patch.description = clampText(input.description);
  if (typeof input.activeForm === 'string' && input.activeForm) patch.activeForm = clampText(input.activeForm);
  if (input.status === 'pending' || input.status === 'in_progress' || input.status === 'completed') {
    patch.status = input.status;
  }
  if (typeof input.owner === 'string') patch.owner = input.owner;
  // addBlocks/addBlockedBy 保持独立字段（追加语义），不映射到 blocks/blockedBy
  if (Array.isArray(input.addBlocks)) {
    patch.addBlocks = input.addBlocks.filter((b): b is string => typeof b === 'string');
  }
  if (Array.isArray(input.addBlockedBy)) {
    patch.addBlockedBy = input.addBlockedBy.filter((b): b is string => typeof b === 'string');
  }
  if (input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)) {
    patch.metadata = input.metadata as Record<string, unknown>;
  }
  return { taskId, patch };
}

/** 校验并解析 TaskListOutput（tool result），返回可见任务条目（不含 description 等详情字段）。 */
export function parseTaskListOutput(
  output: Record<string, unknown>,
): TaskListEntry[] | null {
  const rawTasks = output.tasks;
  if (!Array.isArray(rawTasks)) return null;
  if (rawTasks.length > MAX_ITEMS) return null;
  const result: TaskListEntry[] = [];
  for (const item of rawTasks) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id : '';
    if (!id) continue;
    const status = obj.status;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue;
    result.push({
      id,
      subject: clampText(obj.subject) || id,
      status,
      owner: typeof obj.owner === 'string' ? obj.owner : undefined,
      blockedBy: Array.isArray(obj.blockedBy) ? obj.blockedBy.filter((b): b is string => typeof b === 'string') : [],
    });
  }
  return result;
}

/** 校验并解析 TaskGetOutput（tool result），返回 taskId + patch（subject/description/status 必置，缺失时兜底；blocks/blockedBy/activeForm/owner/metadata 仅在 SDK 实际返回时携带）。 */
export function parseTaskGetOutput(
  output: Record<string, unknown>,
): { id: string; patch: ClaudePlanTaskPatch } | null {
  const task = output.task;
  if (!task || typeof task !== 'object') return null;
  const t = task as Record<string, unknown>;
  const id = typeof t.id === 'string' ? t.id : '';
  if (!id) return null;
  const status = t.status;
  if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null;
  const patch: ClaudePlanTaskPatch = {
    subject: clampText(t.subject) || id,
    description: clampText(t.description),
    status,
  };
  if (Array.isArray(t.blocks)) {
    patch.blocks = t.blocks.filter((b): b is string => typeof b === 'string');
  }
  if (Array.isArray(t.blockedBy)) {
    patch.blockedBy = t.blockedBy.filter((b): b is string => typeof b === 'string');
  }
  if (typeof t.activeForm === 'string' && t.activeForm) {
    patch.activeForm = clampText(t.activeForm);
  }
  if (typeof t.owner === 'string') {
    patch.owner = t.owner;
  }
  if (t.metadata && typeof t.metadata === 'object' && !Array.isArray(t.metadata)) {
    patch.metadata = t.metadata as Record<string, unknown>;
  }
  return { id, patch };
}

/**
 * 解析 SDK system/task_updated 消息的 patch.status。
 * SDK 用 'running'，归一化为 'in_progress'；未知状态返回 null（跳过）。
 */
export function parseTaskUpdatedPatch(
  sdkMsg: Record<string, unknown>,
): { taskId: string; patch: ClaudePlanTaskPatch } | null {
  const taskId = typeof sdkMsg.task_id === 'string' ? sdkMsg.task_id : '';
  if (!taskId) return null;
  const patchRaw = sdkMsg.patch;
  if (!patchRaw || typeof patchRaw !== 'object') return null;
  const p = patchRaw as Record<string, unknown>;
  const patch: ClaudePlanTaskPatch = {};
  // status 归一化：running → in_progress
  const rawStatus = p.status;
  if (rawStatus === 'pending' || rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'killed' || rawStatus === 'paused') {
    patch.status = rawStatus;
  } else if (rawStatus === 'running') {
    patch.status = 'in_progress';
  } else if (rawStatus === undefined) {
    // no status in patch, skip
  } else {
    return null; // unknown status
  }
  if (typeof p.description === 'string') patch.description = clampText(p.description);
  return { taskId, patch };
}

/**
 * 把 ClaudePlanTaskPatch 应用到一条已有任务，返回新任务对象。
 * - addBlocks/addBlockedBy：追加去重。
 * - metadata：按 key 合并，值为 null 的 key 删除。
 * - 其他字段：直接替换。
 */
export function applyTaskPatch(task: ClaudePlanTask, patch: ClaudePlanTaskPatch): ClaudePlanTask {
  const result: ClaudePlanTask = { ...task };
  if (patch.subject !== undefined) result.subject = patch.subject;
  if (patch.description !== undefined) result.description = patch.description;
  if (patch.activeForm !== undefined) result.activeForm = patch.activeForm;
  if (patch.status !== undefined) result.status = patch.status;
  if (patch.owner !== undefined) result.owner = patch.owner;
  if (patch.blocks !== undefined) result.blocks = patch.blocks;
  if (patch.blockedBy !== undefined) result.blockedBy = patch.blockedBy;
  if (patch.addBlocks !== undefined) {
    result.blocks = [...new Set([...result.blocks, ...patch.addBlocks])];
  }
  if (patch.addBlockedBy !== undefined) {
    result.blockedBy = [...new Set([...result.blockedBy, ...patch.addBlockedBy])];
  }
  if (patch.metadata !== undefined) {
    const merged: Record<string, unknown> = { ...result.metadata };
    for (const [key, value] of Object.entries(patch.metadata)) {
      if (value === null) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
    result.metadata = merged;
  }
  return result;
}

/**
 * 纯 reducer：把 ClaudePlanEvent 应用到当前快照，返回新快照。
 * revision 递增；非法事件不修改状态（返回原快照）。
 * 用于测试和 renderer store 的 live 应用。
 */
export function applyPlanEvent(
  state: ClaudePlanState,
  event: ClaudePlanEvent,
): ClaudePlanState {
  // 仅处理同会话事件
  if (event.sessionId !== state.sessionId) return state;
  // revision 保护：有 revision 的事件不能低于当前
  if (event.revision !== undefined && event.revision < state.revision) return state;

  const nextRevision = state.revision + 1;
  const updatedAt = new Date().toISOString();

  switch (event.operation) {
    case 'todos_replace':
      return { ...state, todos: event.todos, revision: nextRevision, updatedAt };
    case 'task_upsert': {
      const idx = state.tasks.findIndex((t) => t.id === event.task.id);
      const tasks = idx >= 0
        ? state.tasks.map((t) => (t.id === event.task.id ? event.task : t))
        : [...state.tasks, event.task];
      return { ...state, tasks, revision: nextRevision, updatedAt };
    }
    case 'task_patch': {
      const tasks = state.tasks.map((t) =>
        t.id === event.taskId ? applyTaskPatch(t, event.patch) : t,
      );
      return { ...state, tasks, revision: nextRevision, updatedAt };
    }
    case 'tasks_merge': {
      // TaskList merge：对每条 entry 更新可见字段，保留本地详情；新建缺失任务
      const existingIds = new Set(state.tasks.map((t) => t.id));
      const entryIds = new Set(event.entries.map((e) => e.id));
      // 本地有但 incoming 无 → 保留（TaskList 可能是过滤视图）
      const merged = state.tasks.map((t) => {
        const entry = event.entries.find((e) => e.id === t.id);
        if (!entry) return t;
        // 只更新可见字段，保留 description/activeForm/metadata/blocks
        return {
          ...t,
          subject: entry.subject,
          status: entry.status,
          ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
          blockedBy: entry.blockedBy,
        };
      });
      // incoming 有但本地无 → 新建（填充默认缺失字段）
      for (const entry of event.entries) {
        if (!existingIds.has(entry.id)) {
          merged.push({
            id: entry.id,
            subject: entry.subject,
            description: '',
            status: entry.status,
            ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
            blocks: [],
            blockedBy: entry.blockedBy,
          });
        }
      }
      // 跳过条件：entries 全部未命中本地任务且无新增（如空列表/纯过滤视图空结果），不递增
      // revision；命中即递增，即使值相同。
      const hasNew = event.entries.some((e) => !existingIds.has(e.id));
      const hasUpdate = state.tasks.some((t) => entryIds.has(t.id));
      if (!hasNew && !hasUpdate) return state; // 无交集且无新增：不递增
      return { ...state, tasks: merged, revision: nextRevision, updatedAt };
    }
    case 'task_delete': {
      const tasks = state.tasks.filter((t) => t.id !== event.taskId);
      return { ...state, tasks, revision: nextRevision, updatedAt };
    }
    default:
      return state;
  }
}

/** 创建空快照。 */
export function createEmptyPlanState(sessionId: string): ClaudePlanState {
  return { sessionId, todos: [], tasks: [], revision: 0, updatedAt: new Date().toISOString() };
}
