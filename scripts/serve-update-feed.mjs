// scripts/serve-update-feed.mjs
// 本地更新 feed 服务器（E2E 专用）：把 dist-electron 下已构建的安装包伪装成高版本 latest.yml，
// 供打包实例经 CLAUDE_LINK_UPDATE_FEED_URL 指向本服务做检查更新全链验证，不触碰 GitHub。
// 用法：node scripts/serve-update-feed.mjs [--dir dist-electron] [--port 8788] [--version 99.0.0]
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const dir = argOf('--dir', 'dist-electron');
const port = Number(argOf('--port', '8788'));
const fakeVersion = argOf('--version', '99.0.0');

const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const exeName = `claude-link-${pkgVersion}-setup.exe`;
// F1（R1 对抗评审 P1）：按 package.json 版本精确选包。dist-electron 常有旧版残留，
// 目录序 find 会选中旧包伪装高版本——E2E 验证错工件，强杀失手还会弹降级安装向导。
const exe = readdirSync(dir).find((f) => f === exeName);
if (!exe) {
  const candidates = readdirSync(dir).filter((f) => /^claude-link-.*-setup\.exe$/.test(f)).join(', ') || '无';
  console.error(`[feed] ${dir} 下未找到 ${exeName}（须与 package.json 版本 ${pkgVersion} 一致；现存候选：${candidates}）。先 npm run package:win`);
  process.exit(2);
}
const exePath = join(dir, exe);
const sha512 = createHash('sha512').update(readFileSync(exePath)).digest('base64');
const size = statSync(exePath).size;
const yml = [
  `version: ${fakeVersion}`,
  'files:',
  `  - url: ${exe}`,
  `    sha512: ${sha512}`,
  `    size: ${size}`,
  `path: ${exe}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  // E4b 归一化/渲染验证：generic feed 的 releaseNotes 经 electron-updater parseUpdateInfo
  // 整体透传 → normalizeReleaseNotes 同一归一链（井号标题/列表/链接 [text](href) 形态
  // + 显式 md 链接与 script/img 注入样例——渲染层消毒的端到端 fixture）。
  'releaseNotes: |',
  '  <h2>修复（E2E 归一化验证）</h2>',
  '  <ul>',
  '  <li>列表项一：<strong>加粗</strong>与 <a href="https://example.com/a">链接文本</a></li>',
  '  <li>列表项二</li>',
  '  </ul>',
  '  <p>注入样例：[显式链接](https://example.com/b)、内嵌脚本 <script>alert(1)</script> 与图片 <img src=x onerror=alert(1)> 已消毒</p>',
].join('\n');

const server = createServer((req, res) => {
  // electron-updater 的 generic provider 会带缓存穿透查询串（latest.yml?noCache=<rand>），
  // 必须按 pathname 匹配，不能对 req.url 全串做精确相等。
  const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  if (pathname === '/' || pathname === '/latest.yml') {
    res.writeHead(200, { 'Content-Type': 'text/yaml' });
    res.end(yml);
    return;
  }
  if (pathname === `/${exe}`) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size });
    createReadStream(exePath).pipe(res);
    return;
  }
  res.writeHead(404); res.end('not found');
});
server.listen(port, '127.0.0.1', () => {
  console.log(`[feed] http://127.0.0.1:${port}/ → ${exe}（伪装 v${fakeVersion}，size=${size}）`);
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
