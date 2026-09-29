// scripts/cdp-sidebar-smoke.mjs
// 侧栏 Quiet Console 重设计（2026-09-27 计划 §8）真窗冒烟：
//   S1 侧栏四区渲染无破版（品牌/新会话/搜索/页签/分组列表）
//   S2 切会话/搜索/页签/批量可用
//   S3 Ctrl+N 新会话、/ 聚焦搜索
//   S6 Esc 急停不回归（markRunning 伪造 sending → Esc → sending 翻 false，零引擎开销）
//   S4 切「终端」色板整窗深色且侧栏可读
//   S5 切「静默」色板近似效果图 A + 旧主题抽查（warm-paper/high-contrast/delve）结构不破
//
// 用法：1) npm run dev:cdp  2) node scripts/cdp-sidebar-smoke.mjs
// 截图落 D:\software\Cache\sidebar-smoke-*.png。退出协议：0=全过 / 1=断言败 / 2=前置不满足。
//
// 种子数据前置要求（复跑前必读）：
//   - 冒烟依赖 dev 库（%APPDATA%/claude-link/claude-link.db）预置 ≥4 条会话；
//   - 其中 ≥1 条标题须含「KaTeX」（S2.2 搜索断言用）；部分会话带 working_dir（S2.3 项目分组断言用）；
//     updatedAt 须覆盖 今天/昨天/本周/更早/跨年 各桶（S1.3/S2.3 分组断言按 group-sessions-by-date 同口径算期望）；
//   - 本脚本是 2026-09-27 侧栏重设计的一次性实施验证脚本，复跑前须自备上述数据；
//   - 种入/清理方式：应用未启动时用
//     `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e "…better-sqlite3…"`
//     直插 / 按 `id LIKE 'smoke-%'` 删除（参考 2026-09-27 实施做法：插 5 条 smoke-* 会话、冒烟后 DELETE 还原）。
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const CDP_PORT = 9223;
const SHOT_DIR = 'D:/software/Cache';
let pass = 0;
let fail = 0;
const log = (msg) => console.log(`[sidebar-smoke] ${msg}`);

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
async function screenshot(ws, name) {
  const r = await cdpCall(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${SHOT_DIR}/sidebar-smoke-${name}.png`, Buffer.from(r.data, 'base64'));
  return `${SHOT_DIR}/sidebar-smoke-${name}.png`;
}
// 与 group-sessions-by-date 同口径的期望桶计算（时间容错：冒烟跨午夜也成立）。
function expectedBuckets(updatedAtList, now = new Date()) {
  const DAY = 86400000;
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const nowMid = midnight(now);
  const mondayMid = nowMid - ((now.getDay() + 6) % 7) * DAY;
  const buckets = { today: [], yesterday: [], week: [], older: [] };
  for (const t of updatedAtList) {
    const ms = Date.parse(t);
    if (Number.isNaN(ms)) { buckets.older.push(t); continue; }
    const dMid = midnight(new Date(ms));
    const ago = Math.round((nowMid - dMid) / DAY);
    if (ago <= 0) buckets.today.push(t);
    else if (ago === 1) buckets.yesterday.push(t);
    else if (dMid >= mondayMid) buckets.week.push(t);
    else buckets.older.push(t);
  }
  return ['today', 'yesterday', 'week', 'older'].filter((k) => buckets[k].length > 0).map((k) => ({ key: k, n: buckets[k].length }));
}

const target = await getPageTarget();
if (!target) throw new PreconditionError('CDP page target 不可用');
const ws = await connectWS(target.webSocketDebuggerUrl);
await cdpCall(ws, 'Page.enable');
await evalExpr(ws, `location.reload()`);
await sleep(2500); // 等 reload 后渲染与 loadSessions 完成（清掉上次冒烟残留的批量态等 UI 状态）

// ── S1 侧栏四区渲染 ──
console.log('\n=== S1 侧栏渲染 ===');
const dbSessions = await evalExpr(ws, `(() => {
  const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session');
  return s.sessions.map(x => ({ id: x.id, name: x.name, updatedAt: x.updatedAt }));
})()`);
if (!Array.isArray(dbSessions) || dbSessions.length < 4) throw new PreconditionError(`种子会话不足：${dbSessions?.length}`);

await check('S1.1 四区元素齐全且可见（brand/new-button/search/tabs/sessions）', async () => {
  const r = await evalExpr(ws, `(() => {
    const q = (sel) => document.querySelector(sel);
    const vis = (sel) => { const el = q(sel); if (!el) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    return {
      brand: vis('.sidebar__brand'), newBtn: vis('.new-button'), search: vis('.sidebar__search'),
      tabs: vis('.sidebar__tabs'), nav: vis('.sidebar__sessions'),
      sidebarW: q('.sidebar')?.getBoundingClientRect().width ?? 0,
    };
  })()`);
  for (const k of ['brand', 'newBtn', 'search', 'tabs', 'nav']) {
    if (!r[k]) throw new Error(`${k} 不可见`);
  }
  if (r.sidebarW < 100) throw new Error(`侧栏宽度异常 ${r.sidebarW}`);
});
await check('S1.2 新会话按钮在搜索框之前（模板顺序）+ Ctrl N 提示存在', async () => {
  const r = await evalExpr(ws, `(() => {
    const nb = document.querySelector('.new-button'); const sw = document.querySelector('.sidebar__search-wrap');
    return { ok: nb && sw && (nb.compareDocumentPosition(sw) & Node.DOCUMENT_POSITION_FOLLOWING) > 0,
      kbd: nb?.querySelector('kbd')?.textContent ?? '' };
  })()`);
  if (!r.ok) throw new Error('new-button 不在搜索框之前');
  if (!/Ctrl/i.test(r.kbd)) throw new Error(`kbd 提示异常：${r.kbd}`);
});
await check('S1.3 日期分组渲染：组头序列与期望桶一致（含计数）', async () => {
  const groups = await evalExpr(ws, `(() => {
    const nav = document.querySelector('.sidebar__sessions');
    const heads = [...nav.querySelectorAll(':scope > .sidebar__group')].map(h => ({
      label: h.querySelector('.sidebar__group__label')?.textContent ?? '',
      n: Number(h.querySelector('.sidebar__group__count')?.textContent ?? '0'),
    }));
    return { heads, rows: nav.querySelectorAll('.session-link').length };
  })()`);
  const expect = expectedBuckets(dbSessions.map((s) => s.updatedAt));
  const keyToLabel = { today: '今天', yesterday: '昨天', week: '本周更早', older: '更早' };
  const expectHeads = expect.map((g) => ({ label: keyToLabel[g.key], n: g.n }));
  if (JSON.stringify(groups.heads) !== JSON.stringify(expectHeads)) {
    throw new Error(`组头 ${JSON.stringify(groups.heads)} ≠ 期望 ${JSON.stringify(expectHeads)}`);
  }
  if (groups.rows !== dbSessions.length) throw new Error(`行数 ${groups.rows} ≠ 会话数 ${dbSessions.length}`);
});
await check('S1.4 会话行单行结构：状态点/名称/时间列/hover 删除钮齐备', async () => {
  const r = await evalExpr(ws, `(() => {
    const row = document.querySelector('.session-link');
    if (!row) return { ok: false };
    const b = row.getBoundingClientRect();
    return { ok: true, h: Math.round(b.height),
      time: !!row.querySelector('.session-link__time'), del: !!row.querySelector('.session-link__delete'),
      name: (row.querySelector('.session-link__name')?.textContent ?? '').slice(0, 20) };
  })()`);
  if (!r.ok) throw new Error('无会话行');
  if (r.h !== 30) throw new Error(`行高 ${r.h} ≠ 30`);
  if (!r.time || !r.del) throw new Error('时间列或删除钮缺失');
});
await check('S1.5 无破版：侧栏无横向溢出、行无换行撑高', async () => {
  const r = await evalExpr(ws, `(() => {
    const sb = document.querySelector('.sidebar');
    const overflowX = sb.scrollWidth - sb.clientWidth;
    const rowHs = [...document.querySelectorAll('.session-link')].map(x => Math.round(x.getBoundingClientRect().height));
    return { overflowX, maxRowH: Math.max(...rowHs) };
  })()`);
  if (r.overflowX > 1) throw new Error(`横向溢出 ${r.overflowX}px`);
  if (r.maxRowH !== 30) throw new Error(`最高行 ${r.maxRowH} ≠ 30`);
});
log(`  📸 ${await screenshot(ws, 's1-default-warm-paper')}`);

// ── S2 切会话/搜索/页签/批量 ──
console.log('\n=== S2 交互 ===');
await check('S2.1 切会话：点击行 → activeSession 切换且路由回 /', async () => {
  const target = dbSessions[dbSessions.length - 1]; // 最后一行（更早组）
  await evalExpr(ws, `(() => {
    const rows = [...document.querySelectorAll('.session-link')];
    const row = rows.find(x => x.querySelector('.session-link__name')?.textContent === ${JSON.stringify(target.name)});
    row.click();
  })()`);
  await sleep(800);
  const r = await evalExpr(ws, `(() => {
    const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session');
    return { activeId: s.activeSession?.id ?? null, hash: location.hash };
  })()`);
  if (r.activeId !== target.id) throw new Error(`activeSession=${r.activeId} ≠ ${target.id}`);
  if (!r.hash.startsWith('#/')) throw new Error(`路由异常 ${r.hash}`);
});
await check('S2.2 搜索：输入防抖后列表过滤 + 空态文案二分', async () => {
  await evalExpr(ws, `(() => {
    const input = document.querySelector('.sidebar__search');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'KaTeX');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(600); // 250ms 防抖 + IPC
  const r = await evalExpr(ws, `(() => {
    const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session');
    const names = [...document.querySelectorAll('.session-link__name')].map(x => x.textContent);
    return { q: s.searchQuery, n: s.displayedSessions.length, names };
  })()`);
  if (r.n !== 1 || !r.names[0]?.includes('KaTeX')) throw new Error(`过滤异常：n=${r.n} names=${JSON.stringify(r.names)}`);
  // 清空 → 恢复全量
  await evalExpr(ws, `(() => {
    const input = document.querySelector('.sidebar__search');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(600);
  const n2 = await evalExpr(ws, `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session').displayedSessions.length`);
  if (n2 !== dbSessions.length) throw new Error(`清空后 ${n2} ≠ ${dbSessions.length}`);
});
await check('S2.3 页签：切「项目」出现项目组（含未选择工作空间组），切回「全部」恢复日期组', async () => {
  await evalExpr(ws, `(() => {
    const tabs = [...document.querySelectorAll('.sidebar__tab')];
    tabs.find(t => t.textContent.trim() === '项目').click();
  })()`);
  await sleep(300);
  const proj = await evalExpr(ws, `(() => {
    const labels = [...document.querySelectorAll('.sidebar__group__label')].map(x => x.textContent);
    return { labels, hasNone: labels.includes('未选择工作空间') };
  })()`);
  if (!proj.hasNone) throw new Error(`项目组异常：${JSON.stringify(proj.labels)}`);
  await evalExpr(ws, `(() => {
    const tabs = [...document.querySelectorAll('.sidebar__tab')];
    tabs.find(t => t.textContent.trim() === '全部').click();
  })()`);
  await sleep(300);
  const back = await evalExpr(ws, `(() => {
    const labels = [...document.querySelectorAll('.sidebar__group__label')].map(x => x.textContent);
    return labels;
  })()`);
  const expectLabels = expectedBuckets(dbSessions.map((s) => s.updatedAt)).map((g) => ({ today: '今天', yesterday: '昨天', week: '本周更早', older: '更早' }[g.key]));
  if (JSON.stringify(back) !== JSON.stringify(expectLabels)) throw new Error(`切回异常：${JSON.stringify(back)} ≠ ${JSON.stringify(expectLabels)}`);
});
await check('S2.4 批量：进模式→勾选 2 条→全选→条上计数→退出清空', async () => {
  await evalExpr(ws, `document.querySelector('.sidebar__multiselect').click()`);
  await sleep(300);
  await evalExpr(ws, `(() => {
    const checks = document.querySelectorAll('.session-link__check');
    checks[0].click(); checks[1].click();
  })()`);
  await sleep(300); // 等 Vue 重渲染批量条计数
  let r = await evalExpr(ws, `(() => {
    const btn = document.querySelector('.sidebar__batchbar__delete');
    return { batchbar: !!document.querySelector('.sidebar__batchbar'),
      btnText: btn?.textContent ?? '', disabled: btn?.disabled ?? null };
  })()`);
  if (!r.batchbar) throw new Error('批量条未出现');
  if (!r.btnText.includes('(2)')) throw new Error(`删除钮计数异常：${r.btnText}`);
  if (r.disabled) throw new Error('选中 2 条后删除钮不应 disabled');
  // 全选
  await evalExpr(ws, `document.querySelector('.sidebar__batchbar__all input').click()`);
  await sleep(300);
  r = await evalExpr(ws, `document.querySelector('.sidebar__batchbar__delete').textContent`);
  if (!r.includes(`(${dbSessions.length})`)) throw new Error(`全选后计数异常：${r}`);
  // 退出（不点删除——避免真删种子数据）
  await evalExpr(ws, `document.querySelector('.sidebar__multiselect').click()`);
  await sleep(300);
  const s = await evalExpr(ws, `(() => {
    const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session');
    return { batchbar: !!document.querySelector('.sidebar__batchbar'), checks: document.querySelectorAll('.session-link__check').length };
  })()`);
  if (s.batchbar || s.checks > 0) throw new Error('退出批量未清场');
});

// ── S3 快捷键 ──
console.log('\n=== S3 快捷键 ===');
await check('S3.1 Ctrl+N → 暂态会话 + 路由 /', async () => {
  await evalExpr(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }))`);
  await sleep(400);
  const r = await evalExpr(ws, `(() => {
    const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session');
    return { transient: !!s.activeSession?.transient, hash: location.hash,
      btnActive: document.querySelector('.new-button').classList.contains('new-button--active') };
  })()`);
  if (!r.transient) throw new Error('activeSession 非暂态');
  if (!r.hash.startsWith('#/') || r.hash.includes('config')) throw new Error(`路由 ${r.hash}`);
  if (!r.btnActive) throw new Error('新会话按钮缺暂态激活态');
});
await check('S3.2 「/」→ 搜索框聚焦（body 焦点派发）', async () => {
  await evalExpr(ws, `document.activeElement?.blur(); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }))`);
  await sleep(200);
  const focused = await evalExpr(ws, `document.activeElement?.classList?.contains('sidebar__search')`);
  if (!focused) throw new Error(`焦点在 ${await evalExpr(ws, `document.activeElement?.tagName + '.' + (document.activeElement?.className || '')`)}`);
});
await check('S3.3 输入框聚焦时按「/」不抢焦点（守卫生效）', async () => {
  await evalExpr(ws, `(() => {
    const input = document.querySelector('.sidebar__search');
    input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
  })()`);
  await sleep(150);
  const same = await evalExpr(ws, `document.activeElement?.classList?.contains('sidebar__search')`);
  if (!same) throw new Error('输入态按 / 焦点丢失（守卫未生效）');
});

// ── S6 Esc 急停（先于主题切换，保证会话态干净）──
console.log('\n=== S6 Esc 急停 ===');
await check('S6.1 sending 态按 Esc → abort 通道生效（sending 翻 false）', async () => {
  // 需要非暂态会话承载 markRunning（暂态 id 也可，但先切到一个真实会话）
  await evalExpr(ws, `(() => {
    const rows = [...document.querySelectorAll('.session-link')];
    rows[0].click();
  })()`);
  await sleep(500);
  await evalExpr(ws, `(() => {
    const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session');
    s.markRunning(s.activeSession.id); // 零开销伪造 running（sending getter 派生 true）
  })()`);
  await sleep(200);
  const before = await evalExpr(ws, `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session').sending`);
  if (before !== true) throw new Error('伪造 sending 失败');
  await evalExpr(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await sleep(800);
  const after = await evalExpr(ws, `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session').sending`);
  if (after !== false) throw new Error('Esc 后 sending 未复位，急停通道失效');
});

// ── S4 终端色板 ──
async function selectTheme(name) {
  await evalExpr(ws, `document.querySelector('.settings-link').click()`);
  await sleep(800);
  const r = await evalExpr(ws, `(() => {
    const cards = [...document.querySelectorAll('.palette-card')];
    if (cards.length !== 11) return { err: '卡片数 ' + cards.length };
    const card = cards.find(c => c.querySelector('.palette-name')?.textContent === ${JSON.stringify(name)});
    if (!card) return { err: '找不到色卡' };
    card.click(); return { ok: true };
  })()`);
  if (r.err) throw new Error(r.err);
  await sleep(400);
}
console.log('\n=== S4/S5 色板 ===');
await check('S4.1 配置页出现 11 张色卡（含 静默/终端）', async () => {
  await evalExpr(ws, `document.querySelector('.settings-link').click()`);
  await sleep(800);
  const names = await evalExpr(ws, `[...document.querySelectorAll('.palette-name')].map(x => x.textContent)`);
  if (names.length !== 11) throw new Error(`色卡 ${names.length} 张`);
  if (!names.includes('静默') || !names.includes('终端')) throw new Error(`缺新卡：${JSON.stringify(names)}`);
});
await check('S4.2 点「终端」→ colorScheme=dark + token 换肤 + 侧栏可读（截图）', async () => {
  await selectTheme('终端');
  const r = await evalExpr(ws, `(() => {
    const root = document.documentElement;
    return { scheme: getComputedStyle(root).colorScheme, bg: root.style.getPropertyValue('--color-bg'),
      panel: root.style.getPropertyValue('--color-panel'), accent: root.style.getPropertyValue('--color-accent') };
  })()`);
  if (r.scheme !== 'dark') throw new Error(`colorScheme=${r.scheme}`);
  if (r.bg !== '#0F1115' || r.accent !== '#4EA1FF') throw new Error(`token 异常：${JSON.stringify(r)}`);
});
await check('S4.3 终端色板下侧栏结构不破 + 回聊天页截图', async () => {
  await evalExpr(ws, `(() => { document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/'); })()`);
  await sleep(700);
  const r = await evalExpr(ws, `(() => {
    const q = (sel) => document.querySelector(sel);
    const vis = (sel) => { const el = q(sel); if (!el) return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    return { brand: vis('.sidebar__brand'), rows: document.querySelectorAll('.session-link').length,
      scheme: getComputedStyle(document.documentElement).colorScheme };
  })()`);
  if (!r.brand || r.rows < 4) throw new Error(`深色下侧栏异常 rows=${r.rows}`);
  if (r.scheme !== 'dark') throw new Error('回聊天页后 colorScheme 应保持 dark');
  log(`  📸 ${await screenshot(ws, 's4-terminal-pro')}`);
});
await check('S5.1 点「静默」→ colorScheme=light + 冷灰 token', async () => {
  await selectTheme('静默');
  const r = await evalExpr(ws, `(() => {
    const root = document.documentElement;
    return { scheme: getComputedStyle(root).colorScheme, bg: root.style.getPropertyValue('--color-bg'),
      accent: root.style.getPropertyValue('--color-accent') };
  })()`);
  if (r.scheme !== 'light') throw new Error(`colorScheme=${r.scheme}`);
  if (r.bg !== '#F6F7F8' || r.accent !== '#1A1D21') throw new Error(`token 异常：${JSON.stringify(r)}`);
});
await check('S5.2 静默色板下侧栏渲染（截图对效果图 A）', async () => {
  await evalExpr(ws, `(() => { document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/'); })()`);
  await sleep(700);
  const rows = await evalExpr(ws, `document.querySelectorAll('.session-link').length`);
  if (rows < 4) throw new Error(`rows=${rows}`);
  log(`  📸 ${await screenshot(ws, 's5-quiet-console')}`);
});
await check('S5.3 旧主题抽查（素白(高对比)/纯白）下侧栏结构不破', async () => {
  for (const theme of ['素白', '纯白']) {
    await selectTheme(theme);
    await evalExpr(ws, `(() => { document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/'); })()`);
    await sleep(600);
    const r = await evalExpr(ws, `(() => {
      const nav = document.querySelector('.sidebar__sessions');
      return { rows: nav.querySelectorAll('.session-link').length, h: Math.round(nav.getBoundingClientRect().height) };
    })()`);
    if (r.rows < 4 || r.h < 50) throw new Error(`${theme} 下侧栏异常 ${JSON.stringify(r)}`);
  }
  // 还原默认主题
  await selectTheme('暖纸');
  await evalExpr(ws, `(() => { document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/'); })()`);
  await sleep(500);
});

console.log(`\n${pass} passed, ${fail} failed`);
ws.close();
process.exit(fail === 0 ? 0 : 1);
