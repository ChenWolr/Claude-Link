<script setup lang="ts">
// TurnTimer.vue
// 本回合实时计时器：紧贴会话输入浮岛顶部，sending 期间常驻显示「时钟 + 递增耗时 + 脉冲点」。
// 自包含——直接读 session-store.sending / activeTurnStartedAt / streamingContent 等（同 StalledBanner 风格）。
// 数据源：markRunning 置 turnStartedAt，markStopped/markCompleted 清除；useNow 每 100ms 跳动驱动递增。
// 保留原 MessageList 内嵌计时器的完整语义：动画点在整个工作阶段（正文未流出）常驻，pre-token
// 阶段额外显示「Claude 正在思考…」文字，让用户始终明确「正在回复」。
import { computed } from 'vue';
import { useSessionStore } from '../../stores/session-store';
import { useNow } from '../../composables/use-now';
import { formatDurationMs } from '../../../shared/format-duration';

const sessionStore = useSessionStore();
const sending = computed(() => sessionStore.sending);
const { now } = useNow(() => sending.value);
const elapsedMs = computed(() => {
  const start = sessionStore.activeTurnStartedAt;
  if (!start) return 0;
  return Math.max(0, now.value - start);
});
// pre-token 判断直接读 store 流式状态（未防抖，布尔切换更即时；50ms 防抖对「正在思考」无感知差异）。
const streamingContent = computed(() => sessionStore.streamingContent);
const streamingThinking = computed(() => sessionStore.streamingThinking);
const streamingTool = computed(() => sessionStore.streamingTool);
</script>

<template>
  <Transition name="turn-timer">
    <div v-if="sending" class="turn-timer" role="status" aria-live="polite" title="本次回复耗时（主线程计算时间）">
      <svg class="turn-timer__clock" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3.5 2" />
      </svg>
      <span class="turn-timer__time">{{ formatDurationMs(elapsedMs) }}</span>
      <!-- R5（问题 1）：动画点在整个「工作阶段」（最终正文未流出时）常驻跳动，不再只在一闪而过的
           pre-token 窗口显示。「正在思考…」文字仅 pre-token（无正文/思考/工具流式）。 -->
      <span v-if="!streamingContent" class="turn-timer__working">
        <span class="turn-timer__dots"><span></span><span></span><span></span></span>
        <span v-if="!streamingThinking && !streamingTool" class="turn-timer__label">Claude 正在思考…</span>
      </span>
    </div>
  </Transition>
</template>

<style scoped>
/* 紧贴输入框上方的低调节点：panel-soft 底 + 细边框，与浮岛同色系，不抢视线。
   font-variant-numeric: tabular-nums 固定数字宽度，计时跳动不引起布局抖动（CLS）。 */
.turn-timer {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  align-self: flex-start;
  margin: 2px 0 0 var(--chat-bottom-pad-x);
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
  font-size: 0.75rem;
  color: var(--color-text-muted);
  box-shadow: var(--ring-light);
}

.turn-timer__clock {
  width: 0.8125rem;
  height: 0.8125rem;
  fill: none;
  stroke: var(--color-accent-strong);
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.9;
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

.turn-timer__label {
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

.turn-timer__dots {
  display: inline-flex;
  gap: 3px;
}

.turn-timer__dots span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color-accent-strong);
  animation: turn-timer-pulse 1.4s infinite ease-in-out both;
}

.turn-timer__dots span:nth-child(2) {
  animation-delay: 0.16s;
}

.turn-timer__dots span:nth-child(3) {
  animation-delay: 0.32s;
}

@keyframes turn-timer-pulse {
  0%, 80%, 100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  40% {
    opacity: 1;
    transform: scale(1);
  }
}

/* 出现/消失过渡：高度平滑展开收起（推挤下方输入框但不突兀），150ms 对齐微交互节奏。 */
.turn-timer-enter-active,
.turn-timer-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out), max-height var(--duration-fast) var(--ease-out), margin var(--duration-fast) var(--ease-out);
  overflow: hidden;
}
.turn-timer-enter-from,
.turn-timer-leave-to {
  opacity: 0;
  max-height: 0;
  margin-top: 0;
  margin-bottom: 0;
}
.turn-timer-enter-to,
.turn-timer-leave-from {
  max-height: 40px;
}

/* 无障碍：减少动态时脉冲点静止、过渡近乎瞬切。 */
@media (prefers-reduced-motion: reduce) {
  .turn-timer__dots span {
    animation: none;
  }
}
</style>
