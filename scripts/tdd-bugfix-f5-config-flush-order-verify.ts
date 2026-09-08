// tdd-bugfix-f5-config-flush-order-verify.ts
// F5（P3，横切复查 2026-09-08）契约钉：ConfigPage 卸载自动保存 flush 顺序缺陷——
// onBeforeUnmount 里 lastSavedSnapshot = configSnapshot() 在 void store.saveConfig()
// 之前执行且不 await：保存失败（磁盘/IPC 异常）→ 基线已前移 → 「无变化」短路吞掉重试，
// 用户已导航离开、store.error 无展示位——纯静默丢失。对照同页手动保存（handleSave）
// 是 await+catch+toast 的正确形态。
//
// 修复语义：卸载 flush 改为 saveConfig() 完成后再前移基线（.then），失败进 .catch
// 置 error 态且不前移基线。
//
// 记账更正（B2 契约普查 2026-09-08）：本脚本原注释宣称「失败可重试/若组件仍存活 watch
// 可重试」——该语义已被 adversarial 复查否定（卸载后 watcher 随 setup 停止、saveStatus
// 卸载后无渲染），为无效修复发过绿灯。失败路径的跨卸载可感知与可重试现由 h1 承载
// （lastSaveFailed 模块级标志 + performInit 重存）；本脚本仅钉 flush 的**顺序形态**
// （.then 前移基线/.catch 置 error，结构契约），不再背书失效语义。
//
// 运行：npx tsx scripts/tdd-bugfix-f5-config-flush-order-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(repoRoot, 'src/renderer/pages/ConfigPage.vue'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: (() => void) | boolean): void {
  try {
    if (typeof cond === 'function') cond();
    else if (!cond) throw new Error('断言为假');
    pass += 1; console.log(`  ✅ ${name}`);
  }
  catch (e) { fail += 1; console.log(`  ✗ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

console.log('=== F5 设置页卸载 flush 顺序 ===');
{
  const at = page.indexOf('onBeforeUnmount(() => {');
  check('onBeforeUnmount flush 块存在', at !== -1);
  if (at !== -1) {
    const block = page.slice(at, page.indexOf('});', at) + 3);

    check('flush 块不再「基线先行」', !/lastSavedSnapshot = configSnapshot\(\);[\s\S]*store\.saveConfig\(\)/.test(block));
    check('flush 块不再裸 fire-and-forget（void store.saveConfig();）', !block.includes('void store.saveConfig();'));
    check('保存成功（.then）后才前移基线', /\.saveConfig\(\)\s*\.then\(\(\) => \{\s*lastSavedSnapshot = configSnapshot\(\);\s*\}\)/.test(block));
    check('失败路径（.catch）不前移基线且置 error 态', /\.catch\(\(\) => \{(?![\s\S]*lastSavedSnapshot = configSnapshot\(\);[\s\S]*\}\))[\s\S]*saveStatus\.value = 'error';/.test(block));
    check('仍在防抖定时器存在时才 flush', block.includes('if (saveTimer)'));
  }

  // 回归：手动保存（handleSave）await+catch+toast 正确形态不受影响
  const handleSaveAt = page.indexOf('async function handleSave()');
  const handleSave = page.slice(handleSaveAt, page.indexOf('function handleThemeSelect', handleSaveAt));
  check('handleSave 维持 try/await/catch 形态（既有契约窗口）', /try \{\s*await store\.saveConfig\(\);\s*lastSavedSnapshot = configSnapshot\(\);/.test(handleSave));
  check('handleSave 失败 toast 保留', handleSave.includes("showToast(store.error ?? '保存失败', 'error')"));
}

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
