<!-- ReleaseNotesView.vue：更新说明渲染预览——markdown 经 renderReleaseNotesToHtml（markdown-it
     渲染 + sanitize-html 白名单消毒）后的 HTML 经 v-html 注入；notes 为空（null/undefined/''）不渲染，
     消毒后为空（内容全被剥）回退 <pre> 纯文本直出。容器限高滚动由消费面负责（about-notes /
     update-dialog__notes），本组件只管内容排版。 -->
<script setup lang="ts">
import { computed } from 'vue';
import { renderReleaseNotesToHtml } from '../../utils/release-notes-md';

// 接 update-store state.releaseNotes（string | null）：空值在此归一处理，父层 v-if 只是第一道闸。
const props = defineProps<{ notes?: string | null }>();

// 双层管道纯函数渲染；空/空白输入 → ''（走回退或不渲染分支）。
const html = computed(() => (props.notes ? renderReleaseNotesToHtml(props.notes) : ''));
</script>

<template>
  <div v-if="html" class="release-notes" v-html="html"></div>
  <pre v-else-if="notes" class="release-notes release-notes--fallback">{{ notes }}</pre>
</template>

<style scoped>
.release-notes {
  margin: 0;
  line-height: 1.6;
  word-break: break-word;
}

/* v-html 注入的内容不带本组件 scope 属性，子元素样式一律经 :deep() 下钻。 */

/* 标题：紧凑分级，首个标题贴顶。 */
.release-notes :deep(h1),
.release-notes :deep(h2),
.release-notes :deep(h3),
.release-notes :deep(h4),
.release-notes :deep(h5),
.release-notes :deep(h6) {
  margin: 0.6em 0 0.3em;
  line-height: 1.35;
  font-weight: 650;
}

.release-notes :deep(h1) { font-size: 1.15em; }
.release-notes :deep(h2) { font-size: 1.1em; }
.release-notes :deep(h3) { font-size: 1em; }
.release-notes :deep(h4) { font-size: 0.95em; }
.release-notes :deep(h5) { font-size: 0.92em; }
.release-notes :deep(h6) { font-size: 0.9em; }

.release-notes :deep(h1:first-child),
.release-notes :deep(h2:first-child),
.release-notes :deep(h3:first-child),
.release-notes :deep(h4:first-child),
.release-notes :deep(h5:first-child),
.release-notes :deep(h6:first-child) {
  margin-top: 0;
}

/* 列表。 */
.release-notes :deep(ul),
.release-notes :deep(ol) {
  margin: 0.35em 0;
  padding-left: 1.4em;
}

.release-notes :deep(li) {
  margin: 0.15em 0;
}

/* 段落：首尾不外扩。 */
.release-notes :deep(p) {
  margin: 0.35em 0;
}

.release-notes :deep(p:first-child) {
  margin-top: 0;
}

.release-notes :deep(p:last-child) {
  margin-bottom: 0;
}

/* 行内代码：等宽小号 pill。 */
.release-notes :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.92em;
  padding: 0.08em 0.35em;
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
}

/* 块级代码：等宽基调 + pre-wrap 防横向撑爆；内嵌 code 还原为纯文本形态。 */
.release-notes :deep(pre) {
  margin: 0.35em 0;
  font-family: var(--font-mono);
  font-size: 0.92em;
  padding: 0.5em 0.75em;
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
  white-space: pre-wrap;
  overflow-x: auto;
}

.release-notes :deep(pre code) {
  font-size: 1em;
  padding: 0;
  border: none;
  border-radius: 0;
  background: none;
}

/* 链接：主题强调色，新窗口打开（消毒层已强制 _blank + noopener noreferrer）。 */
.release-notes :deep(a) {
  color: var(--color-accent-strong);
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* 引用：左侧竖线弱化。 */
.release-notes :deep(blockquote) {
  margin: 0.4em 0;
  padding: 0.1em 0 0.1em 0.75em;
  border-left: 3px solid var(--color-border);
  color: var(--color-text-muted);
}

/* 分隔线。 */
.release-notes :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: 0.6em 0;
}

/* 回退形态：notes 非空但消毒产物为空——纯文本直出（等宽 + 换行保留）。 */
.release-notes--fallback {
  font-family: var(--font-mono);
  font-size: 0.92em;
  white-space: pre-wrap;
}
</style>
