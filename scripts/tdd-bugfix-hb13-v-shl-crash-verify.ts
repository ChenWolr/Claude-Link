// scripts/tdd-bugfix-hb13-v-shl-crash-verify.ts
// hb13-v A9【壳层】契约：渲染崩溃恢复「reload 重拉弹窗」防线生效验证（结构钉）。
//
// 病根（docs/audit/2026-09-13-uncommitted-verify-shell-system.md F1 = perm-interact F5）：
//   render-process-gone handler 在 reload 决策前无条件 cancelAllPendingInteractions() →
//   reload 成功后新渲染层 GET_PENDING 恒空，「重拉弹窗」双防线名存实亡；任意渲染崩溃
//   静默取消全部存量权限弹窗（cancel 兜底有界，但 reload 承诺失实）。
// 修法：先判 reload 资格——clean-exit / 超限两条「不 reload」分支走 cancel 兜底；reload
// 路径不 cancel（pending 弹窗由新渲染层 GET_PENDING 重新拉起）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb13-v-shl-crash-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const mainIndex = fs.readFileSync(path.join(repoRoot, 'src/main/index.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

function handlerBody(): string {
  const hIdx = mainIndex.indexOf("on('render-process-gone'");
  assert.ok(hIdx > -1, '未找到 render-process-gone handler');
  const end = mainIndex.indexOf('\n  });', hIdx);
  assert.ok(end > hIdx, 'handler 闭合未找到');
  return mainIndex.slice(hIdx, end);
}

// ① 首个 cancel 必须位于 clean-exit 判定之后（不得在 reload 决策前无条件执行）。
check('① 无条件 cancel 移除：首个 cancelAllPendingInteractions 在 clean-exit 判定之后', () => {
  const body = handlerBody();
  const cleanExitIdx = body.indexOf("details.reason === 'clean-exit'");
  assert.ok(cleanExitIdx > -1, '缺 clean-exit 判定');
  const firstCancel = body.indexOf('cancelAllPendingInteractions()');
  assert.ok(firstCancel > -1, 'handler 完全无 cancel（兜底缺失）');
  assert.ok(firstCancel > cleanExitIdx, 'cancel 在 reload 决策前无条件执行（hb13-v A9 缺陷形态：重拉防线永不生效）');
});

// ② 两条「不 reload」分支各含 cancel 兜底，且全 handler 恰两处（reload 路径零 cancel）。
check('② clean-exit/超限分支各含 cancel 兜底；reload 路径不含（恰 2 处）', () => {
  const body = handlerBody();
  const overLimitIdx = body.indexOf('reloadCount >= 2');
  assert.ok(overLimitIdx > -1, '缺超限判定');
  const overCancel = body.indexOf('cancelAllPendingInteractions()', overLimitIdx);
  assert.ok(overCancel > -1, '超限分支缺 cancel 兜底');
  const cleanCancel = body.indexOf('cancelAllPendingInteractions()');
  assert.ok(cleanCancel > -1 && cleanCancel < overLimitIdx, 'clean-exit 分支缺 cancel 兜底');
  const hits = (body.match(/cancelAllPendingInteractions\(\)/g) ?? []).length;
  assert.equal(hits, 2, `cancel 调用应恰 2 处（实际 ${hits}，reload 路径不得 cancel）`);
  assert.match(body, /webContents\.reload\(\)/, '缺 reload 恢复链');
});

// ③ 注释与实现一致：不再宣称「先 cancel 再 reload 仍重拉」。
check('③ handler 注释如实：声明 reload 路径不 cancel、由 GET_PENDING 重拉', () => {
  const cIdx = mainIndex.indexOf('// hb12-SHL-01：渲染崩溃自动恢复');
  assert.ok(cIdx > -1, '缺 SHL-01 注释锚');
  const seg = mainIndex.slice(cIdx, mainIndex.indexOf('let reloadCount'));
  assert.match(seg, /reload 路径不 cancel/, '缺「reload 路径不 cancel」声明');
  assert.match(seg, /GET_PENDING/, '缺重拉声明');
  assert.ok(!seg.includes('无条件'), '注释仍宣称无条件 cancel');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
