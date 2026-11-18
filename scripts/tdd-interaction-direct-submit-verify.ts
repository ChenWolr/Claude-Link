// tdd-interaction-direct-submit-verify.ts
// C3 重写版（2026-11-15 eight-issues 批次 C3 点；用例正本 03b-test-cases-renderer.md §6 C3-1/C3-4
// 与 §5 C2-1/C2-5；行为权威 00-behavior-specs.md 域 C C2/C3 节；实现权威 02-impl-details-renderer.md
// §4/§5.1。前史：UI13-P6 版（2026-11-14，T6-A~O）钉向导分页态直提链；C1 变体 2「左侧题号导航栏」
// 重构（2026-11-16 已落）移除向导分页实现，本脚本按重写纪律重组（登记名不变，selftest 清单行沿用）。
//
// 保留面（单题五形态直提现状不变=C1 契约 9 零触碰面，逐字钉）：
//  T6-M 五形态 eyebrow/渲染锚点；T6-A R2 permission/confirm 排除链；T6-E 多选 toggle+footer+
//  canSubmit 守卫；T6-C/T6-D Other 展开与空文本守卫/置换直提；T6-N 在飞防重 submittingId；
//  T6-O alert Esc 语义；T6-K respondAndRemove 载荷三元式+sdk-interactions 零波及；R3/P1-A/P3-1
//  双击防重守卫位次（单题直提边沿=C2-1 白名单成员）；单题（非 wizard）footer 模板零触碰。
//
// 重写面（变体 2 直提新形态+C2 守卫口径）：
//  · wizard 单选直提调用图：wizardToggleOption 普通选项=守卫→updateAnswer(selectedOptionIds:
//    [optionId])+出集清 Other→写时间戳→advanceToNextUnanswered（点击即作答+自动前进，契约 5）；
//  · wizard 多选不直提（谓词 currentMultiSelect 早退 + wizardToggleOption 多选分支 return 双断言）；
//  · C2-1 守卫调用点白名单（C2 报告回填锚点 2026-11-16）：读点恰三处=toggleOption :386 /
//    wizardToggleOption :448 / submit(optionId) :534；写点恰两处 :391/:450；全文件 lastDirectSubmitAt
//    恰 6 处（声明+3 读+2 写）；负向零命中面=jumpToQuestion/previousQuestion/submitWizard/
//    requestDiscard/cancel/handleKeydown/两处多选分支切片；
//  · C2-5 窗值钉：lastDirectSubmitAt 声明保留 + `< 300` 严格小于字面（契约 3 防误触双击目的不变）；
//  · C3-4①footer 顺序钉：wizard footer 取消 ghost 最左→进度文本→上一题 ghost→下一题/提交 primary
//    最右（取消不夹上下一步中间，治抱怨④）；C3-4②取消不居中钉：取消钮无 margin:auto/居中形态，
//    .wizard-foot-progress margin-right:auto（原型 .foot .hint 形态=提示占左、按钮组居右）。
//
// 废卷面（C1 重构移除，随本重写废止并在此留痕——勿再按旧锚补钉）：
//  T6-B showFooterPrimary 旧门控两钉（旧 footer 切片 marker `<footer class="interaction-dialog__footer">`
//    已随 v-if/v-else 分支化失效；「单选未激活 Other 无主按钮」在 wizard 形态被契约 4 反转——非 wizard
//    footer 门控改由「单题 footer 零触碰」钉承接）；
//  T6-F 向导 persist+自动前进链（persistCurrentQuestionAnswer/loadWizardStep 已移除）；
//  T6-G 末题单击整体提交（submitWizard 承担，见 wizard-step-jump 重写版⑨）；
//  T6-H「下一题仅 multiSelect 当前题可见」（变体 2 主按钮恒渲染=契约 4，语义反转）；
//  T6-J Enter/X1 键盘钉（迁 enter-guard 重写版）；T6-L wizard persist 链（同 T6-F）；
//  T6-I 圆点保留钉（圆点行已移除，左栏 wizard-nav 承担——见 wizard-step-jump 重写版②③），其
//  spawn enter-guard 回归门保留为 T6-I 后继。
//
// 「对旧实现必红」自证（内置，C3-1 期望条款）：spawnSync git show 取批次基线提交 3be0d7d
//（04-实施计划 §0；指令原文 HEAD: 在 2026-11-16 实施期与之等价——C1/C2 改动未提交，HEAD 即
// 重构前实现。固定取基线提交快照是为防本批提交入库后 HEAD 指向新实现、新钉对新实现全绿而使
// 自证断言自毁、selftest 永红）旧源码写临时文件 .plan-loop/.../scratch/c3-old-InteractionPrompt-*.vue
// 留痕，对重写面新钉（redOnOld 标记）跑旧源码断言至少一条 FAIL（逐条输出留痕），随后对当前
// 实现全绿。
//
// 运行：npx tsx scripts/tdd-interaction-direct-submit-verify.ts（登记 scripts/selftest-static-list.txt:268）

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const optionListSrc = readFileSync(new URL('../src/renderer/components/chat/InteractionOptionList.vue', import.meta.url), 'utf8');
const sdkInteractionsSrc = readFileSync(new URL('../src/main/modules/sdk-interactions.ts', import.meta.url), 'utf8');

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

/** 切片 wizardToggleOption 内 multiSelect 分支（if (question.multiSelect) { … } 配对体）。 */
function wizardMultiBlock(): string {
  const body = functionBody('wizardToggleOption');
  const marker = 'if (question.multiSelect) {';
  const start = body.indexOf(marker);
  assert.ok(start > -1, 'wizardToggleOption 缺 multiSelect 分支');
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
  assert.ok(false, 'wizardToggleOption multiSelect 分支花括号配对失败');
}

/** 切片 wizard footer（C1 变体 2 契约 4 专钉面）。 */
function wizardFooterBlock(): string {
  const marker = '<footer v-if="isWizard" class="interaction-dialog__footer interaction-dialog__footer--wizard">';
  const idx = src.indexOf(marker);
  assert.ok(idx > -1, '缺 wizard footer（C1 变体 2 重排面）');
  const end = src.indexOf('</footer>', idx);
  assert.ok(end > idx, 'wizard footer 闭合切片失败');
  return src.slice(idx, end);
}

/** 切片单题（非 wizard）footer——C1 契约 9 零触碰面。 */
function singleFooterBlock(): string {
  const marker = '<footer v-else class="interaction-dialog__footer">';
  const idx = src.indexOf(marker);
  assert.ok(idx > -1, '缺单题 footer（v-else 分支）');
  const end = src.indexOf('</footer>', idx);
  assert.ok(end > idx, '单题 footer 闭合切片失败');
  return src.slice(idx, end);
}

/** 提取样式规则体：自选择器起至首个 `}`。 */
function styleRule(selector: string): string {
  const idx = src.indexOf(selector);
  assert.ok(idx > -1, `缺样式规则 ${selector}`);
  return src.slice(idx, src.indexOf('}', idx));
}

/** 按钮开标签切片：footer 切片内含 needle 的 `<button` 起至 `>`。 */
function buttonOpenTag(block: string, needle: string): string {
  const at = block.indexOf(needle);
  assert.ok(at > -1, `footer 缺 ${needle}`);
  const open = block.lastIndexOf('<button', at);
  assert.ok(open > -1, `${needle} 前缺 <button 开标签`);
  const gt = block.indexOf('>', at);
  assert.ok(gt > -1, `${needle} 开标签未闭合`);
  return block.slice(open, gt + 1);
}

function spawnAssert(script: string): void {
  const r = spawnSync('npx', ['tsx', script], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-6).join('\n');
  assert.equal(r.status, 0, `${script} 退出码 ${r.status}（连带契约被波及）\n${tail}`);
}

group('===保留面：单题五形态 T6-M（eyebrow/渲染锚点，C1 契约 9 零触碰） ===');
check('T6-M 五形态 eyebrow 文案字面保留（permission/多选/输入/参数/选择兜底）', () => {
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

group('===保留面：单题直提 T6-A R2 排除链 + R3/P1-A/P3-1 守卫位次（C2-1 白名单成员） ===');
check('T6-A R2 isDirectSubmitChoice 排除链：非 multi/form/text/permission/confirm；单题 single-choice', () => {
  const body = functionBody('isDirectSubmitChoice');
  assert.ok(body.includes('currentMultiSelect.value'), '缺 multiSelect 排除（多选不得直提）');
  assert.ok(body.includes('hasStructuredForm.value'), '缺结构表单排除');
  assert.ok(body.includes('hasTextInput.value'), '缺文本输入排除');
  assert.ok(body.includes("req.kind === 'permission'"), "缺 permission 排除（裁决 R2：权限形态不变）");
  assert.ok(body.includes("req.kind === 'confirm'"), "缺 confirm 排除（裁决 R2：alert 形态不变）");
  assert.ok(body.includes("req.kind === 'single-choice'"), '缺单题 single-choice 直提分支');
});
check('T6-A toggleOption 直选调用序：updateSelected 写回→void submit()；300ms 守卫先于写回', () => {
  const body = functionBody('toggleOption');
  const updateIdx = body.indexOf('updateSelected(new Set([optionId]))');
  assert.ok(updateIdx > -1, '缺普通选项 updateSelected 写回');
  const directIdx = body.indexOf('isDirectSubmitChoice()');
  assert.ok(directIdx > -1, '缺直选判定调用');
  const submitIdx = body.indexOf('void submit()');
  assert.ok(submitIdx > updateIdx, 'void submit() 必须在 updateSelected 写回之后（submit 读刚写回的 selectedIds）');
  const guardIdx = body.indexOf('Date.now() - lastDirectSubmitAt < 300');
  assert.ok(guardIdx > -1, '缺直提 300ms 短窗守卫（C2-5 白名单读点）');
  assert.ok(guardIdx < updateIdx, '短窗守卫必须先于 updateSelected（防第二击污染新请求/新题选中态）');
});
check('R3 直提幂等：submittingId 在飞守卫 + lastDirectSubmitAt 声明 + dblclick 提交链保留', () => {
  const sub = submitBody();
  assert.ok(sub.includes('submittingId.value === request.id'), 'submit 缺在飞守卫（双击二次提交面）');
  assert.match(src, /let lastDirectSubmitAt = 0;/, '缺直提短窗时间戳声明（C2-5）');
  assert.match(src, /@submit="submit"/, 'InteractionOptionList 的 @submit 消费链须保留');
  assert.match(optionListSrc, /@dblclick="!multiSelect && emit\('submit', entry\.option\.id\)"/, '虚拟形态 dblclick 提交链保留（幂等由守卫保证）');
  assert.match(optionListSrc, /@dblclick="!multiSelect && emit\('submit', option\.id\)"/, '非虚拟形态 dblclick 提交链保留');
});
check('P1-A submit(optionId) 直提守卫：位于在飞早退之后、toggleOption(optionId) 之前（单题直提边沿白名单）', () => {
  const sub = submitBody();
  const inFlightIdx = sub.indexOf('if (!request || submittingId.value === request.id) return;');
  assert.ok(inFlightIdx > -1, 'submit 缺在飞早退');
  const guardIdx = sub.indexOf('if (optionId && isDirectSubmitChoice() && optionId !== OTHER_OPTION_ID && Date.now() - lastDirectSubmitAt < 300) return;');
  assert.ok(guardIdx > -1, 'submit 缺 direct 形态 300ms 整体早退守卫（C2-1 白名单读点 :534）');
  const toggleIdx = sub.indexOf('if (optionId) toggleOption(optionId)');
  assert.ok(toggleIdx > -1, 'submit 缺 toggleOption(optionId) 委托');
  assert.ok(guardIdx > inFlightIdx, '守卫须位于在飞早退之后');
  assert.ok(guardIdx < toggleIdx, '守卫必须位于 toggleOption(optionId) 之前（幽灵提交不挡）');
});
check('P3-1 被吞第二击不污染聚焦态：toggleOption 内 focusOption(optionIndex) 在 300ms 守卫之后', () => {
  const body = functionBody('toggleOption');
  const guardIdx = body.indexOf('Date.now() - lastDirectSubmitAt < 300');
  assert.ok(guardIdx > -1, '缺 300ms 短窗守卫');
  const focusIdx = body.indexOf('focusOption(optionIndex)');
  assert.ok(focusIdx > -1, '缺 focusOption(optionIndex)');
  assert.ok(focusIdx > guardIdx, 'focusOption 必须在 300ms 守卫之后');
});

group('===保留面：T6-E 多选 toggle+footer / T6-C/T6-D Other 链 ===');
check('T6-E multiSelect 分支仅增删集+return 无直选；canSubmit 空集早退+在飞禁用', () => {
  const multiBlock = toggleMultiBlock();
  assert.ok(multiBlock.includes('next.add(optionId)') && multiBlock.includes('next.delete(optionId)'), '多选 toggle 增删语义保留');
  assert.ok(multiBlock.includes('return;'), '多选分支须 return（不落入直选）');
  assert.ok(!multiBlock.includes('isDirectSubmitChoice'), '多选分支不得直选');
  assert.ok(!multiBlock.includes('lastDirectSubmitAt'), 'C2-1 负向：多选分支切片零守卫出现（快速连点不吞）');
  const can = computedBody('canSubmit');
  assert.match(can, /selectedIds\.value\.size > 0 \|\| request\.kind === 'confirm'/, 'canSubmit 空集早退守卫保留');
  assert.match(can, /submittingId\.value === request\.id\)\s*return false/, 'canSubmit 在飞禁用保留');
});
check('T6-E footer 多选「提交选择」文案 + 取消钮/cancelLabel 双文案保留', () => {
  const label = computedBody('submitLabel');
  assert.ok(label.includes("kind === 'multi-choice') return '提交选择'"), '多选主按钮「提交选择」文案保留');
  assert.match(src, /@click="cancel">\{\{ cancelLabel \}\}/, '「取消」按钮保留');
  assert.match(src, /const cancelLabel = computed\(\(\) => activeRequest\.value\?\.kind === 'permission' \? '拒绝' : '取消'\);/, 'cancelLabel 双文案保留');
});
check('T6-C 直选排除 OTHER；submit Other 空文本守卫（聚焦输入不提交）保留', () => {
  const body = functionBody('toggleOption');
  assert.ok(body.indexOf('optionId !== OTHER_OPTION_ID') > -1, '直选缺 Other 排除');
  const sub = submitBody();
  const guardIdx = sub.indexOf('ids.includes(OTHER_OPTION_ID) && !otherText.value.trim()');
  assert.ok(guardIdx > -1, 'submit 缺 Other 空文本守卫');
  assert.ok(sub.slice(guardIdx, guardIdx + 200).includes('otherInput.value?.focus()'), 'Other 空文本守卫须聚焦输入框而非提交');
});
check('T6-C Other 展开链：showOtherInput 门控 + updateSelected 出集清文本 + 输入区渲染', () => {
  assert.match(src, /const showOtherInput = computed\(\(\) => selectedIds\.value\.has\(OTHER_OPTION_ID\)\);/, '缺 Other 激活门控');
  const upd = functionBody('updateSelected');
  assert.match(upd, /if \(!next\.has\(OTHER_OPTION_ID\)\) otherText\.value = '';/, 'Other 出集清文本语义保留（单题出集路径）');
  assert.match(src, /v-if="showOtherInput \|\| hasTextInput" class="interaction-other"/, 'Other/文本输入区渲染门控保留');
});
check('T6-D Other 激活时点普通选项=置换并直提：updateSelected 置换在 multiSelect 分支之后、先于直选', () => {
  const body = functionBody('toggleOption');
  const multiBlock = toggleMultiBlock();
  const multiEnd = body.indexOf(multiBlock) + multiBlock.length;
  const updateIdx = body.indexOf('updateSelected(new Set([optionId]))');
  assert.ok(updateIdx > multiEnd, '普通选项置换须在多选分支之后（单选路径）');
  const directIdx = body.indexOf('void submit()');
  assert.ok(directIdx > updateIdx, '置换后须直选提交');
});

group('===保留面：T6-N 在飞防重 / T6-O alert Esc / T6-K 载荷链零波及 ===');
check('T6-N submit/cancel 入口 submittingId 早退守卫保留', () => {
  assert.match(submitBody(), /if \(!request \|\| submittingId\.value === request\.id\) return;/, 'submit 缺在飞守卫');
  const cancelBody = functionBody('cancel');
  assert.match(cancelBody, /if \(!request \|\| submittingId\.value === request\.id\) return;/, 'cancel 缺在飞守卫');
});
check('T6-O alert 边界（confirm 单选项）Esc=提交 confirm 保留', () => {
  const body = functionBody('handleKeydown');
  const seg = body.slice(body.indexOf("event.key === 'Escape'"));
  assert.match(seg, /activeRequest\.value\.options\?\.length === 1\s*&&\s*activeRequest\.value\.options\[0\]\?\.id === 'confirm'/, 'alert 单选项判定保留');
  assert.ok(seg.includes("submit('confirm')"), 'alert Esc=提交 confirm 保留');
});
check('T6-K respondAndRemove 载荷三元式 { id, action, selectedOptionIds|questionAnswers, fieldValues, otherText } 不变', () => {
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

group('===重写面：单题 footer 零触碰（C1 契约 9，承接废卷 T6-B 的存活语义） ===');
check('单题（非 wizard）footer 模板零触碰：上一步死字面/取消 ghost/主按钮 showFooterPrimary 门控+canSubmit 禁用+submit() 调用', () => {
  const footer = singleFooterBlock();
  assert.ok(footer.includes('<button v-if="isWizard && wizardIndex > 0"'), '「上一步」死字面保留（enter-guard 契约锚）');
  assert.ok(footer.includes('@click="cancel">{{ cancelLabel }}'), '取消 ghost 钮保留');
  assert.ok(footer.includes('v-if="showFooterPrimary"'), '主按钮 showFooterPrimary 门控保留（非 wizard 门控语义不变）');
  assert.ok(footer.includes(':disabled="!canSubmit"'), '主按钮 canSubmit 禁用保留');
  assert.ok(footer.includes('data-dialog-initial-focus'), '主按钮初始焦点锚保留');
  assert.ok(footer.includes('@click="submit()"'), '主按钮 submit() 调用保留（无 optionId=不触发 P1-A 守卫，C2 口径）');
  assert.ok(footer.includes('{{ submitLabel }}'), '主按钮 submitLabel 保留');
}, true);

group('===重写面：wizard 单选直提调用图 + 多选不直提（变体 2 契约 5/C2 口径） ===');
check('wizard 单选直提调用图：wizardToggleOption 普通选项=守卫→updateAnswer([optionId],Other 出集)→写时间戳→advanceToNextUnanswered', () => {
  const body = functionBody('wizardToggleOption');
  const guardIdx = body.indexOf('if (Date.now() - lastDirectSubmitAt < 300) return;');
  assert.ok(guardIdx > -1, '缺 300ms 守卫（C2-1 白名单读点 ：448）');
  const updateIdx = body.indexOf('updateAnswer(qid, { selectedOptionIds: [optionId], otherText: undefined });');
  assert.ok(updateIdx > -1, '缺单选作答写账（selectedOptionIds:[optionId] + Other 出集清空）');
  const stampIdx = body.indexOf('lastDirectSubmitAt = Date.now();');
  assert.ok(stampIdx > -1, '缺守卫放行后时间戳写入（C2-1 白名单写点 :450）');
  const advanceIdx = body.indexOf('advanceToNextUnanswered();');
  assert.ok(advanceIdx > -1, '缺自动前进（契约 5：点击即作答+自动前进）');
  assert.ok(guardIdx < updateIdx && updateIdx < stampIdx && stampIdx < advanceIdx, '调用图序错乱：守卫→写账→写时间戳→前进');
}, true);
check('wizard Other 点击=展开聚焦不写账本：OTHER 分支在守卫之前 return 且切片内零 updateAnswer', () => {
  const body = functionBody('wizardToggleOption');
  const marker = 'if (optionId === OTHER_OPTION_ID) {';
  const otherIdx = body.indexOf(marker);
  assert.ok(otherIdx > -1, '缺 Other 展开分支');
  let depth = 0;
  let cursor = otherIdx + marker.length - 1;
  let end = -1;
  while (cursor < body.length) {
    const ch = body[cursor];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = cursor; break; } }
    cursor++;
  }
  assert.ok(end > otherIdx, 'Other 分支配对失败');
  const otherBlock = body.slice(otherIdx, end + 1);
  assert.ok(otherBlock.includes('wizardOtherExpanded.value = true;'), 'Other 分支须展开输入');
  assert.ok(otherBlock.includes('wizardOtherInput.value?.focus()'), 'Other 分支须聚焦输入框');
  assert.ok(otherBlock.includes('return;'), 'Other 分支须 return');
  assert.ok(!otherBlock.includes('updateAnswer'), 'Other 点击不得写账（空文本 Other 不得记成已答）');
  const guardIdx = body.indexOf('if (Date.now() - lastDirectSubmitAt < 300) return;');
  assert.ok(guardIdx > otherIdx, 'Other 展开须在守卫之前 return（C2 口径：Other 流程不经守卫）');
}, true);
check('wizard 多选不直提双断言：谓词 currentMultiSelect 早退 + wizardToggleOption 多选分支 return 无前进无守卫', () => {
  const pred = functionBody('isDirectSubmitChoice');
  assert.ok(pred.includes('if (!req || currentMultiSelect.value) return false;'), '谓词缺多选早退（02 §4.2-1 谓词层双保险）');
  const multiBlock = wizardMultiBlock();
  assert.ok(multiBlock.includes('updateAnswer'), '多选分支须写账（勾选切换）');
  assert.ok(multiBlock.includes('return;'), '多选分支须 return（不落入单选直提）');
  assert.ok(!multiBlock.includes('advanceToNextUnanswered'), '多选 toggle 不得自动前进（显式「下一题」前进）');
  assert.ok(!multiBlock.includes('lastDirectSubmitAt'), 'C2-1 负向：wizard 多选分支切片零守卫出现（C2-3 连点不吞的结构面）');
}, true);
check('advanceToNextUnanswered 只向前找首个未答题：index > wizardIndex 且 !isQuestionAnswered，有则跳无则原地', () => {
  const body = functionBody('advanceToNextUnanswered');
  assert.match(body, /findIndex\(\s*\(question, index\) => index > wizardIndex\.value && !isQuestionAnswered\(questionAnswers\.value\[question\.id\]\)/, '自动前进判据不符（只向前+未答）');
  assert.ok(body.includes('if (next >= 0) {'), '缺 next>=0 门（无未答题原地停留）');
  assert.ok(body.includes('wizardIndex.value = next;'), '缺跳转');
  assert.ok(!body.includes('submittingId'), '自动前进路径不得置 submittingId（在飞守卫面）');
}, true);

group('===重写面：C2-1 守卫调用点白名单（正/负向）+ C2-5 窗值钉 ===');
check('C2-5 守卫窗值语义不变：lastDirectSubmitAt 声明保留 + < 300 严格小于字面 + 白名单非空（三读点）', () => {
  assert.match(src, /let lastDirectSubmitAt = 0;/, '缺声明（守卫被整体删除=收窄过度反转）');
  const reads = [functionBody('toggleOption'), functionBody('wizardToggleOption'), submitBody()].map((body) => body.includes('Date.now() - lastDirectSubmitAt < 300'));
  assert.ok(reads.every(Boolean), `守卫读点白名单残缺 toggleOption=${reads[0]} wizardToggleOption=${reads[1]} submit=${reads[2]}`);
  assert.match(src, /< 300\)? return;/, '缺 < 300 严格小于字面（边界行为逐字一致）');
}, true);
check('C2-1 全文件 lastDirectSubmitAt 恰 6 处（声明 1+读 3+写 2）——新调用点入白名单须经本钉同步评审', () => {
  const count = (src.match(/lastDirectSubmitAt/g) ?? []).length;
  assert.equal(count, 6, `守卫符号出现 ${count} 处（白名单外新增读/写点=守卫口径扩大，C2-1 违约；删点=白名单残缺）`);
}, true);
check('C2-1 负向白名单：显式导航/提交/丢弃/键盘 handler 切片 lastDirectSubmitAt 零出现', () => {
  for (const name of ['jumpToQuestion', 'previousQuestion', 'submitWizard', 'requestDiscard', 'cancel', 'handleKeydown']) {
    const body = functionBody(name);
    assert.ok(!body.includes('lastDirectSubmitAt'), `${name} 切片出现守卫符号（显式导航/提交/丢弃路径被吞面，C2-1 违约）`);
  }
}, true);

group('===重写面：C3-4①wizard footer 顺序 + C3-4②取消不居中 ===');
check('C3-4① wizard footer 顺序：取消 ghost 最左（首钮）→进度文本→上一题 ghost→下一题/提交 primary 最右（取消不夹中间）', () => {
  const footer = wizardFooterBlock();
  const cancelIdx = footer.indexOf('data-testid="wizard-cancel-btn"');
  const progressIdx = footer.indexOf('class="wizard-foot-progress"');
  const prevIdx = footer.indexOf('data-testid="wizard-prev-btn"');
  const nextIdx = footer.indexOf('data-testid="wizard-next-btn"');
  assert.ok(cancelIdx > -1 && progressIdx > -1 && prevIdx > -1 && nextIdx > -1, 'wizard footer 四元素残缺');
  assert.ok(cancelIdx < progressIdx && progressIdx < prevIdx && prevIdx < nextIdx, 'footer 顺序违约（取消须最左、primary 须最右）');
  const firstOpen = buttonOpenTag(footer, 'data-testid="wizard-cancel-btn"');
  assert.ok(footer.indexOf('<button') < cancelIdx && firstOpen.includes('interaction-btn--ghost'), '首钮须为取消 ghost（@click="requestDiscard"）');
  assert.ok(firstOpen.includes('@click="requestDiscard"'), '取消钮须走丢弃保护门（契约 6）');
  assert.ok(buttonOpenTag(footer, 'data-testid="wizard-prev-btn"').includes('interaction-btn--ghost'), '上一题须 ghost');
  assert.ok(buttonOpenTag(footer, 'data-testid="wizard-next-btn"').includes('interaction-btn--primary'), '下一题/提交须 primary（全局惯例）');
}, true);
check('C3-4② 取消不居中：取消钮开标签无 margin/居中样式；.wizard-foot-progress margin-right:auto（提示占左、按钮组居右）', () => {
  const footer = wizardFooterBlock();
  const cancelTag = buttonOpenTag(footer, 'data-testid="wizard-cancel-btn"');
  assert.ok(!cancelTag.includes('margin'), '取消钮开标签不得带 margin（居中形态回归）');
  assert.ok(!cancelTag.includes('align-self'), '取消钮不得 align-self 居中');
  const progress = styleRule('.wizard-foot-progress {');
  assert.match(progress, /margin-right: auto;/, '缺进度文本 margin-right:auto（原型 .foot .hint 形态：提示占左、按钮组居右）');
  const footerStyle = styleRule('.interaction-dialog__footer {');
  assert.match(footerStyle, /justify-content: flex-end;/, 'footer 按钮组须居右（取消不居中的布局面）');
}, true);

group('===C3-5 姊妹门回归门（spawn，沿用 T6-I/T6-J 手法） ===');
check('C3-5 姊妹门：esc-stack / initial-focus / hb13-v-perm-draft 全绿', () => {
  spawnAssert('scripts/tdd-esc-stack-verify.ts');
  spawnAssert('scripts/tdd-interaction-initial-focus-verify.ts');
  spawnAssert('scripts/tdd-bugfix-hb13-v-perm-draft-verify.ts');
});
check('T6-I 后继回归门：enter-guard（C3 重写版）exit 0', () => {
  spawnAssert('scripts/tdd-interaction-prompt-enter-guard.ts');
});

// ── 「对旧实现必红」自证（C3-1 期望条款；机制见头注）──
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
    writeFileSync(new URL('c3-old-InteractionPrompt-direct-submit.vue', scratchDirUrl), old, 'utf8');
  } catch { /* scratch 只读等场景：留痕失败不阻断自证本体 */ }
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
