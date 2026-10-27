// tdd-session-pin-verify.ts
// P2 会话置顶（方案 A：hover pin 图标钮 + 置顶分组，计划 2026-10-22 six-issues §3.1/§3.4 点 S4）
// 源码契约脚本。全部为纯 node 读文件 + 字面/正则断言，不 import Electron、不跑 DB。
//
// 覆盖：
//   ① migrations.ts：自愈块含 pinned_at 加列（hasCol 守卫 + ALTER ... INTEGER），免升版（CURRENT_SCHEMA_VERSION 仍 14）；
//   ② session-repo.ts：SessionRow/toSession 映射 pinned_at；setSessionPinned 专用函数存在且函数体
//      不含 updated_at（不 bump，对齐 updateTurnMeta 先例）；listSessions ORDER BY 置顶前缀；
//   ③ shared/types/session.ts：Session 接口含 pinnedAt: number | null；
//   ④ SESSION_SET_PINNED 通道五处落点一致（ipc.ts 常量 / preload 接口签名 / preload 实现 /
//      ipc-handlers handler（存在校验 + Date.now()/null + SESSIONS_CHANGED 广播）/ web-bridge 通道表）；
//   ⑤ AppSidebar.vue 两处会话行模板（全部/项目）各含置顶钮（!batchMode && !session.transient 守卫、
//      togglePin 调用、:focus-visible 焦点环）与置顶行 pin 标识；SessionsPage.vue 卡片置顶文本钮 + 名称旁 pin 标识；
//   ⑥ session-store.ts：暂态对象 pinnedAt: null；togglePin action（乐观 patch → IPC → loadSessions
//      权威重拉 → 失败回滚）；
//   ⑦ 两个分组纯函数：日期分组置顶组（key 'pinned'，不进日期桶）+ 项目组内置顶优先排序。
//
// 运行：npx tsx scripts/tdd-session-pin-verify.ts（已登记 scripts/selftest-static-list.txt 尾部）

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i > -1) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

const migrations = read('src/main/database/migrations.ts');
const sessionRepoSrc = read('src/main/database/repositories/session-repo.ts');
const sessionTypes = read('src/shared/types/session.ts');
const ipcTypes = read('src/shared/types/ipc.ts');
const preloadApi = read('src/preload/api.ts');
const ipcHandlers = read('src/main/ipc-handlers.ts');
const webBridge = read('src/renderer/web/web-bridge.ts');
const storeSrc = read('src/renderer/stores/session-store.ts');
const sidebar = read('src/renderer/components/layout/AppSidebar.vue');
const sessionsPage = read('src/renderer/pages/SessionsPage.vue');
const groupByDate = read('src/renderer/utils/group-sessions-by-date.ts');
const groupByProject = read('src/renderer/utils/group-sessions.ts');

// ── ① migrations.ts：pinned_at 自愈加列（免升版） ──
console.log('=== 1) migrations.ts：pinned_at 自愈加列 ===');
check('自愈块含 hasCol(\'pinned_at\') 守卫 + ALTER TABLE sessions ADD COLUMN pinned_at INTEGER',
  /if \(!hasCol\('pinned_at'\)\) \{\s*db\.exec\('ALTER TABLE sessions ADD COLUMN pinned_at INTEGER'\);\s*\}/.test(migrations));
check('守卫先于 ALTER（同一块内，防重复加列抛错）',
  migrations.indexOf("hasCol('pinned_at')") > -1 &&
  migrations.indexOf("hasCol('pinned_at')") < migrations.indexOf('ALTER TABLE sessions ADD COLUMN pinned_at INTEGER'));
check('免升版：CURRENT_SCHEMA_VERSION 仍为 15（skill_overrides 免升版先例；14→15 为 V15 落地同步，pin 本身仍免升版）',
  /CURRENT_SCHEMA_VERSION = 15;/.test(migrations),
  `实际 ${migrations.match(/CURRENT_SCHEMA_VERSION = \d+;/)?.[0] ?? '未找到'}`);

// ── ② session-repo.ts：映射 + setSessionPinned（不 bump updated_at）+ ORDER BY ──
console.log('=== 2) session-repo.ts：pinned_at 映射 + setSessionPinned + ORDER BY ===');
check('SessionRow 含 pinned_at: number | null', /pinned_at: number \| null;/.test(sessionRepoSrc));
check('toSession 映射 pinnedAt: row.pinned_at ?? null', sessionRepoSrc.includes('pinnedAt: row.pinned_at ?? null'));
check('setSessionPinned 专用导出（签名 (id: string, pinnedAt: number | null): Session | null）',
  /export function setSessionPinned\(id: string, pinnedAt: number \| null\): Session \| null \{/.test(sessionRepoSrc));
{
  // D-A（2026-10-24 six-issues 跟进）：切片边界改确定锚点——括号配对计数切函数体，替代
  // 「下一个 export 」字面锚点（末函数时 -1 切到文件尾、断言精度靠巧合）。openIdx 双守同 ⑥ 块。
  const fnIdx = sessionRepoSrc.indexOf('export function setSessionPinned');
  const openIdx = fnIdx > -1 ? sessionRepoSrc.indexOf('{', fnIdx) : -1;
  let depth = 0;
  let end = -1;
  for (let i = openIdx; i > -1 && i < sessionRepoSrc.length; i += 1) {
    const ch = sessionRepoSrc[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const body = sessionRepoSrc.slice(fnIdx, end > -1 ? end : undefined);
  check('setSessionPinned 切片取得完整函数体（括号配对计数找到闭合，D-A 确定锚点）', end > -1);
  check('setSessionPinned 函数体含 UPDATE sessions SET pinned_at = ? WHERE id = ?',
    /UPDATE sessions SET pinned_at = \? WHERE id = \?/.test(body));
  check('setSessionPinned 函数体不含 updated_at（不 bump，对齐 updateTurnMeta 先例）',
    !/updated_at/.test(body));
  check('setSessionPinned 返回 getSession(id)', body.includes('return getSession(id);'));
}
check('listSessions ORDER BY：(pinned_at IS NOT NULL) DESC, pinned_at DESC, updated_at DESC, rowid DESC',
  sessionRepoSrc.includes('ORDER BY (pinned_at IS NOT NULL) DESC, pinned_at DESC, updated_at DESC, rowid DESC'));

// ── ③ shared/types/session.ts：Session 接口 ──
console.log('=== 3) Session 接口：pinnedAt ===');
check('Session 接口含 pinnedAt: number | null', /pinnedAt: number \| null;/.test(sessionTypes));

// ── ④ SESSION_SET_PINNED 五处落点一致 ──
console.log('=== 4) SESSION_SET_PINNED 通道五处落点 ===');
check("IPC_CHANNELS 含 SESSION_SET_PINNED: 'session:setPinned'",
  ipcTypes.includes("SESSION_SET_PINNED: 'session:setPinned'"));
check('ClaudeLinkAPI 接口含 setSessionPinned(sessionId: string, pinned: boolean): Promise<Session | null> 签名',
  /setSessionPinned:\s*\(sessionId: string,\s*pinned: boolean\)\s*=>\s*Promise<Session \| null>;/.test(preloadApi));
check('preload createApi 实现 setSessionPinned（invoke SESSION_SET_PINNED 两参透传）',
  /setSessionPinned:\s*\(sessionId, pinned\)\s*=>\s*ipcRenderer\.invoke\(IPC_CHANNELS\.SESSION_SET_PINNED, sessionId, pinned\)/.test(preloadApi));
check('ipc-handlers 注册 SESSION_SET_PINNED handler（regInvokeHandler 形态）',
  ipcHandlers.includes('regInvokeHandler(IPC_CHANNELS.SESSION_SET_PINNED'));
{
  // D-A（2026-10-24 six-issues 跟进）：同 ② 块，handler 切片改括号配对计数（原为「下一个
  // regInvokeHandler( 」字面锚点），openIdx 双守同 ⑥ 块。
  const hIdx = ipcHandlers.indexOf('regInvokeHandler(IPC_CHANNELS.SESSION_SET_PINNED');
  const openIdx = hIdx > -1 ? ipcHandlers.indexOf('{', hIdx) : -1;
  let depth = 0;
  let end = -1;
  for (let i = openIdx; i > -1 && i < ipcHandlers.length; i += 1) {
    const ch = ipcHandlers[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const seg = ipcHandlers.slice(hIdx, end > -1 ? end : undefined);
  check('SESSION_SET_PINNED handler 切片取得完整函数体（括号配对计数找到闭合，D-A 确定锚点）', end > -1);
  check('handler 校验会话存在（sessionRepo.getSession，不存在返回 null）',
    seg.includes('sessionRepo.getSession(id)') && seg.includes('return null'));
  check('handler 写入 sessionRepo.setSessionPinned(id, pinned ? Date.now() : null)',
    seg.includes('sessionRepo.setSessionPinned(id, pinned ? Date.now() : null)'));
  check('handler 成功后广播 SESSIONS_CHANGED(upsert)（:849-853 同款）',
    seg.includes("pushToMainWindow(IPC_CHANNELS.SESSIONS_CHANGED, { kind: 'upsert', sessionId: id })"));
  check('handler 出口经 withBridgePlatform 装饰（单行出口附带 bridgePlatform）',
    seg.includes('withBridgePlatform(updated)'));
}
check('web-bridge WEB_CHANNEL_TABLE 含 setSessionPinned: IPC_CHANNELS.SESSION_SET_PINNED（键集契约由 tdd-web-access-wiring-verify §11.2 双向对等钉死）',
  webBridge.includes('setSessionPinned: IPC_CHANNELS.SESSION_SET_PINNED'));

// ── ⑤ AppSidebar.vue 两处模板 + SessionsPage.vue ──
console.log('=== 5) 侧栏两处模板 + 会话管理页 ===');
check('AppSidebar 置顶钮（session-link__pinbtn）两处模板各一个（恰 2 处 class 使用）',
  countOccurrences(sidebar, 'class="session-link__pinbtn"') === 2,
  `实际 ${countOccurrences(sidebar, 'class="session-link__pinbtn"')}`);
check('两处置顶钮均带 !batchMode && !session.transient 守卫（暂态/批量模式隐藏，恰 2 处）',
  countOccurrences(sidebar, 'v-if="!batchMode && !session.transient"') === 2,
  `实际 ${countOccurrences(sidebar, 'v-if="!batchMode && !session.transient"')}`);
check('两处置顶钮均调 store.togglePin(session.id) 且 @click.stop',
  countOccurrences(sidebar, '@click.stop="store.togglePin(session.id)"') === 2,
  `实际 ${countOccurrences(sidebar, '@click.stop="store.togglePin(session.id)"')}`);
check('置顶钮 title 随态切换（取消置顶/置顶会话）',
  countOccurrences(sidebar, "session.pinnedAt != null ? '取消置顶' : '置顶会话'") === 2);
check('置顶行 pin 标识（session-link__pinned，v-if pinnedAt != null）两处模板各一个',
  countOccurrences(sidebar, 'class="session-link__pinned"') === 2 &&
  countOccurrences(sidebar, 'session-link__pinned" v-if="session.pinnedAt != null"') === 2,
  `class=${countOccurrences(sidebar, 'class="session-link__pinned"')} v-if=${countOccurrences(sidebar, 'session-link__pinned" v-if="session.pinnedAt != null"')}`);
check('pinbtn :focus-visible 焦点环（icon-only 钮可键盘触达）',
  /\.session-link__pinbtn:focus-visible \{/.test(sidebar));
check('hover 互斥扩展：时间列隐藏 + 两钮显示（hover 规则同时覆盖 pinbtn 与 delete）',
  /\.session-link:hover \.session-link__pinbtn[\s\S]{0,120}\.session-link:hover \.session-link__delete|\.session-link:hover \.session-link__delete,[\s\S]{0,40}\.session-link__pinbtn/.test(sidebar));
check('置顶组头渲染无需改动（复用 sidebar__group v-for dateGroups），全部/项目两视图 v-for 保留',
  sidebar.includes('v-for="group in dateGroups"') && sidebar.includes('v-for="group in viewGroups"'));
check('SessionsPage 卡片置顶文本钮（store.togglePin + 取消置顶/置顶 随态文案）',
  sessionsPage.includes('store.togglePin(session.id)') &&
  sessionsPage.includes("session.pinnedAt != null ? '取消置顶' : '置顶'"));
check('SessionsPage 卡片名旁 pin 小标识（pinnedAt != null 守卫）',
  /v-if="session\.pinnedAt != null"[\s\S]{0,200}session-card__pinicon|session-card__pinicon[\s\S]{0,200}v-if="session\.pinnedAt != null"/.test(sessionsPage));

// ── ⑥ session-store.ts：暂态对象 + togglePin ──
console.log('=== 6) session-store.ts：暂态 pinnedAt + togglePin action ===');
check('暂态会话对象补 pinnedAt: null', storeSrc.includes('pinnedAt: null,'));
check('togglePin action 存在（async togglePin(sessionId: string)）',
  /async togglePin\(sessionId: string\) \{/.test(storeSrc));
{
  const fnIdx = storeSrc.indexOf('async togglePin(sessionId: string)');
  // F3（2026-10-24 review）：切片边界改确定锚点——括号配对计数切函数体。旧实现取「下一个
  // \n    async 」作边界，togglePin 为 store 最后一个 async action 时返回 -1、body 实际切到
  // 文件尾，断言精度靠巧合（未来 store 尾部新增代码会误过）。
  // P3-1（2026-10-24 review round-001）：fnIdx=-1（签名消失）时 indexOf 的 fromIndex 负值钳 0
  // 会落到文件首个 { 且循环仍全文件扫描——openIdx 与循环条件双守，保证守卫红灯。
  const openIdx = fnIdx > -1 ? storeSrc.indexOf('{', fnIdx) : -1;
  let depth = 0;
  let end = -1;
  for (let i = openIdx; i > -1 && i < storeSrc.length; i += 1) {
    const ch = storeSrc[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const body = storeSrc.slice(fnIdx, end > -1 ? end : undefined);
  check('togglePin 切片取得完整函数体（括号配对计数找到闭合，F3 确定锚点）', end > -1);
  check('togglePin 经 patchSessionInLists 乐观 patch（临时 pinnedAt）', body.includes('patchSessionInLists('));
  check('togglePin 调 window.claudeLink.setSessionPinned(sessionId, !wasPinned)',
    body.includes('window.claudeLink.setSessionPinned(sessionId, !wasPinned)'));
  check('togglePin 成功后 await this.loadSessions()（排序权威交给 SQL）',
    body.includes('await this.loadSessions()'));
  check('togglePin 失败回滚 patch 并 console.error',
    body.includes('patchSessionInLists(sessionId, { pinnedAt: prevPinnedAt })') && body.includes('console.error'));
  check('togglePin 暂态守卫（transient 早退，入口双保险）',
    /transient/.test(body));
}

// ── ⑦ 两个分组纯函数 ──
console.log('=== 7) 分组纯函数：置顶组 / 组内置顶优先 ===');
check('group-sessions-by-date：置顶组 key \'pinned\' + label 置顶 + pinnedAt 过滤（!= null）',
  groupByDate.includes("key: 'pinned'") && groupByDate.includes("pinned: '置顶'") &&
  /pinnedAt != null/.test(groupByDate));
check('group-sessions-by-date：置顶组内按 pinnedAt DESC 排序',
  /pinnedAt DESC|sort\(\(a, b\) => \(b\.pinnedAt [\s\S]{0,40}- \(a\.pinnedAt/.test(groupByDate));
check('group-sessions：项目组内不做跨组提取，组内置顶优先（pinned 前置 + pinnedAt DESC + 其余保持传入序）',
  groupByProject.includes('pinnedAt != null') &&
  /sort\(\(a, b\) => \(b\.pinnedAt [\s\S]{0,40}- \(a\.pinnedAt/.test(groupByProject) &&
  groupByProject.includes('[...pinned, ...rest]'));

console.log(`\n[P2 会话置顶契约] 通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
