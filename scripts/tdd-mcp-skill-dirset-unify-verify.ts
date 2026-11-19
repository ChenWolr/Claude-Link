// tdd-mcp-skill-dirset-unify-verify.ts
// E4「MCP/Skill 目录集口径统一」TDD 契约（docs/plans/2026-11-15-eight-issues-batch/03-test-cases-main.md
// §7 E4-01~03 + E4-S1；行为契约 00-behavior-specs.md §E4；实现细节 01-impl-details-main.md §E4-1~E4-5；
// 计划定名 04-实施计划.md §4.1：tdd-project-dir-set-unified-verify ≡ 本名）。
// 用例→断言映射：
//   组1 行为（E4-02 并集口径与封顶 12/20/去重）：① recent 段 12 封顶 + 保序（15 候选→12）；
//        ② 会话 distinct 段补足至 20（25 候选→取 8）；③ 跨来源重复单条目（recent 原串保留）；
//        ④ 默认目录不入函数输出、由消费点 mergeProjectDirs 并入（isDefault 单条）；
//        ⑤ dirCap 参数化封顶（recent 优先）。
//   组2 行为退化输入（E4-03）：⑥ 空集→[]（组合后仅默认目录）；⑦ 三来源全同→恰 1 条；
//        ⑧ 大小写/斜杠/尾分隔符变体→归一单条。
//   组3 结构钉（E4-01 单一真相源）：⑨ 两文件同 import 符号；⑩ SKILL handler 换源零内联残留；
//        ⑪ MCP_SNAPSHOT_GET deps 换源；⑫ 白名单四处换源 + mergeProjectDirs(listRecentWorkspaces(
//        零残留；⑬ index.ts getProjectSkillDirs 换源 + 默认目录 concat 尾巴；⑭ 负向钉无第二处
//        拼装（listRecentWorkingDirs( 调用点恰 2 文件；listRecentWorkingDirs(20 旧形态零出现）；
//        ⑮ E4-S1 回填钉（见下方申报）。
//        ⑯ r2-P3-2 补钉（2026-11-19 验收 r2）：组1 内增补——会话目录相互间变体归一去重（D:\a\Proj vs d:\a\proj\ 仅保首个变体）。
// E4-S1 回填申报：用例稿「目录集函数为 async 且带超时预算」按实现后签名回填——统一目录源为同步
// 纯函数（01 §E4-2 伪代码即规范形态：string[] 直返；listRecentWorkingDirs 为同步 better-sqlite3
// 查询，调用点全在 IPC handler 冷路径/启动异步链）；async + withTimeout 3s 预算链保留在 Skill 侧
// collectSkillProjectDirs（既有钉 tdd-skill-project-dirs-verify ⑧ 承担，不重钉）。本钉因此反向钉
// 「不得假异步/不得漏 await」双向：统一函数签名非 async（返回 string[] 非 Promise）+ 全部消费点
// 零 `await listRecentAndSessionProjectDirs` 包裹。
// seam：Module._load 拦截 electron→scripts/electron-stub.cjs（CLAUDE_LINK_TEST_USERDATA 临时目录）、
// session-repo→stub（真实 better-sqlite3 为 Electron ABI 纯 node 不可加载——tdd-queue-autoretry-
// halt-resume-verify seam ① 同款手法）；workspace-history 为真实模块（electron-store 落临时目录，
// 15 次 addRecentWorkspace 实测 MAX_ENTRIES=12 内建封顶，探针先行验证）。临时夹具一律系统临时
// 目录，绝不触碰仓库与用户数据。
// RED 预期（未实现树）：src/main/modules/project-dir-set.ts 不存在 → 组1/组2 全 FAIL（模块加载
// 失败降级）+ 组3 消费点钉全 FAIL；既有基线脚本（tdd-skill-project-dirs / tdd-skill-per-project-
// refresh / selftest-mcp-settings）不受影响。
// 运行：npx tsx scripts/tdd-mcp-skill-dirset-unify-verify.ts（登记 scripts/selftest-static-list.txt 尾部）。

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Module } from 'node:module';
import { mergeProjectDirs, normalizeDirKey } from '../src/shared/project-skills';

const repoRoot = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function check(no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}
function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function readRel(p: string): string {
  const abs = path.resolve(repoRoot, p);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8');
}

// ── seam 安装（必须先于任何 src/main 模块 require：project-dir-set 顶层 import session-repo）──
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-e4-dirset-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = tmpUserData;

// 会话 distinct 工作目录 stub（变体间整体替换；slice(0, limit) 模拟真实 SQL LIMIT 语义）。
let sessionDirsProvider: (limit: number) => string[] = () => [];
const origLoad = (Module as unknown as { _load: unknown })._load as
  (this: unknown, req: string, parent: unknown, isMain: boolean) => unknown;
(Module as unknown as { _load: unknown })._load = function (
  this: unknown, req: string, parent: unknown, isMain: boolean,
) {
  if (req === 'electron') return require('./electron-stub.cjs');
  if (/[\\/]session-repo$/.test(req)) {
    return { listRecentWorkingDirs: (limit: number) => sessionDirsProvider(limit) };
  }
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
} as typeof origLoad;

// 被测模块（RED 阶段不存在 → require 失败降级为断言 FAIL，脚本不 crash）。
let dirSetMod: { listRecentAndSessionProjectDirs?: (dirCap?: number) => string[] } | null = null;
let dirSetModErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dirSetMod = require(path.resolve(repoRoot, 'src', 'main', 'modules', 'project-dir-set.ts'));
} catch (e) {
  dirSetModErr = e instanceof Error ? e.message : String(e);
}
// 真实 workspace-history（electron-stub 下 electron-store 落临时目录；seam 探针已验证可加载）。
let whMod: {
  addRecentWorkspace?: (dir: string) => string[];
  removeRecentWorkspace?: (dir: string) => string[];
  listRecentWorkspaces?: () => string[];
  MAX_ENTRIES?: number;
} | null = null;
let whModErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  whMod = require(path.resolve(repoRoot, 'src', 'main', 'modules', 'workspace-history.ts'));
} catch (e) {
  whModErr = e instanceof Error ? e.message : String(e);
}

// ── 组1/组2 行为测试夹具：真实 store 的 recent 进出（add/remove 幂等回收）──────────
const addedRecents: string[] = [];
function addRecent(dir: string): void {
  const r = whMod?.addRecentWorkspace?.(dir);
  if (r !== undefined) addedRecents.push(dir);
}
function drainRecent(): void {
  for (const dir of addedRecents.splice(0)) whMod?.removeRecentWorkspace?.(dir);
}

try {
  console.log('\n=== 组1 E4-02 并集口径与封顶（真实 workspace-history 12 封顶 + stub session-repo） ===');

  // ① recent 段 12 封顶 + 保序：15 个 distinct 候选 → 真实 MAX_ENTRIES=12 内建封顶，统一函数
  //    只消费其返回值（recent 在前、最新在前）。stub 会话目录 25 个（与 recent 无交集）。
  {
    const sub: string[] = [];
    const fn = dirSetMod?.listRecentAndSessionProjectDirs;
    if (typeof fn !== 'function') {
      sub.push(`listRecentAndSessionProjectDirs 不可用${dirSetModErr ? `（模块加载失败：${dirSetModErr.slice(0, 160)}）` : ''}`);
    } else if (typeof whMod?.addRecentWorkspace !== 'function' || typeof whMod?.listRecentWorkspaces !== 'function') {
      sub.push(`workspace-history 不可用${whModErr ? `（模块加载失败：${whModErr.slice(0, 160)}）` : ''}`);
    } else {
      drainRecent();
      for (let i = 0; i < 15; i++) addRecent(`C:\\w\\recent-${String(i).padStart(2, '0')}`);
      sessionDirsProvider = (limit) =>
        Array.from({ length: 25 }, (_, i) => `C:\\w\\sess-${String(i).padStart(2, '0')}`).slice(0, limit);
      // 上游封顶实证：workspace-history 自身 15→12（统一函数不重复封顶 recent 段）。
      const recent = whMod.listRecentWorkspaces();
      if (recent.length !== 12) sub.push(`recent 段应 12 封顶（15 候选→12），实际 ${recent.length}`);
      if (whMod.MAX_ENTRIES !== 12) sub.push(`MAX_ENTRIES 应为 12，实际 ${String(whMod.MAX_ENTRIES)}`);
      const out = fn(20);
      if (out.length !== 20) sub.push(`并集应封顶 20（12 recent + 8 会话补足），实际 ${out.length}：${JSON.stringify(out)}`);
      const expectedRecent = Array.from({ length: 12 }, (_, i) => `C:\\w\\recent-${String(14 - i).padStart(2, '0')}`);
      if (!deepEq(out.slice(0, 12), expectedRecent)) sub.push(`前 12 条应为 recent 段最新在前，实际 ${JSON.stringify(out.slice(0, 12))}`);
      if (!deepEq(out.slice(12), Array.from({ length: 8 }, (_, i) => `C:\\w\\sess-${String(i).padStart(2, '0')}`)))
        sub.push(`第 13-20 条应为会话 distinct 段按 MAX(updated_at) DESC 序前 8，实际 ${JSON.stringify(out.slice(12))}`);
    }
    check('①', 'E4-02-1 recent 段 12 封顶（15→12，workspace-history 内建）+ 保序最新在前 + 会话段补足至 20', sub.length === 0, sub.join('; '));
  }

  // ⑤ dirCap 参数化：封顶随参数收窄，recent 优先（E4-02 封顶语义的参数面）。
  {
    const sub: string[] = [];
    const fn = dirSetMod?.listRecentAndSessionProjectDirs;
    if (typeof fn !== 'function') {
      sub.push('listRecentAndSessionProjectDirs 不可用');
    } else {
      const out = fn(5);
      if (out.length !== 5) sub.push(`dirCap=5 应封顶 5，实际 ${out.length}`);
      if (!deepEq(out, Array.from({ length: 5 }, (_, i) => `C:\\w\\recent-${String(14 - i).padStart(2, '0')}`)))
        sub.push(`dirCap=5 应 recent 优先截取，实际 ${JSON.stringify(out)}`);
    }
    check('⑤', 'E4-02-2b dirCap 参数化封顶（recent 优先截取，5→5）', sub.length === 0, sub.join('; '));
  }

  // ③ 跨来源去重：会话目录与 recent 同键（大小写/斜杠/尾分隔符变体）→ 单条目，显示串保留
  //    recent 原串（recent 在前优先）。
  {
    const sub: string[] = [];
    const fn = dirSetMod?.listRecentAndSessionProjectDirs;
    if (typeof fn !== 'function') {
      sub.push('listRecentAndSessionProjectDirs 不可用');
    } else {
      drainRecent();
      addRecent('C:\\E4\\Keep-A');   // 先加（更旧）
      addRecent('C:\\E4\\DUP-DIR');  // 后加（最新置顶）——addRecentWorkspace 新的在前
      sessionDirsProvider = () => ['c:/e4/dup-dir/', 'D:\\E4\\Sess-B'];
      const out = fn(20);
      if (out.length !== 3) sub.push(`同键变体应去重为 3 条，实际 ${out.length}：${JSON.stringify(out)}`);
      if (out.filter((d) => d === 'C:\\E4\\DUP-DIR').length !== 1) sub.push(`recent 原串应恰 1 条，实际 ${JSON.stringify(out)}`);
      if (out.some((d) => d === 'c:/e4/dup-dir/')) sub.push('会话侧变体串不得重复入集（normalizeDirKey 归一去重）');
      if (!deepEq(out, ['C:\\E4\\DUP-DIR', 'C:\\E4\\Keep-A', 'D:\\E4\\Sess-B'])) sub.push(`保序应为 recent 段最新在前（DUP-DIR 先于 Keep-A），实际 ${JSON.stringify(out)}`);
    }
    check('③', 'E4-02-3 跨来源重复（大小写/斜杠/尾分隔符变体）单条目 + recent 原串保留 + 保序', sub.length === 0, sub.join('; '));
  }

  // ④ 默认目录不入函数输出；消费点按既有形态 mergeProjectDirs 并入（isDefault 单条，同键合并）。
  {
    const sub: string[] = [];
    const fn = dirSetMod?.listRecentAndSessionProjectDirs;
    if (typeof fn !== 'function') {
      sub.push('listRecentAndSessionProjectDirs 不可用');
    } else {
      drainRecent();
      for (let i = 0; i < 15; i++) addRecent(`C:\\w\\recent-${String(i).padStart(2, '0')}`);
      sessionDirsProvider = (limit) =>
        Array.from({ length: 25 }, (_, i) => `C:\\w\\sess-${String(i).padStart(2, '0')}`).slice(0, limit);
      const out = fn(20);
      if (out.includes('C:\\w\\default-dir')) sub.push('默认工作目录不得入统一函数输出（消费点并入面）');
      // MCP 白名单四处消费形态组合（真实 mergeProjectDirs）：默认目录恒在、isDefault=true。
      const merged = mergeProjectDirs(out, 'C:\\w\\default-dir');
      if (merged.length !== 21) sub.push(`组合后应 20+1（默认目录追加），实际 ${merged.length}`);
      const last = merged[merged.length - 1];
      if (!last || last.path !== 'C:\\w\\default-dir' || last.isDefault !== true)
        sub.push(`默认目录应追加在尾部且 isDefault=true，实际 ${JSON.stringify(merged[merged.length - 1])}`);
      // 默认目录与集内条目同键 → 合并为单条（不双列），显示串保留集内原串。
      const mergedDup = mergeProjectDirs(out, 'C:\\w\\sess-00');
      if (mergedDup.length !== 20) sub.push(`默认目录同键合并后应仍 20 条，实际 ${mergedDup.length}`);
      const dupEntry = mergedDup.find((d) => normalizeDirKey(d.path) === normalizeDirKey('C:\\w\\sess-00'));
      if (!dupEntry || dupEntry.isDefault !== true) sub.push(`同键默认目录应命中 isDefault=true，实际 ${JSON.stringify(dupEntry)}`);
    }
    check('④', 'E4-02-4 默认目录不入函数输出；消费点 mergeProjectDirs 并入（追加 isDefault / 同键合并单条）', sub.length === 0, sub.join('; '));
  }

  // ⑯ r2-P3-2（2026-11-19 验收 r2）：会话目录相互间的变体（大小写/斜杠/尾分隔符）归一去重——
  //    sessionDirs 边遍历边去重后，D:\a\Proj 与 d:\a\proj\ 同归一键仅保首个变体（保序），
  //    不再双入集双占 dirCap 名额（此前仅对 recent 段去重，组1 只钉过 recent↔session 跨来源）。
  {
    const sub: string[] = [];
    const fn = dirSetMod?.listRecentAndSessionProjectDirs;
    if (typeof fn !== 'function') {
      sub.push('listRecentAndSessionProjectDirs 不可用');
    } else {
      drainRecent();
      sessionDirsProvider = (limit) => ['D:\\a\\Proj', 'd:\\a\\proj\\'].slice(0, limit);
      const out = fn(20);
      if (out.length !== 1) sub.push(`同键变体仅应含其一，实际 ${out.length}：${JSON.stringify(out)}`);
      if (out[0] !== 'D:\\a\\Proj') sub.push(`应保序取首个变体 D:\\a\\Proj，实际 ${JSON.stringify(out)}`);
    }
    check('⑯', 'E4-02-r2 会话目录相互间变体归一去重（D:\\a\\Proj vs d:\\a\\proj\\ 仅含其一，r2-P3-2）', sub.length === 0, sub.join('; '));
  }

  console.log('\n=== 组2 E4-03 空集与退化输入 ===');

  // ⑥ 空集：无最近工作区、无会话 → 函数输出 []（无垃圾条目）；组合 mergeProjectDirs 后=仅默认
  //    目录（契约「空集 → 仅默认目录」端到端）。
  {
    const sub: string[] = [];
    const fn = dirSetMod?.listRecentAndSessionProjectDirs;
    if (typeof fn !== 'function') {
      sub.push('listRecentAndSessionProjectDirs 不可用');
    } else {
      drainRecent();
      sessionDirsProvider = () => [];
      const out = fn();
      if (!deepEq(out, [])) sub.push(`空集应返回 []（无 undefined/空串混入），实际 ${JSON.stringify(out)}`);
      const merged = mergeProjectDirs(out, 'C:\\only\\default');
      if (!deepEq(merged.map((d) => [d.path, d.isDefault]), [['C:\\only\\default', true]]))
        sub.push(`空集组合后应仅默认目录，实际 ${JSON.stringify(merged)}`);
    }
    check('⑥', 'E4-03-1 空集→函数 []（无垃圾条目）；组合后仅默认目录（契约端到端）', sub.length === 0, sub.join('; '));
  }

  // ⑦ 三来源全同：最近工作区 / 会话 distinct / 默认目录同一路径 → 输出恰 1 条（isDefault=true）。
  {
    const sub: string[] = [];
    const fn = dirSetMod?.listRecentAndSessionProjectDirs;
    if (typeof fn !== 'function') {
      sub.push('listRecentAndSessionProjectDirs 不可用');
    } else {
      drainRecent();
      addRecent('C:\\E4\\SAME');
      sessionDirsProvider = () => ['C:\\E4\\SAME'];
      const out = fn();
      if (!deepEq(out, ['C:\\E4\\SAME'])) sub.push(`三来源全同应恰 1 条，实际 ${JSON.stringify(out)}`);
      const merged = mergeProjectDirs(out, 'C:\\E4\\SAME');
      if (merged.length !== 1 || merged[0].isDefault !== true)
        sub.push(`含默认目录仍应恰 1 条且 isDefault=true，实际 ${JSON.stringify(merged)}`);
    }
    check('⑦', 'E4-03-2 三来源全同路径→恰 1 条（含默认目录合并后仍 1 条）', sub.length === 0, sub.join('; '));
  }

  // ⑧ 大小写/斜杠变体：`D:\a\B\`（recent）vs `d:/a/b`（会话）→ 按 normalizeDirKey 归一单条
  //    （归一键语义由 tdd-skill-project-dirs 组1 钉住，本卷只断言统一函数消费该口径的端到端结果）。
  {
    const sub: string[] = [];
    const fn = dirSetMod?.listRecentAndSessionProjectDirs;
    if (typeof fn !== 'function') {
      sub.push('listRecentAndSessionProjectDirs 不可用');
    } else {
      drainRecent();
      addRecent('D:\\a\\B\\');
      sessionDirsProvider = () => ['d:/a/b'];
      const out = fn();
      if (!deepEq(out, ['D:\\a\\B\\'])) sub.push(`变体应归一单条且保留 recent 原串，实际 ${JSON.stringify(out)}`);
    }
    check('⑧', 'E4-03-3 大小写/斜杠/尾分隔符变体→normalizeDirKey 归一单条', sub.length === 0, sub.join('; '));
  }

  console.log('\n=== 组3 E4-01 单一真相源结构钉（跨文件接线不变量） ===');

  // ⑨ 两文件同 import 符号：ipc-handlers.ts 与 index.ts 同一 import 点引入统一函数（E4-01 正钉）。
  {
    const handlers = readRel('src/main/ipc-handlers.ts');
    const index = readRel('src/main/index.ts');
    const mod = readRel('src/main/modules/project-dir-set.ts');
    const sub: string[] = [];
    if (!mod) sub.push('src/main/modules/project-dir-set.ts 不存在');
    else {
      if (!/export function listRecentAndSessionProjectDirs\(/.test(mod)) sub.push('project-dir-set.ts 缺 export function listRecentAndSessionProjectDirs');
    }
    if (!/import \{[^}]*listRecentAndSessionProjectDirs[^}]*\} from '\.\/modules\/project-dir-set'/.test(handlers))
      sub.push("ipc-handlers.ts 缺 import { … listRecentAndSessionProjectDirs … } from './modules/project-dir-set'");
    if (!/import \{[^}]*listRecentAndSessionProjectDirs[^}]*\} from '\.\/modules\/project-dir-set'/.test(index))
      sub.push("index.ts 缺 import { … listRecentAndSessionProjectDirs … } from './modules/project-dir-set'");
    check('⑨', 'E4-01 两文件（ipc-handlers/index）同 import 符号 listRecentAndSessionProjectDirs（单一 import 点）', sub.length === 0, sub.join('; '));
  }

  // ⑩ SKILL handler 换源：统一函数调用在位；旧内联装配字面零残留；sessionCounts 装配不动。
  {
    const handlers = readRel('src/main/ipc-handlers.ts');
    const start = handlers.indexOf("regInvokeHandler(IPC_CHANNELS.SKILL_PROJECT_DIRS_GET");
    const end = handlers.indexOf('regInvokeHandler(IPC_CHANNELS.MCP_SNAPSHOT_GET', start);
    const slice = start > -1 && end > start ? handlers.slice(start, end) : '';
    const sub: string[] = [];
    if (!slice) sub.push('SKILL_PROJECT_DIRS_GET handler 切片定位失败');
    else {
      if (!slice.includes('listRecentAndSessionProjectDirs(20)')) sub.push('handler 缺 listRecentAndSessionProjectDirs(20) 统一目录源调用');
      if (!/recentDirs\s*=\s*listRecentAndSessionProjectDirs\(20\)/.test(slice)) sub.push('handler 缺 recentDirs = listRecentAndSessionProjectDirs(20) 装配形态');
      if (slice.includes('listRecentWorkspaces()')) sub.push('旧内联 listRecentWorkspaces() 残留（应随 E4 迁出 handler）');
      if (slice.includes('listRecentWorkingDirs(20)')) sub.push('旧内联 listRecentWorkingDirs(20) 残留');
      if (slice.includes('slice(0, dirCap)')) sub.push('旧内联 slice(0, dirCap) 残留');
      if (!slice.includes('listWorkingDirCounts()')) sub.push('sessionCounts 装配（listWorkingDirCounts()）不得随换源移除');
      if (!/dirs:\s*await\s+collectSkillProjectDirs/.test(slice)) sub.push('handler 应保持 await collectSkillProjectDirs 聚合形态');
    }
    check('⑩', 'E4-01 SKILL handler 换源：统一函数在位 + 旧内联三字面零残留 + sessionCounts/collect 聚合不动', sub.length === 0, sub.join('; '));
  }

  // ⑪ MCP_SNAPSHOT_GET deps 换源（E4 有意扩集=契约本体）：recentWorkspaces 换统一函数，
  //    defaultWorkingDir 仍独立传参（默认目录并入语义由 scanner 内 mergeProjectDirs 保留）。
  {
    const handlers = readRel('src/main/ipc-handlers.ts');
    const start = handlers.indexOf('regInvokeHandler(IPC_CHANNELS.MCP_SNAPSHOT_GET');
    const slice = start > -1 ? handlers.slice(start, start + 900) : '';
    const sub: string[] = [];
    if (!slice) sub.push('MCP_SNAPSHOT_GET handler 切片定位失败');
    else {
      if (!/recentWorkspaces:\s*listRecentAndSessionProjectDirs\(20\)/.test(slice))
        sub.push('deps 缺 recentWorkspaces: listRecentAndSessionProjectDirs(20)（E4 有意扩集=契约本体）');
      if (!/defaultWorkingDir,/.test(slice)) sub.push('deps 缺 defaultWorkingDir 传参（默认目录并入语义）');
      if (/recentWorkspaces:\s*listRecentWorkspaces\(\)/.test(slice)) sub.push('旧 recentWorkspaces: listRecentWorkspaces() 残留');
    }
    check('⑪', 'E4-01 MCP_SNAPSHOT_GET deps 换源：recentWorkspaces=统一函数(20) + defaultWorkingDir 独立传参保留', sub.length === 0, sub.join('; '));
  }

  // ⑫ 白名单四处换源 + 零残留（ask 第 3 条）：mergeProjectDirs(listRecentAndSessionProjectDirs(20)
  //    代码行恰 4 处（probe scoped / probe single / write scoped / export scoped；注释行不计——
  //    机理注释可提及新形态）；旧 mergeProjectDirs(listRecentWorkspaces( 形态全文件零出现
  //    （含注释——负钉以全文件为面）。
  {
    const handlers = readRel('src/main/ipc-handlers.ts');
    const codeLines = handlers.split(/\r?\n/).filter((l) => !l.trim().startsWith('//'));
    const codeText = codeLines.join('\n');
    const sub: string[] = [];
    const newFormCount = (codeText.match(/mergeProjectDirs\(listRecentAndSessionProjectDirs\(20\)/g) ?? []).length;
    if (newFormCount !== 4) sub.push(`白名单四处应恰 4 处 mergeProjectDirs(listRecentAndSessionProjectDirs(20)（代码行），实际 ${newFormCount}`);
    if (handlers.includes('mergeProjectDirs(listRecentWorkspaces('))
      sub.push('旧 mergeProjectDirs(listRecentWorkspaces( 形态残留（白名单四处零残留要求，含注释）');
    check('⑫', 'E4-01 白名单四处换源：新形态代码行恰 4 处 + 旧 mergeProjectDirs(listRecentWorkspaces( 全文件零残留', sub.length === 0, sub.join('; '));
  }

  // ⑬ index.ts getProjectSkillDirs 换源 + 默认目录 concat 尾巴（判重按全集 normalizeDirKey 比对，
  //    §E4-2 指定形态）；旧内联装配字面零残留。
  {
    const index = readRel('src/main/index.ts');
    const start = index.indexOf('getProjectSkillDirs');
    const slice = start > -1 ? index.slice(start, start + 600) : '';
    const sub: string[] = [];
    if (!slice) sub.push('index.ts getProjectSkillDirs 定位失败');
    else {
      if (!slice.includes('listRecentAndSessionProjectDirs(20)')) sub.push('注入闭包缺 listRecentAndSessionProjectDirs(20) 统一目录源');
      if (!/getConfig\(\)\.workingDirectory/.test(slice)) sub.push('注入闭包缺默认目录并入（getConfig().workingDirectory）');
      if (!/dirs\.some\(\(d\) => normalizeDirKey\(d\) === normalizeDirKey\(def\)\)/.test(slice))
        sub.push('concat 尾巴判重应为 dirs.some(normalizeDirKey 全集比对) 形态（§E4-2）');
      if (slice.includes('listRecentWorkingDirs(20)')) sub.push('旧内联 listRecentWorkingDirs(20) 残留');
      if (slice.includes('slice(0, 20)')) sub.push('旧内联 slice(0, 20) 残留（封顶已内聚统一函数）');
      if (!slice.includes('normalizeDirKey')) sub.push('注入闭包缺 normalizeDirKey（尾巴判重）');
    }
    check('⑬', 'E4-01 index.ts getProjectSkillDirs 换源：统一函数 + workingDirectory concat 尾巴全集判重 + 旧内联零残留', sub.length === 0, sub.join('; '));
  }

  // ⑭ 负向钉无第二处拼装：src/main 全域——listRecentWorkingDirs( 调用形态仅存在于定义文件
  //    （session-repo.ts）与单一消费点（project-dir-set.ts）；旧调用字面 listRecentWorkingDirs(20
  //    全域零出现；mergeProjectDirs(listRecentWorkspaces( 全域零出现。
  {
    const sub: string[] = [];
    const srcRoot = path.resolve(repoRoot, 'src', 'main');
    const tsFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith('.ts')) tsFiles.push(p);
      }
    };
    walk(srcRoot);
    const callFiles = tsFiles.filter((f) => /listRecentWorkingDirs\(/.test(fs.readFileSync(f, 'utf8')));
    const rel = callFiles.map((f) => path.relative(repoRoot, f).replace(/\\/g, '/')).sort();
    if (!deepEq(rel, ['src/main/database/repositories/session-repo.ts', 'src/main/modules/project-dir-set.ts']))
      sub.push(`listRecentWorkingDirs( 调用面应恰定义+单一消费两文件，实际 ${JSON.stringify(rel)}`);
    const anyOld20 = tsFiles.some((f) => /listRecentWorkingDirs\(20/.test(fs.readFileSync(f, 'utf8')));
    if (anyOld20) sub.push('旧调用字面 listRecentWorkingDirs(20 全 src/main 残留（应随五处换源清零）');
    const anyOldMerge = tsFiles.some((f) => /mergeProjectDirs\(listRecentWorkspaces\(/.test(fs.readFileSync(f, 'utf8')));
    if (anyOldMerge) sub.push('旧白名单拼装 mergeProjectDirs(listRecentWorkspaces( 全 src/main 残留');
    check('⑭', 'E4-01 负向钉：listRecentWorkingDirs( 调用面恰两文件 + 旧字面（(20 / mergeProjectDirs(listRecentWorkspaces()全域零残留', sub.length === 0, sub.join('; '));
  }

  // ⑮ E4-S1 回填钉：统一函数同步签名（非 async、返回 string[] 非 Promise）+ 全部消费点零 await
  //    包裹（「漏 await/假同步包裹」双向排除；回填申报见头注）。
  {
    const mod = readRel('src/main/modules/project-dir-set.ts');
    const handlers = readRel('src/main/ipc-handlers.ts');
    const index = readRel('src/main/index.ts');
    const sub: string[] = [];
    if (!/export function listRecentAndSessionProjectDirs\(dirCap = 20\): string\[\]/.test(mod))
      sub.push('统一函数签名应为 sync (dirCap = 20): string[]（非 async/Promise，01 §E4-2 伪代码规范形态）');
    if (/async function listRecentAndSessionProjectDirs/.test(mod)) sub.push('统一函数不得 async 化（同步纯函数）');
    if (/await\s+listRecentAndSessionProjectDirs/.test(handlers) || /await\s+listRecentAndSessionProjectDirs/.test(index))
      sub.push('消费点不得 await 同步统一函数（假异步包裹）');
    check('⑮', 'E4-S1 回填钉：sync 签名 (dirCap = 20): string[] + 消费点零 await 包裹（假异步/漏 await 双向排除）', sub.length === 0, sub.join('; '));
  }
} finally {
  drainRecent();
  sessionDirsProvider = () => [];
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}

console.log(`\n===== tdd-mcp-skill-dirset-unify-verify: ${pass} pass / ${fail} fail =====`);
if (fail > 0) console.log('（RED 阶段：FAIL 项为尚未实施的生产改动，实施后应全 PASS）');
process.exit(fail > 0 ? 1 : 0);
