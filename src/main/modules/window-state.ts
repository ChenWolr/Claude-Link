// window-state.ts
// 主窗口大小持久化：把上次窗口宽高落盘到 claude-link-window-state.json，
// 重开时按上次尺寸居中打开。仅记大小，不记位置/最大化状态。
//
// trackWindowSize 监听 resize 并防抖保存；最大化/全屏状态下不保存，
// 以免把「占满屏幕的尺寸」当成普通尺寸存下来。close 时补一次同步保存，
// 兜住「调整后未及防抖就关闭」的情况。

import ElectronStoreModule from 'electron-store';
import { app, type BrowserWindow } from 'electron';
import * as path from 'node:path';
import { rm } from 'node:fs/promises';
import { WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT } from '../../shared/constants';
import { logger } from '../utils/logger';

interface WindowSize {
  width: number;
  height: number;
}

interface PersistedSize {
  width?: unknown;
  height?: unknown;
}

const ElectronStore =
  (ElectronStoreModule as unknown as { default?: typeof ElectronStoreModule }).default ??
  ElectronStoreModule;

const ElectronStoreCtor = ElectronStore as unknown as new (options?: {
  name?: string;
  projectName?: string;
  defaults?: PersistedSize;
}) => {
  store: PersistedSize;
  set(value: Partial<PersistedSize>): void;
};

type WindowStateStore = InstanceType<typeof ElectronStoreCtor>;
let store: WindowStateStore | null = null;

function getStore(): WindowStateStore {
  store ??= new ElectronStoreCtor({
    name: 'claude-link-window-state',
    projectName: app.getName(),
    defaults: {},
  });
  return store;
}

const SAVE_DEBOUNCE_MS = 500;

/** 读取持久化尺寸；不存在或非法返回 null。读出后 clamp 到最小尺寸（防御脏值）。
 *  B2（D14-F1）：损坏兜底——conf 的 get store() 对损坏 JSON 默认抛 SyntaxError
 *  （clearInvalidConfig 未启用），而 createWindow 在 whenReady 的 try/catch 之外，
 *  抛出即中断其后全部初始化（无窗口/无托盘/无更新检查、进程驻留）。此处包 try/catch：
 *  抛错时 warn 留排障线索、删除损坏文件（conf 下次读按不存在走 defaults，下次 resize
 *  保存重建文件，自愈闭环）、返回 null 由 index.ts 回落默认 1200×800——把「应用起不来」
 *  降级为「丢一次窗口尺寸」。 */
export function loadWindowSize(): WindowSize | null {
  let raw: PersistedSize;
  try {
    raw = getStore().store;
  } catch (error) {
    logger.warn(`读取窗口大小持久化失败（已删除损坏文件并回落默认尺寸）：${error instanceof Error ? error.message : String(error)}`);
    const corruptPath = path.join(app.getPath('userData'), 'claude-link-window-state.json');
    void rm(corruptPath, { force: true }).catch(() => { /* 删除失败：留待下次成功保存覆写 */ });
    store = null; // 单例重置：避免实例缓存态与已删文件失配
    return null;
  }
  const width = typeof raw.width === 'number' && Number.isFinite(raw.width) ? raw.width : NaN;
  const height = typeof raw.height === 'number' && Number.isFinite(raw.height) ? raw.height : NaN;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  return {
    width: Math.max(Math.round(width), WINDOW_MIN_WIDTH),
    height: Math.max(Math.round(height), WINDOW_MIN_HEIGHT),
  };
}

/** 给窗口挂载 resize/close 监听，防抖落盘普通窗口尺寸（最大化/全屏时跳过）。 */
export function trackWindowSize(window: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const save = (): void => {
    // 最大化/全屏时不覆盖普通尺寸，避免下次以全屏尺寸（但非最大化状态）打开
    if (window.isDestroyed() || window.isMaximized() || window.isFullScreen()) {
      return;
    }
    const bounds = window.getNormalBounds();
    getStore().set({ width: bounds.width, height: bounds.height });
  };

  const flush = (): void => {
    try {
      save();
    } catch (error) {
      logger.warn(`保存窗口大小失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const schedule = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, SAVE_DEBOUNCE_MS);
  };

  window.on('resize', schedule);
  // 关闭时同步保存一次，兜住调整后未及防抖就关闭的情形
  window.on('close', () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flush();
  });
}
