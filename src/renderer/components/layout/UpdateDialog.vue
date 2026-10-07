<!-- UpdateDialog.vue：发现新版本弹窗（R2）——App.vue 单例常驻，v-if 随 update-store.dialogVisible
     挂载/卸载。z-index 1100：低于 interaction 1200（引擎权限审批优先级更高），高于普通内容；
     全局 toast 3000 最顶。ESC 与遮罩点击 =「稍后提醒」（dismissedVersions 本次运行内记忆）。
     2026-09-29 A 案视觉重排：图标章头部 + 版本对比 pill 行（对照 docs/prototypes/about-tab/a-identity-hero.html）；
     script 逻辑与全部 data-testid 零改动。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue';
import { useUpdateStore } from '../../stores/update-store';
import { ESC_LAYER_PRIORITY, pushEscLayer, type EscLayerHandle } from '../../composables/use-esc-stack';

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
// A9（D14-F5）：弹窗可见期间注册 Esc 层（1100）——更高层遮罩（交互弹窗 1200/导出格式/灯箱）
// 在场时让位，Esc 只作用最上层，不把被遮挡、用户从未决策的版本记入 dismissedVersions。
let escHandle: EscLayerHandle | null = null;
watch(() => updateStore.dialogVisible, (visible) => {
  if (visible && !escHandle) escHandle = pushEscLayer(ESC_LAYER_PRIORITY.updateDialog);
  else if (!visible && escHandle) {
    escHandle.release();
    escHandle = null;
  }
});

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !updateStore.dialogVisible) return;
  // A9（D14-F5）：更高层遮罩在场时让位（不消费、不记 dismissed）。
  if (escHandle && !escHandle.isTopmost()) return;
  // X3（R14-F1）：本组件消费 Esc 时 preventDefault——ChatPage 的 e.defaultPrevented 急停
  // 守卫随即让位，防一次 Esc 双吞（dismiss 弹窗 + abort 流式回合，队列场景连锁熔断）。
  e.preventDefault();
  updateStore.dismissUpdate();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  // A9：卸载兜底出栈（release 幂等）。
  escHandle?.release();
  escHandle = null;
});
</script>

<template>
  <div v-if="updateStore.dialogVisible" class="update-dialog__overlay" @click.self="updateStore.dismissUpdate()">
    <div class="update-dialog" data-testid="update-dialog" role="dialog" aria-modal="true" aria-label="发现新版本">
      <div class="update-dialog__head">
        <span class="update-dialog__head-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
        </span>
        <h3 class="update-dialog__title">发现新版本</h3>
      </div>
      <div class="update-dialog__version">
        <span class="update-dialog__v">v{{ updateStore.currentVersion }}</span>
        <svg class="update-dialog__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
        <span class="update-dialog__v update-dialog__v--new">v{{ updateStore.state.newVersion ?? '?' }}</span>
      </div>

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
  width: min(27.5rem, calc(100vw - 3rem)); /* 27.5rem=440px，对齐原型 .ud 与计划意图（R2 备忘：26rem 实为 416px） */
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-lg);
  background: var(--color-panel);
  color: var(--color-text);
  padding: 1.125rem 1.375rem;
  box-shadow: var(--ring-light), var(--elevation-3);
}

/* 头部：图标章 + 标题（2026-09-29 A 案）。 */
.update-dialog__head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.update-dialog__head-icon {
  width: 2.375rem;
  height: 2.375rem;
  border-radius: var(--radius-md);
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--color-accent) 14%, transparent);
  color: var(--color-accent-strong);
  flex: none;
}

.update-dialog__head-icon svg {
  width: 19px;
  height: 19px;
}

.update-dialog__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 650;
}

/* 版本对比行：两枚 mono pill（当前=中性、新版=accent 染色）夹箭头。 */
.update-dialog__version {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
}

.update-dialog__v {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  padding: 0.1875rem 0.625rem;
  border-radius: var(--radius-pill);
  border: 1px solid var(--color-border);
  background: var(--color-panel-soft);
}

.update-dialog__v--new {
  border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  color: var(--color-accent-strong);
  font-weight: 650;
}

.update-dialog__arrow {
  width: 14px;
  height: 14px;
  color: var(--color-text-muted);
  flex: none;
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
