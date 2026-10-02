// tdd-reasoning-replay-autoretry-toggle-verify.ts
// B10（D11-F1，P3）契约钉：设置页「上游错误自动重试」开关（autoRetryReasoningReplay 的 UI 入口）。
//
// 根因（D11-F1）：README「错误韧性」承诺 reasoning_replay 等上游错误自动重试一次（可关闭），
// 配置项 autoRetryReasoningReplay 在主进程完整生效（默认开 + 读路径 ?? true 归一化 + 韧性层
// 消费），但渲染层零 UI 入口——PERSISTED_FIELDS 不含该字段、全仓无 checkbox 绑定，
// 「可关闭」只能手改配置文件/DB。
//
// 修复语义（纯 UI 接线，主进程消费链既有不动）：ConfigPage「行为」tab 新增
// 「上游错误自动重试」toggle（对齐 notifyOnLeave 的 field--toggle 形态），v-model 直写
// config.autoRetryReasoningReplay 并经 PERSISTED_FIELDS 自动保存链落盘；主进程
// maybeScheduleReasoningReplayRetry 每次回合终态点读 getConfig()（保存后对后续错误
// 即时生效）；默认开不变（config-manager/config-store 默认 true + 读路径 ?? true 兜底）。
//
// 运行：npx tsx scripts/tdd-reasoning-replay-autoretry-toggle-verify.ts
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function readRel(p: string): string {
  const fs = require('node:fs');
  const nodePath = require('node:path');
  const abs = nodePath.resolve(__dirname, '..', p);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8');
}

const readme = readRel('README.md');
const configTypes = readRel('src/shared/types/config.ts');
const configManager = readRel('src/main/modules/config-manager.ts');
const configStore = readRel('src/renderer/stores/config-store.ts');
const configPage = readRel('src/renderer/pages/ConfigPage.vue');
const resilience = readRel('src/main/modules/reasoning-replay-auto-retry.ts');

console.log('\n=== 1) README 承诺与配置形状（默认开不回退） ===');
check('README 承诺 reasoning_replay 自动重试一次并给出行动建议（可关闭）', readme.includes('自动重试一次并给出行动建议（可关闭）'));
check('AppConfig 声明 autoRetryReasoningReplay: boolean', configTypes.includes('autoRetryReasoningReplay: boolean'));
check('config-manager 默认 autoRetryReasoningReplay=true（默认开不变）', configManager.includes('autoRetryReasoningReplay: true,'));
check('config-manager 读路径归一化 ?? true（老配置无键视为开）', configManager.includes('autoRetryReasoningReplay: config.autoRetryReasoningReplay ?? true,'));
check('config-store 默认 autoRetryReasoningReplay=true（与主进程同值）', configStore.includes('autoRetryReasoningReplay: true,'));

console.log('\n=== 2) 主进程消费链（既有不动；回合终态点读 → 保存后即时生效） ===');
check('韧性层守卫：显式 false 才关闭', resilience.includes('if (getConfig().autoRetryReasoningReplay === false) return;'));
check('守卫在 maybeScheduleReasoningReplayRetry 函数体内（每回合点读，非启动缓存）', (() => {
  const at = resilience.indexOf('export function maybeScheduleReasoningReplayRetry');
  if (at < 0) return false;
  return resilience.slice(at, at + 400).includes('getConfig().autoRetryReasoningReplay === false');
})());

console.log('\n=== 3) 设置页「行为」tab 开关接线（B10 修复本体） ===');
const behaviorTabStart = configPage.indexOf("v-show=\"activeTab === 'behavior'\"");
const appearanceTabStart = configPage.indexOf("v-show=\"activeTab === 'appearance'\"");
check('行为/外观 tab 边界可定位', behaviorTabStart >= 0 && appearanceTabStart > behaviorTabStart);
const behaviorTab = behaviorTabStart >= 0 && appearanceTabStart > behaviorTabStart
  ? configPage.slice(behaviorTabStart, appearanceTabStart)
  : '';
check('PERSISTED_FIELDS 纳入 autoRetryReasoningReplay（自动保存链）', (() => {
  const m = configPage.match(/const PERSISTED_FIELDS = \[[\s\S]*?\] as const;/);
  return !!m && m[0].includes("'autoRetryReasoningReplay'");
})());
check('行为 tab 有「上游错误自动重试」toggle（field--toggle 形态 + checkbox 绑定）', (() => {
  const at = behaviorTab.indexOf('上游错误自动重试');
  if (at < 0) return false;
  const block = behaviorTab.slice(Math.max(0, at - 400), at + 400);
  return /field field--toggle/.test(block) && block.includes('v-model="store.config.autoRetryReasoningReplay"');
})());
check('checkbox 直写 config.autoRetryReasoningReplay', configPage.includes('v-model="store.config.autoRetryReasoningReplay"'));
check('绑定不取反（勾选=开启，默认开语义）', !configPage.includes('!store.config.autoRetryReasoningReplay'));
check('描述文案含 reasoning_replay（关闭后果可识别）', (() => {
  const at = configPage.indexOf('v-model="store.config.autoRetryReasoningReplay"');
  if (at < 0) return false;
  return configPage.slice(Math.max(0, at - 600), at).includes('reasoning_replay');
})());

assert.ok(pass + fail > 0, '至少应执行一条断言');
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
