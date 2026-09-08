// tdd-bugfix-n12-prefix-dedup-predicate-verify.ts
// N12（P2）契约钉：后台会话流式快照残留已落库前缀 → 切回双显 + finalize 内存重复气泡——
// P1-5 的「落库即清」只对当前会话生效，后台 message 事件被显式跳过（快照不清）；切回后
// 快照=已落库前缀+新尾巴，与收窄后的「完全一致」去重谓词永不相等 → 已落库气泡与流式块同屏。
//
// 修法（定案：谓词方案优先）：去重谓词由「内容完全相等」改为「前缀匹配」——
// streamingContent 以已落库消息 content 为前缀（或相等）即隐藏该消息；空内容不构成前缀
//（防空串通配误隐藏）。审计报告 P1-5 设计缺陷条目同款建议（一并消掉 N12 全链）。
//
// 运行：npx tsx scripts/tdd-bugfix-n12-prefix-dedup-predicate-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const messageList = fs.readFileSync(path.join(repoRoot, 'src/renderer/components/chat/MessageList.vue'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

// ── 行为：纯函数（shared/turn-boundary）──
// eslint-disable-next-line @typescript-eslint/no-var-requires
let shouldHide: ((persisted: string, streaming: string) => boolean) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  shouldHide = require('../src/shared/turn-boundary').shouldHidePersistedForStreaming ?? null;
} catch { /* RED：模块缺失 */ }

check('① 纯函数 shouldHidePersistedForStreaming 存在', () => {
  assert.equal(typeof shouldHide, 'function');
});
check('② 前缀语义：流式块=已落库内容+新尾巴 → 隐藏已落库气泡（N12 主场景）', () => {
  assert.equal(shouldHide!('已落库前缀', '已落库前缀+新尾巴'), true);
});
check('③ 相等仍隐藏（P1-5 残余双显窗口语义保留）', () => {
  assert.equal(shouldHide!('完全一致', '完全一致'), true);
});
check('④ 非前缀不隐藏（历史早段/无关内容不误伤）', () => {
  assert.equal(shouldHide!('早段正文', '完全不同的流式内容'), false);
});
check('⑤ 空串不构成前缀（防空内容通配误隐藏）', () => {
  assert.equal(shouldHide!('', '任意流式'), false);
  assert.equal(shouldHide!('已落库', ''), false);
});

// ── 结构：MessageList 接线 ──
check('⑥ MessageList 引入并使用 shouldHidePersistedForStreaming', () => {
  assert.ok(messageList.includes('shouldHidePersistedForStreaming'));
});
check('⑦ 旧「内容完全相等」谓词已移除（去重区不再 === props.streaming*）', () => {
  const at = messageList.indexOf('const renderItems = computed');
  const seg = messageList.slice(at, messageList.indexOf('const activeFoldId', at));
  assert.doesNotMatch(seg, /===\s*props\.streaming(Content|Thinking)/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
