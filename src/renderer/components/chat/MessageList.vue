<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue';
import type { Message } from '../../../shared/types/session';
import MessageBubble from './MessageBubble.vue';
import StreamRenderer from './StreamRenderer.vue';
import ProcessGroup from './ProcessGroup.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import { groupMessagesForRender, computeStats, type RenderItem } from '../../utils/group-messages';
import { useSessionStore } from '../../stores/session-store';

const props = defineProps<{
  messages: Message[];
  streamingContent: string;
  streamingThinking: string;
  streamingTool: string;
  sending?: boolean;
}>();

const sessionStore = useSessionStore();
const container = ref<HTMLElement | null>(null);

// 主聊天流：parentAgentId === null 的消息（子 agent 过程抽到右侧「子Agent」Tab）。
// 分组规则（最小颗粒度 + 因果配对 + 正文独立气泡）见 utils/group-messages.ts。
const mainFlowMessages = computed(() => props.messages.filter((m) => !m.parentAgentId));

// 力度② turn-boundary 去重：发送中，若对应流式块非空（流式端点），隐藏本回合已落库的
// text/thinking（message 事件已即时落库为唯一真相，流式块负责实时预览，二者不重复显示）；
// 流式为空（非流式端点）则正常显示已落库内容。工具/系统组始终显示。回合结束(sending=false)
// 流式清空，已落库 text/thinking 接管显示——多段正文按原位穿插呈现（设计决策 #6）。
const renderItems = computed<RenderItem[]>(() => {
  const all = groupMessagesForRender(mainFlowMessages.value);
  if (!props.sending) return all;
  const hideText = props.streamingContent !== '';
  const hideThinking = props.streamingThinking !== '';
  if (!hideText && !hideThinking) return all;
  // 本回合消息 id 集合（基于 store.messages 的 turnStartIndex）。
  const turnIds = new Set<string>();
  const msgs = sessionStore.messages;
  for (let i = sessionStore.turnStartIndex; i < msgs.length; i += 1) {
    turnIds.add(msgs[i].id);
  }
  // 去重：流式正文非空时隐藏本回合已落库 text；流式思考非空时把 fold 内本回合 thinking
  // 过滤掉（由 streamingThinking 实时显示），其余过程保留，重算 fold stats。
  const out: RenderItem[] = [];
  for (const item of all) {
    if (item.type === 'message') {
      if (!(hideText && turnIds.has(item.message.id))) out.push(item);
      continue;
    }
    if (hideThinking) {
      const filtered = item.messages.filter((m) => !(m.eventType === 'thinking' && turnIds.has(m.id)));
      if (filtered.length === 0) continue;
      if (filtered.length !== item.messages.length) {
        out.push({ ...item, messages: filtered, stats: computeStats(filtered) });
        continue;
      }
    }
    out.push(item);
  }
  return out;
});

// 焦点跟随：发送中，最后一个 fold 自动展开（active）；用户手动展开过的保留。发送结束按 foldable 规则。
const activeFoldId = computed<string | null>(() => {
  if (!props.sending) return null;
  for (let i = renderItems.value.length - 1; i >= 0; i -= 1) {
    const it = renderItems.value[i];
    if (it.type === 'fold') return it.key;
  }
  return null;
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
      <template v-for="item in renderItems" :key="item.key">
        <ProcessGroup
          v-if="item.type === 'fold'"
          :messages="item.messages"
          :stats="item.stats"
          :active="item.key === activeFoldId"
        />
        <MessageBubble v-else :message="item.message" />
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
  gap: 12px;
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
