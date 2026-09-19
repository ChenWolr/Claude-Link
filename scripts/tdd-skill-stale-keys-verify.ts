// tdd-skill-stale-keys-verify.ts
// D-1（review 2026-09-18 §3-3）：skillOverrides 死键无生命周期——skill 删除/改名后 'off' 键永久
// 残留（每条新会话把含死键全量 JSON 钉进 sessions.skill_overrides 列）。
// 整改 = ConfigPage「清理失效键」入口：键 ∈ skillOverrides 但 ∉（全局 userSkills 名集 ∪ 当前已
// 枚举全部项目目录 skills 开关键）者列为「疑似失效」，确认后删；不做自动清理。
//
// 断言：① shared/project-skills 新纯函数 findStaleSkillKeys 行为（识别死键；全局名/项目开关键
// 覆盖不放行；null overrides → 空数组）② ConfigPage 消费形态：computed 接纯函数（全局 ∪ 项目
// dirName 全集）、清理函数走 requestConfirm 确认 + 写路径（逐键 delete 后整体替换）、模板有
// 「清理失效键」按钮且仅在非探测态渲染。
// RED 预期（未修复树）：①② FAIL。运行：npx tsx scripts/tdd-skill-stale-keys-verify.ts。

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`  ❌ ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ① 纯函数行为：findStaleSkillKeys（死键识别）
{
  let mod: any = null;
  let err = '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require(path.resolve(repoRoot, 'src', 'shared', 'project-skills.ts'));
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  const f: unknown = mod?.findStaleSkillKeys;
  const sub: string[] = [];
  if (typeof f !== 'function') {
    sub.push(`导出 findStaleSkillKeys 不可用${err ? `（模块加载失败：${err.slice(0, 120)}）` : ''}`);
  } else {
    const fn = f as (o: Record<string, 'off'> | null | undefined, g: string[], p: string[]) => string[];
    if (fn(null, [], []) !== undefined && !deepEq(fn(null, [], []), [])) sub.push('null overrides 应返回 []');
    if (fn(undefined, ['a'], ['b']) === undefined) sub.push('undefined overrides 应返回数组（非 undefined）');
    if (!deepEq(fn({}, ['a'], ['b']), [])) sub.push('空 overrides 应返回 []');
    const overrides = { dead: 'off', alive: 'off', 'proj-only': 'off' } as Record<string, 'off'>;
    const out = fn(overrides, ['alive'], ['proj-only']);
    if (!deepEq(out, ['dead'])) sub.push(`仅未知键应列出，实际 ${JSON.stringify(out)}`);
    // 防误删口径：未挂载项目目录的键不在入参全集 → 会被列为「疑似」（入口语义，确认后才删）
    if (!deepEq(fn({ ghost: 'off' }, [], []), ['ghost'])) sub.push('全集外的键应列为疑似失效');
    if (!deepEq(fn({ A: 'off' }, ['a'], []), ['A'])) sub.push('开关键区分大小写（A ≠ a）');
  }
  check('①', 'findStaleSkillKeys：null/空 → []；全集外键列出；全局名/项目键覆盖不放行；大小写敏感', sub.length === 0, sub.join('; '));
}

// ② ConfigPage 消费形态：computed 接纯函数 + requestConfirm 清理写路径 + 模板按钮
{
  const src = read('src/renderer/pages/ConfigPage.vue');
  const sub: string[] = [];
  if (!src.includes('findStaleSkillKeys')) sub.push('ConfigPage 未消费 findStaleSkillKeys');
  const cAt = src.indexOf('const staleSkillKeys');
  // 窗口 800（X-1 批 2026-09-19 同步申报：computed 头部新增 isStaleKeyScanReady 就绪门控块后，
  // 尾部 findStaleSkillKeys 全集行偏移至 ~698；窗宽适配，钉意图不变——仍钉 userSkills/projectDirs/
  // skillKey 三消费在位）。
  const cBody = cAt >= 0 ? src.slice(cAt, cAt + 800) : '';
  if (cAt < 0) sub.push('缺 staleSkillKeys computed');
  else {
    if (!cBody.includes('userSkills')) sub.push('识别全集缺全局 userSkills 名集');
    if (!cBody.includes('projectDirs')) sub.push('识别全集缺项目目录 skills');
    if (!cBody.includes('skillKey(')) sub.push('项目侧识别应按 skillKey（目录名键）口径');
  }
  if (!/function cleanupStaleSkillKeys/.test(src)) sub.push('缺 cleanupStaleSkillKeys 清理函数');
  else {
    const fAt = src.indexOf('function cleanupStaleSkillKeys');
    const fBody = src.slice(fAt, fAt + 1100);
    if (!fBody.includes('requestConfirm')) sub.push('清理未走 requestConfirm 确认（不做无守卫删除）');
    if (!/delete next\[\w+\]/.test(fBody)) sub.push('写路径缺逐键 delete');
    if (!fBody.includes('store.config.skillOverrides = next')) sub.push('写路径缺整体替换触发自动保存');
  }
  if (!src.includes('清理失效键')) sub.push('模板缺「清理失效键」入口文案');
  if (!/ @click="cleanupStaleSkillKeys\(\)"/.test(src)) sub.push('模板按钮未接线 cleanupStaleSkillKeys');
  check('②', 'ConfigPage：staleSkillKeys computed（全局∪项目 dirName 全集）+ requestConfirm 清理写路径 + 模板入口', sub.length === 0, sub.join('; '));
}

console.log(`\n===== tdd-skill-stale-keys-verify: ${pass} pass / ${fail} fail =====`);
if (fail > 0) console.log('（RED 阶段：FAIL 项为尚未实施的生产改动，实施后应全 PASS）');
process.exit(fail > 0 ? 1 : 0);
