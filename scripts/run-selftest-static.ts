// scripts/run-selftest-static.ts
// selftest:static 链 runner——Windows 命令行长度超限（cmd ~8k 字符上限），契约脚本数量
// 超限后无法以内联 && 链执行。改为逐行读 scripts/selftest-static-list.txt 串行 spawn 执行，
// 任一非零退出立即终止并透传退出码（语义与原 && 链完全一致）。
// 清单维护：新增契约脚本时向 scripts/selftest-static-list.txt 尾部追加一行（相对 repo 根路径）。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const listFile = path.join(repoRoot, 'scripts', 'selftest-static-list.txt');
const scripts = fs.readFileSync(listFile, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

let index = 0;
for (const rel of scripts) {
  index += 1;
  const scriptPath = path.join(repoRoot, rel);
  if (!fs.existsSync(scriptPath)) {
    console.error(`\n[runner] 脚本不存在：${rel}`);
    process.exit(1);
  }
  // 经 tsx 执行（.ts 文件；node 直跑报 ERR_UNKNOWN_FILE_EXTENSION）。
  const r = spawnSync('npx', ['tsx', rel], { stdio: 'inherit', cwd: repoRoot, shell: process.platform === 'win32' });
  if (r.error) {
    console.error(`\n[runner] ${rel} spawn 失败：${String(r.error)}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`\n[runner] ${rel} 退出码 ${r.status}（第 ${index}/${scripts.length} 个）——链终止`);
    process.exit(r.status ?? 1);
  }
}
console.log(`\n[runner] 全部 ${scripts.length} 个契约脚本通过`);
process.exit(0);
