// scripts/tdd-bugfix-hb12-export-ui-verify.ts
// hb12 P2-1（EXP-02/03/04）契约：导出 UI/进程杂项三件。
//
// EXP-02：export-image-store 上一 job 终态的 1.2s 复位定时器不随新 start() 取消——$reset() 丢句柄
// 却留活定时器，到点把新 job 的 preparing 态抹掉（遮罩闪烁消失）。修法：start() 进入时 clearTimeout。
//
// EXP-03：EXPORT_RENDER_PROGRESS 通道 active.phase = payload.phase 无白名单——受损 renderer 可毒化
// 主进程阶段机（captureSelfImpl 对终态拒捕）并提前收遮罩。修法：phase 白名单，白名单外忽略；
// 终态只认 EXPORT_RENDER_FINISH 事件。
//
// EXP-04（OPT）：sendToWorker 未传 transferList，每段 PNG（≤64MB）结构化克隆多一次全量拷贝。
// 修法：segment 消息走 transfer 路径 postMessage(msg, [msg.png])；types:351 契约本就声明
// 「png: ArrayBuffer // transferable」，实现与之对齐。
//
// 运行：npx tsx scripts/tdd-bugfix-hb12-export-ui-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const store = read('src/renderer/stores/export-image-store.ts');
const manager = read('src/main/modules/export-image-manager.ts');
const ipcTypes = read('src/shared/types/export-image.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① EXP-02：start() 进入时取消遗留复位定时器。
check('① EXP-02：start() 进入时 clearTimeout(this._timer)（新 job preparing 态不被上一 job 定时器抹掉）', () => {
  const startIdx = store.indexOf('async start(');
  const scheduleIdx = store.indexOf('scheduleReset(): void');
  assert.ok(startIdx > -1 && scheduleIdx > startIdx, '未定位到 start action');
  const body = store.slice(startIdx, scheduleIdx);
  const timerIdx = body.indexOf('clearTimeout(this._timer)');
  assert.ok(timerIdx > -1, 'start() 缺 clearTimeout(this._timer)');
  const resetIdx = body.indexOf('this.$reset()');
  assert.ok(resetIdx > timerIdx, 'clearTimeout 必须先于 $reset()（先取消遗留定时器再复位状态）');
});

// ② EXP-03：进度通道 phase 白名单，终态不在白名单（只认 EXPORT_RENDER_FINISH）。
check('② EXP-03：EXPORT_RENDER_PROGRESS phase 白名单（终态 done/cancelled/error 被排除）', () => {
  assert.match(manager, /EXPORT_PROGRESS_PHASES/, '缺 phase 白名单常量');
  for (const p of ['preparing', 'planning', 'capturing', 'encoding', 'saving', 'waitingForDestination']) {
    assert.match(manager, new RegExp(`'${p}'`), `白名单缺 ${p}`);
  }
  const wlIdx = manager.indexOf('EXPORT_PROGRESS_PHASES');
  const wlDecl = manager.slice(wlIdx, manager.indexOf(';', wlIdx));
  for (const t of ['done', 'cancelled', 'error']) {
    assert.ok(!wlDecl.includes(`'${t}'`), `终态 ${t} 不得进入进度白名单（终态只认 EXPORT_RENDER_FINISH）`);
  }
  const handlerIdx = manager.indexOf('IPC_CHANNELS.EXPORT_RENDER_PROGRESS');
  assert.ok(handlerIdx > -1, '未找到 EXPORT_RENDER_PROGRESS handler');
  const body = manager.slice(handlerIdx, manager.indexOf('EXPORT_RENDER_FINISH', handlerIdx));
  assert.match(body, /EXPORT_PROGRESS_PHASES\.has\(payload\.phase\)/, 'handler 缺白名单判据');
  const gateIdx = body.indexOf('EXPORT_PROGRESS_PHASES.has(payload.phase)');
  const assignIdx = body.indexOf('active.phase = payload.phase');
  assert.ok(assignIdx > gateIdx, 'phase 赋值必须位于白名单判据之后');
});

// ③ EXP-04：worker 消息 transfer 路径。
check('③ EXP-04：segment 消息 postMessage 带 transferList（[msg.png]），types 契约注释同步', () => {
  const sendIdx = manager.indexOf('async function sendToWorker');
  const sendEnd = manager.indexOf('\n}', sendIdx);
  const body = manager.slice(sendIdx, sendEnd > -1 ? sendEnd : undefined);
  assert.match(body, /postMessage\(msg, \[msg\.png\]\)/, 'segment 消息缺 transferList（结构化克隆多一次全量拷贝）');
  assert.match(body, /type === 'segment'/, 'transfer 分支缺 segment 类型判据（begin/finish/abort 无 png 不可 transfer）');
  assert.match(ipcTypes, /png: ArrayBuffer;\s*\/\/ transferable；主进程保证独立 ArrayBuffer/, 'types:351 transferable 契约注释缺失');
  const captureIdx = manager.indexOf('byteOffset-safe transfer');
  assert.ok(captureIdx > -1, 'pngCaptureSelfImpl 缺 transfer 注释（:332 契约一致性未同步）');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
