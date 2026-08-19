# Claude Link

Claude Link 是一个基于 Electron 的 Claude Code 桌面客户端。它调用本机安装的 Claude Code CLI，通过 Claude Agent SDK 建立会话，把模型输出、工具调用、权限交互和任务状态展示在桌面界面中。

Claude Link 不直接实现一套聊天模型，也不把用户输入原样转发到某个 HTTP 接口。每次聊天都会由 Claude Agent SDK 创建或恢复一次 Claude Code query，配置、工作目录、权限模式和会话状态都会进入这条原生链路。

## 主要功能

- **Claude Code 会话**：使用本机 Claude Code CLI，支持连续会话、会话恢复和中断。
- **多供应商与模型库**：在设置页维护多个供应商及其模型，会话工具栏单独选择当前供应商和实际模型。
- **配置投影**：配置同时通过进程环境变量和 `<工作目录>/.claude/settings.local.json` 注入 Claude Code。权限、hooks 等 settings 字段通过文件投影生效。
- **配置导入与诊断**：扫描 Claude Code 配置文件，导入 settings 内容，并查看原生 settings 来源、路径和键名摘要。
- **流式输出**：展示正文、思考摘要、工具调用、工具结果、工具进度、子 Agent 活动和上下文用量。
- **统一交互弹窗**：权限确认、AskUserQuestion 和本地确认共用同一套交互队列。
- **Slash Commands**：读取 Claude Code SDK 提供的命令快照，按会话隔离，并在菜单中标注内置命令、用户 Skill、项目命令、插件命令和未知来源。
- **附件**：图片作为图像内容发送，文档和普通文件保存到会话附件目录，由 Claude Code 的 Read 工具读取。
- **任务队列**：支持任务排队、排序、暂停、恢复、中断、重试和任务间倒计时。
- **代码改动面板**：按需读取工作目录的 Git 状态和 diff，支持搜索、高亮及使用系统程序打开文件。
- **Claude 计划与子 Agent**：展示 TodoWrite、Task、Agent 等工具产生的计划、后台任务和子 Agent 过程。
- **会话导出**：把会话渲染为 JPEG 或 PNG 长图。
- **主题与显示设置**：提供多套主题色板和字体缩放选项。

## 工作方式

一次聊天回合的链路如下：

```text
Vue renderer
  │ IPC
  ▼
Electron main process
  │
  ├─ 解析会话供应商、实际模型、权限和工作目录
  ├─ 构造 Claude Agent SDK Options
  ├─ 动态加载 SDK，调用 query()
  ├─ 接收 SDKMessage 并转换为 Claude Link 事件
  ├─ 写入 SQLite，并通过 IPC 推送给 renderer
  └─ 处理权限、AskUserQuestion、elicitation 和用户对话
       │
       ▼
本机 Claude Code CLI
  │
  ├─ 读取进程环境变量
  ├─ 读取工作目录下的 .claude/settings.local.json
  ├─ 调用 Anthropic 或兼容端点
  └─ 执行 Read、Write、Edit、Bash、Task 等 Claude Code 工具
```

生产聊天的唯一后端是 `src/main/modules/sdk-backend.ts`，`chat-backend.ts` 只负责重新导出它。主进程使用动态 `import()` 加载纯 ESM 的 Claude Agent SDK，并通过 `pathToClaudeCodeExecutable` 指向系统中实际解析到的 Claude Code 可执行文件。

每条用户消息都会创建一次新的 SDK `query()`，然后使用 Claude Code session id 恢复上下文。SDK 返回的 `system/init`、`assistant`、`user`、`stream_event`、`tool_progress`、`task_*`、`api_retry`、`compacting` 和 `result` 事件分别处理。流末没有收到 `result` 时，主进程会合成 `aborted` 终态，避免界面一直处于发送中。

## 供应商与模型

设置页维护供应商档案，供应商档案包含名称、备注、Base URL、加密 API Key 和模型列表。API Key 在主进程内解密，renderer 只接收掩码，例如 `sk-…****xxxx`。

供应商库是可选项库，不表示全局默认供应商。真正的选用发生在会话工具栏中。会话当前模型的解析顺序为：

1. 会话级供应商和模型覆盖值。
2. 全局最近使用的供应商和模型。
3. 供应商库中的第一项及其第一项模型。

当前会话只保留一个实际模型 ID，例如 `glm-4.6`。`sonnet`、`haiku`、`opus` 和 `fable` 只作为 Claude Code 内部兼容别名，不在用户界面中作为实际模型使用。每次 query 都会把以下环境变量统一映射到当前实际模型：

```text
ANTHROPIC_MODEL
ANTHROPIC_DEFAULT_SONNET_MODEL
ANTHROPIC_DEFAULT_HAIKU_MODEL
ANTHROPIC_DEFAULT_OPUS_MODEL
ANTHROPIC_DEFAULT_FABLE_MODEL
```

Task 和 Agent 工具的调用参数还会进行第二层模型改写，普通子 Agent 使用当前会话实际模型，`fork` 类型保持 Claude Code 原生行为。

## 配置与权限

Claude Link 的配置由全局配置、供应商档案、会话配置和 Claude Code 原生 settings 共同组成。

- `advancedJson` 保存用户编辑的 Claude settings JSON，是高级设置的单一数据源。
- 表单字段和高级 JSON 之间双向同步，JSON 解析采用 peek 方式，不会静默删除未识别字段。
- API Key 使用 Electron `safeStorage` 加密保存，系统不支持时才降级为明文存储。
- 每次保存配置时，如果设置了工作目录，就写入该目录的 `.claude/settings.local.json`。
- `settings.local.json` 只负责配置投影，不伪造 `CLAUDE.md`。`CLAUDE.md` 的创建和更新由 Claude Code 的 `/init` 命令真实完成。
- 权限模式支持 `default`、`acceptEdits`、`plan` 和 `bypassPermissions`。
- 需要工具执行的自动化测试应使用 `bypassPermissions`，否则 query 可能停在等待权限确认的状态。

## 统一交互系统

Claude Agent SDK 的 `canUseTool`、`onElicitation` 和 `onUserDialog` 会被主进程转换为统一的交互提示。提示进入主进程队列后，通过 `interaction:request` 发给 renderer，由用户选择后再通过 `interaction:respond` 返回 SDK。

同一套队列覆盖：

- Claude Code 工具权限确认
- AskUserQuestion 单选和多选
- 文本、长文本和表单输入
- 本地确认弹窗

每次提交或取消都会写入 `interaction_history`，切换会话时加载最近的交互记录。用户主动拒绝和系统中断会区分处理，避免把窗口关闭或会话删除误传成用户拒绝工具。

## 附件与文件安全边界

附件的物理文件由主进程复制到用户数据目录下的会话附件目录，renderer 只持有附件 ID、文件名、MIME、大小和预览摘要，不接收绝对路径、存储键或哈希。

- 图片附件转换为 SDK image block，直接随消息发送。
- 文档和普通文件保存在会话附件目录，并通过 `additionalDirectories` 交给 Claude Code 的 Read 工具。
- 暂存文件采用 `.part` 写入后原子重命名，拒绝符号链接，并在 MIME、magic byte、大小和附件预算上校验。
- 预览接口只返回有界的缩略图或原图字节，不返回文件系统路径。
- 导出窗口使用最小附件快照，不暴露附件 ID、路径、storage key 和哈希，也不调用完整的 `window.claudeLink` API。

## Slash Commands

Claude Link 使用 Claude Agent SDK 的命令发现结果，不维护一份独立的静态命令列表。主进程按 `sessionId` 保存命令快照，命令发生变化时向 renderer 推送全量替换。

命令来源会根据 SDK 初始化信息和项目文件证据分类为：

- Claude Code 内置命令
- 用户 Skill
- 项目命令
- 插件命令
- 内部命令
- 已移除命令
- 来源未知

来源未知会作为可见差异状态保留，不能直接当作内置命令。命令快照属于 transient 状态，不会写入聊天消息，也不会由 renderer 二次持久化。

## 数据与进程结构

```text
src/
├── main/                          # Electron 主进程
│   ├── index.ts                   # 应用入口、窗口和数据库初始化
│   ├── ipc-handlers.ts            # IPC handler 注册
│   ├── modules/
│   │   ├── sdk-backend.ts         # Claude Agent SDK 聊天后端
│   │   ├── cli-shared.ts           # 环境注入、事件持久化等共享逻辑
│   │   ├── sdk-interactions.ts    # SDK 交互适配
│   │   ├── sdk-permissions.ts     # 权限 settings 与更新
│   │   ├── sdk-command-registry.ts# Slash Commands 快照
│   │   ├── config-manager.ts      # 配置与 safeStorage
│   │   ├── claude-settings-projection.ts
│   │   ├── settings-writer.ts     # 写 settings.local.json
│   │   ├── connection-tester.ts   # 单模型连接测试
│   │   ├── attachment-*.ts        # 附件策略、存储和消息构造
│   │   ├── task-queue-engine.ts   # 会话任务队列
│   │   ├── changes-panel.ts       # Git 改动面板
│   │   └── export-image-*.ts      # 长图导出与 PNG worker
│   └── database/                  # SQLite 连接、迁移和 repositories
├── preload/                       # contextBridge，按窗口 surface 暴露 API
├── renderer/                      # Vue 页面、组件、Pinia stores
│   ├── pages/                     # ChatPage、ConfigPage、SessionsPage
│   ├── components/                # 聊天、配置、供应商、任务和改动面板
│   ├── composables/               # use-chat、use-stream、use-task-queue
│   └── export/                    # 隐藏导出窗口的独立入口
└── shared/                        # 主进程与 renderer 共用的类型和纯逻辑
    ├── types/                     # config、session、message、IPC 等类型
    ├── session-model.ts           # 会话实际模型解析
    ├── provider-library.ts        # 供应商库校验和掩码
    ├── settings-parser.ts         # settings JSON 解析
    ├── stall-watchdog.ts          # 卡顿分类纯函数
    └── context-usage.ts           # 上下文用量和压缩识别
```

应用使用 Electron 的主进程、preload 和 renderer 三进程模型。主进程持有 SQLite、供应商密钥、附件绝对路径和 SDK query 句柄，renderer 只通过 preload 暴露的结构化 API 访问能力。

数据库文件位于 Electron `userData` 目录的 `claude-link.db`，附件位于同级 `attachments/` 目录。核心数据包括会话、消息、任务、附件、Claude 计划快照、交互历史和上下文缓存。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面容器 | Electron 35 |
| 前端 | Vue 3.5、TypeScript 5.8、Pinia 3 |
| 构建 | electron-vite 3、electron-builder 26 |
| 数据库 | better-sqlite3 |
| 配置存储 | electron-store、Electron safeStorage |
| Claude Code 接入 | `@anthropic-ai/claude-agent-sdk` |
| Markdown | markdown-it、KaTeX、Mermaid、highlight.js |
| 长图导出 | Electron hidden window、worker_threads、PNG 编码 worker |

## 开发

### 前置条件

- Node.js 20 或更高版本
- 已安装 Claude Code CLI：

```bash
npm install -g @anthropic-ai/claude-code
```

### 安装与运行

```bash
npm install
npm run dev
```

主进程和 preload 的修改需要重启 Electron 应用，renderer 修改可以由开发模式热重载。

### 常用命令

```bash
npm run dev
npm run typecheck
npm run selftest
npm run selftest:native
npm run build
npm run rebuild
npm run package:win
```

命令块中的每一行都可以直接复制到 Windows `cmd.exe`、PowerShell 或 Bash 执行。不要把后面的说明文字写在同一行，Windows shell 会把它们传给 npm 或 electron-builder 作为参数。

- `npm run dev`：启动开发模式
- `npm run typecheck`：检查 node 与 web 两个 TypeScript project
- `npm run selftest`：运行静态自测和本地行为契约
- `npm run selftest:native`：运行静态自测加原生 Claude Code 链路
- `npm run build`：构建 Electron 应用
- `npm run rebuild`：重编译 better-sqlite3 原生模块
- `npm run package:win`：打包 Windows NSIS 安装包

`selftest` 使用 `tsx` 执行，不启动 Electron。它覆盖 settings 映射、Claude 计划、命令行为、回归场景、卡顿看门狗、图片导出、PNG 编码、供应商库和会话模型选择器等契约。

如果启动时出现 `NODE_MODULE_VERSION` 或 `better-sqlite3` ABI 错误，先执行：

```bash
npm run rebuild
```

所有缓存、依赖下载和构建临时文件优先放在 `D:\software\Cache`，不要把临时产物写入源码目录。

## 测试约定

- 纯逻辑优先通过 `src/shared` 的行为测试覆盖。
- 跨进程接线通过读取源码的结构契约测试固定通道、注册和生命周期不变量。
- 新增功能需要在 `scripts/` 增加对应的 selftest，并接入 `package.json` 的 `selftest:static` 链。
- 真实 Electron、CDP 和 Claude Code 测试需要使用自动权限模式，涉及 `/init` 等写文件命令时尤其如此。
- GUI 的像素级布局、hover 和弹窗视觉仍需在真实 Electron 窗口中确认。

## 安全边界

Claude Link 会执行 Claude Code 产生的本地工具调用，因此工作目录和权限模式决定了实际副作用范围。应用不会把密钥发送给 renderer，也不会通过 IPC 暴露附件绝对路径。

涉及文件写入、shell 命令、外部链接、Git 操作和导出窗口的路径都在主进程校验。导航和 `window.open` 由 link guard 处理，外部链接交给系统浏览器，应用窗口不会加载任意外部页面。

使用 `bypassPermissions` 前，应确认工作目录、供应商配置和 Claude Code 工具权限符合预期。生产环境建议从 `default` 或 `acceptEdits` 开始，在确有需要时再切换到自动权限模式。

## License

MIT
