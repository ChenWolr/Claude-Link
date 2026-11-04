// preview-format.ts
// 文件预览面板（2026-11-04 计划 round-001 p2）渲染层格式判定：按扩展名 + category 给出
// 可用模式集合与默认模式，供 preview-store / FilePreviewDrawer 消费。
// 零框架依赖（禁 import vue/pinia）：契约脚本 scripts/tdd-file-preview-verify.ts 以 tsx
// 直测本模块——引入任何框架依赖都会让该脚本在 Node 侧崩掉。

/** 预览模式：md/svg 走 preview/source 双态；html 走 web/code；mmd 走 graph/source。 */
export type PreviewMode = 'preview' | 'source' | 'web' | 'code' | 'graph';

/** 双模式扩展 → 可用模式集合与默认模式（仅 category===null 时生效）。 */
const DUAL_MODE_EXTS: Record<string, { modes: PreviewMode[]; defaultMode: PreviewMode }> = {
  md: { modes: ['preview', 'source'], defaultMode: 'preview' },
  html: { modes: ['web', 'code'], defaultMode: 'web' },
  htm: { modes: ['web', 'code'], defaultMode: 'web' },
  svg: { modes: ['preview', 'source'], defaultMode: 'preview' },
  mmd: { modes: ['graph', 'source'], defaultMode: 'graph' },
};

/**
 * 按扩展名与主进程预览 category 判定可用模式。
 * 判定顺序：category 非空（blob/二进制类）一律单态无 pill；category===null 且 ext 命中
 * 四双模式扩展（md/html/htm/svg/mmd）返回对应双模式；其余（含 category null 的纯文本/源码）
 * 单态——modes 空 + defaultMode null（组件按 modes.length>1 才渲染 pill）。
 * ext 一律小写处理（调用方传大写时函数内 toLowerCase 兜底）。
 */
export function previewFormatInfo(ext: string, category: string | null): { modes: PreviewMode[]; defaultMode: PreviewMode | null } {
  if (category !== null) return { modes: [], defaultMode: null };
  const dual = DUAL_MODE_EXTS[ext.toLowerCase()];
  return dual ?? { modes: [], defaultMode: null };
}

/**
 * 取路径的扩展名（小写）：以最后一个 /[\\/]/ 分隔符之后的末段为准，取末段最后一个 '.' 之后
 * 的后缀并小写；无点或点在末尾 → ''。Windows 反斜杠与 POSIX 斜杠都认。
 */
export function extOfPath(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot === -1 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** base64 → 字节（渲染层无 Buffer；blob 类预览的 base64 载荷转 Blob 用）。
 * 返回类型钉 Uint8Array<ArrayBuffer>（TS 5.7+ 泛型 BufferSource 语义）：new Uint8Array(n)
 * 即此精确类型，宽写 Uint8Array（=ArrayBufferLike）过不了 BlobPart 赋值。 */
export function base64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
