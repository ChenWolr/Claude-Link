// tdd-engine-background-verify.ts
// 「引擎后台请求六开关」行为级契约自测（selftest 门禁，计划 §3.7）。
//
// 验证目标（计划 docs/plans/2026-09-05-engine-background-toggles.md + 用户定案 09-05：
// 六开关 UI 隐藏、默认全开注入）：
//   1.   默认 config（六字段 true）：buildSpawnEnv（进程 env 通道，覆盖 post-turn probe /
//        connection-tester）注入全部六个 DISABLE 键 === '1'。
//   2.   六字段逐个单开（其余显式 false）：buildSpawnEnv 对应键 === '1' 且其余五键不存在
//        （逐字段断言，不得只测一个代表）——验证显式 false 压住默认 true 的收敛语义。
//   3.   六字段全部 true 驱动一次 query：__setSdkQueryFactoryForTest 捕获
//        params.options.settings.env（SDK 侧最高优先级通道，覆盖生产 query 与命令 probe）
//        六键全部 === '1'（送达 SDK Options 主证据）。
//   4.   六字段全部显式 false 驱动一次 query：捕获 settings.env 不含六键（关=完全不注入）。
//   5.   文本断言：UI 链（PERSISTED_FIELDS 六字段保留 + 模板六个 v-model 开关已隐藏 +
//        .field-group-note 已移除 + renderer defaultConfig 镜像六 true）与主进程 config 链
//        （types 六声明 + manager defaultConfig 六 true + 收敛处六 ?? true）字段齐全。
//   6.   反向断言（防回潮）：src/ 全仓库不得出现对六个键赋 '0' 的代码；
//        types/config.ts 中 disableNonessentialTraffic 前不得再是旧注释
//        "引擎后台辅助请求总开关"（旧单开关注释残留检查）。
//
// 手法先例 = tdd-permission-default-verify.ts：Module._load hook + electron-stub.cjs +
// CLAUDE_LINK_TEST_USERDATA 临时目录 + session-repo stub，驱动真实生产 options 组装。
//
// 运行：npx tsx scripts/tdd-engine-background-verify.ts

// ── 1. 在 require 任何主进程模块之前装 _load hook（electron + connection + session-repo）──
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');

// 六开关 × env 键（§1 语义表；DISABLE_TELEMETRY 无 CLAUDE_CODE_ 前缀）。
const SIX: Array<{ field: string; key: string }> = [
  { field: 'disableAutoMemory', key: 'CLAUDE_CODE_DISABLE_AUTO_MEMORY' },
  { field: 'disableBackgroundTasks', key: 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS' },
  { field: 'disableCron', key: 'CLAUDE_CODE_DISABLE_CRON' },
  { field: 'disableFeedbackSurvey', key: 'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY' },
  { field: 'disableTelemetry', key: 'DISABLE_TELEMETRY' },
  { field: 'disableNonessentialTraffic', key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC' },
];

// 封闭性：清掉宿主 shell 可能携带的同名键（buildSpawnEnv 会 spread process.env），
// 防止外部环境污染导致断言 1/4 假失败。
for (const { key } of SIX) delete process.env[key];

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-engbg-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = tmpUserData;

let fakeRowid = 0;
const fakeStmt = {
  run: () => ({ lastInsertRowid: ++fakeRowid, changes: 1 }),
  all: () => [],
  get: () => undefined,
  finalize() { /* no-op */ },
};
const fakeDb = {
  prepare: () => fakeStmt,
  transaction: (fn: () => unknown) => fn,
  pragma: () => undefined,
  exec: () => undefined,
  close() { /* no-op */ },
};
const fakeConnection = { getConnection: () => fakeDb, closeConnection: () => {} };

// session-repo stub：createSession 在 fakeDb 下会因 getSession().get() 返回 undefined 而抛，故 stub。
const sessions = new Map<string, Record<string, unknown>>();
const sessionRepoStub = {
  createSession: (name: string, model: string, workingDir: string | null) => {
    const id = uuidv4();
    const s = {
      id,
      name,
      model,
      workingDir: workingDir ?? null,
      cliSessionId: null as string | null,
      permissionMode: null as string | null,
    };
    sessions.set(id, s);
    return s;
  },
  getSession: (id: string) => sessions.get(id) ?? null,
  updateCliSessionId: (id: string, sid: string | null) => {
    const s = sessions.get(id);
    if (s) s.cliSessionId = sid;
    return s ?? null;
  },
  updateLastContext: () => null,
  updateLastContextWindow: () => null,
  updateLastContextUsed: () => null,
};

const origLoad = Module._load;
Module._load = function (req: string, parent: NodeJS.Module | undefined, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  if (/[\\/]connection$/.test(req)) return fakeConnection;
  if (/[\\/]session-repo$/.test(req)) return sessionRepoStub;
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

// ── 2. 安全 require 主进程模块 ──
const { spawnForChat, sendMessage, __setSdkQueryFactoryForTest } = require('../src/main/modules/sdk-backend');
const { saveConfig, getConfig, clearConfig } = require('../src/main/modules/config-manager');
const { buildSpawnEnv } = require('../src/main/modules/cli-shared');

// 沙盒基座坑（09-05 发现）：electron-store 10 的 .store getter 不合并 defaults，且 stub
// （getName='claude-link-test'）下 store 落盘在持久化沙盒 AppData/Roaming/claude-link-test-nodejs/
// Config/claude-link-config.json（跨运行残留）。断言 1 的「默认值」必须先 clearConfig() 把沙盒
// 重置为 defaultConfig 再读取，否则读到的是上一次运行留下的显式值。
clearConfig();

// cliPath 设为 node 自身（存在的可执行文件），绕过 runQuery 的「未检测到本地 Claude Code」前置拦截。
saveConfig({ cliPath: process.execPath });

function makeSpyWindow(sink: Record<string, unknown>[]) {
  return {
    webContents: {
      send: (_channel: string, payload: { sessionId: string; event: Record<string, unknown> }) => {
        if (payload && payload.event) sink.push(payload.event);
      },
    },
    isDestroyed: () => true,
    isFocused: () => true,
  };
}

function makeFakeQuery(events: Record<string, unknown>[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    async interrupt() { /* no-op */ },
    async getContextUsage() {
      return { maxTokens: 0, rawMaxTokens: 0, totalTokens: 0, percentage: 0 };
    },
    close() { /* no-op */ },
  };
}

// 驱动一回合，返回 SDK query 工厂捕获的 options.settings.env（buildClaudeLinkSettingsBlock 真实构造）。
async function runTurn(): Promise<{
  settingsEnv: Record<string, string> | undefined;
  factoryCalls: number;
  exitCode: number | null | undefined;
}> {
  const session = sessionRepoStub.createSession('engbg-test', 'sonnet', null);
  const ipc: Record<string, unknown>[] = [];
  const handle = spawnForChat(session.id, makeSpyWindow(ipc), { userCommandText: 'hello' });

  let exitCode: number | null | undefined;
  const done = new Promise<void>((resolve) => {
    handle.on('exit', (c: number | null) => {
      exitCode = c;
      resolve();
    });
  });

  let captured: Record<string, string> | undefined;
  let factoryCalls = 0;
  __setSdkQueryFactoryForTest(async (params: { options: Record<string, unknown> }) => {
    factoryCalls += 1;
    const settings = params.options.settings as Record<string, unknown> | undefined;
    captured = settings?.env as Record<string, string> | undefined;
    return makeFakeQuery([
      { type: 'system', subtype: 'init', session_id: 'cli-fake-sid' },
      { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
    ]) as never;
  });

  sendMessage(session.id, 'hello');
  await done;
  return { settingsEnv: captured, factoryCalls, exitCode };
}

(async () => {
  let pass = 0;
  let fail = 0;
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) {
      pass++;
      console.log(`  ✅ ${name}`);
    } else {
      fail++;
      console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    }
  };

  console.log('=== 引擎后台请求六开关 seam 自测（真实 buildSpawnEnv / buildClaudeLinkSettingsBlock + fake sdk.query）===');

  // 断言 1：默认 config（全开）→ 进程 env 通道注入全部六键 === '1'。
  {
    const cfg = getConfig();
    const envDefault = buildSpawnEnv();
    check('① 默认 config 六字段全 true', SIX.every(({ field }) => cfg[field] === true),
      JSON.stringify(SIX.map(({ field }) => [field, cfg[field]])));
    for (const { field, key } of SIX) {
      check(`① buildSpawnEnv() 注入 ${key} === '1'（${field} 默认 true）`, envDefault[key] === '1',
        `实际=${String(envDefault[key])}`);
    }
  }

  // 断言 2：六字段逐个单开（其余显式 false 压住默认 true）→ 进程 env 通道只注入对应键 '1'（逐字段断言）。
  for (const { field, key } of SIX) {
    for (const f of SIX) saveConfig({ [f.field]: false } as Record<string, boolean>);
    const saved = saveConfig({ [field]: true } as Record<string, boolean>);
    const envOn = buildSpawnEnv();
    check(`② saveConfig({${field}:true}) 读回 true`, saved[field] === true, `实际=${String(saved[field])}`);
    check(`② buildSpawnEnv() 注入 ${key} === '1'`, envOn[key] === '1', `实际=${String(envOn[key])}`);
    const others = SIX.filter((f) => f.key !== key);
    check(`② 其余五键不出现（${field} 单开，显式 false 生效）`, others.every(({ key: k }) => !(k in envOn)),
      others.filter(({ key: k }) => k in envOn).map((f) => f.key).join(','));
  }
  // 还原默认全开，避免污染后续断言。
  for (const f of SIX) saveConfig({ [f.field]: true } as Record<string, boolean>);

  // 断言 3：六字段全部 true → 生产 query 的 Options.settings.env 六键全部 === '1'（送达 SDK Options 主证据）。
  {
    for (const f of SIX) saveConfig({ [f.field]: true } as Record<string, boolean>);
    const r = await runTurn();
    check('③ query 走 SDK 路径（工厂被调用，exit 0）', r.factoryCalls === 1 && r.exitCode === 0, `factoryCalls=${r.factoryCalls} exitCode=${r.exitCode}`);
    for (const { field, key } of SIX) {
      check(`③ Options.settings.env 的 ${key} === '1'（送达引擎）`, r.settingsEnv?.[key] === '1',
        r.settingsEnv ? `实际=${JSON.stringify(r.settingsEnv[key])}` : 'settings.env 未捕获');
    }
  }

  // 断言 4：六字段全部显式 false → 生产 query 的 Options.settings.env 不含六键（关=完全不注入）。
  {
    for (const f of SIX) saveConfig({ [f.field]: false } as Record<string, boolean>);
    const r = await runTurn();
    check('④ query 走 SDK 路径（工厂被调用，exit 0）', r.factoryCalls === 1 && r.exitCode === 0, `factoryCalls=${r.factoryCalls} exitCode=${r.exitCode}`);
    check('④ Options.settings.env 存在', !!r.settingsEnv, 'settings.env 未捕获');
    for (const { key } of SIX) {
      check(`④ Options.settings.env 不含 ${key}（关=不注入）`, !!r.settingsEnv && !(key in r.settingsEnv));
    }
  }

  // 断言 5：UI 链 + 主进程 config 链文本断言。
  {
    const configPageSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'pages', 'ConfigPage.vue'), 'utf-8');
    const persistedBlock = configPageSrc.match(/const PERSISTED_FIELDS = \[[\s\S]*?\] as const;/)?.[0] ?? '';
    for (const { field } of SIX) {
      check(`⑤ ConfigPage.vue PERSISTED_FIELDS 含 '${field}'`, persistedBlock.includes(`'${field}'`), 'PERSISTED_FIELDS 数组中未找到');
      check(`⑤ ConfigPage.vue 模板已隐藏（无 v-model="store.config.${field}"）`, !configPageSrc.includes(`v-model="store.config.${field}"`), '模板中仍存在该开关');
    }
    check('⑤ ConfigPage.vue 模板已移除 .field-group-note 组说明', !/class="field-group-note"/.test(configPageSrc), '模板中仍存在');
    const configStoreSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'stores', 'config-store.ts'), 'utf-8');
    for (const { field } of SIX) {
      check(`⑤ config-store.ts defaultConfig 镜像含 ${field}: true`, configStoreSrc.includes(`${field}: true`), 'defaultConfig 中未找到');
    }

    const typesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'types', 'config.ts'), 'utf-8');
    for (const { field } of SIX) {
      check(`⑤ types/config.ts 含 ${field}: boolean 声明`, typesSrc.includes(`${field}: boolean;`), '接口中未找到');
    }
    const managerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'modules', 'config-manager.ts'), 'utf-8');
    for (const { field } of SIX) {
      check(`⑤ config-manager.ts defaultConfig 含 ${field}: true`, managerSrc.includes(`${field}: true,`), 'defaultConfig 中未找到');
      check(`⑤ config-manager.ts getConfig() 收敛处含 config.${field} ?? true`, managerSrc.includes(`config.${field} ?? true`), '收敛处未找到');
    }
  }

  // 断言 6：反向断言（防回潮）。
  {
    // 6a. src/ 全仓库不得出现对六个键赋 '0' 的代码（引擎按 env 存在/非空直判 truthy，'0' 亦视为开）。
    let zeroHit = '';
    try {
      const grep = execSync(
        "grep -rn -E \"(CLAUDE_CODE_DISABLE_AUTO_MEMORY|CLAUDE_CODE_DISABLE_BACKGROUND_TASKS|CLAUDE_CODE_DISABLE_CRON|CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY|DISABLE_TELEMETRY|CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)[^\\n]*= '0'\" src/",
        { encoding: 'utf-8', cwd: path.join(__dirname, '..') },
      );
      zeroHit = grep.trim();
    } catch { /* grep 无命中 exit 1 = 通过 */ }
    check("⑥ src/ 全仓库无六键赋 '0' 的注入代码", zeroHit === '', zeroHit.slice(0, 200));

    // 6b. 旧单开关注入实现无残留：types/config.ts 中 disableNonessentialTraffic 前一行
    //     不得再是旧注释"引擎后台辅助请求总开关"。
    const typesLines = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'types', 'config.ts'), 'utf-8').split('\n');
    const idx = typesLines.findIndex((l) => l.includes('disableNonessentialTraffic: boolean;'));
    const prevLine = idx > 0 ? typesLines[idx - 1] : '';
    check("⑥ types/config.ts 旧单开关注释已移除（前一行非'引擎后台辅助请求总开关'）",
      idx >= 0 && !prevLine.includes('引擎后台辅助请求总开关'), `前一行=${prevLine.trim().slice(0, 60)}`);
  }

  __setSdkQueryFactoryForTest(null);
  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
