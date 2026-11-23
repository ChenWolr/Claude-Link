// scripts/tdd-translation-core-verify.ts
// P5 翻译纯函数组契约卷（2026-11-19 UI 五点批次 · 第三轮 R6 引擎层置换后的引擎形态；
// 规格 = 01-实现细节.md §5.1 引擎常量块 / §5.2 切段规则（含规则 5 代码块）/ §5.2.2 出厂种子 /
// §5.2.3 出厂端点字面 / §5.2.6 置换清单；02-测试用例清单 P5 建议组转写）。
//
// 覆盖（check() 计数，失败 exit 1）：
//   · segmentSourceText 引擎形态：返回 Array<{text, codeBlock}>——正常向（多段按段落切）/
//     边界向（恰 1200 单段、1201 硬切、句末标点二次切、尾部 <40 并入、恰 400 段）/ 异常向
//     （总长 >10 万与段数 >400 → null 拒绝）/ 规则 5 代码块（``` 开头段整段 codeBlock、
//     未闭合围栏防御性同判、代码块段不硬切、表格段送翻、行内码不特殊处理、围栏碎段不并入）
//   · hashSegment 确定性 + 异文异哈希（FNV-1a 32 位 hex，标准测试向量算法钉——置换不动）
//   · DEFAULT_TRANSLATION_ENGINES 出厂种子（RB-CORE-T-种 p7/W4 改写·终态重排）：五条
//     bing-web(0)/alibaba-web(1)/qq-transmart(2)/sogou-web(3)/youdao-web(4) 全 enabled 全直连
//     （useProxy 缺省），kind 全 ∈ 白名单五 kind（p7/W4 起 google-gtx/baidu-web 死引擎剔除）
//   · sanitizeTranslationConfig：kind 白名单外丢弃 / enabled 非 bool→true / order 非有限整数
//     按序重排 / 缺键读出种子 / T-迁-5（p6/W5 改写·剔除语义）：存量 customTemplates 数组与
//     custom-template/tencent-tmt 越集条目静默剔除、字段键消失、其余引擎保全、零报错 /
//     T-迁-1/2/3/4/6（p7/W4 新增·W4 配置迁移组）：kind 白名单终态五（四死 kind 剔除、五活
//     kind 透传）/ seed-google-gtx/seed-baidu-web 条目剔除且用户自定义 id 不受影响、
//     seed-youdao-web 保留 / 存量 google/bing/youdao/baidu 四种子读路径归一恰五引擎（补齐
//     终序 [bing,youdao,alibaba,qq,sogou] 且 order 单调无撞号——P1-6 读法 B 钉）/ 用户显式
//     enabled:false 种子不被覆盖 / alibaba/qq/sogou/youdao 四 kind endpoint 剥离（含存量
//     youdao V1 脏值）、bing-web endpoint 保留 /
//     P1B-T9（MOD-P1B-1 增钉，p8 翻转落卷）：proxyUrl 字段删除、存量键任意值型 sanitize 剥离
//     （T-迁-7 本体；原 trim 透传断言随 P1-B 代理面回撤翻转）+ 缺省/空/纯空白/非字符串 →
//     键缺席（剥离形态与缺省形态一致）
//   · 引擎常量 4 个定值（RB-CORE-T-常-引 p6 改写、p7 钉终集形态——五常量终集：tencent 间隔
//     与 google/baidu 端点常量均不再导出，删除留痕=模块不再导出 + core 源码零残留）
//   · 出厂端点种子字面（RB-CORE-T-端-1 p7 改写：DEFAULT_BING_WEB_DOMAIN 存续；
//     google/baidu/youdao/tencent 端点常量删除留痕）
//   · 既有 9 常量定值钉（置换不动：hashSegment 与全部 TRANSLATION_* 数值不变）
//
// 删除留痕（RB-CORE，2026-11-22 扩容批次 p6/W5——出卷清单 §6）：
//   RB-CORE-T-模/T-径：模板 DSL 用例组 T-模-1..5 / T-径-1..4 整组删除——消费面（makeCustomTemplate
//     适配器 + config.translation.customTemplates 字段 + ConfigPage 模板编辑区）已随 W5 整链
//     移除；renderTemplateUrl 保留（唯一余留消费面 = google-gtx 端点占位替换），body 渲染/
//     responsePath 取值/模板校验三函数失去全部调用方；契约未钉死导出去留（出卷不越契约），
//     本卷不额外钉「DSL 纯函数必须删」，实施侧按「全链删净、删后零死引用」自行收口（见 p6 实施报告）。
//   RB-CORE-T-常-引：TRANSLATION_TENCENT_MIN_INTERVAL_MS 删除留痕（模块不再导出）。
//   RB-CORE-T-端-1（随动）：DEFAULT_TENCENT_TMT_ENDPOINT 删除留痕（tencent 端点随引擎删除）。
//
// p7/W4 re-base 留痕（2026-11-22 扩容批次，出卷清单 §7）：
//   RB-CORE-T-种-1/2（原 T-种-1/2 改写）：出厂种子终态五条五序（google-gtx/baidu-web 两死引擎
//     剔除——用户裁决「谷歌先剔除掉」+ baidu-web 死引擎清理；P3-4 直书五元序，删「Stage A
//     移植者殿后」类残留表述；bing 备注直连 LLM 形态）。
//   RB-CORE-T-端-1（改写）：DEFAULT_GOOGLE_GTX_ENDPOINT/DEFAULT_BAIDU_WEB_ENDPOINT 删除留痕
//     （W4 清理面——两常量随引擎整链移除，模块不再导出、core 源码零残留）。
//   T-迁-1/2/3/4/6 新增：W4 配置迁移组（sanitize 三规则——死种子剔除/规范种子补齐/endpoint 剥离；
//     T-迁-5 已随 p6 落卷；T-迁-7 proxyUrl 剥离随 p8 落卷，断言面并入 T-净-5 翻转形态）。
//
// RED 留证（p7）：对未清理工作树首跑 → RB-CORE-T-种-1（七条旧序）、RB-CORE-T-端-1（google/baidu
// 端点常量仍导出）、T-迁-1（白名单七 kind）（历史留证：p6 时点白名单曾为七 kind，p7 收窄五 kind 终态——留痕不改断言）、T-迁-3（补齐规则缺位）全红，exit ≠ 0。
//
// RED 留证：对第二轮 LLM 形态工作树首跑（DEFAULT_TRANSLATION_ENGINES/引擎常量不存在、
// segmentSourceText 仍返回 string[]）→ 命名导入链接失败崩溃或断言失败，exit ≠ 0。
// p6 红态：对未删除工作树首跑 → T-迁-5（sanitize 仍保留 customTemplates 键与越集条目）、
// T-常-引（TRANSLATION_TENCENT_MIN_INTERVAL_MS 仍导出）、T-端-1（tencent 端点常量仍导出）红。
// 运行：npx tsx scripts/tdd-translation-core-verify.ts（登记 scripts/selftest-static-list.txt 尾部）

import * as fs from 'node:fs';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';
import {
  segmentSourceText,
  hashSegment,
  sanitizeTranslationConfig,
  DEFAULT_TRANSLATION_ENGINES,
  DEFAULT_BING_WEB_DOMAIN,
  TRANSLATION_ENGINE_TRY_TIMEOUT_MS,
  TRANSLATION_PROBE_TIMEOUT_MS,
  TRANSLATION_ENGINE_429_COOLDOWN_MS,
  TRANSLATION_PROBE_TEXT,
  TRANSLATION_MAX_SOURCE_CHARS,
  TRANSLATION_SEGMENT_MAX_CHARS,
  TRANSLATION_MIN_TAIL_CHARS,
  TRANSLATION_MAX_SEGMENTS,
  TRANSLATION_CACHE_MAX_SEGMENTS,
  TRANSLATION_CONCURRENCY,
  TRANSLATION_SEGMENT_TIMEOUT_MS,
  TRANSLATION_RESPONSE_MAX_BYTES,
  TRANSLATION_PUSH_THROTTLE_MS,
} from '../src/shared/translation-core';

const repoRoot = path.resolve(__dirname, '..');
// 纯函数模块不许有副作用依赖：零 import 之外的运行时引用面（仅类型/常量自持）。
const coreSrc = fs.readFileSync(path.join(repoRoot, 'src/shared/translation-core.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 300)}`);
  }
}

const SEG = TRANSLATION_SEGMENT_MAX_CHARS; // 1200
const A = '甲'.repeat(80);
const B = '乙'.repeat(80);
const C = '丙'.repeat(80);
const texts = (segs: ReturnType<typeof segmentSourceText> & NonNullable<unknown>): string[] =>
  (segs as Array<{ text: string }>).map((s) => s.text);

function main(): void {
  console.log('=== 1) segmentSourceText：切段纯函数（引擎形态 {text, codeBlock}）===');

  check('T-切-1 正常向：多段文本按段落切（\\n\\n 与单 \\n 均为段落界，段落内容/顺序保全，全 codeBlock:false）', () => {
    const segs = segmentSourceText([A, B, C].join('\n\n'));
    assert.ok(segs !== null);
    assert.deepEqual(texts(segs), [A, B, C]);
    assert.ok(segs.every((s) => s.codeBlock === false), '普通段落 codeBlock 必须 false');
    assert.deepEqual(texts(segmentSourceText([A, B].join('\n'))), [A, B]);
  });

  check('T-切-2 边界向：恰 1200 字符单段不切（单段 = 1200 上限内）', () => {
    const segs = segmentSourceText('字'.repeat(SEG));
    assert.ok(segs !== null);
    assert.deepEqual(texts(segs), ['字'.repeat(SEG)]);
  });

  check('T-切-3 边界向：1201 字符硬切（无句末标点 → [1200, 1] 两段，单段上限不破）', () => {
    const segs = segmentSourceText('字'.repeat(SEG + 1));
    assert.ok(segs !== null);
    assert.equal(segs.length, 2);
    assert.equal(segs[0]?.text.length, SEG);
    assert.equal(segs[1]?.text.length, 1);
  });

  check('T-切-4 边界向：句末标点二次切（2000 字段落每 100 字一句 → 20 段，全 ≤1200）', () => {
    const para = Array.from({ length: 20 }, () => '句'.repeat(99) + '。').join('');
    assert.equal(para.length, 2000);
    const segs = segmentSourceText(para);
    assert.ok(segs !== null);
    assert.equal(segs.length, 20);
    for (const s of segs) assert.ok(s.text.length <= SEG, `段长 ${s.text.length} 超 1200`);
    assert.equal(segs.map((s) => s.text).join(''), para, '切段内容拼回应保全原文');
  });

  check('T-切-5 边界向：尾部 <40 碎段并入前段（39 并入 / 40 不并入——阈值严格小于）', () => {
    const merged = segmentSourceText([A, '乙'.repeat(39)].join('\n\n'));
    assert.ok(merged !== null && merged.length === 1, '39 字尾段应并入前段');
    assert.ok(merged[0]?.text.startsWith(A) && merged[0]?.text.endsWith('乙'.repeat(39)), '并入后内容保全');
    const unmerged = segmentSourceText([A, '乙'.repeat(40)].join('\n\n'));
    assert.ok(unmerged !== null && unmerged.length === 2, '恰 40 字尾段不并入（<40 才并入）');
  });

  check('T-切-6 边界向：恰好 400 段放行 / 401 段拒绝（段数上限防御线）', () => {
    const paras400 = Array.from({ length: 400 }, () => '段'.repeat(100));
    const segs = segmentSourceText(paras400.join('\n\n'));
    assert.ok(segs !== null && segs.length === 400);
    const paras401 = Array.from({ length: 401 }, () => '段'.repeat(100));
    assert.equal(segmentSourceText(paras401.join('\n\n')), null);
  });

  check('T-切-7 异常向：总长恰 100_000 放行 / 100_001 拒绝（拒绝形态 = 返回 null，零段落产出）', () => {
    const at = segmentSourceText('x'.repeat(100_000));
    assert.ok(at !== null && at.length > 0 && at.every((s) => s.text.length <= SEG));
    assert.equal(segmentSourceText('x'.repeat(100_001)), null);
    assert.equal(segmentSourceText('x'.repeat(200_000)), null);
  });

  check('T-切-8 空/纯空白 → 空数组（service 侧空白拒绝前的防御层）', () => {
    assert.deepEqual(segmentSourceText(''), []);
    assert.deepEqual(segmentSourceText('   \n \t\n  '), []);
  });

  check('T-码-1（规则 5）``` 开头段整段 codeBlock:true——不硬切不发翻，围栏对完整', () => {
    const fence = ['```js', 'const a = 1;', 'console.log(a);', '```'].join('\n');
    const segs = segmentSourceText(`${A}\n\n${fence}`);
    assert.ok(segs !== null && segs.length === 2);
    assert.equal(segs[1]?.codeBlock, true, '围栏段必须 codeBlock:true');
    assert.equal(segs[1]?.text, fence, '围栏段内容逐字保全');
    assert.equal(segs[0]?.codeBlock, false);
  });

  check('T-码-2（规则 5）未闭合围栏防御性同判：``` 开头但至文末无闭合 → 仍 codeBlock:true', () => {
    const unclosed = ['```python', 'def f():', '  return 1'].join('\n');
    const segs = segmentSourceText(`${A}\n\n${unclosed}`);
    assert.ok(segs !== null && segs.length === 2);
    assert.equal(segs[1]?.codeBlock, true, '未闭合围栏防御性视为代码');
  });

  check('T-码-3（规则 5）代码块段不硬切：>1200 字符围栏段保持单段（零送翻无引擎长度风险）', () => {
    const fence = ['```', 'x'.repeat(SEG + 500), '```'].join('\n');
    const segs = segmentSourceText(fence);
    assert.ok(segs !== null && segs.length === 1, `围栏段不得被硬切（实际 ${segs?.length} 段）`);
    assert.equal(segs[0]?.codeBlock, true);
    assert.ok(segs[0] !== undefined && segs[0].text.length > SEG, '超长围栏段整段保留');
  });

  check('T-码-4（规则 5）表格段（markdown 管道行）送翻：codeBlock:false 正常切段', () => {
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    const segs = segmentSourceText(`${A}\n\n${table}`);
    assert.ok(segs !== null);
    assert.ok(segs.some((s) => s.text.includes('| a | b |') && s.codeBlock === false), '表格段送翻（非代码块）');
  });

  check('T-码-5（规则 5）行内代码 span（`foo` 反引号）不特殊处理：codeBlock:false', () => {
    const inline = `运行 \`npm run dev\` 启动 ${A}`;
    const segs = segmentSourceText(inline);
    assert.ok(segs !== null && segs.length === 1);
    assert.equal(segs[0]?.codeBlock === false && segs[0]?.text === inline, true, '行内码段落按普通文本送翻');
  });

  check('T-码-6（规则 5）围栏碎段不并入：围栏尾段（<40）与文本尾段均不跨 codeBlock 边界并入', () => {
    // 围栏段自身短（<40）也不并入前段——codeBlock 段保持独立
    const fence = '```\n```';
    const segs = segmentSourceText(`${A}\n\n${fence}`);
    assert.ok(segs !== null && segs.length === 2, '短围栏段不得并入文本前段');
    assert.equal(segs[1]?.codeBlock, true);
    // 文本尾段（<40）也不并入前面的围栏段
    const segs2 = segmentSourceText(`${fence}\n\n${'乙'.repeat(39)}`);
    assert.ok(segs2 !== null && segs2.length === 2, '文本碎段不得并入围栏段');
    assert.equal(segs2[0]?.codeBlock, true);
    assert.equal(segs2[1]?.codeBlock, false);
  });

  console.log('=== 2) hashSegment：FNV-1a 32 位 hex（置换不动）===');

  check('T-哈-1 确定性：同输入两次哈希相等，输出为 8 位 hex', () => {
    assert.equal(hashSegment(A), hashSegment(A));
    assert.match(hashSegment(A), /^[0-9a-f]{8}$/);
  });

  check('T-哈-2 异文异哈希：不同文本哈希不同（含近似文本与跨语言文本对）', () => {
    assert.notEqual(hashSegment(A), hashSegment(B));
    assert.notEqual(hashSegment('你好'), hashSegment('你们'));
    assert.notEqual(hashSegment('Hello world'), hashSegment('Hello worlds'));
  });

  check("T-哈-3 算法钉：FNV-1a 32 位标准测试向量（空串 → 811c9dc5，a → e40c292c）", () => {
    assert.equal(hashSegment(''), '811c9dc5');
    assert.equal(hashSegment('a'), 'e40c292c');
  });

  // RB-CORE-T-模/T-径 删除留痕（2026-11-22 扩容批次 p6/W5）：原「3) renderTemplateUrl /
  // renderTemplateBody：自定义模板 DSL」（T-模-1..5）与「4) resolveResponsePath」（T-径-1..4）
  // 两组共 9 checks 整组删除——消费面（makeCustomTemplate 适配器 + customTemplates 字段 +
  // ConfigPage 自定义模板编辑区）已随 W5 整链移除，DSL 纯函数失去全部调用方（出卷清单 §6
  // RB 行：契约未钉死导出去留，出卷不越契约，不额外钉「DSL 纯函数必须删」）。

  console.log('=== 5) DEFAULT_TRANSLATION_ENGINES：出厂种子（单一真相源；RB-CORE-T-种 p7/W4 终态五序）===');

  check('RB-CORE-T-种-1 五条种子终态五序：bing-web(0)/alibaba-web(1)/qq-transmart(2)/sogou-web(3)/youdao-web(4)，全 enabled、全 useProxy !== true（全直连零代理依赖；P3-4 直书五元序——google-gtx/baidu-web 死引擎已剔除）', () => {
    assert.equal(DEFAULT_TRANSLATION_ENGINES.length, 5, `出厂种子应为五条（实际 ${DEFAULT_TRANSLATION_ENGINES.length}）`);
    const kinds = DEFAULT_TRANSLATION_ENGINES.map((e) => e.kind);
    assert.deepEqual(kinds, ['bing-web', 'alibaba-web', 'qq-transmart', 'sogou-web', 'youdao-web'], `种子顺序不符：${kinds.join(',')}`);
    const orders = DEFAULT_TRANSLATION_ENGINES.map((e) => e.order);
    assert.deepEqual(orders, [0, 1, 2, 3, 4], `种子 order 不符：${orders.join(',')}`);
    assert.ok(DEFAULT_TRANSLATION_ENGINES.every((e) => e.enabled === true), '出厂五条必须全 enabled（零配置开箱）');
    assert.ok(DEFAULT_TRANSLATION_ENGINES.every((e) => e.useProxy !== true), '出厂种子全直连零代理依赖（google 剔除后无 useProxy 出厂面）');
    const bing = DEFAULT_TRANSLATION_ENGINES[0];
    assert.ok(bing && bing.id === 'seed-bing-web', `bing-web 种子 id 不符：${String(bing?.id)}`);
    const alibaba = DEFAULT_TRANSLATION_ENGINES.find((e) => e.kind === 'alibaba-web');
    assert.ok(alibaba && alibaba.id === 'seed-alibaba-web', `alibaba-web 种子 id 不符：${String(alibaba?.id)}`);
    const qq = DEFAULT_TRANSLATION_ENGINES.find((e) => e.kind === 'qq-transmart');
    assert.ok(qq && qq.id === 'seed-qq-transmart', `qq-transmart 种子 id 不符：${String(qq?.id)}`);
    const sogou = DEFAULT_TRANSLATION_ENGINES.find((e) => e.kind === 'sogou-web');
    assert.ok(sogou && sogou.id === 'seed-sogou-web', `sogou-web 种子 id 不符：${String(sogou?.id)}`);
    const youdao = DEFAULT_TRANSLATION_ENGINES.find((e) => e.kind === 'youdao-web');
    assert.ok(youdao && youdao.id === 'seed-youdao-web', `youdao-web 种子 id 不符：${String(youdao?.id)}`);
  });

  check('RB-CORE-T-种-2 死 kind 不在种子（google-gtx/baidu-web/tencent-tmt/custom-template 全不在）；种子 id 唯一非空；endpoint 缺省（出厂端点在适配器）', () => {
    const deadKinds = ['google-gtx', 'baidu-web', 'tencent-tmt', 'custom-template'];
    for (const e of DEFAULT_TRANSLATION_ENGINES) {
      assert.ok(!deadKinds.includes(e.kind), `死 kind 残留在种子：${e.kind}`);
    }
    const ids = DEFAULT_TRANSLATION_ENGINES.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, '种子 id 必须唯一');
    assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0));
    assert.ok(DEFAULT_TRANSLATION_ENGINES.every((e) => e.endpoint === undefined), '种子条目不带 endpoint（缺省=出厂端点种子）');
  });

  console.log('=== 6) 引擎常量 4 个定值（RB-CORE-T-常-引 p6 改写：tencent 间隔随 W5 整链移除）===');

  check('RB-CORE-T-常-引 五常量终集形态（p7 钉终集）：四定值存续（引擎尝试超时/探测超时/429 冷却/探测文本）+ 死常量删除留痕（TRANSLATION_TENCENT_MIN_INTERVAL_MS 随 p6；google/baidu 端点常量随 p7——模块不再导出、core 源码零残留）', () => {
    assert.equal(TRANSLATION_ENGINE_TRY_TIMEOUT_MS, 10_000);
    assert.equal(TRANSLATION_PROBE_TIMEOUT_MS, 8_000);
    assert.equal(TRANSLATION_ENGINE_429_COOLDOWN_MS, 60_000);
    assert.equal(TRANSLATION_PROBE_TEXT, 'Hello, world. This is a connectivity check.');
    // TRANSLATION_TENCENT_MIN_INTERVAL_MS 删除留痕（W5 p6）：tencent 节流随引擎整链移除，
    // 组内零节流为已知接受态（评审 P2-4）；模块不再导出该键 + core 源码字面零残留。
    assert.ok(!coreSrc.includes('TRANSLATION_TENCENT_MIN_INTERVAL_MS'), 'TRANSLATION_TENCENT_MIN_INTERVAL_MS 源码残留（W5 p6 应删未删）');
    // DEFAULT_GOOGLE_GTX_ENDPOINT / DEFAULT_BAIDU_WEB_ENDPOINT 删除留痕（W4 p7）：
    // google-gtx（用户裁决「谷歌先剔除掉」）与 baidu-web（死引擎）端点常量随引擎整链移除。
    assert.ok(!coreSrc.includes('DEFAULT_GOOGLE_GTX_ENDPOINT'), 'DEFAULT_GOOGLE_GTX_ENDPOINT 源码残留（W4 p7 应删未删）');
    assert.ok(!coreSrc.includes('DEFAULT_BAIDU_WEB_ENDPOINT'), 'DEFAULT_BAIDU_WEB_ENDPOINT 源码残留（W4 p7 应删未删）');
  });

  check('RB-CORE-T-端-1 出厂端点种子终态（p7 改写）：DEFAULT_BING_WEB_DOMAIN 存续（bing 域名口径唯一可配端点）+ 四死端点常量删除留痕（google/baidu W4 p7、youdao W2d、tencent W5 p6——模块不再导出、core 源码零残留）', () => {
    assert.equal(DEFAULT_BING_WEB_DOMAIN, 'cn.bing.com');
    // DEFAULT_GOOGLE_GTX_ENDPOINT 删除留痕（W4 p7）：google-gtx 整链剔除（端点模板消费面随适配器删除）。
    assert.ok(!coreSrc.includes('DEFAULT_GOOGLE_GTX_ENDPOINT'), 'DEFAULT_GOOGLE_GTX_ENDPOINT 源码残留（W4 p7 应删未删）');
    assert.ok(!coreSrc.includes('translate.googleapis.com'), 'google 端点字面在 core 源码残留（W4 p7 应删未删）');
    // DEFAULT_BAIDU_WEB_ENDPOINT 删除留痕（W4 p7）：baidu-web 死引擎清理（v2transapi 端点随适配器删除）。
    assert.ok(!coreSrc.includes('DEFAULT_BAIDU_WEB_ENDPOINT'), 'DEFAULT_BAIDU_WEB_ENDPOINT 源码残留（W4 p7 应删未删）');
    assert.ok(!coreSrc.includes('v2transapi'), 'baidu 端点字面在 core 源码残留（W4 p7 应删未删）');
    // DEFAULT_YOUDAO_WEB_ENDPOINT 删除留痕（W2d p5）：V1 translate_o 端点常量随 V2 重写删除。
    assert.ok(!coreSrc.includes('DEFAULT_YOUDAO_WEB_ENDPOINT'), 'DEFAULT_YOUDAO_WEB_ENDPOINT 源码残留（W2d 应删未删）');
    assert.ok(!coreSrc.includes('translate_o'), 'translate_o V1 端点字面在 core 源码残留');
    // DEFAULT_TENCENT_TMT_ENDPOINT 删除留痕（W5 p6）：tencent 端点常量随引擎整链移除
    assert.ok(!coreSrc.includes('DEFAULT_TENCENT_TMT_ENDPOINT'), 'DEFAULT_TENCENT_TMT_ENDPOINT 源码残留（W5 p6 应删未删）');
    assert.ok(!coreSrc.includes('tmt.tencentcloudapi.com'), 'tencent 端点字面在 core 源码残留（W5 p6 应删未删）');
  });

  check('T-常-1 既有 9 常量定值不变（上限/切段/缓存/并发/超时/字节/节流——置换不动面）', () => {
    assert.equal(TRANSLATION_MAX_SOURCE_CHARS, 100_000);
    assert.equal(TRANSLATION_SEGMENT_MAX_CHARS, 1_200);
    assert.equal(TRANSLATION_MIN_TAIL_CHARS, 40);
    assert.equal(TRANSLATION_MAX_SEGMENTS, 400);
    assert.equal(TRANSLATION_CACHE_MAX_SEGMENTS, 2_000);
    assert.equal(TRANSLATION_CONCURRENCY, 2);
    assert.equal(TRANSLATION_SEGMENT_TIMEOUT_MS, 60_000);
    assert.equal(TRANSLATION_RESPONSE_MAX_BYTES, 4 * 1024 * 1024);
    assert.equal(TRANSLATION_PUSH_THROTTLE_MS, 80);
  });

  console.log('=== 7) sanitizeTranslationConfig：读路径清洗纪律（§5.2.2）===');

  check('T-净-1 合法种子透传：sanitize(DEFAULT) 形态等价（不重排不丢弃不改值）+ 产物零 customTemplates 键（p6/W5 字段删除后不得再产出）', () => {
    const clean = sanitizeTranslationConfig({ engines: DEFAULT_TRANSLATION_ENGINES });
    assert.equal(clean.engines.length, DEFAULT_TRANSLATION_ENGINES.length);
    assert.deepEqual(clean.engines.map((e) => [e.kind, e.order, e.enabled, e.useProxy]),
      DEFAULT_TRANSLATION_ENGINES.map((e) => [e.kind, e.order, e.enabled, e.useProxy]));
    assert.ok(!('customTemplates' in clean), '产物残留 customTemplates 键（W5 p6 字段已删，不得产出）');
  });

  check('T-净-2（RB-CORE-T-净-2 p7 re-base）kind 白名单外丢弃；缺键读出五种子（旧配置零迁移不报错）；alibaba-web/qq-transmart/sogou-web 白名单透传（p7/W4 起种子补齐面同场——用户自定义 id 条目保全 + 缺席规范种子补齐，T-迁-3/4 承载行为钉）', () => {
    const dirty = sanitizeTranslationConfig({
      engines: [...DEFAULT_TRANSLATION_ENGINES, { id: 'x1', kind: 'chatgpt-free', enabled: true, order: 9 }],
    });
    assert.equal(dirty.engines.length, 5, '白名单外 kind 必须整条丢弃');
    const missing = sanitizeTranslationConfig(undefined);
    assert.equal(missing.engines.length, 5, '缺 translation 键 → 种子兜底');
    assert.deepEqual(missing.engines.map((e) => e.kind), ['bing-web', 'alibaba-web', 'qq-transmart', 'sogou-web', 'youdao-web']);
    assert.ok(!('customTemplates' in missing), '种子兜底产物残留 customTemplates 键（W5 p6 应无）');
    // alibaba-web 白名单透传面：用户自定义 id 条目在册不丢弃（id 字段不改写；补齐面见 T-迁-3/4）
    const withAlibaba = sanitizeTranslationConfig({
      engines: [{ id: 'my-alibaba', kind: 'alibaba-web', enabled: true, order: 0 }],
    });
    const myAlibaba = withAlibaba.engines.find((e) => e.id === 'my-alibaba');
    assert.ok(myAlibaba && myAlibaba.kind === 'alibaba-web' && myAlibaba.order === 0, 'alibaba-web 条目被白名单误丢/字段被改写');
    // qq-transmart 白名单透传面（p3 同族新面）
    const withQq = sanitizeTranslationConfig({
      engines: [{ id: 'my-qq', kind: 'qq-transmart', enabled: true, order: 0 }],
    });
    assert.ok(withQq.engines.find((e) => e.id === 'my-qq'), 'qq-transmart 条目被白名单误丢（新 kind 未入白名单）');
    // sogou-web 白名单透传面（p4 同族新面）
    const withSogou = sanitizeTranslationConfig({
      engines: [{ id: 'my-sogou', kind: 'sogou-web', enabled: true, order: 0 }],
    });
    assert.ok(withSogou.engines.find((e) => e.id === 'my-sogou'), 'sogou-web 条目被白名单误丢（新 kind 未入白名单）');
  });

  check('T-净-3（RB-CORE-T-净-3 p7 re-base·载体换规范种子 id）enabled 非 boolean → true；order 非有限整数 → 按数组序重排赋值（规范种子 id 在场 → 补齐面不触发，补齐行为钉隔离在 T-迁-3/4）', () => {
    const dirty = sanitizeTranslationConfig({
      engines: [
        { id: 'seed-bing-web', kind: 'bing-web', enabled: 'yes', order: 'first' },
        { id: 'seed-alibaba-web', kind: 'alibaba-web', enabled: true, order: 1.5 },
        { id: 'seed-qq-transmart', kind: 'qq-transmart', enabled: true, order: 2 },
        { id: 'seed-sogou-web', kind: 'sogou-web', enabled: true, order: 3 },
        { id: 'seed-youdao-web', kind: 'youdao-web', enabled: true, order: 4 },
      ],
    });
    assert.equal(dirty.engines.length, 5);
    assert.equal(dirty.engines[0]?.enabled, true, 'enabled 非 boolean 兜底 true');
    assert.equal(dirty.engines[1]?.enabled, true);
    assert.deepEqual(dirty.engines.map((e) => e.order), [0, 1, 2, 3, 4], 'order 非有限整数按数组序重排');
  });

  check('T-迁-5（原 T-净-4 改写·p6/W5 剔除语义）存量 customTemplates 数组 + custom-template/tencent-tmt 越集条目 → sanitize 静默剔除：条目消失、customTemplates/templateName 键不复产出、其余引擎保全、零报错', () => {
    const clean = sanitizeTranslationConfig({
      engines: [
        { id: 'keep-bing', kind: 'bing-web', enabled: true, order: 0 },
        { id: 'c1', kind: 'custom-template', enabled: true, order: 1, templateName: 'mock' },
        { id: 'c2', kind: 'custom-template', enabled: true, order: 2, templateName: 'ghost' },
        { id: 'tc1', kind: 'tencent-tmt', enabled: true, order: 3 },
      ],
      customTemplates: [
        { name: 'mock', method: 'GET', urlTemplate: 'http://127.0.0.1:9/t?q={text}&to={target}', responsePath: 'data.text' },
        { name: 'bad-text', method: 'GET', urlTemplate: 'http://127.0.0.1:9/t?q={source}', responsePath: 'data.text' },
      ],
    });
    assert.ok(!('customTemplates' in clean), 'customTemplates 键未随字段删除消失（W5 p6 应静默剔除）');
    // p7/W4 起 sanitize 增规范种子补齐——keep-bing 保全断言改为包含式（合法条目恰一次、越集全剔）；
    // 补齐追加的规范种子为 T-迁-3/4 行为面，此处不断言其形态。
    const keepBing = clean.engines.filter((e) => e.id === 'keep-bing');
    assert.equal(keepBing.length, 1, '越集 kind 条目未被白名单剔除 / 其余引擎被误伤或重复');
    for (const dead of ['c1', 'c2', 'tc1']) {
      assert.ok(!clean.engines.some((e) => e.id === dead), `越集条目未剔除：${dead}`);
    }
    assert.ok(keepBing[0] && !('templateName' in keepBing[0]), '在册条目产出 templateName 键（模板引用链已删）');
    // 越集条目混入合法条目之间时剔除不丢合法项（序保持）
    const mixed = sanitizeTranslationConfig({
      engines: [
        { id: 'tc2', kind: 'tencent-tmt', enabled: true, order: 0 },
        { id: 'keep-bing2', kind: 'bing-web', enabled: true, order: 1 },
        { id: 'c3', kind: 'custom-template', enabled: true, order: 2, templateName: 'mock' },
      ],
    });
    assert.equal(mixed.engines.filter((e) => e.id === 'keep-bing2').length, 1, '越集条目剔除后合法条目保全失败');
    for (const dead of ['tc2', 'c3']) {
      assert.ok(!mixed.engines.some((e) => e.id === dead), `越集条目未剔除：${dead}`);
    }
  });

  // ── W4 配置迁移组（2026-11-22 扩容批次 p7 新增；出卷清单 §7.1）──
  console.log('=== 7b) sanitizeTranslationConfig：W4 配置迁移组（死种子剔除 / 规范种子补齐 / endpoint 剥离）===');

  check('T-迁-1 kind 白名单终态五：四死 kind（baidu-web/google-gtx/tencent-tmt/custom-template）条目整条剔除、五活 kind（bing-web/alibaba-web/qq-transmart/sogou-web/youdao-web）全透传（活条目用规范种子 id 承载——补齐面与白名单面隔离，补齐行为钉在 T-迁-3/4）', () => {
    const clean = sanitizeTranslationConfig({
      engines: [
        { id: 'd1', kind: 'baidu-web', enabled: true, order: 0 },
        { id: 'd2', kind: 'google-gtx', enabled: true, order: 1 },
        { id: 'd3', kind: 'tencent-tmt', enabled: true, order: 2 },
        { id: 'd4', kind: 'custom-template', enabled: true, order: 3 },
        { id: 'seed-bing-web', kind: 'bing-web', enabled: true, order: 4 },
        { id: 'seed-alibaba-web', kind: 'alibaba-web', enabled: true, order: 5 },
        { id: 'seed-qq-transmart', kind: 'qq-transmart', enabled: true, order: 6 },
        { id: 'seed-sogou-web', kind: 'sogou-web', enabled: true, order: 7 },
        { id: 'seed-youdao-web', kind: 'youdao-web', enabled: true, order: 8 },
      ],
    });
    const kinds = clean.engines.map((e) => e.kind);
    assert.deepEqual(kinds, ['bing-web', 'alibaba-web', 'qq-transmart', 'sogou-web', 'youdao-web'], `白名单终态不符：${kinds.join(',')}`);
    for (const dead of ['d1', 'd2', 'd3', 'd4']) {
      assert.ok(!clean.engines.some((e) => e.id === dead), `死 kind 条目未剔除：${dead}`);
    }
    assert.deepEqual(clean.engines.map((e) => e.id), ['seed-bing-web', 'seed-alibaba-web', 'seed-qq-transmart', 'seed-sogou-web', 'seed-youdao-web'], '五活 kind 透传丢条目');
  });

  check('T-迁-2 seed id 剔除不误伤：seed-google-gtx/seed-baidu-web 条目剔除、seed-youdao-web 保留（V2 重写后协议）、用户自定义 id 条目（活 kind）不受影响', () => {
    const clean = sanitizeTranslationConfig({
      engines: [
        { id: 'seed-google-gtx', kind: 'google-gtx', enabled: true, order: 0 },
        { id: 'seed-baidu-web', kind: 'baidu-web', enabled: true, order: 3 },
        { id: 'seed-youdao-web', kind: 'youdao-web', enabled: true, order: 2 },
        { id: 'user-custom', kind: 'bing-web', enabled: true, order: 9 },
      ],
    });
    assert.ok(!clean.engines.some((e) => e.id === 'seed-google-gtx'), 'seed-google-gtx 未剔除（W4 清理面）');
    assert.ok(!clean.engines.some((e) => e.id === 'seed-baidu-web'), 'seed-baidu-web 未剔除（W4 清理面）');
    assert.ok(clean.engines.some((e) => e.id === 'seed-youdao-web'), 'seed-youdao-web 被误剔（W2d V2 重写后保留）');
    const custom = clean.engines.find((e) => e.id === 'user-custom');
    assert.ok(custom && custom.kind === 'bing-web' && custom.enabled === true && custom.order === 9, '用户自定义 id 条目被误伤');
  });

  check('T-迁-3（P1-6 读法 B 钉）存量 google/bing/youdao/baidu 四种子经一次 sanitize 读路径归一恰五引擎：剔除二死种子、bing(1)/youdao(2) 原值保留、alibaba/qq/sogou 补齐 order=3/4/5 递增殿后 → 终序 [bing,youdao,alibaba,qq,sogou] 单调无撞号（与出厂序 [bing,alibaba,qq,sogou,youdao] 是两条不同断言）', () => {
    const legacy = sanitizeTranslationConfig({
      engines: [
        { id: 'seed-google-gtx', kind: 'google-gtx', enabled: true, order: 0 },
        { id: 'seed-bing-web', kind: 'bing-web', enabled: true, order: 1 },
        { id: 'seed-youdao-web', kind: 'youdao-web', enabled: true, order: 2 },
        { id: 'seed-baidu-web', kind: 'baidu-web', enabled: true, order: 3 },
      ],
    });
    assert.equal(legacy.engines.length, 5, `归一后恰五引擎（实际 ${legacy.engines.length}）`);
    assert.ok(!legacy.engines.some((e) => e.id === 'seed-google-gtx'), 'seed-google-gtx 残留');
    assert.ok(!legacy.engines.some((e) => e.id === 'seed-baidu-web'), 'seed-baidu-web 残留');
    const bing = legacy.engines.find((e) => e.id === 'seed-bing-web');
    const youdao = legacy.engines.find((e) => e.id === 'seed-youdao-web');
    assert.ok(bing && bing.order === 1 && bing.enabled === true, `在场条目 order/启停被补齐覆盖：bing.order=${String(bing?.order)}`);
    assert.ok(youdao && youdao.order === 2 && youdao.enabled === true, `在场条目 order/启停被补齐覆盖：youdao.order=${String(youdao?.order)}`);
    const alibaba = legacy.engines.find((e) => e.id === 'seed-alibaba-web');
    const qq = legacy.engines.find((e) => e.id === 'seed-qq-transmart');
    const sogou = legacy.engines.find((e) => e.id === 'seed-sogou-web');
    assert.ok(alibaba && alibaba.order === 3, `补齐 alibaba order ≠ 3（在场最大+1 递增殿后）：${String(alibaba?.order)}`);
    assert.ok(qq && qq.order === 4, `补齐 qq order ≠ 4：${String(qq?.order)}`);
    assert.ok(sogou && sogou.order === 5, `补齐 sogou order ≠ 5：${String(sogou?.order)}`);
    // 终序（按 order 升序读回）= [bing, youdao, alibaba, qq, sogou]，order 单调无撞号。
    const sorted = [...legacy.engines].sort((a, b) => a.order - b.order);
    assert.deepEqual(sorted.map((e) => e.kind), ['bing-web', 'youdao-web', 'alibaba-web', 'qq-transmart', 'sogou-web'], `补齐终序不符：${sorted.map((e) => `${e.kind}(${e.order})`).join(',')}`);
    const orders = sorted.map((e) => e.order);
    assert.equal(new Set(orders).size, orders.length, 'order 撞号');
    for (let i = 1; i < orders.length; i++) {
      assert.ok((orders[i] as number) > (orders[i - 1] as number), 'order 非单调递增');
    }
  });

  check('T-迁-4 补齐不覆盖在场条目：enabled:false 的在场规范种子启停/order 原样保留、完全缺席的种子照常补齐（缺 id 才补）', () => {
    const clean = sanitizeTranslationConfig({
      engines: [
        { id: 'seed-bing-web', kind: 'bing-web', enabled: false, order: 7 },
        { id: 'seed-alibaba-web', kind: 'alibaba-web', enabled: true, order: 5 },
      ],
    });
    const bing = clean.engines.find((e) => e.id === 'seed-bing-web');
    const alibaba = clean.engines.find((e) => e.id === 'seed-alibaba-web');
    assert.ok(bing && bing.enabled === false && bing.order === 7, '用户显式禁用的在场种子被补齐覆盖');
    assert.ok(alibaba && alibaba.order === 5, '在场条目 order 被补齐重写');
    // 缺 id 才补：qq/sogou/youdao 三种子缺席 → 补齐 order=在场最大(7)+1 递增。
    for (const [id, expect] of [['seed-qq-transmart', 8], ['seed-sogou-web', 9], ['seed-youdao-web', 10]] as const) {
      const e = clean.engines.find((x) => x.id === id);
      assert.ok(e && e.order === expect, `缺席种子 ${id} 未按在场最大+1 递增补齐（期望 order=${expect}）：${String(e?.order)}`);
    }
    assert.equal(clean.engines.length, 5, '补齐后恰五条');
  });

  check('T-迁-6（P1-5）endpoint 剥离：alibaba/qq/sogou/youdao 四 kind 的 endpoint 一律剥离（含存量 youdao V1 脏值）、bing-web endpoint 保留（endpoint 输入收窄 bing-web 一行的数据面）', () => {
    const clean = sanitizeTranslationConfig({
      engines: [
        { id: 'seed-bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: 'mirror.bing.example' },
        { id: 'a', kind: 'alibaba-web', enabled: true, order: 1, endpoint: 'https://alibaba.dirty.example/api' },
        { id: 'q', kind: 'qq-transmart', enabled: true, order: 2, endpoint: 'https://qq.dirty.example/api/imt' },
        { id: 's', kind: 'sogou-web', enabled: true, order: 3, endpoint: 'https://sogou.dirty.example/api' },
        { id: 'y', kind: 'youdao-web', enabled: true, order: 4, endpoint: 'https://fanyi.youdao.com/translate_o?client=desktop&oldsign=1' },
      ],
    });
    const bing = clean.engines.find((e) => e.id === 'seed-bing-web');
    assert.ok(bing && bing.endpoint === 'mirror.bing.example', `bing-web endpoint 被误剥（唯一可配端点面）：${String(bing?.endpoint)}`);
    for (const id of ['a', 'q', 's', 'y']) {
      const e = clean.engines.find((x) => x.id === id);
      assert.ok(e && !('endpoint' in e), `${id} endpoint 未剥离（该 kind 不消费 endpoint，存量脏值必须清）`);
    }
    // 空/纯空白 endpoint 对 bing-web 的既有兜底不变（trim 空值不产出键）。
    const blank = sanitizeTranslationConfig({
      engines: [{ id: 'seed-bing-web', kind: 'bing-web', enabled: true, order: 0, endpoint: '   ' }],
    });
    assert.ok(blank.engines[0] && !('endpoint' in (blank.engines[0] as object)), '纯空白 endpoint 不得产出键（既有兜底回退）');
  });

  // RB-CORE-T-净-5（P1B-T9 翻转，2026-11-22 扩容批次 p8/W4 P1-B 代理面回撤 + 出卷清单 T-迁-7）：
  // translation.proxyUrl 字段已删——存量键（任意值型）一律剥离。它存在的唯一理由是 google
  // （google 已剔除）；useProxy 透传保留（评审 P3-7：无出厂/UI 入口消费者，机械保留原样）。
  check('T-净-5（T-迁-7 翻转面）proxyUrl 存量键任意值型一律剥离：合法串/trim 形态/非法串 → 读回无键', () => {
    const clean = sanitizeTranslationConfig({
      engines: DEFAULT_TRANSLATION_ENGINES,
      proxyUrl: '  http://127.0.0.1:7890  ',
    });
    assert.ok(!('proxyUrl' in clean), 'proxyUrl 合法值未被剥离（字段已删，存量键必须清）');
    const dirty = sanitizeTranslationConfig({
      engines: DEFAULT_TRANSLATION_ENGINES,
      proxyUrl: 'not a url',
    });
    assert.ok(!('proxyUrl' in dirty), 'proxyUrl 非法串未被剥离（任意值型一律剥）');
    const legacy = sanitizeTranslationConfig({
      engines: DEFAULT_TRANSLATION_ENGINES,
      proxyUrl: 'http://127.0.0.1:7890',
    });
    assert.ok(!('proxyUrl' in legacy), 'proxyUrl 存量值未被剥离（T-迁-7 本体）');
    assert.deepEqual(Object.keys(legacy).sort(), ['engines'], '剥离后 translation 节应仅剩 engines 键');
  });

  check('T-净-6（P1B-T9 翻转面）proxyUrl 缺省/空/纯空白/非字符串 → 键缺席（剥离形态与缺省形态一致）', () => {
    const noKey = sanitizeTranslationConfig({ engines: DEFAULT_TRANSLATION_ENGINES });
    assert.ok(!('proxyUrl' in noKey), '旧配置无 proxyUrl 字段时不得产出该键（缺省读出缺省形态）');
    const seed = sanitizeTranslationConfig(undefined);
    assert.ok(!('proxyUrl' in seed), '缺 translation 键读出种子形态不得带 proxyUrl 键');
    assert.ok(!('proxyUrl' in sanitizeTranslationConfig({ engines: DEFAULT_TRANSLATION_ENGINES, proxyUrl: '' })), '空串 = 未配置（键剔除）');
    assert.ok(!('proxyUrl' in sanitizeTranslationConfig({ engines: DEFAULT_TRANSLATION_ENGINES, proxyUrl: '   ' })), '纯空白 = 未配置（键剔除）');
    assert.ok(!('proxyUrl' in sanitizeTranslationConfig({ engines: DEFAULT_TRANSLATION_ENGINES, proxyUrl: 123 })), '非字符串（数字）不得产出键');
    assert.ok(!('proxyUrl' in sanitizeTranslationConfig({ engines: DEFAULT_TRANSLATION_ENGINES, proxyUrl: { bad: 1 } })), '非字符串（对象）不得产出键');
  });

  console.log('=== 8) 纯函数模块形态 ===');

  check('T-形-1 纯函数模块形态：零 electron/主进程依赖（shared 三端共用先例 topic-analyzer-core）', () => {
    assert.ok(!/from\s+'(electron|(\.\.\/)+main)/.test(coreSrc), 'translation-core.ts 不得依赖 electron 或主进程模块');
    assert.match(coreSrc, /先例.*topic-analyzer-core|topic-analyzer-core.*先例/, '头注释须注明先例 shared/topic-analyzer-core.ts 纯函数三端共用');
  });

  check('T-形-2 LLM 形态残留清零：SSE 三函数与 system 提示词不得存在于置换后的 core', () => {
    for (const dead of ['buildTranslationRequestBody', 'extractTranslationDelta', 'isTranslationStreamEnd', 'TRANSLATION_SYSTEM_PROMPT']) {
      assert.ok(!coreSrc.includes(dead), `置换残留：translation-core.ts 仍含 ${dead}`);
    }
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
