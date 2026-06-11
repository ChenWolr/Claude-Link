import { BrowserWindow, ipcMain } from 'electron';
import type { AppConfig } from '../shared/types/config';
import { IPC_CHANNELS } from '../shared/constants';
import { clearConfig, getConfig, saveConfig } from './modules/config-manager';
import { detectCli, getCachedCliStatus } from './modules/cli-detector';
import { fetchAvailableModels } from './modules/model-resolver';

export function registerIpcHandlers(_mainWindow: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.CLI_DETECT, async () => detectCli(true));
  ipcMain.handle(IPC_CHANNELS.CLI_GET_STATUS, async () => getCachedCliStatus() ?? detectCli());

  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async () => getConfig());
  ipcMain.handle(IPC_CHANNELS.CONFIG_SAVE, async (_event, partial: Partial<AppConfig>) => saveConfig(partial));
  ipcMain.handle(IPC_CHANNELS.CONFIG_CLEAR, async () => clearConfig());
  ipcMain.handle(IPC_CHANNELS.MODELS_FETCH, async (_event, provider: AppConfig['provider'], apiKey: string) =>
    fetchAvailableModels(provider, apiKey),
  );
}
