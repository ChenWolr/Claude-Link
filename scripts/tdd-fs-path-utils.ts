// tdd-fs-path-utils.ts
// 「选目录锁死 C 盘修复」P3 契约钉：路径工具抽取 + 地址栏（含 UNC）。
//
// 背景（计划 2026-10-14 §2 P3）：FilePickerDialog.vue 内联的 joinPath/parentDir/baseName/samePath
// 原样迁移到 src/renderer/composables/fs-path-utils.ts（组件内删除改 import，单源维护）；
// parentDir 增强 UNC（\\srv\sh\a → \\srv\sh，剥到 \\server → null，盘符路径逻辑不变）；
// 新增 isAbsolutePath（盘符绝对路径或 UNC，/^([a-zA-Z]:[\\/]|\\\\)/）；
// 新增 normalizeAddressInput（地址栏输入归一：trim / 拒绝相对路径 / 盘符正斜杠归反斜杠 +
// 去尾斜杠（盘根保留单尾斜杠）/ UNC 保前导 \\ 去尾斜杠 / 长度上限 4096）。
//
// 约束（静态断言 E 组）：fs-path-utils.ts 不得 import 'vue'——契约脚本 tsx 直测的前提。
//
// 运行：npx tsx scripts/tdd-fs-path-utils.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  baseName,
  isAbsolutePath,
  joinPath,
  normalizeAddressInput,
  parentDir,
  samePath,
} from '../src/renderer/composables/fs-path-utils';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  check(name, ok, ok ? '' : `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

function main(): void {
  // ── A 组：joinPath 迁移回归（原样迁移，含尾斜杠/混合斜杠/盘根） ──
  console.log('\n[A] joinPath 迁移回归');
  eq("joinPath('D:\\work', 'sub')", joinPath('D:\\work', 'sub'), 'D:\\work\\sub');
  eq("joinPath('D:\\work\\', 'a')（尾斜杠不重复补）", joinPath('D:\\work\\', 'a'), 'D:\\work\\a');
  eq("joinPath('D:\\', 'sub')（盘根）", joinPath('D:\\', 'sub'), 'D:\\sub');
  eq("joinPath('C:/x', 'y')（混合斜杠原样行为）", joinPath('C:/x', 'y'), 'C:/x\\y');

  // ── B 组：parentDir 盘符路径迁移回归（盘符逻辑不变） + UNC 增强 ──
  console.log('\n[B] parentDir 盘符回归 + UNC 增强');
  eq("parentDir('D:\\work\\sub')", parentDir('D:\\work\\sub'), 'D:\\work');
  eq("parentDir('D:\\work\\sub\\')（尾斜杠）", parentDir('D:\\work\\sub\\'), 'D:\\work');
  eq("parentDir('D:\\')（盘根）", parentDir('D:\\'), null);
  eq("parentDir('d:\\Work')（大小写保留）", parentDir('d:\\Work'), 'd:\\');
  eq("parentDir('foo')（非盘符）", parentDir('foo'), null);
  eq('parentDir UNC: \\\\srv\\sh\\a → \\\\srv\\sh', parentDir(String.raw`\\srv\sh\a`), String.raw`\\srv\sh`);
  eq('parentDir UNC: \\\\srv\\sh → null（剥到 share 即止）', parentDir(String.raw`\\srv\sh`), null);
  eq('parentDir UNC: \\\\srv → null（无 share 段）', parentDir(String.raw`\\srv`), null);
  eq('parentDir UNC: \\\\localhost\\c$ → null（上级置灰依据）', parentDir(String.raw`\\localhost\c$`), null);

  // ── C 组：baseName / samePath 迁移回归 ──
  console.log('\n[C] baseName / samePath 迁移回归');
  eq("baseName('D:\\work\\a.txt')", baseName('D:\\work\\a.txt'), 'a.txt');
  eq("baseName('D:\\work\\')（尾斜杠→空）", baseName('D:\\work\\'), '');
  eq("baseName('C:\\')（盘根→空）", baseName('C:\\'), '');
  eq("baseName('file.txt')（无分隔符）", baseName('file.txt'), 'file.txt');
  eq("samePath('D:\\Work', 'd:\\work')（大小写不敏感）", samePath('D:\\Work', 'd:\\work'), true);
  eq("samePath('D:\\work\\', 'D:\\work')（尾斜杠不敏感）", samePath('D:\\work\\', 'D:\\work'), true);
  eq("samePath('D:\\a', 'D:\\b')", samePath('D:\\a', 'D:\\b'), false);
  eq("samePath('C:\\x', 'D:\\x')（盘符不同）", samePath('C:\\x', 'D:\\x'), false);

  // ── D1 组：isAbsolutePath 六例 ──
  console.log('\n[D1] isAbsolutePath');
  eq("isAbsolutePath('D:\\a')", isAbsolutePath('D:\\a'), true);
  eq("isAbsolutePath('D:/a')", isAbsolutePath('D:/a'), true);
  eq('isAbsolutePath(\\\\s\\sh)（UNC）', isAbsolutePath(String.raw`\\s\sh`), true);
  eq("isAbsolutePath('D:a')（冒号后无分隔→相对）", isAbsolutePath('D:a'), false);
  eq("isAbsolutePath('a\\b')（相对）", isAbsolutePath('a\\b'), false);
  eq("isAbsolutePath('')（空串）", isAbsolutePath(''), false);

  // ── D2 组：normalizeAddressInput 六例（计划 L163 逐条） + 边界 ──
  console.log('\n[D2] normalizeAddressInput');
  eq("'  d:/x/y/  ' → d:\\x\\y（trim+正斜杠归一+去尾斜杠）", normalizeAddressInput('  d:/x/y/  '), 'd:\\x\\y');
  eq("'D:\\' → D:\\（盘根保留单尾斜杠）", normalizeAddressInput('D:\\'), 'D:\\');
  eq("'foo' → null（相对路径）", normalizeAddressInput('foo'), null);
  eq("'' → null（空串）", normalizeAddressInput(''), null);
  eq('UNC 去尾斜杠、前导不动', normalizeAddressInput('\\\\srv\\sh\\'), '\\\\srv\\sh');
  eq('4097 字符 → null（超长）', normalizeAddressInput('D:\\' + 'x'.repeat(4094)), null);
  // 边界补充（计划 L157 边界值）：
  eq('4096 字符 → 非 null（上限恰 4096 不拒）', normalizeAddressInput('D:\\' + 'x'.repeat(4093)) !== null, true);
  eq("'   ' → null（纯空格）", normalizeAddressInput('   '), null);
  // round-002 F1 配套：UNC 分支剥空（纯反斜杠输入）→ null——不得返回 '' 穿过调用方 `norm === null` 校验。
  eq('UNC 纯 \\\\ → null（剥空视同无效输入）', normalizeAddressInput(String.raw`\\`), null);
  eq('UNC 四个反斜杠 → null（全为分隔符，剥空）', normalizeAddressInput(String.raw`\\\\`), null);

  // ── E 组：静态断言（fs-path-utils.ts 源码不得 import vue——tsx 直测前提） ──
  console.log('\n[E] 静态断言');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'composables', 'fs-path-utils.ts'),
    'utf8',
  );
  check("不含 from 'vue'（纯函数零框架依赖）", !src.includes("from 'vue'"));

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
