<script setup lang="ts">
// FilePreviewDrawer.vue（2026-11-04 计划 round-001 p2，p9 接 body 渲染分发表）
// 方案 C 浮动抽屉预览卡：视觉 1:1 对齐 docs/prototypes/file-preview-panel/option-c-overlay-drawer.html。
// body 分发表（p9）：loading / 读取失败 / missing + text 类（ext+mode 联判——md preview 走
// markdown-it+v-enrich、html web 走 sandbox iframe、svg preview 走 img、mmd graph 走 mermaid
// 占位管线，其余源码视图）+ blob 类（image/img、media/video|audio、pdf/docx/xlsx/pptx 四重组件）。
// 开关态由 preview-store.open 驱动 .open class（遮罩透明度 + 抽屉 translateX 过渡）；
// Esc 层 1040（见 use-esc-stack.ts 注释），window keydown 全局监听、isTopmost() 裁决后消费。
import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import hljs from 'highlight.js';
import { usePreviewStore } from '../../stores/preview-store';
import { useFilePreview } from '../../composables/useFilePreview';
import { extOfPath, previewFormatInfo, base64ToUint8Array, type PreviewMode } from '../../utils/preview-format';
import { ESC_LAYER_PRIORITY, pushEscLayer, type EscLayerHandle } from '../../composables/use-esc-stack';
import { copyTextToClipboard } from '../../utils/clipboard';
import { renderMarkdown, getFileLinkWorkspaceRoot } from '../../utils/markdown';
import { isAbsolutePathForm } from '../../utils/file-link';
import { enrichMarkdown as vEnrich } from '../../directives/enrich-markdown';
import PdfPreview from './PdfPreview.vue';
import DocxPreview from './DocxPreview.vue';
import XlsxPreview from './XlsxPreview.vue';
import PptxPreview from './PptxPreview.vue';
import type { FsPreviewBlobCategory, FsPreviewResult } from '../../../shared/types/ipc';

const store = usePreviewStore();

// ── 读取态（组件本地，store 只管开关三件态）──
const loading = ref(false);
const result: Ref<FsPreviewResult | null> = ref(null);
const currentBlobUrl = ref<string | null>(null);
const allBlobUrls: string[] = [];
// blob 类预览 category：本点由 blob 结果回填，仅供 pill 判定（blob body 渲染 p9 接）。
const categoryRef = ref<FsPreviewBlobCategory | null>(null);

// 并发序号：换文件/快速开关时旧请求晚到不回写（模块级单例递增，setup 外）。
let reqSeq = 0;

async function load(): Promise<void> {
  const seq = ++reqSeq;
  loading.value = true;
  result.value = null;
  categoryRef.value = null;
  // 换文件：旧文件的 text→blob 缓存随内容失效（键不含文件身份），立即 revoke 防泄漏。
  clearTextBlobCache();
  // A4 预检（2026-11-06 file linkify 计划）：入参路径非盘符/UNC/POSIX 根形态（即相对路径）→
  // 本地合成错误卡不发 IPC——主进程无法独立定位相对路径，读取必然错误。相对路径有两个来源
  //（round-002 fix-3 F5 修正原「唯一来源是死链分支」的过宽假设）：markdown.ts link_open
  // 死链分支（未设根，clip 存原始相对路径）+ ToolCallBlock chip 直取 tool_use 入参的相对
  // 路径违约形态（Write/Edit 契约要求绝对路径，模型违约时 root 已设仍可能传入相对路径）。
  // 故文案按根状态分述成因：未设根 → 「未设置工作区根」；已设根 → 相对路径本身无法解析
  //（预览目标需要绝对路径）。同步段无 await，seq===reqSeq 恒成立；守卫写法与下方 IPC 路径
  // 同构，竞态语义不变（不发 IPC、不进 try）。
  if (!isAbsolutePathForm(store.path)) {
    if (seq === reqSeq) {
      result.value = {
        ok: false,
        message: getFileLinkWorkspaceRoot()?.trim()
          ? '无法定位文件：相对路径无法解析（预览目标需要绝对路径）'
          : '无法定位文件：当前会话未设置工作区根，相对路径无法解析',
      };
      loading.value = false;
    }
    return;
  }
  try {
    const res = await window.claudeLink.readFilePreview(store.path);
    if (seq !== reqSeq) return;
    result.value = res;
    if (res.ok && res.kind === 'blob') {
      // p2：blob body 暂不渲染（申报，p9 接渲染分发），仅生成 blobUrl 备用 + 回填 category。
      categoryRef.value = res.category;
      const prev = currentBlobUrl.value;
      const url = URL.createObjectURL(new Blob([base64ToUint8Array(res.base64)], { type: res.mime }));
      currentBlobUrl.value = url;
      allBlobUrls.push(url);
      // 换文件成功后上一轮 blobUrl 不再被引用，立即释放（allBlobUrls 保留记录，close/卸载统一 revoke 全部）。
      if (prev) URL.revokeObjectURL(prev);
    } else if (currentBlobUrl.value) {
      // 换成非 blob 文件成功：上一轮 blobUrl 同样失去引用。
      URL.revokeObjectURL(currentBlobUrl.value);
      currentBlobUrl.value = null;
    }
  } catch {
    if (seq === reqSeq) result.value = { ok: false, message: '读取失败' };
  } finally {
    if (seq === reqSeq) loading.value = false;
  }
}

function revokeAllBlobUrls(): void {
  for (const url of allBlobUrls) URL.revokeObjectURL(url);
  allBlobUrls.length = 0;
  // text→blob 缓存键登记的 URL 已随 allBlobUrls 全量 revoke，仅清表防旧键命中（revoke 幂等）。
  textBlobCache.clear();
  currentBlobUrl.value = null;
}

// 关闭统一入口（遮罩/关闭钮/Esc 共用）：翻 store 开关位 + 统一 revoke 全部 blobUrl。
function close(): void {
  reqSeq++; // 备忘-1：关闭使在途响应序号过期（晚到响应不回写，blob URL 不再滞留）。
  store.close();
  revokeAllBlobUrls();
}

// C-F5：抽屉内 md preview/mmd graph 的文件链接点击委托（与 MessageBubble onContentClick
// 同实现、文件内自含——markdown.ts link_open 产出的 .md-file-link 携 data-clip-path）。
// 非文件链接不拦截，外链照旧。
function onMdLinkClick(e: MouseEvent): void {
  const el = (e.target as HTMLElement | null)?.closest('.md-file-link') as HTMLElement | null;
  if (!el) return;
  const p = el.getAttribute('data-clip-path');
  if (p) useFilePreview().open(p);
}

// ── 头部派生 ──
const baseName = computed(() => store.path.split(/[\\/]/).pop() || store.path);
const modes = computed<PreviewMode[]>(() => previewFormatInfo(extOfPath(store.path), categoryRef.value).modes);

const MODE_LABEL: Record<PreviewMode, string> = {
  preview: '👁 预览',
  source: '‖ 源码',
  web: '🌐 网页',
  code: '‖ 代码',
  graph: '📊 图形',
};

// foot 注记（B10）：html/htm 的 web 模式下追加「脚本已禁用 + 相对资源不保证」提示。
const isWebPreviewMode = computed(() => (currentExt.value === 'html' || currentExt.value === 'htm') && store.mode === 'web');

// ── text 源码视图：hljs 高亮（映射命中且语言可用才高亮；>64KB 纯文本不高亮，B11）──
const HIGHLIGHT_BYTE_LIMIT = 64 * 1024;
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  tsx: 'typescript',
  json: 'json',
  css: 'css',
  xml: 'xml',
  svg: 'xml',
  html: 'xml',
  htm: 'xml',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  sh: 'bash',
  bash: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 属性值替换集与 markdown.ts 同款（& < > " ' 换行）：mmd graph 的 data-mermaid 属性安全。
function escapeAttribute(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '&#10;');
}

const textResult = computed(() => (result.value && result.value.ok && result.value.kind === 'text' ? result.value : null));
const blobResult = computed(() => (result.value && result.value.ok && result.value.kind === 'blob' ? result.value : null));
// B3：0 字节文件（content 为空且未截断）渲染空态卡，不渲染空源码视图（gutter 行号 1 + 空白）。
const isEmptyTextFile = computed(() => textResult.value?.content === '' && textResult.value?.truncated === false);

// ── p9 body 分发表：格式 = extOfPath(path) + result 联判，模式 = store.mode（切模式不重发 IPC）──
const currentExt = computed(() => extOfPath(store.path));
const textKind = computed<'md' | 'html' | 'svg' | 'mmd' | 'plain' | null>(() => {
  if (!textResult.value) return null;
  const ext = currentExt.value;
  if (ext === 'md') return 'md';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'svg') return 'svg';
  if (ext === 'mmd') return 'mmd';
  return 'plain';
});

// md preview：markdown-it rich 全家桶（mermaid fence/katex/任务列表/diff2html 自动生效），
// v-enrich 做前端二次增强（mermaid 懒渲染 + 图片灯箱）；.markdown-body 全局样式复用 main.css。
const mdHtml = computed(() => (textKind.value === 'md' ? renderMarkdown(textResult.value?.content ?? '') : ''));

// mmd graph：与 markdown.ts renderMermaidBlock 同构的占位结构——源码同时进 data-mermaid
// （供管线读取）与可见文本（渲染前/失败回退），复用 v-enrich 的 mermaid 渲染管线
// （懒加载/内容指纹缓存/主题/错误重试全继承）。
const mermaidHtml = computed(() => {
  if (textKind.value !== 'mmd') return '';
  const code = textResult.value?.content ?? '';
  return [
    '<div class="mermaid-block">',
    `<div class="mermaid-block__source" data-mermaid="${escapeAttribute(code)}">`,
    escapeHtml(code),
    '</div>',
    '</div>',
  ].join('');
});

// text→blob（html web 的 iframe / svg preview 的 img）：按 ext:mode 缓存避免重复生成，
// 生成后统一进 allBlobUrls（close/换文件/卸载全量 revoke）。mime：html 用 text/html
// （iframe sandbox="allow-scripts allow-forms" 隔离沙箱运行脚本/表单、不授同源，B9）；
// svg 用 image/svg+xml（img 上下文脚本天然不执行，B25）。
const textBlobCache = new Map<string, string>();
function getTextBlobUrl(): string | null {
  const res = textResult.value;
  if (!res) return null;
  const key = `${currentExt.value}:${store.mode}`;
  const hit = textBlobCache.get(key);
  if (hit) return hit;
  const mime = currentExt.value === 'svg' ? 'image/svg+xml' : 'text/html';
  const url = URL.createObjectURL(new Blob([res.content], { type: mime }));
  textBlobCache.set(key, url);
  allBlobUrls.push(url);
  return url;
}
const frameUrl = computed(() => (textKind.value === 'html' && store.mode === 'web' ? getTextBlobUrl() : null));
const svgImageUrl = computed(() => (textKind.value === 'svg' && store.mode === 'preview' ? getTextBlobUrl() : null));

function clearTextBlobCache(): void {
  for (const url of textBlobCache.values()) URL.revokeObjectURL(url);
  textBlobCache.clear();
}
const textHtml = computed<string>(() => {
  const res = textResult.value;
  if (!res) return '';
  const tooBig = new TextEncoder().encode(res.content).length > HIGHLIGHT_BYTE_LIMIT;
  const lang = EXT_LANG[extOfPath(store.path)];
  if (!tooBig && lang && hljs.getLanguage(lang)) {
    // hljs.highlight 内部转义输入并输出安全 span（原子高亮主题已在 main.ts 全局注册）。
    return hljs.highlight(res.content, { language: lang }).value;
  }
  return escapeHtml(res.content);
});
const gutterText = computed(() => {
  const res = textResult.value;
  if (!res) return '';
  const lines = res.content.split('\n').length;
  return Array.from({ length: lines }, (_, i) => i + 1).join('\n');
});

// ── 底部操作 ──
// 网页端隐藏「外部打开」：web 运行时无法触达桌面主机的 shell（App.vue:43 同款判据）。
const isWebRuntime = typeof window !== 'undefined' && (window as any).__claudeLinkWebBridge === true;
const COPY_STATUS_MS = 2000;
const copyStatus = ref('');
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyPath(): Promise<void> {
  const ok = await copyTextToClipboard(store.path);
  copyStatus.value = ok ? '已复制' : '复制失败';
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { copyStatus.value = ''; }, COPY_STATUS_MS);
}

function openExternal(): void {
  void window.claudeLink.fsOpenPath(store.path, 'default').catch(() => { /* 打开失败不打断预览 */ });
}

// ── Esc 层（A9 同款手法，对齐 ImageLightbox）──
// 打开注册 1040 层，关闭/卸载出栈（release 幂等）。
let escHandle: EscLayerHandle | null = null;

function onKey(e: KeyboardEvent): void {
  if (!store.open) return;
  if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented && escHandle?.isTopmost()) {
    // ImageLightbox 先例：只 preventDefault、不 stopPropagation（ChatPage 让位由 p10 补）。
    e.preventDefault();
    close();
  }
}

watch(() => [store.open, store.path] as const, ([open]) => {
  if (open) {
    escHandle?.release();
    escHandle = pushEscLayer(ESC_LAYER_PRIORITY.filePreviewDrawer);
    void load();
  } else {
    escHandle?.release();
    escHandle = null;
  }
});

onMounted(() => {
  window.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  escHandle?.release();
  escHandle = null;
  if (copyTimer) clearTimeout(copyTimer);
  revokeAllBlobUrls();
});
</script>

<template>
  <Teleport to="body">
    <div class="fpreview-mask" :class="{ open: store.open }" @click="close"></div>
    <aside class="fpreview-drawer" :class="{ open: store.open }" role="dialog" aria-label="文件预览" @click.stop>
      <div class="fpreview-head">
        <div class="fpreview-name">
          <span class="fpreview-name__text">{{ baseName }}</span>
          <small class="fpreview-path">{{ store.path }}</small>
        </div>
        <div v-if="modes.length > 1" class="fpreview-pill">
          <button
            v-for="m in modes"
            :key="m"
            type="button"
            :class="{ active: store.mode === m }"
            @click="store.setMode(m)"
          >{{ MODE_LABEL[m] }}</button>
        </div>
        <button class="fpreview-close" type="button" title="关闭（Esc）" aria-label="关闭文件预览" @click="close">✕</button>
      </div>
      <div class="fpreview-body">
        <div v-if="loading" class="fpreview-loading">加载中…</div>
        <div v-else-if="result && !result.ok" class="fpreview-empty">
          <span class="fpreview-empty__icon">⚠</span>
          <span class="fpreview-empty__text">{{ result.message }}</span>
        </div>
        <div v-else-if="result && result.ok && result.kind === 'missing'" class="fpreview-empty">
          <span class="fpreview-empty__icon">⚠</span>
          <span class="fpreview-empty__text">文件不存在</span>
        </div>
        <!-- p9 text 类分发表：md preview → markdown-it + v-enrich；html web → sandbox iframe（隔离沙箱运行脚本/表单、不授同源，B9）；
             svg preview → img（B25）；mmd graph → mermaid 占位（v-enrich 管线）；
             其余（md/html/svg/mmd 的 source 态、plain 全模式）统一源码视图。 -->
        <template v-else-if="textResult">
          <!-- B3：0 字节文件子条件分流——空态卡优先，不再渲染空源码视图 -->
          <div v-if="isEmptyTextFile" class="fpreview-empty">
            <span class="fpreview-empty__icon">⚠</span>
            <span class="fpreview-empty__text">（空文件）</span>
          </div>
          <template v-else>
            <div v-if="textResult.truncated" class="fpreview-banner">文件过大，仅显示前 256 KB</div>
            <div v-if="textKind === 'md' && store.mode === 'preview'" class="fpreview-md markdown-body" @click="onMdLinkClick" v-html="mdHtml" v-enrich></div>
            <iframe v-else-if="frameUrl" :src="frameUrl" sandbox="allow-scripts allow-forms" title="网页预览" class="fpreview-frame"></iframe>
            <div v-else-if="svgImageUrl" class="fpreview-image-wrap">
              <img :src="svgImageUrl" class="fpreview-image" :alt="baseName">
            </div>
            <div v-else-if="textKind === 'mmd' && store.mode === 'graph'" class="fpreview-md markdown-body" @click="onMdLinkClick" v-html="mermaidHtml" v-enrich></div>
            <div v-else class="fpreview-code">
              <div class="fpreview-gutter">{{ gutterText }}</div>
              <div class="fpreview-src" v-html="textHtml"></div>
            </div>
          </template>
        </template>
        <!-- p9 blob 类分发表：image → img；media 按 mime video/audio；pdf/docx/xlsx/pptx → 四重组件
             （props 契约 { base64, size }，错误态组件内部自理）。 -->
        <template v-else-if="blobResult && currentBlobUrl">
          <div v-if="blobResult.category === 'image'" class="fpreview-image-wrap">
            <img :src="currentBlobUrl" class="fpreview-image" :alt="baseName">
          </div>
          <video v-else-if="blobResult.category === 'media' && blobResult.mime.startsWith('video/')" :src="currentBlobUrl" controls class="fpreview-media"></video>
          <div v-else-if="blobResult.category === 'media'" class="fpreview-media-wrap">
            <audio :src="currentBlobUrl" controls class="fpreview-media-audio"></audio>
          </div>
          <div v-else-if="blobResult.category === 'pdf'" class="fpreview-heavy"><PdfPreview :base64="blobResult.base64" :size="blobResult.size" /></div>
          <div v-else-if="blobResult.category === 'docx'" class="fpreview-heavy"><DocxPreview :base64="blobResult.base64" :size="blobResult.size" /></div>
          <div v-else-if="blobResult.category === 'xlsx'" class="fpreview-heavy"><XlsxPreview :base64="blobResult.base64" :size="blobResult.size" /></div>
          <div v-else-if="blobResult.category === 'pptx'" class="fpreview-heavy"><PptxPreview :base64="blobResult.base64" :size="blobResult.size" /></div>
        </template>
      </div>
      <div class="fpreview-foot">
        <span><kbd>Esc</kbd> 关闭</span><span>·</span><span>内容只读，改动请走会话</span>
        <template v-if="isWebPreviewMode"><span>·</span><span class="fpreview-foot-note">网页预览在隔离沙箱中运行脚本（无法访问应用数据与本机文件）；外部相对资源不保证加载</span></template>
        <span v-if="copyStatus" class="fpreview-copy-status">{{ copyStatus }}</span>
        <div class="fpreview-foot-actions">
          <button v-if="!isWebRuntime" type="button" @click="openExternal">↗ 外部打开</button>
          <button type="button" @click="copyPath">⧉ 复制路径</button>
        </div>
      </div>
    </aside>
  </Teleport>
</template>

<style scoped>
/* ═══ 遮罩：全屏压暗，开时透明度过渡 + 可点（点击空白关闭，抽屉本体 @click.stop 不冒泡）═══ */
.fpreview-mask {
  position: fixed;
  inset: 0;
  z-index: 1040;
  background: color-mix(in srgb, var(--color-text) 18%, transparent);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--duration-base) var(--ease-out);
}
.fpreview-mask.open {
  opacity: 1;
  pointer-events: auto;
}

/* ═══ 抽屉：右侧浮动卡片（elevation-3），closed 态滑出视口右侧留 32px 缓冲 ═══ */
.fpreview-drawer {
  position: fixed;
  top: 42px;
  right: 24px;
  bottom: 24px;
  width: min(560px, 46vw);
  z-index: 1041;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--elevation-3);
  transform: translateX(calc(100% + 32px));
  transition: transform 280ms var(--ease-out);
}
.fpreview-drawer.open {
  transform: translateX(0);
}

@media (prefers-reduced-motion: reduce) {
  .fpreview-drawer,
  .fpreview-mask {
    transition-duration: 1ms;
  }
}

/* ═══ 头部：左文件名/路径 + 中 pill 模式切换（绝对居中）+ 右关闭钮 ═══ */
.fpreview-head {
  position: relative;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-panel-soft);
}
.fpreview-name {
  max-width: 40%;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fpreview-name__text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fpreview-path {
  display: block;
  font-weight: 400;
  font-size: 0.62rem;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fpreview-pill {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
}
.fpreview-pill button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 0;
  background: transparent;
  padding: 5px 16px;
  border-radius: var(--radius-pill);
  font-size: 0.75rem;
  font-family: inherit;
  color: var(--color-text-muted);
  cursor: pointer;
}
.fpreview-pill button.active {
  background: var(--color-panel-soft);
  color: var(--color-text);
  font-weight: 600;
  box-shadow: var(--elevation-1);
}
.fpreview-close {
  margin-left: auto;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
.fpreview-close:hover {
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
  color: var(--color-text);
}

/* ═══ body 四态 ═══ */
.fpreview-body {
  flex: 1;
  overflow-y: auto;
}
.fpreview-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
}
.fpreview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  padding: 24px;
  text-align: center;
}
.fpreview-empty__icon { font-size: 1.5rem; }
.fpreview-banner {
  flex-shrink: 0;
  padding: 6px 16px;
  font-size: 0.68rem;
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
  border-bottom: 1px solid var(--color-border);
}

/* 源码视图：gutter 行号 + pre 源码（同 mono/字号/行高保证对齐） */
.fpreview-code {
  display: flex;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.65;
  padding: 12px 0;
}
.fpreview-gutter {
  flex-shrink: 0;
  text-align: right;
  padding: 0 12px;
  color: color-mix(in srgb, var(--color-text-muted) 70%, transparent);
  user-select: none;
  border-right: 1px solid var(--color-border);
  white-space: pre;
}
.fpreview-src {
  padding: 0 16px;
  white-space: pre;
  overflow-x: auto;
  flex: 1;
  min-width: 0;
}

/* ═══ p9 分发表新增分支 ═══ */
/* md / mmd graph：markdown-body（main.css 全局排版）+ 容器自身留白 */
.fpreview-md {
  padding: 16px;
}
/* html web：sandbox iframe 占满 body（隔离沙箱运行脚本/表单、不授同源，B9），衬底页面自身内容 */
.fpreview-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: var(--color-panel);
}
/* 图片（blob image / svg preview）：contain + 居中 + 衬底 */
.fpreview-image-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  overflow: hidden;
  background: var(--color-panel);
}
.fpreview-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
/* media：video 占满 body；audio 居中 + 上下留白 */
.fpreview-media {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: var(--color-panel);
}
.fpreview-media-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  background: var(--color-panel);
}
.fpreview-media-audio {
  display: block;
  width: calc(100% - 48px);
  margin: 24px 0;
}
/* pdf/docx/xlsx/pptx：重组件 flex 撑满 body 高度（组件根自带 height:100%） */
.fpreview-heavy {
  height: 100%;
}

/* ═══ 底部：Esc 提示 + 复制状态闪现 + 右侧操作钮 ═══ */
.fpreview-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding: 8px 16px;
  border-top: 1px solid var(--color-border);
  font-size: 0.68rem;
  color: var(--color-text-muted);
  background: var(--color-panel-soft);
}
.fpreview-foot kbd {
  font-family: var(--font-mono);
  background: color-mix(in srgb, var(--color-text) 7%, transparent);
  border-radius: var(--radius-xs);
  padding: 1px 6px;
  font-size: 0.62rem;
}
.fpreview-copy-status { color: var(--color-text); }
/* B10：html/htm web 模式的安全注记（灰色小字沿用 foot 字号，显式 muted token） */
.fpreview-foot-note { color: var(--color-text-muted); }
.fpreview-foot-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.fpreview-foot-actions button {
  border: 1px solid var(--color-border);
  background: transparent;
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  font-size: 0.68rem;
  font-family: inherit;
  color: var(--color-text);
  cursor: pointer;
}
.fpreview-foot-actions button:hover {
  background: var(--color-panel);
}

/* C-F5：md preview/mmd graph 内文件链接按钮化样式（与 MessageBubble .bubble__content 两组同款）；
   v-html 内容须 :deep 穿透，点状下划线标示「可点开预览」，hover 切实线给明确可点反馈。 */
.fpreview-md :deep(.md-file-link) {
  color: var(--color-accent-strong);
  font-weight: 500;
  cursor: pointer;
  text-decoration: underline dotted;
  text-decoration-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
  text-underline-offset: 4px;
}
.fpreview-md :deep(.md-file-link:hover) {
  text-decoration-style: solid;
  color: var(--color-accent);
}

/* B13：窄窗（<900px）抽屉近似全宽——right:24px 保留，left:24px + width:auto → 占 100vw-48px。 */
@media (max-width: 900px) {
  .fpreview-drawer {
    left: 24px;
    width: auto;
  }
}
</style>
