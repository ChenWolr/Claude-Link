<script setup lang="ts">
// ThinkingBlock —— openhanako 风格的轻量思考行。
// 一行「💭 思考完成 / 思考中 ···」，点击展开看内容。流式时默认展开。
// P5 挂载点 C（2026-11-19 UI 五点批次，变更二）：思考块按需翻译——展开态出现独立入口钮
//（.think-row__headrow 操作组），body 原文/译文二选一（译文 = static profile 渲染 + 段级
// fadeIn/shimmer，同款呈现语言）；译文视口沿用思考块自身滚动窗（clamp(180px,45vh,460px)
// 内滚 + FollowController 贴底），240px 约束只适用于正文视口（A/B）。
// 范围收窄（01 §5.4-C）：TaskQueuePanel 子 agent 思考快照（:732/:785）不接翻译——该文件零
// 改动，由本组件按 DOM 祖先（.task-panel 子树）自别，整体禁用翻译入口与译文替换。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { createFollowController, type FollowController } from '../../utils/follow-scroll';
import { renderMarkdown } from '../../utils/markdown';
// P6-B（2026-11-21）：思考正文 md 文件链接右键委托入口（与 MessageBubble 同款薄壳；左键零动作）。
import { useFileLinkMenuStore } from '../../stores/file-link-menu-store';
import { useSessionStore } from '../../stores/session-store';
import { useTranslationStore } from '../../stores/translation-store';
import { useTranslationDisplay, type TranslationDisplayBlock } from '../../composables/use-translation-display';
import TranslateButton from './TranslateButton.vue';
import TranslationChrome from './TranslationChrome.vue';
import type { TranslationTarget } from '../../../shared/translation-core';

const props = defineProps<{ content: string; streaming?: boolean; sealed?: boolean; defaultOpen?: boolean; exportMode?: boolean; messageId?: string }>();

// 导出模式：思考详情保持默认闭合、不可展开。
const open = ref(props.exportMode ? false : (props.defaultOpen ?? !!props.streaming));
// hb10-CHR-09：懒渲染——body 首次展开后才挂载（v-if+v-show 组合），到达瞬间不再全量渲染
// 折叠思考块；展开过一次后 DOM 常驻。
// hb13-v 批C 注释如实化（chat-render F4）：懒挂载的块（fold 内思考行——初始折叠、非 streaming）
// 其 follow-scroll 控制器仅在组件 onMounted 时 bodyEl 已存在才创建，故首次展开后 ctrl 恒 null：
// 流式中展开该行无「回到贴底」跟随、无「↓ 回到最新」浮标（顶部 streaming 思考行不受影响）。
// 「内滚位置保留语义不变」仅对 DOM 常驻成立，跟随能力对懒挂载体不生效——如实声明。
const everOpened = ref(open.value);
function toggle(): void {
  if (props.exportMode) return;
  open.value = !open.value;
  if (open.value) everOpened.value = true;
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

// ── P5 挂载点 C：思考块按需翻译 ──
// target：messageId 有值=落库且非 redacted（ProcessGroup 只对非 redacted_thinking 传 messageId）
// → {kind:'thinking'}；否则流式挂载（MessageList:423 不传 messageId）→ {kind:'thinking-stream'}。
// sessionId 取活动会话（本组件只在活动会话视图内渲染——主流程消息与子 agent 快照同会话）。
const sessionStore = useSessionStore();
const translationStore = useTranslationStore();
// TaskQueuePanel 子 agent 思考快照自别（该文件零改动的范围收窄落点）：挂载后 DOM 位置不变，
// .task-panel 祖先判定一次即可；判定前的首帧窗口内入口可点性由后置渲染覆盖（亚帧级，无实感）。
const rootEl = ref<HTMLElement | null>(null);
const inTaskPanel = ref(false);
onMounted(() => {
  inTaskPanel.value = !!rootEl.value?.closest('.task-panel');
});
const translationTarget = computed<TranslationTarget>(() =>
  props.messageId !== undefined ? { kind: 'thinking', messageId: props.messageId } : { kind: 'thinking-stream' },
);
const translationEntry = computed(() => {
  if (inTaskPanel.value || props.exportMode) return undefined;
  return translationStore.forTarget(sessionStore.activeSession?.id, translationTarget.value);
});
// body 二选一判定：showingTranslation（变体三视图态）且未中止。stopped=已中止回落原文；
// error 态仍显示译文容器（已译段保留 + 横条重试，不整块消失）。
const showThinkingTranslation = computed(() => {
  const e = translationEntry.value;
  return !!e && e.showingTranslation && e.status !== 'stopped';
});
const chromeVisible = computed(() => {
  const e = translationEntry.value;
  return !!e && e.status !== 'stopped';
});
const translationProgress = computed(() => {
  const e = translationEntry.value;
  if (!e || e.totalSegments === 0) return 0;
  return Math.round((e.segments.length / e.totalSegments) * 100);
});
const translateState = computed<'idle' | 'translating' | 'done' | 'error'>(() => {
  const s = translationEntry.value?.status;
  if (s === 'translating') return 'translating';
  if (s === 'error') return 'error';
  if (s === 'done') return 'done';
  return 'idle';
});

// 入口钮可见性（单一表达式，01 §5.4-C）：①open=展开态才能点（折叠态不显示入口，默认折叠
// 行为不变）；②messageId !== undefined=落库且非 redacted（redacted 内容是中文占位，翻译无意义）；
// ③streaming=流式思考挂载（MessageList:423，无 messageId）。外加范围收窄守卫
// !inTaskPanel（TaskQueuePanel 子 agent 快照整体禁翻译，01 §5.4-C 声明）。
const entryVisible = computed(() =>
  !inTaskPanel.value && !props.exportMode && open.value && props.content.trim().length > 0
    && (props.messageId !== undefined || props.streaming === true),
);

// 入口钮点击路由（同挂载点 A）：无 entry/stopped→START（源=props.content）；translating→STOP
//（唯一「中止」路径）；done→toggleShowing；error→RETRY。swap pill 只切视图（toggleShowing）。
function onEntryClick(): void {
  const sid = sessionStore.activeSession?.id;
  if (!sid) return;
  const e = translationEntry.value;
  if (!e || e.status === 'stopped') {
    void translationStore.start(sid, translationTarget.value, props.content);
    return;
  }
  if (e.status === 'translating') void translationStore.stop(e.translationId);
  else if (e.status === 'error') void translationStore.retry(e.translationId);
  else translationStore.toggleShowing(e.translationId);
}
function onTranslationSwap(): void {
  const e = translationEntry.value;
  if (e) translationStore.toggleShowing(e.translationId);
}
function onTranslationRetry(): void {
  const e = translationEntry.value;
  if (e) void translationStore.retry(e.translationId);
}

// 译文独立节流显示（工厂 = use-stream makeThrottle，50ms；与正文各自实例化——互不串流）。
const { blocks: translatedBlocks } = useTranslationDisplay(computed(() => translationEntry.value?.translationId));
function renderTranslatedBlock(block: TranslationDisplayBlock): string {
  return renderMarkdown(block.text, 'static');
}
const translatedCount = computed(() => translationEntry.value?.segments.length ?? 0);
const totalSegments = computed(() => translationEntry.value?.totalSegments ?? 0);
const remainingSegments = computed(() => Math.max(0, totalSegments.value - translatedCount.value));
const shimmerVisible = computed(() => translateState.value === 'translating' && remainingSegments.value > 0);
const shimmerWidth = computed(() => (totalSegments.value === 0 || remainingSegments.value > 1 ? '86%' : '52%'));

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

// P6-B（2026-11-21）：思考正文 md 文件链接右键委托——与 MessageBubble.onContentContextMenu 同款
// 手法（closest('.md-file-link') 命中后取 data-clip-path 弹 useFileLinkMenuStore 右键菜单；左键
// 零动作）。非文件链接不拦截（外链系统菜单照旧）；无 data-clip-path（异常渲染）时静默忽略，
// 不抛错；exportMode（导出快照）不弹。
function onBodyContextMenu(e: MouseEvent): void {
  const el = (e.target as HTMLElement | null)?.closest?.('.md-file-link') as HTMLElement | null;
  if (!el) return;
  e.preventDefault();
  const p = el.getAttribute('data-clip-path');
  if (p) useFileLinkMenuStore().open(p, e.clientX, e.clientY);
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
// P5：译文增长接同一条内容增长跟随链（译文替换态下 rendered 不再增长，须独立 watch）——
// watch(译文渲染 blocks) 调 ctrl?.onContentGrown()，形态照上（01 §5.4-C）。
watch(translatedBlocks, async () => {
  if (!showThinkingTranslation.value) return;
  await nextTick();
  ctrl?.onContentGrown();
  updateFades();
  syncPill();
});
// 收起→展开：流式中回到贴底（仅挂载时 bodyEl 已存在的行，fold 内懒挂载行 ctrl=null 不跟随
// ——见顶部 hb13-v 批C 注记）；非流式保持原位（v-show 常驻 DOM，位置本就保留）
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
  <div ref="rootEl" class="think-row">
    <!-- P5 挂载点 C：head 行包进 .think-row__headrow（新 flex 行）——现有 head 按钮占满 + 右侧
         操作组（入口钮 + chrome）。入口钮可见性单一表达式见 entryVisible computed。 -->
    <div class="think-row__headrow">
      <button type="button" class="think-row__head" :class="{ 'think-row__head--open': open, 'think-row__head--readonly': exportMode }" :aria-expanded="open" :aria-controls="bodyId" @click="toggle">
        <span class="think-row__icon">💭</span>
        <span class="think-row__label">{{ active ? '思考中' : '思考完成' }}</span>
        <span v-if="active" class="think-row__dots" aria-hidden="true"><span></span><span></span><span></span></span>
        <span v-else-if="!open && preview" class="think-row__preview">{{ preview }}…</span>
        <span v-if="open && !exportMode" class="think-row__count">{{ charCount.toLocaleString('zh-CN') }} 字</span>
        <span class="think-row__arrow">›</span>
      </button>
      <div v-if="entryVisible || chromeVisible" class="think-row__ops">
        <TranslateButton
          v-if="entryVisible"
          :state="translateState"
          :progress="translationProgress"
          :error-text="translationEntry?.error"
          @click="onEntryClick"
        />
        <TranslationChrome
          v-if="translationEntry && chromeVisible"
          :status="translationEntry.status"
          :progress="translationProgress"
          :showing-translation="showThinkingTranslation"
          @swap="onTranslationSwap"
        />
      </div>
    </div>
    <div v-if="everOpened" v-show="open" class="think-row__win" :data-fade-top="fadeTop ? 'on' : 'off'" :data-fade-bottom="fadeBottom ? 'on' : 'off'">
      <!-- P5：body 原文/译文二选一。译文 = static profile（与现状 :28 一致）段级渲染 + 段级
           fadeIn + shimmer 占位 + error 横条；同一滚动窗（.think-row__body 自身 clamp 内滚 +
           FollowController 贴底不变）。 -->
      <div
        v-if="showThinkingTranslation"
        :id="bodyId"
        ref="bodyEl"
        class="think-row__body markdown-body"
        tabindex="0"
        role="region"
        aria-label="思考过程译文，可滚动查看"
        @contextmenu="!exportMode && onBodyContextMenu($event)"
        @scroll="onBodyScroll"
      >
        <div v-for="block in translatedBlocks" :key="block.key" class="think-row__tr-seg fade-seg" v-html="renderTranslatedBlock(block)" />
        <div v-if="shimmerVisible" class="think-row__shimmer" :style="{ width: shimmerWidth }" aria-hidden="true"></div>
        <div v-if="translationEntry && translationEntry.status === 'error'" class="think-row__tr-error" data-testid="thinking-translation-error">
          <span class="think-row__tr-error-text">{{ translationEntry.error || '翻译失败' }}</span>
          <button type="button" class="think-row__tr-error-retry" title="仅重译失败段（已完成段不重复计费）" @click="onTranslationRetry">重试</button>
        </div>
      </div>
      <div
        v-else
        :id="bodyId"
        ref="bodyEl"
        class="think-row__body markdown-body"
        tabindex="0"
        role="region"
        :aria-label="active ? '思考过程内容，生成中，可滚动查看' : '思考过程内容，可滚动查看'"
        v-html="rendered"
        @contextmenu="!exportMode && onBodyContextMenu($event)"
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

/* P5 挂载点 C：head 行容器（head 按钮占满 + 右侧操作组）。 */
.think-row__headrow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.think-row__ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

/* P5：width:100% → flex:1 占满（headrow flex 行内既有语义等价——无操作组时独占整行）。 */
.think-row__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
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

/* 文件链接（p5，2026-11-04）：与 MessageBubble .bubble__content :deep(.md-file-link) 同款——
   accent 色 + 点状下划线标示「可点开预览」，与普通网页外链区分；v-html 内容须 :deep 穿透。
   hover 切实线下划线给明确可点反馈。 */
.think-row__body :deep(.md-file-link) {
  color: var(--color-accent-strong);
  font-weight: 500;
  cursor: pointer;
  text-decoration: underline dotted;
  text-decoration-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
  text-underline-offset: 4px;
}

.think-row__body :deep(.md-file-link:hover) {
  text-decoration-style: solid;
  color: var(--color-accent);
}

/* ── P5 挂载点 C：思考译文呈现（同款 fadeIn/shimmer/error 语言，样式挂 body 内）── */
.think-row__tr-seg {
  min-width: 0;
}

/* 已译段渐显（同 TranslationViewport .fade-seg：260ms ease-out both；段为渐显单位）。 */
.think-row__tr-seg.fade-seg {
  animation: think-tr-fade-in 260ms var(--ease-out, ease-out) both;
}

@keyframes think-tr-fade-in {
  from {
    opacity: 0;
    transform: translateY(2px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* 未译余量 shimmer 占位（同 .tr-shimmer 配方）。 */
.think-row__shimmer {
  height: 0.875rem;
  margin: 0.5rem 0;
  border-radius: 4px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--color-text) 8%, transparent) 25%,
    color-mix(in srgb, var(--color-text) 14%, transparent) 45%,
    color-mix(in srgb, var(--color-text) 8%, transparent) 65%
  );
  background-size: 240% 100%;
  animation: think-tr-shimmer-flow 1.3s linear infinite;
}

@keyframes think-tr-shimmer-flow {
  from {
    background-position: 120% 0;
  }
  to {
    background-position: -120% 0;
  }
}

/* error 态：body 内 danger 横条 + 重试（不整块消失，已译段保留）。 */
.think-row__tr-error {
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid color-mix(in srgb, var(--color-danger) 35%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-danger) 8%, transparent);
}

.think-row__tr-error-text {
  flex: 1;
  min-width: 0;
  font-size: 0.75rem;
  line-height: 1.4;
  color: var(--color-danger);
  word-break: break-word;
}

.think-row__tr-error-retry {
  flex: none;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel);
  color: var(--color-text);
  font-size: 0.75rem;
  font-family: inherit;
  padding: 2px 10px;
  cursor: pointer;
}

.think-row__tr-error-retry:hover {
  border-color: var(--color-danger);
  color: var(--color-danger);
}

@media (prefers-reduced-motion: reduce) {
  .think-row__tr-seg.fade-seg,
  .think-row__shimmer {
    animation: none;
  }
}
</style>
