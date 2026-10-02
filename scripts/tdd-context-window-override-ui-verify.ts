// tdd-context-window-override-ui-verify.ts
// A7（D04-F5，P2）契约钉：设置页「上下文窗口覆盖」编辑区（contextWindowByAlias UI 入口）。
//
// 根因：README 承诺「容量分母优先取设置页按别名配置的窗口覆盖」，但 ConfigPage 全文无该
// 编辑 UI（字段仅出现在持久化清单），advancedJson 编辑器已删、写入函数 renderer 零调用——
// 分母 fallback 链最高优先级源（resolveContextWindow 第 1 级 / lookupUserContextWindow 注入）
// 用户在产品内不可达。
//
// 修复语义：ConfigPage「行为」tab 新增编辑区（行式增删：别名 + token 数），本地行态经
// shared 纯函数（context-window-override.ts）校验投影到既有顶层持久化字段
// config.contextWindowByAlias（已在 PERSISTED_FIELDS 自动保存快照内，走既有保存链）；
// 非法/重复/不完整行不投影并给行内提示；分母消费链（model-context-windows）既有不动。
//
// 运行：npx tsx scripts/tdd-context-window-override-ui-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import {
  contextWindowOverrideRowError,
  projectContextWindowOverrides,
} from '../src/shared/context-window-override';
import { resolveContextWindow } from '../src/shared/model-context-windows';

let pass = 0;
let fail = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const page = readFileSync(new URL('../src/renderer/pages/ConfigPage.vue', import.meta.url), 'utf8');
const shared = readFileSync(new URL('../src/shared/context-window-override.ts', import.meta.url), 'utf8');

async function main(): Promise<void> {
  console.log('\n=== A7-①：投影纯函数（行态 → config 字段） ===');
  await check('合法行投影为映射；非法/重复/不完整行被拦截不写入', () => {
    const { map, errors } = projectContextWindowOverrides([
      { alias: 'sonnet', value: '1000000' },
      { alias: 'haiku', value: '500' },        // 低于下限
      { alias: 'sonnet', value: '200000' },    // 重复别名（两行同拦，无隐式先后优先级）
      { alias: 'opus', value: '' },            // 不完整
      { alias: '', value: '123' },             // 缺别名
      { alias: 'bad alias!', value: '2000' },  // 非法字符
      { alias: 'glm-4.7', value: '500000' },   // 自定义模型 ID（白名单字符）
    ]);
    assert.deepEqual(map, { 'glm-4.7': 500000 });
    assert.equal(errors[0], '别名重复');
    assert.match(errors[1], /整数/);
    assert.equal(errors[2], '别名重复');
    assert.match(errors[3], /缺少 token/);
    assert.match(errors[4], /缺少别名/);
    assert.match(errors[5], /别名仅允许/);
    assert.equal(errors[6], '');
  });
  await check('边界：下限 1000 / 上限 2000000 / 非整数拒绝', () => {
    assert.equal(contextWindowOverrideRowError([{ alias: 'a', value: '1000' }], 0), '');
    assert.equal(contextWindowOverrideRowError([{ alias: 'a', value: '2000000' }], 0), '');
    assert.match(contextWindowOverrideRowError([{ alias: 'a', value: '999' }], 0), /整数/);
    assert.match(contextWindowOverrideRowError([{ alias: 'a', value: '2000001' }], 0), /整数/);
    assert.match(contextWindowOverrideRowError([{ alias: 'a', value: '1.5' }], 0), /整数/);
  });
  await check('链路级：投影映射经 resolveContextWindow 生效（覆盖 > 引擎上报 > 默认）', () => {
    const { map } = projectContextWindowOverrides([{ alias: 'sonnet', value: '1000000' }]);
    assert.equal(resolveContextWindow({ lastContextWindow: 200000, alias: 'sonnet', contextWindowByAlias: map }), 1000000);
    assert.equal(resolveContextWindow({ lastContextWindow: 200000, alias: 'haiku', contextWindowByAlias: map }), 200000);
    assert.equal(resolveContextWindow({ lastContextWindow: null, alias: 'opus', contextWindowByAlias: map }), 200000);
  });
  await check('空值常量与行接口导出（UI 与契约同源）', () => {
    assert.match(shared, /CONTEXT_WINDOW_MIN = 1000/);
    assert.match(shared, /CONTEXT_WINDOW_MAX = 2_000_000/);
  });

  console.log('\n=== A7-②：ConfigPage 编辑区结构契约 ===');
  await check('行为 tab 含「上下文窗口覆盖」编辑区（行式增删 + 投影接线）', () => {
    assert.match(page, /上下文窗口覆盖/, '缺编辑区标题');
    assert.match(page, /v-for="\(row, i\) in ctxOverrideRows"/, '缺行渲染');
    assert.match(page, /function addCtxOverrideRow/, '缺添加行');
    assert.match(page, /function removeCtxOverrideRow\(/, '缺删除行');
    assert.match(page, /function projectCtxOverrideRows\(/, '缺投影函数');
    assert.match(page, /projectContextWindowOverrides\(/, '未消费 shared 纯函数');
    assert.match(page, /store\.config\.contextWindowByAlias = map/, '投影未写入 config 字段');
  });
  await check('种子化：挂载时从 config.contextWindowByAlias 回填行（编辑既有覆盖）', () => {
    assert.match(page, /function seedCtxOverrideRows\(/, '缺种子函数');
    assert.match(page, /seedCtxOverrideRows\(\);/, '种子函数未被调用');
    const seedIdx = page.indexOf('function seedCtxOverrideRows');
    const body = page.slice(seedIdx, seedIdx + 400);
    assert.match(body, /store\.config\.contextWindowByAlias/, '种子未读 config 字段');
  });
  await check('既有保存链不回退：字段在 PERSISTED_FIELDS 自动保存快照内', () => {
    assert.match(page, /'contextWindowByAlias', 'defaultThinkingLevel'/, '字段不在持久化清单');
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
