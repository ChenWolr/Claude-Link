// tdd-mcp-manual-scan-verify.ts
// E1「MCP 手动扫描按钮（UI）+ 快照信号订阅」TDD 契约（2026-11-15 eight-issues 批次）。
// 用例正本 03b-test-cases-renderer.md §11 E1-1~5；行为契约 00-behavior-specs.md §E1；
// 实现细节 02-impl-details-renderer.md §10（E1 全量）+§13（ConfigPage 订阅消费面）；
// 计划定名 04-实施计划.md §4.1（02 §14 旧建议名 tdd-mcp-scan-button-verify ≡ 本名 tdd-mcp-manual-scan-verify）。
// 用例→断言映射：
//   E1-1 扫描钮结构 + managed 文案钉：
//     ① user/project 栏共用扫描钮——data-testid="mcp-scan-button"、v-if 非 managed、
//        :disabled="loading"+「扫描中…」、title 分栏文案（user ~/.claude.json / project .mcp.json）、
//        refresh 图标复用既有 SVG 风格（viewBox 24/stroke currentColor/linecap round/aria-hidden）；
//        位于 mcp-title-row__acts 区首部（导出钮之前）；
//     ② managed 栏负向钉——扫描钮元素带 activeScope.kind !== 'managed' 排除守卫（managed 渲染树
//        恒无钮）+ scopeNoteHead managed 分支文案补句「link 配置实时生效，无需扫描。」；
//     ③ 通道条件钉（已裁定=复用 MCP_SNAPSHOT_GET 扩参，无新 invoke 通道申报）——McpSettings.vue
//        与 ConfigPage.vue 全文零 IPC_CHANNELS 引用（通道常量只归 preload/web-bridge，E2 域钉）；
//   E1-2 扫描 action 序列钉（SFC 不可行为实例化——仓库无 @vue/test-utils，03b §11 E1-2 自身
//        降级条款「否则 [钉]」；①清缓存→重拉→整替序列：scope await 前捕获+managed 早退，
//        before 计数先于 await refresh({bypassCache:true,dir?})（主进程 bypass 分支清负缓存+
//        mtime 缓存，渲染侧钉透传形态），after 计数 await 后取；②失败路径：loadError 非空
//        →pushToast('扫描失败，详见错误提示条') 并跳过计数（02 §10.3 裁定）+ 既有 finally
//        loading 复位保留；③disposed 守卫 await 后补（02 §10.4）；既有无参调用点 wire 形态
//        不变=带参调用恰 manualScan 一处、getMcpSnapshot 非 bypass 分支仍传 undefined；
//   E1-3 反馈形态钉——scanFeedbackText ±N 三态文案字面（新增 N 台/移除 N 台/无变化（共 N 台），
//        数字反馈面与 Skill「+N」徽标先例同形）+ manualScan pushToast 消费链 + mcp-toast-wrap
//        载体回归钉；
//   E1-4 白名单接线钉——项目栏 dir 恒取 activeScope.path（manualScan 唯一 dir 实参形态
//        `scope.kind === 'project' ? scope.path : undefined`，scope 源自 activeScope.value 捕获）；
//        rail 目录列表 v-for=projectDirs（快照目录集投影=主进程白名单集）；渲染层零任意路径
//        输入入口（无 prompt）；E4 目录集口径归 tdd-mcp-skill-dirset-unify-verify，本卷不重复；
//        〔申报 round-006 R6-2②〕E1-4① 行为条款：判据为 handler 内联不可注入，『（可注入时）』条件未达成，以 E1-4a/b/c 接线钉+E1-4c 零越界入口负向钉+external-change-watch ⑪ 白名单切片钉兜底（round-006 R6-2 申报）；
//   E1-5 网页端结构面 + ConfigPage 订阅消费面——web-bridge getMcpSnapshot/onMcpSnapshotChanged
//        双键回归钉（E2 落地面防拆除）；扫描链零 isWebRuntime 平台分支（双端同源渲染）；
//        ConfigPage stopMcpSnapshotChanged onMounted 订阅（tab 门控：活跃 mcp → refresh 重拉 /
//        非活跃 → mcpStalePending=true）+ activeTab watch mcp 分支复位 false（进 tab 既有 refresh
//        兜底）+ onBeforeUnmount 反注册（stop 句柄 + removeMcpSnapshotListener）；
//        CDP 场景 W-mcp-scan 归 T1B 点（03b §11 E1-5 执行命令形态 npm run test:cdp:web-access），
//        本卷不写链；
//   REG  回归门——spawnSync 实跑 scripts/selftest-mcp-settings.ts exit 0（A~Q 组 sanitize/parse/
//        merge/脱敏/mtime 缓存/三态文案/卡片化/编辑器/表单 JSON/导入收口/探活契约与本点互证，
//        refresh 扩参不得破坏既有 106 断言面）。
// seam：纯源码钉（readFileSync McpSettings.vue/ConfigPage.vue/web-bridge.ts + 花括号配平函数
//   切片）；无模块加载、无 electron、无 fs 写副作用（REG spawn 为唯一子进程，只读契约）。
// RED 预期（未实现树）：E1-1①②③、E1-2、E1-3、E1-4、E1-5 的新钉全 FAIL；回归钉
//   （refresh finally 复位/mcp-toast-wrap/rail v-for/web-bridge 双键）现状绿。
// 运行：npx tsx scripts/tdd-mcp-manual-scan-verify.ts（登记 scripts/selftest-static-list.txt 尾部）。
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { strict as assert } from 'node:assert';

const repoRoot = path.resolve(__dirname, '..');

function readRel(p: string): string {
  return fs.readFileSync(path.resolve(repoRoot, p), 'utf8');
}

const mcpSrc = readRel('src/renderer/components/config/McpSettings.vue');
const pageSrc = readRel('src/renderer/pages/ConfigPage.vue');
const bridgeSrc = readRel('src/renderer/web/web-bridge.ts');

let pass = 0;
let fail = 0;
/** assert 回调风格用例（tdd-mcp-import-skip-visible-verify 同款）：抛错即 FAIL，消息进失败行。 */
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.split('\n')[0]}`); }
}

/** 花括号配平函数切片：从 anchor 首个 '{' 起配平到闭合 '}'（字符串字面量粗跳过：引号内
 *  花括号不计数——McpSettings 模板串含 {...} 形态的函数体不适用本 helper，仅用于 script 区）。 */
function fnSlice(src: string, anchor: string): string {
  const start = src.indexOf(anchor);
  if (start < 0) return '';
  const open = src.indexOf('{', start + anchor.length - 1);
  if (open < 0) return '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

// ── E1-1 扫描钮结构 + managed 文案钉 ─────────────────────────────────────────
console.log('\n=== E1-1 扫描钮结构 + managed 文案钉 ===');

/** 扫描钮元素切片（data-testid 锚 → 回溯 <button / 前进 </button>）。 */
function scanButtonSlice(): string {
  const at = mcpSrc.indexOf('data-testid="mcp-scan-button"');
  if (at < 0) return '';
  const btnStart = mcpSrc.lastIndexOf('<button', at);
  const btnEnd = mcpSrc.indexOf('</button>', at);
  if (btnStart < 0 || btnEnd < 0 || btnEnd < btnStart) return '';
  return mcpSrc.slice(btnStart, btnEnd + '</button>'.length);
}

check('E1-1a 扫描钮存在：data-testid="mcp-scan-button" 全文件恰 1 处', () => {
  const n = mcpSrc.split('data-testid="mcp-scan-button"').length - 1;
  assert.equal(n, 1, `出现 ${n} 次（期望恰 1）`);
});

check('E1-1b 扫描钮 v-if 排除 managed（managed 栏负向钉的机制面）', () => {
  const btn = scanButtonSlice();
  assert.ok(btn, '扫描钮元素切片定位失败');
  assert.ok(btn.includes(`v-if="activeScope.kind !== 'managed'"`), '缺 v-if="activeScope.kind !== \'managed\'" 排除守卫');
});

check('E1-1c loading 态：:disabled="loading" + 「扫描中…」与「扫描」双态文案', () => {
  const btn = scanButtonSlice();
  assert.ok(btn, '扫描钮元素切片定位失败');
  assert.ok(btn.includes(':disabled="loading"'), '缺 :disabled="loading"');
  assert.ok(btn.includes('扫描中…'), '缺 loading 文案「扫描中…」');
  assert.ok(/>\s*扫描\s*</.test(btn) || btn.includes("{{ loading ? '扫描中…' : '扫描' }}"), '缺就绪文案「扫描」');
});

check('E1-1d title 分栏文案：user ~/.claude.json / project .mcp.json 双字面', () => {
  const btn = scanButtonSlice();
  assert.ok(btn, '扫描钮元素切片定位失败');
  assert.ok(btn.includes('activeScope.kind === \'user\''), 'title 绑定缺 user 分支判定');
  assert.ok(btn.includes('清除缓存并重扫 ~/.claude.json'), '缺 user 栏 title 文案');
  assert.ok(btn.includes('清除该目录负缓存并重扫 .mcp.json'), '缺 project 栏 title 文案');
});

check('E1-1e refresh 图标复用既有 SVG 风格（viewBox 24/stroke currentColor/linecap round/aria-hidden）', () => {
  const btn = scanButtonSlice();
  assert.ok(btn, '扫描钮元素切片定位失败');
  const svgAt = btn.indexOf('<svg');
  assert.ok(svgAt > -1, '缺 <svg 图标');
  const svg = btn.slice(svgAt, btn.indexOf('>', svgAt) + 1);
  assert.ok(svg.includes('viewBox="0 0 24 24"'), 'svg 缺 viewBox="0 0 24 24"');
  assert.ok(svg.includes('fill="none"'), 'svg 缺 fill="none"');
  assert.ok(svg.includes('stroke="currentColor"'), 'svg 缺 stroke="currentColor"');
  assert.ok(svg.includes('stroke-linecap="round"'), 'svg 缺 stroke-linecap="round"');
  assert.ok(btn.includes('aria-hidden="true"'), 'svg 缺 aria-hidden="true"');
});

check('E1-1f 扫描钮位于 mcp-title-row__acts 区首部（导出钮之前）', () => {
  const actsAt = mcpSrc.indexOf('mcp-title-row__acts');
  assert.ok(actsAt > -1, 'mcp-title-row__acts 区定位失败');
  const actsEnd = mcpSrc.indexOf('</span>', actsAt);
  assert.ok(actsEnd > actsAt, 'acts 区闭合定位失败');
  const acts = mcpSrc.slice(actsAt, actsEnd);
  const scanAt = acts.indexOf('data-testid="mcp-scan-button"');
  const exportAt = acts.indexOf('@click="exportScopeJson"');
  assert.ok(scanAt > -1, '扫描钮不在 acts 区内');
  assert.ok(exportAt > -1, '导出钮不在 acts 区内（结构漂移）');
  assert.ok(scanAt < exportAt, '扫描钮不在 acts 区首部（应先于导出钮）');
});

check('E1-1g managed 说明文案补句：「link 配置实时生效，无需扫描。」在 scopeNoteHead managed 分支', () => {
  const fn = fnSlice(mcpSrc, 'const scopeNoteHead = computed<string>(() => {');
  assert.ok(fn, 'scopeNoteHead computed 切片定位失败');
  const managedBr = fn.indexOf("activeScope.value.kind === 'managed'");
  assert.ok(managedBr > -1, '缺 managed 分支');
  const brEnd = fn.indexOf('}', managedBr);
  const managedSeg = fn.slice(managedBr, brEnd > managedBr ? brEnd : undefined);
  assert.ok(managedSeg.includes('link 配置实时生效，无需扫描。'), 'managed 分支缺补句「link 配置实时生效，无需扫描。」');
});

check('E1-1h 通道条件钉：McpSettings.vue 与 ConfigPage.vue 渲染面零 IPC_CHANNELS 引用（无新 invoke 通道申报）', () => {
  assert.equal(mcpSrc.split('IPC_CHANNELS.').length - 1, 0, 'McpSettings.vue 出现 IPC_CHANNELS 引用');
  assert.equal(pageSrc.split('IPC_CHANNELS.').length - 1, 0, 'ConfigPage.vue 出现 IPC_CHANNELS 引用');
});

// ── E1-2 扫描 action 序列钉（SFC 不可实例化 → 03b §11 E1-2 降级条款 [钉]）──────
console.log('\n=== E1-2 扫描 action 序列钉（清缓存→重拉→整替；失败 loading 复位） ===');

const scanFn = fnSlice(mcpSrc, 'async function manualScan(): Promise<void> {');

check('E1-2a manualScan 函数存在', () => {
  assert.ok(scanFn, '缺 async function manualScan(): Promise<void>');
});

check('E1-2b scope await 前捕获 + managed 早退（先于计数与 refresh）', () => {
  assert.ok(scanFn, 'manualScan 缺席');
  const capAt = scanFn.indexOf('const scope = activeScope.value;');
  const retAt = scanFn.indexOf("if (scope.kind === 'managed') return;");
  const beforeAt = scanFn.indexOf('const before = scopeEntryCount(snapshot.value, scope);');
  const awaitAt = scanFn.indexOf('await refresh(');
  assert.ok(capAt > -1, '缺 const scope = activeScope.value; 捕获');
  assert.ok(retAt > capAt, 'managed 早退应在 scope 捕获之后');
  assert.ok(beforeAt > retAt, 'before 计数应在 managed 早退之后');
  assert.ok(awaitAt > beforeAt, 'await refresh 应在 before 计数之后（序列：捕获→早退→计数→重拉）');
});

check('E1-2c 清缓存→重拉→整替：before 计数 < await refresh({ bypassCache: true, dir? }) < after 计数', () => {
  assert.ok(scanFn, 'manualScan 缺席');
  const beforeAt = scanFn.indexOf('const before = scopeEntryCount(snapshot.value, scope);');
  const awaitAt = scanFn.indexOf('await refresh({ bypassCache: true, dir: scope.kind === \'project\' ? scope.path : undefined });');
  const afterAt = scanFn.indexOf('const after = scopeEntryCount(snapshot.value, scope);');
  assert.ok(beforeAt > -1, '缺 before 计数');
  assert.ok(awaitAt > -1, '缺 bypass 带参 refresh 调用（清负缓存/mtime→重拉合成一次调用）');
  assert.ok(afterAt > awaitAt, 'after 计数应在 await refresh 之后（整替后取新快照计数）');
  assert.ok(beforeAt < awaitAt && awaitAt < afterAt, '序列乱序');
});

check('E1-2d disposed 守卫 await 后补（02 §10.4：卸载后 pushToast 不触发）', () => {
  assert.ok(scanFn, 'manualScan 缺席');
  const awaitAt = scanFn.indexOf('await refresh(');
  const disposedAt = scanFn.indexOf('if (disposed) return;');
  assert.ok(awaitAt > -1 && disposedAt > awaitAt, 'await refresh 之后缺 if (disposed) return; 守卫');
});

check('E1-2e 失败分支：loadError 非空 → pushToast(\'扫描失败，详见错误提示条\') + return（跳过计数）', () => {
  assert.ok(scanFn, 'manualScan 缺席');
  const disposedAt = scanFn.indexOf('if (disposed) return;');
  const errAt = scanFn.indexOf('if (loadError.value)');
  assert.ok(errAt > disposedAt, 'loadError 分支应在 disposed 守卫之后');
  const errSeg = scanFn.slice(errAt);
  assert.ok(errSeg.includes("pushToast('扫描失败，详见错误提示条')"), '缺失败 toast 字面');
  const afterErr = errSeg.indexOf('return;');
  assert.ok(afterErr > -1, '失败分支缺 return 收束（跳过计数）');
  const afterAt = scanFn.indexOf('const after = scopeEntryCount(snapshot.value, scope);');
  assert.ok(afterAt > errAt, 'after 计数应在失败分支之后（失败即跳过计数）');
  assert.ok(scanFn.indexOf('pushToast(scanFeedbackText(before, after))') > scanFn.indexOf('const after ='), '成功反馈应在 after 计数之后');
});

check('E1-2f refresh 签名扩参 opts?: { bypassCache?: boolean; dir?: string }', () => {
  assert.ok(mcpSrc.includes('async function refresh(opts?: { bypassCache?: boolean; dir?: string }): Promise<void> {'),
    'refresh 签名未扩参或形态漂移');
});

check('E1-2g getMcpSnapshot 透传：bypass → { bypassCache: true, dir: opts.dir }；非 bypass → undefined（wire 形态不变）', () => {
  assert.ok(mcpSrc.includes('await claude.getMcpSnapshot(opts?.bypassCache ? { bypassCache: true, dir: opts.dir } : undefined);'),
    'getMcpSnapshot 调用未按 §10.2 形态扩参');
});

check('E1-2h 既有 finally loading 复位保留（失败路径 loading 不卡死）', () => {
  const refreshFn = fnSlice(mcpSrc, 'async function refresh(opts?: { bypassCache?: boolean; dir?: string }): Promise<void> {');
  assert.ok(refreshFn, 'refresh 函数切片定位失败（签名漂移）');
  assert.ok(refreshFn.includes('loading.value = true;'), 'refresh 缺 loading 置真');
  assert.ok(/}\s*finally\s*{[\s\S]*?if \(gen === refreshGen\) loading\.value = false;/.test(refreshFn), 'refresh finally 缺代际守卫 loading 复位');
});

check('E1-2i 带参调用恰 1 处（manualScan）；既有调用点保持无参 wire 形态', () => {
  const n = mcpSrc.split('refresh({ bypassCache').length - 1;
  assert.equal(n, 1, `refresh({ bypassCache 调用出现 ${n} 次（期望恰 1=manualScan）`);
  const pageN = pageSrc.split('refresh?.({').length - 1;
  assert.equal(pageN, 0, 'ConfigPage 出现带参 refresh 调用（既有消费面应保持无参）');
});

check('E1-2j scopeEntryCount：null→0 / user=userServers.length / project=匹配目录 servers.length', () => {
  const fn = fnSlice(mcpSrc, 'function scopeEntryCount(');
  assert.ok(fn, '缺 function scopeEntryCount');
  assert.ok(fn.includes('if (!snap) return 0;'), '缺 null snap 兜底 0');
  assert.ok(fn.includes("if (scope.kind === 'user') return snap.userServers.length;"), '缺 user 分支 userServers.length');
  assert.ok(fn.includes('snap.projectDirs.find((d) => normalizeDirKey(d.path) === normalizeDirKey(scope.path))?.servers.length ?? 0'),
    '缺 project 分支匹配目录 servers.length（normalizeDirKey 双侧归一）');
});

// ── E1-3 反馈形态钉 ──────────────────────────────────────────────────────────
console.log('\n=== E1-3 扫描完成可见反馈（±N 三态） ===');

const feedbackFn = fnSlice(mcpSrc, 'function scanFeedbackText(');

check('E1-3a scanFeedbackText 存在且 delta 计算', () => {
  assert.ok(feedbackFn, '缺 function scanFeedbackText');
  assert.ok(feedbackFn.includes('const delta = after - before;'), '缺 delta 计算');
});

check('E1-3b 三态文案字面：新增 N 台 / 移除 N 台 / 无变化（共 N 台）', () => {
  assert.ok(feedbackFn, 'scanFeedbackText 缺席');
  assert.ok(feedbackFn.includes('`扫描完成：新增 ${delta} 台服务器`'), '缺新增分支字面');
  assert.ok(feedbackFn.includes('`扫描完成：移除 ${-delta} 台服务器`'), '缺移除分支字面');
  assert.ok(feedbackFn.includes('`扫描完成，清单无变化（共 ${after} 台）`'), '缺无变化分支字面');
  assert.ok(feedbackFn.includes('delta > 0') && feedbackFn.includes('delta < 0'), '缺 ±N 分支判定');
});

check('E1-3c toast 载体回归钉：mcp-toast-wrap 既有面保留', () => {
  assert.ok(mcpSrc.includes('mcp-toast-wrap'), 'mcp-toast-wrap 载体缺失');
});

// ── E1-4 白名单接线钉 ────────────────────────────────────────────────────────
console.log('\n=== E1-4 项目栏白名单接线（目录集语义归 E4，不重复） ===');

check('E1-4a 项目栏 dir 恒取 activeScope.path：manualScan dir 实参唯一形态 scope.path', () => {
  assert.ok(scanFn, 'manualScan 缺席');
  assert.ok(scanFn.includes("dir: scope.kind === 'project' ? scope.path : undefined"), 'dir 实参非 activeScope 捕获态');
  assert.equal(scanFn.split('scope.path').length - 1, 1, 'manualScan 内 scope.path 出现多次（应恰 dir 实参 1 处）');
});

check('E1-4b rail 目录列表来自快照目录集（projectDirs computed = snapshot 投影）', () => {
  assert.ok(mcpSrc.includes('v-for="dir in projectDirs"'), 'rail 缺 projectDirs 循环');
  assert.ok(mcpSrc.includes('const projectDirs = computed<McpProjectDirView[]>(() => snapshot.value?.projectDirs ?? []);'),
    'projectDirs 非快照目录集投影（白名单接线漂移）');
});

check('E1-4c 渲染层零越界入口：扫描链无任意路径输入（prompt 零出现）', () => {
  assert.equal(mcpSrc.split('prompt(').length - 1, 0, 'McpSettings.vue 出现 prompt( 调用');
});

// ── E1-5 网页端结构面 + ConfigPage 订阅消费面 ────────────────────────────────
console.log('\n=== E1-5 网页端结构面 + ConfigPage 快照信号订阅 ===');

check('E1-5a web-bridge 双键回归钉（getMcpSnapshot/onMcpSnapshotChanged 各恰 1 处）', () => {
  assert.equal(bridgeSrc.split('getMcpSnapshot: IPC_CHANNELS.MCP_SNAPSHOT_GET').length - 1, 1, 'web-bridge getMcpSnapshot 键缺失或漂移');
  assert.equal(bridgeSrc.split('onMcpSnapshotChanged: IPC_CHANNELS.MCP_SNAPSHOT_CHANGED').length - 1, 1, 'web-bridge onMcpSnapshotChanged 键缺失或漂移');
});

check('E1-5b 扫描链双端同源：McpSettings.vue 零 isWebRuntime 平台分支', () => {
  assert.equal(mcpSrc.split('isWebRuntime').length - 1, 0, 'McpSettings.vue 出现 isWebRuntime（扫描/反馈应双端同源）');
});

check('E1-5c ConfigPage 订阅：stopMcpSnapshotChanged = onMcpSnapshotChanged，tab 门控活跃重拉/非活跃标 stale', () => {
  const subAt = pageSrc.indexOf('stopMcpSnapshotChanged = window.claudeLink.onMcpSnapshotChanged(');
  assert.ok(subAt > -1, '缺 onMcpSnapshotChanged 订阅');
  const cbOpen = pageSrc.indexOf('(', subAt + 'stopMcpSnapshotChanged = window.claudeLink.onMcpSnapshotChanged'.length);
  let depth = 0;
  let cbEnd = -1;
  for (let i = cbOpen; i < pageSrc.length; i++) {
    const ch = pageSrc[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) { cbEnd = i; break; } }
  }
  assert.ok(cbEnd > cbOpen, '订阅回调配平失败');
  const cb = pageSrc.slice(subAt, cbEnd);
  assert.ok(cb.includes("if (activeTab.value === 'mcp') void mcpSettingsRef.value?.refresh?.();"), '活跃分支缺 refresh 重拉');
  assert.ok(cb.includes('else mcpStalePending.value = true;'), '非活跃分支缺 mcpStalePending=true');
});

check('E1-5d mcpStalePending 声明（ref(false)）', () => {
  assert.ok(pageSrc.includes('const mcpStalePending = ref(false);'), '缺 const mcpStalePending = ref(false);');
});

check('E1-5e activeTab watch mcp 分支复位 mcpStalePending=false + 既有 refresh 兜底', () => {
  const watchAt = pageSrc.indexOf('watch(activeTab, (tab) => {');
  assert.ok(watchAt > -1, 'activeTab watch 定位失败');
  const brOpen = pageSrc.indexOf('{', watchAt);
  let depth = 0;
  let brEnd = -1;
  for (let i = brOpen; i < pageSrc.length; i++) {
    const ch = pageSrc[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { brEnd = i; break; } }
  }
  assert.ok(brEnd > brOpen, 'watch 回调配平失败');
  const watchFn = pageSrc.slice(brOpen, brEnd + 1);
  const mcpAt = watchFn.indexOf("if (tab === 'mcp')");
  assert.ok(mcpAt > -1, 'watch 缺 mcp 分支');
  const mcpBr = watchFn.slice(mcpAt, mcpAt + 300);
  assert.ok(mcpBr.includes('mcpStalePending.value = false;'), 'mcp 分支缺 stale 复位');
  assert.ok(mcpBr.includes('void mcpSettingsRef.value?.refresh?.();'), 'mcp 分支缺既有 refresh 兜底');
});

check('E1-5f onBeforeUnmount 反注册：stop 句柄 + removeMcpSnapshotListener', () => {
  // ConfigPage 有多个 onBeforeUnmount 块：取含既有 skill 反注册句的那个（订阅生命周期块）。
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const unbAt = pageSrc.indexOf('onBeforeUnmount(() => {', from);
    if (unbAt < 0) break;
    const brOpen = pageSrc.indexOf('{', unbAt);
    let depth = 0;
    let brEnd = -1;
    for (let i = brOpen; i < pageSrc.length; i++) {
      const ch = pageSrc[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { brEnd = i; break; } }
    }
    if (brEnd > brOpen) blocks.push(pageSrc.slice(brOpen, brEnd + 1));
    from = unbAt + 1;
  }
  const unb = blocks.find((b) => b.includes('stopSkillDirsChanged?.();'));
  assert.ok(unb, '含 skill 反注册句的 onBeforeUnmount 块定位失败');
  assert.ok(unb.includes('stopMcpSnapshotChanged?.();'), '缺 stopMcpSnapshotChanged 反注册');
  assert.ok(unb.includes('window.claudeLink.removeMcpSnapshotListener();'), '缺通道级 removeMcpSnapshotListener 反注册');
});

// ── REG 回归门：既有 McpSettings 契约不被波及 ────────────────────────────────
console.log('\n=== REG 回归门（spawnSync 实跑 selftest-mcp-settings） ===');
{
  const r = spawnSync('npx', ['tsx', 'scripts/selftest-mcp-settings.ts'], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-4).join('\n');
  check('REG-1 selftest-mcp-settings exit 0（A~Q 组全绿互证）', () => {
    assert.equal(r.status, 0, `退出码 ${r.status}\n${tail}`);
  });
}

console.log(`\n===== tdd-mcp-manual-scan-verify: ${pass} pass / ${fail} fail =====`);
if (fail > 0) process.exit(1);
