<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue';
import type { Message } from '../../../shared/types/session';
import MessageBubble from './MessageBubble.vue';
import StreamRenderer from './StreamRenderer.vue';
import ProcessGroup from './ProcessGroup.vue';
import ThinkingBlock from './ThinkingBlock.vue';

interface RenderGroup {
  key: string;
  type: 'message' | 'process';
  messages: Message[];
}

const props = defineProps<{
  messages: Message[];
  streamingContent: string;
  streamingThinking: string;
  streamingTool: string;
  sending?: boolean;
}>();

const container = ref<HTMLElement | null>(null);

// 把连续的 thinking / tool_use / tool_result 合并为一个"过程组"，
// 由 ProcessGroup 统一折叠展示，避免多条独立块堆叠成杂乱横线。
// user / assistant 文本消息各自单独渲染。
const renderGroups = computed<RenderGroup[]>(() => {
  const groups: RenderGroup[] = [];
  for (const msg of props.messages) {
    const isProcess =
      msg.eventType === 'thinking' ||
      msg.eventType === 'tool_use' ||
      msg.eventType === 'tool_result';
    if (isProcess) {
      const last = groups[groups.length - 1];
      if (last && last.type === 'process') {
        last.messages.push(msg);
      } else {
        groups.push({ key: msg.id, type: 'process', messages: [msg] });
      }
    } else {
      groups.push({ key: msg.id, type: 'message', messages: [msg] });
    }
  }
  return groups;
});

// 只在消息数量变化时自动滚底（新消息到达）。流式内容更新时不强制跳底，
// 让用户可以手动向上滚动查看历史。
watch(
  () => props.messages.length,
  async () => {
    await nextTick();
    if (container.value) {
      container.value.scrollTop = container.value.scrollHeight;
    }
  },
);

function handleCopyClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>('.code-block__copy');
  if (!button) return;

  const code = button.dataset.code;
  if (!code) return;

  navigator.clipboard
    .writeText(code)
    .then(() => {
      button.textContent = '已复制';
      button.classList.add('code-block__copy--copied');
      setTimeout(() => {
        button.textContent = '复制';
        button.classList.remove('code-block__copy--copied');
      }, 1500);
    })
    .catch(() => {
      button.textContent = '失败';
      setTimeout(() => {
        button.textContent = '复制';
      }, 1500);
    });
}
</script>

<template>
  <div class="message-list">
    <div ref="container" class="message-list__scroller" @click="handleCopyClick">
      <template v-for="group in renderGroups" :key="group.key">
        <ProcessGroup v-if="group.type === 'process'" :messages="group.messages" />
        <MessageBubble v-else :message="group.messages[0]" />
      </template>
      <div v-if="sending && !streamingContent && !streamingThinking && !streamingTool" class="status-indicator">
        <span class="status-indicator__dots"><span></span><span></span><span></span></span>
        <span class="status-indicator__text">Claude 正在思考…</span>
      </div>
      <ThinkingBlock v-if="streamingThinking" :content="streamingThinking" streaming />
      <div v-if="streamingTool" class="tool-stream">
        <span class="tool-stream__label">🔧 正在调用工具…</span>
        <pre class="tool-stream__content">{{ streamingTool }}</pre>
      </div>
      <StreamRenderer v-if="streamingContent" :content="streamingContent" />
    </div>
  </div>
</template>

<style scoped>
/* 外层：纯 flex 占位容器，承担父级分配的高度（flex: 1 + min-height: 0）。
 * 内层：用 height: 100% 拿到像素级确定高度，overflow-y: auto 稳定出现滚动条。
 * 这种"两层嵌套"是解决 flex 子项百分比基准解析不稳定的经典写法。 */
.message-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.message-list__scroller {
  height: 100%;
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 消息少时贴底、消息多时可自由向上滚动。
 * 不能用 justify-content: flex-end——它会让溢出内容被推到 scrollTop=0 之上的
 * 不可访问区域，导致历史消息无法滚动查看。改用 ::before + margin-bottom:auto：
 * 内容不足时 auto 吸收剩余空间把消息推到底部；溢出时 auto 归零，正常滚动。 */
.message-list__scroller::before {
  content: '';
  margin-bottom: auto;
}

.status-indicator {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
  font-size: 13px;
  color: var(--color-text-muted);
}

.status-indicator__dots {
  display: inline-flex;
  gap: 3px;
}

.status-indicator__dots span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-accent-strong);
  animation: status-dot-pulse 1.4s infinite ease-in-out both;
}

.status-indicator__dots span:nth-child(2) {
  animation-delay: 0.16s;
}

.status-indicator__dots span:nth-child(3) {
  animation-delay: 0.32s;
}

@keyframes status-dot-pulse {
  0%, 80%, 100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  40% {
    opacity: 1;
    transform: scale(1);
  }
}

.tool-stream {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  padding: 10px 14px;
  max-width: 752px;
}

.tool-stream__label {
  display: block;
  font-size: 11px;
  font-weight: 700;
  color: var(--color-accent-strong);
  text-transform: uppercase;
  margin-bottom: 6px;
  opacity: 0.7;
}

.tool-stream__content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  color: var(--color-text-muted);
  max-height: 160px;
  overflow-y: auto;
}
</style>
