// tdd-interaction-prompt-enter-guard.ts
// C3 重写版（2026-11-15 eight-issues 批次 C3 点；用例正本 03b-test-cases-renderer.md §6 C3-3/C3-4-③；
// 行为权威 00-behavior-specs.md 域 C C1 契约 6/7/8 + C3 节；实现权威 02-impl-details-renderer.md
// §3.3/§5.1。前史：X1 版（R06-F1）钉 Enter/Space 让位骨架；C1 变体 2 重构在 handleKeydown 头部
// 插入 wizard 早退分流（Esc 分域），本脚本按重写纪律重组（登记名不变）。
//
// 保留面（X1 让位骨架，逐字钉）：
//  isTopmost 遮挡让位先于键分支（A9/B5 同源）；Enter/Space 分支让位判定（dialogRef.contains +
//  closest('button, summary') - closest('.interaction-option) 排除）先于 preventDefault；Enter
//  submit 兜底/Space toggleOption 兜底保留；两分支条件字面未收窄；让位目标在场（取消/拒绝 ghost
//  钮+上一步钮+交互历史 <summary>）；选项判别器（.interaction-option button 两形态）；
//  previousQuestion 函数名契约（委托 jumpToQuestion(wizardIndex.value - 1)+体无 persist+模板绑定，
//  enter-guard 既有正则契约原样保留）。
//  位次适配说明：旧版「isTextEntryTarget 首行早退」在变体 2 下移至 wizard 分流之后（wizard 输入框
//  内 Esc 须进分域处理=失焦不关单；C1 实现注释明令，两者对非 wizard 早退结果等价）——本重写版按
//  新位次钉（wizard 分流→Tab 分支文本放行→wizard 分流后非 wizard 键链文本早退→箭头分支）。
//
// 重写面（Esc/Enter 分域，C1 契约 6/7/8）：
//  · Esc 分域：wizard 分支 confirm 层 dismiss → 输入焦点 blur → requestDiscard（输入焦点判定先于
//    丢弃链=03b C3-4-③）；wizard 分支先于非 wizard Escape 分支；
//  · Enter 分域：wizard 分流吞掉 Enter（分支内无 Enter 处理无 submit 调用）——B5 focusedOption
//    兜底对 wizard 不可达（02 §5.1 口径；03b C3-3②「兜底零出现」按 wizard Enter 域解读——兜底
//    本体保留服务非 wizard 形态，其写回正确性归 initial-focus 姊妹门 P2-1 既有钉）；
//  · Other 内 Enter=确认该题：wizard-other input @keydown.enter.prevent=blur（文本 @input 即时
//    落账，Enter 仅失焦=确认该题文本）；
//  · 方向键仅移焦（契约 8）：非 wizard 箭头分支只 move()（无 toggleOption/submit）；wizard 态箭头
//    被分流吞掉（交还焦点容器原生滚动）。
//
// P3-4 补钉（2026-11-19，验收 r1 发现清单）：Space 分域断言——03b C1-10③ 旧半行「单选不因 Space
//  改选中」口径偏差已修正。权威口径：00 C1.8 治理的是「Tab/方向键浏览不改选中」；Space 在选项钮
//  聚焦时是浏览器原生 button 激活=等同点击作答（激活键非浏览键，与方向键限制不冲突），故：
//  · 单选态：全局 Space 分支以 currentMultiSelect 限定，单选态不进任何 Space 分支 → 无
//    preventDefault → 原生激活 <button type="button" class="interaction-option"> → click →
//    toggleOption 单选直提链 = 作答（实现无缺陷，此前卷内未出钉=留痕缺口，本补钉收口）；
//  · 多选态：Space 分支接管——选项钮聚焦不让位（.interaction-option 被让位判定排除）→
//    preventDefault + toggleOption(focusedOption) = Set 增删 toggle；焦点不在选项钮时兜底同 toggle；
//  · wizard 态：分流吞掉 Space 交还原生激活（与 Enter 域同口径，实现注释 748-749 行明令）。
//  本组补钉均为保留面语义钉（旧实现同形态，不进必红自证集）。
//
// 废卷面（随本重写废止并在此留痕——勿再按旧锚补钉）：
//  旧 check「B5 兜底仍在 submit（空白处 Enter 提交聚焦项的语义保留）」——与新契约 7「移除 wizard
//  态 Enter 兜底」方向相反，删除；兜底对非 wizard 形态仍存活（initial-focus P2-1 钉管其写回），
//  本脚本以「对 wizard 不可达」负向钉替代（见重写面）。
//
// 「对旧实现必红」自证（内置，C3-3 期望条款）：spawnSync git show 取批次基线提交 3be0d7d
//（04-实施计划 §0；指令原文 HEAD: 在实施期与之等价——固定取基线快照防本批提交入库后自证自毁，
// 机制详见 direct-submit 重写版头注）旧源码写临时文件 scratch/c3-old-InteractionPrompt-*.vue
// 留痕，对 redOnOld 新钉断言至少一条 FAIL（输出留痕），随后对当前实现全绿。
//
// 运行：npx tsx scripts/tdd-interaction-prompt-enter-guard.ts（登记 scripts/selftest-static-list.txt:219）

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const optionListSrc = readFileSync(new URL('../src/renderer/components/chat/InteractionOptionList.vue', import.meta.url), 'utf8');

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

const ENTER_BRANCH_MARK = "event.key === 'Enter' && document.activeElement !== otherInput.value";
const SPACE_BRANCH_MARK = "event.key === ' ' && currentMultiSelect.value";
const TEXT_ENTRY_GUARD = 'if (isTextEntryTarget(event.target)) return;';

function handleKeydownBody(): string {
  const idx = src.indexOf('function handleKeydown(');
  assert.ok(idx > -1, '缺 handleKeydown');
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.ok(body.length > 0, 'handleKeydown 函数体切片失败');
  return body;
}

/** 切片某键分支：自分支条件起、至下一分支条件（endMark）或函数体末尾。 */
function branchBody(branchMark: string, endMark: string | null): string {
  const body = handleKeydownBody();
  const start = body.indexOf(branchMark);
  assert.ok(start > -1, `缺分支条件 ${branchMark}`);
  const end = endMark ? body.indexOf(endMark, start) : -1;
  return end > -1 ? body.slice(start, end) : body.slice(start);
}

/** 定位 handleKeydown 内 wizard 早退分支（if (isWizard.value) { … } 花括号配对）。 */
function findWizardBranch(body: string): { start: number; end: number } {
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
  return { start, end };
}

function wizardKeyBranch(): string {
  const body = handleKeydownBody();
  const { start, end } = findWizardBranch(body);
  return body.slice(start, end + 1);
}

function functionBody(name: string): string {
  const marker = `function ${name}(`;
  const idx = src.indexOf(marker);
  assert.ok(idx > -1, `缺 ${name}`);
  return src.slice(idx, src.indexOf('\n}', idx));
}

group('=== X1 保留面：遮挡让位/Enter/Space 让位骨架（R06-F1 逐字存活） ===');
check('X1 遮挡让位优先：isTopmost 守卫先于 Enter 分支（A9/B5 同源让位）', () => {
  const body = handleKeydownBody();
  const occlusionGuardIdx = body.indexOf('!escHandle.isTopmost()');
  const enterBranchIdx = body.indexOf(ENTER_BRANCH_MARK);
  assert.ok(occlusionGuardIdx > -1, '缺 isTopmost 遮挡让位守卫（B5 补修回归？）');
  assert.ok(occlusionGuardIdx < enterBranchIdx, '遮挡让位守卫必须先于 Enter 分支');
});
check('X1 Enter 分支：让位判定（button/summary）存在且先于 preventDefault；submit 兜底保留', () => {
  const body = branchBody(ENTER_BRANCH_MARK, "event.key === 'Escape'");
  const guardIdx = body.indexOf("closest('button, summary')");
  assert.ok(guardIdx > -1, "Enter 分支缺 closest('button, summary') 让位判定");
  const preventIdx = body.indexOf('event.preventDefault()');
  assert.ok(preventIdx > -1, 'Enter 分支缺 preventDefault（兜底路径被误删？）');
  assert.ok(guardIdx < preventIdx, '让位判定必须先于 preventDefault');
  assert.ok(body.indexOf('void submit()') > preventIdx, 'Enter 分支 submit 兜底仍在（非 wizard 让位之外路径不变）');
});
check('X1 Space 分支：让位判定存在且先于 preventDefault/toggleOption', () => {
  const body = branchBody(SPACE_BRANCH_MARK, null);
  const guardIdx = body.indexOf("closest('button, summary')");
  assert.ok(guardIdx > -1, "Space 分支缺让位判定");
  const preventIdx = body.indexOf('event.preventDefault()');
  assert.ok(preventIdx > -1, 'Space 分支缺 preventDefault');
  assert.ok(guardIdx < preventIdx, '让位判定必须先于 preventDefault');
  assert.ok(body.indexOf('toggleOption(') > preventIdx, 'Space 分支 toggleOption 兜底仍在');
});
check('X1 选项排除判别器 + dialogRef 范围限定（Enter/Space 两分支同款）', () => {
  for (const [name, body] of [['Enter', branchBody(ENTER_BRANCH_MARK, "event.key === 'Escape'")], ['Space', branchBody(SPACE_BRANCH_MARK, null)]] as const) {
    assert.match(body, /!target\.closest\('\.interaction-option'\)/, `${name} 分支缺选项排除`);
    assert.match(body, /dialogRef\.value\?\.contains\(target\)/, `${name} 分支缺 dialogRef 范围限定`);
  }
});
check('X1 分支条件未收窄：otherInput 排除与 currentMultiSelect 限定字面保留', () => {
  const body = handleKeydownBody();
  assert.ok(body.includes(ENTER_BRANCH_MARK), 'Enter 分支条件被改动');
  assert.ok(body.includes(SPACE_BRANCH_MARK), 'Space 分支条件被改动');
});
check('X1 让位目标在场：footer 取消/拒绝 ghost 钮+上一步钮（wizard 专用+死字面）+交互历史 <summary>', () => {
  assert.match(src, /<button type="button" class="interaction-btn interaction-btn--ghost" @click="cancel">/, 'footer 取消/拒绝 ghost 按钮须保留（非 wizard footer）');
  assert.match(src, /<button v-if="isWizard && wizardIndex > 0"[^>]*@click="previousQuestion">/, '上一步按钮死字面保留（enter-guard 既有契约）');
  assert.match(src, /<button type="button" class="interaction-btn interaction-btn--ghost" data-testid="wizard-prev-btn" :disabled="wizardIndex === 0" @click="previousQuestion">/, 'wizard footer 上一题钮须为真实 button @click="previousQuestion"');
  assert.match(src, /<summary>交互历史（\{\{ history\.length \}\}）<\/summary>/, '交互历史 summary 须保持原生可 toggle 形态');
});
check('X1 选项判别器有效：选项渲染为 <button class="interaction-option">（虚拟/非虚拟两形态）', () => {
  const matches = optionListSrc.match(/class="interaction-option"/g) ?? [];
  assert.ok(matches.length >= 2, `选项按钮应带 interaction-option class（虚拟+非虚拟 ≥2 处，实际 ${matches.length}）`);
  assert.match(optionListSrc, /<button[\s\S]{0,220}class="interaction-option"/, '选项元素应为 <button>');
});
check('previousQuestion 函数名契约保留：委托 jumpToQuestion(wizardIndex.value - 1)+体无 persist 调用+模板绑定', () => {
  const body = functionBody('previousQuestion');
  assert.ok(body.includes('jumpToQuestion(wizardIndex.value - 1)'), 'previousQuestion 须委托 jumpToQuestion(wizardIndex.value - 1)');
  assert.ok(!body.includes('persist'), 'previousQuestion 体不得含 persist 调用（翻页落账已废=草稿账本即答即写）');
  assert.match(src, /@click="previousQuestion"/, '模板 @click="previousQuestion" 绑定须保留');
});

group('=== 重写面：键序位次 + Esc 分域（C1 契约 6；C3-4-③ 输入焦点判定先于丢弃链） ===');
check('键序位次：Tab 分支（内含文本放行）→wizard 分流→非 wizard 文本早退→箭头分支（isTextEntryTarget 新位次）', () => {
  const body = handleKeydownBody();
  const { start: wizardIdx, end: wizardEnd } = findWizardBranch(body);
  const tabBranchIdx = body.indexOf("if (event.key === 'Tab') {");
  assert.ok(tabBranchIdx > -1 && tabBranchIdx < wizardIdx, 'Tab trap 分支须在 wizard 分流之前（wizard 亦困于模态）');
  const tabTextEntryIdx = body.indexOf(TEXT_ENTRY_GUARD, tabBranchIdx);
  assert.ok(tabTextEntryIdx > -1 && tabTextEntryIdx < wizardIdx, 'Tab 分支内文本输入放行缺失（wizard 输入框 Tab 维持浏览器默认）');
  const textEntryIdx = body.indexOf(TEXT_ENTRY_GUARD, wizardEnd);
  assert.ok(textEntryIdx > -1, '非 wizard 键链缺 isTextEntryTarget 早退（X1 语义迁移后仍须存活）');
  const arrowIdx = body.indexOf("if (event.key === 'ArrowDown') {");
  assert.ok(textEntryIdx < arrowIdx, '非 wizard 文本早退必须先于箭头分支（旧首行早退语义等价迁移）');
}, true);
check('Esc 分域：wizard 分支=confirm 层 dismiss→输入焦点 blur→requestDiscard（判定序）且先于非 wizard Escape', () => {
  const body = handleKeydownBody();
  const branch = wizardKeyBranch();
  const confirmIdx = branch.indexOf('discardConfirmVisible.value');
  const textEntryIdx = branch.indexOf('isTextEntryTarget(event.target)');
  const discardIdx = branch.indexOf('requestDiscard()');
  assert.ok(confirmIdx > -1 && textEntryIdx > -1 && discardIdx > -1, 'wizard Esc 分流三段残缺');
  assert.ok(confirmIdx < textEntryIdx && textEntryIdx < discardIdx, 'Esc 分域序违约（输入焦点判定须先于丢弃链）');
  assert.ok(branch.includes('dismissDiscard();') && branch.includes('.blur();'), '确认层 dismiss/输入 blur 分支缺失');
  const { end: wizardEnd } = findWizardBranch(body);
  const nonWizardEscIdx = body.indexOf("event.key === 'Escape'", wizardEnd);
  assert.ok(nonWizardEscIdx > -1, '非 wizard Escape 分支缺失（alert/取消语义面）');
}, true);
check('输入框内 Esc 不关整单：wizard-other 行内输入存在 + blur 分支先于 requestDiscard（有作答门由 requestDiscard 承担）', () => {
  const branch = wizardKeyBranch();
  const blurIdx = branch.indexOf('.blur();');
  const discardIdx = branch.indexOf('requestDiscard()');
  assert.ok(blurIdx > -1 && discardIdx > -1 && blurIdx < discardIdx, '输入焦点 Esc 须失焦（不关单），且先于丢弃链');
  assert.match(src, /@keydown\.enter\.prevent="\(\$event\.target as HTMLInputElement\)\.blur\(\)"/, 'wizard-other 输入 Enter=blur（确认该题=失焦，不提交整单）');
}, true);

group('=== 重写面：Enter 分域 + 方向键仅移焦（C1 契约 7/8；B5 兜底废卷留痕见头注） ===');
check('Enter 分域：wizard 分流吞掉 Enter（分支切片无 Enter 处理/无 submit 调用）——B5 focusedOption 兜底对 wizard 不可达（负向钉）', () => {
  const branch = wizardKeyBranch();
  assert.ok(!branch.includes("event.key === 'Enter'"), 'wizard 分支不得处理 Enter（契约 7：无 Enter 兜底）');
  assert.ok(!branch.includes('submit'), 'wizard 分支不得触发提交（B5 兜底对 wizard 不可达）');
  const body = handleKeydownBody();
  const { end: wizardEnd } = findWizardBranch(body);
  const enterIdx = body.indexOf(ENTER_BRANCH_MARK);
  assert.ok(enterIdx > wizardEnd, '非 wizard Enter 分支必须位于 wizard 分流之后（wizard 态 Enter 不可达兜底）');
}, true);
check('Other 内 Enter=确认该题文本：wizard-other @keydown.enter.prevent=blur 分支存在（03b C3-3② 正向面）+非 wizard otherInput 排除保留', () => {
  const body = handleKeydownBody();
  assert.ok(body.includes(ENTER_BRANCH_MARK), '非 wizard Enter 分支 otherInput 排除条件被改动');
  assert.match(src, /class="interaction-other wizard-other"/, 'wizard Other 行内输入区缺失');
  assert.match(src, /@input="onWizardOtherInput"/, 'Other 文本须 @input 即时落账（Enter 前已保全）');
}, true);
check('方向键仅移焦（契约 8）：非 wizard 箭头分支只 move()（无 toggleOption/submit）；wizard 态箭头被分流吞掉', () => {
  const body = handleKeydownBody();
  const arrowStart = body.indexOf("if (event.key === 'ArrowDown') {");
  const enterIdx = body.indexOf(ENTER_BRANCH_MARK);
  assert.ok(arrowStart > -1 && enterIdx > arrowStart, '箭头分支切片前置结构残缺');
  const arrowSlice = body.slice(arrowStart, enterIdx);
  assert.ok(arrowSlice.includes('move(1)') && arrowSlice.includes('move(-1)'), '箭头分支须 move() 移焦');
  assert.ok(!arrowSlice.includes('toggleOption') && !arrowSlice.includes('submit('), '箭头分支不得改写选中/提交（浏览即改写回归面）');
  const branch = wizardKeyBranch();
  assert.ok(!branch.includes('ArrowDown') && !branch.includes('ArrowUp'), 'wizard 态箭头须被分流吞掉（交还原生滚动，不 move）');
}, true);

group('=== P3-4 补钉：Space 分域——激活键非浏览键（C1.8 治理方向键浏览；03b C1-10③ 口径修正 2026-11-19） ===');
check('Space 分域·单选态零拦截：handleKeydown 内 Space 字面仅 2 处（遮挡让位守卫 + currentMultiSelect 限定分支）——单选态不进任何 Space 分支=无 preventDefault=原生 button 激活（等同点击作答）', () => {
  const body = handleKeydownBody();
  const marks: number[] = [];
  let cursor = 0;
  for (;;) {
    const idx = body.indexOf("event.key === ' '", cursor);
    if (idx === -1) break;
    marks.push(idx);
    cursor = idx + 1;
  }
  assert.equal(marks.length, 2, `handleKeydown 内 Space 字面应为 2 处（遮挡让位 + 多选分支），实际 ${marks.length}——新增非多选 Space 处理须先过 C1.8 分域口径（激活键≠浏览键）`);
  const lineStart = body.lastIndexOf('\n', marks[1]) + 1;
  const branchLine = body.slice(lineStart, body.indexOf('\n', marks[1]));
  assert.ok(branchLine.includes('currentMultiSelect.value'), 'Space 处理分支必须以 currentMultiSelect 限定（单选态不接管，保留原生激活=作答路径）');
});
check('Space 分域·多选态=toggle：分支 preventDefault 后 toggleOption(focusedOption)（选项钮聚焦不让位）；toggleOption 多选分支=Set 增删（toggle 非覆写）', () => {
  const body = branchBody(SPACE_BRANCH_MARK, null);
  const preventIdx = body.indexOf('event.preventDefault()');
  const focusIdx = body.indexOf('focusedOption.value');
  const toggleIdx = body.indexOf('toggleOption(');
  assert.ok(preventIdx > -1 && focusIdx > preventIdx && toggleIdx > focusIdx, '多选 Space 须 preventDefault 后取聚焦选项再 toggleOption=toggle 语义');
  const fnBody = functionBody('toggleOption');
  const multiIdx = fnBody.indexOf('if (currentMultiSelect.value) {');
  assert.ok(multiIdx > -1, 'toggleOption 缺多选分支');
  const multiSlice = fnBody.slice(multiIdx, fnBody.indexOf('return;', multiIdx));
  assert.ok(multiSlice.includes('next.has(optionId)') && multiSlice.includes('next.add(optionId)'), '多选 toggle 必须是 Set 增删（has→delete / else→add），不得覆写选中集');
});
check('Space 分域·激活生效前提：选项钮为原生 <button type="button"> 且 @click=toggle emit、无 @keydown 劫持（Space 原生激活走 click=作答入口）', () => {
  const tags = [...optionListSrc.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(tags.length >= 2, `选项 button 开标签应 ≥2（虚拟+非虚拟两形态），实际 ${tags.length}`);
  for (const tag of tags) {
    assert.ok(tag.includes('type="button"'), '选项钮必须 type="button"（原生激活语义前提）');
    assert.ok(tag.includes('@click="emit(\'toggle\''), '选项钮 @click 须绑 toggle emit（Space 激活=click=作答入口）');
    assert.ok(!tag.includes('@keydown'), '选项钮不得有 @keydown 劫持（吞原生激活=单选 Space 作答失效）');
  }
});
check('Space 分域·wizard 态同口径：Space 被分流吞掉（wizard 分支无 Space 字面）交还原生激活（与 Enter 域一致）', () => {
  const branch = wizardKeyBranch();
  assert.ok(!branch.includes("event.key === ' '"), 'wizard 分支不得处理 Space（交还选项钮/左栏项浏览器原生激活，等同点击）');
});

// ── 「对旧实现必红」自证（C3-3 期望条款；机制见头注）──
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
    writeFileSync(new URL('c3-old-InteractionPrompt-enter-guard.vue', scratchDirUrl), old, 'utf8');
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
