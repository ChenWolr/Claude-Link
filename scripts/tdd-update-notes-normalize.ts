// tdd-update-notes-normalize.ts
// 更新说明归一化补块级换行与图片占位（隐藏缺陷修复第二轮 X19 / R14-F2）TDD 契约脚本。
//   R14-F2：atom 补链 HTML 经 htmlReleaseNotesToText 归一时，details/summary 不在块级
//   清单 → 落入通用剥残标签被内联剥除、零分隔（实证「Full Changelogv0.4.2...v0.4.3 (href)」
//   粘连）；<img> 无处理规则 → 连 alt 一起无痕消失。
//   X19 followup（2026-10-07 规则上收）：两条规则由 app-updater 前置补丁 patchAtomHtmlNotes
//   上收到 shared/release-notes.htmlReleaseNotesToText——步骤 6 块级闭合清单补
//   details|summary（→ \n），新增 img 占位规则（→ [图片：alt]，alt 缺失或空 → [图片]），
//   位置在通用剥残标签（步骤 10）之前，占位文本随主链统一解码实体；app-updater 退役
//   包装函数与 looksLikeHtmlNotes import，接线恢复直传 normalizeReleaseNotes(info.releaseNotes)。
//   上收增益：数组分支（fullChangelog 形态）的 HTML note 同样获得两条规则（前置补丁只
//   作用于字符串分支），P8 钉。门谓词 looksLikeHtmlNotes 在 X19 上收时保持不变；2026-10-09
//   扫雷 P2-2 补检 details|summary|img——仅折叠块/仅图片的 HTML 不再直通直出（P9 钉），
//   含字面 <img> 的字符串由直通改为占位转换（P7 已更新）。
// 分组：
//   P1-P2  details/summary 粘连解开（P1 为审计 R14-F2 实证 probe 回归锚）；
//   P3-P5  img 占位（alt 非空 / 无或空 alt / alt 实体解码与单引号形态）；
//   P6     details 包裹列表仍可读；
//   P7     影响面守卫：直通字节不变 + 既有转换（p/li/h2/表格/嵌套列表）不漂移；
//   P8     非字符串形态（null/undefined/数字 → null）+ 数组分支同样获得规则（上收增益）；
//   P9     门谓词补检（2026-10-09 扫雷 P2-2）：仅 details/summary 折叠块或仅 img 的 HTML
//          也判 HTML——正则漏检会让这类 body 直通直出（v0.4.3 标签直出事故同型复发口）；
//   W1-W4  结构钉：shared 规则落点齐备、app-updater 补丁退役干净、兄弟契约字面保留、
//          清单登记。
// 运行：npx tsx scripts/tdd-update-notes-normalize.ts（已登记 scripts/selftest-static-list.txt）
// RED 约定：P 组经受保护加载——规则未上收时逐项 fail（fail>0）而非顶层 crash。
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
function readRel(p: string): string {
  return readFileSync(resolve(__dirname, '..', p), 'utf8');
}

type ReleaseNotesModule = typeof import('../src/shared/release-notes');
let rel: ReleaseNotesModule | null = null;
try {
  // 受保护加载：规则未上收（RED 阶段）时行为断言逐项 fail 而非顶层 crash。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  rel = require('../src/shared/release-notes') as ReleaseNotesModule;
} catch {
  rel = null;
}
function rel_(): ReleaseNotesModule {
  assert.ok(rel, 'src/shared/release-notes 未加载（模块缺失或导出不全）');
  return rel;
}
/** 摄入链（上收后）：normalizeReleaseNotes 单链直归——两条规则已在 htmlReleaseNotesToText 内。 */
function pipeline(raw: unknown): string | null {
  return rel_().normalizeReleaseNotes(raw);
}

console.log('\n=== P1) R14-F2 实证 probe：details/summary 折叠 Changelog 粘连解开 ===');
check('P1 summary 文本与链接文本换行分隔，不再「Full Changelogv0.4.2」粘连', () => {
  const probe =
    '<h2>What\'s Changed</h2><ul><li>修复 A</li></ul>' +
    '<details><summary>Full Changelog</summary>' +
    '<a href="https://github.com/ChenWolr/Claude-Link/compare/v0.4.2...v0.4.3">v0.4.2...v0.4.3</a></details>';
  const out = pipeline(probe);
  // 计划测试锚：输出含 '\nFull Changelog' 与 '[图片]'（后者在 P3/P4）。
  assert.ok(out !== null && out.includes('\nFull Changelog'), `summary 未起新行: ${JSON.stringify(out)}`);
  // 回归锚：审计实证的粘连形态必须消失，summary 与链接文本以换行分隔。
  assert.ok(!out.includes('Full Changelogv0.4.2'), `粘连残留: ${JSON.stringify(out)}`);
  assert.ok(out.includes('Full Changelog\nv0.4.2...v0.4.3'), `summary/链接未换行分隔: ${JSON.stringify(out)}`);
  assert.ok(out.includes('v0.4.2...v0.4.3 (https://github.com/ChenWolr/Claude-Link/compare/v0.4.2...v0.4.3)'), `链接 text (href) 形态漂移: ${JSON.stringify(out)}`);
  assert.ok(!/<\/?[a-zA-Z][^>]*>/.test(out), `残留标签: ${JSON.stringify(out)}`);
});

console.log('\n=== P2) summary 后随内联文本（非块级）同样换行分隔 ===');
check('P2 </summary> 边界换行：完整变更\nv1.0 到 v1.1', () => {
  const out = pipeline('<p>变更：</p><details><summary>完整变更</summary>v1.0 到 v1.1</details>');
  assert.ok(out !== null && !out.includes('完整变更v1.0'), `粘连残留: ${JSON.stringify(out)}`);
  assert.ok(out.includes('完整变更\nv1.0 到 v1.1'), `summary/内联文本未换行分隔: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('<details') && !out.includes('<summary') && !out.includes('</summary'), `details/summary 标签残留: ${JSON.stringify(out)}`);
});

console.log('\n=== P3) img → [图片：alt] 占位（alt 非空） ===');
check('P3 审计 R14-F2 实证 probe：alt「新外观截图」以占位保留而非无痕丢弃', () => {
  const out = pipeline('<p>新增截图展示：</p><p><img src="https://x/s.png" alt="新外观截图"></p><p>end</p>');
  assert.ok(out !== null && out.includes('[图片：新外观截图]'), `img 占位缺失: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('<img'), `img 标签残留: ${JSON.stringify(out)}`);
  assert.ok(out.includes('新增截图展示：\n[图片：新外观截图]\nend'), `块级换行形态漂移: ${JSON.stringify(out)}`);
});

console.log('\n=== P4) img 无 alt / 空 alt → 裸 [图片] 占位 ===');
check('P4 <img src>（无 alt）与 alt="" 均输出 [图片]', () => {
  const noAlt = pipeline('<p>配图：</p><p><img src="https://x/t.png"></p>');
  assert.ok(noAlt !== null && noAlt.includes('[图片]'), `无 alt 占位缺失: ${JSON.stringify(noAlt)}`);
  assert.ok(!noAlt.includes('[图片：'), `无 alt 不应带 alt 形态: ${JSON.stringify(noAlt)}`);
  const emptyAlt = pipeline('<p><img src="https://x/t.png" alt=""></p>');
  assert.ok(emptyAlt !== null && emptyAlt.includes('[图片]'), `空 alt 占位缺失: ${JSON.stringify(emptyAlt)}`);
  assert.ok(!emptyAlt.includes('[图片：'), `空 alt 不应带 alt 形态: ${JSON.stringify(emptyAlt)}`);
});

console.log('\n=== P5) img alt 实体经主链统一解码 + 单引号属性形态 ===');
check('P5 alt="A &amp; B" → [图片：A & B]；alt=\'单引号Alt\' 同样生效', () => {
  const out = pipeline('<p><img src="https://x/e.png" alt="A &amp; B"></p>');
  assert.ok(out !== null && out.includes('[图片：A & B]'), `alt 实体未解码: ${JSON.stringify(out)}`);
  const single = pipeline('<p><img src="https://x/s2.png" alt=\'单引号Alt\'></p>');
  assert.ok(single !== null && single.includes('[图片：单引号Alt]'), `单引号 alt 未占位: ${JSON.stringify(single)}`);
});

console.log('\n=== P6) 影响面守卫：details 包裹列表仍可读（既有 <ul> 自带换行不受扰） ===');
check('P6 summary+列表折叠形态：列表项逐行、零粘连、零标签残留', () => {
  const out = pipeline('<h2>更新</h2><details><summary>完整变更</summary><ul><li>a</li><li>b</li></ul></details>');
  assert.ok(out !== null && out.includes('完整变更'), `summary 文本丢失: ${JSON.stringify(out)}`);
  assert.ok(out.includes('- a\n- b'), `列表形态漂移: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('完整变更- a'), `summary 与列表粘连: ${JSON.stringify(out)}`);
  assert.ok(!/<\/?[a-zA-Z][^>]*>/.test(out), `残留标签: ${JSON.stringify(out)}`);
});

console.log('\n=== P7) 影响面守卫：直通字节不变与既有转换不漂移 ===');
check('P7 纯文本/Markdown 直通字节不变（字面 <img> 经 P2-2 补检后转占位）；p/li/h2/表格/嵌套列表输出不漂移', () => {
  // 计划实现标准：纯文本 release notes 输出字节不变——补丁只作用于将被 HTML 转换的字符串。
  assert.equal(pipeline('## 新增\n- x\n- y'), '## 新增\n- x\n- y');
  assert.equal(pipeline('a < b 且 c > d'), 'a < b 且 c > d');
  // P2-2（2026-10-09）门谓词补检 img 后，字面 <img> 不再直通——无 alt → 裸 [图片] 占位。
  assert.equal(pipeline('说明 <img src="u"> 见下'), '说明 [图片] 见下');
  // 既有契约（tdd-release-notes-verify P2/P4/P10 同款样本）不得被前置补丁扰动。
  const { htmlReleaseNotesToText } = rel_();
  assert.equal(htmlReleaseNotesToText('<p>x</p><p>y</p>'), 'x\ny');
  assert.equal(htmlReleaseNotesToText('<p>a</p>\n\n\n\n<p>b</p>'), 'a\n\nb');
  assert.equal(htmlReleaseNotesToText('<h2>t</h2><ul><li>a</li><li>b</li></ul>'), '## t\n\n- a\n- b');
  assert.equal(
    htmlReleaseNotesToText('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'),
    'A | B\n1 | 2',
  );
});

console.log('\n=== P8) 非字符串形态 + 数组分支同样获得规则（上收增益） ===');
check('P8 null/undefined/数字 → null；数组分支 HTML note 的 details/summary/img 同样处理', () => {
  assert.equal(pipeline(null), null);
  assert.equal(pipeline(undefined), null);
  assert.equal(pipeline(123), null);
  // 上收前：前置补丁只作用于字符串分支（typeof raw !== \'string\' 直通），数组 note 不经
  // 两条规则；上收后统一经 htmlReleaseNotesToText——数组分支同样解粘连/占位
  // （fullChangelog 形态一致可读）。
  const arr = [{ note: '<p>x</p><details><summary>S</summary>y</details>' }, { note: 'b' }];
  const out = pipeline(arr);
  assert.ok(out !== null && out.includes('S\ny'), `数组分支 details 未解粘连: ${JSON.stringify(out)}`);
  const arrImg = pipeline([{ note: '<p><img src="u" alt="配图"></p>' }]);
  assert.ok(arrImg !== null && arrImg.includes('[图片：配图]'), `数组分支 img 未占位: ${JSON.stringify(arrImg)}`);
});

console.log('\n=== P9) 门谓词补检 details/summary/img（2026-10-09 扫雷 P2-2） ===');
check('P9 仅 details/summary 折叠块 → 判 HTML 且转换后无标签、summary 与正文分行', () => {
  const { looksLikeHtmlNotes } = rel_();
  const probe = '<details><summary>更新详情</summary>\n纯文本行\n</details>';
  assert.ok(looksLikeHtmlNotes(probe), '仅折叠块未被检出为 HTML（直通复发口）');
  const out = pipeline(probe);
  assert.ok(out !== null, `输出为空: ${JSON.stringify(out)}`);
  assert.ok(out.includes('更新详情') && out.includes('纯文本行'), `文本丢失: ${JSON.stringify(out)}`);
  assert.ok(!/<\/?[a-zA-Z][^>]*>/.test(out), `残留标签: ${JSON.stringify(out)}`);
  // </summary> 转换 \n 与源文本自带 \n 叠加为一空行（3+ 才折叠，算法忠实输出），钉「换行分隔」。
  assert.ok(/更新详情\n+纯文本行/.test(out), `summary 与正文未分行: ${JSON.stringify(out)}`);
});
check('P9 仅 img → 判 HTML 且输出 [图片：alt] 占位', () => {
  const { looksLikeHtmlNotes } = rel_();
  const probe = '<img src="x" alt="截图">';
  assert.ok(looksLikeHtmlNotes(probe), '仅 img 未被检出为 HTML（直通复发口）');
  const out = pipeline(probe);
  assert.ok(out === '[图片：截图]', `img 占位形态漂移: ${JSON.stringify(out)}`);
});

console.log('\n=== W) 结构钉 ===');
const appUpdater = readRel('src/main/modules/app-updater.ts');
const sharedNotes = readRel('src/shared/release-notes.ts');
const selftestList = readRel('scripts/selftest-static-list.txt');

check('W1 规则落点（上收后）：shared 步骤 6 闭合清单含 details|summary，img 占位规则位于通用剥残标签之前', () => {
  assert.ok(
    sharedNotes.includes('<\\/(p|div|blockquote|ul|ol|table|tr|pre|h[1-6]|details|summary)\\s*>'),
    '步骤 6 块级闭合清单缺 details|summary',
  );
  const imgRuleIdx = sharedNotes.indexOf('/<img\\b[^>]*>/gi');
  assert.ok(imgRuleIdx > -1, 'img 占位规则缺失');
  assert.ok(sharedNotes.includes('[图片：'), 'img 占位带 alt 文案缺失');
  assert.ok(sharedNotes.includes("return text ? `[图片：${text}]` : '[图片]';"), 'img 占位形态漂移（alt 缺失或空 → 裸 [图片]）');
  const genericStripIdx = sharedNotes.indexOf('/<\\/?[a-zA-Z][^>]*>/g');
  assert.ok(genericStripIdx > -1, '通用剥残标签（步骤 10）锚点缺失');
  assert.ok(imgRuleIdx < genericStripIdx, 'img 规则必须在通用剥残标签之前（否则标签先被剥、alt 无痕丢失）');
});
check('W2 补丁退役：app-updater 无 patchAtomHtmlNotes/looksLikeHtmlNotes 残留，接线直传归一主链', () => {
  assert.ok(!appUpdater.includes('patchAtomHtmlNotes'), 'patchAtomHtmlNotes 残留（应退役上收）');
  assert.ok(!appUpdater.includes('looksLikeHtmlNotes'), 'looksLikeHtmlNotes import 残留（补丁专属依赖）');
  assert.ok(!appUpdater.includes('info.releaseNotes = '), '前置写回接线残留（应主链单链直归）');
  assert.ok(appUpdater.includes('releaseNotes: normalizeReleaseNotes(info.releaseNotes)'), '主链直传调用缺失');
});
check('W3 兄弟契约保留：tdd-release-notes-verify W1 钉住的 import 与主链调用字面原样在位', () => {
  assert.ok(appUpdater.includes("import { normalizeReleaseNotes } from '../../shared/release-notes'"), 'import 字面漂移');
  assert.ok(appUpdater.includes('releaseNotes: normalizeReleaseNotes(info.releaseNotes)'), '主链调用字面漂移');
});
check('W4 selftest-static-list.txt 已登记本脚本', () => {
  assert.ok(selftestList.includes('scripts/tdd-update-notes-normalize.ts'), '清单未登记');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
