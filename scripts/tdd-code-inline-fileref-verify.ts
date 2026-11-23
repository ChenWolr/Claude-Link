// tdd-code-inline-fileref-verify.ts
// 计划 docs/plans/2026-11-06-file-linkify-entry-plan.md §5 A1/A2/A4 组契约脚本（2026-11-06）。
// A5a 测试先行点（RED 留痕）：新行为断言在 A1/A2/A4 实现落盘前先红（预期 RED、退出码非 0），
// 正对照/守卫断言保持绿，防恒真断言与现状误钉；实现落盘后本脚本须全绿（计划 §7 闸门）。
//
// 组清单（计划 §5 对齐）：
//   A1-1  生产回合注入块形态钉：buildSdkOptions 内 options.systemPrompt = { type:'preset',
//         preset:'claude_code', append:FILE_REF_SYSTEM_PROMPT_APPEND }，位置在 buildNativeSdkOptionsCore
//         调用之后、options.includePartialMessages 之前（结构钉，红：A1 未实施）
//   A1-2  注入为追加形态：append 键而非整体替换，无基线覆盖/删除语义（结构钉，红）
//   A1-3  探针/诊断请求路径不带引导（正对照，绿）：函数级 buildPostTurnProbeArgs 零引导字面 +
//         函数级 buildNativeSdkOptionsCore 输出不含 systemPrompt 键 + 源码钉 sdk-command-options.ts
//         无 systemPrompt 字样
//   A1-4  引导常量本体存在且两类指引齐全（文件引用 + web URL；函数级动态 import 探测，红：常量未存在）
//   A1-5a 重复构建一致性（函数级，绿）：buildNativeSdkOptionsCore / buildPostTurnProbeArgs 连续两次
//         构建结果 deepStrictEqual 且无一次性 systemPrompt 状态
//   A1-5b 常量为模块级不可变导出（export const …: string）、注入处无一次性可变状态（结构钉，红）
//   A1-6  探针构建相关源码段（post-turn-probe.ts 全文）零命中引导字面（结构钉，正对照，绿）
//   A2 结构钉（红：A2 未实施）：markdown.ts code_inline 覆盖 / resolveCodeInlinePath 接线 /
//         链接内 code_inline 跳过机制 / file-link.ts 三导出 / 产出形态与 link_open 按钮化同形
//   A4 结构钉（红：A4 未实施）：link_open 覆盖 --dead 死链分支 + isPathLikeRelativeHref 接线 +
//         FilePreviewDrawer.vue load() 「无法定位文件」预检字面
//   selftest 清单登记钉
//
// 申报：A1-1/A1-2/A1-5b 以源码结构钉承接 buildSdkOptions——buildSdkOptions 为模块私有未导出
// （sdk-backend.ts:1212）且需 BrowserWindow/SessionEntry 实参，函数级直测须改 src、与测试先行点
// src 零改动纪律冲突，故按指令以源码结构钉承接（tsx 下 import 本身可行，审查域与编排器双实测
// IMPORT_OK）；sdk-command-options.ts 与 post-turn-probe.ts 为纯函数模块，函数级直测先行落地。
// 行为级 A2 断言（renderMarkdown 反引号路径链接化）落 scripts/tdd-file-preview-verify.ts ⑰ 扩充节。
//
// 运行：npx tsx scripts/tdd-code-inline-fileref-verify.ts
// （tsx 动态 import 对 CJS 转译产物的命名空间命名导出不可见，取 `.default ?? namespace` 兜底——
//   A1-4 探测未来常量即用此形态；静态 import 未存在导出会报 TS2305 破坏本点类型闸门，故不用。）

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import {
  buildNativeSdkOptionsCore,
  type NativeSdkOptionsCoreInput,
} from '../src/main/modules/sdk-command-options';
import { buildPostTurnProbeArgs } from '../src/shared/post-turn-probe';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

const backendSrc = readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');
const cmdOptsSrc = readFileSync(new URL('../src/main/modules/sdk-command-options.ts', import.meta.url), 'utf8');
const probeSrc = readFileSync(new URL('../src/shared/post-turn-probe.ts', import.meta.url), 'utf8');
const markdownSrc = readFileSync(new URL('../src/renderer/utils/markdown.ts', import.meta.url), 'utf8');
const fileLinkSrc = readFileSync(new URL('../src/renderer/utils/file-link.ts', import.meta.url), 'utf8');
const drawerSrc = readFileSync(new URL('../src/renderer/components/preview/FilePreviewDrawer.vue', import.meta.url), 'utf8');

const GUIDE_HEADING = 'File references (claude-link)';
const GUIDE_BULLET = 'Markdown links';

/** 切片函数体：起点 marker 至下一个行首 `}`（wizard 验证脚本同款手法；被切函数体内层闭合均缩进）。 */
function functionBodyOf(src: string, marker: string, label: string): string {
  const idx = src.indexOf(marker);
  assert.ok(idx > -1, `缺 ${label}`);
  const end = src.indexOf('\n}', idx);
  assert.ok(end > idx, `${label} 函数体切片失败`);
  return src.slice(idx, end);
}

function buildSdkOptionsBody(): string {
  return functionBodyOf(backendSrc, 'function buildSdkOptions(', 'buildSdkOptions');
}

/** code_inline 覆盖体切片：`md.renderer.rules.code_inline =` 起至行首 `};`。 */
function codeInlineRuleBody(): string {
  const idx = markdownSrc.indexOf('md.renderer.rules.code_inline =');
  assert.ok(idx > -1, 'markdown.ts 未覆盖 md.renderer.rules.code_inline（A2 未实施）');
  const end = markdownSrc.indexOf('\n};', idx);
  assert.ok(end > idx, 'code_inline 覆盖体切片失败');
  return markdownSrc.slice(idx, end);
}

/** link_open 覆盖体切片（文件级 md 单例覆盖；applyExternalLinkTarget 走 instance.* 不在此列）。 */
function linkOpenRuleBody(): string {
  const idx = markdownSrc.indexOf('md.renderer.rules.link_open =');
  assert.ok(idx > -1, 'markdown.ts 未找到文件级 md.renderer.rules.link_open 覆盖');
  const end = markdownSrc.indexOf('\n};', idx);
  assert.ok(end > idx, 'link_open 覆盖体切片失败');
  return markdownSrc.slice(idx, end);
}

/** 查 markdown.ts 内顶层助手函数体（function <name>( 或 const <name> =）；不存在返回 null。 */
function helperBody(name: string): string | null {
  const fnIdx = markdownSrc.indexOf(`function ${name}(`);
  if (fnIdx > -1) {
    const end = markdownSrc.indexOf('\n}', fnIdx);
    return end > fnIdx ? markdownSrc.slice(fnIdx, end) : null;
  }
  const constIdx = markdownSrc.indexOf(`const ${name} =`);
  if (constIdx > -1) {
    const end = markdownSrc.indexOf('\n};', constIdx);
    return end > constIdx ? markdownSrc.slice(constIdx, end) : null;
  }
  return null;
}

function drawerLoadBody(): string {
  return functionBodyOf(drawerSrc, 'async function load(', 'FilePreviewDrawer.vue load()');
}

void (async (): Promise<void> => {
  // 动态 import 提升至顶（模块 tsx 下可干净导入，已实测；CJS 转译命名空间命名导出不可见，
  // 取 `.default ?? namespace` 兜底）。A1-4 经此探测未来常量：未存在时取值 undefined → 该 check 红，
  // 不影响其余 check 运行（静态 import 未存在导出会报 TS2305，破坏本点类型闸门，故不用）。
  const cmdOptsNs = (await import('../src/main/modules/sdk-command-options')) as unknown as Record<string, unknown>;
  const cmdOptsModule = (cmdOptsNs.default ?? cmdOptsNs) as Record<string, unknown>;

  console.log('\n=== A1 组：生产回合文件引用引导注入（计划 §4-A1；A1 未实施前预期红） ===');

  check('A1-1 生产回合注入块形态钉：buildSdkOptions 内 systemPrompt={type:preset,preset:claude_code,append:常量}，位置在 core 调用后、includePartialMessages 前', () => {
    const body = buildSdkOptionsBody();
    const coreCallIdx = body.indexOf('buildNativeSdkOptionsCore({');
    const includeIdx = body.indexOf('options.includePartialMessages = true');
    assert.ok(coreCallIdx > -1, '缺 buildNativeSdkOptionsCore 调用锚（切片漂移）');
    assert.ok(includeIdx > -1, '缺 options.includePartialMessages 锚（切片漂移）');
    const injectIdx = body.indexOf('options.systemPrompt = {');
    assert.ok(injectIdx > -1, '缺注入块 options.systemPrompt = {（A1 未实施——预期 RED）');
    assert.ok(injectIdx > coreCallIdx, '注入块须在 buildNativeSdkOptionsCore 调用之后');
    assert.ok(injectIdx < includeIdx, '注入块须在 options.includePartialMessages 之前');
    assert.ok(body.includes('append: FILE_REF_SYSTEM_PROMPT_APPEND'), '注入块缺 append: FILE_REF_SYSTEM_PROMPT_APPEND');
  });

  check('A1-2 注入为追加形态：块内 type:preset + preset:claude_code + append 键；无基线覆盖/删除语义', () => {
    const body = buildSdkOptionsBody();
    const injectIdx = body.indexOf('options.systemPrompt = {');
    assert.ok(injectIdx > -1, '缺注入块（A1 未实施——预期 RED）');
    const includeIdx = body.indexOf('options.includePartialMessages = true', injectIdx);
    const block = includeIdx > injectIdx ? body.slice(injectIdx, includeIdx) : body.slice(injectIdx);
    assert.ok(block.includes("type: 'preset'"), "注入块缺 type: 'preset'（preset 追加语义）");
    assert.ok(block.includes("preset: 'claude_code'"), "注入块缺 preset: 'claude_code'（默认基线不得改动）");
    assert.ok(/append:\s*FILE_REF_SYSTEM_PROMPT_APPEND/.test(block), '注入块缺 append 键（须追加而非替换基线）');
    assert.ok(!/systemPrompt\s*=\s*['"`]/.test(block), '注入块不得为字符串整体替换形态（破坏 append 语义）');
    assert.ok(!/delete\s+/.test(block), '注入块不得含 delete 基线语义');
  });

  check('A1-3 探针/诊断请求路径不带引导（正对照）：buildPostTurnProbeArgs 输出零引导字面', () => {
    const args = buildPostTurnProbeArgs('a1-3-contract-session');
    assert.ok(args.includes('--resume') && args.includes('a1-3-contract-session'), '探针 args 构造应真实产出（--resume + 会话 id）');
    const joined = args.join('\u0000');
    assert.ok(!joined.includes(GUIDE_HEADING), '探针 args 不得含引导标题字面');
    assert.ok(!joined.includes(GUIDE_BULLET), '探针 args 不得含指引字面');
    assert.ok(!joined.includes('FILE_REF_SYSTEM_PROMPT_APPEND'), '探针 args 不得含引导常量名');
  });

  check('A1-3 结构钉（正对照）：buildNativeSdkOptionsCore 输出不含 systemPrompt 键 + 源码零 systemPrompt 字样', () => {
    const out = buildNativeSdkOptionsCore({ env: { TEST_ENV: '1' } });
    assert.ok(!('systemPrompt' in out), 'buildNativeSdkOptionsCore 输出不得含 systemPrompt 键（probe 共用函数不得带入引导）');
    assert.ok(!cmdOptsSrc.includes('systemPrompt'), 'sdk-command-options.ts 源码不得出现 systemPrompt 字样');
  });

  check('A1-4 引导常量本体存在且两类指引齐全（文件引用 + web URL）', () => {
    const appendValue: unknown = cmdOptsModule.FILE_REF_SYSTEM_PROMPT_APPEND;
    assert.ok(
      typeof appendValue === 'string' && appendValue.length > 0,
      'sdk-command-options.ts 缺导出常量 FILE_REF_SYSTEM_PROMPT_APPEND（A1 未实施——预期 RED）',
    );
    const appendText = appendValue as string;
    assert.ok(appendText.includes(`### ${GUIDE_HEADING}`), '引导缺「文件引用」标题字面');
    assert.ok(appendText.includes(GUIDE_BULLET), '引导缺 Markdown links 形态指引');
    assert.ok(/local files/i.test(appendText), '引导缺「本地文件」指引字面（file 类）');
    assert.ok(/web URL/i.test(appendText), '引导缺「web URL」指引字面');
  });

  check('A1-5a 重复构建一致性（函数级）：buildNativeSdkOptionsCore / buildPostTurnProbeArgs 连续两次构建 deepStrictEqual 且无一次性 systemPrompt 状态', () => {
    const coreInput: NativeSdkOptionsCoreInput = { env: { K: 'v' }, cwd: 'D:\\tmp-ws-repeat-build', maxTurns: 3 };
    const first = buildNativeSdkOptionsCore(coreInput);
    const second = buildNativeSdkOptionsCore(coreInput);
    assert.deepStrictEqual(first, second, '连续两次 core 构建结果应一致（无一次性状态）');
    assert.ok(!('systemPrompt' in first), '重复构建不得引入一次性 systemPrompt 状态（现状钉）');
    const probeFirst = buildPostTurnProbeArgs('a1-5-contract-session');
    const probeSecond = buildPostTurnProbeArgs('a1-5-contract-session');
    assert.deepStrictEqual(probeFirst, probeSecond, '连续两次探针 args 构建结果应一致（无一次性状态）');
  });

  check('A1-5b 结构钉：引导常量为模块级不可变导出（export const …: string）、注入处无一次性可变状态', () => {
    assert.match(cmdOptsSrc, /export const FILE_REF_SYSTEM_PROMPT_APPEND: string/, '常量须为模块级 export const …: string（A1 未实施——预期 RED）');
    const body = buildSdkOptionsBody();
    const injectIdx = body.indexOf('options.systemPrompt = {');
    assert.ok(injectIdx > -1, '缺注入块（A1 未实施——预期 RED）');
    const includeIdx = body.indexOf('options.includePartialMessages = true', injectIdx);
    const block = includeIdx > injectIdx ? body.slice(injectIdx, includeIdx) : body.slice(injectIdx);
    assert.ok(!/let\s|\.push\(|\.set\(|cache/i.test(block), '注入块不得含一次性可变状态形态（let/push/set/cache）');
  });

  check('A1-6 结构钉：探针构建相关源码段（post-turn-probe.ts 全文）零命中引导字面（正对照）', () => {
    assert.ok(!probeSrc.includes('FILE_REF_SYSTEM_PROMPT_APPEND'), 'post-turn-probe.ts 不得引用引导常量');
    assert.ok(!probeSrc.includes(GUIDE_HEADING), 'post-turn-probe.ts 不得含引导标题字面');
    assert.ok(!probeSrc.includes(GUIDE_BULLET), 'post-turn-probe.ts 不得含指引字面');
  });

  console.log('\n=== A2 组：反引号路径链接化渲染层结构钉（计划 §4-A2；A2 未实施前预期红） ===');

  check('A2 结构钉-1：markdown.ts 含 code_inline renderer 覆盖（md.renderer.rules.code_inline）', () => {
    assert.ok(markdownSrc.includes('md.renderer.rules.code_inline'), 'markdown.ts 未覆盖 code_inline renderer（A2 未实施——预期 RED）');
  });

  check('A2 结构钉-2：code_inline 覆盖体内接线 resolveCodeInlinePath', () => {
    const body = codeInlineRuleBody();
    assert.ok(body.includes('resolveCodeInlinePath'), 'code_inline 覆盖体未接线 resolveCodeInlinePath（预期 RED）');
  });

  check('A2 结构钉-3：链接内 code_inline 跳过机制（覆盖体自身或其调用助手内做 link_open/link_close 同段反向扫描）', () => {
    const body = codeInlineRuleBody();
    const callNames = Array.from(body.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g), (m) => m[1]);
    const helperHit = callNames.some((n) => {
      const def = helperBody(n);
      return def !== null && def.includes('link_open') && def.includes('link_close');
    });
    assert.ok(
      (body.includes('link_open') && body.includes('link_close')) || helperHit,
      'code_inline 覆盖缺「链接内跳过」机制（自身或所调助手须含 link_open/link_close 扫描；行为钉不钉助手函数名）',
    );
  });

  check('A2 结构钉-4：file-link.ts 导出 PREVIEWABLE_EXTS（ReadonlySet 白名单）/ resolveCodeInlinePath / isPathLikeRelativeHref', () => {
    const extsLine = fileLinkSrc.split('\n').find((l) => l.includes('const PREVIEWABLE_EXTS'));
    assert.ok(extsLine, '缺 PREVIEWABLE_EXTS 声明（A2 未实施——预期 RED）');
    assert.ok(extsLine.includes('export'), 'PREVIEWABLE_EXTS 须导出');
    assert.ok(extsLine.includes('ReadonlySet'), 'PREVIEWABLE_EXTS 须为 ReadonlySet 白名单（计划 A2 定型）');
    assert.ok(/export function resolveCodeInlinePath\s*\(/.test(fileLinkSrc), '缺 resolveCodeInlinePath 导出');
    assert.ok(/export function isPathLikeRelativeHref\s*\(/.test(fileLinkSrc), '缺 isPathLikeRelativeHref 导出（A4 亦用）');
  });

  check('A2 结构钉-5：code_inline 产出形态与 link_open 按钮化同形（class="md-file-link" / data-clip-path / javascript:void(0)）', () => {
    const body = codeInlineRuleBody();
    assert.ok(body.includes('class="md-file-link"'), 'code_inline 产出缺 class="md-file-link"');
    assert.ok(body.includes('data-clip-path'), 'code_inline 产出缺 data-clip-path');
    assert.ok(body.includes('javascript:void(0)'), 'code_inline 产出缺 href=javascript:void(0)');
  });

  console.log('\n=== A4 组：死链反馈结构钉（计划 §4-A4；A4 未实施前预期红） ===');

  check('A4 结构钉-1：markdown.ts link_open 覆盖含 md-file-link--dead 死链分支', () => {
    const body = linkOpenRuleBody();
    assert.ok(body.includes('md-file-link--dead'), 'link_open 覆盖缺 --dead 死链分支（A4 未实施——预期 RED）');
  });

  check('A4 结构钉-2：link_open 死链分支接线 isPathLikeRelativeHref', () => {
    const body = linkOpenRuleBody();
    assert.ok(body.includes('isPathLikeRelativeHref'), 'link_open 覆盖未接线 isPathLikeRelativeHref（预期 RED）');
  });

  check('A4 结构钉-3：FilePreviewDrawer.vue load() 含「无法定位文件」预检字面', () => {
    const body = drawerLoadBody();
    assert.ok(body.includes('无法定位文件'), 'load() 缺「无法定位文件」预检字面（相对 + 无根静默死链未覆盖——预期 RED）');
  });

  console.log('\n=== P6-A 组：\'...\' 省略段拒绝接线（2026-11-21 计划 p6a·两源收口，RED 先行） ===');
  // P6-A：路径任一段 === '...'（D:\a\...\b.md、src/.../foo.vue）＝模型转述省略路径，非真实可定位
  // 路径 → 两源一律拒绝链接化。拒绝规则收口在 resolveFileLinkHref g 步段循环（两源共享），
  // isPathLikeRelativeHref（markdown.ts 死链标记谓词）同步拒绝——本组钉三处接线字面在位。

  check("P6A 结构钉-1：resolveFileLinkHref 函数体内含 '...' 省略段拒绝（seg === '...' 与 seg === '..' 并列；两源共享 g 步收口）", () => {
    const body = functionBodyOf(fileLinkSrc, 'export function resolveFileLinkHref(', 'resolveFileLinkHref');
    assert.ok(body.includes("seg === '..'"), "resolveFileLinkHref 缺 '..' 段拒绝（切片漂移）");
    assert.ok(body.includes("seg === '...'"), "resolveFileLinkHref 缺 '...' 省略段拒绝（P6-A 未实施——预期 RED）");
  });

  check("P6A 结构钉-2：isPathLikeRelativeHref 函数体内含 seg === '..' || seg === '...'（markdown.ts 死链标记谓词同步拒绝省略段，未设根时省略段不进死链通道）", () => {
    const body = functionBodyOf(fileLinkSrc, 'export function isPathLikeRelativeHref(', 'isPathLikeRelativeHref');
    assert.ok(
      /seg === '\.\.'\s*\|\|\s*seg === '\.\.\.'/.test(body),
      "isPathLikeRelativeHref 缺 '..' || '...' 双段拒绝（P6-A 未实施——预期 RED）",
    );
  });

  check("P6A 结构钉-3：resolveCodeInlinePath 函数体内至少 3 处调用 resolveFileLinkHref（S5a file:///、S5d 绝对、S5e 相对三出口）——'...' 拒绝经共享 g 步在 code_inline 源在位，null 回退基线 <code>", () => {
    const body = functionBodyOf(fileLinkSrc, 'export function resolveCodeInlinePath(', 'resolveCodeInlinePath');
    const hits = body.match(/resolveFileLinkHref\(/g) ?? [];
    assert.ok(hits.length >= 3, `resolveCodeInlinePath 应至少 3 处调用 resolveFileLinkHref（S5a/S5d/S5e 出口），实际 ${hits.length}`);
  });

  console.log('\n=== selftest 清单登记 ===');
  check('selftest-static-list.txt 已登记本脚本', () => {
    const list = readFileSync(new URL('selftest-static-list.txt', import.meta.url), 'utf8');
    const registered = list
      .split(/\r?\n/)
      .map((l) => l.trim())
      .includes('scripts/tdd-code-inline-fileref-verify.ts');
    assert.ok(registered, '清单未登记 scripts/tdd-code-inline-fileref-verify.ts');
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
})().catch((e: unknown) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
