// tdd-bugfix-g2-jsonschema-form-types-verify.ts
// G2（P2）契约钉：fieldsFromJsonSchema 类型适配缺口——number/integer 落 text、array 落 text、
// 数值 enum 被 `filter(item is string)` 清空（选项全无）。表单失真让子代理/工具的结构化提问
// 退化为自由文本，用户无法按 schema 正确作答。
//
// 修复语义：
// ① number/integer → 数值输入（renderer 产出 string，提交侧按 numeric 标记转回数值）；
// ② array → textarea（每行一项/自由文本形态）；
// ③ 数值 enum 保序透传为 select（选项 id/label=String(value)，提交侧转回数值）；
// ④ dialogResultFromInteraction 按 payload 字段标记把数值字段转回 number。
//
// 运行：npx tsx scripts/tdd-bugfix-g2-jsonschema-form-types-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
process.env.CLAUDE_LINK_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-g2form-ud-'));

const Module = require('module');
const origLoad = Module._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (req: string, parent: NodeJS.Module | undefined, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

(async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const interactions = require('../src/main/modules/sdk-interactions');
  const { fieldsFromJsonSchema, dialogResultFromInteraction } = interactions;

  check('① fieldsFromJsonSchema 已导出（行为可测）', () => {
    assert.equal(typeof fieldsFromJsonSchema, 'function');
  });

  const fields = (schema: Record<string, unknown>) =>
    fieldsFromJsonSchema({ properties: schema, required: [] });

  check('② number/integer → 数值输入（numeric 标记）', () => {
    const [num, int] = fields({ n: { type: 'number' }, i: { type: 'integer', title: 'Int 字段' } });
    assert.equal(num.type, 'number', String(num.type));
    assert.equal(num.numeric, true);
    assert.equal(int.type, 'number', String(int.type));
    assert.equal(int.label, 'Int 字段');
  });

  check('③ array → textarea', () => {
    const [f] = fields({ list: { type: 'array', description: '每行一项' } });
    assert.equal(f.type, 'textarea', String(f.type));
  });

  check('④ 数值 enum 保序透传为 select（String 化选项 + numeric 标记）', () => {
    const [f] = fields({ size: { type: 'number', enum: [3, 1, 2] } });
    assert.equal(f.type, 'select', String(f.type));
    assert.deepEqual(f.options?.map((o: { id: string }) => o.id), ['3', '1', '2'], JSON.stringify(f.options));
    assert.equal(f.numeric, true);
  });

  check('⑤ 字符串 enum 行为不回退（仍 select、非 numeric）', () => {
    const [f] = fields({ mode: { enum: ['fast', 'slow'] } });
    assert.equal(f.type, 'select');
    assert.deepEqual(f.options?.map((o: { id: string }) => o.id), ['fast', 'slow']);
    assert.notEqual(f.numeric, true);
  });

  check('⑥ boolean → checkbox 不回退', () => {
    const [f] = fields({ flag: { type: 'boolean' } });
    assert.equal(f.type, 'checkbox');
  });

  check('⑦ 提交侧：numeric 字段 string → number 转回', () => {
    const result = dialogResultFromInteraction(
      { action: 'submit', fieldValues: { n: '5', empty: '', text: 'abc', mode: 'fast' } } as never,
      {
        fields: [
          { id: 'n', label: 'n', type: 'number', numeric: true },
          { id: 'mode', label: 'mode', type: 'select', numeric: true },
          { id: 'empty', label: 'empty', type: 'number', numeric: true },
          { id: 'text', label: 'text', type: 'text' },
        ],
      } as never,
    );
    assert.deepEqual(result, { n: 5, empty: '', text: 'abc', mode: 'fast' }, JSON.stringify(result));
  });

  check('⑧ 无 payload 时 dialogResultFromInteraction 行为不回退', () => {
    assert.deepEqual(dialogResultFromInteraction({ action: 'submit', fieldValues: { a: '1' } } as never), { a: '1' });
    assert.deepEqual(dialogResultFromInteraction({ action: 'submit', otherText: 'x' } as never), { response: 'x' });
    assert.deepEqual(dialogResultFromInteraction({ action: 'submit' } as never), { acknowledged: true });
  });

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
