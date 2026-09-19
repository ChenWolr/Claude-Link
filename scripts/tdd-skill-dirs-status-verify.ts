// tdd-skill-dirs-status-verify.ts
// C-5 + C-6 + C-7（含 E-7，review 2026-09-18 §3-7/3-8/3-9）：
// - C-5：项目目录拉取无 loading/错误态——首拍 rail 显「0 个目录」误导；reject 静默永久退化。
//   整改 = projectDirsPending/projectDirsError ref + rail pending「读取中…」/error 错误行+重试按钮。
// - E-7（§7 裸奔点收口）：SKILL_PROJECT_DIRS_GET 错误路径无契约——shared 新装载状态机
//   loadSkillProjectDirs（桩 reject 行为测：Error 取 message / 非 Error 归一固定文案）+ ConfigPage
//   catch 形态钉（错误进 projectDirsError 不再吞到无形）。
// - C-6：rail 全局行统计不受 pending 门控（探测中显「共 0·0 启用」与统计卡矛盾）——全局行 meta
//   在 skillProbePending 时显「…」。
// - C-7：全局零空态不区分——全局分支补真零（~/.claude/skills 放置引导）/筛选零两态（探测中由
//   既有 !skillProbePending 门控承担第三态）。
// 断言体包 async main 执行（tsx CJS 无顶层 await，先例教训）。
// RED 预期（未修复树）：①（loader 不存在）②（ConfigPage 形态）③（rail 门控）④（空态三态）全 FAIL。
// 运行：npx tsx scripts/tdd-skill-dirs-status-verify.ts。

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

async function main(): Promise<void> {
  // ① E-7 行为 seam：loadSkillProjectDirs 桩 reject 行为测
  {
    let mod: any = null;
    let err = '';
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require(path.resolve(repoRoot, 'src', 'shared', 'project-skills.ts'));
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    const fn: unknown = mod?.loadSkillProjectDirs;
    const sub: string[] = [];
    if (typeof fn !== 'function') {
      sub.push(`导出 loadSkillProjectDirs 不可用${err ? `（模块加载失败：${err.slice(0, 120)}）` : ''}`);
    } else {
      const load = fn as (f: () => Promise<{ dirs: unknown[] }>) => Promise<{ ok: boolean; dirs?: unknown[]; error?: string }>;
      // resolve → ok
      const r1 = await load(async () => ({ dirs: [{ path: 'D:\\a', name: 'a', isDefault: false, sessionCount: 0, skills: [] }] }));
      if (!r1.ok || r1.dirs?.length !== 1) sub.push(`resolve 应得 {ok:true,dirs}，实际 ${JSON.stringify(r1)}`);
      // reject Error → 取 message
      const r2 = await load(async () => { throw new Error('ipc down'); });
      if (r2.ok !== false || r2.error !== 'ipc down') sub.push(`reject(Error) 应得 {ok:false,error:'ipc down'}，实际 ${JSON.stringify(r2)}`);
      // reject 非 Error → 归一固定文案（不吞到无形）
      const r3 = await load(async () => { throw 'boom'; });
      if (r3.ok !== false || typeof r3.error !== 'string' || r3.error.length === 0) sub.push(`reject(非 Error) 应归一非空 error 文案，实际 ${JSON.stringify(r3)}`);
    }
    check('①', 'loadSkillProjectDirs：resolve→{ok,dirs}；reject(Error)→message；reject(非 Error)→归一文案', sub.length === 0, sub.join('; '));
  }

  // ② ConfigPage：pending/error ref + ensureProjectDirs 状态机形态 + rail pending/error 行
  {
    const src = read('src/renderer/pages/ConfigPage.vue');
    const sub: string[] = [];
    if (!/const projectDirsPending\s*=\s*ref\(false\)/.test(src)) sub.push('缺 projectDirsPending ref');
    if (!/const projectDirsError\s*=\s*ref</.test(src)) sub.push('缺 projectDirsError ref');
    const fnAt = src.indexOf('async function ensureProjectDirs');
    // 窗口 1400（Y-1 批 2026-09-19 同步申报：ok 分支新增超时判定 if/else 与注释后，尾部
    // pending=false 清位行偏移至 ~1000；窗宽适配，钉意图不变）。
    const body = fnAt >= 0 ? src.slice(fnAt, fnAt + 1400) : '';
    if (fnAt < 0) sub.push('缺 ensureProjectDirs 定义');
    else {
      if (!body.includes('loadSkillProjectDirs')) sub.push('ensureProjectDirs 未走 loadSkillProjectDirs 装载状态机（E-7）');
      if (!/projectDirsPending\.value\s*=\s*true/.test(body)) sub.push('装载前未置 pending=true');
      if (!/projectDirsError\.value\s*=/.test(body)) sub.push('错误分支缺 projectDirsError 写入（catch 不再吞到无形）');
      if (!/projectDirsPending\.value\s*=\s*false/.test(body)) sub.push('装载后未清 pending');
      if (!/requestId\s*!==\s*projectDirsRequestId/.test(body)) sub.push('代际守卫失守（C-4 回归）');
    }
    if (!src.includes('skill-md-rail__status')) sub.push('rail 缺状态行类（skill-md-rail__status）');
    if (!src.includes('项目目录读取中')) sub.push('rail 缺 pending「读取中」占位');
    if (!/@click="ensureProjectDirs\(\)"/.test(src)) sub.push('error 行缺重试按钮接线（重调 ensureProjectDirs）');
    check('②', 'ConfigPage：pending/error ref + 装载状态机（E-7 catch 收口）+ rail pending/error 行与重试', sub.length === 0, sub.join('; '));
  }

  // ③ C-6：rail 全局行 meta 在 skillProbePending 时显「…」（与统计卡同门控）
  {
    const src = read('src/renderer/pages/ConfigPage.vue');
    const metaAt = src.indexOf('skill-md-item__meta');
    const meta = metaAt >= 0 ? src.slice(metaAt, metaAt + 400) : '';
    const ok = metaAt >= 0 && meta.includes('skillProbePending') && meta.includes('共 {{ userSkills.length }}');
    check('③', 'rail 全局行 meta 受 skillProbePending 门控（探测中不再误显 共0·0 启用）', ok,
      ok ? '' : '全局行 meta 未按 skillProbePending 门控（探测中误显 共0·0 启用）');
  }

  // ④ C-7：全局零空态三态区分（真零=~/.claude/skills 放置引导；筛选零=原文案；探测中=既有门控）
  {
    const src = read('src/renderer/pages/ConfigPage.vue');
    const emptyAt = src.indexOf('visibleSkills.length === 0');
    const empty = emptyAt >= 0 ? src.slice(emptyAt, emptyAt + 1100) : '';
    const sub: string[] = [];
    if (emptyAt < 0) sub.push('缺空态臂');
    else {
      if (!empty.includes('userSkills.length === 0')) sub.push('全局分支缺真零判定');
      if (!empty.includes('~/.claude/skills')) sub.push('真零缺 ~/.claude/skills 放置引导文案');
      if (!empty.includes('当前筛选下无匹配的全局 Skill')) sub.push('筛选零文案丢失（回归）');
    }
    check('④', '全局空态三态：真零放置引导 / 筛选零保留 / 探测中既有门控', sub.length === 0, sub.join('; '));
  }

  console.log(`\n===== tdd-skill-dirs-status-verify: ${pass} pass / ${fail} fail =====`);
  if (fail > 0) console.log('（RED 阶段：FAIL 项为尚未实施的生产改动，实施后应全 PASS）');
  process.exit(fail > 0 ? 1 : 0);
}

void main().catch((e: unknown) => {
  console.error('runner crash:', e);
  process.exit(1);
});
