// tdd-bugfix-p3-10-14-smallfixes-verify.ts
// P3-10/11/12/13/14 契约钉（五个小项合并脚本，逐项断言独立可判）：
//   P3-10 方案 B 兜底容量优先 runtime 快照 capacityTokens；
//   P3-11 Windows 保留设备名附件首段改写 file_<原名>；
//   P3-12 runExport 顶层兜底 catch（finish failed 'unhandled'）+ main.ts .catch；
//   P3-13 api_retry 先分类后转发——确定性错误跳过「重试中」状态卡；
//   P3-14 upstream detail JSON 反转义 + MODEL 正则要求引号（不误捕获 Model Context Protocol）。
//
// 运行：npx tsx scripts/tdd-bugfix-p3-10-14-smallfixes-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyUpstreamError } from '../src/shared/upstream-errors';
import { sanitizeAttachmentFilename } from '../src/main/modules/attachment-policy';

const repoRoot = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const backend = read('src/main/modules/sdk-backend.ts');
const runner = read('src/renderer/export/export-runner.ts');
const exportMain = read('src/renderer/export/main.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

// ── P3-10 ──
check('P3-10① 兜底容量优先 runtime capacityTokens', () => {
  assert.match(backend, /contextWindowCapacityTokens: runtimeCapacity \?\? lastStats\?\.windowSize \?\? null,/);
});

// ── P3-11 ──
check('P3-11① 保留设备名首段改写 file_ 前缀', () => {
  assert.equal(sanitizeAttachmentFilename('CON.txt'), 'file_CON.txt');
  assert.equal(sanitizeAttachmentFilename('NUL'), 'file_NUL');
  assert.equal(sanitizeAttachmentFilename('COM1.md'), 'file_COM1.md');
  assert.equal(sanitizeAttachmentFilename('lpt9'), 'file_lpt9');
});
check('P3-11② 普通名/含保留词中段不误伤', () => {
  assert.equal(sanitizeAttachmentFilename('report.txt'), 'report.txt');
  assert.equal(sanitizeAttachmentFilename('myCON.txt'), 'myCON.txt');
  assert.equal(sanitizeAttachmentFilename('second/CON.txt'), 'file_CON.txt');
});

// ── P3-12 ──
check('P3-12① runExport 顶层 try/catch + finish failed unhandled', () => {
  assert.ok(runner.includes("code: 'unhandled'"), '须有 unhandled 失败码');
  assert.match(runner, /} catch \(e\) \{[\s\S]*?api\.finish\(\{ kind: 'failed', jobId,/);
});
check('P3-12② main.ts 加 .catch', () => {
  assert.match(exportMain, /runExport\(\)\.catch/);
});
check('P3-12③ 既有失败码保留（回归）', () => {
  assert.match(runner, /code: 'no-job'/);
  assert.match(runner, /code: 'too-many-pages'/);
});

// ── P3-13 ──
check('P3-13① 分类先于 forwardTransient（确定性错误跳过重试卡）', () => {
  const at = backend.indexOf("if (infoSubtype === 'api_retry') {");
  const seg = backend.slice(at, backend.indexOf('权限询问/拒绝事件', at));
  const classifyAt = seg.indexOf('const upstream = classifyUpstreamError');
  const fwdAt = seg.indexOf('forwardTransient(sessionId, mainWindow, sysInfo)');
  assert.ok(classifyAt > -1 && fwdAt > classifyAt, 'classify 须在 forwardTransient 之前');
  assert.match(seg, /if \(!nonRetryableNow\) \{\s*forwardTransient/);
});

// ── P3-14 ──
check('P3-14① 转义 JSON message 反转义为可读文案', () => {
  const c = classifyUpstreamError('{"error":{"type":"model_not_found","message":"Model \\"glm-5.2\\" is not supported"}}');
  assert.equal(c.modelId, 'glm-5.2');
  assert.equal(c.detail, 'Model "glm-5.2" is not supported');
});
check('P3-14② 反例：转义引号裸文本 `Model \\"Context\\"` → modelId 必须为 null', () => {
  // 运行时字符串为 Model \"Context\"（含字面反斜杠引号，双重序列化残留形态）。
  // 修复前 MODEL_IN_MSG_RE 的 `\\?` 会吃掉转义引号误捕 'Context'；修复后要求真实引号，
  // 残留转义形态不再捕获（审计报告 §4.1：原 ② 对 HEAD 基线即通过、属恒真，故换反例）。
  const c = classifyUpstreamError('Model \\"Context\\" (MCP) tools failed');
  assert.equal(c.modelId, null, `escaped-quote 形态不应捕获，got ${String(c.modelId)}`);
});
check('P3-14②补 裸文本 Model Context Protocol 不捕获（原回归保留）', () => {
  const c = classifyUpstreamError('{"error":{"type":"server_error","message":"Model Context Protocol (MCP) tools failed"}}');
  assert.equal(c.modelId, null);
});
check('P3-14③ 反转义失败保持原样（不抛错）', () => {
  const c = classifyUpstreamError('{"error":{"type":"server_error","message":"bad \\\\uZZ tail"}}');
  assert.ok(typeof c.detail === 'string');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
