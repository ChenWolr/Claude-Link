// tdd-bugfix-p3-08-form-checkbox-false-verify.ts
// P3-8 契约钉：表单 required 布尔字段无法回答 false——canSubmit 用 Boolean(value) 判空，
// checkbox 默认 false 恒不满足 required。
//
// 修复语义：required checkbox 改「已交互过」判定（touchedCheckboxFields：initFields 清空、
// change 事件登记），false 亦是有效答案；其余字段维持判空。
//
// 运行：npx tsx scripts/tdd-bugfix-p3-08-form-checkbox-false-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(repoRoot, 'src/renderer/components/chat/InteractionPrompt.vue'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

check('① 存在 touchedCheckboxFields 已交互登记表', () => {
  assert.match(src, /const touchedCheckboxFields = ref<Set<string>>\(new Set\(\)\);/);
});
check('② initFields 重置登记表（切请求不残留）', () => {
  const at = src.indexOf('function initFields');
  assert.match(src.slice(at, at + 400), /touchedCheckboxFields\.value = new Set\(\);/);
});
check('③ canSubmit：required checkbox 按已交互判定；其余字段判空（语义收窄不全删）', () => {
  const at = src.indexOf('if (hasStructuredForm.value) {');
  const seg = src.slice(at, at + 400);
  assert.match(seg, /field\.type === 'checkbox'\) return touchedCheckboxFields\.value\.has\(field\.id\)/);
  assert.match(seg, /return Boolean\(fieldValues\.value\[field\.id\]\)/);
});
check('④ checkbox change 事件登记已交互', () => {
  assert.match(src, /@change="touchedCheckboxFields\.add\(field\.id\)"/);
});
check('⑤ 非提交路径不回退（v-model checkbox 保留）', () => {
  assert.match(src, /v-model="fieldValues\[field\.id\]" type="checkbox"/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
