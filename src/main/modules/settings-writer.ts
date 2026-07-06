// 把 Claude Link 配置投影成 Claude Code settings.local.json（对标 CC GUI）。
// 写在 workingDirectory/.claude/settings.local.json，让 CLI 在该 cwd 启动时自动读取，
// permissions 等顶层字段生效（env 注入管不到这些）。env 字段也写入，脱离 Claude Link 也能用。
// 注意：workingDirectory 为 null 时跳过（不阻塞保存，env 注入仍走 buildSpawnEnv）。

import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig } from '../../shared/types/config';
import { logger } from '../utils/logger';
import { buildClaudeSettingsProjection } from './claude-settings-projection';

export interface WriteSettingsResult {
  ok: boolean;
  path: string | null;
  error?: string;
}

export const SKIP_NO_WORKDIR = '未设置工作目录';

export function writeClaudeSettings(workingDir: string | null, config: AppConfig): WriteSettingsResult {
  if (!workingDir) return { ok: false, path: null, error: SKIP_NO_WORKDIR };

  const dir = path.join(workingDir, '.claude');
  const file = path.join(dir, 'settings.local.json');

  const settings = buildClaudeSettingsProjection(config);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
    return { ok: true, path: file };
  } catch (e) {
    logger.error('Failed to write settings.local.json', e);
    return { ok: false, path: null, error: e instanceof Error ? e.message : String(e) };
  }
}
