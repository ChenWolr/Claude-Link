// tdd-skill-user-dirnames-verify.ts
// R-1（review 2026-09-18 验收报告 §3 R-1，2026-09-19 修复批）：
// 全局作用域（~/.claude/skills 用户级 skill）开关键口径统一到目录名——引擎 skillOverrides 只认
// 目录名（2026-09-18 Phase 0-2 裁决），项目作用域已按 dirName 收口（P2-3），全局作用域开关仍写
// frontmatter 名键：fm≠dir 的用户级 skill 禁用无效（引擎不命中、实际仍可用），而 UI 读同键显
// 「已禁用」假象；该无效键 ∈ userSkills 名集，D-1 死键清理不标出；B-5 菜单过滤按 c.name 命中
// 与引擎实效相悖（菜单隐藏但引擎可用）。
// 修向四件（键口径全链统一到目录名）：
// ① 主进程 collectUserSkillDirNames(skillsRoot)：复用项目枚举口径（junction 跟随/大小写同名
//    去重/空 name 回退同款）直读 skillsRoot 产出 Record<fm名, 目录名>——skillsRoot 作参数由
//    handler 侧组装 path.join(os.homedir(), '.claude', 'skills')（不硬编码用户目录，契约夹具
//    可直测）；不存在→空对象。
// ② 通道：SKILL_PROJECT_DIRS_GET 载荷扩展 userSkillDirNames（进 Skill tab 现查同拍，零新增
//    调用时序），经 loadSkillProjectDirs 装载机透传，ConfigPage 写入 commandStore.userSkillDirNames
//    （映射槽，ChatInput 同源消费）。
// ③ 渲染层合并：userSkills 按映射补 dirName（attachUserSkillDirNames 纯函数；显示名仍用快照
//    slash 名）——skillKey（dirName ?? name）/开关/统计/可见性过滤/D-1 全集自动统一目录名。
// ④ B-5 菜单过滤键：filterMenuCommandsBySkillOverrides 增第三参 nameToDir（fm 名→目录名），
//    ChatInput seam 同源映射；拿不到映射维持旧 slash 名口径（注释申报，残面由引擎键入拦截兜底）。
// 断言（10 条）：①collectUserSkillDirNames 行为（fs 夹具：fm≠dir/fm=dir/引号名/无 frontmatter/
// junction/断链/大小写同名归一/__proto__ 名/不存在→{}）②attachUserSkillDirNames 纯函数
// ③filterMenuCommandsBySkillOverrides 三参行为 ④ConfigPage 合并与键口径形态钉 ⑤「键名=目录名」
// 小字提示钉 ⑥handler 载荷接线钉 ⑦载荷类型钉 ⑧ChatInput seam 钉 ⑨command-store 槽位钉
// ⑩旧契约回归（spawn 三份指向被改面的轻量契约 exit 0）。
// RED 预期（未修复树）：①-⑨ FAIL，⑩ PASS（基线守卫）。
// 运行：npx tsx scripts/tdd-skill-user-dirnames-verify.ts（断言体包 async main——tsx CJS 无顶层
// await，先例教训；夹具在系统临时目录（os.tmpdir），绝不触碰仓库/用户真实 ~/.claude）。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
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

// 被测模块（RED 阶段导出不存在 → require 成功但导出为 undefined，断言降级 FAIL，脚本不 crash）。
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
let filterMod: any = null;
let filterModErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  filterMod = require(path.resolve(repoRoot, 'src', 'shared', 'command-filter.ts'));
} catch (e) {
  filterModErr = errMsg(e);
}

// 断言体包 async main 执行（①为 await 行为断言；tsx CJS 无顶层 await）。
async function main(): Promise<void> {
  console.log('\n=== 组1 主进程全局枚举（collectUserSkillDirNames，真实 fs 夹具） ===');

  // 临时夹具（fix-tmp，用毕清理；模拟 ~/.claude/skills 根——不触碰真实用户目录）。
  const fixtureRoot = path.join(os.tmpdir(), 'claude-link-fixtures', `r1-fixture-${process.pid}-${Date.now()}`);
  function writeSkill(dir: string, rel: string, content: string): void {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  try {
    fs.mkdirSync(fixtureRoot, { recursive: true });
    const skillsRoot = path.join(fixtureRoot, 'user-skills');
    // fm≠dir（R-1 缺陷主形态）/ fm=dir（公共形态）/ 引号名（P2-3 剥引号口径）
    writeSkill(skillsRoot, path.join('dir-fm-diff', 'SKILL.md'), '---\nname: fm-diff\ndescription: frontmatter differs\n---\nbody');
    writeSkill(skillsRoot, path.join('same-name', 'SKILL.md'), '---\nname: same-name\ndescription: fm equals dir\n---\nbody');
    writeSkill(skillsRoot, path.join('quoted-dir', 'SKILL.md'), '---\nname: "quoted"\ndescription: quoted name\n---\nbody');
    // 无 frontmatter（引擎亦不加载 → 跳过）
    writeSkill(skillsRoot, path.join('nofm', 'SKILL.md'), 'no frontmatter here');
    // junction（D-4 口径：dirName=junction 自身名，内容取自目标）+ 断链（跳过）
    const jxTarget = path.join(fixtureRoot, 'jx-target');
    writeSkill(jxTarget, 'SKILL.md', '---\nname: jx-skill\ndescription: via junction\n---\nbody');
    fs.symlinkSync(jxTarget, path.join(skillsRoot, 'jx-link'), 'junction');
    const deadTarget = path.join(fixtureRoot, 'jx-dead-target');
    fs.mkdirSync(deadTarget, { recursive: true });
    fs.symlinkSync(deadTarget, path.join(skillsRoot, 'dead-link'), 'junction');
    fs.rmSync(deadTarget, { recursive: true, force: true });
    // 大小写同名对（D-6 口径：枚举按 name 小写去重归并为一条，first-wins）
    writeSkill(skillsRoot, path.join('case-a', 'SKILL.md'), '---\nname: CaseDup\ndescription: case upper\n---\nbody');
    writeSkill(skillsRoot, path.join('case-b', 'SKILL.md'), '---\nname: casedup\ndescription: case lower\n---\nbody');
    // __proto__ 名（B-2 同类边界：映射载体必须允许该名为自有属性）
    writeSkill(skillsRoot, path.join('proto-dir', 'SKILL.md'), '---\nname: __proto__\ndescription: proto name\n---\nbody');

    // ① collectUserSkillDirNames 行为
    {
      const sub: string[] = [];
      const fn: unknown = mainMod?.collectUserSkillDirNames;
      if (typeof fn !== 'function') {
        sub.push(`导出 collectUserSkillDirNames 不可用${mainModErr ? `（模块加载失败：${mainModErr.slice(0, 120)}）` : ''}`);
      } else {
        const c = fn as (root: string) => Promise<Record<string, string>>;
        const map = await c(skillsRoot);
        const keys = Object.keys(map);
        if (map['fm-diff'] !== 'dir-fm-diff') sub.push(`fm≠dir 应映射 fm-diff→dir-fm-diff，实际 ${JSON.stringify(map['fm-diff'])}`);
        if (map['same-name'] !== 'same-name') sub.push(`fm=dir 应映射 same-name→same-name，实际 ${JSON.stringify(map['same-name'])}`);
        if (map['quoted'] !== 'quoted-dir') sub.push(`引号名应剥一层后映射 quoted→quoted-dir，实际 ${JSON.stringify(map['quoted'])}`);
        if (keys.includes('nofm')) sub.push('无 frontmatter 条目应跳过（引擎亦不加载）');
        if (map['jx-skill'] !== 'jx-link') sub.push(`junction 条目应映射 jx-skill→jx-link（dirName=junction 自身名），实际 ${JSON.stringify(map['jx-skill'])}`);
        if (keys.includes('dead-link')) sub.push('断链 junction 应跳过');
        // 大小写同名对：枚举按 name 小写去重归并为恰一条（first-wins；胜者拼写平台相关不钉）
        const caseKeys = keys.filter((k) => k.toLowerCase() === 'casedup');
        if (caseKeys.length !== 1) sub.push(`大小写同名对（CaseDup/casedup）应归并为恰一条，实际 ${caseKeys.length} 条`);
        else if (map[caseKeys[0]] !== 'case-a' && map[caseKeys[0]] !== 'case-b') sub.push(`归一条目录名应为 case-a/case-b 之一，实际 ${JSON.stringify(map[caseKeys[0]])}`);
        // __proto__ 名键须落自有属性（null 原型载体；普通对象赋值走原型 setter 静默 no-op）
        if (!Object.prototype.hasOwnProperty.call(map, '__proto__') || (map as Record<string, string>)['__proto__'] !== 'proto-dir') sub.push(`__proto__ 名键应可写为自有属性（null 原型载体），实际 ${JSON.stringify((map as Record<string, string>)['__proto__'])}`);
        if (keys.length !== 6) sub.push(`映射应恰 6 键（fm-diff/same-name/quoted/jx-skill/__proto__/casedup 归一条），实际 ${keys.length}：${JSON.stringify(keys)}`);
        // skillsRoot 不存在 → 空对象
        const absent = await c(path.join(fixtureRoot, 'no-such-root'));
        if (!deepEq(Object.keys(absent), [])) sub.push(`skillsRoot 不存在应返回空对象，实际 ${JSON.stringify(absent)}`);
      }
      check('①', 'collectUserSkillDirNames：fm 名→目录名映射（fm≠dir/fm=dir/引号名剥离/junction 跟随/断链与无 frontmatter 跳过/大小写同名归一 first-wins/__proto__ 键可写/不存在→{}）', sub.length === 0, sub.join('; '));
    }
  } finally {
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }

  console.log('\n=== 组2 渲染层合并纯函数（attachUserSkillDirNames） ===');

  // ② attachUserSkillDirNames：按 fm 名精确匹配补 dirName
  {
    const sub: string[] = [];
    const fn: unknown = sharedMod?.attachUserSkillDirNames;
    if (typeof fn !== 'function') {
      sub.push(`导出 attachUserSkillDirNames 不可用${sharedModErr ? `（模块加载失败：${sharedModErr.slice(0, 120)}）` : ''}`);
    } else {
      const a = fn as <T extends { name: string }>(items: T[], m: Record<string, string> | null | undefined) => Array<T & { dirName?: string }>;
      const items = [{ name: 'fm-diff', description: 'd1' }, { name: 'plain', description: 'd2' }, { name: '__proto__', description: 'd3' }];
      // JSON.parse 造含自有 __proto__ 键的映射（对象字面量的 __proto__ 键走 setter 不落自有属性）
      const map = JSON.parse('{"fm-diff":"dir-fm-diff","__proto__":"proto-dir"}') as Record<string, string>;
      const out = a(items, map);
      if (out.length !== 3) sub.push(`应等长返回，实际 ${out.length}`);
      if (out[0].dirName !== 'dir-fm-diff') sub.push(`fm 名命中应补 dirName=dir-fm-diff，实际 ${JSON.stringify(out[0].dirName)}`);
      if (out[0].description !== 'd1') sub.push('命中条目其余字段应原样保留');
      if (out[1].dirName !== undefined) sub.push(`无命中条目 dirName 应缺省（skillKey 回退 slash 名），实际 ${JSON.stringify(out[1].dirName)}`);
      if (out[2].dirName !== 'proto-dir') sub.push(`__proto__ 名应按自有键命中且不污染原型链，实际 ${JSON.stringify(out[2].dirName)}`);
      if (out === items) sub.push('不得原引用返回（须新数组）');
      if (Object.prototype.hasOwnProperty.call(items[0], 'dirName')) sub.push('不得改写入参条目（须新对象）');
      const outNull = a(items, null);
      const outUndef = a(items, undefined);
      const outEmpty = a(items, {});
      if (outNull.some((s) => s.dirName !== undefined) || outUndef.some((s) => s.dirName !== undefined) || outEmpty.some((s) => s.dirName !== undefined)) {
        sub.push('null/undefined/空映射应全缺省（映射不可得时口径回退 slash 名）');
      }
    }
    check('②', 'attachUserSkillDirNames：fm 名精确匹配补 dirName；无命中/null/undefined/空映射全缺省；不改入参；__proto__ 键安全', sub.length === 0, sub.join('; '));
  }

  console.log('\n=== 组3 B-5 菜单过滤键（filterMenuCommandsBySkillOverrides 第三参 nameToDir） ===');

  // ③ 开关键=目录名口径：fm≠dir 条目经映射解析键；无命中回退 slash 名；映射缺省维持旧行为
  {
    const sub: string[] = [];
    const f: unknown = filterMod?.filterMenuCommandsBySkillOverrides;
    if (typeof f !== 'function') {
      sub.push(`导出 filterMenuCommandsBySkillOverrides 不可用${filterModErr ? `（模块加载失败：${filterModErr.slice(0, 120)}）` : ''}`);
    } else {
      const flt = f as <T extends { name: string; origin?: string }>(
        cmds: T[], o: Record<string, 'off'> | null | undefined, nameToDir?: Record<string, string> | null,
      ) => T[];
      const cmds = [
        { name: 'fm-diff', origin: 'user-skill' },
        { name: 'plain', origin: 'user-skill' },
        { name: 'other', origin: 'builtin' },
        { name: 'fm-diff', origin: 'plugin' },
      ];
      // 开关键含 fm≠dir 条目的目录名（引擎口径）：映射提供时两侧均按目录名命中剔除
      const overrides = { 'dir-fm-diff': 'off', plain: 'off' } as Record<string, 'off'>;
      const withMap = flt(cmds, overrides, { 'fm-diff': 'dir-fm-diff' });
      if (!deepEq(withMap.map((c) => `${c.name}:${c.origin ?? '-'}`), ['other:builtin', 'fm-diff:plugin']))
        sub.push(`带映射应按目录名键剔除两个 user-skill 条目，实际 ${JSON.stringify(withMap.map((c) => `${c.name}:${c.origin ?? '-'}`))}`);
      // 映射 null → 键回退 slash 名（旧行为）：'plain'（fm=dir）仍命中，'fm-diff' 不命中保留
      const noMap = flt(cmds, overrides, null);
      if (!deepEq(noMap.map((c) => `${c.name}:${c.origin ?? '-'}`), ['fm-diff:user-skill', 'other:builtin', 'fm-diff:plugin']))
        sub.push(`映射 null 应回退 slash 名口径（旧行为），实际 ${JSON.stringify(noMap.map((c) => `${c.name}:${c.origin ?? '-'}`))}`);
      // 缺省第三参（两参调用）→ 与 null 同（旧契约 24 条口径不破）
      const legacy = flt(cmds, overrides);
      if (!deepEq(legacy.map((c) => `${c.name}:${c.origin ?? '-'}`), ['fm-diff:user-skill', 'other:builtin', 'fm-diff:plugin']))
        sub.push('缺省第三参应与旧行为一致');
      // 空 overrides → 原引用快路径不变
      if (flt(cmds, null, { 'fm-diff': 'dir-fm-diff' }) !== cmds) sub.push('overrides=null 应原引用返回（快路径不受第三参影响）');
    }
    check('③', 'filterMenuCommandsBySkillOverrides：第三参映射下按目录名键命中剔除；映射 null/缺省回退 slash 名旧行为；空 overrides 原引用', sub.length === 0, sub.join('; '));
  }

  console.log('\n=== 组4 渲染层/接线形态钉 ===');

  // ④ ConfigPage：userSkills 合并补 dirName + 映射槽回写 + D-1 全集扩为 skillKey 键集 + 计数同键
  {
    const src = readRel('src/renderer/pages/ConfigPage.vue');
    const sub: string[] = [];
    if (!src.includes('attachUserSkillDirNames')) sub.push('ConfigPage 未消费 attachUserSkillDirNames');
    const uAt = src.indexOf('const userSkills');
    const uBody = uAt >= 0 ? src.slice(uAt, uAt + 700) : '';
    if (uAt < 0) sub.push('缺 userSkills computed');
    else {
      if (!uBody.includes('attachUserSkillDirNames')) sub.push('userSkills 未按映射补 dirName（合并口径）');
      if (!uBody.includes('userSkillDirNames')) sub.push('userSkills 合并未消费映射槽（commandStore.userSkillDirNames）');
    }
    const eAt = src.indexOf('async function ensureProjectDirs');
    // 窗口 1400（Y-1 批 2026-09-19 同步申报：ok 分支新增超时判定 if/else 与注释后，映射槽回写行
    // 偏移至 ~770；窗宽适配，钉意图不变——仍钉映射槽同源回写在位）。
    const eBody = eAt >= 0 ? src.slice(eAt, eAt + 1400) : '';
    if (eAt < 0) sub.push('缺 ensureProjectDirs 定义');
    else if (!/commandStore\.userSkillDirNames\s*=/.test(eBody)) sub.push('现查 ok 分支未回写 commandStore.userSkillDirNames（映射槽同源）');
    const sAt = src.indexOf('const staleSkillKeys');
    // 窗口 800（X-1 批 2026-09-19 同步申报：computed 头部新增 isStaleKeyScanReady 就绪门控块后，
    // 尾部 userSkills.value.map 键集行偏移至 ~698；窗宽适配，钉意图不变）。
    const sBody = sAt >= 0 ? src.slice(sAt, sAt + 800) : '';
    if (sAt < 0) sub.push('缺 staleSkillKeys computed');
    else if (!sBody.includes('userSkills.value.map((s) => skillKey(s))')) sub.push('D-1 全局全集应扩为 userSkills 经 skillKey 的键集（含 dirName，无效 fm 名键可被标出）');
    if (!/globalEnabledCount = computed\(\(\) => userSkills\.value\.filter\(\(s\) => isSkillEnabled\(skillKey\(s\)\)\)\.length\)/.test(src)) sub.push('globalEnabledCount 应改按 skillKey 口径（rail 全局行启用计数与开关同键）');
    check('④', 'ConfigPage：userSkills 经 attachUserSkillDirNames 补 dirName + 映射槽同源回写 + D-1 全集 skillKey 化 + globalEnabledCount 同键', sub.length === 0, sub.join('; '));
  }

  // ⑤ 「键名=目录名」小字提示（仅 fm≠dir 条目显示）
  {
    const src = readRel('src/renderer/pages/ConfigPage.vue');
    const sub: string[] = [];
    if (!src.includes('skill-card__keyhint')) sub.push('缺 keyhint 类（skill-card__keyhint）');
    if (!src.includes('键名 {{ skill.dirName }}')) sub.push('缺「键名 = 目录名」小字文案');
    if (!/v-if="[^"]*skill\.dirName !== skill\.name[^"]*"/.test(src)) sub.push('keyhint 应仅对 fm≠dir 条目显示（dirName !== name 条件）');
    if (!/\.skill-card__keyhint\s*\{/.test(src)) sub.push('缺 .skill-card__keyhint 样式定义');
    check('⑤', 'skill 卡片 fm≠dir 条目「键名=目录名」小字提示（类 + 文案 + 条件 + 样式定义）', sub.length === 0, sub.join('; '));
  }

  // ⑥ handler 接线：SKILL_PROJECT_DIRS_GET 载荷同拍带 userSkillDirNames（rootDir 由 handler 组装）
  {
    const src = readRel('src/main/ipc-handlers.ts');
    const at = src.indexOf('ipcMain.handle(IPC_CHANNELS.SKILL_PROJECT_DIRS_GET');
    const region = at >= 0 ? src.slice(at, at + 900) : '';
    const sub: string[] = [];
    if (at < 0) sub.push('缺 SKILL_PROJECT_DIRS_GET handler 注册');
    else {
      // Y-1 批 2026-09-19 改行为同步改断言：null 哨兵先落 const 再分流（旧钉
      // 「userSkillDirNames: await collectUserSkillDirNames」内联形态随超时哨兵整改废止）。
      if (!/const userDirNames = await collectUserSkillDirNames\(/.test(region)) sub.push('载荷缺 const userDirNames = await collectUserSkillDirNames(...)（同拍现查）');
      if (!/userSkillDirNames:\s*userDirNames \?\? \{\}/.test(region)) sub.push('载荷缺 userSkillDirNames: userDirNames ?? {}（映射恒对象，哨兵态空对象兜底）');
      if (!region.includes('os.homedir()')) sub.push('handler 应以 os.homedir() 组装 rootDir（被测函数参数化不硬编码）');
      if (!region.includes("'.claude', 'skills'")) sub.push("缺 ~/.claude/skills 组装字面（'.claude', 'skills'）");
    }
    if (!/import \{[^}]*collectUserSkillDirNames[^}]*\} from '\.\/modules\/project-skills'/.test(src)) sub.push('缺 collectUserSkillDirNames 导入');
    if (!/import os from 'node:os';/.test(src)) sub.push("缺 os 导入（import os from 'node:os';）");
    check('⑥', 'ipc-handlers：SKILL_PROJECT_DIRS_GET 载荷同拍带 userSkillDirNames（os.homedir() 组装，导入在位）', sub.length === 0, sub.join('; '));
  }

  // ⑦ 载荷类型：SkillProjectDirsPayload 扩展 userSkillDirNames
  {
    const src = readRel('src/shared/types/command.ts');
    const at = src.indexOf('export interface SkillProjectDirsPayload');
    const body = at >= 0 ? src.slice(at, at + 500) : '';
    const sub: string[] = [];
    if (at < 0) sub.push('缺 SkillProjectDirsPayload 定义');
    else if (!body.includes('userSkillDirNames: Record<string, string>')) sub.push('载荷类型缺 userSkillDirNames: Record<string, string>（必填，handler 恒产）');
    check('⑦', 'SkillProjectDirsPayload 含 userSkillDirNames: Record<string, string>', sub.length === 0, sub.join('; '));
  }

  // ⑧ ChatInput seam：菜单过滤第三参同源映射
  {
    const src = readRel('src/renderer/components/chat/ChatInput.vue');
    const sub: string[] = [];
    const mAt = src.indexOf('const matchingCommands');
    const mBody = mAt >= 0 ? src.slice(mAt, mAt + 900) : '';
    if (!src.includes('menuSkillNameToDir')) sub.push('缺 fm 名→目录名解析 seam（menuSkillNameToDir）');
    if (mAt < 0) sub.push('缺 matchingCommands 定义');
    else if (!/filterMenuCommandsBySkillOverrides\([\s\S]{0,160}?menuSkillNameToDir\.value/.test(mBody)) sub.push('matchingCommands 过滤链未以第三参传入 menuSkillNameToDir.value');
    const nAt = src.indexOf('const menuSkillNameToDir');
    const nBody = nAt >= 0 ? src.slice(nAt, nAt + 500) : '';
    if (nAt < 0) sub.push('缺 menuSkillNameToDir 定义');
    else if (!nBody.includes('userSkillDirNames')) sub.push('seam 未读 commandStore.userSkillDirNames（与 ConfigPage 现查同源）');
    check('⑧', 'ChatInput：menuSkillNameToDir seam（同源映射槽）+ matchingCommands 过滤链第三参', sub.length === 0, sub.join('; '));
  }

  // ⑨ command-store 映射槽位
  {
    const src = readRel('src/renderer/stores/command-store.ts');
    const sub: string[] = [];
    if (!src.includes('userSkillDirNames: {} as Record<string, string>')) sub.push('缺 userSkillDirNames 槽位声明（内存态映射槽）');
    check('⑨', 'command-store：state 含 userSkillDirNames 映射槽（ConfigPage 写 / ChatInput 读）', sub.length === 0, sub.join('; '));
  }

  console.log('\n=== 组5 旧行为回归（指向被改面的既有契约不破） ===');

  // ⑩ 轻量三份串行 spawn（dirs-status/loader・menu-filter・stale-keys——分别指向装载机透传、
  // 过滤函数签名扩展、D-1 全集扩展的被改面）；重链（project-dirs→overrides→regression）由静态
  // 链全覆盖不在本脚本内重复 spawn。
  {
    let bad = '';
    for (const s of ['scripts/tdd-skill-dirs-status-verify.ts', 'scripts/tdd-skill-menu-filter-verify.ts', 'scripts/tdd-skill-stale-keys-verify.ts']) {
      const r = spawnSync('npx', ['tsx', s], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
      if (r.status !== 0) {
        bad += `${s} exit=${r.status}\n${`${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-200)}\n`;
        break;
      }
    }
    check('⑩', 'dirs-status / menu-filter / stale-keys 三份既有契约全绿（被改面回归实测门）', bad === '', bad.trim());
  }

  console.log(`\n===== tdd-skill-user-dirnames-verify: ${pass} pass / ${fail} fail =====`);
  if (fail > 0) console.log('（RED 阶段：FAIL 项为尚未实施的生产改动，实施后应全 PASS）');
  process.exit(fail > 0 ? 1 : 0);
}

void main().catch((e: unknown) => {
  console.error('runner crash:', e);
  process.exit(1);
});
