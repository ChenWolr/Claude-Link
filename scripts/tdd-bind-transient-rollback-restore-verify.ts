// scripts/tdd-bind-transient-rollback-restore-verify.ts
// B8（D08-F2，复核 PARTIAL 修正口径）：bindTransientAttachmentsToSession 失败回滚恢复暂态
// 登记 Map——物化部分失败（第 k 个 createAttachment 抛错）后，已回滚删行 + 失败位的附件
// 必须回到暂态 Map（未转正的回 Map），不在 Map 的 id（DB 已转正 / 用户已移除 / 归属守卫
// 跳过）保持原状；重试物化可完整绑定，发送侧 assertAttachmentsReadyForSend →
// getAttachmentsByIdsForSession 对缺行抛「部分附件不存在或不属于当前会话」不再被阻断。
// 行为级复放：vm 沙箱抽取 bindTransientAttachmentsToSession + bindOne，桩替
// attachmentRepo.createAttachment（指定 id 抛 SQLITE_FULL）/ deleteAttachment。
//
// 运行：npx tsx scripts/tdd-bind-transient-rollback-restore-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';

const repoRoot = path.resolve(__dirname, '..');
const svc = fs.readFileSync(path.join(repoRoot, 'src/main/modules/attachment-service.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

/** 抽取 bindTransientAttachmentsToSession + bindOne 转译为可执行 JS（锚点缺失即契约失败）。 */
function extractBindJs(): string {
  const start = svc.indexOf('export function bindTransientAttachmentsToSession');
  const end = svc.indexOf('export function resolveAttachmentRecords');
  assert.ok(start > -1, 'attachment-service 缺 bindTransientAttachmentsToSession 锚');
  assert.ok(end > start, 'attachment-service 缺 resolveAttachmentRecords 尾锚（抽取窗口漂移）');
  const js = ts.transpileModule(svc.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return js
    .split('\n')
    .filter((line) => !line.startsWith('exports.'))
    .join('\n');
}

/** 最小 AttachmentRecord 形态（沙箱内仅按字段透传，无运行时校验）。 */
function rec(id: string, sessionId: string): Record<string, unknown> {
  return {
    id,
    sessionId,
    kind: 'file',
    filename: `${id}.txt`,
    mimeType: 'text/plain',
    sizeBytes: 3,
    previewAvailable: true,
    status: 'draft',
    sha256: `sha-${id}`,
    storageKey: `${sessionId}/${id}/${id}.txt`,
  };
}

/**
 * 沙箱装配：transientAttachments Map + attachmentRepo 桩（createAttachment 对
 * state.failCreateFor 指定 id 抛错、其余建行入 rows；deleteAttachment 删行并记账）。
 * 返回 state（failCreateFor 可在重试前置 null 模拟瞬态 DB 故障恢复）。
 */
function buildSandbox(
  seed: Array<Record<string, unknown>>,
  existingRows: Array<Record<string, unknown>>,
  failCreateFor: string | null,
): { transientAttachments: Map<string, unknown>; rows: Map<string, unknown>; deleted: string[]; failCreateFor: string | null; bind: (sessionId: string, ids: string[]) => void } {
  const state = {
    transientAttachments: new Map(seed.map((r) => [r.id as string, r])),
    rows: new Map(existingRows.map((r) => [r.id as string, r])),
    deleted: [] as string[],
    failCreateFor,
  };
  const attachmentRepo = {
    createAttachment(input: { id: string }) {
      if (state.failCreateFor && input.id === state.failCreateFor) {
        throw new Error(`SQLITE_FULL: 模拟物化建行失败（${input.id}）`);
      }
      state.rows.set(input.id, input);
      return input;
    },
    deleteAttachment(id: string) {
      state.rows.delete(id);
      state.deleted.push(id);
    },
  };
  const factory = vm.runInNewContext(
    // const exports 桩：CJS 转译尾部会对 exports 挂载（emit 形态随 TS 版本可变），桩掉即免逐行剥离。
    `(function (transientAttachments, attachmentRepo) {\nconst exports = {};\n${extractBindJs()}\nreturn bindTransientAttachmentsToSession;\n})`,
    vm.createContext({}),
  ) as (m: Map<string, unknown>, r: unknown) => (sessionId: string, ids: string[]) => void;
  state.bind = factory(state.transientAttachments, attachmentRepo);
  return state as typeof state & { bind: (sessionId: string, ids: string[]) => void };
}

// ① 行为级：物化第 2 个建行抛错 → 回滚删已建行 + 未转正的全部回暂态 Map（含失败位）。
check('① 物化部分失败：已建行回滚删除 + 未转正的（成功位/失败位/未处理位）全回暂态 Map，仍重抛', () => {
  // A=将成功建行、B=建行抛错位、C=未处理位；D=归属其他会话（守卫跳过）；X=DB 已转正行（不在 Map）。
  const sb = buildSandbox(
    [rec('A', 'S'), rec('B', 'S'), rec('C', 'S'), rec('D', 'OTHER')],
    [rec('X', 'S')],
    'B',
  );
  assert.throws(() => sb.bind('S', ['A', 'B', 'C', 'X', 'D']), /SQLITE_FULL/, '物化失败必须重抛（hb10-ATT-V01）');
  assert.ok(!sb.rows.has('A'), 'A 已建行应被回滚删除');
  assert.deepEqual(sb.deleted, ['A'], '回滚只删已建行（X 不得误删）');
  for (const id of ['A', 'B', 'C']) {
    assert.ok(sb.transientAttachments.has(id), `未转正的 ${id} 应回暂态 Map（失联=死卡）`);
  }
  // 边界：归属守卫跳过的 D 留在 Map；DB 已转正的 X 不进 Map 且行保留。
  assert.ok(sb.transientAttachments.has('D'), '归属守卫跳过的 D 应留在 Map');
  assert.ok(!sb.transientAttachments.has('X'), 'DB 已转正的 X 不得被塞回暂态 Map');
  assert.ok(sb.rows.has('X'), 'DB 已转正的 X 行应保留（不在 boundIds，不受回滚影响）');
});

// ② 行为级：重试物化完整绑定 → 发送校验（缺行即抛「部分附件不存在」）不再被阻断。
check('② 重试物化可成功：全部 id 完整建行，发送侧不再被「部分附件不存在」阻断', () => {
  const sb = buildSandbox([rec('A', 'S'), rec('B', 'S'), rec('C', 'S')], [], 'B');
  assert.throws(() => sb.bind('S', ['A', 'B', 'C']), /SQLITE_FULL/);
  sb.failCreateFor = null; // 瞬态 DB 故障恢复后用户重试发送（session-store 重带全部草稿 id）。
  sb.bind('S', ['A', 'B', 'C']); // 重试物化不抛。
  assert.equal(sb.transientAttachments.size, 0, '重试后暂态 Map 应清空');
  for (const id of ['A', 'B', 'C']) {
    assert.ok(sb.rows.has(id), `重试后 ${id} 缺 DB 行（getAttachmentsByIdsForSession 将抛「部分附件不存在或不属于当前会话」阻断发送）`);
  }
});

// ③ 结构钉：回滚路径恢复暂态 Map 的字面形态（行为抽取锚漂移时的第二道网）。
check('③ 结构钉：回滚放回 transientAttachments.set + bindOne 弹出前留底', () => {
  const start = svc.indexOf('export function bindTransientAttachmentsToSession');
  const body = svc.slice(start, svc.indexOf('function bindOne', start));
  assert.match(body, /transientAttachments\.set\(record\.id, record\)/, '回滚缺 Map 恢复（D08-F2 半态缺口本体）');
  assert.match(body, /throw err;/, '回滚恢复后须重抛（hb10-ATT-V01 语义不变）');
  const bindOneBody = svc.slice(svc.indexOf('function bindOne', start), svc.indexOf('export function resolveAttachmentRecords', start));
  assert.match(bindOneBody, /consumedRecords\.push\(record\)/, 'bindOne 缺弹出前留底（失败位记录无法回 Map）');
  const pushIdx = bindOneBody.indexOf('consumedRecords.push(record)');
  const delIdx = bindOneBody.indexOf('transientAttachments.delete(id)');
  assert.ok(pushIdx > -1 && delIdx > pushIdx, '留底必须先于弹出（createAttachment 抛错时记录已捕获）');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
