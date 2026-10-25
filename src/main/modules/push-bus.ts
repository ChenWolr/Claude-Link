// push-bus.ts
// 「网页访问（局域网）」P2：主→渲染推送总线（docs/plans/2026-10-20-web-access-plan.md §3-P2-3）。
//
// pushToMainWindow 是 webContents.send 的等价收口：主窗口判空 + isDestroyed + try-catch 后
// 发送（webSink 为 null 时退化为纯 webContents.send——桌面行为零变化），再转发给 web 推送
// sink（P3 web-access-server 经 setWebPushSink 注入，向全部已认证 WS 连接广播）。
// 本模块不 import 任何业务模块（依赖方向铁律：推送站点模块 → push-bus 单向）。

import type { BrowserWindow } from 'electron';

let getWindow: () => BrowserWindow | null = () => null;
let webSink: ((channel: string, args: unknown[]) => void) | null = null;

/** app 启动时注入主窗口 getter（闭包引用局部 let mainWindow，窗口重建自动跟随）。 */
export function initPushBus(getter: () => BrowserWindow | null): void {
  getWindow = getter;
}

/** 当前主窗口（getter 直通；未 init 或窗口已置 null 时为 null）。 */
export function getCurrentMainWindow(): BrowserWindow | null {
  return getWindow();
}

/** P3 web-access-server 注入的事件广播 sink；传 null 摘除（退出/停服收口用）。 */
export function setWebPushSink(sink: ((channel: string, args: unknown[]) => void) | null): void {
  webSink = sink;
}

/** 主→渲染推送唯一出口：主窗口单播（判空/销毁竞态吞噬）+ web sink 转发（单参载荷语义对齐
 * webContents.send(channel, payload)，sink 收 args 数组以备多参通道）。 */
export function pushToMainWindow(channel: string, ...args: unknown[]): void {
  const w = getWindow();
  if (w && !w.isDestroyed()) {
    try {
      w.webContents.send(channel, ...args);
    } catch {
      /* 已销毁竞态：忽略单窗发送失败（与各站点原 try-catch 语义一致） */
    }
  }
  // round-008 R1-F4：sink 侧序列化/发送失败（如 BigInt 载荷不可结构化克隆）只影响 web 广播，
  // 不得穿透本总线抛回业务发射点——与上方主窗口单播的 try-catch 吞噬语义对齐。
  try {
    webSink?.(channel, args);
  } catch {
    /* sink 侧序列化/发送失败不得影响主窗口推送与业务链 */
  }
}

/** P5b（导出目标协商双端独立）：指定窗口单播——只发该窗口，不转发 webSink（origin 单播语义，
 * 与 pushToMainWindow 的「主窗 + web 全量广播」相对，谁发起谁应答的通道专用）。
 * 与 pushToMainWindow 的差异是承重设计：不判空/不判销毁/不吞噬发送异常（纯直通）——调用方
 * （如 requestExportTarget）依赖 send 抛错触发自身 catch 收口（window-closed settle），
 * 本函数若吞错会使 pending 协商挂到超时。 */
export function pushToWindow(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  win.webContents.send(channel, ...args);
}
