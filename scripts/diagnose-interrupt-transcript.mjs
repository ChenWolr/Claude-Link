// scripts/diagnose-interrupt-transcript.mjs
// S6（2026-10-22 计划 §4.2 阶段一）：中断撕裂 transcript 诊断器（纯 node，无 Electron 依赖）。
//
// 背景（计划 §4.1 疑点 A）：user 中断走 killProcess 立即硬杀（TerminateProcess），可能把进行中的
// thinking 轮撕成残缺 transcript（~/.claude/projects/**/<cliSessionId>.jsonl 末行半截 JSON）；
// 紧接的新回合 resume 同一 cliSessionId 时被上游 400 拒收（机制注释见 sdk-backend.ts 两段式中止块）。
// 本脚本对 transcript 做逐行 JSON.parse 体检，产出「末行是否可解析 / 末行 type(subtype) /
// 是否存在疑似被截断的 assistant/thinking 行」，供 E2E（cdp-interrupt-resume-e2e.mjs）与人工取证。
//
// 用法：
//   node scripts/diagnose-interrupt-transcript.mjs --session <cliSessionId>
//   node scripts/diagnose-interrupt-transcript.mjs --all            # 最近 20 个 transcript
//   node scripts/diagnose-interrupt-transcript.mjs --file <path>    # 体检任意 jsonl（E2E 快照复检用）
//
// 退出码：
//   0 = 检查的所有 transcript 均无撕裂证据（末行可解析，且全文件无不可解析行）
//   2 = 存在撕裂 transcript——末行不可解析（硬杀撕裂的典型形态），或全文件存在任何不可解析行
//       （B 回合 resume 会向同一 jsonl 追加、把 A 的撕裂行掩埋到文件中部，故追加场景下
//       「任何不可解析行」同为疑点 A 证据；--file 快照模式则以末行语义为准）
//       注意：历史 transcript 可能因既有 watchdog/user 硬杀残留退出码 2，这是脚本的
//       正常诊断输出，不是脚本缺陷（报告里须区分「脚本可运行」与「诊断结论」）。
//   1 = 用法错误 / transcript 未找到 / 存在读取失败（READ_ERROR）且无撕裂——完整性无法确认

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const ALL_SCAN_LIMIT = 20;
const MAX_TORN_SAMPLES = 3; // 每文件最多展示的坏行样本数（防止刷屏）

function usage() {
  console.error('用法：node scripts/diagnose-interrupt-transcript.mjs --session <cliSessionId>');
  console.error('      node scripts/diagnose-interrupt-transcript.mjs --all');
  console.error('      node scripts/diagnose-interrupt-transcript.mjs --file <path>');
  process.exit(1);
}

// 解析参数（--session <id> / --all / --file <path> 三选一）。
function parseArgs(argv) {
  const args = argv.slice(2);
  if (args[0] === '--all') return { mode: 'all' };
  if (args[0] === '--session' && args[1]) return { mode: 'session', sessionId: args[1] };
  if (args[0] === '--file' && args[1]) return { mode: 'file', filePath: args[1] };
  usage();
  return null;
}

// 递归收集 projects 根下全部 *.jsonl（projects/<工程目录>/<sessionId>.jsonl；递归以容未来布局变化）。
function collectJsonlFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root);
  return out;
}

function safeSnippet(s, max = 90) {
  const cut = s.length > max ? s.slice(0, max) + `…(+${s.length - max}B)` : s;
  return JSON.stringify(cut);
}

// 启发式：坏行是否疑似 assistant/thinking 残体（解析失败只能猜前缀与关键字）。
function looksLikeAssistantOrThinking(rawLine) {
  return /"type"\s*:\s*"(assistant|user|system)"/.test(rawLine) || /"thinking"/.test(rawLine);
}

// 单文件体检：逐行 JSON.parse，输出总行数/末行可解析性/末行 type(subtype)/疑似截断行。
function analyzeFile(filePath, snapshotMode = false) {
  const report = {
    file: filePath,
    sessionId: path.basename(filePath, '.jsonl'),
    bytes: 0,
    totalLines: 0,
    lastLineParseable: null,
    lastLineType: null,
    lastLineSubtype: null,
    unparseableCount: 0,
    unparseableLines: [], // { lineNo, length, snippet, suspectAssistantThinking }
    suspectTruncatedAssistantThinking: false,
    verdict: 'OK', // OK | EMPTY | TORN | READ_ERROR
  };
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    report.verdict = 'READ_ERROR';
    report.error = e.message;
    return report;
  }
  report.bytes = buf.length;
  let content = buf.toString('utf8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // 去 BOM
  const chunks = content.split(/\r?\n/);
  // 文件以换行结尾时最后一个 chunk 是空串——这是正常收尾，不算一行、更不算撕裂。
  if (chunks.length > 0 && chunks[chunks.length - 1] === '') chunks.pop();
  report.totalLines = chunks.length;
  if (chunks.length === 0) {
    report.verdict = 'EMPTY';
    report.lastLineParseable = true; // 空文件无末行，无撕裂证据可言
    return report;
  }
  chunks.forEach((line, idx) => {
    const lineNo = idx + 1;
    const trimmed = line.trim();
    if (trimmed === '') {
      // 中间空行罕见且不构成撕裂证据，跳过不计入总行数语义之外的判定。
      return;
    }
    try {
      const obj = JSON.parse(trimmed);
      if (lineNo === chunks.length || report.lastLineParseable === null) {
        // 末行（或唯一可判定行）的 type/subtype。
        report.lastLineParseable = true;
        report.lastLineType = typeof obj.type === 'string' ? obj.type : null;
        report.lastLineSubtype = typeof obj.subtype === 'string' ? obj.subtype : null;
      }
    } catch {
      report.unparseableCount += 1;
      const suspect = looksLikeAssistantOrThinking(trimmed);
      if (suspect) report.suspectTruncatedAssistantThinking = true;
      if (report.unparseableLines.length < MAX_TORN_SAMPLES) {
        report.unparseableLines.push({ lineNo, length: trimmed.length, snippet: safeSnippet(trimmed), suspectAssistantThinking: suspect });
      }
      if (lineNo === chunks.length) {
        // 末行不可解析 = 疑点 A 的直接证据形态。
        report.lastLineParseable = false;
        report.lastLineType = null;
        report.lastLineSubtype = null;
      }
    }
  });
  report.verdict = report.lastLineParseable === false ? 'TORN' : 'OK';
  // --file 快照模式（screenshotMode）只认末行语义：快照摄于 B 追加前，末行即中断现场。
  // --session/--all 模式下，若 B（或后续回合）已向同一文件追加，撕裂行被掩埋到文件中部——
  // 此时「任何不可解析行」同为撕裂证据（追加不换行拼接，坏行不会自愈），一并判 TORN。
  if (report.verdict === 'OK' && !snapshotMode && report.unparseableCount > 0) report.verdict = 'TORN';
  return report;
}

function printReport(r) {
  console.log(`──────────────────────────────────────────────`);
  console.log(`文件: ${r.file}`);
  if (r.verdict === 'READ_ERROR') {
    console.log(`  ❌ 读取失败：${r.error}`);
    return;
  }
  console.log(`  sessionId: ${r.sessionId}`);
  console.log(`  大小: ${r.bytes} B；总行数: ${r.totalLines}`);
  console.log(`  末行可解析: ${r.lastLineParseable ? '是' : '否 ←—— 撕裂证据'}`);
  if (r.lastLineType !== null) console.log(`  末行 type: ${r.lastLineType}${r.lastLineSubtype ? ` (subtype: ${r.lastLineSubtype})` : ''}`);
  console.log(`  不可解析行数: ${r.unparseableCount}`);
  for (const u of r.unparseableLines) {
    console.log(`    · 行 ${u.lineNo}（${u.length}B）疑似 assistant/thinking 残体=${u.suspectAssistantThinking} 片段: ${u.snippet}`);
  }
  console.log(`  疑似被截断的 assistant/thinking 行: ${r.suspectTruncatedAssistantThinking ? '存在' : '未检出'}`);
  console.log(`  判定: ${r.verdict}`);
}

async function main() {
  const args = parseArgs(process.argv);
  let files;
  let snapshotMode = false;
  if (args.mode === 'file') {
    if (!fs.existsSync(args.filePath)) {
      console.error(`文件不存在：${args.filePath}`);
      process.exit(1);
    }
    files = [args.filePath];
    snapshotMode = true;
  } else {
    if (!fs.existsSync(PROJECTS_ROOT)) {
      console.error(`transcript 根目录不存在：${PROJECTS_ROOT}`);
      process.exit(1);
    }
    if (args.mode === 'session') {
      const all = collectJsonlFiles(PROJECTS_ROOT);
      files = all.filter((f) => path.basename(f) === `${args.sessionId}.jsonl`);
      if (files.length === 0) {
        console.error(`未找到 transcript：${args.sessionId}.jsonl（在 ${PROJECTS_ROOT} 下递归搜索）`);
        process.exit(1);
      }
    } else {
      files = collectJsonlFiles(PROJECTS_ROOT)
        .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
        .sort((a, b) => b.m - a.m)
        .slice(0, ALL_SCAN_LIMIT)
        .map((x) => x.f);
      if (files.length === 0) {
        console.log(`${PROJECTS_ROOT} 下没有任何 .jsonl。`);
        process.exit(0);
      }
    }
  }

  console.log(`=== 中断撕裂 transcript 诊断（${args.mode === 'session' ? `--session ${args.sessionId}` : args.mode === 'file' ? `--file ${args.filePath}` : `--all 最近 ${files.length} 个`}）===`);
  const reports = files.map((f) => analyzeFile(f, snapshotMode));
  for (const r of reports) printReport(r);

  const torn = reports.filter((r) => r.verdict === 'TORN');
  const errors = reports.filter((r) => r.verdict === 'READ_ERROR');
  console.log(`══════════════════════════════════════════════`);
  console.log(`汇总：检查 ${reports.length} 个；TORN（撕裂证据）${torn.length} 个；读取失败 ${errors.length} 个。`);
  if (torn.length > 0) {
    // F4（round-002 review）：证据行按依据区分——末行不可解析=硬杀撕裂典型形态；末行可解析但
    // 中段有不可解析行=追加掩埋形态（B 回合 resume 向同一 jsonl 追加把撕裂行掩埋到中部，见头注）。
    const lastLineTorn = torn.filter((r) => r.lastLineParseable === false);
    const midTorn = torn.filter((r) => r.lastLineParseable !== false);
    if (lastLineTorn.length > 0) {
      console.log(`疑点 A 证据：以下 transcript 末行不可解析（硬杀撕裂典型形态）：`);
      for (const r of lastLineTorn) console.log(`  - ${r.file}`);
    }
    if (midTorn.length > 0) {
      console.log(`疑点 A 证据：以下 transcript 含不可解析行（追加掩埋形态）：`);
      for (const r of midTorn) console.log(`  - ${r.file}`);
    }
    process.exit(2);
  }
  // F5（2026-10-24 review）：读取失败参与退出码——完整性无法确认时不得报「健康」（取证假阴）。
  if (errors.length > 0) {
    console.log(`结论：${errors.length} 个 transcript 读取失败（完整性无法确认，退出码 1）。`);
    process.exit(1);
  }
  console.log(`结论：所有被检 transcript 末行均可解析（退出码 0）。`);
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
