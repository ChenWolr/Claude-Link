// tdd-bridge-sessions-upserted-verify.ts
// A3（D01-F2 + D12-F4，P2）契约钉：桥接运行期自动建会话推送信号 + 会话列表去抖刷新 + 幽灵守卫收窄。
//
// 根因：①桥接侧（manager.ts /new 与悬空重建）经 init.ts 直调 sessionRepo.createSession 直写库，
// 无任何「会话列表已变化」广播——渲染层会话列表只靠三处 onMounted 拉取，运行期新建的桥接会话
// 不进侧栏；②use-chat 的已删会话守卫（hb12-SMG-05）对「不在本地列表」一律丢弃——新桥接会话的
// 后台事件（流式/任务/结果）被当已删丢弃；③完成通知点击 navigate 因列表无该会话而 no-op。
//
// 修复语义：
//   1. 主进程：bridge createSession 依赖封装内建会话成功后经主窗口广播 BRIDGE_SESSIONS_UPSERTED
//      （载荷 { sessionId }），覆盖 manager 全部建会话路径；
//   2. preload：onBridgeSessionsUpserted 监听注册（on/off 对称）；
//   3. session-store：markBridgeSessionUpserted 500ms 去抖重拉 loadSessions（连发合并；不覆盖选中态）；
//   4. use-chat 守卫收窄：「不在列表」拆两态——本运行期已见（knownSessionIds 命中）= 已删除，仍丢弃
//      （SMG-05 防幽灵复活）；从未见过 = 运行期新建（桥接首联），登记后放行进后台处理，列表由
//      信号触发的刷新补齐。knownSessionIds 在 loadSessions / 物化入库 / 守卫放行三处播种。
//
// 运行：npx tsx scripts/tdd-bridge-sessions-upserted-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

const ipc = readFileSync(new URL('../src/shared/types/ipc.ts', import.meta.url), 'utf8');
const bridgeInit = readFileSync(new URL('../src/main/modules/bridge/init.ts', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../src/preload/api.ts', import.meta.url), 'utf8');
const store = readFileSync(new URL('../src/renderer/stores/session-store.ts', import.meta.url), 'utf8');
const useChat = readFileSync(new URL('../src/renderer/composables/use-chat.ts', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/renderer/App.vue', import.meta.url), 'utf8');

console.log('\n=== A3-①：主进程广播通道（ipc 常量 + bridge createSession 封装） ===');
check('IPC_CHANNELS 新增 BRIDGE_SESSIONS_UPSERTED（bridge:sessionsUpserted）', () => {
  assert.match(ipc, /BRIDGE_SESSIONS_UPSERTED: 'bridge:sessionsUpserted',/);
});
check('bridge init.ts createSession 依赖封装内：建会话成功后广播 BRIDGE_SESSIONS_UPSERTED', () => {
  const depIdx = bridgeInit.indexOf('createSession: (name, model, workingDir)');
  assert.ok(depIdx > -1, '未定位到 createSession 依赖封装');
  const depBody = bridgeInit.slice(depIdx, bridgeInit.indexOf('\n    getBinding:', depIdx));
  assert.match(depBody, /sessionRepo\.createSession/, '依赖封装未走 sessionRepo.createSession');
  assert.match(depBody, /BRIDGE_SESSIONS_UPSERTED/, '建会话后未广播 BRIDGE_SESSIONS_UPSERTED');
  assert.match(depBody, /sessionId: session\.id|sessionId/, '广播载荷缺 sessionId');
  // 广播在 createSession 之后（先落库后推送）
  const createIdx = depBody.indexOf('sessionRepo.createSession');
  const sendIdx = depBody.indexOf('BRIDGE_SESSIONS_UPSERTED');
  assert.ok(sendIdx > createIdx, '广播必须先于（晚于）建库行完成');
});

console.log('\n=== A3-②：preload 监听注册 ===');
check('preload 暴露 onBridgeSessionsUpserted（on/off 对称 + 类型声明）', () => {
  assert.match(preload, /onBridgeSessionsUpserted: \(callback: \(payload: \{ sessionId: string \}\) => void\) => \(\) => void;/, '接口类型缺 onBridgeSessionsUpserted');
  assert.match(preload, /ipcRenderer\.on\(IPC_CHANNELS\.BRIDGE_SESSIONS_UPSERTED, listener\);/, '缺 on 注册');
  assert.match(preload, /ipcRenderer\.off\(IPC_CHANNELS\.BRIDGE_SESSIONS_UPSERTED, listener\);/, '缺 off 注销');
});

console.log('\n=== A3-③：session-store 去抖刷新 + 已见集合 ===');
check('markBridgeSessionUpserted：500ms 去抖后 loadSessions（连发合并）', () => {
  const idx = store.indexOf('markBridgeSessionUpserted(');
  assert.ok(idx > -1, '缺 markBridgeSessionUpserted action');
  const body = store.slice(idx, idx + 900);
  assert.match(body, /500/, '去抖窗应为 500ms');
  assert.match(body, /setTimeout/, '缺 setTimeout 去抖');
  assert.match(body, /loadSessions\(\)/, '去抖后未重拉列表');
  assert.match(body, /clearTimeout/, '连发信号未合并（缺 clearTimeout）');
});
check('knownSessionIds 播种单点：loadSessions 全量 + 物化入库 + 守卫放行（use-chat）', () => {
  assert.match(store, /knownSessionIds/, 'session-store 缺 knownSessionIds 状态');
  const loadIdx = store.indexOf('async loadSessions()');
  const loadBody = store.slice(loadIdx, store.indexOf('patchSessionInLists', loadIdx));
  assert.match(loadBody, /knownSessionIds\[s\.id\] = true|knownSessionIds\[s\.id\]=true/, 'loadSessions 未播种已见集合');
  const matIdx = store.indexOf('this.sessions.unshift(session);');
  assert.ok(matIdx > -1, '未定位到物化入库 unshift');
  assert.match(store.slice(matIdx, matIdx + 200), /knownSessionIds\[session\.id\] = true/, '物化入库未播种已见集合');
});

console.log('\n=== A3-④：use-chat 幽灵守卫收窄（已见消失才丢，未见放行） ===');
check('守卫：knownSessionIds 命中（已删除）仍丢弃；未见则登记放行进 handleBackgroundEvent', () => {
  const guardIdx = useChat.indexOf('if (!store.sessions.some((s) => s.id === payload.sessionId)) {');
  assert.ok(guardIdx > -1, '守卫未改为块级两态判定');
  const guardBody = useChat.slice(guardIdx, useChat.indexOf('handleBackgroundEvent(payload);', guardIdx));
  assert.match(guardBody, /if \(store\.knownSessionIds\[payload\.sessionId\]\) return;/, '已见（已删除）分支缺丢弃');
  assert.match(guardBody, /store\.knownSessionIds\[payload\.sessionId\] = true;/, '未见分支缺登记');
  // 登记必须在 handleBackgroundEvent 之前（先登记再放行）
  const seedIdx = guardBody.indexOf('store.knownSessionIds[payload.sessionId] = true;');
  assert.ok(seedIdx > -1, '登记缺失');
});

console.log('\n=== A3-⑤：App.vue 全局接线（订阅 + 卸载清理） ===');
check('App.vue 订阅 onBridgeSessionsUpserted → markBridgeSessionUpserted，onBeforeUnmount 清理', () => {
  assert.match(app, /onBridgeSessionsUpserted\(\(payload\) => \{\s*sessionStore\.markBridgeSessionUpserted\(payload\.sessionId\);/, '缺订阅接线');
  assert.match(app, /stopBridgeSessionsUpserted/, '缺订阅句柄');
  const unmountIdx = app.indexOf('onBeforeUnmount(');
  assert.ok(unmountIdx > -1 && /if \(stopBridgeSessionsUpserted\) stopBridgeSessionsUpserted\(\);/.test(app.slice(unmountIdx)), '卸载缺清理');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
