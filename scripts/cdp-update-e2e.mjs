// scripts/cdp-update-e2e.mjs
// 应用内检查更新全链 E2E（本地 generic feed，不碰 GitHub）：
//   起 serve-update-feed（伪装 v99.0.0）→ 起 dist-electron/win-unpacked/claude-link.exe
//   （--user-data-dir 隔离 + --remote-debugging-port=9224 + CLAUDE_LINK_UPDATE_FEED_URL）
//   → CDP 进设置页关于 tab → 点「检查更新」→ 轮询 state 至 downloaded → 断言「重启更新」按钮
//   → 点击 → 断言 installing + 应用进程退出 + NSIS 安装器进程出现 → taskkill 安装器收尾。
// 前置：npm run package:win 已跑（dist-electron/win-unpacked/claude-link.exe 存在）；
//   dev 实例须关闭（单实例锁按 userData，已用 --user-data-dir 隔离，仍建议关闭减少干扰）。
// 用法：node scripts/cdp-update-e2e.mjs
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CDP_PORT = 9224;
const FEED_PORT = 8788;
const EXE = 'dist-electron/win-unpacked/claude-link.exe';
const ISO_DIR = 'D:/software/Cache/claude-link-update-e2e-userdata';
let pass = 0, fail = 0;
const log = (m) => console.log(`[update-e2e] ${m}`);
async function check(name, fn) {
  try { await fn(); pass++; log(`  ✅ ${name}`); }
  catch (e) { fail++; log(`  ❌ ${name} — ${e.message}`); }
}
class PreconditionError extends Error {}
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
async function waitFor(fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  throw new Error(`等待超时（${timeoutMs}ms）`);
}

let feedProc = null, appProc = null, ws = null;
async function cleanup() {
  try { ws?.close(); } catch {}
  // F3（R1 评审）：按 PID 树杀本脚本拉起的实例。原先 process.kill(-pid) 在 Windows 恒为死代码，
  // 兜底 taskkill /IM claude-link.exe 会误杀用户日常运行的同名实例——一并移除。
  if (appProc && appProc.exitCode === null) {
    try { spawnSync('taskkill', ['/PID', String(appProc.pid), '/T', '/F'], { encoding: 'utf8' }); } catch {}
  }
  try { const r2 = spawnSync('tasklist', ['/FO', 'CSV'], { encoding: 'utf8' });
    const m = r2.stdout?.split('\n').find((l) => /claude-link-.*-setup\.exe/i.test(l));
    if (m) { const name = m.match(/"([^"]+setup\.exe)"/i)?.[1]; if (name) spawnSync('taskkill', ['/IM', name, '/F'], { encoding: 'utf8' }); } } catch {} // 按名杀版本化 setup.exe：quitAndInstall 拉起的安装器非本脚本子进程，拿不到 PID。
  if (feedProc) { try { feedProc.kill(); } catch {} }
  try { rmSync(ISO_DIR, { recursive: true, force: true }); } catch {}
}

try {
  if (!existsSync(EXE)) throw new PreconditionError(`未找到 ${EXE}（先 npm run package:win）`);
  rmSync(ISO_DIR, { recursive: true, force: true });

  feedProc = spawn(process.execPath, ['scripts/serve-update-feed.mjs', '--dir', 'dist-electron', '--port', String(FEED_PORT)], { stdio: 'inherit' });
  await waitFor(async () => { try { const r = await fetch(`http://127.0.0.1:${FEED_PORT}/latest.yml`); return r.ok; } catch { return false; } }, 10000);
  log(`feed 就绪：http://127.0.0.1:${FEED_PORT}/`);

  appProc = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${ISO_DIR}`], {
    env: { ...process.env, CLAUDE_LINK_UPDATE_FEED_URL: `http://127.0.0.1:${FEED_PORT}/` },
    stdio: 'ignore', detached: true,
  });
  const target = await waitFor(async () => {
    try { const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`); const ts = await resp.json(); return ts.find((t) => t.type === 'page') ?? null; } catch { return null; }
  }, 30000);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', () => reject(new Error('WS connect failed'))); });
  log('打包实例 CDP 已连接');

  await check('B1 打包实例初始态：版本展示 + idle', async () => {
    await evalExpr(ws, `window.location.hash = '#/config'`);
    await sleep(1000);
    await evalExpr(ws, `(() => { const b = [...document.querySelectorAll('.tab')].find(x => x.textContent.trim() === '关于'); if (!b) throw new Error('无关于 tab'); b.click(); })()`);
    await sleep(600);
    const info = await evalExpr(ws, `window.claudeLink.getUpdateInfo()`);
    if (info?.state?.status !== 'idle') throw new Error(`初始 status=${info?.state?.status}（期望 idle）`);
    const text = await evalExpr(ws, `document.querySelector('[data-testid="about-version"]')?.textContent?.trim()`);
    if (!/^v\d/.test(text || '')) throw new Error(`版本展示异常：${text}`);
  });

  await check('B2 点「检查更新」→ available → downloading → downloaded', async () => {
    await evalExpr(ws, `document.querySelector('[data-testid="about-check-btn"]')?.click()`);
    const state = await waitFor(async () => {
      const info = await evalExpr(ws, `window.claudeLink.getUpdateInfo()`);
      return ['downloaded', 'error'].includes(info?.state?.status) ? info.state : null;
    }, 180000);
    if (state.status === 'error') throw new Error(`下载失败：${state.error}`);
    if (state.newVersion !== '99.0.0') throw new Error(`newVersion=${state.newVersion}`);
  });

  await check('B3 downloaded 态 UI：「重启更新」按钮可见', async () => {
    const visible = await evalExpr(ws,
      `(() => { const b = document.querySelector('[data-testid="about-install-btn"]'); return !!b && b.offsetParent !== null; })()`);
    if (visible !== true) throw new Error('安装按钮不可见');
    const text = await evalExpr(ws, `document.querySelector('[data-testid="about-status"]')?.textContent?.trim()`);
    if (!text?.includes('99.0.0')) throw new Error(`状态文案缺版本号：${text}`);
  });

  await check('B4 点「重启更新」→ installing → 应用退出 → NSIS 安装器进程出现（随即强杀收尾）', async () => {
    await evalExpr(ws, `document.querySelector('[data-testid="about-install-btn"]')?.click()`);
    await waitFor(async () => appProc.exitCode !== null, 30000).catch(() => {});
    const installer = await waitFor(() => {
      const r = spawnSync('tasklist', ['/FO', 'CSV'], { encoding: 'utf8' });
      return /claude-link-.*-setup\.exe/i.test(r.stdout || '') ? r.stdout.match(/"([^"]*claude-link-[^"]*setup\.exe)"/i)?.[1] : null;
    }, 30000).catch(() => null);
    if (!installer) throw new Error('未观测到 NSIS 安装器进程');
    log(`安装器进程：${installer}（E2E 到此为止，强杀收尾不真装）`);
  });
} catch (e) {
  if (e instanceof PreconditionError) { log(`前置不满足：${e.message}`); await cleanup(); process.exit(2); }
  log(`异常：${e.message}`); await cleanup(); process.exit(1);
}
await cleanup();
log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
