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
  const content = JSON.stringify(settings, null, 2);

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
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, path: file, layer: 'local' };
  } catch (e) {
    logger.error('Failed to write settings.local.json', e);
    return { ok: false, path: null, layer: 'local', error: e instanceof Error ? e.message : String(e) };
  }
}
