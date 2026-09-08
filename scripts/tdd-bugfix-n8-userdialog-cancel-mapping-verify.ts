// tdd-bugfix-n8-userdialog-cancel-mapping-verify.ts
// N8（P2）契约钉：onUserDialog 路径选择题「取消」恒报 completed——
// `result ? completed : cancelled` 对恒非空的 AskUserQuestionOutcome 求值永真，SDK 收到
// 「已完成 + {kind:'cancel'} 杂质对象」；P2-7 只修了 canUseTool 路径（同族漏修分支）。
//
// 修复语义：按 result.kind 分映——answered→{behavior:'completed', result:<输出>}；
// cancel→{behavior:'cancelled'}（文案语义与 P2-7 mapAskUserQuestionCancel 同源：
// 用户/系统取消都不得把 cancel 杂质对象伪装成已完成结果）。
//
// 验证手法：Module._load 拦截 interaction-prompts 注入 canned response，驱动真实
// createUserDialogHandler，断言 cancel/answered 两种响应的 SDK 返回形态。
//
// 运行：npx tsx scripts/tdd-bugfix-n8-userdialog-cancel-mapping-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
process.env.CLAUDE_LINK_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-n8dlg-ud-'));

let cannedResponse: Record<string, unknown> = { action: 'cancel', reason: 'user' };
const Module = require('module');
const origLoad = Module._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (req: string, parent: NodeJS.Module | undefined, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  if (/[\\/]interaction-prompts$/.test(req)) {
    return {
      requestInteraction: async () => cannedResponse,
      cancelAllPendingInteractions: () => undefined,
      getPendingInteractions: () => [],
    };
  }
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

const questions = [{
  question: '选择部署目标？',
  header: 'Deploy',
  options: [{ label: 'staging', description: '测试环境' }, { label: 'prod', description: '生产' }],
  multiSelect: false,
}];

(async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createUserDialogHandler } = require('../src/main/modules/sdk-interactions');
  const win = { webContents: { send: () => undefined }, isDestroyed: () => false };
  const handler = createUserDialogHandler('sess-n8', win as never);
  const request = { dialogKind: 'question', payload: { questions }, toolUseID: 'tool-1' };
  const options = { signal: new AbortController().signal };

  // ① 用户取消 → SDK 必须收到 {behavior:'cancelled'}，不得是 completed+cancel 杂质对象。
  cannedResponse = { action: 'cancel', reason: 'user' };
  const cancelled = await handler(request as never, options as never);
  check('① 取消响应 → behavior=cancelled（不再恒 completed）', () => {
    assert.equal(cancelled.behavior, 'cancelled', JSON.stringify(cancelled));
    assert.equal((cancelled as { result?: unknown }).result, undefined, '不得携带 cancel 杂质对象');
  });

  // ② 正常回答 → completed 且 result 是输出本体（不含 kind 包装）。
  cannedResponse = {
    action: 'submit',
    values: { 'Deploy': 'staging' },
  };
  const answered = await handler(request as never, options as never);
  check('② 回答响应 → completed 且 result 为输出本体（无 kind 包装）', () => {
    assert.equal(answered.behavior, 'completed', JSON.stringify(answered));
    const result = (answered as { result?: Record<string, unknown> }).result;
    assert.ok(result && typeof result === 'object');
    assert.equal((result as { kind?: unknown }).kind, undefined, 'result 不得携带 Outcome 包装字段');
  });

  // ③ 系统取消（abort）同样 → cancelled（中性语义，不指控用户）。
  cannedResponse = { action: 'cancel', reason: 'abort' };
  const aborted = await handler(request as never, options as never);
  check('③ 系统取消（abort）→ cancelled', () => {
    assert.equal(aborted.behavior, 'cancelled', JSON.stringify(aborted));
  });

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
