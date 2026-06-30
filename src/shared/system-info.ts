// system-info.ts
// 判定一条 system information 事件是否值得落库 / 展示。
//
// 背景：SDK / CLI 在某些回合会下发空文本的 informational 横幅（content / text 均为空）。
// 落库后只剩默认文案「系统提示」，渲染成「ℹ️ 系统提示」，纯噪音且每次发送都冒一条。
// 规则：informational 子类型必须有非空文本才保留；其余子类型（permission / compact_boundary /
// plugin_install / interaction_response / api_retry 等）一律放行——它们有专用文案或语义。
//
// 纯函数，被 sdk-backend.ts（发射点）/ cli-shared.ts（落库）/ use-chat.ts（渲染）三处复用，
// 并由 selftest 覆盖契约。

export function isDisplayableSystemInfo(subtype: string | undefined, text: string | undefined): boolean {
  if (subtype !== 'informational') return true;
  return !!(text && text.trim());
}

// R2（二次修复，问题 5）：判定一条已落库的 system 过程消息是否「在聊天流里重复渲染」。
// 背景：首轮误判噪音源为「空 informational」，DB 实测真实噪音是 permission（权限询问）+
// system:interaction_response（交互回执）—— 每次工具调用 1:1 落库两条、content 非空。
// 这两类信息已由 InteractionPrompt 弹窗 + interaction_history 表承载，在消息流里再渲染一遍
// 「ℹ️ Claude 想要执行 X」纯属噪音。故渲染层（group-messages）跳过它们，但**仍落库**留审计。
//
// 问题 2（彻底修复）：把 system:informational 也纳入冗余集。informational 是 CC 的通用信息横幅，
// 即便带非空文本，在聊天流里也是一行来历不明的灰字、与思考/工具混排在同一 fold，无用户可读语义
// （权限询问/交互回执/压缩边界/插件安装各有专用承载或专用 processKind，不在此列）。落库仍保留审计，
// 渲染层跳过——兑现「要么解释要么删掉」的「删掉」一支。compact_boundary/plugin_install 有展示价值，保留。
// 纯函数，由 selftest 覆盖契约。
export function isRedundantSystemProcessKind(processKind: string | null | undefined): boolean {
  return (
    processKind === 'permission' ||
    processKind === 'system:interaction_response' ||
    processKind === 'system:informational'
  );
}
