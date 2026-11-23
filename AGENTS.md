# AGENTS.md

本文件面向 IDE agent（与 `CLAUDE.md` 互补，后者供 Claude Code CLI 读取；完整项目规则以 `CLAUDE.md` 为准）。

## 参考源码：ZCode CLI（2026-10-31 增）

- `D:\software\code\zcode` 是 ZCode CLI 完整源码（monorepo：`apps/zcode-cli` 为 CLI 本体，`packages/*` 为桌面端/共享层）。凡涉及与本仓库同源机制的借鉴或对齐（文件改动追踪/turn-diff/checkpoint/rewind、工具事件流、会话存储、权限面板等），**先到该目录读对应源码再动手**，不凭印象猜。

## 测试 Claude Link 时使用自动权限（必须遵守）

测试时自动权限细则详见 CLAUDE.md 核心准则第 10 条（唯一版本）

## E2E/冒烟必须隔离用户数据（必须遵守）

对 Claude Link 做任何 CDP/E2E/冒烟验证时，被驱动的应用实例必须带独立 --user-data-dir（隔离 profile，用后删除），禁止在用户真实配置上产生写入（增删改 MCP 条目、改设置等）。先例：2026-10-29 MCP 冒烟曾写入用户真实配置（docs/plans/2026-10-27-review-round2-and-mcp-clone-fix-report.md §1.4、2026-10-27-five-issues-review-round3.md §3-B1）；cdp-update-e2e.mjs 的 ISO_DIR 即正确做法。

## 敏感信息提交须二次确认（必须遵守）

敏感信息处理按全局 AGENTS.md §5 + CLAUDE.md 核心准则第 4 条执行（项目史实：曾发生 QQ 邮箱等隐私入库、经 455 提交历史重写才清除）

## 网页版映射检查单（必须遵守，2026-10-22 增；完整版见 CLAUDE.md 同名节）

全文以 CLAUDE.md『网页版映射检查单』为唯一权威版（含 secure-only API 等最新项）
