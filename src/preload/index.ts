import { contextBridge } from 'electron';
import { createApi, type ClaudeLinkAPI } from './api';

contextBridge.exposeInMainWorld('claudeLink', createApi());

declare global {
  interface Window {
    claudeLink: ClaudeLinkAPI;
  }
}
