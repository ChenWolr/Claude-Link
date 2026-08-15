<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { parseSlashInvocation, filterRenderableCommands } from '../../../shared/command-routing';
import type { SdkCommand, CommandSnapshotStatus } from '../../../shared/types/command';

// 受控输入：modelValue 由父组件（草稿 store）持有；附件-only 也允许发送。
// 拖放/粘贴由 ChatPage 在 .chat-page 容器统一处理（不依赖 textarea 焦点、落点更大）。
const props = defineProps<{
  disabled?: boolean;
  modelValue: string;
  hasAttachments?: boolean;
  // 原生 Slash Commands：由父组件从 command-store 传入当前会话的 SDK 动态命令列表与状态。
  commands?: SdkCommand[];
  commandStatus?: CommandSnapshotStatus;
  commandError?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  send: [];
}>();

const showSlashMenu = ref(false);
const selectedSlashIndex = ref(0);
const wrapperRef = ref<HTMLElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const slashMenuRef = ref<HTMLElement | null>(null);

// 动态命令菜单：数据源来自父组件传入的当前会话 SDK 命令（command-store active snapshot），
// 不再依赖静态 SLASH_COMMANDS。仅 / 开头且无参数时联想命令名；alias 与 canonical 都参与匹配。
const COMMANDS_PAGE_SIZE = 5;
const loadedCommandCount = ref(COMMANDS_PAGE_SIZE);

const matchingCommands = computed<SdkCommand[]>(() => {
  const parsed = parseSlashInvocation(props.modelValue);
  if (parsed.kind !== 'slash' || parsed.argumentsText.length > 0) return [];
  const q = parsed.commandName.toLowerCase();
  const cmds = filterRenderableCommands(props.commands ?? []);
  return q
    ? cmds.filter(
        (c) =>
          c.name.toLowerCase().startsWith(q) ||
          c.aliases.some((alias) => alias.toLowerCase().startsWith(q)),
      )
    : cmds;
});

// Task 8：命令来源徽章文案——区分 builtin / 用户 Skill / 项目 / 插件，不让「source=sdk」被误读为官方 builtin。
// unknown 不出现在菜单（availability=unknown 被 filterRenderableCommands 过滤），其计数由 unknownCount 单独展示。
const ORIGIN_LABELS: Record<string, string> = {
  builtin: 'Claude Code 内置',
  'user-skill': '用户 Skill',
  project: '项目命令',
  plugin: '插件命令',
};
function originLabel(origin: string): string {
  return ORIGIN_LABELS[origin] ?? '';
}
// 来源未知/隐藏命令计数（从完整 props.commands 派生，不经菜单过滤）——让 unknown 作为可见差异状态
// （计划：unknown 不得当 builtin 完成）。hidden 是 removed/internal，菜单不展示但计数可见。
const unknownCount = computed(() => (props.commands ?? []).filter((c) => c.origin === 'unknown').length);
const hiddenCount = computed(() => (props.commands ?? []).filter((c) => c.availability === 'hidden').length);

const visibleCommands = computed(() => matchingCommands.value.slice(0, loadedCommandCount.value));
const hasMoreCommands = computed(() => loadedCommandCount.value < matchingCommands.value.length);

// 分页重置：输入变化或菜单重新打开时回到第一页，并复位选中索引。
function resetCommandPagination(): void {
  loadedCommandCount.value = COMMANDS_PAGE_SIZE;
  selectedSlashIndex.value = 0;
}

// 触底/跨页时追加下一页（每页 5 项），并以完整匹配结果长度封顶，不发起 IPC、不改命令 store。
function loadNextCommandPage(): void {
  if (!hasMoreCommands.value) return;
  loadedCommandCount.value = Math.min(
    loadedCommandCount.value + COMMANDS_PAGE_SIZE,
    matchingCommands.value.length,
  );
}

// 键盘跨页后把新选中项滚入菜单可视区域（block:'nearest' 不强制整体滚动）。
function ensureSelectedCommandVisible(): void {
  nextTick(() => {
    const menu = slashMenuRef.value;
    const item = menu?.querySelector<HTMLElement>('.slash-menu__item.active');
    item?.scrollIntoView({ block: 'nearest' });
  });
}

// 菜单滚动触底（容差 8px）时追加下一页；不一次性把完整结果复制到模板。
function handleSlashMenuScroll(e: Event): void {
  const menu = e.currentTarget as HTMLElement;
  if (menu.scrollTop + menu.clientHeight >= menu.scrollHeight - 8) {
    loadNextCommandPage();
  }
}

// 鼠标悬停与键盘选中保持同步，避免悬停高亮和回车选中不一致。
function hoverCommand(i: number) {
  selectedSlashIndex.value = i;
}

function handleKeydown(e: KeyboardEvent): void {
  if (showSlashMenu.value && visibleCommands.value.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const lastVisibleIndex = visibleCommands.value.length - 1;
      if (selectedSlashIndex.value < lastVisibleIndex) {
        selectedSlashIndex.value += 1;
      } else if (hasMoreCommands.value) {
        const previousCount = loadedCommandCount.value;
        loadNextCommandPage();
        selectedSlashIndex.value = previousCount;
      }
      ensureSelectedCommandVisible();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      // 已到首项则保持不动（与 ↓ 到末项不循环对称）；从后续页首项返回上一页末项
      // 由 selectedSlashIndex > 0 的简单 -1 自然完成（如索引 5 → 4 即上一页末项）。
      if (selectedSlashIndex.value > 0) {
        selectedSlashIndex.value -= 1;
      }
      ensureSelectedCommandVisible();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      selectSlashCommand(visibleCommands.value[selectedSlashIndex.value]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      showSlashMenu.value = false;
      resetCommandPagination();
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}

// 菜单选择：插入 canonical 命令 /name（SDK name 不带斜杠，需补 /）。用户手写 alias 不经此路径，原样保留。
function selectSlashCommand(cmd: SdkCommand): void {
  emit('update:modelValue', `/${cmd.name} `);
  showSlashMenu.value = false;
  resetCommandPagination();
}

function handleInput(e: Event): void {
  const value = (e.target as HTMLTextAreaElement).value;
  emit('update:modelValue', value);
  // 菜单：仅 / 开头且无参数（参数输入阶段关闭联想）。loading/empty 仍显示状态提示。
  const parsed = parseSlashInvocation(value);
  showSlashMenu.value = parsed.kind === 'slash' && parsed.argumentsText.length === 0;
  resetCommandPagination();
}

// 输入框自适应高度：随内容增高，最多约 4 行（CSS max-height 封顶），超出则内部滚动。
// 模式参考 openhanako FloatingInput——先置 auto 再读 scrollHeight，由 max-height + overflow-y 兜底。
// 覆盖键盘输入、斜杠命令注入、发送后清空、窗口缩放（换行重排）等所有高度变化路径。
function autoResize(): void {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

// flush:'post' 确保 DOM 已反映最新 modelValue，scrollHeight 读数准确。
watch(() => props.modelValue, () => autoResize(), { flush: 'post' });

// 命令数据源变化（commands_changed 全量替换 / re-probe）时回到第一页：
// 否则旧 selectedSlashIndex 可能越过变短后的 visibleCommands 末端，
// Enter 选中 undefined → `/${cmd.name}` 崩溃。输入变化由 handleInput 单独 reset。
watch(() => props.commands, () => {
  resetCommandPagination();
});

// 发送：文字或附件至少一项即可（附件-only）。不清 modelValue——由父组件在主进程接受后清空草稿。
function submit(): void {
  if (props.disabled) return;
  if (!props.modelValue.trim() && !props.hasAttachments) return;
  emit('send');
}

// 父组件（ChatPage）粘贴混合剪贴板时调用：图片进附件后，把同一次 paste 的文字插入当前选区。
// 不能让图片处理器 preventDefault() 后吞掉文字。插入后恢复光标到插入末尾并重算高度。
function insertTextAtSelection(text: string): void {
  if (!text) return;
  const el = textareaRef.value;
  const value = props.modelValue;
  const start = el?.selectionStart ?? value.length;
  const end = el?.selectionEnd ?? value.length;
  const next = value.slice(0, start) + text + value.slice(end);
  emit('update:modelValue', next);
  const pos = start + text.length;
  nextTick(() => {
    const ta = textareaRef.value;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    autoResize();
  });
}

defineExpose({ insertTextAtSelection });

function handleClickOutside(event: MouseEvent) {
  if (showSlashMenu.value && wrapperRef.value && !wrapperRef.value.contains(event.target as Node)) {
    showSlashMenu.value = false;
    resetCommandPagination();
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
  window.addEventListener('resize', autoResize);
  // 首次挂载若已恢复非空多行草稿（watch 非 immediate 不会触发），主动撑高一次。
  autoResize();
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  window.removeEventListener('resize', autoResize);
});
</script>

<template>
  <div ref="wrapperRef" class="chat-input-wrapper">
    <div
      v-if="showSlashMenu"
      ref="slashMenuRef"
      class="slash-menu"
      data-testid="slash-menu"
      @scroll="handleSlashMenuScroll"
    >
      <div
        v-for="(cmd, i) in visibleCommands"
        :key="cmd.name"
        :class="['slash-menu__item', { active: i === selectedSlashIndex }]"
        data-testid="slash-menu-item"
        :data-command="cmd.name"
        @click="selectSlashCommand(cmd)"
        @mouseenter="hoverCommand(i)"
      >
        <span class="slash-menu__name">/{{ cmd.name }}</span>
        <span
          v-if="originLabel(cmd.origin)"
          class="slash-menu__origin"
          data-testid="slash-menu-origin"
          :data-origin="cmd.origin"
        >{{ originLabel(cmd.origin) }}</span>
      </div>
      <div v-if="matchingCommands.length === 0" class="slash-menu__status">
        <span v-if="commandStatus === 'loading'">正在读取 Claude Code 命令…</span>
        <span v-else-if="commandStatus === 'error' || commandStatus === 'degraded'">{{ commandError || '命令读取异常，可继续输入或发送' }}</span>
        <span v-else>当前会话没有可用 Slash Command（仍可直接输入发送）</span>
      </div>
      <div v-else-if="commandStatus === 'stale'" class="slash-menu__hint">可能不是最新</div>
      <div v-if="unknownCount > 0 || hiddenCount > 0" class="slash-menu__provenance">
        <span v-if="unknownCount > 0">{{ unknownCount }} 个命令来源未知（待分类，未作为内置命令验证）</span>
        <span v-if="unknownCount > 0 && hiddenCount > 0">·</span>
        <span v-if="hiddenCount > 0">{{ hiddenCount }} 个隐藏命令（已移除/内部）</span>
      </div>
    </div>
    <div class="chat-input">
      <textarea
        ref="textareaRef"
        :value="modelValue"
        :disabled="disabled"
        data-testid="chat-input-textarea"
        placeholder="输入消息；输入 / 联想命令（↑↓ 选择，回车确认）"
        rows="1"
        @keydown="handleKeydown"
        @input="handleInput"
      />
      <button type="button" data-testid="chat-send-button" :disabled="disabled || (!modelValue.trim() && !hasAttachments)" @click="submit">发送</button>
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
  left: 0;
  right: 0;
  /* 最多容纳 5 项（每项约 2.5rem + 4 个 2px gap + 上下 0.5rem padding）后内部滚动，
     触底由 handleSlashMenuScroll 追加下一页。 */
  max-height: calc((0.5rem * 2) + (2px * 4) + (2.5rem * 5));
  overflow-y: auto;
  z-index: 50;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  box-shadow: var(--elevation-2), var(--ring-light);
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

/* Task 8：来源徽章——区分 builtin / 用户 Skill / 项目 / 插件，不让 source=sdk 被误读为官方 builtin。 */
.slash-menu__origin {
  margin-left: auto;
  padding-left: 0.5rem;
  color: var(--color-text-muted);
  font-size: 0.6875rem;
  font-weight: 400;
  white-space: nowrap;
}
.slash-menu__origin[data-origin='builtin'] {
  color: var(--color-accent-strong);
}
.slash-menu__origin[data-origin='user-skill'] {
  color: var(--color-text-muted);
}

.slash-menu__status {
  padding: 0.5rem 0.875rem;
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

.slash-menu__hint {
  padding: 0.25rem 0.875rem;
  color: var(--color-text-muted);
  font-size: 0.6875rem;
  border-top: 1px solid var(--color-border);
}

/* Task 8：来源未知/隐藏命令计数（unknown 作为可见差异状态，不被当 builtin 完成）。 */
.slash-menu__provenance {
  padding: 0.25rem 0.875rem;
  color: var(--color-text-muted);
  font-size: 0.6875rem;
  border-top: 1px solid var(--color-border);
  display: flex;
  gap: 0.25rem;
}

.chat-input {
  display: flex;
  gap: 10px;
  /* 浮岛内部输入行：宽度与 padding 由外层 .chat-composer 统一约束（两行天然同宽，
     规避历史上 max-width≠width 导致的错位）。去掉自带背景与 border-top，融入卡片。 */
  width: 100%;
  /* 底部 padding 收窄到 8px，缩短与下方工具栏（工作空间/模型/权限）的间距。 */
  padding: 16px var(--chat-bottom-pad-x) 8px;
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
  /* 约 4 行封顶（line-height 1.5 × 14px × 4 + 上下 padding ≈ 104px）；超出由 overflow-y 滚动查看。
     高度自增由 autoResize() 驱动，max-height 在此兜底封顶。 */
  max-height: 104px;
  overflow-y: auto;
}

button {
  align-self: flex-end;
  border: 0;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  box-shadow: var(--ring-light-accent);
  color: var(--color-on-accent);
  padding: 10px 20px;
  font-weight: 700;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
