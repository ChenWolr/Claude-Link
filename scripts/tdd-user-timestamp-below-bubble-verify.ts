// tdd-user-timestamp-below-bubble-verify.ts
// UI13 批次 P5「用户消息时间戳移到气泡下方」（2026-11-14 计划，用例正本 03-test-cases.md §P5）。
// TDD 验证脚本：T5-A~H 八条用例，静态结构钉 + formatSentAt 纯函数回读 + 内联 spawn 既有
// tdd-user-message-time-verify.ts（T5-C 格式语义回归门）：
//   T5-A  旧形态清除——user 分支不再渲染「你」角色头行与气泡内「发送于 {{ sentAtText }}」脚注；
//   T5-B  气泡正下方新行——单根 bubble-wrap wrapper（保 class fallthrough）+ 兄弟 caption 行
//         「你 · 发送于 {HH:mm:ss}」（P3 2026-11-21 批次升秒级）+ wrap--user 右对齐（承接原
//         .bubble--user 的 align-self）；
//   T5-C  格式语义回归门——spawn tdd-user-message-time-verify.ts 退出码 0（formatSentAt
//         当天 HH:mm:ss / 跨天 M/d HH:mm:ss 口径不动）；
//   T5-D  「来自队列」标签随行——bubble__queue-tag（parentTaskId 门控 + 原 title + !exportMode）
//         从角色头迁至 caption 行内；
//   T5-E  assistant 逐字节不变——「Claude」角色头、耗时/「· 结束于」脚注字面与门控全保留；
//   T5-F  createdAt 缺失/非法不渲染——caption 以 sentAtText 门控，纯函数回空串（诚实不造数）；
//   T5-G  复制/附件/流式/导出零影响——copy 钮、MessageAttachments、user 纯文本回显分支、
//         exportMode 分支锚点全保留 + selftest 清单登记；
//   T5-H  流式乐观消息即带行——caption 门控不含流式/导出附加条件，sentAtText 单链路直读
//         createdAt，毫秒级乐观 ISO 当场可格式化。
// RED 先行：wrapper/caption 未实现时 T5-A/B/C/D/F/H 应红、T5-E/G 回归钉现状即绿（期望桶见点报告）。
// 运行：npx tsx scripts/tdd-user-timestamp-below-bubble-verify.ts（已登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatSentAt } from '../src/shared/format-duration';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const bubbleSrc = readFileSync(
  new URL('../src/renderer/components/chat/MessageBubble.vue', import.meta.url),
  'utf8',
);
const templateStart = bubbleSrc.indexOf('<template>');
const templateEnd = bubbleSrc.lastIndexOf('</template>');
const bubbleTpl = bubbleSrc.slice(templateStart, templateEnd);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** 取 caption 行元素块（caption div 内无嵌套 div，首个 </div> 即其闭合）。 */
function captionBlock(): string {
  const start = bubbleTpl.indexOf('class="bubble-caption"');
  assert.ok(start >= 0, '未找到 caption 行（class="bubble-caption"）——气泡下方时间行未实现');
  const end = bubbleTpl.indexOf('</div>', start);
  assert.ok(end > start, 'caption 块结构异常（无闭合标签）');
  return bubbleTpl.slice(start, end);
}

console.log('\n=== T5-A 旧形态清除 ===');
check('T5-A user 分支不再渲染「你」角色头行与气泡内「发送于 {…}」脚注（旧 .bubble__meta 块删除）', () => {
  // 旧脚注字面（气泡内 bubble__meta 形态）必须清除
  assert.ok(
    !bubbleTpl.includes('<span>发送于 {{ sentAtText }}</span>'),
    '气泡内「<span>发送于 {{ sentAtText }}</span>」脚注残留（双时间戳回退）',
  );
  // 旧「user 门控 + bubble__meta 类」脚注块必须删除
  assert.ok(
    !/v-if="message\.role === 'user' && sentAtText" class="bubble__meta"/.test(bubbleTpl),
    '旧「v-if=message.role===user && sentAtText + class=bubble__meta」脚注块残留',
  );
  // 「你」角色头行必须排除 user 分支（assistant/tool 的 Claude 头保留）
  // 契约同步（2026-11-19 UI 五点批次 P5 挂载点 A）：.bubble__role 包进 .bubble__role-row flex 行
  // （role 文本右侧挂 TranslationChrome swap pill，MessageBubble.vue 同名注释申报）——角色头元素
  // div→div.bubble__role-row+span.bubble__role 形态变化，本钉同步锚 role-row 行；「排除 user」
  // 语义不变（v-if 原样保留 message.role !== 'user'），另补角色头元素 span 形态在位钉。
  const roleMatch = bubbleTpl.match(/<div v-if="([^"]+)" class="bubble__role-row">/);
  assert.ok(roleMatch, '.bubble__role 角色头行消失（assistant 角色头不得被误删）');
  assert.ok(
    roleMatch[1].includes("message.role !== 'user'"),
    `.bubble__role v-if（${roleMatch[1]}）未排除 user——user 气泡内仍会渲染「你」角色头`,
  );
  assert.ok(bubbleTpl.includes('<span class="bubble__role">'), '.bubble__role 角色头元素（span）应仍在 role-row 行内');
});

console.log('\n=== T5-B 气泡正下方新行 ===');
check('T5-B-1 单根 bubble-wrap wrapper（保 class fallthrough）+ user-bubble-wrap testid', () => {
  // 多根 fragment 会禁用 class fallthrough（MessageList:320 的 msg-transition 走 attrs 透传），单根是硬约束。
  // 根元素前允许说明注释——剥离 HTML 注释后再判定单根（注释不是元素，不影响单根性）。
  const tplBody = bubbleTpl
    .slice(bubbleTpl.indexOf('<template>') + '<template>'.length)
    .replace(/<!--[\s\S]*?-->/g, '');
  assert.match(
    tplBody,
    /^\s*<div :class="\['bubble-wrap', `bubble-wrap--\$\{message\.role\}`\]"/,
    '模板根元素应为单根 bubble-wrap（含 bubble-wrap--{role} 修饰类）——多根 fragment 会静默丢 msg-transition fallthrough',
  );
  assert.ok(
    bubbleTpl.includes("'user-bubble-wrap'"),
    'wrapper 缺 user-bubble-wrap data-testid（E2E/导出冒烟定位锚）',
  );
});
check('T5-B-2 caption 行文案形态「你 · 发送于 {HH:mm:ss}」（含连接文本 + sentAtText 插值；P3 升秒级）', () => {
  assert.ok(
    bubbleTpl.includes('你 · 发送于 {{ sentAtText }}'),
    'caption 行缺「你 · 发送于 {{ sentAtText }}」文本（丢了「你 ·」前缀或 sentAtText 插值）',
  );
  const capStart = bubbleTpl.indexOf('class="bubble-caption"');
  const bubbleRootIdx = bubbleTpl.indexOf("`bubble--${message.role}`");
  assert.ok(
    capStart > bubbleRootIdx,
    'caption 行应位于气泡元素之后（气泡正下方兄弟行，非气泡内脚注回退）',
  );
});
check('T5-B-3 行随气泡右对齐（bubble-wrap--user 承接 align-self:flex-end + align-items:flex-end）', () => {
  // 剥离 CSS 注释再断言（注释可提及 align-self 迁移说明，声明级存在性才是观测面）
  const css = bubbleSrc.slice(bubbleSrc.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '');
  const userWrapMatch = css.match(/\.bubble-wrap--user\s*\{([^}]*)\}/);
  assert.ok(userWrapMatch, '样式缺 .bubble-wrap--user 规则（右对齐未承接）');
  assert.ok(userWrapMatch[1].includes('align-self: flex-end'), '.bubble-wrap--user 应含 align-self: flex-end（原 .bubble--user 迁移）');
  assert.ok(userWrapMatch[1].includes('align-items: flex-end'), '.bubble-wrap--user 应含 align-items: flex-end（caption 行随气泡右对齐）');
  // 原 .bubble--user/.bubble--assistant 的 align-self 应移除（迁移至 wrap，防双份对齐打架）
  const userBubbleMatch = css.match(/\.bubble--user\s*\{([^}]*)\}/);
  const assistantBubbleMatch = css.match(/\.bubble--assistant\s*\{([^}]*)\}/);
  assert.ok(userBubbleMatch && !userBubbleMatch[1].includes('align-self'), '.bubble--user 残留 align-self（应迁移至 wrap）');
  assert.ok(assistantBubbleMatch && !assistantBubbleMatch[1].includes('align-self'), '.bubble--assistant 残留 align-self（应迁移至 wrap）');
});

console.log('\n=== T5-S1/S2 UI13 评审 r1 回归钉（P3-2 system 居中恢复 + P3-3 TaskQueuePanel 覆盖规则钉） ===');
check('T5-S1 .bubble-wrap--system 居中钉（align-self:center + align-items:center——恢复批次前水平居中形态）', () => {
  // 剥离 CSS 注释再断言（同 T5-B-3：注释是文档不是渲染面，声明级存在性才是观测面）
  const css = bubbleSrc.slice(bubbleSrc.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '');
  const systemWrapMatch = css.match(/\.bubble-wrap--system\s*\{([^}]*)\}/);
  assert.ok(systemWrapMatch, '样式缺 .bubble-wrap--system 独立规则（system 对齐仍混在 flex-start 组里）');
  assert.ok(
    systemWrapMatch[1].includes('align-self: center'),
    '.bubble-wrap--system 应含 align-self: center（system 气泡水平居中，UI13 批次前形态——原 .bubble--system{align-self:center} 在收缩 wrap 内成 no-op）',
  );
  assert.ok(
    systemWrapMatch[1].includes('align-items: center'),
    '.bubble-wrap--system 应含 align-items: center（caption 行随气泡居中）',
  );
});
check('T5-S2 TaskQueuePanel 子 agent 域 :deep(.bubble-wrap) 覆盖规则存在钉（width:100% + align-self:stretch）', () => {
  // P3-3：UI13-P5 新增的 .subagent-group__body :deep(.bubble-wrap) 覆盖规则此前零回归钉
  // （tdd-subagent-verify 只钉旧 .bubble 规则）——误删时子 agent 消息落进收缩 wrap 丢 100% 宽、布局破毁。
  const tqpSrc = readFileSync(
    new URL('../src/renderer/components/task/TaskQueuePanel.vue', import.meta.url),
    'utf8',
  );
  const css = tqpSrc.slice(tqpSrc.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '');
  const wrapMatch = css.match(/\.subagent-group__body\s*:deep\(\.bubble-wrap\)\s*\{([^}]*)\}/);
  assert.ok(wrapMatch, 'TaskQueuePanel 缺 .subagent-group__body :deep(.bubble-wrap) 覆盖规则（误删则子 agent 消息布局破毁）');
  assert.ok(wrapMatch[1].includes('width: 100%'), '覆盖规则应含 width: 100%（wrap 与 .bubble 同宽）');
  assert.ok(
    wrapMatch[1].includes('align-self: stretch'),
    '覆盖规则应含 align-self: stretch（压过组件内 bubble-wrap--user/--assistant 的 flex-end/flex-start）',
  );
});

console.log('\n=== T5-C 格式语义回归门（内联 spawn 既有契约脚本） ===');
check('T5-C npx tsx scripts/tdd-user-message-time-verify.ts 退出码 0（formatSentAt 口径不动）', () => {
  const r = spawnSync('npx', ['tsx', 'scripts/tdd-user-message-time-verify.ts'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-6).join('\n');
  assert.equal(r.status, 0, `tdd-user-message-time-verify.ts 退出码 ${r.status}（格式口径被波及）\n${tail}`);
});

console.log('\n=== T5-D 「来自队列」随行 ===');
check('T5-D bubble__queue-tag（parentTaskId 门控 + 原 title + !exportMode）迁至 caption 行内', () => {
  const block = captionBlock();
  assert.ok(block.includes('bubble__queue-tag'), '「来自队列」标签未挂靠 caption 行（丢失或仍留在被删的角色头里）');
  assert.ok(
    block.includes('v-if="!exportMode && message.parentTaskId"'),
    '队列标签门控残缺（应为 !exportMode && message.parentTaskId）',
  );
  assert.ok(
    block.includes('title="此消息由队列任务到点/立即执行时发送"'),
    '队列标签原 title 文案丢失',
  );
  assert.ok(block.includes('来自队列'), '队列标签「来自队列」文案丢失');
});

console.log('\n=== T5-E assistant 逐字节不变（回归钉） ===');
check('T5-E 「Claude」角色头、耗时/「· 结束于」脚注字面与门控逐字节保留', () => {
  // 观测面 = 剥离注释后的模板（注释是文档不是渲染面，改动说明可自由措辞不参与钉）。
  const tpl = bubbleTpl.replace(/<!--[\s\S]*?-->/g, '');
  // UI13-P5：user「你」分支删除后角色头只服务 assistant/tool——「Claude」字面保留（渲染逐字节不变）；
  // 且不得回退成带 user 分支的三元形态（防「你」角色头回归；该三元在新 v-if 收窄下也无法过 typecheck）。
  assert.ok(tpl.includes('>Claude</span>'), 'assistant「Claude」角色头字面丢失');
  assert.ok(!tpl.includes("'你' : 'Claude'"), '角色头回退为含 user 分支的三元形态（「你」角色头回归）');
  // C6 连带改钉（slate-ui-completion-1108-1428 中断脚注点）：正常脚注块改 v-else-if（中断分支在前，
  // 与 b3 ⑦/hb10 TM-04/settings-mapping 同款单行同步）——assistant 脚注耗时/结束于内容逐字不变。
  assert.ok(
    tpl.includes('v-else-if="message.durationMs || message.endedAt" class="bubble__meta"'),
    'assistant 脚注门控被改（v-else-if="message.durationMs || message.endedAt" class="bubble__meta"）',
  );
  assert.ok(tpl.includes('· 结束于 {{ endedAtText }}'), '「· 结束于 {{ endedAtText }}」字面丢失');
  assert.ok(tpl.includes('class="bubble__meta-duration"'), '耗时 class bubble__meta-duration 丢失');
  assert.ok(tpl.includes('class="bubble__meta-end"'), '结束于 class bubble__meta-end 丢失');
  assert.ok(tpl.includes('class="bubble__meta-clock"'), '脚注时钟图标 class bubble__meta-clock 丢失');
});

console.log('\n=== T5-F createdAt 缺失/非法不渲染 ===');
check('T5-F caption 以 sentAtText 门控（无「你 · 发送于」空尾残留）；纯函数回空串', () => {
  const capStart = bubbleTpl.indexOf('class="bubble-caption"');
  assert.ok(capStart >= 0, 'caption 行未实现，无从核门控');
  const capOpen = bubbleTpl.lastIndexOf('<div', capStart);
  const capTag = bubbleTpl.slice(capOpen, capStart + 'class="bubble-caption"'.length);
  assert.ok(
    capTag.includes("v-if=\"message.role === 'user' && sentAtText\""),
    'caption 门控缺失（应为 v-if="message.role === \'user\' && sentAtText"，否则空时间尾残留）',
  );
  // 纯函数语义回归：缺失/非法三态入参经 formatSentAt 回空串（诚实不造数）
  assert.equal(formatSentAt(null), '');
  assert.equal(formatSentAt(undefined), '');
  assert.equal(formatSentAt('not-a-date'), '');
  assert.equal(formatSentAt(''), '');
});

console.log('\n=== T5-G 复制/附件/流式/导出零影响（回归钉） ===');
check('T5-G-1 复制钮/附件挂载点/user 纯文本回显分支/exportMode 分支锚点全保留', () => {
  assert.ok(
    bubbleTpl.includes("v-if=\"!exportMode && (message.role === 'user' || message.role === 'assistant')\""),
    '复制按钮门控被波及（user/assistant 才有复制钮）',
  );
  assert.ok(bubbleTpl.includes('class="bubble__copy"'), '复制按钮 class bubble__copy 丢失');
  assert.ok(bubbleTpl.includes('@click="copyMessage"'), '复制按钮点击链路丢失');
  assert.ok(
    bubbleTpl.includes('<MessageAttachments v-if="attachments.length" :attachments="attachments" :export-mode="exportMode" />'),
    '附件挂载点被波及',
  );
  assert.ok(
    bubbleTpl.includes(`v-if="hasContent && message.role === 'user'" class="bubble__content">{{ message.content }}`),
    'user 纯文本回显分支（插值 + pre-wrap）被波及',
  );
  assert.ok(
    bubbleSrc.includes("renderMarkdown(props.message.content, props.exportMode ? 'export' : 'rich')"),
    'exportMode 渲染 profile 锚点被波及',
  );
  const css = bubbleSrc.slice(bubbleSrc.indexOf('<style'));
  assert.ok(/\.bubble--user \.bubble__content\s*\{[^}]*white-space: pre-wrap/.test(css), 'user 气泡 pre-wrap 样式被波及');
});
check('T5-G-2 selftest-static-list.txt 已登记本脚本', () => {
  const list = readFileSync(new URL('selftest-static-list.txt', import.meta.url), 'utf8');
  const registered = list
    .split(/\r?\n/)
    .map((l) => l.trim())
    .includes('scripts/tdd-user-timestamp-below-bubble-verify.ts');
  assert.ok(registered, '清单未登记 scripts/tdd-user-timestamp-below-bubble-verify.ts');
});

console.log('\n=== T5-H 流式中乐观消息即带时间行 ===');
check('T5-H caption 门控无流式/导出附加条件；sentAtText 直读 createdAt；乐观毫秒级 ISO 当场可格式化', () => {
  // 门控必须恰为 role+sentAtText 两条件——流式/乐观态无额外开关，新发消息（内存毫秒级 ISO）立即呈现
  assert.match(
    bubbleTpl,
    /<div v-if="message\.role === 'user' && sentAtText" class="bubble-caption">/,
    'caption v-if 形态漂移（不得附加 streaming/exportMode 等门控，乐观消息须当场带行）',
  );
  assert.match(
    bubbleSrc,
    /sentAtText = computed\(\(\) =>\s*props\.message\.role === 'user' \? formatSentAt\(props\.message\.createdAt\) : ''/,
    'sentAtText 必须单链路直读 createdAt（formatSentAt 单源），不得掺流式态条件',
  );
  // 乐观消息 createdAt = 内存 toISOString 毫秒级（当天）→ 当场格式化为 HH:mm:ss（P3 升秒级）
  assert.match(formatSentAt(new Date().toISOString()), /^\d{2}:\d{2}:\d{2}$/, '乐观毫秒级 ISO 当天应格式化为 HH:mm:ss');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
