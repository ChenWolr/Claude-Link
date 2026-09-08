// auto-session-name.ts
// 会话自动命名形态的唯一判定（H3 判据加固，三端同源）。
//
// 物化自动名的真实格式是 `会话 ${n}`（session-store materializeActiveTransient）。
// 旧判据用「会话」前缀匹配，会被用户自然命名（如「会话备份」「会话 3 备份」）绕过——
// 迟到主题/附件名会覆盖用户手动起的名字（恰是 F4 竞态守卫要防的场景）。
// 消费方：主进程 topic-analyzer（DB 写门槛）× 渲染层 session-store（触发/写前/视图覆盖门槛）。

/** 判定会话名是否仍是自动命名形态「会话 N」（trim 后全等 /^会话 \d+$/）。 */
export function isAutoSessionName(name: string | null | undefined): boolean {
  if (!name) return false;
  return /^会话 \d+$/.test(name.trim());
}
