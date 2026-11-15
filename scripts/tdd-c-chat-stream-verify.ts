// scripts/tdd-c-chat-stream-verify.ts
// C1 用户气泡浅蓝 token 化 + 去描边色条 + 圆角 11/11/4/11（slate-ui-completion-1108-1428 round-001 点 C1）
// 用例正本 = docs/ui-completion/tests/C-chat-stream-cases.md §C1（C1-1～C1-8 共 8 例），转写映射：
//   · C1-1 背景/文字 = 固定浅蓝 token 计算值：源级钉（样式块 var 引用 + variables.css 字面值）+
//     纯计算把 token hex 换算成 rgb 期望常量（证明 CDP 期望与 token 同源不漂移）；元素 computed
//     落 scripts/cdp-layout-e2e.mjs A3 场景组探针（本脚本尾部存在钉守护）；
//   · C1-2 token 引用非硬编码：用户样式块切片含 var(--color-bubble-user-bg) /
//     var(--color-bubble-user-ink) 字面，切片零 hex / rgb( 硬编码字面；
//   · C1-3 accent 混色表达式消失：切片无 color-mix(、无 accent 字面（旧 accent 12% 派生清零）；
//   · C1-4 accent 描边与右缘 3px 色条消失：切片（豁免 border-radius 行后）零 border 声明；CDP
//     computed border 四向宽全 0px（存在钉）；
//   · C1-5 圆角 11px 11px 4px 11px 字面（TL TR BR BL 序）+ box-shadow var(--ring-light),
//     var(--elevation-1)（轻阴影：两层 token alpha 均 ≤ 0.2，源级核）；CDP computed
//     radius/shadow/alpha（存在钉）；
//   · C1-6 助手气泡不受影响：.bubble--assistant 规则块逐行保全（panel-soft 底 / 1px border /
//     左 3px accent 色条 / radius-md / ring-light+elevation-1）；CDP computed（存在钉）；
//   · C1-7 双色板计算色一致：token 不入 THEME_PALETTES 序列化（浅蓝恒定无板分支可穿帮）+ CDP
//     墨石/终端两板探针同值（存在钉）；
//   · C1-8 导出快照同色（verify 半）：单一来源钉——src/ 全树 .bubble--user 样式仅 MessageBubble.vue
//     一处 + 导出页 ExportPage.vue 复用 MessageList→MessageBubble 同一渲染树（快照同色为结构必然）；
//     CDP 逐像素半依赖真实消息 + 导出流程（隔离场景无 provider，不可达），以组件同源钉为代理判据
//     （已在实施报告申报）。
// CDP 探针手法（A3 组内，C1 增）：从编译样式表反查 MessageBubble 的 scoped data-v 属性构造同构
// 探针元素读 computed——隔离场景无 provider 发不了真消息，与 A2 组 cssVarResolved 探针同源思路；
// --user-data-dir 隔离纪律不变。
// 形态对齐 tdd-tokens-inkstone-verify.ts：check/readRel/`结果：N 通过 / M 失败`/fail>0 exit(1)。
// 运行：npx tsx scripts/tdd-c-chat-stream-verify.ts（登记 scripts/selftest-static-list.txt + tsconfig.tdd.json）

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { THEME_PALETTES } from '../src/shared/constants';

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

const MB_PATH = 'src/renderer/components/chat/MessageBubble.vue';
const mb = readRel(MB_PATH);

function ruleBlock(src: string, selector: string): string {
  const m = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(src);
  assert.ok(m, `${selector} 规则块不存在`);
  return m[1];
}

const userBlock = ruleBlock(mb, '\\.bubble--user');
const assistantBlock = ruleBlock(mb, '\\.bubble--assistant');

// hex → 'rgb(r, g, b)' 纯计算换算：证明 C1-1/C1-7 的 CDP 期望常量与 variables.css token 字面同源。
function hexToRgb(hex: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  assert.ok(m, `hex 形态非法：${hex}`);
  const n = m[1];
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

console.log('=== C1 用户气泡浅蓝 token 化契约（C1-1～C1-8） ===');

// ── C1-1 背景/文字 = 固定浅蓝 token 计算值（源级半；CDP computed 半见尾部存在钉）──
check('C1-1 用户气泡 background 引 var(--color-bubble-user-bg) / color 引 var(--color-bubble-user-ink)', () => {
  assert.ok(/background:\s*var\(--color-bubble-user-bg\)/.test(userBlock), 'background 未引 var(--color-bubble-user-bg)');
  assert.ok(/(^|\n)\s*color:\s*var\(--color-bubble-user-ink\)/.test(userBlock), 'color 未引 var(--color-bubble-user-ink)');
});
check('C1-1 variables.css token 字面 #D9E9ED/#17181A 在位（A3 已落，本点零改动钉）', () => {
  const vars = readRel('src/renderer/assets/styles/variables.css');
  assert.match(vars, /--color-bubble-user-bg:\s*#D9E9ED/i, '缺 --color-bubble-user-bg: #D9E9ED（A3 token 被动）');
  assert.match(vars, /--color-bubble-user-ink:\s*#17181A/i, '缺 --color-bubble-user-ink: #17181A（A3 token 被动）');
});
check('C1-1 token 字面纯计算换算 = CDP 期望常量 rgb(217, 233, 237)/rgb(23, 24, 26)（期望同源不漂移）', () => {
  assert.strictEqual(hexToRgb('#D9E9ED'), 'rgb(217, 233, 237)');
  assert.strictEqual(hexToRgb('#17181A'), 'rgb(23, 24, 26)');
});

// ── C1-2 token 引用而非硬编码 ──
check('C1-2 用户样式块切片零硬编码色值（无 hex、无 rgb( 字面）', () => {
  const hexes = userBlock.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.strictEqual(hexes.length, 0, `切片含硬编码 hex：${hexes.join(',')}（写死色值令 token 改值时气泡脱钩）`);
  assert.ok(!/rgb\(/i.test(userBlock), '切片含 rgb( 硬编码字面');
});

// ── C1-3 accent 混色表达式消失 ──
check('C1-3 用户样式块无 color-mix( 且无任何 accent 引用（旧 accent 12% 派生清零）', () => {
  assert.ok(!userBlock.includes('color-mix('), '切片残留 color-mix(（accent 派生未除净，浅蓝被叠偏色）');
  assert.ok(!/accent/i.test(userBlock), '切片残留 accent 引用（描边/色条派生未除净）');
});

// ── C1-4 accent 描边与右缘 3px 色条消失（源级半；CDP computed 半见存在钉）──
// 裁决机制本身 = `border: 0`（reset 归零），正钉其存在；再豁免 border-radius 行与 reset 行后，
// 切片内不得残留任何其它 border 声明（1px 描边 / border-right 色条 / border-* 子声明全清）。
check('C1-4 用户样式块含 border: 0 reset，且除其与 border-radius 外零 border 声明（描边与右缘色条彻底删除）', () => {
  assert.ok(/(^|\n)\s*border:\s*0;/.test(userBlock), '缺 border: 0 reset（裁决 C-D 机制字面）');
  const stripped = userBlock
    .replace(/border-radius:\s*[^;]+;?/g, '')
    .replace(/border:\s*0;/g, '');
  const residual = stripped.match(/border[^\n;]*/g)?.join(' | ') ?? '';
  assert.ok(!/border/.test(stripped), `切片残留 border 声明：${residual}`);
});

// ── C1-5 圆角 11/11/4/11 + 轻阴影（源级半）──
check('C1-5 用户样式块 border-radius: 11px 11px 4px 11px 字面（TL TR BR BL 序）', () => {
  assert.ok(userBlock.includes('border-radius: 11px 11px 4px 11px'), '缺 border-radius: 11px 11px 4px 11px 字面');
});
check('C1-5 box-shadow 走 var(--ring-light), var(--elevation-1)，且两层 token alpha 均 ≤0.2（轻阴影）', () => {
  assert.ok(
    userBlock.includes('box-shadow: var(--ring-light), var(--elevation-1)'),
    'box-shadow 未走 var(--ring-light), var(--elevation-1)',
  );
  const vars = readRel('src/renderer/assets/styles/variables.css');
  for (const m of vars.matchAll(/--(?:ring-light|elevation-1):\s*([^;\n]+)/g)) {
    const tokenName = (m[0].split(':')[0] ?? '').trim();
    const alphas = [...m[1].matchAll(/rgba?\(([^)]+)\)/g)].map((c) => {
      const parts = c[1].split(',').map((s) => parseFloat(s.trim()));
      return parts.length >= 4 ? (parts[parts.length - 1] ?? 1) : 1;
    });
    assert.ok(alphas.length > 0, `${tokenName} 无 rgba 色分量（可解析性破坏）`);
    for (const a of alphas) assert.ok(a <= 0.2, `${tokenName} 阴影 alpha=${a} > 0.2（违背轻阴影口径）`);
  }
});

// ── C1-6 助手气泡不受影响（保全钉）──
// C2 点同步（2026-11-09）：C2 按计划重做助手卡为「纯白卡」（去左 3px accent 色条、圆角 11px、
// 12px 15px padding，见下方 C2-6）。C1 原快照（含 border-left accent 色条 / radius-md）是对
// C1 实施时点的形态冻结，C2 落地后按红线 4「既有断言同步同点完成」改为钉 C2 后形态的稳定
// 面（panel-soft 底 / 1px 整圈描边 / 轻阴影不因形态重构丢失）——这三项是 C1 语义在 C2 后形态
// 上的延续载体；色条/圆角的裁决性变化归 C2-6 专钉。
check('C1-6 .bubble--assistant 稳定面保全（C2 后形态）：panel-soft 底 / 1px border / 轻阴影', () => {
  assert.ok(assistantBlock.includes('background: var(--color-panel-soft)'), 'assistant 底色被牵动');
  assert.ok(assistantBlock.includes('border: 1px solid var(--color-border)'), 'assistant 1px 描边被牵动');
  assert.ok(assistantBlock.includes('box-shadow: var(--ring-light), var(--elevation-1)'), 'assistant 阴影被牵动');
});

// ── C1-7 双色板计算色一致（源级半：token 不随板；CDP 墨石/终端两板探针见存在钉）──
// 裁决注：#17181A 与墨石 colors.text 同值，序列化负断言不可用它（会误伤墨石自身 text 字段，
// A3-2 同判）；可判别的锚 = bg 值 #D9E9ED（12 板无此值）+ 接口面无 bubble-user 字样。
check('C1-7 浅蓝 token 不入色板面（12 板序列化无 #D9E9ED；constants.ts 无 bubble-user 字样）', () => {
  const dumped = JSON.stringify(THEME_PALETTES);
  assert.ok(!dumped.includes('#D9E9ED'), 'THEME_PALETTES 混入 #D9E9ED（固定 token 被板化，双色板恒定即破）');
  const cst = readRel('src/shared/constants.ts');
  assert.ok(!/bubble[-_]?user/i.test(cst), 'constants.ts 出现 bubble-user 字样（token 被接入色板接口面）');
});

// ── C1-8 导出快照同色（verify 半：单一来源 + 导出链同树复用）──
check('C1-8 src/ 全树 .bubble--user 样式仅 MessageBubble.vue 一处（唯一落点，导出链无本地复制）', () => {
  const srcRoot = path.resolve(__dirname, '..', 'src');
  const repoRoot = path.resolve(__dirname, '..');
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(vue|css|ts)$/.test(name) && /\.bubble--user\b/.test(fs.readFileSync(p, 'utf8'))) {
        hits.push(path.relative(repoRoot, p).replace(/\\/g, '/'));
      }
    }
  };
  walk(srcRoot);
  assert.deepStrictEqual(hits, [MB_PATH], `.bubble--user 样式落点漂移：${hits.join(',')}（导出快照将异源异色）`);
});
check('C1-8 ExportPage.vue 复用 MessageList→MessageBubble 同一渲染树（快照同色为结构必然）', () => {
  const ep = readRel('src/renderer/export/ExportPage.vue');
  assert.ok(ep.includes("from '../components/chat/MessageList.vue'"), '导出页未复用 MessageList（快照渲染链分叉）');
});

// ── C1 CDP 侧存在钉（落点 scripts/cdp-layout-e2e.mjs A3 场景组探针；防静默拆链）──
check('C1 cdp-layout-e2e.mjs 含 .bubble--user/.bubble--assistant 探针断言（C1-1/C1-4/C1-5/C1-6/C1-7 标记 + 期望常量 + 隔离纪律）', () => {
  const cdp = readRel('scripts/cdp-layout-e2e.mjs');
  for (const marker of ['C1-1', 'C1-4', 'C1-5', 'C1-6', 'C1-7', 'probeBubble']) {
    assert.ok(cdp.includes(marker), `cdp-layout-e2e.mjs 缺 ${marker} 标记（CDP 探针被静默拆链）`);
  }
  assert.ok(cdp.includes('11px 11px 4px 11px'), 'CDP 缺圆角期望字面');
  assert.ok(cdp.includes('rgb(217, 233, 237)'), 'CDP 缺浅蓝底期望常量');
  assert.ok(cdp.includes('rgb(23, 24, 26)'), 'CDP 缺深字期望常量');
  assert.ok(cdp.includes('--user-data-dir'), 'CDP 探针场景未隔离 user-data-dir');
});

// ═══════════════════════════════════════════════════════════════════════
// C2 消息形态重构（slate-ui-completion-1108-1428 round-001 点 C2，2026-11-09 增）
// 用例正本 = docs/ui-completion/tests/C-chat-stream-cases.md §C2（C2-1～C2-9 + C2-P1～P6），
// 与 C1 同构：源级结构钉为正身，CDP computed 半依赖真实消息/流式回合（隔离场景无 provider
// 不可达），以结构钉为代理判据 + 真实行为闸门（npm run test:cdp 冒烟 / cdp-turn-sync C 链——
// .bubble--user/.bubble--assistant/.stream-group 选择器被两链消费）兜住；申报同 C1-8 先例。
// 变量约定：mbTpl/mbSty=MessageBubble 模板/样式切片；mlTpl/mlSty=MessageList；srTpl/srSty=StreamRenderer。
// ═══════════════════════════════════════════════════════════════════════

const ML_PATH = 'src/renderer/components/chat/MessageList.vue';
const SR_PATH = 'src/renderer/components/chat/StreamRenderer.vue';
const ml = readRel(ML_PATH);
const sr = readRel(SR_PATH);

// 闭合标签取 lastIndexOf：MessageList 模板内嵌 <template v-for>（L311-338），
// indexOf('</template>') 会切在嵌套闭合处把 stream-group 段整体切丢（首版 C2-P6 假红根因）。
// 模板/样式区段切片（钉只判切片内，防跨区误命中）。
function region(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.lastIndexOf(to);
  assert.ok(a >= 0 && b > a, `区段切片失败：${from} → ${to}`);
  return src.slice(a, b);
}

const mbTpl = region(mb, '<template>', '</template>');
const mbSty = region(mb, '<style scoped>', '</style>');
const mlTpl = region(ml, '<template>', '</template>');
const mlSty = region(ml, '<style scoped>', '</style>');
const srTpl = region(sr, '<template>', '</template>');
const srSty = region(sr, '<style scoped>', '</style>');

console.log('\n=== C2 消息形态重构契约（C2-1～C2-9 + C2-P1～P6） ===');

// ── C2-1 外置角色标签行存在（源级半；CDP 半：气泡上方独立标签行由 C 链真实渲染消费）──
check('C2-1 外置标签行：.msg 根 wrapper + .msg__label 行（role!==system 门控）+ 你/Claude 三元 + 样式在位', () => {
  assert.ok(/<div :class="\['msg', `msg--\$\{message\.role\}`\]">/.test(mbTpl), '根 wrapper .msg 缺失');
  assert.ok(/v-if="message\.role !== 'system'" class="msg__label"/.test(mbTpl), '外置标签行缺失（tdd-native-command v-if 字面钉同源）');
  assert.ok(mbTpl.includes("message.role === 'user' ? '你' : 'Claude'"), '标签文案三元（你/Claude）缺失');
  assert.ok(mbSty.includes('.msg__label {'), '.msg__label 样式缺失');
  assert.ok(mbSty.includes('.msg {'), 'wrapper .msg 样式缺失');
  // 标签行置于气泡外上方（wrapper 内先标签后气泡）
  const labelIdx = mbTpl.indexOf('class="msg__label"');
  const bubbleIdx = mbTpl.indexOf("'bubble', `bubble--${message.role}`");
  assert.ok(labelIdx > 0 && bubbleIdx > labelIdx, '标签行未置于气泡外上方');
});

// ── C2-2 气泡内角色行消失（异常路径：双份角色名残留）──
check('C2-2 角色行消失：MessageBubble 零 bubble__role（模板+样式），StreamRenderer 零 stream__role', () => {
  assert.ok(!mbTpl.includes('bubble__role'), '模板残留 bubble__role（气泡内外双份角色名）');
  assert.ok(!mbSty.includes('.bubble__role'), '样式残留 .bubble__role 规则');
  assert.ok(!srTpl.includes('stream__role'), 'StreamRenderer 模板残留 stream__role');
  assert.ok(!srSty.includes('.stream__role'), 'StreamRenderer 样式残留 .stream__role');
});

// ── C2-3 用户外置标签含「发送于 HH:MM」──
check('C2-3 外置标签含「发送于」：user 门控 + msg__label-time 元素类 + sentAtText computed 留守（S3 零同步）', () => {
  assert.ok(mbTpl.includes('发送于 {{ sentAtText }}'), '文案「发送于 {{ sentAtText }}」缺失');
  assert.ok(/v-if="message\.role === 'user' && sentAtText" class="msg__label-time"/.test(mbTpl), 'user 门控 + msg__label-time 元素类缺失');
  assert.ok(/sentAtText\s*=\s*computed/.test(mb), 'sentAtText computed 被动（应留在 MessageBubble，tdd-user-message-time S3 零同步）');
  assert.ok(mbSty.includes('.msg__label-time {'), '.msg__label-time 样式缺失');
});

// ── C2-4 用户气泡内旧脚注消失（边界：内外双份「发送于」）──
check('C2-4 气泡内旧脚注消失：user&&sentAtText 不再挂 bubble__meta；bubble__meta 中断(v-if)在前+耗时/结束于(v-else-if)门控在位', () => {
  assert.ok(!/message\.role === 'user' && sentAtText" class="bubble__meta"/.test(mbTpl), '气泡内旧「发送于」脚注残留（双份显示）');
  // C6 同步（同点完成，C1-6 随 C2 同步先例）：C6 在正常脚注前新增中断分支——本钉随点更新为
  // C6 后形态：中断分支 v-if 唯一 + 正常脚注改 v-else-if（门控表达式字面不变）+ 分支序钉。
  const metaVifs = [...mbTpl.matchAll(/v-else-if="([^"]*)" class="bubble__meta"/g)].map((m) => m[1] ?? '');
  assert.deepStrictEqual(metaVifs, ['message.durationMs || message.endedAt'], '正常脚注门控漂移（应只剩耗时/结束于脚注，tdd-bugfix-b3/hb10 字面钉同源）');
  const metaInterrupt = [...mbTpl.matchAll(/(?<!-)v-if="([^"]*)" class="bubble__meta"/g)].map((m) => m[1] ?? '');
  assert.deepStrictEqual(metaInterrupt, ['interruptedVisible'], '中断脚注门控漂移（C6 新增中断分支应唯一）');
  assert.ok(
    mbTpl.indexOf('v-if="interruptedVisible" class="bubble__meta"') < mbTpl.indexOf('v-else-if="message.durationMs || message.endedAt" class="bubble__meta"'),
    '中断/正常脚注分支序漂移（C6：中断分支应在正常脚注前）',
  );
});

// ── C2-5「来自队列」pill 保全（边界：重构误删/文案漂移；tdd-queue-semantics-v3 §12 三断言同源）──
check('C2-5 队列 pill 保全：!exportMode 门控 + parentTaskId（80 字符内）+ pill 在气泡内 + 类名/title 逐字', () => {
  assert.ok(/v-if="!exportMode &&[\s\S]{0,80}message\.parentTaskId"/.test(mbTpl), '!exportMode 门控漂移（tdd-queue-semantics-v3 §12 exportMode regex 依赖）');
  assert.ok(mbTpl.includes('来自队列'), '文案「来自队列」漂移（queue-semantics §12 同源）');
  assert.ok(mbTpl.includes('title="此消息由队列任务到点/立即执行时发送"'), 'pill title 文案漂移（逐字契约）');
  assert.ok(mbTpl.includes('bubble__queue-tag'), '类名 bubble__queue-tag 漂移（queue-semantics §12 同源）');
  assert.ok(mbTpl.includes('class="bubble__queue"'), 'pill 宿主行 bubble__queue 缺失');
  const bubbleOpen = mbTpl.indexOf("'bubble', `bubble--${message.role}`");
  const queueIdx = mbTpl.indexOf('class="bubble__queue"');
  assert.ok(bubbleOpen >= 0 && queueIdx > bubbleOpen, 'pill 未迁入气泡内（C2① 裁决：气泡内 pill 不动）');
});

// ── C2-6 AI 卡形态（纯白/无左 accent 色条/圆角 11/细描边；C1-6 稳定面钉已随点同步）──
check('C2-6 AI 卡形态：panel-soft 底 + 1px 细描边整圈 + 无左色条/accent/color-mix + 基线圆角 11px + 12px 15px', () => {
  const base = ruleBlock(mbSty, '\\.bubble(?![-_\\w])');
  const asst = ruleBlock(mbSty, '\\.bubble--assistant');
  assert.ok(base.includes('padding: 12px 15px'), '基线 padding 非 12px 15px（裁决 C-G）');
  assert.ok(base.includes('border-radius: 11px'), '基线圆角非 11px（裁决 C2②）');
  assert.ok(base.includes('width: 100%'), '气泡卡未在 wrapper 内满宽（对齐/限宽应上移 wrapper）');
  assert.ok(asst.includes('background: var(--color-panel-soft)'), 'AI 卡底色漂移（非 panel-soft 纯白系）');
  assert.ok(asst.includes('border: 1px solid var(--color-border)'), 'AI 卡非 1px 细描边');
  assert.ok(!asst.includes('border-left'), 'AI 卡残留左色条（border-left accent 应删除）');
  assert.ok(!/accent/i.test(asst), 'AI 卡残留 accent 引用');
  assert.ok(!asst.includes('color-mix('), 'AI 卡残留 color-mix( 派生');
  assert.ok(asst.includes('box-shadow: var(--ring-light), var(--elevation-1)'), 'AI 卡轻阴影丢失');
});

// ── C2-7 流式组包 AI 卡 + 外置 Claude 标签（并发向：流式更新多帧形态稳定由 C 链真实回合兜住）──
const STREAM_GROUP_VIF =
  'streamingContent || streamingThinking || streamingTool || sessionStore.activeStalledInfo || sessionStore.activeApiRetryInfo || sessionStore.activeApiRetryTerminalFallback';
// C4 标签行计时 span（R1-F1 更正后形态，2026-11-10）：sending 门控——「生成中」基础文案在
// sending 在位期间必显（activeTurnStartedAt 缺失窗口不整段隐藏），streamTimerText 非空才追加
// ' · MM:SS' 分隔段。C2-7 与 C4-1 同字面双保险（先例：pC4 §4-2）。
const MSG_LABEL_TIMER_SPAN =
  '<span class="msg-label__timer" v-if="sending">生成中{{ streamTimerText ? \' · \' + streamTimerText : \'\' }}</span>';
check('C2-7 流式组包卡：stream-group v-if 逐字保全 + 外置 Claude 标签行 + ai-card 镜像助手卡 + tool-stream 去壳 + StreamRenderer 去壳', () => {
  assert.ok(mlTpl.includes(`v-if="${STREAM_GROUP_VIF}"`), 'stream-group v-if 表达式漂移（selftest-settings-mapping L1883 regex 字面依赖，逐字契约）');
  // C4 同点同步（红线4「既有断言同步同点完成」，C1-6 先例同判）：C2 快照时点标签行仅 Claude 单
  // span；C4 在同一 .msg-label 内追加计时 span（见下方 C4 小节），本钉随点更新为 C4 后形态。
  // R1-F1 更正（2026-11-10）：计时 span 改 sending 门控——「生成中」必显，timer 非空才追加
  // ' · ' 分隔段（startedAt 缺失窗口只显「生成中」不带假计时，不再整段隐藏）。
  assert.ok(
    mlTpl.includes('<div class="msg-label"><span>Claude</span>' + MSG_LABEL_TIMER_SPAN + '</div>'),
    '外置 Claude 标签行缺失（C4 后形态：Claude span + sending 门控计时 span）',
  );
  assert.ok(mlTpl.includes('class="ai-card"'), '流式组未包 ai-card');
  assert.ok(mlSty.includes('.msg-label {'), '.msg-label 样式缺失');
  const card = ruleBlock(mlSty, '\\.ai-card');
  for (const piece of ['border-radius: 11px', 'border: 1px solid var(--color-border)', 'padding: 12px 15px', 'background: var(--color-panel-soft)', 'box-shadow: var(--ring-light), var(--elevation-1)']) {
    assert.ok(card.includes(piece), `ai-card 形态漂移：缺 ${piece}（须镜像 .bubble--assistant）`);
  }
  const tool = ruleBlock(mlSty, '\\.tool-stream');
  for (const piece of ['border: 0', 'background: transparent', 'padding: 0', 'max-width: none', 'box-shadow: none']) {
    assert.ok(tool.includes(piece), `tool-stream 卡壳未去净：缺 ${piece}`);
  }
  const stream = ruleBlock(srSty, '\\.stream(?![-_\\w])');
  assert.ok(stream.includes('word-break: break-word') && stream.includes('line-height: 1.8'), '.stream 未收敛为 word-break + line-height:1.8');
  const residual = stream.replace(/word-break:\s*break-word;/g, '').replace(/line-height:\s*1\.8;/g, '').trim();
  assert.strictEqual(residual, '', `.stream 残留卡壳声明：${residual}`);
  assert.ok(srTpl.includes('class="stream"') && srTpl.includes('class="cursor"'), '.stream/.cursor 模板元素漂移');
  assert.ok(srSty.includes('.stream__content :deep(.md-file-link)'), '流式文件链接样式被误删（fix-2 F5 回归）');
  assert.ok(srSty.includes('@keyframes blink'), '流式 cursor 闪烁被误删');
  assert.ok(!srSty.includes('line-height: 1.5'), 'StreamRenderer 残留 1.5 行高（度量统一 1.8，settings-mapping L589 同步断言依赖）');
});

// ── C2-8 横幅独立于 AI 卡之外（边界：重构把横幅卷进卡内）──
check('C2-8 横幅独立：StalledBanner/ApiRetryBanner 挂载点均在 ai-card 开标签之前（流组内卡外独立位）', () => {
  const grp = mlTpl.slice(mlTpl.indexOf('class="stream-group"'));
  const cardOpen = grp.indexOf('class="ai-card"');
  const stalled = grp.indexOf('<StalledBanner');
  const retry = grp.indexOf('<ApiRetryBanner');
  assert.ok(stalled >= 0 && retry >= 0, '横幅挂载点缺失');
  assert.ok(stalled < cardOpen && retry < cardOpen, '横幅被卷进 ai-card 内（层级错乱）');
});

// ── C2-9 形态度量钉（user 74% / AI 100% / 列宽 800 / 行高与 padding 取值）──
check('C2-9 度量：user wrapper 74% / assistant wrapper 100% / 气泡级 max-width 上移 / user padding 9px 13px / 行高 1.5 基线+1.7+1.8 / 列宽 800 保全', () => {
  const userMsg = ruleBlock(mbSty, '\\.msg--user');
  const asstMsg = ruleBlock(mbSty, '\\.msg--assistant');
  assert.ok(userMsg.includes('max-width: 74%'), 'user wrapper 限宽非 74%（规范 C2④）');
  assert.ok(asstMsg.includes('max-width: 100%'), 'assistant wrapper 限宽非 100%');
  assert.ok(userMsg.includes('align-items: flex-end'), 'user 标签行未右对齐（外置形态破损）');
  const userBubble = ruleBlock(mbSty, '\\.bubble--user');
  const asstBubble = ruleBlock(mbSty, '\\.bubble--assistant');
  assert.ok(userBubble.includes('padding: 9px 13px'), 'user padding 非 9px 13px（规范 C2④）');
  assert.ok(!userBubble.includes('max-width') && !userBubble.includes('align-self'), 'user 气泡残留旧对齐/限宽（应上移 wrapper）');
  assert.ok(!asstBubble.includes('max-width') && !asstBubble.includes('align-self'), 'assistant 气泡残留旧对齐/限宽（应上移 wrapper）');
  assert.ok(/\.bubble--user \.bubble__content\s*\{[^}]*line-height:\s*1\.7;/.test(mbSty), 'user 行高非 1.7（规范 C2④）');
  assert.ok(/\.bubble--assistant \.bubble__content\s*\{[^}]*line-height:\s*1\.8;/.test(mbSty), 'assistant 行高非 1.8（规范 C2④）');
  assert.ok(/\.bubble__content\s*\{[^}]*line-height:\s*1\.5;/.test(mbSty), '基线行高 1.5 丢失（system/tool 承载 + settings-mapping L587 字面钉依赖）');
  const vars = readRel('src/renderer/assets/styles/variables.css');
  assert.ok(/--chat-bottom-max-width:\s*800px/.test(vars), '消息列宽 800 被牵动（§5-D2④ 裁决保留）');
  assert.ok(mlSty.includes('var(--chat-bottom-max-width)'), 'MessageList 列宽引用漂移');
});

// ── C2-P1 相邻正文合并零变化（保全：P2-15/P2-16-3/P2-17 三面字面钉的共同底线）──
check('C2-P1 合并接线零变化：MessageList 仍含 groupMessagesForRender( / shouldHidePersistedForStreaming( 调用字面', () => {
  assert.ok(ml.includes('groupMessagesForRender(mainFlowMessages.value)'), 'renderItems 分组调用字面漂移（P2-16-3 结构钉依赖）');
  assert.ok(ml.includes('shouldHidePersistedForStreaming('), '流式去重谓词调用字面漂移');
});

// ── C2-P2 fold 分组零变化（保全：分组/焦点跟随/跟底滚动全套）──
check('C2-P2 分组层零变化：renderItems/activeFoldId/角色分组函数/v-for key/跟底滚动锚 全套字面在位', () => {
  assert.ok(ml.includes('const activeFoldId = computed'), 'activeFoldId 被动');
  assert.ok(ml.includes('function getEffectiveRole(') && ml.includes('function isSenderTransition(') && ml.includes('function isStreamTransition('), '角色分组函数被牵动');
  assert.ok(mlTpl.includes(':key="item.key"'), 'v-for key 绑定被牵动');
  assert.ok(ml.includes('if (innerRef.value) resizeObserver.observe(innerRef.value)'), 'ResizeObserver 观察面被牵动（跟底滚动回退）');
});

// ── C2-P3 队列标导出快照不含契约（保全：v-if 字面含 !exportMode &&）──
check('C2-P3 队列标导出契约：v-if 逐字 = !exportMode && role===user && parentTaskId（tdd-queue-semantics-v3 §12 全绿同判）', () => {
  assert.ok(/v-if="!exportMode && message\.role === 'user' && message\.parentTaskId" class="bubble__queue"/.test(mbTpl), '队列 v-if+class 字面漂移');
});

// ── C2-P4 reasoning_replay 建议保全（异常路径）──
check('C2-P4 reasoning 建议保全：bubble__advice 块 + data-testid 逐字 + 样式在位', () => {
  assert.ok(mbTpl.includes('class="bubble__advice" data-testid="reasoning-replay-advice"'), '建议块类名+testid 逐字契约漂移');
  assert.ok(mbSty.includes('.bubble__advice'), '建议块样式被误删');
});

// ── C2-P5 错误气泡整卡红保全（异常路径：卡化误伤红卡）──
check('C2-P5 错误气泡整卡红：.bubble--error 规则块逐字（fail 50% 描边/12% 底/fail-strong 字）+ 模板绑定字面', () => {
  const err = ruleBlock(mbSty, '\\.bubble--error');
  assert.ok(err.includes('border-color: color-mix(in srgb, var(--color-fail) 50%, transparent)'), 'error 描边漂移');
  assert.ok(err.includes('background: color-mix(in srgb, var(--color-fail) 12%, transparent)'), 'error 底漂移');
  assert.ok(err.includes('color: var(--color-fail-strong)'), 'error 字色漂移');
  assert.ok(mbTpl.includes("'bubble--error': message.isError === true"), '模板 error 绑定字面漂移（settings-mapping L2075 依赖）');
});

// ── C2-P6 导出模式渲染不回归（边界：导出链 + msg-transition 接线）──
check('C2-P6 导出不回归：export 动画关闭块在位 + msg-transition 接线保全 + C1-8 导出同树钉仍在（上方）', () => {
  assert.ok(mlSty.includes('.message-list--export :deep(*)'), '导出动画关闭块缺失（新元素须同被覆盖）');
  assert.ok(mlSty.includes('animation: none !important'), '导出动画关闭声明漂移');
  assert.ok(mlTpl.includes("'msg-transition': isSenderTransition(idx)"), 'MessageBubble msg-transition 接线漂移');
  assert.ok(mlTpl.includes("'msg-transition': isStreamTransition()"), 'stream-group msg-transition 接线漂移');
});

// ── C2 类名保全底线（B/C 链选择器与静态钉共同底线：.bubble--user/.bubble--assistant/.stream-group）──
check('C2 选择器底线：bubble--user/bubble--assistant/bubble__content 留在内层气泡元素，stream-group 保留（C 链消费）', () => {
  assert.ok(mbTpl.includes('`bubble--${message.role}`'), '内层气泡动态类漂移（CDP .bubble--user/.bubble--assistant 选择器依赖）');
  assert.ok(mbTpl.includes('class="bubble__content"'), 'bubble__content 类漂移（B 链/纯文本钉依赖）');
  assert.ok(mlTpl.includes('class="stream-group"'), 'stream-group 类漂移（C 链选择器依赖）');
});

// ═══════════════════════════════════════════════════════════════════════
// C3 工具行运行态修复（slate-ui-completion-1108-1428 round-001 点 C3，2026-11-09 增，真实缺陷）
// 用例正本 = docs/ui-completion/tests/C-chat-stream-cases.md §C3（C3-1～C3-7）。
// C3-1/2/3/4/5 断言形态为 CDP computed/文本：隔离场景无 provider 发不了真回合（与 C1-8/C2
// 同判），以源级结构钉为代理判据 + 真实行为闸门（npm run test:cdp 冒烟 / node
// scripts/cdp-turn-sync-e2e.mjs C 链——中断/计时情景）兜住；C3-6 导出半同 C1-8 代理判据
//（导出链同树复用为结构必然）；C3-7 即结构钉本体（判据接线落点=ProcessGroup.vue :running
// 绑定，展示分支落点=ToolCallBlock.vue 状态链，待裁决项据此登记双文件名）。
// 变量约定：pgTpl/pgSty=ProcessGroup 模板/样式切片；tcbTpl/tcbSty=ToolCallBlock 同名；
// tcbStatus=ToolCallBlock 状态链切片（tool-row__status 至 head 闭合 </button>）。
// ═══════════════════════════════════════════════════════════════════════

const PG_PATH = 'src/renderer/components/chat/ProcessGroup.vue';
const TCB_PATH = 'src/renderer/components/chat/ToolCallBlock.vue';
const pg = readRel(PG_PATH);
const tcb = readRel(TCB_PATH);
const pgTpl = region(pg, '<template>', '</template>');
const pgSty = region(pg, '<style scoped>', '</style>');
const tcbTpl = region(tcb, '<template>', '</template>');
const tcbSty = region(tcb, '<style scoped>', '</style>');
const statusStart = tcbTpl.indexOf('class="tool-row__status"');
const tcbStatus = tcbTpl.slice(statusStart, tcbTpl.indexOf('</button>', statusStart));

console.log('\n=== C3 工具行运行态修复契约（C3-1～C3-7） ===');

// ── C3-1 中止态「✗ 已中断」替换运行脉冲（真实缺陷本体，修复前必红）──
// CDP 半的代理判据：中止分支在 else-if 链 running 两分支之后 → 中止态下 dots span 根本不
// 渲染，tool-dot-pulse 动画（挂在 .tool-row__dots span 上）无从存在，即 animationName ≠
// tool-dot-pulse 的结构等价；文字色 = fail 语义 token（#8B3A3A）纯计算换算与 C1-1 同构。
check('C3-1 中止态分支：use && !result 门控 +「✗ 已中断」文案 + tool-row__interrupt 类 + fail 语义色 token（非运行蓝）+ 分支排在 running 两分支之后（脉冲不可达）', () => {
  assert.ok(
    tcbStatus.includes('<span v-else-if="use && !result" class="tool-row__interrupt">✗ 已中断</span>'),
    '缺中止态分支字面（回合结束后未回结果行仍假运行态——缺陷本体未修）',
  );
  const chain = [
    'v-if="running && elapsedSeconds != null" class="tool-row__elapsed"',
    'v-else-if="running" class="tool-row__dots"',
    'v-else-if="use && !result" class="tool-row__interrupt"',
    'v-else-if="backgroundRunning" class="tool-row__bg"',
    'v-else-if="result && result.isError" class="tool-row__fail"',
    'v-else-if="result" class="tool-row__done"',
  ].map((piece) => tcbStatus.indexOf(piece));
  assert.ok(chain.every((i) => i > 0), '状态链分支字面缺失');
  assert.ok(chain.every((v, i) => i === 0 || v > (chain[i - 1] ?? 0)), '状态链分支顺序漂移（running 两分支必须在前——脉冲优先，中止态在其后才可达）');
  const interrupt = ruleBlock(tcbSty, '\\.tool-row__interrupt');
  assert.ok(interrupt.includes('color: var(--color-fail-strong)'), '中止态未走 fail 语义色 token（运行蓝=假运行观感延续）');
  assert.strictEqual(hexToRgb('#8B3A3A'), 'rgb(139, 58, 58)');
  assert.ok(!/accent/i.test(interrupt), '中止态色残留 accent 引用（与 C1-3 同判：非运行蓝）');
});

// ── C3-2 sending=true 期间脉冲完全不变（保全，现状即绿）──
check('C3-2 保全运行态：running 判据以 stats.running 开头（只追加因子）、elapsed/dots 两分支与 tool-dot-pulse keyframes 零触碰', () => {
  const runningBinding = pgTpl.match(/:running="([^"]*)"/)?.[1] ?? '';
  assert.ok(runningBinding.startsWith('stats.running'), 'running 判据首因子漂移（stats.running 被动）');
  assert.ok(tcbStatus.includes('v-if="running && elapsedSeconds != null" class="tool-row__elapsed"'), '⏱ elapsed 分支漂移');
  assert.ok(tcbStatus.includes('v-else-if="running" class="tool-row__dots"'), 'dots 分支漂移');
  assert.ok(tcbSty.includes('animation: tool-dot-pulse 1.4s infinite ease-in-out both'), 'pulse 动画声明被牵动');
  assert.ok(tcbSty.includes('@keyframes tool-dot-pulse'), 'keyframes 被误删（运行态仍用）');
});

// ── C3-3 正常完成/失败行不变（保全，现状即绿）──
check('C3-3 保全完成/失败态：✓ done 分支 + ✗ fail 分支字面与各自样式逐字保全', () => {
  assert.ok(tcbStatus.includes('v-else-if="result && result.isError" class="tool-row__fail">✗</span>'), '失败分支字面漂移');
  assert.ok(tcbStatus.includes('v-else-if="result" class="tool-row__done">✓</span>'), '完成分支字面漂移');
  assert.ok(tcbSty.includes('.tool-row__done'), 'done 样式被牵动');
  assert.ok(ruleBlock(tcbSty, '\\.tool-row__fail').includes('color: var(--color-fail-strong)'), 'fail 样式色被牵动');
});

// ── C3-4 后台态不受影响（保全/边界，现状即绿）──
// 互斥论证（impl §3.2）：backgroundRunning 来自 activeBackgroundTasks 反查（ProcessGroup
// L33-39），后台任务的 tool_result 已回 → result 非空 → 中止分支条件 use && !result 恒假，
// 后台分支不会被中止态吞掉；分支位次（中止之后）归 C3-1 链序断言统一钉。
check('C3-4 后台态不吞：🔁后台分支字面/样式保全', () => {
  assert.ok(tcbStatus.includes('v-else-if="backgroundRunning" class="tool-row__bg">🔁后台</span>'), '后台分支字面漂移/被吞');
  assert.ok(tcbSty.includes('.tool-row__bg'), '后台标注样式被牵动');
});

// ── C3-5 切会话重入不误判（真实判据接线，修复前必红）──
// 机制根：running 判据接 store.sending——sending 是按活动会话派生的 getter
//（session-store L315-317：runningSessions.includes(activeSession.id)），切走/切回自动重评，
// 无行级缓存态可残留（切回仍在跑→脉冲；切回已结束→中止态，双向不误判）。
check('C3-5 重入不误判：ProcessGroup :running 含 && store.sending 因子 + sending 为按活动会话派生 getter（机制根）+ ToolCallBlock 状态链零行级缓存', () => {
  assert.ok(
    pgTpl.includes(':running="stats.running && !item.result && store.sending"'),
    'running 判据未接 sending（切回已结束会话仍脉冲=误判方向一；未接判据即无双向保证）',
  );
  const ss = readRel('src/renderer/stores/session-store.ts');
  assert.match(
    ss,
    /sending\(state\):\s*boolean\s*\{\s*return !!state\.activeSession && state\.runningSessions\.includes\(state\.activeSession\.id\);/,
    'sending 非按活动会话派生 getter（重入正确性机制根被牵动）',
  );
  assert.ok(!/wasInterrupted|interruptCache|statusCache/.test(tcb), 'ToolCallBlock 引入行级缓存态（切会话重入残留旧态的机制根）');
});

// ── C3-6 导出模式同判据（修复前必红）──
check('C3-6 导出同判据：ProcessGroup :running 绑定唯一不分叉（导出链复用同一表达式）+ 中止分支零 exportMode 门控 + 导出链同树（C1-8 钉同源）', () => {
  const bindings = [...pgTpl.matchAll(/:running="([^"]*)"/g)].map((m) => m[1] ?? '');
  assert.deepStrictEqual(
    bindings,
    ['stats.running && !item.result && store.sending'],
    'running 绑定漂移或按 exportMode 分叉（导出快照异判据）',
  );
  assert.ok(!/exportMode/.test(tcbStatus), '中止分支被 exportMode 门控（导出快照内仍脉冲/无中止态）');
  const ep = readRel('src/renderer/export/ExportPage.vue');
  assert.ok(ep.includes("from '../components/chat/MessageList.vue'"), '导出链分叉（快照渲染异树，C1-8 同源钉）');
});

// ── C3-7 中止判据接线结构钉（契约失守守卫，修复前必红）──
check('C3-7 结构钉：判据接线字面（ProcessGroup）+「已中断」文案字面（ToolCallBlock）+ tool-dot-pulse keyframes 保留 + ▾/▴ 箭头逐字（裁决 C-C）+ fold 机制红线零触', () => {
  assert.ok(pg.includes('stats.running && !item.result && store.sending'), '判据接线字面缺失（后续重构无人拦截）');
  assert.ok(tcb.includes('✗ 已中断'), '「已中断」文案字面缺失');
  assert.ok(tcbSty.includes('@keyframes tool-dot-pulse'), 'keyframes 被误删（运行态仍用）');
  assert.ok(tcbTpl.includes('▾') && tcbTpl.includes('▴'), '展开箭头字符被牵动（裁决 C-C：逐字保留）');
  // 红线保全：foldOpenState 机制/thinkingSealed 口径/items 配对零触（本点只追加判据因子）
  assert.ok(pg.includes("const foldOpenState = reactive(new Map<string, boolean>());"), 'foldOpenState 机制被牵动');
  assert.ok(pg.includes('const thinkingSealed = computed(() => !(props.stats.running && store.sending));'), 'thinkingSealed 口径被牵动');
  assert.ok(pg.includes('resultByToolUseId.set(m.toolUseId, m)'), 'items 配对机制被牵动');
  assert.ok(pgSty.includes('.process-fold__summary') && pgTpl.includes(':aria-controls="panelId"'), 'fold 摘要/aria 结构被牵动');
});

// ═══════════════════════════════════════════════════════════════════════
// C4 流式计时第三面「生成中 · 计时」（slate-ui-completion-1108-1428 round-001 点 C4，2026-11-09 增）
// 用例正本 = docs/ui-completion/tests/C-chat-stream-cases.md §C4（C4-1～C4-6）。
// C4-1/C4-2/C4-4/C4-5 断言形态为 CDP 真实回合文本/双页编排：隔离场景无 provider 发不了真回合
//（与 C1-8/C2/C3 同判），以源级结构钉为代理判据 + 真实行为闸门（npm run test:cdp 冒烟 /
// node scripts/cdp-turn-sync-e2e.mjs C 链——TurnTimer 递增+退场断言即 C4-6 三面并存面）兜住；
// C4-3 即结构钉本体（数据纪律负断言 + 引用字面；组件文件名登记：MessageList.vue，占位就此落定）；
// C4-6 = TurnTimer 零触 + 完成态脚注保全 + C 链断言面在位（保全，现状即绿）。
// turn-projection 契约核对（点指令明示）= 计时派生链与 TurnTimer.vue:17-23 逐款同构的结构钉
//（C4-3b：四款从 TurnTimer 源码运行时提取，逐款钉 MessageList 同款在位——同源不漂移）。
// 变量约定：tt=TurnTimer 源；un=use-now 源；ssStore=session-store 源（C3-5 的 ss 为其检查闭包
// 局部量，不冲突）。
// ═══════════════════════════════════════════════════════════════════════

const TT_PATH = 'src/renderer/components/chat/TurnTimer.vue';
const tt = readRel(TT_PATH);
const un = readRel('src/renderer/composables/use-now.ts');
const ssStore = readRel('src/renderer/stores/session-store.ts');

console.log('\n=== C4 流式计时第三面契约（C4-1～C4-6） ===');

// ── C4-1 「生成中 · 计时」出现（源级代理半；CDP 真实递增半见存在钉与真实闸门申报）──
// R1-F1 更正（2026-11-10）：sending 门控必显「生成中」基础文案，streamTimerText 非空才以
// ' · ' 分隔追加计时——startedAt 缺失窗口不再整段隐藏（行为规范 C4 目标态，impl §4.2 边界表）。
check('C4-1 标签行落点：C2 .msg-label 内 Claude span 后挂计时 span（sending 门控 + class msg-label__timer + 「生成中」前缀逐字）', () => {
  assert.ok(
    mlTpl.includes('<div class="msg-label"><span>Claude</span>' + MSG_LABEL_TIMER_SPAN + '</div>'),
    '计时 span 缺失或形态漂移（未挂 C2 标签行内 / 非 sending 门控 / 「生成中」前缀漂移 / 类名漂移）',
  );
});

check("C4-1 计时分隔形态：streamTimerText 存在时以 ' · ' 分隔追加（缺失窗口只显「生成中」，不出「· 0.0s」假值）", () => {
  assert.ok(
    mlTpl.includes("{{ streamTimerText ? ' · ' + streamTimerText : '' }}"),
    "计时分隔形态漂移（streamTimerText 非空须以 ' · ' 分隔追加）",
  );
});

check('C4-1 接线：useNow/formatDurationMs 导入 + streamTimerText computed 在位（禁自算：无第二钟源导入）', () => {
  assert.ok(ml.includes("import { useNow } from '../../composables/use-now';"), '缺 useNow 导入（统一时钟源未接）');
  assert.ok(ml.includes("import { formatDurationMs } from '../../../shared/format-duration';"), '缺 formatDurationMs 导入（裁决 C-A：与 TurnTimer 同源格式）');
  assert.ok(/const streamTimerText = computed\(/.test(ml), 'streamTimerText computed 缺失');
  assert.ok(!/from '[^']*\/(date-fns|dayjs|moment)/.test(ml), '引入第三方日期库（第二钟源，禁自算域外依赖）');
});

check('C4-1 递增驱动（代理钉）：computed 读 now.value（useNow 100ms tick 唯一驱动；统一时钟源 tick 在位零触）', () => {
  assert.ok(
    /return formatDurationMs\(Math\.max\(0, now\.value \+ sessionStore\.activeTurnClockOffset - start\)\);/.test(ml),
    '取值式未读 now.value（tick 不驱动重评=死值）或缺时钟协议取值式',
  );
  assert.ok(un.includes('}, 100);'), 'useNow 100ms tick 缺失（统一时钟源被牵动）');
});

// ── C4-2 回合结束消失（源级代理半：guard 首行 + 计时 span v-if="sending" 门控 → sending=false 卸载零残留）──
// R1-F1 更正（2026-11-10）：卸载门由「streamTimerText 空串 falsy」改为 sending 直门控
//（同时修复 startedAt 缺失窗口整段隐藏）——computed guard 保留，回合结束文本归空语义不变。
check('C4-2 回合结束消失：computed 首行 if (!props.sending) return \'\' + 计时 span v-if="sending"（sending=false→span 卸载，零「生成中」残留）', () => {
  assert.ok(
    /const streamTimerText = computed\(\(\) => \{\s*\r?\n\s*if \(!props\.sending\) return '';/.test(ml),
    'computed 未以 sending guard 开头（回合结束后计时仍显示）',
  );
  assert.ok(mlTpl.includes('v-if="sending"'), '模板 sending 门控缺失（回合结束后「生成中」残留）');
});

// ── C4-3 数据纪律结构钉（负断言本体；组件文件名登记：MessageList.vue = AI 外置标签行渲染组件）──
check('C4-3 数据纪律三断言：MessageList.vue 零 setInterval( 字面（禁自建计时器）+ 含回合开始投影引用 + 含统一时钟源（含偏移校正）引用', () => {
  assert.ok(!ml.includes('setInterval('), 'MessageList 组件内出现 setInterval(（偷建计时器：后台节流错步/泄漏，v0.4.10 前教训）');
  assert.ok(ml.includes('sessionStore.activeTurnStartedAt'), '缺回合开始时间投影引用（turn-projection 公开导出）');
  assert.ok(/useNow\(\(\) => !!props\.sending\)/.test(ml) && ml.includes('sessionStore.activeTurnClockOffset'), '缺统一时钟源引用（useNow 门控 + serverClockOffset 偏移校正）');
});

// ── C4-3b turn-projection 契约核对（点指令明示）：计时派生链与 TurnTimer.vue:17-23 逐款同构 ──
// 四款从 TurnTimer 源码运行时提取（非硬编码拷贝——参照面漂移时本钉先红），逐款钉 MessageList
// 同款在位：款1 useNow 门控 / 款2 起点=activeTurnStartedAt 投影 / 款3 空起点守卫 / 款4 时钟协议
// Math.max(0, now+offset-start)。
check('C4-3b 同构钉（vs TurnTimer.vue:17-23 逐款）：useNow 门控/起点投影/空起点守卫/时钟协议四款同构在位', () => {
  const refs = [
    /useNow\(\(\) => sending\.value\)/,
    /const start = sessionStore\.activeTurnStartedAt;/,
    /if \(!start\) return/,
    /Math\.max\(0, now\.value \+ sessionStore\.activeTurnClockOffset - start\)/,
  ];
  for (const ref of refs) assert.ok(ref.test(tt), `TurnTimer 参照款漂移（${ref} 不复命中，本钉失效需重校）`);
  assert.ok(/useNow\(\(\) => !!props\.sending\)/.test(ml), '款1 useNow 门控漂移（消息列表侧应以 props.sending 门控）');
  assert.ok(ml.includes('const start = sessionStore.activeTurnStartedAt;'), '款2 起点未读 activeTurnStartedAt 投影（与 TurnTimer 异源）');
  assert.ok(/if \(!start\) return/.test(ml), '款3 空起点守卫缺失（无数据造数风险）');
  assert.ok(/Math\.max\(0, now\.value \+ sessionStore\.activeTurnClockOffset - start\)/.test(ml), '款4 时钟协议漂移（裸 Date.now() 相减/缺偏移校正/缺负值钳制）');
});

// ── C4-4 后台会话切回不错步（代理钉）──
// 机制链：起点/偏移 = activeSession 键控 store 投影（切回重读权威起点）+ useNow 失活停跳不累计
// 假时间、激活 start() 首行即重读本地钟 + computed 形态钉（逐字全形态——任何注入的本地累计态
// 都会破坏该形态）。
check('C4-4 切回不错步：投影 activeSession 键控（重读权威起点）+ useNow 失活停跳/激活即重读 + computed 逐字全形态（零本地累计态注入面）', () => {
  assert.ok(
    /activeTurnStartedAt\(state\): number \| null \{[\s\S]{0,120}turnStartedAt\[state\.activeSession\.id\] \?\? null;/.test(ssStore),
    '起点投影非 activeSession 键控（切回不重读权威起点=错步根源）',
  );
  assert.ok(
    /activeTurnClockOffset\(state\): number \{[\s\S]{0,120}serverClockOffset\[state\.activeSession\.id\] \?\? 0;/.test(ssStore),
    '偏移投影非 activeSession 键控（本地钟无校正）',
  );
  assert.ok(/function start\(\): void \{\s*\r?\n\s*now\.value = Date\.now\(\);/.test(un), 'useNow 激活未即重读时钟（切回起点漂移面）');
  assert.ok(/\{\s*\r?\n\s*if \(on\) start\(\);\s*\r?\n?\s*else stop\(\);/.test(un), 'useNow 失活未停跳（后台节流期间仍累计假时间）');
  assert.ok(
    /const streamTimerText = computed\(\(\) => \{\s*\r?\n\s*if \(!props\.sending\) return '';\s*\r?\n\s*const start = sessionStore\.activeTurnStartedAt;\s*\r?\n\s*if \(!start\) return '';[^\r\n]*\r?\n\s*return formatDurationMs\(Math\.max\(0, now\.value \+ sessionStore\.activeTurnClockOffset - start\)\);\s*\r?\n\s*\}\);/.test(ml),
    'computed 形态漂移（注入本地累计态=切回错步机制根）',
  );
  assert.ok(!/now\.value\s*\+=/.test(ml), '对 now 累加（本地累计态，后台停摆期错步）');
});

// ── C4-5 多会话并行只显当前会话计时（代理钉）──
// 派生只读 activeSession 键控投影（getter 层是唯一跨会话安全面）；组件零直连映射读（直读
// turnStartedAt[ / serverClockOffset[ 才可能跨会话取值）；流式内容走 props 快照（C2-7 STREAM_GROUP_VIF
// 钉已锚 props 三元开头，后台会话流不落本组件）。
check('C4-5 不串显：派生只走活动会话投影（组件零 turnStartedAt[/serverClockOffset[ 直连映射读）', () => {
  assert.ok(!/sessionStore\.turnStartedAt\[/.test(ml), '组件直读 turnStartedAt 映射（可跨会话取值=B 显 A 计时面）');
  assert.ok(!/sessionStore\.serverClockOffset\[/.test(ml), '组件直读 serverClockOffset 映射（可跨会话取值）');
  assert.ok(ml.includes('const start = sessionStore.activeTurnStartedAt;'), '派生未走活动会话投影');
});

// ── C4-6 三面并存不冲突（保全，现状即绿）──
// 三面=TurnTimer 底部状态条计时 / 本点流式标签计时 / 完成态气泡脚注计时。四处同读
// activeTurnStartedAt/activeTurnClockOffset + 同用 formatDurationMs → 同值同格式（裁决 C-A）。
check('C4-6 三面并存：TurnTimer 派生链零触（红线：本体零改动）+ 完成态脚注（formatDurationMs/bubble__meta 门控）保全 + C 链 .turn-timer__time 断言面在位', () => {
  assert.ok(tt.includes('Math.max(0, now.value + sessionStore.activeTurnClockOffset - start)'), 'TurnTimer 派生链被牵动（红线：TurnTimer 本体零改动）');
  assert.ok(tt.includes("{{ formatDurationMs(elapsedMs) }}"), 'TurnTimer 展示格式被牵动（裁决 C-A 同源三面）');
  assert.ok(mb.includes('formatDurationMs'), '完成态脚注 formatDurationMs 被牵动（regression-tests.ts:110 同源）');
  assert.ok(mbTpl.includes("message.durationMs || message.endedAt"), '完成态脚注门控被牵动（C2-4 同源钉）');
  const cchain = readRel('scripts/cdp-turn-sync-e2e.mjs');
  assert.ok(cchain.includes('.turn-timer__time'), 'C 链计时断言面缺失（三面并存真实行为闸门被拆链）');
});

// ── C4 类名互斥（旧计时器迁出互斥钉，regression-tests.ts:106）──
check('C4 类名互斥：MessageList 零 turn-timer 子串（msg-label__timer 有意避开）+ 互斥钉本体保全', () => {
  assert.ok(!ml.includes('turn-timer'), 'MessageList 出现 turn-timer 子串（regression-tests.ts:106 必红）');
  assert.ok(ml.includes('msg-label__timer'), '计时类名 msg-label__timer 缺失（本点唯一新增类名）');
  const rt = readRel('scripts/regression-tests.ts');
  assert.ok(rt.includes("assert.ok(!messageList.includes('turn-timer'), 'MessageList 不得再内嵌 turn-timer');"), '互斥钉本体被牵动（互斥契约面漂移）');
});

// ═══════════════════════════════════════════════════════════════════════
// C5 空消息态（slate-ui-completion-1108-1428 round-001 点 C5，2026-11-09 增）
// 用例正本 = docs/ui-completion/tests/C-chat-stream-cases.md §C5（C5-1～C5-6 共 6 例，
// 正常 C5-1/2、边界 C5-3/4、异常路径 C5-5/6；并发向用例卷显式申报不适用）。
// C5-1/2/3/4 断言形态为 CDP（空会话采样/首条消息退场/≤50ms 连续采样防闪帧/空会话与有
// 消息会话互切）——隔离场景无 provider 发不了真回合（与 C1-8/C2/C3/C4 同判），以源级
// 结构钉为代理判据 + data-testid="chat-empty-state" 采样面登记（后续真实链路抽样锚）；
// C5-5/C5-6 即结构钉本体（横幅/无流式判据字面钉进 showEmptyState 切片）。
// 待裁决项回填（用例卷 C5-5「横幅根类名」）：横幅判据从现状源码抽取——stream-group v-if
// 的三横幅因子 = sessionStore.activeStalledInfo / activeApiRetryInfo /
// activeApiRetryTerminalFallback（MessageList.vue 模板区现状字面），空态条件与同源钉。
// 空态与「无会话态」互斥：本组件仅在 activeSession 存在时挂载（ChatPage 守卫），属上游
// 结构不在本文件钉域；导出模式空态绝不出（!props.exportMode 首因子守卫）。
// 居中机制（impl §5.2 + 贴底约束调和，以根容器派生规则落地）：空态在场时根容器挂
// --empty（仅 showEmptyState 真值绑定）→ scroller 贴底伪元素让位
//（.message-list--empty .message-list__scroller::before margin-bottom:0——auto margin
// 吸剩余空间优先于 flex-grow，不让位则 inner 永不生长、空态贴底不居中）+ inner
// flex:1 撑满 → .msg-empty margin:auto 双轴居中。根容器 :class 仅追加一键、scroller/
// inner 模板字面零改动（tdd-bugfix-opt6/hb12/b2 三既有契约脚本钉其字面——C5 红线钉
// 设保全线守护），非空态布局字节级不变——跟底滚动判定不被空态干扰（本点红线）。
// ═══════════════════════════════════════════════════════════════════════

const EMPTY_BLOCK_VIF = '<div v-if="showEmptyState" class="msg-empty" data-testid="chat-empty-state">';
const EMPTY_EYEBROW = '<p class="msg-empty__eyebrow">CHAT</p>';
const EMPTY_TITLE = '<h1 class="msg-empty__title">开始与 Claude 对话</h1>';
const EMPTY_HINT = '<p class="msg-empty__hint">输入第一条消息，或输入 / 使用命令</p>';
function showEmptyStateSlice(): string {
  const m = /const showEmptyState = computed\(\(\) =>([\s\S]*?)\);/.exec(ml);
  assert.ok(m, 'showEmptyState computed 缺失');
  return m[1] ?? '';
}

console.log('\n=== C5 空消息态契约（C5-1～C5-6 + 红线钉） ===');

// ── C5-1 空态三行文案逐字（正常向；CDP 采样面 = data-testid chat-empty-state）──
check('C5-1 空态块逐字：testid + 三行节点文案（CHAT/开始与 Claude 对话/输入第一条消息，或输入 / 使用命令）+ 居中机制链 + 落点（inner 内、v-for 前）', () => {
  for (const [name, node] of [['容器', EMPTY_BLOCK_VIF], ['eyebrow', EMPTY_EYEBROW], ['标题', EMPTY_TITLE], ['副文', EMPTY_HINT]] as const) {
    assert.ok(mlTpl.includes(node), `空态块 ${name} 节点缺失或逐字漂移：${node}`);
  }
  // 行序钉（三行自上而下）。
  const idx = (s: string): number => mlTpl.indexOf(s);
  assert.ok(idx(EMPTY_BLOCK_VIF) > 0 && idx(EMPTY_EYEBROW) > idx(EMPTY_BLOCK_VIF) && idx(EMPTY_TITLE) > idx(EMPTY_EYEBROW) && idx(EMPTY_HINT) > idx(EMPTY_TITLE), '空态三行行序漂移');
  // 落点钉（impl §5.1：.message-list__inner 内、<template v-for> 之前）。
  const innerOpen = mlTpl.indexOf('class="message-list__inner"');
  const emptyIdx = mlTpl.indexOf('data-testid="chat-empty-state"');
  const vForIdx = mlTpl.indexOf('<template v-for');
  assert.ok(innerOpen >= 0 && emptyIdx > innerOpen && vForIdx > emptyIdx, '空态块落点漂移（须在 inner 内、v-for 之前）');
  // 居中（CDP computed 对齐居中布局的结构等价钉）：margin:auto 双轴居中 + 空态在场时
  // 根容器挂 --empty → 贴底伪元素让位 + inner flex:1 撑满（auto margin 吸空间优先于
  // flex-grow，不让位则 inner 永不生长、空态贴底不居中）。
  const emptyCss = ruleBlock(mlSty, '\\.msg-empty');
  assert.ok(emptyCss.includes('margin: auto'), '空态缺 margin:auto（不居中）');
  assert.ok(emptyCss.includes('align-items: center') && emptyCss.includes('text-align: center'), '空态内行居中声明漂移');
  assert.ok(/\.message-list--empty \.message-list__scroller::before\s*\{[^}]*margin-bottom:\s*0;/.test(mlSty), '空态让位规则缺失/未归零贴底 auto margin（空态贴底不居中）');
  const innerEmpty = ruleBlock(mlSty, '\\.message-list--empty \\.message-list__inner');
  assert.ok(innerEmpty.includes('flex: 1'), '空态 inner 未 flex:1 撑满（margin:auto 无空间可吸=空态贴底不居中）');
});

// ── C5-2 发送首条消息后消失（正常向；机制根 = 乐观落库后 length>0 自然翻转）──
check('C5-2 首条消息即退场：showEmptyState 含 renderItems.value.length === 0 判据（首条 user 消息乐观落 store → length>0 → 空态自然卸载）', () => {
  assert.ok(/renderItems\.value\.length === 0/.test(showEmptyStateSlice()), 'showEmptyState 缺 renderItems.length===0 判据（发送首条消息后空态不消失）');
});

// ── C5-3 sending 起步不闪现（边界向；impl §5.2：!props.sending 前置守卫比「流式元素已
// 出现」更强的防闪现——起步首帧流式串可能仍为空，空态须已随 sending 退场）──
check('C5-3 sending 起步不闪现：showEmptyState 含 !props.sending 守卫且先于无流式判据（无「空态与流式同帧在场」窗口）', () => {
  const slice = showEmptyStateSlice();
  const sendingGuard = slice.indexOf('!props.sending');
  const streamGuard = slice.indexOf('!props.streamingContent');
  assert.ok(sendingGuard >= 0, '缺 !props.sending 守卫（sending 起步瞬间流式元素未现仍显空态=闪现面）');
  assert.ok(streamGuard >= 0, '缺 !props.streamingContent 判据');
  assert.ok(sendingGuard < streamGuard, 'sending 守卫未前置（impl §5.2 防闪现守卫应先于无流式判据）');
});

// ── C5-4 切会话条件正确（边界向；机制根 = 空态判据只读按当前 props.messages 派生的
// renderItems——切到有消息会话 length>0 不显、切回空会话再显；跟底复位链零触）──
check('C5-4 切会话条件正确：renderItems 按 props.messages 派生 + showEmptyState 只读 renderItems + 切会话跟底复位 watch 零触（C2-P2 同源）', () => {
  assert.ok(ml.includes('groupMessagesForRender(mainFlowMessages.value)'), 'renderItems 未按 props.messages（当前会话）派生（切会话条件漂移根源，C2-P1 同源）');
  assert.ok(/renderItems\.value\.length === 0/.test(showEmptyStateSlice()), '空态判据未读 renderItems（切会话不随当前会话翻转）');
  assert.ok(/\(\) => sessionStore\.activeSession\?\.id,/.test(ml), '切会话跟底复位 watch 被牵动（近底态跨会话残留回退）');
});

// ── C5-5 横幅在场不出现空态（异常路径钉本体；回填依据见小节块注释）──
check('C5-5 横幅判据钉：showEmptyState 切片含三横幅判据字面（activeStalledInfo/activeApiRetryInfo/activeApiRetryTerminalFallback，与 stream-group v-if 同源）', () => {
  const slice = showEmptyStateSlice();
  for (const ref of ['sessionStore.activeStalledInfo', 'sessionStore.activeApiRetryInfo', 'sessionStore.activeApiRetryTerminalFallback']) {
    assert.ok(slice.includes(ref), `空态条件缺横幅判据 ${ref}（消息空+横幅在场仍显空态：横幅被空态挤压）`);
    assert.ok(STREAM_GROUP_VIF.includes(ref), `stream-group v-if 横幅因子漂移（${ref}，回填参照面失守本钉需重校）`);
  }
});

// ── C5-6 「无流式」条件钉（异常路径钉本体）──
check('C5-6 无流式条件钉：showEmptyState 切片含三流式判据字面（!streamingContent/!streamingThinking/!streamingTool——流式中空态回归即红）', () => {
  const slice = showEmptyStateSlice();
  for (const ref of ['!props.streamingContent', '!props.streamingThinking', '!props.streamingTool']) {
    assert.ok(slice.includes(ref), `空态条件缺无流式判据 ${ref}（流式中空态回归=消息与空态同屏）`);
  }
});

// ── C5 红线钉：跟底滚动判定不被空态干扰（源级保全 + 修饰类键控 + 导出守卫）──
check('C5 红线钉：贴底伪元素/nearBottom/scrollToBottom/跟底 watch/ResizeObserver 全套字面保全 + 根容器 --empty 键控 showEmptyState（scroller/inner 字面零触 + opt6/hb12/b2 三钉保全线）+ !props.exportMode 首因子守卫', () => {
  assert.ok(/\.message-list__scroller::before\s*\{[^}]*margin-bottom:\s*auto;/.test(mlSty), '贴底伪元素 auto margin 被牵动（消息少时贴底回退）');
  assert.ok(ml.includes('const nearBottom = ref(true)'), 'nearBottom 被牵动');
  assert.ok(ml.includes('function scrollToBottom()'), 'scrollToBottom 被牵动');
  assert.ok(/\(\) => \[props\.messages\.length, props\.streamingContent/.test(ml), '跟底 watch 链被牵动');
  assert.ok(ml.includes('resizeObserver.observe(innerRef.value)'), 'ResizeObserver 观察面被牵动（C2-P2 同源）');
  assert.ok(mlTpl.includes(`:class="{ 'message-list--export': exportMode, 'message-list--empty': showEmptyState }"`), '空态修饰类未挂根容器 --empty 键（键控 showEmptyState：非空态布局被改动/居中机制拆链）');
  // 保全线：三既有契约脚本钉 scroller/inner 模板字面（opt6 §② 整字面 regex、hb12 ①/b2 §46
  // 子串 indexOf），空态机制以根容器 --empty 派生规则落地、不触这两枚模板字面——被改动即本钉先红。
  assert.ok(mlTpl.includes('<div ref="innerRef" class="message-list__inner">'), 'inner 模板字面被改动（tdd-bugfix-opt6-session-switch-scroll §② regex 钉依赖）');
  assert.ok(mlTpl.includes('class="message-list__scroller"'), 'scroller 模板字面被改动（tdd-bugfix-hb12-export-measure ① / tdd-bugfix-b2-back-bottom ④ 子串钉依赖）');
  assert.ok(showEmptyStateSlice().trimStart().startsWith('!props.exportMode'), '空态未以 !props.exportMode 首因子守卫（导出快照混入空态）');
});

// ═══════════════════════════════════════════════════════════════════════
// C6 中断脚注「已中断 · 结束于」（slate-ui-completion-1108-1428 round-001 点 C6，2026-11-09 增）
// 用例正本 = docs/ui-completion/tests/C-chat-stream-cases.md §C6（C6-1～C6-7）。
// C6-1/C6-4/C6-5/C6-6 直测半 = 从 MessageList.vue 源码提取 interruptedFinalTextIds getter
// 本体（esbuild ts 剥型后 new Function 求值——script setup 内 computed 不可 import，以
// 「源码即算法」方式对提取体直测：判据走样/机制漂移即红，与源码零复制零漂移）；CDP 文本半
// 隔离场景无 provider 发不了真中断回合（C1-8/C2/C3/C4/C5 同判），以结构钉为代理判据 +
// 真实行为闸门（npm run test:cdp 冒烟 / node scripts/cdp-turn-sync-e2e.mjs C 链中断情景）
// 兜住；C6-2/C6-3 保全钉（正常脚注形态 + formatEndedAt 跨天格式零触，现状即绿）；C6-7 =
// 零 IPC/落库纪律结构钉（推断只读既有行字段，wiring 计数由 B 链既有断言自证不增不减）。
// 变量约定：fd=format-duration 模块对象（含既有三函数直引）；fdRec=同对象弱型化视图（取新
// 导出 formatEndedAtMinute——实现前为 undefined，先红后绿）；fdSrc=同文件源码文本。
// ═══════════════════════════════════════════════════════════════════════

import * as fd from '../src/shared/format-duration';
import type { RenderableMessage } from '../src/shared/types/export-image';
import { transformSync } from 'esbuild';

const fdSrc = readRel('src/shared/format-duration.ts');
const fdRec = fd as unknown as Record<string, ((ts: number | null | undefined, now?: number) => string) | undefined>;
const formatEndedAtMinute = fdRec.formatEndedAtMinute;

function extractInferenceBody(): string {
  const m = /const interruptedFinalTextIds = computed<Set<string>>\(\(\) => \{([\s\S]*?)\n\}\);/.exec(ml);
  assert.ok(m, 'MessageList.vue 缺 interruptedFinalTextIds computed（渲染层推断未落地）');
  return m![1] ?? '';
}

// 提取体 → esbuild 剥 TS 型 → new Function 闭包求值：props.mainFlowMessages 假体注入主流程
// 序列（exportItems: null 走主流程分支）；真行为直测，源码判据任何走样即红。
function buildInference(): (source: RenderableMessage[]) => Set<string> {
  const body = extractInferenceBody();
  const { code } = transformSync(body, { loader: 'ts' });
  assert.ok(typeof code === 'string' && code.length > 0, '推断体 esbuild 剥型失败');
  const run = new Function('props', 'mainFlowMessages', `"use strict";\n${code}\n`) as (
    p: { exportItems: unknown },
    f: { value: unknown },
  ) => Set<string>;
  return (source) => run({ exportItems: null }, { value: source });
}

function inferFromExportItems(
  items: Array<{ type: 'fold'; messages: RenderableMessage[] } | { type: 'message'; message: RenderableMessage }>,
): Set<string> {
  const body = extractInferenceBody();
  const { code } = transformSync(body, { loader: 'ts' });
  const run = new Function('props', 'mainFlowMessages', `"use strict";\n${code}\n`) as (
    p: unknown,
    f: unknown,
  ) => Set<string>;
  return run({ exportItems: items }, { value: [] });
}

// 渲染消息夹具：必填字段齐备、其余零值（RenderableMessage 全形状，不伪造缺字段）。
function rm(partial: Partial<RenderableMessage> & Pick<RenderableMessage, 'id' | 'role'>): RenderableMessage {
  return {
    sessionId: 'sess-c6',
    content: '',
    eventType: 'message',
    costUsd: null,
    durationMs: null,
    endedAt: null,
    processKind: null,
    parentAgentId: null,
    toolUseId: null,
    title: null,
    isError: false,
    createdAt: '2026-11-09T10:00:00.000Z',
    ...partial,
  };
}
const U = (id: string): RenderableMessage => rm({ id, role: 'user', eventType: 'message' });
const BODY = (id: string, extra: Partial<RenderableMessage> = {}): RenderableMessage =>
  rm({ id, role: 'assistant', eventType: 'message', processKind: null, ...extra });
const ABORT = (id: string): RenderableMessage =>
  rm({ id, role: 'system', eventType: 'system', processKind: 'system:aborted' });

// C6-3 用例常量（跨天/同天对拍锚，本地时区构造与被测函数 getHours 口径同源不漂移）：
// 昨侧=2026-11-08 23:05:30，今侧=2026-11-09 09:30:00 → 跨天输出现状 formatEndedAt 回填 = 「11/8 23:05」。
const CROSS_TS = new Date(2026, 10, 8, 23, 5, 30).getTime();
const CROSS_NOW = new Date(2026, 10, 9, 9, 30, 0).getTime();
const SAME_TS = new Date(2026, 10, 9, 14, 5, 0).getTime();

console.log('\n=== C6 中断脚注契约（C6-1～C6-7） ===');

// ── C6-1 中断脚注文本全等（正常向；直测半 + 模板钉代理半，修复前必红）──
check('C6-1 直测：中止行 ∧ 回合最终正文 → id 入集合（中止行夹两段正文间取末段 id——合并单元末段与气泡 message.id 恒等）', () => {
  const infer = buildInference();
  const set1 = infer([U('u1'), BODY('a1', { endedAt: SAME_TS }), ABORT('s1')]);
  assert.ok(set1.has('a1'), '中断回合最终正文未入集合（判据缺失）');
  assert.strictEqual(set1.size, 1, '集合混入非目标 id');
  const set2 = infer([U('u1'), BODY('a1'), ABORT('s1'), BODY('a2')]);
  assert.ok(set2.has('a2'), '未取末段 id（合并单元 id 与渲染气泡对不上）');
  assert.ok(!set2.has('a1'), '前段 id 残留集合（末段语义破）');
  // 导出模式：exportItems 展平分支同判据（fold 内中止行仍可读——group-messages 豁免清单注释同源）。
  const set3 = inferFromExportItems([
    { type: 'message', message: U('u1') },
    { type: 'fold', messages: [ABORT('s1')] },
    { type: 'message', message: BODY('a1', { endedAt: SAME_TS }) },
  ]);
  assert.ok(set3.has('a1'), '导出模式展平分支未命中（导出快照中断脚注失判）');
});
check('C6-1 模板钉：中断脚注块逐字（v-if="interruptedVisible" + testid bubble-meta-interrupted + 「已中断」+「· 结束于 {{ endedAtMinuteText }}」）且块内零耗时件（HH:MM 非 HH:MM:SS 误拼防线）', () => {
  assert.ok(
    mbTpl.includes('<div v-if="interruptedVisible" class="bubble__meta" data-testid="bubble-meta-interrupted">'),
    '中断脚注块缺失或形态漂移',
  );
  assert.ok(mbTpl.includes('<span class="bubble__meta-interrupted">已中断</span>'), '「已中断」文案字面缺失');
  assert.ok(
    mbTpl.includes('<span v-if="endedAtMinuteText" class="bubble__meta-end">· 结束于 {{ endedAtMinuteText }}</span>'),
    '「· 结束于 {HH:MM}」形态缺失（分钟级单源变量漂移）',
  );
  const start = mbTpl.indexOf('data-testid="bubble-meta-interrupted"');
  const end = mbTpl.indexOf('</div>', start);
  const block = mbTpl.slice(start, end);
  assert.ok(start >= 0 && end > start, '中断脚注块切片失败');
  assert.ok(
    !block.includes('durationText') && !block.includes('bubble__meta-clock') && !block.includes('bubble__meta-duration'),
    '耗时件误拼进中断脚注（C6-1 红向：耗时段混入）',
  );
});
check('C6-1 fn 直测：formatEndedAtMinute 当天输出 HH:mm 两位补零、无秒（HH:MM:SS 误写即红）', () => {
  assert.ok(typeof formatEndedAtMinute === 'function', 'format-duration.ts 缺 formatEndedAtMinute 导出（分钟级单源未落地）');
  assert.strictEqual(formatEndedAtMinute!(SAME_TS, CROSS_NOW), '14:05', '当天输出漂移（应为 HH:mm 无秒）');
  assert.strictEqual(formatEndedAtMinute!(new Date(2026, 10, 9, 9, 5, 0).getTime(), CROSS_NOW), '09:05', '两位补零漂移');
});

// ── C6-2 正常回合脚注不变（保全）──
check('C6-2 正常脚注保全：v-else-if 门控（durationMs||endedAt 表达式字面不变）+ 时钟 SVG + durationText + 「· 结束于 {{ endedAtText }}」逐字在位', () => {
  assert.ok(
    mbTpl.includes('<div v-else-if="message.durationMs || message.endedAt" class="bubble__meta">'),
    '正常脚注块门控漂移（中断分支在前后应为 v-else-if，表达式字面不变）',
  );
  assert.ok(mbTpl.includes('class="bubble__meta-clock"'), '时钟 SVG 被牵动');
  assert.ok(
    mbTpl.includes('<span v-if="durationText" class="bubble__meta-duration">{{ durationText }}</span>'),
    '耗时 span 被牵动',
  );
  assert.ok(mbTpl.includes('· 结束于 {{ endedAtText }}'), '「· 结束于 {HH:MM:SS}」文案被牵动');
});
check('C6-2 formatEndedAt 零触：签名行在位（S2 钉同源）+ 同天秒级口径行为钉（HH:mm:ss）', () => {
  assert.ok(
    fdSrc.includes('export function formatEndedAt(ts: number | null | undefined, now: number = Date.now()): string'),
    'formatEndedAt 签名被牵动（tdd-user-message-time S2 同源）',
  );
  assert.match(fd.formatEndedAt(new Date(2026, 10, 9, 9, 30, 5).getTime(), CROSS_NOW), /^\d{2}:\d{2}:\d{2}$/, '同天秒级口径漂移');
});

// ── C6-3 跨天格式不变（边界；现状 formatEndedAt 输出回填常量对拍）──
check('C6-3 跨天对拍：formatEndedAtMinute(昨 23:05:30, 今 09:30) = 「11/8 23:05」（家族字面）且 === formatEndedAt 同参输出（家族口径一致）', () => {
  assert.ok(typeof formatEndedAtMinute === 'function', 'format-duration.ts 缺 formatEndedAtMinute 导出');
  assert.strictEqual(formatEndedAtMinute!(CROSS_TS, CROSS_NOW), '11/8 23:05', '跨天输出漂移（应为 M/d HH:mm）');
  assert.strictEqual(
    formatEndedAtMinute!(CROSS_TS, CROSS_NOW),
    fd.formatEndedAt(CROSS_TS, CROSS_NOW),
    '与 formatEndedAt 跨天输出不一致（家族口径分叉）',
  );
});
check('C6-3 保全：formatEndedAt 跨天分支模板字面零触（M/d HH:mm 表达式在其函数体内原样）', () => {
  const fn = fdSrc.slice(fdSrc.indexOf('export function formatEndedAt('), fdSrc.indexOf('export function formatSentAt('));
  assert.ok(
    fn.includes('${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}'),
    'formatEndedAt 跨天分支字面被触',
  );
});

// ── C6-4 无数据不造数（异常路径；直测 + fn 边界 + 模板缺数据分支）──
check('C6-4 直测：无中止行回合推断空（正常轮零污染）；有中止无正文推断空；空序列空', () => {
  const infer = buildInference();
  assert.strictEqual(infer([U('u1'), BODY('a1')]).size, 0, '无中止行回合被误判中断（无中生有脚注）');
  assert.strictEqual(infer([U('u1'), ABORT('s1')]).size, 0, '中止行无正文时造出 id');
  assert.strictEqual(infer([]).size, 0, '空序列造数');
});
check('C6-4 fn 边界：formatEndedAtMinute 无效值全返空串（null/undefined/0/NaN/负值）；模板 endedAt 缺数据分支有独立 v-if（只显「已中断」不渲染空尾巴）', () => {
  assert.ok(typeof formatEndedAtMinute === 'function', 'format-duration.ts 缺 formatEndedAtMinute 导出');
  for (const bad of [null, undefined, 0, Number.NaN, -5]) {
    assert.strictEqual(formatEndedAtMinute!(bad, CROSS_NOW), '', `无效值 ${String(bad)} 未返空串（造数）`);
  }
  assert.ok(
    mbTpl.includes('<span v-if="endedAtMinuteText" class="bubble__meta-end">'),
    'endedAt 缺数据分支缺独立 v-if（会渲染「· 结束于 」空尾巴）',
  );
});

// ── C6-5 多轮只影响被中断轮（并发/状态；直测 + 接线钉）──
check('C6-5 直测：三轮 正常/正常/中断 → 集合恰含第 3 轮末正文；中断轮后接正常轮不外溢（settle 复位）', () => {
  const infer = buildInference();
  const set1 = infer([U('u1'), BODY('a1'), U('u2'), BODY('a2'), U('u3'), BODY('a3'), ABORT('s3')]);
  assert.deepStrictEqual([...set1], ['a3'], '多轮污染（应仅中断轮末正文入集合）');
  const set2 = infer([U('u1'), BODY('a1'), ABORT('s1'), U('u2'), BODY('a2')]);
  assert.deepStrictEqual([...set2], ['a1'], 'settle 未复位：中断轮之外正文被误标');
});
check('C6-5 接线钉：MessageBubble :interrupted 逐条按 id 判定（interruptedFinalTextIds.has(item.message.id)）', () => {
  assert.ok(
    mlTpl.includes(':interrupted="interruptedFinalTextIds.has(item.message.id)"'),
    ':interrupted 接线缺失或非逐条 id 判定（全局开关=多轮误伤）',
  );
});

// ── C6-6 发送失败红条路径不混淆（异常路径；直测 + 双保险钉）──
check('C6-6 直测：isError 气泡 + 无中止行 → 推断空（发送失败红条不误标中断）', () => {
  const infer = buildInference();
  assert.strictEqual(infer([U('u1'), BODY('e1', { isError: true })]).size, 0, '错误气泡被误判中断（红条路径混淆）');
});
check('C6-6 双保险钉：interruptedVisible 三因子门控逐字（interrupted===true ∧ role===assistant ∧ isError!==true）+ 落库侧 error 与 aborted 分流（cli-shared 只读钉：error case 块零 system:aborted 字面）', () => {
  assert.ok(
    /const interruptedVisible = computed\(\(\) =>\s*\r?\n\s*props\.interrupted === true && props\.message\.role === 'assistant' && props\.message\.isError !== true,\s*\r?\n\s*\);/.test(mb),
    'interruptedVisible 门控形态漂移（缺 interrupted===true / role / isError!==true 三因子之一）',
  );
  const cli = readRel('src/main/modules/cli-shared.ts');
  const errBlock = cli.slice(cli.indexOf("case 'error':"), cli.indexOf("case 'result':"));
  assert.ok(errBlock.includes("processKind: 'system:error'"), 'error case 落库字面漂移');
  assert.ok(!errBlock.includes('system:aborted'), '发送失败路径混入 system:aborted（error/aborted 合流=路径混淆）');
  assert.strictEqual(
    cli.split('system:aborted').length - 1,
    1,
    'system:aborted 落库点漂移（应为单点，多落点破坏「中止行唯一 kind 字面」判据前提）',
  );
});

// ── C6-7 零 IPC/落库纪律（纪律钉）──
check('C6-7 零 IPC：MessageList.vue / MessageBubble.vue / format-duration.ts 零 ipcRenderer / bridge. / invoke( 字面（推断纯渲染层）', () => {
  for (const [name, src] of [['MessageList.vue', ml], ['MessageBubble.vue', mb], ['format-duration.ts', fdSrc]] as const) {
    assert.ok(!/ipcRenderer|bridge\.|invoke\(/.test(src), `${name} 出现 IPC 面（C6-7 零 IPC 纪律破；wiring 计数由 B 链既有断言自证不增不减）`);
  }
});
check('C6-7 推断数据面钉：getter 体只读既有行字段判据（system:aborted ∧ 末段正文两行字面）且零落库面引用（rawEvent/SQL）', () => {
  const body = extractInferenceBody();
  assert.ok(body.includes("m.eventType === 'system' && m.processKind === 'system:aborted'"), '中止行判据漂移');
  assert.ok(body.includes("m.role === 'assistant' && m.eventType === 'message' && m.processKind === null"), '正文判据漂移');
  assert.ok(!/rawEvent|SELECT|UPDATE|ended_at/.test(body), '推断触碰落库面（渲染层推断纪律破）');
});

// ═══════════════════════════════════════════════════════════════════════════
// C7 聊天流细节包（slate-ui-completion-1108-1428 round-001 点 C7，2026-11-09 增）
// 用例正本 = docs/ui-completion/tests/C-chat-stream-cases.md §C7（C7-1～C7-13 共 13 例），
// 与 C1 同构：源级结构钉为正身；CDP computed 半（C7-1 胶囊 computed、C7-3 chip computed、
// C7-5 pre 有效高度、C7-6 点击切换、C7-7 短入参无钮、C7-8 收组复位、C7-10
// Emulation.setEmulatedMedia、C7-11 贴底采样）依赖真实消息/流式回合，隔离场景无 provider
// 兜不住，且 scripts/cdp-layout-e2e.mjs 不在本点文件圈（C1 先例落点本点未圈）——CDP 半
// 由既有 C 链（cdp-turn-sync-e2e 等消费 .tool-row/.bubble 家族）自然兜结构不破，剩余
// computed 半在点报告申报。裁决 C7-7：不溢出不出展开钮（卷内待裁决 1 默认口径落定）。
// 冲突 C-C：入参展开钮文案复用结果区既有逐字（展开全部（N 行）▾ / 收起 ▴ / 展开全部 ▾）。
// C7-12 申报（R1-F2 补落更新，2026-11-10）：impl §7.6 的 MessageBubble.vue
// `.bubble--assistant:hover` 半场原因该文件不在本点文件圈未落地、留点报告申报；R1 修复轮 F2
// 已补落（与 MessageList .ai-card:hover 对称镜像），两半场均在位并被下例正向钉住——
// 后续改 hover 形态须两处同源同步。
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== C7 聊天流细节包契约（C7-1～C7-13） ===');

// ── C7-1 折叠摘要灰底胶囊条（形态 RED + 文案/aria 保全钉；CDP computed 半申报）──
check('C7-1 摘要条胶囊形态：fit-content + margin 0 auto + padding 5px 14px + radius-pill + 灰底 color-mix(text 6%, panel-soft)', () => {
  const block = ruleBlock(pg, '\\.process-fold__summary');
  assert.ok(block.includes('width: fit-content'), '摘要条缺 fit-content（胶囊条自适应宽）');
  assert.ok(block.includes('margin: 0 auto'), '摘要条缺 margin: 0 auto（居中胶囊）');
  assert.ok(block.includes('padding: 5px 14px'), '摘要条 padding 非 5px 14px（impl §7.2 字面）');
  assert.ok(block.includes('border-radius: var(--radius-pill)'), '摘要条非胶囊圆角（--radius-pill）');
  assert.ok(
    block.includes('background: color-mix(in srgb, var(--color-text) 6%, var(--color-panel-soft))'),
    '摘要条底非灰系胶囊（text 6% 混 panel-soft）',
  );
});
check('C7-1 摘要条 hover 同系加深：color-mix text 10% + color text；accent 派生 hover 清零（负向钉）', () => {
  const block = ruleBlock(pg, '\\.process-fold__summary:hover');
  assert.ok(
    block.includes('background: color-mix(in srgb, var(--color-text) 10%, var(--color-panel-soft))'),
    'hover 非同系加深（text 10% 混 panel-soft）',
  );
  assert.ok(block.includes('color: var(--color-text)'), 'hover 文字色缺失');
  const styAll = region(pg, '<style scoped>', '</style>');
  assert.ok(!styAll.includes('color-mix(in srgb, var(--color-accent)'), '摘要区残留 accent 派生（旧 accent 12% hover 未清）');
});
check('C7-1 文案/running/aria 保全钉：summary computed 逐字 + running「···」+ ›箭头旋转 + aria-expanded/controls（regression L2915-2918 同源）', () => {
  assert.ok(pg.includes("const parts = ['✨ Claude 忙活了一阵子'];"), '摘要文案头段漂移');
  assert.ok(pg.includes('`${props.stats.toolCount} 个工具`'), '工具计数文案漂移');
  assert.ok(pg.includes('`${props.stats.thinkingCount} 次思考`'), '思考计数文案漂移');
  assert.ok(pg.includes("parts.join(' · ')"), '摘要拼接符漂移');
  assert.ok(pg.includes('<span v-if="stats.running" class="process-fold__dots">···</span>'), 'running「···」漂移');
  assert.ok(pg.includes(':aria-expanded="open"'), 'aria-expanded 缺失');
  assert.ok(pg.includes(':aria-controls="panelId"'), 'aria-controls 缺失');
  assert.ok(pg.includes('transform: rotate(90deg)'), '›箭头展开旋转态缺失');
});

// ── C7-2 fold 分组逻辑零变化（保全：既有脚本全绿型，注册钉防静默拆链）──
check('C7-2 fold 保全接线：tdd-process-fold-verify.ts 在静态注册表（分组逻辑全绿由 selftest:static 兜底）', () => {
  const list = readRel('scripts/selftest-static-list.txt');
  assert.ok(list.includes('scripts/tdd-process-fold-verify.ts'), 'fold 契约脚本未注册（C7-2 保全断链）');
  assert.ok(pg.includes('const summary = computed(() => {'), 'summary computed 漂移（摘要文案钉前提）');
});

// ── C7-3 生成文件 chip 胶囊化（形态钉；CDP computed 半申报）──
check('C7-3 chip 胶囊化（ToolCallBlock）：描边 1px var(--color-border) + radius-pill + padding 1px 8px + --font-mono + ellipsis 三件套', () => {
  const block = ruleBlock(tcbSty, '\\.tool-row__file');
  assert.ok(block.includes('border: 1px solid var(--color-border)'), 'chip 缺描边');
  assert.ok(block.includes('border-radius: var(--radius-pill)'), 'chip 非胶囊圆角');
  assert.ok(block.includes('padding: 1px 8px'), 'chip padding 非 1px 8px');
  assert.ok(block.includes('font-family: var(--font-mono)'), 'chip 非 mono 族');
  assert.ok(
    block.includes('overflow: hidden') && block.includes('text-overflow: ellipsis') && block.includes('white-space: nowrap'),
    'chip 溢出省略三件套缺失',
  );
});
check('C7-3 chip hover accent 弱底：hover/focus-visible 共块 accent 10% 弱底 + border/文字 accent-strong + 旧下划线清零（负向钉）', () => {
  const block = ruleBlock(tcbSty, '\\.tool-row__file:hover,\\s*\\.tool-row__file:focus-visible');
  assert.ok(
    block.includes('background: color-mix(in srgb, var(--color-accent) 10%, transparent)'),
    'hover 非 accent 弱底（10% 混 transparent）',
  );
  assert.ok(block.includes('border-color: var(--color-accent-strong)'), 'hover 描边色非 accent-strong');
  assert.ok(block.includes('color: var(--color-accent-strong)'), 'hover 文字色非 accent-strong');
  const chipBlock = ruleBlock(tcbSty, '\\.tool-row__file');
  assert.ok(!chipBlock.includes('text-decoration'), '旧下划线形态残留（C7② 胶囊化应彻底删除 underline 规则）');
});

// ── C7-4 chip 交互不变（异常路径保全：模板接线逐字 + 既有脚本全绿型）──
check('C7-4 chip 交互保全：单击预览/Enter/Space/contextmenu/▾filemore/title 逐字 + tdd-chat-file-open-verify 注册钉', () => {
  assert.ok(tcbTpl.includes('class="tool-row__file" role="button" tabindex="0" :title="filePath"'), 'chip 结构属性漂移');
  assert.ok(tcbTpl.includes('@click.stop="!exportMode && useFilePreview().open(filePath)"'), 'chip 单击预览接线漂移');
  assert.ok(tcbTpl.includes('@keydown.enter.stop.prevent="!exportMode && useFilePreview().open(filePath)"'), 'chip Enter 接线漂移');
  assert.ok(tcbTpl.includes('@keydown.space.stop.prevent="!exportMode && useFilePreview().open(filePath)"'), 'chip Space 接线漂移');
  assert.ok(tcbTpl.includes('@contextmenu.prevent="!exportMode && (fileMenuOpen = !fileMenuOpen)"'), 'chip 右键菜单接线漂移');
  assert.ok(tcbTpl.includes('class="tool-row__filemore" role="button" tabindex="0" title="打开方式"'), '▾「打开方式」入口漂移');
  const list = readRel('scripts/selftest-static-list.txt');
  assert.ok(list.includes('scripts/tdd-chat-file-open-verify.ts'), 'tdd-chat-file-open-verify 未注册（C7-4 保全断链）');
});

// ── C7-5 入参 pre 封顶 220px + 底部渐隐（形态钉；CDP computed 半申报）──
check('C7-5 入参封顶：JSON_PREVIEW_PX=220 字面 + :not(--expanded) max-height 220px/overflow hidden + 渐隐字面（linear-gradient to panel）', () => {
  assert.ok(tcb.includes('const JSON_PREVIEW_PX = 220;'), 'JSON_PREVIEW_PX 非 220（突变①：220→20 应红）');
  const capBlock = ruleBlock(tcbSty, '\\.tool-row__json:not\\(\\.tool-row__json--expanded\\) \\.tool-row__json-inner');
  assert.ok(capBlock.includes('max-height: 220px'), '入参封顶非 220px');
  assert.ok(capBlock.includes('overflow: hidden'), '入参封顶缺 overflow hidden');
  // 复合选择器（--expanded 覆盖块）会抢 ruleBlock 首匹配，渐隐主字面按 includes 精确钉。
  assert.ok(
    tcbSty.includes('background: linear-gradient(to bottom, transparent, var(--color-panel) 78%);'),
    '底部渐隐字面漂移',
  );
});
check('C7-5 渐隐/展开接线：json 区复用 tool-row__result-fade 与 tool-row__expand 类（scoped 按类命中）+ 展开态渐隐层静态化', () => {
  assert.ok(tcbSty.includes('.tool-row__json {'), '入参容器缺 position:relative 锚（渐隐层绝对定位前提）');
  assert.ok(tcbSty.includes('.tool-row__json--expanded .tool-row__result-fade'), '入参展开态渐隐层未静态化（结果区镜像）');
  assert.ok(tcbTpl.includes('v-if="jsonOverflow && !exportMode" class="tool-row__result-fade"'), '入参渐隐层未复用 result-fade 类');
  assert.ok(tcbTpl.includes('class="tool-row__expand"'), '入参展开钮未复用 expand 类');
});

// ── C7-6 展开全部动态 N 切换（形态钉；CDP 点击切换半申报）──
check('C7-6 动态 N：jsonLineCount=split(\'\\n\').length computed + 按钮三元文案逐字（展开全部（N 行）▾ / 收起 ▴ / 展开全部 ▾）', () => {
  assert.ok(
    tcb.includes("const jsonLineCount = computed(() => (jsonText.value ? jsonText.value.split('\\n').length : 0));"),
    'jsonLineCount 非动态行数（突变②：N 硬编码应红）',
  );
  assert.ok(
    tcbTpl.includes("{{ jsonExpanded ? '收起 ▴' : (jsonLineCount > 1 ? `展开全部（${jsonLineCount} 行）▾` : '展开全部 ▾') }}"),
    '入参按钮三元文案漂移（N 硬编码/方向反/冲突 C-C 逐字破）',
  );
});
check('C7-6 结果区既有封顶零触碰钉：RESULT_PREVIEW_PX=220 / resultLineCount / 结果区三元与封顶选择器逐字保全', () => {
  assert.ok(tcb.includes('const RESULT_PREVIEW_PX = 220;'), '结果区常量漂移');
  assert.ok(
    tcb.includes("const resultLineCount = computed(() => (displayedSource.value ? displayedSource.value.split('\\n').length : 0));"),
    '结果区行数 computed 漂移',
  );
  assert.ok(
    tcbTpl.includes("{{ resultExpanded ? '收起 ▴' : (resultLineCount > 1 ? `展开全部（${resultLineCount} 行）▾` : '展开全部 ▾') }}"),
    '结果区按钮文案漂移（C7 不得触碰结果区）',
  );
  assert.ok(tcbSty.includes('.tool-row__result:not(.tool-row__result--expanded) .tool-row__result-inner'), '结果区封顶选择器漂移');
});

// ── C7-7 不溢出不出展开钮（边界；裁决 C7-7 落定口径）──
check('C7-7 不溢出/导出不出钮：按钮 v-if="jsonOverflow && !exportMode" 逐字 + 溢出判定 DOM 实测口径（scrollHeight > 220+2）', () => {
  assert.ok(tcbTpl.includes('v-if="jsonOverflow && !exportMode" class="tool-row__result-fade"'), '入参钮门控漂移（恒显钮=短入参也出钮，裁决 C7-7 破）');
  assert.ok(tcb.includes('jsonOverflow.value = !!el && el.scrollHeight > JSON_PREVIEW_PX + 2;'), '入参溢出判定非 DOM 实测口径');
});

// ── C7-8 收起折叠组复位展开态（边界）──
check('C7-8 收组复位：ProcessGroup panel v-if="open"（收起即卸载 ToolCallBlock 实例，jsonExpanded 等随实例销毁自然复位）+ jsonExpanded 为实例级 ref', () => {
  assert.ok(pg.includes('<div v-if="open" :id="panelId" class="process-fold__panel">'), 'panel 非 v-if 卸载形态（展开态将跨收组泄漏）');
  assert.ok(tcb.includes('const jsonExpanded = ref(false);'), 'jsonExpanded 非实例级 ref（模块级/store 化会跨实例泄漏）');
});

// ── C7-9 最新消息进场动画（源码钉）──
check('C7-9 进场动画：.message-list__inner > *:last-child animation msg-enter 0.24s var(--ease-out) + keyframes 上移淡入（opacity 0→ / translateY 5px）', () => {
  assert.ok(
    mlSty.includes('.message-list__inner > *:last-child { animation: msg-enter 0.24s var(--ease-out); }'),
    '进场动画规则漂移（0.24s/ease-out/last-child 任一破）',
  );
  assert.ok(/@keyframes msg-enter \{[\s\S]*?from \{ opacity: 0; transform: translateY\(5px\); \}[\s\S]*?\}/.test(mlSty), 'msg-enter 关键帧漂移（非上移淡入）');
});

// ── C7-10 reduced-motion 关（异常路径；CDP setEmulatedMedia 半申报）──
check('C7-10 reduced-motion 关：@media (prefers-reduced-motion: reduce) 分支内 last-child 动画置 none（突变③：分支删应红）', () => {
  const rmIdx = mlSty.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(rmIdx >= 0, 'reduced-motion 媒体查询缺失');
  const rmBlock = mlSty.slice(rmIdx);
  assert.ok(
    rmBlock.includes('.message-list__inner > *:last-child { animation: none; }'),
    'reduce 分支未关进场动画',
  );
});

// ── C7-11 动画不干扰跟底滚动（并发向：判据保全 + 布局不触碰负向钉）──
check('C7-11 跟底判据保全+动画零布局触碰：scrollHeight/scrollTop/clientHeight 算式与 80/400 阈值逐字 + msg-enter 仅 opacity/transform', () => {
  assert.ok(ml.includes('const distance = el.scrollHeight - el.scrollTop - el.clientHeight;'), '跟底距离算式漂移');
  assert.ok(ml.includes('nearBottom.value = distance < 80;'), '贴底阈值漂移');
  assert.ok(ml.includes('showBackToBottom.value = distance > 400;'), '回底阈值漂移');
  assert.ok(ml.includes('el.scrollTop = el.scrollHeight;'), '滚底赋值漂移');
  const kf = /@keyframes msg-enter \{([\s\S]*?)\}/.exec(mlSty)?.[1] ?? '';
  assert.ok(kf.length > 0, 'msg-enter 关键帧缺失');
  assert.ok(!/width|height|margin|padding|top:|left:/.test(kf), '进场动画触碰布局盒（干扰跟底滚动判定）');
});

// ── C7-12 AI 卡 hover 描边加深（源码钉；两半场：MessageList .ai-card:hover + MessageBubble .bubble--assistant:not(.bubble--error):hover，R1-F2 补落）──
check('C7-12 AI 卡 hover 描边加深（两半场）：.ai-card:hover 与 .bubble--assistant:not(.bubble--error):hover 均 border-color var(--color-border-strong)（token 引用，镜像两处同源 + error 守卫）', () => {
  const block = ruleBlock(mlSty, '\\.ai-card:hover');
  assert.ok(block.includes('border-color: var(--color-border-strong)'), 'AI 卡 hover 描边非 border-strong（MessageList 半场加深缺失）');
  const bubbleHover = ruleBlock(mbSty, '\\.bubble--assistant:not\\(\\.bubble--error\\):hover');
  assert.ok(bubbleHover.includes('border-color: var(--color-border-strong)'), '助手卡 hover 描边非 border-strong（MessageBubble 半场缺失/漂移，R1-F2）');
});

// ── C7-13 token 复核（异常路径：令牌纪律；六文件 + markdown 层）──
check('C7-13 六文件样式段零 hex（剥注释后）：ThinkingBlock/StalledBanner/ApiRetryBanner/ApiRetryRecord/TurnFileChangesCard/MessageAttachments', () => {
  const files = ['ThinkingBlock', 'StalledBanner', 'ApiRetryBanner', 'ApiRetryRecord', 'TurnFileChangesCard', 'MessageAttachments'];
  for (const f of files) {
    const src = readRel(`src/renderer/components/chat/${f}.vue`);
    const sty = /<style[^>]*>([\s\S]*?)<\/style>/.exec(src)?.[1] ?? '';
    assert.ok(sty.length > 0, `${f} 样式段切片失败`);
    const stripped = sty.replace(/\/\*[\s\S]*?\*\//g, '');
    const hexes = stripped.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepStrictEqual(hexes, [], `${f} 样式段残留 hex 字面（令牌纪律破）：${hexes.join(',')}`);
  }
});
check('C7-13 markdown 层复核：main.css 剥注释后 hex 仅剩 #fff（豁免申报：.image-lightbox__close 黑遮罩白钮两板通用）；diff2html 浅色 CSS 属第三方包自带非本仓库样式段', () => {
  const css = readRel('src/renderer/assets/styles/main.css');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const hexes = stripped.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.ok(
    hexes.every((h) => /^#[fF]{3}$/.test(h)),
    `markdown 层存在非豁免 hex：${hexes.join(',')}`,
  );
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
