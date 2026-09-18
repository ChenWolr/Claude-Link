// settings-projection-merge.ts
// hb12-CFG-01（P2）：CL 所有权投影合并——settings.local.json 整体覆盖会丢失 CC 会话期
// 「don't ask again」写入的放行规则与用户手改内容。修法（复核定型）：快照 diff——
//   · CL 所有权键（defaultMode/env/思考档等自家键）照写（CL 权威）；
//   · 非所有权键：现文件有而快照没有 = CC 新增 → 保留；快照有而现文件没有 = CL 上次
//     写入且已被外部删除 → 保持删除（可撤销性）；快照与现文件一致 → 照写 CL 值。
// 纯并集会毁可撤销性（advancedJson 删掉的规则被旧文件复活），故必须 diff。
// 兼容：无快照首跑非 CL 键一律保留现文件值（保守合并，不丢外部内容），落盘后进入 diff 模式（hb12 §6.5）。

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

/** CL 所有权键：这些顶层键由 CL 投影权威整体写入（env/effortLevel/alwaysThinkingEnabled
 *  三键 CC 不写；permissions 例外——CC 会话期「don't ask again」会写 permissions.allow/ask/deny，
 *  故在 mergeProjection 中单独深合并，见下方 permissions 分支）。 */
const CL_OWNED_KEYS: ReadonlySet<string> = new Set([
  'permissions',
  'env',
  'effortLevel',
  'alwaysThinkingEnabled',
]);

const SNAPSHOT_FILE = 'claude-link-projection-snapshot.json';

/** 读取上次投影快照（无/损坏 → null，进入「首跑保守合并」模式）。 */
export function readProjectionSnapshot(dir: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(path.join(dir, SNAPSHOT_FILE), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 写入投影快照（与投影同目录；失败仅记日志，不影响保存主流程——下次退化为首跑模式）。 */
export function writeProjectionSnapshot(dir: string, snapshot: Record<string, unknown>): void {
  try {
    fs.writeFileSync(path.join(dir, SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (e) {
    logger.warn(`[projection] 快照写入失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 删除投影快照（clearConfig 恢复出厂时；目录级清理一并处理）。 */
export function clearProjectionSnapshot(dir: string): void {
  try {
    fs.rmSync(path.join(dir, SNAPSHOT_FILE), { force: true });
  } catch {
    // ignore
  }
}

/** hb12-CFG-01 核心纯函数：三方合并（上次快照 × 现文件 × 下次投影）→ 合并结果。
 *  - CL 所有权键：取 nextProjection（照写）；
 *  - 非 CL 键（如 permissions.allow 细粒度放行、用户手改 hooks）：
 *      · 快照有而现文件没有 → 保持删除（CL 上次写入、已被外部删除/撤销）；
 *      · 现文件有而快照没有 → CC 新增 → 保留现文件值；
 *      · 双方都有：现文件==快照（无外部改动）→ 照写 CL 新值；不同 → 现文件为准（外部
 *        更新优先于 CL 上次投影）。permissions 深合并标量同理（hb13-v B1/F-01+F-02）。
 *  - 无快照（首跑/迁移）：非 CL 键一律保留现文件值（保守合并，不丢任何外部内容）。 */
export function mergeProjection(
  previousSnapshot: Record<string, unknown> | null,
  currentFile: Record<string, unknown>,
  nextProjection: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  // 全部键集合：投影键 ∪ 现文件键 ∪ 快照键。
  const keys = new Set<string>([...Object.keys(nextProjection), ...Object.keys(currentFile)]);
  if (previousSnapshot) for (const k of Object.keys(previousSnapshot)) keys.add(k);

  for (const key of keys) {
    if (key === 'permissions') {
      // permissions 特殊：CL 所有权在 defaultMode 等自家字段，而 CC 会话期「don't ask again」
      // 恰写入 permissions.allow/ask/deny 数组——整键照写会丢 CC 授权（hb12-CFG-01 主场景）。
      // 深层合并：数组字段 = CL 投影条目 + CC 新增（现文件有而快照没有的条目）；defaultMode 等
      // 标量照写投影。
      const next = nextProjection[key];
      if (!(next && typeof next === 'object' && !Array.isArray(next))) continue; // 本次不投影 → 保持删除
      const mergedPerm: Record<string, unknown> = {};
      const curPerm = currentFile[key];
      const snapPerm = previousSnapshot?.[key];
      const nextPerm = next as Record<string, unknown>;
      const curPermObj = curPerm && typeof curPerm === 'object' && !Array.isArray(curPerm) ? curPerm as Record<string, unknown> : {};
      const snapPermObj = snapPerm && typeof snapPerm === 'object' && !Array.isArray(snapPerm) ? snapPerm as Record<string, unknown> : {};
      for (const pk of new Set<string>([...Object.keys(nextPerm), ...Object.keys(curPermObj)])) {
        const nv = nextPerm[pk];
        const cv = curPermObj[pk];
        if (Array.isArray(nv)) {
          // 数组字段（allow/ask/deny/additionalDirectories）：CL 条目 + CC 新增条目。
          const base = Array.isArray(nv) ? nv.slice() : [];
          const prevList = Array.isArray(snapPermObj[pk]) ? (snapPermObj[pk] as unknown[]) : [];
          const curList = Array.isArray(cv) ? cv : [];
          for (const item of curList) {
            if (!base.some((b) => JSON.stringify(b) === JSON.stringify(item))
              && !prevList.some((b) => JSON.stringify(b) === JSON.stringify(item))) {
              // 现文件有而快照没有 = CC 会话期新增 → 保留。
              base.push(item);
            }
          }
          mergedPerm[pk] = base;
        } else if (pk in nextPerm) {
          mergedPerm[pk] = nv; // CL 标量权威（defaultMode 等）
        } else if (cv !== undefined) {
          // hb13-v B1（F-02）：CL 删除的标量不得被现文件复活——现文件值==快照值（即 CL 上次
          // 写的）→ 保持删除（权限档切回后旧值不再残留）；不同 = CC/用户外部改动 → 保留。
          // hb13-v review 修复：数组与标量同款 stringify 快照比对——引用比较对快照/现文件
          // 两次解析出的不同对象恒不等，CL 整体删除的数组字段（allow/ask 等）会被旧文件复活。
          if (!(pk in snapPermObj) || JSON.stringify(cv) !== JSON.stringify(snapPermObj[pk])) {
            mergedPerm[pk] = cv;
          }
        }
      }
      merged[key] = mergedPerm;
      continue;
    }
    if (CL_OWNED_KEYS.has(key)) {
      // CL 权威：照写（nextProjection 缺该键 = 本次不再投影 → 保持删除）。
      if (key in nextProjection) merged[key] = nextProjection[key];
      continue;
    }
    // 键不在本次投影中：
    //  · 快照有 = CL 上次投影过、本次已移除 → 保持删除（可撤销性核心）；
    //  · 快照没有 = 与 CL 投影无关的外部内容（CC/用户直写）→ 保留现文件。
    if (!(key in nextProjection)) {
      const wasOurs = previousSnapshot != null && key in previousSnapshot;
      if (!wasOurs && key in currentFile) merged[key] = currentFile[key];
      continue;
    }
    // 键在本次投影中（走到这里的必为非所有权键——所有权键已在上方 CL_OWNED_KEYS 分支
    //  照写并 continue，不会到达此处）：
    //  · 现文件没有 = CL 上次写入且已被外部删除 → 重写投影（恢复 CL 意图）；
    //  · 现文件有 → 首跑无快照保留现文件（保守合并）；有快照则 diff：现文件==快照（无外部
    //    改动）→ 照写 CL 新值，不等 → 保留现文件（外部更新优先）。
    if (!(key in currentFile)) {
      merged[key] = nextProjection[key];
      continue;
    }
    if (!CL_OWNED_KEYS.has(key) && !previousSnapshot) {
      // 首跑无快照：非 CL 键保留现文件（保守合并，不丢外部内容）。
      merged[key] = currentFile[key];
      continue;
    }
    if (!CL_OWNED_KEYS.has(key)) {
      // hb13-v B1（F-01）：补「现文件==快照」比对——相等 = 自 CL 上次投影后无外部改动 →
      // 照写 CL 新值（CL 对 hooks/model 等非所有权键的修改才能落盘）；不等 = 外部改动优先
      // → 保留现文件。JSON.stringify(undefined)===undefined，快照缺键天然判不等 → 保留现文件。
      if (JSON.stringify(currentFile[key]) === JSON.stringify(previousSnapshot?.[key])) {
        merged[key] = nextProjection[key];
      } else {
        merged[key] = currentFile[key];
      }
    }
  }
  return merged;
}

/** 便捷封装：读取现文件（不存在 → {}）→ 合并 → 返回 [合并结果, 供快照写入的下次投影]。 */
export function mergeProjectionWithFile(
  workingDir: string,
  nextProjection: Record<string, unknown>,
): Record<string, unknown> {
  const dir = path.join(workingDir, '.claude');
  const file = path.join(dir, 'settings.local.json');
  let currentFile: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      currentFile = parsed as Record<string, unknown>;
    }
  } catch {
    // 文件不存在/损坏：按空文件合并（损坏文件内容不可信，不复活）。
  }
  const snapshot = readProjectionSnapshot(dir);
  return mergeProjection(snapshot, currentFile, nextProjection);
}
