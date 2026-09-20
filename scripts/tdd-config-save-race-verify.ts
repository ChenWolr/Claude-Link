// tdd-config-save-race-verify.ts
// P2-1（=C-1）/ P2-2（=C-2）保存链竞态契约（2026-09-18 Skill 管理 review §2 整改）。
// 行为 seam：真实 config-store（Pinia）+ 桩 window.claudeLink（saveConfig IPC 慢返回/可注入失败），
// 断言：①重入返回 {saved:false} 不再被静默吞 ②在飞编辑经漂移补偿最终落盘 ③漂移响应不覆写内存
// ④拨回开（watch 短路）场景补偿链收敛到用户意图 ⑤无漂移采纳主进程清洗回传 ⑥⑦ H1 失败语义哨兵
// ⑧ hb10-CFG-09 notice 哨兵；⑨-⑭ 源形钉（早退消失/{saved} 信号/漂移比对/补偿定时器/调用方仅
// saved 前移基线）。RED 预期（未修复树）：①④⑤⑧ FAIL + 形态钉 FAIL；留证 fix-tmp/red-p21.log。
// 运行：npx tsx scripts/tdd-config-save-race-verify.ts（不启动 Electron）。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import { useConfigStore, lastSaveFailed } from '../src/renderer/stores/config-store';
import type { AppConfig } from '../src/shared/types/config';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

let pass = 0;
let fail = 0;
function check(no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

interface StubState {
  calls: AppConfig[];
  delayMs: number;
  failOnce: boolean;
  responsePatch: Partial<AppConfig> | null;
}

function installStub(state: StubState): void {
  (globalThis as unknown as { window: unknown }).window = {
    claudeLink: {
      saveConfig: async (cfg: AppConfig) => {
        state.calls.push(JSON.parse(JSON.stringify(cfg)));
        if (state.failOnce) { state.failOnce = false; throw new Error('ipc down'); }
        if (state.delayMs > 0) await sleep(state.delayMs);
        return { ...JSON.parse(JSON.stringify(cfg)), ...(state.responsePatch ?? {}) };
      },
      getNativeSettingsDiagnostic: async () => null,
    },
  };
}

async function main(): Promise<void> {
  // ── 组1 行为 seam ──────────────────────────────────────────────

  // 场景 A（P2-1 + P2-2 主形态）：在飞期间二次编辑
  {
    setActivePinia(createPinia());
    const store = useConfigStore();
    const state: StubState = { calls: [], delayMs: 120, failOnce: false, responsePatch: null };
    installStub(state);
    lastSaveFailed.value = false;

    store.config.maxTurns = 5;                    // S1
    const p1 = store.saveConfig();                // 保存 #1 在飞（送 S1）
    await sleep(30);
    store.config.maxTurns = 7;                    // S2（在飞编辑）
    const r2 = await store.saveConfig();          // 重入 → 必须 {saved:false}
    check('①', `重入保存返回 {saved:false}（实际 ${JSON.stringify(r2)}）`, !!r2 && r2.saved === false);
    const r1 = await p1;
    check('①b', `首次保存返回 {saved:true}（实际 ${JSON.stringify(r1)}）`, !!r1 && r1.saved === true);
    check('③', '漂移响应不覆写内存（maxTurns 保持在飞编辑值 7）', store.config.maxTurns === 7, `实际 ${store.config.maxTurns}`);
    check('②sent', '首次保存载荷为发送时快照（maxTurns=5）', state.calls[0]?.maxTurns === 5, `实际 ${state.calls[0]?.maxTurns}`);
    await sleep(900);                             // 等漂移补偿（700ms 防抖）落定
    const last = state.calls[state.calls.length - 1];
    check('②', '在飞编辑经补偿重存最终落盘（末载荷 maxTurns=7）', last?.maxTurns === 7, `实际 ${last?.maxTurns}，calls=${state.calls.length}`);
    check('②mem', '补偿后内存与末载荷一致', store.config.maxTurns === last?.maxTurns);
    await sleep(50);
  }

  // 场景 B（P2-2 拨回开/watch 短路形态）：编辑→在飞→拨回，无任何后续防抖
  {
    setActivePinia(createPinia());
    const store = useConfigStore();
    const state: StubState = { calls: [], delayMs: 100, failOnce: false, responsePatch: null };
    installStub(state);

    store.config.maxTurns = 9;                    // S1'
    const p1 = store.saveConfig();
    await sleep(20);
    store.config.maxTurns = 5;                    // 拨回（等效回基线；watch 会短路不再排保存）
    await p1;
    await sleep(900);                             // 漂移补偿落定
    const last = state.calls[state.calls.length - 1];
    check('④', '拨回开场景补偿链收敛到用户最终意图（末载荷 maxTurns=5）', last?.maxTurns === 5, `实际 ${last?.maxTurns}，calls=${state.calls.length}`);
    check('④mem', '内存保留用户意图（maxTurns=5）', store.config.maxTurns === 5, `实际 ${store.config.maxTurns}`);
    await sleep(50);
  }

  // 场景 C（无漂移采纳主进程清洗回传）
  {
    setActivePinia(createPinia());
    const store = useConfigStore();
    const state: StubState = { calls: [], delayMs: 10, failOnce: false, responsePatch: { providerNote: 'normalized-by-main' } };
    installStub(state);

    store.config.maxTurns = 8;
    const r = await store.saveConfig();
    check('⑤', '无漂移保存返回 {saved:true}', !!r && r.saved === true);
    check('⑤adopt', '无漂移采纳主进程回传（providerNote=normalized-by-main）', store.config.providerNote === 'normalized-by-main', `实际 ${store.config.providerNote}`);
    await sleep(50);
  }

  // 场景 D（H1 失败语义哨兵 + 失败不断链）
  {
    setActivePinia(createPinia());
    const store = useConfigStore();
    const state: StubState = { calls: [], delayMs: 0, failOnce: true, responsePatch: null };
    installStub(state);
    lastSaveFailed.value = false;

    store.config.maxTurns = 6;
    let threw = false;
    try { await store.saveConfig(); } catch { threw = true; }
    check('⑥', '保存失败照常抛出（不吞）', threw);
    check('⑥flag', '失败置 lastSaveFailed=true', lastSaveFailed.value === true);
    check('⑥mem', '失败不清内存（maxTurns=6 仍在）', store.config.maxTurns === 6);
    const r = await store.saveConfig();           // 失败后下一次照常执行且成功
    const rOk = !!r && typeof r === 'object' && (r as { saved?: boolean }).saved === true;
    check('⑦', '失败不断链：下一次保存照常成功清标志', rOk && lastSaveFailed.value === false, `r=${JSON.stringify(r)}`);
    await sleep(50);
  }

  // 场景 E（hb10-CFG-09 notice 哨兵：主进程拒收坏目录回退旧值）
  {
    setActivePinia(createPinia());
    const store = useConfigStore();
    const state: StubState = { calls: [], delayMs: 0, failOnce: false, responsePatch: { workingDirectory: 'D:\\kept-old' } };
    installStub(state);

    store.config.workingDirectory = 'D:\\bad-dir';
    await store.saveConfig();
    check('⑧', 'hb10 notice：回传目录与所送不一致 → error 含「已保留原值」', typeof store.error === 'string' && store.error.includes('已保留原值'), `实际 ${JSON.stringify(store.error)}`);
    check('⑧adopt', 'notice 场景采纳回传（workingDirectory=D:\\kept-old）', store.config.workingDirectory === 'D:\\kept-old', `实际 ${store.config.workingDirectory}`);
    await sleep(50);
  }

  // ── 组2 源形钉 ────────────────────────────────────────────────

  {
    const src = read('src/renderer/stores/config-store.ts');
    const page = read('src/renderer/pages/ConfigPage.vue');
    const sub: string[] = [];
    if (/if\s*\(this\.savingConfig\)\s*return;/.test(src)) sub.push('仍存在 savingConfig 裸早退（须为 return { saved: false }）');
    if (!/saved:\s*false/.test(src)) sub.push('缺 { saved: false } 早退信号');
    if (!/saved:\s*true/.test(src)) sub.push('缺 { saved: true } 完成信号');
    if (!/sentStr/.test(src) || !/nowStr/.test(src)) sub.push('缺 sentStr/nowStr 漂移比对形态');
    if (!src.includes('driftResaveTimer')) sub.push('缺漂移补偿定时器（driftResaveTimer）');
    if (!/loadNativeSettingsDiagnostic\(this\.config\.workingDirectory\)/.test(src)) sub.push('保存体内诊断刷新字面缺失（regression-tests:1498 依赖）');
    if (!/plainConfig\.workingDirectory !== this\.config\.workingDirectory/.test(src)) sub.push('hb10 比对字面缺失');
    if (!/lastSaveFailed\.value = false/.test(src)) sub.push('成功清标志字面缺失');
    check('⑨-⑫', 'config-store 形态：无裸早退/{saved} 信号/漂移比对/补偿定时器/诊断与 notice 字面', sub.length === 0, sub.join('; '));

    const psub: string[] = [];
    if (!/if\s*\(\s*!r\.saved\s*\)\s*\{\s*scheduleAutoSave\(\);\s*return;/.test(page)) psub.push('防抖回调缺 saved:false 重排（scheduleAutoSave 链式补存）');
    if (!/if\s*\(\s*r\.saved\s*\)\s*\{?\s*lastSavedSnapshot = configSnapshot\(\);/.test(page) && !/if\s*\(\s*saved\s*\)\s*\{?\s*lastSavedSnapshot = configSnapshot\(\);/.test(page)) psub.push('缺「仅 saved 才前移基线」形态');
    if (!/saveUntilSettled/.test(page)) psub.push('缺 saveUntilSettled 有界重试 helper（handleSave/卸载 flush 共用）');
    check('⑬-⑭', 'ConfigPage 形态：saved:false 重排补存 / 仅 saved 前移基线 / flush 有界重试', psub.length === 0, psub.join('; '));
  }

  console.log(`\n===== tdd-config-save-race-verify: ${pass} pass / ${fail} fail =====`);
  process.exit(fail > 0 ? 1 : 0);
}

void main().catch((e: unknown) => {
  console.error('runner crash:', e);
  process.exit(1);
});
