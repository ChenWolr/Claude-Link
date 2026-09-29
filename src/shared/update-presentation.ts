// src/shared/update-presentation.ts
// 更新 UI 展示层纯函数：徽标可见性 / 最新版本文案 / 检查按钮文案 / 弹窗自动弹出判定。
// 供 update-store（Pinia）、AppSidebar 徽标、ConfigPage 关于 tab、UpdateDialog 共用；
// 契约钉在 scripts/tdd-update-presentation-verify.ts（行为断言直接 import 本模块）。
import type { AppUpdateState, AppUpdateStatus } from './types/update';

/** 徽标可见 & 弹窗可停留的三个状态：发现新版 → 下载中 → 已就绪。 */
export const UPDATE_DIALOG_STATUSES: readonly AppUpdateStatus[] = ['available', 'downloading', 'downloaded'];

export function updateBadgeVisible(status: AppUpdateStatus): boolean {
  return UPDATE_DIALOG_STATUSES.includes(status);
}

export function latestVersionText(latestVersion: string | null | undefined): string {
  return latestVersion ? `v${latestVersion}` : '未查询';
}

export function aboutCheckButtonLabel(checkPending: boolean): string {
  return checkPending ? '检查中…' : '检查更新';
}

/**
 * 弹窗自动弹出判定：进入 available/downloaded 的边沿（状态变化或版本变化），
 * 且该版本未被用户点过「稍后提醒」（dismissed 只在本次运行内记忆——重启后
 * 启动自动检查重新弹一次，与「每次重启逻辑一样」的需求一致）。
 * downloading 不触发自动开弹（available 时已弹过）；installing/error/latest/
 * checking/idle/unavailable 一律不弹。
 */
export function shouldAutoOpenUpdateDialog(
  prev: AppUpdateState | null,
  next: AppUpdateState,
  dismissedVersions: readonly string[],
): boolean {
  if (next.status !== 'available' && next.status !== 'downloaded') return false;
  if (!next.newVersion || dismissedVersions.includes(next.newVersion)) return false;
  if (prev === null) return true;
  return prev.status !== next.status || prev.newVersion !== next.newVersion;
}
