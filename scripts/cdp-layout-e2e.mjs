// scripts/cdp-layout-e2e.mjs
// 布局回归门禁：验证配置页「内容列 800px 统一契约 + 高度自然填满」在窗口最大化/还原下成立，
// 消除此前 aspect-ratio:3/2 锁死导致的「最大化左右 letterboxing / 还原底部大留白」两态不一致。
//
// 用法：
//   1. 启动 Electron：npm run dev:cdp
//   2. 运行：node scripts/cdp-layout-e2e.mjs
//
// 退出协议（对齐 cdp-*-e2e 约定）：
//   exit 0：全部布局断言通过
//   exit 1：断言失败（实现回归）
//   exit 2：前置条件不满足（Electron/CDP 不可用）——「无法执行」，不算通过
//
// 说明：Electron dev 下 CDP 的 Browser domain 不可用（getWindowForTarget 未实现），
// 无法真正 setWindowBounds 改窗口尺寸；改用 Emulation.setDeviceMetricsOverride 模拟
// 宽/窄视口（等价于窗口 resize，直接驱动 100vw/100vh 与 flex 布局）。断言的是「相对契约」
// （列宽 ≤ 800px、工作区高度填满、三页列宽一致），不依赖窗口外框精确像素。

import { setTimeout as sleep } from 'node:timers/promises';

const CDP_PORT = 9223;
let pass = 0;
let fail = 0;
const log = (msg) => console.log(`[layout] ${msg}`);

async function check(name, fn) {
  try {
    await fn();
    pass++;
    log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    log(`  ❌ ${name} — ${e.message}`);
  }
}
class PreconditionError extends Error {}
function precondition(cond, message) {
  if (!cond) throw new PreconditionError(message);
}

async function getPageTarget() {
  const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  const targets = await resp.json();
  const page = targets.find((t) => t.type === 'page');
  return page ?? null;
}
function connectWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
  });
}
async function cdpCall(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1000000);
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        if (msg.error) reject(new Error('CDP: ' + JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalExpr(ws, expr) {
  const r = await cdpCall(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('Eval: ' + (r.exceptionDetails.exception?.description || '').slice(0, 300));
  return r.result?.value;
}

async function setViewport(ws, width, height) {
  await cdpCall(ws, 'Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(500);
}

async function readRects(ws) {
  return evalExpr(ws, `(() => {
    const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { w: b.width, h: b.height, top: b.top, bottom: b.bottom }; };
    return { workbench: r('.workbench'), stage: r('.stage'), composer: r('.chat-composer') };
  })()`);
}

async function enterConfig(ws) {
  await evalExpr(ws, `document.querySelector('.settings-link')?.click(), true`);
  await sleep(800);
  return evalExpr(ws, `!!document.querySelector('.workbench')`);
}
async function enterChat(ws) {
  await evalExpr(ws, `(() => {
    const l = document.querySelector('.session-link');
    if (l) { l.click(); return true; }
    const nb = document.querySelector('.new-button');
    if (nb) { nb.click(); return true; }
    return false;
  })()`);
  await sleep(800);
}

async function main() {
  console.log('=== CDP Layout E2E（配置页 800px 统一契约 + 高度填满）===');

  const page = await getPageTarget();
  precondition(page, `无法连接 CDP 端口 ${CDP_PORT}——先 npm run dev:cdp。无法执行，exit 2。`);
  const ws = await connectWS(page.webSocketDebuggerUrl);

  let hasBridge = false;
  for (let i = 0; i < 20; i++) {
    if (await evalExpr(ws, `typeof window.claudeLink === 'object'`)) { hasBridge = true; break; }
    await sleep(500);
  }
  precondition(hasBridge, 'preload bridge 不可用。无法执行，exit 2。');

  // 探测 Emulation 域可用性（Browser 域在 Electron dev 下不可用，改用 Emulation）。
  try {
    await cdpCall(ws, 'Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  } catch (e) {
    throw new PreconditionError('Emulation domain 不可用：' + e.message);
  }

  // 进入配置页（默认视口 1200×800）。
  const onConfig = await enterConfig(ws);
  precondition(onConfig, '未进入配置页（.workbench 不存在）。exit 2。');

  // ── L1：还原 1200×800 —— 工作区高度填满（无底部大留白）──
  await check('L1 还原 1200×800：.workbench 高度填满 .stage（底部无大留白）', async () => {
    await setViewport(ws, 1200, 800);
    const r = await readRects(ws);
    if (!r.workbench || !r.stage) throw new Error('workbench/stage 矩形缺失');
    const gap = r.stage.h - r.workbench.h;
    log(`     stage.h=${r.stage.h.toFixed(0)} workbench.h=${r.workbench.h.toFixed(0)} 底部余量=${gap.toFixed(0)}px`);
    if (gap > 8) throw new Error(`底部留白 ${gap.toFixed(0)}px > 8px（工作区未填满舞台高度）`);
  });

  // ── L2：最大化 1920×1080 —— 列宽收敛到 800px 契约（不再铺满 ~1168px）──
  await check('L2 最大化：.workbench 宽度收敛到 ≤804px（min(100%,800) 契约）', async () => {
    await setViewport(ws, 1920, 1080);
    const r = await readRects(ws);
    if (!r.workbench) throw new Error('workbench 矩形缺失');
    log(`     workbench.w=${r.workbench.w.toFixed(0)}px（契约 ≤800px）`);
    if (r.workbench.w > 804) throw new Error(`列宽 ${r.workbench.w.toFixed(0)}px > 804px（未收敛到 800px 契约，疑似仍铺满）`);
  });

  // ── L3：最大化 —— 配置页与聊天页内容列宽一致 ──
  await check('L3 最大化：配置 .workbench 与聊天 .chat-composer 列宽一致', async () => {
    const rConfig = await readRects(ws);
    await enterChat(ws);
    const rChat = await readRects(ws);
    const composerW = rChat.composer ? rChat.composer.w : null;
    if (!composerW) throw new Error('聊天页 .chat-composer 不存在');
    const diff = Math.abs((rConfig.workbench.w ?? 0) - composerW);
    log(`     config.workbench.w=${rConfig.workbench.w?.toFixed(0)} chat.composer.w=${composerW.toFixed(0)} 差=${diff.toFixed(0)}px`);
    if (diff > 8) throw new Error(`配置页/聊天页列宽差 ${diff.toFixed(0)}px > 8px（三页列宽契约不一致）`);
  });

  // ── 还原视口（清 Emulation override）──
  await cdpCall(ws, 'Emulation.clearDeviceMetricsOverride').catch(() => {});

  ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  if (e instanceof PreconditionError) {
    console.error(`\n前置条件不满足（无法执行，不算通过）：${e.message}`);
    process.exit(2);
  }
  console.error('FATAL:', e.message);
  process.exit(1);
});
