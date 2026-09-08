// scripts/tdd-bugfix-b2-back-bottom-viewport-anchor-verify.ts
// B2 契约：回到底部浮动按钮必须锚定在「滚动容器的父级」（.message-list）上。
//
// 病根（2026-09-08 用户报告 + CDP 实测）：按钮原先挂在 .message-list__scroller（滚动容器）
// 内部，absolute 定位以滚动容器为包含块时锚定的是内容坐标——按钮内容坐标恒定
// （实测 contentTop 恒为布局时的视口底），视口位置随 scrollTop 漂移，滚远后按钮飘出
// 屏外，表现为「固定死在那个位置、不跟滚动条对应滚动」。
//
// 修复：按钮移出 scroller，作为 .message-list（position:relative）的直接子元素，
// 真正悬浮于聊天区视口右下角；显隐逻辑（距底 >400px 显示 / 到底 <80px 隐藏）不变。
// 本契约锁四件事：①定位锚换到父级 ②scroller 不再是定位锚（病根移除）
// ③按钮位于滚动容器/内容 wrapper 双层闭合之后（div 开闭平衡——旧的「连续两个 </div>」
//   弱断言在按钮留在 scroller 内的病态结构下也命中（stream-group/tool-stream 的连续闭合
//   会满足），模板单独回退会逃逸契约网，故改为片段内 div 开闭数相等）
// ④显隐判据保留（含 !exportMode——防导出模式泄漏回底按钮）。
//
// 运行：npx tsx scripts/tdd-bugfix-b2-back-bottom-viewport-anchor-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(repoRoot, 'src/renderer/components/chat/MessageList.vue'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

check('① 定位锚换到父级：.message-list 根块声明 position: relative', () => {
  const m = src.match(/^\.message-list \{([^}]*)\}/m);
  assert.ok(m, '未找到 .message-list 根样式块');
  assert.match(m[1], /position\s*:\s*relative/, '.message-list 根块缺 position: relative');
});

check('② 病根移除：.message-list__scroller 块不再声明 position: relative', () => {
  const m = src.match(/\.message-list__scroller \{([^}]*)\}/);
  assert.ok(m, '未找到 .message-list__scroller 样式块');
  assert.doesNotMatch(m[1], /position\s*:\s*relative/, 'scroller 仍是定位锚（absolute 按钮会随内容漂移）');
});

check('③ 按钮元素在滚动容器/内容 wrapper 双层闭合之后（div 开闭平衡，防模板回退逃逸）', () => {
  const scrollerAttr = src.indexOf('class="message-list__scroller"');
  const btn = src.indexOf('data-testid="back-to-bottom"');
  assert.ok(scrollerAttr > -1 && btn > -1, '模板元素缺失');
  // 片段 = scroller 开标签 → 按钮。按钮移出双层（scroller+inner）闭合之后时，片段内
  // div 开闭恰好平衡（stream-group/tool-stream 等内容 div 自身成对，不影响净额）；
  // 按钮被移回滚动内容内时，两层闭合落在按钮之后 → 闭合数 < 开标签数，断言红。
  // （旧版「连续两个 </div>」弱断言在病态结构下也命中，已废弃。）
  const scrollerOpen = src.lastIndexOf('<div', scrollerAttr);
  assert.ok(scrollerOpen > -1, '未找到 scroller 开标签');
  const between = src.slice(scrollerOpen, btn);
  const opens = between.match(/<div[\s>]/g)?.length ?? 0;
  const closes = between.match(/<\/div>/g)?.length ?? 0;
  assert.ok(opens > 0 && opens === closes, `按钮必须位于滚动容器双层闭合之后（片段 div 开 ${opens} !== 闭 ${closes}）`);
});

check('④ 显隐判据保留：距底 >400px 显示 / <80px 视为到底 / 滚动监听在 scroller 上 / 导出模式不显示', () => {
  assert.match(src, /showBackToBottom\.value = distance > 400/);
  assert.match(src, /nearBottom\.value = distance < 80/);
  assert.match(src, /@scroll\.passive="onScroll"/);
  assert.match(src, /showBackToBottom && !exportMode/, '缺 !exportMode（导出模式会泄漏回底按钮）');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
