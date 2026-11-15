// tdd-wizard-step-jump-verify.ts
// C-W1（2026-11-05 计划 §3.2，P1）契约钉：向导题间自由跳转——步骤圆点按钮化 + jumpToQuestion
// 越界/原地守卫 + 末步提交完整性守卫 + draftCache 记录题号 + 圆点 button 重置样式。
//
// 根因（C-W1 CONFIRMED）：步骤圆点是纯展示 <span>（无 click、不可聚焦），既不能跳回已答题，
// 也不能提前查看未答题；「顺序作答保证全答完」的隐含前提被自由跳转打破后，末步还需要
// 提交完整性守卫（多选零选中/Other 空文本不放行空答案提交）。
//
// 修复语义（计划 §3.1-A1~A6/B1/C1）：
//  ① 圆点 span → <button type="button">，@click="jumpToQuestion(index)"，--done 改按
//     isQuestionAnswered(questionAnswers[question.id]) 点亮（位置序不再等于作答序）；
//  ② jumpToQuestion：越界（index<0 / >=wizardQuestions.value.length）与原地跳转 no-op，
//     跳走前 persistCurrentQuestionAnswer() 落账当前题；previousQuestion 委托之（函数名与
//     模板绑定原样保留——tdd-interaction-prompt-enter-guard.ts:127 正则契约）；
//  ③ submit() wizard 分支追加末步守卫：!allQuestionsAnswered 时跳到第一个未答题，不放行空答案；
//  ④ isQuestionAnswered：非空选项 或 非空 Other 文本（多选空数组不算已答）；
//  ⑤ draftCache 值类型/watch 源/写入对象/缓存恢复分支均含 wizardIndex（切走再切回停留原题号）；
//  ⑥ .interaction-step 补 button 重置（appearance/padding/background/cursor/font-family），
//     --active/--done 的 background 覆盖保持其后，视觉与 span 时代一致。
//
// 断言 1-6/8/9 属点 1（wizard 导航）；断言 7 原钉「confirm 隐藏历史区」（计划 §3.1-B2），已由
// slate-ui 回路点 I6 改钉（2026-11-10 编排器裁定：与 I6 裁决 §5-D7③ confirm 放开互斥）。
//
// 运行：npx tsx scripts/tdd-wizard-step-jump-verify.ts

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

/** 切片模板 interaction-steps 块（容器开标签起、至其配对闭合 </div>；起点须含 v-if/aria-label）。
 *  配对计数切片：自开标签起逐个前进扫描 <div / </div> token、深度计数（开标签自身计 1），
 *  深度归零处即容器真实闭合——容器内新增嵌套 div 不会让切片提前截断。 */
function stepsBlock(): string {
  const marker = '<div v-if="isWizard" class="interaction-steps"';
  const idx = src.indexOf(marker);
  assert.ok(idx > -1, '缺 interaction-steps 容器');
  let depth = 1; // 开标签自身
  let cursor = idx + marker.length;
  let end = -1;
  while (cursor < src.length) {
    const open = src.indexOf('<div', cursor);
    const close = src.indexOf('</div>', cursor);
    if (close === -1) break; // 无闭合——走下方 assert 响亮报错
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
  assert.ok(end > idx, 'interaction-steps 块切片失败（配对计数未归零）');
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

/** 切片 hb13-v A8 注释锚之后的草稿 watch(...) 整体（括号配对至其配对闭合）。
 *  回调体内无含括号 token 的字符串/注释，括号计数安全；写入对象断言限定在此切片内，
 *  排除全文件其他位置出现同名片段的误绿面。 */
function draftWatchBlock(): string {
  const anchor = '// hb13-v A8：写回自身 id';
  const anchorIdx = src.indexOf(anchor);
  assert.ok(anchorIdx > -1, '缺 hb13-v A8 草稿 watch 注释锚');
  const start = src.indexOf('watch(', anchorIdx);
  assert.ok(start > anchorIdx, '缺草稿 watch(');
  let depth = 0;
  let cursor = start;
  let end = -1;
  while (cursor < src.length) {
    const ch = src[cursor];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        end = cursor;
        break;
      }
    }
    cursor++;
  }
  assert.ok(end > start, '草稿 watch(...) 括号配对失败');
  return src.slice(start, end);
}

/** 切片 initSelection 函数体的缓存恢复分支：{ cached: if (cached) { … } 配对体,
 *  tail: 配对闭合之后剩余（非缓存分支） }。花括号深度计数；分支内注释/字符串无花括号 token。 */
function initSelectionBranches(): { cached: string; tail: string } {
  const body = functionBody('initSelection');
  const marker = 'if (cached) {';
  const ifIdx = body.indexOf(marker);
  assert.ok(ifIdx > -1, 'initSelection 缺 if (cached) 分支');
  let depth = 0;
  let cursor = ifIdx + marker.length - 1; // 指向分支开 {
  let end = -1;
  while (cursor < body.length) {
    const ch = body[cursor];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = cursor;
        break;
      }
    }
    cursor++;
  }
  assert.ok(end > ifIdx, 'initSelection if (cached) 花括号配对失败');
  return { cached: body.slice(ifIdx, end), tail: body.slice(end) };
}

console.log('\n=== C-W1（点 1）：向导题间自由跳转 ===');
check('1 步骤圆点为 <button> 且含 @click="jumpToQuestion(index)"（span 已废）', () => {
  const block = stepsBlock();
  assert.ok(block.includes('v-if="isWizard"'), '外层容器 v-if="isWizard" 须保留');
  assert.ok(block.includes('aria-label="问题进度"'), '外层容器 aria-label="问题进度" 须保留');
  assert.ok(block.includes('<button'), '步骤圆点应为 <button>');
  assert.ok(!block.includes('<span'), '步骤圆点不应再是 <span>');
  assert.ok(block.includes('type="button"'), '圆点 button 须带 type="button"（防表单内隐式 submit）');
  assert.ok(block.includes('@click="jumpToQuestion(index)"'), '圆点缺 @click="jumpToQuestion(index)"');
  assert.ok(block.includes(':title="`跳到第 ${index + 1} 题`"'), '圆点缺 title 提示');
  assert.ok(block.includes(':aria-label="`跳到第 ${index + 1} 题`"'), '圆点缺 aria-label（键盘可达）');
});
check('2 --done 类绑定改按 isQuestionAnswered(questionAnswers[question.id]) 点亮', () => {
  const block = stepsBlock();
  assert.match(
    block,
    /'interaction-step--done':\s*index !== wizardIndex && isQuestionAnswered\(questionAnswers\[question\.id\]\)/,
    '--done 须按「该题已有有效作答」点亮（index !== wizardIndex && isQuestionAnswered(...)）',
  );
  assert.ok(!block.includes("'interaction-step--done': index < wizardIndex"), '--done 旧「位置在前」语义须移除');
});
check('3 jumpToQuestion 存在越界/原地守卫（index<0 / >=length / ===wizardIndex）', () => {
  const body = functionBody('jumpToQuestion');
  assert.ok(body.includes('index < 0'), '缺下界守卫 index < 0');
  assert.ok(body.includes('index >= wizardQuestions.value.length'), '缺上界守卫 index >= wizardQuestions.value.length');
  assert.ok(body.includes('index === wizardIndex.value'), '缺原地跳转守卫 index === wizardIndex.value');
  assert.ok(body.includes('void persistCurrentQuestionAnswer()'), '跳走前须落账当前题（persist 语义）');
  assert.ok(body.includes('loadWizardStep(index)'), '须以 loadWizardStep(index) 切题');
});
check('4 previousQuestion 保留且委托 jumpToQuestion(wizardIndex.value - 1)（enter-guard 契约）', () => {
  const body = functionBody('previousQuestion');
  assert.ok(
    body.includes('jumpToQuestion(wizardIndex.value - 1)'),
    'previousQuestion 须委托 jumpToQuestion(wizardIndex.value - 1)',
  );
  assert.match(
    src,
    /<button v-if="isWizard && wizardIndex > 0"[^>]*@click="previousQuestion">/,
    '上一步按钮 @click="previousQuestion" 绑定须原样保留',
  );
});
check('5 submit wizard 分支含 !allQuestionsAnswered 末步守卫与 firstUnanswered findIndex', () => {
  const idx = src.indexOf('async function submit(optionId?: string)');
  assert.ok(idx > -1, '缺 submit');
  const body = src.slice(idx, src.indexOf('\n}', idx));
  const wizardIdx = body.indexOf('if (isWizard.value) {');
  assert.ok(wizardIdx > -1, 'submit 缺 wizard 分支');
  const wizardBlock = body.slice(wizardIdx);
  assert.ok(wizardBlock.includes('!allQuestionsAnswered.value'), '末步守卫缺 !allQuestionsAnswered.value');
  assert.match(
    wizardBlock,
    /firstUnanswered = wizardQuestions\.value\.findIndex\(\s*\(question\) => !isQuestionAnswered\(questionAnswers\.value\[question\.id\]\),?\s*\)/,
    '缺 firstUnanswered findIndex（!isQuestionAnswered 判据）',
  );
  assert.ok(
    wizardBlock.indexOf('!persistCurrentQuestionAnswer()') > -1 &&
      wizardBlock.indexOf('wizardIndex.value < wizardQuestions.value.length - 1') > -1 &&
      wizardBlock.indexOf('!allQuestionsAnswered.value') > -1,
    'wizard 分支四段结构（persist 失败/前进/末步守卫）不完整',
  );
  // 末步守卫须先于整体提交（submittingId 赋值）——否则守卫形同虚设。
  const guardIdx = wizardBlock.indexOf('!allQuestionsAnswered.value');
  const submittingIdx = body.indexOf('submittingId.value = request.id;');
  assert.ok(guardIdx > -1 && submittingIdx > -1 && wizardIdx + guardIdx < submittingIdx, '末步守卫必须先于 submittingId 赋值（提交路径）');
});
check('6 isQuestionAnswered 含 selectedOptionIds?.length 与 otherText 双判据', () => {
  const body = functionBody('isQuestionAnswered');
  assert.ok(body.includes('selectedOptionIds?.length'), '缺选项判据 selectedOptionIds?.length（多选空数组不算已答）');
  assert.ok(body.includes('otherText'), '缺 Other 文本判据');
  assert.ok(body.includes('trim()'), 'Other 判据须 trim（纯空白不算已答）');
});
check('7 历史区 <details> 的 v-if 恰为 history.length（I6：confirm 不再隐藏历史区）', () => {
  const detailsIdx = src.indexOf('<details');
  assert.ok(detailsIdx > -1, '缺历史区 <details');
  const tag = src.slice(detailsIdx, src.indexOf('>', detailsIdx));
  assert.ok(tag.includes('class="interaction-history"'), '首个 <details 非交互历史区（切片漂移）');
  const vif = tag.match(/v-if="([^"]*)"/);
  assert.ok(vif, '历史区缺 v-if');
  assert.equal(vif[1], 'history.length', '历史区 v-if 须恰为 history.length（空守卫保留、confirm 排除条件移除后不得放宽）');
  assert.ok(!tag.includes("kind !== 'confirm'"), 'confirm 排除条件残留（I6 裁决 §5-D7③：confirm 型弹窗不再隐藏历史区）');
});
check('8 draftCache 类型与 watch 源/写入/恢复均含 wizardIndex', () => {
  assert.match(
    src,
    /const draftCache = new Map<string, \{ selectedIds: Set<string>; otherText: string; wizardIndex: number;/,
    'draftCache 值类型缺 wizardIndex: number',
  );
  assert.match(
    src,
    /watch\(\s*\[selectedIds, otherText, wizardIndex, questionAnswers, fieldValues\] as const,/,
    'watch 源数组缺 wizardIndex',
  );
  // 写入对象：限定在草稿 watch(...) 切片内（旧断言为全文件子串，watch 外同名片段会误绿）。
  const watchBlock = draftWatchBlock();
  assert.ok(
    watchBlock.includes('wizardIndex: wizardIndex.value'),
    'draftCache 写入对象缺 wizardIndex: wizardIndex.value（须落在草稿 watch 回调体内）',
  );
  // 恢复分支：限定在 initSelection 的 if (cached) 配对体内；非缓存分支仍须重置为 0。
  const { cached, tail } = initSelectionBranches();
  assert.ok(
    cached.includes('wizardIndex.value = cached.wizardIndex'),
    'initSelection 缓存恢复分支未恢复题号（wizardIndex.value = cached.wizardIndex 须落在 if (cached) 分支内）',
  );
  assert.ok(tail.includes('wizardIndex.value = 0'), 'initSelection 非缓存分支仍须 wizardIndex.value = 0 重置');
});
check('9 .interaction-step 样式含 button 重置（appearance/padding/background/cursor/font-family）', () => {
  const styleIdx = src.indexOf('.interaction-step {');
  assert.ok(styleIdx > -1, '缺 .interaction-step 样式规则');
  const styleBody = src.slice(styleIdx, src.indexOf('}', styleIdx));
  for (const need of ['appearance: none', 'padding: 0', 'background: transparent', 'cursor: pointer', 'font-family: inherit']) {
    assert.ok(styleBody.includes(need), `.interaction-step 缺重置样式 ${need}`);
  }
  // --active/--done 的 background 覆盖保持其后（C1：优先级不变）。
  const activeIdx = src.indexOf('.interaction-step--active');
  assert.ok(activeIdx > styleIdx, '--active/--done 规则须保持在 .interaction-step 之后（background 覆盖优先级）');
  const activeBody = src.slice(activeIdx, src.indexOf('}', activeIdx));
  assert.ok(activeBody.includes('background:'), '--active/--done 的 background 覆盖须保留');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
