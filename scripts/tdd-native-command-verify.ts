// tdd-native-command-verify.ts
// 原生 Claude Code Slash Commands 动态接入：行为测试 + 源码接线契约。
// 运行：npx tsx scripts/tdd-native-command-verify.ts
//
// 约定（与项目其它 tdd-*-verify.ts 一致）：纯 node:assert + check() 计数，
// 不 import Electron；失败 process.exit(1)。优先测纯函数行为；记录跨文件接线契约用源码文本断言。
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  parseSlashInvocation,
  filterRenderableCommands,
  findCommandByAlias,
} from '../src/shared/command-routing';
import {
  createDefaultCommandSnapshot,
  type SdkCommand,
  type SessionCommandSnapshot,
} from '../src/shared/types/command';
import { IPC_CHANNELS } from '../src/shared/types/ipc';
import { SdkCommandRegistry, toSdkCommand, sdkCommandRegistry, GLOBAL_FALLBACK_SESSION_ID } from '../src/main/modules/sdk-command-registry';
import { setActivePinia, createPinia } from 'pinia';
import { useCommandStore } from '../src/renderer/stores/command-store';
import { prepareAttachmentPrompt } from '../src/main/modules/attachment-prompt-builder';
import { hasLocalCommandOutputMessage } from '../src/renderer/composables/use-chat';
import { mergeSpawnOptions } from '../src/main/modules/sdk-command-options';
import type { Message, Session } from '../src/shared/types/session';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}
// 异步断言（prepareAttachmentPrompt 等纯 async 函数用）。需在调用处 await。
async function asyncCheck(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

const sdkCommands: SdkCommand[] = [
  { name: 'usage', description: 'show usage', argumentHint: '', aliases: ['cost', 'stats'], source: 'sdk' },
  { name: 'goal', description: 'set a goal', argumentHint: '', aliases: [], source: 'sdk' },
];

console.log('=== 1) parseSlashInvocation 路由（不充当发送白名单）===');

check('/cost tokens → slash，保留 rawText/参数', () => {
  const r = parseSlashInvocation('/cost tokens');
  assert.equal(r.kind, 'slash');
  if (r.kind !== 'slash') throw new Error('expected slash');
  assert.equal(r.commandName, 'cost');
  assert.equal(r.rawText, '/cost tokens');
  assert.equal(r.argumentsText, 'tokens');
});

check('普通文本中间的 /tmp → prompt（不触发命令逻辑）', () => {
  assert.equal(parseSlashInvocation('请解释 /tmp 目录').kind, 'prompt');
});

check('  /goal 中文 参数 → 不 trim rawText', () => {
  const r = parseSlashInvocation('  /goal 中文 参数');
  assert.equal(r.kind, 'slash');
  assert.equal(r.rawText, '  /goal 中文 参数');
  if (r.kind === 'slash') {
    assert.equal(r.commandName, 'goal');
    assert.equal(r.argumentsText, '中文 参数');
  }
});

check('/unknown 任意参数 → slash candidate，路由不阻止发送', () => {
  const r = parseSlashInvocation('/unknown 任意参数');
  assert.equal(r.kind, 'slash');
  if (r.kind !== 'slash') throw new Error('expected slash');
  assert.equal(r.commandName, 'unknown');
  assert.equal(r.argumentsText, '任意参数');
  // 关键不变量：路由结果不携带"拒绝发送"信号；未知命令仍归类为 slash，由现有 CHAT_SEND 原样发送。
});

check('空串 / 全空白 → prompt', () => {
  assert.equal(parseSlashInvocation('').kind, 'prompt');
  assert.equal(parseSlashInvocation('   ').kind, 'prompt');
});

check('纯 / → slash（commandName 空，用于菜单触发）', () => {
  const r = parseSlashInvocation('/');
  assert.equal(r.kind, 'slash');
  if (r.kind !== 'slash') throw new Error('expected slash');
  assert.equal(r.commandName, '');
});

check('leading slash 后含引号/中文不丢失', () => {
  const r = parseSlashInvocation('/compact 保留中文和  引号"');
  assert.equal(r.kind, 'slash');
  if (r.kind !== 'slash') throw new Error('expected slash');
  assert.equal(r.commandName, 'compact');
  assert.equal(r.argumentsText, '保留中文和  引号"');
});

console.log('=== 2) alias / canonical 匹配（大小写不敏感）===');

check('findCommandByAlias：alias 命中', () => {
  assert.equal(findCommandByAlias(sdkCommands, 'cost')?.name, 'usage');
  assert.equal(findCommandByAlias(sdkCommands, 'stats')?.name, 'usage');
});

check('findCommandByAlias：canonical 大小写不敏感', () => {
  assert.equal(findCommandByAlias(sdkCommands, 'USAGE')?.name, 'usage');
  assert.equal(findCommandByAlias(sdkCommands, 'Goal')?.name, 'goal');
});

check('findCommandByAlias：未命中返回 undefined（不抛错）', () => {
  assert.equal(findCommandByAlias(sdkCommands, 'nope'), undefined);
  assert.equal(findCommandByAlias([], 'usage'), undefined);
  assert.equal(findCommandByAlias(sdkCommands, ''), undefined);
});

console.log('=== 3) filterRenderableCommands（菜单数据源清洗）===');

check('filterRenderableCommands：返回合法 sdk 命令', () => {
  assert.deepEqual(
    filterRenderableCommands(sdkCommands).map((c) => c.name),
    ['usage', 'goal'],
  );
});

check('filterRenderableCommands：丢弃 name 空 / 非 sdk 来源', () => {
  const mixed: SdkCommand[] = [
    ...sdkCommands,
    { name: '', description: 'x', argumentHint: '', aliases: [], source: 'sdk' },
  ];
  assert.deepEqual(
    filterRenderableCommands(mixed).map((c) => c.name),
    ['usage', 'goal'],
  );
});

console.log('=== 4) 共享命令模型 / 默认快照 ===');

check('SdkCommand 字段齐备', () => {
  const c: SdkCommand = { name: 'usage', description: 'd', argumentHint: '<file>', aliases: ['cost'], source: 'sdk' };
  assert.equal(c.name, 'usage');
  assert.equal(c.argumentHint, '<file>');
  assert.deepEqual(c.aliases, ['cost']);
  assert.equal(c.source, 'sdk');
});

check('createDefaultCommandSnapshot：默认 loading / 空命令', () => {
  const snap = createDefaultCommandSnapshot('s1');
  assert.equal(snap.sessionId, 's1');
  assert.equal(snap.status, 'loading');
  assert.equal(snap.commands.length, 0);
  assert.equal(snap.updatedAt, null);
});

check('SessionCommandSnapshot：source/status 取值符合联合类型', () => {
  const snap: SessionCommandSnapshot = {
    sessionId: 's2',
    commands: [],
    status: 'ready',
    source: 'probe',
    updatedAt: '2026-08-06T00:00:00.000Z',
  };
  assert.equal(snap.status, 'ready');
  assert.equal(snap.source, 'probe');
});

console.log('=== 5) IPC 常量与 payload 接线契约 ===');

check('IPC_CHANNELS.COMMANDS_GET / COMMANDS_CHANGED 存在且唯一', () => {
  assert.equal(typeof IPC_CHANNELS.COMMANDS_GET, 'string');
  assert.equal(IPC_CHANNELS.COMMANDS_GET, 'commands:get');
  assert.equal(IPC_CHANNELS.COMMANDS_CHANGED, 'commands:changed');
  assert.notEqual(IPC_CHANNELS.COMMANDS_GET, IPC_CHANNELS.COMMANDS_CHANGED);
});

check('源码契约：ChatEventPayload 之外存在专用 CommandChangedPayload', () => {
  const ipcSrc = readFileSync(path.join('src', 'shared', 'types', 'ipc.ts'), 'utf8');
  assert.ok(ipcSrc.includes('CommandChangedPayload'), 'ipc.ts 应引用/定义 CommandChangedPayload');
  const cmdSrc = readFileSync(path.join('src', 'shared', 'types', 'command.ts'), 'utf8');
  assert.ok(cmdSrc.includes('CommandChangedPayload'), 'command.ts 应定义 CommandChangedPayload');
});

console.log('=== 6) 主进程 registry：全量替换 / 隔离 / 清理 ===');

check('registry.get 默认 loading / 空命令', () => {
  const reg = new SdkCommandRegistry();
  assert.equal(reg.get('a').status, 'loading');
  assert.equal(reg.get('a').commands.length, 0);
});

check('registry.replace 全量替换（旧命令消失，不 concat）', () => {
  const reg = new SdkCommandRegistry();
  reg.replace('a', [{ name: 'goal', description: 'd', argumentHint: '', aliases: [], source: 'sdk' }], 'probe');
  reg.replace('a', [{ name: 'usage', description: 'd', argumentHint: '', aliases: ['cost'], source: 'sdk' }], 'changed');
  assert.deepEqual(
    reg.get('a').commands.map((c) => c.name),
    ['usage'],
  );
  assert.equal(reg.get('a').source, 'changed');
  assert.equal(reg.get('a').status, 'ready');
});

check('registry 隔离 + clear 只影响指定 session', () => {
  const reg = new SdkCommandRegistry();
  reg.replace('a', [{ name: 'goal', description: '', argumentHint: '', aliases: [], source: 'sdk' }], 'probe');
  reg.replace('b', [{ name: 'help', description: '', argumentHint: '', aliases: [], source: 'sdk' }], 'probe');
  reg.clear('a');
  assert.equal(reg.get('a').status, 'loading'); // clear 后回默认 loading
  assert.equal(reg.get('b').commands[0].name, 'help'); // B 不受影响
});

check('registry.setStatus 保留 commands（probe 失败降级不清空缓存）', () => {
  const reg = new SdkCommandRegistry();
  reg.replace('a', [{ name: 'goal', description: '', argumentHint: '', aliases: [], source: 'sdk' }], 'probe');
  reg.setStatus('a', 'degraded', 'probe failed');
  assert.equal(reg.get('a').status, 'degraded');
  assert.equal(reg.get('a').commands.length, 1); // 命令保留
  assert.equal(reg.get('a').error, 'probe failed');
});

check('registry.replace 空列表 → status empty', () => {
  const reg = new SdkCommandRegistry();
  const snap = reg.replace('a', [], 'changed');
  assert.equal(snap.status, 'empty');
  assert.equal(snap.commands.length, 0);
});

console.log('=== 7) toSdkCommand：SDK 原始对象清洗 ===');

check('toSdkCommand 去前导 / + 非 string 字段归空 + alias 去重', () => {
  const c = toSdkCommand({ name: '/Usage', description: 123, argumentHint: null, aliases: ['cost', 'cost', 'stats', '/usage'] });
  assert.equal(c?.name, 'Usage'); // 去前导 / 不改大小写
  assert.equal(c?.description, '');
  assert.equal(c?.argumentHint, '');
  assert.deepEqual(c?.aliases, ['cost', 'stats']); // 去重 + 去 / + 去掉与 name 同名
  assert.equal(c?.source, 'sdk');
});

check('toSdkCommand name 空 / 非对象 → 丢弃', () => {
  assert.equal(toSdkCommand({ name: '', description: 'x' }), undefined);
  assert.equal(toSdkCommand({ name: '   ' }), undefined);
  assert.equal(toSdkCommand(null), undefined);
  assert.equal(toSdkCommand('string'), undefined);
});

check('toSdkCommand 不泄漏 SDK 原始字段', () => {
  const raw = { name: 'goal', description: 'd', argumentHint: '', aliases: [], extra: 'leak' } as Record<string, unknown>;
  const c = toSdkCommand(raw);
  assert.equal(c?.name, 'goal');
  assert.ok(!c || !('extra' in c), '不应泄漏 SDK 原始字段');
});

check('sdkCommandRegistry 单例存在（供 sdk-backend / ipc-handlers 共用）', () => {
  assert.ok(sdkCommandRegistry instanceof SdkCommandRegistry);
});

console.log('=== 8) Task 4 SDK 动态发现接线契约（sdk-backend 源码）===');
// sdk-backend.ts 经 config-manager → electron 运行时依赖链，无法被 tsx 直接 import，故用源码文本契约
// 钉住跨文件接线不变量（CLAUDE.md：记录接线契约可用源码文本断言）。
const sdkBackendSrc = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');

check('导出 startCommandProbe / cancelCommandProbe', () => {
  assert.ok(/export (async )?function startCommandProbe/.test(sdkBackendSrc), '应导出 startCommandProbe');
  assert.ok(/export async function cancelCommandProbe/.test(sdkBackendSrc), '应导出 cancelCommandProbe');
});

check('control-only probe 使用 shouldQuery:false（Task 1 验证的 B 路径）', () => {
  assert.ok(sdkBackendSrc.includes('shouldQuery: false'), 'probe 应使用 shouldQuery:false 单条消息，不伪造空 prompt');
});

check('Query 类型声明 supportedCommands?（可选，调用前判断）', () => {
  assert.ok(/supportedCommands\?\s*:/.test(sdkBackendSrc), 'Query 类型应有可选 supportedCommands');
});

check('commands_changed 全量替换 source:changed，不 concat', () => {
  assert.ok(sdkBackendSrc.includes("'commands_changed'"), "system 分支应识别 commands_changed");
  assert.ok(
    /replace\(sessionId,\s*rawCommands,\s*'changed'\)/.test(sdkBackendSrc),
    'commands_changed 应 registry.replace 全量替换 source:changed',
  );
});

check('runQuery 开头取消 probe（probe/真实 query 互斥，§7）', () => {
  assert.ok(
    /await cancelCommandProbe\(sessionId\)/.test(sdkBackendSrc),
    'runQuery 应在真实 query 创建前 await cancelCommandProbe',
  );
});

check('markSessionDeleted 清理 probe + registry（生命周期）', () => {
  assert.ok(/cancelCommandProbeInternal\(sessionId,\s*0\)/.test(sdkBackendSrc), 'markSessionDeleted 应取消 probe');
  assert.ok(sdkBackendSrc.includes('sdkCommandRegistry.clear(sessionId)'), 'markSessionDeleted 应 registry.clear');
});

check('emitCommandChanged 走独立 COMMANDS_CHANGED + isSessionActive 守卫', () => {
  assert.ok(sdkBackendSrc.includes('IPC_CHANNELS.COMMANDS_CHANGED'), '应经 COMMANDS_CHANGED 推送（不进 CHAT_EVENT）');
  const m = sdkBackendSrc.match(/function emitCommandChanged[\s\S]*?\n}/);
  assert.ok(m, 'emitCommandChanged 函数应存在');
  assert.ok(m && m[0].includes('isSessionActive'), 'emitCommandChanged 应有 isSessionActive 守卫（迟到事件拒绝）');
});

check('命令发现失败 → degraded（保留缓存命令，不阻塞聊天）', () => {
  assert.ok(sdkBackendSrc.includes("'degraded'"), '失败路径应设 degraded');
});

check('不新增 invokeCommand 通道 / 不额外 spawn claude CLI / 不伪造空 prompt', () => {
  assert.ok(!/invokeCommand|executeCommand/.test(sdkBackendSrc), '不应新增 invokeCommand/executeCommand 通道');
  assert.ok(!/child_process\.spawn/.test(sdkBackendSrc), '不应 child_process.spawn（仅 resolveExecutable 用 execFileSync）');
  assert.ok(!/prompt:\s*''|prompt:\s*""/.test(sdkBackendSrc), '不应伪造空字符串 prompt');
});

console.log('=== 9) command-store（renderer 缓存 + 全量替换 + 按 sessionId 隔离）===');
setActivePinia(createPinia());

check('activeSnapshot 未加载 → 默认 loading（不抛错、不阻塞 UI）', () => {
  const store = useCommandStore();
  const snap = store.activeSnapshot('s-store-1');
  assert.equal(snap.sessionId, 's-store-1');
  assert.equal(snap.status, 'loading');
  assert.equal(snap.commands.length, 0);
});

check('replaceFromEvent 全量替换指定 session', () => {
  const store = useCommandStore();
  store.replaceFromEvent({
    sessionId: 's-store-2',
    snapshot: {
      sessionId: 's-store-2',
      commands: [{ name: 'usage', description: '', argumentHint: '', aliases: [], source: 'sdk' }],
      status: 'ready',
      source: 'probe',
      updatedAt: 't',
    },
  });
  assert.equal(store.activeSnapshot('s-store-2').commands.length, 1);
  assert.equal(store.activeSnapshot('s-store-2').status, 'ready');
});

check('clear 只影响指定 session（A/B 隔离）', () => {
  const store = useCommandStore();
  store.replaceFromEvent({
    sessionId: 'a',
    snapshot: { sessionId: 'a', commands: [], status: 'ready', source: 'probe', updatedAt: 't' },
  });
  store.replaceFromEvent({
    sessionId: 'b',
    snapshot: { sessionId: 'b', commands: [], status: 'ready', source: 'probe', updatedAt: 't' },
  });
  store.clear('a');
  assert.equal(store.activeSnapshot('a').status, 'loading'); // clear 后回默认
  assert.equal(store.activeSnapshot('b').status, 'ready'); // B 不受影响
});

check('commands_changed 全量替换不 concat（旧命令消失）', () => {
  const store = useCommandStore();
  store.replaceFromEvent({
    sessionId: 'c',
    snapshot: {
      sessionId: 'c',
      commands: [
        { name: 'goal', description: '', argumentHint: '', aliases: [], source: 'sdk' },
        { name: 'help', description: '', argumentHint: '', aliases: [], source: 'sdk' },
      ],
      status: 'ready',
      source: 'probe',
      updatedAt: 't',
    },
  });
  store.replaceFromEvent({
    sessionId: 'c',
    snapshot: {
      sessionId: 'c',
      commands: [{ name: 'usage', description: '', argumentHint: '', aliases: [], source: 'sdk' }],
      status: 'ready',
      source: 'changed',
      updatedAt: 't2',
    },
  });
  assert.deepEqual(
    store.activeSnapshot('c').commands.map((cmd) => cmd.name),
    ['usage'],
  );
});

console.log('=== 10) Task 5 IPC / preload / renderer 接线契约（源码）===');

check('preload 暴露 getSessionCommands / onCommandChanged / removeCommandListener', () => {
  const src = readFileSync(path.join('src', 'preload', 'api.ts'), 'utf8');
  assert.ok(src.includes('getSessionCommands'), 'preload 应暴露 getSessionCommands');
  assert.ok(src.includes('onCommandChanged'), 'preload 应暴露 onCommandChanged');
  assert.ok(src.includes('removeCommandListener'), 'preload 应暴露 removeCommandListener');
  assert.ok(src.includes('IPC_CHANNELS.COMMANDS_GET'), 'preload 应 invoke COMMANDS_GET');
  assert.ok(src.includes('IPC_CHANNELS.COMMANDS_CHANGED'), 'preload 应 on(COMMANDS_CHANGED)');
});

check('ipc-handlers 注册 COMMANDS_GET + SESSION_CREATE 触发 probe', () => {
  const src = readFileSync(path.join('src', 'main', 'ipc-handlers.ts'), 'utf8');
  assert.ok(src.includes('IPC_CHANNELS.COMMANDS_GET'), '应注册 COMMANDS_GET handler');
  assert.ok(src.includes('sdkCommandRegistry.get'), 'COMMANDS_GET 应返回 registry snapshot（不返回 Query/stream）');
  assert.ok(
    /startCommandProbe\(session\.id,\s*mainWindow/.test(src),
    'SESSION_CREATE 应触发 startCommandProbe（fire-and-forget）',
  );
});

check('App.vue 全局订阅 onCommandChanged（ChatPage 卸载/后台会话不丢事件）', () => {
  const src = readFileSync(path.join('src', 'renderer', 'App.vue'), 'utf8');
  assert.ok(src.includes('onCommandChanged'), 'App.vue 应订阅 onCommandChanged');
  assert.ok(src.includes('commandStore.replaceFromEvent'), '事件应交给 commandStore.replaceFromEvent');
  assert.ok(src.includes('stopCommandChanges'), 'onBeforeUnmount 应退订');
});

check('session-store create/delete 同步 command-store', () => {
  const src = readFileSync(path.join('src', 'renderer', 'stores', 'session-store.ts'), 'utf8');
  assert.ok(/useCommandStore\(\)\.load\(session\.id\)/.test(src), 'createSession 应 commandStore.load');
  assert.ok(/useCommandStore\(\)\.clear\(id\)/.test(src), 'deleteSession 应 commandStore.clear');
});

console.log('=== 11) Task 6 ChatInput 动态菜单契约（源码）===');

check('ChatInput 不再依赖静态 SLASH_COMMANDS，改用 props.commands', () => {
  const src = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
  assert.ok(!/import\s*\{\s*SLASH_COMMANDS/.test(src), 'ChatInput 不应再 import SLASH_COMMANDS');
  assert.ok(!src.includes("from '../../../shared/constants'"), 'ChatInput 不应再从 constants import 静态列表');
  assert.ok(src.includes('props.commands'), 'ChatInput 应基于 props.commands');
  assert.ok(src.includes('parseSlashInvocation'), '应使用 parseSlashInvocation 路由');
});

check('菜单选择插入 canonical /name（SDK name 不带斜杠，需补 /）', () => {
  const src = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
  assert.ok(src.includes('`/${cmd.name} `'), 'selectSlashCommand 应插入 /${cmd.name} ');
});

check('ChatInput 展示 loading/empty/error 状态（不退回静态列表）', () => {
  const src = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
  assert.ok(src.includes('正在读取 Claude Code 命令'), '应显示 loading 提示');
  assert.ok(src.includes('没有可用 Slash Command'), '应显示 empty 提示');
});

check('ChatPage 从 command-store 传 active snapshot 给 ChatInput', () => {
  const src = readFileSync(path.join('src', 'renderer', 'pages', 'ChatPage.vue'), 'utf8');
  assert.ok(src.includes('activeCommandSnapshot'), 'ChatPage 应有 activeCommandSnapshot computed');
  assert.ok(src.includes(':commands="activeCommandSnapshot'), '应传 :commands');
  assert.ok(src.includes(':command-status="activeCommandSnapshot'), '应传 :command-status');
});

check('constants 删除静态 SLASH_COMMANDS（SDK 命令为真相源）', () => {
  const src = readFileSync(path.join('src', 'shared', 'constants.ts'), 'utf8');
  assert.ok(!src.includes('SLASH_COMMANDS'), 'constants 不应再有 SLASH_COMMANDS');
});

// Slash Command 菜单分页需求（2026-08-06）：移除独立 / 按钮 + 仅前缀匹配 + 每页 5 项分页 + 滚动/键盘跨页。
check('ChatInput 移除独立 slash trigger，/ 由输入触发', () => {
  const src = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
  assert.ok(!src.includes('class="slash-trigger"'), '不应保留独立 slash trigger 按钮');
  assert.ok(!src.includes('insertSlash'), '不应保留 insertSlash 触发函数');
});

check('ChatInput 仅按命令名和 alias 前缀匹配', () => {
  const src = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
  assert.ok(src.includes('startsWith(q)'), '命令名/alias 应使用 startsWith 前缀匹配');
  assert.ok(!src.includes('.includes(q)'), '不应保留 includes 中间匹配兜底');
});

check('ChatInput 使用每页 5 项的分页渲染', () => {
  const src = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
  assert.ok(src.includes('COMMANDS_PAGE_SIZE = 5'), '页面大小应为 5');
  assert.ok(src.includes('visibleCommands'), '模板应使用分页后的 visibleCommands');
  assert.ok(src.includes('slice(0, loadedCommandCount'), '可见命令应按 loadedCommandCount 截取');
});

check('ChatInput 支持滚动触底和键盘跨页', () => {
  const src = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
  assert.ok(src.includes('@scroll="handleSlashMenuScroll"'), '菜单应监听滚动触底');
  assert.ok(src.includes('loadNextCommandPage'), '应存在下一页加载函数');
  assert.ok(src.includes("e.key === 'ArrowDown'"), '应保留 ArrowDown 分页导航');
  assert.ok(src.includes("e.key === 'ArrowUp'"), '应保留 ArrowUp 跨页返回');
});

console.log('=== 12) Task 7 原样发送契约（prepareAttachmentPrompt 纯函数）===');
// 无附件时 prepareAttachmentPrompt 原样返回 trim 后的用户文字（line 173-180），不加自然语言前缀；
// 参数内部空白/引号/中文不被改写；alias 手写不被 canonicalize。
// 包进 async IIFE——CJS 输出不支持 top-level await；汇总/exit 置于 IIFE 内，确保 async 计数完成后再判定。
void (async () => {
  const slashSendCases: Array<{ text: string; expect: string }> = [
    { text: '/goal 完成后停止', expect: '/goal 完成后停止' },
    { text: '/compact 保留中文和  引号"', expect: '/compact 保留中文和  引号"' },
    { text: '/cost', expect: '/cost' },
    { text: '/unknown 任意参数', expect: '/unknown 任意参数' },
    { text: '请解释 /tmp', expect: '请解释 /tmp' },
  ];
  for (const c of slashSendCases) {
    await asyncCheck(`无附件时原样进 SDK：${c.text}`, async () => {
      const result = await prepareAttachmentPrompt({
        sessionId: 's7',
        payload: { text: c.text, attachmentIds: [] },
        attachments: [],
        attachmentPaths: {},
      });
      assert.equal(result.prompt, c.expect, `prompt 应原样（仅 trim 前后空白），实际：${result.prompt}`);
      assert.equal(result.additionalDirectories.length, 0, '无附件不应有 additionalDirectories');
      assert.equal(result.attachmentIds.length, 0, '无附件不应有 attachmentIds');
    });
  }
  await asyncCheck('alias 手写不被 canonicalize（/cost 不变 /usage）', async () => {
    const result = await prepareAttachmentPrompt({
      sessionId: 's7',
      payload: { text: '/cost tokens', attachmentIds: [] },
      attachments: [],
      attachmentPaths: {},
    });
    assert.equal(result.prompt, '/cost tokens', 'alias 应原样，不被改写成 /usage');
  });

  console.log('=== 13) Task 8 local_command_output 落库 + result 兜底契约（源码）===');
  const sdkBackendSrcLco = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
  check('system 分支识别 local_command_output', () => {
    assert.ok(sdkBackendSrcLco.includes("'local_command_output'"), "system 分支应识别 local_command_output");
  });
  check('local_command_output 主进程单一落库（processKind + persisted_message）', () => {
    assert.ok(sdkBackendSrcLco.includes('system:local_command_output'), '应用专用 processKind');
    const m = sdkBackendSrcLco.match(/function persistLocalCommandOutput[\s\S]*?\n}/);
    if (!m) throw new Error('persistLocalCommandOutput 未找到');
    assert.ok(m[0].includes('createMessage'), '应 createMessage 单一落库');
    assert.ok(m[0].includes('persisted_message'), '应推 persisted_message（renderer upsert 不二次落库）');
  });
  check('content string 原样 / 非 string 安全 stringify', () => {
    assert.ok(
      sdkBackendSrcLco.includes("typeof rawContent === 'string' ? rawContent : JSON.stringify"),
      '应 string 原样 / 非 string 安全 stringify',
    );
  });
  check('local_command_output 不靠正文正则猜命令名', () => {
    const m = sdkBackendSrcLco.match(/subtype === 'local_command_output'[\s\S]*?continue;/);
    if (!m) throw new Error('local_command_output 分支未找到');
    assert.ok(!/\.match\(/.test(m[0]), '不应从正文正则提取信息');
  });
  check('result 终态兜底保留（/usage 结果只出现在 result.result）', () => {
    assert.ok(/type === 'result'/.test(sdkBackendSrcLco), 'result 终态分支应保留');
  });

  console.log('=== 14) Task 9 降级 / 隔离 / 迟到事件补全契约（源码）===');
  check('api_retry 不清空已有命令列表（retry 分支不碰 registry）', () => {
    const m = sdkBackendSrcLco.match(/infoSubtype === 'api_retry'[\s\S]*?continue;/);
    if (!m) throw new Error('api_retry 分支未找到');
    assert.ok(!/sdkCommandRegistry/.test(m[0]), 'api_retry 分支不应触碰命令 registry（不清空命令）');
  });
  check('commands_changed 不重新调 supportedCommands（SDK 官定 REPLACE，不 refetch）', () => {
    const m = sdkBackendSrcLco.match(/subtype === 'commands_changed'[\s\S]*?continue;/);
    if (!m) throw new Error('commands_changed 分支未找到');
    assert.ok(!/supportedCommands/.test(m[0]), 'commands_changed 不应重调 supportedCommands');
  });
  check('命令推送/落库出口均有 isSessionActive 守卫（迟到事件对已删会话无效）', () => {
    const emitM = sdkBackendSrcLco.match(/function emitCommandChanged[\s\S]*?\n}/);
    const persistM = sdkBackendSrcLco.match(/function persistLocalCommandOutput[\s\S]*?\n}/);
    assert.ok(emitM && emitM[0].includes('isSessionActive'), 'emitCommandChanged 应有 isSessionActive 守卫');
    assert.ok(persistM && persistM[0].includes('isSessionActive'), 'persistLocalCommandOutput 应有 isSessionActive 守卫');
  });

  console.log('=== 15) Review F1-F4 修复契约 ===');
  // F4：registry revision 代际（纯函数，可测）
  check('F4 registry.getRevision 单调递增，clear 归零', () => {
    const reg = new SdkCommandRegistry();
    assert.equal(reg.getRevision('a'), 0);
    reg.replace('a', [{ name: 'goal', description: '', argumentHint: '', aliases: [], source: 'sdk' }], 'probe');
    assert.equal(reg.getRevision('a'), 1);
    reg.replace('a', [{ name: 'usage', description: '', argumentHint: '', aliases: [], source: 'sdk' }], 'changed');
    assert.equal(reg.getRevision('a'), 2);
    reg.clear('a');
    assert.equal(reg.getRevision('a'), 0);
  });
  // F1：SESSION_CREATE 登记会话，probe 真正启动
  check('F1 SESSION_CREATE 调 markSessionActive 登记会话（probe 守卫可通过）', () => {
    const ipc = readFileSync(path.join('src', 'main', 'ipc-handlers.ts'), 'utf8');
    assert.ok(/markSessionActive\(session\.id\)/.test(ipc), 'SESSION_CREATE 应 markSessionActive(session.id)');
    const backend = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(/export function markSessionActive/.test(backend), 'markSessionActive 应导出');
  });
  // F2：probe 复用会话 SDK 上下文（settings 投影 / 模型映射 / 会话权限）
  check('F2 probe 复用 buildClaudeSettingsProjection / 模型映射 / 会话权限', () => {
    const backend = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(/function buildProbeSdkOptions/.test(backend), '应存在 buildProbeSdkOptions');
    const m = backend.match(/function buildProbeSdkOptions[\s\S]*?return \{ options, exe \};/);
    if (!m) throw new Error('buildProbeSdkOptions 未找到');
    assert.ok(m[0].includes('buildClaudeSettingsProjection'), 'probe 应用 settings 投影');
    assert.ok(m[0].includes('resolveAliasToActualModel'), 'probe 应用模型别名映射');
    assert.ok(m[0].includes('applySessionPermissionUpdates'), 'probe 应用会话权限更新');
  });
  // F3：SESSION_UPDATE workingDir 变化触发重新 probe；startCommandProbe 标 stale
  check('F3 workingDir 变化触发重新 probe（SESSION_UPDATE + stale 标记）', () => {
    const ipc = readFileSync(path.join('src', 'main', 'ipc-handlers.ts'), 'utf8');
    assert.ok(/data\.workingDir/.test(ipc) && /startCommandProbe\(/.test(ipc), 'SESSION_UPDATE 应在 workingDir 更新后 startCommandProbe');
    const backend = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(/'stale'/.test(backend), 'startCommandProbe 重新探测应标 stale（保留旧命令）');
  });
  // F4：异步 supportedCommands 结果用 getRevision 校验（防旧 probe 覆盖较新 commands_changed）
  check('F4 supportedCommands 异步结果用 getRevision 代际校验（防旧覆盖新）', () => {
    const backend = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(backend.includes('getRevision(sessionId)'), 'probe/init fallback 应校验 revision');
    assert.ok(/getRevision\(sessionId\) === startRev/.test(backend), '应校验 startRev === 当前 revision');
  });

  console.log('=== 16) Review F5 命令输出去重契约 ===');
  const mkMsg = (role: Message['role'], content: string | null, processKind: string | null): Message =>
    ({
      id: 'x',
      sessionId: 's',
      role,
      content,
      rawEvent: null,
      eventType: 'message',
      costUsd: null,
      durationMs: null,
      parentTaskId: null,
      processKind,
      parentAgentId: null,
      toolUseId: null,
    }) as Message;
  check('F5 result-only：无相同 local 输出 → false（需补 assistant 正文）', () => {
    assert.equal(hasLocalCommandOutputMessage([], 'X'), false);
    assert.equal(hasLocalCommandOutputMessage([mkMsg('assistant', 'A', null)], 'X'), false);
  });
  check('F5 local+相同 result → true（去重，不重复展示）', () => {
    const messages = [mkMsg('user', '/usage', null), mkMsg('system', 'X', 'system:local_command_output')];
    assert.equal(hasLocalCommandOutputMessage(messages, 'X'), true);
  });
  check('F5 local+不同 result → false（都保留）', () => {
    const messages = [mkMsg('user', '/usage', null), mkMsg('system', 'X', 'system:local_command_output')];
    assert.equal(hasLocalCommandOutputMessage(messages, 'Y'), false);
  });
  check('F5 只查本回合（用户消息之后）', () => {
    const messages = [
      mkMsg('system', 'X', 'system:local_command_output'), // 上一回合
      mkMsg('user', '新消息', null),
      mkMsg('system', 'Z', 'system:local_command_output'), // 本回合
    ];
    assert.equal(hasLocalCommandOutputMessage(messages, 'X'), false);
    assert.equal(hasLocalCommandOutputMessage(messages, 'Z'), true);
  });
  check('F5 ensureResultMessage 调用去重（源码契约）', () => {
    const src = readFileSync(path.join('src', 'renderer', 'composables', 'use-chat.ts'), 'utf8');
    assert.ok(src.includes('hasLocalCommandOutputMessage'), 'ensureResultMessage 应调用 hasLocalCommandOutputMessage');
  });

  console.log('=== 17) Review-v2 N1-N4 修复契约 ===');
  const sessionFields = {
    id: 's1',
    name: '会话',
    model: 'sonnet',
    modelOverride: 'opus',
    workingDir: null,
    permissionMode: 'plan',
    maxTurns: 50,
    thinkingLevel: 'high',
  } as Session;
  // N1：增量 opts 由会话配置补全（纯函数）
  check('N1 mergeSpawnOptions 用会话配置补全增量 opts（modelOverride/permissionMode/thinkingLevel）', () => {
    const merged = mergeSpawnOptions(sessionFields, { workingDir: 'D:/proj' });
    assert.equal(merged.modelOverride, 'opus');
    assert.equal(merged.permissionMode, 'plan');
    assert.equal(merged.thinkingLevel, 'high');
    assert.equal(merged.maxTurns, 50);
    assert.equal(merged.workingDir, 'D:/proj'); // 增量优先
  });
  check('N1 mergeSpawnOptions 无会话时原样返回 opts', () => {
    assert.deepEqual(mergeSpawnOptions(null, { workingDir: 'D:/proj' }), { workingDir: 'D:/proj' });
  });
  check('N1 mergeSpawnOptions workingDir:null 保持 null（N2 清除场景）', () => {
    const merged = mergeSpawnOptions(sessionFields, { workingDir: null });
    assert.equal(merged.workingDir, null);
  });
  // N2：SESSION_UPDATE 条件含 null
  check('N2 SESSION_UPDATE 清除工作目录（null）也触发重新 probe', () => {
    const src = readFileSync(path.join('src', 'main', 'ipc-handlers.ts'), 'utf8');
    assert.ok(/data\.workingDir !== undefined/.test(src), '条件应为 workingDir !== undefined（string 和 null 都触发）');
  });
  // N3：startCommandProbe async + 等待旧 probe + 活跃 query 检查
  check('N3 startCommandProbe 等待旧 probe 取消 + 活跃聊天 query 检查', () => {
    const src = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(/export async function startCommandProbe/.test(src), 'startCommandProbe 应为 async');
    assert.ok(/await cancelCommandProbeInternal/.test(src), '应等待旧 probe 取消完成');
    assert.ok(/isEntryActive/.test(src), '应检查活跃聊天 query（活跃时只标 stale）');
  });
  // N4：COMMANDS_GET 无快照触发 probe + switchSession load
  // （report-v1 N6：COMMANDS_GET 改写为「正向 has 判断 + 无快照 markSessionActive + startCommandProbe」，
  //   语义不变——无 per-session 快照仍触发 probe；此处只钉住该接线仍存在。）
  check('N4 COMMANDS_GET 无快照时异步启动 probe（重启后打开已有会话）', () => {
    const src = readFileSync(path.join('src', 'main', 'ipc-handlers.ts'), 'utf8');
    const m = src.match(/IPC_CHANNELS\.COMMANDS_GET[\s\S]*?(?=ipcMain\.handle)/);
    if (!m) throw new Error('COMMANDS_GET handler 未找到');
    assert.ok(m[0].includes('sdkCommandRegistry.has(sessionId)'), 'COMMANDS_GET 应按 per-session 快照判断');
    assert.ok(m[0].includes('startCommandProbe'), '无快照时应触发 probe');
  });
  check('N4 switchSession 触发 commandStore.load（重启后已有会话加载命令）', () => {
    const src = readFileSync(path.join('src', 'renderer', 'stores', 'session-store.ts'), 'utf8');
    assert.ok(
      /switchSession[\s\S]*?useCommandStore\(\)\.load\(session\.id\)/.test(src),
      'switchSession 应 commandStore.load',
    );
  });

  console.log('=== 18) Review-v3 N5 + O1 + O3 修复契约 ===');
  // N5：startCommandProbe 守卫放宽——DB 中真实存在的会话（重启后 activeSessions 为空）也能探测
  check('N5 startCommandProbe 对 DB 存在会话放宽 isSessionActive 守卫', () => {
    const src = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(
      /!isSessionActive\(sessionId\) && !sessionFromDb/.test(src),
      '守卫应为「内存活跃 或 DB 会话存在」',
    );
    assert.ok(src.includes('sessionRepo.getSession(sessionId)'), 'probe 应从 DB 读取会话判断存活');
  });
  // O1：buildProbeSdkOptions 调用在 try/catch 内（fire-and-forget 无 unhandled rejection）
  check('O1 buildProbeSdkOptions 调用包 try/catch（失败标 degraded）', () => {
    const src = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    const m = src.match(/export async function startCommandProbe[\s\S]*?await donePromise;/);
    if (!m) throw new Error('startCommandProbe 未找到');
    assert.ok(
      /try \{[\s\S]*?buildProbeSdkOptions[\s\S]*?\} catch/.test(m[0]),
      'buildProbeSdkOptions 应在 try/catch 内',
    );
    assert.ok(m[0].includes("'degraded'"), '失败应标 degraded');
  });
  // O3：supportedCommands 超时定时器清理
  check('O3 supportedCommands 超时定时器 clearTimeout 清理', () => {
    const src = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(src.includes('clearTimeout(timeoutTimer)'), 'supportedCommands 超时应清理定时器');
  });

  console.log('=== 19) Report-v1：启动兜底 + N6 运行期 + 菜单精简 ===');
  // registry globalFallback 纯函数行为
  check('globalFallback 写入/读取/清空 + 哨兵 sessionId', () => {
    const reg = new SdkCommandRegistry();
    assert.strictEqual(reg.getGlobalFallback(), null, '初始无兜底');
    const snap = reg.setGlobalFallback(
      [{ name: 'foo', description: 'd', argumentHint: '', aliases: [], source: 'sdk' }],
      'probe',
    );
    assert.strictEqual(snap.status, 'ready');
    assert.strictEqual(snap.sessionId, GLOBAL_FALLBACK_SESSION_ID, '兜底快照用哨兵 sessionId');
    assert.strictEqual(reg.getGlobalFallback(), snap, 'getGlobalFallback 返回刚写入的快照');
    reg.clearGlobalFallback();
    assert.strictEqual(reg.getGlobalFallback(), null, '清空后无兜底');
  });
  check('globalFallback 清洗去重与 replace 同款', () => {
    const reg = new SdkCommandRegistry();
    const snap = reg.setGlobalFallback(
      [
        { name: 'foo', description: '', argumentHint: '', aliases: [], source: 'sdk' },
        { name: 'Foo', description: '', argumentHint: '', aliases: [], source: 'sdk' }, // 同名大小写去重
        { name: '', description: '', argumentHint: '', aliases: [], source: 'sdk' }, // 空 name 丢弃
        null,
      ],
      'probe',
    );
    assert.strictEqual(snap.commands.length, 1, '去重 + 丢弃空名后应只剩 1 条');
    assert.strictEqual(snap.commands[0].name, 'foo');
  });
  check('clear(sessionId) 不影响 globalFallback（per-session 优先且隔离）', () => {
    const reg = new SdkCommandRegistry();
    reg.replace('s1', [{ name: 'a', description: '', argumentHint: '', aliases: [], source: 'sdk' }], 'probe');
    reg.setGlobalFallback([{ name: 'g', description: '', argumentHint: '', aliases: [], source: 'sdk' }], 'probe');
    reg.clear('s1');
    assert.strictEqual(reg.has('s1'), false);
    assert.ok(reg.getGlobalFallback() !== null, '清 per-session 不应影响 globalFallback');
  });
  check('get/has 语义不受 globalFallback 影响（无 per-session 仍 loading）', () => {
    const reg = new SdkCommandRegistry();
    reg.setGlobalFallback([{ name: 'g', description: '', argumentHint: '', aliases: [], source: 'sdk' }], 'probe');
    const got = reg.get('s1');
    assert.strictEqual(got.status, 'loading', '无 per-session 快照时 get 仍返回 loading 默认');
    assert.strictEqual(got.commands.length, 0);
    assert.strictEqual(reg.has('s1'), false, 'has 不因 globalFallback 变 true');
  });
  // N6 运行期：COMMANDS_GET 无快照 markSessionActive + 兜底回填
  check('N6 运行期：COMMANDS_GET 无快照 markSessionActive + getGlobalFallback 回填', () => {
    const src = readFileSync(path.join('src', 'main', 'ipc-handlers.ts'), 'utf8');
    const m = src.match(/IPC_CHANNELS\.COMMANDS_GET[\s\S]*?(?=ipcMain\.handle)/);
    if (!m) throw new Error('COMMANDS_GET handler 未找到');
    assert.ok(m[0].includes('markSessionActive(sessionId)'), '无快照应 markSessionActive 让 probe 下游守卫放行');
    assert.ok(m[0].includes('getGlobalFallback()'), '无快照应回填全局兜底');
    assert.ok(m[0].includes("'cache'"), '回填快照 source 应为 cache');
  });
  // 全局兜底探测接线
  check('全局兜底探测：runGlobalCommandProbe / cancelGlobalCommandProbe 接线', () => {
    const src = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(/export function runGlobalCommandProbe/.test(src), '应 export runGlobalCommandProbe');
    assert.ok(/export async function cancelGlobalCommandProbe/.test(src), '应 export cancelGlobalCommandProbe');
    assert.ok(src.includes('GLOBAL_PROBE_SESSION_ID'), '全局探测应用哨兵 sessionId（不污染 per-session map）');
    assert.ok(src.includes('sdkCommandRegistry.setGlobalFallback'), '全局探测应写入 globalFallback');
  });
  check('全局探测启动触发 + 退出清理（index.ts）', () => {
    const src = readFileSync(path.join('src', 'main', 'index.ts'), 'utf8');
    assert.ok(src.includes('runGlobalCommandProbe'), 'app.whenReady 应触发全局探测');
    assert.ok(src.includes('cancelGlobalCommandProbe'), '退出时应 cancelGlobalCommandProbe 防孤儿进程');
  });
  // 菜单精简：仅 /命令名
  check('菜单精简：ChatInput 仅 /命令名，无 desc/hint-arg', () => {
    const src = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
    assert.ok(!src.includes('slash-menu__desc'), '不应再有 slash-menu__desc');
    assert.ok(!src.includes('slash-menu__hint-arg'), '不应再有 slash-menu__hint-arg');
    assert.ok(src.includes('/{{ cmd.name }}'), '菜单应显示 /命令名');
  });

  console.log('=== 20) Review-v5 N7：globalFallback 不被 loading/degraded 清空 ===');
  // setStatusPreservingCommands 纯函数行为
  check('N7 setStatusPreservingCommands：无 per-session 快照时 loading 携带 globalFallback 命令', () => {
    const reg = new SdkCommandRegistry();
    reg.setGlobalFallback(
      [{ name: 'global-cmd', description: '', argumentHint: '', aliases: [], source: 'sdk' }],
      'probe',
    );
    const snap = reg.setStatusPreservingCommands('s1', 'loading');
    assert.strictEqual(snap.status, 'loading');
    assert.strictEqual(snap.commands.length, 1, 'loading 应携带 globalFallback 命令，不清空');
    assert.strictEqual(snap.commands[0].name, 'global-cmd');
    assert.strictEqual(snap.source, 'cache', '命令取自 globalFallback 时 source 标 cache');
  });
  check('N7 setStatusPreservingCommands：degraded 同样保留 globalFallback 命令（异常容错）', () => {
    const reg = new SdkCommandRegistry();
    reg.setGlobalFallback(
      [{ name: 'global-cmd', description: '', argumentHint: '', aliases: [], source: 'sdk' }],
      'probe',
    );
    const snap = reg.setStatusPreservingCommands('s1', 'degraded', '探测失败');
    assert.strictEqual(snap.status, 'degraded');
    assert.strictEqual(snap.commands.length, 1, 'degraded 不应清空兜底命令');
    assert.ok(snap.error, 'degraded 应携带 error');
  });
  check('N7 setStatusPreservingCommands：有 per-session 命令时优先保留（per-session 优先于兜底）', () => {
    const reg = new SdkCommandRegistry();
    reg.replace('s1', [{ name: 'session-cmd', description: '', argumentHint: '', aliases: [], source: 'sdk' }], 'init');
    reg.setGlobalFallback(
      [{ name: 'global-cmd', description: '', argumentHint: '', aliases: [], source: 'sdk' }],
      'probe',
    );
    const snap = reg.setStatusPreservingCommands('s1', 'loading');
    assert.strictEqual(snap.commands.length, 1);
    assert.strictEqual(snap.commands[0].name, 'session-cmd', 'per-session 命令优先于 globalFallback');
  });
  check('N7 setStatusPreservingCommands：无 globalFallback 时 0 命令（兼容现状）', () => {
    const reg = new SdkCommandRegistry();
    const snap = reg.setStatusPreservingCommands('s1', 'loading');
    assert.strictEqual(snap.commands.length, 0);
  });
  // 源码契约：probe 的 non-ready 推送均改用 setStatusPreservingCommands（无残留裸 setStatus 调用）
  check('N7 源码：sdk-backend 的 loading/degraded/stale 推送均用 setStatusPreservingCommands', () => {
    const src = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(/setStatusPreservingCommands\(sessionId, 'loading'/.test(src), '初始 loading 应保留兜底命令');
    assert.ok(/setStatusPreservingCommands\(sessionId, 'degraded'/.test(src), '失败 degraded 应保留兜底命令');
    assert.ok(
      !/sdkCommandRegistry\.setStatus\(/.test(src),
      '不应残留裸 sdkCommandRegistry.setStatus( 调用（9 处应全改为 setStatusPreservingCommands）',
    );
  });
  // 源码契约：回填按 commands 空判断（不再被 has(sid) 跳过）
  check('N7 源码：applyGlobalProbeCommands 回填按 commands 空判断 + 保留会话 status', () => {
    const src = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    const m = src.match(/async function applyGlobalProbeCommands[\s\S]*?clearTimeout\(timeoutTimer\)/);
    if (!m) throw new Error('applyGlobalProbeCommands 未找到');
    assert.ok(m[0].includes('current.commands.length > 0'), '回填应按 commands 空判断，而非 has(sid)');
    assert.ok(m[0].includes('setStatusPreservingCommands(sid, current.status)'), '回填应保留会话当前 status 并补 cache 命令');
  });
  // renderer 行为：cache → loading(携带命令) → ready 序列，命令不被清空
  check('N7 renderer：cache → loading(携带命令) → ready，中途不清空、最终为真实命令', () => {
    setActivePinia(createPinia());
    const store = useCommandStore();
    const sid = 'n7-renderer';
    const cmd = (name: string): SdkCommand => ({ name, description: '', argumentHint: '', aliases: [], source: 'sdk' });
    const snap = (
      commands: SdkCommand[],
      status: SessionCommandSnapshot['status'],
      source: SessionCommandSnapshot['source'],
    ): SessionCommandSnapshot => ({ sessionId: sid, commands, status, source, updatedAt: null });
    // ① COMMANDS_GET 返回 cache（全局兜底立即显示）
    store.replaceFromEvent({ sessionId: sid, snapshot: snap([cmd('cache-cmd')], 'ready', 'cache') });
    assert.strictEqual(store.activeSnapshot(sid).commands.length, 1, 'cache 应有命令');
    // ② COMMANDS_CHANGED 推 loading（携带 cache 命令，N7 修复）——不应清空
    store.replaceFromEvent({ sessionId: sid, snapshot: snap([cmd('cache-cmd')], 'loading', 'cache') });
    assert.strictEqual(store.activeSnapshot(sid).commands.length, 1, 'loading 携带命令，不被清空');
    assert.strictEqual(store.activeSnapshot(sid).status, 'loading');
    // ③ per-session probe 成功 → 真实命令替换 cache（per-session 仍优先）
    store.replaceFromEvent({ sessionId: sid, snapshot: snap([cmd('real-cmd')], 'ready', 'probe') });
    assert.strictEqual(store.activeSnapshot(sid).commands[0].name, 'real-cmd');
    assert.strictEqual(store.activeSnapshot(sid).status, 'ready');
  });
  // 失败路径：degraded(携带命令) 不清空 cache（异常容错）
  check('N7 renderer：degraded(携带命令) 覆盖 cache，命令仍可用（异常容错）', () => {
    setActivePinia(createPinia());
    const store = useCommandStore();
    const sid = 'n7-degraded';
    const cmd = (name: string): SdkCommand => ({ name, description: '', argumentHint: '', aliases: [], source: 'sdk' });
    const snap = (
      commands: SdkCommand[],
      status: SessionCommandSnapshot['status'],
      source: SessionCommandSnapshot['source'],
      error?: string,
    ): SessionCommandSnapshot => ({ sessionId: sid, commands, status, source, updatedAt: null, ...(error ? { error } : {}) });
    store.replaceFromEvent({ sessionId: sid, snapshot: snap([cmd('cache-cmd')], 'ready', 'cache') });
    // per-session probe 失败 → degraded 携带 cache 命令（N7 修复），不清空
    store.replaceFromEvent({ sessionId: sid, snapshot: snap([cmd('cache-cmd')], 'degraded', 'cache', '探测失败') });
    assert.strictEqual(store.activeSnapshot(sid).commands.length, 1, 'degraded 应保留兜底命令');
    assert.strictEqual(store.activeSnapshot(sid).status, 'degraded');
  });

  // ── 汇总 ──
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    process.exit(1);
  }
})().catch((e) => {
  console.error('Task 7 fatal:', e);
  process.exit(1);
});
