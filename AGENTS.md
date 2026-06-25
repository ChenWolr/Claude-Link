# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## Project overview

Claude Link is an Electron 35 + Vue 3.5 + TypeScript desktop app that acts as a graphical frontend for the locally-installed Claude Code CLI. It does NOT call the Anthropic API directly — it spawns the `claude` CLI as a child process, injecting config via environment variables + writing `.claude/settings.local.json`, then parses the CLI's stream-json output for display.

## Prerequisites

- Node.js 20+
- Claude Code CLI installed globally: `npm install -g @anthropic-ai/claude-code`

## Commands

- `npm run dev` — start dev with hot reload
- `npm run typecheck` — type check via `vue-tsc --noEmit`; this is the primary correctness gate (there is **no** jest/vitest and **no** `npm test` script)
- `npm run selftest` — custom self-test for settings↔JSON bidirectional mapping (`npx tsx scripts/selftest-settings-mapping.ts`)
- `npx tsx scripts/regression-tests.ts` — regression tests (no npm script wired up)
- `npm run rebuild` — recompile the `better-sqlite3` native ABI; **run this after pulling code or changing the electron version if startup fails with `NODE_MODULE_VERSION` errors**
- `npm run build` / `npm run package:win` — build / package Windows installer

## Architecture

Three-process Electron model:

- `src/main/` — main process (Node): CLI spawning, IPC handlers, SQLite, config storage
- `src/preload/` — contextBridge exposing the `window.claudeLink` API
- `src/renderer/` — Vue frontend (Pinia stores, composables, pages)
- `src/shared/` — types and pure logic shared by main + renderer (e.g. `settings-parser.ts`)

Path aliases: `@shared` → `src/shared`, `@` → `src/renderer` (renderer only).

## Key design decisions

- **Config injection is dual-channel**: env vars injected into the spawned CLI process + `settings.local.json` written to the working directory (the latter carries permissions, hooks, etc.).
- **Model alias mapping**: Claude Code uses `sonnet/haiku/opus/fable` aliases; Claude Link maps them to real models (e.g. `glm-5.2`) via `ANTHROPIC_DEFAULT_*_MODEL` env vars — never uses real model names directly.
- **Form ↔ JSON bidirectional binding**: `advancedJson` is the single source of truth; form fields are views of it. `parseClaudeSettings` peeks values without deleting them, and an `updatingFromJson` flag prevents update loops.
- **stream-json parsing**: `thinking_delta` / `text_delta` / `signature_delta` are parsed separately; thinking is shown in a collapsed block.
- **apiKey encryption**: stored via electron-store + safeStorage.

## Git conventions

- **All commit subjects and bodies are in Chinese.** Do not write English commit messages. Conventional-commit prefixes (`feat:`, `fix:`, `style:`) with a Chinese scope are acceptable, e.g. `feat(配置页): ...`.
- Working branch is `dev`; PRs target `master`.
