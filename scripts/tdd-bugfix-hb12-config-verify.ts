// scripts/tdd-bugfix-hb12-config-verify.ts
// hb12 P2-7【配置批】契约（hb12-CFG-01 快照合并 / CFG-02 空串 / CFG-04 退避清理 / CFG-05 出厂复位 / CFG-07 warn / CFG-V01 safe-store）。
// 注意：mergeProjection 纯函数在主进程模块（import electron）内，本契约以源码形态钉 + 关键行为逻辑注释核对；
// 行为级测试以「合并规则文本钉」+ 独立重放（把 mergeProjection 源码抽出经 node:vm 无 Electron 执行）双保险。
//
// 运行：npx tsx scripts/tdd-bugfix-hb12-config-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const mergeSrc = read('src/main/modules/settings-projection-merge.ts');
const writer = read('src/main/modules/settings-writer.ts');
const cm = read('src/main/modules/config-manager.ts');
const tester = read('src/main/modules/connection-tester.ts');
const projection = read('src/main/modules/claude-settings-projection.ts');
const cliDet = read('src/main/modules/cli-detector.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// 行为级：把 mergeProjection 源码在 stub 环境里执行（无 Electron 依赖的纯逻辑抽取）。
function loadMergeFn(): (snap: Record<string, unknown> | null, cur: Record<string, unknown>, next: Record<string, unknown>) => Record<string, unknown> {
  const fnStart = mergeSrc.indexOf('export function mergeProjection(');
  const fnEnd = mergeSrc.indexOf('/** 便捷封装', fnStart);
  let body = mergeSrc.slice(fnStart, fnEnd > -1 ? fnEnd : undefined)
    .replace('export function mergeProjection(', 'function mergeProjection(');
  // 注入 CL_OWNED_KEYS 常量声明（从源码截取，避免重复维护）。
  const keysStart = mergeSrc.indexOf('const CL_OWNED_KEYS');
  const keysEnd = mergeSrc.indexOf(']);', keysStart) + 4;
  // 剥 TS 类型标注（vm 只懂 JS；本函数体类型标注形态固定，顺序替换可安全剥离）。
  // 注意：常量与函数体先拼接、再整体 replace（replace 只作用于左侧整个字符串表达式）。
  body = (mergeSrc.slice(keysStart, keysEnd) + '\n' + body)
    .replace(/: ReadonlySet<string>/g, '')
    .replace(/: Record<string, unknown> \| null/g, '')
    .replace(/: Record<string, unknown>/g, '')
    .replace(/: string/g, '')
    .replace(/: boolean/g, '')
    .replace(/new Set<string>\(/g, 'new Set(')
    .replace(/ as Record<string, unknown>/g, '')
    .replace(/ as unknown\[\]/g, '')
    .replace(/ as string\[\]/g, '')
    .replace(/\): \{[\s\S]*?\} \{/g, ') {')
    + '\nmergeProjection';
  const context: Record<string, unknown> = {};
  vm.runInNewContext(body, context, { timeout: 1000 });
  return context.mergeProjection as (snap: Record<string, unknown> | null, cur: Record<string, unknown>, next: Record<string, unknown>) => Record<string, unknown>;
}

// ① mergeProjection 行为级（vm 抽取执行）。
const merge = (() => { try { return loadMergeFn(); } catch { return null; } })();
check('① CFG-01 行为级：CC 授权保留（现文件有而快照没有 → 保留）', () => {
  assert.ok(merge, 'mergeProjection 抽取失败');
  const cur = { permissions: { allow: ['Bash(git status)'] }, env: {} };
  const snap = { permissions: { allow: [] }, env: {} };
  const next = { permissions: { allow: [] }, env: {} };
  const out = merge!(snap, cur, next);
  assert.deepEqual((out.permissions as { allow: string[] }).allow, ['Bash(git status)'], 'CC 新增授权被丢');
});

check('② CFG-01 行为级：CL 删除可撤销（投影不再含的非 CL 键 → 保持删除）', () => {
  const cur = { myCustomRule: 'x', env: {} };
  const snap = { myCustomRule: 'x', env: {} };
  const next = { env: {} }; // CL 本次不再投影 myCustomRule
  const out = merge!(snap, cur, next);
  assert.equal(out.myCustomRule, undefined, 'CL 删除的键被旧文件复活（纯并集病灶）');
  // permissions 投影存在时照常产出（CL 权威键，深层合并归 allow/ask/deny）。
  const cur2 = { env: {} };
  const snap2 = { permissions: { allow: ['Read'] }, env: {} };
  const next2 = { permissions: { allow: ['Read'] }, env: {} };
  const out2 = merge!(snap2, cur2, next2);
  assert.deepEqual((out2.permissions as { allow: string[] }).allow, ['Read'], '投影存在时 permissions 应照写');
});

check('③ CFG-01 行为级：CL 自家键照写（覆盖现文件）', () => {
  const cur = { permissions: { defaultMode: 'plan', allow: ['X'] } };
  const snap = { permissions: { defaultMode: 'default' } };
  const next = { permissions: { defaultMode: 'acceptEdits' } };
  const out = merge!(snap, cur, next);
  assert.equal((out.permissions as { defaultMode: string }).defaultMode, 'acceptEdits', '自家键未照写');
  // 非 CL 键（allow 是 CC 会话期写入的细节）保留现文件。
  assert.deepEqual((out.permissions as { allow: string[] }).allow, ['X']);
});

check('④ CFG-01 行为级：无快照首跑保守合并（现文件全部保留）', () => {
  const cur = { hooks: [{ a: 1 }], model: 'x' };
  const next = { permissions: {} };
  const out = merge!(null, cur, next);
  assert.deepEqual(out.hooks, [{ a: 1 }], '首跑丢了现文件内容');
  assert.deepEqual(out.model, 'x');
});

// ⑤ 源码形态钉。
check('⑤ CFG-01：settings-writer 接入 mergeProjectionWithFile + 快照写入', () => {
  assert.match(writer, /mergeProjectionWithFile\(workingDir, rawProjection\)/, 'writer 未接合并');
  assert.match(writer, /writeProjectionSnapshot\(dir, rawProjection\)/, '落盘后缺快照写入');
  assert.match(mergeSrc, /CL_OWNED_KEYS/, '缺所有权键集合');
  assert.match(mergeSrc, /claude-link-projection-snapshot\.json/, '缺快照文件名');
});

// ⑪ hb13-v B1（F-01/F-02）：快照比对补齐——非 CL 键「现文件==快照 → 写 CL 新值」；
// permissions 标量删除不复活（档位切回后旧值不再残留）。
check('⑪ B1 行为级：CL 改非所有权键（现文件==快照）可写入；CC 外改保留；档位切回更新', () => {
  assert.ok(merge, 'mergeProjection 抽取失败');
  // 场景 1（F-01）：CL 上次投影 hooks=X（快照），现文件仍 X（无外部改动）——本次 CL 投影
  // hooks=Y 必须落盘（旧实现恒保留现文件，CL 对非所有权键的修改永远无法写入）。
  const out1 = merge!({ hooks: 'X', model: 'm1' }, { hooks: 'X', model: 'm1' }, { hooks: 'Y', model: 'm1' });
  assert.equal(out1.hooks, 'Y', '现文件==快照时 CL 对非所有权键的修改未落盘（F-01）');
  // 场景 2（F-01 对照）：CC 外部改过 hooks（现文件 Z ≠ 快照 X）→ 保留现文件。
  const out2 = merge!({ hooks: 'X' }, { hooks: 'Z' }, { hooks: 'Y' });
  assert.equal(out2.hooks, 'Z', 'CC 外部改动被 CL 投影覆盖');
  // 场景 3（F-02）：权限档切回——快照与现文件的 defaultMode 同为 acceptEdits（CL 上次写的），
  // CL 本次删除该标量 → 保持删除不复活；CC 改过（plan）→ 保留 plan。
  const out3 = merge!(
    { permissions: { defaultMode: 'acceptEdits', allow: [] } },
    { permissions: { defaultMode: 'acceptEdits', allow: [] } },
    { permissions: { allow: [] } },
  );
  assert.equal((out3.permissions as { defaultMode?: string }).defaultMode, undefined, 'CL 删除的标量被现文件复活（F-02：档位切回后旧值残留）');
  const out4 = merge!(
    { permissions: { defaultMode: 'acceptEdits', allow: [] } },
    { permissions: { defaultMode: 'plan', allow: [] } },
    { permissions: { allow: [] } },
  );
  assert.equal((out4.permissions as { defaultMode?: string }).defaultMode, 'plan', 'CC 会话期改写的档位未保留');
  // 场景 5（hb13-v review 补钉）：CL 整体删除数组字段（allow）——现文件与快照相同（都是
  // CL 上次写的 ['A']）→ 保持删除不复活；旧实现引用比较恒不等会把删除复活。
  const out5 = merge!(
    { permissions: { allow: ['A'] } },
    { permissions: { allow: ['A'] } },
    { permissions: {} },
  );
  assert.equal((out5.permissions as { allow?: string[] }).allow, undefined, 'CL 删除的数组字段被现文件复活（引用比较恒不等，review P3）');
  // 场景 6（hb13-v review 补钉对照）：CL 删除数组字段期间 CC 新增了数组项 → 保留现文件。
  const out6 = merge!(
    { permissions: { allow: ['A'] } },
    { permissions: { allow: ['A', 'B'] } },
    { permissions: {} },
  );
  assert.deepEqual((out6.permissions as { allow?: string[] }).allow, ['A', 'B'], 'CL 删除数组期间 CC 新增项未保留');
});

// ⑥ CFG-02：空串语义。
check('⑥ CFG-02：saveProviderProfile 空串=不改动（不 encrypt("")）', () => {
  const idx = cm.indexOf('hb12-CFG-02：空串=不改动');
  assert.ok(idx > -1, 'CFG-02 注释缺失');
  // 窗口 500→800：hb13-v B4/F-06 在同一分支前补两行 clearApiKey 注释，空串分支被推出旧窗
  //（必要同步，断言本身未放松）。
  const body = cm.slice(idx, idx + 800);
  assert.match(body, /input\.apiKey === '' \|\| input\.apiKey === null/, '缺空串分支');
});

// ⑦ CFG-03/04：tester stdin ignore + 清理延迟重试。
check('⑦ CFG-03/04：测试 spawn stdin ignore + 清理延迟重试（taskkill 异步）', () => {
  assert.match(tester, /stdio: \['ignore', 'pipe', 'pipe'\]/, '缺 stdin ignore');
  assert.match(tester, /hb12-CFG-04/, '清理缺延迟重试注释');
  assert.match(tester, /临时目录清理失败（已重试）/, '缺最终失败留证');
});

// ⑧ CFG-05：clearConfig 缓存复位。
check('⑧ CFG-05：clearConfig 复位模型缓存/CLI 缓存/投影快照', () => {
  const idx = cm.indexOf('export function clearConfig');
  const body = cm.slice(idx, cm.indexOf('export function importSettingsFile'));
  assert.match(body, /clearProviderModelsCache\(\);/, '缺模型缓存复位');
  assert.match(body, /resetCliDetectionCache\(\);/, '缺 CLI 缓存复位');
  assert.match(body, /clearProjectionSnapshot\(/, '缺投影快照清理');
  assert.match(cliDet, /export function resetCliDetectionCache\(\)/, 'cli-detector 缺复位导出');
});

// ⑨ CFG-07：advancedJson 非法 JSON warn。
check('⑨ CFG-07：projection 非法 JSON logger.warn（不再静默）', () => {
  assert.match(projection, /advancedJson 非法 JSON，hooks\/env 将丢失/, '缺 warn');
});

// ⑩ CFG-V01：safe-store helper。
check('⑩ CFG-V01：safe-store helper（坏 JSON 备份重建）+ 两处消费', () => {
  const helper = read('src/main/utils/safe-store.ts');
  assert.match(helper, /corrupt-/, '缺 .corrupt 备份');
  assert.match(helper, /createSafeStore/, '缺导出');
  assert.match(cm, /createSafeStore<ConfigStore>/, 'config-manager 未换 helper');
  assert.match(read('src/main/modules/workspace-history.ts'), /createSafeStore<WorkspaceStore>/, 'workspace-history 未换 helper');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
