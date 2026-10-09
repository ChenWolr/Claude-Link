// scripts/selftest-build-freshness.ts
// 发布管线陈旧产物事故（2026-10-09）静态契约：v0.4.3 发版时 package:win 不重建 out/，
// 打包了归一化修复（94eb3f8）合入前的陈旧产物——修复从未进入安装包，「复发」实为
// 「源码已修、二进制没带上」。本脚本钉住三条防线的结构性接线：
//   C1 package:win 自带构建（npm run build && …）——消灭陈旧 out/ 上包（核心修复）；
//   C2 构建指纹 define 注入（__CL_BUILD_REV__/__CL_BUILD_TIME__，main+renderer 两段）；
//   C3 指纹模块 typeof 守卫（define 未注入时不 ReferenceError，显示 unknown）；
//   C4 关于页指纹展示（about-build-rev testid）；
//   C5 主进程启动日志指纹（build <rev> @ <time>）。
// 运行：npx tsx scripts/selftest-build-freshness.ts（已登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
function readRel(p: string): string {
  return readFileSync(resolve(__dirname, '..', p), 'utf8');
}

console.log('\n=== C1) package:win 自带构建（核心修复：陈旧 out/ 不再上包） ===');
check('C1 scripts["package:win"] 精确匹配 npm run build && electron-builder --win --publish never', () => {
  const pkg = JSON.parse(readRel('package.json')) as { scripts?: Record<string, string> };
  const s = pkg.scripts?.['package:win'];
  assert.ok(
    typeof s === 'string' && /^npm run build && electron-builder --win --publish never$/.test(s),
    `实际为: ${JSON.stringify(s)}（build 失败必须短路不打包）`,
  );
});

console.log('\n=== C2) 构建指纹 define 注入（electron.vite.config.ts main+renderer 两段） ===');
check('C2 config 含 __CL_BUILD_REV__/__CL_BUILD_TIME__ 且 buildDefine 出现 ≥ 2 次', () => {
  const cfg = readRel('electron.vite.config.ts');
  assert.ok(cfg.includes('__CL_BUILD_REV__'), '缺少 __CL_BUILD_REV__');
  assert.ok(cfg.includes('__CL_BUILD_TIME__'), '缺少 __CL_BUILD_TIME__');
  const n = cfg.split('buildDefine').length - 1;
  assert.ok(n >= 2, `buildDefine 出现 ${n} 次（期望 ≥ 2：定义 + main/renderer 引用）`);
});

console.log('\n=== C3) build-info typeof 守卫（未注入不 ReferenceError） ===');
check('C3 src/shared/build-info.ts 存在且含 typeof __CL_BUILD_REV__ 守卫', () => {
  const p = 'src/shared/build-info.ts';
  assert.ok(existsSync(resolve(__dirname, '..', p)), `${p} 不存在`);
  assert.ok(readRel(p).includes('typeof __CL_BUILD_REV__'), 'typeof 守卫缺失');
});

console.log('\n=== C4) 关于页构建指纹展示 ===');
check('C4 ConfigPage.vue 含 about-build-rev testid', () => {
  assert.ok(readRel('src/renderer/pages/ConfigPage.vue').includes('about-build-rev'), 'about-build-rev 缺失');
});

console.log('\n=== C5) 主进程启动日志指纹 ===');
check('C5 src/main/index.ts 含 BUILD_REV 接线', () => {
  assert.ok(readRel('src/main/index.ts').includes('BUILD_REV'), 'BUILD_REV 缺失');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
