// tdd-export-progress-cancel-verify.ts
// B4（D13-F2 + D13-F3，P3 合并）契约钉：导出进度真实推进 + 用户取消通道。
//
// F2 根因：export-runner 六处 report 均不传 percent → `percent: partial.percent ?? 0`
// 恒为 0，manager makeProgress 信任透传 → 遮罩/AppHeader 全程「0%」直到 done 跳 100。
// F3 根因：全仓无取消通道（EXPORT_IMAGE_CANCEL/cancelExport 零命中），分钟级长导出
// 无逃生口（唯一途径关窗误伤整个会话）。
//
// 修复语义：
//  ① estimateExportPercent 纯函数（shared/export-image.ts）：planning/preparing → -1
//     （store 呈 indeterminate）；done → 100；capturing/encoding 按
//     ((page-1)*segmentsInPage + segment) / (totalPages*segmentsInPage) 推进、封顶 99
//     （终态 100 由 manager done 分支发，防「100% 还在跑」）；非法入参钳 0。
//     renderer report() 以它回落（数据 page/totalPages/segment/segmentsInPage 已齐）。
//  ② EXPORT_IMAGE_CANCEL IPC：主进程 cancelJob（cancelled 终态 + 复用 cleanup：
//     terminate worker、销毁导出窗口、删临时目录，resolve ExportResults.cancelled()）；
//     仅捕获/编码阶段可取消（保存对话框自带取消；performSave 持句柄中途回抽会误报 failed）。
//  ③ Overlay「取消」按钮（running 且 percent<100 显示）→ store.cancel() → IPC。
//     P2-3（2026-10-02 对抗 review）：v-if 另排除 waitingForDestination/saving——与主进程
//     cancellable 白名单对齐；这两个阶段 cancel 返回 {ok:false} 在 store 链路被静默吞，
//     按钮照常渲染即成死按钮（保存大文件期间点击无任何反应）。
//  ④ P3-12（2026-10-02 对抗 review）：主进程在 EXPORT_RENDER_PROGRESS 转发处记录最近
//     捕获/编码估算（ActiveJob.lastCapturePercent，钳 [0,99] 单调）；waitingForDestination/
//     saving 两处 makeProgress 携带它——否则 computeProgressPercent(phase,0,0)=0，进度条
//     99%→0%→100% 回零跳变（视觉误导「重头来过」）。
//  ⑤ NaN 加固（2026-10-02 复审遗留 P3）：④的记录行原为 Math.max 复合链——payload.percent
//     为 NaN/非数值时 Math.min/max 把 NaN 传染给 lastCapturePercent（单调基线一旦 NaN，
//     后续保存阶段进度显示 NaN% 永久毒化）。守卫形态：Number.isFinite 三目先钳 [0,99]，
//     非数值落 null，pct !== null 才更新——非数值跳过本次记录、不毒化既有估算。
//  ⑥ X7（R13-F2，2026-10-06）：renderer report() 的 percent 钳制移到 {...base, ...partial}
//     合并之后——planning/preparing 的 estimateExportPercent 回落 -1（不确定态），旧形态
//     `percent: <回落>, ...partial` 后经 manager makeProgress 转发（其钳制写在 `...partial`
//     展开之前属死代码）直通 store，AppHeader 悬停显示「正在导出长图… -1%」。修复：report()
//     先合并出 merged、再 `merged.percent = Math.max(0, Math.min(100, merged.percent))`，
//     可见层（AppHeader 悬停/遮罩数值分支）永不出现负值进度；遮罩不确定分支由 phase 驱动
//     （store indeterminate getter），不受影响。
//  ⑦ X7 followup（2026-10-07）：manager 本地 makeProgress 的死钳制同修——旧形态
//     `percent: percent < 0 ? 0 : percent, ...partial` 钳制写在展开之前，partial 携带负
//     percent 时被覆盖成死代码（renderer 已在 ⑥ 自钳，但 manager 是第二道防线——任何主进程
//     侧新发射点/直传路径不再依赖调用方自觉）。与 report() 同构：先合并出 merged、再钳
//     [0,100]、以 merged 调 emitProgress。
//
// 运行：npx tsx scripts/tdd-export-progress-cancel-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { estimateExportPercent, makeProgressPayload } from '../src/shared/export-image';

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

console.log('\n=== B4（D13-F2/F3）：导出进度推进 + 取消通道 ===');

console.log('-- estimateExportPercent 纯逻辑 --');
check('planning/preparing → -1（不确定态，store 呈 indeterminate）', () => {
  assert.equal(estimateExportPercent('planning', 0, 0, 0, 0), -1);
  assert.equal(estimateExportPercent('preparing', 0, 0, 0, 0), -1);
});
check('done → 100', () => {
  assert.equal(estimateExportPercent('done', 1, 1, 0, 0), 100);
});
check('非法入参（无页/无段）→ 0 而非 NaN/除零', () => {
  assert.equal(estimateExportPercent('capturing', 0, 0, 0, 0), 0);
  assert.equal(estimateProgressSafe('capturing', 1, 2, 1, 0), 0);
});
check('>3 段导出按段推进：33% → 66%（3 页各 1 段）', () => {
  assert.equal(estimateExportPercent('capturing', 1, 3, 1, 1), 33);
  assert.equal(estimateExportPercent('capturing', 2, 3, 1, 1), 67);
});
check('最后一段封顶 99（终态 100 由 manager done 发，防 100% 还在跑）', () => {
  assert.equal(estimateExportPercent('capturing', 3, 3, 1, 1), 99);
  assert.equal(estimateExportPercent('encoding', 3, 3, 1, 1), 99);
});
check('页间累计段数正确（2 页各 3 段：第 2 页完成 2 段 = 5/6 → 83）', () => {
  assert.equal(estimateExportPercent('capturing', 2, 2, 2, 3), 83);
});
check('负数 page/segment 钳 0（不产生负进度）', () => {
  const v = estimateExportPercent('capturing', -1, 2, -3, 2);
  assert.ok(v >= 0, `负入参产出 ${v}`);
});

function estimateProgressSafe(phase: 'capturing', page: number, totalPages: number, segment: number, segmentsInPage: number): number {
  return estimateExportPercent(phase, page, totalPages, segment, segmentsInPage);
}

console.log('-- 结构契约 --');
const runner = readFileSync(new URL('../src/renderer/export/export-runner.ts', import.meta.url), 'utf8');
const ipcTs = readFileSync(new URL('../src/shared/types/ipc.ts', import.meta.url), 'utf8');
const manager = readFileSync(new URL('../src/main/modules/export-image-manager.ts', import.meta.url), 'utf8');
const preloadApi = readFileSync(new URL('../src/preload/api.ts', import.meta.url), 'utf8');
const store = readFileSync(new URL('../src/renderer/stores/export-image-store.ts', import.meta.url), 'utf8');
const overlay = readFileSync(new URL('../src/renderer/components/chat/ExportImageOverlay.vue', import.meta.url), 'utf8');

check('export-runner report() 以 estimateExportPercent 回落（不再恒 0）', () => {
  assert.match(runner, /percent: partial\.percent \?\? estimateExportPercent\(/, 'report 缺 estimateExportPercent 回落');
});
check('X7（R13-F2）纯函数：进度构造 percent=-1 输入 → 输出钳 0（≥0）', () => {
  // makeProgressPayload 是 manager 本地 makeProgress 的导出纯函数同构体（shared/export-image.ts
  // 注释钉明）；负值 percent 输入必须被钳为 0——主进程侧钳制写在 `...partial` 展开前会先写后
  // 被覆盖成死代码（R13-F2 根因），纯函数钉住「合并之后钳制」的正确语义。
  const base = { jobId: 'j1', sessionId: 's1', sessionName: 'n', phase: 'planning' as const, page: 0, totalPages: 0, segment: 0, segmentsInPage: 0, message: 'm' };
  assert.equal(makeProgressPayload({ ...base, percent: -1 }).percent, 0, 'percent=-1 应钳 0');
  assert.equal(makeProgressPayload({ ...base, phase: 'preparing', percent: -7 }).percent, 0, '任意负值应钳 0');
  assert.ok(makeProgressPayload({ ...base, phase: 'capturing', page: 1, totalPages: 2, segment: 1, segmentsInPage: 1 }).percent >= 0, '缺省回落不得为负');
});
check('X7（R13-F2）report() 钳制位于 {...base, ...partial} 合并之后（-1 回落不再直通 IPC）', () => {
  // report() 无法被 tsx 直接 import（@shared 别名在 scripts 运行态不可解析），
  // 按本脚本既有风格钉源码结构：合并对象 → 钳制 → 以 merged 发送，三段缺一不可。
  const fnIdx = runner.indexOf('function report(');
  assert.ok(fnIdx > -1, 'export-runner 缺 report()');
  const endIdx = runner.indexOf('export async function runExport', fnIdx);
  const body = runner.slice(fnIdx, endIdx > -1 ? endIdx : fnIdx + 1200);
  const mergeIdx = body.indexOf('...partial,');
  assert.ok(mergeIdx > -1, 'report() 缺 ...partial 合并展开');
  const clampIdx = body.indexOf('merged.percent = Math.max(0, Math.min(100, merged.percent))');
  assert.ok(clampIdx > -1, '缺合并后钳制 merged.percent = Math.max(0, Math.min(100, merged.percent))');
  assert.ok(clampIdx > mergeIdx, '钳制必须位于 ...partial 合并之后（先合并再钳，防展开覆盖钳制值）');
  assert.match(body, /api\.reportProgress\(merged\)/, 'reportProgress 须发送合并并钳制后的 merged（旧内联字面量形态会绕过钳制）');
});
check('X7 followup（2026-10-07）manager makeProgress 钳制位于 ...partial 展开之后（主进程侧死钳制同修）', () => {
  // manager makeProgress 旧形态：`percent: percent < 0 ? 0 : percent, ...partial`——钳制写在
  // 展开之前，partial 携带负 percent（如 estimateExportPercent 的 -1 不确定态）时被覆盖成
  // 死代码。与 renderer report() 的 X7 形态同构：合并对象 → 钳 [0,100] → 以 merged 发送。
  const fnIdx = manager.indexOf('function makeProgress(');
  assert.ok(fnIdx > -1, 'manager 缺 makeProgress()');
  const endIdx = manager.indexOf('// —— 运行时校验 ——', fnIdx);
  const body = manager.slice(fnIdx, endIdx > -1 ? endIdx : fnIdx + 1200);
  const mergeIdx = body.indexOf('...partial,');
  assert.ok(mergeIdx > -1, 'makeProgress 缺 ...partial 合并展开');
  const clampIdx = body.indexOf('merged.percent = Math.max(0, Math.min(100, merged.percent))');
  assert.ok(clampIdx > -1, '缺合并后钳制 merged.percent = Math.max(0, Math.min(100, merged.percent))');
  assert.ok(clampIdx > mergeIdx, '钳制必须位于 ...partial 合并之后（先合并再钳，防展开覆盖钳制值）');
  assert.match(body, /emitProgress\(merged\)/, 'emitProgress 须发送合并并钳制后的 merged');
  assert.ok(!/percent: percent < 0 \? 0 : percent,/.test(body), '旧死钳制形态（展开前的内联 percent 钳制）不得残存');
});
check('IPC 通道 EXPORT_IMAGE_CANCEL 已登记', () => {
  assert.match(ipcTs, /EXPORT_IMAGE_CANCEL: 'export-image:cancel'/, 'ipc.ts 缺 EXPORT_IMAGE_CANCEL');
});
check('主进程注册 EXPORT_IMAGE_CANCEL handler + cancelJob（cancelled 终态 + cleanup）', () => {
  assert.match(manager, /ipcMain\.handle\(IPC_CHANNELS\.EXPORT_IMAGE_CANCEL/, 'manager 缺取消 handler');
  assert.match(manager, /async function cancelJob\(/, 'manager 缺 cancelJob');
  assert.match(manager, /phase: 'cancelled',[\s\S]{0,400}已取消导出/, 'cancelJob 缺 cancelled 终态进度');
  assert.match(manager, /ExportResults\.cancelled\(\)/, 'cancelJob 应 resolve ExportResults.cancelled()（对齐保存取消语义，不算失败）');
});
check('取消仅在捕获/编码阶段放行（保存链不抽走句柄）', () => {
  const idx = manager.indexOf('ipcMain.handle(IPC_CHANNELS.EXPORT_IMAGE_CANCEL');
  assert.ok(idx > -1, '缺取消 handler');
  const around = manager.slice(idx, idx + 800);
  // 白名单形态：cancellable 只列 preparing/planning/capturing/encoding——
  // waitingForDestination/saving（保存对话框/写盘期）与终态自然被排除。
  assert.match(around, /const cancellable =/, '缺 cancellable 白名单');
  for (const p of ["'preparing'", "'planning'", "'capturing'", "'encoding'"]) {
    assert.ok(around.includes(p), `白名单应含 ${p}`);
  }
  assert.ok(!around.includes("'waitingForDestination'") && !around.includes("'saving'"), '白名单不得含保存阶段');
});
check('preload 可见 API 暴露 cancelImageExport', () => {
  assert.match(preloadApi, /cancelImageExport: \(\) => Promise</, 'preload 接口缺 cancelImageExport 声明');
  assert.match(preloadApi, /cancelImageExport: \(\) => ipcRenderer\.invoke\(IPC_CHANNELS\.EXPORT_IMAGE_CANCEL\)/, 'preload 缺 cancelImageExport 实现');
});
check('store 提供 cancel action', () => {
  assert.match(store, /async cancel\(\): Promise<void>/, 'store 缺 cancel action');
});
check('P3-12：保存阶段进度不回零（转发处记录最近估算，两处 makeProgress 携带、封顶 99）', () => {
  // ① 追踪：EXPORT_RENDER_PROGRESS 转发处记录钳 [0,99] 的最近捕获/编码估算。
  //（区域边界用下一 handler 标记 EXPORT_RENDER_FINISH——handler 内 makeProgress({...});
  //  自带 "});"，以它截断会把随后的记录行切出区域。）
  const fwdIdx = manager.indexOf('IPC_CHANNELS.EXPORT_RENDER_PROGRESS');
  assert.ok(fwdIdx > -1, '缺进度转发 handler');
  const fwdBody = manager.slice(fwdIdx, manager.indexOf('EXPORT_RENDER_FINISH', fwdIdx));
  assert.match(fwdBody, /lastCapturePercent = Math\.max\(active\.lastCapturePercent,/, '转发处缺 lastCapturePercent 单调记录');
  assert.match(fwdBody, /Math\.min\(99,/, '记录须以 99 封顶（estimateExportPercent 口径：100 只属终态 done）');
  // ② ActiveJob 字段声明 + 构造初始化。
  assert.match(manager, /lastCapturePercent: number;/, 'ActiveJob 缺 lastCapturePercent 字段声明');
  assert.match(manager, /lastCapturePercent: 0,/, 'ActiveJob 构造缺 lastCapturePercent: 0 初始化');
  // ③ 发射：两个保存阶段 makeProgress 均携带 percent（缺省时 computeProgressPercent(totalSteps=0) 得 0 → 99%→0% 回零跳变）。
  const waitIdx = manager.indexOf("makeProgress({ phase: 'waitingForDestination'");
  assert.ok(waitIdx > -1, '缺 waitingForDestination 进度');
  assert.match(manager.slice(waitIdx, waitIdx + 400), /percent: active\.lastCapturePercent/, 'waitingForDestination 进度须携带最近估算 percent');
  const saveIdx = manager.indexOf("makeProgress({ phase: 'saving'");
  assert.ok(saveIdx > -1, '缺 saving 进度');
  assert.match(manager.slice(saveIdx, saveIdx + 400), /percent: job\.lastCapturePercent/, 'saving 进度须携带最近估算 percent（performSave 形参 job）');
});
check('NaN 加固：非数值 percent 不毒化 lastCapturePercent（isFinite 三目 + pct !== null 守卫内才更新）', () => {
  const fwdIdx = manager.indexOf('IPC_CHANNELS.EXPORT_RENDER_PROGRESS');
  assert.ok(fwdIdx > -1, '缺进度转发 handler');
  const fwdBody = manager.slice(fwdIdx, manager.indexOf('EXPORT_RENDER_FINISH', fwdIdx));
  // 守卫三目：Number.isFinite(payload.percent) ? 钳 [0,99] : null——NaN/Infinity/undefined 全落 null 分支。
  assert.match(fwdBody, /const pct = Number\.isFinite\(payload\.percent\) \? Math\.max\(0, Math\.min\(99, payload\.percent\)\) : null/, '缺 Number.isFinite 三目守卫——NaN 经 Math.min/max 复合链直接传染 lastCapturePercent');
  // 仅 pct !== null（有限数值）时才单调更新；非数值跳过整条记录语句、保持既有估算。
  assert.match(fwdBody, /if \(pct !== null\) active\.lastCapturePercent = Math\.max\(active\.lastCapturePercent, pct\)/, '缺 pct !== null 守卫内更新——非数值须跳过记录，不得写入 lastCapturePercent');
  // 「仅守卫内更新」：旧无守卫复合形态（Math.max 链直接吃 payload.percent）不得残存。
  assert.ok(!/lastCapturePercent = Math\.max\(active\.lastCapturePercent, Math\.max\(0,/.test(fwdBody), '仍存在守卫外的 NaN 可传染复合链形态');
});
check('Overlay 取消按钮（running 且未到 100% 显示，点击调 store.cancel）', () => {
  assert.match(overlay, /exportStore\.running && exportStore\.percent < 100/, '按钮显示条件不符');
  assert.match(overlay, /@click="exportStore\.cancel\(\)"/, '按钮未接 store.cancel');
});
check('P2-3：按钮 v-if 排除 waitingForDestination/saving（与主进程白名单对齐，不渲染死按钮）', () => {
  const m = overlay.match(/<button\s+v-if="([^"]+)"/);
  assert.ok(m, '缺取消按钮 v-if');
  const vif = m[1];
  assert.ok(vif.includes('exportStore.running') && vif.includes('exportStore.percent < 100'), '原显示条件（running 且 <100）须保留');
  assert.ok(vif.includes("exportStore.phase !== 'waitingForDestination'"), 'v-if 须排除 waitingForDestination（保存对话框期 cancel 返回 {ok:false} 被静默吞）');
  assert.ok(vif.includes("exportStore.phase !== 'saving'"), 'v-if 须排除 saving（写盘期同上，死按钮）');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
