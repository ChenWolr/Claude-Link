// scripts/tdd-bugfix-hb10-commands-p3-verify.ts
// hb10 P3 CMD 批契约（CMD-01收窄+V02/02/03/04/05/06/07收窄/08/09/10/V01/V03）。
// 2026-09-13 二轮补救追加 ⑨⑩⑪：hb12-CMD-01（cancelAllCommandProbes 收口）、hb12-CMD-02
// （指纹 await 后代际重查）、hb12-CMD-03（菜单高度预算 4 项）——round2 验收 P2-A2/A6/A7。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-commands-p3-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const origin = read('src/main/modules/sdk-command-origin.ts');
const watcher = read('src/main/modules/command-source-watcher.ts');
const backend = read('src/main/modules/sdk-backend.ts');
const handlers = read('src/main/ipc-handlers.ts');
const chatInput = read('src/renderer/components/chat/ChatInput.vue');
const mainIndex = read('src/main/index.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① CMD-01+V02：官方优先级裁 winner。
check('① CMD-01+V02：ORIGIN_PRIORITY 裁 winner（不再判 unknown）；深度 6', () => {
  assert.match(origin, /ORIGIN_PRIORITY/, '缺优先级表');
  assert.match(origin, /pn > pe \? origin : existing/, '缺 winner 裁决');
  assert.doesNotMatch(origin, /existing && existing !== origin \? 'unknown' : origin;/, '旧 unknown 判定残留');
  assert.match(origin, /COMMAND_SCAN_MAX_DEPTH = 6/, '深度非 6（CMD-09）');
});

// ② CMD-02/05/06（hb13-v B11 同步：慢重试实为 30s（WATCHER_PENDING_ROOT_RETRY_MS），注释/日志
// 向实现对齐——hb10 计划原文误写 60s；补慢循环恢复挂载后 hadErrorSinceMount 复位（F8 归零链））。
check('② CMD-02/05/06：超限转 30s 慢重试 + mountAll 清 pendingRoots + handleConfigSaved 清 remountTimer', () => {
  assert.match(watcher, /转入 30s 慢重试循环/, '超限仍放弃（或注释仍误写 60s）');
  assert.match(watcher, /WATCHER_PENDING_ROOT_RETRY_MS = 30_000/, '慢重试周期常量漂移');
  assert.match(watcher, /for \(const r of allRoots\) s\.pendingRoots\.add\(r\);/, '超限缺登记 pending');
  assert.match(watcher, /s\.pendingRoots\.clear\(\); \/\/ hb10-CMD-05/, 'mountAll 首行未清 pendingRoots');
  assert.match(watcher, /hb10-CMD-06：先清在途重挂 timer/, 'handleConfigSaved 缺清 remountTimer');
  // F8：慢循环恢复挂载成功后复位 hadErrorSinceMount——安静刷新才能把 consecutiveErrors 归零
  //（旧实现无复位点，超限一次即永久慢模式）。
  const loopIdx = watcher.indexOf('function ensurePendingRetryLoop');
  const loopBody = watcher.slice(loopIdx, watcher.indexOf('\n}', loopIdx));
  assert.match(loopBody, /after\.hadErrorSinceMount = false;/, '慢循环恢复挂载后缺 hadErrorSinceMount 复位（永久慢模式病灶）');
});

// ③ CMD-03。
check('③ CMD-03：init/probe重试/changed 三处补传项目指纹（hb13-v B6 同步：经 helper computeProjectFp 委托，取值链保持）', () => {
  // hb13-v B6 必要同步：三处指纹改为 replaceCommandSnapshotIfCurrent 的 computeProjectFp 委托
  //（init 早期/probe 主路径/changed 三处共用守卫 helper），断言钉委托存在与数量，强度等价。
  const delegations = (backend.match(/computeProjectFp: \(\) => getProjectOriginFingerprint\(/g) ?? []).length;
  assert.ok(delegations >= 3, `三处指纹委托缺失（${delegations}/3）`);
  assert.match(backend, /source: 'init'/, 'init 路径缺指纹来源标记');
  assert.match(backend, /source: 'changed'/, 'changed 路径缺指纹来源标记');
});

// ④ CMD-04。
check('④ CMD-04：rawContent null/undefined → 空串（无 "" 噪声）', () => {
  const idx = backend.indexOf('hb10-CMD-04');
  const body = backend.slice(idx, idx + 400);
  assert.match(body, /rawContent == null/, '缺 null 分支');
});

// ⑤ CMD-07。
check('⑤ CMD-07：globalProbeError 三失败路落终态 + 导出查询', () => {
  assert.match(backend, /let globalProbeError = false;/, '缺标志');
  assert.match(backend, /export function isGlobalProbeFailed\(\)/, '缺导出');
  const hits = (backend.match(/globalProbeError = true;/g) ?? []).length;
  assert.ok(hits >= 3, `三失败路置位不足（${hits}/3）`);
});

// ⑥ CMD-08（hb13-v A2 改钉）。
// 旧断言钉住 `new RegExp('\s')`——JS 字符串 '\s' 转义丢失即字母 s，正则实为 /s/：
// 含字母 s 的命令名（/status、/list）被误判「含空格」，split(/s+/) 按字母 s 切分，
// 选择后插入被截断（status → "/ "）。新断言拒绝单反斜杠 bug 形态、接受 /\\s/ 修复形态。
check('⑥ CMD-08：空格分流用 /\\s/（拒绝 \'\\s\' 单反斜杠 bug 形态）+ 菜单标注', () => {
  assert.ok(!/new RegExp\('\\s'\)/.test(chatInput), "仍存在 new RegExp('\\s') 单反斜杠 bug 形态（转义丢失实为 /s/）");
  const selectIdx = chatInput.indexOf('function selectSlashCommand');
  assert.ok(selectIdx > -1, '未找到 selectSlashCommand');
  const selectEnd = chatInput.indexOf('\n}', selectIdx);
  const body = chatInput.slice(selectIdx, selectEnd > -1 ? selectEnd : undefined);
  assert.match(body, /\/\\s\/\.test\(cmd\.name\)/, 'selectSlashCommand 缺 /\\s/ 空格分流');
  assert.match(body, /split\(\/\\s\+\/\)\[0\]/, '缺 /\\s+/ 首段切分');
  assert.match(chatInput, /（含空格，需手动输入）/, '缺菜单标注');
});

// ⑥b CMD-08 行为级（hb13-v A2）：vm 抽取 selectSlashCommand 实调，含 s 命令名完整保留。
check('⑥b CMD-08 行为级：status 完整插入；空格名仅插首段；普通名原样插入', () => {
  assert.ok(!/new RegExp\('\\s'\)/.test(chatInput), "bug 形态在文件内，行为断言无意义（先消除 new RegExp('\\s')）");
  const selectIdx = chatInput.indexOf('function selectSlashCommand');
  const selectEnd = chatInput.indexOf('\n}', selectIdx);
  assert.ok(selectIdx > -1 && selectEnd > selectIdx, '未截取到 selectSlashCommand');
  const fnSrc = chatInput.slice(selectIdx, selectEnd + 2);
  const js = ts.transpileModule(fnSrc, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const wrapper = `(function(__deps){ const {emit, showSlashMenu, resetCommandPagination} = __deps; ${js}; return selectSlashCommand; })`;
  const run = (name: string): string => {
    const emitted: string[] = [];
    const menu = { value: true };
    const fn = vm.runInNewContext(wrapper, vm.createContext({}))({
      emit: (_evt: string, value: string) => { emitted.push(value); },
      showSlashMenu: menu,
      resetCommandPagination: () => {},
    });
    fn({ name });
    assert.equal(menu.value, false, '选择后菜单未关闭');
    return emitted[0] ?? '';
  };
  assert.equal(run('status'), '/status ', '含字母 s 的命令名被字母 s 切分截断（\'\\s\' 转义丢失 bug）');
  assert.equal(run('list'), '/list ', '含字母 s 的命令名被截断');
  assert.equal(run('multi word cmd'), '/multi ', '含空格命令名未仅插首段');
  assert.equal(run('init'), '/init ', '普通命令名插入失真');
});

// ⑦ CMD-10。
check('⑦ CMD-10：needsRefreshProbeOnly 10s 节流', () => {
  assert.match(handlers, /lastProbeOnlyAt/, '缺节流时间戳');
  assert.match(handlers, /now - lastProbeOnlyAt >= 10_000/, '缺 10s 判据');
});

// ⑧ CMD-V01/V03。
check('⑧ CMD-V01/V03：比对侧镜像回退 + refreshFingerprints 单调序号', () => {
  assert.match(handlers, /sessionRow\?\.workingDir \?\? getConfig\(\)\.workingDirectory \?\? null/, '比对侧缺全局 cwd 回退');
  assert.match(watcher, /let refreshSeq = 0;/, '缺单调序号');
  assert.match(watcher, /if \(mySeq !== refreshSeq\) return;/, '缺最新写判定');
});

// ⑨ hb12-CMD-01（二轮补救）：全探针退出收口。
check('⑨ CMD-01：导出 cancelAllCommandProbes/cancelAllPostTurnProbes 并入 before-quit', () => {
  assert.match(backend, /export async function cancelAllCommandProbes\(/, '缺 cancelAllCommandProbes 导出');
  assert.match(backend, /entry\.aborted = true;[\s\S]{0,200}?entry\.abortController\.abort\(\);/, '缺 abort 记账形态');
  assert.match(
    backend,
    /export function cancelAllPostTurnProbes\(\): void \{[\s\S]{0,120}?for \(const sid of \[\.\.\.postTurnProbeState\.keys\(\)\]\) cancelPostTurnProbe\(sid\);/,
    '缺 post-turn 一行循环',
  );
  const bqIdx = mainIndex.indexOf("app.on('before-quit'");
  assert.ok(bqIdx > -1, '缺 before-quit');
  const body = mainIndex.slice(bqIdx, bqIdx + 700);
  assert.match(body, /cancelAllCommandProbes\(\)/, 'before-quit 缺 cancelAllCommandProbes 调用');
  assert.match(body, /cancelAllPostTurnProbes\(\)/, 'before-quit 缺 cancelAllPostTurnProbes 调用');
});

// ⑩ hb12-CMD-02（二轮补救）：指纹 IO 第二异步窗后代际重查。
check('⑩ CMD-02：指纹 await 返回后重查代际+现役才 replace（probe 主路径经 helper；init 兜底内联保留）', () => {
  // hb13-v B6 必要同步：probe 主路径/changed/init 早期三处的「指纹 IO 后重查」收口至
  // replaceCommandSnapshotIfCurrent（helper 内含代际重查+现役委托+二次重查，见 hb13-v 契约④）；
  // 此处钉 helper 的守卫要素 + init 兜底路径的既有内联双查（未被重构）。
  const helperIdx = backend.indexOf('async function replaceCommandSnapshotIfCurrent(');
  assert.ok(helperIdx > -1, '缺守卫 helper');
  const helperBody = backend.slice(helperIdx, helperIdx + 1600);
  assert.match(helperBody, /await args\.computeProjectFp\(\)/, 'helper 缺指纹 IO');
  assert.match(helperBody, /getRevision\(sessionId\) !== [\s\S]{0,40}startRev/, 'helper 缺代际重查');
  assert.match(helperBody, /args\.isCurrent\(\)/, 'helper 缺现役委托重查');
  const initFp = backend.indexOf('const probeProjectFp = await getProjectOriginFingerprint(');
  assert.ok(initFp > -1, '缺 init 兜底指纹 await');
  const initBody = backend.slice(initFp, initFp + 500);
  assert.match(initBody, /sdkCommandRegistry\.getRevision\(sessionId\) !== startRev/, 'init 指纹后缺代际重查');
  assert.match(initBody, /isCurrentEntry\(sessionId, entry\)/, 'init 指纹后缺现役重查');
});

// ⑪ hb12-CMD-03（二轮补救）：菜单高度预算改容纳 4 项，提示行计入同一预算。
check('⑪ CMD-03：slash-menu max-height 预算 = 4 项 + 提示行（同一预算）', () => {
  assert.match(
    chatInput,
    /max-height: calc\(\(0\.5rem \* 2\) \+ \(2px \* 4\) \+ \(2\.5rem \* 4\) \+ 2\.5rem\);/,
    '预算须为 4 项 + 提示行 2.5rem',
  );
  assert.ok(!chatInput.includes('(2.5rem * 5)'), '5 项旧预算须移除');
  assert.match(chatInput, /提示行计入同一预算/, '缺提示行预算注释');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
