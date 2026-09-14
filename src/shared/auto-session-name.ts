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

/** hb13-v A5：物化判定——两形态并集。暂态会话默认名「新会话」与物化自动名「会话 N」都视为
 *  自动形态（物化时改写为「最大自动序号+1」）；用户自然命名（含以「新会话」为前缀的其他
 *  命名）原样透传。仅物化分支消费；DB 写门槛仍走 isAutoSessionName（物化后不存在「新会话」）。 */
export function isMaterializableAutoName(name: string | null | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  return isAutoSessionName(trimmed) || trimmed === '新会话';
}

/** hb10-SMG-08：扫描名称集中「会话 N」的最大自动序号（无自动名则 0）——
 *  物化名取 max+1，删除中间会话后不再与现存自动名撞号。 */
export function maxAutoSessionNumber(names: readonly (string | null | undefined)[]): number {
  let max = 0;
  for (const name of names) {
    if (!name) continue;
    const m = /^会话 (\d+)$/.exec(name.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}
