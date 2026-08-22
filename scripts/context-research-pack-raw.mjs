// scripts/context-research-pack-raw.mjs
// review-v4 §11.3/§3.6-5 补采：把成功 E2E run 的真实 payload 派生为计划命名的原始事件文件。
//
// 用法（须先有一份成功跑完的 test:cdp:context-e2e 证据目录）：
//   node scripts/context-research-pack-raw.mjs --e2e e2e-cdp-ctx-<runId> --out run-2026-08-21-205616
//
// 产物（全部由 context-payloads.json / scenarios.json / S12 结果机械派生，无手工数字）：
//   manifest.json                 —— 来源 runId、文件映射、node/npm、git 状态、脱敏声明
//   sdk-events.jsonl              —— CONTEXT_UPDATE 全量 payload 流（SDK 事件的 renderer 可见投影）
//   runtime-context-window.jsonl  —— source=runtime-live 的当前窗口快照（含 samplePhase/queryGeneration）
//   sdk-get-context-usage.jsonl   —— getContextUsage() 结局：成功（runtime-live）与失败（post-turn 兜底 diagnostic）
//   model-usage.jsonl             —— source=estimated-turn-usage 的回合用量
//   compaction-events.jsonl       —— S10 场景记录的压缩时序 payload
//   comparison-table.json         —— 按 queryGeneration 重建，runtimeCurrentUsed 拆分为
//                                    runtimeQueryStartUsed / runtimePostTurnUsed（§3.6-5 时点区分）
// 旧 comparison-table.json 备份为 comparison-table.pre-review-v4.json。
// 另在 source-contract-matrix.md 追加「runtime snapshot 采样时点」章节（§3.6-5）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const RESEARCH_ROOT = 'D:/software/Cache/claude-link/context-research';
const HOME_DIRS = [process.env.USERPROFILE, process.env.HOME, os.homedir()].filter(Boolean).map(String).filter((d, i, a) => a.indexOf(d) === i).sort((a, b) => b.length - a.length);
function scrub(text) {
  let out = String(text ?? '');
  for (const home of HOME_DIRS) out = out.split(home).join('<USER_DIR>');
  out = out.split('D:\\software\\code\\claude-link').join('<REPO_DIR>');
  out = out.split('D:/software/code/claude-link').join('<REPO_DIR>');
  out = out.replace(/sk-[a-zA-Z0-9_-]{16,}/g, '<redacted>');
  out = out.replace(/(ANTHROPIC_(?:API_KEY|AUTH_TOKEN)\s*[=:]\s*)\S+/gi, '$1<redacted>');
  out = out.replace(/(Authorization\s*[:=]\s*)(Bearer\s+)?\S+/gi, '$1<redacted>');
  return out;
}
function sh(cmd) { try { return scrub(String(execSync(cmd, { encoding: 'utf8', cwd: process.cwd() })).trim()); } catch { return null; } }
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };

const e2eDirName = arg('--e2e');
const outDirName = arg('--out');
if (!e2eDirName || !outDirName) { console.error('用法：node scripts/context-research-pack-raw.mjs --e2e <e2e-run-dir> --out <research-run-dir>'); process.exit(2); }
const e2eDir = path.join(RESEARCH_ROOT, e2eDirName);
const outDir = path.join(RESEARCH_ROOT, outDirName);
const payloads = JSON.parse(fs.readFileSync(path.join(e2eDir, 'context-payloads.json'), 'utf8'));
const scenarios = JSON.parse(fs.readFileSync(path.join(e2eDir, 'scenarios.json'), 'utf8'));
const s12Path = path.join(outDir, 'S12-resume-result.json');
const s12 = fs.existsSync(s12Path) ? JSON.parse(fs.readFileSync(s12Path, 'utf8')) : null;
fs.mkdirSync(outDir, { recursive: true });

const writeJsonl = (file, rows) => fs.writeFileSync(path.join(outDir, file), rows.map((r) => JSON.stringify(scrubJson(r))).join('\n') + '\n', 'utf8');
function scrubJson(v) {
  if (typeof v === 'string') return scrub(v);
  if (Array.isArray(v)) return v.map(scrubJson);
  if (v && typeof v === 'object') { const o = {}; for (const [k, val] of Object.entries(v)) o[k] = scrubJson(val); return o; }
  return v;
}

// ── sdk-events.jsonl：全量 CONTEXT_UPDATE 流 ──
writeJsonl('sdk-events.jsonl', payloads.map((p) => ({
  t: p.t ?? null,
  capturedAt: new Date(p.t ?? p.refreshedAt ?? Date.now()).toISOString(),
  sessionId: p.sessionId ?? null,
  queryGeneration: p.queryGeneration ?? null,
  kind: p.source === 'runtime-live' ? 'getContextUsage-ok'
    : p.source === 'estimated-turn-usage' ? 'result-turn-usage'
    : p.source === 'native-context' ? 'slash-context-reconcile'
    : p.source === 'reconciled' ? 'slash-context-reconcile'
    : 'context-unavailable',
  source: p.source, freshness: p.freshness, consistency: p.consistency ?? null,
  samplePhase: p.samplePhase ?? null,
  diagnostic: p.diagnostic ?? null,
})));

// ── runtime-context-window.jsonl：当前窗口 runtime 快照（时点标注）──
writeJsonl('runtime-context-window.jsonl', payloads.filter((p) => p.source === 'runtime-live').map((p) => ({
  t: p.t ?? null, sessionId: p.sessionId ?? null, queryGeneration: p.queryGeneration ?? null,
  samplePhase: p.samplePhase ?? null,
  usedTokens: p.currentContextUsedTokens ?? null, capacityTokens: p.contextWindowCapacityTokens ?? null,
  percentage: p.currentContextUsedPercent ?? null, model: p.model ?? null,
})));

// ── sdk-get-context-usage.jsonl：getContextUsage() 成功/失败结局 + post-turn 官方探针 ──
// P2 mid-turn：outcome 区分 mid-turn-ok（回合中途轮询成功）与 ok（query-start/post-turn/post-compaction），
// 避免中途轮询成功污染 post-turn 失败口径（post-turn 失败=回合末 control request 已被 SDK 拒绝）。
// post-turn 官方探针（本计划）：native-context + post-turn payload → outcome='probe-ok'（回合外旁路，
// 精确回合末值，零 API），与 SDK 回合内 post-turn（常失败）口径分开。
writeJsonl('sdk-get-context-usage.jsonl', payloads.filter((p) =>
  p.source === 'runtime-live' ||
  (p.source === 'native-context' && p.samplePhase === 'post-turn') ||
  (p.source === 'unavailable' && /post-turn|runtime 当前窗口/.test(String(p.diagnostic ?? ''))),
).map((p) => ({
  t: p.t ?? null, sessionId: p.sessionId ?? null, queryGeneration: p.queryGeneration ?? null,
  outcome: p.source === 'native-context' ? 'probe-ok'
    : p.source === 'runtime-live' ? (p.samplePhase === 'mid-turn' ? 'mid-turn-ok' : 'ok')
    : 'failed',
  samplePhase: p.samplePhase ?? null,
  usedTokens: p.currentContextUsedTokens ?? null, capacityTokens: p.contextWindowCapacityTokens ?? null,
  diagnostic: p.diagnostic ?? null,
})));

// ── model-usage.jsonl：回合 model 用量 ──
writeJsonl('model-usage.jsonl', payloads.filter((p) => p.source === 'estimated-turn-usage').map((p) => ({
  t: p.t ?? null, sessionId: p.sessionId ?? null, queryGeneration: p.queryGeneration ?? null,
  inputTokens: p.inputTokens ?? null, outputTokens: p.outputTokens ?? null,
  turnInputTokens: p.turnInputTokens ?? null, turnCacheReadTokens: p.turnCacheReadTokens ?? null,
  turnCacheCreationTokens: p.turnCacheCreationTokens ?? null, turnOutputTokens: p.turnOutputTokens ?? null,
})));

// ── compaction-events.jsonl：S10 压缩时序 ──
const compactRows = [];
const s10 = scenarios.S10;
if (Array.isArray(s10?.payloads)) {
  for (const p of s10.payloads) compactRows.push({ t: p.t ?? null, sessionId: p.sessionId ?? null, queryGeneration: p.queryGeneration ?? null, stage: 'compact-boundary', source: p.source, freshness: p.freshness, compactedJustNow: p.compactedJustNow === true, diagnostic: p.diagnostic ?? null });
}
if (compactRows.length === 0) compactRows.push({ note: '本 run 未捕获压缩 payload（S10 证据见 scenarios.json）' });
writeJsonl('compaction-events.jsonl', compactRows);

// ── comparison-table.json：按 queryGeneration 重建，runtime 时点拆分（§3.6-5）──
const oldTablePath = path.join(outDir, 'comparison-table.json');
if (fs.existsSync(oldTablePath) && !fs.existsSync(path.join(outDir, 'comparison-table.pre-review-v4.json'))) {
  fs.copyFileSync(oldTablePath, path.join(outDir, 'comparison-table.pre-review-v4.json'));
}
// 场景 after-dom 按 lastPayload.queryGeneration 关联，供 UI 列使用。
const domByGen = new Map();
for (const v of Object.values(scenarios)) {
  for (const key of ['after', '']) {
    const node = key ? v?.[key] : v;
    const gen = node?.lastPayload?.queryGeneration ?? node?.dom ? node?.lastPayload?.queryGeneration ?? null : null;
    if (typeof gen === 'number' && node?.dom?.title && !domByGen.has(gen)) domByGen.set(gen, node.dom.title);
  }
}
const gens = [...new Set(payloads.map((p) => p.queryGeneration).filter((g) => typeof g === 'number'))].sort((a, b) => a - b);
const rows = gens.map((g) => {
  const mine = payloads.filter((p) => p.queryGeneration === g);
  const qs = mine.find((p) => p.source === 'runtime-live' && p.samplePhase === 'query-start') ?? null;
  const mt = mine.find((p) => p.source === 'runtime-live' && p.samplePhase === 'mid-turn') ?? null;
  const pt = mine.find((p) => p.source === 'runtime-live' && p.samplePhase === 'post-turn') ?? null;
  const ptProbe = mine.find((p) => p.source === 'native-context' && p.samplePhase === 'post-turn') ?? null;
  const ptFallback = mine.find((p) => p.source === 'unavailable' && /post-turn/.test(String(p.diagnostic ?? ''))) ?? null;
  const turn = mine.find((p) => p.source === 'estimated-turn-usage') ?? null;
  const native = mine.find((p) => p.source === 'native-context' || p.source === 'reconciled') ?? null;
  const uiTitle = domByGen.get(g) ?? null;
  const uiPct = uiTitle && /上下文已用\s*(\d+(?:\.\d+)?)%/.test(uiTitle) ? Number(uiTitle.match(/上下文已用\s*(\d+(?:\.\d+)?)%/)[1]) : null;
  const terminal = mine[mine.length - 1] ?? null;
  return {
    key: `gen-${g}`,
    sessionId: mine[0]?.sessionId ?? null,
    // §3.6-5：query-start / mid-turn / post-turn 分列，不再共用一个无时点标注的 runtimeCurrentUsed。
    runtimeQueryStartUsed: qs?.currentContextUsedTokens ?? null,
    runtimeMidTurnUsed: mt?.currentContextUsedTokens ?? null,
    // post-turn 官方探针（本计划）：探针值（native-context + post-turn）优先，SDK 回合内值兜底。
    runtimePostTurnUsed: ptProbe?.currentContextUsedTokens ?? pt?.currentContextUsedTokens ?? null,
    runtimePostTurnOutcome: ptProbe ? 'probe-fresh' : pt ? 'fresh' : ptFallback ? 'fallback-stale' : 'none',
    runtimeCapacity: qs?.contextWindowCapacityTokens ?? mt?.contextWindowCapacityTokens ?? pt?.contextWindowCapacityTokens ?? null,
    sdkGetContextUsed: qs?.currentContextUsedTokens ?? mt?.currentContextUsedTokens ?? pt?.currentContextUsedTokens ?? null,
    messageInput: turn?.turnInputTokens ?? null,
    cacheRead: turn?.turnCacheReadTokens ?? null,
    cacheCreation: turn?.turnCacheCreationTokens ?? null,
    turnOutput: turn?.turnOutputTokens ?? null,
    nativeUsed: native?.currentContextUsedTokens ?? null,
    nativeCapacity: native?.contextWindowCapacityTokens ?? null,
    nativePercentage: native?.currentContextUsedPercent ?? null,
    uiTitle, uiPercentage: uiPct,
    terminalSource: terminal?.source ?? null,
    terminalFreshness: terminal?.freshness ?? null,
    terminalSamplePhase: terminal?.samplePhase ?? null,
  };
});
fs.writeFileSync(oldTablePath, JSON.stringify(scrubJson(rows), null, 2), 'utf8');

// ── source-contract-matrix.md：追加采样时点契约章节（§3.6-5）──
const matrixPath = path.join(outDir, 'source-contract-matrix.md');
if (fs.existsSync(matrixPath) && !fs.readFileSync(matrixPath, 'utf8').includes('采样时点（review-v4')) {
  const qsCount = payloads.filter((p) => p.source === 'runtime-live' && p.samplePhase === 'query-start').length;
  const mtCount = payloads.filter((p) => p.source === 'runtime-live' && p.samplePhase === 'mid-turn').length;
  const ptOk = payloads.filter((p) => p.source === 'runtime-live' && p.samplePhase === 'post-turn').length;
  const ptProbe = payloads.filter((p) => p.source === 'native-context' && p.samplePhase === 'post-turn').length;
  const ptFail = payloads.filter((p) => p.source === 'unavailable' && /post-turn/.test(String(p.diagnostic ?? ''))).length;
  fs.appendFileSync(matrixPath, `
## runtime snapshot 采样时点（review-v4 §3.6-5）

| 阶段 | 语义 | 生产标记 | 实测行为（${e2eDirName}） |
|---|---|---|---|
| query-start | system:init 后的基线快照 | \`samplePhase='query-start'\` | 命中 ${qsCount} 次，全部 fresh |
| mid-turn | 回合中途（assistant/tool_result 落地后）轮询 | \`samplePhase='mid-turn'\` | 命中 ${mtCount} 次 |
| post-turn | result 收尾前的回合末快照（方案A） | \`samplePhase='post-turn'\` | 命中 ${ptOk} 次 |
| post-turn 官方探针 | 回合外旁路 \`claude.exe -p "/context" --resume <sid> --no-session-persistence\`（本计划 F1-F5） | \`source='native-context' + samplePhase='post-turn'\` | 命中 ${ptProbe} 次，fresh |
| post-turn 兜底 | SDK 在 result 阶段不响应 control request（方案B） | \`unavailable + stale + diagnostic\` | 触发 ${ptFail} 次 |
| post-compaction | compact_result=success 后快照 | \`samplePhase='post-compaction'\` | 同代 fresh 才带 compactedJustNow |

契约结论：post-turn 时点**回合内** SDK 已关闭 control request 通道，方案 B（显式 stale/pending + diagnostic）
即回合内生产语义；query-start 快照在回合结束后不得冒充当前实时值（renderer freshness 降级保证）。
**回合外**官方 /context 探针（本计划，F1-F5 实测：零 API、约 2s、不污染 transcript）可得精确回合末值，
source='native-context' + freshness='fresh' + samplePhase='post-turn'，作为圈圈 fresh 终值；探针失败维持 stale 兜底。
S12 restart/resume：${s12 ? `重启前 fresh（${scrub(s12.domBeforeRestart?.title ?? '')}）→ 重启后 ${s12.pendingAfterResume ? '待刷新/pending（未伪装 last-known）' : '需人工复核'}` : '本 run 无 S12 结果文件'}。
数值时点区分见 comparison-table.json（runtimeQueryStartUsed / runtimePostTurnUsed 分列，探针值优先）。
`, 'utf8');
}

// ── manifest.json ──
const manifest = {
  generatedAt: new Date().toISOString(),
  derivedFrom: {
    e2eRunDir: e2eDirName,
    e2ePayloads: payloads.length,
    researchRunDir: outDirName,
    note: '以下文件全部由成功 E2E run 的 context-payloads.json / scenarios.json 机械派生（renderer 可见的 CONTEXT_UPDATE 投影），非 SDK 原始流的重放；无手工数字。',
  },
  files: {
    'sdk-events.jsonl': '全量 CONTEXT_UPDATE payload 流（kind 标注来源事件）',
    'runtime-context-window.jsonl': 'runtime-live 当前窗口快照（含 samplePhase/queryGeneration）',
    'sdk-get-context-usage.jsonl': 'getContextUsage() 成功/失败结局（失败=post-turn 兜底 diagnostic）',
    'model-usage.jsonl': 'estimated-turn-usage 回合用量',
    'compaction-events.jsonl': 'S10 压缩时序 payload',
    'comparison-table.json': `按 queryGeneration 重建（${rows.length} 行）；旧表备份为 comparison-table.pre-review-v4.json`,
  },
  s12: s12 ? { file: 'S12-resume-result.json', pendingAfterResume: s12.pendingAfterResume } : null,
  env: { node: process.version, npm: sh('npm --version'), platform: process.platform },
  git: { branch: sh('git branch --show-current'), head: sh('git rev-parse --short HEAD'), dirtyFiles: sh('git status --short') },
  scrub: 'HOME/用户目录→<USER_DIR>，仓库目录→<REPO_DIR>，sk-*/Authorization/ANTHROPIC_*→<redacted>；payload 中 sessionId 本已是前缀脱敏。',
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(scrubJson(manifest), null, 2), 'utf8');

console.log('补采完成 →', outDir);
console.log('  sdk-events:', payloads.length, '行');
console.log('  runtime-context-window:', payloads.filter((p) => p.source === 'runtime-live').length, '行');
console.log('  sdk-get-context-usage:', payloads.filter((p) => p.source === 'runtime-live' || (p.source === 'unavailable' && /post-turn|runtime 当前窗口/.test(String(p.diagnostic ?? '')))).length, '行（含失败结局）');
console.log('  model-usage:', payloads.filter((p) => p.source === 'estimated-turn-usage').length, '行');
console.log('  compaction-events:', compactRows.length, '行');
console.log('  comparison-table:', rows.length, '行（runtime 时点分列）');
console.log('  manifest.json + source-contract-matrix.md 采样时点章节：已写入');
