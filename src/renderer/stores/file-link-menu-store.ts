// file-link-menu-store.ts
// md-file-link 右键上下文菜单全局状态（P6-B，2026-11-21 translate-fix-and-ui-points 计划）：
// pinia 单例 store，App.vue 挂载的 FileLinkMenu 全局单例消费（七处委托组件只经 useFileLinkMenuStore
// 的 open() 弹菜单，不各自持菜单实例）。行为契约（00 唯一事实源）：
//   - open(path, x, y)：置可见 + 坐标 + exists:null（检查中），立即异步 fs:stat 预检存在性；
//     存在 → 全部动作可用；不存在 → notice「文件不存在」+ 1-4 禁用（复制路径恒可用）。
//   - 左键零动作（本点契约）：菜单是 .md-file-link 的唯一交互入口；http 外链不经此 store。
//   - 竞态：模块级 seq 自增守卫——open/close 都 ++，晚到的旧 fsStat 响应一律丢弃（连右键第二个
//     链接 = 换目标重开不叠双菜单；close 后响应不回写不重开）。
//   - 动作全部复用既有通道，零新 IPC：fs:stat（预检）/ fs:openPath（default|choose）/
//     fs:showInExplorer；网页版同通道（web-bridge.ts 已注册，远控语义：动作作用于桌面主机）。
//   - 动作反馈对齐 ToolCallBlock.openGeneratedFile 先例（ToolCallBlock.vue:67-78）：失败把
//     ChangesOpenResult.message 写入 notice 行、菜单保持可见；成功即 close()。
import { defineStore } from 'pinia';
import { copyTextToClipboard } from '../utils/clipboard';
import { useFilePreview } from '../composables/useFilePreview';

// pinia 全局唯一 store id：「fileLinkMenu」（cdp-file-preview-smoke.mjs A5-3 经 _s.get('fileLinkMenu')
// 断言菜单目标，id 与脚本契约耦合勿改）。
export const useFileLinkMenuStore = defineStore('fileLinkMenu', {
  state: () => ({
    visible: false,
    path: '',
    x: 0,
    y: 0,
    // 存在性预检三态：null=检查中（菜单已开、动作用户先行时不阻断，失败自反馈）；true/false=已判定。
    exists: null as boolean | null,
    // 提示行（role="status"）：exists=false → 「文件不存在」；动作失败 → ChangesOpenResult.message；
    // 复制成功 → 「已复制」。空串 = 无提示行。
    notice: '',
  }),
  actions: {
    /** 弹出菜单：记录目标路径与屏幕坐标（clientX/clientY），复位检查中态并异步预检。
     *  重入安全：seq++ 使旧目标的在途预检作废（连右键第二个链接 = 换目标重开）。 */
    open(path: string, x: number, y: number): void {
      statSeq++;
      this.visible = true;
      this.path = path;
      this.x = x;
      this.y = y;
      this.exists = null;
      this.notice = '';
      void this.statCheck(statSeq);
    },
    /** fs:stat 存在性预检（单次 invoke，低频；主进程 statPath 对缺失路径恒回 {exists:false} 不抛）。
     *  响应回来时 seq 变化（重开/已关）或菜单已关 → 丢弃。通道级异常按 fail-closed 收敛为
     *  exists=false（动作禁用、复制路径仍可用），不误报「已存在」。 */
    async statCheck(mySeq: number): Promise<void> {
      let res: { exists: boolean; isDir: boolean; size: number };
      try {
        res = await window.claudeLink.fsStat(this.path);
      } catch {
        res = { exists: false, isDir: false, size: 0 };
      }
      if (mySeq !== statSeq || !this.visible) return;
      this.exists = res.exists;
      if (!res.exists) this.notice = '文件不存在';
    },
    /** 关闭菜单（幂等）：seq++ 使在途预检与晚到响应全部作废。 */
    close(): void {
      statSeq++;
      this.visible = false;
      this.notice = '';
    },
    /** 1 预览：关菜单后开内置预览抽屉（useFilePreview 语义，与原左键直开同终态；远控语义同现状）。 */
    preview(): void {
      this.close();
      useFilePreview().open(this.path);
    },
    /** 2 用系统默认程序打开（fsOpenPath default）：成功关菜单；失败写 notice 留菜单。 */
    async openDefault(): Promise<void> {
      await this.openWith('default');
    },
    /** 3 选择打开方式…（fsOpenPath choose，Win 打开方式对话框；非 Win 由主进程
     *  changes-panel.openChooseDialog 既有响应承担「当前平台暂不支持选择打开方式」——R2 裁决
     *  不做渲染层平台判定）。 */
    async openChoose(): Promise<void> {
      await this.openWith('choose');
    },
    /** 2/3 公用：先关旧提示再发请求；ok → close()；!ok → message 进 notice（菜单保持可见）。 */
    async openWith(mode: 'default' | 'choose'): Promise<void> {
      this.notice = '';
      try {
        const res = await window.claudeLink.fsOpenPath(this.path, mode);
        if (res.ok) {
          this.close();
        } else {
          this.notice = res.message;
        }
      } catch (e) {
        this.notice = `打开失败：${(e as Error).message ?? e}`;
      }
    },
    /** 4 在文件夹中显示（fsShowInExplorer）：成功关菜单；失败写 notice 留菜单。
     *  FsShowResult 仅 { ok }（无 message，主进程 shell.showItemInFolder 静默失败形态）——
     *  ok:false 用本地固定文案；通道级异常带 message 走通用打开失败文案。 */
    async showInExplorer(): Promise<void> {
      this.notice = '';
      try {
        const res = await window.claudeLink.fsShowInExplorer(this.path);
        if (res.ok) {
          this.close();
        } else {
          this.notice = '在文件夹中显示失败';
        }
      } catch (e) {
        this.notice = `打开失败：${(e as Error).message ?? e}`;
      }
    },
    /** 5 复制路径（data-clip-path 全路径）：复制恒可用（不受 exists 预检门控）。网页版非安全
     *  上下文经 utils/clipboard 降级（textarea+execCommand）；成功「已复制」/失败写反馈，均留
     *  菜单可见（notice 行承接，与 1-4 失败同款反馈面）。 */
    async copyPath(): Promise<void> {
      this.notice = '';
      const ok = await copyTextToClipboard(this.path);
      this.notice = ok ? '已复制' : '复制失败';
    },
  },
});

// 模块级竞态守卫序号（非响应式，与 FilePreviewDrawer.reqSeq 同形态）：open/close 自增，
// statCheck 捕获发起时的序号，响应回来序号不一致即丢弃。
let statSeq = 0;
