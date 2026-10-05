// tdd-window-state-corruption-verify.ts
// B2（D14-F1，P3）契约钉：window-state.json 损坏时启动链兜底（回落默认尺寸 + 自愈）。
//
// 根因：loadWindowSize() 的 getStore().store 全程无 try/catch——conf 的 get store() 对损坏
// JSON 默认抛 SyntaxError（clearInvalidConfig 未启用）；createWindow() 位于 whenReady 内
// try/catch 之外，抛出即中断其后全部初始化（无窗口/无托盘/无更新检查），进程驻留——应用
// 「点了没反应」，普通用户需手删 %APPDATA% 下的 json 才能自救。
//
// 修复语义：读取包 try/catch——抛错时 logger.warn 留排障线索、删除损坏文件（conf 下次读
// 按不存在处理走 defaults，下次 resize 保存重建文件，自愈闭环）、返回 null；index.ts 的
// `size?.width ?? WINDOW_DEFAULT_WIDTH` 既有回落承担默认 1200×800。保存侧（flush）既有
// try/catch 不变。
//
// 运行：npx tsx scripts/tdd-window-state-corruption-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const mod = readFileSync(new URL('../src/main/modules/window-state.ts', import.meta.url), 'utf8');
const index = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');

console.log('\n=== B2（D14-F1）：window-state 损坏兜底 ===');
check('① loadWindowSize 读取包 try/catch（conf 损坏抛错不再外溢炸启动链）', () => {
  const at = mod.indexOf('export function loadWindowSize');
  const body = mod.slice(at, mod.indexOf('\n}', at));
  const tryIdx = body.indexOf('try {');
  const readIdx = body.indexOf('getStore().store');
  assert.ok(tryIdx > -1 && readIdx > tryIdx, '读取须在 try 内');
});
check('② catch 路径：logger.warn + 删除损坏文件 + 返回 null', () => {
  const at = mod.indexOf('export function loadWindowSize');
  const body = mod.slice(at, mod.indexOf('\n}', at));
  const catchIdx = body.indexOf('} catch');
  assert.ok(catchIdx > -1, '缺 catch');
  const region = body.slice(catchIdx);
  assert.match(region, /logger\.warn/, '缺 warn 留痕');
  assert.match(region, /rm\(corruptPath/, '缺损坏文件删除');
  assert.match(region, /force: true/, '删除须 force（不存在不抛）');
  assert.match(region, /return null;/, '缺 null 返回（默认尺寸回落信号）');
});
check('③ 损坏文件路径与 conf 存储名同源（userData/claude-link-window-state.json）', () => {
  assert.match(mod, /name: 'claude-link-window-state'/, 'conf 存储名锚');
  assert.match(mod, /path\.join\(app\.getPath\('userData'\), 'claude-link-window-state\.json'\)/, '删除路径须与存储文件一致');
});
check('④ 保存侧既有 try/catch 不变（resize/close flush 失败仅 warn）', () => {
  const at = mod.indexOf('const flush = (): void => {');
  const body = mod.slice(at, mod.indexOf('\n  };', at) + 5);
  assert.match(body, /try \{[\s\S]*save\(\);[\s\S]*\} catch/, 'flush 须 try 包裹 save');
});
check('⑤ index.ts 默认回落既有形态在位（null → WINDOW_DEFAULT_*）', () => {
  assert.match(index, /size\?\.width \?\? WINDOW_DEFAULT_WIDTH/, '缺宽回落');
  assert.match(index, /size\?\.height \?\? WINDOW_DEFAULT_HEIGHT/, '缺高回落');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
