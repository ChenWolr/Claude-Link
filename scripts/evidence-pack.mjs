// scripts/evidence-pack.mjs
// review-v9 §7：正式验收证据包。每次执行发布级验收时，在
// $CLAUDE_LINK_CACHE_ROOT/claude-link/evidence/<run-id>/ 固化：输入、输出、版本与工作树状态。
//
// 用法：
//   node scripts/evidence-pack.mjs                        # 默认集：typecheck + selftest:static + 矩阵门禁
//   node scripts/evidence-pack.mjs -- "npm run typecheck" "npm run test:cdp"
//   （-- 后的命令依次执行，stdout/stderr 分别落盘；任一非零退出 → 汇总非零退出）
//
// 产物（review-v9 §7 清单）：
//   metadata.json / stdout-<n>-<name>.txt / command-verification.json / baseline.json /
//   git-head.txt / git-diff-name-status.txt
//
// 脱敏：输出与复制文件中出现的用户主目录路径替换为 %USER_HOME%，sk-/token 形态串替换为
// %REDACTED%。不保存 API key、完整 env、加密 store 内容或会话正文。

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EVIDENCE_ROOT = 'D:/software/Cache/claude-link/evidence';
const RUN_ID = `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
const OUT_DIR = path.join(EVIDENCE_ROOT, RUN_ID);

const HOME_DIRS = [process.env.USERPROFILE, process.env.HOME, os.homedir()]
  .filter(Boolean).map(String)
  .filter((d, i, a) => a.indexOf(d) === i)
  .sort((a, b) => b.length - a.length);

function redact(text) {
  let out = String(text);
  for (const home of HOME_DIRS) out = out.split(home).join('%USER_HOME%');
  out = out.replace(/sk-[a-zA-Z0-9_-]{16,}/g, '%REDACTED%');
  out = out.replace(/(ANTHROPIC_(?:API_KEY|AUTH_TOKEN)\s*[=:]\s*)\S+/gi, '$1%REDACTED%');
  return out;
}

function safeName(s) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '') || 'cmd';
}

async function main() {
  const argIdx = process.argv.indexOf('--');
  const commands = argIdx >= 0
    ? process.argv.slice(argIdx + 1)
    : [
        'npm run typecheck',
        'npm run selftest:static',
        'npx tsx scripts/claude-code-command-matrix.ts --require-no-unexplained-gap --require-no-unverified-command --require-behavioral-coverage --require-behavioral-coverage-full',
      ];

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`evidence runId=${RUN_ID}`);
  console.log(`dir=${OUT_DIR}`);

  // ── metadata（先写骨架，命令跑完补 versions/end）──
  const metadata = {
    runId: RUN_ID,
    startedAt: new Date().toISOString(),
    commands,
    fixtureRoot: 'D:/software/Cache/claude-link/e2e',
    settingsSources: ['user', 'project', 'local'],
  };
  try {
    metadata.gitHead = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const status = execSync('git status --porcelain', { encoding: 'utf8' });
    metadata.workingTreeDirty = status.trim().length > 0;
    fs.writeFileSync(path.join(OUT_DIR, 'git-head.txt'), metadata.gitHead + '\n', 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'git-diff-name-status.txt'),
      redact(execSync('git diff --name-status', { encoding: 'utf8' })), 'utf8');
  } catch {
    metadata.gitHead = '(git 不可用)';
    metadata.workingTreeDirty = null;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    metadata.electronAppVersion = pkg.version;
    const sdkPkg = JSON.parse(fs.readFileSync('node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8'));
    metadata.agentSdkVersion = sdkPkg.version;
  } catch { /* 缺失如实留空 */ }

  // ── 执行命令并落盘输出 ──
  const results = [];
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    const outFile = path.join(OUT_DIR, `stdout-${i}-${safeName(cmd)}.txt`);
    console.log(`[${i + 1}/${commands.length}] ${cmd}`);
    const r = spawnSync(cmd, { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env });
    fs.writeFileSync(outFile,
      `$ ${cmd}\nexit=${r.status}\n\n--- stdout ---\n${redact(r.stdout ?? '')}\n--- stderr ---\n${redact(r.stderr ?? '')}`,
      'utf8');
    results.push({ cmd, exit: r.status, outFile: path.basename(outFile) });
    console.log(`  exit=${r.status} → ${path.basename(outFile)}`);
  }

  // ── 复制 manifest 工件（若存在）──
  const artifacts = [
    ['D:/software/Cache/claude-link/command-verification.json', 'command-verification.json'],
    ['D:/software/Cache/claude-link/command-baseline.json', 'baseline.json'],
  ];
  for (const [src, dest] of artifacts) {
    if (fs.existsSync(src)) {
      fs.writeFileSync(path.join(OUT_DIR, dest), redact(fs.readFileSync(src, 'utf8')), 'utf8');
      console.log(`  复制 ${dest}`);
    } else {
      console.log(`  ⚠ 缺少 ${src}（先运行对应验收命令再打包）`);
    }
  }

  // baseline 里的版本信息补进 metadata。
  try {
    const b = JSON.parse(fs.readFileSync('D:/software/Cache/claude-link/command-baseline.json', 'utf8'));
    metadata.claudeCodeVersion = b?.environment?.claudeCodeVersion;
    if (!metadata.agentSdkVersion) metadata.agentSdkVersion = b?.environment?.sdkVersion;
  } catch { /* 已尽力 */ }

  metadata.finishedAt = new Date().toISOString();
  metadata.results = results;
  fs.writeFileSync(path.join(OUT_DIR, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
  console.log(`metadata.json 写入完成（gitHead=${metadata.gitHead}, dirty=${metadata.workingTreeDirty}, cc=${metadata.claudeCodeVersion ?? '?'}, sdk=${metadata.agentSdkVersion ?? '?'}）`);

  const bad = results.filter((r) => r.exit !== 0);
  if (bad.length > 0) {
    console.error(`\n${bad.length} 个命令非零退出（证据包保留于 ${OUT_DIR}）：${bad.map((r) => `${r.cmd}(exit=${r.exit})`).join('; ')}`);
    process.exit(1);
  }
  console.log('\n全部命令 exit 0；证据包完整。');
}

main().catch((e) => {
  console.error('evidence-pack fatal:', e.message);
  process.exit(1);
});
