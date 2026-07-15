<script setup lang="ts">
// ToolCallBlock —— openhanako 行式工具行（ToolIndicator 风格）。
// 默认一行：图标 + 标签 + mono 细节（summarizeToolUse 提取的文件名/命令/查询）+ ✓/✗/···；
// 点击展开看完整入参与结果（保留 claude-link 的详情能力 + 长结果渐进披露）。
// 子 Agent（Agent/Task）行带「查看过程 →」锚点，点击定位右侧子Agent Tab。
import { computed, ref, watch, nextTick } from 'vue';
import type { Message } from '../../../shared/types/session';
import { isDiffContent, renderDiffHtml, renderMarkdown } from '../../utils/markdown';
import { getProcessKindMeta, summarizeToolUse } from '../../utils/process-kind';
import { SUB_AGENT_TOOL_NAMES } from '../../../shared/process-kind';
import { useSessionStore } from '../../stores/session-store';

const props = defineProps<{
  use: Message | null;
  result: Message | null;
  running?: boolean;
  elapsedSeconds?: number;
  backgroundRunning?: boolean;
}>();

const store = useSessionStore();
const expanded = ref(false);

const useParsed = computed<{ name?: string; input?: unknown } | null>(() => {
  if (!props.use) return null;
  try {
    return JSON.parse(props.use.content) as { name?: string; input?: unknown };
  } catch {
    return null;
  }
});

const toolName = computed(() => useParsed.value?.name ?? '工具');
const meta = computed(() => getProcessKindMeta(`tool:${toolName.value}`));
// 行内 mono 细节（对齐 openhanako extractToolDetail：read→文件名、bash→命令…）。
const detail = computed(() => (props.use ? summarizeToolUse(props.use.content) : ''));
// 与 process-kind.isSubAgentToolUse 共用同一份工具名清单：Agent/Task/Workflow/Skill 派生的
// 子 agent 都显示「查看过程」锚点（原先只认 Agent/Task，Workflow/Skill 漏掉）。
const isSubAgent = computed(() => (SUB_AGENT_TOOL_NAMES as readonly string[]).includes(toolName.value));

function focusSubAgent(): void {
  if (props.use?.toolUseId) store.focusSubAgent(props.use.toolUseId);
}

const resultContent = computed(() => props.result?.content ?? '');
const isDiff = computed(() => !!props.result && isDiffContent(props.result.content));
const renderedDiff = computed(() => (isDiff.value ? renderDiffHtml(props.result!.content) : ''));
const renderedMarkdown = computed(() => (resultContent.value ? renderMarkdown(resultContent.value) : ''));

const costMsg = computed<Message | null>(() => {
  if (props.use && props.use.costUsd != null) return props.use;
  if (props.result && props.result.costUsd != null) return props.result;
  return null;
});

// 长结果渐进披露（参考 openhanako #786）。
// Bug1：是否需要「展开全部」以真实 DOM 溢出为准（scrollHeight > 预览高度），不再只按行数判断。
// 旧行数 >30 才出按钮 → 单行/少行但超长内容（长 URL、压缩文本、minified 代码、14~30 行段落）
// 被 max-height:220px + overflow:hidden 永久裁断却无展开入口，后半段看不到。改用 DOM 实测后还天然
// 适配字号缩放（rem 迁移），不再与行数/字符阈值耦合。resultLineCount 仅用于按钮文案。
const RESULT_PREVIEW_PX = 220;
const resultLineCount = computed(() => (resultContent.value ? resultContent.value.split('\n').length : 0));
const resultExpanded = ref(false);
const resultInnerRef = ref<HTMLElement | null>(null);
const resultOverflow = ref(false);
function measureResultOverflow(): void {
  const el = resultInnerRef.value;
  // scrollHeight 不受 max-height/overflow:hidden 裁剪影响，恒为完整内容高度。
  resultOverflow.value = !!el && el.scrollHeight > RESULT_PREVIEW_PX + 2;
}
// 工具行展开后、或结果到达后，等 DOM 渲染完再测是否溢出。
watch([expanded, resultContent], () => {
  if (expanded.value) nextTick(measureResultOverflow);
});
</script>

<template>
  <div class="tool-row">
    <div class="tool-row__head" @click="expanded = !expanded">
      <span class="tool-row__icon">{{ meta.icon }}</span>
      <span class="tool-row__desc">{{ meta.label }}</span>
      <span v-if="detail" class="tool-row__detail">{{ detail }}</span>
      <span v-if="isSubAgent && use?.toolUseId" class="tool-row__anchor" @click.stop="focusSubAgent">查看过程 →</span>
      <span class="tool-row__status">
        <span v-if="running && elapsedSeconds != null" class="tool-row__elapsed">⏱{{ elapsedSeconds.toFixed(1) }}s</span>
        <span v-else-if="running" class="tool-row__dots"><span></span><span></span><span></span></span>
        <span v-else-if="backgroundRunning" class="tool-row__bg">🔁后台</span>
        <span v-else-if="result && result.isError" class="tool-row__fail">✗</span>
        <span v-else-if="result" class="tool-row__done">✓</span>
      </span>
    </div>
    <div v-if="expanded" class="tool-row__body">
      <div v-if="useParsed" class="tool-row__json">
        <pre>{{ JSON.stringify(useParsed.input ?? {}, null, 2) }}</pre>
      </div>
      <div v-if="resultContent" class="tool-row__result" :class="{ 'tool-row__result--expanded': resultExpanded }">
        <div ref="resultInnerRef" class="tool-row__result-inner">
          <div v-if="isDiff" class="markdown-body" v-html="renderedDiff" />
          <div v-else class="markdown-body" v-html="renderedMarkdown" />
        </div>
        <div v-if="resultOverflow" class="tool-row__result-fade">
          <button type="button" class="tool-row__expand" @click.stop="resultExpanded = !resultExpanded">
            {{ resultExpanded ? '收起 ▴' : (resultLineCount > 1 ? `展开全部（${resultLineCount} 行）▾` : '展开全部 ▾') }}
          </button>
        </div>
      </div>
      <div v-else-if="useParsed" class="tool-row__pending">（等待结果…）</div>
      <div v-if="costMsg" class="tool-row__meta">
        ${{ costMsg.costUsd!.toFixed(4) }}<span v-if="costMsg.durationMs"> · {{ (costMsg.durationMs / 1000).toFixed(1) }}s</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-row {
  width: 100%;
}

.tool-row__head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 4px 8px;
  font-size: 0.8125rem;
  color: var(--color-text);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background 0.15s;
}

.tool-row__head:hover {
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
}

.tool-row__icon {
  font-size: 0.875rem;
  flex-shrink: 0;
}

.tool-row__desc {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-row__detail {
  flex: 1;
  min-width: 0;
  font-size: 0.75rem;
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-row__anchor {
  flex-shrink: 0;
  font-size: 0.6875rem;
  color: var(--color-accent-strong);
  cursor: pointer;
}

.tool-row__anchor:hover {
  text-decoration: underline;
}

.tool-row__status {
  flex-shrink: 0;
  margin-left: auto;
}

.tool-row__dots {
  display: inline-flex;
  gap: 2px;
  align-items: center;
}
.tool-row__dots span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color-accent-strong);
  animation: tool-dot-pulse 1.4s infinite ease-in-out both;
}
.tool-row__dots span:nth-child(2) {
  animation-delay: 0.16s;
}
.tool-row__dots span:nth-child(3) {
  animation-delay: 0.32s;
}
@keyframes tool-dot-pulse {
  0%, 80%, 100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  40% {
    opacity: 1;
    transform: scale(1);
  }
}

.tool-row__done {
  color: var(--color-accent-strong);
  font-weight: 700;
}

/* 工具失败（is_error）：红色 ✗，与成功的 ✓ 形成醒目对比。 */
.tool-row__fail {
  color: var(--color-fail-strong);
  font-weight: 700;
}

/* C：工具运行实时耗时（tool_progress）。 */
.tool-row__elapsed {
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

/* C：后台运行标注（后台 Bash 的 tool_result 已回但实际后台仍在跑，区别于 ✓）。 */
.tool-row__bg {
  font-size: 0.6875rem;
  color: var(--color-accent-strong);
}

/* 展开态：左侧细引导线，缩进显示入参/结果。 */
.tool-row__body {
  padding: 8px 8px 10px;
  margin: 2px 0 2px 6px;
  border-left: 2px solid var(--color-border);
}

.tool-row__json pre {
  margin: 0 0 8px;
  font-size: 0.75rem;
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  box-shadow: inset 0 1px 2px rgba(0,0,0,0.08);
}

.tool-row__result {
  position: relative;
}

.tool-row__result:not(.tool-row__result--expanded) .tool-row__result-inner {
  max-height: 220px;
  overflow: hidden;
}

.tool-row__result-fade {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  justify-content: center;
  padding-top: 40px;
  background: linear-gradient(to bottom, transparent, var(--color-panel) 78%);
  pointer-events: none;
}

.tool-row__result--expanded .tool-row__result-fade {
  position: static;
  padding-top: 8px;
  background: none;
}

.tool-row__expand {
  pointer-events: auto;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 3px 12px;
  font-size: 0.6875rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}

.tool-row__expand:hover {
  border-color: var(--color-accent-strong);
  color: var(--color-accent-strong);
}

.tool-row__pending {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  font-style: italic;
}

.tool-row__meta {
  margin-top: 6px;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}

.tool-row__body :deep(.markdown-body p) {
  margin: 0 0 6px;
}
</style>
