<script setup lang="ts">
// 可复用确认/提示对话框：替换 window.confirm / window.alert。
// 原生对话框在 Electron 渲染进程会窃取 OS 级焦点且关闭后不归还，导致整个应用失焦。
// 本组件全程在 DOM 内交互，并管理焦点：打开时记录触发元素并聚焦按钮，关闭后归还焦点。
import { ref, watch, nextTick, onBeforeUnmount } from 'vue';

const props = withDefaults(defineProps<{
  visible: boolean;
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  mode?: 'confirm' | 'alert';
}>(), {
  title: '确认操作',
  confirmText: '确定',
  cancelText: '取消',
  danger: false,
  mode: 'confirm',
});

const emit = defineEmits<{
  'update:visible': [boolean];
  confirm: [];
  cancel: [];
}>();

const confirmBtn = ref<HTMLButtonElement | null>(null);
const cancelBtn = ref<HTMLButtonElement | null>(null);
// 打开时记录触发元素，关闭后归还焦点，避免焦点链断裂。
let triggerEl: HTMLElement | null = null;
// 防止同一轮事件循环内重复 close（按钮 click 与 keydown Enter 并发）。
let closing = false;

function close(result: 'confirm' | 'cancel') {
  if (closing) return;
  closing = true;
  emit('update:visible', false);
  if (result === 'confirm') emit('confirm');
  else emit('cancel');
}

function onOverlayClick() {
  // alert 模式（仅提示）不允许点遮罩关闭，避免用户误以为"取消"。
  if (props.mode === 'alert') return;
  close('cancel');
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    // alert 只有一个确定按钮，ESC 视为"知道了"→ confirm；
    // confirm 模式 ESC → cancel。
    close(props.mode === 'alert' ? 'confirm' : 'cancel');
  } else if (e.key === 'Enter') {
    e.preventDefault();
    close('confirm');
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      closing = false;
      triggerEl = document.activeElement as HTMLElement | null;
      document.addEventListener('keydown', onKeydown);
      nextTick(() => {
        // danger 操作默认聚焦"取消"，防误按回车删除；其余聚焦"确定"。
        // alert 模式无取消按钮，必然聚焦确定。
        if (props.danger && props.mode === 'confirm' && cancelBtn.value) {
          cancelBtn.value.focus();
        } else if (confirmBtn.value) {
          confirmBtn.value.focus();
        }
      });
    } else {
      document.removeEventListener('keydown', onKeydown);
      // 归还焦点到触发元素，恢复交互链。
      // 若触发元素已被移除（如确认删除后会话项从 DOM 消失），跳过以让焦点自然落到 body。
      nextTick(() => {
        if (triggerEl && document.contains(triggerEl) && typeof triggerEl.focus === 'function') {
          triggerEl.focus();
        }
        triggerEl = null;
      });
    }
  },
);

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="confirm-overlay" @click.self="onOverlayClick">
      <div
        class="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        :aria-label="title"
      >
        <div class="confirm-dialog__header">
          <h3>{{ title }}</h3>
        </div>
        <div class="confirm-dialog__body">
          <p>{{ message }}</p>
        </div>
        <div class="confirm-dialog__footer">
          <button
            v-if="mode === 'confirm'"
            ref="cancelBtn"
            type="button"
            class="cd-btn cd-btn--cancel"
            @click="close('cancel')"
          >
            {{ cancelText }}
          </button>
          <button
            ref="confirmBtn"
            type="button"
            :class="['cd-btn', danger ? 'cd-btn--danger' : 'cd-btn--primary']"
            @click="close('confirm')"
          >
            {{ confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}

.confirm-dialog {
  width: min(420px, 92vw);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  overflow: hidden;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
}

.confirm-dialog__header {
  padding: 16px 20px 0;
}

.confirm-dialog__header h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}

.confirm-dialog__body {
  padding: 10px 20px 18px;
}

.confirm-dialog__body p {
  margin: 0;
  color: var(--color-text);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.confirm-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 20px 16px;
}

.cd-btn {
  border-radius: var(--radius-md);
  padding: 8px 18px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.cd-btn--cancel {
  border: 1px solid var(--color-border);
  background: var(--color-panel-soft);
  color: var(--color-text);
}

.cd-btn--cancel:hover {
  border-color: var(--color-text-muted);
}

.cd-btn--primary {
  border: 0;
  background: var(--color-accent);
  color: #07120d;
  font-weight: 700;
}

.cd-btn--primary:hover {
  background: var(--color-accent-strong);
}

.cd-btn--danger {
  border: 0;
  background: var(--color-danger);
  color: #fff;
  font-weight: 700;
}

.cd-btn--danger:hover {
  filter: brightness(1.1);
}

.cd-btn:focus-visible {
  outline: 2px solid var(--color-accent-strong);
  outline-offset: 2px;
}
</style>
