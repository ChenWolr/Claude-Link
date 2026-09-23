// tdd-bridge-shared-verify.ts
// 计划 docs/plans/2026-09-21-im-bridge-feishu-wechat-plan.md Task 1 契约钉：bridge shared 纯函数层。
//   A. session-key：前缀表构造/解析（fs_dm_/wx_dm_），群键与非桥键拒绝。
//   B. feishu-outbound：默认 post 富文本（按行分段 {tag:'md'}）；markdown 表格 → interactive
//      schema 2.0 卡片；代码块/行内 code 中的竖线不算表格；空串仍产出至少 1 段。
//   C. wechat-outbound：4000 字分段（贪心 + 段内最后换行回退；单行超限硬切；空串空数组）。
// RED 预期（未改树）：三模块不存在，import 即 FAIL。
// 运行：npx tsx scripts/tdd-bridge-shared-verify.ts

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

function readTypes(): string {
  return fs.readFileSync(path.join(__dirname, '../src/shared/types/bridge.ts'), 'utf8');
}

// tsx 下带 .ts 后缀 import（先例：tdd 脚本直接引 src 模块）。
import { buildBridgeSessionKey, parseBridgeSessionKey } from '../src/shared/bridge/session-key';
import { renderFeishuOutbound } from '../src/shared/bridge/feishu-outbound';
import { WECHAT_MSG_CHUNK_LIMIT, splitWechatText } from '../src/shared/bridge/wechat-outbound';

let pass = 0;
let fail = 0;
function check(group: string, no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ [${group}] ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ [${group}] ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A. session-key
{
  check('A', '①', "buildBridgeSessionKey('feishu','ou_abc') === 'fs_dm_ou_abc'",
    buildBridgeSessionKey('feishu', 'ou_abc') === 'fs_dm_ou_abc',
    `实际=${buildBridgeSessionKey('feishu', 'ou_abc')}`);
  check('A', '②', "buildBridgeSessionKey('wechat','wxid_1') === 'wx_dm_wxid_1'",
    buildBridgeSessionKey('wechat', 'wxid_1') === 'wx_dm_wxid_1',
    `实际=${buildBridgeSessionKey('wechat', 'wxid_1')}`);
  const parsedFs = parseBridgeSessionKey('fs_dm_ou_abc');
  check('A', '③', "parseBridgeSessionKey('fs_dm_ou_abc') → {feishu, ou_abc}",
    parsedFs !== null && parsedFs.platform === 'feishu' && parsedFs.userId === 'ou_abc',
    `实际=${JSON.stringify(parsedFs)}`);
  const parsedWx = parseBridgeSessionKey('wx_dm_wxid_1');
  check('A', '④', "parseBridgeSessionKey('wx_dm_wxid_1') → {wechat, wxid_1}",
    parsedWx !== null && parsedWx.platform === 'wechat' && parsedWx.userId === 'wxid_1',
    `实际=${JSON.stringify(parsedWx)}`);
  check('A', '⑤', "parseBridgeSessionKey('随便') → null（非桥键拒绝）",
    parseBridgeSessionKey('随便') === null,
    `实际=${JSON.stringify(parseBridgeSessionKey('随便'))}`);
  check('A', '⑥', "parseBridgeSessionKey('fs_group_x') → null（phase 1 不认群键）",
    parseBridgeSessionKey('fs_group_x') === null,
    `实际=${JSON.stringify(parseBridgeSessionKey('fs_group_x'))}`);
}

// B. feishu-outbound
{
  const post = renderFeishuOutbound('# 标题\n正文');
  check('B', '①', '纯文本 → kind post / msgType post', post.kind === 'post' && post.msgType === 'post',
    `实际=${JSON.stringify(post.kind)}/${JSON.stringify(post.msgType)}`);
  let postParsed: { zh_cn?: { content?: unknown[][] } } | null = null;
  try { postParsed = JSON.parse(post.content); } catch { /* 断言里报 */ }
  const paragraphs = postParsed?.zh_cn?.content;
  const paraOk = Array.isArray(paragraphs) && paragraphs.length === 2
    && Array.isArray(paragraphs![0]) && paragraphs![0]!.length > 0
    && (paragraphs![0]![0] as { tag?: string }).tag === 'md';
  check('B', '②', 'post content = {zh_cn:{content:[[md..],[md..]]}} 且段数=行数(2)', paraOk,
    `实际=${post.content.slice(0, 120)}`);

  const card = renderFeishuOutbound('| a | b |\n|---|---|\n| 1 | 2 |');
  check('B', '③', 'markdown 表格 → kind interactive / msgType interactive',
    card.kind === 'interactive' && card.msgType === 'interactive',
    `实际=${card.kind}`);
  let cardParsed: { schema?: string; body?: { elements?: Array<{ tag?: string; content?: string }> } } | null = null;
  try { cardParsed = JSON.parse(card.content); } catch { /* 断言里报 */ }
  check('B', '④', '卡片 content schema=2.0 且 body.elements[0].tag=markdown',
    cardParsed?.schema === '2.0' && cardParsed?.body?.elements?.[0]?.tag === 'markdown',
    `实际=${card.content.slice(0, 160)}`);

  const fenced = renderFeishuOutbound('看代码：\n```\n| a | b |\n```\n完');
  check('B', '⑤', '围栏代码块内竖线不触发卡片（仍 post）', fenced.kind === 'post',
    `实际=${fenced.kind}`);
  const inline = renderFeishuOutbound('用 `a | b` 对齐列');
  check('B', '⑥', '行内 code 竖线不触发卡片（仍 post）', inline.kind === 'post',
    `实际=${inline.kind}`);

  const empty = renderFeishuOutbound('');
  const emptyOk = empty.kind === 'post' && (() => {
    try {
      const parsed = JSON.parse(empty.content) as { zh_cn?: { content?: unknown[][] } };
      return (parsed.zh_cn?.content?.length ?? 0) >= 1;
    } catch { return false; }
  })();
  check('B', '⑦', "空串 → post 且至少 1 个段落（不产出空 content）", emptyOk,
    `实际=${empty.kind} ${empty.content.slice(0, 80)}`);
}

// C. wechat-outbound
{
  check('C', '①', 'WECHAT_MSG_CHUNK_LIMIT === 4000', WECHAT_MSG_CHUNK_LIMIT === 4000,
    `实际=${String(WECHAT_MSG_CHUNK_LIMIT)}`);
  check('C', '②', "splitWechatText('a'.repeat(3999)) 长 1", splitWechatText('a'.repeat(3999)).length === 1,
    `实际=${splitWechatText('a'.repeat(3999)).length}`);
  check('C', '③', "splitWechatText('a'.repeat(4000)) 长 1", splitWechatText('a'.repeat(4000)).length === 1,
    `实际=${splitWechatText('a'.repeat(4000)).length}`);
  const over = splitWechatText('a'.repeat(4001));
  check('C', '④', "4001 字 → 2 段且 [0].length===4000", over.length === 2 && over[0]!.length === 4000,
    `实际=${over.length} 段，[0]=${over[0]?.length}`);
  const lines = ('x'.repeat(99) + '\n').repeat(60); // 6000 字，60 行每行 100 字
  const lineSplit = splitWechatText(lines);
  const allLineAligned = lineSplit.every((chunk, i) =>
    i === lineSplit.length - 1 ? chunk.length > 0 : chunk.endsWith('\n'));
  const lossless = lineSplit.join('') === lines;
  check('C', '⑤', '多行长文本：非末段边界落在换行处（段尾含 \\n）且拼接无损',
    lineSplit.length >= 2 && allLineAligned && lossless,
    `段数=${lineSplit.length} 对齐=${allLineAligned} 无损=${lossless}`);
  check('C', '⑥', "splitWechatText('') → []（空串不发空消息）", splitWechatText('').length === 0,
    `实际=${JSON.stringify(splitWechatText(''))}`);
  const losslessOver = splitWechatText('a'.repeat(9000));
  check('C', '⑦', '9000 字切 3 段且拼接无损', losslessOver.length === 3 && losslessOver.join('') === 'a'.repeat(9000),
    `实际=${losslessOver.length} 段`);
}

console.log(`\n结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
