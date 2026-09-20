// tdd-rightpanel-route-gate-verify.ts
// 计划 docs/plans/2026-09-20-rightpanel-route-gate-plan.md §2 改动 5：右侧活动栏仅会话页渲染——
// 队列事件监听全局化（App.vue 全局 onQueueEvent）+ TaskQueuePanel 纯展示化 + AppLayout 路由门控
// + 删除 use-task-queue.ts。
// 断言分组（全部字面窗口匹配）：
//   A. App.vue 全局队列监听（注册 + 卸载清理）
//   B. TaskQueuePanel 纯展示化（无 useTaskQueue/startListening；loadOverview 重挂载兜底保留）
//   C. AppLayout 路由门控（isChatRoute + 三件 v-if 门 + reopen 按钮 v-else-if + taskWidth=340 契约不回归）
//   D. use-task-queue.ts 已删除且 src/renderer 无残留引用
// RED 预期（未改树）：B、D 组 FAIL（A/C 也 FAIL，注册与门控尚未实施）。
// 运行：npx tsx scripts/tdd-rightpanel-route-gate-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(repoRoot, 'src/renderer/App.vue'), 'utf8');
const panel = fs.readFileSync(path.join(repoRoot, 'src/renderer/components/task/TaskQueuePanel.vue'), 'utf8');
const layout = fs.readFileSync(path.join(repoRoot, 'src/renderer/components/layout/AppLayout.vue'), 'utf8');

let pass = 0;
let fail = 0;
function check(group: string, no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ [${group}] ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ [${group}] ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A. App.vue 全局队列监听：注册字面 + stopQueueEvents 声明 + 卸载清理调用。
{
  const registered = app.includes('onQueueEvent((payload) => taskStore.handleQueueEvent(payload))');
  check('A', '①', 'App.vue 全局注册 onQueueEvent → taskStore.handleQueueEvent', registered,
    '缺 window.claudeLink.onQueueEvent 全局注册（TaskQueuePanel 卸载后队列事件丢失）');
  const declared = app.includes('stopQueueEvents');
  const cleanup = app.includes('if (stopQueueEvents) stopQueueEvents()');
  check('A', '②', 'App.vue stopQueueEvents 声明 + onBeforeUnmount 清理', declared && cleanup,
    `声明=${declared} 清理=${cleanup}——全局监听缺清理即泄漏`);
}

// B. TaskQueuePanel 纯展示化：组件级监听全撤，重挂载兜底拉取保留。
{
  const noComposable = !panel.includes('useTaskQueue');
  const noStart = !panel.includes('startListening');
  check('B', '①', 'TaskQueuePanel 无 useTaskQueue/startListening（监听已上移 App.vue）', noComposable && noStart,
    `useTaskQueue 残留=${!noComposable} startListening 残留=${!noStart}`);
  const keepPull = panel.includes('loadOverview();');
  check('B', '②', 'TaskQueuePanel 保留 onMounted loadOverview 兜底拉取', keepPull,
    '重挂载后须 loadOverview() 权威快照对齐');
}

// C. AppLayout 路由门控：isChatRoute computed + 右栏三件模板门 + taskWidth=340 契约。
{
  const hasComputed = layout.includes('isChatRoute') && layout.includes("route.name === 'chat'");
  check('C', '①', 'AppLayout 含 isChatRoute（route.name === \'chat\'）', hasComputed,
    '缺 useRoute + isChatRoute computed');
  const gate = layout.includes('v-if="isTaskPanelOpen && isChatRoute"');
  check('C', '②', '右栏手柄+面板模板门 v-if="isTaskPanelOpen && isChatRoute"', gate,
    'resize-handle--task/TaskQueuePanel 仍不感知路由');
  const reopenGate = layout.includes('v-else-if="isChatRoute"');
  check('C', '③', 'reopen 按钮仅 chat 页 v-else-if="isChatRoute"', reopenGate,
    '「队列」悬浮按钮仍出现在非 chat 路由');
  const widthPinned = /taskWidth\s*=\s*ref\(340\)/.test(layout);
  check('C', '④', 'taskWidth = ref(340) 契约不回归', widthPinned, '宽度契约（selftest-settings-mapping 1406）钉死');
}

// D. use-task-queue.ts 已删除，且 src/renderer 内无 'use-task-queue' 残留引用（防死代码复活）。
{
  const gone = !fs.existsSync(path.join(repoRoot, 'src/renderer/composables/use-task-queue.ts'));
  check('D', '①', 'src/renderer/composables/use-task-queue.ts 已删除', gone, '唯一消费者已移除，文件应删');
  const hits: string[] = [];
  function walk(dir: string): void {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (fs.readFileSync(p, 'utf8').includes('use-task-queue')) hits.push(path.relative(repoRoot, p));
    }
  }
  walk(path.join(repoRoot, 'src/renderer'));
  check('D', '②', 'src/renderer 内无 use-task-queue 残留引用', hits.length === 0, hits.join(', '));
}

console.log(`\n===== tdd-rightpanel-route-gate-verify: ${pass} pass / ${fail} fail =====`);
if (fail > 0) console.log('（RED 阶段：FAIL 项为尚未实施的生产改动，实施后应全 PASS）');
process.exit(fail > 0 ? 1 : 0);
