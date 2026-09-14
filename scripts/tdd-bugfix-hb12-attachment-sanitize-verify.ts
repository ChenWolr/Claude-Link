// scripts/tdd-bugfix-hb12-attachment-sanitize-verify.ts
// hb12 P2-5（ATT-01 三合一）契约——同时覆盖 hb10-P2-17（点折叠变体；按 hb12 计划勿重复立项 hb10 脚本）。
//
// sanitizeAttachmentFilename 单函数三个缺口（一次改完，三步作用于同一输出）：
//   ① 黑名单缺 `<>:"|?*`——`:` 触发 NTFS ADS（a:b.txt 写入 ADS 流），磁盘枚举键≠DB 键 →
//      启动孤儿误删+队列熔断（复核实验：'a:b.txt'/'<>|"?*'/'CONIN$' 全部原样通过）；
//   ② 点折叠变体（hb10-P2-17）：折叠/清洗结果为 `.`、`..` 或纯点串时 path.win32.resolve/join
//      把 `<sid>/<id>/.` 折叠为目录自身（复核 node 实验复现）→ 键失配；尾点文件在 Win32
//      资源管理器不可操作（trim 改为剥尾部 `.` 与空白）；
//   ③ 无长度上限（hb12-ATT-02）：300 字符文件名原样通过 → MAX_PATH 260 必败且 raw 错误串经
//      ipc 透传泄漏绝对路径 → basename 裁剪 100 字符 + 截断哈希后缀，保留扩展名。
//
// 边界值：老库已存坏键的孤儿清扫逻辑不动（仅新写入不产生坏键）；前端展示名不变（filename 仅存储用）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb12-attachment-sanitize-verify.ts

import { strict as assert } from 'node:assert';
import * as path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sanitizeAttachmentFilename } = require('../src/main/modules/attachment-policy') as {
  sanitizeAttachmentFilename: (name: string) => string;
};

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① hb10-P2-17 八例（点折叠/尾点/设备名/常规）。设备名沿用既有 file_ 前缀机制（P3-11 形态）；
// 内部 '..' 折叠（a..b→ab）为既有行为，本修复不改变其语义。
check('① 点折叠与尾点八例（hb10-P2-17）', () => {
  assert.equal(sanitizeAttachmentFilename('...'), 'attachment', '纯点串未回退 attachment（path.win32 折叠为目录自身）');
  assert.equal(sanitizeAttachmentFilename('..'), 'attachment', '.. 未回退');
  assert.equal(sanitizeAttachmentFilename('.'), 'attachment', '. 未回退');
  assert.equal(sanitizeAttachmentFilename('report.'), 'report', '尾点未剥（Win32 资源管理器不可操作）');
  assert.equal(sanitizeAttachmentFilename('a..b.txt'), 'ab.txt', '内部 .. 折叠语义漂移（既有行为）');
  assert.equal(sanitizeAttachmentFilename('CON.txt'), 'file_CON.txt', '设备名 file_ 前缀机制被破坏（P3-11 既有形态）');
  assert.equal(sanitizeAttachmentFilename('正常名.txt'), '正常名.txt', '正常中文名被误伤');
  assert.equal(sanitizeAttachmentFilename(''), 'attachment', '空串未回退兜底名');
});

// ② hb12-ATT-01 非法字符黑名单。
check('② 非法字符黑名单（<>:"|?* → _；设备名扩 CONIN$/CONOUT$）', () => {
  assert.equal(sanitizeAttachmentFilename('a:b.txt'), 'a_b.txt', '冒号未替换（NTFS ADS 流）');
  assert.equal(sanitizeAttachmentFilename('<>|"?*'), '______', '尖括号/管道/问号/星号未替换');
  assert.equal(sanitizeAttachmentFilename('CONIN$'), 'file_CONIN$', 'CONIN$ 未被设备名分支处理（原样通过=可创建）');
  assert.equal(sanitizeAttachmentFilename('CONOUT$'), 'file_CONOUT$', 'CONOUT$ 未被设备名分支处理');
  assert.equal(sanitizeAttachmentFilename('com1.txt'), 'file_com1.txt', 'com1 设备名未处理');
  assert.equal(sanitizeAttachmentFilename('带 空格 名.txt'), '带 空格 名.txt', '内部空格被误伤');
});

// ③ hb12-ATT-02 长度上限。
check('③ 长度上限：300 字符 basename 裁剪为 100+哈希后缀且保留扩展名', () => {
  const long = 'x'.repeat(300);
  const out = sanitizeAttachmentFilename(long);
  assert.ok(out.length <= 140, `裁剪后过长：${out.length}`);
  const longExt = `y`.repeat(300) + '.txt';
  const out2 = sanitizeAttachmentFilename(longExt);
  assert.ok(out2.endsWith('.txt'), '扩展名未保留');
  assert.ok(out2.length <= 140, `带扩展名裁剪后过长：${out2.length}`);
  // hb13-v 批C 改钉（原为 `out !== out2 || true` 恒真断言）：不同内容裁剪后哈希可区分。
  assert.notEqual(out, out2, '不同内容裁剪后应可区分');
  assert.notEqual(out2, 'y'.repeat(100) + '.txt', '缺截断哈希后缀（不同内容裁剪后应可区分）');
});

// ④ 源码钉：三步同函数（黑名单/点折叠回退/长度裁剪均在 sanitizeAttachmentFilename 内）。
check('④ 源码钉：三步收口于 sanitizeAttachmentFilename 单函数', () => {
  // 契约以行为断言为主（①②③ 已覆盖），此处补一条防御：黑名单正则存在。
  const fs = require('node:fs') as typeof import('node:fs');
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/modules/attachment-policy.ts'), 'utf8');
  const idx = src.indexOf('export function sanitizeAttachmentFilename');
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /[<>:"|?*]/, '黑名单正则缺非法字符集');
  assert.match(body, /attachment/, '缺兜底名 attachment');
  assert.match(body, /slice\(/, '缺长度裁剪');
});

// ⑤ hb13-v B10.4：超长扩展名——`a.`+253z 旧实现原样保留扩展产出 350+ 字符名（MAX_PATH 必败）。
check('⑤ B10.4：超长扩展名裁剪后不超 MAX_PATH 安全值（扩展 ≤16 + 哈希改写）', () => {
  const out = sanitizeAttachmentFilename('a.' + 'z'.repeat(253));
  assert.ok(out.length <= 100, `超长扩展名裁剪后仍过长：${out.length}`);
  assert.ok(out.includes('~'), '超长扩展名场景缺哈希改写');
  const ext = out.slice(out.indexOf('.'));
  assert.ok(ext.length <= 17, `扩展名仍超 16 位：${ext.length}`);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
