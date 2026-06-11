import type { ClaudeLinkAPI } from '../preload/api';

declare global {
  interface Window {
    claudeLink: ClaudeLinkAPI;
  }
}

export {};
