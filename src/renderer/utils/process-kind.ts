// process-kind.ts（renderer）
// processKind → 图标 / 中文名 / 语义强调色 映射。供 ToolCallBlock 工具卡头部统一消费，
// 让"思考 / 读文件 / 执行命令"等不同过程在折叠态就有色彩区分，不再是一条清一色的灰缝。
// 与 src/shared/process-kind.ts 的分类键一一对应。

export interface ProcessKindMeta {
  icon: string;
  label: string;
  /** 语义强调色（hex）。用于折叠卡左色条、图标、徽章背景的着色。 */
  color: string;
}

// 深色主题友好的低饱和色板（Tokyo Night / Catppuccin 风格），浅色主题下也保持可读。
const C = {
  thinking: '#b5a3ff', // 柔紫
  file: '#7aa2f7', // 蓝
  exec: '#f0b86e', // 琥珀
  search: '#9ece6a', // 绿
  web: '#56c7d8', // 青
  skill: '#f7768e', // 粉红
  agent: '#bb9af7', // 紫
  plan: '#7dcfff', // 浅蓝
  task: '#e0af68', // 橙
  mcp: '#73daca', // 青绿
  system: '#9aa6b8', // 灰（muted）
  danger: '#f87171', // 红
} as const;

const TOOL_META: Record<string, ProcessKindMeta> = {
  Read: { icon: '📂', label: '读取', color: C.file },
  Write: { icon: '📝', label: '写入', color: C.file },
  Edit: { icon: '✏️', label: '编辑', color: C.file },
  NotebookEdit: { icon: '📓', label: '编辑笔记本', color: C.file },
  Bash: { icon: '⌨️', label: '执行命令', color: C.exec },
  PowerShell: { icon: '⌨️', label: '执行命令', color: C.exec },
  Glob: { icon: '🔎', label: '查找文件', color: C.search },
  Grep: { icon: '🔍', label: '搜索内容', color: C.search },
  WebSearch: { icon: '🌐', label: '联网搜索', color: C.web },
  WebFetch: { icon: '🌐', label: '读取网页', color: C.web },
  web_search: { icon: '🌐', label: '联网搜索', color: C.web },
  web_fetch: { icon: '🌐', label: '读取网页', color: C.web },
  code_execution: { icon: '🧮', label: '执行代码', color: C.exec },
  Skill: { icon: '✨', label: '技能', color: C.skill },
  Agent: { icon: '🤖', label: '子Agent', color: C.agent },
  Task: { icon: '🤖', label: '子Agent', color: C.agent },
  Workflow: { icon: '🧩', label: '工作流', color: C.agent },
  AskUserQuestion: { icon: '❓', label: '提问', color: C.skill },
  TodoWrite: { icon: '📋', label: '任务清单', color: C.task },
  TaskCreate: { icon: '📋', label: '任务', color: C.task },
  TaskUpdate: { icon: '📋', label: '任务', color: C.task },
  TaskGet: { icon: '📋', label: '任务', color: C.task },
  TaskList: { icon: '📋', label: '任务', color: C.task },
  TaskStop: { icon: '📋', label: '停止任务', color: C.task },
  EnterPlanMode: { icon: '📋', label: '进入计划', color: C.plan },
  ExitPlanMode: { icon: '📋', label: '计划', color: C.plan },
  result: { icon: '🔧', label: '工具结果', color: C.system },
};

// MCP server 名 → 专属图标表（折叠态可辨识服务器；未命中回退 🔌）。
// gitea=Git+tea 茶杯 logo；gitlab=tanuki 狐狸 logo。
const MCP_SERVER_ICONS: Record<string, string> = {
  github: '🐙', gitea: '🍵', gitee: '🔴', gitlab: '🦊', gitcode: '🔷',
  atomgit: '⚛️', codeup: '☁️', coding: '🐧', bitbucket: '🪣',
  codeberg: '🏔️', forgejo: '🔨', gogs: '🐹',
};

// server 名 → 图标：小写化后先精确查表，未命中按表序（Object.keys 字面顺序）做包含匹配
//（'my-gitea' 含 'gitea' → 🍵），全部未命中回退 🔌。空串/畸形输入不抛错。
export function mcpServerIcon(server: string): string {
  const lower = (server || '').toLowerCase();
  if (MCP_SERVER_ICONS[lower]) return MCP_SERVER_ICONS[lower];
  for (const key of Object.keys(MCP_SERVER_ICONS)) {
    if (lower.includes(key)) return MCP_SERVER_ICONS[key];
  }
  return '🔌';
}

const NEUTRAL: ProcessKindMeta = { icon: '⚙️', label: '', color: C.system };

export function getProcessKindMeta(kind: string | null | undefined): ProcessKindMeta {
  if (!kind) return { icon: '💬', label: '消息', color: C.system };
  if (kind === 'thinking') return { icon: '💭', label: '思考', color: C.thinking };
  if (kind === 'redacted_thinking') return { icon: '🚫', label: '思考(隐藏)', color: C.danger };
  if (kind === 'permission') return { icon: '🔒', label: '权限', color: C.danger };
  if (kind.startsWith('system:')) return { icon: 'ℹ️', label: '系统', color: C.system };
  if (kind.startsWith('tool:')) {
    const name = kind.slice(5);
    if (TOOL_META[name]) return TOOL_META[name];
    if (name.startsWith('mcp__')) {
      // mcp__<server>__<tool>：按第一个 '__' 切出 server 名（可含单下划线如 web_reader，
      // 不能 split('_')）；畸形名（mcp__foo，无第二个 '__'）→ server 取剩余整段。
      const rest = name.slice(5);
      const sep = rest.indexOf('__');
      const server = sep >= 0 ? rest.slice(0, sep) : rest;
      return { icon: mcpServerIcon(server), label: `MCP_${server}`, color: C.mcp };
    }
    return { icon: '⚙️', label: name, color: C.system }; // 未知工具：⚙️ + 原名
  }
  return NEUTRAL;
}

// 给一个工具 processKind 追加具体名（如 ✨技能·design / 🍵 MCP_gitea·list_issues），用于组标题更可读。
// 当前无调用方（预留）。name 是工具原始名（tool_use 的 part.name）。
export function decorateToolLabel(kind: string | null | undefined, detail?: string | null): string {
  const meta = getProcessKindMeta(kind);
  if (!detail) return `${meta.icon} ${meta.label}`;
  return `${meta.icon} ${meta.label}·${detail}`;
}

// 把路径裁成 basename，用于折叠态预览（Read/Write/Edit 等只显示文件名更易读）。
function basename(p: string): string {
  if (!p) return '';
  const norm = p.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// 从一次工具调用（tool_use 的 content，JSON 字符串）提取人话摘要，供 ProcessGroup 折叠态预览。
// 例：Bash → "npm run build"；Read → "package.json"；Grep → "useState"；Skill → "design"。
// 解析失败或不适用 → 返回 ''（调用方自行兜底）。
export function summarizeToolUse(useContent: string): string {
  let parsed: { name?: string; input?: Record<string, unknown> };
  try {
    parsed = JSON.parse(useContent) as { name?: string; input?: Record<string, unknown> };
  } catch {
    return '';
  }
  const { name, input } = parsed;
  if (!name || !input || typeof input !== 'object') return '';
  const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return s(input.command).split('\n')[0].trim().slice(0, 120);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const p = s(input.file_path) || s(input.notebook_path) || s(input.path);
      return p ? basename(p) : '';
    }
    case 'Grep':
      return s(input.pattern);
    case 'Glob':
      return s(input.pattern);
    case 'WebSearch':
      return s(input.query);
    case 'WebFetch': {
      const u = s(input.url);
      return u ? hostname(u) : '';
    }
    case 'Skill':
      return s(input.name);
    case 'Agent':
    case 'Task':
      return s(input.description);
    case 'TodoWrite': {
      const todos = input.todos;
      if (Array.isArray(todos) && todos.length) {
        const first = todos[0] as { content?: unknown } | undefined;
        return s(first?.content).slice(0, 80);
      }
      return '';
    }
    case 'TaskCreate':
    case 'TaskUpdate':
      return s(input.subject) || s(input.description);
    default: {
      // mcp__<server>__<tool> → 工具名段（server 已体现在折叠标签 MCP_<server> 里）；
      // 畸形名（无第二个 '__'）→ ''。
      if (name.startsWith('mcp__')) {
        const rest = name.slice(5);
        const sep = rest.indexOf('__');
        return sep >= 0 ? rest.slice(sep + 2) : '';
      }
      return '';
    }
  }
}
