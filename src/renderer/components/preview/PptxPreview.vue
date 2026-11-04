<!-- PptxPreview.vue（2026-11-04 计划 round-001 p8）
     抽屉 body 的 pptx 渲染卡（@aiden0z/pptx-renderer@1.4，Apache-2.0）：OOXML → HTML/SVG DOM
     幻灯片列表（形状/文本/图片/表格/图表/SmartArt，库自带内联样式，无外部 CSS 注入），动态
     import 防主包膨胀。dist/types 已实核：PreviewInput = ArrayBuffer|Uint8Array|Blob（本组件传
     base64ToUint8Array 产物）；幻灯片渲染不经 pdfjs——pdfjs 仅 EMF-PDF 回退可选项（per-open
     pdfjs 配置，非全局 GlobalWorkerOptions），宿主无需设 workerSrc，不配置时库内 best-effort
     自动解析并优雅降级；echarts 为库自身 dependency 随异步 chunk 加载，库内部自管。
     取消手段已实核存在（非 DocxPreview 的无-cancel 情形）：viewer.open 支持 signal（dist 内
     aborted 检查点遍布 parse/build/render 链）+ destroy()（blob URLs/observers/DOM 全清）+
     同 viewer 重入 open 时内建 supersede（过期批次停止追加 DOM）。故竞态采用「单实例复用 +
     loadToken + AbortSignal」：换文件先 abort 旧链再重入 open（库自清旧状态），卸载 destroy。
     错误态：损坏/伪扩展/加密 pptx 统一落「文件损坏或格式异常」（B22），提示可走抽屉
     「外部打开」。真实 pptx 渲染的视觉验证归 p11 CDP 冒烟，本点以 typecheck + 结构钉为门。 -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { PptxViewer } from '@aiden0z/pptx-renderer';
import { base64ToUint8Array } from '../../utils/preview-format';

const props = defineProps<{ base64: string; size: number }>();

// ── 视图态 ──
const loading = ref(false);
const errorMsg = ref(''); // '' = 无错误；非空渲染空态卡（B22 损坏/伪扩展/加密统一落点）

const viewRef = ref<HTMLDivElement | null>(null); // 滚动区：windowed list 的 IntersectionObserver root
const containerRef = ref<HTMLDivElement | null>(null); // 库渲染落点

// ── 非响应式句柄 ──
let loadToken = 0; // 竞态 token：换文件/快速重载时旧异步链各 await 后比对丢弃
let viewer: PptxViewer | null = null; // 单实例复用（重入 open 库内自清旧状态 + supersede）
let abortCtl: AbortController | null = null; // 每次重入新建；换文件/卸载时 abort 旧链

// 库动态加载一次并记忆化 promise（对齐 PdfPreview 的 loadPdfjs 模式），防主包膨胀。
type PptxModule = typeof import('@aiden0z/pptx-renderer');
let modPromise: Promise<PptxModule> | null = null;
function loadLib(): Promise<PptxModule> {
  if (!modPromise) modPromise = import('@aiden0z/pptx-renderer');
  return modPromise;
}

async function load(): Promise<void> {
  const token = ++loadToken;
  loading.value = true;
  errorMsg.value = '';
  if (!props.base64) {
    // 防御：宿主（抽屉/p9 分发表）只应传合法 blob；空载荷按损坏态收口，不留无限 spinner。
    loading.value = false;
    errorMsg.value = '文件损坏或格式异常';
    return;
  }
  try {
    // immediate 首跑发生在 setup 期（containerRef 未就绪）：等挂载完成再取容器。
    await nextTick();
    if (token !== loadToken) return;
    const container = containerRef.value;
    const view = viewRef.value;
    if (!container) return; // 未挂载（宿主契约外情形）：loading 在 finally 复位，空白收口
    const { PptxViewer: Viewer, RECOMMENDED_ZIP_LIMITS } = await loadLib();
    if (token !== loadToken) return;
    if (!viewer) {
      // 构造期定死的能力项：RECOMMENDED_ZIP_LIMITS 为不可信输入的 ZIP 解析资源上限；
      // fitMode contain 自适应容器宽度（viewer 自带 ResizeObserver 随抽屉拖宽重适配）。
      // 实例 open 的 options 无 zipLimits（dist/types 已核），只能在构造期传。
      viewer = new Viewer(container, {
        fitMode: 'contain',
        scrollContainer: view ?? undefined,
        zipLimits: RECOMMENDED_ZIP_LIMITS,
      });
    }
    abortCtl?.abort(); // 旧 open 链在下一个 aborted 检查点抛 AbortError（其 token 已失配，静默）
    abortCtl = new AbortController();
    // 重入 open：库先清理上一次的渲染状态再渲染新文件（README: cleans up previous state on
    // re-open）；lazySlides/lazyMedia + windowed list 为 README 推荐的交互查看器档位。
    await viewer.open(base64ToUint8Array(props.base64), {
      renderMode: 'list',
      signal: abortCtl.signal,
      lazySlides: true,
      lazyMedia: true,
      listOptions: { windowed: true, batchSize: 8, initialSlides: 4 },
    });
    if (token !== loadToken) return;
  } catch {
    // 损坏/伪扩展/加密 pptx：zip 解析或模型构建 throw；AbortError 属竞态主动取消且
    // token 已失配，被上行检查拦截不落错误态。
    if (token !== loadToken) return;
    errorMsg.value = '文件损坏或格式异常';
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

watch(() => props.base64, () => { void load(); }, { immediate: true });

onBeforeUnmount(() => {
  loadToken++; // 失效在途异步链（迟到 resolve 不再写任何 DOM/状态）
  abortCtl?.abort();
  abortCtl = null;
  viewer?.destroy(); // blob URLs、IntersectionObserver/ResizeObserver、container DOM 全清
  viewer = null;
  if (containerRef.value) containerRef.value.innerHTML = '';
});
</script>

<template>
  <div class="pptx-preview">
    <div ref="viewRef" class="pptx-preview__view">
      <div v-if="loading" class="pptx-preview__state">加载中…</div>
      <div v-else-if="errorMsg" class="pptx-preview__state pptx-preview__state--empty">
        <span class="pptx-preview__state-icon">⚠</span>
        <span class="pptx-preview__state-text">{{ errorMsg }}</span>
        <span class="pptx-preview__state-hint">可用抽屉底部「外部打开」</span>
      </div>
      <!-- 渲染容器：库输出为自包含内联样式 DOM（无外部 CSS 注入），幻灯片内部样式属库行为 -->
      <div v-show="!loading && !errorMsg" ref="containerRef" class="pptx-preview__body"></div>
    </div>
  </div>
</template>

<style scoped>
/* ═══ 根：flex column，滚动区自适应 ═══ */
.pptx-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* 滚动区：幻灯片纵向列表滚动（token 化，禁硬编码色值） */
.pptx-preview__view {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
  background: var(--color-panel-soft);
}

/* 内层渲染容器：放行库渲染的幻灯片列表结构（fitMode contain 自适应宽度） */
.pptx-preview__body {
  max-width: 100%;
}

/* 空态卡：对齐 PdfPreview .pdf-preview__state / DocxPreview .docx-preview__state（居中 ⚠ + 文字）；
   宿主为块级滚动容器，用 min-height:100% 自撑满视口实现纵向居中 */
.pptx-preview__state {
  min-height: 100%;
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
.pptx-preview__state-icon { font-size: 1.5rem; }
.pptx-preview__state-hint { font-size: 0.68rem; }
</style>
