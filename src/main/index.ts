import { app, BrowserWindow, Menu } from 'electron';
import { join } from 'path';
import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { closeConnection, getConnection } from './database/connection';
import { runMigrations } from './database/migrations';
import { registerIpcHandlers } from './ipc-handlers';
import { detectCli } from './modules/cli-detector';
import { killAllProcesses } from './modules/sdk-backend';
import * as taskRepo from './database/repositories/task-repo';
import { logger } from './utils/logger';
import {
  WINDOW_DEFAULT_WIDTH,
  WINDOW_DEFAULT_HEIGHT,
  WINDOW_MIN_WIDTH,
  WINDOW_MIN_HEIGHT,
} from '../shared/constants';
import { loadWindowSize, trackWindowSize } from './modules/window-state';

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

    // Reset any tasks that were running when app was closed
    // (since their processes died with the app)
    taskRepo.resetRunningTasks();

    // Detect Claude Code CLI
    await detectCli();

    logger.info('Application initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize application services', error);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  killAllProcesses();
  closeConnection();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  killAllProcesses();
  closeConnection();
});

// Global error handlers
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason instanceof Error ? reason : new Error(String(reason)));
});
