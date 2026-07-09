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
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const matchingCommands = computed(() => {
  if (!text.value.startsWith('/')) return [];
  const q = text.value.toLowerCase();
  // 动态搜索：前缀匹配优先；无前缀命中时退化为包含匹配，提升可发现性。
  const prefix = SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(q));
  if (prefix.length) return prefix;
  return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().includes(q));
});

// 显式触发命令联想：插入 '/' 并聚焦，让斜杠菜单立刻弹出。
function insertSlash() {
  if (!text.value.startsWith('/')) {
    text.value = '/';
  }
  showSlashMenu.value = matchingCommands.value.length > 0;
  selectedSlashIndex.value = 0;
  textareaRef.value?.focus();
}

// 鼠标悬停与键盘选中保持同步，避免悬停高亮和回车选中不一致。
function hoverCommand(i: number) {
  selectedSlashIndex.value = i;
}

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
        @mouseenter="hoverCommand(i)"
      >
        <span class="slash-menu__name">{{ cmd.name }}</span>
        <span class="slash-menu__desc">{{ cmd.description }}</span>
      </div>
    </div>
    <div class="chat-input">
      <button
        type="button"
        class="slash-trigger"
        title="插入命令（/ 开头自动联想，↑↓ 选择，回车确认）"
        @click="insertSlash"
      >/</button>
      <textarea
        ref="textareaRef"
        v-model="text"
        :disabled="disabled"
        placeholder="输入消息；输入 / 联想命令（↑↓ 选择，回车确认）"
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
  left: 1.5rem;
  right: 1.5rem;
  max-width: 47rem;
  z-index: 50;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  padding: 0.5rem 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.slash-menu__item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.875rem;
  cursor: pointer;
}

.slash-menu__item:hover,
.slash-menu__item.active {
  background: var(--color-panel-soft);
}

.slash-menu__name {
  color: var(--color-accent-strong);
  font-size: 0.8125rem;
  font-weight: 600;
}

.slash-menu__desc {
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

.chat-input {
  display: flex;
  gap: 10px;
  /* 浮岛内部输入行：宽度与 padding 由外层 .chat-composer 统一约束（两行天然同宽，
     规避历史上 max-width≠width 导致的错位）。去掉自带背景与 border-top，融入卡片。 */
  width: 100%;
  padding: 16px var(--chat-bottom-pad-x);
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
  font-size: 0.875rem;
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

.slash-trigger {
  align-self: flex-end;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
  padding: 10px 14px;
  font-weight: 700;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}

.slash-trigger:hover {
  color: var(--color-accent-strong);
  border-color: var(--color-accent);
}
</style>
