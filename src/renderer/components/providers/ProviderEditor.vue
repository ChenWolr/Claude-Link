<script setup lang="ts">
// ProviderEditor.vue — 供应商新建/编辑双用表单（r9：不单独弹卡，与详情框合并；新建再点左栏「新建供应商」收起，编辑经详情框「编辑」进入、取消或保存后退出）。
import { ref, onMounted } from 'vue';
import { useInteractionStore } from '../../stores/interaction-store';

const props = withDefaults(defineProps<{
  id?: string;
  initialName?: string;
  initialNote?: string;
  initialApiBaseUrl?: string;
  /** B7（D02-F4）：编辑态档案是否已存密钥——有才显示「清除已存密钥」入口。 */
  hasApiKey?: boolean;
}>(), {});

const emit = defineEmits<{
  save: [payload: { id?: string; name: string; note: string; apiBaseUrl: string; apiKey?: string; clearApiKey?: boolean }];
  cancel: [];
}>();

const interactionStore = useInteractionStore();

const name = ref(props.initialName ?? '');
const note = ref(props.initialNote ?? '');
const apiBaseUrl = ref(props.initialApiBaseUrl ?? '');
const apiKey = ref('');
// B7（D02-F4）：密钥清除请求——确认后保存时带 clearApiKey:true（主进程抹掉密文，档案回到
// key-less 形态）。确认清除后又输入了新 key 时新 key 优先（不带 clearApiKey，主进程
// else-if 链天然不冲突），输入框有值即视为撤回清除意图。
const clearApiKeyRequested = ref(false);

const nameInput = ref<HTMLInputElement | null>(null);
onMounted(() => {
  nameInput.value?.focus();
});

async function requestClearApiKey(): Promise<void> {
  const ok = await interactionStore.requestConfirm({
    title: '清除已存 API Key？',
    message: '清除后该供应商回到未配置密钥（key-less）状态：需要密钥的端点将返回未授权错误，走 IP 白名单/外部登录态的端点不受影响。保存后生效。',
    confirmText: '清除',
    cancelText: '取消',
    danger: true,
  });
  if (ok) clearApiKeyRequested.value = true;
}

function submit(): void {
  emit('save', {
    id: props.id,
    name: name.value,
    note: note.value,
    apiBaseUrl: apiBaseUrl.value,
    ...(apiKey.value ? { apiKey: apiKey.value } : {}),
    clearApiKey: clearApiKeyRequested.value && !apiKey.value,
  });
}
</script>

<template>
  <div class="card">
    <div class="d-head">
      <div class="d-ava" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path v-if="!props.id" d="M12 5v14M5 12h14"/><path v-else d="M4 7h16M4 12h16M4 17h10"/></svg>
      </div>
      <div class="d-title">
        <div class="row1"><h2>{{ props.id ? '编辑供应商' : '新建供应商' }}</h2></div>
        <div class="sub"><span>{{ props.id ? '修改连接信息；API Key 留空表示保留现有密钥。' : '创建后点「查询模型」即可从端点拉取并添加模型' }}</span></div>
      </div>
    </div>
    <form class="pform" @submit.prevent="submit">
      <div class="grid2">
        <label class="req">名称<input ref="nameInput" v-model="name" placeholder="例如：DeepSeek 官方" /></label>
        <label class="req">请求地址（Base URL）<input v-model="apiBaseUrl" placeholder="https://api.deepseek.com/anthropic" /></label>
      </div>
      <label>备注<input v-model="note" placeholder="可选" /></label>
      <label>API Key<input v-model="apiKey" type="password" :placeholder="props.id ? '留空以保留现有密钥' : 'sk-…'" autocomplete="off" /></label>
      <!-- B7（D02-F4）：key-less 回退入口——后端 clearApiKey 通道已备，此前渲染层零入口，
           配过 key 的档案只能毁档重建。确认后保存生效；输入新 key 视为撤回（新 key 优先）。 -->
      <div v-if="props.id && props.hasApiKey && !clearApiKeyRequested" class="keyless-row">
        <button class="btn keyless-clear" type="button" @click="requestClearApiKey">清除已存密钥</button>
        <span class="keyless-hint">改用 IP 白名单 / 外部登录态时清除（key-less）</span>
      </div>
      <div v-else-if="props.id && clearApiKeyRequested" class="keyless-row keyless-row--armed">
        <span class="keyless-hint">将在保存后清除已存密钥（输入新密钥则改为保存新密钥）</span>
      </div>
      <div class="frow">
        <button class="btn" type="button" @click="emit('cancel')">取消</button>
        <button class="btn primary" type="submit">{{ props.id ? '保存修改' : '创建供应商' }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
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

.d-title .row1 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.d-title h2 {
  margin: 0;
  font-size: 1.0625rem;
}

.d-title .sub {
  margin-top: 0.1875rem;
  font-size: 0.8125rem;
  color: var(--color-text-muted);
}

.pform {
  padding: 1rem 1.25rem 1.125rem;
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  border-top: 1px solid var(--color-border);
}

.pform .grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.625rem;
}

.pform label {
  display: grid;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.pform input {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  padding: 0.375rem 0.625rem;
  font-size: 0.8125rem;
  color: var(--color-text);
}

.pform input:focus {
  outline: none;
  border-color: var(--color-accent);
}

.req::after {
  content: ' *';
  color: var(--color-danger);
}

.frow {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

/* B7（D02-F4）：清除密钥入口行（次级 + danger 提示色）。 */
.keyless-row {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  margin-top: -0.125rem;
}

.keyless-clear {
  color: var(--color-danger);
  border-color: color-mix(in srgb, var(--color-danger) 35%, var(--color-border));
}

.keyless-clear:hover {
  border-color: var(--color-danger);
}

.keyless-hint {
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

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
  cursor: pointer;
}

.btn.primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-on-accent);
}

.btn.primary:hover {
  background: var(--color-accent-strong);
  border-color: var(--color-accent-strong);
}
</style>
