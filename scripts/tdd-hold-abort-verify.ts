// tdd-hold-abort-verify.ts
// 问题⑥（2026-09-27 六使用问题）中断防误触 TDD 验证脚本：
//   A 组  use-hold-action.ts composable 关键形态（静态）；
//   B 组  composable 行为用例（node 实测：rAF stub + 假指针/键盘事件，短 durationMs 加速）；
//   C 组  SessionToolbar.vue 接入字面（进度填充/holding 态/title/旧 @click 移除）；
//   D 组  ChatPage.vue Esc 急停分流（sending 守卫 + 分层避让静态断言）。
// 运行：npx tsx scripts/tdd-hold-abort-verify.ts（已登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

function readIfExists(rel: string): string | null {
  try { return readFileSync(join(__dirname, rel), 'utf8'); } catch { return null; }
}

const composableSrc = readIfExists('../src/renderer/composables/use-hold-action.ts');
const toolbarSrc = readIfExists('../src/renderer/components/chat/SessionToolbar.vue');
const chatPageSrc = readIfExists('../src/renderer/pages/ChatPage.vue');
const appHeaderSrc = readIfExists('../src/renderer/components/layout/AppHeader.vue');
const e2eRealSrc = readIfExists('../scripts/cdp-real-window-e2e.mjs');
const e2eContextSrc = readIfExists('../scripts/cdp-context-e2e.mjs');
const e2eHarnessSrc = readIfExists('../scripts/context-research-harness.mjs');

console.log('\n=== A 组 · use-hold-action.ts composable 形态（静态） ===');

async function main(): Promise<void> {
await check('A1 文件存在且导出 useHoldAction', async () => {
  assert.ok(composableSrc, 'src/renderer/composables/use-hold-action.ts 不存在');
  assert.ok(composableSrc.includes('export function useHoldAction'), '缺 useHoldAction 导出');
});

await check('A2 durationMs 默认 1000（options 可覆盖）', () => {
  assert.ok(composableSrc!.includes('options.durationMs ?? 1000'), '缺 options.durationMs ?? 1000 默认');
});

await check('A3 返回集：holding/holdProgress/指针五件套/键盘两件/onBlur/resetHold', () => {
  for (const k of ['holding', 'holdProgress', 'onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerLeave', 'onPointerCancel', 'onKeydown', 'onKeyup', 'onBlur', 'resetHold']) {
    assert.ok(composableSrc!.includes(k), `返回集缺 ${k}`);
  }
});

await check('A4 setPointerCapture 失败静默降级（try/catch no-op）', () => {
  const body = composableSrc!.match(/function onPointerDown[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.ok(body.includes('setPointerCapture'), 'onPointerDown 未捕获指针');
  assert.ok(body.includes('catch'), 'setPointerCapture 未做 try/catch 静默降级');
});

await check('A5 rAF 进度 + 进度满 onComplete 后 150ms 复位', () => {
  assert.ok(composableSrc!.includes('requestAnimationFrame'), '进度未用 rAF 驱动');
  assert.ok(/150\).{0,40}resetHold|setTimeout\(resetHold,\s*150\)/.test(composableSrc!), '进度满后缺 150ms 复位');
});

await check('A6 键盘 Space/Enter 且 !repeat 启动；onBeforeUnmount 清理', () => {
  const kd = composableSrc!.match(/function onKeydown[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.ok(kd.includes('e.repeat'), 'onKeydown 未忽略自动重复');
  assert.ok(kd.includes("' '") && kd.includes("'Enter'"), 'onKeydown 未限定 Space/Enter');
  assert.ok(composableSrc!.includes('onBeforeUnmount'), '缺 onBeforeUnmount 清理');
});

await check('A7 window blur 监听注册/移除成对 + 无「已知限制」残留口径（清零轮 A 项）', () => {
  assert.ok(
    composableSrc!.includes("window.addEventListener('blur', resetHold)"),
    'setup 缺 window blur 监听注册（窗口失焦取消补全）',
  );
  assert.ok(
    composableSrc!.includes("window.removeEventListener('blur', resetHold)"),
    '卸载缺 window blur 监听成对移除',
  );
  assert.ok(
    composableSrc!.includes("typeof window !== 'undefined'"),
    'window 访问缺 typeof 守卫（node/SSR 环境安全）',
  );
  assert.ok(!composableSrc!.includes('已知限制'), 'A 项收口后注释不应再含「已知限制」口径');
});

console.log('\n=== B 组 · composable 行为用例（node 实测） ===');

type HoldModule = typeof import('../src/renderer/composables/use-hold-action');
let holdMod: HoldModule | null | undefined;
async function loadHold(): Promise<HoldModule | null> {
  if (holdMod === undefined) {
    try { holdMod = await import('../src/renderer/composables/use-hold-action'); }
    catch { holdMod = null; }
  }
  return holdMod;
}

// rAF stub：手动泵帧（真实时钟），cancel 丢弃待执行帧。
type FrameCb = (t: number) => void;
let rafQueue: FrameCb[] = [];
(globalThis as unknown as { requestAnimationFrame: (cb: FrameCb) => number }).requestAnimationFrame = (cb) => {
  rafQueue.push(cb);
  return rafQueue.length;
};
(globalThis as unknown as { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame = () => {
  rafQueue = [];
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function pump(stepMs = 8, rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await sleep(stepMs);
    const pending = rafQueue;
    rafQueue = [];
    for (const cb of pending) cb(performance.now());
  }
}
// 小步泵帧直至条件成立（完成瞬间断言用——完整 pump 会跨过 150ms 复位窗口）。
async function pumpUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('pumpUntil 超时');
    await sleep(4);
    const pending = rafQueue;
    rafQueue = [];
    for (const cb of pending) cb(performance.now());
  }
}
function fakePointer(opts: { x?: number; y?: number } = {}): PointerEvent {
  return {
    button: 0,
    pointerId: 1,
    clientX: opts.x ?? 50,
    clientY: opts.y ?? 20,
    currentTarget: {
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 40 }),
    },
    preventDefault: () => {},
  } as unknown as PointerEvent;
}
function fakeKey(key: string, repeat = false): KeyboardEvent {
  return { key, repeat, preventDefault: () => {} } as unknown as KeyboardEvent;
}

await check('B1 单击（<durationMs 松开）不触发 onComplete', async () => {
  const m = await loadHold();
  if (!m) throw new Error('use-hold-action 模块不存在');
  let calls = 0;
  const h = m.useHoldAction(() => { calls += 1; }, { durationMs: 60 });
  h.onPointerDown(fakePointer());
  assert.equal(h.holding.value, true, '按住后 holding 应为 true');
  await sleep(20);
  h.onPointerUp(fakePointer());
  assert.equal(h.holding.value, false, '松开后 holding 应复位');
  await pump();
  assert.equal(calls, 0, `未满即松开不应触发（实际 ${calls} 次）`);
});

await check('B2 按住满 durationMs 触发一次，继续按住不重复触发', async () => {
  const m = await loadHold();
  if (!m) throw new Error('use-hold-action 模块不存在');
  let calls = 0;
  const h = m.useHoldAction(() => { calls += 1; }, { durationMs: 60 });
  h.onPointerDown(fakePointer());
  await pumpUntil(() => calls >= 1);
  assert.equal(calls, 1, `满时长应恰好触发一次（实际 ${calls} 次）`);
  assert.equal(h.holdProgress.value, 100, '进度应停在 100');
  await pump(); // 继续按住（无新 pointerdown，跨过 150ms 复位窗口）
  assert.equal(calls, 1, `进度满后 rAF 停摆不应二次触发（实际 ${calls} 次）`);
  h.resetHold();
});

await check('B3 pointermove 滑出按钮坐标 → 取消，无触发', async () => {
  const m = await loadHold();
  if (!m) throw new Error('use-hold-action 模块不存在');
  let calls = 0;
  const h = m.useHoldAction(() => { calls += 1; }, { durationMs: 60 });
  h.onPointerDown(fakePointer());
  h.onPointerMove(fakePointer({ x: 500 })); // 滑出（rect right=100）
  assert.equal(h.holding.value, false, '滑出后应取消');
  await pump();
  assert.equal(calls, 0, '滑出取消后不应触发');
});

await check('B4 pointerleave / pointercancel → 取消', async () => {
  const m = await loadHold();
  if (!m) throw new Error('use-hold-action 模块不存在');
  const h = m.useHoldAction(() => {}, { durationMs: 60 });
  h.onPointerDown(fakePointer());
  h.onPointerLeave();
  assert.equal(h.holding.value, false, 'pointerleave 应取消');
  h.onPointerDown(fakePointer());
  h.onPointerCancel();
  assert.equal(h.holding.value, false, 'pointercancel 应取消');
});

await check('B5 键盘 Space 按住满时长等效触发；提前 keyup 无动作；repeat 忽略', async () => {
  const m = await loadHold();
  if (!m) throw new Error('use-hold-action 模块不存在');
  let calls = 0;
  const h = m.useHoldAction(() => { calls += 1; }, { durationMs: 60 });
  h.onKeydown(fakeKey(' ', true)); // repeat=true 忽略
  assert.equal(h.holding.value, false, 'repeat keydown 不应启动');
  h.onKeydown(fakeKey(' '));
  assert.equal(h.holding.value, true, 'Space 按下应启动');
  h.onKeyup(fakeKey(' '));
  assert.equal(h.holding.value, false, '提前 keyup 应取消');
  await pump();
  assert.equal(calls, 0, '提前 keyup 不应触发');
  h.onKeydown(fakeKey('Enter'));
  await pump();
  assert.equal(calls, 1, `Enter 按住满时长应触发（实际 ${calls} 次）`);
  h.resetHold();
});

await check('B6 键盘长按中 onBlur → 取消，满等效时长不触发（P3 blur 补做）', async () => {
  const m = await loadHold();
  if (!m) throw new Error('use-hold-action 模块不存在');
  let calls = 0;
  const h = m.useHoldAction(() => { calls += 1; }, { durationMs: 60 });
  h.onKeydown(fakeKey(' '));
  assert.equal(h.holding.value, true, 'Space 按下应启动');
  h.onBlur(); // 焦点被夺走，keyup 不会回到按钮
  h.onBlur(); // 重复 blur 不产生重复回调（resetHold 幂等）
  assert.equal(h.holding.value, false, 'blur 应取消长按');
  // 泵帧 480ms ≫ durationMs=60：满等效时长（真实 1s 档即 ~1100ms 语义）跨过仍不触发
  await pump();
  assert.equal(calls, 0, `blur 取消后满等效时长不应触发（实际 ${calls} 次）`);
});

await check('B7 满时长触发后 resetHold 幂等——doneTimer 窗口内取消不二次触发（B2 的互补路径）', async () => {
  const m = await loadHold();
  if (!m) throw new Error('use-hold-action 模块不存在');
  let calls = 0;
  const h = m.useHoldAction(() => { calls += 1; }, { durationMs: 60 });
  h.onKeydown(fakeKey(' '));
  await pumpUntil(() => calls >= 1);
  assert.equal(calls, 1, `满时长应恰好触发一次（实际 ${calls} 次）`);
  h.resetHold(); // 对应 sending 翻 false 恰逢满时长完成的边界：清掉已排的 doneTimer
  h.resetHold(); // 重复 reset 幂等：不抛错不重复触发
  await pump();
  assert.equal(calls, 1, `resetHold 幂等，不应二次触发（实际 ${calls} 次）`);
});

// window stub：捕获 addEventListener 注册的回调（useHoldAction 在调用时才读 window）。
type WinCb = (...args: unknown[]) => void;
let winListeners: Record<string, WinCb[]> = {};
function installWindowStub(): void {
  winListeners = {};
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: (type: string, cb: WinCb) => { (winListeners[type] ??= []).push(cb); },
    removeEventListener: (type: string, cb: WinCb) => {
      winListeners[type] = (winListeners[type] ?? []).filter((f) => f !== cb);
    },
  };
}
function uninstallWindowStub(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
}
function dispatchWindowEvent(type: string): void {
  for (const cb of [...(winListeners[type] ?? [])]) cb();
}

await check('B8 窗口失焦（window blur 监听）→ 长按取消，满等效时长不触发（清零轮 A 项）', async () => {
  const m = await loadHold();
  if (!m) throw new Error('use-hold-action 模块不存在');
  installWindowStub();
  try {
    let calls = 0;
    const h = m.useHoldAction(() => { calls += 1; }, { durationMs: 60 });
    assert.ok((winListeners['blur'] ?? []).length >= 1, 'useHoldAction setup 未注册 window blur 监听');
    h.onPointerDown(fakePointer()); // 指针长按：@pointerdown.prevent 下按钮不持焦，Alt+Tab 时
    // 元素 blur 不会派发——只有 window blur 监听能覆盖该路径（A 项收口点）
    assert.equal(h.holding.value, true, '按住后 holding 应为 true');
    dispatchWindowEvent('blur'); // 手动派发捕获到的 blur 回调（模拟窗口失焦）
    assert.equal(h.holding.value, false, 'window blur 应取消长按');
    dispatchWindowEvent('blur'); // 重复 blur：resetHold 幂等不产生重复回调
    await pump(); // 泵帧 480ms ≫ durationMs=60（满等效时长语义）
    assert.equal(calls, 0, `window blur 取消后满等效时长不应触发（实际 ${calls} 次）`);
  } finally {
    uninstallWindowStub();
  }
});

await check('B9 watch 行为复刻 SessionToolbar 接线：长按进行中 sending 翻 false → 取消不触发（清零轮 B 项）', async () => {
  const m = await loadHold();
  if (!m) throw new Error('use-hold-action 模块不存在');
  const { watch, ref, nextTick } = await import('vue');
  let calls = 0;
  const h = m.useHoldAction(() => { calls += 1; }, { durationMs: 60 });
  const sending = ref(true);
  watch(() => sending.value, (v) => { if (!v) h.resetHold(); }); // 与 SessionToolbar.vue 同款接线
  h.onKeydown(fakeKey(' '));
  assert.equal(h.holding.value, true, 'Space 按下应启动');
  sending.value = false; // 回合自然结束（长按仍在进行中）
  await nextTick(); // watch 默认 pre flush：调度器微任务队列，nextTick 后回调已执行
  assert.equal(h.holding.value, false, 'sending 翻 false 应经 watch 取消长按');
  await pump(); // 泵帧 480ms ≫ durationMs=60：原会迟发幽灵 abort 的窗口
  assert.equal(calls, 0, `watch 取消后不应触发 abort（实际 ${calls} 次）`);
});

await check('B10 满时长完成后同 tick sending 翻 false → 不二次触发（B7 doneTimer 路径的 watch 接线版）', async () => {
  const m = await loadHold();
  if (!m) throw new Error('use-hold-action 模块不存在');
  const { watch, ref, nextTick } = await import('vue');
  let calls = 0;
  const h = m.useHoldAction(() => { calls += 1; }, { durationMs: 60 });
  const sending = ref(true);
  watch(() => sending.value, (v) => { if (!v) h.resetHold(); });
  h.onKeydown(fakeKey(' '));
  await pumpUntil(() => calls >= 1);
  assert.equal(calls, 1, `满时长应恰好触发一次（实际 ${calls} 次）`);
  sending.value = false; // 恰逢满时长完成后同 tick 翻 false（doneTimer 已排）
  await nextTick();
  assert.equal(calls, 1, 'watch 取消不应重复触发已完成的 onComplete');
  await pump(); // 跨过 150ms doneTimer 窗口
  assert.equal(calls, 1, `doneTimer 已被 watch 清掉，不应二次触发（实际 ${calls} 次）`);
});

console.log('\n=== C 组 · SessionToolbar.vue 接入契约 ===');

await check('C1 title 常驻「长按 1 秒中断」', () => {
  assert.ok(toolbarSrc!.includes('title="长按 1 秒中断"'), '中断按钮缺常驻 title');
});

await check('C2 指针五件套 + 键盘两件接入；pointerdown 带 .prevent 吃原生 click', () => {
  for (const binding of [
    '@pointerdown.prevent="onAbortPointerDown"',
    '@pointermove="onAbortPointerMove"',
    '@pointerup="onAbortPointerUp"',
    '@pointerleave="onAbortPointerLeave"',
    '@pointercancel="onAbortPointerCancel"',
    '@keydown="onAbortKeydown"',
    '@keyup="onAbortKeyup"',
  ]) {
    assert.ok(toolbarSrc!.includes(binding), `中断按钮缺绑定 ${binding}`);
  }
});

await check('C3 内层进度填充 span：width 绑定 holdProgress', () => {
  assert.ok(toolbarSrc!.includes('ctl__abort-fill'), '缺内层进度填充 span');
  assert.ok(/width: `\$\{abortHoldProgress\}%`/.test(toolbarSrc!), '填充宽度未绑定 abortHoldProgress');
  const fill = toolbarSrc!.match(/\.ctl__abort-fill\s*\{[^}]*\}/)?.[0] ?? '';
  assert.ok(fill.includes('color-mix'), '填充未用 color-mix');
});

await check('C4 holding 态可视反馈：.ctl__btn--abort-holding 规则存在', () => {
  assert.ok(/\.ctl__btn--abort-holding\s*\{[^}]*\}/.test(toolbarSrc!), '缺 holding 态样式规则');
  assert.ok(/'ctl__btn--abort-holding': abortHolding/.test(toolbarSrc!), 'holding class 未按 abortHolding 切换');
});

await check('C5 旧单击路径移除：@click="emit(\'abort\')" 不存在；emit(\'abort\') 仍由长按完成触发', () => {
  assert.ok(!toolbarSrc!.includes("@click=\"emit('abort')\""), '旧单击 @click 仍在（单击会立即中断）');
  assert.ok(toolbarSrc!.includes("useHoldAction(() => emit('abort'))"), "长按完成回调缺 emit('abort')");
});

await check('C6 sending 翻 false 防幽灵中断：resetHold 解构 + watch 取消 + @blur 绑定（P2/P3 静态钉）', () => {
  assert.ok(toolbarSrc!.includes('resetHold: resetAbortHold'), '解构缺 resetHold: resetAbortHold');
  assert.ok(toolbarSrc!.includes('onBlur: onAbortBlur'), '解构缺 onBlur: onAbortBlur');
  assert.ok(
    toolbarSrc!.includes('watch(() => props.sending, (v) => { if (!v) resetAbortHold(); });'),
    '缺 sending 翻 false → resetAbortHold 的 watch（node 侧无组件实例不驱动 Vue watch，以静态钉覆盖）',
  );
  assert.ok(toolbarSrc!.includes('@blur="onAbortBlur"'), '中断按钮缺 @blur 绑定');
});

await check('C7 .ctl__abort-fill 圆角随按钮裁剪（border-radius: inherit）', () => {
  const fill = toolbarSrc!.match(/\.ctl__abort-fill\s*\{[^}]*\}/)?.[0] ?? '';
  assert.ok(fill, '缺 .ctl__abort-fill 样式块');
  assert.ok(fill.includes('border-radius: inherit'), '进度填充缺 border-radius: inherit（圆角按钮下左右露直角）');
});

console.log('\n=== D 组 · ChatPage.vue Esc 急停分流契约 ===');

await check('D1 window keydown 监听注册/卸载成对', () => {
  assert.ok(chatPageSrc!.includes("window.addEventListener('keydown', onGlobalKeydown)"), '缺 window keydown 注册');
  assert.ok(chatPageSrc!.includes("window.removeEventListener('keydown', onGlobalKeydown)"), '缺 window keydown 卸载');
});

await check('D2 Esc + sending 守卫 + 桥接只读让位 + abort 调用', () => {
  const fn = chatPageSrc!.match(/function onGlobalKeydown[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(fn, '缺 onGlobalKeydown');
  assert.ok(fn.includes("'Escape'"), '未过滤 Escape');
  assert.ok(fn.includes('sending.value'), '未守卫 sending');
  assert.ok(fn.includes('bridgeLocked.value'), '桥接只读会话未让位（桌面无急停通道）');
  assert.ok(fn.includes('abort()'), '未调用 abort');
});

await check('D3 分层避让：交互弹窗/双 diff 弹窗/灯箱状态单例 + 菜单/遮罩 DOM 探测', () => {
  const fn = chatPageSrc!.match(/function escConsumerOpen[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(fn, '缺 escConsumerOpen 避让判定');
  for (const needle of [
    'visibleRequestsForActiveSession',
    'diffDialogState.value',
    'toolDiffDialogState.value',
    'imageLightboxState.value',
    "'.slash-menu'",
    "'.menu, .perm-menu, .tl-menu, .cascade'",
    "'.export-overlay'",
  ]) {
    assert.ok(fn.includes(needle), `避让判定缺 ${needle}`);
  }
});

await check('D4 IME 组合态守卫：isComposing/keyCode 229 不触发急停（review R1-P2）', () => {
  const fn = chatPageSrc!.match(/function onGlobalKeydown[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(
    /if \(e\.isComposing \|\| e\.keyCode === 229\) return;/.test(fn),
    '缺 IME 组合态守卫（中文输入法 Esc 取消组词会冒泡成急停误触发中断）',
  );
});

await check('D5 AppHeader 重命名 Esc 阻断冒泡（review R1-P3：唯一漏网 Esc 消费者）', () => {
  assert.ok(appHeaderSrc, 'src/renderer/components/layout/AppHeader.vue 不存在');
  assert.ok(
    appHeaderSrc.includes('@keydown.esc.stop="cancelEdit"'),
    '重命名输入 Esc 未阻断冒泡（sending 中重命名按 Esc 会误触发中断）',
  );
});

await check('D6 E2E 中断场景改用长按模拟：三脚本弃 .click()（review R1-P2 断链修复）', () => {
  for (const [label, src] of [['cdp-real-window-e2e', e2eRealSrc], ['cdp-context-e2e', e2eContextSrc], ['context-research-harness', e2eHarnessSrc]]) {
    assert.ok(src, `${label}.mjs 不存在`);
    assert.ok(!src.includes("ctl__btn--abort')?.click()"), `${label} 仍在用 .click() 触发中断（长按交互下永不 abort）`);
    assert.ok(src.includes("new PointerEvent('pointerdown'"), `${label} 缺 pointerdown 长按派发`);
    assert.ok(src.includes("new PointerEvent('pointerup'"), `${label} 缺 pointerup 收尾派发`);
    assert.ok(src.includes('setTimeout(r, 1200)'), `${label} 缺 1.2s 长按等待（>1s 阈值）`);
  }
});

await check('D7 选择器 document 级 Esc preventDefault 双保险（review R3-P3 观察收口：不再单靠 DOM 探测兜底）', () => {
  const tlSrc = readIfExists('../src/renderer/components/chat/ThinkingLevelSelector.vue');
  const pmSrc = readIfExists('../src/renderer/components/chat/ProviderModelSelector.vue');
  assert.ok(tlSrc, 'ThinkingLevelSelector.vue 不存在');
  assert.ok(pmSrc, 'ProviderModelSelector.vue 不存在');
  const tlFn = tlSrc!.match(/function handleEscape[\s\S]{0,400}?\n\}/)?.[0] ?? '';
  assert.ok(
    /event\.preventDefault\(\)/.test(tlFn) && /showMenu\.value = false/.test(tlFn),
    'ThinkingLevelSelector handleEscape 消费 Esc 时未 preventDefault（菜单开时 Esc 应标记已消费，双保险急停避让）',
  );
  const pmFn = pmSrc!.match(/function handleEscape[\s\S]{0,400}?\n\}/)?.[0] ?? '';
  assert.ok(
    /event\.preventDefault\(\)/.test(pmFn) && /close\(\)/.test(pmFn),
    'ProviderModelSelector handleEscape 消费 Esc 时未 preventDefault（菜单开时 Esc 应标记已消费，双保险急停避让）',
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
}

void main();
