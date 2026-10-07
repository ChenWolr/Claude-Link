// tdd-provider-store-error-outlet-verify.ts
// X15（R02-F2，P3）契约钉：providerStore.error 必须有用户可见出口，设置页空态须区分
// 「加载失败」与「真空库」两态。
//
// 根因（复核 CONFIRMED）：provider-store.load() 失败仅置 this.error（providers 保持 []），
// 该 error 全仓唯一消费点是 ProviderModelSelector.vue:59 的 hb10-PRV-02 防误跳守卫（静默
// return）——设置页 ProviderManager 两处空态（左栏 plist-empty / 详情 empty 卡）均不检查
// store.error，拉取失败时误显「还没有供应商」引导用户重复建档；会话页选择器触发器点击
// 静默 no-op。上轮 D02-F8 已为 sessionStore.error 建了 App.vue 全局 3.5s toast（A4 模式，
// commit 6098959），providerStore.error 是同构未修面。
//
// 修复语义（本点钉住）：
// ① App.vue 新增 watch(() => providerStore.error)——与 A4 sessionStore.error 同款 3.5s
//    全局错误 toast：文案「操作失败：<截断至 80 字符>」，复用 A4 的 SESSION_ERROR_TOAST_MS /
//    SESSION_ERROR_TEXT_MAX 常量与 .global-toast--error 样式（本点文件白名单收窄，不另建
//    共享常量文件，同文件复用即单源）；空值不弹（成功路径零打扰）；onBeforeUnmount 清理计时器。
// ② ProviderManager 两处空态在 store.error 非空时改显「供应商加载失败，请重试」（文案-only：
//    组件内无既有 load 重试按钮/下拉刷新链，重试入口 = 重进设置页重挂载 ensureLoaded）；
//    真空库文案原样保留（不回归）。
//
// 运行：npx tsx scripts/tdd-provider-store-error-outlet-verify.ts（已登记 scripts/selftest-static-list.txt）

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const appVue = read('../src/renderer/App.vue');
const providerManager = read('../src/renderer/components/providers/ProviderManager.vue');
const providerStore = read('../src/renderer/stores/provider-store.ts');
const selftestList = read('selftest-static-list.txt');

// 提取 Vue SFC 内指定 watch 回调体（从 watch 源行到顶格 }); 结束——与既有代码形态匹配）。
// 未找到时返回 null，由各 check 自行断言（红阶段逐项记失败而非崩溃）。
function extractWatchBody(src: string, watchSource: string): string | null {
  const startIdx = src.indexOf(watchSource);
  if (startIdx === -1) return null;
  const endIdx = src.indexOf('\n});', startIdx);
  if (endIdx === -1) return null;
  return src.slice(startIdx, endIdx);
}

console.log('\n=== X15-① App.vue：providerStore.error 全局 toast 出口（A4 同构） ===');
check('引入并实例化 useProviderStore（watch 有源可挂）', () => {
  assert.ok(
    appVue.includes("import { useProviderStore } from './stores/provider-store';"),
    '缺少 useProviderStore import',
  );
  assert.ok(appVue.includes('const providerStore = useProviderStore();'), '缺少 providerStore 实例化');
});
const providerErrorWatch = extractWatchBody(appVue, 'watch(() => providerStore.error, (err) => {');
check('watch(() => providerStore.error, ...) 存在（R02-F2 出口主体）', () => {
  assert.ok(providerErrorWatch !== null, 'watch(() => providerStore.error) 缺失（load 失败仍零全局出口）');
});
check('watch 回调空值守卫 if (!err) return——成功路径零打扰（load() 开头清 error 不弹）', () => {
  assert.ok(providerErrorWatch !== null && providerErrorWatch.includes('if (!err) return;'), '空值守卫缺失（error 清空路径会误弹）');
});
check('toast 文案前缀「操作失败：」+ 截断至 SESSION_ERROR_TEXT_MAX（复用 A4 截断常量，同文件单源）', () => {
  assert.ok(providerErrorWatch !== null && providerErrorWatch.includes('操作失败：'), '文案前缀「操作失败：」缺失');
  assert.ok(
    providerErrorWatch !== null && providerErrorWatch.includes('SESSION_ERROR_TEXT_MAX'),
    '未复用 A4 的 SESSION_ERROR_TEXT_MAX 截断常量（复制常量会分叉漂移）',
  );
  assert.ok(providerErrorWatch !== null && providerErrorWatch.includes('.slice('), '超长截断 slice 缺失');
});
check('toast 时长复用 SESSION_ERROR_TOAST_MS（3.5s，A4 同款节奏）', () => {
  assert.ok(
    providerErrorWatch !== null && providerErrorWatch.includes('SESSION_ERROR_TOAST_MS'),
    '未复用 A4 的 SESSION_ERROR_TOAST_MS 常量',
  );
});
check('连续失败以最新文案重置计时（setTimeout 前 clearTimeout）', () => {
  assert.ok(providerErrorWatch !== null && providerErrorWatch.includes('clearTimeout(providerErrorToastTimer)'), 'clearTimeout 缺失（旧计时器不清会提前隐藏新 toast）');
});
check('模板含 providerErrorToastVisible 的 toast 节点且复用 .global-toast--error 样式', () => {
  const toastLine = appVue.split('\n').find((l) => l.includes('v-if="providerErrorToastVisible"'));
  assert.ok(toastLine, 'toast 模板节点缺失');
  assert.ok(toastLine.includes('global-toast--error'), '未复用 global-toast--error 样式类');
  assert.ok(toastLine.includes('{{ providerErrorToastText }}'), 'toast 未绑定 providerErrorToastText');
});
check('三档 toast 纵向错开（供应商错误 toast 不与保存失败/会话错误 toast 同位重叠）', () => {
  const toastLine = appVue.split('\n').find((l) => l.includes('v-if="providerErrorToastVisible"'));
  assert.ok(toastLine, 'toast 模板节点缺失');
  assert.ok(
    toastLine.includes('global-toast--stacked'),
    '供应商错误 toast 须带 stacked 错位类（默认 top:1rem 与保存失败 toast 重叠）',
  );
  assert.ok(appVue.includes('global-toast--stacked-3'), '第三档错位样式类 .global-toast--stacked-3 缺失');
});
check('onBeforeUnmount 清理 providerErrorToastTimer（不留悬挂计时器）', () => {
  const unmountIdx = appVue.indexOf('onBeforeUnmount(');
  assert.ok(unmountIdx !== -1, 'onBeforeUnmount 缺失');
  // watch 回调内也有同款 clearTimeout（连续失败重置计时），此处只认卸载段内的那一次。
  assert.ok(
    appVue.slice(unmountIdx).includes('clearTimeout(providerErrorToastTimer)'),
    'providerErrorToastTimer 清理须在 onBeforeUnmount 内',
  );
});

console.log('\n=== X15-② ProviderManager.vue：空态区分「加载失败 / 真空库」两态 ===');
check('store.error 有消费（本文件此前零 error 消费——出现即为本点接线）', () => {
  const count = (providerManager.match(/store\.error/g) || []).length;
  assert.ok(count >= 2, `store.error 消费点 ${count} 处 <2（左栏空态 + 详情空卡均须区分）`);
});
check('左栏空态（providers.length === 0）含 store.error 分支与「供应商加载失败，请重试」文案', () => {
  const line = providerManager.split('\n').find((l) => l.includes('v-if="providers.length === 0"'));
  assert.ok(line, '左栏空态 v-if="providers.length === 0" 行缺失（形态漂移）');
  assert.ok(line.includes('store.error'), '左栏空态未检查 store.error（失败态仍显空库引导）');
  assert.ok(line.includes('供应商加载失败，请重试'), '左栏空态缺「供应商加载失败，请重试」文案');
});
check('详情空卡同样区分（v-if="store.error" 分支显失败文案）', () => {
  assert.ok(
    providerManager.includes('v-if="store.error"'),
    '详情空卡缺 store.error 分支',
  );
  const count = (providerManager.match(/供应商加载失败，请重试/g) || []).length;
  assert.equal(count, 2, `「供应商加载失败，请重试」出现 ${count} 处，预期 2（左栏 + 详情）`);
});
check('真空库引导文案原样保留（失败分支不吞真空态语义）', () => {
  assert.ok(
    providerManager.includes('还没有供应商，点上方「新建供应商」创建。'),
    '左栏真空态文案「还没有供应商，点上方…」被移除（真空引导回归）',
  );
  assert.ok(
    providerManager.includes('还没有供应商。点左侧'),
    '详情真空态文案「还没有供应商。点左侧…」被移除（真空引导回归）',
  );
});

console.log('\n=== X15-③ 前提钉：provider-store 的 error 通道语义（出口的供电源） ===');
check('load() 失败置 this.error（catch 分支）、进入时清位（this.error = null 在 try 前）', () => {
  const loadIdx = providerStore.indexOf('async load()');
  assert.ok(loadIdx !== -1, 'load() 函数缺失（形态漂移）');
  const loadBody = providerStore.slice(loadIdx, providerStore.indexOf('},', loadIdx));
  const clearIdx = loadBody.indexOf('this.error = null;');
  const tryIdx = loadBody.indexOf('try {');
  const setIdx = loadBody.indexOf('this.error = error instanceof Error');
  assert.ok(clearIdx !== -1 && tryIdx !== -1 && clearIdx < tryIdx, 'this.error = null 须在 try 前（成功路径清位，watch 不误弹）');
  assert.ok(setIdx !== -1, 'catch 分支置 this.error 缺失（失败无源可弹）');
});

console.log('\n=== X15-④ selftest 清单登记 ===');
check('selftest-static-list.txt 已登记本脚本', () => {
  assert.ok(
    selftestList.includes('scripts/tdd-provider-store-error-outlet-verify.ts'),
    '清单未登记（尾部追加一行）',
  );
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
