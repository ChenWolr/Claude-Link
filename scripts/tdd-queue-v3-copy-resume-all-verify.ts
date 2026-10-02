// tdd-queue-v3-copy-resume-all-verify.ts
// B9（D09-F8 + D09-F9，P3）契约钉：队列 v2 残留文案清理 + 「全部恢复」按钮补渲染。
//
// 根因（D09-F8）：ConfigPage 队列开关描述残留 v2 文案「（仍可在队列面板手动「开始」）」——
// v3 面板已删队列级开始/暂停/恢复按钮（TaskQueuePanel.vue 注释自证），且开关关闭时
// runTaskNow 主进程抛错（task-queue-engine.ts 开关闸）、「立即执行」渲染层全置灰——
// 描述承诺的动作既无入口也会被拒绝，照做必扑空。
//
// 根因（D09-F9）：queueBarHint「所有任务已暂停」分支（tasks>0 且 runnableCount===0，
// 即全部 pending 均暂停）showResumeAll:false，而文案指路「点恢复/全部恢复后执行」——
// 模板仅 showResumeAll 为真才渲染「全部恢复」按钮，用户只能逐卡点「恢复」。
// 到达路径：halt 熔断置全部 paused → 用户直发成功 beginUserTurn 清 reason → 回合结束
// armAfterTurn 因无未暂停 pending 转 standby(null) → 落入本分支。
//
// 修复语义：① ConfigPage 描述改 v3 语义（删手动「开始」残留，指路真实入口：
// 重开开关后点「恢复」/「立即执行」或完成一次会话）；② 该分支 showResumeAll:true
// ——resumeAllTasks（resumeAllPending + armFromUserAction）对「全部已暂停」语义正确
// （恢复全部 paused→pending 后四道守卫全过，起全量倒计时）。
//
// 运行：npx tsx scripts/tdd-queue-v3-copy-resume-all-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

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

const configPage = readFileSync(new URL('../src/renderer/pages/ConfigPage.vue', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../src/renderer/components/task/TaskQueuePanel.vue', import.meta.url), 'utf8');

console.log('\n=== B9-D09-F8：ConfigPage 队列开关描述改 v3 语义（删「手动开始」v2 残留） ===');
check('开启段保留（消息与附件自动加入队列）', () => {
  assert.ok(configPage.includes('消息与附件自动加入队列'), '开启段文案不应随本次改动漂移');
});
check('v2 残留「仍可在队列面板手动」已删除', () => {
  assert.ok(!configPage.includes('仍可在队列面板手动'), '仍残留「仍可在队列面板手动…」v2 文案');
});
check('v2 残留「手动「开始」」承诺已删除', () => {
  assert.ok(!configPage.includes('手动「开始」'), '仍残留「手动「开始」」——v3 已删该按钮');
});
check('关闭段改 v3 语义（不自动执行 + 重开开关后的真实入口）', () => {
  assert.ok(
    configPage.includes('关闭后：回复生成中禁止发送，队列不自动执行；重新开启后点「恢复」/「立即执行」或完成一次会话可重新调度。'),
    '缺 v3 语义关闭段文案',
  );
});

console.log('\n=== B9-D09-F9：「所有任务已暂停」分支渲染「全部恢复」按钮 ===');
check('该分支 showResumeAll 置 true（按钮随文案渲染）', () => {
  const at = panel.indexOf('所有任务已暂停');
  assert.ok(at > -1, '缺「所有任务已暂停」分支文案');
  const after = panel.slice(at, at + 200);
  assert.match(after, /showResumeAll:\s*true/, '分支应置 showResumeAll: true');
});
check('分支推导门不回退（存在任务且全部暂停才命中）', () => {
  const at = panel.indexOf('所有任务已暂停');
  assert.ok(at > -1, '缺「所有任务已暂停」分支文案');
  const before = panel.slice(Math.max(0, at - 400), at);
  assert.match(before, /taskStore\.tasks\.length > 0/, '分支应保留 tasks.length > 0 门（零任务不命中）');
  assert.match(before, /runnableCount\.value === 0/, '分支应保留 runnableCount === 0 门（存在未暂停任务不命中）');
});
check('按钮渲染门与接线不变（v-if=showResumeAll + handleResumeAll）', () => {
  assert.ok(panel.includes('v-if="queueBarHint.showResumeAll"'), '模板渲染门应仍由 showResumeAll 驱动');
  const btnAt = panel.indexOf('@click="handleResumeAll"');
  assert.ok(btnAt > -1, '「全部恢复」按钮应仍接 handleResumeAll');
  const btnBlock = panel.slice(btnAt - 200, btnAt + 100);
  assert.ok(btnBlock.includes('全部恢复'), '按钮文案应仍为「全部恢复」');
});
check('halt 分支 showResumeAll:true 不回归', () => {
  assert.ok(panel.includes(`'上次执行失败，队列已全部暂停', showResumeAll: true`), 'halt_failed 分支应保持 showResumeAll: true');
  assert.ok(panel.includes(`'上次执行被中断，队列已全部暂停', showResumeAll: true`), 'halt_interrupted 分支应保持 showResumeAll: true');
});
check('引擎侧 resumeAllTasks 语义支撑（resumeAllPending + armFromUserAction）', () => {
  const engine = readFileSync(new URL('../src/main/modules/task-queue-engine.ts', import.meta.url), 'utf8');
  const at = engine.indexOf('export function resumeAllTasks');
  assert.ok(at > -1, '缺 resumeAllTasks 导出');
  const body = engine.slice(at, at + 400);
  assert.match(body, /resumeAllPending\(sessionId\)/, '应先 resumeAllPending');
  assert.match(body, /armFromUserAction\(sessionId, mainWindow\)/, '再经 armFromUserAction 起倒计时');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
