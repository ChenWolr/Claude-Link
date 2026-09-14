// scripts/tdd-bugfix-hb13-v-topic-fallback-verify.ts
// hb13-v A4【会话】契约（行为级）：topic-analyzer 兜底标题双重损坏修复验证。
//
// 病根（docs/audit/2026-09-13-uncommitted-verify-session-mgmt.md F1/F1b，主会话字节级亲验）：
//   ① firstMessage.replace(/s+/g, ' ') 反斜杠丢失实为字母 s——兜底标题所有小写 s 变空格且落库；
//   ② maskApiKey(rawFallback) 无条件掩码（任意非空输入变 sk-…****+尾4）——全部兜底标题毁掉。
// 修法：恢复 /\s+/g；掩码改条件式（仅首句呈 API key 形态 ^sk-[A-Za-z0-9_-]{8,} 才掩码）。
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

/** 抽取兜底段（rawFallback→fallback→空串守卫），注入 firstMessage/maskApiKey 实跑。 */
function makeFallbackRunner(): (firstMessage: string, mask: (s: string) => string) => string | null {
  const start = analyzer.indexOf('const rawFallback =');
  assert.ok(start > -1, '未找到 rawFallback 段');
  const guardEnd = analyzer.indexOf('return null;', start);
  assert.ok(guardEnd > start, '未找到空串守卫');
  const blockEnd = analyzer.indexOf('}', guardEnd);
  const src = analyzer.slice(start, blockEnd + 1);
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const wrapper = `(function(__deps){ const {firstMessage, maskApiKey} = __deps; ${js}; return fallback; })`;
  return (firstMessage: string, mask: (s: string) => string): string | null =>
    vm.runInNewContext(wrapper, vm.createContext({}))({ firstMessage, maskApiKey: mask }) as string | null;
}

const run = makeFallbackRunner();

// ① 正常句：原样保留（掩码不得毁标题）。
check('① 正常句兜底标题原样保留（「修复登录页面的问题」不被掩码）', () => {
  const got = run('修复登录页面的问题', maskApiKey);
  assert.equal(got, '修复登录页面的问题', `兜底标题被无条件掩码毁掉：${got}`);
});

// ② 含 s 句：小写 s 不得变空格（正则转义丢失复现）。
check('② 含小写 s 句：空白压缩用 /\\s+/g，字母 s 原样保留', () => {
  const got = run('parse error message and retry logic here', maskApiKey);
  assert.equal(got, 'parse error mes', `字母 s 被替换成空格（/s+/g 转义丢失）：${got}`);
  assert.ok(!got.includes('  '), '出现连续空格（空白压缩失效）');
});

// ③ sk- key 形态首句：条件掩码生效（防明文密钥落库）。
check('③ sk- 形态首句落库为掩码形态（sk-…****+尾4）', () => {
  const got = run('sk-abc1234567890123456', maskApiKey);
  assert.equal(got, 'sk-…****6789', `key 形态首句未被掩码：${got}`);
});

// ④ 空白句：null 不写库（hb10-SMG-07 语义保持）。
check('④ 全空白首句返回 null 不写库', () => {
  const got = run('   \n\t  ', maskApiKey);
  assert.equal(got, null, `空白句未返回 null：${String(got)}`);
});

// ⑤ 结构补钉：源码无字母 s 版空白压缩正则残留。
check('⑤ 结构：无 /s+/g 转义丢失形态残留', () => {
  assert.ok(!/replace\(\/s\+\/g/.test(analyzer), "replace(/s+/g) 转义丢失形态残留");
  assert.match(analyzer, /replace\(\/\\s\+\/g/, '缺 /\\s+/g 空白压缩');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
