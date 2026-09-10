// p1-09-subdir-command-probe.ts
// P1-9 实施第一步（计划要求）：真实 SDK probe 确证「子目录命令」在系统侧的 name 形态
// （ns:cmd 冒号拼接或其它），据此确定 scanCommandFiles 证据键的拼接分隔符。
// 手法对齐 claude-code-command-baseline.ts：本地 claude.exe + 临时 cwd + /usage（零花费、不走模型）。
//
// 运行：npx tsx scripts/p1-09-subdir-command-probe.ts
// 结果落盘：$CLAUDE_LINK_CACHE_ROOT/claude-link/p1-09-subdir-probe.json
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const OUT_FILE = 'D:/software/Cache/claude-link/p1-09-subdir-probe.json';
const EXE = 'D:/software/Cache/npm-global/node_modules/@anthropic-ai/claude-code/bin/claude.exe';

const cwd = mkdtempSync(path.join(tmpdir(), 'p1-09-probe-'));
mkdirSync(path.join(cwd, '.claude', 'commands', 'devtool'), { recursive: true });
writeFileSync(
  path.join(cwd, '.claude', 'commands', 'topcmd.md'),
  '---\ndescription: P1-9 顶层探针命令\n---\nnoop\n',
);
writeFileSync(
  path.join(cwd, '.claude', 'commands', 'devtool', 'buildcmd.md'),
  '---\ndescription: P1-9 子目录探针命令\n---\nnoop\n',
);

async function main(): Promise<void> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const q = sdk.query({
    prompt: '/usage',
    options: {
      cwd,
      pathToClaudeCodeExecutable: EXE,
      maxTurns: 1,
    },
  });
  let slashCommands: string[] = [];
  let probeNames: string[] = [];
  try {
    const consume = (async () => {
      for await (const msg of q as AsyncIterable<Record<string, unknown>>) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          slashCommands = Array.isArray(msg.slash_commands) ? (msg.slash_commands as string[]) : [];
        } else if (msg.type === 'result') {
          break;
        }
      }
    })();
    const raw = (await q.supportedCommands()) as Array<{ name?: string }>;
    probeNames = raw.map((c) => (typeof c.name === 'string' ? c.name : ''));
    await consume.catch(() => undefined);
  } finally {
    try { q.close(); } catch { /* 已关闭 */ }
  }
  const result = {
    cwd,
    slashCommandsContainingMarker: slashCommands.filter((n) => /cmd/i.test(n)),
    probeNamesContainingMarker: probeNames.filter((n) => /cmd/i.test(n)),
    allSlashCommandCount: slashCommands.length,
    allProbeCount: probeNames.length,
  };
  console.log('P1-9 PROBE RESULT ' + JSON.stringify(result, null, 2));
  try { writeFileSync(OUT_FILE, JSON.stringify(result, null, 2)); } catch { /* stdout 已有证据 */ }
}

main()
  .catch((err) => {
    console.error('P1-9 probe 失败:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* 缓存目录残留无害 */ }
  });
