// tdd-search-clear-guard-verify.ts
// A2（D01-F1，P2）契约钉：搜索框 Enter 不再误清空（AppSidebar.vue + SessionsPage.vue 两处同款）。
//
// 根因：type=search 输入框的 @search 事件在按 Enter 时同样触发（Chromium 行为，MDN
// HTMLElement: search event），而 handleSearchClear 无条件清空本地输入与 store 搜索态——
// 输入关键词按 Enter（「确认搜索」的本能操作）反而清空搜索词并把列表重置为全量。
//
// 修复语义：handleSearchClear(evt) 入口加守卫——evt.target.value 非空（= Enter 到达）直接
// return 保持过滤；点原生 X / 按 Esc 清除时浏览器已把 value 置空，守卫放行，走清空逻辑恢复
// 全量列表。中文输入法组合态 Enter 不触发 search 事件（Chromium 行为），无需额外处理。
//
// 运行：npx tsx scripts/tdd-search-clear-guard-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

const sidebar = readFileSync(new URL('../src/renderer/components/layout/AppSidebar.vue', import.meta.url), 'utf8');
const sessionsPage = readFileSync(new URL('../src/renderer/pages/SessionsPage.vue', import.meta.url), 'utf8');

function assertGuardedHandler(src: string, label: string): void {
  const idx = src.indexOf('function handleSearchClear(evt: Event)');
  assert.ok(idx > -1, `${label} 缺 handleSearchClear(evt: Event) 入口`);
  const body = src.slice(idx, src.indexOf('}', idx));
  // 守卫：值非空（Enter 到达）直接 return，且必须先于清空逻辑。
  const guardIdx = body.indexOf("(evt.target as HTMLInputElement).value !== ''");
  assert.ok(guardIdx > -1, `${label} 缺 value 非空守卫`);
  assert.match(body, /if \(\(evt\.target as HTMLInputElement\)\.value !== ''\) return;/, `${label} 守卫形态不符（应非空即 return）`);
  const clearIdx = body.indexOf("searchQuery.value = '';");
  assert.ok(clearIdx > -1 && clearIdx > guardIdx, `${label} 清空逻辑缺失或被提到守卫之前`);
  assert.match(body, /store\.searchSessions\(''\);/, `${label} 缺 store 搜索态重置`);
}

console.log('\n=== A2（D01-F1）：搜索框 @search 守卫（Enter 不再清空） ===');
check('AppSidebar.handleSearchClear 含 value 非空守卫（先守卫后清空）', () => {
  assertGuardedHandler(sidebar, 'AppSidebar');
});
check('SessionsPage.handleSearchClear 含 value 非空守卫（先守卫后清空）', () => {
  assertGuardedHandler(sessionsPage, 'SessionsPage');
});
check('两处 @search 绑定保留（Esc/X 清除路径不被断开）', () => {
  assert.match(sidebar, /@search="handleSearchClear"/, 'AppSidebar 缺 @search 绑定');
  assert.match(sessionsPage, /@search="handleSearchClear"/, 'SessionsPage 缺 @search 绑定');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
