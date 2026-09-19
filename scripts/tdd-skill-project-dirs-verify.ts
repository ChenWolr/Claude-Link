// tdd-skill-project-dirs-verify.ts
// 项目级 Skill 管理（方案 B 双栏 master-detail）TDD 契约
// （docs/plans/2026-09-17-project-skill-master-detail-plan.md §4.9；review-round3 修复轮 R-1~R-3 增改；
// review-round4 修复轮 R-5 增改：空/纯空白 name 回退子目录名）。
// 共 16 条断言，四组：
// 组1 纯函数行为（①-⑤）：src/shared/project-skills.ts（新增纯函数模块）；
// 组2 主进程枚举链（⑥-⑪）：enumerateProjectSkills/collectSkillProjectDirs 真实 fs 行为
//      （临时夹具在 D:\software\Cache，绝不触碰仓库/用户数据）+ 源形钉
//      （ipc-handlers 三源接线 / session-repo GROUP BY / ipc 通道 / preload 暴露）。
//      R-1 起全链 async（node:fs/promises + withTimeout 3s 预算），⑥⑦ 改 await 直跑；
//      R-2 起单目录同名去重（first-wins），⑥ 夹具含同目录同名对 dup-a/dup-b（name: twin）；
//      R-5 起空/纯空白 name 视同缺省，⑥ 夹具含空 name 夹具 blank-name（name: 空行，回退子目录名）；
// 组3 渲染层形态钉（⑫-⑮）：ConfigPage 双栏结构 + 目录存在性语义文案 + 同名联动徽章
//      （⑭ 含按作用域计数键 `project:${path}` 形态钉）+ watch(projectDirs) 幽灵作用域回退钉（⑫）+
//      ⑮/㉑/㉓ 旧契约字面回归钉（防手滑破 tdd-skill-overrides-verify.ts 的 24 条）；
// 组4 行为回归（⑯）：spawn tdd-skill-overrides-verify.ts exit 0（旧 24 条不破的实测门）。
//
// 修复轮 RED 预期（对未修复工作树）：⑥⑦（twin 未去重/条数 6≠5）、⑧（无 async 形态）、
// ⑫（缺 watch(projectDirs）、⑭（缺作用域键）FAIL，其余 PASS——新增/改动断言未过、基线不破。
// 留证：D:\software\Cache\claude-link\project-skill-impl\red-r2.log（首轮 RED 见 red.log）。
// R-5 轮 RED 预期（对未修复工作树）：⑥（blank-name 产出空串名条目）、⑧（缺 fm.name?.trim() 钉）
// FAIL——⑥ 实际数组首条为 ""（空名直通未回退），⑦ 条数 6=6 不构成区分（未修代码也吐 6 条，
// 区分力在 ⑥ 的空串与 ⑧ 的源钉）；留证：同目录 red-r3.log。
// GREEN 目标：16/16 全 PASS。
//
// 运行：npx tsx scripts/tdd-skill-project-dirs-verify.ts（不启动 Electron、不碰 better-sqlite3，
// 无 ABI respawn 需求——被测模块只依赖 node:fs/promises/node:path；
// ⑥⑦ 为 await 断言，断言体包 async main 执行——tsx CJS 无顶层 await，先例教训）。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');

function readRel(p: string): string {
  const abs = path.resolve(repoRoot, p);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8');
}

let pass = 0;
let fail = 0;
function check(no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// 组1/组2 被测模块（RED 阶段不存在 → require 失败降级为断言 FAIL，脚本不 crash）。
let sharedMod: any = null;
let sharedModErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  sharedMod = require(path.resolve(repoRoot, 'src', 'shared', 'project-skills.ts'));
} catch (e) {
  sharedModErr = errMsg(e);
}
let mainMod: any = null;
let mainModErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  mainMod = require(path.resolve(repoRoot, 'src', 'main', 'modules', 'project-skills.ts'));
} catch (e) {
  mainModErr = errMsg(e);
}

// ⑥⑦ 为 await 断言（R-1 起 enumerate/collect 为 async），整脚本包 async main 执行。
async function main(): Promise<void> {
// ── 组1 纯函数行为（src/shared/project-skills.ts）──────────────────────────

console.log('\n=== 组1 纯函数行为（shared/project-skills.ts） ===');

// ① normalizeDirKey：trim + 正斜杠归反斜杠 + 去尾部分隔符 + 小写 → 大小写/斜杠不敏感归一键
{
  const sub: string[] = [];
  const fn: unknown = sharedMod?.normalizeDirKey;
  if (typeof fn !== 'function') {
    sub.push(`导出 normalizeDirKey 不可用${sharedModErr ? `（模块加载失败：${sharedModErr.slice(0, 120)}）` : ''}`);
  } else {
    const n = fn as (d: string) => string;
    if (n('D:\\a\\B\\') !== n('d:/a/b')) sub.push(`'D:\\a\\B\\'(${n('D:\\a\\B\\')}) ≠ 'd:/a/b'(${n('d:/a/b')}) 应同键`);
    if (n('D:\\code\\x') !== n('d:\\code\\X')) sub.push('仅大小写差异应同键');
    if (n('D:\\code\\x\\') !== n('D:\\code\\x')) sub.push('尾分隔符应归一');
    if (n('  D:/code/x ') !== n('d:\\code\\x')) sub.push('两端空白应 trim');
  }
  check('①', 'normalizeDirKey：大小写/正反斜杠/尾分隔符/空白归一到同一键', sub.length === 0, sub.join('; '));
}

// ② basenameOfDir：按 [\\/] 切尾段（win32/posix 兼容，纯函数不用 path 模块）
{
  const sub: string[] = [];
  const fn: unknown = sharedMod?.basenameOfDir;
  if (typeof fn !== 'function') {
    sub.push(`导出 basenameOfDir 不可用${sharedModErr ? `（模块加载失败：${sharedModErr.slice(0, 120)}）` : ''}`);
  } else {
    const b = fn as (d: string) => string;
    if (b('D:\\Code\\DemoSuite\\viewer') !== 'viewer') sub.push('反斜杠路径尾段应取最后一段');
    if (b('D:/Code/DemoSuite/viewer/') !== 'viewer') sub.push('正斜杠+尾分隔符应取尾段');
    if (b(' lone-dir') !== 'lone-dir') sub.push('裸名（含空白 trim）应原样返回尾段');
  }
  check('②', 'basenameOfDir：win32/posix 分隔符与尾分隔符均取末段', sub.length === 0, sub.join('; '));
}

// ③ mergeProjectDirs：recentDirs 保序在前 ∪ defaultDir；同键合并 isDefault=true 不重复
{
  const sub: string[] = [];
  const fn: unknown = sharedMod?.mergeProjectDirs;
  if (typeof fn !== 'function') {
    sub.push(`导出 mergeProjectDirs 不可用${sharedModErr ? `（模块加载失败：${sharedModErr.slice(0, 120)}）` : ''}`);
  } else {
    const m = fn as (recent: string[], def: string | null) => Array<{ path: string; isDefault: boolean }>;
    // 并集保序：recent 在前，default 仅追加新键
    const r1 = m(['D:\\b', 'D:\\a'], 'D:\\c');
    if (!deepEq(r1.map((e) => [e.path, e.isDefault]), [['D:\\b', false], ['D:\\a', false], ['D:\\c', true]]))
      sub.push(`并集保序失败：${JSON.stringify(r1)}`);
    // 同键不同写法（大小写/斜杠）→ 合并为一条 isDefault=true，显示串保留 recent 原串
    const r2 = m(['D:\\Code\\ProjA\\'], 'd:/code/proja');
    if (r2.length !== 1) sub.push(`default 与 recent 同键应合并为一条，实际 ${r2.length} 条`);
    else if (r2[0].isDefault !== true) sub.push('合并条 isDefault 应为 true');
    else if (r2[0].path !== 'D:\\Code\\ProjA\\') sub.push(`显示串应保留 recentDirs 原串，实际 ${JSON.stringify(r2[0].path)}`);
    // defaultDir=null → 全部 isDefault=false
    const r3 = m(['D:\\x'], null);
    if (r3.length !== 1 || r3[0].isDefault !== false) sub.push('defaultDir=null 时 isDefault 应为 false');
    // recentDirs 空 + default 存在 → 用 default 原串
    const r4 = m([], 'D:\\only-default');
    if (!deepEq(r4.map((e) => [e.path, e.isDefault]), [['D:\\only-default', true]])) sub.push(`空 recent + default 应产出一条，实际 ${JSON.stringify(r4)}`);
    // B1：双空 → 空数组
    if (!deepEq(m([], null), [])) sub.push('recentDirs 空 + defaultDir=null 应返回空数组');
  }
  check('③', 'mergeProjectDirs：并集保序；同键合并 isDefault；null/空边界', sub.length === 0, sub.join('; '));
}

// ④ sortProjectDirs：isDefault 置顶 + basename localeCompare 字典序；空数组；不改入参
{
  const sub: string[] = [];
  const fn: unknown = sharedMod?.sortProjectDirs;
  if (typeof fn !== 'function') {
    sub.push(`导出 sortProjectDirs 不可用${sharedModErr ? `（模块加载失败：${sharedModErr.slice(0, 120)}）` : ''}`);
  } else {
    const s = fn as <T extends { path: string; isDefault: boolean }>(dirs: T[]) => T[];
    const input = [
      { path: 'D:\\zeta', isDefault: false },
      { path: 'D:\\alpha', isDefault: false },
      { path: 'D:\\mid', isDefault: true },
    ];
    const out = s(input);
    if (!deepEq(out.map((d) => d.path), ['D:\\mid', 'D:\\alpha', 'D:\\zeta']))
      sub.push(`默认应置顶其余字典序，实际 ${JSON.stringify(out.map((d) => d.path))}`);
    if (deepEq(input.map((d) => d.path), ['D:\\mid', 'D:\\alpha', 'D:\\zeta'])) sub.push('不应改动入参顺序（须返回新数组）');
    if (!deepEq(s([]), [])) sub.push('空数组应返回空数组');
  }
  check('④', 'sortProjectDirs：默认置顶 + 字典序；空数组；不改入参', sub.length === 0, sub.join('; '));
}

// ⑤ parseSkillFrontmatter：标准块 / CRLF / BOM / 引号值 / 无分隔符→null / 无 name 键 / 首块不误切
{
  const sub: string[] = [];
  const fn: unknown = sharedMod?.parseSkillFrontmatter;
  if (typeof fn !== 'function') {
    sub.push(`导出 parseSkillFrontmatter 不可用${sharedModErr ? `（模块加载失败：${sharedModErr.slice(0, 120)}）` : ''}`);
  } else {
    const p = fn as (c: string) => { name: string | null; description: string | null } | null;
    // 标准块
    const r1 = p('---\nname: alpha\ndescription: do things\n---\nbody');
    if (!r1 || r1.name !== 'alpha' || r1.description !== 'do things') sub.push(`标准块解析失败：${JSON.stringify(r1)}`);
    // CRLF
    const r2 = p('---\r\nname: beta\r\ndescription: crlf desc\r\n---\r\nbody');
    if (!r2 || r2.name !== 'beta' || r2.description !== 'crlf desc') sub.push(`CRLF 解析失败：${JSON.stringify(r2)}`);
    // BOM
    const r3 = p('\uFEFF---\nname: bom-skill\n---\nbody');
    if (!r3 || r3.name !== 'bom-skill') sub.push(`BOM 解析失败：${JSON.stringify(r3)}`);
    // 引号值：成对 " 与 ' 各剥一层
    const r4 = p('---\nname: "quoted"\ndescription: \'single\'\n---\n');
    if (!r4 || r4.name !== 'quoted' || r4.description !== 'single') sub.push(`引号值应剥一层：${JSON.stringify(r4)}`);
    const r5 = p('---\nname: "unbalanced\n---\n');
    if (!r5 || r5.name !== '"unbalanced') sub.push(`不成对引号应保留原值：${JSON.stringify(r5)}`);
    // 无分隔符 → null（引擎亦不加载 → 调用方跳过）
    if (p('no frontmatter here\nname: fake') !== null) sub.push('无分隔符应返回 null');
    if (p('--- name: inline\n') !== null) sub.push('首行非独立 --- 分隔行应返回 null');
    // 块内无 name 键 → name=null（调用方以子目录名兜底）
    const r6 = p('---\ndescription: only desc\n---\nbody');
    if (!r6 || r6.name !== null || r6.description !== 'only desc') sub.push(`无 name 键应 {name:null}：${JSON.stringify(r6)}`);
    // 首块后正文含 --- 不误切
    const r7 = p('---\nname: bodydashes\n---\nlater\n---\nmore');
    if (!r7 || r7.name !== 'bodydashes') sub.push(`首块后正文 --- 不应误切：${JSON.stringify(r7)}`);
    // 其余键忽略
    const r8 = p('---\nname: k\nallowed-tools: Bash\ndescription: d\n---\n');
    if (!r8 || r8.name !== 'k' || r8.description !== 'd') sub.push(`其余键应忽略：${JSON.stringify(r8)}`);
  }
  check('⑤', 'parseSkillFrontmatter：标准/CRLF/BOM/引号值；无分隔符→null；无 name→null；首块不误切', sub.length === 0, sub.join('; '));
}

// ── 组2 主进程枚举链（fs 行为 + 源形钉）────────────────────────────────────

console.log('\n=== 组2 主进程枚举链（enumerateProjectSkills / collectSkillProjectDirs / 接线） ===');

// 临时夹具（D:\software\Cache，绝不触碰仓库与用户数据；用毕清理）。
const fixtureRoot = path.join('D:\\software\\Cache', 'claude-link', 'project-skill-impl', `tdd-fixture-${process.pid}-${Date.now()}`);
function writeSkill(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}
try {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  // proj-a：混合形态（正常/引号/CRLF/BOM/无 frontmatter/无 name/普通文件/SKILL.md 为目录/
  // 同目录同名对 dup-a+dup-b（R-2：单目录同名只保留一条）/空 name 行 blank-name（R-5：回退子目录名））
  const projA = path.join(fixtureRoot, 'proj-a');
  writeSkill(projA, path.join('.claude', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: "quoted desc"\n---\nbody');
  writeSkill(projA, path.join('.claude', 'skills', 'beta', 'SKILL.md'), '---\r\nname: beta\r\ndescription: crlf desc\r\n---\r\nbody');
  writeSkill(projA, path.join('.claude', 'skills', 'gamma', 'SKILL.md'), '\uFEFF---\nname: bom-name\n---\nbody');
  writeSkill(projA, path.join('.claude', 'skills', 'delta', 'SKILL.md'), 'no frontmatter here');
  writeSkill(projA, path.join('.claude', 'skills', 'zeta', 'SKILL.md'), '---\ndescription: desc only\n---\nbody');
  writeSkill(projA, path.join('.claude', 'skills', 'dup-a', 'SKILL.md'), '---\nname: twin\ndescription: same-dir dup a\n---\nbody');
  writeSkill(projA, path.join('.claude', 'skills', 'dup-b', 'SKILL.md'), '---\nname: twin\ndescription: same-dir dup b\n---\nbody');
  writeSkill(projA, path.join('.claude', 'skills', 'blank-name', 'SKILL.md'), '---\nname:\ndescription: blank desc\n---\nbody'); // R-5：name 空行 → 回退子目录名
  fs.mkdirSync(path.join(projA, '.claude', 'skills', 'eta-isdir', 'SKILL.md'), { recursive: true }); // SKILL.md 为目录 → 读失败跳过
  writeSkill(projA, path.join('.claude', 'skills', 'plain.md'), 'file not dir');
  // proj-b：与 proj-a 存在同名 skill（渲染层「同名 · 联动」场景的数据基础）
  const projB = path.join(fixtureRoot, 'proj-b');
  writeSkill(projB, path.join('.claude', 'skills', 'alpha', 'SKILL.md'), '---\nname: shared-name\ndescription: dup across dirs\n---\n');
  // proj-c：无 .claude/skills（B4 空态）
  fs.mkdirSync(path.join(fixtureRoot, 'proj-c'), { recursive: true });
  // 非目录条目（stat 通过但 isDirectory()=false → 剔除）
  fs.writeFileSync(path.join(fixtureRoot, 'file-as-dir.txt'), 'x', 'utf8');

  // ⑥ enumerateProjectSkills 行为（§3.2 口径 + R-2 单目录同名去重）
  {
    const sub: string[] = [];
    const fn: unknown = mainMod?.enumerateProjectSkills;
    if (typeof fn !== 'function') {
      sub.push(`导出 enumerateProjectSkills 不可用${mainModErr ? `（模块加载失败：${mainModErr.slice(0, 120)}）` : ''}`);
    } else {
      const e = fn as (dir: string) => Promise<Array<{ name: string; description: string }>>;
      // proj-a：6 个合法 skill（dup-a/dup-b 同名 twin 去重为一条；blank-name 空 name 回退子目录名，R-5），
      // 按 name 字典序（实测 localeCompare 序：beta < blank-name < bom-name）；非法形态全部静默跳过
      const outA = await e(projA);
      if (!deepEq(outA.map((s) => s.name), ['alpha', 'beta', 'blank-name', 'bom-name', 'twin', 'zeta']))
        sub.push(`proj-a 应得 [alpha,beta,blank-name,bom-name,twin,zeta]（dup 同名去重为一条；blank-name 空名回退子目录名；delta 无 frontmatter/eta 目录/plain.md 跳过），实际 ${JSON.stringify(outA.map((s) => s.name))}`);
      else {
        if (outA.filter((s) => s.name === 'twin').length !== 1) sub.push(`同目录同名 twin 应恰一条（first-wins），实际 ${outA.filter((s) => s.name === 'twin').length} 条`);
        if (outA[0].description !== 'quoted desc') sub.push(`alpha 引号值应剥一层，实际 ${JSON.stringify(outA[0].description)}`);
        if (outA[1].description !== 'crlf desc') sub.push(`beta CRLF 值应干净，实际 ${JSON.stringify(outA[1].description)}`);
        if (outA[2].name !== 'blank-name' || outA[2].description !== 'blank desc') sub.push(`blank-name 空 name 应回退子目录名且描述仍取 frontmatter，实际 ${JSON.stringify(outA[2])}`);
        if (outA[5].name !== 'zeta' || outA[5].description !== 'desc only') sub.push(`zeta 无 name 键应以子目录名兜底，实际 ${JSON.stringify(outA[5])}`);
      }
      // B4：目录无 .claude/skills → []
      if (!deepEq(await e(path.join(fixtureRoot, 'proj-c')), [])) sub.push('proj-c 无 .claude/skills 应返回 []');
      // skillsRoot 不存在（ENOENT）→ []
      if (!deepEq(await e(path.join(fixtureRoot, 'no-such-dir')), [])) sub.push('ENOENT 应返回 []');
    }
    check('⑥', 'enumerateProjectSkills：合法六条去重后按字典序（同目录同名 first-wins；空 name 回退子目录名）；无 frontmatter/普通文件/SKILL.md 为目录跳过；缺省兜底；ENOENT 空', sub.length === 0, sub.join('; '));
  }

  // ⑦ collectSkillProjectDirs 行为（merge → sort → stat 过滤 → 枚举 → 会话计数并入）
  {
    const sub: string[] = [];
    const fn: unknown = mainMod?.collectSkillProjectDirs;
    if (typeof fn !== 'function') {
      sub.push(`导出 collectSkillProjectDirs 不可用${mainModErr ? `（模块加载失败：${mainModErr.slice(0, 120)}）` : ''}`);
    } else {
      const c = fn as (input: { recentDirs: string[]; defaultDir: string | null; sessionCounts: Map<string, number> }) =>
        Promise<Array<{ path: string; name: string; isDefault: boolean; sessionCount: number; skills: Array<{ name: string; description: string }> }>>;
      const recentA = `${projA}\\`;                                   // 尾分隔符写法
      const defaultA = projA.replace(/\\/g, '/');                     // 正斜杠写法（同键不同写法，B3）
      const counts = new Map<string, number>([
        [projB, 2],
        [projB.replace(/\\/g, '/').toUpperCase(), 5],                 // 不同写法的会话计数应按归一键聚合（B10）
      ]);
      const out = await c({
        recentDirs: [projB, path.join(fixtureRoot, 'no-such-dir-xyz'), path.join(fixtureRoot, 'file-as-dir.txt'), recentA],
        defaultDir: defaultA,
        sessionCounts: counts,
      });
      // stat 过滤：不存在目录与文件条目剔除；排序：默认置顶
      if (!deepEq(out.map((d) => d.name), ['proj-a', 'proj-b']))
        sub.push(`应仅 [proj-a(默认置顶), proj-b]，实际 ${JSON.stringify(out.map((d) => d.name))}`);
      else {
        if (out[0].isDefault !== true) sub.push('proj-a 同键合并后 isDefault 应为 true');
        if (out[0].path !== recentA) sub.push(`显示串应保留 recentDirs 原串（含尾分隔符），实际 ${JSON.stringify(out[0].path)}`);
        if (out[0].skills.length !== 6) sub.push(`proj-a skills 应 6 条（同名 twin 去重 + blank-name 空名回退），实际 ${out[0].skills.length}`);
        if (out[0].sessionCount !== 0) sub.push(`proj-a 无会话应 0，实际 ${out[0].sessionCount}`);
        if (out[1].sessionCount !== 7) sub.push(`proj-b 不同写法计数应聚合为 7，实际 ${out[1].sessionCount}`);
        if (!deepEq(out[1].skills.map((s) => s.name), ['shared-name'])) sub.push(`proj-b skills 应 [shared-name]，实际 ${JSON.stringify(out[1].skills.map((s) => s.name))}`);
      }
      // B1：双空输入 → []
      if (!deepEq(await c({ recentDirs: [], defaultDir: null, sessionCounts: new Map() }), [])) sub.push('空输入应返回 []');
    }
    check('⑦', 'collectSkillProjectDirs：stat 过滤（不存在/文件）+ 默认置顶 + 同键合并 + 计数聚合 + 去重后条数 + 空边界', sub.length === 0, sub.join('; '));
  }
} finally {
  try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}

// ⑧ 主模块源形钉（R-1 async 形态）：node:fs/promises、withTimeout(3s, Promise.race+clearTimeout)、
//    fs.stat 超时剔除、整目录枚举超时→空；isDirectory/8192/parseSkillFrontmatter/静默失败/R-2 去重
{
  const src = readRel('src/main/modules/project-skills.ts');
  const sub: string[] = [];
  if (!src) sub.push('src/main/modules/project-skills.ts 不存在');
  else {
    if (!src.includes('node:fs/promises')) sub.push("缺 node:fs/promises 导入（R-1 全链 async）");
    if (!/async function withTimeout/.test(src)) sub.push('缺 async function withTimeout 定义（超时归 null）');
    if (!src.includes('3000')) sub.push('缺 3000 字面（每目录 3s 超时预算，针对不可达 UNC/断连映射盘）');
    if (!/Promise\.race/.test(src)) sub.push('withTimeout 应以 Promise.race 实现');
    if (!src.includes('clearTimeout')) sub.push('超时定时器应 clearTimeout 清理');
    if (!/await\s+withTimeout\(fs\.stat\(/.test(src)) sub.push('逐目录存在性检查应为 await withTimeout(fs.stat(...)) 形态（超时/抛错/非目录一律剔除）');
    if (!/withTimeout\([\s\S]{0,60}enumerateProjectSkills[\s\S]{0,60}\?\? \[\]/.test(src)) sub.push('整目录枚举应包 withTimeout 且超时回退 skills=[]（超时→空语义）');
    if (!/async function enumerateProjectSkills/.test(src)) sub.push('enumerateProjectSkills 应为 async');
    if (!/async function collectSkillProjectDirs/.test(src)) sub.push('collectSkillProjectDirs 应为 async');
    if (!src.includes('isDirectory()')) sub.push('缺 isDirectory() 判定');
    if (!src.includes('8192')) sub.push('缺 8192 截断（前 8192 字符解析 frontmatter）');
    if (!src.includes('parseSkillFrontmatter')) sub.push('应经 parseSkillFrontmatter 解析（§3.2 口径）');
    if (!/catch[\s\S]{0,120}?(return \[\]|continue)/.test(src)) sub.push('读失败应静默（catch → return [] / continue）');
    if (!/first-wins|按 name 去重/.test(src)) sub.push('缺单目录同名去重（first-wins，R-2）');
    if (!src.includes('fm.name?.trim()')) sub.push('缺空/纯空白 name 回退子目录名钉（fm.name?.trim()，R-5：空串经 ?? 不回退）');
  }
  check('⑧', 'project-skills.ts（主进程）：fs/promises + withTimeout(3000, race+clearTimeout) + fs.stat 超时剔除 + 枚举超时→空 + isDirectory/8192/静默失败/同名去重/空 name 回退钉', sub.length === 0, sub.join('; '));
}

// ⑨ ipc-handlers.ts：SKILL_PROJECT_DIRS_GET 注册 + 三源形态（R-1 起 await collectSkillProjectDirs）
{
  const src = readRel('src/main/ipc-handlers.ts');
  const at = src.indexOf('ipcMain.handle(IPC_CHANNELS.SKILL_PROJECT_DIRS_GET');
  const region = at >= 0 ? src.slice(at, at + 700) : '';
  const sub: string[] = [];
  if (at < 0) sub.push('缺 SKILL_PROJECT_DIRS_GET handler 注册');
  else {
    if (!/dirs:\s*await\s+collectSkillProjectDirs/.test(region)) sub.push('handler 应 await collectSkillProjectDirs（R-1 async 化）');
    if (!region.includes('listRecentWorkspaces()')) sub.push('缺 listRecentWorkspaces() 来源');
    if (!region.includes('workingDirectory')) sub.push('缺 config.workingDirectory 来源');
    if (!region.includes('listWorkingDirCounts()')) sub.push('缺 listWorkingDirCounts() 来源');
  }
  check('⑨', 'ipc-handlers.ts：SKILL_PROJECT_DIRS_GET 注册在位，await 三源齐（recent/default/counts）', sub.length === 0, sub.join('; '));
}

// ⑩ session-repo.ts：listWorkingDirCounts 只读函数 + GROUP BY 形态
{
  const src = readRel('src/main/database/repositories/session-repo.ts');
  const at = src.indexOf('export function listWorkingDirCounts');
  const region = at >= 0 ? src.slice(at, at + 700) : '';
  const sub: string[] = [];
  if (at < 0) sub.push('缺 export function listWorkingDirCounts');
  else {
    if (!region.includes('GROUP BY working_dir')) sub.push('缺 GROUP BY working_dir（原文分组）');
    if (!region.includes('working_dir IS NOT NULL')) sub.push('缺 working_dir IS NOT NULL（NULL 行不进计数）');
    if (!region.includes('Map')) sub.push('返回形态应为 Map<string, number>');
  }
  check('⑩', 'session-repo.ts：listWorkingDirCounts 原文分组计数（GROUP BY working_dir，NULL 排除）', sub.length === 0, sub.join('; '));
}

// ⑪ 通道与暴露：ipc.ts 字面 + preload 接口与实现
{
  const ipc = readRel('src/shared/types/ipc.ts');
  const preload = readRel('src/preload/api.ts');
  const sub: string[] = [];
  if (!ipc.includes("SKILL_PROJECT_DIRS_GET: 'skills:projectDirsGet'")) sub.push("ipc.ts 缺 SKILL_PROJECT_DIRS_GET: 'skills:projectDirsGet'");
  if (!preload.includes('getSkillProjectDirs: () => Promise<SkillProjectDirsPayload>;')) sub.push('preload 接口缺 getSkillProjectDirs 声明');
  if (!preload.includes('ipcRenderer.invoke(IPC_CHANNELS.SKILL_PROJECT_DIRS_GET)')) sub.push('preload 实现缺 IPC_CHANNELS.SKILL_PROJECT_DIRS_GET invoke');
  check('⑪', "ipc.ts 通道字面 'skills:projectDirsGet' + preload 接口/实现双暴露", sub.length === 0, sub.join('; '));
}

// ── 组3 渲染层形态钉（ConfigPage.vue 双栏）─────────────────────────────────

console.log('\n=== 组3 渲染层形态钉（ConfigPage.vue 双栏 master-detail + 旧契约回归钉） ===');

// ⑫ 双栏结构 + 作用域状态 + 现查接线 + 幽灵作用域回退（R-3）
{
  const src = readRel('src/renderer/pages/ConfigPage.vue');
  const watchAt = src.indexOf('watch(activeTab');
  const watchBody = watchAt >= 0 ? src.slice(watchAt, watchAt + 400) : '';
  const sub: string[] = [];
  if (!src.includes('class="skill-md-body"')) sub.push('缺 .skill-md-body 双栏容器');
  if (!src.includes('skill-md-rail') || !src.includes('skill-md-main')) sub.push('缺 skill-md-rail / skill-md-main 双栏');
  if (!/type SkillScope\s*=\s*\{\s*kind:\s*'global'\s*\}\s*\|\s*\{\s*kind:\s*'project'/.test(src)) sub.push("缺 SkillScope 联合类型（global | project）");
  if (!src.includes('async function ensureProjectDirs')) sub.push('缺 ensureProjectDirs 定义');
  if (!src.includes('void ensureProjectDirs()')) sub.push('watch 接线缺 void ensureProjectDirs() 调用');
  if (!src.includes('getSkillProjectDirs')) sub.push('缺 window.claudeLink.getSkillProjectDirs 消费');
  if (!src.includes('scopeItems')) sub.push('缺 scopeItems 作用域全集 computed');
  if (!src.includes('watch(projectDirs')) sub.push('缺 watch(projectDirs) 幽灵作用域回退（R-3：选中目录被现查淘汰自动回全局）');
  check('⑫', 'ConfigPage：skill-md-body/rail/main 双栏 + SkillScope 类型 + ensureProjectDirs 定义与 watch 接线 + watch(projectDirs) 回退', sub.length === 0, sub.join('; '));
}

// ⑬ 目录存在性语义文案钉（用户需求 5 留证）+ rail meta 形态
{
  const src = readRel('src/renderer/pages/ConfigPage.vue');
  const footAt = src.indexOf('skill-md-rail__foot');
  const foot = footAt >= 0 ? src.slice(footAt, footAt + 400) : '';
  const sub: string[] = [];
  if (footAt < 0) sub.push('缺 skill-md-rail__foot 底注');
  else {
    if (!foot.includes('不再显示')) sub.push('rail foot 应含「已删除的目录不再显示」存在性语义文案');
    if (!foot.includes('最近工作区')) sub.push('rail foot 应说明目录来源（最近工作区并集与默认工作区）');
  }
  if (!/skill-md-item__meta[\s\S]{0,300}?会话/.test(src) && !src.includes('dir.sessionCount')) sub.push('目录行 meta 应含会话计数（sessionCount）');
  if (!src.includes('共 {{')) sub.push('目录行 meta 应含「共 N」计数形态');
  check('⑬', 'rail foot 目录口径文案（含「不再显示」）+ 目录行 meta 三段（共/启用/会话）', sub.length === 0, sub.join('; '));
}

// ⑭ 同名联动徽章（R-2 按作用域计数：'global' 与 `project:${path}` 键）+ 作用域徽章（项目=紫/全局=蓝）
{
  const src = readRel('src/renderer/pages/ConfigPage.vue');
  const style = src;
  const sub: string[] = [];
  if (!src.includes('同名 · 联动')) sub.push('卡片应含「同名 · 联动」徽章文案');
  if (!src.includes('dup-badge')) sub.push('缺 dup-badge 类');
  if (!src.includes('scope-badge') || !src.includes('scope-badge--project')) sub.push('缺 scope-badge / scope-badge--project 作用域徽章');
  if (!style.includes('#7C5CFC')) sub.push('项目紫应写字面 #7C5CFC（不新增全局 token）');
  if (!src.includes('`project:${dir.path}`')) sub.push('dupSkillNames 应按作用域键计数（`project:${dir.path}` 形态，R-2：≥2 作用域才徽章）');
  if (!/set\.size\s*>=\s*2/.test(src)) sub.push('徽章条件应为作用域 Set 计数 size >= 2');
  check('⑭', '同名 · 联动徽章按作用域计数（global/project:<path> 键，size≥2）+ scope-badge 双色 + 项目紫字面', sub.length === 0, sub.join('; '));
}

// ⑮ 旧契约回归钉：⑮/㉑/㉓ 六字面在改后源码仍命中（防手滑破 tdd-skill-overrides-verify 24 条）
{
  const src = readRel('src/renderer/pages/ConfigPage.vue');
  const watchAt = src.indexOf('watch(activeTab');
  const watchBody = watchAt >= 0 ? src.slice(watchAt, watchAt + 400) : '';
  const sub: string[] = [];
  if (!/type TabId\s*=\s*[^;\n]*'skill'/.test(src)) sub.push("TabId 联合类型缺 'skill'（⑮）");
  if (!src.includes('data-testid="skill-manage-section"')) sub.push('缺 data-testid="skill-manage-section"（⑮）');
  if (!/PERSISTED_FIELDS\s*=\s*\[[\s\S]{0,800}?'skillOverrides'/.test(src)) sub.push("PERSISTED_FIELDS 缺 'skillOverrides'（⑮）");
  if (!src.includes("!== 'off'")) sub.push("缺 !== 'off' 启用语义（⑮）");
  if (!src.includes('<div v-if="!skillProbePending" class="stat-grid">')) sub.push('缺 stat-grid 门控字面（㉑）');
  if (!src.includes('v-if="!skillProbePending && visibleSkills.length === 0"')) sub.push('缺空态臂门控字面（㉑）');
  if (!(watchAt >= 0 && watchBody.includes("'skill'") && watchBody.includes('ensureGlobalSnapshot'))) sub.push("watch(activeTab) 缺 'skill' → ensureGlobalSnapshot 接线（㉓）");
  check('⑮', '回归钉：⑮/㉑/㉓ 六处契约字面在双栏改后源码仍命中', sub.length === 0, sub.join('; '));
}

// ── 组4 行为回归 ────────────────────────────────────────────────────────────

console.log('\n=== 组4 行为回归（旧 24 条契约不破） ===');

// ⑯ spawn tdd-skill-overrides-verify.ts exit 0（实测门：含其内部组4 再 spawn regression-tests.ts）。
{
  const r = spawnSync('npx', ['tsx', 'scripts/tdd-skill-overrides-verify.ts'], {
    cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32',
  });
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-300).trim();
  check('⑯', 'tdd-skill-overrides-verify.ts 旧 24 条零重指全绿（exit 0）',
    r.status === 0,
    r.status === 0 ? '' : `exit=${r.status}${r.error ? ` err=${String(r.error)}` : ''}\n${tail}`);
}

console.log(`\n===== tdd-skill-project-dirs-verify: ${pass} pass / ${fail} fail =====`);
if (fail > 0) console.log('（RED 阶段：FAIL 项为尚未实施的生产改动，实施后应全 PASS）');
process.exit(fail > 0 ? 1 : 0);
}

void main().catch((e: unknown) => {
  console.error('runner crash:', e);
  process.exit(1);
});
