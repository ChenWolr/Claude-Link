// scripts/cdp-update-e2e.mjs
// 应用内检查更新全链 E2E（本地 generic feed，不碰 GitHub）——v2（更新 UX 增强 2026-09-28）：
//   起 serve-update-feed（伪装 v99.0.0）→ 起 dist-electron/win-unpacked/claude-link.exe
//   （--user-data-dir 隔离 + --remote-debugging-port=9224 + CLAUDE_LINK_UPDATE_FEED_URL）
//   → E0 启动 ~5s 自动检查发现新版自动弹窗（R5+R2）→ 点「稍后提醒」→ E2 侧栏「可更新」徽标
//   → E3 点徽标直达设置关于 tab（最新版本行=feed 版本）→ E4 手动点「检查更新」弹窗重弹
//   （dismissed 不挡主动检查）→ E4b 关于页更新说明渲染态断言（ReleaseNotesView：真 h2/可点
//   链接/_blank+noopener，无标签直出、无 script/img 注入元素）→ E5 等 downloaded
//   → 点弹窗「立即重启更新」→ 断言 installing
//   + 应用进程退出 + NSIS 安装器进程出现 → taskkill 安装器收尾。
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

  await check('E0 启动自动检查（R5）：~5s 后发现新版自动弹窗（R2）', async () => {
    const visible = await waitFor(async () => evalExpr(ws,
      `(() => { const d = document.querySelector('[data-testid="update-dialog"]'); return !!d && d.offsetParent !== null; })()`), 15000);
    if (visible !== true) throw new Error('启动 15s 内弹窗未出现');
    const info = await evalExpr(ws, `window.claudeLink.getUpdateInfo()`);
    const status = info?.state?.status;
    if (!['available', 'downloading', 'downloaded'].includes(status)) throw new Error(`status=${status}（期望三态之一）`);
  });

  await check('E1 点「稍后提醒」→ 弹窗关闭', async () => {
    await evalExpr(ws, `document.querySelector('[data-testid="update-dialog-dismiss"]')?.click()`);
    const gone = await waitFor(async () => evalExpr(ws,
      `document.querySelector('[data-testid="update-dialog"]') === null`), 5000);
    if (gone !== true) throw new Error('点稍后后弹窗未关闭');
  });

  await check('E2 侧栏「可更新」徽标可见（R4）', async () => {
    const r = await evalExpr(ws,
      `(() => { const b = document.querySelector('[data-testid="update-badge"]'); return b ? { visible: b.offsetParent !== null, text: b.textContent.trim() } : null; })()`);
    if (!r || r.visible !== true) throw new Error('徽标不可见');
    if (!String(r.text).includes('可更新')) throw new Error(`徽标文本异常：${r.text}`);
  });

  await check('E3 点徽标直达设置→关于 tab，最新版本行 = feed 版本（R4+R3）', async () => {
    await evalExpr(ws, `document.querySelector('[data-testid="update-badge"]')?.click()`);
    const arrived = await waitFor(async () => {
      const hash = await evalExpr(ws, `window.location.hash`);
      return typeof hash === 'string' && hash.startsWith('#/config');
    }, 5000);
    if (arrived !== true) throw new Error('未跳转到 /config');
    const aboutVisible = await waitFor(async () => evalExpr(ws,
      `(() => { const s = document.querySelector('[data-testid="about-status"]'); return !!s && s.offsetParent !== null; })()`), 5000);
    if (aboutVisible !== true) throw new Error('关于 tab 未激活');
    const latest = await evalExpr(ws, `document.querySelector('[data-testid="about-latest-version"]')?.textContent?.trim()`);
    if (latest !== 'v99.0.0') throw new Error(`最新版本行=${latest}（期望 v99.0.0）`);
    const current = await evalExpr(ws, `document.querySelector('[data-testid="about-version"]')?.textContent?.trim()`);
    if (!/^v\d/.test(current || '')) throw new Error(`当前版本展示异常：${current}`);
  });

  await check('E4 手动点「检查更新」→ 弹窗重弹（dismissed 不挡主动检查）', async () => {
    // 前置：等首轮启动自动下载完成（downloaded 态才允许再次检查，主进程重入守卫放行）。
    const state = await waitFor(async () => {
      const info = await evalExpr(ws, `window.claudeLink.getUpdateInfo()`);
      return ['downloaded', 'error'].includes(info?.state?.status) ? info.state : null;
    }, 180000);
    if (state.status === 'error') throw new Error(`首轮下载失败：${state.error}`);
    const enabled = await evalExpr(ws, `document.querySelector('[data-testid="about-check-btn"]')?.disabled`);
    if (enabled !== false) throw new Error(`检查按钮不可点 disabled=${enabled}`);
    await evalExpr(ws, `document.querySelector('[data-testid="about-check-btn"]')?.click()`);
    const reopened = await waitFor(async () => evalExpr(ws,
      `(() => { const d = document.querySelector('[data-testid="update-dialog"]'); return !!d && d.offsetParent !== null; })()`), 30000);
    if (reopened !== true) throw new Error('手动检查后弹窗未重弹');
  });

  await check('E4b 更新说明渲染预览（真标题/可点链接，无标签直出、无注入元素）', async () => {
    const probe = await evalExpr(ws, `(() => {
      const box = document.querySelector('.about-notes');
      if (!box) return null;
      const h2 = box.querySelector('h2');
      return {
        hasH2: !!h2,
        h2Text: h2 ? h2.textContent : null,
        linkA: !!box.querySelector('a[href="https://example.com/a"]'),
        linkB: !!box.querySelector('a[href="https://example.com/b"]'),
        scripts: box.querySelectorAll('script').length,
        imgs: box.querySelectorAll('img').length,
        text: box.textContent || '',
        anchors: Array.from(box.querySelectorAll('a')).map((a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') })),
      };
    })()`);
    if (probe === null) throw new Error('关于页更新说明容器 .about-notes 不存在');
    if (probe.hasH2 !== true || probe.h2Text !== '修复（E2E 归一化验证）') throw new Error('h2 渲染态缺失或文本不符: ' + probe.h2Text);
    if (probe.linkA !== true) throw new Error('归一化链接未渲染为 a[href="https://example.com/a"]');
    if (probe.linkB !== true) throw new Error('显式 md 链接未渲染为 a[href="https://example.com/b"]');
    if (probe.scripts !== 0 || probe.imgs !== 0) throw new Error('注入元素残留: script=' + probe.scripts + ' img=' + probe.imgs);
    if (probe.text.includes('<h2') || probe.text.includes('<li')) throw new Error('标签直出回归: ' + probe.text.slice(0, 160));
    const badAnchor = probe.anchors.find((a) => a.target !== '_blank' || !/noopener/.test(a.rel || '') || !/noreferrer/.test(a.rel || ''));
    if (badAnchor) throw new Error('链接未强制 _blank+noopener/noreferrer: ' + JSON.stringify(badAnchor));
  });

  await check('E5 downloaded 后点弹窗「立即重启更新」→ installing → 应用退出 → NSIS 安装器进程出现（随即强杀收尾）', async () => {
    const state = await waitFor(async () => {
      const info = await evalExpr(ws, `window.claudeLink.getUpdateInfo()`);
      return ['downloaded', 'error'].includes(info?.state?.status) ? info.state : null;
    }, 180000);
    if (state.status === 'error') throw new Error(`二轮下载失败：${state.error}`);
    const installEnabled = await waitFor(async () => evalExpr(ws,
      `document.querySelector('[data-testid="update-dialog-install"]')?.disabled === false`), 30000);
    if (installEnabled !== true) throw new Error('「立即重启更新」按钮未就绪');
    await evalExpr(ws, `document.querySelector('[data-testid="update-dialog-install"]')?.click()`);
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
