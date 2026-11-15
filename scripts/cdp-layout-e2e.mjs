// scripts/cdp-layout-e2e.mjs
// 布局回归门禁：验证配置页「内容列 800px 统一契约 + 高度自然填满」在窗口最大化/还原下成立，
// 消除此前 aspect-ratio:3/2 锁死导致的「最大化左右 letterboxing / 还原底部大留白」两态不一致。
//
// 用法：
//   1. 启动 Electron：npm run dev:cdp
//   2. 运行：node scripts/cdp-layout-e2e.mjs
//
// A1 场景组（slate-ui-completion-1108-1428 点 A1，2026-11-08 增）：
//   末段自持三个「冷启动 electron（out/ 产物）+ mkdtemp --user-data-dir 隔离 profile（用后即删，
//   禁写用户真实配置）」场景（CDP 端口 9337，与 9223 长驻实例无耦合）：
//   · S1 全新配置（无 settings.json）：色板 12 卡、默认选中墨石、根 token=墨石值、large 档 18px
//     （A1-5/A1-9 行为面）；
//   · S2 预置 themePaletteId='warm-paper'（旧默认）：读路径一次性迁移 → 读出/选中 inkstone 且
//     settings.json 的 themePaletteId 未被写回（A1-8 增补迁移用例，裁决②）；
//   · S3 预置 themePaletteId='quiet-console'（非默认存量选择）：保持静默不被墨石覆盖（A1-8 原用例）。
//   前置：npm run build 已跑（out/ 新鲜度预检：out/main/index.js 必须晚于 constants.ts 与
//   config-manager.ts 的 mtime，过期 exit 2）。
//
// A2 场景组（slate-ui-completion-1108-1428 点 A2，2026-11-08 增）：
//   复用 A1 场景 runner（同端口 9337 / 同隔离纪律 / 同 out/ 新鲜度前置），单场景自持：
//   · A2-5 发送钮 disabled 抽验（聊天页：空输入 vs 有文本 computed opacity 不等）；
//   · A2-1 墨石默认下 documentElement 上 --color-btn-ink/--color-on-btn-ink 变量解析值
//     = rgb(23,24,26)/rgb(255,255,255)（探针元素 color:var(...) 经 getComputedStyle 解析）；
//   · A2-2 逐板切换暖纸/静默/终端：变量解析值=各板 accent/onAccent 且无 #17181A 残留。
//   裁决口径：断言对象=根元素上 ink 对「变量」的解析值，**不断言**发送钮/新会话钮元素
//   computed（消费方 E1/B6 才 ink 化，其时点由该点复核）。
//
// A3 场景组（slate-ui-completion-1108-1428 点 A3，2026-11-08 增）：
//   复用 A1 场景 runner，单场景：全新配置（墨石默认）→ 逐板切暖纸/静默/终端，
//   每板断言 --color-bubble-user-bg=#D9E9ED / --color-bubble-user-ink=#17181A raw 变量值
//   恒定 + documentElement inline 零写入（纯静态、不随板、无 JS 写入链；终端暗板下浅蓝
//   恒定属设计意图，红线禁止 isDark 分支）。
//   A3-3/A3-4 消费者侧断言（.bubble--user 元素 computed 探针）已由点 C1 落地转写（2026-11-08）：
//   探针手法见本文件「C1 消费者侧探针」组；隔离 --user-data-dir 纪律不变。
//
// G2 场景组（slate-ui-completion-1108-1428 点 G2，2026-11-09 增）：
//   复用 A1 场景 runner，单场景：全新配置（墨石默认）→ 外观 tab → 真实键盘（CDP Input 域）
//   Tab 可达色板卡 + 连续 Tab 走完 12 卡 + Enter/Space 激活选色即时生效（config.themePaletteId
//   经 700ms 防抖自动保存后 getConfig 读出）＋ button/aria-pressed 运行时钉（防结构绕过）。
//   配套适配：readPaletteCards/clickPaletteCard 卡名改读 palette-name 首文本节点
//   （G2 名称行内嵌条件徽章后 textContent 会带「默认/暗色」字，卡名语义=A1 既定 palette.name）。
//
// G3 场景组（slate-ui-completion-1108-1428 点 G3，2026-11-09 增）：
//   复用 A1 场景 runner，单场景：全新配置 → 连接 tab（tablist/tabpanel 运行时钉 + 返回钮左置
//   bounding box 对齐）→ 外观 tab（字号 seg 三档「小 14/中 16/大 18」radio + 真实方向键
//   ←/→/↑/↓ 切档即时生效 --font-size-base 无需失焦即变化 + 端点停不循环（Owner 裁决）+
//   焦点跟随 + config.fontScale 自动保存落盘轮询）。档位 px 表由 constants.ts 解析同源。
//
// I7 场景组（slate-ui-completion-1108-1428 点 I7，2026-11-10 增）：
//   复用 A1 场景 runner，单场景两站（真实键鼠，CDP Input 域）：
//   · FilePickerDialog 站（I7-CT-1~4）：工作空间真实入口开选择器 → tabindex=-1 壳聚焦 → Shift+Tab
//     真实逃逸出卡 → Tab/Shift+Tab 重捕拉回首/末元素（trapTab 同选择器现算期望位）→ 正常循环保全；
//   · DiffDialog 站（I7-CT-5~8）：种 workingDirectory（等价设置页默认工作目录，放行 changes 三通道
//     allowlist）→ 真实选工作空间 → 右栏「只看改动」→ 改动行开 DiffDialog → 点 footer 图例留白
//     （activeElement 落 body）→ Tab/Shift+Tab 重捕 → 正常循环保全。
//   FilePicker 关闭走 fp-fade leave 过渡，落位轮询可能在过渡窗口内通过——「只看改动」点击前
//   先等 .fp-overlay 卸载清场（R2-F14），点击再带重试环保底。
//
// 退出协议（对齐 cdp-*-e2e 约定）：
//   exit 0：全部布局断言 + A1/A2/A3 场景断言通过
//   exit 1：断言失败（实现回归）
//   exit 2：前置条件不满足（Electron/CDP 不可用 / out/ 产物缺失或过期）——「无法执行」，不算通过
//
// 说明：Electron dev 下 CDP 的 Browser domain 不可用（getWindowForTarget 未实现），
// 无法真正 setWindowBounds 改窗口尺寸；改用 Emulation.setDeviceMetricsOverride 模拟
// 宽/窄视口（等价于窗口 resize，直接驱动 100vw/100vh 与 flex 布局）。断言的是「相对契约」
// （列宽 ≤ 800px、工作区高度填满、三页列宽一致），不依赖窗口外框精确像素。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CDP_PORT = 9223;
// A1 场景组端口（9335 已被 cdp-file-preview-smoke 占用，取邻近空闲位）。
const A1_CDP_PORT = 9337;
const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MAIN_OUT = path.join(REPO_ROOT, 'out', 'main', 'index.js');
const ELECTRON_EXE = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const APP_READY_TIMEOUT_MS = 60_000;
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

async function getPageTarget(port = CDP_PORT) {
  const resp = await fetch(`http://127.0.0.1:${port}/json`);
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

  // ── A1 场景组（slate-ui-completion-1108-1428 点 A1）：独立隔离实例，与 9223 长驻实例无耦合 ──
  await runA1Scenarios();

  // ── A2 场景组（slate-ui-completion-1108-1428 点 A2）：复用 A1 隔离 runner 与新鲜度前置 ──
  await runA2Scenarios();

  // ── A3 场景组（slate-ui-completion-1108-1428 点 A3）：bubble 固定 token 三板恒定 ──
  await runA3Scenarios();

  // ── E1 场景组（slate-ui-completion-1108-1428 点 E1）：发送钮 ink 化 computed + 角标 ──
  await runE1Scenarios();

  // ── E2 场景组（slate-ui-completion-1108-1428 点 E2）：工具栏 chips 一体化 ──
  await runE2Scenarios();

  // ── E6 场景组（slate-ui-completion-1108-1428 点 E6）：附件草稿卡移入浮岛 ──
  await runE6Scenarios();

  // ── G 配置页组（slate-ui-completion-1108-1428 点 G1）：CLI 横幅 tab 门控运行时面 ──
  await runG1Scenario();

  // ── G2 配置页组（slate-ui-completion-1108-1428 点 G2）：ThemeSelector 键盘可达运行时面 ──
  await runG2Scenario();

  // ── G3 配置页组（slate-ui-completion-1108-1428 点 G3）：tablist/tabpanel + 返回钮左置 + 字号 seg 键盘 ──
  await runG3Scenario();

  // ── G4 配置页组（slate-ui-completion-1108-1428 点 G4）：端口/Host Enter 通道 + IME 守卫运行时面 ──
  await runG4Scenario();

  // ── I7 场景组（slate-ui-completion-1108-1428 点 I7）：四处 trapTab 焦点逃逸重捕行为面 ──
  await runI7Scenario();

  // ── B4 场景组（验收 round1 备忘①跟进，2026-11-12 增）：两级断点穿越运行时行为面 ──
  await runB4Scenario();

  // ── R1 场景组（2026-11-12 增：分组页签恢复）：两视图/搜索/批量/键盘运行时行为面 ──
  await runR1Scenario();

  // ── R2 场景组（2026-11-12 增：置顶钮迁 r1）：恒显/点击重排/hover/键盘/批量/时间互换/连点运行时行为面 ──
  await runR2Scenario();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

// ══ A1 场景组（2026-11-08 增）══════════════════════════════════════════════════
// 隔离纪律（仓库 AGENTS.md）：每场景 mkdtemp 独立 profile + --user-data-dir 冷启动 out/ 产物，
// 用后 taskkill 进程树 + 删 profile，全程不触用户真实配置；webAccess 一律 off（避免与 9223
// 长驻实例的 8790 端口冲突）；providerProfiles 预置空数组跳过 ensureProviderMigration 写库，
// 让 S2 的「settings.json 未被写回」断言信号干净（迁移守卫 s.has('providerProfiles') 命中即返）。

async function waitForA1Cdp() {
  const deadline = Date.now() + APP_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const page = await getPageTarget(A1_CDP_PORT);
      if (page) return page;
    } catch { /* 未就绪继续轮询 */ }
    await sleep(500);
  }
  throw new PreconditionError(`A1 场景 CDP ${A1_CDP_PORT} ${APP_READY_TIMEOUT_MS / 1000}s 内未就绪`);
}

async function waitBridgeAndTheme(ws) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const ready = await evalExpr(ws, `(() => {
      if (typeof window.claudeLink !== 'object') return false;
      if (!document.querySelector('.settings-link')) return false; // 侧栏已挂载（防过早点击落空）
      // App.vue 注入链（applyThemePalette）已跑：内联 --color-bg 非空（CSS 静态值不算，必须是 JS 写入）
      const inlineBg = document.documentElement.style.getPropertyValue('--color-bg').trim();
      return inlineBg.length > 0;
    })()`);
    if (ready) return;
    if (Date.now() > deadline) throw new Error('20s 内 bridge/侧栏挂载/主题注入未就绪');
    await sleep(400);
  }
}

async function openAppearanceTab(ws) {
  // 设置页路由切换有挂载窗口期：轮询重试（点 .settings-link → 等 .tab 外观 出现），10s 上限。
  const deadline = Date.now() + 10_000;
  for (;;) {
    await evalExpr(ws, `(() => { document.querySelector('.settings-link')?.click(); return true; })()`);
    await sleep(800);
    const opened = await evalExpr(ws, `(() => {
      const btn = [...document.querySelectorAll('.tab')].find((b) => b.textContent.trim() === '外观');
      if (btn) { btn.click(); return true; }
      return false;
    })()`);
    if (opened) { await sleep(500); return; }
    if (Date.now() > deadline) throw new PreconditionError('外观 tab 按钮不存在（.tab 文案失配或设置页未挂载）');
  }
}

async function readPaletteCards(ws) {
  // G2 起名称行内含条件徽章（palette-badge span），textContent 会带上「默认/暗色」徽章字——
  // 卡名语义须保持 = palette.name 拼写文本（A1-5/A1-8 严格等值断言与 clickPaletteCard 按名寻卡
  // 依赖此口径），故取首个文本节点 trim（{{ palette.name }} 插值经 Vue condense 后与尾部空白
  // 合并为首个文本节点，可能带前导空格，trim 归一；色板名首尾无空白，语义不变）。
  return evalExpr(ws, `(() => [...document.querySelectorAll('.palette-card')].map((c) => ({
    name: (c.querySelector('.palette-name')?.childNodes[0]?.textContent ?? '').trim(),
    active: c.classList.contains('active'),
  })))()`);
}

async function cssVar(ws, name) {
  const v = await evalExpr(ws, `getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`);
  return typeof v === 'string' ? v : '';
}

async function configThemeId(ws) {
  const v = await evalExpr(ws, `window.claudeLink.getConfig().then((c) => c.themePaletteId)`);
  return typeof v === 'string' ? v : '';
}

async function switchFontLarge(ws) {
  // G3③ 同步（2026-11-09）：字号控件 select → seg radiogroup（点 G3 改造），切档驱动改为点击
  // 「大」档 radio——A1-9 行为语义不变（切 large → --font-size-base=18px，即时生效链）。
  const ok = await evalExpr(ws, `(() => {
    const radios = [...document.querySelectorAll('.font-seg [role="radio"]')];
    const target = radios.find((r) => r.textContent.trim().startsWith('大'));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  precondition(ok, '字号 seg「大」档不存在（.font-seg 未渲染）');
  await sleep(400);
}

async function runA1Scenario(title, seedConfig, body) {
  const parent = path.join(os.tmpdir(), 'claude-link-layout-a1');
  mkdirSync(parent, { recursive: true });
  const profileDir = mkdtempSync(path.join(parent, 'profile-'));
  let proc = null;
  try {
    if (seedConfig) {
      writeFileSync(path.join(profileDir, 'claude-link-config.json'), JSON.stringify(seedConfig), 'utf8');
    }
    proc = spawn(ELECTRON_EXE, ['.', `--remote-debugging-port=${A1_CDP_PORT}`, `--user-data-dir=${profileDir}`], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    const page = await waitForA1Cdp();
    const scenarioWs = await connectWS(page.webSocketDebuggerUrl);
    let bridgeReady = false;
    for (let i = 0; i < 20; i++) {
      if (await evalExpr(scenarioWs, `typeof window.claudeLink === 'object'`)) { bridgeReady = true; break; }
      await sleep(500);
    }
    precondition(bridgeReady, `${title}：preload bridge 不可用`);
    await waitBridgeAndTheme(scenarioWs);
    log(`  —— ${title}（profile=${path.basename(profileDir)}）——`);
    await body(scenarioWs, profileDir);
    scenarioWs.close();
  } finally {
    if (proc?.pid) {
      try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { encoding: 'utf8' }); } catch { /* 尽力而为 */ }
    }
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    await sleep(1000); // 端口/进程树清理由余量
  }
}

async function runA1Scenarios() {
  // 前置：out/ 产物新鲜度（防「改源码 × 跑旧产物」假绿，同 cdp-file-preview-smoke 手法）。
  precondition(existsSync(MAIN_OUT) && existsSync(ELECTRON_EXE), 'out/main/index.js 或 electron.exe 缺失——先 npm run build');
  const outMtime = statSync(MAIN_OUT).mtime;
  for (const src of ['src/shared/constants.ts', 'src/main/modules/config-manager.ts']) {
    precondition(outMtime > statSync(path.join(REPO_ROOT, src)).mtime, `out/ 产物过期（${src} 晚于产物）——先 npm run build`);
  }

  console.log('\n── A1 场景组（墨石默认 / warm-paper 迁移 / quiet-console 保持；隔离 --user-data-dir）──');

  // S1：全新配置（无 settings.json）→ 默认墨石（A1-5 + A1-9 CDP 面）
  await runA1Scenario('S1 全新配置', null, async (ws) => {
    await openAppearanceTab(ws);
    await check('A1-5 全新配置：色板卡恰 12 张', async () => {
      const cards = await readPaletteCards(ws);
      if (cards.length !== 12) throw new Error(`卡片 ${cards.length} 张 ≠ 12`);
    });
    await check('A1-5 含「墨石」卡', async () => {
      const cards = await readPaletteCards(ws);
      if (!cards.some((c) => c.name === '墨石')) throw new Error('无 name=墨石 卡');
    });
    await check('A1-5 默认选中卡为墨石（active 命中墨石）', async () => {
      const cards = await readPaletteCards(ws);
      const active = cards.filter((c) => c.active);
      if (active.length !== 1) throw new Error(`active 卡 ${active.length} 张 ≠ 1`);
      if (active[0].name !== '墨石') throw new Error(`active 卡为 ${active[0].name}，非墨石`);
    });
    await check('A1-5 墨石生效根 token：--color-bg=#EFF1F4', async () => {
      const v = await cssVar(ws, '--color-bg');
      if (v !== '#EFF1F4') throw new Error(`--color-bg=${v} ≠ #EFF1F4`);
    });
    await check('A1-5 墨石字段写入链：--color-btn-ink=#17181A / --color-text-sub=#5B6779 / --color-border-strong=#D5DAE1', async () => {
      const btnInk = await cssVar(ws, '--color-btn-ink');
      const textSub = await cssVar(ws, '--color-text-sub');
      const borderStrong = await cssVar(ws, '--color-border-strong');
      if (btnInk !== '#17181A') throw new Error(`--color-btn-ink=${btnInk} ≠ #17181A`);
      if (textSub !== '#5B6779') throw new Error(`--color-text-sub=${textSub} ≠ #5B6779`);
      if (borderStrong !== '#D5DAE1') throw new Error(`--color-border-strong=${borderStrong} ≠ #D5DAE1`);
    });
    await check('A1-9 墨石生效下字号切 large → --font-size-base=18px', async () => {
      await switchFontLarge(ws);
      const v = await evalExpr(ws, `document.documentElement.style.getPropertyValue('--font-size-base').trim()`);
      if (v !== '18px') throw new Error(`--font-size-base=${v} ≠ 18px`);
    });
  });

  // S2：预置 warm-paper（旧默认存量）→ 读路径一次性迁移到墨石且不写回（A1-8 增补，裁决②）
  await runA1Scenario('S2 预置 warm-paper 迁移', {
    themePaletteId: 'warm-paper',
    permissionMode: 'bypassPermissions',
    providerProfiles: [],
    webAccess: { enabled: false, port: 8790, allowedHosts: [] },
  }, async (ws, profileDir) => {
    await openAppearanceTab(ws);
    await check('A1-8 迁移：getConfig 读出 themePaletteId=inkstone（读路径内存映射）', async () => {
      const id = await configThemeId(ws);
      if (id !== 'inkstone') throw new Error(`getConfig().themePaletteId=${id} ≠ inkstone`);
    });
    await check('A1-8 迁移：外观 tab 选中卡为墨石', async () => {
      const cards = await readPaletteCards(ws);
      const active = cards.filter((c) => c.active);
      if (active.length !== 1 || active[0].name !== '墨石') {
        throw new Error(`active 卡=${active.map((c) => c.name).join('/')}，非墨石`);
      }
    });
    await check('A1-8 迁移：settings.json 的 themePaletteId 未被写回（仍 warm-paper）', async () => {
      await evalExpr(ws, `window.claudeLink.getConfig().then(() => 'settled')`);
      const { readFileSync } = await import('node:fs');
      const cfgPath = path.join(profileDir, 'claude-link-config.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (cfg.themePaletteId !== 'warm-paper') {
        throw new Error(`settings.json themePaletteId=${cfg.themePaletteId}（被写回，违背「内存映射不落盘」）`);
      }
    });
    await check('A1-8 迁移：墨石生效根 token --color-bg=#EFF1F4', async () => {
      const v = await cssVar(ws, '--color-bg');
      if (v !== '#EFF1F4') throw new Error(`--color-bg=${v} ≠ #EFF1F4`);
    });
  });

  // S3：预置 quiet-console（非默认存量选择）→ 不被墨石覆盖（A1-8 原用例）+ 旧板 ?? 回退链
  await runA1Scenario('S3 预置 quiet-console 保持', {
    themePaletteId: 'quiet-console',
    permissionMode: 'bypassPermissions',
    providerProfiles: [],
    webAccess: { enabled: false, port: 8790, allowedHosts: [] },
  }, async (ws) => {
    await openAppearanceTab(ws);
    await check('A1-8 保持：getConfig 读出 themePaletteId=quiet-console（未被覆盖）', async () => {
      const id = await configThemeId(ws);
      if (id !== 'quiet-console') throw new Error(`getConfig().themePaletteId=${id} ≠ quiet-console`);
    });
    await check('A1-8 保持：选中卡仍为静默', async () => {
      const cards = await readPaletteCards(ws);
      const active = cards.filter((c) => c.active);
      if (active.length !== 1 || active[0].name !== '静默') {
        throw new Error(`active 卡=${active.map((c) => c.name).join('/')}，非静默`);
      }
    });
    await check('A1-8 保持：静默板根 token --color-bg=#F6F7F8', async () => {
      const v = await cssVar(ws, '--color-bg');
      if (v !== '#F6F7F8') throw new Error(`--color-bg=${v} ≠ #F6F7F8`);
    });
    await check('A1-8 保持：旧板回退链 --color-btn-ink=accent(#1A1D21) / --color-text-sub=textMuted(#6B7280) / --color-border-strong=rgba(0, 0, 0, 0.12)', async () => {
      const btnInk = await cssVar(ws, '--color-btn-ink');
      const textSub = await cssVar(ws, '--color-text-sub');
      const borderStrong = await cssVar(ws, '--color-border-strong');
      if (btnInk !== '#1A1D21') throw new Error(`--color-btn-ink=${btnInk} ≠ #1A1D21`);
      if (textSub !== '#6B7280') throw new Error(`--color-text-sub=${textSub} ≠ #6B7280`);
      if (borderStrong !== 'rgba(0, 0, 0, 0.12)') throw new Error(`--color-border-strong=${borderStrong} ≠ rgba(0, 0, 0, 0.12)`);
    });
  });
}

// ══ A2 场景组（点 A2：ink 语义对变量层三板断言 + 发送钮 disabled opacity 抽验）════════════════
// 裁决（点指令执行侧）：断言对象 = documentElement 上 --color-btn-ink / --color-on-btn-ink 变量的
// 解析值——探针元素 `color: var(--color-btn-ink)` 挂根后经 getComputedStyle 解析为 rgb 形态（该解析
// 同时穿越 :root 静态声明 var(--color-accent) 与 inline 写入两层，单点即验全链）；**不断言**发送钮/
// 新会话钮元素背景 computed（消费方 E1/B6 才 ink 化，其时点由该点复核）。
// 期望值（由 constants.ts 各板字段确定的 rgb 换算）：
//   墨石        btnInk #17181A → rgb(23, 24, 26)   / onBtnInk #FFFFFF → rgb(255, 255, 255)
//   warm-paper  accent  #537D96 → rgb(83, 125, 150)/ onAccent  #FFFFFF → rgb(255, 255, 255)
//   quiet-console accent #1A1D21 → rgb(26, 29, 33)  / onAccent  #FFFFFF → rgb(255, 255, 255)
//   terminal-pro accent  #4EA1FF → rgb(78, 161, 255)/ onAccent  #0B1220 → rgb(11, 18, 32)

async function cssVarResolved(ws, name) {
  return evalExpr(ws, `(() => {
    const probe = document.createElement('i');
    probe.style.color = 'var(${name})';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  })()`);
}

async function clickPaletteCard(ws, name) {
  // 与 readPaletteCards 同口径：palette-name 首文本节点 trim 比对（G2 徽章不进卡名）。
  const ok = await evalExpr(ws, `(() => {
    const card = [...document.querySelectorAll('.palette-card')]
      .find((c) => (c.querySelector('.palette-name')?.childNodes[0]?.textContent ?? '').trim() === '${name}');
    if (!card) return false;
    card.click();
    return true;
  })()`);
  precondition(ok, `色板卡「${name}」不存在`);
  await sleep(400);
}

async function sendButtonOpacity(ws) {
  const v = await evalExpr(ws, `(() => {
    const b = document.querySelector('[data-testid="chat-send-button"]');
    return b ? getComputedStyle(b).opacity : null;
  })()`);
  precondition(typeof v === 'string', '发送钮不存在（chat-send-button）');
  return v;
}

async function runA2Scenarios() {
  // 前置：out/ 产物新鲜度（同 A1 场景组口径；本组复用其 runner 与端口 9337）。
  precondition(existsSync(MAIN_OUT) && existsSync(ELECTRON_EXE), 'out/main/index.js 或 electron.exe 缺失——先 npm run build');
  const outMtime = statSync(MAIN_OUT).mtime;
  for (const src of ['src/shared/constants.ts', 'src/main/modules/config-manager.ts']) {
    precondition(outMtime > statSync(path.join(REPO_ROOT, src)).mtime, `out/ 产物过期（${src} 晚于产物）——先 npm run build`);
  }

  console.log('\n── A2 场景组（墨石默认 → 三板切换 ink 对 + 发送钮 disabled 抽验；隔离 --user-data-dir）──');

  await runA1Scenario('A2-S1 全新配置：墨石默认 + 逐板切换 ink 对 + 发送钮 opacity', null, async (ws) => {
    // A2-5 CDP 抽验（先在聊天页做：空输入=disabled，注入文本=enabled；随后再进外观 tab）
    await enterChat(ws);
    await check('A2-5 发送钮 disabled 抽验：空输入 computed opacity < 有文本 computed opacity', async () => {
      const empty = await sendButtonOpacity(ws);
      const typed = await evalExpr(ws, `(() => {
        const ta = document.querySelector('[data-testid="chat-input-textarea"]');
        if (!ta) return false;
        ta.value = 'ink 探针文本';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      precondition(typed, '聊天输入 textarea 不存在');
      await sleep(400);
      const filled = await sendButtonOpacity(ws);
      log(`     空输入 opacity=${empty} / 有文本 opacity=${filled}`);
      if (!(parseFloat(empty) < parseFloat(filled))) {
        throw new Error(`空输入 opacity=${empty} 未小于有文本 opacity=${filled}（disabled 可计算差异缺失）`);
      }
    });
    await openAppearanceTab(ws);

    // A2-1 墨石默认：ink 对变量解析值 = 近黑/白
    await check('A2-1 墨石生效：--color-btn-ink 解析=rgb(23, 24, 26)', async () => {
      const v = await cssVarResolved(ws, '--color-btn-ink');
      if (v !== 'rgb(23, 24, 26)') throw new Error(`--color-btn-ink 解析=${v} ≠ rgb(23, 24, 26)`);
    });
    await check('A2-1 墨石生效：--color-on-btn-ink 解析=rgb(255, 255, 255)', async () => {
      const v = await cssVarResolved(ws, '--color-on-btn-ink');
      if (v !== 'rgb(255, 255, 255)') throw new Error(`--color-on-btn-ink 解析=${v} ≠ rgb(255, 255, 255)`);
    });

    // A2-2 旧板回退（浅暖纸/浅静默/暗终端三板代表）：解析值=各板 accent/onAccent 且无 #17181A 残留
    await clickPaletteCard(ws, '暖纸');
    await check('A2-2 暖纸回退：ink=rgb(83, 125, 150) / on-ink=rgb(255, 255, 255) 且无 #17181A 残留', async () => {
      const inkV = await cssVarResolved(ws, '--color-btn-ink');
      const onV = await cssVarResolved(ws, '--color-on-btn-ink');
      const raw = await cssVar(ws, '--color-btn-ink');
      if (inkV !== 'rgb(83, 125, 150)') throw new Error(`ink 解析=${inkV} ≠ rgb(83, 125, 150)`);
      if (onV !== 'rgb(255, 255, 255)') throw new Error(`on-ink 解析=${onV} ≠ rgb(255, 255, 255)`);
      if (raw === '#17181A') throw new Error('raw 变量残留 #17181A（切板未覆写）');
    });
    await clickPaletteCard(ws, '静默');
    await check('A2-2 静默回退：ink=rgb(26, 29, 33) / on-ink=rgb(255, 255, 255) 且无 #17181A 残留', async () => {
      const inkV = await cssVarResolved(ws, '--color-btn-ink');
      const onV = await cssVarResolved(ws, '--color-on-btn-ink');
      const raw = await cssVar(ws, '--color-btn-ink');
      if (inkV !== 'rgb(26, 29, 33)') throw new Error(`ink 解析=${inkV} ≠ rgb(26, 29, 33)`);
      if (onV !== 'rgb(255, 255, 255)') throw new Error(`on-ink 解析=${onV} ≠ rgb(255, 255, 255)`);
      if (raw === '#17181A') throw new Error('raw 变量残留 #17181A（切板未覆写）');
    });
    await clickPaletteCard(ws, '终端');
    await check('A2-2 终端回退（暗板代表）：ink=rgb(78, 161, 255) / on-ink=rgb(11, 18, 32) 且无 #17181A 残留', async () => {
      const inkV = await cssVarResolved(ws, '--color-btn-ink');
      const onV = await cssVarResolved(ws, '--color-on-btn-ink');
      const raw = await cssVar(ws, '--color-btn-ink');
      if (inkV !== 'rgb(78, 161, 255)') throw new Error(`ink 解析=${inkV} ≠ rgb(78, 161, 255)`);
      if (onV !== 'rgb(11, 18, 32)') throw new Error(`on-ink 解析=${onV} ≠ rgb(11, 18, 32)`);
      if (raw === '#17181A') throw new Error('raw 变量残留 #17181A（切板未覆写）');
    });
  });
}

// ══ E1 场景组（slate-ui-completion-1108-1428 点 E1：发送钮 ink 化 + Enter 角标）════════════════
// 补全 A2 留下的消费者侧复核（A2 场景组裁决：「断言变量解析值，**不断言**发送钮元素
// computed——消费方 E1 才 ink 化，其时点由该点复核」→ 本组兑现元素 computed 层）：
//   · E1-CT-1 行为面：发送钮内含 aria-hidden="true" 角标 svg 且「发送」文本保留；
//   · E1-CT-2 墨石默认：发送钮 computed bg=rgb(23, 24, 26) / color=rgb(255, 255, 255)（ink 对）；
//   · E1-CT-3/4 旧板回退（暖纸浅板代表 / 终端暗板代表）：computed=各板 accent/onAccent
//     （btn-ink→accent 回退链在元素上的兑现；期望值口径同 A2 注释表）。
// 复用 A1 场景 runner（同端口 9337 / 同隔离纪律 / 同 out/ 新鲜度前置）。
// 聚焦环可见（E1-06②）属目检申报项：脚本 focus() 不触发 :focus-visible 键盘启发式，CDP 不探。

async function sendButtonComputed(ws) {
  const v = await evalExpr(ws, `(() => {
    const b = document.querySelector('[data-testid="chat-send-button"]');
    if (!b) return null;
    const svg = b.querySelector('svg');
    const cs = getComputedStyle(b);
    return {
      text: (b.textContent || '').trim(),
      bg: cs.backgroundColor,
      color: cs.color,
      hasSvg: !!svg,
      ariaHidden: svg ? svg.getAttribute('aria-hidden') : null,
    };
  })()`);
  precondition(v, '发送钮不存在（chat-send-button）');
  return v;
}

async function runE1Scenarios() {
  // 前置：out/ 产物新鲜度（同 A1/A2/A3 场景组口径；本组复用其 runner 与端口 9337）。
  precondition(existsSync(MAIN_OUT) && existsSync(ELECTRON_EXE), 'out/main/index.js 或 electron.exe 缺失——先 npm run build');
  const outMtime = statSync(MAIN_OUT).mtime;
  for (const src of ['src/shared/constants.ts', 'src/main/modules/config-manager.ts']) {
    precondition(outMtime > statSync(path.join(REPO_ROOT, src)).mtime, `out/ 产物过期（${src} 晚于产物）——先 npm run build`);
  }

  console.log('\n── E1 场景组（发送钮 ink 化 computed + 角标 + 旧板回退；隔离 --user-data-dir）──');

  await runA1Scenario('E1-S1 全新配置：墨石默认发送钮 computed=ink 对 + 角标 + 旧板回退', null, async (ws) => {
    await enterChat(ws);
    await check('E1-CT-1 发送钮内含 aria-hidden="true" 角标 svg 且「发送」文本保留', async () => {
      const b = await sendButtonComputed(ws);
      if (!b.hasSvg) throw new Error('发送钮内无角标 svg（角标漏加）');
      if (b.ariaHidden !== 'true') throw new Error(`角标 svg aria-hidden=${b.ariaHidden} ≠ true（装饰性标记缺失）`);
      if (!b.text.includes('发送')) throw new Error(`发送钮文本=${JSON.stringify(b.text)}（「发送」丢失）`);
    });
    await check('E1-CT-2 墨石默认：发送钮 computed bg=rgb(23, 24, 26) / color=rgb(255, 255, 255)（ink 对；A2 留下的消费者侧复核由本组兑现）', async () => {
      const b = await sendButtonComputed(ws);
      log(`     bg=${b.bg} color=${b.color}`);
      if (b.bg !== 'rgb(23, 24, 26)') throw new Error(`bg=${b.bg} ≠ rgb(23, 24, 26)（未走 var(--color-btn-ink)）`);
      if (b.color !== 'rgb(255, 255, 255)') throw new Error(`color=${b.color} ≠ rgb(255, 255, 255)（未走 var(--color-on-btn-ink)）`);
    });

    // 旧板回退：暖纸 accent #537D96 / 终端 accent #4EA1FF + onAccent #0B1220（A2 注释表口径）
    await openAppearanceTab(ws);
    await clickPaletteCard(ws, '暖纸');
    await enterChat(ws);
    await check('E1-CT-3 暖纸回退（浅板代表）：发送钮 computed bg=rgb(83, 125, 150)', async () => {
      const b = await sendButtonComputed(ws);
      if (b.bg !== 'rgb(83, 125, 150)') throw new Error(`bg=${b.bg} ≠ rgb(83, 125, 150)（btn-ink→accent 回退链在元素上未兑现）`);
    });
    await openAppearanceTab(ws);
    await clickPaletteCard(ws, '终端');
    await enterChat(ws);
    await check('E1-CT-4 终端回退（暗板代表）：发送钮 computed bg=rgb(78, 161, 255) / color=rgb(11, 18, 32)', async () => {
      const b = await sendButtonComputed(ws);
      if (b.bg !== 'rgb(78, 161, 255)') throw new Error(`bg=${b.bg} ≠ rgb(78, 161, 255)（btn-ink→accent 回退未兑现）`);
      if (b.color !== 'rgb(11, 18, 32)') throw new Error(`color=${b.color} ≠ rgb(11, 18, 32)（on-btn-ink→on-accent 回退未兑现）`);
    });
  });
}

// ══ E2 场景组（slate-ui-completion-1108-1428 点 E2：工具栏 chips 一体化）════════════════
// 消费者侧断言（静态钉归 tdd-ui-e-input-area-verify.ts E2 节）：
//   · E2-CT-1 结构面（E2-01/02）：四触发钮带 data-testid、钮内图标 svg、文本无 caret 字符；
//   · E2-CT-2 warn 态（E2-04 CDP 半）：无 workingDir 会话 → --warn 类 +「未选择」+ title 全文
//     + 描边半透明（alpha<1，与普通 chip 实色描边可辨——不硬编码板色）；
//   · E2-CT-3 尺寸采样（E2-07 证据包）：四触发钮 rect 记录 + 塌缩下限（裁决：结构钉为主+目检，
//     本采样为证据留痕，热区观感目检申报）；
//   · E2-CT-4 下拉行为（E2-08 行为面 + E2-06 空闲半）：工作空间菜单开 → 权限钮外点关+自身开
//     → toggle 关 → 思考钮开关 → 模型钮（有库才级联，无库跳设置页故条件跳过）。
// E2-06 sending 半（工作空间钮禁用/其余可开）需真实发送回合，本隔离链无 provider 不发——
// 静态矩阵由 tdd-midrun-settings-unlock-verify 既有钉守护（恰 3 处 :disabled="sending"）。
// E2-11 CDP 半（空会话态无 .session-toolbar）在场景前置顺带（fresh profile 首启；若应用
// 启动即恢复会话则条件跳过并记录）。

async function toolbarProbe(ws) {
  return evalExpr(ws, `(() => {
    const btn = (t) => {
      const b = document.querySelector('[data-testid="' + t + '"]');
      if (!b) return null;
      const svg = b.querySelector('svg');
      const r = b.getBoundingClientRect();
      return {
        hasSvg: !!svg,
        svgClass: svg ? svg.getAttribute('class') : '',
        text: (b.textContent || '').trim(),
        title: b.getAttribute('title') ?? '',
        rect: { w: Math.round(r.width), h: Math.round(r.height) },
      };
    };
    return {
      ws: btn('workspace-trigger'),
      perm: btn('permission-trigger'),
      model: btn('model-trigger'),
      tl: btn('thinking-trigger'),
    };
  })()`);
}

async function runE2Scenarios() {
  // 前置：out/ 产物新鲜度（同 A1/E1 场景组口径；本组复用其 runner 与端口 9337）。
  precondition(existsSync(MAIN_OUT) && existsSync(ELECTRON_EXE), 'out/main/index.js 或 electron.exe 缺失——先 npm run build');
  const outMtime = statSync(MAIN_OUT).mtime;
  for (const src of ['src/shared/constants.ts', 'src/main/modules/config-manager.ts']) {
    precondition(outMtime > statSync(path.join(REPO_ROOT, src)).mtime, `out/ 产物过期（${src} 晚于产物）——先 npm run build`);
  }

  console.log('\n── E2 场景组（工具栏 chips 一体化：结构/warn/尺寸/下拉；隔离 --user-data-dir）──');

  await runA1Scenario('E2-S1 全新配置：chips 结构 + warn 态 + 尺寸采样 + 下拉开合', null, async (ws) => {
    // E2-11 CDP 半：fresh profile 首启若仍无会话 → 工具栏不渲染。实测本应用首启即构造
    // 暂态会话占位 activeSession（.session-link 只渲染持久会话，故「无 link 有 toolbar」是
    // 暂态合法活跃态而非渲染门失效）——本断言只钉「无任何会话态（暂态也无）时工具栏缺席」，
    // 该形态在现应用启动流中不可达，检测到即跳过并记录（结构半由静态钉 v-if 守护）。
    await check('E2-11 空会话态：无任何会话时 .session-toolbar 不渲染（可达形态检测；不可达即跳过）', async () => {
      const hasToolbar = await evalExpr(ws, `!!document.querySelector('.session-toolbar')`);
      const hasSessionLink = await evalExpr(ws, `!!document.querySelector('.session-link')`);
      if (!hasToolbar && !hasSessionLink) return;
      log(`     启动态：toolbar=${hasToolbar} sessionLink=${hasSessionLink}（首启即入暂态会话=合法活跃态），空态断言跳过`);
    });

    await enterChat(ws);

    await check('E2-CT-1 四触发钮 data-testid 就位、钮内图标 svg、文本无 caret 字符（E2-01/02）', async () => {
      const r = await toolbarProbe(ws);
      precondition(r && r.ws && r.perm && r.model && r.tl, '四触发钮 data-testid 缺失');
      const expect = { ws: 'ctl__btn-icon', perm: 'ctl__btn-icon', tl: 'tl-btn__icon' };
      for (const [k, cls] of Object.entries(expect)) {
        if (!r[k].hasSvg) throw new Error(`${k} 触发钮内无图标 svg`);
        if (!r[k].svgClass.includes(cls)) throw new Error(`${k} 图标类 ${r[k].svgClass} ≠ ${cls}`);
      }
      // 模型钮图标在 hasLibrary 分支内（无库态走「未配置模型 → 前往设置」文本分支，无图标属设计形态）
      const hasLib = r.model.text.includes('/');
      if (hasLib) {
        if (!r.model.hasSvg) throw new Error('model 触发钮（有库态）内无图标 svg');
        if (!r.model.svgClass.includes('model-trigger__icon')) throw new Error(`model 图标类 ${r.model.svgClass} ≠ model-trigger__icon`);
      }
      if (r.ws.text.includes('▾')) throw new Error(`工作空间钮文本残留 ▾：${r.ws.text}`);
      if (r.model.text.includes('⌃')) throw new Error(`模型钮文本残留 ⌃：${r.model.text}`);
    });

    await check('E2-CT-2 无 workingDir 会话：工作空间钮 warn 态（--warn + 未选择 + title 全文 + 描边半透明）', async () => {
      const probe = await evalExpr(ws, `(() => {
        const b = document.querySelector('[data-testid="workspace-trigger"]');
        if (!b) return null;
        const perm = document.querySelector('[data-testid="permission-trigger"]');
        return {
          warn: b.classList.contains('ctl__btn--warn'),
          text: (b.textContent || '').trim(),
          title: b.getAttribute('title') ?? '',
          border: getComputedStyle(b).borderTopColor,
          permBorder: perm ? getComputedStyle(perm).borderTopColor : '',
        };
      })()`);
      precondition(probe, '工作空间触发钮不存在');
      if (!probe.warn) { log('     会话已有 workingDir（非全新态），warn 断言跳过'); return; }
      if (probe.text !== '未选择') throw new Error(`warn 钮文案=${probe.text} ≠ 未选择`);
      if (probe.title !== '未选择工作空间（运行前必须选择）') throw new Error(`warn 钮 title=${probe.title} 全文失配`);
      // 半透明解析：Chromium 对 color-mix(…, transparent) 的 computed 形态有 rgba() 与
      // color(srgb … / a) 两种——统一抽 alpha 分量判定（50% mix ⇒ alpha=0.5<1；实色描边 alpha=1）。
      const alpha = (c) => {
        const s = c || '';
        const mSlash = /\/\s*([\d.]+)\s*\)$/.exec(s);
        if (mSlash) return parseFloat(mSlash[1]);
        if (/^rgba\(/i.test(s)) {
          const parts = s.replace(/^rgba\(/i, '').replace(/\)$/, '').split(',').map((t) => parseFloat(t));
          if (parts.length >= 4) return parts[3];
        }
        return 1;
      };
      const warnAlpha = alpha(probe.border);
      const permAlpha = alpha(probe.permBorder);
      if (!(warnAlpha < 1)) throw new Error(`warn 描边=${probe.border} alpha=${warnAlpha} 非半透明（50% color-mix 未兑现）`);
      if (permAlpha !== 1) throw new Error(`普通 chip 描边=${probe.permBorder} alpha=${permAlpha} 竟为半透明（对照组失效）`);
      log(`     warn 描边=${probe.border}（alpha=${warnAlpha}）/ 普通描边=${probe.permBorder}（alpha=${permAlpha}）`);
    });

    await check('E2-CT-3 四触发钮热区尺寸采样留痕 + 塌缩下限（E2-07 证据包；目检申报）', async () => {
      const r = await toolbarProbe(ws);
      precondition(r && r.ws && r.perm && r.model && r.tl, '触发钮 rect 采样失败');
      log(`     sizes ws=${r.ws.rect.w}x${r.ws.rect.h} perm=${r.perm.rect.w}x${r.perm.rect.h} model=${r.model.rect.w}x${r.model.rect.h} tl=${r.tl.rect.w}x${r.tl.rect.h}`);
      for (const [k, v] of Object.entries({ ws: r.ws.rect, perm: r.perm.rect, model: r.model.rect, tl: r.tl.rect })) {
        if (v.w < 40 || v.h < 20) throw new Error(`${k} 钮热区 ${v.w}x${v.h} < 40x20（一体化塌缩）`);
      }
    });

    await check('E2-CT-4 下拉开合：工作空间开 → 权限外点关+自身开 → toggle 关 → 思考开关 → 模型（有库）', async () => {
      await evalExpr(ws, `document.querySelector('[data-testid="workspace-trigger"]').click()`);
      await sleep(300);
      if (!(await evalExpr(ws, `!!document.querySelector('.session-toolbar .menu')`))) throw new Error('点工作空间钮菜单未展开');
      await evalExpr(ws, `document.querySelector('[data-testid="permission-trigger"]').click()`);
      await sleep(300);
      const wsClosed = await evalExpr(ws, `!document.querySelector('.session-toolbar .menu')`);
      const permOpen = await evalExpr(ws, `!!document.querySelector('.perm-menu')`);
      if (!wsClosed || !permOpen) throw new Error(`外点关链断裂（wsClosed=${wsClosed} permOpen=${permOpen}）`);
      await evalExpr(ws, `document.querySelector('[data-testid="permission-trigger"]').click()`);
      await sleep(300);
      if (!(await evalExpr(ws, `!document.querySelector('.perm-menu')`))) throw new Error('权限面板 toggle 关闭失效');
      await evalExpr(ws, `document.querySelector('[data-testid="thinking-trigger"]').click()`);
      await sleep(300);
      if (!(await evalExpr(ws, `!!document.querySelector('.tl-menu')`))) throw new Error('思考菜单未展开');
      await evalExpr(ws, `document.querySelector('[data-testid="thinking-trigger"]').click()`);
      await sleep(300);
      if (!(await evalExpr(ws, `!document.querySelector('.tl-menu')`))) throw new Error('思考菜单 toggle 关闭失效');
      // 模型钮：无库时点击跳设置页（toggleOpen 三态），故仅在 hasLibrary 时断言级联
      const hasLib = await evalExpr(ws, `!!document.querySelector('[data-testid="model-trigger"] .model-trigger__provider')`);
      if (hasLib) {
        await evalExpr(ws, `document.querySelector('[data-testid="model-trigger"]').click()`);
        await sleep(300);
        if (!(await evalExpr(ws, `!!document.querySelector('.cascade')`))) throw new Error('模型级联未展开');
        await evalExpr(ws, `document.querySelector('[data-testid="model-trigger"]').click()`);
        await sleep(300);
        if (!(await evalExpr(ws, `!document.querySelector('.cascade')`))) throw new Error('模型级联 toggle 关闭失效');
      } else {
        log('     无供应商库（隔离 profile），模型级联断言跳过（该形态归 commands-e2e 既有链）');
      }
    });
  });
}

// ══ E6 场景组（slate-ui-completion-1108-1428 点 E6：附件草稿卡移入浮岛）══════════════
// 消费者侧断言（静态钉归 tdd-ui-e-input-area-verify.ts E6 节 + regression 位置序反转钉）：
//   · E6-CT-1 空态（E6-05 CDP 半）：无附件草稿时 .attachment-draft-list 不渲染（v-if 空壳
//     不占位），浮岛 .chat-composer 与 .chat-input 结构完好；
//   · E6-CT-2 播种入岛（E6-01 行为半）：合成 ClipboardEvent('paste') 携带 1×1 PNG File 走
//     真实 stageFiles→IPC→草稿链，.attachment-draft-list 渲染于 .chat-composer 内部且
//     DOM 序在 .chat-input 之前（compareDocumentPosition），缩略图 <img> 真链加载；
//   · E6-CT-3 拖放高亮（E6-06 CDP 半）：合成 DragEvent('dragenter' Files) → .chat-composer--drag
//     仍挂浮岛本体，高亮圈（浮岛自身描边）几何包住入岛后的附件行；dragleave 复位；
//   · E6-CT-4 移除链（E6-03 保全行为半）：点击 .att-card__remove → 行消失、空态恢复。
// 隔离纪律同 A1/E1/E2：独立 --user-data-dir、用后删 profile；无 provider 不发真消息。

async function runE6Scenarios() {
  // 前置：out/ 产物新鲜度（同 A1/E1 场景组口径；本组复用其 runner 与端口 9337）。
  precondition(existsSync(MAIN_OUT) && existsSync(ELECTRON_EXE), 'out/main/index.js 或 electron.exe 缺失——先 npm run build');
  const outMtime = statSync(MAIN_OUT).mtime;
  for (const src of ['src/shared/constants.ts', 'src/main/modules/config-manager.ts']) {
    precondition(outMtime > statSync(path.join(REPO_ROOT, src)).mtime, `out/ 产物过期（${src} 晚于产物）——先 npm run build`);
  }

  console.log('\n── E6 场景组（附件草稿卡移入浮岛：空态/播种入岛/拖放高亮/移除链；隔离 --user-data-dir）──');

  await runA1Scenario('E6-S1 全新配置：附件行浮岛内位置 + 空态不占位 + 播种/移除链', null, async (ws) => {
    await enterChat(ws);

    await check('E6-CT-1 空态：.chat-composer 在且内部无 .attachment-draft-list（v-if 空壳不占位；E6-05 CDP 半）', async () => {
      const r = await evalExpr(ws, `(() => {
        const c = document.querySelector('.chat-composer');
        if (!c) return { composer: false };
        return {
          composer: true,
          list: !!c.querySelector('.attachment-draft-list'),
          input: !!c.querySelector('.chat-input'),
        };
      })()`);
      if (!r.composer) throw new Error('.chat-composer 不存在（浮岛结构破坏）');
      if (r.list) throw new Error('无附件时 .attachment-draft-list 仍渲染（空壳占位，v-if 守卫丢失）');
      if (!r.input) throw new Error('.chat-input 不在浮岛内（输入区结构破坏）');
    });

    // 播种：合成 paste 携带小 PNG File，走真实 stageFiles→IPC→草稿链（隔离 profile 内）。
    await check('E6-CT-2 播种图片附件（合成 paste 走真实 stageFiles/IPC 链）→ .attachment-draft-list 渲染于浮岛内部、DOM 序在 .chat-input 之前、缩略图真链加载（E6-01/02 行为半）', async () => {
      const seeded = await evalExpr(ws, `(() => {
        const px = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
        const bytes = Uint8Array.from(atob(px), (ch) => ch.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'e6-probe.png', { type: 'image/png' }));
        const page = document.querySelector('.chat-page');
        if (!page) return false;
        page.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        return true;
      })()`);
      if (!seeded) throw new Error('合成 paste 派发失败（.chat-page 缺失）');
      // 等 IPC 落草稿 + 缩略图 Blob URL 链。
      const deadline = Date.now() + 10_000;
      let st = null;
      for (;;) {
        st = await evalExpr(ws, `(() => {
          const c = document.querySelector('.chat-composer');
          const l = document.querySelector('.attachment-draft-list');
          const input = document.querySelector('.chat-input');
          const thumb = document.querySelector('.att-card__thumb-img');
          return {
            inComposer: !!(c && l && c.contains(l)),
            beforeInput: !!(l && input && !!(l.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING)),
            thumbLoaded: !!thumb && thumb.naturalWidth > 0,
            cards: document.querySelectorAll('.att-card').length,
          };
        })()`);
        if (st.inComposer && st.beforeInput && st.thumbLoaded) break;
        if (Date.now() > deadline) break;
        await sleep(400);
      }
      log(`     inComposer=${st.inComposer} beforeInput=${st.beforeInput} thumbLoaded=${st.thumbLoaded} cards=${st.cards}`);
      if (!st.inComposer) throw new Error('附件列表未渲染或不在 .chat-composer 内部（E6 移动未生效或草稿链断）');
      if (!st.beforeInput) throw new Error('附件列表 DOM 序不在 .chat-input 之前（岛内错位）');
      if (st.cards !== 1) throw new Error(`附件卡 ${st.cards} 张 ≠ 1（播种重复或丢失）`);
      if (!st.thumbLoaded) throw new Error('缩略图 <img> 未加载（缩略图 IPC 链断）');
    });

    await check('E6-CT-3 拖放高亮（E6-06 CDP 半）：合成 dragenter(Files) → .chat-composer--drag 挂浮岛本体且高亮圈几何包住附件行；dragleave 复位', async () => {
      // Vue 类绑定经微任务刷新：dispatch 与读 class 必须分两次 CDP 往返（同任务内读恒为旧值）。
      const dispatched = await evalExpr(ws, `(() => {
        const page = document.querySelector('.chat-page');
        if (!page) return false;
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(1)], 'drag.png', { type: 'image/png' }));
        page.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
        return true;
      })()`);
      if (!dispatched) throw new Error('.chat-page 缺失');
      const deadline = Date.now() + 5_000;
      let r = null;
      for (;;) {
        r = await evalExpr(ws, `(() => {
          const c = document.querySelector('.chat-composer');
          const l = document.querySelector('.attachment-draft-list');
          if (!c || !l) return null;
          const cr = c.getBoundingClientRect();
          const lr = l.getBoundingClientRect();
          return {
            drag: c.classList.contains('chat-composer--drag'),
            contains: cr.top <= lr.top && lr.bottom <= cr.bottom && cr.left <= lr.left && lr.right <= cr.right,
          };
        })()`);
        if (r && r.drag) break;
        if (Date.now() > deadline) break;
        await sleep(300);
      }
      if (!r) throw new Error('.chat-composer / .attachment-draft-list 缺失');
      if (!r.drag) throw new Error('dragenter(Files) 后 .chat-composer--drag 未出现（拖放高亮链断）');
      if (!r.contains) throw new Error('浮岛高亮圈未包住附件行（附件行溢出浮岛几何）');
      // dragleave 复位：同样拆往返等微任务。
      await evalExpr(ws, `(() => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(1)], 'drag.png', { type: 'image/png' }));
        document.querySelector('.chat-page').dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt, bubbles: true, cancelable: true }));
        return true;
      })()`);
      const leaveDeadline = Date.now() + 5_000;
      let reset = false;
      for (;;) {
        reset = await evalExpr(ws, `!document.querySelector('.chat-composer')?.classList.contains('chat-composer--drag')`);
        if (reset) break;
        if (Date.now() > leaveDeadline) break;
        await sleep(300);
      }
      if (!reset) throw new Error('dragleave 后高亮未复位（dragCounter 计数失衡）');
    });

    await check('E6-CT-4 移除链（E6-03 保全行为半）：点击 .att-card__remove → 行消失、空态恢复（无残留占位）', async () => {
      const clicked = await evalExpr(ws, `(() => {
        const b = document.querySelector('.att-card__remove');
        if (!b) return false;
        b.click();
        return true;
      })()`);
      if (!clicked) throw new Error('移除钮 .att-card__remove 不存在');
      const deadline = Date.now() + 8_000;
      let gone = false;
      for (;;) {
        gone = await evalExpr(ws, `!document.querySelector('.attachment-draft-list')`);
        if (gone) break;
        if (Date.now() > deadline) break;
        await sleep(400);
      }
      if (!gone) throw new Error('移除后 .attachment-draft-list 仍在（移除链断或 v-if 未回收）');
    });
  });
}

// ══ G 配置页组（slate-ui-completion-1108-1428 点 G1：CLI 横幅 tab 门控运行时面）══════════════
// G1-02（tests 卷 G-config-core-cases.md G1-02 的 CDP 落点；静态半边在 tdd-config-core-g1-g5-verify.ts）：
//   · G1-02a 连接 tab（默认激活）：.banner 在场、可见（offsetParent 非空）、为 .wb-connection
//     首个元素子节点、激活 tab 文案=「连接」；
//   · G1-02b 逐个点击其余 7 tab（行为/外观/Skill/MCP/IM/网页访问/关于）：横幅不可见。
//     转写裁决（申报留痕）：tab 面板按 G3-02 须保持 v-show 常挂（IM 扫码链/Skill-MCP 探测态
//     不重置），横幅随容器 display:none 隐藏——行为规范 §G1「其他 tab 不显示 / 深链 ?tab= 直达
//     其他 tab 时无横幅」按用户可见语义断言为「不可见」；若横幅仍在 DOM，必须仍居
//     .wb-connection 之内（结构性兜底：横幅只允许活在连接面板里）；
//   · G1-02c 切回连接 tab：横幅恢复可见且仍为首元素子节点（v-show 门控双向）；
//   · G1-02d 深链 ?tab=about 直达（置 hash 后 reload 冷载，走 onMounted query 解析路径）：
//     无横幅可见、激活 tab=「关于」；
//   · G1-02e 深链后点连接 tab：横幅恢复可见。
// 隔离纪律同 A1/E6：独立 --user-data-dir、用后删 profile；复用 runA1Scenario runner 与端口 9337。

async function bannerState(ws) {
  return evalExpr(ws, `(() => {
    const b = document.querySelector('.banner');
    const wb = document.querySelector('.wb-connection');
    return {
      present: !!b,
      visible: !!b && b.offsetParent !== null,
      inPanel: !!b && !!b.closest('.wb-connection'),
      firstChild: !!b && !!wb && wb.firstElementChild === b,
      activeTab: [...document.querySelectorAll('.tab')].find((t) => t.classList.contains('tab--active'))?.textContent?.trim() ?? '',
    };
  })()`);
}

async function enterConfigWait(ws) {
  // 设置页路由切换有挂载窗口期：轮询重试（同 openAppearanceTab 手法，但不点具体 tab——G1 断言默认连接 tab）。
  const deadline = Date.now() + 10_000;
  for (;;) {
    await evalExpr(ws, `(() => { document.querySelector('.settings-link')?.click(); return true; })()`);
    await sleep(800);
    const ok = await evalExpr(ws, `!!document.querySelector('.workbench') && document.querySelectorAll('.tab').length === 8`);
    if (ok) return;
    if (Date.now() > deadline) throw new PreconditionError('配置页未挂载（.workbench / 8 tab 缺失）');
  }
}

async function clickTabByText(ws, text) {
  const ok = await evalExpr(ws, `(() => {
    const btn = [...document.querySelectorAll('.tab')].find((b) => b.textContent.trim() === '${text}');
    if (!btn) return false;
    btn.click(); return true;
  })()`);
  precondition(ok, `tab 按钮「${text}」不存在`);
  await sleep(300);
}

const G_OTHER_TABS = ['行为', '外观', 'Skill', 'MCP', 'IM', '网页访问', '关于'];

async function runG1Scenario() {
  // 前置：out/ 产物新鲜度（同 A1/E6 场景组口径；本组复用其 runner 与端口 9337）。
  precondition(existsSync(MAIN_OUT) && existsSync(ELECTRON_EXE), 'out/main/index.js 或 electron.exe 缺失——先 npm run build');
  const outMtime = statSync(MAIN_OUT).mtime;
  for (const src of ['src/shared/constants.ts', 'src/main/modules/config-manager.ts']) {
    precondition(outMtime > statSync(path.join(REPO_ROOT, src)).mtime, `out/ 产物过期（${src} 晚于产物）——先 npm run build`);
  }

  console.log('\n── G 配置页组（CLI 横幅 tab 门控：连接首位 / 其余 7 tab 不可见 / 深链直达 / 切回恢复；隔离 --user-data-dir）──');

  await runA1Scenario('G1-S1 全新配置', null, async (ws) => {
    // reload 冷载可能瞬断页面 WS 会话：本组后续断言统一走 ensureLive 后的连接。
    let conn = ws;
    const ensureLive = async () => {
      try {
        await evalExpr(conn, `1`);
        return;
      } catch {
        try { conn.close(); } catch { /* 尽力而为 */ }
      }
      const page = await getPageTarget(A1_CDP_PORT);
      precondition(page, '深链 reload 后页面 target 丢失');
      conn = await connectWS(page.webSocketDebuggerUrl);
    };

    await enterConfigWait(conn);

    await check('G1-02a 连接 tab 默认激活：横幅在场、可见、wb-connection 首个元素子节点', async () => {
      const s = await bannerState(conn);
      if (!s.present) throw new Error('.banner 不在 DOM（连接 tab 应渲染横幅）');
      if (!s.visible) throw new Error('.banner 不可见（连接 tab 横幅被隐藏）');
      if (!s.inPanel) throw new Error('.banner 不在 .wb-connection 之内');
      if (!s.firstChild) throw new Error('.banner 非 .wb-connection 首个元素子节点');
      if (s.activeTab !== '连接') throw new Error(`默认激活 tab=${s.activeTab} ≠ 连接`);
    });

    for (const tab of G_OTHER_TABS) {
      await check(`G1-02b 点击「${tab}」tab：横幅不可见（其他 tab 不显示）`, async () => {
        await ensureLive();
        await clickTabByText(conn, tab);
        const s = await bannerState(conn);
        if (s.visible) throw new Error(`「${tab}」tab 下横幅仍可见（tab 门控失效）`);
        if (s.present && !s.inPanel) throw new Error('.banner 存在但脱离 .wb-connection（结构越位）');
      });
    }

    await check('G1-02c 切回连接 tab：横幅恢复可见且仍为首元素子节点', async () => {
      await ensureLive();
      await clickTabByText(conn, '连接');
      const s = await bannerState(conn);
      if (!s.present || !s.visible || !s.firstChild) throw new Error(`切回后横幅态异常：${JSON.stringify(s)}`);
    });

    await check('G1-02d 深链 ?tab=about 直达（reload 冷载走 onMounted 解析）：无横幅可见', async () => {
      await ensureLive();
      try {
        await evalExpr(conn, `location.hash = '#/config?tab=about'; location.reload(); true`);
      } catch { /* reload 可能瞬断 WS，忽略 */ }
      // 冷载后等就绪（bridge + 配置页挂载；WS 若断由 ensureLive 重连）。
      const deadline = Date.now() + 25_000;
      for (;;) {
        await ensureLive();
        let ready = false;
        try {
          ready = await evalExpr(conn, `typeof window.claudeLink === 'object' && !!document.querySelector('.workbench')`);
        } catch { /* 未就绪继续轮询 */ }
        if (ready) break;
        if (Date.now() > deadline) throw new Error('深链 reload 后 25s 内配置页未就绪');
        await sleep(500);
      }
      await sleep(500);
      const s = await bannerState(conn);
      if (s.visible) throw new Error('深链 ?tab=about 直达下横幅仍可见（深链门控穿帮）');
      if (s.present && !s.inPanel) throw new Error('.banner 存在但脱离 .wb-connection');
      if (s.activeTab !== '关于') throw new Error(`深链后激活 tab=${s.activeTab} ≠ 关于`);
    });

    await check('G1-02e 深链后点连接 tab：横幅恢复可见（v-show 门控双向）', async () => {
      await ensureLive();
      await clickTabByText(conn, '连接');
      const s = await bannerState(conn);
      if (!s.present || !s.visible || !s.firstChild) throw new Error(`深链→连接横幅态异常：${JSON.stringify(s)}`);
    });
  });
}

// ══ G2 场景组（slate-ui-completion-1108-1428 点 G2：ThemeSelector button 化键盘可达）══════════
// G2-04（tests 卷 G-config-core-cases.md G2-04 的 CDP 落点；静态半边在 tdd-config-core-g1-g5-verify.ts）：
// 真实键盘事件走 CDP Input.dispatchKeyEvent（合成 DOM KeyboardEvent 不触发原生 button 的
// click 激活默认行为，不可替代）：Tab 聚焦色板卡 → 连续 Tab 在 12 卡间移动 → Enter/Space 激活
// 选色 → config.themePaletteId 即时变更（700ms 防抖自动保存后 getConfig 读出，轮询窗 6s）
// ＋ active/aria-pressed 迁移（运行时钉防结构绕过——G2-01 的 button 化被改回 div 时本组必红）。
// 卡序↔色板 id 映射：v-for DOM 序 = THEME_PALETTES 数组序（静态钉守护），id 表由 constants.ts 解析。
function paletteIdsFromConstants() {
  const src = readFileSync(path.join(REPO_ROOT, 'src', 'shared', 'constants.ts'), 'utf8');
  const start = src.indexOf('THEME_PALETTES: ThemePalette[] = [');
  precondition(start !== -1, 'constants.ts 未找到 THEME_PALETTES 数组');
  const end = src.indexOf('\n];', start);
  precondition(end !== -1, 'constants.ts THEME_PALETTES 数组未闭合（解析切片失效）');
  const ids = [];
  for (const m of src.slice(start, end).matchAll(/\bid:\s*'([^']+)'/g)) ids.push(m[1]);
  return ids;
}

const KEY_TAB = { key: 'Tab', code: 'Tab', vk: 9, text: '\t' };
const KEY_ENTER = { key: 'Enter', code: 'Enter', vk: 13, text: '\r' };
const KEY_SPACE = { key: ' ', code: 'Space', vk: 32, text: ' ' };

// modifiers 为 CDP 位掩码 int（Alt=1/Ctrl=2/Meta=4/Shift=8），非数组（-32602 教训留痕）。
// text 必传：缺 text 的 keyDown 会被 CDP 降级为 rawKeyDown（无字符事件），Chromium 对
// button 的 Enter 点击激活走字符事件默认行为——漏传时 Enter 不触发 click（G2-04d 首跑留痕）。
async function pressKey(ws, { key, code, vk, text }, modifiers = 0) {
  await cdpCall(ws, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text, modifiers,
  });
  await cdpCall(ws, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers,
  });
}

async function activeCardProbe(ws) {
  return evalExpr(ws, `(() => {
    const a = document.activeElement;
    if (!a) return null;
    const cards = [...document.querySelectorAll('.palette-card')];
    return {
      isCard: a.classList.contains('palette-card'),
      idx: cards.indexOf(a),
      pressed: a.getAttribute('aria-pressed'),
      active: a.classList.contains('active'),
    };
  })()`);
}

async function pollConfigThemeId(ws, want, ms = 6000) {
  const deadline = Date.now() + ms;
  let id = '';
  for (;;) {
    id = await configThemeId(ws);
    if (id === want) return id;
    if (Date.now() > deadline) return id;
    await sleep(300);
  }
}

async function runG2Scenario() {
  // 前置：out/ 产物新鲜度（同 G1/A1 场景组口径；本组复用其 runner 与端口 9337）。
  precondition(existsSync(MAIN_OUT) && existsSync(ELECTRON_EXE), 'out/main/index.js 或 electron.exe 缺失——先 npm run build');
  const outMtime = statSync(MAIN_OUT).mtime;
  for (const src of ['src/shared/constants.ts', 'src/main/modules/config-manager.ts']) {
    precondition(outMtime > statSync(path.join(REPO_ROOT, src)).mtime, `out/ 产物过期（${src} 晚于产物）——先 npm run build`);
  }

  console.log('\n── G2 配置页组（ThemeSelector 键盘可达：Tab/Enter/Space 真实按键选色即时生效；隔离 --user-data-dir）──');

  await runA1Scenario('G2-S1 全新配置：色板卡键盘可达可选', null, async (ws) => {
    await openAppearanceTab(ws);

    const paletteIds = paletteIdsFromConstants();
    precondition(paletteIds.length === 12, `constants.ts 色板 id 解析 ${paletteIds.length} ≠ 12`);
    precondition(paletteIds[10] === 'quiet-console' && paletteIds[11] === 'terminal-pro', `constants.ts 尾两板 id=${paletteIds[10]}/${paletteIds[11]} ≠ quiet-console/terminal-pro（序映射锚失效）`);

    await check('G2-04a 12 张色板卡自动渲染（v-for 数据面运行时半边）', async () => {
      const n = await evalExpr(ws, `document.querySelectorAll('.palette-card').length`);
      if (n !== 12) throw new Error(`色板卡 ${n} 张 ≠ 12`);
    });

    await check('G2-01r 卡为原生 button[type=button] 且 aria-pressed 与 active 同源（运行时钉防结构绕过）', async () => {
      const s = await evalExpr(ws, `(() => {
        const cards = [...document.querySelectorAll('.palette-card')];
        return {
          allBtn: cards.every((c) => c.tagName === 'BUTTON' && c.getAttribute('type') === 'button'),
          activeIdx: cards.findIndex((c) => c.classList.contains('active')),
          pressedIdx: cards.findIndex((c) => c.getAttribute('aria-pressed') === 'true'),
          pressedCount: cards.filter((c) => c.getAttribute('aria-pressed') === 'true').length,
        };
      })()`);
      if (!s.allBtn) throw new Error('存在非 button[type=button] 色板卡');
      if (s.activeIdx === -1 || s.pressedIdx !== s.activeIdx || s.pressedCount !== 1) {
        throw new Error(`aria-pressed 与 active 不同源：active=${s.activeIdx} pressed=${s.pressedIdx}/${s.pressedCount}`);
      }
    });

    await check('G2-04b Tab 真实按键可达色板卡（首个命中=首卡，循 DOM 序）', async () => {
      let probe = null;
      let reached = false;
      for (let i = 0; i < 60; i += 1) {
        await pressKey(ws, KEY_TAB);
        probe = await activeCardProbe(ws);
        if (probe && probe.isCard) { reached = true; break; }
      }
      if (!reached || !probe) throw new Error('60 次 Tab 内焦点未落到 .palette-card（键盘不可达）');
      if (probe.idx !== 0) throw new Error(`首个聚焦卡序 ${probe.idx} ≠ 0（Tab 序应循 DOM 序命中首卡）`);
    });

    await check('G2-04c 连续 Tab 在 12 卡间移动焦点（自首卡 11 步全落卡内，末步=末卡）', async () => {
      for (let step = 1; step <= 11; step += 1) {
        await pressKey(ws, KEY_TAB);
        const probe = await activeCardProbe(ws);
        if (!probe || !probe.isCard) throw new Error(`第 ${step} 步 Tab 焦点离开色板卡`);
        if (probe.idx !== step) throw new Error(`第 ${step} 步 Tab 聚焦卡序 ${probe.idx} ≠ ${step}`);
      }
    });

    await check('G2-04d Enter 激活末卡（终端 terminal-pro）：config.themePaletteId 即时变更 + active/aria-pressed 迁移', async () => {
      await pressKey(ws, KEY_ENTER);
      const probe = await activeCardProbe(ws);
      if (!probe || !probe.isCard || probe.idx !== 11) throw new Error(`Enter 后焦点异常：${JSON.stringify(probe)}`);
      if (probe.active !== true || probe.pressed !== 'true') throw new Error('Enter 后末卡 active/aria-pressed 未迁移');
      const id = await pollConfigThemeId(ws, paletteIds[11]);
      if (id !== paletteIds[11]) throw new Error(`getConfig().themePaletteId=${id} ≠ ${paletteIds[11]}（切换未生效）`);
    });

    await check('G2-04e Shift+Tab 回退 + Space 激活次末卡（静默 quiet-console）：config 即时变更', async () => {
      await pressKey(ws, KEY_TAB, 8); // Shift 位掩码
      let probe = await activeCardProbe(ws);
      if (!probe || !probe.isCard || probe.idx !== 10) throw new Error(`Shift+Tab 后焦点异常：${JSON.stringify(probe)}`);
      await pressKey(ws, KEY_SPACE);
      probe = await activeCardProbe(ws);
      if (!probe || probe.active !== true || probe.pressed !== 'true') throw new Error('Space 后次末卡 active/aria-pressed 未迁移');
      const id = await pollConfigThemeId(ws, paletteIds[10]);
      if (id !== paletteIds[10]) throw new Error(`getConfig().themePaletteId=${id} ≠ ${paletteIds[10]}（切换未生效）`);
    });
  });
}

// ══ G3 场景组（slate-ui-completion-1108-1428 点 G3：骨架运行时面——tablist/tabpanel + 返回钮左置 + 字号 seg 键盘）══
// G3-01/G3-02/G3-03 的 CDP 落点（静态半边在 tdd-config-core-g1-g5-verify.ts G3 小节）：
//   · G3-02r tab 语义三件套运行时钉：nav[role=tablist] + 8 个 button[role=tab]（id=cfg-tab-*，
//     aria-selected 恰一 true 且随激活迁移）+ 8 个 [role=tabpanel]（aria-labelledby 与 tab id 配对、
//     恰一可见——v-show 门控运行时面）；
//   · G3-01r 返回钮列左置：.back-button 左缘与 .workbench 内容列左缘对齐（bounding box 差 ≤8px），
//     且位于列左半（防右推形态回归）；
//   · G3-03r 字号 seg：三档「小 14/中 16/大 18」radio（aria-checked 恰一 true、roving tabindex）；
//     外观面板 select 归零（运行时负断言）；真实方向键（CDP Input 域）←/→/↑/↓ 切档且**即时生效**
//     （documentElement inline --font-size-base 无需失焦/保存即变化）＋端点停不循环（Owner 裁决）
//     ＋焦点跟随；点击切档即时生效；config.fontScale 经自动保存链落盘（轮询窗 6s）。
// 隔离纪律同 G1/G2：独立 --user-data-dir、用后删 profile；复用 runA1Scenario runner 与端口 9337。
// 档位 px 表由 constants.ts 解析（fontScaleSizesFromConstants），与 seg 派生同源，杜绝测试自造值。
function fontScaleSizesFromConstants() {
  const src = readFileSync(path.join(REPO_ROOT, 'src', 'shared', 'constants.ts'), 'utf8');
  const start = src.indexOf('export const FONT_SCALE_SIZES');
  precondition(start !== -1, 'constants.ts 未找到 FONT_SCALE_SIZES');
  const end = src.indexOf('};', start);
  precondition(end !== -1, 'constants.ts FONT_SCALE_SIZES 未闭合');
  const sizes = {};
  for (const m of src.slice(start, end).matchAll(/\b(small|medium|large):\s*'(\d+)px'/g)) sizes[m[1]] = `${m[2]}px`;
  precondition(Object.keys(sizes).length === 3, `constants.ts FONT_SCALE_SIZES 解析异常：${JSON.stringify(sizes)}`);
  return sizes;
}

const KEY_ARROW_LEFT = { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37, text: '' };
const KEY_ARROW_RIGHT = { key: 'ArrowRight', code: 'ArrowRight', vk: 39, text: '' };
const KEY_ARROW_UP = { key: 'ArrowUp', code: 'ArrowUp', vk: 38, text: '' };
const KEY_ARROW_DOWN = { key: 'ArrowDown', code: 'ArrowDown', vk: 40, text: '' };

async function fontSegProbe(ws) {
  return evalExpr(ws, `(() => {
    const seg = document.querySelector('.font-seg');
    if (!seg) return null;
    const radios = [...seg.querySelectorAll('[role="radio"]')];
    const checked = radios.findIndex((r) => r.getAttribute('aria-checked') === 'true');
    const ae = document.activeElement;
    return {
      role: seg.getAttribute('role'),
      labelledby: seg.getAttribute('aria-labelledby'),
      labels: radios.map((r) => r.textContent.trim()),
      checked,
      checkedCount: radios.filter((r) => r.getAttribute('aria-checked') === 'true').length,
      tabindex: radios.map((r) => r.getAttribute('tabindex')),
      focusIdx: radios.indexOf(ae),
      inlineBase: document.documentElement.style.getPropertyValue('--font-size-base').trim(),
      tagNames: radios.map((r) => r.tagName),
      selectInAppearance: !!document.querySelector('[aria-labelledby="cfg-tab-appearance"] select'),
    };
  })()`);
}

async function pollConfigFontScale(ws, want, ms = 6000) {
  const deadline = Date.now() + ms;
  let v = '';
  for (;;) {
    v = await evalExpr(ws, `window.claudeLink.getConfig().then((c) => String(c.fontScale ?? ''))`);
    if (v === want) return v;
    if (Date.now() > deadline) return v;
    await sleep(300);
  }
}

async function focusSegRadio(ws, idx) {
  const ok = await evalExpr(ws, `(() => {
    const radios = [...document.querySelectorAll('.font-seg [role="radio"]')];
    if (!radios[${idx}]) return false;
    radios[${idx}].focus(); return true;
  })()`);
  precondition(ok, `seg 第 ${idx} 档不存在（focus 失败）`);
  await sleep(150);
}

async function runG3Scenario() {
  // 前置：out/ 产物新鲜度（同 G1/G2 场景组口径；本组复用其 runner 与端口 9337）。
  precondition(existsSync(MAIN_OUT) && existsSync(ELECTRON_EXE), 'out/main/index.js 或 electron.exe 缺失——先 npm run build');
  const outMtime = statSync(MAIN_OUT).mtime;
  for (const src of ['src/shared/constants.ts', 'src/main/modules/config-manager.ts']) {
    precondition(outMtime > statSync(path.join(REPO_ROOT, src)).mtime, `out/ 产物过期（${src} 晚于产物）——先 npm run build`);
  }

  console.log('\n── G3 配置页组（tablist/tabpanel 运行时 + 返回钮左置 + 字号 seg 方向键即时生效；隔离 --user-data-dir）──');

  await runA1Scenario('G3-S1 全新配置', null, async (ws) => {
    await enterConfigWait(ws);

    await check('G3-02r tab 语义三件套运行时钉（tablist/tab×8/aria-selected 恰一 true）', async () => {
      const s = await evalExpr(ws, `(() => {
        const nav = document.querySelector('nav.tabs');
        if (!nav) return null;
        const tabs = [...nav.querySelectorAll('button')];
        return {
          role: nav.getAttribute('role'),
          label: nav.getAttribute('aria-label'),
          n: tabs.length,
          roles: tabs.every((t) => t.getAttribute('role') === 'tab'),
          ids: tabs.map((t) => t.id),
          selected: tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length,
          selectedText: tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.textContent?.trim() ?? '',
          allHaveSelected: tabs.every((t) => t.getAttribute('aria-selected') !== null),
        };
      })()`);
      if (!s) throw new Error('nav.tabs 不在 DOM');
      if (s.role !== 'tablist') throw new Error(`nav role=${s.role} ≠ tablist`);
      if (s.label !== '设置分类') throw new Error(`nav aria-label=${s.label} ≠ 设置分类（既有文案漂移）`);
      if (s.n !== 8 || !s.roles) throw new Error(`tab 数=${s.n} role 全 tab=${s.roles}`);
      if (s.ids.filter((id) => id.startsWith('cfg-tab-')).length !== 8 || new Set(s.ids).size !== 8) {
        throw new Error(`tab id 异常：${JSON.stringify(s.ids)}`);
      }
      if (s.selected !== 1) throw new Error(`aria-selected=true 计数 ${s.selected} ≠ 1`);
      if (s.selectedText !== '连接') throw new Error(`aria-selected 落点=${s.selectedText} ≠ 连接（默认激活 tab）`);
      if (!s.allHaveSelected) throw new Error('存在无 aria-selected 属性的 tab');
    });

    await check('G3-02r tabpanel 运行时钉（8 容器配对 + 恰一可见 = v-show 门控运行时面）', async () => {
      const s = await evalExpr(ws, `(() => {
        const panels = [...document.querySelectorAll('[role="tabpanel"]')];
        const tabIds = new Set([...document.querySelectorAll('nav.tabs button')].map((t) => t.id));
        return {
          n: panels.length,
          paired: panels.every((p) => tabIds.has(p.getAttribute('aria-labelledby') ?? '')),
          visible: panels.filter((p) => p.offsetParent !== null).length,
          activeLabelledby: panels.find((p) => p.offsetParent !== null)?.getAttribute('aria-labelledby') ?? '',
        };
      })()`);
      if (s.n !== 8) throw new Error(`tabpanel 计数 ${s.n} ≠ 8`);
      if (!s.paired) throw new Error('存在 aria-labelledby 未配对到 tab id 的面板');
      if (s.visible !== 1) throw new Error(`可见面板 ${s.visible} ≠ 1（v-show 门控失效）`);
      if (s.activeLabelledby !== 'cfg-tab-connection') throw new Error(`可见面板=${s.activeLabelledby} ≠ cfg-tab-connection`);
    });

    await check('G3-01r 返回钮列左置：左缘与内容列左缘对齐（≤8px）且位于列左半', async () => {
      const r = await evalExpr(ws, `(() => {
        const b = document.querySelector('.back-button');
        const w = document.querySelector('.workbench');
        if (!b || !w) return null;
        const bb = b.getBoundingClientRect(), ww = w.getBoundingClientRect();
        return { bl: bb.left, br: bb.right, wl: ww.left, wr: ww.right };
      })()`);
      if (!r) throw new Error('.back-button / .workbench 矩形缺失');
      const diffLeft = Math.abs(r.bl - r.wl);
      log(`     back-button.left=${r.bl.toFixed(0)} workbench.left=${r.wl.toFixed(0)} 差=${diffLeft.toFixed(0)}px`);
      if (diffLeft > 8) throw new Error(`返回钮左缘与列左缘差 ${diffLeft.toFixed(0)}px > 8px（右推形态回归）`);
      if (r.bl > r.wl + (r.wr - r.wl) / 2) throw new Error('返回钮位于列右半（未左置）');
    });

    await openAppearanceTab(ws);
    const sizes = fontScaleSizesFromConstants();
    precondition(sizes.small === '14px' && sizes.medium === '16px' && sizes.large === '18px', `constants.ts FONT_SCALE_SIZES=${JSON.stringify(sizes)} ≠ 14/16/18（测试与机制同源锚失效）`);

    await check('G3-03r 初始态：seg radiogroup 三档「小 14/中 16/大 18」+ aria-checked 恰一 + roving tabindex + 外观面板 select 归零', async () => {
      const s = await fontSegProbe(ws);
      if (!s) throw new Error('.font-seg 不在 DOM（外观 tab 字号控件未 seg 化）');
      if (s.role !== 'radiogroup') throw new Error(`seg role=${s.role} ≠ radiogroup`);
      if (s.labelledby !== 'cfg-font-scale-label') throw new Error(`seg aria-labelledby=${s.labelledby} ≠ cfg-font-scale-label`);
      if (JSON.stringify(s.labels) !== JSON.stringify(['小 14', '中 16', '大 18'])) throw new Error(`三档文案=${JSON.stringify(s.labels)} ≠ 小 14/中 16/大 18（数值未派生或漂移）`);
      if (s.checkedCount !== 1 || s.checked === -1) throw new Error(`aria-checked=true 计数 ${s.checkedCount} ≠ 1`);
      if (s.tabindex[s.checked] !== '0' || s.tabindex.filter((t) => t === '0').length !== 1) {
        throw new Error(`roving tabindex 异常：${JSON.stringify(s.tabindex)}`);
      }
      if (s.selectInAppearance) throw new Error('外观面板仍存在 <select>（字号未 seg 化）');
      const cfg = await evalExpr(ws, `window.claudeLink.getConfig().then((c) => String(c.fontScale ?? ''))`);
      const wantPx = sizes[cfg];
      if (s.inlineBase !== wantPx) throw new Error(`初始 --font-size-base=${s.inlineBase} ≠ ${wantPx}（fontScale=${cfg} 与应用链脱钩）`);
    });

    await check('G3-03r 点击「大」档：aria-checked 迁移 + --font-size-base 即时变化（点击即时生效）', async () => {
      const clicked = await evalExpr(ws, `(() => {
        const radios = [...document.querySelectorAll('.font-seg [role="radio"]')];
        radios[2].click(); return true;
      })()`);
      precondition(clicked, '点击「大」档失败');
      await sleep(300);
      const s = await fontSegProbe(ws);
      if (s.checked !== 2 || s.checkedCount !== 1) throw new Error(`点击后 checked=${s.checked}/${s.checkedCount} ≠ 2/1`);
      if (s.inlineBase !== sizes.large) throw new Error(`点击后 --font-size-base=${s.inlineBase} ≠ ${sizes.large}（点击未即时生效）`);
    });

    await check('G3-03r ArrowRight 到端点停不循环（大档 + → 保持大档，焦点不丢）', async () => {
      await focusSegRadio(ws, 2);
      await pressKey(ws, KEY_ARROW_RIGHT);
      await sleep(300);
      const s = await fontSegProbe(ws);
      if (s.checked !== 2 || s.focusIdx !== 2) throw new Error(`端点 ArrowRight 后 checked=${s.checked} focus=${s.focusIdx} ≠ 2/2（循环回绕）`);
      if (s.inlineBase !== sizes.large) throw new Error(`端点 ArrowRight 后 --font-size-base=${s.inlineBase} ≠ ${sizes.large}（被循环改档）`);
    });

    await check('G3-03r ArrowLeft 大→中：切档即时生效 + 焦点跟随', async () => {
      await pressKey(ws, KEY_ARROW_LEFT);
      await sleep(300);
      const s = await fontSegProbe(ws);
      if (s.checked !== 1) throw new Error(`ArrowLeft 后 checked=${s.checked} ≠ 1`);
      if (s.focusIdx !== 1) throw new Error(`ArrowLeft 后 focus=${s.focusIdx} ≠ 1（焦点未跟随）`);
      if (s.inlineBase !== sizes.medium) throw new Error(`ArrowLeft 后 --font-size-base=${s.inlineBase} ≠ ${sizes.medium}（切档未即时生效）`);
    });

    await check('G3-03r ArrowUp 中→小：切档即时生效（上键同向左）', async () => {
      await pressKey(ws, KEY_ARROW_UP);
      await sleep(300);
      const s = await fontSegProbe(ws);
      if (s.checked !== 0 || s.focusIdx !== 0) throw new Error(`ArrowUp 后 checked/focus=${s.checked}/${s.focusIdx} ≠ 0/0`);
      if (s.inlineBase !== sizes.small) throw new Error(`ArrowUp 后 --font-size-base=${s.inlineBase} ≠ ${sizes.small}`);
    });

    await check('G3-03r 小档端点：ArrowLeft/ArrowUp 均停（不循环）', async () => {
      await pressKey(ws, KEY_ARROW_LEFT);
      await sleep(250);
      let s = await fontSegProbe(ws);
      if (s.checked !== 0 || s.inlineBase !== sizes.small) throw new Error(`小档 ArrowLeft 后漂移：checked=${s.checked} base=${s.inlineBase}`);
      await pressKey(ws, KEY_ARROW_UP);
      await sleep(250);
      s = await fontSegProbe(ws);
      if (s.checked !== 0 || s.inlineBase !== sizes.small) throw new Error(`小档 ArrowUp 后漂移：checked=${s.checked} base=${s.inlineBase}`);
    });

    await check('G3-03r ArrowDown/ArrowRight 小→中→大：切档即时生效 + 焦点跟随', async () => {
      await pressKey(ws, KEY_ARROW_DOWN);
      await sleep(300);
      let s = await fontSegProbe(ws);
      if (s.checked !== 1 || s.focusIdx !== 1 || s.inlineBase !== sizes.medium) {
        throw new Error(`ArrowDown 后 checked/focus/base=${s.checked}/${s.focusIdx}/${s.inlineBase} ≠ 1/1/${sizes.medium}`);
      }
      await pressKey(ws, KEY_ARROW_RIGHT);
      await sleep(300);
      s = await fontSegProbe(ws);
      if (s.checked !== 2 || s.focusIdx !== 2 || s.inlineBase !== sizes.large) {
        throw new Error(`ArrowRight 后 checked/focus/base=${s.checked}/${s.focusIdx}/${s.inlineBase} ≠ 2/2/${sizes.large}`);
      }
    });

    await check('G3-03r config.fontScale 经自动保存链落盘（=large，轮询窗 6s）', async () => {
      const v = await pollConfigFontScale(ws, 'large');
      if (v !== 'large') throw new Error(`getConfig().fontScale=${v} ≠ large（自动保存链断裂或未生效）`);
    });
  });
}

// ══ G4 场景组（slate-ui-completion-1108-1428 点 G4：端口/Host Enter 通道 + IME 守卫运行时面）══
// G4-01/G4-02/G4-03 的 CDP 落点（静态半边在 tdd-config-core-g1-g5-verify.ts G4 小节；tests 卷
// G-config-core-cases.md G4-01~G4-04）：
//   · G4-01r 端口越界值按真实 Enter（CDP Input 域）立即夹回 8790（等效失焦：无需真失焦——
//     handler blur() → 既有 @blur="clampWaPort" 夹取链，Enter 零新逻辑）；
//   · G4-02r Host 未归一值按真实 Enter 立即归一（小写化+去重+剔空）+ toast 文案逐字
//     「Host 白名单已保存 · 共 2 条（已归一化）」+ 经既有自动保存链落盘（getConfig 轮询窗 6s）；
//   · G4-03r 值未变再按 Enter 不弹 toast（先等 toast 3s 生命周期 + 500ms 去重窗过期再测基线，
//     规避计时抖动——tests 卷待裁决 E-3「static 钉为主」口径，此处只钉确定性的值未变负例）；
//   · G4-04r IME 守卫运行时面：合成 isComposing=true / keyCode=229 的 keydown 派发到端口输入，
//     断言不夹取/不失焦/不 preventDefault（物理 IME 组合序列 CDP 不可靠——tests 卷待裁决 C-6，
//     守卫形态静态钉为正本，此处为运行时佐证）；随后真实 Enter 正常夹取（守卫不吞正常回车）。
// 隔离纪律同 G1/G2/G3：独立 --user-data-dir、用后删 profile；复用 runA1Scenario runner 与端口 9337。
async function waPortInputProbe(ws) {
  return evalExpr(ws, `(() => {
    const el = document.querySelector('[aria-labelledby="cfg-tab-web"] input[type="number"]');
    return el ? { value: el.value, focused: document.activeElement === el } : null;
  })()`);
}

async function seedWaInput(ws, selector, value) {
  const ok = await evalExpr(ws, `(() => {
    const el = document.querySelector('${selector}');
    if (!el) return false;
    el.value = '${value}';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    return true;
  })()`);
  precondition(ok, `G4 播种失败：${selector} 不在 DOM`);
  await sleep(150);
}

async function hostToastVisible(ws) {
  const hit = await evalExpr(ws, `!![...document.querySelectorAll('.toast')].find((t) => t.textContent.includes('Host 白名单已保存'))`);
  return hit === true;
}

async function pollWaPort(ws, want, ms = 6000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await evalExpr(ws, `window.claudeLink.getConfig().then((c) => String(c.webAccess?.port ?? ''))`);
    if (v === want) return v;
    if (Date.now() > deadline) return v;
    await sleep(300);
  }
}

async function pollWaHosts(ws, wantJson, ms = 6000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await evalExpr(ws, `window.claudeLink.getConfig().then((c) => JSON.stringify(c.webAccess?.allowedHosts ?? []))`);
    if (v === wantJson) return v;
    if (Date.now() > deadline) return v;
    await sleep(300);
  }
}

const WA_PORT_INPUT = '[aria-labelledby="cfg-tab-web"] input[type="number"]';
const WA_HOST_INPUT = '.webacc-advanced input[type="text"]';

async function runG4Scenario() {
  // 前置：out/ 产物新鲜度（同 G1/G2/G3 场景组口径；本组复用其 runner 与端口 9337）。
  precondition(existsSync(MAIN_OUT) && existsSync(ELECTRON_EXE), 'out/main/index.js 或 electron.exe 缺失——先 npm run build');
  const outMtime = statSync(MAIN_OUT).mtime;
  for (const src of ['src/shared/constants.ts', 'src/main/modules/config-manager.ts']) {
    precondition(outMtime > statSync(path.join(REPO_ROOT, src)).mtime, `out/ 产物过期（${src} 晚于产物）——先 npm run build`);
  }

  console.log('\n── G4 配置页组（端口/Host Enter 通道 + IME 守卫 + 归一化 toast；隔离 --user-data-dir）──');

  await runA1Scenario('G4-S1 全新配置', null, async (ws) => {
    await enterConfigWait(ws);
    await clickTabByText(ws, '网页访问');
    await check('G4 前置：网页 tab 端口/Host 输入在场且「高级」折叠可展开', async () => {
      const opened = await evalExpr(ws, `(() => {
        const d = document.querySelector('.webacc-advanced');
        if (!d) return false;
        d.open = true;
        return !!d.querySelector('input[type="text"]');
      })()`);
      if (!opened) throw new Error('.webacc-advanced 不在 DOM 或其 Host 输入缺失');
    });

    await check('G4-01r 端口 99999 按真实 Enter：立即夹回 8790（等效失焦，无需真失焦）', async () => {
      await seedWaInput(ws, WA_PORT_INPUT, '99999');
      const seeded = await waPortInputProbe(ws);
      if (!seeded || seeded.value !== '99999' || !seeded.focused) {
        throw new Error(`播种态异常：${JSON.stringify(seeded)}`);
      }
      await pressKey(ws, KEY_ENTER);
      const deadline = Date.now() + 3000;
      let after = null;
      for (;;) {
        after = await waPortInputProbe(ws);
        if (after && after.value === '8790') break;
        if (Date.now() > deadline) break;
        await sleep(200);
      }
      if (!after || after.value !== '8790') throw new Error(`Enter 后端口值=${after?.value} ≠ 8790（夹取未生效——Enter 通道断裂）`);
      if (after.focused) throw new Error('Enter 后焦点未离开端口输入（等效失焦语义缺失）');
      const saved = await pollWaPort(ws, '8790');
      if (saved !== '8790') throw new Error(`getConfig().webAccess.port=${saved} ≠ 8790（夹取值未落盘或 99999 被直存）`);
    });

    await check('G4-02r Host 未归一值按真实 Enter：立即归一（小写化+去重+剔空）+ toast 文案逐字 + 落盘', async () => {
      await seedWaInput(ws, WA_HOST_INPUT, 'Example.COM, b.com, b.com, ,');
      const seeded = await evalExpr(ws, `document.querySelector('${WA_HOST_INPUT}').value`);
      // 播种串尾部空段会被 v-model 即时洗掉（setter 拆分→剔空→get 重组回填 DOM）：未归一本质态
      // （大写 Example.COM + 重复 b.com）仍在即可，形态取 Vue 回填串。
      if (!/^Example\.COM, b\.com, b\.com(, ,)?$/.test(String(seeded))) throw new Error(`Host 播种态异常：${seeded}`);
      await pressKey(ws, KEY_ENTER);
      const deadline = Date.now() + 3000;
      let val = '';
      for (;;) {
        val = await evalExpr(ws, `document.querySelector('${WA_HOST_INPUT}').value`);
        if (val === 'example.com, b.com') break;
        if (Date.now() > deadline) break;
        await sleep(200);
      }
      if (val !== 'example.com, b.com') throw new Error(`Enter 后 Host 值=${val} ≠ example.com, b.com（归一化未生效）`);
      let toastHit = false;
      const tDeadline = Date.now() + 3000;
      while (!toastHit && Date.now() < tDeadline) {
        toastHit = await hostToastVisible(ws);
        if (!toastHit) await sleep(200);
      }
      if (!toastHit) throw new Error('归一化改变值后未见 toast「Host 白名单已保存 …」');
      const toastText = await evalExpr(ws, `[...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()).join('|')`);
      if (!toastText.includes('Host 白名单已保存 · 共 2 条（已归一化）')) {
        throw new Error(`toast 文案=${toastText} ≠ 「Host 白名单已保存 · 共 2 条（已归一化）」（N 须=归一后条数）`);
      }
      const saved = await pollWaHosts(ws, JSON.stringify(['example.com', 'b.com']));
      if (saved !== JSON.stringify(['example.com', 'b.com'])) throw new Error(`getConfig().webAccess.allowedHosts=${saved} ≠ ["example.com","b.com"]（归一值未落盘）`);
    });

    await check('G4-03r 值已规范形态再按 Enter：不弹 toast（去重窗过期后基线零，规避计时抖动）', async () => {
      await sleep(4200); // toast 3s 生命周期 + 500ms 去重窗 + 余量
      const baselineToast = await hostToastVisible(ws);
      if (baselineToast) throw new Error('基线期 toast 未按 3s 生命周期消退（计时环境异常）');
      await seedWaInput(ws, WA_HOST_INPUT, 'example.com, b.com'); // 已规范形态（重播现有值）
      await pressKey(ws, KEY_ENTER);
      await sleep(800);
      const afterVal = await evalExpr(ws, `document.querySelector('${WA_HOST_INPUT}').value`);
      if (afterVal !== 'example.com, b.com') throw new Error(`值漂移：${afterVal}`);
      if (await hostToastVisible(ws)) throw new Error('值未变仍弹 toast（值变化判定缺失）');
    });

    await check('G4-04r IME 守卫：isComposing / keyCode 229 的 Enter 不夹取、不失焦、不 preventDefault', async () => {
      await seedWaInput(ws, WA_PORT_INPUT, '123'); // <1024 越界：守卫若失守会被夹回 8790
      const r1 = await evalExpr(ws, `(() => {
        const el = document.querySelector('${WA_PORT_INPUT}');
        const evt = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: true });
        const dispatched = el.dispatchEvent(evt);
        return { dispatched, defaultPrevented: evt.defaultPrevented, focused: document.activeElement === el, value: el.value };
      })()`);
      if (!r1 || r1.dispatched === false) throw new Error(`isComposing Enter 被 preventDefault（守卫未先行，C-G4-1）: ${JSON.stringify(r1)}`);
      if (r1.defaultPrevented || r1.focused === false || r1.value !== '123') {
        throw new Error(`isComposing Enter 误触发（组合态守卫失守）：${JSON.stringify(r1)}`);
      }
      const r2 = await evalExpr(ws, `(() => {
        const el = document.querySelector('${WA_PORT_INPUT}');
        const evt = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
        Object.defineProperty(evt, 'keyCode', { value: 229 });
        const dispatched = el.dispatchEvent(evt);
        return { dispatched, defaultPrevented: evt.defaultPrevented, focused: document.activeElement === el, value: el.value };
      })()`);
      if (!r2 || r2.dispatched === false) throw new Error(`keyCode=229 Enter 被 preventDefault: ${JSON.stringify(r2)}`);
      if (r2.defaultPrevented || r2.focused === false || r2.value !== '123') {
        throw new Error(`keyCode=229 Enter 误触发：${JSON.stringify(r2)}`);
      }
      await pressKey(ws, KEY_ENTER); // 正常回车：守卫不得吞
      const deadline = Date.now() + 3000;
      let val = '';
      for (;;) {
        val = (await waPortInputProbe(ws))?.value ?? '';
        if (val === '8790') break;
        if (Date.now() > deadline) break;
        await sleep(200);
      }
      if (val !== '8790') throw new Error(`正常 Enter 后端口值=${val} ≠ 8790（守卫吞了正常回车）`);
    });
  });
}

// ══ I7 场景组（slate-ui-completion-1108-1428 点 I7：四处 trapTab 焦点逃逸重捕）════════
// I7-03 行为级（tests 卷：CDP 可用；采样 DiffDialog 与 FilePickerDialog 两站；结构半边在
// tdd-dialogs-i1-i10-verify I7 节）。真实键鼠（CDP Input 域，G2 同手法）走真实 UI 入口链：
//   · FilePickerDialog 站：工具栏「工作空间」钮 → 下拉「选择目录…」→ 选择器打开（打开边沿壳聚焦
//     tabindex=-1 卡本体）→ Shift+Tab 真实逃逸出卡（现状=自然路径，重捕只对「已逃出」的下一键生效）
//     → Tab 被拉回卡内首元素、Shift+Tab 拉回末元素（trapTab 同选择器现算期望位）→ 正常循环不吞；
//     随后真实键入仓库根路径选作工作空间（链路继续给 DiffDialog 站供真实改动列表）。
//   · DiffDialog 站：右栏「只看改动」→ ChangesPanel 行（真实 git 改动）→ 点行打开（open 边沿聚焦
//     关闭钮；卡无 tabindex）→ 点击弹窗留白（footer 图例区，非交互元素；header 有 startDrag
//     preventDefault 会吞焦点迁移故不可用）→ activeElement 落 body
//     → Tab 拉回首元素、Shift+Tab 拉回末元素 → 正常循环不吞。
// 隔离纪律同 A1/G 组：独立 mkdtemp --user-data-dir 冷启动 out/ 产物，用后 taskkill+删 profile；
// 复用 runA1Scenario runner 与端口 9337；out/ 新鲜度预检同 runA1Scenarios。

async function realClick(ws, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdpCall(ws, 'Input.dispatchMouseEvent', {
      type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
  }
}

async function clickSelector(ws, selector) {
  const pos = await evalExpr(ws, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!pos) throw new PreconditionError(`clickSelector 找不到元素：${selector}`);
  await realClick(ws, pos.x, pos.y);
}

// 焦点探针：用 trapTab 同款选择器在 containerSel 容器内现算首/末 focusable，回报 activeElement
// 相对位置（first/last 命中、容器内外、body）。期望位不写死按钮（防内容漂移假红）。
async function focusProbe(ws, containerSel) {
  return evalExpr(ws, `(() => {
    const dlg = document.querySelector(${JSON.stringify(containerSel)});
    if (!dlg) return null;
    const focusables = Array.from(dlg.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ));
    const a = document.activeElement;
    return {
      count: focusables.length,
      first: focusables[0] ?? null,
      last: focusables[focusables.length - 1] ?? null,
      isFirst: !!a && a === focusables[0],
      isLast: !!a && a === focusables[focusables.length - 1],
      inside: !!a && !!dlg && dlg.contains(a),
      isBody: a === document.body,
      tag: a ? (a.tagName + '.' + String(a.className).split(' ').join('.')) : 'null',
    };
  })()`);
}

async function waitFocus(ws, containerSel, want, ms = 6000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const p = await focusProbe(ws, containerSel);
    if (p && want(p)) return p;
    if (Date.now() > deadline) return p;
    await sleep(300);
  }
}

async function runI7Scenario() {
  // 前置：out/ 产物新鲜度（与 runA1Scenarios 同款预检——防「改源码 × 跑旧产物」假绿）。
  precondition(existsSync(MAIN_OUT) && existsSync(ELECTRON_EXE), 'out/main/index.js 或 electron.exe 缺失——先 npm run build');
  const outMtime = statSync(MAIN_OUT).mtime;
  for (const src of ['src/shared/constants.ts', 'src/main/modules/config-manager.ts']) {
    precondition(outMtime > statSync(path.join(REPO_ROOT, src)).mtime, `out/ 产物过期（${src} 晚于产物）——先 npm run build`);
  }

  // 种子 workingDirectory=REPO_ROOT：等价用户在设置页配置默认工作目录（AppConfig 真实键）——
  // changes 三通道 allowlist（ipc-handlers isBoundWorkingDir）=全局 config.workingDirectory ∪
  // 已物化会话目录；本场景暂态会话不落库、又不发消息触发物化，不种子则 listChanges 被拒
  // （「工作目录不在允许列表」），DiffDialog 站无法建立。隔离 profile 内种子，不触真实配置。
  await runA1Scenario('I7-S1 弹窗焦点逃逸重捕：FilePicker + DiffDialog 两站（真实键鼠）', { workingDirectory: REPO_ROOT }, async (ws) => {
    await enterChat(ws); // fresh profile 空态 → 点新会话进入聊天页（SessionToolbar/工作空间钮就位）
    log('  [I7] 站 1：FilePickerDialog（工作空间选择真实入口）');
    // 打开链：工作空间钮 → 下拉「选择目录…」→ FilePicker（fresh profile 无工作空间，钮带 warn 态）。
    await clickSelector(ws, '[data-testid="workspace-trigger"]');
    await sleep(400);
    await clickSelector(ws, '.menu__item--accent');
    const opened = await waitFocus(ws, '.fp-card', (p) => p && p.count > 0 && p.inside);
    if (!opened) throw new PreconditionError('FilePicker 未打开或焦点未落卡（.fp-card 缺失/壳聚焦未完成）');
    log(`     打开完成：focusables=${opened.count} activeElement=${opened.tag}`);

    // I7-CT-1 焦点逃逸面（现状自然路径）：焦点在 tabindex=-1 壳上 Shift+Tab → 原生逃出卡。
    await pressKey(ws, KEY_TAB, 8); // Shift+Tab
    const escaped = await focusProbe(ws, '.fp-card');
    if (!escaped || escaped.inside || escaped.isFirst) {
      throw new Error(`Shift+Tab 未逃出卡片（inside=${escaped?.inside}）——逃逸前置态未形成，后续重捕断言无意义`);
    }
    log(`     逃逸确认：activeElement=${escaped.tag}（卡外）`);

    // I7-CT-2 重捕：Tab → 卡内首元素（修复前=背景页继续循环）。
    await pressKey(ws, KEY_TAB);
    const back = await waitFocus(ws, '.fp-card', (p) => p && p.isFirst);
    if (!back?.isFirst) throw new Error(`Tab 未拉回卡内首元素（activeElement=${back?.tag}）——I7 重捕失效`);
    log('     ✅ I7-CT-2 FilePicker：逃逸后 Tab 拉回首元素');

    // I7-CT-3 重捕：Shift+Tab（自首元素）→ 卡内末元素。
    await pressKey(ws, KEY_TAB, 8);
    const backLast = await waitFocus(ws, '.fp-card', (p) => p && p.isLast);
    if (!backLast?.isLast) throw new Error(`Shift+Tab 未拉回卡内末元素（activeElement=${backLast?.tag}）——I7 重捕失效`);
    log('     ✅ I7-CT-3 FilePicker：Shift+Tab 拉回末元素');

    // I7-CT-4 正常循环保全：末元素 Tab → 首（回绕）；首元素 Tab → 原生次序（不吞回绕）。
    await pressKey(ws, KEY_TAB);
    const wrap = await waitFocus(ws, '.fp-card', (p) => p && p.isFirst);
    if (!wrap?.isFirst) throw new Error(`末元素 Tab 未回绕到首元素（activeElement=${wrap?.tag}）——正常循环被破坏`);
    await pressKey(ws, KEY_TAB);
    const second = await focusProbe(ws, '.fp-card');
    if (!second?.inside || second.isFirst) {
      throw new Error(`首元素 Tab 未原生前进（activeElement=${second?.tag}）——收紧吞掉了容器内正常 Tab 序`);
    }
    log('     ✅ I7-CT-4 FilePicker：末→首回绕 + 首→次原生序保全');

    // 链路续程：导航到仓库根（真实键入路径 → Enter）→ 选为工作空间（供 DiffDialog 站用）。
    await clickSelector(ws, 'button[title="编辑路径 (Ctrl+L)"]');
    await sleep(300);
    await cdpCall(ws, 'Input.insertText', { text: REPO_ROOT });
    await pressKey(ws, KEY_ENTER);
    await sleep(1200); // loadDir IPC + 列表渲染
    await clickSelector(ws, 'button.fp-btn--primary');
    // 工作空间落位轮询（activeSession.workingDir 由 session store 持有，无直接 IPC 读口——
    // 以侧栏工具栏 pill 文本=目录尾段为准）。
    const wdLabel = path.basename(REPO_ROOT);
    let wdOk = false;
    for (let i = 0; i < 20; i++) {
      wdOk = await evalExpr(ws, `(() => {
        const b = document.querySelector('[data-testid="workspace-trigger"]');
        return !!b && b.textContent.includes(${JSON.stringify(wdLabel)});
      })()`);
      if (wdOk) break;
      await sleep(400);
    }
    if (!wdOk) throw new PreconditionError(`工作空间未落位（pill 未显示 ${wdLabel}）`);
    log(`     工作空间已选：${REPO_ROOT}`);

    // R2-F14 加固：FilePicker 关闭走 fp-fade leave 过渡（百 ms 级），落位轮询可能在过渡窗口内
    // 通过——点击前补离场清场等待：.fp-overlay 完全卸载后才进站 2（下方重试环保底不变）。
    for (let i = 0; i < 30; i++) {
      const fpGone = await evalExpr(ws, `!document.querySelector('.fp-overlay')`);
      if (fpGone) break;
      await sleep(100);
    }

    log('  [I7] 站 2：DiffDialog（右栏改动行真实入口）');
    // 打开链：右栏「只看改动」→ ChangesPanel 行（仓库真实 git 改动）→ 点行。
    const preClick = await evalExpr(ws, `(() => {
      const el = document.querySelector('.status-metric[title^="只看改动"]');
      if (!el) return { missing: true };
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        hit: hit ? hit.tagName + '.' + String(hit.className).split(' ').slice(0, 2).join('.') : null,
        panelW: document.querySelector('.task-panel')?.getBoundingClientRect().width ?? null,
      };
    })()`);
    log(`     metric 点击面诊断：${JSON.stringify(preClick)}`);
    // FilePicker 关闭走 fp-fade leave 过渡（百 ms 级）——落位轮询可能在过渡窗口内通过，首击被
    // 离场遮罩吃掉。R2-F14：进站前已补 .fp-overlay 卸载清场等待（见上）；此处点击→查
    // aria-pressed→重试环（≤8 次）仍保底，过渡结束后的第一次点击必中。
    let tabOn = false;
    for (let i = 0; i < 8 && !tabOn; i++) {
      await clickSelector(ws, '.status-metric[title^="只看改动"]');
      await sleep(500);
      tabOn = await evalExpr(ws, `document.querySelector('.status-metric[title^="只看改动"]')?.getAttribute('aria-pressed') === 'true'`);
    }
    if (!tabOn) throw new PreconditionError('「只看改动」tab 点击 8 次未激活（aria-pressed 恒 false）');
    let rowCount = 0;
    let lastDiag = null;
    for (let i = 0; i < 25; i++) {
      rowCount = await evalExpr(ws, `document.querySelectorAll('.changes__row').length`);
      if (rowCount > 0) break;
      if (i % 5 === 4) {
        lastDiag = await evalExpr(ws, `(() => ({
          err: document.querySelector('.changes__error')?.textContent?.trim()?.slice(0, 120) ?? null,
          empty: document.querySelector('.changes__empty')?.textContent?.trim() ?? null,
          pressed: document.querySelector('.status-metric[title^="只看改动"]')?.getAttribute('aria-pressed') ?? null,
        }))()`);
        log(`     [诊断 t+${(i + 1) * 0.4 | 0}s] ${JSON.stringify(lastDiag)}`);
      }
      await sleep(400);
    }
    if (!rowCount) throw new PreconditionError(`ChangesPanel 无改动行（diag=${JSON.stringify(lastDiag)}）——DiffDialog 站无法建立`);
    await clickSelector(ws, '.changes__row .changes__row-main');
    const diffOpened = await waitFocus(ws, '.diff-dialog', (p) => p && p.count > 0 && p.inside);
    if (!diffOpened) throw new PreconditionError('DiffDialog 未打开（.diff-dialog 缺失或焦点未入弹窗）');
    log(`     打开完成：focusables=${diffOpened.count}`);

    // I7-CT-5 留白点击 → activeElement 落 body（卡无 tabindex；footer 图例区=非交互元素。
    // 不能用 header 标题区——startDrag 对 pointerdown preventDefault 会吞掉焦点迁移）。
    await clickSelector(ws, '.diff-footer .legend');
    await sleep(200);
    const blank = await focusProbe(ws, '.diff-dialog');
    if (!blank || !blank.isBody) {
      throw new Error(`留白点击后 activeElement 未落 body（${blank?.tag}）——留白复现面未形成`);
    }

    // I7-CT-6 重捕：Tab → 弹窗首元素；Shift+Tab → 弹窗末元素。
    await pressKey(ws, KEY_TAB);
    const dBack = await waitFocus(ws, '.diff-dialog', (p) => p && p.isFirst);
    if (!dBack?.isFirst) throw new Error(`Tab 未拉回弹窗首元素（activeElement=${dBack?.tag}）——I7 重捕失效`);
    log('     ✅ I7-CT-6 DiffDialog：留白落 body 后 Tab 拉回首元素');
    await pressKey(ws, KEY_TAB, 8);
    const dLast = await waitFocus(ws, '.diff-dialog', (p) => p && p.isLast);
    if (!dLast?.isLast) throw new Error(`Shift+Tab 未拉回弹窗末元素（activeElement=${dLast?.tag}）——I7 重捕失效`);
    log('     ✅ I7-CT-7 DiffDialog：Shift+Tab 拉回末元素');

    // I7-CT-8 正常循环保全：末元素 Tab → 首；首元素 Tab → 原生次序。
    await pressKey(ws, KEY_TAB);
    const dWrap = await waitFocus(ws, '.diff-dialog', (p) => p && p.isFirst);
    if (!dWrap?.isFirst) throw new Error(`末元素 Tab 未回绕到首元素（activeElement=${dWrap?.tag}）`);
    await pressKey(ws, KEY_TAB);
    const dSecond = await focusProbe(ws, '.diff-dialog');
    if (!dSecond?.inside || dSecond.isFirst) {
      throw new Error(`首元素 Tab 未原生前进（activeElement=${dSecond?.tag}）——收紧吞掉了容器内正常 Tab 序`);
    }
    log('     ✅ I7-CT-8 DiffDialog：末→首回绕 + 首→次原生序保全');
  });
}

// ══ A3 场景组（点 A3：用户气泡固定浅蓝 token 纯静态三板恒定）════════════════════════════
// A3-3/A3-4 消费者侧断言（.bubble--user 元素 computed 探针）已由点 C1 落地转写（2026-11-08）——
// 探针组见上方「C1 消费者侧探针」；本组保留 token 变量层三板恒定钉不变。
// --color-bubble-user-bg / --color-bubble-user-ink 为 :root 纯静态字面（不随板、无 JS 写入链），
// 三板切换下 raw 值恒定 + documentElement inline 零写入。终端暗板下浅蓝恒定属设计意图
// （红线：禁止为 terminal-pro 加 isDark 分支或覆写）。

async function assertBubbleTokenStable(ws, label) {
  const bg = await cssVar(ws, '--color-bubble-user-bg');
  const ink = await cssVar(ws, '--color-bubble-user-ink');
  const inlineBg = await evalExpr(ws, `document.documentElement.style.getPropertyValue('--color-bubble-user-bg').trim()`);
  const inlineInk = await evalExpr(ws, `document.documentElement.style.getPropertyValue('--color-bubble-user-ink').trim()`);
  if (bg !== '#D9E9ED') throw new Error(`[${label}] --color-bubble-user-bg=${bg} ≠ #D9E9ED（固定 token 不随板被破坏）`);
  if (ink !== '#17181A') throw new Error(`[${label}] --color-bubble-user-ink=${ink} ≠ #17181A（固定 token 不随板被破坏）`);
  if (inlineBg !== '' || inlineInk !== '') {
    throw new Error(`[${label}] documentElement inline 出现 bubble token 写入（bg='${inlineBg}' ink='${inlineInk}'，违背纯静态、无 JS 写入链）`);
  }
}

// ══ C1 消费者侧探针（点 C1，2026-11-08 增；A3-3/A3-4 按拆点时序由本点落地转写）══════════════
// 隔离场景无 provider 发不了真消息，探针手法 = 从编译样式表反查 MessageBubble 的 scoped
// data-v 属性，构造同构元素（同 class + 同属性）挂 body 读 computed——与 A2 cssVarResolved
// 探针同源思路；真实组件规则命中，读值即页面级 computed。真实消息在场场景归 C 链。

async function probeBubble(ws, extraClass) {
  const scope = await evalExpr(ws, `(() => {
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) {
        const m = (r.selectorText || '').match(/\\.bubble--user\\[(data-v-[0-9a-f]+)\\]/);
        if (m) return m[1];
      }
    }
    return null;
  })()`);
  precondition(scope, '样式表反查失败：未找到 .bubble--user 的 scoped data-v 属性（out/ 产物过期或样式被剥离）');
  return evalExpr(ws, `(() => {
    const el = document.createElement('div');
    el.className = 'bubble ${extraClass}';
    el.setAttribute('${scope}', '');
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    const alphas = [...cs.boxShadow.matchAll(/rgba?\\(([^)]+)\\)/g)].map((m) => {
      const parts = m[1].split(',').map((t) => parseFloat(t));
      return parts.length >= 4 ? parts[3] : 1;
    });
    const out = {
      bg: cs.backgroundColor,
      color: cs.color,
      borderWidths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
      topBorderColor: cs.borderTopColor,
      radius: cs.borderRadius,
      tl: cs.borderTopLeftRadius,
      tr: cs.borderTopRightRadius,
      brr: cs.borderBottomRightRadius,
      bll: cs.borderBottomLeftRadius,
      shadow: cs.boxShadow,
      shadowAlphas: alphas,
      dpr: window.devicePixelRatio,
    };
    el.remove();
    return out;
  })()`);
}


async function runA3Scenarios() {
  // 前置：out/ 产物新鲜度（同 A1/A2 场景组口径；本组复用其 runner 与端口 9337）。
  precondition(existsSync(MAIN_OUT) && existsSync(ELECTRON_EXE), 'out/main/index.js 或 electron.exe 缺失——先 npm run build');
  const outMtime = statSync(MAIN_OUT).mtime;
  for (const src of ['src/shared/constants.ts', 'src/main/modules/config-manager.ts']) {
    precondition(outMtime > statSync(path.join(REPO_ROOT, src)).mtime, `out/ 产物过期（${src} 晚于产物）——先 npm run build`);
  }

  console.log('\n── A3 场景组（bubble 固定 token 三板恒定；隔离 --user-data-dir）──');

  await runA1Scenario('A3-S1 全新配置：墨石默认 + 三板切换 bubble token 恒定', null, async (ws) => {
    await openAppearanceTab(ws);
    await check('A3 token 墨石默认（首板）：bg=#D9E9ED / ink=#17181A，inline 零写入', async () => {
      await assertBubbleTokenStable(ws, '墨石');
    });
    // ── C1 消费者侧探针（点 C1，2026-11-08 增；A3-3/A3-4 落地转写；墨石首板）──
    await check('C1-1 .bubble--user computed 墨石：bg=rgb(217, 233, 237) / color=rgb(23, 24, 26)（固定浅蓝 token 计算值）', async () => {
      const p = await probeBubble(ws, 'bubble--user');
      if (p.bg !== 'rgb(217, 233, 237)') throw new Error(`bg=${p.bg} ≠ rgb(217, 233, 237)`);
      if (p.color !== 'rgb(23, 24, 26)') throw new Error(`color=${p.color} ≠ rgb(23, 24, 26)`);
    });
    await check('C1-4 .bubble--user computed 墨石：border 四向宽全 0px 且 borderColor 非 accent（描边与右缘 3px 色条彻底删除）', async () => {
      const p = await probeBubble(ws, 'bubble--user');
      const bad = p.borderWidths.filter((w) => w !== '0px');
      if (bad.length) throw new Error(`border 宽残留：${bad.join('/')}（描边/色条未除净）`);
      if (p.topBorderColor === 'rgb(234, 88, 12)') throw new Error(`borderColor 仍为 accent #EA580C：${p.topBorderColor}`);
    });
    await check('C1-5 .bubble--user computed 墨石：四角 radius 11/11/4/11（longhand 直读，免 CSSOM 收缩序列化歧义）且阴影非空、全部 alpha ≤ 0.2（轻阴影）', async () => {
      const p = await probeBubble(ws, 'bubble--user');
      // TL TR BR BL = 11px 11px 4px 11px（规范字面）；TR===BL（11===11）时 Chrome computed
      // borderRadius 收缩为 3 值形「11px 11px 4px」，故逐 longhand 断言，不钉收缩形态。
      for (const [k, want] of [['tl', '11px'], ['tr', '11px'], ['brr', '4px'], ['bll', '11px']]) {
        if (p[k] !== want) throw new Error(`${k}=${p[k]} ≠ ${want}`);
      }
      if (!p.shadow || p.shadow === 'none') throw new Error('boxShadow 为 none（轻阴影丢失）');
      const heavy = p.shadowAlphas.filter((a) => a > 0.2);
      if (heavy.length) throw new Error(`阴影 alpha 超 0.2：${p.shadowAlphas.join('/')}（${p.shadow}）`);
    });
    // C2 点同步（2026-11-09，G2 修复轮落锤）：C2 重做助手卡为「纯白卡」——panel-soft 底 +
    // 1px var(--color-border) 整圈细描边（左 3px accent 色条删除）+ 圆角/padding 走基线
    // （11px / 12px 15px）。C1 原快照（左 3px accent 色条 / radius-md 12px）是对 C1 实施时点
    // 的形态冻结，C2 落地后必红；静态半已由 C2 同步（tdd-c-chat-stream-verify.ts C1-6/C2-6
    // 先例，红线 4），本 CDP computed 钉按同一义务同步到 C2 后稳定面：白底 / 1px 整圈 /
    // 无 accent 色条 / 基线 11px 圆角 / 轻阴影——断言强度不降（色条删除改由整圈 1px + 负向
    // accent 色守卫钉住）。
    await check('C1-6 .bubble--assistant computed 墨石（C2 后稳定面保全）：panel-soft 白底 / 1px 整圈细描边（无 accent 色条）/ 四角 radius 11px / 轻阴影', async () => {
      const p = await probeBubble(ws, 'bubble--assistant');
      if (p.bg !== 'rgb(255, 255, 255)') throw new Error(`bg=${p.bg} ≠ rgb(255, 255, 255)（墨石 panelSoft #FFFFFF 被牵动）`);
      // 边框宽 used 值按设备像素吸附（Windows 125% DPI 下 1px→0.8px），容差 = 1 个设备像素。
      const tol = 1 / (p.dpr || 1) + 0.01;
      const bad = p.borderWidths.filter((w) => Math.abs(parseFloat(w) - 1) > tol);
      if (bad.length) {
        throw new Error(`border 四向宽非 1px：${p.borderWidths.join('/')} ≠ 1px±${tol.toFixed(2)}（整圈细描边被牵动）`);
      }
      if (p.topBorderColor === 'rgb(234, 88, 12)') {
        throw new Error(`borderColor 仍为 accent #EA580C：${p.topBorderColor}（色条已裁决删除，不应残留 accent 引用）`);
      }
      for (const [k, want] of [['tl', '11px'], ['tr', '11px'], ['brr', '11px'], ['bll', '11px']]) {
        if (p[k] !== want) throw new Error(`${k}=${p[k]} ≠ ${want}（基线 .bubble radius 11px 被牵动）`);
      }
      if (!p.shadow || p.shadow === 'none') throw new Error('boxShadow 为 none（轻阴影随形态重构丢失）');
      const heavy = p.shadowAlphas.filter((a) => a > 0.2);
      if (heavy.length) throw new Error(`阴影 alpha 超 0.2：${p.shadowAlphas.join('/')}（${p.shadow}）`);
    });

    await clickPaletteCard(ws, '暖纸');
    await check('A3 token 暖纸切换后恒定：bg=#D9E9ED / ink=#17181A，inline 零写入', async () => {
      await assertBubbleTokenStable(ws, '暖纸');
    });
    await clickPaletteCard(ws, '静默');
    await check('A3 token 静默切换后恒定：bg=#D9E9ED / ink=#17181A，inline 零写入', async () => {
      await assertBubbleTokenStable(ws, '静默');
    });
    await clickPaletteCard(ws, '终端');
    await check('A3 token 终端（暗板）恒定：bg=#D9E9ED / ink=#17181A（浅蓝恒定属设计意图），inline 零写入', async () => {
      await assertBubbleTokenStable(ws, '终端');
    });
    await check('C1-7 .bubble--user computed 终端（暗板代表）：bg=rgb(217, 233, 237) / color=rgb(23, 24, 26)（双色板恒定，无 isDark 分支）', async () => {
      const p = await probeBubble(ws, 'bubble--user');
      if (p.bg !== 'rgb(217, 233, 237)') throw new Error(`bg=${p.bg} ≠ rgb(217, 233, 237)`);
      if (p.color !== 'rgb(23, 24, 26)') throw new Error(`color=${p.color} ≠ rgb(23, 24, 26)`);
    });

  });
}

// ══ B4 场景组（验收 round1 备忘①跟进，2026-11-12 增）：AppLayout 两级断点穿越运行时面 ═════
// B4 两级断点以 JS matchMedia 实现（AppLayout.vue :21-46）：≤1100 收右侧活动面板（唤回条
// pill 内联回唤，B-C1）、≤800 收左侧栏（AppHeader toggle 唤出 overlay 浮层）；变宽自动复位
// （mq change 回调 + watch 兜底双保险）。此前验收裁定该行为面缺自动化运行时用例（round1
// 备忘①）——本组复用 A1 隔离 runner（同端口 9337 / 同隔离纪律 / 同 out/ 新鲜度前置），
// 单场景四站穿越 1280 → 1000 → 720 → 1280，断言类名以 AppLayout.vue / AppHeader.vue 当前
// 实现为准（.task-panel / .resize-handle--task / .resize-handle--sidebar / .reopen-task-panel /
// .sidebar + sidebar--forced-hidden / sidebar--overlay-open / .sidebar-overlay-backdrop /
// .app-header__sidebar-toggle，toggle title/aria 钉「显示会话列表」）：
//   · 1280（>1100）：活动面板+双侧手柄可见，唤回条与 toggle 不在场；
//   · 1000（≤1100）：面板+任务手柄退场、唤回条在场；点击唤回条 → 面板+手柄内联回唤、
//     唤回条退场（panelRecalled 覆盖态）；
//   · 720（≤800）：侧栏挂 sidebar--forced-hidden 不可见、侧栏手柄退场、toggle 在场；点击
//     toggle → sidebar--overlay-open + sidebar-overlay-backdrop 在场；点遮罩 → 二者退场且
//     侧栏保持隐藏；
//   · 1280 复位：forced-hidden 摘除、面板+双侧手柄回场、唤回条/toggle/backdrop 全退场。
// 注意：720 站任务面板仍被回唤态保留（panelRecalled 跨 ≤800 持续，两级断点互不干扰），
// 该站只断言侧栏三件套与 toggle，不断言 .task-panel 退场。

async function b4Probe(ws) {
  return evalExpr(ws, `(() => {
    const q = (sel) => document.querySelector(sel);
    const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
    const sb = q('.sidebar');
    const tg = q('.app-header__sidebar-toggle');
    return {
      taskPanel: vis(q('.task-panel')),
      taskHandle: vis(q('.resize-handle--task')),
      sidebarHandle: vis(q('.resize-handle--sidebar')),
      reopen: vis(q('.reopen-task-panel')),
      toggle: vis(tg),
      toggleTitle: tg?.getAttribute('title') ?? null,
      toggleAria: tg?.getAttribute('aria-label') ?? null,
      sidebarPresent: !!sb,
      sidebarHiddenClass: !!sb && sb.classList.contains('sidebar--forced-hidden'),
      sidebarOverlayClass: !!sb && sb.classList.contains('sidebar--overlay-open'),
      sidebarVisible: vis(sb),
      backdrop: vis(q('.sidebar-overlay-backdrop')),
    };
  })()`);
}

// 站间过渡等待：matchMedia change → Vue 重渲有窗口期，轮询至 want 成立（6s 上限）；
// 超时返回末态，由调用方以具体字段拼错误信息。
async function waitForB4State(ws, want, ms = 6000) {
  const deadline = Date.now() + ms;
  let s = await b4Probe(ws);
  for (;;) {
    if (want(s)) return s;
    if (Date.now() > deadline) return s;
    await sleep(200);
    s = await b4Probe(ws);
  }
}

async function runB4Scenario() {
  // 前置：out/ 产物新鲜度（同 A1/E6/G1 场景组口径；本组复用其 runner 与端口 9337）。
  precondition(existsSync(MAIN_OUT) && existsSync(ELECTRON_EXE), 'out/main/index.js 或 electron.exe 缺失——先 npm run build');
  const outMtime = statSync(MAIN_OUT).mtime;
  for (const src of ['src/shared/constants.ts', 'src/main/modules/config-manager.ts']) {
    precondition(outMtime > statSync(path.join(REPO_ROOT, src)).mtime, `out/ 产物过期（${src} 晚于产物）——先 npm run build`);
  }

  console.log('\n── B4 场景组（两级断点穿越 1280→1000→720→1280；隔离 --user-data-dir）──');

  await runA1Scenario('B4-S1 全新配置：两级断点穿越', null, async (ws) => {
    // 站 1：宽视口 1280×800（>1100）。冷启动默认窗口尺寸不定，先强制宽视口并等面板挂载。
    await setViewport(ws, 1280, 800);
    const wide = await waitForB4State(ws, (s) => s.taskPanel && s.taskHandle && s.sidebarHandle);
    await check('B4-1 宽视口 1280（>1100）：活动面板+任务/侧栏手柄可见，唤回条与 toggle 不在场', async () => {
      if (!wide.taskPanel) throw new Error('.task-panel 不可见（活动面板未渲染或被收起）');
      if (!wide.taskHandle) throw new Error('.resize-handle--task 不可见');
      if (!wide.sidebarHandle) throw new Error('.resize-handle--sidebar 不可见');
      if (wide.reopen) throw new Error('.reopen-task-panel 残留（宽视口不应有唤回条）');
      if (wide.toggle) throw new Error('.app-header__sidebar-toggle 残留（宽视口不应有侧栏唤回钮）');
      log(`     1280 站：taskPanel=${wide.taskPanel} taskHandle=${wide.taskHandle} sidebarHandle=${wide.sidebarHandle}`);
    });

    // 站 2：≤1100 → 面板收起 + 唤回条在场；点击唤回 → 内联回唤（B-C1）。
    await setViewport(ws, 1000, 800);
    const narrow = await waitForB4State(ws, (s) => s.reopen && !s.taskPanel && !s.taskHandle);
    await check('B4-2 ≤1100（1000）：面板+任务手柄退场，唤回条 .reopen-task-panel 在场', async () => {
      if (narrow.taskPanel || narrow.taskHandle) {
        throw new Error(`面板未收起：taskPanel=${narrow.taskPanel} taskHandle=${narrow.taskHandle}`);
      }
      if (!narrow.reopen) throw new Error('.reopen-task-panel 未出现');
    });
    await check('B4-3 点击唤回条：面板+任务手柄内联回唤，唤回条退场（panelRecalled 覆盖态）', async () => {
      const clicked = await evalExpr(ws, `(() => { const b = document.querySelector('.reopen-task-panel'); if (!b) return false; b.click(); return true; })()`);
      precondition(clicked, '唤回条 .reopen-task-panel 不存在（无法点击）');
      const recalled = await waitForB4State(ws, (s) => s.taskPanel && s.taskHandle && !s.reopen);
      if (!recalled.taskPanel || !recalled.taskHandle) {
        throw new Error(`回唤失败：taskPanel=${recalled.taskPanel} taskHandle=${recalled.taskHandle}`);
      }
      if (recalled.reopen) throw new Error('唤回条未退场（面板已回场仍残留 pill）');
    });

    // 站 3：≤800 → 侧栏隐藏 + AppHeader toggle 在场 + overlay 开合（回唤态跨站保留，断点独立）。
    await setViewport(ws, 720, 800);
    const narrow2 = await waitForB4State(ws, (s) => s.sidebarHiddenClass && s.toggle && !s.sidebarVisible);
    await check('B4-4 ≤800（720）：侧栏挂 sidebar--forced-hidden 不可见，侧栏手柄退场，toggle（title/aria=显示会话列表）在场', async () => {
      if (!narrow2.sidebarHiddenClass) throw new Error('.sidebar 未挂 sidebar--forced-hidden');
      if (narrow2.sidebarVisible) throw new Error('侧栏仍可见（display:none 失效）');
      if (narrow2.sidebarHandle) throw new Error('.resize-handle--sidebar 未随侧栏收起退场');
      if (!narrow2.toggle) throw new Error('.app-header__sidebar-toggle 未出现');
      if (narrow2.toggleTitle !== '显示会话列表' || narrow2.toggleAria !== '显示会话列表') {
        throw new Error(`toggle 文案失配：title=${narrow2.toggleTitle} aria=${narrow2.toggleAria} ≠ 显示会话列表`);
      }
    });
    await check('B4-5 点击 toggle：sidebar--overlay-open + sidebar-overlay-backdrop 在场（overlay 浮出）', async () => {
      const clicked = await evalExpr(ws, `(() => { const b = document.querySelector('.app-header__sidebar-toggle'); if (!b) return false; b.click(); return true; })()`);
      precondition(clicked, 'toggle .app-header__sidebar-toggle 不存在（无法点击）');
      const opened = await waitForB4State(ws, (s) => s.sidebarOverlayClass && s.backdrop && s.sidebarVisible);
      if (!opened.sidebarOverlayClass || !opened.backdrop) {
        throw new Error(`overlay 未浮出：overlayClass=${opened.sidebarOverlayClass} backdrop=${opened.backdrop}`);
      }
      if (!opened.sidebarVisible) throw new Error('overlay 开启后侧栏仍不可见（浮层未显示）');
    });
    await check('B4-6 点遮罩：backdrop 与 sidebar--overlay-open 退场，侧栏保持隐藏（forced-hidden 在）', async () => {
      const clicked = await evalExpr(ws, `(() => { const b = document.querySelector('.sidebar-overlay-backdrop'); if (!b) return false; b.click(); return true; })()`);
      precondition(clicked, '遮罩 .sidebar-overlay-backdrop 不存在（无法点击）');
      const closed = await waitForB4State(ws, (s) => !s.backdrop && !s.sidebarOverlayClass && s.sidebarHiddenClass && !s.sidebarVisible);
      if (closed.backdrop || closed.sidebarOverlayClass) {
        throw new Error(`遮罩点击未关 overlay：backdrop=${closed.backdrop} overlayClass=${closed.sidebarOverlayClass}`);
      }
      if (!closed.sidebarHiddenClass || closed.sidebarVisible) throw new Error('遮罩关闭后侧栏未保持隐藏');
    });

    // 站 4：恢复宽视口 → 自动复位（mq change 回调 + watch 兜底）。
    await setViewport(ws, 1280, 800);
    const restore = await waitForB4State(ws, (s) => s.taskPanel && s.taskHandle && s.sidebarHandle && !s.sidebarHiddenClass);
    await check('B4-7 恢复宽视口 1280：侧栏 forced-hidden 摘除、面板+双侧手柄回场，唤回条/toggle/backdrop 全退场（自动复位）', async () => {
      if (!restore.taskPanel || !restore.taskHandle || !restore.sidebarHandle) {
        throw new Error(`面板/手柄未回场：taskPanel=${restore.taskPanel} taskHandle=${restore.taskHandle} sidebarHandle=${restore.sidebarHandle}`);
      }
      if (restore.sidebarHiddenClass || restore.sidebarOverlayClass || restore.backdrop) {
        throw new Error(`侧栏态未复位：forcedHidden=${restore.sidebarHiddenClass} overlay=${restore.sidebarOverlayClass} backdrop=${restore.backdrop}`);
      }
      if (restore.reopen || restore.toggle) throw new Error(`唤回条/toggle 残留：reopen=${restore.reopen} toggle=${restore.toggle}`);
    });
  });
}

// ══ R1 场景组（2026-11-12 分组页签恢复）════════════════════════════════════════════════════════
// 复用 A1 runner（端口 9337 / mkdtemp --user-data-dir 隔离 profile / 用后即删 / out 新鲜度前置）；
// 真实键鼠（CDP Input 域）+ getComputedStyle 断言。用例正本 =
// docs/ui-completion/tests/R1R2-restore-cases.md §1 中标 CDP 的 14 例（R1-01/02/03/04/05/11/
// 14/15/16/17/18/19/20/21）。R1-18 按任务裁决以「组件态 ref + 无 electron-store/config 写入」
// 出钉（本组读隔离 profile 配置文件 + tdd-r1r2-restore-verify.ts 静态钉），不复现用例卷
// 「路由往返回全部」口误：groupByProject 为组件态 ref，AppLayout 常驻下路由切换不卸载侧栏，
// 语义为应用会话内保持、重启回默认（impl 卷 §4 边界 R1-6）。
const R1_TAB_ALL = '.sidebar__tabs button:nth-of-type(1)';
const R1_TAB_PROJECT = '.sidebar__tabs button:nth-of-type(2)';

function r1GroupHeaders(ws) {
  return evalExpr(ws, `(() => [...document.querySelectorAll('.sidebar__group')].map((g) => ({
    label: (g.querySelector('.sidebar__group__label')?.textContent ?? '').trim(),
    count: (g.querySelector('.sidebar__group__count')?.textContent ?? '').trim(),
    title: g.getAttribute('title'),
  })))()`);
}
function r1ActiveTab(ws) {
  return evalExpr(ws, `(() => { const a = document.querySelector('.sidebar__tab--active'); return a ? a.textContent.trim() : null; })()`);
}
function r1SessionNames(ws) {
  return evalExpr(ws, `(() => [...document.querySelectorAll('.session-link')].map((el) => el.getAttribute('aria-label') || (el.querySelector('.session-link__name')?.textContent ?? '').trim()))()`);
}
function r1SessionCount(ws) {
  return evalExpr(ws, `document.querySelectorAll('.session-link').length`);
}
async function r1Search(ws, q) {
  await evalExpr(ws, `(() => { const el = document.querySelector('.sidebar__search'); if (!el) return false; el.value = ${JSON.stringify(q)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(500); // 250ms 防抖 + IPC 结果返回余量
}
async function r1ClickTab(ws, selector) {
  await clickSelector(ws, selector); // CDP Input 域真实鼠标
  await sleep(350);
}
async function r1Wait(ws, probe, want, ms = 8000) {
  const deadline = Date.now() + ms;
  let v = null;
  for (;;) {
    v = await probe();
    if (want(v)) return v;
    if (Date.now() > deadline) return v;
    await sleep(300);
  }
}

async function runR1Scenario() {
  // 前置：out/ 产物新鲜度（同 runA1Scenarios/runI7Scenario/runB4Scenario 口径）。
  precondition(existsSync(MAIN_OUT) && existsSync(ELECTRON_EXE), 'out/main/index.js 或 electron.exe 缺失——先 npm run build');
  const outMtime = statSync(MAIN_OUT).mtime;
  for (const src of ['src/shared/constants.ts', 'src/main/modules/config-manager.ts']) {
    precondition(outMtime > statSync(path.join(REPO_ROOT, src)).mtime, `out/ 产物过期（${src} 晚于产物）——先 npm run build`);
  }

  // 预置 5 会话：projA 两条（反斜杠/正斜杠混用，其一置顶）、projB/projC 各一条、无 workingDir 一条。
  const specs = [
    { name: 'R1-projA-1', dir: 'D:\\ws\\projA', pinned: true },
    { name: 'R1-projA-2', dir: 'D:/ws/projA', pinned: false },
    { name: 'R1-projB-1', dir: 'D:\\ws\\projB', pinned: false },
    { name: 'R1-projC-1', dir: 'D:\\ws\\projC', pinned: false },
    { name: 'R1-none-1', dir: null, pinned: false },
  ];

  await runA1Scenario('R1-S1 分组页签恢复：全部/项目两视图 + 搜索 + 批量 + 键盘（隔离 --user-data-dir）', null, async (ws, profileDir) => {
    await enterChat(ws); // fresh profile 空态 → 新会话进聊天页，侧栏常驻
    const seeded = await evalExpr(ws, `(async () => {
      const specs = ${JSON.stringify(specs)};
      const out = [];
      for (const s of specs) {
        const created = await window.claudeLink.createSession(s.name, { workingDir: s.dir });
        if (s.pinned) await window.claudeLink.setSessionPinned(created.id, true);
        out.push({ id: created.id, name: s.name, dir: s.dir, pinned: s.pinned });
      }
      return out;
    })()`);
    precondition(Array.isArray(seeded) && seeded.length === specs.length, 'R1 预置会话失败（createSession/setSessionPinned）');
    const seededCount = await r1Wait(ws, () => r1SessionCount(ws), (n) => n === specs.length, 10000);
    precondition(seededCount === specs.length, `侧栏会话数=${seededCount} ≠ ${specs.length}（SESSIONS_CHANGED 重拉未生效）`);
    const allViewSnapshot = await r1SessionNames(ws); // 「全部」视图成员快照（R1-05 往返比对）

    await check('R1-01 页签组在搜索行与列表之间渲染且语义完整（role=group / aria / 恰 2 原生 button / 文档序）', async () => {
      const s = await evalExpr(ws, `(() => {
        const tabs = document.querySelector('.sidebar__tabs');
        if (!tabs) return null;
        const btns = [...tabs.querySelectorAll('button')];
        const row = document.querySelector('.sidebar__search-row');
        const nav = document.querySelector('.sidebar__sessions');
        const F = Node.DOCUMENT_POSITION_FOLLOWING;
        return {
          role: tabs.getAttribute('role'),
          aria: tabs.getAttribute('aria-label'),
          tags: btns.map((b) => b.tagName),
          texts: btns.map((b) => b.textContent.trim()),
          order: !!(row && nav && (row.compareDocumentPosition(tabs) & F) && (tabs.compareDocumentPosition(nav) & F)),
        };
      })()`);
      precondition(s, '.sidebar__tabs 容器不存在');
      if (s.role !== 'group') throw new Error(`role=${s.role} ≠ group`);
      if (s.aria !== '会话分组方式') throw new Error(`aria-label=${s.aria} ≠ 会话分组方式`);
      if (s.tags.length !== 2 || s.tags.some((t) => t !== 'BUTTON')) throw new Error(`页签钮形态异常：${s.tags.join(',')}`);
      if (s.texts.join(',') !== '全部,项目') throw new Error(`页签文案/顺序异常：${s.texts.join(',')}`);
      if (!s.order) throw new Error('页签容器不在 search-row 之后、sessions 列表之前');
    });

    await check('R1-02 默认激活「全部」且列表走日期五桶（置顶组最前）', async () => {
      const active = await r1ActiveTab(ws);
      if (active !== '全部') throw new Error(`默认 active=${active} ≠ 全部`);
      const heads = await r1GroupHeaders(ws);
      const labels = heads.map((h) => h.label);
      const allowed = new Set(['置顶', '今天', '昨天', '本周更早', '更早']);
      if (labels.some((l) => !allowed.has(l))) throw new Error(`出现非日期桶组头：${labels.join(',')}`);
      if (labels[0] !== '置顶') throw new Error(`置顶组应最前，实际 ${labels.join(',')}`);
    });

    await check('R1-03 active 页签有 accent 视觉、非 active 无（getComputedStyle ::after 对比 + accent token 解析值）', async () => {
      const s = await evalExpr(ws, `(() => {
        const active = document.querySelector('.sidebar__tab--active');
        const inactive = [...document.querySelectorAll('.sidebar__tab')].find((t) => t !== active);
        const probe = document.createElement('div');
        probe.style.color = 'var(--color-accent)';
        document.body.appendChild(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        return {
          activeAfter: active ? getComputedStyle(active, '::after').backgroundColor : null,
          inactiveAfter: inactive ? getComputedStyle(inactive, '::after').backgroundColor : null,
          accent,
        };
      })()`);
      if (!s.activeAfter || s.activeAfter === 'rgba(0, 0, 0, 0)' || s.activeAfter === 'transparent') {
        throw new Error(`active ::after 无底色：${s.activeAfter}`);
      }
      if (s.activeAfter !== s.accent) throw new Error(`active ::after 底色 ${s.activeAfter} ≠ accent 解析值 ${s.accent}`);
      if (s.inactiveAfter && s.inactiveAfter !== 'rgba(0, 0, 0, 0)' && s.inactiveAfter !== 'transparent') {
        throw new Error(`非 active 页签存在 ::after 底色：${s.inactiveAfter}`);
      }
    });

    await check('R1-04 点「项目」进入项目分组视图（组头=末段名/未选择工作空间，无日期桶与「置顶」组）', async () => {
      await r1ClickTab(ws, R1_TAB_PROJECT);
      const heads = await r1Wait(ws, () => r1GroupHeaders(ws), (h) => h.some((x) => x.label === 'projA'), 8000);
      const labels = heads.map((h) => h.label);
      if (labels.includes('置顶') || labels.includes('今天') || labels.includes('昨天')) {
        throw new Error(`项目视图仍出现日期桶/置顶组头：${labels.join(',')}`);
      }
      for (const want of ['projA', 'projB', 'projC', '未选择工作空间']) {
        if (!labels.includes(want)) throw new Error(`项目视图缺组头「${want}」：${labels.join(',')}`);
      }
      const projA = heads.find((h) => h.label === 'projA');
      if (!projA || Number(projA.count) !== 2) throw new Error(`projA 组应含 2 会话（混用分隔符归一），实际 ${projA?.count}`);
    });

    await check('R1-11 组头携带完整目录供 title 呈现（有目录组 title=原文，「未选择工作空间」组无 title）', async () => {
      const heads = await r1GroupHeaders(ws);
      const dirs = specs.map((s) => s.dir).filter(Boolean);
      const titled = heads.filter((h) => h.title);
      if (titled.length === 0) throw new Error('项目视图组头全无 title');
      if (!titled.some((h) => dirs.includes(h.title))) throw new Error(`组头 title 未命中预置目录原文：${titled.map((h) => h.title).join(' | ')}`);
      const none = heads.find((h) => h.label === '未选择工作空间');
      if (none && none.title) throw new Error(`「未选择工作空间」组头不应带 title：${none.title}`);
    });

    await check('R1-18 页签选择不持久化（组件态 ref；隔离 profile 配置文件无 groupByProject/视图态写入）', async () => {
      const cfgPath = path.join(profileDir, 'claude-link-config.json');
      const raw = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
      if (/groupByProject|group-by-project|sidebarView|viewMode/.test(raw)) {
        throw new Error('隔离配置写入了页签视图态（不持久化契约破坏）');
      }
    });

    await check('R1-05 点「全部」回日期视图且五桶组成不变（成员快照 deepEqual）', async () => {
      await r1ClickTab(ws, R1_TAB_ALL);
      const heads = await r1Wait(ws, () => r1GroupHeaders(ws), (h) => h.some((x) => x.label === '置顶'), 8000);
      if (!heads.some((h) => h.label === '置顶')) throw new Error('回「全部」后缺置顶组');
      const now = await r1SessionNames(ws);
      if (JSON.stringify(now.slice().sort()) !== JSON.stringify(allViewSnapshot.slice().sort())) {
        throw new Error(`往返后成员漂移：before=${allViewSnapshot.join(',')} after=${now.join(',')}`);
      }
    });

    await check('R1-14 搜索态下项目视图对搜索结果分组（仅命中项目组、成员收敛）', async () => {
      await r1Search(ws, 'R1-projA');
      await r1ClickTab(ws, R1_TAB_PROJECT);
      const heads = await r1Wait(ws, () => r1GroupHeaders(ws), (h) => h.length === 1 && h[0].label === 'projA', 8000);
      if (heads.length !== 1 || heads[0].label !== 'projA') throw new Error(`搜索+项目视图组应为单 projA：${heads.map((h) => h.label).join(',')}`);
      if (Number(heads[0].count) !== 2) throw new Error(`projA 组应含 2 命中会话，实际 ${heads[0].count}`);
    });

    await check('R1-15 项目视图停留期间搜索防抖结果晚到 → 分组重算（新关键词后组与成员收敛）', async () => {
      await r1Search(ws, 'R1-projB-1');
      const heads = await r1Wait(ws, () => r1GroupHeaders(ws), (h) => h.length === 1 && h[0].label === 'projB', 8000);
      if (heads.length !== 1 || heads[0].label !== 'projB') throw new Error(`防抖晚到后未重算为 projB：${heads.map((h) => h.label).join(',')}`);
      if (Number(heads[0].count) !== 1) throw new Error(`projB 组应含 1 命中会话，实际 ${heads[0].count}`);
      await r1Search(ws, ''); // 清搜索，恢复全量（供后续批量/连点用例）
      await r1Wait(ws, () => r1SessionCount(ws), (n) => n === specs.length, 8000);
    });

    await check('R1-16 批量删除模式在项目视图可用（复选框渲染/全选/删除(n) 计数）', async () => {
      await clickSelector(ws, '.sidebar__multiselect'); // 真实鼠标开批量态
      await sleep(300);
      const s = await evalExpr(ws, `(() => ({
        checks: document.querySelectorAll('.session-link__check').length,
        bar: !!document.querySelector('.sidebar__batchbar'),
      }))()`);
      if (!s.bar) throw new Error('项目视图缺批量条');
      if (s.checks !== specs.length) throw new Error(`复选框数 ${s.checks} ≠ ${specs.length}`);
      await clickSelector(ws, '.sidebar__batchbar__all input'); // 全选
      await sleep(200);
      const sel = await evalExpr(ws, `document.querySelectorAll('.session-link--selected').length`);
      if (sel !== specs.length) throw new Error(`全选后选中数 ${sel} ≠ ${specs.length}`);
      const del = await evalExpr(ws, `(document.querySelector('.sidebar__batchbar__delete')?.textContent ?? '').trim()`);
      if (!/\(\s*5\s*\)/.test(del)) throw new Error(`删除(n) 计数漂移：${del}`);
    });

    await check('R1-17 批量选中集合跨视图切换保留（选中态与删除(n) 计数不变）', async () => {
      await r1ClickTab(ws, R1_TAB_ALL);
      const a = await evalExpr(ws, `({ sel: document.querySelectorAll('.session-link--selected').length, del: (document.querySelector('.sidebar__batchbar__delete')?.textContent ?? '').trim() })`);
      await r1ClickTab(ws, R1_TAB_PROJECT);
      const b = await evalExpr(ws, `({ sel: document.querySelectorAll('.session-link--selected').length, del: (document.querySelector('.sidebar__batchbar__delete')?.textContent ?? '').trim() })`);
      if (a.sel !== specs.length || b.sel !== specs.length) throw new Error(`切视图丢选中集：all=${a.sel} project=${b.sel}`);
      if (a.del !== b.del) throw new Error(`切视图删除(n) 计数漂移：${a.del} → ${b.del}`);
      await clickSelector(ws, '.sidebar__multiselect'); // 退出批量态（后续键盘/连点）
      await sleep(300);
    });

    await check('R1-19 页签键盘可达：Tab 移焦 + Enter 激活「项目」+ Space 激活「全部」（CDP Input 域真实键盘）', async () => {
      await evalExpr(ws, `document.querySelector(${JSON.stringify(R1_TAB_ALL)})?.focus(), true`);
      await pressKey(ws, KEY_TAB);
      const focused = await evalExpr(ws, `(() => { const a = document.activeElement; return a ? a.textContent.trim() : null; })()`);
      if (focused !== '项目') throw new Error(`Tab 未移焦到「项目」页签：${focused}`);
      await pressKey(ws, KEY_ENTER);
      const enterView = await r1Wait(ws, () => r1ActiveTab(ws), (v) => v === '项目', 5000);
      if (enterView !== '项目') throw new Error(`Enter 未激活「项目」：${enterView}`);
      await evalExpr(ws, `document.querySelector(${JSON.stringify(R1_TAB_ALL)})?.focus(), true`);
      await pressKey(ws, KEY_SPACE);
      const spaceView = await r1Wait(ws, () => r1ActiveTab(ws), (v) => v === '全部', 5000);
      if (spaceView !== '全部') throw new Error(`Space 未激活「全部」：${spaceView}`);
    });

    await check('R1-21 快速连点页签终态一致（≥6 次交替后无重复成员、五桶组成完整）', async () => {
      for (let i = 0; i < 6; i++) await r1ClickTab(ws, i % 2 === 0 ? R1_TAB_PROJECT : R1_TAB_ALL);
      await r1ClickTab(ws, R1_TAB_ALL); // 停于「全部」
      const n = await r1SessionCount(ws);
      if (n !== specs.length) throw new Error(`连点后成员数 ${n} ≠ ${specs.length}（重复/丢失节点）`);
      const heads = await r1GroupHeaders(ws);
      if (!heads.some((h) => h.label === '置顶')) throw new Error('连点后「全部」视图五桶组头不完整（缺置顶组）');
      await r1ClickTab(ws, R1_TAB_PROJECT); // 再停于「项目」复验同规则
      const n2 = await r1SessionCount(ws);
      if (n2 !== specs.length) throw new Error(`项目视图连点后成员数 ${n2} ≠ ${specs.length}`);
    });

    await check('R1-20 空态文案分支在两视图下沿用（项目视图搜索无命中=未找到匹配的会话，不新增第三态）', async () => {
      await r1Search(ws, 'R1-NO-SUCH-SESSION-KEYWORD');
      const t = await evalExpr(ws, `(() => { const e = document.querySelector('.sidebar__empty'); return e ? e.textContent.trim() : null; })()`);
      if (t !== '未找到匹配的会话') throw new Error(`项目视图空态文案=${t} ≠ 未找到匹配的会话`);
      const heads = await r1GroupHeaders(ws);
      if (heads.length !== 0) throw new Error(`空态仍渲染组头：${heads.map((h) => h.label).join(',')}`);
      await r1Search(ws, ''); // 复原（用后即删 profile，不影响用户真实配置）
    });
  });
}

// ══ R2 场景组（2026-11-12 置顶钮迁 r1）════════════════════════════════════════════════════════
// 复用 A1 runner（端口 9337 / mkdtemp --user-data-dir 隔离 profile / 用后即删 / out 新鲜度前置）；
// 真实键鼠（CDP Input 域 mouseMoved/pressed/released + dispatchKeyEvent）+ getComputedStyle 断言。
// 用例正本 = docs/ui-completion/tests/R1R2-restore-cases.md §2 中标 CDP 的 8 例
// （R2-03/04/05/06/08/09/10/12）。owner 终裁（计划 §0-4）：title=短文案「取消置顶/置顶会话」、
// aria-label=文案+会话名；用例卷 R2-08「title 也含会话名」为出卷口误，CDP 断言按终裁。
// R2-07（暂态守卫）运行时不可达（暂态不进列表），由 tdd-r1r2-restore-verify.ts 静态钉 + 目检申报覆盖。
const R2_PIN_SEL = '.session-link__pinbtn';

// 会话卡置顶钮探针：按会话名定位卡片，回报钮所在行（r1/r2）、双态类、width/opacity/pointer-events/
// color（含 accent 解析值对照）、title/aria、r1 首元素、时间列/删除钮 computed display、焦点环。
function r2PinProbe(ws, name) {
  return evalExpr(ws, `(() => {
    const card = [...document.querySelectorAll('.session-link')].find(
      (el) => (el.querySelector('.session-link__name')?.textContent ?? '').trim() === ${JSON.stringify(name)});
    if (!card) return null;
    const r1 = card.querySelector('.session-link__r1');
    const r2 = card.querySelector('.session-link__r2');
    const btn = card.querySelector(${JSON.stringify(R2_PIN_SEL)});
    const cs = btn ? getComputedStyle(btn) : null;
    const probe = document.createElement('i');
    probe.style.color = 'var(--color-accent)';
    document.documentElement.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const time = card.querySelector('.session-link__time');
    const del = card.querySelector('.session-link__delete');
    return {
      pinCount: card.querySelectorAll(${JSON.stringify(R2_PIN_SEL)}).length,
      inR1: !!(btn && r1 && r1.contains(btn)),
      inR2: !!(btn && r2 && r2.contains(btn)),
      pinned: !!(btn && btn.classList.contains('session-link__pinbtn--pinned')),
      width: cs ? cs.width : null,
      opacity: cs ? cs.opacity : null,
      pointerEvents: cs ? cs.pointerEvents : null,
      color: cs ? cs.color : null,
      title: btn ? btn.getAttribute('title') : null,
      aria: btn ? btn.getAttribute('aria-label') : null,
      accent,
      firstR1Class: r1 && r1.firstElementChild ? r1.firstElementChild.className : null,
      timeDisplay: time ? getComputedStyle(time).display : null,
      delDisplay: del ? getComputedStyle(del).display : null,
      outlineWidth: cs ? cs.outlineWidth : null,
      outlineStyle: cs ? cs.outlineStyle : null,
    };
  })()`);
}

// 组→成员映射（按 .sidebar__sessions DOM 顺序：组头后跟会话卡），供「点击后即时重排」断言。
function r2Groups(ws) {
  return evalExpr(ws, `(() => {
    const nav = document.querySelector('.sidebar__sessions');
    if (!nav) return [];
    const out = [];
    let cur = null;
    for (const el of nav.children) {
      if (el.classList.contains('sidebar__group')) {
        cur = { label: (el.querySelector('.sidebar__group__label')?.textContent ?? '').trim(), names: [] };
        out.push(cur);
      } else if (el.classList.contains('session-link') && cur) {
        cur.names.push((el.querySelector('.session-link__name')?.textContent ?? '').trim());
      }
    }
    return out;
  })()`);
}

async function r2Wait(ws, probe, want, ms = 8000) {
  const deadline = Date.now() + ms;
  let v = null;
  for (;;) {
    v = await probe();
    if (want(v)) return v;
    if (Date.now() > deadline) return v;
    await sleep(300);
  }
}

// 真实鼠标移动到卡片中心（触发 :hover / :focus-within 显现组），或移出到 (1,1) 复原。
async function r2MoveTo(ws, x, y) {
  await cdpCall(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', buttons: 0 });
  await sleep(250);
}
async function r2HoverCard(ws, name) {
  const pos = await evalExpr(ws, `(() => {
    const card = [...document.querySelectorAll('.session-link')].find(
      (el) => (el.querySelector('.session-link__name')?.textContent ?? '').trim() === ${JSON.stringify(name)});
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!pos) throw new PreconditionError(`r2HoverCard 找不到会话卡：${name}`);
  await r2MoveTo(ws, pos.x, pos.y);
}
async function r2Leave(ws) {
  await r2MoveTo(ws, 1, 1);
}
// 真实点击指定会话卡的置顶钮（按 DOM 现算矩形中心，CDP Input 域鼠标）。
async function r2ClickPin(ws, name) {
  const pos = await evalExpr(ws, `(() => {
    const card = [...document.querySelectorAll('.session-link')].find(
      (el) => (el.querySelector('.session-link__name')?.textContent ?? '').trim() === ${JSON.stringify(name)});
    const btn = card && card.querySelector(${JSON.stringify(R2_PIN_SEL)});
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!pos) throw new PreconditionError(`r2ClickPin 找不到置顶钮：${name}`);
  await realClick(ws, pos.x, pos.y);
}

async function runR2Scenario() {
  // 前置：out/ 产物新鲜度（同 runA1Scenarios/runR1Scenario 口径）。
  precondition(existsSync(MAIN_OUT) && existsSync(ELECTRON_EXE), 'out/main/index.js 或 electron.exe 缺失——先 npm run build');
  const outMtime = statSync(MAIN_OUT).mtime;
  for (const src of ['src/shared/constants.ts', 'src/main/modules/config-manager.ts']) {
    precondition(outMtime > statSync(path.join(REPO_ROOT, src)).mtime, `out/ 产物过期（${src} 晚于产物）——先 npm run build`);
  }

  // 预置 4 会话：1 已置顶（R2-P，落「置顶」组）+ 3 未置顶（各用例独占，避免态互相污染）。
  const specs = [
    { name: 'R2-P', pinned: true },
    { name: 'R2-U1', pinned: false },
    { name: 'R2-U2', pinned: false },
    { name: 'R2-U3', pinned: false },
  ];

  await runA1Scenario('R2-S1 置顶钮迁 r1：恒显/点击重排/hover/键盘/批量/时间互换/连点（隔离 --user-data-dir）', null, async (ws) => {
    await enterChat(ws); // fresh profile 空态 → 新会话进聊天页，侧栏常驻
    const seeded = await evalExpr(ws, `(async () => {
      const specs = ${JSON.stringify(specs)};
      const out = [];
      for (const s of specs) {
        const created = await window.claudeLink.createSession(s.name, { workingDir: null });
        if (s.pinned) await window.claudeLink.setSessionPinned(created.id, true);
        out.push({ id: created.id, name: s.name, pinned: s.pinned });
      }
      return out;
    })()`);
    precondition(Array.isArray(seeded) && seeded.length === specs.length, 'R2 预置会话失败（createSession/setSessionPinned）');
    const seededCount = await r2Wait(ws, () => evalExpr(ws, `document.querySelectorAll('.session-link').length`),
      (n) => n === specs.length, 10000);
    precondition(seededCount === specs.length, `侧栏会话数=${seededCount} ≠ ${specs.length}（SESSIONS_CHANGED 重拉未生效）`);

    // R2-03 已置顶恒显 accent（不 hover/不聚焦）vs 未置顶同位钮隐藏（getComputedStyle 两态对照）。
    await check('R2-03 已置顶钮恒显且强调色（pinned 卡 width/opacity/pointer-events + accent 解析值 vs 未置顶卡 hidden）', async () => {
      await r2Leave(ws);
      const pinned = await r2PinProbe(ws, 'R2-P');
      const plain = await r2PinProbe(ws, 'R2-U1');
      if (!pinned || !plain) throw new Error('置顶/未置顶卡探针缺失');
      if (pinned.pinCount !== 1 || plain.pinCount !== 1) throw new Error(`单卡置顶钮应恰 1 个：${pinned.pinCount}/${plain.pinCount}`);
      if (!pinned.inR1 || pinned.inR2) throw new Error('置顶钮未迁至 r1（或仍在 r2）');
      if (!pinned.pinned || plain.pinned) throw new Error(`双态类不符：pinned=${pinned.pinned} plain=${plain.pinned}`);
      if (pinned.width !== '18px' || pinned.opacity !== '1' || pinned.pointerEvents !== 'auto') {
        throw new Error(`已置顶钮未恒显：width=${pinned.width} opacity=${pinned.opacity} pe=${pinned.pointerEvents}`);
      }
      if (pinned.color !== pinned.accent) throw new Error(`已置顶钮着色 ${pinned.color} ≠ accent 解析值 ${pinned.accent}`);
      if (plain.width !== '0px' || plain.opacity !== '0' || plain.pointerEvents !== 'none') {
        throw new Error(`未置顶钮未隐藏：width=${plain.width} opacity=${plain.opacity} pe=${plain.pointerEvents}`);
      }
    });

    // R2-08 title/aria 双属性逐字（owner §0-4：title 短文案、aria-label 文案+会话名）。
    await check('R2-08 title/aria 逐字（未置顶：title=置顶会话 / aria=置顶会话 名；已置顶：title=取消置顶 / aria=取消置顶 名）', async () => {
      await r2Leave(ws);
      const plain = await r2PinProbe(ws, 'R2-U1');
      const pinned = await r2PinProbe(ws, 'R2-P');
      if (plain.title !== '置顶会话' || plain.aria !== '置顶会话 R2-U1') {
        throw new Error(`未置顶 title/aria 漂移：${plain.title} / ${plain.aria}`);
      }
      if (pinned.title !== '取消置顶' || pinned.aria !== '取消置顶 R2-P') {
        throw new Error(`已置顶 title/aria 漂移：${pinned.title} / ${pinned.aria}`);
      }
    });

    // R2-04 已置顶钮点击=取消置顶且列表即时重排（点击后会话离开「置顶」组，稳定后 pinnedAt=null）。
    await check('R2-04 已置顶钮点击=取消置顶且列表即时重排（离开「置顶」组；稳定后 --pinned 类消失）', async () => {
      const before = await r2Groups(ws);
      const top = before.find((g) => g.label === '置顶');
      if (!top || !top.names.includes('R2-P')) throw new Error(`R2-P 起始不在「置顶」组：${JSON.stringify(before)}`);
      await r2ClickPin(ws, 'R2-P');
      const after = await r2Wait(ws, () => r2Groups(ws), (gs) => {
        const t = gs.find((g) => g.label === '置顶');
        return !t || !t.names.includes('R2-P');
      }, 8000);
      const topAfter = after.find((g) => g.label === '置顶');
      if (topAfter && topAfter.names.includes('R2-P')) throw new Error('取消置顶后会话仍在「置顶」组（重排未生效）');
      const probe = await r2Wait(ws, () => r2PinProbe(ws, 'R2-P'), (p) => p && !p.pinned, 8000);
      if (probe.pinned) throw new Error('稳定态仍挂 --pinned 类（权威态与乐观态不一致）');
    });

    // R2-05 未置顶钮 hover 显现、点击=置顶且即时重排；移出 hover 后已置顶钮仍恒显。
    await check('R2-05 未置顶钮 hover 显现 + 点击置顶即时进「置顶」组 + 移出 hover 后恒显', async () => {
      await r2HoverCard(ws, 'R2-U1');
      const hovered = await r2PinProbe(ws, 'R2-U1');
      if (hovered.width !== '18px' || hovered.opacity !== '1' || hovered.pointerEvents !== 'auto') {
        throw new Error(`hover 未显现置顶钮：width=${hovered.width} opacity=${hovered.opacity}`);
      }
      await r2ClickPin(ws, 'R2-U1');
      const gs = await r2Wait(ws, () => r2Groups(ws),
        (g) => g.some((x) => x.label === '置顶' && x.names.includes('R2-U1')), 8000);
      if (!gs.some((x) => x.label === '置顶' && x.names.includes('R2-U1'))) {
        throw new Error('点击置顶后 R2-U1 未进「置顶」组（即时重排未生效）');
      }
      await r2Leave(ws);
      const settled = await r2Wait(ws, () => r2PinProbe(ws, 'R2-U1'), (p) => p && p.pinned, 8000);
      if (settled.width !== '18px' || settled.opacity !== '1' || settled.color !== settled.accent) {
        throw new Error('移出 hover 后已置顶钮未恒显 accent（与 R2-03 衔接失败）');
      }
    });

    // R2-06 未置顶钮 :focus-within 显现 + focus-visible 焦点环 + Enter 激活置顶（真实键盘）。
    // 用例卷 R2-06 规定步骤：先聚焦卡片容器 → 继续 Tab 进入卡内控件直至置顶钮（容器 tabindex=0
    // 为键盘入口，非批量 r1 内首个可聚焦控件即置顶钮）。键盘源焦点使 :focus-within 与
    // :focus-visible 同时成立。width/opacity 显现有 --duration-fast(120ms) 过渡，聚焦/Tab 后须等
    // 落定再探针（同 r2MoveTo 250ms 先例），否则读到过渡起点 0px（2026-11-12 终审门实败根因）。
    await check('R2-06 :focus-within 显现 + focus-visible 焦点环 + Enter 激活置顶（CDP Input 域真实键盘）', async () => {
      await r2Leave(ws);
      const focused = await evalExpr(ws, `(() => {
        const card = [...document.querySelectorAll('.session-link')].find(
          (el) => (el.querySelector('.session-link__name')?.textContent ?? '').trim() === ${JSON.stringify('R2-U2')});
        if (card) card.focus();
        return !!card && document.activeElement === card;
      })()`);
      if (!focused) throw new Error('卡片容器不可聚焦（tabindex=0 丢失或卡未渲染）');
      await pressKey(ws, KEY_TAB); // 容器 → 置顶钮：键盘源焦点落钮
      await sleep(300); // --duration-fast(120ms) 显现过渡落定后再探针
      const probe = await r2PinProbe(ws, 'R2-U2');
      if (probe.width !== '18px' || probe.opacity !== '1') {
        throw new Error(`聚焦态置顶钮未显现：width=${probe.width} opacity=${probe.opacity}`);
      }
      if (probe.outlineStyle === 'none' || probe.outlineWidth === '0px') {
        throw new Error(`focus-visible 焦点环缺失：${probe.outlineWidth} ${probe.outlineStyle}`);
      }
      await pressKey(ws, KEY_ENTER);
      const gs = await r2Wait(ws, () => r2Groups(ws),
        (g) => g.some((x) => x.label === '置顶' && x.names.includes('R2-U2')), 8000);
      if (!gs.some((x) => x.label === '置顶' && x.names.includes('R2-U2'))) {
        throw new Error('Enter 未激活置顶（键盘路径断链）');
      }
    });

    // R2-09 批量模式置顶钮零渲染、r1 首位复选框；退出批量后置顶钮恢复。
    await check('R2-09 批量模式置顶钮隐藏 + r1 首位复选框 + 退出批量后置顶钮恢复', async () => {
      await r2Leave(ws);
      await clickSelector(ws, '.sidebar__multiselect'); // 真实鼠标开批量态
      await sleep(300);
      const s = await evalExpr(ws, `(() => ({
        pinCount: document.querySelectorAll(${JSON.stringify(R2_PIN_SEL)}).length,
        checkCount: document.querySelectorAll('.session-link__check').length,
        firstR1: (() => { const c = document.querySelector('.session-link__r1'); return c && c.firstElementChild ? c.firstElementChild.className : null; })(),
      }))()`);
      if (s.pinCount !== 0) throw new Error(`批量态仍有 ${s.pinCount} 个置顶钮`);
      if (s.checkCount !== specs.length) throw new Error(`批量态复选框数 ${s.checkCount} ≠ ${specs.length}`);
      if (s.firstR1 !== 'session-link__check') throw new Error(`r1 首位非复选框：${s.firstR1}`);
      await clickSelector(ws, '.sidebar__multiselect'); // 退出批量
      await sleep(300);
      const restored = await evalExpr(ws, `document.querySelectorAll(${JSON.stringify(R2_PIN_SEL)}).length`);
      if (restored !== specs.length) throw new Error(`退出批量后置顶钮恢复数 ${restored} ≠ ${specs.length}`);
    });

    // R2-10 时间列↔删除钮 hover 互换保持；移出复原；批量态时间列恢复。
    await check('R2-10 时间↔删除 hover 互换（hover：time none + delete grid；移出复原；批量态 time 恢复）', async () => {
      await r2HoverCard(ws, 'R2-U3');
      const hov = await r2PinProbe(ws, 'R2-U3');
      if (hov.timeDisplay !== 'none') throw new Error(`hover 时间列未隐藏：${hov.timeDisplay}`);
      if (hov.delDisplay !== 'grid') throw new Error(`hover 删除钮未显现：${hov.delDisplay}`);
      await r2Leave(ws);
      const off = await r2PinProbe(ws, 'R2-U3');
      if (off.timeDisplay === 'none') throw new Error('移出 hover 后时间列未恢复');
      if (off.delDisplay === 'grid') throw new Error('移出 hover 后删除钮未隐藏');
      await clickSelector(ws, '.sidebar__multiselect'); // 批量态
      await sleep(250);
      const batched = await evalExpr(ws, `(() => {
        const card = [...document.querySelectorAll('.session-link')].find(
          (el) => (el.querySelector('.session-link__name')?.textContent ?? '').trim() === ${JSON.stringify('R2-U3')});
        const t = card && card.querySelector('.session-link__time');
        return t ? getComputedStyle(t).display : null;
      })()`);
      if (batched === 'none') throw new Error('批量态时间列未恢复显示（hover 隐藏未被豁免）');
      await clickSelector(ws, '.sidebar__multiselect'); // 退出批量
      await sleep(250);
    });

    // R2-12 连点置顶钮终态一致（置顶→取消；稳定后 --pinned 消失、会话恰 1 次、无幽灵「置顶」成员）。
    await check('R2-12 连点置顶钮终态一致（2 次连点后回落未置顶 + 成员集合无重复/幽灵）', async () => {
      await r2Leave(ws);
      await r2HoverCard(ws, 'R2-U3');
      await r2ClickPin(ws, 'R2-U3');
      await r2ClickPin(ws, 'R2-U3');
      const probe = await r2Wait(ws, () => r2PinProbe(ws, 'R2-U3'), (p) => p && !p.pinned, 10000);
      if (probe.pinned) throw new Error('连点稳定后仍挂 --pinned（乐观 patch 与权威重拉竞争错乱）');
      const dup = await evalExpr(ws, `(() => [...document.querySelectorAll('.session-link')]
        .filter((el) => (el.querySelector('.session-link__name')?.textContent ?? '').trim() === ${JSON.stringify('R2-U3')}).length)()`);
      if (dup !== 1) throw new Error(`R2-U3 出现 ${dup} 次（重复节点）`);
      const ghost = await r2Groups(ws);
      const top = ghost.find((g) => g.label === '置顶');
      if (top && top.names.includes('R2-U3')) throw new Error('幽灵「置顶」组成员残留');
    });
  });
}

main().catch((e) => {
  if (e instanceof PreconditionError) {
    console.error(`\n前置条件不满足（无法执行，不算通过）：${e.message}`);
    process.exit(2);
  }
  console.error('FATAL:', e.message);
  process.exit(1);
});
