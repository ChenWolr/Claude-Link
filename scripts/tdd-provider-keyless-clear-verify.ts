// tdd-provider-keyless-clear-verify.ts
// B7（D02-F4 + D02-F5，P3 合并）契约钉：供应商密钥清除入口 + key-less 测试/查询放行。
//
// F4 根因（CONFIRMED）：主进程显式清除通道已备（ProviderSaveInput.clearApiKey:true →
// config-manager 抹掉密文），但渲染层零入口——配过 key 的档案永远回不到 key-less 形态
//（会话链路明确支持无 key：认证走端点侧白名单/外部登录态），唯一出路是毁档重建。
// F5 根因（CONFIRMED）：会话 spawn 支持空 key（applySessionOverrideEnv 显式删
// ANTHROPIC_API_KEY），但行内测试（connection-tester 两处）与模型查询（ipc-handlers）
// 对空 key 一刀切前置拦截——「真实会话能跑通、行内测试却直接判负」。
//
// 修复语义：
//  ① ProviderEditor 加「清除已存密钥」danger 按钮（编辑态且档案有 key 时显示；
//     requestConfirm 二次确认；确认后保存时带 clearApiKey:true；确认清除后又输入了
//     新 key 则新 key 优先——不带 clearApiKey，主进程 else-if 链天然不冲突）；
//  ② connection-tester 两处 / ipc-handlers 查询一处删「未填写 API Key」前置拦截
//     （DECRYPT_FAILED 哨兵拦截保留），按空 key 真实发请求，结果由端点决定；
//  ③ model-resolver 空 key 省略凭据头（x-api-key/Bearer 空头无意义，IP 白名单网关
//     无凭据即可通）。
//
// 运行：npx tsx scripts/tdd-provider-keyless-clear-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

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

const editor = readFileSync(new URL('../src/renderer/components/providers/ProviderEditor.vue', import.meta.url), 'utf8');
const manager = readFileSync(new URL('../src/renderer/components/providers/ProviderManager.vue', import.meta.url), 'utf8');
const tester = readFileSync(new URL('../src/main/modules/connection-tester.ts', import.meta.url), 'utf8');
const ipcHandlers = readFileSync(new URL('../src/main/ipc-handlers.ts', import.meta.url), 'utf8');
const resolver = readFileSync(new URL('../src/main/modules/model-resolver.ts', import.meta.url), 'utf8');

console.log('\n=== B7（D02-F4/F5）：清除 API Key 入口 + key-less 放行 ===');

console.log('-- ① ProviderEditor 清除入口 --');
check('编辑表单有「清除已存密钥」按钮（danger + 二次确认）', () => {
  assert.match(editor, /清除已存密钥/, '缺清除按钮文案');
  assert.match(editor, /requestConfirm\(/, '清除应走 requestConfirm 二次确认');
  assert.match(editor, /danger: true/, '确认弹窗应为 danger 形态');
});
check('清除按钮仅编辑态且有已存 key 时显示（hasApiKey prop 门控）', () => {
  assert.match(editor, /hasApiKey\?: boolean/, '缺 hasApiKey prop');
  assert.match(editor, /props\.id && props\.hasApiKey/, '按钮显示应受编辑态+hasApiKey 门控');
});
check('保存载荷带 clearApiKey（确认清除且未输入新 key 时）', () => {
  assert.match(editor, /clearApiKey: clearApiKeyRequested\.value && !apiKey\.value/, 'clearApiKey 条件不符（输入新 key 应优先新 key）');
});
check('ProviderManager 挂载点传 hasApiKey + handleEditorSave 透传 clearApiKey', () => {
  assert.match(manager, /:has-api-key="editing \? current\?\.hasApiKey : undefined"/, '挂载点缺 hasApiKey 传递');
  assert.match(manager, /payload\.clearApiKey \? \{ clearApiKey: true \}/, 'save 调用缺 clearApiKey 透传');
});

console.log('-- ② key-less 放行（删前置拦截，DECRYPT_FAILED 保留）--');
check('connection-tester 删除「未填写 API Key」前置拦截（两处）', () => {
  assert.ok(!tester.includes('未填写 API Key'), '仍存在「未填写 API Key」前置拦截');
  assert.ok(tester.includes('DECRYPT_FAILED'), 'DECRYPT_FAILED 哨兵拦截应保留');
});
check('模型查询删除「未配置 API Key，无法查询」前置拦截', () => {
  assert.ok(!ipcHandlers.includes('未配置 API Key，无法查询'), '查询仍被前置拦截');
});

console.log('-- ③ model-resolver 空 key 省略凭据头 --');
check('空 key 时 x-api-key / Bearer 头均省略（key-less 网关无凭据可通）', () => {
  assert.match(resolver, /apiKey \? \{\s*'x-api-key': apiKey,/, 'x-api-key 头应受 apiKey 门控');
  assert.match(resolver, /apiKey \? \{ Authorization: `Bearer \$\{apiKey\}` \} : \{\}/, 'Bearer 头应受 apiKey 门控');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
