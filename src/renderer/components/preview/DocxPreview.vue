<!-- DocxPreview.vue（2026-11-04 计划 round-001 p6；同日 p3 媒体 blob URL 泄漏修复）
     抽屉 body 的 docx 渲染卡（docx-preview@0.4）：renderAsync 把 OOXML 渲染为
     .docx-wrapper 文档节 DOM（内嵌图片/页眉页脚等库自带处理，B21），动态 import 防主包膨胀。
     内嵌媒体 URL 走 useBase64URL data URL（p3：库默认 createObjectURL 无任何 revoke
     途径，逐次渲染累积泄漏；核实证据见调用处注释），动态 import 防主包膨胀。
     d.ts/源码已核（node_modules/docx-preview/dist）：renderAsync(data, bodyContainer,
     styleContainer?, userOptions?)，data 走 JSZip.loadAsync（Uint8Array 可用）；库注入的
     <style> 默认落 bodyContainer（styleContainer 缺省 = bodyContainer），不是 document.head。
     loadToken 递增竞态守卫：docx-preview 无 cancel API，故每次 load 渲染进独立离屏容器，
     仅 token 仍当前时才替换正式容器——迟到 resolve 的过期链只丢弃自己的 DOM，绝不回写。
     错误态：损坏/伪扩展/加密 docx 统一落「文件损坏或格式异常」（B22），提示可走抽屉
     「外部打开」。真实 docx 渲染的视觉验证归 p11 CDP 冒烟，本点以 typecheck + 结构钉为门。 -->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { base64ToUint8Array } from '../../utils/preview-format';

const props = defineProps<{ base64: string; size: number }>();

// ── 视图态 ──
const loading = ref(false);
const errorMsg = ref(''); // '' = 无错误；非空渲染空态卡（B22 损坏/伪扩展/加密统一落点）

const containerRef = ref<HTMLDivElement | null>(null);

let loadToken = 0; // 竞态 token：换文件/快速重载时旧异步链各 await 后比对丢弃

async function load(): Promise<void> {
  const token = ++loadToken;
  loading.value = true;
  errorMsg.value = '';
  if (containerRef.value) containerRef.value.innerHTML = '';
  if (!props.base64) {
    // 防御：宿主（抽屉/p9 分发表）只应传合法 blob；空载荷按损坏态收口，不留无限 spinner。
    loading.value = false;
    errorMsg.value = '文件损坏或格式异常';
    return;
  }
  try {
    const { renderAsync } = await import('docx-preview');
    if (token !== loadToken) return;
    const binary = base64ToUint8Array(props.base64);
    // 渲染进本次独立的离屏容器：renderAsync 无取消手段，若直接渲染进正式容器，
    // 过期链迟到 resolve 时会整体覆盖/清空当前文档（token 检查拦不住已发生的 DOM 写）。
    // 离屏成功且 token 仍当前，才原子地换入正式容器；过期链的离屏容器直接丢弃。
    const scratch = document.createElement('div');
    // options 显式传 inWrapper:true（保留 .docx-wrapper 文档节 wrapper 便于样式圈定）
    // 与 useBase64URL:true（round-001 p3 媒体泄漏修复）。核实证据（当前安装
    // docx-preview@0.4.1，node_modules/docx-preview/dist/）：
    //   - docx-preview.mjs:1225-1228 blobToURL：useBase64URL 为真走 blobToBase64（data URL），
    //     否则 URL.createObjectURL(blob)；mjs:3979 defaultOptions useBase64URL:false；
    //     dist 全文 grep revokeObjectURL 零命中——库对 blob URL 无任何释放途径。
    //   - 后果：默认态每次渲染（含 token 过期被丢弃的 scratch 离屏链）的全部内嵌媒体
    //     blob URL 都随 DOM 一起失去引用却仍驻留 blob 注册表，页面存活期累积泄漏。
    //   - data URL 随 DOM 节点由 GC 一并回收，生命周期与容器绑定，故选主选修法；
    //     其余选项走库默认（defaultOptions 已核：breakPages/renderHeaders 等均为 true）。
    await renderAsync(binary, scratch, undefined, { inWrapper: true, useBase64URL: true });
    if (token !== loadToken) return; // 过期链：scratch 随 GC 丢弃，不触碰正式容器
    const container = containerRef.value;
    if (!container) return; // 已卸载：不写 DOM
    container.innerHTML = '';
    container.appendChild(scratch);
  } catch {
    // docx-preview 对损坏/伪扩展/加密 zip 统一 throw（JSZip 解析失败或缺 document.xml）。
    if (token !== loadToken) return;
    errorMsg.value = '文件损坏或格式异常';
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

watch(() => props.base64, () => { void load(); }, { immediate: true });

onBeforeUnmount(() => {
  loadToken++; // 失效在途异步链（迟到 resolve 不再写任何 DOM/状态）
  if (containerRef.value) containerRef.value.innerHTML = '';
});
</script>

<template>
  <div class="docx-preview-host">
    <div v-if="loading" class="docx-preview__state">加载中…</div>
    <div v-else-if="errorMsg" class="docx-preview__state docx-preview__state--empty">
      <span class="docx-preview__state-icon">⚠</span>
      <span class="docx-preview__state-text">{{ errorMsg }}</span>
      <span class="docx-preview__state-hint">可用抽屉底部「外部打开」</span>
    </div>
    <!-- 渲染容器：docx-preview 输出落点（.docx-wrapper + 库注入的 <style>，均在本容器内） -->
    <div v-show="!loading && !errorMsg" ref="containerRef" class="docx-preview__body"></div>
  </div>
</template>

<style scoped>
/* ═══ 宿主：抽屉 body 滚动区（token 化，禁硬编码色值） ═══ */
.docx-preview-host {
  height: 100%;
  overflow: auto;
  background: var(--color-panel-soft);
  padding: 16px;
}

/* 内层渲染容器：放行 .docx-wrapper（库注入纸张样式，section.docx 白底黑字为预期观感） */
.docx-preview__body {
  max-width: 100%;
}

/* 空态卡：对齐 PdfPreview .pdf-preview__state（居中 ⚠ + 文字，token 化）；
   宿主为块级滚动容器，用 min-height:100% 自撑满视口实现纵向居中 */
.docx-preview__state {
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
.docx-preview__state-icon { font-size: 1.5rem; }
.docx-preview__state-hint { font-size: 0.68rem; }
</style>
