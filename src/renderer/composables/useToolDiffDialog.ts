// useToolDiffDialog.ts
// 「片段意图 diff」弹窗（ToolDiffDialog）的全局单例触发器，仿 useDiffDialog：
// 模块级 state ref + open/close，ToolDiffDialog.vue 在 App.vue 挂单例并 v-if="state"。
//
// 数据源与 useDiffDialog 不同：这里直接携带本地合成的 unified diff 文本（Edit/Write/MultiEdit
// 的片段意图 diff 或 Bash git diff 等真 diff 文本），不经 changesStore/git 拉取。
// open 时按 splitUnifiedDiff 拆成多段（MultiEdit 多段 / git 多文件），弹窗内逐段切换展示。
//
// trigger 记录触发元素，供 ToolDiffDialog 关闭后还原焦点（a11y，仿 InteractionPrompt/ImageLightbox）。
//
// 与 InteractionPrompt 并存时的让步：交互弹窗有 pending 请求时 openToolDiffDialog no-op——
// 避免两个 window keydown 的 ESC 监听同时关掉双弹窗（交互弹窗优先）。

import { ref } from 'vue';
import { useInteractionStore } from '../stores/interaction-store';
import { splitUnifiedDiff } from '../utils/diff-parser';

export interface ToolDiffSegment {
  /** 段标题（如「编辑 1 / 3」或解析出的文件路径）。 */
  label: string;
  /** 单段 unified diff 文本（可直接喂 parseUnifiedDiff）。 */
  diffText: string;
}

export interface ToolDiffDialogState {
  /** 弹窗标题（通常是触发工具的文件路径）。 */
  title: string;
  segments: ToolDiffSegment[];
  trigger: HTMLElement | null;
}

const state = ref<ToolDiffDialogState | null>(null);

export interface OpenToolDiffDialogOptions {
  title: string;
  diffText: string;
  trigger?: HTMLElement | null;
}

export function openToolDiffDialog(options: OpenToolDiffDialogOptions): void {
  const { title, diffText, trigger = null } = options;
  if (!diffText) return;
  // 交互弹窗在场时不抢开（ESC 归属冲突，优先让 InteractionPrompt 处理）。
  if (useInteractionStore().requests.length > 0) return;
  const chunks = splitUnifiedDiff(diffText);
  const segments: ToolDiffSegment[] = chunks.map((chunk, i) => ({
    label: chunks.length > 1 ? `${title} · 段 ${i + 1}/${chunks.length}` : title,
    diffText: chunk,
  }));
  state.value = { title, segments, trigger };
}

export function closeToolDiffDialog(): void {
  state.value = null;
}

export function useToolDiffDialog() {
  return { state, close: closeToolDiffDialog };
}
