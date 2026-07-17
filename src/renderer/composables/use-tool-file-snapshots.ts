// use-tool-file-snapshots.ts
// 改前文件快照的渲染层存储。主进程在 canUseTool（工具执行前）拍快照，经专用 IPC 通道
// tool:fileSnapshot 直发到这里，按 toolUseId 索引。ToolCallBlock 渲染 Edit/Write/MultiEdit 时
// 取对应快照交给 synthesizeToolDiff，得到真实全文件 diff（真实行号/上下文、新建覆盖区分、
// MultiEdit 顺序合并）。
//
// 模块级单例：快照随 app 生命周期常驻，toolUseId 为全局唯一 UUID，无需按会话清理。
// 历史会话回看时无快照（事件早已发过且不落库）→ 调用方回退片段 diff，体验不退化。

import { reactive } from 'vue';

const snapshots = reactive<Record<string, string>>({});
let listening = false;

// App 启动时注册一次监听。必须在 app 启动即调用（早于任何工具执行），
// 否则会漏接 canUseTool 时刻发出的快照——那时 ToolCallBlock 可能尚未挂载。
export function bindToolFileSnapshots(): void {
  if (listening) return;
  listening = true;
  window.claudeLink.onToolFileSnapshot((payload) => {
    snapshots[payload.toolUseId] = payload.before;
  });
}

export function useToolFileSnapshots(): { getSnapshot: (toolUseId: string | null | undefined) => { before: string } | undefined } {
  return {
    // 取某 toolUseId 的改前快照；不存在返回 undefined（调用方回退片段 diff）。
    // 对 reactive Record 做 `in` / 下标读会被 Vue 追踪：快照后到时依赖它的 computed 自动重算。
    getSnapshot(toolUseId: string | null | undefined): { before: string } | undefined {
      if (!toolUseId) return undefined;
      return toolUseId in snapshots ? { before: snapshots[toolUseId] } : undefined;
    },
  };
}
