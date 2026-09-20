// tdd-skill-x123-verify.ts
// X-1/X-2/X-3（docs/audit/2026-09-19-skill-fix-independent-review.md §2，P3×3 整改契约）：
// - X-1（P3）D-1 失效键识别三个「假失效」窗口（全局快照 degraded/error/empty → commands=[] 全局
//   禁用键被全数误判；项目目录 pending/error → 项目侧键集缺席；fm≠dir 且映射未就绪 → 目录名历史键
//   被误判）可诱导用户确认删除有效禁用键。整改 = 清理入口数据层门控：shared 新纯函数
//   isStaleKeyScanReady（快照 ready + 目录装载空闲无错 + 映射至少成功装载一次 才放行），
//   ConfigPage staleSkillKeys 非就绪态恒 []（渲染行 v-if 长度判定与 cleanupStaleSkillKeys 同闸门）。
// - X-2（P3）fm≠dir 全局 skill 在映射载荷落地前拨开关 → 写引擎不认的 frontmatter 名键 + UI 回弹。
//   整改 = 全局卡片开关在 userSkillDirNamesReady=false 时禁用（:disabled + :title 提示；W-2 后
//   title 按 userDirNamesTimedOut 分化「键名映射读取中/键名映射读取超时」，见文末 W 批块）；
//   项目条目 dirName 恒来自磁盘枚举不受门控（表达式含 skillScope.kind === 'global'）。
// - X-3（P3）collectUserSkillDirNames 无超时预算、不在 in-flight 共享内——D-4 起跟随 symlink，
//   坏链接单条 stat/open 可占线程数十秒（P2-4 实测 31s 量级），拖挂整个 SKILL_PROJECT_DIRS_GET。
//   整改 = 封装在本模块导出内（先例 collectSkillProjectDirs/collectInFlight 同形态）：整根枚举套
//   withTimeout(…, 3000) 超时回退空映射（?? [] → {}，与项目路径「枚举超时 skills=[]」同语义），
//   并发调用共享独立单槽 userDirNamesInFlight（rootDir 恒定无需键控）+ finally 条件清空；
//   SKILL_PROJECT_DIRS_GET handler 调用形态不变（ipc-handlers 零改动）。
// Y-1（2026-09-19 X-123 批独立评审 §2，P3）：X-3 超时回退 `?? []` 以空映射正常 resolve，渲染层
//   ok 分支无条件覆盖映射槽 + 置 ready=true——「ready+空映射」使 X-1 假失效与 X-2 无效键写入
//   复活，且超时无负缓存、坏链接存在期间每次进 tab 持续复现。整改 = 超时与「合法空」在载荷层
//   区分：①collectUserSkillDirNamesUncached 超时（withTimeout 归 null）→ resolve null 哨兵
//   （不再 ?? [] 以空映射落地；「不存在/读失败 → 空对象」既有语义保留），包装签名改
//   Promise<Record<string,string> | null>，枚举器/超时预算可注入（badDirCache now 注入先例同款
//   seam，契约行为级验证哨兵）；②载荷 SkillProjectDirsPayload.userSkillDirNamesTimedOut?:
//   boolean（handler 透传哨兵态；userSkillDirNames 恒为对象——槽/seam/attach 消费链零触碰）；
//   ③loadSkillProjectDirs resolve 分支透传该标记（缺省归一 false）；ConfigPage ok 分支超时态
//   不覆盖映射槽、不置 userSkillDirNamesReady（首访超时 ready=false → X-1/X-2 门控自然兜住；
//   曾装载过则保留旧映射，消费旧值为已申报残面）；rail 第三态超时轻提示（不写 projectDirsError
//   ——项目目录与用户根两源独立）；main X-3 注释「渲染层 X-1 门控下不产生假失效」错误论断同步
//   修正（该门控挡「未装载」挡不住「装载成功但内容为空」，超时现经 null 哨兵区分）。
// 断言（8 条，Y-1 批扩 ⑤⑥⑦、Y-3 批扩 ⑧；Y-2 批 ① 矩阵 empty 行为改放行同步改断言；W-3 计数修正）：
// ①isStaleKeyScanReady 行为矩阵（shared 直调——就绪唯一真值 + degraded/error/loading/null/
//   undefined/目录 pending/error/映射未就绪全拒 + Y-2：empty 合法终态放行）
// ②ConfigPage 形态钉（staleSkillKeys 早退门四要素 + userSkillDirNamesReady ref 声明与 ok 分支写
// true + skill-stale-row 模板入口回归）③X-2 形态钉（switch :disabled/:title 门控 + 开关写链回归）
// ④collectUserSkillDirNames 并发共享行为（真实 fs 夹具：并发双调解析值同一对象 + 落定后槽清空取新）
// ⑤Y-1 超时哨兵行为（注入 seam 受控触发：永不落定枚举器+40ms 预算 → null；不存在→{} 非 null；
// 正常路径默认枚举器回归）⑥X-3/Y-1 源形钉（单槽含 null 联合 + 早退共享 + finally 条件清空 + 超时
// null 哨兵——旧 withTimeout(enumerateSkillsRoot,3000) ?? [] 钉随 Y-1 改行为同步废止 + handler 载荷
// 映射/超时标记接线，dirs 三源 await 内联形态不动）⑦Y-1 载荷层/渲染层形态钉（类型
// 标记/装载机透传/ConfigPage 超时分支不覆盖槽不置 ready+复位+rail 超时第三态+main 注释论断修正；
// Z-1：超时文案按 userSkillDirNamesReady 分化）。
// SFC 不可行为实例化（仓库无 jsdom/@vue/test-utils）——②③⑦ 沿用「shared 行为测 + 组件形态钉」
// 既有口径。⑧ Y-3（OPT）：.switch:disabled 灰显 + not-allowed 形态钉（X-2 禁用态视觉收口）；
// Z-3：opacity 钉具体值 0.55（防 opacity:1 假绿）。
// Z 批（2026-09-19 Y-1 批独立评审 docs/audit/2026-09-19-skill-y1-independent-review.md §2）：
// Z-1（P3）⑦ 扩钉——「曾装载成功后超时」（ready=true+timedOut=true）态开关 disabled 只看 !ready
//   实际可拨，rail 文案宣称「全局开关暂不可用」与可交互状态矛盾；整改 = 文案按 ready 三元分化
//   （ready=true「正在使用上次成功读取的映射」/ready=false 维持「暂不可用」），两变体+分化门控钉入 ⑦。
//   RED：Z-1 批前树 ⑦ FAIL（缺分化文案与门控）；Z-2（OPT）① check 名称漏随 Y-2 同步，纯文案
//   如实化无行为 RED；Z-3（OPT）⑧ 值钉对当前树即 GREEN（生产已 0.55），区分力经 fix-tmp 变异
//   探针证明（opacity:1 旧钉过、新钉拒）。
// W 批（2026-09-19 Z-1 批独立评审 docs/audit/2026-09-19-skill-z1-independent-review.md §2，OPT×3）：
// W-1（OPT）⑦ 三钉合一为方向绑定正则——旧三钉均为「窗内存在」级，分支对调变异体全绿（Z-1 缺陷
//   镜像回归不可见）；新钉把文案变体与三元分支一一绑定，对调即 FAIL。区分力经 fix-tmp/red-w/
//   w1-mutation-probe.log 变异探针证明（对调形态旧三钉全过、新钉拒），生产已合规无行为 RED。
// W-2（OPT，X-2/Y-1 批残面）ConfigPage :title 首访超时拍（ready=false+timedOut=true）装载已落定
//   为超时非进行中，由「键名映射读取中」分化出「键名映射读取超时」（与 rail 同拍措辞）；
//   ③ :title 钉同步改方向绑定形态（超时/读取中对调即 FAIL）。
// W-3（OPT，Y-3 批残面）头注释断言计数 7→8（⑧ 由 Y-3 批追加，:54 已改 8/8 而 :30 未同步），纯注释。
// RED 预期（Y-1 前树）：⑤⑥⑦ FAIL；①②③④ PASS（既有基线断言不破，区分力在哨兵形态/seam
// 行为/载荷标记与超时分支）；Y-2 批 RED：① empty 放行行 FAIL 余全 PASS；Y-3 批 RED：⑧ FAIL
// 余全 PASS；Z-1 批 RED：⑦ FAIL 余全 PASS；W 批 RED：③ FAIL 余全 PASS（W-2 生产未改前；
// W-1/W-3 无行为 RED）。GREEN 目标：8/8 全 PASS。
// 运行：npx tsx scripts/tdd-skill-x123-verify.ts（断言体包 async main——tsx CJS 无顶层 await，
// 先例教训；夹具在系统临时目录（os.tmpdir），绝不触碰仓库/用户真实 ~/.claude）。

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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

// 被测模块（RED 阶段导出不存在 → require 成功但导出为 undefined，断言降级 FAIL，脚本不 crash）。
let sharedMod: any = null;
let sharedModErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  sharedMod = require(path.resolve(repoRoot, 'src', 'shared', 'project-skills.ts'));
} catch (e) {
  sharedModErr = e instanceof Error ? e.message : String(e);
}
let mainMod: any = null;
let mainModErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  mainMod = require(path.resolve(repoRoot, 'src', 'main', 'modules', 'project-skills.ts'));
} catch (e) {
  mainModErr = e instanceof Error ? e.message : String(e);
}

// 断言体包 async main 执行（④为 await 行为断言；tsx CJS 无顶层 await）。
async function main(): Promise<void> {
  console.log('\n=== 组1 X-1 清理入口数据就绪门控（isStaleKeyScanReady + ConfigPage 消费） ===');

  // ① shared 纯函数行为矩阵：就绪唯一真值；快照非 ready（degraded/error/empty/loading/null/
  //   undefined）/目录 pending/目录 error/映射未就绪 任一成立即不放行
  {
    const sub: string[] = [];
    const fn: unknown = sharedMod?.isStaleKeyScanReady;
    if (typeof fn !== 'function') {
      sub.push(`导出 isStaleKeyScanReady 不可用${sharedModErr ? `（模块加载失败：${sharedModErr.slice(0, 120)}）` : ''}`);
    } else {
      const r = fn as (i: {
        snapshotStatus: string | null | undefined;
        projectDirsPending: boolean;
        projectDirsError: string | null | undefined;
        userSkillDirNamesReady: boolean;
      }) => boolean;
      const ready = { snapshotStatus: 'ready', projectDirsPending: false, projectDirsError: null, userSkillDirNamesReady: true };
      if (r(ready) !== true) sub.push(`全就绪应放行，实际 ${String(r(ready))}`);
      for (const bad of ['degraded', 'error', 'loading']) {
        if (r({ ...ready, snapshotStatus: bad }) !== false) sub.push(`快照 status=${bad} 不应放行（假失效窗口①）`);
      }
      // Y-2（2026-09-19 X-123 批评审 §2，改行为同步改断言）：empty 是探测成功的合法终态
      // （setGlobalFallback/replace：commands.length>0 ? 'ready' : 'empty'）——该态全局命令集真空，
      // overrides 键确为真失效键，全集只剩项目键语义仍安全，应放行；degraded/error（失败出口
      // 同为 commands=[]，不可作全集依据）与 loading 仍拒绝。
      if (r({ ...ready, snapshotStatus: 'empty' }) !== true) sub.push('快照 status=empty 应放行（Y-2：探测成功合法终态，键确为真失效）');
      if (r({ ...ready, snapshotStatus: null }) !== false) sub.push('快照 null 不应放行');
      if (r({ ...ready, snapshotStatus: undefined }) !== false) sub.push('快照 undefined 不应放行');
      if (r({ ...ready, projectDirsPending: true }) !== false) sub.push('目录 pending 中不应放行（假失效窗口②）');
      if (r({ ...ready, projectDirsError: 'read failed' }) !== false) sub.push('目录 error 不应放行（假失效窗口②）');
      if (r({ ...ready, userSkillDirNamesReady: false }) !== false) sub.push('映射未就绪不应放行（假失效窗口③，与 X-2 同根）');
    }
    // Z-2（2026-09-19 Y-1 批独立评审 §2，OPT）：名称漏随 Y-2 改行为同步——empty 已是放行臂，
    // 名称如实化（empty 放行、degraded/error/loading 拒绝），纯文案改无行为 RED。
    check('①', 'isStaleKeyScanReady：ready+空闲+无错+映射就绪 唯一放行；degraded/error/loading/null 快照、目录 pending/error、映射未就绪 拒绝；empty 合法终态放行（Y-2）', sub.length === 0, sub.join('; '));
  }

  // ② ConfigPage 形态钉：staleSkillKeys 早退门（isStaleKeyScanReady 四要素传参）+ 旗标声明与
  //   ensureProjectDirs ok 分支写入 + skill-stale-row 模板入口回归（基线子断言）
  {
    const src = readRel('src/renderer/pages/ConfigPage.vue');
    const sub: string[] = [];
    if (!src.includes('isStaleKeyScanReady')) sub.push('ConfigPage 未消费 isStaleKeyScanReady（X-1 门控缺失）');
    const cAt = src.indexOf('const staleSkillKeys');
    // 窗口 800：门控块在前、findStaleSkillKeys 全集行偏移 ~698（含回归基线键径断言）。
    const cBody = cAt >= 0 ? src.slice(cAt, cAt + 800) : '';
    if (cAt < 0) sub.push('缺 staleSkillKeys computed');
    else {
      if (!/if \(!isStaleKeyScanReady\(\{/.test(cBody)) sub.push('staleSkillKeys 缺就绪门控早退（未就绪应恒 []）');
      if (!cBody.includes('snapshotStatus')) sub.push('门控传参缺 snapshotStatus（快照 ready 要素）');
      if (!cBody.includes('projectDirsPending')) sub.push('门控传参缺 projectDirsPending 要素');
      if (!cBody.includes('projectDirsError')) sub.push('门控传参缺 projectDirsError 要素');
      if (!cBody.includes('userSkillDirNamesReady')) sub.push('门控传参缺 userSkillDirNamesReady 要素');
      if (!cBody.includes('userSkills.value.map((s) => skillKey(s))')) sub.push('D-1 全局全集键径回归破（user-dirnames ④ 基线）');
    }
    if (!/const userSkillDirNamesReady\s*=\s*ref\(false\)/.test(src)) sub.push('缺 userSkillDirNamesReady 旗标声明（首访前 false）');
    const eAt = src.indexOf('async function ensureProjectDirs');
    // 窗口 1400（Y-1 批 2026-09-19 同步申报：ok 分支新增超时判定 if/else 与注释后，就绪旗标
    // 写入行偏移至 ~900；窗宽适配，钉意图不变）。
    const eBody = eAt >= 0 ? src.slice(eAt, eAt + 1400) : '';
    if (eAt < 0) sub.push('缺 ensureProjectDirs 定义');
    else if (!/userSkillDirNamesReady\.value\s*=\s*true/.test(eBody)) sub.push('ensureProjectDirs ok 分支未写 userSkillDirNamesReady=true（映射「至少成功装载一次」旗标路径）');
    // 模板入口回归（基线子断言：清理行仍由 staleSkillKeys 长度驱动渲染，入口文案/接线不丢）
    if (!src.includes('v-if="staleSkillKeys.length > 0"')) sub.push('skill-stale-row 渲染条件回归破（v-if staleSkillKeys.length）');
    if (!src.includes('清理失效键')) sub.push('模板「清理失效键」入口文案丢失（基线回归）');
    if (!/ @click="cleanupStaleSkillKeys\(\)"/.test(src)) sub.push('模板按钮未接线 cleanupStaleSkillKeys（基线回归）');
    check('②', 'ConfigPage：staleSkillKeys 就绪门控早退（四要素）+ 旗标声明与 ok 分支写入 + 清理入口模板回归', sub.length === 0, sub.join('; '));
  }

  console.log('\n=== 组2 X-2 映射未就绪禁用全局开关（仅全局卡片，项目条目不受门控） ===');

  // ③ ConfigPage 形态钉：switch :disabled/:title 门控表达式 + 开关写链回归（skillKey/!== 'off'/
  //   handleSkillToggle 接线——⑮ 契约钉区字面不破）
  {
    const src = readRel('src/renderer/pages/ConfigPage.vue');
    const sub: string[] = [];
    if (!/:disabled="skillScope\.kind === 'global' && !userSkillDirNamesReady"/.test(src)) {
      sub.push('switch 缺 :disabled 门控（全局作用域 && 映射未就绪）');
    }
    // W-2（2026-09-19 Z-1 批独立评审 §2，OPT）：首访超时拍（ready=false+timedOut=true）装载已
    // 落定为超时非进行中，:title 按 userDirNamesTimedOut 分化出「键名映射读取超时」（与 rail
    // 同拍措辞）；装载中维持「键名映射读取中」、ready 态 undefined。方向绑定形态：两文案与
    // 内层分支对调即 FAIL。
    if (!/:title="skillScope\.kind === 'global' && !userSkillDirNamesReady\s*\?\s*\(userDirNamesTimedOut\s*\?\s*'键名映射读取超时'\s*:\s*'键名映射读取中'\s*\)\s*:\s*undefined"/.test(src)) {
      sub.push('switch :title 未按 userDirNamesTimedOut 方向绑定分化（W-2：超时臂「键名映射读取超时」/装载中臂「键名映射读取中」/ready undefined，缺失或对调即 FAIL）');
    }
    // 项目条目不受门控：disabled 表达式以 skillScope.kind === 'global' 为前提（project 恒 false）
    const dAt = src.indexOf(':disabled="skillScope.kind');
    const dBody = dAt >= 0 ? src.slice(dAt, dAt + 120) : '';
    if (dAt < 0 || !dBody.includes("skillScope.kind === 'global'")) sub.push('门控未按作用域收窄（项目条目不得被禁用）');
    // 开关写链回归（基线子断言：拨开关仍经 skillKey→setSkillEnabled，'off' 语义与自动保存链不动）
    if (!src.includes("!== 'off'")) sub.push("启用语义 !== 'off' 字面丢失（⑮ 基线回归）");
    if (!/PERSISTED_FIELDS\s*=\s*\[[\s\S]{0,800}?'skillOverrides'/.test(src)) sub.push("PERSISTED_FIELDS 缺 'skillOverrides'（⑮ 基线回归）");
    if (!/function skillKey\(/.test(src)) sub.push('缺 skillKey helper（⑰ 基线回归）');
    if (!/@change="handleSkillToggle\(skill, \$event\)"/.test(src)) sub.push('开关 @change 接线丢失（基线回归）');
    check('③', 'ConfigPage：全局开关 :disabled/:title 未就绪门控（项目条目豁免；W-2 :title 按 userDirNamesTimedOut 分化「读取超时/读取中」）+ 开关写链字面回归', sub.length === 0, sub.join('; '));
  }

  console.log('\n=== 组3 X-3 用户根枚举超时+in-flight 共享（真实 fs 夹具 + 源形钉） ===');

  // 临时夹具（fix-tmp，用毕清理；模拟 ~/.claude/skills 根——不触碰真实用户目录）。
  const fixtureRoot = path.join(os.tmpdir(), 'claude-link-fixtures', `x123-fixture-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(fixtureRoot, { recursive: true });
    const skillsRoot = path.join(fixtureRoot, 'user-skills');
    fs.mkdirSync(path.join(skillsRoot, 'dir-fm-diff'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'dir-fm-diff', 'SKILL.md'), '---\nname: fm-diff\ndescription: fm differs\n---\nbody', 'utf8');

    // ④ 并发共享行为：同步双调共享同一在飞枚举——解析值同一对象（async 包装器各自回传新 Promise
    //   外壳，与 collectInFlight 先例同构，故钉解析值身份而非 Promise 对象身份）；落定后槽清空，
    //   再调取新鲜结果（不得吃到旧共享）
    {
      const sub: string[] = [];
      const fn: unknown = mainMod?.collectUserSkillDirNames;
      if (typeof fn !== 'function') {
        sub.push(`导出 collectUserSkillDirNames 不可用${mainModErr ? `（模块加载失败：${mainModErr.slice(0, 120)}）` : ''}`);
      } else {
        const c = fn as (root: string) => Promise<Record<string, string>>;
        const p1 = c(skillsRoot);
        const p2 = c(skillsRoot);
        const m1 = await p1;
        const m2 = await p2;
        if (!Object.is(m1, m2)) sub.push('并发双调应共享同一在飞枚举（解析值须同一对象；独立双跑必产出不同结果对象）');
        if (m1['fm-diff'] !== 'dir-fm-diff') sub.push(`共享结果应含 fm-diff→dir-fm-diff，实际 ${JSON.stringify(m1['fm-diff'])}`);
        // 落定后槽清空：新增目录后再调须取新鲜结果（不得吃到旧共享）
        fs.mkdirSync(path.join(skillsRoot, 'second-dir'), { recursive: true });
        fs.writeFileSync(path.join(skillsRoot, 'second-dir', 'SKILL.md'), '---\nname: second\ndescription: added after first settle\n---\nbody', 'utf8');
        const m3 = await c(skillsRoot);
        if (m3['second'] !== 'second-dir') sub.push(`在飞槽落定后应清空（再调须全量重枚举到新增 skill second→second-dir），实际 ${JSON.stringify(m3['second'])}`);
        if (m3['fm-diff'] !== 'dir-fm-diff') sub.push('新调用应保留既有条目（全量重枚举非增量）');
      }
      check('④', 'collectUserSkillDirNames：并发双调共享同一在飞枚举（解析值同一对象）；落定后槽清空、再调取新鲜全量结果', sub.length === 0, sub.join('; '));
    }

    console.log('\n=== 组4 Y-1 超时哨兵行为（注入 seam 受控触发——超时行为本身不可稳定复现，同 P2-4 now 注入先例口径） ===');

    // ⑤ Y-1 超时哨兵行为（真实 fs 夹具 + 注入 seam：badDirCache now 注入先例同款）——超时 resolve
    //   null（不得以空映射正常 resolve）；「目录不存在 → 空对象」非 null（合法空与超时须可区分）；
    //   正常路径默认枚举器不受 seam 影响回归。
    {
      const sub: string[] = [];
      const fn: unknown = mainMod?.collectUserSkillDirNames;
      if (typeof fn !== 'function') {
        sub.push(`导出 collectUserSkillDirNames 不可用${mainModErr ? `（模块加载失败：${mainModErr.slice(0, 120)}）` : ''}`);
      } else {
        type EnumResult = Array<{ name: string; dirName: string; description: string }>;
        const c = fn as (
          root: string,
          inject?: { enumerator?: (root: string) => Promise<EnumResult>; timeoutMs?: number },
        ) => Promise<Record<string, string> | null>;
        // 超时 → null 哨兵：注入永不落定的枚举器 + 40ms 极小预算（受控触发，不等待真实 3s）
        const timedOut = await c(path.join(skillsRoot, 'probe'), {
          enumerator: () => new Promise<EnumResult>(() => {}),
          timeoutMs: 40,
        });
        if (timedOut !== null) sub.push(`超时应 resolve null 哨兵（不得以空映射正常 resolve），实际 ${JSON.stringify(timedOut)}`);
        // 「不存在/读失败 → 空对象」既有语义保留（非 null——合法空与超时在载荷层可区分）
        const absent = await c(path.join(fixtureRoot, 'no-such-root'));
        if (absent === null) sub.push('目录不存在应得空对象而非 null 哨兵（合法空≠超时）');
        else if (Object.keys(absent).length !== 0) sub.push(`目录不存在应空对象，实际 ${JSON.stringify(absent)}`);
        // 正常路径（默认枚举器、默认预算）不受 seam 影响
        const normal = await c(skillsRoot);
        if (normal === null || normal['fm-diff'] !== 'dir-fm-diff') {
          sub.push(`正常路径应返回真实映射（seam 缺省不劫持），实际 ${JSON.stringify(normal === null ? null : normal['fm-diff'])}`);
        }
      }
      check('⑤', 'collectUserSkillDirNames 超时哨兵（注入 seam）：超时→null 不得空映射落地；不存在→{} 非 null（合法空可区分）；正常路径默认枚举器回归', sub.length === 0, sub.join('; '));
    }
  } finally {
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }

  // ⑥ X-3/Y-1 源形钉：单槽声明（超时哨兵态含 null 联合）+ 早退共享 + finally 条件清空
  //   + 超时 null 哨兵（X-1 批旧钉「withTimeout(enumerateSkillsRoot,3000) ?? []」随 Y-1 改行为
  //   同步废止——超时不得以空映射落地）+ handler 载荷映射/超时标记接线（dirs 三源 await 内联
  //   形态不动——enum-resilience ⑤ / project-dirs ⑨ 钉不破）
  {
    const src = readRel('src/main/modules/project-skills.ts');
    const ipc = readRel('src/main/ipc-handlers.ts');
    const sub: string[] = [];
    if (!/let userDirNamesInFlight:\s*Promise<Record<string, string> \| null>\s*\|\s*null\s*=\s*null/.test(src)) {
      sub.push('缺 userDirNamesInFlight 在飞槽（Y-1：槽类型须含 null 联合以承载超时哨兵）');
    }
    if (!/if \(userDirNamesInFlight\) return userDirNamesInFlight;/.test(src)) {
      sub.push('缺并发早退共享形态（if (userDirNamesInFlight) return）');
    }
    if (!/if \(userDirNamesInFlight === promise\) userDirNamesInFlight = null;/.test(src)) {
      sub.push('缺 finally 条件清空在飞槽（仅自身在飞时清空）');
    }
    // Y-1 改行为同步改断言：超时 → null 哨兵（withTimeout 归 null 不得以空映射正常 resolve）
    if (!/const skills = await withTimeout\(\s*enumerate\(skillsRoot\),\s*inject\?\.timeoutMs \?\? 3000\s*\);\s*if \(skills === null\) return null;/.test(src)) {
      sub.push('缺 Y-1 超时 null 哨兵形态（withTimeout 归 null → return null；旧 ?? [] 空映射回退已废）');
    }
    if (/withTimeout\(enumerateSkillsRoot\(/.test(src)) sub.push('用户根枚举旧直调形态残留（应经可注入 seam 选择枚举器）');
    // handler 接线：null 哨兵先落 const 再分流——载荷恒回对象 + 超时标记（基线子断言：dirs 三源 await 内联不动）
    const at = ipc.indexOf('ipcMain.handle(IPC_CHANNELS.SKILL_PROJECT_DIRS_GET');
    const region = at >= 0 ? ipc.slice(at, at + 900) : '';
    if (!/const userDirNames = await collectUserSkillDirNames\(/.test(region)) {
      sub.push('handler 缺 const userDirNames = await collectUserSkillDirNames(…)（null 哨兵须先落 const 再分流）');
    }
    if (!/userSkillDirNames:\s*userDirNames \?\? \{\}/.test(region)) {
      sub.push('handler 载荷缺 userSkillDirNames: userDirNames ?? {}（哨兵态空对象兜底，槽消费链零触碰）');
    }
    if (!/userSkillDirNamesTimedOut:\s*userDirNames === null/.test(region)) {
      sub.push('handler 载荷缺 userSkillDirNamesTimedOut: userDirNames === null（超时标记透传）');
    }
    if (!/dirs:\s*await\s+collectSkillProjectDirs/.test(region)) {
      sub.push('handler dirs: await collectSkillProjectDirs 内联形态丢失（enum-resilience ⑤ / project-dirs ⑨ 基线回归）');
    }
    check('⑥', 'project-skills 源形：userDirNamesInFlight 单槽（含 null 联合）+ 早退共享 + finally 条件清空 + 超时 null 哨兵（旧 ?? [] 已废）；handler 载荷映射兜底 + 超时标记接线 + dirs 内联回归', sub.length === 0, sub.join('; '));
  }

  console.log('\n=== 组5 Y-1 载荷层/渲染层形态钉（超时与合法空在载荷层区分） ===');

  // ⑦ 载荷标记 + 装载机透传 + ConfigPage 超时分支（不覆盖槽/不置 ready/复位 + rail 超时第三态）
  //   + main 注释错误论断修正（「渲染层 X-1 门控下不产生假失效」不成立——该门控挡「未装载」
  //   挡不住「装载成功但内容为空」，超时现经 null 哨兵区分）
  {
    const cmdTypes = readRel('src/shared/types/command.ts');
    const shared = readRel('src/shared/project-skills.ts');
    const cfg = readRel('src/renderer/pages/ConfigPage.vue');
    const mainSrc = readRel('src/main/modules/project-skills.ts');
    const sub: string[] = [];
    // 载荷类型：userSkillDirNames 恒为对象（下游消费链零触碰）+ 可选超时标记
    if (!/userSkillDirNames:\s*Record<string, string>/.test(cmdTypes)) sub.push('载荷 userSkillDirNames 应维持恒对象类型（槽/seam/attach 消费链零触碰）');
    if (!/userSkillDirNamesTimedOut\?\s*:\s*boolean/.test(cmdTypes)) sub.push('载荷类型缺 userSkillDirNamesTimedOut?: boolean（超时标记）');
    // 装载机：resolve 分支透传该标记（缺省归一 false——旧载荷/非超时走常规装载）
    const lAt = shared.indexOf('export async function loadSkillProjectDirs');
    const lBody = lAt >= 0 ? shared.slice(lAt, lAt + 900) : '';
    if (lAt < 0) sub.push('缺 loadSkillProjectDirs 定义');
    else if (!/userSkillDirNamesTimedOut:\s*payload\.userSkillDirNamesTimedOut === true/.test(lBody)) sub.push('装载机 resolve 分支未透传超时标记（缺省归一 false）');
    // ConfigPage：超时旗标 ref + ensureProjectDirs 超时分支语义（不覆盖槽/不置 ready/装载前复位）
    if (!/const userDirNamesTimedOut\s*=\s*ref\(false\)/.test(cfg)) sub.push('缺 userDirNamesTimedOut 旗标声明（超时轻提示数据源）');
    const eAt = cfg.indexOf('async function ensureProjectDirs');
    const eBody = eAt >= 0 ? cfg.slice(eAt, eAt + 1400) : '';
    if (eAt < 0) sub.push('缺 ensureProjectDirs 定义');
    else {
      if (!eBody.includes('userDirNamesTimedOut.value = false;')) sub.push('装载前未复位超时旗标（旧超时提示残留）');
      const bAt = eBody.indexOf('if (r.userSkillDirNamesTimedOut)');
      if (bAt < 0) sub.push('ok 分支缺超时判定（载荷 userSkillDirNamesTimedOut 未消费）');
      else {
        const elseAt = eBody.indexOf('} else {', bAt);
        const tBody = elseAt >= 0 ? eBody.slice(bAt, elseAt) : eBody.slice(bAt, bAt + 300);
        if (tBody.includes('commandStore.userSkillDirNames =') || tBody.includes('userSkillDirNamesReady.value = true')) {
          sub.push('超时分支不得覆盖映射槽/不得置 userSkillDirNamesReady=true（「ready+空映射」复活 X-1/X-2 口）');
        }
        if (!tBody.includes('userDirNamesTimedOut.value = true')) sub.push('超时分支未置超时提示旗标');
      }
      if (!eBody.includes('commandStore.userSkillDirNames =')) sub.push('非超时分支映射槽写入丢失（user-dirnames ④ 基线回归）');
      if (!/userSkillDirNamesReady\.value\s*=\s*true/.test(eBody)) sub.push('非超时分支就绪旗标写入丢失（X-1/X-2 基线回归）');
    }
    // rail 第三态：超时轻提示（不写 projectDirsError——项目目录与用户根两源独立；带重试入口）
    if (!/v-else-if="userDirNamesTimedOut"/.test(cfg)) sub.push('rail 缺超时第三态（v-else-if userDirNamesTimedOut）');
    if (!cfg.includes('用户级 Skill 键名映射读取超时')) sub.push('rail 缺超时提示文案');
    // Z-1（2026-09-19 Y-1 批独立评审 §2，P3）：超时文案按 userSkillDirNamesReady 三元分化——
    // 「曾装载成功后超时」（ready=true）态开关 :disabled 只看 !ready 实际可拨，文案不得宣称
    // 「暂不可用」（UI 语义矛盾）；首访（ready=false）开关真禁用（X-2 门控），维持「暂不可用」。
    // W-1（2026-09-19 Z-1 批独立评审 §2，OPT）：分化钉由三钉（两变体 includes + 门控存在）合一为
    // 单一方向绑定正则——文案变体与三元分支一一绑定，分支对调变异即 FAIL（旧三钉对对调变异体
    // 全绿，区分力经 fix-tmp/red-w/w1-mutation-probe.log 变异探针证明）。
    const railAt = cfg.indexOf('v-else-if="userDirNamesTimedOut"');
    if (railAt < 0) sub.push('rail 超时块定位失败（Z-1 分化钉锚点缺失）');
    else {
      const railBody = cfg.slice(railAt, railAt + 600);
      if (!/userSkillDirNamesReady\s*\?\s*'[^']*正在使用上次成功读取的映射'\s*:\s*'[^']*全局开关暂不可用'/.test(railBody)) {
        sub.push('rail 超时文案未按 userSkillDirNamesReady 方向绑定（W-1：ready=true 臂须为「正在使用上次成功读取的映射」、ready=false 臂须为「全局开关暂不可用」，缺失或分支对调即 FAIL）');
      }
    }
    // main 注释论断修正留痕（错误论断清除 + Y-1 修正标记在位）
    if (/X-1 门控下不产生[\s\S]{0,8}假失效/.test(mainSrc)) sub.push('main 注释错误论断未修正（超时经 null 哨兵区分，不再以空映射落地）');
    if (!/Y-1/.test(mainSrc)) sub.push('main 缺 Y-1 超时哨兵注释标记（论断修正留痕）');
    check('⑦', 'Y-1 形态：载荷超时标记 + 装载机透传 + ConfigPage 超时分支（不覆盖槽/不置 ready/复位 + rail 超时第三态）+ main 注释论断修正', sub.length === 0, sub.join('; '));
  }

  console.log('\n=== 组6 Y-3 禁用态开关样式（X-2 disabled 无视觉形态——看似可点实则不可点） ===');

  // ⑧ Y-3（2026-09-19 X-123 批评审 §2，OPT）形态钉：.switch:disabled 灰显（opacity）+
  //   not-allowed 光标——首访映射装载期间（X-2 禁用态）开关不再「看似可点实则不可点」。
  {
    const src = readRel('src/renderer/pages/ConfigPage.vue');
    const sub: string[] = [];
    const m = /\.switch:disabled\s*\{([^}]*)\}/.exec(src);
    if (!m) sub.push('缺 .switch:disabled 规则（X-2 禁用态无视觉样式）');
    else {
      // Z-3（2026-09-19 Y-1 批独立评审 §2，OPT）：钉具体值 0.55（Y-3 交付值）——旧钉 /opacity/
      // 对 opacity:1 / opacity:0 均假绿；对当前树即 GREEN（生产已 0.55），区分力经 fix-tmp
      // 变异探针独立证明（opacity:1 旧钉过、新钉拒）。
      if (!/opacity:\s*0\.55/.test(m[1])) sub.push('.switch:disabled opacity 灰显值须为 0.55（Z-3 值钉，防 opacity:1 假绿）');
      if (!/cursor:\s*not-allowed/.test(m[1])) sub.push('.switch:disabled 缺 cursor: not-allowed');
    }
    check('⑧', 'ConfigPage：.switch:disabled 灰显（opacity: 0.55 值钉）+ cursor: not-allowed（X-2 禁用态视觉形态；Z-3 钉具体值）', sub.length === 0, sub.join('; '));
  }

  console.log(`\n===== tdd-skill-x123-verify: ${pass} pass / ${fail} fail =====`);
  if (fail > 0) console.log('（RED 阶段：FAIL 项为尚未实施的生产改动，实施后应全 PASS）');
  process.exit(fail > 0 ? 1 : 0);
}

void main().catch((e: unknown) => {
  console.error('runner crash:', e);
  process.exit(1);
});
