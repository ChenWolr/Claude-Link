// tdd-skill-ghost-fallback-verify.ts
// A-2/D-10（review 2026-09-18 §3-13）：归一键等价类与幽灵回退——ConfigPage 三处目录匹配
// （watch(projectDirs) 幽灵回退 / activeProjectDir / scopeItems）按 path 原串全等，同键不同写法
//（大小写/斜杠/尾分隔符，recent 淘汰换幸存串时）会被误判「目录已不在清单」→ 误回退全局/双条目
// 分裂。整改 = 三处统一改 normalizeDirKey 相等（shared 纯函数渲染层 import）；
// realpath 级等价类（映射盘↔UNC/8.3/\\?\）不做，登记已知限制。
// 断言：①夹具行为——同键两写法在新谓词（normalizeDirKey 相等）下命中、旧谓词（===）失配
// （缺陷复现 + 修复谓词行为钉，normalizeDirKey 真函数直调）②ConfigPage 三处消费形态钉。
// RED 预期（未修复树）：② FAIL。运行：npx tsx scripts/tdd-skill-ghost-fallback-verify.ts。

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(repoRoot, 'src/renderer/pages/ConfigPage.vue'), 'utf8');

let pass = 0;
let fail = 0;
function check(no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main(): Promise<void> {
  // ① 夹具行为：同键两写法——旧谓词误判「不在清单」，新谓词（normalizeDirKey）正确命中
  {
    let mod: any = null;
    let err = '';
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require(path.resolve(repoRoot, 'src', 'shared', 'project-skills.ts'));
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    const n: unknown = mod?.normalizeDirKey;
    const sub: string[] = [];
    if (typeof n !== 'function') {
      sub.push(`导出 normalizeDirKey 不可用${err ? `（模块加载失败：${err.slice(0, 120)}）` : ''}`);
    } else {
      const key = n as (d: string) => string;
      // 夹具：查询时幸存串换了写法（大小写 + 正斜杠 + 尾分隔符），键相同
      const scopePath = 'D:\\Code\\ProjA';
      const survivor = 'd:/code/proja/';
      const dirs = [{ path: survivor }, { path: 'D:\\other' }];
      const oldHit = dirs.some((d) => d.path === scopePath);
      const newHit = dirs.some((d) => key(d.path) === key(scopePath));
      if (oldHit) sub.push('旧谓词（===）对同键两写法竟然命中（缺陷复现前提失效）');
      if (!newHit) sub.push('新谓词（normalizeDirKey 相等）应命中同键两写法');
    }
    check('①', '夹具：同键两写法旧谓词（===）失配（幽灵回退复现）/新谓词命中', sub.length === 0, sub.join('; '));
  }

  // ② ConfigPage 三处消费形态：统一 normalizeDirKey 相等
  {
    const sub: string[] = [];
    if (!/import \{[^}]*normalizeDirKey[^}]*\} from '\.\.\/\.\.\/shared\/project-skills'/.test(src) && !/normalizeDirKey/.test(src.split('<template')[0]))
      sub.push('ConfigPage 未 import normalizeDirKey');
    const watchAt = src.indexOf('watch(projectDirs');
    const watchBody = watchAt >= 0 ? src.slice(watchAt, watchAt + 400) : '';
    if (watchAt < 0) sub.push('缺 watch(projectDirs) 幽灵回退');
    else if (!watchBody.includes('normalizeDirKey')) sub.push('幽灵回退比较未改 normalizeDirKey（仍原串全等）');
    const actAt = src.indexOf('const activeProjectDir');
    const actBody = actAt >= 0 ? src.slice(actAt, actAt + 400) : '';
    if (actAt < 0) sub.push('缺 activeProjectDir');
    else if (!actBody.includes('normalizeDirKey')) sub.push('activeProjectDir 目录匹配未改 normalizeDirKey');
    const scopeAt = src.indexOf('const scopeItems');
    const scopeBody = scopeAt >= 0 ? src.slice(scopeAt, scopeAt + 500) : '';
    if (scopeAt < 0) sub.push('缺 scopeItems');
    else if (!scopeBody.includes('normalizeDirKey')) sub.push('scopeItems 目录匹配未改 normalizeDirKey');
    check('②', 'ConfigPage：watch(projectDirs)/activeProjectDir/scopeItems 三处统一 normalizeDirKey 相等', sub.length === 0, sub.join('; '));
  }

  console.log(`\n===== tdd-skill-ghost-fallback-verify: ${pass} pass / ${fail} fail =====`);
  if (fail > 0) console.log('（RED 阶段：FAIL 项为尚未实施的生产改动，实施后应全 PASS）');
  process.exit(fail > 0 ? 1 : 0);
}

void main().catch((e: unknown) => {
  console.error('runner crash:', e);
  process.exit(1);
});
