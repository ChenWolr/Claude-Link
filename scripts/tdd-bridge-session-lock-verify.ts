// tdd-bridge-session-lock-verify.ts
// 计划 docs/plans/2026-09-25-im-settings-simplify-and-session-lock-plan.md §4.2 契约钉：
// bridge 绑定会话桌面端只读（静态源码断言；init.ts/ipc-handlers/ChatPage 耦合 electron+Vue
// 无法行为级单测，沿 tdd-bridge-ui-static-verify 形态断言先例）。
//   S. shared/types/session.ts 加 bridgePlatform 可选字段 + ipc-handlers SESSION_LIST 装饰。
//   P. ChatPage.vue bridgeLocked 门控：锁定提示条 / TurnTimer 恒在 ChatInput 之前 / 五入口守卫。
//   L. selftest-static-list.txt 登记。
// RED 预期（未改树）：除 L①（登记后即真）外全 FAIL。
// 运行：npx tsx scripts/tdd-bridge-session-lock-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(group: string, no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ [${group}] ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ [${group}] ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

// S. 类型 + SESSION_LIST 装饰
{
  const sessionTypesSrc = read('src/shared/types/session.ts');
  check('S', '①', 'Session 类型含 bridgePlatform 字段声明与 BridgePlatform import',
    /bridgePlatform\?:\s*BridgePlatform\s*\|\s*null/.test(sessionTypesSrc)
      && sessionTypesSrc.includes("import type { BridgePlatform } from './bridge';"),
    'shared/types/session.ts 缺 bridgePlatform 可选字段或 BridgePlatform import');

  const handlersSrc = read('src/main/ipc-handlers.ts');
  // S②：SESSION_LIST 字面之后 400 字符窗口内出现 bridgeBindingList()（复用既有 import，位置紧邻）。
  check('S', '②', 'SESSION_LIST handler 内调用 bridgeBindingList()（拉活跃绑定做装饰）',
    /IPC_CHANNELS\.SESSION_LIST[\s\S]{0,400}bridgeBindingList\(\)/.test(handlersSrc),
    'SESSION_LIST handler 未接 bridgeBindingList()');
  // S③：装饰形态：SESSION_LIST handler 段内含 bridgePlatform: 字面与 ?? null 归一。
  const listIdx = handlersSrc.indexOf('IPC_CHANNELS.SESSION_LIST');
  const seg = listIdx >= 0 ? handlersSrc.slice(listIdx, listIdx + 800) : '';
  check('S', '③', '装饰形态：返回行带 bridgePlatform（Map 取值 ?? null 归一）',
    seg.includes('bridgePlatform:') && seg.includes('?? null'),
    'SESSION_LIST 装饰缺 bridgePlatform 字面或 ?? null 归一');
  // S④（review 2026-09-25 P1 修复）：UPDATE/GET 出口统一装饰，防渲染层整体替换丢锁。
  const updIdx = handlersSrc.indexOf('IPC_CHANNELS.SESSION_UPDATE');
  const getIdx = handlersSrc.indexOf('IPC_CHANNELS.SESSION_GET');
  check('S', '④', 'SESSION_UPDATE/SESSION_GET 出口统一装饰（withBridgePlatform，防整体替换丢锁）',
    handlersSrc.includes('function withBridgePlatform')
      && updIdx >= 0 && handlersSrc.slice(updIdx, updIdx + 3500).includes('withBridgePlatform')
      && getIdx >= 0 && handlersSrc.slice(getIdx, getIdx + 500).includes('withBridgePlatform'),
    'SESSION_UPDATE/SESSION_GET 返回未装饰行，改名等整体替换路径会丢 bridgePlatform');
}

// P. ChatPage.vue 门控
{
  const chatSrc = read('src/renderer/pages/ChatPage.vue');
  // P①：bridgeLocked computed 且判据为 bridgePlatform != null（undefined = 未装饰 → 不锁）。
  check('P', '①', 'bridgeLocked computed 且判据为 bridgePlatform != null',
    /bridgeLocked\s*=\s*computed/.test(chatSrc) && /bridgePlatform\s*!=\s*null/.test(chatSrc),
    'ChatPage 缺 bridgeLocked computed 或判据形态不符');
  // P②：模板门控：v-if="bridgeLocked" 提示条 → <template v-else> 包裹 ChatInput。
  const idxIf = chatSrc.indexOf('v-if="bridgeLocked"');
  const idxElse = chatSrc.indexOf('<template v-else>', idxIf >= 0 ? idxIf : 0);
  const idxInputAfterElse = chatSrc.indexOf('<ChatInput', idxElse >= 0 ? idxElse : 0);
  check('P', '②', '模板门控：v-if="bridgeLocked" 提示条 + <template v-else> 包裹 ChatInput',
    idxIf >= 0 && idxElse > idxIf && idxInputAfterElse > idxElse,
    `v-if=${idxIf} v-else=${idxElse} ChatInput=${idxInputAfterElse}`);
  // P③：TurnTimer 恒渲染且在 ChatInput 之前（与 regression-tests.ts:104 同向）。
  const idxTimer = chatSrc.indexOf('<TurnTimer');
  const idxInput = chatSrc.indexOf('<ChatInput');
  check('P', '③', 'TurnTimer 恒渲染且在 ChatInput 之前',
    idxTimer >= 0 && idxInput >= 0 && idxTimer < idxInput,
    `TurnTimer=${idxTimer} ChatInput=${idxInput}`);
  // P④：锁定提示文案字面。
  check('P', '④', '锁定提示文案（桥接驱动 + 仅可查看）',
    chatSrc.includes('桥接驱动') && chatSrc.includes('仅可查看'),
    '缺锁定提示文案');
  // P⑤：四入口守卫（函数体前 300 字符窗口内 if (bridgeLocked.value) return;）。
  const guardFns = ['handleSend', 'onPickAttachments', 'stageFiles', 'handleCompress'];
  for (const fn of guardFns) {
    const re = new RegExp(`function ${fn}\\([^)]*\\)[\\s\\S]{0,300}if \\(bridgeLocked\\.value\\) return;`);
    check('P', '⑤', `${fn} 入口 bridgeLocked 守卫`, re.test(chatSrc),
      `${fn} 缺 if (bridgeLocked.value) return; 守卫`);
  }
  // P⑥：onPageDragEnter 守卫（锁定态不显示拖放高亮，避免"看起来可投递"）。
  check('P', '⑥', 'onPageDragEnter 入口 bridgeLocked 守卫',
    /function onPageDragEnter\([^)]*\)[\s\S]{0,300}bridgeLocked/.test(chatSrc),
    'onPageDragEnter 缺 bridgeLocked 守卫');
}

// L. 登记
{
  check('L', '①', 'selftest-static-list.txt 已登记本脚本',
    read('scripts/selftest-static-list.txt').includes('scripts/tdd-bridge-session-lock-verify.ts'),
    'selftest-static-list.txt 未登记');
}

console.log(`\n结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
