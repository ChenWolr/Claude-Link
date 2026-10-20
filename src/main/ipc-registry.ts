// ipc-registry.ts
// 「网页访问（局域网）」P2：invoke handler 注册表（docs/plans/2026-10-20-web-access-plan.md §3-P2-1）。
//
// regInvokeHandler 是 ipcMain.handle 的等价包装：桌面路径行为零变化（ipcMain.handle 原样注册，
// 仅多转发一层），同时把 handler 收进模块级 Map——网页端（web-access-server，P3）经
// invokeFromWeb 用同一份 handler 闭包响应 WS invoke。网页可调用面 = 注册表键集：
// 未进注册表的通道（如 export-image-manager 的 EXPORT_RENDER_* 7 通道裸注册）天然不可被网页
// 调用，无需黑名单机制。
//
// 实现注记（与计划 §3-P2-1 代码形态的唯一偏差，已申报）：handler 的 args 用 any[] 而非 unknown[]
// ——strictFunctionTypes 下 unknown[] 的参数逆变检查会拒绝既有 handler 的具体类型注解
// （如 workingDir: string | null），逐个抹注解违背「机械替换、签名不动」的最小影响面约束；
// any[] 与 electron 自身 ipcMain.handle 的 listener 形参（...args: any[]）同口径。

import { ipcMain } from 'electron';

export type RegisteredInvokeHandler = (
  event: Electron.IpcMainInvokeEvent | null,
  ...args: any[]
) => unknown;

const registry = new Map<string, RegisteredInvokeHandler>();

/** ipcMain.handle 的注册表等价物：桌面 invoke 行为不变，同时登记进 Map 供 invokeFromWeb 复用。 */
export function regInvokeHandler(channel: string, handler: RegisteredInvokeHandler): void {
  ipcMain.handle(channel, (event, ...args) => handler(event, ...args));
  registry.set(channel, handler);
}

/** 网页端 invoke 分发入口（P3 web-access-server 调用）：查表调同一份 handler；event 传 null，
 * handler 侧对 event 的既有消费点（如导出发起窗 sender）自行按空分支回落主窗口。 */
export async function invokeFromWeb(
  channel: string,
  args: unknown[],
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const h = registry.get(channel);
  if (!h) return { ok: false, error: `未知通道: ${channel}` };
  try {
    return { ok: true, result: await h(null, ...args) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 当前可被网页调用的通道键集（诊断/契约用）。 */
export function listRegisteredChannels(): string[] {
  return [...registry.keys()];
}
