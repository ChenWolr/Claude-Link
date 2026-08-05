<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../../stores/session-store';
import { useInteractionStore } from '../../stores/interaction-store';

const store = useSessionStore();
const router = useRouter();
const interactionStore = useInteractionStore();
const searchQuery = ref('');
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

onMounted(() => {
  store.loadSessions();
});

async function handleNewSession() {
  const session = await store.createSession(`会话 ${store.sessions.length + 1}`);
  if (session) {
    await store.switchSession(session);
    router.push('/');
  }
}

async function openSession(session: { id: string }) {
  const found = store.sessions.find((s) => s.id === session.id);
  if (found) {
    await store.switchSession(found);
    router.push('/');
  }
}

// 侧栏搜索与 SessionsPage 行为对齐：250ms 防抖 → store.searchSessions
// （IPC 含消息内容匹配）。store 通过 searchResults 视图态隔离，不污染全量 sessions。
function onSearchInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  const q = searchQuery.value.trim();
  debounceTimer = setTimeout(() => {
    store.searchSessions(q);
  }, 250);
}

function handleSearchClear() {
  searchQuery.value = '';
  store.searchSessions('');
}

// 删除会话：用 interaction 队列的 requestConfirm 确认（避免 window.confirm 导致 Electron 焦点丢失）。
// 会话及消息由主进程级联清理。
async function confirmDelete(session: { id: string; name: string }) {
  const ok = await interactionStore.requestConfirm({
    title: '删除会话',
    message: `确定删除会话「${session.name}」？此操作不可撤销。`,
    confirmText: '删除',
    cancelText: '取消',
    danger: true,
  });
  if (ok) await store.deleteSession(session.id);
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar__brand">
      <div class="brand-mark">CL</div>
      <div>
        <h1>Claude Link</h1>
        <p>Task Console</p>
      </div>
    </div>

    <input
      v-model="searchQuery"
      class="sidebar__search"
      type="search"
      placeholder="搜索会话"
      @input="onSearchInput"
      @search="handleSearchClear"
    />

    <nav class="sidebar__sessions">
      <div
        v-for="session in store.displayedSessions"
        :key="session.id"
        :class="['session-link', {
          active: store.activeSession?.id === session.id,
          'session-link--running': store.sessionStatus[session.id] === 'running',
          'session-link--completed': store.sessionStatus[session.id] === 'completed',
        }]"
        @click="openSession(session)"
      >
        <span
          v-if="store.sessionStatus[session.id]"
          class="session-link__status"
          :class="{ 'session-link__status--completed': store.sessionStatus[session.id] === 'completed' }"
          role="img"
          :aria-label="store.sessionStatus[session.id] === 'completed' ? '任务已完成' : '执行中'"
          :title="store.sessionStatus[session.id] === 'completed' ? '任务已完成' : '执行中'"
        ></span>
        <span class="session-link__name">{{ session.name }}</span>
        <button
          type="button"
          class="session-link__delete"
          title="删除会话"
          @click.stop="confirmDelete(session)"
        >
          ×
        </button>
      </div>
      <div v-if="!store.displayedSessions.length" class="sidebar__empty">
        {{ store.searchQuery ? '未找到匹配的会话' : '暂无会话' }}
      </div>
    </nav>

    <div class="sidebar__footer">
      <button class="new-button" type="button" @click="handleNewSession">+ 新会话</button>
      <RouterLink class="settings-link" to="/config">配置</RouterLink>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  width: var(--sidebar-width);
  min-width: var(--sidebar-width);
  flex-direction: column;
  border-right: 1px solid var(--color-border-strong);
  background: var(--color-panel);
  padding: 16px 12px;
}

.sidebar__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
}

.brand-mark {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  box-shadow: var(--ring-light-accent), var(--elevation-1);
  color: var(--color-on-accent);
  font-size: 0.8125rem;
  font-weight: 800;
}

.sidebar__brand h1 {
  margin: 0;
  font-size: 0.9375rem;
}

.sidebar__brand p {
  margin: 2px 0 0;
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

.sidebar__search {
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 9px 10px;
  outline: none;
}

.sidebar__sessions {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  margin-top: 16px;
  overflow-y: auto;
}

/* 列表 stagger 入场（Layered Console 签名动效）：前 8 项 35ms 阶梯淡入上移，超出无延迟。
   尊重 prefers-reduced-motion（variables.css 已把动效时长压到 1ms，此处再显式关掉位移）。 */
.session-link {
  animation: session-enter var(--duration-base) var(--ease-out) both;
}
.session-link:nth-child(2) { animation-delay: 35ms; }
.session-link:nth-child(3) { animation-delay: 70ms; }
.session-link:nth-child(4) { animation-delay: 105ms; }
.session-link:nth-child(5) { animation-delay: 140ms; }
.session-link:nth-child(6) { animation-delay: 175ms; }
.session-link:nth-child(7) { animation-delay: 210ms; }
.session-link:nth-child(8) { animation-delay: 245ms; }

@keyframes session-enter {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}

.session-link {
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius-md);
  padding: 10px 11px;
  color: var(--color-text);
  cursor: pointer;
  font-size: 0.8125rem;
  transition: background var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}

.session-link__name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-link__status {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-warn);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-warn) 55%, transparent);
  animation: session-status-pulse 1.2s ease-in-out infinite;
}
/* 会话状态灯：running = 黄灯呼吸闪烁（pulse），completed = 静态绿灯（--completed）。
   idle 不渲染（无状态点）；颜色不只依赖颜色本身——状态点带 role="img" +
   aria-label/title 供辅助技术读取。 */
.session-link__status--completed {
  background: var(--color-success);
  box-shadow: none;
  animation: none;
}

@keyframes session-status-pulse {
  0%,
  100% {
    opacity: 1;
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-warn) 55%, transparent);
  }
  50% {
    opacity: 0.55;
    box-shadow: 0 0 0 4px transparent;
  }
}

/* F4：reduced-motion 块必须位于状态灯基础动画声明与 keyframes 之后——媒体查询与基础规则
   同特异性时后声明的规则胜出，放前面会让 pulse 动画覆盖 animation: none，降级失效。 */
@media (prefers-reduced-motion: reduce) {
  .session-link {
    animation: none;
  }
  .session-link__status {
    animation: none;
  }
}

.session-link__delete {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s, transform var(--duration-fast) var(--ease-out);
}

.session-link:hover .session-link__delete {
  opacity: 0.8;
}

.session-link__delete:hover {
  opacity: 1;
  background: rgba(239, 100, 97, 0.18);
  color: var(--color-danger);
}

.session-link:hover {
  background: var(--color-panel-soft);
}

.session-link.active {
  background: color-mix(in srgb, var(--color-accent) 14%, var(--color-panel-soft));
  box-shadow: var(--ring-light);
  border-left: 3px solid var(--color-accent);
  padding-left: 8px;
}

/* active 项的 hover 反馈：.active 与 :hover 同特异性，靠源序 active 在后胜出会吃掉 hover。
   此复合选择器特异性更高，让活动项仍能感知悬停（比 active 的 14% 更深）。 */
.session-link.active:hover {
  background: color-mix(in srgb, var(--color-accent) 22%, var(--color-panel-soft));
}

.sidebar__empty {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  padding: 12px;
  text-align: center;
}

.sidebar__footer {
  display: grid;
  gap: 8px;
}

.new-button,
.settings-link {
  border-radius: var(--radius-md);
  padding: 10px 11px;
  color: var(--color-text);
}

.new-button {
  border: 0;
  background: var(--color-accent);
  box-shadow: var(--ring-light-accent);
  color: var(--color-on-accent);
  font-weight: 700;
}

.settings-link {
  display: block;
  border: 1px solid var(--color-border);
  text-align: center;
}
</style>
