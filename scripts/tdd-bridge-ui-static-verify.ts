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
// 方案 D 版式契约（计划 docs/plans/2026-09-21-im-tab-d-layout-plan.md §2.5）：
//   B③ 语义升级：孤儿「IM 机器人」区块 → IM tab 门控挂载（v-show=activeTab im）。
//   F. BridgeSettings.vue 双栏版式：F① 平台导航 / F② 五态中文映射 / F③ 绑定按面板过滤 /
//      F④ 迷你开关联 save 链 / F⑤ 全局面板保留 / F⑥ 微信扫码链原样 / F⑦ 图标全内联 SVG。
//      F⑧ mini-switch 双开关 @click.stop（点开关不连带切面板）。
// RED 预期（未改树）：BridgeSettings.vue 不存在 → FAIL。
// 2026-09-23 微信扫码重连修复计划追加：N. init.ts 扫码 confirmed 清墓碑接线
//   （N③④ 2026-09-23 退出登录完全重置追加：doSave 退出登录清绑定接线形态断言）
//   （耦合 electron 无法行为级测试，沿 D 组形态断言先例）。
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
  // 批次5.1-5 同步：挂载加 ref="bridgeSettingsRef"（IM tab 重拉），正则放宽到允许属性。
  check('B', '②', '模板挂载 <BridgeSettings … />（允许 ref 属性）', /<BridgeSettings\b[^>]*\/>/.test(src));
  check('B', '③', 'IM tab 门控挂载（v-show=activeTab im + <BridgeSettings … />）',
    src.includes(`v-show="activeTab === 'im'"`) && /<BridgeSettings\b[^>]*\/>/.test(src));
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
  // 2026-09-23 第二轮 B1 最小同步：startQrcodeLogin 加 opts?/{ auto? } 参（自动换码），
  // 签名钉放宽为可带参（窗口位移按 5db45f7 先例）；终止旧链三锚点不变。
  check('E', '③', 'startQrcodeLogin 开头终止旧链（qrQrcodeId 非空 → stopQrcodePoll + 清 id）',
    /async function startQrcodeLogin\([^)]*\)[\s\S]*?if \(qrQrcodeId\.value\) \{[\s\S]*?stopQrcodePoll\(\);[\s\S]*?qrQrcodeId\.value = '';/m.test(vueSrc),
    'startQrcodeLogin 未清旧链，在途再点产生双链');
}

// F. 方案 D 版式契约（计划 docs/plans/2026-09-21-im-tab-d-layout-plan.md §2.5）
{
  const src = read('src/renderer/components/config/BridgeSettings.vue');
  check('F', '①', '平台导航存在（activePane + im-rail）',
    src.includes('activePane') && src.includes('im-rail'),
    '缺左栏平台导航（activePane ref / im-rail 类）');
  check('F', '②', '状态五态中文映射（STATUS_LABELS：已连接/连接中/异常/已断开/未启用）',
    src.includes('STATUS_LABELS') && ['已连接', '连接中', '异常', '已断开', '未启用'].every((t) => src.includes(t)),
    '缺 STATUS_LABELS 五态中文映射');
  check('F', '③', '绑定按面板过滤（paneBindings：平台面板只看本平台，全局=全部）',
    src.includes('paneBindings') && /b\.platform\s*===\s*activePane/.test(src),
    '缺 paneBindings computed / 平台过滤形态');
  check('F', '④', '迷你开关联 save 链（mini-switch × feishu/wechat enabled）',
    src.includes('mini-switch') && src.includes('save({ feishu: { enabled') && src.includes('save({ wechat: { enabled'),
    'rail 迷你开关未接原 save({ platform: { enabled } }) 链');
  check('F', '⑤', '全局面板保留（pickWorkingDir + 留空 = 不设置工作目录）',
    src.includes('pickWorkingDir') && src.includes('留空 = 不设置工作目录'),
    '全局面板工作目录/浏览/说明文案丢失');
  check('F', '⑥', '微信扫码链原样（startQrcodeLogin + bridgeWechatQrcodeStatus + 每 4 秒自动查询状态）',
    src.includes('startQrcodeLogin') && src.includes('bridgeWechatQrcodeStatus') && src.includes('每 4 秒自动查询状态'),
    '微信扫码链或 4s 提示文案丢失');
  const logoCount = (src.match(/im-rail__logo/g) ?? []).length;
  const svgCount = (src.match(/<svg/g) ?? []).length;
  check('F', '⑦', '图标全内联 SVG（im-rail__logo ≥3 且 <svg ≥3，无 emoji 结构位）',
    logoCount >= 3 && svgCount >= 3,
    `im-rail__logo=${logoCount}, <svg=${svgCount}（须各 ≥3：飞书/微信/全局）`);
  // F⑧（P3 收口）：mini-switch 嵌套在 rail <button> 内，须 @click.stop 阻断冒泡，
  // 否则点开关会连带触发外层按钮 @click 切换面板（P3-1）。逐个标签断言：删任一 @click.stop 必转 FAIL。
  const inputTags = src.match(/<input\b[^>]*>/g) ?? [];
  const miniSwitchTags = inputTags.filter((tag) => tag.includes('mini-switch'));
  const stopCount = miniSwitchTags.filter((tag) => tag.includes('@click.stop')).length;
  check('F', '⑧', '迷你开关 @click.stop（嵌套在 rail 按钮内，点击/空格不冒泡切面板，两个均须带）',
    miniSwitchTags.length === 2 && stopCount === 2,
    `mini-switch 输入=${miniSwitchTags.length}（须 2），带 @click.stop=${stopCount}/2`);
}

// 生命周期修复计划契约（docs/plans/2026-09-22-im-bridge-lifecycle-ux-fix-plan.md 批次1）：
//   G. 解绑确认框+_transient 提示 / 空态文案 / appId 前置校验（渲染层红字+主进程正则双路径）/
//      微信 expired 态扫码入口并存。
{
  const vueSrc = read('src/renderer/components/config/BridgeSettings.vue');
  check('G', '①', '解绑按钮走确认框+unbindNotice 提示（window.confirm + unbindNotice ref）',
    vueSrc.includes('window.confirm') && vueSrc.includes('unbindNotice'),
    '解绑无确认框或无 transient 提示 ref');
  check('G', '②', '绑定空态文案含「/new 重新绑定」（解绑语义告知）',
    vueSrc.includes('/new 重新绑定'),
    '空态文案未告知解绑后需 /new 重新绑定');
  check('G', '③', 'appId 渲染层即时校验（appidError ref + cli_ 正则字面 + 校验失败不保存）',
    vueSrc.includes('appidError') && /cli_\[0-9a-fA-F\]\{16\}/.test(vueSrc),
    '缺渲染层 appId 格式校验');
  const initSrc = read('src/main/modules/bridge/init.ts');
  check('G', '④', 'init.ts 保存路径 appId 前置校验（FEISHU_APPID_RE + 格式非法抛错）',
    initSrc.includes('FEISHU_APPID_RE') && initSrc.includes('App ID 格式非法'),
    'init.ts 缺保存路径 appId 前置校验');
  check('G', '⑤', 'initBridge 启动分支非法 appId → markPlatformError（文案含 cli_ 开头）',
    initSrc.includes('markPlatformError') && initSrc.includes('cli_ 开头'),
    '启动分支缺非法 appId markPlatformError 兜底');
  check('G', '⑥', '微信 expired 态扫码入口并存（!loggedIn || wechatSessionExpired()）',
    /!config\?\.wechat\.loggedIn \|\| wechatSessionExpired\(\)/.test(vueSrc),
    '扫码登录区仍以 v-else 挂在 loggedIn 上，expired 态被「退出登录」遮挡');
}

// 生命周期修复计划契约（docs/plans/2026-09-22-im-bridge-lifecycle-ux-fix-plan.md 批次2）：
//   H. 保存串行链 + 脏检查 + 微信积压跳过接线 + 平台重启 IPC 全链（constants/types/ipc-handlers/
//      preload）+ 微信开关区积压语义文案。
{
  const initSrc = read('src/main/modules/bridge/init.ts');
  check('H', '①', '保存串行链（bridgeSaveChain + doSave 拆分，restart 与 save 全局串行）',
    initSrc.includes('bridgeSaveChain') && /async function doSave/.test(initSrc),
    'init.ts 缺保存串行链');
  check('H', '②', '保存脏检查（before 快照 + feishuRestart/wechatRestart 触发字段集比较）',
    initSrc.includes('feishuRestart') && initSrc.includes('wechatRestart') && initSrc.includes('before.feishu'),
    'bridgeConfigSave 未按重启字段集做脏检查');
  check('H', '③', '微信禁用写积压跳过标记（writeWechatSkipBacklogFlag 接线）',
    initSrc.includes('writeWechatSkipBacklogFlag'),
    '微信禁用分支未写 skip-backlog 标记');
  check('H', '④', '平台重启 IPC 逻辑（bridgePlatformRestart：入链 + 未启用/凭据缺失明确拒绝）',
    initSrc.includes('bridgePlatformRestart') && initSrc.includes('无法重连'),
    'init.ts 缺 bridgePlatformRestart');
  const ipcSrc = read('src/shared/types/ipc.ts');
  check('H', '⑤', 'BRIDGE_PLATFORM_RESTART 通道常量', ipcSrc.includes('BRIDGE_PLATFORM_RESTART'),
    'types/ipc.ts 缺 BRIDGE_PLATFORM_RESTART');
  check('H', '⑥', 'ipc-handlers 注册 BRIDGE_PLATFORM_RESTART（输入归一）',
    read('src/main/ipc-handlers.ts').includes('IPC_CHANNELS.BRIDGE_PLATFORM_RESTART'),
    'ipc-handlers 未注册平台重启通道');
  const preloadSrc = read('src/preload/api.ts');
  check('H', '⑦', 'preload bridgePlatformRestart 方法（接口 + 实现 ≥2 处）',
    (preloadSrc.match(/bridgePlatformRestart/g) ?? []).length >= 2,
    `出现 ${(preloadSrc.match(/bridgePlatformRestart/g) ?? []).length} 次（须 ≥2）`);
  const vueSrc = read('src/renderer/components/config/BridgeSettings.vue');
  check('H', '⑧', '微信积压语义 dim 文案（关闭通信期间消息不补处理）',
    vueSrc.includes('关闭通信期间收到的消息不会在重新打开后处理'),
    '微信开关区缺积压语义说明');
}

// 生命周期修复计划契约（docs/plans/2026-09-22-im-bridge-lifecycle-ux-fix-plan.md 批次3）：
//   I. 状态可见性：错误内联红字（140 截断）/ loadAll 竞态代际守卫 / 重连按钮（busy 锁 + 未启用禁用）。
{
  const vueSrc = read('src/renderer/components/config/BridgeSettings.vue');
  check('I', '①', '平台面板错误内联红字（paneError + truncate 140 截断 + im-status-error）',
    vueSrc.includes('paneError') && /truncate\(/.test(vueSrc) && /140/.test(vueSrc)
      && vueSrc.includes('im-status-error'),
    '缺内联错误行或 140 字截断');
  check('I', '②', 'loadAll/推送竞态代际守卫（pushGen：旧快照不覆盖新推送）',
    /pushGen/.test(vueSrc) && /gen === pushGen/.test(vueSrc),
    '缺 pushGen 代际守卫');
  check('I', '③', '重连按钮（restartPlatform + bridgePlatformRestart + restarting busy 锁）',
    vueSrc.includes('restartPlatform') && vueSrc.includes('bridgePlatformRestart') && /restarting/.test(vueSrc),
    '缺重连按钮或 busy 锁');
}

// 生命周期修复计划契约（docs/plans/2026-09-22-im-bridge-lifecycle-ux-fix-plan.md 批次5）：
//   J. 渲染层卫生：saveError 生命周期 / 扫码失败走 qrError+清二维码 / 轮询容错 streak /
//      ConfigPage im tab 重拉 / 测试连接先存后测 / 微信授权用户 UI / 使用说明六条补全。
{
  const vueSrc = read('src/renderer/components/config/BridgeSettings.vue');
  check('J', '①', 'loadAll 成功路径清 saveError',
    /await claude\.bridgeListBindings\(\);[\s\S]{0,80}saveError\.value = ''/.test(vueSrc),
    'loadAll 成功后未清 saveError');
  check('J', '②', 'startQrcodeLogin 失败走 qrError 且清残留二维码',
    /catch[\s\S]{0,200}qrError\.value =/m.test(vueSrc) && /qrDataUrl\.value = ''[\s\S]{0,120}qrQrcodeId\.value = '';[\s\S]{0,120}qrError\.value =/m.test(vueSrc),
    '扫码失败仍占用 saveError 槽位或未清旧二维码');
  check('J', '③', '扫码轮询容错（qrErrorStreak：<3 不断链，>=3 才 settled 断链）',
    /qrErrorStreak/.test(vueSrc),
    '一次 error 即断链（网络抖动作废整条扫码链）');
  check('J', '④', '测试连接先存后测（feishuAppIdInput 本地 ref + testFeishu 内先 save appId）',
    /feishuAppIdInput/.test(vueSrc)
      && /async function testFeishu[\s\S]{0,300}await save\(\{ feishu: \{ appId: feishuAppIdInput\.value\.trim\(\) \} \}\)/m.test(vueSrc),
    'testFeishu 未用当前输入框值先保存');
  check('J', '⑤', '微信授权用户 UI（ownerUserId 匹配 + 清除授权按钮 + dim 提示）',
    vueSrc.includes('wechatOwnerUserId') || (vueSrc.includes('ownerUserId') && vueSrc.includes('清除授权')),
    '微信面板缺授权用户行/清除授权');
  check('J', '⑥', '使用说明六条补全（私聊/命令/合并/积压/隐私/owner）',
    ['仅支持私聊', '/new', '/stop', '合并为一次回复', '不会在重新打开后处理', '会话列表中可见', '仅授权用户'].every((t) => vueSrc.includes(t)),
    '使用说明缺批次5.3 新文案');

  const pageSrc = read('src/renderer/pages/ConfigPage.vue');
  check('J', '⑦', 'ConfigPage 切回 IM tab 重拉（watch im 分支 + bridgeSettingsRef + refresh expose）',
    /watch\(activeTab, \(tab\) => \{[\s\S]{0,200}tab === 'im'[\s\S]{0,120}bridgeSettingsRef[\s\S]{0,80}refresh/m.test(pageSrc)
      && /<BridgeSettings ref="bridgeSettingsRef" \/>/.test(pageSrc),
    'ConfigPage 缺 im 分支 watch 或模板 ref');
  check('J', '⑧', 'BridgeSettings defineExpose refresh（loadAll）',
    /defineExpose\(\{ refresh: loadAll \}\)/.test(vueSrc),
    'BridgeSettings 未暴露 refresh');
}

// 第二轮计划契约（docs/plans/2026-09-23-im-config-ux-round2-plan.md 批次A A2）：
//   K. 处理中回执开关（全局面板「处理中提示」checkbox + save receiptEnabled + 「（正在处理…）」锚点）。
{
  const vueSrc = read('src/renderer/components/config/BridgeSettings.vue');
  check('K', '①', '全局面板「处理中提示」开关（checkbox + receiptEnabled 联动保存）',
    vueSrc.includes('处理中提示') && /receiptEnabled/.test(vueSrc)
      && /save\(\{ global: \{ receiptEnabled/.test(vueSrc),
    '全局面板缺处理中回执开关或未接 save receiptEnabled');
  check('K', '②', '「（正在处理…）」回执文案锚点存在（与 manager 回执文案一致）',
    vueSrc.includes('（正在处理…）'),
    '缺「（正在处理…）」回执说明锚点');
}

// 第二轮计划契约（docs/plans/2026-09-23-im-config-ux-round2-plan.md 批次B）：
//   L. 设置页交互卫生：B1 二维码自动换码（限 2 次）+手动刷新 / B2 微信使用说明折叠区 /
//      B3 清除授权确认框（两处）/ B4 重连引导 title+测试结果自动消失+引导开启。
{
  const vueSrc = read('src/renderer/components/config/BridgeSettings.vue');
  // B1：自动换码计数 + auto 调用形态 + 上限 2 + 手动刷新按钮 + 过期文案。
  check('L', '①', 'B1 二维码自动换码（qrAutoRefetch 计数 + auto 形态调用 + 上限 2）',
    /qrAutoRefetch/.test(vueSrc) && /startQrcodeLogin\(\{ auto: true \}\)/.test(vueSrc)
      && /qrAutoRefetch < 2/.test(vueSrc),
    '缺 qrAutoRefetch 计数 / auto 调用 / 上限守卫');
  check('L', '②', 'B1 手动刷新按钮（「刷新二维码」+ 过期文案含自动换码已达上限）',
    vueSrc.includes('刷新二维码') && vueSrc.includes('自动换码已达上限'),
    '缺手动刷新按钮或过期提示未改');

  // B2：微书面板使用说明折叠区（与飞书块分块锚定，互不误伤）+ 旧积压 hint 不残留。
  const wechatSection = vueSrc.split('<!-- 微书面板 -->')[1]?.split('<!-- 全局面板 -->')[0] ?? '';
  const feishuSection = vueSrc.split('<!-- 飞书面板 -->')[1]?.split('<!-- 微书面板 -->')[0] ?? '';
  check('L', '③', 'B2 微书面板新增 <details class="im-guide"> 使用说明折叠区',
    wechatSection.includes('<details class="im-guide">') && wechatSection.includes('<summary>使用说明</summary>'),
    '微书面板缺 im-guide 折叠区');
  const guideKeywords = ['扫码登录', '授权用户', '/help', '24 小时', '暂不支持', '隐私提示'];
  const hit = guideKeywords.filter((k) => wechatSection.includes(k));
  check('L', '④', 'B2 微信使用说明关键词 ≥6（扫码登录/授权用户//help/24 小时/暂不支持/隐私提示）',
    hit.length >= 6, `命中=${JSON.stringify(hit)}（飞书面板不含「24 小时」——分块锚定不误伤）`);
  check('L', '⑤', 'B2 旧积压散置 hint 删除（短语并入说明第 9 条，独立 hint 行不残留）',
    !/<span class="im-field-hint">关闭通信期间收到的消息不会在重新打开后处理<\/span>/.test(vueSrc)
      && wechatSection.includes('关闭通信期间收到的消息不会在重新打开后处理'),
    '旧积压 hint 行残留或未并入说明');
  check('L', '⑥', 'B2 分块锚定不误伤（飞书面板不含「24 小时」字样）',
    !feishuSection.includes('24 小时'),
    `飞书面板长度=${feishuSection.length}（锚定失败会误伤）`);

  // B3：清除授权两处确认框（clearOwner / clearWechatOwner 函数体各含 confirm+明示后果）。
  check('L', '⑦', 'B3 clearOwner/clearWechatOwner 各含 window.confirm+后果明示',
    /function clearOwner\(\): void \{[\s\S]{0,300}window\.confirm\('确定清除授权用户\？[\s\S]{0,200}下一个给机器人发私聊消息的用户将自动成为授权用户/.test(vueSrc)
      && /function clearWechatOwner\(\): void \{[\s\S]{0,300}window\.confirm\('确定清除授权用户\？[\s\S]{0,200}下一个给机器人发私聊消息的用户将自动成为授权用户/.test(vueSrc),
    '清除授权缺确认框或未明示后果');

  // B4：三处小卫生。
  check('L', '⑧', 'B4 重连按钮禁用解释 title（请先在左侧打开×2 平台）',
    (vueSrc.match(/请先在左侧打开/g) ?? []).length >= 2,
    `出现 ${(vueSrc.match(/请先在左侧打开/g) ?? []).length} 次（须 ≥2）`);
  check('L', '⑨', 'B4 测试结果自动消失（feishuTestResultTimer + onBeforeUnmount 清理）',
    /feishuTestResultTimer/.test(vueSrc)
      && /onBeforeUnmount\(\(\) => \{[\s\S]{0,600}feishuTestResultTimer/.test(vueSrc),
    '缺 feishuTestResultTimer 或 onBeforeUnmount 未清理');
  check('L', '⑩', 'B4 测试成功引导开启（凭据可用；在左侧列表打开飞书开关）',
    vueSrc.includes('凭据可用；在左侧列表打开飞书开关'),
    '测试成功后缺引导开启 hint');
}

// 第二轮计划契约（docs/plans/2026-09-23-im-config-ux-round2-plan.md 批次C）：
//   M. C1 botName 回显 / C2 入站活动性自查提示 / C3 飞书 owner 昵称显示。
{
  const vueSrc = read('src/renderer/components/config/BridgeSettings.vue');
  // C1：botName 展示（机器人：）+ BridgeFeishuTestResult 类型引用。
  check('M', '①', 'C1 测试成功回显 botName（机器人：）',
    vueSrc.includes('机器人：') && /botName/.test(vueSrc),
    '测试结果缺 botName 回显');
  check('M', '②', 'C1 feishuTestResult 类型用 BridgeFeishuTestResult（替换内联类型）',
    /BridgeFeishuTestResult/.test(vueSrc),
    'feishuTestResult 仍用内联类型');

  // C2：staleInbound 派生 + 两平台自查提示关键词。
  check('M', '③', 'C2 staleInbound 活动性派生（connectedAt + 120s + nowTick 依赖）',
    /staleInbound/.test(vueSrc) && /120_000/.test(vueSrc) && /connectedAt/.test(vueSrc),
    '缺 staleInbound 派生');
  check('M', '④', 'C2 飞书自查提示关键词（im.message.receive_v1 事件并发布 / 给机器人发一条私聊消息试试）',
    vueSrc.includes('im.message.receive_v1 事件并发布') && vueSrc.includes('给机器人发一条私聊消息试试'),
    '缺飞书无入站自查提示');
  check('M', '⑤', 'C2 微信自查提示（已连接超过 2 分钟但未收到消息）',
    /staleInbound\('wechat'\)/.test(vueSrc) && vueSrc.includes('已连接超过 2 分钟但未收到消息'),
    '缺微信无入站自查提示');

  // C3：feishuOwnerName computed + 模板昵称（openId）回退形态。
  check('M', '⑥', 'C3 feishuOwnerName 解析（bindings displayName 匹配 + 空回退）',
    /feishuOwnerName/.test(vueSrc) && /ownerOpenId/.test(vueSrc),
    '缺 feishuOwnerName computed');
  check('M', '⑦', 'C3 模板昵称优先回退裸 openId（feishuOwnerName || config.feishu.ownerOpenId）',
    /feishuOwnerName \|\| config\.feishu\.ownerOpenId/.test(vueSrc),
    'Owner 行未接昵称回退形态');

  // C1 关键边界（执行要点③）：botName 二次请求失败必须静默省略、不影响 ok 判定。
  // init.ts 耦合 electron 无法行为级测试，按 D② 先例用源码形态断言。
  const initSrc = read('src/main/modules/bridge/init.ts');
  check('M', '⑧', 'C1 botName 二次请求失败静默省略（catch 空体）且 ok 判定只看第一步',
    /bot\/v3\/info/.test(initSrc) && /catch \{ \/\* botName 可选[\s\S]{0,40}\*\//.test(initSrc)
      && /return \{ ok: true, detail: '连接成功', botName \}/.test(initSrc),
    'init.ts botName 路径缺静默省略形态');
}

{
  const initSrc = read('src/main/modules/bridge/init.ts');
  check('N', '①', 'init.ts 接线存在（purgeTombstonesByPlatform 调用）',
    initSrc.includes('purgeTombstonesByPlatform'),
    'init.ts 缺扫码 confirmed 清墓碑接线');
  // N②：位置钉。锚点取 confirmed 分支内特有字面量避免歧义：
  //   cipher.encrypt（confirmed 段内写密文，全文件唯一）→ persistProfiles（confirmed 段内那处）→
  //   purgeTombstonesByPlatform → startPlatform('wechat')（qrcodeStatus 段内调用处）。
  const anchorEncrypt = initSrc.indexOf('botTokenEnc = cipher.encrypt');
  const anchorPersist = initSrc.indexOf('persistProfiles(rt);', anchorEncrypt);
  const anchorPurge = initSrc.indexOf('purgeTombstonesByPlatform', anchorEncrypt);
  const anchorStart = initSrc.indexOf("startPlatform('wechat')", anchorEncrypt);
  check('N', '②', '接线位置正确：persistProfiles(rt) 之后、startPlatform(\'wechat\') 之前（confirmed 分支内）',
    anchorEncrypt >= 0 && anchorPersist >= 0 && anchorPurge >= 0 && anchorStart >= 0
    && anchorPersist < anchorPurge && anchorPurge < anchorStart,
    `encrypt=${anchorEncrypt} persist=${anchorPersist} purge=${anchorPurge} start=${anchorStart}`);
  // N③④（2026-09-23 退出登录完全重置）：doSave 微信禁用分支接线退出登录清绑定——
  // purgeAllBindingsByPlatform + 逐 key manager.unbind，位置在 markPlatformOff('wechat')
  // （该调用全文件唯一）之后；init.ts 耦合 electron，沿 N①② 形态断言先例。
  check('N', '③', '退出登录接线存在（purgeAllBindingsByPlatform + manager.unbind + 授权用户一并清除）',
    initSrc.includes('purgeAllBindingsByPlatform') && initSrc.includes('manager.unbind')
    && initSrc.includes("input.wechat.botToken === ''") && initSrc.includes('p.wechat.ownerUserId = null'),
    'init.ts 缺退出登录清绑定/清授权用户接线');
  const anchorOff = initSrc.indexOf("markPlatformOff('wechat')");
  const anchorPurgeAll = initSrc.indexOf('purgeAllBindingsByPlatform');
  check('N', '④', '退出登录接线位于微信禁用分支（markPlatformOff(\'wechat\') 之后）',
    anchorOff >= 0 && anchorPurgeAll > anchorOff,
    `off=${anchorOff} purgeAll=${anchorPurgeAll}`);
}

console.log(`\n结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
