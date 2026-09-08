// tdd-bugfix-p1-12-13-export-verify.ts
// P1-12：JPEG 导出全程无看门狗重置 → 健康长导出 90s 必被误杀。
//   修复：EXPORT_RENDER_PROGRESS 处理器内调 resetWatchdog（PNG 路径幂等无害；已终态 job no-op）。
// P1-13：单张导出确认「替换」却报「目标已存在」→ 导出失败。
//   修复：经保存对话框确认的目标存在时先删后写；目录批量路径保留 COPYFILE_EXCL 排他语义。
//
// 运行：npx tsx scripts/tdd-bugfix-p1-12-13-export-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(repoRoot, 'src/main/modules/export-image-manager.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// P1-12。
const progressAt = src.indexOf('IPC_CHANNELS.EXPORT_RENDER_PROGRESS');
const progressBody = src.slice(progressAt, src.indexOf('});', progressAt));
check('① EXPORT_RENDER_PROGRESS 处理器调 resetWatchdog（长导出不误杀）',
  progressBody.includes('resetWatchdog('), progressBody.slice(0, 120));
check('② resetWatchdog 对已终态 job no-op（terminal 门，迟到进度安全）',
  /function resetWatchdog[\s\S]{0,200}active\.terminal\) return;/.test(src));

// P1-13。
const saveBody = src.slice(src.indexOf('async function performSave'), src.indexOf('/** 排他移动'));
check('③ 单张分支存在时先删后写（不再 COPYFILE_EXCL 报目标已存在）',
  saveBody.includes('if (existsSync(target)) unlinkSync(target);') &&
  saveBody.slice(saveBody.indexOf('if (existsSync(target))')).includes('copyFileSync(pages[0].path, target);'));
check('④ 批量路径保留排他语义（moveExclusive 不回退）',
  saveBody.includes('await moveExclusive(pages[i].path, target);') &&
  /moveExclusive[\s\S]{0,400}COPYFILE_EXCL/.test(src.slice(src.indexOf('async function moveExclusive'))));

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
