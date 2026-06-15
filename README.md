# Claude Link

> Claude Code 的图形化**配置输送器**与**会话代理** —— 把配置喂给本地 Claude Code CLI，完整接收它的思考 / 输入 / 输出并可视化，附带任务队列调度。

## 它是什么

Claude Link **不是另一个 Claude**，而是已安装的 Claude Code CLI 的图形化前端：

- 你在 Claude Link 里配置（API Key、URL、模型映射、权限…）
- Claude Link 把配置通过 **环境变量 + `.claude/settings.local.json`** 注入本地 `claude` CLI
- CLI 的流式输出（**思考、正文、工具调用**）被原封不动接收、解析、展示
- 多条指令排队执行，自动调度

特别适合**用国产模型（GLM、DeepSeek、通义…）跑 Claude Code**：通过 `ANTHROPIC_DEFAULT_SONNET_MODEL` 等映射，把 Claude 的类型别名指向国产模型。

## 核心功能

- 🔧 **配置输送** — spawn `claude` CLI 时注入 env（apiKey / url / 模型映射），同时写 `.claude/settings.local.json`（permissions 等顶层字段也生效，对标 [CC GUI](https://github.com/ronghuaxueleng/claude-code-config-manage-gui)）
- 🔀 **配置双向绑定** — 配置页输入框 ↔ JSON 文本框双向同步；粘 settings.json 自动回填，改输入框实时生成 JSON
- 🤖 **国产模型适配** — `sonnet/haiku/opus/fable` 类型别名 → 实际模型（glm-5.2、deepseek-chat）映射，CLI 走别名 + env 映射
- 🧠 **思考完整接收** — 解析 stream-json 的 `thinking_delta`，灰色折叠块展示 Claude 的思考过程
- 🧪 **测试连接** — 一键用当前配置调 CLI 验证，显示真实响应
- 💬 **会话流** — text / tool_use / tool_result / thinking 全类型解析展示，流式输出
- 📋 **任务队列** — 多条指令排队、拖拽排序、暂停 / 恢复 / 中断、倒计时续写
- 🎨 **主题** — 多套预设调色板
- 🔍 **CLI 检测 / 配置自动导入** — 自动检测 `claude` CLI + 扫描 `~/.claude/` 配置

## 工作原理

```
┌──────────────────────── Claude Link (Electron + Vue) ────────────────────────┐
│                                                                              │
│  配置页 ──→ config-store (表单↔JSON 双向) ──→ advancedJson (settings 结构)    │
│                              │                                               │
│  saveConfig ──→ electron-store (apiKey safeStorage 加密)                     │
│              └→ settings-writer → 写 <工作目录>/.claude/settings.local.json  │
│                                                                              │
│  发消息 ──→ process-manager                                                  │
│            spawn claude CLI (env 注入 + --include-partial-messages)          │
│                ↓ stdout (stream-json 逐行)                                   │
│            attachStreamParser (init / message / stream_event / result)       │
│            持久化 SQLite + 转发渲染进程                                       │
│                ↓                                                             │
│  use-chat (thinking_delta / text_delta / signature_delta 分流)               │
│                ↓                                                             │
│  session-store (streamingContent / streamingThinking)                        │
│                ↓                                                             │
│  MessageList (ThinkingBlock 折叠块 + StreamRenderer 流式正文)                │
└──────────────────────────────────────────────────────────────────────────────┘
                                  ↓ spawn 子进程
┌──────────────────────── claude CLI (本地 npm 全局安装) ──────────────────────┐
│  读 process env + cwd/.claude/settings.local.json                            │
│  调 Anthropic 官方 / 国产兼容端点                                             │
│  输出 stream-json (thinking / text / tool_use / tool_result)                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 国产模型配置（重点）

Claude Code 用 `sonnet/haiku/opus/fable` 类型别名，通过 env 映射指向实际模型。配置页"模型类型映射"4 个输入框：

```
sonnet → glm-5.2     (默认 · 均衡)
haiku  → glm-5.2     (快速)
opus   → glm-5.2     (强力)
fable  →             (超长任务)
```

会话里选类型（sonnet），CLI 自动走映射调 glm-5.2。也可直接粘 settings.json 到配置页高级 JSON 框，自动回填输入框：

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "你的key",
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.2",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.2",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.2"
  }
}
```

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面 | Electron 35 |
| 前端 | Vue 3.5 + TypeScript 5.8 + Pinia 3 |
| 构建 | electron-vite 3 + electron-builder 26 |
| 数据库 | better-sqlite3 |
| 配置存储 | electron-store + safeStorage（加密 apiKey） |
| CLI 桥接 | child_process spawn + stream-json |

## 架构

```
src/
├── shared/                      # 主进程 + 渲染进程共享
│   ├── settings-parser.ts       # settings.json 解析（peek 不删，支持双向）
│   ├── constants.ts             # IPC 通道、主题调色板、slash 命令
│   └── types/                   # cli / config / session / task / ipc 类型
├── main/                        # Electron 主进程
│   ├── index.ts                 # 入口（窗口、DB 初始化、IPC 注册）
│   ├── ipc-handlers.ts          # IPC handler 注册
│   ├── modules/
│   │   ├── process-manager.ts         # spawn CLI + env 注入 + stream 解析 + 持久化
│   │   ├── config-manager.ts          # electron-store + apiKey 加密 + 触发写 settings
│   │   ├── settings-writer.ts         # 写 .claude/settings.local.json（对标 CC GUI）
│   │   ├── connection-tester.ts       # 测试连接（调 CLI 发"你好"）
│   │   ├── claude-config-detector.ts  # 自动检测 ~/.claude/ 配置
│   │   ├── cli-detector.ts            # 检测 claude CLI 版本/路径
│   │   ├── task-queue-engine.ts       # 任务队列调度引擎
│   │   ├── model-resolver.ts          # 获取可用模型列表
│   │   └── topic-analyzer.ts          # AI 生成会话名
│   └── database/                # SQLite（migrations + repositories）
├── preload/                     # contextBridge 桥
│   └── api.ts                   # window.claudeLink API（35 个方法）
└── renderer/                    # Vue 前端
    ├── stores/
    │   ├── config-store.ts      # 配置（双向绑定 + 防循环 + modelMappings）
    │   ├── session-store.ts     # 会话/消息/streamingContent/streamingThinking
    │   └── task-store.ts        # 任务队列状态
    ├── composables/
    │   ├── use-chat.ts          # CLI 事件处理（thinking/text/tool 分流）
    │   ├── use-stream.ts        # 流式内容防抖（displayContent/displayThinking）
    │   └── use-task-queue.ts
    ├── pages/
    │   ├── ConfigPage.vue       # 配置页（模型映射/双向/测试连接/主题）
    │   └── ChatPage.vue         # 聊天页
    └── components/
        ├── chat/                # MessageList / ThinkingBlock / ModelSelector / ...
        ├── config/              # ModelMappingInputs / ModelSelect / ThemeSelector / ...
        ├── layout/              # AppLayout / AppSidebar / AppHeader
        └── task/                # TaskQueuePanel / TaskItem
```

## 开发

```bash
npm install           # 安装（postinstall 自动 rebuild 原生模块）
npm run dev           # 开发热更新
npm run typecheck     # 类型检查（vue-tsc）
npm run build         # 构建
npm run rebuild       # 重编译 better-sqlite3（换 electron 版本后必须）
npm run package:win   # 打包 Windows 安装包
```

> **换 electron 版本 / 拉取代码后跑不起来?** 八成是 `better-sqlite3` 的原生 ABI 不匹配（报 `NODE_MODULE_VERSION` 错）。跑 `npm run rebuild` 重新编译即可。打包 mac/linux 需在对应平台（或 CI）执行。

## 前置条件

- Node.js 20+
- Claude Code CLI：`npm install -g @anthropic-ai/claude-code`
- API Key（Anthropic 官方 或 国产兼容端点）

## 关键设计决策

- **env 注入 + settings 文件双通道**：Claude Link 自己 spawn CLI 走 env 注入（核心机制）；额外写 settings.local.json 让 permissions / autoMemoryEnabled 等顶层字段生效
- **类型别名 + 映射**：不直接用国产模型名，而是用 sonnet/haiku/opus 别名 + env 映射，符合 [Claude Code 官方机制](https://code.claude.com/docs/en/model-config)
- **表单 ↔ JSON 双向**：advancedJson 作为 settings.json 单一数据源，输入框是其视图；`peek` 不删 + `updatingFromJson` 标志防循环
- **思考完整接收**：stream-json 的 `thinking_delta` 解析（之前只处理 `text_delta`，思考被丢）

## License

MIT
