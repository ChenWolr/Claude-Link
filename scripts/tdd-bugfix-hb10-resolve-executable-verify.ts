// scripts/tdd-bugfix-hb10-resolve-executable-verify.ts
// hb10 P2-16（SHL-04）契约：resolveExecutable 按空白切首段，含空格 cliPath 必败。
//
// 病根：resolveExecutable/resolveExecutableUncached 两处 `raw.trim().split(/\s+/)[0]`——
// 含空格 cliPath（C:\Program Files\...）首段被截成 'C:\Program'，解析必败 → CLI 探测/spawn 链全断。
// 修法：两处先取整串 full：绝对路径存在即快路径（win 下 .exe 直接命中；.cmd/.bat shim 经
// resolveFromCmdShim 解出真 exe——SDK 不能直接 spawn shim）；非绝对路径（'npx claude'）走原切分。
// 缓存键不变（按首段 cmd）。复核触发链三处落库点（CONFIG_SAVE/CONFIG_GET_STATUS/detect）不涉及本函数签名。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-resolve-executable-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(repoRoot, 'src/main/modules/sdk-backend.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

check('① resolveExecutable：整串绝对路径快路径优先于按空白切分（缓存键不变）', () => {
  const idx = backend.indexOf('export function resolveExecutable(');
  const body = backend.slice(idx, backend.indexOf('\n}', idx));
  assert.match(body, /const full = raw\.trim\(\);/, '缺整串 full 提取');
  assert.match(body, /resolveAbsolutePathCandidate\(full\)/, '整串绝对路径快路径缺失');
  const fullIdx = body.indexOf('resolveAbsolutePathCandidate(full)');
  const splitIdx = body.indexOf("split(/\\s+/)[0]");
  assert.ok(splitIdx > fullIdx > 0, '快路径必须先于按空白切分');
  assert.match(body, /resolveExecutableCache\.has\(cmd\)/, '缓存键（按首段 cmd）被改');
});

check('② resolveExecutableUncached：同样整串先行，再回退 where/which 切分链', () => {
  const idx = backend.indexOf('function resolveExecutableUncached(');
  const body = backend.slice(idx, backend.indexOf('\n}', idx));
  assert.match(body, /resolveAbsolutePathCandidate\(full\)/, 'uncached 缺整串先行');
  const fullIdx = body.indexOf('resolveAbsolutePathCandidate(full)');
  const splitIdx = body.indexOf("split(/\\s+/)[0]");
  assert.ok(splitIdx > fullIdx, 'uncached 整串先行必须先于切分');
});

check('③ resolveAbsolutePathCandidate：exe 直接命中；win 下 .cmd/.bat shim 解真 exe（不弱化 PE 不变量）', () => {
  const idx = backend.indexOf('function resolveAbsolutePathCandidate(');
  assert.ok(idx > -1, '缺整串解析 helper');
  const body = backend.slice(idx, backend.indexOf('\n}', idx));
  assert.match(body, /isLikelyExecutable\(full\)/, '缺 exe 快路径');
  assert.match(body, /\.endsWith\('\.cmd'\)/, '缺 .cmd shim 分支');
  assert.match(body, /resolveFromCmdShim\(full\)/, '.cmd shim 未解真 exe');
  // PE 不变量不弱化：isLikelyExecutable 的 .exe-only 判定保持。
  const likely = backend.slice(backend.indexOf('function isLikelyExecutable('), backend.indexOf('// 解析 Windows .cmd/.bat shim'));
  assert.match(likely, /endsWith\('\.exe'\)/, 'isLikelyExecutable 的 .exe-only 判定被弱化');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
