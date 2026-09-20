import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { closeConnection, getConnection } from './database/connection';
import { runMigrations } from './database/migrations';
import { registerIpcHandlers } from './ipc-handlers';
import { detectCli } from './modules/cli-detector';
import { ensureProviderMigration, getConfig, onConfigSaved } from './modules/config-manager';
import { killAllProcesses, runGlobalCommandProbe, cancelGlobalCommandProbe, cancelAllCommandProbes, cancelAllPostTurnProbes, effectiveUserHome } from './modules/sdk-backend';
import { startCommandSourceWatcher, stopCommandSourceWatcher } from './modules/command-source-watcher';
import * as taskRepo from './database/repositories/task-repo';
import { logger } from './utils/logger';
import {
  WINDOW_DEFAULT_WIDTH,
  WINDOW_DEFAULT_HEIGHT,
  WINDOW_MIN_WIDTH,
  WINDOW_MIN_HEIGHT,
  IPC_CHANNELS,
} from '../shared/constants';
import { loadWindowSize, trackWindowSize } from './modules/window-state';
import { setupLinkGuard } from './modules/link-guard';
import { cleanupStaleTempDirs, disposeExportTempDirsSync } from './modules/export-image-manager';
import { runExportSmokeIfRequested } from './modules/export-image-smoke';
import { cleanupOrphanAttachments, reconcileDraftAttachments } from './modules/attachment-service';
import { setNotificationFocusHook } from './modules/session-completion-notifier';
import { cancelAllPendingInteractions, pendingInteractionCount, setInteractionCountChangedHook } from './modules/interaction-prompts';

if (process.env.CLAUDE_LINK_EXPORT_SMOKE) {
  // hb10-SHL-10：smoke userData 根可配置（CLAUDE_LINK_SMOKE_ROOT），换机可跑；缺省保留原根。
  const smokeRoot = process.env.CLAUDE_LINK_SMOKE_ROOT || 'D:\\software\\Cache';
  const smokeUserDataDir = join(smokeRoot, `claude-link-smoke-${process.pid}-${randomUUID()}`);
  app.setPath('userData', smokeUserDataDir);
}

// hb10 P2-5：单实例锁——双实例并行会双写同一 SQLite（锁冲突/损坏），且导出临时目录清理
// （disposeExportTempDirsSync/cleanupStaleTempDirs）会跨实例互删对方在用的目录。
// 锁按 userData 作用域：dev 与打包同锁；隔离实例（--user-data-dir）天然不受影响。
// 锁失败（已有实例）→ 立即 quit，且 whenReady 主体被守卫包裹（runMigrations 不得触达）。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = mainWindow;
    if (w && !w.isDestroyed()) {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }
  });
}

let mainWindow: BrowserWindow | null = null;
// 托盘（后台运行模式）。minimizeToTray 开启时随启动/配置保存同步创建，常驻可见——
// 运行中即可在右下角看到入口，而不是关窗后才出现；右键菜单提供「显示主窗口」与「退出」
// 两项——退出是真正结束进程的唯一入口（当 minimizeToTray 开时）。
let tray: Tray | null = null;
// 正在真正退出的标志：托盘「退出」置 true 后，close 处理器不再拦截（避免最小化拦截到 app.quit）。
let quitting = false;

function trayIcon(): Electron.NativeImage {
  // dev：icon.png 位于项目根 resources/，app.getAppPath() + 'resources/icon.png' 可命中。
  // packaged：extraResources 的 to: "icon.png" 相对 resources 根（app-builder-lib 源码证实）——
  // 实际落点 <resourcesPath>/icon.png，并无 resources/ 子目录；hb10 P2-15 修复运行时查找路径
  // 与实际落点一致（原 join 拼出 <resourcesPath>/resources/icon.png 必落 createEmpty()，打包托盘空白）。
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
  const icon = nativeImage.createFromPath(app.isPackaged ? join(base, 'icon.png') : join(base, 'resources', 'icon.png'));
  if (!icon.isEmpty()) {
    return icon.resize({ width: 16, height: 16 });
  }
  return nativeImage.createEmpty();
}

function showMainWindow(): void {
  // hb12-SHL-02：isDestroyed 短路（closed 置 null 兜底 + 悬垂引用防御）。
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function ensureTray(): void {
  if (tray) return;
  tray = new Tray(trayIcon());
  tray.setToolTip('Claude Link');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  // 左键单击/双击都显示主窗口（右键已由 setContextMenu 弹出菜单）。
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
  // hb10-PERM-05：托盘 pending 弹窗提示——数量变化时更新 tooltip（后台弹窗可见性）。
  updateTrayPendingHint();
  logger.info('托盘图标已创建');
}

// hb10-PERM-05：托盘 tooltip 追加 ⏳ 计数（0 项时显示基础文案）。
function updateTrayPendingHint(): void {
  if (!tray) return;
  const n = pendingInteractionCount();
  tray.setToolTip(n > 0 ? `Claude Link（⏳ ${n} 项待确认）` : 'Claude Link');
}

// 托盘生命周期跟随 minimizeToTray 开关：开启 → 常驻（启动时与设置页保存后各同步一次）；
// 关闭 → 撤掉图标。例外：开关为关但主窗口仍藏在托盘里（外部改配置文件等场景）时保留
// 图标，否则程序失去唯一入口——窗口可见（设置页里正常切换；或 mainWindow 尚未创建的
// 防御半边）才会走到销毁分支。
function syncTrayWithConfig(): void {
  if (getConfig().minimizeToTray) {
    ensureTray();
    return;
  }
  // hb12-SHL-02：mainWindow 悬垂/已销毁防御（isVisible 前先 isDestroyed）。
  const goneOrVisible = !mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible();
  if (tray && goneOrVisible) {
    tray.destroy();
    tray = null;
    logger.info('托盘图标已移除');
  }
}

function createWindow(): void {
  const size = loadWindowSize();
  mainWindow = new BrowserWindow({
    width: size?.width ?? WINDOW_DEFAULT_WIDTH,
    height: size?.height ?? WINDOW_DEFAULT_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    center: true,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // hb12-SHL-02：窗口关闭即置 null——托盘点击/focusHook 等触点不再解引用悬垂引用。
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
    if (process.platform === 'win32') {
      Menu.setApplicationMenu(null);
    }
  });

  // 后台运行模式：minimizeToTray 开启且非真正退出时，关闭窗口改为隐藏到托盘，不退出进程。
  // ensureTray 作兜底（正常路径下开关开启时托盘早已由 syncTrayWithConfig 常驻创建）。
  mainWindow.on('close', (event) => {
    if (quitting || !getConfig().minimizeToTray) return;
    event.preventDefault();
    mainWindow?.hide();
    ensureTray();
  });

  // hb12-SHL-01：渲染崩溃自动恢复——非 clean-exit 计数式 reload（同窗口限 2 次防循环），
  // 超限 dialog 提示后由用户选择 relaunch 或 quit（hb13-v 批C 措辞纠偏：原「可选销毁」
  // 与实际按钮「重启应用/关闭」不符）。hb13-v A9：cancel 兜底只走「不 reload」分支（clean-exit /
  // 超限）——旧实现在 reload 决策前一律先 cancelAllPendingInteractions()，reload 成功后新
  // 渲染层 GET_PENDING 恒空，「重拉弹窗」双防线名存实亡，且任意渲染崩溃静默取消全部存量
  // 权限弹窗。reload 路径不 cancel：pending 弹窗由新渲染层 GET_PENDING 重新拉起。
  let reloadCount = 0;
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`Renderer process gone: ${details.reason} (${details.exitCode})`);
    if (details.reason === 'clean-exit') {
      cancelAllPendingInteractions();
      return;
    }
    if (reloadCount >= 2) {
      cancelAllPendingInteractions();
      logger.error('[render] reload 超限，弹窗提示用户');
      const { dialog } = require('electron') as typeof import('electron');
      void dialog
        .showMessageBox({
          type: 'error',
          title: '界面进程反复崩溃',
          message: '界面进程多次崩溃，已停止自动恢复。请重启应用；若持续出现请反馈日志。',
          buttons: ['重启应用', '关闭'],
        })
        .then((r) => {
          if (r.response === 0) app.relaunch();
          app.quit();
        })
        .catch(() => {});
      return;
    }
    reloadCount += 1;
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      void mainWindow.webContents.reload();
    }, 300);
  });
  // 渲染层成功加载（did-finish-load）视为恢复成功，重置计数。
  mainWindow.webContents.on('did-finish-load', () => {
    reloadCount = 0;
  });

  setupLinkGuard(mainWindow, is.dev ? process.env.ELECTRON_RENDERER_URL : undefined);
  // P2-18：系统通知点击 → 聚焦主窗（回调注入，避免 notifier → index 循环依赖）。
  // hb12-SHL-03：携带 sessionId——聚焦后经 CHAT_EVENT 导航事件让渲染层切换到对应会话。
  setNotificationFocusHook((sessionId) => {
    showMainWindow();
    if (sessionId && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send(IPC_CHANNELS.CHAT_EVENT, { sessionId, event: { type: 'navigate' } });
      } catch {
        // ignore
      }
    }
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  registerIpcHandlers(mainWindow);
  trackWindowSize(mainWindow);
}

// D3：命令来源监视 + 全局兜底探测的统一启动点（F6）：whenReady 首启与 macOS activate
// 重启共用同一份依赖注入，避免两处漂移。window-all-closed 会停 watcher/取消全局探测，
// mac 重开路径必须在此恢复，否则命令热刷新在本进程剩余生命周期内永久失效。
function startGlobalCommandPipeline(): void {
  if (!mainWindow) return;
  // 启动全局兜底命令探测（无会话绑定）：结果写入 registry.globalFallback，作为重启后旧会话的命令兜底。
  // fire-and-forget；完成时对已打开且命令仍为空的会话回填（含已有 loading/degraded 快照但命令
  // 为空者，见 sdk-backend 回填（N7）注释——不按 has(sid) 判断）。CLI 缺失/失败均不阻塞启动。
  runGlobalCommandProbe(mainWindow);

  // D3：命令来源目录监视——用户级 ~/.claude/{commands,skills} 与项目级 .claude/{commands,skills}
  // 新增/修改/删除 → 指纹变化 → 节流重探热刷新 globalFallback，新会话（含暂态）免重启拿最新命令。
  // app 依赖（effectiveUserHome / workingDirectory / onConfigSaved）在此注入，watcher 模块保持纯 node。
  startCommandSourceWatcher({
    getUserHome: effectiveUserHome,
    getWorkingDirectory: () => getConfig().workingDirectory,
    // 透传幂等结果（true=启动 / false=被吞）：watcher 据此在被吞时延迟重试（review-v1 发现1）。
    triggerGlobalProbe: () => (mainWindow ? runGlobalCommandProbe(mainWindow) : false),
    onConfigSaved,
    logger,
  });
}

app.whenReady().then(async () => {
  // hb10 P2-5：锁失败路径不执行任何初始化（runMigrations 不触达 DB，防双写）。
  if (!gotLock) return;

  electronApp.setAppUserModelId('com.clauedelink.app');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  try {
    // Initialize database
    runMigrations(getConnection());

    // 多供应商库一次性迁移：老单供应商配置 → ProviderProfile（幂等，键存在即跳过）。
    ensureProviderMigration();

    // Reset any tasks that were running when app was closed
    // (since their processes died with the app)
    taskRepo.resetRunningTasks();

    // 清理上次强退残留的导出临时目录（> 24h）。
    cleanupStaleTempDirs().catch((e) => logger.error('cleanupStaleTempDirs failed', e));

    // 附件清理必须串行：先按 DB 引用修正 draft，再清数据库无记录的孤儿文件。
    try {
      await reconcileDraftAttachments();
    } catch (e) {
      logger.error('reconcileDraftAttachments failed', e);
    }
    try {
      await cleanupOrphanAttachments();
    } catch (e) {
      logger.error('cleanupOrphanAttachments failed', e);
    }

    // Detect Claude Code CLI
    await detectCli();

    logger.info('Application initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize application services', error);
  }

  createWindow();

  // 后台运行开启时托盘常驻：启动即建图标，修复「运行中托盘不可见、关窗后才出现」。
  // 之后设置页每次保存配置（含开关切换）都经 onConfigSaved 重新同步托盘增删。
  syncTrayWithConfig();
  onConfigSaved(syncTrayWithConfig);

  startGlobalCommandPipeline();

  // hb10-PERM-05：订阅 pending 弹窗数量变化（requestInteraction/cleanup 触发）。
  setInteractionCountChangedHook(() => updateTrayPendingHint());

  // 阶段二 fixture smoke：env CLAUDE_LINK_EXPORT_SMOKE 指定会话种子消息条数时自动跑一次导出。
  if (process.env.CLAUDE_LINK_EXPORT_SMOKE) {
    logger.info('[smoke] hook scheduled');
    setTimeout(() => {
      logger.info('[smoke] hook firing');
      runExportSmokeIfRequested(mainWindow?.webContents).catch((e) =>
        logger.error('export smoke failed', e),
      );
    }, 1500);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      // F6（macOS dock 重开）：window-all-closed 已 killAllProcesses/取消全局探测/停命令源
      // 监视（darwin 不退出进程），重开走 activate——createWindow 后必须恢复命令管线，
      // 否则 watcher 与全局兜底永久失效。IPC 注册经 registerIpcHandlers 幂等守卫安全重入。
      startGlobalCommandPipeline();
    }
  });
});

app.on('window-all-closed', () => {
  killAllProcesses();
  void cancelGlobalCommandProbe(); // 取消全局兜底探测，避免孤儿 claude 子进程（killAllProcesses 不扫 probe）
  stopCommandSourceWatcher(); // D3：停命令来源监视，释放 fs.watch 句柄
  closeConnection();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // hb10 P2-14：先置位再拆毁——否则 minimizeToTray 开启时 app.quit() 触发的 close 事件被
  // 「隐藏到托盘」分支拦截（quitting 尚为 false），而下方 killAllProcesses/closeConnection
  // 已先行执行，被取消的退出留下已拆毁的运行环境。
  quitting = true;
  killAllProcesses();
  void cancelGlobalCommandProbe(); // 取消全局兜底探测，避免孤儿 claude 子进程（killAllProcesses 不扫 probe）
  // hb12-CMD-01：per-session 命令探针与 post-turn 探针一并收口（同上，killAllProcesses 不扫它们）。
  void cancelAllCommandProbes();
  cancelAllPostTurnProbes();
  stopCommandSourceWatcher(); // D3：停命令来源监视，释放 fs.watch 句柄
  // OPT-9：退出前同步 best-effort 清导出临时目录（原 void 异步调用退出前可能跑不完）。
  disposeExportTempDirsSync();
  closeConnection();
});

// Global error handlers
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason instanceof Error ? reason : new Error(String(reason)));
});
