<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import { useConfigStore, type ModelAlias } from '../../stores/config-store';

const store = useConfigStore();

const ALIASES: ReadonlyArray<{ id: ModelAlias; label: string }> = [
  { id: 'sonnet', label: 'sonnet（默认 · 均衡）' },
  { id: 'haiku', label: 'haiku（快速）' },
  { id: 'opus', label: 'opus（强力）' },
  { id: 'fable', label: 'fable（超长任务）' },
];

// 齿轮图标（Lucide settings，stroke 风格）。
const GEAR_BODY = 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z';

// 当前打开的上下文弹窗的别名（同时只一个）。null = 无弹窗。
const openCtx = ref<ModelAlias | null>(null);
const modalInputRef = ref<HTMLInputElement | null>(null);

async function openContextModal(alias: ModelAlias): Promise<void> {
  openCtx.value = alias;
  await nextTick();
  modalInputRef.value?.focus();
}
function closeCtx(): void {
  openCtx.value = null;
}
function handleEscape(e: KeyboardEvent): void {
  if (e.key === 'Escape' && openCtx.value) openCtx.value = null;
}
onMounted(() => document.addEventListener('keydown', handleEscape));
onUnmounted(() => document.removeEventListener('keydown', handleEscape));

// 该别名是否已设上下文覆盖（齿轮高亮 + 角标）。
function ctxValue(alias: ModelAlias): number | undefined {
  return store.config.contextWindowByAlias[alias];
}
function onModelInput(alias: ModelAlias, v: string): void {
  store.setModelMapping(alias, v);
}
// 弹窗内输入：实时写入当前打开别名。空/非正 → 清除（回落 200k）。
function onCtxInput(raw: string): void {
  if (!openCtx.value) return;
  const n = Number(raw);
  store.setContextWindowForAlias(openCtx.value, Number.isFinite(n) && n > 0 ? Math.floor(n) : null);
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}k`;
  return String(n);
}
</script>

<template>
  <div class="model-mapping">
    <div class="model-mapping__title">模型类型映射</div>
    <div class="model-mapping__grid">
      <div v-for="a in ALIASES" :key="a.id" class="model-mapping__field">
        <span>{{ a.label }}</span>
        <div class="model-mapping__row">
          <input
            type="text"
            placeholder="实际模型名，如 glm-5.2"
            autocomplete="off"
            spellcheck="false"
            :value="store.modelMappings[a.id] ?? ''"
            @input="onModelInput(a.id, ($event.target as HTMLInputElement).value)"
          />
          <div class="model-mapping__ctx-wrap">
            <button
              type="button"
              :class="['model-mapping__ctx-btn', { 'model-mapping__ctx-btn--set': ctxValue(a.id) !== undefined }]"
              :title="ctxValue(a.id) !== undefined ? `上下文窗口：${fmtTokens(ctxValue(a.id) as number)} token（点击修改）` : '设置该别名的上下文窗口（默认 200k）'"
              @click="openContextModal(a.id)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path :d="GEAR_BODY" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <span v-if="ctxValue(a.id) !== undefined" class="model-mapping__ctx-tag">{{ fmtTokens(ctxValue(a.id) as number) }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 居中弹窗：Teleport 到 body，遮罩 + 居中卡片，与 InteractionPrompt 同款视觉。
       点击遮罩 / Esc / 完成 关闭。尺寸 rem，随字号等比。 -->
  <Teleport to="body">
    <div v-if="openCtx" class="ctx-modal-overlay" @click.self="closeCtx">
      <section class="ctx-modal" role="dialog" aria-modal="true" :aria-label="`设置 ${openCtx} 上下文窗口`">
        <header class="ctx-modal__header">
          <span class="ctx-modal__eyebrow">模型类型映射</span>
          <h4>设置 {{ openCtx }} 上下文窗口</h4>
        </header>
        <div class="ctx-modal__body">
          <input
            ref="modalInputRef"
            type="number"
            min="1"
            placeholder="如 1000000（留空默认 200k）"
            :value="ctxValue(openCtx) ?? ''"
            @input="onCtxInput(($event.target as HTMLInputElement).value)"
          />
          <p class="ctx-modal__hint">单位 token · 留空使用默认 200k。连通后仍以 SDK 上报的真实窗口为准。</p>
        </div>
        <footer class="ctx-modal__footer">
          <button type="button" class="ctx-modal__btn ctx-modal__btn--primary" @click="closeCtx">完成</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.model-mapping {
  display: grid;
  gap: 0.5rem;
}

.model-mapping__title {
  color: var(--color-text);
  font-size: 0.8125rem;
  font-weight: 600;
}

.model-mapping__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

.model-mapping__field {
  display: grid;
  gap: 0.375rem;
}

.model-mapping__field span {
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

/* 模型名输入框 + 齿轮同行：stretch 让 wrap 与 input 等高 */
.model-mapping__row {
  display: flex;
  gap: 0.375rem;
  align-items: stretch;
}

.model-mapping__row input {
  min-width: 0;
  flex: 1;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0.5rem 0.625rem;
  font-size: 0.8125rem;
}

/* wrap 是齿轮的定位上下文；display:flex 让按钮 stretch 到 wrap 高（=input 高），
   按钮内容用 align-items:center 垂直居中 → 齿轮位于 input 正中央高度。 */
.model-mapping__ctx-wrap {
  position: relative;
  flex-shrink: 0;
  display: flex;
}

.model-mapping__ctx-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
  padding: 0 0.5rem;
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
}

.model-mapping__ctx-btn:hover {
  color: var(--color-text);
  border-color: var(--color-accent);
}

.model-mapping__ctx-btn svg {
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.model-mapping__ctx-btn--set {
  color: var(--color-accent-strong);
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 12%, var(--color-panel-soft));
}

.model-mapping__ctx-tag {
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

/* ── 居中弹窗（与 InteractionPrompt 同款视觉，复用 interaction-tokens）── */
.ctx-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: grid;
  place-items: center;
  padding: 1.25rem;
  background: var(--interaction-overlay-bg);
}

.ctx-modal {
  display: flex;
  flex-direction: column;
  width: min(24rem, 94vw);
  max-height: min(86vh, 47.5rem);
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--color-accent-strong) 35%, var(--color-border));
  border-radius: var(--interaction-panel-radius);
  background: var(--color-panel);
  box-shadow: var(--interaction-shadow);
}

.ctx-modal__header {
  user-select: none;
  padding: var(--interaction-header-pad);
  border-bottom: 1px solid var(--color-border);
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 12%, transparent), transparent 72%);
}

.ctx-modal__eyebrow {
  display: inline-flex;
  margin-bottom: 0.5rem;
  color: var(--color-accent-strong);
  font-size: 0.6875rem;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.ctx-modal__header h4 {
  margin: 0;
  font-size: 1rem;
  line-height: 1.4;
}

.ctx-modal__body {
  display: grid;
  gap: 0.5rem;
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--interaction-body-pad);
}

.ctx-modal__body input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 0.5625rem 0.625rem;
  background: var(--color-panel-soft);
  color: var(--color-text);
  font: inherit;
  outline: none;
}

.ctx-modal__body input:focus {
  border-color: var(--color-accent-strong);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 18%, transparent);
}

.ctx-modal__hint {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.ctx-modal__footer {
  display: flex;
  flex-shrink: 0;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: var(--interaction-footer-pad);
}

.ctx-modal__btn {
  border: 0;
  border-radius: var(--interaction-btn-radius);
  padding: var(--interaction-btn-pad);
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 750;
  cursor: pointer;
}

.ctx-modal__btn--primary {
  background: var(--color-accent);
  color: var(--color-on-accent);
  box-shadow: var(--ring-light-accent);
}
</style>
