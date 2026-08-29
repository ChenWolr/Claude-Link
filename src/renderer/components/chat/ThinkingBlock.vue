<script setup lang="ts">
// ThinkingBlock —— openhanako 风格的轻量思考行。
// 一行「💭 思考完成 / 思考中 ···」，点击展开看内容。流式时默认展开。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { createFollowController, type FollowController } from '../../utils/follow-scroll';
import { renderMarkdown } from '../../utils/markdown';

const props = defineProps<{ content: string; streaming?: boolean; sealed?: boolean; defaultOpen?: boolean; exportMode?: boolean }>();

// 导出模式：思考详情保持默认闭合、不可展开。
const open = ref(props.exportMode ? false : (props.defaultOpen ?? !!props.streaming));
function toggle(): void {
  if (props.exportMode) return;
  open.value = !open.value;
}
// 思考正文唯一 id，供 aria-controls 指向（多实例不能硬编码）。
const bodyId = useId();
const rendered = computed(() => renderMarkdown(props.content, 'static'));
const preview = computed(() => {
  const summary = props.content.replace(/\s+/g, ' ').trim();
  const codePoints = Array.from(summary);
  return codePoints.slice(0, 90).join('');
});
const active = computed(() => props.streaming || props.sealed === false);

// —— 内滚动窗口状态（方案 A）：展开态封顶内滚 + 流式贴底跟随 ——
const bodyEl = ref<HTMLElement | null>(null);
let ctrl: FollowController | null = null;
const fadeTop = ref(false);
const fadeBottom = ref(false);
// pillVisible 用 ref 镜像 ctrl.pillVisible()（ctrl 非响应式，直接绑不可更新）
const pillVisible = ref(false);
const charCount = computed(() => Array.from(props.content).length);

function syncPill(): void {
  pillVisible.value = ctrl?.pillVisible() ?? false;
}
function updateFades(): void {
  const el = bodyEl.value;
  if (!el) return;
  fadeTop.value = el.scrollTop > 12;
  fadeBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight > 12;
}
function onBodyScroll(): void {
  ctrl?.onUserScroll();
  updateFades();
  syncPill();
}
function onPillClick(): void {
  ctrl?.jumpToLatest();
  updateFades();
  syncPill();
}

onMounted(() => {
  if (bodyEl.value) ctrl = createFollowController(bodyEl.value);
  ctrl?.setLive(active.value); // immediate 语义：挂载即对齐当前流式状态
  syncPill();
  updateFades();
});
onBeforeUnmount(() => { ctrl = null; });

// 流式起止：live 切换（streaming/sealed 变化都会走 active）
watch(active, (v) => {
  ctrl?.setLive(v);
  syncPill();
});
// 内容追加（rendered 经 markdown 重渲）：跟随或保持
watch(rendered, async () => {
  await nextTick(); // 等 DOM 更新后再读 scrollHeight，避免少滚一段
  ctrl?.onContentGrown();
  updateFades();
  syncPill();
});
// 收起→展开：流式中回到贴底；非流式保持原位（v-show 常驻 DOM，位置本就保留）
watch(open, async (v) => {
  if (!v) return;
  await nextTick();
  ctrl?.onUserScroll();
  if (active.value && ctrl?.stick) ctrl?.onContentGrown();
  updateFades();
  syncPill();
});
</script>

<template>
  <div class="think-row">
    <button type="button" class="think-row__head" :class="{ 'think-row__head--open': open, 'think-row__head--readonly': exportMode }" :aria-expanded="open" :aria-controls="bodyId" @click="toggle">
      <span class="think-row__icon">💭</span>
      <span class="think-row__label">{{ active ? '思考中' : '思考完成' }}</span>
      <span v-if="active" class="think-row__dots" aria-hidden="true"><span></span><span></span><span></span></span>
      <span v-else-if="!open && preview" class="think-row__preview">{{ preview }}…</span>
      <span v-if="open && !exportMode" class="think-row__count">{{ charCount.toLocaleString('zh-CN') }} 字</span>
      <span class="think-row__arrow">›</span>
    </button>
    <div v-show="open" class="think-row__win" :data-fade-top="fadeTop ? 'on' : 'off'" :data-fade-bottom="fadeBottom ? 'on' : 'off'">
      <div
        :id="bodyId"
        ref="bodyEl"
        class="think-row__body markdown-body"
        tabindex="0"
        role="region"
        :aria-label="active ? '思考过程内容，生成中，可滚动查看' : '思考过程内容，可滚动查看'"
        v-html="rendered"
        @scroll="onBodyScroll"
      />
      <button v-if="pillVisible" type="button" class="think-row__pill" @click="onPillClick">↓ 回到最新</button>
    </div>
  </div>
</template>

<style scoped>
.think-row {
  width: 100%;
}

.think-row__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 8px;
  font-size: 0.8125rem;
  color: var(--color-text-muted);
  background: transparent;
  border: 0;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  border-radius: var(--radius-sm);
  transition: background 0.15s, color 0.15s;
}

.think-row__head:hover {
  color: var(--color-text);
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
}

.think-row__icon {
  font-size: 0.875rem;
  flex-shrink: 0;
}

.think-row__label {
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}

/* R5（问题 1）：「思考中」用 3 个脉冲动画点取代静态「···」，让用户看到动态反馈。 */
.think-row__dots {
  display: inline-flex;
  gap: 3px;
  align-items: center;
}

.think-row__dots span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color-accent-strong);
  animation: think-dot-pulse 1.4s infinite ease-in-out both;
}

.think-row__dots span:nth-child(2) {
  animation-delay: 0.16s;
}

.think-row__dots span:nth-child(3) {
  animation-delay: 0.32s;
}

@keyframes think-dot-pulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}

.think-row__preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.75rem;
  opacity: 0.7;
}

.think-row__arrow {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: 0.75rem;
  transition: transform 0.15s;
}

.think-row__head--open .think-row__arrow {
  transform: rotate(90deg);
}

/* 原 .think-row__body 的 margin/border-left 移到 wrapper（渐隐不压边线） */
.think-row__win {
  position: relative;
  margin: 2px 0 2px 6px;
  border-left: 2px solid var(--color-border);
  background: var(--color-bg); /* 渐隐用，跟随主题 */
}

.think-row__body {
  max-height: clamp(180px, 45vh, 460px);
  overflow-y: auto;
  overscroll-behavior: auto; /* 显式：窗内滚到底自然接续页面滚动 */
  padding: 8px 10px 10px;
  font-size: 0.8125rem;
  color: var(--color-text);
  line-height: 1.5;
  word-break: break-word;
  scrollbar-width: thin;
  scrollbar-color: rgba(122, 96, 88, 0.35) transparent;
}

.think-row__body::-webkit-scrollbar { width: 8px; }

.think-row__body::-webkit-scrollbar-thumb {
  background: rgba(122, 96, 88, 0.28);
  border-radius: var(--radius-pill);
  border: 2px solid var(--color-bg);
}

.think-row__body:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
  border-radius: var(--radius-xs);
}

/* 边缘渐隐：方向暗示，颜色跟随主题令牌（禁止写死 #F8F4ED） */
.think-row__win::before,
.think-row__win::after {
  content: '';
  position: absolute;
  left: 2px; right: 0; height: 28px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s var(--ease-out, ease-out);
  z-index: 2;
}

.think-row__win::before { top: 0; background: linear-gradient(var(--color-bg), transparent); }

.think-row__win::after { bottom: 0; background: linear-gradient(transparent, var(--color-bg)); }

.think-row__win[data-fade-top='on']::before { opacity: 1; }

.think-row__win[data-fade-bottom='on']::after { opacity: 1; }

/* 「回到最新」浮标 */
.think-row__pill {
  position: absolute;
  left: 50%; bottom: 12px;
  transform: translateX(-50%);
  z-index: 5;
  border: 0;
  cursor: pointer;
  background: var(--color-accent-strong);
  color: var(--color-on-accent);
  border-radius: var(--radius-pill);
  padding: 4px 14px;
  font-size: 0.75rem;
  font-weight: 500;
  box-shadow: var(--elevation-2);
  transition: background 0.15s;
}

.think-row__pill:hover { background: var(--color-accent); }

.think-row__pill:focus-visible { outline: 2px solid var(--color-accent-strong); outline-offset: 2px; }

/* 字数（头部） */
.think-row__count {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .think-row__win::before,
  .think-row__win::after,
  .think-row__pill { transition: none; }
}

.think-row__body :deep(p) {
  margin: 0 0 0.25rem;
}

.think-row__body :deep(p:last-child) {
  margin-bottom: 0;
}
</style>
