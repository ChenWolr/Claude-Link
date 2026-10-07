// tdd-diff-control-chars-verify.ts
// R10-F1（X4，P2）契约钉：diff 内容行含 \f/\v/U+0085/裸 \r 被 jsdiff 拆行，hunk 从该行起
// 静默丢内容——GBK（主进程 latin1 降级把尾字节 0x85 映射 U+0085）文件常态化触发。
//
// 根因：jsdiff parsePatch 以 /\r\n|[\n\v\f\r\x85]/ 拆行（node_modules/diff/lib/patch/parse.js:15），
// git 只按 \n 分行，行内容里的 \f\v\x85 裸 \r 被当分隔符；拆出的后半段行首不在 +/-/space/\\
// 集合 → parseHunk break，该 hunk 余下行静默丢弃。
//
// 修复语义：parseUnifiedDiff 入口（两弹窗共用）先做行内容归一——\r\n 先归一为 \n 避免误伤，
// 其余 \v\f\r\x85 一对一替换为 U+2400 系可见占位符（␋␌␍␥），保证「渲染行数 = git 输出行数」；
// ±计数/导航数/Ctrl+F 命中数随行数恢复自动修复。
//
// 用例复用 R10 收集文档探针1（探针复跑与第一轮逐字一致）：
//   ① ctx1/old/+new<控制符>line/ctx3 三段 6 行不缩水（四种控制符逐一）；
//   ② 多 hunk：+b\fREMAINDER 后的 ctx 与第二 hunk 均不缺；
//   ③ GBK 降级形态 +中文\x85后半句… 整句保留；
//   ④⑤ 回归：CRLF/无控制符输入渲染字节不变（与 jsdiff 自身 split 行为等价）。
//
// 运行：npx tsx scripts/tdd-diff-control-chars-verify.ts

import { strict as assert } from 'node:assert';
import { parseUnifiedDiff } from '../src/renderer/utils/diff-parser';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

// 占位符码点钉死（一对一映射；U+2425 为 U+0085 NEL 的可见替身，U+2400 系无官方对应）。
const PH: Record<string, string> = { '\v': '␋', '\f': '␌', '\r': '␍', '\x85': '␥' };
assert.equal(PH['\v'], '\u240B');
assert.equal(PH['\f'], '\u240C');
assert.equal(PH['\r'], '\u240D');
assert.equal(PH['\x85'], '\u2425');

// 探针1形态：@@ -1,3 +1,3 @@ + ctx1 / -old / +new<控制符>line / ctx3。
// 完整渲染应为 6 行（ctx1×2 + mod L/R + ctx3×2）；缺陷态只剩 4 行（ctx3 两侧整行消失）。
function probeSingle(ctl: string): string {
  return ['--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,3 @@', ' context1', '-old', `+new${ctl}line`, ' context3'].join('\n');
}

function allLines(parsed: NonNullable<ReturnType<typeof parseUnifiedDiff>>): { n: number | null; t: string }[] {
  return parsed.groups.flatMap((g) => [...g.L, ...g.R].map((l) => ({ n: l.n, t: l.t })));
}

for (const [label, ctl] of [['\\f(0x0C)', '\f'], ['\\v(0x0B)', '\v'], ['U+0085(NEL)', '\x85'], ['裸\\r(0x0D)', '\r']] as const) {
  check(`① 含 ${label} 的内容行：三段 6 行不缩水（ctx3 两侧整行不丢）`, () => {
    const parsed = parseUnifiedDiff(probeSingle(ctl));
    assert.ok(parsed, '应可解析');
    assert.ok(!parsed!.binary && !parsed!.conflict, '普通 unified diff 不应走降级视图');
    const lines = allLines(parsed!);
    assert.equal(lines.length, 6, `渲染行数应 = git 输出行数（6），实际 ${lines.length}`);
    assert.equal(lines.filter((l) => l.t === 'context1').length, 2, 'ctx1 两侧都在');
    assert.equal(lines.filter((l) => l.t === 'context3').length, 2, 'ctx3 两侧都在（缺陷态整行消失）');
  });
  check(`①' ${label} 归一为可见占位符：改动行整行保留（new${PH[ctl]}line）`, () => {
    const parsed = parseUnifiedDiff(probeSingle(ctl));
    const mod = parsed!.groups.find((g) => g.k === 'mod' || g.k === 'ws');
    assert.ok(mod, '应有 mod 组');
    assert.equal(mod!.R[0]!.t, `new${PH[ctl]}line`, '行内容一对一映射为占位符，不截断');
    assert.equal(mod!.L[0]!.t, 'old', '旧行不受影响');
  });
}

// 探针1 多 hunk 形态：hunk1 的 +b\fREMAINDER_AFTER_FF 后还有 ctx 与第二 hunk——
// 缺陷态 REMAINDER 与 hunk1 尾 ctx 均丢、第二 hunk 幸存（部分 hunk 缺损形态）。
const MULTI = [
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+b\fREMAINDER_AFTER_FF',
  ' ctx-after-h1',
  '@@ -10,2 +10,2 @@',
  ' x',
  '-y',
  '+z',
].join('\n');

check('② 多 hunk：控制符后的 ctx 与后段内容不丢（REMAINDER 保留）', () => {
  const parsed = parseUnifiedDiff(MULTI);
  assert.ok(parsed, '应可解析');
  const lines = allLines(parsed!);
  assert.equal(lines.length, 10, `两个 hunk 共 10 行（h1: a×2+mod×2+ctx×2；h2: x×2+mod×2），实际 ${lines.length}`);
  const text = JSON.stringify(parsed!.groups);
  assert.ok(text.includes('REMAINDER_AFTER_FF'), '控制符后半段内容必须保留');
  assert.ok(text.includes(`b${PH['\f']}REMAINDER_AFTER_FF`), '占位符一对一映射在位');
  assert.equal(lines.filter((l) => l.t === 'ctx-after-h1').length, 2, 'hunk1 尾 ctx 两侧都在');
});
check('②' + "' 多 hunk 结构完整：skip 间隙组保留、行号连续", () => {
  const parsed = parseUnifiedDiff(MULTI)!;
  const skip = parsed.groups.filter((g) => g.k === 'skip');
  assert.equal(skip.length, 1, 'hunk 间隙 skip 组保留');
  assert.equal(skip[0]!.skipCount, 6, 'skipCount = 10 - (1+3)');
  const ns = allLines(parsed).map((l) => l.n).filter((n): n is number => n != null);
  assert.deepEqual(ns, [1, 1, 2, 2, 3, 3, 10, 10, 11, 11], '两 hunk 行号从各自 oldStart/newStart 起算不受扰');
});

// 探针1 GBK 形态：主进程 latin1 降级把 GBK 尾字节 0x85 单射为 U+0085（changes-panel.ts decode）。
const GBK = ['--- a/gbk.txt', '+++ b/gbk.txt', '@@ -1,2 +1,2 @@', ' 前一行', '-旧句', '+中文\x85后半句消失了'].join('\n');

check('③ GBK 降级形态：+中文\\x85后半句消失了 整句保留（缺陷态只剩「中文」）', () => {
  const parsed = parseUnifiedDiff(GBK);
  assert.ok(parsed, '应可解析');
  const mod = parsed!.groups.find((g) => g.k === 'mod' || g.k === 'ws');
  assert.ok(mod, '应有 mod 组');
  assert.equal(mod!.R[0]!.t, `中文${PH['\x85']}后半句消失了`, 'U+0085 → ␥(U+2425)，整句不截断');
  assert.equal(mod!.L[0]!.t, '旧句');
  assert.equal(allLines(parsed!).length, 4, 'ctx×2 + mod×2 = 4 行');
});

// 回归：CRLF 行尾 diff（autocrlf 仓库常态）——\r\n 先归一为 \n，与 jsdiff 自身把 \r\n 当
// 整体分隔符等价：行内不残留 \r、不产占位符、渲染零差异。
const CRLF = ['--- a/crlf.txt', '+++ b/crlf.txt', '@@ -1,2 +1,2 @@', ' ctx', '-gone', '+new'].join('\r\n') + '\r\n';

check('④ CRLF 输入回归：正常解析、行内零残留 \\r、零占位符', () => {
  const parsed = parseUnifiedDiff(CRLF);
  assert.ok(parsed, '应可解析');
  const lines = allLines(parsed!);
  assert.equal(lines.length, 4, 'ctx×2 + mod×2 = 4 行');
  for (const l of lines) {
    assert.ok(!l.t.includes('\r'), '行内不得残留 \\r');
    assert.ok(!l.t.includes('␍') && !l.t.includes('␋') && !l.t.includes('␌') && !l.t.includes('␥'), 'CRLF 归一不得产占位符');
  }
  const mod = parsed!.groups.find((g) => g.k === 'mod' || g.k === 'ws');
  assert.equal(mod!.R[0]!.t, 'new', '内容原样');
});

// 回归：无控制符输入字节不变（含 \t/中文/空格原样保留），且尾部 `\ No newline` 标记仍被跳过。
check('⑤ 无控制符输入回归：内容字节不变 + \\ No newline 标记不进内容', () => {
  const plain = ['--- a/p.txt', '+++ b/p.txt', '@@ -1,2 +1,2 @@', ' \ttab 前导 ctx', '-\t旧\t行', '+\t新\t行', '\\ No newline at end of file'].join('\n');
  const parsed = parseUnifiedDiff(plain);
  assert.ok(parsed, '应可解析');
  const text = JSON.stringify(parsed!.groups);
  assert.ok(text.includes('\\ttab 前导 ctx'), 'ctx 内容原样（含 \\t 与中文）');
  assert.ok(!text.includes('No newline'), '\\ 标记行仍被跳过');
  const mod = parsed!.groups.find((g) => g.k === 'mod' || g.k === 'ws');
  assert.equal(mod!.R[0]!.t, '\t新\t行', '改动行内容逐字节不变');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
