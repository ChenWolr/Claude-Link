// 自测：生成中（sending）解锁模型/思考强度选择器（2026-09-03 midrun-settings-unlock）。
// 覆盖：UI 解锁契约 + 思考强度生效时机文案 + store 无 sending 守卫 + 「下一条生效」架构锁定 + 最小影响面（其余禁用不动）。
// 运行：npx tsx scripts/tdd-midrun-settings-unlock-verify.ts（不启动 Electron）。

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('node:fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodePath = require('node:path');
function readRel(p: string): string {
  const abs = nodePath.resolve(__dirname, '..', p);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8');
}

console.log('\n=== 1) 生成中解锁：模型与思考强度选择器不再随 sending 禁用 ===');
{
  const st = readRel('src/renderer/components/chat/SessionToolbar.vue');
  check('模型选择器不再绑定 :disabled="sending"', st.includes('<ProviderModelSelector />') && !st.includes('ProviderModelSelector :disabled'));
  check('思考强度选择器不再绑定 :disabled="sending"', st.includes('<ThinkingLevelSelector />') && !st.includes('ThinkingLevelSelector :disabled'));
  // sending 禁用恰余 3 处：ContextButton / 工作空间按钮 / 添加文件（最小影响面：其余不动）。
  check('sending 禁用恰余 3 处（上下文/工作空间/添加文件）', (st.match(/:disabled="sending"/g) ?? []).length === 3);
  // 权限按钮现状锁定：生成中本来就可点（bd26a9a streaming 控制请求链路）。
  const permBlock = st.slice(st.indexOf('ref="permissionRef"'), st.indexOf('perm-menu'));
  check('权限触发按钮保持无 disabled 绑定（运行中即时切换现状锁定）', permBlock.includes('ctl__btn') && !permBlock.includes(':disabled'));
  check('权限 tooltip 保留「运行中切换即时生效」', st.includes('运行中切换即时生效'));
}

console.log('\n=== 2) 思考强度生效时机文案（对齐 ProviderModelSelector 先例） ===');
{
  const tl = readRel('src/renderer/components/chat/ThinkingLevelSelector.vue');
  check('菜单底部 foot「下一条消息起生效」', tl.includes('tl-foot') && tl.includes('下一条消息起生效'));
  check('触发器 title 追加生效时机（；下一条消息起生效）', tl.includes('；下一条消息起生效'));
}

console.log('\n=== 3) store 层无 sending 守卫（解锁是纯 UI 层；action 任何时刻可写） ===');
{
  const ss = readRel('src/renderer/stores/session-store.ts');
  const a1 = ss.slice(ss.indexOf('async setActiveSessionThinkingLevel'), ss.indexOf('async loadRecentWorkspaces'));
  const a2 = ss.slice(ss.indexOf('async setActiveSessionProviderModel'), ss.indexOf('async setActiveSessionWorkingDir'));
  check('setActiveSessionThinkingLevel 无 sending/running 守卫', !/sending|runningSessions/.test(a1));
  check('setActiveSessionProviderModel 无 sending/running 守卫', !/sending|runningSessions/.test(a2));
  const a3 = ss.slice(ss.indexOf('async setActiveSessionPermissionMode'), ss.indexOf('async setActiveSessionThinkingLevel'));
  check('权限 action 仍含运行中即时生效调用（现状锁定）', a3.includes('setRunningPermissionMode'));
}

console.log('\n=== 4) 「下一条生效」架构保证锁定（主进程每回合现读，防未来回归） ===');
{
  const sb = readRel('src/main/modules/sdk-backend.ts');
  const h = readRel('src/main/ipc-handlers.ts');
  check('buildSdkOptions 每回合解析 thinkingLevel', /function buildSdkOptions[\s\S]{0,1500}?resolveEffectiveThinkingLevel\(opts\.thinkingLevel \?\? null/.test(sb));
  check('buildSdkOptions 每回合解析会话模型', /function buildSdkOptions[\s\S]{0,1500}?resolveSessionOverride\(opts\)/.test(sb));
  check('CHAT_SEND 每回合现读 DB session', /IPC_CHANNELS\.CHAT_SEND,[\s\S]{0,2000}?sessionRepo\.getSession\(sessionId\)/.test(h));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
