import type { Directive } from 'vue';
import { openImageLightbox } from '../composables/useImageLightbox';

/**
 * v-enrich：挂在 v-html 的 .markdown-body 容器上，对解析后插入的"需前端二次渲染"
 * 内容做增强。当前负责：
 *  - mermaid：renderMarkdown 把 ```mermaid 产成 .mermaid-block 占位（携带源码 data-mermaid），
 *    这里懒加载 mermaid 运行时（动态 import，code-splitting 出首屏包），渲染成 SVG。
 *  - 图片灯箱：点击 img.md-img 弹出原图模态（事件委托到容器，卸载时解绑）。
 *
 * 这些是 DOM 依赖的客户端增强，无法由 tsx 契约覆盖（契约只验 renderMarkdown 的 HTML 输出），
 * 视觉/交互正确性靠真实 Electron 目视。
 */

type MermaidApi = typeof import('mermaid')['default'];

let mermaidPromise: Promise<MermaidApi> | null = null;

type MermaidJob = { raw: string; promise: Promise<void> };
const mermaidJobs = new WeakMap<HTMLElement, MermaidJob>();

type MermaidState = 'loading' | 'rendered' | 'error' | string | undefined;
const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_MERMAID_TITLE = 'Mermaid 图表';

export function shouldSkipMermaidErrorRetry(state: MermaidState, previousRaw: string | undefined, raw: string): boolean {
  return state === 'error' && previousRaw === raw;
}

export function summarizeMermaidAccessibleTitle(raw: string, maxLength = 120): string {
  const summary = raw.trim().replace(/\s+/g, ' ');
  if (!summary) return DEFAULT_MERMAID_TITLE;
  const codePoints = Array.from(summary);
  if (codePoints.length <= maxLength) return summary;
  return `${codePoints.slice(0, Math.max(0, maxLength - 1)).join('')}…`;
}

function addMermaidSvgAccessibility(block: HTMLElement, raw: string): void {
  const svg = block.querySelector<SVGSVGElement>('svg');
  if (!svg) throw new Error('Mermaid render did not return an SVG');
  let title = svg.querySelector<SVGTitleElement>(':scope > title');
  if (!title) {
    title = document.createElementNS(SVG_NS, 'title');
    svg.insertBefore(title, svg.firstChild);
  }
  const titleId = `mermaid-svg-title-${renderCounter}`;
  title.id = titleId;
  title.textContent = summarizeMermaidAccessibleTitle(raw);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-labelledby', titleId);
}

function ensureMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then((mod) => {
        const api = mod.default;
        // securityLevel:'strict' 禁用 HTML 标签注入，Electron 沙箱下更安全。
        api.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
        return api;
      })
      .catch((error) => {
        // chunk 加载失败不能缓存 rejected Promise，否则整个 renderer 生命周期都无法重试。
        mermaidPromise = null;
        throw error;
      });
  }
  return mermaidPromise;
}

// renderCounter 的生命周期贯穿 renderer，单调递增保证异步/并行旧任务的 SVG ID 永不复用；故意不在容器卸载时重置。
let renderCounter = 0;

function currentMermaidSource(block: HTMLElement): string {
  return block.querySelector<HTMLElement>('.mermaid-block__source')?.getAttribute('data-mermaid') ?? '';
}

function isCurrentMermaidJob(root: HTMLElement, block: HTMLElement, job: MermaidJob): boolean {
  return root.isConnected
    && block.isConnected
    && root.contains(block)
    && mermaidJobs.get(block) === job
    && currentMermaidSource(block) === job.raw;
}

async function renderOneMermaidBlock(root: HTMLElement, block: HTMLElement, raw: string): Promise<void> {
  if (!raw.trim()) return;
  const previousRaw = block.getAttribute('data-mermaid-error-source');
  if (block.dataset.mermaidState === 'rendered' && block.getAttribute('data-mermaid-source') === raw) return;
  if (block.dataset.mermaidState === 'loading' && block.getAttribute('data-mermaid-source') === raw) return;
  if (block.dataset.mermaidState === 'error' && shouldSkipMermaidErrorRetry(block.dataset.mermaidState, previousRaw ?? undefined, raw)) return;
  if (block.dataset.mermaidState === 'loading') mermaidJobs.delete(block);
  // 错误态对相同源码不重试是有意为之：语法错误重渲染必失败，避免每次 mounted/updated 重跑 parse。
  // ensureMermaid 的 mermaidPromise=null 仅服务 chunk 首次加载失败后的重试（对未进入 error 态、或源码已变的块生效）。

  block.dataset.mermaidState = 'loading';
  block.setAttribute('data-mermaid-state', 'loading');
  block.dataset.mermaidSource = raw;
  block.setAttribute('data-mermaid-source', raw);
  const job = {} as MermaidJob;
  const promise = (async () => {
    try {
      const mermaid = await ensureMermaid();
      if (!isCurrentMermaidJob(root, block, job)) return;
      renderCounter += 1;
      const id = `mermaid-svg-${renderCounter}`;
      const { svg, bindFunctions } = await mermaid.render(id, raw);
      if (!isCurrentMermaidJob(root, block, job)) return;
      block.innerHTML = svg;
      addMermaidSvgAccessibility(block, raw);
      bindFunctions?.(block);
      block.dataset.mermaidState = 'rendered';
      block.setAttribute('data-mermaid-state', 'rendered');
      delete block.dataset.mermaidErrorSource;
    } catch {
      if (!isCurrentMermaidJob(root, block, job)) return;
      block.dataset.mermaidState = 'error';
      block.setAttribute('data-mermaid-state', 'error');
      block.dataset.mermaidErrorSource = raw;
      const fallback = document.createElement('div');
      fallback.className = 'mermaid-block__error';
      fallback.textContent = 'Mermaid 渲染失败，已保留源码';
      block.appendChild(fallback);
    } finally {
      if (mermaidJobs.get(block) === job) mermaidJobs.delete(block);
    }
  })();
  job.raw = raw;
  job.promise = promise;
  mermaidJobs.set(block, job);
  await promise;
}

// 模块级串行队列：mermaid 各 diagram 类型的 db 为单例，render 非线程安全。
// 不仅单容器内串行，跨容器（多个 v-enrich 同一 tick mounted / 切换会话多条消息）也须互斥，
// 否则并发的 db.clear() 会互踩导致空白/串图。
let mermaidQueue: Promise<void> = Promise.resolve();
function runMermaidSerial(task: () => Promise<void>): void {
  // 单次任务失败不得阻断队列（后续块/容器仍可渲染）。
  mermaidQueue = mermaidQueue.then(task).catch(() => undefined);
}

function renderMermaidBlocks(root: HTMLElement): void {
  if (!root.isConnected) return;
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('.mermaid-block'));
  if (blocks.length === 0) return;
  runMermaidSerial(async () => {
    // 串行渲染：mermaid 各 diagram 类型的 db 为单例，Diagram.fromText 内 db.clear()+await parse，
    // 并发会让后块的 clear 抹掉前块已解析节点（mermaid 11.16 render 非线程安全）。
    for (const block of blocks) {
      if (!root.isConnected) break;
      await renderOneMermaidBlock(root, block, currentMermaidSource(block));
    }
  });
}

function onContainerClick(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLImageElement && target.classList.contains('md-img')) {
    event.preventDefault();
    openImageLightbox(target.currentSrc || target.src, target.alt, target);
  }
}

function onContainerKeydown(event: KeyboardEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLImageElement) || !target.classList.contains('md-img')) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  openImageLightbox(target.currentSrc || target.src, target.alt, target);
}

function prepareImages(root: HTMLElement): void {
  for (const image of root.querySelectorAll<HTMLImageElement>('img.md-img')) {
    image.setAttribute('tabindex', '0');
    image.setAttribute('role', 'button');
    image.setAttribute('aria-label', image.alt ? `放大图片：${image.alt}` : '放大图片');
  }
}

const clickHandlers = new WeakMap<HTMLElement, (event: Event) => void>();

export const enrichMarkdown: Directive<HTMLElement> = {
  mounted(el) {
    void renderMermaidBlocks(el);
    prepareImages(el);
    const handler = onContainerClick;
    clickHandlers.set(el, handler);
    el.addEventListener('click', handler);
    el.addEventListener('keydown', onContainerKeydown);
  },
  updated(el) {
    void renderMermaidBlocks(el);
    prepareImages(el);
  },
  unmounted(el) {
    const handler = clickHandlers.get(el);
    if (handler) el.removeEventListener('click', handler);
    el.removeEventListener('keydown', onContainerKeydown);
    clickHandlers.delete(el);
  },
};
