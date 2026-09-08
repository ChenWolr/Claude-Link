// tdd-bugfix-opt2-window-fallback-verify.ts
// OPT-2 补口（审计「设计缺陷：不绝对等价」）：result 去重窄查询 getRecentMessagesForTurnCheck
// 只取尾部 50 条——重工具回合尾部 >50 条 assistant/tool 消息时 user 边界出窗，「遇 user 即停」
// 的回合窗口语义被破坏 → 谓词假阴性 → result 重复落库（重启后双气泡）。
//
// 修复语义：窗口打满（返回条数=limit）且窗内未见 user 时，回落全量 getMessagesBySession 一次
//（一次性的慢路径兜底；窗口内已见 user 或窗口未满则不变）。
//
// 运行：npx tsx scripts/tdd-bugfix-opt2-window-fallback-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const cliSharedSrc = fs.readFileSync(path.join(repoRoot, 'src/main/modules/cli-shared.ts'), 'utf8');

process.env.CLAUDE_LINK_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-opt2fb-ud-'));

// fake history：新→旧数组（index 0 = 最新）。
let history: Array<Record<string, unknown>> = [];
let createdCount = 0;
const Module = require('module');
const origLoad = Module._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (req: string, parent: NodeJS.Module | undefined, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  if (/[\\/]message-repo$/.test(req)) {
    return {
      getRecentMessagesForTurnCheck: (_sessionId: string, limit = 50) => history.slice(0, limit),
      getMessagesBySession: () => history,
      createMessage: (input: Record<string, unknown>) => { createdCount += 1; return { id: `m-${createdCount}`, ...input }; },
    };
  }
  if (/[\\/]session-repo$/.test(req)) return { updateCliSessionId: () => undefined, getSession: () => ({ id: 's' }) };
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

(async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { persistCliEvent } = require('../src/main/modules/cli-shared');

  // 夹具：尾部 50 条全是 tool 消息（本回合重工具段），第 51 条是本回合早前的 assistant
  // 正文（已落库），第 52 条才是 user 边界——窄窗口内无 user、无主流程正文。
  const toolMsg = { id: 't', role: 'tool', content: 'tool', eventType: 'tool', parentAgentId: null as string | null, processKind: null as string | null };
  history = [
    ...Array.from({ length: 50 }, (_, i) => ({ ...toolMsg, id: `tool-${i}` })),
    { id: 'a-main', role: 'assistant', content: '本回合已落库正文', eventType: 'message', parentAgentId: null, processKind: null },
    { id: 'u1', role: 'user', content: '问一句', eventType: 'message', parentAgentId: null, processKind: null },
  ];
  createdCount = 0;
  persistCliEvent('sess-opt2', { type: 'result', subtype: 'success', is_error: false, result: '本回合已落库正文' } as never);
  check('行为① 窗口打满未见 user → 回落全量：早前正文被识别，result 不重复落库', () => {
    assert.equal(createdCount, 0, `createdCount=${createdCount}（若=1 则窄窗口假阴性导致重复落库）`);
  });

  // 回归：窗口内已见 user（本回合无正文）→ 不回落、正常放行落库。
  history = [
    { id: 'u2', role: 'user', content: '第二问', eventType: 'message', parentAgentId: null, processKind: null },
  ];
  createdCount = 0;
  persistCliEvent('sess-opt2', { type: 'result', subtype: 'success', is_error: false, result: '全新回答' } as never);
  check('行为② 正常链路不回退：窗口内遇 user 即停，无正文 → result 落库', () => {
    assert.equal(createdCount, 1, `createdCount=${createdCount}`);
  });

  // 结构：两谓词共用「窗口打满未见 user 回落全量」的兜底。
  check('结构③ 两谓词的窄查询窗口有打满回落兜底', () => {
    assert.match(cliSharedSrc, /getMessagesBySession\(sessionId\)/);
    assert.match(cliSharedSrc, /rows\.length === TURN_CHECK_WINDOW/);
  });

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
