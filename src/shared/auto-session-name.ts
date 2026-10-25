// auto-session-name.ts
// 会话自动命名形态的唯一判定（H3 判据加固，三端同源）。
//
// 物化自动名的真实格式是 `会话 ${n}`（session-store materializeActiveTransient）。
// 旧判据用「会话」前缀匹配，会被用户自然命名（如「会话备份」「会话 3 备份」）绕过——
// 迟到主题/附件名会覆盖用户手动起的名字（恰是 F4 竞态守卫要防的场景）。
// 消费方：主进程 topic-analyzer（DB 写门槛）× 渲染层 session-store（触发/写前/视图覆盖门槛）。
// P4（计划 2026-10-24-web-sync §3.2.1-2）：名源判定与首输入兜底名构造——类型
// SessionNameSource 定义在 shared/types/session.ts（与 Session 接口同文件，申报：二选一取
// session.ts 方案），本文件只放纯判定函数（仅依赖 shared 纯函数、零宿主运行时依赖，
// Node selftest 可导）。

import type { SessionNameSource } from './types/session';
// round-001 review-report FIX-1a：sk- 密钥形态条件掩码（shared→shared 同层引用，零宿主依赖）。
import { maskApiKey } from './provider-library';

/** 判定会话名是否仍是自动命名形态「会话 N」（trim 后全等 /^会话 \d+$/）。 */
export function isAutoSessionName(name: string | null | undefined): boolean {
  if (!name) return false;
  return /^会话 \d+$/.test(name.trim());
}

/** P4：名源派生——存量行（DB name_source NULL）与脏值行按名称形态派生，与建行时
 *  createSession 的落列判据（isAutoSessionName ? 'slot' : 'custom'）同一口径；
 *  显式合法值直用（新建行 / 已写行不再随改名漂移，改名经 SESSION_UPDATE 恒置 custom）。 */
export function deriveNameSource(stored: string | null, name: string): SessionNameSource {
  if (stored === 'slot' || stored === 'first_input' || stored === 'generated' || stored === 'custom') {
    return stored;
  }
  return isAutoSessionName(name) ? 'slot' : 'custom';
}

/** P4：名源可升级判定——仅 slot（未命名槽位）与 first_input（首输入兜底名）允许被
 *  自动命名写覆盖；generated（LLM 概括已落）与 custom（用户命名）一律让位。 */
export function isUpgradableNameSource(s: SessionNameSource): boolean {
  return s === 'slot' || s === 'first_input';
}

/** P4：会话名源可升级判定（渲染层便捷形态，消费 Session/列表行/草稿对象）——
 *  nameSource 缺省的对象（旧快照/跨版本缓存/测试 fixture）按 NULL 存量行同语义经
 *  deriveNameSource 按名称形态派生（自动形态名 → slot 可升级；自然名 → custom 让位），
 *  不做「缺省即 slot」的乐观兜底（自然名可能是用户命名，乐观兜底会打开覆盖窗口）。
 *  申报：计划 §3.2.1-9 字面为 `?? 'slot'`，本实现收紧为派生兜底（最小影响原则）。 */
export function isUpgradableSession(s: { nameSource?: SessionNameSource; name: string } | null | undefined): boolean {
  if (!s) return false;
  return isUpgradableNameSource(s.nameSource ?? deriveNameSource(null, s.name));
}

/** P4：首输入兜底名——取首行 → trim → 连续空白折叠为单空格 → sk- 密钥形态条件掩码 →
 *  >20 码点截为前 19 码点 + …（码点安全，不劈代理对）；空/纯空白返回 null（调用方不写库，保持 slot 槽位）。 */
export function buildFirstInputSessionName(text: string): string | null {
  const firstLine = text.split('\n')[0] ?? '';
  const collapsed = firstLine.trim().replace(/\s+/g, ' ');
  // round-001 review-report FIX-1a：sk- 密钥形态条件掩码，对齐 topic-analyzer 短输入直写
  // 分支同款形态（防密钥碎片入标题）；maskApiKey 输出恒短于 20，自然免截。
  const src = /^sk-[A-Za-z0-9_\-]{8,}/.test(collapsed) ? maskApiKey(collapsed) : collapsed;
  if (!src) return null;
  // 按码点截断（Array.from 按 Unicode 码点切）：>20 码点 → 前 19 码点 + '…'；
  // ≤20 码点不截（UTF-16 码元超 20 但码点 ≤20 的纯 emoji 串不误截，不劈代理对）。
  const cps = Array.from(src);
  if (cps.length > 20) return `${cps.slice(0, 19).join('')}…`;
  return src;
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
