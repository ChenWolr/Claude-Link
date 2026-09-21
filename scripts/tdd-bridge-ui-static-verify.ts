// tdd-bridge-ui-static-verify.ts
// 计划 docs/plans/2026-09-21-im-bridge-feishu-wechat-plan.md Task 8 契约钉：设置页 UI（静态源码断言）。
//   A. BridgeSettings.vue：BRIDGE IPC 调用 / qrcode <img> 渲染 / 掩码占位「已保存」不回显 /
//      飞书教程文案关键词「长连接」/ blur/change 即保存 / 4s 轮询 / session expired 提示。
//   B. ConfigPage.vue：import BridgeSettings 且模板挂载（「IM 机器人」区块）。
//   C. preload/api.ts：bridge 组 9 方法存在。
// 返工追加（2026-09-21 review）：
//   D. P3b 扫码 error 透传（类型 error 变体 / init.ts 不再映射 expired / Vue 展示错误文案）
//      + P3e 扫码轮询链式化（无 setInterval 堆积，poll 完成后再 setTimeout 下一次）。
//      init.ts 耦合 electron 无法行为级测试，按 ui-static 先例用源码形态断言。
// 零遗留收口追加（2026-09-21 review R2 观察）：
//   E. 扫码登录在途再点防双链：pollQrcodeStatus 快照局部 id + 重排前校验 id 一致；
//      startQrcodeLogin 开头终止旧链（非空即 stopQrcodePoll + 清 id）。
// RED 预期（未改树）：BridgeSettings.vue 不存在 → FAIL。
// 运行：npx tsx scripts/tdd-bridge-ui-static-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const exists = (rel: string): boolean => fs.existsSync(path.join(repoRoot, rel));

let pass = 0;
let fail = 0;
function check(group: string, no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ [${group}] ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ [${group}] ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A. BridgeSettings.vue
{
  const p = 'src/renderer/components/config/BridgeSettings.vue';
  if (exists(p)) {
    const src = read(p);
    check('A', '①', '调用 BRIDGE IPC（getConfig/saveConfig/getStatus/testFeishu/qrcode/qrcodeStatus/bindings/unbind）',
      src.includes('bridgeGetConfig') && src.includes('bridgeSaveConfig') && src.includes('bridgeGetStatus')
      && src.includes('bridgeTestFeishu') && src.includes('bridgeWechatQrcode') && src.includes('bridgeWechatQrcodeStatus')
      && src.includes('bridgeListBindings') && src.includes('bridgeUnbind'));
    check('A', '②', '二维码 <img :src> 渲染', /<img[^>]*:src=/.test(src));
    check('A', '③', '已存 App Secret 显示占位「已保存」不回显',
      src.includes('已保存') && !/placeholder="\{\{\s*config/.test(src));
    check('A', '④', '飞书使用说明含「长连接」关键词（教程 9 步）', src.includes('长连接'));
    check('A', '⑤', '字段 blur / 开关 change 即保存（saveOnBlur/change 语义）',
      /@blur/.test(src) && /@change/.test(src));
    check('A', '⑥', '微信扫码 4s 轮询状态', src.includes('4000'));
    check('A', '⑦', '登录态过期（session expired）→ 提示重新扫码', src.includes('session expired'));
    check('A', '⑧', '状态点渲染（绿/灰/红）', src.includes('bridge-dot') || src.includes('status-dot'));
    check('A', '⑨', '订阅 onBridgeStatusChanged + 卸载清理', src.includes('onBridgeStatusChanged') && src.includes('onBeforeUnmount'));
  } else {
    check('A', '①', 'BridgeSettings.vue 存在', false, '文件不存在');
    for (const no of ['②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨']) {
      check('A', no, '（BridgeSettings.vue 缺失连带断言）', false);
    }
  }
}

// B. ConfigPage.vue 挂载
{
  const src = read('src/renderer/pages/ConfigPage.vue');
  check('B', '①', 'import BridgeSettings 组件', src.includes("import BridgeSettings from '../components/config/BridgeSettings.vue'"));
  check('B', '②', '模板挂载 <BridgeSettings />', /<BridgeSettings\s*\/>/.test(src));
  check('B', '③', '「IM 机器人」区块标题', src.includes('IM 机器人'));
}

// C. preload/api.ts bridge 组 9 方法
{
  const src = read('src/preload/api.ts');
  const methods = [
    'bridgeGetConfig', 'bridgeSaveConfig', 'bridgeGetStatus', 'bridgeTestFeishu',
    'bridgeWechatQrcode', 'bridgeWechatQrcodeStatus', 'bridgeListBindings', 'bridgeUnbind',
    'onBridgeStatusChanged',
  ];
  const missing = methods.filter((m) => !src.includes(`${m}:`));
  check('C', '①', 'bridge 组 9 方法齐全（接口 + 实现各 1 处）', missing.length === 0,
    `缺=${JSON.stringify(missing)}；实现对象遗漏=${JSON.stringify(methods.filter((m) => (src.split(`${m}:`).length - 1) < 2))}`);
  check('C', '②', 'onBridgeStatusChanged 订阅 BRIDGE_STATUS_CHANGED 通道',
    src.includes('IPC_CHANNELS.BRIDGE_STATUS_CHANGED'));
}

// D. 返工契约（review P3b/P3e）：扫码错误透传 + 轮询链式化
{
  const typesSrc = read('src/shared/types/bridge.ts');
  check('D', '①', "WechatQrcodeStatusResult 含 { status: 'error' } 变体（错误可透传，不再吞成 expired）",
    /status:\s*'error'/.test(typesSrc), 'shared/types/bridge.ts 缺 error 变体');
  const initSrc = read('src/main/modules/bridge/init.ts');
  check('D', '②', "init.ts 扫码 error 透传错误文案（error: result.error），不再映射成 expired",
    initSrc.includes('error: result.error'), 'init.ts 仍把扫码 error 映射成 expired');
  if (exists('src/renderer/components/config/BridgeSettings.vue')) {
    const vueSrc = read('src/renderer/components/config/BridgeSettings.vue');
    check('D', '③', "BridgeSettings 展示扫码错误文案（r.status === 'error' 分支）",
      /r\.status\s*===\s*'error'/.test(vueSrc), 'Vue 未处理扫码 error 状态');
    check('D', '④', '扫码轮询链式化（无 setInterval 堆积；poll 完成后再 setTimeout 下一次）',
      !vueSrc.includes('setInterval') && /setTimeout/.test(vueSrc),
      '仍存在 setInterval 请求堆积或未链式');
  } else {
    check('D', '③', '（BridgeSettings.vue 缺失连带断言）', false);
    check('D', '④', '（BridgeSettings.vue 缺失连带断言）', false);
  }
}

// E. 零遗留收口契约（review R2 观察）：扫码登录在途再点产生双轮询链
{
  const vueSrc = read('src/renderer/components/config/BridgeSettings.vue');
  check('E', '①', 'pollQrcodeStatus 开头快照局部 id（const id = qrQrcodeId.value; if (!id) return;）',
    /const id = qrQrcodeId\.value;\s*\r?\n\s*if \(!id\) return;/.test(vueSrc),
    'pollQrcodeStatus 仍直接读响应式 qrQrcodeId，无局部快照');
  check('E', '②', 'pollQrcodeStatus 尾部重排前校验链身份（qrQrcodeId.value === id，旧链回来不再排程）',
    vueSrc.includes('qrQrcodeId.value === id'),
    '重排条件未校验 id 一致性，在途旧链回来会续排双链');
  check('E', '③', 'startQrcodeLogin 开头终止旧链（qrQrcodeId 非空 → stopQrcodePoll + 清 id）',
    /async function startQrcodeLogin\(\)[\s\S]*?if \(qrQrcodeId\.value\) \{[\s\S]*?stopQrcodePoll\(\);[\s\S]*?qrQrcodeId\.value = '';/m.test(vueSrc),
    'startQrcodeLogin 未清旧链，在途再点产生双链');
}

console.log(`\n结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
