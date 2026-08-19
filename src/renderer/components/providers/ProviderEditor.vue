<script setup lang="ts">
// ProviderEditor.vue — 新建供应商表单（r9：不单独弹卡，与详情框合并；再点左栏「新建供应商」收起）。
import { ref, onMounted } from 'vue';

const props = withDefaults(defineProps<{
  id?: string;
  initialName?: string;
  initialNote?: string;
  initialApiBaseUrl?: string;
}>(), {});

const emit = defineEmits<{
  save: [payload: { id?: string; name: string; note: string; apiBaseUrl: string; apiKey?: string }];
  cancel: [];
}>();

const name = ref(props.initialName ?? '');
const note = ref(props.initialNote ?? '');
const apiBaseUrl = ref(props.initialApiBaseUrl ?? '');
const apiKey = ref('');

const nameInput = ref<HTMLInputElement | null>(null);
onMounted(() => {
  nameInput.value?.focus();
});

function submit(): void {
  emit('save', {
    id: props.id,
    name: name.value,
    note: note.value,
    apiBaseUrl: apiBaseUrl.value,
    ...(apiKey.value ? { apiKey: apiKey.value } : {}),
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
