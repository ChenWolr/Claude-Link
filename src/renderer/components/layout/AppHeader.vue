<script setup lang="ts">
import { ref, computed, nextTick } from 'vue';
import { useSessionStore } from '../../stores/session-store';

const sessionStore = useSessionStore();
const activeSession = computed(() => sessionStore.activeSession);

// 标题重命名：点击 ✎ 进入内联编辑，Enter/blur 保存，Esc 取消。
const editing = ref(false);
const draftName = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

async function startEdit() {
  if (!activeSession.value) return;
  draftName.value = activeSession.value.name;
  editing.value = true;
  await nextTick();
  inputRef.value?.focus();
  inputRef.value?.select();
}

async function commitEdit() {
  if (!editing.value) return;
  editing.value = false;
  const name = draftName.value.trim();
  if (name && activeSession.value && name !== activeSession.value.name) {
    await sessionStore.renameActiveSession(name);
  }
}

function cancelEdit() {
  editing.value = false;
}
</script>

<template>
  <header class="app-header">
    <div class="app-header__title">
      <p class="app-header__label">当前会话</p>
      <div v-if="activeSession" class="app-header__name">
        <input
          v-if="editing"
          ref="inputRef"
          v-model="draftName"
          class="app-header__name-input"
          maxlength="80"
          @keydown.enter.prevent="commitEdit"
          @keydown.esc="cancelEdit"
          @blur="commitEdit"
        />
        <template v-else>
          <h2 :title="activeSession.name">{{ activeSession.name }}</h2>
          <button type="button" class="app-header__rename" title="重命名会话" @click="startEdit">✎</button>
        </template>
      </div>
      <h2 v-else>未选择会话</h2>
    </div>
  </header>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  height: 56px;
  padding: 0 24px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-panel);
}

.app-header__title {
  min-width: 0;
}

.app-header__label {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 11px;
}

.app-header__name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 1px;
}

.app-header__title h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 60vw;
}

.app-header__name-input {
  font-size: 16px;
  font-weight: 650;
  color: var(--color-text);
  background: var(--color-panel-soft);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  outline: none;
  max-width: 60vw;
}

.app-header__rename {
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 13px;
  cursor: pointer;
  padding: 2px 4px;
  opacity: 0.6;
}

.app-header__rename:hover {
  opacity: 1;
  color: var(--color-accent-strong);
}
</style>
