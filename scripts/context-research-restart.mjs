// scripts/context-research-restart.mjs
// Task 6 S12：restart/resume 黑盒验证（两阶段，中间需重启 Electron）。
//   phase=persist：建会话 + 发消息 + 记录 session name/cliSessionId/lastContextTokens/lastContextWindow，不删会话。
//   phase=resume ：重启后找到该会话，切到它，采 contextStats 与 DOM，验证是否把 last-known 伪装成 fresh。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CDP_PORT = 9223;
const OUT = 'D:/software/Cache/claude-link/context-research/run-2026-08-21-205616';
const MARKER = 'S12-restart-marker.json';
const SESSION_NAME = 'S12-restart-resume-probe';

async function getPageTarget() { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json`); const t = await r.json(); return t.find((x) => x.type === 'page') ?? null; }
function connectWS(url) { return new Promise((res, rej) => { const ws = new WebSocket(url); ws.addEventListener('open', () => res(ws)); ws.addEventListener('error', () => rej(new Error('ws fail'))); }); }
async function cdpCall(ws, method, params = {}) { const id = Math.floor(Math.random() * 1e6); return new Promise((res, rej) => { const h = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m.id === id) { ws.removeEventListener('message', h); if (m.error) rej(new Error('CDP: ' + JSON.stringify(m.error))); else res(m.result); } }; ws.addEventListener('message', h); ws.send(JSON.stringify({ id, method, params })); }); }
async function evalExpr(ws, expr) { const r = await cdpCall(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('Eval: ' + (r.exceptionDetails.exception?.description || '').slice(0, 300)); return r.result?.value; }
async function evalOk(ws, expr) { return (await evalExpr(ws, expr)) === true; }
async function waitFor(label, fn, t = 60, iv = 500) { const dl = Date.now() + t * 1000; while (Date.now() < dl) { try { const v = await fn(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, iv)); } throw new Error('timeout ' + label); }
async function newSessionViaUI(ws) { await evalExpr(ws, `document.querySelector('button.new-button')?.click(), true`); await waitFor('input', () => evalOk(ws, `!!document.querySelector('[data-testid="chat-input-textarea"]')`), 15); return activeSessionId(ws); }
async function activeSessionId(ws) { return waitFor('sid', async () => { const n = await evalExpr(ws, `document.querySelector('.session-link.active .session-link__name')?.textContent?.trim() ?? null`); if (!n) return null; const ss = await evalExpr(ws, `window.claudeLink.listSessions()`); return (ss ?? []).find((s) => s.name === n)?.id ?? null; }, 15); }
async function typeInChatInput(ws, text) { await evalExpr(ws, `(() => { const ta = document.querySelector('[data-testid="chat-input-textarea"]'); ta.focus(); const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; s.call(ta, ''); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`); await cdpCall(ws, 'Input.insertText', { text }); await new Promise((r) => setTimeout(r, 300)); }
async function waitQueryIdle(ws, t = 600) { await waitFor('idle', () => evalOk(ws, `!document.querySelector('button.ctl__btn--abort')`), t, 1000); }
async function sendViaUI(ws, text) { await waitQueryIdle(ws, 600); await typeInChatInput(ws, text); await evalExpr(ws, `document.querySelector('[data-testid="chat-send-button"]')?.click(), true`); }
async function getMessages(ws, sid) { return (await evalExpr(ws, `window.claudeLink.getSessionMessages(${JSON.stringify(sid)})`)) ?? []; }
async function waitTurnComplete(ws, sid, base, t = 300) {
  return waitFor('turn', async () => {
    const m = await getMessages(ws, sid);
    // 完成 = 出现 assistant 或 system result 消息（不只靠条数 +1）
    const last = m[m.length - 1];
    return (m.length > base + 1 && last && (last.role === 'assistant' || (last.role === 'system' && /result|aborted|local_command/.test(last.processKind || '')))) ? last : null;
  }, t, 1000);
}
async function sampleDom(ws) { return await evalExpr(ws, `(() => { const btn = document.querySelector('.ctx__btn'); const ring = document.querySelector('.ctx__ring-fg'); const rows = [...document.querySelectorAll('.ctx__row')].map((r) => ({ label: r.querySelector('span')?.textContent?.trim() ?? '', value: r.querySelector('code')?.textContent?.trim() ?? '' })); return { present: !!btn, title: btn?.getAttribute('title') ?? null, ringDasharray: ring?.getAttribute('stroke-dasharray') ?? null, popoverRows: rows }; })()`); }
async function sampleContextStats(ws) { return await evalExpr(ws, `(() => { try { const s = window.__claudeLinkSessionStore; return s ? JSON.parse(JSON.stringify(s.contextStats)) : null; } catch { return null; } })()`); }

async function main() {
  const phase = process.argv[2] ?? 'persist';
  const page = await getPageTarget();
  if (!page) { console.error('CDP 不可用，先 npm run dev:cdp。exit 2'); process.exit(2); }
  const ws = await connectWS(page.webSocketDebuggerUrl);
  await waitFor('bridge', () => evalOk(ws, `typeof window.claudeLink === 'object'`), 15);

  if (phase === 'persist') {
    // 清理旧的同名 S12 会话（重跑安全：resume 按 name 查找，不允许歧义）
    await evalExpr(ws, `window.claudeLink.listSessions().then((ss) => Promise.all((ss ?? []).filter((s) => s.name === ${JSON.stringify(SESSION_NAME)}).map((s) => window.claudeLink.deleteSession(s.id)))).then(() => true)`);
    const sid = await newSessionViaUI(ws);
    // 重命名以在重启后定位
    await evalExpr(ws, `window.claudeLink.updateSession(${JSON.stringify(sid)}, { name: ${JSON.stringify(SESSION_NAME)} }).catch(()=>{})`);
    // 无 workingDir 时 handleSend 静默 no-op（文本留在输入框、不产生回合、超时）——
    // 先建隔离 cwd 并经 UI 工作空间菜单设置（与 harness/e2e 相同的已验证路径）。
    const isoCwd = path.join(OUT, 'cwd-s12').replace(/\\/g, '/');
    fs.mkdirSync(isoCwd, { recursive: true });
    fs.writeFileSync(path.join(isoCwd, 'README.md'), '# s12-restart\n', 'utf8');
    await evalExpr(ws, `window.claudeLink.addRecentWorkspace(${JSON.stringify(isoCwd)})`);
    await evalExpr(ws, `document.querySelector('.settings-link')?.click(), true`);
    await new Promise((r) => setTimeout(r, 800));
    await evalExpr(ws, `(document.querySelector('.session-link.active') || document.querySelector('.session-link'))?.click(), true`);
    await waitFor('toolbar', () => evalOk(ws, `!!document.querySelector('.session-toolbar')`), 15);
    await evalExpr(ws, `(() => { const btns = [...document.querySelectorAll('.session-toolbar .ctl__btn')]; const b = btns.find((x) => (x.textContent || '').includes('▾')); if (!b) throw new Error('ws btn'); b.click(); return true; })()`);
    const cwdOk = await evalExpr(ws, `(() => { const items = [...document.querySelectorAll('.session-toolbar .menu__item')]; const t = items.find((i) => i.getAttribute('title') === ${JSON.stringify(isoCwd)}); if (t) { t.click(); return true; } return false; })()`);
    if (!cwdOk) { console.error('无法设置 S12 会话工作目录（菜单项未找到）：' + isoCwd); process.exit(2); }
    const sessCheck = await evalExpr(ws, `window.claudeLink.getSession(${JSON.stringify(sid)})`);
    if ((sessCheck?.workingDir ?? null) !== isoCwd) { console.error('S12 会话 workingDir 复核失败：' + String(sessCheck?.workingDir)); process.exit(2); }
    const b = (await getMessages(ws, sid)).length;
    await sendViaUI(ws, '只回复"持久化会话就绪"。');
    await waitTurnComplete(ws, sid, b, 180);
    await waitQueryIdle(ws, 180);
    const sess = await evalExpr(ws, `window.claudeLink.getSession(${JSON.stringify(sid)})`);
    const dom = await sampleDom(ws);
    fs.writeFileSync(path.join(OUT, MARKER), JSON.stringify({
      appSessionId: sid,
      name: SESSION_NAME,
      cliSessionId: sess?.cliSessionId,
      lastContextTokens: sess?.lastContextTokens,
      lastContextWindow: sess?.lastContextWindow,
      domBeforeRestart: dom,
    }, null, 2), 'utf8');
    console.log('persist 完成：');
    console.log('  appSessionId=' + crypto.createHash('sha256').update(sid).digest('hex').slice(0, 10));
    console.log('  cliSessionId=' + (sess?.cliSessionId ? crypto.createHash('sha256').update(sess.cliSessionId).digest('hex').slice(0, 10) : null));
    console.log('  lastContextTokens=' + sess?.lastContextTokens + ' lastContextWindow=' + sess?.lastContextWindow);
    console.log('  dom=' + JSON.stringify(dom));
    // 不删除会话，等重启后 resume
    try { ws.close(); } catch {}
    return;
  }

  if (phase === 'resume') {
    const marker = JSON.parse(fs.readFileSync(path.join(OUT, MARKER), 'utf8'));
    // 找到该会话（按 name）
    const sess = await evalExpr(ws, `window.claudeLink.listSessions().then((ss) => ss.find((s) => s.name === ${JSON.stringify(SESSION_NAME)}) ?? null)`);
    if (!sess) { console.error('未找到 S12 会话（可能被清理）'); process.exit(2); }
    // 切到该会话
    await evalExpr(ws, `(() => { const links = [...document.querySelectorAll('.session-link')]; const t = links.find((l) => l.querySelector('.session-link__name')?.textContent?.trim() === ${JSON.stringify(SESSION_NAME)}); if (!t) throw new Error('未找到 ' + ${JSON.stringify(SESSION_NAME)}); t.click(); return true; })()`);
    await waitFor('切换完成', () => evalOk(ws, `!!document.querySelector('[data-testid="chat-input-textarea"]')`), 15);
    await new Promise((r) => setTimeout(r, 1000));
    const dom = await sampleDom(ws);
    // S12 证据落盘（与 marker 同目录）：重启前后 DOM 对照 + 判定结论。
    const verdict = {
      ts: new Date().toISOString(),
      appSessionIdHash: crypto.createHash('sha256').update(marker.appSessionId).digest('hex').slice(0, 10),
      cliSessionIdHash: marker.cliSessionId ? crypto.createHash('sha256').update(marker.cliSessionId).digest('hex').slice(0, 10) : null,
      lastContextTokens: marker.lastContextTokens,
      lastContextWindow: marker.lastContextWindow,
      domBeforeRestart: marker.domBeforeRestart,
      domAfterResume: dom,
      // 计划 Task 6 Step 5 语义：无新 telemetry 时不得把 last-known 伪装为当前值。
      pendingAfterResume: dom.title != null && (dom.title.includes('待刷新') || dom.ringDasharray == null),
    };
    fs.writeFileSync(path.join(OUT, 'S12-resume-result.json'), JSON.stringify(verdict, null, 2), 'utf8');
    console.log('resume 完成：');
    console.log('  cliSessionId(重启前持久化)=' + (marker.cliSessionId ? crypto.createHash('sha256').update(marker.cliSessionId).digest('hex').slice(0, 10) : null));
    console.log('  lastContextTokens(重启前)=' + marker.lastContextTokens + ' lastContextWindow=' + marker.lastContextWindow);
    console.log('  domBeforeRestart=' + JSON.stringify(marker.domBeforeRestart));
    console.log('  domAfterResume=' + JSON.stringify(dom));
    console.log('  判定：resume 后未产生新 telemetry，UI ' + (verdict.pendingAfterResume ? '正确显示待刷新/pending（未伪装 last-known 为当前值）' : '仍显示重启前数字——需人工核对是否 stale'));
    // 清理会话
    await evalExpr(ws, `window.claudeLink.deleteSession(${JSON.stringify(sess.id)}).catch(()=>{})`);
    // WS 不关会让 Node 进程挂住（曾表现为脚本超时而非完成）
    try { ws.close(); } catch {}
    return;
  }
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
