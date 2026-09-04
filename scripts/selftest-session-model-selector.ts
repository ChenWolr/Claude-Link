// 自测：会话内供应商 × 模型级联选择器 + 全会话统一当前模型（doc2 §7.5）。
// 覆盖：resolveSessionModel 纯函数 + 四别名 env 映射 + Agent 工具 model 改写逻辑 + V8 迁移 + 接线契约。
// 运行：npx tsx scripts/selftest-session-model-selector.ts（不启动 Electron）。

import {
  resolveSessionModel,
  buildUnifiedModelEnv,
  decideAgentModelOverride,
  type ProviderModelSource,
} from '../src/shared/session-model';

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

const LIB: ProviderModelSource[] = [
  { id: 'p1', name: '智谱 GLM', apiBaseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'k1', models: [{ id: 'glm-4.7' }, { id: 'glm-4.6' }, { id: 'glm-4.5-air' }] },
  { id: 'p2', name: 'sub2api', apiBaseUrl: 'https://sub2.example.com', apiKey: 'k2', models: [{ id: 'gpt-5.6' }, { id: 'claude-sonnet-4-6' }] },
  { id: 'p3', name: 'Anthropic 官方', apiBaseUrl: 'https://api.anthropic.com', apiKey: 'k3', models: [{ id: 'claude-opus-4-6' }] },
];

console.log('\n=== 1) resolveSessionModel：会话 override > 最近使用 > 库首 ===');
{
  // 会话显式选择优先。
  const a = resolveSessionModel({ providerOverride: 'p2', modelOverride: 'gpt-5.6' }, { providerId: 'p1', modelId: 'glm-4.7' }, LIB);
  check('会话 override 命中 p2/gpt-5.6', a.provider?.id === 'p2' && a.modelId === 'gpt-5.6' && a.invalidOverride === false);
  check('解析结果带供应商连接信息（spawn 用）', a.provider?.apiBaseUrl === 'https://sub2.example.com' && a.provider?.apiKey === 'k2');

  // 无会话 override → lastUsed。
  const b = resolveSessionModel({ providerOverride: null, modelOverride: null }, { providerId: 'p1', modelId: 'glm-4.6' }, LIB);
  check('无 override 走最近使用', b.provider?.id === 'p1' && b.modelId === 'glm-4.6');

  // 无会话、无 lastUsed → 库首 + 首模型。
  const c = resolveSessionModel({ providerOverride: null, modelOverride: null }, null, LIB);
  check('全无 → 库首供应商 + 首模型', c.provider?.id === 'p1' && c.modelId === 'glm-4.7');

  // lastUsed 指向已删供应商 → 回退库首（无效记忆不报 invalidOverride——只有会话 override 才提示）。
  const d = resolveSessionModel({ providerOverride: null, modelOverride: null }, { providerId: 'gone', modelId: 'x' }, LIB);
  check('lastUsed 供应商已删 → 回退库首', d.provider?.id === 'p1' && d.invalidOverride === false);

  // lastUsed 模型不在该供应商 → 取首模型。
  const e = resolveSessionModel({ providerOverride: 'p2', modelOverride: null }, { providerId: 'p2', modelId: 'glm-4.7' }, LIB);
  check('lastUsed 模型不属该供应商 → 取首模型', e.modelId === 'gpt-5.6');

  // 会话 override 指向已删供应商 → 回退 + invalidOverride 置位（一次性 toast 用）。
  const f = resolveSessionModel({ providerOverride: 'gone', modelOverride: 'gpt-5.6' }, { providerId: 'p1', modelId: 'glm-4.7' }, LIB);
  check('会话供应商已删 → 回退 lastUsed 并标记 invalidOverride', f.provider?.id === 'p1' && f.invalidOverride === true);

  // 会话模型不属于（已回退到的）供应商 → 作废 + 标记。
  const g = resolveSessionModel({ providerOverride: null, modelOverride: 'not-in-p1' }, { providerId: 'p1', modelId: 'glm-4.7' }, LIB);
  check('会话模型不在供应商库 → 作废回退并标记', g.modelId === 'glm-4.7' && g.invalidOverride === true);

  // 空库 → null（主进程回落老字段链）。
  const h = resolveSessionModel({ providerOverride: 'p2', modelOverride: 'gpt-5.6' }, { providerId: 'p2', modelId: 'gpt-5.6' }, []);
  check('空库 → provider/model 为 null', h.provider === null && h.modelId === null);

  // 供应商有模型但 lastUsed/override 全空 → 首模型。
  const i = resolveSessionModel({ providerOverride: 'p3', modelOverride: null }, null, LIB);
  check('选供应商未选模型 → 该供应商首模型', i.provider?.id === 'p3' && i.modelId === 'claude-opus-4-6');
}

console.log('\n=== 2) 四别名 env 统一映射（双保险第一层）===');
{
  const env = buildUnifiedModelEnv('glm-4.6');
  check('ANTHROPIC_MODEL = 当前实际模型', env.ANTHROPIC_MODEL === 'glm-4.6');
  check('SONNET/HAIKU/OPUS/FABLE 四别名全部映射到当前实际模型', env.ANTHROPIC_DEFAULT_SONNET_MODEL === 'glm-4.6' && env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'glm-4.6' && env.ANTHROPIC_DEFAULT_OPUS_MODEL === 'glm-4.6' && env.ANTHROPIC_DEFAULT_FABLE_MODEL === 'glm-4.6');
  check('env 恰好 5 个键', Object.keys(env).length === 5);
}

console.log('\n=== 3) Agent/Task 调用级 model 改写（双保险第二层）===');
{
  check('Task 带 haiku → 改写为当前模型', decideAgentModelOverride('Task', { model: 'haiku', prompt: 'x' }, 'glm-4.6') === 'glm-4.6');
  check('Agent 带自定义模型 → 改写', decideAgentModelOverride('Agent', { model: 'gpt-4o' }, 'glm-4.6') === 'glm-4.6');
  check('未传 model → 补写当前模型（压过 agent 定义缺省继承）', decideAgentModelOverride('Task', { prompt: 'x' }, 'glm-4.6') === 'glm-4.6');
  check('已是当前模型 → 不改写', decideAgentModelOverride('Task', { model: 'glm-4.6' }, 'glm-4.6') === null);
  check('fork 不改（天然继承 parent）', decideAgentModelOverride('Task', { subagent_type: 'fork', model: 'haiku' }, 'glm-4.6') === null);
  check('其它工具不改', decideAgentModelOverride('Bash', { model: 'haiku' }, 'glm-4.6') === null);
  check('无当前模型（老链路回合）不改', decideAgentModelOverride('Task', { model: 'haiku' }, null) === null);
}

console.log('\n=== 4) V8 迁移：provider_override 列 + 别名清洗 ===');
{
  const mig = readRel('src/main/database/migrations.ts');
  check('schema 版本 = 9（V9 tasks.paused 列）', mig.includes('CURRENT_SCHEMA_VERSION = 9'));
  check('新增 provider_override 列（版本块）', mig.includes('ADD COLUMN provider_override TEXT DEFAULT NULL'));
  check('model_override 旧别名清洗为 NULL', /UPDATE sessions SET model_override = NULL\s+WHERE model_override IN \('sonnet', 'haiku', 'opus', 'fable'\)/.test(mig));
  check('幂等自愈也补 provider_override 列', /!hasCol\('provider_override'\)/.test(mig));

  const repo = readRel('src/main/database/repositories/session-repo.ts');
  check('SessionRow 含 provider_override', repo.includes('provider_override: string | null'));
  check('toSession 映射 providerOverride', repo.includes('providerOverride: row.provider_override ?? null'));
  check('updateSession 类型联合含 providerOverride/modelOverride', repo.includes("'providerOverride' | 'modelOverride'"));
  check('updateSession SQL 分支 provider_override', repo.includes("'provider_override = @providerOverride'"));

  const sessType = readRel('src/shared/types/session.ts');
  check('Session 类型含 providerOverride + modelOverride 语义注释（实际模型 ID）', sessType.includes('providerOverride: string | null') && sessType.includes('实际模型'));
}

console.log('\n=== 5) 主进程注入：env / settings / options.model / canUseTool ===');
{
  const cliShared = readRel('src/main/modules/cli-shared.ts');
  const sb = readRel('src/main/modules/sdk-backend.ts');
  const handlers = readRel('src/main/ipc-handlers.ts');
  const tq = readRel('src/main/modules/task-queue-engine.ts');
  const cmdOpts = readRel('src/main/modules/sdk-command-options.ts');

  check('buildSpawnEnv 接受会话覆盖（SessionModelOverride）', cliShared.includes('export interface SessionModelOverride') && /buildSpawnEnv\(override\??: SessionModelOverride \| null\)/.test(cliShared));
  const overrideBlock = cliShared.slice(cliShared.indexOf('if (override) {'));
  check('覆盖应用收口 applySessionOverrideEnv（BASE_URL/API_KEY/AUTH_TOKEN/四别名规则单源）', overrideBlock.includes('applySessionOverrideEnv(env, override)'));

  check('SpawnOptions 含 providerOverride', cliShared.includes('providerOverride?: string | null'));
  check('buildSdkOptions 走 resolveSessionModel', /function buildSdkOptions[\s\S]*?resolveSessionOverride\(opts\)/.test(sb));
  check('buildProbeSdkOptions 同一解析（probe 与真实回合一致）', /function buildProbeSdkOptions[\s\S]*?resolveSessionOverride\(opts\)/.test(sb));
  check('resolveSessionOverride 实现（会话 override > lastUsed > 库首）', /function resolveSessionOverride[\s\S]*?resolveSessionModel\(/.test(sb) && sb.includes('getProviderModelSources()'));
  check('settings.env 注入统一模型（最高优先级通道，与 env 通道同一规则单源）', /buildClaudeLinkSettingsBlock[\s\S]*?applySessionOverrideEnv\(settingsEnv, modelOverride\)/.test(sb));
  check('options.model = 当前实际模型', /buildSdkOptions[\s\S]*?model: override \? override\.modelId :/.test(sb));
  check('entry.resolvedModel 记录当前实际模型（canUseTool 用）', sb.includes('entry.resolvedModel = override?.modelId ?? null'));

  // canUseTool：改写必须在「本会话已授权」本地短路之前，且无条件放行。
  const permHandler = sb.slice(sb.indexOf('function createPermissionHandler'), sb.indexOf('── 句柄：鸭子类型'));
  const rewriteIndex = permHandler.indexOf('decideAgentModelOverride');
  const shortCircuitIndex = permHandler.indexOf('isToolSessionAllowed');
  check('canUseTool 入口调用 decideAgentModelOverride', rewriteIndex >= 0);
  check('改写位于本地短路之前（防 allow-session 跳过改写）', rewriteIndex >= 0 && shortCircuitIndex > rewriteIndex);
  check('改写分支无条件放行（allow + updatedInput，不新增权限）', /decideAgentModelOverride[\s\S]{0,300}behavior: 'allow', updatedInput: \{ \.\.\.input, model: rewriteModel \}/.test(permHandler));

  check('CHAT_SEND spawn 传 providerOverride', handlers.includes('providerOverride: session.providerOverride'));
  check('任务队列出队 spawn 传 providerOverride（v3：出队为唯一队列 spawn，续接路径已删）', (tq.match(/providerOverride: session\?\.providerOverride \?\? null/g) ?? []).length >= 1 && !tq.includes('providerOverride: session.providerOverride ?? null'));
  check('mergeSpawnOptions 补全 providerOverride', cmdOpts.includes("merged.providerOverride = session.providerOverride"));
  check('SESSION_UPDATE 扩展 providerOverride/modelOverride 白名单', handlers.includes("'providerOverride' | 'modelOverride'") && handlers.includes('recordLastUsedProviderModel'));
}

console.log('\n=== 6) 渲染层：级联选择器（A2 视觉 1:1）+ 会话选择链路 ===');
{
  const pms = readRel('src/renderer/components/chat/ProviderModelSelector.vue');
  const st = readRel('src/renderer/components/chat/SessionToolbar.vue');
  const ss = readRel('src/renderer/stores/session-store.ts');
  const api = readRel('src/preload/api.ts');

  check('SessionToolbar 挂载 ProviderModelSelector（替换旧 ModelSelector；生成中不再禁用）', st.includes('<ProviderModelSelector />') && !st.includes('ProviderModelSelector :disabled') && !st.includes("from './ModelSelector.vue'"));
  check('旧 ModelSelector.vue 已删除', readRel('src/renderer/components/chat/ModelSelector.vue') === '');

  // a2 关键尺寸/结构契约（rem 化，随 fontScale 缩放）。
  check('向上弹出（bottom: calc(100% + …)）', pms.includes('bottom: calc(100% + 0.5rem)'));
  check('左列供应商 190px（11.875rem）', pms.includes('width: 11.875rem'));
  check('右列模型 235px（14.6875rem）', pms.includes('width: 14.6875rem'));
  check('两列各最多 4 项可见（item 高 2.625rem × 4）', pms.includes('max-height: calc(2.625rem * 4)'));
  check('右列标题 = 供应商 · N 个模型', pms.includes('个模型'));
  check('左列页脚「设置中管理供应商」跳设置', pms.includes('设置中管理供应商') && pms.includes("router.push('/config')"));
  check('右列页脚「下一条消息起生效 · 全部任务统一当前模型」', pms.includes('下一条消息起生效') && pms.includes('全部任务统一当前模型'));
  check('模型 ID 用 mono 字体', pms.includes('model-id') && /font-mono/.test(pms));
  check('触发器显示 供应商名 / 模型ID + ⌃', pms.includes('model-trigger__provider') && pms.includes('model-trigger__model'));
  check('ESC / 点外部关闭', pms.includes("key === 'Escape'") && pms.includes('handleClickOutside'));
  check('空库兜底「未配置模型 → 前往设置」', pms.includes('未配置模型 → 前往设置'));
  check('两列独立滚动（各自 .scroll overflow-y:auto）', /\.scroll \{[\s\S]*?overflow-y: auto/.test(pms));
  check('显示用与主进程同一 resolveSessionModel（单一真相源）', pms.includes('providerStore.resolve'));

  check('session-store 提供 setActiveSessionProviderModel（一次写两个 override）', ss.includes('async setActiveSessionProviderModel'));
  check('preload updateSession 类型联合含 providerOverride/modelOverride', api.includes("'providerOverride' | 'modelOverride'"));
  check('回退一次性 toast（原供应商/模型已删除）', pms.includes('已回退到') && pms.includes('fallbackToastShownFor'));

  // 别名退场：渲染层不再有别名选择/映射入口。
  const configStore = readRel('src/renderer/stores/config-store.ts');
  check('config-store 已移除 modelMappings getter', !configStore.includes('modelMappings(state)'));
  check('config-store 已移除 setModelMapping/setContextWindowForAlias/syncFormToAdvanced', !configStore.includes('setModelMapping') && !configStore.includes('setContextWindowForAlias') && !configStore.includes('syncFormToAdvanced'));
  check('TestConnectionModal 已删除（弹框测试退场，行内测试为唯一入口）', readRel('src/renderer/components/config/TestConnectionModal.vue') === '');
  check('ModelMappingInputs.vue 已删除', readRel('src/renderer/components/config/ModelMappingInputs.vue') === '');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
