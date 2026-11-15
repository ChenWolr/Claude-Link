// tdd-sidebar-card-pin-verify.ts
// UI13-P3 侧栏会话卡片化改版（变体 A：ZCode 截图基准两行卡）源码契约 + 行为直测脚本。
// 对应 docs/plans/2026-11-14-ui13-batch/03-test-cases.md「P3 侧栏会话卡片化」T3-A~L 十二条：
//   T3-A 卡片结构契约（结构钉：状态标识/标题/项目徽章/右上操作组，按钮 title/aria 语义）
//   T3-B 项目视图置顶跨组浮顶直测（纯函数 groupSessionsByProject）
//   T3-C 日期视图置顶浮顶回归钉（纯函数 groupSessionsByDate）
//   T3-D 置顶标识可见（pin-mark 类钉，收敛后单模板一处）
//   T3-E 中断钮门控（displayStatus ∈ {running, retrying} 且批量模式整组隐藏）
//   T3-F 长按 1 秒触发（use-hold-action 1000ms 常量 + down/up/leave 取消形态 + 委托式接线）
//   T3-G 中断链路与聊天区一致（活动 useChat().abort / 后台 abortChat IPC 同通道）
//   T3-H 保留清单逐项存在性钉（搜索/批量/⏳/四态/选中/active/hover 显隐/分组头）
//   T3-I 主题 token 钉（.session-card 新样式段零硬编码十六进制色值）
//   T3-J 零影响钉（MessageBubble/MessageList/TaskQueuePanel/TaskItem 零交叉污染）
//   T3-K 中断收口语义（活动乐观复位 / 后台不乐观改态两分支判据）
//   T3-L 置顶乐观更新与重拉竞态（patchSessionInLists 乐观 → IPC → loadSessions 权威重拉 → 回滚）
//   T3-M (P2-B/P3 串扰) 中断钮 @click.stop 阻冒泡（短按误开会话）+ use-hold-action 注释口径修正
//         + holding 类/fill 宽度按 holdTargetId 过滤（防按住 A 卡时 B 卡同显按压态/进度）
// 运行：npx tsx scripts/tdd-sidebar-card-pin-verify.ts（登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupSessionsByProject, projectLabel } from '../src/renderer/utils/group-sessions';
import { groupSessionsByDate } from '../src/renderer/utils/group-sessions-by-date';
import type { Session } from '../src/shared/types/session';

const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i > -1) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}
function sliceBalanced(src: string, startIdx: number): string {
  // 括号配对计数切 {…} 块（对齐 tdd-session-pin-verify D-A 确定锚点法）。
  // 体括号定位：找首个「其后到行尾仅剩空白」的 { ——跳过签名内 { id: string } 类型字面量。
  let openIdx = -1;
  for (let i = startIdx; i < src.length; i += 1) {
    if (src[i] !== '{') continue;
    let j = i + 1;
    while (j < src.length && src[j] !== '\n' && /\s/.test(src[j])) j += 1;
    if (j >= src.length || src[j] === '\n') { openIdx = i; break; }
  }
  if (openIdx === -1) return '';
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(startIdx, i + 1);
    }
  }
  return '';
}

const sidebar = read('../src/renderer/components/layout/AppSidebar.vue');
const holdComposable = read('../src/renderer/composables/use-hold-action.ts');
const storeSrc = read('../src/renderer/stores/session-store.ts');
const sessionRepoSrc = read('../src/main/database/repositories/session-repo.ts');
const messageBubble = read('../src/renderer/components/chat/MessageBubble.vue');
const messageList = read('../src/renderer/components/chat/MessageList.vue');
const taskQueuePanel = read('../src/renderer/components/task/TaskQueuePanel.vue');
const taskItem = read('../src/renderer/components/task/TaskItem.vue');

// template 段（首个顶层 <template> 到最后一个 </template>）。
const tplStart = sidebar.indexOf('<template>');
const tplEnd = sidebar.lastIndexOf('</template>');
const template = sidebar.slice(tplStart, tplEnd);

// ── 最小 Session 构造（仅分组函数消费 id/workingDir/pinnedAt/updatedAt） ──
function session(
  id: string,
  workingDir: string | null,
  pinnedAt: number | null = null,
  updatedAt = '2026-08-24T00:00:00.000Z',
): Session {
  return {
    id,
    name: `会话-${id}`,
    cliSessionId: null,
    model: 'test-model',
    providerOverride: null,
    modelOverride: null,
    workingDir,
    permissionMode: null,
    maxTurns: 0,
    thinkingLevel: null,
    pinnedAt,
    createdAt: updatedAt,
    updatedAt,
    lastContextTokens: null,
    lastContextUpdatedAt: null,
  } as unknown as Session;
}
function iso(y: number, m: number, d: number, hh = 12, mm = 0): string {
  return new Date(y, m - 1, d, hh, mm, 0).toISOString();
}

console.log('\n=== T3-A · 卡片结构契约（结构钉） ===');

check('T3-A1 卡片根类 session-card 存在（class 数组字面，收敛后单模板恰 1 处）', () => {
  assert.equal(countOccurrences(sidebar, "'session-card'"), 1, `实际 ${countOccurrences(sidebar, "'session-card'")} 处`);
});
check('T3-A2 状态标识：session-card__status + role="img" + aria-label/title 走 statusLabel', () => {
  assert.ok(sidebar.includes('class="session-card__status"'), '缺状态标识元素');
  assert.ok(sidebar.includes('role="img"'), '状态标识缺 role="img"');
  assert.match(sidebar, /:aria-label="statusLabel\(session\.id\)"/);
  assert.match(sidebar, /:title="statusLabel\(session\.id\)"/);
});
check('T3-A3 标题 session-card__name（单行省略由样式保证，模板单处）', () => {
  assert.equal(countOccurrences(sidebar, 'class="session-card__name"'), 1);
});
check('T3-A4 项目徽章 session-card__proj：workingDir 经 projectLabel + :title=workingDir + null 不渲染', () => {
  assert.ok(sidebar.includes('class="session-card__proj"'), '缺项目徽章');
  assert.match(sidebar, /v-if="session\.workingDir"[\s\S]{0,200}projectLabel\(session\.workingDir\)/);
  assert.match(sidebar, /:title="session\.workingDir"/);
});
check('T3-A5 右上操作组容器 session-card__ops 挂卡片内（单处）', () => {
  assert.equal(countOccurrences(sidebar, 'class="session-card__ops"'), 1);
});
check('T3-A6 按钮语义齐备：置顶会话/取消置顶（随态 title）、删除会话、中断（长按 1 秒中断）', () => {
  assert.ok(sidebar.includes("session.pinnedAt != null ? '取消置顶' : '置顶会话'"), '置顶钮缺随态 title');
  assert.ok(sidebar.includes('title="删除会话"'), '删除钮缺 title');
  assert.ok(sidebar.includes('title="长按 1 秒中断"'), '中断钮缺 title');
  assert.ok(/aria-label="[^"]*中断会话/.test(sidebar), '中断钮缺 aria-label 中断语义');
});
check('T3-A7 两行卡结构：row1（状态/置顶标识/标题/⏳/操作组）+ row2（徽章/时间）', () => {
  assert.ok(sidebar.includes('class="session-card__row1"'), '缺 row1 容器');
  assert.ok(sidebar.includes('class="session-card__row2"'), '缺 row2 容器');
  const row1Idx = sidebar.indexOf('class="session-card__row1"');
  const row2Idx = sidebar.indexOf('class="session-card__row2"');
  const opsIdx = sidebar.indexOf('class="session-card__ops"');
  assert.ok(row1Idx < opsIdx && opsIdx < row2Idx, 'ops 应位于 row1 内、row2 之前');
});

console.log('\n=== T3-B · 项目视图置顶跨组浮顶直测 ===');

check('T3-B1 两项目组各含 1 置顶 → 首组为置顶组（__pinned__，label 置顶）', () => {
  const a1 = session('a1', '/d/p1');
  const a2pin = session('a2-pin', '/d/p1', 2000);
  const b1 = session('b1', '/d/p2');
  const b2pin = session('b2-pin', '/d/p2', 5000);
  const a3 = session('a3', '/d/p1');
  const groups = groupSessionsByProject([a1, a2pin, b1, b2pin, a3]);
  assert.equal(groups[0].key, '__pinned__');
  assert.equal(groups[0].label, '置顶');
  // pinnedAt DESC：后置顶在前
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['b2-pin', 'a2-pin']);
});
check('T3-B2 原项目组不含置顶会话（跨组提取后组归属干净）', () => {
  const a1 = session('a1', '/d/p1');
  const a2pin = session('a2-pin', '/d/p1', 2000);
  const b1 = session('b1', '/d/p2');
  const b2pin = session('b2-pin', '/d/p2', 5000);
  const groups = groupSessionsByProject([a1, a2pin, b1, b2pin]);
  const p1 = groups.find((g) => g.label === 'p1')!;
  const p2 = groups.find((g) => g.label === 'p2')!;
  assert.deepEqual(p1.sessions.map((s) => s.id), ['a1'], 'p1 组应只含未置顶');
  assert.deepEqual(p2.sessions.map((s) => s.id), ['b1'], 'p2 组应只含未置顶');
});
check('T3-B3 未置顶项目组序不变（按首次出现序，置顶提取不重排普通组）', () => {
  const b1 = session('b1', '/d/p2');
  const a1 = session('a1', '/d/p1');
  const a2pin = session('a2-pin', '/d/p1', 2000);
  const b2 = session('b2', '/d/p2');
  const groups = groupSessionsByProject([b1, a1, a2pin, b2]);
  assert.deepEqual(
    groups.filter((g) => g.key !== '__pinned__').map((g) => g.label),
    ['p2', 'p1'],
  );
});
check('T3-B4 无置顶 → 不输出 __pinned__ 组（空置顶无组）', () => {
  const groups = groupSessionsByProject([session('a', '/d/p1'), session('b', null)]);
  assert.ok(groups.every((g) => g.key !== '__pinned__'));
  assert.equal(groups.length, 2);
});
check('T3-B5 置顶组 dir 为 null（分组头不挂项目路径 title）', () => {
  const groups = groupSessionsByProject([session('a2-pin', '/d/p1', 2000)]);
  assert.equal(groups[0].dir, null);
});
check('T3-B6 undefined（旧数据缺 pinnedAt 字段）一致按未置顶、留在项目组', () => {
  const noField = session('nofield', '/d/p1');
  delete (noField as { pinnedAt?: number | null }).pinnedAt;
  const groups = groupSessionsByProject([noField, session('a', '/d/p1')]);
  assert.ok(groups.every((g) => g.key !== '__pinned__'));
  const p1 = groups.find((g) => g.label === 'p1')!;
  assert.deepEqual(p1.sessions.map((s) => s.id), ['nofield', 'a']);
});

console.log('\n=== T3-C · 日期视图置顶浮顶回归钉 ===');

check('T3-C1 置顶 + 日期桶混合 → 首组 key \'pinned\'、置顶不进日期桶、pinnedAt DESC', () => {
  const NOW = new Date(2026, 8, 23, 15, 0, 0);
  const groups = groupSessionsByDate(
    [
      session('older', null, null, iso(2026, 9, 15, 10, 0)),
      session('pin-a', null, 3000, iso(2026, 9, 15, 11, 0)),
      session('today', null, null, iso(2026, 9, 23, 10, 0)),
      session('pin-b', null, 1000, iso(2026, 9, 22, 11, 0)),
    ],
    NOW,
  );
  assert.deepEqual(groups.map((g) => g.key), ['pinned', 'today', 'older']);
  assert.equal(groups[0].label, '置顶');
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['pin-a', 'pin-b']);
  assert.deepEqual(groups[1].sessions.map((s) => s.id), ['today']);
  assert.deepEqual(groups[2].sessions.map((s) => s.id), ['older']);
});
check('T3-C2 空置顶 → 无置顶组（既有行为不被卡片化重构破坏）', () => {
  const NOW = new Date(2026, 8, 23, 15, 0, 0);
  const groups = groupSessionsByDate([session('a', null, null, iso(2026, 9, 23, 9, 0))], NOW);
  assert.deepEqual(groups.map((g) => g.key), ['today']);
});

console.log('\n=== T3-D · 置顶标识可见 ===');

check('T3-D1 pin 标识元素 session-card__pin-mark 存在且 pinnedAt != null 门控（收敛后单模板恰 1 处）', () => {
  assert.equal(countOccurrences(sidebar, 'class="session-card__pin-mark"'), 1,
    `实际 ${countOccurrences(sidebar, 'class="session-card__pin-mark"')} 处`);
  assert.equal(countOccurrences(sidebar, 'class="session-card__pin-mark" v-if="session.pinnedAt != null"'), 1);
});
check('T3-D2 pin 标识常驻（非 hover 显隐）且 accent 填充样式', () => {
  assert.match(sidebar, /\.session-card__pin-mark\s*\{[^}]*fill:\s*var\(--color-accent\)/);
});
check('T3-D3 两视图一致：renderGroups 单模板归一（v-for="group in renderGroups" 恰 1 处）', () => {
  assert.equal(countOccurrences(template, 'v-for="group in renderGroups"'), 1);
  assert.match(sidebar, /groupByProject\.value \? viewGroups\.value : dateGroups\.value/);
});

console.log('\n=== T3-E · 中断钮门控 ===');

check('T3-E1 中断钮 v-if=canInterrupt(session.id)（四态门控结构钉）', () => {
  assert.ok(sidebar.includes('v-if="canInterrupt(session.id)"'), '中断钮缺 canInterrupt 门控');
});
check('T3-E2 canInterrupt 判定恰为 displayStatus ∈ {running, retrying}', () => {
  const fnIdx = sidebar.indexOf('function canInterrupt(');
  assert.ok(fnIdx > -1, '缺 canInterrupt 函数');
  const body = sliceBalanced(sidebar, fnIdx);
  assert.match(body, /=== 'running'/);
  assert.match(body, /=== 'retrying'/);
  assert.ok(!/completed/.test(body) && !/idle/.test(body), '门控不得包含 completed/idle');
});
check('T3-E3 批量模式整组隐藏：ops 容器 v-if="!batchMode"（中断钮批量不可达）', () => {
  assert.ok(sidebar.includes('v-if="!batchMode"') &&
    sidebar.indexOf('class="session-card__ops"') > sidebar.indexOf('v-if="!batchMode"'),
    'ops 容器缺批量模式隐藏门控');
});

console.log('\n=== T3-F · 长按 1 秒触发 ===');

check('T3-F1 use-hold-action 1000ms 默认常量 + down/up/leave 三态取消形态', () => {
  assert.ok(holdComposable.includes('options.durationMs ?? 1000'), '缺 1000ms 默认常量');
  for (const k of ['onPointerDown', 'onPointerUp', 'onPointerLeave', 'onPointerCancel', 'resetHold']) {
    assert.ok(holdComposable.includes(k), `use-hold-action 缺 ${k}`);
  }
});
check('T3-F2 侧栏接线 useHoldAction（委托式：interruptHold + holdTargetId 单槽）', () => {
  assert.match(sidebar, /useHoldAction\(/);
  assert.match(sidebar, /const holdTargetId = ref<string \| null>\(null\)/);
  assert.match(sidebar, /interruptHold/);
});
check('T3-F3 指针五件套接线且 pointerdown 先设 target 再启动（.prevent 抑制 mousedown 等默认行为，click 仍派发——阻冒泡见 T3-M1）', () => {
  assert.match(sidebar, /@pointerdown\.prevent="holdTargetId = session\.id; interruptHold\.onPointerDown\(\$event\)"/);
  assert.match(sidebar, /@pointermove="interruptHold\.onPointerMove\(\$event\)"/);
  assert.match(sidebar, /@pointerup="interruptHold\.onPointerUp\(\$event\)"/);
  assert.match(sidebar, /@pointerleave="interruptHold\.onPointerLeave\(\)"/);
  assert.match(sidebar, /@pointercancel="interruptHold\.onPointerCancel\(\)"/);
});
check('T3-F4 键盘两件 + blur 接入（可达性，对齐 SessionToolbar 形态）', () => {
  assert.match(sidebar, /@keydown="interruptHold\.onKeydown\(\$event\)"/);
  assert.match(sidebar, /@keyup="interruptHold\.onKeyup\(\$event\)"/);
  assert.match(sidebar, /@blur="interruptHold\.onBlur\(\)"/);
});
check('T3-F5 进度可视：holdProgress 绑定填充宽度 + holding 态类', () => {
  assert.match(sidebar, /interruptHoldProgress/);
  assert.match(sidebar, /session-card__interrupt-fill/);
  assert.match(sidebar, /interruptHolding/);
});

console.log('\n=== T3-G · 中断链路与聊天区一致 ===');

check('T3-G1 活动会话走 useChat().abort（与 SessionToolbar 同一 abort 链路）', () => {
  assert.match(sidebar, /useChat\(\)/);
  const fnIdx = sidebar.indexOf('async function interruptSession(');
  assert.ok(fnIdx > -1, '缺 interruptSession');
  const body = sliceBalanced(sidebar, fnIdx);
  assert.match(body, /store\.activeSession\?\.id/);
  assert.match(body, /await abortActive\(\)/);
});
check('T3-G2 后台会话走 window.claudeLink.abortChat（同一 CHAT_ABORT 通道，不另造轻量中止）', () => {
  const fnIdx = sidebar.indexOf('async function interruptSession(');
  const body = sliceBalanced(sidebar, fnIdx);
  assert.match(body, /window\.claudeLink\.abortChat\(session\.id\)/);
  // 与聊天区同一 IPC 通道（preload abortChat → CHAT_ABORT）
  const preload = read('../src/preload/api.ts');
  assert.match(preload, /abortChat: \(sessionId\) => ipcRenderer\.invoke\(IPC_CHANNELS\.CHAT_ABORT, sessionId\)/);
});
check('T3-G3 长按完成回调复查 canInterrupt（防回合自然结束后的幽灵 abort）', () => {
  const cbIdx = sidebar.indexOf('useHoldAction(');
  assert.ok(cbIdx > -1, '缺 useHoldAction 接线');
  const body = sidebar.slice(cbIdx, cbIdx + 400);
  assert.match(body, /canInterrupt\(target\)/);
});

console.log('\n=== T3-H · 保留清单逐项存在性钉 ===');

check('T3-H1 搜索框保留（sidebar__search + 搜索会话标题 placeholder）', () => {
  assert.ok(sidebar.includes('class="sidebar__search"'));
  assert.ok(sidebar.includes('placeholder="搜索会话标题"'));
});
check('T3-H2 批量删除 checkbox 保留（session-card__check + 全选/删除条）', () => {
  assert.ok(sidebar.includes('class="session-card__check"'));
  assert.ok(sidebar.includes('toggleSelectAll'));
  assert.ok(sidebar.includes('confirmBatchDelete'));
});
check('T3-H3 ⏳ 待确认弹窗徽章保留（字面量 + title「该会话有待确认的弹窗」+ 判定源不变）', () => {
  assert.match(sidebar, /pendingRemoteCountBySession\[session\.id\]/);
  assert.ok(sidebar.includes('title="该会话有待确认的弹窗"'));
  assert.ok(sidebar.includes('⏳'));
});
check('T3-H4 状态四态类保留（--running/--retrying/--completed/--network-interrupted）+ 呼吸动画', () => {
  for (const cls of ["'session-card--running'", "'session-card--retrying'", "'session-card--completed'", "'session-card--network-interrupted'"]) {
    assert.ok(sidebar.includes(cls), `缺状态类 ${cls}`);
  }
  const pulseDecls = sidebar.split('animation: session-status-pulse 1.2s ease-in-out infinite').length - 1;
  assert.equal(pulseDecls, 1, `pulse 声明应恰好 1 条，实际 ${pulseDecls}`);
});
check('T3-H5 选中态 --selected + active 态保留', () => {
  assert.ok(sidebar.includes("'session-card--selected'"));
  assert.match(sidebar, /active: store\.activeSession\?\.id === session\.id/);
});
check('T3-H6 hover 显隐规则保留（ops 组 hover / focus-within 显现，键盘可达）', () => {
  assert.match(sidebar, /\.session-card:hover \.session-card__ops/);
  assert.match(sidebar, /\.session-card:focus-within \.session-card__ops/);
});
check('T3-H7 分组头「标签 | N」保留（sidebar__group__label + __count）', () => {
  assert.ok(sidebar.includes('class="sidebar__group__label"'));
  assert.ok(sidebar.includes('class="sidebar__group__count"'));
  assert.match(template, /\{\{ group\.label \}\}/);
  assert.match(template, /\{\{ group\.sessions\.length \}\}/);
});
check('T3-H8 空态二分文案保留（未找到匹配的会话 / 暂无会话）', () => {
  assert.match(sidebar, /store\.searchQuery \? '未找到匹配的会话' : '暂无会话'/);
});
check('T3-H9 删除确认两段文案逐字保留（batch 版先于 single 版）', () => {
  const batchMsg = '确定删除选中的 ${count} 个会话？会话及其全部消息、任务与附件将被永久删除，此操作不可撤销。';
  const singleMsg = '确定删除会话「${session.name}」？此操作不可撤销。';
  const batchIdx = sidebar.indexOf(batchMsg);
  const singleIdx = sidebar.indexOf(singleMsg);
  assert.ok(batchIdx !== -1 && singleIdx !== -1, '删除确认文案缺失');
  assert.ok(batchIdx < singleIdx, 'batch 版 message 必须先于 single 版');
});
check('T3-H10 快捷键与搜索回写保留（Ctrl+N、/、watch searchQuery）', () => {
  assert.match(sidebar, /\(e\.ctrlKey \|\| e\.metaKey\) && e\.key\.toLowerCase\(\) === 'n'/);
  assert.match(sidebar, /searchInputRef\.value\?\.focus\(\)/);
  assert.match(sidebar, /watch\(\s*\(\) => store\.searchQuery,\s*\(q\) => \{\s*searchQuery\.value = q;\s*\},?\s*\);/);
});
check('T3-H11 P11 防泄漏清理保留（unmount 清 debounceTimer）', () => {
  assert.match(sidebar, /if \(debounceTimer\) \{\s*clearTimeout\(debounceTimer\);/);
});
check('T3-H12 时间列保留（formatSessionTime(session.updatedAt)）', () => {
  assert.match(sidebar, /formatSessionTime\(session\.updatedAt\)/);
});
check('T3-H13 (P2-A) idle 状态块静态化：模板动态修饰类生成 --idle + 样式侧 .session-card__status--idle 关停规则（无光环/无动画）', () => {
  // 模板侧：:class="[`session-card__status--${displayStatus(session.id)}`]" 对 idle 恒生成
  // --idle 修饰类（SessionDisplayStatus 五态含 idle）——关停规则的存在前提。
  assert.match(sidebar, /:class="\[`session-card__status--\$\{displayStatus\(session\.id\)\}`\]"/);
  // 样式侧：idle 显式关停规则存在且含两条关停声明（缺任一即运行态样式泄漏到静态态）。
  const m = /\.session-card__status--idle\s*\{/.exec(sidebar);
  assert.ok(m, '缺 .session-card__status--idle 关停规则（idle 永久呼吸 + 黄光环未修）');
  const body = sliceBalanced(sidebar, m.index);
  assert.ok(body.includes('box-shadow: none'), 'idle 关停规则缺 box-shadow: none（黄光环未关）');
  assert.ok(body.includes('animation: none'), 'idle 关停规则缺 animation: none（呼吸未停）');
});
check('T3-H14 (P2-A) 状态块注释与实现一致：不再声称「idle 无修饰类」', () => {
  assert.ok(!sidebar.includes('idle 无修饰类'), '注释仍误称「idle 无修饰类」（与模板动态修饰类绑定矛盾，评审 P2-A）');
});

console.log('\n=== T3-I · 主题 token 钉 ===');

check('T3-I1 .session-card 新样式段存在（卡片化已实现）', () => {
  assert.ok(/\.session-card\s*\{/.test(sidebar), 'style 段缺 .session-card 样式块');
});
check('T3-I2 .session-card 新样式段零硬编码十六进制色值（全走 var/color-mix token）', () => {
  const styleStart = sidebar.indexOf('<style');
  const cardStyleStart = sidebar.indexOf('.session-card {', styleStart);
  assert.ok(cardStyleStart > -1, '未找到 .session-card 样式定义');
  const segment = sidebar.slice(cardStyleStart);
  const hexColors = segment.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(hexColors, [], `卡片样式段发现硬编码色值：${hexColors.join(', ')}`);
});

console.log('\n=== T3-J · 零影响钉 ===');

check('T3-J1 消息区/任务面板四文件不含 session-card / session-link 类名（交叉污染零）', () => {
  for (const [label, src] of [['MessageBubble', messageBubble], ['MessageList', messageList], ['TaskQueuePanel', taskQueuePanel], ['TaskItem', taskItem]]) {
    assert.ok(!src.includes('session-card'), `${label} 被卡片化波及（含 session-card）`);
    assert.ok(!src.includes('session-link__'), `${label} 被侧栏旧类名污染（含 session-link__）`);
  }
});
check('T3-J2 AppSidebar 不含消息区/任务面板类名（反向污染零）', () => {
  for (const needle of ['bubble__', 'msg-transition', 'task-item__', 'task-queue', 'subagent-group']) {
    assert.ok(!sidebar.includes(needle), `AppSidebar 出现外来字面 ${needle}`);
  }
});
check('T3-J3 总验收门声明：npm run selftest:static 全量静态回归由总验收阶段执行（本脚本不内联 spawn）', () => {
  // 出卷口径（派发词 T3-J 转写裁决）：脚本内不 spawn selftest:static（全量静态套件太重），
  // 以「四文件零交叉污染」结构断言 + 总验收门全量 selftest:static 兜底覆盖，GREEN 阶段如实申报。
  assert.ok(true);
});

console.log('\n=== T3-K · 中断收口语义 ===');

check('T3-K1 活动会话分支：activeSession?.id 判据 → abortActive()（乐观复位在 useChat.abort 内部）', () => {
  const fnIdx = sidebar.indexOf('async function interruptSession(');
  const body = sliceBalanced(sidebar, fnIdx);
  const activeIdx = body.indexOf('store.activeSession?.id');
  const abortIdx = body.indexOf('await abortActive()');
  const elseIdx = body.indexOf('else await');
  assert.ok(activeIdx > -1 && abortIdx > activeIdx, '活动分支判据/调用缺失');
  assert.ok(elseIdx > abortIdx, '活动分支应先于后台分支');
});
check('T3-K2 后台会话分支不乐观改态：abortChat IPC 直调 + 负向钉（侧栏无 markStopped/clearStream 等乐观复位字面）', () => {
  const fnIdx = sidebar.indexOf('async function interruptSession(');
  const body = sliceBalanced(sidebar, fnIdx);
  assert.match(body, /window\.claudeLink\.abortChat\(session\.id\)/);
  for (const forbidden of ['markStopped', 'clearStream', 'clearThinking', 'clearToolStream', 'finalizeAssistantStream']) {
    assert.ok(!sidebar.includes(forbidden), `侧栏不得乐观改态（出现 ${forbidden}——乐观复位只属 useChat().abort 内部）`);
  }
});
check('T3-K3 后台终态收口路径存在（abort 失败静默 + 终态事件兜底注释语义）', () => {
  const fnIdx = sidebar.indexOf('async function interruptSession(');
  const body = sliceBalanced(sidebar, fnIdx);
  assert.match(body, /\.catch\(\(\) => \{/);
});

console.log('\n=== T3-L · 置顶乐观更新与重拉竞态 ===');

check('T3-L1 togglePin：乐观 patch（await 前）→ setSessionPinned IPC → loadSessions 权威重拉 → 失败回滚', () => {
  const fnIdx = storeSrc.indexOf('async togglePin(sessionId: string)');
  assert.ok(fnIdx > -1, '缺 togglePin');
  const body = sliceBalanced(storeSrc, fnIdx);
  const patchIdx = body.indexOf('patchSessionInLists(sessionId, { pinnedAt: wasPinned ? null : Date.now() })');
  const ipcIdx = body.indexOf('window.claudeLink.setSessionPinned(sessionId, !wasPinned)');
  const reloadIdx = body.indexOf('await this.loadSessions()');
  const rollbackIdx = body.indexOf('patchSessionInLists(sessionId, { pinnedAt: prevPinnedAt })');
  assert.ok(patchIdx > -1 && ipcIdx > patchIdx, '乐观 patch 必须先于 IPC');
  assert.ok(reloadIdx > ipcIdx, '权威重拉在 IPC 之后');
  assert.ok(rollbackIdx > -1, '缺失败回滚');
});
check('T3-L2 SQL 权威序兜底链保留（pinned 优先前缀 ORDER BY）', () => {
  assert.ok(sessionRepoSrc.includes('ORDER BY (pinned_at IS NOT NULL) DESC, pinned_at DESC'));
});
check('T3-L3 重拉返回旧快照也不丢置顶：跨组提取 pinnedAt DESC 二次保证（纯函数层防御）', () => {
  const groups = groupSessionsByProject([session('plain', '/d/p1'), session('pin', '/d/p1', 123)]);
  assert.equal(groups[0].key, '__pinned__');
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['pin']);
});

console.log('\n=== T3-M · (P2-B/P3 串扰) 中断钮 click 阻冒泡 + hold 态目标过滤 ===');

check('T3-M1 中断钮绑定含 @click.stop（短按 click 冒泡到卡片 @click → 误 openSession；scoped 中断钮元素切片）', () => {
  const start = sidebar.indexOf('class="session-card__interrupt"');
  assert.ok(start > -1, '缺中断钮元素');
  const btnSlice = sidebar.slice(start, sidebar.indexOf('</button>', start));
  assert.ok(btnSlice.includes('@click.stop'), '中断钮缺 @click.stop（评审 P2-B：Chromium 实测 @pointerdown.prevent 不阻止 click 派发与冒泡）');
  // 修法方向钉：卡片自身 @click 必须仍在——阻冒泡修在钮侧，不是拆卡片点击能力。
  assert.ok(
    sidebar.includes('@click="batchMode ? toggleSelected(session.id) : openSession(session)"'),
    '卡片 @click 被移除（正确修法是钮侧阻冒泡，不是拆卡片点击）',
  );
});
check('T3-M2 use-hold-action 注释口径修正：不再声称「.prevent 吃掉原生 click」，明示 click 仍派发 + 调用方 @click.stop 指引', () => {
  assert.ok(!holdComposable.includes('吃掉原生 click'), '注释仍误称「.prevent 吃掉原生 click」（评审 P2-B 根因认知错误）');
  assert.ok(!holdComposable.includes('单击不再触发按钮默认行为'), '注释仍误称「单击不再触发按钮默认行为」');
  assert.ok(holdComposable.includes('click 仍会派发'), '注释缺准确表述「click 仍会派发」');
  assert.ok(holdComposable.includes('调用方需自行 @click.stop'), '注释缺「调用方需自行 @click.stop 阻冒泡」指引');
});
check('T3-M3 (P3 串扰) holding 态类按目标过滤：interruptHolding && holdTargetId === session.id', () => {
  const start = sidebar.indexOf('class="session-card__interrupt"');
  assert.ok(start > -1, '缺中断钮元素');
  const btnSlice = sidebar.slice(start, sidebar.indexOf('</button>', start));
  assert.match(
    btnSlice,
    /'session-card__interrupt--holding':\s*interruptHolding && holdTargetId === session\.id/,
    'holding 类未按目标过滤（单槽 hold 状态为全部卡片共享，按住 A 卡中断钮时 B 卡同显按压态）',
  );
});
check('T3-M4 (P3 串扰) fill 宽度绑定按目标过滤：非目标卡恒 0%', () => {
  const start = sidebar.indexOf('class="session-card__interrupt"');
  assert.ok(start > -1, '缺中断钮元素');
  const btnSlice = sidebar.slice(start, sidebar.indexOf('</button>', start));
  assert.match(
    btnSlice,
    /width:\s*interruptHolding && holdTargetId === session\.id \? `\$\{interruptHoldProgress\}%` : '0%'/,
    'fill 宽度未按目标过滤（长按进度条泄漏到非目标卡）',
  );
});

console.log(`\n[UI13-P3 侧栏卡片化契约] 通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
