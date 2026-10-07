// tdd-session-error-toast-seq-verify.ts
// X16（R01-F1）契约钉：sessionStore.error toast 对「同文案连续失败」的可达性。
//
// 根因（R01-F1）：App.vue 的全局错误 toast watch 只以 sessionStore.error（string | null）
// 为源，Vue 对 primitive 只在 Object.is 不等时触发——删除会话失败 → 立即重试 → 再失败写入
// 完全相同的文案 → watch 不触发 → 无任何提示；store 10 处失败写入点也无入口复位 error。
// 「失败后立即重试再失败」恰是最常见路径（比首次失败更需要反馈）。
//
// 修复语义：store 新增 errorSeq 计数 state + 统一 fail(msg) action（this.error = msg;
// this.errorSeq++），10 处失败写入点（loadSessions/materialize/deleteSession/searchSessions/
// setActiveSessionProviderModel/setActiveSessionWorkingDir/setActiveSessionPermissionMode/
// setActiveSessionThinkingLevel/removeRecentWorkspace/renameActiveSession）全部改走 fail()
// ——error 值语义不变，startTransientSession/switchSession 的 error = null 清空路径不动；
// App.vue toast watch 源改为 () => [sessionStore.error, sessionStore.errorSeq]——seq 每次
// 失败自增，同文案连续失败也触发回调、再次弹 toast 并重置 3.5s 计时；error 清空路径
//（成功/切换会话）不弹（!err 守卫保持）。
//
// 运行：npx tsx scripts/tdd-session-error-toast-seq-verify.ts

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

console.log('\n=== X16（R01-F1）：errorSeq 序列触发——同文案连续失败 toast 可达 ===');

check('store 新增 errorSeq 数值计数 state', () => {
  assert.match(store, /errorSeq: 0,/, '缺 errorSeq 计数 state（数值初值 0）');
});

check('store 新增统一 fail(msg) action：写 error 同时自增 errorSeq', () => {
  assert.match(
    store,
    /fail\(msg: string\) \{\s*\r?\n\s*this\.error = msg;\s*\r?\n\s*this\.errorSeq\+\+;/,
    '缺 fail action（形态：fail(msg: string) { this.error = msg; this.errorSeq++; }）',
  );
});

check('10 处失败写入点全部改走 fail()（逐处原始兜底文案不变）', () => {
  const fallbacks = [
    '加载会话失败',
    '创建会话失败',
    '删除会话失败',
    '搜索会话失败',
    '更新会话模型失败',
    '更新工作空间失败',
    '更新权限模式失败',
    '更新思考强度失败',
    '删除目录历史失败',
    '重命名失败',
  ];
  for (const fb of fallbacks) {
    assert.match(
      store,
      new RegExp(`this\\.fail\\(error instanceof Error \\? error\\.message : '${fb}'\\);`),
      `写入点「${fb}」未改走 this.fail(...)`,
    );
  }
});

check('无残留的直接失败写入（this.error = error instanceof Error ...）', () => {
  const direct = store.match(/this\.error = error instanceof Error/g) ?? [];
  assert.equal(direct.length, 0, `残留 ${direct.length} 处直接写入（同文案重试静默根因）`);
});

check('error 直写总数收敛为 3：fail() 内 1 处 + null 清空 2 处（值语义不变）', () => {
  const all = store.match(/this\.error =/g) ?? [];
  assert.equal(all.length, 3, `this.error 直写应为 3 处（fail 1 + null 清空 2），实际 ${all.length}`);
  const nullClears = store.match(/this\.error = null;/g) ?? [];
  assert.equal(nullClears.length, 2, 'startTransientSession/switchSession 的 error = null 清空路径须保留');
});

check('App.vue toast watch 源含 errorSeq（[error, errorSeq] 数组源）', () => {
  const idx = app.search(/watch\(\(\) => \[sessionStore\.error, sessionStore\.errorSeq\]/);
  assert.ok(idx > -1, 'watch 源未含 errorSeq（须为 () => [sessionStore.error, sessionStore.errorSeq]）');
});

check('error 清空路径不弹：!err 守卫保持；再次触发重置 3.5s 计时', () => {
  const idx = app.search(/watch\(\(\) => \[sessionStore\.error, sessionStore\.errorSeq\]/);
  const body = app.slice(idx, idx + 900);
  assert.match(body, /if \(!err\) return;/, '空值守卫缺失（null/空串清空不得弹）');
  assert.match(body, /clearTimeout\(sessionErrorToastTimer\)/, '缺计时重置（同文案再失败须重置计时）');
  assert.match(body, /setTimeout\(\(\) => \{ sessionErrorToastVisible\.value = false; \}, SESSION_ERROR_TOAST_MS\)/, '缺 3.5s 计时重建');
  assert.match(app, /const SESSION_ERROR_TOAST_MS = 3500;/, '缺 3.5s 时窗常量定义');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
