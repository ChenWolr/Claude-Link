// scripts/tdd-bugfix-hb13-v-tm-narrow-verify.ts
// hb13-v A11【回合元数据】契约：hb12-TM-01/TM-02 补实施 + created_at 列三钉。
//
// 病根（docs/audit/2026-09-13-uncommitted-verify-turn-meta.md F-1/F-2/F-3）：
//   F-1/P2 getRecentMessagesForTurnCheck SELECT 缺 created_at → 窄窗主路径
//   Date.parse(undefined)=NaN → 10min 时间下界恒被跳过；
//   F-2/P2 回落触发谓词未补 parentAgentId == null 口径，且 b1 契约 :89 钉死旧形态、
//   hb12-p3 ⑬ 名实不符（只断言无关的 getKnownTurnOutcome）；
//   F-3/P2 回落仍走 getMessagesBySession（SELECT * + 附件 JOIN 全量物化），未改窄列无 LIMIT。
//
// 运行：npx tsx scripts/tdd-bugfix-hb13-v-tm-narrow-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const messageRepo = fs.readFileSync(path.join(repoRoot, 'src/main/database/repositories/message-repo.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① 窄窗 SELECT 含 created_at（时间下界在主路径真实生效）。
check('① 窄窗 SELECT 含 created_at 列', () => {
  const idx = messageRepo.indexOf('export function getRecentMessagesForTurnCheck');
  const body = messageRepo.slice(idx, messageRepo.indexOf('\n}', idx));
  assert.match(body, /SELECT id, session_id, role, content, event_type, process_kind, parent_agent_id, created_at/, '窄窗 SELECT 缺 created_at');
});

// ② 回落触发谓词含 parentAgentId == null（与 walk 口径对齐）。
check('② 回落触发谓词 parentAgentId == null 口径（hb12-TM-01）', () => {
  const idx = messageRepo.indexOf('export function findLastTurnMainFlowAssistantId');
  const body = messageRepo.slice(idx, messageRepo.indexOf('\n}', idx));
  assert.match(body, /rows\.length === 50 && !rows\.some\(\(m\) => m\.role === 'user' && m\.parentAgentId == null\)/, '回落谓词缺 parentAgentId == null');
  assert.ok(!/getMessagesBySession\(/.test(body), '回落仍调用 getMessagesBySession（F-3 缺陷形态残留）');
});

// ③ 回落走窄列无 LIMIT 查询（含 created_at、DESC 与窄窗同序、无附件 JOIN）。
check('③ 回落 getTurnCheckRowsAll：窄列 + 无 LIMIT + DESC + created_at（hb12-TM-02）', () => {
  const idx = messageRepo.indexOf('export function getTurnCheckRowsAll');
  assert.ok(idx > -1, '缺 getTurnCheckRowsAll 导出');
  const body = messageRepo.slice(idx, messageRepo.indexOf('\n}', idx));
  assert.match(body, /SELECT id, session_id, role, content, event_type, process_kind, parent_agent_id, created_at/, '回落 SELECT 缺 created_at 或列集不符');
  assert.match(body, /ORDER BY created_at DESC, rowid DESC(?!\s*LIMIT)/, '回落排序须 DESC 且不带 LIMIT');
  assert.ok(!/LIMIT/.test(body), '回落查询不得带 LIMIT');
  assert.ok(!/fillMessageAttachments/.test(body), '回落不得填附件');
  assert.match(messageRepo, /rows = getTurnCheckRowsAll\(sessionId\);/, 'findLastTurnMainFlowAssistantId 未换用回落窄列查询');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
