<script setup lang="ts">
// TurnTimer.vue
// 方案 A「状态头条」：sending 期间作为输入浮岛的第一行（有 header 语义，非悬浮孤岛）。
// 左侧「呼吸点 + 正在回复 + 递增耗时」，右侧「阶段徽章」（思考中 / 调用工具中 / 工具执行中 / 生成回复中）。
// 信号收敛为一个 ping 呼吸点 + 一个 tabular 计时 + 一个阶段徽章，替代旧版
// 「时钟 SVG + 3 脉冲点 + 条件文字」的四信号堆叠。
// 数据源：markRunning 置 turnStartedAt，markStopped/markCompleted 清除；useNow 每 100ms 跳动驱动递增。
// 阶段直接读 store 流式状态（未防抖，布尔切换更即时；50ms 防抖对阶段徽章无感知差异）。
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
const streamingContent = computed(() => sessionStore.streamingContent);
const streamingTool = computed(() => sessionStore.streamingTool);
// 工具执行中：tool_progress 事件实时置位 toolProgress（toolUseId → 秒数），工具结果到达时 clearToolProgress 清除。
// 全新回合开始时 markRunning 已清残留（见 session-store），故这里读到非空即「当前回合有工具在跑」。
const hasRunningTool = computed(() => Object.keys(sessionStore.toolProgress).length > 0);

// B1：回合结束后的完成态——保留显示上次回复耗时 + 结束时间（持久化，切会话/重启不丢）。
const lastMeta = computed(() => sessionStore.activeLastTurnMeta);
const endClockText = computed(() =>
  lastMeta.value ? new Date(lastMeta.value.endedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '',
);

// 阶段判定（按时间线优先级）：正文流出 → 生成回复中；工具真正执行中（toolProgress 非空）→ 工具执行中；
// 正在吐工具入参（streamingTool）→ 调用工具中；否则（thinking 流式或 pre-token）→ 思考中。
// 阶段徽章在整个 sending 期间常驻（替代旧 pre-token 一闪而过的动画点）。
type Phase = 'thinking' | 'toolCalling' | 'toolRunning' | 'generating';
const phase = computed<Phase>(() => {
  if (streamingContent.value) return 'generating';
  if (hasRunningTool.value) return 'toolRunning';
  if (streamingTool.value) return 'toolCalling';
  return 'thinking';
});
const PHASE_META: Record<Phase, { label: string; mod: string }> = {
  thinking: { label: '思考中', mod: 'turn-timer__phase--thinking' },
  toolCalling: { label: '调用工具中', mod: 'turn-timer__phase--tool-calling' },
  toolRunning: { label: '工具执行中', mod: 'turn-timer__phase--tool-running' },
  generating: { label: '生成回复中', mod: 'turn-timer__phase--generating' },
};
const phaseMeta = computed(() => PHASE_META[phase.value]);
</script>

<template>
  <Transition name="turn-timer" mode="out-in">
    <div v-if="sending" class="turn-timer" role="status" aria-live="polite" title="本次回复进行中（主线程计算时间）">
      <span class="turn-timer__lead">
        <span class="turn-timer__live" aria-hidden="true"></span>
        <span class="turn-timer__label">正在回复</span>
        <span class="turn-timer__time">{{ formatDurationMs(elapsedMs) }}</span>
      </span>
      <span class="turn-timer__phase" :class="phaseMeta.mod">
        <span class="turn-timer__pdot" aria-hidden="true"></span>
        {{ phaseMeta.label }}
      </span>
    </div>
    <div v-else-if="lastMeta" class="turn-timer turn-timer--done" role="status" title="上次回复的耗时与结束时间（已持久化）">
      <span class="turn-timer__lead">
        <span class="turn-timer__done-dot" aria-hidden="true"></span>
        <span class="turn-timer__label">本次回复</span>
        <span class="turn-timer__time">{{ formatDurationMs(lastMeta.durationMs) }}</span>
        <span class="turn-timer__end">· 结束于 {{ endClockText }}</span>
      </span>
    </div>
  </Transition>
</template>

<style scoped>
/* 方案 A「状态头条」：浮岛第一行，整宽 header + 底部细分隔线自然过渡到输入区。
   font-variant-numeric: tabular-nums 固定数字宽度，计时跳动不引起布局抖动（CLS）。 */
.turn-timer {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 8px var(--chat-bottom-pad-x);
  border-bottom: 1px solid var(--color-border);
  font-size: 0.75rem;
}

.turn-timer__lead {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.turn-timer__label {
  color: var(--color-text);
  font-weight: 600;
}

.turn-timer__time {
  color: var(--color-accent-strong);
  font-weight: 700;
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
}

/* 呼吸点：静态核心 + 一圈向外扩散的 ping，进行中的活性指示。 */
.turn-timer__live {
  position: relative;
  width: 8px;
  height: 8px;
  flex-shrink: 0;
}
.turn-timer__live::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--color-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 16%, transparent);
}
.turn-timer__live::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--color-accent);
  animation: turn-timer-ping 2.1s cubic-bezier(0, 0, 0.2, 1) infinite;
}
@keyframes turn-timer-ping {
  0% {
    transform: scale(1);
    opacity: 0.55;
  }
  72%, 100% {
    transform: scale(2.7);
    opacity: 0;
  }
}

/* 工具执行中：阶段点脉冲（与静态「调用工具中」区分，表示工具正在活跃执行）。 */
@keyframes turn-timer-pdot-pulse {
  0%, 100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}

/* 阶段徽章：克制配色（单一色点 + muted 文案），pill 轮廓。 */
.turn-timer__phase {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--color-text) 5%, transparent);
  color: var(--color-text-muted);
  font-size: 0.6875rem;
  white-space: nowrap;
}
.turn-timer__pdot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-accent);
  flex-shrink: 0;
}
.turn-timer__phase--tool-calling .turn-timer__pdot {
  background: var(--color-info);
}
.turn-timer__phase--tool-running .turn-timer__pdot {
  background: var(--color-info);
  animation: turn-timer-pdot-pulse 1.2s ease-in-out infinite;
}
.turn-timer__phase--generating .turn-timer__pdot {
  background: var(--color-success);
}

/* B1 完成态：静态绿点（无 ping）+ muted 结束时刻；数字口径与运行中计时一致（tabular-nums）。 */
.turn-timer--done .turn-timer__time {
  color: var(--color-success);
}
.turn-timer__done-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--color-success);
}
.turn-timer__end {
  color: var(--color-text-muted);
}

/* 出现/消失过渡：高度平滑展开收起（推挤下方输入框但不突兀），对齐微交互节奏。 */
.turn-timer-enter-active,
.turn-timer-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out), max-height var(--duration-fast) var(--ease-out), padding var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out);
  overflow: hidden;
}
.turn-timer-enter-from,
.turn-timer-leave-to {
  opacity: 0;
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  border-bottom-color: transparent;
}
.turn-timer-enter-to,
.turn-timer-leave-from {
  max-height: 44px;
}

/* 无障碍：减少动态时呼吸点 ping 静止。 */
@media (prefers-reduced-motion: reduce) {
  .turn-timer__live::after,
  .turn-timer__phase--tool-running .turn-timer__pdot {
    animation: none;
  }
}
</style>
