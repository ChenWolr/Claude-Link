<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue';
import type { Message } from '../../../shared/types/session';
import MessageBubble from './MessageBubble.vue';
import StreamRenderer from './StreamRenderer.vue';
import ProcessGroup from './ProcessGroup.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import StalledBanner from './StalledBanner.vue';
import ApiRetryBanner from './ApiRetryBanner.vue';
import { groupMessagesForRender, computeStats, type RenderItem } from '../../utils/group-messages';
import { useSessionStore } from '../../stores/session-store';
import { useNow } from '../../composables/use-now';

const props = defineProps<{
  messages: Message[];
  streamingContent: string;
  streamingThinking: string;
  streamingTool: string;
  sending?: boolean;
  // 导出模式：直接渲染稳定 RenderItem 切片（隐藏 renderer 预分组好），不重复分组、不流式去重、
  // 不自动滚底、不短会话贴底、关闭交互。exportItems 存在时优先用它。
  exportMode?: boolean;
  exportItems?: RenderItem[];
}>();

const sessionStore = useSessionStore();
const container = ref<HTMLElement | null>(null);

// 问题 1+2：实时计时器。sending 期间 useNow 每 100ms 跳动，整个回复过程常驻显示「⏱ X.Xs」，
// 让用户始终明确「正在回复」（取代只在首个 token 前一闪而过的「正在思考」）。
const { now } = useNow(() => !!props.sending);
const elapsedMs = computed(() => {
  const start = sessionStore.activeTurnStartedAt;
  if (!start) return 0;
  return Math.max(0, now.value - start);
});
function formatElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  return `${m}:${String(rs).padStart(2, '0')}`;
}

// 主聊天流：parentAgentId === null 的消息（子 agent 过程抽到右侧「子Agent」Tab）。
// 分组规则（最小颗粒度 + 因果配对 + 正文独立气泡）见 utils/group-messages.ts。
const mainFlowMessages = computed(() => props.messages.filter((m) => !m.parentAgentId));

// 力度② turn-boundary 去重：发送中，若对应流式块非空（流式端点），隐藏本回合已落库的
// text/thinking（message 事件已即时落库为唯一真相，流式块负责实时预览，二者不重复显示）；
// 流式为空（非流式端点）则正常显示已落库内容。工具/系统组始终显示。回合结束(sending=false)
// 流式清空，已落库 text/thinking 接管显示——多段正文按原位穿插呈现（设计决策 #6）。
const renderItems = computed<RenderItem[]>(() => {
  // 导出模式：渲染隐藏 renderer 预分组好的稳定切片，不重复分组、不流式去重。
  if (props.exportItems) return props.exportItems;
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
      const isMainAssistantText = item.message.role === 'assistant' && item.message.eventType === 'message' && !item.message.parentAgentId;
      if (!(hideText && isMainAssistantText && turnIds.has(item.message.id))) out.push(item);
      continue;
    }
    if (hideThinking) {
      const filtered = item.messages.filter((m) => !(m.role === 'assistant' && m.eventType === 'thinking' && !m.parentAgentId && turnIds.has(m.id)));
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
// 让用户可以手动向上滚动查看历史。导出模式禁用（隐藏窗口不滚底）。
watch(
  () => props.messages.length,
  async () => {
    if (props.exportMode) return;
    await nextTick();
    if (container.value) {
      container.value.scrollTop = container.value.scrollHeight;
    }
  },
);

// 发送者角色：fold（思考/工具过程）算 assistant 侧，message 按 role 判断。
// 用于间距分组：同一发送者的连续消息间距收紧，发送者切换时间距加大。
function getEffectiveRole(item: RenderItem): 'user' | 'assistant' {
  if (item.type === 'fold') return 'assistant';
  return item.message.role === 'user' ? 'user' : 'assistant';
}

function isSenderTransition(idx: number): boolean {
  if (idx === 0) return false;
  return getEffectiveRole(renderItems.value[idx - 1]) !== getEffectiveRole(renderItems.value[idx]);
}

// 流式元素（status/thinking/tool/stream）都是 assistant 侧。
// 若上一条已落库消息来自 user，则此处发生发送者切换，需要加宽间距。
function isStreamTransition(): boolean {
  const items = renderItems.value;
  if (items.length === 0) return false;
  return getEffectiveRole(items[items.length - 1]) === 'user';
}

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
  <div class="message-list" :class="{ 'message-list--export': exportMode }">
    <div ref="container" class="message-list__scroller" @click="handleCopyClick">
      <template v-for="(item, idx) in renderItems" :key="item.key">
        <ProcessGroup
          v-if="item.type === 'fold'"
          :class="{ 'msg-transition': isSenderTransition(idx) }"
          :messages="item.messages"
          :stats="item.stats"
          :active="item.key === activeFoldId"
          :exportMode="exportMode"
        />
        <MessageBubble v-else :class="{ 'msg-transition': isSenderTransition(idx) }" :message="item.message" :exportMode="exportMode" />
      </template>
      <div v-if="sending || streamingContent || streamingThinking || streamingTool || sessionStore.activeStalledInfo || sessionStore.activeApiRetryInfo || sessionStore.activeApiRetryTerminalFallback" class="stream-group" :class="{ 'msg-transition': isStreamTransition() }">
        <!-- 问题 1+2：实时计时器——整个 sending 期间常驻；动画点在整个工作阶段跳动。 -->
        <div v-if="sending" class="turn-timer">
          <span class="turn-timer__time">⏱ {{ formatElapsed(elapsedMs) }}</span>
          <!-- R5（问题 1）：动画点在整个「工作阶段」（最终正文未流出时）常驻跳动，不再只在一闪而过的
               pre-token 窗口显示——让用户始终看到「正在回复」的动态反馈。「正在思考…」文字仅 pre-token。 -->
          <span v-if="!streamingContent" class="turn-timer__working">
            <span class="turn-timer__dots"><span></span><span></span><span></span></span>
            <span v-if="!streamingThinking && !streamingTool" class="turn-timer__label">Claude 正在思考…</span>
          </span>
        </div>
        <!-- 卡死检测横幅：主进程看门狗判定无响应时显形，提供 继续等待/重试/中断。 -->
        <StalledBanner />
        <!-- Bug4/Bug5：API 重试瞬态指示器（不落库、不进聊天流），计数本回合累计递增。 -->
        <ApiRetryBanner />
        <ThinkingBlock v-if="streamingThinking" :content="streamingThinking" streaming />
        <div v-if="streamingTool" class="tool-stream">
          <span class="tool-stream__label">🔧 正在调用工具…</span>
          <pre class="tool-stream__content">{{ streamingTool }}</pre>
        </div>
        <StreamRenderer v-if="streamingContent" :content="streamingContent" />
      </div>
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
  /* 水平 padding 动态：宽窗口撑开使消息内容限宽居中（≈800px），窄窗口回退 24px。
     scroller 全宽 → 垂直滚动条贴右侧边栏（任务面板），不再被挤到限宽列中央。 */
  padding: 20px max(24px, calc((100% - var(--chat-bottom-max-width)) / 2));
  display: flex;
  flex-direction: column;
  /* 同一发送者的连续消息间距收紧（0.25rem = 4px@medium）；
     发送者切换处由 :deep(.msg-transition) 叠加 margin-top 加宽至 1rem。 */
  gap: 0.25rem;
}

/* 发送者切换（user→assistant / assistant→user）：额外加宽间距（问题 4）。
   gap(0.25rem) + margin-top(2.25rem) ≈ 2.5rem 总间距（二次修复：用户反馈再大一点）。 */
:deep(.msg-transition) {
  margin-top: 2.25rem;
}

/* 流式元素容器：思考/工具/正文流式渲染都在此容器内，内部间距紧凑。
   容器本身的间距由 .msg-transition 控制（user→assistant 切换时加宽）。 */
.stream-group {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

/* 消息少时贴底、消息多时可自由向上滚动。
 * 不能用 justify-content: flex-end——它会让溢出内容被推到 scrollTop=0 之上的
 * 不可访问区域，导致历史消息无法滚动查看。改用 ::before + margin-bottom:auto：
 * 内容不足时 auto 吸收剩余空间把消息推到底部；溢出时 auto 归零，正常滚动。 */
.message-list__scroller::before {
  content: '';
  margin-bottom: auto;
}

/* 导出模式：自然文档高度、不滚底、不贴底伪元素、关闭动画/光标/选择。
 * 覆盖主聊天样式（height:100%/overflow:hidden → 自然高度），由隐藏 export renderer 复用同一组件。 */
.message-list--export {
  flex: none;
  min-height: 0;
}
.message-list--export .message-list__scroller {
  height: auto;
  overflow: visible;
  padding: 0;
  gap: 0.25rem;
}
.message-list--export .message-list__scroller::before {
  display: none;
}
.message-list--export :deep(*) {
  animation: none !important;
  transition: none !important;
  caret-color: transparent;
}
.message-list--export :deep(.code-block pre) {
  white-space: pre-wrap;
  word-break: break-word;
}

/* 问题 1+2：实时计时器胶囊——左对齐（assistant 侧），整个回复期间常驻。 */
.turn-timer {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
  font-size: 0.8125rem;
  color: var(--color-text-muted);
  box-shadow: var(--ring-light);
}

.turn-timer__time {
  color: var(--color-accent-strong);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.turn-timer__working {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.turn-timer__dots {
  display: inline-flex;
  gap: 3px;
}

.turn-timer__dots span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-accent-strong);
  animation: status-dot-pulse 1.4s infinite ease-in-out both;
}

.turn-timer__dots span:nth-child(2) {
  animation-delay: 0.16s;
}

.turn-timer__dots span:nth-child(3) {
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
  box-shadow: inset 0 1px 2px rgba(0,0,0,0.08);
}

.tool-stream__label {
  display: block;
  font-size: 0.6875rem;
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
  font-size: 0.75rem;
  color: var(--color-text-muted);
  max-height: 160px;
  overflow-y: auto;
}
</style>
