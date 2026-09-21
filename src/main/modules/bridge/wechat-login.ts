// wechat-login.ts — 微信 iLink 扫码登录模块。
// 移植自 openhanako (Apache-2.0) lib/bridge/wechat-login.ts（其参考 MIT 的
// @tencent-weixin/openclaw-weixin v1.0.2 的 src/auth/login-qr.ts）。
// 独立于 adapter 生命周期，被 BRIDGE_WECHAT_QRCODE IPC 直接调用（botToken 不出主进程）。

import QRCode from 'qrcode';

const BASE_URL = 'https://ilinkai.weixin.qq.com';
const BOT_TYPE = '3';
const QRCODE_STATUS_TIMEOUT_MS = 40_000;

/** 登录阶段请求头（无需 Authorization）。 */
function loginHeaders(): Record<string, string> {
  return { 'iLink-App-ClientVersion': '1' };
}

export interface WechatQrcodeResult {
  qrcodeId: string;
  qrcodeDataUrl: string;
}

/** 获取微信扫码登录二维码：qrcode_img_content 是要编码成二维码的 URL 文本（不是图片）。 */
export async function getWechatQrcode(fetchFn: typeof fetch = fetch): Promise<WechatQrcodeResult> {
  const url = `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  const res = await fetchFn(url, { headers: loginHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`获取微信二维码失败：HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const data = (await res.json()) as { qrcode?: string; qrcode_img_content?: string };
  if (!data.qrcode) throw new Error('服务器未返回二维码');
  const qrText = data.qrcode_img_content || data.qrcode;
  // qrcode 库转 data URL（base64 PNG），前端直接 <img src> 显示。
  const qrcodeDataUrl = await QRCode.toDataURL(qrText, { width: 280, margin: 2 });
  return { qrcodeId: data.qrcode, qrcodeDataUrl };
}

export type WechatQrcodePollResult =
  | { status: 'wait' | 'scaned' | 'expired' }
  | { status: 'confirmed'; botToken: string; botUserId: string }
  | { status: 'error'; error: string };

/**
 * 轮询扫码状态：iLink 服务器 hold 连接最多 35s（长轮询），调用方无需高频轮询。
 * confirmed 返回 bot_token/ilink_user_id（token 只进主进程，绝不回传渲染层以外的任何地方）。
 */
export async function pollWechatQrcodeStatus(qrcodeId: string, fetchFn: typeof fetch = fetch): Promise<WechatQrcodePollResult> {
  if (!qrcodeId) return { status: 'error', error: 'qrcodeId is required' };
  const url = `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QRCODE_STATUS_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchFn(url, { headers: loginHeaders(), signal: controller.signal });
    clearTimeout(timer);
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error)?.name === 'AbortError') return { status: 'wait' }; // 长轮询超时，继续等
    return { status: 'error', error: String((err as Error)?.message ?? err) };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { status: 'error', error: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}` };
  }
  const data = (await res.json()) as {
    status?: string;
    bot_token?: string;
    ilink_bot_id?: string;
    ilink_user_id?: string;
  };
  switch (data.status) {
    case 'wait':
      return { status: 'wait' };
    case 'scaned':
      return { status: 'scaned' };
    case 'confirmed':
      if (!data.bot_token || !data.ilink_bot_id) {
        return { status: 'error', error: '登录成功但服务器未返回凭证' };
      }
      return {
        status: 'confirmed',
        botToken: data.bot_token,
        botUserId: data.ilink_user_id || data.ilink_bot_id,
      };
    case 'expired':
      return { status: 'expired' };
    default:
      return { status: 'wait' };
  }
}
