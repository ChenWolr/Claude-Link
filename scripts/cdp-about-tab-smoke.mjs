// scripts/cdp-about-tab-smoke.mjs
// 关于 tab dev 冒烟：v1 仅验证「设置→关于 tab 可达、版本号展示、开发模式 unavailable、
// 检查按钮禁用」。更新全链（available→downloading→downloaded→installing）在
// cdp-update-e2e.mjs 的打包实例上验证。
// 用法：1) npm run dev:cdp  2) node scripts/cdp-about-tab-smoke.mjs
import { readFileSync } from 'node:fs';

const CDP_PORT = 9223;
let pass = 0, fail = 0;
const log = (m) => console.log(`[about-smoke] ${m}`);
async function check(name, fn) {
  try { await fn(); pass++; log(`  ✅ ${name}`); }
  catch (e) { fail++; log(`  ❌ ${name} — ${e.message}`); }
}
class PreconditionError extends Error {}
async function getPageTarget() {
  const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  const targets = await resp.json();
  return targets.find((t) => t.type === 'page') ?? null;
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
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
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

try {
  const target = await getPageTarget();
  if (!target) throw new PreconditionError('CDP 无 page target（先 npm run dev:cdp）');
  const ws = await connectWS(target.webSocketDebuggerUrl);

  await check('A1 导航到设置页并切「关于」tab', async () => {
    await evalExpr(ws, `window.location.hash = '#/config'`);
    await new Promise((r) => setTimeout(r, 800));
    const clicked = await evalExpr(ws,
      `(() => { const b = [...document.querySelectorAll('.tab')].find(x => x.textContent.trim() === '关于'); if (!b) return false; b.click(); return true; })()`);
    if (clicked !== true) throw new Error('未找到「关于」tab 按钮');
    await new Promise((r) => setTimeout(r, 500));
  });

  await check('A2 版本号展示 = package.json version', async () => {
    const expected = 'v' + JSON.parse(readFileSync('package.json', 'utf8')).version;
    const text = await evalExpr(ws, `document.querySelector('[data-testid="about-version"]')?.textContent?.trim()`);
    if (text !== expected) throw new Error(`期望 ${expected}，实际 ${text}`);
  });

  await check('A3 开发模式 unavailable 提示', async () => {
    const text = await evalExpr(ws, `document.querySelector('[data-testid="about-status"]')?.textContent?.trim()`);
    if (!text || !text.includes('开发模式下不可用')) throw new Error(`实际：${text}`);
  });

  await check('A4 检查按钮禁用（dev 不可点）', async () => {
    const disabled = await evalExpr(ws, `document.querySelector('[data-testid="about-check-btn"]')?.disabled`);
    if (disabled !== true) throw new Error(`disabled=${disabled}`);
  });

  await check('A5 store 直查 status=unavailable（不经 DOM）', async () => {
    const info = await evalExpr(ws, `window.claudeLink.getUpdateInfo()`);
    if (info?.state?.status !== 'unavailable') throw new Error(`实际 status=${info?.state?.status}`);
    if (typeof info?.currentVersion !== 'string' || !info.currentVersion) throw new Error('currentVersion 缺失');
  });
} catch (e) {
  if (e instanceof PreconditionError) { log(`前置不满足：${e.message}`); process.exit(2); }
  log(`异常：${e.message}`); process.exit(1);
}
log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
