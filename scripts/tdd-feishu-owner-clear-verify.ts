// tdd-feishu-owner-clear-verify.ts
// A14（D12-F2，P2）契约钉：飞书 owner 捕获后的「清除授权用户」UI 出口。
//
// 根因：e8aec11「设置页收窄」撤下清除授权 UI 后仅微信有「退出登录」兜底（退出清 owner），
// 飞书无任何等价操作——ownerOpenId 一旦写入只能手改 userData/bridge/profiles.json。owner
// 收窄后非 owner 消息在 manager 直接 return（无会话/无回复/无提示），错误捕获（他人抢注/
// 换账号/应用重建致 openId 变化）即对所有人永久静默，界面（已连接无报错）零线索。
//
// 修复语义：飞书卡片 Owner 行补「清除授权用户」danger 按钮，两段式确认（首次点击进入 armed
// 态 + 3s 自动退出，渲染层无 window.confirm 先例；再点执行）。执行传 `ownerOpenId: ''` 走
// bridgeSaveConfig 既有清除语义（init.ts ''→null），属「纯数据操作只落盘不动平台」（before
// 快照不含 ownerOpenId）——进行中桥接回合不中断；manager 每条消息现读 profiles，下一个私聊
// 用户自动重新捕获为 owner。保存返回后 Owner 行随 config.feishu.ownerOpenId 为 null 消失，
// 回到「等待首个私聊用户」态；重复点击幂等（v-if 卸载按钮）。
//
// 运行：npx tsx scripts/tdd-feishu-owner-clear-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const vue = readFileSync(new URL('../src/renderer/components/config/BridgeSettings.vue', import.meta.url), 'utf8');
const init = readFileSync(new URL('../src/main/modules/bridge/init.ts', import.meta.url), 'utf8');
const manager = readFileSync(new URL('../src/main/modules/bridge/manager.ts', import.meta.url), 'utf8');
const bridgeTypes = readFileSync(new URL('../src/shared/types/bridge.ts', import.meta.url), 'utf8');

console.log('\n=== A14（D12-F2）：飞书 owner 清除授权用户出口 ===');
console.log('\n=== 组1 渲染层（两段式确认 + 清除调用） ===');
check('① Owner 行含 danger 清除按钮（两段式文案随 armed 态切换）', () => {
  const at = vue.indexOf('v-if="config?.feishu.ownerOpenId"');
  assert.ok(at > -1, '缺 Owner 行定位锚');
  const region = vue.slice(at, vue.indexOf('</div>', at) + 6);
  assert.match(region, /清除授权用户/, '缺按钮文案');
  assert.match(region, /确认清除/, '缺 armed 态确认文案');
  assert.match(region, /im-act-btn--danger/, '缺 danger 样式类');
});
check('② 清除确认提示：清除后下一个私聊用户自动成为授权用户', () => {
  const at = vue.indexOf('v-if="config?.feishu.ownerOpenId"');
  const region = vue.slice(at, vue.indexOf('</div>', at) + 6);
  assert.match(region, /下一个.{0,6}私聊.{0,6}的用户.{0,4}自动成为授权用户|自动成为授权用户/, '缺语义提示');
});
check('③ handler 两段式：armed 态 + 3s 自动退出 + 二次点击才执行', () => {
  const at = vue.indexOf('async function clearFeishuOwner');
  assert.ok(at > -1, '缺 clearFeishuOwner');
  const body = vue.slice(at, vue.indexOf('\n}', at));
  assert.match(body, /if \(!feishuClearArmed\.value\)/, '缺首击 armed 门');
  assert.match(body, /setTimeout\(\(\) => \{ feishuClearArmed\.value = false; \}, 3000\)/, '缺 3s 退出');
  const armIdx = body.indexOf('if (!feishuClearArmed.value)');
  const saveIdx = body.indexOf("save({ feishu: { ownerOpenId: '' } })");
  assert.ok(saveIdx > armIdx, '执行须在 armed 门之后（二击路径）');
});
check('④ 卸载清 armed 计时器（防泄漏）', () => {
  assert.match(vue, /onBeforeUnmount\(\(\) => \{[\s\S]{0,400}feishuClearArmTimer/, 'onBeforeUnmount 须清 feishuClearArmTimer');
});

console.log('\n=== 组2 主进程与类型（既有语义回归钉） ===');
check('⑤ init.ts 既有清除语义在位：空串 → null', () => {
  assert.match(init, /input\.feishu\.ownerOpenId === '' \? null : input\.feishu\.ownerOpenId/, "缺 ''→null 清除分支");
});
check('⑥ owner 清除不动平台：before 快照不含 ownerOpenId（进行中回合不中断）', () => {
  const at = init.indexOf('const before = {');
  const region = init.slice(at, init.indexOf('};', at) + 2);
  assert.ok(!region.includes('ownerOpenId'), 'before 快照不应含 ownerOpenId（含则清除会触发平台重启）');
});
check('⑦ manager 侧 owner 现读 profiles（清除即时生效，无需重启）', () => {
  assert.match(manager, /this\.deps\.profiles\(\)\.feishu\.ownerOpenId/, '缺现读形态');
  assert.match(manager, /saveFeishuOwner\(m\.userId\)/, '缺首捕获路径（清除后重新捕获的依赖）');
});
check('⑧ 类型：BridgeConfigSaveInput.feishu.ownerOpenId 可选（支撑部分保存 patch）', () => {
  assert.match(bridgeTypes, /ownerOpenId\?: string \| null;/, '缺 optional 声明');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
