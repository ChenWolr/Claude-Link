# AGENTS.md

本文件面向 IDE agent（与 `CLAUDE.md` 互补，后者供 Claude Code CLI 读取；完整项目规则以 `CLAUDE.md` 为准）。

## 测试 Claude Link 时使用自动权限（必须遵守）

对 Claude Link 做自动化测试（E2E / CDP / 真实窗口等）时，凡涉及需要工具执行的命令（如 `/init` 的 Write），必须先把会话权限模式切到「自动模式」（bypassPermissions）——经真实 UI 权限面板（工具栏权限按钮 → 「自动模式」项），或等效注入。default 权限下 query 会静默等待无人点击的权限确认，表现为「命令长时间无结果」（曾误判为网关慢：/init 挂 20 分钟实为等权限，切换后 1 分钟落盘）。纯本地命令（/usage、/clear 等）与纯文本场景保持默认权限即可。
