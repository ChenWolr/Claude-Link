// tdd-background-tray-verify.ts
// 「离开会话后通知」+「后台运行（最小化到托盘）」两个配置开关的接线契约测试。
// 纯源码契约（readFileSync 钉住跨文件不变量），不 import Electron、不启动窗口——
// 托盘/close 事件是主进程运行时行为，纯 Node 无法真正创建 Tray，故用字符串级契约
// 验证「配置形状 → 主进程守卫 → 托盘菜单 → 打包资源 → 设置页 UI」整条链的接线正确。
// 运行：npx tsx scripts/tdd-background-tray-verify.ts
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

const configTypes = readRel('src/shared/types/config.ts');
const configManager = readRel('src/main/modules/config-manager.ts');
const configStore = readRel('src/renderer/stores/config-store.ts');
const configPage = readRel('src/renderer/pages/ConfigPage.vue');
const indexMain = readRel('src/main/index.ts');
const sessionNotif = readRel('src/shared/session-notification.ts');
const notifier = readRel('src/main/modules/session-completion-notifier.ts');
const builder = readRel('electron-builder.json5');

console.log('\n=== 1) AppConfig 公开形状含两个布尔开关 ===');
check('AppConfig 声明 notifyOnLeave: boolean', configTypes.includes('notifyOnLeave: boolean'));
check('AppConfig 声明 minimizeToTray: boolean', configTypes.includes('minimizeToTray: boolean'));

console.log('\n=== 2) 主进程 config-manager：默认值 + getConfig 回读 ===');
check('defaultConfig 默认 notifyOnLeave=true（保留既有通知行为）', configManager.includes('notifyOnLeave: true,'));
check('defaultConfig 默认 minimizeToTray=false（关闭即退出，不破坏现状）', configManager.includes('minimizeToTray: false,'));
check('getConfig 回读 notifyOnLeave（?? true 兜底脏值/旧库）', configManager.includes('notifyOnLeave: config.notifyOnLeave ?? true,'));
check('getConfig 回读 minimizeToTray（?? false 兜底脏值/旧库）', configManager.includes('minimizeToTray: config.minimizeToTray ?? false,'));

console.log('\n=== 3) renderer config-store 默认形状与主进程一致 ===');
check('config-store defaultConfig 含 notifyOnLeave: true', configStore.includes('notifyOnLeave: true,'));
check('config-store defaultConfig 含 minimizeToTray: false', configStore.includes('minimizeToTray: false,'));

console.log('\n=== 4) 设置页 UI：两个勾选项 + 自动保存字段 ===');
check('PERSISTED_FIELDS 纳入 notifyOnLeave 与 minimizeToTray（自动保存）', configPage.includes("'notifyOnLeave', 'minimizeToTray',"));
check('通知开关 checkbox 绑定 store.config.notifyOnLeave', configPage.includes('v-model="store.config.notifyOnLeave"'));
check('后台运行 checkbox 绑定 store.config.minimizeToTray', configPage.includes('v-model="store.config.minimizeToTray"'));
check('通知开关文案「离开会话后通知」存在', configPage.includes('离开会话后通知'));
check('后台运行文案「后台运行」存在', configPage.includes('后台运行'));

console.log('\n=== 5) 共享通知判定：notifyEnabled 守卫 ===');
check('SessionNotificationContext 声明 notifyEnabled: boolean', sessionNotif.includes('notifyEnabled: boolean'));
check('buildSessionNotification 首道守卫为 notifyEnabled 关闭即返回 null', /if \(!ctx\.notifyEnabled\) return null;/.test(sessionNotif));
check('notifier 从 config-manager 读 getConfig().notifyOnLeave', notifier.includes('notifyEnabled: getConfig().notifyOnLeave'));
check('notifier 导入 getConfig', notifier.includes("import { getConfig } from './config-manager';"));

console.log('\n=== 6) 主进程 index.ts：托盘常驻 + 关闭拦截 + 右键退出 ===');
check('index.ts 导入 Tray 与 nativeImage', indexMain.includes('import { app, BrowserWindow, Menu, Tray, nativeImage } from \'electron\';'));
check('声明托盘句柄 let tray: Tray | null', indexMain.includes('let tray: Tray | null = null;'));
check('声明真正退出标志 let quitting = false', indexMain.includes('let quitting = false;'));
check('启动即同步托盘（createWindow 后调用 syncTrayWithConfig）', /createWindow\(\);[\s\S]{0,200}syncTrayWithConfig\(\);/.test(indexMain));
check('托盘生命周期挂接配置保存回调 onConfigSaved(syncTrayWithConfig)', indexMain.includes('onConfigSaved(syncTrayWithConfig);'));
check('syncTrayWithConfig：开关开→ensureTray（运行中托盘常驻可见）', /function syncTrayWithConfig\(\): void \{[\s\S]{0,120}ensureTray\(\);/.test(indexMain));
check('syncTrayWithConfig：开关关且窗口可见→销毁托盘（tray.destroy）', indexMain.includes('tray.destroy();'));
check('syncTrayWithConfig：窗口藏托盘时保留图标守卫（mainWindow.isVisible()）', /if \(tray && \(!mainWindow \|\| mainWindow\.isVisible\(\)\)\)/.test(indexMain));
check('close 处理器挂到 mainWindow.on(\'close\')', indexMain.includes("mainWindow.on('close', (event) => {"));
check('close 守卫：quitting 或 minimizeToTray 关闭时放行（不拦截）', indexMain.includes('if (quitting || !getConfig().minimizeToTray) return;'));
check('close 拦截：event.preventDefault()', indexMain.includes('event.preventDefault();'));
check('close 拦截：隐藏窗口而非销毁（mainWindow?.hide()）', indexMain.includes('mainWindow?.hide();'));
check('close 拦截：兜底创建托盘（ensureTray()）', indexMain.includes('ensureTray();'));
check('ensureTray 创建 Tray（new Tray(trayIcon())）', indexMain.includes('tray = new Tray(trayIcon());'));
check('托盘菜单含「显示主窗口」', indexMain.includes("label: '显示主窗口'"));
check('托盘菜单含「退出」', indexMain.includes("label: '退出'"));
check('托盘「退出」先置 quitting=true 再 app.quit()（避免 close 拦截到退出）', /quitting = true;[\s\S]{0,40}app\.quit\(\);/.test(indexMain));
check('托盘图标路径按 packaged 区分（process.resourcesPath vs app.getAppPath）', indexMain.includes('app.isPackaged ? process.resourcesPath : app.getAppPath()'));

console.log('\n=== 6b) config-manager：保存后回调（托盘随开关实时增删） ===');
check('config-manager 导出 onConfigSaved 订阅', configManager.includes('export function onConfigSaved('));
// OPT-10/P3-6 同步：saveConfig 增加 getConfigForRenderer 说明与「掩码=不改动」注释后函数体变长，窗口 800→1400（断言语义不变）。
check('saveConfig 末尾触发 emitConfigSaved()', /export function saveConfig[\s\S]{0,1400}emitConfigSaved\(\);[\s\S]{0,60}return getConfig\(\);/.test(configManager));
check('clearConfig 末尾触发 emitConfigSaved()', /export function clearConfig[\s\S]{0,200}emitConfigSaved\(\);[\s\S]{0,60}return getConfig\(\);/.test(configManager));
check('回调异常不扩散（listener try/catch）', /for \(const listener of configSavedListeners\) \{[\s\S]{0,120}catch/.test(configManager));
check('设置页文案提示「开启后托盘图标常驻右下角」', configPage.includes('开启后托盘图标常驻右下角'));

console.log('\n=== 7) 打包：托盘图标资源随包分发 ===');
check('electron-builder 配置 extraResources 拷贝托盘图标', builder.includes('extraResources'));
check('extraResources 源指向 resources/icon.png', builder.includes('from: "resources/icon.png"'));
check('extraResources 目标为 icon.png（落入 process.resourcesPath）', builder.includes('to: "icon.png"'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
