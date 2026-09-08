// tdd-bugfix-p2-03-model-id-injection-verify.ts
// P2-3 契约钉：连接测试 spawn `shell:true` + 模型 ID 未转义 → cmd 元字符注入面。
//
// 修复语义（双保险）：① sanitizeProviderModels 增加模型 ID 格式校验（/^[\w.\-:\/]+$/，
// 拒绝空格与 & | ^ % " < > ( ) 等元字符），不合法条目丢弃；② connection-tester spawn 改
// shell:false——复用 resolveExecutable 解析出的真实 exe（Windows .cmd shim 已被解析为真实
// claude.exe，无需 shell），--setting-sources 恢复传真正的空参数。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-03-model-id-injection-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';
import { sanitizeProviderModels } from '../src/shared/provider-library';

const repoRoot = path.resolve(__dirname, '..');
const tester = fs.readFileSync(path.join(repoRoot, 'src/main/modules/connection-tester.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 160)}`); }
}

check('① 含空格的模型 ID 被丢弃', () => {
  const out = sanitizeProviderModels([{ id: 'glm 4.6 & calc' }, { id: 'glm-4.6' }]);
  assert.deepEqual(out.map((m) => m.id), ['glm-4.6']);
});
check('② cmd 元字符（& | ^ % " < > ( )）条目被丢弃', () => {
  const out = sanitizeProviderModels([
    { id: 'a&whoami' }, { id: 'b|del' }, { id: 'c^x' }, { id: 'd%PATH%' },
    { id: 'e"f' }, { id: 'g<h' }, { id: 'i>j' }, { id: '(k)' }, { id: 'ok-model' },
  ]);
  assert.deepEqual(out.map((m) => m.id), ['ok-model']);
});
check('③ 合法形态保留（字母数字._-:/），含端口的 URL 形模型 ID 不误伤', () => {
  const out = sanitizeProviderModels([
    { id: 'glm-4.6' }, { id: 'deepseek:v4' }, { id: 'openai/gpt-4.1' }, { id: '模型中文' },
  ]);
  assert.deepEqual(out.map((m) => m.id).sort(), ['deepseek:v4', 'glm-4.6', 'openai/gpt-4.1']);
});
check('④ 结构：connection-tester spawn 改 shell:false', () => {
  assert.match(tester, /shell:\s*false/);
  assert.doesNotMatch(tester, /shell:\s*process\.platform/);
});
check('⑤ 结构：exe 经 resolveExecutable 解析（不再把裸 cliPath 交给 spawn）', () => {
  assert.ok(tester.includes('resolveExecutable('), '须调用 resolveExecutable');
  assert.match(tester, /import\s*\{[^}]*resolveExecutable[^}]*}\s*from\s*'\.\/(chat-backend|sdk-backend)'/);
});
check('⑥ 结构：--setting-sources 传真正空参数（shell:false 下不再需要字面双引号包裹）', () => {
  const arg = ["'--setting-sources', ''"].join('');
  assert.ok(tester.includes(arg), tester.match(/--setting-sources.{0,20}/)?.[0]);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
