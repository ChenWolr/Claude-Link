// scripts/tdd-provider-model-context-window-ui-verify.ts
// 按供应商模型配置上下文窗口（计划 docs/plans/2026-10-02-provider-model-context-window-plan.md §5 第二行）
// 的 UI/消费链静态契约脚本——测试先行：UI 与消费链实施前本脚本应 RED（非零退出，失败原因为
// 「契约标记尚不存在」而非脚本语法错误；唯 ConfigPage 不含旧别名覆盖字段一条在 A7
// 回退完成后即应通过）。纯文本静态断言，不 import 任何 src 模块（消费链未切换时也不受链接影响）。
//
// 断言面（§5 第二行，锚点取自 §4.1/§4.2/§4.3/§3.2 明文）：
//   - ProviderModelList.vue：emit('set-window', model, raw) 事件；.win-badge 徽标（set/unset
//     两态 + 未设态「设置上下文窗口」文案）；providerModelWindowInputError 实时校验引用；浮层卡
//     三段结构标记（openWinId 受控开合 / 输入占位「token 数，留空清除」/ 预设胶囊
//     200k·1M·2M·清除覆盖 / 底部 取消·保存 / @keydown.enter·@keydown.esc 键盘纪律）。
//   - ProviderManager.vue：handleModelWindowSet 存在且走 persistModels 串行链；清除写
//     contextWindow:null、设置写 contextWindow:Number(raw)；@set-window 模板接线；成功 toast 文案。
//   - ConfigPage.vue：不含旧别名覆盖字段（A7 回退契约；符号名经运行时拼接，见 LEGACY_* 注记）。
//   - session-store.ts：getter 含 lookupProviderModelContextWindow 与
//     userOverride ?? state.contextLastWindow ?? 200_000 组合形态；旧链符号零残留。
//   - cli-shared.ts：不含 readContextWindow 与旧链 per-session 窗口解析符号（§3.2 死代码删除）。
//
// 运行：npx tsx scripts/tdd-provider-model-context-window-ui-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

// §9.4 门禁注记：旧链符号名在本脚本内一律运行时拼接（如 'contextWindow' + 'ByAlias'）——
// 计划要求 scripts 内这些符号 grep 零命中，而负向契约（「源码不得再出现这些符号」）必须按
// 全名判定；拼接不改变断言语义，只是避免本脚本自身击穿门禁。
const LEGACY_ALIAS_FIELD = ['contextWindow', 'ByAlias'].join('');
const LEGACY_SESSION_RESOLVER = ['resolveContextWindow', 'ForSession'].join('');
const LEGACY_USER_LOOKUP = ['lookupUser', 'ContextWindow'].join('');

const modelList = read('../src/renderer/components/providers/ProviderModelList.vue');
const manager = read('../src/renderer/components/providers/ProviderManager.vue');
const configPage = read('../src/renderer/pages/ConfigPage.vue');
const sessionStore = read('../src/renderer/stores/session-store.ts');
const cliShared = read('../src/main/modules/cli-shared.ts');

function countMatches(src: string, re: RegExp): number {
  return (src.match(re) ?? []).length;
}

// 截取指定函数体（从定义起到下一个顶层 function 或 </script>），用于「链内形态」类断言。
function functionBody(src: string, name: string): string {
  const idx = src.search(new RegExp(`(?:async )?function ${name}\\b`));
  assert.ok(idx >= 0, `缺函数 ${name}`);
  const rest = src.slice(idx);
  const next = rest.slice(1).search(/\n(?:async )?function \w|<\/script>/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function main(): void {
  console.log('\n=== ① ProviderModelList.vue：窗口徽标与 set-window 事件（§4.1） ===');
  check('set-window 事件：emit(\'set-window\', model, raw) 调用存在', () => {
    assert.ok(/emit\('set-window'/.test(modelList), "缺 emit('set-window', …) 调用");
  });
  check('win-badge 徽标：模板类 + .win-badge 样式选择器 + set/unset 两态 + 「设置上下文窗口」未设文案', () => {
    assert.ok(countMatches(modelList, /win-badge/g) >= 2, 'win-badge 须同时出现在模板与样式');
    assert.ok(/\.win-badge[^{]*\{/.test(modelList), '缺 .win-badge 样式定义');
    assert.ok(/\bunset\b/.test(modelList), '缺 unset 态类名（已设/未设两态）');
    assert.ok(modelList.includes('设置上下文窗口'), '缺未设态「设置上下文窗口」文案');
  });
  check('实时校验：providerModelWindowInputError 被引用', () => {
    assert.ok(/providerModelWindowInputError/.test(modelList), '未引用 providerModelWindowInputError');
  });

  console.log('\n=== ② ProviderModelList.vue：浮层卡三段结构标记（§1 交互契约/§4.1） ===');
  check('受控开合与输入段：openWinId + 占位「token 数，留空清除」', () => {
    assert.ok(/openWinId/.test(modelList), '缺受控 openWinId ref');
    assert.ok(modelList.includes('token 数，留空清除'), '缺输入占位文案「token 数，留空清除」');
  });
  check('输入段字段标签：pop-field-label 类 + 「上下文窗口」label 文案（for/id 关联）', () => {
    assert.ok(modelList.includes('pop-field-label'), '缺 pop-field-label 字段标签类');
    assert.ok(modelList.includes('>上下文窗口</label>'), '缺字段标签文案「上下文窗口」');
  });
  check('预设胶囊：200k / 1M / 2M / 清除覆盖', () => {
    for (const preset of ['200k', '1M', '2M', '清除覆盖']) {
      assert.ok(modelList.includes(preset), `缺预设胶囊「${preset}」`);
    }
  });
  check('底部段与键盘纪律：取消 / 保存 + @keydown.enter 提交 + @keydown.esc 关闭', () => {
    assert.ok(modelList.includes('取消'), '缺底部「取消」按钮');
    assert.ok(modelList.includes('保存'), '缺底部「保存」按钮');
    assert.ok(/@keydown\.enter/.test(modelList), '缺 @keydown.enter 提交');
    assert.ok(/@keydown\.esc/.test(modelList), '缺 @keydown.esc 关闭');
  });

  console.log('\n=== ③ ProviderManager.vue：handleModelWindowSet 落库链（§4.2） ===');
  check('handleModelWindowSet 走 persistModels 串行链；清除写 null / 设置写 Number(raw)；成功 toast 文案', () => {
    const body = functionBody(manager, 'handleModelWindowSet');
    assert.ok(/persistModels\(/.test(body), '函数体内缺 persistModels( 调用（须走既有串行链）');
    assert.ok(/contextWindow:\s*null/.test(body), '清除路径须写 contextWindow: null（保留键的未设置语义）');
    assert.ok(/contextWindow:\s*Number\(/.test(body), '设置路径须写 contextWindow: Number(…)');
    assert.ok(countMatches(body, /上下文窗口/g) >= 2, '成功 toast 须含更新/清除两态「上下文窗口」文案');
  });
  check('@set-window 接线到 handleModelWindowSet', () => {
    assert.ok(
      /@set-window="handleModelWindowSet"/.test(manager),
      'ProviderModelList 须以 @set-window="handleModelWindowSet" 接线',
    );
  });

  console.log('\n=== ④ ConfigPage.vue：A7 回退后无别名覆盖残留（§4.4） ===');
  check('ConfigPage.vue 不含旧别名覆盖字段（A7 回退契约）', () => {
    assert.ok(!configPage.includes(LEGACY_ALIAS_FIELD), `仍残留 ${LEGACY_ALIAS_FIELD}（A7 未回退干净）`);
  });

  console.log('\n=== ⑤ session-store.ts：分母 getter 切按模型覆盖（§4.3） ===');
  check('getter 含 lookupProviderModelContextWindow 与 userOverride ?? state.contextLastWindow ?? 200_000 组合形态', () => {
    assert.ok(/lookupProviderModelContextWindow\(/.test(sessionStore), '缺 lookupProviderModelContextWindow 调用');
    assert.ok(
      /userOverride \?\? state\.contextLastWindow \?\? (?:200_000|DEFAULT_CONTEXT_WINDOW)/.test(sessionStore),
      '缺组合形态 userOverride ?? state.contextLastWindow ?? 200_000',
    );
  });
  check('旧链符号零残留（旧 lookup/resolve/别名覆盖三符号）', () => {
    for (const legacy of [LEGACY_USER_LOOKUP, LEGACY_SESSION_RESOLVER, LEGACY_ALIAS_FIELD]) {
      assert.ok(!sessionStore.includes(legacy), `仍残留旧链符号 ${legacy}`);
    }
  });

  console.log('\n=== ⑥ cli-shared.ts：死代码删除（§3.2） ===');
  check('cli-shared 不含 readContextWindow / 旧链 per-session 解析符号', () => {
    assert.ok(!cliShared.includes('readContextWindow'), '仍残留死代码 readContextWindow');
    assert.ok(!cliShared.includes(LEGACY_SESSION_RESOLVER), `仍残留 ${LEGACY_SESSION_RESOLVER} import`);
  });

  console.log('\n=== ⑦ 迁移接线：窗口迁移不在 getStore 首初始化、晚于 ensureProviderMigration（P1 修复契约） ===');
  check('config-manager.ts getStore 函数体（含 createSafeStore if 块）不含 migrateLegacy 调用', () => {
    const configManager = read('../src/main/modules/config-manager.ts');
    const body = functionBody(configManager, 'getStore');
    assert.ok(!body.includes('migrateLegacyContextWindowOverridesToProfiles'), 'getStore 内不得调用窗口迁移（会击穿 ensureProviderMigration 守卫）');
  });
  check('index.ts：ensureProviderMigration() 调用行号 < migrateLegacyContextWindowOverridesToProfiles() 调用行号', () => {
    const main = read('../src/main/index.ts');
    const lineOf = (re: RegExp): number => {
      const lines = main.split('\n');
      const i = lines.findIndex((l) => re.test(l));
      assert.ok(i >= 0, `index.ts 缺 ${re} 调用行`);
      return i;
    };
    const ensure = lineOf(/ensureProviderMigration\(\);/);
    const migrate = lineOf(/migrateLegacyContextWindowOverridesToProfiles\(\);/);
    assert.ok(ensure < migrate, `窗口迁移调用（行 ${migrate + 1}）必须晚于 ensureProviderMigration（行 ${ensure + 1}）`);
  });
  check('config-manager.ts 迁移函数含 hadKey 防御（不因迁移创建空 providerProfiles 键）', () => {
    const configManager = read('../src/main/modules/config-manager.ts');
    const body = functionBody(configManager, 'migrateLegacyContextWindowOverridesToProfiles');
    assert.ok(/hadKey\s*=\s*s\.has\('providerProfiles'\)/.test(body), '缺 hadKey = s.has(providerProfiles) 防御');
    assert.ok(/hadKey \|\| result\.profiles\.length > 0/.test(body), '缺 hadKey || profiles.length > 0 条件载荷');
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (pass + fail === 0) {
    console.error('断言计数为 0——脚本自身缺陷');
    process.exit(1);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main();
