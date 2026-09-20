// tdd-skill-nullproto-verify.ts
// B-2（review 2026-09-18 §3-11）：`__proto__` skill 名开关 no-op——setSkillEnabled 旧形态
// `const next = { ...store.config.skillOverrides }` 后 `next['__proto__'] = 'off'` 走
// Object.prototype 的 __proto__ setter，自有属性不落、拨开关静默无效。
// 整改 = next 改 `Object.assign(Object.create(null), ...)`（自有属性语义，赋值/删除均安全；
// saveConfig 的 JSON 往返归一为普通对象，IPC 安全）。
// 断言：①node 直调复现——旧展开形态 '__proto__' 键写入 no-op（缺陷在位证明），null-proto 形态
// '__proto__'/'constructor' 键可写入（Object.keys 可见 + JSON 往返保形）可删除 ②ConfigPage
// setSkillEnabled 源形钉（Object.create(null) + Object.assign）。
// RED 预期（未修复树）：② FAIL。运行：npx tsx scripts/tdd-skill-nullproto-verify.ts。

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

// ① node 直调复现：旧形态缺陷 + 新形态修复（两种形态行为永久钉死，防回归口径漂移）
{
  const sub: string[] = [];
  // 旧形态：展开字面量 → '__proto__' 赋值走原型 setter，自有属性不落
  const oldNext: Record<string, 'off'> = { ...(JSON.parse('{"a":"off"}') as Record<string, 'off'>) };
  oldNext['__proto__'] = 'off';
  if (Object.keys(oldNext).includes('__proto__')) sub.push('旧形态 __proto__ 竟然落了自有属性（复现前提失效）');
  // 新形态：null 原型对象 → 自有属性语义
  const newNext: Record<string, 'off'> = Object.assign(Object.create(null), JSON.parse('{"a":"off"}') as Record<string, 'off'>);
  newNext['__proto__'] = 'off';
  newNext['constructor'] = 'off';
  if (!Object.keys(newNext).includes('__proto__') || !Object.keys(newNext).includes('constructor'))
    sub.push('null-proto 形态 __proto__/constructor 键应可写入（Object.keys 可见）');
  if (JSON.parse(JSON.stringify(newNext)).__proto__ !== 'off') sub.push('JSON 往返应保形（IPC 安全）');
  delete newNext['__proto__'];
  if (Object.keys(newNext).includes('__proto__')) sub.push('null-proto 形态 __proto__ 键应可删除');
  check('①', '直调复现：旧展开形态 __proto__ no-op（缺陷）；null-proto 形态可写入/JSON 保形/可删除', sub.length === 0, sub.join('; '));
}

// ② ConfigPage 源形钉：setSkillEnabled 的 next 为 null 原型对象
{
  const sub: string[] = [];
  const fnAt = src.indexOf('function setSkillEnabled');
  const body = fnAt >= 0 ? src.slice(fnAt, fnAt + 500) : '';
  if (fnAt < 0) sub.push('缺 setSkillEnabled 定义');
  else {
    if (!body.includes('Object.create(null)')) sub.push('setSkillEnabled 的 next 未用 Object.create(null)（__proto__ 名开关仍 no-op）');
    if (!body.includes('Object.assign')) sub.push('setSkillEnabled 的 next 未用 Object.assign 拷贝既有键');
  }
  check('②', 'ConfigPage：setSkillEnabled 的 next 改 null 原型对象（Object.assign + Object.create(null)）', sub.length === 0, sub.join('; '));
}

console.log(`\n===== tdd-skill-nullproto-verify: ${pass} pass / ${fail} fail =====`);
if (fail > 0) console.log('（RED 阶段：FAIL 项为尚未实施的生产改动，实施后应全 PASS）');
process.exit(fail > 0 ? 1 : 0);
