<!-- PdfPreview.vue（2026-11-04 计划 round-001 p5；R1 改用 legacy 构建）
     抽屉 body 的 PDF 分页渲染卡（pdfjs-dist@6）：单页 canvas 按容器宽度自适应缩放（dpr 保留清晰度），
     底部『上一页 / 第 N 页 / 共 M 页 / 下一页 + 页码跳转』控件条；loadToken 管文档加载代际、
     renderSeq 管页渲染代际（快速翻页旧链作废，防同 canvas 双 render() 并发被误判损坏，p2），
     render 前 cancel 上一次 RenderTask，重载/卸载时 destroy 文档。错误态：PasswordException →
     「加密文件不支持预览」（B23），其余 → 「文件损坏或格式异常」（B22），均提示可走抽屉「外部打开」。
     R1：用 legacy 构建——Electron 35（Chromium 134）无 Uint8Array.prototype.toHex，现代构建
     worker fingerprints 路径裸调之必抛（p11 T4 CDP 冒烟三跑复现），legacy 自带 core-js polyfill。
     真实 PDF 渲染的视觉验证归 p11 CDP 冒烟，本点以 typecheck + 结构钉为门。 -->
<script lang="ts">
// 模块级（<script setup> 体每实例执行，worker 设置必须放在这）：pdfjs 动态加载一次并
// 记忆化 promise——workerSrc 仅在首次加载时赋值，后续实例复用同一 promise 不再重复赋值。
// R1：legacy 构建（自带 toHex 等 polyfill），类型由同目录 pdf.d.mts 提供。
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfjsModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { base64ToUint8Array } from '../../utils/preview-format';

const props = defineProps<{ base64: string; size: number }>();

// ── 视图态 ──
const loading = ref(false);
const errorMsg = ref(''); // '' = 无错误；非空渲染空态卡（B23 加密 / B22 损坏）
const numPages = ref(0);
const current = ref(1);
const pageInput = ref('1');
const maxPage = computed(() => Math.max(numPages.value, 1));

const hostRef = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);

// ── pdfjs 非响应式句柄（不进 ref，避免代理开销）──
let pdfDoc: PDFDocumentProxy | null = null;
// v6 销毁入口在 loading task（PDFDocumentProxy 已无 destroy，仅 cleanup）：
// 重载/卸载统一 task.destroy()（中断加载 + 销毁 worker + 文档）。
let loadingTask: PDFDocumentLoadingTask | null = null;
let pdfRenderTask: RenderTask | null = null;
let loadToken = 0; // 竞态 token：换文件/快速重载时旧异步链各 await 后比对丢弃（管文档加载代际）
let renderSeq = 0; // 渲染代际：每次发起页面渲染自增（管页渲染代际，与 loadToken 各司其职）——
                   // 快速翻页多链在 await doc.getPage 窗口内交错时，非最新链一律作废，
                   // 保证同一 canvas 任意时刻至多一个 render()（pdfjs #canvasInUse 对并发
                   // render() 抛普通 Error，会被 catch 误判「文件损坏或格式异常」）
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
let resizeObserver: ResizeObserver | null = null;

// v6 transferable 语义：getDocument 会接管传入 TypedArray（可 transfer detach）。
// base64ToUint8Array 每次调用都从 props.base64 新建独立 buffer，天然是副本、无共享引用，
// 重试路径（同一 base64 再次 load）不会受 detach 影响，无需额外 slice。
function cancelRender(): void {
  // v6 RenderTask.cancel(): void（同步），取消后旧 promise 以 RenderingCancelledException reject。
  if (pdfRenderTask) {
    pdfRenderTask.cancel();
    pdfRenderTask = null;
  }
}

async function destroyDoc(): Promise<void> {
  const task = loadingTask;
  loadingTask = null;
  pdfDoc = null;
  if (task) await task.destroy().catch(() => { /* 旧文档销毁失败不影响新加载 */ });
}

async function load(): Promise<void> {
  const token = ++loadToken;
  loading.value = true;
  errorMsg.value = '';
  numPages.value = 0;
  current.value = 1;
  pageInput.value = '1';
  cancelRender();
  void destroyDoc();
  if (!props.base64) {
    // 防御：宿主（抽屉/p9 分发表）只应传合法 blob；空载荷按损坏态收口，不留无限 spinner。
    loading.value = false;
    errorMsg.value = '文件损坏或格式异常';
    return;
  }
  try {
    const pdfjs = await loadPdfjs();
    if (token !== loadToken) return;
    const task = pdfjs.getDocument({ data: base64ToUint8Array(props.base64) });
    const doc = await task.promise;
    if (token !== loadToken) {
      void task.destroy().catch(() => { /* 迟到文档直接销毁 */ });
      return;
    }
    loadingTask = task;
    pdfDoc = doc;
    numPages.value = doc.numPages;
    await renderPage();
  } catch (err) {
    if (token !== loadToken) return;
    errorMsg.value = (err as { name?: string } | null)?.name === 'PasswordException'
      ? '加密文件不支持预览'
      : '文件损坏或格式异常';
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

// 页渲染统一入口（首渲染/翻页/resize 重渲染都经此）：进入即自增 renderSeq 并快照（同步、
// 先于任何 await，即「发起渲染的入口处」），await doc.getPage 之后与 render() 完成后各比对
// 一次——被更新翻页/加载作废的旧链直接丢弃，绝不启动第二个 render()。渲染启动前 cancel
// 上一次 RenderTask（cancel() 同步；旧 promise 以 RenderingCancelledException reject）。
// loadToken 文档代际仍并行校验：换文件/卸载销毁文档时，旧链 getPage reject 或比对不符一律静默，
// 与既有 load()/onBeforeUnmount 失效链协同，不破坏原卸载路径。
async function renderPage(): Promise<void> {
  const seq = ++renderSeq;
  const ltoken = loadToken;
  const doc = pdfDoc;
  const canvas = canvasRef.value;
  const host = hostRef.value;
  if (!doc || !canvas || !host || !numPages.value) return;
  cancelRender();
  try {
    const page = await doc.getPage(current.value);
    if (seq !== renderSeq || ltoken !== loadToken) return; // 已有更新的翻页/加载，本链作废（不渲染）
    const vp1 = page.getViewport({ scale: 1 });
    // availW 按 host 内容盒宽计算：clientWidth 含两侧 padding（.pdf-preview__view 左右各
    // 12px），不扣除则 canvas CSS 全宽恒溢出内容盒 → 横向滚动条常驻。padding 用
    // getComputedStyle 实测求和（防与 CSS 改值失同步）；扣减后 ≤0（极窄 / 隐藏时
    // clientWidth=0，NaN 因守卫 `> 0` 不成立同样落回落）沿用既有回落分支取 vp1.width。
    const padStyle = window.getComputedStyle(host);
    const contentW = host.clientWidth - (parseFloat(padStyle.paddingLeft) + parseFloat(padStyle.paddingRight));
    const availW = contentW > 0 ? contentW : vp1.width;
    const scale = Math.max(0.1, availW / vp1.width);
    const dpr = window.devicePixelRatio || 1;
    // 位图按 scale*dpr 出（清晰度），CSS 尺寸按 scale 摆（布局）。
    const vp = page.getViewport({ scale: scale * dpr });
    canvas.width = Math.floor(vp1.width * scale * dpr);
    canvas.height = Math.floor(vp1.height * scale * dpr);
    canvas.style.width = Math.floor(vp1.width * scale) + 'px';
    canvas.style.height = Math.floor(vp1.height * scale) + 'px';
    // v6 RenderParameters：推荐 { canvas, viewport }（canvasContext 仅向后兼容）。
    const task = page.render({ canvas, viewport: vp });
    pdfRenderTask = task;
    await task.promise;
    if (seq !== renderSeq || ltoken !== loadToken) return;
    // 仅当前链成功出帧才清上一页遗留的错误卡（不在入口清，防错误卡闪烁）：
    // 否则真实渲染错误后翻页成功画出新页，错误卡却驻留且 canvas 仍被 v-show 隐藏（A-P3-1）。
    errorMsg.value = '';
  } catch (err) {
    // 取消（RenderingCancelledException）与被作废旧链一律静默——绝不落入损坏错误卡；
    // 只有「当前渲染代 + 当前文档」上的真实解析错误才报「文件损坏或格式异常」。
    if ((err as { name?: string } | null)?.name === 'RenderingCancelledException') return;
    if (seq !== renderSeq || ltoken !== loadToken) return;
    errorMsg.value = '文件损坏或格式异常';
  }
}

async function jumpTo(n: number): Promise<void> {
  const target = Math.min(maxPage.value, Math.max(1, Math.round(n)));
  current.value = target;
  pageInput.value = String(target);
  await renderPage(); // renderPage 进入即自增 renderSeq：连续快点时旧翻页链自动作废
}

function prevPage(): void {
  if (current.value > 1) void jumpTo(current.value - 1);
}
function nextPage(): void {
  if (current.value < numPages.value) void jumpTo(current.value + 1);
}

// 页码 input 回车/失焦：空/非数回退当前页，数值 clamp 到 [1, numPages]。
// 不用 v-model（Vue 对 type=number 自动 looseToNumber 会把 ref 变 number），
// 用 :value + 手动 @input 保持恒为 string。
function onInput(e: Event): void {
  pageInput.value = (e.target as HTMLInputElement).value;
}
function commitInput(): void {
  const raw = pageInput.value.trim();
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n)) {
    pageInput.value = String(current.value);
    return;
  }
  void jumpTo(n);
}

// 抽屉宽度变化（拖拽/窗口 resize）后重渲染当前页，防模糊/溢出；120ms 去抖。
function scheduleRerender(): void {
  if (!pdfDoc || loading.value || errorMsg.value || !numPages.value) return;
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    void renderPage();
  }, 120);
}

watch(() => props.base64, () => { void load(); }, { immediate: true });

onMounted(() => {
  const host = hostRef.value;
  if (host && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(scheduleRerender);
    resizeObserver.observe(host);
  }
});

onBeforeUnmount(() => {
  loadToken++; // 失效在途异步链（与 Docx/Xlsx/Pptx 三兄弟组件同法）：加载中卸载时，迟到
               // task.promise 在 load() 内比对令牌不符 → 走 task.destroy() 分支，销毁
               // pdfjs 文档 + 专属 worker，不悬挂等 GC（单份可达 24MB）。
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  cancelRender();
  void destroyDoc();
});
</script>

<template>
  <div class="pdf-preview">
    <div ref="hostRef" class="pdf-preview__view">
      <div v-if="loading" class="pdf-preview__state">加载中…</div>
      <div v-else-if="errorMsg" class="pdf-preview__state pdf-preview__state--empty">
        <span class="pdf-preview__state-icon">⚠</span>
        <span class="pdf-preview__state-text">{{ errorMsg }}</span>
        <span class="pdf-preview__state-hint">可用抽屉底部「外部打开」</span>
      </div>
      <canvas v-show="!loading && !errorMsg" ref="canvasRef" class="pdf-preview__canvas"></canvas>
    </div>
    <div class="pdf-preview__bar">
      <button type="button" :disabled="current <= 1" @click="prevPage">上一页</button>
      <span class="pdf-preview__pageno">第 {{ current }} 页 / 共 {{ numPages }} 页</span>
      <button type="button" :disabled="current >= numPages" @click="nextPage">下一页</button>
      <input
        :value="pageInput"
        class="pdf-preview__input"
        type="number"
        min="1"
        :max="maxPage"
        aria-label="页码，输入后回车跳转"
        title="输入页码后回车/失焦跳转"
        @input="onInput"
        @keydown.enter="commitInput"
        @blur="commitInput"
      />
    </div>
  </div>
</template>

<style scoped>
/* ═══ 根：flex column，canvas 区自适应 + 控件条固定 ═══ */
.pdf-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* canvas 区：纵向可滚（长页出滚动条），页面小时双向居中（margin:auto） */
.pdf-preview__view {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  padding: 12px;
}
.pdf-preview__canvas {
  display: block;
  margin: auto;
}

/* 空态卡：对齐 FilePreviewDrawer .fpreview-empty（居中 ⚠ + 文字，token 化） */
.pdf-preview__state {
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  text-align: center;
}
.pdf-preview__state-icon { font-size: 1.5rem; }
.pdf-preview__state-hint { font-size: 0.68rem; }

/* ═══ 控件条：对齐 .fpreview-foot 风格（token 化，禁硬编码色值） ═══ */
.pdf-preview__bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-shrink: 0;
  padding: 8px 16px;
  border-top: 1px solid var(--color-border);
  background: var(--color-panel-soft);
  font-size: 0.68rem;
  color: var(--color-text-muted);
}
.pdf-preview__bar button {
  border: 1px solid var(--color-border);
  background: transparent;
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  font-size: 0.68rem;
  font-family: inherit;
  color: var(--color-text);
  cursor: pointer;
}
.pdf-preview__bar button:hover:not(:disabled) {
  background: var(--color-panel);
}
.pdf-preview__bar button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.pdf-preview__pageno {
  font-family: var(--font-mono);
  white-space: nowrap;
}
.pdf-preview__input {
  width: 56px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: 0.68rem;
  padding: 3px 6px;
  text-align: center;
}
.pdf-preview__input:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--color-text) 35%, transparent);
}
</style>
