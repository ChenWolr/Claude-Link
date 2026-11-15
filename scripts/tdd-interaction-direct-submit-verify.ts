// tdd-interaction-direct-submit-verify.ts
// UI13 批次 P6「交互弹窗选项直选直提」（2026-11-14 计划，用例正本 03-test-cases.md §P6；
// 实现权威 01-impl-details.md §P6；裁决 R2/R3 与 T6-B 的 01 语义修正按 04-实施计划.md §3 应用）。
//
// 行为契约（00-behavior-specs §P6 八条）：单选题单击普通选项=选中并立即提交（弹窗关闭）；
// Other 单击仅展开输入（Enter/footer「确认」提交）；多选维持 toggle+footer「提交选择」；
// 向导单选题单击=作答并自动前进、末题单击=整体提交关闭、multiSelect 题不自动前进
//（footer「下一题/末题确认」）；「上一步」「取消」「步骤圆点跳转」保留；Enter/Esc 全键盘
// 路径不变；提交载荷形态不变（主进程零改动）；自动前进前答案落草稿；permission/confirm/
// text/long-text/form(fields) 五形态 UI 不变。
//
// 裁决应用：
//  R2——直提范围排除 permission/confirm（契约 #8 权限弹窗「拒绝+所选 label 主按钮」形态保留）；
//  R3——不钉「@dblclick 字面删除」，钉行为「单选直提后双击不产生二次提交」（submittingId
//       在飞守卫 + 300ms 短窗守卫；修正原表述：dblclick 经队列下一请求/向导题间复用 DOM 可达，
//       「弹窗已关使链不可达」假设不成立——守卫已上移 submit(optionId)，toggleOption 内保留双保险）；
//  T6-B 01 语义修正——单选形态主按钮门控为「未激活 Other 时缺席、Other 激活时有『确认』」
//      （showFooterPrimary），不按 03 字面「单选形态无主按钮」绝对化。
//  边缘守卫补丁（编排裁定回执）——直提 300ms 短窗守卫（lastDirectSubmitAt）：submittingId
//      仅覆盖 IPC 在飞窗口，双击第二击/换请求换单的第二击可能落在守卫清零后；守卫置于
//      updateSelected 之前防第二击污染新请求/新题选中态。属实现标准「边界处理」项，
//      03 用例未显式覆盖（T6-N 只钉 submittingId 在飞守卫），锚定于 T6-A 两条 check。
//
// P1-A 补钉（评审缺陷：dblclick 绕过 300ms 直提守卫——幽灵作答/幽灵提交）：toggleOption 内
//      守卫只挡 toggle 路径；submit(optionId) 在 toggleOption 被吞后仍按 optionId 直构 ids 走
//      全链（多题向导题切换/队列下一请求复用同 key DOM 时第二击可达）——守卫上移 submit：
//      direct 形态整体早退位于在飞早退之后、toggleOption(optionId) 之前；toggleOption 内守卫
//      保留（双保险）；focusOption(optionIndex) 随之移到守卫之后（P3-1：被吞第二击不得污染
//      聚焦态；鼠标路径聚焦已由 InteractionOptionList @mouseenter 驱动，键盘路径经 move()）。
//
// 用例映射（T6-A~O）：T6-A 单选直提（含 R2 排除链/R3 行为钉）；T6-B footer 主按钮门控+
// submitLabel；T6-C Other 展开不提交；T6-D Other 激活点普通选项直提；T6-E 多选 toggle+footer；
// T6-F 向导自动前进；T6-G 末题整体提交；T6-H multiSelect 不前进+「下一题」专属；T6-I 上一步/
// 取消/圆点保留（spawn enter-guard）；T6-J Enter/Esc 不变（spawn esc-stack/initial-focus/
// hb13-v-perm-draft）；T6-K 载荷结构+主进程零波及；T6-L 自动前进前落草稿；T6-M 五形态 UI；
// T6-N 提交在飞防重；T6-O alert 边界。
//
// RED 期望桶（对未实现工作树）：T6-A/B/F/G/H 必红（派发要求最低集）；T6-C/D 因用例语义
// 含直选断言（Other 排除条件/置换后直提）同根因先红；T6-E/I/J/K/L/M/N/O 为回归钉现状即绿。
//
// 运行：npx tsx scripts/tdd-interaction-direct-submit-verify.ts（登记 scripts/selftest-static-list.txt）

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const src = readFileSync(new URL('../src/renderer/components/chat/InteractionPrompt.vue', import.meta.url), 'utf8');
const optionListSrc = readFileSync(new URL('../src/renderer/components/chat/InteractionOptionList.vue', import.meta.url), 'utf8');
const sdkInteractionsSrc = readFileSync(new URL('../src/main/modules/sdk-interactions.ts', import.meta.url), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

/** 切片函数体：自 `function <name>(` 起、至首个 `\n}`（顶层闭合）。 */
function functionBody(name: string): string {
  const marker = `function ${name}(`;
  const idx = src.indexOf(marker);
  assert.ok(idx > -1, `缺 ${name}`);
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.ok(body.length > 0, `${name} 函数体切片失败`);
  return body;
}

function submitBody(): string {
  const idx = src.indexOf('async function submit(optionId?: string)');
  assert.ok(idx > -1, '缺 submit（签名被改？enter-guard 以该切片钉死）');
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.ok(body.length > 0, 'submit 函数体切片失败');
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

/** 切片 toggleOption 内 multiSelect 分支（if (currentMultiSelect.value) { … } 花括号配对体）。 */
function toggleMultiBlock(): string {
  const body = functionBody('toggleOption');
  const marker = 'if (currentMultiSelect.value) {';
  const start = body.indexOf(marker);
  assert.ok(start > -1, 'toggleOption 缺 multiSelect 分支');
  let depth = 0;
  let cursor = start + marker.length - 1;
  while (cursor < body.length) {
    const ch = body[cursor];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return body.slice(start, cursor + 1);
    }
    cursor++;
  }
  assert.ok(false, 'multiSelect 分支花括号配对失败');
}

function footerBlock(): string {
  const marker = '<footer class="interaction-dialog__footer">';
  const idx = src.indexOf(marker);
  assert.ok(idx > -1, '缺 footer');
  const end = src.indexOf('</footer>', idx);
  assert.ok(end > idx, 'footer 闭合切片失败');
  return src.slice(idx, end);
}

function spawnAssert(script: string): void {
  const r = spawnSync('npx', ['tsx', script], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-6).join('\n');
  assert.equal(r.status, 0, `${script} 退出码 ${r.status}（连带契约被波及）\n${tail}`);
}

console.log('\n=== UI13-P6 T6-A 单选直提（含 R2 排除链 / R3 双击行为钉） ===');
check('T6-A isDirectSubmitChoice 判定：非 multi/form/text/permission/confirm；向导单选或 single-choice', () => {
  const body = functionBody('isDirectSubmitChoice');
  assert.ok(body.includes('currentMultiSelect.value'), '缺 multiSelect 排除（多选不得直提）');
  assert.ok(body.includes('hasStructuredForm.value'), '缺结构表单排除');
  assert.ok(body.includes('hasTextInput.value'), '缺文本输入排除');
  assert.ok(body.includes("req.kind === 'permission'"), "缺 permission 排除（裁决 R2：权限形态不变）");
  assert.ok(body.includes("req.kind === 'confirm'"), "缺 confirm 排除（裁决 R2：alert 形态不变）");
  assert.ok(body.includes('isWizard.value'), '缺向导当前题单选直提分支（kind form+questions）');
  assert.ok(body.includes("req.kind === 'single-choice'"), '缺单题 single-choice 直提分支');
});
check('T6-A toggleOption 直选调用：void submit() 在 updateSelected 写回之后（submit 读刚写回的 selectedIds）；短窗守卫在写回之前（编排裁定：防第二击污染新请求/新题选中态）', () => {
  const body = functionBody('toggleOption');
  const updateIdx = body.indexOf('updateSelected(new Set([optionId]))');
  assert.ok(updateIdx > -1, '缺普通选项 updateSelected 写回');
  const directIdx = body.indexOf('isDirectSubmitChoice()');
  assert.ok(directIdx > -1, '缺直选判定调用（单击仍只选中、需 footer 确认=条目 5 原抱怨形态）');
  const submitIdx = body.indexOf('void submit()');
  assert.ok(submitIdx > updateIdx, 'void submit() 必须在 updateSelected 写回之后（submit 读刚写回的 selectedIds）');
  const guardIdx = body.indexOf('Date.now() - lastDirectSubmitAt < 300');
  assert.ok(guardIdx > -1, '缺直提 300ms 短窗守卫（01 边界值「第二击落空」的完整兑现，边缘守卫补丁）');
  assert.ok(guardIdx < updateIdx, '短窗守卫必须先于 updateSelected（防第二击污染新请求/新题选中态，编排裁定）');
});
check('T6-A/R3 单选直提后双击不二次提交：submittingId 在飞守卫 + 直提短窗时间戳（dblclick 经队列下一请求/向导题间复用 DOM 可达，幂等由守卫保证）', () => {
  const sub = submitBody();
  assert.ok(sub.includes('submittingId.value === request.id'), 'submit 缺在飞守卫（双击二次提交面）');
  assert.match(src, /let lastDirectSubmitAt = 0;/, '缺直提短窗时间戳声明（边缘守卫补丁）');
  // R3：不钉子组件 @dblclick 字面删除；行为幂等由守卫保证，提交链保留（多选 Enter 等消费面）。
  assert.match(src, /@submit="submit"/, 'InteractionOptionList 的 @submit 消费链须保留');
  assert.match(optionListSrc, /@dblclick="!multiSelect && emit\('submit', entry\.option\.id\)"/, '虚拟形态 dblclick 提交链保留（幂等由守卫保证）');
  assert.match(optionListSrc, /@dblclick="!multiSelect && emit\('submit', option\.id\)"/, '非虚拟形态 dblclick 提交链保留');
});
check('P1-A 守卫上移 submit(optionId)：direct 形态 300ms 整体早退，位于在飞早退之后、toggleOption(optionId) 之前（第二击直构 ids 幽灵提交面）', () => {
  const sub = submitBody();
  const inFlightIdx = sub.indexOf('if (!request || submittingId.value === request.id) return;');
  assert.ok(inFlightIdx > -1, 'submit 缺在飞早退（函数体开头既有早退被波及）');
  const guardIdx = sub.indexOf('if (optionId && isDirectSubmitChoice() && optionId !== OTHER_OPTION_ID && Date.now() - lastDirectSubmitAt < 300) return;');
  assert.ok(guardIdx > -1, 'submit 缺 direct 形态 300ms 整体早退守卫（toggleOption 被吞后 submit 仍按 optionId 直构 ids 走全链——多题向导/队列下一请求 DOM 复用时第二击可达）');
  const toggleIdx = sub.indexOf('if (optionId) toggleOption(optionId)');
  assert.ok(toggleIdx > -1, 'submit 缺 toggleOption(optionId) 委托（结构被波及）');
  assert.ok(guardIdx > inFlightIdx, '守卫须位于在飞早退之后（既有早退保留在前）');
  assert.ok(guardIdx < toggleIdx, '守卫必须位于 toggleOption(optionId) 之前（晚于 toggleOption 则 ids 仍按 optionId 直构，幽灵提交不挡）');
});
check('P1-A/P3-1 被吞第二击不得污染聚焦态：toggleOption 内 focusOption(optionIndex) 移到 300ms 短窗守卫之后', () => {
  const body = functionBody('toggleOption');
  const guardIdx = body.indexOf('Date.now() - lastDirectSubmitAt < 300');
  assert.ok(guardIdx > -1, '缺 300ms 短窗守卫（前置结构被波及）');
  const focusIdx = body.indexOf('focusOption(optionIndex)');
  assert.ok(focusIdx > -1, '缺 focusOption(optionIndex)（键盘导航起点丢失）');
  assert.ok(focusIdx > guardIdx, 'focusOption 必须在 300ms 守卫之后（守卫吞掉的第二击不得改写 focusedIndex）');
});

console.log('\n=== UI13-P6 T6-B 单选形态 footer 主按钮门控（01 语义：Other 未激活缺席/激活有「确认」） ===');
check('T6-B showFooterPrimary 形态门控：form/text/permission/confirm/multi 恒真，其余=Other 激活', () => {
  const body = computedBody('showFooterPrimary');
  assert.ok(body.includes('hasStructuredForm.value || hasTextInput.value'), '缺 form/text 恒真分支');
  assert.ok(body.includes("kind === 'permission'") && body.includes("kind === 'confirm'"), '缺 permission/confirm 恒真（裁决 R2：权限「拒绝+所选 label」形态保留）');
  assert.ok(body.includes('if (currentMultiSelect.value) return true;'), '缺多选恒真分支（含向导 multiSelect 题与 kind multi-choice）');
  assert.ok(body.includes('return showOtherInput.value;'), '单选形态须门控在 Other 激活（未激活 Other 无主按钮）');
});
check('T6-B footer 主按钮 v-if="showFooterPrimary"（「取消」ghost /「上一步」模板字面逐字保留）', () => {
  const footer = footerBlock();
  assert.ok(footer.includes('v-if="showFooterPrimary"'), '主按钮缺 showFooterPrimary 门控（单选未激活 Other 仍渲染提交钮）');
  assert.match(
    src,
    /<button type="button" class="interaction-btn interaction-btn--ghost" @click="cancel">/,
    '「取消」ghost 按钮字面须逐字保留（enter-guard 契约钉）',
  );
  assert.match(
    src,
    /<button v-if="isWizard && wizardIndex > 0"[^>]*@click="previousQuestion">/,
    '「上一步」按钮字面须逐字保留（wizard-step-jump #4 钉）',
  );
});
check('T6-B submitLabel 按 01 重写：向导非末「下一题」/末「确认」；permission 所选 label；multi-choice「提交选择」；其余「确认」', () => {
  const body = computedBody('submitLabel');
  assert.ok(body.includes("wizardIndex.value < wizardQuestions.value.length - 1) return '下一题'"), '缺向导非末「下一题」（仅 multiSelect 题可见）');
  assert.ok(body.includes("if (isWizard.value) return '确认'"), '缺向导（含末题）「确认」分支');
  assert.match(body, /kind === 'permission'\)\s*return selectedOption\.value\?\.label \?\? '提交选择'/, '缺 permission 所选 label 文案');
  assert.ok(body.includes("kind === 'multi-choice') return '提交选择'"), '缺 multi-choice「提交选择」');
  assert.ok(body.includes("return '确认'"), '缺兜底「确认」（单选 Other 激活形态）');
  assert.ok(!body.includes('allQuestionsAnswered'), 'submitLabel 不再依赖 allQuestionsAnswered（末步未答全跳转守卫由 submit 承担，01 权威版无此行）');
});

console.log('\n=== UI13-P6 T6-C Other 展开不提交 / T6-D Other 激活点普通选项直提 ===');
check('T6-C 直选排除 OTHER_OPTION_ID；submit Other 空文本守卫（聚焦输入不提交）保留', () => {
  const body = functionBody('toggleOption');
  const directIdx = body.indexOf('isDirectSubmitChoice()');
  assert.ok(directIdx > -1, '缺直选判定');
  const exclIdx = body.indexOf('optionId !== OTHER_OPTION_ID');
  assert.ok(exclIdx > -1, '直选缺 Other 排除（Other 单击被误提交/空文本误提交面）');
  const sub = submitBody();
  const guardIdx = sub.indexOf('ids.includes(OTHER_OPTION_ID) && !otherText.value.trim()');
  assert.ok(guardIdx > -1, 'submit 缺 Other 空文本守卫');
  assert.ok(sub.slice(guardIdx, guardIdx + 200).includes('otherInput.value?.focus()'), 'Other 空文本守卫须聚焦输入框而非提交');
});
check('T6-C Other 展开链保留：showOtherInput 门控 + updateSelected Other 出集清文本 + 输入区渲染', () => {
  assert.match(src, /const showOtherInput = computed\(\(\) => selectedIds\.value\.has\(OTHER_OPTION_ID\)\);/, '缺 Other 激活门控');
  const upd = functionBody('updateSelected');
  assert.match(upd, /if \(!next\.has\(OTHER_OPTION_ID\)\) otherText\.value = '';/, 'Other 出集清文本语义保留');
  assert.match(src, /v-if="showOtherInput \|\| hasTextInput" class="interaction-other"/, 'Other/文本输入区渲染门控保留');
});
check('T6-D Other 激活时点普通选项=置换并直提：updateSelected 置换在 multiSelect 分支之后、先于直选', () => {
  const body = functionBody('toggleOption');
  const multiBlock = toggleMultiBlock();
  const multiEnd = body.indexOf(multiBlock) + multiBlock.length;
  const updateIdx = body.indexOf('updateSelected(new Set([optionId]))');
  assert.ok(updateIdx > multiEnd, '普通选项置换须在多选分支之后（单选路径）');
  const directIdx = body.indexOf('void submit()');
  assert.ok(directIdx > updateIdx, '置换后须直选提交（Other 出集、该普通选项被直接提交）');
});

console.log('\n=== UI13-P6 T6-E 多选维持 toggle+footer（回归钉） ===');
check('T6-E multiSelect 分支仅增删集 + return，无直选调用；canSubmit 空集早退守卫保留', () => {
  const multiBlock = toggleMultiBlock();
  assert.ok(multiBlock.includes('next.add(optionId)') && multiBlock.includes('next.delete(optionId)'), '多选 toggle 增删语义保留');
  assert.ok(multiBlock.includes('return;'), '多选分支须 return（不落入直选）');
  assert.ok(!multiBlock.includes('isDirectSubmitChoice'), '多选分支不得直选（零选中/半选误提交面）');
  const can = computedBody('canSubmit');
  assert.match(can, /selectedIds\.value\.size > 0 \|\| request\.kind === 'confirm'/, 'canSubmit 空集早退守卫保留（≥1 选中才可提交）');
  assert.match(can, /submittingId\.value === request\.id\)\s*return false/, 'canSubmit 在飞禁用保留');
});
check('T6-E footer 多选形态「提交选择」主按钮与「取消」保留', () => {
  const label = computedBody('submitLabel');
  assert.ok(label.includes("kind === 'multi-choice') return '提交选择'"), '多选主按钮「提交选择」文案保留');
  assert.match(src, /@click="cancel">\{\{ cancelLabel \}\}/, '「取消」按钮保留');
});

console.log('\n=== UI13-P6 T6-F 向导自动前进 / T6-G 末题整体提交 ===');
check('T6-F 直选 void submit() 无参 → submit wizard 分支 persist+前进链承担（与 Enter 等价）', () => {
  const body = functionBody('toggleOption');
  assert.match(body, /void submit\(\);/, '直选须无参 submit（走 wizard 分支前进/末题提交）');
  const sub = submitBody();
  assert.match(sub, /if \(isWizard\.value\) \{/, 'submit 缺 wizard 分支');
  assert.ok(sub.indexOf('persistCurrentQuestionAnswer()') > -1, 'wizard 分支缺 persist（前进前落账）');
  assert.ok(sub.includes('loadWizardStep(wizardIndex.value + 1)'), '缺自动前进 loadWizardStep(index+1)');
});
check('T6-G 向导末题单击=整体提交：末步 allQuestionsAnswered 守卫 + questionAnswers 载荷 + 直选入口', () => {
  const sub = submitBody();
  assert.ok(sub.includes('!allQuestionsAnswered.value'), '缺末步完整性守卫（未答全不放行）');
  assert.match(sub, /questionAnswers: isWizard\.value\s*\?\s*JSON\.parse\(JSON\.stringify\(questionAnswers\.value\)\)/, '向导整体提交 questionAnswers 载荷保留');
  const body = functionBody('toggleOption');
  assert.ok(body.includes('void submit()'), '末题单击的直选入口缺失（答完卡在最后一步）');
});

console.log('\n=== UI13-P6 T6-H multiSelect 题不自动前进 +「下一题」专属 ===');
check('T6-H 多选分支 return 先于直选判定（multiSelect 题单击 toggle 不前进）', () => {
  const body = functionBody('toggleOption');
  const multiBlock = toggleMultiBlock();
  const multiEnd = body.indexOf(multiBlock) + multiBlock.length;
  const directIdx = body.indexOf('isDirectSubmitChoice()');
  assert.ok(directIdx > -1, '缺直选判定');
  assert.ok(directIdx > multiEnd, '直选必须在多选分支之后（multiSelect 题不自动前进）');
});
check('T6-H 「下一题/末题确认」仅 multiSelect 当前题可见：showFooterPrimary 多选恒真 + 单选非 Other 无主按钮', () => {
  const show = computedBody('showFooterPrimary');
  assert.ok(show.includes('if (currentMultiSelect.value) return true;'), '缺多选恒真（「下一题」按钮在单选题也出现=回归）');
  assert.ok(show.includes('return showOtherInput.value;'), '单选非 Other 形态须无主按钮');
  const label = computedBody('submitLabel');
  assert.ok(label.includes("return '下一题'") && label.includes("if (isWizard.value) return '确认'"), '缺「下一题」/末题「确认」文案分支');
});

console.log('\n=== UI13-P6 T6-I 「上一步」「取消」「圆点」保留（回归钉 + 既有契约脚本） ===');
check('T6-I 上一步/取消/圆点跳转/cancelLabel/previousQuestion 委托全保留', () => {
  assert.match(src, /<button v-if="isWizard && wizardIndex > 0"[^>]*@click="previousQuestion">上一步</, '「上一步」按钮字面保留');
  assert.match(src, /@click="cancel">\{\{ cancelLabel \}\}/, '「取消」按钮保留');
  assert.match(src, /const cancelLabel = computed\(\(\) => activeRequest\.value\?\.kind === 'permission' \? '拒绝' : '取消'\);/, 'cancelLabel 双文案保留');
  assert.match(src, /@click="jumpToQuestion\(index\)"/, '步骤圆点跳转保留');
  const prev = functionBody('previousQuestion');
  assert.ok(prev.includes('jumpToQuestion(wizardIndex.value - 1)'), 'previousQuestion 委托保留');
});
check('T6-I 既有契约脚本回归门：npx tsx scripts/tdd-interaction-prompt-enter-guard.ts 退出码 0', () => {
  spawnAssert('scripts/tdd-interaction-prompt-enter-guard.ts');
});

console.log('\n=== UI13-P6 T6-J Enter/Esc 全键盘路径不变（回归钉 + 既有契约脚本） ===');
check('T6-J Enter 分支不动：X1 让位（button/summary、选项除外）+ void submit() 兜底', () => {
  const body = functionBody('handleKeydown');
  const enterIdx = body.indexOf("event.key === 'Enter'");
  assert.ok(enterIdx > -1, '缺 Enter 分支');
  const seg = body.slice(enterIdx, body.indexOf("event.key === 'Escape'"));
  assert.ok(seg.includes("closest('button, summary')"), 'Enter X1 让位保留');
  assert.ok(seg.includes("!target.closest('.interaction-option')"), '选项按钮不让人让位判定保留');
  assert.ok(seg.includes('void submit()'), 'Enter submit 兜底保留（Enter=提交/前进与单击等价）');
});
check('T6-J Esc 让位与 alert 语义不动：isTopmost 守卫 + isAlert submit(\'confirm\')', () => {
  const body = functionBody('handleKeydown');
  const escIdx = body.indexOf("event.key === 'Escape'");
  assert.ok(escIdx > -1, '缺 Esc 分支');
  const seg = body.slice(escIdx);
  assert.ok(seg.includes('!escHandle.isTopmost()'), 'Esc 让位守卫保留');
  assert.match(seg, /const isAlert = activeRequest\.value\.kind === 'confirm'/, 'alert 判定保留');
  assert.ok(seg.includes("submit('confirm')"), 'alert Esc=提交 confirm 保留');
});
check('T6-J 既有契约脚本回归门：esc-stack / initial-focus / hb13-v-perm-draft 全绿', () => {
  spawnAssert('scripts/tdd-esc-stack-verify.ts');
  spawnAssert('scripts/tdd-interaction-initial-focus-verify.ts');
  spawnAssert('scripts/tdd-bugfix-hb13-v-perm-draft-verify.ts');
});

console.log('\n=== UI13-P6 T6-K 载荷结构不变 / T6-L 自动前进前落草稿 ===');
check('T6-K respondAndRemove 载荷 { id, action, selectedOptionIds|questionAnswers, fieldValues, otherText } 不变', () => {
  const sub = submitBody();
  assert.match(sub, /action: 'submit',/, 'action 字面变动');
  assert.match(sub, /selectedOptionIds: isWizard\.value \? undefined : ids/, '单题 selectedOptionIds 字段变动');
  assert.match(sub, /questionAnswers: isWizard\.value/, '向导 questionAnswers 字段变动');
  assert.match(sub, /fieldValues: hasStructuredForm\.value/, '表单 fieldValues 字段变动');
  assert.match(sub, /otherText: otherText\.value\.trim\(\) \|\| undefined/, 'otherText 字段变动');
});
check('T6-K 主进程交互文件零波及：sdk-interactions 载荷映射/解析字面仍在', () => {
  assert.ok(sdkInteractionsSrc.includes('selectedOptionIds: response.selectedOptionIds'), '主进程 selectedOptionIds 映射被波及');
  assert.ok(sdkInteractionsSrc.includes('questionAnswers?.[questionId]'), '主进程 questionAnswers 解析被波及');
});
check('T6-L submit wizard 分支 persist 先于前进/提交；draftCache wizardIndex/questionAnswers 链保留', () => {
  const sub = submitBody();
  const wizIdx = sub.indexOf('if (isWizard.value) {');
  assert.ok(wizIdx > -1, '缺 wizard 分支');
  const persistIdx = sub.indexOf('persistCurrentQuestionAnswer()', wizIdx);
  assert.ok(persistIdx > -1, 'wizard 分支缺 persist');
  const advanceIdx = sub.indexOf('loadWizardStep(wizardIndex.value + 1)', wizIdx);
  assert.ok(advanceIdx > persistIdx, 'persist 必须先于自动前进（草稿落账语义）');
  const submittingIdx = sub.indexOf('submittingId.value = request.id;', wizIdx);
  assert.ok(submittingIdx > persistIdx, 'persist 必须先于整体提交路径');
  assert.match(src, /const draftCache = new Map<string, \{ selectedIds: Set<string>; otherText: string; wizardIndex: number; questionAnswers/, 'draftCache 值类型含 wizardIndex/questionAnswers');
  assert.match(src, /watch\(\s*\[selectedIds, otherText, wizardIndex, questionAnswers, fieldValues\] as const/, '草稿 watch 源完整（切回恢复链）');
});

console.log('\n=== UI13-P6 T6-M 五形态 UI 一致 / T6-N 在飞防重 / T6-O alert 边界（回归钉） ===');
check('T6-M 五形态 eyebrow 标题文案字面保留', () => {
  const eyebrow = computedBody('eyebrow');
  for (const need of ["kind === 'permission') return 'Claude Code 需要确认'", "'Claude Code 需要你多选'", "'Claude Code 需要你输入'", "'Claude Code 需要参数'"]) {
    assert.ok(eyebrow.includes(need), `eyebrow 缺 ${need}`);
  }
  assert.ok(eyebrow.includes('需要你选择'), '缺选择题 eyebrow 兜底文案');
});
check('T6-M 五形态渲染锚点不变：permission 详情 / 表单 / 选项列表 / 预览面板', () => {
  assert.match(src, /v-if="activeRequest\.kind === 'permission'" :input="activeRequest\.input"/, 'permission 详情渲染保留');
  assert.match(src, /v-if="hasStructuredForm" class="interaction-form"/, '表单渲染保留');
  assert.match(src, /<InteractionOptionList/, '选项列表组件保留');
  assert.match(src, /v-if="hasPreview" :preview/, '预览面板保留');
});
check('T6-N submit/cancel 入口 submittingId 早退守卫保留（在飞再点不重复提交）', () => {
  assert.match(submitBody(), /if \(!request \|\| submittingId\.value === request\.id\) return;/, 'submit 缺在飞守卫');
  const cancelBody = functionBody('cancel');
  assert.match(cancelBody, /if \(!request \|\| submittingId\.value === request\.id\) return;/, 'cancel 缺在飞守卫');
});
check('T6-O alert 边界（confirm 单选项）Esc=提交 confirm 保留（confirm 不直选由 T6-A R2 排除链钉）', () => {
  const body = functionBody('handleKeydown');
  const escIdx = body.indexOf("event.key === 'Escape'");
  const seg = body.slice(escIdx);
  assert.match(seg, /activeRequest\.value\.options\?\.length === 1\s*&&\s*activeRequest\.value\.options\[0\]\?\.id === 'confirm'/, 'alert 单选项判定保留');
  assert.ok(seg.includes("submit('confirm')"), 'alert Esc=提交 confirm 保留');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
