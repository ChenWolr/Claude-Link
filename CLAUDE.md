# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本文件供 Claude Code CLI 在本仓库工作时读取。与 `AGENTS.md` 内容互补，后者面向 IDE agent。

## 核心准则（必须遵守）

1. **记忆写入需授权**：未经用户明确允许，一律禁止编辑 / 写入任何记忆文件（用户级或项目级）；仅在用户明确授权本次写入时才可写入或修改记忆。
2. **缓存统一目录**：所有依赖下载、安装、构建中间产物、临时文件，如非必要一律生成在 `D:\software\Cache` 下（npm/pnpm 缓存、临时目录、打包中间产物等），不污染项目目录与系统盘。
3. **沟通使用中文**：与用户的所有沟通必须使用中文。
4. **禁止私自提交**：未经用户确认不得 `git commit` / `git push`；每次提交前说明范围并获确认。
5. **提交按单一操作原子化拆分（接口隔离原则·铁训）**：代码获准提交后，每个 commit 只承载一种逻辑修改操作。先标注每处改动属于哪类操作（新增 / 修改 / 重构 / 修复 / 删除）；同一文件内若同时含多种性质改动（如「新增」+「修改既有逻辑」，或多个不相关问题点），必须用 `git add -p` 按 hunk 拆开、分多次提交，不得混入同一 commit。自检：一个 commit 能否用一句话、单一动词准确描述——需要“和”连接两件事时就该拆。
6. **参考代码优先本地 `D:\software\code`**：当用户提及「参考某代码 / 某项目 / 某开源库的源码」时，优先在本地 `D:\software\code` 目录下查找已 clone 的源码，先用 Glob/Grep 定位并读真实源码再落地，严禁凭印象脑补或先上 GitHub 浏览（具体 UI 参考项目见下文「前端设计参考」一节）。
7. **Claude Code 对齐铁训（必须遵守）**：Claude Link 的产品目标是通过 Claude Agent SDK 对 Claude Code 做 UI 层复刻。除非用户明确要求降级、简化、偏离或实现 Claude Code 没有的产品行为，否则新增或修改任何功能都必须以 Claude Code 的实际行为为唯一基准，做到运行语义、配置来源、用户级/项目级指令与记忆、工作目录、权限、交互、文件副作用、错误处理和结果展示的 1:1 对齐。实现前必须先核对对应 Claude Code/Agent SDK 的真实契约与端到端行为；不能把「菜单显示、IPC 接通、prompt 原样转发」当作功能完成。凡涉及命令（尤其 `/init`）必须验证真实结果（例如文件是否按原生行为创建/更新、上下文是否按原生来源加载），并在 selftest 或可运行的端到端回归中留下门禁；若 SDK 无法直接提供等价能力，必须先报告差异与影响并停止，不得私自用近似实现冒充 1:1。
8. **命令对齐范围（必须遵守）**：命令对齐不能只修 `/init`，必须盘点并实现 SDK/Claude Code 支持的全部命令。仅当 Claude Link 已有操作在用户可见行为、会话状态、文件副作用、配置/记忆语义和结果反馈上逐项等价时，才允许采用平替（例如用「新建对话」平替 `/clear`）；每个平替必须单独证明等价并写入行为回归。除这些经过证明的平替外，其余命令必须 1:1 实现，不能用「功能类似」「能发送 prompt」或「菜单能显示」作为完成标准。
9. **测试 Claude Link 时使用自动权限（必须遵守）**：对 Claude Link 做自动化测试（E2E / CDP / 真实窗口等）时，凡涉及需要工具执行的命令（如 `/init` 的 Write），必须先把会话权限模式切到「自动模式」（bypassPermissions）——经真实 UI 权限面板（工具栏权限按钮 → 「自动模式」项），或等效注入。default 权限下 query 会静默等待无人点击的权限确认（曾误判为「网关慢」：/init 挂 20 分钟实为等权限，切换后 1 分钟落盘）。纯本地命令（/usage、/clear 等）与纯文本场景保持默认权限即可。

## 项目概览

Claude Link 是 **Electron 35 + Vue 3.5 + TypeScript** 桌面应用，作为本地安装的 Claude Code CLI 的图形化前端。它**不直接调用 Anthropic API**；所有生产聊天统一通过 **Claude Agent SDK** 接入，注入配置（env + `.claude/settings.local.json`）并解析流式事件。`child_process.spawn` 仅 `connection-tester.ts` 一次性连通性探测在用，不作为生产聊天入口。

## 前置条件

- Node.js 20+
- Claude Code CLI 全局安装：`npm install -g @anthropic-ai/claude-code`

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发模式（热重载，仅覆盖渲染层） |
| `npm run typecheck` | 依次检查 node（`tsc`）和 web（`vue-tsc`）两个 TS project，**主要正确性门禁**；无 jest/vitest、无 `npm test` |
| `npm run selftest` | 自测六段（`&&` 串联，全过才算过）：settings↔JSON 映射 / claude-plan / regression / stall-watchdog / export-image / PNG codec；本地 `tsx` 执行，不启动 Electron |
| `npx tsx scripts/regression-tests.ts` | 最大那段回归，selftest 已串联，可单独跑 |
| `npm run rebuild` | 重编译 `better-sqlite3` 原生 ABI；**拉代码后若启动报 `NODE_MODULE_VERSION` 错误必跑** |
| `npm run build` / `npm run package:win` | 构建 / 打包 Windows 安装包 |

> **改完主进程或 preload 必须重启 Electron app 才生效**（dev 热重载只覆盖渲染层）。

## 架构

三进程 Electron 模型 + 两个渲染入口：

```
src/main/        主进程（Node，CJS bundle）：SDK 接入、IPC handler、SQLite、配置存储、导出引擎
src/preload/     contextBridge：主窗口暴露 window.claudeLink（~60 方法），隐藏导出窗口暴露 window.exportLink（~9 方法）
src/renderer/    Vue 前端（Pinia stores / composables / pages / components）+ 独立 export.html（隐藏导出窗口的第二个 Vue app）
src/shared/      主进程与渲染进程共享的类型与纯逻辑（settings-parser、context-usage、stall-watchdog、types）
```

路径别名：`@shared` → `src/shared`，`@` → `src/renderer`（仅渲染层）。主进程的 `main` / `preload` / `renderer.export` 在 `electron.vite.config.ts` 各为独立 rollup input；PNG 编码 worker 是独立 input，打包时 `asarUnpack` 解包（asar 内无法 `new Worker`）。

### 后端接入（核心）

- **生产聊天唯一入口：`chat-backend.ts`（6 行 re-export）→ `sdk-backend.ts`**，通过 Claude Agent SDK 的 `canUseTool` / `onElicitation` / `onUserDialog` / `supportedDialogKinds` 四个 hook 接入交互。
- SDK 是纯 ESM，而主进程是 CJS bundle —— 经 `importSdk()` 模块级缓存的动态 `import()` 加载（`sdk-backend.ts`）。
- **`pathToClaudeCodeExecutable` 必填**（无内置二进制）：`resolveExecutable` 用 `execFileSync` 跑 `which`/`where`，Windows 下解析 `.cmd` shim 拿到真实 `claude.exe`，传给 SDK `Options.pathToClaudeCodeExecutable`。
- 原 `process-manager.ts` 已删除；其纯工具函数（`buildSpawnEnv` / `normalizeToolResultContent` / `persistCliEvent` / `persistMessageParts`）迁到 **`cli-shared.ts`**，被 SDK 路径与测试共用，**不可删除**。

### 回合生命周期与关键不变量（`sdk-backend.ts`）

- 每条用户消息 = 一次全新 `query()` + resume，不是往运行中的 query 追加。`for await` 按 `sdkMsg.type` 分流：`system/init`（持久化 CC `session_id`）、`assistant`（`convertAssistantMessage`→转发+落库+计划扫描）、`user`（只透传 tool_result 类）、`stream_event`（增量 delta 原样转发）、`tool_progress`/`task_*`/`api_retry`/`compacting`/`thinking_tokens`（`forwardTransient`，**只 IPC 不落库**）、`result`（终态落库）。
- **流末未收到 `result` 时合成 `{type:'aborted'}`**（国产端点/Windows 常见），保证前端 `sending` 必复位；`aborted` 不落库。
- **`markSessionDeleted` 是单一收口**：清 `activeSessions`、entries、stall 追踪、toolUse 缓存、权限/上下文缓存、pending interactions —— 新增任何 per-session Map 都必须在此登记。
- **`forwardEvent` 每次落库前查 `isSessionActive`**：避免会话已删后 FK 违例回滚阻塞主循环（会让所有输入卡死）。
- 中断：`killProcess` 先取消 interactions → 加入 `interruptedQueries` WeakSet → `abortEntry`（state 置 `aborting` + `abortController.abort()`，Windows 下走 `TerminateProcess` 硬杀）→ `query.interrupt()`（stdin 控制帧，软中断）。`AbortController` 是硬杀，`interrupt()` 是软杀。
- `api_retry` 使用 Claude Code 原始 `attempt/max_retries` 作为当前请求链的权威序号；claude-link 不注入 `CLAUDE_CODE_MAX_RETRIES`，实际重试节奏和上限由本机 Claude Code 默认策略决定。通知表示“等待后将发起第 N 次真实重试”，不能在通知阶段提前判耗尽。SDK 未回传 `max_retries` 时，本地状态机仅使用展示回退值；正常模型活动进入恢复终态，最后一次真实重试的 assistant/result 错误才进入耗尽终态。
- 各次重试通知经 `forwardTransient` 只更新一张状态卡、不落库；恢复、用户停止、耗尽由主进程写一条 `messages` system 记录并以 `persisted_message` 推前端，renderer 只按 ID upsert，不二次持久化。
- `keep_alive` 心跳**不刷新 stall 计时**（代理常对死连接发心跳）。`forwardSubagentText:true` + stream event 透传 `parent_tool_use_id` 是子 Agent Tab 能看到实时思考的前提，关掉即坏。

### 统一交互弹窗系统

权限确认 + AskUserQuestion 选择题 + 本地 confirm 走**同一队列**：

```
SDK canUseTool / onUserDialog / onElicitation
  → sdk-interactions.ts 适配为 InteractionPromptPayload
  → interaction-prompts.ts 主进程 pending Map + IPC（按 promptId 索引）
  → INTERACTION_REQUEST → InteractionPrompt.vue 展示
  → 用户选择 → INTERACTION_RESPOND → 适配层转回 SDK 返回值
```

- **`canUseTool` 返回 `allow` 必须带 `updatedInput`**，否则 SDK ZodError 封死所有工具。
- **cancel 与 deny 解耦**（`mapPermissionInteractionResponse`）：`reason:'user'`→deny「用户拒绝」；`reason:'abort'`/默认→中性 deny「工具调用已取消」。否则恶意 transcript 里的"user refused"会让模型整场回避该工具。
- 渲染进程本地 confirm（替代原 ConfirmDialog.vue）走 `interaction-store.ts` 的 `requestConfirm()`，生成 `kind:'confirm'` payload 入同一队列，**不经主进程 IPC**，Promise 在 `respondAndRemove` 里 resolve。
- `interaction_history` 表（ON DELETE CASCADE 跟随会话删）每次 submit/cancel 落库一条，切会话加载最近 8 条。

### IPC 契约（主↔渲染边界）

- 通道名 `domain:action`，全部集中在 `IPC_CHANNELS`（`src/shared/types/ipc.ts`，由 `src/shared/constants.ts` re-export），约 70 个。
- **新增一个 IPC 通道需三处同步**：① `IPC_CHANNELS` 加字符串常量 → ② `ClaudeLinkAPI` 加方法 + `preload/api.ts` 加 `ipcRenderer.invoke` 实现 → ③ `ipc-handlers.ts` 的 `registerIpcHandlers` 里 `ipcMain.handle(IPC_CHANNELS.X, …)`。
- 主→渲染推送用 `ipcRenderer.on` 并返回 unsubscribe（`onChatEvent` / `onQueueEvent` / `onContextUpdate` / `onImageExportProgress` / `onTestConnectionEvent`）。
- **导出窗口的 surface 拆分**：`preload/index.ts` 按 `process.argv` 的 `--claude-link-surface=export` 决定只暴露 `window.exportLink`（最小集），主进程仍对每次调用复核 sender/frame/URL/job。

### 渲染层要点

- `use-chat.ts` 是**全局单例**（`createChat` 工厂 + `chatSingleton`），在 `App.vue` `onMounted` 注册一次 `chat:event` 监听；`ChatPage` 卸载不影响监听。`handleEvent` 分流 `thinking_delta`/`text_delta`/`input_json_delta`/`message`/`result`/`error`/`aborted`，靠 `turnHad*` 标志避免流式兜底与已落库内容重复。
- `sending` 是 `session-store` 的**派生 getter**（从 `runningSessions` 算），不是 state；per-session 的 `runningSessions`/`sessionStreams`/`stalledInfo`/`apiRetryInfo`/`subAgentStreamingThinking` 全按 sessionId 索引，切会话不串扰。
- `apiRetryInfo` 保存主进程下发的权威 `retryCount/retryLimit/nextRetryAt`，renderer 不自行加一；状态卡只提供“立即停止”。三个 retry 终态使用 `ApiRetryRecord` 单条折叠显示，详情来自可见窗口 `Message.rawEvent`，隐藏导出窗口仍只拿摘要。
- 流式防抖在 `use-stream.ts`（`STREAM_DEBOUNCE_MS`，per-channel `setTimeout`；清空立即触发不防抖，让已落库消息无缝替换流式）。
- 后台（非活动）会话的流式累积进 `sessionStreams[id]` 快照，`switchSession` 恢复。
- `config-store`：`saveConfig` 用 `JSON.parse(JSON.stringify(this.config))` 脱响应式代理（Pinia proxy 过不了 IPC 结构化克隆）；`updatingFromJson` 标志 gates JSON→表单回填，防 `watch` 再写回 JSON 形成循环。

### 配置注入与模型映射

- **双通道注入**：env 注入子进程 + `<工作目录>/.claude/settings.local.json` 写盘（后者带权限/hooks，优先级最高，覆盖 CC 自身 `~/.claude/settings.json` 的 env 块）。`claude-settings-projection.ts` 合并 `advancedJson` + 计算后的 `permissions` + `env`（apiKey→`ANTHROPIC_API_KEY`，仅非官方端点写 `ANTHROPIC_BASE_URL`）+ thinking 级别 patch。
- **模型别名映射**：CC 用 `sonnet/haiku/opus/fable` 别名；claude-link 通过 `ANTHROPIC_DEFAULT_*_MODEL` env 映射到真实模型（如 `glm-5.2`），从不直接用真实模型名；`resolveAliasToActualModel` 解析后传 `--model` 双保险。
- **表单 ↔ JSON 双向**：`advancedJson` 是单一真相源，表单字段是它的视图。`parseClaudeSettings` peek 不删，`updatingFromJson` 防循环。
- apiKey 经 electron-store + safeStorage 加密；`TestConnectionModal` 明文回显 `requestedModel` vs CC 上报 `model` + 端点，不一致标红。

### 数据库（`src/main/database/`）

- 单例 better-sqlite3（`getConnection()` 每语句同步调用），`journal_mode=WAL` + `PRAGMA foreign_keys=ON`。DB 文件在 `userData/claude-link.db`，附件在同级 `attachments/`（不在工作树内）。
- 迁移幂等自愈：`CURRENT_SCHEMA_VERSION = 7`；V3+ 用 `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` 守卫的 `ALTER TABLE ADD COLUMN`，老库/半应用库升级不阻塞。
- 核心表：`sessions`（含 `model_override`、缓存上下文）、`messages`（FK CASCADE，含过程分组列 `process_kind`/`parent_agent_id`/`tool_use_id`/`title`/`is_error`）、`tasks`（含幂等 `client_message_id` 偏索引）、`attachments` + `message_attachments`/`task_attachments` 连接表、`claude_plan_state`（带单调 `revision`）、`interaction_history`。
- 各 repo 是 `getConnection()` 之上的薄函数模块；`createMessageWithAttachments` 在单事务内 insert+link+promote。

### 其它子系统（`src/main/modules/`）

- **附件**：主进程复制管理，物理文件在 `userData/attachments/<sessionId>/`；renderer 只持附件 ID/摘要，**不能收绝对路径**。图片走 SDK image block；文档/普通文件走会话附件目录 + `additionalDirectories` 交给 CC `Read`。`attachment-policy.ts`（纯：MIME/magic-byte/size/预算/文件名净化）+ `attachment-storage.ts`（原子 `.part`→rename、symlink 拒绝）+ `attachment-prompt-builder.ts`（图片生成可重复 AsyncIterable，图先文后）。
- **changes-panel**：git diff 面板，`git status --porcelain=v1 -z` + `diff HEAD --numstat -z`，3s 超时、`GIT_TERMINAL_PROMPT=0`、`--` 防注入；按需算 vs HEAD 的净 diff，无预快照。
- **export-image**：把会话导成长图。单飞（`active`）+ 隐藏 `BrowserWindow`（sandbox/隔离 partition）+ `capturePage` 分段；PNG 走 `worker_threads` 编码（`export-image-codec-worker.ts`，主线程外拼 RGBA 行）。隐藏 renderer 只消费最小附件快照（不含 ID/路径/storage key/哈希），不调 `window.claudeLink`。
- **task-queue-engine**：per-session 队列，任务间倒计时串行；`interruptTask` 处理 `continuing` 态；generation 计数废掉过期子进程退出。
- **stall-watchdog**（`src/shared/stall-watchdog.ts` 纯函数 `classifyStall`）：继续负责 model/tool 双区静默超时，5s tick 命中发 `stalled` 横幅，到 `hardAutoAbortMs`/`toolHardAbortMs` 经 `killProcess('watchdog')` 硬中断；连续 API retry 的精确阈值由事件边沿状态机处理，watchdog 不再维护第二套 retry 计数。
- **context-usage**：`extractContextTokens` = input + cache_creation + cache_read（不含 output）；`detectCompaction` 识别 `compact_boundary` → emit `CONTEXT_UPDATE` 带 `compactedJustNow`。
- **link-guard**：拦 `will-navigate`/`will-redirect`/`window.open` 走 `getNavigationDisposition`（拦截或交 `shell.openExternal`），`window.open` 一律拒。

## 测试约定

- 无 jest/vitest，Vue 组件不做单测。`npm run selftest` 用 `tsx` 直接跑 Node，**不启动 Electron、不 build**。
- 两类断言：① 导入 `src/shared/*` 纯函数做**行为测试**；② `readFileSync` 读主进程/渲染层源码做**结构文本契约**（`.includes`/regex），专门钉住「一个功能横跨多文件」的接线不变量。
- **新增功能必须在 selftest 补契约断言**（按节追加，如 `=== 30) ... ===`）。`scripts/` 里的 `tdd-*-verify.ts` / `export-image-*-verify.ts` 同此风格；只有进入 `package.json` `selftest` 的 `&&` 链才算门禁，其余可单跑。
- 新脚本约定：纯 `node:assert`/自定义 `check()` 计数、不 import Electron、失败 `process.exit(1)`、优先测纯函数行为而非脆弱的源码文本匹配（除非在记录接线契约）。

## 命令对齐已验证真实行为（Task 5–9 证据，脱敏）

> 只记录经真实门禁验证的事实，不含 API key/token/完整 env。命令对齐不以此节为准——以 `scripts/` 的
> 实时门禁为权威；本节是「到某时间点已验证」的快照，命令集随 Claude Code 版本漂移时须重跑门禁刷新。

- **环境**：Claude Code `2.1.227` / Agent SDK `0.3.191`；运行时 **80 命令**（20 builtin + 57 user-skill + 2 internal + 1 removed）；
  `settings.sources = user|project|local`（Task 3 恢复原生级联，不再 `settingSources: []`）。
  > **门禁口径（review-v9/v10 终态）**：两级门禁均接入且通过——
  > **实践级**（`--require-behavioral-coverage`）：discovery + cancel + ≥1(success,failure)，builtin 还需 reopenPersistence，≥95% 通过。
  > **严格级**（`--require-behavioral-coverage-full`）：**契约驱动**（`CommandBehaviorContract` 77 条：required 须 observed，not-applicable 须理由 + 前后快照 snapshotClean 举证），逐条列出全部豁免及原因。
  > 当前状态（evidence `run-2026-08-14T21-31-07`）：实践级 77/77，严格级 exit 0（discovery/success/failure/cancel 77/77；sideEffects 50 observed + 51 豁免；reopenPersistence 20/20 builtin）。
  > manifest（`D:/software/Cache/claude-link/command-verification.json`）须随 CC/SDK 版本漂移重跑 `--all` 刷新（skillMeta 含 SKILL.md 哈希做版本绑定）。
- **`/init`（Task 5）**：真实创建/更新 `CLAUDE.md`（10 场景矩阵，含空目录/已有文件/用户级·项目级 CLAUDE.md 进上下文/local settings/executable 缺失/用户取消/流末无 result 合成 aborted）；空目录不落盘时 UI 须显「未执行文件写入」不假成功。
- **候选平替（Task 6）**：`/clear`↔新建对话、`/context`↔上下文 UI、`/usage`↔费用 UI、`/config`↔配置页 **逐项不等价 → 全部保持 `native-sdk`**；`/compact` 入口即原生执行。`/compact` 上下文统计变化用 `/context` 前后对比实证（如 4%→3%，SDK `result.usage` 因 cache_read 计入压缩前历史而无效，禁用）。
- **全量命令行为矩阵（Task 7）**：`--all` **240 场景 0 失败 0 skip** + 四门禁（含严格级）exit 0。逐命令独立失败场景（无效 resume → 原生 `error_during_execution`）；核心 builtin 显式成功/失败/重开场景（/insights 等须 warmup 真实会话历史）；文件写入类 skill bypassPermissions 真实落盘举证。8 个 skill 运行时描述空是上游枚举行为（dir name≠frontmatter name），非对齐缺陷。
- **跨进程 provenance（Task 8）**：命令菜单按来源区分（Claude Code 内置/用户 Skill/项目/插件）；unknown 作为可见差异状态计数展示，不被当 builtin 完成；provenance 诊断是 transient 状态，不经 renderer 聊天流二次落库。发布级 DOM 门禁 `npm run test:cdp:commands-e2e`（6/6）：真实 slash 菜单 DOM 断言「项目命令」徽章/全量替换/会话隔离/延迟 probe 不回退；烟雾测试 §6.3 ⑤⑥⑦ 覆盖动态 commands_changed。
- **只读目录受限账户链（Task 9，review-v10 已闭合）**：`npm run test:cdp:readonly-e2e` exit 0——非管理员账户 `ClaudeLinkROE2E` + RX-only ACL + 同账户 EPERM 预检 + 完整 Electron/SDK/CLI 链真实 UI `/init`：文件未创建、EPERM tool result 落库、`init_write_skipped` 持久化、sending 复位、重开一致。此前「DPAPI 跨用户限制」的结论被推翻：不复制加密 store、以该账户新建自身 profile 即可运行。② 中断取消 DB 文本——已修复并真实验证：abort 后 `system:aborted`（「已中断」）落库且重开可见（review-v4 §7.3，推翻 v1–v3 旧结论）。
- **真实窗口发布门禁（Task 9）**：`npm run test:cdp:real-window` exit 0（10 断言：/init 落盘/重开恢复//clear 对照新建对话//context /usage /reload-skills 原生结果//compact 压缩证据//config 备份恢复/中断持久化）；完整 native 链 `selftest:native` exit 0（--all 240/0/0）。全部证据以 `npm run evidence:pack` 产出的 runId 引用（如 `run-2026-08-14T21-31-07`）。
- **真实 Electron 窗口核验（Task 9 Step 3，经 CDP 驱动真实运行窗口，已通过）**：app 启动含 Task 8 改动无崩溃；`window.claudeLink` preload 桥真实在位且 `getCommandDiagnostics` 已上线；命令菜单来源徽章真实渲染（`/init`→「Claude Code 内置」、user-skill→「用户 Skill」）+ provenance 行「7 个命令来源未知 · 3 个隐藏命令」；**`/init` 在真实窗口内对临时目录落盘成功**（~80s 生成 1201 字节非空 `CLAUDE.md`，模型经 Read/Write 工具真实创建）；关闭并重开会话消息 97→97 持久化、徽章稳定；`/clear` 正确派发（conversation_reset）；`/reload-skills` 返回「Reloaded skills: 53 available」；`/context` `/usage` 本地命令真实执行并渲染结果；网关工具层降级期间还观察到 app **正确触发 `init_write_skipped` 横幅（Task 5 逻辑：不伪造成功）**。`/compact` 真实窗口实证压缩（`/context` 10%→5%，103.1k tokens 经 glm-5.2 压缩，与 native E2E `--replacements` 的 compact_boundary + 4%→3% 一致）；`/config` 真实窗口实证「Set Auto-compact to false」并写**用户级** `~/.claude/settings.json`（测后从快照还原，无污染）——隔离 HOME 经 `advancedJson.env.USERPROFILE` 不可达（CC 进程从 process env 解析 HOME，非 SDK env 选项），故 native E2E 的隔离 HOME 覆盖（设 process.env）与真实窗口互补。另实证：中断按钮（`ctl__btn--abort`）停止运行中 query；新建对话对照（会话 15→16 独立新会话 ≠ `/clear` 当前会话内重置，Task 6「不等价」结论复证）。

## Git 提交规范

- **所有提交主题和正文使用中文**（运行环境强制追加的固定署名行除外）。
- Conventional-commit 前缀（`feat:` / `fix:` / `refactor:` / `docs:`）+ 中文 scope 可接受，如 `feat(配置页): ...`。
- 工作分支 `dev`；PR 目标 **`master`**。
- **提交原子化（铁训）**：按“单一改动操作”隔离提交——同文件内不同性质改动（新增 / 修改 / 多个问题点）也要用 `git add -p` 按 hunk 拆成多个 commit，每个 commit 单一动词可描述、且 typecheck 自洽。

## 前端设计参考

UI/设计灵感参考以下三个开源项目，源码已 clone 到本地 `D:\software\code`，**优先读本地源码**，不再上 GitHub 浏览：

- **LobsterAI**：`D:\software\code\LobsterAI\LobsterAI-main`（Electron + Vue/TS，网易出品；前端在 `src/renderer`）
- **openhanako**（HanaAgent）：`D:\software\code\openhanako\openhanako-main`（Electron，作者 liliMozi；主题在 `desktop/src/themes/*.css` + `desktop/src/shared/theme-registry-data.json`）
- **desktop-cc-gui**（ccgui）：`D:\software\code\desktop-cc-gui-main`（**Tauri + React + Vite**，非 Electron、前端 React 非 Vue；只借 UX/视觉/交互，不可照搬技术栈）

参考布局/交互/视觉时**必须先读本地真实源码（theme/token/组件源文件）再落地，严禁凭印象脑补**。主题色板（`src/shared/constants.ts` 的 `THEME_PALETTES`，9 套浅色，默认 `warm-paper`）灵感源自 openhanako。

## 工作流约定

- **改代码后重启 app 验证**：dev 热重载不覆盖主进程与 preload。
- **typecheck 是硬门禁**：任何改动 `npm run typecheck` 必须零错误。
- **selftest 是契约门禁**：新增功能补对应契约断言。
- **GUI 像素层无法自动化验证**：弹窗 hover/横幅/对齐等需真实 Electron app 目视确认；逻辑/结构/真实 CLI 行为由 selftest + regression 覆盖。
- `docs/superpowers` 被 `.gitignore` 忽略：已跟踪文件用 `git add -f` 强制更新；新文件不入库（设计/计划/审计文档不进 git）。
