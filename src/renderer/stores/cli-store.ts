import { defineStore } from 'pinia';
import type { CliDetectionResult } from '../../shared/types/cli';

export const useCliStore = defineStore('cli', {
  state: () => ({
    cliResult: null as CliDetectionResult | null,
    detecting: false,
    error: null as string | null,
  }),
  actions: {
    async detectCli() {
      this.detecting = true;
      this.error = null;
      try {
        this.cliResult = await window.claudeLink.detectCli();
      } catch (error) {
        this.error = error instanceof Error ? error.message : '检测 Claude Code CLI 失败';
      } finally {
        this.detecting = false;
      }
    },
  },
});
