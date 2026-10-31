// tdd-web-access-wiring-verify.ts
// 「网页访问（局域网）」接线契约钉：主进程 handler 注册表（ipc-registry）+ 推送总线
// （push-bus）+ 全量站点替换后的等价重构不变量（P2）+ Web 服务器/信息构建/生命周期接线（P3）。
//
// P2（docs/plans/2026-10-20-web-access-plan.md §3-P2 全部 8 条 + 4a/4b 补充）+ P3 增量补充；
// P5 再增量。全部为纯 node:assert/计数 check 的源码文本/结构断言，不 import Electron。
//
// 覆盖：
//   ① ipc-handlers.ts：ipcMain.handle( 字面归零；regInvokeHandler( 计数以 1) 节计算式断言为准（不在此硬编码）；
//   ② export-image-manager.ts：ipcMain.handle( === 7（EXPORT_RENDER_* 裸注册，天然不可被网页
//      调用）；regInvokeHandler( === 2（EXPORT_IMAGE_START/CANCEL 经注册表）；
//   ③ src/main/** 全目录 webContents.send(IPC_CHANNELS. 字面仅出现在 push-bus.ts
//      （app-updater 用局部 STATE_EVENT 常量不匹配该字面，天然豁免且行为正确）；
//   ④ ipc-registry.ts 导出 invokeFromWeb / regInvokeHandler / listRegisteredChannels；
//      push-bus.ts 导出 initPushBus / getCurrentMainWindow / setWebPushSink / pushToMainWindow；
//   ⑤ index.ts 在 app.whenReady 内、createWindow() 之前 initPushBus(() => mainWindow)；
//   ⑥ SESSIONS_CHANGED 新推送通道三处同步（IPC_CHANNELS 常量 + ClaudeLinkAPI.onSessionsChanged
//      + preload 实现）与 ipc-handlers.ts 三处发射（create/update/delete）；
//   ⑦ CHAT_SEND 在 sendMessage 提交之后补推 persisted_message（结构断言：字面位于 CHAT_SEND
//      handler 段内且序在 sendMessage 调用之后；回滚 catch 分支无第二处补发）；
//   ⑧ export-image-manager 注册形态：registerExportImageHandlers(getMainWindow) 增参 +
//      ipc-handlers 调用点传 () => mainWindow（round-008 R1-F3：模块级 live 变量，防窗口重建
//      闭包过期）+ handler 内 origin = event ? event.sender :
//      getMainWindow()?.webContents ?? null 与 bad-origin 守卫；
//   ⑨ app-updater 广播改形：循环跳过主窗口 + 循环后 pushToMainWindow(STATE_EVENT, state) 一次；
//   ⑩ P3：WEB_ACCESS_* 三通道三处同步 + 注册计数 +3；web-access-server.ts 导出面与安全要点
//      字面（64MiB maxPayload / sha256+timingSafeEqual / 限速 5 次 10 分钟 / 30s 心跳 / bye
//      bad-token close 4001 / Origin 校验 / setWebPushSink 注入 + 最后客户端清 sink /
//      invokeFromWeb 分发 / 0.0.0.0 绑定 / server.on('error') / 403-404-405 / index.html
//      no-cache + nosniff / dev 无产物提示页）；web-access-info.ts URL 含 '#token='（非
//      '?token='）+ qrcode toDataURL + 仅 IPv4；index.ts createWindow 后 sync + will-quit stop；
//      CONFIG_SAVE handler 返回前 sync；config-manager 不反向 import server（防环）。
//   ⑪ P4：main.ts !window.claudeLink 引导 + WEB_CHANNEL_TABLE 键集 === ClaudeLinkAPI 成员集
//      （双向对等）+ App.vue onSessionsChanged 订阅/注销 + session-store handleSessionsChanged
//      + web-bridge hash token/退避/生命周期重试/断线 reject/重连对齐序列。
//   ⑫ P5：ConfigPage「网页访问（局域网）」节——webAccess 保存路径（PERSISTED_FIELDS 快照 +
//      store.config.webAccess 整体替换写）、webAccessGetInfo/RegenerateToken/CopyLink 三调用、
//      requestConfirm 本地二次确认序、状态卡三态（未开启/urls+qrDataUrl/error message）、令牌
//      掩码（前4+****+后4）与「显示」切换、端口 1024–65535 失焦 sanitize、allowedHosts 逗号
//      分隔 + placeholder、安全文案两条、保存后/web tab 激活刷新状态卡；config-store
//      defaultConfig 含 webAccess 默认值。
//   ⑬ round-008 修复钉（R1-F2/F3/F4/F7）：CONFIG_CLEAR 驱动 sync、导出窗注册点改 live 变量、
//      push-bus webSink 转发 try 包裹、SESSION_DELETE 删库结果门控 delete 信号。
//   ⑭ 目录历史跨端同步（2026-10-24 web-sync 计划 §2，正文节 13）：WORKSPACES_CHANGED 三处同步
//      （ipc 常量 + preload on/off 两成员 + web-bridge 表两键）+ ADD/REMOVE 两 handler 发射
//      （=== 2，LIST 不推）+ App.vue 订阅/注销 + SessionToolbar 打开下拉现拉兜底。
//   ⑮ 轮末文件改动两通道（2026-10-26-turn-file-changes 计划 §3.4）：TURN_DIFF_LIST_SUMMARIES /
//      TURN_DIFF_FILE_PATCH 常量 + ClaudeLinkAPI 两成员 + preload 实现 + WEB_CHANNEL_TABLE 两键
//      + ipc-handlers 两 handler 注册（键集对等由 §11.2 双向断言自动覆盖新键）。
//
// 运行：npx tsx scripts/tdd-web-access-wiring-verify.ts（已追加 selftest-static-list.txt 尾部）

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as assert from 'node:assert';

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

const handlers = read('src/main/ipc-handlers.ts');
const mainIndex = read('src/main/index.ts');
const registry = read('src/main/ipc-registry.ts');
const pushBus = read('src/main/modules/push-bus.ts');
const exportManager = read('src/main/modules/export-image-manager.ts');
const appUpdater = read('src/main/modules/app-updater.ts');
const sdkBackend = read('src/main/modules/sdk-backend.ts');
const queueEngine = read('src/main/modules/task-queue-engine.ts');
const interactionPrompts = read('src/main/modules/interaction-prompts.ts');
const bridgeInit = read('src/main/modules/bridge/init.ts');
const ipcTypes = read('src/shared/types/ipc.ts');
const preloadApi = read('src/preload/api.ts');
const turnDiffSrc = read('src/main/modules/turn-diff.ts');

// ── ① ipc-handlers.ts：注册表全量替换 ──
console.log('=== 1) ipc-handlers.ts：ipcMain.handle( → regInvokeHandler( 全量替换 ===');
// 计算式：regInvokeHandler( === 89 = P2 替换后实测 79 + P3 新增 WEB_ACCESS_* 三通道（计划
// §3-P3-4）+ SA-2 回合投影只读查询两通道 CHAT_RUNTIME_SNAPSHOT/CHAT_RUNNING_OVERVIEW
//（计划 2026-10-21「回合投影 + 标题质量」）+ P2 会话置顶 SESSION_SET_PINNED（计划 2026-10-22
// six-issues 点 S4）+ P6 Skill 刷新 COMMANDS_REFRESH_GLOBAL（同计划点 S5，方案 C 同步条）
// + P4 会话命名兜底 SESSION_SET_FALLBACK_NAME（计划 2026-10-24-web-sync §3.2.1-6）
// + 轮末文件改动两通道 TURN_DIFF_*（计划 2026-10-26-turn-file-changes §3.4）
// + FS_OPEN_PATH（2026-10-27 五问题 p3：聊天工具行生成文件打开，绝对路径直达）；
// ipcMain.handle( === 0：注释行无该带括号字面。
check('ipc-handlers.ts ipcMain.handle( 出现次数 === 0', countOccurrences(handlers, 'ipcMain.handle(') === 0,
  `实际 ${countOccurrences(handlers, 'ipcMain.handle(')}`);
check('ipc-handlers.ts regInvokeHandler( 出现次数 === 90', countOccurrences(handlers, 'regInvokeHandler(') === 90,
  `实际 ${countOccurrences(handlers, 'regInvokeHandler(')}`);
check('ipc-handlers.ts 从 ./ipc-registry 导入 regInvokeHandler',
  /import\s*\{[^}]*regInvokeHandler[^}]*\}\s*from\s*'\.\/ipc-registry'/.test(handlers));
check('ipc-handlers.ts 从 ./modules/push-bus 导入 pushToMainWindow',
  /import\s*\{[^}]*pushToMainWindow[^}]*\}\s*from\s*'\.\/modules\/push-bus'/.test(handlers));

// ── ② export-image-manager.ts：7 裸注册 + 2 注册表 ──
console.log('=== 2) export-image-manager.ts：EXPORT_RENDER_* 裸注册豁免 + START/CANCEL 入注册表 ===');
check('export-image-manager.ts ipcMain.handle( === 7（EXPORT_RENDER_*）',
  countOccurrences(exportManager, 'ipcMain.handle(') === 7,
  `实际 ${countOccurrences(exportManager, 'ipcMain.handle(')}`);
check('export-image-manager.ts regInvokeHandler( === 2（EXPORT_IMAGE_START/CANCEL）',
  countOccurrences(exportManager, 'regInvokeHandler(') === 2,
  `实际 ${countOccurrences(exportManager, 'regInvokeHandler(')}`);
check('EXPORT_IMAGE_START 经 regInvokeHandler 注册',
  exportManager.includes('regInvokeHandler(IPC_CHANNELS.EXPORT_IMAGE_START'));
check('EXPORT_IMAGE_CANCEL 经 regInvokeHandler 注册',
  exportManager.includes('regInvokeHandler(IPC_CHANNELS.EXPORT_IMAGE_CANCEL'));
check('registerExportImageHandlers 增参 getMainWindow',
  /export function registerExportImageHandlers\(getMainWindow:\s*\(\)\s*=>\s*BrowserWindow\s*\|\s*null\)/.test(exportManager));
check('handler 内 origin = event ? event.sender : getMainWindow()?.webContents ?? null',
  exportManager.includes('event ? event.sender : getMainWindow()?.webContents ?? null'));
check('origin 空守卫返回 bad-origin',
  /code:\s*'bad-origin'/.test(exportManager));
check('ipc-handlers 调用点传 () => mainWindow（round-008 R1-F3：模块级 live 变量，窗口重建自动跟随）',
  handlers.includes('registerExportImageHandlers(() => mainWindow)') &&
  !handlers.includes('registerExportImageHandlers(() => mainWindowRef)'));

// ── ③ src/main/** 推送字面收口 ──
console.log('=== 3) src/main/** webContents.send(IPC_CHANNELS. 字面仅出现在 push-bus.ts ===');
const mainDir = path.join(repoRoot, 'src', 'main');
const offenders: string[] = [];
const walk = (dir: string): void => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith('.ts')) continue;
    const rel = path.relative(repoRoot, full).split(path.sep).join('/');
    if (rel === 'src/main/modules/push-bus.ts') continue;
    if (read(rel).includes('webContents.send(IPC_CHANNELS.')) offenders.push(rel);
  }
};
walk(mainDir);
check('push-bus.ts 之外零 webContents.send(IPC_CHANNELS. 站点', offenders.length === 0,
  offenders.join(', '));
check('push-bus.ts 是唯一经 webContents 推送的实现点',
  pushBus.includes('webContents.send(channel'));

// ── ④ 注册表与推送总线导出面 ──
console.log('=== 4) ipc-registry / push-bus 导出面 ===');
check('ipc-registry.ts 导出 regInvokeHandler', /export function regInvokeHandler\(/.test(registry));
check('ipc-registry.ts 导出 invokeFromWeb（async）', /export async function invokeFromWeb\(/.test(registry));
check('ipc-registry.ts 导出 listRegisteredChannels', /export function listRegisteredChannels\(/.test(registry));
check('invokeFromWeb 未知通道返回 未知通道 错误', registry.includes('未知通道'));
check('invokeFromWeb 异常 catch 成 { ok:false, error }',
  registry.includes('ok: false, error: e instanceof Error ? e.message : String(e)'));
check('regInvokeHandler 内部 ipcMain.handle 包装并注册进 Map',
  registry.includes('ipcMain.handle(channel, (event, ...args) => handler(event, ...args))') && registry.includes('registry.set(channel, handler)'));
check('invokeFromWeb 查表调用 h(null, ...args)', registry.includes('await h(null, ...args)'));
check('push-bus.ts 导出 initPushBus', /export function initPushBus\(/.test(pushBus));
check('push-bus.ts 导出 getCurrentMainWindow', /export function getCurrentMainWindow\(/.test(pushBus));
check('push-bus.ts 导出 setWebPushSink', /export function setWebPushSink\(/.test(pushBus));
check('push-bus.ts 导出 pushToMainWindow', /export function pushToMainWindow\(/.test(pushBus));
check('pushToMainWindow 窗口判空 + isDestroyed + try-catch 后 send',
  /if\s*\(w\s*&&\s*!w\.isDestroyed\(\)\)/.test(pushBus));
check('pushToMainWindow 发送后调 webSink?.(channel, args)', pushBus.includes('webSink?.(channel, args)'));
check('webSink 转发包 try-catch（sink 侧序列化/发送异常不穿透业务发射点，round-008 R1-F4）',
  /try\s*\{\s*webSink\?\.\(channel,\s*args\);\s*\}\s*catch/.test(pushBus.replace(/\r?\n/g, ' ')));
check('push-bus.ts 不 import 任何业务模块（零相对路径导入，仅 electron）',
  !/from\s*'\.\.?\//.test(pushBus));

// ── ⑤ index.ts initPushBus 接线 ──
console.log('=== 5) index.ts：app.whenReady 内 createWindow() 之前 initPushBus ===');
const initIdx = mainIndex.indexOf('initPushBus(() => mainWindow)');
const createIdx = mainIndex.indexOf('  createWindow();');
const whenReadyIdx = mainIndex.indexOf('app.whenReady()');
check('index.ts 含 initPushBus(() => mainWindow)', initIdx > -1);
check('initPushBus 位于 whenReady 内且先于 createWindow()',
  initIdx > -1 && createIdx > -1 && whenReadyIdx > -1 && initIdx > whenReadyIdx && initIdx < createIdx);
check('index.ts 从 ./modules/push-bus 导入 initPushBus',
  /import\s*\{[^}]*initPushBus[^}]*\}\s*from\s*'\.\/modules\/push-bus'/.test(mainIndex));

// ── ⑥ 推送站点替换（抽验关键文件全量字面归零）──
console.log('=== 6) 推送站点替换：各模块 .webContents.send( 字面归零（app-updater 豁免除外） ===');
check('index.ts 通知导航 CHAT_EVENT 改经 pushToMainWindow',
  !mainIndex.includes('mainWindow.webContents.send(') && mainIndex.includes("pushToMainWindow(IPC_CHANNELS.CHAT_EVENT, { sessionId, event: { type: 'navigate' } })"));
check('sdk-backend.ts 零 .webContents.send( 残留', !sdkBackend.includes('.webContents.send('));
check('task-queue-engine.ts 零 .webContents.send( 残留', !queueEngine.includes('.webContents.send('));
check('interaction-prompts.ts 零 .webContents.send( 残留', !interactionPrompts.includes('.webContents.send('));
check('bridge/init.ts 零 .webContents.send( 残留', !bridgeInit.includes('.webContents.send('));
check('export-image-manager.ts 零 .webContents.send( 与 origin.send( 残留',
  !exportManager.includes('.webContents.send(') && !exportManager.includes('origin.send('));
check('app-updater.ts 循环内跳过主窗口（导出窗口仍直发）',
  /for\s*\(const win of BrowserWindow\.getAllWindows\(\)\)/.test(appUpdater) &&
  /win\s*===\s*current/.test(appUpdater));
check('app-updater.ts 循环结束后 pushToMainWindow(STATE_EVENT, state) 一次',
  countOccurrences(appUpdater, 'pushToMainWindow(STATE_EVENT, state)') === 1);
check('app-updater.ts STATE_EVENT 仍为局部常量（豁免字面正则）',
  appUpdater.includes('const STATE_EVENT = IPC_CHANNELS.APP_UPDATE_STATE_CHANGED;'));
check('sdk-backend 从 ./push-bus 导入 pushToMainWindow',
  /import\s*\{[^}]*pushToMainWindow[^}]*\}\s*from\s*'\.\/push-bus'/.test(sdkBackend));

// ── ⑦ SESSIONS_CHANGED 新推送通道（4a）──
console.log('=== 7) SESSIONS_CHANGED：三处同步 + 三处发射 ===');
check("IPC_CHANNELS 含 SESSIONS_CHANGED: 'sessions:changed'",
  ipcTypes.includes("SESSIONS_CHANGED: 'sessions:changed'"));
check('ClaudeLinkAPI 含 onSessionsChanged 成员（upsert|delete 载荷）',
  /onSessionsChanged:\s*\(callback:\s*\(payload:\s*\{\s*kind:\s*'upsert'\s*\|\s*'delete';\s*sessionId:\s*string\s*\}\)\s*=>\s*void\)\s*=>\s*\(\)\s*=>\s*void;/.test(preloadApi));
check('preload/api.ts 实现 onSessionsChanged（ipcRenderer.on 模式）',
  /onSessionsChanged:\s*\(callback\)\s*=>\s*\{[\s\S]*?ipcRenderer\.on\(IPC_CHANNELS\.SESSIONS_CHANGED,\s*listener\);[\s\S]*?return\s*\(\)\s*=>\s*ipcRenderer\.off\(IPC_CHANNELS\.SESSIONS_CHANGED,\s*listener\);/.test(preloadApi));
// [P4 连带同步 2026-10-24]：新 handler SESSION_SET_FALLBACK_NAME 成功后广播 upsert 一处
//（计划 2026-10-24-web-sync §3.2.1-6「upgradable 才写 + 成功后广播」），发射 4→5（upsert×4 + delete×1）。
check('ipc-handlers.ts 五处 pushToMainWindow(IPC_CHANNELS.SESSIONS_CHANGED 发射（create/update/setPinned/fallback/delete，P4 兜底命名 +1）',
  countOccurrences(handlers, 'pushToMainWindow(IPC_CHANNELS.SESSIONS_CHANGED') === 5,
  `实际 ${countOccurrences(handlers, 'pushToMainWindow(IPC_CHANNELS.SESSIONS_CHANGED')}`);
check("发射形态含 upsert×4 + delete×1（P2 置顶 upsert + P4 兜底命名 upsert）",
  countOccurrences(handlers, "{ kind: 'upsert', sessionId") === 4 &&
  countOccurrences(handlers, "{ kind: 'delete', sessionId") === 1);
// 发射点落位：SESSION_CREATE 物化成功后（return session 之前）、SESSION_UPDATE 成功后
//（return updated ? 之前）、SESSION_DELETE 删库成功后（deleteSession 之后）。
const createSeg = handlers.slice(handlers.indexOf('regInvokeHandler(IPC_CHANNELS.SESSION_CREATE'), handlers.indexOf('regInvokeHandler(IPC_CHANNELS.SESSION_GET'));
check('SESSION_CREATE：SESSIONS_CHANGED(upsert) 发射位于 return session 之前',
  createSeg.includes('pushToMainWindow(IPC_CHANNELS.SESSIONS_CHANGED') &&
  createSeg.indexOf('pushToMainWindow(IPC_CHANNELS.SESSIONS_CHANGED') < createSeg.indexOf('return session;'));
const updateSeg = handlers.slice(handlers.indexOf('IPC_CHANNELS.SESSION_UPDATE,'), handlers.indexOf('IPC_CHANNELS.SESSION_RECORD_TURN_META'));
check('SESSION_UPDATE：SESSIONS_CHANGED(upsert) 发射位于成功后、return updated 之前',
  updateSeg.includes('pushToMainWindow(IPC_CHANNELS.SESSIONS_CHANGED') &&
  updateSeg.indexOf('pushToMainWindow(IPC_CHANNELS.SESSIONS_CHANGED') < updateSeg.indexOf('return updated ?'));
const delStart = handlers.indexOf('regInvokeHandler(IPC_CHANNELS.SESSION_DELETE');
const deleteSeg = handlers.slice(delStart, handlers.indexOf('regInvokeHandler(', delStart + 10));
check('SESSION_DELETE：SESSIONS_CHANGED(delete) 发射位于 deleteSession 成功之后',
  deleteSeg.includes("kind: 'delete'") &&
  deleteSeg.indexOf('sessionRepo.deleteSession(id)') > -1 &&
  deleteSeg.indexOf("kind: 'delete'") > deleteSeg.indexOf('sessionRepo.deleteSession(id)'));
// round-008 R1-F7：delete 信号门控于删库结果（计划 §3-P2-4a「删库成功后」措辞对齐）——
// deleteSession 返回 changes>0 的 boolean，未删到行（重复删/未知 id）不再发信号。
const sessionRepoSrc = read('src/main/database/repositories/session-repo.ts');
check('session-repo deleteSession 返回删库结果 boolean（changes > 0，round-008 R1-F7 依赖）',
  /export function deleteSession\(id: string\): boolean \{[\s\S]*?\.changes > 0;/.test(sessionRepoSrc.replace(/\r?\n/g, ' ')));
check('SESSION_DELETE：delete 信号 if (result) 门控于删库结果（round-008 R1-F7）',
  /const result = sessionRepo\.deleteSession\(id\);[\s\S]*?if \(result\) pushToMainWindow\(IPC_CHANNELS\.SESSIONS_CHANGED, \{ kind: 'delete', sessionId: id \}\);/.test(deleteSeg.replace(/\r?\n/g, ' ')));

// ── ⑧ CHAT_SEND 落库后补推 persisted_message（4b）──
console.log('=== 8) CHAT_SEND：spawn 成功 + sendMessage 提交之后补推 persisted_message ===');
const sendStart = handlers.indexOf('regInvokeHandler(IPC_CHANNELS.CHAT_SEND');
const sendEnd = handlers.indexOf('regInvokeHandler(IPC_CHANNELS.CHAT_ABORT');
assert.ok(sendStart > -1 && sendEnd > sendStart, '未定位 CHAT_SEND handler 段');
const sendSeg = handlers.slice(sendStart, sendEnd);
const submitIdx = sendSeg.indexOf('sendMessage(sessionId, prepared.prompt);');
const persistedIdx = sendSeg.indexOf("type: 'persisted_message'");
const spawnIdx = sendSeg.indexOf('spawned = true;');
check('CHAT_SEND 段内 type: persisted_message 代码字面恰 1 处（回滚 catch 不补发）',
  countOccurrences(sendSeg, "type: 'persisted_message'") === 1,
  `实际 ${countOccurrences(sendSeg, "type: 'persisted_message'")}`);
check('persisted_message 推送位于 spawned = true 与 sendMessage 提交之后',
  spawnIdx > -1 && submitIdx > -1 && persistedIdx > submitIdx && submitIdx > spawnIdx);
check('补推经 pushToMainWindow(CHAT_EVENT, { sessionId, event: { type: persisted_message, message: created } })',
  /pushToMainWindow\(IPC_CHANNELS\.CHAT_EVENT,\s*\{\s*sessionId,\s*event:\s*\{\s*type:\s*'persisted_message',\s*message:\s*created\s*\}\s*,\s*\}\)/.test(sendSeg.replace(/\r?\n/g, ' ')));
// 回滚 catch 分支（同步失败删行路径）不得补发任何推送。
const rollbackIdx = sendSeg.indexOf('} catch (error) {');
const rollbackSeg = sendSeg.slice(rollbackIdx, sendSeg.indexOf('throw error;', rollbackIdx));
check('回滚 catch 分支零 pushToMainWindow（早推会气泡闪现又消失）',
  rollbackIdx > -1 && !rollbackSeg.includes('pushToMainWindow('));
check('发送形态对齐 task-queue-engine.ts:393 先例（{ sessionId, event: { type: persisted_message, message } }）',
  queueEngine.includes("event: { type: 'persisted_message', message: persisted }"));

// ── ⑨ 桌面零行为退化抽查：broadcastProvidersChanged 仍存在（字面名不变）──
console.log('=== 9) 既有函数名保持（影响面最小） ===');
check('broadcastProvidersChanged 函数仍在 ipc-handlers.ts',
  handlers.includes('function broadcastProvidersChanged(): void'));
check('broadcastProvidersChanged 改经 pushToMainWindow',
  /function broadcastProvidersChanged[\s\S]{0,400}pushToMainWindow\(IPC_CHANNELS\.PROVIDERS_CHANGED\)/.test(handlers.replace(/\r?\n/g, ' ')));

// ── ⑩ P3：Web 服务器 + 信息构建 + 生命周期接线 ──
console.log('=== 10) P3：WEB_ACCESS_* 三通道 + web-access-server + web-access-info + 生命周期 ===');
const ipcConst = read('src/shared/types/ipc.ts');
const webServer = read('src/main/modules/web-access/web-access-server.ts');
const webInfo = read('src/main/modules/web-access/web-access-info.ts');
const configManager = read('src/main/modules/config-manager.ts');

// 10.1 三通道常量三处同步
check("IPC_CHANNELS 含 WEB_ACCESS_GET_INFO: 'webAccess:getInfo'", ipcConst.includes("WEB_ACCESS_GET_INFO: 'webAccess:getInfo'"));
check("IPC_CHANNELS 含 WEB_ACCESS_REGENERATE_TOKEN: 'webAccess:regenerateToken'", ipcConst.includes("WEB_ACCESS_REGENERATE_TOKEN: 'webAccess:regenerateToken'"));
check("IPC_CHANNELS 含 WEB_ACCESS_COPY_LINK: 'webAccess:copyLink'", ipcConst.includes("WEB_ACCESS_COPY_LINK: 'webAccess:copyLink'"));
check('ClaudeLinkAPI 含 webAccessGetInfo/webAccessRegenerateToken/webAccessCopyLink 成员',
  /webAccessGetInfo:\s*\(\)\s*=>\s*Promise<WebAccessInfoView>;/.test(preloadApi) &&
  /webAccessRegenerateToken:\s*\(\)\s*=>\s*Promise<\{\s*token:\s*string\s*\}>;/.test(preloadApi) &&
  /webAccessCopyLink:\s*\(url:\s*string\)\s*=>\s*Promise<\{\s*ok:\s*boolean\s*\}>;/.test(preloadApi));
check('preload 实现三方法（invoke 对应通道）',
  preloadApi.includes('ipcRenderer.invoke(IPC_CHANNELS.WEB_ACCESS_GET_INFO)') &&
  preloadApi.includes('ipcRenderer.invoke(IPC_CHANNELS.WEB_ACCESS_REGENERATE_TOKEN)') &&
  preloadApi.includes('ipcRenderer.invoke(IPC_CHANNELS.WEB_ACCESS_COPY_LINK, url)'));
check('ipc-handlers.ts 注册三通道（regInvokeHandler 形态）',
  handlers.includes('regInvokeHandler(IPC_CHANNELS.WEB_ACCESS_GET_INFO') &&
  handlers.includes('regInvokeHandler(IPC_CHANNELS.WEB_ACCESS_REGENERATE_TOKEN') &&
  handlers.includes('regInvokeHandler(IPC_CHANNELS.WEB_ACCESS_COPY_LINK'));

// 10.2 web-access-server.ts 导出面与实现要点
check('web-access-server.ts 导出 syncWebAccessServer', /export function syncWebAccessServer\(/.test(webServer));
check('web-access-server.ts 导出 getWebAccessStatus', /export function getWebAccessStatus\(/.test(webServer));
check('web-access-server.ts 导出 kickAllWebClients', /export function kickAllWebClients\(/.test(webServer));
check('web-access-server.ts 导出 stopWebAccessServer', /export function stopWebAccessServer\(/.test(webServer));
check('web-access-server.ts 导出 WebAccessRuntimeStatus / WebAccessSyncHooks 类型',
  /export type WebAccessRuntimeStatus/.test(webServer) && /export interface WebAccessSyncHooks/.test(webServer));
check('幂等 sync：enabled=false → stop 分支', /enabled[\s\S]{0,40}stopWebAccessServer\(\)/.test(webServer.replace(/\r?\n/g, ' ')) || webServer.includes('stopWebAccessServer()'));
check('token 为空自动生成（randomBytes(24).toString(base64url)）',
  webServer.includes("randomBytes(24).toString('base64url')") || webServer.includes('randomBytes(24).toString("base64url")'));
check('HTTP bind 0.0.0.0', webServer.includes("'0.0.0.0'"));
check('server.on(error) 兜底（EADDRINUSE 等不抛不崩）', /server\.on\('error'/.test(webServer) || /\.on\('error'/.test(webServer));
check('Host 校验失败 → 403', /403/.test(webServer) && webServer.includes('isAllowedHost('));
check('静态未命中 → 404；非 GET/HEAD → 405', webServer.includes('404') && webServer.includes('405'));
check('dev 无构建产物 → 200 提示页（npm run build 文案）', webServer.includes('请先执行 npm run build'));
check('index.html no-cache，其余 max-age=604800, immutable',
  webServer.includes('no-cache') && webServer.includes('max-age=604800, immutable'));
check('X-Content-Type-Options: nosniff', webServer.includes('X-Content-Type-Options'));
check('WebSocketServer noServer + maxPayload 64MiB',
  /noServer:\s*true/.test(webServer) && /maxPayload:\s*64\s*\*\s*1024\s*\*\s*1024/.test(webServer));
check('upgrade 路径非 /ws → destroy', webServer.includes("'/ws'") || webServer.includes('"/ws"'));
check('Origin 校验（缺失放行）', /origin/i.test(webServer));
check('Origin 判定用 URL.origin 全形比对（candidates.has(parsed.origin，候选集带 scheme 全形——防 scheme 错配回退）',
  webServer.includes('candidates.has(parsed.origin'));
check('限速表 5 次 / 10 分钟', /10\s*\*\s*60\s*\*\s*1000/.test(webServer));
check('token 复核 sha256 + timingSafeEqual', webServer.includes("createHash('sha256')") && webServer.includes('timingSafeEqual('));
check('bad-token → bye + close 4001', webServer.includes("'bad-token'") && webServer.includes('4001'));
check('welcome 携带 appVersion + buildRev', /kind:\s*'welcome'/.test(webServer) && webServer.includes('appVersion') && webServer.includes('buildRev'));
check('invoke 分发经 invokeFromWeb + wire 编解码', webServer.includes('invokeFromWeb(') && webServer.includes('decodeWireValue') && webServer.includes('encodeWireValue'));
check('心跳 30s ping / 无 pong terminate', /30\s*\*\s*1000|30_000/.test(webServer) && webServer.includes('.ping(') && webServer.includes('.terminate('));
check('setWebPushSink 注入 + 最后客户端断开清 sink', webServer.includes('setWebPushSink('));
check('kickAllWebClients 发 bye(reason)', webServer.includes("kind: 'bye'") || webServer.includes("kind:'bye'"));

// 10.3 web-access-info.ts：URL hash 形态 + 二维码 + 仅 IPv4
check('web-access-info.ts 导出 buildWebAccessInfo', /export (async )?function buildWebAccessInfo\(/.test(webInfo));
check('URL 含 #token=（hash 片段，非 query）', webInfo.includes('#token='));
check('URL 不含 ?token=（token 不进请求行）', !webInfo.includes('?token='));
check('qrDataUrl 经 qrcode toDataURL', /toDataURL\(/.test(webInfo));
check('仅列 IPv4（非 internal；IPv6 由 allowedHosts+隧道覆盖）', webInfo.includes("'IPv4'") && webInfo.includes('internal'));

// 10.4 生命周期接线
const syncCall = 'syncWebAccessServer(getConfig()';
const createIdxP3 = mainIndex.indexOf('  createWindow();');
const syncIdxP3 = mainIndex.indexOf(syncCall);
check('index.ts 含 syncWebAccessServer(getConfig() 调用', syncIdxP3 > -1);
check('index.ts sync 位于 createWindow() 之后', syncIdxP3 > -1 && createIdxP3 > -1 && syncIdxP3 > createIdxP3);
check("index.ts 含 app.on('will-quit') → stopWebAccessServer()",
  /app\.on\('will-quit'[\s\S]{0,200}stopWebAccessServer\(\)/.test(mainIndex.replace(/\r?\n/g, ' ')));
// CONFIG_SAVE handler 段内：保存成功返回前 sync（位于 return { ...getConfigForRenderer() 之前）。
const saveStartP3 = handlers.indexOf('regInvokeHandler(IPC_CHANNELS.CONFIG_SAVE');
const saveEndP3 = handlers.indexOf('regInvokeHandler(IPC_CHANNELS.CONFIG_CLEAR');
const saveSegP3 = handlers.slice(saveStartP3, saveEndP3);
check('CONFIG_SAVE handler 段内含 syncWebAccessServer 调用', saveSegP3.includes('syncWebAccessServer('));
check('CONFIG_SAVE sync 位于保存返回之前',
  saveSegP3.indexOf('syncWebAccessServer(') < saveSegP3.indexOf('return { ...getConfigForRenderer()'));
// round-008 R1-F2：CONFIG_CLEAR（恢复出厂）同样驱动 sync——clearConfig 返回 getConfig()，
// webAccess 复位 enabled=false → stop 分支踢线停服（驱动点仍在 ipc-handlers.ts 内）。
const clearStartP3 = handlers.indexOf('regInvokeHandler(IPC_CHANNELS.CONFIG_CLEAR');
const clearEndP3 = handlers.indexOf('regInvokeHandler(', clearStartP3 + 10);
const clearSegP3 = clearStartP3 > -1 && clearEndP3 > clearStartP3 ? handlers.slice(clearStartP3, clearEndP3) : '';
check('CONFIG_CLEAR handler 段内驱动 syncWebAccessServer（round-008 R1-F2）',
  clearSegP3.includes('syncWebAccessServer(cfg, webAccessHooks)'));
check('CONFIG_CLEAR sync 位于 return cfg 之前（返回前驱动，round-008 R1-F2）',
  clearSegP3.indexOf('syncWebAccessServer(cfg, webAccessHooks)') > -1 &&
  clearSegP3.indexOf('syncWebAccessServer(cfg, webAccessHooks)') < clearSegP3.indexOf('return cfg;'));
check('hooks 从 mainWindowRef 闭包构造', /getMainWindow:\s*\(\)\s*=>\s*mainWindowRef/.test(handlers) || /getMainWindow:\s*\(\)\s*=>\s*mainWindow\b/.test(handlers));

// 10.5 防环：config-manager 不 import web-access-server；sync 驱动点仅 ipc-handlers 与 index 两文件
check('config-manager.ts 不 import web-access-server（防环）', !configManager.includes('web-access-server'));
const mainDirP3 = path.join(repoRoot, 'src', 'main');
const syncDrivers: string[] = [];
const walkP3 = (dir: string): void => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walkP3(full); continue; }
    if (!entry.name.endsWith('.ts')) continue;
    const rel = path.relative(repoRoot, full).split(path.sep).join('/');
    if (read(rel).includes('syncWebAccessServer(') && !rel.endsWith('web-access-server.ts')) syncDrivers.push(rel);
  }
};
walkP3(mainDirP3);
check('syncWebAccessServer 驱动点仅 ipc-handlers.ts 与 index.ts', syncDrivers.length === 2 && syncDrivers.includes('src/main/ipc-handlers.ts') && syncDrivers.includes('src/main/index.ts'),
  `实际 ${syncDrivers.join(', ')}`);

// ── ⑪ P4：渲染层 web 桥 + 启动引导 + 跨端会话消费 ──
console.log('=== 11) P4：web-bridge + main.ts 引导 + App.vue 订阅 + session-store 消费 ===');
const rendererMain = read('src/renderer/main.ts');
const appVue = read('src/renderer/App.vue');
const sessionStoreSrc = read('src/renderer/stores/session-store.ts');
const webBridge = read('src/renderer/web/web-bridge.ts');

// 11.1 main.ts 异步引导：!window.claudeLink 条件 + 动态 import + 先于 mount
check('main.ts 含 !window.claudeLink 条件', rendererMain.includes('!window.claudeLink'));
check('main.ts 动态 import ./web/web-bridge 并调用 installWebBridge',
  /import\('\.\/web\/web-bridge'\)/.test(rendererMain) && rendererMain.includes('installWebBridge'));
check('installWebBridge 引导位于 createApp(App) mount 之前',
  rendererMain.indexOf('installWebBridge') > -1 &&
  rendererMain.indexOf('installWebBridge') < rendererMain.indexOf('createApp(App)'));

// 11.2 键集对等契约：WEB_CHANNEL_TABLE 键集 === ClaudeLinkAPI 接口成员集（多键/少键均 fail）
// P2 会话置顶（点 S4）新通道 SESSION_SET_PINNED 五处一致性由下方键集对等（表键 ↔ 接口成员）
// + 注册计数断言覆盖（计数以 1) 节 regInvokeHandler( === 90 的计算式断言为准，此处不重复
// 硬编码，防通道增减后再陈旧）；此处再显式钉三字面（ipc 常量 / 表项 / handler 注册）防键集
// 对等被并行改动绕过。
check("IPC_CHANNELS 含 SESSION_SET_PINNED: 'session:setPinned'", ipcConst.includes("SESSION_SET_PINNED: 'session:setPinned'"));
check('WEB_CHANNEL_TABLE 含 setSessionPinned 表项', webBridge.includes('setSessionPinned: IPC_CHANNELS.SESSION_SET_PINNED'));
check('ipc-handlers 注册 SESSION_SET_PINNED handler', handlers.includes('regInvokeHandler(IPC_CHANNELS.SESSION_SET_PINNED'));
// P3（2026-10-27 五问题）：FS_OPEN_PATH 新通道显式三字面钉（同 SESSION_SET_PINNED 先例防漂移）。
check("IPC_CHANNELS 含 FS_OPEN_PATH: 'fs:openPath'", ipcConst.includes("FS_OPEN_PATH: 'fs:openPath'"));
check('WEB_CHANNEL_TABLE 含 fsOpenPath 表项', webBridge.includes('fsOpenPath: IPC_CHANNELS.FS_OPEN_PATH'));
check('ipc-handlers 注册 FS_OPEN_PATH handler', handlers.includes('regInvokeHandler(IPC_CHANNELS.FS_OPEN_PATH'));
const tableStart = webBridge.indexOf('const WEB_CHANNEL_TABLE');
const tableEnd = webBridge.indexOf('\n};', tableStart);
check('web-bridge.ts 含 WEB_CHANNEL_TABLE（Record<keyof ClaudeLinkAPI, string>）',
  tableStart > -1 && /const WEB_CHANNEL_TABLE:\s*Record<keyof ClaudeLinkAPI,\s*string>/.test(webBridge));
const tableBody = tableStart > -1 && tableEnd > tableStart ? webBridge.slice(tableStart, tableEnd) : '';
const tableKeys = [...tableBody.matchAll(/^\s{2}([A-Za-z_$][\w$]*):\s*IPC_CHANNELS\./gm)].map((m) => m[1]);
const ifaceStart = preloadApi.indexOf('export interface ClaudeLinkAPI');
const ifaceEnd = preloadApi.indexOf('export function createApi', ifaceStart);
const ifaceBody = ifaceStart > -1 && ifaceEnd > ifaceStart ? preloadApi.slice(ifaceStart, ifaceEnd) : '';
const apiMembers = [...ifaceBody.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]);
check('ClaudeLinkAPI 成员抽取非空（≥100）且表键无重复',
  apiMembers.length >= 100 && new Set(tableKeys).size === tableKeys.length && tableKeys.length > 0,
  `apiMembers=${apiMembers.length} tableKeys=${tableKeys.length}`);
{
  const missingInTable = apiMembers.filter((k) => !tableKeys.includes(k));
  const extraInTable = tableKeys.filter((k) => !apiMembers.includes(k));
  check('WEB_CHANNEL_TABLE 键集 === ClaudeLinkAPI 成员集（双向对等，多键/少键均 fail）',
    missingInTable.length === 0 && extraInTable.length === 0,
    `表中缺(${missingInTable.length}): ${missingInTable.join(',')}；表中多(${extraInTable.length}): ${extraInTable.join(',')}`);
}

// 11.3 App.vue：onSessionsChanged 全局订阅与注销
check('App.vue 全局订阅 onSessionsChanged → sessionStore.handleSessionsChanged',
  /stopSessionsChanged\s*=\s*window\.claudeLink\.onSessionsChanged\(\(payload\)\s*=>\s*\{[\s\S]{0,120}?sessionStore\.handleSessionsChanged\(payload\)/.test(appVue));
check('App.vue onBeforeUnmount 注销 stopSessionsChanged',
  /if\s*\(stopSessionsChanged\)\s*stopSessionsChanged\(\);/.test(appVue) &&
  appVue.indexOf('onBeforeUnmount(') < appVue.indexOf('stopSessionsChanged();'));

// 11.4 session-store：handleSessionsChanged（500ms 独立去抖 + delete 命中活动会话切暂态）
check('session-store 含 handleSessionsChanged action',
  sessionStoreSrc.includes('handleSessionsChanged('));
{
  const hscStart = sessionStoreSrc.indexOf('handleSessionsChanged(');
  const hscEnd = sessionStoreSrc.indexOf('patchSessionInLists(', hscStart);
  const hscSeg = hscStart > -1 && hscEnd > hscStart ? sessionStoreSrc.slice(hscStart, hscEnd) : '';
  check('handleSessionsChanged 500ms 去抖（独立 sessionsChangedTimer，不复用 bridgeRefreshTimer）',
    hscSeg.includes('500') && hscSeg.includes('sessionsChangedTimer') && !hscSeg.includes('bridgeRefreshTimer'));
  check('delete 命中活动会话先本地切回暂态（不调删除 API）',
    /kind\s*===\s*'delete'/.test(hscSeg) &&
    hscSeg.includes("this.activeSession?.id === sessionId") &&
    hscSeg.includes('startTransientSession()') &&
    !hscSeg.includes('deleteSession'));
  check('upsert 直接 loadSessions（不动选中态）', hscSeg.includes('loadSessions()'));
}

// 11.5 web-bridge 要点：hash token / WS URL / 4001 / 退避 / 生命周期重试 / 断线 reject / 对齐序列
check('web-bridge 导出 installWebBridge（async, Promise<void>）',
  /export async function installWebBridge\(\):\s*Promise<void>/.test(webBridge));
check('web-bridge 从 location.hash 读 #token= → 存 localStorage.clWebToken → replaceState 清除',
  webBridge.includes("location.hash.startsWith('#token=')") &&
  webBridge.includes('history.replaceState(') &&
  webBridge.includes('clWebToken') &&
  webBridge.includes('localStorage'));
check('web-bridge WS URL：protocol 定 wss/ws + /ws?token= + encodeURIComponent',
  /'wss'\s*:\s*'ws'/.test(webBridge) && webBridge.includes('/ws?token=') && webBridge.includes('encodeURIComponent('));
check('web-bridge close 4001 → 清 token 回登录浮层（令牌无效或已更换）',
  webBridge.includes('4001') && webBridge.includes('令牌无效或已更换'));
check('web-bridge 退避表 1/2/4/8/15s（15s 封顶）',
  /\[1000,\s*2000,\s*4000,\s*8000,\s*15000\]/.test(webBridge));
check('web-bridge online / visibilitychange 立即重试监听',
  webBridge.includes("addEventListener('online'") && webBridge.includes('visibilitychange'));
check('web-bridge 断线期间 invoke reject「Web 桥未连接」', webBridge.includes('Web 桥未连接'));
check('web-bridge 重连浮层（连接已断开，正在重连…）', webBridge.includes('正在重连'));
check('web-bridge 重连对齐序列：loadSessions + switchSession 重入 + reconcile 重水合（getPendingInteractions）+ 更新态重拉',
  webBridge.includes('loadSessions()') &&
  webBridge.includes('switchSession(') &&
  webBridge.includes('reconcile()') &&
  webBridge.includes('getUpdateInfo()'));
check('web-bridge on* 本地订阅 + remove*Listener 清空分派（remove 非 Listener 后缀者仍走 invoke）',
  /key\.startsWith\('on'\)/.test(webBridge) &&
  /key\.startsWith\('remove'\)\s*&&\s*key\.endsWith\('Listener'\)/.test(webBridge) &&
  webBridge.includes('removeTask: IPC_CHANNELS.TASK_REMOVE') &&
  webBridge.includes('removeRecentWorkspace: IPC_CHANNELS.WORKSPACE_REMOVE_RECENT'));

// 11.6 round-008 修复钉（R1-F1/F5）：
//   R1-F1——hash 路由（createWebHashHistory）模块求值会把 #token= 归一成 #/token=（vue-router
//   创建期 !historyState.value → replaceState），令牌必须在一切 module script 之前被 index.html
//   <head> 内联前置脚本消费（存 localStorage.clWebToken + replaceState 清地址栏），否则
//   「#token= 免登录直达」在真实浏览器 100% 断裂。三字面钉住前置脚本不被误删；时序断言钉住
//   「先于 module script + window.claudeLink 短路」不被破坏。
const rendererIndexHtml = read('src/renderer/index.html');
check('index.html 前置脚本同含 #token= / history.replaceState / clWebToken 三字面（R1-F1，钉前置脚本不被误删）',
  rendererIndexHtml.includes("'#token='") &&
  rendererIndexHtml.includes('history.replaceState') &&
  rendererIndexHtml.includes('clWebToken'));
check('index.html 前置脚本位于 module script 之前且 window.claudeLink 短路（R1-F1 时序前提）',
  rendererIndexHtml.indexOf('<script>') > -1 &&
  rendererIndexHtml.indexOf('<script type="module"') > rendererIndexHtml.indexOf('<script>') &&
  rendererIndexHtml.indexOf('window.claudeLink') > rendererIndexHtml.indexOf('<script>') &&
  rendererIndexHtml.indexOf('window.claudeLink') < rendererIndexHtml.indexOf('<script type="module"'));
//   R1-F5——生命周期加速监听须在主循环开始前绑定一次：首连失败期 online/visibilitychange 也能
//   跳过当次退避等待；welcome 分支内的原调用删除（调用点恰 1 处且源码序先于 for (;;)）。
check('web-bridge ensureLifecycleRetryListeners() 调用恰 1 处且先于 for (;;) 主循环（R1-F5 源码序断言）',
  countOccurrences(webBridge, 'ensureLifecycleRetryListeners();') === 1 &&
  webBridge.indexOf('ensureLifecycleRetryListeners();') < webBridge.indexOf('for (;;)'));

// ── ⑫ P5：设置页「网页访问」节 + config-store 默认值 ──
console.log('=== 12) P5：ConfigPage「网页访问（局域网）」节 + config-store 默认值 ===');
const configPage = read('src/renderer/pages/ConfigPage.vue');
const configStoreSrc = read('src/renderer/stores/config-store.ts');
const configPageFlat = configPage.replace(/\r?\n/g, ' ');

// 12.1 webAccess 保存路径：进 PERSISTED_FIELDS 快照 → 既有 700ms 防抖自动保存链（§3-P5-2）
check("ConfigPage PERSISTED_FIELDS 含 'webAccess'（写 store.config.webAccess 触发快照自动保存）",
  /PERSISTED_FIELDS = \[[\s\S]*?'webAccess',[\s\S]*?\] as const/.test(configPage));
check('ConfigPage 含 store.config.webAccess = 整体替换写入（脱代理/纯 JSON 形状）',
  /store\.config\.webAccess = \{/.test(configPage));

// 12.2 三 IPC 调用 + requestConfirm 本地二次确认序（不经主进程）
check('ConfigPage 含 webAccessGetInfo 调用', configPage.includes('window.claudeLink.webAccessGetInfo()'));
check('ConfigPage 含 webAccessCopyLink 调用', configPage.includes('window.claudeLink.webAccessCopyLink('));
{
  const regenFnIdx = configPage.indexOf('async function regenerateWebAccessToken');
  const regenFnEnd = configPage.indexOf('\nasync function', regenFnIdx + 10);
  const regenFnEndAlt = configPage.indexOf('\nfunction ', regenFnIdx + 10);
  const endCandidates = [regenFnEnd, regenFnEndAlt].filter((i) => i > regenFnIdx);
  const segEnd = endCandidates.length > 0 ? Math.min(...endCandidates) : configPage.length;
  const regenSeg = regenFnIdx > -1 ? configPage.slice(regenFnIdx, segEnd) : '';
  check('regenerateWebAccessToken 函数存在',
    regenFnIdx > -1 && configPage.includes('window.claudeLink.webAccessRegenerateToken()'));
  check('重新生成令牌先 interactionStore.requestConfirm 本地二次确认（不经主进程），后调 webAccessRegenerateToken',
    regenSeg.includes('interactionStore.requestConfirm(') &&
    regenSeg.indexOf('interactionStore.requestConfirm(') < regenSeg.indexOf('webAccessRegenerateToken()'));
  check('regenerate 后刷新状态卡（refreshWebAccessInfo）', regenSeg.includes('refreshWebAccessInfo()'));
}

// 12.3 状态卡三态：off「未开启」/ running 逐条 urls + 首条二维码 qrDataUrl / error message
check('状态卡 off 文案「未开启」', configPage.includes('未开启'));
check('状态卡 running 逐条列出 urls（v-for）', /v-for="url in webAccessInfo\?\.urls \?\? \[\]"/.test(configPage));
check('首条 URL 带二维码（v-if qrDataUrl 守卫 + img :src）',
  /<img v-if="webAccessInfo\?\.qrDataUrl"[^>]*:src="webAccessInfo\.qrDataUrl"/.test(configPage));
check('running/error 三态经显式 computed 收窄（waRunning/waStatusError，模板不做联合收窄）',
  /const waRunning = computed\(/.test(configPage) && /const waStatusError = computed\(/.test(configPage));
check('状态卡 error 显示 waStatusError.message（含端口）',
  configPage.includes('waStatusError.port') && configPage.includes('waStatusError.message'));

// 12.4 令牌区：掩码 前4+****+后4、「显示」切换本地态
check('令牌掩码前 4 + **** + 后 4（slice(0, 4)…slice(-4)）',
  /slice\(0,\s*4\)[\s\S]{0,12}\*{4}[\s\S]{0,12}slice\(-4\)/.test(configPage));
check('「显示」切换为本地组件态（showWebAccessToken）', configPage.includes('showWebAccessToken'));

// 12.5 端口 1024–65535：失焦夹取走同一 sanitizeWebAccessConfig（主进程同源）
check('端口输入 1024–65535 + 失焦夹取（clampWaPort → sanitizeWebAccessConfig）',
  configPage.includes('sanitizeWebAccessConfig') &&
  /clampWaPort/.test(configPage) && configPage.includes('1024') && configPage.includes('65535'));

// 12.6 「高级」折叠行：allowedHosts 逗号分隔输入 + placeholder 注明隧道/反代域名
check('「高级」折叠行（details.webacc-advanced）', /<details class="webacc-advanced">/.test(configPage));
check('allowedHosts 逗号分隔输入 + placeholder「隧道/反代域名，如 link.example.top」',
  configPage.includes('placeholder="隧道/反代域名，如 link.example.top"'));

// 12.7 安全文案两条（计划 §3-P5-1 原文）
check('安全文案：开启后局域网内持有令牌的设备可完全操控本机 Claude Link（含文件浏览与发送），请仅在可信网络使用',
  configPage.includes('开启后局域网内持有令牌的设备可完全操控本机 Claude Link（含文件浏览与发送），请仅在可信网络使用'));
check('明文 HTTP 提示：仅限可信局域网使用（明文 HTTP）', configPage.includes('仅限可信局域网使用（明文 HTTP）'));

// 12.8 状态卡刷新：保存完成（saved/projection-failed）后重拉 getInfo + web tab 激活重拉
check('watch(saveStatus) saved/projection-failed → refreshWebAccessInfo（保存后状态卡刷新）',
  /watch\(saveStatus,[\s\S]{0,220}refreshWebAccessInfo\(\)/.test(configPageFlat));
check("web tab 激活重拉 getInfo（watch(activeTab) 分支）",
  /tab === 'web'[\s\S]{0,120}refreshWebAccessInfo\(\)/.test(configPageFlat));

// 12.9 新 tab 接线：TabId / TAB_IDS / 导航按钮
check("TabId 联合含 'web'", /type TabId = [^;]*'web'/.test(configPage));
check("TAB_IDS 含 'web'", /const TAB_IDS = \[[^\]]*'web'[^\]]*\] as const;/.test(configPage));
check('导航含「网页访问」tab 按钮（activeTab === \'web\'）',
  /activeTab === 'web'/.test(configPage) && configPage.includes('>网页访问</button>'));

// 12.10 config-store defaultConfig 含 webAccess（渲染层兜底默认值，与主进程同形状）
check('config-store defaultConfig 含 webAccess 默认值（enabled:false/port:WEB_ACCESS_DEFAULT_PORT/allowedHosts:[]）',
  /webAccess:\s*\{\s*enabled:\s*false,\s*port:\s*WEB_ACCESS_DEFAULT_PORT,\s*allowedHosts:\s*\[\]\s*,?\s*\}/.test(configStoreSrc));
check('config-store 从 shared/web-access-protocol 导入 WEB_ACCESS_DEFAULT_PORT',
  /import\s*\{[^}]*WEB_ACCESS_DEFAULT_PORT[^}]*\}\s*from\s*'\.\.\/\.\.\/shared\/web-access-protocol'/.test(configStoreSrc));

// ── ⑬ P2 目录历史跨端同步（docs/plans/2026-10-24-web-sync-directory-naming-export-plan.md §2）：
//   WORKSPACES_CHANGED 新推送通道三处同步（IPC_CHANNELS 常量 + ClaudeLinkAPI on/off 两成员 +
//   WEB_CHANNEL_TABLE 两键）+ ipc-handlers.ts ADD/REMOVE 两 handler 成功返回前发射（=== 2，LIST
//   不推）+ App.vue 全局订阅/注销 + SessionToolbar 打开下拉现拉兜底。对齐 §7 SESSIONS_CHANGED 写法。
console.log('=== 13) WORKSPACES_CHANGED：三处同步 + 两处发射 + App.vue/SessionToolbar 消费 ===');
const sessionToolbar = read('src/renderer/components/chat/SessionToolbar.vue');
check("IPC_CHANNELS 含 WORKSPACES_CHANGED: 'workspaces:changed'",
  ipcTypes.includes("WORKSPACES_CHANGED: 'workspaces:changed'"));
check('ClaudeLinkAPI 含 onWorkspacesChanged 成员（无参回调 → 反注册函数）',
  /onWorkspacesChanged:\s*\(callback:\s*\(\)\s*=>\s*void\)\s*=>\s*\(\)\s*=>\s*void;/.test(preloadApi));
check('ClaudeLinkAPI 含 removeWorkspacesListener 成员',
  /removeWorkspacesListener:\s*\(\)\s*=>\s*void;/.test(preloadApi));
check('preload/api.ts 实现 onWorkspacesChanged（ipcRenderer.on/off 模式照 onProvidersChanged）',
  /onWorkspacesChanged:\s*\(callback\)\s*=>\s*\{\s*const listener = \(\) => callback\(\);\s*ipcRenderer\.on\(IPC_CHANNELS\.WORKSPACES_CHANGED,\s*listener\);\s*return \(\) => ipcRenderer\.off\(IPC_CHANNELS\.WORKSPACES_CHANGED,\s*listener\);/.test(preloadApi.replace(/\r?\n/g, ' ')));
check('preload/api.ts 实现 removeWorkspacesListener（removeAllListeners 形态）',
  preloadApi.includes('removeWorkspacesListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.WORKSPACES_CHANGED)'));
check('WEB_CHANNEL_TABLE 含 onWorkspacesChanged / removeWorkspacesListener 两键（键集对等由 §11.2 钉死）',
  webBridge.includes('onWorkspacesChanged: IPC_CHANNELS.WORKSPACES_CHANGED') &&
  webBridge.includes('removeWorkspacesListener: IPC_CHANNELS.WORKSPACES_CHANGED'));
check('ipc-handlers.ts 两处 pushToMainWindow(IPC_CHANNELS.WORKSPACES_CHANGED 发射（ADD/REMOVE；LIST 不推）',
  countOccurrences(handlers, 'pushToMainWindow(IPC_CHANNELS.WORKSPACES_CHANGED') === 2,
  `实际 ${countOccurrences(handlers, 'pushToMainWindow(IPC_CHANNELS.WORKSPACES_CHANGED')}`);
{
  const addStart = handlers.indexOf('regInvokeHandler(IPC_CHANNELS.WORKSPACE_ADD_RECENT');
  const addEnd = handlers.indexOf('regInvokeHandler(', addStart + 10);
  const addSeg = addStart > -1 && addEnd > addStart ? handlers.slice(addStart, addEnd) : '';
  check('WORKSPACE_ADD_RECENT：WORKSPACES_CHANGED 发射位于 addRecentWorkspace(dir) 之后（成功返回前）',
    addSeg.includes('pushToMainWindow(IPC_CHANNELS.WORKSPACES_CHANGED') &&
    addSeg.indexOf('addRecentWorkspace(dir)') > -1 &&
    addSeg.indexOf('pushToMainWindow(IPC_CHANNELS.WORKSPACES_CHANGED') > addSeg.indexOf('addRecentWorkspace(dir)'));
  const rmStart = handlers.indexOf('regInvokeHandler(IPC_CHANNELS.WORKSPACE_REMOVE_RECENT');
  const rmEnd = handlers.indexOf('regInvokeHandler(', rmStart + 10);
  const rmSeg = rmStart > -1 && rmEnd > rmStart ? handlers.slice(rmStart, rmEnd) : '';
  check('WORKSPACE_REMOVE_RECENT：WORKSPACES_CHANGED 发射位于 removeRecentWorkspace(dir) 之后（删不存在目录仍推送，无害）',
    rmSeg.includes('pushToMainWindow(IPC_CHANNELS.WORKSPACES_CHANGED') &&
    rmSeg.indexOf('removeRecentWorkspace(dir)') > -1 &&
    rmSeg.indexOf('pushToMainWindow(IPC_CHANNELS.WORKSPACES_CHANGED') > rmSeg.indexOf('removeRecentWorkspace(dir)'));
}
check('App.vue 全局订阅 onWorkspacesChanged → sessionStore.loadRecentWorkspaces（信号型重拉，幂等）',
  /stopWorkspacesChanged\s*=\s*window\.claudeLink\.onWorkspacesChanged\(\(\)\s*=>\s*\{\s*void sessionStore\.loadRecentWorkspaces\(\);/.test(appVue.replace(/\r?\n/g, ' ')));
check('App.vue onBeforeUnmount 注销 stopWorkspacesChanged',
  /if\s*\(stopWorkspacesChanged\)\s*stopWorkspacesChanged\(\);/.test(appVue) &&
  appVue.indexOf('onBeforeUnmount(') < appVue.indexOf('stopWorkspacesChanged();'));
check('SessionToolbar 目录按钮改 toggleWorkspaceMenu()（裸布尔翻转字面移除）',
  sessionToolbar.includes('@click="toggleWorkspaceMenu()"') &&
  !sessionToolbar.includes('@click="showWorkspaceMenu = !showWorkspaceMenu"'));
check('SessionToolbar toggleWorkspaceMenu：打开时现拉 loadRecentWorkspaces（断线错过推送的兜底）',
  /function toggleWorkspaceMenu\(\): void \{\s*showWorkspaceMenu\.value = !showWorkspaceMenu\.value;\s*(?:\/\/[^\r\n]*\s*)?if \(showWorkspaceMenu\.value\) void sessionStore\.loadRecentWorkspaces\(\);/.test(sessionToolbar));
check('ClaudeLinkAPI 成员集含 onWorkspacesChanged / removeWorkspacesListener（apiMembers 抽取闭环，下限断言 ≥100 不变）',
  apiMembers.includes('onWorkspacesChanged') && apiMembers.includes('removeWorkspacesListener') && apiMembers.length >= 100);

// ── ⑮ 轮末文件改动两通道（docs/plans/2026-10-26-turn-file-changes-diff-and-web-changes-fix-plan §3.4）──
console.log('=== 15) TURN_DIFF_*：轮末文件改动两通道三处同步 ===');
check("IPC_CHANNELS 含 TURN_DIFF_LIST_SUMMARIES: 'turnDiff:listSummaries'",
  ipcTypes.includes("TURN_DIFF_LIST_SUMMARIES: 'turnDiff:listSummaries'"));
check("IPC_CHANNELS 含 TURN_DIFF_FILE_PATCH: 'turnDiff:filePatch'",
  ipcTypes.includes("TURN_DIFF_FILE_PATCH: 'turnDiff:filePatch'"));
check('ClaudeLinkAPI 含 listTurnDiffSummaries / getTurnFilePatch 成员',
  /listTurnDiffSummaries:\s*\(sessionId:\s*string\)\s*=>\s*Promise<import\('\.\.\/shared\/types\/turn-file-diff'\)\.TurnFileDiffTurnSummary\[\]>;/.test(preloadApi) &&
  /getTurnFilePatch:\s*\(sessionId:\s*string,\s*turnStartMessageId:\s*string,\s*endMessageId:\s*string\s*\|\s*null,\s*path:\s*string,\s*context\?:\s*number\)/.test(preloadApi));
check('preload 实现两方法（invoke 对应通道）',
  preloadApi.includes('ipcRenderer.invoke(IPC_CHANNELS.TURN_DIFF_LIST_SUMMARIES, sessionId)') &&
  preloadApi.includes('IPC_CHANNELS.TURN_DIFF_FILE_PATCH, sessionId, turnStartMessageId, endMessageId, path, context ?? 3'));
check('WEB_CHANNEL_TABLE 含 listTurnDiffSummaries / getTurnFilePatch 两键（键集对等由 §11.2 双向断言自动覆盖）',
  webBridge.includes('listTurnDiffSummaries: IPC_CHANNELS.TURN_DIFF_LIST_SUMMARIES') &&
  webBridge.includes('getTurnFilePatch: IPC_CHANNELS.TURN_DIFF_FILE_PATCH'));
check('ipc-handlers 注册 TURN_DIFF 两通道（regInvokeHandler 形态）',
  handlers.includes('regInvokeHandler(IPC_CHANNELS.TURN_DIFF_LIST_SUMMARIES') &&
  handlers.includes('regInvokeHandler(IPC_CHANNELS.TURN_DIFF_FILE_PATCH'));
check('ipc-handlers TURN_DIFF_FILE_PATCH 第 5 参 context: unknown + 钳制 1..100000 否则 3（2026-10-30 意图 diff 计划 §2.3）',
  handlers.includes('path: unknown, context: unknown') &&
  handlers.includes('context >= 1 && context <= 100000 ? context : 3'));
check('turn-diff getPatch/computeFileDiff 声明含 context 默认参（context = 3 ≥ 2 处）',
  countOccurrences(turnDiffSrc, 'context = 3') >= 2);

console.log(`\n[P2+P3+P4+P5 接线契约] 通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
