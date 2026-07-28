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

type WorkspaceStore = InstanceType<typeof ElectronStoreCtor>;
let store: WorkspaceStore | null = null;

function getStore(): WorkspaceStore {
  store ??= new ElectronStoreCtor({
    name: 'claude-link-workspaces',
    projectName: app.getName(),
    defaults: { recentDirs: [] },
  });
  return store;
}

export function listRecentWorkspaces(): string[] {
  return [...getStore().store.recentDirs];
}

export function addRecentWorkspace(dir: string | null | undefined): string[] {
  if (!dir || !dir.trim()) return listRecentWorkspaces();
  const normalized = dir.trim();
  // 去重并置顶
  const next = [normalized, ...getStore().store.recentDirs.filter((d) => d !== normalized)].slice(0, MAX_ENTRIES);
  getStore().set({ recentDirs: next });
  return next;
}

export function removeRecentWorkspace(dir: string): string[] {
  const next = getStore().store.recentDirs.filter((d) => d !== dir);
  getStore().set({ recentDirs: next });
  return next;
}
