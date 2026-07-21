# Claude Link 项目指令

> 本文件供 Claude Code CLI 在本仓库工作时读取。与 `AGENTS.md` 内容互补，后者面向 IDE agent。

## 项目概览

Claude Link 是 **Electron 35 + Vue 3.5 + TypeScript** 桌面应用，作为本地安装的 Claude Code CLI 的图形化前端。它**不直接调用 Anthropic API**，而是通过 Claude Agent SDK（默认）或 spawn `claude` CLI 子进程（回退）方式接入，注入配置（env + `.claude/settings.local.json`），解析 stream-json 输出并展示。

## 前置条件

- Node.js 20+
- Claude Code CLI 全局安装：`npm install -g @anthropic-ai/claude-code`

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发模式（热重载） |
| `npm run typecheck` | 类型检查（`vue-tsc --noEmit`），**主要正确性门禁**；无 jest/vitest，无 `npm test` |
| `npm run selftest` | 自测：`selftest-settings-mapping.ts && regression-tests.ts`（含 settings↔JSON 映射、模型别名解析、上下文用量、交互契约等） |
| `npx tsx scripts/regression-tests.ts` | 回归测试（selftest 已串联，可单独跑） |
| `npm run rebuild` | 重编译 `better-sqlite3` 原生 ABI；**拉代码后若启动报 `NODE_MODULE_VERSION` 错误必跑** |
| `npm run build` / `npm run package:win` | 构建 / 打包 Windows 安装包 |

**改完代码必须重启 Electron app 才生效**（dev 热重载只覆盖渲染层，主进程改动需重启）。

## 架构

三进程 Electron 模型：

```
src/main/        主进程（Node）：CLI/SDK 接入、IPC handler、SQLite、配置存储
src/preload/     contextBridge 暴露 window.claudeLink API（35+ 方法）
src/renderer/    Vue 前端（Pinia stores、composables、pages、components）
src/shared/      主进程与渲染进程共享的类型与纯逻辑（settings-parser、context-usage、types）
```

路径别名：`@shared` → `src/shared`，`@` → `src/renderer`（仅渲染层）。

### 后端接入（双路径）

- **默认：Claude Agent SDK**（`src/main/modules/sdk-backend.ts`）——通过 `canUseTool` / `onElicitation` / `onUserDialog` / `supportedDialogKinds` 四个 SDK 正式 hook 接入交互。
- **回退：spawn CLI**（`src/main/modules/process-manager.ts`）——`chat-backend.ts` 的 re-export 一行切换。
- 公共工具函数（`buildSpawnEnv` / `normalizeToolResultContent` / `persistCliEvent` / `persistMessageParts`）被两路径共用，不可删除。

### 统一交互弹窗系统

权限确认 + AskUserQuestion 选择题 + 本地 confirm 都纳入同一队列：

```
SDK canUseTool / onUserDialog / onElicitation
  → sdk-interactions.ts 适配为 InteractionPromptPayload
  → interaction-prompts.ts 主进程 pending Map + IPC
  → INTERACTION_REQUEST → InteractionPrompt.vue 展示
  → 用户选择 → INTERACTION_RESPOND
  → 适配层转回 SDK 返回值
```

渲染进程本地 confirm（替代原 ConfirmDialog.vue）走 `interaction-store.ts` 的 `requestConfirm()`，生成 `kind:'confirm'` payload 入同一队列，不经主进程 IPC，Promise 在 `respondAndRemove` 里 resolve。

关键文件：
- `src/main/modules/interaction-prompts.ts`：主进程 pending resolver Map
- `src/main/modules/sdk-interactions.ts`：SDK 请求 ↔ Interaction payload 适配
- `src/renderer/stores/interaction-store.ts`：渲染进程统一队列（远程 IPC + 本地 confirm）
- `src/renderer/components/chat/InteractionPrompt.vue`：主弹窗（含 wizard、虚拟滚动、拖拽、位置记忆、焦点陷阱、历史回看）
- 子组件：`InteractionOptionList` / `InteractionPreview`（Markdown+高亮+copy）/ `InteractionDetails`

### 交互历史持久化

`interaction_history` 表（ON DELETE CASCADE 跟随会话删除）。每次 submit/cancel 落库一条，切换会话时加载最近 8 条回看。
- repo：`src/main/database/repositories/interaction-history-repo.ts`
- IPC：`INTERACTION_HISTORY_GET` / `INTERACTION_HISTORY_RECORD`（输入做最小校验）

### 真实上下文用量与自动压缩

- `src/shared/context-usage.ts`：
  - `extractContextTokens(usage)`：input + cache_creation + cache_read
  - `detectCompaction(event)`：识别 `system + compact_boundary` 事件
- 双后端在 usage 推送后调 `detectCompaction`，命中则 emit `CONTEXT_UPDATE` 带 `compactedJustNow:true`
- `sessionContextStats` Map 缓存最近用量（压缩事件无 usage 时沿用），`markSessionDeleted` 清理
- 前端 `ContextButton.vue`：圆环占比 + hover 弹层 + 自动压缩横幅（3 秒）
- `session-store.compactedJustNow` 标记，`switchSession` 复位防串扰

### 会话搜索（视图态）

`session-store` 用 `searchResults: Session[] | null` + `searchQuery` 视图态 + `displayedSessions` getter，`searchSessions` 写 `searchResults` 不覆盖全量 `sessions`。侧栏与会话管理页都走 `store.displayedSessions` + 250ms 防抖。

### 过程分组展示

消息按 turn 折叠成 `ProcessGroup`（居中摘要 fold），子 Agent（Task/Agent 工具）过程透传 `parentToolUseId` 抽到右侧「子Agent」Tab。`messages` 表有 `process_kind` / `parent_agent_id` / `tool_use_id` / `title` 四列支持。

## 关键设计决策

- **配置注入双通道**：env 注入子进程 + `settings.local.json` 写工作目录（后者携带权限/hooks）。**CC 自身 `~/.claude/settings.json` 的 env 块会覆盖子进程 env**，故 claude-link 在 spawn 前把完整配置投影到会话工作目录的 `.claude/settings.local.json`（优先级最高），并用 `resolveAliasToActualModel` 解析后传 `--model`（CLI 参数双保险）。
- **模型别名映射**：CC 用 `sonnet/haiku/opus/fable` 别名；claude-link 通过 `ANTHROPIC_DEFAULT_*_MODEL` env 映射到真实模型（如 `glm-5.2`），从不直接用真实模型名。
- **表单 ↔ JSON 双向绑定**：`advancedJson` 是单一真相源，表单字段是它的视图。`parseClaudeSettings` peek 不删，`updatingFromJson` 标志防更新循环。
- **stream-json 解析**：`thinking_delta` / `text_delta` / `signature_delta` 分开解析；thinking 折叠展示。
- **apiKey 加密**：electron-store + safeStorage。
- **测试连接明文回显**：`TestConnectionModal` 回显 `requestedModel` vs CC 上报 `model` + 端点，不一致标红，消除"配置 vs 实际生效"疑虑。
- **DB 迁移幂等自愈**：`migrations.ts` 按 `PRAGMA table_info` 检查列是否存在再补加，老库升级不阻塞。`PRAGMA foreign_keys = ON` 已开，CASCADE 生效。
- **设计 token**：`variables.css`（通用色板/圆角/字体）+ `interaction-tokens.css`（交互弹窗 16 个 `--interaction-*` token）。

## Git 提交规范

- **所有提交主题和正文使用中文**。不写英文提交说明；如运行环境强制追加固定署名行，则该署名行除外。
- Conventional-commit 前缀（`feat:` / `fix:` / `refactor:` / `docs:`）+ 中文 scope 可接受，如 `feat(配置页): ...`。
- 工作分支 `dev`；PR 目标 `master`。
- 按问题点隔离提交（接口隔离原则）：跨问题点文件用 `git add -p` 拆 hunk，让每个提交 typecheck 自洽。

## 前端设计参考

- UI / 设计灵感参考以下三个开源项目，源码已 clone 到本地 `D:\software\code`，**优先读本地源码**，不再上 GitHub 浏览（LobsterAI / openhanako 各套一层同名 `-main` 子目录，desktop-cc-gui-main 直接是项目根）：
  - **LobsterAI**：`D:\software\code\LobsterAI\LobsterAI-main`（Electron + Vue/TS，网易出品；前端在 `src/renderer`）
  - **openhanako**（HanaAgent）：`D:\software\code\openhanako\openhanako-main`（Electron，作者 liliMozi；主题在 `desktop/src/themes/*.css` + `desktop/src/shared/theme-registry-data.json`）
  - **desktop-cc-gui**（ccgui）：`D:\software\code\desktop-cc-gui-main`（**Tauri + React + Vite**，非 Electron、前端 React 非 Vue；只借 UX/视觉/交互，不可照搬技术栈）
- 参考它们的 UI 布局、交互模式与视觉风格时，**必须先读本地真实源码（theme/token/组件源文件）再落地，严禁凭印象脑补**。
- 主题色板（`src/shared/constants.ts` 的 `THEME_PALETTES`）灵感源自 openhanako。

## 工作流约定

- **改代码后重启 app 验证**：dev 热重载不覆盖主进程与 preload 改动。
- **typecheck 是硬门禁**：任何改动 `npm run typecheck` 必须零错误。
- **selftest 是契约门禁**：新增功能在 `scripts/selftest-settings-mapping.ts` 补契约断言（按节追加，如 `=== 30) ... ===`）。
- **GUI 像素层无法自动化验证**：交互弹窗 hover/横幅/对齐等需真实 Electron app 目视确认；逻辑/结构/真实 CLI 行为由 selftest + regression 覆盖。
- **docs/superpowers 被 .gitignore 忽略**：已跟踪文件用 `git add -f` 强制更新；新文件不入库（设计/计划/审计文档不进 git）。
