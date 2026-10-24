// tdd-skill-refresh-verify.ts
// P6 Skill 刷新入口与状态呈现（方案 C：同步条，计划 2026-10-22 six-issues §7.1/§7.6 点 S5）
// 源码契约脚本。全部为纯 node 读文件 + 字面/正则断言，不 import Electron、不跑 DB。
//
// 覆盖：
//   ① config 新字段 skillAutoSync：AppConfig 形状（含「仅控 watcher 变更触发重探；启动初始探测不受影响」注释）+
//      config-manager defaults 与读路径 ?? true 归一化 + config-store 渲染层默认值 + ConfigPage PERSISTED_FIELDS；
//   ② index.ts triggerGlobalProbe 注入回调的 skillAutoSync 守卫（每次触发现读配置；关闭时 return true=
//      本次触发已处置、不触发 watcher 被吞 10s 重试（F2）；在跑被幂等锁吞仍 return false 走 10s 重试；
//      启动初始探测 runGlobalCommandProbe 不经该回调）；
//   ③ sdk-backend 导出 refreshGlobalCommands：绕过 60s 节流与「仅空时生效」条件的源码证据
//      （函数体不触 ensureGlobalCommandProbeFresh / lastGlobalProbeAttemptAt 节流读 / getGlobalFallback 早退，
//      复用 runGlobalCommandProbe 幂等锁等待同一 donePromise）；
//   ④ 新 IPC 通道 COMMANDS_REFRESH_GLOBAL 五处落点一致（ipc.ts 常量 / preload 接口签名 / preload 实现 /
//      ipc-handlers handler（转发 refreshGlobalCommands 返回快照）/ web-bridge 通道表）；
//   ⑤ command-store：globalRefreshing / globalSkillDelta / lastAddedSkillNames 三 state + diffUserSkills
//      纯函数（origin==='user-skill' 命名集合对比）+ refreshGlobal action（before 集记录 → 应用快照 → diff →
//      失败沿 status='error' 通道且 delta 不动）+ applyGlobalFallback 广播消费同样 diff + resetSkillFreshState；
//   ⑥ ConfigPage Skill 页同步条（data-testid="skill-sync-bar" 仅全局作用域）+ 开关绑定 store.config.skillAutoSync +
//      「立即刷新」按钮（data-testid="skill-refresh-button"，busy 旋转 + prefers-reduced-motion 停用）+
//      同步条/rail delta 徽标 + 卡片「新增」徽标（仅全局作用域消费）+ warn 系样式类。
//
// 运行：npx tsx scripts/tdd-skill-refresh-verify.ts（已登记 scripts/selftest-static-list.txt 尾部）

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i > -1) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

const configTypes = read('src/shared/types/config.ts');
const configManager = read('src/main/modules/config-manager.ts');
const configStore = read('src/renderer/stores/config-store.ts');
const mainIndex = read('src/main/index.ts');
const sdkBackend = read('src/main/modules/sdk-backend.ts');
const ipcTypes = read('src/shared/types/ipc.ts');
const preloadApi = read('src/preload/api.ts');
const ipcHandlers = read('src/main/ipc-handlers.ts');
const webBridge = read('src/renderer/web/web-bridge.ts');
const commandStore = read('src/renderer/stores/command-store.ts');
const configPage = read('src/renderer/pages/ConfigPage.vue');

// ── ① config 新字段 skillAutoSync（默认 true，四处落点） ──
console.log('=== 1) config 字段 skillAutoSync：形状 + defaults + 归一化 + 渲染层默认 ===');
check('AppConfig 含 skillAutoSync: boolean', /skillAutoSync: boolean;/.test(configTypes));
check('字段注释写明语义边界（仅控 watcher 变更触发重探 / 关闭后需手动刷新 / 启动初始探测不受影响）',
  /仅控制 skills 目录 watcher/.test(configTypes) && /启动时初始全局探测[\s\S]{0,80}不受此开关影响/.test(configTypes));
check('config-manager defaults 含 skillAutoSync: true', configManager.includes('skillAutoSync: true'));
check('config-manager 读路径归一化 skillAutoSync: config.skillAutoSync ?? true',
  /skillAutoSync:\s*config\.skillAutoSync\s*\?\?\s*true/.test(configManager));
check('config-store defaultConfig 含 skillAutoSync: true', configStore.includes('skillAutoSync: true'));
check('ConfigPage PERSISTED_FIELDS 含 skillAutoSync（走既有自动保存链）',
  /'skillOverrides',\s*'skillAutoSync',/.test(configPage));

// ── ② index.ts triggerGlobalProbe 注入回调 skillAutoSync 守卫 ──
console.log('=== 2) index.ts：watcher 自动同步门（watcher 本体零改动） ===');
check('triggerGlobalProbe 注入回调含 if (!getConfig().skillAutoSync) return true 守卫（F2：关闭=已处置不重试）',
  /if \(!getConfig\(\)\.skillAutoSync\) return true;/.test(mainIndex));
check('守卫位于回调内且在 runGlobalCommandProbe 调用之前（现读配置，拨动即刻生效）',
  mainIndex.indexOf('!getConfig().skillAutoSync') > -1 &&
  mainIndex.indexOf('!getConfig().skillAutoSync') < mainIndex.indexOf('triggerGlobalProbe: () => {') + 400);
check('守卫注释说明启动初始探测与 ensureGlobalCommandProbeFresh 兜底不受门控',
  /ensureGlobalCommandProbeFresh/.test(mainIndex) && /不受.{0,12}门/.test(mainIndex));
check('启动初始探测 runGlobalCommandProbe(mainWindow) 仍在守卫回调之外（startGlobalCommandPipeline 直调）',
  /runGlobalCommandProbe\(mainWindow\);/.test(mainIndex));

// ── ③ sdk-backend.ts 导出 refreshGlobalCommands（绕过节流证据） ──
console.log('=== 3) sdk-backend：refreshGlobalCommands 导出与绕过节流证据 ===');
check('导出 export async function refreshGlobalCommands(mainWindow: BrowserWindow): Promise<SessionCommandSnapshot>',
  /export async function refreshGlobalCommands\(mainWindow: BrowserWindow\): Promise<SessionCommandSnapshot> \{/.test(sdkBackend));
{
  const fnIdx = sdkBackend.indexOf('export async function refreshGlobalCommands');
  const docStart = sdkBackend.lastIndexOf('/**', fnIdx);
  const nextExport = sdkBackend.indexOf('\nexport ', fnIdx + 10);
  const end = nextExport > -1 ? nextExport : undefined;
  // 负向断言只看代码体（JSDoc 里的对比性提及不算调用/读取）。
  const codeBody = sdkBackend.slice(fnIdx, end);
  // 正向注释断言含紧邻 JSDoc。
  const docAndBody = sdkBackend.slice(docStart > -1 ? docStart : fnIdx, end);
  check('函数体不调 ensureGlobalCommandProbeFresh（绕过「仅空时生效」+ 60s 节流条件）',
    !codeBody.includes('ensureGlobalCommandProbeFresh'));
  check('函数体不读 lastGlobalProbeAttemptAt（不因节流窗口早退）',
    !codeBody.includes('lastGlobalProbeAttemptAt'));
  check('函数体复用 runGlobalCommandProbe 幂等锁（无在飞则启动探测）',
    codeBody.includes('runGlobalCommandProbe(mainWindow)'));
  check('在飞去重：等待同一 donePromise（探测中不并发 spawn、不打断）',
    /entry\.donePromise/.test(codeBody));
  check('完成后走既有广播链：注释声明 emitGlobalCommandsChanged 自动广播（applyGlobalProbeCommands 既有出口）',
    docAndBody.includes('emitGlobalCommandsChanged'));
  check('失败终态：CLI 缺失返回 degraded 快照（文案对齐 commands-get 只读分流）',
    codeBody.includes("status: 'degraded'") && codeBody.includes('globalCliMissing'));
  check('失败终态：探测失败返回 error 快照（渲染层 snap-status 既有通道呈现）',
    codeBody.includes("status: 'error'"));
  check('F1 修复：失败旗标判定（globalCliMissing || isGlobalProbeFailed()）先于 if (fallback) return fallback; 返回（失败不静默返回旧 ready 快照）',
    codeBody.indexOf('if (globalCliMissing || isGlobalProbeFailed())') > -1 &&
    codeBody.indexOf('if (globalCliMissing || isGlobalProbeFailed())') < codeBody.indexOf('if (fallback) return fallback;'));
  check('F1 修复：失败终态快照 status/error 文案对齐既有两分支（三元对齐 degraded/error）',
    /status:\s*globalCliMissing\s*\?\s*'degraded'\s*:\s*'error'/.test(codeBody) &&
    codeBody.includes('命令探测失败，可重试（点「立即刷新」重试）'));
}

// ── ④ COMMANDS_REFRESH_GLOBAL 五处落点一致 ──
console.log('=== 4) COMMANDS_REFRESH_GLOBAL 通道五处落点 ===');
check("IPC_CHANNELS 含 COMMANDS_REFRESH_GLOBAL: 'commands:refreshGlobal'",
  ipcTypes.includes("COMMANDS_REFRESH_GLOBAL: 'commands:refreshGlobal'"));
check('ClaudeLinkAPI 接口含 refreshGlobalCommands: () => Promise<SessionCommandSnapshot> 签名',
  /refreshGlobalCommands:\s*\(\)\s*=>\s*Promise<SessionCommandSnapshot>;/.test(preloadApi));
check('preload createApi 实现 refreshGlobalCommands（invoke COMMANDS_REFRESH_GLOBAL 零参透传）',
  /refreshGlobalCommands:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IPC_CHANNELS\.COMMANDS_REFRESH_GLOBAL\)/.test(preloadApi));
check('ipc-handlers 注册 COMMANDS_REFRESH_GLOBAL handler（regInvokeHandler 形态）',
  ipcHandlers.includes('regInvokeHandler(IPC_CHANNELS.COMMANDS_REFRESH_GLOBAL'));
{
  const hIdx = ipcHandlers.indexOf('regInvokeHandler(IPC_CHANNELS.COMMANDS_REFRESH_GLOBAL');
  const nextH = ipcHandlers.indexOf('regInvokeHandler(', hIdx + 10);
  const seg = ipcHandlers.slice(hIdx, nextH > -1 ? nextH : undefined);
  check('handler 转发 refreshGlobalCommands(mainWindow) 并返回快照',
    seg.includes('return refreshGlobalCommands(mainWindow)'));
  check('ipc-handlers 已从 chat-backend 导入 refreshGlobalCommands',
    /refreshGlobalCommands\s*[,}]/.test(ipcHandlers.match(/import \{[^}]*\} from '\.\/modules\/chat-backend';/)?.[0] ?? ''));
}
check('web-bridge WEB_CHANNEL_TABLE 含 refreshGlobalCommands: IPC_CHANNELS.COMMANDS_REFRESH_GLOBAL（键集契约由 tdd-web-access-wiring-verify §11.2 双向对等钉死）',
  webBridge.includes('refreshGlobalCommands: IPC_CHANNELS.COMMANDS_REFRESH_GLOBAL'));

// ── ⑤ command-store：state + diffUserSkills + refreshGlobal + applyGlobalFallback diff + reset ──
console.log('=== 5) command-store：刷新状态与 diff ===');
check('state 含 globalRefreshing: false', /globalRefreshing:\s*false/.test(commandStore));
check('state 含 globalSkillDelta: 0', /globalSkillDelta:\s*0/.test(commandStore));
check('state 含 lastAddedSkillNames: [] as string[]', /lastAddedSkillNames:\s*\[\]\s*as string\[\]/.test(commandStore));
check('内部纯函数 diffUserSkills(before, after)：对比 origin===\'user-skill\' 命名集合返回新增名列表',
  /function diffUserSkills\(before: SessionCommandSnapshot \| null, after: SessionCommandSnapshot \| null\): string\[\]/.test(commandStore) &&
  /origin === 'user-skill'/.test(commandStore));
check('refreshGlobal action 存在（async refreshGlobal(): Promise<void>）',
  /async refreshGlobal\(\): Promise<void> \{/.test(commandStore));
{
  const fnIdx = commandStore.indexOf('async refreshGlobal(): Promise<void>');
  const nextFn = commandStore.indexOf('\n    async ', fnIdx + 10);
  const body = commandStore.slice(fnIdx, nextFn > -1 ? nextFn : undefined);
  check('refreshGlobal 在飞守卫（UI disabled + 二次进入直接返回双保险）',
    body.includes('if (this.globalRefreshing) return'));
  check('refreshGlobal 记录刷新前快照作 before 集', body.includes('const before = this.globalSnapshot'));
  check('refreshGlobal 调 window.claudeLink.refreshGlobalCommands()',
    body.includes('window.claudeLink.refreshGlobalCommands()'));
  check('refreshGlobal 应用快照后 diff：lastAddedSkillNames = diffUserSkills(before, …) 且 globalSkillDelta = …length',
    /lastAddedSkillNames\s*=\s*diffUserSkills\(before/.test(body) && /globalSkillDelta\s*=\s*[\w.]+\.length/.test(body));
  check('refreshGlobal 失败沿 status=\'error\' 既有通道呈现（globalSnapshot 写失败终态）',
    body.includes("status: 'error'"));
  check('refreshGlobal 失败时 delta/lastAdded 不更新（不误报 +0）',
    body.indexOf("status: 'error'") > -1 && /不更新|不动/.test(commandStore.slice(fnIdx - 800, fnIdx)));
  {
    // F7（round-002 review）行为级加固：失败分支（else 体）内不得含 delta/lastAdded 赋值字面——
    // 旧断言仅匹配注释佐证（删行为留注释仍过），此断言钉源码结构。
    const elseIdx = body.indexOf('} else {');
    const catchIdx = elseIdx > -1 ? body.indexOf('} catch', elseIdx) : -1;
    const elseBody = body.slice(elseIdx, catchIdx > -1 ? catchIdx : undefined);
    check('refreshGlobal 失败分支（else 体）不含 lastAddedSkillNames/globalSkillDelta 赋值字面（F7 行为级）',
      elseIdx > -1 && catchIdx > -1 &&
      !/lastAddedSkillNames\s*=/.test(elseBody) && !/globalSkillDelta\s*=/.test(elseBody));
  }
  {
    // F3（round-002 review）首拍/空基线不标新增：无基线（null/loading/degraded/error 占位）只建基线
    // 不计 delta；有基线才 diff。两处写入点均须有 hasUsableBaseline 守卫。
    check('F3 模块级 hasUsableBaseline 帮助函数（null/loading/degraded/error 均非可用基线）',
      /function hasUsableBaseline\(snapshot: SessionCommandSnapshot \| null\): boolean \{/.test(commandStore) &&
      /snapshot\.status !== 'loading'/.test(commandStore) &&
      /snapshot\.status !== 'degraded'/.test(commandStore) &&
      /snapshot\.status !== 'error'/.test(commandStore));
    const afIdx = commandStore.indexOf('applyGlobalFallback(snapshot: SessionCommandSnapshot');
    const afSeg = commandStore.slice(afIdx, commandStore.indexOf('if (!snapshot) return;', afIdx));
    check('F3 applyGlobalFallback 首拍/无基线跳过 delta/lastAdded 写入（firstShot 守卫在早退分支前）',
      /const firstShot = !hasUsableBaseline\(prevGlobalUserSkillSnapshot\);/.test(afSeg) &&
      /if \(!firstShot\) \{\s*this\.lastAddedSkillNames = added;\s*this\.globalSkillDelta = added\.length;\s*\}/.test(afSeg));
    check('F3 refreshGlobal 成功路径 delta/lastAdded 写入有 hasBaseline 守卫（无基线保持默认 0/[]）',
      /if \(hasUsableBaseline\(before\)\) \{\s*this\.lastAddedSkillNames = diffUserSkills\(before, snapshot\);/.test(commandStore));
  }
  check('refreshGlobal finally 复位 globalRefreshing', body.includes('this.globalRefreshing = false'));
}
check('applyGlobalFallback 广播消费同样 diff（自动同步的发现计入「本次刷新 +N」）',
  /applyGlobalFallback\(snapshot: SessionCommandSnapshot[\s\S]{0,600}diffUserSkills\(prevGlobalUserSkillSnapshot, snapshot\)/.test(commandStore));
check('applyGlobalFallback 的 diff 在既有早退分支之前执行（无活跃会话的广播同样推进基线）',
  (() => {
    const fnIdx = commandStore.indexOf('applyGlobalFallback(snapshot: SessionCommandSnapshot');
    const earlyReturn = commandStore.indexOf('if (!snapshot) return;', fnIdx);
    const diff = commandStore.indexOf('diffUserSkills(prevGlobalUserSkillSnapshot, snapshot)', fnIdx);
    return earlyReturn > -1 && diff > -1 && diff < earlyReturn;
  })());
check('模块级非响应式 before 基线 prevGlobalUserSkillSnapshot（与 globalEnsureInFlight 同款并发先例）',
  /let prevGlobalUserSkillSnapshot: SessionCommandSnapshot \| null = null;/.test(commandStore));
check('load() 哨兵回填后同步基线（广播 before 集不因菜单拉取路径失真）',
  /GLOBAL_FALLBACK_SESSION_ID \};[\s\S]{0,600}prevGlobalUserSkillSnapshot = this\.globalSnapshot;/.test(commandStore));
check('resetSkillFreshState action 存在（重进 Skill tab 清零防陈旧徽标常驻）',
  /resetSkillFreshState\(\): void \{[\s\S]{0,200}globalSkillDelta = 0;/.test(commandStore));

// ── ⑥ ConfigPage Skill 页：同步条 + 徽标 + 样式 ──
console.log('=== 6) ConfigPage：同步条与状态徽标 ===');
check('同步条仅全局作用域渲染（v-if skillScope.kind === \'global\'）',
  /v-if="skillScope\.kind === 'global'" class="skill-sync-bar" data-testid="skill-sync-bar"/.test(configPage));
check('同步条开关绑定 store.config.skillAutoSync（复用既有自动保存链）',
  configPage.includes('v-model="store.config.skillAutoSync"'));
check('开关 aria-label「自动同步 Skill 变更」', configPage.includes('aria-label="自动同步 Skill 变更"'));
check('hint 文案随开关分化（监听目录 / 已暂停自动同步需手动刷新）',
  configPage.includes('监听 ~/.claude/skills 与全局工作目录 .claude/skills') &&
  configPage.includes('已暂停自动同步'));
check('「立即刷新」按钮 data-testid="skill-refresh-button"（busy 禁用 + 调 commandStore.refreshGlobal()）',
  /data-testid="skill-refresh-button"/.test(configPage) &&
  /:disabled="commandStore\.globalRefreshing \|\| skillProbePending"\s*@click="commandStore\.refreshGlobal\(\)"/.test(configPage));
check('按钮文案随态切换（刷新中… / 立即刷新）',
  /commandStore\.globalRefreshing \? '刷新中…' : '立即刷新'/.test(configPage));
check('自动同步关闭时按钮仍可用（手动通道独立，disabled 不含 skillAutoSync 条件）',
  !/disabled="[^"]*skillAutoSync[^"]*"/.test(configPage));
check('同步条 delta 徽标（v-if globalSkillDelta > 0 → 本次刷新 +N）',
  /class="skill-sync-bar__delta" v-if="commandStore\.globalSkillDelta > 0"[\s\S]{0,80}本次刷新 \+\{\{ commandStore\.globalSkillDelta \}\}/.test(configPage));
check('rail「全局 Skill」条目 delta 徽标（skill-md-item__delta）',
  /v-if="commandStore\.globalSkillDelta > 0" class="skill-md-item__delta">\+\{\{ commandStore\.globalSkillDelta \}\}/.test(configPage));
check('卡片「新增」徽标仅全局作用域消费（项目作用域卡片不受影响）',
  /v-if="skillScope\.kind === 'global' && commandStore\.lastAddedSkillNames\.includes\(skill\.name\)"\s*class="skill-card__fresh-badge"/.test(configPage));
check('新增卡片附 warn 描边 fresh class（skill-card--fresh）',
  /'skill-card--fresh': skillScope\.kind === 'global' && commandStore\.lastAddedSkillNames\.includes\(skill\.name\)/.test(configPage));
check('同步条/hint/delta/按钮样式类齐备（.skill-sync-bar{,__label,__hint,__delta,__now}）',
  ['.skill-sync-bar {', '.skill-sync-bar__label', '.skill-sync-bar__hint', '.skill-sync-bar__delta', '.skill-sync-bar__now']
    .every((cls) => configPage.includes(cls)));
check('rail delta 徽标与卡片新增徽标样式（.skill-md-item__delta / .skill-card__fresh-badge / .skill-card--fresh）',
  configPage.includes('.skill-md-item__delta') && configPage.includes('.skill-card__fresh-badge') && configPage.includes('.skill-card--fresh'));
check('样式走 warn 系 token（--color-warn / --color-warn-strong，对齐效果图 plan-c-timeline-sync）',
  /skill-(sync-bar|md-item__delta|card__fresh)[\s\S]{0,400}var\(--color-warn/.test(configPage));
check('busy 态 svg 旋转（skill-sync-spin 动画）',
  /skill-sync-bar__now--busy[\s\S]{0,200}animation:\s*skill-sync-spin/.test(configPage));
check('prefers-reduced-motion 停用旋转（对齐 variables.css :68-75 约定）',
  /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,200}\.skill-sync-bar__now--busy svg \{[\s\S]{0,80}animation:\s*none/.test(configPage));
check('重进 Skill tab 清零徽标（watch activeTab skill 分支调 resetSkillFreshState）',
  /if \(tab === 'skill'\) \{ commandStore\.resetSkillFreshState\(\);/.test(configPage));

console.log(`\n[S5 Skill 刷新入口契约] 通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
