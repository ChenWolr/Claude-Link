// tdd-fs-picker.ts
// 「原生弹窗统一改造」T1 契约钉：shared 层类型/常量 + 主进程 fs-picker 模块（只读文件系统元数据）。
// T3 同步：工作空间选目录通道（原生弹窗）已整链删除，删除断言入列（断言字符串按段拼接，
// 本文件不得出现完整通道名/方法名字面量——完成判定要求全仓 grep 零命中，含 scripts/）。
// T4 同步：附件选择通道（原生弹窗）同样删除——选择动作移渲染层自绘，主进程改 ATTACHMENT_STAGE_PATHS 路径暂存。
// T5 同步：导出目标协商通道上线——export-image-manager 的 performSave 不再弹原生 dialog，
// 改 EXPORT_REQUEST_TARGET（主→渲染推送）+ EXPORT_RESOLVE_TARGET（渲染→主应答）协商，
// ipc-handlers 注册 EXPORT_RESOLVE_TARGET handler（原负断言改正断言）。
// P2-1 同步：EXPORT_RESOLVE_TARGET handler 内容校验断言——save 的 filename 走 isValidFolderName、
// directory/save 的 dir 必须绝对路径（复审报告 P2-1 纵深防御契约钉）。
// P2-2 同步：enumerateDrives 由同步 existsSync 逐盘探测改异步 fsp.access + allSettled——
// 同步代码阻塞 event loop 时 withBudget 的 1s race 赢不了（timer 无法触发），异步化后预算才真实生效。
//
// 覆盖：isValidFolderName 纯函数 / listDir 排序·hidden·size·错误归一·空目录 /
// mkdir 合法名·重名·非法名·父目录不存在 / statPath 三态 / listRoots 形态 /
// IPC_CHANNELS 六通道常量 / ipc-handlers 五 handler 注册（T5 增 EXPORT_RESOLVE_TARGET）。
// 不 import Electron（被测模块 src/main/modules/fs-picker.ts 亦不得 import electron，
// 本脚本经 tsx 直跑验证该约束：import electron 会在无 Electron 运行时下挂掉）。
//
// 运行：npx tsx scripts/tdd-fs-picker.ts

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isValidFolderName, listDir, listRoots, mkdir, statPath } from '../src/main/modules/fs-picker';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main(): Promise<void> {
  // ── ① isValidFolderName（Windows 命名限制纯函数）──
  console.log('\n[1] isValidFolderName');
  check('合法名「新建文件夹」', isValidFolderName('新建文件夹'));
  check('合法名「abc」', isValidFolderName('abc'));
  check('空串 false', !isValidFolderName(''));
  for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
    check(`非法字符 ${JSON.stringify(bad)} false`, !isValidFolderName(bad));
  }
  check('以点结尾「a.」false', !isValidFolderName('a.'));
  check('以空格结尾「a 」false', !isValidFolderName('a '));
  check('超长名（255+）false', !isValidFolderName('a'.repeat(256)));
  check('恰好 255 长度 true', isValidFolderName('a'.repeat(255)));

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-fs-picker-'));
  try {
    // fixture：目录与文件混合（含中文名、.hidden、多目录多文件、有内容的文件）。
    fs.mkdirSync(path.join(fixtureRoot, '子目录甲'));
    fs.mkdirSync(path.join(fixtureRoot, 'zdir'));
    fs.mkdirSync(path.join(fixtureRoot, 'adir'));
    fs.writeFileSync(path.join(fixtureRoot, '文件乙.txt'), 'hello-fs-picker');
    fs.writeFileSync(path.join(fixtureRoot, '.hidden'), 'dot-file');
    fs.writeFileSync(path.join(fixtureRoot, 'afile.txt'), 'x');
    fs.writeFileSync(path.join(fixtureRoot, 'zfile.txt'), 'y');
    const emptyDir = path.join(fixtureRoot, 'empty-dir');
    fs.mkdirSync(emptyDir);

    // ── ② listDir 排序 / hidden / size / mtime ──
    console.log('\n[2] listDir 排序与条目元数据');
    const listed = await listDir(fixtureRoot);
    assert.ok(listed.ok, `fixture 列目录应成功：${JSON.stringify(listed)}`);
    if (!listed.ok) throw new Error('unreachable（上面已 assert）');
    check('返回 resolve 后的绝对路径', listed.path === path.resolve(fixtureRoot));
    const names = listed.entries.map((e) => e.name);
    check('包含全部 fixture 条目', ['子目录甲', 'zdir', 'adir', '文件乙.txt', '.hidden', 'afile.txt', 'zfile.txt', 'empty-dir'].every((n) => names.includes(n)), `实际: ${names.join(',')}`);
    const firstFileIdx = listed.entries.findIndex((e) => !e.isDir);
    check('目录全部排在文件前', firstFileIdx === -1 || listed.entries.slice(firstFileIdx).every((e) => !e.isDir), JSON.stringify(names));
    const dirIdx = names.indexOf('子目录甲');
    const fileIdx = names.indexOf('afile.txt');
    check('目录「子目录甲」isDir=true 排在文件「afile.txt」前', dirIdx >= 0 && fileIdx >= 0 && dirIdx < fileIdx);
    const hiddenEntry = listed.entries.find((e) => e.name === '.hidden');
    check('.hidden 的 hidden===true', !!hiddenEntry && hiddenEntry.hidden === true);
    check('普通文件 hidden===false', listed.entries.find((e) => e.name === '文件乙.txt')?.hidden === false);
    const fileEntry = listed.entries.find((e) => e.name === '文件乙.txt');
    check('有内容文件 size>0', !!fileEntry && fileEntry.size === 'hello-fs-picker'.length, `size=${fileEntry?.size}`);
    check('mtimeMs>0', !!fileEntry && fileEntry.mtimeMs > 0);
    check('目录条目 isDirectory 以 dirent 为准（子目录甲 isDir=true）', listed.entries.find((e) => e.name === '子目录甲')?.isDir === true);
    // 排序 localeCompare zh/numeric：目录组内 adir < zdir、文件组内 afile.txt < 文件乙.txt < zfile.txt
    const dirNames = listed.entries.filter((e) => e.isDir).map((e) => e.name);
    const fileNames = listed.entries.filter((e) => !e.isDir).map((e) => e.name);
    check('目录组内 localeCompare zh 升序', JSON.stringify(dirNames) === JSON.stringify([...dirNames].sort((a, b) => a.localeCompare(b, 'zh', { numeric: true, sensitivity: 'base' }))), dirNames.join(','));
    check('文件组内 localeCompare zh 升序', JSON.stringify(fileNames) === JSON.stringify([...fileNames].sort((a, b) => a.localeCompare(b, 'zh', { numeric: true, sensitivity: 'base' }))), fileNames.join(','));

    // ── ③ listDir 错误归一 ──
    console.log('\n[3] listDir 错误归一');
    const notExist = await listDir(path.join(fixtureRoot, 'no-such-dir'));
    check('不存在路径 → not-found', !notExist.ok && notExist.error === 'not-found', JSON.stringify(notExist));
    const fileAsDir = await listDir(path.join(fixtureRoot, '文件乙.txt'));
    check('普通文件路径 → not-found（ENOTDIR）', !fileAsDir.ok && fileAsDir.error === 'not-found', JSON.stringify(fileAsDir));
    const notExistPath = path.join(fixtureRoot, 'no-such-dir');
    check('失败结果携带 path', !notExist.ok && notExist.path === notExistPath);
    // timeout 分支：不造 flaky 测试——直接断言模块源码含 3s 预算 + 'timeout' 归一形态。
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'modules', 'fs-picker.ts'), 'utf8');
    check('源码含 3s 超时预算与 timeout 错误归一', src.includes('LIST_DIR_BUDGET_MS') && src.includes("'timeout'"));
    // access-denied 分支：断言源码映射形态（权限目录 fixture 在 CI/Windows 管理员下难以稳定构造）。
    check('源码含 EPERM/EACCES → access-denied 映射', /EPERM|EACCES/.test(src) && src.includes("'access-denied'"));

    // ── ④ listDir 空目录 ──
    console.log('\n[4] listDir 空目录');
    const empty = await listDir(emptyDir);
    check('空目录 → ok:true, entries:[]', empty.ok && empty.entries.length === 0, JSON.stringify(empty));

    // ── ⑤ mkdir ──
    console.log('\n[5] mkdir');
    const created = await mkdir(fixtureRoot, '新建文件夹');
    check('合法名 → ok:true', created.ok, JSON.stringify(created));
    check('目录真实出现', created.ok && fs.existsSync(created.path));
    check('返回路径 = resolve(parent, name)', created.ok && created.path === path.resolve(fixtureRoot, '新建文件夹'));
    const dup = await mkdir(fixtureRoot, '新建文件夹');
    check('重名 → exists', !dup.ok && dup.error === 'exists', JSON.stringify(dup));
    const bad1 = await mkdir(fixtureRoot, 'a/b');
    check('非法名 a/b → invalid-name', !bad1.ok && bad1.error === 'invalid-name');
    const bad2 = await mkdir(fixtureRoot, 'a.');
    check('非法名 a. → invalid-name', !bad2.ok && bad2.error === 'invalid-name');
    const noParent = await mkdir(path.join(fixtureRoot, 'no-such-parent'), 'child');
    check('父目录不存在 → not-found', !noParent.ok && noParent.error === 'not-found', JSON.stringify(noParent));

    // ── ⑥ statPath ──
    console.log('\n[6] statPath');
    const sf = await statPath(path.join(fixtureRoot, '文件乙.txt'));
    check('存在文件 exists/isDir/size', sf.exists && !sf.isDir && sf.size === 'hello-fs-picker'.length, JSON.stringify(sf));
    const sd = await statPath(path.join(fixtureRoot, '子目录甲'));
    check('存在目录 isDir=true', sd.exists && sd.isDir);
    const sn = await statPath(path.join(fixtureRoot, 'no-such-file'));
    check('不存在 → exists:false,isDir:false,size:0', !sn.exists && !sn.isDir && sn.size === 0, JSON.stringify(sn));

    // ── ⑦ listRoots ──
    console.log('\n[7] listRoots');
    const roots = await listRoots();
    check('ok:true', roots.ok);
    check('cwdHome 非空', typeof roots.cwdHome === 'string' && roots.cwdHome.length > 0);
    check('drives 每项 { 单字母, X:\\ }', roots.drives.every((d) => /^[A-Za-z]$/.test(d.letter) && /^[A-Za-z]:\\$/.test(d.path)), JSON.stringify(roots.drives));
    check('quick 每项 id/label/path 非空', roots.quick.every((q) => q.id.length > 0 && q.label.length > 0 && q.path.length > 0));
    check('quick 含主目录', roots.quick.some((q) => q.id === 'home' && q.path === roots.cwdHome));
    check('home quick 项存在才可能含 desktop/documents/downloads（不强制）', roots.quick.filter((q) => ['home', 'desktop', 'documents', 'downloads'].includes(q.id)).length >= 1);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }

  // ── ⑧ IPC 通道常量 + handler 注册（三处同步铁律的常量/注册两处）──
  console.log('\n[8] IPC_CHANNELS 常量 + handler 注册');
  const repoRoot = path.resolve(__dirname, '..');
  const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
  const ipcSrc = read('src/shared/types/ipc.ts');
  check('FS_LIST_ROOTS 常量', ipcSrc.includes("FS_LIST_ROOTS: 'fs:listRoots'"));
  check('FS_LIST_DIR 常量', ipcSrc.includes("FS_LIST_DIR: 'fs:listDir'"));
  check('FS_MKDIR 常量', ipcSrc.includes("FS_MKDIR: 'fs:mkdir'"));
  check('FS_STAT 常量', ipcSrc.includes("FS_STAT: 'fs:stat'"));
  check('EXPORT_RESOLVE_TARGET 常量', ipcSrc.includes("EXPORT_RESOLVE_TARGET: 'export-image:resolveTarget'"));
  check('EXPORT_REQUEST_TARGET 常量', ipcSrc.includes("EXPORT_REQUEST_TARGET: 'export-image:requestTarget'"));
  // T3 同步：工作空间选目录通道已删除（两入口改渲染层自绘 FilePickerDialog）。
  // 通道名/方法名按段拼接——若本脚本含完整字面量，「全仓 grep 零命中」判定会被自身命中。
  const pickDirChannel = 'WORKSPACE_' + 'PICK_DIR';
  check('工作空间选目录通道已删除（改自绘）', !ipcSrc.includes(pickDirChannel));
  const attachPickChannel = 'ATTACHMENT_' + 'PICK';
  check('附件选择通道已删除（T4 改自绘 + 路径暂存）', !ipcSrc.includes(attachPickChannel) && !ipcSrc.includes("'attachment:" + "pick'"));
  check('附件路径暂存通道常量（T4 stagePaths）', ipcSrc.includes("ATTACHMENT_STAGE_PATHS: 'attachment:stagePaths'"));
  const preloadSrc = read('src/preload/api.ts');
  check('preload 不再暴露工作空间选目录方法（T3 已删）', !preloadSrc.includes('pick' + 'WorkspaceDir'));
  check('preload 不再暴露附件原生选择方法（T4 已删）', !preloadSrc.includes('pick' + 'Attachments'));
  check('preload 暴露附件路径暂存方法（T4）', preloadSrc.includes('stageAttachmentPaths:'));
  const toolbarSrc = read('src/renderer/components/chat/SessionToolbar.vue');
  const bridgeSrc = read('src/renderer/components/config/BridgeSettings.vue');
  check('SessionToolbar/BridgeSettings 选目录入口已改自绘 openFilePicker', toolbarSrc.includes('openFilePicker') && bridgeSrc.includes('openFilePicker'));
  const handlersSrc = read('src/main/ipc-handlers.ts');
  check('附件路径暂存 handler 注册（T4 stagePaths）', handlersSrc.includes('IPC_CHANNELS.ATTACHMENT_STAGE_PATHS'));
  for (const [chan, arg] of [['FS_LIST_ROOTS', ''], ['FS_LIST_DIR', 'target'], ['FS_MKDIR', 'parent'], ['FS_STAT', 'p']] as const) {
    check(`handler 注册 ${chan}`, handlersSrc.includes(`IPC_CHANNELS.${chan}`));
  }
  check('handler 入参校验存在（Invalid directory path / Invalid mkdir arguments / Invalid path）',
    handlersSrc.includes("Invalid directory path") && handlersSrc.includes('Invalid mkdir arguments') && handlersSrc.includes('Invalid path'));
  check('EXPORT_RESOLVE_TARGET handler 已注册（T5 导出目标协商应答）', handlersSrc.includes('IPC_CHANNELS.EXPORT_RESOLVE_TARGET'));
  // P2-1（复审报告）：save 应答内容校验——filename 复用 isValidFolderName（防 '..\\..\\x.png' 穿越等）、
  // directory/save 的 dir 必须绝对路径（防相对路径落主进程 cwd）。原原生 dialog 时代由系统对话框保证。
  {
    const at = handlersSrc.indexOf('EXPORT_RESOLVE_TARGET');
    const seg = handlersSrc.slice(at, handlersSrc.indexOf('SKILL_PROJECT_DIRS_GET', at));
    check('EXPORT_RESOLVE_TARGET save 校验用 isValidFolderName + dir 绝对性（P2-1）',
      seg.includes('isValidFolderName') && seg.includes('path.isAbsolute'));
  }
  const exportManagerSrc = read('src/main/modules/export-image-manager.ts');
  check('export-image-manager 目标协商三件套（T5 request/resolve + EXPORT_REQUEST_TARGET 推送）',
    exportManagerSrc.includes('requestExportTarget') && exportManagerSrc.includes('resolveExportTarget') && exportManagerSrc.includes('IPC_CHANNELS.EXPORT_REQUEST_TARGET'));
  check('export-image-manager 已无原生 dialog（T5 源码级）', !exportManagerSrc.includes('dialog.showOpenDialog') && !exportManagerSrc.includes('dialog.showSaveDialog') && !/import \{[^}]*\bdialog\b[^}]*\} from ['"]electron['"]/.test(exportManagerSrc));
  check('preload 含 onExportTargetRequested 订阅（T5 主→渲染推送）', preloadSrc.includes('onExportTargetRequested') && preloadSrc.includes('EXPORT_REQUEST_TARGET'));
  // 被测模块不得 import electron（契约：tsx 可直跑）。
  const moduleSrc = read('src/main/modules/fs-picker.ts');
  check('fs-picker.ts 不 import electron', !/from ['"]electron['"]/.test(moduleSrc));
  // P2-2（复审报告）：enumerateDrives 原为同步 existsSync 逐盘探测，阻塞 event loop 时
  // withBudget 的 1s race 赢不了（timer 回调无法在阻塞期触发）——异步化（fsp.access +
  // allSettled）后预算才真实生效；断言模块内已无任何 existsSync 调用形态（含 quick 过滤，
  // 注释里的历史表述不算）。
  check('驱动器枚举不再用同步 existsSync（P2-2：1s 预算真实生效）',
    !moduleSrc.includes('existsSync(') && moduleSrc.includes('allSettled'));
  // 共享类型文件存在且只含类型（契约脚本可 import，不产生运行时副作用）。
  const typesSrc = read('src/shared/types/fs-picker.ts');
  check('shared 类型文件不含运行时常量（只类型）', !/export const /.test(typesSrc));

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('脚本执行异常：', err);
  process.exit(1);
});
