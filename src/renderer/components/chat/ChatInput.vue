<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { SLASH_COMMANDS } from '../../../shared/constants';

defineProps<{
  disabled?: boolean;
}>();

const emit = defineEmits<{
  send: [text: string];
}>();

const text = ref('');
const showSlashMenu = ref(false);
const selectedSlashIndex = ref(0);
const wrapperRef = ref<HTMLElement | null>(null);

const matchingCommands = computed(() => {
  if (!text.value.startsWith('/')) return [];
  const q = text.value.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(q));
});

function handleKeydown(e: KeyboardEvent): void {
  if (showSlashMenu.value && matchingCommands.value.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedSlashIndex.value = (selectedSlashIndex.value + 1) % matchingCommands.value.length;
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedSlashIndex.value =
        (selectedSlashIndex.value - 1 + matchingCommands.value.length) % matchingCommands.value.length;
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      selectSlashCommand(matchingCommands.value[selectedSlashIndex.value]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      showSlashMenu.value = false;
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}

function selectSlashCommand(cmd: { name: string }): void {
  text.value = cmd.name + ' ';
  showSlashMenu.value = false;
  selectedSlashIndex.value = 0;
}

function handleInput(): void {
  showSlashMenu.value = text.value.startsWith('/') && matchingCommands.value.length > 0;
  selectedSlashIndex.value = 0;
}

function submit(): void {
  const value = text.value.trim();
  if (!value) return;
  emit('send', value);
  text.value = '';
  showSlashMenu.value = false;
}

function handleClickOutside(event: MouseEvent) {
  if (showSlashMenu.value && wrapperRef.value && !wrapperRef.value.contains(event.target as Node)) {
    showSlashMenu.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
});
</script>

<template>
  <div ref="wrapperRef" class="chat-input-wrapper">
    <div v-if="showSlashMenu" class="slash-menu">
      <div
        v-for="(cmd, i) in matchingCommands"
        :key="cmd.name"
        :class="['slash-menu__item', { active: i === selectedSlashIndex }]"
        @click="selectSlashCommand(cmd)"
      >
        <span class="slash-menu__name">{{ cmd.name }}</span>
        <span class="slash-menu__desc">{{ cmd.description }}</span>
      </div>
    </div>
    <div class="chat-input">
      <textarea
        v-model="text"
        :disabled="disabled"
        placeholder="输入消息（Enter 发送，Shift+Enter 换行）"
        rows="1"
        @keydown="handleKeydown"
        @input="handleInput"
      />
      <button type="button" :disabled="disabled || !text.trim()" @click="submit">发送</button>
    </div>
  </div>
</template>

<style scoped>
.chat-input-wrapper {
  position: relative;
}

.slash-menu {
  position: absolute;
  bottom: 100%;
  left: 24px;
  right: 24px;
  max-width: 752px;
  z-index: 50;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  padding: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.slash-menu__item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  cursor: pointer;
}

.slash-menu__item:hover,
.slash-menu__item.active {
  background: var(--color-panel-soft);
}

.slash-menu__name {
  color: var(--color-accent-strong);
  font-size: 13px;
  font-weight: 600;
}

.slash-menu__desc {
  color: var(--color-text-muted);
  font-size: 12px;
}

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
