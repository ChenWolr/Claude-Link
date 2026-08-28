<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../../stores/session-store';
import { useInteractionStore } from '../../stores/interaction-store';
import { sessionDisplayStatusMeta, type SessionDisplayStatus } from '../../../shared/session-display-status';
import { groupSessionsByProject, type SessionGroup } from '../../utils/group-sessions';

const store = useSessionStore();
const router = useRouter();
const interactionStore = useInteractionStore();

// 侧栏展示状态统一经 store.sessionDisplayStatus 解析（completed > network_interrupted
// > retrying > running > idle），此处只做投影，供模板绑定 class 与可访问文案。
function displayStatus(sessionId: string): SessionDisplayStatus {
  return store.sessionDisplayStatus(sessionId);
}
function statusLabel(sessionId: string): string {
  return sessionDisplayStatusMeta(displayStatus(sessionId)).label;
}
const searchQuery = ref('');
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// 项目分组开关：false=全部（不分组，默认），true=按项目（workingDir）分组展示。
// 点击「项目」切换分组，再点「全部」取消分组。
const groupByProject = ref(false);

// 分组视图：关闭时返回单个「全部」组（不渲染组头）；开启时按 workingDir 分组。
// 分组作用于 displayedSessions，天然兼容搜索态（searchResults）。
const viewGroups = computed<SessionGroup[]>(() => {
  if (!groupByProject.value) {
    return [{ key: 'all', label: '', dir: null, sessions: store.displayedSessions }];
  }
  return groupSessionsByProject(store.displayedSessions);
});

// 批量删除模式：开启后会话显示复选框、点击切换选中（不再跳转会话），
// 底部批量操作条提供全选/删除所选。删除走 store.deleteSessions → 单个删除同一条
// 物理删除 IPC 链（停 query/队列 → DELETE 级联删库 → 清理附件物理文件）。
const batchMode = ref(false);
const selectedIds = ref(new Set<string>());

const allSelected = computed(
  () =>
    store.displayedSessions.length > 0 &&
    store.displayedSessions.every((s) => selectedIds.value.has(s.id)),
);

function toggleBatchMode() {
  batchMode.value = !batchMode.value;
  selectedIds.value = new Set();
}

function toggleSelected(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

function toggleSelectAll() {
  selectedIds.value = allSelected.value
    ? new Set()
    : new Set(store.displayedSessions.map((s) => s.id));
}

async function confirmBatchDelete() {
  const count = selectedIds.value.size;
  if (!count) return;
  const ok = await interactionStore.requestConfirm({
    title: '批量删除会话',
    message: `确定删除选中的 ${count} 个会话？会话及其全部消息、任务与附件将被永久删除，此操作不可撤销。`,
    confirmText: '删除',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;
  await store.deleteSessions([...selectedIds.value]);
  batchMode.value = false;
  selectedIds.value = new Set();
}

onMounted(() => {
  store.loadSessions();
});

function handleNewSession() {
  // 新会话延迟持久化：不落库，进入/回到暂态草稿；已有暂态则原地回到它（内容保留）。
  store.startTransientSession();
  router.push('/');
}

async function openSession(session: { id: string }) {
  const found = store.sessions.find((s) => s.id === session.id);
  if (found) {
    await store.switchSession(found);
    router.push('/');
  }
}

// 侧栏搜索与 SessionsPage 行为对齐：250ms 防抖 → store.searchSessions
// （IPC 仅匹配会话标题，不含会话内消息/附件）。store 通过 searchResults 视图态隔离，不污染全量 sessions。
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
      placeholder="搜索会话标题"
      @input="onSearchInput"
      @search="handleSearchClear"
    />

    <div class="sidebar__toolbar">
      <div class="seg" :class="{ 'seg--project': groupByProject }" role="group" aria-label="会话分组方式">
        <span class="seg__thumb" aria-hidden="true"></span>
        <button
          type="button"
          :class="['seg__btn', { 'seg__btn--active': !groupByProject }]"
          @click="groupByProject = false"
        >
          全部
        </button>
        <button
          type="button"
          :class="['seg__btn', { 'seg__btn--active': groupByProject }]"
          @click="groupByProject = true"
        >
          项目
        </button>
      </div>
      <button
        type="button"
        class="sidebar__multiselect"
        :class="{ 'sidebar__multiselect--active': batchMode }"
        :title="batchMode ? '退出批量删除' : '批量删除'"
        :aria-label="batchMode ? '退出批量删除' : '批量删除'"
        @click="toggleBatchMode"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 6h18" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
        </svg>
      </button>
    </div>

    <nav class="sidebar__sessions">
      <template v-for="group in viewGroups" :key="group.key">
        <div v-if="groupByProject" class="sidebar__group" :title="group.dir ?? undefined">
          <span class="sidebar__group__label">{{ group.label }}</span>
          <span class="sidebar__group__count">{{ group.sessions.length }}</span>
        </div>
        <div
          v-for="session in group.sessions"
          :key="session.id"
          :class="['session-link', {
            active: store.activeSession?.id === session.id,
            'session-link--selected': batchMode && selectedIds.has(session.id),
            'session-link--running': displayStatus(session.id) === 'running',
            'session-link--retrying': displayStatus(session.id) === 'retrying',
            'session-link--completed': displayStatus(session.id) === 'completed',
            'session-link--network-interrupted': displayStatus(session.id) === 'network_interrupted',
          }]"
          @click="batchMode ? toggleSelected(session.id) : openSession(session)"
        >
          <input
            v-if="batchMode"
            class="session-link__check"
            type="checkbox"
            :checked="selectedIds.has(session.id)"
            @click.stop="toggleSelected(session.id)"
          />
          <span
            v-if="displayStatus(session.id) !== 'idle'"
            class="session-link__status"
            :class="[`session-link__status--${displayStatus(session.id)}`]"
            role="img"
            :aria-label="statusLabel(session.id)"
            :title="statusLabel(session.id)"
          ></span>
          <span class="session-link__name">{{ session.name }}</span>
          <button
            v-if="!batchMode"
            type="button"
            class="session-link__delete"
            title="删除会话"
            @click.stop="confirmDelete(session)"
          >
            ×
          </button>
        </div>
      </template>
      <div v-if="!store.displayedSessions.length" class="sidebar__empty">
        {{ store.searchQuery ? '未找到匹配的会话' : '暂无会话' }}
      </div>
    </nav>

    <div v-if="batchMode" class="sidebar__batchbar">
      <label class="sidebar__batchbar__all">
        <input type="checkbox" :checked="allSelected" @change="toggleSelectAll" />
        <span>全选</span>
      </label>
      <button
        type="button"
        class="sidebar__batchbar__delete"
        :disabled="!selectedIds.size"
        @click="confirmBatchDelete"
      >
        删除{{ selectedIds.size ? ` (${selectedIds.size})` : '' }}
      </button>
    </div>

    <div class="sidebar__footer">
      <button class="new-button" type="button" :class="{ 'new-button--active': store.activeSession?.transient }" @click="handleNewSession">+ 新会话</button>
      <div class="sidebar__footer-links">
        <RouterLink class="settings-link" to="/config">配置</RouterLink>
      </div>
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

/* 工具条：分组开关 + 批量删除按钮一行，紧贴搜索框下方。 */
.sidebar__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

/* 分组开关：等宽左右切换（全部/项目）。seg 相对定位承载滑动滑块 thumb，
   未选中时 thumb 停在「全部」，选中「项目」时滑到右侧。 */
.seg {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 3px;
  gap: 2px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  box-shadow: var(--ring-light);
}

.seg__thumb {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: calc(50% - 4px);
  border-radius: calc(var(--radius-md) - 3px);
  background: var(--color-accent);
  box-shadow: var(--ring-light-accent), var(--elevation-1);
  transition: transform var(--duration-base) var(--ease-out);
}

/* 补偿 2px gap，确保滑块精确覆盖「项目」按钮，不露边。 */
.seg--project .seg__thumb {
  transform: translateX(calc(100% + 2px));
}

.seg__btn {
  position: relative;
  z-index: 1;
  flex: 1;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 0.75rem;
  font-weight: 600;
  border-radius: calc(var(--radius-md) - 3px);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out);
}

.seg__btn--active {
  color: var(--color-on-accent);
}

/* 批量删除按钮：图标按钮（垃圾桶），进入多选删除模式；激活时红色填充回显。 */
.sidebar__multiselect {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
    border-color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
}

.sidebar__multiselect:hover {
  border-color: var(--color-danger);
  color: var(--color-danger);
}

.sidebar__multiselect--active {
  background: var(--color-danger);
  border-color: var(--color-danger);
  color: var(--color-on-accent);
  box-shadow: var(--ring-light-accent);
}

.sidebar__multiselect svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 项目分组头：组名 + 计数，紧贴下一组卡片。 */
.sidebar__group {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  padding: 2px 4px;
}

.sidebar__group:first-child {
  margin-top: 0;
}

.sidebar__group__label {
  flex: 1;
  min-width: 0;
  font-size: 0.6875rem;
  font-weight: 700;
  color: var(--color-accent-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar__group__count {
  flex-shrink: 0;
  font-size: 0.625rem;
  color: var(--color-text-muted);
  background: var(--color-panel-soft);
  border-radius: 999px;
  padding: 1px 7px;
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
  background: var(--session-status-color, var(--color-warn));
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--session-status-color, var(--color-warn)) 55%, transparent);
  animation: session-status-pulse 1.2s ease-in-out infinite;
}
/* 会话状态灯四态（颜色经 --session-status-color 继承，圆点/pulse 阴影共用变量）：
   running = 黄灯呼吸闪烁；retrying = 红灯呼吸闪烁（同一条 pulse keyframes）；
   completed = 静态绿灯；network_interrupted = 静态红灯（显式 animation: none）。
   idle 不渲染（无状态点）；颜色不只依赖颜色本身——状态点带 role="img" +
   aria-label/title 供辅助技术读取（reduced-motion 下红闪/黄闪会停动画，文案不可省）。 */
.session-link--running {
  --session-status-color: var(--color-warn);
}
.session-link--retrying,
.session-link--network-interrupted {
  --session-status-color: var(--color-danger);
}
.session-link--completed {
  --session-status-color: var(--color-success);
}
.session-link__status--completed,
.session-link__status--network-interrupted {
  box-shadow: none;
  animation: none;
}

@keyframes session-status-pulse {
  0%,
  100% {
    opacity: 1;
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--session-status-color, var(--color-warn)) 55%, transparent);
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

/* 批量删除：复选框 + 选中态高亮。选中态用 accent 描边+淡填充，区别于活动会话的左侧条。 */
.session-link__check {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.session-link--selected {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  box-shadow: inset 0 0 0 1px var(--color-accent);
}

.session-link--selected:hover {
  background: color-mix(in srgb, var(--color-accent) 18%, transparent);
}

/* 批量操作条：多选模式下置底（footer 之上），全选 + 删除所选。 */
.sidebar__batchbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
}

.sidebar__batchbar__all {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.75rem;
  color: var(--color-text-muted);
  cursor: pointer;
}

.sidebar__batchbar__all input {
  width: 14px;
  height: 14px;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.sidebar__batchbar__delete {
  margin-left: auto;
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-danger);
  padding: 5px 12px;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
}

.sidebar__batchbar__delete:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.sidebar__footer {
  display: grid;
  gap: 8px;
}

/* 底部入口：现在只剩「配置」单入口，占满整行。 */
.sidebar__footer-links {
  display: grid;
  grid-template-columns: 1fr;
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

/* 暂态会话激活态（B14）：暂态不进列表、无高亮项，用按钮描边标识「正在暂态草稿」。 */
.new-button--active {
  box-shadow: var(--ring-light-accent), 0 0 0 2px color-mix(in srgb, var(--color-accent) 55%, transparent);
}

.settings-link {
  display: block;
  border: 1px solid var(--color-border);
  text-align: center;
  font-size: 0.8125rem;
}

.settings-link:hover {
  border-color: var(--color-accent);
}
</style>
