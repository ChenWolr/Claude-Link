// tdd-file-link-context-menu-verify.ts
// P6-B（2026-11-21 translate-fix-and-ui-points 计划）：md-file-link 左键直开改右键上下文菜单契约钉。
// 行为契约（00 唯一事实源）：任意 .md-file-link 左键零动作；右键弹 5 项菜单（预览 / 用系统默认程序
// 打开 / 选择打开方式… / 在文件夹中显示 / 复制路径）；fs:stat 预检存在性（不存在 → 「文件不存在」
// 提示 + 1/2/3/4 禁用，复制路径恒可用）；Esc/菜单外点/滚动(capture)/resize 关闭；零新 IPC
// （复用 fs:stat / fs:openPath(default|choose) / fs:showInExplorer，web-bridge 已注册）。
// 合并裁决 R2：菜单项全平台渲染，无渲染层平台分支（非 Win 由主进程 openChooseDialog 既有响应承担）。
//
// 组清单：
//   P6B-T1  菜单载体钉：FileLinkMenu.vue 存在 + Teleport body + role=menu/menuitem + 恰 5 项
//           字面 + 文件不存在提示行(role=status) + 1-4 disabled 由 exists 驱动 + 复制恒可用
//           + 关闭机制四监听 + 定位 clamp
//   P6B-T2  七组件左键零动作 + 右键委托唯一化（旧委托函数名清零、新委托同形、委托体内无
//           useFilePreview/fs 通道残留）
//   P6B-T3  死链收编：委托无 --dead 特判（与活链同一右键路径）+ store exists=false →「文件不存在」
//           + 抽屉相对路径预检错误卡字面保留（ToolCallBlock chip 相对路径来源不变）
//   P6B-T4  IPC 零新增：ipc.ts 三通道键值钉 + store/组件零 'fs:' 字面 + web-bridge 三绑定在位
//           + App.vue 挂载
//   P6B-T5  R2 裁决钉：菜单无渲染层平台判定，5 项全平台无条件渲染
//   P6B-T15 外链不劫持：七委托 closest 不命中即 return（if (!el) return 同形）
//   P6B-T16 markdown.ts 围栏不链接化断言保留（既有结构钉仍在 + markdown.ts fence 锚点仍在
//           + p6a '...' 段拒绝不回退）
//   P6B-T17 scroll 宽限窗钉（round-001 f4，用户裁决 2026-11-22）：FileLinkMenu scroll 关闭路径
//           加打开后 200ms 宽限窗——SCROLL_GRACE_MS=200 具名常量在位 + openedAt 打开刷新/关闭
//           复位生命周期 + 宽限守卫仅 scroll 处理器；resize/pointerdown/Esc 三路径负向无宽限
//           （原语义零触碰）。既有 P6B-T1 关闭机制结构钉（监听器在位 + capture: true）不受影响
//           ——宽限窗只是 onWinScroll 处理器体内提前 return，监听接线形态未变。
//           同族 smoke 测试同步钉：T12-① scroll 派发前 sleep(>200) 越过宽限窗（裁决选项 A 授权）。
//   场景代码钉：cdp-file-preview-smoke.mjs 右键化 + cdp-web-access-e2e.mjs W-file-context-menu 登记
//           （场景代码本点落定，整链由编排器收尾跑）
//   store 行为组（函数级 pinia 直测 + window.claudeLink 桩）：open 预检/exists=false 提示/竞态 seq
//           守卫/preview 关菜单开抽屉/三 fs 动作成功关菜单失败留菜单写 notice/copy 失败 notice/close 幂等
//   spawn 门：tdd-file-preview-verify（MOD 后委托钉）+ tdd-code-inline-fileref-verify（不破坏）
//   登记钉：selftest-static-list.txt 尾部登记本脚本
//
// 运行：npx tsx scripts/tdd-file-link-context-menu-verify.ts（已登记 scripts/selftest-static-list.txt）

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createPinia, setActivePinia } from 'pinia';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const MENU_REL = 'src/renderer/components/common/FileLinkMenu.vue';
const STORE_REL = 'src/renderer/stores/file-link-menu-store.ts';

// 七组件委托契约表：[文件, 旧委托名（须清零）, 新委托名（须存在）, 是否 exportMode 门控]。
const DELEGATES: ReadonlyArray<readonly [string, string, string, boolean]> = [
  ['src/renderer/components/chat/MessageBubble.vue', 'onContentClick', 'onContentContextMenu', true],
  ['src/renderer/components/chat/ToolCallBlock.vue', 'onResultClick', 'onResultContextMenu', true],
  ['src/renderer/components/chat/ThinkingBlock.vue', 'onBodyClick', 'onBodyContextMenu', true],
  ['src/renderer/components/chat/StreamRenderer.vue', 'onContentClick', 'onContentContextMenu', false],
  ['src/renderer/components/chat/TranslationViewport.vue', 'onContentClick', 'onContentContextMenu', false],
  ['src/renderer/components/task/TaskQueuePanel.vue', 'onLiveTextClick', 'onLiveTextContextMenu', false],
  ['src/renderer/components/preview/FilePreviewDrawer.vue', 'onMdLinkClick', 'onMdLinkContextMenu', false],
];

/** 提取指定函数源码体（function name ... 起至下一个顶层 function 或文件尾的粗分界）。
 *  各委托函数体短小且其后不嵌套 function 声明，以「下一个 \nfunction 」为界足够可靠。 */
function fnBody(src: string, fnName: string): string {
  const start = src.indexOf(`function ${fnName}`);
  if (start < 0) return '';
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next < 0 ? src.length : next);
}

/** store 动态导入（tsx 下 file URL 形态）；文件缺失返回 null（各行为组显式 ❌ 而非整体崩溃）。 */
async function importStore(): Promise<{ useFileLinkMenuStore: () => any } | null> {
  try {
    return (await import(pathToFileURL(path.join(repoRoot, STORE_REL)).href)) as { useFileLinkMenuStore: () => any };
  } catch {
    return null;
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

void (async (): Promise<void> => {
  console.log('\n=== P6B-T1 菜单载体钉（FileLinkMenu.vue） ===');
  let menuSrc = '';
  let menuMissing = true;
  try { menuSrc = file(MENU_REL); menuMissing = false; } catch { /* 未实施期 */ }
  check('文件存在：src/renderer/components/common/FileLinkMenu.vue', () => {
    assert.ok(!menuMissing, 'FileLinkMenu.vue 不存在（P6-B 未实施）');
  });
  check('Teleport 到 body + position:fixed + z-index 2000（低于 global-toast 3000）', () => {
    assert.ok(menuSrc.includes('<Teleport to="body">'), '缺 <Teleport to="body">');
    assert.ok(/position:\s*fixed/.test(menuSrc), '缺 position: fixed');
    assert.ok(/z-index:\s*2000/.test(menuSrc), '缺 z-index: 2000');
  });
  check('v-if="visible" + role="menu" + 菜单项 role="menuitem"（对齐 ToolCallBlock filemenu 先例）', () => {
    assert.ok(menuSrc.includes('v-if="visible"'), '菜单未以 store.visible 门控渲染（v-if="visible"）');
    assert.ok(menuSrc.includes('role="menu"'), '缺 role="menu"');
    const items = menuSrc.match(/role="menuitem"/g) ?? [];
    assert.strictEqual(items.length, 5, `role="menuitem" 应恰 5 项，实际 ${items.length}`);
  });
  check('菜单项自上而下恰 5 项，文案字面：预览 / 用系统默认程序打开 / 选择打开方式… / 在文件夹中显示 / 复制路径', () => {
    const order = ['预览', '用系统默认程序打开', '选择打开方式…', '在文件夹中显示', '复制路径'];
    let idx = -1;
    for (const t of order) {
      const at = menuSrc.indexOf(t);
      assert.ok(at >= 0, `缺菜单项文案「${t}」`);
      assert.ok(at > idx, `菜单项「${t}」顺序错位（应自上而下）`);
      idx = at;
    }
  });
  check('exists===false：1-4 项 disabled 由 exists 驱动 + 「文件不存在」提示行 role="status"；复制路径恒可用（无 disabled 绑定）', () => {
    const disabledHits = menuSrc.match(/:disabled="/g) ?? [];
    assert.strictEqual(disabledHits.length, 4, `:disabled 绑定应恰 4 处（1-4 项），实际 ${disabledHits.length}`);
    assert.ok(/:disabled="[^"]*exists[^"]*"/.test(menuSrc), 'disabled 未由 exists 驱动');
    assert.ok(menuSrc.includes('文件不存在'), '缺「文件不存在」提示文案');
    assert.ok(/role="status"/.test(menuSrc), '提示行缺 role="status"');
    const copyLines = menuSrc.split('\n').filter((l) => l.includes('复制路径') || (l.includes('menuitem') && l.includes('copy')));
    assert.ok(copyLines.length > 0, '未找到复制路径菜单项');
    assert.ok(copyLines.every((l) => !l.includes(':disabled')), '复制路径项不应有 disabled 绑定（恒可用）');
  });
  check('关闭机制接线：pointerdown 菜单外关闭 + keydown Esc + scroll(capture) + resize（打开时挂/关闭时卸）', () => {
    assert.ok(menuSrc.includes("'pointerdown'"), '缺 document pointerdown 监听（菜单外关闭）');
    assert.ok(menuSrc.includes("'keydown'"), '缺 window keydown（Esc 关闭）');
    assert.ok(menuSrc.includes("'scroll'"), '缺 window scroll 监听');
    assert.ok(/addEventListener\('scroll'[^)]*capture:\s*true/.test(menuSrc.replace(/\s+/g, ' ')), 'scroll 监听缺 capture: true（须覆盖内层滚动容器）');
    assert.ok(menuSrc.includes("'resize'"), '缺 window resize 监听');
    assert.ok(menuSrc.includes('removeEventListener'), '缺监听卸载（打开时挂/关闭时卸）');
  });
  check('scroll 关闭路径 200ms 宽限窗（P6B-T17，round-001 f4，用户裁决 2026-11-22）：SCROLL_GRACE_MS=200 具名常量在位 + openedAt 打开刷新/关闭复位 + 宽限守卫仅 scroll 处理器（resize/pointerdown/Esc 负向无宽限）', () => {
    assert.ok(/const\s+SCROLL_GRACE_MS\s*=\s*200\b/.test(menuSrc), '缺具名常量 const SCROLL_GRACE_MS = 200');
    const scrollBody = fnBody(menuSrc, 'onWinScroll');
    assert.ok(scrollBody.length > 0, '缺 onWinScroll 处理器');
    assert.ok(/performance\.now\(\)\s*-\s*openedAt\s*<\s*SCROLL_GRACE_MS/.test(scrollBody), 'scroll 处理器缺宽限守卫（performance.now() - openedAt < SCROLL_GRACE_MS 提前 return）');
    assert.ok(scrollBody.includes('store.close()'), '宽限守卫后缺 store.close()（超宽限后的滚动仍须立即关闭，契约措辞不变）');
    assert.ok(/openedAt\s*=\s*performance\.now\(\)/.test(menuSrc), '缺打开时 openedAt 刷新（openedAt = performance.now()）');
    assert.ok(/openedAt\s*=\s*0\b/.test(menuSrc), '缺关闭时 openedAt 置 0 复位');
    // 生命周期定位：刷新须落在 watch([visible, x, y]) 打开分支、复位须落在关闭（else）分支。
    // （以语句形态定位 watch 本体，避开 f1 注释中的同字面；reset 自 elseIdx 起搜，避开
    // `let openedAt = 0;` 声明行的误匹配。）
    const wIdx = menuSrc.indexOf('watch([visible, x, y], ([v])');
    assert.ok(wIdx >= 0, '缺 watch([visible, x, y]) 打开/关闭钩子（f1 既有载体）');
    const setIdx = menuSrc.indexOf('openedAt = performance.now()', wIdx);
    const elseIdx = menuSrc.indexOf('} else {', wIdx);
    assert.ok(setIdx >= 0 && (elseIdx < 0 || setIdx < elseIdx), 'openedAt 刷新须在 watch 打开分支内');
    assert.ok(elseIdx >= 0, 'watch 关闭（else）分支缺失');
    const resetIdx = menuSrc.indexOf('openedAt = 0', elseIdx);
    assert.ok(resetIdx >= 0, 'openedAt 复位（openedAt = 0）须在 watch 关闭（else）分支内');
    // 负向：其余三条关闭路径（菜单外点 / Esc / resize）零宽限——处理器体内不得出现宽限字面。
    for (const fn of ['onDocPointerDown', 'onWinKeydown', 'onWinResize']) {
      const body = fnBody(menuSrc, fn);
      assert.ok(body.length > 0, `缺 ${fn} 处理器`);
      assert.ok(!body.includes('openedAt') && !body.includes('SCROLL_GRACE_MS'), `${fn} 出现宽限窗字面（负向钉：宽限仅允许在 scroll 路径）`);
    }
  });
  check('定位 clamp：Math.min(x, innerWidth - 16 - menuWidth) / Math.min(y, innerHeight - 16 - menuHeight)（渲染后 nextTick 修正）', () => {
    assert.ok(/Math\.min\([^)]*innerWidth\s*-\s*16/.test(menuSrc), '缺横向 clamp（innerWidth - 16 - menuWidth）');
    assert.ok(/Math\.min\([^)]*innerHeight\s*-\s*16/.test(menuSrc), '缺纵向 clamp（innerHeight - 16 - menuHeight）');
    assert.ok(menuSrc.includes('nextTick'), '缺 nextTick 渲染后修正');
    assert.ok(menuSrc.includes('offsetWidth') && menuSrc.includes('offsetHeight'), '缺 offsetWidth/offsetHeight 实测');
  });

  console.log('\n=== P6B-T2 七组件左键零动作 + 右键委托唯一化 ===');
  for (const [rel, oldName, newName, gated] of DELEGATES) {
    const src = file(rel);
    check(`${path.basename(rel)}：旧左键委托 ${oldName} 清零（函数与模板绑定全删）`, () => {
      assert.ok(!src.includes(oldName), `仍残留旧委托 ${oldName}（左键直开链路须全删）`);
    });
    check(`${path.basename(rel)}：新右键委托 ${newName}（closest?.('.md-file-link') 同形 + 委托体内零 useFilePreview/fs 通道残留）`, () => {
      const body = fnBody(src, newName);
      assert.ok(body.length > 0, `缺新委托 ${newName}`);
      assert.ok(body.includes("closest?.('.md-file-link')") || body.includes("closest('.md-file-link')"), '委托缺 closest(.md-file-link)');
      assert.ok(body.includes('data-clip-path'), '委托缺 data-clip-path 读取');
      assert.ok(body.includes('e.preventDefault()'), '委托缺 preventDefault（命中才拦，外链系统菜单照旧）');
      assert.ok(body.includes('useFileLinkMenuStore().open('), '委托未接 useFileLinkMenuStore().open');
      assert.ok(body.includes('e.clientX') && body.includes('e.clientY'), '委托缺坐标透传（e.clientX/e.clientY）');
      assert.ok(!body.includes('useFilePreview'), '委托体内残留 useFilePreview（左键开抽屉动作未删净）');
      assert.ok(!body.includes('fsOpenPath') && !body.includes('fsShowInExplorer') && !body.includes('fsStat'), '委托体内残留 fs 通道直调');
    });
    check(`${path.basename(rel)}：模板 @contextmenu 绑定在位${gated ? '（含 !exportMode 门控）' : ''}`, () => {
      const bind = src.match(new RegExp(`@contextmenu="[^"]*${newName}[^"]*"`, 'g')) ?? [];
      assert.ok(bind.length >= 1, `缺 @contextmenu 绑定 ${newName}`);
      if (gated) {
        assert.ok(bind.every((b) => b.includes('!exportMode')), `exportMode 门控缺失：${bind.join(' | ')}`);
      }
    });
  }
  check('ToolCallBlock chip 左键预览独立入口零触碰（@click.stop 预览绑定仍在，契约外零改动）', () => {
    const src = file('src/renderer/components/chat/ToolCallBlock.vue');
    assert.ok(src.includes('@click.stop="!exportMode && useFilePreview().open(filePath)"'),
      'chip @click.stop 预览绑定丢失（契约外改动）');
  });

  console.log('\n=== P6B-T3 死链收编（文案变化申报锚） ===');
  {
    check('七委托无 md-file-link--dead 特判（死链与活链同走右键菜单路径，无分支残留）', () => {
      for (const [rel, , newName] of DELEGATES) {
        const body = fnBody(file(rel), newName);
        assert.ok(!body.includes('--dead'), `${path.basename(rel)} 委托出现 --dead 特判（死链应与活链同路径）`);
      }
    });
    check('store：fsStat exists=false → notice「文件不存在」置入（菜单内提示形态）', () => {
      let src = '';
      let missing = true;
      try { src = file(STORE_REL); missing = false; } catch { /* 未实施期 */ }
      assert.ok(!missing, 'file-link-menu-store.ts 不存在');
      assert.ok(src.includes('文件不存在'), 'store 缺「文件不存在」提示写入');
      assert.ok(src.includes('this.exists') || /exists/.test(src), 'store 缺 exists 状态位');
      assert.ok(src.includes('fsStat'), 'store 未调 fsStat 预检');
    });
    check('抽屉相对路径预检错误卡字面保留（chip 相对路径来源不变，「未设置工作区根」文案仍在）', () => {
      const src = file('src/renderer/components/preview/FilePreviewDrawer.vue');
      assert.ok(src.includes('当前会话未设置工作区根'), 'FilePreviewDrawer 相对路径预检文案丢失（chip 来源仍依赖）');
      assert.ok(src.includes('isAbsolutePathForm'), 'FilePreviewDrawer 预检谓词丢失');
    });
  }

  console.log('\n=== P6B-T4 IPC 通道键集零新增 ===');
  {
    const ipcSrc = file('src/shared/types/ipc.ts');
    check("ipc.ts 三通道键值钉：FS_STAT='fs:stat' / FS_OPEN_PATH='fs:openPath' / FS_SHOW_IN_EXPLORER='fs:showInExplorer'", () => {
      assert.ok(ipcSrc.includes("FS_STAT: 'fs:stat'"), "缺 FS_STAT: 'fs:stat'");
      assert.ok(ipcSrc.includes("FS_OPEN_PATH: 'fs:openPath'"), "缺 FS_OPEN_PATH: 'fs:openPath'");
      assert.ok(ipcSrc.includes("FS_SHOW_IN_EXPLORER: 'fs:showInExplorer'"), "缺 FS_SHOW_IN_EXPLORER: 'fs:showInExplorer'");
    });
    check('store 与 FileLinkMenu 零 \'fs:\' 字面（零新 IPC：全部经 window.claudeLink 既有方法）', () => {
      for (const rel of [STORE_REL, MENU_REL]) {
        let src = '';
        try { src = file(rel); } catch { src = ''; }
        assert.ok(src.length > 0, `${rel} 不存在`);
        assert.ok(!src.includes("'fs:"), `${rel} 出现 'fs:' 字面（须走 window.claudeLink 既有通道）`);
        if (rel === STORE_REL) {
          assert.ok(src.includes('window.claudeLink.fsStat'), 'store 缺 fsStat 调用');
        }
      }
    });
    check('store 菜单动作经 fsOpenPath(default|choose) + fsShowInExplorer（两模式齐全）', () => {
      const src = file(STORE_REL);
      assert.ok(src.includes("openWith('default')"), '缺 default 模式分发（openWith）');
      assert.ok(src.includes("openWith('choose')"), '缺 choose 模式分发（openWith）');
      assert.ok(/fsOpenPath\(\s*this\.path\s*,\s*mode\s*\)/.test(src), '缺 fsOpenPath(this.path, mode) 调用');
      assert.ok(src.includes('fsShowInExplorer'), '缺 fsShowInExplorer 调用');
    });
    check('web-bridge.ts 三绑定在位（网页版零新通道：fsStat/fsShowInExplorer/fsOpenPath 已注册）', () => {
      const src = file('src/renderer/web/web-bridge.ts');
      assert.ok(src.includes('fsStat: IPC_CHANNELS.FS_STAT'), 'web-bridge 缺 fsStat 绑定');
      assert.ok(src.includes('fsShowInExplorer: IPC_CHANNELS.FS_SHOW_IN_EXPLORER'), 'web-bridge 缺 fsShowInExplorer 绑定');
      assert.ok(src.includes('fsOpenPath: IPC_CHANNELS.FS_OPEN_PATH'), 'web-bridge 缺 fsOpenPath 绑定');
    });
    check('App.vue 挂载 FileLinkMenu（与 FilePreviewDrawer 并列全局单例）', () => {
      const src = file('src/renderer/App.vue');
      assert.ok(src.includes("import FileLinkMenu from './components/common/FileLinkMenu.vue'"), 'App.vue 缺 FileLinkMenu import');
      assert.ok(src.includes('<FileLinkMenu />'), 'App.vue 缺 <FileLinkMenu /> 挂载');
    });
  }

  console.log('\n=== P6B-T5 R2 裁决钉：菜单全平台渲染（无渲染层平台分支） ===');
  {
    check('FileLinkMenu.vue 无 process.platform / navigator.platform / win32 判定（5 项无条件渲染）', () => {
      assert.ok(!/process\.platform/.test(menuSrc), '出现 process.platform 判定（R2 裁决禁止）');
      assert.ok(!/navigator\.platform/.test(menuSrc), '出现 navigator.platform 判定（R2 裁决禁止）');
      assert.ok(!/['"]win32['"]/.test(menuSrc), '出现 win32 平台字面（R2 裁决禁止）');
      const itemLines = menuSrc.split('\n').filter((l) => l.includes('role="menuitem"'));
      assert.ok(itemLines.length === 5 && itemLines.every((l) => !l.includes('v-if')), '菜单项存在 v-if 分支渲染（应 5 项全平台无条件渲染）');
    });
    check('store 同口径：无平台判定字面', () => {
      let src = '';
      try { src = file(STORE_REL); } catch { src = ''; }
      assert.ok(src.length > 0, 'file-link-menu-store.ts 不存在');
      assert.ok(!/process\.platform/.test(src), 'store 出现 process.platform');
      assert.ok(!/['"]win32['"]/.test(src), 'store 出现 win32 字面');
    });
  }

  console.log('\n=== P6B-T15 外链不劫持（closest 不命中即 return） ===');
  {
    for (const [rel, , newName] of DELEGATES) {
      const body = fnBody(file(rel), newName);
      check(`${path.basename(rel)}：closest 不命中即 return（http 外链系统行为保留）`, () => {
        assert.ok(/if\s*\(!el\)\s*return;?/.test(body), '委托缺 if (!el) return 守卫（外链会被劫持）');
      });
    }
  }

  console.log('\n=== P6B-T16 markdown.ts 围栏不链接化断言保留（P6-A/B 不波及） ===');
  {
    const mdSrc = file('src/renderer/utils/markdown.ts');
    const previewVerifySrc = file('scripts/tdd-file-preview-verify.ts');
    check('tdd-file-preview-verify.ts markdown.ts 结构钉四字面仍在（本点 MOD 只改委托钉）', () => {
      assert.ok(previewVerifySrc.includes('md.renderer.rules.link_open'), '既有 markdown.ts 结构钉被移除');
      assert.ok(previewVerifySrc.includes('data-clip-path'), '既有结构钉 data-clip-path 被移除');
      assert.ok(previewVerifySrc.includes('javascript:void(0)'), '既有结构钉 javascript:void(0) 被移除');
      assert.ok(previewVerifySrc.includes('setFileLinkWorkspaceRoot'), '既有结构钉 setFileLinkWorkspaceRoot 被移除');
    });
    check('markdown.ts 零改动锚：fence 不走 inline renderer 注释 + link_open 按钮化产出形态不变', () => {
      assert.ok(mdSrc.includes('fence/code_block/缩进代码块不走 inline renderer'), 'markdown.ts fence 锚点注释丢失（围栏不链接化被波及）');
      assert.ok(mdSrc.includes("attrSet('class', 'md-file-link')"), 'markdown.ts link_open 按钮化形态丢失');
      assert.ok(mdSrc.includes("attrSet('href', 'javascript:void(0)')"), 'markdown.ts href 置换形态丢失');
    });
    check("markdown.ts P6-A '...' 段拒绝锚仍在（p6a 产物不回退）", () => {
      const flSrc = file('src/renderer/utils/file-link.ts');
      assert.ok(flSrc.includes("seg === '...'"), "file-link.ts '...' 省略段拒绝丢失");
    });
  }

  console.log('\n=== 场景代码钉（MOD-P6-1 + W-file-context-menu，整链由编排器收尾跑） ===');
  {
    const smokeSrc = file('scripts/cdp-file-preview-smoke.mjs');
    const ctxIdx = smokeSrc.indexOf('async function contextMenuFileLink');
    check('clickFileLinkReal 右键化：contextMenuFileLink 派发 contextmenu + 菜单出现断言 + 「预览」菜单项点击', () => {
      assert.ok(ctxIdx >= 0, 'contextMenuFileLink 辅助函数丢失');
      const end = smokeSrc.indexOf('function buildMinimalPdf', ctxIdx);
      assert.ok(end > ctxIdx, '右键辅助块边界丢失（buildMinimalPdf 前置标记）');
      const body = smokeSrc.slice(ctxIdx, end);
      assert.ok(/dispatchEvent\(new MouseEvent\('contextmenu'/.test(body), '右键辅助块缺 contextmenu 事件派发');
      assert.ok(body.includes('.file-link-menu'), '右键辅助块缺菜单出现断言');
      assert.ok(!/\bel\.click\(\)/.test(body), '右键辅助块仍残留 el.click() 左键驱动');
      assert.ok(body.includes("=== '预览'"), 'clickFileLinkReal 缺「预览」菜单项点击');
      const realBody = smokeSrc.slice(smokeSrc.indexOf('async function clickFileLinkReal'), end);
      assert.ok(realBody.includes('await contextMenuFileLink('), 'clickFileLinkReal 未复用 contextMenuFileLink（右键驱动）');
    });
    check('A4 死链反馈改菜单形态：死链右键 → 菜单「文件不存在」/禁用断言在位（禁用计数 ===4 精确钉，round-001 F-r1-5）', () => {
      assert.ok(smokeSrc.includes('文件不存在'), 'A4 死链菜单形态断言缺失');
      assert.ok(smokeSrc.includes('dv.disabled !== 4'), 'A4 死链禁用形态断言缺失（须精确钉 assertMenuMissingForm 的 dv.disabled !== 4 计数断言，弱匹配 includes(\'disabled\') 已废除）');
    });
    check('T12-① 宽限窗测试同步钉（round-001 f4 裁决选项 A 授权）：smoke scroll 派发前先越过 200ms 宽限窗（await sleep(>200)），外点/resize/Esc 关闭路径无宽限零触碰', () => {
      const openIdx = smokeSrc.indexOf("await reopen('T12-①开')");
      assert.ok(openIdx >= 0, 'T12-① 开菜单锚丢失');
      const scrollIdx = smokeSrc.indexOf(".message-list__scroller') || document.body", openIdx);
      assert.ok(scrollIdx > openIdx, 'T12-① scroll 派发锚丢失');
      const m = smokeSrc.slice(openIdx, scrollIdx).match(/await sleep\((\d+)\)/);
      assert.ok(m !== null, 'T12-① scroll 派发前缺越过宽限窗等待（await sleep）——宽限窗落地后窗内 scroll 必被吞，契约钉须在宽限窗后派发');
      const ms = Number(m![1]);
      assert.ok(ms > 200, `宽限窗等待须 >200ms（用户裁决 SCROLL_GRACE_MS=200），实际 ${ms}ms`);
    });
    const webSrc = file('scripts/cdp-web-access-e2e.mjs');
    check('W-file-context-menu 场景登记在位（web 端右键同款菜单，禁写真实配置）', () => {
      assert.ok(webSrc.includes('W-file-context-menu'), 'cdp-web-access-e2e.mjs 缺 W-file-context-menu 场景');
    });
  }

  console.log('\n=== store 行为组（函数级 pinia 直测 + window.claudeLink 桩） ===');
  // 桩：window.claudeLink 三 FS 通道（可编排返回值/调用记录）。store 模块仅在 action 内触达
  // window，import 期零副作用，导入后再装桩即可。pinia 直测前提：store 与其依赖（useFilePreview
  // → preview-store → preview-format / clipboard）均为纯 TS，无 Vue 组件依赖。
  const mod = await importStore();
  await checkAsync('store 模块可导入（pinia defineStore 形态）', async () => {
    assert.ok(mod !== null, `file-link-menu-store.ts 导入失败（未实施或编译错误）`);
    assert.ok(typeof mod?.useFileLinkMenuStore === 'function', 'useFileLinkMenuStore 导出缺失');
  });
  if (mod) {
    const g = globalThis as unknown as { window?: unknown };
    await checkAsync('open()：置可见+坐标+exists:null（检查中），异步 fsStat 预检存在→exists=true', async () => {
      setActivePinia(createPinia());
      const st = mod.useFileLinkMenuStore();
      const calls: Array<{ ch: string; args: unknown[] }> = [];
      g.window = {
        claudeLink: {
          fsStat: async (...a: unknown[]) => { calls.push({ ch: 'fsStat', args: a }); return { exists: true, isDir: false, size: 1 }; },
          fsOpenPath: async () => ({ ok: true }),
          fsShowInExplorer: async () => ({ ok: true }),
        },
      };
      st.open('D:\\x\\a.md', 40, 60);
      assert.strictEqual(st.visible, true, 'open 后 visible 应为 true');
      assert.strictEqual(st.path, 'D:\\x\\a.md', 'open 后 path 应落位');
      assert.strictEqual(st.exists, null, '检查中 exists 应为 null');
      assert.strictEqual(st.notice, '', 'open 应重置 notice');
      assert.strictEqual(st.x, 40, '坐标 x 应透传');
      assert.strictEqual(st.y, 60, '坐标 y 应透传');
      await sleep(30);
      assert.strictEqual(st.exists, true, 'fsStat 存在后 exists 应为 true');
      assert.strictEqual(calls.filter((c) => c.ch === 'fsStat').length, 1, 'fsStat 应恰调一次');
      st.close();
    });
    await checkAsync('exists=false → notice「文件不存在」置入（菜单内提示形态）', async () => {
      setActivePinia(createPinia());
      const st = mod.useFileLinkMenuStore();
      g.window = {
        claudeLink: {
          fsStat: async () => ({ exists: false, isDir: false, size: 0 }),
          fsOpenPath: async () => ({ ok: true }),
          fsShowInExplorer: async () => ({ ok: true }),
        },
      };
      st.open('D:\\x\\gone.md', 0, 0);
      await sleep(30);
      assert.strictEqual(st.exists, false, 'exists 应为 false');
      assert.ok(st.notice.includes('文件不存在'), `notice 应含「文件不存在」，实际「${st.notice}」`);
      st.close();
    });
    await checkAsync('T11 store 级 fail-closed（round-001 F-r1-2）：fsStat 通道 reject（IPC 异常）→ exists=false + notice「文件不存在」', async () => {
      setActivePinia(createPinia());
      const st = mod.useFileLinkMenuStore();
      g.window = {
        claudeLink: {
          fsStat: async () => { throw new Error('ipc'); },
          fsOpenPath: async () => ({ ok: true }),
          fsShowInExplorer: async () => ({ ok: true }),
        },
      };
      st.open('D:\\x\\rej.md', 0, 0);
      await sleep(30);
      assert.strictEqual(st.exists, false, 'fsStat reject 应按 fail-closed 收敛 exists=false（不误报已存在）');
      assert.ok(st.notice.includes('文件不存在'), `notice 应含「文件不存在」，实际「${st.notice}」`);
      st.close();
    });
    await checkAsync('seq 竞态守卫：旧 open 的 fsStat 响应晚到不回写（新 open 重置序号，换目标重开不叠双菜单）', async () => {
      setActivePinia(createPinia());
      const st = mod.useFileLinkMenuStore();
      let release: (() => void) | null = null;
      let n = 0;
      g.window = {
        claudeLink: {
          fsStat: async () => {
            n++;
            if (n === 1) await new Promise<void>((r) => { release = r; });
            return { exists: true, isDir: false, size: 1 };
          },
          fsOpenPath: async () => ({ ok: true }),
          fsShowInExplorer: async () => ({ ok: true }),
        },
      };
      st.open('D:\\x\\slow.md', 10, 10);
      st.open('D:\\x\\fast.md', 20, 20); // 换目标重开（seq++，旧响应作废）
      assert.strictEqual(st.path, 'D:\\x\\fast.md', '重开应换目标');
      assert.strictEqual(st.exists, null, '重开应复位检查中态');
      await sleep(30);
      assert.strictEqual(st.exists, true, '第二次 open 的 stat 应落位');
      if (release) release();
      await sleep(30);
      assert.strictEqual(st.path, 'D:\\x\\fast.md', '旧响应晚到不得改写 path');
      st.close();
    });
    await checkAsync('preview()：先关菜单再开预览抽屉（useFilePreview 语义，远控同现状）', async () => {
      setActivePinia(createPinia());
      const st = mod.useFileLinkMenuStore();
      g.window = {
        claudeLink: {
          fsStat: async () => ({ exists: true, isDir: false, size: 1 }),
          fsOpenPath: async () => ({ ok: true }),
          fsShowInExplorer: async () => ({ ok: true }),
        },
      };
      st.open('D:\\x\\p.md', 10, 10);
      await sleep(20);
      st.preview();
      assert.strictEqual(st.visible, false, 'preview 应关闭菜单');
      const { usePreviewStore } = await import(pathToFileURL(path.join(repoRoot, 'src/renderer/stores/preview-store.ts')).href);
      const drawer = usePreviewStore();
      assert.strictEqual(drawer.open, true, 'preview 应经 useFilePreview 打开抽屉');
      assert.strictEqual(drawer.path, 'D:\\x\\p.md', '抽屉 path 应为菜单目标');
      st.close();
      drawer.close();
    });
    await checkAsync('openDefault/openChoose：fsOpenPath 两模式；成功关菜单；失败留菜单写 notice', async () => {
      setActivePinia(createPinia());
      const st = mod.useFileLinkMenuStore();
      const fpCalls: Array<unknown[]> = [];
      let openPathResult: { ok: boolean; reason?: string; message?: string } = { ok: true };
      g.window = {
        claudeLink: {
          fsStat: async () => ({ exists: true, isDir: false, size: 1 }),
          fsOpenPath: async (...a: unknown[]) => { fpCalls.push(a); return openPathResult; },
          fsShowInExplorer: async () => ({ ok: true }),
        },
      };
      st.open('D:\\x\\o.md', 0, 0);
      await sleep(20);
      st.openDefault();
      await sleep(20);
      assert.strictEqual(st.visible, false, 'default 成功应关菜单');
      assert.deepStrictEqual(fpCalls[0], ['D:\\x\\o.md', 'default'], 'default 模式参数错');
      st.open('D:\\x\\c.md', 0, 0);
      await sleep(20);
      st.openChoose();
      await sleep(20);
      assert.strictEqual(st.visible, false, 'choose 成功应关菜单');
      assert.deepStrictEqual(fpCalls[1], ['D:\\x\\c.md', 'choose'], 'choose 模式参数错');
      // 失败分支：ok:false + message → notice 写入、菜单保持可见（对齐契约「失败自反馈」）。
      openPathResult = { ok: false, reason: 'error', message: '打开失败：无关联程序' };
      st.open('D:\\x\\f.md', 0, 0);
      await sleep(20);
      st.openDefault();
      await sleep(20);
      assert.strictEqual(st.visible, true, '失败应保持菜单可见');
      assert.ok(st.notice.includes('打开失败'), `失败 notice 应含消息，实际「${st.notice}」`);
      st.close();
    });
    await checkAsync('showInExplorer：成功关菜单；失败留菜单写 notice', async () => {
      setActivePinia(createPinia());
      const st = mod.useFileLinkMenuStore();
      const showCalls: number[] = [];
      let showResult: { ok: boolean; reason?: string; message?: string } = { ok: true };
      g.window = {
        claudeLink: {
          fsStat: async () => ({ exists: true, isDir: false, size: 1 }),
          fsOpenPath: async () => ({ ok: true }),
          fsShowInExplorer: async () => { showCalls.push(1); return showResult; },
        },
      };
      st.open('D:\\x\\s.md', 0, 0);
      await sleep(20);
      st.showInExplorer();
      await sleep(20);
      assert.strictEqual(showCalls.length, 1, 'fsShowInExplorer 应恰调一次');
      assert.strictEqual(st.visible, false, 'show 成功应关菜单');
      showResult = { ok: false };
      st.open('D:\\x\\s2.md', 0, 0);
      await sleep(20);
      st.showInExplorer();
      await sleep(20);
      assert.strictEqual(st.visible, true, 'show 失败应保持菜单可见');
      assert.ok(st.notice.includes('失败'), `失败 notice 应有固定文案，实际「${st.notice}」`);
      st.close();
    });
    await checkAsync('copyPath：node 环境复制必然失败 → notice 写入、菜单保持可见；成功文案「已复制」字面在位', async () => {
      setActivePinia(createPinia());
      const st = mod.useFileLinkMenuStore();
      g.window = {
        claudeLink: {
          fsStat: async () => ({ exists: true, isDir: false, size: 1 }),
          fsOpenPath: async () => ({ ok: true }),
          fsShowInExplorer: async () => ({ ok: true }),
        },
      };
      st.open('D:\\x\\cp.md', 0, 0);
      await sleep(20);
      await st.copyPath();
      assert.strictEqual(st.visible, true, 'copyPath 不应关闭菜单（notice 行承接反馈）');
      assert.ok(st.notice.length > 0, '失败（node 无 clipboard/execCommand）应写 notice');
      const src = file(STORE_REL);
      assert.ok(src.includes('已复制'), 'store 缺「已复制」成功提示');
      st.close();
    });
    await checkAsync('close()：幂等可重复调用；close 后晚到 fsStat 响应不回写不重开', async () => {
      setActivePinia(createPinia());
      const st = mod.useFileLinkMenuStore();
      let release2: (() => void) | null = null;
      let n2 = 0;
      g.window = {
        claudeLink: {
          fsStat: async () => {
            n2++;
            if (n2 === 1) await new Promise<void>((r) => { release2 = r; });
            return { exists: true, isDir: false, size: 1 };
          },
          fsOpenPath: async () => ({ ok: true }),
          fsShowInExplorer: async () => ({ ok: true }),
        },
      };
      st.open('D:\\x\\late.md', 0, 0);
      st.close();
      st.close(); // 幂等
      assert.strictEqual(st.visible, false, 'close 后 visible 应为 false');
      if (release2) release2();
      await sleep(30);
      assert.strictEqual(st.visible, false, '晚到响应不得重开菜单');
    });
  }

  console.log('\n=== spawn 门（本点关联卷，退出码即判定） ===');
  function spawnGate(rel: string): boolean {
    const r = spawnSync('npx', ['tsx', rel], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
    if (r.status !== 0) {
      console.log(`  ---- ${rel} 输出（尾部） ----`);
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.split(/\r?\n/).slice(-12).join('\n');
      console.log(out);
    }
    return r.status === 0;
  }
  check('spawn tdd-file-preview-verify.ts（MOD 后委托钉 + chip 钉全绿）', () => {
    assert.ok(spawnGate('scripts/tdd-file-preview-verify.ts'), 'tdd-file-preview-verify.ts 非零退出');
  });
  check('spawn tdd-code-inline-fileref-verify.ts（A2/A4 结构钉不破坏）', () => {
    assert.ok(spawnGate('scripts/tdd-code-inline-fileref-verify.ts'), 'tdd-code-inline-fileref-verify.ts 非零退出');
  });

  console.log('\n=== 登记）selftest-static-list 含本脚本 ===');
  check('scripts/selftest-static-list.txt 尾部登记 tdd-file-link-context-menu-verify', () => {
    const list = file('scripts/selftest-static-list.txt').split(/\r?\n/).map((l) => l.trim());
    assert.ok(list.includes('scripts/tdd-file-link-context-menu-verify.ts'), 'selftest-static-list.txt 未登记新卷');
  });

  console.log(`\n[P6-B 文件链接右键菜单契约] 通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) process.exit(1);
})().catch((e: unknown) => {
  console.error('脚本异常退出：', e);
  process.exit(1);
});
