// tdd-bugfix-n3-ime-composing-guard-verify.ts
// N3（P2）契约钉：ChatInput 无 isComposing 守卫——中文输入法组词确认回车会派发
// key==='Enter' && isComposing===true 的 keydown → 菜单开时误执行 selectSlashCommand、
// 关时误 submit() 半成品草稿。全 renderer 此前零 isComposing 命中。
//
// 修复语义：handleKeydown 两处 Enter 分支（菜单选命令 / submit）入口加
// `if (e.isComposing) return;`——组词期间的回车属于 IME 确认，不是提交意图。
//
// 运行：npx tsx scripts/tdd-bugfix-n3-ime-composing-guard-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const chatInput = fs.readFileSync(path.join(repoRoot, 'src/renderer/components/chat/ChatInput.vue'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const fnAt = chatInput.indexOf('function handleKeydown');
const fnEnd = chatInput.indexOf('function selectSlashCommand');
const handleKeydown = fnAt > -1 && fnEnd > fnAt ? chatInput.slice(fnAt, fnEnd) : '';
const menuEnterAt = handleKeydown.indexOf("e.key === 'Enter' && !e.shiftKey");
const submitEnterAt = menuEnterAt > -1
  ? handleKeydown.indexOf("e.key === 'Enter' && !e.shiftKey", menuEnterAt + 1)
  : -1;

check('① handleKeydown 存在（夹具自检）', fnAt > -1 && menuEnterAt > -1 && submitEnterAt > menuEnterAt);
check('② 菜单选命令 Enter 分支入口有 isComposing 守卫',
  menuEnterAt > -1
  && handleKeydown.slice(menuEnterAt, menuEnterAt + 200).includes('if (e.isComposing) return;'));
check('③ submit Enter 分支入口有 isComposing 守卫',
  submitEnterAt > -1
  && handleKeydown.slice(submitEnterAt, submitEnterAt + 200).includes('if (e.isComposing) return;'));

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
