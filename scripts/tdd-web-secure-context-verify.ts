// tdd-web-secure-context-verify.ts
// 「网页版非安全上下文可用性」契约钉（SA-1 / P0-1）：crypto.randomUUID 全局 polyfill。
//
// 背景：网页访问入口是 http://局域网IP:8790，属非安全上下文，Web 平台 secure-only API
// crypto.randomUUID 在其中为 undefined；渲染层多处业务直调（session-store / ChatPage /
// use-chat / fs-picker-store / McpSettings / web-bridge）会在任何 IPC 发出之前抛
// TypeError，表现为「UI 能渲染但新建会话/发送全不可用」。修复为 index.html 一处全局
// polyfill（crypto.getRandomValues 非安全上下文处处可用，据此生成 UUID v4）；Electron
// 桌面窗口是安全上下文、原生存在该 API，polyfill 条件不触发，桌面行为零变化。
//
// 纯源码文本断言，不 import Electron。四组：
//   A. src/renderer/index.html 含 defineProperty(crypto, 'randomUUID' 关键行，且其字符
//      位置索引 < 主 module script 标签索引（module script 用 type="module" 的 script
//      标签定位；找不到断言 FAIL）——钉住 polyfill 必须先于一切模块求值生效；
//   B. polyfill 代码段内含 getRandomValues 与 0x40 / 0x80（UUID v4 版本位 + variant 位
//      形状）且 defineProperty 以 value: uuidV4 绑定生成函数，段边界取 randomUUID 关键行
//      所在 <script>…</script> 内联块；
//   C. src/renderer/ 下（排除 index.html）crypto.randomUUID() 直调出现次数 ≥ 8（注释行
//      trim() 以 // 开头者不计——注释字面不构成调用点）——证明 polyfill 必要性，防「顺手
//      改几处后删 polyfill」。
//   D.（SA-2 / P0-2 追加）src/renderer/ 下 navigator.clipboard 字面出现的文件集合 ⊆
//      {utils/clipboard.ts}（F9 收窄，对齐计划 §6 实现标准条 2）——剪贴板能力降级收口在
//      一处工具；4 个业务
//      组件（MessageList / MessageBubble / InteractionPreview / McpSettings）必须全部
//      不出现该字面并改调 copyTextToClipboard（网页端非安全上下文降级 execCommand）。
//
// 运行：npx tsx scripts/tdd-web-secure-context-verify.ts（已追加 selftest-static-list.txt 尾部）

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i > -1) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

const indexHtml = read('src/renderer/index.html');

// ── A. polyfill 存在且先于主 module script ──
console.log('=== A) index.html：randomUUID polyfill 位于主 module script 之前 ===');
const defineIdx = indexHtml.indexOf("defineProperty(crypto, 'randomUUID'");
const moduleMatch = /<script\b[^>]*type="module"[^>]*>/.exec(indexHtml);
const moduleIdx = moduleMatch ? (moduleMatch.index ?? -1) : -1;
check('index.html 含 defineProperty(crypto, \'randomUUID\' 关键行（polyfill 落盘）',
  defineIdx > -1, defineIdx === -1 ? '未找到关键行，polyfill 缺失' : '');
check('index.html 能定位主 module script 标签（type="module"）',
  moduleIdx > -1, moduleIdx === -1 ? '未找到 type="module" 的 script 标签，无法做时序断言' : '');
check('polyfill 关键行字符位置 < 主 module script 标签位置（先于一切模块求值生效）',
  defineIdx > -1 && moduleIdx > -1 && defineIdx < moduleIdx,
  `defineIdx=${defineIdx}, moduleIdx=${moduleIdx}`);

// ── B. polyfill 代码段形状：getRandomValues + 0x40 / 0x80（UUID v4 版本位） ──
console.log('=== B) polyfill 代码段：getRandomValues + 0x40/0x80（UUID v4 形状） ===');
let polyfillSeg = '';
if (defineIdx > -1) {
  const segStart = indexHtml.lastIndexOf('<script>', defineIdx);
  const segEnd = indexHtml.indexOf('</script>', defineIdx);
  if (segStart > -1 && segEnd > defineIdx) polyfillSeg = indexHtml.slice(segStart, segEnd);
}
check('polyfill 所在内联 <script> 段可定位（randomUUID 关键行回溯段边界）',
  polyfillSeg.length > 0, '段边界回溯失败：defineProperty 关键行不在任何 <script>…</script> 内');
check('polyfill 段内含 getRandomValues（非安全上下文可用的熵源）',
  polyfillSeg.includes('getRandomValues'));
check('polyfill 段内含 0x40（UUID v4 version 位）与 0x80（variant 位）',
  polyfillSeg.includes('0x40') && polyfillSeg.includes('0x80'));
// F3（审查修正）：B4 断言原为 includes("'randomUUID'")——polyfill 段由含该字面的关键行
// 回溯切出，A1 过则 B4 恒真，无独立判定力；改为断言 value: uuidV4（段内 uuidV4 定义与
// defineProperty 的 value 绑定同时在场，才证明 polyfill 真正把生成函数接到该键上）。
check('polyfill 段把 uuidV4 绑定为 crypto.randomUUID（defineProperty value: uuidV4）',
  polyfillSeg.includes('value: uuidV4'));

// ── C. 渲染层直调计数 ≥ 8（polyfill 必要性契约） ──
console.log('=== C) src/renderer/**（排除 index.html）crypto.randomUUID() 直调 ≥ 8 ===');
const rendererDir = path.join(repoRoot, 'src', 'renderer');
let directCalls = 0;
const callSites: string[] = [];
const walk = (dir: string): void => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (entry.name === 'index.html') continue;
    if (!/\.(ts|vue)$/.test(entry.name)) continue;
    // F7（审查修正）：按行剥离注释行（trim() 以 // 开头）后再计数——注释里的
    // crypto.randomUUID() 字面不构成真实调用点，不得用来满足「polyfill 必要性」阈值。
    const codeLines = fs.readFileSync(full, 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//'));
    const n = countOccurrences(codeLines.join('\n'), 'crypto.randomUUID()');
    if (n > 0) {
      directCalls += n;
      callSites.push(`${path.relative(repoRoot, full).split(path.sep).join('/')} ×${n}`);
    }
  }
};
walk(rendererDir);
check('crypto.randomUUID() 直调出现次数 ≥ 8（注释行不计；防顺手改几处后删 polyfill）',
  directCalls >= 8, `实际 ${directCalls}（${callSites.join(', ')}）`);

// ── D. navigator.clipboard 字面收口（SA-2 / P0-2）：剪贴板降级收口在一处工具 ──
console.log('=== D) src/renderer/** navigator.clipboard 字面收口（仅 utils/clipboard.ts 白名单） ===');
// F9（审查修正）：白名单由 {utils/clipboard.ts, web/web-bridge.ts} 收窄为仅
// {src/renderer/utils/clipboard.ts}（对齐计划 §6 实现标准条 2「仅剩 utils/clipboard.ts」）；
// web-bridge.ts 当前已不含该字面，收窄后仍应全绿——此后任何新文件出现 navigator.clipboard
// 字面（含 web-bridge.ts 回潮）都会被本断言拦下。
const clipboardWhitelist = new Set(['src/renderer/utils/clipboard.ts']);
const clipboardHitFiles: string[] = [];
const walkClipboard = (dir: string): void => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walkClipboard(full); continue; }
    if (fs.readFileSync(full, 'utf8').includes('navigator.clipboard')) {
      clipboardHitFiles.push(path.relative(repoRoot, full).split(path.sep).join('/'));
    }
  }
};
walkClipboard(rendererDir);
const clipOffenders = clipboardHitFiles.filter((f) => !clipboardWhitelist.has(f));
check('navigator.clipboard 字面仅出现于白名单 {utils/clipboard.ts}',
  clipOffenders.length === 0, `白名单外命中：${clipOffenders.join(', ') || '(无)'}`);
const clipboardUtilFile = path.join(rendererDir, 'utils', 'clipboard.ts');
const clipboardUtilExists = fs.existsSync(clipboardUtilFile);
check('统一回退工具 src/renderer/utils/clipboard.ts 存在且导出 copyTextToClipboard(',
  clipboardUtilExists && fs.readFileSync(clipboardUtilFile, 'utf8').includes('export async function copyTextToClipboard('),
  clipboardUtilExists ? '文件存在但未导出 copyTextToClipboard(' : '文件不存在');
const pinnedClipboardComponents = [
  'src/renderer/components/chat/MessageList.vue',
  'src/renderer/components/chat/MessageBubble.vue',
  'src/renderer/components/chat/InteractionPreview.vue',
  'src/renderer/components/config/McpSettings.vue',
];
const stillRawClipboard = pinnedClipboardComponents.filter((f) => clipboardHitFiles.includes(f));
check('4 个业务组件不出现 navigator.clipboard 字面（MessageList/MessageBubble/InteractionPreview/McpSettings）',
  stillRawClipboard.length === 0, `仍直调：${stillRawClipboard.join(', ') || '(无)'}`);
const notSwapped = pinnedClipboardComponents.filter(
  (f) => !fs.existsSync(path.join(repoRoot, f)) || !fs.readFileSync(path.join(repoRoot, f), 'utf8').includes('copyTextToClipboard('),
);
check('4 个业务组件均已调用 copyTextToClipboard(',
  notSwapped.length === 0, `未接入：${notSwapped.join(', ') || '(无)'}`);

console.log(`\n[网页版非安全上下文 polyfill 契约] 通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
