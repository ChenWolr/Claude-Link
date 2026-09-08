// tdd-bugfix-h1-config-save-fail-toast-retry-verify.ts
// H1（P3，对抗复查 2026-09-08 第二轮）契约钉：F5「卸载 flush 顺序」修复无效重做——
// 跨卸载可感知 + 可重试。
//
// 修复前：ConfigPage onBeforeUnmount 的 flush .catch 只置组件局部 saveStatus——
// 三条失效链：①卸载后无渲染；②watch(configSnapshot) 随 setup 卸载即停，无法重试；
// ③重进设置页 performInit 先 loadConfig() 用主进程旧值覆写 store.config，失败编辑被
// 静默回滚。用户可感知行为与修复前完全一致（静默丢失）。
//
// 修复语义：
// ① config-store 增模块级 lastSaveFailed 标志（saveConfig 失败置 true、成功清 false），
//    与组件生命周期解耦；失败时不清内存 config（this.config 仅在成功分支被覆写）。
// ② App.vue 全局 watch 该标志，置 true 弹一次 toast「设置保存失败，部分修改可能未保存」
//    （A3 文案中性化：用户在场时原「重进设置页将恢复」承诺不适配）——用户已离开设置页时
//    唯一可达的展示位；标志回到 false 时若 toast 仍在显示则提前隐藏（A3 滞后撤销收口）。
// ③ ConfigPage performInit 开头检测 lastSaveFailed：为真先用手头内存值重存一次
//    （此刻 loadConfig 尚未覆写，内存 config 仍是失败时的编辑值）。成功由 config-store
//    saveConfig 成功路径清标志；失败进 catch 也清标志（A1 边沿饥饿修复：载荷即将被
//    loadConfig 用主进程旧值覆写，标志语义已死——保持 true 会让后续新失败停在 true→true
//    无边沿，toast 不再弹，退回 F5 静默丢失形态），且不阻塞页面初始化。
//
// 契约：flush 失败后重进设置页触发重存——saveConfig 行为 seam stub「两次失败一次成功」，
// 断言标志三态翻转与内存 config 不被失败清空；A1 增补边沿恢复行为 + 两处清标志不变量
// （performInit catch 清 / config-store 成功清，契约普查 2026-09-08 B3 钉扎更正）。
//
// 运行：npx tsx scripts/tdd-bugfix-h1-config-save-fail-toast-retry-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import { useConfigStore, lastSaveFailed } from '../src/renderer/stores/config-store';
import type { AppConfig } from '../src/shared/types/config';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: (() => void) | boolean): void {
  try {
    if (typeof cond === 'function') cond();
    else if (!cond) throw new Error('断言为假');
    pass += 1; console.log(`  ✅ ${name}`);
  }
  catch (e) { fail += 1; console.log(`  ✗ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

async function main(): Promise<void> {
  console.log('=== H1-① config-store lastSaveFailed 标志（行为 seam：两次失败一次成功）===');
  const flagExported = typeof lastSaveFailed !== 'undefined' && lastSaveFailed !== null;
  check('config-store 导出模块级标志 lastSaveFailed', flagExported);
  {
    setActivePinia(createPinia());
    const store = useConfigStore();
    if (!flagExported) {
      // RED 兜底：标志未实现时不再往下取 .value（避免 crash 吞掉后续断言输出）。
      console.log('  ⏭ 标志未实现，跳过行为 seam 细项');
      console.log('=== H1-②③ 接线契约（跨文件不变量）===');
      console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
      process.exit(1);
    }

    const calls: AppConfig[] = [];
    (globalThis as unknown as { window: unknown }).window = {
      claudeLink: {
        // 行为 seam：saveConfig 前两次失败、第三次成功（幂等回显入参）。
        saveConfig: async (cfg: AppConfig) => {
          calls.push(cfg);
          if (calls.length <= 2) throw new Error(`ipc down #${calls.length}`);
          return cfg;
        },
        getNativeSettingsDiagnostic: async () => {
          throw new Error('不应被调用（workingDirectory=null）');
        },
      },
    };

    check('模块级标志初始为 false', lastSaveFailed.value === false);

    // 内存值标记（模拟用户失败前的编辑）。
    store.config.maxTurns = 5;

    // 第一次失败：标志置 true，内存 config 不被清（重存的先决条件）。
    let threw = false;
    try { await store.saveConfig(); } catch { threw = true; }
    check('第一次 saveConfig 失败照常抛出（不吞）', threw);
    check('失败后 lastSaveFailed 置 true', lastSaveFailed.value === true);
    check('失败不清内存 config（maxTurns=5 仍在）', store.config.maxTurns === 5);

    // 第二次失败：标志保持 true。
    threw = false;
    try { await store.saveConfig(); } catch { threw = true; }
    check('第二次失败仍抛出且标志保持 true', threw && lastSaveFailed.value === true);

    // 第三次成功：标志清 false，且三次载荷都携带内存值 5（保存的是失败时的编辑，非回滚值）。
    await store.saveConfig();
    check('第三次成功后 lastSaveFailed 清 false', lastSaveFailed.value === false);
    check('三次调用全部携带内存编辑值（maxTurns=5）', calls.length === 3 && calls.every((c) => c.maxTurns === 5));

    // 成功后再失败：标志重新置 true（边沿可重复，App.vue 每次 false→true 都可感知）。
    (globalThis as unknown as { window: unknown }).window = {
      claudeLink: { saveConfig: async () => { throw new Error('ipc down again'); } },
    };
    threw = false;
    try { await store.saveConfig(); } catch { threw = true; }
    check('成功后再失败标志重新置 true', threw && lastSaveFailed.value === true);

    // A1（契约普查 2026-09-08）行为 seam：边沿恢复。performInit catch 的清位动作在无挂载
    // 环境不可驱动，此处以直接置 false 模拟该清位（组件侧清位由下方结构不变量①钉住），
    // 经真实 saveConfig 断言：标志一旦被清，下一次失败重新产生 false→true 边沿——
    // 连续失败场景不再退回 F5 静默形态。
    lastSaveFailed.value = false; // 模拟 performInit catch 清位（A1 修复点）
    threw = false;
    try { await store.saveConfig(); } catch { threw = true; }
    check('标志被清后下一次失败重新置 true（边沿恢复——A1 可观察收益）', threw && lastSaveFailed.value === true);
  }

  console.log('=== H1-②③ 接线契约（跨文件不变量）===');
  {
    const configStore = read('src/renderer/stores/config-store.ts');
    const configPage = read('src/renderer/pages/ConfigPage.vue');
    const app = read('src/renderer/App.vue');

    check('config-store 导出模块级 ref(false) 标志', /export const lastSaveFailed = ref\(false\)/.test(configStore));
    const saveActionAt = configStore.indexOf('async saveConfig()');
    const saveAction = configStore.slice(saveActionAt, configStore.indexOf('async detectCli()', saveActionAt));
    // B3 钉扎更正：两处清标志不变量——②config-store saveConfig 成功清（含 ConfigPage 重存
    // 成功结局，组件不再重复书写）；①performInit catch 清（A1，见下）。
    check('A1 不变量②：config-store saveConfig 成功清标志', /lastSaveFailed\.value = false/.test(saveAction));
    check('saveConfig 失败路径置标志', /catch[\s\S]*lastSaveFailed\.value = true[\s\S]*throw error/.test(saveAction));

    check('ConfigPage 引入 lastSaveFailed', /import\s*\{[^}]*lastSaveFailed[^}]*\}\s*from\s*'\.\.\/stores\/config-store'/.test(configPage));
    const initAt = configPage.indexOf('async function performInit()');
    const initFn = configPage.slice(initAt, configPage.indexOf('onMounted(performInit)', initAt));
    const retryAt = initFn.indexOf('if (lastSaveFailed.value)');
    const loadAt = initFn.indexOf('await store.loadConfig()');
    check('performInit 检测标志在 loadConfig 之前（覆写前抢救内存值）', retryAt !== -1 && loadAt !== -1 && retryAt < loadAt);
    const retryBlock = retryAt !== -1 ? initFn.slice(retryAt, loadAt) : '';
    check('重存走 store.saveConfig()（内存值重试）', /await store\.saveConfig\(\)/.test(retryBlock));
    // B3 钉扎更正：原「重存成功清标志」钉的是与 config-store 成功清冗余的实现细节（未来清理
    // 会误报 RED），改为钉 catch 清标志这一真实不变量（A1）。
    check('A1 不变量①：performInit 重存 catch 清标志（载荷将被 loadConfig 覆写，标志语义已死）',
      /catch\s*\{[\s\S]*?lastSaveFailed\.value = false/.test(retryBlock));
    check('重存失败不阻塞初始化（catch 不 rethrow）', /catch/.test(retryBlock) && !/catch[\s\S]*throw/.test(retryBlock));

    check('App.vue 全局 watch lastSaveFailed', /watch\(lastSaveFailed/.test(app));
    check('A3：全局 toast 文案中性化（逐字）', app.includes('设置保存失败，部分修改可能未保存'));
    check('A3：失败边沿弹 toast + 成功时在显示的 toast 提前隐藏（watch 双分支收口）',
      /watch\(lastSaveFailed, \(failed\) => \{\s*if \(failed\) \{[\s\S]*?saveFailedToastVisible\.value = true;[\s\S]*?\} else if \(saveFailedToastVisible\.value\) \{[\s\S]*?saveFailedToastVisible\.value = false;/.test(app));
  }

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
