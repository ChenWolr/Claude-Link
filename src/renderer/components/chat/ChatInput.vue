<script setup lang="ts">
import { ref } from 'vue';

defineProps<{
  disabled?: boolean;
}>();

const emit = defineEmits<{
  send: [text: string];
}>();

const text = ref('');

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}

function submit(): void {
  const value = text.value.trim();
  if (!value) return;
  emit('send', value);
  text.value = '';
}
</script>

<template>
  <div class="chat-input">
    <textarea
      v-model="text"
      :disabled="disabled"
      placeholder="输入消息（Enter 发送，Shift+Enter 换行）"
      rows="1"
      @keydown="handleKeydown"
    />
    <button type="button" :disabled="disabled || !text.trim()" @click="submit">发送</button>
  </div>
</template>

<style scoped>
.chat-input {
  display: flex;
  gap: 10px;
  max-width: 800px;
  margin: 0 auto;
  padding: 16px 24px;
  border-top: 1px solid var(--color-border);
  background: var(--color-panel);
}

textarea {
  min-width: 0;
  flex: 1;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 10px 14px;
  resize: none;
  outline: none;
  font-size: 14px;
  line-height: 1.5;
  min-height: 42px;
  max-height: 160px;
}

button {
  align-self: flex-end;
  border: 0;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: #07120d;
  padding: 10px 20px;
  font-weight: 700;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
