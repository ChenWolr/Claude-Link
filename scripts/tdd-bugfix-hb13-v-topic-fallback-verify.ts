// scripts/tdd-bugfix-hb13-v-topic-fallback-verify.ts
// hb13-v A4【会话】契约（行为级）：topic-analyzer 兜底标题双重损坏修复验证。
//
// 病根（docs/audit/2026-09-13-uncommitted-verify-session-mgmt.md F1/F1b，主会话字节级亲验）：
//   ① firstMessage.replace(/s+/g, ' ') 反斜杠丢失实为字母 s——兜底标题所有小写 s 变空格且落库；
//   ② maskApiKey(rawFallback) 无条件掩码（任意非空输入变 sk-…****+尾4）——全部兜底标题毁掉。
// 修法：恢复 /\s+/g；掩码改条件式（仅首句呈 API key 形态 ^sk-[A-Za-z0-9_-]{8,} 才掩码）。
//
// [SA-4/P6-乙 同步 2026-10-21]：首句兜底写库路径已整体移除（兜底不落库——DB 保留「会话 N」
// 槽位由既有 switchSession 回补链重试；计划 .plan-loop/2026-10-21-turn-projection-title-quality
// §P6-3）。原兜底段行为级用例随主体删除退役；历史修复不变式在仍存活的短输入直写路径
//（§P6-2，≤8 字符不发起 LLM 直接写库）上收窄保持：条件掩码形态（仅 sk- 前缀+≥8 位键字符
// 才掩码，正常输入原样保留——防「无条件掩码毁标题」回归）+ 兜底段确已删除（无 rawFallback /
// 无 slice(0, 15) 截断写库形态）。空白压缩语义由短输入路径的 trim 承担（不再截断不再压缩）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb13-v-topic-fallback-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import { maskApiKey } from '../src/shared/provider-library';

const repoRoot = path.resolve(__dirname, '..');
const analyzer = fs.readFileSync(path.join(repoRoot, 'src/main/modules/topic-analyzer.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

/** 抽取短输入直写路径的掩码判定行（const name = /^sk-…/ …;），注入 trimmed/maskApiKey 实跑。 */
function makeShortInputMaskRunner(): (trimmed: string, mask: (s: string) => string) => string {
  const start = analyzer.indexOf('const name = /^sk-');
  assert.ok(start > -1, '未找到短输入掩码判定行');
  const end = analyzer.indexOf(';', start);
  assert.ok(end > start, '未找到判定行收口');
  const src = analyzer.slice(start, end + 1);
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const wrapper = `(function(__deps){ const {trimmed, maskApiKey} = __deps; ${js}; return name; })`;
  return (trimmed: string, mask: (s: string) => string): string =>
    vm.runInNewContext(wrapper, vm.createContext({}))({ trimmed, maskApiKey: mask }) as string;
}

const run = makeShortInputMaskRunner();

// ① 正常输入：原样保留（掩码不得毁标题——「无条件掩码」病根②回归守卫）。
check('① 正常短输入标题原样保留（「修复登录页面的问题」不被掩码）', () => {
  const got = run('修复登录页面的问题', maskApiKey);
  assert.equal(got, '修复登录页面的问题', `标题被无条件掩码毁掉：${got}`);
});

// ② sk- key 形态：条件掩码生效（防明文密钥落标题，病根②的正向形态）。短输入路径不再
// 先截 15 字符（不截断），掩码取完整输入末 4 位——与原兜底路径（截后掩码）期望值不同。
check('② sk- 形态输入判定为掩码形态（sk-…****+末4位）', () => {
  const got = run('sk-abc1234567890123456', maskApiKey);
  assert.equal(got, 'sk-…****3456', `key 形态输入未被掩码：${got}`);
});

// ③ 结构：兜底段确已删除（P6-乙 兜底不落库——无 rawFallback、无 slice(0, 15) 截断写库形态）。
check('③ 结构：首句兜底写库段已移除（无 rawFallback / 无 slice(0, 15)）', () => {
  assert.ok(!analyzer.includes('const rawFallback ='), 'rawFallback 兜底段残留');
  assert.ok(!analyzer.includes('slice(0, 15)'), '15 字符截断写库形态残留');
});

// ④ 结构：无字母 s 版空白压缩正则残留（病根①回归守卫；短输入路径用 trim，无压缩正则）。
check('④ 结构：无 /s+/g 转义丢失形态残留', () => {
  assert.ok(!/replace\(\/s\+\/g/.test(analyzer), 'replace(/s+/g) 转义丢失形态残留');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
