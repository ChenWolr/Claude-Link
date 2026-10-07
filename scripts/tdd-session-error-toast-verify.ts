// tdd-session-error-toast-verify.ts
// A4（D01-F3 + D02-F8，P2）契约钉：sessionStore.error 的全局 UI 出口。
//
// 根因（D01-F3 复核修正后口径）：sessionStore.error 有 10 处写入点，但渲染层消费点实为零
// （ConfigPage/ChangesPanel 消费的是 config/changes store 的 error）——删除/搜索/改名/会话内
// 切模型失败全程静默。D02-F8：会话内切模型失败仅写 store.error，用户以为切换成功。
//
// 修复语义：App.vue watch(sessionStore.error)——非空弹 3.5s 全局错误 toast（复用 H1 的
// .global-toast--error 样式），文案「操作失败：<摘要>」截断至 ~80 字符；连续失败以最新文案
// 重置计时；空串/null 不弹；不动 config/changes 既有出口；toast 不拦截交互（纯展示节点，
// 无 pointer 事件绑定）。X16（R01-F1）起：store 写入点统一走 fail() action（写 error 同时
// 自增 errorSeq），watch 源改为 [error, errorSeq]——同文案连续失败也再次触发（另见
// tdd-session-error-toast-seq-verify.ts）。
//
// 运行：npx tsx scripts/tdd-session-error-toast-verify.ts

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

const app = readFileSync(new URL('../src/renderer/App.vue', import.meta.url), 'utf8');
const store = readFileSync(new URL('../src/renderer/stores/session-store.ts', import.meta.url), 'utf8');

console.log('\n=== A4（D01-F3/D02-F8）：sessionStore.error 全局 toast 出口 ===');
check('App.vue watch(sessionStore.error)：非空弹 toast，空串/null 不弹', () => {
  const idx = app.indexOf('watch(() => [sessionStore.error, sessionStore.errorSeq] as const, ([err]) => {');
  assert.ok(idx > -1, '缺 sessionStore.error watch（X16 起 watch 源为 [error, errorSeq]）');
  const body = app.slice(idx, idx + 800);
  assert.match(body, /if \(!err\) return;/, '空值守卫缺失（空串/null 不得弹）');
  assert.match(body, /sessionErrorToastVisible\.value = true;/, '缺置位显示');
});
check('文案「操作失败：<摘要>」并截断至 ~80 字符', () => {
  const idx = app.indexOf('watch(() => [sessionStore.error, sessionStore.errorSeq] as const, ([err]) => {');
  const body = app.slice(idx, idx + 800);
  assert.match(body, /操作失败：/, '缺文案前缀');
  assert.match(body, /slice\(0, SESSION_ERROR_TEXT_MAX\)/, '缺摘要截断');
  assert.match(app, /const SESSION_ERROR_TEXT_MAX = 80;/, '缺 80 字符上限常量');
});
check('连续失败重置计时（clearTimeout + 3.5s 窗），卸载清理定时器', () => {
  const idx = app.indexOf('watch(() => [sessionStore.error, sessionStore.errorSeq] as const, ([err]) => {');
  const body = app.slice(idx, idx + 800);
  assert.match(body, /clearTimeout\(sessionErrorToastTimer\)/, '缺计时重置');
  assert.match(app, /const SESSION_ERROR_TOAST_MS = 3500;/, '缺 3.5s 时窗常量');
  const unmountIdx = app.indexOf('onBeforeUnmount(');
  assert.ok(unmountIdx > -1 && /if \(sessionErrorToastTimer\) clearTimeout\(sessionErrorToastTimer\);/.test(app.slice(unmountIdx)), '卸载缺定时器清理');
});
check('模板含 sessionErrorToast 节点（复用 global-toast--error 样式，纯展示不拦截交互）', () => {
  assert.match(app, /<div v-if="sessionErrorToastVisible" class="global-toast global-toast--error[^"]*">\{\{ sessionErrorToastText \}\}<\/div>/, '缺 toast 模板节点');
});
check('双 toast 同屏纵向错开（stacked 修饰类）', () => {
  assert.match(app, /global-toast--stacked/, '缺 stacked 修饰类');
});
check('D02-F8 佐证：会话内切模型失败走 fail()（同一通道，无需补写）', () => {
  const idx = store.indexOf('async setActiveSessionProviderModel');
  const body = store.slice(idx, idx + 1600);
  assert.match(body, /this\.fail\(error instanceof Error \? error\.message : '更新会话模型失败'\);/, '切模型失败未写 sessionStore.error 通道');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
