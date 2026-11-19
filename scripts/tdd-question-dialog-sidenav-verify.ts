// scripts/tdd-question-dialog-sidenav-verify.ts
// C1【选择题弹窗左栏导航重构·变体 2】契约钉（用户 2026-11-15 拍板，基准
// =prototypes/question-dialog-variant-2-sidenav.html；行为契约=00-behavior-specs 域 C C1 十条）。
//
// 本脚本钉 02-impl-details-renderer §14「tdd-question-dialog-sidenav-verify」行钉点清单
// + 03b-test-cases §4 用例 C1-1（变体 2 分栏结构钉/persist-on-leave 负向钉零残留/单题形态
// 回归字面保留）与 C1-4（footer 结构钉：按钮顺序+全局惯例）。CDP 场景（W-question-*）
// 归 T1B 点，不在本脚本。
//
// 钉面（实现=src/renderer/components/chat/InteractionPrompt.vue 变体 2 重构版）：
//  ① 分栏结构：interaction-dialog__body--wizard 分栏容器；nav.wizard-nav（左栏，width 引用
//     --interaction-wizard-nav-w）+ wizard-nav__item v-for 全量渲染（编号圈 .n + 题干 .t +
//     状态行 .row2，@click="jumpToQuestion(index)" 直达）；.wizard-content 右栏单题内容
//     （count 行 + 题干 + InteractionOptionList 复用 + Other 行内输入 + skipnote）；
//  ② 宽面板类 interaction-dialog--wizard → width: var(--interaction-panel-width-wide)，无裸宽度；
//     头部 wizard-progress-chip「已答 N/M」常显（替代旧圆点行）；
//  ③ persist-on-leave 负向钉：persistCurrentQuestionAnswer / loadWizardStep / allQuestionsAnswered /
//     interaction-step(s) 圆点行旧符号全文件零残留；作答即时写入 questionAnswers 账本
//     （updateAnswer 单写入点 + advanceToNextUnanswered + wizardToggleOption）；
//  ④ 丢弃确认层：wizard-discard-confirm 结构（h3「丢弃本次作答？」+ p 含 discardCounts +
//     [继续作答 dismissDiscard][丢弃 confirmDiscard] 双钮）+ requestDiscard 有作答门（hasAnyAnswer）；
//  ⑤ footer 排布钉（C1-4）：wizard footer 恰四元素且 DOM 顺序=取消（ghost，@click="requestDiscard"）
//     最左 → wizard-foot-progress → 上一题（ghost，:disabled="wizardIndex === 0"）→ 下一题/提交
//     （primary，data-dialog-initial-focus）最右；主按钮无 :disabled="!canSubmit" 钉死（恒可点，
//     非末题点击=goNext 前进（跳过语义）；末题点击=submitWizard 跳转首个未答题+wizardFlaggedIndex
//     警示——R4-1 round-004 分流形态）；
//  ⑥ 单题（非 form）形态回归字面保留：旧 body（interaction-dialog__choices/搜索/表单/Other/
//     历史区/预览）与旧 footer（上一步 v-if/取消 @click="cancel"/showFooterPrimary 主按钮
//     :disabled="!canSubmit"）原字面；isQuestionAnswered 判据与草稿 watch 源逐字保留；
//  ⑦ 键盘分域结构：handleKeydown wizard 早退分支先于 isTextEntryTarget（Esc 分域=输入框 blur
//     不关单/确认层 dismiss/其余 requestDiscard）；Tab trap 先于 wizard 分流；B5 兜底仍存于
//     submit（非 wizard），wizard 无 Enter 兜底。
//
// 〔R4-1 跳过语义补钉（2026-11-18 round-004 修复轮）：footer 主按钮 @click 由无条件 submitWizard
//   改分流=非末题 goNext（跳过语义，不校验已答、不触发 flagged）/末题 submitWizard（未答齐定位
//   +左栏警示）——C1 契约 2「下一题恒可点（允许跳过未答题）」；⑤5a 主按钮锚字面随分流最小同步，
//   新增 5e 行为钉（分流+goNext 函数体+恒可点结构保持）。〕
// 〔r2-P3-1 补钉（2026-11-19 验收 r2）：removeRequest 当前单守卫——摘除非当前头请求（如后台会话
//   弹窗被主进程 cancel）不得触碰当前单瞬态面（丢弃确认层/警示描边/Other 展开态），store 摘除与
//   submittingId 复位先于守卫不动——00 契约 9「新请求不顶掉当前单」；新增 8c 结构钉（守卫字面+
//   位置序：submittingId 复位之后、initSelection 之前）。〕
//
// 「对旧实现必红」自证：实施前对重构前代码运行本脚本——①②③④⑤全部 FAIL（结构不存在、
// 旧符号残留）；⑥⑦部分 FAIL。留痕见 .plan-loop/eight-issues-batch-1115-1714/round-001/c1-impl-report.md。
//
// 运行：npx tsx scripts/tdd-question-dialog-sidenav-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

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

const src = readFileSync(new URL('../src/renderer/components/chat/InteractionPrompt.vue', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../src/renderer/assets/styles/interaction-tokens.css', import.meta.url), 'utf8');

/** 切片：marker 起点至配对闭合（div 深度计数），容器内嵌套 div 不截断。 */
function blockByDiv(marker: string): string {
  const idx = src.indexOf(marker);
  assert.ok(idx > -1, `缺 ${marker}`);
  let depth = 1; // 开标签自身
  let cursor = idx + marker.length;
  let end = -1;
  while (cursor < src.length) {
    const open = src.indexOf('<div', cursor);
    const close = src.indexOf('</div>', cursor);
    if (close === -1) break;
    if (open !== -1 && open < close) {
      depth++;
      cursor = open + '<div'.length;
    } else {
      depth--;
      cursor = close + '</div>'.length;
      if (depth === 0) {
        end = cursor;
        break;
      }
    }
  }
  assert.ok(end > idx, `${marker} 块切片失败（配对计数未归零）`);
  return src.slice(idx, end);
}

/** 切片：marker 起点至闭合标签（footer 等非 div 容器用精确闭合切片，div 配对计数会溢出）。 */
function blockByClosing(marker: string, closing: string): string {
  const idx = src.indexOf(marker);
  assert.ok(idx > -1, `缺 ${marker}`);
  const end = src.indexOf(closing, idx);
  assert.ok(end > idx, `${marker} 闭合切片失败`);
  return src.slice(idx, end);
}

function functionBody(name: string): string {
  const marker = `function ${name}(`;
  const idx = src.indexOf(marker);
  assert.ok(idx > -1, `缺 ${name}`);
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.ok(body.length > 0, `${name} 函数体切片失败`);
  return body;
}

function cssRule(selector: string): string {
  const idx = src.indexOf(selector);
  assert.ok(idx > -1, `缺样式 ${selector}`);
  return src.slice(idx, src.indexOf('}', idx));
}

console.log('\n=== ① 变体 2 分栏结构钉（C1-1 意图 1） ===');
check('1a wizard 态分栏容器 interaction-dialog__body--wizard 存在且为 wizard 专属分支', () => {
  const block = blockByDiv('<div v-if="isWizard" class="interaction-dialog__body--wizard">');
  assert.ok(block.length > 0, '分栏容器切片失败');
  assert.ok(!block.includes('interaction-dialog__choices'), 'wizard 分栏不得复用旧单题 body 容器');
});
check('1b 左栏 nav.wizard-nav + data-testid="wizard-nav" + 宽度引用 --interaction-wizard-nav-w', () => {
  assert.ok(src.includes('<nav class="wizard-nav" data-testid="wizard-nav"'), '缺左栏 nav.wizard-nav 或 testid');
  assert.ok(src.includes('width: var(--interaction-wizard-nav-w);'), '左栏宽度未引用 token（须 var(--interaction-wizard-nav-w)）');
});
check('1c wizard-nav__item v-for 全量渲染 + type="button" + @click="jumpToQuestion(index)" + testid', () => {
  const nav = blockByDiv('<div v-if="isWizard" class="interaction-dialog__body--wizard">');
  assert.match(
    nav,
    /<button\s+v-for="\(question, index\) in wizardQuestions"\s+:key="question\.id"\s+type="button"\s+class="wizard-nav__item"/,
    '左栏项须 v-for="(question, index) in wizardQuestions" 全量渲染（button + type="button" + class="wizard-nav__item"）',
  );
  assert.ok(nav.includes('data-testid="wizard-nav-item"'), '左栏项缺 data-testid="wizard-nav-item"');
  assert.ok(nav.includes('@click="jumpToQuestion(index)"'), '左栏项缺 @click="jumpToQuestion(index)" 直达');
});
check('1d 左栏项三态类绑定：answered/current/flagged 由账本+wizardIndex+wizardFlaggedIndex 派生', () => {
  const nav = blockByDiv('<div v-if="isWizard" class="interaction-dialog__body--wizard">');
  assert.match(nav, /answered: isQuestionAnswered\(questionAnswers\[question\.id\]\)/, '缺 answered 态绑定（按账本判据）');
  assert.match(nav, /current: wizardIndex === index/, '缺 current 态绑定（wizardIndex 直接绑定，无观测器）');
  assert.match(nav, /'wizard-nav__item--flagged': wizardFlaggedIndex === index/, '缺 flagged 警示态绑定');
});
check('1e 左栏项节点面：编号圈 .n（✓/序号）+ 题干 .t + 状态行 .row2（未答=「未作答」）', () => {
  const nav = blockByDiv('<div v-if="isWizard" class="interaction-dialog__body--wizard">');
  assert.match(nav, /<span class="row1">/, '缺 row1 行');
  assert.match(nav, /class="n">\{\{ isQuestionAnswered\(questionAnswers\[question\.id\]\) \? '✓' : index \+ 1 \}\}</, '编号圈 .n 缺 ✓/序号三态渲染');
  assert.match(nav, /class="t">\{\{ question\.title \}\}</, '缺题干 .t');
  assert.match(nav, /<span class="row2">\{\{ wizardNavSummary\(question\) \}\}</, '缺状态行 .row2');
  const summary = functionBody('wizardNavSummary');
  assert.ok(summary.includes("'未作答'"), '状态行摘要缺「未作答」未答分支');
});
check('1f 右栏 .wizard-content + testid：count 行（第 N 题/共 M 题）+ 题干 + skipnote', () => {
  assert.ok(src.includes('<div class="wizard-content" data-testid="wizard-content">'), '缺右栏 .wizard-content');
  const content = blockByDiv('<div v-if="isWizard" class="interaction-dialog__body--wizard">');
  assert.match(content, /第 \{\{ wizardIndex \+ 1 \}\} 题 \/ 共 \{\{ wizardQuestions\.length \}\} 题/, '缺 count 行「第 N 题 / 共 M 题」');
  assert.ok(content.includes('class="wizard-qtext"'), '缺题干 wizard-qtext');
  assert.match(content, /可跳过本题稍后再答；提交前需答完全部 \{\{ wizardQuestions\.length \}\} 题。/, '缺 skipnote（对齐原型）');
});
check('1g 右栏复用 InteractionOptionList：selected-ids 接账本派生、@toggle 接 wizardToggleOption、不接 @submit', () => {
  const content = blockByDiv('<div v-if="isWizard" class="interaction-dialog__body--wizard">');
  assert.match(content, /<InteractionOptionList/, '右栏未复用 InteractionOptionList');
  assert.match(content, /:selected-ids="wizardSelectedIds"/, '选中集须来自账本派生 wizardSelectedIds');
  assert.ok(content.includes('@toggle="wizardToggleOption"'), '右栏 @toggle 须接 wizardToggleOption');
  const wizardBlockEnd = src.indexOf('</div>', src.indexOf('<div class="wizard-content" data-testid="wizard-content">'));
  const wizardSeg = src.slice(src.indexOf('<div v-if="isWizard" class="interaction-dialog__body--wizard">'), wizardBlockEnd);
  assert.ok(!/@submit="submit"/.test(wizardSeg.split('interaction-dialog__choices')[0] ?? wizardSeg), '右栏不得直连旧 submit 提交链');
});
check('1h Other 行内输入即时暂存：@input 接 onWizardOtherInput、Enter 仅 blur 无提交副作用', () => {
  const content = blockByDiv('<div v-if="isWizard" class="interaction-dialog__body--wizard">');
  assert.ok(content.includes('@input="onWizardOtherInput"'), 'Other 输入缺 @input 即时暂存绑定');
  assert.ok(content.includes('@keydown.enter.prevent="($event.target as HTMLInputElement).blur()"'), 'Other Enter 须仅 blur（契约 7）');
  assert.ok(!content.includes('@keydown.esc.prevent="cancel'), 'wizard Other 不得绑定 esc→cancel（契约 6：输入框内 Esc 仅失焦）');
});

console.log('\n=== ② 宽面板 + 头部进度 chip ===');
check('2a 宽面板类 interaction-dialog--wizard 绑定且 width 引用 --interaction-panel-width-wide（无裸宽度）', () => {
  assert.ok(src.includes("'interaction-dialog--wizard': isWizard"), '缺 interaction-dialog--wizard 类绑定');
  const rule = cssRule('.interaction-dialog--wizard {');
  assert.match(rule, /width: var\(--interaction-panel-width-wide\);/, '宽面板须引用 --interaction-panel-width-wide token');
  assert.ok(!/width:\s*\d+(\.\d+)?(rem|px)/.test(rule), '宽面板规则内出现裸宽度');
});
check('2b 头部进度 chip：wizard-progress-chip + testid +「已答 N/M」answeredCount 常显', () => {
  assert.ok(
    src.includes('<span v-if="isWizard" class="wizard-progress-chip" data-testid="wizard-progress-chip">已答 {{ answeredCount }}/{{ wizardQuestions.length }}</span>'),
    '缺头部进度 chip（v-if="isWizard" + class/testid + 已答 N/M）',
  );
  assert.ok(src.includes('.wizard-progress-chip {'), '缺 chip 样式');
  assert.ok(!src.includes('<div v-if="isWizard" class="interaction-steps"'), '旧圆点行模板须已移除');
});

console.log('\n=== ③ persist-on-leave 负向钉零残留（C1-1 意图 2） ===');
check('3a 旧符号零残留：persistCurrentQuestionAnswer / loadWizardStep / allQuestionsAnswered', () => {
  assert.ok(!src.includes('persistCurrentQuestionAnswer'), 'persistCurrentQuestionAnswer 残留（persist-on-leave 未除）');
  assert.ok(!src.includes('loadWizardStep'), 'loadWizardStep 残留');
  assert.ok(!src.includes('allQuestionsAnswered'), 'allQuestionsAnswered 残留（须重写为 answeredCount）');
});
check('3b 旧圆点行零残留：interaction-step 模板与样式（含 interaction-steps）', () => {
  assert.ok(!src.includes('interaction-step'), 'interaction-step(s) 残留（模板或样式）');
});
check('3c 草稿账本即时写入面：updateAnswer 单写入点 + advanceToNextUnanswered + wizardToggleOption 在位', () => {
  const update = functionBody('updateAnswer');
  assert.match(update, /questionAnswers\.value = \{ \.\.\.questionAnswers\.value, \[qid\]: \{ \.\.\.prev, \.\.\.patch \} \};/, 'updateAnswer 须整体替换式写入账本');
  const advance = functionBody('advanceToNextUnanswered');
  assert.match(advance, /index > wizardIndex\.value && !isQuestionAnswered\(questionAnswers\.value\[question\.id\]\)/, '自动前进须找当前题之后的首个未答题');
  const toggle = functionBody('wizardToggleOption');
  assert.ok(toggle.includes('question.multiSelect'), 'wizardToggleOption 缺多选分支');
  assert.ok(toggle.includes('Date.now() - lastDirectSubmitAt < 300'), '单选分支缺 300ms 短窗守卫（防自动前进后双击二次作答）');
  assert.ok(toggle.indexOf('question.multiSelect') < toggle.indexOf('Date.now() - lastDirectSubmitAt'), '多选分支须在守卫之前 return（不受守卫）');
  assert.ok(functionBody('jumpToQuestion').includes('wizardIndex.value = index;'), 'jumpToQuestion 须直接切 wizardIndex');
  assert.ok(!functionBody('jumpToQuestion').includes('persistCurrentQuestionAnswer'), 'jumpToQuestion 不得残留 persist 调用');
});

console.log('\n=== ④ 丢弃确认层结构钉（契约 6） ===');
check('4a wizard-discard-confirm 层：v-if=discardConfirmVisible + testid + 遮罩点击 dismiss', () => {
  assert.ok(
    src.includes('<div v-if="discardConfirmVisible" class="wizard-discard-confirm" data-testid="wizard-discard-confirm"'),
    '缺丢弃确认层（v-if="discardConfirmVisible" + class/testid）',
  );
  assert.ok(src.includes('@click.self="dismissDiscard"'), '确认层遮罩点击须=继续作答（dismiss）');
});
check('4b 确认层文案：h3「丢弃本次作答？」+ p 含 discardCounts 与「模型不会收到任何回答」', () => {
  const layer = blockByDiv('<div v-if="discardConfirmVisible"');
  assert.ok(layer.includes('<h3>丢弃本次作答？</h3>'), '缺 h3「丢弃本次作答？」（02 §3.2 文案，沿用原型须申报）');
  assert.match(layer, /已作答的 \{\{ discardCounts \}\} 题内容将被丢弃，模型不会收到任何回答。/, '缺正文（含已答数 N + 模型不收回答）');
});
check('4c 确认层双钮：[继续作答 dismissDiscard][丢弃 confirmDiscard→cancel 链]', () => {
  const layer = blockByDiv('<div v-if="discardConfirmVisible"');
  assert.ok(layer.includes('@click="dismissDiscard">继续作答</button>'), '缺「继续作答」钮（dismissDiscard）');
  assert.ok(layer.includes('@click="confirmDiscard">丢弃</button>'), '缺「丢弃」钮（confirmDiscard）');
  const discard = functionBody('confirmDiscard');
  assert.ok(discard.includes('void cancel()'), 'confirmDiscard 须走既有 cancel 链');
  const request = functionBody('requestDiscard');
  assert.ok(request.includes('!hasAnyAnswer.value'), 'requestDiscard 缺零作答直通门（无作答直接关闭）');
  assert.ok(request.includes('void cancel()'), '零作答分支须直接 cancel');
});

console.log('\n=== ⑤ footer 排布钉（C1-4：取消最左，不夹导航中间） ===');
check('5a wizard footer 恰四元素且 DOM 顺序=取消→进度文本→上一题→主按钮', () => {
  const footer = blockByClosing('<footer v-if="isWizard" class="interaction-dialog__footer interaction-dialog__footer--wizard">', '</footer>');
  const cancelIdx = footer.indexOf('@click="requestDiscard"');
  const progressIdx = footer.indexOf('class="wizard-foot-progress"');
  const prevIdx = footer.indexOf('@click="previousQuestion"');
  // R4-1 分流同步（round-004）：主按钮锚字面由无条件 submitWizard 随分流形态最小同步
  //（非末题 goNext / 末题 submitWizard），排布语义（primary 最右）不变。
  const primaryIdx = footer.indexOf('@click="wizardIndex < wizardQuestions.length - 1 ? goNext() : submitWizard()"');
  assert.ok(cancelIdx > -1 && progressIdx > -1 && prevIdx > -1 && primaryIdx > -1, 'wizard footer 四元素缺失');
  assert.ok(cancelIdx < progressIdx && progressIdx < prevIdx && prevIdx < primaryIdx, 'footer DOM 顺序须=取消→进度→上一题→下一题/提交');
  assert.match(footer, /<button type="button" class="interaction-btn interaction-btn--ghost" data-testid="wizard-cancel-btn" @click="requestDiscard">/, '取消须为 ghost 且最左（requestDiscard 保护链）');
  assert.match(footer, /class="interaction-btn interaction-btn--primary" data-testid="wizard-next-btn" data-dialog-initial-focus @click="wizardIndex < wizardQuestions\.length - 1 \? goNext\(\) : submitWizard\(\)"/, '主按钮须 primary + data-dialog-initial-focus + 分流（非末题 goNext/末题 submitWizard）');
});
check('5b 取消不夹导航中间：旧 footer（单题形态）取消位置字面保留 + wizard footer 取消为首按钮', () => {
  const oldFooter = blockByClosing('<footer v-else class="interaction-dialog__footer">', '</footer>');
  const firstBtn = oldFooter.indexOf('<button');
  assert.ok(firstBtn > -1, '旧 footer 缺按钮');
  assert.ok(oldFooter.includes('@click="cancel"'), '旧 footer 缺取消钮');
  const wizardFooter = blockByClosing('<footer v-if="isWizard" class="interaction-dialog__footer interaction-dialog__footer--wizard">', '</footer>');
  const firstWizardBtn = wizardFooter.slice(wizardFooter.indexOf('<button'));
  assert.ok(firstWizardBtn.includes('@click="requestDiscard"'), 'wizard footer 首按钮须为取消（取消最左）');
  assert.ok(!firstWizardBtn.slice(0, firstWizardBtn.indexOf('@click="requestDiscard"')).includes('上一题'), '「上一题」不得位于取消之前（取消不夹导航中间钉）');
});
check('5c 主按钮恒可点（无 canSubmit 钉死）+ 上一题仅第一题禁用', () => {
  const footer = blockByClosing('<footer v-if="isWizard" class="interaction-dialog__footer interaction-dialog__footer--wizard">', '</footer>');
  assert.ok(!footer.includes(':disabled="!canSubmit"'), 'wizard 主按钮不得被 canSubmit 钉死（恒可点，未答齐点击=跳转）');
  assert.match(footer, /:disabled="wizardIndex === 0"/, '上一题须 :disabled="wizardIndex === 0"（仅第一题禁用）');
  const label = src.indexOf('wizardPrimaryLabel');
  assert.ok(label > -1, '缺 wizardPrimaryLabel computed');
  const labelBody = src.slice(src.indexOf('const wizardPrimaryLabel'), src.indexOf('};', src.indexOf('const wizardPrimaryLabel')));
  assert.ok(labelBody.includes("'下一题'"), '非最后题主按钮 label=「下一题」');
  assert.ok(labelBody.includes("'提交'"), '最后题主按钮 label=「提交」');
  assert.ok(labelBody.includes('提交（'), '未答齐 label=「提交（N/M）」');
});
check('5d submitWizard：未答齐=findIndex→flagged+跳转早退（不置 submittingId）；答齐=respondAndRemove 既有链', () => {
  const body = functionBody('submitWizard');
  const guardIdx = body.indexOf('submittingId.value = request.id;');
  const findIdx = body.indexOf('findIndex(');
  assert.ok(findIdx > -1 && findIdx < guardIdx, '未答齐校验须先于 submittingId 赋值（早退不置 submittingId）');
  assert.match(body, /!isQuestionAnswered\(questionAnswers\.value\[question\.id\]\)/, '完整性判据须 isQuestionAnswered（多选空数组=未答）');
  const flagIdx = body.indexOf('wizardFlaggedIndex.value = firstUnanswered;');
  const jumpIdx = body.indexOf('wizardIndex.value = firstUnanswered;');
  assert.ok(flagIdx > -1 && jumpIdx > flagIdx, '未答齐须 wizardFlaggedIndex 警示 + wizardIndex 跳转（跳转在警示后）');
  const earlyReturn = body.indexOf('return;', jumpIdx);
  assert.ok(earlyReturn > -1 && earlyReturn < guardIdx, '未答齐分支须早退（不得落提交路径）');
  assert.match(body, /selectedOptionIds: undefined/, 'wizard 提交 selectedOptionIds 恒空（逐题答案走 questionAnswers）');
  assert.match(body, /questionAnswers: JSON\.parse\(JSON\.stringify\(questionAnswers\.value\)\) as Record<string, QuestionAnswer>/, '提交载荷须深拷贝账本');
  assert.ok(body.includes('pushHistory(request, \'submit\', [])'), '提交须落交互历史');
  assert.ok(body.includes('advanceQueueUI()'), '提交成功须前进队列');
});
// R4-1（round-004 复审）跳过语义行为钉：C1 契约 2「下一题恒可点（允许跳过未答题）」——
// 非末题主按钮=goNext 前进（不校验已答、不触发 flagged）；末题主按钮=submitWizard（未答齐定位+警示）。
check('5e 主按钮 @click 分流：非末题=goNext（跳过语义不校验不动 flagged）/末题=submitWizard；「下一题」恒可点结构保持', () => {
  const footer = blockByClosing('<footer v-if="isWizard" class="interaction-dialog__footer interaction-dialog__footer--wizard">', '</footer>');
  const nbIdx = footer.indexOf('data-testid="wizard-next-btn"');
  const nextTag = footer.slice(footer.lastIndexOf('<button', nbIdx), footer.indexOf('>', nbIdx) + 1);
  assert.match(nextTag, /@click="wizardIndex < wizardQuestions\.length - 1 \? goNext\(\) : submitWizard\(\)"/, '主按钮 @click 须分流：非末题 goNext / 末题 submitWizard（R4-1）');
  assert.ok(!nextTag.includes(':disabled'), '「下一题」恒可点结构保持（主按钮无 :disabled）');
  const body = functionBody('goNext');
  assert.match(body, /if \(wizardIndex\.value >= wizardQuestions\.value\.length - 1\) return;/, 'goNext 缺末题守卫（末题交 submitWizard 分流）');
  assert.match(body, /wizardIndex\.value \+= 1;/, 'goNext 缺前进一格');
  assert.ok(body.includes('wizardOtherExpanded.value = false;'), 'goNext 须收起 Other 展开态');
  assert.ok(!body.includes('wizardFlaggedIndex'), 'goNext 不得触碰 wizardFlaggedIndex（跳过语义不触发校验、不清既有警示）');
  assert.ok(!body.includes('isQuestionAnswered'), 'goNext 不得校验已答（跳过语义：未答亦可前进）');
});

console.log('\n=== ⑥ 单题（非 form）形态回归字面保留（C1-1 意图 4 / C1-4 回归面） ===');
check('6a 旧 body 结构字面保留（choices/搜索/表单/Other/历史/预览/选项列表）', () => {
  const oldBody = blockByDiv('<div v-else class="interaction-dialog__body"');
  for (const need of [
    'class="interaction-dialog__choices"',
    'class="interaction-search"',
    'class="interaction-form"',
    'class="interaction-other"',
    'class="interaction-history"',
    '<InteractionOptionList',
    '<InteractionPreview',
  ]) {
    assert.ok(oldBody.includes(need), `旧 body 缺 ${need}（单题形态字面被触碰）`);
  }
  assert.ok(oldBody.includes('v-if="activeOptions.length > 8"'), '搜索框门控字面漂移');
});
check('6b 旧 footer 字面保留：上一步 v-if / 取消 @click="cancel" / showFooterPrimary 主按钮 / canSubmit 禁用', () => {
  const oldFooter = blockByDiv('<footer v-else class="interaction-dialog__footer">');
  assert.match(oldFooter, /<button v-if="isWizard && wizardIndex > 0" type="button" class="interaction-btn interaction-btn--ghost" @click="previousQuestion">上一步</, '旧 footer 上一步字面漂移');
  assert.ok(oldFooter.includes('<button type="button" class="interaction-btn interaction-btn--ghost" @click="cancel">'), '旧 footer 取消字面漂移');
  assert.ok(oldFooter.includes('v-if="showFooterPrimary"'), '旧 footer 主按钮门控漂移');
  assert.ok(oldFooter.includes(':disabled="!canSubmit"'), '旧 footer 主按钮禁用绑定漂移');
});
check('6c isQuestionAnswered 判据逐字保留 + 草稿 watch 源逐字保留（hb13-v 契约联动）', () => {
  const body = functionBody('isQuestionAnswered');
  assert.ok(body.includes('selectedOptionIds?.length'), '缺选项判据');
  assert.ok(body.includes('otherText'), '缺 Other 文本判据');
  assert.ok(body.includes('trim()'), 'Other 判据须 trim');
  assert.match(
    src,
    /watch\(\s*\[selectedIds, otherText, wizardIndex, questionAnswers, fieldValues\] as const,/,
    '草稿 watch 源字面漂移（hb13-v 钉①；本点保留 wizardIndex 于源中——缓存题号新鲜度+姊妹门字面）',
  );
});
check('6d 非 wizard 键盘分支字面保留：X1 让位 / alert confirm / Space toggle / B5 兜底存于 submit', () => {
  const body = functionBody('handleKeydown');
  assert.ok(body.includes("closest('button, summary')"), 'Enter X1 让位漂移');
  assert.ok(body.includes("!target.closest('.interaction-option')"), '选项排除漂移');
  assert.match(body, /const isAlert = activeRequest\.value\.kind === 'confirm'/, 'alert 判定漂移');
  assert.ok(body.includes("submit('confirm')"), 'alert Esc=提交 confirm 漂移');
  const submitBody = src.slice(src.indexOf('async function submit(optionId?: string)'), src.indexOf('async function submit(optionId?: string)') + 2200);
  assert.match(submitBody, /ids = \[focusedOption\.value\.id\];\s*selectedIds\.value = new Set\(ids\);/, 'B5 兜底（非 wizard）漂移');
});

console.log('\n=== ⑦ 键盘分域结构（契约 6/7/8 结构面） ===');
check('7a handleKeydown wizard 早退分支先于（非 wizard 路径的）isTextEntryTarget 首行守卫', () => {
  const body = functionBody('handleKeydown');
  const wizardIdx = body.indexOf('if (isWizard.value) {');
  assert.ok(wizardIdx > -1, '缺 wizard 早退分支');
  // governing 守卫 = wizard 分流之后的首个 textEntry 早退（Tab 分支内的等价早退不算——
  // 其语义是「文本输入内 Tab 走浏览器默认」，非分域 governing 守卫）。
  const textIdx = body.indexOf('if (isTextEntryTarget(event.target)) return;', wizardIdx);
  assert.ok(textIdx > wizardIdx, 'wizard 分流后缺 isTextEntryTarget 首行守卫（非 wizard 路径零变化前提）');
});
check('7b wizard Esc 分域：确认层在场=dismiss；输入框内=blur 不关单；其余=requestDiscard', () => {
  const body = functionBody('handleKeydown');
  const wizardIdx = body.indexOf('if (isWizard.value) {');
  const wizardBlock = body.slice(wizardIdx);
  assert.match(wizardBlock, /event\.key === 'Escape' && \(!escHandle \|\| escHandle\.isTopmost\(\)\)/, 'wizard Esc 缺栈顶让位守卫');
  const pdIdx = wizardBlock.indexOf('event.preventDefault()');
  const guardIdx = wizardBlock.indexOf('isTopmost()');
  assert.ok(guardIdx > -1 && pdIdx > guardIdx, '让位守卫须先于 preventDefault（A9 语义）');
  const confirmIdx = wizardBlock.indexOf('if (discardConfirmVisible.value)');
  const blurIdx = wizardBlock.indexOf('.blur()');
  const discardIdx = wizardBlock.indexOf('requestDiscard()');
  assert.ok(confirmIdx > -1 && blurIdx > -1 && discardIdx > -1, 'Esc 三分域缺失（确认层/输入框/丢弃保护）');
  assert.ok(blurIdx > confirmIdx, '输入框 blur 分域须在确认层分域之后');
  assert.ok(discardIdx > blurIdx, '丢弃保护分域须在输入框 blur 之后');
});
check('7c wizard 分流吞掉箭头/Enter/Space（无 B5 兜底、不 move 不改选中），Tab trap 保留在分流外', () => {
  const body = functionBody('handleKeydown');
  const wizardIdx = body.indexOf('if (isWizard.value) {');
  // wizard 分支体=分流起点至其后 governing textEntry 早退行止（分流整体 return，其后即非 wizard 路径）。
  const textIdx = body.indexOf('if (isTextEntryTarget(event.target)) return;', wizardIdx);
  assert.ok(textIdx > wizardIdx, 'wizard 分流后缺 governing textEntry 早退');
  const wizardBlock = body.slice(wizardIdx, textIdx);
  assert.ok(!wizardBlock.includes('move(1)') && !wizardBlock.includes('move(-1)'), 'wizard 分流内不得 move（箭头键交还原生滚动）');
  assert.ok(!wizardBlock.includes('toggleOption('), 'wizard 分流内不得 toggleOption（Space 交还原生激活）');
  assert.ok(!wizardBlock.includes('void submit()'), 'wizard 分流内不得 submit（无 Enter 兜底，契约 7）');
  const tabIdx = body.indexOf("if (event.key === 'Tab')");
  assert.ok(tabIdx > -1 && tabIdx < wizardIdx, 'Tab trap 须在 wizard 分流之前执行（分支外先执行）');
  assert.ok(body.slice(tabIdx, wizardIdx).includes('isTextEntryTarget(event.target)'), 'Tab 分支须保留文本输入内浏览器默认（旧首行早退行为不变）');
});

console.log('\n=== ⑧ token 钉（interaction-tokens.css） ===');
check('8a --interaction-wizard-nav-w: 13rem 定义于 interaction-tokens.css', () => {
  assert.match(tokens, /--interaction-wizard-nav-w:\s*13rem;/, 'tokens 缺 --interaction-wizard-nav-w: 13rem');
});
check('8b 组件引用面：wizard-nav 宽度引用该 token（其余复用既有 token）', () => {
  assert.ok(src.includes('width: var(--interaction-wizard-nav-w);'), '组件未引用 --interaction-wizard-nav-w');
});
// r2-P3-1（2026-11-19 验收 r2）结构钉：removeRequest 摘除非当前头请求须早退（00 契约 9）——
// store 摘除与 submittingId 复位先于守卫不动；守卫置 submittingId 复位之后、initSelection 之前。
check('8c r2-P3-1 摘除非当前头请求早退守卫：removeRequest 体含 activeRequest id 守卫（submittingId 复位后、initSelection 前，00 契约 9）', () => {
  const body = functionBody('removeRequest');
  const guardIdx = body.indexOf('if (id !== activeRequest.value?.id) return;');
  assert.ok(guardIdx > -1, 'removeRequest 缺早退守卫字面（非当前头请求摘除不得触碰当前单瞬态面，00 契约 9）');
  const submittingIdx = body.indexOf('submittingId.value = null;');
  assert.ok(submittingIdx > -1 && guardIdx > submittingIdx, '守卫须置于 submittingId 复位之后');
  const nextIdx = body.indexOf('const next = currentRequests.value[0]');
  assert.ok(nextIdx > -1 && guardIdx < nextIdx, '守卫须置于 initSelection（取 next）之前');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
