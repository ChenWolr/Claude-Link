// tdd-bugfix-p2-10-background-context-backfill-verify.ts
// P2-10 契约钉：后台会话探针 fresh 数据被 renderer 丢弃 → 切回后圆环显旧值/待刷新。
//
// 修复语义：bindContextUpdates 把代际门提前到 activeSession 判定之前；门内先回填 sessions
// 列表对象的 lastContextUsed/lastContextUsedCapacity/lastContextUsedAt（与 DB repo/
// buildPersistedCanonical 消费端同字段名），再按 activeSession 匹配决定是否更新 canonical。
// turn-usage-only payload（used=null）不回填（红线：turn usage 永不驱动圆环）。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-10-background-context-backfill-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

// 无头 renderer 环境 stub。
let contextUpdateCb: ((payload: Record<string, unknown>) => void) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).window = {
  claudeLink: {
    analyzeTopic: async () => null,
    getSessionMessages: async () => [],
    onContextUpdate: (cb: (payload: Record<string, unknown>) => void) => {
      contextUpdateCb = cb;
      return () => { contextUpdateCb = null; };
    },
  },
};
const { createPinia, setActivePinia } = require('pinia');
setActivePinia(createPinia());
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useSessionStore } = require('../src/renderer/stores/session-store');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const store = useSessionStore();
// 驻留会话 A；后台会话 B 在列表中（旧值 100）。
store.activeSession = { id: 'sess-A', name: 'A' } as never;
store.sessions = [
  { id: 'sess-A', name: 'A', lastContextUsed: 10, lastContextUsedCapacity: 1000, lastContextUsedAt: 1 },
  { id: 'sess-B', name: 'B', lastContextUsed: 100, lastContextUsedCapacity: 1000, lastContextUsedAt: 1 },
] as never;
store.bindContextUpdates();

function payloadOf(sessionId: string, used: number | null, extra: Record<string, unknown> = {}) {
  return {
    sessionId,
    queryGeneration: Date.now(),
    currentContextUsedTokens: used,
    contextWindowCapacityTokens: 200000,
    currentContextUsedPercent: used == null ? null : 5,
    currentContextRemainingTokens: null,
    currentContextRemainingPercent: null,
    windowSize: 200000,
    refreshedAt: 1234567890,
    samplePhase: 'post-turn',
    freshness: 'fresh',
    source: 'runtime-live',
    consistency: 'unavailable',
    inputTokens: 0, outputTokens: 0,
    turnInputTokens: null, turnCacheReadTokens: null, turnCacheCreationTokens: null, turnOutputTokens: null,
    diagnostic: null,
    ...extra,
  };
}

// 后台会话 B 的探针 fresh payload。
contextUpdateCb?.(payloadOf('sess-B', 30000));
const b = store.sessions.find((s: { id: string }) => s.id === 'sess-B') as { lastContextUsed: number | null; lastContextUsedCapacity: number | null; lastContextUsedAt: number | null };
check('① 后台会话 fresh 数据回填列表 lastContextUsed', b.lastContextUsed === 30000, String(b.lastContextUsed));
check('② 回填容量与时间戳', b.lastContextUsedCapacity === 200000 && b.lastContextUsedAt === 1234567890);

// turn-usage-only payload（used=null）不回填。
contextUpdateCb?.(payloadOf('sess-B', null));
check('③ turn-usage-only 不回填（红线保持）', (store.sessions.find((s: { id: string }) => s.id === 'sess-B') as { lastContextUsed: number }).lastContextUsed === 30000);

// 旧代际 payload 被代际门拒收（门内回填，不过门不回填）。
contextUpdateCb?.(payloadOf('sess-B', 1, { queryGeneration: 1 }));
check('④ 旧代际 payload 不回填（代际门内执行）', (store.sessions.find((s: { id: string }) => s.id === 'sess-B') as { lastContextUsed: number }).lastContextUsed === 30000);

// 活动会话路径不回归：canonical 更新照常。
contextUpdateCb?.(payloadOf('sess-A', 42000));
check('⑤ 活动会话 canonical 照常更新（不回归）',
  store.canonicalContext?.currentContextUsedTokens === 42000, JSON.stringify(store.canonicalContext));
check('⑥ 活动会话列表对象同样回填', (store.sessions.find((s: { id: string }) => s.id === 'sess-A') as { lastContextUsed: number }).lastContextUsed === 42000);

// 结构：回填字段名与消费端一致。
const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/renderer/stores/session-store.ts'), 'utf8');
check('⑦ 回填写 lastContextUsed/Capacity/At 三字段', /listItem\.lastContextUsed = payload\.currentContextUsedTokens;/.test(src) &&
  /listItem\.lastContextUsedCapacity = payload\.contextWindowCapacityTokens/.test(src) &&
  /listItem\.lastContextUsedAt = payload\.refreshedAt/.test(src));
check('⑧ 代际门在 activeSession 判定之前', src.indexOf('shouldAcceptContextPayload(this.contextQueryGenerations') < src.indexOf("if (this.activeSession?.id !== payload.sessionId) return;", src.indexOf('bindContextUpdates()')));

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
