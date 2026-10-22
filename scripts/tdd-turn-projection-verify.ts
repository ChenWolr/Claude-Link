// tdd-turn-projection-verify.ts
// 「回合流式投影 + 标题质量」SA-1 段契约钉：主进程投影模块（turn-projection）+ 挂点
//（forwardEvent/forwardTransient 单点收口 noteTurnEvent、三终态 turn_ended、
// markSessionDeleted 收口 clearSession）+ 回合起点 turn_started 双发射点
//（CHAT_SEND user / popExecute queue）+ cli.ts 两伴生事件类型。
// SA-2 段增补：快照/概览只读查询协议三处同步（ipc.ts 通道 + ipc-handlers 注册 +
// preload/api.ts 方法与镜像类型 + web-bridge 表键）+ persistCliEvent 显式跳过 case。
// SA-4 段增补：标题质量四处（P6：prompt 强化 / 短输入跳过 / 兜底不落库 / 写库后补推送）
// + P5 恢复接线两步（web-bridge runRealignSequence + ChatPage onMounted 各拉概览与快照）。
// round-002 FIX-A 增补（round-001 R1/R2/R3，见 §8）：三非 kill 终态出口 + finishKill
// wasCurrent 投影收口 / toolIndexKeys 命名空间键两侧同规则 / resendUserText 第三
// turn_started 发射点（§3 计数钉随之由「0 处」改「恰好 1 处」）。
// round-002 FIX-B 增补（round-001 R4-R9，见 §7/§9）：applyRuntimeSnapshot 瞬态后置于
// markRunning（R4）/ markRunning generation 递增收窄至新回合边界（R7）/ 快照 tool 路
// sub: 过滤（R8）/ 耗时兜底双点 serverClockOffset 换算（R6）/ TOPIC_PROMPT_PREFIX
// 全角标点钉（R5，§7）/ App.vue 先订阅后 loadConfig 顺序钉（R9）。
//
// 全部为纯 node:assert/计数 check 的源码文本/结构断言，不 import Electron。
// 既有事件流不变以「关键既有调用行原文仍在原函数段内 + 段内顺序不变」钉住
//（见 §5；实现期间另经 git diff 人工核对无既有行删除）。
//
// 运行：npx tsx scripts/tdd-turn-projection-verify.ts（已追加 selftest-static-list.txt 尾部）

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as assert from 'node:assert';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i > -1) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}
/** 提取顶层函数段：从签名出现处到其后第一个列 0 的 '}'（本仓库顶层函数收口风格）。 */
function topLevelFunction(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start === -1) return '';
  const end = src.indexOf('\n}', start);
  if (end === -1) return '';
  return src.slice(start, end);
}

const tpPath = path.join(repoRoot, 'src', 'main', 'modules', 'turn-projection.ts');
const turnProjection = fs.existsSync(tpPath) ? fs.readFileSync(tpPath, 'utf8') : '';
const sdkBackend = read('src/main/modules/sdk-backend.ts');
const handlers = read('src/main/ipc-handlers.ts');
const taskQueue = read('src/main/modules/task-queue-engine.ts');
const cliTypes = read('src/shared/types/cli.ts');
const cliShared = read('src/main/modules/cli-shared.ts');
const ipcTypes = read('src/shared/types/ipc.ts');
const preloadApi = read('src/preload/api.ts');
const webBridge = read('src/renderer/web/web-bridge.ts');

// ── §1 投影模块：文件 + 导出面 + 上限常量 ─────────────────────────────
console.log('=== 1) turn-projection.ts：模块存在 + 七函数导出面 + 上限常量 ===');
check('turn-projection.ts 存在', turnProjection !== '');
for (const fn of [
  'noteTurnStarted',
  'noteTurnEvent',
  'getSnapshot',
  'getRunningOverview',
  'noteTurnEnded',
  'clearSession',
  'reset',
] as const) {
  check(`导出 ${fn}`, new RegExp(`export function ${fn}\\(`).test(turnProjection));
}
check('终态清理常量 60000（60s 迟到快照保留窗）', turnProjection.includes('60000'));
check('文本/思考累积上限 2 * 1024 * 1024（2MiB）', turnProjection.includes('2 * 1024 * 1024'));
check('单 tool 值上限 512 * 1024（512KiB）', turnProjection.includes('512 * 1024'));
check('超限截断标志 truncatedText 存在', turnProjection.includes('truncatedText'));
check('generation 字段（复用 query 代际防旧回合污染）', turnProjection.includes('generation'));
check('三路累积器字段 streamText/streamThinking/streamTool 齐备',
  turnProjection.includes('streamText') && turnProjection.includes('streamThinking') && turnProjection.includes('streamTool'));
check('瞬态字段 apiRetry/stalled/backgroundTasks 齐备',
  turnProjection.includes('apiRetry') && turnProjection.includes('stalled') && turnProjection.includes('backgroundTasks'));

// ── §2 sdk-backend 挂点：noteTurnEvent 单点收口 + 三终态 turn_ended ──────
console.log('=== 2) sdk-backend.ts：forwardEvent/forwardTransient 挂点 + 三终态 turn_ended ===');
const forwardEventSeg = topLevelFunction(sdkBackend, 'function forwardEvent(');
const forwardTransientSeg = topLevelFunction(sdkBackend, 'function forwardTransient(');
const killProcessSeg = topLevelFunction(sdkBackend, 'export function killProcess(');
const markDeletedSeg = topLevelFunction(sdkBackend, 'export function markSessionDeleted(');
check('forwardEvent 段提取非空', forwardEventSeg !== '');
check('forwardTransient 段提取非空', forwardTransientSeg !== '');
check('sdk-backend 从 ./turn-projection 导入投影函数', sdkBackend.includes("from './turn-projection'"));

const pushChatLine = 'pushToMainWindow(IPC_CHANNELS.CHAT_EVENT, { sessionId, event });';
check('forwardEvent 段内 pushToMainWindow(CHAT_EVENT) 原样存在', forwardEventSeg.includes(pushChatLine));
check('forwardTransient 段内 pushToMainWindow(CHAT_EVENT) 原样存在', forwardTransientSeg.includes(pushChatLine));
check('forwardEvent 段内 noteTurnEvent(sessionId, event) 恰好一处',
  countOccurrences(forwardEventSeg, 'noteTurnEvent(sessionId, event)') === 1,
  `实际 ${countOccurrences(forwardEventSeg, 'noteTurnEvent(sessionId, event)')}`);
check('forwardTransient 段内 noteTurnEvent(sessionId, event) 恰好一处',
  countOccurrences(forwardTransientSeg, 'noteTurnEvent(sessionId, event)') === 1,
  `实际 ${countOccurrences(forwardTransientSeg, 'noteTurnEvent(sessionId, event)')}`);
check('forwardEvent 段内 noteTurnEvent 位于 pushToMainWindow 之后',
  forwardEventSeg.indexOf(pushChatLine) < forwardEventSeg.indexOf('noteTurnEvent(sessionId, event)'));
check('forwardTransient 段内 noteTurnEvent 位于 pushToMainWindow 之后',
  forwardTransientSeg.indexOf(pushChatLine) < forwardTransientSeg.indexOf('noteTurnEvent(sessionId, event)'));
check('全文件 noteTurnEvent(sessionId, event) 恰好两处（仅上述两挂点）',
  countOccurrences(sdkBackend, 'noteTurnEvent(sessionId, event)') === 2,
  `实际 ${countOccurrences(sdkBackend, 'noteTurnEvent(sessionId, event)')}`);

check('turn_ended 唯一构造点 emitTurnEnded 收口函数存在', /function emitTurnEnded\(/.test(sdkBackend));
const emitTurnEndedSeg = topLevelFunction(sdkBackend, 'function emitTurnEnded(');
check("turn_ended 事件字面全文件恰好 2 处（emitTurnEnded 的权威/近似两分支）且不出收口函数",
  countOccurrences(sdkBackend, "type: 'turn_ended'") === 2 &&
  countOccurrences(emitTurnEndedSeg, "type: 'turn_ended'") === 2,
  `全文件 ${countOccurrences(sdkBackend, "type: 'turn_ended'")} / 段内 ${countOccurrences(emitTurnEndedSeg, "type: 'turn_ended'")}`);
// 终态① result：forwardEvent 的 result 钩子段内发射。
check('result 终态：forwardEvent 段内 result 钩子仍存在', forwardEventSeg.includes("event.type === 'result'"));
check('result 终态：forwardEvent 段内 emitTurnEnded(sessionId, outcome, …) 发射',
  forwardEventSeg.includes('emitTurnEnded(sessionId, outcome,'));
check('result 终态：emitTurnEnded 序在 result 判定之后',
  forwardEventSeg.indexOf("event.type === 'result'") < forwardEventSeg.indexOf('emitTurnEnded(sessionId, outcome,'));
// 终态② killProcess 合成 aborted。
const abortedLine = "forwardEvent(sessionId, mainWindow, { type: 'aborted', message: '已中断' });";
check('killProcess 段内合成 aborted 原样存在', killProcessSeg.includes(abortedLine));
check("killProcess 终态：emitTurnEnded(sessionId, 'interrupted', …) 发射",
  killProcessSeg.includes("emitTurnEnded(sessionId, 'interrupted',"));
check('killProcess 终态：emitTurnEnded 序在合成 aborted 之后',
  killProcessSeg.indexOf(abortedLine) < killProcessSeg.indexOf("emitTurnEnded(sessionId, 'interrupted',"));
// 终态③ runQuery catch 的 error 发射点（SDK 执行出错）。
// 锚点唯一化：`const msg = err instanceof ...`（err 变量名）区分于 resume 重试失败分支
//（retryErr 变量名）的同类文案行——本终态锚定 P2-1 兜底后的真实 SDK 错误出口。
const errorAnchor = 'const msg = err instanceof Error ? err.message : String(err);';
const errorAnchorIdx = sdkBackend.indexOf(errorAnchor);
const errorEmitLine = 'forwardEvent(sessionId, mainWindow, { type: \'error\', message: `SDK 执行出错：${msg}` });';
const errorEmitIdx = errorAnchorIdx === -1 ? -1 : sdkBackend.indexOf(errorEmitLine, errorAnchorIdx);
check('error 终态：SDK 执行出错 error 发射点原样存在', errorEmitIdx !== -1);
// R1（round-001）：出口⑤（resume 重试失败）/出口⑥（启动外层 catch）新增的 error 终态发射点
// 位于本锚点（出口④）之前——首现式 indexOf 会先命中新点而误报间距/缺失，改为从 error 发射点
// 之后搜索（语义不变：紧随本出口的 emitTurnEnded 仍被钉住）。
const errorTurnEndedIdx = errorEmitIdx === -1 ? -1 : sdkBackend.indexOf("emitTurnEnded(sessionId, 'error',", errorEmitIdx);
check("error 终态：emitTurnEnded(sessionId, 'error', …) 发射", errorTurnEndedIdx !== -1);
check('error 终态：emitTurnEnded 紧随 error 发射点之后（≤400 字符内）',
  errorEmitIdx !== -1 && errorTurnEndedIdx > errorEmitIdx && errorTurnEndedIdx - errorEmitIdx <= 400,
  errorEmitIdx === -1 || errorTurnEndedIdx === -1 ? '锚点缺失' : `间距 ${errorTurnEndedIdx - errorEmitIdx}`);

check('markSessionDeleted 段提取非空', markDeletedSeg !== '');
check('markSessionDeleted 段内 clearSession(sessionId) 收口', markDeletedSeg.includes('clearSession(sessionId);'));

// ── §3 回合起点 turn_started 双发射点 ─────────────────────────────────
console.log('=== 3) turn_started 起点：CHAT_SEND(user) + popExecute(queue) ===');
check('sdk-backend 导出 getCurrentQueryInstance（代际查询口）', /export function getCurrentQueryInstance\(/.test(sdkBackend));
check('ipc-handlers.ts 内 noteTurnStarted 调用', handlers.includes('noteTurnStarted('));
check("ipc-handlers.ts 内 turn_started 发射恰好 1 处",
  countOccurrences(handlers, "type: 'turn_started'") === 1,
  `实际 ${countOccurrences(handlers, "type: 'turn_started'")}`);
check("ipc-handlers.ts turnKind: 'user'", handlers.includes("turnKind: 'user'"));
check('ipc-handlers.ts turn_started 序在 spawnForChat 成功之后',
  handlers.indexOf('spawnForChat(sessionId, mainWindow') !== -1 &&
  handlers.indexOf('spawnForChat(sessionId, mainWindow') < handlers.indexOf("type: 'turn_started'"));
check('task-queue-engine.ts 内 noteTurnStarted 调用', taskQueue.includes('noteTurnStarted('));
check("task-queue-engine.ts 内 turn_started 发射恰好 1 处",
  countOccurrences(taskQueue, "type: 'turn_started'") === 1,
  `实际 ${countOccurrences(taskQueue, "type: 'turn_started'")}`);
check("task-queue-engine.ts turnKind: 'queue'", taskQueue.includes("turnKind: 'queue'"));
check('task-queue-engine.ts turn_started 序在 spawnForTask 成功之后',
  taskQueue.indexOf('spawnForTask(task.id') !== -1 &&
  taskQueue.indexOf('spawnForTask(task.id') < taskQueue.indexOf("type: 'turn_started'"));
check("sdk-backend 内 turn_started 发射恰好 1 处（R3：resendUserText 第三发射点）",
  countOccurrences(sdkBackend, "type: 'turn_started'") === 1,
  `实际 ${countOccurrences(sdkBackend, "type: 'turn_started'")}`);
// A2（P3 收尾批）：noteTurnStarted 对 generation<0（getCurrentQueryInstance 取不到
// queryInstance 的兜底值）不登记投影——早退 null、不建 Map 项；三发射点 turn_started
// 照发，startedAt 以发射点 Date.now() 兜底（防 -1 代不可终态僵尸投影）。
check('A2：noteTurnStarted 返回类型 number | null 且 generation<0 早退（不登记投影）',
  /export function noteTurnStarted\(sessionId: string, generation: number\): number \| null \{[\s\S]*?if \(generation < 0\) return null;/.test(turnProjection));
check('A2：三发射点 startedAt 以 turnStartedAt ?? Date.now() 兜底（投影未登记时 turn_started 照发）',
  countOccurrences(handlers, 'startedAt: turnStartedAt ?? Date.now(),') === 1 &&
  countOccurrences(taskQueue, 'startedAt: turnStartedAt ?? Date.now(),') === 1 &&
  countOccurrences(sdkBackend, 'startedAt: turnStartedAt ?? Date.now(),') === 1);

// ── §4 cli.ts 两伴生事件类型 ──────────────────────────────────────────
console.log('=== 4) cli.ts：CliTurnStartedEvent / CliTurnEndedEvent 入联合 ===');
check('CliTurnStartedEvent interface 定义', cliTypes.includes('export interface CliTurnStartedEvent'));
check('CliTurnEndedEvent interface 定义', cliTypes.includes('export interface CliTurnEndedEvent'));
check('CliTurnStartedEvent 含 startedAt/serverNow/turnKind/generation 四字段',
  /export interface CliTurnStartedEvent \{[\s\S]*?type: 'turn_started';[\s\S]*?startedAt: number;[\s\S]*?serverNow: number;[\s\S]*?turnKind: 'user' \| 'queue';[\s\S]*?generation: number;[\s\S]*?\}/.test(cliTypes));
check('CliTurnEndedEvent 含 endedAt/durationMs/outcome 三字段',
  /export interface CliTurnEndedEvent \{[\s\S]*?type: 'turn_ended';[\s\S]*?endedAt: number;[\s\S]*?durationMs: number;[\s\S]*?outcome: 'success' \| 'error' \| 'interrupted';[\s\S]*?\}/.test(cliTypes));
const unionIdx = cliTypes.indexOf('export type CliEvent =');
check('CliEvent 联合存在', unionIdx !== -1);
const unionSeg = unionIdx === -1 ? '' : cliTypes.slice(unionIdx, cliTypes.indexOf(';', unionIdx));
check('CliEvent 联合引用 CliTurnStartedEvent', unionSeg.includes('CliTurnStartedEvent'));
check('CliEvent 联合引用 CliTurnEndedEvent', unionSeg.includes('CliTurnEndedEvent'));

// ── §5 既有事件流不变（关键既有调用行原文 + 段内顺序） ────────────────
console.log('=== 5) 既有事件流不变：关键行原文仍在 + 顺序不变 ===');
check('forwardEvent 段内 persistCliEvent(sessionId, event) 原样存在',
  forwardEventSeg.includes('persistCliEvent(sessionId, event);'));
check('forwardEvent 段内推送仍先于落库（push < persist 顺序不变）',
  forwardEventSeg.indexOf(pushChatLine) < forwardEventSeg.indexOf('persistCliEvent(sessionId, event);'));
check('forwardEvent 段内 noteTurnOutcome 钩子原样存在',
  forwardEventSeg.includes('noteTurnOutcome(sessionId, outcome, mainWindow);'));
check('forwardEvent 段内 result 三态映射原样存在',
  forwardEventSeg.includes("isSuccessfulCliResult(event) ? 'success' : isAbortedCliResult(event) ? 'interrupted' : 'error'"));
check('killProcess 段内 post-turn 探针调度原样存在',
  killProcessSeg.includes('schedulePostTurnProbe(sessionId, mainWindow, entry.queryInstance,'));
// 伴生信号不落库（SA-2 起为显式跳过 case 形态——原「全文件无 turn_started/turn_ended 字面」
// 的缺席代理钉随显式 case 失效，改为语义更强形态：case 组存在且 case 体到 break 之间无任何
// 落库调用（messageRepo./sessionRepo.），证明两事件只被跳过、不被持久化）。
const persistSeg = topLevelFunction(cliShared, 'export function persistCliEvent(');
const skipCaseStart = persistSeg.indexOf("case 'turn_started':");
const skipCaseEnd = skipCaseStart === -1 ? -1 : persistSeg.indexOf('break;', skipCaseStart);
check('伴生信号不落库：persistCliEvent 含 turn_started/turn_ended 显式跳过 case 且 case 体内零落库调用',
  persistSeg !== '' && skipCaseStart > -1 && skipCaseEnd > skipCaseStart &&
  persistSeg.includes("case 'turn_ended':") &&
  !persistSeg.slice(skipCaseStart, skipCaseEnd).includes('Repo.'),
  persistSeg === '' ? 'persistCliEvent 段提取失败' : 'case 组缺失或 case 体内存在落库调用');

// ── §6 SA-2：协议三处同步 + persistCliEvent 跳过 + 计数同步 ────────────
console.log('=== 6) SA-2：chat:getRuntimeSnapshot / chat:getRunningOverview 三处同步 ===');
check("IPC_CHANNELS 含 CHAT_RUNTIME_SNAPSHOT: 'chat:getRuntimeSnapshot'",
  ipcTypes.includes("CHAT_RUNTIME_SNAPSHOT: 'chat:getRuntimeSnapshot'"));
check("IPC_CHANNELS 含 CHAT_RUNNING_OVERVIEW: 'chat:getRunningOverview'",
  ipcTypes.includes("CHAT_RUNNING_OVERVIEW: 'chat:getRunningOverview'"));
check('ipc-handlers.ts 注册 CHAT_RUNTIME_SNAPSHOT（regInvokeHandler + 通道引用）',
  handlers.includes('regInvokeHandler(IPC_CHANNELS.CHAT_RUNTIME_SNAPSHOT'));
check('ipc-handlers.ts 注册 CHAT_RUNNING_OVERVIEW（regInvokeHandler + 通道引用）',
  handlers.includes('regInvokeHandler(IPC_CHANNELS.CHAT_RUNNING_OVERVIEW'));
check('ipc-handlers.ts 从 ./modules/turn-projection 导入 getSnapshot/getRunningOverview',
  /import\s*\{[^}]*getSnapshot[^}]*getRunningOverview[^}]*\}\s*from\s*'\.\/modules\/turn-projection'/.test(handlers));
check('ClaudeLinkAPI 含 getRuntimeSnapshot/getRunningOverview 成员',
  /getRuntimeSnapshot:\s*\(sessionId:\s*string\)\s*=>\s*Promise<TurnProjectionSnapshotView \| null>;/.test(preloadApi) &&
  /getRunningOverview:\s*\(\)\s*=>\s*Promise<TurnRunningOverviewEntry\[\]>;/.test(preloadApi));
check('preload 实现两方法（invoke 对应通道）',
  preloadApi.includes('ipcRenderer.invoke(IPC_CHANNELS.CHAT_RUNTIME_SNAPSHOT, sessionId)') &&
  preloadApi.includes('ipcRenderer.invoke(IPC_CHANNELS.CHAT_RUNNING_OVERVIEW)'));
check('api.ts 头注释「106 个方法」且与 ClaudeLinkAPI 成员数一致（动态比对）', (() => {
  const header = /(\d+)\s*个方法/.exec(preloadApi);
  const ifaceAt = preloadApi.indexOf('export interface ClaudeLinkAPI');
  const ifaceEnd = preloadApi.indexOf('export function createApi');
  if (!header || ifaceAt === -1 || ifaceEnd === -1) return false;
  const members = (preloadApi.slice(ifaceAt, ifaceEnd).match(/^\s+[A-Za-z]+\s*:\s*\(/gm) ?? []).length;
  return Number(header[1]) === 106 && members === 106;
})());
check('api.ts 导出镜像类型 TurnProjectionSnapshotView / TurnRunningOverviewEntry',
  /export interface TurnProjectionSnapshotView\b/.test(preloadApi) &&
  /export interface TurnRunningOverviewEntry\b/.test(preloadApi));
check('web-bridge WEB_CHANNEL_TABLE 含两键（表键值直引 IPC_CHANNELS 常量）',
  webBridge.includes('getRuntimeSnapshot: IPC_CHANNELS.CHAT_RUNTIME_SNAPSHOT') &&
  webBridge.includes('getRunningOverview: IPC_CHANNELS.CHAT_RUNNING_OVERVIEW'));
check('cli-shared.ts persistCliEvent 含 turn_started/turn_ended 显式跳过 case',
  persistSeg.includes("case 'turn_started':") && persistSeg.includes("case 'turn_ended':"));

// ── §7 SA-4：兜底不写库 + prompt 强化 + 短输入跳过 + 写库补推送 + P5 恢复接线 ──
console.log('=== 7) SA-4：标题质量四处（P6）+ 恢复接线两步（P5） ===');
const topicCore = read('src/shared/topic-analyzer-core.ts');
const topicAnalyzer = read('src/main/modules/topic-analyzer.ts');
const chatPage = read('src/renderer/pages/ChatPage.vue');

// P6-1 prompt 文案钉：新文案关键片段齐备 + 旧文案不再存在。
check('TOPIC_PROMPT_PREFIX 含新文案关键片段（编程会话起一个会话标题 / 不超过16个字 / 禁止直接复制消息原文）',
  topicCore.includes('编程会话起一个会话标题') &&
  topicCore.includes('不超过16个字') &&
  topicCore.includes('禁止直接复制消息原文'));
check('TOPIC_PROMPT_PREFIX 不含旧文案「用5个字以内概括」', !topicCore.includes('用5个字以内概括'));
// R5（round-001）：标点形态对齐计划 108 行（全角：；，）——现有三片段钉均不含标点，
// 补一条含全角冒号的形态钉防半角回退。
check('TOPIC_PROMPT_PREFIX 含全角冒号「。要求：」形态（R5：标点对齐计划 108 行，防半角回退）',
  topicCore.includes('。要求：'));
check('extractTopicCandidate 截断上限 20 保持不变（slice(0, 20)）', topicCore.includes('slice(0, 20)'));
check('META_PREAMBLE_PATTERNS 保留', topicCore.includes('META_PREAMBLE_PATTERNS'));

// P6-2/3/4 topic-analyzer.ts analyzeTopic 函数段（段级收口，不受模块内其他函数干扰）。
const analyzeSeg = topLevelFunction(topicAnalyzer, 'export async function analyzeTopic(');
check('analyzeTopic 函数段提取非空', analyzeSeg !== '');
check('短输入跳过：段内含 trimmed.length <= 8 守卫', analyzeSeg.includes('trimmed.length <= 8'));
check('短输入跳过：空串守卫（trimmed.length > 0，纯空白不走短输入写库路径）',
  analyzeSeg.includes('trimmed.length > 0'));
check('短输入跳过：守卫文本序位于 makeHttpRequest 调用之前（不发 LLM 请求）',
  analyzeSeg.indexOf('trimmed.length <= 8') !== -1 &&
  analyzeSeg.indexOf('makeHttpRequest(url,') !== -1 &&
  analyzeSeg.indexOf('trimmed.length <= 8') < analyzeSeg.indexOf('makeHttpRequest(url,'));
check('兜底不落库：段内 sessionRepo.updateSession 写点恰 2 处（LLM 成功点 + 短输入点）',
  countOccurrences(analyzeSeg, 'sessionRepo.updateSession(sessionId') === 2,
  `实际 ${countOccurrences(analyzeSeg, 'sessionRepo.updateSession(sessionId')}`);
check('兜底不落库：段内无首句截断兜底形态（rawFallback 已移除）', !analyzeSeg.includes('rawFallback'));
check('写库补推送：段内 pushToMainWindow(IPC_CHANNELS.SESSIONS_CHANGED 恰 2 次（两写点各一）',
  countOccurrences(analyzeSeg, 'pushToMainWindow(IPC_CHANNELS.SESSIONS_CHANGED') === 2,
  `实际 ${countOccurrences(analyzeSeg, 'pushToMainWindow(IPC_CHANNELS.SESSIONS_CHANGED')}`);
check('topic-analyzer 从 ./push-bus 导入 pushToMainWindow（失败由总线内部吞噬）',
  topicAnalyzer.includes("from './push-bus'"));

// P5 恢复接线：web-bridge realign 段 + ChatPage onMounted 段各含两调用。
const realignSeg = topLevelFunction(webBridge, 'async function runRealignSequence(');
check('web-bridge runRealignSequence 段提取非空', realignSeg !== '');
check('runRealignSequence 段含 getRunningOverview() 调用', realignSeg.includes('getRunningOverview()'));
check('runRealignSequence 段含 getRuntimeSnapshot( 调用', realignSeg.includes('getRuntimeSnapshot('));
const onMountedSeg = topLevelFunction(chatPage, 'onMounted(async () => {');
check('ChatPage.vue onMounted 段提取非空', onMountedSeg !== '');
check('onMounted 段含 getRunningOverview() 调用', onMountedSeg.includes('getRunningOverview()'));
check('onMounted 段含 getRuntimeSnapshot( 调用', onMountedSeg.includes('getRuntimeSnapshot('));
check('onMounted 段两步位于 restoreWebActiveSession 之后',
  onMountedSeg.indexOf('restoreWebActiveSession') !== -1 &&
  onMountedSeg.indexOf('restoreWebActiveSession') < onMountedSeg.indexOf('getRunningOverview()'));

// ── §8 round-002 FIX-A（round-001 R1/R2/R3）修复钉 ─────────────────────
console.log('=== 8) round-001 修复钉：R1 僵尸投影收口 / R2 命名空间 / R3 重发起点 ===');
// R1-①：三处非 kill 终态出口的 forwardEvent(aborted/error) 后紧跟 emitTurnEnded（≤400 字符内）。
// 出口①（流丢 result 合成 aborted「回合已结束」）。
const lostAbortedLine = "forwardEvent(sessionId, mainWindow, { type: 'aborted', message: '回合已结束' });";
const lostAbortedIdx = sdkBackend.indexOf(lostAbortedLine);
const lostEndedIdx = lostAbortedIdx === -1 ? -1 : sdkBackend.indexOf("emitTurnEnded(sessionId, 'interrupted',", lostAbortedIdx);
check('R1 出口①：流丢 result 合成 aborted 后紧跟 emitTurnEnded(interrupted)（≤400 字符内）',
  lostAbortedIdx !== -1 && lostEndedIdx !== -1 && lostEndedIdx - lostAbortedIdx <= 400,
  lostAbortedIdx === -1 ? 'aborted 锚点缺失' : lostEndedIdx === -1 ? 'emitTurnEnded 缺失' : `间距 ${lostEndedIdx - lostAbortedIdx}`);
// 出口⑤（resume 重试失败 error；retryErr 变量名锚点唯一）。
const retryAnchor = 'const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);';
const retryAnchorIdx = sdkBackend.indexOf(retryAnchor);
const retryEmitLine = 'forwardEvent(sessionId, mainWindow, { type: \'error\', message: `SDK 执行出错：${msg}` });';
const retryEmitIdx = retryAnchorIdx === -1 ? -1 : sdkBackend.indexOf(retryEmitLine, retryAnchorIdx);
const retryEndedIdx = retryEmitIdx === -1 ? -1 : sdkBackend.indexOf("emitTurnEnded(sessionId, 'error',", retryEmitIdx);
check('R1 出口⑤：resume 重试失败 error 后紧跟 emitTurnEnded(error)（≤400 字符内）',
  retryEmitIdx !== -1 && retryEndedIdx !== -1 && retryEndedIdx - retryEmitIdx <= 400,
  retryEmitIdx === -1 ? 'error 发射点缺失' : retryEndedIdx === -1 ? 'emitTurnEnded 缺失' : `间距 ${retryEndedIdx - retryEmitIdx}`);
// 出口⑥（启动阶段外层 catch error；`const message = err …` 变量名锚点唯一）。
const outerAnchor = 'const message = err instanceof Error ? err.message : String(err);';
const outerAnchorIdx = sdkBackend.indexOf(outerAnchor);
const outerEmitLine = 'forwardEvent(sessionId, mainWindow, { type: \'error\', message: `SDK 执行出错：${message}` });';
const outerEmitIdx = outerAnchorIdx === -1 ? -1 : sdkBackend.indexOf(outerEmitLine, outerAnchorIdx);
const outerEndedIdx = outerEmitIdx === -1 ? -1 : sdkBackend.indexOf("emitTurnEnded(sessionId, 'error',", outerEmitIdx);
check('R1 出口⑥：启动阶段外层 catch error 后紧跟 emitTurnEnded(error)（≤400 字符内）',
  outerEmitIdx !== -1 && outerEndedIdx !== -1 && outerEndedIdx - outerEmitIdx <= 400,
  outerEmitIdx === -1 ? 'error 发射点缺失' : outerEndedIdx === -1 ? 'emitTurnEnded 缺失' : `间距 ${outerEndedIdx - outerEmitIdx}`);
// R1-②：finishKill 段（killProcess 段内）含 wasCurrent 投影收口——user/watchdog 既有门之外
// 的一切 kill 形态（session_cleanup/upstream_fatal/queue 等）也 ended 投影，防僵尸投影。
// A1（P3 收尾批）：wasCurrent 收口门改经 KillReason 语义映射——upstream_fatal /
// api_retry_exhausted → 'error'（上游致命/重试耗尽的 error 语义终局），其余系统杀保持
// 'interrupted'；字面 emitTurnEnded(sessionId, 'interrupted', 只剩 user/watchdog 既有门 1 处。
check("R1 finishKill：killProcess 段内 emitTurnEnded(sessionId, 'interrupted', 恰好 1 处（user/watchdog 既有门；A1 后 wasCurrent 收口门改经 outcome 变量）",
  countOccurrences(killProcessSeg, "emitTurnEnded(sessionId, 'interrupted',") === 1,
  `实际 ${countOccurrences(killProcessSeg, "emitTurnEnded(sessionId, 'interrupted',")}`);
check("A1（P3 收尾批）：wasCurrent 收口门 outcome 映射——upstream_fatal/api_retry_exhausted → 'error'、其余 'interrupted'，且以映射结果发射",
  killProcessSeg.includes("reason === 'upstream_fatal' || reason === 'api_retry_exhausted' ? 'error' : 'interrupted'") &&
  killProcessSeg.includes('emitTurnEnded(sessionId, endedOutcome, entry.queryInstance);'));
check('R1 finishKill：wasCurrent 收口门形态存在（if (wasCurrent) { try { emitTurnEnded(…endedOutcome…) } }）',
  /if \(wasCurrent\) \{\s*try \{[\s\S]*?emitTurnEnded\(sessionId, endedOutcome, entry\.queryInstance\);\s*\} catch \{/.test(killProcessSeg));
// R1-③：emitTurnEnded 全文件计数——1 处函数定义 + 8 处调用（result 钩子 1 + killProcess 2 +
// 出口①④⑤⑥ 各 1 + interruptedQueries 分支 1）= 9（注释文字不含带括号形态，不干扰计数）。
check('R1 全局：emitTurnEnded( 全文件恰好 9 处（1 定义 + 8 调用）',
  countOccurrences(sdkBackend, 'emitTurnEnded(') === 9,
  `实际 ${countOccurrences(sdkBackend, 'emitTurnEnded(')}`);
// round-003 FIX-D（round-002 复审 P2-1）：runQuery catch interruptedQueries 分支（两段式优雅
// 窗内流抛错）——迟到 finishKill 因 entry 已被 finally deleteEntry 移除而 wasCurrent 恒 false，
// 其收口门被跳过；分支内 emitTurnEnded(interrupted) 为该形态唯一投影收口点。
// 窗口申报：分支锚点 interruptedQueries.has(query)（全文件唯一）到 emitTurnEnded 实距 754
// （分支头 5 行既有注释 + forceKill 块 + emitExit + CRLF；LF 下亦 ≈740 >400），超 400 窗；照
// 出口①/⑤/⑥「从终态发射行起量」惯例改从分支内 aborted 发射行起量 ≤400 窗（实距 364），分支
// 归属另由唯一分支锚点钉住（indexOf === lastIndexOf）。emitTurnEnded 置 emitExit(null) 之后：
// p3-01 契约钉要求 emitExit 留在分支前 700 窗（位置不可推后），watchdog ⑬ X9 消费块同款先例。
const intrAnchorIdx = sdkBackend.indexOf('interruptedQueries.has(query)');
const intrAbortedIdx = intrAnchorIdx === -1 ? -1
  : sdkBackend.indexOf("forwardEvent(sessionId, mainWindow, { type: 'aborted', message: '已中断' });", intrAnchorIdx);
const intrEndedIdx = intrAbortedIdx === -1 ? -1
  : sdkBackend.indexOf("emitTurnEnded(sessionId, 'interrupted',", intrAbortedIdx);
check('P2-1 interruptedQueries 分支：分支锚点唯一 + aborted 发射行后紧跟 emitTurnEnded(interrupted)（≤400 字符内）',
  intrAnchorIdx !== -1 && intrAbortedIdx !== -1 && intrEndedIdx !== -1 && intrEndedIdx - intrAbortedIdx <= 400 &&
  sdkBackend.indexOf('interruptedQueries.has(query)') === sdkBackend.lastIndexOf('interruptedQueries.has(query)'),
  intrAnchorIdx === -1 ? '分支锚点缺失' : intrAbortedIdx === -1 ? 'aborted 发射点缺失' : intrEndedIdx === -1 ? 'emitTurnEnded 缺失' : `间距 ${intrEndedIdx - intrAbortedIdx}`);
// R2：toolIndexKeys 命名空间键——注册/查询两侧同规则 `${parentToolUseId ?? ''}#${index}`。
check('R2：toolIndexKeys 类型 Map<string, string>（命名空间键）',
  /toolIndexKeys: Map<string, string>;/.test(turnProjection));
check('R2：命名空间键拼装 `${event.parentToolUseId ?? \'\'}#${index}` 恰好 2 处（注册 + 查询同规则）',
  countOccurrences(turnProjection, "${event.parentToolUseId ?? ''}#${index}") === 2,
  `实际 ${countOccurrences(turnProjection, "${event.parentToolUseId ?? ''}#${index}")}`);
check('R2：注册侧 set(nsIndex, key) / 清退 delete(nsIndex)',
  turnProjection.includes('p.toolIndexKeys.set(nsIndex, key)') &&
  turnProjection.includes('p.toolIndexKeys.delete(nsIndex)'));
check('R2：查询侧解析查同一 nsIndex（toolIndexKeys.get(nsIndex)）',
  turnProjection.includes('p.toolIndexKeys.get(nsIndex)'));
check('R2：子 agent 最终 streamTool 键形态保持 `sub:${event.parentToolUseId}:${resolved}`',
  turnProjection.includes('`sub:${event.parentToolUseId}:${resolved}`'));
// R3：resendUserText（reasoning_replay 重发）第三 turn_started 发射点。
const resendStart = sdkBackend.indexOf('resendUserText: (text) => {');
const resendEnd = resendStart === -1 ? -1 : sdkBackend.indexOf('sendMessage(sessionId, text);', resendStart);
const resendSeg = resendStart !== -1 && resendEnd !== -1 ? sdkBackend.slice(resendStart, resendEnd) : '';
check('R3：resendUserText 段提取非空', resendSeg !== '');
check('R3：段内 noteTurnStarted 调用', resendSeg.includes('noteTurnStarted(sessionId,'));
check("R3：段内 turn_started 发射且 turnKind 'user'",
  resendSeg.includes("type: 'turn_started'") && resendSeg.includes("turnKind: 'user'"));
check('R3：generation 取 getCurrentQueryInstance(sessionId) ?? -1',
  resendSeg.includes('getCurrentQueryInstance(sessionId) ?? -1'));
check('R3：turn_started 序在 spawnForChat 成功之后',
  resendSeg.indexOf('spawnForChat(sessionId, mainWindow') !== -1 &&
  resendSeg.indexOf('spawnForChat(sessionId, mainWindow') < resendSeg.indexOf("type: 'turn_started'"));

// ── §9 round-002 FIX-B（round-001 R4-R9）修复钉 ─────────────────────
console.log('=== 9) round-001 修复钉：R4 瞬态后置 / R7 代际收窄 / R8 sub: 过滤 / R6 时钟偏移 / R9 订阅顺序 ===');
const sessionStoreSrc = read('src/renderer/stores/session-store.ts');
const useChatSrc = read('src/renderer/composables/use-chat.ts');
const appVue = read('src/renderer/App.vue');

// R4：applyRuntimeSnapshot 段内瞬态（apiRetry 写/删）必须后置于 markRunning 调用——markRunning
// 体内无条件 delete apiRetryInfo，瞬态先写会被同 tick 抹除（快照恢复重试横幅永不生效）。
const applySnapSeg = topLevelFunction(sessionStoreSrc, 'applyRuntimeSnapshot(snap: TurnProjectionSnapshotView)');
check('R4：applyRuntimeSnapshot 函数段提取非空', applySnapSeg !== '');
check('R4：markRunning 调用先于 apiRetry 瞬态写点（先运行置位、后瞬态置位）',
  applySnapSeg.indexOf('this.markRunning(sid, snap.startedAt, snap.serverNow);') !== -1 &&
  applySnapSeg.indexOf('this.apiRetryInfo[sid] = {') !== -1 &&
  applySnapSeg.indexOf('this.markRunning(sid, snap.startedAt, snap.serverNow);') < applySnapSeg.indexOf('this.apiRetryInfo[sid] = {'));
// R7：markRunning 的 generation 递增收窄至「新加入 runningSessions」分支（真正的新回合边界）；
// 幂等覆盖分支（已 running + 传入 startedAt）不递增；防御 else（已 running 无 startedAt）保留旧语义递增。
const markRunningSeg = topLevelFunction(sessionStoreSrc, 'markRunning(sessionId: string');
check('R7：markRunning 函数段提取非空', markRunningSeg !== '');
const r7PushIdx = markRunningSeg.indexOf('this.runningSessions.push(sessionId);');
const r7IncLine = 'this.turnGeneration[sessionId] = (this.turnGeneration[sessionId] ?? 0) + 1;';
const r7IncIdx = markRunningSeg.indexOf(r7IncLine);
const r7ElseIfIdx = markRunningSeg.indexOf("} else if (typeof startedAt === 'number' && Number.isFinite(startedAt)) {");
check('R7：递增行位于「新加入 runningSessions」分支内（push 之后、幂等覆盖 else-if 之前）',
  r7PushIdx !== -1 && r7IncIdx !== -1 && r7ElseIfIdx !== -1 && r7PushIdx < r7IncIdx && r7IncIdx < r7ElseIfIdx);
const r7DefensiveElseIdx = markRunningSeg.indexOf('} else {', r7ElseIfIdx);
const r7StatusIdx = markRunningSeg.indexOf('// 侧栏黄灯');
check('R7：幂等覆盖分支（已 running + startedAt）不递增 generation',
  r7ElseIfIdx !== -1 && r7DefensiveElseIdx !== -1 &&
  !markRunningSeg.slice(r7ElseIfIdx, r7DefensiveElseIdx).includes('turnGeneration'));
check('R7：防御 else（已 running 无 startedAt）保留旧语义递增',
  r7DefensiveElseIdx !== -1 && r7StatusIdx !== -1 &&
  markRunningSeg.slice(r7DefensiveElseIdx, r7StatusIdx).includes(r7IncLine));
// R8：快照 tool 路按插入序拼接时过滤 `sub:` 子 agent 键，不灌回主流程累加器。
check("R8：applyRuntimeSnapshot tool 路含 startsWith('sub:') 过滤",
  applySnapSeg.includes(".filter(([k]) => !k.startsWith('sub:'))"));
// R6：耗时兜底两处（前台 attachResultMetadata / 后台 result 分支）按 serverClockOffset 换算
// 服务器口径；未换算形态（Date.now() - startedAt，含注释）归零。
const r6OffsetForm = '(Date.now() + (store.serverClockOffset[sid] ?? 0)) - startedAt';
check('R6：use-chat 含 serverClockOffset 换算兜底恰好 2 处',
  countOccurrences(useChatSrc, r6OffsetForm) === 2,
  `实际 ${countOccurrences(useChatSrc, r6OffsetForm)}`);
check('R6：use-chat 不含未换算形态 Date.now() - startedAt', !useChatSrc.includes('Date.now() - startedAt'));
// R9：App.vue onMounted 内 startListening 先于 loadConfig——「先订阅后拉快照」从统计性
// 保证变为确定性保证。
check('R9：App.vue startListening() 调用先于 await configStore.loadConfig()',
  appVue.indexOf('startListening();') !== -1 &&
  appVue.indexOf('startListening();') < appVue.indexOf('await configStore.loadConfig()'));

console.log(`\n[turn-projection SA-1] pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.error(`[turn-projection SA-1] ❌ ${fail} 项断言失败`);
  process.exit(1);
}
assert.strictEqual(fail, 0);
console.log('[turn-projection SA-1] ✅ 全部通过');
