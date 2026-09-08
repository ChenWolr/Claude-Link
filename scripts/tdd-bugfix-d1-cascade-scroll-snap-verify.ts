// tdd-bugfix-d1-cascade-scroll-snap-verify.ts
// D1/D2/D3（模型级联选择器三缺陷，2026-09-08 诊断定案）契约钉：
//   D1 点击盲区——`.cascade .models .scroll`（max-height=4 行）下第 5 个模型半行可见，
//      其被裁剪的下半段命中测试落在菜单底部 `.foot` 提示条上，点击静默无效（不选中/
//      不关菜单/无报错）。真实事故：用户以为选了 t-glm-5.3-flash 实际没选上，会话无
//      override，引擎按全局默认跑了 mimo-v2.5-pro。
//   D2 可发现性——模型列最多 4 行、滚动条悬停前透明，后面的模型几乎不可发现。
//   D3 语义含混——触发器显示 resolveSessionModel 解析结果（override ?? lastUsed ?? 库首），
//      不区分「会话已钉住」与「跟随默认恰好同值」。
//
// 修复语义（仅 ProviderModelSelector.vue，主进程/IPC/DB/store 零改动）：
// ① 打开即滚到当前项：toggleOpen() 打开分支 nextTick 后，左列 .item.active 与右列当前
//    生效模型行各 scrollIntoView({ block: 'nearest' })；目标行不存在静默跳过。
// ② 行级滚动吸附：两列 .scroll 加 scroll-snap-type: y proximity，.item 加
//    scroll-snap-align: start（消除「半行可见」几何源；不改行高/视窗数值）。
// ③ 触发器「默认」徽标：无会话级 override 时显示 model-trigger__tag「默认」徽标，
//    title 说明跟随默认语义；钉住后徽标消失、title 维持原文。
//
// 运行：npx tsx scripts/tdd-bugfix-d1-cascade-scroll-snap-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}`);
  }
}

const comp = read('src/renderer/components/chat/ProviderModelSelector.vue');

console.log('=== D1-① 打开即滚到当前项（toggleOpen nextTick 归位）===');
{
  check('nextTick 已从 vue 引入', /import \{[^}]*\bnextTick\b[^}]*\} from 'vue'/.test(comp));

  const toggleAt = comp.indexOf('function toggleOpen');
  check('toggleOpen 存在', toggleAt !== -1);
  // script setup 顶层函数以行首 `}` 收束（内部闭括号均带缩进）
  const toggleBody = toggleAt !== -1 ? comp.slice(toggleAt, comp.indexOf('\n}', toggleAt) + 2) : '';

  check(
    'scrollIntoView({ block: \'nearest\' }) 恰两处调用（左列+右列）',
    (comp.match(/scrollIntoView\(\{ block: 'nearest' \}\)/g) || []).length === 2,
  );
  check('打开分支保留 hoverProviderId 初始化', toggleBody.includes('hoverProviderId.value = resolved.value.provider?.id ?? null;'));
  check('滚动在 nextTick 内（DOM 已渲染 .cascade）', toggleBody.includes('nextTick('));
  check('左列 active 行选择器正确', toggleBody.includes(".querySelector('.cascade .providers .scroll .item.active')"));
  check('右列按 hoverIsCurrent + resolved.modelId 门控', toggleBody.includes("if (!hoverIsCurrent.value || !resolved.value.modelId) return;"));
  check('右列当前行经 querySelectorAll + findIndex 定位', toggleBody.includes("querySelectorAll('.cascade .models .scroll .item')") && toggleBody.includes('findIndex'));
  check('目标行不存在静默跳过（无 throw 路径）', !toggleBody.includes('throw'));
}

console.log('=== D1-② 行级滚动吸附（消除半行可见几何源）===');
{
  check(
    '两列 .scroll 挂 scroll-snap-type: y proximity',
    /\.cascade \.models \.scroll,\s*\.cascade \.providers \.scroll \{[^}]*scroll-snap-type: y proximity;/.test(comp),
  );
  check('行 .item 挂 scroll-snap-align: start', /\.cascade \.scroll \.item \{[^}]*scroll-snap-align: start;/.test(comp));
}

console.log('=== D3 触发器「默认」徽标 ===');
{
  check(
    'followsDefault computed 精确形态（任一 override 即非默认）',
    comp.includes(
      'const followsDefault = computed(() => !(sessionStore.activeSession?.providerOverride || sessionStore.activeSession?.modelOverride));',
    ),
  );
  check('模板徽标 span v-if="followsDefault"', comp.includes('<span v-if="followsDefault" class="model-trigger__tag">默认</span>'));
  check('徽标位于 model-trigger__model 之后', comp.indexOf('<strong class="model-trigger__model">') !== -1 && comp.indexOf('<strong class="model-trigger__model">') < comp.indexOf('model-trigger__tag'));
  check('跟随默认态 title 文案（语义自解释）', comp.includes('当前跟随默认（最近使用），未在本会话固定'));
  check('钉住态 title 原文保留', comp.includes('切换本会话使用的供应商与模型（下一条消息起生效）'));
  check(
    '徽标样式：0.5625rem 小号 + muted 色 + radius-sm 描边 + flex none',
    [
      'font-size: 0.5625rem;',
      'var(--color-text-muted)',
      'var(--radius-sm)',
      'flex: none;',
    ].every((needle) => /\.model-trigger__tag \{[^}]*\}/.test(comp) && /\.model-trigger__tag \{[^}]*\}/.exec(comp)![0].includes(needle)),
  );
}

console.log('=== 回归：视觉基准 1:1 与选择语义零改动 ===');
{
  check('行高基准不变（2.625rem）', comp.includes('height: 2.625rem;'));
  check('4 行视窗 max-height 不变', comp.includes('max-height: calc(2.625rem * 4);'));
  check(
    'selectModel → setActiveSessionProviderModel 链路不变',
    /async function selectModel\(modelId: string\): Promise<void> \{[\s\S]{0,300}setActiveSessionProviderModel\(pid, modelId\)/.test(comp),
  );
  check(
    'resolve 投影不变（会话 override 透传 shared 纯函数）',
    /providerOverride: sessionStore\.activeSession\?\.providerOverride \?\? null,[\s\S]{0,80}modelOverride: sessionStore\.activeSession\?\.modelOverride \?\? null,/.test(comp),
  );
  check('invalidOverride 回退 toast 逻辑保留', comp.includes('fallbackToastShownFor'));
  check('触发器未配置态入口保留', comp.includes('未配置模型 → 前往设置'));
}

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
