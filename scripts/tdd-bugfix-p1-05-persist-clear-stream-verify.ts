// tdd-bugfix-p1-05-persist-clear-stream-verify.ts
// P1-5 契约钉：text/thinking part 落库后流式累加器不清空 →
//   ① 单回合「文本→工具→文本」多段输出：全部已落库正文被去重隐藏、流式块把多段错位拼接；
//   ② 切走时快照保存的 streamingContent 含已落库内容，切回后 turnHad* 已复位，
//      finalize 把同一段正文再落库一次（新 UUID 重复气泡）。
//
// 修复语义（对齐 tool_use 模式）：text part 落库后清 streamingContent、thinking/redacted_thinking
// part 落库后清 streamingThinking（仅主流程；子 Agent 累加器独立、已在 445 清）。落库即清后
// 快照只含未落库尾巴，finalize 兜底只补尾巴=正确行为。MessageList 去重谓词同步收窄为
// 「内容与流式块一致」——已落库早段在后续段流式期间保持原位显示（§5-②）。
//
// 运行：npx tsx scripts/tdd-bugfix-p1-05-persist-clear-stream-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 截取 from 起点到下一 `continue;` 的分支体。 */
function branchBody(src: string, anchor: string): string {
  const start = src.indexOf(anchor);
  if (start < 0) return '';
  const end = src.indexOf('continue;', start);
  return end > start ? src.slice(start, end) : '';
}

const useChat = read('src/renderer/composables/use-chat.ts');
const msgList = read('src/renderer/components/chat/MessageList.vue');

// ── 1. 落库即清：handleMessagePartsFull 各分支 ──
const thinkingBranch = branchBody(useChat, "if (part.type === 'thinking' && 'thinking' in part) {");
check('① thinking part 落库后清 thinking 流式累加器（主流程门控内）',
  thinkingBranch.includes('persistMessage') && thinkingBranch.includes('clearThinking()'));
const redactedBranch = branchBody(useChat, "if (part.type === 'redacted_thinking') {");
check('② redacted_thinking 落库后同样清 thinking 流式累加器',
  redactedBranch.includes('persistMessage') && redactedBranch.includes('clearThinking()'));
const textBranch = branchBody(useChat, "if (part.type === 'text' && 'text' in part) {");
check('③ text part 落库后清正文流式累加器',
  textBranch.includes('persistMessage') && textBranch.includes('clearStream()'));
const toolBranch = branchBody(useChat, 'if (part.type === \'tool_use\') {');
check('④ tool_use 分支既有 clearToolStream 不回退（对照基准）',
  toolBranch.includes('persistMessage') && toolBranch.includes('clearToolStream()'));
check('⑤ 清累加器仅在主流程（isMainFlow 门控，子 Agent 落库不清主流程预览）',
  (thinkingBranch + redactedBranch + textBranch).includes('isMainFlow'));

// ── 2. MessageList 去重谓词（已落库早段原位显示）──
// N12 同步（先例 5db45f7）：谓词由「内容完全一致」升级为前缀匹配纯函数
// shouldHidePersistedForStreaming（shared/turn-boundary），语义不变——已落库早段不被批量隐藏。
check('⑥ MessageList 去重谓词存在（前缀匹配纯函数 + turnIds/turnStartIndex 契约标识）',
  msgList.includes('turnIds') && msgList.includes('turnStartIndex') &&
  /streamingContent/.test(msgList) &&
  /shouldHidePersistedForStreaming\([^)]*props\.streamingContent\)/.test(msgList),
  '需存在 shouldHidePersistedForStreaming(…, props.streamingContent) 形态的谓词');
check('⑦ thinking 折叠去重同样走前缀匹配纯函数',
  /shouldHidePersistedForStreaming\([^)]*props\.streamingThinking\)/.test(msgList));

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
