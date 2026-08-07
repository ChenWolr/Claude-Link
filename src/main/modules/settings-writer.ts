// 把 Claude Link 配置投影成 Claude Code settings.local.json（对标 CC GUI）。
// 写在 workingDirectory/.claude/settings.local.json，让 CLI 在该 cwd 启动时自动读取，
// permissions 等顶层字段生效（env 注入管不到这些）。env 字段也写入，脱离 Claude Link 也能用。
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

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
    return { ok: true, path: file, layer: 'local' };
  } catch (e) {
    logger.error('Failed to write settings.local.json', e);
    return { ok: false, path: null, layer: 'local', error: e instanceof Error ? e.message : String(e) };
  }
}
