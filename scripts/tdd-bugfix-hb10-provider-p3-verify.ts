// scripts/tdd-bugfix-hb10-provider-p3-verify.ts
// hb10 P3 PRV 批契约（PRV-02/03/04/05/06/07/V01/V04）。
// 编号正名（hb13-v A10，PM-04）：hb10-PRV-04（编辑 splice 原位）/PRV-05（persistModels
// 串行化）/PRV-06（手动输入预检+丢弃计数）是 hb10 计划 §4 PRV 批的三条独立项，本契约
// ⑦⑧⑨ 钉之；hb12 计划的 PRV-04/05/06 是重新编号后的另外三个问题（:key/归一化/键盘导航），
// 两套编号互不相干。hb10 计划真正并入他批的只有 PRV-08（→P2-6）与 PRV-V03（→P2-4）。
// 2026-09-13 一轮补救追加 ④：hb12 附录 C/PRV-V04 撤销恢复成功文案。
// 2026-09-13 二轮补救追加 ⑤⑥：hb12-PRV-03（drift current 增 providerId）、hb12-PRV-05
// （输出上限三处直出原值）——round2 验收 P2-A5/A3 判未实施。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-provider-p3-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeAnthropicModelsPayload, normalizeOpenAiModelsPayload } from '../src/main/modules/model-resolver';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const selector = read('src/renderer/components/chat/ProviderModelSelector.vue');
const resolver = read('src/main/modules/model-resolver.ts');
const backend = read('src/main/modules/sdk-backend.ts');
const manager = read('src/renderer/components/providers/ProviderManager.vue');
const modelList = read('src/renderer/components/providers/ProviderModelList.vue'); // 二轮补救：PRV-05
const modelPicker = read('src/renderer/components/providers/ProviderModelPicker.vue'); // 二轮补救：PRV-05
const configManager = read('src/main/modules/config-manager.ts'); // 三轮补救：hb10-PRV-04

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① PRV-02：三态。
check('① PRV-02：toggleOpen 三态（loading/error 不跳设置页）', () => {
  const idx = selector.indexOf('function toggleOpen()');
  const body = selector.slice(idx, idx + 700);
  assert.match(body, /if \(providerStore\.loading\) return;/, '缺 loading 守卫');
  assert.match(body, /if \(providerStore\.error\) return;/, '缺 error 守卫');
  const loadIdx = body.indexOf('if (providerStore.loading) return;');
  const libIdx = body.indexOf('if (!hasLibrary.value)');
  assert.ok(loadIdx < libIdx, '三态守卫必须先于库空跳转');
});

// ② PRV-03 + V01。
check('② PRV-03/V01：回退 watch immediate + 文案库外标注 + drift 首回合提示', () => {
  assert.match(selector, /\{ immediate: true \},/, '回退 watch 缺 immediate');
  assert.match(selector, /库外配置（老字段链）/, '回退文案未标注库外链');
  const driftIdx = backend.indexOf('function notifyDriftMessage(');
  assert.ok(driftIdx > -1, '缺 notifyDriftMessage 共享函数');
  assert.match(backend, /notifyDriftMessage\(sessionId, mainWindow, \{ providerName: null, modelId: '初始化' \}, current\);/, '首回合缺「初始化」提示');
});

// ③ PRV-07。
check('③ PRV-07：查询 15s 超时 + in-flight 去重（双击单请求）', () => {
  assert.match(resolver, /AbortSignal\.timeout\(15_000\)/, '缺 15s 超时');
  assert.match(resolver, /inflightFetches/, '缺 in-flight 表');
  const implIdx = resolver.indexOf('async function fetchAvailableModelsImpl');
  assert.ok(implIdx > resolver.indexOf('export function fetchAvailableModels'), '缺薄壳+Impl 拆分');
  assert.match(resolver, /\.finally\(\(\) => inflightFetches\.delete/, '缺 finally 清除');
});

// ④ hb12 附录 C/PRV-V04。
check('④ PRV-V04：restoreDeleted 成功分支补「已恢复到列表末尾」提示', () => {
  const idx = manager.indexOf('.restoreDeleted()');
  assert.ok(idx > -1, '缺 restoreDeleted 调用');
  const body = manager.slice(idx, idx + 400);
  assert.match(body, /已恢复到列表末尾/, 'restoreDeleted 成功分支缺恢复位置提示文案');
});

// ⑤ hb12-PRV-03（二轮补救）：drift current 增 providerId（resolveSessionModel 结果透传）。
check('⑤ PRV-03：notifyEffectiveConnectionDrift current 增 providerId 并透传', () => {
  assert.match(backend, /providerId: resolved\.provider\.id,/, 'resolveSessionOverride 缺透传 providerId');
  assert.match(
    backend,
    /const current = \{ providerName: override\?\.providerName \?\? null, modelId: override\?\.modelId \?\? null, providerId: override\?\.providerId \?\? null \};/,
    'current 缺 providerId',
  );
  assert.match(
    backend,
    /const sessionLastEffective = new Map<string, \{ providerName: string \| null; modelId: string \| null; providerId: string \| null \}>\(\);/,
    'sessionLastEffective 缺 providerId 字段',
  );
});

// ⑥ hb12-PRV-05（二轮补救）：输出上限三处直出原值（1024 除数取整误导）；级联加「输出上限」。
check('⑥ PRV-05：输出上限直出原值（Selector「输出上限」，List/Picker「out tok」）', () => {
  const OLD_DIVISOR = 'Math.floor(maxTokens / 1024)';
  assert.match(selector, /return maxTokens > 0 \? `\$\{maxTokens\}` : '';[\s\S]{0,10}\/\/ hb12-PRV-05|\/\/ hb12-PRV-05[\s\S]{0,120}return maxTokens > 0 \? `\$\{maxTokens\}` : '';/, 'Selector 缺直出原值');
  assert.match(selector, /输出上限 \{\{ formatCtx\(m\.maxTokens\) \}\}/, '级联缺「输出上限」标注');
  assert.match(modelList, /return maxTokens > 0 \? `\$\{maxTokens\} out tok` : '—';/, 'ModelList 缺直出+out tok');
  assert.match(modelPicker, /return maxTokens > 0 \? `\$\{maxTokens\} out tok` : '—';/, 'Picker 缺直出+out tok');
  assert.ok(!selector.includes(OLD_DIVISOR), 'Selector 1024 除数残留');
  assert.ok(!modelList.includes(OLD_DIVISOR), 'ModelList 1024 除数残留');
  assert.ok(!modelPicker.includes(OLD_DIVISOR), 'Picker 1024 除数残留');
});

// ⑦ hb10-PRV-04（三轮补救 hb13-v A10）：编辑档案按原 index 原位替换，不再 filter+push 移库尾。
check('⑦ PRV-04：saveProviderProfile 编辑按原 index splice 原位替换（不再移库尾）', () => {
  assert.match(
    configManager,
    /const editIdx = profiles\.findIndex\(\(p\) => p\.id === saved\.id\);\s*\n\s*if \(editIdx >= 0\) profiles\[editIdx\] = saved;\s*\n\s*else profiles\.push\(saved\);/,
    '编辑未按原 index 原位替换（findIndex>=0 splice else push）',
  );
  assert.ok(!configManager.includes('previousProfiles.filter((p) => p.id !== saved.id)'), 'filter+push 移库尾旧形态残留');
});

// ⑧ hb10-PRV-05（三轮补救 hb13-v A10）：persistModels 模块级 promise 链串行化，toast 在真正落库后提示。
check('⑧ PRV-05：persistModels 模块级 promise 链串行化（连点不丢更新）', () => {
  assert.match(manager, /providerPersistChain: Promise<void> = Promise\.resolve\(\);/, '缺模块级串行链承载');
  assert.match(manager, /providerPersistChain\.then\(doPersist\)/, '操作未入链（chain = chain.then(doPersist)）');
  assert.match(manager, /providerPersistChain = chained\.catch\(/, '缺断链保护（单次失败不得阻塞后续落库）');
  const fnIdx = manager.indexOf('function persistModels');
  const fnEnd = manager.indexOf('\n}', fnIdx);
  const body = manager.slice(fnIdx, fnEnd > -1 ? fnEnd : undefined);
  assert.match(body, /await chained;/, 'persistModels 未等待自身链位（调用方 await 后 toast 时未真正落库）');
});

// ⑨ hb10-PRV-06（三轮补救 hb13-v A10）：手动输入白名单预检 + 不合规丢弃如实计数提示。
check('⑨ PRV-06：手动输入 ^[\\w.\\-:/]+$ 预检 + 不合规 ID 计数提示（不再静默丢弃/谎报已添加）', () => {
  assert.match(modelPicker, /\/\^\[\\w\.\\-:\/\]\+\$\//, 'Picker 缺手动输入白名单预检');
  const cmIdx = modelPicker.indexOf('function confirmManual');
  const cmEnd = modelPicker.indexOf('\n}', cmIdx);
  const body = modelPicker.slice(cmIdx, cmEnd > -1 ? cmEnd : undefined);
  const preIdx = body.search(/\/\^\[\\w\.\\-:\/\]\+\$\//);
  const emitIdx = body.indexOf("emit('manual-add', id)");
  assert.ok(preIdx > -1 && emitIdx > preIdx, '预检未位于 manual-add 发射之前');
  assert.match(manager, /不合规被忽略/, 'Manager 缺不合规 ID 计数提示（sanitize 静默丢弃面）');
});

// ⑩ hb12-PRV-02（三轮补救 hb13-v B5）：ProviderModelList 挂 :key，testStates 不跨供应商残留。
check('⑩ PRV-02：ProviderModelList 用法补 :key="current.id"（与 Picker 对齐）', () => {
  const idx = manager.indexOf('<ProviderModelList');
  assert.ok(idx > -1, '未找到 ProviderModelList 用法');
  const tag = manager.slice(idx, manager.indexOf('>', idx));
  assert.match(tag, /:key="current\.id"/, 'ProviderModelList 缺 :key（组件实例原位复用，testStates 跨供应商残留）');
});

// ⑪ hb12-PRV-03（三轮补救 hb13-v B5）：漂移比对真正消费 providerId（管道已通但未参与比对）。
check('⑪ PRV-03：漂移早退比对纳入 providerId（同名供应商可区分）', () => {
  assert.match(
    backend,
    /prev\.providerName === current\.providerName && prev\.modelId === current\.modelId && prev\.providerId === current\.providerId/,
    '漂移早退比对未消费 providerId（同名供应商切换被抑制）',
  );
});

// ⑫ hb12-PRV-04（三轮补救 hb13-v B5）：归一化条目级形状探测——行为级（import 真函数实调）。
check('⑫ PRV-04 行为级：Anthropic 归一化对 OpenAI 形状条目读 context_length（不再恒 0）', () => {
  assert.equal(
    normalizeAnthropicModelsPayload({ data: [{ id: 'gw-model', context_length: 4096 }] }).length > 0
      && normalizeAnthropicModelsPayload({ data: [{ id: 'gw-model', context_length: 4096 }] })[0].maxTokens,
    4096,
    'Anthropic 归一化未按 context_length 兜底（OpenAI 形状网关输出上限丢失）',
  );
  assert.equal(normalizeAnthropicModelsPayload({ data: [{ id: 'a', display_name: 'A', max_output_tokens: 8192 }] })[0].maxTokens, 8192, '原生 Anthropic 条目 max_output_tokens 读取被破坏');
  assert.equal(normalizeAnthropicModelsPayload({ data: [{ id: 'b' }] })[0].maxTokens, 0, '全缺省条目应归 0');
  assert.equal(normalizeOpenAiModelsPayload({ data: [{ id: 'c', context_length: 16384 }] })[0].maxTokens, 16384, 'OpenAI 归一化回归');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
