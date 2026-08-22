// scripts/context-research-context-full.mjs
// 一次性证据采集：捕获 /context 完整原文（脱敏）+ 验证 getContextUsage 在长回合是否可达。
// 用法：node scripts/context-research-context-full.mjs --runId run-2026-08-21-205616

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const CDP_PORT = 9223;
const RESEARCH_ROOT = 'D:/software/Cache/claude-link/context-research';
const HOME_DIRS = [process.env.USERPROFILE, process.env.HOME, os.homedir()].filter(Boolean).map(String).filter((d, i, a) => a.indexOf(d) === i).sort((a, b) => b.length - a.length);
function scrub(text) {
  let out = String(text ?? '');
  for (const home of HOME_DIRS) out = out.split(home).join('<USER_DIR>');
  out = out.split('D:\\software\\code\\claude-link').join('<REPO_DIR>');
  out = out.split('D:/software/code/claude-link').join('<REPO_DIR>');
  out = out.replace(/sk-[a-zA-Z0-9_-]{16,}/g, '<redacted>');
  out = out.replace(/(ANTHROPIC_(?:API_KEY|AUTH_TOKEN)\s*[=:]\s*)\S+/gi, '$1<redacted>');
  out = out.replace(/(Authorization\s*[:=]\s*)(Bearer\s+)?\S+/gi, '$1<redacted>');
  return out;
}
function stableId(raw) { return raw ? crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 10) : null; }

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
async function waitTurnComplete(ws, sid, base, t = 300) { return waitFor('turn', async () => { const m = await getMessages(ws, sid); return m.length > base + 1 ? m[m.length - 1] : null; }, t, 1000); }

async function main() {
  const i = process.argv.indexOf('--runId');
  const runId = i >= 0 ? process.argv[i + 1] : `run-${Date.now()}`;
  const outDir = path.join(RESEARCH_ROOT, runId);
  fs.mkdirSync(outDir, { recursive: true });
  const page = await getPageTarget();
  if (!page) { console.error('CDP 不可用，先 npm run dev:cdp。exit 2'); process.exit(2); }
  const ws = await connectWS(page.webSocketDebuggerUrl);
  await waitFor('bridge', () => evalOk(ws, `typeof window.claudeLink === 'object'`), 15);
  const sid = await newSessionViaUI(ws);
  const created = [sid];
  // 隔离 cwd（与 harness 一致）
  const isoCwd = path.join(outDir, 'cwd-full').replace(/\\/g, '/');
  fs.mkdirSync(isoCwd, { recursive: true });
  fs.writeFileSync(path.join(isoCwd, 'README.md'), '# context-research\n', 'utf8');
  await evalExpr(ws, `window.claudeLink.addRecentWorkspace(${JSON.stringify(isoCwd)})`);
  await evalExpr(ws, `document.querySelector('.settings-link')?.click(), true`);
  await new Promise((r) => setTimeout(r, 800));
  await evalExpr(ws, `(document.querySelector('.session-link.active') || document.querySelector('.session-link'))?.click(), true`);
  await waitFor('toolbar', () => evalOk(ws, `!!document.querySelector('.session-toolbar')`), 15);
  await evalExpr(ws, `(() => { const btns = [...document.querySelectorAll('.session-toolbar .ctl__btn')]; const b = btns.find((x) => (x.textContent || '').includes('▾')); if (!b) throw new Error('ws btn'); b.click(); return true; })()`);
  const clicked = await evalExpr(ws, `(() => { const items = [...document.querySelectorAll('.session-toolbar .menu__item')]; const t = items.find((i) => i.getAttribute('title') === ${JSON.stringify(isoCwd)}); if (t) { t.click(); return true; } return false; })()`);
  if (!clicked) throw new Error('菜单未出现 ' + isoCwd);
  await waitFor('ws 反映', () => evalOk(ws, `[...document.querySelectorAll('.session-toolbar .ctl__btn')].some((b) => (b.getAttribute('title') || '') === ${JSON.stringify(isoCwd)})`), 15);
  console.log('隔离 cwd=' + isoCwd);

  const sess = await evalExpr(ws, `window.claudeLink.getSession(${JSON.stringify(sid)})`);
  const cliSid = stableId(sess?.cliSessionId);
  console.log('sid=' + stableId(sid) + ' cliSessionId(初始)=' + cliSid);

  // 捕获 /context 完整原文（直接轮询包含 "Context Usage" 的消息，不依赖条数 +1）
  const b0 = (await getMessages(ws, sid)).length;
  await sendViaUI(ws, '/context');
  const ctxMsg = await waitFor('/context 原文', async () => {
    const msgs = await getMessages(ws, sid);
    const found = msgs.slice(b0).find((m) => typeof m.content === 'string' && m.content.includes('Context Usage'));
    return found ?? null;
  }, 300, 2000);
  const msgs = await getMessages(ws, sid);
  const fullText = scrub(ctxMsg?.content ?? null);
  fs.writeFileSync(path.join(outDir, 'native-context-full.txt'), (fullText ?? '(none)') + '\n', 'utf8');
  console.log('=== /context 完整原文（脱敏）===');
  console.log(fullText ?? '(none)');
  console.log('=== END ===');
  await waitQueryIdle(ws, 300);

  // 长回合验证 getContextUsage（发一个需要多 turn 的 prompt，观察 dev-server.log 是否出现诊断）
  const b1 = (await getMessages(ws, sid)).length;
  await sendViaUI(ws, '请写一个 20 行的 TypeScript 泛型示例并逐行解释。');
  await waitTurnComplete(ws, sid, b1, 300);
  await waitQueryIdle(ws, 300);
  console.log('长回合完成，消息 ' + b1 + ' -> ' + (await getMessages(ws, sid)).length);

  for (const s of created) { try { await evalExpr(ws, `window.claudeLink.deleteSession(${JSON.stringify(s)})`); } catch {} }
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
