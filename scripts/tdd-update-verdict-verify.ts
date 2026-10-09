// tdd-update-verdict-verify.ts
// P1-1「latest.yml 缺失错误分级裁决」TDD 契约脚本。
//   背景：上游发版资产半传（Release 已发布、latest.yml 忘传）时 electron-updater 报 404
//   类错误，现有 app-updater 一律判「无更新」——若远端其实存在更高版本的 Release，发版资产
//   事故被静默吞掉。修法：src/shared/update-verdict.missingMetadataVerdict 从错误消息解析
//   /download/<tag>/latest.yml 的 tag，高于当前版本 → 显式 error 带用户文案；否则（相等 /
//   更低 / 消息无 download 段）维持 latest（覆盖「用户比 stable 还新」等边缘）。
// 分组：
//   V1-V5  missingMetadataVerdict 行为（高版本 → error 文案；tag 等于/低于 current → latest；
//          generic feed 404（无 /download/<tag>/ 段）→ latest；latest-mac.yml 变体）；
//   V6     isNewerVersion 边界（两位数版本号、prerelease 后缀截断按主版本比、无效串不抛错、
//          相等不判新）；
//   W1-W2  结构钉：app-updater 接线（import + ≥2 处消费点）、selftest 清单登记。
// 运行：npx tsx scripts/tdd-update-verdict-verify.ts（已登记 scripts/selftest-static-list.txt）
// RED 约定：V 组经受保护加载——模块不存在/导出缺失时逐项 fail（fail>0）而非顶层 crash。
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
function readRel(p: string): string {
  return readFileSync(resolve(__dirname, '..', p), 'utf8');
}

type VerdictModule = typeof import('../src/shared/update-verdict');
let mod: VerdictModule | null = null;
try {
  // 受保护加载：模块未落地（RED 阶段）时行为断言逐项 fail 而非顶层 crash。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  mod = require('../src/shared/update-verdict') as VerdictModule;
} catch {
  mod = null;
}
function mod_(): VerdictModule {
  assert.ok(mod && typeof mod.missingMetadataVerdict === 'function' && typeof mod.isNewerVersion === 'function',
    'src/shared/update-verdict 未加载（模块缺失或导出不全）');
  return mod;
}
function verdict(message: string, currentVersion: string): { status: string; message?: string } {
  return mod_().missingMetadataVerdict(message, currentVersion) as { status: string; message?: string };
}

console.log('\n=== V1) 远端更高版本 + latest.yml 缺失 → 显式 error 文案 ===');
check('V1 /download/v0.5.0/latest.yml 404、current=0.4.4 → error，文案含 v0.5.0 与「资产不完整」', () => {
  const v = verdict('https://github.com/ChenWolr/Claude-Link/releases/download/v0.5.0/latest.yml 404 not found', '0.4.4');
  assert.equal(v.status, 'error', `status=${v.status}`);
  assert.ok(typeof v.message === 'string' && v.message.includes('v0.5.0'), `文案缺版本号: ${JSON.stringify(v.message)}`);
  assert.ok(typeof v.message === 'string' && v.message.includes('资产不完整'), `文案缺「资产不完整」: ${JSON.stringify(v.message)}`);
});

console.log('\n=== V2) tag 等于 current（用户已是该版）→ latest ===');
check('V2 /download/v0.4.4/latest.yml 404、current=0.4.4 → {status:"latest"}', () => {
  const v = verdict('https://github.com/ChenWolr/Claude-Link/releases/download/v0.4.4/latest.yml 404 (Not Found)', '0.4.4');
  assert.equal(v.status, 'latest', `status=${v.status}（相等不判新，维持原语义）`);
});

console.log('\n=== V3) tag 低于 current（用户比 stable 还新）→ latest ===');
check('V3 /download/v0.4.3/latest.yml 404、current=0.4.4 → {status:"latest"}', () => {
  const v = verdict('https://github.com/ChenWolr/Claude-Link/releases/download/v0.4.3/latest.yml 404 not found', '0.4.4');
  assert.equal(v.status, 'latest', `status=${v.status}（更低不判新）`);
});

console.log('\n=== V4) 消息无 /download/<tag>/ 段（generic feed 404 形态）→ latest ===');
check('V4 ENOENT 本地路径 latest.yml 打开失败（不含 download 段）→ {status:"latest"}', () => {
  const v = verdict("ENOENT: no such file or directory, open 'C:\\Users\\u\\AppData\\Local\\claude-link-updater\\latest.yml'", '0.4.4');
  assert.equal(v.status, 'latest', `status=${v.status}（无从解析 tag，回落旧语义）`);
});

console.log('\n=== V5) latest-mac.yml 变体同样解析 tag ===');
check('V5 /download/v0.5.0/latest-mac.yml 404、current=0.4.4 → error，文案含 v0.5.0', () => {
  const v = verdict('https://github.com/ChenWolr/Claude-Link/releases/download/v0.5.0/latest-mac.yml 404 not found', '0.4.4');
  assert.equal(v.status, 'error', `status=${v.status}`);
  assert.ok(typeof v.message === 'string' && v.message.includes('v0.5.0'), `文案缺版本号: ${JSON.stringify(v.message)}`);
});

console.log('\n=== V6) isNewerVersion 边界 ===');
check('V6 两位数主/次版本 v0.10.0>0.9.9=true；prerelease 后缀截断 0.4.4-beta.1 vs 0.4.4=false；0.5.0>0.4.4-beta.2=true；乱串不抛错=false；相等=false', () => {
  const { isNewerVersion } = mod_();
  assert.equal(isNewerVersion('v0.10.0', '0.9.9'), true, 'v0.10.0 应判新于 0.9.9（数值比，非字典序）');
  assert.equal(isNewerVersion('0.4.4-beta.1', '0.4.4'), false, 'prerelease 后缀按主版本截断比，相等不判新');
  assert.equal(isNewerVersion('0.5.0', '0.4.4-beta.2'), true, '0.5.0 应判新于 0.4.4-beta.2');
  assert.equal(isNewerVersion('乱串!!', '0.4.4'), false, '不可解析串应保守判 false 且不抛错');
  assert.equal(isNewerVersion('0.4.4', '0.4.4'), false, '相等不判新');
});

console.log('\n=== W) 结构钉 ===');
const appUpdater = readRel('src/main/modules/app-updater.ts');
const selftestList = readRel('scripts/selftest-static-list.txt');

check('W1 app-updater 已接线：missingMetadataVerdict import + ≥2 处消费点（error 事件与 checkForAppUpdates catch）', () => {
  assert.ok(
    appUpdater.includes("import { missingMetadataVerdict } from '../../shared/update-verdict'"),
    'missingMetadataVerdict import 缺失',
  );
  const callSites = appUpdater.match(/missingMetadataVerdict\(/g) ?? [];
  assert.ok(callSites.length >= 2, `消费点不足 2 处（实际 ${callSites.length}）`);
});
check('W2 selftest-static-list.txt 已登记本脚本', () => {
  assert.ok(selftestList.includes('scripts/tdd-update-verdict-verify.ts'), '清单未登记');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
