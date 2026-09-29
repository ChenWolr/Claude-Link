<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../../stores/session-store';
import { useInteractionStore } from '../../stores/interaction-store';
import { useUpdateStore } from '../../stores/update-store';
import { sessionDisplayStatusMeta, type SessionDisplayStatus } from '../../../shared/session-display-status';
import { groupSessionsByProject, type SessionGroup } from '../../utils/group-sessions';
import { groupSessionsByDate } from '../../utils/group-sessions-by-date';
import { formatSessionTime } from '../../utils/format-session-time';

const store = useSessionStore();
const router = useRouter();
const interactionStore = useInteractionStore();
const updateStore = useUpdateStore();

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

// 项目分组开关：false=全部（按日期分组，默认），true=按项目（workingDir）分组展示。
// 点击「项目」切换分组，再点「全部」取消分组。
const groupByProject = ref(false);

// 「全部」视图改日期分组（今天/昨天/本周更早/更早）；分组作用于 displayedSessions，
// 天然兼容搜索态（searchResults）。
const dateGroups = computed(() => groupSessionsByDate(store.displayedSessions));

// 项目分组视图：按 workingDir 分组（逻辑不变）。
const viewGroups = computed<SessionGroup[]>(() => groupSessionsByProject(store.displayedSessions));

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

// hb12-SMG-03：query 唯一存 store——本地 ref 仅作输入缓冲；store 变化（SessionsPage 搜索、
// loadSessions 条件清搜索态等）经 watch 回写本地，两侧搜索框与空态判断保持一致。
watch(
  () => store.searchQuery,
  (q) => {
    searchQuery.value = q;
  },
);

function handleSearchClear() {
  searchQuery.value = '';
  store.searchSessions('');
}

// 全局快捷键：Ctrl+N 新会话；/ 聚焦搜索（输入态/IME 组合态/可编辑焦点不触发）。
// 不监听 Escape——ChatPage 的 Esc 急停通道独占该键，零冲突。
const searchInputRef = ref<HTMLInputElement | null>(null);
function isEditableTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement ||
    (t instanceof HTMLElement && t.isContentEditable);
}
function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); handleNewSession(); return; }
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing && !isEditableTarget(e.target)) {
    e.preventDefault(); searchInputRef.value?.focus();
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKeydown));
onUnmounted(() => window.removeEventListener('keydown', onGlobalKeydown));

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
      <h1>Claude Link</h1>
    </div>

    <div class="sidebar__new-wrap">
      <button
        class="new-button"
        type="button"
        :class="{ 'new-button--active': store.activeSession?.transient }"
        @click="handleNewSession"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        <span>新会话</span>
        <kbd>Ctrl N</kbd>
      </button>
      <!-- R4：绿色「可更新」徽标——new-button 的兄弟绝对定位元素（不嵌 button 进 button）；
           @click.stop 防冒泡误触发新会话。仅 available/downloading/downloaded 三态可见。 -->
      <button
        v-if="updateStore.badgeVisible"
        class="update-badge"
        type="button"
        data-testid="update-badge"
        :title="`发现新版本 v${updateStore.state.newVersion ?? ''}，点击查看`"
        @click.stop="router.push({ path: '/config', query: { tab: 'about', v: Date.now().toString(36) } })"
      >可更新</button>
    </div>

    <div class="sidebar__search-wrap">
      <svg class="sidebar__search-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        ref="searchInputRef"
        v-model="searchQuery"
        class="sidebar__search"
        type="search"
        placeholder="搜索会话标题"
        @input="onSearchInput"
        @search="handleSearchClear"
      />
      <span class="sidebar__search-slash" aria-hidden="true">/</span>
    </div>

    <div class="sidebar__tabs" role="group" aria-label="会话分组方式">
      <button
        type="button"
        :class="['sidebar__tab', { 'sidebar__tab--active': !groupByProject }]"
        @click="groupByProject = false"
      >
        全部
      </button>
      <button
        type="button"
        :class="['sidebar__tab', { 'sidebar__tab--active': groupByProject }]"
        @click="groupByProject = true"
      >
        项目
      </button>
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

    <nav class="sidebar__sessions" :class="{ batching: batchMode }">
      <template v-if="!groupByProject">
        <template v-for="group in dateGroups" :key="group.key">
          <div class="sidebar__group">
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
            <!-- hb10-PERM-05：后台会话 pending 弹窗可见性 badge -->
            <span
              v-if="interactionStore.pendingRemoteCountBySession[session.id]"
              class="session-link__pending"
              title="该会话有待确认的弹窗"
            >⏳</span>
            <span class="session-link__time">{{ formatSessionTime(session.updatedAt) }}</span>
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
      </template>
      <template v-else>
        <template v-for="group in viewGroups" :key="group.key">
          <div class="sidebar__group" :title="group.dir ?? undefined">
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
            <!-- hb10-PERM-05：后台会话 pending 弹窗可见性 badge -->
            <span
              v-if="interactionStore.pendingRemoteCountBySession[session.id]"
              class="session-link__pending"
              title="该会话有待确认的弹窗"
            >⏳</span>
            <span class="session-link__time">{{ formatSessionTime(session.updatedAt) }}</span>
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
      <RouterLink class="settings-link" to="/config">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span>配置</span>
      </RouterLink>
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
  padding: 14px 12px 12px;
}

/* 品牌行：20px CL 方标（accent 底）+ 名称，无副标/版本号。 */
.sidebar__brand {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 2px 4px 0;
  margin-bottom: 14px;
}

.brand-mark {
  display: grid;
  width: 20px;
  height: 20px;
  flex: none;
  place-items: center;
  border-radius: 6px;
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-size: 0.59375rem;
  font-weight: 800;
  letter-spacing: 0.02em;
}

.sidebar__brand h1 {
  margin: 0;
  font-size: 0.8125rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}

/* 主操作上位：新会话（描边扁平按钮 + Ctrl N 快捷键提示）。 */
.new-button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-panel);
  color: var(--color-text);
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out);
}

.new-button:hover {
  background: var(--color-panel-soft);
}

.new-button svg {
  width: 14px;
  height: 14px;
  flex: none;
  fill: none;
  stroke: var(--color-text-muted);
  stroke-width: 2;
  stroke-linecap: round;
}

.new-button kbd {
  margin-left: auto;
  font-family: inherit;
  font-size: 0.65625rem;
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 1px 5px;
  background: var(--color-bg);
}

/* 暂态会话激活态（B14）：暂态不进列表、无高亮项，按钮 inset 左缘条标识「正在暂态草稿」。 */
.new-button--active {
  border-color: var(--color-accent);
  box-shadow: inset 2px 0 0 var(--color-accent);
}

/* 徽标容器：new-button 包裹层，作兄弟绝对定位徽标的锚点。 */
.sidebar__new-wrap {
  position: relative;
}

/* 绿色「可更新」徽标：叠加在新会话按钮右上角（R4）。底色 --color-success-strong 恒深绿
   （不随色板），白字必须用专 token --color-on-success（on-accent 按各色板 accent 亮度选，
   四套色板下会落到近黑字、对比度 <AA，P3-1）；hover 不换浅底（--color-success 上白字
   仅 3.31:1），以浮起阴影作反馈。 */
.update-badge {
  position: absolute;
  top: -7px;
  right: -5px;
  z-index: 1;
  border: 1px solid var(--color-success-strong);
  border-radius: 999px;
  background: var(--color-success-strong);
  color: var(--color-on-success);
  padding: 1px 7px;
  font-size: 0.625rem;
  font-weight: 650;
  line-height: 1.4;
  cursor: pointer;
  box-shadow: var(--ring-light);
}

.update-badge:hover {
  box-shadow: var(--ring-light), var(--elevation-1);
}

/* 搜索框：放大镜 + 输入 + 「/」聚焦提示角标。 */
.sidebar__search-wrap {
  position: relative;
  margin-top: 10px;
}

.sidebar__search-icon {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  width: 13px;
  height: 13px;
  fill: none;
  stroke: var(--color-text-muted);
  stroke-width: 2;
  stroke-linecap: round;
  pointer-events: none;
}

.sidebar__search {
  width: 100%;
  height: 30px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0 30px 0 28px;
  font-size: 0.78125rem;
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
}

.sidebar__search::placeholder {
  color: var(--color-text-muted);
}

.sidebar__search:focus {
  border-color: var(--color-accent);
  background: var(--color-panel);
}

/* 原生 search 清除钮与「/」角标位置重叠，隐藏后清除走键盘/ESC（@search 事件保留）。 */
.sidebar__search::-webkit-search-cancel-button {
  -webkit-appearance: none;
  appearance: none;
}

.sidebar__search-slash {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 0.65625rem;
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 0 5px;
  background: var(--color-panel);
  pointer-events: none;
}

/* 页签行：文字页签 + 下划线活动态；批量删除图标钮收同一行右端（armed 红底）。 */
.sidebar__tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 12px;
  padding: 0 4px;
  border-bottom: 1px solid var(--color-border);
}

.sidebar__tab {
  position: relative;
  border: 0;
  background: none;
  cursor: pointer;
  padding: 6px 8px 8px;
  font-size: 0.78125rem;
  font-weight: 600;
  color: var(--color-text-muted);
  transition: color var(--duration-fast) var(--ease-out);
}

.sidebar__tab--active {
  color: var(--color-text);
}

.sidebar__tab--active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--color-accent);
}

.sidebar__multiselect {
  margin-left: auto;
  margin-bottom: 3px;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.sidebar__multiselect:hover {
  background: var(--color-panel-soft);
  color: var(--color-danger);
}

.sidebar__multiselect--active {
  background: var(--color-danger);
  color: var(--color-on-accent);
}

.sidebar__multiselect svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 分组头：组名 + 计数（日期分组与项目分组共用）。 */
.sidebar__group {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 14px 6px 5px;
}

.sidebar__group:first-child {
  padding-top: 6px;
}

.sidebar__group__label {
  flex: 1;
  min-width: 0;
  font-size: 0.65625rem;
  font-weight: 650;
  letter-spacing: 0.07em;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar__group__count {
  flex: none;
  font-size: 0.65625rem;
  font-weight: 600;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.sidebar__sessions {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  margin-top: 8px;
  padding: 0 2px 8px;
  overflow-y: auto;
}

/* 列表 stagger 入场（签名动效）：前 8 项 35ms 阶梯淡入上移，超出无延迟。
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

/* 会话行：30px 紧凑单行（状态点 + 名称 + ⏳ + 时间列 + hover 删除 ×）。 */
.session-link {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  flex: none;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  color: var(--color-text);
  cursor: pointer;
  font-size: 0.8125rem;
  transition: background var(--duration-fast) var(--ease-out);
}

.session-link:hover {
  background: var(--color-panel-soft);
}

/* 活动行：accent 8% 混色 + 加粗（Quiet Console 无左缘条）。 */
.session-link.active {
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-panel-soft));
  font-weight: 600;
}

.session-link.active:hover {
  background: color-mix(in srgb, var(--color-accent) 14%, var(--color-panel-soft));
}

.session-link__name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* hb10-PERM-05：后台 pending 弹窗 badge（⏳ 字面量为契约钉死，勿改图标）。 */
.session-link__pending {
  flex: none;
  font-size: 0.6875rem;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--color-warn) 16%, transparent);
}

.session-link__time {
  flex: none;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.session-link__delete {
  flex: none;
  display: none;
  width: 18px;
  height: 18px;
  place-items: center;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  line-height: 1;
  cursor: pointer;
}

/* hover 时时间列与删除 × 互斥显隐（纯 CSS）。 */
.session-link:hover .session-link__delete {
  display: grid;
}

.session-link:hover .session-link__time {
  display: none;
}

/* 批量模式：删除钮不渲染，hover 隐藏时间列只会留行尾空白——恢复显示。 */
.sidebar__sessions.batching .session-link:hover .session-link__time {
  display: inline;
}

.session-link__delete:hover {
  background: color-mix(in srgb, var(--color-danger) 18%, transparent);
  color: var(--color-danger);
}

.session-link__status {
  flex: none;
  width: 6px;
  height: 6px;
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
.session-link__status--network_interrupted {
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

/* 批量删除：复选框 + 选中态高亮。选中态用 accent 描边+淡填充，区别于活动行混色。 */
.session-link__check {
  flex: none;
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

.sidebar__empty {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  padding: 12px;
  text-align: center;
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

/* 页脚：分隔线 + 配置入口（图标+文字）；新会话已上移，无引擎 LED（renderer 无数据源，见计划 §6）。 */
.sidebar__footer {
  display: flex;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
}

.settings-link {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: 0.78125rem;
  text-decoration: none;
  transition: background var(--duration-fast) var(--ease-out);
}

.settings-link:hover {
  background: var(--color-panel-soft);
}

.settings-link svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
}
</style>
