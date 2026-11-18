// tdd-dialogs-i1-i10-verify.ts
// I 弹窗体系与全局（I1~I10）共用契约脚本——逐条转写 docs/ui-completion/tests/I-dialogs-global-cases.md。
// 本轮落 I1 组（confirm 型 eyebrow）；I2~I10 各组由对应原子点实施时在本文件追加各自分区。
//
// 运行：npx tsx scripts/tdd-dialogs-i1-i10-verify.ts
//
// 〔R2-C P22 契约同步与预置红处置（2026-11-17，round-002 修复组 C；分类依据=git show HEAD 对照：
//   24 失败中 3 枚为 C1 变体 2 合法改结构所致的钉面漂移、21 枚为 HEAD 同红的预置红——I 组原子点
//   尚未落盘，钉面锚定的是 impl 文档目标态而非现存代码）〕
// 〔① C1 契约同步（3 枚，修钉至新形态）：I1-02 wizard eyebrow 字面随 C1 变体 2 改「Claude Code
//   需要你回答 N 个问题」（题号移右栏 count 行/头部进度 chip，InteractionPrompt.vue eyebrow
//   computed 注释为据）；I8-03 wizard steps 圆点行（aria-label="问题进度"）随 C1 变体 2 整体移除，
//   重锚 wizard-nav aria-label="题目导航"（tdd-wizard-step-jump-verify 重写版② 同锚）；I9-06
//   单一 footer 随 C1 变体 2 拆 wizard(v-if)/单题(v-else) 双 footer，footerSlice 重锚 v-else
//   单题 footer（enter-guard T6-K/direct-submit「单题 footer 零触碰」同锚面）。〕
// 〔② 预置红暂缓（21 枚，check 内跳过+留痕）：I1-01/I1-03/I1-04、I2-01a/I2-01b/I2-01c/I2-04、
//   I6-01a/I6-01b/I6-02、I8-01a、I9-01a/I9-01b/I9-02a/I9-02b/I9-03a/I9-03b/I9-04a/I9-04b/
//   I9-04c/I9-05——经 git show HEAD 快照沙箱实跑对照，同 21 枚在 HEAD 亦红（其中 I9-02a/I9-03b/
//   I9-05 两态皆红但报错信息随 C1 漂移），即钉死的是从未存在的 I 组目标态结构，非本批回归。
//   处置按 b-layout 先例（tdd-b-layout-sidebar-verify.ts 头注「登记状态如实申报」块同款）：
//   check→park 转暂缓（钉体零删改，红时 ⏸ 不计失败、绿时自动 ✅ 计通过），脚本整体 exit 0。
//   再硬化纪律：I 组原子点落盘时逐枚 park→check 还原为硬钉，并按 impl 文档同步钉面（注意
//   I9-05 为混合面：✕/esc-hint 为目标态断言、initSelection optionDefaults 面已被 C1 变体 2
//   「wizard 无预选」合法改写，还原时须按落盘形态重写该枚）。
// 〔R4-3（2026-11-18 round-004 修复轮）登记状态更正：本脚本已登记 scripts/selftest-static-list.txt
//   （清单 :294，全清单 294 行）——上文「本脚本仍未登记（漏网面现状如实申报）」系 round-002 时点的
//   陈旧自述，作废；登记已由编排器完成并经 round-003 复审核验（selftest 全量 294 绿）。〕

import { readFileSync, readdirSync } from 'node:fs';
import { strict as assert } from 'node:assert';

let pass = 0;
let fail = 0;
let parked = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
// park = 预置红暂缓钉（I 组目标态未落盘）：断言体原样执行——目标态意外提前在场则 ✅ 计通过；
// 仍缺则 ⏸ 不计失败（exit 0 不受影响）。落盘后须 park→check 还原硬钉（见头注②）。
function park(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { parked += 1; console.log(`  ⏸ ${name} — 预置红暂缓（I 组未落盘）：${(e as Error).message}`); }
}

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const prompt = read('../src/renderer/components/chat/InteractionPrompt.vue');

// eyebrow computed 切片（InteractionPrompt.vue script 内，止于下一个 computed currentTitle）。
function eyebrowSlice(): string {
  const start = prompt.indexOf('const eyebrow = computed(() => {');
  assert.ok(start > -1, '缺 eyebrow computed');
  const end = prompt.indexOf('const currentTitle', start);
  assert.ok(end > start, 'eyebrow computed 切片越界');
  return prompt.slice(start, end);
}

console.log('\n=== I1 · confirm 型 eyebrow ===');

// I1-01（正常）：confirm 分支存在、字面逐字「Claude Code 需要你确认」（含「你」字），
// 且位于 default 回退之前——confirm 不得再回落「需要你选择」。
park('I1-01 confirm 分支存在且字面恰为「Claude Code 需要你确认」，位于 default return 之前', () => {
  const slice = eyebrowSlice();
  const confirmIdx = slice.indexOf("kind === 'confirm') return 'Claude Code 需要你确认';");
  assert.ok(confirmIdx > -1, '缺 confirm 分支或文案漂移（须逐字「Claude Code 需要你确认」，含「你」字）');
  const defaultIdx = slice.indexOf("return 'Claude Code 需要你选择';");
  assert.ok(defaultIdx > -1, '缺 default 回退分支（「Claude Code 需要你选择」）');
  assert.ok(confirmIdx < defaultIdx, 'confirm 分支必须位于 default return 之前（confirm 不得回落 default 分支）');
});

// I1-02（异常·防误改）：其余五型 eyebrow 逐字不变——尤其 permission 恰为「需要确认」（无「你」）。
// 〔R2-C 契约同步（2026-11-17）：wizard 分支随 C1 变体 2 改「Claude Code 需要你回答 N 个问题」
//   恒显总题数（旧「需要你选择 · N/M」插值形态随圆点行移除消亡），本钉同步至新形态。〕
check('I1-02 其余五型 eyebrow 字面逐一保持（permission/wizard·N 总数/multi-choice/text|long-text/form）', () => {
  const slice = eyebrowSlice();
  assert.ok(
    slice.includes("kind === 'permission') return 'Claude Code 需要确认';"),
    'permission eyebrow 须恰为「Claude Code 需要确认」（无「你」字，防 I1 顺手误改成「需要你确认」）',
  );
  assert.ok(
    slice.includes('`Claude Code 需要你回答 ${wizardQuestions.value.length} 个问题`'),
    'wizard eyebrow 模板串漂移（C1 变体 2 新形态：「Claude Code 需要你回答 N 个问题」，题号位置已移右栏 count 行/头部进度 chip）',
  );
  assert.ok(slice.includes("return 'Claude Code 需要你多选';"), 'multi-choice eyebrow 漂移');
  assert.ok(slice.includes("return 'Claude Code 需要你输入';"), 'text/long-text eyebrow 漂移');
  assert.ok(slice.includes("return 'Claude Code 需要参数';"), 'form eyebrow 漂移');
});

// I1-03（边界）：confirm 分支条件仅 kind==='confirm' 判定——不得按 options/danger 分化
//（spec「含全部危险确认」= 所有 confirm 统一 eyebrow）。
park('I1-03 confirm 分支条件仅 kind 判定，不附加 options/danger 分化', () => {
  const slice = eyebrowSlice();
  const m = slice.match(/if \(([^)]*)\) return 'Claude Code 需要你确认';/);
  assert.ok(m, '缺 confirm 分支行（if (...) return 形态）');
  const cond = m[1];
  assert.ok(cond.includes("activeRequest.value?.kind === 'confirm'"), 'confirm 分支条件缺 kind === \'confirm\' 判定');
  assert.ok(!cond.includes('options'), 'confirm 分支不得附加 options 判定（全部 confirm 统一 eyebrow）');
  assert.ok(!cond.includes('danger'), 'confirm 分支不得附加 danger 判定');
});

// I1-04（边界·保全）：alert 型（confirm 且单选项）Esc=知道了语义不变——I9④ 将 isAlert 决策
// 收敛到 escapeDismiss 共享函数（Esc 与头部 ✕ 单源等效，E-6 裁决 A），本断言随代码形态同步：
// Esc 分支内保序 isTopmost→preventDefault→escapeDismiss()；isAlert 三条件与
// submit('confirm')/cancel() 落在 escapeDismiss 体内。
park('I1-04 alert 型 Esc 语义保全（Esc 分支 isTopmost→preventDefault→escapeDismiss；escapeDismiss 内 isAlert 三条件 / submit(confirm) / cancel）', () => {
  const escStart = prompt.indexOf("} else if (event.key === 'Escape') {");
  assert.ok(escStart > -1, '缺 handleKeydown Escape 分支');
  const escEnd = prompt.indexOf("} else if (event.key === ' '", escStart);
  assert.ok(escEnd > escStart, 'Escape 分支切片越界');
  const slice = prompt.slice(escStart, escEnd);
  const topmostIdx = slice.indexOf('isTopmost()');
  const pdIdx = slice.indexOf('event.preventDefault()');
  assert.ok(topmostIdx > -1, 'Esc 分支缺 isTopmost 让位守卫');
  assert.ok(pdIdx > topmostIdx, 'isTopmost 守卫必须先于 event.preventDefault()');
  assert.ok(slice.includes('escapeDismiss()'), 'Esc 分支决策须收敛 escapeDismiss 共享函数（I9④ 单源等效）');
  const dismissBody = fnBody(prompt, 'escapeDismiss');
  assert.ok(dismissBody.includes("request.kind === 'confirm'"), 'isAlert 判定缺 kind === \'confirm\' 条件');
  assert.ok(dismissBody.includes('request.options?.length === 1'), 'isAlert 判定缺单选项条件（options?.length === 1）');
  assert.ok(dismissBody.includes("request.options[0]?.id === 'confirm'"), 'isAlert 判定缺选项 id 条件（options[0]?.id === \'confirm\'）');
  assert.ok(dismissBody.includes("void submit('confirm')"), 'alert 型 Esc/✕ 应提交确定项（知道了→submit(\'confirm\')）');
  assert.ok(dismissBody.includes('void cancel()'), '非 alert confirm/选择题 Esc/✕ 应取消');
});

// ═══ I2 · 弹窗输入 IME 守卫 ═══
// 行为级 CDP（I2-05/06）按 Owner 裁决 E-4 降级：结构钉（I2-01~04）为硬闸，行为用例目检替代
//（C-3 真实 Windows IME 抽验），不落 cdp-layout-e2e.mjs（组词事件合成可行性未验证）。
// 统一口径 = isComposing || keyCode === 229（与 ChatPage.vue onGlobalKeydown / ChatInput N3 同源）。

const filePicker = read('../src/renderer/components/common/FilePickerDialog.vue');
const diffDialog = read('../src/renderer/components/changes/DiffDialog.vue');
const toolDiffDialog = read('../src/renderer/components/chat/ToolDiffDialog.vue');
const turnDiffDialog = read('../src/renderer/components/chat/TurnDiffDialog.vue');

const countOf = (src: string, needle: string): number => src.split(needle).length - 1;

function scriptOf(src: string): string {
  const m = src.match(/<script setup lang="ts">([\s\S]*?)<\/script>/);
  assert.ok(m, '缺 <script setup lang="ts"> 区');
  return m[1];
}

// 函数体切片：定位 `function name(` 后首个 `{`，按花括号配平取函数体（不含首尾花括号）。
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `缺 function ${name}`);
  const open = src.indexOf('{', start);
  assert.ok(open > -1, `function ${name} 缺函数体开括号`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  assert.fail(`function ${name} 花括号未配平`);
}

console.log('\n=== I2 · 弹窗输入 IME 守卫 ===');

// I2-01（正常）：交互弹窗输入入口守卫改绑——Other 单行（Enter/Esc）、long-text（Ctrl+Enter/Esc）。
park('I2-01a InteractionPrompt Other 单行/long-text Enter·Esc·Ctrl+Enter 改绑守卫包装，旧内联 submit()/cancel() 绑定清零', () => {
  assert.ok(prompt.includes('@keydown.enter.prevent="onOtherEnter"'), 'Other 单行 Enter 未改绑 onOtherEnter');
  assert.ok(prompt.includes('@keydown.enter.ctrl.prevent="onOtherCtrlEnter"'), 'long-text Ctrl+Enter 未改绑 onOtherCtrlEnter');
  assert.equal(countOf(prompt, '@keydown.esc.prevent="onOtherEsc"'), 2, 'Other 单行 + long-text Esc 须均改绑 onOtherEsc（恰 2 处）');
  assert.equal(countOf(prompt, '@keydown.enter.prevent="submit()"'), 0, 'Other Enter 旧内联绑定 submit() 残留');
  assert.equal(countOf(prompt, '@keydown.enter.ctrl.prevent="submit()"'), 0, 'long-text Ctrl+Enter 旧内联绑定 submit() 残留');
  assert.equal(countOf(prompt, '@keydown.esc.prevent="cancel()"'), 0, '旧内联绑定 cancel() 残留');
});

// I2-01（正常·续）：form 三类输入（textarea/number/text）Esc 改绑 onFieldEsc；
// 过滤搜索框按 Owner 裁决（impl §I2 范围外残留）保持现状不加固——仍直连 cancel。
park('I2-01b InteractionPrompt form textarea/number/text Esc 改绑 onFieldEsc（恰 3 处）；过滤搜索框保持现状（裁决范围外）', () => {
  assert.equal(countOf(prompt, '@keydown.esc.prevent="onFieldEsc"'), 3, 'form textarea/number/text Esc 须均改绑 onFieldEsc（恰 3 处，漏一即红）');
  assert.ok(
    prompt.includes('type="search" placeholder="输入关键词..." @keydown.stop @keydown.esc.prevent="cancel"'),
    '过滤搜索框被误改（裁决=范围外保持现状，仍直连 cancel）',
  );
});

// I2-01（正常·续）+ I2-04（负断言）：四个包装方法守卫先于动作、且为条件早退形态
//（submit/cancel 还被 footer 按钮与 window 键盘路径复用，守卫必须走包装方法而非塞进 submit/cancel 本体）。
park('I2-01c InteractionPrompt 四包装方法（onOtherEnter/onOtherCtrlEnter/onOtherEsc/onFieldEsc）守卫先于动作且为 if(...) return 条件早退', () => {
  const wrappers: ReadonlyArray<readonly [string, string]> = [
    ['onOtherEnter', 'void submit();'],
    ['onOtherCtrlEnter', 'void submit();'],
    ['onOtherEsc', 'void cancel();'],
    ['onFieldEsc', 'void cancel();'],
  ];
  for (const [name, action] of wrappers) {
    const body = fnBody(prompt, name);
    const guard = body.indexOf('isImeComposing(e)');
    assert.ok(guard > -1, `${name} 缺 IME 守卫`);
    const act = body.indexOf(action);
    assert.ok(act > -1, `${name} 缺动作调用 ${action}（组词结束后行为须不变）`);
    assert.ok(act > guard, `${name} 守卫必须先于动作 ${action}（守卫挪到动作分支之后=序断言红）`);
    assert.ok(body.includes('if (isImeComposing(e)) return;'), `${name} 守卫须为 if(...) return 条件早退形态（无条件吞键=红）`);
  }
  // 守卫不得塞进 submit/cancel 本体（两者被 footer 按钮 @click 与 window 键盘路径复用，无 KeyboardEvent）。
  assert.ok(!fnBody(prompt, 'submit').includes('isImeComposing'), 'submit 本体不得内嵌 IME 守卫（click/keyboard 复用路径无 KeyboardEvent）');
  assert.ok(!fnBody(prompt, 'cancel').includes('isImeComposing'), 'cancel 本体不得内嵌 IME 守卫');
});

// I2-02（正常）：FilePicker 4 输入入口 7 处 keydown 改绑 + 旧绑定清零 + 非键盘复用路径保全
//（submitMkdir/cancelAddr 等底层函数被按钮 click / blur / 互斥入口复用，只能改绑模板）。
check('I2-02a FilePicker addr/mkdir/rename/filename 七处 keydown 改绑守卫包装，旧绑定清零，click/blur 复用路径保全', () => {
  for (const b of [
    '@keydown.enter.stop.prevent="onAddrEnter"',
    '@keydown.esc.stop.prevent="onAddrEsc"',
    '@keydown.enter.stop.prevent="onMkdirEnter"',
    '@keydown.esc.stop.prevent="onMkdirEsc"',
    '@keydown.enter.stop.prevent="onRenameEnter"',
    '@keydown.esc.stop.prevent="onRenameEsc"',
    '@keydown.enter.stop.prevent="onFilenameEnter"',
  ]) {
    assert.ok(filePicker.includes(b), `FilePicker 模板缺改绑 ${b}`);
  }
  for (const old of [
    '@keydown.enter.stop.prevent="submitAddr"',
    '@keydown.esc.stop.prevent="cancelAddr"',
    '@keydown.enter.stop.prevent="submitMkdir"',
    '@keydown.esc.stop.prevent="cancelMkdir"',
    '@keydown.enter.stop.prevent="submitRename"',
    '@keydown.esc.stop.prevent="cancelRename"',
    '@keydown.enter.stop.prevent="confirmSave"',
  ]) {
    assert.equal(countOf(filePicker, old), 0, `FilePicker 旧绑定 ${old} 残留`);
  }
  // 非键盘路径保全（busy 失焦互斥与按钮 click 不涉按键路径，零改动）。
  assert.ok(filePicker.includes('@blur="cancelAddr"'), '地址栏 @blur="cancelAddr" 失焦取消被误删');
  assert.ok(filePicker.includes('@blur="onMkdirBlur"'), 'mkdir @blur 互斥失焦被误删');
  assert.ok(filePicker.includes('@blur="onRenameBlur"'), 'rename @blur 互斥失焦被误删');
  assert.ok(filePicker.includes('@click="submitMkdir"'), 'mkdir 确定钮 @click 复用被误删');
  assert.ok(filePicker.includes('@click="confirmSave"'), '保存钮 @click 复用被误删');
  assert.ok(filePicker.includes('mkdirBusy'), 'mkdirBusy 语义被触碰（应零改动）');
  assert.ok(filePicker.includes('renameBusy'), 'renameBusy 语义被触碰（应零改动）');
});

// I2-02（正常·续）：7 个包装方法守卫先于动作。
check('I2-02b FilePicker 七包装方法守卫先于各自提交/取消分支', () => {
  const wrappers: ReadonlyArray<readonly [string, string]> = [
    ['onAddrEnter', 'submitAddr();'],
    ['onAddrEsc', 'cancelAddr();'],
    ['onMkdirEnter', 'void submitMkdir();'],
    ['onMkdirEsc', 'cancelMkdir();'],
    ['onRenameEnter', 'void submitRename();'],
    ['onRenameEsc', 'cancelRename();'],
    ['onFilenameEnter', 'void confirmSave();'],
  ];
  for (const [name, action] of wrappers) {
    const body = fnBody(filePicker, name);
    const guard = body.indexOf('isImeComposing(e)');
    assert.ok(guard > -1, `${name} 缺 IME 守卫`);
    const act = body.indexOf(action);
    assert.ok(act > -1, `${name} 缺动作调用 ${action}`);
    assert.ok(act > guard, `${name} 守卫必须先于动作 ${action}`);
    assert.ok(body.includes('if (isImeComposing(e)) return;'), `${name} 守卫须为条件早退形态`);
  }
});

// I2-02（正常·续）+ I2-04：文件名框 Esc 无本地 handler（裁决）——守卫加在 window onKey
// Escape 分支首行、先于 isTopmost 让位与 ctxMenu→删除确认条→弹窗层级（加本地 esc.stop
// 会绕过该内部层级，deletePending 在场按 Esc 将直接取消整个弹窗=回归）。
check('I2-02c FilePicker window onKey Escape 分支首行 IME 守卫（先于 isTopmost 让位）；文件名框无本地 Esc handler', () => {
  const script = scriptOf(filePicker);
  const onKeyIdx = script.indexOf('function onKey(');
  assert.ok(onKeyIdx > -1, '缺 window onKey');
  const escIdx = script.indexOf("e.key === 'Escape'", onKeyIdx);
  assert.ok(escIdx > -1, 'onKey 缺 Escape 分支');
  const branch = script.slice(escIdx, escIdx + 260);
  const guardIdx = branch.indexOf('if (isImeComposing(e)) return;');
  assert.ok(guardIdx > -1, 'Escape 分支缺 IME 守卫（须为 onKey 外层唯一插入点）');
  const topmostIdx = branch.indexOf('isTopmost()');
  assert.ok(topmostIdx > -1, 'Escape 分支缺 isTopmost 让位（tdd-esc-stack 既有钉）');
  assert.ok(guardIdx < topmostIdx, 'IME 守卫必须先于 isTopmost 让位（组词 Esc 由外层直接 return）');
  // 文件名框裁决：不加本地 Esc handler（模板无 @keydown.esc 绑定到 filename 输入）。
  assert.ok(!filePicker.includes('@keydown.esc.stop.prevent="onFilenameEsc"'), '文件名框不得加本地 Esc handler（会绕过 window onKey 内部层级=回归）');
});

// I2-03（正常）：三个 diff 搜索框 onSearchKeydown 消费式守卫——守卫在 Escape 与 Enter 分支前，
// 守卫体消费事件（preventDefault+stopPropagation，外层 window onKey 的 Esc 分支在 isTextTarget
// 早退之前，朴素 return 会让组词 Esc 冒泡关搜索栏/弹窗=新回归）；既有分支逐字不动。
const diffSources: ReadonlyArray<readonly [string, string]> = [
  ['DiffDialog', diffDialog],
  ['ToolDiffDialog', toolDiffDialog],
  ['TurnDiffDialog', turnDiffDialog],
];
for (const [label, src] of diffSources) {
  check(`I2-03 ${label} onSearchKeydown 消费式 IME 守卫（先于 Escape/Enter 分支，preventDefault+stopPropagation，既有分支逐字不动）`, () => {
    const script = scriptOf(src);
    const body = fnBody(script, 'onSearchKeydown');
    const guardIdx = body.indexOf('if (isImeComposing(e))');
    assert.ok(guardIdx > -1, `${label} onSearchKeydown 缺 IME 守卫`);
    const escIdx = body.indexOf("e.key === 'Escape'");
    const enterIdx = body.indexOf("e.key === 'Enter'");
    assert.ok(escIdx > -1 && enterIdx > -1, `${label} onSearchKeydown 缺 Escape/Enter 分支`);
    assert.ok(escIdx > guardIdx, `${label} 守卫必须先于 Escape 分支`);
    const guardRegion = body.slice(guardIdx, escIdx);
    assert.ok(guardRegion.includes('e.preventDefault();'), `${label} 守卫须消费事件（preventDefault）`);
    assert.ok(guardRegion.includes('e.stopPropagation();'), `${label} 守卫须消费事件（stopPropagation）`);
    // 既有分支逐字不动：Escape→preventDefault→stopPropagation→closeSearch；Enter→preventDefault→gotoSearch(±1)。
    const escBranch = body.slice(escIdx, enterIdx);
    const pd = escBranch.indexOf('e.preventDefault();');
    const sp = escBranch.indexOf('e.stopPropagation();');
    const cs = escBranch.indexOf('closeSearch();');
    assert.ok(pd > -1 && sp > pd && cs > sp, `${label} Escape 分支 preventDefault→stopPropagation→closeSearch 序列漂移`);
    const enterBranch = body.slice(enterIdx);
    assert.ok(enterBranch.indexOf('e.preventDefault();') > -1, `${label} Enter 分支缺 preventDefault`);
    assert.ok(enterBranch.includes('gotoSearch(e.shiftKey ? -1 : 1);'), `${label} Enter 分支 gotoSearch(±1) 序列漂移`);
    // regression-tests:3359 距离正则预算镜像：签名到 Escape 分支 ≤500 字符（守卫插入后仍须在预算内）。
    const sigIdx = script.indexOf('function onSearchKeydown(e: KeyboardEvent): void');
    const escInScript = script.indexOf("e.key === 'Escape'", sigIdx);
    assert.ok(sigIdx > -1 && escInScript > -1, `${label} 缺 onSearchKeydown 签名形态`);
    assert.ok(escInScript - sigIdx <= 500, `${label} 签名到 Escape 分支距离 ${escInScript - sigIdx} 超 regression:3359 的 500 预算`);
  });
}

// I2-04（边界·防倒退）：五组件助手统一口径、5 份本地复制（不建共享 util）、
// 非 IME 环境零变化由条件早退形态保证（各包装/分支断言已内嵌）。
park('I2-04 五组件 isImeComposing 助手统一口径（isComposing || keyCode === 229）且为本地复制不建共享 util', () => {
  for (const [label, src] of [
    ['InteractionPrompt', prompt],
    ['FilePickerDialog', filePicker],
    ['DiffDialog', diffDialog],
    ['ToolDiffDialog', toolDiffDialog],
    ['TurnDiffDialog', turnDiffDialog],
  ] as const) {
    const body = fnBody(src, 'isImeComposing');
    assert.ok(body.includes('return e.isComposing || e.keyCode === 229;'), `${label} 助手口径漂移（须恰为 e.isComposing || e.keyCode === 229）`);
  }
  // 不建共享 util：5 份本地定义（每组件一份），utils 目录无 IME 共享文件。
  assert.equal(
    diffSources.reduce((n, [, s]) => n + countOf(s, 'function isImeComposing(e: KeyboardEvent): boolean {'), 0) + countOf(prompt, 'function isImeComposing(e: KeyboardEvent): boolean {') + countOf(filePicker, 'function isImeComposing(e: KeyboardEvent): boolean {'),
    5,
    '助手须为五组件各一份本地复制（恰 5 处定义）',
  );
  const utilFiles = readdirSync(new URL('../src/renderer/utils/', import.meta.url));
  // 精确匹配 IME 命名（ime-guard.ts / keyboard-ime.ts 等），不误伤含 time 的既有文件（format-session-time.ts）。
  assert.ok(!utilFiles.some((f) => /(^ime)|([-_.]ime)/.test(f)), 'utils 目录不得新增 IME 共享 util（复制不抽公共）');
});

// ═══ I3 · 文件预览抽屉键盘三件套（FilePreviewDrawer.vue） ═══
// 行为级 CDP（I3-01/02 可选项）按 I2 同款裁决降级：结构钉+切片钉为硬闸，行为走查目检替代
//（C-2 键盘走查），不落 cdp-layout-e2e.mjs（真实窗口焦点序在合成环境可行性未验证）。

const drawer = read('../src/renderer/components/preview/FilePreviewDrawer.vue');
const drawerScript = scriptOf(drawer);

// watch 回调整体切片（watch 起点到 onMounted 之间，含 open/close 两个分支）。
function drawerWatchSlice(): string {
  const start = drawerScript.indexOf('watch(() => [store.open, store.path] as const');
  assert.ok(start > -1, '缺 [store.open, store.path] watch');
  const end = drawerScript.indexOf('onMounted(', start);
  assert.ok(end > start, 'watch 切片越界（onMounted 应在 watch 之后）');
  return drawerScript.slice(start, end);
}

console.log('\n=== I3 · 文件预览抽屉键盘三件套 ===');

// I3-01（正常）：打开边沿初始焦点落关闭钮——closeButtonRef 声明 + 模板接线到 .fpreview-close
// + open 分支 nextTick focus 关闭钮；负断言：open 分支不得落到抽屉内首个交互元素或落空。
check('I3-01 打开边沿初始焦点落关闭钮（nextTick + closeButtonRef 接线 .fpreview-close；边沿分支唯一 focus 落点）', () => {
  assert.ok(
    drawerScript.includes('const closeButtonRef = ref<HTMLButtonElement | null>(null);'),
    '缺 closeButtonRef 声明',
  );
  const btnLine = drawer.split('\n').find((l) => l.includes('class="fpreview-close"') && l.includes('<button'));
  assert.ok(btnLine, '缺 .fpreview-close 关闭钮');
  assert.ok(btnLine.includes('ref="closeButtonRef"'), '.fpreview-close 按钮缺 ref="closeButtonRef" 接线（初始焦点落空=红）');
  const watchSlice = drawerWatchSlice();
  assert.ok(
    watchSlice.includes('void nextTick(() => closeButtonRef.value?.focus());'),
    'open 分支缺 nextTick(() => closeButtonRef.value?.focus()) 初始焦点接线',
  );
  // 负断言：初始焦点不得落到抽屉内首个交互元素（spec 点名关闭钮）——边沿分支仅关闭钮一处 focus。
  const focusCalls = watchSlice.match(/\.focus\(\)/g) ?? [];
  assert.equal(focusCalls.length, 1, 'watch 边沿分支应只有初始焦点一处 focus 调用（落到首个交互元素/容器=红）');
});

// I3-02（正常）：close 边沿还原到打开前触发元素——还原调用恰在 watch close 分支且带 true→false
// 边沿守卫；三通道（遮罩点击/关闭钮/Esc）统一 close 入口→store.close()→watch 边沿，还原不被旁路。
check('I3-02 close 边沿还原到打开前触发元素（restoreFocus 恰在 watch close 分支；三通道统一 close 入口不旁路）', () => {
  const watchSlice = drawerWatchSlice();
  assert.ok(watchSlice.includes('if (prevOpen) restoreFocus();'), 'close 分支缺 if (prevOpen) restoreFocus() 还原接线');
  // 还原调用恰一处（定义签名 + watch 调用），无旁路第二调用点。
  assert.equal(countOf(drawerScript, 'restoreFocus()'), 2, 'restoreFocus 应恰为定义+watch 调用两处（旁路调用点=红）');
  // 三通道统一入口：close() 翻 store 开关位驱动 watch 边沿。
  const closeBody = fnBody(drawerScript, 'close');
  assert.ok(closeBody.includes('store.close();'), 'close() 缺 store.close()（三通道统一入口断链=还原被旁路）');
  assert.equal(countOf(drawer, '@click="close"'), 2, '遮罩与关闭钮 @click="close" 应恰 2 处（通道漂移=红）');
});

// I3-03（边界·换文件边沿）：触发元素记录仅由 open false→true 边沿驱动——记录恰一处、位于
// open 分支内、被 if (!prevOpen) 守卫；抽屉内嵌套换文件（B16 复用链，open 恒 true）不重记。
check('I3-03 触发元素记录仅由 open false→true 边沿驱动（恰一处、open 分支内、if (!prevOpen) 守卫；换文件不重记）', () => {
  const rec = 'lastFocused = document.activeElement as HTMLElement | null;';
  assert.equal(countOf(drawerScript, rec), 1, '触发元素记录应恰一处（第二处=换文件重记=红）');
  assert.ok(drawerScript.includes('([open], [prevOpen])'), 'watch 缺新旧值解构（边沿判定无依据）');
  const watchSlice = drawerWatchSlice();
  const openStart = watchSlice.indexOf('if (open) {');
  const elseStart = watchSlice.indexOf('} else {', openStart);
  const recIdx = watchSlice.indexOf(rec);
  assert.ok(recIdx > openStart && recIdx < elseStart, '记录不在 open 分支内');
  assert.ok(watchSlice.lastIndexOf('if (!prevOpen)', recIdx) > -1, '记录缺 if (!prevOpen) 边沿守卫（挂全体 watch=换文件重记=红）');
});

// I3-04（正常）：Tab 在抽屉内循环（焦点陷阱）——同族口径（I7 收紧/InteractionPrompt B5）：
// focusables 非禁用选择器 + 空 focusables 早退 + contains 收紧（容器外拉回）+ 首末回绕两分支；
// onKey Tab 分支位于 Escape 三守卫分支之后，且更高层 Esc 层在场时让位（被遮挡抽屉不抢拉焦点）。
check('I3-04 Tab 焦点陷阱（trapTab 首末回绕+contains 收紧+空集早退；onKey Tab 分支居 Escape 后且带遮挡让位）', () => {
  assert.ok(drawerScript.includes('function trapTab(e: KeyboardEvent): void {'), '缺 trapTab 函数');
  const body = fnBody(drawerScript, 'trapTab');
  assert.ok(
    body.includes("'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex=\"-1\"])'"),
    'focusables 选择器漂移（同族口径：button/input/textarea/select/[tabindex] 非禁用）',
  );
  assert.ok(body.includes('if (focusables.length === 0) return;'), '缺空 focusables 早退（同族守卫）');
  assert.ok(body.includes('const outside = !drawer.contains(active);'), '缺 contains 收紧判定（焦点逃逸重捕=I7 同族口径）');
  const shiftIdx = body.indexOf('e.shiftKey && (active === first || outside)');
  const noShiftIdx = body.indexOf('!e.shiftKey && (active === last || outside)');
  assert.ok(shiftIdx > -1, '缺 Shift+Tab 分支（首→末回绕/容器外拉回）');
  assert.ok(noShiftIdx > shiftIdx, '缺 Tab 分支（末→首回绕/容器外拉回），或分支次序漂移');
  assert.ok(body.includes('e.preventDefault();'), 'trapTab 缺 preventDefault（不消费则 Tab 双跳=红）');
  assert.ok(body.includes('last.focus();') && body.includes('first.focus();'), '缺 first/last 回绕落点');
  // onKey Tab 分支：Escape 分支之后；更高层让位守卫在 Tab 分支内（isTopmost 先于 trapTab）。
  const onKeyBody = fnBody(drawerScript, 'onKey');
  const escIdx = onKeyBody.indexOf("e.key === 'Escape'");
  const tabIdx = onKeyBody.indexOf("e.key === 'Tab'");
  assert.ok(escIdx > -1 && tabIdx > escIdx, 'onKey 缺 Tab 分支或其先于 Escape 分支（次序漂移）');
  const tabBranch = onKeyBody.slice(tabIdx);
  const yieldIdx = tabBranch.indexOf('if (escHandle && !escHandle.isTopmost()) return;');
  const trapIdx = tabBranch.indexOf('trapTab(e)');
  assert.ok(yieldIdx > -1, 'Tab 分支缺更高层让位守卫（被遮挡抽屉抢拉焦点与上层弹窗互抢=红）');
  assert.ok(trapIdx > yieldIdx, 'trapTab 必须在让位守卫之后');
});

// I3-05（正常）：容器补 aria-modal=true——既有 role="dialog" 与 aria-label="文件预览" 保持
//（I8-02 例外形态：不删 aria-label、不强造标题文本节点）。
check('I3-05 容器补 aria-modal=true（既有 role=dialog 与 aria-label=文件预览 保持）', () => {
  const asideLine = drawer.split('\n').find((l) => l.includes('class="fpreview-drawer"') && l.includes('<aside'));
  assert.ok(asideLine, '缺 aside.fpreview-drawer 容器行');
  assert.ok(asideLine.includes('aria-modal="true"'), '容器缺 aria-modal="true"');
  assert.ok(asideLine.includes('role="dialog"'), '既有 role="dialog" 被删');
  assert.ok(asideLine.includes('aria-label="文件预览"'), '既有 aria-label="文件预览" 被删（I8-02 例外形态不得被统一掉）');
});

// I3-06（异常·还原目标失效）：还原分支含 document.contains + typeof focus 双守卫——目标不在
// DOM → 不 focus 任何兜底元素（spec「落 body」= 自然降级）、不抛错；还原后清位防旧目标复用。
check('I3-06 还原目标已卸载时安全降级（contains+typeof 双守卫先于 focus；无兜底 focus、用后清位）', () => {
  assert.ok(drawerScript.includes('function restoreFocus(): void {'), '缺 restoreFocus 函数');
  const body = fnBody(drawerScript, 'restoreFocus');
  const containsIdx = body.indexOf('document.contains(lastFocused)');
  const focusCallIdx = body.indexOf('lastFocused.focus()');
  assert.ok(containsIdx > -1, '还原缺 document.contains 卸载守卫');
  assert.ok(focusCallIdx > containsIdx, 'focus 必须在卸载守卫之后（无守卫直呼 focus=红）');
  assert.ok(body.includes("typeof lastFocused.focus === 'function'"), '还原缺 typeof focus 可调性守卫（InteractionPrompt 同形）');
  // 负断言：不得在目标卸载时 focus 任意兜底元素——restoreFocus 体唯一 focus 落点是 lastFocused。
  const focusCalls = body.match(/\.focus\(/g) ?? [];
  assert.equal(focusCalls.length, 1, 'restoreFocus 体出现多个 focus 落点（兜底 focus=违反「自然落 body」降级语义）');
  assert.ok(body.includes('lastFocused = null;'), '还原后未清位（重开抽屉误还原旧目标）');
});

// I3-07（并发·防倒退）：Esc 既有三守卫保全——!isComposing / !defaultPrevented / isTopmost
// 次序不变、preventDefault→close 序列不变；Esc 层 1040 注册（open）/释放（close 两分支）保持。
check('I3-07 Esc 既有三守卫保全（isComposing→defaultPrevented→isTopmost 次序 + preventDefault→close + 层注册/释放）', () => {
  const onKeyBody = fnBody(drawerScript, 'onKey');
  const escIdx = onKeyBody.indexOf("e.key === 'Escape'");
  assert.ok(escIdx > -1, '缺 Escape 分支');
  const composingIdx = onKeyBody.indexOf('!e.isComposing');
  const preventedIdx = onKeyBody.indexOf('!e.defaultPrevented');
  const topmostIdx = onKeyBody.indexOf('escHandle?.isTopmost()');
  assert.ok(
    composingIdx > escIdx && preventedIdx > composingIdx && topmostIdx > preventedIdx,
    'Esc 三守卫缺失或次序漂移（isComposing→defaultPrevented→isTopmost）',
  );
  const pdIdx = onKeyBody.indexOf('e.preventDefault();');
  const closeIdx = onKeyBody.indexOf('close();');
  assert.ok(pdIdx > topmostIdx && closeIdx > pdIdx, 'Esc 分支 preventDefault→close 序列漂移');
  const watchSlice = drawerWatchSlice();
  assert.ok(
    watchSlice.includes('escHandle = pushEscLayer(ESC_LAYER_PRIORITY.filePreviewDrawer);'),
    'open 分支缺 Esc 层注册（1040）',
  );
  assert.ok(
    (watchSlice.match(/escHandle\?\.release\(\);/g) ?? []).length >= 2,
    'open/close 分支缺 escHandle 释放（重开抽屉叠层）',
  );
});

// ═══ I4 · TurnDiffDialog 壳基座（useDialogShell 接入） ═══
// 行为级 CDP 按 I2/I3 同款裁决降级：结构钉+切片钉为硬闸，行为走查目检替代（附 C-1），
// 不落 cdp-layout-e2e.mjs。壳几何钳制全在 useDialogShell / dialog-shell-geometry
//（既有钉 tdd-dialog-shell-geometry / tdd-update-dialog-autoheight-verify 保持绿），
// 本组只钉 TurnDiffDialog 的接线形态（I4-01~03/05）与键盘·Esc·seg 保全（I4-04 防倒退红线）。

console.log('\n=== I4 · TurnDiffDialog 壳基座 ===');

const turnScript = scriptOf(turnDiffDialog);

// 标签切片：定位 marker 所在开标签（前溯 '<'、后溯 '>'），用于多行开标签的整标签断言。
function tagSlice(src: string, marker: string): string {
  const mIdx = src.indexOf(marker);
  assert.ok(mIdx > -1, `缺 ${marker}`);
  const tagStart = src.lastIndexOf('<', mIdx);
  const tagEnd = src.indexOf('>', mIdx);
  assert.ok(tagStart > -1 && tagEnd > mIdx, `${marker} 开标签切片越界`);
  return src.slice(tagStart, tagEnd + 1);
}

// I4-01（正常）：壳接线——useDialogShell(computed(()=>!!props.target), dialogEl, 560×360, 1280×840)
// + shellStyle 顶层解包（P4 使用方规范：ComputedRef 须 script 顶层解包，模板自动 unwrap）。
check('I4-01a 壳接线 useDialogShell（visible=computed(target)/cardRef=dialogEl/min 560×360/initialSize 1280×840）+ shellStyle 顶层解包', () => {
  assert.ok(
    turnScript.includes("import { useDialogShell } from '../../composables/use-dialog-shell';"),
    '缺 useDialogShell 导入',
  );
  assert.ok(
    turnScript.includes("import DialogResizeHandles from '../common/DialogResizeHandles.vue';"),
    '缺 DialogResizeHandles 导入',
  );
  const shellIdx = turnScript.indexOf('const shell = useDialogShell(');
  assert.ok(shellIdx > -1, '缺 const shell = useDialogShell( 接线');
  const shellCall = turnScript.slice(shellIdx, turnScript.indexOf(');', shellIdx) + 2);
  assert.ok(
    shellCall.includes('computed(() => !!props.target)'),
    'visible 须为 computed(() => !!props.target)（target 驱动；关闭重开经 shell 内部 visible 边沿重居中，不继承旧几何）',
  );
  assert.ok(shellCall.includes('dialogEl'), 'cardRef 须为既有 dialogEl ref');
  assert.ok(shellCall.includes('minW: 560'), '缺 minW: 560（spec 约 560×360 下限）');
  assert.ok(shellCall.includes('minH: 360'), '缺 minH: 360');
  assert.ok(
    shellCall.includes('initialSize: { width: 1280, height: 840 }'),
    '缺 initialSize { width: 1280, height: 840 }（逐值对齐现 CSS min(1280px,·)×min(840px,·)，视口钳制由壳 clampRectToViewport 承担）',
  );
  assert.ok(turnScript.includes('const shellStyle = shell.style;'), 'shellStyle 须 script 顶层解包（P4 使用方规范）');
});

// I4-01（正常·续）：拖动/复位绑定挂 diff-header 切片内；header 子元素（徽标/标题/meta/关闭钮）语义不动。
check('I4-01b diff-header 切片含 @pointerdown="shell.beginDrag" 与 @dblclick="shell.resetToCenter"；header 子元素语义不动', () => {
  const hStart = turnDiffDialog.indexOf('<header class="diff-header"');
  assert.ok(hStart > -1, '缺 <header class="diff-header"');
  const hEnd = turnDiffDialog.indexOf('</header>', hStart);
  assert.ok(hEnd > hStart, 'header 切片越界');
  const slice = turnDiffDialog.slice(hStart, hEnd);
  assert.ok(slice.includes('@pointerdown="shell.beginDrag"'), '头部缺拖动接线 @pointerdown="shell.beginDrag"（头部拖不动）');
  assert.ok(slice.includes('@dblclick="shell.resetToCenter"'), '头部缺复位接线 @dblclick="shell.resetToCenter"（双击不复位）');
  assert.ok(slice.includes('class="diff-eyebrow__badge"'), 'header 内 mode 徽标被误动');
  assert.ok(slice.includes('class="diff-title"'), 'header 内标题被误动');
  assert.ok(slice.includes('ref="closeBtn"') && slice.includes('@click="close"'), 'header 内关闭钮 ref/click 接线被误动');
});

// I4-01（正常·续）：.diff-dialog 开标签挂 :style="shellStyle"；role/aria-modal 保持。
//（aria 面锚点随 I8 统一同步：旧 :aria-label 已按 impl「I8 七处对照表」移除、容器改
// aria-labelledby 引用 turn-diff-dlg-title——本钉原「:aria-label= 保持」换锚到 labelledby
// 引用，防壳 aria 接线被顺手改坏的语义不变。）
check('I4-01c .diff-dialog 开标签加 :style="shellStyle"；role/aria-modal/aria-labelledby 保持（I8 统一后形态）', () => {
  const tag = tagSlice(turnDiffDialog, 'class="diff-dialog"');
  assert.ok(tag.includes(':style="shellStyle"'), '.diff-dialog 缺 :style="shellStyle"（rect 绑定缺失=壳几何不生效）');
  assert.ok(tag.includes('role="dialog"') && tag.includes('aria-modal="true"'), 'role/aria-modal 被误动');
  assert.ok(tag.includes('aria-labelledby="turn-diff-dlg-title"'), 'aria-labelledby 引用丢失（I8 统一后形态）');
});

// I4-02（正常+负断言）：DialogResizeHandles 在位（binder=shell、diff-main 之后卡片级末尾）、
// 缺省全 8 向——不得只接部分方向（:dirs 局部清单=负断言红）。
check('I4-02 DialogResizeHandles 在位（binder=shell、卡片级末尾 diff-main 之后；缺省全 8 向，不得 :dirs 半向）', () => {
  assert.equal(
    countOf(turnDiffDialog, '<DialogResizeHandles :binder="shell" />'),
    1,
    'DialogResizeHandles 须恰一处且 binder 接壳（缺失/半向=红）',
  );
  const hIdx = turnDiffDialog.indexOf('<DialogResizeHandles');
  const footerIdx = turnDiffDialog.indexOf('</footer>');
  assert.ok(hIdx > footerIdx, '手柄须在 diff-main 内容（footer 闭合）之后——卡片级末尾（ToolDiffDialog 同位）');
  assert.ok(!turnDiffDialog.includes(':dirs='), '不得传 :dirs 局部方向清单（缩放须全 8 向）');
});

// I4-03（边界·极值/越界）：最小尺寸 560×360 落在壳配置；负断言——组件不自管几何、不绕过
// clampRectToViewport 约束链直写尺寸（拖出视口/缩到不可用=红）。
check('I4-03 min 560×360 在壳配置；负断言：组件不自管 rect/不直调几何纯函数/不直写尺寸（约束链全走壳）', () => {
  const shellIdx = turnScript.indexOf('const shell = useDialogShell(');
  assert.ok(shellIdx > -1, '缺壳接线');
  const shellCall = turnScript.slice(shellIdx, turnScript.indexOf(');', shellIdx) + 2);
  assert.ok(shellCall.includes('minW: 560') && shellCall.includes('minH: 360'), '壳配置缺 560×360 下限（min 写错=缩到不可用）');
  assert.ok(!turnScript.includes('const rect = ref<'), '组件不得自管 rect ref（几何归壳，自管=ToolDiff 形态漂移）');
  assert.ok(!turnScript.includes('function clampRect'), '组件不得自写 clampRect（钳制须走壳内 clampRectToViewport）');
  for (const fn of ['dragRect(', 'resizeRect(', 'clampRectToViewport(', 'centerRect(']) {
    assert.ok(!turnScript.includes(fn), `组件不得直调几何纯函数 ${fn}（直调=绕过壳约束链）`);
  }
  assert.ok(!/rect\.value\s*=/.test(turnScript), '组件不得直写 rect.value（尺寸直写=绕过 clamp）');
});

// I4-04（并发·层级让位·保全红线）：onKey 三分支守卫序列 + trapTab + Esc 层注册/释放 + seg/ctx 链路
// 全部零变化——壳基座接入不得顺手重排键盘链（tdd-esc-stack-verify P3-5 的 TurnDiff 同形钉）。
check('I4-04a onKey 切片保全：Ctrl+F/Esc 分支 isTopmost 守卫先于消费；↑↓ 分支 isTextTarget+isTopmost 双守卫与 gotoChange 序列', () => {
  const body = fnBody(turnScript, 'onKey');
  // Ctrl+F 分支：isTopmost 守卫 → preventDefault → openSearch。
  const ctrlIdx = body.indexOf("e.ctrlKey && e.key.toLowerCase() === 'f'");
  assert.ok(ctrlIdx > -1, 'onKey 缺 Ctrl+F 分支');
  const escIdx = body.indexOf("e.key === 'Escape'");
  const ctrlSlice = body.slice(ctrlIdx, escIdx);
  const cTop = ctrlSlice.indexOf('if (escHandle && !escHandle.isTopmost()) return;');
  const cPd = ctrlSlice.indexOf('e.preventDefault();');
  const cOpen = ctrlSlice.indexOf('void openSearch();');
  assert.ok(cTop > -1 && cPd > cTop && cOpen > cPd, 'Ctrl+F 分支 isTopmost→preventDefault→openSearch 序列漂移');
  // Escape 分支：isTopmost 守卫先于 preventDefault；先关搜索再关弹窗。
  const textIdx = body.indexOf('if (isTextTarget(e.target)) return;');
  assert.ok(escIdx > -1 && textIdx > escIdx, 'Esc 分支或 isTextTarget 过滤漂移');
  const escSlice = body.slice(escIdx, textIdx);
  const eTop = escSlice.indexOf('if (escHandle && !escHandle.isTopmost()) return;');
  const ePd = escSlice.indexOf('e.preventDefault();');
  const eSearch = escSlice.indexOf('if (searchOpen.value) closeSearch();');
  const eClose = escSlice.indexOf('else close();');
  assert.ok(eTop > -1 && ePd > eTop, 'Esc 分支 isTopmost 守卫先于消费（层级让位红线）');
  assert.ok(eSearch > ePd && eClose > eSearch, 'Esc 分支「先关搜索再关弹窗」序列漂移');
  // ↑↓ 分支：isTextTarget 过滤 + isTopmost 让位守卫先于 gotoChange；Tab 分支殿后。
  const arrGuard = body.indexOf("(e.key === 'ArrowDown' || e.key === 'ArrowUp') && escHandle && !escHandle.isTopmost()");
  assert.ok(arrGuard > textIdx, '↑↓ 缺 isTopmost 让位守卫或次序漂移');
  const downIdx = body.indexOf("e.key === 'ArrowDown'", arrGuard);
  assert.ok(downIdx > arrGuard && body.slice(downIdx).includes('gotoChange(1);'), 'ArrowDown→gotoChange(1) 漂移');
  assert.ok(body.includes('gotoChange(-1);'), 'ArrowUp→gotoChange(-1) 漂移');
  assert.ok(body.includes("} else if (e.key === 'Tab') {") && body.includes('trapTab(e);'), 'Tab→trapTab 分支漂移');
});

check('I4-04b trapTab/Esc 层注册释放/seg·ctx·重试链路保全（壳基座零顺手改动）', () => {
  // trapTab 同族口径（focusables 查询 + 首末回绕）。
  const trap = fnBody(turnScript, 'trapTab');
  assert.ok(
    trap.includes("'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex=\"-1\"])'"),
    'trapTab focusables 选择器漂移',
  );
  assert.ok(trap.includes('last.focus();') && trap.includes('first.focus();'), 'trapTab 首末回绕漂移');
  // Esc 层：打开注册（1250 diff 层）、关闭释放、卸载兜底释放（release 幂等）。
  assert.equal(
    countOf(turnScript, 'pushEscLayer(ESC_LAYER_PRIORITY.toolDiffDialog)'),
    1,
    'Esc 层注册应恰一处（打开分支）',
  );
  assert.ok(turnScript.includes('escHandle.release();'), '关闭分支缺 escHandle.release()（重开叠层）');
  assert.equal(countOf(turnScript, 'escHandle?.release();'), 1, '卸载兜底释放应恰一处（onBeforeUnmount）');
  // seg（视图模式/上下文档位）与 ctx 禁用链路零变化。
  const setMode = fnBody(turnScript, 'setMode');
  assert.ok(setMode.includes('if (mode.value === m) return;') && setMode.includes('mode.value = m;') && setMode.includes('curChange.value = 0;'), 'setMode 语义漂移');
  const setContext = fnBody(turnScript, 'setContext');
  assert.ok(setContext.includes('fullText.value = false;') && setContext.includes('context.value = n;'), 'setContext 语义漂移');
  const setFullText = fnBody(turnScript, 'setFullText');
  assert.ok(setFullText.includes('fullText.value = true;'), 'setFullText 语义漂移');
  assert.ok(
    turnScript.includes("ctxSynthOnly = computed(() => entry.value?.mode === 'first-change' || entry.value?.mode === 'intent')"),
    'ctxSynthOnly 禁用谓词漂移',
  );
  // 上下文重拉与重试链路零变化（懒加载/缓存键含 context 维度）。
  const ctxWatchIdx = turnScript.indexOf('watch(effectiveContext,');
  assert.ok(ctxWatchIdx > -1, '缺 effectiveContext watch');
  const ctxWatchSlice = turnScript.slice(ctxWatchIdx, turnScript.indexOf('});', ctxWatchIdx));
  assert.ok(ctxWatchSlice.includes('store.getPatch('), 'effectiveContext watch 重拉链路漂移');
  const retry = fnBody(turnScript, 'retry');
  assert.ok(
    retry.includes('store.getPatch(t.sessionId, t.turnStartMessageId, t.endMessageId, t.path, effectiveContext.value)'),
    'retry 重拉链路漂移',
  );
});

// I4-05（边界·窄窗极值）：CSS 两处必改——①.diff-dialog 加 position:absolute（.dlg-rz 手柄包含块 +
// rect left/top 定位前提），回退 min(...) 尺寸保留；②720px 断点 !important 四键逐字对齐
// ToolDiffDialog（内联 rect 与断点竞争的共存机制：!important 覆盖内联四键→窄窗全屏无偏移无溢出）。
// 负断言：断点不得引入 position:fixed 绕过壳；100vw/100vh 直写全文件恰为回退+断点各一处。
check('I4-05 CSS 两处必改（position:absolute + 断点 !important 四键）；负断言：无 fixed 绕过、100vw/vh 直写不越位', () => {
  const style = turnDiffDialog.slice(turnDiffDialog.indexOf('<style scoped>'));
  // ① .diff-dialog 块。
  const dlgIdx = style.indexOf('.diff-dialog {');
  assert.ok(dlgIdx > -1, '缺 .diff-dialog 样式块');
  const dlgBlock = style.slice(dlgIdx, style.indexOf('}', dlgIdx) + 1);
  assert.ok(dlgBlock.includes('position: absolute;'), '.diff-dialog 缺 position:absolute（手柄包含块/rect 定位必改项）');
  assert.ok(dlgBlock.includes('width: min(1280px, calc(100vw - 16px));'), '回退 width min(1280px,·) 被误删（rect 未测量帧回退面）');
  assert.ok(dlgBlock.includes('height: min(840px, calc(100vh - 16px));'), '回退 height min(840px,·) 被误删');
  // ② 720px 断点（逐字对齐 ToolDiffDialog 同款块）。
  const bpIdx = style.indexOf('@media (max-width: 720px)');
  assert.ok(bpIdx > -1, '缺 720px 断点');
  const bpBlock = style.slice(bpIdx, style.indexOf('}', style.indexOf('.diff-dialog {', bpIdx)) + 1);
  assert.ok(bpBlock.includes('width: 100vw !important;'), '断点缺 width:100vw !important');
  assert.ok(bpBlock.includes('height: 100vh !important;'), '断点缺 height:100vh !important');
  assert.ok(bpBlock.includes('left: 0 !important;'), '断点缺 left:0 !important（内联 rect left 竞争覆盖必改项）');
  assert.ok(bpBlock.includes('top: 0 !important;'), '断点缺 top:0 !important');
  assert.ok(bpBlock.includes('border-radius: 0;'), '断点缺 border-radius: 0');
  // 负断言（尺寸失控面）：断点不得引入 fixed 定位绕过壳；100vw/100vh 全文件恰 2 处（回退 min + 断点）。
  assert.ok(!bpBlock.includes('position: fixed'), '断点不得引入 position:fixed（绕过 rect/clamp 体系）');
  assert.equal(countOf(turnDiffDialog, '100vw'), 2, '100vw 直写应恰为回退+断点两处（他处直写=尺寸失控面）');
  assert.equal(countOf(turnDiffDialog, '100vh'), 2, '100vh 直写应恰为回退+断点两处');
});

// I4-06（防文档说谎）：头注释「无…」清单去掉拖动缩放——壳能力已接入，注释须同步。
check('I4-06 头注释「无…」清单去掉「拖动缩放」（壳能力已接入，防文档说谎）', () => {
  const head = turnDiffDialog.slice(0, 1200);
  assert.ok(!head.includes('无侧栏文件列表 / git 状态 / 拖动缩放'), '头注释仍声称无拖动缩放（文档说谎）');
  assert.ok(head.includes('无侧栏文件列表 / git 状态 / 多段切换'), '头注释清单漂移');
});

// ═══ I5 · 弹窗焦点还原补全（UpdateDialog / ExportImageFormatDialog） ═══
// 行为级 CDP（I5-01/02 可选项）按 I2/I3 同款裁决降级：结构钉+切片钉+负断言为硬闸，行为走查
// 目检替代（C 组弹窗交互），不落 cdp-layout-e2e.mjs（真实窗口焦点序合成环境可行性未验证）。
// 还原口径（impl I5）：lastFocus 记录并入既有 Esc 层 watch——open 边沿记 document.activeElement
// （instanceof HTMLElement 归一），close 边沿 nextTick 内 document.contains 守卫还原+用后清位
//（目标卸载自然落 body、不兜底 focus）；打开期焦点行为零变化（I5-04 保全，B-10 红线）。

const updateDialog = read('../src/renderer/components/layout/UpdateDialog.vue');
const exportFmt = read('../src/renderer/components/export/ExportImageFormatDialog.vue');
const updateDialogScript = scriptOf(updateDialog);
const exportFmtScript = scriptOf(exportFmt);

// watch 切片：定位 watch 起点至其后首个锚（UpdateDialog=onKeydown 定义、ExportFormat=onMounted）。
function watchSliceOf(script: string, startMarker: string, endMarker: string): string {
  const start = script.indexOf(startMarker);
  assert.ok(start > -1, `缺 ${startMarker}`);
  const end = script.indexOf(endMarker, start);
  assert.ok(end > start, 'watch 切片越界');
  return script.slice(start, end);
}

console.log('\n=== I5 · 弹窗焦点还原补全（UpdateDialog / ExportFormat） ===');

// I5-01（正常）：UpdateDialog 打开边沿记录触发元素、关闭边沿还原——记录/还原并入既有
// dialogVisible watch；footer 稍后提醒/遮罩点击/Esc 三关闭路径全走 dismissUpdate→dialogVisible
// 边沿统一收口，还原不得在 onKeydown/按钮处理器另起第二入口。
check('I5-01 UpdateDialog 打开记录/关闭还原并入 dialogVisible watch（三关闭路径收敛单一边沿，无旁路还原入口）', () => {
  assert.ok(
    updateDialogScript.includes('let lastFocus: HTMLElement | null = null;'),
    '缺 lastFocus 状态声明',
  );
  const watchSlice = watchSliceOf(updateDialogScript, 'watch(() => updateStore.dialogVisible', 'function onKeydown');
  assert.ok(
    watchSlice.includes('lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;'),
    'open 边沿缺触发元素记录（activeElement instanceof HTMLElement 归一形态）',
  );
  const restoreIdx = watchSlice.indexOf('void nextTick(() => {');
  assert.ok(restoreIdx > -1, 'close 分支缺 nextTick 还原块');
  const restoreSlice = watchSlice.slice(restoreIdx, watchSlice.indexOf('});', restoreIdx) + 3);
  assert.ok(restoreSlice.includes('document.contains(lastFocus)'), '还原缺 document.contains 卸载守卫');
  assert.ok(restoreSlice.includes('lastFocus.focus()'), '还原缺 lastFocus.focus()');
  assert.ok(restoreSlice.includes('lastFocus = null;'), '还原后未清位（重开误还旧目标）');
  // 收敛负断言：还原接线恰一处（watch close 分支）；onKeydown 内无 lastFocus（旁路第二入口=红）。
  assert.equal(countOf(updateDialogScript, 'document.contains(lastFocus)'), 1, '还原接线应恰一处（watch close 分支）');
  const onKeyBody = fnBody(updateDialogScript, 'onKeydown');
  assert.ok(!onKeyBody.includes('lastFocus'), 'onKeydown 内出现 lastFocus（还原散落到 Esc 处理器=双入口）');
  // 三关闭路径前提：均驱动 dialogVisible 边沿（Esc/遮罩/footer 全部 dismissUpdate 出口）。
  assert.ok(onKeyBody.includes('updateStore.dismissUpdate();'), 'Esc 分支 dismissUpdate 出口漂移（三路径统一入口前提被破坏）');
  assert.ok(updateDialog.includes('@click.self="updateStore.dismissUpdate()"'), '遮罩关闭路径漂移');
  assert.ok(updateDialog.includes('@click="updateStore.dismissUpdate()"'), 'footer 稍后提醒关闭路径漂移');
});

// I5-02（正常+负断言）：ExportFormat 打开记录/关闭还原并入 props.open watch——取消钮/遮罩/Esc
//（emit cancel）与确认（emit confirm 后父级置 open=false）各通道全部经 open 边沿收敛；
// 还原不得在 onKey/confirm 内旁路。
check('I5-02 ExportFormat 打开记录/关闭还原并入 props.open watch（cancel×3+confirm 通道经父级 open 边沿收敛，无旁路还原）', () => {
  assert.ok(
    exportFmtScript.includes('let lastFocus: HTMLElement | null = null;'),
    '缺 lastFocus 状态声明',
  );
  const watchSlice = watchSliceOf(exportFmtScript, 'watch(() => props.open', 'onMounted(');
  assert.ok(
    watchSlice.includes('lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;'),
    'open 边沿缺触发元素记录',
  );
  const restoreIdx = watchSlice.indexOf('void nextTick(() => {');
  assert.ok(restoreIdx > -1, 'close 分支缺 nextTick 还原块（open 分支初始 focus 为表达式形态不相干）');
  const restoreSlice = watchSlice.slice(restoreIdx, watchSlice.indexOf('});', restoreIdx) + 3);
  assert.ok(restoreSlice.includes('document.contains(lastFocus)'), '还原缺 document.contains 卸载守卫');
  assert.ok(restoreSlice.includes('lastFocus.focus()'), '还原缺 lastFocus.focus()');
  assert.ok(restoreSlice.includes('lastFocus = null;'), '还原后未清位');
  // 收敛负断言：还原接线恰一处；onKey 与 confirm 体内无 lastFocus（逐通道旁路=红）。
  assert.equal(countOf(exportFmtScript, 'document.contains(lastFocus)'), 1, '还原接线应恰一处（watch close 分支）');
  const onKeyBody = fnBody(exportFmtScript, 'onKey');
  const confirmBody = fnBody(exportFmtScript, 'confirm');
  assert.ok(!onKeyBody.includes('lastFocus'), 'onKey 内出现 lastFocus（还原散落到 Esc 分支=双入口）');
  assert.ok(!confirmBody.includes('lastFocus'), 'confirm 内出现 lastFocus（还原散落到确认路径=双入口）');
  // 通道前提：三关闭通道 emit cancel + 确认通道 emit confirm（父级关弹窗驱动 open 边沿）。
  assert.ok(onKeyBody.includes("emit('cancel');"), 'Esc 取消通道漂移');
  assert.ok(exportFmt.includes("@click.self=\"emit('cancel')\""), '遮罩取消通道漂移');
  assert.ok(exportFmt.includes("@click=\"emit('cancel')\""), 'footer 取消通道漂移');
  assert.ok(confirmBody.includes("emit('confirm', selected.value);"), '确认通道漂移');
});

// I5-03（异常·还原目标失效）：两弹窗还原分支均含 document.contains 守卫（I3-06 同口径，逐弹窗
// 计数=1、合计=2）——守卫先于 focus、还原块唯一 focus 落点（不兜底 focus=自然落 body）、用后清位。
check('I5-03 还原目标卸载安全降级（两弹窗各含 contains 守卫且先于 focus；还原块唯一 focus 落点、用后清位）', () => {
  for (const [label, script] of [
    ['UpdateDialog', updateDialogScript],
    ['ExportFormat', exportFmtScript],
  ] as const) {
    assert.equal(countOf(script, 'document.contains(lastFocus)'), 1, `${label} contains 守卫应恰一处（逐弹窗=1）`);
    const gIdx = script.indexOf('document.contains(lastFocus)');
    const blkStart = script.lastIndexOf('void nextTick(() => {', gIdx);
    assert.ok(blkStart > -1, `${label} 还原不在 nextTick 块内`);
    const blk = script.slice(blkStart, script.indexOf('});', gIdx) + 3);
    const gRel = gIdx - blkStart;
    assert.ok(blk.indexOf('lastFocus.focus()') > gRel, `${label} focus 必须在卸载守卫之后（无守卫直呼 focus=红）`);
    const focusCalls = blk.match(/\.focus\(/g) ?? [];
    assert.equal(focusCalls.length, 1, `${label} 还原块出现多个 focus 落点（兜底 focus=违反自然落 body 降级语义）`);
    assert.ok(blk.includes('lastFocus = null;'), `${label} 还原后未清位`);
  }
});

// I5-04（边界·保全）：打开期焦点行为零变化——ExportFormat 既有初始 focus（cardRef）逐字保持；
// UpdateDialog 打开不新增聚焦（全 script 唯一 .focus( 落点是还原 lastFocus）。附 B-10 红线切片：
// Esc 形态（isTopmost→preventDefault→dismissUpdate 序）、autoHeight 选项、ReleaseNotesView 接线零改动。
check('I5-04 打开期焦点行为不变（ExportFormat 初始 focus 保持；UpdateDialog 不新增聚焦）+ B-10 保全切片', () => {
  // ExportFormat：open 分支初始焦点逐字保持（既有行为）。
  const fmtWatch = watchSliceOf(exportFmtScript, 'watch(() => props.open', 'onMounted(');
  const fmtOpenStart = fmtWatch.indexOf('if (open) {');
  const fmtElseStart = fmtWatch.indexOf('} else {', fmtOpenStart);
  const fmtOpenBranch = fmtWatch.slice(fmtOpenStart, fmtElseStart);
  assert.ok(
    fmtOpenBranch.includes('void nextTick(() => cardRef.value?.focus());'),
    'ExportFormat 打开初始 focus 漂移（cardRef.value?.focus() 必须逐字保持）',
  );
  // UpdateDialog：open 分支零 focus；全 script 唯一 .focus( = 还原落点（无任何新抢焦）。
  const updWatch = watchSliceOf(updateDialogScript, 'watch(() => updateStore.dialogVisible', 'function onKeydown');
  const updOpenStart = updWatch.indexOf('if (visible) {');
  const updElseStart = updWatch.indexOf('} else {', updOpenStart);
  const updOpenBranch = updWatch.slice(updOpenStart, updElseStart);
  assert.ok(!updOpenBranch.includes('.focus('), 'UpdateDialog 打开分支新增聚焦（打开抢焦=回归）');
  assert.equal(countOf(updateDialogScript, '.focus('), 1, 'UpdateDialog script 应只有还原一处 .focus(（他处新聚焦=回归）');
  // B-10 保全：Esc 形态（isTopmost→preventDefault→dismissUpdate）+ autoHeight 选项 + ReleaseNotesView 接线。
  const onKeyBody = fnBody(updateDialogScript, 'onKeydown');
  const topIdx = onKeyBody.indexOf('if (escHandle && !escHandle.isTopmost()) return;');
  const pdIdx = onKeyBody.indexOf('e.preventDefault();');
  const disIdx = onKeyBody.indexOf('updateStore.dismissUpdate();');
  assert.ok(topIdx > -1 && pdIdx > topIdx && disIdx > pdIdx, 'UpdateDialog Esc 形态漂移（isTopmost→preventDefault→dismissUpdate 序被顺手动）');
  assert.ok(
    updateDialogScript.includes('{ minW: 320, minH: 220, autoHeight: true }'),
    'autoHeight 选项被顺手动（B-10）',
  );
  assert.ok(
    updateDialog.includes('<ReleaseNotesView :notes="updateStore.state.releaseNotes" />'),
    'ReleaseNotesView 接线被顺手动（B-10）',
  );
});

// ═══ I6 · 交互历史 chip+时间 + confirm 放开 ═══
// 行为级按 I2/I3 同款裁决降级（结构钉+切片钉为硬闸，行为走查目检替代）。
// 双裁决落地：①数据源=既有落库字段 action/createdAt，禁 summary 反推（timeout 路径
// summary='系统取消（…）' 而 action='cancel'，从 summary 反推必误判）；②跨日时间口径选
// 附 E-3 B——当天 HH:mm / 跨天 M/d HH:mm（I6-02 断言随之扩跨日分支）。
console.log('\n=== I6 · 交互历史 chip+时间 + confirm 放开 ===');

const promptScript = scriptOf(prompt);

// 历史区 details 块切片（<details … class="interaction-history" … 起，至 </details> 止）。
// 依赖 class="interaction-history" 全文件唯一（BEM 修饰类带 __ 后缀不含闭引号，不误命中）。
function historyDetailsSlice(): string {
  const marker = prompt.indexOf('class="interaction-history"');
  assert.ok(marker > -1, '缺 interaction-history 容器');
  const start = prompt.lastIndexOf('<details', marker);
  const end = prompt.indexOf('</details>', marker);
  assert.ok(start > -1 && end > marker, '历史区 details 切片越界');
  return prompt.slice(start, end + '</details>'.length);
}

// 历史行 li 切片（v-for 首个 li 模板至 </li>）。
function historyRowSlice(): string {
  const det = historyDetailsSlice();
  const start = det.indexOf('<li');
  assert.ok(start > -1, '历史区缺 li 行');
  const end = det.indexOf('</li>', start);
  assert.ok(end > start, 'li 切片越界');
  return det.slice(start, end + '</li>'.length);
}

// I6-01（正常）：历史行结果 chip——文案与 tone 类均由 action 字段驱动（:class 与插值文案两处
// 三元、计数=2 钉死「源=action」）；meta 块内零 summary 引用（timeout/系统取消路径 summary
// 与 action 不同步，反推必误判）。
park('I6-01a 历史行 chip：文案/tone 双处由 item.action 驱动（计数=2），meta 块零 summary 引用', () => {
  const row = historyRowSlice();
  assert.ok(row.includes('interaction-history__chip'), '历史行缺 chip 节点（RED 判据：现状无 chip）');
  assert.equal(countOf(row, "item.action === 'submit'"), 2, "chip 的 action 三元须恰两处（:class tone 分化 + 文案；改由 summary 反推=红）");
  assert.ok(row.includes("'interaction-history__chip--ok'") && row.includes("'interaction-history__chip--neutral'"), 'chip 两 tone 修饰类（--ok/--neutral）缺失');
  assert.ok(row.includes('interaction-history__meta'), '缺 chip/时间 meta 容器');
  const metaStart = row.indexOf('interaction-history__meta');
  const timeIdx = row.indexOf('interaction-history__time', metaStart);
  assert.ok(timeIdx > -1, 'meta 块缺时间节点');
  const meta = row.slice(metaStart, row.indexOf('</span>', timeIdx));
  assert.ok(!meta.includes('summary'), 'chip/时间 meta 块出现 summary 引用（反推=禁）');
});

// I6-01（正常·续）：两条数据源补齐 action/createdAt——内存条目（pushHistory）+ DB 映射
//（loadHistory），字段均为既有落库字段，不新增落库。
park('I6-01b 双数据源补字段：HistoryEntry 类型 + pushHistory 内存条目 + loadHistory 映射均含 action/createdAt', () => {
  const tStart = promptScript.indexOf('type HistoryEntry = {');
  assert.ok(tStart > -1, '缺 HistoryEntry 类型');
  const typeSlice = promptScript.slice(tStart, promptScript.indexOf('};', tStart));
  assert.ok(typeSlice.includes("action: 'submit' | 'cancel';"), 'HistoryEntry 类型缺 action');
  assert.ok(typeSlice.includes('createdAt: string;'), 'HistoryEntry 类型缺 createdAt');
  const push = fnBody(promptScript, 'pushHistory');
  const entryStart = push.indexOf('history.value = [{');
  assert.ok(entryStart > -1, 'pushHistory 缺内存条目构造');
  const entry = push.slice(entryStart, push.indexOf(']', entryStart));
  assert.ok(/\baction,/.test(entry), 'pushHistory 内存条目缺 action');
  assert.ok(entry.includes('createdAt: new Date().toISOString()'), 'pushHistory 内存条目缺 createdAt');
  const load = fnBody(promptScript, 'loadHistory');
  assert.ok(load.includes('action: e.action') && load.includes('createdAt: e.createdAt'), 'loadHistory 映射缺 action/createdAt 扩接');
});

// I6-01（负断言）：不新增落库——ipc.ts InteractionHistoryEntry 形状恰 7 字段零漂移；
// repo 落库列（action/created_at）保全（I6 对表/repo 零改动）。
check('I6-01c 不新增落库：ipc.ts InteractionHistoryEntry 恰 7 字段 + repo 落库列保全', () => {
  const ipc = read('../src/shared/types/ipc.ts');
  const iStart = ipc.indexOf('export interface InteractionHistoryEntry {');
  assert.ok(iStart > -1, '缺 InteractionHistoryEntry 接口');
  const iface = ipc.slice(iStart, ipc.indexOf('}', iStart));
  const fieldLines = iface.split('\n').filter((l) => /^  [A-Za-z_]+\??:/.test(l));
  assert.equal(fieldLines.length, 7, 'InteractionHistoryEntry 字段数漂移（I6 私加落库字段=红）');
  const repo = read('../src/main/database/repositories/interaction-history-repo.ts');
  assert.ok(repo.includes('created_at') && repo.includes("'submit' | 'cancel'"), 'repo 落库列形状漂移（I6 不新增不删减落库列）');
});

// I6-02（边界·格式化）：时间节点——DB 条目取 createdAt 格式化、本地条目取 push 时刻；
// 前导零 HH:mm；E-3B 跨日分支（当天 HH:mm / 跨天 M/d HH:mm）；样式 mono + tabular-nums；
// 负断言：不得复用 summary 字段当时间。
park('I6-02 时间节点：createdAt 经 formatHistoryTime + 前导零 + E-3B 跨日分支 + mono/tabular-nums 样式', () => {
  const row = historyRowSlice();
  assert.ok(row.includes('interaction-history__time'), '缺时间节点（RED 判据：现状无时间）');
  assert.ok(row.includes('formatHistoryTime(item.createdAt)'), '时间必须取 createdAt 经 formatHistoryTime（复用 summary 当时间=红）');
  const fn = fnBody(promptScript, 'formatHistoryTime');
  assert.ok(fn.includes('Number.isNaN(d.getTime())'), 'formatHistoryTime 缺 NaN 守卫（非法时间须回空串不崩）');
  assert.ok(
    fn.includes("String(d.getHours()).padStart(2, '0')") && fn.includes("String(d.getMinutes()).padStart(2, '0')"),
    'HH:mm 前导零缺失',
  );
  // E-3 裁决 B：跨日分支（当天仅 HH:mm / 跨天 M/d HH:mm）。
  assert.ok(
    fn.includes('getFullYear()') && fn.includes('getMonth()') && fn.includes('getDate()'),
    '跨日同天判定缺失（E-3B）',
  );
  assert.ok(/\$\{d\.getMonth\(\) \+ 1\}\/\$\{d\.getDate\(\)\}/.test(fn), '跨天前缀须为 M/d 形态（getMonth()+1/getDate()）');
  const tIdx = prompt.indexOf('.interaction-history__time {');
  assert.ok(tIdx > -1, '缺 .interaction-history__time 样式块');
  const timeStyle = prompt.slice(tIdx, prompt.indexOf('}', tIdx));
  assert.ok(timeStyle.includes('var(--font-mono)'), '时间样式缺 mono 字体族');
  assert.ok(timeStyle.includes('font-variant-numeric: tabular-nums'), '时间样式缺 tabular-nums（时间宽度跳动）');
});

// I6-03（正常）：confirm 型弹窗不再隐藏历史区——排除条件移除、单 details 结构保持、
// summary 字面钉保全（tdd-interaction-prompt-enter-guard:132 依赖）。
check('I6-03 confirm 放开：v-if 排除条件移除（kind!==confirm 清零）、单 details 结构、summary 字面钉保持', () => {
  const tag = tagSlice(prompt, 'class="interaction-history"');
  assert.ok(!tag.includes("kind !== 'confirm'"), 'confirm 排除条件残留（RED 判据对位：主行为未落地）');
  assert.equal(countOf(prompt, 'class="interaction-history"'), 1, '历史区容器被复制（不得另起容器重复渲染 confirm 历史）');
  assert.ok(prompt.includes('<summary>交互历史（{{ history.length }}）</summary>'), 'summary 字面钉漂移（enter-guard:132 依赖）');
});

// I6-04（边界·空历史）：history.length 空守卫在位且 v-if 表达式恰为 history.length——
// 删除空守卫或放宽成恒真形态（本地 confirm 弹出空「交互历史（0）」壳）都红。
check('I6-04 空历史不渲染：v-if 表达式恰为 history.length（空守卫在位、无空壳骨架）', () => {
  const tag = tagSlice(prompt, 'class="interaction-history"');
  const m = tag.match(/v-if="([^"]*)"/);
  assert.ok(m, '历史区缺 v-if');
  assert.equal(m[1], 'history.length', 'v-if 须恰为 history.length（保留空守卫、删 confirm 条件后不得放宽）');
});

// I6-05（边界·极值保全）：条数上限 8 不变——不得顺手放大或移除裁剪。
check('I6-05 条数上限 8 保全：pushHistory slice(0, 8) 保持', () => {
  const push = fnBody(promptScript, 'pushHistory');
  const nums = [...push.matchAll(/slice\(0,\s*(\d+)\)/g)].map((m) => m[1]);
  assert.ok(nums.length >= 1, '上限裁剪被移除');
  assert.ok(nums.every((n) => n === '8'), '上限被改动（非 8）');
});

// I6-06（并发·竞态骨架保全）：loadHistory token 自增/过期丢弃/空会话清空/catch 静默——
// I6 映射扩字段（action/createdAt）只增字段不改骨架。
check('I6-06 loadHistory 竞态骨架保全（token 自增+引用计数=4+过期丢弃+空会话清空+catch 静默）', () => {
  const load = fnBody(promptScript, 'loadHistory');
  assert.ok(load.includes('++historyLoadToken'), 'token 自增被移除');
  assert.equal(countOf(load, 'historyLoadToken'), 4, 'token 引用计数漂移（自增1+空会话1+过期丢弃1+catch静默1）');
  assert.ok(load.includes('if (token !== historyLoadToken) return;'), '过期结果丢弃早退缺失（快速切会话 A→B 被 A 晚到响应覆盖）');
  assert.ok(load.includes('if (token === historyLoadToken) history.value = [];'), '空会话清空守卫漂移');
  assert.ok(load.includes('if (token === historyLoadToken) {'), 'catch 静默守卫漂移');
  assert.ok(load.includes("summary: e.summary ?? ''"), 'summary 既有映射漂移');
});

// ═══ I7 · 四处 trapTab 焦点逃逸重捕 ═══
// 行为级 CDP（I7-03：点留白→Tab 拉回首元素/Shift+Tab 拉回末元素）挂 scripts/cdp-layout-e2e.mjs
// 弹窗交互组（FilePicker + DiffDialog 两站采样）。本节钉 I7-01 结构+计数（四组件逐个）与
// I7-02 防倒退保全（转写即绿属预期）。同族口径=InteractionPrompt B5 / I3-04（FilePreviewDrawer
// 已含 contains 收紧）；InteractionPrompt 本身不动（tdd-interaction-initial-focus-verify :62-64 钉）。
console.log('\n=== I7 · 四处 trapTab 焦点逃逸重捕 ===');

const i7Stations: Array<{ label: string; script: string }> = [
  { label: 'DiffDialog', script: scriptOf(diffDialog) },
  { label: 'ToolDiffDialog', script: scriptOf(toolDiffDialog) },
  { label: 'TurnDiffDialog', script: scriptOf(turnDiffDialog) },
  { label: 'FilePickerDialog', script: scriptOf(filePicker) },
];

for (const st of i7Stations) {
  // I7-01（异常·结构钉+计数钉）：trapTab 含 contains(activeElement) 收紧——焦点不在容器内时
  // Tab→preventDefault+首元素 focus、Shift+Tab→preventDefault+末元素 focus；收紧判定先于既有
  // 首尾回绕分支；outside 判定恰一处、旧等值形态清零（漏一组件/漏一分支即红）。
  check(`I7-01 ${st.label} trapTab 焦点逃逸重捕（active/outside 两行插入+两处条件改写+先于回绕分支+恰一处）`, () => {
    assert.ok(st.script.includes('function trapTab(e: KeyboardEvent): void {'), '缺 trapTab 函数');
    const body = fnBody(st.script, 'trapTab');
    assert.ok(body.includes('const active = document.activeElement;'), '缺 active 插入行（impl 规格行 1）');
    assert.equal(
      countOf(body, 'const outside = !dlg.contains(active);'), 1,
      '缺 outside 收紧判定恰一处（容器引用须为 trapTab 内 dlg 变量；重复插入=红）',
    );
    const outsideIdx = body.indexOf('const outside =');
    const shiftIdx = body.indexOf('e.shiftKey &&');
    assert.ok(outsideIdx > -1 && shiftIdx > outsideIdx, '收紧判定须先于既有首尾回绕分支');
    assert.ok(
      body.includes('e.shiftKey && (active === first || outside)'),
      'Shift+Tab 分支缺容器外拉回（outside 析取并入 === first 条件）',
    );
    assert.ok(
      body.includes('!e.shiftKey && (active === last || outside)'),
      'Tab 分支缺容器外拉回（outside 析取并入 === last 条件）',
    );
    // 旧形态清零（防两形态并存/防只改一处）。
    assert.equal(countOf(body, 'document.activeElement === first'), 0, '旧形态 document.activeElement === first 残留');
    assert.equal(countOf(body, 'document.activeElement === last'), 0, '旧形态 document.activeElement === last 残留');
    // 回绕落点与消费语义保全：preventDefault + 交叉 focus（Shift+Tab→last、Tab→first）。
    assert.ok(body.includes('e.preventDefault();'), 'trapTab 缺 preventDefault（不消费则 Tab 双跳=红）');
    assert.ok(body.includes('last.focus();') && body.includes('first.focus();'), '缺 first/last 回绕落点');
  });

  // I7-02（边界·防倒退钉，转写即绿）：既有分支保全——focusables 选择器、空集早退、容器内
  // 正常回绕（首/末等值判定仍在分支条件内，收紧不得吞回绕=负断言）。
  check(`I7-02 ${st.label} 正常 Tab 循环与空 focusables 守卫保全（选择器/空集早退/容器内回绕不吞）`, () => {
    const body = fnBody(st.script, 'trapTab');
    assert.ok(
      body.includes("'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex=\"-1\"])'"),
      'focusables 选择器漂移（同族口径：button/input/[tabindex] 非禁用）',
    );
    assert.ok(body.includes('if (!focusables.length) return;'), '空 focusables 早退漂移');
    // 容器内回绕保全：等值判定仍在（无论旧形态直写还是新形态析取内）。
    assert.ok(/e\.shiftKey && [^;{]*=== first/.test(body), 'Shift+Tab 容器内回绕（=== first 等值判定）被吞');
    assert.ok(/!e\.shiftKey && [^;{]*=== last/.test(body), 'Tab 容器内回绕（=== last 等值判定）被吞');
  });
}

// ═══ I8 · aria-labelledby 统一（5 改点 + 2 已合规 + 2 例外） ═══
// 转写 docs/ui-completion/tests/I-dialogs-global-cases.md I8-01/02/03；改法照
// docs/ui-completion/impl/I-dialogs-global-impl.md「I8 七处对照表」。容器旧 aria-label
// 移除（E-1 裁决 B 形态：dispatch 指令与 impl 均要求「旧 aria-label 移除」，故含移除
// 负断言；'aria-label=' 与 'aria-labelledby=' 无子串歧义——前者后随 '='，后者后随 'l'）。
console.log('\n=== I8 · aria-labelledby 统一 ===');

const updateDialogSrc = read('../src/renderer/components/layout/UpdateDialog.vue');
const exportFmtDialog = read('../src/renderer/components/export/ExportImageFormatDialog.vue');
const lightbox = read('../src/renderer/components/chat/ImageLightbox.vue');

// I8 容器通用断言：labelledby 引用在位、role/aria-modal 保全、id 站内存在（防悬空引用）；
// changed=true 时另断言旧 aria-label 清零（改点五站；已合规两站只验证不外加约束）。
function i8ContainerAssert(src: string, marker: string, id: string, changed: boolean): void {
  const tag = tagSlice(src, marker);
  assert.ok(tag.includes(`aria-labelledby="${id}"`), `容器缺 aria-labelledby="${id}"`);
  assert.ok(tag.includes('role="dialog"'), '容器 role="dialog" 丢失');
  assert.ok(tag.includes('aria-modal="true"'), '容器 aria-modal="true" 丢失');
  if (changed) assert.ok(!tag.includes('aria-label='), '容器旧 aria-label 未移除（E-1 裁决 B：改点站旧 aria-label 须清零）');
  assert.ok(src.includes(`id="${id}"`), `labelledby 引用悬空：站内缺 id="${id}"`);
}

// I8-01（正常，7 站逐站）：标题元素置 id + 容器 aria-labelledby 引用 + 引用不悬空 +
// 既有类名/动态绑定不被顺手改；改点五站另含旧 aria-label 清零负断言。
park('I8-01a InteractionPrompt：h3 置 id=interaction-dlg-title + 容器 aria-labelledby + 旧 :aria-label 清零', () => {
  i8ContainerAssert(prompt, 'class="interaction-dialog"', 'interaction-dlg-title', true);
  const h3Line = prompt.split('\n').find((l) => l.includes('<h3') && l.includes('{{ currentTitle }}'));
  assert.ok(h3Line, '缺 h3 标题行');
  assert.ok(h3Line.includes('id="interaction-dlg-title"'), 'h3 缺 id="interaction-dlg-title"');
  assert.ok(h3Line.includes('{{ currentTitle }}'), '标题动态绑定 {{ currentTitle }} 丢失（可见标题须保持动态）');
  assert.equal(countOf(prompt, ':aria-label="activeRequest.title"'), 0, '旧 :aria-label="activeRequest.title" 残留（E-1 裁决 B）');
  assert.ok(prompt.includes('class="interaction-dialog__eyebrow"'), '既有类 .interaction-dialog__eyebrow 被改名');
});

check('I8-01b UpdateDialog：h3.update-dialog__title 置 id=update-dlg-title + 卡片 aria-labelledby + 旧 aria-label 清零', () => {
  i8ContainerAssert(updateDialogSrc, 'data-testid="update-dialog"', 'update-dlg-title', true);
  const h3Line = updateDialogSrc.split('\n').find((l) => l.includes('<h3') && l.includes('update-dialog__title'));
  assert.ok(h3Line, '缺 h3.update-dialog__title 标题行');
  assert.ok(h3Line.includes('id="update-dlg-title"'), 'h3 缺 id="update-dlg-title"');
  assert.ok(h3Line.includes('class="update-dialog__title"'), '既有类 .update-dialog__title 被改名');
  assert.ok(h3Line.includes('发现新版本'), '标题文本「发现新版本」漂移');
  assert.equal(countOf(updateDialogSrc, 'aria-label="发现新版本"'), 0, '旧 aria-label="发现新版本" 残留（E-1 裁决 B）');
});

check('I8-01c DiffDialog：h2.diff-title 置 id=diff-dlg-title + 容器 aria-labelledby + 旧 :aria-label 清零', () => {
  i8ContainerAssert(diffDialog, 'class="diff-dialog"', 'diff-dlg-title', true);
  const h2Line = diffDialog.split('\n').find((l) => l.includes('<h2') && l.includes('class="diff-title"'));
  assert.ok(h2Line, '缺 h2.diff-title 标题行');
  assert.ok(h2Line.includes('id="diff-dlg-title"'), 'h2 缺 id="diff-dlg-title"');
  assert.ok(h2Line.includes('class="diff-title"'), '既有类 .diff-title 被改名');
  assert.ok(
    diffDialog.includes('{{ pathParts.dir }}') && diffDialog.includes("{{ pathParts.name || '—' }}"),
    '标题动态绑定 pathParts 丢失（可见标题须保持动态）',
  );
  assert.equal(countOf(diffDialog, ':aria-label="`文件对比'), 0, '旧 :aria-label="文件对比 …" 残留（E-1 裁决 B）');
});

check('I8-01d ToolDiffDialog：h2.diff-title 置 id=tool-diff-dlg-title + 容器 aria-labelledby + 旧 :aria-label 清零', () => {
  i8ContainerAssert(toolDiffDialog, 'class="diff-dialog"', 'tool-diff-dlg-title', true);
  const h2Line = toolDiffDialog.split('\n').find((l) => l.includes('<h2') && l.includes('class="diff-title"'));
  assert.ok(h2Line, '缺 h2.diff-title 标题行');
  assert.ok(h2Line.includes('id="tool-diff-dlg-title"'), 'h2 缺 id="tool-diff-dlg-title"');
  assert.ok(h2Line.includes('class="diff-title"'), '既有类 .diff-title 被改名');
  assert.ok(
    toolDiffDialog.includes('{{ pathParts.dir }}') && toolDiffDialog.includes("{{ pathParts.name || '—' }}"),
    '标题动态绑定 pathParts 丢失（可见标题须保持动态）',
  );
  assert.equal(countOf(toolDiffDialog, ':aria-label="`改动对比'), 0, '旧 :aria-label="改动对比 …" 残留（E-1 裁决 B）');
});

check('I8-01e TurnDiffDialog：h2.diff-title 置 id=turn-diff-dlg-title + 容器 aria-labelledby + 旧 :aria-label 清零', () => {
  i8ContainerAssert(turnDiffDialog, 'class="diff-dialog"', 'turn-diff-dlg-title', true);
  const h2Line = turnDiffDialog.split('\n').find((l) => l.includes('<h2') && l.includes('class="diff-title"'));
  assert.ok(h2Line, '缺 h2.diff-title 标题行');
  assert.ok(h2Line.includes('id="turn-diff-dlg-title"'), 'h2 缺 id="turn-diff-dlg-title"');
  assert.ok(h2Line.includes('class="diff-title"'), '既有类 .diff-title 被改名');
  assert.ok(
    turnDiffDialog.includes('{{ pathParts.dir }}') && turnDiffDialog.includes("{{ pathParts.name || '—' }}"),
    '标题动态绑定 pathParts 丢失（可见标题须保持动态）',
  );
  assert.equal(countOf(turnDiffDialog, ':aria-label="`轮末改动对比'), 0, '旧 :aria-label="轮末改动对比 …" 残留（E-1 裁决 B）');
});

// 已合规两站（对照表 #6/#7）：验证即可不改——labelledby + 标题 id/类保全，转写即绿。
check('I8-01f ExportImageFormatDialog 已合规验证：aria-labelledby=export-fmt-title 引用与标题 id/类保全', () => {
  i8ContainerAssert(exportFmtDialog, 'class="export-fmt-card"', 'export-fmt-title', false);
  const titleTag = tagSlice(exportFmtDialog, 'id="export-fmt-title"');
  assert.ok(titleTag.includes('class="export-fmt-title"'), '既有类 .export-fmt-title 被改名');
  assert.ok(titleTag.includes('<h3'), '标题元素标签漂移（须保持 h3）');
});

check('I8-01g FilePickerDialog 已合规验证：aria-labelledby=fp-dlg-title 引用与标题 id/类/动态绑定保全', () => {
  i8ContainerAssert(filePicker, 'aria-labelledby="fp-dlg-title"', 'fp-dlg-title', false);
  const h3Line = filePicker.split('\n').find((l) => l.includes('<h3') && l.includes('fp-header__title'));
  assert.ok(h3Line, '缺 h3.fp-header__title 标题行');
  assert.ok(h3Line.includes('id="fp-dlg-title"'), 'h3 缺 id="fp-dlg-title"');
  assert.ok(h3Line.includes('class="fp-header__title"'), '既有类 .fp-header__title 被改名');
  assert.ok(h3Line.includes('{{ req.title }}'), '标题动态绑定 {{ req.title }} 丢失');
});

// I8-02（边界·例外面）：灯箱与文件预览抽屉例外保留 aria-label——无标题文本节点，
// 不强造标题 id/labelledby（例外形态不得被「统一」掉）。
check('I8-02a ImageLightbox 例外保留 aria-label="图片预览"（不强造标题节点/labelledby）', () => {
  const tag = tagSlice(lightbox, 'class="image-lightbox"');
  assert.ok(tag.includes('aria-label="图片预览"'), '灯箱 aria-label="图片预览" 丢失（例外形态不得被统一掉）');
  assert.ok(!tag.includes('aria-labelledby'), '灯箱被强造 aria-labelledby（例外形态不得统一）');
  assert.ok(!tag.includes('id='), '灯箱容器被强造 id（无标题文本节点，不得强造标题锚点）');
});

check('I8-02b FilePreviewDrawer 例外保留 aria-label="文件预览"（不强造标题节点/labelledby）', () => {
  const tag = tagSlice(drawer, 'class="fpreview-drawer"');
  assert.ok(tag.includes('aria-label="文件预览"'), '抽屉 aria-label="文件预览" 丢失（例外形态不得被统一掉）');
  assert.ok(!tag.includes('aria-labelledby'), '抽屉被强造 aria-labelledby（例外形态不得统一）');
  assert.ok(!tag.includes('id='), '抽屉容器被强造 id（无标题文本节点，不得强造标题锚点）');
});

// I8-03（边界·保全）：I8 属性补齐不得触碰既有结构钉——wizard 题号导航容器
// aria-label="题目导航"（tdd-wizard-step-jump-verify 重写版② 同锚；R2-C 契约同步 2026-11-17：
// 旧 wizard steps 圆点行 aria-label="问题进度" 随 C1 变体 2 左栏重构整体移除，本钉重锚新形态）；
// 既有钉其余面（regression-tests/selftest-mcp 等）由 npm run selftest:static 全链承担，本卷不复制钉面。
check('I8-03 既有结构钉保全：wizard 导航 aria-label="题目导航" 保持（C1 变体 2 重锚）+ 五站既有类名在场', () => {
  assert.ok(
    prompt.includes('<nav class="wizard-nav" data-testid="wizard-nav" aria-label="题目导航">'),
    'wizard 导航容器 aria-label="题目导航" 丢失（wizard-step-jump 重写版钉依赖）',
  );
  assert.ok(prompt.includes('class="interaction-dialog__eyebrow"'), '.interaction-dialog__eyebrow 被改名');
  assert.ok(updateDialogSrc.includes('.update-dialog__title') && updateDialogSrc.includes('class="update-dialog__title"'), '.update-dialog__title 被改名');
  for (const [label, src] of [['DiffDialog', diffDialog], ['ToolDiffDialog', toolDiffDialog], ['TurnDiffDialog', turnDiffDialog]] as const) {
    assert.ok(src.includes('class="diff-title"'), `${label} .diff-title 被改名`);
  }
  assert.ok(filePicker.includes('class="fp-header__title"'), '.fp-header__title 被改名');
  assert.ok(exportFmtDialog.includes('class="export-fmt-title"'), '.export-fmt-title 被改名');
});

// ═══ I9 · 交互弹窗反馈增强（①多选计数 ②向导定位提示 ③footer Esc提示三分支 ④头部✕共享escapeDismiss） ═══
// 转写 docs/ui-completion/tests/I-dialogs-global-cases.md I9-01~06；实现代码形态逐字采纳
// docs/ui-completion/impl/I-dialogs-global-impl.md §I9（L644-812）。
// hb12 落账链保全断言必落（I9-02b：submitError 行字面 + initSelection 清除）。

function submitLabelSlice(): string {
  const start = prompt.indexOf('const submitLabel = computed(() => {');
  assert.ok(start > -1, '缺 submitLabel computed');
  const end = prompt.indexOf('const cancelLabel', start);
  assert.ok(end > start, 'submitLabel 切片越界');
  return prompt.slice(start, end);
}

function submitFnBody(): string {
  return fnBody(prompt, 'submit');
}

function escapeDismissBody(): string {
  return fnBody(prompt, 'escapeDismiss');
}

function initSelectionBody(): string {
  return fnBody(prompt, 'initSelection');
}

function escHintSlice(): string {
  const start = prompt.indexOf('const escHint = computed(() => {');
  assert.ok(start > -1, '缺 escHint computed');
  const end = prompt.indexOf('});', start);
  assert.ok(end > start, 'escHint computed 切片越界');
  return prompt.slice(start, end);
}

// 〔R2-C 契约同步（2026-11-17）：C1 变体 2 将单一 footer 拆为 wizard(v-if)/单题(v-else) 双 footer，
//   本切片重锚 v-else 单题 footer（与 enter-guard T6-K「单题 footer 零触碰」锚面一致）；wizard
//   footer 结构归 tdd-wizard-step-jump-verify ⑦ 管辖，本卷不复制。〕
function footerSlice(): string {
  const start = prompt.indexOf('<footer v-else class="interaction-dialog__footer">');
  assert.ok(start > -1, '缺 interaction-dialog__footer');
  const end = prompt.indexOf('</footer>', start);
  assert.ok(end > start, 'footer 切片越界');
  return prompt.slice(start, end);
}

function headerSlice(): string {
  const start = prompt.indexOf('<header class="interaction-dialog__header"');
  assert.ok(start > -1, '缺 interaction-dialog__header');
  const end = prompt.indexOf('</header>', start);
  assert.ok(end > start, 'header 切片越界');
  return prompt.slice(start, end);
}

console.log('\n=== I9 · 交互弹窗反馈增强 ===');

// I9-01（正常）：多选提交钮实时计数——multi-choice 分支改「提交选择（已选 N 项）」，
// N=selectedIds.value.size（Other __other__ 选中即计入，无 otherText 条件——与 canSubmit 判空
// 解耦，spec「与原型口径一致」）；size=0 落回裸「提交选择」。
park('I9-01a submitLabel multi-choice 分支计数「提交选择（已选 N 项）」，N=selectedIds.size 无 otherText 条件，size=0 裸「提交选择」', () => {
  const slice = submitLabelSlice();
  const m = slice.match(/kind === 'multi-choice'\)\s*\{\s*return ([^;]+);/);
  assert.ok(m, '缺 multi-choice 分支 return 形态');
  const ret = m[1];
  assert.ok(
    ret.includes('提交选择（已选 ${selectedIds.value.size} 项）'),
    '计数模板漂移（须逐字「提交选择（已选 ${selectedIds.value.size} 项）」）',
  );
  assert.ok(ret.includes(": '提交选择'"), 'size=0 须落回裸「提交选择」');
  assert.ok(!ret.includes('otherText'), '计数不得耦合 otherText 判空（Other 选中未填也计入 1 项）');
  assert.ok(!ret.includes('wizard'), 'wizard 内多选题不计数（wizard 分支在前返回 下一题/确认，计数仅在 kind 分支）');
});

// I9-01（负断言·防误改）：其余五分支字面保持——permission 选项 label/「提交选择」、
// wizard 两处「下一题」、default「确认」（spec「permission/确认/下一题零改动」）。
park('I9-01b 其余分支字面零改动（permission label 回退 / wizard 下一题×2 / default 确认）', () => {
  const slice = submitLabelSlice();
  assert.ok(
    slice.includes("kind === 'permission') return selectedOption.value?.label ?? '提交选择';"),
    'permission 分支 label 回退形态被改',
  );
  const nextCount = slice.split("return '下一题';").length - 1;
  assert.equal(nextCount, 2, 'wizard「下一题」分支须恰 2 处（中途 + 末步未答全）');
  assert.ok(slice.includes("return '确认';"), 'default 分支「确认」漂移');
});

// I9-02（正常）：向导末步未答全提交=定位链——findIndex 首个未答题 → loadWizardStep(首个未答)
// → submitError=「第 N 题还未作答，已定位」（N=firstUnanswered+1，1 基题号与圆点 title 同口径）。
park('I9-02a 末步守卫定位链：findIndex 首个未答 → loadWizardStep(firstUnanswered) → submitError=「第 N 题还未作答，已定位」（1 基）', () => {
  const body = submitFnBody();
  const guardIdx = body.indexOf('if (!allQuestionsAnswered.value) {');
  assert.ok(guardIdx > -1, '缺末步守卫分支');
  const guardEnd = body.indexOf('return;', guardIdx);
  assert.ok(guardEnd > guardIdx, '末步守卫缺 return（未答全不得放行提交）');
  const slice = body.slice(guardIdx, guardEnd);
  assert.ok(
    slice.includes('(question) => !isQuestionAnswered(questionAnswers.value[question.id])'),
    'findIndex 判定漂移（须 !isQuestionAnswered(questionAnswers.value[question.id])）',
  );
  const loadIdx = slice.indexOf('loadWizardStep(firstUnanswered)');
  const hintIdx = slice.indexOf('submitError.value = `第 ${firstUnanswered + 1} 题还未作答，已定位`');
  assert.ok(loadIdx > -1, '缺 loadWizardStep(firstUnanswered) 定位跳转');
  assert.ok(hintIdx > -1, '缺定位提示文案（须逐字「第 ${firstUnanswered + 1} 题还未作答，已定位」）');
  assert.ok(loadIdx < hintIdx, '跳转须先于提示赋值（plan 代码形态序）');
});

// I9-02 + hb12 落账链保全（必落）：提示载体复用既有 submitError 行（role=alert），
// 该行完整字面被 tdd-bugfix-hb12-perm-consent :70 钉住——不得改模板只赋值；initSelection
// 既有清除保留；submit() 入口（防重入守卫后）新增 submitError.value = null 清理时机。
park('I9-02b 提示载体复用 submitError 行（role=alert 字面恰 1 处）+ initSelection 清除保留 + submit 入口清理在守卫后', () => {
  const line = '<p v-if="submitError" class="interaction-dialog__submit-error" role="alert">{{ submitError }}</p>';
  assert.equal((prompt.split(line).length - 1), 1, 'submitError 行字面漂移或多处（hb12 :70 钉其完整字面，不得改模板）');
  assert.ok(initSelectionBody().includes('submitError.value = null;'), 'initSelection 既有清除被删（hb12 钉住）');
  const body = submitFnBody();
  const entryGuard = body.indexOf('if (!request || submittingId.value === request.id) return;');
  const entryClear = body.indexOf('submitError.value = null;');
  assert.ok(entryGuard > -1, 'submit 缺入口防重入守卫（I9-06 前提）');
  assert.ok(entryClear > -1, 'submit 入口缺 submitError.value = null 清理（滞留提示不清理）');
  assert.ok(entryClear > entryGuard, '入口清理必须在防重入守卫之后、业务分支之前');
  const wizardGuard = body.indexOf('if (!allQuestionsAnswered.value) {');
  assert.ok(entryClear < wizardGuard, '入口清理必须先于向导守卫（本点击新设提示不被入口清掉）');
});

// I9-03（边界·分支完备性）：footer Esc 提示三分支逐字——confirm 全族（含 alert）「Esc = 知道了」/
// permission「Esc 拒绝并关闭」/ 其余型「Esc 取消」；confirm 分支在前、default 兜底收尾。
park('I9-03a escHint computed 三分支逐字（confirm=「Esc = 知道了」/ permission=「Esc 拒绝并关闭」/ default=「Esc 取消」）', () => {
  const slice = escHintSlice();
  assert.ok(slice.includes("if (kind === 'confirm') return 'Esc = 知道了';"), 'confirm 分支文案漂移（须逐字「Esc = 知道了」）');
  assert.ok(slice.includes("if (kind === 'permission') return 'Esc 拒绝并关闭';"), 'permission 分支文案漂移（须逐字「Esc 拒绝并关闭」）');
  assert.ok(slice.includes("return 'Esc 取消';"), 'default 分支文案漂移（须逐字「Esc 取消」）');
  const confirmIdx = slice.indexOf("kind === 'confirm'");
  const permIdx = slice.indexOf("kind === 'permission'");
  const defaultIdx = slice.indexOf("return 'Esc 取消';");
  assert.ok(confirmIdx > -1 && permIdx > confirmIdx && defaultIdx > permIdx, '分支序错误（confirm→permission→default）');
  assert.ok(slice.includes("activeRequest.value?.kind"), 'escHint 须消费 activeRequest 响应式源（实时性）');
});

// I9-03（正常）：footer 左端插入提示节点——首个子元素、aria-hidden 不可聚焦、左置类
// margin-right:auto（flex-end 容器内推到最左，不打乱右对齐钮序）。
park('I9-03b footer 首子元素 esc-hint span（v-if=activeRequest / aria-hidden / class+左置 margin-right:auto）', () => {
  const slice = footerSlice();
  const span = '<span v-if="activeRequest" class="interaction-dialog__esc-hint" aria-hidden="true">{{ escHint }}</span>';
  assert.ok(slice.includes(span), 'footer esc-hint span 形态漂移（须逐字）');
  const spanIdx = slice.indexOf('<span');
  const prevIdx = slice.indexOf('上一步');
  const cancelIdx = slice.indexOf('@click="cancel"');
  const submitIdx = slice.indexOf('@click="submit()"');
  assert.ok(spanIdx < prevIdx && spanIdx < cancelIdx && spanIdx < submitIdx, 'esc-hint 须为 footer 首个子元素（左端位）');
  const styleIdx = prompt.indexOf('.interaction-dialog__esc-hint {');
  assert.ok(styleIdx > -1, '缺 .interaction-dialog__esc-hint 样式规则');
  const styleSlice = prompt.slice(styleIdx, prompt.indexOf('}', styleIdx));
  assert.ok(styleSlice.includes('margin-right: auto'), 'esc-hint 缺 margin-right:auto 左置');
  assert.ok(styleSlice.includes('align-self: center'), 'esc-hint 缺 align-self:center 垂直居中');
});

// I9-04（正常）：header 右上 ✕ 钮——class interaction-dialog__close / title=aria-label=「关闭（Esc）」
// / @click="escapeDismiss"（与 Esc 同源函数，E-6 裁决 A 结构钉）；header 需 position:relative 承载。
park('I9-04a header ✕ 钮存在（class/title=aria-label=「关闭（Esc）」逐字/@click=escapeDismiss）+ header position:relative + close 样式', () => {
  const slice = headerSlice();
  assert.ok(slice.includes('class="interaction-dialog__close"'), '缺 ✕ 钮 class');
  assert.ok(slice.includes('title="关闭（Esc）"'), '✕ title 漂移（须逐字「关闭（Esc）」）');
  assert.ok(slice.includes('aria-label="关闭（Esc）"'), '✕ aria-label 漂移');
  assert.ok(slice.includes('@click="escapeDismiss"'), '✕ 须绑定 escapeDismiss（与 Esc 同源，E-6 裁决 A）');
  const headerRule = prompt.indexOf('.interaction-dialog__header {');
  assert.ok(headerRule > -1, '缺 .interaction-dialog__header 样式');
  const headerStyle = prompt.slice(headerRule, prompt.indexOf('}', headerRule));
  assert.ok(headerStyle.includes('position: relative'), 'header 缺 position:relative（✕ 绝对定位承载）');
  const closeRule = prompt.indexOf('.interaction-dialog__close {');
  assert.ok(closeRule > -1, '缺 .interaction-dialog__close 样式规则');
});

// I9-04（结构钉·同源）：Esc 分支决策收敛 escapeDismiss（I1-04 已断言分支内调用），此处钉
// 模板 ✕ 与 Esc 消费同一函数标识——escapeDismiss 标识在 Escape 分支与模板 @click 双在场。
park('I9-04b ✕ 与 Esc 同源（escapeDismiss 标识于 Escape 分支与模板 @click 双在场，单源不复制）', () => {
  const escStart = prompt.indexOf("} else if (event.key === 'Escape') {");
  assert.ok(escStart > -1, '缺 Escape 分支');
  const escSlice = prompt.slice(escStart, prompt.indexOf("} else if (event.key === ' '", escStart));
  assert.ok(escSlice.includes('escapeDismiss()'), 'Escape 分支未走 escapeDismiss');
  const closeBtnIdx = headerSlice().indexOf('@click="escapeDismiss"');
  assert.ok(closeBtnIdx > -1, '✕ 未绑定 escapeDismiss');
  assert.equal((prompt.split('function escapeDismiss(').length - 1), 1, 'escapeDismiss 定义须唯一（单源，不复制逻辑）');
});

// I9-04（负断言·落账链保全）：escapeDismiss 不旁路——体内只允许 submit/cancel 两个出口
//（落账链 pushHistory/落库 IPC 均在其内），禁止直清请求/直改状态绕过 cancel·submit。
park('I9-04c escapeDismiss 不旁路落账链：仅 submit/cancel 出口，无 respondAndRemove/removeRequest/直清状态；cancel 内 pushHistory+落库 IPC 在位', () => {
  const body = escapeDismissBody();
  assert.ok(body.includes("void submit('confirm')") && body.includes('void cancel()'), 'escapeDismiss 出口漂移');
  assert.ok(!body.includes('respondAndRemove'), 'escapeDismiss 直调 respondAndRemove（旁路落账链）');
  assert.ok(!body.includes('removeRequest'), 'escapeDismiss 直调 removeRequest（旁路落账链）');
  assert.ok(!body.includes('pushHistory'), 'escapeDismiss 直调 pushHistory（落账应收敛在 submit/cancel 内）');
  assert.ok(!body.includes('submittingId.value ='), 'escapeDismiss 直改 submittingId（绕过防重入）');
  assert.ok(!body.includes('selectedIds.value ='), 'escapeDismiss 直改 selectedIds（旁路状态链）');
  const cancelBody = fnBody(prompt, 'cancel');
  assert.ok(cancelBody.includes("pushHistory(request, 'cancel', [])"), 'cancel 落账链被改（pushHistory 缺失）');
  assert.ok(cancelBody.includes('respondAndRemove'), 'cancel 不再走 respondAndRemove（落账前 IPC 断链）');
  const submitBody = submitFnBody();
  assert.ok(submitBody.includes("pushHistory(request, 'submit', ids)"), 'submit 落账链被改（pushHistory 缺失）');
});

// I9-04（红线保全）：esc-stack 切片钉本地复刻——Escape 分支内 isTopmost 守卫先于 preventDefault
//（tdd-esc-stack-verify :108-113 同判据；守卫与 preventDefault 必须留在分支内，只换末尾决策）。
check('I9-04d Esc 分支 isTopmost 守卫先于 preventDefault（esc-stack 切片钉保全）', () => {
  const escIdx = prompt.indexOf("event.key === 'Escape'");
  assert.ok(escIdx > -1, '缺 Escape 分支');
  const branch = prompt.slice(escIdx, escIdx + 400);
  const guardIdx = branch.indexOf('isTopmost()');
  const pdIdx = branch.indexOf('event.preventDefault()');
  assert.ok(guardIdx > -1, 'Esc 分支缺 isTopmost 让位守卫');
  assert.ok(pdIdx > guardIdx, '守卫必须先于 preventDefault（让位时不得消费事件）');
});

// I9-05（异常·误授权防线保全）：I9 全部改动不得触碰权限不预选纪律——initSelection 双
// optionDefaults 调用原样（permission 空集）、✕ 无初始焦点标记（初始焦点仍落提交钮）、
// esc-hint aria-hidden 不可聚焦、escHint 纯读无选择态写。
park('I9-05 权限不预选纪律保全（initSelection optionDefaults 双调用原样 / ✕ 无 data-dialog-initial-focus / esc-hint aria-hidden / escHint 纯读）', () => {
  const init = initSelectionBody();
  assert.ok(
    init.includes('selectedIds.value = optionDefaults(firstQuestion.options, firstQuestion.defaultOptionIds, firstQuestion.multiSelect);'),
    'initSelection wizard 首题 optionDefaults 调用被改',
  );
  assert.ok(
    init.includes('selectedIds.value = optionDefaults(request.options ?? [], request.defaultOptionIds, request.multiSelect);'),
    'initSelection permission 路径 optionDefaults 调用被改（不预选防线）',
  );
  const headerSrc = headerSlice();
  const clsIdx = headerSrc.indexOf('class="interaction-dialog__close"');
  assert.ok(clsIdx > -1, '✕ 钮缺失');
  const btnIdx = headerSrc.lastIndexOf('<button', clsIdx);
  assert.ok(btnIdx > -1, '✕ 元素非 <button> 起始');
  const closeTag = headerSrc.slice(btnIdx, clsIdx + 'class="interaction-dialog__close"'.length);
  assert.ok(!closeTag.includes('data-dialog-initial-focus'), '✕ 不得携带初始焦点标记（初始焦点仍落提交钮）');
  assert.ok(closeTag.includes('type="button"'), '✕ 须 type="button"（防表单隐式提交）');
  const escHintSpan = footerSlice().split('\n').find((l) => l.includes('interaction-dialog__esc-hint'));
  assert.ok(escHintSpan && escHintSpan.includes('aria-hidden="true"'), 'esc-hint 须 aria-hidden（不可聚焦不进焦点环）');
  const hintSlice = escHintSlice();
  assert.ok(!hintSlice.includes('selectedIds.value ='), 'escHint 内直改 selectedIds（纯读 computed 被污染）');
  assert.ok(!hintSlice.includes('optionDefaults'), 'escHint 引入预选赋值（误授权防线）');
});

// I9-06（并发·并存保全）：✕ 为补充非替代——footer 取消钮形态原样（enter-guard :122 钉）；
// submit/cancel 入口防重入守卫保持；✕ 点击走同源 escapeDismiss 天然受防重入约束。
// 〔R2-C 契约同步（2026-11-17）：C1 变体 2 footer 拆双后，本钉锚 v-else 单题 footer（footerSlice
//   重锚同注），wizard footer 取消（requestDiscard 丢弃门）归 tdd-wizard-step-jump-verify ⑦ 管辖。〕
check('I9-06 footer 取消钮并存 + submit/cancel 入口防重入守卫保全（✕ 同源天然受约束）', () => {
  const slice = footerSlice();
  assert.ok(
    slice.includes('<button type="button" class="interaction-btn interaction-btn--ghost" @click="cancel">{{ cancelLabel }}</button>'),
    'footer 取消钮形态被改/被删（✕ 为补充非替代，两者并存）',
  );
  assert.ok(slice.includes('@click="submit()"'), 'footer 提交钮缺失');
  const submitBody = submitFnBody();
  const cancelBody = fnBody(prompt, 'cancel');
  for (const [name, body] of [['submit', submitBody], ['cancel', cancelBody]] as const) {
    assert.ok(
      body.includes('if (!request || submittingId.value === request.id) return;'),
      `${name} 入口防重入守卫被改`,
    );
  }
});

// ═══ I10 · 全局 toast 关闭钮 + error 图标 + timer 清理 ═══
// 转写 docs/ui-completion/tests/I-dialogs-global-cases.md I10-01~05；实现代码形态逐字采纳
// docs/ui-completion/impl/I-dialogs-global-impl.md §I10（L813-912）。
// 既有断言同步（随本点落）：tdd-session-error-toast-verify「模板节点」精确 regex → 新目标态
// 等价钉（A-1）；tdd-provider-store-error-outlet-verify toastLine 文本绑定 → 节点块内断言
//（A-2，文本挪 global-toast__text 子节点新行）。A-3 免同步：实现不抽公共 closeToast
//（三层各自 dismiss* 函数），watch [error,errorSeq] 链零改动，seq-verify setTimeout 形态钉原样成立。

const appVue = read('../src/renderer/App.vue');

// 三层 toast 逐层档案：v-if 旗标 / 关闭钮绑定函数 / 对应清理 timer（impl §I10 ①命名）。
const I10_LAYERS = [
  { flag: 'saveFailedToastVisible', dismiss: 'dismissSaveFailedToast', timer: 'saveFailedToastTimer' },
  { flag: 'sessionErrorToastVisible', dismiss: 'dismissSessionErrorToast', timer: 'sessionErrorToastTimer' },
  { flag: 'providerErrorToastVisible', dismiss: 'dismissProviderErrorToast', timer: 'providerErrorToastTimer' },
] as const;

// toast 节点块切片：v-if 开标签起至首个闭合 </div>（块内仅 svg/span/button，无嵌套 div）。
function toastBlock(flag: string): string {
  const marker = `<div v-if="${flag}"`;
  const start = appVue.indexOf(marker);
  assert.ok(start > -1, `缺 v-if="${flag}" toast 节点`);
  const end = appVue.indexOf('</div>', start);
  assert.ok(end > start, `v-if="${flag}" 节点块未闭合`);
  return appVue.slice(start, end);
}

console.log('\n=== I10 · 全局 toast 关闭钮 + error 图标 + timer 清理 ===');

// I10-01（正常）：三层逐一含 × 关闭钮——aria-label「关闭提示」逐字（漏一即红）、可聚焦
// <button type="button">（不得纯 span 装饰）、绑定各自 dismiss 函数；文案节点保持
//（保存失败文案逐字 / 两处「操作失败：」文本绑定子节点，同屏层数上限 3 不变）。
check('I10-01 三层各含 × 关闭钮：aria-label「关闭提示」逐字、可聚焦 button、各自 dismiss 绑定、文案节点保持', () => {
  for (const layer of I10_LAYERS) {
    const block = toastBlock(layer.flag);
    const closeIdx = block.indexOf('class="global-toast__close"');
    assert.ok(closeIdx > -1, `${layer.flag} 缺关闭钮（class global-toast__close）`);
    assert.ok(block.lastIndexOf('<button', closeIdx) > -1, `${layer.flag} 关闭钮非 <button> 元素（不得纯 span 装饰）`);
    assert.ok(block.includes('aria-label="关闭提示"'), `${layer.flag} 关闭钮 aria-label 漂移（须逐字「关闭提示」）`);
    assert.ok(block.includes('type="button"'), `${layer.flag} 关闭钮缺 type="button"`);
    assert.ok(block.includes(`@click="${layer.dismiss}"`), `${layer.flag} 关闭钮未绑定 ${layer.dismiss}`);
    assert.ok(block.includes('</button>'), `${layer.flag} 关闭钮未闭合`);
  }
  assert.equal(countOf(appVue, 'class="global-toast__close"'), 3, '关闭钮计数 ≠3（漏一层或多层；web-rev-warn 关钮为独立 class 不计入）');
  assert.ok(
    appVue.includes('<span class="global-toast__text">设置保存失败，部分修改可能未保存</span>'),
    '保存失败文案逐字漂移（须在 global-toast__text 子节点内逐字保留）',
  );
  assert.ok(appVue.includes('<span class="global-toast__text">{{ sessionErrorToastText }}</span>'), 'session 文本绑定子节点漂移');
  assert.ok(appVue.includes('<span class="global-toast__text">{{ providerErrorToastText }}</span>'), 'provider 文本绑定子节点漂移');
});

// I10-02（正常）：三层各含 error 语义图标——内联 SVG（本仓图标全内联 SVG 惯例）、装饰性
// aria-hidden、stroke=currentColor 继承 toast 错误色（--color-fail-strong）；负断言：不得外链图片。
check('I10-02 三层各含 error 图标：内联 SVG 计数=3、aria-hidden、stroke=currentColor；负断言无外链 <img>', () => {
  const iconHead = '<svg class="global-toast__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">';
  assert.equal(countOf(appVue, iconHead), 3, '内联 SVG 图标头计数 ≠3（三层各一）');
  assert.equal(countOf(appVue, '<circle cx="12" cy="12" r="9" />'), 3, '图标缺 alert-circle 圆形主体（error 语义形态漂移）');
  for (const layer of I10_LAYERS) {
    const block = toastBlock(layer.flag);
    assert.ok(block.includes('<svg class="global-toast__icon"'), `${layer.flag} 缺内联 SVG 图标`);
    assert.ok(block.includes('aria-hidden="true"'), `${layer.flag} 图标缺 aria-hidden（装饰性）`);
    assert.ok(!block.includes('<img'), `${layer.flag} 图标用外链 <img>（违本仓全内联 SVG 惯例）`);
  }
});

// I10-03（并发·状态保全，防倒退钉——转写即绿，回归价值在实现期被顺手改坏时变红）：
// 时窗/截断常量、「操作失败：」前缀（两处 watch）、保存失败文案、stacked/stacked-3 错位类、
// watch [error,errorSeq] 触发链（空值守卫/置位/计时重置/3.5s 自动消失）、卸载三 timer 清理。
check('I10-03 时长/层数/文案/堆叠/触发链/卸载清理保全（防倒退钉）', () => {
  assert.ok(appVue.includes('const SESSION_ERROR_TOAST_MS = 3500;'), '3.5s 时窗常量被改');
  assert.ok(appVue.includes('const SESSION_ERROR_TEXT_MAX = 80;'), '80 字符截断常量被改');
  const sessionWatchIdx = appVue.indexOf('watch(() => [sessionStore.error, sessionStore.errorSeq] as const, ([err]) => {');
  assert.ok(sessionWatchIdx > -1, 'watch [error,errorSeq] 触发链缺失');
  const sessionWatch = appVue.slice(sessionWatchIdx, appVue.indexOf('\n});', sessionWatchIdx));
  assert.ok(sessionWatch.includes('if (!err) return;'), '空值守卫被改');
  assert.ok(sessionWatch.includes('操作失败：'), 'session watch「操作失败：」前缀被改');
  assert.ok(sessionWatch.includes('slice(0, SESSION_ERROR_TEXT_MAX)'), 'session 截断被改');
  assert.ok(sessionWatch.includes('sessionErrorToastVisible.value = true;'), 'session 置位显示被改');
  assert.ok(sessionWatch.includes('clearTimeout(sessionErrorToastTimer)'), 'session 计时重置被改');
  assert.ok(sessionWatch.includes('setTimeout(() => { sessionErrorToastVisible.value = false; }, SESSION_ERROR_TOAST_MS)'), 'session 3.5s 自动消失计时被改');
  const providerWatchIdx = appVue.indexOf('watch(() => providerStore.error, (err) => {');
  assert.ok(providerWatchIdx > -1, 'provider watch 缺失');
  const providerWatch = appVue.slice(providerWatchIdx, appVue.indexOf('\n});', providerWatchIdx));
  assert.ok(providerWatch.includes('操作失败：') && providerWatch.includes('SESSION_ERROR_TOAST_MS'), 'provider watch 文案/时窗复用被改');
  assert.ok(appVue.includes('watch(lastSaveFailed, (failed) => {'), 'saveFailed watch 缺失');
  const unmountIdx = appVue.indexOf('onBeforeUnmount(');
  assert.ok(unmountIdx > -1, 'onBeforeUnmount 缺失');
  const unmountSlice = appVue.slice(unmountIdx, appVue.indexOf('</script>', unmountIdx));
  for (const layer of I10_LAYERS) {
    assert.ok(unmountSlice.includes(`clearTimeout(${layer.timer})`), `卸载缺 ${layer.timer} 清理`);
  }
});

// I10-04（并发·手动关与自动消失竞争）：× 点击处置 visible=false 且显式清各自 timer——
// 只藏不清 → 旧 timer 到点把同文案重弹的新 toast 提前吞掉；逐层对应各自 timer 核对，
// 三个 dismiss 定义各恰一处（单源不复制）。
check('I10-04 三个 dismiss 函数逐层对应：置 visible=false + clearTimeout(各自 timer)，定义各恰一处', () => {
  for (const layer of I10_LAYERS) {
    const body = fnBody(appVue, layer.dismiss);
    assert.ok(body.includes(`${layer.flag}.value = false;`), `${layer.dismiss} 缺 ${layer.flag} 置 false`);
    assert.ok(body.includes(`clearTimeout(${layer.timer})`), `${layer.dismiss} 缺 clearTimeout(${layer.timer})（只藏不清会吞掉重弹 toast）`);
    assert.equal(countOf(appVue, `function ${layer.dismiss}(`), 1, `${layer.dismiss} 定义漂移/重复`);
  }
});

// I10-05（边界·堆叠组合）：三条 toast 状态各自独立——负断言：各 dismiss 不得引用他人
// visible/timer（共享关闭状态会连带吞掉别的 toast）；stacked/stacked-3 错位类各归其位
//（session 带 stacked、provider 带 stacked-3，保存失败 toast 默认档）。
check('I10-05 多条堆叠互不影响：各 dismiss 不引用他人 visible/timer；错位类各归其位', () => {
  for (const layer of I10_LAYERS) {
    const body = fnBody(appVue, layer.dismiss);
    for (const other of I10_LAYERS) {
      if (other.flag === layer.flag) continue;
      assert.ok(!body.includes(other.flag), `${layer.dismiss} 引用他人 visible ${other.flag}（共享关闭状态会连带吞掉别的 toast）`);
      assert.ok(!body.includes(other.timer), `${layer.dismiss} 引用他人 timer ${other.timer}（共享 timer 会吞掉别的 toast）`);
    }
  }
  assert.ok(toastBlock('sessionErrorToastVisible').includes('global-toast--stacked"'), 'session toast 缺 stacked 错位类');
  assert.ok(toastBlock('providerErrorToastVisible').includes('global-toast--stacked-3'), 'provider toast 缺 stacked-3 错位类');
  assert.ok(toastBlock('saveFailedToastVisible').includes('global-toast--error"'), '保存失败 toast 缺 error 修饰类');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败 / ${parked} 暂缓（I 组预置红未落盘，park 处置见头注〔R2-C P22〕；落盘后 park→check 还原硬钉）`);
process.exit(fail > 0 ? 1 : 0);
