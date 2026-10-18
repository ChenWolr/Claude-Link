// tdd-fs-picker-file-ops.ts
// 「选目录弹窗文件操作补齐」P1 契约钉：共享名称规则单源（src/shared/fs-name-rules.ts）+
// 主进程同目录重命名（src/main/modules/fs-picker.ts 的 renamePath，纯 node 不 import electron）。
// A 组：真实临时目录运行时行为（mkdtemp 随机后缀防并行撞名，结束 rmSync 递归强制清理）；
// B 组：源码文本静态断言（B1-B3：renamePath 存在 / 无 electron import / 共享模块零 import；
// B4-B7：P2 IPC 三通道 / preload 三绑定 / channel 字面量 / README 计数；
// B8：round-001 fix1——FS_TRASH/FS_SHOW_IN_EXPLORER 对象载荷解构 + FsRenameResult 类型单源）；
// D 组：源码文本静态断言（P5 右键菜单 / 刷新 F5 / 在资源管理器中显示 / F2/Del/F5 三分支；
// D3：round-002 fix2——Enter 键盘守卫五态钉）。
//
// 运行：npx tsx scripts/tdd-fs-picker-file-ops.ts

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeInvalidFsItemName, FS_ITEM_NAME_MAX, isValidFsItemName } from '../src/shared/fs-name-rules';
import { renamePath } from '../src/main/modules/fs-picker';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main(): Promise<void> {
  // ── ① fs-name-rules：共享名称规则（文案单源，逐字沿用 save-file confirmSave 现文案）──
  console.log('\n[1] fs-name-rules 共享名称规则');
  check('FS_ITEM_NAME_MAX === 255', FS_ITEM_NAME_MAX === 255);
  check('合法名 true（中文名/带扩展名）', isValidFsItemName('新建文件夹') && isValidFsItemName('a.md'));
  check('恰好 255 长度 true', isValidFsItemName('a'.repeat(255)));
  check('空名 isValid false', !isValidFsItemName(''));
  check('空名 describe null（空名由调用方自己提示）', describeInvalidFsItemName('') === null);
  check('合法名 describe null', describeInvalidFsItemName('abc') === null);
  check('尾点 → 非法字符文案逐字', describeInvalidFsItemName('a.') === '名称含非法字符（\\ / : * ? " < > |），或以点/空格结尾');
  check('非法字符 → 文案逐字（a:b）', describeInvalidFsItemName('a:b') === '名称含非法字符（\\ / : * ? " < > |），或以点/空格结尾');
  check('超长 → 文案逐字', describeInvalidFsItemName('a'.repeat(256)) === '名称过长（上限 255 字符）');
  check('非 string describe → 非法字符文案逐字（防御与 isValid 对齐）',
    describeInvalidFsItemName(undefined as unknown as string) === '名称含非法字符（\\ / : * ? " < > |），或以点/空格结尾');

  // ── A 组：renamePath 运行时（真实临时目录，随机后缀防并行撞名）──
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-ops-'));
  try {
    console.log('\n[A1] 重命名目录成功');
    const dirA = path.join(fixtureRoot, 'a');
    fs.mkdirSync(dirA);
    fs.writeFileSync(path.join(dirA, 'inner.txt'), 'keep-me');
    const r1 = await renamePath(dirA, 'b');
    check('A1 目录 a→b → ok', r1.ok, JSON.stringify(r1));
    check('A1 新路径存在且为目录', r1.ok && fs.existsSync(r1.path) && fs.statSync(r1.path).isDirectory());
    check('A1 旧路径不存在', r1.ok && !fs.existsSync(dirA));
    check('A1 内容随迁', r1.ok && fs.readFileSync(path.join(r1.path, 'inner.txt'), 'utf8') === 'keep-me');

    console.log('\n[A2] 重命名文件成功');
    const fileX = path.join(fixtureRoot, 'x.txt');
    fs.writeFileSync(fileX, 'content-x');
    const r2 = await renamePath(fileX, 'y.md');
    check('A2 文件 x.txt→y.md → ok', r2.ok, JSON.stringify(r2));
    check('A2 新文件存在且旧文件消失', r2.ok && fs.existsSync(path.join(fixtureRoot, 'y.md')) && !fs.existsSync(fileX));
    check('A2 返回路径 = 父目录/y.md', r2.ok && r2.path === path.join(fixtureRoot, 'y.md'));

    console.log('\n[A3] 同名 no-op');
    const dirC = path.join(fixtureRoot, 'c-dir');
    fs.mkdirSync(dirC);
    fs.writeFileSync(path.join(dirC, 'f.txt'), 'same-content');
    const r3 = await renamePath(dirC, 'c-dir');
    check('A3 同名 → ok', r3.ok, JSON.stringify(r3));
    check('A3 返回旧路径（no-op 不换路径）', r3.ok && r3.path === dirC);
    check('A3 目录与内容原样在', fs.existsSync(dirC) && fs.readFileSync(path.join(dirC, 'f.txt'), 'utf8') === 'same-content');

    console.log('\n[A4] 大小写-only 放行');
    const dirCase = path.join(fixtureRoot, 'case');
    fs.mkdirSync(dirCase);
    const r4 = await renamePath(dirCase, 'CASE');
    check('A4 case→CASE → ok（Windows 大小写不敏感放行）', r4.ok, JSON.stringify(r4));
    check('A4 重读目录可见 CASE', r4.ok && fs.readdirSync(fixtureRoot).includes('CASE'));

    console.log('\n[A5] 冲突 → exists');
    fs.mkdirSync(path.join(fixtureRoot, 'd1'));
    fs.mkdirSync(path.join(fixtureRoot, 'd2'));
    const r5 = await renamePath(path.join(fixtureRoot, 'd1'), 'd2');
    check('A5 目标已存在 → { ok:false, error:exists }', !r5.ok && r5.error === 'exists', JSON.stringify(r5));
    check('A5 冲突双方均未受损', fs.existsSync(path.join(fixtureRoot, 'd1')) && fs.existsSync(path.join(fixtureRoot, 'd2')));

    console.log('\n[A6] 非法名参数化（校验先于触盘，oldPath 取既有目录）');
    const dirD1 = path.join(fixtureRoot, 'd1');
    const badNames: string[] = [
      '', '.', '..', 'a/b', String.raw`a\b`, 'a:b', 'a*b', 'a?', 'a"', 'a<', 'a|', 'a.', 'a ', 'x'.repeat(256),
    ];
    for (const bad of badNames) {
      const r = await renamePath(dirD1, bad);
      check(`A6 ${JSON.stringify(bad)} → invalid-name`, !r.ok && r.error === 'invalid-name', JSON.stringify(r));
    }
    check('A6 参数化清单共 14 条', badNames.length === 14);

    console.log('\n[A6-order] fix2 钉序：校验先于触盘（源不存在 + 非法名）');
    // 组合断言：ghost 源（不创建）+ 非法名 → 必须返回 invalid-name 而非 not-found。
    // 若实现改为先 stat 后校验，此处会变 not-found → 断言红，即达钉序目的（回归钉）。
    const rOrder = await renamePath(path.join(fixtureRoot, 'ghost-order-pin'), 'a/b');
    check('A6 校验先于触盘：ghost 源 + 非法名 → invalid-name（非 not-found）',
      !rOrder.ok && rOrder.error === 'invalid-name', JSON.stringify(rOrder));

    console.log('\n[A7] 源不存在');
    const r7 = await renamePath(path.join(fixtureRoot, 'ghost'), 'x');
    check('A7 不存在路径 → not-found', !r7.ok && r7.error === 'not-found', JSON.stringify(r7));
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }

  // ── B 组：静态断言（读源码文本）──
  console.log('\n[B] 静态断言');
  const repoRoot = path.resolve(__dirname, '..');
  const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
  const pickerSrc = read('src/main/modules/fs-picker.ts');
  check('B1 fs-picker.ts 含 export async function renamePath', pickerSrc.includes('export async function renamePath'));
  check("B2 fs-picker.ts 不含 from 'electron'", !pickerSrc.includes("from 'electron'"));
  const rulesSrc = read('src/shared/fs-name-rules.ts');
  check('B3 fs-name-rules.ts 零 import（无 from/require）', !/\bfrom\s|require\(/.test(rulesSrc));

  // ── B4-B7：P2 IPC 三通道 + preload 桥接 + 计数同步（docs/plans/2026-10-14-picker-file-ops-idea-parity-plan.md §2 P2）──
  console.log('\n[B4-B7] P2 IPC 三通道 / preload 桥接 / README 计数');
  const handlersSrc = read('src/main/ipc-handlers.ts');
  check('B4 ipc-handlers.ts 含 IPC_CHANNELS.FS_RENAME', handlersSrc.includes('IPC_CHANNELS.FS_RENAME'));
  check('B4 ipc-handlers.ts 含 IPC_CHANNELS.FS_TRASH', handlersSrc.includes('IPC_CHANNELS.FS_TRASH'));
  check('B4 ipc-handlers.ts 含 IPC_CHANNELS.FS_SHOW_IN_EXPLORER', handlersSrc.includes('IPC_CHANNELS.FS_SHOW_IN_EXPLORER'));
  check('B4 ipc-handlers.ts 含 shell.trashItem', handlersSrc.includes('shell.trashItem'));
  check('B4 ipc-handlers.ts 含 shell.showItemInFolder', handlersSrc.includes('shell.showItemInFolder'));
  const preloadSrc = read('src/preload/api.ts');
  check('B5 preload fsRename 绑定（对象载荷走 FS_RENAME）',
    preloadSrc.includes('fsRename: (oldPath, newName) => ipcRenderer.invoke(IPC_CHANNELS.FS_RENAME, { oldPath, newName })'));
  check('B5 preload fsTrash 绑定（对象载荷走 FS_TRASH）',
    preloadSrc.includes('fsTrash: (paths) => ipcRenderer.invoke(IPC_CHANNELS.FS_TRASH, { paths })'));
  check('B5 preload fsShowInExplorer 绑定（对象载荷走 FS_SHOW_IN_EXPLORER）',
    preloadSrc.includes('fsShowInExplorer: (path) => ipcRenderer.invoke(IPC_CHANNELS.FS_SHOW_IN_EXPLORER, { path })'));
  // 计数快照随点 E（2026-10-17 P8 双向写入）新增 writeMcpScoped 同步：97→98（README handle
  // 计数一并校准为实数 77——点 D 加 TASK_OUTPUT_READ 时 75 未同步，本点补齐）。
  check('B5 preload 头注释含「99 个方法」', preloadSrc.includes('99 个方法'));
  const ipcTypesSrc = read('src/shared/types/ipc.ts');
  check("B6 ipc.ts 含 'fs:rename' 字面量", ipcTypesSrc.includes("'fs:rename'"));
  check("B6 ipc.ts 含 'fs:trash' 字面量", ipcTypesSrc.includes("'fs:trash'"));
  check("B6 ipc.ts 含 'fs:showInExplorer' 字面量", ipcTypesSrc.includes("'fs:showInExplorer'"));
  const readmeSrc = read('README.md');
  check('B7 README.md 含「79 个 handle」', readmeSrc.includes('79 个 handle'));
  check('B7 README.md 含「99 方法」', readmeSrc.includes('99 方法'));

  // ── B8：round-001 fix1 验收修复钉（2026-10-15）──
  // preload 三绑定（B5）发的是对象载荷（{paths}/{path}），主进程 handler 必须以 req 对象解构
  // 读取——裸值校验会形状错配静默断链（FS_TRASH 恒温和拒绝 / FS_SHOW 恒 throw），静态文本断言
  // 钉住签名与解构读取防回归；FsRenameResult 类型单源（fs-picker.ts 不再保留本地过渡定义）。
  console.log('\n[B8] fix1：FS_TRASH/FS_SHOW 对象载荷解构 + FsRenameResult 类型单源');
  check('B8a FS_TRASH handler 对象载荷签名（_event, req: unknown）', handlersSrc.includes('IPC_CHANNELS.FS_TRASH, async (_event, req: unknown)'));
  check('B8a FS_SHOW_IN_EXPLORER handler 对象载荷签名（_event, req: unknown）', handlersSrc.includes('IPC_CHANNELS.FS_SHOW_IN_EXPLORER, async (_event, req: unknown)'));
  check('B8b ipc-handlers.ts 含 r.paths（FS_TRASH 对象解构读取）', (handlersSrc.match(/r\.paths/g) ?? []).length >= 1);
  check('B8b ipc-handlers.ts 含 r.path（FS_SHOW 对象解构读取，\\b 不误计 r.paths）', (handlersSrc.match(/r\.path\b/g) ?? []).length >= 1);
  check('B8c fs-picker.ts 不再含本地 export type FsRenameResult（类型单源）', !pickerSrc.includes('export type FsRenameResult'));

  // ── D 组：P5 右键菜单 + 刷新 + 在资源管理器中显示（docs/plans/2026-10-14-picker-file-ops-idea-parity-plan.md §2 P5）──
  console.log('\n[D1-D2] P5 右键菜单 / 刷新 / 在资源管理器中显示');
  const dialogSrc = read('src/renderer/components/common/FilePickerDialog.vue');
  check('D1 FilePickerDialog.vue 含 @contextmenu（行/空白两形态至少一处）', dialogSrc.includes('@contextmenu'));
  check('D1 FilePickerDialog.vue 含 fsShowInExplorer(', (dialogSrc.match(/fsShowInExplorer\(/g) ?? []).length >= 1);
  check('D1 FilePickerDialog.vue 含 fsRename(', (dialogSrc.match(/fsRename\(/g) ?? []).length >= 1);
  check('D1 FilePickerDialog.vue 含 fsTrash(', (dialogSrc.match(/fsTrash\(/g) ?? []).length >= 1);
  check("D2 FilePickerDialog.vue 含 e.key === 'F2' 分支", dialogSrc.includes("e.key === 'F2'"));
  check("D2 FilePickerDialog.vue 含 e.key === 'Delete' 分支", dialogSrc.includes("e.key === 'Delete'"));
  check("D2 FilePickerDialog.vue 含 e.key === 'F5' 分支", dialogSrc.includes("e.key === 'F5'"));
  // D3（round-002 fix2）：Enter 守卫五态钉——覆盖确认视图/新建行/重命名行之外，删除确认条
  // （deletePending，聚焦确认钮）与右键菜单（ctxMenu，聚焦首菜单项）在场时 Enter 必须让位给
  // 聚焦元素原生行为；缺任一态则聚焦按钮上 Enter 被 preventDefault 后被 activateCursor 劫持。
  check('D3 Enter 守卫五态（renaming || deletePending || ctxMenu 串联在场）',
    dialogSrc.includes('renaming.value || deletePending.value || ctxMenu.value'));

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('脚本执行异常：', err);
  process.exit(1);
});
