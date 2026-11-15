<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../../stores/session-store';
import { useInteractionStore } from '../../stores/interaction-store';
import { useUpdateStore } from '../../stores/update-store';
import { sessionDisplayStatusMeta, type SessionDisplayStatus } from '../../../shared/session-display-status';
import { groupSessionsByProject, projectLabel, type SessionGroup } from '../../utils/group-sessions';
import { groupSessionsByDate } from '../../utils/group-sessions-by-date';
import { formatSessionTime } from '../../utils/format-session-time';
import { useHoldAction } from '../../composables/use-hold-action';
import { useChat } from '../../composables/use-chat';

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
  const label = sessionDisplayStatusMeta(displayStatus(sessionId)).label;
  // idle 元数据 label 为空串；卡片化后 idle 也渲染灰状态块（效果图 A），补可访问文案。
  return label || '空闲';
}

// ── UI13-P3：侧栏中断（委托式长按，条目 12 + 契约 #3）──
// v-for 内不能每行各持一个 useHoldAction 实例——单一 hold 状态 + holdTargetId 单槽位委托：
// @pointerdown 先把目标会话 id 写入槽位再启动计时，完成回调按槽位触发中断（canInterrupt 复查
// 防幽灵 abort：长按进行中回合自然结束、按钮 v-if 卸载后 rAF 仍在跑，最迟 1s 迟发——复查
// 终态已翻 false 即 no-op）。活动会话走 useChat().abort()（乐观清流式/复位 sending 全套，
// 与聊天区 SessionToolbar 同链路）；后台会话直调 abortChat IPC，终态由主进程 aborted 事件
// 收口（后台事件按 sessionId 停表投影），侧栏不乐观改态。
const holdTargetId = ref<string | null>(null);
const { abort: abortActive } = useChat();
async function interruptSession(session: { id: string }): Promise<void> {
  if (session.id === store.activeSession?.id) await abortActive();
  else await window.claudeLink.abortChat(session.id).catch(() => { /* 终态事件兜底，IPC 失败静默 */ });
}
const interruptHold = useHoldAction(() => {
  const target = holdTargetId.value;
  if (target && canInterrupt(target)) void interruptSession({ id: target });
});
const { holdProgress: interruptHoldProgress, holding: interruptHolding } = interruptHold;
function canInterrupt(sessionId: string): boolean {
  const s = displayStatus(sessionId);
  return s === 'running' || s === 'retrying';
}
const searchQuery = ref('');
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// 项目分组开关：false=全部（按日期分组，默认），true=按项目（workingDir）分组展示。
// 点击「项目」切换分组，再点「全部」取消分组。
const groupByProject = ref(false);

// 「全部」视图改日期分组（今天/昨天/本周更早/更早）；分组作用于 displayedSessions，
// 天然兼容搜索态（searchResults）。
const dateGroups = computed(() => groupSessionsByDate(store.displayedSessions));

// 项目分组视图：按 workingDir 分组（UI13-P3 起置顶跨组提取为 __pinned__ 组）。
const viewGroups = computed<SessionGroup[]>(() => groupSessionsByProject(store.displayedSessions));

// UI13-P3：双视图模板收敛——日期组（DateSessionGroup 无 dir 字段）归一为 SessionGroup 形态
//（dir: null，分组头 :title 不渲染），单一卡片模板 v-for renderGroups 消除日期/项目两份重复块。
const renderGroups = computed<SessionGroup[]>(() =>
  groupByProject.value ? viewGroups.value : dateGroups.value.map((g) => ({ key: g.key, label: g.label, dir: null, sessions: g.sessions })),
);

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

function handleSearchClear(evt: Event) {
  // A2（D01-F1）：type=search 的 @search 事件在按 Enter 时同样触发（Chromium 行为）——
  // 值非空即 Enter 确认，直接 return 保持过滤；点原生 X / 按 Esc 清除时浏览器已把值置空，
  // 守卫放行走清空逻辑恢复全量列表。
  if ((evt.target as HTMLInputElement).value !== '') return;
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
onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown);
  // UI13-P11（条目 9）：卸载清搜索防抖计时器（设置页↔聊天往返卸载重挂不留悬挂 timer）。
  // P3 侧栏卡片化改版重写本组件时必须保留此清理。
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
});

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
  <aside class="sidebar" :class="{ 'sidebar--collapsed': store.sidebarCollapsed }">
    <!-- UI13-P4 折叠：根类 sidebar--collapsed 由 store.sidebarCollapsed 驱动（窄轨 48px，
         本组件固定宽覆盖 AppLayout 的 --sidebar-width 记忆宽，展开即恢复）。折叠仅 v-if
         卸载展开态主体 DOM（R1 裁决：契约只要求状态不丢）——会话推送订阅全在 App.vue 全局
         （CHAT_EVENT/SESSIONS_CHANGED），store 数据持续更新，展开后列表/状态即时正确；
         批量模式 batchMode/selectedIds 为本组件 setup 层 ref，不随 v-if 卸载丢失。 -->
    <template v-if="!store.sidebarCollapsed">
    <div class="sidebar__brand">
      <div class="brand-mark">CL</div>
      <h1>Claude Link</h1>
      <!-- 绿色「可更新」徽标——品牌行右端并排（2026-09-29 用户反馈：原叠加在新会话按钮
           右上角，侧栏窄时与按钮/标题重叠）。@click.stop 防冒泡误触发新会话。
           仅 available/downloading/downloaded 三态可见。 -->
      <button
        v-if="updateStore.badgeVisible"
        class="update-badge"
        type="button"
        data-testid="update-badge"
        :title="`发现新版本 v${updateStore.state.newVersion ?? ''}，点击查看`"
        @click.stop="router.push({ path: '/config', query: { tab: 'about', v: Date.now().toString(36) } })"
      >可更新</button>
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
      <!-- UI13-P3：双视图收敛——日期/项目两视图统一走 renderGroups，单一卡片模板（变体 A 两行卡）。
           卡片点击：批量模式 checkbox 接管（toggleSelected），否则打开会话。 -->
      <template v-for="group in renderGroups" :key="group.key">
        <div class="sidebar__group" :title="group.dir ?? undefined">
          <span class="sidebar__group__label">{{ group.label }}</span>
          <span class="sidebar__group__count">{{ group.sessions.length }}</span>
        </div>
        <div
          v-for="session in group.sessions"
          :key="session.id"
          :class="['session-card', {
            active: store.activeSession?.id === session.id,
            'session-card--selected': batchMode && selectedIds.has(session.id),
            'session-card--running': displayStatus(session.id) === 'running',
            'session-card--retrying': displayStatus(session.id) === 'retrying',
            'session-card--completed': displayStatus(session.id) === 'completed',
            'session-card--network-interrupted': displayStatus(session.id) === 'network_interrupted',
          }]"
          @click="batchMode ? toggleSelected(session.id) : openSession(session)"
        >
          <div class="session-card__row1">
            <input
              v-if="batchMode"
              class="session-card__check"
              type="checkbox"
              :checked="selectedIds.has(session.id)"
              @click.stop="toggleSelected(session.id)"
            />
            <!-- 状态块（22px 圆角）：四态经 --session-status-color 变量着色（idle 灰块无动画，
                 running/retrying 呼吸）；role="img" + aria/title 供辅助技术读取（不只依赖颜色）。 -->
            <span
              class="session-card__status"
              :class="[`session-card__status--${displayStatus(session.id)}`]"
              role="img"
              :aria-label="statusLabel(session.id)"
              :title="statusLabel(session.id)"
            ></span>
            <!-- UI13-P3：置顶标识 pin 图标常驻标题左侧（accent 填充，非 hover 显隐）。 -->
            <svg class="session-card__pin-mark" v-if="session.pinnedAt != null" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
            </svg>
            <span class="session-card__name">{{ session.name }}</span>
            <!-- hb10-PERM-05：后台会话 pending 弹窗可见性 badge（⏳ 字面量为契约钉死，勿改图标） -->
            <span
              v-if="interactionStore.pendingRemoteCountBySession[session.id]"
              class="session-card__pending"
              title="该会话有待确认的弹窗"
            >⏳</span>
            <!-- 右上角操作组：hover / focus-within 显隐（opacity 键盘可达）；批量模式整组隐藏
                 （中断钮批量不可达防误杀）。中断钮仅 running/retrying，长按 1 秒防误触；
                 @click.stop 阻短按 click 冒泡（.prevent 不拦 click 派发，冒泡到卡片 @click 会误开会话——P2-B）。 -->
            <div v-if="!batchMode" class="session-card__ops">
              <button
                v-if="canInterrupt(session.id)"
                type="button"
                class="session-card__interrupt"
                :class="{ 'session-card__interrupt--holding': interruptHolding && holdTargetId === session.id }"
                title="长按 1 秒中断"
                :aria-label="'中断会话 ' + session.name"
                @pointerdown.prevent="holdTargetId = session.id; interruptHold.onPointerDown($event)"
                @pointermove="interruptHold.onPointerMove($event)"
                @pointerup="interruptHold.onPointerUp($event)"
                @pointerleave="interruptHold.onPointerLeave()"
                @pointercancel="interruptHold.onPointerCancel()"
                @click.stop
                @keydown="interruptHold.onKeydown($event)"
                @keyup="interruptHold.onKeyup($event)"
                @blur="interruptHold.onBlur()"
              >
                <span class="session-card__interrupt-fill" :style="{ width: interruptHolding && holdTargetId === session.id ? `${interruptHoldProgress}%` : '0%' }" aria-hidden="true"></span>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="1.5" />
                </svg>
              </button>
              <!-- P2 会话置顶（点 S4）语义沿用：暂态（未落库）隐藏；title/aria 随态切换。 -->
              <button
                v-if="!session.transient"
                type="button"
                class="session-card__pinbtn"
                :title="session.pinnedAt != null ? '取消置顶' : '置顶会话'"
                :aria-label="(session.pinnedAt != null ? '取消置顶 ' : '置顶会话 ') + session.name"
                @click.stop="store.togglePin(session.id)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
                </svg>
              </button>
              <button
                type="button"
                class="session-card__delete"
                title="删除会话"
                @click.stop="confirmDelete(session)"
              >
                ×
              </button>
            </div>
          </div>
          <div class="session-card__row2">
            <!-- 项目徽章 pill：workingDir 经 projectLabel（末段目录名）；null 不渲染。 -->
            <span
              v-if="session.workingDir"
              class="session-card__proj"
              :title="session.workingDir"
            >{{ projectLabel(session.workingDir) }}</span>
            <span class="session-card__time">{{ formatSessionTime(session.updatedAt) }}</span>
          </div>
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
      <RouterLink class="settings-link" to="/config">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span>配置</span>
      </RouterLink>
      <!-- UI13-P4：底缘折叠触发器（页脚尾追加，与右栏 rail 底部折叠钮镜像对称）——
           « 双箭头指左 = 把侧栏向左收起 -->
      <button
        type="button"
        class="sidebar__collapse"
        title="折叠侧栏"
        aria-label="折叠侧栏"
        @click="store.toggleSidebarCollapsed()"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10.5 4 7 8l3.5 4M6.5 4 3 8l3.5 4" />
        </svg>
      </button>
    </div>
    </template>

    <!-- UI13-P4：折叠窄轨（48px 图标轨）——顶部 brand 方标（点击=展开）+ 新建会话图标钮 +
         底部「»」展开钮（与右栏 rail 底部折叠钮镜像对称，» 双箭头指右 = 把侧栏向右展开）。 -->
    <nav v-else class="sidebar__rail" aria-label="侧栏折叠轨">
      <button
        type="button"
        class="sidebar__rail__mark"
        title="展开侧栏"
        aria-label="展开侧栏"
        @click="store.toggleSidebarCollapsed()"
      >CL</button>
      <button
        type="button"
        class="sidebar__rail__new"
        title="新建会话"
        aria-label="新建会话"
        @click="handleNewSession"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      </button>
      <div class="sidebar__rail__spacer" aria-hidden="true"></div>
      <button
        type="button"
        class="sidebar__rail__expand"
        title="展开侧栏"
        aria-label="展开侧栏"
        @click="store.toggleSidebarCollapsed()"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5.5 4 9 8l-3.5 4M9.5 4 13 8l-3.5 4" />
        </svg>
      </button>
    </nav>
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

/* 品牌行：20px CL 方标（accent 底）+ 名称，无副标/版本号；可更新徽标右端并排。 */
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

/* 绿色「可更新」徽标：品牌行右端并排（2026-09-29 用户反馈，原叠加在新会话按钮右上角
   与按钮/标题重叠，改为文档流内 flex 项）。底色 --color-success-strong 恒深绿
   （不随色板），白字必须用专 token --color-on-success（on-accent 按各色板 accent 亮度选，
   四套色板下会落到近黑字、对比度 <AA，P3-1）；hover 不换浅底（--color-success 上白字
   仅 3.31:1），以浮起阴影作反馈。 */
.update-badge {
  margin-left: auto;
  flex: none;
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
  color: var(--color-on-danger);
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

/* ── UI13-P3 会话卡片化（变体 A：两行卡 ~52px，结构 1:1 对齐 prototypes/sidebar-card-variant-a.html）── */

/* 列表 stagger 入场（签名动效）：前 8 项 35ms 阶梯淡入上移，超出无延迟。
   尊重 prefers-reduced-motion（variables.css 已把动效时长压到 1ms，此处再显式关掉位移）。 */
.session-card {
  animation: session-enter var(--duration-base) var(--ease-out) both;
}
.session-card:nth-child(2) { animation-delay: 35ms; }
.session-card:nth-child(3) { animation-delay: 70ms; }
.session-card:nth-child(4) { animation-delay: 105ms; }
.session-card:nth-child(5) { animation-delay: 140ms; }
.session-card:nth-child(6) { animation-delay: 175ms; }
.session-card:nth-child(7) { animation-delay: 210ms; }
.session-card:nth-child(8) { animation-delay: 245ms; }

@keyframes session-enter {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}

/* 会话卡基座：圆角 + panel 底 + ring/elevation 浮起（效果图 A 卡片语言）。 */
.session-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--color-panel);
  box-shadow: var(--ring-light), var(--elevation-1);
  border: 1px solid transparent;
  color: var(--color-text);
  cursor: pointer;
  font-size: 0.8125rem;
  transition: background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out);
}

.session-card:hover {
  background: color-mix(in srgb, var(--color-text) 4%, var(--color-panel));
}

/* 活动卡：accent 8% 混色（Quiet Console 配色语言延续）+ accent 45% 描边（效果图 A）。 */
.session-card.active {
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-panel-soft));
  border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
}

.session-card.active .session-card__name {
  font-weight: 600;
}

.session-card__row1 {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.session-card__name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}

.session-card__status {
  /* 状态块：22px 圆角小方块（running/retrying 呼吸；completed/network_interrupted/idle 静态——基础声明 + 显式关停组）。 */
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--session-status-color, var(--color-border));
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--session-status-color, var(--color-warn)) 55%, transparent);
  animation: session-status-pulse 1.2s ease-in-out infinite;
}

/* 状态四态着色（颜色经 --session-status-color 继承，块底/pulse 阴影共用变量）：
   running = 黄呼吸；retrying = 红呼吸（同一条 pulse keyframes）；completed = 静态绿；
   network_interrupted = 静态红；idle 无着色类 → 灰块（--color-border fallback）。
   completed/network_interrupted/idle 三静态态均经状态块修饰类显式关停；--idle 由模板
   :class 动态修饰类恒生成（评审 P2-A：关停规则缺位即运行态样式泄漏到静态态）。
   颜色不只依赖颜色本身——状态块带 role="img" + aria-label/title 供辅助技术读取
  （reduced-motion 下呼吸会停，文案不可省）。 */
.session-card--running {
  --session-status-color: var(--color-warn);
}
.session-card--retrying,
.session-card--network-interrupted {
  --session-status-color: var(--color-danger);
}
.session-card--completed {
  --session-status-color: var(--color-success);
}
.session-card__status--completed,
.session-card__status--network_interrupted {
  box-shadow: none;
  animation: none;
}
/* idle 静态化（评审 P2-A）：模板动态修饰类对 idle 恒生成 --idle，缺关停规则则继承基础
   呼吸动画 + box-shadow fallback（--color-warn）呈永久黄光环——运行态样式泄漏到静态态。 */
.session-card__status--idle {
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

/* F4：reduced-motion 块必须位于状态块基础动画声明与 keyframes 之后——媒体查询与基础规则
   同特异性时后声明的规则胜出，放前面会让 pulse 动画覆盖 animation: none，降级失效。 */
@media (prefers-reduced-motion: reduce) {
  .session-card {
    animation: none;
  }
  .session-card__status {
    animation: none;
  }
}

/* 置顶标识：标题左侧 12px accent 填充 pin 图标（常驻，非 hover 显隐——置顶态一眼可辨）。 */
.session-card__pin-mark {
  flex: none;
  width: 12px;
  height: 12px;
  fill: var(--color-accent);
}

/* hb10-PERM-05：后台 pending 弹窗 badge（⏳ 字面量为契约钉死，勿改图标）。 */
.session-card__pending {
  flex: none;
  font-size: 0.6875rem;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--color-warn) 16%, transparent);
}

/* 右上操作组：hover / focus-within 显隐（opacity 不脱 Tab 序，键盘聚焦即显现）；批量模式
   整组 v-if 隐藏（模板层，中断钮批量不可达防误杀）。 */
.session-card__ops {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out);
}

.session-card:hover .session-card__ops,
.session-card:focus-within .session-card__ops {
  opacity: 1;
}

.session-card__ops button {
  position: relative;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  overflow: hidden;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}

.session-card__ops button:hover {
  background: color-mix(in srgb, var(--color-text) 8%, var(--color-panel-soft));
  color: var(--color-text);
}

.session-card__ops button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.session-card__ops svg {
  width: 13px;
  height: 13px;
  fill: currentColor;
}

/* 中断钮：hover 红（危险语义）；内层进度填充 span 长按可视（width 0→100%）。 */
.session-card__interrupt:hover {
  color: var(--color-danger);
}

.session-card__interrupt--holding {
  color: var(--color-danger);
}

.session-card__interrupt-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: color-mix(in srgb, var(--color-danger) 30%, transparent);
  pointer-events: none;
}

.session-card__row2 {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* 项目徽章 pill：panel-soft 底 + border 描边（workingDir null 不渲染，模板层 v-if）。 */
.session-card__proj {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.6875rem;
  line-height: 1.6;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
}

.session-card__time {
  margin-left: auto;
  flex: none;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

/* 批量删除：复选框 + 选中态高亮（accent 虚线描边，区别于活动卡混色）。 */
.session-card__check {
  flex: none;
  width: 16px;
  height: 16px;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.session-card--selected {
  outline: 1.5px dashed color-mix(in srgb, var(--color-accent) 55%, transparent);
  outline-offset: -3px;
}

.session-card--selected:hover {
  background: color-mix(in srgb, var(--color-accent) 12%, var(--color-panel));
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

/* ── UI13-P4 左侧栏可折叠 ──
   折叠窄轨 48px：本类与 .sidebar 基础规则同特异性（单类），后声明胜出——固定宽覆盖
   width/min-width: var(--sidebar-width)，AppLayout 的 --sidebar-width 记忆宽不动，展开即恢复。
   契约 #4：折叠/展开瞬时切换，无 transition（对齐右栏 rail 折叠决策；T4-E 钉）。 */
.sidebar--collapsed {
  width: 48px;
  min-width: 48px;
  padding: 14px 8px 12px;
  align-items: center;
}

/* 窄轨：纵向图标列（方标 / 新建 / 弹性占位 / 底部展开钮）。 */
.sidebar__rail {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  width: 100%;
  gap: 10px;
}

.sidebar__rail__mark {
  display: grid;
  width: 24px;
  height: 24px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-size: 0.625rem;
  font-weight: 800;
  letter-spacing: 0.02em;
  cursor: pointer;
}

.sidebar__rail__new {
  display: grid;
  width: 26px;
  height: 26px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}

.sidebar__rail__new:hover {
  background: var(--color-panel-soft);
  color: var(--color-text);
}

.sidebar__rail__new svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
}

.sidebar__rail__spacer {
  flex: 1;
}

.sidebar__rail__expand {
  display: grid;
  width: 26px;
  height: 26px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}

.sidebar__rail__expand:hover {
  background: var(--color-panel-soft);
  color: var(--color-text);
}

.sidebar__rail__expand svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 底缘折叠钮（展开态页脚尾，右端并排）：« 双箭头指左 = 向左收起侧栏。 */
.sidebar__collapse {
  display: grid;
  width: 26px;
  height: 26px;
  margin-left: auto;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}

.sidebar__collapse:hover {
  background: var(--color-panel-soft);
  color: var(--color-text);
}

.sidebar__collapse svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
