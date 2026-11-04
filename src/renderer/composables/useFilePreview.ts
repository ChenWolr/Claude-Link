// useFilePreview.ts
// 文件预览抽屉触发器薄壳（仿 useDiffDialog/useImageLightbox 的 use 三件套形态）：
// 真实状态在 pinia preview-store（跨组件全局单例），本层零自有状态——
// 薄壳的意义：给触发点一个稳定窄入口并收拢「开抽屉」语义（默认模式推导在 store 内），
// 触发点不直连 store，后续加触发点（工具行/文件链接）只 import 本函数即可。

import { usePreviewStore } from '../stores/preview-store';

export function useFilePreview() {
  const store = usePreviewStore();
  return {
    open: (p: string) => store.openPreview(p),
    close: () => store.close(),
    store,
  };
}
