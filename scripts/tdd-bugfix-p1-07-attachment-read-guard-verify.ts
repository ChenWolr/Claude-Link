// tdd-bugfix-p1-07-attachment-read-guard-verify.ts
// P1-7 契约钉：选附件把整个文件读进内存后才校验大小 → 数 GB 文件可致主进程 OOM。
//
// 修复语义：主进程 ATTACHMENT_PICK 读前 fsp.stat 早退（>32MiB 直接按既有文案报错）；
// renderer 拖放/粘贴先查 file.size 同阈值早退。精确 10/30MiB 区分仍由既有校验裁定，
// ≤32MiB 行为完全不变。
//
// 运行：npx tsx scripts/tdd-bugfix-p1-07-attachment-read-guard-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const policy = read('src/main/modules/attachment-policy.ts');
const ipc = read('src/main/ipc-handlers.ts');
const chatPage = read('src/renderer/pages/ChatPage.vue');

check('① policy 导出共享守卫常量 ATTACHMENT_READ_GUARD_BYTES = 32MiB',
  /export const ATTACHMENT_READ_GUARD_BYTES = 32 \* 1024 \* 1024;/.test(policy));

// ATTACHMENT_PICK 循环体：stat 守卫在 readFile 之前。
const pickAt = ipc.indexOf('IPC_CHANNELS.ATTACHMENT_PICK');
const loopAt = ipc.indexOf('for (const filePath of result.filePaths)', pickAt);
const loopBody = ipc.slice(loopAt, ipc.indexOf('return { attachments, errors }', loopAt));
check('② 主进程读前 stat 守卫（stat 先于 readFile，超限抛既有形态错误）',
  loopBody.includes('await fsp.stat(filePath)') &&
  loopBody.indexOf('await fsp.stat(filePath)') < loopBody.indexOf('await fsp.readFile(filePath)') &&
  loopBody.includes('ATTACHMENT_READ_GUARD_BYTES') &&
  loopBody.includes('超过'));
check('③ renderer 拖放/粘贴读 bytes 前按 file.size 早退（同阈值）',
  chatPage.includes('file.size > 32 * 1024 * 1024') &&
  chatPage.indexOf('file.size > 32 * 1024 * 1024') < chatPage.indexOf('await file.arrayBuffer()'));
check('④ ATTACHMENT_STAGE_BYTES 主进程二次校验路径不变（不信任 renderer）',
  ipc.includes("IPC_CHANNELS.ATTACHMENT_STAGE_BYTES") && ipc.includes('detectDirectImageFormat(input.bytes)'));

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
