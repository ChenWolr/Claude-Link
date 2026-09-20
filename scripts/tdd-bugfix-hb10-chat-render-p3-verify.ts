// scripts/tdd-bugfix-hb10-chat-render-p3-verify.ts
// hb10 P3 CHR 批契约（CHR-03/04/05/06/07/08/09/10/11/V01/V04）。
//
// 逐条要点：
//  CHR-03      ProcessGroup 展开态跨实例存续（foldOpenState 模块级 Map，fold 首消息 id 为键）。
//  CHR-04/11   思考行 sealed 收窄（组内 running × 会话 sending，中断不再永久「思考中」）。
//  CHR-05/11   附件 JOIN 分块（500 id/批，SQLite 32766 变量上限安全余量）。
//  CHR-06      导出投影补 api_error_kind（错误气泡保留类型语义）。
//  CHR-07      ToolCallBlock meta 行补「结束于」（exportMode/展开态）。
//  CHR-08      DiffBody 空态文案含「纯重命名/无内容变化」。
//  CHR-09      ToolCallBlock/ThinkingBlock 折叠 body 懒渲染（v-if+已展开过标记）。
//  CHR-10      MessageList 滚底 rAF 批处理（每帧至多一次 + 卸载取消）。
//  CHR-V01     短错误正文豁免折叠（reasoning_replay 失败气泡可见）。
//  CHR-V04     cost 脚注门控 durationMs || costUsd != null（cost 缺失时耗时仍显示）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-chat-render-p3-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import { computed as vueComputed, reactive as vueReactive } from 'vue';
import { isFoldable } from '../src/renderer/utils/group-messages';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const group = read('src/renderer/utils/group-messages.ts');
const pg = read('src/renderer/components/chat/ProcessGroup.vue');
const tcb = read('src/renderer/components/chat/ToolCallBlock.vue');
const tb = read('src/renderer/components/chat/ThinkingBlock.vue');
const ml = read('src/renderer/components/chat/MessageList.vue');
const db = read('src/renderer/components/changes/DiffBody.vue');
const attRepo = read('src/main/database/repositories/attachment-repo.ts');
const msgRepo = read('src/main/database/repositories/message-repo.ts');
const useStreamSrc = read('src/renderer/composables/use-stream.ts'); // 二轮补救：CHR-01 节流钉

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① CHR-03（hb13-v A3 改钉）+ R4 既有钉保持。
// 旧断言钉住 `const foldOpenState = new Map(...)`——该声明实际位于 <script setup> 体内：
// 每实例各建一份非响应式普通 Map，toggle 的 Map.set 不触发 computed 重算 → 折叠/展开点击
// 完全无效，跨实例存续目标也未达成。新断言：reactive Map 声明于模块级（<script setup> 块之外）。
check('① ProcessGroup：foldOpenState 模块级 reactive Map + manualClosed 形态保留（R4 语义不弱化）', () => {
  const declMatch = pg.match(/^const foldOpenState = reactive\(new Map<string, boolean>\(\)\);/m);
  assert.ok(declMatch, '缺模块级 reactive 展开态 Map（hb13-v A3 修复形态）');
  const declIdx = pg.indexOf(declMatch[0]);
  const setupIdx = pg.search(/^<script[^>]*setup/m);
  assert.ok(setupIdx > -1, '未找到 setup script 块');
  assert.ok(declIdx < setupIdx, 'foldOpenState 声明仍在 setup script 块内（每实例新建，非模块级）');
  assert.match(pg, /foldKey/, '缺 fold 首消息 id 键');
  assert.match(pg, /manualClosed/, 'R4 manualClosed 形态丢失（既有契约钉）');
  assert.match(pg, /manualOpen\.value \?\? \(props\.active \|\| !foldable\.value\)/, 'open 优先级形态被改');
});

// ①b CHR-03 行为级（hb13-v A3）：抽取真实模块级声明+声明链（foldable→foldKey→manualOpen→
// manualClosed→open→toggle），以项目内 vue 的 computed/reactive 实跑——toggle 后 open 立即翻转。
check('①b ProcessGroup 行为级：toggle 后 open 立即翻转（reactive Map 触发 computed 重算）', () => {
  const declLine = pg.match(/^const foldOpenState = reactive\(new Map<string, boolean>\(\)\);$/m);
  assert.ok(declLine, '未找到模块级 foldOpenState 声明');
  const chainIdx = pg.indexOf('const foldable = computed(');
  assert.ok(chainIdx > -1, '未找到折叠声明链起点');
  const toggleIdx = pg.indexOf('function toggle(', chainIdx);
  assert.ok(toggleIdx > -1, '未找到 toggle');
  const toggleEnd = pg.indexOf('\n}', toggleIdx);
  const chainSrc = `${declLine[0]}\n${pg.slice(chainIdx, toggleEnd + 2)}`;
  const js = ts.transpileModule(chainSrc, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const wrapper = `(function(__deps){ const {computed, reactive, isFoldable, props} = __deps; ${js}; return { open, toggle }; })`;
  const harness = vm.runInNewContext(wrapper, vm.createContext({}))({
    computed: vueComputed,
    reactive: vueReactive,
    isFoldable,
    props: { messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }], stats: {}, active: false, exportMode: false },
  });
  assert.equal(harness.open.value, false, '初始态应为折叠（manualOpen 空 ?? (active=false || !foldable=false)）');
  harness.toggle();
  assert.equal(harness.open.value, true, `toggle 后 open 未翻转（${harness.open.value}）——Map.set 未触发 computed 重算`);
  harness.toggle();
  assert.equal(harness.open.value, false, '二次 toggle 未收起');
});

// ② CHR-04/11。
check('② 思考行 sealed 收窄：thinkingSealed = !(stats.running && store.sending)', () => {
  assert.match(pg, /thinkingSealed = computed\(\(\) => !\(props\.stats\.running && store\.sending\)\)/, 'sealed 判据形态不符');
  assert.match(pg, /:sealed="thinkingSealed"/, 'ThinkingBlock 未接新判据');
  assert.doesNotMatch(pg, /:sealed="!stats\.running"/, '旧组级 running 判据残留（中断永久「思考中」）');
});

// ③ CHR-05/11。
check('③ 附件 JOIN 分块：500 id/批（两个批量加载器 + getMessagesByTask 经共享加载器受益）', () => {
  assert.match(attRepo, /ATTACHMENT_IN_BATCH = 500/, '缺 500 分批常量');
  const m = attRepo.slice(attRepo.indexOf('export function getAttachmentsByMessageIds'), attRepo.indexOf('export function getAttachmentsByTaskIds'));
  const t = attRepo.slice(attRepo.indexOf('export function getAttachmentsByTaskIds'));
  for (const [name, body] of [['messageIds', m], ['taskIds', t]] as const) {
    assert.match(body, /for \(let i = 0; i < \w+\.length; i \+= ATTACHMENT_IN_BATCH\)/, `${name} 加载器缺分批循环`);
    assert.match(body, /\.slice\(i, i \+ ATTACHMENT_IN_BATCH\)/, `${name} 加载器缺批切片`);
  }
});

// ④ CHR-06。
check('④ 导出投影：ExportMessageRow/SELECT/toRenderable 补 api_error_kind 投影', () => {
  const iface = msgRepo.slice(msgRepo.indexOf('interface ExportMessageRow'), msgRepo.indexOf('function toRenderable'));
  assert.match(iface, /api_error_kind: string \| null;/, 'ExportMessageRow 缺 api_error_kind');
  assert.match(msgRepo, /apiErrorKind: row\.api_error_kind \?\? null,\s*\n\s*createdAt: normalizeDbTime\(row\.created_at\),\s*\n\s*};\s*\}\s*\n\s*export function getRenderableMessagesBySession/, 'toRenderable 缺 apiErrorKind 投影');
  assert.match(msgRepo, /title, is_error, api_error_kind, created_at\s+FROM messages WHERE session_id/, 'SELECT 窄投影缺列');
});

// ⑤ CHR-07 + V04。
check('⑤ ToolCallBlock meta：cost 门控放宽 + 「结束于」补展示（exportMode/展开态）', () => {
  assert.match(tcb, /v-if="costMsg && \(costMsg\.durationMs \|\| costMsg\.costUsd != null\)"/, 'CHR-V04 门控形态不符');
  assert.match(tcb, /· 结束于/, 'CHR-07 缺「结束于」展示');
  assert.match(tcb, /\(exportMode \|\| expanded\) && costMsg\.endedAt/, 'endedAt 显示条件不符（仅 exportMode/展开态）');
});

// ⑥ CHR-08。
check('⑥ DiffBody 空态文案含「纯重命名/无内容变化」', () => {
  assert.match(db, /纯重命名\/无内容变化/, '空态文案未更新');
});

// ⑦ CHR-09。
check('⑦ 折叠 body 懒渲染：ToolCallBlock everExpanded / ThinkingBlock everOpened（v-if+v-show）', () => {
  assert.match(tcb, /const everExpanded = ref\(false\);/, 'ToolCallBlock 缺已展开过标记');
  assert.match(tcb, /v-if="everExpanded" v-show="expanded"/, 'ToolCallBlock body 未改懒渲染');
  assert.match(tb, /const everOpened = ref\(open\.value\);/, 'ThinkingBlock 缺已展开过标记');
  assert.match(tb, /v-if="everOpened" v-show="open"/, 'ThinkingBlock body 未改懒渲染');
});

// ⑧ CHR-10。
check('⑧ MessageList 滚底 rAF 批处理 + 卸载取消', () => {
  assert.match(ml, /scrollRafId/, '缺 rAF 句柄');
  assert.match(ml, /requestAnimationFrame\(/, '缺 rAF 排程');
  assert.match(ml, /cancelAnimationFrame\(scrollRafId\)/, '卸载缺取消');
  assert.match(ml, /if \(scrollRafId !== null\) return; \/\/ 本帧已排程/, '缺每帧一次合并判据');
});

// ⑨ CHR-V01。
check('⑨ 短错误正文豁免折叠（isError 且 ≤100 字符打断 fold）', () => {
  assert.match(group, /msg\.isError === true && isAssistantBodyText\(msg\) && msg\.content\.trim\(\).length <= PROCESS_NARRATION_TEXT_LIMIT/, '豁免分支缺失');
  const breakIdx = group.indexOf('const isBreak =');
  const errIdx = group.indexOf('msg.isError === true && isAssistantBodyText');
  assert.ok(errIdx > breakIdx && errIdx < group.indexOf('close();', breakIdx), '豁免分支未位于 isBreak 判据内');
});


// ⑩ hb12-CHR-01/CHR-03（2026-09-13 二轮补救）：流式 watch 节流；ToolCallBlock 原文回退。
check('⑩ CHR-01：use-stream 三 watch 改节流（首条立即+50ms 间隔+trailing；空串直通）', () => {
  assert.match(useStreamSrc, /function makeThrottle\(/, '缺节流 helper');
  assert.match(useStreamSrc, /首条立即/, '缺首条立即注释');
  assert.match(useStreamSrc, /INTERVAL - elapsed/, '缺按剩余间隔排程（trailing）');
  assert.match(useStreamSrc, /value === ''/, '缺空串直通');
  assert.match(useStreamSrc, /pushContent\(content\)/, 'content watch 未接节流');
  assert.match(useStreamSrc, /pushThinking\(content\)/, 'thinking watch 未接节流');
  assert.match(useStreamSrc, /pushTool\(content\)/, 'tool watch 未接节流');
  assert.doesNotMatch(useStreamSrc, /\}, 50\);/, '旧 50ms 防抖形态须移除');
});
check('⑫ CHR-03：ToolCallBlock parse 失败回退展示原文 pre', () => {
  const idx = tcb.indexOf('v-if="useParsed"');
  assert.ok(idx > -1, '缺 useParsed 分支');
  const body = tcb.slice(idx, idx + 300);
  assert.match(body, /v-else-if="use"/, '缺 parse 失败原文回退分支');
  assert.match(body, /\{\{ use\.content \}\}/, '回退分支未展示原文');
});

// ⑬ hb13-v B10.3：折叠豁免清单补 system:error——失败原因独立成条不被折进过程组（错误可见性）。
// 注：system:aborted 不在豁免清单内（仍随过程折进 fold），原「与 system:aborted 家族同待遇」
// 说法与实现不符；本断言仅钉 system:error 行为。
check('⑬ B10.3：group-messages 折叠豁免清单补 system:error', () => {
  const idx = group.indexOf('system:init_write_skipped');
  assert.ok(idx > -1, '未找到豁免清单锚');
  const seg = group.slice(idx, idx + 600);
  assert.match(seg, /system:error/, '豁免清单缺 system:error（失败原因被折进过程组）');
});
console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
