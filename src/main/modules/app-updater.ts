// src/main/modules/app-updater.ts
// 应用内检查更新（electron-updater + GitHub Releases）。
// 发版侧：electron-builder.json5 的 publish 指向 github ChenWolr/Claude-Link；package:win 用
// --publish never 只构建不上传，latest.yml 照常生成在 dist-electron/，发版时手动连同安装包传 Release。
// 客户端：设置页「关于」tab 触发 checkForAppUpdates → 拉 latest.yml 与 app.getVersion() semver 比较
// → 有更新先查磁盘空间（≥500MB）再静默下载（sha512 校验由 electron-updater 完成）→「重启更新」
// quitAndInstall 由 NSIS 安装器杀旧进程覆盖安装并自启；before-quit 置 quitting 使托盘拦截放行
// （复用现有退出清理链，无需改 index.ts 退出逻辑）。开发模式（!app.isPackaged）固定 unavailable。
// 启动自动检查（R5）：whenReady 后延迟 5s 静默查一次（scheduleStartupUpdateCheck），失败只落日志。
// latestVersion（R3）：最近一次检查获知的最新版本号，available/not-available 均写入且检查中/
// 失败不清空（setState patch 合并自然保留）——关于 tab「最新版本」跨状态流转永久显示。
// 禁用差分下载：Release 不上传 blockmap，差分链路必然失败。
import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as fs from 'fs';
import { logger } from '../utils/logger';
import { IPC_CHANNELS } from '../../shared/constants';
import type { AppUpdateInfo, AppUpdateState } from '../../shared/types/update';

const GITHUB_OWNER = 'ChenWolr';
const GITHUB_REPO = 'Claude-Link';
const MIN_FREE_DISK_MB = 500;
const STATE_EVENT = IPC_CHANNELS.APP_UPDATE_STATE_CHANGED;

type GetMainWindow = () => BrowserWindow | null;

function createIdleState(): AppUpdateState {
  return { status: 'idle', newVersion: null, latestVersion: null, releaseNotes: null, progress: null, error: null };
}

let _getMainWindow: GetMainWindow = () => null;
let _updaterConfigured = false;
let _installPromise: Promise<boolean> | null = null;
let _state: AppUpdateState = createIdleState();

function getUpdateState(): AppUpdateState {
  return { ..._state };
}

function sendStateToRenderers(state: AppUpdateState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send(STATE_EVENT, state);
    } catch {
      // 窗口销毁竞态：忽略单窗发送失败
    }
  }
}

function setState(patch: Partial<AppUpdateState>): void {
  _state = { ..._state, ...patch };
  sendStateToRenderers(getUpdateState());
}

/** latest.yml 尚未上传（draft/资产传一半）时 GitHub 返回 404——视为无更新，不惊扰用户。 */
function isMissingLatestMetadataError(message: string): boolean {
  return /\blatest(?:-mac)?\.ya?ml\b/i.test(message) && /(cannot find|not found|missing|404)/i.test(message);
}

/**
 * checkForUpdates 失败信息的用户态文案归一（形态实证：node_modules/electron-updater
 * 6.8.3 out/providers/GitHubProvider.js :100/:114/:162）：
 * - :100 零已发布 Release；
 * - :162 最新版本为 prerelease 且未开 allowPrerelease（含 "please ensure a production release exists"）；
 * - :114 latest.yml 缺失走 isMissingLatestMetadataError（上层判「无更新」），不经此函数。
 * 其余错误剥掉堆栈行并截断，避免内嵌 stack 直示用户。
 */
function friendlyCheckErrorMessage(message: string): string {
  if (/No published versions on GitHub/.test(message)) {
    return 'GitHub 上暂无已发布的版本';
  }
  if (/please ensure a production release exists/.test(message)) {
    return 'GitHub 上最新版本为预发布（pre-release），检查更新只认稳定版；请确认 Release 未误勾 pre-release';
  }
  return message
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trimStart().startsWith('at '))
    .join(' ')
    .slice(0, 300);
}

async function hasSufficientDiskSpace(minMB: number): Promise<boolean> {
  try {
    const stats = await fs.promises.statfs(app.getPath('userData'));
    return stats.bavail * stats.bsize >= minMB * 1024 * 1024;
  } catch {
    return true; // statfs 失败不阻塞更新
  }
}

function configureUpdater(): void {
  // 显式 setFeedURL，不依赖 electron-builder 内嵌的 app-update.yml（--publish never 本地构建亦可用）。
  // CLAUDE_LINK_UPDATE_FEED_URL：本地 generic feed 测试缝（E2E 见 scripts/cdp-update-e2e.mjs）。⚠ 仅测试用：对打包生产版同样生效，正式环境勿设置此环境变量。
  const envFeed = process.env.CLAUDE_LINK_UPDATE_FEED_URL;
  if (envFeed) {
    const url = envFeed.endsWith('/') ? envFeed : `${envFeed}/`;
    autoUpdater.setFeedURL({ provider: 'generic', url });
  } else {
    autoUpdater.setFeedURL({ provider: 'github', owner: GITHUB_OWNER, repo: GITHUB_REPO });
  }
  autoUpdater.autoDownload = false; // 由我们在磁盘检查后手动触发
  autoUpdater.autoInstallOnAppQuit = false; // 只在用户明确点「重启更新」时安装
  autoUpdater.disableDifferentialDownload = true; // Release 不上传 blockmap
  autoUpdater.logger = {
    info: (m) => logger.info(String(m)),
    warn: (m) => logger.warn(String(m)),
    error: (m) => logger.error(String(m)),
  };

  autoUpdater.on('checking-for-update', () => {
    setState({ status: 'checking', error: null, newVersion: null, releaseNotes: null, progress: null });
  });

  autoUpdater.on('update-available', async (info) => {
    setState({
      status: 'available',
      newVersion: info.version ?? null,
      latestVersion: info.version ?? _state.latestVersion,
      releaseNotes: typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => (typeof n === 'string' ? n : n.note || '')).join('\n')
          : null,
      progress: null,
      error: null,
    });
    const ok = await hasSufficientDiskSpace(MIN_FREE_DISK_MB);
    if (!ok) {
      setState({ status: 'error', error: `磁盘空间不足：更新至少需要 ${MIN_FREE_DISK_MB}MB 可用空间` });
      return;
    }
    autoUpdater.downloadUpdate().catch((err) => {
      setState({ status: 'error', error: friendlyCheckErrorMessage(err instanceof Error ? err.message : String(err)) });
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    setState({
      status: 'downloading',
      progress: {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      },
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    setState({ status: 'downloaded', newVersion: info.version ?? _state.newVersion, progress: null });
  });

  autoUpdater.on('update-not-available', (info) => {
    setState({ status: 'latest', latestVersion: info.version ?? _state.latestVersion });
  });

  autoUpdater.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (isMissingLatestMetadataError(message)) {
      setState({ status: 'latest' });
      return;
    }
    setState({ status: 'error', error: friendlyCheckErrorMessage(message) });
  });
}

/** whenReady 内 createWindow 后调用一次；重复调用安全（幂等守卫）。 */
export function initAppUpdater(getMainWindow: GetMainWindow): void {
  _getMainWindow = getMainWindow;
  void _getMainWindow; // 仅作扩展点保留：广播走 getAllWindows，不消费单窗引用（计划 §5 Task 3 注）
  if (!app.isPackaged) return; // 开发模式不接入 electron-updater（状态恒 unavailable）
  if (_updaterConfigured) return;
  _updaterConfigured = true;
  configureUpdater();
}

export function getAppUpdateInfo(): AppUpdateInfo {
  const state = app.isPackaged ? getUpdateState() : { ...createIdleState(), status: 'unavailable' as const };
  return { currentVersion: app.getVersion(), state };
}

export async function checkForAppUpdates(): Promise<AppUpdateState> {
  if (!app.isPackaged) {
    setState({ ...createIdleState(), status: 'unavailable' });
    return getAppUpdateInfo().state;
  }
  if (getUpdateState().status === 'installing') return getUpdateState(); // 安装中拒绝重入
  // 检查/发现/下载中拒绝重入：渲染层按钮常可点后由这里兜底（重入 electron-updater
  // 会报 "download in progress" 类错误并把 downloading 态覆盖成 error）。
  if (['checking', 'available', 'downloading'].includes(getUpdateState().status)) return getUpdateState();
  setState({ status: 'checking', error: null, newVersion: null, releaseNotes: null, progress: null });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isMissingLatestMetadataError(message)) {
      setState({ status: 'latest' });
    } else {
      setState({ status: 'error', error: friendlyCheckErrorMessage(message) });
    }
  }
  return getUpdateState();
}

export async function installAppUpdate(): Promise<boolean> {
  if (getUpdateState().status !== 'downloaded') return false;
  if (_installPromise) return _installPromise;
  _installPromise = (async () => {
    setState({ status: 'installing', progress: null });
    // 延一拍让 installing 状态先推到渲染层，再关窗起安装器。
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      // win32 非静默（保留 NSIS 向导 allowToChangeInstallationDirectory 语义）；装完自启。
      // 注意：isSilent=false（向导模式）下 electron-updater 忽略 isForceRunAfter，装完自启不保证——用户可能需手动重开。
      autoUpdater.quitAndInstall(process.platform !== 'win32', true);
      return true;
    } catch (err) {
      setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      _installPromise = null;
    }
  })();
  return _installPromise;
}

const STARTUP_CHECK_DELAY_MS = 5000;

/** index.ts whenReady 内 createWindow 后调用：延迟 5s 静默检查一次（R5）。
 *  dev 模式由 checkForAppUpdates 内部守卫消化（unavailable，无网络请求）；
 *  失败只落日志与 About 状态文案，不弹窗不亮徽标。 */
export function scheduleStartupUpdateCheck(): void {
  setTimeout(() => {
    checkForAppUpdates().catch((err) => logger.warn(`startup update check failed: ${err instanceof Error ? err.message : String(err)}`));
  }, STARTUP_CHECK_DELAY_MS);
}
