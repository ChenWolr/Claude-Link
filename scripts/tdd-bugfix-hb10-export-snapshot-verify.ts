// scripts/tdd-bugfix-hb10-export-snapshot-verify.ts
// hb10 P2-10（EXP-03）+ P2-11（EXP-04）契约：附件快照并发受限+边加载预算短路 + 超长单消息预检快速失败。
//
// P2-10 病根：buildExportAttachmentSnapshots 嵌套无上限 Promise.all——大量图片附件同时整读进内存，
// 且预算校验（checkSnapshotBudget）发生在全部加载完成后，先整读后判预算 = OOM 前置。
// 修法：①8 并发 worker-pool（flatten 任务队列循环取）；②readStoredAttachmentPreview 增加可选
// maxBytes 参数，读文件前 statSync 预检，超限抛错→上层降级 previewUnavailable（不读文件）；
// ③快照构建边加载边累计预览字节，超预算对剩余任务短路降级；④删除快照侧冗余 Uint8Array.from。
//
// P2-11 病根：splitPages 对单项超页预算只「自成一项」，走到捕获期才以 page-over-budget /
// png-over-budget 整单失败，错误不可理解。
// 修法（预检 + 可理解报错，不恢复 item 内分割）：splitPages 检测 h > maxHeight → 置
// runnerState.oversizeItem 并提前收口，runExport 以 code:'item-over-budget'、文案含条目序号快速失败。
// （前置依赖：hb12-EXP-01 已先修——否则 itemHeights=[整文档高] 会把每份导出误判超长。）
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-export-snapshot-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const snapshot = read('src/main/modules/export-attachment-snapshot.ts');
const storage = read('src/main/modules/attachment-storage.ts');
const manager = read('src/main/modules/export-image-manager.ts');
const runner = read('src/renderer/export/export-runner.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// —— P2-10 ——
check('① 快照构建：8 并发 worker-pool 形态（任务队列 + 上限 worker），不再无上限嵌套 Promise.all', () => {
  assert.doesNotMatch(snapshot, /Promise\.all\(messages\.map\(async \(message\)/, '仍是无上限嵌套 Promise.all（原病根未修）');
  assert.match(snapshot, /maxConcurrency/, '缺 maxConcurrency 并发上限参数');
  assert.match(snapshot, /budgetBytes/, '缺 budgetBytes 预算参数');
  assert.match(snapshot, /while \(next < tasks\.length\)/, '缺任务队列 worker 循环（worker-pool 形态）');
  assert.match(snapshot, /Array\.from\(\{ length: Math\.min\(maxConcurrency/, 'worker 数未按 maxConcurrency 收敛');
});

check('② 快照构建：边加载边累计预算，超预算对剩余任务短路降级 previewUnavailable', () => {
  assert.match(snapshot, /budgetExhausted/, '缺预算耗尽标志');
  assert.match(snapshot, /usedBytes \+= preview\.bytes\.byteLength/, '缺预览字节累计');
  const exhaustedIdx = snapshot.indexOf('budgetExhausted = true');
  assert.ok(exhaustedIdx > -1, '缺 budgetExhausted 置位');
  assert.match(snapshot, /previewUnavailable: true/, '超预算任务缺 previewUnavailable 降级');
  assert.doesNotMatch(snapshot, /Uint8Array\.from\(preview\.bytes\)/, '快照侧仍有冗余 Uint8Array.from（readStoredAttachmentPreview 已返回新副本，双拷贝应删）');
  // hb13-v B10.5：toBlobPart 段同样去掉 Uint8Array.from 逐元素双拷——Buffer→独立 ArrayBuffer
  // 改用 buffer.slice（单次内存拷贝，byteOffset 安全），sendToWorker 零拷贝 transfer 语义不变。
  assert.doesNotMatch(manager, /Uint8Array\.from\(pngBuf\)/, 'toBlobPart 段仍有 Uint8Array.from(pngBuf) 逐元素双拷');
  assert.match(manager, /pngBuf\.buffer\.slice\(pngBuf\.byteOffset, pngBuf\.byteOffset \+ pngBuf\.byteLength\)/, '缺 byteOffset-safe 单次拷贝形态');
  // hb13-v review 补修：renderer 侧同款双拷（export-runner createImageBitmap 段）——B10.5
  // 「两处替换」此前只修了主进程 manager，renderer 半边本轮补修。
  assert.doesNotMatch(runner, /Uint8Array\.from\(cap\.png\)/, 'renderer 导出段仍有 Uint8Array.from(cap.png) 逐元素双拷');
  assert.match(runner, /cap\.png\.buffer\.slice\(cap\.png\.byteOffset, cap\.png\.byteOffset \+ cap\.png\.byteLength\)/, 'renderer 缺 byteOffset-safe 单次拷贝形态');
});

check('③ readStoredAttachmentPreview：可选 maxBytes + statSync 读前预检（超限不读文件直接抛错降级）', () => {
  const fnIdx = storage.indexOf('export async function readStoredAttachmentPreview');
  assert.ok(fnIdx > -1, '未找到 readStoredAttachmentPreview');
  const fnEnd = storage.indexOf('\n}', fnIdx);
  const body = storage.slice(fnIdx, fnEnd > -1 ? fnEnd : undefined);
  assert.match(body, /maxBytes\?: number/, '缺可选 maxBytes 参数（其他调用方零影响）');
  const statIdx = body.indexOf('statSync');
  const readIdx = body.indexOf('fsp.readFile');
  assert.ok(statIdx > -1, '缺 statSync 预检');
  assert.ok(readIdx > statIdx, 'statSync 预检必须位于 readFile 之前（先判后读）');
  assert.match(body, /st\.size > maxBytes/, '缺 size > maxBytes 判定');
  // 其他既有调用方签名不变（两参调用仍合法）。
  assert.match(storage, /thumbnail: boolean/, '原 thumbnail 参数形态被破坏');
});

check('④ export-image-manager：快照构建传入预算与并发上限 + loader 传 maxBytes', () => {
  const callIdx = manager.indexOf('buildExportAttachmentSnapshots(');
  assert.ok(callIdx > -1, '未找到 buildExportAttachmentSnapshots 调用');
  const callBody = manager.slice(callIdx, manager.indexOf('checkSnapshotBudget', callIdx));
  assert.match(callBody, /budgetBytes/, '快照构建未传 budgetBytes（边加载短路失效）');
  assert.match(callBody, /maxConcurrency:\s*8/, '快照构建未传 8 并发上限');
  assert.match(callBody, /readStoredAttachmentPreview\(record, true, \w+\)/, 'loader 未传 maxBytes 预检参数');
  assert.match(manager, /SNAPSHOT_TOTAL_BYTES_MAX/, '预算未复用 shared 既有常量');
});

// —— P2-11 ——
check('⑤ splitPages：单项超页预算预检（h > maxHeight 置 oversizeItem 提前收口）', () => {
  const fnIdx = runner.indexOf('function splitPages');
  const fnEnd = runner.indexOf('\n}', fnIdx);
  const body = runner.slice(fnIdx, fnEnd > -1 ? fnEnd : undefined);
  assert.match(body, /h > maxHeight/, 'splitPages 缺单项超预算检测');
  assert.match(body, /runnerState\.oversizeItem = \{ index: i, heightPx: h \}/, '缺 oversizeItem 记录（条目序号定位）');
  const oversizeIdx = body.indexOf('runnerState.oversizeItem');
  const accIdx = body.indexOf('acc += h');
  assert.ok(oversizeIdx < accIdx, '超长项必须提前收口（不得继续累加进入页序列）');
  assert.match(runner, /oversizeItem: null as \{ index: number; heightPx: number \} \| null,/, 'runnerState 缺 oversizeItem 字段');
});

check('⑥ runExport：item-over-budget 快速失败出口（文案含条目序号，位于捕获循环之前）', () => {
  assert.match(runner, /code: 'item-over-budget'/, "缺 code: 'item-over-budget' 失败出口");
  assert.match(runner, /条消息高度超过单页上限，无法导出/, '缺可理解文案（含条目序号）');
  assert.match(runner, /runnerState\.oversizeItem = null;/, 'splitPages 缺 oversizeItem 复位（跨 job 残留会误杀下一次导出）');
  const mmIdx = runner.indexOf("code: 'measurement-mismatch'");
  const itemIdx = runner.indexOf("code: 'item-over-budget'");
  const loopIdx = runner.indexOf('for (let pi = 0');
  assert.ok(loopIdx > -1, '未找到捕获循环');
  assert.ok(itemIdx < loopIdx, 'item-over-budget 出口必须位于捕获循环之前（预检快速失败，不走到 capture 才报 page-over-budget）');
  assert.ok(mmIdx < itemIdx, 'measurement-mismatch（hb12-EXP-01）应先于 item-over-budget 检查（测量失真时两个判据都不可信）');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
