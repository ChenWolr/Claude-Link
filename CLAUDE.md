# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本文件供 Claude Code CLI 在本仓库工作时读取。与 `AGENTS.md` 内容互补，后者面向 IDE agent。

## 核心准则（必须遵守）

1. **记忆写入需授权**：未经用户明确允许，一律禁止编辑 / 写入任何记忆文件（用户级或项目级）；仅在用户明确授权本次写入时才可写入或修改记忆。
2. **缓存统一目录**：所有依赖下载、安装、构建中间产物、临时文件，如非必要一律生成在专用缓存根目录（环境变量 `CLAUDE_LINK_CACHE_ROOT` 指定）下（npm/pnpm 缓存、临时目录、打包中间产物等），不污染项目目录与系统盘。
3. **沟通使用中文**：与用户的所有沟通必须使用中文。
4. **禁止私自提交**：未经用户确认不得 `git commit` / `git push`；每次提交前说明范围并获确认。
5. **提交按单一操作原子化拆分（接口隔离原则·铁训）**：代码获准提交后，每个 commit 只承载一种逻辑修改操作。先标注每处改动属于哪类操作（新增 / 修改 / 重构 / 修复 / 删除）；同一文件内若同时含多种性质改动（如「新增」+「修改既有逻辑」，或多个不相关问题点），必须用 `git add -p` 按 hunk 拆开、分多次提交，不得混入同一 commit。自检：一个 commit 能否用一句话、单一动词准确描述——需要“和”连接两件事时就该拆。
6. **详细代码审核标准**：后续代码审核必须逐项给出文件、函数、字段和行号，说明触发场景、当前行为、实际后果及计划/契约依据；同时给出目标行为、分步骤整改方案、测试改法、验收命令和通过标准。报告必须区分已验证项、未验证项、证据缺口和阻塞项；结构测试不能替代真实行为验证，未完成真实验证不得宣称完成。需要 subagent 时严格单个、串行使用，不并行、不允许 subagent 派生。
6. **参考代码优先本地已 clone 源码**：当用户提及「参考某代码 / 某项目 / 某开源库的源码」时，优先在本地参考目录查找已 clone 的源码，先用 Glob/Grep 定位并读真实源码再落地，严禁凭印象脑补或先上 GitHub 浏览（具体 UI 参考项目见下文「前端设计参考」一节）。
7. **Claude Code 对齐铁训（必须遵守）**：Claude Link 的产品目标是通过 Claude Agent SDK 对 Claude Code 做 UI 层复刻。除非用户明确要求降级、简化、偏离或实现 Claude Code 没有的产品行为，否则新增或修改任何功能都必须以 Claude Code 的实际行为为唯一基准，做到运行语义、配置来源、用户级/项目级指令与记忆、工作目录、权限、交互、文件副作用、错误处理和结果展示的 1:1 对齐。实现前必须先核对对应 Claude Code/Agent SDK 的真实契约与端到端行为；不能把「菜单显示、IPC 接通、prompt 原样转发」当作功能完成。凡涉及命令（尤其 `/init`）必须验证真实结果（例如文件是否按原生行为创建/更新、上下文是否按原生来源加载），并在 selftest 或可运行的端到端回归中留下门禁；若 SDK 无法直接提供等价能力，必须先报告差异与影响并停止，不得私自用近似实现冒充 1:1。
8. **命令对齐范围（必须遵守）**：命令对齐不能只修 `/init`，必须盘点并实现 SDK/Claude Code 支持的全部命令。仅当 Claude Link 已有操作在用户可见行为、会话状态、文件副作用、配置/记忆语义和结果反馈上逐项等价时，才允许采用平替（例如用「新建对话」平替 `/clear`）；每个平替必须单独证明等价并写入行为回归。除这些经过证明的平替外，其余命令必须 1:1 实现，不能用「功能类似」「能发送 prompt」或「菜单能显示」作为完成标准。
9. **测试 Claude Link 时使用自动权限（必须遵守）**：对 Claude Link 做自动化测试（E2E / CDP / 真实窗口等）时，凡涉及需要工具执行的命令（如 `/init` 的 Write），必须先把会话权限模式切到「自动模式」（bypassPermissions）——经真实 UI 权限面板（工具栏权限按钮 → 「自动模式」项），或等效注入。default 权限下 query 会静默等待无人点击的权限确认（曾误判为「网关慢」：/init 挂 20 分钟实为等权限，切换后 1 分钟落盘）。纯本地命令（/usage、/clear 等）与纯文本场景保持默认权限即可。

## 项目概览

Claude Link 是 **Electron 35 + Vue 3.5 + TypeScript** 桌面应用，作为本地安装的 Claude Code CLI 的图形化前端。它**不直接调用 Anthropic API**；所有生产聊天统一通过 **Claude Agent SDK** 接入，注入配置（env + SDK 内联 settings + `.claude/settings.local.json`）并解析流式事件。`child_process.spawn` 仅两处在用：`connection-tester.ts` 的行内连通性探测、`sdk-backend.ts` 的 post-turn `/context` 探针，均不作为生产聊天入口。

## 前置条件

- Node.js 20+
- Claude Code CLI 全局安装：`npm install -g @anthropic-ai/claude-code`

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发模式（热重载，仅覆盖渲染层） |
| `npm run typecheck` | 依次检查 node（`tsc`）和 web（`vue-tsc`）两个 TS project，**主要正确性门禁**；无 jest/vitest、无 `npm test` |
| `npm run selftest` | 自测多段（`&&` 串联，全过才算过）：`selftest:static` 106 段契约脚本 + 本地行为链；本地 `tsx` 执行，不启动 Electron |
| `npx tsx scripts/regression-tests.ts` | 最大那段回归，selftest 已串联，可单独跑 |
| `npm run rebuild` | 重编译 `better-sqlite3` 原生 ABI；**拉代码后若启动报 `NODE_MODULE_VERSION` 错误必跑** |
| `npm run build` / `npm run package:win` | 构建 / 打包 Windows 安装包 |

> **改完主进程或 preload 必须重启 Electron app 才生效**（dev 热重载只覆盖渲染层）。

## 架构

三进程 Electron 模型 + 两个渲染入口：

```
src/main/        主进程（Node，CJS bundle）：SDK 接入、IPC handler、SQLite、配置存储、导出引擎
src/preload/     contextBridge：主窗口暴露 window.claudeLink（69 方法），隐藏导出窗口暴露 window.exportLink（9 方法）
src/renderer/    Vue 前端（Pinia stores / composables / pages / components）+ 独立 export.html（隐藏导出窗口的第二个 Vue app）
src/shared/      主进程与渲染进程共享的类型与纯逻辑（settings-parser、context-usage、session-model、queue-eta、stall-watchdog、types）
```

路径别名：`@shared` → `src/shared`，`@` → `src/renderer`（仅渲染层）。主进程的 `main` / `preload` / `renderer.export` 在 `electron.vite.config.ts` 各为独立 rollup input；PNG 编码 worker 是独立 input，打包时 `asarUnpack` 解包（asar 内无法 `new Worker`）。

### 后端接入（核心）

- **生产聊天唯一入口：`chat-backend.ts`（re-export）→ `sdk-backend.ts`（约 4000 行）**，通过 Claude Agent SDK 的 `canUseTool` / `onElicitation` / `onUserDialog` / `supportedDialogKinds` 四个 hook 接入交互。
- SDK 是纯 ESM，而主进程是 CJS bundle —— 经 `importSdk()` 模块级缓存的动态 `import()` 加载（`sdk-backend.ts`）。
- **`pathToClaudeCodeExecutable` 必填**（无内置二进制）：`resolveExecutable` 用 `execFileSync` 跑 `which`/`where`，Windows 下解析 `.cmd` shim 拿到真实 `claude.exe`，传给 SDK `Options.pathToClaudeCodeExecutable`。
- 原 `process-manager.ts` 已删除；其纯工具函数（`buildSpawnEnv` / `normalizeToolResultContent` / `persistCliEvent` / `persistMessageParts`）迁到 **`cli-shared.ts`**，被 SDK 路径与测试共用，**不可删除**。

### 回合生命周期与关键不变量（`sdk-backend.ts`）

- 每条用户消息 = 一次全新 `query()` + resume，不是往运行中的 query 追加。**所有 prompt 统一经 `toStreamingPrompt` 包装为流式输入（AsyncIterable）**（运行中切权限档、两段式优雅中止依赖此形态）；resume 失败会清 session id 自动重试一次。
- `for await` 按 `sdkMsg.type` 分流：`system/init`（持久化 CC `session_id` + 命令发现兜底）、`assistant`（转发+落库+计划扫描）、`user`（只透传 tool_result 类）、`stream_event`（增量 delta 原样转发）、`tool_progress`/`task_*`/`api_retry`/`compacting`/`thinking_tokens`（`forwardTransient`，**只 IPC 不落库**）、`commands_changed`（命令快照全量 REPLACE）、`result`（终态落库）。
- **result 分支「同步释放占坑」不变量**：捕获探针参数 → `deleteEntry` → `emitExit(0)` 与 result 处理同序列执行，post-turn 快照 `await` 在其后——UI 立即可发下一条，上下文刷新后台进行。`settle()` 在快照之后幂等收口。
- **流末未收到 `result` 时合成 `{type:'aborted'}`**（国产端点/Windows 常见），伴随 `deleteEntry`+`emitExit`+探针调度，保证前端 `sending` 必复位；`aborted` 不落库。
- **`markSessionDeleted` 是单一收口**：清 `activeSessions`、entries、stall 追踪、toolUse 缓存、权限/上下文缓存、pending interactions、postTurnProbeState、reasoning_replay、apiRetryStates 等 20+ 项 —— 新增任何 per-session Map 都必须在此登记。**唯一刻意例外：`contextRefreshBreaker` 不清**（防跨回合熔断 streak 被清零，切换模型时才重置）。
- **`forwardEvent` 每次落库前查 `isSessionActive`**：避免会话已删后 FK 违例回滚阻塞主循环（会让所有输入卡死）。
- 中断为**两段式**：watchdog/upstream_fatal/queue 理由先 `query.interrupt()`（有界约 5s 优雅窗，观察 exit 到 deadline），超时 `finishKill` → `abortController.abort()` 硬杀兜底；user/session_cleanup 直接 `finishKill`。优雅窗句柄 `entry.forceKill` 供 CHAT_SEND 新回合强制接管；`getActiveProcess` 对优雅窗判否。
- **迟到事件代际守卫**（防「僵尸 exit 假空闲/新回合被旧回合污染」）：① `finishKill` 迟到守卫——`wasCurrent` 在 removeEntryIfCurrent 前捕获，会话级副作用（stall 清理/aborted 补发/探针）以它为门；② CHAT_SEND `child.on('exit')` 兜底的回合代际守卫（`ipc-handlers.ts`，`active !== child` 即让位），队列记账 `noteTurnOutcome` 不被旧回合触发。
- **运行中能力**：`CHAT_SET_PERMISSION_MODE` → `setRunningQueryPermissionMode`（`query.setPermissionMode`，3s 超时按已写入放行）；模型/思考强度无运行中通道，一律「下一条消息起生效」（每次 spawn 现读会话配置）。
- `api_retry` 使用 Claude Code 原始 `attempt/max_retries` 作为当前请求链的权威序号（`src/shared/api-retry-state.ts` 边沿状态机，三终态 recovered/user_stopped/exhausted，terminal 后迟到 retry 丢弃）；claude-link 不注入 `CLAUDE_CODE_MAX_RETRIES`。重试通知经 `forwardTransient` 只更新一张状态卡；三终态由主进程落库一条 system 记录。非重试上游错误（model_not_found/authentication/billing 等）走 `abortNonRetryableUpstream` 快败并落 `system:upstream_fatal` 精确诊断。
- **reasoning_replay 韧性层**：`src/shared/upstream-errors.ts` 分类器 + `reasoning-replay-auto-retry.ts` 自动重试一次（2s 延时、防重入），错误以 `messages.api_error_kind` 结构化落库，错误气泡带行动建议。
- `keep_alive` 心跳**不刷新 stall 计时**（代理常对死连接发心跳）。`forwardSubagentText:true` + stream event 透传 `parent_tool_use_id` 是子 Agent Tab 能看到实时思考的前提，关掉即坏。

### 统一交互弹窗系统

权限确认 + AskUserQuestion 选择题 + 本地 confirm 走**同一队列**：

```
SDK canUseTool / onUserDialog / onElicitation
  → sdk-interactions.ts 适配为 InteractionPromptPayload（7 种 kind：permission / single-choice / multi-choice / text / long-text / form / confirm）
  → interaction-prompts.ts 主进程 pending Map + IPC（按 promptId 索引）
  → INTERACTION_REQUEST → interaction-store（Pinia，本地/远端同队列）→ InteractionPrompt.vue 展示
  → 用户选择 → INTERACTION_RESPOND → 适配层转回 SDK 返回值
```

- 主→渲染另有 `interaction:cancel` 推送（会话删除/中断时逐条取消）与启动时 `interaction:getPending` 水合未决弹窗。
- **`canUseTool` 返回 `allow` 必须带 `updatedInput`**，否则 SDK ZodError 封死所有工具。
- **cancel 与 deny 解耦**（`mapPermissionInteractionResponse`）：`reason:'user'`→deny「用户拒绝」；`reason:'abort'`/默认→中性 deny「工具调用已取消」。否则恶意 transcript 里的"user refused"会让模型整场回避该工具。watchdog/upstream_fatal/queue 三理由中断时另落 `system:interaction_cancelled` 可见系统消息。
- **看门狗让位**：权限弹窗 pending 期间 `watchdogTick` 刷新 `lastActivityAt` 并暂停硬杀判定（`hasPendingInteractionForSession`）；API 重试排期期间同样暂停。
- 会话级放行：工具栏「本会话总是允许」经 `withToolSessionAllow` 写入（无 SDK 建议时自补裸 allow 规则），toolName 归一化（trim+lowercase）对称读写，本地短路命中免重复弹窗；`options.agentID == null` 才享受短路（子 Agent 不搭车）。
- 渲染进程本地 confirm 走 `interaction-store.ts` 的 `requestConfirm()`，同队列 Promise resolve，**不经主进程 IPC**，也不落 interaction_history。
- `interaction_history` 表（ON DELETE CASCADE 跟随会话删）由渲染层在弹窗 submit/cancel 后落库一条，切会话加载最近 8 条（仅读取 LIMIT，DB 不修剪）。

### IPC 契约（主↔渲染边界）

- 通道名 `domain:action`，全部集中在 `IPC_CHANNELS`（`src/shared/types/ipc.ts`，由 `src/shared/constants.ts` re-export）；主进程约 55 个 `ipcMain.handle`（导出子系统另注册 8 个 + 1 个单向 on）。
- **新增一个 IPC 通道需三处同步**：① `IPC_CHANNELS` 加字符串常量 → ② `ClaudeLinkAPI` 加方法 + `preload/api.ts` 加 `ipcRenderer.invoke` 实现 → ③ `ipc-handlers.ts` 的 `registerIpcHandlers` 里 `ipcMain.handle(IPC_CHANNELS.X, …)`。
- 主→渲染推送用 `ipcRenderer.on` 并返回 unsubscribe（`onChatEvent` / `onQueueEvent` / `onContextUpdate` / `onImageExportProgress` / `onTestConnectionEvent` / `onCommandsChanged` / `onGlobalCommandsChanged` / `onInteractionCancel` 等）。
- **导出窗口的 surface 拆分**：`preload/index.ts` 按 `process.argv` 的 `--claude-link-surface=export` 决定只暴露 `window.exportLink`（最小集），主进程仍对每次调用复核 sender/frame/URL/job。

### 渲染层要点

- `use-chat.ts` 是**全局单例**（`createChat` 工厂 + `chatSingleton`），在 `App.vue` `onMounted` 注册一次 `chat:event` 监听；`ChatPage` 卸载不影响监听。`handleEvent` 分流 `thinking_delta`/`text_delta`/`input_json_delta`/`message`/`result`/`error`/`aborted`，靠 `turnHad*` 标志避免流式兜底与已落库内容重复。
- `sending` 是 `session-store` 的**派生 getter**（从 `runningSessions` 算）；per-session 的 `runningSessions`/`sessionStreams`/`stalledInfo`/`apiRetryInfo`/`subAgentStreamingThinking` 全按 sessionId 索引，切会话不串扰。`ChatInput` 的 disabled 判据是 `sending && !queueEnabled`（队列开启时生成中可继续发送→入队）。
- `apiRetryInfo` 保存主进程下发的权威 `retryCount/retryLimit/nextRetryAt`，renderer 不自行加一；状态卡只提供“立即停止”。三个 retry 终态使用 `ApiRetryRecord` 单条折叠显示。
- 流式防抖在 `use-stream.ts`（per-channel 50ms `setTimeout` 硬编码；清空立即触发不防抖，让已落库消息无缝替换流式。`constants.ts`/`types/ipc.ts` 里的 `STREAM_DEBOUNCE_MS` 是无引用残留，勿当成真相源）。
- 会话状态灯：`shared/session-display-status.ts` 五态解析（idle/running/retrying/completed/network_interrupted，固定优先级），仅在侧栏渲染；`sessionStatus` 为内存态不跨重启。
- 暂态会话：点「新会话」三入口统一 `startTransientSession()`——renderer-only 对象占 `activeSession`，单例保活、不进侧栏列表；首条消息发送前 `materializeActiveTransient()` 以同 id 建 DB 行，暂态附件经 `bindTransientAttachmentsToSession` 转正。
- `config-store`：`saveConfig` 用 `JSON.parse(JSON.stringify(this.config))` 脱响应式代理（Pinia proxy 过不了 IPC 结构化克隆）；`updatingFromJson` 标志 gates JSON→表单回填，防 `watch` 再写回 JSON 形成循环。
- App.vue 全局挂四个单例：`use-chat` 事件监听、`InteractionPrompt`、`ImageLightbox`、`ToolDiffDialog`（+ DiffDialog 经 `useDiffDialog` 单例）。`/sessions` 路由保留但 UI 入口已移除（39ed6f8），仅手输 hash 可达。

### 配置注入与模型选择（多供应商库）

- **多供应商库**：`ProviderProfile[]`（名称/备注/Base URL/加密 key/模型列表）存 electron-store（`providerProfiles`/`lastUsedProviderId`/`lastUsedModelId` 三键刻意不进 defaults 以保迁移守卫），密钥 safeStorage 加密、只在主进程内解密；renderer 经 `config:listProviders` 只拿掩码视图（`sk-…****xxxx`）。设置页=可选项库；**会话是唯一选用现场**（工具栏 `ProviderModelSelector` 二级级联）。
- **唯一实际模型原则**：会话只有一个「当前实际模型」（如 `glm-4.6`），主流程与全部普通 subagent 统一使用它；`haiku/opus/sonnet/fable` 只作 CC 内部兼容层，不出现在 UI/业务数据。解析单一真相源 `resolveSessionModel`（`src/shared/session-model.ts`）：会话 override > `lastUsedProviderId/lastUsedModelId` > 库首；renderer 显示与主进程 spawn 共用。
- **七键 env 映射**：`applySessionOverrideEnv`（shared 纯函数，双通道共用收口）把 `ANTHROPIC_MODEL` + 四个 `ANTHROPIC_DEFAULT_*_MODEL` + `ANTHROPIC_SMALL_FAST_MODEL` + `CLAUDE_CODE_SUBAGENT_MODEL` 全部映射到当前实际模型，并按会话三元组收口 BASE_URL/KEY（清 `ANTHROPIC_AUTH_TOKEN`），防跨供应商混用。`canUseTool` 入口对 Task/Agent 工具调用级改写 `model` 入参（`decideAgentModelOverride`，fork 不改）。
- **双通道注入**：env 注入子进程 + `buildClaudeLinkSettingsBlock` 内联 `Options.settings`（**SDK 最高优先级层**，含权限/env/会话模型钉扎/六开关）。`<工作目录>/.claude/settings.local.json` 为按需投影层（原子写、内容不变跳过、**不投影端点凭据**）。主聊天不传 `settingSources`（原生 user/project/local 级联 + 内联叠加）；connection-tester 与 post-turn 探针带 `--setting-sources` 空值防原生 settings env 劫持（Windows 下传字面 `'""'` 防 cmd 吞参）。
- **运行中解锁语义**：模型/思考强度选择器不随 `sending` 禁用，改动「下一条消息起生效」——**不存在 SDK setModel 通道**，切换靠下次 spawn 现读会话配置（`tdd-midrun-settings-unlock-verify` 锁定该架构）。
- **思考强度真值可见化**：回合 result 后主进程按 2/4/6/8s 延迟重试读引擎 JSONL（`shared/effort-truth.ts` 纯函数），命中写 `sessions.last_effective_effort`；选择器展示「上回合实际生效」行，renderer 在回合结束后 3.5/6/9s 串行拉取。
- **连接完整性**：上游错误分类器（`shared/upstream-errors.ts`）识别确定性错误快败；会话连接漂移落 `system:connection_drift` 可见消息；`config:testProviderModel` 行内测试支持并行（按 `providerId::modelId` 隔离）、90s 超时必落定、`taskkill /T /F` 进程树杀、隔离临时目录 + 空 settings 来源。
- **老字段投影**：`providerName/apiKey/apiBaseUrl/defaultModel` = lastUsed 档案的投影（`config-manager.projectLegacyFields`），库为空时回落老字段链。
- **表单 ↔ JSON 双向**：`advancedJson` 是全局 Claude 设置（permissions/hooks/env）单一真相源。`parseClaudeSettings` peek 不删，`updatingFromJson` 防循环。

### 权限体系

- **全局默认档 + 会话级覆盖**：`shared/permission-resolver.ts`（`resolveEffectivePermissionMode`）统一解析——会话 `permission_mode` 为 NULL 时回落全局默认（AppConfig.permissionMode）；存量会话的 'default' 幻影值由迁移清洗为 NULL。运行中切档走 `CHAT_SET_PERMISSION_MODE`。
- `alignPermissionDefaultMode` 把会话显式选档对齐进 settings.permissions.defaultMode，与 env 通道双保险。
- 引擎后台请求六开关（`CLAUDE_CODE_DISABLE_AUTO_MEMORY/BACKGROUND_TASKS/CRON/FEEDBACK_SURVEY`、`DISABLE_TELEMETRY`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`）：默认全开、勾选语义=注入 '1'（**永不注入 '0'**），经 `buildSpawnEnv` + settings block 双通道；UI 当前隐藏（模板无控件，ConfigPage 仅持久化字段）。

### 数据库（`src/main/database/`）

- 单例 better-sqlite3（`getConnection()` 每语句同步调用），`journal_mode=WAL` + `PRAGMA foreign_keys=ON`。DB 文件在 `userData/claude-link.db`，附件在同级 `attachments/`（不在工作树内）。
- 迁移幂等自愈：**`CURRENT_SCHEMA_VERSION = 11`**；V3+ 用 `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` 守卫的 `ALTER TABLE ADD COLUMN`。版本一览：V1 初始三表 / V2 `model_override` / V3 `interaction_history` / V4 attachments+连接表+`messages.is_error` / V5 `tasks.client_message_id` 部分唯一索引 / V6 `claude_plan_state` / V7 `thinking_level` / V8 `provider_override`+旧别名清洗 / V9 `tasks.paused` / V10 `messages.parent_task_id` 索引 / V11 `permission_mode='default'` 存量一次性清洗（N2：只在升版时执行一次，用户显式 'default' 重启后保留）；另有无版本号幂等自愈块（sessions 的 `last_context_*` 6 列与 `last_effective_effort`、messages 的 `process_kind/parent_agent_id/tool_use_id/title/is_error/api_error_kind`）。
- 核心表 9 张：`sessions`（19 列，含 provider/model/permission/thinking 覆盖与上下文缓存）、`messages`（FK CASCADE，16 列）、`tasks`（`paused` 列、幂等 `client_message_id` 偏索引）、`attachments` + `message_attachments`/`task_attachments` 连接表、`claude_plan_state`（单调 `revision`）、`interaction_history`、`schema_version`。
- 各 repo 是 `getConnection()` 之上的薄函数模块；`createMessageWithAttachments` 在单事务内 insert+link+promote。

### 其它子系统（`src/main/modules/`）

- **任务队列 v3（task-queue-engine.ts）**：per-session 三态状态机 standby/countdown/running（standbyReason：restart/halt_failed/halt_interrupted/switch_off）；回合 success → `armAfterTurn` 全量倒计时（分钟制 `taskDelayMinutes`，1–60 默认 5）→ 归零三重守卫 → `popExecute` 唯一出队体（稳定 clientMessageId 建消息+附件升格+`user_message_created` 事件，带「来自队列」标）。熔断 `haltQueue`/`abortHalt`（result error/interrupted、手动中断、spawn 失败）→ 全部 pending 转 paused + 待命栏。`runTaskNow` 插队（paused 先解禁）。挂点四处：CHAT_SEND `beginUserTurn`、exit 兜底 `noteTurnOutcome`（代际守卫）、CHAT_ABORT `abortHalt`、CONFIG_SAVE 开关联动。已执行历史为内存态（上限 50，重启清零）；重启不自动执行（引擎 Map 空天然保证）。旧版 `interruptTask`/`retryTask`/`continuing` 已删除。
- **上下文占用（canonical 链路）**：`shared/context-usage.ts` 17 个导出——`deriveCurrentContextUsed` 只认 `contextUsedTokens`（**红线：turn usage 永不驱动圆圈**，payload 恒 null + source='estimated-turn-usage'）；`reconcileContextUsage` runtime/native 对账；`shouldAcceptContextPayload` 代际门 + `hasCompleteCanonicalFields` 完整性门；`postTurnFallbackTerminal`（方案 B：stale+诊断显式降级，不伪装 fresh）。主进程四相位采样：query-start / mid-turn（8s 节流+变化门限+单飞）/ post-turn（同 result 序列）/ post-compaction。**post-turn 官方探针**：spawn `claude -p /context --resume <sid> --setting-sources ''`（`shared/post-turn-probe.ts`），45s 预算、四重发射守卫、单飞可打断。**刷新熔断**：连续 3 次真超时（CU 5s 预算）退避 10 分钟，模型切换重置，成功删键半开重开。探针结果持久化进 sessions 的 `last_context_used/used_capacity/used_at`，重启预填 stale 不冒充 fresh。
- **压缩链路**：`compact_boundary` 只发 pending 清旧值（**不携带 compactedJustNow**）；账单来自 `compact_result` 后的 fresh 快照/探针（`parseCompactMetadata` + `formatCompactionSummary`「91.0k → 1.6k（清出 89.4k）」），renderer `shouldShowCompactedBanner` 二次终态校验后弹 3 秒横幅。长按圆环 1 秒 = 发送 `/compact` 原生消息。
- **附件**：主进程复制管理，物理文件在 `userData/attachments/<sessionId>/`；renderer 只持附件 ID/摘要，**不能收绝对路径**。预算：单次 10 个、图片 10MiB/长边 8000px、文件 30MiB、总 50MiB（编码后请求上限另 30MiB）。`attachment-policy.ts`（纯：MIME/magic-byte/尺寸/预算/文件名净化/载荷形状）+ `attachment-storage.ts`（原子 `.part`→rename、symlink 拒绝、过期清扫）+ `attachment-service.ts`（暂态附件内存 Map + `bindTransientAttachmentsToSession` 物化转正 + 消息附件克隆 + 启动 reconcile/孤儿清扫）+ `attachment-prompt-builder.ts`（可重复迭代 AsyncIterable，图先文后，防 sessionId 路径越权）。
- **changes-panel**：git diff 面板，`git status --porcelain=v1 -z` + `diff HEAD --numstat -z`，3s 超时、`GIT_TERMINAL_PROMPT=0`、execFile 非 shell + `--` pathspec 防注入；`getChangeDiff` 支持 `-U{context}`、未跟踪文件 `--no-index` 兜底、二进制检测、按 hunk 完整性截断到 2000 行；`CHANGES_OPEN_FILE` 经 `shell.openPath` + Windows rundll32「打开方式」降级，仓库根越界守卫。
- **Diff 渲染器族（renderer/utils + components/changes）**：`diff-parser`（unified 解析+多段拆分）/ `diff-render`（split chunk 对齐模型 + `computeOffsets` 焦点对齐 + `bridgeRibbon` 贝塞尔缎带桥）/ `diff-words`（本地 LCS 词级 diff，非 jsdiff）/ `diff-highlight`（hljs 逐行 token × 词级 segs，>1500 行降级）/ `diff-search`（token 级高亮+循环导航）。`DiffBody` 无状态渲染器被 `DiffDialog`（git 按需 diff）与 `ToolDiffDialog`（工具调用/消息详情合成 diff，App.vue 全局单例）共用；「纸面工坊」视觉（纸卡舞台/行号中廊贴码/左栏色轨钉层/插入线 3px·62%）已全部提交落地。markdown 正文的 ```diff 代码块仍走 diff2html。
- **export-image（v4.1）**：会话导出 JPEG/PNG 双格式（`ExportImageFormatDialog` 先选格式）。单飞 + 隐藏 `BrowserWindow`（sandbox/独立 partition/setWindowOpenHandler deny）+ `capturePage` 分段；PNG 走 `worker_threads` 编码（独立 rollup input + asarUnpack）；watchdog 90s 无进展 reset + 单 job 5 分钟硬顶；保存对话框 `performSave` 排他写入。隐藏 renderer 只消费最小附件快照（`export-attachment-snapshot.ts`，不含 ID/路径/storage key/哈希），不调 `window.claudeLink`；子 Agent 详情不进主图。
- **stall-watchdog**（`src/shared/stall-watchdog.ts` 纯函数 `classifyStall`）：model/tool 双区静默超时，5s tick 命中发 `stalled` 横幅，到阈值经 `killProcess('watchdog')` 两段式中断；**权限弹窗 pending 期间与 API 重试排期期间自动暂停判定**；连续 API retry 的精确阈值由 `shared/api-retry-state.ts` 边沿状态机处理，watchdog 不维护第二套 retry 计数。
- **托盘与通知**：`minimizeToTray` + `notifyOnLeave` 两开关；托盘启动即建、随开关联动增删（`syncTrayWithConfig`），close 拦截隐藏到托盘，右键退出置 quitting 标志。会话完成/网络中断经主进程 Electron `Notification`（Windows toast），守卫链在纯函数 `buildSessionNotification`；retry 耗尽为唯一通知边沿。
- **link-guard**：拦 `will-navigate`/`will-redirect`/`window.open` 走 `getNavigationDisposition`（拦截或交 `shell.openExternal`），`window.open` 一律拒。
- **暂态会话与命令热刷新**：暂态会话见「渲染层要点」；命令侧 `shared/commands-get.ts` 的 `resolveCommandsGetResult` 三态分流（无 DB 行→只读返回全局兜底副本，不 probe/不 markSessionActive）；`sdk-command-registry.ts` 持 per-session 快照 + `globalFallback` 哨兵；`command-source-watcher.ts` 递归 fs.watch 用户级+项目级 `{commands,skills}` 四目录（1.5s 去抖+sha1 指纹+挂载失败 30s 重挂），指纹变化节流触发全局探测，成功广播 `COMMANDS_GLOBAL_CHANGED`；兜底为空时 60s 节流重试+幂等锁。

## 测试约定

- 无 jest/vitest，Vue 组件不做单测。`npm run selftest` 用 `tsx` 直接跑 Node，**不启动 Electron、不 build**；`selftest:static` 链现有 106 段契约脚本。
- 两类断言：① 导入 `src/shared/*` 纯函数做**行为测试**；② `readFileSync` 读主进程/渲染层源码做**结构文本契约**（`.includes`/regex），专门钉住「一个功能横跨多文件」的接线不变量。注意 `selftest:static` 里的 `tdd-*-verify` 含大量**字面窗口正则**（隐藏契约网），行为改动前先跑基线，被破时按最小同步原则独立 commit 同步断言。
- **新增功能必须在 selftest 补契约断言**并接入 `package.json` `selftest:static` 的 `&&` 链；`scripts/` 里的 `tdd-*-verify.ts` / `export-image-*-verify.ts` 同此风格。
- CDP 门禁：`test:cdp`（烟雾）、`test:cdp:commands-e2e`（命令菜单 DOM）、`test:cdp:real-window`（真实窗口 10 断言）、`test:cdp:context-e2e`（上下文圆环发布级语义，S0–S13）、`test:cdp:readonly-e2e`（受限账户链）、`test:cdp:layout`（布局）。
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
  > manifest（`$CLAUDE_LINK_CACHE_ROOT/claude-link/command-verification.json`）须随 CC/SDK 版本漂移重跑 `--all` 刷新（skillMeta 含 SKILL.md 哈希做版本绑定）。
- **`/init`（Task 5）**：真实创建/更新 `CLAUDE.md`（10 场景矩阵，含空目录/已有文件/用户级·项目级 CLAUDE.md 进上下文/local settings/executable 缺失/用户取消/流末无 result 合成 aborted）；空目录不落盘时 UI 须显「未执行文件写入」不假成功（`init_write_skipped` 横幅，判定在 sdk-backend 回合前记录 CLAUDE.md 存在性）。
- **候选平替（Task 6）**：`/clear`↔新建对话、`/context`↔上下文 UI、`/usage`↔费用 UI、`/config`↔配置页 **逐项不等价 → 全部保持 `native-sdk`**；`/compact` 入口即原生执行。`/compact` 上下文统计变化用 `/context` 前后对比实证（如 4%→3%，SDK `result.usage` 因 cache_read 计入压缩前历史而无效，禁用）。
- **全量命令行为矩阵（Task 7）**：`--all` **240 场景 0 失败 0 skip** + 四门禁（含严格级）exit 0。逐命令独立失败场景（无效 resume → 原生 `error_during_execution`）；核心 builtin 显式成功/失败/重开场景（/insights 等须 warmup 真实会话历史）；文件写入类 skill bypassPermissions 真实落盘举证。8 个 skill 运行时描述空是上游枚举行为（dir name≠frontmatter name），非对齐缺陷。
- **跨进程 provenance（Task 8）**：命令菜单按来源区分（Claude Code 内置/用户 Skill/项目/插件）；unknown 作为可见差异状态计数展示，不被当 builtin 完成；provenance 诊断是 transient 状态，不经 renderer 聊天流二次落库。发布级 DOM 门禁 `npm run test:cdp:commands-e2e`（6/6）：真实 slash 菜单 DOM 断言「项目命令」徽章/全量替换/会话隔离/延迟 probe 不回退；烟雾测试 §6.3 ⑤⑥⑦ 覆盖动态 commands_changed。
- **只读目录受限账户链（Task 9，review-v10 已闭合）**：`npm run test:cdp:readonly-e2e` exit 0——非管理员账户 `ClaudeLinkROE2E` + RX-only ACL + 同账户 EPERM 预检 + 完整 Electron/SDK/CLI 链真实 UI `/init`：文件未创建、EPERM tool result 落库、`init_write_skipped` 持久化、sending 复位、重开一致。此前「DPAPI 跨用户限制」的结论被推翻：不复制加密 store、以该账户新建自身 profile 即可运行。② 中断取消 DB 文本——已修复并真实验证：abort 后 `system:aborted`（「已中断」）落库且重开可见（review-v4 §7.3，推翻 v1–v3 旧结论）。
- **真实窗口发布门禁（Task 9）**：`npm run test:cdp:real-window` exit 0（10 断言：/init 落盘/重开恢复//clear 对照新建对话//context /usage /reload-skills 原生结果//compact 压缩证据//config 备份恢复/中断持久化）；完整 native 链 `selftest:native` exit 0（--all 240/0/0）。全部证据以 `npm run evidence:pack` 产出的 runId 引用（如 `run-2026-08-14T21-31-07`）。
- **暂态会话命令可用性（08-28 增量）**：暂态会话经全局兜底快照立即拥有命令菜单（D2），物化后 SESSION_CREATE 的 per-session probe 经 COMMANDS_CHANGED 升级为精确快照；命令来源目录磁盘变更由 watcher 热刷新全局兜底（D3–D6，契约在 `tdd-native-command-verify.ts` 节 25）。

## Git 提交规范

- **所有提交主题和正文使用中文**（运行环境强制追加的固定署名行除外）。
- Conventional-commit 前缀（`feat:` / `fix:` / `refactor:` / `docs:`）+ 中文 scope 可接受，如 `feat(配置页): ...`。
- 工作分支 `dev`；PR 目标 **`master`**。
- **提交原子化（铁训）**：按“单一改动操作”隔离提交——同文件内不同性质改动（新增 / 修改 / 多个问题点）也要用 `git add -p` 按 hunk 拆成多个 commit，每个 commit 单一动词可描述、且 typecheck 自洽。

## 前端设计参考

UI/设计灵感参考以下三个开源项目，源码已 clone 到本地参考目录，**优先读本地源码**，必要时再上 GitHub 对照：

- **LobsterAI**（Electron + Vue/TS，网易出品；前端在 `src/renderer`）：公开仓库以 GitHub 搜索「LobsterAI」为准
- **openhanako**（HanaAgent，Electron，作者 liliMozi；主题在 `desktop/src/themes/*.css` + `desktop/src/shared/theme-registry-data.json`）：https://github.com/liliMozi/openhanako
- **desktop-cc-gui**（ccgui，**Tauri + React + Vite**，非 Electron、前端 React 非 Vue；只借 UX/视觉/交互，不可照搬技术栈）：https://github.com/zhukunpenglinyutong/desktop-cc-gui

参考布局/交互/视觉时**必须先读本地真实源码（theme/token/组件源文件）再落地，严禁凭印象脑补**。主题色板（`src/shared/constants.ts` 的 `THEME_PALETTES`，9 套浅色，默认 `warm-paper`）灵感源自 openhanako。

## 工作流约定

- **改代码后重启 app 验证**：dev 热重载不覆盖主进程与 preload。
- **typecheck 是硬门禁**：任何改动 `npm run typecheck` 必须零错误。
- **selftest 是契约门禁**：新增功能补对应契约断言。
- **GUI 像素层无法自动化验证**：弹窗 hover/横幅/对齐等需真实 Electron app 目视确认；逻辑/结构/真实 CLI 行为由 selftest + regression 覆盖。
- `docs/superpowers` 被 `.gitignore` 忽略：已跟踪文件用 `git add -f` 强制更新；新文件不入库（设计/计划/审计文档不进 git）。
