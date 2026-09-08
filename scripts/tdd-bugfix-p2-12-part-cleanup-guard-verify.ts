// tdd-bugfix-p2-12-part-cleanup-guard-verify.ts
// P2-12 契约钉（修复轮 N10 收紧）：`.part` 结尾的合法附件被启动清扫当临时文件删除。
//
// 修复语义：cleanupStalePartFiles 增加 registeredStorageKeys 参数——**完整 storageKey**
// （POSIX 形态 `<sessionId>/<attachmentId>/<filename>`，与生产调用方
// attachmentRepo.listAllStorageKeys() 的 DB 值同形）命中的 `.part` 结尾文件是「键即登记键的
// 合法附件」（落盘名 report.part 的原子写临时名为 report.part.part），不得删除；
// 真临时 .part（不在 DB）照删；1 小时内正在写的 .part（mtime 新）照旧跳过。
// N10：守卫必须比较完整键而非叶子文件名——仅叶子名命中不构成保护（同名不保护）。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-12-part-cleanup-guard-verify.ts

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-p212-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = tmpUserData;

const origLoad = Module._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (req: string, parent: NodeJS.Module | undefined, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { cleanupStalePartFiles } = require('../src/main/modules/attachment-storage');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { app } = require('./electron-stub.cjs');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  // 夹具按生产形态组织：附件根/<sessionId>/<attachmentId>/<filename>。
  const attRoot = path.join(app.getPath('userData'), 'attachments');
  const att1Dir = path.join(attRoot, 'sess-1', 'att-1');
  const att2Dir = path.join(attRoot, 'sess-1', 'att-2');
  fs.mkdirSync(att1Dir, { recursive: true });
  fs.mkdirSync(att2Dir, { recursive: true });
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 小时前（超过 1h 阈值）
  const fresh = new Date();

  // ① 合法附件：落盘名 report.part，DB 登记键为完整 storageKey 'sess-1/att-1/report.part'。
  fs.writeFileSync(path.join(att1Dir, 'report.part'), 'LEGAL-ATTACHMENT');
  fs.utimesSync(path.join(att1Dir, 'report.part'), old, old);
  // ② 该合法附件的残留临时文件（不在 DB，应删）。
  fs.writeFileSync(path.join(att1Dir, 'report.part.part'), 'STALE-TMP');
  fs.utimesSync(path.join(att1Dir, 'report.part.part'), old, old);
  // ③ 普通合法附件的过期临时文件（不在 DB，应删）。
  fs.writeFileSync(path.join(att1Dir, 'photo.png.part'), 'STALE-TMP-2');
  fs.utimesSync(path.join(att1Dir, 'photo.png.part'), old, old);
  // ④ 正在写的 .part（mtime 新，应保留）。
  fs.writeFileSync(path.join(att1Dir, 'writing.png.part'), 'IN-FLIGHT');
  fs.utimesSync(path.join(att1Dir, 'writing.png.part'), fresh, fresh);
  // ⑤ 同名不保护：att-2 下的 report.part 落盘名与 ① 相同，但其完整键未登记（应删）。
  fs.writeFileSync(path.join(att2Dir, 'report.part'), 'UNREGISTERED-SAME-NAME');
  fs.utimesSync(path.join(att2Dir, 'report.part'), old, old);

  // 生产调用方（attachment-service）传 DB 全键：'sess-1/<attId>/<filename>' 形态。
  await cleanupStalePartFiles(60 * 60 * 1000, ['sess-1/att-1/report.part']);

  check('① 合法附件 sess-1/att-1/report.part（全键命中）未被误删',
    fs.existsSync(path.join(att1Dir, 'report.part')));
  check('② 其残留临时文件 report.part.part 被删（真临时）',
    !fs.existsSync(path.join(att1Dir, 'report.part.part')));
  check('③ 普通过期 .part 照删（回归不变）',
    !fs.existsSync(path.join(att1Dir, 'photo.png.part')));
  check('④ 正在写的 .part 保留（mtime 门回归不变）',
    fs.existsSync(path.join(att1Dir, 'writing.png.part')));
  check('⑤ 同名不保护：att-2/report.part 未登记（仅叶子名同名）照删',
    !fs.existsSync(path.join(att2Dir, 'report.part')));

  // ⑥ 缺省（无登记信息）行为与旧版一致：仅 mtime 门生效。
  fs.writeFileSync(path.join(att1Dir, 'report.part.part'), 'X');
  fs.utimesSync(path.join(att1Dir, 'report.part.part'), old, old);
  await cleanupStalePartFiles();
  check('⑥ 缺省无登记参数时 mtime 门行为不变（旧 .part.part 照删）',
    !fs.existsSync(path.join(att1Dir, 'report.part.part')));

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
