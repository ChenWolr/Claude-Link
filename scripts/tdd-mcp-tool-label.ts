// tdd-mcp-tool-label.ts
// 「MCP 工具折叠态 server 专属图标 + MCP_<server> 标签」契约钉（p1，测试先行）。
// 被测单源：src/renderer/utils/process-kind.ts（零外部 import 纯函数模块）。
// A 组：getProcessKindMeta —— mcp__<server>__<tool> → server 专属图标 + 'MCP_<server>' 标签 +
//       C.mcp 色；大小写/包含匹配、12 平台抽查、未命中回退 🔌、畸形名不抛错、非 mcp__ 工具回归；
// B 组：summarizeToolUse —— mcp__ 前缀返回工具名段（server 已在标签里），畸形返回 ''，
//       Bash 首行 / Skill 技能名回归；
// C 组：源码静态断言 —— process-kind.ts 含 MCP_SERVER_ICONS 及全部 12 键；
//       ToolCallBlock.vue 仍含 meta.icon / meta.label 渲染点（唯一消费方未受影响）；
// D 组：mcpServerIcon 直测 —— 大小写+中文混合命中 / 未命中回退 / 空串不抛错。
//
// 运行：npx tsx scripts/tdd-mcp-tool-label.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getProcessKindMeta, mcpServerIcon, summarizeToolUse } from '../src/renderer/utils/process-kind';
import type { ProcessKindMeta } from '../src/renderer/utils/process-kind';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 畸形名/异常输入不允许抛错——抛错按 null 处理，交由 check 判 ❌。
function safeMeta(kind: string): ProcessKindMeta | null {
  try {
    return getProcessKindMeta(kind);
  } catch {
    return null;
  }
}

function main(): void {
  const meta = (kind: string): ProcessKindMeta => {
    const m = safeMeta(kind);
    if (!m) throw new Error(`getProcessKindMeta(${kind}) 抛错`);
    return m;
  };

  // ── A 组：getProcessKindMeta（mcp__ 分裂 + 图标表 + 标签）──
  console.log('\n[A] getProcessKindMeta：server 专属图标 + MCP_<server> 标签');
  const mGitea = meta('tool:mcp__gitea__list_issues');
  check('A1 gitea 图标 🍵', mGitea.icon === '🍵', `icon=${mGitea.icon}`);
  check('A2 gitea 标签 MCP_gitea', mGitea.label === 'MCP_gitea', `label=${mGitea.label}`);
  check('A3 gitea 色仍为 C.mcp #73daca', mGitea.color === '#73daca', `color=${mGitea.color}`);
  const mGithub = meta('tool:mcp__github__search_repositories');
  check('A4 github 🐙 + MCP_github', mGithub.icon === '🐙' && mGithub.label === 'MCP_github',
    `icon=${mGithub.icon} label=${mGithub.label}`);
  check('A5 大小写 mcp__Gitea__x → 🍵（小写化命中）', meta('tool:mcp__Gitea__x').icon === '🍵');
  check('A6 包含 mcp__my-gitea__x → 🍵', meta('tool:mcp__my-gitea__x').icon === '🍵');
  check('A7 包含 mcp__github-mirror__x → 🐙', meta('tool:mcp__github-mirror__x').icon === '🐙');
  const probe = (kind: string): string => meta(kind).icon;
  check('A8 gitee → 🔴', probe('tool:mcp__gitee__get_repo') === '🔴');
  check('A9 gitlab → 🦊', probe('tool:mcp__gitlab__create_mr') === '🦊');
  check('A10 atomgit → ⚛️', probe('tool:mcp__atomgit__x') === '⚛️');
  check('A11 coding → 🐧', probe('tool:mcp__coding__x') === '🐧');
  check('A12 bitbucket → 🪣', probe('tool:mcp__bitbucket__x') === '🪣');
  check('A13 codeberg → 🏔️', probe('tool:mcp__codeberg__x') === '🏔️');
  check('A14 forgejo → 🔨', probe('tool:mcp__forgejo__x') === '🔨');
  check('A15 gogs → 🐹', probe('tool:mcp__gogs__x') === '🐹');
  check('A16 gitcode → 🔷', probe('tool:mcp__gitcode__x') === '🔷');
  check('A17 codeup → ☁️', probe('tool:mcp__codeup__x') === '☁️');
  const mWebReader = meta('tool:mcp__web_reader__webReader');
  check('A18 未命中 web_reader → 🔌 + MCP_web_reader（含单下划线 server 按首个 __ 切分）',
    mWebReader.icon === '🔌' && mWebReader.label === 'MCP_web_reader',
    `icon=${mWebReader.icon} label=${mWebReader.label}`);
  const mMalformed = safeMeta('tool:mcp__foo');
  check('A19 畸形 mcp__foo → 🔌 + MCP_foo 不抛错',
    mMalformed !== null && mMalformed.icon === '🔌' && mMalformed.label === 'MCP_foo',
    mMalformed ? `icon=${mMalformed.icon} label=${mMalformed.label}` : '抛错');
  const mRead = meta('tool:Read');
  check('A20 回归 Read → 📂读取', mRead.icon === '📂' && mRead.label === '读取');
  const mSkill = meta('tool:Skill');
  check('A21 回归 Skill → ✨技能', mSkill.icon === '✨' && mSkill.label === '技能');
  const mBash = meta('tool:Bash');
  check('A22 回归 Bash → ⌨️执行命令', mBash.icon === '⌨️' && mBash.label === '执行命令');
  const mScan = meta('tool:mcp_scan_registry');
  check('A23 回归 mcp_scan_registry（单下划线非 mcp__ 前缀）→ ⚙️ + 原名',
    mScan.icon === '⚙️' && mScan.label === 'mcp_scan_registry',
    `icon=${mScan.icon} label=${mScan.label}`);

  // ── B 组：summarizeToolUse（mcp__ 前缀 → 工具名段）──
  console.log('\n[B] summarizeToolUse：mcp__ 前缀返回工具名段');
  const s1 = summarizeToolUse(JSON.stringify({ name: 'mcp__gitea__list_issues', input: {} }));
  check('B1 mcp__gitea__list_issues → list_issues', s1 === 'list_issues', `got=${s1}`);
  const s2 = summarizeToolUse(JSON.stringify({ name: 'mcp__foo', input: {} }));
  check('B2 畸形 mcp__foo → \'\'', s2 === '', `got=${s2}`);
  const s3 = summarizeToolUse(JSON.stringify({ name: 'mcp__web_reader__webReader', input: {} }));
  check('B3 mcp__web_reader__webReader → webReader', s3 === 'webReader', `got=${s3}`);
  const s4 = summarizeToolUse(JSON.stringify({ name: 'Bash', input: { command: 'npm run build\necho hi' } }));
  check('B4 回归 Bash 首行 → npm run build', s4 === 'npm run build', `got=${s4}`);
  const s5 = summarizeToolUse(JSON.stringify({ name: 'Skill', input: { name: 'design' } }));
  check('B5 回归 Skill 技能名 → design', s5 === 'design', `got=${s5}`);

  // ── C 组：源码静态断言（读源文本，钉表与消费方渲染点）──
  console.log('\n[C] 源码静态断言：MCP_SERVER_ICONS 12 键 + ToolCallBlock 渲染点');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'utils', 'process-kind.ts'), 'utf8');
  check('C1 process-kind.ts 声明 MCP_SERVER_ICONS', source.includes('MCP_SERVER_ICONS'));
  const keys = ['github', 'gitea', 'gitee', 'gitlab', 'gitcode', 'atomgit', 'codeup', 'coding',
    'bitbucket', 'codeberg', 'forgejo', 'gogs'];
  for (const key of keys) {
    check(`C2-${key} 表含键 ${key}`, new RegExp(`\\b${key}\\s*:`).test(source));
  }
  const vue = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'components', 'chat', 'ToolCallBlock.vue'), 'utf8');
  check('C3 ToolCallBlock.vue 仍渲染 meta.icon', vue.includes('meta.icon'));
  check('C4 ToolCallBlock.vue 仍渲染 meta.label', vue.includes('meta.label'));

  // ── D 组：mcpServerIcon 直测（已导出）──
  console.log('\n[D] mcpServerIcon 直测');
  check('D1 Gitea主 → 🍵（小写化+包含命中）', mcpServerIcon('Gitea主') === '🍵', `got=${mcpServerIcon('Gitea主')}`);
  check('D2 web_reader → 🔌（未命中回退）', mcpServerIcon('web_reader') === '🔌');
  let d3 = '';
  try { d3 = mcpServerIcon(''); } catch (e) { d3 = `THROW:${String(e)}`; }
  check('D3 空串 → 🔌 不抛错', d3 === '🔌', `got=${d3}`);

  // ── 汇总 ──
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main();
