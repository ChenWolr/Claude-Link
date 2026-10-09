// scripts/release-gate.ts
// 发版门禁（一条命令两段）：把「本地构建产物一致性」与「GitHub 远端资产正确性」钉进发版流程，
// 堵两个缺口：三处版本一致性（package.json / Release tag / latest.yml）无人守门；更新说明由
// 用户手上的旧版应用渲染、真实用户视角滞后（post 相用上一版 tag 的源码当场回放 atom 内容）。
// 用法（三态）：
//   1) pre（默认）   npx tsx scripts/release-gate.ts
//       G1 工作树干净（脏树会以 -dirty 进包）
//       G2 tag v<version> 指向 HEAD
//       G3 app.asar 构建指纹含当前 HEAD rev 且无 -dirty 后缀
//       G4 归一链（normalizeReleaseNotes）已编入 asar
//       G5 latest.yml 与安装包 sha512·size·version·path 逐项一致（防 yml 与 exe 来自两次构建）
//       G6 win-unpacked\claude-link.exe 与 setup.exe 产物存在
//   2) --selftest    npx tsx scripts/release-gate.ts --selftest
//       开发期自检：G1 放宽为 WARN（允许脏树）、G2 跳过（SKIP）、G3 允许 -dirty（降 WARN，仍要求含 rev）。
//   3) --post        npx tsx scripts/release-gate.ts --post [--tag vX.Y.Z] [--proxy <url>]
//       上传资产后远端三查：P1 releases/latest 指向 / P2 远端 latest.yml 与本地 version·sha512·size 一致 /
//       P3 releases.atom 首 entry 校验 + 用上一版 tag 检出的旧源码回放真实 atom 更新说明，当场预览
//       「旧版用户将看到的更新说明」。--tag 缺省 v${package.json version}，--proxy 缺省读 CLAUDE_LINK_PROXY → HTTPS_PROXY，均未设则仅直连。
// 发版顺序：bump package.json version → commit → git tag v<version>（在发版分支打 tag）→
//           npm run release:gate（内含 package:win 构建 + 本脚本 pre 相 + 更新全链 E2E）→
//           GitHub 建 Release 上传 setup.exe 与 latest.yml → npm run release:gate:post。
// 网络策略（post 相）：github.com 页面直连通常可达，releases/download 会 302 到
//   objects.githubusercontent.com 等重定向域（直连不通）——因此每一跳独立走「直连 5s → 代理 CONNECT 隧道」，
//   HTTP 4xx/5xx 不算网络层失败（是逻辑结果），只有超时/连接错误才落代理。
// 退出码：0 全绿；1 门禁 fail；2 环境问题（区别于逻辑 fail）：直连与代理均网络不可达 / 代理 URL 非法 / 临时目录不可创建或不可写。
// 非 selftest 契约脚本，不登记 scripts/selftest-static-list.txt。
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import type { TLSSocket } from 'node:tls';

type ReleaseNotesModule = typeof import('../src/shared/release-notes');

// ---------- 参数与公共状态 ----------

const argv = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const isPost = argv.includes('--post');
const selftest = argv.includes('--selftest'); // 仅 pre 相生效
const tagArg = argValue('--tag');
const proxyArg = argValue('--proxy');

const ROOT = resolve(__dirname, '..');
const DIST = join(ROOT, 'dist-electron');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
const pkgVersion = pkg.version;

const GITHUB_LATEST = 'https://github.com/ChenWolr/Claude-Link/releases/latest';
const GITHUB_ATOM = 'https://github.com/ChenWolr/Claude-Link/releases.atom';
const githubAssetYml = (tag: string): string =>
  `https://github.com/ChenWolr/Claude-Link/releases/download/${tag}/latest.yml`;
const CACHE_DIR = process.env.CLAUDE_LINK_CACHE_DIR || join(tmpdir(), 'claude-link-release-gate');

let pass = 0;
let fail = 0;
let warnCount = 0;
let skipCount = 0;
type Gate = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
function report(id: string, r: Gate, msg: string): void {
  if (r === 'PASS') {
    pass++;
    console.log(`✅ ${id} ${msg}`);
  } else if (r === 'FAIL') {
    fail++;
    console.log(`❌ ${id} ${msg}`);
  } else if (r === 'WARN') {
    warnCount++; // WARN 不计 fail
    console.log(`⚠ ${id} ${msg}（WARN）`);
  } else {
    skipCount++;
    console.log(`⏭ ${id} ${msg}（SKIP）`);
  }
}
function summary(): void {
  console.log(`\n结果：${pass} 通过 / ${fail} 失败 / ${warnCount} 警告 / ${skipCount} 跳过`);
  if (fail > 0) process.exit(1);
}
function gate(id: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    report(id, 'FAIL', `执行异常：${(e as Error).message}`);
  }
}
async function gateAsync(id: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    report(id, 'FAIL', `执行异常：${(e as Error).message}`);
  }
}
function sh(cmd: string): string {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
}

// ---------- latest.yml 手写正则解析（勿引 yaml 依赖；形态与 electron-builder 产物一致） ----------

interface LatestYml {
  version?: string;
  path?: string;
  sha512?: string;
  size?: number; // files 条目内缩进 4 空格的 size
}
function parseLatestYml(raw: string): LatestYml {
  const t = raw.replace(/\r\n?/g, '\n'); // CRLF 归一，防 `(\d+)$` 匹配不到行尾
  const sizeRaw = /^ {4}size: (\d+)$/m.exec(t)?.[1];
  return {
    version: /^version: (.+)$/m.exec(t)?.[1]?.trim(),
    path: /^path: (.+)$/m.exec(t)?.[1]?.trim(),
    sha512: /^sha512: (.+)$/m.exec(t)?.[1]?.trim(),
    size: sizeRaw !== undefined ? Number(sizeRaw) : undefined,
  };
}

// ---------- pre 相：G1-G6 六项静态断言 ----------

function gateG1(): void {
  const out = sh('git status --porcelain');
  if (out === '') {
    report('G1', 'PASS', '工作树干净');
    return;
  }
  const files = out.split('\n');
  const head = files.slice(0, 3).join('；');
  if (selftest) {
    report('G1', 'WARN', `工作树有 ${files.length} 个脏文件（selftest 放宽；示例：${head}）`);
  } else {
    report('G1', 'FAIL', `工作树脏（${files.length} 个文件）：脏树会以 -dirty 进包，先提交再 gate（示例：${head}）`);
  }
}

function gateG2(): void {
  if (selftest) {
    report('G2', 'SKIP', 'selftest 模式跳过 tag 检查（开发分支通常无发版 tag）');
    return;
  }
  const want = `v${pkgVersion}`;
  const out = sh('git tag --points-at HEAD');
  const tags = out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (tags.includes(want)) {
    report('G2', 'PASS', `tag ${want} 指向 HEAD`);
  } else {
    report(
      'G2',
      'FAIL',
      `HEAD 上没有 tag ${want}（git tag --points-at HEAD 实际：${tags.join(', ') || '无'}）。` +
        '发版顺序：bump → commit → git tag v<version> → release:gate → 上传资产 → release:gate:post',
    );
  }
}

function gateG3(asarBuf: string): void {
  const rev = sh('git rev-parse --short HEAD');
  const dirtyMark = `${rev}-dirty`;
  if (!asarBuf.includes(rev)) {
    // selftest 下仍要求含 rev（否则检不出任何构建指纹）
    report('G3', 'FAIL', `app.asar 不含当前 HEAD 构建指纹 ${rev}——产物不是本 HEAD 构建，先 npm run package:win`);
  } else if (asarBuf.includes(dirtyMark)) {
    if (selftest) {
      report('G3', 'WARN', `app.asar 构建指纹为 ${dirtyMark}（开发期自检放宽；正式发版须干净树重打包）`);
    } else {
      report('G3', 'FAIL', `app.asar 构建指纹为 ${dirtyMark}——脏树构建进包了，提交后重打包（npm run package:win）`);
    }
  } else {
    report('G3', 'PASS', `app.asar 构建指纹 ${rev}（无 -dirty）`);
  }
}

function gateG4(asarBuf: string): void {
  if (asarBuf.includes('normalizeReleaseNotes')) {
    report('G4', 'PASS', 'asar 已含 normalizeReleaseNotes 归一链');
  } else {
    report('G4', 'FAIL', 'asar 未含 shared 归一链（normalizeReleaseNotes 字符串缺失），检查构建是否带上最新源码');
  }
}

function gateG5(): void {
  const ymlPath = join(DIST, 'latest.yml');
  if (!existsSync(ymlPath)) {
    report('G5', 'FAIL', `缺 ${ymlPath}——先 npm run package:win`);
    return;
  }
  const yml = parseLatestYml(readFileSync(ymlPath, 'utf8'));
  const exeName = `claude-link-${pkgVersion}-setup.exe`;
  const exePath = join(DIST, exeName);
  const problems: string[] = [];
  if (yml.version !== pkgVersion) {
    problems.push(`version: yml=${yml.version ?? '(缺失)'} vs package.json=${pkgVersion}`);
  }
  if (yml.path !== exeName) {
    problems.push(`path: yml=${yml.path ?? '(缺失)'} vs 期望=${exeName}`);
  }
  if (yml.sha512 === undefined) problems.push('sha512: yml 缺顶层 sha512 字段');
  if (yml.size === undefined) problems.push('size: yml 缺 files 条目 size 字段（4 空格缩进形态）');
  if (!existsSync(exePath)) {
    problems.push(`安装包不存在：${exePath}`);
  } else {
    // 与 scripts/serve-update-feed.mjs 同款算法：sha512 base64 + statSync().size
    const actualSha = createHash('sha512').update(readFileSync(exePath)).digest('base64');
    const actualSize = statSync(exePath).size;
    if (yml.sha512 !== actualSha) {
      problems.push(`sha512: yml=${yml.sha512 ?? '(缺失)'} vs 现算=${actualSha}`);
    }
    if (yml.size !== actualSize) {
      problems.push(`size: yml=${yml.size ?? '(缺失)'} vs 现算=${actualSize}`);
    }
  }
  if (problems.length === 0) {
    report('G5', 'PASS', `latest.yml 与 ${exeName} 一致（version/path/sha512/size 逐项相符，同一份构建）`);
  } else {
    report(
      'G5',
      'FAIL',
      `latest.yml 与安装包不一致（「yml 与 exe 来自两次构建」典型症状）：\n      ${problems.join('\n      ')}`,
    );
  }
}

function gateG6(): void {
  const unpackedExe = join(DIST, 'win-unpacked', 'claude-link.exe');
  const setupExe = join(DIST, `claude-link-${pkgVersion}-setup.exe`);
  const missing: string[] = [];
  if (!existsSync(unpackedExe)) missing.push(unpackedExe);
  if (!existsSync(setupExe)) missing.push(setupExe);
  if (missing.length === 0) {
    report('G6', 'PASS', '产物齐备（win-unpacked/claude-link.exe 与 setup.exe）');
  } else {
    report('G6', 'FAIL', `产物缺失：${missing.join('；')}`);
  }
}

function preMain(): void {
  console.log(
    `\n=== PRE：本地构建门禁（package.json version=${pkgVersion}${selftest ? '，selftest 模式（G1 WARN / G2 SKIP / G3 允许 -dirty）' : ''}） ===`,
  );
  gate('G1', gateG1);
  gate('G2', gateG2);
  const asarPath = join(DIST, 'win-unpacked', 'resources', 'app.asar');
  let asarBuf: string | null = null;
  try {
    asarBuf = readFileSync(asarPath).toString('latin1');
  } catch {
    asarBuf = null;
  }
  if (asarBuf === null) {
    report('G3', 'FAIL', `缺 ${asarPath}——先 npm run package:win`);
    report('G4', 'FAIL', `缺 ${asarPath}，asar 无法读取，归一链检查无从谈起`);
  } else {
    const buf = asarBuf;
    gate('G3', () => gateG3(buf));
    gate('G4', () => gateG4(buf));
  }
  gate('G5', gateG5);
  gate('G6', gateG6);
  summary();
}

// ---------- post 相：HTTP 辅助（每跳独立「直连 5s → 代理 CONNECT 隧道」，跟随重定向 ≤5 跳） ----------

interface HttpResult {
  status: number;
  location?: string;
  body: string;
}

async function fetchDirect(url: URL, timeoutMs: number, headers?: Record<string, string>): Promise<HttpResult> {
  // redirect: 'manual'——undici 下 3xx 会作为带 Location 的正常响应返回（非浏览器 opaqueredirect），
  // 由上层逐跳跟随；任何 reject 都是网络层失败（超时/连接错误），HTTP 4xx/5xx 正常 resolve。
  const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, location: res.headers.get('location') ?? undefined, body: await res.text() };
}

/** 原生 http CONNECT 隧道：向代理请求 targetHost:443 的裸 socket。 */
function connectThroughProxy(targetHost: string, proxy: URL, timeoutMs: number): Promise<Socket> {
  return new Promise((resolveP, rejectP) => {
    const req = httpRequest({
      method: 'CONNECT',
      host: proxy.hostname,
      port: proxy.port ? Number(proxy.port) : 80,
      path: `${targetHost}:443`,
      timeout: timeoutMs,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode === 200) {
        // 清 CONNECT 相位的空闲计时器（timeout 选项在 socket 上常驻）：慢代理节点 TLS 握手
        // 超 5s 时它会在中途 destroy socket，表现为「握手前连接被断」——握手预算交给 tlsHandshake 自己的计时。
        socket.setTimeout(0);
        resolveP(socket);
      } else {
        socket.destroy();
        rejectP(new Error(`代理 CONNECT 被拒：HTTP ${res.statusCode}`));
      }
    });
    req.once('timeout', () => req.destroy(new Error(`代理 CONNECT 超时（${timeoutMs}ms）`)));
    req.once('error', rejectP);
    req.end();
  });
}

function tlsHandshake(socket: Socket, servername: string, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolveP, rejectP) => {
    const tlsSocket = tlsConnect({ socket, servername });
    const timer = setTimeout(() => {
      tlsSocket.destroy();
      rejectP(new Error(`TLS 握手超时（${timeoutMs}ms）`));
    }, timeoutMs);
    tlsSocket.once('secureConnect', () => {
      clearTimeout(timer);
      resolveP(tlsSocket);
    });
    tlsSocket.once('error', (e) => {
      clearTimeout(timer);
      rejectP(e);
    });
  });
}

/** 在已建好的 TLS socket 上发 GET（createConnection 让 https.request 直接复用该连接，不重复握手）。 */
function requestOverTls(
  url: URL,
  tlsSocket: TLSSocket,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolveReq, rejectReq) => {
    const req = httpsRequest(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
        createConnection: () => tlsSocket,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', rejectReq);
        res.on('end', () => {
          resolveReq({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.once('timeout', () => req.destroy(new Error(`代理请求响应超时（${timeoutMs}ms）`)));
    req.once('error', rejectReq);
    req.end();
  });
}

async function fetchViaProxy(
  url: URL,
  proxy: URL,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  const socket = await connectThroughProxy(url.hostname, proxy, timeoutMs);
  const tlsSocket = await tlsHandshake(socket, url.hostname, timeoutMs);
  try {
    return await requestOverTls(url, tlsSocket, timeoutMs, headers);
  } finally {
    tlsSocket.destroy();
  }
}

/** 单跳：先直连（5s），网络层失败才落代理；未配代理时直连失败即环境问题 exit 2（区别于逻辑 fail 的 exit 1）。 */
async function fetchSingleHop(
  url: URL,
  opts: { timeoutMs: number; headers?: Record<string, string>; proxy: URL | null },
): Promise<HttpResult> {
  try {
    return await fetchDirect(url, opts.timeoutMs, opts.headers);
  } catch (directErr) {
    if (opts.proxy === null) {
      console.error(
        `❌ 直连不可达（${url.href}）：${(directErr as Error).message}；` +
          '未配置代理——可设 CLAUDE_LINK_PROXY/HTTPS_PROXY 环境变量或用 --proxy 指定代理',
      );
      process.exit(2);
    }
    console.log(`  （直连 ${url.host} 网络层失败：${(directErr as Error).message}；改走代理 ${opts.proxy.href}）`);
    try {
      return await fetchViaProxy(url, opts.proxy, opts.timeoutMs, opts.headers);
    } catch (proxyErr) {
      console.error(`❌ 直连与代理均不可达（${url.href}）：直连=${(directErr as Error).message}；代理=${(proxyErr as Error).message}`);
      console.error(`   请检查代理 ${opts.proxy.href}`);
      process.exit(2);
    }
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** 跟随重定向（≤5 跳），每一跳独立走「直连 → 代理」——github.com 直连可达、302 后的 objects.githubusercontent.com 需代理正靠此。 */
async function fetchText(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; proxy: URL | null },
): Promise<HttpResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    const res = await fetchSingleHop(current, { timeoutMs, headers: opts.headers, proxy: opts.proxy });
    if (REDIRECT_STATUSES.has(res.status)) {
      if (!res.location) throw new Error(`HTTP ${res.status} 无 Location 头，无法跟随重定向`);
      if (hop >= 5) throw new Error(`重定向超过 5 跳（最后停在 ${current.href}）`);
      const next = new URL(res.location, current);
      console.log(`  ↳ ${res.status} → ${next.href}`);
      current = next;
      continue;
    }
    return res;
  }
}

// ---------- post 相：P1-P3 远端三查 ----------

async function gateP1(tag: string, proxy: URL | null): Promise<void> {
  console.log(`→ GET ${GITHUB_LATEST}`);
  const res = await fetchText(GITHUB_LATEST, { headers: { Accept: 'application/json' }, proxy });
  if (res.status !== 200) {
    report('P1', 'FAIL', `releases/latest HTTP ${res.status}（Release 未建或 tag 未推）`);
    return;
  }
  let actual: string | undefined;
  try {
    actual = (JSON.parse(res.body) as { tag_name?: string }).tag_name;
  } catch {
    // 返回 HTML（JSON 解析失败）时从页面兜底提取
    actual =
      /releases\/tag\/(v[\w.+-]+)/.exec(res.body)?.[1] ?? /<title>[^<]*?(v[\w.+-]+)/.exec(res.body)?.[1];
  }
  if (actual === tag) {
    report('P1', 'PASS', `远端 releases/latest 指向 ${tag}`);
  } else {
    report('P1', 'FAIL', `远端 releases/latest 指向 ${actual ?? '(未解析到 tag_name)'}，期望 ${tag}`);
  }
}

async function gateP2(tag: string, proxy: URL | null): Promise<void> {
  const localYmlPath = join(DIST, 'latest.yml');
  if (!existsSync(localYmlPath)) {
    report('P2', 'FAIL', `缺本地 ${localYmlPath}——无比对基准`);
    return;
  }
  const url = githubAssetYml(tag);
  console.log(`→ GET ${url}`);
  const res = await fetchText(url, { proxy }); // 会 302 到对象存储域，逐跳直连/代理跟随
  if (res.status !== 200) {
    report('P2', 'FAIL', `远端 latest.yml HTTP ${res.status}（资产未上传或未就绪）`);
    return;
  }
  const remote = parseLatestYml(res.body);
  const local = parseLatestYml(readFileSync(localYmlPath, 'utf8'));
  const diffs: string[] = []; // releaseDate 不比（每次上传都会变）
  if (remote.version !== local.version) {
    diffs.push(`version: 远端=${remote.version ?? '(缺失)'} vs 本地=${local.version ?? '(缺失)'}`);
  }
  if (remote.sha512 !== local.sha512) {
    diffs.push(`sha512: 远端=${remote.sha512 ?? '(缺失)'} vs 本地=${local.sha512 ?? '(缺失)'}`);
  }
  if (remote.size !== local.size) {
    diffs.push(`size: 远端=${remote.size ?? '(缺失)'} vs 本地=${local.size ?? '(缺失)'}`);
  }
  if (diffs.length === 0) {
    report('P2', 'PASS', `远端 latest.yml 与本地一致（version/sha512/size，releaseDate 不比）`);
  } else {
    report('P2', 'FAIL', `远端资产与本地 dist-electron 不一致（上传的可能不是同一份 yml）：\n      ${diffs.join('\n      ')}`);
  }
}

// XML 实体解码：顺序与 src/shared/release-notes.ts 步骤 11（实体解码段）一致——
// 数字实体（&#xHH; / &#NN;）先，然后命名实体，&amp; 必须最后（防 &amp;lt; 双解成 <）。
function decodeNumericEntity(n: number, entity: string): string {
  if (Number.isNaN(n) || n < 0x20 || n === 0x7f || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return entity;
  try {
    return String.fromCodePoint(n);
  } catch {
    return entity;
  }
}
function decodeXmlEntities(s: string): string {
  let out = s.replace(/&#[xX]([0-9a-fA-F]+);/g, (m, hex: string) => decodeNumericEntity(Number.parseInt(hex, 16), m));
  out = out.replace(/&#(\d+);/g, (m, dec: string) => decodeNumericEntity(Number.parseInt(dec, 10), m));
  out = out
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
  out = out
    .replace(/&copy;/g, '©')
    .replace(/&reg;/g, '®')
    .replace(/&trade;/g, '™')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rsquo;/g, '’')
    .replace(/&bull;/g, '•')
    .replace(/&middot;/g, '·');
  out = out.replace(/&amp;/g, '&'); // &amp; 必须最后
  return out;
}

/** 单份渲染结果断言：非空（null/空串 FAIL）+ 无残留标签（/<\/?[a-zA-Z][^>]*>/，残留打出样例）。 */
function assertNotesRendered(which: string, out: string | null): void {
  if (out === null || out.length === 0) {
    report('P3', 'FAIL', `${which}渲染输出为空（null/空串）——旧版用户将看不到更新说明`);
    return;
  }
  report('P3', 'PASS', `${which}渲染输出非空（${out.length} 字符）`);
  const residual = /<\/?[a-zA-Z][^>]*>/.exec(out);
  if (residual) {
    report('P3', 'FAIL', `${which}渲染残留标签：${JSON.stringify(residual[0].slice(0, 60))}…`);
  } else {
    report('P3', 'PASS', `${which}渲染无残留标签`);
  }
}

async function gateP3(tag: string, proxy: URL | null): Promise<void> {
  console.log(`→ GET ${GITHUB_ATOM}`);
  const res = await fetchText(GITHUB_ATOM, { proxy });
  if (res.status !== 200) {
    report('P3', 'FAIL', `releases.atom HTTP ${res.status}`);
    return;
  }
  const entries = res.body
    .split(/<entry\b[^>]*>/)
    .slice(1)
    .map((e) => e.split('</entry>')[0]);
  if (entries.length === 0) {
    report('P3', 'FAIL', 'releases.atom 解析不出任何 entry');
    return;
  }

  // 3.1 首 entry 指向本次 tag
  const firstLink = /<link\b[^>]*\bhref="([^"]+)"/.exec(entries[0])?.[1] ?? '';
  if (firstLink.includes(`/tag/${tag}`)) {
    report('P3', 'PASS', `atom 首 entry 指向 ${tag}`);
  } else {
    report('P3', 'FAIL', `atom 首 entry link=${firstLink || '(未解析到 link)'}，未指向 ${tag}`);
  }

  // 3.2 首 entry content → rawHtml（XML 实体解码，顺序见 decodeXmlEntities）
  const contentEscaped = /<content type="html">([\s\S]*?)<\/content>/.exec(entries[0])?.[1];
  if (contentEscaped === undefined) {
    report('P3', 'FAIL', '首 entry 无 <content type="html">（Release body 为空或形态异常）');
    return;
  }
  const rawHtml = decodeXmlEntities(contentEscaped);

  // 3.3-3.6 旧版回放：上一版 tag 检出旧源码，与当前工作区源码各跑一遍 normalizeReleaseNotes
  let prevNormalize: ((raw: unknown) => string | null) | null = null;
  let prevTag = '';
  if (entries.length < 2) {
    console.log('⏭ P3 旧版回放：atom 不足 2 个 entry，跳过旧版回放，仅校验当前版渲染');
  } else {
    prevTag = /\/tag\/(v[\w.+-]+)/.exec(entries[1])?.[1] ?? '';
    if (!prevTag) {
      report('P3', 'FAIL', 'atom 第 2 个 entry 的 link 中提取不到 prevTag');
    } else {
      let prevSrc: string;
      try {
        prevSrc = sh(`git show "${prevTag}:src/shared/release-notes.ts"`);
      } catch (e) {
        report('P3', 'FAIL', `git show ${prevTag}:src/shared/release-notes.ts 失败：${(e as Error).message}`);
        prevSrc = '';
      }
      if (prevSrc) {
        try {
          mkdirSync(CACHE_DIR, { recursive: true });
        } catch (e) {
          console.error(`临时目录不可创建：${CACHE_DIR}（可设 CLAUDE_LINK_CACHE_DIR 指向可写目录）：${(e as Error).message}`);
          process.exit(2); // 环境问题，不混入 P3 逻辑 FAIL
        }
        const prevPath = join(CACHE_DIR, 'release-notes.prev.ts');
        try {
          writeFileSync(prevPath, prevSrc, 'utf8');
        } catch (e) {
          console.error(`临时目录不可写：${CACHE_DIR}（可设 CLAUDE_LINK_CACHE_DIR 指向可写目录）：${(e as Error).message}`);
          process.exit(2); // 环境问题，不混入 P3 逻辑 FAIL
        }
        try {
          // tsx 下可直接 require .ts
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const prevMod = require(prevPath) as Partial<ReleaseNotesModule>;
          if (typeof prevMod.normalizeReleaseNotes === 'function') {
            prevNormalize = prevMod.normalizeReleaseNotes;
          } else {
            report('P3', 'FAIL', `${prevTag} 检出的 release-notes.ts 不导出 normalizeReleaseNotes（历史形态差异）`);
          }
        } catch (e) {
          report('P3', 'FAIL', `加载 ${prevPath} 失败：${(e as Error).message}`);
        }
      }
    }
  }

  // 3.6 两份渲染 + 预览（标题行原样）
  // 当前版：直接 require 工作区 ../src/shared/release-notes（与其他契约脚本一致）。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const curMod = require('../src/shared/release-notes') as ReleaseNotesModule;
  const cur = curMod.normalizeReleaseNotes(rawHtml);
  console.log('\n----- 当前版源码渲染 -----');
  console.log(cur ?? '(null)');
  if (prevNormalize) {
    const old = prevNormalize(rawHtml);
    console.log(`\n----- 旧版 ${prevTag} 用户将看到 -----`);
    console.log(old ?? '(null)');
    assertNotesRendered(`旧版（${prevTag}）`, old);
  }
  assertNotesRendered('当前版', cur);
}

async function postMain(): Promise<void> {
  const tag = tagArg ?? `v${pkgVersion}`;
  // || 语义：空串视为未设置（与 CACHE_DIR 对称）——?? 会把 HTTPS_PROXY= 的空壳环境变量当有效值。
  const proxyUrl = proxyArg || process.env.CLAUDE_LINK_PROXY || process.env.HTTPS_PROXY || null;
  let proxy: URL | null = null;
  if (proxyUrl !== null) {
    try {
      proxy = new URL(proxyUrl);
    } catch {
      console.error(`代理 URL 非法：${proxyUrl}（来源 --proxy 或 CLAUDE_LINK_PROXY/HTTPS_PROXY 环境变量）`);
      process.exit(2); // 环境问题，非门禁逻辑 fail
    }
  }
  console.log(
    `\n=== POST：远端资产三查（tag=${tag}${tagArg ? '' : `（缺省取 package.json v${pkgVersion}）`}，proxy=${proxy === null ? '未配置（仅直连）' : proxy.href}） ===`,
  );
  await gateAsync('P1', () => gateP1(tag, proxy));
  await gateAsync('P2', () => gateP2(tag, proxy));
  await gateAsync('P3', () => gateP3(tag, proxy));
  summary();
}

// ---------- 入口 ----------

if (isPost) {
  void postMain().catch((e: unknown) => {
    console.error(e);
    process.exit(2);
  });
} else {
  preMain();
}
