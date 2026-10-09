// tdd-app-updater-verify.ts
// 应用内检查更新（electron-updater / GitHub Releases）接线契约测试。
// 纯源码契约（readFileSync 钉住跨文件不变量），不 import Electron、不启动窗口——
// electron-updater 的 checkForUpdates/quitAndInstall 是主进程运行时行为，纯 Node 无法真跑，
// 用字符串级契约验证「publish 配置 → 类型/通道 → 主进程模块 → 接线 → preload 桥 → 设置页 UI」
// 整条链的接线正确。运行：npx tsx scripts/tdd-app-updater-verify.ts（已登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(section: string, name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✅ [${section}] ${name}`);
  } else {
    fail++;
    console.log(`  ❌ [${section}] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function readRel(p: string): string {
  const fs = require('node:fs');
  const nodePath = require('node:path');
  const abs = nodePath.resolve(__dirname, '..', p);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8');
}

const builder = readRel('electron-builder.json5');
const pkg = readRel('package.json');
const updateTypes = readRel('src/shared/types/update.ts');
const ipcTypes = readRel('src/shared/types/ipc.ts');
const updaterModule = readRel('src/main/modules/app-updater.ts');
const ipcHandlers = readRel('src/main/ipc-handlers.ts');
const indexMain = readRel('src/main/index.ts');
const preloadApi = readRel('src/preload/api.ts');
const configPage = readRel('src/renderer/pages/ConfigPage.vue');
const updateStore = readRel('src/renderer/stores/update-store.ts');
const appVue = readRel('src/renderer/App.vue');
const selftestList = readRel('scripts/selftest-static-list.txt');
const serveFeed = readRel('scripts/serve-update-feed.mjs');
const updateE2e = readRel('scripts/cdp-update-e2e.mjs');

console.log('\n=== 1) 打包发布配置（latest.yml 生成前提） ===');
check('1', 'electron-builder.json5 含 publish github ChenWolr/Claude-Link',
  /provider:\s*"github"/.test(builder) && /owner:\s*"ChenWolr"/.test(builder) && /repo:\s*"Claude-Link"/.test(builder));
check('1', 'package.json dependencies 含 electron-updater',
  /"electron-updater":\s*"\^6\.8\.3"/.test(pkg));
check('1', 'package:win 保持 --publish never（只构建不上传，发版手动传资产；2026-10-09 起内含 npm run build 前置防陈旧 out/ 上包）',
  pkg.includes('"package:win": "npm run build && electron-builder --win --publish never"'));

console.log('\n=== 2) 共享类型与 IPC 通道 ===');
check('2', 'AppUpdateStatus 九态齐全',
  updateTypes.includes("'unavailable'") && updateTypes.includes("'idle'") && updateTypes.includes("'checking'")
  && updateTypes.includes("'available'") && updateTypes.includes("'downloading'") && updateTypes.includes("'downloaded'")
  && updateTypes.includes("'installing'") && updateTypes.includes("'error'") && updateTypes.includes("'latest'"));
check('2', 'AppUpdateState 六字段（status/newVersion/latestVersion/releaseNotes/progress/error）',
  updateTypes.includes('status: AppUpdateStatus') && updateTypes.includes('newVersion: string | null')
  && updateTypes.includes('latestVersion: string | null')
  && updateTypes.includes('releaseNotes: string | null') && updateTypes.includes('progress: AppUpdateProgress | null')
  && updateTypes.includes('error: string | null'));
check('2', 'AppUpdateInfo = { currentVersion, state }',
  updateTypes.includes('currentVersion: string') && updateTypes.includes('state: AppUpdateState'));
check('2', 'IPC_CHANNELS 四通道',
  ipcTypes.includes("APP_UPDATE_GET_INFO: 'appUpdate:getInfo'") && ipcTypes.includes("APP_UPDATE_CHECK: 'appUpdate:check'")
  && ipcTypes.includes("APP_UPDATE_INSTALL: 'appUpdate:install'") && ipcTypes.includes("APP_UPDATE_STATE_CHANGED: 'appUpdate:stateChanged'"));

console.log('\n=== 3) 主进程模块 modules/app-updater.ts ===');
check('3', 'GitHub feed：owner/repo 常量 + setFeedURL',
  updaterModule.includes("const GITHUB_OWNER = 'ChenWolr'") && updaterModule.includes("const GITHUB_REPO = 'Claude-Link'")
  && updaterModule.includes('provider: \'github\''));
check('3', '测试缝：CLAUDE_LINK_UPDATE_FEED_URL 指向 generic feed（尾斜杠归一）',
  updaterModule.includes('CLAUDE_LINK_UPDATE_FEED_URL') && updaterModule.includes("provider: 'generic'"));
check('3', 'autoDownload=false / autoInstallOnAppQuit=false / disableDifferentialDownload=true',
  updaterModule.includes('autoUpdater.autoDownload = false') && updaterModule.includes('autoUpdater.autoInstallOnAppQuit = false')
  && updaterModule.includes('autoUpdater.disableDifferentialDownload = true'));
check('3', '开发模式守卫 !app.isPackaged',
  updaterModule.includes('!app.isPackaged'));
check('3', '下载前磁盘检查 ≥500MB（fs.promises.statfs）',
  updaterModule.includes('fs.promises.statfs') && updaterModule.includes('MIN_FREE_DISK_MB = 500'));
check('3', 'quitAndInstall 参数：win32 非静默 + 装完自启',
  updaterModule.includes('autoUpdater.quitAndInstall(process.platform !== \'win32\', true)'));
check('3', 'latest.yml 缺失（404）视为无更新而非报错（R2-F7 加钉：匹配器第二子句 + 双路消费点）',
  updaterModule.includes('/(cannot find|not found|missing|404)/i')
  && (updaterModule.match(/isMissingLatestMetadataError\(message\)/g) || []).length >= 2);
check('3', '状态广播走 APP_UPDATE_STATE_CHANGED 通道',
  updaterModule.includes('IPC_CHANNELS.APP_UPDATE_STATE_CHANGED'));
check('3', 'install 幂等守卫（非 downloaded 拒绝 + _installPromise 去重）',
  updaterModule.includes('_installPromise') && updaterModule.includes("getUpdateState().status !== 'downloaded'"));
check('3', '日志接入 logger',
  updaterModule.includes('autoUpdater.logger') && updaterModule.includes("from '../utils/logger'"));
check('3', 'check 重入守卫：checking/available/downloading 直接返回当前态（R1 按钮常可点后的主进程兜底）',
  updaterModule.includes("['checking', 'available', 'downloading'].includes(getUpdateState().status)"));
check('3', '启动自动检查 scheduleStartupUpdateCheck（R5，延迟 5s）',
  updaterModule.includes('export function scheduleStartupUpdateCheck') && updaterModule.includes('STARTUP_CHECK_DELAY_MS = 5000'));
check('3', 'available/not-available 双处理器捕获 latestVersion（R3）',
  updaterModule.includes('latestVersion: info.version ?? _state.latestVersion')
  && (updaterModule.match(/latestVersion: info\.version \?\? _state\.latestVersion/g) || []).length >= 2);

console.log('\n=== 4) 主进程接线 ===');
check('4', 'ipc-handlers 注册三 handler',
  ipcHandlers.includes('ipcMain.handle(IPC_CHANNELS.APP_UPDATE_GET_INFO') && ipcHandlers.includes('ipcMain.handle(IPC_CHANNELS.APP_UPDATE_CHECK')
  && ipcHandlers.includes('ipcMain.handle(IPC_CHANNELS.APP_UPDATE_INSTALL'));
check('4', 'index.ts whenReady 内 createWindow 后调 initAppUpdater',
  indexMain.includes("from './modules/app-updater'") && indexMain.includes('initAppUpdater(() => mainWindow)')
  && /createWindow\(\);[\s\S]*initAppUpdater/.test(indexMain));
check('4', 'index.ts 调 scheduleStartupUpdateCheck（R5 启动自动检查接线）',
  indexMain.includes('scheduleStartupUpdateCheck();'));

console.log('\n=== 5) preload 桥 ===');
check('5', '接口五成员（getUpdateInfo/checkForAppUpdate/installAppUpdate/onUpdateStateChanged/removeUpdateStateListener）',
  preloadApi.includes('getUpdateInfo: () => Promise<AppUpdateInfo>') && preloadApi.includes('checkForAppUpdate: () => Promise<AppUpdateState>')
  && preloadApi.includes('installAppUpdate: () => Promise<boolean>') && preloadApi.includes('onUpdateStateChanged: (callback: (state: AppUpdateState) => void) => () => void')
  && preloadApi.includes('removeUpdateStateListener: () => void'));
check('5', '实现绑定到对应通道',
  preloadApi.includes('ipcRenderer.invoke(IPC_CHANNELS.APP_UPDATE_GET_INFO)') && preloadApi.includes('ipcRenderer.invoke(IPC_CHANNELS.APP_UPDATE_CHECK)')
  && preloadApi.includes('ipcRenderer.invoke(IPC_CHANNELS.APP_UPDATE_INSTALL)') && preloadApi.includes('ipcRenderer.on(IPC_CHANNELS.APP_UPDATE_STATE_CHANGED, listener)')
  && preloadApi.includes('ipcRenderer.removeAllListeners(IPC_CHANNELS.APP_UPDATE_STATE_CHANGED)'));
check('5', 'api.ts 头注释方法数 77→82 同步',
  preloadApi.includes('82 个方法'));

console.log('\n=== 6) 设置页关于 tab ===');
check('6', 'TabId 联合类型含 about',
  configPage.includes("'im' | 'about'"));
check('6', '导航按钮关于',
  configPage.includes(`activeTab === 'about'`) && configPage.includes('>关于</button>'));
check('6', '关于块 v-show + 版本/按钮 testid',
  configPage.includes(`v-show="activeTab === 'about'"`) && configPage.includes('data-testid="about-version"')
  && configPage.includes('data-testid="about-check-btn"') && configPage.includes('data-testid="about-install-btn"'));
check('6', '开发模式提示文案',
  configPage.includes('开发模式下不可用'));
check('6', '订阅单主化：update-store 是渲染层唯一 onUpdateStateChanged 订阅者',
  updateStore.includes('window.claudeLink.onUpdateStateChanged'));
check('6', '订阅单主化：App.vue onMounted 全局 init 一次',
  appVue.includes('updateStore.init()'));
check('6', '订阅单主化：ConfigPage 不再直接订阅（负向，removeUpdateStateListener 互踩点消除）',
  !configPage.includes('onUpdateStateChanged') && !configPage.includes('removeUpdateStateListener'));
check('6', '最新版本行 testid（R3）',
  configPage.includes('data-testid="about-latest-version"'));

console.log('\n=== 7) 修复轮 R1：F1 精确选包 / F2 错误归一 / F3 按 PID 清理 ===');
check('7', 'feed 按 package.json 版本精确选包（防目录序选中旧包）',
  serveFeed.includes('`claude-link-${pkgVersion}-setup.exe`') && serveFeed.includes('现存候选'));
check('7', '无匹配包时报错退出并列出候选',
  serveFeed.includes('process.exit(2)') && serveFeed.includes('先 npm run package:win'));
check('7', '错误文案归一 friendlyCheckErrorMessage（零发布/prerelease 双形态）',
  updaterModule.includes('function friendlyCheckErrorMessage') && updaterModule.includes('No published versions on GitHub')
  && updaterModule.includes('please ensure a production release exists'));
check('7', 'check/download 失败消费点走归一（≥2 处）',
  (updaterModule.match(/friendlyCheckErrorMessage\(/g) || []).length >= 3);
check('7', 'E2E 按 PID 树杀、无同名 taskkill',
  updateE2e.includes("'/PID', String(appProc.pid), '/T', '/F'") && !updateE2e.includes("'/IM', 'claude-link.exe'"));

console.log('\n=== 8) 契约链登记 ===');
check('8', 'selftest-static-list.txt 已登记本脚本',
  selftestList.includes('scripts/tdd-app-updater-verify.ts'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
