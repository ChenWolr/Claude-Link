// 自测：思考强度生效可见性 + post-turn 探针防劫持（2026-09-04 effort-visibility-and-probe-hijack-fix）。
// 覆盖：effort-truth 纯函数（真实 JSONL 样本提取/munge）+ 探针参数契约（--setting-sources ''）
// + DB 加列 + repo 白名单 + UI 显示行。
// 运行：npx tsx scripts/tdd-effort-truth-verify.ts（不启动 Electron）。

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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require('node:os');
function readRel(p: string): string {
  const abs = nodePath.resolve(__dirname, '..', p);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8');
}

console.log('\n=== 1) effort-truth 纯函数：真实 JSONL 样本提取 ===');
// 真实样本：2026-09-04 排查留存的本机会话 JSONL（D:\software\code\claude-link 工作目录）。
// 样本 A：全局默认期全部 max → 用户改选 xhigh 后末尾 xhigh；样本 B：全程 max。
// 样本不存在（他机/清理）时跳过真实文件断言，内嵌行样本兜底。
{
  const mod = nodePath.resolve(__dirname, '..', 'src', 'shared', 'effort-truth.ts');
  const src = readRel('src/shared/effort-truth.ts');
  check('src/shared/effort-truth.ts 存在', src.length > 0);
  if (src) {
    // 静态编译后动态加载（tsx 支持直接 import TS）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { extractLastEffortFromJsonl, mungeProjectDirName } = require(mod);

    const projDir = nodePath.join(os.homedir(), '.claude', 'projects', 'D--software-code-claude-link');
    const sampleA = nodePath.join(projDir, 'df296c5b-5844-4f52-9472-599a7255c5a0.jsonl'); // max→xhigh
    const sampleB = nodePath.join(projDir, '7fa23b29-1783-4252-aa5f-88b65924dd4c.jsonl'); // max
    if (fs.existsSync(sampleA)) {
      check(
        '真实样本 A（max→xhigh 演进）提取末尾 effort = xhigh',
        extractLastEffortFromJsonl(fs.readFileSync(sampleA, 'utf8')) === 'xhigh',
      );
    }
    if (fs.existsSync(sampleB)) {
      check(
        '真实样本 B（全程 max）提取末尾 effort = max',
        extractLastEffortFromJsonl(fs.readFileSync(sampleB, 'utf8')) === 'max',
      );
    }

    // 内嵌行样本兜底：含半写入行（尾部截断）与多事件乱序
    const embedded = [
      '{"type":"user","message":{"role":"user"}}',
      '{"type":"assistant","effort":"max","message":{}}',
      '{"type":"assistant","effort":"xhi', // 半写入行
      '{"type":"assistant","effort":"xhigh","message":{}}',
      '',
    ].join('\n');
    check('内嵌样本（含半写入行）提取 = xhigh', extractLastEffortFromJsonl(embedded) === 'xhigh');
    check('无 effort 事件返回 null', extractLastEffortFromJsonl('{"type":"user"}\n') === null);
    check('空文本返回 null', extractLastEffortFromJsonl('') === null);
    check('effort 空字符串视为无值', extractLastEffortFromJsonl('{"type":"assistant","effort":""}') === null);
    check('非 assistant 事件的 effort 不采纳', extractLastEffortFromJsonl('{"type":"system","effort":"low"}') === null);
    check('从后向前取最后一条（非第一条）', extractLastEffortFromJsonl('{"type":"assistant","effort":"low"}\n{"type":"assistant","effort":"max"}') === 'max');

    check('mungeProjectDirName(claude-link) = D--software-code-claude-link', mungeProjectDirName('D:\\software\\code\\claude-link') === 'D--software-code-claude-link');
    check('mungeProjectDirName 非字母数字一律替换（冒号/斜杠）', mungeProjectDirName('C:/aB9') === 'C--aB9');
  }
}

console.log('\n=== 2) post-turn 探针参数契约：--setting-sources \'\' 首两位 ===');
{
  const src = readRel('src/shared/post-turn-probe.ts');
  check('src/shared/post-turn-probe.ts 存在且导出 buildPostTurnProbeArgs', src.includes('export function buildPostTurnProbeArgs'));
  if (src) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildPostTurnProbeArgs } = require(nodePath.resolve(__dirname, '..', 'src', 'shared', 'post-turn-probe.ts'));
    const args = buildPostTurnProbeArgs('sid-123');
    check('首两位 = ["--setting-sources", ""]', args[0] === '--setting-sources' && args[1] === '');
    check(
      '其余六项与原 args 顺序一致',
      JSON.stringify(args.slice(2)) === JSON.stringify(['-p', '/context', '--resume', 'sid-123', '--output-format', 'stream-json', '--verbose', '--no-session-persistence']),
    );
  }
  const sb = readRel('src/main/modules/sdk-backend.ts');
  check('sdk-backend 已 import buildPostTurnProbeArgs', sb.includes('buildPostTurnProbeArgs'));
  // 探针内联 args 数组不再存在：runPostTurnContextProbe 内不再出现旧的 '-p', '/context' 内联构造。
  const probeFn = sb.slice(sb.indexOf('async function runPostTurnContextProbe'), sb.indexOf('async function runPostTurnContextProbe') + 4000);
  check('runPostTurnContextProbe 改调 buildPostTurnProbeArgs', probeFn.includes('buildPostTurnProbeArgs(cliSessionId)'));
  check('探针内不再有内联 args 数组', !probeFn.includes("'-p', '/context'"));
}

console.log('\n=== 3) DB：sessions 表幂等自愈加列 last_effective_effort ===');
{
  const mg = readRel('src/main/database/migrations.ts');
  check("migrations 幂等自愈块含 last_effective_effort 补列", mg.includes("hasCol('last_effective_effort')") && mg.includes('ADD COLUMN last_effective_effort'));
}

console.log('\n=== 4) repo：SessionRow/toSession/updateSession 白名单 ===');
{
  const repo = readRel('src/main/database/repositories/session-repo.ts');
  check('SessionRow 含 last_effective_effort', repo.includes('last_effective_effort: string | null;'));
  check('toSession 映射 lastEffectiveEffort', repo.includes('lastEffectiveEffort: row.last_effective_effort ?? null'));
  const upd = repo.slice(repo.indexOf('export function updateSession'), repo.indexOf('export function searchSessions'));
  check('updateSession 白名单含 lastEffectiveEffort', upd.includes("'lastEffectiveEffort'"));
  check('updateSession 体含 last_effective_effort 写入', upd.includes('last_effective_effort = @lastEffectiveEffort'));
}

console.log('\n=== 5) 类型 + renderer + UI ===');
{
  const types = readRel('src/shared/types/session.ts');
  check('Session 含 lastEffectiveEffort: string | null', types.includes('lastEffectiveEffort: string | null;'));
  const store = readRel('src/renderer/stores/session-store.ts');
  check('session-store 含 refreshActiveSessionEffort action', store.includes('async refreshActiveSessionEffort()'));
  check('refreshActiveSessionEffort 有 transient 守卫', store.slice(store.indexOf('async refreshActiveSessionEffort'), store.indexOf('async refreshActiveSessionEffort') + 600).includes('transient'));
  const chat = readRel('src/renderer/composables/use-chat.ts');
  check("case 'result' 在 resetTurnCache 前调 refreshActiveSessionEffort", /void store\.refreshActiveSessionEffort\(\);\s*\n\s*resetTurnCache\(\)/.test(chat));
  const tl = readRel('src/renderer/components/chat/ThinkingLevelSelector.vue');
  check('菜单含「上回合实际生效」条件行', tl.includes('上回合实际生效') && tl.includes('v-if="lastEffortLabel"'));
  check('既有 foot「下一条消息起生效」文本保留', tl.includes('<div class="tl-foot">下一条消息起生效</div>'));
}

console.log(`\n===== tdd-effort-truth-verify: ${pass} pass / ${fail} fail =====`);
if (fail > 0) process.exit(1);
