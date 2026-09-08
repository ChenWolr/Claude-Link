// tdd-bugfix-f2-maxturns-source-unify-clamp-verify.ts
// F2（P2，横切复查 2026-09-08）契约钉：maxTurns 双源分裂 + 输入无钳制。
//
// 修复前：设置页「最大轮次」两条执行链取值源分裂——队列路径 task-queue-engine 读
// getConfig().maxTurns（全局），直发 CHAT_SEND 与卡死/重放重发路径读 session.maxTurns
// （DB 列默认 200，渲染层从不写入，设置永远到不了这两条链）；叠加 ConfigPage number
// 输入无 blur 钳制、saveConfig 无兜底清洗——清空/0 保存后 sdk-command-options 的 >0
// 守卫静默丢旗标=队列任务无轮次上限运行。
//
// 修复语义：
// ① 三路 spawn 组装同源：CHAT_SEND 与重发路径统一 getConfig().maxTurns（与队列路径一致）；
// ② 新增 shared/max-turns.ts 纯函数（DEFAULT_MAX_TURNS=200 + sanitizeMaxTurns），
//    ConfigPage blur 夹取（清空/非正数回落默认 200）与 config-manager saveConfig/getConfig
//    兜底清洗共用同一实现（对齐 sanitizeTaskDelayMinutes 先例）。
//
// 契约（记账如实化，B1 契约普查 2026-09-08）：F2-②「设置改 5 后直发 spawn 的
// options.maxTurns=5」这一取值源统一是**结构契约**——三路断言为 includes/字面文本锚
// （钉「取值源=getConfig().maxTurns」的接线不变量，字面锚为修复引入、基线必 RED），
// 零行为驱动；行为语义由 F2-① sanitizeMaxTurns 的 13 条纯函数行为断言承载
// （钳制/回落全行为驱动）。声称与实现落差在此声明，勿按头注释误判守护力。
//
// 运行：npx tsx scripts/tdd-bugfix-f2-maxturns-source-unify-clamp-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_MAX_TURNS, sanitizeMaxTurns } from '../src/shared/max-turns';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: (() => void) | boolean): void {
  try {
    if (typeof cond === 'function') cond();
    else if (!cond) throw new Error('断言为假');
    pass += 1; console.log(`  ✅ ${name}`);
  }
  catch (e) { fail += 1; console.log(`  ✗ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

console.log('=== F2-① sanitizeMaxTurns 纯函数行为 ===');
{
  check('正整数原样保留（5→5）', () => assert.strictEqual(sanitizeMaxTurns(5), 5));
  check('数字串可解析（"5"→5）', () => assert.strictEqual(sanitizeMaxTurns('5'), 5));
  check('小数向下取整（5.9→5）', () => assert.strictEqual(sanitizeMaxTurns(5.9), 5));
  check('1 为合法下界（1→1）', () => assert.strictEqual(sanitizeMaxTurns(1), 1));
  check('清空输入（""）回落默认 200', () => assert.strictEqual(sanitizeMaxTurns(''), DEFAULT_MAX_TURNS));
  check('空白串回落默认 200', () => assert.strictEqual(sanitizeMaxTurns('  '), DEFAULT_MAX_TURNS));
  check('0 回落默认 200', () => assert.strictEqual(sanitizeMaxTurns(0), DEFAULT_MAX_TURNS));
  check('负数回落默认 200', () => assert.strictEqual(sanitizeMaxTurns(-3), DEFAULT_MAX_TURNS));
  check('NaN 回落默认 200', () => assert.strictEqual(sanitizeMaxTurns(Number.NaN), DEFAULT_MAX_TURNS));
  check('null 回落默认 200', () => assert.strictEqual(sanitizeMaxTurns(null), DEFAULT_MAX_TURNS));
  check('undefined 回落默认 200', () => assert.strictEqual(sanitizeMaxTurns(undefined), DEFAULT_MAX_TURNS));
  check('不可解析串回落默认 200', () => assert.strictEqual(sanitizeMaxTurns('abc'), DEFAULT_MAX_TURNS));
  check('DEFAULT_MAX_TURNS === 200', () => assert.strictEqual(DEFAULT_MAX_TURNS, 200));
}

console.log('=== F2-② 三路 spawn 取值源统一 ===');
{
  const handlers = read('src/main/ipc-handlers.ts');
  const sdkBackend = read('src/main/modules/sdk-backend.ts');
  const queueEngine = read('src/main/modules/task-queue-engine.ts');

  // 直发链（CHAT_SEND）
  const chatSendBody = handlers.slice(handlers.indexOf('IPC_CHANNELS.CHAT_SEND'), handlers.indexOf('IPC_CHANNELS.CHAT_ABORT'));
  check('CHAT_SEND maxTurns 改读 getConfig().maxTurns', chatSendBody.includes('maxTurns: getConfig().maxTurns,'));
  check('CHAT_SEND 不再读 session.maxTurns', !chatSendBody.includes('maxTurns: session.maxTurns'));

  // 卡死/重放重发链（sdk-backend resendUserText）
  const resendAt = sdkBackend.indexOf('resendUserText: (text)');
  const resendBody = sdkBackend.slice(resendAt, sdkBackend.indexOf('sendMessage(sessionId, text);', resendAt));
  check('重发路径 maxTurns 改读 getConfig().maxTurns', resendBody.includes('maxTurns: getConfig().maxTurns,'));
  check('重发路径不再读 session.maxTurns', !resendBody.includes('maxTurns: session.maxTurns'));

  // 队列链（既有同源基准，钉住不回退）
  check('队列路径维持 getConfig().maxTurns', queueEngine.includes('maxTurns: getConfig().maxTurns,'));

  // 回归：SESSION_UPDATE 类型联合等既有契约不受影响
  check('SESSION_UPDATE 仍可传 maxTurns 类型字段', handlers.includes("'maxTurns' | 'thinkingLevel'"));
  // 回归：sdk-command-options 的 >0 守卫保留（防御纵深）
  const cmdOpts = read('src/main/modules/sdk-command-options.ts');
  check('sdk-command-options 保留 maxTurns>0 守卫', /input\.maxTurns !== undefined && input\.maxTurns > 0/.test(cmdOpts));
}

console.log('=== F2-③ 设置页输入钳制 + config 兜底清洗 ===');
{
  const configPage = read('src/renderer/pages/ConfigPage.vue');
  const configManager = read('src/main/modules/config-manager.ts');

  check('ConfigPage 导入 sanitizeMaxTurns', configPage.includes("from '../../shared/max-turns'"));
  check('maxTurns 输入加 @blur 夹取', /v-model\.number="store\.config\.maxTurns"[^>]*@blur="clampMaxTurns"/.test(configPage));
  check('clampMaxTurns 使用 sanitizeMaxTurns', /function clampMaxTurns\(\)[\s\S]{0,200}sanitizeMaxTurns\(store\.config\.maxTurns\)/.test(configPage));
  // 回归：taskDelayMinutes 夹取先例不受影响
  check('taskDelayMinutes blur 夹取仍存在', configPage.includes('@blur="clampTaskDelayMinutes"'));

  check('getConfig 对 maxTurns 读时清洗', configManager.includes('maxTurns: sanitizeMaxTurns(config.maxTurns)'));
  check('saveConfig 对 maxTurns 落盘前兜底清洗', /storage\.maxTurns = sanitizeMaxTurns\(storage\.maxTurns\)/.test(configManager));
  check('config-manager 导入 sanitizeMaxTurns', configManager.includes("from '../../shared/max-turns'"));
  // 回归：taskDelayMinutes 清洗先例不受影响
  check('taskDelayMinutes 读时清洗仍存在', configManager.includes('taskDelayMinutes: sanitizeTaskDelayMinutes(config.taskDelayMinutes)'));
}

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
