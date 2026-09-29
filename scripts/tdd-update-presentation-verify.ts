// tdd-update-presentation-verify.ts
// 更新 UX 增强（2026-09-28 计划 §Task11）TDD 验证脚本：
//   P1-P4  update-presentation 纯函数行为断言（直接 import 真跑）：
//          updateBadgeVisible 九态 / latestVersionText / aboutCheckButtonLabel /
//          shouldAutoOpenUpdateDialog 弹窗自动弹出用例矩阵；
//   W1-W6  接线字面钉：App.vue 挂载与 init / AppSidebar 徽标与直达路由 /
//          ConfigPage 最新版本行与 route.query.tab（负向：cursor: wait 根因清除）/
//          update-store 消费纯函数 / selftest 清单登记。
// 运行：npx tsx scripts/tdd-update-presentation-verify.ts（已登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  UPDATE_DIALOG_STATUSES,
  updateBadgeVisible,
  latestVersionText,
  aboutCheckButtonLabel,
  shouldAutoOpenUpdateDialog,
} from '../src/shared/update-presentation';
import type { AppUpdateState } from '../src/shared/types/update';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
function readRel(p: string): string {
  return readFileSync(resolve(__dirname, '..', p), 'utf8');
}

function state(status: AppUpdateState['status'], newVersion: string | null = null): AppUpdateState {
  return { status, newVersion, latestVersion: null, releaseNotes: null, progress: null, error: null };
}

console.log('\n=== P1) updateBadgeVisible：徽标三态白名单 ===');
check('P1 available/downloading/downloaded → true', () => {
  for (const s of ['available', 'downloading', 'downloaded'] as const) {
    assert.equal(updateBadgeVisible(s), true, s);
  }
});
check('P1 unavailable/idle/checking/installing/error/latest → false', () => {
  for (const s of ['unavailable', 'idle', 'checking', 'installing', 'error', 'latest'] as const) {
    assert.equal(updateBadgeVisible(s), false, s);
  }
});
check('P1 UPDATE_DIALOG_STATUSES 常量 = [available, downloading, downloaded]', () => {
  assert.deepEqual([...UPDATE_DIALOG_STATUSES], ['available', 'downloading', 'downloaded']);
});

console.log('\n=== P2) latestVersionText：最新版本文案 ===');
check('P2 null → 未查询', () => assert.equal(latestVersionText(null), '未查询'));
check('P2 undefined → 未查询（旧广播向后兼容）', () => assert.equal(latestVersionText(undefined), '未查询'));
check("P2 '0.5.0' → v0.5.0", () => assert.equal(latestVersionText('0.5.0'), 'v0.5.0'));

console.log('\n=== P3) aboutCheckButtonLabel：检查按钮文案 ===');
check("P3 true → 检查中…", () => assert.equal(aboutCheckButtonLabel(true), '检查中…'));
check("P3 false → 检查更新", () => assert.equal(aboutCheckButtonLabel(false), '检查更新'));

console.log('\n=== P4) shouldAutoOpenUpdateDialog：弹窗自动弹出用例矩阵 ===');
check('P4 null → available(v1) 弹', () => {
  assert.equal(shouldAutoOpenUpdateDialog(null, state('available', '1.0.0'), []), true);
});
check('P4 null → downloaded(v1) 弹', () => {
  assert.equal(shouldAutoOpenUpdateDialog(null, state('downloaded', '1.0.0'), []), true);
});
check('P4 available(v1) → downloading(v1) 不弹（downloading 不自动开弹）', () => {
  assert.equal(shouldAutoOpenUpdateDialog(state('available', '1.0.0'), state('downloading', '1.0.0'), []), false);
});
check('P4 downloading(v1) → downloaded(v1) 弹（就绪再提示安装）', () => {
  assert.equal(shouldAutoOpenUpdateDialog(state('downloading', '1.0.0'), state('downloaded', '1.0.0'), []), true);
});
check('P4 downloaded(v1) → downloaded(v1) 不弹（重复广播不重弹）', () => {
  assert.equal(shouldAutoOpenUpdateDialog(state('downloaded', '1.0.0'), state('downloaded', '1.0.0'), []), false);
});
check('P4 dismissed 含 v1 时 null → available(v1) 不弹', () => {
  assert.equal(shouldAutoOpenUpdateDialog(null, state('available', '1.0.0'), ['1.0.0']), false);
});
check('P4 available(v1) → available(v2) 版本变化弹（dismissed 只挡旧版本）', () => {
  assert.equal(shouldAutoOpenUpdateDialog(state('available', '1.0.0'), state('available', '2.0.0'), ['1.0.0']), true);
});
check('P4 checking(v1) → available(v1) 且 dismissed=[v1] 不弹（稍后 + 启动自动检查不重弹）', () => {
  assert.equal(shouldAutoOpenUpdateDialog(state('checking', '1.0.0'), state('available', '1.0.0'), ['1.0.0']), false);
});
check('P4 next 为 downloading/idle/error/latest/installing/checking/unavailable 一律不弹', () => {
  for (const s of ['downloading', 'idle', 'error', 'latest', 'installing', 'checking', 'unavailable'] as const) {
    assert.equal(shouldAutoOpenUpdateDialog(null, state(s, '1.0.0'), []), false, s);
  }
});

console.log('\n=== W) 接线字面钉 ===');
const appVue = readRel('src/renderer/App.vue');
const appSidebar = readRel('src/renderer/components/layout/AppSidebar.vue');
const configPage = readRel('src/renderer/pages/ConfigPage.vue');
const updateStore = readRel('src/renderer/stores/update-store.ts');
const selftestList = readRel('scripts/selftest-static-list.txt');
const variablesCss = readRel('src/renderer/assets/styles/variables.css');

check('W1 App.vue 含 <UpdateDialog /> 与 updateStore.init()', () => {
  assert.ok(appVue.includes('<UpdateDialog />'), 'UpdateDialog 未挂载');
  assert.ok(appVue.includes('updateStore.init()'), 'updateStore.init() 缺失');
});
check('W2 AppSidebar 含 update-badge testid 与对象式直达路由（tab=about + v 参数防同 query 死导航，P3-2）', () => {
  assert.ok(appSidebar.includes('data-testid="update-badge"'), '徽标 testid 缺失');
  assert.ok(appSidebar.includes("path: '/config'"), '直达 path 缺失');
  assert.ok(appSidebar.includes("tab: 'about'"), '直达 tab query 缺失');
});
check('W2b 徽标白字走 --color-on-success token（P3-1，负向：徽标块内不得回退 on-accent 误用）', () => {
  assert.ok(appSidebar.includes('--color-on-success'), '徽标白字未引用 on-success token');
  // 负向限定在 .update-badge 样式块内：文件级字面会误伤 brand-mark 对 on-accent 的合法使用（accent 底白字，语义正确）。
  const badgeStart = appSidebar.indexOf('.update-badge {');
  const badgeEnd = appSidebar.indexOf('.update-badge:hover');
  assert.ok(badgeStart !== -1 && badgeEnd > badgeStart, '未找到 .update-badge 样式块');
  const badgeCss = appSidebar.slice(badgeStart, badgeEnd);
  assert.ok(!badgeCss.includes('var(--color-on-accent)'), '徽标块仍引用 on-accent（色板依赖的近黑字，对比度不达 AA）');
});
check('W2c variables.css 定义 --color-on-success 白字 token（P3-1）', () => {
  assert.ok(variablesCss.includes('--color-on-success: #FFFFFF'), 'token 缺失');
});
check('W3 ConfigPage 含 about-latest-version testid 与 route.query.tab，且 cursor: wait 根因清除（负向）', () => {
  assert.ok(configPage.includes('data-testid="about-latest-version"'), '最新版本行缺失');
  assert.ok(configPage.includes('route.query.tab'), '路由直达缺失');
  assert.ok(!configPage.includes('cursor: wait'), 'ConfigPage 仍存在 cursor: wait（R1 根因未清）');
});
check('W4 update-store 消费纯函数 + dismissedVersions 记忆', () => {
  assert.ok(updateStore.includes('shouldAutoOpenUpdateDialog'), 'shouldAutoOpenUpdateDialog 缺失');
  assert.ok(updateStore.includes('dismissedVersions'), 'dismissedVersions 缺失');
});
check('W5 selftest-static-list.txt 已登记本脚本', () => {
  assert.ok(selftestList.includes('scripts/tdd-update-presentation-verify.ts'), '清单未登记');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
