// 全局导出状态 store（v3 第 10 节）。判别联合状态机 + 迟到 jobId 过滤 + 终态 1.2s 收起。
// 可见 renderer 只接收进度事件，不持有图片数据。
import { defineStore } from 'pinia';
import type { ExportImagePhase, ExportImageProgressPayload, ExportWebDownloadFile } from '../../shared/types/export-image';
import type { ExportTargetRequest } from '../../shared/types/fs-picker';
import { useFsPickerStore } from './fs-picker-store';

const TERMINAL_PHASES: ExportImagePhase[] = ['done', 'cancelled', 'error'];
const TERMINAL_HOLD_MS = 1200;

// P5（网页版导出）：web 模式判定——与 session-store isWebMode 同源（web-bridge createWebApi
// 安装时置位 window.__claudeLinkWebBridge；该文件仅网页端加载，桌面 Electron 恒无标记）。
// session-store 的 isWebMode 为模块私有未导出，此处按同源表达式镜像（桌面恒 false → 全旧行为）。
function isWebMode(): boolean {
  return !!(window as any).__claudeLinkWebBridge;
}

// T5 导出目标协商：最近一次导出目录（内存态，作下次 defaultPath；不持久化）。
// 刻意放模块级而非 state——scheduleReset 的 this.$reset() 会以 state 工厂重置全部 state，
// 进 state 会在终态 1.2s 后归空，「跨 job 记住上次目录」永远不生效。
let lastExportDir = '';

// round-001 review-report FIX-2a：本端最近一次 start 生成的一次性 nonce（模块级，理由同
// lastExportDir——$reset 会清 state，而 nonce 生命周期应跨 1.2s 终态驻留期）。done 相
// webDownloads.originNonce 与之相等才触发本端下载（多网页客户端抢答防护）；命中即清空防重放。
let pendingWebNonce = '';

interface ExportImageState {
  jobId: string | null;
  sessionId: string | null;
  sessionName: string;
  phase: ExportImagePhase;
  page: number;
  totalPages: number;
  segment: number;
  segmentsInPage: number;
  percent: number;
  message: string;
  _timer: ReturnType<typeof setTimeout> | null;
  // P5b 双端互不弹窗/互不干扰：本端是否发起了当前导出（$reset 复位为 false）。
  localStarted: boolean;
}

export const useExportImageStore = defineStore('export-image', {
  state: (): ExportImageState => ({
    jobId: null,
    sessionId: null,
    sessionName: '',
    phase: 'idle',
    page: 0,
    totalPages: 0,
    segment: 0,
    segmentsInPage: 0,
    percent: 0,
    message: '',
    _timer: null,
    localStarted: false,
  }),
  getters: {
    running(state): boolean {
      return state.phase !== 'idle' && !TERMINAL_PHASES.includes(state.phase);
    },
    terminal(state): boolean {
      return TERMINAL_PHASES.includes(state.phase);
    },
    indeterminate(state): boolean {
      return state.phase === 'planning' || state.phase === 'preparing';
    },
  },
  actions: {
    /** 应用一条进度事件：未发起导出的端不收养他端 job；迟到 jobId 丢弃；终态保持 1.2s 后复位。 */
    applyProgress(payload: ExportImageProgressPayload): void {
      // 未发起导出的端不再显示另一端发起的导出进度/完成文案（双端独立原则）。
      if (!this.localStarted) return;
      // P5b 审查 F1 窗 a：他端 job 终态迟到竞态（本端已置位、自端首条进度未达的窗口）不收养。
      // 自端首事件恒为 preparing 非终态；自端「首事件即终态」（导出窗加载失败等）由 invoke
      // 失败分支置 error UI 兜底，此处丢弃不损 UX。
      if (!this.jobId && TERMINAL_PHASES.includes(payload.phase)) return;
      if (this.jobId && payload.jobId !== this.jobId) return; // 迟到事件丢弃
      this.jobId = payload.jobId;
      this.sessionId = payload.sessionId;
      this.sessionName = payload.sessionName;
      this.phase = payload.phase;
      this.page = payload.page;
      this.totalPages = payload.totalPages;
      this.segment = payload.segment;
      this.segmentsInPage = payload.segmentsInPage;
      this.percent = payload.percent;
      this.message = payload.message;
      // P5（网页版导出）：web 发起的 job，done 相携带一次性票据下载清单——立即触发浏览器
      // 逐文件下载（先于终态收起计时；void 不阻塞 scheduleReset）。桌面分支不触发。
      // round-001 review-report FIX-2a：nonce 门——多网页客户端同收 done 广播，仅
      // originNonce 与本端 pendingWebNonce 相等（即本端发起的这次 start）才触发下载；
      // 命中后立即清空 pendingWebNonce（防同一清单重放）。
      if (
        payload.phase === 'done' &&
        payload.webDownloads &&
        isWebMode() &&
        payload.webDownloads.originNonce === pendingWebNonce
      ) {
        pendingWebNonce = '';
        // round-001 review-report FIX-2b：先钉住发起 job 的 jobId——downloadWebFiles 异步
        // 串行 await 期间用户可能已发起新 job（this.jobId 被覆盖），迟到失败不得污染新 job。
        const ownerJobId = payload.jobId;
        void this.downloadWebFiles(payload.webDownloads.files, ownerJobId);
      }
      if (TERMINAL_PHASES.includes(payload.phase)) {
        this.scheduleReset();
      }
    },
    /** 主动发起导出（来自 AppHeader 分享按钮，格式由 ExportImageFormatDialog 选定）。 */
    async start(sessionId: string, sessionName: string, format: 'jpeg' | 'png'): Promise<void> {
      if (this.running) return; // 全局只允许一个导出 job
      // hb12-EXP-02：上一 job 终态的 1.2s 复位定时器若未取消，$reset() 会丢掉句柄却留活定时器，
      // 到点把本 job 刚置的 preparing 态抹掉（遮罩闪烁消失）。新 start 必须先取消遗留定时器。
      if (this._timer) clearTimeout(this._timer);
      this.$reset();
      // 本端发起标记（$reset 复位为 false，重复 start 语义自洽）：applyProgress 只收养本端发起的 job。
      this.localStarted = true;
      this.phase = 'preparing';
      this.sessionId = sessionId;
      this.sessionName = sessionName;
      this.message = format === 'png' ? '正在准备会话（PNG 长图）…' : '正在准备会话…';
      try {
        // round-001 review-report FIX-2a：web 发起为本 job 生成一次性 nonce 存 pendingWebNonce
        // 并作第 4 参透传（主进程回填 webDownloads.originNonce 供本端比对）；桌面不传
        //（undefined → 全旧行为）。
        const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
        pendingWebNonce = nonce;
        const r = await window.claudeLink.startImageExport(sessionId, format, isWebMode(), isWebMode() ? nonce : undefined);
        if (!r.ok) {
          // P5b 审查 F1 窗 b：失败即回置——error 驻留 1.2s 内不收养他端 job。
          this.localStarted = false;
          this.phase = 'error';
          this.message = r.message;
          this.scheduleReset();
        }
        // 成功：jobId 由第一条进度事件（preparing/planning）回填。
      } catch (e) {
        // P5b 审查 F1 窗 b：失败即回置——error 驻留 1.2s 内不收养他端 job。
        this.localStarted = false;
        this.phase = 'error';
        this.message = String((e as Error)?.message || e);
        this.scheduleReset();
      }
    },
    /** B4（D13-F3）：用户取消当前导出（仅捕获/编码阶段有效；无活动 job/已终态主进程拒绝，
     * 终态进度事件自然收口）。 */
    async cancel(): Promise<void> {
      try {
        await window.claudeLink.cancelImageExport();
      } catch {
        // IPC 失败：job 已死/无活动 job——终态进度（cancelled/error）或复位定时器兜底。
      }
    },
    /** T5 导出目标协商：主进程 EXPORT_REQUEST_TARGET 推送 → 自绘 FilePickerDialog 选择 → 应答。
     *  App.vue onMounted 注册一次订阅（单订阅者），与 applyProgress 同为全局链路。 */
    async handleExportTargetRequest(req: ExportTargetRequest): Promise<void> {
      const fsPicker = useFsPickerStore();
      const r = await fsPicker.openFilePicker({
        mode: req.multi ? 'directory' : 'save-file',
        title: req.multi ? '选择导出图片保存目录' : '保存导出图片',
        filename: req.multi ? undefined : req.suggestedName,
        defaultPath: lastExportDir || undefined,
      });
      try {
        if (r && r.kind === 'directory') {
          lastExportDir = r.dir;
          await window.claudeLink.resolveExportTarget(req.jobId, { kind: 'directory', dir: r.dir });
        } else if (r && r.kind === 'save') {
          lastExportDir = r.dir;
          await window.claudeLink.resolveExportTarget(req.jobId, { kind: 'save', dir: r.dir, filename: r.filename });
        } else {
          await window.claudeLink.resolveExportTarget(req.jobId, { kind: 'cancel', reason: 'user' });
        }
      } catch {
        // 应答失败（job 已超时/收口）：主进程 Map 已清，迟到应答被拒——静默。
      }
    },
    /** P5（网页版导出）：逐文件把票据 URL 产物下载到浏览器本机（fetch→blob→a[download]）。
     *  串行触发；全部失败才置 error 文案，部分失败注明第几张。已知限制：浏览器对多文件
     *  自动下载可能弹「允许下载多个文件」权限提示，用户允许后继续（一次授权仅对本站生效，
     *  后续导出可能再次询问——浏览器行为，应用侧不可控）。
     *  round-001 review-report FIX-2b：ownerJobId 为发起下载时的 job——await 串行下载期间
     *  用户可能已发起新 job，全败/部分败写状态前须 this.jobId === ownerJobId 守卫，
     *  非 owner 一律 console.warn 丢弃（不污染后继 job 的 phase/message/收起计时）。 */
    async downloadWebFiles(files: ExportWebDownloadFile[], ownerJobId?: string | null): Promise<void> {
      const failedIdx: number[] = [];
      for (let i = 0; i < files.length; i++) {
        try {
          const r = await fetch(files[i]!.url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const blob = await r.blob();
          const u = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = u;
          a.download = files[i]!.filename;
          a.click();
          URL.revokeObjectURL(u);
        } catch {
          failedIdx.push(i + 1);
        }
      }
      if (files.length > 0 && failedIdx.length === files.length) {
        // 全部失败：票据已随首次消费/过期失效，须重跑导出（message 无歧义）。
        if (this.jobId === ownerJobId) {
          this.phase = 'error';
          this.message = '下载失败：请重新导出（下载链接已失效）';
          this.scheduleReset();
        } else {
          // round-001 review-report FIX-2b：迟到失败（job 已切换/已复位）——丢弃不污染。
          console.warn(`[export-image] 迟到的网页下载全败结果已丢弃（owner=${String(ownerJobId)}，当前 job=${String(this.jobId)}）`);
        }
      } else if (failedIdx.length > 0) {
        // 部分失败：仅注明；终态遮罩 1.2s 后收起，重跑导出可补齐缺页。
        if (this.jobId === ownerJobId) {
          this.message = `部分文件下载失败（第 ${failedIdx.join('、')} 张），请重新导出补齐`;
        } else {
          console.warn(`[export-image] 迟到的网页下载部分失败结果已丢弃（owner=${String(ownerJobId)}，当前 job=${String(this.jobId)}）`);
        }
      }
    },
    scheduleReset(): void {
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => {
        this.$reset();
        this._timer = null;
      }, TERMINAL_HOLD_MS);
    },
  },
});
