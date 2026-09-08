// useDiffDialog.ts
// 改动对比弹窗（DiffDialog）的全局单例触发器，仿 useImageLightbox：
// 模块级 state ref + open/close/use 三件套，DiffDialog.vue 在 App.vue 挂单例并 v-if="state"。
//
// trigger 记录触发元素，供 DiffDialog 关闭后还原焦点（a11y，仿 InteractionPrompt/ImageLightbox）。
//
// 与 InteractionPrompt 并存时的让步：交互弹窗有 pending 请求时 openDiffDialog no-op——
// 避免两个 window keydown 的 ESC 监听同时关掉双弹窗（交互弹窗优先，等用户先处理 Claude 的提问）。

import { ref } from 'vue';
import { useInteractionStore } from '../stores/interaction-store';

export interface DiffDialogState {
  path: string;
  trigger: HTMLElement | null;
}

const state = ref<DiffDialogState | null>(null);

export function openDiffDialog(path: string, trigger: HTMLElement | null = null): void {
  if (!path) return;
  // 交互弹窗在场时不抢开（ESC 归属冲突，优先让 InteractionPrompt 处理）。
  // P2-8：只看「当前会话可见」的 pending 请求——他会话的后台弹窗不应阻断本会话的 diff 弹窗。
  if (useInteractionStore().visibleRequestsForActiveSession.length > 0) return;
  state.value = { path, trigger };
}

export function closeDiffDialog(): void {
  state.value = null;
}

export function useDiffDialog() {
  return { state, close: closeDiffDialog };
}
