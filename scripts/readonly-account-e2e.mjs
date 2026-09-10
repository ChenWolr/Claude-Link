// scripts/readonly-account-e2e.mjs
// review-v10 §4：受限非管理员账户 + 真实 DENY ACL 下，完整 Electron + Agent SDK + Claude Code
// 链路的 /init 只读目录验收——编排脚本（发布级，无 SKIP）。
//
// 用法：npm run test:cdp:readonly-e2e   （或 node scripts/readonly-account-e2e.mjs [--purge] [--keep-app]）
//
// 步骤（review-v10 §4.4）：
//   1. 前置：管理员权限、9224 端口空闲、CLI/依赖就位。
//   2. 专用非管理员账户 ClaudeLinkROE2E（存在则复用；--purge 时结束后删除账户与 profile）。
//   3. ACL 夹具 $CLAUDE_LINK_CACHE_ROOT/claude-link/readonly-e2e/<run-id>/cwd（RX only），
//      并以同一账户运行最小 Node 写入预检——必须 EPERM/EACCES（§4.5-2）。
//   4. 受控凭据 bootstrap：该账户自己的 ~/.claude/settings.json env 块 + .claude.json 工作区
//      信任标记（等价首次交互式接受信任对话框）；不复制任何加密 store / 记忆 / 用户数据。
//   5. npm run build 后以该账户启动 Electron（CDP 9224，--inspect 不开）。
//   6. 运行 scripts/cdp-readonly-e2e.mjs（真实 UI /init + 四层断言）。
//   7. 清理：停止该实例 Electron（含子进程）、删除 <run-id> 夹具；账户默认保留供复用。
//      任何清理失败 → 报错并保留路径，不静默。
//
// 退出协议：0 全过 / 1 失败（保留现场路径）/ 2 前置不满足（明确「无法执行」）。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const USER = 'ClaudeLinkROE2E';
const PASS = 'ClaudeLink!RO2026';
const RO_ROOT = 'D:/software/Cache/claude-link/readonly-e2e';
const REPO = 'D:/software/code/claude-link';
const CLI_EXE = 'D:/software/Cache/npm-global/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const CDP_PORT = 9224;
const PURGE = process.argv.includes('--purge');
const KEEP_APP = process.argv.includes('--keep-app');

const RUN_ID = `ro-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
const FIXTURE = path.join(RO_ROOT, RUN_ID);
const RO_CWD = path.join(FIXTURE, 'cwd');
const USER_HOME = `C:/Users/${USER}`;

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
function ps(script) {
  return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
}
function fail(msg, keepPaths) {
  console.error(`\n失败${keepPaths ? `（现场保留：${keepPaths}）` : ''}：${msg}`);
  process.exit(1);
}

async function waitForCdp(timeoutS) {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  console.log('=== Read-only Account E2E 编排（review-v10 §4：受限账户完整链）===');
  log(`runId=${RUN_ID} fixture=${FIXTURE}`);

  // ── 1. 前置 ──
  const isAdmin = ps(`([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`).trim() === 'True';
  if (!isAdmin) { console.error('前置条件不满足：需要管理员权限创建测试账户/ACL。无法执行，exit 2。'); process.exit(2); }
  if (!fs.existsSync(CLI_EXE)) { console.error(`前置条件不满足：CLI 不存在 ${CLI_EXE}。无法执行，exit 2。`); process.exit(2); }
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (r.ok) { console.error(`前置条件不满足：端口 ${CDP_PORT} 已被占用（先停掉其它实例）。无法执行，exit 2。`); process.exit(2); }
  } catch { /* port free ✓ */ }

  let electronPid = null;
  try {
    // ── 2. 账户（非管理员）──
    const exists = ps(`!!(Get-LocalUser -Name '${USER}' -ErrorAction SilentlyContinue)`).trim() === 'True';
    if (!exists) {
      ps(`New-LocalUser -Name '${USER}' -Password (ConvertTo-SecureString '${PASS}' -AsPlainText -Force) -FullName 'Claude Link RO E2E' -Description 'Non-admin readonly-dir E2E test account' -PasswordNeverExpires -ErrorAction Stop | Out-Null`);
      log(`账户 ${USER} 已创建（非管理员）`);
    } else {
      log(`账户 ${USER} 已存在，复用`);
    }
    const inAdmin = ps(`(net localgroup Administrators) -match '${USER}'`).trim() === 'True';
    if (inAdmin) fail(`${USER} 在 Administrators 组中——必须是非管理员账户`);

    // ── 3. ACL 夹具 + 同账户 Node EPERM 预检（同时加载 profile）──
    fs.mkdirSync(RO_CWD, { recursive: true });
    fs.writeFileSync(path.join(RO_CWD, 'README.md'), '# readonly fixture\n\nMinimal read-only workspace for restricted-account /init E2E.\n', 'utf8');
    ps(`icacls '${RO_CWD.replace(/\//g, '\\')}' /inheritance:r /grant 'Administrators:(OI)(CI)F' /grant 'SYSTEM:(OI)(CI)F' /grant '${USER}:(OI)(CI)RX' | Out-Null`);
    log(`ACL 夹具就绪（${USER}: RX only）`);
    fs.writeFileSync(path.join(RO_ROOT, 'precheck.mjs'), PRECHECK_SRC, 'utf8');
    ps(`$cred = New-Object System.Management.Automation.PSCredential('${USER}',(ConvertTo-SecureString '${PASS}' -AsPlainText -Force)); $p = Start-Process -FilePath 'node.exe' -ArgumentList '"${path.join(RO_ROOT, 'precheck.mjs').replace(/\//g, '\\')}"','"${RO_CWD.replace(/\//g, '\\')}"' -Credential $cred -LoadUserProfile -RedirectStandardOutput '${path.join(RO_ROOT, 'precheck-out.txt').replace(/\//g, '\\')}' -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`);
    const precheckOut = fs.readFileSync(path.join(RO_ROOT, 'precheck-out.txt'), 'utf8');
    log(`EPERM 预检（同一账户）：${precheckOut.trim().split('\n').join(' | ')}`);
    if (!/write-code=(EPERM|EACCES)/.test(precheckOut)) fail(`同账户 Node 写入预检未返回 EPERM/EACCES：${precheckOut}`);

    // ── 4. 受控 bootstrap：env 块 + 工作区信任（该账户自己的 profile，不复制加密 store）──
    const adminSettings = JSON.parse(fs.readFileSync('C:/Users/Administrator/.claude/settings.json', 'utf8'));
    fs.mkdirSync(path.join(USER_HOME, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(USER_HOME, '.claude', 'settings.json'), JSON.stringify({ env: adminSettings.env }, null, 2), 'utf8');
    const claudeJsonPath = path.join(USER_HOME, '.claude.json');
    let cj = {};
    try { cj = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch { /* fresh */ }
    cj.projects = cj.projects || {};
    const bs = String.fromCharCode(92);
    for (const p of [REPO, RO_CWD]) {
      const key = p.replace(/\//g, bs);
      cj.projects[key] = Object.assign({}, cj.projects[key], { hasTrustDialogAccepted: true });
    }
    fs.writeFileSync(claudeJsonPath, JSON.stringify(cj, null, 2), 'utf8');
    log('受控 bootstrap 完成（该账户 settings.json env 块 + 工作区信任标记）');

    // ── 5. 构建 + 以该账户启动 Electron ──
    const build = spawnSync('npm', ['run', 'build'], { shell: true, encoding: 'utf8', cwd: REPO });
    if (build.status !== 0) fail(`npm run build 失败：${(build.stderr || '').slice(0, 200)}`);
    log('应用已构建（out/）');
    // 注意：-RedirectStandardOutput/Error 必须带上——否则 electron 子进程继承 powershell 的
    // stdio 管道，execFileSync 会等到 electron 退出才返回（编排卡死）。
    const BS = String.fromCharCode(92);
    const toWin = (p) => p.split('/').join(BS);
    const electronExe = toWin(path.join(REPO, 'node_modules/electron/dist/electron.exe'));
    const roOut = toWin(path.join(RO_ROOT, 'electron-ro-out.log'));
    const roErr = toWin(path.join(RO_ROOT, 'electron-ro-err.log'));
    const roPidFile = toWin(path.join(RO_ROOT, 'electron-ro-pid.txt'));
    const pidOut = ps(`$cred = New-Object System.Management.Automation.PSCredential('${USER}',(ConvertTo-SecureString '${PASS}' -AsPlainText -Force)); $p = Start-Process -FilePath '${electronExe}' -ArgumentList '.','--remote-debugging-port=${CDP_PORT}' -WorkingDirectory '${toWin(REPO)}' -Credential $cred -LoadUserProfile -PassThru -WindowStyle Hidden -RedirectStandardOutput '${roOut}' -RedirectStandardError '${roErr}'; $p.Id | Out-File '${roPidFile}' -Encoding ascii; $p.Id`);
    electronPid = Number(pidOut.trim());
    log(`受限账户 Electron 已启动（pid=${electronPid}，CDP ${CDP_PORT}）`);
    if (!(await waitForCdp(30))) fail('受限账户 Electron 的 CDP 30s 未就绪', FIXTURE);

    // ── 6. 四层断言（真实 UI /init）──
    const e2e = spawnSync('node', [path.join(REPO, 'scripts/cdp-readonly-e2e.mjs'), '--port', String(CDP_PORT), '--cwd', RO_CWD.replace(/\\/g, '/'), '--cli-exe', CLI_EXE], { encoding: 'utf8', cwd: REPO });
    process.stdout.write(e2e.stdout ?? '');
    process.stderr.write(e2e.stderr ?? '');
    log(`cdp-readonly-e2e 退出码=${e2e.status}`);
    if (e2e.status !== 0) fail(`四层断言失败（exit=${e2e.status}）`, FIXTURE);
  } finally {
    // ── 7. 清理（失败保留现场路径）──
    if (electronPid != null && !KEEP_APP) {
      try { execFileSync('taskkill', ['/PID', String(electronPid), '/T', '/F'], { stdio: 'ignore' }); log(`Electron pid=${electronPid} 已停止（含子进程）`); }
      catch (e) { console.error(`⚠ 停止 Electron pid=${electronPid} 失败：${e.message}——请手动清理`); }
    }
    if (PURGE) {
      try {
        ps(`$prof = Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -eq 'C:\\Users\\${USER}' }; if ($prof) { $prof | Remove-CimInstance -ErrorAction Stop }; Remove-LocalUser -Name '${USER}' -ErrorAction Stop`);
        log(`--purge：账户 ${USER} 与 profile 已删除`);
      } catch (e) {
        console.error(`⚠ 账户/profile 清理失败（保留）：${e.message.slice(0, 150)}`);
        process.exitCode = 1;
      }
    }
  }

  console.log(`\n受限账户只读完整链验收通过（runId=${RUN_ID}；账户${PURGE ? '已删除' : '保留供复用（--purge 可删）'}）。`);
  process.exit(process.exitCode ?? 0);
}

const PRECHECK_SRC = `// 以受限账户运行的最小写入检查（review-v10 §4.4-3）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const cwd = process.argv[2];
console.log('user=' + os.userInfo().username);
console.log('list-ok entries=' + fs.readdirSync(cwd).join(','));
try {
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'should-fail');
  console.log('WRITE-UNEXPECTEDLY-SUCCEEDED');
  process.exit(2);
} catch (e) {
  console.log('write-code=' + e.code);
  process.exit(e.code === 'EPERM' || e.code === 'EACCES' ? 0 : 3);
}
`;

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
