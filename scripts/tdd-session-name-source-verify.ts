// tdd-session-name-source-verify.ts
// P4 会话自动命名（计划 docs/plans/2026-10-24-web-sync-directory-naming-export-plan.md §3）契约钉：
//   A) nameSource 列 + first_input 首输入兜底（§3.2.1-1..11）；
//   B) 回复结束自动重试窗口（§3.2.2：attempts≤3 + 在飞互斥 + maybeRetrySessionNaming）。
// 分组（对齐计划 §3.2.1-11）：
//   ① deriveNameSource 存量派生（行为级：shared 纯函数直测——NULL+「会话 3」→slot；
//      NULL+任意自定义→custom；非法值按 NULL 派生；显式合法值直用）；
//   ② buildFirstInputSessionName 边界（行为级：''/纯空白→null；多行取首行；折叠空白；
//      >20 截前 19+…；恰好 20 不截）；
//   ③ updateSession 名源守卫（行为级：vm 抽取守卫块实跑——custom 不被 slot/first_input/
//      generated 覆盖；slot→first_input→generated 链放行；旧形态 isAutoSessionName 守卫
//      兼容存量保持。session-repo 依赖 electron 连接面不可直 import，vm 抽取对齐
//      tdd-bugfix-hb13-v-topic-fallback-verify makeShortInputMaskRunner 先例）；
//   ④ SESSION_UPDATE handler 置 custom（静态）；
//   ⑤ topic-analyzer：写库带 nameSource:'generated'（静态）+ isAutoNameSlot 名源判定 +
//      A 部分尝试预算/在飞互斥/maybeRetrySessionNaming（静态）；
//   ⑥ fallback 通道 upgradable 才写（静态）+ SESSION_SET_FALLBACK_NAME 五处一致
//      （ipc 常量 / preload 接口+实现 / web-bridge 表 / ipc-handlers handler+广播）。
// RED 预期（未改树）：①② 无导出符号 → FAIL；③~⑥ 全部字面缺失 → FAIL。
// 运行：npx tsx scripts/tdd-session-name-source-verify.ts（已登记 scripts/selftest-static-list.txt 尾部）

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import {
  deriveNameSource,
  isUpgradableNameSource,
  isUpgradableSession,
  buildFirstInputSessionName,
  type SessionNameSource,
} from '../src/shared/auto-session-name';
import { isAutoSessionName } from '../src/shared/auto-session-name';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

const migrations = read('src/main/database/migrations.ts');
const nameSourceModule = read('src/shared/auto-session-name.ts');
const sessionTypes = read('src/shared/types/session.ts');
const sessionRepoSrc = read('src/main/database/repositories/session-repo.ts');
const ipcTypes = read('src/shared/types/ipc.ts');
const preloadApi = read('src/preload/api.ts');
const ipcHandlers = read('src/main/ipc-handlers.ts');
const webBridge = read('src/renderer/web/web-bridge.ts');
const analyzer = read('src/main/modules/topic-analyzer.ts');
const sdkBackend = read('src/main/modules/sdk-backend.ts');
const storeSrc = read('src/renderer/stores/session-store.ts');

// ── ① deriveNameSource 存量派生（行为级） ──
console.log('=== ① deriveNameSource 存量派生 ===');
check('NULL + 「会话 3」→ slot（存量自动名行可升级）', () => {
  assert.strictEqual(deriveNameSource(null, '会话 3'), 'slot');
});
check('NULL + 任意自定义名 → custom（存量已命名行零扰动）', () => {
  assert.strictEqual(deriveNameSource(null, '会话备份'), 'custom');
  assert.strictEqual(deriveNameSource(null, '[飞书] 张三'), 'custom');
  assert.strictEqual(deriveNameSource(null, '购物清单'), 'custom');
});
check('非法存储值按 NULL 派生（脏值兜底）', () => {
  assert.strictEqual(deriveNameSource('nonsense' as SessionNameSource, '会话 3'), 'slot');
  assert.strictEqual(deriveNameSource('nonsense' as SessionNameSource, '我的会话'), 'custom');
});
check('显式合法值直用（slot/first_input/generated/custom 全值域）', () => {
  assert.strictEqual(deriveNameSource('slot', '任意名'), 'slot');
  assert.strictEqual(deriveNameSource('first_input', '任意名'), 'first_input');
  assert.strictEqual(deriveNameSource('generated', '任意名'), 'generated');
  assert.strictEqual(deriveNameSource('custom', '任意名'), 'custom');
});
check('isUpgradableNameSource：仅 slot / first_input 可升级', () => {
  assert.strictEqual(isUpgradableNameSource('slot'), true);
  assert.strictEqual(isUpgradableNameSource('first_input'), true);
  assert.strictEqual(isUpgradableNameSource('generated'), false);
  assert.strictEqual(isUpgradableNameSource('custom'), false);
});
check('isUpgradableSession：缺省名源按名称形态派生（自动名→可升级；自然名→让位）；显式值直用', () => {
  assert.strictEqual(isUpgradableSession({ name: '会话 3' }), true);
  assert.strictEqual(isUpgradableSession({ name: '会话备份' }), false);
  assert.strictEqual(isUpgradableSession({ name: '任意', nameSource: 'first_input' }), true);
  assert.strictEqual(isUpgradableSession({ name: '任意', nameSource: 'generated' }), false);
  assert.strictEqual(isUpgradableSession(null), false);
  assert.strictEqual(isUpgradableSession(undefined), false);
});

// ── ② buildFirstInputSessionName 边界（行为级） ──
console.log('=== ② buildFirstInputSessionName 边界 ===');
check("'' → null", () => assert.strictEqual(buildFirstInputSessionName(''), null));
check("'   '（纯空白）→ null", () => assert.strictEqual(buildFirstInputSessionName('   '), null));
check('多行取首行', () => {
  assert.strictEqual(buildFirstInputSessionName('修复登录页面\n第二行内容\n第三行'), '修复登录页面');
});
check('连续空白折叠为单空格', () => {
  assert.strictEqual(buildFirstInputSessionName('修复  登录\t页面 \n 问题'), '修复 登录 页面');
});
check('>20 截为前 19 字符 + …', () => {
  const twentyOne = '一二三四五六七八九十一二三四五六七八九十一'; // 21 字符
  assert.strictEqual(twentyOne.length, 21);
  // 前 19 字符 = 二十字串去末一字。
  assert.strictEqual(buildFirstInputSessionName(twentyOne), `${twentyOne.slice(0, 19)}…`);
  const got = buildFirstInputSessionName(twentyOne);
  assert.ok(got && got.length === 20 && got.endsWith('…'));
});
check('恰好 20 不截断（无 …）', () => {
  const twenty = '一二三四五六七八九十一二三四五六七八九十';
  assert.strictEqual(twenty.length, 20);
  assert.strictEqual(buildFirstInputSessionName(twenty), twenty);
});
check('emoji >20 码点截断为 19 码点 + …（无孤立代理项）', () => {
  const emoji21 = '😀'.repeat(21); // 21 码点 = 42 UTF-16 码元
  const got = buildFirstInputSessionName(emoji21);
  // 期望：前 19 个完整码点 + '…'
  assert.strictEqual(got, '😀'.repeat(19) + '…');
  // 结果每个字符仍是完整码点（Array.from 按码点切，长度应为 20 = 19 emoji + …），以 … 结尾
  assert.ok(got && Array.from(got).length === 20 && got.endsWith('…'));
});
check('emoji 恰 20 码点（UTF-16 码元 40 > 20）不截断', () => {
  const emoji20 = '😀'.repeat(20); // 20 码点 = 40 UTF-16 码元
  assert.strictEqual(buildFirstInputSessionName(emoji20), emoji20);
});
check('首行纯空白、次行有字 → 取次行有效文本（首行折叠后为空则顺延语义：trim 后空即 null 由首行决定）', () => {
  // 语义钉死：取首行 → trim；首行空即 null（不跳次行）——首输入兜底只看首行。
  assert.strictEqual(buildFirstInputSessionName('   \n第二行'), null);
});
check('sk- 密钥形态首输入 → 掩码形态（round-001 review-report FIX-1a：防密钥碎片入标题）', () => {
  // 期望输出先读 src/shared/provider-library.ts maskApiKey 实现钉死（>8 长度 → sk-…****<末4位>，
  // 输出长 12 < 20 自然免截）；掩码形态不得泄漏明文前缀。
  const got = buildFirstInputSessionName('sk-abc1234567890123456');
  assert.strictEqual(got, 'sk-…****3456');
  assert.ok(got !== null && !got.startsWith('sk-abc'), '不得泄漏明文前缀');
});

// ── ③ updateSession 名源守卫（vm 抽取守卫块实跑） ──
console.log('=== ③ updateSession 名源守卫（行为级） ===');
const guardStart = sessionRepoSrc.indexOf('if (partial.name !== undefined && isAutoSessionName(partial.name)) {');
const guardEnd = sessionRepoSrc.indexOf('const updates: string[] = [];');
check('守卫块定位成功（旧形态守卫在前、updates 组装在后）', () => {
  assert.ok(guardStart > -1, '未找到旧形态守卫起点');
  assert.ok(guardEnd > guardStart, '未找到 updates 组装点');
});
const guardSrc = sessionRepoSrc.slice(guardStart, guardEnd);
const guardJs = ts.transpileModule(guardSrc, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
// partial 以 let 重绑：守卫块对 partial 重新赋值（{ ...partial, name: undefined } 剥离形态），
// 解构 const 绑定不可赋值（「Assignment to constant variable」）。
const guardWrapper = `(function(__deps){ const { isAutoSessionName, getSession, id } = __deps; let partial = __deps.partial; ${guardJs}; return partial; })`;
function runGuards(partial: Record<string, unknown>, existing: { name: string; nameSource: SessionNameSource } | null): Record<string, unknown> {
  return vm.runInNewContext(guardWrapper, vm.createContext({}))({
    isAutoSessionName,
    getSession: () => existing,
    partial,
    id: 's1',
  }) as Record<string, unknown>;
}
check('existing=custom：slot/first_input/generated 三种自动写全部剥离（name+nameSource 双剥）', () => {
  for (const src of ['slot', 'first_input', 'generated'] as const) {
    const out = runGuards({ name: '新名', nameSource: src }, { name: '我的会话', nameSource: 'custom' });
    assert.strictEqual(out.name, undefined, `src=${src} name 未剥离`);
    assert.strictEqual(out.nameSource, undefined, `src=${src} nameSource 未剥离`);
  }
});
check('existing=custom：用户再改名（nameSource=custom）放行', () => {
  const out = runGuards({ name: '新名', nameSource: 'custom' }, { name: '我的会话', nameSource: 'custom' });
  assert.strictEqual(out.name, '新名');
  assert.strictEqual(out.nameSource, 'custom');
});
check('slot→first_input→generated 升级链放行', () => {
  const out1 = runGuards({ name: '修空调', nameSource: 'first_input' }, { name: '会话 3', nameSource: 'slot' });
  assert.strictEqual(out1.name, '修空调');
  assert.strictEqual(out1.nameSource, 'first_input');
  const out2 = runGuards({ name: '空调不制冷排查', nameSource: 'generated' }, { name: '修空调', nameSource: 'first_input' });
  assert.strictEqual(out2.name, '空调不制冷排查');
  assert.strictEqual(out2.nameSource, 'generated');
});
check('旧形态守卫兼容存量：自然名 existing + 自动形态名（无 nameSource）仍剥离', () => {
  const out = runGuards({ name: '会话 9' }, { name: '我的会话', nameSource: 'custom' });
  assert.strictEqual(out.name, undefined);
});
check('旧形态守卫放行：自动形态 existing + 自动形态名（无 nameSource）照常', () => {
  const out = runGuards({ name: '会话 9' }, { name: '会话 3', nameSource: 'slot' });
  assert.strictEqual(out.name, '会话 9');
});

// ── 结构钉：迁移 / 类型 / repo 映射 ──
console.log('=== 结构钉：迁移/类型/repo/新模块 ===');
check('migrations 自愈块含 name_source 加列（hasCol 守卫 + TEXT DEFAULT NULL）', () => {
  assert.match(migrations, /if \(!hasCol\('name_source'\)\) \{\s*db\.exec\('ALTER TABLE sessions ADD COLUMN name_source TEXT DEFAULT NULL'\);\s*\}/);
});
check('session.ts：SessionNameSource 四值类型 + Session.nameSource 必填', () => {
  assert.match(sessionTypes, /export type SessionNameSource = 'slot' \| 'first_input' \| 'generated' \| 'custom';/);
  assert.match(sessionTypes, /nameSource: SessionNameSource;/);
});
check('auto-session-name.ts：三判定函数导出（纯函数、无 electron 依赖）', () => {
  assert.match(nameSourceModule, /export function deriveNameSource\(/);
  assert.match(nameSourceModule, /export function isUpgradableNameSource\(/);
  assert.match(nameSourceModule, /export function buildFirstInputSessionName\(/);
  assert.ok(!nameSourceModule.includes('electron'));
});
check('SessionRow.name_source + toSession 派生 nameSource', () => {
  assert.match(sessionRepoSrc, /name_source: string \| null;/);
  assert.match(sessionRepoSrc, /nameSource: deriveNameSource\(row\.name_source, row\.name\)/);
});
check('createSession INSERT 落 name_source（自动形态名→slot，其余→custom）', () => {
  assert.match(sessionRepoSrc, /name_source[\s\S]{0,200}VALUES/, 'INSERT 缺 name_source 列');
  assert.match(sessionRepoSrc, /isAutoSessionName\(name\) \? 'slot' : 'custom'/, '建行名源未按名称形态派生');
});
check('updateSession Pick 列表含 nameSource + 写 name_source 列', () => {
  assert.match(sessionRepoSrc, /Pick<Session, 'name' \| 'nameSource' /);
  assert.match(sessionRepoSrc, /name_source = @nameSource/);
});

// ── ④ SESSION_UPDATE handler 置 custom（静态） ──
console.log('=== ④ SESSION_UPDATE handler 置 custom ===');
check('凡经改名通道（data.name !== undefined）一律注入 nameSource=custom', () => {
  const updIdx = ipcHandlers.indexOf('IPC_CHANNELS.SESSION_UPDATE');
  const body = ipcHandlers.slice(updIdx, updIdx + 2200);
  assert.match(body, /if \(data\.name !== undefined\) \(data as \{ nameSource\?: SessionNameSource \}\)\.nameSource = 'custom';/);
});
check('无 name 时 nameSource 被剔除（round-001 review-report FIX-1b：本通道无自动写语义，残值不照收）', () => {
  const updIdx = ipcHandlers.indexOf('IPC_CHANNELS.SESSION_UPDATE');
  const body = ipcHandlers.slice(updIdx, updIdx + 2200);
  assert.match(body, /else delete \(data as \{ nameSource\?: SessionNameSource \}\)\.nameSource;/);
});

// ── ⑤ topic-analyzer（静态：写库名源 + A 部分重试窗口） ──
console.log('=== ⑤ topic-analyzer 名源写库 + 重试窗口 ===');
check('两处写库均带 nameSource: generated（LLM 主题 + 短输入直写）', () => {
  const count = (analyzer.match(/nameSource: 'generated'/g) || []).length;
  assert.ok(count === 2, `实际 ${count} 处`);
});
check('isAutoNameSlot 改名源判定（getSession + isUpgradableNameSource）', () => {
  assert.match(analyzer, /function isAutoNameSlot\(\s*sessionId[\s\S]{0,200}isUpgradableNameSource\(\w+\.nameSource\)/);
});
check('A：模块级尝试预算 + 在飞互斥（TOPIC_MAX_ATTEMPTS=3）', () => {
  assert.match(analyzer, /const topicAttempts = new Map<string, number>\(\);/);
  assert.match(analyzer, /const topicInFlight = new Set<string>\(\);/);
  assert.match(analyzer, /const TOPIC_MAX_ATTEMPTS = 3;/);
});
check('A：analyzeTopic 入口在飞互斥 + finally 清理 + 预算超限 return null', () => {
  const idx = analyzer.indexOf('export async function analyzeTopic');
  const body = analyzer.slice(idx, analyzer.indexOf('\n}', idx));
  assert.match(body, /if \(topicInFlight\.has\(sessionId\)\) return null;/);
  assert.match(body, /topicInFlight\.add\(sessionId\)/);
  assert.match(body, /finally\s*\{\s*topicInFlight\.delete\(sessionId\);\s*\}/);
  assert.match(body, /if \(n > TOPIC_MAX_ATTEMPTS\) return null;/);
});
check('A：maybeRetrySessionNaming 导出（upgradable 才重试 + 预算/在飞双闸 + 首条 user 文本 + slot 先兜底）', () => {
  const idx = analyzer.indexOf('export function maybeRetrySessionNaming');
  assert.ok(idx > -1, '缺 maybeRetrySessionNaming 导出');
  const body = analyzer.slice(idx, analyzer.indexOf('\n}', idx));
  assert.match(body, /isUpgradableNameSource\(s\.nameSource\)/);
  assert.match(body, /\(topicAttempts\.get\(sessionId\) \?\? 0\) >= TOPIC_MAX_ATTEMPTS/);
  assert.match(body, /topicInFlight\.has\(sessionId\)/);
  assert.match(body, /getMessagesBySession\(sessionId\)/);
  assert.match(body, /role === 'user'/);
  assert.match(body, /setFirstInputFallbackName\(sessionId/);
  assert.match(body, /analyzeTopic\(sessionId/);
});
check('sdk-backend：成功 result 边沿调用 maybeRetrySessionNaming（与通知同点位 + try 隔离）', () => {
  const idx = sdkBackend.indexOf('if (event.type === \'result\' && isSuccessfulCliResult(event)) {');
  const body = sdkBackend.slice(idx, idx + 600);
  assert.ok(idx > -1, '未找到成功 result 边沿');
  assert.match(body, /notifySessionCompleted\(mainWindow, sessionId\);/);
  const notifyAt = body.indexOf('notifySessionCompleted');
  const retryAt = body.indexOf('maybeRetrySessionNaming(sessionId)');
  assert.ok(retryAt > notifyAt, '重试须在通知之后（同点位同序）');
  assert.match(body, /try\s*\{\s*maybeRetrySessionNaming\(sessionId\);\s*\}\s*catch/);
});

// ── ⑥ fallback 通道 upgradable 才写 + 五处一致（静态） ──
console.log('=== ⑥ fallback 通道 + 五处一致 ===');
check('session-repo：setFirstInputFallbackName（upgradable 才写 + 空文本不写 + first_input 落库）', () => {
  const idx = sessionRepoSrc.indexOf('export function setFirstInputFallbackName');
  assert.ok(idx > -1, '缺 setFirstInputFallbackName');
  const body = sessionRepoSrc.slice(idx, sessionRepoSrc.indexOf('\n}', idx));
  assert.match(body, /isUpgradableNameSource\(s\.nameSource\)/);
  assert.match(body, /buildFirstInputSessionName\(text\)/);
  assert.match(body, /return false/);
  assert.match(body, /nameSource: 'first_input'/);
});
// round-001 review-report FIX-1c：同值短路行为级（vm 抽取函数体实跑，复用 ③ 组形态——
// session-repo 依赖 electron 连接面不可直 import，先例同 tdd-bugfix-hb13-v-topic-fallback-verify）。
const fbIdx = sessionRepoSrc.indexOf('export function setFirstInputFallbackName');
const fbBodySrc = sessionRepoSrc.slice(
  sessionRepoSrc.indexOf('{', fbIdx) + 1,
  sessionRepoSrc.indexOf('\n}', fbIdx),
);
const fbJs = ts.transpileModule(fbBodySrc, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const fbWrapper = `(function(__deps){ const { getSession, isUpgradableNameSource, buildFirstInputSessionName, updateSession, id, text } = __deps; ${fbJs} })`;
function runFallback(existing: { nameSource: SessionNameSource; name: string } | null, text: string): { result: boolean; updates: number } {
  const state = { updates: 0 };
  const result = vm.runInNewContext(fbWrapper, vm.createContext({}))({
    getSession: () => existing,
    isUpgradableNameSource,
    buildFirstInputSessionName,
    updateSession: () => { state.updates += 1; return existing; },
    id: 's1',
    text,
  }) as boolean;
  return { result, updates: state.updates };
}
check('first_input 同值兜底名不重写（updateSession 不被调用；round-001 review-report FIX-1c）', () => {
  const out = runFallback({ nameSource: 'first_input', name: '修复登录页面' }, '修复登录页面');
  assert.strictEqual(out.result, true);
  assert.strictEqual(out.updates, 0, '同值不得重写（不写库不 bump updated_at）');
});
check('first_input 异值照常重写 + slot 首写不受影响（FIX-1c 短路不扩大影响面）', () => {
  const diff = runFallback({ nameSource: 'first_input', name: '修复登录页面' }, '新问题排查');
  assert.strictEqual(diff.result, true);
  assert.strictEqual(diff.updates, 1);
  const first = runFallback({ nameSource: 'slot', name: '会话 3' }, '修复登录页面');
  assert.strictEqual(first.result, true);
  assert.strictEqual(first.updates, 1, 'slot→first_input 首写不受短路影响');
});
check('ipc 常量：SESSION_SET_FALLBACK_NAME: session:setFallbackName', () => {
  assert.match(ipcTypes, /SESSION_SET_FALLBACK_NAME: 'session:setFallbackName',/);
});
check('preload：接口成员 + createApi 实现 + 头注释方法数同步（动态钉由 app-updater/turn-projection 契约覆盖，此处钉实现字面）', () => {
  assert.match(preloadApi, /setFallbackSessionName: \(sessionId: string, text: string\) => Promise<boolean>;/);
  assert.match(preloadApi, /setFallbackSessionName: \(sessionId, text\) => ipcRenderer\.invoke\(IPC_CHANNELS\.SESSION_SET_FALLBACK_NAME, sessionId, text\)/);
});
check('web-bridge 通道表：setFallbackSessionName 表项', () => {
  assert.match(webBridge, /setFallbackSessionName: IPC_CHANNELS\.SESSION_SET_FALLBACK_NAME,/);
});
check('ipc-handlers：新 handler 注册（非空校验 → repo 调用 → 成功广播 upsert）', () => {
  const idx = ipcHandlers.indexOf('regInvokeHandler(IPC_CHANNELS.SESSION_SET_FALLBACK_NAME');
  assert.ok(idx > -1, '缺 handler 注册');
  const body = ipcHandlers.slice(idx, ipcHandlers.indexOf('\n  });', idx));
  assert.match(body, /typeof sessionId !== 'string'/);
  assert.match(body, /typeof text !== 'string'/);
  assert.match(body, /setFirstInputFallbackName\(sessionId, text\)/);
  assert.match(body, /pushToMainWindow\(IPC_CHANNELS\.SESSIONS_CHANGED, \{ kind: 'upsert', sessionId \}\)/);
});
check('渲染层：触发先落兜底名（setFallbackSessionName 先于 analyzeTopic）+ transient 草稿 nameSource=slot + .then 双门槛名源化', () => {
  // 可选调用形态（?.）：测试 stub/降级宿主缺方法时 no-op，不破 addMessage 主链。
  const fallbackAt = storeSrc.indexOf('setFallbackSessionName?.(sessionId, textContent)');
  const analyzeAt = storeSrc.indexOf('window.claudeLink.analyzeTopic(sessionId, textContent)');
  assert.ok(fallbackAt > -1, '缺 setFallbackSessionName 触发');
  assert.ok(analyzeAt > fallbackAt, '兜底名须先于 LLM 链落库');
  // transient 草稿对象带 nameSource: 'slot'（紧随默认名「新会话」，TS 必填字段强制落点）。
  const draftAt = storeSrc.indexOf("name: '新会话',");
  assert.ok(draftAt > -1, '未找到暂态草稿对象');
  assert.ok(storeSrc.slice(draftAt, draftAt + 300).includes("nameSource: 'slot',"), '暂态草稿缺 nameSource: slot');
  assert.match(storeSrc, /isUpgradableSession\(this\.activeSession\)/);
  assert.match(storeSrc, /listItem && isUpgradableSession\(listItem\)/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
