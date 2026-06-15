// 自动检测系统 Claude Code 配置，参考 cc gui 的"零手动"体验。
//
// 扫描 Windows 三个标准路径并合并提取：
//   %USERPROFILE%\.claude\settings.json   → env.* / apiKeyHelper（复用 parseClaudeSettings）
//   %USERPROFILE%\.claude.json            → oauthAccount 元数据（订阅登录态标识，脱敏）
//   %USERPROFILE%\.claude\.credentials.json → 只判存在性，绝不读取 token 内容
//
// 安全约束：检测到的明文 apiKey 只回传给渲染进程预填表单，最终落盘走
// config-manager.encryptApiKey（safeStorage 加密）；OAuth token 永不读取/存储；
// apiKeyHelper 仅记录路径用于 UI 提示，Claude Link 不执行外部脚本。

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseClaudeSettings } from '../../shared/settings-parser';
import type { DetectedClaudeConfig, DetectedOauthAccount } from '../../shared/types/config';

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

// 读（不删除）第一个非空字符串（trim 后）。
function peekString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

// 从 .claude.json 的 oauthAccount 提取非敏感标识字段。
function extractOauthAccount(root: Record<string, unknown>): DetectedOauthAccount | undefined {
  const oauth = asObject(root.oauthAccount);
  if (!oauth) return undefined;
  const email = peekString(oauth, ['emailAddress', 'email']);
  const accountUuid = peekString(oauth, ['accountUuid', 'accountId']);
  const organizationType = peekString(oauth, ['organizationType']);
  if (!email && !accountUuid && !organizationType) return undefined;
  return { email, accountUuid, organizationType };
}

export function detectClaudeConfig(): DetectedClaudeConfig {
  const home = os.homedir();
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const claudeJsonPath = path.join(home, '.claude.json');
  const credPath = path.join(home, '.claude', '.credentials.json');

  const result: DetectedClaudeConfig = {
    found: false,
    sources: [],
    apiKey: undefined,
    apiBaseUrl: undefined,
    defaultModel: undefined,
    apiKeyHelper: undefined,
    oauthAccount: undefined,
    hasOAuthCredentials: false,
    advancedJson: '{}',
    errors: [],
  };

  // 1. settings.json — 复用 parseClaudeSettings（含 env.* 与 apiKeyHelper 提取规则）
  try {
    if (fs.existsSync(settingsPath)) {
      result.sources.push('settings.json');
      const content = fs.readFileSync(settingsPath, 'utf-8');
      const extracted = parseClaudeSettings(content);
      if (extracted.apiKey) result.apiKey = extracted.apiKey;
      if (extracted.apiBaseUrl) result.apiBaseUrl = extracted.apiBaseUrl;
      if (extracted.defaultModel) result.defaultModel = extracted.defaultModel;
      if (extracted.apiKeyHelper) result.apiKeyHelper = extracted.apiKeyHelper;
      if (extracted.advancedJson && extracted.advancedJson !== '{}') {
        result.advancedJson = extracted.advancedJson;
      }
    }
  } catch (e) {
    result.errors.push(`settings.json: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. .claude.json — oauthAccount 元数据（claude.ai 订阅登录态标识）
  try {
    if (fs.existsSync(claudeJsonPath)) {
      result.sources.push('.claude.json');
      const content = fs.readFileSync(claudeJsonPath, 'utf-8');
      const root = asObject(JSON.parse(content));
      if (root) {
        const oauth = extractOauthAccount(root);
        if (oauth) result.oauthAccount = oauth;
      }
    }
  } catch (e) {
    result.errors.push(`.claude.json: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3. .credentials.json — 仅判存在性，绝不读取 OAuth token 内容
  try {
    if (fs.existsSync(credPath)) {
      result.sources.push('.credentials.json');
      result.hasOAuthCredentials = true;
    }
  } catch (e) {
    result.errors.push(`.credentials.json: ${e instanceof Error ? e.message : String(e)}`);
  }

  result.found = result.sources.length > 0;
  return result;
}
