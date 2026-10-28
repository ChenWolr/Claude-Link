// scripts/cdp-update-e2e.mjs
// 应用内检查更新全链 E2E（本地 generic feed，不碰 GitHub）——v2（更新 UX 增强 2026-09-28）：
//   起 serve-update-feed（伪装 v99.0.0）→ 起 dist-electron/win-unpacked/claude-link.exe
//   （--user-data-dir 隔离 + --remote-debugging-port=9224 + CLAUDE_LINK_UPDATE_FEED_URL）
//   → E0 启动 ~5s 自动检查发现新版自动弹窗（R5+R2）→ 点「稍后提醒」→ E2 侧栏「可更新」徽标
//   → E3 点徽标直达设置关于 tab（最新版本行=feed 版本）→ E4 手动点「检查更新」弹窗重弹
//   （dismissed 不挡主动检查）→ E4b 关于页更新说明渲染态断言（ReleaseNotesView：真 h2/可点
//   链接/_blank+noopener，无标签直出、无 script/img 注入元素）→ E4c 弹窗更新说明不溢出
//   （autoHeight）/ E4c-2 矮视口 560px 三路径（缩窗重钳+展开 toggle 重钳+拖动后重钳）不越视口
//   → E5 等 downloaded
//   → 点弹窗「立即重启更新」→ 断言 installing
//   + 应用进程退出 + NSIS 安装器进程出现 → taskkill 安装器收尾。
// 前置：npm run package:win 已跑（dist-electron/win-unpacked/claude-link.exe 存在）；
//   dev 实例须关闭（单实例锁按 userData，已用 --user-data-dir 隔离，仍建议关闭减少干扰）。
// 用法：node scripts/cdp-update-e2e.mjs
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
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
async function screenshotPng(ws, file) {
  const r = await cdpCall(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(r.data, 'base64'));
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

  await check('E4c 弹窗更新说明不溢出（autoHeight：展开后 notes/footer 不出卡片、卡片不越视口）', async () => {
    // 复用 E4 手法保证弹窗在场：E4 已重弹则直接用；意外关闭则等 downloaded/error 后手动检查重弹。
    const dialogOpen = `(() => { const d = document.querySelector('[data-testid="update-dialog"]'); return !!d && d.offsetParent !== null; })()`;
    if ((await evalExpr(ws, dialogOpen)) !== true) {
      const state = await waitFor(async () => {
        const info = await evalExpr(ws, `window.claudeLink.getUpdateInfo()`);
        return ['downloaded', 'error'].includes(info?.state?.status) ? info.state : null;
      }, 180000);
      if (state.status === 'error') throw new Error(`重弹前置下载失败：${state.error}`);
      const enabled = await evalExpr(ws, `document.querySelector('[data-testid="about-check-btn"]')?.disabled`);
      if (enabled !== false) throw new Error(`检查按钮不可点 disabled=${enabled}`);
      await evalExpr(ws, `document.querySelector('[data-testid="about-check-btn"]')?.click()`);
      if ((await waitFor(async () => evalExpr(ws, dialogOpen), 30000)) !== true) throw new Error('手动检查后弹窗未重弹');
    }
    const expanded = await evalExpr(ws, `(() => {
      const d = document.querySelector('.update-dialog__notes');
      if (!d) return false;
      d.querySelector('summary')?.click();
      return d.open === true;
    })()`);
    if (expanded !== true) throw new Error('更新说明 details 不存在或未展开（弹窗缺 releaseNotes）');
    const m = await evalExpr(ws, `(() => {
      const card = document.querySelector('[data-testid="update-dialog"]');
      const notes = document.querySelector('.update-dialog__notes .release-notes');
      const dismiss = document.querySelector('[data-testid="update-dialog-dismiss"]');
      if (!card || !notes || !dismiss) return null;
      const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
      return { card: r(card), notes: r(notes), dismiss: r(dismiss), innerH: window.innerHeight };
    })()`);
    if (m === null) throw new Error('卡片/notes/dismiss 元素缺失');
    const bad = [];
    if (m.notes.bottom > m.card.bottom + 1) bad.push(`notes.bottom=${m.notes.bottom} 超出 card.bottom=${m.card.bottom}`);
    if (m.dismiss.bottom > m.card.bottom + 1) bad.push(`dismiss.bottom=${m.dismiss.bottom} 超出 card.bottom=${m.card.bottom}`);
    if (m.card.bottom > m.innerH - 4) bad.push(`card.bottom=${m.card.bottom} 越过视口 innerH=${m.innerH}`);
    if (m.card.top < 0) bad.push(`card.top=${m.card.top} 越出视口顶部`);
    if (bad.length > 0) {
      try { await screenshotPng(ws, 'E4c-notes-overflow.png'); } catch {}
      throw new Error(`更新说明溢出：${bad.join('；')}`);
    }
    // 分辨力护栏：fixture 30 条撑高后 notes 须内部滚动（scrollHeight > clientHeight≈180px），
    // 否则内容根本没逼近边界，本断言无法区分修复前后。
    const info = await evalExpr(ws, `(() => { const n = document.querySelector('.update-dialog__notes .release-notes'); return { scrollH: n.scrollHeight, clientH: n.clientHeight }; })()`);
    if ((info?.scrollH ?? 0) <= (info?.clientH ?? 0)) throw new Error(`fixture 撑高失效：notes scrollH=${info?.scrollH} clientH=${info?.clientH}（未内滚，E4c 无分辨力）`);
  });

  await check('E4c-2 矮视口（560px）下更新说明不越视口（缩窗重钳 + 展开重钳 + 拖动后重钳三路径）', async () => {
    // F1（round-001 审查 P2，round-002 fix-a）：E4c 只在默认 1200×800 跑，与矮视口越界带不相交；
    // 此处把视口压到 560px 高，验证「缩窗重钳（壳层 80ms + 组件 120ms 兜底）」「展开 @toggle → rAF
    // 重钳」「拖动后重钳（卡片头拖到视口下部再展开）」三条路径下 footer/notes 均不出视口。
    // 前置：弹窗在场（复用 E4c 手法）；details 保持展开态（E4c 已展开，若中途重弹则补展开）。
    const dialogOpen = `(() => { const d = document.querySelector('[data-testid="update-dialog"]'); return !!d && d.offsetParent !== null; })()`;
    if ((await evalExpr(ws, dialogOpen)) !== true) {
      const state = await waitFor(async () => {
        const info = await evalExpr(ws, `window.claudeLink.getUpdateInfo()`);
        return ['downloaded', 'error'].includes(info?.state?.status) ? info.state : null;
      }, 180000);
      if (state.status === 'error') throw new Error(`重弹前置下载失败：${state.error}`);
      const enabled = await evalExpr(ws, `document.querySelector('[data-testid="about-check-btn"]')?.disabled`);
      if (enabled !== false) throw new Error(`检查按钮不可点 disabled=${enabled}`);
      await evalExpr(ws, `document.querySelector('[data-testid="about-check-btn"]')?.click()`);
      if ((await waitFor(async () => evalExpr(ws, dialogOpen), 30000)) !== true) throw new Error('手动检查后弹窗未重弹');
    }
    const ensured = await evalExpr(ws, `(() => { const d = document.querySelector('.update-dialog__notes'); if (!d) return false; if (!d.open) d.querySelector('summary')?.click(); return d.open === true; })()`);
    if (ensured !== true) throw new Error('更新说明 details 不存在或未展开（弹窗缺 releaseNotes）');
    await sleep(300); // 等展开布局与 rAF 兜底稳定后再缩窗
    await cdpCall(ws, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 560, deviceScaleFactor: 1, mobile: false });
    // F2（R1 评审）：视口覆写后全部断言体包进 try，finally 兜底 clear——任一步 throw 时
    // 560px 视口不泄漏给 E5；clear 自身失败可吞（不掩盖原始用例失败）。
    try {
      const measure = `(() => {
        const card = document.querySelector('[data-testid="update-dialog"]');
        const notes = document.querySelector('.update-dialog__notes .release-notes');
        const dismiss = document.querySelector('[data-testid="update-dialog-dismiss"]');
        if (!card || !notes || !dismiss) return null;
        const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
        return { card: r(card), notes: r(notes), dismiss: r(dismiss), innerH: window.innerHeight };
      })()`;
      const badOf = (m) => {
        if (m === null) return ['卡片/notes/dismiss 元素缺失'];
        const bad = [];
        if (m.notes.bottom > m.card.bottom + 1) bad.push(`notes.bottom=${m.notes.bottom} 超出 card.bottom=${m.card.bottom}`);
        if (m.dismiss.bottom > m.card.bottom + 1) bad.push(`dismiss.bottom=${m.dismiss.bottom} 超出 card.bottom=${m.card.bottom}`);
        if (m.card.bottom > m.innerH - 4) bad.push(`card.bottom=${m.card.bottom} 越过视口 innerH=${m.innerH}`);
        if (m.card.top < 0) bad.push(`card.top=${m.card.top} 越出视口顶部`);
        return bad;
      };
      // 路径①（缩窗，details 已展开）：window resize → 壳层 80ms 重钳 + 本组件 120ms 真实盒兜底。
      let lastBad = ['等待超时'];
      try {
        await waitFor(async () => {
          const m = await evalExpr(ws, measure);
          lastBad = badOf(m);
          return lastBad.length === 0;
        }, 5000);
      } catch {
        try { await screenshotPng(ws, 'E4c2-short-viewport-overflow.png'); } catch {}
        throw new Error(`缩窗 560px 后仍越界：${lastBad.join('；')}`);
      }
      // 路径②（展开 toggle）：折叠→再展开，验证 @toggle → rAF 重钳路径（收起时 overBottom≤0 应 no-op 不抖动）。
      const collapsed = await evalExpr(ws, `(() => { const d = document.querySelector('.update-dialog__notes'); if (!d) return false; d.querySelector('summary')?.click(); return d.open === false; })()`);
      if (collapsed !== true) throw new Error('summary 点击后 details 未折叠');
      await sleep(300);
      const reexpanded = await evalExpr(ws, `(() => { const d = document.querySelector('.update-dialog__notes'); if (!d) return false; d.querySelector('summary')?.click(); return d.open === true; })()`);
      if (reexpanded !== true) throw new Error('summary 再次点击后 details 未展开');
      await sleep(300);
      const bad2 = badOf(await evalExpr(ws, measure));
      if (bad2.length > 0) {
        try { await screenshotPng(ws, 'E4c2-toggle-overflow.png'); } catch {}
        throw new Error(`矮视口下展开 toggle 后仍越界：${bad2.join('；')}`);
      }
      // 分辨力护栏：展开态 notes 须内滚（内容逼近边界，四断言才有分辨力）。
      const info2 = await evalExpr(ws, `(() => { const n = document.querySelector('.update-dialog__notes .release-notes'); return { scrollH: n.scrollHeight, clientH: n.clientHeight }; })()`);
      if ((info2?.scrollH ?? 0) <= (info2?.clientH ?? 0)) throw new Error(`fixture 撑高失效：notes scrollH=${info2?.scrollH} clientH=${info2?.clientH}（未内滚，E4c-2 无分辨力）`);
      // 路径③（拖动后重钳，R1-F3b）：折叠 → CDP 拖动卡片头到视口下部（dragRect 拖动中钳回，
      // 卡片贴视口底）→ 展开：此几何下卡片向下生长越过视口底，@toggle 修正分支 overBottom>0 必然真实执行。
      const collapsed3 = await evalExpr(ws, `(() => { const d = document.querySelector('.update-dialog__notes'); if (!d) return false; if (d.open) d.querySelector('summary')?.click(); return d.open === false; })()`);
      if (collapsed3 !== true) throw new Error('路径③ summary 点击后 details 未折叠');
      await sleep(300);
      const beforeDrag = await evalExpr(ws, measure);
      if (!beforeDrag) throw new Error('路径③拖动前卡片测量缺失');
      const headCenter = await evalExpr(ws, `(() => { const h = document.querySelector('.update-dialog__head'); if (!h) return null; const b = h.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      if (!headCenter) throw new Error('.update-dialog__head 不存在，无法构造拖动');
      const innerH3 = await evalExpr(ws, `window.innerHeight`);
      const toY = innerH3 - 24; // 接近视口底部
      const dragSteps = 8;
      await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(headCenter.x), y: Math.round(headCenter.y), button: 'left', buttons: 1, clickCount: 1 });
      await sleep(60);
      for (let i = 1; i <= dragSteps; i++) {
        await cdpCall(ws, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(headCenter.x),
          y: Math.round(headCenter.y + ((toY - headCenter.y) * i) / dragSteps),
          button: 'left', buttons: 1,
        });
        await sleep(30);
      }
      await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(headCenter.x), y: Math.round(toY), button: 'left', clickCount: 1 });
      await sleep(300); // 等 pointerup 兜底重钳（rAF）与拖动会话收尾稳定
      // 拖动效果护栏：卡片须被真实拖到视口下部（bottom 贴近视口底、top 明显下移），
      // 否则「拖动后展开」退化为路径②几何，路径③失去分辨力。
      const afterDrag = await evalExpr(ws, measure);
      if (!afterDrag) throw new Error('路径③拖动后卡片测量缺失');
      if (!(afterDrag.card.bottom > afterDrag.innerH - 40) || !(afterDrag.card.top > beforeDrag.card.top + 40)) {
        try { await screenshotPng(ws, 'E4c2-drag-noeffect.png'); } catch {}
        throw new Error(`拖动未生效：拖前 card.top=${beforeDrag.card.top} 拖后 card.top=${afterDrag.card.top} 拖后 card.bottom=${afterDrag.card.bottom} innerH=${afterDrag.innerH}（CDP 拖动序列未移动卡片）`);
      }
      // 展开 details（summary 再点击）→ @toggle → rAF 重钳，修正分支真实执行。
      const reexpanded3 = await evalExpr(ws, `(() => { const d = document.querySelector('.update-dialog__notes'); if (!d) return false; d.querySelector('summary')?.click(); return d.open === true; })()`);
      if (reexpanded3 !== true) throw new Error('路径③拖动后 summary 再次点击 details 未展开');
      await sleep(300);
      const bad3 = badOf(await evalExpr(ws, measure));
      if (bad3.length > 0) {
        try { await screenshotPng(ws, 'E4c2-drag-overflow.png'); } catch {}
        throw new Error(`拖动到视口下部后展开 toggle 仍越界：${bad3.join('；')}`);
      }
    } finally {
      try { await cdpCall(ws, 'Emulation.clearDeviceMetricsOverride'); } catch { /* 兜底清理失败不掩盖原始用例失败 */ }
    }
    // 收尾：视口恢复已在 finally 完成（用例中途失败也不把 560px 泄漏给 E5），
    // 这里只等壳层重钳后再进 E5（details 保持展开不影响 E5）。
    await sleep(500);
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
