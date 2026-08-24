// tdd-group-sessions-verify.ts
// 会话管理页「项目分组」纯函数契约：projectLabel + groupSessionsByProject。
// 运行：npx tsx scripts/tdd-group-sessions-verify.ts
import { strict as assert } from 'node:assert';
import { projectLabel, groupSessionsByProject } from '../src/renderer/utils/group-sessions';
import type { Session } from '../src/shared/types/session';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

function session(id: string, workingDir: string | null): Session {
  return {
    id,
    name: `会话-${id}`,
    cliSessionId: null,
    model: 'glm-5.2',
    providerOverride: null,
    modelOverride: null,
    workingDir,
    permissionMode: null,
    maxTurns: 10,
    thinkingLevel: null,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    lastContextTokens: null,
    lastContextUpdatedAt: null,
    lastContextWindow: null,
    lastContextUsed: null,
    lastContextUsedCapacity: null,
    lastContextUsedAt: null,
  };
}

check('projectLabel 取末段目录名（正斜杠）', () => {
  assert.equal(projectLabel('/d/software/code/claude-link'), 'claude-link');
});

check('projectLabel 兼容 Windows 反斜杠路径', () => {
  assert.equal(projectLabel('D:\\software\\code\\claude-link'), 'claude-link');
});

check('projectLabel 对只有根斜杠/空段不抛错且回落原文', () => {
  assert.equal(projectLabel('/'), '/');
  assert.equal(projectLabel(''), '');
});

check('按项目分组：同 workingDir 归一组，顺序按首次出现', () => {
  const a1 = session('a1', '/d/p1');
  const b1 = session('b1', '/d/p2');
  const a2 = session('a2', '/d/p1');
  const groups = groupSessionsByProject([a1, b1, a2]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.label), ['p1', 'p2']);
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['a1', 'a2']);
  assert.deepEqual(groups[1].sessions.map((s) => s.id), ['b1']);
});

check('无工作空间的会话归入「未选择工作空间」', () => {
  const n1 = session('n1', null);
  const p1 = session('p1', '/d/p1');
  const n2 = session('n2', null);
  const groups = groupSessionsByProject([n1, p1, n2]);
  assert.equal(groups.length, 2);
  const none = groups.find((g) => g.key === '__none__')!;
  assert.equal(none.label, '未选择工作空间');
  assert.deepEqual(none.sessions.map((s) => s.id), ['n1', 'n2']);
});

check('同路径不同分隔符归一（正斜杠与反斜杠视为同一项目）', () => {
  const a = session('a', 'D:/software/code/claude-link');
  const b = session('b', 'D:\\software\\code\\claude-link');
  const groups = groupSessionsByProject([a, b]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sessions.length, 2);
});

check('空列表返回空数组', () => {
  assert.deepEqual(groupSessionsByProject([]), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
