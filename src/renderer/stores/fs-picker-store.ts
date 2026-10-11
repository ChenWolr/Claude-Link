// fs-picker-store.ts
// 全局自绘文件选择器 store（原生弹窗统一改造 T2）：单例队列——同时只显示一个选择器，
// 后续请求排队（对齐 InteractionPrompt 队列语义），resolve 先到先得。
// App.vue 挂载的 FilePickerDialog 单例消费 current；选择动作全部在渲染层完成，
// 文件系统元数据经 window.claudeLink.fs* 只读 IPC（主进程 modules/fs-picker.ts）。

import { defineStore } from 'pinia';
import type { FsDriveInfo, FsQuickLocation, FsRootsResult } from '../../shared/types/fs-picker';

export interface FilePickerRequest {
  id: string;                       // uuid（crypto.randomUUID）
  mode: 'directory' | 'save-file' | 'open-file';
  title: string;
  defaultPath?: string;             // 初始目录（缺省 home）
  filename?: string;                // save-file 初始文件名（含扩展名；若含目录部分组件只取文件名）
  multiSelect?: boolean;            // open-file 有效
}

export type FilePickerResult =
  | { kind: 'directory'; dir: string }
  | { kind: 'files'; paths: string[] }
  | { kind: 'save'; dir: string; filename: string }
  | { kind: 'cancel' };

interface FsRootsCache {
  cwdHome: string;
  quick: FsQuickLocation[];
  drives: FsDriveInfo[];
}

interface QueueItem {
  req: FilePickerRequest;
  resolve: (r: FilePickerResult) => void;
}

export const useFsPickerStore = defineStore('fs-picker', {
  state: () => ({
    current: null as QueueItem | null,
    queue: [] as QueueItem[],
    // listRoots 结果缓存：驱动器枚举 1s 预算别反复花——首个请求拉一次，后续复用；
    // 拉取失败归 null（弹窗用缺省目录仍可用），ensureRoots 幂等可重试。
    roots: null as FsRootsCache | null,
    _rootsPromise: null as Promise<void> | null,
  }),
  actions: {
    /**
     * 发起一次文件选择。返回 Promise，用户确认/取消时 resolve（FilePickerResult）。
     * 已有选择器在场时排队（先到先得），排到队首时组件 watch(current) 自动接手。
     */
    openFilePicker(req: Omit<FilePickerRequest, 'id'>): Promise<FilePickerResult> {
      const id = crypto.randomUUID();
      return new Promise<FilePickerResult>((resolve) => {
        const item: QueueItem = { req: { ...req, id }, resolve };
        if (this.current) this.queue.push(item);
        else this.current = item;
        if (!this.roots) void this.ensureRoots();
      });
    },
    /**
     * 结算当前选择器：resolve 其 promise 并切到队首下一单（无则 null）。
     * 先切 current 再 resolve——resolve 的微任务回调（如立即再发起下一次选择）执行时
     * current 已就位，队列语义不被回调顺序影响；组件 watch(current) 直接重开。
     */
    settleCurrent(result: FilePickerResult): void {
      const cur = this.current;
      if (!cur) return;
      this.current = this.queue.shift() ?? null;
      cur.resolve(result);
    },
    /**
     * 幂等拉取 roots 缓存：已缓存直接返回；在途请求共享同一 Promise（去重并发）；
     * 失败后清 _rootsPromise，供组件在 roots 为 null 时再试。
     */
    async ensureRoots(): Promise<void> {
      if (this.roots) return;
      if (!this._rootsPromise) {
        this._rootsPromise = (async () => {
          try {
            const r: FsRootsResult = await window.claudeLink.fsListRoots();
            if (r.ok) this.roots = { cwdHome: r.cwdHome, quick: r.quick, drives: r.drives };
          } catch {
            // IPC 异常：roots 维持 null，不阻塞选择器打开（defaultPath / C:\ 兜底）。
          } finally {
            this._rootsPromise = null;
          }
        })();
      }
      await this._rootsPromise;
    },
  },
});
