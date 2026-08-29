// tdd-thinking-scroll-verify.ts
// 思考过程展开态内滚动窗口 TDD 验证脚本，两部分：
//   L1–L12  逻辑用例——follow-scroll.ts「贴底跟随」状态机（普通对象模拟 ScrollBox，node 里确定性跑）；
//   C1–C14  源码契约——ThinkingBlock.vue 接线/样式结构文本契约（readFileSync 断言）。
// 运行：npx tsx scripts/tdd-thinking-scroll-verify.ts（已挂 package.json selftest:static 链尾）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFollowController, distanceFromBottom, FOLLOW_THRESHOLD_PX, type ScrollBox } from '../src/renderer/utils/follow-scroll';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

// ScrollBox 形状的普通对象工厂（jsdom 无布局，纯对象模拟才能确定性断言）
function makeBox(scrollTop: number, scrollHeight: number, clientHeight: number): ScrollBox {
  return { scrollTop, scrollHeight, clientHeight };
}

console.log('\n=== L1–L12 · follow-scroll 贴底跟随状态机（逻辑用例） ===');

check('L1 距底计算：box{scrollTop:400,scrollHeight:1000,clientHeight:500} → dist=100', () => {
  assert.equal(distanceFromBottom(makeBox(400, 1000, 500)), 100);
});

check('L2 负值钳制：scrollTop=700 → dist=0（不出现负距底）', () => {
  assert.equal(distanceFromBottom(makeBox(700, 1000, 500)), 0);
});

check('L3 初始态：live=false、stick=true', () => {
  const ctrl = createFollowController(makeBox(0, 0, 0));
  assert.equal(ctrl.live, false);
  assert.equal(ctrl.stick, true);
});

check('L4 非 live 不滚：onContentGrown 后 box.scrollTop 不变（0→0）', () => {
  const box = makeBox(0, 100, 100);
  const ctrl = createFollowController(box);
  box.scrollHeight = 900; // 内容涨高
  ctrl.onContentGrown();
  assert.equal(box.scrollTop, 0);
});

check('L5 live+贴底跟随：setLive(true) 后 scrollHeight 涨到 1000，onContentGrown → scrollTop=1000', () => {
  const box = makeBox(0, 600, 100);
  const ctrl = createFollowController(box);
  ctrl.setLive(true);
  box.scrollHeight = 1000;
  ctrl.onContentGrown();
  assert.equal(box.scrollTop, 1000);
});

check('L6 上滚不被拽：live 且用户上滚到 dist=100（stick=false），scrollHeight 再涨 200，scrollTop 仍 500', () => {
  const box = makeBox(600, 700, 100); // 贴底：dist=0
  const ctrl = createFollowController(box);
  ctrl.setLive(true);
  box.scrollTop = 500; // 用户上滚：dist=700-500-100=100
  ctrl.onUserScroll();
  assert.equal(ctrl.stick, false);
  box.scrollHeight = 900; // 内容再涨 200
  ctrl.onContentGrown();
  assert.equal(box.scrollTop, 500);
});

check('L7 阈值边界：FOLLOW_THRESHOLD_PX=32；dist=31 → stick=true，dist=32 → stick=false（语义 dist<threshold）', () => {
  assert.equal(FOLLOW_THRESHOLD_PX, 32);
  const box = makeBox(469, 1000, 500); // dist=31
  const ctrl = createFollowController(box);
  ctrl.onUserScroll();
  assert.equal(ctrl.stick, true);
  box.scrollTop = 468; // dist=32
  ctrl.onUserScroll();
  assert.equal(ctrl.stick, false);
});

check('L8 setLive 重置：先滚到 stick=false，setLive(true) → stick=true', () => {
  const box = makeBox(0, 1000, 500); // dist=500
  const ctrl = createFollowController(box);
  ctrl.onUserScroll();
  assert.equal(ctrl.stick, false);
  ctrl.setLive(true);
  assert.equal(ctrl.stick, true);
});

check('L9 完成即静默：setLive(false) 后 pillVisible() 恒 false（含 stick=false 时）', () => {
  const box = makeBox(500, 1000, 100); // dist=400
  const ctrl = createFollowController(box);
  ctrl.setLive(true);
  ctrl.onUserScroll();
  assert.equal(ctrl.pillVisible(), true);
  ctrl.setLive(false);
  assert.equal(ctrl.pillVisible(), false);
  // 即便此刻仍离底（stick=false）也不显示浮标
  ctrl.onUserScroll();
  assert.equal(ctrl.stick, false);
  assert.equal(ctrl.pillVisible(), false);
});

check('L10 浮标四象限：pillVisible = live && !stick 逐一断言', () => {
  // (live=false, stick=true) 默认
  const a = createFollowController(makeBox(0, 0, 0));
  assert.equal(a.pillVisible(), false);
  // (live=false, stick=false)
  const b = createFollowController(makeBox(0, 1000, 100));
  b.onUserScroll();
  assert.equal(b.stick, false);
  assert.equal(b.pillVisible(), false);
  // (live=true, stick=true)
  const c = createFollowController(makeBox(0, 0, 0));
  c.setLive(true);
  assert.equal(c.pillVisible(), false);
  // (live=true, stick=false)
  const d = createFollowController(makeBox(500, 1000, 100));
  d.setLive(true);
  d.onUserScroll();
  assert.equal(d.pillVisible(), true);
});

check('L11 浮标点击：上滚后 jumpToLatest → scrollTop=scrollHeight 且 stick=true → pillVisible=false', () => {
  const box = makeBox(500, 1000, 100);
  const ctrl = createFollowController(box);
  ctrl.setLive(true);
  ctrl.onUserScroll();
  assert.equal(ctrl.pillVisible(), true);
  ctrl.jumpToLatest();
  assert.equal(box.scrollTop, 1000);
  assert.equal(ctrl.stick, true);
  assert.equal(ctrl.pillVisible(), false);
});

check('L12 隐藏元素安全：box 全 0（display:none 语义）dist=0，onContentGrown/jumpToLatest/onUserScroll 不抛错', () => {
  const box = makeBox(0, 0, 0);
  assert.equal(distanceFromBottom(box), 0);
  const ctrl = createFollowController(box);
  ctrl.setLive(true);
  assert.doesNotThrow(() => ctrl.onContentGrown());
  assert.doesNotThrow(() => ctrl.onUserScroll());
  assert.doesNotThrow(() => ctrl.jumpToLatest());
});

// ── C1–C14 · ThinkingBlock.vue 源码契约（结构文本断言，沿用项目 check() 惯例） ──

const src = readFileSync(join(__dirname, '../src/renderer/components/chat/ThinkingBlock.vue'), 'utf8');

// .think-row__body 主规则块（\s*\{ 保证不误伤 ::-webkit-scrollbar / :focus-visible / :deep 等衍生选择器）
const bodyRule = src.match(/\.think-row__body\s*\{([^}]*)\}/)?.[1] ?? '';
// 模板里 body 元素的开标签（属性跨行，[^>] 可跨行匹配）
const bodyTag = src.match(/<div\s[^>]*?class="think-row__body[^>]*>/)?.[0] ?? '';
function windowFrom(needle: string, span: number): string {
  const idx = src.indexOf(needle);
  return idx < 0 ? '' : src.slice(idx, idx + span);
}

console.log('\n=== C1–C14 · ThinkingBlock.vue 内滚动窗口源码契约 ===');

check('C1 窗口封顶：.think-row__body 规则含 max-height: clamp(180px, 45vh, 460px)', () => {
  assert.ok(bodyRule.includes('max-height: clamp(180px, 45vh, 460px)'), `body 规则块实际为：${bodyRule.trim()}`);
});

check('C2 内滚动：.think-row__body 规则含 overflow-y: auto', () => {
  assert.ok(bodyRule.includes('overflow-y: auto'), `body 规则块实际为：${bodyRule.trim()}`);
});

check('C3 链式滚动显式：.think-row__body 规则含 overscroll-behavior: auto', () => {
  assert.ok(bodyRule.includes('overscroll-behavior: auto'), `body 规则块实际为：${bodyRule.trim()}`);
});

check('C4 键盘可达：body 元素含 tabindex="0"、role="region"、aria-label 含「思考过程」', () => {
  assert.ok(bodyTag.length > 0, '未找到 .think-row__body 开标签');
  assert.ok(bodyTag.includes('tabindex="0"'), `body 开标签缺 tabindex="0"：${bodyTag}`);
  assert.ok(bodyTag.includes('role="region"'), `body 开标签缺 role="region"：${bodyTag}`);
  assert.ok(bodyTag.includes('思考过程'), `body 开标签 aria-label 未含「思考过程」：${bodyTag}`);
});

check('C5 常驻 DOM 契约保活：v-show="open"、:id="bodyId"、v-html="rendered"、useId、aria-controls、:aria-expanded="open" 原样存在', () => {
  for (const needle of ['v-show="open"', ':id="bodyId"', 'v-html="rendered"', 'useId', 'aria-controls', ':aria-expanded="open"']) {
    assert.ok(src.includes(needle), `缺少 ${needle}`);
  }
});

check('C6 浮标接线：.think-row__pill 按钮 + @click 绑定 onPillClick + 文案含「回到最新」', () => {
  assert.ok(src.includes('class="think-row__pill"'), '缺 .think-row__pill 按钮');
  assert.ok(/class="think-row__pill"[^>]*@click="onPillClick"/.test(src) || /@click="onPillClick"[^>]*class="think-row__pill"/.test(src), '浮标未绑定 onPillClick');
  assert.ok(src.includes('回到最新'), '浮标文案缺「回到最新」');
});

check('C7 渐隐接线：data-fade-top/bottom 绑定 + ::before/::after 渐变用 var(--color-bg)，且不写死 #F8F4ED', () => {
  assert.ok(src.includes(':data-fade-top='), '缺 :data-fade-top 绑定');
  assert.ok(src.includes(':data-fade-bottom='), '缺 :data-fade-bottom 绑定');
  assert.ok(/\.think-row__win::before\s*\{[^}]*linear-gradient\(\s*var\(--color-bg\)\s*,\s*transparent\s*\)/.test(src), '::before 顶部渐变未用 var(--color-bg)');
  assert.ok(/\.think-row__win::after\s*\{[^}]*linear-gradient\(\s*transparent\s*,\s*var\(--color-bg\)\s*\)/.test(src), '::after 底部渐变未用 var(--color-bg)');
  assert.ok(!src.replace(/\/\*[\s\S]*?\*\//g, '').includes('#F8F4ED'), '渐变色写死了 #F8F4ED（必须走主题令牌）');
});

check('C8 reduced-motion：含 @media (prefers-reduced-motion: reduce) 且覆盖 pill/渐隐 transition', () => {
  const media = windowFrom('@media (prefers-reduced-motion: reduce)', 400);
  assert.ok(media, '缺 prefers-reduced-motion 媒体查询');
  assert.ok(media.includes('.think-row__pill'), '媒体查询未覆盖浮标');
  assert.ok(media.includes('.think-row__win::before'), '媒体查询未覆盖顶部渐隐');
  assert.ok(media.includes('transition: none'), '媒体查询未关闭 transition');
});

check('C9 旧契约保活：字面 line-height: 1.5 仍在 .think-row__body', () => {
  assert.ok(/line-height:\s*1\.5/.test(bodyRule), `body 规则块实际为：${bodyRule.trim()}`);
});

check('C10 props 不变：五项 props 签名字符串原样存在', () => {
  const sig = '{ content: string; streaming?: boolean; sealed?: boolean; defaultOpen?: boolean; exportMode?: boolean }';
  assert.ok(src.includes(sig), 'props 签名与原契约不一致');
});

check('C11 内容接线：watch(rendered 存在且体内含 nextTick 与 onContentGrown', () => {
  const w = windowFrom('watch(rendered', 400);
  assert.ok(w, '缺 watch(rendered');
  assert.ok(w.includes('nextTick'), 'watch(rendered 未先等 nextTick 再读 scrollHeight');
  assert.ok(w.includes('onContentGrown'), 'watch(rendered 未驱动 onContentGrown');
});

check('C12 流式接线：watch(active 存在且体内含 setLive', () => {
  const w = windowFrom('watch(active', 200);
  assert.ok(w, '缺 watch(active');
  assert.ok(w.includes('setLive'), 'watch(active 未切换 setLive');
});

check('C13 细滚动条：scrollbar-width: thin + ::-webkit-scrollbar width 8px', () => {
  assert.ok(bodyRule.includes('scrollbar-width: thin'), 'body 规则缺 scrollbar-width: thin');
  const webkit = src.match(/\.think-row__body::-webkit-scrollbar\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(webkit.includes('width: 8px'), `::-webkit-scrollbar 规则缺 width: 8px：${webkit.trim()}`);
});

check('C14 焦点环：.think-row__body:focus-visible 规则存在', () => {
  assert.ok(/\.think-row__body:focus-visible\s*\{[^}]*outline/.test(src), '缺 .think-row__body:focus-visible 焦点环');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
