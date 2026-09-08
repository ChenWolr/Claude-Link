// tdd-bugfix-h2-sessions-page-debounce-cleanup-verify.ts
// H2（P3，对抗复查 2026-09-08 第二轮新透镜）契约钉：SessionsPage 搜索防抖定时器不随卸载
// 清理——迟到的 searchSessions 给全局侧栏留下「不可见过滤器」。
//
// 修复前：SessionsPage 模块级 debounceTimer（250ms 防抖调 store.searchSessions），全文件
// 无 onUnmounted/onBeforeUnmount。时序：会话管理页输入搜索词 → 250ms 内导航走 → ChatPage
// onMounted 的 loadSessions() 清掉 searchResults → 残留定时器其后触发 searchSessions('旧词')
// 重新置入过滤结果 → 聊天页侧栏被静默过滤（AppSidebar 常驻消费 searchResults，跨路由存活），
// 用户看到「会话消失」，直到下一次 loadSessions 才自愈。
//
// 修复语义：对齐 ChatPage noticeTimer 先例（:92-94），onUnmounted 清理 pending 定时器。
//
// A2 增补（契约普查 2026-09-08）：onUnmounted 只能取消「未触发」的 timer——timer 已 fire、
// searchSessions 的 IPC 在途时导航走，晚完成的旧搜索结果仍会把 searchResults 重新置入
// （不可见过滤器变体）。修复：session-store.searchSessions 加模块级自增 requestId 代际守卫
// （对照 config-store loadNativeSettingsDiagnostic 先例），await 返回时非最新代际即丢弃。
// 行为 seam：stub searchSessions 两次不同延迟——慢的旧结果/旧失败晚到不得覆盖新状态。
//
// 运行：npx tsx scripts/tdd-bugfix-h2-sessions-page-debounce-cleanup-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '../src/renderer/stores/session-store';

const repoRoot = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(repoRoot, 'src/renderer/pages/SessionsPage.vue'), 'utf8');
const chatPage = fs.readFileSync(path.join(repoRoot, 'src/renderer/pages/ChatPage.vue'), 'utf8');

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

console.log('=== H2 SessionsPage 防抖定时器卸载清理 ===');
{
  check('从 vue 引入 onUnmounted', /import\s*\{[^}]*\bonUnmounted\b[^}]*\}\s*from\s*'vue'/.test(page));
  const at = page.indexOf('onUnmounted(() => {');
  check('onUnmounted 清理块存在', at !== -1);
  if (at !== -1) {
    const block = page.slice(at, page.indexOf('});', at) + 3);
    check('清理块 clearTimeout(debounceTimer)', /if \(debounceTimer\) clearTimeout\(debounceTimer\);/.test(block));
  }
  // 回归：防抖本体未被误删（250ms 延迟 + 空查询也走 store 清搜索态）。
  check('防抖搜索本体保留', /debounceTimer = setTimeout\(\(\) => \{\s*store\.searchSessions\(q\);\s*\}, 250\)/.test(page));
}

console.log('=== 回归：ChatPage noticeTimer 先例不受影响 ===');
{
  const at = chatPage.indexOf('onUnmounted(() => {');
  check('ChatPage noticeTimer 卸载清理仍在', at !== -1 && /if \(noticeTimer\) clearTimeout\(noticeTimer\);/.test(chatPage.slice(at, chatPage.indexOf('});', at) + 3)));
}

console.log('=== A2 searchSessions 代际守卫（行为 seam：两次不同延迟，晚到旧结果不覆盖新状态）===');
async function verifySearchSessionsGenerationGuard(): Promise<void> {
  setActivePinia(createPinia());
  const store = useSessionStore();
  const calls: string[] = [];
  const delayOf = new Map<string, number>([['ab', 80], ['abc', 5], ['boom', 80], ['ok', 5]]);
  (globalThis as unknown as { window: unknown }).window = {
    claudeLink: {
      searchSessions: async (q: string) => {
        calls.push(q);
        await new Promise((r) => setTimeout(r, delayOf.get(q) ?? 5));
        if (q === 'boom') throw new Error('ipc down');
        return [{ id: `sid-${q}`, title: `结果-${q}`, transient: false }];
      },
    },
  };

  // 场景①：先发慢查询、后发快查询——慢的旧结果晚完成，不得覆盖快查询已写入的状态
  // （无守卫时 'ab' 的结果最后落袋，AppSidebar 被旧过滤器劫持）。
  const p1 = store.searchSessions('ab');
  const p2 = store.searchSessions('abc');
  await p2;
  await p1;
  check('晚到的旧结果不覆盖新搜索状态（searchResults 仍是最新查询的结果）',
    Array.isArray(store.searchResults) && store.searchResults.length === 1 && store.searchResults[0].id === 'sid-abc');

  // 场景②：先发慢失败、后发快成功——晚到的旧失败不得清掉新结果、不得误报 error。
  const q1 = store.searchSessions('boom');
  const q2 = store.searchSessions('ok');
  await q2;
  await q1;
  check('晚到的旧失败不清新结果、不误报 error',
    Array.isArray(store.searchResults) && store.searchResults.length === 1 && store.searchResults[0].id === 'sid-ok' && store.error === null);

  // 回归：单发正常路径不受守卫影响（结果与 searchQuery 照常写入）。
  await store.searchSessions('ab');
  check('单发搜索仍写入结果与 searchQuery（守卫不误伤正常路径）',
    Array.isArray(store.searchResults) && store.searchResults.length === 1 && store.searchResults[0].id === 'sid-ab' && store.searchQuery === 'ab');
}

// tsx 以 CJS 跑本脚本，顶层 await 不可用（h1 先例）：同步段先行，A2 行为 seam 异步收尾。
void (async () => {
  await verifySearchSessionsGenerationGuard();
  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
