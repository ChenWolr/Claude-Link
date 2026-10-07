// tdd-retry-attachment-notice-verify.ts
// X17（R08-F1，P3）契约钉：retryLastTurn 的附件余量/克隆失败提示走短暂通知，不再被 sendMessage 清空。
//
// 根因（R08-F1）：retryLastTurn 三处置 error.value 提示（use-chat.ts 1186/1189/1192），而同一闭包的
// sendMessage 入口无条件 error.value = null（1034）——持久会话路径从置值到清空全同步（无 await），
// Vue 渲染前即被覆写，用户永远看不到；附件被静默降级（部分附件/纯文本重发）。
//
// 修复语义（第二轮验收收窄后口径）：三处提示改走 sessionStore.fail()——App.vue 既有
// watch([sessionStore.error, sessionStore.errorSeq]) 全局 toast（A4/X16 通道，3.5s 自动消失 ≥3s，
// 同文案连发经 errorSeq 再次触发），不写 useChat 闭包的 error（该横幅语义属「回合错误」，且会被
// sendMessage 入口清空）；sendMessage 入口 error.value = null 原样保留（正常发送的 error 生命周期
// 不变）。注：计划原修法为「经回调让 ChatPage 弹 showNotice」，因验收硬边界不允许改
// src/renderer/pages/ChatPage.vue（允许清单中的 components/chat/ChatPage.vue 路径在仓库中不存在），
// 改用从 use-chat.ts 单文件即可触达的既有全局 toast 通道，实现标准（通知可见 ≥3s）不变。
//
// 运行：npx tsx scripts/tdd-retry-attachment-notice-verify.ts

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

const useChatSrc = readFileSync(new URL('../src/renderer/composables/use-chat.ts', import.meta.url), 'utf8');
const appSrc = readFileSync(new URL('../src/renderer/App.vue', import.meta.url), 'utf8');

// 提取 retryLastTurn 函数体（自函数声明起，至 createChat 尾部 return 语句止）。
const retryIdx = useChatSrc.indexOf('async function retryLastTurn');
assert.ok(retryIdx > -1, 'use-chat.ts 缺 retryLastTurn（源码结构变化，契约需复核）');
const returnIdx = useChatSrc.indexOf('return { sending', retryIdx);
assert.ok(returnIdx > -1, 'use-chat.ts 缺 createChat 尾部 return（源码结构变化，契约需复核）');
const retryBody = useChatSrc.slice(retryIdx, returnIdx);
// 整行注释剥离后再断言「不再写 error.value / store.fail 计数」——注释里提及 error.value = null
// 或 store.fail（说明性文字）不是代码，不应误伤契约。
const retryCode = retryBody.replace(/^[ \t]*\/\/[^\n]*$/gm, '');

console.log('\n=== X17（R08-F1）：retryLastTurn 附件提示改短暂通知（sessionStore.fail → App.vue 全局 toast） ===');
check('retryLastTurn 函数体内不再写 error.value（三处旧提示全部摘除）', () => {
  assert.ok(!/error\.value\s*=/.test(retryCode), `retryLastTurn 仍存在 error.value 赋值（共 ${(retryCode.match(/error\.value\s*=/g) ?? []).length} 处）`);
});
check('三处提示改写 sessionStore.fail（余量不足 + 纯文本重发 ×2，文案逐字保留）', () => {
  assert.equal((retryCode.match(/store\.fail\(/g) ?? []).length, 3, 'store.fail 调用应为 3 处（rejected / created=0 / catch）');
  assert.match(retryCode, /附件余量不足，已恢复 \$\{result\.created\.length\} 个、忽略 \$\{result\.rejected\.length\} 个/, '缺「余量不足」统计文案');
  assert.equal((retryCode.match(/附件恢复失败，已按纯文本重发/g) ?? []).length, 2, '缺「按纯文本重发」文案（created=0 与 catch 各一）');
});
check('旧误导注释（以 error 横幅承载提示）已移除', () => {
  assert.ok(!useChatSrc.includes('以 error 横幅承载提示'), '旧注释仍在：自称发送后清理与实际发送开始时清理相悖');
});
check('通知通道消费端在位：App.vue watch([sessionStore.error, errorSeq]) 弹全局 toast（A4/X16 既有通道）', () => {
  const wIdx = appSrc.indexOf('watch(() => [sessionStore.error, sessionStore.errorSeq] as const, ([err]) => {');
  assert.ok(wIdx > -1, 'App.vue 缺 sessionStore.error toast watch（通道消失则本提示不可见）');
  const wBody = appSrc.slice(wIdx, wIdx + 900);
  assert.match(wBody, /if \(!err\) return;/, 'watch 缺非空守卫');
  assert.match(wBody, /sessionErrorToastVisible\.value = true;/, 'watch 缺 toast 置位');
});
check('toast 自动消失时窗 ≥3s（实现标准），同文案连发可再触发', () => {
  assert.match(appSrc, /const SESSION_ERROR_TOAST_MS = 3500;/, '缺 3.5s 时窗常量');
  assert.match(appSrc, /const SESSION_ERROR_TEXT_MAX = 80;/, '缺文本截断常量（既有通道行为）');
});
check('sendMessage 入口 error.value = null 原样保留（正常发送 error 生命周期不变）', () => {
  const sIdx = useChatSrc.indexOf('async function sendMessage');
  assert.ok(sIdx > -1, '缺 sendMessage');
  const sBody = useChatSrc.slice(sIdx, sIdx + 2500);
  assert.match(sBody, /clearAbortTimer\(sessionId\);\s*\r?\n\s*resetTurnCache\(\);\s*\r?\n\s*error\.value = null;/, 'sendMessage 入口清错链被改动（超出本点影响面）');
});
check('无残留死通道 retryAttachmentNotice（ChatPage 消费端已回退，通道不得遗留在 use-chat）', () => {
  assert.ok(!useChatSrc.includes('retryAttachmentNotice'), 'use-chat.ts 仍含 retryAttachmentNotice（无消费端的死代码）');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
