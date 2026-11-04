// preview-store.ts
// 文件预览抽屉全局开关态（2026-11-04 计划 round-001 p2）：pinia 单例 store，
// App.vue 挂载的 FilePreviewDrawer 全局单例消费（触发点只经 useFilePreview 薄壳开/关，
// 不直连本 store，避免打开逻辑散落）。真实文件内容读取在组件侧 load()，本 store 只管
// 「开着没有、开着哪个文件、当前哪个模式」三件状态。

import { defineStore } from 'pinia';
import { extOfPath, previewFormatInfo, type PreviewMode } from '../utils/preview-format';

// pinia 全局唯一 store id：「filePreview」——唯一结构钉为调用形状钉
// （scripts/tdd-file-preview-verify.ts 的 defineStore('filePreview', { 断言）；
// round-001 P3-E 已删除自证式字面钉，注释内容不再参与任何断言。
export const usePreviewStore = defineStore('filePreview', {
  state: () => ({
    open: false,
    path: '',
    // 初始 neutral 值；openPreview 时按扩展名推导默认模式（单态文件落 'source' 源码视图）。
    mode: 'source' as PreviewMode,
  }),
  actions: {
    /** 打开某文件的预览：记录路径并按格式判定推导默认模式（无默认则回落源码视图）。 */
    openPreview(path: string): void {
      this.open = true;
      this.path = path;
      this.mode = previewFormatInfo(extOfPath(path), null).defaultMode ?? 'source';
    },
    /** 关闭抽屉（仅翻开关位；内容清理/revoke 由组件 close 路径负责）。 */
    close(): void {
      this.open = false;
    },
    /** pill 切换预览模式。 */
    setMode(m: PreviewMode): void {
      this.mode = m;
    },
  },
});
