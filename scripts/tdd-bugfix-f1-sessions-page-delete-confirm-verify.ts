// tdd-bugfix-f1-sessions-page-delete-confirm-verify.ts
// F1（P2，横切复查 2026-09-08）契约钉：会话管理页单条删除无确认——卡片「删除」按钮原本
// 直接 @click.stop="store.deleteSession(session.id)"，而同链路另两个入口（侧栏单删
// AppSidebar、同页批量删除 confirmBatchDelete）都有 requestConfirm（danger）确认。
// 删除是不可逆物理删除（停 query/队列 → DELETE 级联删库 → 清理附件物理文件），
// 一次误点即永久丢失，三入口守卫必须一致。
//
// 修复语义：卡片删除改走 confirmDelete → interactionStore.requestConfirm（danger，
// 文案对齐 AppSidebar 单删版）→ 确认后才 store.deleteSession。
//
// 运行：npx tsx scripts/tdd-bugfix-f1-sessions-page-delete-confirm-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const pagePath = path.join(repoRoot, 'src/renderer/pages/SessionsPage.vue');
const sidebarPath = path.join(repoRoot, 'src/renderer/components/layout/AppSidebar.vue');
const page = fs.readFileSync(pagePath, 'utf8');
const sidebar = fs.readFileSync(sidebarPath, 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: (() => void) | boolean): void {
  try {
    if (typeof cond === 'function') cond();
    else if (!cond) throw new Error('断言为假');
    pass += 1; console.log(`  ✅ ${name}`);
  }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

console.log('=== F1 会话管理页单条删除确认 ===');
{
  // 模板：删除按钮不再直连物理删除 IPC
  check('模板删除按钮不再直接调 store.deleteSession', !page.includes('@click.stop="store.deleteSession'));
  check('模板删除按钮改走 confirmDelete(session)', /@click\.stop="confirmDelete\(session\)"/.test(page));

  // 脚本：confirmDelete 存在且先 requestConfirm（danger）后删除
  const fnAt = page.indexOf('async function confirmDelete(session:');
  check('confirmDelete 函数存在', fnAt !== -1);
  if (fnAt !== -1) {
    const body = page.slice(fnAt, page.indexOf('}', page.indexOf('store.deleteSession', fnAt)) + 1);
    check('confirmDelete 走 interactionStore.requestConfirm', body.includes('interactionStore.requestConfirm({'));
    check('确认框为 danger 档', body.includes('danger: true'));
    check('确认文案标题为「删除会话」', body.includes("title: '删除会话'"));
    check('确认文案声明不可撤销', body.includes('此操作不可撤销'));
    check('确认通过后才 store.deleteSession', /if \(ok\) await store\.deleteSession\(session\.id\);/.test(body));
  }

  // 文案与侧栏单删版逐字对齐（同一确认语义，不另造第二套文案）
  const sidebarMsg = sidebar.match(/message: (`[^`]*`)/)?.[1];
  const pageMsg = page.match(/message: (`[^`]*`)/)?.[1];
  check('单删确认文案与 AppSidebar 单删版逐字一致', sidebarMsg !== undefined && pageMsg === sidebarMsg);

  // 回归：同页批量删除确认未被波及
  check('批量删除确认（confirmBatchDelete）仍带 requestConfirm danger', /confirmBatchDelete[\s\S]{0,400}requestConfirm\(\{[\s\S]{0,400}danger: true/.test(page));
  // 回归：interactionStore 引用仍在（原有依赖不回退）
  check('useInteractionStore 引用保留', page.includes('useInteractionStore()'));
}

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
