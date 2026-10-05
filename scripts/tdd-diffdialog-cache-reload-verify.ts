// tdd-diffdialog-cache-reload-verify.ts
// A12（D10-F1，P2）契约钉：DiffDialog 打开期间回合结束 refresh(true) 清空 diffCache 的死态自愈。
//
// 根因：回合结束防抖 refresh(true) 全清 diffCache（changes-store.ts 全项目唯一调用点），
// 弹窗仍开着时 cached 变 undefined → isLoading=true → DiffBody 被 v-if 卸载，而全组件只有
// path / effectiveContext 两个 ensureDiff 触发点（两者均未变）→ 无任何 watcher 重拉，永久
// 「加载中」。changes-store.ts:87 注释「展开态改由 DiffDialog 自管」印证系遗漏（hb13-v B8
// 同类死态先例按 P2 修复）。恢复路径仅剩用户切文件/切上下文，完全不直观。
//
// 修复语义：DiffDialog 增加 watch(cached) 失效自愈——弹窗开着且缓存条目缺失（undefined）即
// 重新 ensureDiff（复用既有 in-flight 去重与代际守卫）；仅认 undefined：错误条目（{ok:false}）
// 已呈现错误态，自动重试会因每次失败写入新对象引用而无限循环；context 不匹配的成功缓存由
// effectiveContext watch 负责。ensureDiff 失败分支补写 {ok:false} 错误条目进 diffCache（保留
// CHG-V03 的 store.error 横幅写入），使弹窗呈现错误态而非永久 loading。
//
// 运行：npx tsx scripts/tdd-diffdialog-cache-reload-verify.ts
// （组1 为 vue 响应式迷你复刻：watch 是微任务 flush，用例一律 await nextTick 后断言。）

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { computed, nextTick, ref, watch } from 'vue';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const dialog = readFileSync(new URL('../src/renderer/components/changes/DiffDialog.vue', import.meta.url), 'utf8');
const store = readFileSync(new URL('../src/renderer/stores/changes-store.ts', import.meta.url), 'utf8');

type DiffResult =
  | { ok: true; diff: string; truncated: boolean; binary: boolean; context: number }
  | { ok: false; reason: string; message: string };

// 迷你复刻 DiffDialog 的 cached / isLoading / path watch 首拉 + 失效自愈 watch（与实施后
// 源码同构）；ensureDiff 以计数器 + 手工写回仿真。
function setupMiniDialog() {
  const diffCache = ref<Record<string, DiffResult>>({});
  const state = ref<{ path: string } | null>(null);
  const effectiveContext = ref(3);
  const ensureCalls: Array<{ path: string; context: number }> = [];
  let resolveNext: ((r: DiffResult) => void) | null = null;
  function request(path: string, context: number): void {
    ensureCalls.push({ path, context });
    resolveNext = (r) => { diffCache.value = { ...diffCache.value, [path]: r }; };
  }

  const cached = computed(() => (state.value ? diffCache.value[state.value.path] : undefined));
  const isLoading = computed(() => {
    if (!state.value) return false;
    const c = cached.value;
    if (!c) return true;
    if (!c.ok) return false;
    return c.context !== effectiveContext.value;
  });
  watch(
    () => state.value?.path,
    (p) => { if (p) request(p, effectiveContext.value); },
  );
  watch(cached, (c) => {
    if (!state.value?.path) return;
    if (c !== undefined) return;
    request(state.value.path, effectiveContext.value);
  });

  return { diffCache, state, effectiveContext, isLoading, get calls() { return ensureCalls; }, resolve: (r: DiffResult) => resolveNext?.(r) };
}

const OK3: DiffResult = { ok: true, diff: '@@', truncated: false, binary: false, context: 3 };

async function main(): Promise<void> {
  console.log('\n=== A12（D10-F1）：缓存失效自愈重拉 ===');
  console.log('\n=== 组1 行为级（vue 响应式迷你复刻：refresh(true) 死态消除） ===');
  await checkAsync('① 死态消除：清缓存 → cached 失效 → 自发重拉 → 写回 → isLoading 复位', async () => {
    const m = setupMiniDialog();
    m.state.value = { path: 'a.ts' };
    await nextTick();
    assert.equal(m.calls.length, 1, '打开经 path watch 触发首拉');
    m.resolve(OK3);
    await nextTick();
    assert.equal(m.isLoading.value, false, '前置：缓存有效不在加载');
    m.diffCache.value = {}; // 回合结束 refresh(true) 全清
    assert.equal(m.isLoading.value, true, '清缓存后进入加载态');
    await nextTick();
    assert.equal(m.calls.length, 2, 'cached 失效应自发重拉（死态根因即无此重拉）');
    m.resolve(OK3);
    await nextTick();
    assert.equal(m.isLoading.value, false, '写回后恢复显示（非永久加载中）');
  });
  await checkAsync('② 有效缓存/错误条目/context 不匹配的成功缓存均不触发额外重拉', async () => {
    const m = setupMiniDialog();
    m.state.value = { path: 'b.ts' };
    await nextTick();
    assert.equal(m.calls.length, 1, '首拉一次');
    m.resolve({ ...OK3, context: 3 });
    await nextTick();
    assert.equal(m.calls.length, 1, '有效缓存写回不触发');
    m.diffCache.value = { 'b.ts': { ...OK3, context: 5 } };
    await nextTick();
    assert.equal(m.calls.length, 1, 'context 不匹配的成功缓存：isLoading 兜底，不由此 watch 拉取');
  });
  await checkAsync('③ 弹窗关闭（state=null）后清缓存不发起重拉（守卫）', async () => {
    const m = setupMiniDialog();
    m.state.value = { path: 'c.ts' };
    await nextTick();
    assert.equal(m.calls.length, 1);
    m.state.value = null;
    m.diffCache.value = {};
    await nextTick();
    assert.equal(m.calls.length, 1, '关闭后清缓存不再重拉');
  });
  await checkAsync('④ 重拉失败写 {ok:false} 错误条目 → isLoading=false + 错误文案可见（非永久 loading）', async () => {
    const m = setupMiniDialog();
    m.state.value = { path: 'd.ts' };
    await nextTick();
    assert.equal(m.calls.length, 1);
    m.resolve({ ok: false, reason: 'git-error', message: 'git 不可用' }); // ensureDiff 失败补写错误条目
    await nextTick();
    assert.equal(m.isLoading.value, false, '错误态不算加载中');
    assert.equal((m.calls.filter((c) => c.path === 'd.ts').length), 1);
    void m.diffCache; // 错误文案经 cached.message 呈现（结构钉见组2）
  });
  await checkAsync('⑤ 失败后不再自发重试（cached watch 对非 undefined 早退，无死循环）', async () => {
    const m = setupMiniDialog();
    m.state.value = { path: 'e.ts' };
    await nextTick();
    m.resolve({ ok: false, reason: 'error', message: 'x' });
    await nextTick();
    await nextTick(); // 多轮微任务后仍无新增（新对象引用若未早退会无限触发）
    assert.equal(m.calls.length, 1);
  });

  console.log('\n=== 组2 结构契约（DiffDialog 接线 + store 失败条目） ===');
  check('⑥ DiffDialog 含 watch(cached) 失效自愈重拉（state 守卫 + 仅认 undefined + ensureDiff）', () => {
    const at = dialog.indexOf('watch(cached');
    assert.ok(at > -1, '缺 watch(cached) 接线');
    const body = dialog.slice(at, dialog.indexOf('});', at) + 3);
    assert.match(body, /if \(!state\.value\?\.path\) return;/, '缺弹窗关闭守卫');
    assert.match(body, /if \(c !== undefined\) return;/, '缺仅认 undefined 谓词（错误条目自动重试会无限循环）');
    assert.match(body, /changesStore\.ensureDiff\(state\.value\.path, effectiveContext\.value\)/, '缺重拉调用');
  });
  check('⑦ ensureDiff 失败补写 {ok:false} 错误条目（失败也进缓存 → 弹窗错误态）', () => {
    const at = store.indexOf('function ensureDiff');
    const body = store.slice(at, store.indexOf('\n  }', at));
    assert.match(body, /ok: false, reason: 'error'/, 'catch 分支缺错误条目写入');
    assert.match(store, /error\.value = err instanceof Error \? err\.message : '读取 diff 失败';/, 'CHG-V03 error 横幅写入保留（契约⑦兼容）');
  });
  check('⑧ 既有触发点不回归：path watch 与 effectiveContext watch 仍在', () => {
    assert.match(dialog, /watch\(\s*\(\) => state\.value\?\.path,/, '缺 path watch');
    assert.match(dialog, /watch\(effectiveContext,/, '缺 effectiveContext watch');
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
