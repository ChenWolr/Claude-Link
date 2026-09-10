<script setup lang="ts">
// ProviderManager.vue — 连接页容器（r9 定版布局）。
// 左：供应商列表栏（新建按钮 + 条目：名称/域名/模型数）；右：详情框（查看 / 新建表单切换）。
// 设置页 = 可选项库：无「使用中/默认模型」选用语义（选用在会话内）。
// 滚动全部发生在面板内部（左栏条目 / 右侧模型区），卡头（查询模型）与表尾（职责说明）常驻。
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { useProviderStore } from '../../stores/provider-store';
import { useInteractionStore } from '../../stores/interaction-store';
import ProviderEditor from './ProviderEditor.vue';
import ProviderModelList from './ProviderModelList.vue';
import ProviderModelPicker from './ProviderModelPicker.vue';
import type { ModelInfo, ProviderModel, ProviderProfileView } from '../../../shared/types/config';

const store = useProviderStore();
const interactionStore = useInteractionStore();

const selectedId = ref<string | null>(null);
const creating = ref(false);
const editing = ref(false);

const providers = computed(() => store.providers);
const current = computed<ProviderProfileView | null>(
  () => providers.value.find((p) => p.id === selectedId.value) ?? null,
);

let unbindProviders: (() => void) | null = null;
onMounted(() => {
  unbindProviders = store.ensureLoaded();
});
onUnmounted(() => {
  unbindProviders?.();
});

// 库刷新后（删除/撤销/别处变更）兜底选中态。
watch(providers, (list) => {
  if (creating.value || editing.value) return;
  if (!list.some((p) => p.id === selectedId.value)) {
    selectedId.value = list[0]?.id ?? null;
  }
}, { immediate: true });

// ── 轻量 toast（含撤销动作）─────────────────────────────────────────
interface ToastItem {
  key: number;
  message: string;
  action?: { label: string; fn: () => void };
}
const toasts = ref<ToastItem[]>([]);
let toastSeq = 0;

function pushToast(message: string, action?: { label: string; fn: () => void }): void {
  const key = ++toastSeq;
  toasts.value.push({ key, message, action });
  const kill = () => {
    toasts.value = toasts.value.filter((t) => t.key !== key);
  };
  window.setTimeout(kill, action ? 5000 : 2600);
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ── 选择 / 新建 ──────────────────────────────────────────────────────
function selectProvider(id: string): void {
  selectedId.value = id;
  creating.value = false;
  editing.value = false;
}

function toggleCreating(): void {
  creating.value = !creating.value;
  editing.value = false;
}

function startEditing(): void {
  if (!current.value) return;
  editing.value = true;
  creating.value = false;
}

async function handleEditorSave(payload: { id?: string; name: string; note: string; apiBaseUrl: string; apiKey?: string }): Promise<void> {
  const name = payload.name.trim();
  const note = payload.note.trim();
  const apiBaseUrl = payload.apiBaseUrl.trim();
  const apiKey = payload.apiKey?.trim();
  if (!name || !apiBaseUrl) {
    pushToast('名称和请求地址为必填');
    return;
  }
  try {
    const currentProvider = payload.id ? providers.value.find((p) => p.id === payload.id) : null;
    const view = await store.save({
      id: payload.id,
      name,
      note,
      apiBaseUrl,
      ...(apiKey ? { apiKey } : {}),
      models: currentProvider?.models,
    });
    selectedId.value = view.id;
    creating.value = false;
    editing.value = false;
    pushToast(payload.id ? `供应商「${view.name}」已更新` : `已创建供应商「${view.name}」，点「查询模型」开始添加模型`);
  } catch (error) {
    pushToast(error instanceof Error ? error.message : payload.id ? '更新供应商失败' : '创建供应商失败');
  }
}

function handleEditorCancel(): void {
  creating.value = false;
  editing.value = false;
}

// ── 删除供应商（破坏性 → 确认弹窗 + 撤销）────────────────────────────
async function handleDeleteProvider(): Promise<void> {
  const p = current.value;
  if (!p) return;
  const ok = await interactionStore.requestConfirm({
    title: `删除供应商「${p.name}」？`,
    message: `将同时删除其 ${p.models.length} 个模型配置。正在使用它的会话将回退到当前默认供应商（下一条消息起生效），新建会话不能再选它。删除后可撤销。`,
    confirmText: '删除',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;
  try {
    await store.remove(p.id);
    pushToast(`已删除供应商「${p.name}」`, {
      label: '撤销',
      fn: () => {
        void store
          .restoreDeleted()
          .then((view) => {
            selectedId.value = view.id;
          })
          .catch(() => pushToast('撤销失败'));
      },
    });
  } catch (error) {
    pushToast(error instanceof Error ? error.message : '删除供应商失败');
  }
}

// ── 模型增删（models 数组整体替换，撤销可回放）────────────────────────
async function persistModels(p: ProviderProfileView, models: ProviderModel[]): Promise<void> {
  await store.save({ id: p.id, name: p.name, note: p.note, apiBaseUrl: p.apiBaseUrl, models });
}

async function handleModelAdd(info: Pick<ModelInfo, 'id' | 'name' | 'maxTokens'>, source: ProviderModel['source']): Promise<void> {
  const p = current.value;
  if (!p) return;
  if (p.models.some((m) => m.id === info.id)) {
    pushToast(`「${info.id}」已在列表中，不可重复添加`);
    return;
  }
  const next: ProviderModel[] = [
    ...p.models,
    { id: info.id, name: info.name || info.id, maxTokens: info.maxTokens ?? 0, source, addedAt: Date.now() },
  ];
  try {
    await persistModels(p, next);
    pushToast(`已添加模型 ${info.id} 到「${p.name}」`);
  } catch (error) {
    pushToast(error instanceof Error ? error.message : '添加模型失败');
  }
}

function handleQueriedAdd(info: ModelInfo): void {
  void handleModelAdd(info, 'queried');
}

function handleManualAdd(id: string): void {
  void handleModelAdd({ id, name: id, maxTokens: 0 }, 'manual');
}

async function handleModelRemove(model: ProviderModel, index: number): Promise<void> {
  const p = current.value;
  if (!p) return;
  const next = p.models.filter((_, i) => i !== index);
  try {
    await persistModels(p, next);
    pushToast(`已删除模型 ${model.id}`, {
      label: '撤销',
      fn: () => {
        const fresh = store.providers.find((x) => x.id === p.id);
        if (!fresh) {
          pushToast('撤销失败：供应商已不存在');
          return;
        }
        const restored = [...fresh.models];
        restored.splice(Math.min(index, restored.length), 0, model);
        void persistModels(fresh, restored).catch(() => pushToast('撤销失败'));
      },
    });
  } catch (error) {
    pushToast(error instanceof Error ? error.message : '删除模型失败');
  }
}
</script>

<template>
  <div class="pm">
    <!-- 左：供应商列表栏（r3：加宽为 230px 列表栏；与详情框拼成一个复合面板）-->
    <aside class="plist" aria-label="供应商列表">
      <div class="plist-head">
        <h2>供应商</h2>
        <span class="count">{{ providers.length }} 个</span>
      </div>
      <button type="button" :class="['plist-add', { active: creating }]" @click="toggleCreating">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>新建供应商
      </button>
      <div class="plist-items">
        <button
          v-for="p in providers"
          :key="p.id"
          type="button"
          :class="['pitem', { sel: p.id === selectedId && !creating }]"
          :aria-current="p.id === selectedId && !creating"
          @click="selectProvider(p.id)"
        >
          <span class="meta">
            <span class="name" :title="p.name">{{ p.name }}</span>
            <span class="host" :title="p.apiBaseUrl">{{ host(p.apiBaseUrl) }}</span>
          </span>
          <span class="mcount">{{ p.models.length }} 模型</span>
        </button>
      </div>
      <div v-if="providers.length === 0" class="plist-empty">还没有供应商，点上方「新建供应商」创建。</div>
    </aside>

    <!-- 右：详情框（查看 / 新建表单，紧挨左栏共享圆角）-->
    <section class="pdetail">
      <!-- 新建供应商：表单渲染在与详情同一个框里（再点新建按钮收起）-->
      <ProviderEditor
        v-if="creating || editing"
        :key="editing ? 'edit-' + (current?.id ?? '') : 'create'"
        :id="editing ? current?.id : undefined"
        :initial-name="editing ? current?.name : undefined"
        :initial-note="editing ? current?.note : undefined"
        :initial-api-base-url="editing ? current?.apiBaseUrl : undefined"
        @save="handleEditorSave"
        @cancel="handleEditorCancel"
      />

      <div v-else-if="current" class="card">
        <div class="d-head">
          <div class="d-ava" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
          </div>
          <div class="d-title">
            <div class="row1"><h2>{{ current.name }}</h2></div>
            <div class="sub">
              <span>地址 <code>{{ current.apiBaseUrl }}</code></span>
              <span v-if="current.note">备注 {{ current.note }}</span>
            </div>
          </div>
          <div class="d-actions">
            <button class="btn" type="button" aria-label="编辑供应商" @click="startEditing">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>编辑
            </button>
            <button class="btn ghost-danger" type="button" aria-label="删除供应商" @click="handleDeleteProvider">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>删除
            </button>
          </div>
        </div>
        <div class="card-head">
          <h3>我的模型</h3>
          <span class="card-head__count">{{ current.models.length }} 个</span>
          <div class="spacer" />
          <ProviderModelPicker
            :key="current.id"
            :provider="current"
            @add="handleQueriedAdd"
            @manual-add="handleManualAdd"
            @toast="(msg: string) => pushToast(msg)"
          />
        </div>
        <div class="mscroll">
          <ProviderModelList
            :provider-id="current.id"
            :models="current.models"
            @remove="handleModelRemove"
            @toast="(msg: string) => pushToast(msg)"
          />
        </div>
        <div class="pool-note">设置页只维护可选的供应商与模型；会话中可自由选用任意供应商 / 模型。</div>
      </div>

      <div v-else class="card">
        <div class="empty">还没有供应商。点左侧<b>「新建供应商」</b>开始。</div>
      </div>
    </section>

    <!-- toast 栈（固定底部居中，支持撤销）-->
    <Teleport to="body">
      <div class="toast-wrap" aria-live="polite">
        <div v-for="t in toasts" :key="t.key" class="toast">
          <span>{{ t.message }}</span>
          <button v-if="t.action" type="button" @click="t.action.fn(); toasts = toasts.filter((x) => x.key !== t.key)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>{{ t.action.label }}
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 两栏紧挨（gap 0）拼成一个复合面板；宽高由外层 .wb-connection（flex:1 填满舞台）约束。 */
.pm {
  display: flex;
  gap: 0;
  align-items: stretch;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

/* 窄容器（workbench < 460px）：供应商列表 + 详情双栏折为上下堆叠，且整体垂直滚动，
   避免 230px 列表栏把详情列压到不可达、也避免堆叠后详情区 mscroll 被 flex:1 压到 0
   高度导致「看不到下面内容」。断点 460 保证双栏态下详情区 ≥ 230px（460−230）。
   容器查询锚点是父级 .wb-connection（声明 container-type:inline-size，见 ConfigPage），
   不是 .pm 自身——容器查询不能作用于容器自己。 */
@container (max-width: 460px) {
  .pm {
    flex-direction: column;
    overflow-y: auto;
  }
  /* .pm .plist / .pm .pdetail / .pm .card 提高特异性（0,2,0 > 0,1,0），压过源码后文
     同属性的普通规则，不依赖声明顺序——否则 .plist 的 width:14.375rem 会覆盖 width:100%。 */
  .pm .plist {
    width: 100%;
    flex: none;
    border-right: 1px solid var(--color-border);
    border-radius: var(--radius-md) var(--radius-md) 0 0;
  }
  .pm .plist-items {
    flex: none;
    max-height: 12rem;
    overflow-y: auto;
  }
  .pm .pdetail {
    flex: none;
  }
  .pm .card {
    flex: none;
    border-top: 0;
    border-radius: 0 0 var(--radius-md) var(--radius-md);
  }
  .pm .mscroll {
    flex: none;
    overflow: visible;
  }
}

/* ── 左侧供应商列表栏 ── */
.plist {
  width: 14.375rem;
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
  border-right: 0;
  border-radius: var(--radius-md) 0 0 var(--radius-md);
  overflow: hidden;
}

.plist-head {
  padding: 0.875rem 1rem 0.5rem;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex: none;
}

.plist-head h2 {
  margin: 0;
  font-size: 0.9375rem;
}

.plist-head .count {
  font-size: 0.71875rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.plist-add {
  margin: 0 0.75rem 0.75rem;
  width: calc(100% - 1.5rem);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  padding: 0.5rem;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-accent-strong);
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  border: 1px dashed color-mix(in srgb, var(--color-accent) 45%, transparent);
  border-radius: var(--radius-sm);
  transition: background var(--duration-fast) var(--ease-out);
  flex: none;
  cursor: pointer;
}

.plist-add:hover {
  background: color-mix(in srgb, var(--color-accent) 16%, transparent);
}

.plist-add.active {
  border-style: solid;
  background: color-mix(in srgb, var(--color-accent) 16%, transparent);
}

.plist-items {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 0 0.5rem 0.625rem;
  gap: 0.125rem;
}

/* 设置页滚动容器：供应商列表溢出时常驻低对比度滚动条（同 ConfigPage 行为/外观卡，避免
   全局 overlay 滚动条在表单溢出时无提示）。 */
.plist-items::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text-muted) 28%, transparent);
}

.plist-items::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-muted);
}

.pitem {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  padding: 0.625rem;
  border-radius: var(--radius-sm);
  transition: background var(--duration-fast) var(--ease-out);
  cursor: pointer;
}

.pitem:hover {
  background: color-mix(in srgb, var(--color-text) 4%, transparent);
}

.pitem.sel {
  background: color-mix(in srgb, var(--color-accent) 13%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 38%, transparent);
}

.pitem:focus-visible,
.btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.pitem .meta {
  min-width: 0;
}

.pitem .meta .name {
  display: block;
  font-size: 0.875rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pitem .meta .host {
  display: block;
  font-size: 0.71875rem;
  color: var(--color-text-muted);
  font-family: var(--font-mono, ui-monospace, monospace);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pitem .mcount {
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-text) 7%, transparent);
  padding: 0.125rem 0.4375rem;
  border-radius: var(--radius-pill);
  font-variant-numeric: tabular-nums;
}

.plist-empty {
  padding: 0.375rem 1rem 1rem;
  font-size: 0.78125rem;
  color: var(--color-text-muted);
  flex: none;
}

/* ── 右侧详情框 ── */
.pdetail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
}

.mscroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

/* 设置页滚动容器：模型列表溢出时常驻低对比度滚动条（同左栏 plist-items）。 */
.mscroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text-muted) 28%, transparent);
}

.mscroll::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-muted);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 1rem 1.25rem 0;
  flex-wrap: wrap;
  flex: none;
}

.card-head h3 {
  margin: 0;
  font-size: 1rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-head__count {
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.card-head .spacer {
  flex: 1;
}

.d-head {
  padding: 1.125rem 1.25rem;
  display: flex;
  align-items: flex-start;
  gap: 0.875rem;
  flex: none;
}

.d-ava {
  width: 2.5rem;
  height: 2.5rem;
  flex: none;
  border-radius: var(--radius-sm);
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--color-accent) 15%, var(--color-panel));
  color: var(--color-accent-strong);
}

.d-title {
  flex: 1;
  min-width: 0;
}

.d-title .row1 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.d-title h2 {
  margin: 0;
  font-size: 1.0625rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.d-title .sub {
  margin-top: 0.1875rem;
  font-size: 0.8125rem;
  color: var(--color-text-muted);
  display: flex;
  gap: 0.875rem;
  flex-wrap: nowrap;
  overflow: hidden;
}

/* 地址/备注超长时省略号截断（不再换行堆叠挤高标题区）；地址列优先收缩、备注列不收缩。 */
.d-title .sub span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.d-title .sub span:first-child {
  flex: 1;
}

.d-title .sub span:not(:first-child) {
  flex-shrink: 0;
}

.d-title .sub code {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.75rem;
  word-break: break-all;
}

.d-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.empty {
  padding: 1.625rem 1.25rem 1.875rem;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
}

.empty b {
  color: var(--color-text);
}

.pool-note {
  padding: 0.625rem 1.25rem 0.875rem;
  border-top: 1px dashed var(--color-border);
  font-size: 0.71875rem;
  color: var(--color-text-muted);
  flex: none;
}

/* ── 按钮 ── */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.4375rem 0.8125rem;
  font-size: 0.8125rem;
  font-weight: 600;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-panel-soft);
  color: var(--color-text);
  transition: background var(--duration-fast) var(--ease-out), border-color var(--duration-fast);
  cursor: pointer;
}

.btn:hover {
  border-color: var(--color-border-strong);
  background: color-mix(in srgb, var(--color-text) 4%, var(--color-panel-soft));
}

.btn.ghost-danger {
  color: var(--color-danger);
  border-color: color-mix(in srgb, var(--color-danger) 35%, transparent);
  background: transparent;
}

.btn.ghost-danger:hover {
  background: color-mix(in srgb, var(--color-danger) 8%, transparent);
}

/* ── toast 栈（r9 同款：底部居中，深底反白）── */
.toast-wrap {
  position: fixed;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  z-index: 1000;
  align-items: center;
}

.toast {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  background: var(--color-text);
  color: var(--color-panel-soft);
  font-size: 0.8125rem;
  padding: 0.5625rem 0.75rem 0.5625rem 1rem;
  border-radius: var(--radius-md);
  box-shadow: var(--elevation-3);
}

.toast button {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  border: 0;
  background: color-mix(in srgb, var(--color-panel-soft) 14%, transparent);
  color: var(--color-panel-soft);
  font-size: 0.75rem;
  font-weight: 700;
  padding: 0.25rem 0.625rem;
  border-radius: var(--radius-xs);
  cursor: pointer;
}

@media (prefers-reduced-motion: reduce) {
  .plist-add,
  .pitem,
  .btn {
    transition: none;
  }
}
</style>
