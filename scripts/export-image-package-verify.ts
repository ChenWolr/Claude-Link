// v4.1 packaged worker 部署闭包验证。
// worker 被 electron-builder asarUnpack 后，其相对 require('./chunks/*.js') 依赖也必须在
// app.asar.unpacked/out/main/chunks/ 下；否则 packaged PNG 导出会在 worker 启动时 MODULE_NOT_FOUND。
// 运行：npx tsx scripts/export-image-package-verify.ts [win-unpacked 路径]

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appRoot = resolve(process.argv[2] ?? 'dist-electron/win-unpacked');
const unpackedMain = join(appRoot, 'resources', 'app.asar.unpacked', 'out', 'main');
const workerPath = join(unpackedMain, 'exportImageCodecWorker.js');

assert(existsSync(workerPath), `未找到解包 worker：${workerPath}`);
const workerSource = readFileSync(workerPath, 'utf8');
const requiredChunks = [...workerSource.matchAll(/require\(["']\.\/chunks\/([^"']+)["']\)/g)].map((m) => m[1]);

for (const chunk of requiredChunks) {
  const chunkPath = join(unpackedMain, 'chunks', chunk);
  assert(existsSync(chunkPath), `worker 相对依赖未解包：${chunkPath}`);
}

console.log(`✅ packaged worker 部署闭包完整：${workerPath}${requiredChunks.length ? `（${requiredChunks.length} 个 chunk）` : '（无共享 chunk）'}`);
