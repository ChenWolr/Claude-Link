// scripts/tdd-provider-model-context-window-verify.ts
// 按供应商模型配置上下文窗口（计划 docs/plans/2026-10-02-provider-model-context-window-plan.md §2/§5）的
// 纯函数契约脚本——测试先行：新导出落地前本脚本应 RED（非零退出，失败原因为「新导出尚不存在/
// 断言未满足」，非脚本语法错误）。
//
// 断言面（§5 第一行）：
//   - sanitizeProviderModels 对 contextWindow 的采纳/拒绝矩阵
//     （0/负/小数/字符串/NaN/Infinity/999/2000001 边界拒绝；1000 与 2000000 恰好采纳）；
//   - lookupProviderModelContextWindow 命中/未命中/null/0；
//   - providerModelWindowInputError 五态（空串/合法/越界/非整数/非数字）；
//   - migrateLegacyContextWindowOverrides 4 场景
//     （可移植写入首个命中供应商且不覆盖已设 / 无 ANTHROPIC_DEFAULT 映射→dropped /
//      库内无该模型→dropped / 幂等二次零操作）+ env 键必删断言。
//   - X13（R02-F1，2026-10-06 隐藏缺陷修复第二轮）录入层口径钉住：sanitize 对
//     2,000,000 / 64,000 原值保留——录入/显示尊重真实窗口 [1k,2M]，引擎注入侧
//     [1e5,1e6] 钳制与圆环分母均不动，分叉由浮层卡说明弥合（UI/迁移侧静态断言在
//     tdd-provider-model-context-window-ui-verify.ts ⑧/⑨ 组）。
//
// 运行：npx tsx scripts/tdd-provider-model-context-window-verify.ts

import { strict as assert } from 'node:assert';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

type Dict = Record<string, unknown>;
type ModelLike = { id: string; contextWindow?: number | null };
type LookupFn = (
  models: Array<ModelLike> | null | undefined,
  modelId: string | null | undefined,
) => number | undefined;
type InputErrorFn = (raw: string) => string | null;
type SanitizeFn = (input: unknown) => Array<Dict>;
type MigrationResult = {
  advancedJson: string;
  profiles: Array<Dict>;
  migrated: Array<{ alias: string; modelId: string; window: number }>;
  dropped: Array<{ alias: string; window: number }>;
};
type MigrateFn = (advancedJson: string, profiles: Array<Dict>) => MigrationResult;

// 动态加载被测模块：RED 阶段（新导出尚未实现/模块链接失败）时给出可读的断言失败，
// 而不是让整个脚本在 import 阶段崩溃成不可读的语法样输出。
async function loadModule(rel: string): Promise<Dict> {
  try {
    return (await import(rel)) as unknown as Dict;
  } catch (e) {
    return { __loadError: e };
  }
}
function requireFn(mod: Dict, name: string): unknown {
  const fn = mod[name];
  const exported = Object.keys(mod).filter((k) => !k.startsWith('__')).join(', ') || '(模块加载失败)';
  assert.ok(typeof fn === 'function', `新导出 ${name} 尚不存在（当前导出: ${exported}）`);
  return fn;
}

// ── 测试数据构造（plain object，避免依赖尚未落地的 ProviderModel.contextWindow 类型）──
function makeModel(id: string, contextWindow?: number | null): Dict {
  const m: Dict = { id, name: id, maxTokens: 0, source: 'manual', addedAt: 1 };
  if (contextWindow !== undefined) m.contextWindow = contextWindow;
  return m;
}
function makeProfile(id: string, models: Array<Dict>): Dict {
  return { id, name: id, note: '', apiBaseUrl: 'https://example.com', models, createdAt: 1, updatedAt: 1 };
}
function envJson(env: Dict): string {
  return JSON.stringify({ env }, null, 2);
}
function parseEnv(json: string): Dict {
  const root = JSON.parse(json) as Dict;
  const env = root.env;
  assert.ok(env && typeof env === 'object', 'advancedJson 缺 env 对象');
  return env as Dict;
}
function hasLegacyWindowKey(env: Dict): boolean {
  return Object.keys(env).some((k) => k.startsWith('CLAUDE_LINK_CONTEXT_WINDOW'));
}
function findModel(profiles: Array<Dict>, profileId: string, modelId: string): Dict {
  const p = profiles.find((x) => x.id === profileId);
  assert.ok(p, `结果缺供应商 ${profileId}`);
  const m = (p.models as Array<Dict>).find((x) => x.id === modelId);
  assert.ok(m, `供应商 ${profileId} 缺模型 ${modelId}`);
  return m;
}
function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

async function main(): Promise<void> {
  const mcw = await loadModule('../src/shared/model-context-windows');
  const lib = await loadModule('../src/shared/provider-library');

  // ① 常量契约：界限定值 + DEFAULT_CONTEXT_WINDOW 保留（§2.3）。
  check('① 常量：CONTEXT_WINDOW_MIN=1_000 / CONTEXT_WINDOW_MAX=2_000_000 / DEFAULT_CONTEXT_WINDOW=200_000 保留', () => {
    assert.equal(mcw.CONTEXT_WINDOW_MIN, 1_000, 'CONTEXT_WINDOW_MIN 缺失或不等于 1000');
    assert.equal(mcw.CONTEXT_WINDOW_MAX, 2_000_000, 'CONTEXT_WINDOW_MAX 缺失或不等于 2000000');
    assert.equal(mcw.DEFAULT_CONTEXT_WINDOW, 200_000, 'DEFAULT_CONTEXT_WINDOW 须保留 200_000');
  });

  // ② sanitizeProviderModels：contextWindow 采纳/拒绝矩阵（§2.2）。
  check('② sanitize 矩阵：0/负/小数/字符串/NaN/Infinity/999/2000001 拒绝；1000/2000000 恰好与 200000 采纳', () => {
    const sanitize = requireFn(lib, 'sanitizeProviderModels') as SanitizeFn;
    const out = sanitize([
      { id: 'm-zero', contextWindow: 0 },
      { id: 'm-neg', contextWindow: -1000 },
      { id: 'm-frac', contextWindow: 1.5 },
      { id: 'm-str', contextWindow: '1000' },
      { id: 'm-nan', contextWindow: Number.NaN },
      { id: 'm-inf', contextWindow: Number.POSITIVE_INFINITY },
      { id: 'm-999', contextWindow: 999 },
      { id: 'm-over', contextWindow: 2_000_001 },
      { id: 'm-null', contextWindow: null },
      { id: 'm-none' },
      { id: 'm-lo', contextWindow: 1000 },
      { id: 'm-hi', contextWindow: 2_000_000 },
      { id: 'm-mid', contextWindow: 200_000 },
    ]);
    const got = (id: string): Dict => {
      const m = out.find((x) => x.id === id);
      assert.ok(m, `sanitize 输出缺条目 ${id}`);
      return m;
    };
    const rejected = ['m-zero', 'm-neg', 'm-frac', 'm-str', 'm-nan', 'm-inf', 'm-999', 'm-over', 'm-null', 'm-none'];
    for (const id of rejected) {
      assert.equal(got(id).contextWindow, undefined, `${id} 的 contextWindow 应被省略（未设置语义）`);
    }
    assert.equal(got('m-lo').contextWindow, 1000, '恰好 1000 须采纳');
    assert.equal(got('m-hi').contextWindow, 2_000_000, '恰好 2000000 须采纳');
    assert.equal(got('m-mid').contextWindow, 200_000, '界内中值须采纳');
  });

  // ③ lookupProviderModelContextWindow：命中/未命中/null/0（§2.3）。
  check('③ lookup：命中返回值；未设/不存在/null/0 → undefined；精确匹配不归一大小写', () => {
    const lookup = requireFn(mcw, 'lookupProviderModelContextWindow') as unknown as LookupFn;
    const models: Array<ModelLike> = [
      { id: 'has-window', contextWindow: 500_000 },
      { id: 'zero-window', contextWindow: 0 },
      { id: 'null-window', contextWindow: null },
      { id: 'no-field' },
    ];
    assert.equal(lookup(models, 'has-window'), 500_000, '命中须返回显式设置值');
    assert.equal(lookup(models, 'no-field'), undefined, '模型存在但未设 → undefined');
    assert.equal(lookup(models, 'other-model'), undefined, 'id 不存在 → undefined');
    assert.equal(lookup(models, null), undefined, 'modelId=null → undefined');
    assert.equal(lookup(models, undefined), undefined, 'modelId=undefined → undefined');
    assert.equal(lookup(null, 'has-window'), undefined, 'models=null → undefined');
    assert.equal(lookup(undefined, 'has-window'), undefined, 'models=undefined → undefined');
    assert.equal(lookup(models, 'zero-window'), undefined, 'contextWindow=0 → undefined（>0 才返回）');
    assert.equal(lookup(models, 'null-window'), undefined, 'contextWindow=null → undefined');
    assert.equal(
      lookup([{ id: 'GLM-4.7', contextWindow: 1_000_000 }], 'glm-4.7'),
      undefined,
      '匹配须精确（大小写敏感，不做归一化）',
    );
  });

  // ④ providerModelWindowInputError：五态（§2.3）。
  check('④ inputError 五态：空串→null（清除）；1000/2000000/200000→null；越界与非整数→统一错误文案', () => {
    const inputError = requireFn(mcw, 'providerModelWindowInputError') as unknown as InputErrorFn;
    assert.equal(inputError(''), null, '空串须视为清除意图（null）');
    assert.equal(inputError('1000'), null, '下界恰好 1000 合法');
    assert.equal(inputError('2000000'), null, '上界恰好 2000000 合法');
    assert.equal(inputError('200000'), null, '界内中值合法');
    for (const raw of ['999', '2000001', '0', '-500', '1.5', 'abc']) {
      const err = inputError(raw);
      assert.ok(typeof err === 'string' && err.length > 0, `输入 ${JSON.stringify(raw)} 须返回非空错误文案`);
      assert.match(err, /1,000/, `输入 ${JSON.stringify(raw)} 错误文案缺下界 1,000`);
      assert.match(err, /2,000,000/, `输入 ${JSON.stringify(raw)} 错误文案缺上界 2,000,000`);
    }
    // P3-3：科学计数法/十六进制字面量不得被 Number() 宽容解析放行（E2 原型 /^\d+$/ 同口径）。
    assert.ok(inputError('1e6') !== null, "输入 '1e6' 须被拒（严格十进制数字串）");
    assert.ok(inputError('0x10') !== null, "输入 '0x10' 须被拒（严格十进制数字串）");
  });

  // ⑤ 迁移场景 1：可移植值写入首个命中供应商 + 不覆盖已设 + env 键必删 + ANTHROPIC_DEFAULT 不动（§2.2/§7.7）。
  check('⑤ 迁移①：写入首个命中供应商；已设值不覆盖；CLAUDE_LINK_* 键全删且 ANTHROPIC_DEFAULT_* 保留', () => {
    const migrate = requireFn(lib, 'migrateLegacyContextWindowOverrides') as unknown as MigrateFn;
    const json = envJson({
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'shared-model',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'preset-model',
      ANTHROPIC_BASE_URL: 'https://example.com',
      CLAUDE_LINK_CONTEXT_WINDOW_SONNET: 1_000_000,
      CLAUDE_LINK_CONTEXT_WINDOW_HAIKU: 500_000,
    });
    const pA = makeProfile('p-a', [makeModel('shared-model'), makeModel('preset-model', 300_000)]);
    const pB = makeProfile('p-b', [makeModel('shared-model'), makeModel('other')]);
    const r = migrate(json, [clone(pA), clone(pB)]);
    assert.equal(
      findModel(r.profiles, 'p-a', 'shared-model').contextWindow,
      1_000_000,
      '须写入首个命中供应商 p-a 的模型条目',
    );
    assert.equal(
      findModel(r.profiles, 'p-b', 'shared-model').contextWindow,
      undefined,
      '第二家同 id 模型不得写入（只写遍历序首家）',
    );
    assert.equal(
      findModel(r.profiles, 'p-a', 'preset-model').contextWindow,
      300_000,
      '模型已有值不得被覆盖',
    );
    const mig = r.migrated.find((x) => x.modelId === 'shared-model');
    assert.ok(mig, 'migrated 须记录 shared-model 移植');
    assert.equal(mig.window, 1_000_000, 'migrated.window 须为移植值');
    assert.match(String(mig.alias), /sonnet/i, 'migrated.alias 须指向 sonnet 别名');
    const env = parseEnv(r.advancedJson);
    assert.ok(!hasLegacyWindowKey(env), 'advancedJson 中 CLAUDE_LINK_CONTEXT_WINDOW_* 键必须全部删除');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'shared-model', 'ANTHROPIC_DEFAULT_* 键不得动（sonnet）');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'preset-model', 'ANTHROPIC_DEFAULT_* 键不得动（haiku）');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://example.com', '无关 env 键不得误删');
  });

  // ⑥ 迁移场景 2：无 ANTHROPIC_DEFAULT 映射 → dropped（值废弃仅删键）。
  check('⑥ 迁移②：无 ANTHROPIC_DEFAULT 映射 → dropped，值废弃仅删键，不写任何模型', () => {
    const migrate = requireFn(lib, 'migrateLegacyContextWindowOverrides') as unknown as MigrateFn;
    const json = envJson({
      ANTHROPIC_BASE_URL: 'https://example.com',
      CLAUDE_LINK_CONTEXT_WINDOW_OPUS: 400_000,
    });
    const p = makeProfile('p', [makeModel('m')]);
    const r = migrate(json, [clone(p)]);
    assert.equal(r.migrated.length, 0, '无映射不得移植');
    assert.equal(r.dropped.length, 1, '须记 dropped 恰好一条');
    assert.equal(r.dropped[0].window, 400_000, 'dropped.window 须为被废弃值');
    assert.match(String(r.dropped[0].alias), /opus/i, 'dropped.alias 须指向 opus 别名');
    assert.equal(findModel(r.profiles, 'p', 'm').contextWindow, undefined, '不得写入任何模型条目');
    assert.ok(!hasLegacyWindowKey(parseEnv(r.advancedJson)), '废弃场景同样必须删除 env 键');
  });

  // ⑦ 迁移场景 3：有映射但库内无该模型 → dropped。
  check('⑦ 迁移③：库内无映射到的模型 → dropped，仅删键，ANTHROPIC_DEFAULT 保留', () => {
    const migrate = requireFn(lib, 'migrateLegacyContextWindowOverrides') as unknown as MigrateFn;
    const json = envJson({
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'no-such-model',
      CLAUDE_LINK_CONTEXT_WINDOW_FABLE: 1_500_000,
    });
    const r = migrate(json, [makeProfile('p', [makeModel('m')])]);
    assert.equal(r.migrated.length, 0, '库内无模型不得移植');
    assert.equal(r.dropped.length, 1, '须记 dropped 恰好一条');
    assert.equal(r.dropped[0].window, 1_500_000, 'dropped.window 须为被废弃值');
    assert.match(String(r.dropped[0].alias), /fable/i, 'dropped.alias 须指向 fable 别名');
    const env = parseEnv(r.advancedJson);
    assert.ok(!hasLegacyWindowKey(env), '库内无模型场景同样必须删除 env 键');
    assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'no-such-model', 'ANTHROPIC_DEFAULT_* 键不得动（fable）');
  });

  // ⑧ 迁移场景 4：幂等（二次运行零操作）。
  check('⑧ 迁移④：幂等——二次运行 migrated/dropped 均空、profiles 与 advancedJson 零变化', () => {
    const migrate = requireFn(lib, 'migrateLegacyContextWindowOverrides') as unknown as MigrateFn;
    const json = envJson({
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'shared-model',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'preset-model',
      CLAUDE_LINK_CONTEXT_WINDOW_SONNET: 1_000_000,
      CLAUDE_LINK_CONTEXT_WINDOW_HAIKU: 500_000,
    });
    const pA = makeProfile('p-a', [makeModel('shared-model'), makeModel('preset-model', 300_000)]);
    const pB = makeProfile('p-b', [makeModel('shared-model')]);
    const first = migrate(json, [clone(pA), clone(pB)]);
    const profilesSnapshot = JSON.stringify(first.profiles);
    const jsonSnapshot = JSON.stringify(JSON.parse(first.advancedJson) as unknown);
    const second = migrate(first.advancedJson, first.profiles);
    assert.equal(second.migrated.length, 0, '二次运行不得再产生移植');
    assert.equal(second.dropped.length, 0, '二次运行不得再产生废弃');
    assert.equal(JSON.stringify(second.profiles), profilesSnapshot, '二次运行 profiles 必须零变化');
    assert.equal(
      JSON.stringify(JSON.parse(second.advancedJson) as unknown),
      jsonSnapshot,
      '二次运行 advancedJson 必须零变化（键已删，无残留可处理）',
    );
    assert.ok(!hasLegacyWindowKey(parseEnv(second.advancedJson)), '二次运行后仍不得有遗留键');
  });

  // ⑨ X13（R02-F1）录入层口径钉住：sanitize 对 2,000,000 / 64,000 原值保留——口径决策
  //    「显示与录入尊重真实窗口」：保存仍按 [1k,2M] sanitize（不动）；引擎注入钳制
  //    [1e5,1e6]（sdk-backend，静态钉住在 ui-verify ⑧b）与圆环分母（userOverride 原值）
  //    各自语义不动，分叉由浮层卡说明显式化（ui-verify ⑧a）。
  check('⑨ X13 录入层：sanitize(2_000_000)=2_000_000、sanitize(64_000)=64_000（真实窗口原值保留，钳制分叉交给 UI 说明）', () => {
    const sanitize = requireFn(lib, 'sanitizeProviderModels') as SanitizeFn;
    const out = sanitize([
      { id: 'm-2m', contextWindow: 2_000_000 },
      { id: 'm-64k', contextWindow: 64_000 },
    ]);
    const by = (id: string): Dict => {
      const m = out.find((x) => x.id === id);
      assert.ok(m, `sanitize 输出缺条目 ${id}`);
      return m;
    };
    assert.equal(by('m-2m').contextWindow, 2_000_000, '2M（UI 预置一等公民）在录入层须原值保留');
    assert.equal(by('m-64k').contextWindow, 64_000, '64k（<100k 引擎上钳段）在录入层须原值保留');
  });

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
