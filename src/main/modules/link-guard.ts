import { BrowserWindow, shell } from 'electron';
import { getNavigationDisposition } from '../../shared/external-links';
import { logger } from '../utils/logger';

export function setupLinkGuard(window: BrowserWindow, devRendererUrl?: string): void {
  const guardNavigation = (event: Electron.Event<Electron.WebContentsWillNavigateEventParams>): void => {
    const disposition = getNavigationDisposition(event.url, devRendererUrl);
    if (disposition === 'allow') {
      return;
    }

    event.preventDefault();

    if (disposition === 'open-external') {
      void shell.openExternal(event.url).catch((error) => logger.error('打开外部链接失败', error));
    } else {
      logger.warn('已阻止不受信任的导航');
    }
  };

  window.webContents.on('will-navigate', guardNavigation);
  window.webContents.on('will-redirect', guardNavigation);

  window.webContents.setWindowOpenHandler(({ url }) => {
    const disposition = getNavigationDisposition(url, devRendererUrl);
    if (disposition === 'open-external') {
      void shell.openExternal(url).catch((error) => logger.error('打开外部链接失败', error));
    } else if (disposition === 'block') {
      logger.warn('已阻止不受信任的窗口打开请求');
    }

    return { action: 'deny' };
  });
}
