// tdd-ui-e-input-area-verify.ts
// E 输入区与工具栏契约脚本（E1~E6 各点共用卷；当前覆盖 E1、E2、E3、E4、E5、E6 节）
// （slate-ui-completion-1108-1428 round-001 点 E1「发送钮 ink 化 + Enter 角标」；
//   用例正本 = docs/ui-completion/tests/E-input-area-cases.md §E1 E1-01～E1-07；
//   实现基准 = docs/ui-completion/impl/E-input-area-impl.md §1）
//   · E1-01 发送钮背景/字色引用 A2 定稿 ink 对 token（用例卷待裁决项 1 已由计划回填：
//           var(--color-btn-ink) / var(--color-on-btn-ink)）；负断言：button 规则块切片
//           不再含 `background: var(--color-accent)`。A2-4 同款「切片零硬编码 hex」负断言
//           已由 tdd-tokens-inkstone-verify.ts A2-4 对同一切片钉过（var(--color-*) 形态 +
//           零 hex），本卷不重复钉死同一形态——只钉具体 token 名（避免同切片双份 pin 互相牵动）。
//   · E1-02 Enter 角标：钮内 svg 带装饰性标记 aria-hidden="true"（corner-down-left 语义），
//           「发送」文本节点保留；data-testid / @click="submit" 语义逐字保留。
//   · E1-03 button:disabled 含 opacity: 0.5（A2-5 只钉 (0,1) 开区间可计算差异，本卷钉裁决值）。
//   · E1-04 附件-only 可发送语义：① 模板 :disabled 表达式逐字（外部禁用 + 空内容判定；
//           regression-tests.ts:767 正则钉同源）；② submit() 早退分支
//           `!props.modelValue.trim() && !props.hasAttachments`；③ 主进程「附件-only（空文字）
//           应允许」校验钉由既有 regression-tests.ts 保持绿（不重钉）。
//   · E1-05 IME 组合中 Enter 不发送：既有 tdd-bugfix-n3-ime-composing-guard-verify ②③
//           保持绿（selftest:static 全量兑现；本卷不重钉既有守卫窗口）。
//   · E1-06 聚焦环可见：main.css 全局 `button:focus-visible` outline 焦点环声明存在；
//           ChatInput 发送钮切片零 outline 覆写（不得 outline:none 关掉全局环；
//           实现稿 §1.2(2) 裁决：聚焦环由全局规则承担，组件侧不新增不覆写）。
//           E1-06②（深浅两主题 Tab 聚焦环目检）属用例卷目检申报项，无法自动化。
//   · E1-07 CDP 行为面落点 cdp-layout-e2e.mjs E1 场景组（墨石下发送钮 computed 底/字=ink 对
//           ——补全 A2 留下的消费者侧复核：A2 场景组裁决「断言变量解析值、元素 computed 留给
//           消费方 E1」由本点兑现——+ 旧板暖纸/终端回退 computed 抽验 + 角标 aria-hidden
//           行为面），本脚本尾部以存在钉守护该扩展不被静默拆链；点击→草稿清空→落库链由
//           test:cdp:commands-e2e 既有链保持绿。
// 形态对齐 tdd-tokens-inkstone-verify.ts：check/readRel、`结果：N 通过 / M 失败` 末行、
// fail>0 则 process.exit(1)。运行：npx tsx scripts/tdd-ui-e-input-area-verify.ts
// （登记 scripts/selftest-static-list.txt 与 tsconfig.tdd.json 两处）。

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
function readRel(p: string): string {
  const abs = path.resolve(__dirname, '..', p);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8');
}

console.log('=== E 输入区契约 · E1 发送钮 ink 化 + Enter 角标 ===');

// 发送钮样式切片（`button {` 规则块起点 → `</style>`；与 A2-4 同窗口口径）
function sendButtonStyleSlice(): { ci: string; slice: string } {
  const ci = readRel('src/renderer/components/chat/ChatInput.vue');
  const styleIdx = ci.indexOf('<style scoped>');
  assert.ok(styleIdx !== -1, 'ChatInput.vue 无 scoped 样式块');
  const from = ci.indexOf('button {', styleIdx);
  assert.ok(from !== -1, '发送钮 button 样式块不存在');
  const to = ci.indexOf('</style>', from);
  assert.ok(to > from, '</style> 右界未找到');
  return { ci, slice: ci.slice(from, to) };
}

// 发送钮模板切片（`<button … data-testid="chat-send-button" …</button>`）
function sendButtonTemplateSlice(): string {
  const ci = readRel('src/renderer/components/chat/ChatInput.vue');
  const testidIdx = ci.indexOf('data-testid="chat-send-button"');
  assert.ok(testidIdx !== -1, '发送钮 data-testid 锚点缺失');
  const from = ci.lastIndexOf('<button', testidIdx);
  assert.ok(from !== -1, '<button 开标签未找到');
  const to = ci.indexOf('</button>', testidIdx);
  assert.ok(to > from, '</button> 闭标签未找到');
  return ci.slice(from, to + '</button>'.length);
}

// ── E1-01 ink 对 token ──
check('E1-01 发送钮背景引用 ink 语义 token：background: var(--color-btn-ink)', () => {
  const { slice } = sendButtonStyleSlice();
  assert.ok(
    /background:\s*var\(--color-btn-ink\)/.test(slice),
    '发送钮背景未引用 var(--color-btn-ink)（仍留旧板 accent 或写死色值）',
  );
});
check('E1-01 发送钮字色引用 ink 对：color: var(--color-on-btn-ink)', () => {
  const { slice } = sendButtonStyleSlice();
  assert.ok(
    /^[ \t]*color:[ \t]*var\(--color-on-btn-ink\)/m.test(slice),
    '发送钮字色未引用 var(--color-on-btn-ink)',
  );
});
check('E1-01 负断言：button 规则块切片不再含 background: var(--color-accent)', () => {
  const { slice } = sendButtonStyleSlice();
  assert.ok(
    !slice.includes('background: var(--color-accent)'),
    'button 切片残留 background: var(--color-accent)（旧板 accent 未退场）',
  );
});

// ── E1-02 Enter 角标 ──
check('E1-02 钮内含角标 svg 且带 aria-hidden="true"（装饰性标记）', () => {
  const tpl = sendButtonTemplateSlice();
  assert.ok(/<svg\b/.test(tpl), '发送钮内无角标 svg 元素（角标漏加）');
  assert.ok(/<svg[^>]*aria-hidden="true"/.test(tpl), '角标 svg 缺 aria-hidden="true"（装饰性标记缺失）');
});
check('E1-02 「发送」文本节点保留 + @click="submit" 语义不变（E1-07 静态侧）', () => {
  const tpl = sendButtonTemplateSlice();
  assert.ok(tpl.includes('发送'), '「发送」文本节点丢失');
  assert.ok(tpl.includes('@click="submit"'), '@click="submit" 语义被动（发送链断裂）');
});

// ── E1-03 disabled 半透明态 ──
check('E1-03 button:disabled 含 opacity: 0.5（裁决值）', () => {
  const ci = readRel('src/renderer/components/chat/ChatInput.vue');
  const m = /button:disabled\s*\{([^}]*)\}/.exec(ci);
  assert.ok(m, 'button:disabled 样式块不存在');
  assert.match(m[1], /opacity:\s*0\.5\b/, 'disabled 块 opacity 不是 0.5');
});

// ── E1-04 附件-only 可发送语义 ──
check('E1-04 ① :disabled 表达式逐字保留（外部禁用 + 空内容判定；附件-only 放行）', () => {
  const tpl = sendButtonTemplateSlice();
  assert.ok(
    tpl.includes(':disabled="disabled || (!modelValue.trim() && !hasAttachments)"'),
    ':disabled 表达式被动（regression-tests.ts:767 正则钉同源）',
  );
});
check('E1-04 ② submit() 早退分支保留（disabled 外部禁用 + 附件-only 放行 + 发送链）', () => {
  const ci = readRel('src/renderer/components/chat/ChatInput.vue');
  const from = ci.indexOf('function submit(): void');
  assert.ok(from !== -1, 'submit() 函数不存在');
  const to = ci.indexOf('}', from);
  assert.ok(to > from, 'submit() 函数体右界未找到');
  const body = ci.slice(from, to);
  assert.ok(body.includes('if (props.disabled) return;'), 'submit() 外部禁用早退分支丢失');
  assert.ok(body.includes('!props.modelValue.trim() && !props.hasAttachments'), 'submit() 附件-only 放行分支丢失');
  assert.ok(body.includes("emit('send')"), "submit() 不再 emit('send')（发送链断裂）");
});

// ── E1-06 聚焦环 ──
check('E1-06 ① main.css 全局 button:focus-visible 焦点环声明存在', () => {
  const css = readRel('src/renderer/assets/styles/main.css');
  const idx = css.indexOf('button:focus-visible');
  assert.ok(idx !== -1, 'main.css 无 button:focus-visible 规则');
  assert.match(
    css.slice(idx, idx + 240),
    /outline:\s*2px solid var\(--color-accent\)/,
    'focus-visible 规则无 outline 焦点环声明',
  );
});
check('E1-06 ① 发送钮切片零 outline 覆写（不得 outline:none 关掉全局聚焦环）', () => {
  const { slice } = sendButtonStyleSlice();
  assert.ok(!/outline/i.test(slice), '发送钮切片出现 outline 覆写（会压制全局聚焦环）');
});

// ── E1-07 CDP 落点存在钉（行为断言本体在 cdp-layout-e2e.mjs E1 场景组）──
check('E1-07 cdp-layout-e2e.mjs 含 E1 场景组（runE1Scenarios 入口 + 发送钮 computed 探针 + 隔离 user-data-dir）', () => {
  const cdp = readRel('scripts/cdp-layout-e2e.mjs');
  assert.ok(cdp.includes('runE1Scenarios'), 'cdp-layout-e2e.mjs 缺 runE1Scenarios 场景组入口');
  assert.ok(cdp.includes('chat-send-button'), 'cdp-layout-e2e.mjs E1 场景缺发送钮 computed 探针');
  assert.ok(cdp.includes('--user-data-dir'), 'cdp-layout-e2e.mjs 未隔离 user-data-dir');
});

// ════════════════════════════════════════════════════════════════════════════
// E2 工具栏 chips 一体化（slate-ui-completion-1108-1428 点 E2；
// 用例正本 = docs/ui-completion/tests/E-input-area-cases.md §E2 E2-01～E2-11；
// 实现基准 = docs/ui-completion/impl/E-input-area-impl.md §2）
//   · E2-01 chips「图标+值」一体化结构钉：外置 svg.ctl__label-icon 元素全量消失；
//           工作空间/权限/模型/思考四触发钮元素内部各含一枚图标 svg（图标在钮内与值同钮）。
//   · E2-02 caret 全量消失（三文件分别负断言，不跨文件扫）：SessionToolbar 无 class="caret"
//           且无 ▾ 字符；ThinkingLevelSelector 无 tl-caret 且无 ▾；ProviderModelSelector
//           无 model-trigger__caret 且无 ⌃。
//   · E2-03 模型触发钮 accent 突出语义保留：accent 描边 + accent 弱底（color-mix）+ accent-strong 文字。
//   · E2-04 未选工作空间 warn 态：--warn 类绑定 / warn 50% 描边 + warn-strong 文字 /「未选择」
//           兜底文案 / title 全文逐字；E2-09 warn:hover 叠加规则显式声明（hover 全值 warn 描边）。
//   · E2-05 各钮 title 全文逐字保留（title 是工具提示唯一全文出口）。
//   · E2-07 尺寸结构钉（裁决：结构钉为主+目检）：.ctl__btn padding/max-width 与 .ctl gap
//           保留——chip 内加图标只增宽不缩热区（高度由 padding 撑，≥ 改版前基线）；目检申报。
//   · E2-08 下拉打开行为与键盘不变：toggleWorkspaceMenu/showPermissionMenu/handleClickOutside
//           与工作空间菜单内部结构（📁 选择目录…/最近使用/删除/清除）保留；ThinkingLevelSelector
//           handleEscape（Esc 关菜单 + preventDefault）保留。
//   · E2-11 v-if="activeSession" 渲染门保留。
//   分工申报：E2-06 禁用矩阵静态钉（:disabled="sending" 恰 3 处/权限钮无 disabled/模型思考
//   零绑定）归既有 tdd-midrun-settings-unlock-verify 保持绿——本卷不重复钉同一形态（E1 先例）；
//   E2-10 中断钮归 tdd-hold-abort-verify C 组；E2-09 目检申报；E2-06④/E2-07 CDP 半落
//   cdp-layout-e2e.mjs E2 场景组。
// ════════════════════════════════════════════════════════════════════════════

console.log('\n=== E 输入区契约 · E2 工具栏 chips 一体化 ===');

// 按锚点字符串取「按钮开标签→闭标签」切片（图标入钮结构钉的提取器）
function buttonSliceByAnchor(src: string, anchor: string, label: string): string {
  const idx = src.indexOf(anchor);
  assert.ok(idx !== -1, `${label}：锚点 ${anchor} 缺失（钮未加 testid 或结构漂移）`);
  const from = src.lastIndexOf('<button', idx);
  assert.ok(from !== -1, `${label}：<button 开标签未找到`);
  const to = src.indexOf('</button>', idx);
  assert.ok(to > from, `${label}：</button> 闭标签未找到`);
  return src.slice(from, to + '</button>'.length);
}

function cssBlock(src: string, selector: string, label: string): string {
  const m = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(src);
  assert.ok(m, `${label}：样式规则 ${selector} 不存在`);
  return m[1];
}

const st = readRel('src/renderer/components/chat/SessionToolbar.vue');
const pms = readRel('src/renderer/components/chat/ProviderModelSelector.vue');
const tls = readRel('src/renderer/components/chat/ThinkingLevelSelector.vue');

// ── E2-01 一体化结构钉 ──
check('E2-01 负断言：SessionToolbar 外置图标 ctl__label-icon 全量消失（模板+样式）', () => {
  assert.ok(!st.includes('ctl__label-icon'), 'ctl__label-icon 残留（外置 label 图标未入钮）');
});
check('E2-01 工作空间触发钮内含图标 svg（ctl__btn-icon 在钮内）', () => {
  const tpl = buttonSliceByAnchor(st, 'data-testid="workspace-trigger"', '工作空间触发钮');
  assert.ok(/<svg\b/.test(tpl), '工作空间触发钮内无图标 svg');
  assert.ok(tpl.includes('ctl__btn-icon'), '工作空间触发钮图标未用 ctl__btn-icon 类');
});
check('E2-01 权限触发钮内含图标 svg（ctl__btn-icon 在钮内）', () => {
  const tpl = buttonSliceByAnchor(st, 'data-testid="permission-trigger"', '权限触发钮');
  assert.ok(/<svg\b/.test(tpl), '权限触发钮内无图标 svg');
  assert.ok(tpl.includes('ctl__btn-icon'), '权限触发钮图标未用 ctl__btn-icon 类');
});
check('E2-01 模型触发钮内含图标 svg（model-trigger__icon 在钮内；图标自 SessionToolbar 迁入）', () => {
  const tpl = buttonSliceByAnchor(pms, 'class="model-trigger"', '模型触发钮');
  assert.ok(/<svg\b/.test(tpl), '模型触发钮内无图标 svg');
  assert.ok(tpl.includes('model-trigger__icon'), '模型触发钮图标未用 model-trigger__icon 类');
  assert.ok(!st.includes('M5 5h14v14H5z'), '模型图标 svg 仍留在 SessionToolbar（未迁移）');
});
check('E2-01 思考触发钮内含图标 svg（tl-btn__icon 在钮内；图标自 SessionToolbar 迁入）', () => {
  const tpl = buttonSliceByAnchor(tls, "'tl-btn--custom'", '思考触发钮');
  assert.ok(/<svg\b/.test(tpl), '思考触发钮内无图标 svg');
  assert.ok(tpl.includes('tl-btn__icon'), '思考触发钮图标未用 tl-btn__icon 类');
  assert.ok(!st.includes('M9 18h6'), '思考图标 svg 仍留在 SessionToolbar（未迁移）');
});

// ── E2-02 caret 全量消失（三文件分别负断言） ──
check('E2-02 SessionToolbar 无 class="caret" 且无 ▾ 字符', () => {
  assert.ok(!st.includes('class="caret"'), 'SessionToolbar 残留 class="caret"');
  assert.ok(!st.includes('▾'), 'SessionToolbar 残留 ▾ 字符');
});
check('E2-02 ThinkingLevelSelector 无 tl-caret 且无 ▾ 字符', () => {
  assert.ok(!tls.includes('tl-caret'), 'ThinkingLevelSelector 残留 tl-caret');
  assert.ok(!tls.includes('▾'), 'ThinkingLevelSelector 残留 ▾ 字符');
});
check('E2-02 ProviderModelSelector 无 model-trigger__caret 且无 ⌃ 字符', () => {
  assert.ok(!pms.includes('model-trigger__caret'), 'ProviderModelSelector 残留 model-trigger__caret');
  assert.ok(!pms.includes('⌃'), 'ProviderModelSelector 残留 ⌃ 字符');
});

// ── E2-03 模型触发钮 accent 突出语义 ──
check('E2-03 model-trigger 保留 accent 描边 + accent 弱底 + accent-strong 文字', () => {
  const block = cssBlock(pms, '.model-trigger', '模型触发钮样式');
  assert.ok(block.includes('border: 1px solid var(--color-accent)'), 'accent 描边丢失');
  assert.ok(/background:\s*color-mix\(in srgb, var\(--color-accent\)/.test(block), 'accent 弱底（color-mix）丢失');
  assert.ok(block.includes('color: var(--color-accent-strong)'), 'accent-strong 文字丢失');
});

// ── E2-04 未选工作空间 warn 态 ──
check('E2-04 ① 工作空间钮保留 --warn 类绑定（!activeSession.workingDir 条件）', () => {
  const tpl = buttonSliceByAnchor(st, 'data-testid="workspace-trigger"', '工作空间触发钮');
  assert.ok(tpl.includes("'ctl__btn--warn': !activeSession.workingDir"), 'warn 类绑定丢失或条件被改');
});
check('E2-04 ② warn 形态保留：50% 描边 + warn-strong 文字（裁决形态零改动）', () => {
  const block = cssBlock(st, '.ctl__btn--warn', 'warn 样式');
  assert.ok(
    block.includes('color-mix(in srgb, var(--color-warn) 50%'),
    'warn 描边非 50% color-mix（裁决值被动）',
  );
  assert.ok(block.includes('var(--color-warn-strong)'), 'warn-strong 文字色丢失');
});
check('E2-04 ③ warn+hover 叠加可辨：--warn:hover 显式走全值 warn 描边（E2-09 自动化侧）', () => {
  const block = cssBlock(st, '.ctl__btn--warn:hover', 'warn:hover 样式');
  assert.ok(block.includes('border-color: var(--color-warn)'), 'warn:hover 描边未走全值 warn');
});
check('E2-04 ④ 「未选择」兜底文案 + title 全文逐字保留', () => {
  const tpl = buttonSliceByAnchor(st, 'data-testid="workspace-trigger"', '工作空间触发钮');
  assert.ok(
    tpl.includes(`:title="activeSession.workingDir ?? '未选择工作空间（运行前必须选择）'"`),
    '工作空间钮 title 全文被动',
  );
  assert.ok(st.includes(`if (!dir) return '未选择';`), 'workspaceLabel「未选择」兜底丢失');
});

// ── E2-05 title 全文逐字 ──
check('E2-05 权限触发钮 title 全文逐字（跟随全局默认分支 + 运行中切换即时生效）', () => {
  const tpl = buttonSliceByAnchor(st, 'data-testid="permission-trigger"', '权限触发钮');
  assert.ok(tpl.includes('本会话 Claude Code 权限模式（'), '权限 title 前缀被动');
  assert.ok(tpl.includes('跟随全局默认：'), '权限 title「跟随全局默认」分支丢失');
  assert.ok(tpl.includes('；运行中切换即时生效'), '权限 title 生效时机注记丢失');
});
check('E2-05 工作空间钮 title 二态绑定保留（已选=目录全路径 / 未选=全文兜底）', () => {
  const tpl = buttonSliceByAnchor(st, 'data-testid="workspace-trigger"', '工作空间触发钮');
  assert.ok(tpl.includes('activeSession.workingDir ?? '), 'title 已选态（目录全路径）绑定丢失');
  assert.ok(tpl.includes('未选择工作空间（运行前必须选择）'), 'title 未选态全文丢失');
});

// ── E2-07 尺寸结构钉（热区不小于改版前基线的静态侧；目检申报） ──
check('E2-07 .ctl__btn padding(5px 10px)/max-width(200px) 保留（热区基线：图标只增宽）', () => {
  const block = cssBlock(st, '.ctl__btn', 'ctl__btn 样式');
  assert.ok(block.includes('padding: 5px 10px'), 'ctl__btn padding 被改（热区收缩风险）');
  assert.ok(block.includes('max-width: 200px'), 'ctl__btn max-width 被改');
});
check('E2-07 .ctl gap 6px 保留（图标与值间距基线）', () => {
  const block = cssBlock(st, '.ctl', 'ctl 样式');
  assert.ok(block.includes('gap: 6px'), '.ctl gap 被改');
});

// ── E2-08 下拉开合链路保留 ──
check('E2-08 工作空间/权限开合函数与 click-outside 关闭链保留', () => {
  assert.ok(st.includes('function toggleWorkspaceMenu'), 'toggleWorkspaceMenu 丢失');
  assert.ok(st.includes('showPermissionMenu = !showPermissionMenu'), '权限 toggle 语义丢失');
  const hco = st.slice(st.indexOf('function handleClickOutside'), st.indexOf('onMounted('));
  assert.ok(hco.includes('showWorkspaceMenu.value = false'), 'click-outside 不再关工作空间菜单');
  assert.ok(hco.includes('showPermissionMenu.value = false'), 'click-outside 不再关权限菜单');
});
check('E2-08 工作空间菜单内部结构零触碰（选择目录/最近使用/删除/清除）', () => {
  assert.ok(st.includes('menu__item--accent'), '「📁 选择目录…」菜单项丢失');
  assert.ok(st.includes('menu__recent-list'), '最近使用列表丢失');
  assert.ok(st.includes('menu__item--dir'), '目录项丢失');
  assert.ok(st.includes('menu__row-delete'), '历史删除钮丢失');
  assert.ok(st.includes('清除工作空间'), '清除工作空间项丢失');
});
check('E2-08 ThinkingLevelSelector Esc 关菜单链保留（preventDefault 消费）', () => {
  const esc = tls.slice(tls.indexOf('function handleEscape'), tls.indexOf('onMounted('));
  assert.ok(esc.includes('event.preventDefault()'), 'Esc preventDefault 消费丢失（急停让位链断裂）');
  assert.ok(esc.includes('showMenu.value = false'), 'Esc 不再关思考菜单');
});

// ── E2-11 渲染门 ──
check('E2-11 v-if="activeSession" 工具栏渲染门保留', () => {
  assert.ok(
    st.includes('<div v-if="activeSession" class="session-toolbar">'),
    '工具栏 v-if="activeSession" 渲染门被动',
  );
});

// ════════════════════════════════════════════════════════════════════════════
// E3 思考/权限菜单去 desc 渲染 + Beta chip（slate-ui-completion-1108-1428 点 E3；
// 用例正本 = docs/ui-completion/tests/E-input-area-cases.md §E3 E3-01～E3-09；
// 实现基准 = docs/ui-completion/impl/E-input-area-impl.md §3）
//   · E3-01/E3-02 desc 行退出渲染：perm-item__desc / tl-item__desc 两 class 全文件零命中
//           （模板与 CSS 同删）；选项数不变（PERMISSIONS 恰 5 含 null 档、LEVELS 恰 7 档）。
//   · E3-03 「工作流」（ultracode）Beta chip：v-if 恰绑 ultracode、模板恰 1 处、label 行内
//           （标题右侧、勾之前）、文案「Beta」、CSS 用 fail/danger 语义族零 hex；
//           .tl-item--danger warn 边框保全（E3 未裁决移除）。SessionToolbar 权限菜单无
//           工作流项，chip 只落思考菜单（impl §3.1/§3.5：SessionToolbar 改动=模板 1 行删+CSS 1 块删）。
//   · E3-04/E3-05 三脚注逐字保留（权限 1 + 思考 2；既有 tdd-effort-truth 两钉另跑全量保持绿）。
//   · E3-06 auto 触发钮显示全局默认档名（triggerLabel 三元，非「自动」中间态）。
//   · E3-07 LEVELS 七档顺序/value 不变（PERMISSIONS 五档序在 E3-01 钉，不重复）。
//   · E3-08 两触发钮 title 全文逐字（title 是 desc 精简后的信息补偿出口）。
//   · E3-09 desc 数据字段保留（只删渲染不删数据）：权限四条字面钉方向=数据保留
//           （tdd-bugfix-hb10-perm-p3 ⑦ 同源）；LEVELS desc 保留且 triggerTitle 仍消费 desc。
// ════════════════════════════════════════════════════════════════════════════

console.log('\n=== E 输入区契约 · E3 思考/权限菜单去 desc 渲染 + Beta chip ===');

// 数据数组切片提取器（声明锚点 → `= [` 字面量起点 → 首个 `];`；类型注解内的
// `Session['permissionMode'];` 形如 `];`，不能作右界）与 value 序提取
function arraySlice(src: string, declAnchor: string, label: string): string {
  const from = src.indexOf(declAnchor);
  assert.ok(from !== -1, `${label}：声明锚点缺失`);
  const lit = src.indexOf('= [', from);
  assert.ok(lit !== -1, `${label}：数组字面量起点未找到`);
  const to = src.indexOf('];', lit);
  assert.ok(to > lit, `${label}：数组右界未找到`);
  return src.slice(from, to);
}
function extractValues(block: string): string[] {
  return [...block.matchAll(/value:\s*(null|'[^']*')/g)].map((m) => m[1].replace(/^'|'$/g, ''));
}

// ── E3-01 权限菜单 desc 退出渲染 + 恰 5 选项（含 null 档） ──
check('E3-01 负断言：perm-item__desc 全文件零命中（模板与 CSS 同删）', () => {
  assert.ok(!st.includes('perm-item__desc'), 'perm-item__desc 残留（权限 desc 行未退出渲染）');
});
check('E3-01 权限菜单恰 5 选项（含 null 档）：PERMISSIONS 五档 value 序不变 + v-for/null 三元保留', () => {
  const values = extractValues(arraySlice(st, 'const PERMISSIONS: Array<{', 'PERMISSIONS'));
  assert.deepEqual(
    values,
    ['null', 'default', 'plan', 'acceptEdits', 'bypassPermissions'],
    'PERMISSIONS 五档 value 集合/顺序被动',
  );
  assert.ok(st.includes('v-for="p in PERMISSIONS"'), '权限菜单 v-for 被动');
  assert.ok(
    st.includes('p.value === null ? `默认：${globalDefaultPermissionLabel}` : p.label'),
    'null 档 label 三元被动（settings-mapping 同源）',
  );
});

// ── E3-02 思考菜单 desc 退出渲染 + 恰 7 选项 ──
check('E3-02 负断言：tl-item__desc 全文件零命中（模板与 CSS 同删）', () => {
  assert.ok(!tls.includes('tl-item__desc'), 'tl-item__desc 残留（思考 desc 行未退出渲染）');
});
check('E3-02 思考菜单恰 7 选项钮：LEVELS 恰 7 成员 + 模板 v-for 保留', () => {
  const values = extractValues(arraySlice(tls, 'const LEVELS: ThinkingOption[] = [', 'LEVELS'));
  assert.equal(values.length, 7, `LEVELS 成员数 ${values.length} ≠ 7（菜单丢档/增档）`);
  assert.ok(tls.includes('v-for="opt in LEVELS"'), '思考菜单 v-for 被动');
});

// ── E3-03 Beta chip（只在思考菜单 ultracode 项） ──
check('E3-03 ① ultracode 项 label 行内含 Beta chip（标题右侧、勾之前）', () => {
  const labelIdx = tls.indexOf('class="tl-item__label"');
  const betaIdx = tls.indexOf('class="tl-item__beta"');
  const checkIdx = tls.indexOf('class="tl-item__check"');
  assert.ok(labelIdx !== -1, 'tl-item__label 锚点缺失');
  assert.ok(betaIdx !== -1, 'tl-item__beta chip 缺失（Beta 语义未承接）');
  assert.ok(checkIdx !== -1, 'tl-item__check 锚点缺失');
  assert.ok(labelIdx < betaIdx && betaIdx < checkIdx, 'chip 未在 label 行内（标题右侧、勾之前）');
  assert.ok(
    tls.includes(`v-if="opt.value === 'ultracode'" class="tl-item__beta"`),
    'chip v-if 未恰绑 ultracode（加错项）',
  );
  assert.ok(/class="tl-item__beta">Beta<\/span>/.test(tls), 'chip 文案非「Beta」');
});
check('E3-03 ② 其余 6 项无 chip：模板切片内 tl-item__beta 恰 1 处', () => {
  const tpl = tls.slice(tls.indexOf('<template>'), tls.indexOf('</template>'));
  const n = tpl.split('tl-item__beta').length - 1;
  assert.equal(n, 1, `模板内 tl-item__beta 出现 ${n} 处 ≠ 1（chip 泄漏到其他项）`);
});
check('E3-03 ③ chip 用 fail/danger 语义族配色（零 hex；不随色板漂移）', () => {
  const block = cssBlock(tls, '.tl-item__beta', 'Beta chip 样式');
  assert.ok(/var\(--color-(fail|danger)/.test(block), 'chip 未用 fail/danger 语义族 token');
  assert.ok(!block.includes('#'), 'chip 样式含硬编码 hex（红线：组件内禁硬编码色值）');
});
check('E3-03 ④ .tl-item--danger warn 边框保全（现状即有，E3 未裁决移除）', () => {
  const block = cssBlock(tls, '.tl-item--danger', 'ultracode danger 样式');
  assert.ok(block.includes('color-mix(in srgb, var(--color-warn) 45%'), 'ultracode warn 边框被动');
});

// ── E3-04/E3-05 三脚注逐字保留 ──
check('E3-04 权限脚注逐字保留（切换后新发起即时生效；bypass 下一条消息）', () => {
  assert.ok(
    st.includes('<div class="perm-foot">对切换后新发起的工具请求即时生效；bypass 需下一条消息生效</div>'),
    '权限脚注全文被动（hb10-PERM / settings-mapping 同源）',
  );
});
check('E3-05 思考菜单双脚注逐字保留（下一条消息起生效 / 上回合实际生效：{档名}）', () => {
  assert.ok(tls.includes('<div class="tl-foot">下一条消息起生效</div>'), '「下一条消息起生效」脚注被动');
  assert.ok(tls.includes('v-if="lastEffortLabel"'), '「上回合实际生效」条件行被动');
  assert.ok(tls.includes('上回合实际生效：{{ lastEffortLabel }}'), '「上回合实际生效：{档名}」插值被动');
});

// ── E3-06 auto 触发钮显示全局默认档名 ──
check('E3-06 auto 触发钮显示全局默认档名（triggerLabel 三元，非「自动」中间态）', () => {
  const from = tls.indexOf('const triggerLabel = computed(');
  assert.ok(from !== -1, 'triggerLabel 声明丢失');
  const block = tls.slice(from, tls.indexOf(');', from));
  assert.ok(
    block.includes("activeValue.value === 'auto' ? globalDefaultLabel.value : activeOption.value.label"),
    'auto→全局默认档名三元被动',
  );
});

// ── E3-07 LEVELS 七档顺序/value 不变 ──
check('E3-07 LEVELS 七档顺序/value 不变（auto→low→medium→high→xhigh→max→ultracode）', () => {
  const values = extractValues(arraySlice(tls, 'const LEVELS: ThinkingOption[] = [', 'LEVELS'));
  assert.deepEqual(
    values,
    ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    'LEVELS 七档顺序/value 被动（与 THINKING_LEVELS 七档钉对齐）',
  );
});

// ── E3-08 两触发钮 title 全文逐字（desc 精简后的信息补偿出口） ──
check('E3-08 权限触发钮 title 全文逐字（null/非 null 双分支 + 生效时机）', () => {
  const tpl = buttonSliceByAnchor(st, 'data-testid="permission-trigger"', '权限触发钮');
  const expected =
    `:title="\`本会话 Claude Code 权限模式（\${activeSession.permissionMode === null ` +
    `? \`跟随全局默认：\${globalDefaultPermissionLabel}\` : activePermission.label}）；运行中切换即时生效\`"`;
  assert.ok(tpl.includes(expected), '权限触发钮 title 全文被动');
});
check('E3-08 思考触发钮 title 全文逐字（三段式：档名 + 说明/跟随全局默认 + 生效时机）', () => {
  const expected =
    '`思考强度：${triggerLabel.value}${activeValue.value === \'auto\' ? `（跟随全局默认）` ' +
    ': `（${activeOption.value.desc}）`}；下一条消息起生效`';
  assert.ok(tls.includes(expected), '思考触发钮 title 全文被动');
});

// ── E3-09 desc 数据字段保留（只删渲染不删数据） ──
check('E3-09 ① 权限 desc 四条字面钉仍在数据区（方向=数据保留；hb10-PERM ⑦ 同源）', () => {
  assert.ok(st.includes(`desc: '每次工具调用需手动确认'`), 'default desc 数据丢失');
  assert.ok(st.includes(`desc: '仅规划，工具需审批'`), 'plan desc 数据丢失');
  assert.ok(st.includes(`desc: '自动接受文件编辑，其余需确认'`), 'acceptEdits desc 数据丢失');
  assert.ok(st.includes(`desc: '跳过所有权限确认【谨慎使用】'`), 'bypass desc 数据丢失');
});
check('E3-09 ② LEVELS desc 数据保留且 triggerTitle 仍消费 desc（Beta 语义源不丢）', () => {
  assert.ok(tls.includes(`desc: 'xhigh + 动态工作流编排（Beta）'`), 'ultracode desc 数据丢失（Beta 语义源丢失）');
  assert.ok(tls.includes('${activeOption.value.desc}'), 'title 不再消费 desc（数据保留失去消费出口）');
});

// E4 斜杠菜单增强（slate-ui-completion-1108-1428 点 E4；
// 用例正本 = docs/ui-completion/tests/E-input-area-cases.md §E4 E4-01～E4-10；
// 实现基准 = docs/ui-completion/impl/E-input-area-impl.md §4）
//   · 裁决 E-C2：tdd-native-command-verify.ts 历史「无 desc」钉反转采纳（在该脚本内完成，不在此重复钉）。
//   · 裁决 E-C3：role="listbox" 挂内层容器 .slash-menu__list（status/hint/provenance 行在容器外侧）。
//   · E4-01 命令名下 muted 小字 desc 渲染（数据源 cmd.description；空/缺 v-if 不渲染）。
//   · E4-02 listbox 三件套结构钉：容器 role="listbox" + :aria-activedescendant + aria-label；
//           项 :id=slash-opt-i / role="option" / :aria-selected 绑定。
//   · E4-03 键盘选中 aria 同步：activedescendant 与 aria-selected 同源 selectedSlashIndex；
//           行为面（ArrowDown 后读 aria）在 cdp-commands-e2e.mjs 场景7。
//   · E4-04 选中回焦：selectSlashCommand 尾部 nextTick focus + setSelectionRange 钉尾；
//           行为面（键盘 Enter/点击两路径 activeElement）在场景7。
//   · E4-05 desc 超长 ellipsis 三声明（静态）；CDP scrollWidth>clientWidth 采样在场景7。
//   · E4-06 loading/error/空态三分支文案逐字。
//   · E4-07 stale hint/provenance 两计数/含空格注记+title/来源徽章结构与文案逐字保留。
//   · E4-08 分页触底容差/悬停同步/外点关零触碰 + CMD-03 max-height 预算字面零改动。
//   · E4-09 handleKeydown 四分支 + isComposing 守卫字面钉（正验=既有 n3-ime 脚本保持绿）。
//   · E4-10 状态行不混入 option 语义（静态侧；CDP 空态采样在场景7）。

console.log('\n=== E 输入区契约 · E4 斜杠菜单增强（desc + listbox 三件套 + 选中回焦）===');

// ChatInput 模板切片（<template> → </template>）
function chatInputTemplate(): string {
  const src = readRel('src/renderer/components/chat/ChatInput.vue');
  const from = src.indexOf('<template>');
  assert.ok(from !== -1, 'ChatInput.vue 无 <template>');
  const to = src.indexOf('</template>', from);
  assert.ok(to > from, 'ChatInput.vue 无 </template>');
  return src.slice(from, to);
}

// listbox 容器切片：.slash-menu__list 开标签 → 状态行锚点（v-if="matchingCommands.length === 0"
// 在容器闭合之后，切片恰含整个 v-for 循环体 + 容器闭标签）。
function listboxSlice(): string {
  const tpl = chatInputTemplate();
  const from = tpl.indexOf('class="slash-menu__list"');
  assert.ok(from !== -1, '内层 listbox 容器 .slash-menu__list 缺失');
  const to = tpl.indexOf('v-if="matchingCommands.length === 0"', from);
  assert.ok(to > from, '状态行锚点缺失（切片右界）');
  return tpl.slice(from, to);
}

// ── E4-01 desc 渲染 ──
check('E4-01 ① desc 渲染分支：v-if="cmd.description" + cmd.description 插值（空/缺不渲染空行）', () => {
  const tpl = chatInputTemplate();
  assert.ok(
    tpl.includes('<span v-if="cmd.description" class="slash-menu__desc">{{ cmd.description }}</span>'),
    'desc 渲染分支缺失（或形态不符）',
  );
});
check('E4-01 ② desc 在命令名行（slash-menu__row）之后、item 内部（名下渲染）', () => {
  const s = listboxSlice();
  const itemIdx = s.indexOf("['slash-menu__item'");
  const rowIdx = s.indexOf('class="slash-menu__row"');
  const descIdx = s.indexOf('class="slash-menu__desc"');
  assert.ok(itemIdx !== -1 && rowIdx !== -1 && descIdx !== -1, 'item/row/desc 锚点缺失');
  assert.ok(itemIdx < rowIdx && rowIdx < descIdx, 'desc 未在命令名行之后（item 内部名下）');
});
check('E4-01 ③ desc muted 小字：--color-text-muted + 字号小于命令名（.slash-menu__name）', () => {
  const ci = readRel('src/renderer/components/chat/ChatInput.vue');
  const descBlock = cssBlock(ci, '.slash-menu__desc', 'desc 样式');
  const nameBlock = cssBlock(ci, '.slash-menu__name', '命令名样式');
  assert.ok(descBlock.includes('var(--color-text-muted)'), 'desc 未用 muted 色 token');
  const fontSizeOf = (block: string): number => {
    const m = /font-size:\s*([\d.]+)rem/.exec(block);
    assert.ok(m, 'font-size 声明缺失');
    return parseFloat(m[1]);
  };
  assert.ok(fontSizeOf(descBlock) < fontSizeOf(nameBlock), 'desc 字号未小于命令名字号（非「小字」层级）');
});

// ── E4-02 listbox 三件套结构钉 ──
check('E4-02 ① 内层容器：role="listbox" + :aria-activedescendant 绑 selectedSlashIndex + aria-label', () => {
  const s = listboxSlice();
  assert.ok(s.includes('role="listbox"'), '容器缺 role="listbox"（裁决 E-C3：挂内层容器）');
  assert.ok(
    s.includes(':aria-activedescendant="`slash-opt-${selectedSlashIndex}`"'),
    '容器缺 :aria-activedescendant 绑定（未跟随键盘/悬停选中）',
  );
  assert.ok(s.includes('aria-label="斜杠命令联想"'), 'listbox 缺 aria-label');
});
check('E4-02 ② 每项 option 三件套：:id=slash-opt-i + role="option" + :aria-selected="i === selectedSlashIndex"', () => {
  const s = listboxSlice();
  assert.ok(s.includes(':id="`slash-opt-${i}`"'), '项缺 :id 绑定（activedescendant 无目标）');
  assert.ok(s.includes('role="option"'), '项缺 role="option"');
  assert.ok(s.includes(':aria-selected="i === selectedSlashIndex"'), '项缺 :aria-selected 绑定');
});
check('E4-02 ③ status/hint/provenance 在 listbox 容器外侧（切片零命中）', () => {
  const s = listboxSlice();
  for (const needle of ['slash-menu__status', 'slash-menu__hint', 'slash-menu__provenance']) {
    assert.ok(!s.includes(needle), `${needle} 混入 listbox 容器（非 option 行污染 option 语义）`);
  }
});

// ── E4-03 键盘选中 aria 同步（静态侧：同一 ref 落点；行为面在 cdp-commands-e2e 场景7） ──
check('E4-03 activedescendant/aria-selected 同源 selectedSlashIndex（悬停 hoverCommand 写同一 ref）', () => {
  const ci = readRel('src/renderer/components/chat/ChatInput.vue');
  const s = listboxSlice();
  assert.ok(s.includes('`slash-opt-${selectedSlashIndex}`'), 'activedescendant 未落 selectedSlashIndex');
  assert.ok(s.includes(':aria-selected="i === selectedSlashIndex"'), 'aria-selected 未落 selectedSlashIndex');
  const hoverFrom = ci.indexOf('function hoverCommand');
  assert.ok(hoverFrom !== -1, 'hoverCommand 函数缺失');
  const hoverBody = ci.slice(hoverFrom, ci.indexOf('}', hoverFrom));
  assert.ok(hoverBody.includes('selectedSlashIndex.value = i'), 'hoverCommand 未写同一 ref（悬停与 aria 脱钩）');
});

// ── E4-04 选中回焦（静态侧；行为面在场景7） ──
check('E4-04 ① selectSlashCommand 尾部 nextTick 回焦 + 光标钉尾（focus + setSelectionRange(pos,pos)）', () => {
  const ci = readRel('src/renderer/components/chat/ChatInput.vue');
  const from = ci.indexOf('function selectSlashCommand');
  assert.ok(from !== -1, 'selectSlashCommand 函数缺失');
  const to = ci.indexOf('function handleInput', from);
  assert.ok(to > from, 'selectSlashCommand 函数切片右界缺失');
  const body = ci.slice(from, to);
  assert.ok(body.includes('void nextTick('), '回焦缺 nextTick（:value 写入 DOM 前聚焦会错位）');
  assert.ok(body.includes('ta.focus()'), '回焦缺 focus()');
  assert.ok(body.includes('ta.setSelectionRange(pos, pos)'), '光标未钉在插入文本末尾（含尾随空格）');
});
check('E4-04 ② handleKeydown→selectSlashCommand 相对顺序与函数头形态不变（n3-ime 切片边界）', () => {
  const ci = readRel('src/renderer/components/chat/ChatInput.vue');
  const a = ci.indexOf('function handleKeydown');
  const b = ci.indexOf('function selectSlashCommand');
  assert.ok(a !== -1 && b !== -1 && a < b, '两函数相对顺序被移动（n3-ime 切片窗口错位）');
});

// ── E4-05 desc 超长 ellipsis ──
check('E4-05 desc 超长截断三声明：white-space nowrap + overflow hidden + text-overflow ellipsis', () => {
  const ci = readRel('src/renderer/components/chat/ChatInput.vue');
  const block = cssBlock(ci, '.slash-menu__desc', 'desc 样式');
  assert.ok(block.includes('white-space: nowrap'), '缺 white-space: nowrap（超长换行爆高）');
  assert.ok(block.includes('overflow: hidden'), '缺 overflow: hidden（撑破菜单宽度）');
  assert.ok(block.includes('text-overflow: ellipsis'), '缺 text-overflow: ellipsis');
});

// ── E4-06 状态三分支文案逐字 ──
check('E4-06 loading/error/空态三分支文案逐字不变', () => {
  const tpl = chatInputTemplate();
  assert.ok(tpl.includes('正在读取 Claude Code 命令…'), 'loading 文案被动');
  assert.ok(tpl.includes("{{ commandError || '命令读取异常，可继续输入或发送' }}"), 'error/degraded 文案被动');
  assert.ok(tpl.includes('当前会话没有可用 Slash Command（仍可直接输入发送）'), '空态文案被动');
});

// ── E4-07 尾部提示/注记/徽章逐字与结构 ──
check('E4-07 ① stale hint + provenance 两计数 + 含空格注记与 title 逐字', () => {
  const tpl = chatInputTemplate();
  assert.ok(
    tpl.includes('<div v-else-if="commandStatus === \'stale\'" class="slash-menu__hint">可能不是最新</div>'),
    'stale hint 行被动',
  );
  assert.ok(tpl.includes('{{ unknownCount }} 个命令来源未知（待分类，未作为内置命令验证）'), 'unknown 计数文案被动');
  assert.ok(tpl.includes('{{ hiddenCount }} 个隐藏命令（已移除/内部）'), 'hidden 计数文案被动');
  assert.ok(tpl.includes('>（含空格，需手动输入）</span>'), '含空格注记文案被动');
  assert.ok(tpl.includes('title="命令名含空格，点击仅插入首段，需手动输入完整名"'), '含空格注记 title 被动');
});
check('E4-07 ② 来源徽章结构与四来源文案保留（testid/data-origin/originLabel 映射）', () => {
  const ci = readRel('src/renderer/components/chat/ChatInput.vue');
  const tpl = chatInputTemplate();
  assert.ok(tpl.includes('data-testid="slash-menu-origin"'), '徽章 data-testid 被动');
  assert.ok(tpl.includes(':data-origin="cmd.origin"'), '徽章 :data-origin 绑定被动');
  assert.ok(tpl.includes('v-if="originLabel(cmd.origin)"'), '徽章 v-if 门槛被动');
  for (const label of ['Claude Code 内置', '用户 Skill', '项目命令', '插件命令']) {
    assert.ok(ci.includes(`'${label}'`), `来源文案「${label}」被动（ORIGIN_LABELS 映射）`);
  }
});

// ── E4-08 分页/悬停/外点关零触碰 + CMD-03 预算 ──
check('E4-08 ① CMD-03 max-height 预算字面与注释零改动（hb10-⑪ 同字面）', () => {
  const ci = readRel('src/renderer/components/chat/ChatInput.vue');
  assert.match(ci, /max-height: calc\(\(0\.5rem \* 2\) \+ \(2px \* 4\) \+ \(2\.5rem \* 4\) \+ 2\.5rem\);/, '预算字面被动');
  assert.ok(ci.includes('提示行计入同一预算'), '预算注释被动（提示行计入同一预算语义）');
});
check('E4-08 ② 分页触底容差/外点关/active 类查询零触碰', () => {
  const ci = readRel('src/renderer/components/chat/ChatInput.vue');
  assert.ok(ci.includes('@scroll="handleSlashMenuScroll"'), '外层滚动容器 @scroll 绑定被动');
  assert.ok(ci.includes('menu.scrollHeight - 8'), '触底容差 8px 被动');
  assert.ok(ci.includes(".slash-menu__item.active"), 'ensureSelectedCommandVisible 的 active 类查询被动');
  assert.ok(ci.includes('!wrapperRef.value.contains(event.target as Node)'), '外点关判定被动');
});

// ── E4-09 键盘分支 + IME 守卫字面钉（正验=既有 n3-ime 脚本保持绿） ──
check('E4-09 handleKeydown 四分支与 isComposing 守卫字面钉', () => {
  const ci = readRel('src/renderer/components/chat/ChatInput.vue');
  const from = ci.indexOf('function handleKeydown');
  assert.ok(from !== -1, 'handleKeydown 缺失');
  const to = ci.indexOf('function selectSlashCommand', from);
  assert.ok(to > from, 'handleKeydown 切片右界缺失');
  const body = ci.slice(from, to);
  for (const needle of ["e.key === 'ArrowDown'", "e.key === 'ArrowUp'", "e.key === 'Enter' && !e.shiftKey", "e.key === 'Escape'"]) {
    assert.ok(body.includes(needle), `键盘分支缺失：${needle}`);
  }
  assert.ok(body.includes('if (e.isComposing) return;'), 'IME isComposing 守卫被动（n3 ②③）');
});

// ── E4-10 状态行不混入 option 语义（静态侧） ──
check('E4-10 模板 role="option" 恰 1 处（仅命令项；status/hint/provenance 无 option/aria-selected 语义）', () => {
  const tpl = chatInputTemplate();
  const n = tpl.split('role="option"').length - 1;
  assert.ok(n === 1, `模板 role="option" 出现 ${n} 处 ≠ 1（option 语义泄漏）`);
  const afterOptions = tpl.slice(tpl.indexOf('v-if="matchingCommands.length === 0"'));
  assert.ok(!afterOptions.includes('aria-selected'), '状态/提示区残留 aria-selected（非 option 行带选中语义）');
});

// ── E4 CDP 行为面落点存在钉（E1-07 先例：守护行为断言不被静默拆链） ──
check('E4-CDP cdp-commands-e2e.mjs 场景7 存在钉（aria 同步/双路径回焦/desc 与超长采样/空态 option 语义）', () => {
  const cdp = readRel('scripts/cdp-commands-e2e.mjs');
  assert.ok(cdp.includes('场景7'), 'cdp-commands-e2e.mjs 缺场景7（E4 行为断言入口被拆链）');
  assert.ok(cdp.includes('aria-activedescendant'), '场景7 缺 aria-activedescendant 采样（E4-03 行为面）');
  assert.ok(cdp.includes('activeElement'), '场景7 缺 activeElement 回焦采样（E4-04 行为面）');
  assert.ok(cdp.includes('slash-menu__desc'), '场景7 缺 desc 元素采样（E4-01 行为面）');
  assert.ok(cdp.includes('textOverflow'), '场景7 缺 ellipsis computed 采样（E4-05 行为面）');
  assert.ok(cdp.includes('E4-10'), '场景7 缺空态 option 语义采样（E4-10 行为面）');
});

// ════════════════════════════════════════════════════════════════════════════
// E5 圆环 popover focus 显隐（slate-ui-completion-1108-1428 点 E5；
// 用例正本 = docs/ui-completion/tests/E-input-area-cases.md §E5 E5-01～E5-07；
// 实现基准 = docs/ui-completion/impl/E-input-area-impl.md §5）
//   · E5-01/E5-02 显隐并集结构钉：showPopover 拆 hoverPopover/focusPopover 两 ref 派生
//           computed（hover ∪ focus 并集）；wrapper .ctx 四事件（mouseenter/mouseleave 写
//           hoverPopover、focusin/focusout 写 focusPopover）。wrapper 级 focusin/focusout
//           （冒泡语义）而非按钮级 @focus——按钮 @blur="onHoldBlur" 字面一字不动
//           （tdd-contextbutton-hold-composable-verify.ts:60 精确钉），wrapper 级零冲突。
//   · E5-04 高亮阈值 80 保持：'ctx__btn--high': pct >= 80 绑定字面（K1 裁决值）。
//   · E5-05 长按接线共存钉（轻量存在性；形态深钉归既有 hold-composable 脚本全量保持绿，
//           不重复钉同一形态——E1 先例）：指针五件套/键盘两件/@blur/watch(disabled) 存在 +
//           wrapper focusin/focusout 与按钮 @blur 同文件共存。
//   · E5-06 既有态轻量存在钉：--thinking（呼吸 + reduced-motion 停）、--stale、待刷新文案
//           （popover 行 + title）、ctx__banner 3s 自动消失链（timer 清理）。
//   · E5-07 Esc 负断言：全文件零 'Escape' 字面；popover 元素切片零键盘绑定
//           （防实现顺手加 Esc 关闭 + stopPropagation 吞掉急停分层）。
//   · E5-03 静态侧：「全部上下文」行模板字面（动态 windowSize 驱动 + null 兜底 '—'）；
//           fmt m 档字面由既有 tdd-bugfix-hb10-context-p3-verify ④ 保持绿（不重复钉）。
//   · E5-CDP 行为面落点存在钉：cdp-context-e2e.mjs E5 场景组（focus 显隐采样/1M 窗口注入/
//           Escape 采样）——行为断言本体在该链。
// ════════════════════════════════════════════════════════════════════════════

console.log('\n=== E 输入区契约 · E5 圆环 popover focus 显隐 ===');

// ContextButton 模板 wrapper（.ctx 开标签 → button 开标签之前）切片
function ctxWrapperSlice(): string {
  const cb = readRel('src/renderer/components/chat/ContextButton.vue');
  const from = cb.indexOf('<div');
  assert.ok(from !== -1, 'ContextButton.vue 无模板根 div');
  const to = cb.indexOf('<button', from);
  assert.ok(to > from, 'ContextButton.vue 模板 <button 未找到');
  return cb.slice(from, to);
}

// ContextButton popover 元素切片（v-if="showPopover" → v-if="showCompactBanner" 转场之前）
function ctxPopoverSlice(): string {
  const cb = readRel('src/renderer/components/chat/ContextButton.vue');
  const from = cb.indexOf('<div v-if="showPopover"');
  assert.ok(from !== -1, 'popover v-if="showPopover" 字面缺失（三行弹层入口被动）');
  const to = cb.indexOf('<transition', from);
  assert.ok(to > from, 'popover 切片右界（banner transition）未找到');
  return cb.slice(from, to);
}

// ── E5-01/E5-02 显隐并集（两源派生） ──
check('E5-01 ① showPopover 改两源派生 computed：hoverPopover ∪ focusPopover 并集', () => {
  const cb = readRel('src/renderer/components/chat/ContextButton.vue');
  assert.ok(cb.includes('const hoverPopover = ref(false);'), '缺 hoverPopover ref（hover 源未拆出）');
  assert.ok(cb.includes('const focusPopover = ref(false);'), '缺 focusPopover ref（focus 源未拆出）');
  assert.ok(
    cb.includes('const showPopover = computed(() => hoverPopover.value || focusPopover.value);'),
    'showPopover 非 hover ∪ focus 并集 computed（单源或顺序错误）',
  );
});
check('E5-01 ② wrapper 四事件：mouseenter/mouseleave 写 hoverPopover、focusin/focusout 写 focusPopover', () => {
  const w = ctxWrapperSlice();
  assert.ok(w.includes('@mouseenter="hoverPopover = true"'), 'wrapper @mouseenter 未写 hoverPopover=true');
  assert.ok(w.includes('@mouseleave="hoverPopover = false"'), 'wrapper @mouseleave 未写 hoverPopover=false');
  assert.ok(w.includes('@focusin="focusPopover = true"'), 'wrapper 缺 @focusin 写 focusPopover=true（focus 显隐未接）');
  assert.ok(w.includes('@focusout="focusPopover = false"'), 'wrapper 缺 @focusout 写 focusPopover=false（只加 focusin 未加 focusout 即 popover 永驻）');
});
check('E5-01 ③ 模板不再直接写 showPopover（显隐唯一路径=并集 computed）', () => {
  const cb = readRel('src/renderer/components/chat/ContextButton.vue');
  const tpl = cb.slice(cb.indexOf('<template>'), cb.indexOf('</template>'));
  assert.ok(!tpl.includes('showPopover ='), '模板残留对 showPopover 的直接赋值（绕过并集派生）');
});
check('E5-02 v-if="showPopover" 字面保留（模板消费点不变；三行结构钉归 tdd-context-usage-verify D4 全量保持绿）', () => {
  const cb = readRel('src/renderer/components/chat/ContextButton.vue');
  assert.ok(cb.includes('<div v-if="showPopover" class="ctx__popover">'), 'popover 入口 v-if 字面被动');
});

// ── E5-04 高亮阈值 80（裁决值） ──
check('E5-04 高亮阈值保持 pct >= 80（ctx__btn--high 类绑定字面；K1 裁决）', () => {
  const cb = readRel('src/renderer/components/chat/ContextButton.vue');
  assert.ok(cb.includes("'ctx__btn--high': pct >= 80"), 'high 阈值绑定被动（80 被挪）');
  assert.ok(cb.includes('.ctx__btn--high .ctx__ring-fg { stroke: var(--color-warn-strong); }'), 'high 态 warn-strong 弧线样式被动');
});

// ── E5-05 长按接线共存钉（轻量存在性；深钉归既有 hold-composable 脚本） ──
check('E5-05 ① 长按接线存在性：指针五件套/键盘两件/@blur/watch(disabled) 全在', () => {
  const cb = readRel('src/renderer/components/chat/ContextButton.vue');
  for (const needle of [
    '@pointerdown.prevent="startHold"',
    '@pointermove="moveHold"',
    '@pointerup="endHold"',
    '@pointerleave="resetHold"',
    '@pointercancel="resetHold"',
    '@keydown="onHoldKeydown"',
    '@keyup="onHoldKeyup"',
    '@blur="onHoldBlur"',
    'watch(() => props.disabled, (v) => { if (v) resetHold(); });',
  ]) {
    assert.ok(cb.includes(needle), `长按接线缺失：${needle}`);
  }
});
check('E5-05 ② wrapper focusin/focusout 与按钮 @blur 同文件共存（E5 改造未吞长按失焦取消链）', () => {
  const cb = readRel('src/renderer/components/chat/ContextButton.vue');
  assert.ok(cb.includes('@focusin="focusPopover = true"') && cb.includes('@focusout="focusPopover = false"'), 'wrapper focus 显隐被移除');
  assert.ok(cb.includes('@blur="onHoldBlur"'), '按钮 @blur="onHoldBlur" 字面被动（hold-composable:60 精确钉）');
});

// ── E5-06 既有态轻量存在钉（深钉归既有脚本：hb10-context-p3 / context-usage / hold 链） ──
check('E5-06 ① thinking 呼吸态与 reduced-motion 停保留', () => {
  const cb = readRel('src/renderer/components/chat/ContextButton.vue');
  assert.ok(cb.includes("'ctx__btn--thinking': thinking"), 'thinking 类绑定被动');
  assert.ok(cb.includes('animation: ctx-thinking 1.6s ease-in-out infinite;'), '呼吸动画声明被动');
  assert.match(cb, /@media \(prefers-reduced-motion: reduce\) \{\s*\.ctx__btn--thinking \{\s*animation: none;/, 'reduced-motion 停声明被动');
});
check('E5-06 ② stale 降透明态与待刷新文案保留（popover 行 + title 双出口）', () => {
  const cb = readRel('src/renderer/components/chat/ContextButton.vue');
  assert.ok(cb.includes("'ctx__btn--stale': isStaleTrusted"), 'stale 类绑定被动');
  assert.ok(cb.includes('.ctx__btn--stale .ctx__ring-fg { stroke-opacity: 0.55; }'), 'stale 降透明样式被动');
  assert.ok(cb.includes("上下文待刷新，长按 1 秒压缩"), 'title 待刷新文案被动');
  assert.ok(cb.includes("hasTrustedCurrent ? fmt(eff.currentUsedTokens ?? 0) : '待刷新'"), 'popover 已用行待刷新三元被动');
});
check('E5-06 ③ 压缩横幅 3s 自动消失链保留（bannerTimer 清理 + transition）', () => {
  const cb = readRel('src/renderer/components/chat/ContextButton.vue');
  assert.ok(cb.includes('clearTimeout(bannerTimer)'), '横幅 timer 清理被动');
  assert.ok(cb.includes('<transition name="ctx-banner">'), '横幅 transition 被动');
  assert.ok(cb.includes("store.clearCompactedJustNow();"), '横幅 3s 自动消失复位链被动');
});

// ── E5-07 Esc 负断言（popover 无键盘消费） ──
check('E5-07 ① ContextButton.vue 全文件零 Escape 字面（不得加 Esc 关闭）', () => {
  const cb = readRel('src/renderer/components/chat/ContextButton.vue');
  assert.ok(!cb.includes('Escape'), 'ContextButton.vue 出现 Escape 字面（越权消费 Esc 急停链）');
});
check('E5-07 ② popover 元素切片零键盘绑定（keydown/keyup/focus 捕获）', () => {
  const slice = ctxPopoverSlice();
  assert.ok(!slice.includes('@keydown'), 'popover 元素出现 @keydown（Esc/键盘捕获风险）');
  assert.ok(!slice.includes('@keyup'), 'popover 元素出现 @keyup');
  assert.ok(!slice.includes('tabindex'), 'popover 元素出现 tabindex（可聚焦即可能截停 Esc 链）');
});

// ── E5-03 静态侧：「全部」行动态窗口驱动 ──
check('E5-03 「全部上下文」行动态取窗口值模板字面（windowSize 驱动 fmt + null 兜底「—」）', () => {
  const slice = ctxPopoverSlice();
  assert.ok(
    slice.includes("<div class=\"ctx__row\"><span>全部上下文</span><code>{{ eff.windowSize != null ? fmt(eff.windowSize) : '—' }}</code></div>"),
    '「全部上下文」行模板被动（写死值或分母改回 payload）',
  );
});

// ── E5-CDP 行为面落点存在钉（E1-07/E4-CDP 先例） ──
check('E5-CDP cdp-context-e2e.mjs E5 场景组存在钉（focus 显隐/并集语义/1M 注入/Escape 采样）', () => {
  const cdp = readRel('scripts/cdp-context-e2e.mjs');
  assert.ok(cdp.includes('runE5Scenarios'), 'cdp-context-e2e.mjs 缺 runE5Scenarios 场景组入口（E5 行为断言被拆链）');
  assert.ok(cdp.includes('E5-01'), '缺 E5-01 focus 显隐采样');
  assert.ok(cdp.includes("focusin"), '缺 focusin 显隐采样（E5-01 行为面）');
  assert.ok(cdp.includes('E5-03'), '缺 E5-03 窗口值注入采样');
  assert.ok(cdp.includes('contextLastWindow'), '缺 contextLastWindow 注入通道（E5-03 行为面）');
  assert.ok(cdp.includes("key: 'Escape'"), '缺 Escape keydown 采样（E5-07 行为面）');
});

// ══ E6 附件草稿卡移入浮岛（slate-ui-completion-1108-1428 点 E6；裁决 E-C5）══════════
// 用例正本 = docs/ui-completion/tests/E-input-area-cases.md §E6 E6-01～E6-06；
// 实现正本 = docs/ui-completion/impl/E-input-area-impl.md §6。
//   · E6-01 位置序（裁决 E-C5：TurnTimer 之后、bridge-lock/ChatInput 之前；composer 内）。
//   · E6-02/03 缩略图→灯箱与三态反馈逐字保全（搬运零触碰组件 script/模板卡片区）。
//   · E6-04 发送携带链（:has-attachments 传递）保全；主进程校验链归既有钉不重复。
//   · E6-05 空附件行不占位（根节点 v-if 保留）。
//   · E6-06 拖放高亮仍挂浮岛本体 + notice/error 横幅仍在浮岛外（quota ⑩⑪⑫ 链归既有脚本）。
//   · E6-S* 容器样式适配（impl §6.2(2) 裁决值：去二次限宽/auto margin，pad 与输入行对齐）。
//   · E6-CDP 行为面落点 cdp-layout-e2e.mjs E6 场景组（空态不占位/合成 paste 播种入岛/
//     拖放高亮包住附件行/移除链），本脚本尾部以存在钉守护该扩展不被静默拆链。

console.log('=== E 输入区契约 · E6 附件草稿卡移入浮岛 ===');

// ChatPage 模板切片（<template> → </template>）
function chatPageTemplate(): string {
  const cp = readRel('src/renderer/pages/ChatPage.vue');
  const from = cp.indexOf('<template>');
  const to = cp.indexOf('</template>', from);
  assert.ok(from !== -1 && to > from, 'ChatPage.vue 模板块未找到');
  return cp.slice(from, to);
}

// .attachment-draft-list 规则块切片（scoped 样式内首个该选择器 → 首个 '}'）
function draftListStyleBlock(): string {
  const src = readRel('src/renderer/components/chat/AttachmentDraftList.vue');
  const styleIdx = src.indexOf('<style scoped>');
  const from = src.indexOf('.attachment-draft-list {', styleIdx);
  assert.ok(from !== -1, '.attachment-draft-list 规则块不存在');
  const to = src.indexOf('}', from);
  assert.ok(to > from, '.attachment-draft-list 规则块右界未找到');
  return src.slice(from, to + 1);
}

// ── E6-01 位置序（裁决 E-C5）──
check('E6-01 ① 源码序：composer 开标签 < TurnTimer < AttachmentDraftList < ChatInput（浮岛内 TurnTimer 之后、输入行之前）', () => {
  const tpl = chatPageTemplate();
  const idxComposer = tpl.indexOf('class="chat-composer"');
  const idxTimer = tpl.indexOf('<TurnTimer');
  const idxList = tpl.indexOf('<AttachmentDraftList');
  const idxInput = tpl.indexOf('<ChatInput');
  assert.ok(idxComposer >= 0, '模板缺 .chat-composer');
  assert.ok(idxTimer >= 0, '模板缺 <TurnTimer>');
  assert.ok(idxList >= 0, '模板缺 <AttachmentDraftList>（挂载被删）');
  assert.ok(idxInput >= 0, '模板缺 <ChatInput>');
  assert.ok(
    idxComposer < idxTimer && idxTimer < idxList && idxList < idxInput,
    `位置序错乱（composer=${idxComposer} timer=${idxTimer} list=${idxList} input=${idxInput}；须 composer<timer<list<input）`,
  );
});
check('E6-01 ② 负断言：composer 开标签之前零 AttachmentDraftList（旧「浮岛外上方」位置退场）', () => {
  const tpl = chatPageTemplate();
  const idxComposer = tpl.indexOf('class="chat-composer"');
  const firstList = tpl.indexOf('<AttachmentDraftList');
  assert.ok(firstList >= 0, '模板缺 <AttachmentDraftList>');
  assert.ok(
    firstList > idxComposer,
    `AttachmentDraftList 仍在 composer 开标签之前（firstList=${firstList} ≤ composer=${idxComposer}，旧位置残留）`,
  );
});
check('E6-01 ③ AttachmentDraftList 位于 v-if="bridgeLocked" 分支之前（锁定态上方；桥接结构逐字不动）', () => {
  const tpl = chatPageTemplate();
  const idxList = tpl.indexOf('<AttachmentDraftList');
  const idxLock = tpl.indexOf('v-if="bridgeLocked"');
  assert.ok(idxLock >= 0, '模板缺 v-if="bridgeLocked"（桥接锁定条被动）');
  assert.ok(idxList >= 0 && idxList < idxLock, '附件行未在 bridge-lock 分支之前（挪到锁定条之后=错位）');
});

// ── E6-02 缩略图→灯箱链保全（搬运零触碰）──
check('E6-02 缩略图钮三件套 + previewImage→openImageLightbox 链逐字保留', () => {
  const adl = readRel('src/renderer/components/chat/AttachmentDraftList.vue');
  for (const needle of [
    'class="att-card__thumb"',
    ':title="`预览 ${att.filename}`"',
    ':aria-label="`预览图片 ${att.filename}`"',
    '@click="previewImage(att, $event.currentTarget as HTMLElement)"',
    'openImageLightbox(url, att.filename, trigger)',
    'getAttachmentPreview({ sessionId: sid, attachmentId: att.id, thumbnail: true })',
  ]) {
    assert.ok(adl.includes(needle), `缩略图→灯箱链缺失：${needle}`);
  }
});

// ── E6-03 三态反馈逐字保全 ──
check('E6-03 读取中…/预览不可用/移除钮 title+aria-label/移除失败 逐字保留', () => {
  const adl = readRel('src/renderer/components/chat/AttachmentDraftList.vue');
  for (const needle of [
    '读取中…',
    "'预览不可用'",
    ':title="`移除 ${att.filename}`"',
    ':aria-label="`移除附件 ${att.filename}`"',
    "'移除失败'",
    'class="att-card__err"',
  ]) {
    assert.ok(adl.includes(needle), `三态反馈缺失：${needle}`);
  }
});

// ── E6-04 发送携带链（附件-only 语义传递）──
check('E6-04 ChatPage :has-attachments="draftAttachments.length > 0" 保留（附件-only 放行传递面）', () => {
  const cp = readRel('src/renderer/pages/ChatPage.vue');
  assert.ok(
    cp.includes(':has-attachments="draftAttachments.length > 0"'),
    ':has-attachments 绑定被动（附件-only 可发送语义断链）',
  );
});

// ── E6-05 空附件行不占位 ──
check('E6-05 根节点 v-if="attachments.length" 保留（空列表不渲染不占位）', () => {
  const adl = readRel('src/renderer/components/chat/AttachmentDraftList.vue');
  assert.ok(
    adl.includes('<div v-if="attachments.length" class="attachment-draft-list">'),
    '根节点 v-if="attachments.length" 被改（空壳占位风险）',
  );
});

// ── E6-06 拖放高亮 / notice 横幅位置 ──
check('E6-06 ① .chat-composer--drag 仍绑在 .chat-composer 上（accent 高亮圈包住入岛后的附件行）', () => {
  const tpl = chatPageTemplate();
  assert.ok(
    tpl.includes('<div class="chat-composer" :class="{ \'chat-composer--drag\': dragActive }">'),
    '拖放高亮 class 绑定被动（挪错元素或删绑）',
  );
});
check('E6-06 ② notice/error 横幅仍在浮岛外上方（composer 开标签之前；quota 预检弹条不入岛）', () => {
  const tpl = chatPageTemplate();
  const idxComposer = tpl.indexOf('class="chat-composer"');
  const idxNotice = tpl.indexOf('class="notice"');
  const idxError = tpl.indexOf('class="chat-error"');
  assert.ok(idxNotice >= 0, '模板缺 notice 弹条');
  assert.ok(idxError >= 0, '模板缺 chat-error 横幅');
  assert.ok(idxNotice < idxComposer && idxError < idxComposer, 'notice/error 横幅被挪入浮岛（预检弹条位置漂移）');
});

// ── E6-S* 容器样式适配（impl §6.2(2) 裁决值）──
check('E6-S1 容器去二次限宽/auto margin：零 --chat-bottom-max-width、零 auto margin（浮岛已限宽居中）', () => {
  const block = draftListStyleBlock();
  assert.ok(!block.includes('--chat-bottom-max-width'), '容器残留 max-width: var(--chat-bottom-max-width)（浮岛内二次缩进）');
  assert.ok(!/margin:[^;]*auto/.test(block), '容器残留 auto margin（浮岛内二次居中错位）');
});
check('E6-S2 容器 padding 改「顶部 0.5rem + 左右 --chat-bottom-pad-x」且 max-width: 100%（impl §6.2(2) 裁决值）', () => {
  const block = draftListStyleBlock();
  assert.ok(block.includes('padding: 0.5rem var(--chat-bottom-pad-x) 0;'), '容器 padding 未按裁决值改（与输入行水平内边距对齐缺失）');
  assert.ok(block.includes('max-width: 100%;'), '容器缺 max-width: 100%（浮岛内溢出防护）');
});
check('E6-S3 容器仍无自身 border（与 regression-tests「列表容器不得有自身 border」钉同口径）', () => {
  const block = draftListStyleBlock();
  assert.ok(!/border:/.test(block), '容器规则块出现 border 声明（违 regression 钉）');
});

// ── E6-CDP 行为面落点存在钉（E1-07/E5-CDP 先例） ──
check('E6-CDP cdp-layout-e2e.mjs E6 场景组存在钉（空态不占位/播种入岛/拖放高亮/移除链采样）', () => {
  const cdp = readRel('scripts/cdp-layout-e2e.mjs');
  assert.ok(cdp.includes('runE6Scenarios'), 'cdp-layout-e2e.mjs 缺 runE6Scenarios 场景组入口（E6 行为断言被拆链）');
  assert.ok(cdp.includes('E6-CT-1'), '缺 E6-CT-1 空态不占位采样');
  assert.ok(cdp.includes('E6-CT-2'), '缺 E6-CT-2 播种入岛采样');
  assert.ok(cdp.includes('E6-CT-3'), '缺 E6-CT-3 拖放高亮采样');
  assert.ok(cdp.includes('E6-CT-4'), '缺 E6-CT-4 移除链采样');
  assert.ok(cdp.includes('attachment-draft-list'), 'CDP 场景缺 .attachment-draft-list 探针');
  assert.ok(cdp.includes('chat-composer--drag'), 'CDP 场景缺 .chat-composer--drag 探针');
});

// ── 登记自钉 ──
check('E1-REG 本脚本两处登记：selftest-static-list.txt + tsconfig.tdd.json', () => {
  assert.ok(
    readRel('scripts/selftest-static-list.txt').includes('scripts/tdd-ui-e-input-area-verify.ts'),
    'selftest-static-list.txt 未登记本脚本',
  );
  assert.ok(
    readRel('tsconfig.tdd.json').includes('scripts/tdd-ui-e-input-area-verify.ts'),
    'tsconfig.tdd.json 未登记本脚本',
  );
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
