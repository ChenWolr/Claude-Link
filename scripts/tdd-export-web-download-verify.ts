// tdd-export-web-download-verify.ts
// P5 网页版导出 HTTP 下载端点（一次性票据）契约钉（计划
// docs/plans/2026-10-24-web-sync-directory-naming-export-plan.md §4.6）。
// 分组：
//   ① tickets 模块行为级（Node 直跑纯逻辑）：createTicket 形状/随机性、consume 单次消费、
//      伪造/过期（Date.now 时钟注入）→ null、并发 consume 恰一次成功、purgeJob 按 job 摘除、
//      reset() 隔离；
//   ② manager 静态断言：ActiveJob.webOrigin、handler 第 4 参 webOrigin===true 才置位、
//      performSave web 分支在 smoke 判定之后且不调 requestExportTarget（performWebSave 免协商）、
//      web 延迟清理调度（scheduleWebArtifactCleanup / setTimeout 10min / unref）存在、
//      cleanup 摘票据（purgeJob）、nonce 链路透传（handler 第 5 参 ≤64 校验 → options →
//      ActiveJob → performWebSave 回填，round-001 review-report FIX-2a）；
//   ③ server 静态断言：/api/export-download 路由 + consumeTicket 接线 + Host 白名单后置
//      （路由在白名单判定之后）+ 404 固定文案 / 410 / RFC 5987 附件流形态；
//   ④ store 静态断言：start 传 web 判定第 3 参 + 一次性 nonce 第 4 参（pendingWebNonce，
//      FIX-2a）、done+webDownloads+nonce 门触发 downloadWebFiles（ownerJobId 钉住 + 两分支
//      job 守卫，FIX-2a/2b）、fetch→blob→a[download]→revoke 形态。
// RED 预期（未改树）：① 模块不存在 → 全 FAIL；②③④ 字面缺失 → FAIL。
// 运行：npx tsx scripts/tdd-export-web-download-verify.ts（已登记 scripts/selftest-static-list.txt 尾部）

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createTicket,
  consumeTicket,
  purgeJob,
  reset,
  WEB_DOWNLOAD_TTL_MS,
} from '../src/main/modules/export-web-tickets';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`);
  }
}

const manager = read('src/main/modules/export-image-manager.ts');
const server = read('src/main/modules/web-access/web-access-server.ts');
const storeSrc = read('src/renderer/stores/export-image-store.ts');
const typesSrc = read('src/shared/types/export-image.ts');
const preloadApi = read('src/preload/api.ts');
const webBridge = read('src/renderer/web/web-bridge.ts');

// ── ① tickets 模块行为级（Node 直跑纯逻辑，reset() 隔离） ──
console.log('=== ① export-web-tickets 行为级 ===');

check('reset() 隔离 + createTicket 返回形状（filename 原样 / url 为 /api/export-download?ticket=…）', () => {
  reset();
  const f = createTicket('job-a', 'C:\\tmp\\page-0001.jpg', '会话-20261024-000000.jpg');
  assert.equal(f.filename, '会话-20261024-000000.jpg');
  assert.match(f.url, /^\/api\/export-download\?ticket=[A-Za-z0-9_-]+$/);
  assert.ok(!f.url.includes('C:') && !f.url.includes('tmp'), 'url 不得含文件路径信息');
});

check('同 job 两次签发 ticket 随机不重复（192bit）', () => {
  reset();
  const a = createTicket('job-a', 'p1', 'f1').url;
  const b = createTicket('job-a', 'p2', 'f2').url;
  assert.notEqual(a, b);
});

check('consume 命中返回 {filePath, filename}；单次消费（第二次 → null）', () => {
  reset();
  const f = createTicket('job-a', 'C:\\tmp\\page-0001.jpg', 'f.jpg');
  const ticket = f.url.split('ticket=')[1]!;
  const hit = consumeTicket(ticket);
  assert.ok(hit, '首次消费应命中');
  assert.equal(hit.filePath, 'C:\\tmp\\page-0001.jpg');
  assert.equal(hit.filename, 'f.jpg');
  assert.equal(consumeTicket(ticket), null, '重放（第二次消费）必须 null');
});

check('伪造 ticket → null（固定 null，无路径/状态区分）', () => {
  reset();
  createTicket('job-a', 'p', 'f');
  assert.equal(consumeTicket('forged-ticket'), null);
  assert.equal(consumeTicket(''), null);
});

check('并发 consume（同 ticket 同步连发两次）恰一次成功', () => {
  reset();
  const ticket = createTicket('job-a', 'p', 'f').url.split('ticket=')[1]!;
  const results = [consumeTicket(ticket), consumeTicket(ticket)];
  assert.equal(results.filter((r) => r !== null).length, 1, '两次并发消费必须恰一次命中');
});

check('过期（时钟注入前拨 11min）→ null', () => {
  reset();
  const ticket = createTicket('job-a', 'p', 'f').url.split('ticket=')[1]!;
  assert.ok(WEB_DOWNLOAD_TTL_MS === 10 * 60_000, 'TTL 须为 10min');
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 11 * 60_000;
    assert.equal(consumeTicket(ticket), null, '过期票据必须 null');
  } finally {
    Date.now = realNow;
  }
  // 时钟复原后该票据已按过期摘除，不可复用。
  assert.equal(consumeTicket(ticket), null);
});

check('purgeJob 按 job 摘除：A 失效、B 不受影响', () => {
  reset();
  const ta = createTicket('job-a', 'pa', 'fa').url.split('ticket=')[1]!;
  const tb = createTicket('job-b', 'pb', 'fb').url.split('ticket=')[1]!;
  purgeJob('job-a');
  assert.equal(consumeTicket(ta), null, 'purge 后 job-a 票据必须失效');
  const hit = consumeTicket(tb);
  assert.ok(hit, 'purge job-a 不得波及 job-b');
  assert.equal(hit!.filePath, 'pb');
});

check('reset() 后全部失效（测试注入）', () => {
  reset();
  const t = createTicket('job-a', 'p', 'f').url.split('ticket=')[1]!;
  reset();
  assert.equal(consumeTicket(t), null);
});

// ── ② manager 静态断言 ──
console.log('=== ② export-image-manager 静态 ===');

check('ActiveJob 含 webOrigin: boolean；active 装配透传 webOrigin', () => {
  const iface = manager.slice(manager.indexOf('interface ActiveJob'), manager.indexOf('let active: ActiveJob'));
  assert.ok(/webOrigin:\s*boolean/.test(iface), 'ActiveJob 缺 webOrigin: boolean');
  const assignStart = manager.indexOf('  active = {');
  const assignBody = manager.slice(assignStart, assignStart + 900);
  assert.ok(/webOrigin,/.test(assignBody), 'active = {...} 缺 webOrigin 透传');
});

check('EXPORT_IMAGE_START handler 第 4 参 webOrigin: unknown 且仅 ===true 置位', () => {
  assert.match(manager, /webOrigin:\s*unknown/, 'handler 缺第 4 参 webOrigin: unknown');
  assert.match(manager, /webOrigin\s*===\s*true/, 'webOrigin 须仅 ===true 才置位（防任意真值注入）');
});

check('performSave：web 分支在 smoke 判定之后（smoke 优先），命中即短路 performWebSave', () => {
  const fnStart = manager.indexOf('async function performSave');
  const fnEnd = manager.indexOf('function performWebSave');
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'performSave / performWebSave 缺失');
  const body = manager.slice(fnStart, fnEnd);
  const smokeAt = body.indexOf('CLAUDE_LINK_EXPORT_SMOKE_DEST');
  const webAt = body.indexOf('job.webOrigin');
  assert.ok(smokeAt > -1, 'performSave 缺 smoke 判定');
  assert.ok(webAt > smokeAt, 'web 分支必须在 smoke 判定之后（smoke 语义优先）');
  assert.match(body, /performWebSave\(job,\s*pages\)/, 'web 分支须短路至 performWebSave');
});

check('performWebSave 免协商：不含 requestExportTarget；逐页签票 + 不 copy/move（paths: []）', () => {
  const fnStart = manager.indexOf('function performWebSave');
  const fnEnd = manager.indexOf('/** 排他移动：'); // moveExclusive 的 doc 注释（含 copyFileSync 字样）不属函数体
  const body = manager.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
  assert.ok(!body.includes('requestExportTarget'), 'performWebSave 不得调 requestExportTarget');
  assert.ok(body.includes('createTicket('), 'performWebSave 缺逐页签票');
  assert.ok(body.includes('buildExportFilename('), 'performWebSave 缺文件名构造（与桌面导出同名）');
  assert.match(body, /paths:\s*\[\]/, 'web 结果 paths 须为 []（不落 A 机用户目录）');
  assert.match(body, /webDownloads:\s*\{/, 'web 结果须携带 webDownloads');
  assert.ok(!/copyFileSync|moveExclusive/.test(body), 'performWebSave 不得 copy/move 文件');
});

check('web 延迟清理：scheduleWebArtifactCleanup + setTimeout 10min + unref；资源立即收口（active 槽位不滞留）', () => {
  const fnStart = manager.indexOf('function scheduleWebArtifactCleanup');
  assert.ok(fnStart > -1, '缺 scheduleWebArtifactCleanup');
  const body = manager.slice(fnStart, fnStart + 1600);
  assert.match(body, /setTimeout/, '延迟清理缺 setTimeout');
  assert.match(body, /10\s*\*\s*60_000|WEB_ARTIFACT_TTL_MS/, '延迟清理须 10min（常量或字面）');
  assert.match(body, /unref/, '清理定时器须 unref');
  assert.ok(manager.includes('WEB_ARTIFACT_TTL_MS = 10 * 60_000'), 'WEB_ARTIFACT_TTL_MS 须为 10min');
});

check('终态收口：web saved 分支走 scheduleWebArtifactCleanup，桌面仍走 cleanup(\'finished\')', () => {
  const fnStart = manager.indexOf('async function handleFinishImpl');
  const fnEnd = manager.indexOf('async function performSave');
  const body = manager.slice(fnStart, fnEnd);
  const webAt = body.indexOf('scheduleWebArtifactCleanup');
  const cleanupAt = body.indexOf("cleanup('finished')");
  assert.ok(webAt > -1, 'handleFinishImpl 缺 web 延迟清理分支');
  assert.ok(cleanupAt > -1, 'handleFinishImpl 缺桌面 cleanup 分支');
  assert.ok(webAt < cleanupAt, 'web 分支应先于桌面 cleanup 出现（if/else 结构）');
  assert.match(body, /导出完成，正在通过浏览器下载/, 'done 相 web message 缺失');
});

check('cleanup 摘票据：purgeJob(job.jobId)（cancel/error 路径票据随即失效；桌面无票据 no-op）', () => {
  const fnStart = manager.indexOf('async function cleanup(');
  const body = manager.slice(fnStart, fnStart + 1600);
  assert.match(body, /purgeJob\(job\.jobId\)/, 'cleanup 缺 purgeJob');
});

// round-001 review-report FIX-2a：nonce 链路透传——handler 第 5 参收 nonce（string ≤64 校验，
// 非法/缺省 undefined）→ StartExportOptions.originNonce → ActiveJob → performWebSave 回填
// webDownloads.originNonce；桌面不传 → undefined → 全旧行为。
check('nonce 链路：handler 第 5 参 string ≤64 校验 → options.originNonce → ActiveJob → performWebSave 回填（FIX-2a）', () => {
  assert.match(manager, /webOrigin:\s*unknown,\s*originNonce:\s*unknown/, 'handler 缺第 5 参 originNonce: unknown');
  assert.match(manager, /originNonce\.length >= 1 && originNonce\.length <= 64/, 'nonce 缺 1–64 长度校验');
  const optStart = manager.indexOf('export interface StartExportOptions');
  const optEnd = manager.indexOf('export type StartExportResult');
  assert.ok(/originNonce\?:\s*string/.test(manager.slice(optStart, optEnd)), 'StartExportOptions 缺 originNonce?: string');
  const iface = manager.slice(manager.indexOf('interface ActiveJob'), manager.indexOf('let active: ActiveJob'));
  assert.ok(/originNonce\?:\s*string/.test(iface), 'ActiveJob 缺 originNonce?: string');
  const assignStart = manager.indexOf('  active = {');
  assert.ok(/originNonce:\s*options\.originNonce/.test(manager.slice(assignStart, assignStart + 1100)), 'active 装配缺 originNonce 透传');
  const wsStart = manager.indexOf('function performWebSave');
  const wsEnd = manager.indexOf('/** 排他移动：');
  assert.match(manager.slice(wsStart, wsEnd > wsStart ? wsEnd : undefined), /originNonce:\s*job\.originNonce/, 'performWebSave 缺 webDownloads.originNonce 回填');
});

// ── ③ server 静态断言 ──
console.log('=== ③ web-access-server 静态 ===');

check('/api/export-download 路由 + consumeTicket 接线（import + 调用）', () => {
  assert.ok(server.includes('/api/export-download'), '缺下载路由');
  assert.match(server, /import\s*\{[^}]*consumeTicket[^}]*\}\s*from\s*'\.\.\/export-web-tickets'/, '缺 consumeTicket import');
  assert.match(server, /consumeTicket\(/, '缺 consumeTicket 调用');
});

check('Host 白名单后置：路由在 isAllowedHost 判定之后（防 DNS rebinding 对 /api 同样生效）', () => {
  const hostAt = server.indexOf('isAllowedHost(req.headers.host, allowedHosts)');
  const routeAt = server.indexOf('/api/export-download');
  assert.ok(hostAt > -1 && routeAt > hostAt, '下载路由必须在 Host 白名单判定之后');
});

check('未命中 → 404 固定文案（无路径泄漏）；statSync 失败 → 410', () => {
  assert.ok(server.includes("plain(res, 404, 'Not Found（链接无效或已使用）')"), '404 文案须固定');
  assert.match(server, /plain\(res,\s*410/, 'statSync 失败须 410');
  const fnStart = server.indexOf('function serveExportDownload');
  const routeBody = server.slice(fnStart, fnStart + 2800);
  // 错误响应（plain 404/410）必须全字面固定文案：不得内插 filePath/状态等动态信息。
  const plainCalls = routeBody.match(/plain\(res,[^\n]*\);/g) ?? [];
  assert.ok(plainCalls.length >= 2, `错误分支 plain 调用缺失（${plainCalls.length} 处）`);
  for (const c of plainCalls) {
    assert.ok(!c.includes('${') && !c.includes('filePath'), `错误响应不得回显动态信息：${c.trim()}`);
  }
});

check('附件流形态：Content-Disposition（filename* RFC 5987）+ Content-Length + nosniff + createReadStream + HEAD 直接 end', () => {
  const fnStart = server.indexOf('function serveExportDownload');
  const routeBody = server.slice(fnStart, fnStart + 2800);
  assert.match(routeBody, /Content-Disposition/, '缺附件头');
  assert.match(routeBody, /filename\*=UTF-8''/, '缺 RFC 5987 filename*');
  assert.match(routeBody, /Content-Length/, '缺 Content-Length（statSync 预检）');
  assert.match(routeBody, /X-Content-Type-Options/, '缺 nosniff');
  assert.match(routeBody, /createReadStream/, '须流式（HTTP 流不受 WS 48MiB 帧约束）');
  assert.match(routeBody, /res\.destroy\(\)/, '流错误须 destroy（对齐静态流形态）');
  assert.match(routeBody, /method === 'HEAD'/, 'HEAD 须直接 end');
});

// ── ④ store 静态断言 ──
console.log('=== ④ export-image-store 静态 ===');

check('types：ExportWebDownloadFile / webDownloads（进度 done 相与 saved 结果同形状可选）+ originNonce（FIX-2a nonce 门）', () => {
  assert.match(typesSrc, /interface ExportWebDownloadFile\s*\{\s*filename:\s*string;\s*url:\s*string;[^}]*\}/, '缺 ExportWebDownloadFile');
  const count = (typesSrc.match(/webDownloads\?:/g) ?? []).length;
  assert.ok(count >= 2, `进度载荷与 saved 结果均须有可选 webDownloads（现状 ${count} 处）`);
  // round-001 review-report FIX-2a：多网页客户端票据抢答防护——下载清单携带发起端一次性 nonce。
  assert.match(typesSrc, /interface ExportWebDownloads\s*\{[\s\S]{0,400}?originNonce\?:\s*string/, 'ExportWebDownloads 缺 originNonce?: string');
});

check('preload / web-bridge：startImageExport 第 3 参 webOrigin? + 第 4 参 originNonce? 透传（无新方法，头注释 111 不变）', () => {
  // round-001 review-report FIX-2a：接口与实现签名加可选第 4 参 nonce 透传 invoke。
  assert.match(preloadApi, /startImageExport:\s*\(sessionId:\s*string,\s*format:\s*import\([^)]+\)\.ExportImageFormat,\s*webOrigin\?:\s*boolean,\s*originNonce\?:\s*string\)/, 'preload 接口缺第 4 参 originNonce?');
  assert.match(preloadApi, /EXPORT_IMAGE_START,\s*sessionId,\s*format,\s*webOrigin,\s*originNonce\)/, 'preload 实现缺第 4 参透传');
  assert.ok(webBridge.includes('startImageExport: IPC_CHANNELS.EXPORT_IMAGE_START'), 'web-bridge 通道键不得变');
  // 泛型分派（...args → invokeOverWire(channel, args)）天然透传第 3/4 参：
  assert.match(webBridge, /\.\.\.args[^)]*\):\s*Promise<unknown> => invokeOverWire\(channel,\s*args\)/, 'web-bridge 泛型透传形态缺失');
});

check('start：生成一次性 nonce 存 pendingWebNonce 并作第 4 参透传（web 才传；FIX-2a）', () => {
  assert.match(storeSrc, /let pendingWebNonce = ''/, '缺模块级 pendingWebNonce');
  assert.match(storeSrc, /Math\.random\(\)\.toString\(36\)\.slice\(2\)\s*\+\s*Date\.now\(\)\.toString\(36\)/, 'nonce 生成形态缺失');
  assert.match(storeSrc, /pendingWebNonce\s*=\s*nonce/, 'nonce 未暂存 pendingWebNonce');
  assert.match(storeSrc, /startImageExport\(sessionId,\s*format,\s*isWebMode\(\),\s*isWebMode\(\)\s*\?\s*nonce\s*:\s*undefined\)/, 'start 缺第 4 参 nonce 透传（web 才传）');
  assert.match(storeSrc, /!\(window as any\)\.__claudeLinkWebBridge/, 'isWebMode 判定须与 session-store 同源');
});

check('applyProgress：done+webDownloads+web+originNonce===pendingWebNonce 门 → 命中清 nonce 防重放 → ownerJobId 钉住后触发 downloadWebFiles（FIX-2a/2b）', () => {
  const fnStart = storeSrc.indexOf('applyProgress(payload');
  const fnEnd = storeSrc.indexOf('async start(');
  const body = storeSrc.slice(fnStart, fnEnd);
  assert.match(body, /payload\.phase === 'done' &&\s+payload\.webDownloads &&\s+isWebMode\(\)/, '触发门缺失');
  // round-001 review-report FIX-2a：nonce 门——仅发起端本 job 命中才下载，他端忽略。
  assert.match(body, /payload\.webDownloads\.originNonce === pendingWebNonce/, 'nonce 比对门缺失');
  assert.match(body, /pendingWebNonce\s*=\s*''/, '命中后未清空 pendingWebNonce（防重放）');
  // round-001 review-report FIX-2b：先钉 ownerJobId 再异步下载（迟到失败不污染后继 job）。
  assert.match(body, /const ownerJobId = payload\.jobId/, '缺 ownerJobId 钉取');
  assert.match(body, /void this\.downloadWebFiles\(payload\.webDownloads\.files,\s*ownerJobId\)/, '缺 downloadWebFiles 触发（带 ownerJobId）');
  const dlAt = body.indexOf('downloadWebFiles');
  const resetAt = body.indexOf('scheduleReset()');
  assert.ok(dlAt > -1 && resetAt > dlAt, '下载触发须先于终态收起计时');
});

check('downloadWebFiles：fetch→!ok throw→blob→createObjectURL→a[download]→click→revoke；全败才 error、部分败注明第几张；两分支均 this.jobId===ownerJobId 守卫（FIX-2b）', () => {
  const fnStart = storeSrc.indexOf('async downloadWebFiles(');
  assert.ok(fnStart > -1, '缺 downloadWebFiles action');
  const fnEnd = storeSrc.indexOf('scheduleReset():', fnStart);
  const body = storeSrc.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 3200);
  assert.match(body, /ownerJobId\?:\s*string\s*\|\s*null/, 'downloadWebFiles 缺 ownerJobId?: string | null 参数');
  assert.match(body, /await fetch\(/, '缺 fetch');
  assert.match(body, /!\s*r\.ok[\s\S]{0,40}throw/, '非 2xx 须 throw');
  assert.match(body, /await r\.blob\(\)/, '缺 blob');
  assert.match(body, /URL\.createObjectURL\(/, '缺 createObjectURL');
  assert.match(body, /a\.download\s*=/, '缺 a[download] 文件名');
  assert.match(body, /a\.click\(\)/, '缺触发下载');
  assert.match(body, /URL\.revokeObjectURL\(/, '缺 revoke');
  assert.match(body, /length === files\.length/, '须全败才置 error');
  assert.match(body, /第 \$\{/, '部分失败须注明第几张');
  // round-001 review-report FIX-2b：全败/部分败两分支均须 job 守卫——非 owner（job 已切换）
  // 一律 console.warn 丢弃，不写 phase/message/scheduleReset。
  const guardCount = (body.match(/this\.jobId === ownerJobId/g) ?? []).length;
  assert.ok(guardCount >= 2, `全败/部分败两分支均须 ownerJobId 守卫（现状 ${guardCount} 处）`);
  const warnCount = (body.match(/console\.warn/g) ?? []).length;
  assert.ok(warnCount >= 2, `守卫丢弃路径须 console.warn（现状 ${warnCount} 处）`);
});

process.exit(fail > 0 ? 1 : 0);
