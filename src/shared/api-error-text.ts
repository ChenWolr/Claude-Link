// api-error-text.ts
// 判定一条 assistant 正文是否是引擎落下来的 API 错误文案（如 400 reasoning_content）。
//
// 背景：第三方端点的 API 错误会以 `API Error: 400 …` 开头的 assistant 正文事件落库，
// isError=false，UI 当成普通回复展示（实测报告场景 C / dcf7be88 历史同形）。
// 谓词只认 trim 后的**前缀** `API Error:`——正文中间引用（如「之前报了 API Error: 400」）
// 不命中，避免误伤正常回复。
//
// 纯函数，被 cli-shared.ts（主进程落库）/ use-chat.ts（renderer 镜像）复用，
// 由 regression-tests 覆盖行为契约。
export function isApiErrorAssistantText(text: string): boolean {
  return text.trim().startsWith('API Error:');
}
