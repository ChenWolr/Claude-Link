// tdd-provider-models-write-recompute-verify.ts
// A5（D02-F1，P2）契约钉：模型增删串行链改「写时重算」，消除点击时快照的整表覆盖丢更新。
//
// 根因：persistModels 串行链只保证落库顺序，models 是调用方点击时从 current.value 算好的快照——
// 连续快速添加（间隔 < saveProvider IPC + load() 往返）时，链上后一个 doPersist 仍携带旧快照，
// 整表替换语义下先添加的模型被覆盖丢失；handleEditorSave 直调 store.save 绕开链，同样携带旧
// currentProvider?.models 与在飞模型增删并发。文件头注释声称的「后写基于最新列表重算」未实现。
//
// 修复语义：provider-store 新增 updateProviderModels(providerId, fn)——fn 在保存执行时刻基于
// store 最新 models 应用（纯函数，收最新数组返回新数组）；ProviderManager 的增/删/撤销全部改传
// mutator；handleEditorSave 的更新路径入链且 models 现取最新。重复添加在 fn 内再查重（连点同 id
// 的链内拦截），删除按模型 id 过滤（索引在交错场景不稳定）。
//
// 2026-09-30 复核补丁：handleEditorSave 更新路径镜像 persistModels 延伸链头——此前只经
// chain.then(persist) 排队而不重赋链头，编辑保存在飞窗口内入链的模型操作（撤销 toast 回添）
// 挂到已结算旧链头上并发执行，整表替换下互相覆盖（档案字段被回盖/回添模型被丢弃）。行为
// 测试改交错 enqueue（顺序 await 无法区分「点击时快照」实现——store 的 providers 是调用
// 时刻同步读，交错安全由链提供，故须复刻链机制再交错），并补「编辑保存×模型操作交错」
// 「空模型列表删除 no-op」两个计划边界值。
//
// 运行：npx tsx scripts/tdd-provider-models-write-recompute-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

let pass = 0;
let fail = 0;
// 行为检查为 async（真实 store 异步落库）：check 统一 await，拒绝即计失败（CJS 无顶层 await，
// 主流程入 async IIFE）。
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

const manager = readFileSync(new URL('../src/renderer/components/providers/ProviderManager.vue', import.meta.url), 'utf8');
const storeSrc = readFileSync(new URL('../src/renderer/stores/provider-store.ts', import.meta.url), 'utf8');

// ── ① 行为：provider-store.updateProviderModels 写时重算（pinia 无头实例 + 桩 IPC）──
interface FakeModel { id: string; name: string; maxTokens: number; source: 'queried' | 'manual'; addedAt: number }
// 模拟主进程 DB：saveProvider 落库 models，listProviders 回读。
let fakeDb: Array<{ id: string; name: string; note: string; apiBaseUrl: string; models: FakeModel[] }> = [
  { id: 'p1', name: 'P1', note: '', apiBaseUrl: 'https://api.example.com', models: [] },
];

async function main(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = {
    claudeLink: {
      listProviders: async () => ({
        providers: JSON.parse(JSON.stringify(fakeDb)),
        lastUsedProviderId: null,
        lastUsedModelId: null,
      }),
      saveProvider: async (input: { id: string; name: string; note?: string; apiBaseUrl: string; models?: FakeModel[] }) => {
        const cur = fakeDb.find((p) => p.id === input.id);
        if (!cur) throw new Error('not found');
        cur.name = input.name;
        cur.note = input.note ?? cur.note;
        cur.apiBaseUrl = input.apiBaseUrl;
        if (input.models) cur.models = JSON.parse(JSON.stringify(input.models));
        return JSON.parse(JSON.stringify({ ...cur, apiKeyMasked: '', hasApiKey: false }));
      },
    },
  };
  const { createPinia, setActivePinia } = require('pinia');
  setActivePinia(createPinia());
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useProviderStore } = require('../src/renderer/stores/provider-store');

  console.log('\n=== A5-①：updateProviderModels 写时重算（fn 收最新列表） ===');
  // 复刻 ProviderManager 模块级串行链的 enqueue 形态（链头延伸 + 单次失败不断链）：enqueue 即
  // 「点击」，不等前一 op 落定即再 enqueue，即两次操作落在同一 saveProvider IPC + load 往返
  // 窗内的交错（store 的 providers 在调用时刻同步读，交错安全由链提供——顺序 await 测不出）。
  const makeChain = (): { enqueue: (op: () => Promise<unknown>) => Promise<unknown> } => {
    let head: Promise<unknown> = Promise.resolve();
    return {
      enqueue: (op) => {
        const chained = head.then(op);
        head = chained.catch(() => undefined);
        return chained;
      },
    };
  };
  await check('两次交错更新均保留（第二次点击发生在第一次在飞窗口内——竞态根除）', async () => {
    const store = useProviderStore();
    await store.load();
    const { enqueue } = makeChain();
    const received: FakeModel[][] = [];
    const p1 = enqueue(() => store.updateProviderModels('p1', (latest: FakeModel[]) => [
      ...latest,
      { id: 'model-a', name: 'A', maxTokens: 0, source: 'manual' as const, addedAt: 1 },
    ]));
    const p2 = enqueue(() => store.updateProviderModels('p1', (latest: FakeModel[]) => {
      received.push(JSON.parse(JSON.stringify(latest)));
      return [
        ...latest,
        { id: 'model-b', name: 'B', maxTokens: 0, source: 'manual' as const, addedAt: 2 },
      ];
    }));
    await Promise.all([p1, p2]);
    assert.equal(received.length, 1);
    assert.ok(received[0].some((m) => m.id === 'model-a'), 'fn 未收到最新列表（第二次仍拿旧快照，先写更新会被覆盖）');
    const saved = fakeDb.find((p) => p.id === 'p1')!;
    assert.deepEqual(saved.models.map((m) => m.id), ['model-a', 'model-b'], '两次添加未都落库');
  });
  await check('编辑保存与模型操作经同一链交错（档案字段不被回盖、回添模型不丢）', async () => {
    fakeDb = [{ id: 'p1', name: 'Old', note: '', apiBaseUrl: 'https://old.example.com', models: [] }];
    const store = useProviderStore();
    await store.load();
    const { enqueue } = makeChain();
    // 模拟 handleEditorSave 的链位 persist：现取最新 models + 表单档案字段整表提交。
    const pEdit = enqueue(() => {
      const latest = store.providers.find((p: { id: string }) => p.id === 'p1');
      return store.save({ id: 'p1', name: 'New', note: 'n', apiBaseUrl: 'https://new.example.com', models: latest?.models });
    });
    // 模拟撤销 toast 回添：编辑保存在飞窗口内入链（A5 复核缺陷的场景）。
    const pModel = enqueue(() => store.updateProviderModels('p1', (latest: FakeModel[]) => [
      ...latest,
      { id: 'model-x', name: 'X', maxTokens: 0, source: 'manual' as const, addedAt: 3 },
    ]));
    await Promise.all([pEdit, pModel]);
    const saved = fakeDb.find((p) => p.id === 'p1')!;
    assert.equal(saved.name, 'New', '编辑保存的档案名称被后续模型操作回盖');
    assert.equal(saved.apiBaseUrl, 'https://new.example.com', '编辑保存的请求地址被后续模型操作回盖');
    assert.deepEqual(saved.models.map((m) => m.id), ['model-x'], '编辑保存在飞窗口内的模型回添被丢弃');
  });
  await check('fn 收到的是去代理纯数组（IPC 结构化克隆安全）', async () => {
    const store = useProviderStore();
    await store.load();
    let isPlain = false;
    await store.updateProviderModels('p1', (latest: FakeModel[]) => {
      isPlain = JSON.stringify(JSON.parse(JSON.stringify(latest))) === JSON.stringify(latest);
      return latest;
    });
    assert.ok(isPlain, 'fn 收到的 models 含不可克隆形态');
  });
  await check('边界：空模型列表删除 no-op（filter 不产生条目、不抛错、保持空列表）', async () => {
    fakeDb = [{ id: 'p-empty', name: 'E', note: '', apiBaseUrl: 'https://api.example.com', models: [] }];
    const store = useProviderStore();
    await store.load();
    await store.updateProviderModels('p-empty', (latest: FakeModel[]) => latest.filter((m) => m.id !== 'ghost'));
    assert.deepEqual(fakeDb.find((p) => p.id === 'p-empty')!.models, [], '空列表删除后应保持空（no-op）');
  });

  console.log('\n=== A5-②：ProviderManager 结构契约（mutator 化 + 编辑入链） ===');
  await check('persistModels 改收 mutator，doPersist 内走 store.updateProviderModels（链形态保留）', () => {
    assert.match(manager, /providerPersistChain\.then\(doPersist\)/, '链形态被破坏（PRV-05）');
    assert.match(manager, /providerPersistChain = chained\.catch\(/, '断链保护被破坏（PRV-05）');
    const fnIdx = manager.indexOf('function persistModels');
    const body = manager.slice(fnIdx, manager.indexOf('\n}', fnIdx));
    assert.match(body, /mutate: \(latest: ProviderModel\[\]\) => ProviderModel\[\]/, 'persistModels 未改收 mutator 参数');
    assert.match(body, /store\.updateProviderModels\(/, 'doPersist 未走写时重算 action');
    assert.match(body, /await chained;/, 'persistModels 未等待自身链位（PRV-05）');
  });
  await check('handleModelAdd：不再点击时预拼 next 数组；链内 fn 再查重', () => {
    const idx = manager.indexOf('async function handleModelAdd');
    const body = manager.slice(idx, manager.indexOf('\n}', manager.indexOf('pushToast(`已添加模型', idx)));
    assert.ok(!body.includes('const next: ProviderModel[] = ['), '仍保留点击时快照拼接（竞态根源）');
    assert.match(body, /latest\.some\(\(m\) => m\.id === info\.id\)/, '链内缺同 id 再查重');
  });
  await check('handleModelRemove：按模型 id 在链内过滤（索引不再穿越交错窗口）', () => {
    const idx = manager.indexOf('async function handleModelRemove');
    const body = manager.slice(idx, manager.indexOf('pushToast(`已删除模型', idx));
    assert.match(body, /latest\.filter\(\(m\) => m\.id !== model\.id\)/, '删除未按 id 链内过滤');
    assert.ok(!body.includes('p.models.filter((_, i)'), '仍按点击时索引过滤');
  });
  await check('handleEditorSave：更新路径入链且 models 现取最新（不再携带点击时快照、不再绕开串行链）', () => {
    const idx = manager.indexOf('async function handleEditorSave');
    const body = manager.slice(idx, manager.indexOf('function handleEditorCancel', idx));
    assert.ok(!body.includes('models: currentProvider?.models'), '编辑保存仍携带点击时 models 快照');
    assert.ok(!body.includes('const view = await store.save('), '编辑保存仍直调 store.save 绕开串行链');
    assert.match(body, /providerPersistChain\.then\(/, '编辑保存未入串行链');
    assert.match(body, /store\.providers\.find\(\(p\) => p\.id === payload\.id\)/, '编辑保存未在链内现取最新 models');
  });
  await check('handleEditorSave：更新路径延伸链头（编辑保存在飞窗口内入链的操作挂其后，不再与已结算旧链头并发）', () => {
    const idx = manager.indexOf('async function handleEditorSave');
    const body = manager.slice(idx, manager.indexOf('function handleEditorCancel', idx));
    assert.match(body, /providerPersistChain = chained\.(?:then|catch)\(/, '编辑保存只排队未延伸链头（A5 复核缺陷：在飞窗口内入链的模型操作挂到已结算旧链头并发，整表替换互相覆盖）');
    assert.match(body, /view = await chained;/, '编辑保存未等待自身链位');
  });
  await check('文件头注释与实现一致（写时重算语义）', () => {
    const head = manager.slice(0, manager.indexOf('export default'));
    assert.match(head, /写时重算/, '头注释未更新为写时重算语义');
  });

  console.log('\n=== A5-③：provider-store 结构契约 ===');
  await check('updateProviderModels action：现取 this.providers 最新并整表提交 save', () => {
    const idx = storeSrc.indexOf('async updateProviderModels(');
    assert.ok(idx > -1, 'provider-store 缺 updateProviderModels action');
    const body = storeSrc.slice(idx, idx + 900);
    assert.match(body, /this\.providers\.find\(\(p\) => p\.id === providerId\)/, '未现取最新 provider');
    assert.match(body, /this\.save\(/, '未走 save 落库');
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
