// tdd-fs-picker-drive-resilience.ts
// 「选目录锁死 C 盘修复」P1 契约钉：主进程驱动器枚举逐盘预算（fs-picker 慢盘剔除韧性）。
//
// 背景（计划 2026-10-14 §0.1 F1）：原 enumerateDrives 为「1s 整体预算、全有或全无」——
// 26 盘 Promise.allSettled 等最慢一个，任一盘探测 >1s（机械盘休眠唤醒/断连映射盘/读卡器）
// 整个 drives 归 []。本契约钉死重构后的逐盘预算语义：每盘各自 withBudget 计时，
// 慢盘单独剔除、其余照常返回；全慢归 [] 但不抛异常；probe reject 与现状一致剔除。
//
// A 组（运行时注入直测，import enumerateDrivesWithProbe + listRoots）：
//   A1 单盘慢（E 永不 resolve）→ 仅剔除该盘，其余保留，总耗时 ≈ 单盘预算（不叠加）；
//   A2 全部盘 hang → []、无异常抛出；
//   A3 probe reject（盘符不存在）→ 剔除该盘，不影响其他盘；
//   A4 listRoots 真机直跑：ok===true、含 C 盘、drives 形状 { 单字母, X:\ }。
// B 组（静态断言，读 fs-picker.ts 源码文本）：
//   B1 不含 existsSync(（防回退，与 tdd-fs-picker.ts 同款）；
//   B2 含 LIST_ROOTS_DRIVE_BUDGET_MS 且 LIST_ROOTS_BUDGET_MS 值为 2500（外层兜底上限）；
//   B3 enumerateDrivesWithProbe 为 export（契约脚本可注入直测的前提）。
//
// 运行：npx tsx scripts/tdd-fs-picker-drive-resilience.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { enumerateDrivesWithProbe, listRoots } from '../src/main/modules/fs-picker';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 测试用单盘预算：远小于真机 800ms，keep 断言耗时上界有意义。 */
const TEST_PER_DRIVE_MS = 150;

/** A1 探针：C/D 即时 resolve、E 永不 resolve（模拟慢盘 hang）、其余盘 reject（视同不存在）。 */
function probeOneSlowDrive(root: string): Promise<void> {
  const letter = root[0];
  if (letter === 'C' || letter === 'D') return Promise.resolve();
  if (letter === 'E') return new Promise<void>(() => { /* 永不 resolve */ });
  return Promise.reject(new Error(`${letter}: absent`));
}

/** A3 探针：仅 C resolve、B reject（模拟盘符不存在 ENOENT）、其余全 reject。 */
function probeBReject(root: string): Promise<void> {
  const letter = root[0];
  if (letter === 'C') return Promise.resolve();
  return Promise.reject(new Error(`${letter}: absent`));
}

async function main(): Promise<void> {
  // ── A1：单盘慢（E hang）→ 该盘剔除，C/D 保留，耗时 ≈ 单盘预算（26 盘并发不叠加） ──
  console.log('\n[A1] 单盘慢 → 剔除该盘，其余保留');
  const t1 = Date.now();
  const r1 = await enumerateDrivesWithProbe(probeOneSlowDrive, TEST_PER_DRIVE_MS);
  const elapsed1 = Date.now() - t1;
  check('letters = [C,D]（E 慢盘剔除、reject 盘剔除）',
    JSON.stringify(r1.map((d) => d.letter)) === JSON.stringify(['C', 'D']),
    `实际: ${JSON.stringify(r1)}`);
  check(`耗时 < 2000ms（实测 ${elapsed1}ms，逐盘并发不叠加）`, elapsed1 < 2000, `实测 ${elapsed1}ms`);
  check('保留项形状 { letter, path: "X:\\" }',
    r1.every((d) => /^[A-Z]$/.test(d.letter) && /^[A-Z]:\\$/.test(d.path)), JSON.stringify(r1));

  // ── A2：全部盘 hang → []、无异常抛出（走到此断言本身即未抛） ──
  console.log('\n[A2] 全部盘 hang → 空数组不抛异常');
  const r2 = await enumerateDrivesWithProbe(() => new Promise<void>(() => { /* 永不 resolve */ }), TEST_PER_DRIVE_MS);
  check('全部 hang → drives: []', Array.isArray(r2) && r2.length === 0, `实际: ${JSON.stringify(r2)}`);

  // ── A3：probe reject（B 盘）→ 剔除，其余盘不受牵连 ──
  console.log('\n[A3] probe reject → 剔除该盘');
  const r3 = await enumerateDrivesWithProbe(probeBReject, TEST_PER_DRIVE_MS);
  check('仅 C 保留（B reject 被剔除）',
    JSON.stringify(r3.map((d) => d.letter)) === JSON.stringify(['C']), `实际: ${JSON.stringify(r3)}`);

  // ── A4：listRoots 真机直跑（真实 fsp.access 探测链 + 外层兜底预算）──
  console.log('\n[A4] listRoots 真机直跑');
  const roots = await listRoots();
  check('ok === true', roots.ok === true, JSON.stringify(roots));
  check("drives 含 'C'（本机必有 C 盘）", roots.drives.some((d) => d.letter === 'C'), JSON.stringify(roots.drives));
  check("drives 每项形状 { 单字母, 'X:\\' }",
    roots.drives.every((d) => /^[A-Z]$/.test(d.letter) && /^[A-Z]:\\$/.test(d.path)), JSON.stringify(roots.drives));
  check('cwdHome 非空', typeof roots.cwdHome === 'string' && roots.cwdHome.length > 0);

  // ── B 组：静态断言（fs-picker.ts 源码文本）──
  console.log('\n[B] 静态断言');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'modules', 'fs-picker.ts'), 'utf8');
  check('不含 existsSync(（防回退同步探测，P2-2 契约延续）', !src.includes('existsSync('));
  check('含 LIST_ROOTS_DRIVE_BUDGET_MS（单盘预算常量存在）', src.includes('LIST_ROOTS_DRIVE_BUDGET_MS'));
  check('LIST_ROOTS_BUDGET_MS = 2500（外层兜底上限）', /const LIST_ROOTS_BUDGET_MS = 2500;/.test(src));
  check('enumerateDrivesWithProbe 为 export（可注入直测）', /export async function enumerateDrivesWithProbe\(/.test(src));

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('脚本执行异常：', err);
  process.exit(1);
});
