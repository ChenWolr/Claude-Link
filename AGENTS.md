# AGENTS.md

Guidance for AI agents working in this repository. The longer-form `CLAUDE.md` covers the same project in more depth (in Chinese) — read it when touching sensitive areas.

## Project overview

Claude Link is an Electron 35 + Vue 3.5 + TypeScript desktop app that acts as a graphical frontend for the locally-installed Claude Code CLI. It does NOT call the Anthropic API directly. Production chat has one backend path: `src/main/modules/chat-backend.ts` re-exports `sdk-backend.ts`, which uses the Claude Agent SDK hooks `canUseTool` / `onElicitation` / `onUserDialog` / `supportedDialogKinds`. `process-manager.ts` remains only for compatibility/tests; do not restore it as a production chat fallback.

Shared helpers such as `buildSpawnEnv` / `normalizeToolResultContent` / `persistCliEvent` / `persistMessageParts` still have callers — do not delete them.

## Prerequisites

- Node.js 20+
- Claude Code CLI installed globally: `npm install -g @anthropic-ai/claude-code`

## Commands

- `npm run dev` — start dev with hot reload (renderer only; main/preload changes need an app restart).
- `npm run typecheck` — runs the node and web TypeScript projects; the **hard correctness gate**. Any change must pass with zero errors. There is no jest/vitest and no `npm test` script.
- `npm run selftest` — chains five local `tsx` scripts: settings↔JSON mapping, regression contracts (including attachments/Task 8), stall watchdog, export-image logic, and PNG codec.
- `npx tsx scripts/regression-tests.ts` — run regression tests alone.
- `npm run rebuild` — recompile the `better-sqlite3` native ABI. **Run this after pulling code or bumping the electron version if startup fails with `NODE_MODULE_VERSION` errors.**
- `npm run build` / `npm run package:win` — build / package Windows installer.

## Workflow

- **Restart the Electron app after main/preload changes** — dev hot reload only covers the renderer.
- **typecheck is the hard gate; selftest is the contract gate.** New features should add assertions to `scripts/selftest-settings-mapping.ts` (append a new `=== N) ... ===` section).
- **GUI pixel-level details can't be auto-verified.** Hover/animation/alignment of the interaction dialogs and attachment composer/export layout must be eyeballed in a real Electron app; logic/structure/CLI behavior is covered by selftest + regression.
## Architecture

Three-process Electron model:

- `src/main/` — main process (Node): CLI/SDK backends, IPC handlers, SQLite, config storage
- `src/main/modules/` — feature modules: `sdk-backend`, `chat-backend`, `interaction-prompts`, `sdk-interactions`, `settings-writer`, `model-resolver`, `task-queue-engine`, `config-manager`, `changes-panel`, etc.
- `src/main/database/` — SQLite (`connection.ts`, idempotent self-healing `migrations.ts`, `repositories/`). `PRAGMA foreign_keys = ON` is on, so CASCADE works.
- `src/preload/` — contextBridge exposing the `window.claudeLink` API (35+ methods).
- `src/renderer/` — Vue frontend. `pages/` (Chat / Config / Sessions), `stores/` (Pinia: session, task, config, interaction, changes), `composables/` (`use-chat`, `use-stream`, `use-task-queue`, `use-ipc`), `components/{chat,config,changes,common,layout,task}/`.
- `src/shared/` — types and pure logic shared by main + renderer (`settings-parser.ts`, `context-usage.ts`, `stall-watchdog.ts`, `types/`).

Path aliases (see `electron.vite.config.ts` + `tsconfig.web.json`): `@shared` → `src/shared`, `@` → `src/renderer` (renderer only).

### Cross-cutting subsystems (read before editing)

- **Unified interaction queue**: SDK `canUseTool` / `onUserDialog` / `onElicitation` are adapted in `sdk-interactions.ts` to `InteractionPromptPayload`, queued in `interaction-prompts.ts` (main) + `interaction-store.ts` (renderer), rendered by `InteractionPrompt.vue`. Local confirm dialogs also use the same queue (`kind:'confirm'`, no IPC, resolved in `respondAndRemove`). Persisted in the `interaction_history` table (CASCADE-delete with session).
- **Real context usage & auto-compaction**: `src/shared/context-usage.ts` — `extractContextTokens` sums input + cache_creation + cache_read; `detectCompaction` flags `system + compact_boundary` events. `sessionContextStats` Map caches the last seen usage; `markSessionDeleted` cleans it.
- **Process grouping**: messages fold into `ProcessGroup` by turn; sub-agent (Task/Agent tool) processes are pulled to the right-side "子Agent" tab via `parentToolUseId`. The `messages` table carries `process_kind` / `parent_agent_id` / `tool_use_id` / `title` columns.
- **Attachments**: main process owns copies under Electron `userData/attachments/<sessionId>/...`; renderer receives only IDs/summaries through local IPC. Images use SDK image blocks; documents/files use the controlled attachment directory plus `additionalDirectories` for the Claude Code `Read` tool. Export uses a minimal snapshot without IDs, paths, storage keys, or hashes.
- **Changes panel**: right-side "改动" Tab — `changes-panel.ts` (main) + `changes-store.ts` / `components/changes/ChangesPanel.vue` (renderer).

## Key design decisions

- **Config injection is dual-channel**: env vars injected into the spawned CLI + `settings.local.json` written to the working directory (the latter carries permissions/hooks and has the **highest priority**, beating CC's own `~/.claude/settings.json` env block). `--model` is also passed with the alias resolved via `resolveAliasToActualModel` as a second safeguard.
- **Model alias mapping**: Claude Code uses `sonnet/haiku/opus/fable` aliases; Claude Link maps them to real models (e.g. `glm-5.2`) via `ANTHROPIC_DEFAULT_*_MODEL` env vars — never uses real model names directly.
- **Form ↔ JSON bidirectional binding**: `advancedJson` is the single source of truth; form fields are views of it. `parseClaudeSettings` peeks values without deleting them, and an `updatingFromJson` flag prevents update loops.
- **stream-json parsing**: `thinking_delta` / `text_delta` / `signature_delta` are parsed separately; thinking is shown in a collapsed block.
- **apiKey encryption**: stored via electron-store + safeStorage.
- **DB migrations are idempotent and self-healing**: `migrations.ts` checks `PRAGMA table_info` before adding columns, so old DBs upgrade without blocking.
- **Design tokens**: `src/renderer/assets/variables.css` (general palette/radius/font) + `interaction-tokens.css` (16 `--interaction-*` tokens for the interaction dialogs). Theme palette `THEME_PALETTES` lives in `src/shared/constants.ts`.

## Git conventions

- **All commit subjects and bodies are in Chinese.** Do not write English commit messages (fixed automated co-author lines excepted). Conventional-commit prefixes (`feat:` / `fix:` / `refactor:` / `docs:` / `style:`) with a Chinese scope are acceptable, e.g. `feat(配置页): ...`.
- Working branch is `dev`; PRs target `master`.
- Isolate commits by concern (interface-separation principle): use `git add -p` to split hunks across concerns so each commit typechecks on its own.
- `docs/superpowers/` is gitignored — tracked files there need `git add -f`; design/plan/audit docs do not go into git.

## Frontend design references

UI / design inspiration comes from two open-source projects — browse their READMEs/source on GitHub as needed (don't clone):
- https://github.com/zhukunpenglinyutong/desktop-cc-gui
- https://github.com/liliMozi/openhanako (source of the `THEME_PALETTES` color scheme)
