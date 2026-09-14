// scripts/tdd-bugfix-hb10-context-p3-verify.ts
// hb10 P3 CTX 批契约（CTX-01/02/03收窄/05/06/07/08/10/V02；CTX-04 竞态窗被 hb12 附录A推翻不实施；CTX-09 随 P2 观测面留档）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-context-p3-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lookupUserContextWindow } from '../src/shared/model-context-windows';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const backend = read('src/main/modules/sdk-backend.ts');
const sessionStore = read('src/renderer/stores/session-store.ts');
const ctxBtn = read('src/renderer/components/chat/ContextButton.vue');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① CTX-01：探针窗口注入（单源函数 + 探针侧补注入）。
check('① CTX-01：computeContextWindowOverrideTokens 单源 + 探针 env 补注入', () => {
  assert.match(backend, /function computeContextWindowOverrideTokens\(/, '缺共享函数');
  assert.match(backend, /env\.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String\(probeWindow\);/, '探针侧缺注入');
  assert.match(backend, /hb10-CTX-01：探针窗口与生产一致/, '探针注入缺标注');
});

// ② CTX-02：分母单源。
check('② CTX-02：contextStats 分母改 resolveContextWindowForSession（模型 ID 会话反查）', () => {
  const idx = sessionStore.indexOf('contextStats(state)');
  const body = sessionStore.slice(idx, idx + 1200);
  assert.match(body, /resolveContextWindowForSession\(/, 'getter 缺单源函数');
  assert.match(body, /advancedJson: useConfigStore\(\)\.config\.advancedJson/, '缺 advancedJson 入参');
});

// ③ CTX-03 收窄。
check('③ CTX-03：/clear 回合跳过探针调度（isLocalCommandTurn 守卫）', () => {
  assert.match(backend, /function isLocalCommandTurn\(initCommandText: string\): boolean \{/, '缺判定函数');
  assert.match(backend, /if \(!isLocalCommandTurn\(initCommandText\)\) \{[\s\S]{0,120}schedulePostTurnProbe/, '调度缺守卫');
});

// ④ CTX-05/06：pct 现算 + m 档。
check('④ CTX-05/06：pct used/windowSize 现算派生 + fmt m 档', () => {
  const pctIdx = ctxBtn.indexOf('const pct = computed(');
  const pctBody = ctxBtn.slice(pctIdx, pctIdx + 700);
  assert.match(pctBody, /used \/ win\) \* 100/, '缺现算派生');
  assert.match(ctxBtn, /1_000_000\)\.toFixed\(1\)\}m/, '缺 m 档');
});

// ⑤ CTX-07/08：顺序 + 只增不减。
check('⑤ CTX-07/08：协议校验先于列表回填；回填窗口只增不减', () => {
  const gateIdx = sessionStore.indexOf('if (!hasCompleteCanonicalFields(payload)) return;');
  const fillIdx = sessionStore.indexOf('listItem.lastContextUsed = payload.currentContextUsedTokens;');
  const activeIdx = sessionStore.indexOf('if (this.activeSession?.id !== payload.sessionId) return;', gateIdx);
  assert.ok(gateIdx > -1 && fillIdx > gateIdx, '校验未先于回填');
  assert.ok(activeIdx > fillIdx, '回填被挪到 activeSession 判定之后（P2-10 后台回填被破坏）');
  assert.match(sessionStore, /Math\.max\(prevRealWindow, liveWindow\)/, '缺只增不减钳制');
  assert.match(sessionStore, /payload\.source !== 'estimated-turn-usage'/, 'estimated payload 未排除（hb12-CTX-02 收紧）');
});

// ⑥ CTX-10：resume 重试重置压缩标记。
check('⑥ CTX-10：resume 重试二次起步重置 turnHadCompactSuccess/postCompactionFreshSent', () => {
  const idx = backend.indexOf('clearReasoningReplayTurnFlag(sessionId);\r\n        // hb10-CTX-10');
  if (idx < 0) {
    // LF 兜底
    const alt = backend.indexOf('clearReasoningReplayTurnFlag(sessionId);\n        // hb10-CTX-10');
    assert.ok(alt > -1, 'CTX-10 重置未接在 resume 重试起步序列');
  }
  assert.match(backend, /turnHadCompactSuccess = false;[\s\S]{0,120}postCompactionFreshSent = false;/, '缺双标记重置');
});

// ⑦ CTX-V02：预填诚实标注。
check('⑦ CTX-V02：buildPersistedCanonical 预填 source 改 unavailable', () => {
  const idx = sessionStore.indexOf('function buildPersistedCanonical');
  const body = sessionStore.slice(idx, idx + 1400);
  assert.match(body, /source: 'unavailable',/, '预填 source 非 unavailable');
  assert.doesNotMatch(body, /source: 'native-context'/, '预填仍伪装 native-context');
});

// ⑪ hb13-v B7（F-1）：分母优先级恢复「用户 contextWindowByAlias 覆盖 > contextLastWindow > 默认」。
check('⑪ B7/F-1：用户 1M 覆盖不被 SDK 200k 上报短路（纯函数行为 + getter 接线顺序）', () => {
  // 行为级（真实共享纯函数）：用户按别名显式覆盖（含 advancedJson 反查路径）必须命中。
  assert.equal(
    lookupUserContextWindow({ aliasOrModel: 'sonnet', advancedJson: '', contextWindowByAlias: { sonnet: 1_000_000 } }),
    1_000_000,
    'lookupUserContextWindow 未命中显式覆盖',
  );
  assert.equal(
    lookupUserContextWindow({ aliasOrModel: 'sonnet', advancedJson: '', contextWindowByAlias: {} }),
    undefined,
    '未配置时必须返回 undefined（不得伪造成覆盖）',
  );
  // getter 接线：组合顺序 userOverride ?? contextLastWindow ?? resolve——拒绝 contextLastWindow
  // 提到 ?? 左侧的优先级反转形态（hb12-CTX-01 实施引入的回归）。
  const idx = sessionStore.indexOf('contextStats(state)');
  const body = sessionStore.slice(idx, idx + 1800);
  assert.match(body, /userOverride \?\? state\.contextLastWindow \?\? resolveContextWindowForSession\(/, '分母组合顺序不符（F-1 反转形态残留）');
  assert.match(body, /lookupUserContextWindow\(/, 'getter 缺用户覆盖探测');
});

// ⑫ hb13-v B7（F-2）：estimated turn-usage 窗口「只增不减」主进程面（下发+落库同值）。
check('⑫ B7/F-2：estimated 路径缺 realWindow 时兜底值不得缩水 DB 已持久化真实窗口', () => {
  const guardIdx = backend.indexOf('// hb13-v B7（F-2 / hb10-CTX-08 主进程面）');
  assert.ok(guardIdx > -1, '缺主进程只增不减守卫');
  const seg = backend.slice(guardIdx, guardIdx + 3600);
  assert.match(seg, /if \(!realWindow\) \{/, '缺 !realWindow 条件（realWindow 存在须允许缩小=精确化）');
  assert.match(seg, /lastContextWindow/, '守卫未比对 DB 已持久化真实窗口');
  assert.match(seg, /windowSize = persisted;/, '兜底值未抬升到已持久化真实窗口');
  assert.match(seg, /updateLastContextWindow\(sessionId, windowSize\)/, '落库未使用只增不减后的 windowSize');
  assert.match(seg, /windowSize,\s*\n\s*model: null,/, '下发 payload 未使用只增不减后的 windowSize');
});

// ⑬ hb13-v B7（F-3）：派生方向矫正——used+windowSize 可信即现算占比，payload percent 仅缺 used 兜底。
check('⑬ B7/F-3：pct 现算为主分支、payload percent 降为兜底（hb12-CTX-01 计划方向）', () => {
  const pctIdx = ctxBtn.indexOf('const pct = computed(');
  const pctBody = ctxBtn.slice(pctIdx, pctIdx + 800);
  const usedIdx = pctBody.indexOf('const used = stats');
  const pIdx = pctBody.indexOf('const p = stats');
  assert.ok(usedIdx > -1, 'pct 缺 used 现算分支');
  assert.ok(pIdx > usedIdx, '派生方向仍为「payload percent 优先」（hb12-CTX-01 实施与计划相反，F-3）');
  assert.match(pctBody, /used \/ win\) \* 100/, '缺现算派生');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
