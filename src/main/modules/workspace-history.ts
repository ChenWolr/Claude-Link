// workspace-history.ts
// 最近工作空间历史：记录用户用过的工作目录，便于在新建/切换会话时快速复用。
// 独立 electron-store（claude-link-workspaces.json），与配置分离；最多保留 12 条，去重、新的置顶。

import ElectronStoreModule from 'electron-store';
import { app } from 'electron';

const MAX_ENTRIES = 12;

const ElectronStore =
  (ElectronStoreModule as unknown as { default?: typeof ElectronStoreModule }).default ??
  ElectronStoreModule;

const ElectronStoreCtor = ElectronStore as unknown as new (options?: {
  name?: string;
  projectName?: string;
  defaults?: { recentDirs: string[] };
}) => { store: { recentDirs: string[] }; set: (v: { recentDirs: string[] }) => void };

const store = new ElectronStoreCtor({
  name: 'claude-link-workspaces',
  projectName: app.getName(),
  defaults: { recentDirs: [] },
});

export function listRecentWorkspaces(): string[] {
  return [...store.store.recentDirs];
}

export function addRecentWorkspace(dir: string | null | undefined): string[] {
  if (!dir || !dir.trim()) return listRecentWorkspaces();
  const normalized = dir.trim();
  // 去重并置顶
  const next = [normalized, ...store.store.recentDirs.filter((d) => d !== normalized)].slice(0, MAX_ENTRIES);
  store.set({ recentDirs: next });
  return next;
}

export function removeRecentWorkspace(dir: string): string[] {
  const next = store.store.recentDirs.filter((d) => d !== dir);
  store.set({ recentDirs: next });
  return next;
}
