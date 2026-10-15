<template>
  <div
    v-for="dir in DIRS"
    :key="dir"
    class="dlg-rz"
    :class="`dlg-rz--${dir}`"
    aria-hidden="true"
    @pointerdown="binder.beginResize(dir, $event)"
  />
</template>

<script setup lang="ts">
import type { ResizeDir } from '../../composables/dialog-shell-geometry';
import type { ResizeHandleBinder } from '../../composables/use-dialog-shell';

// 弹窗壳 8 向缩放手柄（计划 2026-10-14 §2 P4）：
// - props 用最小接入接口 ResizeHandleBinder（duck-typed：useDialogShell 返回值整体传入即满足）；
// - 定位/光标/hover 扩大命中样式在全局 main.css 的 .dlg-rz 段（手柄渲染在各类弹窗卡片内，须全局类）；
// - 无插槽无文案，aria-hidden（纯指针交互，无键盘语义）。
defineProps<{ binder: ResizeHandleBinder }>();

const DIRS: ResizeDir[] = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'];
</script>
