<script setup lang="ts">
// StalledBanner.vue
// 卡死横幅：主进程看门狗判定「无响应」时显形。自包含——直接读 session-store.activeStalledInfo
// 与 useChat()，无需父组件传 props/events。三动作：继续等待（清横幅，靠 hardAbort 兜底）/重试/中断。
import { computed } from 'vue';
import { useSessionStore } from '../../stores/session-store';
import { useChat } from '../../composables/use-chat';

const sessionStore = useSessionStore();
const chat = useChat();

const info = computed(() => sessionStore.activeStalledInfo);

function shortAgent(id: string | null | undefined): string {
  if (!id) return '';
  return id.length > 8 ? id.slice(0, 8) : id;
}
function onWait(): void {
  if (sessionStore.activeSession) sessionStore.clearStalled(sessionStore.activeSession.id);
}
function onAbort(): void {
  void chat.abort();
}
function onRetry(): void {
  void chat.retryLastTurn();
}
</script>

<template>
  <div v-if="info" class="stall-banner" role="status" aria-live="polite">
    <div class="stall-banner__main">
      <span class="stall-banner__icon">⏳</span>
      <span class="stall-banner__text">
        已较长时间无响应（{{ Math.round(info.gapMs / 1000) }}s）
        <span v-if="info.zone === 'tool'" class="stall-banner__tag">工具执行中</span>
        <span v-else class="stall-banner__tag">等待模型</span>
        <span v-if="info.pendingAgentId" class="stall-banner__tag">子Agent {{ shortAgent(info.pendingAgentId) }} 疑似卡住</span>
        <span v-if="info.stallCount > 1" class="stall-banner__tag stall-banner__tag--warn">第 {{ info.stallCount }} 次</span>
      </span>
    </div>
    <div class="stall-banner__actions">
      <button type="button" class="stall-btn stall-btn--ghost" @click="onWait">继续等待</button>
      <button type="button" class="stall-btn stall-btn--ghost" @click="onRetry">重试</button>
      <button type="button" class="stall-btn stall-btn--danger" @click="onAbort">中断</button>
    </div>
  </div>
</template>

<style scoped>
.stall-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 8px 0 4px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  /* 项目无 warn token：用 color-mix 把琥珀色混入主题面板色，随 ThemePalette 自适应。 */
  background: color-mix(in srgb, #f5a623 12%, var(--color-panel-soft));
  border: 1px solid color-mix(in srgb, #f5a623 38%, transparent);
  font-size: 13px;
}
.stall-banner__main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.stall-banner__icon {
  font-size: 15px;
}
.stall-banner__text {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.stall-banner__tag {
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
  color: var(--color-text-muted);
  font-size: 12px;
}
.stall-banner__tag--warn {
  color: var(--color-danger);
}
.stall-banner__actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.stall-btn {
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text);
  font-size: 12px;
  cursor: pointer;
}
.stall-btn:hover {
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
}
.stall-btn--danger {
  border-color: var(--color-danger);
  color: var(--color-danger);
}
.stall-btn--danger:hover {
  background: color-mix(in srgb, var(--color-danger) 14%, transparent);
}
</style>
