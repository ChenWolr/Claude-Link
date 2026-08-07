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

function record(
  out: CommandOriginEvidence,
  name: string | undefined,
  canonicalName: string,
  origin: CommandOrigin,
): void {
  const key = commandOriginKey(name);
  if (!key) return;
  const existing = out.origins[key];
  // 同名由不同层同时声明时不能猜 winner；显式 unknown 留给 UI/门禁解释。
  out.origins[key] = existing && existing !== origin ? 'unknown' : origin;
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

function scanCommandFiles(root: string, origin: CommandOrigin, out: CommandOriginEvidence): void {
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = readdirSync(root, { withFileTypes: true }) as unknown as Array<{
      name: string;
      isFile(): boolean;
    }>;
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const name = entry.name.slice(0, -3);
    record(out, name, name, origin);
  }
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
