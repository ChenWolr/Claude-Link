// scripts/tdd-bugfix-hb10-changes-p3-verify.ts
// hb10 P3 CHG 批契约（CHG-06/07/08收窄/10/11/12/13收窄/14/V03/V04；CHG-05 REFUTED 不实施）。
// 2026-09-13 补救轮追加 ⑨：hb12-P2-9/CHG-02 两处 windowsHide（验收 §3-A 判首轮漏实施，此处补钉）。
// 2026-09-13 三轮补救：⑦ hb13-v B8 改钉（CHG-14 requestId 归位 refresh + finally 条件清键）+ ⑩
// DiffSidebar 截断/watch 短路——旧⑦恰钉住 F-1/F-2 缺陷形态（ensureDiff 判死 + 恒空护栏）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-changes-p3-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const panel = read('src/main/modules/changes-panel.ts');
const store = read('src/renderer/stores/changes-store.ts');
const changesPanelVue = read('src/renderer/components/changes/ChangesPanel.vue');
const diffSidebar = read('src/renderer/components/changes/DiffSidebar.vue');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① CHG-06。
check('① CHG-06：normalizeStatus 冲突先判（y=U / DD / AA → U）', () => {
  const idx = panel.indexOf('export function normalizeStatus');
  const body = panel.slice(idx, panel.indexOf('\n}', idx));
  assert.match(body, /y === 'U' \|\| xy === 'DD' \|\| xy === 'AA'\) return 'U';/, '缺冲突判定');
  assert.match(body, /const y = xy\[1\];/, '缺第二列读取');
});

// ② CHG-07。
check('② CHG-07：openChangeFile realpathSync 后验界（symlink 穿透封堵）', () => {
  const idx = panel.indexOf('export async function openChangeFile');
  const body = panel.slice(idx, idx + 1400);
  assert.match(body, /fs\.realpathSync\(abs\);/, '缺 realpath');
  const rpIdx = body.indexOf('fs.realpathSync(abs);');
  const insideIdx = body.indexOf('isPathInsideRoot(abs, root)');
  assert.ok(insideIdx > rpIdx, '验界必须在 realpath 之后');
});

// ③ CHG-08 收窄。
check('③ CHG-08：目录兜底预算（>50 文件 / >8MB 拒绝）', () => {
  const idx = panel.indexOf("path.endsWith('/')");
  const body = panel.slice(idx, idx + 1800);
  assert.match(body, /dirFiles\.length > 50/, '缺文件数上限');
  assert.match(body, /8 \* 1024 \* 1024/, '缺字节上限');
  assert.match(body, /目录条目过大/, '缺失败文案');
});

// ④ CHG-10。
check('④ CHG-10：U+FFFD 占比 >5% 按 latin1 重解（GBK 启发式）', () => {
  assert.match(panel, /encoding: 'buffer',/, 'runGitRaw 缺 buffer 编码');
  assert.match(panel, /String\.fromCharCode\(0xfffd\)/, '缺 FFFD 计数');
  assert.match(panel, /toString\('latin1'\)/, '缺 latin1 重解');
  assert.match(panel, /0\.05/, '缺 5% 阈值');
});

// ⑤ CHG-11。
check('⑤ CHG-11：列表前 500 条截断 + 「其余 N 条未显示」', () => {
  assert.match(changesPanelVue, /store\.files\.slice\(0, 500\)/, '缺截断');
  assert.match(changesPanelVue, /其余 \{\{ store\.files\.length - 500 \}\} 条未显示/, '缺汇总行');
});

// ⑥ CHG-12。
check('⑥ CHG-12：重命名条目 diff 用 -- oldPath newPath（lastListFiles 快照）', () => {
  assert.match(panel, /let lastListFiles: ChangedFile\[\] \| null = null;/, '缺快照');
  assert.match(panel, /lastListFiles = files;/, 'listChanges 未写快照');
  const diffIdx = panel.indexOf('const renameEntry = lastListFiles?.find');
  assert.ok(diffIdx > -1, 'getChangeDiff 缺重命名判定');
  assert.match(panel, /\['--', renameEntry\.oldPath, path\]/, '缺双路径 pathspec');
});

// ⑦ CHG-13/14/V03（hb13-v B8 改钉）。
// 旧⑦钉住缺陷形态：requestId 装在 ensureDiff（复用在途 Promise 被判死丢弃 → 弹窗永久
// 「加载中」），finally 先无条件 delete 后判 has（恒空死护栏）。新钉：requestId 归位
// refresh（hb12 计划 CHG-14 原文「防抖×在途乱序仅最新写」），ensureDiff 恢复纯代际守卫。
check('⑦ CHG-13/14/V03 改钉：requestId 归位 refresh + ensureDiff 纯代际 + finally 条件清键', () => {
  assert.match(store, /const reqId = \+\+refreshRequestId;/, 'refresh 缺 requestId（hb12 CHG-14 归位）');
  assert.match(store, /gen !== sessionGen \|\| reqId !== refreshRequestId\) return;/, 'refresh 缺「仅最新完成者写」判定');
  assert.ok(!/reqId !== diffRequestId\) return;/.test(store), 'ensureDiff 残留 requestId 判死（F-1 弹窗永久加载缺陷形态）');
  assert.ok(!/let diffRequestId = 0;/.test(store), '旧 diffRequestId 变量残留');
  // F-2（hb13-v review 复核改钉）：finally 身份比较清键——上一轮改钉的 `!has` 形态恒空
  //（set 同步先于异步 finally，!has 恒 false → 自身条目永不清 → 回合结束清 diffCache 后
  // 复用已结算 Promise，同 diff 永久「加载中」）；身份比较既清自身条目、又不误删后来者
  //（CHG-13「后来者不被误删」语义保持）。
  assert.match(store, /if \(inflightDiffs\.get\(inflightKey\) === promise\) inflightDiffs\.delete\(inflightKey\);/, 'finally 缺身份比较清键（!has 形态恒空 → in-flight 泄漏）');
  assert.ok(!/if \(!inflightDiffs\.has\(inflightKey\)\) inflightDiffs\.delete\(inflightKey\);/.test(store), '`!has` 恒空清键形态残留（review P2）');
  assert.ok(!/已删，无操作/.test(store), '「已删，无操作」死护栏注释残留');
  assert.match(store, /error\.value = err instanceof Error \? err\.message : '读取 diff 失败';/, '缺失败 error 态（CHG-V03）');
});

// ⑧ CHG-15 + V04。
check('⑧ CHG-15/V04：error 监听 noop 兜底 + touchedPaths memo', () => {
  assert.match(panel, /child\.on\('error', \(\) => \{\}\);/, '缺 noop 兜底');
  assert.match(store, /touchedPathsMemo/, '缺 memo');
  assert.match(store, /sessionStore\.messages\.length === touchedPathsMemo\.count\)? return touchedPathsMemo\.paths|length === touchedPathsMemo\.count\) return touchedPathsMemo\.paths;/, 'memo 命中缺短路');
  assert.match(store, /切会话清 memo/, '切会话缺清 memo');
});

// ⑨ hb12-P2-9/CHG-02。
check('⑨ CHG-02：runGitRaw execFile 与 spawnOpenWithDialog spawn 均带 windowsHide', () => {
  const gitIdx = panel.indexOf('function runGitRaw');
  const gitBody = panel.slice(gitIdx, panel.indexOf('async function runGit', gitIdx));
  assert.ok(gitBody.includes('execFile('), '未定位到 runGitRaw 的 execFile 调用');
  assert.match(gitBody, /windowsHide: true,/, 'runGitRaw execFile 缺 windowsHide');
  const spawnIdx = panel.indexOf('function spawnOpenWithDialog');
  const spawnBody = panel.slice(spawnIdx, spawnIdx + 600);
  assert.match(spawnBody, /detached: true,\s*stdio: 'ignore',\s*windowsHide: true/, 'spawnOpenWithDialog 缺 windowsHide');
});

// ⑩ hb13-v B8（F-4/F-5）：弹窗侧栏同款截断 + 切会话 watch 短路守卫。
check('⑩ B8：DiffSidebar 截断 500 + watch 回调 id+wd 未变即跳过', () => {
  assert.match(diffSidebar, /slice\(0, 500\)/, '侧栏列表未截断（F-4：万级文件弹窗路径仍全量渲染）');
  assert.match(diffSidebar, /其余/, '侧栏缺截断提示行');
  const wIdx = store.indexOf('sessionStore.activeSession?.id, sessionStore.activeSession?.workingDir');
  assert.ok(wIdx > -1, '未找到切会话 watch 源');
  const wSeg = store.slice(wIdx, wIdx + 900);
  assert.match(wSeg, /lastWatchedId/, 'watch 回调缺 id+wd 短路守卫（F-5：无关整对象替换触发冗余全量扫描）');
  assert.match(wSeg, /lastWatchedWd/, 'watch 守卫缺 workingDir 维度（同会话切 wd 仍须触发，hb12-CHG-01 不弱化）');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
