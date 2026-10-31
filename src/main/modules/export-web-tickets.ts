// export-web-tickets.ts
// P5（网页版导出）：一次性下载票据（192bit 随机、单次消费、10min 过期）。
// 设计依据：docs/plans/2026-10-24-web-sync-directory-naming-export-plan.md §4.2-2。
//
// ticket 即凭证：a[download]/fetch 的 GET 无法携带 WS 鉴权，故不复用 WS token；票据 URL
// 不含任何文件路径信息（路径只在主进程内存 Map 里，消费时才还原）。消费面仅
// web-access-server 的 /api/export-download；cancel/error 路径经 export-image-manager 的
// cleanup → purgeJob 随即失效。纯逻辑、无 Electron 依赖，Node selftest 可直接导入。

import { randomBytes } from 'node:crypto';
import type { ExportWebDownloadFile } from '../../shared/types/export-image';

/** 票据 TTL（= 下载窗口）：与导出产物 tempDir 的 web 延迟清理同刻。 */
export const WEB_DOWNLOAD_TTL_MS = 10 * 60_000;

interface TicketRecord {
  jobId: string;
  filePath: string;   // content 型票据为 ''
  filename: string;
  content?: string;   // content 型票据的内存正文（不出主进程）
  mime?: string;      // content 型票据的 MIME
  expiresAt: number;
  used: boolean;
}

const tickets = new Map<string, TicketRecord>();

/** 为一页产物签发一次性下载票据；返回网页端下载清单条目（URL 相对当前 web 源）。 */
export function createTicket(jobId: string, filePath: string, filename: string): ExportWebDownloadFile {
  const ticket = randomBytes(24).toString('base64url');
  tickets.set(ticket, { jobId, filePath, filename, expiresAt: Date.now() + WEB_DOWNLOAD_TTL_MS, used: false });
  const timer = setTimeout(() => { tickets.delete(ticket); }, WEB_DOWNLOAD_TTL_MS);
  // unref：过期清理定时器不阻止进程退出（quit 路径另有 disposeExportTempDirsSync 兜底）。
  timer.unref();
  return { filename, url: `/api/export-download?ticket=${ticket}` };
}

/** 一次性票据的命中视图（判别字段：content 存在即内存正文型，否则为文件型）。
 *  文件型票据消费结果保持既有 { filePath, filename } 形状（既有下载链零变化）。 */
export type TicketHit =
  | { filePath: string; filename: string; content?: undefined; mime?: undefined }
  | { content: string; mime: string; filename: string; filePath?: undefined };

/** 为内存正文签发一次性下载票据（MCP 导出 JSON 网页路径）：正文只存主进程内存，URL 不含内容。 */
export function createTicketForContent(
  filename: string,
  content: string,
  mime: string,
): { filename: string; url: string } {
  const ticket = randomBytes(24).toString('base64url');
  // jobId 用空串哨兵：purgeJob(真实 jobId) 永不命中，避免导出产物清理误摘内容票据。
  tickets.set(ticket, { jobId: '', filePath: '', filename, content, mime, expiresAt: Date.now() + WEB_DOWNLOAD_TTL_MS, used: false });
  const timer = setTimeout(() => { tickets.delete(ticket); }, WEB_DOWNLOAD_TTL_MS);
  timer.unref();
  return { filename, url: `/api/export-download?ticket=${ticket}` };
}

/** 单次消费：查无 / 过期 / 已用 → null（过期/已用顺手摘除条目）；命中标记 used 后返回。 */
export function consumeTicket(ticket: string): TicketHit | null {
  const rec = tickets.get(ticket);
  if (!rec) return null;
  if (rec.used || Date.now() > rec.expiresAt) {
    tickets.delete(ticket);
    return null;
  }
  rec.used = true;
  if (typeof rec.content === 'string') {
    return { content: rec.content, mime: rec.mime ?? 'application/octet-stream', filename: rec.filename };
  }
  return { filePath: rec.filePath, filename: rec.filename };
}

/** 按 job 摘除全部票据（job 终态清理路径调用；桌面 job 无票据时 no-op）。 */
export function purgeJob(jobId: string): void {
  for (const [ticket, rec] of tickets) {
    if (rec.jobId === jobId) tickets.delete(ticket);
  }
}

/** 测试注入：清空全部票据（生产不调用）。 */
export function reset(): void {
  tickets.clear();
}
