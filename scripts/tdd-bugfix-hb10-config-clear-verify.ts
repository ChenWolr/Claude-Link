// scripts/tdd-bugfix-hb10-config-clear-verify.ts
// hb10 P2-6（CFG-03，收 PRV-08）契约：clearConfig 恢复出厂投影收口。
//
// 机制现状（hb13-v B4 纠偏，原头注释描述的「set(defaultConfig) 后重投影」机制已被
// hb10-CFG-10 的 clear()+delete 取代）：clearConfig 在 clear() 前 capture 旧 workingDirectory，
// 清后按捕获值把 default 投影重写进旧目录 settings.local.json（diff 模式清净残留）+ 清投影
// 快照，随后 projectLegacyFields() + emitConfigSaved() + 撤销栈清空。
//
// 2026-09-13 二轮补救追加 ②③：hb10-CFG-09（CONFIG_SAVE workingDirectory 验目录）与
// hb10-CFG-05（settings 导入入口四项加固）——round2 验收判两项未实施（P2-B/P2-C）。
// 2026-09-20 收口：CFG-05 项随 settings.json 导入死链路整链删除而移除（原 ③，
// 导入函数与渲染层入口已不存在，见 docs/plans/2026-09-20-settings-connection-audit-plan.md）。
// 2026-09-13 三轮补救追加 ④⑤：hb13-v B4（F-05 清理顺序 + F-06 clearApiKey 显式通道）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-config-clear-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const cm = fs.readFileSync(path.join(repoRoot, 'src/main/modules/config-manager.ts'), 'utf8');
const handlers = fs.readFileSync(path.join(repoRoot, 'src/main/ipc-handlers.ts'), 'utf8');
const configStore = fs.readFileSync(path.join(repoRoot, 'src/renderer/stores/config-store.ts'), 'utf8');
const configTypes = fs.readFileSync(path.join(repoRoot, 'src/shared/types/config.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

check('clearConfig：projectLegacyFields() 位于 emitConfigSaved() 之前（先落投影再广播）', () => {
  const idx = cm.indexOf('export function clearConfig');
  assert.ok(idx > -1, '未找到 clearConfig');
  const body = cm.slice(idx, cm.indexOf('\n}', idx));
  const projIdx = body.indexOf('projectLegacyFields();');
  const emitIdx = body.indexOf('emitConfigSaved();');
  assert.ok(projIdx > -1, 'clearConfig 缺 projectLegacyFields() 重投影');
  assert.ok(emitIdx > projIdx, '重投影必须先于 emitConfigSaved（广播前投影已就位）');
  assert.match(body, /lastDeletedProvider = null;/, 'clearConfig 缺撤销栈清空（收 PRV-08：加密 key 不得跨复位存活）');
});

// ② hb10-CFG-09（二轮补救）：CONFIG_SAVE 拒收非法 workingDirectory（丢弃保旧值）+ 渲染层 notice。
check('② CFG-09：CONFIG_SAVE 验存在目录否则丢弃该字段；渲染层比对回传给 notice', () => {
  const idx = handlers.indexOf('IPC_CHANNELS.CONFIG_SAVE');
  assert.ok(idx > -1, '未找到 CONFIG_SAVE handler');
  const body = handlers.slice(idx, idx + 1200);
  assert.match(body, /fs\.existsSync\(partial\.workingDirectory\)/, '缺存在性校验');
  assert.match(body, /statSync\(partial\.workingDirectory\)\.isDirectory\(\)/, '缺目录类型校验');
  assert.match(body, /已丢弃并保留旧值/, '缺丢弃记账（warn/注释）');
  assert.match(configStore, /已保留原值/, '渲染层缺 notice 文案');
  assert.match(configStore, /plainConfig\.workingDirectory !== this\.config\.workingDirectory/, '渲染层缺回传比对');
});

// ③ hb10-CFG-05（原 2026-09-13 二轮补救项）：已于 2026-09-20 随死链路删除收口移除——
// settings 导入函数与渲染层入口整链不存在，四项加固随之失去载体。

// ④ hb13-v B4（F-05）：clear() 前捕获旧 workingDirectory——清后按捕获值重投影旧目录+清快照
// （旧实现先 clear 致 workingDirectory 复位 null，清理恒被跳过、hb10-P2-6 净残留承诺失效）。
check('④ B4/F-05：clearConfig 捕获旧目录 → 重投影旧目录 → 清快照（顺序钉）', () => {
  const idx = cm.indexOf('export function clearConfig');
  assert.ok(idx > -1, '未找到 clearConfig');
  const body = cm.slice(idx, cm.indexOf('\n}', idx));
  const capIdx = body.indexOf('const previousWorkingDir = getConfig().workingDirectory;');
  const clearIdx = body.indexOf('.clear();');
  assert.ok(capIdx > -1, '缺 clear() 前捕获旧 workingDirectory');
  assert.ok(clearIdx > capIdx, '捕获必须位于 clear() 之前（清后 workingDirectory 已复位）');
  const wdIdx = body.indexOf('writeClaudeSettings(previousWorkingDir');
  const snapIdx = body.indexOf('clearProjectionSnapshot(path.join(previousWorkingDir');
  assert.ok(wdIdx > -1, '缺旧目录 default 重投影（hb10-P2-6 净残留意图）');
  assert.ok(snapIdx > wdIdx, '投影快照必须在旧目录重投影之后再清（diff 净化依赖快照，清早了退化为首跑保守合并）');
});

// ⑤ hb13-v B4（F-06 / hb12-CFG-02）：显式 clearApiKey 布尔清除通道（''=不改语义不变）。
check('⑤ B4/F-06：ProviderSaveInput.clearApiKey 显式通道（清密钥；省略/空串=不改动不变）', () => {
  assert.match(configTypes, /clearApiKey\?: boolean;/, 'ProviderSaveInput 缺 clearApiKey 字段');
  const idx = cm.indexOf('export function saveProviderProfile');
  const body = cm.slice(idx, cm.indexOf('\n}', idx));
  assert.match(body, /input\.clearApiKey === true/, 'saveProviderProfile 缺显式清除分支');
  assert.match(body, /encryptedApiKey: null,\s*apiKeyEncoding: null/, '清除分支须抹密文（encryptedApiKey/apiKeyEncoding 置 null）');
  assert.match(body, /input\.apiKey === '' \|\| input\.apiKey === null/, '空串=不改动语义被破坏（hb12-CFG-02 既有钉）');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
