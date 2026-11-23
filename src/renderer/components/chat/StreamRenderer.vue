<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown } from '../../utils/markdown';
// P6-B（2026-11-21）：流式态正文文件链接右键委托（左键零动作，右键菜单为唯一交互入口）。
import { useFileLinkMenuStore } from '../../stores/file-link-menu-store';
import { enrichMarkdown as vEnrich } from '../../directives/enrich-markdown';

const props = defineProps<{ content: string }>();

const renderedContent = computed(() => renderMarkdown(props.content));

// P6-B：流式态正文的文件链接右键委托，与 MessageBubble.vue 的 onContentContextMenu 同实现
//（文件内自含、不跨组件抽公共——最小影响面）。markdown.ts link_open 规则把 .md-file-link 的
// href 置 javascript:void(0)：左键零动作，右键弹 useFileLinkMenuStore 菜单；非文件链接（含
// http 外链）不拦截——closest 不命中即 return，系统菜单照旧。
function onContentContextMenu(e: MouseEvent): void {
  const el = (e.target as HTMLElement | null)?.closest?.('.md-file-link') as HTMLElement | null;
  if (!el) return;
  e.preventDefault();
  const p = el.getAttribute('data-clip-path');
  if (p) useFileLinkMenuStore().open(p, e.clientX, e.clientY);
}
</script>

<template>
  <!-- C2②/③：角色名已外置到 MessageList stream-group 的 .msg-label 标签行（本组件不再渲染
       角色行）；外壳（底/描边/圆角/内边距/阴影/限宽）归 ai-card，.stream 只承载正文排版。 -->
  <div class="stream">
    <div class="stream__content markdown-body" v-html="renderedContent" v-enrich @contextmenu="onContentContextMenu" /><span class="cursor">▊</span>
  </div>
</template>

<style scoped>
/* C2③ 去壳：.stream 只留正文度量（word-break + line-height 1.8，随 AI 卡行高统一——
   settings-mapping「StreamRenderer line-height:1.8」同步钉；卡壳归 MessageList .ai-card）。 */
.stream {
  word-break: break-word;
  line-height: 1.8;
}

.stream__content :deep(p) {
  margin: 0 0 0.25rem;
}

.stream__content :deep(p:last-child) {
  margin-bottom: 0;
}

/* fix-2 F5：文件链接按钮化样式，与 MessageBubble.vue 的两组 :deep(.md-file-link) 同款——
   accent 色 + 点状下划线标示「可交互」（P6-B 起交互入口为右键菜单，左键零动作；cursor/样式
   系列保留仍可达），与普通网页外链区分；v-html 内容须 :deep 穿透，hover 切实线下划线给明确
   可交互反馈。 */
.stream__content :deep(.md-file-link) {
  color: var(--color-accent-strong);
  font-weight: 500;
  cursor: pointer;
  text-decoration: underline dotted;
  text-decoration-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
  text-underline-offset: 4px;
}

.stream__content :deep(.md-file-link:hover) {
  text-decoration-style: solid;
  color: var(--color-accent);
}

.cursor {
  animation: blink 1s step-end infinite;
  color: var(--color-accent-strong);
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}
</style>
