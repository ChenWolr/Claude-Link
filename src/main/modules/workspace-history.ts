// workspace-history.ts
// 最近工作空间历史：记录用户用过的工作目录，便于在新建/切换会话时快速复用。
// 独立 electron-store（claude-link-workspaces.json），与配置分离；最多保留 12 条，去重、新的置顶。

import { createSafeStore } from '../utils/safe-store';

const MAX_ENTRIES = 12;

type WorkspaceStore = { store: { recentDirs: string[] }; set: (v: { recentDirs: string[] }) => void };
let store: WorkspaceStore | null = null;

function getStore(): WorkspaceStore {
  // hb12-SMG-01（hb10-CFG-V01 合并面）：坏 JSON 自愈（safe-store helper 统一实现）。
  store ??= createSafeStore<WorkspaceStore>({
    name: 'claude-link-workspaces',
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
