// tdd-bugfix-f4-topic-rename-race-verify.ts
// F4（P3，横切复查 2026-09-08）契约钉：首条消息自动命名与手动重命名竞态——自动命名门槛
// 在发送瞬间判定（session-store startsWith('会话')），主进程 topic-analyzer 最长 10s HTTP
// 往返后无条件 updateSession 覆盖，渲染层 .then 同步覆盖 activeSession.name。用户在窗口内
// 用标题栏 ✎ 重命名（发完顺手改名是自然动作序列），5 字自动主题会覆盖用户起的名字（DB+视图）。
//
// 修复语义：
// ① 主进程收口（最稳）：topic-analyzer 两处出口（LLM 主题/首句兜底）写前重查
//    sessionRepo.getSession(sessionId).name 仍 startsWith('会话') 才写；
// ② 渲染层同门槛：analyzeTopic .then 与附件名命名 .then 在覆盖 activeSession.name 前
//    加同一 startsWith('会话') 检查。
//
// 契约：改名后迟到的 topic 不覆盖（DB 与视图两侧都收口）。
//
// [H3 判据加固同步 2026-09-08]：自动名判据已从 startsWith('会话') 前缀改为 shared 纯函数
// isAutoSessionName（trim 后全等 /^会话 \d+$/，防「会话备份」等自然命名绕过；另补附件-only
// 路径 DB 写前门槛，见 tdd-bugfix-h3-auto-session-name-criteria-verify.ts）。本脚本断言
// 随之最小同步，竞态守卫语义（迟到写让位手动名）不变。
//
// 运行：npx tsx scripts/tdd-bugfix-f4-topic-rename-race-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const analyzer = fs.readFileSync(path.join(repoRoot, 'src/main/modules/topic-analyzer.ts'), 'utf8');
const sessionStore = fs.readFileSync(path.join(repoRoot, 'src/renderer/stores/session-store.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: (() => void) | boolean): void {
  try {
    if (typeof cond === 'function') cond();
    else if (!cond) throw new Error('断言为假');
    pass += 1; console.log(`  ✅ ${name}`);
  }
  catch (e) { fail += 1; console.log(`  ✗ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

console.log('=== F4-① topic-analyzer 主进程写前重查 ===');
{
  // H3 判据加固同步：重查判据从字面前缀匹配改为 shared 纯函数 isAutoSessionName
  // （精确形态 /^会话 \d+$/，防「会话备份」等自然命名绕过）。
  check('竞态守卫函数存在（重查当前名）', /function isAutoNameSlot\(\s*sessionId[\s\S]{0,200}isAutoSessionName\(sessionRepo\.getSession\(sessionId\)\?\.name\)/.test(analyzer));
  const gateCount = (analyzer.match(/if \(\w*[Aa]uto[Nn]ame\w*\(sessionId\)\)/g) || []).length;
  check(`两处 updateSession 出口都有守卫（实际 ${gateCount} 处）`, gateCount >= 2);
  // 两处出口 = LLM 主题 + 首句兜底，都写 name
  const writeCount = (analyzer.match(/sessionRepo\.updateSession\(sessionId, \{ name:/g) || []).length;
  check('仍保留两处 name 写入出口（不误删兜底）', writeCount === 2);
  // 回归：模型解析链既有契约（selftest-settings-mapping 40 段前后）不受影响
  check('resolveSessionModel 解析链保留', analyzer.includes('resolveSessionModel'));
  check('老链路兜底 resolveConfiguredDefaultModel 保留', analyzer.includes('resolveConfiguredDefaultModel'));
}

console.log('=== F4-② 渲染层 .then 覆盖同门槛 ===');
{
  // H3 判据加固同步：三处门槛（发送触发 / LLM 视图覆盖 / 附件名视图覆盖）均改走
  // isAutoSessionName；竞态守卫语义（迟到写让位手动名）不变。
  // LLM 主题路径：analyzeTopic(...).then 内覆盖 activeSession.name 前查自动名形态
  check('analyzeTopic .then 覆盖前加会话名门槛',
    /analyzeTopic\(sessionId, textContent\)\.then\(\(topic\) => \{[\s\S]{0,500}isAutoSessionName\(this\.activeSession\.name\)[\s\S]{0,300}this\.activeSession\.name = topic;/.test(sessionStore));
  // 附件名路径：updateSession({name}).then 内同样加门槛
  check('附件名 .then 覆盖前加会话名门槛',
    /updateSession\(sessionId, \{ name: topic \}\)\.then\(\(updated\) => \{[\s\S]{0,400}isAutoSessionName\(this\.activeSession\.name\)[\s\S]{0,300}this\.activeSession\.name = updated\.name;/.test(sessionStore));
  // 回归：发送瞬间的既有门槛保留（触发条件不放宽）
  check('发送瞬间自动名门槛保留', /isAutoSessionName\(this\.activeSession\?\.name\)/.test(sessionStore));
  // 回归：regression-tests 钉的 analyzeTopic 调用形态不变
  check('analyzeTopic(sessionId, textContent) 调用形态不变', sessionStore.includes('analyzeTopic(sessionId, textContent)'));
}

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
