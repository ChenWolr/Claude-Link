// tdd-skill-dirs-generation-verify.ts
// C-4（≡K1，review 2026-09-18 §3-6）：ensureProjectDirs 无请求代际守卫——坏目录场景旧 IPC 响应
// 可拖秒级，乱序返回会覆盖新请求的最新结果（13 坏目录最坏 ~78s 窗口）。
// 整改 = ConfigPage 模块级自增 requestId（先例 config-store.nativeSettingsDiagnosticRequestId
// 同款）：请求前 ++，响应后仅最新代际可写 projectDirs。与 P2-4 in-flight 共享叠加（共享消并发、
// 代卫消串行乱序）。
// 断言（SFC 组件函数，按 ⑫ 先例做源形钉）：①模块级 requestId 变量 + 请求前自增 ②响应写回前
// 代际校验（仅最新代际可写 projectDirs）。RED 预期（未修复树）：①② FAIL。
// 运行：npx tsx scripts/tdd-skill-dirs-generation-verify.ts。

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(repoRoot, 'src/renderer/pages/ConfigPage.vue'), 'utf8');

let pass = 0;
let fail = 0;
function check(no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

{
  const sub: string[] = [];
  const fnAt = src.indexOf('async function ensureProjectDirs');
  if (fnAt < 0) {
    sub.push('缺 ensureProjectDirs 定义');
  } else {
    // 请求体窗口（定义起 ~1000 字符覆盖函数体与守卫）
    const body = src.slice(fnAt, fnAt + 1000);
    if (!/let projectDirsRequestId\s*=\s*0/.test(src)) sub.push('缺模块级 requestId 计数变量（projectDirsRequestId）');
    if (!/\+\+projectDirsRequestId/.test(body)) sub.push('请求前缺代际自增（++projectDirsRequestId）');
    // 代际校验形态（C-5 批同步）：`requestId !== projectDirsRequestId` 失守早退（等价于
    // 「仅最新代际可写」——旧响应乱序返回时直接作废，语义与写前校验一致，断言随行为同步改）。
    if (!/requestId\s*!==\s*projectDirsRequestId/.test(body)) sub.push('响应缺代际失守判定（requestId !== projectDirsRequestId）');
    if (!/projectDirs\.value\s*=/.test(body)) sub.push('缺 projectDirs 写回形态');
    // 代际失守判定须在写回之前（守卫先行，不能先写后判）
    const guardAt = body.indexOf('requestId !== projectDirsRequestId');
    const writeAt = body.indexOf('projectDirs.value =');
    if (guardAt < 0 || writeAt < 0 || guardAt > writeAt) sub.push('代际失守判定应在 projectDirs 写回之前');
  }
  check('①②', 'ConfigPage：ensureProjectDirs 代际守卫（模块级 requestId 自增 + 写回前校验，先例同款）', sub.length === 0, sub.join('; '));
}

console.log(`\n===== tdd-skill-dirs-generation-verify: ${pass} pass / ${fail} fail =====`);
if (fail > 0) console.log('（RED 阶段：FAIL 项为尚未实施的生产改动，实施后应全 PASS）');
process.exit(fail > 0 ? 1 : 0);
