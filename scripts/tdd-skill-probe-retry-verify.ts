// tdd-skill-probe-retry-verify.ts
// B-1/C-3/D-7（review 2026-09-18 §3-1）：degraded/error 态封死 Skill 页自重试。
// 旧 ensureGlobalSnapshot 守卫 `status !== 'loading'` 对 degraded/error 快照同样早退——Skill 页
// 纯被动消费 globalSnapshot，一旦探测失败（degraded/error）永不重拉，页面文案「重新打开菜单可
// 重试」在 Skill 页无对应旁路（误导）。整改 = 守卫收窄（仅 ready/empty/stale 定态早退，degraded/
// error 放行重拉）+ ConfigPage degraded/error 臂加显式「重试」入口 + 文案修正。
//
// 行为 seam：真实 command-store（Pinia）+ 桩 window.claudeLink.getSessionCommands（按调用序出队
// 快照，echo 请求 sessionId）；断言：①degraded 态 ensure 不早退（重新拉取）②重拉 ready 后恢复
// ③error 态同款放行并恢复 ④ready/stale/empty 定态仍早退（防拉取风暴不回退）⑤loading 仍放行
// （启动空窗回填语义不变）；⑥-⑧ 源形钉：守卫收窄三态字面 / ConfigPage degraded/error 臂显式
// 「重试」入口（retryGlobalSnapshot）/ commands-get 误导文案退场（保留「命令探测失败」前缀）。
// RED 预期（未修复树）：①②③⑥⑦⑧ FAIL、④⑤ PASS（防拉取风暴是既有语义，做回归守卫）。
// 运行：npx tsx scripts/tdd-skill-probe-retry-verify.ts（不启动 Electron）。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import { useCommandStore } from '../src/renderer/stores/command-store';
import type { SessionCommandSnapshot, SdkCommand } from '../src/shared/types/command';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

const mkCmd = (name: string): SdkCommand => ({ name, description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'user-skill', availability: 'available' });

/** 构造哨兵兜底快照（source:'cache' 与 COMMANDS_GET 只读分流/哨兵回填真实形态一致）。 */
function snapOf(sessionId: string, status: SessionCommandSnapshot['status'], cmds: SdkCommand[] = []): SessionCommandSnapshot {
  return { sessionId, commands: cmds, status, source: 'cache', updatedAt: new Date().toISOString() };
}

interface StubState {
  /** 按调用序出队的快照状态；耗尽后重复末位。 */
  queue: SessionCommandSnapshot['status'][];
  calls: number;
}

function installStub(state: StubState): void {
  (globalThis as unknown as { window: unknown }).window = {
    claudeLink: {
      getSessionCommands: async (sessionId: string) => {
        state.calls += 1;
        const status = state.queue.length > 1 ? state.queue.shift() as SessionCommandSnapshot['status'] : state.queue[0];
        return snapOf(sessionId, status, status === 'ready' ? [mkCmd('probe-skill')] : []);
      },
    },
  };
}

async function main(): Promise<void> {
  // ── 组1 行为 seam（真实 command-store + 桩 IPC）─────────────────────

  // ①② degraded 态：首次 ensure 注入 degraded 快照；二次 ensure 必须重新拉取（旧守卫早退即封死），
  //    且重拉返回 ready 后恢复。
  {
    setActivePinia(createPinia());
    const store = useCommandStore();
    const state: StubState = { queue: ['degraded', 'ready'], calls: 0 };
    installStub(state);
    await store.ensureGlobalSnapshot();
    const degradedSeen = store.globalSnapshot?.status === 'degraded' && state.calls === 1;
    await store.ensureGlobalSnapshot();
    check('①', `degraded 态 ensure 不早退（第二次调用发生 IPC 重拉，calls=${state.calls}）`, degradedSeen && state.calls === 2);
    check('②', `degraded 重拉 ready 后快照恢复（status=${store.globalSnapshot?.status}）`, store.globalSnapshot?.status === 'ready' && store.globalSnapshot?.commands.length === 1);
  }

  // ③ error 态同款：首拉 error 快照，二次 ensure 放行重拉并恢复 ready。
  {
    setActivePinia(createPinia());
    const store = useCommandStore();
    const state: StubState = { queue: ['error', 'ready'], calls: 0 };
    installStub(state);
    await store.ensureGlobalSnapshot();
    await store.ensureGlobalSnapshot();
    check('③', `error 态 ensure 放行重拉并恢复（calls=${state.calls}，status=${store.globalSnapshot?.status}）`, state.calls === 2 && store.globalSnapshot?.status === 'ready');
  }

  // ④ 定态早退不回退（防拉取风暴是既有语义）：ready / stale / empty 二次 ensure 均不重拉。
  {
    setActivePinia(createPinia());
    const store = useCommandStore();
    const state: StubState = { queue: ['ready'], calls: 0 };
    installStub(state);
    await store.ensureGlobalSnapshot();
    await store.ensureGlobalSnapshot();
    const readyOk = state.calls === 1;

    setActivePinia(createPinia());
    const store2 = useCommandStore();
    const state2: StubState = { queue: ['stale'], calls: 0 };
    installStub(state2);
    await store2.ensureGlobalSnapshot();
    await store2.ensureGlobalSnapshot();
    const staleOk = state2.calls === 1;

    setActivePinia(createPinia());
    const store3 = useCommandStore();
    const state3: StubState = { queue: ['empty'], calls: 0 };
    installStub(state3);
    await store3.ensureGlobalSnapshot();
    await store3.ensureGlobalSnapshot();
    const emptyOk = state3.calls === 1;
    check('④', `ready/stale/empty 定态仍早退（calls=${state.calls}/${state2.calls}/${state3.calls}）`, readyOk && staleOk && emptyOk);
  }

  // ⑤ loading 仍放行（启动空窗回填语义不变：loading 占位不早退，允许再次拉取）。
  {
    setActivePinia(createPinia());
    const store = useCommandStore();
    const state: StubState = { queue: ['loading'], calls: 0 };
    installStub(state);
    await store.ensureGlobalSnapshot();
    await store.ensureGlobalSnapshot();
    check('⑤', `loading 态 ensure 照常放行（calls=${state.calls}）`, state.calls === 2);
  }

  // ── 组2 源形钉 ────────────────────────────────────────────────

  // ⑥ command-store 守卫收窄形态：ensureGlobalSnapshot 守卫体同时含 loading/degraded/error 三态
  //    不早退字面（ready/empty/stale 隐式早退——三态白名单取反式收窄，㉒ 的 loading 字面保持命中）。
  {
    const src = read('src/renderer/stores/command-store.ts');
    const ensureAt = src.indexOf('async ensureGlobalSnapshot(): Promise<void>');
    const nextAt = ensureAt >= 0 ? src.indexOf('\n    async ', ensureAt + 10) : -1;
    const body = ensureAt >= 0 ? src.slice(ensureAt, nextAt > ensureAt ? nextAt : ensureAt + 1600) : '';
    const sub: string[] = [];
    if (!/status\s*!==\s*'loading'/.test(body)) sub.push('守卫缺 loading 放行字面（启动空窗回填语义，㉒ 回归）');
    if (!/status\s*!==\s*'degraded'/.test(body)) sub.push('守卫缺 degraded 放行（B-1 主形态）');
    if (!/status\s*!==\s*'error'/.test(body)) sub.push('守卫缺 error 放行');
    check('⑥', 'command-store：ensureGlobalSnapshot 守卫收窄（loading/degraded/error 均放行重拉）', sub.length === 0, sub.join('; '));
  }

  // ⑦ ConfigPage：degraded/error 状态臂含显式「重试」入口（retryGlobalSnapshot 接线）。
  {
    const src = read('src/renderer/pages/ConfigPage.vue');
    const armAt = src.indexOf("commandStore.globalSnapshot?.status === 'degraded'");
    const arm = armAt >= 0 ? src.slice(armAt, armAt + 1600) : '';
    const sub: string[] = [];
    if (!src.includes('function retryGlobalSnapshot')) sub.push('缺 retryGlobalSnapshot 重试函数');
    if (armAt < 0) sub.push('缺 degraded/error 状态臂');
    else if (!/retryGlobalSnapshot/.test(arm)) sub.push('degraded/error 臂未接线 retryGlobalSnapshot');
    else if (!arm.includes('重试')) sub.push('degraded/error 臂缺「重试」按钮文案');
    check('⑦', 'ConfigPage：degraded/error 态显式「重试」入口接线', sub.length === 0, sub.join('; '));
  }

  // ⑧ 误导文案退场：commands-get 的「重新打开菜单可重试」改为对两处消费面（斜杠菜单/Skill 页）
  //    都成立的修正文案（保留「命令探测失败」前缀——hb13-v CMD-07 契约钉依赖）；ConfigPage 不引入。
  {
    const cg = read('src/shared/commands-get.ts');
    const page = read('src/renderer/pages/ConfigPage.vue');
    const sub: string[] = [];
    if (cg.includes('重新打开菜单可重试')) sub.push('commands-get 误导文案仍在（Skill 页无菜单旁路）');
    if (!/命令探测失败/.test(cg)) sub.push('「命令探测失败」前缀缺失（hb13-v CMD-07 契约钉）');
    if (page.includes('重新打开菜单可重试')) sub.push('ConfigPage 引入误导文案');
    check('⑧', '误导文案退场（保留「命令探测失败」前缀）', sub.length === 0, sub.join('; '));
  }

  console.log(`\n===== tdd-skill-probe-retry-verify: ${pass} pass / ${fail} fail =====`);
  if (fail > 0) console.log('（RED 阶段：FAIL 项为尚未实施的生产改动，实施后应全 PASS）');
  process.exit(fail > 0 ? 1 : 0);
}

void main().catch((e: unknown) => {
  console.error('runner crash:', e);
  process.exit(1);
});
