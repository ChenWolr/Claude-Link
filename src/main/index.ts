import { app, BrowserWindow, Menu } from 'electron';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { closeConnection, getConnection } from './database/connection';
import { runMigrations } from './database/migrations';
import { registerIpcHandlers } from './ipc-handlers';
import { detectCli } from './modules/cli-detector';
import { ensureProviderMigration } from './modules/config-manager';
import { killAllProcesses, runGlobalCommandProbe, cancelGlobalCommandProbe } from './modules/sdk-backend';
import * as taskRepo from './database/repositories/task-repo';
import { logger } from './utils/logger';
import {
  WINDOW_DEFAULT_WIDTH,
  WINDOW_DEFAULT_HEIGHT,
  WINDOW_MIN_WIDTH,
  WINDOW_MIN_HEIGHT,
} from '../shared/constants';
import { loadWindowSize, trackWindowSize } from './modules/window-state';
import { setupLinkGuard } from './modules/link-guard';
import { cleanupStaleTempDirs, disposeExportImageOnQuit } from './modules/export-image-manager';
import { runExportSmokeIfRequested } from './modules/export-image-smoke';
import { cleanupOrphanAttachments, reconcileDraftAttachments } from './modules/attachment-service';

if (process.env.CLAUDE_LINK_EXPORT_SMOKE) {
  const smokeUserDataDir = join('D:\\software\\Cache', `claude-link-smoke-${process.pid}-${randomUUID()}`);
  app.setPath('userData', smokeUserDataDir);
}

let mainWindow: BrowserWindow | null = null;

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

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
    if (process.platform === 'win32') {
      Menu.setApplicationMenu(null);
    }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`Renderer process gone: ${details.reason} (${details.exitCode})`);
  });

  setupLinkGuard(mainWindow, is.dev ? process.env.ELECTRON_RENDERER_URL : undefined);

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  registerIpcHandlers(mainWindow);
  trackWindowSize(mainWindow);
}

app.whenReady().then(async () => {
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

  // 启动全局兜底命令探测（无会话绑定）：结果写入 registry.globalFallback，作为重启后旧会话的命令兜底。
  // fire-and-forget；完成时对已打开且无 per-session 快照的会话回填。CLI 缺失/失败均不阻塞启动。
  if (mainWindow) {
    runGlobalCommandProbe(mainWindow);
  }

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
    }
  });
});

app.on('window-all-closed', () => {
  killAllProcesses();
  void cancelGlobalCommandProbe(); // 取消全局兜底探测，避免孤儿 claude 子进程（killAllProcesses 不扫 probe）
  closeConnection();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  killAllProcesses();
  void cancelGlobalCommandProbe(); // 取消全局兜底探测，避免孤儿 claude 子进程（killAllProcesses 不扫 probe）
  void disposeExportImageOnQuit();
  closeConnection();
});

// Global error handlers
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason instanceof Error ? reason : new Error(String(reason)));
});
