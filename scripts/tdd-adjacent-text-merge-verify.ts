// tdd-adjacent-text-merge-verify.ts
// 行为测试：相邻 assistant 正文段的显示层合并（2026-11-06 两缺陷修复·点 2）。
// 用例正本：docs/plans/2026-11-06-two-bugs-test-cases.md §2（P2-01～P2-16，隔离出卷产物）；
// 澄清假设与计划会话裁决修正见同文件 §0（A3 合并全文暴露形态由实现落定、A4 空段/CR LF、
// A5 冗余 system 仍构成夹隔、A6 合并判定在分组层、A7 合并单元标识含回合末正文 id）。
// 形态对齐 tdd-process-fold-verify.ts：msg()/构造器 + RenderableMessage 最小契约直测
// groupMessagesForRender；仅 import node:* + 被测公开导出，不 import electron / vue 组件。
// round-002 F2 补齐：P2-ATT-1～3 attachments 聚合用例组（impl-design §2.9 第 11 条）、
// 合并接线结构钉（mergeAdjacentAssistantTexts(messages) / joinTextSegments /
// for (const msg of merged) 三字面，§2.10）、selftest 清单登记自检置尾。
// 运行：npx tsx scripts/tdd-adjacent-text-merge-verify.ts（已登记 scripts/selftest-static-list.txt）
// RED 先行：合并未实现时「合并新行为正例」应红、阻断/不变式钉现状即绿（期望桶见实施报告）。
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  groupMessagesForRender,
  PROCESS_NARRATION_TEXT_LIMIT,
} from '../src/renderer/utils/group-messages';
import type { RenderItem } from '../src/renderer/utils/group-messages';
import { shouldHidePersistedForStreaming } from '../src/shared/turn-boundary';
import { mapFinalTextToTurnStart } from '../src/renderer/utils/turn-diff-attach';
import { renderMarkdown } from '../src/renderer/utils/markdown';
import { isRedundantSystemProcessKind } from '../src/shared/system-info';
import type { RenderableMessage } from '../src/shared/types/export-image';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

let seq = 0;
function msg(partial: Partial<RenderableMessage>): RenderableMessage {
  seq += 1;
  return {
    id: partial.id ?? `m${seq}`,
    sessionId: 's1',
    role: partial.role ?? 'assistant',
    content: partial.content ?? '',
    eventType: partial.eventType ?? 'message',
    costUsd: null,
    durationMs: null,
    endedAt: null,
    processKind: partial.processKind ?? null,
    parentAgentId: partial.parentAgentId ?? null,
    toolUseId: partial.toolUseId ?? null,
    title: null,
    isError: partial.isError ?? false,
    createdAt: partial.createdAt ?? '2026-08-19T00:00:00.000Z',
  };
}

/** assistant 正文 text（合并被测形态：role=assistant / eventType=message / processKind=null）。 */
function body(id: string, content: string, extra: Partial<RenderableMessage> = {}): RenderableMessage {
  return msg({ id, role: 'assistant', content, eventType: 'message', processKind: null, ...extra });
}
/** 附件摘要最小契约（经 RenderableMessage 默认泛型导出，不新增 import 面）。 */
type AttachmentSummary = NonNullable<RenderableMessage['attachments']>[number];
/** 附加 attachments 的正文段（msg() 构造器固定字段不含可选键，经 spread 补挂）。 */
function withAttachments(m: RenderableMessage, atts: AttachmentSummary[]): RenderableMessage {
  return { ...m, attachments: atts };
}
function userText(id: string, content: string): RenderableMessage {
  return msg({ id, role: 'user', content, eventType: 'message', processKind: null });
}
function toolUse(id: string, toolUseId: string): RenderableMessage {
  return msg({ id, content: '{}', eventType: 'tool_use', processKind: 'tool:Bash', toolUseId });
}
function toolResult(id: string, toolUseId: string): RenderableMessage {
  return msg({ id, role: 'tool', content: 'ok', eventType: 'tool_result', processKind: 'tool:Bash', toolUseId });
}
function thinkingMsg(id: string, content: string): RenderableMessage {
  return msg({ id, eventType: 'thinking', processKind: 'thinking', content });
}
function sysMsg(id: string, processKind: string): RenderableMessage {
  return msg({ id, role: 'system', content: '系统事件', eventType: 'system', processKind });
}

/** 长正文（>PROCESS_NARRATION_TEXT_LIMIT，现状独立成 message 项），默认 120 字。 */
const L = (ch: string): string => ch.repeat(PROCESS_NARRATION_TEXT_LIMIT + 20);
const LA = L('甲');
const LB = L('乙');
const LC = L('丙');
const LERR = L('错');

// —— 合并全文读取助手（假设 A3：形态由实现落定，断言以能从公开导出读到全文为准——
// message 项 content 承载 / fold 内合并单元承载两形态均可读；未合并时读到的必是分段原文） ——
function isBodyText(m: RenderableMessage): boolean {
  return m.role === 'assistant' && m.eventType === 'message' && m.processKind === null;
}
function bodyMessageItems(items: RenderItem[]): RenderableMessage[] {
  const out: RenderableMessage[] = [];
  for (const it of items) {
    if (it.type === 'message' && isBodyText(it.message)) out.push(it.message);
  }
  return out;
}
function foldItems(items: RenderItem[]): Array<Extract<RenderItem, { type: 'fold' }>> {
  return items.filter((it): it is Extract<RenderItem, { type: 'fold' }> => it.type === 'fold');
}
function allBodyTexts(items: RenderItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.type === 'message') {
      if (isBodyText(it.message)) out.push(it.message.content);
    } else {
      for (const m of it.messages) if (isBodyText(m)) out.push(m.content);
    }
  }
  return out;
}
/** 阻断钉公用断言：两段各自独立成正文渲染项、不产生合并全文。 */
function assertNotMergedAround(items: RenderItem[], left: string, right: string, label: string): void {
  assert.deepEqual(
    bodyMessageItems(items).map((m) => m.content),
    [left, right],
    `${label}：两段应各自独立成正文渲染项`,
  );
  assert.ok(!allBodyTexts(items).includes(left + '\n' + right), `${label}：不应产生合并全文`);
}

console.log('\n=== P2-01 合并正例 ===');
{
  const items = groupMessagesForRender([body('A', LA), body('B', LB)]);
  check('P2-01 相邻两条长正文合并为恰 1 个正文渲染项、全文=段1+换行+段2', () => {
    const bodyItems = bodyMessageItems(items);
    assert.equal(bodyItems.length, 1, `正文渲染项应恰 1 个（未合并现状 ${bodyItems.length} 个——缺陷本身）`);
    assert.equal(bodyItems[0].content, LA + '\n' + LB, '合并全文应=段1+一个换行+段2');
    assert.equal(allBodyTexts(items).length, 1, '正文全文恰由 1 个合并单元承载');
  });
}

console.log('\n=== P2-02 拼接换行规则表（参数化 6 子形态） ===');
function joinCase(name: string, segs: string[], expected: string): void {
  const items = groupMessagesForRender(segs.map((c, i) => body(`j${i}`, c)));
  check(name, () => {
    assert.deepEqual(allBodyTexts(items), [expected], '合并全文与独立推导期望值不符');
  });
}
joinCase('P2-02-1 拼接换行规则：裸相邻两段恰一个换行分隔', ['a', 'b'], 'a\nb');
joinCase('P2-02-2 拼接换行规则：前段末尾已带换行不再叠加', ['a\n', 'b'], 'a\nb');
joinCase('P2-02-3 拼接换行规则：段内既有空行保留、仅不新增', ['a\n\n', 'b'], 'a\n\nb');
joinCase('P2-02-4 拼接换行规则：空段不产生多余空行（A4 裁决）', ['a', '', 'b'], 'a\nb');
joinCase('P2-02-5 拼接换行规则：CRLF 计为已带换行（A4 裁决）', ['a\r\n', 'b'], 'a\r\nb');
joinCase('P2-02-6 拼接换行规则：三段顺次合并', ['a', 'b', 'c'], 'a\nb\nc');

console.log('\n=== P2-03 跨段表格经 renderMarkdown 恢复 ===');
{
  const seg1 = '| a | b |\n|---|---|';
  const seg2 = '| 1 | 2 |';
  const items = groupMessagesForRender([body('t1', seg1), body('t2', seg2)]);
  check('P2-03 跨段表格：合并全文喂 renderMarkdown 恢复完整表格；对照组两段各自渲染无完整表格', () => {
    const merged = allBodyTexts(items).find((t) => t === seg1 + '\n' + seg2);
    assert.ok(merged, `未从分组输出读到合并全文（现状=${JSON.stringify(allBodyTexts(items))}）`);
    const html = renderMarkdown(merged);
    assert.ok(html.includes('<table'), '合并全文应渲染出 <table>');
    assert.ok(html.includes('<th>a</th>') && html.includes('<th>b</th>'), '表格应含 a|b 行');
    assert.ok(html.includes('<td>1</td>') && html.includes('<td>2</td>'), '表格应含 1|2 数据行');
    // 对照组（现状断裂形态）：分两段各自渲染无「完整表格」（同时含表头行与 1|2 数据行的表格）。
    const isCompleteTable = (h: string): boolean =>
      h.includes('<table') && h.includes('<td>1</td>') && h.includes('<td>2</td>');
    assert.ok(!isCompleteTable(renderMarkdown(seg1)), '段1 单独渲染无完整表格');
    assert.ok(!isCompleteTable(renderMarkdown(seg2)), '段2 单独渲染无完整表格');
  });
}

console.log('\n=== P2-04 单段零变化 ===');
{
  const single = LA;
  const items = groupMessagesForRender([body('single', single)]);
  check('P2-04 单段零变化：content 原样、key=msg.id、输出形态与现状一致', () => {
    assert.equal(items.length, 1);
    const it = items[0];
    assert.equal(it.type, 'message');
    if (it.type === 'message') {
      assert.equal(it.message.content, single, 'content 原样（首尾零添加）');
      assert.equal(it.key, 'single', 'key=msg.id');
    }
  });
}

console.log('\n=== P2-05 tool 过程夹隔阻断合并 ===');
{
  const items = groupMessagesForRender([body('A', LA), toolUse('use1', 'tool1'), body('B', LB)]);
  check('P2-05-1 tool_use 夹隔阻断合并：两段独立、过程项在中间', () => {
    assertNotMergedAround(items, LA, LB, 'tool_use 夹隔');
    assert.ok(foldItems(items).length >= 1, 'tool 过程项应在中间（fold 形态）');
  });
}
{
  const items = groupMessagesForRender([
    body('A', LA),
    toolUse('use1', 'tool1'),
    toolResult('res1', 'tool1'),
    body('B', LB),
  ]);
  check('P2-05-2 tool_use+tool_result 夹隔阻断合并：两段独立', () => {
    assertNotMergedAround(items, LA, LB, 'tool_use+tool_result 夹隔');
    assert.ok(foldItems(items).length >= 1, 'tool 过程对应在中间');
  });
}

console.log('\n=== P2-06 thinking 夹隔阻断合并 ===');
{
  const items = groupMessagesForRender([
    body('A', LA),
    thinkingMsg('th1', '思考内容'),
    body('B', LB),
  ]);
  check('P2-06 thinking 夹隔阻断合并：两段不跨 thinking 合并', () => {
    assertNotMergedAround(items, LA, LB, 'thinking 夹隔');
    assert.ok(foldItems(items).length >= 1, 'thinking 应在中间（fold 形态）');
  });
}

console.log('\n=== P2-07 user 夹隔阻断合并 ===');
{
  const items = groupMessagesForRender([body('A', LA), userText('u1', '追问'), body('B', LB)]);
  check('P2-07 user 夹隔阻断合并（回合边界是硬边界）', () => {
    assertNotMergedAround(items, LA, LB, 'user 夹隔');
    assert.ok(
      items.some((it) => it.type === 'message' && it.message.role === 'user'),
      'user 消息独立成项',
    );
  });
}

console.log('\n=== P2-08 system 夹隔阻断合并（含冗余 system，A5 裁决） ===');
{
  assert.equal(isRedundantSystemProcessKind('system:aborted'), false, '构造自检：system:aborted 非冗余');
  const items = groupMessagesForRender([body('A', LA), sysMsg('sysA', 'system:aborted'), body('B', LB)]);
  check('P2-08-1 非冗余 system（system:aborted，实际进 fold）夹隔阻断合并', () => {
    assertNotMergedAround(items, LA, LB, 'system:aborted 夹隔');
    const foldIds = foldItems(items).flatMap((f) => f.messages.map((m) => m.id));
    assert.ok(foldIds.includes('sysA'), '构造自检：system:aborted 实际进 fold');
  });
}
{
  assert.equal(isRedundantSystemProcessKind('system:informational'), true, '构造自检：命中冗余集');
  const items = groupMessagesForRender([
    body('A', LA),
    sysMsg('sysR', 'system:informational'),
    body('B', LB),
  ]);
  check('P2-08-2 冗余 system（isRedundantSystemProcessKind 命中）仍是消息流实体、构成夹隔阻断合并（A5）', () => {
    assertNotMergedAround(items, LA, LB, '冗余 system 夹隔');
  });
}

console.log('\n=== P2-09 isError 正文不并入且阻断紧邻 ===');
{
  const items = groupMessagesForRender([body('B', LB), body('errA', LERR, { isError: true }), body('C', LC)]);
  check('P2-09-1 err 长正文夹中间：三者各自独立、err 保持 isError 标', () => {
    assert.deepEqual(
      bodyMessageItems(items).map((m) => m.content),
      [LB, LERR, LC],
      '三者各自独立（err 不并入、err 阻断两侧互不相邻）',
    );
    const errItem = bodyMessageItems(items).find((m) => m.content === LERR);
    assert.ok(errItem && errItem.isError === true, 'err 段保持 isError 标（错误可见性）');
  });
}
{
  const items = groupMessagesForRender([body('errA', LERR, { isError: true }), body('B', LB), body('C', LC)]);
  check('P2-09-2 err 在首：阻断范围恰为紧邻，B+C 正常合并', () => {
    const texts = allBodyTexts(items);
    assert.ok(texts.includes(LERR), 'err 段独立保留（不被吞并）');
    assert.ok(texts.includes(LB + '\n' + LC), 'err 只阻断自己前后紧邻：B+C 应合并');
    assert.ok(!texts.includes(LB) && !texts.includes(LC), 'B、C 不应再独立存在（已合并为一段）');
  });
}
{
  const errShort = '失'.repeat(80);
  const tail = L('尾');
  const items = groupMessagesForRender([
    body('errS', errShort, { isError: true }),
    toolUse('use1', 'tool1'),
    toolResult('res1', 'tool1'),
    body('tail', tail),
  ]);
  check('P2-09-3 isError 且 ≤100 字短正文仍独立成条（hb10-CHR-V01 豁免折叠语义不破坏）', () => {
    assert.ok(
      bodyMessageItems(items).map((m) => m.content).includes(errShort),
      'err 短正文独立成 message 项',
    );
    const foldIds = foldItems(items).flatMap((f) => f.messages.map((m) => m.id));
    assert.ok(!foldIds.includes('errS'), 'err 短正文不得折进 fold');
  });
}

console.log('\n=== P2-10 跨 parentAgentId 不合并 ===');
{
  const items = groupMessagesForRender([
    body('a1', LA, { parentAgentId: 'agent1' }),
    body('a2', LB, { parentAgentId: 'agent2' }),
  ]);
  check('P2-10 不同 parentAgentId 相邻不合并、各自独立且归属保持', () => {
    assert.ok(!allBodyTexts(items).includes(LA + '\n' + LB), '跨 agent 不合并');
    assert.deepEqual(allBodyTexts(items), [LA, LB], '两段各自独立');
    const i1 = bodyMessageItems(items).find((m) => m.id === 'a1');
    const i2 = bodyMessageItems(items).find((m) => m.id === 'a2');
    assert.equal(i1?.parentAgentId, 'agent1', '归属保持（不串台）');
    assert.equal(i2?.parentAgentId, 'agent2', '归属保持（不串台）');
  });
}

console.log('\n=== P2-11 合并单元稳定标识（turn-diff 锚点 + 标识稳定） ===');
{
  const input = [userText('u1', '问题'), body('A', LA), body('B', LB)];
  const items = groupMessagesForRender(input);
  check('P2-11-1 合并单元 id=回合末正文 B.id（mapFinalTextToTurnStart 锚点命中）且承载合并全文', () => {
    const map = mapFinalTextToTurnStart(input);
    assert.ok(map.has('B'), '回归钉：mapFinalTextToTurnStart 产出键=回合末正文 B.id');
    assert.deepEqual(map.get('B'), { turnStartMessageId: 'u1', endMessageId: null }, '回合区间锚点形态');
    const mu = bodyMessageItems(items).find((m) => m.id === 'B');
    assert.ok(mu, '合并单元（承载回合末正文 id 的 message 项）应存在');
    assert.equal(mu.content, LA + '\n' + LB, '合并单元承载合并全文');
    assert.equal(mu.id, 'B', '合并单元稳定标识=回合末正文 id（A7，末回合 turn-diff 卡片不失锚）');
  });
  check('P2-11-2 同输入两次分组输出 deepEqual（标识稳定，无随机/时序 key）', () => {
    const again = groupMessagesForRender(input.map((m) => ({ ...m })));
    assert.deepEqual(again, items);
  });
}

console.log('\n=== P2-12 显示层合并不改输入 ===');
check('P2-12 调用后输入数组与深拷贝留底 deepEqual（不落库、不原地改写）', () => {
  const input = [body('x1', LA), body('x2', LB)];
  const snapshot = JSON.parse(JSON.stringify(input)) as RenderableMessage[];
  groupMessagesForRender(input);
  assert.deepEqual(input, snapshot, '输入消息对象零变化');
  assert.equal(input.length, 2, '输入数组长度不变');
});

console.log('\n=== P2-13 分组语义在合并单元上评估 ===');
{
  // 非回合最终形态：被测段之后另有正文 t3（同回合续后），使 t1/t2 均不落 protectedFinalTextIds
  // 保护位（现状下两短叙事进 fold 的叙述成立）。
  const t1 = '一'.repeat(60);
  const t2 = '二'.repeat(60);
  const t3 = L('三');
  const items = groupMessagesForRender([
    body('t1', t1),
    body('t2', t2),
    toolUse('use1', 'tool1'),
    toolResult('res1', 'tool1'),
    body('t3', t3),
  ]);
  check('P2-13-1 合并后 121>100：合并单元独立 message 项、不以两条短叙事身份进 fold', () => {
    const mergedItem = bodyMessageItems(items).find((m) => m.content === t1 + '\n' + t2);
    assert.ok(mergedItem, '合并单元（121>100）应独立成 message 项');
    const foldIds = foldItems(items).flatMap((f) => f.messages.map((m) => m.id));
    assert.ok(!foldIds.includes('t1') && !foldIds.includes('t2'), '被测段不得以两条短叙事身份进 fold');
  });
}
{
  // 非回合最终形态：s3 同回合续后，s1/s2 均不落保护位；合并后 81≤100 → 按短叙事规则并入 fold。
  const s1 = '甲'.repeat(40);
  const s2 = '乙'.repeat(40);
  const s3 = L('丙');
  const items = groupMessagesForRender([
    toolUse('use1', 'tool1'),
    toolResult('res1', 'tool1'),
    body('s1', s1),
    body('s2', s2),
    body('s3', s3),
  ]);
  check('P2-13-2 合并后 81≤100、非回合最终：合并单元按短叙事规则并入 fold、无被测段独立项', () => {
    assert.ok(items.some((it) => it.type === 'fold'), '输出存在 fold 项');
    const msgContents = bodyMessageItems(items).map((m) => m.content);
    assert.ok(!msgContents.includes(s1) && !msgContents.includes(s2), '被测段不产生独立 message 项');
    assert.ok(!msgContents.includes(s1 + '\n' + s2), '合并单元（81≤100）不独立成 message 项，应并入 fold');
  });
}
{
  const items = groupMessagesForRender([userText('u1', '问题'), body('A', LA), body('B', LB)]);
  check('P2-13-3 回合最终合并单元受保护独立 message 项（1 个，不是 2 个）', () => {
    const bodyItems = bodyMessageItems(items);
    assert.equal(bodyItems.length, 1, '正文渲染项恰 1 个（合并单元，不是两条各自独立）');
    assert.equal(bodyItems[0].content, LA + '\n' + LB, '合并单元承载合并全文');
    assert.equal(bodyItems[0].id, 'B', '合并单元 id=回合末正文 B.id（受保护锚点）');
    assert.equal(foldItems(items).length, 0, '回合最终文本受保护，不产生 fold');
  });
}

console.log('\n=== P2-14 老会话历史生效 + 确定性 ===');
{
  const old = '2024-01-15T00:00:00.000Z';
  const input = [body('o1', LA, { createdAt: old }), body('o2', LB, { createdAt: old })];
  const items = groupMessagesForRender(input);
  check('P2-14-1 旧时间戳输入同样合并（老会话历史受益）', () => {
    const bodyItems = bodyMessageItems(items);
    assert.equal(bodyItems.length, 1, '旧时间戳相邻长正文同样合并为 1 项');
    assert.equal(bodyItems[0].content, LA + '\n' + LB, '全文与新时间戳输入同构');
  });
  check('P2-14-2 同输入两次分组输出 deepEqual（无流式态/内存态/时间依赖）', () => {
    const again = groupMessagesForRender(input.map((m) => ({ ...m })));
    assert.deepEqual(again, items);
  });
}

console.log('\n=== P2-ATT attachments 聚合（impl-design §2.9 第 11 条） ===');
{
  const attA: AttachmentSummary = {
    id: 'att-a', sessionId: 's1', kind: 'image', filename: 'a.png', mimeType: 'image/png',
    sizeBytes: 10, previewAvailable: true, status: 'message',
  };
  const attB: AttachmentSummary = {
    id: 'att-b', sessionId: 's1', kind: 'document', filename: 'b.pdf', mimeType: 'application/pdf',
    sizeBytes: 20, previewAvailable: false, status: 'message',
  };
  const attC: AttachmentSummary = {
    id: 'att-c', sessionId: 's1', kind: 'file', filename: 'c.zip', mimeType: 'application/zip',
    sizeBytes: 30, previewAvailable: false, status: 'message',
  };
  const attItems = groupMessagesForRender([
    withAttachments(body('att1', LA), [attA]),
    withAttachments(body('att2', LB), [attB, attC]),
  ]);
  check('P2-ATT-1 相邻两长正文段各带 attachments → 合并单元（id=末段 id）attachments deepEqual 按序两段之和', () => {
    const mu = bodyMessageItems(attItems).find((m) => m.id === 'att2');
    assert.ok(mu, '合并单元（承载末段 id）应存在');
    assert.equal(mu.content, LA + '\n' + LB, '合并全文不受 attachments 聚合影响');
    assert.deepEqual(mu.attachments, [attA, attB, attC], 'attachments 应为前段在前、末段在后的按序之和');
  });
}
{
  const items = groupMessagesForRender([body('na1', LA), body('na2', LB)]);
  check('P2-ATT-2 两段均无 attachments 字段 → 合并产物 attachments === undefined（保持末段原值、无键差异）', () => {
    const mu = bodyMessageItems(items).find((m) => m.id === 'na2');
    assert.ok(mu, '合并单元（承载末段 id）应存在');
    assert.equal(mu.content, LA + '\n' + LB, '正文照常合并');
    assert.equal(mu.attachments, undefined, 'attachments 应保持 undefined（末段原值）');
    assert.ok(!('attachments' in mu), '合并产物不得新增 attachments 键（无键差异）');
  });
}
{
  const items = groupMessagesForRender([body('ea1', LA), withAttachments(body('ea2', LB), [])]);
  check('P2-ATT-3 前段无、末段 attachments 为空数组 → 合并产物 attachments deepEqual 空数组（末段原值保持）', () => {
    const mu = bodyMessageItems(items).find((m) => m.id === 'ea2');
    assert.ok(mu, '合并单元（承载末段 id）应存在');
    assert.deepEqual(mu.attachments, [], 'attachments 应保持末段空数组原值');
  });
}

console.log('\n=== P2-15 三面共用分组单点（结构钉） ===');
{
  const messageListSrc = readFileSync(
    new URL('../src/renderer/components/chat/MessageList.vue', import.meta.url),
    'utf8',
  );
  const subagentGroupsSrc = readFileSync(new URL('../src/renderer/utils/subagent-groups.ts', import.meta.url), 'utf8');
  const exportRunnerSrc = readFileSync(new URL('../src/renderer/export/export-runner.ts', import.meta.url), 'utf8');
  check('P2-15 MessageList / subagent-groups / export-runner 三处仍经 groupMessagesForRender', () => {
    const targets: Array<[string, string]> = [
      ['MessageList.vue', messageListSrc],
      ['subagent-groups.ts', subagentGroupsSrc],
      ['export-runner.ts', exportRunnerSrc],
    ];
    for (const [label, src] of targets) {
      assert.ok(src.includes('groupMessagesForRender'), `${label} 仍引用 groupMessagesForRender`);
      assert.ok(src.includes('groupMessagesForRender('), `${label} 仍调用 groupMessagesForRender（无绕行自渲染）`);
    }
  });
}

console.log('\n=== P2-16 流式去重语义保持 ===');
{
  const mSeg1 = '已落库第一段正文';
  const mSeg2 = '已落库第二段正文';
  const mergedFull = mSeg1 + '\n' + mSeg2;
  check('P2-16-1 组合：shouldHidePersistedForStreaming(合并全文 M, M+流式尾巴) === true（单显）', () => {
    assert.equal(
      shouldHidePersistedForStreaming(mergedFull, mergedFull + '流式增量尾巴'),
      true,
      '流式覆盖到合并全文之后时，合并气泡整体按既有前缀规则隐藏',
    );
  });
  check('P2-16-2 shouldHidePersistedForStreaming 纯函数 4 形态回归钉（去重规则本身未被波及）', () => {
    assert.equal(shouldHidePersistedForStreaming('', 'stream'), false, '空前缀串 → false');
    assert.equal(shouldHidePersistedForStreaming('persisted', ''), false, '空流串 → false');
    assert.equal(shouldHidePersistedForStreaming('abc', 'abc-def'), true, '前缀命中 → true');
    assert.equal(shouldHidePersistedForStreaming('abc', 'xabc'), false, '不命中 → false');
  });
  check('P2-16-3 结构钉：MessageList.vue 含 shouldHidePersistedForStreaming 调用字面', () => {
    const messageListSrc = readFileSync(
      new URL('../src/renderer/components/chat/MessageList.vue', import.meta.url),
      'utf8',
    );
    assert.ok(
      messageListSrc.includes('shouldHidePersistedForStreaming('),
      '去重组装层调用字面保留（仍作用于正文 message 项路径）',
    );
  });
}

console.log('\n=== P2-17 合并接线结构钉（impl-design §2.10） ===');
{
  const groupSrc = readFileSync(new URL('../src/renderer/utils/group-messages.ts', import.meta.url), 'utf8');
  check('P2-17 group-messages.ts 含 mergeAdjacentAssistantTexts(messages) / joinTextSegments / for (const msg of merged) 三字面', () => {
    assert.ok(groupSrc.includes('mergeAdjacentAssistantTexts(messages)'), '缺 mergeAdjacentAssistantTexts(messages) 调用字面（合并未接入分组主链）');
    assert.ok(groupSrc.includes('joinTextSegments'), '缺 joinTextSegments 字面（拼接换行规则函数消失）');
    assert.ok(groupSrc.includes('for (const msg of merged)'), '缺 for (const msg of merged) 遍历字面（合并结果须在分组层消费）');
  });
}

console.log('\n=== selftest 清单登记 ===');
check('selftest-static-list.txt 已登记本脚本', () => {
  const list = readFileSync(new URL('selftest-static-list.txt', import.meta.url), 'utf8');
  const registered = list
    .split(/\r?\n/)
    .map((l) => l.trim())
    .includes('scripts/tdd-adjacent-text-merge-verify.ts');
  assert.ok(registered, '清单未登记 scripts/tdd-adjacent-text-merge-verify.ts');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
