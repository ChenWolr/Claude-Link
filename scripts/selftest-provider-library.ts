// 自测：多供应商模型库（doc1 §3-§6）——迁移纯函数 / 掩码 / 模型列表校验 / 查询归一化 / IPC 接线契约。
// 运行：npx tsx scripts/selftest-provider-library.ts（不启动 Electron）。

import {
  maskApiKey,
  buildLegacyProviderProfile,
  sanitizeProviderModels,
} from '../src/shared/provider-library';
import {
  normalizeAnthropicModelsPayload,
  normalizeOpenAiModelsPayload,
} from '../src/main/modules/model-resolver';

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

console.log('\n=== 1) apiKey 掩码（明文不出主进程）===');
{
  check('长 key 取末 4 位掩码', maskApiKey('sk-abcdef1234') === 'sk-…****1234', maskApiKey('sk-abcdef1234'));
  // P3-7 同步：≤8 字符短 key 尾部 4 位即可拼出大半原文 → 纯占位符，不尾随任何原文。
  check('短 key 掩码为纯占位符（不回显任何原文片段）', maskApiKey('k9') === 'sk-…****');
  check('8 字符边界 key 同样纯占位符', maskApiKey('12345678') === 'sk-…****');
  check('空 key 返回空串', maskApiKey('') === '');
  check('空白 key 返回空串', maskApiKey('   ') === '');
}

console.log('\n=== 2) 老单供应商配置 → 档案迁移（纯函数）===');
{
  const now = 1737000000000;
  // 全新安装：无 key 且供应商名是默认值 → 不生成档案。
  const fresh = buildLegacyProviderProfile(
    { providerName: 'Anthropic', providerNote: '', apiBaseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-6', hasApiKey: false },
    'p1', now,
  );
  check('全新安装不生成档案', fresh === null);

  // 老用户：配了 key（第三方网关）→ 生成档案，models 含 defaultModel 一条（manual）。
  const migrated = buildLegacyProviderProfile(
    { providerName: '智谱 GLM', providerNote: '主力', apiBaseUrl: 'https://open.bigmodel.cn/api/anthropic', defaultModel: 'glm-4.6', hasApiKey: true },
    'p1', now,
  );
  check('老配置生成档案', migrated !== null);
  check('档案名/备注/地址来自老字段', migrated?.name === '智谱 GLM' && migrated?.note === '主力' && migrated?.apiBaseUrl === 'https://open.bigmodel.cn/api/anthropic');
  check('models 含 defaultModel 一条（manual）', migrated?.models.length === 1 && migrated?.models[0]?.id === 'glm-4.6' && migrated?.models[0]?.source === 'manual');
  check('createdAt/updatedAt = now', migrated?.createdAt === now && migrated?.updatedAt === now);

  // 无 key 但自定义了供应商名 → 也算已配置（生成档案）。
  const noKey = buildLegacyProviderProfile(
    { providerName: 'sub2api', providerNote: '', apiBaseUrl: 'https://sub2.example.com', defaultModel: '', hasApiKey: false },
    'p2', now,
  );
  check('自定义供应商名（无 key）也生成档案', noKey !== null && noKey.models.length === 0);
}

console.log('\n=== 3) 模型列表校验（同供应商内 ID 唯一）===');
{
  const cleaned = sanitizeProviderModels([
    { id: ' glm-4.7 ', name: '  ', maxTokens: 98304, source: 'queried', addedAt: 1 },
    { id: 'manual-x' },
    'garbage' as never,
  ].filter((x) => typeof x === 'object'));
  check('id 去空白 / 缺省补 name=source 默认', cleaned[0]?.id === 'glm-4.7' && cleaned[0]?.name === 'glm-4.7' && cleaned[0]?.source === 'queried');
  check('缺省项补 queried 来源与 addedAt', cleaned[1]?.source === 'queried' && typeof cleaned[1]?.addedAt === 'number');
  check('maxTokens 非法值归 0', sanitizeProviderModels([{ id: 'a', maxTokens: -5 }])[0]?.maxTokens === 0);

  let dupThrew = false;
  try {
    sanitizeProviderModels([{ id: 'a' }, { id: 'a' }]);
  } catch {
    dupThrew = true;
  }
  check('重复 ID 抛错', dupThrew);

  let emptyThrew = false;
  try {
    sanitizeProviderModels([{ id: '  ' }]);
  } catch {
    emptyThrew = true;
  }
  check('空 ID 抛错', emptyThrew);
}

console.log('\n=== 4) 查询响应归一化（Anthropic / OpenAI 双形状）===');
{
  const anth = normalizeAnthropicModelsPayload({
    data: [
      { id: 'glm-4.7', display_name: 'GLM-4.7 旗舰', max_output_tokens: 98304 },
      { id: 'glm-4.6' },
      { display_name: '坏条目' },
    ],
  });
  check('Anthropic 归一化 2 条（无 id 条目丢弃）', anth.length === 2, JSON.stringify(anth));
  check('display_name/max_output_tokens 映射', anth[0]?.name === 'GLM-4.7 旗舰' && anth[0]?.maxTokens === 98304);
  check('无 display_name 回落 id', anth[1]?.name === 'glm-4.6');
  check('OpenAI 归一化（无元数据，maxTokens=0）', normalizeOpenAiModelsPayload({ data: [{ id: 'gpt-5.6' }] })[0]?.maxTokens === 0);
  check('非数组 data 返回空', normalizeAnthropicModelsPayload({ data: null }).length === 0 && normalizeOpenAiModelsPayload({}).length === 0);
}

console.log('\n=== 5) 按档案查询：无 anthropic 早退 / OpenAI 回退 / 缓存 key = profile.id ===');
{
  const resolver = readRel('src/main/modules/model-resolver.ts');
  check('已删除 provider !== anthropic 早退', !resolver.includes("provider !== 'anthropic'"));
  check('签名按档案（profile, apiKey, forceRefresh）', /fetchAvailableModels\(\s*profile: Pick<ProviderProfile, 'id' | 'apiBaseUrl'>,/.test(resolver));
  check('缓存 key = profile.id', /const key = profile\.id;/.test(resolver));
  check('forceRefresh 绕过缓存', resolver.includes('forceRefresh'));
  check('404/401 自动回退 OpenAI Bearer', /status !== 404 && status !== 401/.test(resolver) && resolver.includes('Authorization: `Bearer ${apiKey}`'));
  check('失败带 body 前 200 字', /slice\(0, 200\)/.test(resolver));
  check('TTL 1h', resolver.includes('MODEL_CACHE_TTL_MS = 60 * 60 * 1000'));
}

console.log('\n=== 6) IPC / preload / 主进程接线 ===');
{
  const ipc = readRel('src/shared/types/ipc.ts');
  const api = readRel('src/preload/api.ts');
  const handlers = readRel('src/main/ipc-handlers.ts');
  const configManager = readRel('src/main/modules/config-manager.ts');
  const mainIndex = readRel('src/main/index.ts');
  const connectionTester = readRel('src/main/modules/connection-tester.ts');

  check('6 个供应商通道定义', ipc.includes('PROVIDER_LIST') && ipc.includes('PROVIDER_SAVE') && ipc.includes('PROVIDER_DELETE') && ipc.includes('PROVIDER_RESTORE') && ipc.includes('PROVIDER_QUERY_MODELS') && ipc.includes('PROVIDER_TEST_MODEL'));
  check('PROVIDERS_CHANGED 推送通道', ipc.includes("PROVIDERS_CHANGED: 'providers:changed'"));
  check('旧 MODELS_FETCH 通道已删除', !ipc.includes('MODELS_FETCH'));
  check('preload 暴露 5 方法 + 变更监听', api.includes('listProviders') && api.includes('saveProvider') && api.includes('deleteProvider') && api.includes('queryProviderModels') && api.includes('testProviderModel') && api.includes('onProvidersChanged'));
  check('ipc-handlers 注册全部 handler', handlers.includes('IPC_CHANNELS.PROVIDER_LIST') && handlers.includes('IPC_CHANNELS.PROVIDER_SAVE') && handlers.includes('IPC_CHANNELS.PROVIDER_DELETE') && handlers.includes('IPC_CHANNELS.PROVIDER_RESTORE') && handlers.includes('IPC_CHANNELS.PROVIDER_QUERY_MODELS') && handlers.includes('IPC_CHANNELS.PROVIDER_TEST_MODEL'));
  check('增删改后广播 PROVIDERS_CHANGED', handlers.includes('broadcastProvidersChanged'));
  check('查询在主进程内解密（renderer 拿不到明文）', handlers.includes('decryptProviderApiKey(profile)'));
  check('config-manager 提供迁移 + CRUD + 恢复 + lastUsed', configManager.includes('export function ensureProviderMigration') && configManager.includes('export function saveProviderProfile') && configManager.includes('export function deleteProviderProfile') && configManager.includes('export function restoreDeletedProvider') && configManager.includes('export function recordLastUsedProviderModel'));
  check('迁移幂等（键存在即跳过）', configManager.includes("s.has('providerProfiles')"));
  // CDP 冒烟实测抓到的回归：electron-store 的 defaults 并入 store 视图参与 has()，
  // defaults 一旦给 providerProfiles 默认值（哪怕是 []），迁移守卫永远为真 → 老用户升级路径静默断裂。
  check('defaults 不含 providerProfiles/lastUsed 默认值（守卫依赖 has() 真实性）', !/providerProfiles:s*[]/.test(configManager) && !/lastUsedProviderId:s*null,/.test(configManager));
  check('老字段投影（projectLegacyFields 内写 settings.local.json）', /function projectLegacyFields[\s\S]*?writeClaudeSettings/.test(configManager));
  check('启动时执行迁移（main/index.ts）', mainIndex.includes('ensureProviderMigration()'));
  check('行内测试按指定供应商+模型 spawn', connectionTester.includes('export async function runProviderModelTest') && connectionTester.includes('getStoredProviderProfile(providerId)'));
  check('弹框流式测试已删（测试收敛到行内直返）', !connectionTester.includes('runTestConnectionStream') && connectionTester.includes('export async function runProviderModelTest'));
}

console.log('\n=== 7) 渲染层：provider-store + 四组件（r9 视觉契约）===');
{
  const store = readRel('src/renderer/stores/provider-store.ts');
  const pm = readRel('src/renderer/components/providers/ProviderManager.vue');
  // 只扫模板区（注释里的设计说明会提到这些词，不算 UI 残留）。
  const pmTemplate = pm.slice(pm.indexOf('<template>'));
  const pe = readRel('src/renderer/components/providers/ProviderEditor.vue');
  const pml = readRel('src/renderer/components/providers/ProviderModelList.vue');
  const pmp = readRel('src/renderer/components/providers/ProviderModelPicker.vue');

  check('provider-store：加载 + 订阅变更 + 与主进程同源解析', store.includes('listProviders') && store.includes('onProvidersChanged') && store.includes('resolveSessionModel'));
  check('四组件齐备', pm.length > 0 && pe.length > 0 && pml.length > 0 && pmp.length > 0);
  check('左栏 230px（14.375rem）+ 新建按钮', pm.includes('width: 14.375rem') && pm.includes('新建供应商'));
  check('供应商档案支持编辑入口与带 id 保存', pmTemplate.includes('编辑') && pm.includes('startEditing') && /:id="editing \? current\?\.id/.test(pm) && pe.includes('defineProps') && pe.includes('id?: string'));
  check('详情中不回显 API Key 掩码', !pmTemplate.includes('Key <code>') && !pm.includes('current.apiKeyMasked'));
  check('详情框与左栏紧挨（gap 0 + 共享圆角）', pm.includes('gap: 0') && pm.includes('border-radius: 0 var(--radius-md) var(--radius-md) 0'));
  const providerStore = readRel('src/renderer/stores/provider-store.ts');
  check('供应商保存先转为纯对象，避免响应式代理无法结构化克隆', providerStore.includes('JSON.parse(JSON.stringify(input))') && providerStore.includes('saveProvider(plainInput)'));
  check('模型 ID 与名称相同时不重复显示名称', pml.includes('m.name !== m.id') && /v-if="m\.name !== m\.id"/.test(pml));
  check('无选用语义：模板无「使用中/设为当前使用/默认模型」', !pmTemplate.includes('使用中') && !pmTemplate.includes('设为当前使用') && !pmTemplate.includes('默认模型'));
  check('删除供应商走确认弹窗（requestConfirm）', pm.includes('requestConfirm'));
  check('删除供应商可撤销（restoreDeleted）', pm.includes('restoreDeleted'));
  check('行内测试按钮（spinner → 通过/失败态）', pml.includes('testProviderModel') && pml.includes("testStates.get(m.id) === 'pending'") && pml.includes("=== 'ok'") && pml.includes("=== 'fail'"));
  check('行内测试失败反馈包含 detail（便于定位 URL/Key/模型错误）', pml.includes('result.detail'));
  check('查询组合框：首开自动拉取', pmp.includes("phase.value === 'idle'") && pmp.includes('runQuery(false)'));
  check('查询组合框：刷新强制重查', pmp.includes('runQuery(true)') && pmp.includes('重新查询'));
  check('查询组合框：确认按钮在拉框内', pmp.includes('确认'));
  check('查询组合框：ESC/点外部关闭', pmp.includes("key === 'Escape'") && pmp.includes('handleClickOutside'));
  check('查询组合框：已添加置灰打勾', pmp.includes(':disabled="addedSet.has(x.id)"') && pmp.includes('已添加'));
  check('查询组合框：无匹配提示手动添加', pmp.includes('手动添加'));
  check('查询组合框：骨架屏', pmp.includes('skel'));
  check('查询输入框不再显示突兀的内层焦点框', !pmp.includes('.searchbox:focus-within') && /\.searchbox \{[\s\S]*?border: 0;/.test(pmp) && pmp.includes('.searchbox input:focus-visible') && /\.searchbox input:focus-visible[\s\S]*?box-shadow: none/.test(pmp));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
