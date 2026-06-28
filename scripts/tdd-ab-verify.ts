// tdd-ab-verify.ts
// TDD 行为验证：A（工具映射补全）+ B（子 agent 标题扩展）。
// 与 selftest 的「结构契约」（字符串 includes）不同——这里 import 真实函数、断言真实返回值，
// 验证的是行为而非代码文本。运行：npx tsx scripts/tdd-ab-verify.ts
//
// 注：A+B 代码已先于本测试实现，故这里是「回归验证」性质；为证明测试非空过，
// 配合 mutation 验证（临时破坏实现 → 看测试失败 → 改回）。

import { strict as assert } from 'node:assert';
import { getProcessKindMeta, summarizeToolUse } from '../src/renderer/utils/process-kind';
import { extractSubAgentTitle } from '../src/shared/process-kind';
import type { CliMessageContentPart } from '../src/shared/types/cli';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

const tu = (name: string, input: Record<string, unknown>): CliMessageContentPart =>
  ({ type: 'tool_use', name, input }) as CliMessageContentPart;

console.log('\n=== A：工具映射补全（getProcessKindMeta / summarizeToolUse）===');
check('Workflow → 🧩工作流', () => {
  const m = getProcessKindMeta('tool:Workflow');
  assert.equal(m.icon, '🧩');
  assert.equal(m.label, '工作流');
});
check('AskUserQuestion → ❓提问', () => {
  const m = getProcessKindMeta('tool:AskUserQuestion');
  assert.equal(m.icon, '❓');
  assert.equal(m.label, '提问');
});
check('EnterPlanMode → 📋进入计划', () => {
  assert.equal(getProcessKindMeta('tool:EnterPlanMode').label, '进入计划');
});
check('TaskStop → 📋停止任务', () => {
  assert.equal(getProcessKindMeta('tool:TaskStop').label, '停止任务');
});
check('PowerShell → ⌨️执行命令', () => {
  const m = getProcessKindMeta('tool:PowerShell');
  assert.equal(m.icon, '⌨️');
  assert.equal(m.label, '执行命令');
});
check('MultiEdit 死映射已清 → ⚙️+原名兜底（不再是 ✏️编辑）', () => {
  const m = getProcessKindMeta('tool:MultiEdit');
  assert.equal(m.icon, '⚙️');
  assert.equal(m.label, 'MultiEdit');
});
check('原有工具不退化（Bash/Skill/Agent）', () => {
  assert.equal(getProcessKindMeta('tool:Bash').label, '执行命令');
  assert.equal(getProcessKindMeta('tool:Skill').icon, '✨');
  assert.equal(getProcessKindMeta('tool:Agent').label, '子Agent');
});
check('summarizeToolUse PowerShell 取 command 首行', () => {
  assert.equal(
    summarizeToolUse(JSON.stringify({ name: 'PowerShell', input: { command: 'Get-Process\nSelect-Object' } })),
    'Get-Process',
  );
});
check('summarizeToolUse MultiEdit 不再有摘要 → 空串', () => {
  assert.equal(summarizeToolUse(JSON.stringify({ name: 'MultiEdit', input: { file_path: 'a.ts' } })), '');
});

console.log('\n=== B：子 agent 标题扩展（extractSubAgentTitle）===');
check('Agent → input.description', () => {
  assert.equal(extractSubAgentTitle(tu('Agent', { description: '研究 X' })), '研究 X');
});
check('Task → input.description（别名）', () => {
  assert.equal(extractSubAgentTitle(tu('Task', { description: '研究 Y' })), '研究 Y');
});
check('Skill → input.name', () => {
  assert.equal(extractSubAgentTitle(tu('Skill', { name: 'code-review' })), 'code-review');
});
check('Workflow → input.description 优先', () => {
  assert.equal(extractSubAgentTitle(tu('Workflow', { description: '迁移脚本' })), '迁移脚本');
});
check('Workflow → 无 description 时 fallback input.name', () => {
  assert.equal(extractSubAgentTitle(tu('Workflow', { name: 'wf-1' })), 'wf-1');
});
check('非子 agent 工具（Bash）→ null', () => {
  assert.equal(extractSubAgentTitle(tu('Bash', { command: 'ls' })), null);
});
check('空/空白 description → null', () => {
  assert.equal(extractSubAgentTitle(tu('Agent', { description: '   ' })), null);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
