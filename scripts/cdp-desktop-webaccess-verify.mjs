// scripts/cdp-desktop-webaccess-verify.mjs
// 「网页访问」桌面端设置页 9223 核验（F6 入库版；纯 CDP 原生，不依赖 computer-use 等 skill）。
//
// 用法（前置条件，编排器/复现者手动准备环境）：
//   1. npm run build
//   2. npx electron . --remote-debugging-port=9223   （应用运行；网页访问开关已开启）
//   3. node scripts/cdp-desktop-webaccess-verify.mjs
//
// 断言（证据截图落 docs/reports/web-e2e-screenshots/）：
//   ① location.hash='#/config' → 点「网页访问」页签 → DOM 断言：状态卡「运行中 · 端口 <port>」；
//      URL 列表（.webacc-urls li code）包含当场派生的 LAN IP 条目（主判定，V9：不再依赖
//      192.168 前缀，192.168 仅作辅助信息打印）且含 CGNAT（100.64.x）前缀 ≥1 条（期望 IP 由
//      node:os networkInterfaces() 程序派生，源码不硬编码本机 IP）；
//      二维码 img.webacc-qr 存在且 src 以 data:image 开头；启用开关 checked=true。
//   ② 截图前先 DOM 掩码：把 .webacc-urls li code 文本中 #token= 之后的内容替换为 ****
//      （断言已在前完成，截图仅供视觉留证）→ Page.captureScreenshot 落
//      desktop-9223-config-web.png。
//   ③ 开关拨关（DOM click [data-testid="web-access-section"] label.field--toggle
//      input[type="checkbox"]）→ 轮询 node:net connect 127.0.0.1:<port> 直到不通（≤15s）→
//      断言状态卡「未开启」→ 拨开 → 轮询恢复监听（≤15s）→ 状态卡恢复「运行中」→ 掩码后再截
//      desktop-9223-config-web-restored.png。任一步失败也会尽力把开关拨回开启（善后恢复）。
//
// 敏感纪律：port/token 从 %APPDATA%/claude-link/claude-link-config.json 读取
// （webAccess.port / 顶层 webAccessToken），一切输出掩码为前 4 后 4；本脚本无任何硬编码
// 本机 IP / 本机绝对路径。
// 退出码：0 = 全部通过；1 = 任一失败（含前置条件不满足）。

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CDP_PORT = 9223;
const CONFIG_PATH = path.join(process.env.APPDATA ?? '', 'claude-link', 'claude-link-config.json');
const SHOT_DIR = path.resolve('docs/reports/web-e2e-screenshots');

// ── 配置与掩码 ──
let rawConfig;
try { rawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { rawConfig = null; }
const PORT = rawConfig?.webAccess?.port ?? 8790;
const TOKEN = typeof rawConfig?.webAccessToken === 'string' ? rawConfig.webAccessToken : '';
const maskTok = () => (TOKEN ? `${TOKEN.slice(0, 4)}****${TOKEN.slice(-4)}` : '(无)');
const sanitize = (text) => (TOKEN ? String(text).split(TOKEN).join(maskTok()) : String(text));

function log(msg) {
  console.log(sanitize(`[${new Date().toISOString()}] ${msg}`));
}

// ── 结果记账 ──
const failures = [];
const steps = []; // {step, status, note}：全步骤流水，供总超时回溯打印
let currentStep = '(pre)';
function stepOk(step, note) { steps.push({ step, status: 'PASS', note }); log(`  [${step}] PASS ${note}`); }
function stepFail(step, note) { failures.push(step); steps.push({ step, status: 'FAIL', note }); log(`  [${step}] FAIL ${note}`); }

// V1：脚本级总超时兜底（对齐 scripts/web-access-e2e-probe.ts 的 TOTAL_TIMEOUT_MS 做法）。
const TOTAL_TIMEOUT_MS = 300_000;
const totalTimer = setTimeout(() => {
  log(`[总超时] ${TOTAL_TIMEOUT_MS}ms 到，脚本自杀退出（防挂死）`);
  log('==== 超时时刻已完成步骤 ====');
  for (const s of steps) log(`  ${s.step}: ${s.status} ${s.note}`);
  log(`==== 汇总：总超时自杀；此前失败 ${failures.length} 处${failures.length > 0 ? `（${failures.join(', ')}）` : ''} ====`);
  process.exit(1);
}, TOTAL_TIMEOUT_MS);
totalTimer.unref();

// ── 本机网卡派生（与 scripts/cdp-web-access-e2e.mjs F10 同款逻辑）──
function deriveLanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.internal || iface.family !== 'IPv4') continue;
      // 排除 100.64.0.0/10 CGNAT 段（Tailscale）——那是 deriveCgnatIp 的职责。
      const p = iface.address.split('.').map(Number);
      if (p.length === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127) continue;
      return iface.address;
    }
  }
  return null;
}
function deriveCgnatIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.internal || iface.family !== 'IPv4') continue;
      const p = iface.address.split('.').map(Number);
      if (p.length === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127) return iface.address;
    }
  }
  return null;
}

// ── CDP 基础（写法对齐 scripts/cdp-real-window-e2e.mjs）──
async function getPageTarget() {
  const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  const targets = await resp.json();
  return targets.find((t) => t.type === 'page') ?? null;
}
// N3：连接阶段独立 10s 超时（与下方 30s 调用超时同风格），超时即 reject，不依赖总看门狗回收。
const WS_CONNECT_TIMEOUT_MS = 10_000;
function connectWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* 尽力而为 */ }
      reject(new Error(`WebSocket 连接超时（${WS_CONNECT_TIMEOUT_MS / 1000}s）：${url}`));
    }, WS_CONNECT_TIMEOUT_MS);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`WebSocket 连接失败：${url}`)); });
  });
}
const CDP_CALL_TIMEOUT_MS = 30_000;
let cdpDead = false;
const inflightCalls = new Set(); // { handler, reject, timer }：在飞调用登记，供断连时统一 reject
async function cdpCall(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1000000);
  return new Promise((resolve, reject) => {
    if (cdpDead) { reject(new Error('CDP WebSocket 已断开，拒绝新调用')); return; }
    const entry = { handler: null, reject, timer: null };
    entry.timer = setTimeout(() => {
      ws.removeEventListener('message', entry.handler);
      inflightCalls.delete(entry);
      reject(new Error(`CDP 调用超时（${CDP_CALL_TIMEOUT_MS / 1000}s）：${method}`));
    }, CDP_CALL_TIMEOUT_MS);
    entry.handler = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id === id) {
        clearTimeout(entry.timer);
        ws.removeEventListener('message', entry.handler);
        inflightCalls.delete(entry);
        if (msg.error) reject(new Error('CDP: ' + JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    inflightCalls.add(entry);
    ws.addEventListener('message', entry.handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function killAllCdpCalls(ws, reason) {
  cdpDead = true;
  for (const entry of inflightCalls) {
    clearTimeout(entry.timer);
    ws.removeEventListener('message', entry.handler);
    entry.reject(new Error(`${reason}（未完成调用被拒绝）`));
  }
  inflightCalls.clear();
}
async function evalExpr(ws, expr) {
  const r = await cdpCall(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('Eval: ' + (r.exceptionDetails.exception?.description || '').slice(0, 300));
  return r.result?.value;
}
async function evalOk(ws, expr) { return (await evalExpr(ws, expr)) === true; }
async function waitFor(label, fn, timeoutS = 15, intervalMs = 250) {
  const deadline = Date.now() + timeoutS * 1000;
  let lastErr = '';
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e.message; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时（${timeoutS}s）：${label}${lastErr ? `；最后错误：${lastErr}` : ''}`);
}
async function screenshot(ws, name) {
  const r = await cdpCall(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(r.data, 'base64'));
  log(`  截图落盘 ${name}.png`);
}

// ── TCP 探测 ──
function tcpReachable(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: timeoutMs });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

// ── DOM 断言/操作（模板真相源：src/renderer/pages/ConfigPage.vue web tab）──
const maskUrlsExpr = `(() => {
  document.querySelectorAll('.webacc-urls li code').forEach((el) => {
    const t = el.textContent || '';
    const i = t.indexOf('#token=');
    if (i >= 0) el.textContent = t.slice(0, i + '#token='.length) + '****';
  });
  return true;
})()`;
const runningLineExpr = `(() => {
  const el = document.querySelector('.webacc-status .webacc-status__line--ok');
  if (!el) return null;
  return (el.textContent || '').replace(/\\s+/g, ' ');
})()`;
const statusTextExpr = `(() => {
  const el = document.querySelector('.webacc-status');
  return el ? (el.textContent || '').replace(/\\s+/g, ' ') : '';
})()`;

async function assertRunningCard(ws, step, note) {
  const line = await waitFor(`状态卡「运行中 · 端口 ${PORT}」`, () => evalExpr(ws, runningLineExpr).then((t) => (t && t.includes(`运行中 · 端口 ${PORT}`) ? t : null)), 15);
  stepOk(step, `${note}：状态卡「${line.trim()}」`);
}

async function main() {
  log(`==== desktop 9223 webaccess 核验开始（端口=${PORT} token=${maskTok()}）====`);
  const lanIp = deriveLanIp();
  const cgnatIp = deriveCgnatIp();
  log(`网卡派生：WLAN=${lanIp ?? '(未发现)'} CGNAT=${cgnatIp ?? '(未发现)'}`);

  // ── 前置条件 ──
  if (TOKEN.length === 0) throw new Error(`配置 ${CONFIG_PATH} 顶层键 webAccessToken 缺失或为空`);
  const target = await getPageTarget();
  if (!target) throw new Error(`无法连接 CDP 端口 ${CDP_PORT}——前置：npm run build + npx electron . --remote-debugging-port=${CDP_PORT}`);
  const ws = await connectWS(target.webSocketDebuggerUrl);
  // V1：通道一断全部在飞 cdpCall 立即 reject，并拒绝后续新调用（防 CDP 中断后脚本永挂）。
  ws.addEventListener('close', () => killAllCdpCalls(ws, 'CDP WebSocket 已关闭'));
  ws.addEventListener('error', () => killAllCdpCalls(ws, 'CDP WebSocket 错误'));
  await cdpCall(ws, 'Runtime.enable');
  await cdpCall(ws, 'Page.enable');
  log(`已连接应用 CDP 9223（target=${target.url}）`);

  // ── ① 导航设置页 → 点「网页访问」页签 → DOM 断言 ──
  currentStep = 'D1';
  try {
    await evalExpr(ws, `location.hash = '#/config', true`);
    await waitFor('设置页 tabs 渲染', () => evalOk(ws, `(() => { const el = document.querySelector('.tabs'); return !!el && !!(el.offsetParent || el.getClientRects().length); })()`), 15);
    await evalExpr(ws, `[...document.querySelectorAll('.tabs .tab')].find((b) => (b.textContent || '').trim() === '网页访问')?.click(), true`);
    await waitFor('「网页访问」页签激活且分区可见', () => evalOk(ws, `(() => {
      const tab = [...document.querySelectorAll('.tabs .tab')].find((b) => (b.textContent || '').trim() === '网页访问');
      const sec = document.querySelector('[data-testid="web-access-section"]');
      return !!tab && tab.classList.contains('tab--active') && !!sec && !!(sec.offsetParent || sec.getClientRects().length);
    })()`), 10);
    await assertRunningCard(ws, 'D1', '网页访问运行中');
    const urls = await waitFor('URL 列表出现', () => evalExpr(ws, `[...document.querySelectorAll('.webacc-urls li code')].map((el) => el.textContent || '')`).then((a) => (Array.isArray(a) && a.length > 0 ? a : null)), 10);
    // V9：主判定改为「URL 列表包含当场派生的 LAN IP」（10.x/172.16-31 私网同样成立）；
    // 192.168 前缀不再参与判定，仅作辅助信息打印。
    const lanListed = lanIp ? urls.some((u) => u.startsWith(`http://${lanIp}:`)) : null;
    if (!lanIp) {
      stepFail('D1', '本机未派生出 LAN IP（networkInterfaces 无非 internal 非 CGNAT IPv4），无法执行主判定');
    } else if (!lanListed) {
      stepFail('D1', `URL 列表未包含当场派生的 LAN IP ${lanIp}（列表 ${urls.length} 条）`);
    } else {
      const has192 = urls.some((u) => /^http:\/\/192\.168\.\d+\.\d+:\d+\//.test(u));
      log(`  辅助信息：派生 LAN IP ${lanIp} 在列；192.168 前缀条目${has192 ? ' ≥1 条' : ' 0 条（非 192.168 私网段，仅信息、不参与判定）'}`);
    }
    const hasCgnat = urls.some((u) => /^http:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+:\d+\//.test(u));
    const cgnatListed = cgnatIp ? urls.some((u) => u.startsWith(`http://${cgnatIp}:`)) : null;
    if (!hasCgnat) stepFail('D1', `URL 列表无 CGNAT（100.64.x）前缀条目（列表 ${urls.length} 条）`);
    else log(`  URL 列表含 CGNAT 前缀 ≥1 条${cgnatIp ? `（含派生 ${cgnatIp}：${cgnatListed ? '是' : '否——前缀判定为准'}）` : ''}`);
    if (lanIp && lanListed && hasCgnat) stepOk('D1', `URL 列表 ${urls.length} 条，含派生 LAN IP ${lanIp} + CGNAT 前缀 ≥1（token 已在 ② 掩码，此处不打印 URL 全文）`);
    const qrOk = await evalOk(ws, `(() => { const img = document.querySelector('img.webacc-qr'); return !!img && typeof img.src === 'string' && img.src.startsWith('data:image'); })()`);
    if (!qrOk) stepFail('D1', '二维码 img.webacc-qr 缺失或 src 非 data:image 开头');
    else stepOk('D1', '二维码 img.webacc-qr 存在且 src 以 data:image 开头');
    const checked = await evalOk(ws, `(() => { const el = document.querySelector('[data-testid="web-access-section"] label.field--toggle input[type="checkbox"]'); return !!el && el.checked === true; })()`);
    if (!checked) stepFail('D1', '启用开关未处于 checked=true');
    else stepOk('D1', '启用开关 checked=true');
  } catch (e) { stepFail('D1', e.message); }

  // ── ② DOM 掩码 → 截图 ──
  currentStep = 'D2';
  try {
    await evalExpr(ws, maskUrlsExpr);
    await screenshot(ws, 'desktop-9223-config-web');
    stepOk('D2', '掩码后截图 desktop-9223-config-web.png');
  } catch (e) { stepFail('D2', e.message); }

  // ── ③ 开关拨关 → 端口不通 + 「未开启」→ 拨开 → 恢复监听 + 「运行中」→ 掩码再截 ──
  currentStep = 'D3';
  const toggleExpr = `document.querySelector('[data-testid="web-access-section"] label.field--toggle input[type="checkbox"]')?.click(), true`;
  try {
    await evalExpr(ws, toggleExpr);
    await waitFor(`127.0.0.1:${PORT} 监听停止（≤15s）`, async () => !(await tcpReachable(PORT)), 15, 250);
    stepOk('D3', '拨关后 TCP 探测不通');
    await waitFor('状态卡「未开启」', () => evalExpr(ws, statusTextExpr).then((t) => (t.includes('未开启') ? t : null)), 15);
    stepOk('D3', '状态卡转为「未开启」');
    await evalExpr(ws, toggleExpr);
    await waitFor(`127.0.0.1:${PORT} 监听恢复（≤15s）`, () => tcpReachable(PORT), 15, 250);
    stepOk('D3', '拨开后 TCP 探测恢复连通');
    await assertRunningCard(ws, 'D3', '开关恢复后');
    await evalExpr(ws, maskUrlsExpr);
    await screenshot(ws, 'desktop-9223-config-web-restored');
    stepOk('D3', '掩码后截图 desktop-9223-config-web-restored.png');
  } catch (e) {
    stepFail('D3', e.message);
    // 善后：失败也尽力把开关拨回开启，不留「网页访问被测试关闭」的现场。
    try {
      const stillOff = await evalOk(ws, `(() => { const el = document.querySelector('[data-testid="web-access-section"] label.field--toggle input[type="checkbox"]'); return !!el && el.checked === false; })()`);
      if (stillOff) {
        await evalExpr(ws, toggleExpr);
        await waitFor('善后：监听恢复', () => tcpReachable(PORT), 15, 250);
        log('  善后：已把网页访问开关拨回开启');
      }
    } catch (e2) { log(`  善后拨回失败（需人工确认开关状态）：${e2.message}`); }
  }

  log(`==== 汇总：${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 处（${failures.join(', ')}）`} ====`);
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(sanitize(`[运行错误] ${e?.stack || e}`));
  process.exit(1);
});
