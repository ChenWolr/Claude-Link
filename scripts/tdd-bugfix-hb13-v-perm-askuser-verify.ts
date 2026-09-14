// scripts/tdd-bugfix-hb13-v-perm-askuser-verify.ts
// hb13-v A7【权限】契约（行为级）：AskUserQuestion 修复分支可达性验证。
//
// 病根（docs/audit/2026-09-13-uncommitted-verify-perm-interact.md F1，tsx 探针实证）：
//   mapPermissionInteractionResponse 守卫 isAskUserQuestionPayload(payload) 检查 payload 顶层
//   questions 键，但唯一生产来源 buildAskUserQuestionInteractionPayload 无该键（题目在
//   input.question）→ 判据恒 false、修复分支不可达 → MCP questions 形态作答被映射
//   deny「工具调用已取消」。
// 修法：题目提取 askQuestionsFromInteractionPayload 与生产载荷真实形状一致（单题
// input.question / 向导 input.questions），isAskUserQuestionPayload 降为题目形状校验。
//
// 运行：npx tsx scripts/tdd-bugfix-hb13-v-perm-askuser-verify.ts

import { strict as assert } from 'node:assert';
import {
  buildAskUserQuestionInteractionPayload,
  buildWizardAskUserQuestionPayload,
  buildPermissionInteractionPayload,
  isAskUserQuestionPayload,
  mapPermissionInteractionResponse,
} from '../src/main/modules/sdk-interactions';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

const QUESTION = { question: '选择部署环境？', header: 'Env', options: [{ label: 'Staging' }, { label: 'Production' }] };

// ① 生产载荷形状锚：build 产物无顶层 questions 键（isAskUserQuestionPayload 对其恒 false）。
check('① 生产形状：buildAskUserQuestionInteractionPayload 产物无顶层 questions 键', () => {
  const payload = buildAskUserQuestionInteractionPayload('s1', QUESTION, 0, 'tid', 'rid');
  assert.ok(!('questions' in payload), '载荷出现顶层 questions 键（形状锚失真）');
  assert.equal(isAskUserQuestionPayload(payload as unknown as Record<string, unknown>), false, '顶层判据应对生产载荷为 false');
  assert.equal(payload.toolName, 'AskUserQuestion', 'toolName 锚失真');
});

// ② 行为级：MCP questions 形态单题作答 → allow + 答案进 updatedInput（不再落 deny）。
check('② 单题作答：submit option-0 → allow，答案「Staging」进 answers', () => {
  const payload = buildAskUserQuestionInteractionPayload('s1', QUESTION, 0, 'tid', 'rid');
  const result = mapPermissionInteractionResponse(
    payload,
    { action: 'submit', selectedOptionIds: ['option-0'] },
    { questions: [QUESTION] } as unknown as Record<string, unknown>,
  );
  assert.equal(result.behavior, 'allow', `仍落 deny：${JSON.stringify(result)}`);
  const answers = (result.updatedInput as { answers?: Record<string, string> })?.answers ?? {};
  assert.equal(answers['选择部署环境？'], 'Staging', `答案未组装：${JSON.stringify(answers)}`);
  assert.equal(result.toolUseID, 'tid', 'toolUseID 丢失');
});

// ③ 行为级：向导载荷（input.questions 形态）同样走 AskUserQuestion 分支。
check('③ 向导载荷：input.questions 形态作答 → allow', () => {
  const payload = buildWizardAskUserQuestionPayload('s1', [QUESTION], 'tid', 'rid');
  const result = mapPermissionInteractionResponse(
    payload,
    { action: 'submit', questionAnswers: { q0: { selectedOptionIds: ['option-1'] } } },
    { questions: [QUESTION] } as unknown as Record<string, unknown>,
  );
  assert.equal(result.behavior, 'allow', `向导形态未走 ask 分支：${JSON.stringify(result)}`);
  const answers = (result.updatedInput as { answers?: Record<string, string> })?.answers ?? {};
  assert.equal(answers['选择部署环境？'], 'Production', `向导答案未按 questionAnswers 组装：${JSON.stringify(answers)}`);
});

// ④ 既有语义不弱化：普通权限载荷 deny 选择仍映射用户拒绝。
check('④ 普通权限载荷：deny 选择仍映射「用户拒绝了该工具调用」', () => {
  const payload = buildPermissionInteractionPayload('s1', 'Bash', { command: 'ls' }, { toolUseID: 'tid' } as never, 'rid');
  const result = mapPermissionInteractionResponse(payload, { action: 'submit', selectedOptionIds: ['deny'] }, { command: 'ls' });
  assert.equal(result.behavior, 'deny');
  assert.equal((result as { message?: string }).message, '用户拒绝了该工具调用', 'deny 文案漂移');
});

// ⑤ 既有语义不弱化：AskUserQuestion 弹窗的 cancel 不再误伤（中性取消文案）。
check('⑤ cancel：AskUserQuestion 弹窗取消仍按权限通道中性文案（无 ask 分支误触发）', () => {
  const payload = buildAskUserQuestionInteractionPayload('s1', QUESTION, 0, 'tid', 'rid');
  const result = mapPermissionInteractionResponse(payload, { action: 'cancel' }, {});
  assert.equal(result.behavior, 'deny');
  assert.notEqual((result as { message?: string }).message, '用户拒绝了该工具调用', '系统取消不得记成用户拒绝');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
