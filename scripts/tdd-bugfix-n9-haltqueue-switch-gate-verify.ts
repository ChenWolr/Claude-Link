// tdd-bugfix-n9-haltqueue-switch-gate-verify.ts
// N9（P2）契约钉：haltQueue 无队列开关联动闸 + 空队列也弹熔断横幅——
// 开关关闭时普通直发回合失败照样 pauseAllPending（违背「开关关：任务状态不动」承诺），
// halt_failed 横幅不判断任务数（零任务也弹「队列已全部暂停」）。
//
// 修复语义：① haltQueue 入口加 `getConfig().queueEnabled !== true` 即 return（任务状态不动）；
// ② TaskQueuePanel 的 halt_* 横幅渲染加「存在任务」门——零任务落到「待命中」。
//
// 行为验证手法：Module._load 拦截 config-manager/task-repo/chat-backend 等，spy pauseAllPending，
// 驱动真实 beginUserTurn + noteTurnOutcome；横幅门用源码结构契约（渲染层组件无单测约定）。
//
// 运行：npx tsx scripts/tdd-bugfix-n9-haltqueue-switch-gate-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const engineSrc = fs.readFileSync(path.join(repoRoot, 'src/main/modules/task-queue-engine.ts'), 'utf8');
const panelSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/components/task/TaskQueuePanel.vue'), 'utf8');

let spass = 0;
let sfail = 0;
function scheck(name: string, cond: boolean, detail = ''): void {
  if (cond) { spass += 1; console.log(`  ✅ ${name}`); }
  else { sfail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 结构契约 ──
scheck('结构① haltQueue 入口有 queueEnabled !== true 闸', (() => {
  const at = engineSrc.indexOf('export function haltQueue');
  const body = engineSrc.slice(at, engineSrc.indexOf('export function abortHalt', at));
  return /getConfig\(\)\.queueEnabled !== true\)\s*return;/.test(body);
})());
scheck('结构② halt_failed 横幅有「存在任务」门（零任务不弹）', (() => {
  const at = panelSrc.indexOf("case 'halt_failed':");
  return at > -1 && panelSrc.slice(at, at + 260).includes('tasks.length === 0');
})());
scheck('结构③ halt_interrupted 横幅有「存在任务」门（零任务不弹）', (() => {
  const at = panelSrc.indexOf("case 'halt_interrupted':");
  return at > -1 && panelSrc.slice(at, at + 260).includes('tasks.length === 0');
})());

// ── 行为 seam：开关关 = pauseAllPending 不被调；开关开 = 正常熔断 ──
const Module = require('module');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-n9halt-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = tmpUserData;

const configStub: Record<string, unknown> = { queueEnabled: true, taskDelayMinutes: 5 };
const pauseCalls: string[] = [];
const eventLog: string[] = [];
const origLoad = Module._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (req: string, parent: NodeJS.Module | undefined, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  if (/[\\/]config-manager$/.test(req)) return { getConfig: () => configStub };
  if (/[\\/]task-repo$/.test(req)) {
    return {
      pauseAllPending: (sessionId: string) => { pauseCalls.push(sessionId); },
      getPendingTasks: () => [],
      getTask: () => null,
      updateTaskError: () => undefined,
      listTasksBySession: () => [],
    };
  }
  if (/[\\/]session-repo$/.test(req)) return { getSession: () => ({ id: 's' }), updateSessionStatus: () => undefined };
  if (/[\\/]message-repo$/.test(req)) return { createMessage: () => ({ id: 'm' }) };
  if (/[\\/]chat-backend$/.test(req)) {
    return { spawnForTask: () => { throw new Error('not used'); }, resolveCliSessionId: () => null, getActiveProcess: () => undefined };
  }
  if (/[\\/]attachment-prompt-builder$/.test(req)) return { prepareAttachmentPrompt: async () => ({ attachmentIds: [], additionalDirectories: [] }) };
  if (/[\\/]attachment-service$/.test(req)) return { resolveAttachmentRecords: () => ({ records: [], paths: [] }) };
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const engine = require('../src/main/modules/task-queue-engine');
  const win = { webContents: { send: (_ch: string, payload?: { type?: string }) => { eventLog.push(payload?.type ?? ''); } } } as never;

  // 场景 A：开关关 → 直发回合失败不得触发熔断（pauseAllPending 不被调、无 queue_halted）。
  configStub.queueEnabled = false;
  engine.beginUserTurn('sess-n9-off', win);
  engine.noteTurnOutcome('sess-n9-off', 'error', win);
  check('行为① 开关关：回合失败不 pauseAllPending（任务状态不动）',
    pauseCalls.length === 0, `pauseCalls=${JSON.stringify(pauseCalls)}`);
  check('行为② 开关关：不广播 queue_halted',
    !eventLog.includes('queue_halted'), `events=${JSON.stringify(eventLog)}`);

  // 场景 B：开关开 → 熔断照常（回归不伤）。
  configStub.queueEnabled = true;
  engine.beginUserTurn('sess-n9-on', win);
  engine.noteTurnOutcome('sess-n9-on', 'error', win);
  check('行为③ 开关开：回合失败照常 pauseAllPending（熔断语义不变）',
    pauseCalls.includes('sess-n9-on'), `pauseCalls=${JSON.stringify(pauseCalls)}`);

  console.log(`\nverify 结果：结构 ${spass} passed/${sfail} failed，行为 ${pass} passed/${fail} failed`);
  process.exit(sfail + fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
