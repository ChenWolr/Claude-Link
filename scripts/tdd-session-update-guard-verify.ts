// tdd-session-update-guard-verify.ts
// D-8（review 2026-09-18 §3-14）：SESSION_UPDATE 无形状校验——data 为 null/非对象时
// `data.thinkingLevel` 白名单访问 TypeError → invoke reject（渲染层 6 处恒传对象，当前不可达，
// 属防御惯例对齐：其他 handler 均有入参防御，此处补齐）。
// 整改 = handler 入口 `if (!data || typeof data !== 'object') return false;`。
// 断言（源形钉，⑰ 同款区域切片）：①守卫字面在位且位于白名单访问之前 ②守卫返回 false 形态。
// RED 预期（未修复树）：①② FAIL。运行：npx tsx scripts/tdd-session-update-guard-verify.ts。

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(repoRoot, 'src/main/ipc-handlers.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

{
  const updAt = src.indexOf('IPC_CHANNELS.SESSION_UPDATE');
  const nextAt = updAt >= 0 ? src.indexOf('IPC_CHANNELS.', updAt + 10) : -1;
  const region = updAt >= 0 && nextAt > updAt ? src.slice(updAt, nextAt) : '';
  const sub: string[] = [];
  if (updAt < 0) sub.push('缺 SESSION_UPDATE handler');
  else {
    const guardAt = region.indexOf("if (!data || typeof data !== 'object')");
    if (guardAt < 0) sub.push('缺 data 形状守卫（!data || typeof data !== \'object\'）');
    else {
      const whitelistAt = region.indexOf('data.thinkingLevel');
      if (whitelistAt < 0) sub.push('区域锚定异常（白名单段未找到）');
      else if (guardAt > whitelistAt) sub.push('形状守卫应位于白名单访问（data.thinkingLevel）之前——否则 null 入参仍先炸');
      if (!/return false;/.test(region.slice(guardAt, guardAt + 90))) sub.push('守卫应直接 return false（拒绝而非抛错）');
    }
  }
  check('①②', 'SESSION_UPDATE：入口 data 形状守卫（先于白名单访问，return false 拒绝）', sub.length === 0, sub.join('; '));
}

console.log(`\n===== tdd-session-update-guard-verify: ${pass} pass / ${fail} fail =====`);
if (fail > 0) console.log('（RED 阶段：FAIL 项为尚未实施的生产改动，实施后应全 PASS）');
process.exit(fail > 0 ? 1 : 0);
