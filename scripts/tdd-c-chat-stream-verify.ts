// scripts/tdd-c-chat-stream-verify.ts
// 【UI13 形态同步，2026-11-22（p2p4p3 返工轮）】本卷源级钉按现行形态整体同步。裁决链：
// scripts/cdp-layout-e2e.mjs A3 组已在 t1clp（2026-11-17）将 C1 元素层五钉 skipCheck 留痕
// 「UI13 c4e0ede 气泡形态重构取代 slate 冻结面——重写归 UI13 测试面独立任务」，本卷即该欠账清偿：
//   · C1/C2 气泡形态：slate 冻结面（浅蓝 token 卡/无边框/11-11-4-11 圆角/外置 .msg 标签行）在 src
//     全历史从未落地（git log -S 全仓零命中），现行形态 = c4e0ede（UI13 渲染批次：8ca3786 accent
//     染色卡 color-mix 派生）+ UI13-P5（bubble-wrap wrapper/user 角色头移除/caption 下方行）；
//   · C4 计时第三面（msg-label 流式计时行）未实施：计时面收敛 TurnTimer④ 单点，C4 钉改钉 TurnTimer；
//   · C5 空态：MessageList 内空态未实施，现行空态 = ChatPage 无会话分支 .empty-state，C5 改钉该面；
//   · C7-9/10/11/12：msg-enter 进场动画/ai-card hover 未实施，改钉现状（msg-transition 间距类/
//     全局 reduce 面/操作钮 hover 面）。
// 原契约字面与裁决依据保留于各检查体注释，未裸删任何钉（红线：禁止裸删钉）。
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
// 【UI13 形态同步】slate 冻结面（var(--color-bubble-user-bg/ink) 固定浅蓝卡）被 c4e0ede 取代为
// accent 染色卡（color-mix 派生跟随 9 套主题）；variables.css 的 A3 token 字面钉与 CDP 变量层
// 静态钉（assertBubbleTokenStable）按 t1clp 裁决保留，消费面改钉现行派生配方。
check('C1-1 用户气泡 accent 染色卡（UI13 c4e0ede 后形态）：background = color-mix(accent 12%, panel-soft) / color = var(--color-text)', () => {
  assert.ok(
    /background:\s*color-mix\(in srgb, var\(--color-accent\) 12%, var\(--color-panel-soft\)\)/.test(userBlock),
    'background 非 accent 12% 派生（8ca3786 染色卡形态漂移）',
  );
  assert.ok(/(^|\n)\s*color:\s*var\(--color-text\)/.test(userBlock), 'color 未引 var(--color-text)');
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

// ── C1-3 accent 派生配方冻结（UI13 后形态：底/描边皆 color-mix accent 派生，文字色不走 accent）──
check('C1-3 用户气泡色板派生（UI13 后形态）：底=accent 12% 派生 + 描边=accent 30% 派生（跟随主题变量）+ 文字色不染 accent', () => {
  assert.ok(userBlock.includes('color-mix(in srgb, var(--color-accent) 12%'), '底色缺 accent 12% 派生（8ca3786 配方漂移）');
  assert.ok(userBlock.includes('color-mix(in srgb, var(--color-accent) 30%'), '描边缺 accent 30% 派生（配方漂移）');
  assert.ok(!/(^|\n)\s*color:\s*[^;\n]*accent/i.test(userBlock), '文字色被 accent 染（可读性面漂移）');
});

// ── C1-4 描边形态（UI13 后形态：1px accent 30% 整圈 + 右缘 3px accent 色条，与助手左色条镜像共享卡片语言）──
// 豁免该两条声明与 border-radius 行后，切片内不得残留任何其它 border 声明。
check('C1-4 用户气泡描边（UI13 后形态）：1px accent 30% 整圈 + border-right 3px accent 色条在位，且除其与 border-radius 外零 border 声明', () => {
  assert.ok(
    userBlock.includes('border: 1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)'),
    '缺 1px accent 30% 整圈描边（8ca3786 形态漂移）',
  );
  assert.ok(userBlock.includes('border-right: 3px solid var(--color-accent)'), '缺右缘 3px accent 色条（镜像卡片语言漂移）');
  const stripped = userBlock
    .replace(/border-radius:\s*[^;]+;?/g, '')
    .replace(/border:\s*1px solid color-mix\(in srgb, var\(--color-accent\) 30%, transparent\);/g, '')
    .replace(/border-right:\s*3px solid var\(--color-accent\);/g, '');
  const residual = stripped.match(/border[^\n;]*/g)?.join(' | ') ?? '';
  assert.ok(!/border/.test(stripped), `切片残留 border 声明：${residual}`);
});

// ── C1-5 圆角单源（UI13 后形态：无差分圆角，基线 var(--radius-md) 由 .bubble 承载）──
check('C1-5 圆角单源（UI13 后形态）：.bubble 基线 border-radius: var(--radius-md)，user 气泡零差分圆角覆盖', () => {
  assert.ok(ruleBlock(mb, '\\.bubble(?![-_\\w])').includes('border-radius: var(--radius-md)'), '基线圆角非 var(--radius-md)');
  assert.ok(!userBlock.includes('border-radius'), 'user 气泡残留差分圆角覆盖（UI13 后形态应走基线单源）');
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

// ── C1 CDP 侧存在钉（落点 scripts/cdp-layout-e2e.mjs A3 场景组；t1clp 死锚隔离后=skipCheck 留痕面）──
check('C1 cdp-layout-e2e.mjs C1 探针留痕在位（t1clp 死锚隔离：元素层五钉 skipCheck 归 UI13 测试面独立任务 + probeBubble 机制 + 期望常量字面 + 隔离纪律）', () => {
  const cdp = readRel('scripts/cdp-layout-e2e.mjs');
  for (const marker of ['C1-1', 'C1-4', 'C1-5', 'C1-6', 'C1-7', 'probeBubble']) {
    assert.ok(cdp.includes(marker), `cdp-layout-e2e.mjs 缺 ${marker} 标记（CDP 探针留痕被静默拆链）`);
  }
  assert.ok(cdp.includes('skipCheck'), 'C1 死锚隔离 skipCheck 机制缺失（死锚被裸删或复活）');
  assert.ok(cdp.includes('UI13 气泡形态重构'), 't1clp 死锚隔离留痕缺失（c4e0ede 裁决链断）');
  assert.ok(cdp.includes('rgb(217, 233, 237)'), 'CDP 缺浅蓝底期望常量字面（留痕面）');
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

// ── C2-1 根 wrapper（UI13-P5 后形态：外置 .msg/.msg__label 标签行方案在 src 全历史未落地，死钉清账）──
check('C2-1 根 wrapper（UI13-P5 后形态）：.bubble-wrap 单根 wrapper + role 修饰类 + 对齐方向在位，气泡置于 wrapper 内', () => {
  assert.ok(/<div :class="\['bubble-wrap', `bubble-wrap--\$\{message\.role\}`\]"/.test(mbTpl), '根 wrapper .bubble-wrap 缺失（UI13-P5 单根透传形态漂移）');
  assert.ok(mbSty.includes('.bubble-wrap {'), '.bubble-wrap 样式缺失');
  assert.ok(/\.bubble-wrap--user\s*\{[^}]*align-self: flex-end;/.test(mbSty), 'user 对齐修饰类漂移（wrap 承接 align-self）');
  // 气泡置于 wrapper 内（wrapper 先于气泡）
  const wrapIdx = mbTpl.indexOf("['bubble-wrap', `bubble-wrap--${message.role}`]");
  const bubbleIdx = mbTpl.indexOf("'bubble', `bubble--${message.role}`");
  assert.ok(wrapIdx > 0 && bubbleIdx > wrapIdx, '气泡未置于 wrapper 内');
});

// ── C2-2 角色头形态（UI13-P5 后形态：user「你」头移除并入 caption；assistant/tool「Claude」头保留在气泡内 role-row）──
check('C2-2 角色头形态（UI13-P5 后形态）：user 角色头移除（role!==user 门控）+ assistant/tool「Claude」头保留 bubble__role-row + StreamRenderer 零角色行', () => {
  assert.ok(
    mbTpl.includes(`<div v-if="message.role !== 'system' && message.role !== 'user'" class="bubble__role-row">`),
    'role 行门控漂移（user「你」头应移除、assistant/tool 保留）',
  );
  assert.ok(mbTpl.includes('<span class="bubble__role">Claude</span>'), '「Claude」头文案漂移');
  assert.ok(mbSty.includes('.bubble__role-row {'), '.bubble__role-row 样式缺失');
  assert.ok(!srTpl.includes('stream__role'), 'StreamRenderer 模板残留 stream__role');
  assert.ok(!srSty.includes('.stream__role'), 'StreamRenderer 样式残留 .stream__role');
});

// ── C2-3 user caption 行（UI13-P5 后形态：气泡正下方 .bubble-caption；外置 msg__label-time 方案未落地）──
check('C2-3 caption 行（UI13-P5 后形态）：user 门控 + .bubble-caption 类 + 时钟 svg +「你 · 发送于 {{ sentAtText }}」+ sentAtText computed 留守（S3 零同步）', () => {
  assert.ok(mbTpl.includes('你 · 发送于 {{ sentAtText }}'), '文案「你 · 发送于 {{ sentAtText }}」缺失');
  assert.ok(/v-if="message\.role === 'user' && sentAtText" class="bubble-caption"/.test(mbTpl), 'user 门控 + bubble-caption 类缺失');
  assert.ok(mbTpl.includes('class="bubble-caption-clock"'), 'caption 时钟 svg 缺失（P3 对齐②脚注视觉语言）');
  assert.ok(/sentAtText\s*=\s*computed/.test(mb), 'sentAtText computed 被动（应留在 MessageBubble，tdd-user-message-time S3 零同步）');
  assert.ok(mbSty.includes('.bubble-caption {'), '.bubble-caption 样式缺失');
  // caption 位于气泡下方（wrapper 内先气泡后 caption）
  const bubbleIdx = mbTpl.indexOf("'bubble', `bubble--${message.role}`");
  const capIdx = mbTpl.indexOf('class="bubble-caption"');
  assert.ok(bubbleIdx > 0 && capIdx > bubbleIdx, 'caption 未置于气泡下方');
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

// ── C2-5「来自队列」pill 保全（UI13-P5 后形态：宿主行 bubble__queue 并入 caption 行，pill 直接挂 caption 内）──
check('C2-5 队列 pill 保全（UI13-P5 后形态）：!exportMode 门控 + parentTaskId（80 字符内）+ pill 在 caption 行内 + 类名/title 逐字', () => {
  assert.ok(/v-if="!exportMode &&[\s\S]{0,80}message\.parentTaskId"/.test(mbTpl), '!exportMode 门控漂移（tdd-queue-semantics-v3 §12 exportMode regex 依赖）');
  assert.ok(mbTpl.includes('来自队列'), '文案「来自队列」漂移（queue-semantics §12 同源）');
  assert.ok(mbTpl.includes('title="此消息由队列任务到点/立即执行时发送"'), 'pill title 文案漂移（逐字契约）');
  assert.ok(mbTpl.includes('bubble__queue-tag'), '类名 bubble__queue-tag 漂移（queue-semantics §12 同源）');
  const capIdx = mbTpl.indexOf('class="bubble-caption"');
  const queueIdx = mbTpl.indexOf('class="bubble__queue-tag"');
  assert.ok(capIdx > 0 && queueIdx > capIdx, 'pill 未迁入 caption 行内（UI13-P5 宿主行并入 caption）');
});

// ── C2-6 助手卡形态（UI13 c4e0ede 后形态：panel-soft 底 + 1px 整圈描边 + 左缘 3px accent 色条（8ca3786 卡片语言，镜像 user 右色条）+ 基线圆角 var(--radius-md) + 12px 16px）──
check('C2-6 助手卡形态（UI13 后形态）：panel-soft 底 + 1px 细描边整圈 + 左缘 3px accent 色条 + 基线圆角 var(--radius-md) + 12px 16px', () => {
  const base = ruleBlock(mbSty, '\\.bubble(?![-_\\w])');
  const asst = ruleBlock(mbSty, '\\.bubble--assistant');
  assert.ok(base.includes('padding: 12px 16px'), '基线 padding 非 12px 16px（UI13 后基线）');
  assert.ok(base.includes('border-radius: var(--radius-md)'), '基线圆角非 var(--radius-md)（单源 token）');
  assert.ok(asst.includes('background: var(--color-panel-soft)'), 'AI 卡底色漂移（非 panel-soft 纯白系）');
  assert.ok(asst.includes('border: 1px solid var(--color-border)'), 'AI 卡非 1px 细描边');
  assert.ok(asst.includes('border-left: 3px solid var(--color-accent)'), 'AI 卡左缘 accent 色条漂移（8ca3786 卡片语言，镜像 user 右色条）');
  assert.ok(!asst.includes('color-mix('), 'AI 卡残留 color-mix( 派生');
  assert.ok(asst.includes('box-shadow: var(--ring-light), var(--elevation-1)'), 'AI 卡轻阴影丢失');
});

// ── C2-7 流式组（UI13 后形态：ai-card 镜像卡与外置 Claude 标签行方案未落地，死钉清账——现状为
// stream-group 直接流式子元素 + tool-stream 现状卡（1px 描边/panel-soft 度量面）；并发向流式更新
// 多帧形态稳定由 C 链真实回合兜住）──
const STREAM_GROUP_VIF =
  'streamingContent || streamingThinking || streamingTool || sessionStore.activeStalledInfo || sessionStore.activeApiRetryInfo || sessionStore.activeApiRetryTerminalFallback';
check('C2-7 流式组（UI13 后形态）：stream-group v-if 逐字保全 + tool-stream 现状卡（1px 描边/panel-soft/10px 14px/752px）+ StreamRenderer 去壳', () => {
  assert.ok(mlTpl.includes(`v-if="${STREAM_GROUP_VIF}"`), 'stream-group v-if 表达式漂移（selftest-settings-mapping L1883 regex 字面依赖，逐字契约）');
  assert.ok(mlTpl.includes('class="stream-group"'), 'stream-group 类漂移（C 链选择器依赖）');
  const tool = ruleBlock(mlSty, '\\.tool-stream');
  for (const piece of ['border: 1px solid var(--color-border)', 'border-radius: var(--radius-md)', 'background: var(--color-panel-soft)', 'padding: 10px 14px', 'max-width: 752px']) {
    assert.ok(tool.includes(piece), `tool-stream 现状卡形态漂移：缺 ${piece}`);
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

// ── C2-8 横幅流组前置（UI13 后形态：ai-card 未落地，横幅为 stream-group 直接子元素且居最前——
// 卡壳方案若日后落地，本钉先红提示同步）──
check('C2-8 横幅流组前置（UI13 后形态）：StalledBanner/ApiRetryBanner 为 stream-group 直接子元素，且在 ThinkingBlock/tool-stream/StreamRenderer 之前', () => {
  const grp = mlTpl.slice(mlTpl.indexOf('class="stream-group"'));
  const stalled = grp.indexOf('<StalledBanner');
  const retry = grp.indexOf('<ApiRetryBanner');
  const thinking = grp.indexOf('<ThinkingBlock');
  const tool = grp.indexOf('class="tool-stream"');
  const stream = grp.indexOf('<StreamRenderer');
  assert.ok(stalled >= 0 && retry >= 0, '横幅挂载点缺失');
  assert.ok(stalled < retry && retry < thinking && thinking < tool && tool < stream, '流组内元素序漂移（横幅须居最前独立位）');
});

// ── C2-9 形态度量钉（UI13 后形态：user/assistant 气泡限宽 85% 同参照系、对齐方向由 wrap 承接、
// 基线行高 1.5 + assistant 正文 1.75、列宽 800）──
check('C2-9 度量（UI13 后形态）：user/assistant 气泡 max-width 85% + wrap 对齐方向承接 + 行高 1.5 基线 + 1.75 assistant 正文 / 列宽 800 保全', () => {
  assert.ok(/\.bubble-wrap--user\s*\{[^}]*align-self: flex-end;[^}]*align-items: flex-end;/.test(mbSty), 'user wrap 对齐方向漂移（右对齐承接）');
  assert.ok(/\.bubble-wrap--assistant,\s*\.bubble-wrap--tool\s*\{[^}]*align-self: flex-start;/.test(mbSty), 'assistant wrap 对齐方向漂移（左对齐承接）');
  const userBubble = ruleBlock(mbSty, '\\.bubble--user');
  const asstBubble = ruleBlock(mbSty, '\\.bubble--assistant');
  assert.ok(userBubble.includes('max-width: 85%'), 'user 限宽非 85%（行宽对齐 P3 参照系）');
  assert.ok(asstBubble.includes('max-width: 85%'), 'assistant 限宽非 85%（行宽对齐 P3 参照系）');
  assert.ok(/\.bubble__content\s*\{[^}]*line-height:\s*1\.5;/.test(mbSty), '基线行高 1.5 丢失（system/tool 承载 + settings-mapping L587 字面钉依赖）');
  assert.ok(/\.bubble--assistant \.bubble__content\s*\{[^}]*line-height:\s*1\.75;/.test(mbSty), 'assistant 正文行高非 1.75（UI13 后度量）');
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

// ── C2-P3 队列标导出快照不含契约（UI13-P5 后形态：role 因子上移 caption 容器，pill 自身 v-if
// 保留 !exportMode && parentTaskId——导出语义不变；tdd-queue-semantics-v3 §12 全绿同判）──
check('C2-P3 队列标导出契约（UI13-P5 后形态）：pill v-if = !exportMode && parentTaskId + role 因子在 caption 容器（user && sentAtText）', () => {
  assert.ok(/v-if="!exportMode && message\.parentTaskId"[\s\S]{0,40}class="bubble__queue-tag"/.test(mbTpl), 'pill v-if+class 字面漂移');
  assert.ok(/v-if="message\.role === 'user' && sentAtText" class="bubble-caption"/.test(mbTpl), 'role 门控未在 caption 容器（user 限定漂移）');
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
// 【UI13 形态同步，2026-11-22】C4 计划的「第三面」（MessageList 外置标签行内 msg-label__timer
// 计时行）在 src 全历史未落地（git log -S streamTimerText/msg-label__timer 零命中）——现状计时
// 面收敛为 TurnTimer④ 单点（运行态 + B1 完成态），MessageList.vue:25 注释留痕「计时已迁出」。
// C4 各钉随之改钉 TurnTimer④（契约精神不变：统一时钟源/投影起点/sending 门控消失/切回不错步/
// 不串显/类名互斥——TurnTimer 即原契约的同构实现落点）。
// ═══════════════════════════════════════════════════════════════════════

const TT_PATH = 'src/renderer/components/chat/TurnTimer.vue';
const tt = readRel(TT_PATH);
const un = readRel('src/renderer/composables/use-now.ts');
const ssStore = readRel('src/renderer/stores/session-store.ts');
// C5（UI13 形态同步）共用：现行空态落 ChatPage 无会话分支（C5 各钉改钉该面）。
const CP_PATH = 'src/renderer/pages/ChatPage.vue';
const cp = readRel(CP_PATH);
const cpTpl = region(cp, '<template>', '</template>');
const cpSty = region(cp, '<style scoped>', '</style>');

console.log('\n=== C4 流式计时第三面契约（C4-1～C4-6） ===');

// ── C4-1 计时面落点（UI13 形态同步：第三面未实施，唯一流式计时面 = TurnTimer④）──
check('C4-1 计时面落点（UI13 死钉清账）：TurnTimer④ 挂 ChatPage 浮岛第一行（sending 运行态门控）+ MessageList 零计时面残留', () => {
  assert.ok(cp.includes('<TurnTimer />'), 'TurnTimer 未挂 ChatPage 浮岛（流式计时面失锚）');
  assert.ok(tt.includes('<div v-if="sending" class="turn-timer"'), 'TurnTimer 运行态 sending 门控漂移');
  assert.ok(
    !ml.includes('msg-label__timer') && !/streamTimerText\s*=/.test(ml),
    'MessageList 残留标签行计时面消费（第三面方案未实施，死钉清账后不得复活；注释留痕提及历史名不在此列）',
  );
});

check('C4-1 无假值窗口（UI13 死钉清账）：TurnTimer 起点缺失守卫 if (!start) return 0 + 完成态「· 结束于」分隔字面（B1 形态）', () => {
  assert.ok(/if \(!start\) return 0;/.test(tt), 'TurnTimer 起点缺失守卫漂移（缺数据造数风险）');
  assert.ok(tt.includes('· 结束于 {{ endClockText }}'), '完成态「· 结束于」分隔字面漂移（B1 形态）');
});

check('C4-1 接线（UI13 死钉清账）：useNow/formatDurationMs 导入在 TurnTimer（禁自算：无第二钟源导入）+ MessageList 零时钟源导入', () => {
  assert.ok(tt.includes("import { useNow } from '../../composables/use-now';"), 'TurnTimer 缺 useNow 导入（统一时钟源未接）');
  assert.ok(tt.includes("import { formatDurationMs, formatEndedAt } from '../../../shared/format-duration';"), 'TurnTimer 缺 formatDurationMs 导入（裁决 C-A：同源格式）');
  assert.ok(!/from '[^']*\/(date-fns|dayjs|moment)/.test(tt + ml), '引入第三方日期库（第二钟源，禁自算域外依赖）');
  assert.ok(!ml.includes('use-now'), 'MessageList 残留时钟源导入（计时面已收敛 TurnTimer 单点）');
});

check('C4-1 递增驱动（代理钉）：TurnTimer 取值式读 now.value（useNow 100ms tick 唯一驱动；统一时钟源 tick 在位零触）', () => {
  assert.ok(
    /return Math\.max\(0, now\.value \+ sessionStore\.activeTurnClockOffset - start\);/.test(tt),
    '取值式未读 now.value（tick 不驱动重评=死值）或缺时钟协议取值式',
  );
  assert.ok(un.includes('}, 100);'), 'useNow 100ms tick 缺失（统一时钟源被牵动）');
});

// ── C4-2 回合结束切换完成态（UI13 形态同步：sending=false → 运行态卸载、B1 完成态接棒）──
check('C4-2 回合结束切换完成态：TurnTimer v-if="sending" 运行态门控 + v-else-if="lastMeta" 完成态接棒（分支序在位）', () => {
  assert.ok(tt.includes('<div v-if="sending" class="turn-timer"'), '运行态 sending 门控漂移（回合结束后「正在回复」残留）');
  assert.ok(tt.includes('v-else-if="lastMeta"'), '完成态分支漂移（B1 完成态接棒面）');
  assert.ok(tt.indexOf('v-if="sending"') < tt.indexOf('v-else-if="lastMeta"'), '运行态/完成态分支序漂移');
});

// ── C4-3 数据纪律结构钉（UI13 形态同步：负断言保留 MessageList，投影/时钟源引用改钉 TurnTimer）──
check('C4-3 数据纪律三断言：MessageList.vue 零 setInterval( 字面（禁自建计时器）+ TurnTimer 含回合开始投影引用 + 统一时钟源（含偏移校正）引用', () => {
  assert.ok(!ml.includes('setInterval('), 'MessageList 组件内出现 setInterval(（偷建计时器：后台节流错步/泄漏，v0.4.10 前教训）');
  assert.ok(tt.includes('sessionStore.activeTurnStartedAt'), '缺回合开始时间投影引用（turn-projection 公开导出）');
  assert.ok(/useNow\(\(\) => sending\.value\)/.test(tt) && tt.includes('sessionStore.activeTurnClockOffset'), '缺统一时钟源引用（useNow 门控 + serverClockOffset 偏移校正）');
});

// ── C4-3b turn-projection 契约核对（点指令明示）：计时派生链四款（UI13 形态同步：原设计钉
// MessageList 同构款——第三面未实施，四款改钉 TurnTimer 本体在位）：
// 款1 useNow 门控 / 款2 起点=activeTurnStartedAt 投影 / 款3 空起点守卫 / 款4 时钟协议
// Math.max(0, now+offset-start)。
check('C4-3b 四款同构钉（UI13 死钉清账：计时派生收敛 TurnTimer 单面）：useNow 门控/起点投影/空起点守卫/时钟协议四款在位', () => {
  const refs = [
    /useNow\(\(\) => sending\.value\)/,
    /const start = sessionStore\.activeTurnStartedAt;/,
    /if \(!start\) return 0;/,
    /Math\.max\(0, now\.value \+ sessionStore\.activeTurnClockOffset - start\)/,
  ];
  for (const ref of refs) assert.ok(ref.test(tt), `TurnTimer 派生链款漂移（${ref} 不复命中，本钉失效需重校）`);
});

// ── C4-4 后台会话切回不错步（代理钉）──
// 机制链：起点/偏移 = activeSession 键控 store 投影（切回重读权威起点）+ useNow 失活停跳不累计
// 假时间、激活 start() 首行即重读本地钟 + computed 形态钉（逐字全形态——任何注入的本地累计态
// 都会破坏该形态）。
check('C4-4 切回不错步（UI13 形态同步）：投影 activeSession 键控（重读权威起点）+ useNow 失活停跳/激活即重读 + TurnTimer elapsedMs 逐字全形态（零本地累计态注入面）', () => {
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
    /const elapsedMs = computed\(\(\) => \{[\s\S]{0,200}?const start = sessionStore\.activeTurnStartedAt;[\s\S]{0,200}?if \(!start\) return 0;[\s\S]{0,300}?return Math\.max\(0, now\.value \+ sessionStore\.activeTurnClockOffset - start\);\s*\r?\n\s*\}\);/.test(tt),
    'TurnTimer elapsedMs 全形态漂移（注入本地累计态=切回错步机制根）',
  );
  assert.ok(!/now\.value\s*\+=/.test(tt), '对 now 累加（本地累计态，后台停摆期错步）');
});

// ── C4-5 多会话并行只显当前会话计时（代理钉）──
// 派生只读 activeSession 键控投影（getter 层是唯一跨会话安全面）；组件零直连映射读（直读
// turnStartedAt[ / serverClockOffset[ 才可能跨会话取值）；流式内容走 props 快照（C2-7 STREAM_GROUP_VIF
// 钉已锚 props 三元开头，后台会话流不落本组件）。
check('C4-5 不串显（UI13 形态同步）：派生只走活动会话投影（MessageList/TurnTimer 零 turnStartedAt[/serverClockOffset[ 直连映射读）', () => {
  assert.ok(!/sessionStore\.turnStartedAt\[/.test(ml), 'MessageList 直读 turnStartedAt 映射（可跨会话取值=B 显 A 计时面）');
  assert.ok(!/sessionStore\.serverClockOffset\[/.test(ml), 'MessageList 直读 serverClockOffset 映射（可跨会话取值）');
  assert.ok(!/sessionStore\.turnStartedAt\[/.test(tt), 'TurnTimer 直读 turnStartedAt 映射（可跨会话取值）');
  assert.ok(!/sessionStore\.serverClockOffset\[/.test(tt), 'TurnTimer 直读 serverClockOffset 映射（可跨会话取值）');
  assert.ok(tt.includes('const start = sessionStore.activeTurnStartedAt;'), '派生未走活动会话投影');
});

// ── C4-6 三面并存不冲突（保全，现状即绿）──
// 三面=TurnTimer 底部状态条计时 / 本点流式标签计时 / 完成态气泡脚注计时。四处同读
// activeTurnStartedAt/activeTurnClockOffset + 同用 formatDurationMs → 同值同格式（裁决 C-A）。
check('C4-6 三面并存：TurnTimer 派生链零触（红线：本体零改动）+ 完成态脚注（formatDurationMs/bubble__meta 门控）保全 + C 链 .turn-timer__time 断言面在位', () => {
  assert.ok(tt.includes('Math.max(0, now.value + sessionStore.activeTurnClockOffset - start)'), 'TurnTimer 派生链被牵动（红线：TurnTimer 本体零改动）');
  assert.ok(tt.includes("{{ formatDurationMs(elapsedMs) }}"), 'TurnTimer 展示格式被牵动（裁决 C-A 同源三面）');
  assert.ok(mb.includes('formatDurationClock'), '完成态脚注 formatDurationClock 被牵动（regression-tests.ts:108 P4 同源时钟格式钉）');
  assert.ok(mbTpl.includes("message.durationMs || message.endedAt"), '完成态脚注门控被牵动（C2-4 同源钉）');
  const cchain = readRel('scripts/cdp-turn-sync-e2e.mjs');
  assert.ok(cchain.includes('.turn-timer__time'), 'C 链计时断言面缺失（三面并存真实行为闸门被拆链）');
});

// ── C4 类名互斥（UI13 形态同步：msg-label__timer 第三面未实施，互斥钉保留 turn-timer 禁入面）──
check('C4 类名互斥（UI13 死钉清账）：MessageList 零 turn-timer 子串（regression-tests.ts:106 互斥钉）+ 互斥钉本体保全', () => {
  assert.ok(!ml.includes('turn-timer'), 'MessageList 出现 turn-timer 子串（regression-tests.ts:106 必红）');
  const rt = readRel('scripts/regression-tests.ts');
  assert.ok(rt.includes("assert.ok(!messageList.includes('turn-timer'), 'MessageList 不得再内嵌 turn-timer');"), '互斥钉本体被牵动（互斥契约面漂移）');
});

// ═══════════════════════════════════════════════════════════════════════
// C5 空消息态（slate-ui-completion-1108-1428 round-001 点 C5，2026-11-09 增）
// 用例正本 = docs/ui-completion/tests/C-chat-stream-cases.md §C5（C5-1～C5-6 共 6 例，
// 正常 C5-1/2、边界 C5-3/4、异常路径 C5-5/6；并发向用例卷显式申报不适用）。
// C5-1/2/3/4 断言形态为 CDP（空会话采样/首条消息退场/≤50ms 连续采样防闪帧/空会话与有
// 消息会话互切）——隔离场景无 provider 发不了真回合（与 C1-8/C2/C3/C4 同判），以源级
// 结构钉为代理判据。
// 【UI13 形态同步，2026-11-22】计划中的 MessageList 内空态（.msg-empty/showEmptyState/
// --empty 键控）在 src 全历史未落地（git log -S 零命中）——现行空态 = ChatPage 无会话分支
// `.empty-state`（v-if="store.activeSession" 的 v-else），空态与消息流分支结构性互斥。
// C5 各钉改钉该面；C5 红线钉保留 MessageList 跟底判定全套字面（原红线精神不变）。
// ═══════════════════════════════════════════════════════════════════════

const EMPTY_BLOCK = '<div class="empty-state">';
const EMPTY_EYEBROW = '<p class="empty-state__eyebrow">Chat</p>';
const EMPTY_TITLE = '<h1>选择或创建一个会话</h1>';
const EMPTY_HINT = '<p>聊天区将在这里显示消息流和 Claude Code 执行详情。</p>';
const CP_SESSION_VIF = '<template v-if="store.activeSession">';
const CP_ELSE = '<template v-else>';

console.log('\n=== C5 空消息态契约（UI13 后形态：ChatPage 无会话分支 .empty-state） ===');

// ── C5-1 空态块文案逐字（正常向；ChatPage 无会话分支面）──
check('C5-1 空态块（UI13 死钉清账）：四节点文案逐字（Chat/选择或创建一个会话/聊天区提示/+ 新会话钮）+ grid 居中 + 落点（v-else 分支内）', () => {
  for (const [name, node] of [['容器', EMPTY_BLOCK], ['eyebrow', EMPTY_EYEBROW], ['标题', EMPTY_TITLE], ['副文', EMPTY_HINT]] as const) {
    assert.ok(cpTpl.includes(node), `空态块 ${name} 节点缺失或逐字漂移：${node}`);
  }
  // 行序钉（自上而下）。
  const idx = (s: string): number => cpTpl.indexOf(s);
  assert.ok(idx(EMPTY_BLOCK) > 0 && idx(EMPTY_EYEBROW) > idx(EMPTY_BLOCK) && idx(EMPTY_TITLE) > idx(EMPTY_EYEBROW) && idx(EMPTY_HINT) > idx(EMPTY_TITLE), '空态行序漂移');
  // 落点钉（v-else 分支内、v-if 消息流分支外）。
  const vifIdx = cpTpl.indexOf(CP_SESSION_VIF);
  const elseIdx = cpTpl.indexOf(CP_ELSE);
  const emptyIdx = cpTpl.indexOf('class="empty-state"');
  assert.ok(vifIdx > 0 && elseIdx > vifIdx && emptyIdx > elseIdx, '空态块落点漂移（须在无会话 v-else 分支内）');
  // 居中（结构等价钉）：grid + align-content: center 双轴居中。
  const emptyCss = ruleBlock(cpSty, '\\.empty-state');
  assert.ok(emptyCss.includes('display: grid') && emptyCss.includes('align-content: center'), '空态居中机制漂移（grid + align-content: center）');
});

// ── C5-2 会话建立即退场（UI13 死钉清账：空态挂 v-if="store.activeSession" 的 v-else——选会/建会
// 置位 activeSession 即切消息流分支，空态自然退场，无独立判据面）──
check('C5-2 会话建立即退场（UI13 死钉清账）：空态在 activeSession v-else 分支 + MessageList 在消息流分支内（结构互斥无残留窗口）', () => {
  const vifIdx = cpTpl.indexOf(CP_SESSION_VIF);
  const elseIdx = cpTpl.indexOf(CP_ELSE);
  assert.ok(vifIdx > 0 && elseIdx > vifIdx, '空态/消息流分支门控漂移');
  const msgListIdx = cpTpl.indexOf('<MessageList');
  assert.ok(msgListIdx > vifIdx && msgListIdx < elseIdx, 'MessageList 未在消息流分支内（空态退场结构互斥破）');
});

// ── C5-3 sending 起步不闪现（UI13 死钉清账：sending 仅在有活动会话时可为真（session-store
// sending getter = runningSessions.includes(activeSession.id)，C3-5 同源钉）→ 空态 v-else 分支
// 与 sending 状态结构性互斥，空态分支零消息流/流式渲染面）──
check('C5-3 sending 起步不闪现（UI13 死钉清账）：空态分支零 MessageList/stream-group 渲染面（无「空态与流式同帧在场」窗口）', () => {
  const emptySlice = cpTpl.slice(cpTpl.indexOf(CP_ELSE));
  assert.ok(!emptySlice.includes('<MessageList') && !emptySlice.includes('class="stream-group"'), '空态分支混入消息流/流式渲染面（同帧窗口）');
});

// ── C5-4 切会话条件正确（UI13 死钉清账：空态分支由 store.activeSession 直接门控——切会话/
// 无会话自动翻转，无行级缓存；跟底复位链零触）──
check('C5-4 切会话条件正确（UI13 死钉清账）：空态分支 activeSession 直接门控 + 切会话跟底复位 watch 零触（C2-P2 同源）', () => {
  assert.ok(cpTpl.includes(CP_SESSION_VIF), '空态/消息流分支门控漂移');
  assert.ok(/\(\) => sessionStore\.activeSession\?\.id,/.test(ml), '切会话跟底复位 watch 被牵动（近底态跨会话残留回退）');
});

// ── C5-5 横幅与空态互斥（UI13 死钉清账：横幅仅消息流分支 stream-group 内渲染，空态分支零
// 横幅挂载点；stream-group v-if 三横幅因子同源钉保留）──
check('C5-5 横幅与空态互斥（UI13 死钉清账）：空态分支零横幅挂载点 + stream-group v-if 三横幅判据字面（与流组同源）', () => {
  const emptySlice = cpTpl.slice(cpTpl.indexOf(CP_ELSE));
  assert.ok(!emptySlice.includes('<StalledBanner') && !emptySlice.includes('<ApiRetryBanner'), '空态分支混入横幅挂载点（横幅被空态挤压）');
  for (const ref of ['sessionStore.activeStalledInfo', 'sessionStore.activeApiRetryInfo', 'sessionStore.activeApiRetryTerminalFallback']) {
    assert.ok(STREAM_GROUP_VIF.includes(ref), `stream-group v-if 横幅因子漂移（${ref}，同源参照面失守本钉需重校）`);
  }
});

// ── C5-6 流式与空态互斥（UI13 死钉清账：空态分支零流式渲染面；stream-group v-if 三流式因子
// 字面保留——流式渲染只在消息流分支）──
check('C5-6 流式与空态互斥（UI13 死钉清账）：空态分支零 StreamRenderer/ThinkingBlock + stream-group v-if 三流式因子字面', () => {
  const emptySlice = cpTpl.slice(cpTpl.indexOf(CP_ELSE));
  assert.ok(!emptySlice.includes('<StreamRenderer') && !emptySlice.includes('<ThinkingBlock'), '空态分支混入流式渲染面（消息与空态同屏）');
  for (const ref of ['streamingContent', 'streamingThinking', 'streamingTool']) {
    assert.ok(STREAM_GROUP_VIF.includes(ref), `stream-group v-if 流式因子漂移（${ref}）`);
  }
});

// ── C5 红线钉：跟底滚动判定不被空态干扰（UI13 死钉清账：--empty 键控未实施，根容器现状唯一
// --export 键 + MessageList 零空态面；scroller/inner 字面保全线保留）──
check('C5 红线钉：贴底伪元素/nearBottom/scrollToBottom/跟底 watch/ResizeObserver 全套字面保全 + 根容器 --export 键现状（MessageList 零空态面——空态收敛 ChatPage）+ inner/scroller 模板字面零触', () => {
  assert.ok(/\.message-list__scroller::before\s*\{[^}]*margin-bottom:\s*auto;/.test(mlSty), '贴底伪元素 auto margin 被牵动（消息少时贴底回退）');
  assert.ok(ml.includes('const nearBottom = ref(true)'), 'nearBottom 被牵动');
  assert.ok(ml.includes('function scrollToBottom()'), 'scrollToBottom 被牵动');
  assert.ok(/\(\) => \[props\.messages\.length, props\.streamingContent/.test(ml), '跟底 watch 链被牵动');
  assert.ok(ml.includes('resizeObserver.observe(innerRef.value)'), 'ResizeObserver 观察面被牵动（C2-P2 同源）');
  assert.ok(mlTpl.includes(`:class="{ 'message-list--export': exportMode }"`), '根容器键控漂移（UI13 后现状唯一 --export 键）');
  // 保全线：三既有契约脚本钉 scroller/inner 模板字面（opt6 §② 整字面 regex、hb12 ①/b2 §46
  // 子串 indexOf）——被改动即本钉先红。
  assert.ok(mlTpl.includes('<div ref="innerRef" class="message-list__inner">'), 'inner 模板字面被改动（tdd-bugfix-opt6-session-switch-scroll §② regex 钉依赖）');
  assert.ok(mlTpl.includes('class="message-list__scroller"'), 'scroller 模板字面被改动（tdd-bugfix-hb12-export-measure ① / tdd-bugfix-b2-back-bottom ④ 子串钉依赖）');
  assert.ok(!ml.includes('showEmptyState') && !ml.includes('message-list--empty'), 'MessageList 残留空态面字面（空态已收敛 ChatPage 无会话分支，死钉清账后不得复活）');
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

// ── C7-9 消息进场过渡现状（UI13 死钉清账：msg-enter 进场动画未实施；msg-transition 为发送者
// 切换间距类 :deep(.msg-transition) margin-top 2.25rem + 接线三处在位（C2-P6 同源））──
check('C7-9 进场过渡现状（UI13 死钉清账）：msg-transition 间距类 margin-top 2.25rem + 接线三处在位 + MessageList 样式段零 @keyframes（进场动画未实施）', () => {
  assert.ok(/:deep\(\.msg-transition\)\s*\{[^}]*margin-top:\s*2\.25rem;/.test(mlSty), '发送者切换间距类漂移（msg-transition 仅间距语义）');
  assert.ok(mlTpl.includes("'msg-transition': isSenderTransition(idx)") && mlTpl.includes("'msg-transition': isStreamTransition()"), 'msg-transition 接线漂移（C2-P6 同源）');
  assert.ok(!mlSty.includes('@keyframes'), 'MessageList 混入 @keyframes（进场动画未实施，新增动画须走独立裁决）');
});

// ── C7-10 reduced-motion 现状（UI13 死钉清账：MessageList 零动画面故无 reduce 分支；全局动画
// 关闭面在 main.css（cursor/dots/banner 家族）+ TurnTimer 局部 reduce 分支（呼吸点/pdot 静止））──
check('C7-10 reduced-motion 现状（UI13 死钉清账）：MessageList 零 reduce 分支（无动画面）+ main.css 全局 reduce 面在位 + TurnTimer 局部 reduce 分支在位', () => {
  assert.ok(!mlSty.includes('@media (prefers-reduced-motion'), 'MessageList 混入 reduce 分支（无动画面不应有）');
  const mainCss = readRel('src/renderer/assets/styles/main.css');
  assert.ok(mainCss.includes('@media (prefers-reduced-motion: reduce)'), '全局 reduce 关闭面缺失（main.css cursor/dots/banner 家族）');
  assert.ok(tt.includes('@media (prefers-reduced-motion: reduce)'), 'TurnTimer reduce 分支缺失（呼吸点/pdot 静止面）');
});

// ── C7-11 跟底判据保全+过渡零布局触碰（UI13 死钉清账：msg-transition 间距类仅 margin——
// 零盒模型尺寸/定位触碰，不干扰跟底滚动判定）──
check('C7-11 跟底判据保全+过渡零布局触碰：scrollHeight/scrollTop/clientHeight 算式与 80/400 阈值逐字 + msg-transition 间距类仅 margin', () => {
  assert.ok(ml.includes('const distance = el.scrollHeight - el.scrollTop - el.clientHeight;'), '跟底距离算式漂移');
  assert.ok(ml.includes('nearBottom.value = distance < 80;'), '贴底阈值漂移');
  assert.ok(ml.includes('showBackToBottom.value = distance > 400;'), '回底阈值漂移');
  assert.ok(ml.includes('el.scrollTop = el.scrollHeight;'), '滚底赋值漂移');
  const mt = /:deep\(\.msg-transition\)\s*\{([^}]*)\}/.exec(mlSty)?.[1] ?? '';
  assert.ok(mt.includes('margin-top: 2.25rem'), '间距类漂移');
  assert.ok(!/(^|\n)\s*(width|height|padding|top|left|right|bottom|position)\s*:/.test(mt), '间距类触碰布局盒（干扰跟底滚动判定）');
});

// ── C7-12 hover 面现状（UI13 死钉清账：ai-card 描边加深方案未实施；现状 hover 面 = 气泡操作钮
// hover 显现（copy/translate）+ 列表侧按钮级 hover（back-bottom/turn-diff-retry））──
check('C7-12 hover 面现状（UI13 死钉清账）：气泡操作钮 hover 显现机制在位（copy/translate）+ 列表侧按钮级 hover 在位', () => {
  assert.ok(mbSty.includes('.bubble:hover .bubble__copy'), 'copy 行 hover 显现机制漂移');
  assert.ok(mbSty.includes('.bubble__copy:hover'), 'copy 钮 hover 漂移');
  assert.ok(mbSty.includes('.bubble:hover .bubble__translate'), 'translate 行 hover 显现机制漂移');
  assert.ok(mlSty.includes('.message-list__back-bottom:hover') && mlSty.includes('.turn-diff-error__retry:hover'), '列表侧按钮级 hover 漂移');
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
