// 全局导出状态 store（v3 第 10 节）。判别联合状态机 + 迟到 jobId 过滤 + 终态 1.2s 收起。
// 可见 renderer 只接收进度事件，不持有图片数据。
import { defineStore } from 'pinia';
import type { ExportImagePhase, ExportImageProgressPayload } from '../../shared/types/export-image';

const TERMINAL_PHASES: ExportImagePhase[] = ['done', 'cancelled', 'error'];
const TERMINAL_HOLD_MS = 1200;

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
    /** 应用一条进度事件：迟到 jobId 丢弃；终态保持 1.2s 后复位。 */
    applyProgress(payload: ExportImageProgressPayload): void {
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
      if (TERMINAL_PHASES.includes(payload.phase)) {
        this.scheduleReset();
      }
    },
    /** 主动发起导出（来自 AppHeader 分享按钮，格式由 ExportImageFormatDialog 选定）。 */
    async start(sessionId: string, sessionName: string, format: 'jpeg' | 'png'): Promise<void> {
      if (this.running) return; // 全局只允许一个导出 job
      this.$reset();
      this.phase = 'preparing';
      this.sessionId = sessionId;
      this.sessionName = sessionName;
      this.message = format === 'png' ? '正在准备会话（PNG 长图）…' : '正在准备会话…';
      try {
        const r = await window.claudeLink.startImageExport(sessionId, format);
        if (!r.ok) {
          this.phase = 'error';
          this.message = r.message;
          this.scheduleReset();
        }
        // 成功：jobId 由第一条进度事件（preparing/planning）回填。
      } catch (e) {
        this.phase = 'error';
        this.message = String((e as Error)?.message || e);
        this.scheduleReset();
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
