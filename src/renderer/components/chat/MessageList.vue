<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onBeforeUnmount } from 'vue';
import type { Message } from '../../../shared/types/session';
import MessageBubble from './MessageBubble.vue';
import StreamRenderer from './StreamRenderer.vue';
import ProcessGroup from './ProcessGroup.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import StalledBanner from './StalledBanner.vue';
import ApiRetryBanner from './ApiRetryBanner.vue';
import { groupMessagesForRender, computeStats, type RenderItem } from '../../utils/group-messages';
import { useSessionStore } from '../../stores/session-store';
import { shouldHidePersistedForStreaming } from '../../../shared/turn-boundary';

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
// OPT-6：内层内容 wrapper（ResizeObserver 观察面）。
const innerRef = ref<HTMLElement | null>(null);

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
  // 去重：落库即清（P1-5）后流式块只含「未落库的当前段」，已落库早段不再被本回合批量隐藏、
  // 在后续段流式期间保持原位显示；去重谓词（N12）改「前缀匹配」——流式块以已落库内容为前缀
  // （或相等）即隐藏，覆盖后台快照残留（快照=已落库前缀+新尾巴，切回不再双显）。
  const out: RenderItem[] = [];
  for (const item of all) {
    if (item.type === 'message') {
      const isMainAssistantText = item.message.role === 'assistant' && item.message.eventType === 'message' && !item.message.parentAgentId;
      if (!(hideText && isMainAssistantText && turnIds.has(item.message.id) && shouldHidePersistedForStreaming(item.message.content, props.streamingContent))) out.push(item);
      continue;
    }
    if (hideThinking || hideText) {
      const filtered = item.messages.filter((m) => {
        if (!turnIds.has(m.id)) return true;
        // 前缀命中的已落库 thinking/正文才隐藏（残余双显窗口 + 后台快照前缀残留兜底）。
        if (hideThinking && m.role === 'assistant' && m.eventType === 'thinking' && !m.parentAgentId && shouldHidePersistedForStreaming(m.content, props.streamingThinking)) return false;
        if (hideText && m.role === 'assistant' && m.eventType === 'message' && !m.parentAgentId && shouldHidePersistedForStreaming(m.content, props.streamingContent)) return false;
        return true;
      });
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

// OPT-6：跟底滚动 + 回底按钮。核心约束：用户上滚阅读时不抢滚动。
// - nearBottom（距底 <80px）：新消息/流式内容增长/图片 KaTeX 异步撑高（ResizeObserver 兜住）
//   时自动跟底；
// - 距底超阈值（>400px）显示浮动「回到底部」按钮；
// - 导出模式禁用一切滚动干预（隐藏窗口无交互）。
const nearBottom = ref(true);
const showBackToBottom = ref(false);
let resizeObserver: ResizeObserver | null = null;

function updateBottomState(): void {
  const el = container.value;
  if (!el) return;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  nearBottom.value = distance < 80;
  showBackToBottom.value = distance > 400;
}

function onScroll(): void {
  updateBottomState();
}

function scrollToBottom(): void {
  const el = container.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  nearBottom.value = true;
  showBackToBottom.value = false;
}

watch(
  () => [props.messages.length, props.streamingContent, props.streamingThinking, props.streamingTool] as const,
  async () => {
    if (props.exportMode) return;
    if (!nearBottom.value) return;
    await nextTick();
    scrollToBottom();
  },
);

// OPT-6：会话切换重置跟底状态——nearBottom 是组件级状态，跨会话残留（上一会话上滚未到底），
// 切到新会话时必须复位并滚底，否则新会话首屏停在旧滚动位置（基线行为回退）。
watch(
  () => sessionStore.activeSession?.id,
  async () => {
    if (props.exportMode) return;
    nearBottom.value = true;
    showBackToBottom.value = false;
    await nextTick();
    scrollToBottom();
  },
);

onMounted(() => {
  const el = container.value;
  if (!el || typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver(() => {
    if (props.exportMode) return;
    if (nearBottom.value) {
      el.scrollTop = el.scrollHeight;
    }
    updateBottomState();
  });
  resizeObserver.observe(el);
  // 内容撑高（图片/KaTeX/代码高亮）反映在内层内容盒上：观察面=整个内容 wrapper（OPT-6：
  // 旧实现只盯首条消息，元素身份随内容漂移、非首条异步撑高兜不住）。
  if (innerRef.value) resizeObserver.observe(innerRef.value);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

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
    <div ref="container" class="message-list__scroller" @click="handleCopyClick" @scroll.passive="onScroll">
      <!-- OPT-6：内层内容 wrapper——ResizeObserver 的观察面=整个内容 wrapper（内容整体撑高都
           触发跟底；旧实现只盯首条消息，元素身份随内容漂移、非首条异步撑高兜不住）。 -->
      <div ref="innerRef" class="message-list__inner">
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
        <div v-if="streamingContent || streamingThinking || streamingTool || sessionStore.activeStalledInfo || sessionStore.activeApiRetryInfo || sessionStore.activeApiRetryTerminalFallback" class="stream-group" :class="{ 'msg-transition': isStreamTransition() }">
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
    <!-- OPT-6：回到底部浮动按钮（明显上滚时出现）。
         B2 修复：必须挂在 .message-list（滚动容器的父级）上，不能放进 scroller——
         absolute 定位以滚动容器为包含块时锚定的是「内容坐标」，按钮会随内容滚走
         （实测按钮内容坐标恒定、视口位置随 scrollTop 漂移出屏）。挂在父级才真正
         悬浮于聊天区视口右下角，随显隐逻辑（距底 >400px 出现 / 到底消失）工作。 -->
    <button
      v-if="showBackToBottom && !exportMode"
      type="button"
      class="message-list__back-bottom"
      data-testid="back-to-bottom"
      @click="scrollToBottom"
    >↓ 回到底部</button>
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
  /* B2：回底浮动按钮的定位锚——必须是滚动容器的「父级」。锚在 scroller 自身上时
     absolute 按钮锚定内容坐标随滚动漂移（B2 病根），锚在父级上才稳定悬浮视口右下。 */
  position: relative;
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

/* OPT-6：内层内容 wrapper——ResizeObserver 观察面；承接原 scroller 的纵向排列与
   消息间距（scroller 的 gap 只作用于直接子元素，包 wrapper 后移到这里）。 */
.message-list__inner {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

/* OPT-6：回到底部浮动按钮——明显上滚（距底 >400px）时出现，到底（<80px）消失，悬停高亮。
   定位锚 = .message-list（滚动容器父级，见模板 B2 注释）。 */
.message-list__back-bottom {
  position: absolute;
  right: 24px;
  bottom: 16px;
  z-index: 5;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-panel) 88%, transparent);
  color: var(--color-text);
  font-size: 0.75rem;
  padding: 6px 14px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}
.message-list__back-bottom:hover {
  background: var(--color-panel-strong, var(--color-panel));
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
