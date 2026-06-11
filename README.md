# Claude Link

> Claude Code CLI 任务调度管理器

Claude Link 是一个桌面应用，通过子进程管道连接本地 Claude Code CLI，提供微信风格的聊天界面和任务队列管理系统。

## 功能

- 🔍 **CLI 检测** — 自动检测本地 Claude Code CLI 安装
- ⚙️ **配置管理** — 供应商、API Key、模型选择，安全加密存储
- 💬 **聊天界面** — 实时流式输出，微信风格对话
- 📋 **任务队列** — 添加多条任务、拖拽排序、暂停/恢复/中断
- ⏱️ **自动调度** — 任务间自动倒计时，可跳过立即执行
- 💾 **会话持久化** — SQLite 存储历史会话和消息

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 35+ |
| 前端 | Vue 3.5 + TypeScript 5.7 |
| 构建 | electron-vite 3 + electron-builder 26 |
| 数据库 | better-sqlite3 |
| 配置存储 | electron-store + safeStorage |

## 开发

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build

# 打包 Windows 安装包
npm run package:win
```

## 前置条件

- Node.js 20+
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- Anthropic API Key

## 项目结构

```
src/
├── shared/          # 共享类型和常量
├── main/            # Electron 主进程
│   ├── modules/     # 核心模块 (CLI检测、配置、进程管理、流解析、任务队列)
│   ├── database/    # SQLite 数据库层
│   └── utils/       # 工具函数
├── preload/         # Preload 桥接
└── renderer/        # Vue 3 前端
    ├── stores/      # Pinia 状态管理
    ├── composables/ # 组合式函数
    ├── pages/       # 页面组件
    └── components/  # UI 组件
```

## License

MIT
