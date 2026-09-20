// tdd-skill-menu-filter-verify.ts
// B-5（review 2026-09-18 §3-2）：'/' 菜单展示被禁 skill（展示面收口）。
// V1 引擎实验实证 supportedCommands 不经 skillOverrides 过滤（ready 态菜单同样展示被禁项）；
// Phase 0-1 实验实证键入有引擎本地拦截（0 模型请求）——菜单展示是 B-5 的最后残面，修法=纯展示层
// 过滤。取值口径：暂态/未探测=全局现值（config.skillOverrides，与 command-store load/回填同源）；
// 已物化=该会话创建时钉住值（Session.skillOverrides，与 buildClaudeLinkSettingsBlock 注入同源）。
//
// 断言：① shared/command-filter 新纯函数 filterMenuCommandsBySkillOverrides 行为（仅 user-skill
// 来源参与禁用过滤，builtin/project/plugin/无 origin 同名条目保留；空 overrides 原引用返回）
// ② ChatInput 消费形态：matchingCommands 的 filterRenderableCommands 链套用新过滤 + 取值 seam
// （menuSkillOverrides：暂态→config 现值 / 已物化→session.skillOverrides 钉住值）。
// RED 预期（未修复树）：①② FAIL。运行：npx tsx scripts/tdd-skill-menu-filter-verify.ts。

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ① 纯函数行为：filterMenuCommandsBySkillOverrides（origin 感知变体）
{
  let mod: any = null;
  let err = '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require(path.resolve(repoRoot, 'src', 'shared', 'command-filter.ts'));
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  const f: unknown = mod?.filterMenuCommandsBySkillOverrides;
  const sub: string[] = [];
  if (typeof f !== 'function') {
    sub.push(`导出 filterMenuCommandsBySkillOverrides 不可用${err ? `（模块加载失败：${err.slice(0, 120)}）` : ''}`);
  } else {
    const flt = f as <T extends { name: string; origin?: string }>(cmds: T[], o: Record<string, 'off'> | null | undefined) => T[];
    const cmds = [
      { name: 'pua', origin: 'user-skill' },
      { name: 'other', origin: 'builtin' },
      { name: 'pua', origin: 'plugin' },
      { name: 'pua', origin: 'project' },
      { name: 'noorigin' },
    ];
    if (flt(cmds, null) !== cmds) sub.push('overrides=null → 应原数组引用返回');
    if (flt(cmds, undefined) !== cmds) sub.push('overrides=undefined → 应原数组引用返回');
    if (flt(cmds, {}) !== cmds) sub.push('overrides={} → 应原数组引用返回');
    const out = flt(cmds, { pua: 'off' });
    if (!deepEq(out.map((c) => `${c.name}:${c.origin ?? '-'}`), ['other:builtin', 'pua:plugin', 'pua:project', 'noorigin:-']))
      sub.push(`仅 user-skill 的 pua 应被剔除，实际 ${JSON.stringify(out.map((c) => `${c.name}:${c.origin ?? '-'}`))}`);
    if (flt(cmds, { PUA: 'off' }).length !== 5) sub.push('大小写不匹配（PUA vs pua）应全保留（canonical 名区分大小写）');
    const onlyUser = [{ name: 'a', origin: 'user-skill' }, { name: 'b', origin: 'user-skill' }];
    if (!deepEq(flt(onlyUser, { b: 'off' }).map((c) => c.name), ['a'])) sub.push('多 user-skill 命中应只剔被禁者');
  }
  check('①', 'filterMenuCommandsBySkillOverrides：空 overrides 原引用；仅剔 user-skill 命中键；大小写不匹配不动', sub.length === 0, sub.join('; '));
}

// ② ChatInput 消费形态：matchingCommands 过滤链 + 取值 seam（暂态=全局现值 / 已物化=钉住值）
{
  const src = read('src/renderer/components/chat/ChatInput.vue');
  const sub: string[] = [];
  if (!src.includes('filterMenuCommandsBySkillOverrides')) sub.push('ChatInput 未接入 filterMenuCommandsBySkillOverrides');
  const mAt = src.indexOf('const matchingCommands');
  const mBody = mAt >= 0 ? src.slice(mAt, mAt + 900) : '';
  if (mAt < 0) sub.push('缺 matchingCommands 定义');
  else if (!mBody.includes('filterMenuCommandsBySkillOverrides')) sub.push('matchingCommands 链未套用菜单过滤');
  const oAt = src.indexOf('const menuSkillOverrides');
  const oBody = oAt >= 0 ? src.slice(oAt, oAt + 700) : '';
  if (oAt < 0) sub.push('缺 menuSkillOverrides 取值 computed');
  else {
    if (!/\.transient/.test(oBody)) sub.push('取值 seam 缺暂态判定（session.transient）');
    if (!oBody.includes('config.skillOverrides')) sub.push('取值 seam 缺全局现值回退（config.skillOverrides）');
    if (!/session\.skillOverrides|activeSession\.skillOverrides/.test(oBody)) sub.push('取值 seam 缺已物化钉住值（session.skillOverrides）');
  }
  check('②', 'ChatInput：matchingCommands 链套用过滤；取值 seam 暂态→config 现值 / 已物化→钉住值', sub.length === 0, sub.join('; '));
}

console.log(`\n===== tdd-skill-menu-filter-verify: ${pass} pass / ${fail} fail =====`);
if (fail > 0) console.log('（RED 阶段：FAIL 项为尚未实施的生产改动，实施后应全 PASS）');
process.exit(fail > 0 ? 1 : 0);
