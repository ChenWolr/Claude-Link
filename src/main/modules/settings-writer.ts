// 把 Claude Link 配置投影成 Claude Code settings.local.json（对标 CC GUI）。
// 写在 workingDirectory/.claude/settings.local.json，让 CLI 在该 cwd 启动时自动读取，
// permissions/hooks 等顶层字段生效（env 注入管不到这些）。
// 连接加固 P3：端点凭据不再写入本文件（见 claude-settings-projection 头注释）；
// 写入本身原子化（临时文件 + rename）且内容不变时跳过。
// 注意：workingDirectory 为 null 时跳过（不阻塞保存，env 注入仍走 buildSpawnEnv）。
//
// Task 3：settings.local.json 属于「local 层」（优先级高于 project 文件、低于 Claude Link 显式
// Options.settings）。本模块只写允许写入的 local 层；绝不创建伪造的 CLAUDE.md（那是 /init 的真实
// 文件副作用，Task 4/5 验证，不由配置保存路径代写）。

import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig } from '../../shared/types/config';
import { logger } from '../utils/logger';
import { buildClaudeSettingsProjection } from './claude-settings-projection';
import { mergeProjectionWithFile, writeProjectionSnapshot } from './settings-projection-merge';

export interface WriteSettingsResult {
  ok: boolean;
  /** 实际写入的 settings.local.json 绝对路径（写入成功时非 null）。 */
  path: string | null;
  /** 写入的配置层（固定 'local'，明确本模块的语义边界）。 */
  layer: 'local';
  error?: string;
}

export const SKIP_NO_WORKDIR = '未设置工作目录';

export function writeClaudeSettings(workingDir: string | null, config: AppConfig): WriteSettingsResult {
  if (!workingDir) return { ok: false, path: null, layer: 'local', error: SKIP_NO_WORKDIR };

  const dir = path.join(workingDir, '.claude');
  const file = path.join(dir, 'settings.local.json');

  const settings = buildClaudeSettingsProjection(config);
  // hb12-CFG-01：投影合并——快照 diff（CC 授权保留 + CL 删除可撤销 + 自家键照写），
  // 替换原整体覆盖（每次 CL 保存丢 CC 会话期「don't ask again」授权与用户手改内容）。
  // rawProjection = CL 本次实际投影，写入快照供下轮 diff 判定外部增删。
  const rawProjection = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
  const merged = mergeProjectionWithFile(workingDir, rawProjection);
  const content = JSON.stringify(merged, null, 2);

  try {
    fs.mkdirSync(dir, { recursive: true });
    // 内容未变则跳过写盘：本文件在每次供应商 CRUD / 会话选模型 / 配置保存时被重写，
    // 相同内容跳过可避免与正在启动的 CLI 子进程发生「读到半截 JSON」的竞态，也减少磁盘抖动。
    try {
      if (fs.readFileSync(file, 'utf8') === content) return { ok: true, path: file, layer: 'local' };
    } catch {
      // 文件不存在（首次写入）则继续。
    }
    // 原子替换：先写同目录临时文件再 rename，杜绝并发读者看到半截文件。
    const tmp = path.join(dir, `.settings.local.json.${process.pid}.${Date.now()}.tmp`);
    try {
      fs.writeFileSync(tmp, content, 'utf8');
      // hb10-CFG-04：rename 受杀软/索引器占用时瞬时失败常见——3 次退避重试（10/50/100ms）
      // 后仍失败才上抛（saveConfig 据此返回 projectionOk:false，UI 可见「已保存（投影失败）」）。
      const backoffs = [10, 50, 100];
      let renamed = false;
      let lastErr: unknown;
      for (const ms of backoffs) {
        try {
          fs.renameSync(tmp, file);
          renamed = true;
          break;
        } catch (renameErr) {
          lastErr = renameErr;
          const until = Date.now() + ms;
          while (Date.now() < until) { /* 同步忙等（本模块全同步 API） */ }
        }
      }
      if (!renamed) throw lastErr;
      // hb12-CFG-01：落盘成功后写入快照（记录 CL 本次实际投影；失败仅记日志）。
      writeProjectionSnapshot(dir, rawProjection);
    } catch (writeErr) {
      // P3-9：写失败 best-effort 清掉 .tmp 垃圾（每次保存都会生成唯一名，不清则累积）；
      // 清理自身失败静默（主错误照常上抛给外层日志）。
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw writeErr;
    }
    return { ok: true, path: file, layer: 'local' };
  } catch (e) {
    logger.error('Failed to write settings.local.json', e);
    return { ok: false, path: null, layer: 'local', error: e instanceof Error ? e.message : String(e) };
  }
}
