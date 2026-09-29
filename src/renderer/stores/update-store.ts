// src/renderer/stores/update-store.ts
// 应用更新状态唯一订阅者（App.vue onMounted init 一次，生命周期与 app 等长）。
// 侧栏徽标 / 关于 tab / UpdateDialog 都消费本 store，渲染层不得再直接订阅
// onUpdateStateChanged（removeUpdateStateListener 是 removeAllListeners，多订阅者互踩）。
import { defineStore } from 'pinia';
import type { AppUpdateState } from '../../shared/types/update';
import { shouldAutoOpenUpdateDialog, updateBadgeVisible } from '../../shared/update-presentation';

let offUpdateState: (() => void) | null = null; // 模块级：订阅 off 句柄不进响应式 state

function idleState(): AppUpdateState {
  return { status: 'idle', newVersion: null, latestVersion: null, releaseNotes: null, progress: null, error: null };
}

interface UpdateStoreState {
  currentVersion: string;
  state: AppUpdateState;
  dismissedVersions: string[]; // 点过「稍后提醒」的版本（仅本次运行内记忆）
  dialogVisible: boolean;
  checkPending: boolean;
}

export const useUpdateStore = defineStore('app-update', {
  state: (): UpdateStoreState => ({
    currentVersion: '',
    state: idleState(),
    dismissedVersions: [],
    dialogVisible: false,
    checkPending: false,
  }),
  getters: {
    status(state): AppUpdateState['status'] { return state.state.status; },
    badgeVisible(state): boolean { return updateBadgeVisible(state.state.status); },
  },
  actions: {
    /** App.vue onMounted 调用；幂等。拉初值 + 订阅广播。 */
    init() {
      if (offUpdateState) return;
      void window.claudeLink.getUpdateInfo().then((info) => {
        this.currentVersion = info.currentVersion;
        this.applyState(info.state);
      });
      offUpdateState = window.claudeLink.onUpdateStateChanged((state) => this.applyState(state));
    },
    /** 应用一拍广播：边沿判定弹窗；离开三态集合自动收起弹窗。 */
    applyState(next: AppUpdateState) {
      const prev = this.state;
      this.state = next;
      if (shouldAutoOpenUpdateDialog(prev, next, this.dismissedVersions)) {
        this.dialogVisible = true;
      } else if (!updateBadgeVisible(next.status)) {
        this.dialogVisible = false;
      }
    },
    /** 手动检查（关于 tab 按钮）：pending 防抖；发现新版直接开弹窗（无视 dismissed——用户主动询问结果）。 */
    async check() {
      if (this.checkPending) return;
      this.checkPending = true;
      try {
        const state = await window.claudeLink.checkForAppUpdate();
        this.applyState(state);
        if ((state.status === 'available' || state.status === 'downloaded') && state.newVersion) {
          this.dialogVisible = true;
        }
      } finally {
        this.checkPending = false;
      }
    },
    async install() {
      await window.claudeLink.installAppUpdate();
    },
    /** 弹窗「稍后提醒」：记版本，本次运行内同版本不再自动弹；徽标与关于 tab 仍可见。 */
    dismissUpdate() {
      const v = this.state.newVersion;
      if (v && !this.dismissedVersions.includes(v)) this.dismissedVersions.push(v);
      this.dialogVisible = false;
    },
  },
});
