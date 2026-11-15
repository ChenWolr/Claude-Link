// tdd-config-h1-h7-verify.ts
// H 配置页集成（H1~H7）共用契约脚本 · H1 小节「MCP 批量测试手动钮 + armed/gen/作用域三重 toast 去重 + spinner」
//   ＋ H2 小节「MCP 服务器卡键盘可达（role/tabindex/aria-label 三件套 + target===currentTarget 守卫 + focus-visible 焦点环）」
// （slate-ui-completion-1108-1428 round-001 点 H1；用例正本 = docs/ui-completion/tests/H-config-integrations-cases.md
//   H1 节 H1-01~H1-08；行为规范 = docs/ui-completion/10-behavior-specs.md §H1；实现细节 =
//   docs/ui-completion/impl/H-config-integrations-impl.md §1；裁决：空作用域=钮禁用（附 E-1 形态 B）、
//   M 口径=本批完成数/总数（附 E-5）、计数锚用模块常量（附 E-6））。
// 全部为纯 node 读文件 + 字面/正则断言，不 import Electron、不跑 DB。
//
// 覆盖（H1）：
//   H1-01 「批量测试」钮在右栏头部按钮组（.mcp-title-row__acts）且位于「导出 JSON」之前；
//         activity 语义内联 SVG（stroke 体系同排三钮）；title 逐字「对当前作用域全部已启用服务器依次探活」。
//   H1-02 进行中钮 disabled 绑定既有在飞态 probingAll（负断言：不引入与 probingAll 脱钩的独立布尔）。
//   H1-03 点击=复用既有批量链路：manualProbeAll 调 probeAllInView（负断言：不复制独立批量实现旁路
//         Q 组分流——handler 零 probeMcpServers/target:'all'/'scoped' 直调）。
//   H1-04 手动路径完成 toast「批量探活完成 · N/M 台已连接」逐字骨架：前缀字面 + N/M 动态插值 +
//         后缀「台已连接」；N=探活报告 status==='ok' 台数、M=已启用台数（isEnabled 过滤）；
//         载体=既有 pushToast 组件内栈；pushToast 在 armed 守卫的 watch 边沿消费分支内。
//   H1-05 自动触发（进 tab/切作用域/保存后）完成不弹 toast：文案字面全文件恰 1 次（E-6 裁决：
//         计数锚=模块常量定义点，消费点经常量引用）；probeAllInView/switchScope/refresh/
//         persistManaged 四切片零出现该字面与常量引用。
//   H1-06 statpill「批量测试中…」补 spinner（row__spin 类在 statpill 切片内）+ reduced-motion 停转
//         （@media (prefers-reduced-motion: reduce) 块内 .row__spin { animation: none; }）；
//         statpill 既有 role="status" 与容器 aria-label="统计" 形态保持。
//   H1-07 空作用域/全部已禁用点击合理不报错（裁决形态 B）：空作用域钮 :disabled（含
//         scopeCards.length === 0）；全部已禁用可点击→「0/0 台已连接」；handler 防重入早退守卫；
//         文案无 NaN/undefined/Infinity 插值风险（N/M 取自数组 length 数值插值）。
//   H1-08 批量中切作用域既有语义不变（防倒退钉，转写即绿属预期）：四处竞态骨架——①probingBatchPrefix
//         在飞前缀圈定；②批量派发时刻锚点 dispatchAt（P2-2①）；③probedAt 仲裁回填（P2-2③）；
//         ④代际守卫 probeGen/disposed——形态切片保持；手动批量与自动批量共用同一在飞态
//         （负断言：不新增并行在飞 ref；manualProbeAll 只读消费，不写 probingAll/probingBatchPrefix/probeGen）。
//   附 B-5：selftest-mcp-settings Q 组分流保全镜像钉——probeAllInView 仍含 managed→all /
//         user·project→scoped 双分流字面（正本保全由 selftest:static 全量跑 Q2/Q4b 承担）。
// 覆盖（H2）（slate-ui-completion-1108-1428 round-001 点 H2；用例正本 = 同卷 H2 节 H2-01~H2-06；
//   行为规范 = docs/ui-completion/10-behavior-specs.md §H2；实现细节 =
//   docs/ui-completion/impl/H-config-integrations-impl.md §2）：
//   H2-01 整卡 button 语义三件套：role="button"+tabindex="0"+aria-label 动态名插值
//         「编辑 ${card.name}」（负断言：aria-label 不得写死漏名称插值）。
//   H2-02 Enter/Space 两键全覆盖接 onCardKeydown（负断言：不裸直调 openEdit、不单键遗漏）。
//   H2-03 target===currentTarget 守卫在位且先行（卡内 switch/图标钮/⚠ 钮焦点上的按键
//         原样放行，不冒泡误开编辑器）；负断言：零 .prevent/.stop 键盘修饰符（子控件冒泡
//         按键会被先 preventDefault 吞掉原生激活）；卡根交互约束注释补守卫说明行。
//   H2-04 .grp__row:focus-visible 焦点环（outline 2px + --color-* 变量，禁硬编码；
//         负断言：不得退化为 :focus——鼠标点击也出环）。
//   H2-05 禁用卡/测试中卡打开语义不变（保全钉，转写即绿属预期）：整卡零新增
//         isEnabled/isProbing 门控；卡内「测试连接」钮既有禁用门控与三态 title 保持原样。
//   H2-06 Tab 序合理：全文件零正值 tabindex 字面（负断言）；模板 tabindex 集合恰
//         {卡根 0, 编辑器 -1}——卡内控件零额外 tabindex，靠 DOM 原生序。
// 覆盖（H3）（slate-ui-completion-1108-1428 round-001 点 H3；用例正本 = 同卷 H3 节 H3-01~H3-04；
//   行为规范 = docs/ui-completion/10-behavior-specs.md §H3；实现细节 =
//   docs/ui-completion/impl/H-config-integrations-impl.md §3；收敛形态裁决 = 附 E-2 形态 B
//   （watch skillScope 收敛）＋点指令裁决「目录消失自动回退（R-3 幽灵作用域回退）不重置」）：
//   H3-01 MCP switchScope（activeScope 唯一写路径）函数体含 search 清空与 filter 复位两条赋值，
//         且受 changed 守卫包裹（kind 维 + 项目路径归一等价维——同作用域重复点击不清空）；
//         既有语义保全：editorView 回列表与进入即批量探活不被 changed 包裹（同拍语义不变）。
//   H3-02 Skill 侧 watch(skillScope) 收敛块在位（形态 B：源订阅自动覆盖全部赋值点，rail 两处
//         @click 内联赋值保持），块内含 skillSearch 清空与 skillFilter 复位两条赋值；
//         same-scope 守卫在位；幽灵回退签名守卫在位（回退不重置——非用户主动切换）。
//   H3-03 负向钉：重置只挂作用域切换路径——开关拨动（handleSkillToggle/handleToggle）、
//         卡片点击（openEdit）、进 tab（watch activeTab）、保存后（saveForm/saveScopedForm/
//         persistManaged）六切片零出现四类重置赋值字面；两侧同作用域守卫齐备（复合钉）。
//   H3-04 重置后列表即时刷新（静态面）：visibleCards/visibleSkills 过滤 computed 消费
//         search/filter 与 skillSearch/skillFilter（过滤链不旁路）；重置写响应式 ref 本体
//         （.value 赋值形态 + 目标名与 ref 声明一致）；切作用域路径零列表手动赋值。
// 覆盖（H4）（slate-ui-completion-1108-1428 round-001 点 H4；用例正本 = 同卷 H4 节 H4-01~H4-05；
//   行为规范 = docs/ui-completion/10-behavior-specs.md §H4；实现细节 =
//   docs/ui-completion/impl/H-config-integrations-impl.md §4；裁决 = 计划 §2 H 组
//   「H4 移植 tip 样式必须剔除 #fcfaf5/#e8c8c8 硬编码」）：
//   H4-01 同步条两态长文案收进可聚焦 ⓘ（真 button + aria-label）+ role="tooltip" 气泡；
//         两态文案逐字保留且分化条件不变（载体 hint span → 气泡；外层 span 保留
//         skill-sync-bar__hint 类名——tdd-skill-refresh ⑥ 样式类钉与两文案 includes 钉保全）。
//   H4-02 气泡显隐双触发（:hover 与 :focus-within 配对，沿 McpSettings .tip 先例）；
//         负断言：不得仅 :hover（hover-only 独立规则块即红）。
//   H4-03 开关成功 toast 逐字骨架：公共字面「同名 Skill 跨作用域联动，新会话生效」+「已启用」
//         「已禁用」两分支随 enabled 三元分化 + 名称动态插值『${skill.name}』；载体 = 页内
//         showToast 体系（非全局 error toast 旁路）；字面全文件恰 1 次（不旁路挂第二处）。
//   H4-04 开关禁用门控保全（X-2/W-2 原形态镜像钉）：:disabled/:title 表达式逐字、@change
//         接线不动、写链 setSkillEnabled 保持；toast 挂唯一 change handler 内（原生 disabled
//         checkbox 不发 change——门控天然防误弹，toast 无绕过路径）。
//   H4-05 toast 自动消失 ≤4s：showToast 既有 setTimeout 定时清除形态保持（现值 3000ms ≤
//         4000ms）；负断言：常驻/仅手动清除形态即红。
//   H4-06（点指令完成判定）移植样式四块齐备（.tip/.tip .bubble/显隐/.skill-info-btn 族）且
//         零硬编码 hex（token 化：--color-text 底 / panel·text mix 字色 / elevation-3 /
//         radius token）；#fcfaf5/#e8c8c8 全文件零出现（McpSettings b/code 规则不移植）；
//         .skill-sync-bar__hint 原字号/色值规则保留 + 追加 inline-flex 承载。
// 覆盖（H5）（slate-ui-completion-1108-1428 round-001 点 H5；用例正本 = 同卷 H5 节 H5-01~H5-04；
//   行为规范 = docs/ui-completion/10-behavior-specs.md §H5；实现细节 =
//   docs/ui-completion/impl/H-config-integrations-impl.md §5；裁决 = 统一确认体系
//   interactionStore.requestConfirm（非 window.confirm / 非两段式 armed 自制层——armed 仅为
//   飞书清除授权用户局部先例），Esc=取消由 InteractionPrompt 既有语义承担、零新增 Esc 层；
//   附A A-4 预期免同步：confirmText 与按钮文案同串「退出登录」，A⑩ includes 命中面更宽）：
//   H5-01 退出登录前置 danger 确认：useInteractionStore 导入/实例 + wechatLogout 函数体
//         await interactionStore.requestConfirm(...) + 四段文案逐字（title「退出微信登录」/
//         message「退出后微信私聊不再同步；重新扫码登录即可恢复。」/confirmText「退出登录」/
//         cancelText「取消」）+ danger: true。
//   H5-02 取消无副作用：if (!ok) return 早退在位；序钉 confirm < 早退 < qrDataUrl 清空 <
//         save（既有副作用两点全部移到确认分支之后——现状清空在函数头部即回归）；副作用
//         两点形态保全未被重写/删除。
//   H5-03 确认后才执行既有退出逻辑（保全）：确认分支走既有 save({ wechat: { botToken: '' } })
//         清 token 链零旁路（无 bridgeSaveConfig/resolveSecretPatch 直调）；按钮本体
//         @click="wechatLogout" + im-act-btn + v-if 门控 + 文案「退出登录」保持（A⑩ 镜像钉）。
//   H5-04 统一确认体系负断言：全文件零 @keydown.esc / 零 Escape 自制接线（Esc=取消由统一
//         体系承担）；wechatLogout 函数体零 window.confirm / 零 armed 两段式自制确认层
//         （window.confirm/armed 全文件级断言不可用——L265 既有注释与飞书 armed 先例含字面）。
// 覆盖（H6）（slate-ui-completion-1108-1428 round-001 点 H6；用例正本 = 同卷 H6 节 H6-01~H6-04；
//   行为规范 = docs/ui-completion/10-behavior-specs.md §H6；实现细节 =
//   docs/ui-completion/impl/H-config-integrations-impl.md §6；裁决 = 点指令 2026-11-10
//   「未开启」整行替换执行（附 A-3 同步路径：wiring 12.3 includes 钉同点改钉为警示行文案））：
//   H6-01 off 态警示行：文案逐字「网页访问已关闭 · 局域网设备无法连接；已连接设备将被断开」+
//         独立 warn 类（负断言：不复用 --error 类）+ 样式 token 化（warn-strong 字 / warn 10%
//         color-mix 弱底 / warn 30% 描边 / radius-sm，零硬编码 hex）+ 样式序钉（--warn 在 --error 后）。
//   H6-02 警示行挂 off 分支门控（v-else）；负断言：无门控常驻（运行中仍显示「已关闭」自相矛盾）。
//   H6-03 分支链互斥序：webAccessInfoError 行最前（并列独立行，现状形态不变）→ running
//         (v-if=waRunning) → error (v-else-if=waStatusError) → off (v-else 警示行)；
//         error 臂切片零出现警示文案（启动失败不提示「已关闭」——结构性互斥零新增逻辑）。
//   H6-04 既有三态呈现保全（防倒退钉，转写即绿属预期）：running 逐条 urls+首条二维码+空列表
//         提示行、error「启动失败（端口 …）：…」形态、webAccessInfoError「状态获取失败」行
//         三处零变化；「未开启」字面全文件零残留（替换执行裁决的对偶钉）。
// 覆盖（H7）（slate-ui-completion-1108-1428 round-001 点 H7；用例正本 = 同卷 H7 节 H7-01~H7-05；
//   行为规范 = docs/ui-completion/10-behavior-specs.md §H7；实现细节 =
//   docs/ui-completion/impl/H-config-integrations-impl.md §7；形态裁决 = 附 E-4 形态 A：
//   编辑态分支收进 locationHint computed 函数体首行，{{ locationHint }} 模板绑定零改动 →
//   selftest-mcp-settings P3 切片结束边界（p3SegEnd，~L2389）免同步）：
//   H7-01 编辑态名称 hint「编辑态不可改名」（无校验错误时）；新建态格式 hint 逐字保持（负断言）。
//   H7-02 编辑态保存位置 hint「编辑态下保存位置不可更改」（computed 函数体首行分支）；
//         新建态 managed/user/project 作用域说明逐字原样；P3 切片保全断言（绑定恰 1 次
//         ＋ selftest 边界字面未漂移）。
//   H7-03 名称 hint 优先级链：nameErrorShown（最外层判定）> 编辑态 hint > 格式 hint；
//         保存位置 hint 无校验错误通道（负断言）。
//   H7-04 校验逻辑不变（保全钉，转写即绿属预期）：名称 :disabled="isEditMode" 禁用保持 /
//         touchedFields·nameErrorShown 校验链零变化 / project 分支与 projectDirs 回退零变化。
//   H7-05 两处 hint 沿既有 mcp-ffield__hint 类渲染；编辑态分支切片零 --danger。
//
// 运行：npx tsx scripts/tdd-config-h1-h7-verify.ts（已登记 scripts/selftest-static-list.txt 尾部
//   ＋ tsconfig.tdd.json include 类型闸门）。H2~H7 小节后续各点在同一文件追加。

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');
// 读取统一折叠 CRLF→LF：切片断言对行尾不敏感（g1 脚本同款）。
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');

const msFile = read('src/renderer/components/config/McpSettings.vue');
const staticList = read('scripts/selftest-static-list.txt');
const tsconfigTdd = read('tsconfig.tdd.json');

// 组件三切片：script（<script 开标签后 → </script>）/ template / style。
const scriptStart = msFile.indexOf('<script setup lang="ts">');
const scriptEnd = msFile.indexOf('</script>', scriptStart);
const script = scriptStart !== -1 && scriptEnd > scriptStart ? msFile.slice(scriptStart, scriptEnd) : msFile.slice(0, msFile.indexOf('<template>'));
const tplStart = msFile.indexOf('<template>');
const template = msFile.slice(tplStart, msFile.lastIndexOf('</template>'));
const style = msFile.slice(msFile.indexOf('<style'));

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i > -1) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

// 函数体切片：自 `function <name>(` 起深度计数花括号归零（g4 jsFnBody 同款；模板串 ${…} 花括号
// 成对平衡，无需字符串态机）。锚缺失返回空串落为单条 ❌，不让模块加载期崩溃吞掉其余小节结果。
function jsFnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return '';
  const open = src.indexOf('{', start);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

// 负向写路径钉用：剥掉块注释与整行注释后再断言（钉「代码写路径」意图，注释提及不算旁路；
// 仅处理整行 // 与 /* */，不剥行尾注释——本域被测函数行尾注释不含被钉字面）。
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// 以锚串起点的花括号平衡块切片（watch(...) 回调等非 function 形态用；锚缺失返回空串）。
function blockFrom(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  if (at === -1) return '';
  const open = src.indexOf('{', at);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return '';
}

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ❌ ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── 切片材料 ────────────────────────────────────────────────────────────────
// 右栏头部按钮组：自 .mcp-title-row__acts 开标签到其闭合 </span>（含闭合标签本身；组内 button
// 无嵌套 span，首个 </span> 即组闭合——若日后组内出现嵌套 span 该切片锚失效，落为显式 ❌）。
const actsOpen = template.indexOf('<span class="mcp-title-row__acts">');
const actsClose = actsOpen === -1 ? -1 : template.indexOf('</span>', actsOpen);
const actsSlice = actsOpen === -1 || actsClose === -1 ? '' : template.slice(actsOpen, actsClose + '</span>'.length);
// 批量测试钮开标签切片（disabled/title/@click 绑定均在开标签上）。
const batchBtnAt = actsSlice.indexOf('批量测试');
const batchBtnOpen = batchBtnAt === -1 ? '' : actsSlice.slice(Math.max(0, actsSlice.lastIndexOf('<button', batchBtnAt)), batchBtnAt + '批量测试'.length);
// 批量链路四函数体 + watch 消费块。
const probeAllBody = jsFnBody(script, 'probeAllInView');
const manualBody = jsFnBody(script, 'manualProbeAll');
const refreshBody = jsFnBody(script, 'refresh');
const switchScopeBody = jsFnBody(script, 'switchScope');
const persistBody = jsFnBody(script, 'persistManaged');
const toastTextBody = jsFnBody(script, 'probeBatchToastText');
const watchBlock = blockFrom(script, 'watch(probingAll');

// ── H2 切片材料 ─────────────────────────────────────────────────────────────
// 整卡开标签切片：以 v-for 属性为锚（impl §2.2(1) 开标签为多行形态，锚定属性而非 <div 起始），
// 向前 lastIndexOf('<div') 取标签起、向后第一个 '>' 取标签止（开标签全部属性在内；锚失效落显式 ❌）。
const cardAnchor = 'v-for="card in grp.cards"';
const cardAnchorAt = template.indexOf(cardAnchor);
const cardTagStart = cardAnchorAt === -1 ? -1 : template.lastIndexOf('<div', cardAnchorAt);
const cardOpenTag = cardAnchorAt === -1 || cardTagStart === -1 ? '' : template.slice(cardTagStart, template.indexOf('>', cardAnchorAt) + 1);
// 卡根上方注释窗口：开标签起前 800 字符（交互约束注释紧邻卡开标签，含 H2 要求补的守卫说明行）。
const cardCommentWin = cardTagStart === -1 ? '' : template.slice(Math.max(0, cardTagStart - 800), cardTagStart);
// onCardKeydown 函数体（H2-03 守卫本体；缺失落空串 → H2-02c/H2-03 显式 ❌）。
const cardKeydownBody = jsFnBody(script, 'onCardKeydown');
// 卡内「测试连接」钮开标签切片：disabled/title/@click.stop 都在开标签上。
const probeBtnAnchor = ':disabled="isProbing(card) || !isEnabled(card)"';
const probeBtnAt = template.indexOf(probeBtnAnchor);
const probeBtnSlice = probeBtnAt === -1 ? '' : template.slice(Math.max(0, template.lastIndexOf('<button', probeBtnAt)), template.indexOf('>', probeBtnAt) + 1);
// 模板去 HTML 注释切片（H2-06b tabindex 集合统计用——注释里的 tabindex="-1" 字样不计）。
const templateNoComments = template.replace(/<!--[\s\S]*?-->/g, '');

// ── H3 切片材料 ─────────────────────────────────────────────────────────────
// ConfigPage.vue 两切片：script / template（Skill 侧被测对象在本文件，与 McpSettings 分离）。
const cpFile = read('src/renderer/pages/ConfigPage.vue');
const cpScriptStart = cpFile.indexOf('<script setup lang="ts">');
const cpScriptEnd = cpFile.indexOf('</script>', cpScriptStart);
const cpScript = cpScriptStart !== -1 && cpScriptEnd > cpScriptStart ? cpFile.slice(cpScriptStart, cpScriptEnd) : cpFile.slice(0, cpFile.indexOf('<template>'));
const cpTplStart = cpFile.indexOf('<template>');
const cpTemplate = cpFile.slice(cpTplStart, cpFile.lastIndexOf('</template>'));
// Skill 侧：skillScope 收敛 watch 块（附 E-2 形态 B 本体）＋幽灵回退块（R-3 watch projectDirs）
// ＋过滤 computed ＋开关/进 tab 负向切片。锚缺失落空串 → 对应检查显式 ❌。
const watchSkillBlock = blockFrom(cpScript, 'watch(skillScope');
const ghostFallbackBlock = blockFrom(cpScript, 'watch(projectDirs');
const visibleSkillsBlock = blockFrom(cpScript, 'const visibleSkills');
const handleSkillToggleBody = jsFnBody(cpScript, 'handleSkillToggle');
const activeTabBlock = blockFrom(cpScript, 'watch(activeTab');
// MCP 侧负向切片：开关/卡片点击/保存路径函数体 ＋过滤 computed（H3-04 过滤链钉）。
const handleToggleBody = jsFnBody(script, 'handleToggle');
const openEditBody = jsFnBody(script, 'openEdit');
const saveScopedBody = jsFnBody(script, 'saveScopedForm');
const saveFormBody = jsFnBody(script, 'saveForm');
const visibleCardsBlock = blockFrom(script, 'const visibleCards');
// 重置赋值字面（四类；写响应式 ref 本体形态）。skillSearch/skillFilter 不含小写 search/filter
// 子串（大小写敏感 indexOf），四类字面互无误伤、可独立断言。
const RST_MCP_SEARCH = "search.value = ''";
const RST_MCP_FILTER = "filter.value = 'all'";
const RST_SK_SEARCH = "skillSearch.value = ''";
const RST_SK_FILTER = "skillFilter.value = 'all'";
const RESET_LITERALS_ALL = [RST_MCP_SEARCH, RST_MCP_FILTER, RST_SK_SEARCH, RST_SK_FILTER];

console.log('\n=== H 配置页集成契约（H1 小节：MCP 批量测试手动钮 + 三重 toast 去重 + spinner）===\n');

console.log('── H1-01 「批量测试」钮在头部按钮组且位于导出 JSON 之前 ──');
check('H1-01a 头部按钮组切片锚有效（.mcp-title-row__acts 在场）', () => {
  assert.ok(actsOpen !== -1, '切片锚失效：.mcp-title-row__acts 未找到');
  assert.ok(actsSlice.includes('</span>'), '按钮组闭合 </span> 未找到（切片截断）');
});
check('H1-01b 批量测试钮在按钮组切片内，且位于「导出 JSON」之前（序钉）', () => {
  assert.ok(batchBtnAt !== -1, '按钮组切片内未出现「批量测试」钮');
  const exportAt = actsSlice.indexOf('导出 JSON');
  assert.ok(exportAt !== -1, '切片内未找到「导出 JSON」锚（基准漂移）');
  assert.ok(batchBtnAt < exportAt, `批量测试(${batchBtnAt}) 不在导出 JSON(${exportAt}) 之前（spec 点名「导出 JSON 之前」）`);
});
check('H1-01c 钮为 class="mcp-btn" + type="button" + @click="manualProbeAll"', () => {
  assert.ok(batchBtnOpen.includes('class="mcp-btn"'), '批量测试钮缺 class="mcp-btn"（与同排三钮同形）');
  assert.ok(batchBtnOpen.includes('type="button"'), '批量测试钮缺 type="button"');
  assert.ok(batchBtnOpen.includes('@click="manualProbeAll"'), '批量测试钮未接 manualProbeAll');
});
check('H1-01d title 逐字「对当前作用域全部已启用服务器依次探活」', () => {
  assert.ok(batchBtnOpen.includes('title="对当前作用域全部已启用服务器依次探活"'), 'title 文案漂移或缺失');
});
check('H1-01e activity 语义内联 SVG（心电线 polyline，stroke 体系与同排三钮一致）', () => {
  assert.ok(batchBtnOpen.includes('<svg'), '批量测试钮缺内联 SVG 图标');
  assert.ok(batchBtnOpen.includes('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'), '图标非 activity 心电线 polyline（lucide activity 形态）');
  assert.ok(batchBtnOpen.includes('stroke="currentColor"') && batchBtnOpen.includes('fill="none"') && batchBtnOpen.includes('aria-hidden="true"'), '图标 stroke 体系漂移（同排 1790/1794/1798 同款形态）');
});

console.log('── H1-02 进行中钮 disabled 绑定既有在飞态（负断言：无脱钩独立布尔）──');
check('H1-02a :disabled 绑定 probingAll（在飞真相源唯一）', () => {
  assert.ok(batchBtnOpen.includes(':disabled="probingAll'), '批量测试钮 :disabled 未绑定 probingAll');
});
check('H1-02b 负断言：disabled 表达式不含与 probingAll 脱钩的独立在飞布尔', () => {
  const m = batchBtnOpen.match(/:disabled="([^"]*)"/);
  assert.ok(m, ':disabled 绑定缺失');
  const expr = m[1];
  assert.ok(!/^(?!\s*probingAll)\s*\w+\s*\|\|/.test(expr) && !/manualProbe(?!Armed|Gen|Scope)/.test(expr), `disabled 表达式引入脱钩布尔：${expr}`);
  assert.ok(!/isBatchRunning|batchInFlight|manualProbing/.test(expr), 'disabled 表达式出现独立在飞标志（真相源分叉）');
});

console.log('── H1-03 点击=复用既有批量链路（不旁路）──');
check('H1-03a manualProbeAll 调用既有 probeAllInView（切片钉）', () => {
  assert.ok(manualBody !== '', 'manualProbeAll 函数缺失');
  assert.ok(/void\s+probeAllInView\(\)/.test(manualBody), 'manualProbeAll 未调用 probeAllInView（批量链路旁路）');
});
check('H1-03b 负断言：handler 零独立批量实现（无 probeMcpServers 直调/无 target 分流复制）', () => {
  const manualCode = stripComments(manualBody);
  assert.ok(!manualCode.includes('probeMcpServers'), 'manualProbeAll 内出现 probeMcpServers 直调（旁路既有批量链路）');
  assert.ok(!manualCode.includes("target: 'all'") && !manualCode.includes("target: 'scoped'"), 'manualProbeAll 内出现 target 分流字面（复制批量实现）');
  assert.ok(!manualCode.includes('probingBatchPrefix') && !manualCode.includes('probeReports'), 'manualProbeAll 内出现批量状态写路径（旁路竞态骨架）');
});

console.log('── H1-04 手动路径完成 toast「批量探活完成 · N/M 台已连接」逐字 ──');
check('H1-04a 前缀字面以模块常量定义（E-6 裁决计数锚）', () => {
  assert.ok(/const PROBE_BATCH_DONE_PREFIX = '批量探活完成 · ';/.test(script), '模块常量 PROBE_BATCH_DONE_PREFIX 定义缺失或字面漂移');
});
check('H1-04b 文案骨架：前缀常量 + N/M 动态插值 + 后缀「台已连接」', () => {
  assert.ok(toastTextBody !== '', 'probeBatchToastText 函数缺失');
  assert.ok(toastTextBody.includes('${PROBE_BATCH_DONE_PREFIX}'), 'toast 文案未引用前缀常量');
  assert.ok(toastTextBody.includes('${okCount}/${'), 'N 插值缺失（须 ${okCount}/${…} 形态）');
  assert.ok(toastTextBody.includes(' 台已连接'), '后缀「台已连接」漂移');
});
check('H1-04c N=报告 status ok 台数、M=已启用（isEnabled）台数（M 口径=本批完成数/总数，E-5）', () => {
  assert.ok(/filter\(\(c\) => isEnabled\(c\)\)/.test(toastTextBody), 'M 未按 isEnabled 过滤（口径漂移）');
  assert.ok(/status === 'ok'/.test(toastTextBody), 'N 未按探活报告 status===ok 统计');
  assert.ok(/\.length\b/.test(toastTextBody), 'N/M 未取自数组 length（NaN 插值风险）');
});
check('H1-04d toast 经既有 pushToast 组件内栈弹出，且在 armed 守卫的 watch 边沿消费分支内', () => {
  assert.ok(watchBlock !== '', 'watch(probingAll) 边沿消费块缺失');
  assert.ok(watchBlock.includes('pushToast(probeBatchToastText())'), 'watch 消费块未经 pushToast(probeBatchToastText()) 弹 toast');
  assert.ok(watchBlock.includes('manualProbeArmed'), 'watch 消费块缺 armed 守卫（自动路径会误弹）');
});

console.log('── H1-05 自动触发完成不弹 toast（计数 + 四切片负断言）──');
check('H1-05a 「批量探活完成」字面全文件恰 1 次（仅模块常量定义点，E-6 计数锚）', () => {
  assert.strictEqual(countOccurrences(msFile, '批量探活完成'), 1, `「批量探活完成」出现 ${countOccurrences(msFile, '批量探活完成')} 次 ≠ 1（泄漏到自动路径或绕过常量）`);
});
check('H1-05b probeAllInView/switchScope/refresh/persistManaged 四切片零出现该字面与常量引用', () => {
  for (const [n, body] of [['probeAllInView', probeAllBody], ['switchScope', switchScopeBody], ['refresh', refreshBody], ['persistManaged', persistBody]] as const) {
    assert.ok(body !== '', `${n} 函数体切片缺失`);
    assert.ok(!body.includes('批量探活完成'), `${n} 切片出现完成 toast 字面（自动路径误弹）`);
    assert.ok(!body.includes('PROBE_BATCH_DONE_PREFIX'), `${n} 切片引用完成 toast 常量（自动路径误弹）`);
  }
});
check('H1-05c 自动触发点零 armed 置位（armed 只在 manualProbeAll 置 true）', () => {
  assert.strictEqual(countOccurrences(script, 'manualProbeArmed = true'), 1, 'armed 置位点 ≠ 1（自动路径可能置位）');
  const armedAt = script.indexOf('manualProbeArmed = true');
  const manualAt = script.indexOf('function manualProbeAll(');
  assert.ok(armedAt > manualAt && armedAt < manualAt + manualBody.length, 'armed 置位点不在 manualProbeAll 内');
});

console.log('── H1-06 statpill 补 spinner + reduced-motion 停 ──');
check('H1-06a 「批量测试中…」statpill 内补 row__spin spinner（既有文案/role/容器形态保持）', () => {
  const pillsAt = template.indexOf('<div v-if="probingAll" class="mcp-statpills" aria-label="统计">');
  assert.ok(pillsAt !== -1, 'statpills 容器（v-if=probingAll + aria-label=统计）形态漂移');
  const pillsSlice = template.slice(pillsAt, template.indexOf('</div>', pillsAt));
  assert.ok(pillsSlice.includes('class="mcp-statpill" role="status"'), 'statpill 既有 role="status" 形态漂移');
  assert.ok(pillsSlice.includes('批量测试中…'), 'statpill 既有「批量测试中…」文案漂移');
  assert.ok(pillsSlice.includes('<span class="row__spin" aria-hidden="true"></span>'), 'statpill 内缺 row__spin spinner 元素');
  const spinAt = pillsSlice.indexOf('row__spin');
  const textAt = pillsSlice.indexOf('批量测试中…');
  assert.ok(spinAt !== -1 && textAt !== -1 && spinAt < textAt, 'spinner 未在 pill 文本之前（spec：pill 文本前插入）');
});
check('H1-06b reduced-motion 块内 .row__spin { animation: none; }（既有规则保持，转写即绿）', () => {
  const mediaRe = /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/g;
  let found = false;
  for (const m of style.matchAll(mediaRe)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < style.length; i += 1) {
      if (style[i] === '{') depth += 1;
      else if (style[i] === '}' && --depth === 0) {
        const body = style.slice(open + 1, i);
        if (/\.row__spin\s*\{\s*animation:\s*none;\s*\}/.test(body)) found = true;
        break;
      }
    }
  }
  assert.ok(found, 'reduced-motion 块内缺 .row__spin { animation: none; }（停转降级回归）');
});
check('H1-06c .row__spin 旋转动画声明在场（动画类在位；新增引用零样式新增）', () => {
  const at = style.indexOf('.row__spin {');
  assert.ok(at !== -1, '.row__spin 规则缺失');
  const blk = style.slice(at, style.indexOf('}', at));
  assert.ok(/animation:\s*mcp-spin-rot\s+0\.7s\s+linear\s+infinite;/.test(blk), 'row__spin 旋转动画声明漂移');
  assert.ok(style.includes('@keyframes mcp-spin-rot {'), '@keyframes mcp-spin-rot 缺失');
});

console.log('── H1-07 空作用域/全部已禁用点击合理不报错（裁决形态 B：空作用域禁用）──');
check('H1-07a 空作用域钮 :disabled（disabled 绑定含 scopeCards.length === 0）', () => {
  assert.ok(batchBtnOpen.includes('scopeCards.length === 0'), '空作用域未纳入 disabled（裁决 C-H1-1 形态 B：禁用不得报错）');
});
check('H1-07b manualProbeAll 防重入早退守卫（probingAll 兜底）', () => {
  assert.ok(manualBody.includes('if (probingAll.value) return;'), 'manualProbeAll 缺 probingAll 早退守卫（双击重入风险）');
});
check('H1-07c 文案无 NaN/undefined/Infinity 插值风险（N/M 取自 length 数值，全文件负断言）', () => {
  assert.ok(!toastTextBody.includes('NaN') && !toastTextBody.includes('undefined') && !toastTextBody.includes('Infinity'), 'toast 文案函数出现 NaN/undefined/Infinity 字面');
  assert.ok(!/[^\w/]\s*\/\s*[\w.]+\s*[^/]*===/.test(toastTextBody.replace('${okCount}/${', '')), 'toast 文案函数出现除法（除零风险）');
});
check('H1-07d 全部已禁用可点击（disabled 不含 isEnabled 门控——仅 probingAll 与空作用域两条件）', () => {
  const m = batchBtnOpen.match(/:disabled="([^"]*)"/);
  assert.ok(m, ':disabled 绑定缺失');
  assert.strictEqual(m[1], 'probingAll || scopeCards.length === 0', `disabled 表达式形态漂移：${m[1]}（期望 probingAll || scopeCards.length === 0；全部已禁用仍可点击）`);
});

console.log('── H1-08 批量中切作用域既有语义不变（竞态骨架保全；防倒退钉转写即绿属预期）──');
check('H1-08a ① probingBatchPrefix 在飞前缀圈定骨架在位', () => {
  assert.ok(script.includes("let probingBatchPrefix = 'managed:';"), 'probingBatchPrefix 声明漂移');
  assert.ok(countOccurrences(script, 'probingBatchPrefix = ') >= 2, 'probingBatchPrefix 写入点缺失（前缀圈定骨架残缺）');
  assert.ok(script.includes("rowStateClass") && probeAllBody.includes('probingBatchPrefix'), 'probeAllInView 前缀写入缺失');
});
check('H1-08b ② 批量派发时刻锚点 dispatchAt（P2-2①）在位', () => {
  assert.ok(probeAllBody.includes('const dispatchAt = Date.now();'), 'dispatchAt 锚点漂移（P2-2① 保全失败）');
  assert.ok(probeAllBody.includes('v.probedAt > dispatchAt'), 'dropOwnPrefix fresh 判定漂移');
});
check('H1-08c ③ probedAt 仲裁回填（P2-2③）在位', () => {
  assert.ok(probeAllBody.includes('prev.probedAt <= r.probedAt'), 'probedAt 仲裁回填漂移（P2-2③ 保全失败）');
});
check('H1-08d ④ 代际守卫 probeGen/disposed 形态保持（4 处迟到丢弃 + 2 处 finally 复位）', () => {
  assert.strictEqual(countOccurrences(probeAllBody, 'gen !== probeGen'), 4, `probeAllInView 代际守卫计数 ≠ 4`);
  assert.strictEqual(countOccurrences(probeAllBody, 'if (gen === probeGen) probingAll.value = false;'), 2, 'finally 在飞复位计数 ≠ 2');
  assert.ok(probeAllBody.includes('if (disposed || gen !== probeGen) return;'), 'disposed/probeGen 复合守卫形态漂移');
});
check('H1-08e 在飞态真相源唯一：手动批量共用 probingAll/probingBatchPrefix，零并行在飞 ref', () => {
  const probingRefs = [...script.matchAll(/const (probing\w+)\s*=\s*ref[<(]/g)].map((m) => m[1]);
  assert.deepStrictEqual(probingRefs.sort(), ['probingAll', 'probingSingle'], `在飞态 ref 集合漂移：${probingRefs.join(',') || '(无)'}（新增并行在飞标志）`);
  const manualCode = stripComments(manualBody);
  assert.ok(!manualCode.includes('probingAll.value ='), 'manualProbeAll 写 probingAll（真相源旁路）');
  assert.ok(!manualCode.includes('probingBatchPrefix ='), 'manualProbeAll 写 probingBatchPrefix（前缀圈定旁路）');
  // probeGen 只读快照合法（impl §1.2：新增代码只读既有状态）；写/自增才算代际守卫旁路。
  assert.ok(!/probeGen\s*=(?!=)/.test(manualCode) && !/\+\+\s*probeGen/.test(manualCode) && !/probeGen\s*\+\+/.test(manualCode), 'manualProbeAll 写 probeGen（代际守卫旁路）');
});

console.log('── 附 B-5 selftest-mcp-settings Q 组分流保全（镜像钉；正本保全由 selftest:static 承担）──');
check('B-5 probeAllInView 仍含 managed→all / user·project→scoped 双分流字面', () => {
  assert.ok(probeAllBody.includes("{ target: 'all' }"), "managed 分流 target:'all' 漂移（Q2 保全失败）");
  assert.ok(probeAllBody.includes("{ target: 'scoped', scope: 'project'"), "project 分流形态漂移（Q2 保全失败）");
  assert.ok(probeAllBody.includes("{ target: 'scoped', scope: 'user' }"), "user 分流形态漂移（Q2 保全失败）");
});

console.log('\n=== H 配置页集成契约（H2 小节：MCP 服务器卡键盘可达）===\n');

console.log('── H2-01 整卡 button 语义三件套（role+tabindex+aria-label）──');
check('H2-01a 整卡开标签切片锚有效（grp__row v-for 在场且切片含闭合 >）', () => {
  assert.ok(cardAnchorAt !== -1, '切片锚失效：grp__row v-for 卡开标签未找到');
  assert.ok(cardOpenTag.endsWith('>'), '开标签切片截断（首个 > 缺失）');
});
check('H2-01b 整卡 role="button" + tabindex="0"（键盘可达三件套之一二）', () => {
  assert.ok(cardOpenTag.includes('role="button"'), '整卡缺 role="button"（读屏不识可交互）');
  assert.ok(cardOpenTag.includes('tabindex="0"'), '整卡缺 tabindex="0"（键盘不可聚焦）');
});
check('H2-01c aria-label 动态名插值（与卡内编辑图标钮同文案形态；负断言不得写死）', () => {
  assert.ok(cardOpenTag.includes(':aria-label="`编辑 ${card.name}`"'), '整卡 aria-label 缺动态名插值绑定（期望 :aria-label="`编辑 ${card.name}`"）');
  assert.ok(!/aria-label="编辑/.test(cardOpenTag), '整卡 aria-label 写死字面（漏名称插值——读屏只报「编辑」不知哪台服务器）');
});

console.log('── H2-02 Enter/Space 打开编辑器（两键全覆盖，与点击等效）──');
check('H2-02a 卡 keydown 覆盖 Enter 与 Space 两键（不单键遗漏）', () => {
  assert.ok(cardOpenTag.includes('@keydown.enter'), '整卡缺 @keydown.enter 接线');
  assert.ok(cardOpenTag.includes('@keydown.space'), '整卡缺 @keydown.space 接线');
});
check('H2-02b 两键同接 onCardKeydown handler（负断言：不裸直调 openEdit）', () => {
  assert.ok(cardOpenTag.includes('@keydown.enter="onCardKeydown($event, card)"'), 'Enter 未接 onCardKeydown($event, card)');
  assert.ok(cardOpenTag.includes('@keydown.space="onCardKeydown($event, card)"'), 'Space 未接 onCardKeydown($event, card)');
  assert.ok(!/keydown[^=]*="openEdit/.test(cardOpenTag), 'keydown 裸直调 openEdit（绕守卫 handler）');
});
check('H2-02c handler 消费侧调 openEdit(card)（键盘与点击等效）', () => {
  assert.ok(cardKeydownBody !== '', 'onCardKeydown 函数缺失');
  assert.ok(cardKeydownBody.includes('openEdit(card)'), 'onCardKeydown 未调 openEdit(card)');
});

console.log('── H2-03 卡内控件键盘操作不误开编辑器（target===currentTarget 守卫）──');
check('H2-03a 守卫在位：e.target !== e.currentTarget 早退（卡内按键冒泡放行）', () => {
  assert.ok(cardKeydownBody.includes('if (e.target !== e.currentTarget) return;'), 'onCardKeydown 缺 target===currentTarget 守卫（卡内 switch/图标钮上按 Space/Enter 会误开编辑器——spec 点名的防冒泡回归）');
});
check('H2-03b 守卫先行：preventDefault 与 openEdit 均置于守卫 return 之后（冒泡按键不拦截不打开）', () => {
  const guardAt = cardKeydownBody.indexOf('e.target !== e.currentTarget');
  const pdAt = cardKeydownBody.indexOf('e.preventDefault()');
  const oeAt = cardKeydownBody.indexOf('openEdit(card)');
  assert.ok(guardAt !== -1 && pdAt > guardAt && oeAt > guardAt, `守卫先行失序：guard=${guardAt} preventDefault=${pdAt} openEdit=${oeAt}`);
});
check('H2-03c 负断言：守卫进 handler 而非 .prevent/.stop 修饰符（冒泡按键会被先 preventDefault）', () => {
  assert.ok(!/keydown[^=]*\.(prevent|stop)/.test(cardOpenTag), 'keydown 用 .prevent/.stop 修饰符（子控件冒泡按键会被先执行 preventDefault，吞掉 switch/按钮原生激活，与让位语义矛盾）');
});
check('H2-03d 卡根交互约束注释补 keydown 守卫说明行', () => {
  assert.ok(/keydown/.test(cardCommentWin) && /守卫/.test(cardCommentWin), '卡根注释缺 keydown 守卫说明（impl §2.2(1)：交互约束注释补一行）');
});

console.log('── H2-04 focus-visible 焦点环（accent，--color-* only）──');
check('H2-04a .grp__row:focus-visible 规则在位', () => {
  assert.ok(style.includes('.grp__row:focus-visible'), '样式缺 .grp__row:focus-visible 焦点环规则');
});
check('H2-04b 焦点环形态 outline 2px solid var(--color-*) + outline-offset（对齐 mcp-info-btn 先例；禁硬编码）', () => {
  const at = style.indexOf('.grp__row:focus-visible');
  if (at === -1) throw new Error('.grp__row:focus-visible 规则缺失');
  const blk = style.slice(at, style.indexOf('}', at));
  assert.ok(/outline:\s*2px solid var\(--color-[a-z-]+\)/.test(blk), '焦点环非 outline: 2px solid var(--color-*) 形态');
  assert.ok(/outline-offset:\s*2px/.test(blk), '缺 outline-offset: 2px（贴边观感）');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(blk), '焦点环出现硬编码色值（违反 --color-* only 红线）');
});
check('H2-04c 负断言：不得退化为 :focus（鼠标点击也出环）', () => {
  assert.ok(!/\.grp__row:focus(?!-visible)/.test(style), '存在 .grp__row:focus（非 -visible）规则——鼠标点击也会出环（键盘可见性语义错误）');
});

console.log('── H2-05 禁用卡/测试中卡打开语义不变（保全钉，转写即绿属预期）──');
check('H2-05a 整卡打开零新增门控（点击与键盘均无 isEnabled/isProbing 分流）', () => {
  assert.ok(cardOpenTag.includes('@click="openEdit(card)"'), '整卡 @click 形态漂移（期望无门控直调 openEdit）');
  assert.ok(!/isEnabled|isProbing/.test(cardOpenTag), '整卡根属性出现 isEnabled/isProbing 门控（改变既有打开语义）');
  assert.ok(!/isEnabled|isProbing/.test(stripComments(cardKeydownBody)), 'onCardKeydown 出现 isEnabled/isProbing 门控（键盘路径新增状态分流）');
});
check('H2-05b 卡内「测试连接」钮既有禁用门控与三态 title 保持原样', () => {
  assert.ok(probeBtnSlice !== '', '「测试连接」钮切片锚失效（:disabled 绑定未找到）');
  assert.ok(probeBtnSlice.includes(':disabled="isProbing(card) || !isEnabled(card)"'), '「测试连接」钮禁用门控漂移');
  assert.ok(probeBtnSlice.includes("'已禁用 · 启用后可测试连接'") && probeBtnSlice.includes("'探测中…'"), '「测试连接」钮 title 三态分支漂移');
});

console.log('── H2-06 Tab 序合理（负值/零 tabindex only；卡内控件靠 DOM 原生序）──');
check('H2-06a 全文件零正值 tabindex 字面（自然 Tab 流不被插序）', () => {
  const positives = [...msFile.matchAll(/tabindex="(\d+)"/g)].map((m) => m[1]).filter((n) => n !== '0');
  assert.strictEqual(positives.length, 0, `出现正值 tabindex 字面：tabindex="${positives.join('", tabindex="')}"（正值插序破坏自然 Tab 流）`);
});
check('H2-06b 模板 tabindex 集合恰为 {卡根 0, 编辑器 -1}（卡内控件零额外 tabindex）', () => {
  const tps = [...templateNoComments.matchAll(/tabindex="(-?\d+)"/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(tps, ['-1', '0'], `模板 tabindex 集合漂移：[${tps.join(',') || '(无)'}]（期望恰 2 处：卡根 0 + 编辑器 -1；卡内控件不得额外加）`);
});

console.log('\n=== H3 小节：Skill/MCP 切作用域重置搜索/筛选（same-scope 守卫）===\n');

console.log('── H3-01 MCP switchScope 重置（activeScope 唯一写路径收敛点）──');
check('H3-01a switchScope 函数体含 search 清空与 filter 复位两条赋值', () => {
  assert.ok(switchScopeBody !== '', 'switchScope 函数体切片锚失效');
  assert.ok(switchScopeBody.includes(RST_MCP_SEARCH), '缺 search 清空赋值（切栏残留上一栏搜索词）');
  assert.ok(switchScopeBody.includes(RST_MCP_FILTER), '缺 filter 复位赋值（切栏残留上一栏筛选 chips）');
});
check('H3-01b 重置受 changed 守卫包裹（kind 维 + 项目路径归一等价维；同作用域重复点击不清空）', () => {
  assert.ok(switchScopeBody.includes('const changed ='), '缺 changed 判定（rail 每次点击都赋新对象字面量，无守卫会把同作用域重复点击误判为切换清空）');
  const changedBlk = blockFrom(switchScopeBody, 'if (changed)');
  assert.ok(changedBlk !== '', '缺 if (changed) 包裹（重置成了无条件清空）');
  assert.ok(changedBlk.includes(RST_MCP_SEARCH) && changedBlk.includes(RST_MCP_FILTER), '两条重置赋值未都落在 if (changed) 块内');
  assert.ok(switchScopeBody.includes('prev.kind !== scope.kind'), 'changed 判定缺 kind 维');
  assert.ok(/normalizeDirKey\(prev\.path\) !== normalizeDirKey\(scope\.path\)/.test(switchScopeBody), '项目路径比较未走归一键（A-2/D-10 口径：同目录换幸存串会被误判为切换而清空）');
});
check('H3-01c 负断言：rail 全收敛 switchScope（模板零内联 activeScope 赋值、三 rail 项全走 handler）', () => {
  assert.ok(!/activeScope = \{/.test(template), '模板出现内联 activeScope = { 赋值（绕过收敛点，切栏残留搜索/筛选）');
  assert.strictEqual(countOccurrences(template, '@click="switchScope('), 3, '模板 rail @click="switchScope(" 计数漂移（期望恰 3：managed/user/project）');
});
check('H3-01d 既有语义保全：editorView 回列表与进入即批量探活不被 changed 包裹（同拍语义不变）', () => {
  const evAt = switchScopeBody.indexOf("editorView.value = 'list'");
  const chAt = switchScopeBody.indexOf('if (changed)');
  const paAt = switchScopeBody.indexOf('void probeAllInView()');
  assert.ok(evAt > -1 && chAt > -1 && paAt > -1, '既有语句缺失（editorView 回列表/进入即探活）');
  assert.ok(evAt < chAt && paAt > chAt, 'editorView 回列表应在 changed 守卫之前、探活触发应在其之后（同拍既有语义不变）');
  const changedBlk = blockFrom(switchScopeBody, 'if (changed)');
  assert.ok(!changedBlk.includes('editorView') && !changedBlk.includes('probeAllInView'), 'editorView/探活被 changed 包裹（同作用域重复点击将不回列表/不探活——既有语义漂移）');
});

console.log('── H3-02 Skill watch(skillScope) 收敛重置（附 E-2 形态 B）──');
check('H3-02a skillScope 收敛 watch 块在位（源订阅自动覆盖全部赋值点）', () => {
  assert.ok(watchSkillBlock !== '', 'ConfigPage script 缺 skillScope 收敛 watch 块（形态 B 本体）');
});
check('H3-02b 块内含 skillSearch 清空与 skillFilter 复位两条赋值（写 ref 本体）', () => {
  assert.ok(watchSkillBlock.includes(RST_SK_SEARCH), '缺 skillSearch 清空赋值（切作用域残留搜索词）');
  assert.ok(watchSkillBlock.includes(RST_SK_FILTER), '缺 skillFilter 复位赋值（切作用域残留筛选 chips）');
});
check('H3-02c same-scope 守卫在位（同 kind 早退 + 项目路径归一相等早退）', () => {
  assert.ok(watchSkillBlock.includes('next.kind === prev.kind'), '缺同 kind 守卫（点击当前作用域 rail 项会被误清空）');
  assert.ok(/normalizeDirKey\(next\.path\) === normalizeDirKey\(prev\.path\)/.test(watchSkillBlock), '项目路径同作用域判定未走归一键（A-2/D-10 口径：同目录换幸存串会被误判为切换而清空）');
});
check('H3-02d rail 两处触发点在位（内联赋值保持——watch 源订阅自动覆盖）', () => {
  assert.ok(cpTemplate.includes("@click=\"skillScope = { kind: 'global' }\""), '全局 rail 项 @click 内联赋值漂移');
  assert.ok(cpTemplate.includes("@click=\"skillScope = { kind: 'project', path: dir.path }\""), '项目 rail 项 @click 内联赋值漂移');
});
check('H3-02e 幽灵回退不重置（裁决：目录消失自动回退非用户主动切换，保留搜索上下文）', () => {
  assert.ok(watchSkillBlock.includes("prev.kind === 'project'") && watchSkillBlock.includes("next.kind === 'global'"), 'watch 缺回退签名守卫（prev=project → next=global）');
  assert.ok(watchSkillBlock.includes('!projectDirs.value.some('), '回退守卫缺 projectDirs 清单缺失判定（无法区分用户切全局与幽灵回退）');
  assert.ok(/normalizeDirKey\(prev\.path\)/.test(watchSkillBlock), '回退签名判定未走归一键（与 R-3 幽灵回退判定不同口径）');
  assert.ok(ghostFallbackBlock !== '' && !ghostFallbackBlock.includes(RST_SK_SEARCH) && !ghostFallbackBlock.includes(RST_SK_FILTER), 'watch(projectDirs) 幽灵回退块内出现重置赋值（裁决：回退不重置）');
});

console.log('── H3-03 负向钉：重置只挂作用域切换路径（同作用域其他操作零清空）──');
check('H3-03a 开关拨动切片零重置（Skill handleSkillToggle + MCP handleToggle；开关写链红线）', () => {
  const slices: Array<[string, string]> = [['handleSkillToggle', handleSkillToggleBody], ['handleToggle', handleToggleBody]];
  for (const [nm, body] of slices) {
    assert.ok(body !== '', `${nm} 函数体切片锚失效`);
    for (const lit of RESET_LITERALS_ALL) assert.ok(!body.includes(lit), `${nm} 出现重置赋值字面「${lit}」（开关链被挂重置——tdd-skill-x123 开关写链红线）`);
  }
});
check('H3-03b 进 tab 切片零重置（watch(activeTab)）', () => {
  assert.ok(activeTabBlock !== '', 'watch(activeTab) 切片锚失效');
  for (const lit of RESET_LITERALS_ALL) assert.ok(!activeTabBlock.includes(lit), `进 tab 路径出现重置赋值字面「${lit}」（同作用域进 tab 被清空）`);
});
check('H3-03c 卡片点击/保存路径零重置（openEdit/saveForm/saveScopedForm/persistManaged）', () => {
  const slices: Array<[string, string]> = [['openEdit', openEditBody], ['saveForm', saveFormBody], ['saveScopedForm', saveScopedBody], ['persistManaged', persistBody]];
  for (const [nm, body] of slices) {
    assert.ok(body !== '', `${nm} 函数体切片锚失效`);
    for (const lit of RESET_LITERALS_ALL) assert.ok(!body.includes(lit), `${nm} 出现重置赋值字面「${lit}」（保存/点击路径被清空）`);
  }
});
check('H3-03d 复合钉：两侧同作用域守卫齐备（重复点击当前 rail 项不清空）', () => {
  assert.ok(switchScopeBody.includes('const changed =') && switchScopeBody.includes('if (changed)'), 'MCP 侧缺 changed 同作用域守卫');
  assert.ok(watchSkillBlock.includes('next.kind === prev.kind'), 'Skill 侧缺同作用域守卫');
});

console.log('── H3-04 重置后列表即时刷新（过滤链不旁路；写响应式 ref 本体）──');
check('H3-04a MCP visibleCards 过滤 computed 消费 search/filter；切作用域路径零列表手动赋值', () => {
  assert.ok(visibleCardsBlock.includes('search.value') && visibleCardsBlock.includes('filter.value'), 'visibleCards 未消费 search/filter（过滤链旁路）');
  assert.ok(!switchScopeBody.includes('visibleCards.value ='), 'switchScope 出现 visibleCards 手动赋值（列表刷新走手动触发而非响应式重算）');
});
check('H3-04b Skill visibleSkills 过滤 computed 消费 skillSearch/skillFilter；切作用域路径零列表手动赋值', () => {
  assert.ok(visibleSkillsBlock.includes('skillSearch.value') && visibleSkillsBlock.includes('skillFilter.value'), 'visibleSkills 未消费 skillSearch/skillFilter（过滤链旁路）');
  assert.ok(!watchSkillBlock.includes('visibleSkills.value =') && !switchScopeBody.includes('visibleSkills.value ='), '切作用域路径出现 visibleSkills 手动赋值（旁路响应式重算）');
});
check('H3-04c 重置写响应式 ref 本体（赋值目标与 ref 声明一一对应）', () => {
  assert.ok(cpScript.includes("const skillSearch = ref('')") && cpScript.includes("const skillFilter = ref<SkillFilterId>('all')"), 'skillSearch/skillFilter ref 声明形态漂移（重置目标非响应式 ref 本体）');
  assert.ok(script.includes("const search = ref('')") && script.includes("const filter = ref<'all' | 'on' | 'off'>('all')"), 'search/filter ref 声明形态漂移（重置目标非响应式 ref 本体）');
});

// ══ H4：Skill 反馈补全（ⓘ 气泡 + 开关 toast；impl §4 / tests H4 节 H4-01~05）══
// 切片：同步条 div（无嵌套 div，首个 </div> 即闭）、showToast 函数体、ConfigPage 样式区
// 新增 .tip 族四块、.skill-sync-bar__hint 规则块。
const syncBarAnchorAt = cpTemplate.indexOf('data-testid="skill-sync-bar"');
const syncBarDivAt = syncBarAnchorAt === -1 ? -1 : cpTemplate.lastIndexOf('<div', syncBarAnchorAt);
const syncBarCloseAt = syncBarAnchorAt === -1 ? -1 : cpTemplate.indexOf('</div>', syncBarAnchorAt);
const syncBarSlice = syncBarDivAt === -1 || syncBarCloseAt === -1 ? '' : cpTemplate.slice(syncBarDivAt, syncBarCloseAt + '</div>'.length);
const showToastBody = jsFnBody(cpScript, 'showToast');
// handleSkillToggle 参数表含内联类型标注（skill: { … }），jsFnBody 的首 `{` 深度计数会截断在
// 类型标注（函数体断言不可达）——H4 小节改用「到首个行首 } 」整函数体切片；共用 jsFnBody 与
// 其既有 65 断言零触碰。注：函数体单行模板串不含行首 }（换行重构形态由断言显式红暴露）。
const h4ToggleAt = cpScript.indexOf('function handleSkillToggle(');
const handleSkillToggleFullBody = h4ToggleAt === -1 ? '' : cpScript.slice(h4ToggleAt, cpScript.indexOf('\n}', h4ToggleAt) + 2);
const cpStyle = cpFile.slice(cpFile.indexOf('<style'));
const tipBlock = blockFrom(cpStyle, '\n.tip {');
const bubbleBlock = blockFrom(cpStyle, '.tip .bubble {');
const tipShowBlock = blockFrom(cpStyle, '.tip:hover .bubble');
const infoBtnBlock = blockFrom(cpStyle, '.skill-info-btn {');
const syncHintBlock = blockFrom(cpStyle, '.skill-sync-bar__hint {');
const H4_TOAST_COMMON = '同名 Skill 跨作用域联动，新会话生效';

console.log('── H4-01 同步条 ⓘ + 气泡结构（两态文案逐字；外层保留 skill-sync-bar__hint 类名）──');
check('H4-01a ⓘ 为真 button + aria-label「自动同步说明」（skill-info-btn 载体在同步条切片内）', () => {
  assert.ok(syncBarSlice !== '', '同步条切片锚失效（data-testid="skill-sync-bar"）');
  assert.ok(syncBarSlice.includes('<button type="button" class="skill-info-btn" aria-label="自动同步说明">'), '同步条缺可聚焦 ⓘ 按钮（真 button + aria-label）');
  assert.ok(syncBarSlice.includes('aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'), 'ⓘ 内联 SVG 图形漂移（McpSettings 1772 同款逐字）');
});
check('H4-01b 两态长文案收进 role="tooltip" 气泡且分化条件不变', () => {
  assert.ok(syncBarSlice.includes('<span class="bubble" role="tooltip">'), '气泡容器缺失（role="tooltip"）');
  assert.ok(syncBarSlice.includes("{{ store.config.skillAutoSync ? '监听 ~/.claude/skills 与全局工作目录 .claude/skills，变化自动重新探测' : '已暂停自动同步，目录变化需手动刷新' }}"), '两态文案/分化条件漂移（skillAutoSync 三元逐字）');
});
check('H4-01c 文案载体已换（裸 hint 直排形态消失：两态文案全文件各恰 1 次且在同步条内）', () => {
  assert.ok(countOccurrences(cpTemplate, '监听 ~/.claude/skills') === 1, `「监听 ~/.claude/skills」出现 ${countOccurrences(cpTemplate, '监听 ~/.claude/skills')} 次（应恰 1 次）`);
  assert.ok(countOccurrences(cpTemplate, '已暂停自动同步') === 1, `「已暂停自动同步」出现 ${countOccurrences(cpTemplate, '已暂停自动同步')} 次（应恰 1 次）`);
  assert.ok(syncBarSlice.includes('监听 ~/.claude/skills'), '两态文案不在同步条切片内');
});
check('H4-01d 外层 span 保留 skill-sync-bar__hint 类名（tdd-skill-refresh ⑥ 样式类钉保全）', () => {
  assert.ok(syncBarSlice.includes('<span class="skill-sync-bar__hint tip">'), '外层 span 未保留 skill-sync-bar__hint 类名（或未挂 tip）');
});
check('H4-01e 保全镜像：同步条容器钉与文案 includes 钉维持绿（tdd-skill-refresh ⑥ 同款断言）', () => {
  assert.ok(/v-if="skillScope\.kind === 'global'" class="skill-sync-bar" data-testid="skill-sync-bar"/.test(cpFile), '同步条容器结构钉漂移');
  assert.ok(cpFile.includes('监听 ~/.claude/skills 与全局工作目录 .claude/skills') && cpFile.includes('已暂停自动同步'), '两态文案 includes 钉漂移');
  assert.ok(cpFile.includes('v-model="store.config.skillAutoSync"'), '同步条开关 v-model 绑定漂移');
});

console.log('── H4-02 气泡显隐双触发（:hover + :focus-within 配对；键盘可达）──');
check('H4-02a 显隐触发含键盘路径（focus-within 与 hover 配对同块；opacity/transform 形态）', () => {
  assert.ok(tipShowBlock !== '', 'hover/focus-within 显隐块缺失');
  assert.ok(tipShowBlock.includes('.tip:focus-within .bubble'), '显隐触发缺 :focus-within（键盘不可达）');
  assert.ok(tipShowBlock.includes('opacity: 1') && tipShowBlock.includes('transform: translateY(0)'), '显隐触发块形态漂移（opacity 1 / translateY(0)）');
});
check('H4-02b 负断言：不得仅 :hover（hover-only 独立规则块即红）+ ⓘ 载体可聚焦', () => {
  assert.ok(!cpStyle.includes('.tip:hover .bubble {'), '存在 hover-only 独立规则块（气泡仅 hover 可见，键盘不可达）');
  assert.ok(infoBtnBlock !== '', '.skill-info-btn 样式块缺失（ⓘ 非可聚焦真按钮载体）');
  assert.ok(syncBarSlice.includes('<button type="button" class="skill-info-btn"'), 'ⓘ 载体非真 button（不可 Tab 聚焦）');
});

console.log('── H4-03 开关成功 toast（页内 showToast 体系；逐字骨架 + 动态名）──');
check('H4-03a toast 走页内 showToast 且不旁路全局 error toast', () => {
  assert.ok(handleSkillToggleFullBody !== '', 'handleSkillToggle 整函数体切片锚失效');
  assert.ok(handleSkillToggleFullBody.includes('showToast('), 'handleSkillToggle 缺 showToast 调用（开关切换无反馈）');
  assert.ok(!stripComments(handleSkillToggleFullBody).includes('store.error'), '开关路径直写 store.error（旁路全局 error toast 载体）');
});
check('H4-03b toast 文案逐字：公共字面 + 启用/禁用两分支随 enabled 分化 + 名称动态插值', () => {
  assert.ok(handleSkillToggleFullBody.includes(H4_TOAST_COMMON), '公共字面「同名 Skill 跨作用域联动，新会话生效」缺失/漂移');
  assert.ok(handleSkillToggleFullBody.includes("enabled ? '启用' : '禁用'"), '启用/禁用两分支未随 enabled 三元分化');
  assert.ok(handleSkillToggleFullBody.includes('『${skill.name}』'), '名称未动态插值 skill.name（写死某名）');
});
check('H4-03c toast 字面全文件恰 1 次（不旁路挂第二处——自动路径/门控路径不弹）', () => {
  const n = countOccurrences(cpFile, H4_TOAST_COMMON);
  assert.ok(n === 1, `H4 toast 公共字面全文件出现 ${n} 次（应恰 1 次，仅 change handler 内）`);
});

console.log('── H4-04 开关禁用门控保全（X-2/W-2 原形态镜像；toast 无绕过路径）──');
check('H4-04a :disabled 门控表达式逐字（全局作用域 && 键名映射未就绪）', () => {
  assert.ok(/:disabled="skillScope\.kind === 'global' && !userSkillDirNamesReady"/.test(cpFile), 'switch :disabled 门控表达式漂移（X-2 原形态）');
});
check('H4-04b :title 按 userDirNamesTimedOut 分化原形态（W-2 镜像：超时臂/读取中臂/ready undefined）', () => {
  assert.ok(/:title="skillScope\.kind === 'global' && !userSkillDirNamesReady\s*\?\s*\(userDirNamesTimedOut\s*\?\s*'键名映射读取超时'\s*:\s*'键名映射读取中'\s*\)\s*:\s*undefined"/.test(cpFile), ':title 分化形态漂移（W-2）');
});
check('H4-04c @change 接线不动 + 开关写链保持（toast 只挂 change handler，原生 disabled 不发 change）', () => {
  assert.ok(cpFile.includes('@change="handleSkillToggle(skill, $event)"'), '开关 @change 接线漂移');
  assert.ok(handleSkillToggleFullBody.includes('setSkillEnabled('), '开关写链 setSkillEnabled 调用缺失');
});

console.log('── H4-05 toast 自动消失 ≤4s（页内体系 setTimeout 定时清除形态）──');
check('H4-05a showToast 定时清除形态保持（非常驻/非仅手动清除）', () => {
  assert.ok(showToastBody !== '', 'showToast 函数体切片锚失效');
  assert.ok(showToastBody.includes('toast.value = message'), 'showToast 页内载体形态漂移（toast ref 单槽）');
  assert.ok(showToastBody.includes('setTimeout('), 'showToast 缺 setTimeout 定时清除（常驻形态）');
});
check('H4-05b 自动消失时限 ≤4000ms（现值 3000ms 满足 4s 约束）', () => {
  const m = /setTimeout\(\s*\(\)\s*=>\s*\{\s*toast\.value = null;\s*\},\s*(\d+)\s*\);/.exec(showToastBody);
  assert.ok(m !== null, '定时清除形态漂移（toast.value = null 赋值 + 超时数值不可解析）');
  const ms = Number(m![1]);
  assert.ok(ms > 0 && ms <= 4000, `toast 自动消失时限 ${ms}ms 超出 ≤4000ms 约束`);
});

console.log('── H4-06（点指令完成判定）移植样式四块 + 零硬编码 hex ──');
check('H4-06a 四新增样式块齐备（.tip / .tip .bubble / 显隐 / .skill-info-btn 族）', () => {
  assert.ok(tipBlock !== '' && tipBlock.includes('position: relative') && tipBlock.includes('display: inline-flex'), '.tip 块缺失或形态漂移');
  assert.ok(bubbleBlock !== '' && bubbleBlock.includes('position: absolute'), '.tip .bubble 块缺失');
  assert.ok(tipShowBlock !== '', 'hover/focus-within 显隐块缺失');
  assert.ok(infoBtnBlock !== '' && infoBtnBlock.includes('width: 1.375rem') && cpStyle.includes('.skill-info-btn svg'), '.skill-info-btn 基础块/svg 子规则缺失');
  assert.ok(/\.skill-info-btn:hover,\s*\.skill-info-btn:focus-visible\s*\{/.test(cpStyle), 'info-btn hover/focus-visible 规则缺失');
  assert.ok(/\.skill-info-btn:focus-visible\s*\{[\s\S]{0,120}outline: 2px solid var\(--color-accent\)/.test(cpStyle), 'info-btn focus-visible 焦点环缺失');
});
check('H4-06b 移植块零硬编码 hex（token 化裁决：#fcfaf5/#e8c8c8 等色值剔除）', () => {
  const ported = tipBlock + bubbleBlock + tipShowBlock + infoBtnBlock;
  const hexHit = /#[0-9a-fA-F]{3,8}\b/.exec(ported);
  assert.ok(hexHit === null, `移植样式块出现硬编码 hex：${hexHit ? hexHit[0] : ''}`);
});
check('H4-06c #fcfaf5/#e8c8c8 全文件零出现（b/code 规则未移植进 ConfigPage）', () => {
  assert.ok(!cpFile.includes('#fcfaf5') && !cpFile.includes('#e8c8c8'), 'McpSettings 硬编码色值被带入 ConfigPage');
});
check('H4-06d 气泡深底浅字走 token（--color-text 底 + panel·text mix 字色 + elevation-3/radius token）', () => {
  assert.ok(bubbleBlock.includes('background: var(--color-text)'), '气泡底色未走 --color-text');
  assert.ok(bubbleBlock.includes('color-mix(in srgb, var(--color-panel) 92%, var(--color-text))'), '气泡字色未走 panel/text color-mix');
  assert.ok(bubbleBlock.includes('var(--elevation-3)') && bubbleBlock.includes('var(--radius-md)'), '气泡阴影/圆角未走 token');
});
check('H4-06e .skill-sync-bar__hint 原规则保留 + 追加 inline-flex 承载（防断言钉依赖漂移）', () => {
  assert.ok(syncHintBlock !== '', '.skill-sync-bar__hint 规则块缺失（tdd-skill-refresh 样式类钉）');
  assert.ok(syncHintBlock.includes('font-size: 0.6875rem') && syncHintBlock.includes('color: var(--color-text-muted)'), '原字号/色值规则漂移');
  assert.ok(syncHintBlock.includes('display: inline-flex'), '未追加 display: inline-flex（ⓘ 布局承载缺失）');
  assert.ok(syncHintBlock.includes('align-items: center') && syncHintBlock.includes('gap: 0.375rem'), '对齐/间距承载缺失');
});

// ══ H5：IM 微信退出确认（impl §5 / tests H5 节 H5-01~04）══
// 切片：BridgeSettings.vue 全文件 / script / template / wechatLogout 函数体 / 退出按钮切片。
const bsFile = read('src/renderer/components/config/BridgeSettings.vue');
const bsScriptStart = bsFile.indexOf('<script setup lang="ts">');
const bsScriptEnd = bsFile.indexOf('</script>', bsScriptStart);
const bsScript = bsScriptStart !== -1 && bsScriptEnd > bsScriptStart ? bsFile.slice(bsScriptStart, bsScriptEnd) : bsFile.slice(0, bsFile.indexOf('<template>'));
const bsTplStart = bsFile.indexOf('<template>');
const bsTemplate = bsFile.slice(bsTplStart, bsFile.lastIndexOf('</template>'));
const logoutBody = jsFnBody(bsScript, 'wechatLogout');
const logoutCode = stripComments(logoutBody);
// 退出按钮切片：@click="wechatLogout" 锚 → <button 开标签至 </button> 闭合（含文案）。
const logoutBtnAt = bsTemplate.indexOf('@click="wechatLogout"');
const logoutBtnCloseAt = logoutBtnAt === -1 ? -1 : bsTemplate.indexOf('</button>', logoutBtnAt);
const logoutBtnSlice = logoutBtnAt === -1 || logoutBtnCloseAt === -1 ? '' : bsTemplate.slice(Math.max(0, bsTemplate.lastIndexOf('<button', logoutBtnAt)), logoutBtnCloseAt + '</button>'.length);
const H5_TITLE = '退出微信登录';
const H5_MESSAGE = '退出后微信私聊不再同步；重新扫码登录即可恢复。';

console.log('\n=== H 配置页集成契约（H5 小节：IM 微信退出登录 danger 确认）===\n');

console.log('── H5-01 退出登录前置 danger 确认（统一体系接线 + 四段文案逐字）──');
check('H5-01a useInteractionStore 导入与实例在位（统一确认体系接线前置）', () => {
  assert.ok(bsScript.includes("import { useInteractionStore } from '../../stores/interaction-store';"), '缺 useInteractionStore 导入');
  assert.ok(bsScript.includes('const interactionStore = useInteractionStore();'), '缺 interactionStore 实例化');
});
check('H5-01b wechatLogout 函数体含 await interactionStore.requestConfirm（RED 判据：现状无确认直退）', () => {
  assert.ok(logoutBody !== '', 'wechatLogout 函数体切片锚失效');
  assert.ok(logoutCode.includes('await interactionStore.requestConfirm('), 'wechatLogout 缺 requestConfirm 前置确认（删确认直接退出）');
});
check('H5-01c title 逐字「退出微信登录」', () => {
  assert.ok(logoutBody.includes(`title: '${H5_TITLE}'`), 'title 文案漂移或缺失');
});
check('H5-01d message 逐字「退出后微信私聊不再同步；重新扫码登录即可恢复。」', () => {
  assert.ok(logoutBody.includes(`'${H5_MESSAGE}'`), 'message 文案漂移或缺失');
});
check('H5-01e confirmText「退出登录」/ cancelText「取消」逐字（附A A-4：confirmText 与按钮文案同串，A⑩ includes 命中面更宽）', () => {
  assert.ok(logoutBody.includes("confirmText: '退出登录'"), 'confirmText 漂移或缺失');
  assert.ok(logoutBody.includes("cancelText: '取消'"), 'cancelText 漂移或缺失');
});
check('H5-01f danger: true 在位（danger 确认钮形态，非普通确认）', () => {
  assert.ok(/danger:\s*true/.test(logoutBody), 'danger 未标 true（危险操作降级普通确认）');
});

console.log('── H5-02 取消无副作用（早退 + 序钉：副作用全部移到确认分支之后）──');
check('H5-02a 取消早退在位（requestConfirm 返回 false → return）', () => {
  assert.ok(logoutCode.includes('if (!ok) return;'), '缺 if (!ok) return 早退（取消路径会继续执行副作用）');
});
check('H5-02b 序钉：confirm < 早退 < qrDataUrl 清空 < save（取消路径零副作用）', () => {
  const confirmAt = logoutCode.indexOf('await interactionStore.requestConfirm(');
  const retAt = logoutCode.indexOf('if (!ok) return;');
  const qrAt = logoutCode.indexOf("qrDataUrl.value = ''");
  const saveAt = logoutCode.indexOf("save({ wechat: { botToken: '' } })");
  assert.ok(confirmAt !== -1 && retAt !== -1 && qrAt !== -1 && saveAt !== -1, `切片要素缺失 confirm=${confirmAt} return=${retAt} qr=${qrAt} save=${saveAt}`);
  assert.ok(confirmAt < retAt, '确认调用不在早退之前（确认失去先置意义）');
  assert.ok(retAt < qrAt && retAt < saveAt, `早退未前置全部副作用：return=${retAt} qr=${qrAt} save=${saveAt}（取消路径残留副作用——现状 qrDataUrl 清空在函数头部即此回归）`);
});
check('H5-02c 既有副作用两点形态保全（清二维码 + 清 token 保存链未被重写/删除）', () => {
  assert.ok(logoutBody.includes("qrDataUrl.value = '';"), 'qrDataUrl 清空语句缺失或漂移');
  assert.ok(logoutBody.includes("await save({ wechat: { botToken: '' } });"), '清 token 保存链缺失或漂移');
});

console.log('── H5-03 确认后才执行既有退出逻辑（保全；防倒退钉转写即绿属预期）──');
check('H5-03a 确认分支走既有 save 链清 token（零旁路：无 bridgeSaveConfig/resolveSecretPatch 直调）', () => {
  assert.ok(logoutBody.includes("save({ wechat: { botToken: '' } })"), '既有清 token 保存链缺失（确认分支重写退出逻辑）');
  assert.ok(!logoutCode.includes('bridgeSaveConfig'), '函数体出现 bridgeSaveConfig 直调（旁路既有 save 链）');
  assert.ok(!logoutCode.includes('resolveSecretPatch'), '函数体出现 resolveSecretPatch（复制主进程掩码语义）');
});
check('H5-03b 按钮本体保全：@click="wechatLogout" + im-act-btn + v-if 门控 + 文案「退出登录」（A⑩ 镜像钉）', () => {
  assert.ok(logoutBtnAt !== -1, '模板 @click="wechatLogout" 接线漂移');
  assert.ok(logoutBtnSlice !== '', '退出按钮切片锚失效（</button> 闭合未找到）');
  assert.ok(logoutBtnSlice.includes('class="im-act-btn"'), '退出按钮 class 漂移');
  assert.ok(logoutBtnSlice.includes('v-if="config?.wechat.loggedIn"'), '退出按钮 v-if 门控漂移');
  assert.ok(logoutBtnSlice.includes('>退出登录</button>'), '按钮文案「退出登录」漂移（tdd-bridge-ui-static A⑩ 钉）');
});
check('H5-03c 全文件「退出登录」includes 命中保全（A⑩ 同款：按钮文案 + confirmText 双命中）', () => {
  assert.ok(bsFile.includes('退出登录'), '「退出登录」字面全文件缺失（tdd-bridge-ui-static A⑩ 破）');
});

console.log('── H5-04 统一确认体系承担；Esc=取消零新增接线（负断言）──');
check('H5-04a 全文件零 @keydown.esc / 零 Escape 自制接线（Esc=取消由 InteractionPrompt 既有语义承担）', () => {
  assert.ok(!/@keydown\.esc/i.test(bsFile), '出现 @keydown.esc 接线（自制 Esc 层——红线：不新增 Esc 层）');
  assert.ok(!bsFile.includes('Escape'), '出现 Escape 键处理（自制 Esc 层——红线：不新增 Esc 层）');
});
check('H5-04b wechatLogout 函数体零 window.confirm / 零 armed 两段式自制确认层', () => {
  assert.ok(!logoutCode.includes('window.confirm'), 'wechatLogout 出现 window.confirm（绕统一确认体系；全文件级断言不可用——L265 既有注释含该字面）');
  assert.ok(!/[Aa]rmed/.test(logoutCode), 'wechatLogout 出现 armed 两段式自制确认（统一体系裁决；armed 仅为飞书清除授权用户局部先例）');
});

// ══ H6：网页访问关闭态警示行（impl §6 / tests H6 节 H6-01~H6-04）══
// 切片：ConfigPage 状态卡（.webacc-status 卡片 div 平衡切片）/ warn 行切片 / error 臂切片 /
//   样式 .webacc-status__line--warn 块。裁决（点指令 2026-11-10）：「未开启」整行替换执行——
//   wiring 12.3「状态卡 off 文案『未开启』」includes 钉同点同步改钉为警示行文案断言（附 A-3）。
const webaccCardAt = cpTemplate.indexOf('<div class="webacc-status" data-testid="web-access-status">');
// div 平衡切片：自卡片开标签起计数 <div/</div> 归零（卡内层级行均为 div，<template>/<ol>/<p>/
// <img> 非 div 不参与计数——与 H4 tag 切片同思路，g4 花括号平衡的标签版）。
const webaccCard = (() => {
  if (webaccCardAt === -1) return '';
  const re = /<\/?div\b[^>]*>/g;
  re.lastIndex = webaccCardAt;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cpTemplate)) !== null) {
    if (m[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) return cpTemplate.slice(webaccCardAt, m.index + m[0].length);
    } else if (!m[0].endsWith('/>')) {
      depth += 1;
    }
  }
  return '';
})();
const H6_WARN_TEXT = '网页访问已关闭 · 局域网设备无法连接；已连接设备将被断开';
const warnRowAt = webaccCard.indexOf('webacc-status__line--warn');
const warnRowOpenAt = warnRowAt === -1 ? -1 : webaccCard.lastIndexOf('<div', warnRowAt);
const warnRowSlice = warnRowOpenAt === -1 ? '' : webaccCard.slice(warnRowOpenAt, webaccCard.indexOf('</div>', warnRowAt) + 6);
const errArmAt = webaccCard.indexOf('v-else-if="waStatusError"');
const errArmSlice = errArmAt === -1 ? '' : webaccCard.slice(errArmAt, warnRowOpenAt === -1 ? webaccCard.length : warnRowOpenAt);
const warnStyleAt = cpStyle.indexOf('.webacc-status__line--warn {');
const warnStyleBlock = warnStyleAt === -1 ? '' : blockFrom(cpStyle, '.webacc-status__line--warn {');
const errStyleAt = cpStyle.indexOf('.webacc-status__line--error {');

console.log('\n=== H 配置页集成契约（H6 小节：网页访问关闭态 warn 警示行）===\n');

console.log('── H6-01 off 态警示行文案逐字 + warn 弱底（--error 类负断言 + 样式 token 化）──');
check('H6-01a 警示行文案逐字「网页访问已关闭 · 局域网设备无法连接；已连接设备将被断开」（RED 判据：现状仅「未开启」行）', () => {
  assert.ok(warnRowSlice !== '', '警示行切片锚失效（webacc-status__line--warn 缺失）');
  assert.ok(warnRowSlice.includes(H6_WARN_TEXT), '状态卡 off 警示行文案漂移或缺失');
});
check('H6-01b 警示行独立 warn 类且不复用 --error 类（负断言：误用 error 红必红）', () => {
  assert.ok(warnRowSlice !== '', '警示行切片锚失效');
  assert.ok(warnRowSlice.includes('webacc-status__line--warn'), '警示行未挂 webacc-status__line--warn 类');
  assert.ok(!warnRowSlice.includes('webacc-status__line--error'), '警示行复用 --error 类（warn 弱底语义丢失）');
});
check('H6-01c 样式 .webacc-status__line--warn 在位且 token 化（warn-strong 字 / warn 10% 弱底 / warn 30% 描边 / radius-sm，零硬编码 hex）', () => {
  assert.ok(warnStyleBlock !== '', '.webacc-status__line--warn 样式块缺失');
  assert.ok(warnStyleBlock.includes('color: var(--color-warn-strong)'), '警示字色未走 --color-warn-strong');
  assert.ok(warnStyleBlock.includes('color-mix(in srgb, var(--color-warn) 10%, transparent)'), '警示底色未走 warn 10% color-mix 弱底');
  assert.ok(warnStyleBlock.includes('color-mix(in srgb, var(--color-warn) 30%, transparent)'), '警示描边未走 warn 30% color-mix');
  assert.ok(warnStyleBlock.includes('var(--radius-sm)'), '圆角未走 --radius-sm token');
  const hexHit = /#[0-9a-fA-F]{3,8}\b/.exec(warnStyleBlock);
  assert.ok(hexHit === null, `warn 样式块出现硬编码 hex：${hexHit ? hexHit[0] : ''}`);
});
check('H6-01d 样式序钉：--warn 规则位于 --error 规则之后（impl §6.2 位置约束）', () => {
  assert.ok(errStyleAt !== -1 && warnStyleAt !== -1 && errStyleAt < warnStyleAt, `样式顺序漂移：error=${errStyleAt} warn=${warnStyleAt}`);
});

console.log('── H6-02 挂 off 分支门控（v-else）+ 负断言常驻 ──');
check('H6-02a 警示行以 v-else 门控挂分支链尾（非 running 非 error 才渲染；无门控常驻即红）', () => {
  assert.ok(warnRowSlice.startsWith('<div v-else'), '警示行未挂 v-else 门控（常驻渲染 → 运行中仍显示「已关闭」自相矛盾）');
});

console.log('── H6-03 分支链互斥序（error 优先不并存）+ error 臂零警示文案 ──');
check('H6-03a 状态卡序钉：webAccessInfoError 行最前（并列独立行）→ running(v-if=waRunning) → error(v-else-if=waStatusError) → off(v-else 警示行)', () => {
  assert.ok(webaccCard !== '', '状态卡切片锚失效');
  const infoErrAt = webaccCard.indexOf('v-if="webAccessInfoError"');
  const runningAt = webaccCard.indexOf('<template v-if="waRunning">');
  assert.ok(infoErrAt !== -1 && runningAt !== -1 && errArmAt !== -1, `分支锚缺失 info=${infoErrAt} running=${runningAt} err=${errArmAt}`);
  assert.ok(infoErrAt < runningAt, '「状态获取失败」行不在卡片最前（现状并列形态被挤占）');
  assert.ok(runningAt < errArmAt, '分支链序漂移：running 不在 error 臂之前');
  assert.ok(errArmAt < warnRowAt, '警示行不在 error 臂之后（互斥链断裂——error 与警示并存）');
  assert.ok(warnRowSlice.startsWith('<div v-else'), 'off 臂非 v-else（互斥链断裂）');
});
check('H6-03b error 臂（启动失败）切片零出现警示文案「网页访问已关闭」（负断言：启动失败不提示已关闭）', () => {
  assert.ok(errArmSlice !== '', 'error 臂切片锚失效');
  assert.ok(!errArmSlice.includes('网页访问已关闭'), 'error 臂混入警示文案（启动失败还提示「已关闭」）');
});

console.log('── H6-04 既有三态呈现保全（防倒退钉，转写即绿属预期）──');
check('H6-04a running 态呈现保全：逐条 urls v-for + 首条二维码 img v-if qrDataUrl + 空列表提示行（wiring 12.3 镜像）', () => {
  assert.ok(webaccCard !== '', '状态卡切片锚失效');
  assert.ok(/v-for="url in webAccessInfo\?\.urls \?\? \[\]"/.test(webaccCard), 'running urls v-for 漂移');
  assert.ok(/<img v-if="webAccessInfo\?\.qrDataUrl"/.test(webaccCard), '二维码 img v-if 漂移');
  assert.ok(webaccCard.includes('未发现可用的局域网 IPv4 地址'), '空列表提示行漂移');
});
check('H6-04b error 态呈现保全：「启动失败（端口 …）：…」形态 + waStatusError.port/message 字段锚', () => {
  assert.ok(errArmSlice !== '', 'error 臂切片锚失效');
  assert.ok(errArmSlice.includes('启动失败（端口'), 'error 臂「启动失败」形态漂移');
  assert.ok(errArmSlice.includes('waStatusError.port') && errArmSlice.includes('waStatusError.message'), 'error 臂字段锚漂移');
});
check('H6-04c webAccessInfoError 行保全：「状态获取失败：{{ webAccessInfoError }}」独立并列行', () => {
  assert.ok(webaccCard !== '' && webaccCard.includes('状态获取失败：{{ webAccessInfoError }}'), '「状态获取失败」行漂移');
});
check('H6-04d 「未开启」字面全文件零残留（替换执行裁决；wiring 12.3 同步改钉的对偶钉）', () => {
  assert.ok(!cpFile.includes('未开启'), '「未开启」字面残留（替换执行裁决未落实，或出现于其他位置）');
});

// ═══ H7 小节：MCP 编辑器两处 hint 编辑态分支（slate-ui-completion-1108-1428 round-001 点 H7）═══

const selftestMcp = read('scripts/selftest-mcp-settings.ts');

// H7 切片：
//   locHintBlock    —— locationHint computed 声明块（blockFrom 花括号平衡切片）；
//   nameHintSlice   —— 名称 hint span 的插值表达式（{{ nameErrorShown !== '' ? … }}）；
//   locHintSpanLine —— 保存位置 hint span 开标签 → 关标签整段（selftest P3 切片终点所在行）；
//   nameSpanSlice   —— 名称 hint span 开标签。
const locHintBlock = blockFrom(script, 'const locationHint = computed');
const nameHintExprAt = template.indexOf('{{ nameErrorShown !== \'\' ?');
const nameHintSlice = nameHintExprAt === -1 ? '' : template.slice(nameHintExprAt, template.indexOf('}}', nameHintExprAt) + 2);
const locHintAt = template.indexOf('{{ locationHint }}');
const locHintSpanLine = locHintAt === -1 ? '' : template.slice(template.lastIndexOf('<span', locHintAt), template.indexOf('</span>', locHintAt) + 7);
const nameSpanAt = template.indexOf('<span :class="[\'mcp-ffield__hint\'');
const nameSpanSlice = nameSpanAt === -1 ? '' : template.slice(nameSpanAt, template.indexOf('>', nameSpanAt) + 1);

console.log('── H7-01 名称 hint 编辑态分支「编辑态不可改名」+ 新建态格式 hint 保全 ──');
check('H7-01a 名称 hint 切片含 isEditMode 编辑态分支「编辑态不可改名」逐字（RED 判据：现状 hint 无 isEditMode 分支）', () => {
  assert.ok(nameHintSlice !== '', '名称 hint 切片锚失效（nameErrorShown 三元缺失）');
  assert.ok(nameHintSlice.includes("isEditMode ? '编辑态不可改名'"), '名称 hint 无编辑态分支（编辑态仍显格式 hint，误导用户以为可改名）');
});
check('H7-01b 新建态格式 hint 逐字保全（负断言：新建态文案不得被替换删除）', () => {
  assert.ok(template.includes('工具名形如 mcp__<名称>__<工具>，仅限字母、数字、-、_'), '新建态格式 hint 文案被删改');
});

console.log('── H7-02 保存位置 hint 编辑态分支（形态 A：computed 首行）+ 新建态三段保全 + P3 切片保全 ──');
check('H7-02a locationHint computed 函数体首行为 isEditMode 分支「编辑态下保存位置不可更改」逐字（RED 判据：现状无编辑态分支）', () => {
  assert.ok(locHintBlock !== '', 'locationHint computed 切片锚失效');
  const branchAt = locHintBlock.indexOf("if (isEditMode.value) return '编辑态下保存位置不可更改'");
  assert.ok(branchAt !== -1, 'locationHint 无 isEditMode 编辑态分支');
  assert.ok(branchAt < locHintBlock.indexOf("if (formLocation.value === 'managed')"), 'isEditMode 分支不在函数体首行（新建态分支先于编辑态分支）');
});
check('H7-02b 新建态作用域说明逐字原样（managed/user/project 目录非空/project 回退四 return 不动）', () => {
  assert.ok(locHintBlock.includes('存入应用配置库，仅 Claude Link 会话可用（经 SDK 注入，优先级最高，推荐）。'), 'managed 段文案漂移');
  assert.ok(locHintBlock.includes('写入 ~/.claude.json，全局 Claude Code 共享（所有项目的新会话可用，运行中会话不重载）。'), 'user 段文案漂移');
  assert.ok(locHintBlock.includes('写入 ${formProjectDir.value}\\\\.mcp.json，随仓库共享（仅该目录下的会话可用）。'), 'project 目录非空段文案漂移');
  assert.ok(locHintBlock.includes('写入所选项目目录的 .mcp.json，随仓库共享（仅该目录下的会话可用）。'), 'project 回退段文案漂移');
});
check('H7-02c P3 切片保全断言：{{ locationHint }} 绑定模板内恰 1 次（形态 A 裁决：保持绑定零改动）+ selftest-mcp-settings P3 边界字面未漂移', () => {
  assert.ok(countOccurrences(template, '{{ locationHint }}') === 1, 'P3 切片边界 {{ locationHint }} 绑定形态被破坏（形态 B 内联三元即触发本钉）');
  assert.ok(selftestMcp.includes("const p3SegEnd = pSrc.indexOf('{{ locationHint }}', p3SegStart);"), 'selftest-mcp-settings P3 边界字面漂移（P3 免同步前提被破坏）');
});

console.log('── H7-03 错误红字最优先（三元链序钉）+ 保存位置 hint 零 danger 通道 ──');
check('H7-03a 名称 hint 优先级链序：nameErrorShown（最外层判定）> isEditMode 编辑态 hint > 格式 hint（校验错误被遮必红）', () => {
  assert.ok(nameHintSlice !== '', '名称 hint 切片锚失效');
  const errAt = nameHintSlice.indexOf("nameErrorShown !== '' ? nameErrorShown");
  const editAt = nameHintSlice.indexOf('isEditMode ?');
  const fmtAt = nameHintSlice.indexOf('工具名形如');
  assert.ok(errAt !== -1 && editAt !== -1 && fmtAt !== -1, `优先级链锚缺失 err=${errAt} edit=${editAt} fmt=${fmtAt}`);
  assert.ok(errAt < editAt && editAt < fmtAt, '优先级链序漂移（nameErrorShown 判定必须最外层，编辑态 hint 次之）');
});
check('H7-03b 保存位置 hint 无校验错误通道（负断言：不得给保存位置 hint 新增 danger 通道）', () => {
  assert.ok(locHintSpanLine.includes('{{ locationHint }}'), '保存位置 hint span 锚失效');
  assert.ok(!locHintSpanLine.includes('danger'), '保存位置 hint 出现 danger 通道（错误红字仅由名称 hint 的 nameErrorShown 通道承担）');
});

console.log('── H7-04 校验逻辑不变（防倒退保全钉，转写即绿属预期）──');
check('H7-04a 名称既有 :disabled="isEditMode" 禁用保持（编辑态不可改名的实现根基）', () => {
  const nameFieldAt = template.indexOf('placeholder="context7"');
  assert.ok(nameFieldAt !== -1, '名称输入切片锚失效');
  const nameLabel = template.slice(template.lastIndexOf('<label', nameFieldAt), template.indexOf('</label>', nameFieldAt));
  assert.ok(nameLabel.includes(':disabled="isEditMode"'), '名称输入禁用绑定漂移（编辑态可改名即破坏 H7 根基）');
});
check('H7-04b touchedFields/nameErrorShown 校验链零变化（H7 仅换 hint 呈现）', () => {
  assert.ok(script.includes("computed<string>(() => (touchedFields.value.name || submitAttempted.value ? nameError.value : ''))"), 'nameErrorShown 门控形态漂移');
  assert.ok(template.includes('@blur="touchedFields.name = true"'), '名称失焦 touched 门控漂移');
  assert.ok(script.includes("if (name === '') return '名称必填';"), '名称必填校验漂移');
});
check('H7-04c locationHint project 分支守卫与 editorSubline projectDirs 回退零变化（数据流零改动）', () => {
  assert.ok(locHintBlock.includes("if (formProjectDir.value !== '')"), 'project 分支守卫漂移');
  const sublineBlock = blockFrom(script, 'const editorSubline = computed');
  assert.ok(sublineBlock.includes('projectDirs.value.find'), 'editorSubline projectDirs 回退漂移（round-002 F2 行为被顺手改坏）');
});

console.log('── H7-05 hint 均 muted 小字（mcp-ffield__hint 类）+ 编辑态分支零 danger ──');
check('H7-05a 两处 hint 沿既有 mcp-ffield__hint 类渲染（muted 小字既有样式）', () => {
  assert.ok(locHintSpanLine.includes('class="mcp-ffield__hint"'), '保存位置 hint 未走 mcp-ffield__hint 类');
  assert.ok(nameSpanSlice.startsWith('<span :class="[\'mcp-ffield__hint\''), '名称 hint 未走 mcp-ffield__hint 类');
});
check('H7-05b 编辑态 hint 分支切片零 --danger 修饰（负断言：错误态红字仅由 H7-03 的 nameErrorShown 通道承担）', () => {
  assert.ok(locHintBlock !== '' && !locHintBlock.includes('danger'), 'locationHint 编辑态分支/正文混入 danger');
  assert.ok(nameHintSlice !== '' && !nameHintSlice.includes('danger'), '名称 hint 编辑态分支混入 danger');
});

console.log('── 契约脚本注册（两处）──');
check('注册 · scripts/selftest-static-list.txt 含本脚本', () => {
  assert.ok(staticList.includes('scripts/tdd-config-h1-h7-verify.ts'), 'static list 未登记');
});
check('注册 · tsconfig.tdd.json include 含本脚本', () => {
  assert.ok(tsconfigTdd.includes('scripts/tdd-config-h1-h7-verify.ts'), 'tsconfig.tdd.json include 未登记');
});

console.log(`\n[H 配置页集成契约 · H1+H2+H3+H4+H5+H6+H7] 通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
