// tdd-turn-diff-quality-verify.ts
// 计划 docs/plans/2026-11-05-turn-diff-quality-encoding-reconstruct-plan.md 契约脚本（2026-11-05）。
// 由 plan-loop 各原子点分段追加（点1 先建，断言组总清单 F-a～F-f；本点仅落 F-a/F-b/F-f）：
//   F-a decodeTextBuffer 单测（点1）
//   F-b 快照编码落库（noteCheckpointEvent 全链，点1）
//   F-c reconstruct 经 computeFileDiff 集成（点2 落）
//   F-d 上下文参数生效性（点2 落）
//   F-e 渲染层结构钉（点3 落）
//   F-f fs-preview 文本预览（点1）
//
// 运行：npx tsx scripts/tdd-turn-diff-quality-verify.ts
// （better-sqlite3 为 Electron ABI：当前 node 不匹配时自动以 ELECTRON_RUN_AS_NODE 重 spawn 本脚本——
//   n2 / skill-overrides 先例。DB 行为用 electron-stub（house pattern）：Module._load 把 'electron'
//   解析到 scripts/electron-stub.cjs，app.getPath 由 CLAUDE_LINK_TEST_USERDATA 指向系统临时目录，
//   真实 connection/runMigrations/真实文件在临时库/临时目录上跑，绝不触碰真实用户库。）

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');

// —— electron-stub 安装（tdd-turn-file-diff-verify 先例）：必须在 require 任何主进程模块之前 ——
// 临时根用系统 tmpdir（脱敏：2026-11-05 验收 F3 用户拍板，去除本机盘符硬编码；隔离/清扫语义不变）。
const stubUserDataDir = path.join(
  os.tmpdir(),
  'claude-link',
  'turn-diff-quality-verify',
  `tmp-userdata-${process.pid}-${Date.now()}`,
);
// 入口清扫：上轮运行若因 db 句柄未放（Windows 上 rmSync 报 EBUSY/EPERM）留下 tmp-userdata-*
// 残留，本轮建目录前先逐个清掉历史 tmp-userdata-*（尽力而为，清扫失败吞异常不阻断本轮）。
{
  const sweepRoot = path.dirname(stubUserDataDir);
  try {
    for (const entry of fs.readdirSync(sweepRoot)) {
      if (entry.startsWith('tmp-userdata-')) {
        try { fs.rmSync(path.join(sweepRoot, entry), { recursive: true, force: true }); } catch { /* 尽力清扫 */ }
      }
    }
  } catch { /* 根目录尚不存在：无残留可清 */ }
}
fs.mkdirSync(stubUserDataDir, { recursive: true });
process.env.CLAUDE_LINK_TEST_USERDATA = stubUserDataDir;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const origLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (req: string, parent: unknown, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

// —— better-sqlite3 ABI 预检 + ELECTRON_RUN_AS_NODE respawn（照抄 tdd-turn-file-diff-verify 手法）——
function openMemoryDb(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3');
  return new Database(':memory:');
}

/** ABI 不匹配（node vs electron NODE_MODULE_VERSION）时以 electron-as-node 重跑自身并透传退出码。 */
function respawnUnderElectronIfNeeded(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/NODE_MODULE_VERSION/.test(msg)) throw err;
  const r = spawnSync(
    path.join('node_modules', '.bin', 'electron.cmd'),
    [path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), ...process.argv.slice(1)],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', shell: true },
  );
  process.stdout.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  process.exit(r.status ?? 1);
}

{
  let probe: { close: () => void } | null = null;
  try {
    probe = openMemoryDb() as { close: () => void };
  } catch (err) {
    respawnUnderElectronIfNeeded(err);
  }
  probe?.close();
}

let pass = 0;
let fail = 0;
function check(no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// 临时目录 SQLite 库（electron-stub userData 下 claude-link.db，真实 connection）+ 迁移（F-b 前提：
// turn_file_checkpoints / sessions / messages 表）。migrations/connection 为既有稳定模块，不包 try。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runMigrations } = require(path.resolve(repoRoot, 'src', 'main', 'database', 'migrations.ts'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const connectionMod = require(path.resolve(repoRoot, 'src', 'main', 'database', 'connection.ts'));
const db = connectionMod.getConnection() as {
  prepare: (sql: string) => { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] };
  exec: (sql: string) => void;
};
runMigrations(db);
runMigrations(db);

// ═══════════════════════════════════════════════════════════════════════════
// F-a decodeTextBuffer 单测（点1）：require '../src/shared/text-decode' 直测；
// 模块缺失 → 本组 10 条全 FAIL（脚本不 crash）。
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== F-a decodeTextBuffer 单测（点1） ===');

let textDecode: Record<string, unknown> | null = null;
let textDecodeErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  textDecode = require(path.resolve(repoRoot, 'src', 'shared', 'text-decode.ts')) as Record<string, unknown>;
} catch (e) {
  textDecodeErr = errMsg(e);
}
const decodeTextBuffer = textDecode?.decodeTextBuffer as ((buf: Buffer) => unknown) | undefined;
const faWhy = `decodeTextBuffer 不可用${textDecodeErr ? `（模块加载失败：${textDecodeErr.slice(0, 160)}）` : ''}`;

/** 逐字段比对（不用 JSON.stringify：键序无关，binary 用例只比 binary/bom）。 */
function faEq(r: unknown, exp: { binary: boolean; bom: string | null; text?: string }): boolean {
  if (r == null || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  if (o.binary !== exp.binary || o.bom !== exp.bom) return false;
  if (exp.binary === false && o.text !== exp.text) return false;
  return true;
}

/** F-a 单用例驱动：给定输入 Buffer 与期望结果，decodeTextBuffer 缺失时记 FAIL。 */
function faCase(no: string, name: string, buf: Buffer, exp: { binary: boolean; bom: string | null; text?: string }): void {
  if (typeof decodeTextBuffer !== 'function') {
    check(no, name, false, faWhy);
    return;
  }
  let r: unknown;
  let threw = '';
  try {
    r = decodeTextBuffer(buf);
  } catch (e) {
    threw = errMsg(e);
  }
  if (threw) {
    check(no, name, false, `decodeTextBuffer 抛错：${threw.slice(0, 160)}`);
    return;
  }
  check(no, name, faEq(r, exp), `实际=${JSON.stringify(r)} 期望=${JSON.stringify(exp)}`);
}

faCase('F-a①', '纯 ASCII UTF-8 → text 原样、bom:null', Buffer.from('hello\nworld\n', 'utf-8'),
  { binary: false, bom: null, text: 'hello\nworld\n' });
faCase('F-a②', 'UTF-8 BOM（EF BB BF）→ text 以 \\uFEFF 开头（UTF-8 BOM 保留不动）',
  Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('中文UTF8BOM\n', 'utf-8')]),
  { binary: false, bom: null, text: '\uFEFF中文UTF8BOM\n' });
faCase('F-a③', 'UTF-16LE BOM + ASCII → text 正确、无 \\0、bom:utf16le',
  Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('class Foo {}\n', 'utf16le')]),
  { binary: false, bom: 'utf16le', text: 'class Foo {}\n' });
faCase('F-a④', 'UTF-16LE BOM + 中文（含「」）→ text 相等、bom:utf16le',
  Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('公共类 foo {}\n// 注释「引号」\n', 'utf16le')]),
  { binary: false, bom: 'utf16le', text: '公共类 foo {}\n// 注释「引号」\n' });
faCase('F-a⑤', 'UTF-16BE BOM + 中英混合 → bom:utf16be、text 正确',
  Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from('中英 mix {}\n', 'utf16le').swap16()]),
  { binary: false, bom: 'utf16be', text: '中英 mix {}\n' });
faCase('F-a⑥', '仅 BOM 两字节（FF FE）→ { binary:false, bom:utf16le, text:\'\' }', Buffer.from([0xFF, 0xFE]),
  { binary: false, bom: 'utf16le', text: '' });
faCase('F-a⑦', 'UTF-16LE BOM + \'ab\' + 奇数尾字节 → 尾字节被丢弃、text===\'ab\'',
  Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('ab', 'utf16le'), Buffer.from([0x61])]),
  { binary: false, bom: 'utf16le', text: 'ab' });
faCase('F-a⑧', '无 BOM 含 \\0 → binary:true、bom:null（回归红线）', Buffer.from([0x61, 0x00, 0x62]),
  { binary: true, bom: null });
faCase('F-a⑨', 'UTF-32LE BOM（FF FE 00 00）→ binary:true、bom:null', Buffer.from([0xFF, 0xFE, 0x00, 0x00]),
  { binary: true, bom: null });
faCase('F-a⑩', '空 Buffer → { binary:false, bom:null, text:\'\' }', Buffer.alloc(0),
  { binary: false, bom: null, text: '' });


// ═══════════════════════════════════════════════════════════════════════════
// F-b 快照编码落库（点1）：noteCheckpointEvent 全链驱动（对齐 tdd-turn-file-diff-verify 段F
// sess-f-a 手法：seed sessions 行 → tool_use(Write 伪事件带 input.file_path) → tool_result →
// messages 表插对应 tool_use_id 的 tool_result 行 → 轮询快照落库 → 查 turn_file_checkpoints 行
// 断言）。每个用例用唯一 session id，防 checkpoint 模块内存 Map 串扰。
// ═══════════════════════════════════════════════════════════════════════════

let recorder: Record<string, unknown> | null = null;
let recorderErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  recorder = require(path.resolve(repoRoot, 'src', 'main', 'modules', 'turn-diff-checkpoint.ts')) as Record<string, unknown>;
} catch (e) {
  recorderErr = errMsg(e);
}
const note = recorder?.noteCheckpointEvent as ((sessionId: string, ev: unknown) => void) | undefined;

const segBDir = path.join(stubUserDataDir, 'f-b-files');

function seedSessionB(id: string): void {
  db.prepare("INSERT INTO sessions (id, name, model) VALUES (?, 'F-b-编码落库测试', 'claude-sonnet-4-6')").run(id);
}

/** 模拟 persistCliEvent 的 tool_result 消息落库行（照抄段C seedToolResultMessage）。 */
function seedToolResultMessageB(sessionId: string, messageId: string, toolUseId: string): void {
  db.prepare(
    "INSERT INTO messages (id, session_id, role, content, event_type, tool_use_id) VALUES (?, ?, 'tool', 'ok', 'tool_result', ?)",
  ).run(messageId, sessionId, toolUseId);
}

function checkpointRowsB(sessionId: string): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM turn_file_checkpoints WHERE session_id = ? ORDER BY id ASC').all(sessionId) as Array<Record<string, unknown>>;
}

/** 轮询等待谓词成立（快照落库是异步续体；3s 上限防挂死；超时按当前行集继续断言，RED 预期内）。 */
async function waitForB(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!pred() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!pred()) console.log(`  （等待超时：${label}——按当前行集继续断言）`);
}

async function runFb(): Promise<void> {
  console.log('\n=== F-b 快照编码落库（点1，noteCheckpointEvent 全链） ===');
  fs.mkdirSync(segBDir, { recursive: true });
  if (typeof note !== 'function') {
    const why = `noteCheckpointEvent 不可用${recorderErr ? `（模块加载失败：${recorderErr.slice(0, 160)}）` : ''}`;
    check('F-b①', 'UTF-16LE BOM java 文件 → binary=0、snapshot_state=disk、after_content=转码正确文本', false, why);
    check('F-b②', 'UTF-16BE BOM java 文件 → binary=0、after_content=转码正确文本', false, why);
    check('F-b③', '无 BOM 含 \\0 文件 → binary=1、after_content=NULL（回归红线）', false, why);
    check('F-b④', '普通 UTF-8 文件 → after_content 与 fs.readFileSync(p,utf-8) 逐字节相等（回归红线）', false, why);
    return;
  }

  /** 全链驱动：seed session → tool_use(Write, input.file_path) → tool_result → tool_result 消息行 → 等快照落库。 */
  async function driveSnapshot(sid: string, msgId: string, toolUseId: string, filePath: string): Promise<void> {
    seedSessionB(sid);
    note!(sid, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'Write', id: toolUseId, input: { file_path: filePath, content: 'x' } }] });
    note!(sid, { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] });
    seedToolResultMessageB(sid, msgId, toolUseId);
    await waitForB(() => checkpointRowsB(sid).length === 1, `F-b 快照落库 ${sid}`);
  }

  const javaBody = 'public class Foo {\n    int x = 1;\n}\n';

  // ① UTF-16LE BOM java 风格文件。
  {
    const sid = 'sess-fb-1';
    const p = path.join(segBDir, 'Foo.java');
    fs.writeFileSync(p, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(javaBody, 'utf16le')]));
    await driveSnapshot(sid, 'msg-fb-1', 'tu-fb-1', p);
    const rows = checkpointRowsB(sid);
    const r = rows[0] ?? {};
    check('F-b①', 'UTF-16LE BOM java 文件 → binary=0、snapshot_state=disk、after_content=转码正确文本（无 \\0）',
      rows.length === 1 && r.binary === 0 && r.snapshot_state === 'disk' && r.after_content === javaBody,
      `rows=${JSON.stringify(rows).slice(0, 400)}`);
  }

  // ② UTF-16BE 同上（swap16 构造）。
  {
    const sid = 'sess-fb-2';
    const p = path.join(segBDir, 'Bar.java');
    fs.writeFileSync(p, Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from(javaBody, 'utf16le').swap16()]));
    await driveSnapshot(sid, 'msg-fb-2', 'tu-fb-2', p);
    const rows = checkpointRowsB(sid);
    const r = rows[0] ?? {};
    check('F-b②', 'UTF-16BE BOM java 文件 → binary=0、snapshot_state=disk、after_content=转码正确文本（无 \\0）',
      rows.length === 1 && r.binary === 0 && r.snapshot_state === 'disk' && r.after_content === javaBody,
      `rows=${JSON.stringify(rows).slice(0, 400)}`);
  }

  // ③ 无 BOM 含 \0 文件 → binary=1、after_content NULL（回归红线，现行为）。
  {
    const sid = 'sess-fb-3';
    const p = path.join(segBDir, 'nul.bin');
    fs.writeFileSync(p, Buffer.from([0x61, 0x00, 0x62]));
    await driveSnapshot(sid, 'msg-fb-3', 'tu-fb-3', p);
    const rows = checkpointRowsB(sid);
    const r = rows[0] ?? {};
    check('F-b③', '无 BOM 含 \\0 文件 → binary=1、after_content=NULL（回归红线）',
      rows.length === 1 && r.binary === 1 && r.after_content === null,
      `rows=${JSON.stringify(rows).slice(0, 400)}`);
  }

  // ④ 普通 UTF-8 文件 → after_content === fs.readFileSync(p,'utf-8')（回归红线：逐字节不变）。
  {
    const sid = 'sess-fb-4';
    const body = '普通 UTF-8 中文 + ascii\nline2\n';
    const p = path.join(segBDir, 'plain.txt');
    fs.writeFileSync(p, body, 'utf-8');
    await driveSnapshot(sid, 'msg-fb-4', 'tu-fb-4', p);
    const rows = checkpointRowsB(sid);
    const r = rows[0] ?? {};
    check('F-b④', '普通 UTF-8 文件 → after_content 与 fs.readFileSync(p,utf-8) 逐字节相等（回归红线）',
      rows.length === 1 && r.binary === 0 && r.after_content === fs.readFileSync(p, 'utf-8'),
      `rows=${JSON.stringify(rows).slice(0, 300)}`);
  }
}

// ── 后续断言组追加区（F-c/F-d 由点2、F-e 由点3 插入本标记与 F-f 段之间，勿删）──

// ═══════════════════════════════════════════════════════════════════════════
// F-c reconstruct 经 computeFileDiff 集成（点2，计划 §2.3）：构造行集直调 computeFileDiff
// （纯函数，不触 DB）。行形状照抄 tdd-turn-file-diff-verify.ts 的 mkRow（message_id 与 mrow
// 对齐）；turn-diff/diff-core 模块缺失 → 本组断言全 FAIL（脚本不 crash）。
// ═══════════════════════════════════════════════════════════════════════════

let turnDiffQ: Record<string, unknown> | null = null;
let turnDiffQErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  turnDiffQ = require(path.resolve(repoRoot, 'src', 'main', 'modules', 'turn-diff.ts')) as Record<string, unknown>;
} catch (e) {
  turnDiffQErr = errMsg(e);
}
let diffCoreQ: Record<string, unknown> | null = null;
let diffCoreQErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  diffCoreQ = require(path.resolve(repoRoot, 'src', 'shared', 'diff-core.ts')) as Record<string, unknown>;
} catch (e) {
  diffCoreQErr = errMsg(e);
}

interface FileDiffResultQ { mode: string; additions: number; deletions: number; writeCount: number; patch: string; truncated: boolean }
type ComputeFileDiffQ = (rows: unknown[], startRow: number, endRow: number | null, path: string, context?: number) => FileDiffResultQ;
type DiffFullQ = (before: string, after: string, path: string, context?: number) => { patch: string; additions: number; deletions: number; truncated: boolean };

const computeFileDiffQ = turnDiffQ?.computeFileDiff as ComputeFileDiffQ | undefined;
const diffFullQ = diffCoreQ?.diffFull as DiffFullQ | undefined;

/** F-c 行构造（形状照抄 tdd-turn-file-diff-verify.ts 的 mkRow；message_id 与 mrow 对齐）。 */
function mkRowQ(seq: number, over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: seq, session_id: 'sess-q', message_id: `mq${seq}`, path: 'p', tool_name: 'Write',
    tool_use_id: `tu-q-${seq}`, input_json: null, input_truncated: 0,
    after_content: null, after_truncated: 0, binary: 0, snapshot_state: 'disk',
    mrow: seq,
    ...over,
  };
}

/** F-c①/F-d① 共用场景：20 行文件（第 10 行旧文 const oldTen = 10;）单 Edit 改第 10 行，无 before 行。 */
function fc1Case(): { p: string; rows: Record<string, unknown>[] } {
  const p = 'fc1.txt';
  const beforeLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
  beforeLines[9] = 'const oldTen = 10;';
  const afterLines = [...beforeLines];
  afterLines[9] = 'const newTen = 10;';
  const after = afterLines.join('\n') + '\n';
  const rows = [mkRowQ(1, {
    mrow: 101, path: p, tool_name: 'Edit', after_content: after,
    input_json: JSON.stringify({ file_path: p, old_string: 'const oldTen = 10;', new_string: 'const newTen = 10;' }),
  })];
  return { p, rows };
}

function runFcFd(): void {
  console.log('\n=== F-c reconstruct 集成（点2，computeFileDiff 直调） ===');
  if (typeof computeFileDiffQ !== 'function' || typeof diffFullQ !== 'function') {
    const why = `computeFileDiff/diffFull 不可用（turn-diff${turnDiffQErr ? ` 加载失败：${turnDiffQErr.slice(0, 120)}` : ''}；diff-core${diffCoreQErr ? ` 加载失败：${diffCoreQErr.slice(0, 120)}` : ''}）`;
    check('F-c①', '单 Edit 首改 → reconstructed、头两行 ---/+++、hunk 头 @@ -7,7 +7,7 @@、含 -旧/+新', false, why);
    check('F-c②', 'MultiEdit 三连改 → reconstructed、恰 3 hunk（-1,6/-12,7/-24,7）、各 hunk 含对应 ±', false, why);
    check('F-c③', '删除型（new_string=\'\'）→ 回落 first-change', false, why);
    check('F-c④', '轮含 Write → first-change（前置否决）', false, why);
    check('F-c⑤', '一行 input_truncated=1 → first-change（链条断一环全有或全无）', false, why);
    check('F-c⑥', 'new 与 after 不匹配 → first-change（反向 new 未命中）', false, why);
    check('F-c⑦', 'replace_all=true（原文两处）→ reconstructed 且 ±=2/2', false, why);
    check('F-c⑧(i)', 'before 快照存在 → full 且 patch===diffFull（回归红线）', false, why);
    check('F-c⑧(ii)', '全 binary 行 + input 可用 → intent、patch 含片段行（回归红线）', false, why);
    check('F-d①', 'reconstructed 场景 ctx=3 vs 100000 → patch 不相等', false, why);
    check('F-d②', '意图合成场景 ctx=3 vs 100000 → patch 相等（现状钉）', false, why);
    return;
  }
  const fileDiffQ = computeFileDiffQ;

  // ① 单 Edit 首改：before 20 行（第 10 行旧文），Edit 行 old/new=第 10 行旧/新文，after_content=改后 20 行，无 before 行
  //    → mode=reconstructed，patch 头两行 ---/+++、hunk 头 @@ -7,7 +7,7 @@（上下文自第 7 行起）、体含 -旧/+新（真实行号）。
  {
    const { p, rows } = fc1Case();
    const r = fileDiffQ(rows, 100, 200, p);
    const lines = r.patch.split('\n');
    check('F-c①', '单 Edit 首改（20 行文件改第 10 行）→ mode=reconstructed、头两行 ---/+++、hunk 头 @@ -7,7 +7,7 @@、体含 -旧/+新（真实行号）',
      r.mode === 'reconstructed'
        && lines[0] === `--- a/${p}` && lines[1] === `+++ b/${p}`
        && lines.includes('@@ -7,7 +7,7 @@')
        && lines.includes('-const oldTen = 10;') && lines.includes('+const newTen = 10;'),
      `mode=${r.mode} patch=[${lines.join(' ⏎ ')}]`);
  }

  // ② MultiEdit 三连改：30 行文件第 3/15/27 行各改一处（相距 12 行，context=3 下不合并），单行 input_json
  //    → mode=reconstructed、恰 3 个 hunk、头 @@ -1,6 / -12,7 / -24,7、各 hunk 体含对应 -旧行/+新行。
  {
    const p = 'fc2.txt';
    const beforeLines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    beforeLines[2] = 'old3'; beforeLines[14] = 'old15'; beforeLines[26] = 'old27';
    const afterLines = [...beforeLines];
    afterLines[2] = 'new3'; afterLines[14] = 'new15'; afterLines[26] = 'new27';
    const rows = [mkRowQ(1, {
      mrow: 101, path: p, tool_name: 'MultiEdit', after_content: afterLines.join('\n') + '\n',
      input_json: JSON.stringify({ file_path: p, edits: [
        { old_string: 'old3', new_string: 'new3' },
        { old_string: 'old15', new_string: 'new15' },
        { old_string: 'old27', new_string: 'new27' },
      ] }),
    })];
    const r = fileDiffQ(rows, 100, 200, p);
    const lines = r.patch.split('\n');
    const headers = lines.filter((l) => l.startsWith('@@'));
    check('F-c②', 'MultiEdit 三连改（30 行文件第 3/15/27 行）→ mode=reconstructed、恰 3 hunk、头 -1,6/-12,7/-24,7、各 hunk 含对应 -旧行/+新行',
      r.mode === 'reconstructed'
        && headers.length === 3
        && headers[0] === '@@ -1,6 +1,6 @@' && headers[1] === '@@ -12,7 +12,7 @@' && headers[2] === '@@ -24,7 +24,7 @@'
        && lines.includes('-old3') && lines.includes('+new3')
        && lines.includes('-old15') && lines.includes('+new15')
        && lines.includes('-old27') && lines.includes('+new27'),
      `mode=${r.mode} headers=[${headers.join(' | ')}] patch=[${lines.join(' ⏎ ').slice(0, 300)}]`);
  }

  // ③ 删除型：Edit new_string='' → 反向无法定位插入点 → 重建 null → 回落意图合成 first-change。
  {
    const p = 'fc3.txt';
    const rows = [mkRowQ(1, {
      mrow: 101, path: p, tool_name: 'Edit', after_content: 'A\nC\n',
      input_json: JSON.stringify({ file_path: p, old_string: 'B\n', new_string: '' }),
    })];
    const r = fileDiffQ(rows, 100, 200, p);
    check('F-c③', '删除型（new_string=\'\'，反向无法定位插入点）→ 回落 mode=first-change',
      r.mode === 'first-change', `mode=${r.mode} patch=[${r.patch.split('\n').join(' ⏎ ').slice(0, 160)}]`);
  }

  // ④ 轮含 Write：同文件一行 Write 行 + 一行 Edit 行（均无 before）→ Write 前置否决 → first-change。
  {
    const p = 'fc4.txt';
    const rows = [
      mkRowQ(1, { mrow: 101, path: p, tool_name: 'Write', after_content: 'W\n',
        input_json: JSON.stringify({ file_path: p, content: 'W\n' }) }),
      mkRowQ(2, { mrow: 102, path: p, tool_name: 'Edit', after_content: 'W\nE\n',
        input_json: JSON.stringify({ file_path: p, old_string: 'W\n', new_string: 'W\nE\n' }) }),
    ];
    const r = fileDiffQ(rows, 100, 200, p);
    check('F-c④', '轮含 Write（Write 整替换后轮初不可知，前置否决）→ mode=first-change',
      r.mode === 'first-change', `mode=${r.mode}`);
  }

  // ⑤ 链条断一环全有或全无：一行 Edit input 可用 + 一行 Edit input_truncated=1 → 重建否决 → 回落
  //    意图合成（可用行照常合成）→ first-change。
  {
    const p = 'fc5.txt';
    const rows = [
      mkRowQ(1, { mrow: 101, path: p, tool_name: 'Edit', after_content: 'G\n',
        input_json: JSON.stringify({ file_path: p, old_string: 'g', new_string: 'G' }) }),
      mkRowQ(2, { mrow: 102, path: p, tool_name: 'Edit', after_content: 'G\n',
        input_json: '{"file_path":"fc5.txt","old_str', input_truncated: 1 }),
    ];
    const r = fileDiffQ(rows, 100, 200, p);
    check('F-c⑤', '一行 input_truncated=1（链条断一环全有或全无）→ mode=first-change',
      r.mode === 'first-change', `mode=${r.mode}`);
  }

  // ⑥ old_string 与 after 不匹配：input new_string='DDD' 不出现在 after 中 → 反向 new 未命中 → null
  //    → 回落 first-change。
  {
    const p = 'fc6.txt';
    const rows = [mkRowQ(1, {
      mrow: 101, path: p, tool_name: 'Edit', after_content: 'AAA\nBBB-free\n',
      input_json: JSON.stringify({ file_path: p, old_string: 'xxx', new_string: 'DDD' }),
    })];
    const r = fileDiffQ(rows, 100, 200, p);
    check('F-c⑥', 'new_string 与 after 不匹配（反向 new 未命中 → null）→ mode=first-change',
      r.mode === 'first-change', `mode=${r.mode}`);
  }

  // ⑦ replace_all=true、old 在原文出现两次：after 中新文恰好出现两次（构造自证无第三处）
  //    → mode=reconstructed 且 additions===2、deletions===2（± 计入两处）。
  {
    const p = 'fc7.txt';
    const before = 'head\noldX\nmid\noldX\ntail\n';
    const after = 'head\nnewX\nmid\nnewX\ntail\n';
    const rows = [mkRowQ(1, {
      mrow: 101, path: p, tool_name: 'Edit', after_content: after,
      input_json: JSON.stringify({ file_path: p, old_string: 'oldX', new_string: 'newX', replace_all: true }),
    })];
    const r = fileDiffQ(rows, 100, 200, p);
    const newXCount = after.split('newX').length - 1;
    check('F-c⑦', 'replace_all=true（old 在原文出现两次、after 新文恰两处）→ mode=reconstructed 且 ±=2/2',
      r.mode === 'reconstructed' && newXCount === 2 && r.additions === 2 && r.deletions === 2,
      `mode=${r.mode} ±=${r.additions}/${r.deletions} newXCount=${newXCount}`);
  }

  // ⑧ 既有场景回归红线：
  //   (i) before 快照存在（mrow<startRow 的 disk 行）→ mode=full 且 patch 与 diffFull(before, after, path, 3) 逐字节相等；
  //  (ii) 全 binary 行（binary=1、after_content=null）+ input_json 可用 → mode=intent、patch 非空含片段行。
  {
    const p = 'fc8a.txt';
    const beforeLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    beforeLines[9] = 'const oldTen = 10;';
    const afterLines = [...beforeLines];
    afterLines[9] = 'const newTen = 10;';
    const before = beforeLines.join('\n') + '\n';
    const after = afterLines.join('\n') + '\n';
    const rows = [
      mkRowQ(1, { mrow: 10, path: p, after_content: before,
        input_json: JSON.stringify({ file_path: p, content: before }) }),
      mkRowQ(2, { mrow: 101, path: p, tool_name: 'Edit', after_content: after,
        input_json: JSON.stringify({ file_path: p, old_string: 'const oldTen = 10;', new_string: 'const newTen = 10;' }) }),
    ];
    const r = fileDiffQ(rows, 100, 200, p);
    const exp = diffFullQ(before, after, p, 3);
    check('F-c⑧(i)', '回归红线：before 快照存在（mrow<startRow）→ mode=full 且 patch/±/truncated 与 diffFull 逐字节相等',
      r.mode === 'full' && exp !== undefined && r.patch === exp.patch
        && r.additions === exp.additions && r.deletions === exp.deletions && r.truncated === exp.truncated,
      `mode=${r.mode}`);
  }
  {
    const p = 'fc8b.txt';
    const rows = [mkRowQ(1, {
      mrow: 101, path: p, binary: 1, after_content: null, tool_name: 'Edit',
      input_json: JSON.stringify({ file_path: p, old_string: 'old-frag', new_string: 'new-frag' }),
    })];
    const r = fileDiffQ(rows, 100, 200, p);
    check('F-c⑧(ii)', '回归红线：全 binary 行（after 缺）+ input 可用 → mode=intent、patch 非空含片段行',
      r.mode === 'intent' && r.patch !== ''
        && r.patch.split('\n').includes('-old-frag') && r.patch.split('\n').includes('+new-frag'),
      `mode=${r.mode} patch=[${r.patch.split('\n').join(' ⏎ ').slice(0, 160)}]`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // F-d 上下文参数生效性（点2）：reconstructed 场景 context 真实可展开（patch 变）；
  // 意图合成场景片段级 diff 无文件上下文（patch 恒等，现状钉）。
  // ═════════════════════════════════════════════════════════════════════════

  console.log('\n=== F-d 上下文参数生效性（点2） ===');

  // ① F-c① 同场景（reconstructed）：context=3 vs context=100000 → 两 patch 字符串不相等。
  {
    const { p, rows } = fc1Case();
    const r3 = fileDiffQ(rows, 100, 200, p, 3);
    const rBig = fileDiffQ(rows, 100, 200, p, 100000);
    check('F-d①', 'reconstructed 场景（F-c① 同款）context=3 vs 100000 → 两 patch 不相等（上下文行数真实变化、可展开）',
      r3.mode === 'reconstructed' && rBig.mode === 'reconstructed' && r3.patch !== rBig.patch,
      `mode=${r3.mode}/${rBig.mode} equal=${String(r3.patch === rBig.patch)}`);
  }

  // ② 意图合成场景：单行 Edit 片段（after 缺失：binary=1 行，input old/new 各一行）context=3 vs 100000
  //    → 两 patch 相等（钉「片段级 diff 无文件上下文可展开」现状）。
  {
    const p = 'fd2.txt';
    const rows = [mkRowQ(1, {
      mrow: 101, path: p, binary: 1, after_content: null, tool_name: 'Edit',
      input_json: JSON.stringify({ file_path: p, old_string: 'old-line', new_string: 'new-line' }),
    })];
    const r3 = fileDiffQ(rows, 100, 200, p, 3);
    const rBig = fileDiffQ(rows, 100, 200, p, 100000);
    check('F-d②', '意图合成场景（片段级 diff 无文件上下文）context=3 vs 100000 → 两 patch 相等（现状钉）',
      r3.mode === 'intent' && rBig.mode === 'intent' && r3.patch === rBig.patch,
      `mode=${r3.mode}/${rBig.mode} equal=${String(r3.patch === rBig.patch)}`);
  }
}

runFcFd();

// ═══════════════════════════════════════════════════════════════════════════
// F-e 渲染层结构钉（点3，计划 §2.5）：读 .vue/.ts 源文件为字符串做结构断言
// （fs.readFileSync + includes；源路径经 path.resolve(repoRoot,…)）。
// 文件缺失/读取失败 → 本组全 FAIL（脚本不 crash）。
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== F-e 渲染层结构钉（点3） ===');

/** 读仓库内源文件为字符串；失败返回 null + 错误信息（不 crash）。 */
function feReadSrc(relSegs: string[]): { src: string | null; err: string } {
  try {
    return { src: fs.readFileSync(path.resolve(repoRoot, ...relSegs), 'utf-8'), err: '' };
  } catch (e) {
    return { src: null, err: errMsg(e) };
  }
}

const feVue = feReadSrc(['src', 'renderer', 'components', 'chat', 'TurnDiffDialog.vue']);
const feTypes = feReadSrc(['src', 'shared', 'types', 'turn-file-diff.ts']);

// ① ctx-group 5 个上下文按钮（v-for n 按钮 + 全文按钮）统一 :disabled="ctxSynthOnly"，
//    且 ctxSynthOnly computed 定义同时覆盖 'first-change' 与 'intent' 两 mode、排他 'reconstructed'
//    （以该 computed 声明起 240 字符窗口断言，钉住定义处而非全文件散布）。
{
  if (feVue.src === null) {
    check('F-e①', 'ctx-group 按钮 :disabled="ctxSynthOnly"（≥2 处、v-for 行/全文行各含）且 computed 恰覆盖 first-change/intent（排他 reconstructed）',
      false, `TurnDiffDialog.vue 读取失败：${feVue.err.slice(0, 160)}`);
  } else {
    const s = feVue.src;
    const lines = s.split(/\r?\n/);
    const disabledCount = (s.match(/:disabled="ctxSynthOnly"/g) ?? []).length;
    const vforLine = lines.find((l) => l.includes('v-for="n in CONTEXT_OPTIONS"')) ?? '';
    const fullBtnLine = lines.find((l) => l.includes('>全文</button>')) ?? '';
    const synthIdx = s.indexOf('ctxSynthOnly = computed(');
    // 窗口口径：声明起 240 字符。实测（2026-11-05）整条单行 computed 定义约 102 字符，其后相邻两行
    // （SPLIT_HL_MAX_LINES / language 声明）不含 'reconstructed' 字样，含该字样的 modeBadge computed
    // 位于声明之前、不入前向窗口；若回归把 'reconstructed' 误加进该 computed，定义约增至 143 字符，
    // 仍在窗口内、被下方排他条件拦截，故 240 足够、无需扩窗。
    const synthWindow = synthIdx >= 0 ? s.slice(synthIdx, synthIdx + 240) : '';
    const synthExcludes = !synthWindow.includes("'reconstructed'");
    const synthCovers = synthWindow.includes("'first-change'") && synthWindow.includes("'intent'") && synthExcludes;
    check('F-e①', 'ctx-group 按钮 :disabled="ctxSynthOnly"（≥2 处、v-for 行/全文行各含）且 computed 恰覆盖 first-change/intent（排他 reconstructed）',
      disabledCount >= 2 && vforLine.includes(':disabled="ctxSynthOnly"')
        && fullBtnLine.includes(':disabled="ctxSynthOnly"') && synthCovers,
      `disabledCount=${disabledCount} vfor行含绑定=${vforLine.includes(':disabled="ctxSynthOnly"')} 全文行含绑定=${fullBtnLine.includes(':disabled="ctxSynthOnly"')} computed窗口覆盖两mode=${synthCovers} computed窗口排他reconstructed=${synthExcludes}`);
  }
}

// ② modeBadge computed 含 reconstructed 徽标文案 '首改（重建对比）'
//    （以该 computed 声明起 500 字符窗口断言，钉在 computed 内而非全文件散布）。
{
  if (feVue.src === null) {
    check('F-e②', "modeBadge computed 含 '首改（重建对比）'", false, `TurnDiffDialog.vue 读取失败：${feVue.err.slice(0, 160)}`);
  } else {
    const badgeIdx = feVue.src.indexOf('modeBadge = computed(');
    const badgeWindow = badgeIdx >= 0 ? feVue.src.slice(badgeIdx, badgeIdx + 500) : '';
    check('F-e②', "modeBadge computed 含 '首改（重建对比）'", badgeWindow.includes("'首改（重建对比）'"),
      badgeIdx < 0 ? '未找到 modeBadge = computed(' : `声明起 500 字符窗口内未命中（窗口前段=${badgeWindow.slice(0, 200)}）`);
  }
}

// ③ TurnFileDiffMode 联合类型含 'reconstructed'（p2 已落类型，本点 RED 阶段即应 PASS）。
{
  if (feTypes.src === null) {
    check('F-e③', "TurnFileDiffMode 联合类型含 'reconstructed'", false, `turn-file-diff.ts 读取失败：${feTypes.err.slice(0, 160)}`);
  } else {
    const unionLine = feTypes.src.split(/\r?\n/).find((l) => l.includes('export type TurnFileDiffMode')) ?? '';
    check('F-e③', "TurnFileDiffMode 联合类型含 'reconstructed'", unionLine.includes("'reconstructed'"),
      `union 行=${unionLine.slice(0, 180)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F-f fs-preview 文本预览（点1）：require '../src/main/modules/fs-preview' 直调 previewFile，
// roots=[临时目录]；模块缺失 → 本组 2 条全 FAIL（脚本不 crash）。
// ═══════════════════════════════════════════════════════════════════════════

let fsPreview: Record<string, unknown> | null = null;
let fsPreviewErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  fsPreview = require(path.resolve(repoRoot, 'src', 'main', 'modules', 'fs-preview.ts')) as Record<string, unknown>;
} catch (e) {
  fsPreviewErr = errMsg(e);
}
const previewFile = fsPreview?.previewFile as
  | ((absPath: unknown, opts: { roots: string[] }) => Promise<unknown>)
  | undefined;

async function runFf(): Promise<void> {
  console.log('\n=== F-f fs-preview 文本预览（点1） ===');
  const segFDir = path.join(stubUserDataDir, 'f-f-files');
  fs.mkdirSync(segFDir, { recursive: true });
  if (typeof previewFile !== 'function') {
    const why = `previewFile 不可用${fsPreviewErr ? `（模块加载失败：${fsPreviewErr.slice(0, 160)}）` : ''}`;
    check('F-f①', 'UTF-16LE BOM txt → ok:true、kind:text、content=转码正确文本、truncated:false', false, why);
    check('F-f②', '无 BOM 含 \\0 txt → ok:false 且 message 含「二进制文件不支持预览」（拒绝路径不变）', false, why);
    return;
  }
  const roots = [segFDir];

  // ① UTF-16LE BOM txt。
  {
    const body = '预览中文 utf16 body\n第二行 ascii\n';
    const p = path.join(segFDir, 'utf16.txt');
    fs.writeFileSync(p, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(body, 'utf16le')]));
    let res: unknown;
    let threw = '';
    try {
      res = await previewFile(p, { roots });
    } catch (e) {
      threw = errMsg(e);
    }
    if (threw) {
      check('F-f①', 'UTF-16LE BOM txt → ok:true、kind:text、content=转码正确文本、truncated:false', false, `previewFile 抛错：${threw.slice(0, 160)}`);
    } else {
      const r = res as Record<string, unknown> | null;
      check('F-f①', 'UTF-16LE BOM txt → ok:true、kind:text、content=转码正确文本、truncated:false',
        !!r && r.ok === true && r.kind === 'text' && r.content === body && r.truncated === false,
        `res=${JSON.stringify(res)?.slice(0, 300)}`);
    }
  }

  // ② 无 BOM 含 \0 txt → 拒绝路径不变。
  {
    const p = path.join(segFDir, 'nul.txt');
    fs.writeFileSync(p, Buffer.from([0x61, 0x00, 0x62]));
    const res = await previewFile(p, { roots }) as Record<string, unknown> | null;
    check('F-f②', '无 BOM 含 \\0 txt → ok:false 且 message 含「二进制文件不支持预览」（拒绝路径不变）',
      !!res && res.ok === false && typeof res.message === 'string' && (res.message as string).includes('二进制文件不支持预览'),
      `res=${JSON.stringify(res)}`);
  }
}

// ── 异步驱动链：F-b（快照全链，fire-and-forget 续体需轮询）→ F-f（previewFile async）→
//    收口：closeConnection → rmSync 临时目录 → 汇总打印 → fail>0 时 exit 1 ──

void runFb()
  .catch((e: unknown) => {
    fail += 1;
    console.log(`  ❌ F-b 异步驱动异常：${errMsg(e)}`);
  })
  .then(() => runFf())
  .catch((e: unknown) => {
    fail += 1;
    console.log(`  ❌ F-f 异步驱动异常：${errMsg(e)}`);
  })
  .then(() => {
    // 先放掉 db 句柄再删目录（对齐 tdd-turn-file-diff-verify 尾部：Windows 上未关闭的
    // better-sqlite3 句柄会让 rmSync 报 EBUSY/EPERM、留下 tmp-userdata-* 残留）。
    try { connectionMod.closeConnection(); } catch { /* 尽力关闭 */ }
    try { fs.rmSync(stubUserDataDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
    try { fs.rmSync(path.dirname(stubUserDataDir), { recursive: true, force: true }); } catch { /* 尽力清理 */ }

    console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
    if (fail > 0) {
      process.exit(1);
    }
    console.log('OK');
  });
