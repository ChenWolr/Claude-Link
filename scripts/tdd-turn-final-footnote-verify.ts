// tdd-turn-final-footnote-verify.ts
// F1「回合终态脚注独立载体」契约脚本（2026-11-15 八问题批次，用例正本 03b-test-cases-renderer.md §13）。
//
//   F1-1  载体结构钉（兼行为规范 T2.6 正本）：MessageList 回合尾（renderItems 循环后、stream-group
//         之前）存在独立脚注载体 data-testid="turn-footnote"，三 kind 类名 success/interrupted/error；
//         渲染条件绑定回合终态（exportMode/sending 排除 + note 三分支 + DB 回落）；终态文案三分支
//         字面：成功「本次回复 X:XX · 结束于 HH:MM」（无效耗时只显「结束于」半句）、中断
//         「已中断 · 运行 X:XX」（无耗时只「已中断」）、错误「失败 · 运行 X:XX」（无耗时只「失败」）；
//         无内存 note 时成功回合回落 DB lastTurnDurationMs/lastTurnEndedAt（P2-1 中断不落库语义维持）。
//   F1-1d 数据面结构钉：session-store turnFootnote state（per-session 单槽）+ setTurnFootnote
//         action + markRunning 新回合边界清槽 + deleteSession 清理；use-chat 后台/前台 turn_ended
//         两分支各 +1 行无条件记账（在 running 守卫之前，与 noteTurnEndedServer 同门同位）。
//   F1-1e 行为直测（pinia 真实 store）：setTurnFootnote 三 outcome 写入 / durationMs 非正数置 0
//         （无造数纪律）/ running 门防复活（runningSessions 含 sid 时写入被拒）/ markRunning
//         新回合边界清槽（仅最新回合显示）/ deleteSession 清槽。
//   F1-7  中断/错误收口窗脚注归属钉（round-002 P2-3）：①中断窗临时账——markRunning→markStopped
//         （abort 乐观收口同形裸调用）后 turnFootnote 落 interrupted 临时账（仅内存不落库，
//         P2-1 中断不落库裁决维持），审查探针 FALLBACK 判定（note 空 && lastTurn* 双非 null）
//         不再命中，幂等重入不重写；②迟到终态兜底——turn_ended 在 running 态到达被防复活门
//         拒收后，收口段（markStopped/markCompleted 摘除 running 之后）补一次记账使脚注落地；
//         ③两 turn_ended 分支 running 守卫之后收口段各有兜底记账行源钉；④error 调用面
//         （失败 result/error 分支）显式 footnoteOutcome:'error' 源钉 + MessageList DB 回落
//         归属校验（network_interrupted 常红态不回落显成功句）源钉。
//   F1-5  ToolCallBlock 门控改 durationMs||endedAt 钉：metaMsg computed（use/result 任一
//         durationMs!=null||endedAt!=null 即取）+ meta 行渲染门控与 MessageBubble 同口径
//         （负向钉：门控不含 costUsd 合取——costUsd 单独门控不再压死 meta 行）+ endedAt 展示
//         维持 exportMode||expanded 条件；ThinkingBlock 负向钉（组件内零 meta 行渲染分支）。
//   F1-6  双写链零回归 spawn 门：tdd-bugfix-b1-turn-meta-persistence-verify.ts（V12 持久化十钉）+
//         tdd-bugfix-b3-turn-endtime-bubble-verify.ts（endedAt 链+气泡脚注钉）+
//         tdd-user-timestamp-below-bubble-verify.ts（T5-E assistant 脚注字面回归钉）三脚本退出码 0。
//
// CDP/P 链场景（F1-2 四形态一致可见 / F1-3 仅最新回合 / F1-4 重开语义）归 T1B/T1CLP 网页/P 链
// 契约（03b §13 F1-2/F1-3/F1-4 执行命令形态），不在本脚本。
//
// 运行：npx tsx scripts/tdd-turn-final-footnote-verify.ts（已登记 scripts/selftest-static-list.txt）

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${repoRoot}/${rel}`, 'utf8');

const messageList = read('src/renderer/components/chat/MessageList.vue');
const toolCallBlock = read('src/renderer/components/chat/ToolCallBlock.vue');
const thinkingBlock = read('src/renderer/components/chat/ThinkingBlock.vue');
const messageBubble = read('src/renderer/components/chat/MessageBubble.vue');
const sessionStoreSrc = read('src/renderer/stores/session-store.ts');
const useChat = read('src/renderer/composables/use-chat.ts');
const selftestList = read('scripts/selftest-static-list.txt');

/** MessageList 模板区（首个 <template> 到最后一个 </template> 前——避开 scoped style）。 */
const tplStart = messageList.indexOf('<template>');
const tplEnd = messageList.lastIndexOf('</template>');
const messageListTpl = messageList.slice(tplStart, tplEnd);
/** renderItems v-for 循环闭合（</template> 独行）位置。 */
const loopCloseIdx = messageListTpl.indexOf('        </template>');
const streamGroupIdx = messageListTpl.indexOf('class="stream-group"');

console.log('\n=== F1-1 脚注独立载体结构钉（03b §13 F1-1，兼规范 T2.6 正本） ===');
check('F1-1(1) 载体存在：data-testid="turn-footnote" 恰 1 处，位于 renderItems 循环闭合之后、stream-group 之前', () => {
  const carrierIdx = messageListTpl.indexOf('data-testid="turn-footnote"');
  assert.ok(carrierIdx >= 0, 'MessageList 模板未找到 data-testid="turn-footnote"——脚注独立载体缺失');
  assert.equal(
    messageListTpl.split('data-testid="turn-footnote"').length - 1, 1,
    'turn-footnote 载体须恰 1 处（同一会话仅最新回合单载体）',
  );
  assert.ok(loopCloseIdx >= 0 && streamGroupIdx >= 0, '锚点提取失败（renderItems 闭合/stream-group）');
  assert.ok(carrierIdx > loopCloseIdx, '载体须在 renderItems 循环闭合之后（回合尾=最后内容块之后）');
  assert.ok(carrierIdx < streamGroupIdx, '载体须在 stream-group 之前（sending 期间脚注已 v-if 排除，无交错）');
});
check('F1-1(2a) 三 kind 类名：turn-footnote--success/--interrupted/--error（动态绑定 turn-footnote--${kind} + computed 三 outcome 字面）', () => {
  const blockStart = messageListTpl.indexOf('data-testid="turn-footnote"');
  const block = messageListTpl.slice(Math.max(0, blockStart - 220), blockStart + 400);
  assert.ok(block.includes("'turn-footnote'"), '根类名 turn-footnote 缺失');
  // 计划规定的动态绑定形态：`turn-footnote--${turnFootnote.kind}`（03b F1-1：三 kind 类名，kind
  // 取值 success/interrupted/error 由 computed outcome 三分支字面保证，见 F1-1(3a) 断言）。
  assert.ok(block.includes('turn-footnote--${') && block.includes('.kind'), 'kind 动态类名绑定 turn-footnote--${…} 缺失');
  const computedStart = messageList.indexOf('const turnFootnote');
  const computedEnd = messageList.indexOf('\n});', computedStart);
  const body = messageList.slice(computedStart, computedEnd);
  for (const kind of ['success', 'interrupted', 'error']) {
    assert.ok(body.includes(`'${kind}'`), `kind 取值 '${kind}' 在 computed outcome 分支缺失`);
  }
});
check('F1-1(2b) 渲染条件绑定回合终态：computed turnFootnote 排除 exportMode/sending（导出面不新增、回合未终不渲染）', () => {
  assert.ok(/const turnFootnote = computed</.test(messageList), 'MessageList 缺 turnFootnote computed');
  const computedStart = messageList.indexOf('const turnFootnote');
  const computedEnd = messageList.indexOf('\n});', computedStart);
  const body = messageList.slice(computedStart, computedEnd);
  assert.ok(body.includes('props.exportMode'), 'computed 须排除 exportMode（导出面不新增载体）');
  assert.ok(body.includes('props.sending'), 'computed 须排除 sending（回合未终不渲染）');
  assert.ok(body.includes('sessionStore.turnFootnote'), 'computed 须读 sessionStore.turnFootnote 内存记账');
});
check('F1-1(3a) 成功分支文案字面：「本次回复 {耗时} · 结束于 {时刻}」；durationMs=0 只显「结束于」半句', () => {
  const computedStart = messageList.indexOf('const turnFootnote');
  const computedEnd = messageList.indexOf('\n});', computedStart);
  const body = messageList.slice(computedStart, computedEnd);
  assert.ok(body.includes('本次回复'), '成功句缺「本次回复」段');
  assert.ok(body.includes('· 结束于'), '成功句缺「· 结束于」段（耗时与时刻两段式）');
  assert.ok(body.includes("'success'") && body.includes("'interrupted'") && body.includes("'error'"), '三分支 outcome 判定缺失');
  assert.ok(body.includes("已中断") && body.includes("失败"), '中断/错误分支字面缺失');
});
check('F1-1(3b) 中断/错误分支文案字面：「已中断 · 运行 X:XX」/「失败 · 运行 X:XX」', () => {
  const computedStart = messageList.indexOf('const turnFootnote');
  const computedEnd = messageList.indexOf('\n});', computedStart);
  const body = messageList.slice(computedStart, computedEnd);
  assert.ok(body.includes('· 运行'), '中断/错误句缺「· 运行」段');
  assert.ok(body.includes("'已中断'"), '无效耗时降级半句「已中断」缺失');
  assert.ok(body.includes("'失败'"), '无效耗时降级半句「失败」缺失');
});
check('F1-1(4a) 无 note 时成功回落 DB：lastTurnDurationMs/lastTurnEndedAt 两字段同时非 null 才渲染（诚实不造数）', () => {
  const computedStart = messageList.indexOf('const turnFootnote');
  const computedEnd = messageList.indexOf('\n});', computedStart);
  const body = messageList.slice(computedStart, computedEnd);
  assert.ok(body.includes('lastTurnDurationMs') && body.includes('lastTurnEndedAt'), 'DB 回落字段缺失（V12 sessions.last_turn_*）');
  assert.ok(body.includes('!= null'), '回落须双字段同时非 null 门控（半写不渲染）');
});
check('F1-1(4b) 独立于消息类型：格式化走 shared/format-duration 单源（formatDurationMs/formatEndedAt），载体非 MessageBubble 内部分支', () => {
  assert.ok(messageList.includes("from '../../../shared/format-duration'"), 'MessageList 须 import shared/format-duration 单源格式化');
  // MessageBubble 既有气泡脚注保留（b3 回归红线——双呈现申报不修，见 04 §5 零触碰面）。
  assert.ok(messageBubble.includes('class="bubble__meta"'), 'MessageBubble 既有脚注块被误删（b3 红线：逐字保留）');
});
check('F1-1(5) 载体时钟 svg 与 bubble__meta-clock 同形（circle cx=12 cy=12 r=9 + path M12 7v5l3.5 2）', () => {
  const carrierStart = messageListTpl.indexOf('data-testid="turn-footnote"');
  const carrier = messageListTpl.slice(carrierStart, messageListTpl.indexOf('</div>', carrierStart));
  assert.ok(carrier.includes('<svg'), '脚注载体缺时钟 svg');
  assert.ok(carrier.includes('cx="12"') && carrier.includes('cy="12"') && carrier.includes('r="9"'), 'svg circle 同形缺失');
  assert.ok(carrier.includes('M12 7v5l3.5 2'), 'svg path 同形缺失');
});
check('F1-1(6) 脚注样式全 var()（muted 基色 + warn/fail 分支色，浅深双板 token）', () => {
  const styleStart = messageList.lastIndexOf('<style scoped>');
  const style = messageList.slice(styleStart);
  assert.ok(style.includes('.turn-footnote'), '缺 .turn-footnote 样式块');
  assert.ok(style.includes('--color-text-muted'), '基色须 var(--color-text-muted)');
  assert.ok(style.includes('--color-warn-strong'), '中断分支须 var(--color-warn-strong)');
  assert.ok(style.includes('--color-fail-strong'), '错误分支须 var(--color-fail-strong)');
  const tnStart = style.indexOf('.turn-footnote');
  const tnBlock = style.slice(tnStart, style.indexOf('}', tnStart));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(tnBlock), '脚注样式块不得含硬编码色值（全 var()）');
});

console.log('\n=== F1-1d 数据面结构钉（session-store + use-chat 两分支记账） ===');
check('F1-1d-1 session-store：turnFootnote state（per-session 单槽，outcome/durationMs/endedAt 三字段）', () => {
  assert.ok(/turnFootnote: \{\} as Record<string,/.test(sessionStoreSrc), 'session-store 缺 turnFootnote state');
  assert.ok(/outcome: 'success' \| 'error' \| 'interrupted'/.test(sessionStoreSrc), 'turnFootnote outcome 三值类型缺失');
});
check('F1-1d-2 setTurnFootnote action：durationMs 非正数/非有限置 0（无造数纪律）+ running 门防复活', () => {
  const fnStart = sessionStoreSrc.indexOf('setTurnFootnote(sessionId');
  assert.ok(fnStart >= 0, 'session-store 缺 setTurnFootnote action');
  const fnEnd = sessionStoreSrc.indexOf('\n    },', fnStart);
  const body = sessionStoreSrc.slice(fnStart, fnEnd);
  assert.ok(body.includes('Number.isFinite'), '缺 Number.isFinite 无效耗时判定');
  assert.ok(body.includes('> 0'), '缺正数判定（非正数置 0）');
  assert.ok(body.includes('runningSessions.includes(sessionId)'), '缺 running 门防复活（runningSessions 含 sid 时写入被拒）');
});
check('F1-1d-3 markRunning 新回合边界清槽：delete this.turnFootnote[sessionId]（仅最新回合显示）', () => {
  const fnStart = sessionStoreSrc.indexOf('markRunning(sessionId');
  assert.ok(fnStart >= 0, 'markRunning 缺失');
  const fnEnd = sessionStoreSrc.indexOf('\n    },', fnStart);
  const body = sessionStoreSrc.slice(fnStart, fnEnd);
  assert.ok(body.includes('delete this.turnFootnote[sessionId]'), 'markRunning 缺脚注清槽（新回合边界=旧脚注退场）');
});
check('F1-1d-4 deleteSession 清理区删 turnFootnote（防内存泄漏）', () => {
  const fnStart = sessionStoreSrc.indexOf('async deleteSession(id');
  assert.ok(fnStart >= 0, 'deleteSession 缺失');
  const fnEnd = sessionStoreSrc.indexOf('    try {', fnStart);
  const body = sessionStoreSrc.slice(fnStart, fnEnd);
  assert.ok(body.includes('delete this.turnFootnote[id]'), 'deleteSession 清理区缺 turnFootnote 清槽');
});
check('F1-1d-5 use-chat 后台 turn_ended 分支记账：noteTurnEndedServer 旁 +1 行 setTurnFootnote（running 守卫之前=无条件记账区）', () => {
  const first = useChat.indexOf("case 'turn_ended':");
  assert.ok(first >= 0, '后台 turn_ended 分支缺失');
  const firstEnd = useChat.indexOf("case 'result':", first);
  const branch = useChat.slice(first, firstEnd);
  assert.ok(branch.includes('setTurnFootnote(sid, { outcome: event.outcome, durationMs: event.durationMs, endedAt: event.endedAt }'), '后台分支缺 setTurnFootnote 记账行');
  const noteIdx = branch.indexOf('noteTurnEndedServer(sid, event.endedAt)');
  const guardIdx = branch.indexOf('if (!store.runningSessions.includes(sid)) break;');
  const footIdx = branch.indexOf('store.setTurnFootnote(sid');
  assert.ok(noteIdx >= 0 && guardIdx >= 0 && footIdx > noteIdx && footIdx < guardIdx, '后台记账须在 noteTurnEndedServer 之后、running 守卫之前（无条件记账区，迟到终态同门入账）');
});
check('F1-1d-6 use-chat 前台 turn_ended 分支记账：noteTurnEndedServer 旁 +1 行 setTurnFootnote（running 守卫之前）', () => {
  const second = useChat.indexOf("case 'turn_ended':", useChat.indexOf("case 'turn_ended':") + 1);
  assert.ok(second >= 0, '前台 turn_ended 分支缺失');
  const secondEnd = useChat.indexOf('\n      }', second);
  const branch = useChat.slice(second, secondEnd);
  assert.ok(branch.includes('setTurnFootnote(sid, { outcome: event.outcome, durationMs: event.durationMs, endedAt: event.endedAt }'), '前台分支缺 setTurnFootnote 记账行');
  const noteIdx = branch.indexOf('noteTurnEndedServer(sid, event.endedAt)');
  const guardIdx = branch.indexOf('if (!store.runningSessions.includes(sid)) break;');
  const footIdx = branch.indexOf('store.setTurnFootnote(sid');
  assert.ok(noteIdx >= 0 && guardIdx >= 0 && footIdx > noteIdx && footIdx < guardIdx, '前台记账须在 noteTurnEndedServer 之后、running 守卫之前');
});
check('F1-1d-7 V12 双写链零触碰：attachResultMetadata/recordTurnMeta/setLastTurnMeta 调用行仍在（消费面不动）', () => {
  assert.ok(useChat.includes('attachResultMetadata'), 'attachResultMetadata 被误删');
  assert.ok(useChat.includes('recordTurnMeta(sid, {'), 'recordTurnMeta 调用被误删');
  assert.ok(sessionStoreSrc.includes('setLastTurnMeta(sessionId'), 'setLastTurnMeta 被误删');
  assert.ok(sessionStoreSrc.includes('activeLastTurnMeta(state)'), 'activeLastTurnMeta getter 被误删（TurnTimer 消费面）');
});
check('F1-1d-8 selftest 清单登记：selftest-static-list.txt 含本脚本', () => {
  assert.ok(selftestList.includes('scripts/tdd-turn-final-footnote-verify.ts'), 'selftest-static-list.txt 未登记本脚本');
});

console.log('\n=== F1-1e 行为直测（pinia 真实 store 注入，兼 F1-2d store 级注入兜底） ===');
// 对齐 tdd-send-route-verify 夹具惯例：createRequire 同一 require 引入 pinia + session-store
//（tsx 下 require 可加载 .ts 模块，保证单实例；避免顶层 await——本仓库 tsx 输出 CJS）。
const req = createRequire(import.meta.url);
let piniaMod: { createPinia: () => unknown; setActivePinia: (p: unknown) => void } | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sessionStoreMod: any = null;
try {
  piniaMod = req('pinia');
  sessionStoreMod = req('../src/renderer/stores/session-store');
} catch {
  piniaMod = null;
  sessionStoreMod = null;
}
check('F1-1e-0 夹具可用（session-store/pinia 模块在 tsx 下可加载）', () => {
  assert.ok(piniaMod && sessionStoreMod && typeof sessionStoreMod.useSessionStore === 'function', 'session-store/pinia 模块加载失败，行为直测不可用');
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function freshStore(): any {
  piniaMod!.setActivePinia(piniaMod!.createPinia());
  return sessionStoreMod.useSessionStore();
}
const SID = 'sess-f1-footnote';
const NOTE_SUCCESS = { outcome: 'success' as const, durationMs: 9500, endedAt: 1763200000000 };
const NOTE_ERROR = { outcome: 'error' as const, durationMs: 4200, endedAt: 1763200000001 };
const NOTE_INTERRUPTED = { outcome: 'interrupted' as const, durationMs: 18000, endedAt: 1763200000002 };

check('F1-1e-1 setTurnFootnote 三 outcome 正常写入（空闲态入账）', () => {
  const store = freshStore();
  store.setTurnFootnote(SID, NOTE_SUCCESS);
  assert.deepStrictEqual(store.turnFootnote[SID], { ...NOTE_SUCCESS }, 'success 记账失真');
  store.setTurnFootnote(SID, NOTE_ERROR);
  assert.equal(store.turnFootnote[SID].outcome, 'error', 'error 覆盖失败（单槽末事件胜）');
  store.setTurnFootnote(SID, NOTE_INTERRUPTED);
  assert.equal(store.turnFootnote[SID].outcome, 'interrupted', 'interrupted 覆盖失败');
});
check('F1-1e-2 durationMs 非正数/非有限置 0（无造数纪律：0/负数/NaN/Infinity → 0，渲染只显半句）', () => {
  const store = freshStore();
  for (const bad of [0, -123, Number.NaN, Number.POSITIVE_INFINITY]) {
    store.setTurnFootnote(SID, { ...NOTE_SUCCESS, durationMs: bad });
    assert.equal(store.turnFootnote[SID].durationMs, 0, `durationMs=${bad} 未置 0`);
  }
  store.setTurnFootnote(SID, { ...NOTE_SUCCESS, durationMs: 1 });
  assert.equal(store.turnFootnote[SID].durationMs, 1, '正数被误置 0');
});
check('F1-1e-3 running 门防复活：runningSessions 含 sid 时写入被拒（迟到 turn_ended 不复活旧脚注）', () => {
  const store = freshStore();
  store.markRunning(SID);
  store.setTurnFootnote(SID, NOTE_SUCCESS);
  assert.equal(store.turnFootnote[SID], undefined, 'running 态写入未被拒（防复活门缺失）');
  // 既有收口路径摘除 running 后，迟到终态入账（空闲态入账回归面）。
  store.markCompleted(SID);
  store.setTurnFootnote(SID, NOTE_SUCCESS);
  assert.ok(store.turnFootnote[SID], '空闲态正常入账被误拒');
});
check('F1-1e-4 markRunning 新回合边界清槽：旧脚注退场（同一会话仅最新回合显示）', () => {
  const store = freshStore();
  store.setTurnFootnote(SID, NOTE_SUCCESS);
  assert.ok(store.turnFootnote[SID], '前置记账失败');
  store.markRunning(SID);
  assert.equal(store.turnFootnote[SID], undefined, '新回合起步未清旧脚注（历史回合堆脚注）');
});
check('F1-1e-5 deleteSession 清理 turnFootnote（防内存泄漏）', () => {
  const store = freshStore();
  // 造一个可删会话并注入脚注；window.claudeLink.deleteSession 桩为 resolve。
  store.sessions = [{ id: SID, name: 'f1-fixture' } as never];
  store.setTurnFootnote(SID, NOTE_SUCCESS);
  assert.ok(store.turnFootnote[SID], '前置记账失败');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const prevWindow = g.window;
  g.window = { claudeLink: { deleteSession: async () => ({ ok: true }) } };
  try {
    // 清理区（含 turnFootnote 清槽）在 deleteSession 首个 await 之前同步执行——同步段即可断言；
    // 异步尾段（IPC stub resolve + discardDraft）自吞错，仅触及本夹具独立 pinia 实例，不影响断言面。
    store.deleteSession(SID).catch(() => {});
    assert.equal(store.turnFootnote[SID], undefined, 'deleteSession 未清 turnFootnote');
  } finally {
    g.window = prevWindow;
  }
});

console.log('\n=== F1-7 中断/错误收口窗脚注归属钉（round-002 P2-3：中断窗临时账 + 迟到终态兜底 + 回落归属校验） ===');
check('F1-7(1) 行为·中断窗临时脚注：markRunning→markStopped 裸调用（abort 乐观收口同形）落 interrupted 临时账，探针 FALLBACK 判定不再命中', () => {
  const store = freshStore();
  store.sessions = [{ id: SID, name: 'f1-fixture', lastTurnDurationMs: null, lastTurnEndedAt: null } as never];
  // T1 成功回合残留（上一回合 meta+脚注）→ T2 起步（markRunning 清槽）→ 用户中断乐观收口。
  // 审查探针 f1-abort-window-probe.mts 同序列：中断窗内 DB 回落分支不得挂上一成功回合脚注。
  store.setLastTurnMeta(SID, { durationMs: 42000, endedAt: 1000 });
  store.setTurnFootnote(SID, { outcome: 'success', durationMs: 42000, endedAt: 1000 });
  store.markRunning(SID, 2000);
  assert.equal(store.turnFootnote[SID], undefined, '前置失败：新回合起步未清旧脚注');
  store.markStopped(SID);
  assert.ok(store.turnFootnote[SID], '中断窗无临时脚注——MessageList 将命中 DB 回落分支把上一成功回合数据挂在刚中断回合下（P2-3 病灶）');
  // 注：as any 仅剥离 assert.equal(x, undefined) 的 asserts 收窄（类型面，round-002 R2-F 收纳 typecheck 补丁），运行时断言不变。
  assert.equal((store.turnFootnote[SID] as any).outcome, 'interrupted', '中断窗临时脚注 outcome 应为 interrupted（abort 调用面默认值）');
  // 审查探针 FALLBACK 判定同式：note 空 && lastTurn* 双非 null 不得同时成立。
  const s = store.sessions[0];
  const fallbackHits = store.turnFootnote[SID] == null
    && s.lastTurnDurationMs != null && s.lastTurnEndedAt != null;
  assert.equal(fallbackHits, false, '探针 FALLBACK_HITS 判定仍命中（中断窗回落未堵住）');
  // P2-1 中断不落库维持：临时账只写内存 turnFootnote，不得触碰会话级 lastTurn*（V12 字段）。
  assert.equal(s.lastTurnDurationMs, 42000, '临时中断账不得改写 sessions.lastTurnDurationMs（P2-1 中断不落库红线）');
  assert.equal(s.lastTurnEndedAt, 1000, '临时中断账不得改写 sessions.lastTurnEndedAt（P2-1 中断不落库红线）');
  // 幂等重入（迟到 result/aborted 重停，非 running 过渡）不得重写临时账（endedAt 漂移）。
  const firstEndedAt = (store.turnFootnote[SID] as any).endedAt;
  store.markStopped(SID);
  assert.equal((store.turnFootnote[SID] as any).endedAt, firstEndedAt, '非 running 过渡的幂等 markStopped 不应重写脚注');
});
check('F1-7(2) 行为·迟到终态兜底：running 拒收（防复活门）→ 收口临时账（error 调用面）→ 权威 event 数据覆盖落地', () => {
  const store = freshStore();
  store.markRunning(SID, 1000);
  // 终态事件丢失路径：turn_ended 在 running 态到达，无条件区记账被 running 门拒绝（F1-1e-3 同门）。
  store.setTurnFootnote(SID, { outcome: 'error', durationMs: 6600, endedAt: 1763200000009 });
  assert.equal(store.turnFootnote[SID], undefined, 'running 态记账未被拒（防复活门回归）');
  // 收口：markStopped（error 调用面显式 outcome）落临时账 → 随行权威记账覆盖（handler 收口段同形）。
  store.markStopped(SID, { footnoteOutcome: 'error' });
  assert.equal((store.turnFootnote[SID] as any).outcome, 'error', '收口临时账应带调用面 outcome（error）而非默认 interrupted');
  store.setTurnFootnote(SID, { outcome: 'error', durationMs: 6600, endedAt: 1763200000009 });
  assert.deepStrictEqual(store.turnFootnote[SID], { outcome: 'error', durationMs: 6600, endedAt: 1763200000009 }, '收口后权威记账未落地（迟到终态脚注缺席）');
});
check('F1-7(3) 源钉·两 turn_ended 分支 running 守卫之后收口段各有兜底记账行（同 event 权威数据）', () => {
  const first = useChat.indexOf("case 'turn_ended':");
  assert.ok(first >= 0, '后台 turn_ended 分支缺失');
  const firstEnd = useChat.indexOf("case 'result':", first);
  const bg = useChat.slice(first, firstEnd);
  const fgStart = useChat.indexOf("case 'turn_ended':", first + 1);
  assert.ok(fgStart > first, '前台 turn_ended 分支缺失');
  const fgEnd = useChat.indexOf('\n      }', fgStart);
  const fg = useChat.slice(fgStart, fgEnd);
  for (const [label, branch] of [['后台', bg], ['前台', fg]] as const) {
    const guardIdx = branch.indexOf('if (!store.runningSessions.includes(sid)) break;');
    assert.ok(guardIdx >= 0, `${label}分支 running 守卫缺失`);
    const afterGuard = branch.slice(guardIdx);
    assert.ok(
      afterGuard.includes('store.setTurnFootnote(sid, { outcome: event.outcome, durationMs: event.durationMs, endedAt: event.endedAt })'),
      `${label}分支 running 守卫之后的收口段缺兜底记账行（迟到终态收口路径脚注缺席）`,
    );
  }
});
check('F1-7(4) 源钉·error 调用面显式 footnoteOutcome:\'error\'（四处）+ MessageList DB 回落归属校验（network_interrupted 不回落）', () => {
  // 前台失败 result / 前台 error 两处（activeSession 形态）+ 后台失败 result / 后台 error+aborted 两处（sid 形态）。
  assert.equal(
    useChat.split("store.markStopped(store.activeSession.id, { footnoteOutcome: 'error' })").length - 1, 2,
    '前台 error 调用面（失败 result/error 分支）footnoteOutcome:\'error\' 应恰 2 处',
  );
  assert.ok(
    useChat.includes("store.markStopped(sid, { footnoteOutcome: 'error' })"),
    '后台失败 result 分支缺 footnoteOutcome:\'error\'',
  );
  assert.ok(
    useChat.includes("store.markStopped(sid, { footnoteOutcome: event.type === 'error' ? 'error' : 'interrupted' })"),
    '后台 error/aborted 分支缺按事件类型分流 footnoteOutcome',
  );
  // MessageList DB 回落归属校验：network_interrupted 常红态在回落读取之前拦下（不回落显成功句）。
  const computedStart = messageList.indexOf('const turnFootnote');
  const computedEnd = messageList.indexOf('\n});', computedStart);
  const body = messageList.slice(computedStart, computedEnd);
  assert.ok(
    body.includes("sessionStore.sessionStatus[sid] === 'network_interrupted'"),
    'DB 回落分支缺归属校验（network_interrupted 常红态不得回落显上一成功回合成功句）',
  );
  const guardIdx = body.indexOf("sessionStore.sessionStatus[sid] === 'network_interrupted'");
  const fallbackIdx = body.indexOf('lastTurnDurationMs');
  assert.ok(guardIdx >= 0 && fallbackIdx > guardIdx, '归属校验须在 DB 回落读取之前（先拦后读）');
});

console.log('\n=== F1-5 ToolCallBlock 门控改 durationMs||endedAt + ThinkingBlock 负向钉（03b §13 F1-5） ===');
check('F1-5(1) metaMsg computed：use/result 任一 durationMs!=null||endedAt!=null 即取（门控字面）', () => {
  const fnStart = toolCallBlock.indexOf('const metaMsg = computed');
  assert.ok(fnStart >= 0, 'ToolCallBlock 缺 metaMsg computed（costMsg 未改写）');
  const fnEnd = toolCallBlock.indexOf('\n});', fnStart);
  const body = toolCallBlock.slice(fnStart, fnEnd);
  assert.ok(body.includes('props.use && (props.use.durationMs != null || props.use.endedAt != null)'), 'use 分支须任一字段命中即取');
  assert.ok(body.includes('props.result && (props.result.durationMs != null || props.result.endedAt != null)'), 'result 分支须任一字段命中即取');
  assert.ok(body.includes('return null'), '缺兜底 null');
});
check('F1-5(2a) meta 行渲染门控=durationMs||endedAt（与 MessageBubble 同口径）', () => {
  assert.ok(toolCallBlock.includes('v-if="metaMsg && (metaMsg.durationMs != null || metaMsg.endedAt != null)"'), 'meta 行门控未改为 durationMs||endedAt 双字段口径');
  // 同口径参照面：MessageBubble 气泡脚注门控。
  assert.ok(messageBubble.includes('v-else-if="message.durationMs || message.endedAt"'), 'MessageBubble 参照门控缺失（b3 红线面被误动）');
});
check('F1-5(2b) 负向钉：meta 行门控不含 costUsd 合取（costUsd 单独门控不再压死 meta 行）', () => {
  const metaRowStart = toolCallBlock.indexOf('class="tool-row__meta"');
  assert.ok(metaRowStart >= 0, 'tool-row__meta 行缺失');
  const lineStart = toolCallBlock.lastIndexOf('<div', metaRowStart);
  const gate = toolCallBlock.slice(lineStart, metaRowStart);
  assert.ok(!gate.includes('costUsd != null'), 'meta 行渲染门控仍含 costUsd 合取（costUsd!=null+展开双门压死 meta 行的病根未除）');
});
check('F1-5(2c) costUsd 单独门控（有则显示）+ durationMs 秒级展示 + endedAt 维持 exportMode||expanded 条件', () => {
  const metaRowStart = toolCallBlock.indexOf('class="tool-row__meta"');
  const rowEnd = toolCallBlock.indexOf('</div>', metaRowStart);
  const row = toolCallBlock.slice(metaRowStart, rowEnd);
  assert.ok(row.includes('v-if="metaMsg.costUsd != null"'), 'costUsd 伴随展示门控缺失');
  assert.ok(row.includes('metaMsg.durationMs'), 'durationMs 秒级展示缺失');
  assert.ok(row.includes('(exportMode || expanded) && metaMsg.endedAt'), 'endedAt 展示须维持 exportMode||expanded 条件（导出/展开语义不变）');
});
check('F1-5(3) ThinkingBlock 负向钉：组件内零 meta 行渲染分支（不加 meta UI）', () => {
  assert.ok(!thinkingBlock.includes('durationMs'), 'ThinkingBlock 出现 durationMs（规范明文不加 meta UI）');
  assert.ok(!thinkingBlock.includes('endedAt'), 'ThinkingBlock 出现 endedAt（规范明文不加 meta UI）');
  assert.ok(!thinkingBlock.includes('tool-row__meta') && !thinkingBlock.includes('__meta'), 'ThinkingBlock 出现 meta 行类名');
});
check('F1-5(4) 旧 costMsg 引用清零（rename 收口：无残桩）', () => {
  assert.ok(!toolCallBlock.includes('costMsg'), 'ToolCallBlock 仍残留 costMsg 引用（rename 未收口）');
});

console.log('\n=== F1-6 双写链零回归 spawn 门（03b §13 F1-6，三脚本退出码 0） ===');
const spawnGate = (script: string, name: string) => check(name, () => {
  const r = spawnSync('npx', ['tsx', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-6).join('\n');
  assert.equal(r.status, 0, `${script} 退出码 ${r.status}（V12 双写链/呈现层回归门被波及）\n${tail}`);
});
void spawnGate('scripts/tdd-bugfix-b1-turn-meta-persistence-verify.ts', 'F1-6(1) spawn tdd-bugfix-b1-turn-meta-persistence-verify.ts 退出码 0（V12 持久化十钉）');
void spawnGate('scripts/tdd-bugfix-b3-turn-endtime-bubble-verify.ts', 'F1-6(2) spawn tdd-bugfix-b3-turn-endtime-bubble-verify.ts 退出码 0（endedAt 链+气泡脚注钉）');
void spawnGate('scripts/tdd-user-timestamp-below-bubble-verify.ts', 'F1-6(3) spawn tdd-user-timestamp-below-bubble-verify.ts 退出码 0（T5-E assistant 脚注字面回归钉）');

const summary = `\n结果：${pass} 通过 / ${fail} 失败`;
console.log(summary);
process.exit(fail === 0 ? 0 : 1);
