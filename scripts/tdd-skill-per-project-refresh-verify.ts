// tdd-skill-per-project-refresh-verify.ts
// UI13-P8「Skill 每项目刷新与目录监听」契约脚本（docs/plans/2026-11-14-ui13-batch/03-test-cases.md
// P8 节 T8-A~M 转写；实现细节见 01-impl-details.md P8 节 A/B/C/D/E 五段；R7 裁决：广播不受
// skillAutoSync 门控、重探受门控）。
// 用例→断言映射：
//   T8-A   全局刷新回归门：spawn npx tsx scripts/tdd-skill-refresh-verify.ts 退出码 0；
//   T8-B   项目作用域刷新按钮：data-testid="skill-project-refresh" + :disabled + @click 接线（结构钉）；
//   T8-C   整句提示清零：负向钉「监听 ~/.claude/skills 与全局工作目录 …」零命中 + 新 hint 两态字面（结构钉）；
//   T8-D   清单三源 ∪ 且 ≤20：镜像纯逻辑直测（normalizeDirKey/mergeProjectDirs 真函数 + >20 夹具
//          截断、去重、默认目录必含）+ handler / index.ts 注入侧结构钉；
//   T8-E   会话 distinct 工作目录源：session-repo listRecentWorkingDirs SQL 文本提取 → 内存
//          better-sqlite3 夹具直测（>20 行截断、MAX(updated_at) DESC、NULL/空串排除、distinct），
//          ABI 不匹配时按 p1-10/bridge-binding 先例以 ELECTRON_RUN_AS_NODE 重 spawn 自身；
//   T8-F   清单内每目录被监听：commandSourceRoots 行为直测（注入 getProjectSkillDirs → 每目录
//          .claude/skills 入 allRoots、只加 skills 不加 commands）+ deps 接口结构钉；
//          T8-F-3（UI13 批评审 P2-D）增量挂载：refreshFingerprints 比对本次 roots vs 已挂载
//          集合——新增根增量挂载、消失根关闭句柄（结构钉：roots 差集 → mountRoot/close 字面
//          + 误导注释「mountAll 自然覆盖新根」清零）；
//   T8-G   门控切分：index.ts 广播调用不在 skillAutoSync 门内 + triggerGlobalProbe 既有守卫在位
//          + watcher queueProbe 处广播（R7：广播不受门控）；
//   T8-H   tab 活跃自动重拉：ConfigPage 订阅注册 + tab 守卫 + 重拉调用三链 + 卸载反注册（结构钉）；
//   T8-I   网页端同广播：ipc 常量 + preload 接口/实现 + WEB_CHANNEL_TABLE 两键（结构钉；
//          键集对等全量校验由 tdd-web-access-wiring-verify §11.2 承担）；
//   T8-J   作用域归属回归钉：全局=origin==='user-skill' 快照子集 + 用户根 ~/.claude/skills 源不动；
//   T8-K   解析容错回归门：spawn npx tsx scripts/tdd-skill-dirs-generation-verify.ts 退出码 0
//          + 负缓存 60s / parseSkillFrontmatter 跳过结构钉；
//   T8-L   监听风暴防抖/幂等：去抖单 timer 合并 + 指纹未变早退 + 节流/排队机制保留（结构钉）；
//   T8-M   不存在目录静默：computeCommandRootsFingerprint 不存在目录不抛错且指纹确定 + 根构造
//          容错 + pendingRoots 慢重试机制在位（行为直测夹具 + 结构钉）。
// T8-D 镜像申报：清单收集并集/封顶逻辑位于 ipc-handlers handler 与 index.ts 注入闭包内
//（均 electron 重导入链，tsx 不可直 import）——按派发词「重命名等效跟随」以镜像纯逻辑直测 +
// 生产侧结构钉（同形字面）覆盖，如实申报于点报告。
// E4（2026-11-15 eight-issues）最小同步：生产侧并集/封顶装配迁入 src/main/modules/project-dir-set.ts
//（listRecentAndSessionProjectDirs，真实 fs/store 链可 tsx 直驱），handler 与 index.ts 注入闭包改为
// 调用该单一真相源；T8-D-3 结构钉由旧内联字面（listRecentWorkspaces()/listRecentWorkingDirs(20)/
// slice(0, dirCap|20)/dirCap = 20）改指统一函数调用，断言语义不变（三源∪封顶 20 在位）；统一函数
// 内部行为由 scripts/tdd-mcp-skill-dirset-unify-verify.ts 行为钉承担；T8-D-1/2 镜像纯逻辑保留
//（electron 链无关的语义回归面）。
// RED 预期（未实现树）：T8-B/C/D/E/F/G/H/I 先红；T8-A/J/K/L/M 为回归钉现状即绿。
// 运行：npx tsx scripts/tdd-skill-per-project-refresh-verify.ts（登记 scripts/selftest-static-list.txt）

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { normalizeDirKey, mergeProjectDirs } from '../src/shared/project-skills';
import {
  commandSourceRoots,
  computeCommandRootsFingerprint,
  WATCHER_DEBOUNCE_MS,
  WATCHER_PROBE_MIN_INTERVAL_MS,
  type CommandSourceWatcherDeps,
} from '../src/main/modules/command-source-watcher';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readSrc = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const configPageSrc = readSrc('src/renderer/pages/ConfigPage.vue');
const handlersSrc = readSrc('src/main/ipc-handlers.ts');
const indexSrc = readSrc('src/main/index.ts');
const watcherSrc = readSrc('src/main/modules/command-source-watcher.ts');
const sessionRepoSrc = readSrc('src/main/database/repositories/session-repo.ts');
const ipcTypesSrc = readSrc('src/shared/types/ipc.ts');
const preloadSrc = readSrc('src/preload/api.ts');
const webBridgeSrc = readSrc('src/renderer/web/web-bridge.ts');
const mainProjectSkillsSrc = readSrc('src/main/modules/project-skills.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
/** 异步用例（T8-M 指纹直测；tdd-native-command-verify asyncCheck 同款）。 */
async function asyncCheck(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

/** spawn 既有契约脚本（退出码 0 = 绿；失败 tail 供定位）。 */
function spawnAssert(script: string): void {
  const r = spawnSync('npx', ['tsx', script], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-8).join('\n');
  assert.equal(r.status, 0, `${script} 退出码 ${r.status}（回归门被波及）\n${tail}`);
}

/** better-sqlite3 为 Electron ABI：node 不匹配时以 ELECTRON_RUN_AS_NODE 重 spawn 自身透传退出码
 *  （tdd-bridge-binding-repo-verify / p1-10 先例同款；仅 T8-E 内存 DB 夹具需要）。 */
function respawnUnderElectronIfNeeded(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/NODE_MODULE_VERSION/.test(msg)) throw err;
  const r = spawnSync(
    join('node_modules', '.bin', 'electron.cmd'),
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), ...process.argv.slice(1)],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', shell: true },
  );
  process.stdout.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  process.exit(r.status ?? 1);
}

/** 打开内存 DB（ABI 不匹配 → 重 spawn 自身）。 */
function openMemoryDb(): import('better-sqlite3').Database {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    return new Database(':memory:');
  } catch (e) {
    respawnUnderElectronIfNeeded(e);
    throw e; // 不可达（respawn 必 exit）
  }
}

/** handler 切片：SKILL_PROJECT_DIRS_GET 注册行起 → MCP_SNAPSHOT_GET 注册行止（数据源扩容所在）。 */
function dirsHandlerSlice(): string {
  const start = handlersSrc.indexOf('regInvokeHandler(IPC_CHANNELS.SKILL_PROJECT_DIRS_GET');
  const end = handlersSrc.indexOf('regInvokeHandler(IPC_CHANNELS.MCP_SNAPSHOT_GET', start);
  assert.ok(start > -1 && end > start, 'SKILL_PROJECT_DIRS_GET handler 切片定位失败');
  return handlersSrc.slice(start, end);
}

/** index.ts startGlobalCommandPipeline 切片（依赖注入所在）。 */
function pipelineSlice(): string {
  const start = indexSrc.indexOf('function startGlobalCommandPipeline');
  const end = indexSrc.indexOf('app.whenReady()', start);
  assert.ok(start > -1 && end > start, 'startGlobalCommandPipeline 切片定位失败');
  return indexSrc.slice(start, end);
}

/** watcher queueProbe 函数切片（广播联动所在）。 */
function queueProbeSlice(): string {
  const start = watcherSrc.indexOf('function queueProbe');
  const end = watcherSrc.indexOf('function fireProbe', start);
  assert.ok(start > -1 && end > start, 'queueProbe 切片定位失败');
  return watcherSrc.slice(start, end);
}

console.log('\n=== T8-A 全局刷新回归门（spawn 既有脚本） ===');
check('T8-A npx tsx scripts/tdd-skill-refresh-verify.ts 退出码 0（立即刷新/通道/忙态不因本点回归）', () => {
  spawnAssert('scripts/tdd-skill-refresh-verify.ts');
});

console.log('\n=== T8-B 项目作用域刷新按钮（结构钉） ===');
check('T8-B data-testid="skill-project-refresh" 按钮存在 + 项目作用域条件 + 忙态禁用 + @click=ensureProjectDirs 接线', () => {
  assert.ok(configPageSrc.includes('data-testid="skill-project-refresh"'), '缺 data-testid="skill-project-refresh"（项目作用域无手动刷新→新自建 skill 不进 tab 就看不到）');
  const btnAt = configPageSrc.indexOf('data-testid="skill-project-refresh"');
  const btnRegion = configPageSrc.slice(Math.max(0, btnAt - 300), btnAt + 300);
  assert.ok(/v-if="skillScope\.kind === 'project'"/.test(btnRegion) || /v-else-if="skillScope\.kind === 'project'"/.test(btnRegion),
    '按钮渲染条件应绑项目作用域（skillScope.kind === \'project\'）');
  assert.ok(btnRegion.includes(':disabled="projectDirsPending"'), '按钮应随 projectDirsPending 忙态禁用');
  assert.ok(btnRegion.includes('@click="ensureProjectDirs()"'), '按钮应接线 @click="ensureProjectDirs()"（整表重拉=重新枚举）');
  assert.ok(btnRegion.includes('重新枚举'), '按钮文案应为「重新枚举」');
  assert.ok(btnRegion.includes('title="重新枚举项目 Skill 清单"'), '按钮应有 title 说明');
});

console.log('\n=== T8-C 整句提示清零（负向钉 + 新 hint 两态） ===');
check('T8-C 模板不再含「监听 ~/.claude/skills 与全局工作目录 .claude/skills，变化自动重新探测」整句；hint 两态新文案在位', () => {
  assert.ok(!configPageSrc.includes('监听 ~/.claude/skills 与全局工作目录 .claude/skills'),
    '整句提示回潮（用户被误导为已自动同步所有项目——需求 7 明确「提示不要展示」）');
  assert.ok(configPageSrc.includes('目录变化自动重新探测'), 'hint 开态文案缺「目录变化自动重新探测」');
  assert.ok(configPageSrc.includes('已暂停自动同步'), 'hint 关态文案缺「已暂停自动同步」');
  assert.ok(configPageSrc.includes("store.config.skillAutoSync ? '目录变化自动重新探测' : '已暂停自动同步，目录变化需手动刷新'"),
    'hint 应为 skillAutoSync 两态三元（单态化后字面）');
});

console.log('\n=== T8-D 清单三源 ∪ 且 ≤20（镜像纯逻辑直测 + 生产侧结构钉） ===');
{
  // 镜像声明：与 01-P8 A.2 handler 侧同形（normalizeDirKey 去重 → recent 保序在前 → slice(0, 20)）。
  const unionCapDirs = (recent: string[], sessionDirs: string[], cap = 20): string[] => {
    const seen = new Set(recent.map(normalizeDirKey));
    const extra = sessionDirs.filter((d) => !seen.has(normalizeDirKey(d)));
    return [...recent, ...extra].slice(0, cap);
  };
  check('T8-D-1 >20 候选截断至 ≤20（非默认部分）且默认目录必含（mergeProjectDirs 真函数合并）', () => {
    const recent = ['C:\\w\\recent-one', 'C:\\w\\recent-two'];
    const sessionDirs: string[] = [];
    for (let i = 0; i < 25; i++) sessionDirs.push(`C:\\w\\session-proj-${String(i).padStart(2, '0')}`);
    const capped = unionCapDirs(recent, sessionDirs);
    assert.equal(capped.length, 20, `并集封顶应 20，实际 ${capped.length}（上限缺失→>20 全量返回）`);
    assert.equal(capped[0], recent[0], 'recent 应保序在前');
    const merged = mergeProjectDirs(capped, 'C:\\w\\default-dir');
    const nonDefault = merged.filter((d) => !d.isDefault);
    assert.equal(nonDefault.length, 20, `合并默认目录后非默认应仍 20，实际 ${nonDefault.length}`);
    assert.ok(merged.some((d) => d.isDefault && normalizeDirKey(d.path) === normalizeDirKey('C:\\w\\default-dir')),
      '默认目录必含（isDefault=true）——默认目录被丢即红');
  });
  check('T8-D-2 normalizeDirKey 去重：sessionDirs 与 recent 同键（大小写/斜杠差异）不重复入清单', () => {
    const capped = unionCapDirs(['C:\\W\\Same-Dir'], ['c:/w/same-dir/', 'D:\\other']);
    assert.equal(capped.length, 2, `同键去重后应 2 条，实际 ${capped.length}：${JSON.stringify(capped)}`);
    assert.deepEqual(capped, ['C:\\W\\Same-Dir', 'D:\\other']);
  });
  check('T8-D-3 生产侧结构钉：handler recentDirs=统一目录源 listRecentAndSessionProjectDirs(20)（E4 收口）；index.ts getProjectSkillDirs 同源 + 默认目录 concat 尾巴', () => {
    const slice = dirsHandlerSlice();
    // E4 最小同步（头注）：旧内联四字面随装配迁出，本钉改指统一函数调用（断言语义不变）。
    assert.ok(slice.includes('listRecentAndSessionProjectDirs(20)'), 'handler 缺 listRecentAndSessionProjectDirs(20) 统一目录源（E4 收口）');
    const pipe = pipelineSlice();
    assert.ok(pipe.includes('getProjectSkillDirs'), 'index.ts 缺 getProjectSkillDirs 注入（watcher 项目根清单源）');
    const injAt = pipe.indexOf('getProjectSkillDirs');
    const injRegion = pipe.slice(injAt, injAt + 600);
    assert.ok(injRegion.includes('listRecentAndSessionProjectDirs(20)'), '注入闭包缺 listRecentAndSessionProjectDirs(20) 统一目录源（E4 收口）');
    assert.ok(injRegion.includes('normalizeDirKey'), '注入闭包缺 normalizeDirKey（默认目录 concat 尾巴判重）');
    assert.ok(injRegion.includes('workingDirectory'), '注入闭包缺默认目录并入（getConfig().workingDirectory）');
  });
}

console.log('\n=== T8-E 会话 distinct 工作目录源（SQL 文本提取 + 内存 DB 夹具直测） ===');
check('T8-E listRecentWorkingDirs：SQL 提取直测——>20 行截 20、MAX(updated_at) DESC 序、NULL/空串排除、distinct', () => {
  const at = sessionRepoSrc.indexOf('export function listRecentWorkingDirs');
  assert.ok(at > -1, 'session-repo 缺 export function listRecentWorkingDirs（会话目录源缺失→新会话项目不可见）');
  const fnRegion = sessionRepoSrc.slice(at, at + 600);
  const sqlM = /prepare\(\s*"([\s\S]*?)"\s*\)/.exec(fnRegion);
  assert.ok(sqlM, 'listRecentWorkingDirs 缺 prepare("...") SQL 字面（提取直测锚）');
  const sql = sqlM![1];
  assert.ok(/GROUP BY working_dir/.test(sql), 'SQL 缺 GROUP BY working_dir（distinct）');
  assert.ok(/MAX\(updated_at\) AS latest/.test(sql), 'SQL 缺 MAX(updated_at) AS latest（最近活动序）');
  assert.ok(/ORDER BY latest DESC/.test(sql), 'SQL 缺 ORDER BY latest DESC');
  assert.ok(/working_dir IS NOT NULL AND working_dir != ''/.test(sql), 'SQL 缺 NULL/空串排除');
  assert.ok(/LIMIT \?/.test(sql), 'SQL 缺 LIMIT ?（限量）');

  // 内存 DB 夹具直测（ABI 不匹配时 openMemoryDb 内自动重 spawn 自身）。
  const db = openMemoryDb();
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, working_dir TEXT, updated_at INTEGER)');
  const ins = db.prepare('INSERT INTO sessions (id, working_dir, updated_at) VALUES (?, ?, ?)');
  // 22 个 distinct 目录（updated_at 交错）+ 指向同目录的旧会话（MAX 取新）+ NULL + 空串 + 重复行。
  for (let i = 0; i < 22; i++) ins.run(`s${i}`, `C:\\w\\db-dir-${String(i).padStart(2, '0')}`, 1000 + i);
  ins.run('s-old', 'C:\\w\\db-dir-00', 100); // 同目录旧会话：latest 仍取该目录 MAX=1000+0
  ins.run('s-null', null, 9999);
  ins.run('s-empty', '', 9998);
  const rows = db.prepare(sql).all(20) as Array<{ dir: string }>;
  assert.equal(rows.length, 20, `LIMIT 20 应截 20 行，实际 ${rows.length}`);
  const dirs = rows.map((r) => r.dir);
  assert.ok(!dirs.includes(''), '空串应被排除');
  assert.ok(new Set(dirs).size === dirs.length, 'GROUP BY 应 distinct（无重复目录）');
  assert.equal(dirs[0], 'C:\\w\\db-dir-21', '首行应为 MAX(updated_at) 最大目录（最近活动序）');
  assert.equal(dirs[19], 'C:\\w\\db-dir-02', '末行应为第 20 新目录（截断边界）');
  assert.ok(!dirs.includes('C:\\w\\db-dir-00') || dirs.indexOf('C:\\w\\db-dir-00') === 19,
    '同目录多会话应按该目录 MAX 聚合（不因旧行重复/错序）');
  db.close();
});

console.log('\n=== T8-F 清单内每目录被监听（commandSourceRoots 行为直测 + 结构钉） ===');
check('T8-F-1 行为直测：注入 getProjectSkillDirs → 每目录 .claude/skills 入 allRoots；只加 skills 不加 commands', () => {
  const mkDeps = (skillDirs: string[] | undefined): CommandSourceWatcherDeps => ({
    getUserHome: () => 'C:/u',
    getWorkingDirectory: () => 'C:/p',
    triggerGlobalProbe: () => true,
    onConfigSaved: () => () => {},
    logger: { info: () => {}, warn: () => {} },
    ...(skillDirs !== undefined ? { getProjectSkillDirs: () => skillDirs } : {}),
  });
  const r = commandSourceRoots(mkDeps(['C:/proj-a', 'C:/proj-b']));
  assert.ok(r.allRoots.includes(join('C:/proj-a', '.claude', 'skills')), '清单目录 proj-a 的 .claude/skills 应入监听集（仍只监听固定目录→新项目目录变化不触发任何刷新）');
  assert.ok(r.allRoots.includes(join('C:/proj-b', '.claude', 'skills')), '清单目录 proj-b 的 .claude/skills 应入监听集');
  assert.ok(!r.allRoots.includes(join('C:/proj-a', '.claude', 'commands')), '清单目录的 .claude/commands 不得入监听集（契约只扩 skills；命令侧维持现状仅默认目录）');
  assert.equal(r.allRoots.filter((x) => x === join('C:/p', '.claude', 'skills')).length, 1, '默认目录 skills 根保持单份（不因清单重复）');
  // 缺省依赖（旧 deps 形态）→ 行为与现状一致（4 根；tdd-native-command-verify D3 同口径回归）。
  const rLegacy = commandSourceRoots(mkDeps(undefined));
  assert.equal(rLegacy.allRoots.length, 4, '缺省 getProjectSkillDirs 时应维持现状 4 根（可选项兼容）');
});
check('T8-F-2 结构钉：deps 接口含 getProjectSkillDirs/onProjectSkillsChanged 可选依赖；roots 构造以 getProjectSkillDirs 为源（skills join）', () => {
  // 可选依赖两种等价 TS 形态皆可（01 原文为方法简写 `getProjectSkillDirs?(): string[]`）。
  assert.ok(/getProjectSkillDirs\?\s*\(\)\s*:\s*string\[\]|getProjectSkillDirs\?\?:\s*\(\)\s*=>\s*string\[\]/.test(watcherSrc),
    'deps 缺可选 getProjectSkillDirs(): string[]');
  assert.ok(/onProjectSkillsChanged\?\s*\(\)\s*:\s*void|onProjectSkillsChanged\?\?:\s*\(\)\s*=>\s*void/.test(watcherSrc),
    'deps 缺可选 onProjectSkillsChanged(): void');
  const rootsAt = watcherSrc.indexOf('export function commandSourceRoots');
  const rootsRegion = watcherSrc.slice(rootsAt, rootsAt + 1200);
  assert.ok(rootsRegion.includes('getProjectSkillDirs'), 'commandSourceRoots 应以 deps.getProjectSkillDirs 为项目 skills 根源');
  assert.ok(/\.claude',\s*'skills'/.test(rootsRegion), 'roots 构造缺 .claude/skills join');
});
check('T8-F-3 增量挂载（UI13 批评审 P2-D）：refreshFingerprints 比对本次 roots vs 已挂载集合——新增根增量挂载、消失根关闭句柄', () => {
  // 状态侧：按根登记已挂载句柄（差集比对的前提——扁平 FSWatcher[] 无法回答「哪些根已挂」）。
  assert.ok(/mountedRoots: Map<string, FSWatcher\[\]>/.test(watcherSrc),
    'state 缺 mountedRoots: Map<string, FSWatcher[]>（按根登记句柄；无它则无法做「本次 roots vs 已挂载」差集比对）');
  // 刷新侧：refreshFingerprints 调用增量同步——旧实现只刷指纹不补挂载（P2-D 原缺陷本体）。
  const rfAt = watcherSrc.indexOf('async function refreshFingerprints');
  assert.ok(rfAt > -1, 'refreshFingerprints 定位失败');
  const rfBody = watcherSrc.slice(rfAt, watcherSrc.indexOf('\n}', rfAt));
  assert.ok(rfBody.includes('syncMountedRoots(deps'),
    'refreshFingerprints 缺 syncMountedRoots(deps, allRoots) 调用（只刷指纹不补挂载 = 启动后新进清单目录永不建 watch 回潮）');
  // 同步函数本体：差集两向都须在位——新增根复用既有单根挂载 mountRoot（含 pendingRoots 兜底），
  // 消失根走既有 close 清理路径；差集比对按小写同键（与 commandSourceRoots 去重口径一致）。
  const syncAt = watcherSrc.indexOf('function syncMountedRoots');
  assert.ok(syncAt > -1, '缺 syncMountedRoots 增量挂载函数');
  const syncBody = watcherSrc.slice(syncAt, watcherSrc.indexOf('\n}', syncAt));
  assert.ok(syncBody.includes('mountRoot('), '增量同步缺 mountRoot 调用（新增根必须复用既有单根挂载逻辑，目录不存在落 pendingRoots 慢重试）');
  assert.ok(/\.close\(\)/.test(syncBody), '增量同步缺消失根句柄 .close()（已消失根按既有清理路径处理）');
  assert.ok(syncBody.includes('toLowerCase()'), '差集比对缺 toLowerCase() 归一（commandSourceRoots 去重同键口径；win32 大小写不敏感）');
  // 注释与实现对齐：误导性旧注释「mountAll 自然覆盖新根」不得残留（评审 P2-D 点名——
  // mountAll 仅启动/onConfigSaved/错误重挂三处触发，清单增长不触发）。
  assert.ok(!watcherSrc.includes('mountAll 自然覆盖新根'), '「mountAll 自然覆盖新根」注释残留（与实现不符——清单新增根不经 mountAll 挂载）');
});

console.log('\n=== T8-G 门控切分（R7：广播不受门控、重探受门控） ===');
check('T8-G-1 index.ts：onProjectSkillsChanged 直推 SKILL_PROJECT_DIRS_CHANGED 且不受 skillAutoSync 门控；triggerGlobalProbe 守卫仍在门内', () => {
  const pipe = pipelineSlice();
  const bcAt = pipe.indexOf('onProjectSkillsChanged');
  assert.ok(bcAt > -1, 'index.ts 缺 onProjectSkillsChanged 注入');
  const bcRegion = pipe.slice(bcAt, bcAt + 300);
  assert.ok(bcRegion.includes('IPC_CHANNELS.SKILL_PROJECT_DIRS_CHANGED'), '广播应推 IPC_CHANNELS.SKILL_PROJECT_DIRS_CHANGED（空载荷 {}）');
  assert.ok(!bcRegion.includes('skillAutoSync'), '广播调用被 skillAutoSync 门控（关开关后清单永不更新——R7 裁决：广播不受门控）');
  const gateAt = pipe.indexOf('triggerGlobalProbe');
  const gateRegion = pipe.slice(gateAt, gateAt + 400);
  const gatePos = gateRegion.indexOf('!getConfig().skillAutoSync');
  const probePos = gateRegion.indexOf('runGlobalCommandProbe');
  assert.ok(gatePos > -1, 'triggerGlobalProbe 缺 skillAutoSync 早退守卫（重探脱门→关闭后仍自动重探）');
  assert.ok(probePos > gatePos, '重探调用应在 skillAutoSync 守卫之后（门内）');
});
check('T8-G-2 watcher：queueProbe 处联动广播（指纹变化即广播）；该路径不读配置（watcher 保持纯 node 零 app import）', () => {
  const qp = queueProbeSlice();
  assert.ok(qp.includes('onProjectSkillsChanged?.()'), 'queueProbe 缺 deps.onProjectSkillsChanged?.() 广播联动（01 取简实现：任何指纹变化都广播）');
  // 钉代码调用形态而非注释字面（queueProbe 注释可提及门控归属）。
  assert.ok(!/getConfig\(\)\.skillAutoSync|config\.skillAutoSync/.test(qp), 'watcher 不得在 queueProbe 路径读 skillAutoSync 配置（门控在 index.ts triggerGlobalProbe 注入侧）');
  assert.ok(!watcherSrc.includes('from \'electron\'') && !watcherSrc.includes('from "electron"'), 'watcher 不得 import electron（模块零 app import 测试边界）');
});

console.log('\n=== T8-H tab 活跃自动重拉（订阅 + 守卫 + 重拉三链） ===');
check('T8-H ConfigPage：onSkillsProjectDirsChanged 订阅注册于 onMounted + activeTab===\'skill\' 守卫 + void ensureProjectDirs() 重拉 + 卸载反注册', () => {
  const subAt = configPageSrc.indexOf('window.claudeLink.onSkillsProjectDirsChanged(');
  assert.ok(subAt > -1, '渲染层缺 onSkillsProjectDirsChanged 订阅（收到广播不重拉→列表陈旧需手动进出 tab）');
  const cbRegion = configPageSrc.slice(subAt, subAt + 300);
  assert.ok(cbRegion.includes("activeTab.value === 'skill'"), '订阅回调缺 Skill tab 活跃守卫');
  assert.ok(cbRegion.includes('void ensureProjectDirs()'), '订阅回调缺 void ensureProjectDirs() 重拉调用');
  const mountedAt = configPageSrc.lastIndexOf('onMounted(', subAt);
  assert.ok(mountedAt > -1, '订阅应注册于 onMounted（随页面生命周期）');
  assert.ok(/stopSkillDirsChanged[\s\S]{0,200}onSkillsProjectDirsChanged\(/.test(configPageSrc) ||
    /onSkillsProjectDirsChanged\([\s\S]{0,200}stopSkillDirsChanged/.test(configPageSrc.slice(Math.max(0, subAt - 200), subAt + 400)),
    '订阅句柄应存 stop 变量（反注册用）');
  // 反注册须位于 onBeforeUnmount 钩子体内（页面存在多个卸载钩子：既有保存 flush 钩子在前）。
  assert.ok(/onBeforeUnmount\(\(\) => \{\s*stopSkillDirsChanged\?\.\(\);/.test(configPageSrc),
    'onBeforeUnmount 缺 stopSkillDirsChanged?.() 反注册（泄漏）');
});

console.log('\n=== T8-I 网页端同广播（新推送通道落点） ===');
check('T8-I ipc 常量 skills:projectDirsChanged + preload 接口/实现 onSkillsProjectDirsChanged/removeSkillsProjectDirsListener + WEB_CHANNEL_TABLE 两键', () => {
  assert.ok(ipcTypesSrc.includes("SKILL_PROJECT_DIRS_CHANGED: 'skills:projectDirsChanged'"),
    "ipc.ts 缺 SKILL_PROJECT_DIRS_CHANGED: 'skills:projectDirsChanged' 常量");
  assert.ok(/onSkillsProjectDirsChanged:\s*\(callback:\s*\(\)\s*=>\s*void\)\s*=>\s*\(\)\s*=>\s*void;/.test(preloadSrc),
    'preload 接口缺 onSkillsProjectDirsChanged 成员（无参回调 → 反注册函数，onWorkspacesChanged 同形）');
  assert.ok(preloadSrc.includes('removeSkillsProjectDirsListener: () => void;'), 'preload 接口缺 removeSkillsProjectDirsListener 成员');
  assert.ok(/onSkillsProjectDirsChanged:\s*\(callback\)\s*=>\s*\{[\s\S]{0,200}ipcRenderer\.on\(IPC_CHANNELS\.SKILL_PROJECT_DIRS_CHANGED/.test(preloadSrc),
    'preload 实现缺 ipcRenderer.on(IPC_CHANNELS.SKILL_PROJECT_DIRS_CHANGED) 订阅');
  assert.ok(preloadSrc.includes('removeSkillsProjectDirsListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.SKILL_PROJECT_DIRS_CHANGED)'),
    'preload 实现缺 removeAllListeners 反注册');
  assert.ok(webBridgeSrc.includes('onSkillsProjectDirsChanged: IPC_CHANNELS.SKILL_PROJECT_DIRS_CHANGED'),
    'WEB_CHANNEL_TABLE 缺 onSkillsProjectDirsChanged 键（网页 Skill 页永不自动更新）');
  assert.ok(webBridgeSrc.includes('removeSkillsProjectDirsListener: IPC_CHANNELS.SKILL_PROJECT_DIRS_CHANGED'),
    'WEB_CHANNEL_TABLE 缺 removeSkillsProjectDirsListener 键');
});

console.log('\n=== T8-J 作用域归属回归钉 ===');
check('T8-J 全局=origin===\'user-skill\' 快照子集 + 用户根 ~/.claude/skills 源不动（归属错乱回归门）', () => {
  assert.ok(configPageSrc.includes(".filter((c) => c.origin === 'user-skill')"),
    'ConfigPage 全局条目应仍过滤 origin===\'user-skill\'（项目 skill 混进全局节点即红）');
  const hAt = handlersSrc.indexOf('collectUserSkillDirNames(');
  assert.ok(hAt > -1, 'handler 缺 collectUserSkillDirNames（全局 fm 名→目录名映射源）');
  const hRegion = handlersSrc.slice(hAt, hAt + 200);
  assert.ok(hRegion.includes("'.claude', 'skills'"), '全局源应仍为 ~/.claude/skills（effectiveUserHome 锚）');
  assert.ok(handlersSrc.includes('collectSkillProjectDirs'), 'handler 仍应走 collectSkillProjectDirs 聚合（签名不变）');
});

console.log('\n=== T8-K 解析容错回归门 ===');
check('T8-K spawn npx tsx scripts/tdd-skill-dirs-generation-verify.ts 退出码 0 + 负缓存 60s / frontmatter 跳过结构钉', () => {
  spawnAssert('scripts/tdd-skill-dirs-generation-verify.ts');
  assert.ok(/BAD_DIR_TTL_MS = 60_000|BAD_DIR_TTL_MS = 60000/.test(mainProjectSkillsSrc), '缺 BAD_DIR_TTL_MS 60s（坏目录反复扫描）');
  assert.ok(/badDirCacheHas\(d\.path\)/.test(mainProjectSkillsSrc), '缺循环头负缓存跳过接线');
  assert.ok(/badDirCacheMark\(/.test(mainProjectSkillsSrc), '缺 stat 超时负缓存标记接线');
  assert.ok(mainProjectSkillsSrc.includes('parseSkillFrontmatter'), '缺 parseSkillFrontmatter（无 frontmatter 跳过）');
});

console.log('\n=== T8-L 监听风暴防抖/幂等（机制保留） ===');
check('T8-L 去抖 1500ms 单 timer 合并 + 指纹未变早退 + 10s 节流/排队/幂等锁重试机制保留（结构钉）', () => {
  assert.equal(WATCHER_DEBOUNCE_MS, 1500, '去抖窗口应保持 1500ms');
  assert.equal(WATCHER_PROBE_MIN_INTERVAL_MS, 10_000, '节流最小间隔应保持 10s');
  assert.ok(/if \(s\.debounceTimer\) return;/.test(watcherSrc), '缺单 timer 合并（窗口内后续事件并入）');
  assert.ok(/cur\.fingerprint === allFp\) return;/.test(watcherSrc), '缺指纹未变早退（无实质变化不 spawn）');
  assert.ok(/isFirstBaseline/.test(watcherSrc), '缺首拍基准不探测');
  assert.ok(/probeQueued/.test(watcherSrc), '缺节流窗口排队合并');
  assert.ok(/swallowedRetryTimer/.test(watcherSrc), '缺幂等锁吞掉后的延迟重试');
  assert.ok(/pendingRoots/.test(watcherSrc), '缺 pendingRoots 慢重试（目录从无到有兜底）');
});

console.log('\n=== T8-M 不存在目录静默（行为直测夹具） ===');
// 尾段 async IIFE（顶层 await 在 cjs 输出下不可用；tdd-native-command-verify 同款）。
void (async () => {
  await asyncCheck('T8-M 不存在目录：指纹计算不抛错且确定；roots 构造含不存在目录无异常；pendingRoots 兜底在位', async () => {
    const ghost = join(repoRoot, 'definitely-not-exists-p8', '.claude', 'skills');
    const fp1 = await computeCommandRootsFingerprint([ghost]);
    const fp2 = await computeCommandRootsFingerprint([ghost]);
    assert.equal(fp1, fp2, '不存在目录指纹应确定（空集指纹，反复扫描不抖动）');
    assert.doesNotThrow(() => {
      commandSourceRoots({
        getUserHome: () => 'C:/u',
        getWorkingDirectory: () => null,
        triggerGlobalProbe: () => true,
        onConfigSaved: () => () => {},
        logger: { info: () => {}, warn: () => {} },
        getProjectSkillDirs: () => [join(repoRoot, 'definitely-not-exists-p8-root')],
      });
    }, '含不存在目录的清单构造 roots 不应抛错（watcher 不崩）');
    assert.ok(watcherSrc.includes('pendingRoots.add(root)'), '缺 pendingRoots 登记（挂载失败慢重试兜底）');
  });

  console.log(`\n===== tdd-skill-per-project-refresh-verify: ${pass} pass / ${fail} fail =====`);
  if (fail > 0) console.log('（存在 FAIL 项：实现缺失或回归——见上方 ❌ 明细）');
  process.exit(fail > 0 ? 1 : 0);
})();
