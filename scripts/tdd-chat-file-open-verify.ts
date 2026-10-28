// tdd-chat-file-open-verify.ts
// P3（聊天流生成文件 chip 可点击打开 + FS_OPEN_PATH 新通道，2026-10-27 五问题计划 round-001 p3）
// 静态源钉：
//   ① ToolCallBlock.vue：Write/Edit/MultiEdit/NotebookEdit 折叠态 basename 升级为可点击文件 chip
//     （head 是原生 button → chip 用 role="button" 的 span，不嵌套 button）+ 迷你菜单两项
//     （tool-row 级、controls wrapper 外）+ exportMode 守卫 + FILE_TOOLS 家族字面 + 监听器清理；
//   ② FS_OPEN_PATH 新通道三处同步 + handler 注册（ipc.ts / preload/api.ts 类型+实现 / web-bridge.ts /
//     ipc-handlers.ts）——wiring 键集对等（tdd-web-access-wiring-verify）另覆盖双向完备性，此钉防漂移；
//   ③ changes-panel.ts openAbsoluteFile 守卫链（isAbsolute / realpathSync / isFile / choose 复用 p4 helper）；
//   ④ selftest 清单登记。
// F2/M1（round-002 修复）：位置断言由裸 \n needle（CRLF 下恒真空转 / LF 下误报）改为行尾归一 + div 配平扫描
//   （CRLF/LF 皆稳，含 filetoast）；卸载清理钉随 M1 改为块体正则（fileToastTimer clearTimeout + removeEventListener）。
// 运行：npx tsx scripts/tdd-chat-file-open-verify.ts（已登记 scripts/selftest-static-list.txt）

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
// R1-F8：提取样式块断言定位属性（手法同 tdd-update-dialog-autoheight-verify.ts，selector 特殊字符转义内置）。
function extractCssBlock(src: string, selector: string): string {
  const m = src.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `未找到样式块 ${selector}`);
  return m[1];
}
const block = read('../src/renderer/components/chat/ToolCallBlock.vue');
const ipcConst = read('../src/shared/types/ipc.ts');
const preload = read('../src/preload/api.ts');
const webBridge = read('../src/renderer/web/web-bridge.ts');
const handlers = read('../src/main/ipc-handlers.ts');
const panel = read('../src/main/modules/changes-panel.ts');
const selftestList = read('selftest-static-list.txt');
const card = read('../src/renderer/components/chat/TurnFileChangesCard.vue');
const turnDiff = read('../src/main/modules/turn-diff.ts');

console.log('\n=== P3-① ToolCallBlock.vue：文件 chip + 迷你菜单 + 守卫 ===');
check('FILE_TOOLS 家族字面恰含 Write/Edit/MultiEdit/NotebookEdit 四工具', () => {
  assert.ok(
    block.includes("['Write', 'Edit', 'MultiEdit', 'NotebookEdit']"),
    '缺 FILE_TOOLS 四工具名字面',
  );
});
check('filePath computed 取 input.file_path ?? input.notebook_path（家族口径）', () => {
  assert.ok(block.includes('.file_path ?? (input as Record<string, unknown>).notebook_path'), '缺 file_path/notebook_path 取值');
});
check('chip：head 内 role="button" span（不嵌套 button）+ @click.stop + exportMode 守卫', () => {
  assert.ok(block.includes('class="tool-row__file" role="button"'), '缺 tool-row__file chip（role="button"）');
  assert.ok(block.includes('@click.stop'), 'chip 缺 @click.stop（防触发 head 折叠）');
  assert.ok(block.includes('!exportMode && (fileMenuOpen = !fileMenuOpen)'), '缺 exportMode 守卫');
  assert.ok(block.includes('@keydown.enter.stop.prevent'), 'chip 缺键盘可达性（enter 开菜单）');
  assert.ok(block.includes('@keydown.space.stop.prevent'), 'chip 缺键盘可达性（space 开菜单）');
});
check('R1-F8：.tool-row__filemenu 样式块含 left: 0; + top: 100%;（菜单贴 chip 下拉定位）', () => {
  const css = extractCssBlock(block, '.tool-row__filemenu');
  assert.ok(css.includes('left: 0;'), 'filemenu 缺 left: 0;');
  assert.ok(css.includes('top: 100%;'), 'filemenu 缺 top: 100%;');
});
check('菜单在 tool-row 级（controls wrapper 之外）：双 menuitem default/choose', () => {
  const norm = block.replace(/\r\n/g, '\n');
  assert.ok(norm.includes('tool-row__filemenu'), '缺 tool-row__filemenu 菜单');
  assert.ok(norm.includes("@click=\"openGeneratedFile('default')\""), '缺 default menuitem');
  assert.ok(norm.includes("@click=\"openGeneratedFile('choose')\""), '缺 choose menuitem');
  // 菜单/toast div 必须在 controls wrapper 关闭之后：行尾归一后从 wrapper 起点做 div 配平扫描定位关闭位。
  const controlsStart = norm.indexOf('<div class="tool-row__controls">');
  assert.ok(controlsStart >= 0, '缺 tool-row__controls wrapper');
  let depth = 0;
  let controlsEnd = -1;
  for (let i = controlsStart; i < norm.length; i++) {
    if (norm.startsWith('<div', i)) { depth++; i += 3; continue; }
    if (norm.startsWith('</div>', i)) { depth--; if (depth === 0) { controlsEnd = i; break; } i += 4; }
  }
  assert.ok(controlsEnd > controlsStart, 'controls wrapper 关闭位定位失败');
  const menuPos = norm.indexOf('tool-row__filemenu');
  const toastPos = norm.indexOf('tool-row__filetoast');
  assert.ok(menuPos > controlsEnd, 'filemenu 未在 controls wrapper 之外');
  assert.ok(toastPos > controlsEnd, 'filetoast 未在 controls wrapper 之外');
});
check('打开调用走 fsOpenPath 且 toast 双态（成功文案含文件名 / 失败回显 message）', () => {
  assert.ok(block.includes('window.claudeLink.fsOpenPath(filePath.value, mode)'), '缺 fsOpenPath 调用');
  assert.ok(block.includes('已调起打开方式'), '缺 choose 成功文案');
  assert.ok(block.includes('已打开 '), '缺 default 成功文案');
  assert.ok(block.includes('res.message'), '失败未回显 message');
});
check('菜单外点关闭监听器：watch 挂载 + onBeforeUnmount 清理（不泄漏）', () => {
  assert.ok(/import \{[^}]*onBeforeUnmount[^}]*\} from 'vue'/.test(block), 'vue import 缺 onBeforeUnmount');
  assert.ok(block.includes("document.addEventListener('pointerdown', onFileMenuDocDown)"), '缺外点关闭监听');
  assert.ok(/onBeforeUnmount\(\(\) => \{[\s\S]*?clearTimeout\(fileToastTimer\)[\s\S]*?removeEventListener\('pointerdown', onFileMenuDocDown\)[\s\S]*?\}\)/.test(block), '缺卸载清理（timer + 监听器）');
});

console.log('\n=== P3-② FS_OPEN_PATH 通道三处同步 + handler 注册 ===');
check("ipc.ts 含 FS_OPEN_PATH: 'fs:openPath'", () => {
  assert.ok(ipcConst.includes("FS_OPEN_PATH: 'fs:openPath'"), 'ipc 常量缺失');
});
check('preload/api.ts 含 fsOpenPath 类型 + 实现两处', () => {
  assert.ok(preload.includes('fsOpenPath: (absPath: string, mode'), 'preload 类型缺失');
  assert.ok(preload.includes('fsOpenPath: (absPath, mode) => ipcRenderer.invoke(IPC_CHANNELS.FS_OPEN_PATH, absPath, mode)'), 'preload 实现缺失');
});
check('web-bridge.ts 表项 fsOpenPath: IPC_CHANNELS.FS_OPEN_PATH', () => {
  assert.ok(webBridge.includes('fsOpenPath: IPC_CHANNELS.FS_OPEN_PATH'), 'web-bridge 表项缺失');
});
check('ipc-handlers.ts 注册 IPC_CHANNELS.FS_OPEN_PATH handler', () => {
  assert.ok(handlers.includes('regInvokeHandler(IPC_CHANNELS.FS_OPEN_PATH'), 'handler 注册缺失');
});

console.log('\n=== P3-③ changes-panel.ts openAbsoluteFile 守卫链 ===');
check('openAbsoluteFile 导出且守卫链齐备（isAbsolute/realpathSync/isFile/choose 复用）', () => {
  assert.ok(panel.includes('export async function openAbsoluteFile('), '缺 openAbsoluteFile 导出');
  assert.ok(panel.includes('path.isAbsolute(absPath)'), '缺绝对路径守卫');
  assert.ok(panel.includes('fs.realpathSync(absPath)'), '缺 symlink 穿透');
  assert.ok(panel.includes('st.isFile()'), '缺常规文件守卫');
  assert.ok(panel.includes('if (mode === \'choose\') return openChooseDialog(abs)'), 'choose 未复用 p4 helper');
});

console.log('\n=== P3-④ selftest 清单登记 ===');
check('selftest-static-list.txt 已登记本脚本', () => {
  assert.ok(selftestList.includes('scripts/tdd-chat-file-open-verify.ts'), '清单未登记');
});

console.log('\n=== P3-⑤ R1-F9 注释同步：mode 徽标注释 + turn-diff 文件头口径块 ===');
check('两处注释均已同步 intent 语义（徽标注释含 intent（muted）+ 文件头含 intent 兜底路径）', () => {
  assert.ok(card.includes('intent → 意图合成（muted）'), '徽标注释缺 intent（muted）语义');
  assert.ok(turnDiff.includes('after 为 null 且入参可用时按意图合成'), '文件头口径块缺 intent 兜底语义');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
