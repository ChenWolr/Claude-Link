// sdk-command-origin.ts
// 从 Claude Code 实际 Skill/command 文件建立可验证的命令来源与 canonical name 映射。
// 不猜相似字符串：只接受目录名、SKILL.md frontmatter name/slug、command 文件名这些磁盘证据。

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { CommandOrigin } from '../../shared/types/command';

export interface CommandOriginEvidence {
  origins: Record<string, CommandOrigin>;
  canonicalNames: Record<string, string>;
}

export interface CommandOriginEvidenceInput {
  cwd?: string;
  plugins?: Array<{ name: string; path?: string }>;
  userHome?: string;
}

export function commandOriginKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^\/+/, '').toLowerCase();
}

function parseFrontmatter(text: string): { name?: string; slug?: string } {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = text.slice(3, end);
  const value = (key: string): string | undefined => {
    const match = block.match(new RegExp(`^${key}:\\s*["']?([^"'\\r\\n]+)["']?\\s*$`, 'mi'));
    return match?.[1]?.trim();
  };
  return { name: value('name'), slug: value('slug') };
}

// hb10-CMD-01（收窄）+ hb12-CMD-04：同名冲突按官方优先级裁 winner（plugin/builtin >
// enterprise > user-skill/personal > project），不再判 unknown——同名命令菜单可见且
// 来源徽章正确。证据仍记录全部 origins 供诊断。
const ORIGIN_PRIORITY: Record<string, number> = {
  plugin: 60,
  builtin: 60,
  enterprise: 50,
  'user-skill': 40,
  project: 30,
  unknown: 0,
};

function record(
  out: CommandOriginEvidence,
  name: string | undefined,
  canonicalName: string,
  origin: CommandOrigin,
): void {
  const key = commandOriginKey(name);
  if (!key) return;
  const existing = out.origins[key];
  if (!existing) {
    out.origins[key] = origin;
  } else if (existing !== origin) {
    // 冲突：按优先级取 winner（同优先级保持 unknown 语义不明时保守）。
    const pe = ORIGIN_PRIORITY[existing] ?? 0;
    const pn = ORIGIN_PRIORITY[origin] ?? 0;
    out.origins[key] = pn > pe ? origin : existing;
  }
  if (!out.canonicalNames[key]) out.canonicalNames[key] = canonicalName;
}

function scanSkillTree(
  root: string,
  origin: CommandOrigin,
  out: CommandOriginEvidence,
  maxDepth = 6,
): void {
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{
        name: string;
        isFile(): boolean;
        isDirectory(): boolean;
      }>;
    } catch {
      return;
    }
    const skill = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md');
    if (skill) {
      try {
        const frontmatter = parseFrontmatter(readFileSync(path.join(dir, skill.name), 'utf8'));
        const directoryName = path.basename(dir);
        const canonicalName = frontmatter.slug || directoryName;
        record(out, directoryName, canonicalName, origin);
        record(out, frontmatter.slug, canonicalName, origin);
        record(out, frontmatter.name, canonicalName, origin);
      } catch {
        // 单个损坏/不可读 Skill 不阻断其他来源采集。
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      try {
        if (lstatSync(child).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      visit(child, depth + 1);
    }
  };
  visit(root, 0);
}

/**
 * commands 目录扫描（P1-9 递归化）：`.claude/commands/<dir>/<cmd>.md` 形态的命名空间命令
 * 之前只扫根层 → 磁盘无证据 → origin=unknown → availability hidden → 从菜单消失。
 * 子目录命令 name 形态经真实 SDK probe 确证为「目录:basename」冒号拼接
 *（scripts/p1-09-subdir-command-probe.ts：commands/devtool/buildcmd.md → `devtool:buildcmd`，
 * system.init.slash_commands 与 supportedCommands 双源一致）。
 * 证据同时记录「冒号拼接全名」与「basename」两个键，classifyOrigin 命中任一即可；
 * 限深 6 层防爆炸（hb10-CMD-09 由 3 调到 6，见下方 COMMAND_SCAN_MAX_DEPTH），symlink 目录跳过（与 scanSkillTree 同防环手法）。
 */
// hb10-CMD-09：扫描深度 3→6（与指纹/skill 对齐，深命名空间命令可见）。
const COMMAND_SCAN_MAX_DEPTH = 6;

function scanCommandFiles(root: string, origin: CommandOrigin, out: CommandOriginEvidence): void {
  const visit = (dir: string, prefix: string, depth: number): void => {
    if (depth > COMMAND_SCAN_MAX_DEPTH) return;
    let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{
        name: string;
        isFile(): boolean;
        isDirectory(): boolean;
      }>;
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        try {
          if (lstatSync(child).isSymbolicLink()) continue;
        } catch {
          continue;
        }
        visit(child, prefix ? `${prefix}:${entry.name}` : entry.name, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const basename = entry.name.slice(0, -3);
      const fullName = prefix ? `${prefix}:${basename}` : basename;
      record(out, fullName, fullName, origin);
      if (fullName !== basename) record(out, basename, basename, origin);
    }
  };
  visit(root, '', 0);
}

export function buildCommandOriginEvidence(input: CommandOriginEvidenceInput): CommandOriginEvidence {
  const out: CommandOriginEvidence = { origins: {}, canonicalNames: {} };
  const home = input.userHome || homedir();
  scanSkillTree(path.join(home, '.claude', 'skills'), 'user-skill', out);
  scanCommandFiles(path.join(home, '.claude', 'commands'), 'user-skill', out);

  if (input.cwd) {
    scanSkillTree(path.join(input.cwd, '.claude', 'skills'), 'project', out);
    scanCommandFiles(path.join(input.cwd, '.claude', 'commands'), 'project', out);
  }

  for (const plugin of input.plugins ?? []) {
    if (!plugin?.path) continue;
    scanSkillTree(plugin.path, 'plugin', out);
    // plugin-qualified名字也可由 plugin 根名 + canonical 名证明。
    const entries = Object.entries(out.canonicalNames);
    for (const [key, canonical] of entries) {
      if (out.origins[key] !== 'plugin') continue;
      record(out, `${plugin.name}:${canonical}`, canonical, 'plugin');
    }
  }
  return out;
}
