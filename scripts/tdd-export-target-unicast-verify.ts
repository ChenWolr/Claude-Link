// tdd-export-target-unicast-verify.ts
// P5b 双端互不弹窗/互不干扰契约钉（2026-10-24 用户问题5补丁，计划
// docs/plans/ 下 export-target-unicast 点 p1；round-001 裁定路径 A——单播实现改经
// push-bus 新原语 pushToWindow，不改 wiring 钉、零契约松动）。分组：
//   ① export-image-manager 静态：requestExportTarget 经 pushToWindow(win, ...) 只向发起端
//      单播 EXPORT_REQUEST_TARGET；全文件不再有 pushToMainWindow(...EXPORT_REQUEST_TARGET)
//      广播（桌面发起不再让网页端误弹「选择保存位置」；进度通道 EXPORT_IMAGE_PROGRESS 不动）；
//   ② export-image-store 静态：localStarted 本端发起标记——interface + state 工厂、start()
//      在 $reset() 之后置位（复位语义自洽）、applyProgress() 的 localStarted 守卫位于
//      迟到 jobId 丢弃判定之前（未发起的端不收养他端 job 的进度/完成文案）；
//      round-002 F1 修复钉：start 两个失败分支回置 localStarted（窗 b：error 驻留 1.2s
//      内不收养他端 job）+ applyProgress 终态-null 守卫（窗 a：他端 job 终态迟到竞态不收养）。
//   ③ App.vue 保留 onExportTargetRequested 订阅（桌面路径消费；网页端经 web-bridge 映射为
//      休眠路径，通道表完备性契约不允许删键，刻意不删）；
//   ④ push-bus 原语契约（round-001 裁定新增）：pushToWindow 导出存在、函数体纯直通
//      （webContents.send(channel 且不触 webSink——单播语义钉）、manager 全文件零裸
//      .webContents.send( 残留（对齐 tdd-web-access-wiring-verify.ts ③/:184 站点收口）。
// RED 预期（首轮改后树：manager 裸 webContents.send、push-bus 无 pushToWindow）：
// ① 第一条 + ④ 全 FAIL；②③ 与 ① 第二条 PASS。
// 运行：npx tsx scripts/tdd-export-target-unicast-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`);
  }
}

const manager = read('src/main/modules/export-image-manager.ts');
const storeSrc = read('src/renderer/stores/export-image-store.ts');
const appVue = read('src/renderer/App.vue');
const pushBus = read('src/main/modules/push-bus.ts');

// ── ① manager：EXPORT_REQUEST_TARGET 广播改单播 ──
console.log('=== ① export-image-manager：目标请求单播（不广播） ===');

check('requestExportTarget 函数体含 pushToWindow(win, IPC_CHANNELS.EXPORT_REQUEST_TARGET（经 push-bus 单播原语，只发发起端窗口）', () => {
  const fnStart = manager.indexOf('export async function requestExportTarget');
  const fnEnd = manager.indexOf('function isActive');
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'requestExportTarget 函数切片缺失');
  const body = manager.slice(fnStart, fnEnd);
  assert.ok(body.includes('pushToWindow(win, IPC_CHANNELS.EXPORT_REQUEST_TARGET'), 'requestExportTarget 缺 pushToWindow(win, ...) 单播');
});

check('全文件不含 pushToMainWindow(IPC_CHANNELS.EXPORT_REQUEST_TARGET（广播移除）；EXPORT_IMAGE_PROGRESS 推送不受影响', () => {
  assert.ok(!manager.includes('pushToMainWindow(IPC_CHANNELS.EXPORT_REQUEST_TARGET'), 'EXPORT_REQUEST_TARGET 仍在经推送总线广播到全部端');
  assert.ok(manager.includes('pushToMainWindow(IPC_CHANNELS.EXPORT_IMAGE_PROGRESS'), 'emitProgress 的 EXPORT_IMAGE_PROGRESS 推送不得受影响');
});

// ── ② store：localStarted 本端发起标记 + applyProgress 守卫 ──
console.log('=== ② export-image-store：localStarted 收养门 ===');

check('interface + state 工厂含 localStarted（boolean / false 初始）', () => {
  assert.match(storeSrc, /localStarted:\s*boolean/, 'interface ExportImageState 缺 localStarted: boolean');
  const factoryStart = storeSrc.indexOf('state: (): ExportImageState');
  const factoryEnd = storeSrc.indexOf('getters:');
  assert.ok(factoryStart > -1 && factoryEnd > factoryStart, 'state 工厂切片缺失');
  assert.ok(/localStarted:\s*false/.test(storeSrc.slice(factoryStart, factoryEnd)), 'state 工厂缺 localStarted: false');
});

check('start() 内 this.localStarted = true 存在且位于 this.$reset() 之后（复位后再置位，重复 start 语义自洽）', () => {
  const fnStart = storeSrc.indexOf('async start(');
  const fnEnd = storeSrc.indexOf('async cancel(', fnStart);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'start() 函数切片缺失');
  const body = storeSrc.slice(fnStart, fnEnd);
  const resetAt = body.indexOf('this.$reset()');
  const setAt = body.indexOf('this.localStarted = true');
  assert.ok(resetAt > -1, 'start() 缺 this.$reset()');
  assert.ok(setAt > -1, 'start() 缺 this.localStarted = true');
  assert.ok(setAt > resetAt, 'localStarted 置位必须位于 $reset() 之后（否则被工厂复位覆盖）');
});

check('applyProgress() 内 if (!this.localStarted) return; 位于迟到 jobId 丢弃判定之前（未发起端不收养他端 job）', () => {
  const fnStart = storeSrc.indexOf('applyProgress(payload');
  const fnEnd = storeSrc.indexOf('async start(', fnStart);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'applyProgress 函数切片缺失');
  const body = storeSrc.slice(fnStart, fnEnd);
  const guardAt = body.indexOf('if (!this.localStarted) return;');
  const staleAt = body.indexOf('payload.jobId !== this.jobId');
  assert.ok(guardAt > -1, 'applyProgress 缺 localStarted 守卫');
  assert.ok(staleAt > -1, 'applyProgress 缺迟到 jobId 丢弃判定');
  assert.ok(guardAt < staleAt, 'localStarted 守卫必须先于迟到 jobId 丢弃判定');
});

// round-002 F1 修复钉（窗 b + 窗 a）
check('start() 两个失败分支（!r.ok 与 catch）各含 this.localStarted = false;（失败回置，F1 窗 b）', () => {
  const fnStart = storeSrc.indexOf('async start(');
  const fnEnd = storeSrc.indexOf('async cancel(', fnStart);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'start() 函数切片缺失');
  const body = storeSrc.slice(fnStart, fnEnd);
  const count = (body.match(/this\.localStarted = false;/g) ?? []).length;
  assert.equal(count, 2, `start() 失败分支须恰 2 处 this.localStarted = false;（现状 ${count} 处）`);
});

check('applyProgress() 终态-null 守卫位于 localStarted 守卫之后、迟到 jobId 丢弃之前（F1 窗 a）', () => {
  const fnStart = storeSrc.indexOf('applyProgress(payload');
  const fnEnd = storeSrc.indexOf('async start(', fnStart);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'applyProgress 函数切片缺失');
  const body = storeSrc.slice(fnStart, fnEnd);
  const guardAt = body.indexOf('if (!this.localStarted) return;');
  const terminalAt = body.indexOf('!this.jobId && TERMINAL_PHASES.includes');
  const staleAt = body.indexOf('payload.jobId !== this.jobId');
  assert.ok(terminalAt > -1, 'applyProgress 缺终态-null 守卫（!this.jobId && TERMINAL_PHASES.includes）');
  assert.ok(guardAt > -1 && staleAt > -1, 'localStarted 守卫 / 迟到 jobId 丢弃缺失');
  assert.ok(guardAt < terminalAt && terminalAt < staleAt, '位序须为 localStarted 守卫 < 终态-null 守卫 < 迟到 jobId 丢弃');
});

// ── ③ App.vue：休眠订阅保留 ──
console.log('=== ③ App.vue：onExportTargetRequested 订阅保留 ===');

check('App.vue 仍含 onExportTargetRequested 订阅（桌面路径消费；web-bridge 通道表完备性契约不允许删键）', () => {
  assert.ok(appVue.includes('onExportTargetRequested'), 'App.vue 缺 onExportTargetRequested 订阅（不得删除）');
});

// ── ④ push-bus：pushToWindow origin 单播原语（round-001 裁定路径 A：不改 wiring 钉、改实现形态） ──
console.log('=== ④ push-bus：pushToWindow 单播原语（纯直通，不触 webSink） ===');

check('push-bus.ts 导出 pushToWindow（origin 单播原语）', () => {
  assert.match(pushBus, /export function pushToWindow\(/, 'push-bus 缺 pushToWindow 导出');
});

check('pushToWindow 函数体含 webContents.send(channel 且不含 webSink（单播语义：不广播到网页端；纯直通不吞异常）', () => {
  const fnStart = pushBus.indexOf('export function pushToWindow');
  assert.ok(fnStart > -1, 'pushToWindow 缺失');
  const nextExport = pushBus.indexOf('export ', fnStart + 10);
  const body = pushBus.slice(fnStart, nextExport > fnStart ? nextExport : undefined);
  assert.ok(body.includes('webContents.send(channel'), 'pushToWindow 缺 webContents.send(channel 直通发送');
  assert.ok(!body.includes('webSink'), 'pushToWindow 不得触 webSink（单播语义，广播即回退本点 bug）');
});

check('export-image-manager.ts 全文件零 .webContents.send( 残留（对齐 wiring :184 站点收口）', () => {
  assert.ok(!manager.includes('.webContents.send('), 'manager 仍有裸 .webContents.send( 站点（须改经 pushToWindow）');
});

process.exit(fail > 0 ? 1 : 0);
