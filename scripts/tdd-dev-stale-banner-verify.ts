// tdd-dev-stale-banner-verify.ts
// 八问题批次 D2 网页产物新鲜度治理（dev 横幅 + README 纪律）契约脚本
// （docs/plans/2026-11-15-eight-issues-batch/03b-test-cases-renderer.md §8 D2-1/D2-2/D2-4；
//   行为契约唯一事实源 = 00-behavior-specs.md 域 D D2 节；实现细节 = 02-impl-details-renderer.md §7。
//   CDP 行为场景 D2-3（W-dev-stale-banner）归 B 链 T1，不在本脚本。）
//   D2-1 dev 横幅结构与关闭记忆（钉）：
//     判据链钉——主进程 web-access-server welcome 帧 devMode: !app.isPackaged（渲染层无既有通道可读
//       isPackaged，welcome 帧是唯一零新通道搭载面）→ web-bridge WireServerFrame welcome 类型
//       devMode?: boolean（可选字段；旧主进程无该字段缺省 false 不误报）+ welcomedDevModeRef 模块级
//       捕获导出（对齐 welcomedBuildRevRef 形态；捕获严格 === true 门）→ App.vue 动态 import 消费；
//     生产模式不渲染钉——App.vue showDevModeWarn 判据含 isWebRuntime && devModeActive（devMode
//       !== true 恒不渲染；桌面端 isWebRuntime 恒 false 同样不渲染）；
//     文案意图钉——「开发模式：网页产物可能落后于桌面热更新代码」「重启 npm run dev」「后再验证网页端」
//       （规范 D2.1 原文语）；常驻=模板 v-if 渲染分支（默认渲染，非按需拉取）；
//     可关闭钮钉——✕ @click dismissDevModeWarn；
//     关闭记忆会话级钉——sessionStorage 键 clWebDevModeWarnDismissed（DEV_WARN_KEY），getItem/setItem
//       双字面 + dev 区块无 localStorage 负向钉（跨会话不弹=违反「按会话记忆」；与 rev warn 的
//       localStorage rev 对记忆刻意区分）；
//     rev warn 存量面零触碰对照钉——clWebRevWarnDismissed / dismissRevWarn / web-rev-warn 既有字面
//       仍在（详钉在 tdd-web-access-wiring-verify §16 W2，由 D2-2 spawn 门覆盖）；
//     --dev 变体中性描边钉——.web-rev-warn--dev 用 var(--color-border-strong)/panel 底，不抢 rev warn
//       warn 色（var(--color-warn-strong) 不出现在 --dev 变体块）。
//   D2-2 生产 buildRev 横幅语义不变（回归门）：spawn tdd-web-access-wiring-verify.ts（§16 W1-W3）+
//     spawn selftest-build-freshness.ts（C1-C5 生产指纹链）——两脚本退出码 0。
//   D2-4 README 纪律行（文档钉）：「### 安装与运行」节内（常用命令节前）含「改动渲染层后如需网页端验证
//     → 重启 npm run dev 刷新 out/renderer 产物…禁止拿旧产物断言双端差异」纪律行。
// 运行：npx tsx scripts/tdd-dev-stale-banner-verify.ts（登记 scripts/selftest-static-list.txt）
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');

const serverSrc = readFileSync(join(repoRoot, 'src/main/modules/web-access/web-access-server.ts'), 'utf8');
const bridgeSrc = readFileSync(join(repoRoot, 'src/renderer/web/web-bridge.ts'), 'utf8');
const appVue = readFileSync(join(repoRoot, 'src/renderer/App.vue'), 'utf8');
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 截取 App.vue 中 dev 横幅脚本区块（DEV_WARN_KEY 声明起 → dismissDevModeWarn 函数体止，
 *  函数尾以首个行首 `}` 定界）。 */
function devBlock(): string {
  const start = appVue.indexOf("const DEV_WARN_KEY = 'clWebDevModeWarnDismissed'");
  if (start < 0) return '';
  const fnStart = appVue.indexOf('function dismissDevModeWarn(): void {', start);
  if (fnStart < 0) return appVue.slice(start, start + 800);
  const closeIdx = appVue.indexOf('\n}', fnStart);
  return appVue.slice(start, closeIdx < 0 ? fnStart + 400 : closeIdx + 2);
}

console.log('\n=== D2-1a) 判据链：主进程 welcome 帧 devMode（!app.isPackaged） ===');
check('server welcome 帧 devMode: !app.isPackaged（safeSend welcome 字面内）',
  /safeSend\(ws, \{ v: 1, kind: 'welcome', appVersion: app\.getVersion\(\), buildRev: BUILD_REV, devMode: !app\.isPackaged \}\)/.test(serverSrc),
  'web-access-server.ts welcome 帧需补 devMode: !app.isPackaged');
check('server 经 electron app 包取 isPackaged（import { app } from electron）',
  serverSrc.includes("import { app } from 'electron'") && serverSrc.includes('app.isPackaged'));

console.log('\n=== D2-1b) 判据链：web-bridge devMode 可选字段 + welcomedDevModeRef 捕获导出 ===');
check('WireServerFrame welcome 类型补 devMode?: boolean（可选字段，旧主进程缺省不炸）',
  bridgeSrc.includes("kind: 'welcome'; appVersion: string; buildRev: string; devMode?: boolean }"));
check('welcomedDevMode 捕获严格 === true 门（frame.devMode === true；缺省 false 不误报）',
  bridgeSrc.includes('welcomedDevMode.value = frame.devMode === true'));
check('welcomedDevModeRef 模块级导出（对齐 welcomedBuildRevRef 形态）',
  bridgeSrc.includes('export const welcomedDevModeRef: Ref<boolean> = welcomedDevMode'));

console.log('\n=== D2-1c) App.vue dev 横幅：判据/文案/关闭/会话记忆 ===');
check('DEV_WARN_KEY 会话级键名钉（clWebDevModeWarnDismissed）',
  appVue.includes("const DEV_WARN_KEY = 'clWebDevModeWarnDismissed'"));
check('showDevModeWarn 判据含 isWebRuntime && devModeActive（生产/桌面恒不渲染链）',
  /showDevModeWarn = computed\(\(\) => isWebRuntime && devModeActive\.value && !devWarnDismissed\.value && !readDevDismissed\(\)\)/.test(appVue));
check('devModeActive 来源 welcomedDevModeRef（严格 === true；动态 import 消费）',
  appVue.includes('mod.welcomedDevModeRef') && /devModeHolder\.value\?\.dev\.value === true/.test(appVue));
check('横幅渲染分支常驻（模板 v-if="showDevModeWarn"，默认渲染非按需拉取）',
  appVue.includes('v-if="showDevModeWarn"'));
check('--dev 变体类挂载 + role="status"',
  appVue.includes('class="web-rev-warn web-rev-warn--dev"') && /web-rev-warn web-rev-warn--dev" role="status"/.test(appVue));
check('文案原文关键语（开发模式：网页产物可能落后于桌面热更新代码 / 重启 npm run dev / 后再验证网页端）',
  appVue.includes('开发模式：网页产物可能落后于桌面热更新代码') &&
  /重启 <code>npm run dev<\/code> 后再验证网页端/.test(appVue));
check('✕ 关闭钮 @click="dismissDevModeWarn"',
  appVue.includes('@click="dismissDevModeWarn"'));
check('关闭记忆 getItem/setItem 均走 sessionStorage（会话级）',
  appVue.includes('sessionStorage.getItem(DEV_WARN_KEY)') &&
  appVue.includes("sessionStorage.setItem(DEV_WARN_KEY, '1')"));
{
  const blk = devBlock();
  check('dev 区块无 localStorage（负向钉：跨会话记忆=违反「按会话记忆」）',
    blk.length > 0 && !blk.includes('localStorage'),
    blk.length === 0 ? 'DEV_WARN_KEY 区块未找到' : 'dev 区块出现 localStorage');
}

console.log('\n=== D2-1d) rev warn 存量面对照 + --dev 中性描边变体 ===');
check('rev warn 既有字面仍在（键/关闭函数/样式类零触碰；详钉由 D2-2 spawn 门覆盖）',
  appVue.includes('clWebRevWarnDismissed') &&
  appVue.includes('@click="dismissRevWarn"') &&
  appVue.includes('v-if="showRevWarn"'));
check('--dev 变体中性描边（var(--color-border-strong) + panel 底；不引 warn 色）',
  /\.web-rev-warn--dev \{[^}]*var\(--color-border-strong\)[^}]*\}/.test(appVue) &&
  /\.web-rev-warn--dev \{[^}]*var\(--color-panel\)[^}]*\}/.test(appVue));
{
  const m = appVue.match(/\.web-rev-warn--dev \{([^}]*)\}/);
  check('--dev 变体块不含 warn 色（不抢 rev warn 警示语义）',
    m !== null && !m[1].includes('warn'),
    m === null ? '.web-rev-warn--dev 样式块未找到' : '--dev 变体出现 warn 色');
}

console.log('\n=== D2-2) 生产 buildRev 横幅语义不变（spawn 回归门） ===');
function spawnGate(rel: string): boolean {
  // 与 run-selftest-static.ts 同 spawn 形态（npx tsx + win32 shell），退出码即判定。
  const r = spawnSync('npx', ['tsx', rel], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.log(`  ---- ${rel} 输出（尾部） ----`);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.split(/\r?\n/).slice(-12).join('\n');
    console.log(out);
  }
  return r.status === 0;
}
check('spawn tdd-web-access-wiring-verify.ts（§16 W1-W3 rev warn 横条接线 + 不新增 IPC 通道口径）',
  spawnGate('scripts/tdd-web-access-wiring-verify.ts'));
check('spawn selftest-build-freshness.ts（C1-C5 生产指纹链）',
  spawnGate('scripts/selftest-build-freshness.ts'));

console.log('\n=== D2-4) README 纪律行（文档钉） ===');
const disciplineIdx = readme.indexOf('改动渲染层后如需网页端验证');
check('README 含纪律行关键语（改动渲染层后如需网页端验证 → 重启 npm run dev 刷新 out/renderer 产物）',
  disciplineIdx >= 0 &&
  /改动渲染层后如需网页端验证 → 重启 `npm run dev` 刷新 `out\/renderer` 产物/.test(readme));
check('纪律行落在「### 安装与运行」节内（常用命令节前）',
  disciplineIdx > readme.indexOf('### 安装与运行') && disciplineIdx < readme.indexOf('### 常用命令'));
check('纪律行含禁止语（禁止拿旧产物断言双端差异）',
  readme.includes('禁止拿旧产物断言双端差异'));

console.log('\n=== 登记）selftest-static-list 含本脚本 ===');
check('scripts/selftest-static-list.txt 尾部登记 tdd-dev-stale-banner-verify',
  readFileSync(join(repoRoot, 'scripts/selftest-static-list.txt'), 'utf8')
    .split(/\r?\n/).map((l) => l.trim()).includes('scripts/tdd-dev-stale-banner-verify.ts'));

console.log(`\n[D2 dev 产物新鲜度横幅契约] 通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
