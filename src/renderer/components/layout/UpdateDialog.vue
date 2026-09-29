<!-- UpdateDialog.vue：发现新版本弹窗（R2）——App.vue 单例常驻，v-if 随 update-store.dialogVisible
     挂载/卸载。z-index 1100：低于 interaction 1200（引擎权限审批优先级更高），高于普通内容；
     全局 toast 3000 最顶。ESC 与遮罩点击 =「稍后提醒」（dismissedVersions 本次运行内记忆）。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useUpdateStore } from '../../stores/update-store';

const updateStore = useUpdateStore();
const status = computed(() => updateStore.status);
const progress = computed(() => updateStore.state.progress);
// 下载进度文案（MB 四舍五入整数，与关于 tab updateStatusText 同口径）。
const progressText = computed(() => {
  const p = progress.value;
  return p ? `${p.percent}%（${Math.round(p.transferred / 1048576)}/${Math.round(p.total / 1048576)} MB）` : '';
});

// ESC = 稍后提醒。监听随组件常驻挂载，dialogVisible 守卫兜底：弹窗未开时按 ESC
// 不得把当前 newVersion 误写进 dismissedVersions（全局键位与 ChatPage Esc 急停并存，互不影响）。
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && updateStore.dialogVisible) updateStore.dismissUpdate();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div v-if="updateStore.dialogVisible" class="update-dialog__overlay" @click.self="updateStore.dismissUpdate()">
    <div class="update-dialog" data-testid="update-dialog" role="dialog" aria-modal="true" aria-label="发现新版本">
      <h3 class="update-dialog__title">发现新版本</h3>
      <p class="update-dialog__version">
        当前 v{{ updateStore.currentVersion }} → 最新 v{{ updateStore.state.newVersion ?? '?' }}
      </p>

      <div class="update-dialog__status" data-testid="update-dialog-status">
        <template v-if="status === 'available'">正在准备下载…</template>
        <template v-else-if="status === 'downloading'">
          <div class="update-dialog__bar">
            <div class="update-dialog__bar-fill" :style="{ width: `${progress?.percent ?? 0}%` }"></div>
          </div>
          <span>{{ progressText }}</span>
        </template>
        <template v-else-if="status === 'downloaded'">已下载就绪，重启应用后安装。</template>
      </div>

      <details v-if="updateStore.state.releaseNotes" class="update-dialog__notes">
        <summary>更新说明</summary>
        <pre>{{ updateStore.state.releaseNotes }}</pre>
      </details>

      <footer class="update-dialog__footer">
        <button
          type="button"
          class="update-dialog__btn"
          data-testid="update-dialog-dismiss"
          @click="updateStore.dismissUpdate()"
        >稍后提醒</button>
        <button
          type="button"
          class="update-dialog__btn update-dialog__btn--primary"
          data-testid="update-dialog-install"
          :disabled="status !== 'downloaded'"
          @click="updateStore.install()"
        >立即重启更新</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.update-dialog__overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.4);
}

.update-dialog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(420px, calc(100vw - 48px));
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  color: var(--color-text);
  padding: 18px 20px;
  box-shadow: var(--ring-light), var(--elevation-2);
}

.update-dialog__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 650;
}

.update-dialog__version {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}

/* 状态区（三态分化）：available 准备中 / downloading 进度条+百分比 / downloaded 就绪。 */
.update-dialog__status {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.78125rem;
  color: var(--color-text-muted);
}

.update-dialog__bar {
  height: 6px;
  border-radius: 3px;
  background: var(--color-panel-soft);
  overflow: hidden;
}

.update-dialog__bar-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--color-accent);
  transition: width var(--duration-base) var(--ease-out);
}

.update-dialog__notes {
  font-size: 0.78125rem;
  color: var(--color-text-muted);
}

.update-dialog__notes summary {
  cursor: pointer;
  user-select: none;
}

.update-dialog__notes pre {
  max-height: 180px;
  margin: 8px 0 0;
  padding: 10px;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  font-size: 0.75rem;
  white-space: pre-wrap;
  word-break: break-word;
}

.update-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.update-dialog__btn {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 6px 14px;
  font-size: 0.78125rem;
  font-weight: 600;
  cursor: pointer;
}

.update-dialog__btn--primary {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: var(--color-on-accent);
}

.update-dialog__btn--primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
