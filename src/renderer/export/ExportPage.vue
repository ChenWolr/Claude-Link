<script setup lang="ts">
// 导出页：复用主聊天 MessageList（exportMode）渲染真实消息，v3 版心包裹。
// 阶段三：真实组件渲染（替代阶段二 fixture 色带）。
import MessageList from '../components/chat/MessageList.vue';
import { runnerState } from './export-runner';
</script>

<template>
  <div class="export-root" :data-phase="runnerState.phase">
    <div class="export-header">
      <div class="export-header__title">{{ runnerState.sessionName || '导出预览' }}</div>
      <div class="export-header__meta">{{ runnerState.exportedAt }}</div>
    </div>
    <div class="export-card">
      <MessageList
        :messages="[]"
        :streamingContent="''"
        :streamingThinking="''"
        :streamingTool="''"
        :exportMode="true"
        :exportItems="runnerState.items"
      />
    </div>
  </div>
</template>

<style>
/* v3 第 5 节版心：896 页宽 / 24 外留白 / 848 卡片 / 16 圆角 / 72 顶部信息。
 * html/body/#app 改为自然文档高度（主聊天是 height:100%/overflow:hidden）。 */
html,
body,
#app {
  margin: 0;
  padding: 0;
  background: var(--color-bg, #ffffff);
  height: auto;
  overflow: visible;
}
.export-root {
  width: 896px;
  box-sizing: border-box;
  padding: 24px;
  font-family: -apple-system, 'Segoe UI', sans-serif;
  color: var(--color-text, #222);
  font-size: var(--font-size-base, 16px);
}
.export-header {
  min-height: 72px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 12px 24px;
  margin-bottom: 16px;
  border-radius: 16px;
  background: var(--color-panel, #f4f0ea);
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.1));
}
.export-header__title {
  font-size: 1.25rem;
  font-weight: 700;
  max-width: 560px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.export-header__meta {
  font-size: 0.8125rem;
  color: var(--color-text-muted, #888);
}
.export-card {
  width: 848px;
  margin: 0 auto;
  padding: 24px;
  border-radius: 16px;
  background: var(--color-panel-soft, #fcfaf5);
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.1));
  box-sizing: border-box;
}
/* 导出根节点隐藏输入光标（v3 第 5 节）；动画与文本选择未在此处禁用。 */
.export-root * {
  caret-color: transparent;
}
</style>
