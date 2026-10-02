import type { Directive } from 'vue';
import { openImageLightbox } from '../composables/useImageLightbox';

/**
 * v-enrich：挂在 v-html 的 .markdown-body 容器上，对解析后插入的"需前端二次渲染"
 * 内容做增强。当前负责：
 *  - mermaid：renderMarkdown 把 ```mermaid 产成 .mermaid-block 占位（携带源码 data-mermaid），
 *    这里懒加载 mermaid 运行时（动态 import，code-splitting 出首屏包），渲染成 SVG。
 *  - 图片灯箱：点击 img.md-img 弹出原图模态（事件委托到容器，卸载时解绑）。
 *
 * 这些是 DOM 依赖的客户端增强，其中可测部分已由 tsx 契约覆盖（scripts/regression-tests.ts：
 * mermaid 错误重试判定/无障碍标题为行为断言，串行队列/生命周期守卫为源码结构断言）；
 * mermaid 运行时真实 SVG 渲染与灯箱视觉交互仍靠真实 Electron 目视。
 */

type MermaidApi = typeof import('mermaid')['default'];

// A8（D05-F2）：主题单源——initialize 与内容指纹缓存键共用（键含主题保证主题切换强制全量重渲）。
const MERMAID_THEME_ID = 'neutral';

let mermaidPromise: Promise<MermaidApi> | null = null;

type MermaidJob = { raw: string; promise: Promise<void> };
const mermaidJobs = new WeakMap<HTMLElement, MermaidJob>();

type MermaidState = 'loading' | 'rendered' | 'error' | string | undefined;
const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_MERMAID_TITLE = 'Mermaid 图表';

// ── A8（D05-F2）：内容指纹 LRU 缓存 ──────────────────────────────────────
// 流式期间 v-html 每 50ms 整树替换，新 .mermaid-block 无 dataset 状态——去重状态机失效，
// 已完成图反复「闪回源码→重渲」。缓存键 = 主题 id + 内容指纹（FNV-1a + 长度），值 = 已渲染
// SVG 字符串；命中同步注入（全程微任务内，无源码帧），未命中走渲染并在成功后写入。
// 失败态不缓存（防毒化；流式半成品 parse 必失败同样不入）；上限 64，命中刷新 recency。
export class MermaidSvgCache {
  private entries = new Map<string, string>();

  constructor(private maxEntries = 64) {}

  get(key: string): string | null {
    const svg = this.entries.get(key);
    if (svg === undefined) return null;
    // LRU：命中即刷新 recency（摘除后重插尾部）。
    this.entries.delete(key);
    this.entries.set(key, svg);
    return svg;
  }

  set(key: string, svg: string): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, svg);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export const mermaidSvgCache = new MermaidSvgCache();

function fnv1aHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function mermaidCacheKey(raw: string, themeId: string): string {
  return `${themeId}:${raw.length}:${fnv1aHash(raw)}`;
}

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
  // P3-13（2026-10-02 对抗 review）：title id 的自增收敛到本函数——缓存命中路径原先复用
  // 未自增的 renderCounter（只有 fresh 渲染路径自增），同批多图命中（或与仍在 DOM 的上次
  // 渲染）撞同一 title id，aria-labelledby 指错图题；两条路径在此统一唯一化。
  renderCounter += 1;
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
        api.initialize({ startOnLoad: false, securityLevel: 'strict', theme: MERMAID_THEME_ID });
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
// P3-13：aria title id 也从此计数器取值（在 addMermaidSvgAccessibility 内自增）——缓存命中
// 路径复用未自增值会同批多图撞 id（aria-labelledby 指错图题）。
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

  // A8（D05-F2）：内容指纹命中 → 同步注入缓存 SVG（先于 loading 态——mounted/updated 到注入
  // 全程微任务内，已完成图不再闪回源码、不再重跑 parse）。注入后重盖唯一 aria title id
  //（同内容多块并存时旧 id 已随旧节点销毁/可能同 DOM 并存，复用旧 id 会重复）。
  const cachedSvg = mermaidSvgCache.get(mermaidCacheKey(raw, MERMAID_THEME_ID));
  if (cachedSvg !== null) {
    block.innerHTML = cachedSvg;
    addMermaidSvgAccessibility(block, raw);
    block.dataset.mermaidState = 'rendered';
    block.setAttribute('data-mermaid-state', 'rendered');
    block.dataset.mermaidSource = raw;
    block.setAttribute('data-mermaid-source', raw);
    delete block.dataset.mermaidErrorSource;
    return;
  }

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
      // A8：渲染成功写入内容指纹缓存（title id 重盖后取原始 svg 串；失败态走 catch 不入缓存）。
      mermaidSvgCache.set(mermaidCacheKey(raw, MERMAID_THEME_ID), svg);
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
