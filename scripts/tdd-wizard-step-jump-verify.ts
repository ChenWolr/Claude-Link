// tdd-wizard-step-jump-verify.ts
// C3 重写版（2026-11-15 eight-issues 批次 C3 点；用例正本 03b-test-cases-renderer.md §6 C3-2/C3-4-④
// 与 §4 C1-13①；行为权威 00-behavior-specs.md 域 C C1/C3 节；实现权威 02-impl-details-renderer.md
// §3/§5.1。前史：C-W1 版（2026-11-05）钉向导分页态（步骤圆点/翻页落账/末步守卫）；C1 变体 2
// 「左侧题号导航栏」重构（2026-11-16 已落）移除分页实现，本脚本按重写纪律重组（登记名不变）。
//
// 废卷面（C1 重构移除，随本重写废止并在此留痕——勿再按旧锚补钉）：
//  旧钉 1/2（步骤圆点 button 化/--done 按 isQuestionAnswered 点亮）——圆点行整体移除，左栏
//    wizard-nav 承担三态标识（本重写版①②③）；
//  旧钉 3（jumpToQuestion 越界守卫+跳走前 persistCurrentQuestionAnswer+loadWizardStep）——
//    翻页落账移除（草稿账本即答即写=契约 5），jumpToQuestion 改直达+警示清除（本重写版④附钉）；
//  旧钉 4（previousQuestion 委托+模板绑定）——函数名契约迁 enter-guard 重写版（C3-3①保留面）；
//  旧钉 5（submit wizard 分支 !allQuestionsAnswered 末步守卫+firstUnanswered）——submit 整体
//    移除 wizard 分支，未答齐定位改 submitWizard 承担（本重写版⑧⑨）；
//  旧钉 8（draftCache 值类型/watch 源/写入/恢复含 wizardIndex）——wizardIndex 仍在类型与 watch
//    源（题号暂存语义保留），钉力改聚焦「按 request.id 键控」（本重写版⑩；hb13-v 姊妹门管键守卫）；
//  旧钉 9（.interaction-step button 重置样式）——圆点样式随圆点行移除（本重写版⑮样式纪律组）。
//
// 保留面（语义存活，逐字钉）：
//  旧钉 6 isQuestionAnswered 双判据（selectedOptionIds?.length / otherText.trim）——三态「已答」
//    判据沿用（本重写版⑬）；旧钉 7 历史区 <details> v-if="history.length"（⑭）；draftCache 按
//    request.id 键控（⑩，hb13-v A8 机制零变化）。
//
// 新钉面（变体 2「左侧题号导航栏」，2026-11-15 用户拍板；锚点=2026-11-16 实测行号）：
//  ①interaction-dialog--wizard 宽档类+分栏 body；②wizard-nav 导航结构（nav/testid/item button/
//  跳到第 N 题 title+aria/jumpToQuestion 直达）；③左栏三态类名 answered/current/--flagged+编号圈
//  ✓/index+1；④row2 状态行（wizardNavSummary：未作答/已选 N 项/自定义·截断）；⑤wizard-content
//  右栏单题（wizard-qhead 题号/wizard-qtext 题干/InteractionOptionList wizard 专用 props）；
//  ⑥头部进度 chip 常显（已答 answeredCount/总数）；⑦wizard footer 结构（取消/进度/上一题/
//  下一题，上一题仅第一题禁用）；⑧下一题恒可点（无 :disabled 负向钉+wizardPrimaryLabel 三分支）；
//  ⑨未答齐提交早退序（submitWizard findIndex→flagged+跳转+return→不置 submittingId 负向）；
//  ⑩draftCache 按 request.id 键控（watch 源断言）；⑪丢弃保护有作答门（requestDiscard）；
//  ⑫确认层双钮（继续作答/丢弃+discardCounts 正文，附钉⑫b Esc 分域序）；⑬isQuestionAnswered
//  判据保留；⑭历史区 details 保留（见上「保留面」）；⑮~⑯b C3-4④Other 保全（updateAnswer
//  单写入点恰 3 调用/非出集路径 otherText 清空写点零出现/出集清空按新形态保留/wizard Other
//  输入即时落账+Enter blur，附钉⑮b）；⑰新增样式块裸 hex 负向钉（C1-13①：色值全 var()/
//  color-mix）。
//
// 〔R2-C 契约同步留痕（2026-11-17，round-002 修复组 C）：P33 裸色值迁 token——实现侧
//   .wizard-nav__item.answered .n 前景 color:#fff → var(--color-on-success)（variables.css:27
//   既有 token，视觉等价 #FFFFFF），⑰ 的「#hex 仅限申报先例 color: #fff」容许清单随之移除
//  （钉改零裸 hex + answered .n 正面抽查 on-success token）。M-E 头注枚举序号漂移同轮更正
//  （原「⑭⑮Other 保全／⑯hex 钉」→ 实际 ⑮~⑯b／⑰）。〕
//
// 〔R4-1 分流同步留痕（2026-11-18 round-004 修复轮）：footer 主按钮 @click 由无条件 submitWizard
//   改分流=非末题 goNext（跳过语义，C1 契约 2「下一题恒可点（允许跳过未答题）」）/末题
//   submitWizard（未答齐定位+警示）——⑧ 主按钮锚字面随分流形态最小同步（sidenav 5a/5e 同锚面），
//   排布/恒可点/label 三分支语义不变。〕
//
// 〔M-R6-2 补钉留痕（2026-11-18 round-006 修复轮）：⑨ 组新增 ⑨c——submitWizard 未答齐早退分支
//   切片含 focusedIndex.value = 0;（round-005 备忘(e) 复位行的契约钉护，focusedIndex 复位四路径
//   钉面收口）；并入卷内既有 redOnOld 自证机制（旧源无 submitWizard，functionBody 定位即缺必红）。〕
//
// 「对旧实现必红」自证（内置，C3-2 期望条款）：spawnSync git show 取批次基线提交 3be0d7d
//（04-实施计划 §0；指令原文 HEAD: 在实施期与之等价——固定取基线快照防本批提交入库后自证自毁，
// 机制详见 direct-submit 重写版头注）旧源码写临时文件 scratch/c3-old-InteractionPrompt-*.vue
// 留痕，对 redOnOld 新钉断言至少一条 FAIL（输出留痕），随后对当前实现全绿。
//
// 运行：npx tsx scripts/tdd-wizard-step-jump-verify.ts（登记 scripts/selftest-static-list.txt:262）

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
let src = readFileSync(new URL('../src/renderer/components/chat/InteractionPrompt.vue', import.meta.url), 'utf8');

interface CheckItem { name: string; fn: () => void; redOnOld: boolean; group: string }
const checks: CheckItem[] = [];
let pendingGroup = '';
function group(title: string): void { pendingGroup = title; }
let pass = 0;
let fail = 0;
function check(name: string, fn: () => void, redOnOld = false): void {
  checks.push({ name, fn, redOnOld, group: pendingGroup });
}
function runCheck(item: CheckItem): void {
  try { item.fn(); pass++; console.log(`  ✅ ${item.name}`); }
  catch (e) { fail++; console.log(`  ❌ ${item.name} — ${(e as Error).message}`); }
}

function functionBody(name: string): string {
  const marker = `function ${name}(`;
  const idx = src.indexOf(marker);
  assert.ok(idx > -1, `缺 ${name}`);
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.ok(body.length > 0, `${name} 函数体切片失败`);
  return body;
}

/** 切片块状 computed：自 `const <name> = computed(() => {` 起、花括号配对至闭合。 */
function computedBody(name: string): string {
  const marker = `const ${name} = computed(() => {`;
  const idx = src.indexOf(marker);
  assert.ok(idx > -1, `缺 ${name} computed`);
  let depth = 0;
  let cursor = idx + marker.length - 1;
  while (cursor < src.length) {
    const ch = src[cursor];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(idx, cursor + 1);
    }
    cursor++;
  }
  assert.ok(false, `${name} computed 花括号配对失败`);
}

/** 切片模板块：marker 起、至 endMarker 首现（不含）。 */
function templateSlice(marker: string, endMarker: string): string {
  const start = src.indexOf(marker);
  assert.ok(start > -1, `缺模板块 ${marker}`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, `模板块闭合缺失（${endMarker}）`);
  return src.slice(start, end);
}

/** 切片 wizard footer。 */
function wizardFooterBlock(): string {
  return templateSlice('<footer v-if="isWizard"', '</footer>');
}

/** 切片丢弃确认层浮层（v-if="discardConfirmVisible" 起、至 data-testid 之后首个 </div> 配对闭合）。 */
function discardConfirmBlock(): string {
  return divBlock('<div v-if="discardConfirmVisible"');
}

/** div 配对切片：marker 起逐个前进扫描 <div / </div>、深度计数（开标签自身计 1）至归零。
 *  容器内新增嵌套 div 不截断；不含换行的 marker 兼容 CRLF 工作区文件。 */
function divBlock(marker: string): string {
  const start = src.indexOf(marker);
  assert.ok(start > -1, `缺模板块 ${marker}`);
  let depth = 0;
  let cursor = start;
  let end = -1;
  while (cursor < src.length) {
    const open = src.indexOf('<div', cursor);
    const close = src.indexOf('</div>', cursor);
    if (close === -1) break;
    if (open !== -1 && open < close) { depth++; cursor = open + '<div'.length; }
    else { depth--; cursor = close + '</div>'.length; if (depth === 0) { end = cursor; break; } }
  }
  assert.ok(end > start, `div 配对失败（${marker}）`);
  return src.slice(start, end);
}

/** 按钮开标签切片：block 内含 needle 的 `<button` 起至 `>`（lastIndexOf 定位，免字距漂移）。 */
function buttonOpenTag(block: string, needle: string): string {
  const at = block.indexOf(needle);
  assert.ok(at > -1, `块内缺 ${needle}`);
  const open = block.lastIndexOf('<button', at);
  assert.ok(open > -1, `${needle} 前缺 <button 开标签`);
  const gt = block.indexOf('>', at);
  assert.ok(gt > -1, `${needle} 开标签未闭合`);
  return block.slice(open, gt + 1);
}

/** 切片 handleKeydown 内 wizard 早退分支（if (isWizard.value) { … } 花括号配对体，含内部嵌套）。 */
function wizardKeyBranch(): string {
  const body = functionBody('handleKeydown');
  const marker = 'if (isWizard.value) {';
  const start = body.indexOf(marker);
  assert.ok(start > -1, 'handleKeydown 缺 wizard 早退分流（C1 变体 2 结构）');
  let depth = 0;
  let cursor = start + marker.length - 1;
  let end = -1;
  while (cursor < body.length) {
    const ch = body[cursor];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = cursor; break; } }
    cursor++;
  }
  assert.ok(end > start, 'wizard 分支花括号配对失败');
  return body.slice(start, end + 1);
}

/** 提取样式规则体：自选择器起至首个 `}`。 */
function styleRule(selector: string): string {
  const idx = src.indexOf(selector);
  assert.ok(idx > -1, `缺样式规则 ${selector}`);
  return src.slice(idx, src.indexOf('}', idx));
}

group('=== 新钉：变体 2 分栏结构（①宽档类 ②左栏导航 ③三态类名） ===');
check('① interaction-dialog--wizard 宽档类绑定+独立样式（57.5rem token）+wizard 分栏 body', () => {
  assert.ok(src.includes(`'interaction-dialog--wizard': isWizard`), '缺 interaction-dialog--wizard 类绑定');
  const rule = styleRule('.interaction-dialog--wizard {');
  assert.match(rule, /width: var\(--interaction-panel-width-wide\);/, 'wizard 宽档未引用 --interaction-panel-width-wide token');
  assert.ok(src.includes('<div v-if="isWizard" class="interaction-dialog__body--wizard">'), '缺 wizard 分栏 body');
}, true);
check('② wizard-nav 结构：nav(testid/aria-label) + item button(type=button/jumpToQuestion 直达/跳到第 N 题 title+aria)', () => {
  const nav = templateSlice('<nav class="wizard-nav"', '</nav>');
  assert.match(nav, /<nav class="wizard-nav" data-testid="wizard-nav" aria-label="题目导航">/, 'nav 开标签形态不符');
  assert.match(nav, /v-for="\(question, index\) in wizardQuestions"/, '缺题目 v-for');
  assert.match(nav, /:key="question\.id"/, 'item 缺 :key');
  assert.match(nav, /class="wizard-nav__item"/, 'item 缺类名');
  assert.match(nav, /type="button"/, 'item 须为 type=button（防表单隐式 submit）');
  assert.match(nav, /@click="jumpToQuestion\(index\)"/, 'item 缺 jumpToQuestion 直达绑定（任意序自由跳）');
  assert.match(nav, /:title="`跳到第 \$\{index \+ 1\} 题`"/, 'item 缺 title 提示');
  assert.match(nav, /:aria-label="`跳到第 \$\{index \+ 1\} 题：\$\{wizardNavSummary\(question\)\}`"/, 'item 缺含状态摘要的 aria-label');
  assert.match(nav, /data-testid="wizard-nav-item"/, 'item 缺 testid');
  assert.ok(!nav.includes('persist'), '左栏跳转不得含落账步骤（草稿账本即答即写）');
}, true);
check('③ 左栏三态类名：answered=isQuestionAnswered / current=wizardIndex===index / --flagged=wizardFlaggedIndex；编号圈 ✓/index+1', () => {
  const nav = templateSlice('<nav class="wizard-nav"', '</nav>');
  assert.match(nav, /answered: isQuestionAnswered\(questionAnswers\[question\.id\]\)/, 'answered 态判据不符');
  assert.match(nav, /current: wizardIndex === index/, 'current 态绑定不符');
  assert.match(nav, /'wizard-nav__item--flagged': wizardFlaggedIndex === index/, 'flagged 警示态绑定不符');
  assert.match(nav, /\{\{ isQuestionAnswered\(questionAnswers\[question\.id\]\) \? '✓' : index \+ 1 \}\}/, '编号圈 ✓/序号绑定不符');
}, true);

group('=== 新钉：row2 状态行 / wizard-content 右栏 / 进度 chip（④⑤⑥） ===');
check('④ row2 状态行：wizardNavSummary 绑定 + 未作答/已选 N 项/自定义·截断文案', () => {
  const nav = templateSlice('<nav class="wizard-nav"', '</nav>');
  assert.match(nav, /<span class="row2">\{\{ wizardNavSummary\(question\) \}\}<\/span>/, '缺 row2 状态行节点');
  const body = functionBody('wizardNavSummary');
  assert.ok(body.includes("return '未作答';"), '缺未答「未作答」文案');
  assert.match(body, /已选 \$\{ids\.length\} 项/, '缺多选「已选 N 项」摘要');
  assert.ok(body.includes('自定义 · '), '缺 Other「自定义 ·」摘要前缀');
  assert.match(body, /chars\.length > 24 \? `\$\{chars\.slice\(0, 24\)\.join\(''\)}…`/, '缺 24 码点截断');
  assert.match(body, /已选「\$\{label\}」/, '缺单选「已选「label」」摘要');
}, true);
check('⑤ wizard-content 右栏单题：题号行+题干+wizard 专用选项 props+分页保留（一次一题）', () => {
  const content = divBlock('<div class="wizard-content"');
  assert.match(content, /第 \{\{ wizardIndex \+ 1 \}\} 题 \/ 共 \{\{ wizardQuestions\.length \}\} 题/, '缺当前题号行（第 N 题 / 共 M 题）');
  assert.match(content, /\{\{ currentMultiSelect \? '多选' : '单选 · 点击即作答' \}\}/, '缺题型 tag（单选直提提示）');
  assert.match(content, /<div class="wizard-qtext">\{\{ activeQuestion\?\.title \}\}<\/div>/, '缺右栏题干（题干移入右栏=契约 C1 变体 2）');
  assert.match(content, /:selected-ids="wizardSelectedIds"/, '选项列表未接 wizard 账本选中集');
  assert.match(content, /@toggle="wizardToggleOption"/, '选项点击未接 wizardToggleOption（变体 2 右栏入口）');
  assert.ok(!content.includes('interaction-search'), 'wizard 右栏不得有过滤输入框（C1 报告申报项 10）');
}, true);
check('⑥ 头部进度 chip 常显：wizard-progress-chip 已答 {{ answeredCount }}/{{ 总数 }} + answeredCount 判据', () => {
  assert.match(
    src,
    /<span v-if="isWizard" class="wizard-progress-chip" data-testid="wizard-progress-chip">已答 \{\{ answeredCount \}\}\/\{\{ wizardQuestions\.length \}\}<\/span>/,
    '缺头部进度 chip（常显 N/M）',
  );
  const body = src; // answeredCount 为表达式体 computed（非块状），直接全文件正则
  assert.match(body, /const answeredCount = computed\(\(\) => wizardQuestions\.value\.filter\(\(question\) => isQuestionAnswered\(questionAnswers\.value\[question\.id\]\)\)\.length\);/, 'answeredCount 判据不符（isQuestionAnswered 沿用）');
}, true);

group('=== 新钉：wizard footer 结构 / 下一题恒可点 / 未答齐提交早退序（⑦⑧⑨） ===');
check('⑦ wizard footer 结构：取消(丢弃门)→进度文本→上一题(仅第一题禁用)→下一题/提交；上一题 :disabled="wizardIndex === 0"', () => {
  const footer = wizardFooterBlock();
  assert.ok(footer.includes('class="interaction-dialog__footer interaction-dialog__footer--wizard"'), 'footer 缺 wizard 修饰类');
  const cancelTag = buttonOpenTag(footer, 'data-testid="wizard-cancel-btn"');
  assert.ok(cancelTag.includes('@click="requestDiscard"'), '取消钮须走丢弃保护门（契约 6：有作答二次确认）');
  assert.ok(cancelTag.includes('interaction-btn--ghost'), '取消钮须 ghost');
  const prevTag = buttonOpenTag(footer, 'data-testid="wizard-prev-btn"');
  assert.match(prevTag, /:disabled="wizardIndex === 0"/, '上一题仅第一题禁用（其余题可回退）');
  assert.ok(prevTag.includes('@click="previousQuestion"'), '上一题绑定 previousQuestion');
}, true);
check('⑧ 下一题恒可点：wizard-next-btn 无 :disabled（负向钉）+ data-dialog-initial-focus + wizardPrimaryLabel 三分支', () => {
  const footer = wizardFooterBlock();
  const nextTag = buttonOpenTag(footer, 'data-testid="wizard-next-btn"');
  assert.ok(!nextTag.includes(':disabled'), '下一题钮不得带 :disabled（恒可点=契约 2/4；非末题跳过语义前进、末题未答齐定位早退）');
  assert.ok(nextTag.includes('data-dialog-initial-focus'), '主按钮初始焦点锚保留（initial-focus 姊妹门锚面）');
  // R4-1 分流同步（round-004）：无条件 submitWizard 锚随分流形态最小同步——非末题 goNext（跳过
  // 语义）/末题 submitWizard；sidenav 5a/5e 同锚面。
  assert.match(nextTag, /@click="wizardIndex < wizardQuestions\.length - 1 \? goNext\(\) : submitWizard\(\)"/, '主按钮须分流：非末题 goNext（跳过语义）/末题 submitWizard（R4-1）');
  const label = computedBody('wizardPrimaryLabel');
  assert.ok(label.includes("if (wizardIndex.value < wizardQuestions.value.length - 1) return '下一题';"), '非末题「下一题」分支缺失');
  assert.match(label, /answeredCount\.value === wizardQuestions\.value\.length\s*\?\s*'提交'/, '末题答齐「提交」分支缺失');
  assert.match(label, /`提交（\$\{answeredCount\.value\}\/\$\{wizardQuestions\.value\.length\}）`/, '末题未答齐「提交（N/M）」分支缺失');
}, true);
check('⑨ 未答齐提交早退序：submitWizard findIndex(!isQuestionAnswered)→flagged+跳转+Other 收起→return；submittingId 赋值在早退之后', () => {
  const body = functionBody('submitWizard');
  const guardIdx = body.indexOf('if (!request || submittingId.value === request.id) return;');
  assert.ok(guardIdx > -1, '缺在飞守卫');
  const findIdx = body.indexOf('wizardQuestions.value.findIndex(');
  assert.ok(findIdx > guardIdx, '缺未答题定位 findIndex');
  assert.match(body, /findIndex\(\s*\(question\) => !isQuestionAnswered\(questionAnswers\.value\[question\.id\]\)/, 'findIndex 判据不符（首个未答题）');
  const earlyBlockStart = body.indexOf('if (firstUnanswered >= 0) {');
  assert.ok(earlyBlockStart > findIdx, '缺 firstUnanswered>=0 早退分支');
  const earlyBlock = body.slice(earlyBlockStart, body.indexOf('}', earlyBlockStart) + 1);
  assert.ok(earlyBlock.includes('wizardFlaggedIndex.value = firstUnanswered;'), '早退缺左栏警示描边（红色 flagged）');
  assert.ok(earlyBlock.includes('wizardIndex.value = firstUnanswered;'), '早退缺跳转定位');
  assert.ok(earlyBlock.includes('return;'), '早退缺 return');
  const submitIdx = body.indexOf('submittingId.value = request.id;');
  assert.ok(submitIdx > earlyBlockStart, 'submittingId 赋值必须位于早退之后（未答齐不置在飞）');
}, true);
check('⑨b 未答齐早退不置 submittingId（负向）：早退分支切片内零 submittingId 赋值', () => {
  const body = functionBody('submitWizard');
  const earlyStart = body.indexOf('if (firstUnanswered >= 0) {');
  const submitIdx = body.indexOf('submittingId.value = request.id;');
  assert.ok(earlyStart > -1 && submitIdx > earlyStart, '前置结构残缺');
  const earlySlice = body.slice(earlyStart, submitIdx);
  assert.ok(!earlySlice.includes('submittingId.value = request.id;'), '早退路径置了 submittingId（在飞守卫污染）');
  assert.ok(earlySlice.includes('return;'), '早退分支缺 return');
}, true);
check('⑨c 未答齐早退分支焦点环复位（round-006 M-R6-2）：早退分支切片含 focusedIndex.value = 0;', () => {
  const body = functionBody('submitWizard');
  const earlyStart = body.indexOf('if (firstUnanswered >= 0) {');
  assert.ok(earlyStart > -1, '缺未答齐早退分支');
  const earlyBlock = body.slice(earlyStart, body.indexOf('}', earlyStart) + 1);
  assert.ok(earlyBlock.includes('focusedIndex.value = 0;'), '未答齐早退分支缺 focusedIndex.value = 0;（焦点环复位第四路径，防残留 --focused 落在新题中间项，备忘(e)）');
}, true);

group('=== 新钉：draftCache 键控 / 丢弃保护 / 确认层（⑩⑪⑫） ===');
check('⑩ draftCache 按 request.id 键控存活：watch 源草稿字段 + displayedRequestId 键 + null 守卫 + initSelection 捕获刷新', () => {
  assert.match(src, /watch\(\s*\[selectedIds, otherText, wizardIndex, questionAnswers, fieldValues\] as const/, 'watch 源缺草稿字段（wizardIndex 题号暂存语义保留面）');
  assert.match(src, /draftCache\.set\(displayedRequestId,/, '缓存写入未用捕获期 id 作键（request.id 键控）');
  assert.match(src, /if \(!displayedRequestId\) return;/, '缺 null 守卫');
  const init = functionBody('initSelection');
  const setIdx = init.indexOf('displayedRequestId = request.id;');
  const getIdx = init.indexOf('draftCache.get(request.id)');
  assert.ok(setIdx > -1 && getIdx > setIdx, 'initSelection 须先刷新捕获期 id 再读缓存（hb13-v A8 保序）');
  assert.ok(init.includes('wizardIndex.value = cached.wizardIndex'), '缓存恢复须恢复题号（切走再切回停留原题号）');
});
check('⑪ 丢弃保护有作答门：requestDiscard 零作答直接 cancel；有作答置 discardCounts+确认层', () => {
  const body = functionBody('requestDiscard');
  assert.match(body, /if \(!hasAnyAnswer\.value\) \{\s*void cancel\(\);\s*return;\s*\}/, '缺零作答直通 cancel 门（hasAnyAnswer 判据）');
  assert.ok(body.includes('discardCounts.value = answeredCount.value;'), '缺已答数登记');
  assert.ok(body.includes('discardConfirmVisible.value = true;'), '缺确认层拉起');
}, true);
check('⑫ 确认层双钮：wizard-discard-confirm 浮层+「丢弃本次作答？」+discardCounts 正文+继续作答/丢弃双钮', () => {
  const block = discardConfirmBlock();
  assert.ok(block.includes('class="wizard-discard-confirm"'), '缺浮层容器');
  assert.ok(block.includes('<h3>丢弃本次作答？</h3>'), '缺确认文案（原型 .confirm 口径）');
  assert.match(block, /已作答的 \{\{ discardCounts \}\} 题内容将被丢弃/, '缺已答数正文');
  assert.match(block, /@click="dismissDiscard">继续作答</, '缺「继续作答」钮（dismissDiscard）');
  assert.match(block, /@click="confirmDiscard">丢弃</, '缺「丢弃」钮（confirmDiscard）');
  assert.ok(block.includes('role="alertdialog"'), '缺 alertdialog 角色（键盘可达语义）');
}, true);
check('⑫b Esc 分域序：wizard 分支 confirm 层 dismiss 先于输入焦点 blur 先于 requestDiscard（输入焦点判定先于丢弃链）', () => {
  const branch = wizardKeyBranch();
  const confirmIdx = branch.indexOf('discardConfirmVisible.value');
  const textEntryIdx = branch.indexOf('isTextEntryTarget(event.target)');
  const discardIdx = branch.indexOf('requestDiscard()');
  assert.ok(confirmIdx > -1 && textEntryIdx > -1 && discardIdx > -1, 'wizard Esc 分流三段残缺');
  assert.ok(confirmIdx < textEntryIdx && textEntryIdx < discardIdx, 'Esc 分域序违约（输入焦点判定须先于丢弃链）');
  assert.ok(branch.includes('dismissDiscard();'), '确认层在场须 dismiss（只关确认层不动草稿）');
  assert.ok(branch.includes('.blur();'), '输入焦点 Esc 须失焦（不关整单）');
  assert.ok(branch.includes('event.preventDefault();'), 'Esc 分支须 preventDefault');
}, true);

group('=== 保留面：isQuestionAnswered 判据 / 历史区（旧钉 6/7 存活） ===');
check('⑬ 旧钉 6 判据语义保留：isQuestionAnswered 双判据 selectedOptionIds?.length + otherText.trim', () => {
  const body = functionBody('isQuestionAnswered');
  assert.ok(body.includes('selectedOptionIds?.length'), '缺选项判据 selectedOptionIds?.length（多选空数组不算已答）');
  assert.ok(body.includes('otherText'), '缺 Other 文本判据');
  assert.ok(body.includes('trim()'), 'Other 判据须 trim（纯空白不算已答）');
});
check('⑭ 旧钉 7 保留：历史区 <details> v-if 恰为 history.length（confirm 不隐藏历史区）', () => {
  const detailsIdx = src.indexOf('<details');
  assert.ok(detailsIdx > -1, '缺历史区 <details');
  const tag = src.slice(detailsIdx, src.indexOf('>', detailsIdx));
  assert.ok(tag.includes('class="interaction-history"'), '首个 <details 非交互历史区（切片漂移）');
  const vif = tag.match(/v-if="([^"]*)"/);
  assert.ok(vif, '历史区缺 v-if');
  assert.equal(vif[1], 'history.length', '历史区 v-if 须恰为 history.length');
  assert.ok(!tag.includes("kind !== 'confirm'"), 'confirm 排除条件残留（I6 裁决：confirm 不隐藏历史区）');
});

group('=== 新钉：C3-4④ Other 保全（updateAnswer 单写入点/非出集路径零清空写点/出集清空新形态） ===');
check('⑮ Other 保全：updateAnswer 单写入点（定义+恰 3 调用）+账本合并形态', () => {
  const count = (src.match(/updateAnswer\(/g) ?? []).length;
  assert.equal(count, 4, `updateAnswer 出现 ${count} 处（定义 1+调用 3=多选 toggle/单选直答/Other 输入；账本写入点泄漏=保全违约）`);
  const body = functionBody('updateAnswer');
  assert.match(body, /questionAnswers\.value = \{ \.\.\.questionAnswers\.value, \[qid\]: \{ \.\.\.prev, \.\.\.patch \} \};/, '账本合并形态不符（单写入点）');
}, true);
check('⑮b 非出集路径 otherText 清空写点零出现：jumpToQuestion/previousQuestion/advanceToNextUnanswered 切片零 otherText；submitWizard 零 updateAnswer/零草稿清空', () => {
  for (const name of ['jumpToQuestion', 'previousQuestion', 'advanceToNextUnanswered']) {
    const body = functionBody(name);
    assert.ok(!body.includes('otherText'), `${name} 切片出现 otherText 写点（跳转/前进不得动 Other 草稿）`);
  }
  const wizard = functionBody('submitWizard');
  assert.ok(!wizard.includes('updateAnswer('), 'submitWizard 不得经 updateAnswer 改账本');
  assert.ok(!wizard.includes('otherText.value ='), 'submitWizard 不得清空 Other 草稿（载荷 otherText: undefined 字面除外）');
}, true);
check('⑯ 出集清空按新形态保留：单选改选 otherText: undefined + 多选移除 __other__ 清 Other + onWizardOtherInput 即时落账', () => {
  const body = functionBody('wizardToggleOption');
  assert.ok(body.includes('updateAnswer(qid, { selectedOptionIds: [optionId], otherText: undefined });'), '单选改选须清 Other 草稿（出集路径=申报保留语义）');
  assert.ok(body.includes('...(removing && optionId === OTHER_OPTION_ID ? { otherText: undefined } : {}),'), '多选移除 __other__ 须清 Other 草稿（其余选择保留）');
  const other = functionBody('onWizardOtherInput');
  assert.match(other, /updateAnswer\(question\.id, \{ selectedOptionIds: nextIds, otherText: text \|\| undefined \}\);/, 'Other 输入须即时落账（契约 5：翻页/跳转/切换不丢）');
}, true);
check('⑯b wizard Other 行内输入：ref=wizardOtherInput + @input=onWizardOtherInput + Enter.prevent=blur（确认该题=失焦，文本已落账）', () => {
  const content = divBlock('<div class="wizard-content"');
  assert.match(content, /ref="wizardOtherInput"/, '缺 Other 输入 ref');
  assert.match(content, /@input="onWizardOtherInput"/, '缺 @input 即时落账绑定');
  assert.match(content, /@keydown\.enter\.prevent="\(\$event\.target as HTMLInputElement\)\.blur\(\)"/, '缺 Enter=确认该题（blur）绑定——Other 内 Enter 不提交整单（契约 7）');
}, true);

group('=== 新钉：样式纪律（C1-13① 裸 hex 负向钉） ===');
check('⑰ 新增 wizard 样式块裸 hex 负向钉：向导样式规则切片内零裸 hex（R2-C P33 后原「#fff 申报先例」容许移除，success 实底前景亦 var(--color-on-success)），色值全 var()/color-mix', () => {
  const rules = [
    '.wizard-progress-chip {', '.interaction-dialog__body--wizard {', '.wizard-nav {', '.wizard-nav__item {',
    '.wizard-nav__item:hover {', '.wizard-nav__item .row1 {', '.wizard-nav__item .n {', '.wizard-nav__item .t {',
    '.wizard-nav__item .row2 {', '.wizard-nav__item.answered {', '.wizard-nav__item.answered .n {',
    '.wizard-nav__item.answered .row2 {', '.wizard-nav__item.current {', '.wizard-nav__item.current .n {',
    '.wizard-nav__item--flagged {', '.wizard-content {', '.wizard-qhead {', '.wizard-count {',
    '.wizard-qtag {', '.wizard-qtext {', '.wizard-qdesc {', '.wizard-skipnote {', '.wizard-foot-progress {',
    '.wizard-discard-confirm {', '.wizard-discard-confirm__box {', '.wizard-discard-confirm__box h3 {',
    '.wizard-discard-confirm__box p {', '.wizard-discard-confirm__row {',
  ];
  const slices = rules.map((rule) => styleRule(rule)); // 任一缺失即 assert 报错（旧实现无向导样式=必红）
  const joined = slices.join('\n');
  const hexes = joined.match(/#[0-9a-fA-F]{3,8}/g) ?? [];
  assert.deepEqual(hexes, [], `向导样式块残留裸 hex（须全 var()/color-mix；原申报先例 color: #fff 已随 R2-C P33 迁 var(--color-on-success)）：${hexes.join(' ')}`);
  // 关键三态色引用 token（C1-13① 色值全 var()/color-mix 的正面抽查）。
  assert.match(styleRule('.wizard-nav__item.answered .n {'), /var\(--color-success\)/, '已答编号圈未引用 success token');
  assert.match(styleRule('.wizard-nav__item.answered .n {'), /var\(--color-on-success\)/, '已答编号圈前景未引用 on-success token（R2-C P33 迁移后形态）');
  assert.match(styleRule('.wizard-nav__item.current .n {'), /var\(--color-accent\)/, '当前编号圈未引用 accent token');
  assert.match(styleRule('.wizard-nav__item--flagged {'), /var\(--color-danger\)/, '警示描边未引用 danger token');
}, true);

// ── 「对旧实现必红」自证（C3-2 期望条款；机制见头注/直接提交重写版头注）──
function loadOldSource(): string {
  const baselineRef = '3be0d7d'; // 04-实施计划 §0 批次基线（2026-11-15 实施期 HEAD=C1/C2 改动未提交）
  const r = spawnSync('git', ['show', `${baselineRef}:src/renderer/components/chat/InteractionPrompt.vue`], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `git show ${baselineRef} 旧源码失败：${r.stderr?.slice(0, 300)}`);
  const old = r.stdout;
  assert.ok(old.length > 1000, '旧源码快照异常（空/过短）');
  try {
    const scratchDirUrl = new URL('../.plan-loop/eight-issues-batch-1115-1714/scratch/', import.meta.url);
    mkdirSync(scratchDirUrl, { recursive: true });
    writeFileSync(new URL('c3-old-InteractionPrompt-wizard-step-jump.vue', scratchDirUrl), old, 'utf8');
  } catch { /* 留痕失败不阻断自证本体 */ }
  return old;
}

console.log('\n=== 「对旧实现必红」自证：重写面新钉 × 基线提交 3be0d7d 旧源码 ===');
const currentSrc = src;
const oldSrc = loadOldSource();
assert.notEqual(oldSrc, currentSrc, '旧源码快照与当前实现一致（基线提交取错或组件已回退）——必红自证失去意义，拒绝空转');
src = oldSrc;
let oldFail = 0;
let oldTotal = 0;
const oldPassed: string[] = [];
try {
  for (const item of checks) {
    if (!item.redOnOld) continue;
    oldTotal++;
    try { item.fn(); oldPassed.push(item.name); }
    catch { oldFail++; console.log(`  🔴 [旧实现必红] ${item.name} — FAIL（新结构在基线快照中不存在/形态不符）`); }
  }
} finally {
  src = currentSrc;
}
assert.ok(oldFail >= 1, `必红自证失败：${oldTotal} 条新钉在旧源码上全部 PASS（基线快照取错或新钉全部退化）`);
console.log(`  自证结论：${oldTotal} 条新钉对旧实现 ${oldFail} 条 FAIL${oldPassed.length ? `；意外 PASS ${oldPassed.length} 条（保留面重叠，可接受）：${oldPassed.join('；')}` : '（无意外 PASS）'}`);

console.log('\n=== 正式卷：对当前实现全绿 ===');
let lastGroup = '';
for (const item of checks) {
  if (item.group && item.group !== lastGroup) { console.log(`\n${item.group}`); lastGroup = item.group; }
  runCheck(item);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
