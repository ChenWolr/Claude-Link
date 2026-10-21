// web-access-info.ts
// 「网页访问（局域网）」P3：连接信息构建（URL 列表 + 二维码），供 webAccess:getInfo 通道
//（P5 设置页「网页访问」节消费）。docs/plans/2026-10-20-web-access-plan.md §3-P3-3。
//
// token 走 URL hash 片段（计划 §2）：hash 不随任何 HTTP 请求行发送（也不进网关/隧道代理的
// 访问日志）；页面 JS（P4 web-bridge）读 location.hash → 存 localStorage → replaceState 清除。

import * as os from 'node:os';
import QRCode from 'qrcode';
import type { WebAccessInfoView } from '../../../shared/types/ipc';
import { getConfig, getWebAccessToken } from '../config-manager';
import { logger } from '../../utils/logger';
import { getWebAccessStatus } from './web-access-server';

/**
 * 构建连接 URL 列表：http://<IPv4>:<port>/#token=<token>。
 * v1 仅列非 internal 的 IPv4 地址（计划 §4 #16）——IPv6 场景由 allowedHosts+隧道覆盖；
 * token 为空（未生成）或功能未启用时返回空列表。
 */
export function listWebAccessUrls(port: number, token: string): string[] {
  const urls: string[] = [];
  if (!token) return urls;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.internal || iface.family !== 'IPv4') continue;
      urls.push(`http://${iface.address}:${port}/#token=${token}`);
    }
  }
  return urls;
}

/** 当前生效的 URL 列表（copyLink 通道白名单校验同源复用）：按配置端口 + 存量令牌现算。 */
export function currentWebAccessUrls(): string[] {
  const cfg = getConfig().webAccess;
  const token = getWebAccessToken();
  if (!cfg.enabled || !token) return [];
  const status = getWebAccessStatus();
  const port = status.state === 'off' ? cfg.port : status.port;
  return listWebAccessUrls(port, token);
}

/**
 * 设置页信息卡全量：enabled / 运行状态 / URL 列表 / 令牌明文（桌面展示复制用；已认证网页端
 * 也可调——等同信任域，计划 §3-P3-4 注） / 首 URL 二维码（qrcode toDataURL，同 wechat-login
 * 用法，前端 <img src> 直显）。二维码生成失败不阻断信息卡（urls 仍可复制）。
 */
export async function buildWebAccessInfo(): Promise<WebAccessInfoView> {
  const cfg = getConfig().webAccess;
  const status = getWebAccessStatus();
  const token = getWebAccessToken();
  const urls = cfg.enabled ? currentWebAccessUrls() : [];
  let qrDataUrl: string | null = null;
  if (urls.length > 0) {
    try {
      qrDataUrl = await QRCode.toDataURL(urls[0], { width: 280, margin: 2 });
    } catch (e) {
      // 编码失败（理论不可达）：仅丢二维码，不阻断信息卡
      logger.warn(`[web-access] qrcode 生成失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { enabled: cfg.enabled, status, urls, token, qrDataUrl };
}
