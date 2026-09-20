// tdd-skill-enum-resilience-verify.ts
// P2-4（=A-4）枚举链线程池治理契约（2026-09-18 Skill 管理 review §2 整改）：
// ①② 坏目录负缓存行为（导出纯函数 badDirCacheMark/badDirCacheHas，now 可注入——真实不可达
//     UNC 在本机受 SMB 重定向器负缓存影响无法稳定复现慢 stat，行为级以纯函数 + 接线源形钉承载）；
// ③ A-1 巨文件行为（真实 fs 夹具）：frontmatter 闭合在前 8192B 内的 >1MB 文件可解析（内存有界），
//     闭合在 8192B 后的维持跳过（既有语义）；
// ④⑤ 源形钉：in-flight 共享（collectInFlight 早退共享 + finally 清空）、负缓存接线（循环头
//     isBadDir 跳过、仅 stat 超时 markBadDir、抛错路径不负缓存）、按字节读（Buffer.alloc(8192)+
//     filehandle.read）、SKILL_PROJECT_DIRS_GET handler 形态不变。
// RED 预期（未修复树）：①②（导出不存在）④⑤ 形态钉 FAIL；③ 为既有语义保持断言（两态皆过）。
// 运行：npx tsx scripts/tdd-skill-enum-resilience-verify.ts（真实 fs 夹具在系统临时目录（os.tmpdir））。

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const repoRoot = path.resolve(__dirname, '..');
const readRel = (p: string): string => {
  const abs = path.resolve(repoRoot, p);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
};

let pass = 0;
let fail = 0;
function check(no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

let mainMod: any = null;
let mainModErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  mainMod = require(path.resolve(repoRoot, 'src', 'main', 'modules', 'project-skills.ts'));
} catch (e) {
  mainModErr = e instanceof Error ? e.message : String(e);
}

async function main(): Promise<void> {
  console.log('\n=== 组1 坏目录负缓存行为（now 注入） ===');
  {
    const mark: unknown = mainMod?.badDirCacheMark;
    const has: unknown = mainMod?.badDirCacheHas;
    const ok = typeof mark === 'function' && typeof has === 'function';
    check('①', '导出 badDirCacheMark/badDirCacheHas（负缓存可测 seam）', ok, ok ? '' : `模块加载失败：${mainModErr.slice(0, 120)}`);
    if (ok) {
      const m = mark as (dir: string, now?: number) => void;
      const h = has as (dir: string, now?: number) => boolean;
      const t0 = 1_000_000;
      const TTL = 60_000; // 与实现常量一致（review 允许 30-60s，实现取 60s）
      m('D:\\Unc\\bad\\dir', t0);
      const sub: string[] = [];
      if (!h('D:\\Unc\\bad\\dir', t0 + 1)) sub.push('标记后 TTL 内应命中');
      if (!h('d:/unc/BAD/dir/', t0 + TTL - 1)) sub.push('normalizeDirKey 等价写法应同键命中');
      if (h('D:\\Unc\\bad\\dir', t0 + TTL)) sub.push('TTL 到点应过期（自愈）');
      if (h('D:\\Unc\\other\\dir', t0 + 1)) sub.push('未标记目录不应命中');
      m('D:\\Unc\\bad\\dir', t0 + TTL + 1);   // 过期后重标记
      if (!h('D:\\Unc\\bad\\dir', t0 + TTL + 2)) sub.push('过期后重标记应再次命中');
      check('②', '负缓存命中/等价键/TTL 过期自愈/未标记不命中/重标记', sub.length === 0, sub.join('; '));
    }
  }

  console.log('\n=== 组2 A-1 巨文件行为（真实 fs 夹具） ===');
  const fixtureRoot = path.join(os.tmpdir(), 'claude-link-fixtures', `enum-fixture-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(fixtureRoot, { recursive: true });
    const big = 'x'.repeat(1024 * 1024); // 1MB 正文
    // fm-early：frontmatter 在前 8192B 内闭合，正文 >1MB → 应可解析（字节有界读）
    fs.mkdirSync(path.join(fixtureRoot, 'fm-early', '.claude', 'skills', 'big-ok'), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'fm-early', '.claude', 'skills', 'big-ok', 'SKILL.md'), '---\nname: big-ok\ndescription: fm within first 8192B\n---\n' + big, 'utf8');
    // fm-late：frontmatter 闭合在 8192B 之后 → 维持跳过（既有语义，非本批扩大）
    fs.mkdirSync(path.join(fixtureRoot, 'fm-late', '.claude', 'skills', 'big-late'), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'fm-late', '.claude', 'skills', 'big-late', 'SKILL.md'), '---\nname: big-late\n' + 'c'.repeat(9000) + '\n---\nbody', 'utf8');

    const e: unknown = mainMod?.enumerateProjectSkills;
    const okFn = typeof e === 'function';
    check('③a', 'enumerateProjectSkills 可用', okFn, mainModErr.slice(0, 120));
    if (okFn) {
      const en = e as (dir: string) => Promise<Array<{ name: string; description: string }>>;
      const early = await en(path.join(fixtureRoot, 'fm-early'));
      const late = await en(path.join(fixtureRoot, 'fm-late'));
      check('③b', '>1MB 文件 frontmatter 在前 8192B 内 → 可解析（字节有界读，不全文读）', early.length === 1 && early[0].name === 'big-ok', `实际 ${JSON.stringify(early.map((s) => s.name))}`);
      check('③c', 'frontmatter 闭合在 8192B 后 → 维持跳过（既有语义不扩大）', late.length === 0, `实际 ${JSON.stringify(late.map((s) => s.name))}`);
    }
  } finally {
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }

  console.log('\n=== 组3 源形钉（in-flight 共享 / 负缓存接线 / 按字节读 / handler 不变） ===');
  {
    const src = readRel('src/main/modules/project-skills.ts');
    const ipc = readRel('src/main/ipc-handlers.ts');
    const sub: string[] = [];
    if (!/let collectInFlight:\s*Promise<ProjectDirEntry\[\]>\s*\|\s*null\s*=\s*null/.test(src)) sub.push('缺 collectInFlight 模块级在飞槽');
    if (!/if \(collectInFlight\) return collectInFlight;/.test(src)) sub.push('缺并发早退共享形态');
    if (!/\.finally\(\(\) => \{\s*(if \(collectInFlight === promise\)\s*)?collectInFlight = null;/.test(src)) sub.push('缺 finally 清空在飞槽');
    if (!/badDirCacheHas\(d\.path\)/.test(src)) sub.push('缺循环头负缓存跳过接线');
    if (!/badDirCacheMark\(d\.path\)/.test(src)) sub.push('缺 stat 超时标记接线');
    if (!/statTimedOut/.test(src)) sub.push('缺 stat 超时/抛错区分（仅超时负缓存，ENOENT 不缓存）');
    if (!/Buffer\.alloc\(8192\)/.test(src) || !/\.read\(buf,\s*0,\s*8192,\s*0\)/.test(src)) sub.push('缺按字节读（Buffer.alloc(8192)+filehandle.read）');
    if (!/BAD_DIR_TTL_MS = 60_000/.test(src) && !/BAD_DIR_TTL_MS = 60000/.test(src)) sub.push('缺负缓存 TTL 常量（60s）');
    check('④', 'project-skills 源形：in-flight 共享 + 负缓存接线 + 字节读 + TTL', sub.length === 0, sub.join('; '));

    const at = ipc.indexOf('IPC_CHANNELS.SKILL_PROJECT_DIRS_GET');
    const region = at >= 0 ? ipc.slice(at, at + 700) : '';
    check('⑤', 'SKILL_PROJECT_DIRS_GET handler 形态不变（await collectSkillProjectDirs 三源）', /dirs:\s*await\s+collectSkillProjectDirs/.test(region) && region.includes('listRecentWorkspaces()') && region.includes('listWorkingDirCounts()'), at < 0 ? '缺 handler' : '');
  }

  console.log(`\n===== tdd-skill-enum-resilience-verify: ${pass} pass / ${fail} fail =====`);
  process.exit(fail > 0 ? 1 : 0);
}

void main().catch((e: unknown) => {
  console.error('runner crash:', e);
  process.exit(1);
});
