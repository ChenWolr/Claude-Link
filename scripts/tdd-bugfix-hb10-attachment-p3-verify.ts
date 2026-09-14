// scripts/tdd-bugfix-hb10-attachment-p3-verify.ts
// hb10 P3 ATT 批契约（ATT-02/03/04收窄/05/06/07/09/V02/V01；V01 与 hb12-SMG-09 合流由 SESSION_CREATE 回滚覆盖）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-attachment-p3-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const storage = read('src/main/modules/attachment-storage.ts');
const attTypes = read('src/shared/types/attachment.ts');
const svc = read('src/main/modules/attachment-service.ts');
const handlers = read('src/main/ipc-handlers.ts');
const msgAtt = read('src/renderer/components/chat/MessageAttachments.vue');
const draftStore = read('src/renderer/stores/chat-draft-store.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① ATT-02（hb13-v B10.5 改钉）：解码失败探针取尺寸返回原图；downscaled 死字段已删除
//（旧断言钉类型字段+写入点，但渲染层零消费者——「渲染层半边」永不存在，取删除=最小影响）。
check('① ATT-02：解码失败探针取尺寸返回原图（downscaled 死字段已删除）', () => {
  assert.ok(!attTypes.includes('downscaled'), '类型 downscaled 死字段残留（渲染层无消费者）');
  assert.ok(!storage.includes('downscaled'), 'storage downscaled 写点残留');
  assert.match(storage, /hb10-ATT-02/, '缩略图分支缺解码失败兜底注释');
  assert.match(storage, /const probed = probeImageDimensions\(bytes\);/, '缺探针取尺寸');
});

// ② ATT-03。
check('② ATT-03：MessageAttachments.openPreview 会话归属守卫', () => {
  const idx = msgAtt.indexOf('async function openPreview');
  const body = msgAtt.slice(idx, idx + 700);
  assert.match(body, /sessionStore\.activeSession\?\.id !== sid\)? return|activeSession\?\.id !== sid/, '缺归属守卫');
  const guardIdx = body.indexOf('sessionStore.activeSession?.id !== sid');
  assert.ok(guardIdx > -1 && guardIdx < body.indexOf('let url ='), '守卫必须先于取图');
});

// ③ ATT-04 收窄 + ATT-V01。
check('③ ATT-04/V01：bind 归属守卫 + 失败回滚已建行', () => {
  const idx = svc.indexOf('export function bindTransientAttachmentsToSession');
  const body = svc.slice(idx, idx + 1600);
  assert.match(body, /record\.sessionId !== sessionId\) return/, '缺归属守卫');
  assert.match(body, /boundIds/, '缺已建行收集');
  assert.match(body, /attachmentRepo\.deleteAttachment\(id\)/, '缺回滚删除');
  assert.match(body, /throw err;/, '回滚后未重抛（半态静默=死锁保留）');
});

// ④ ATT-05。
check('④ ATT-05：TASK_REMOVE 仅 pending 可删', () => {
  const idx = handlers.indexOf('IPC_CHANNELS.TASK_REMOVE');
  const body = handlers.slice(idx, idx + 900);
  assert.match(body, /task\.status !== 'pending'/, '缺状态守卫');
  assert.match(body, /仅待执行任务可删除/, '缺守卫文案');
  const guardIdx = body.indexOf("task.status !== 'pending'");
  const delIdx = body.indexOf('taskRepo.deleteTask(taskId)');
  assert.ok(delIdx > guardIdx, '守卫必须先于删除');
});

// ⑤ ATT-06。
check('⑤ ATT-06：PICK 截断 10 + draftStore 上限丢弃', () => {
  assert.match(handlers, /result\.filePaths\.slice\(0, 10\)/, 'PICK 缺截断');
  assert.match(handlers, /一次最多 10 个附件|hb10-ATT-06/, 'PICK 缺限量注释');
  assert.match(draftStore, /attachments\.slice\(0, room\)/, 'draftStore 缺上限丢弃');
});

// ⑥ ATT-07。
check('⑥ ATT-07：PICK 错误文案脱敏（原文仅 logger）', () => {
  // hb13-v 批C 改钉（原为双分支相同的三元恒真断言）：直接钉脱敏变量声明形态。
  assert.match(handlers, /const safeMessage =/, '缺脱敏变量 safeMessage');
  assert.match(handlers, /部分附件保存失败（可能已被删除）/, '缺中性文案');
  assert.match(handlers, /sanitized error: /, '原文未走 logger');
});

// ⑦ ATT-09/V02。
check('⑦ ATT-09/V02：STAGE_BYTES 32MiB 早退 + 原图预览限 image kind', () => {
  const idx = handlers.indexOf('IPC_CHANNELS.ATTACHMENT_STAGE_BYTES');
  const body = handlers.slice(idx, idx + 900);
  assert.match(body, /32 \* 1024 \* 1024/, '缺 32MiB 上限');
  assert.match(svc, /!request\.thumbnail && record\.kind !== 'image'/, '原图预览缺 kind 限制');
});


// ⑧ hb12-ATT-06（2026-09-13 二轮补救，EXIF 半边）：缩略图按 EXIF orientation 转正后再缩放。
check('⑧ ATT-06：JPEG EXIF orientation 解析 + 位图转正 + createFromBitmap 重建', () => {
  assert.match(storage, /function readJpegExifOrientation\(/, '缺 EXIF orientation 解析函数');
  assert.match(storage, /0x0112/, '缺 orientation 标签（0x0112）');
  assert.match(storage, /function uprightBitmap\(/, '缺位图转正函数');
  assert.match(storage, /nativeImage\.createFromBitmap\(/, '缺转正后位图重建');
  assert.match(storage, /nativeImage 不应用 EXIF/, '缺依据注释');
  assert.match(storage, /CMYK 半边维持留档/, '缺 CMYK 留档注释');
});

// ⑧b ATT-06 行为级（hb13-v A6）：vm 抽取 readJpegExifOrientation 实调，合成 II/MM 字节序 ×
// orientation 6/8 四样张断言解析正确。旧实现 IFD 偏移读 u32(tiff+4) 错位（tiff 变量实指
// "Exif\0\0" 起始，TIFF 头在 tiff+6、IFD 偏移在 tiff+10）→ 全部带方向 JPEG 恒解析为 1，
// 静态钉测不出。样张布局：FFD8 FFE1 len "Exif\0\0" [BO 002A ifdOff=8] [count=1 entry next=0]。
function buildExifJpeg(byteOrder: 'II' | 'MM', orientation: number): Uint8Array {
  const be = byteOrder === 'MM';
  const u16 = (v: number): number[] => (be ? [v >> 8, v & 0xff] : [v & 0xff, v >> 8]);
  const u32 = (v: number): number[] => (be
    ? [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
    : [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
  const tiff = [...(byteOrder === 'II' ? [0x49, 0x49] : [0x4d, 0x4d]), 0x00, 0x2a, ...u32(8)];
  const entry = [...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0x00, 0x00];
  const ifd = [...u16(1), ...entry, ...u32(0)];
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff, ...ifd];
  const segLen = payload.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff, ...payload]);
}
check('⑧b ATT-06 行为级：II/MM×orientation 6/8 四样张解析正确（偏移错位回归门）', () => {
  const fnIdx = storage.indexOf('function readJpegExifOrientation');
  assert.ok(fnIdx > -1, '未找到 readJpegExifOrientation');
  const fnEnd = storage.indexOf('\n}', fnIdx);
  const js = ts.transpileModule(storage.slice(fnIdx, fnEnd + 2), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const parse = vm.runInNewContext(`(function(){ ${js}; return readJpegExifOrientation; })()`, vm.createContext({})) as (b: Uint8Array) => number;
  for (const bo of ['II', 'MM'] as const) {
    for (const o of [6, 8]) {
      assert.equal(parse(buildExifJpeg(bo, o)), o, `${bo} 字节序 orientation=${o} 未解析出（错位恒 1 → uprightBitmap 死代码）`);
    }
  }
  assert.equal(parse(buildExifJpeg('II', 1)), 1, 'orientation=1 应返回 1');
  assert.equal(parse(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02])), 1, '无 EXIF JPEG 应恒 1');
});

// ⑨ hb13-v B10.2：草稿 10 上限——addAttachments 返回被拒摘要（调用方 notice），不再静默丢弃。
check('⑨ B10.2：addAttachments 返回被拒摘要列表（ATT-06「调用方弹 notice」承诺兑现）', () => {
  const idx = draftStore.indexOf('addAttachments(sessionId: string, attachments: AttachmentSummary[])');
  assert.ok(idx > -1, '未找到 addAttachments');
  const body = draftStore.slice(idx, draftStore.indexOf('\n    },', idx));
  assert.match(body, /: AttachmentSummary\[\] \{/, '返回类型应为被拒摘要数组');
  assert.match(body, /const rejected/, '缺 rejected 收集');
  assert.match(body, /return rejected;/, '缺被拒列表返回');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
