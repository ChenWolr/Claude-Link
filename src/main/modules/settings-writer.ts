// 把 Claude Link 配置投影成 Claude Code settings.local.json（对标 CC GUI）。
// 写在 workingDirectory/.claude/settings.local.json，让 CLI 在该 cwd 启动时自动读取，
// permissions 等顶层字段生效（env 注入管不到这些）。env 字段也写入，脱离 Claude Link 也能用。
// 注意：workingDirectory 为 null 时跳过（不阻塞保存，env 注入仍走 buildSpawnEnv）。

import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig } from '../../shared/types/config';
import { logger } from '../utils/logger';

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

  // 从 advancedJson.env 提取字符串字段（模型映射、CLAUDE_CODE_* 等）
  const env: Record<string, string> = {};
  try {
    const adv = JSON.parse(config.advancedJson || '{}');
    const envBlock =
      adv && adv.env && typeof adv.env === 'object' && !Array.isArray(adv.env) ? (adv.env as Record<string, unknown>) : null;
    if (envBlock) {
      for (const [k, v] of Object.entries(envBlock)) {
        if (typeof v === 'string') env[k] = v;
      }
    }
  } catch {
    /* advancedJson 非法时忽略，env 仅含下方显式字段 */
  }

  // apiKey/baseUrl 显式写入 env（对标 CC GUI，让 settings.local.json 独立可用）
  if (config.apiKey) env.ANTHROPIC_API_KEY = config.apiKey;
  const baseUrl = config.apiBaseUrl?.trim();
  if (baseUrl && baseUrl !== 'https://api.anthropic.com') env.ANTHROPIC_BASE_URL = baseUrl;

  const settings: Record<string, unknown> = {
    permissions: { defaultMode: config.permissionMode },
    env,
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
    return { ok: true, path: file };
  } catch (e) {
    logger.error('Failed to write settings.local.json', e);
    return { ok: false, path: null, error: e instanceof Error ? e.message : String(e) };
  }
}
