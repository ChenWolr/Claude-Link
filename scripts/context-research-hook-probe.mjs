// scripts/context-research-hook-probe.mjs
// 回合中途上下文刷新计划 Phase 1 黑盒实验（docs/superpowers/plans/2026-08-22-mid-turn-context-refresh.md Task 2）。
//
// 目标：黑盒钉死三条候选通道的可行性（被动 hook 消息 / 回调入参 / statusline 旁路 / 主动中途轮询），
// 落盘判定矩阵到 summary.json。不 import 生产代码、不写生产文件、key 绝不落盘。
//
// 用法：
//   node scripts/context-research-hook-probe.mjs                     # 无凭据自检，exit 2，不烧 query
//   node scripts/context-research-hook-probe.mjs --runId hook-probe-<ts>   # 跑全臂 A/B/C/D/F（E 可选）
//   node scripts/context-research-hook-probe.mjs --runId <id> --arm F      # 单补某臂
//
// 退出码：0=所选臂完成且 summary 落盘（含否定结论）；2=前置失败（exe/凭据/版本）；1=臂失败（证据保留）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';

const RESEARCH_ROOT = 'D:/software/Cache/claude-link/context-research';
const DEMO_EXE_PATH = 'D:/software/Cache/npm-global/node_modules/@anthropic-ai/claude-code/bin/claude.exe';

// ── 参数解析 ──
function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return null;
}
const runId = argValue('runId') ?? `hook-probe-${Date.now()}`;
const onlyArm = argValue('arm'); // 可选：单臂补跑
const OUT = path.join(RESEARCH_ROOT, runId);

const HOME_DIRS = [process.env.USERPROFILE, process.env.HOME, os.homedir()]
  .filter(Boolean).map(String)
  .filter((d, i, a) => a.indexOf(d) === i)
  .sort((a, b) => b.length - a.length);

// ── 脱敏（对齐 context-research-harness.mjs scrub）──
function scrub(text) {
  let out = String(text ?? '');
  for (const home of HOME_DIRS) out = out.split(home).join('<USER_DIR>');
  out = out.split('D:\\software\\code\\claude-link').join('<REPO_DIR>');
  out = out.split('D:/software/code/claude-link').join('<REPO_DIR>');
  out = out.replace(/sk-[a-zA-Z0-9_-]{16,}/g, '<redacted>');
  out = out.replace(/(ANTHROPIC_(?:API_KEY|AUTH_TOKEN)\s*[=:]\s*)\S+/gi, '$1<redacted>');
  out = out.replace(/(Authorization\s*[:=]\s*)(Bearer\s+)?\S+/gi, '$1<redacted>');
  // 其它常见凭据字段兜底
  out = out.replace(/("?(?:api[_-]?key|auth[_-]?token|authorization|password|secret)"?\s*[:=]\s*")[^"]+"/gi, '$1<redacted>"');
  // 要点6：session_id 只留前 8 位（本地 transcript UUID，非凭据，但按计划数据最小化要求截断）。
  out = out.replace(/(["']session_id["']\s*:\s*["'])([0-9a-fA-F-]{8,36})(["'])/g, (m, p1, v, p3) => p1 + v.slice(0, 8) + p3);
  return out;
}
function stableId(raw) {
  if (!raw) return null;
  return crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 10);
}
// 只留 session_id 前 8 位（要点 6）
function scrubSessionId(raw) {
  if (!raw) return null;
  return String(raw).slice(0, 8);
}

// ── 关键词扫描（要点 7；对齐 ccgui find_context_window 语义）──
// 两种语义分开：broad 用于信息性落盘（含 camelCase modelUsage.contextWindow 别名），
// HOOK_SIGNAL 才是判定矩阵的权威信号（§0.3 statusline/hook payload 为 snake_case，产
// {total_input_tokens, total_output_tokens, context_window_size, current_usage, used_percentage, remaining_percentage}）。
// camelCase 的 contextWindow/currentUsage/usedPercentage 是 result 消息 modelUsage 的既有扩展字段（§0.5），
// 不是 hook 通道信号，若混入会把「hook 通道可行」误判为真。
const KEYWORDS = [
  'context_window', 'contextWindow', 'current_usage', 'currentUsage',
  'used_percentage', 'usedPercentage', 'remaining_percentage', 'remainingPercentage',
  'context_window_size', 'total_input_tokens',
];
const HOOK_SIGNAL_KEYWORDS = [
  'context_window', 'current_usage', 'used_percentage', 'remaining_percentage',
  'context_window_size', 'total_input_tokens', 'total_output_tokens',
];
function scanForHookSignal(text) {
  const hits = [];
  for (const kw of HOOK_SIGNAL_KEYWORDS) {
    const idx = text.indexOf(kw);
    if (idx >= 0) hits.push({ keyword: kw, snippet: scrub(text.slice(Math.max(0, idx - 10), idx + kw.length + 70)).slice(0, 80) });
  }
  return hits;
}
function scanTextForKeywords(text) {
  const hits = [];
  for (const kw of KEYWORDS) {
    const idx = text.indexOf(kw);
    if (idx >= 0) {
      const frag = text.slice(Math.max(0, idx - 10), idx + kw.length + 70);
      hits.push({ keyword: kw, snippet: scrub(frag).slice(0, 80) });
    }
  }
  return hits;
}
function scanFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return scanTextForKeywords(text);
}
function scanDir(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const hits = scanFile(p);
        if (hits.length) out.push({ file: path.relative(dir, p), hits });
      }
    }
  };
  walk(dir);
  return out;
}

// ── exe 解析（复刻 claude-code-command-e2e-verify.ts 最小版）──
function isExe(p) {
  if (!p) return false;
  return process.platform === 'win32' ? p.toLowerCase().endsWith('.exe') : true;
}
function resolveFromCmdShim(cmdPath) {
  try {
    const text = fs.readFileSync(cmdPath, 'utf8');
    const dir = path.dirname(cmdPath);
    const m = text.match(/"[^"]*?\.exe"|[\w./\\:-]+\.exe/i);
    if (!m) return undefined;
    let p = m[0].replace(/"/g, '').replace(/%dp0%/gi, dir + path.sep).replace(/%~dp0/gi, dir + path.sep);
    if (!path.isAbsolute(p)) p = path.join(dir, p);
    p = path.normalize(p);
    return fs.existsSync(p) && isExe(p) ? p : undefined;
  } catch { return undefined; }
}
function resolveClaudeExe() {
  const override = process.env.CLAUDE_LINK_CLAUDE_EXE;
  if (override && fs.existsSync(override) && isExe(override)) return override;
  if (fs.existsSync(DEMO_EXE_PATH) && isExe(DEMO_EXE_PATH)) return DEMO_EXE_PATH;
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(lookup, ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const candidates = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && fs.existsSync(l));
    if (process.platform === 'win32') {
      const direct = candidates.find((c) => isExe(c));
      if (direct) return direct;
      for (const c of candidates) {
        if (c.toLowerCase().endsWith('.cmd') || c.toLowerCase().endsWith('.bat')) {
          const exe = resolveFromCmdShim(c);
          if (exe) return exe;
        }
      }
    } else if (candidates[0]) return candidates[0];
  } catch { /* not in PATH */ }
  return null;
}

// ── 凭据链（要点 2；key 绝不落盘）──
// process env ANTHROPIC_API_KEY(+BASE_URL/MODEL) > CLAUDE_LINK_PROVIDER_JSON > user ~/.claude/settings.json env 块。
function readUserSettingsEnv() {
  const dirs = [process.env.USERPROFILE, process.env.HOME, os.homedir()].filter(Boolean);
  for (const d of dirs) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(d, '.claude', 'settings.json'), 'utf8'));
      const e = j?.env;
      if (e && typeof e === 'object' && !Array.isArray(e)) {
        const out = {};
        for (const [k, v] of Object.entries(e)) if (typeof v === 'string') out[k] = v;
        return out;
      }
    } catch { /* skip */ }
  }
  return {};
}
function resolveCredentials() {
  let key = process.env.ANTHROPIC_API_KEY;
  let base = process.env.ANTHROPIC_BASE_URL;
  let model = process.env.ANTHROPIC_MODEL;
  let source = 'env';
  if (key) { /* env 已提供 */ }
  else if (process.env.CLAUDE_LINK_PROVIDER_JSON) {
    try {
      const j = JSON.parse(process.env.CLAUDE_LINK_PROVIDER_JSON);
      key = j.apiKey || j.ANTHROPIC_API_KEY || j.key;
      base = j.baseUrl || j.ANTHROPIC_BASE_URL || j.baseURL;
      model = j.model || j.ANTHROPIC_MODEL;
      source = 'CLAUDE_LINK_PROVIDER_JSON';
    } catch { /* fallthrough */ }
  }
  if (!key) {
    const u = readUserSettingsEnv();
    if (u.ANTHROPIC_API_KEY) {
      key = u.ANTHROPIC_API_KEY;
      base = base || u.ANTHROPIC_BASE_URL;
      model = model || u.ANTHROPIC_MODEL;
      source = 'user-settings';
    }
  }
  if (!key) return null;
  const env = { ...process.env, ANTHROPIC_API_KEY: key };
  if (base) env.ANTHROPIC_BASE_URL = base;
  if (model) env.ANTHROPIC_MODEL = model;
  return { env, source };
}

// ── 隔离目录准备（要点 1）──
function prepIsolation(arm) {
  const cwd = path.join(OUT, 'iso', `${arm}-cwd`);
  const config = path.join(OUT, 'iso', `${arm}-config`);
  const home = path.join(OUT, 'iso', `${arm}-home`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  // 预置 README.md + package.json（Read 工具目标；F 臂多步）
  if (!fs.existsSync(path.join(cwd, 'README.md'))) {
    fs.writeFileSync(path.join(cwd, 'README.md'), '# hook-probe\n\nThis is the hook-probe experiment workspace.\n', 'utf8');
  }
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'hook-probe', version: '1.0.0' }, null, 2) + '\n', 'utf8');
  }
  // 防首跑挂起：hasCompletedOnboarding（.claude.json 放 HOME 与 config 两处兜底）
  const onboarding = JSON.stringify({ hasCompletedOnboarding: true }) + '\n';
  fs.writeFileSync(path.join(home, '.claude.json'), onboarding, 'utf8');
  fs.writeFileSync(path.join(config, '.claude.json'), onboarding, 'utf8');
  return { cwd, config, home };
}
function isoEnv(creds, iso) {
  const env = { ...creds.env };
  env.CLAUDE_CONFIG_DIR = iso.config;
  env.USERPROFILE = iso.home;
  env.HOME = iso.home;
  return env;
}

// ── capture-stdin helper（command hook / statusline 把 stdin 落盘）──
// 用 .cjs 扩展名：CLI 以 `node <helper>` 直接 spawn，.cjs 保证 CommonJS require 可用（.mjs 会走 ESM 报 require undefined）。
function writeCaptureHelper(iso) {
  const p = path.join(iso.config, 'capture-stdin.cjs');
  fs.writeFileSync(p, [
    "const fs = require('fs');",
    "let data = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (c) => { data += c; });",
    "process.stdin.on('error', () => process.exit(0));",
    "process.stdin.on('end', () => {",
    "  const out = process.argv[2];",
    "  if (out) { try { fs.appendFileSync(out, data + '\\n---\\n'); } catch {} }",
    "  process.stdout.write('CAPTURED ' + data.length + ' bytes');",
    "});",
  ].join('\n') + '\n', 'utf8');
  return p;
}

// ── 网关抖动判定（要点 8）──
function isGatewayJitter(errText) {
  return /502|503|504|529|overloaded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|rate.?limit/i.test(String(errText));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)),
  ]);
}

// 带退避重试的运行封装（重试即全新 query）
async function runWithRetry(arm, fn, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (isGatewayJitter(msg) && i < attempts - 1) {
        const wait = i === 0 ? 8000 : 20000;
        console.log(`  [${arm}] 网关抖动，${wait / 1000}s 后重试（第 ${i + 1} 次失败）：${scrub(msg).slice(0, 120)}`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ── SDK 臂通用：for-await 全量消息 + hook 回调入参落盘 ──
async function runSdkArm(arm, { hooks, includeHookEvents, prompt, maxTurns = 4, recordCallbacks = false }) {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const iso = prepIsolation(arm);
  const creds = resolveCredentials();
  if (!creds) throw new Error('无凭据（resolveCredentials 返回 null）');
  const env = isoEnv(creds, iso);
  const msgsFile = path.join(OUT, `${arm}-sdk.messages.jsonl`);
  const cbFile = path.join(OUT, `${arm}-hook-callbacks.jsonl`);
  fs.writeFileSync(msgsFile, '', 'utf8');
  if (recordCallbacks) fs.writeFileSync(cbFile, '', 'utf8');

  const q = sdk.query({
    prompt,
    options: {
      cwd: iso.cwd,
      pathToClaudeCodeExecutable: resolveClaudeExe(),
      permissionMode: 'bypassPermissions',
      maxTurns,
      includeHookEvents,
      env,
      ...(hooks ? { hooks } : {}),
    },
  });

  const msgCount = { hookStarted: 0, hookProgress: 0, hookResponse: 0, hookCallback: 0, init: 0, result: 0, other: 0 };
  let terminate = false;
  const hookMessageHasCtx = [];
  const callbackHasCtx = [];
  const callbackSamples = [];

  try {
    for await (const msg of q) {
      const rec = scrub(JSON.stringify(msg));
      fs.appendFileSync(msgsFile, rec + '\n', 'utf8');
      if (msg.type === 'system') {
        if (msg.subtype === 'init') msgCount.init++;
        else if (msg.subtype === 'hook_started') msgCount.hookStarted++;
        else if (msg.subtype === 'hook_progress') msgCount.hookProgress++;
        else if (msg.subtype === 'hook_response') msgCount.hookResponse++;
        else if (msg.subtype === 'hook_callback') msgCount.hookCallback++;
        // hook 生命周期消息字段扫描（权威信号：snake_case context_window 家族）
        if (msg.subtype === 'hook_started' || msg.subtype === 'hook_progress' || msg.subtype === 'hook_response') {
          const hits = scanForHookSignal(JSON.stringify(msg));
          for (const h of hits) hookMessageHasCtx.push({ subtype: msg.subtype, ...h });
        }
        // hook_callback 入参扫描
        if (msg.subtype === 'hook_callback' && msg.input) {
          const hits = scanForHookSignal(JSON.stringify(msg.input));
          if (hits.length) callbackHasCtx.push({ hookEvent: msg.input?.hook_event_name, hits });
        }
      } else if (msg.type === 'result') {
        msgCount.result++;
      } else {
        msgCount.other++;
      }
      if (msg.type === 'result') { terminate = true; break; }
    }
  } catch (e) {
    if (isGatewayJitter(String(e?.message || e))) throw e;
    // 其它错误：记录后继续（SDK 迭代错误不等于实验失败，summary 里区分）
    fs.appendFileSync(msgsFile, scrub(JSON.stringify({ __query_error__: String(e?.message || e) })) + '\n', 'utf8');
  } finally {
    try { q.close(); } catch { /* closed */ }
  }

  // 若注册了 JS 回调，回调入参由 SDK 直接调用（非 hook_callback 消息），在回调内落盘。
  return { arm, msgCount, hookMessageHasCtx, callbackHasCtx, callbackSamples, terminate };
}

// ── A 臂：注册 SessionStart/PostToolUse/Stop noop 回调，includeHookEvents=true ──
async function armA() {
  const iso = prepIsolation('a');
  const cbFile = path.join(OUT, 'a-hook-callbacks.jsonl');
  fs.writeFileSync(cbFile, '', 'utf8');
  const callbackHasCtx = [];
  const mkHook = (eventName) => ({
    hooks: [async (input) => {
      fs.appendFileSync(cbFile, scrub(JSON.stringify(input)) + '\n', 'utf8');
      const hits = scanForHookSignal(JSON.stringify(input));
      for (const h of hits) callbackHasCtx.push({ hookEvent: eventName, ...h });
      return { continue: true };
    }],
  });
  const hooks = {
    SessionStart: [mkHook('SessionStart')],
    PostToolUse: [mkHook('PostToolUse')],
    Stop: [mkHook('Stop')],
  };
  const r = await runSdkArm('a', {
    hooks, includeHookEvents: true,
    prompt: '请用 Read 工具读取 README.md 文件，然后只回复该文件的第一个词。',
    maxTurns: 4,
  });
  r.callbackHasCtx = callbackHasCtx;
  r.callbackCount = (fs.readFileSync(cbFile, 'utf8').split('\n').filter(Boolean)).length;
  return r;
}

// ── B 臂：不注册 hooks，includeHookEvents=true ──
async function armB() {
  return runSdkArm('b', {
    hooks: null, includeHookEvents: true,
    prompt: '请用 Read 工具读取 README.md 文件，然后只回复该文件的第一个词。',
    maxTurns: 4,
  });
}

// ── C 臂：注册 hooks 但 includeHookEvents=false ──
async function armC() {
  const iso = prepIsolation('c');
  const cbFile = path.join(OUT, 'c-hook-callbacks.jsonl');
  fs.writeFileSync(cbFile, '', 'utf8');
  const mkHook = (eventName) => ({
    hooks: [async (input) => {
      fs.appendFileSync(cbFile, scrub(JSON.stringify(input)) + '\n', 'utf8');
      return { continue: true };
    }],
  });
  const hooks = {
    SessionStart: [mkHook('SessionStart')],
    PostToolUse: [mkHook('PostToolUse')],
    Stop: [mkHook('Stop')],
  };
  const r = await runSdkArm('c', {
    hooks, includeHookEvents: false,
    prompt: '请用 Read 工具读取 README.md 文件，然后只回复该文件的第一个词。',
    maxTurns: 4,
  });
  r.callbackCount = (fs.readFileSync(cbFile, 'utf8').split('\n').filter(Boolean)).length;
  return r;
}

// ── D/E 臂：直连 CLI，settings.json 配 command hooks / statusline，hook stdin 落盘 ──
function spawnCli(args, { env, cwd, stdinMode }) {
  return new Promise((resolve) => {
    const exe = resolveClaudeExe();
    const child = spawn(exe, args, {
      cwd, env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ code: -1, stdout, stderr, err: e.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 300000);
  });
}

async function armD() {
  const iso = prepIsolation('d');
  const creds = resolveCredentials();
  const env = isoEnv(creds, iso);
  const helper = writeCaptureHelper(iso);
  const stdinOut = path.join(OUT, 'd-cli-hook-stdin.jsonl').replace(/\\/g, '/');
  fs.writeFileSync(stdinOut, '', 'utf8');
  const settings = {
    hooks: {
      PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: `node ${helper} ${stdinOut}` }] }],
      Stop: [{ hooks: [{ type: 'command', command: `node ${helper} ${stdinOut}` }] }],
    },
  };
  fs.writeFileSync(path.join(iso.config, 'settings.json'), JSON.stringify(settings, null, 2) + '\n', 'utf8');
  const prompt = '请用 Read 工具读取 README.md 文件，然后只回复该文件的第一个词。';
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--dangerously-skip-permissions'];
  const r = await spawnCli(args, { env, cwd: iso.cwd });
  fs.writeFileSync(path.join(OUT, 'd-cli-stream.jsonl'),
    (r.stdout || '').split(/\r?\n/).filter(Boolean).map((l) => scrub(l)).join('\n') + '\n', 'utf8');
  if (r.stderr) fs.appendFileSync(path.join(OUT, 'd-cli-stream.jsonl'), scrub('STDERR: ' + r.stderr) + '\n', 'utf8');
  // hook stdin 由 CLI helper 进程直接落盘（未经 scrub），此处补一轮脱敏重写。
  if (fs.existsSync(stdinOut)) {
    const raw = fs.readFileSync(stdinOut, 'utf8');
    fs.writeFileSync(stdinOut, scrub(raw), 'utf8');
  }
  return { arm: 'd', exitCode: r.code, stdoutBytes: (r.stdout || '').length, stderrBytes: (r.stderr || '').length, err: r.err };
}

async function armE() {
  const iso = prepIsolation('e');
  const creds = resolveCredentials();
  const env = isoEnv(creds, iso);
  const helper = writeCaptureHelper(iso);
  const stdinOut = path.join(OUT, 'e-cli-statusline-stdin.jsonl').replace(/\\/g, '/');
  fs.writeFileSync(stdinOut, '', 'utf8');
  const settings = {
    statusLine: { type: 'command', command: `node ${helper} ${stdinOut}`, refreshInterval: 5 },
  };
  fs.writeFileSync(path.join(iso.config, 'settings.json'), JSON.stringify(settings, null, 2) + '\n', 'utf8');
  const prompt = '请用 Read 工具读取 README.md 文件，然后只回复该文件的第一个词。';
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  const r = await spawnCli(args, { env, cwd: iso.cwd });
  fs.writeFileSync(path.join(OUT, 'e-cli-stream.jsonl'),
    (r.stdout || '').split(/\r?\n/).filter(Boolean).map((l) => scrub(l)).join('\n') + '\n', 'utf8');
  return { arm: 'e', exitCode: r.code, stdoutBytes: (r.stdout || '').length, err: r.err };
}

// ── F 臂：中途轮询（必做）──
async function armF() {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const iso = prepIsolation('f');
  const creds = resolveCredentials();
  const env = isoEnv(creds, iso);
  const msgsFile = path.join(OUT, 'f-sdk.messages.jsonl');
  const pollFile = path.join(OUT, 'f-polling-timeline.jsonl');
  fs.writeFileSync(msgsFile, '', 'utf8');
  fs.writeFileSync(pollFile, '', 'utf8');

  const startT0 = Date.now();
  const timeline = []; // 消息时间线：{t, elapsedMs, type, subtype}
  const polls = []; // 轮询时间线：{t, elapsedMs, ok, totalTokens, percentage, latencyMs, err}
  let done = false;
  let firstToolResultAt = null;
  let resultAt = null;

  const q = sdk.query({
    prompt: '请依次用 Read 工具读取 README.md 和 package.json 两个文件，再用 Bash 工具运行 `dir` 列出当前目录内容，最后回复"完成"。',
    options: {
      cwd: iso.cwd,
      pathToClaudeCodeExecutable: resolveClaudeExe(),
      permissionMode: 'bypassPermissions',
      maxTurns: 8,
      includeHookEvents: false,
      env,
    },
  });

  // 轮询器：从 init 起每 5s 轮询 getContextUsage（5s 超时），直到 result
  const poller = (async () => {
    while (!done) {
      await sleep(5000);
      if (done) break;
      const t0 = Date.now();
      try {
        const r = await withTimeout(q.getContextUsage(), 5000, 'getContextUsage');
        polls.push({ t: Date.now(), elapsedMs: Date.now() - startT0, ok: true, totalTokens: r.totalTokens, percentage: r.percentage, latencyMs: Date.now() - t0 });
      } catch (e) {
        polls.push({ t: Date.now(), elapsedMs: Date.now() - startT0, ok: false, err: scrub(String(e?.message || e)).slice(0, 120), latencyMs: Date.now() - t0 });
      }
    }
  })();

  let queryErr = null;
  try {
    for await (const msg of q) {
      const rec = { t: Date.now(), elapsedMs: Date.now() - startT0, type: msg.type, subtype: msg.subtype };
      timeline.push(rec);
      fs.appendFileSync(msgsFile, scrub(JSON.stringify(msg)) + '\n', 'utf8');
      // user 消息含 tool_result → 记录首个工具结果落地时刻
      if (msg.type === 'user') {
        const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
        const hasToolResult = blocks.some((b) => b?.type === 'tool_result');
        if (hasToolResult && !firstToolResultAt) firstToolResultAt = Date.now() - startT0;
      }
      if (msg.type === 'result') { resultAt = Date.now() - startT0; done = true; break; }
    }
  } catch (e) {
    queryErr = String(e?.message || e);
    timeline.push({ t: Date.now(), elapsedMs: Date.now() - startT0, type: '__query_error__', subtype: scrub(queryErr).slice(0, 120) });
  } finally {
    done = true;
    try { q.close(); } catch { /* closed */ }
  }
  await poller;

  // 落盘合并时间线（消息 + 轮询，按 elapsedMs 排序）
  const merged = [
    ...timeline.map((x) => ({ ...x, kind: 'msg' })),
    ...polls.map((x) => ({ ...x, kind: 'poll' })),
  ].sort((a, b) => a.elapsedMs - b.elapsedMs);
  fs.writeFileSync(pollFile, merged.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');

  // 判定：首个 tool_result 之后、result 之前 ≥1 次轮询成功，且数值随工具结果增长
  const midPolls = polls.filter((p) => p.ok && firstToolResultAt != null && p.elapsedMs >= firstToolResultAt && (resultAt == null || p.elapsedMs < resultAt));
  const firstMid = midPolls[0];
  const lastMid = midPolls[midPolls.length - 1];
  const grew = firstMid && lastMid ? lastMid.totalTokens > firstMid.totalTokens : false;

  return { arm: 'f', polls, timeline, firstToolResultAt, resultAt, midPollCount: midPolls.length, grew, queryErr };
}

// ── 判定矩阵落行（summary.json）──
function readScrubbed(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}
function computeMatrix(results) {
  const has = (arr) => Array.isArray(arr) && arr.length > 0;
  // R1/R2：SDK 臂的 hook 生命周期消息 / 回调入参（已在臂内用 HOOK_SIGNAL 语义扫描）。
  const hookMsgCtx = (r) => has(r?.hookMessageHasCtx);
  const callbackCtx = (r) => has(r?.callbackHasCtx);

  const R1 = hookMsgCtx(results.a) || hookMsgCtx(results.b);
  const R2 = callbackCtx(results.a);

  // R3：D 臂直连 CLI——stream 或 hook stdin 是否含权威 hook 信号（snake_case context_window 家族）。
  const dStreamSignal = scanForHookSignal(readScrubbed(path.join(OUT, 'd-cli-stream.jsonl')));
  const dStdinSignal = scanForHookSignal(readScrubbed(path.join(OUT, 'd-cli-hook-stdin.jsonl')));
  const R3 = has(dStreamSignal) || has(dStdinSignal);

  // R4：A/D 全无 → hook 通道不带（与静态侦察一致）。
  const R4 = !R1 && !R2 && !R3;

  // E+：E 臂 statusline stdin 含权威信号且稳定产出。
  const eStdinText = readScrubbed(path.join(OUT, 'e-cli-statusline-stdin.jsonl'));
  const eSignal = scanForHookSignal(eStdinText);
  const EPlus = results.e && eStdinText.trim().length > 0 && has(eSignal);

  // F+：F 臂在首个 tool_result 之后、result 之前 ≥1 次轮询成功。
  const FPlus = results.f ? results.f.midPollCount >= 1 : false;

  return { R1, R2, R3, R4, EPlus, FPlus };
}

function writeSummary(results, matrix, versions) {
  const summary = {
    runId,
    generatedAt: new Date().toISOString(),
    versions,
    matrix,
    arms: {},
    keywordScan: scanDir(OUT).map((s) => ({ file: s.file, hits: s.hits.map((h) => h.keyword) })),
  };
  for (const [arm, r] of Object.entries(results)) {
    if (!r) continue;
    summary.arms[arm] = {
      terminate: r.terminate,
      msgCount: r.msgCount,
      callbackCount: r.callbackCount,
      exitCode: r.exitCode,
      midPollCount: r.midPollCount,
      grew: r.grew,
      firstToolResultAtMs: r.firstToolResultAt,
      resultAtMs: r.resultAt,
      hookMessageHasCtx: r.hookMessageHasCtx,
      callbackHasCtx: r.callbackHasCtx,
    };
  }
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  return summary;
}

// ── 主流程 ──
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // 基线 git status 存档 + node/npm 版本（Task 1 Step 1）
  try {
    const status = execFileSync('git', ['status', '--short'], { cwd: 'D:/software/code/claude-link', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    fs.writeFileSync(path.join(OUT, 'baseline-git-status.txt'), status, 'utf8');
  } catch (e) {
    fs.writeFileSync(path.join(OUT, 'baseline-git-status.txt'), '(git status 失败：' + e.message + ')\n', 'utf8');
  }
  fs.writeFileSync(path.join(OUT, 'baseline-runtime.txt'),
    `node=${process.version}\nnpm=${(() => { try { return execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })()}\nplatform=${process.platform} ${os.release()}\n`, 'utf8');

  // 版本钉死（Task 1 Step 2）
  const sdkPkg = JSON.parse(fs.readFileSync('D:/software/code/claude-link/node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8'));
  const exe = resolveClaudeExe();
  let cliVersion = null;
  if (exe) {
    try { cliVersion = execFileSync(exe, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* ignore */ }
  }
  const versions = { sdk: sdkPkg.version, cli: cliVersion, exe };
  console.log(`runId=${runId}`);
  console.log(`sdk=${versions.sdk} cli=${cliVersion}`);
  console.log(`exe=${exe}`);

  // 前置失败：exe 缺失（exit 2）
  if (!exe) {
    console.error('前置失败：未解析到 claude.exe（CLAUDE_LINK_CLAUDE_EXE / demo 路径 / where claude 均未命中）。exit 2');
    writeSummary({}, { R1: false, R2: false, R3: false, R4: false, EPlus: false, FPlus: false }, versions);
    process.exit(2);
  }
  // 前置失败：无凭据（exit 2，不烧 query）
  const creds = resolveCredentials();
  if (!creds) {
    console.error('前置失败：未检出 ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN（env 或 ~/.claude/settings.json 各层）。无凭据自检完成，不烧 query。exit 2');
    writeSummary({}, { R1: false, R2: false, R3: false, R4: false, EPlus: false, FPlus: false }, versions);
    process.exit(2);
  }
  console.log(`凭据来源=${creds.source}（key 不落盘）`);

  const armRunners = { a: armA, b: armB, c: armC, d: armD, e: armE, f: armF };
  const selected = onlyArm ? [onlyArm] : ['a', 'b', 'c', 'd', 'f']; // 默认 A/B/C/D/F，E 可选
  const results = {};
  let failed = false;

  for (const arm of selected) {
    if (!armRunners[arm]) { console.error(`未知臂：${arm}`); process.exit(1); }
    console.log(`\n=== 臂 ${arm.toUpperCase()} 开始 ===`);
    try {
      results[arm] = await runWithRetry(arm, armRunners[arm]);
      console.log(`  [${arm}] 完成：${JSON.stringify({
        terminate: results[arm].terminate,
        msgCount: results[arm].msgCount,
        callbackCount: results[arm].callbackCount,
        midPollCount: results[arm].midPollCount,
        grew: results[arm].grew,
        exitCode: results[arm].exitCode,
      })}`);
    } catch (e) {
      failed = true;
      console.error(`  [${arm}] 失败（证据保留）：${scrub(String(e?.message || e))}`);
      results[arm] = { arm, error: scrub(String(e?.message || e)), terminate: false };
    }
  }

  const matrix = computeMatrix(results);
  const summary = writeSummary(results, matrix, versions);
  console.log('\n=== 判定矩阵 ===');
  console.log(JSON.stringify(matrix, null, 2));
  console.log('\nsummary.json 已落盘：' + path.join(OUT, 'summary.json'));

  if (failed) {
    console.error('\n存在失败臂（exit 1），证据已保留。');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', scrub(String(e?.message || e)));
  process.exit(1);
});
