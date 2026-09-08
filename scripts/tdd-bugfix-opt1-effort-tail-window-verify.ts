// tdd-bugfix-opt1-effort-tail-window-verify.ts
// OPT-1 契约钉：effort 真值提取改尾部窗口读——每回合至多 4 次整文件 readFileSync（长会话
// 数十 MB 同步阻塞主进程）改为 fsp.open+stat+只读末尾 EFFORT_TAIL_WINDOW_BYTES（256KB）。
//
// 运行：npx tsx scripts/tdd-bugfix-opt1-effort-tail-window-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  extractLastEffortFromJsonl,
  extractLastEffortFromText,
  EFFORT_TAIL_WINDOW_BYTES,
} from '../src/shared/effort-truth';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

const line = (effort: string) => JSON.stringify({ type: 'assistant', effort, message: { role: 'assistant', content: [] } }) + '\n';
const filler = JSON.stringify({ type: 'user', message: 'x'.repeat(200) }) + '\n';

check('① 窗口常量 = 256KB', () => assert.equal(EFFORT_TAIL_WINDOW_BYTES, 256 * 1024));
check('② 全文解析回归：取最后一条 effort', () => {
  assert.equal(extractLastEffortFromJsonl(line('high') + filler + line('max')), 'max');
});
check('③ 尾部窗口：丢弃首半个截断行后仍可解析', () => {
  const twoFillers = filler + filler;
  const effortLine = line('high');
  const full = twoFillers + effortLine + filler;
  // 截断点落在第二个 filler 行中部：窗口首行=半个截断行，effort 行完整在窗口内。
  const tail = full.slice(filler.length + Math.floor(filler.length / 2)); // 截在第二个 filler 行中部（effort 行之前）
  assert.equal(extractLastEffortFromText(tail), 'high');
});
check('④ 窗口内无 effort → null', () => {
  assert.equal(extractLastEffortFromText(filler.slice(0, 100)), null);
});
check('⑤ sdk-backend 改为尾部窗口读（无整文件 readFileSync）', () => {
  const backend = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/modules/sdk-backend.ts'), 'utf8');
  assert.ok(backend.includes('EFFORT_TAIL_WINDOW_BYTES'));
  assert.ok(backend.includes('extractLastEffortFromText(tailText)'));
  assert.ok(!backend.includes('extractLastEffortFromJsonl(readFileSync'), '整读调用应删除');
});
check('⑥ 行为：临时 JSONL 尾部窗口提取与全文一致', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opt1-'));
  const file = path.join(tmp, 'sid.jsonl');
  const big = filler.repeat(2000) + line('xhigh');
  fs.writeFileSync(file, big);
  assert.ok(big.length > EFFORT_TAIL_WINDOW_BYTES, '前置：构造大于窗口的文件');
  const buf = Buffer.alloc(EFFORT_TAIL_WINDOW_BYTES);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, EFFORT_TAIL_WINDOW_BYTES, big.length - EFFORT_TAIL_WINDOW_BYTES);
  fs.closeSync(fd);
  assert.equal(extractLastEffortFromText(buf.toString('utf8')), 'xhigh');
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
