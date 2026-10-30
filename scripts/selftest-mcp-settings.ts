// selftest-mcp-settings.ts
// MCP 管理契约 selftest 断言集（docs/plans/2026-10-12-mcp-management-plan.md §2 P9 / §5 T1）。
// 纯函数断言：不依赖 Electron runtime、不读任何磁盘配置（绝不触碰真实 ~/.claude.json），
// 直接 import src/main/modules/mcp/mcp-config.ts 与 sdk-mcp.ts（两文件均不得 import electron）。
//
// 断言集分五组（§5 T1 全集）：
//   A sanitize 组：sanitizeMcpServersConfig / sanitizeMcpOverridesConfig——P1 已实现，
//     RED 阶段本组应【全 PASS】（作为断言集自身的基线自证）。
//   B parseMcpServersJson 组：三形态 / transport 判定 / 坏 JSON·坏根 → ok:false 中文 error。
//   C toSdkMcpServerConfig 组：stdio（env 空对象省略）/ http / sse 三形。
//   D mergeMcpServersForSession 组：三层合并同名覆盖顺序 managed > project > user；
//     override 禁用 user:/project:<dirKey>:/managed: 前缀键；projectDirKey=null 项目级不参与；
//     全空 → {}；项目级 override 仅同目录键生效。
//   E sdk-mcp 组：buildSessionMcpOverridesForPin / parseSessionMcpOverrides /
//     mergeMcpServersIntoSettings（空配置字节级一致 / 会话钉住优先 / 存量 null 回退全局 /
//     幽灵键跳过不崩；io 注入内存 stub，默认实现暂缺不在此路径）。
//     E3g/E3h（B-1，2026-10-16）：默认 io（readUser/readProject 不覆盖，仅钉 userHome 到临时
//     目录）的坏目录负缓存——badDirCacheMark 后项目层/用户层缺席，共享负缓存键形态
//     （项目=原始目录串、用户=mcp-user:<home>）与未标记对照。
//     E3i（round-002 修复 F2，2026-10-16）：真实读失败（目录形态 .mcp.json，非 ENOENT）→
//     默认 io 自动 mark + 重调负缓存短路；损坏 JSON / ENOENT 两反例不 mark。
//   F §1.3 脱敏闭环组（r3 修复 F2 新增）：maskMcpServersForRenderer（值全变哨兵/键保留/
//     入参不被变异/无该字段不添加）+ restoreMaskedMcpServers（同键哨兵还原/改名 hint/无 hint
//     丢键/非哨兵透传/id 对位优先 name 兜底/瞬态字段剥离）+ mask→restore 往返 deepEqual。
//   G R2 mtime 缓存组（2026-10-13 mcp-followup R2 新增）：readUserMcpServersRawSync 的
//     用户级 ~/.claude.json 读取 mtime 缓存（初读/改写失效/clearMcpRawCache 后等价/同 mtime
//     重复读稳定/损坏不缓存）；临时目录 os.tmpdir() 下自建跑完清理，绝不触真实 ~/.claude.json。
//     （注：P8a mcp-writer 未来落地时，writer 组顺延命名——原预留 H 已被 R5 三态文案组占用。）
//   H R5 三态文案组（2026-10-13 mcp-followup R5 新增）：McpSettings.vue 项目作用域空列表
//     三态互斥的静态源码钉（渲染层组件无纯函数可行为级断言，沿 tdd-bridge-ui-static-verify
//     先例读源码断言）：消失态文案逐字存在、isProjectDirGone 判定含 project 作用域守卫
//    （消失态不得误报管理库/user/未选目录态）、p4 快照失败占位先于空态块、分支嵌套顺序。
//     H6（p6 B-3，2026-10-16 新增；2026-10-19 mcp-settings-plan-a 点6 改写）：导入归一值级
//     清洗防漂移钉——原钉渲染层 normalizeImportEntry 区域值级过滤 + env/headers 不得
//     `as Record<string, string>` 断言/裸透传（与主进程 pickStringRecord 防「双处同步」漂移）；
//     点6 删双副本后按保护意图改钉新架构（解析走 claude.parseMcpJson 桥 + 副本函数定义零出现
//     + 透传负向形态保留），判定语义「防透传、防漂移」不变，详见 H6 处注释。
//   I D-V1-1 注入挂载组（2026-10-13 mcp-followup R4 修复新增）：buildNativeSdkOptionsCore 在
//     settings.mcpServers 非空时把同一归一 map 挂到顶层 Options.mcpServers（strictMcpConfig 下
//     SDK 只认顶层 mcpServers，settings 块内键被忽略——D-V1-1 根因）；空配置（三层全空/全禁用/
//     空对象防御边界）零挂载；挂载载体（null 原型）可被 JSON 无损序列化（SDK --mcp-config 走
//     JSON.stringify）。全链真实构造：mergeMcpServersIntoSettings 产 settings 块 → 核心工厂产 options。
//     （sdk-command-options.ts 仅类型 import，纯 node 可直接 import。）
//     I4/I5（B-2 strict 门控化，2026-10-16 新增；2026-10-29 H2 收紧改写）：strictMcpConfig =
//     「挂载 ∨ overridesHitExisting」门控——未接管空配置 strict=false 恢复引擎原生加载（I4）；
//     I5 改为双场景新口径：merged 空+钉住孤儿键（不命中现存定义）→ strict=false（孤儿键不再
//     压制引擎原生加载——H2 修复点）；merged 空+钉住禁用键命中现存定义 → strict=true 保底
//    （「禁用生效」不回退，I 组回归底线）。两场景 mcpOverridesActive 均消费
//     mergeMcpServersIntoSettings 新返回值（与生产链同信号源）。
//     I6（round-002 修复 F1，2026-10-16；2026-10-29 H2 重钉）：sdk-backend 两生产构造点
//     （buildSdkOptions / buildProbeSdkOptions）改钉新形态——三元解构 + mcpOverridesActive 简写
//     传参；旧公式（effectiveOverrides 局部声明 / 全局键计数三元）全文件零出现（防回退）。
//     I7（2026-10-29 H2 收紧新增）：mergeMcpServersIntoSettings.overridesHitExisting 直测——
//     effective overrides 中至少一个值==='off' 的键命中三层现存定义才 true；孤儿键/跨目录
//     project 键（D5）/非 'off' 脏值键均 false。
//     I8（2026-10-29 B-M1 加固新增）：不可观测定义层（默认 io 真实读失败 readFailed=true / 坏目录
//     负缓存 60s 短路）视为「定义未知」——effective overrides 中存在任意值==='off' 的键时保守置
//     overridesHitExisting=true（宁可短暂 strict，不放行引擎原生拉起破坏用户显式禁用语义）；
//     ENOENT / JSON 损坏两条正常空态路径不保守（既有三态分类口径不变）；无 'off' 键时仍 false
//    （H2「未接管恢复原生加载」不回归）。默认 io + 真实临时目录（绝不触真实 ~/.claude.json）。
//   J timeoutMs 全链组（2026-10-19 mcp-settings-plan-a 点1 新增）：sanitize/导出/解析/视图
//     对 timeoutMs 的透传（配置侧口径：合法=Number.isInteger 且 1..120000，非法静默丢字段、
//     条目其余字段完好）+ resolveProbeTimeoutMs 参数化（undefined/非法→30000、>=1 整数封顶
//     120000）+ 注入链防漏钉（J6：带 timeoutMs 条目经 toSdkMcpServerConfig / merge 全链输出
//     均不含 timeoutMs——会话行为零变化，计划 §1.2 硬约束）。J2（writer 写出含/无 timeoutMs
//     键）为异步驱动，归位 scripts/selftest-mcp-writer.ts [12]（两断言逐字对应），本组不重复；
//     J4 另在 scripts/selftest-mcp-export.ts A9 镜像补条。J3 为异步断言（collectMcpSnapshot +
//     临时目录，沿 G 组惯例绝不触真实 ~/.claude.json）——自本点起汇总移入 finish()，由 J3 的
//     promise 链收尾调用一次。
//   K 单服务器导出 JSON 组（2026-10-19 mcp-settings-plan-a 点2 新增）：src/shared/mcp-json.ts
//     buildSingleServerExportJson（表单⇄JSON 双模式「表单 → JSON」方向的 shared 纯函数）——
//     {"<name>":{…}} 单服务器形态、2 空格缩进+尾换行、字段序固定、空 args/env/headers 省略键、
//     description 不导出、数组/嵌套对象单行紧凑（K1 字面比对为准绳）；K5 哨兵经主进程
//     parseMcpServersJson 回读往返一致（JSON 模式可回填契约）；K6（round-002 F6）description
//     防漏钉——输入带 description:"x" 输出也不出现该键（沿 J6 先例，写断言即 PASS）。
//   L 方案 A 列表卡片化组（2026-10-19 mcp-settings-plan-a 点3 新增）：McpSettings.vue 条目区
//     卡片化（对照原型 .mxA-card）静态源码钉——L1 row__ic/row__st 类与状态点四色修饰类
//     （row__st--ok/--fail/--busy/--off）存在，且旧结构 mcp-tchip / mcp-scope-badge /
//     inset 3px 0 0 三者源码零出现；L2=H 组 R5 三态文案钉回归确认（无新断言，不计 check）；
//     L3 row__spin 存在且同文件含 prefers-reduced-motion 停用其动画规则。点3 RED：L1/L3
//     因新类未落地而 FAIL（L1 兼负向钉，旧结构未删同 FAIL）；实现后全 PASS。
//   M 方案 A 编辑器页内化组（2026-10-19 mcp-settings-plan-a 点4 新增）：编辑/新建从 Teleport
//     弹窗（useDialogShell 拖拽缩放壳）改为主区第二视图（v-show 常挂防丢草稿）静态源码钉——
//     M1 editorView ref（'list'|'edit'）与双视图 v-show 结构存在；M2 编辑弹窗壳类 mcp-modal
//     源码零出现（原为编辑/导入两弹窗共用类，编辑壳移除后导入壳类名改名 mcp-import-modal，
//     "mcp-modal" 不为其子串）+ editCardRef/editShell/showEditDialog 零出现 + 导入弹窗壳
//    （importCardRef/importShell）仍在；M3 面包屑「返回列表」文案存在；M4 页内 Esc——
//     @keydown.escape 绑定存在且处理器含 editorView==='edit' 守卫（回 list）。点4 RED：
//     M1/M3/M4 因新结构不存在 FAIL、M2 因编辑弹窗壳仍在 FAIL；实现后全 PASS。
//   N 方案 A 表单⇄JSON 双模式 + 超时字段组（2026-10-19 mcp-settings-plan-a 点5 新增）：
//     McpSettings.vue 编辑器双模式与超时字段的静态源码钉（沿 H/L/M 组读源码先例）——
//     N1 editMode/jsonText/jsonError/jsonParsing 状态定义存在；N2 分段胶囊「表单」「JSON」
//     两项文案存在；N3 两条 jsonError 文案字面存在（一次只支持一台 / 编辑态不可改名）；
//     N4「复制 JSON」按钮本体存在（@click="copyJson" 绑定 + pushToast('已复制 JSON') toast 字面，
//     R3 改钉）；N5 超时校验文案字面存在（1–120000，en-dash）；N6「由当前
//     表单配置实时生成」提示条文案字面存在。点5 RED：N1/N3/N4/N5/N6 因新代码未落地而
//     FAIL（N2 的胶囊壳点4 已建、两项文案先行存在，RED 阶段即 PASS）；实现后全 PASS。
//     N7（round-002 F1 修复新增）JSON 往返键改名 hint 快照闭环：切 JSON 前 jsonRenameHints
//     快照改名映射 + kvRowsFromParsed 回填入参 + 哨兵行 hints 回退式 token 存在——round-002
//     RED：N7 因快照代码未落地 FAIL；实现后 PASS。
//   O 导入解析收口主进程组（2026-10-19 mcp-settings-plan-a 点6 新增）：McpSettings.vue 删
//     双副本（导入归一副本 normalizeImportEntry 链 + 本地哨兵字面量）后的静态源码钉（沿
//     H/L/M/N 组读源码先例，O2/O3 以 node fs 递归遍历 src/renderer 全部 .ts/.vue 断言，
//     跑完不留临时文件）——O1 normalizeImportEntry 在 McpSettings.vue 源码零出现；O2
//     mask_sentinel 子串（大小写不敏感，含主进程名 MCP_MASK_SENTINEL 变体；注释提及同算）
//     在 src/renderer 零出现（渲染层唯一合法引用为 shared 的 MCP_VALUE_MASK，其名不含该
//     子串）；O3 渲染层无哨兵字面量【定义形态】（赋值/常量定义 = '••••••••' 零命中；UI 文案/
//     注释中展示性 ••••••••——如点5 JSON 注释行「已存密钥以 •••••••• 脱敏显示」——不属定义、
//     不算命中）且 src/shared/mcp-json.ts 中 '••••••••'（带引号字面）恰 1 处（唯一字面定义；
//     主进程 mcp-config.ts:MCP_MASK_SENTINEL 为 shared MCP_VALUE_MASK 的 re-export，两名字
//     一常量）。点6 RED：O1/O2/O3 因副本仍在而 FAIL；实现后全 PASS。同点 H6 改写（编排器
//     裁定）：原钉渲染层值级清洗副本的存在性，副本删除后改钉「解析走桥 + 副本定义零出现 +
//     透传负向保留」，详见 H6 处注释。
//   P 保存位置联动组（2026-10-29 mcp-scope-misplacement-fix P1-A，R1/R2/H3）：McpSettings.vue
//     保存位置三态与入口 rail 联动的静态源码钉（沿 H/L/M/N 组读源码先例）——P1 openAdd 保存
//     位置三态无条件随入口 rail 联动（activeScope 取值 + project/user·managed 双分支赋值，联动
//     赋值在 resetForm() 之后防 clobber，且不受 formHasContent 门控——负向钉去注释后判定）；
//     P2 resetForm 去除 projectDirs[0] 预填（恰含一次 formProjectDir.value = '' 且不再含
//     projectDirs.value[0]）；P3 保存位置段位锁定恒态（2026-10-29 mcp-import-scope-and-segment-lock
//     改动点 C 改写，见下）：LOCATION_ORDER 三段按钮退化为只读指示——无 @click/switchLocation
//     绑定、静态 disabled（无 :disabled= 动态形态）、全文件 switchLocation 零出现（含原「编辑态
//     锁定」历史语义并入：编辑态与新建态均锁定）；
//     P4 新增态哨兵 KV 行拦截（2026-10-29 mcp-scope-misplacement-fix P1-B，H1；V2 载体分化）：
//     saveForm 函数体含「检测到残留的加密占位值」拦截（V2：JSON 模式走 jsonError 红条
//     「表单校验未通过：」前缀 + return 停留 JSON 侧，与 N9/N11 停留契约统一；表单模式走
//     toast + return）两种载体共用模块级常量 SENTINEL_BLOCK_MSG（防双处字面漂移）+
//     !isEditMode.value 门控 + 值 === MCP_VALUE_MASK 行判定，且提示载体位置先于落盘链起点
//     saving.value = true；P5（2026-10-29
//     mcp-scope-misplacement-fix P3-A，H5）：MCP_WRITE_SCOPED 白名单拒绝文案钉——ipc-handlers.ts
//     拒绝错误为含 ${MAX_ENTRIES} 插值的模板串（补「最近工作区上限」说明），MAX_ENTRIES 经
//     workspace-history import 引入，旧文案整串（三种引号形态）零出现；
//     P6 导入作用域跟随栏位（2026-10-29 mcp-import-scope-and-segment-lock 改动点 C 新增，
//     计划 §3.B）：confirmImport 切片含 writeMcpScoped 调用 + importTargetList.value 消费 +
//     activeProjectDir.value === null 前置判定 + overwrote 覆盖计数；预览/确认切片旧形态
//     analyzeImportText(importText.value, managedServers.value) 零出现（第二参改传
//     importTargetList.value）；模板区含「将导入到：」三形态目标位置文案（管理（全局生效）/
//     用户级 ~/.claude.json / 项目级 .mcp.json）。
//     点 RED：P1/P2/P3 因新代码未落地而 FAIL；实现后全 PASS。
//     P3 改写 RED（2026-10-29 改动点 C）：旧实现仍带 @click="switchLocation(loc)" + 动态
//     :disabled 且 switchLocation 全文件在场 → P3 FAIL；P6 RED：现状 confirmImport 恒
//     persistManaged 写管理库、预览第二参恒 managedServers.value、弹窗无目标位置文案 → P6 FAIL。
//     P3/P6 对应的 McpSettings.vue 实现（改动点 A/B）落地后应转 GREEN；本组最终口径为全 pass
//     / 0 fail（P6 新增后本文件 check 总数 100 → 101，GREEN 时 101 pass / 0 fail）。
//   Q MCP 探活扩展用户级/项目级组（2026-10-29 mcp-probe-all-scopes-plan 点 p1：RED 钉先行）：
//     MCP_PROBE 三作用域取源（计划 §1.A）与 UI 测试入口放开（计划 §1.B）的静态源码钉（沿
//     H/L/M/N/O/P 组读源码先例）——
//     Q1 handler 钉（ipc-handlers.ts）：MCP_PROBE 切片（IPC_CHANNELS.MCP_PROBE 注册行 →
//     MCP_WRITE_SCOPED 注册行）含 target === 'scoped' 分支；取源区域（handler 切片 ∪
//     resolveProbeSource 辅助函数体——计划 §1.A.2 新增内部辅助，定义形态 function/const/
//     async function 兼容）消费 readUserMcpServersRawSync( / readProjectMcpServersRawSync(
//    （user/project 从磁盘 raw 取明文）、mcpProbeKey( 调用含 scope 实参与 normalizeDirKey(
//     dirKey 实参（第二实参内联 normalizeDirKey( 形态，计划 §1.A.2 cacheKey 形态）、project
//     白名单（mergeProjectDirs + normalizeDirKey 在取源路径）、badDirCacheHas( 前置于 project
//     读盘（计划 §1.A.4 防慢目录）；
//     Q2 UI 钉（McpSettings.vue）：①卡片操作区（row__acts → </section>）内「测试连接」按钮
//    （handleProbe(card) 点击绑定）不再被「仅管理库」<template v-if="activeScope.kind ===
//     'managed'"> 先行限定——按钮上移三作用域共用区（门在按钮之后/门消失）或 managed/else 两
//     分支各渲染一枚均可；旧限定注释「仍仅管理库」全文件零出现；handleProbe 切片含 scope 实参
//    （scope/dir 由 card.key 前缀与 activeScope 推导，计划 §1.B.1）；②probeAllInView 切片按
//     activeScope 分流，含 target:'scoped' + scope:'user' + scope:'project' 形态（managed 栏
//     target:'all' 现状保留，计划 §1.B.2）；③saveScopedForm 成功块（writeMcpScoped await →
//     } catch 之间）含 probeMcpServers({ target:'single' … scope … }) 现探刷新（计划 §1.B.3）；
//     Q3 负向现状钉（本点即 PASS，防后续误改）：all 分支（req.target !== 'all' 校验行起，至
//     handler 切片收尾或楔入其中的 resolveProbeSource 定义处止）仍只遍历 getConfig().mcpServers
//     ——user/project raw 读取与 'scoped' 分支零混入（计划 §1.A.3「target:'all' 保持现状」）。
//     点 p1 RED 预期：Q1/Q2 因 scoped 分支、raw 消费、UI 放开形态未落地而 FAIL，Q3 PASS，
//     其余既有 101 钉全 pass（整体 102 pass / 2 fail、退出码 1）；下一实现点落地后 104 pass /
//     0 fail（本文件 check 总数 101 → 104）。RED 窗口内本脚本已在 selftest-static-list 清单
//    （第 234 行）中，selftest:static 会随本脚本红——属钉先行预期，由实现点转绿。
//     Q4（round-001 review 修复钉，2026-10-29 fix-probe 点；①语义 2026-10-29 review round-4
//     F1 反转改写——sse 中性门拆除，sse 卡回归 'probe' 与其他 transport 同权可测）：四项修复的
//     落位形态钉——①connModeOf sse 中性门零出现（反转钉：connModeOf 切片不含任何
//     card.transport === 'sse' 返回门——无限定形与旧 managed∧sse 合取形均零出现，旧形全文件
//     查；ConnMode 类型行不含 'sse' 成员；「会话内自动协商」「SSE 传输暂不支持探测」文案全
//     文件零出现）；②probeAllInView scoped 回写
//     竞态闭环（P2-2：dispatchAt 捕获 + dropOwnPrefix fresh 保留 probedAt > dispatchAt + 回填
//     probedAt 仲裁 prev.probedAt <= r.probedAt）；③confirmImport 覆盖同名条目补 single 现探
//    （m4：切片含 target: 'single'）；④渲染层 cast 收口（m3：全文件 claude.probeMcpServers as
//     零出现，载荷契约镜像上移 preload McpProbeTarget）。修复 RED：Q4 因四形态未齐 FAIL（既有
//     104 全 pass，整体 104 pass / 1 fail）；实现落地后 105 pass / 0 fail（check 总数 104 → 105）。
//     round-4 F1 改写窗口（2026-10-29）：sse 门拆除前 Q4 因门/成员/文案残留 FAIL（105 pass /
//     1 fail，退出码 1）；McpSettings.vue 拆门后 106 pass / 0 fail。
//     Q4b（round-002 复审备忘-2 负向现状钉，2026-10-29，本点即 PASS 沿 Q3 先例）：probeAllInView
//     managed 分支切片（函数体起点 → scoped 分界，取 scoped 首行代码 scope.kind === 'user'
//     首现处止）保持无仲裁回填形态——prev.probedAt / probedAt <= 仲裁形零出现 +
//     next[r.key] = r; 现状回填在位（计划硬约束「管理库探活行为零变化」）；check 总数 105 → 106。
//
// RED 阶段预期（p9a，B/C/D 组函数为 P2 桩、E 组函数为 P5 桩，桩体一律 throw
// not implemented）：A 组全 PASS，B/C/D/E 组全 FAIL（失败详情为「调用抛错：not
// implemented: …」）。P2/P5 实现后应全 PASS（GREEN）。R2 RED：G 组因
// clearMcpRawCache 未导出而 FAIL（调用抛错），实现后转 GREEN。
// 点1 RED（2026-10-19）：J1/J3/J4/J5/J7 因 timeoutMs 透传与 resolveProbeTimeoutMs 未实现而
// FAIL；J6 为防漏钉（实现前即 PASS——toSdkMcpServerConfig 本就不输出该键），A-I 组保持全 PASS。
//
// 退出码约定：任一断言 FAIL → 1；全 PASS → 末行打印 `selftest-mcp-settings: OK`，退出码 0。
// 运行：npx tsx scripts/selftest-mcp-settings.ts
// 清单注意：p9a（RED）阶段本文件【不】追加进 scripts/selftest-static-list.txt（避免红脚本
// 进入 T2 链）；p9b 转绿验收后由 p9b 追加。

import {
  sanitizeMcpServersConfig,
  sanitizeMcpOverridesConfig,
  parseMcpServersJson,
  toSdkMcpServerConfig,
  mergeMcpServersForSession,
  buildMcpServersExportJson,
  MCP_MASK_SENTINEL,
  maskMcpServersForRenderer,
  restoreMaskedMcpServers,
  type McpManagedSaveEntry,
  type ParsedMcpEntry,
} from '../src/main/modules/mcp/mcp-config';
import {
  buildSessionMcpOverridesForPin,
  parseSessionMcpOverrides,
  mergeMcpServersIntoSettings,
} from '../src/main/modules/mcp/sdk-mcp';
import { clearMcpRawCache, collectMcpSnapshot, readUserMcpServersRawSync } from '../src/main/modules/mcp/mcp-scanner';
// K 组（2026-10-19 mcp-settings-plan-a 点2）被测函数：单服务器导出 JSON 纯函数
//（shared 纯 TS 模块：renderer/main 两用，严禁 import electron 与 node 内置）。
import { buildSingleServerExportJson } from '../src/shared/mcp-json';
// J5（timeoutMs 点1）被测函数：探活生效超时解析（纯 node 模块，仅 import node:child_process）。
import { resolveProbeTimeoutMs } from '../src/main/modules/mcp/mcp-probe';
// E3g/E3h（B-1 默认 io 坏目录负缓存，2026-10-16）被测依赖：与 Skill/快照链同实例的共享负缓存。
import { badDirCacheHas, badDirCacheMark } from '../src/main/modules/project-skills';
// I8（2026-10-29 B-M1）项目级 override 键构造：与生产链同口径的目录归一键（shared 纯函数）。
import { normalizeDirKey } from '../src/shared/project-skills';
// D-V1-1 注入挂载组（I 组）被测函数：核心 options 工厂（仅类型 import，纯 node 可直接 import）。
import { buildNativeSdkOptionsCore } from '../src/main/modules/sdk-command-options';
import type { AppConfig, McpManagedServer } from '../src/shared/types/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let pass = 0;
let fail = 0;
function check(no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 键序不敏感的结构相等（canonical 序列化：对象键排序后比较；数组保序）。 */
function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`).join(',')}}`;
}
function eq(a: unknown, b: unknown): boolean {
  return canon(a) === canon(b);
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type CallResult<T> = { ok: true; value: T } | { ok: false; error: Error };
/** 安全调用：桩 throw not implemented（或 GREEN 阶段的任何异常）→ 记为该子断言失败而非脚本崩溃。 */
function call<T>(fn: () => T): CallResult<T> {
  try { return { ok: true, value: fn() }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e : new Error(String(e)) }; }
}
/** call 失败分支的详情文案（RED 阶段即「not implemented: …」证据行）。 */
function throwDetail(r: { ok: false; error: Error }): string {
  return `调用抛错：${r.error.message}（桩未实现，RED 预期）`;
}

/** 构造合法 McpManagedServer（sanitize/merge 输入用）。 */
let managedSeq = 0;
function mkManaged(name: string, transport: 'stdio' | 'http' | 'sse', extra: Partial<McpManagedServer> = {}): McpManagedServer {
  managedSeq += 1;
  return { id: `id-${managedSeq}`, name, description: '', transport, createdAt: 1700000000000, updatedAt: 1700000000000, ...extra };
}

/** mergeMcpServersIntoSettings 的 io 注入 stub（内存表，确定性；绝不读真实 ~/.claude.json）。 */
type MergeIo = {
  readUser: () => Record<string, ParsedMcpEntry>;
  readProject: (dir: string) => Record<string, ParsedMcpEntry>;
};
const ioOf = (user: Record<string, ParsedMcpEntry>): MergeIo => ({
  readUser: () => user,
  readProject: () => ({}),
});
const EMPTY_PROJECT: Record<string, ParsedMcpEntry> = {};
/** 以空 out（或 seed 播种的副本）调 mergeMcpServersIntoSettings，返回调用后的 out（或抛错）。 */
function mergeCall(
  config: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'>,
  sessionRow: { mcpOverrides: Record<string, 'off'> | null; workingDir?: string | null } | null,
  io: MergeIo,
  seed?: Record<string, unknown>,
): CallResult<Record<string, unknown>> {
  const out: Record<string, unknown> = seed ? { ...seed } : {};
  try {
    mergeMcpServersIntoSettings(out, config, sessionRow, null, io);
    return { ok: true, value: out };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

/**
 * mergeCall 的带返回值版（I4/I5/I7 专用，E3* 既有断言所用 mergeCall 原样不动）：同时返回
 * mergeMcpServersIntoSettings 的新返回值 { overridesHitExisting }（H2 收紧口径的 strict 门控
 * 信号）与调用后的 out。workingDir 直传入参（I7 跨目录场景需非 null 的 projectDirKey）。
 * result 以可选链消费：RED 阶段（函数尚返回 void）result 为 undefined，断言走 FAIL 分支不崩脚本。
 */
function mergeCallWithResult(
  config: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'>,
  sessionRow: { mcpOverrides: Record<string, 'off'> | null; workingDir?: string | null } | null,
  io: MergeIo,
  workingDir: string | null,
  seed?: Record<string, unknown>,
): CallResult<{ out: Record<string, unknown>; result?: { overridesHitExisting: boolean } }> {
  const out: Record<string, unknown> = seed ? { ...seed } : {};
  try {
    const result = mergeMcpServersIntoSettings(out, config, sessionRow, workingDir, io);
    return { ok: true, value: { out, result } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

// ── A. sanitize 组（P1 已实现——RED 阶段基线，应全 PASS）─────────────────────

console.log('\n=== A. sanitize 组（sanitizeMcpServersConfig / sanitizeMcpOverridesConfig） ===');

// A1 合法条目逐字段保留（stdio 全字段 / http 带 headers / sse 无 headers）。
{
  const sub: string[] = [];
  const input = [
    { id: 'id-1', name: 'alpha', description: '第一台', transport: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { A: '1' }, createdAt: 100, updatedAt: 200 },
    { id: 'id-2', name: 'beta', description: '', transport: 'http', url: 'https://e/mcp', headers: { 'X-A': '1' }, createdAt: 100, updatedAt: 200 },
    { id: 'id-3', name: 'gamma', description: '', transport: 'sse', url: 'https://e/sse', createdAt: 100, updatedAt: 200 },
  ];
  const out = sanitizeMcpServersConfig(input);
  if (out.length !== 3) sub.push(`应保留 3 条，得到 ${out.length}`);
  if (!eq(out[0], { id: 'id-1', name: 'alpha', description: '第一台', transport: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { A: '1' }, createdAt: 100, updatedAt: 200 })) sub.push(`alpha 应逐字段保留：${canon(out[0])}`);
  if (!eq(out[1], { id: 'id-2', name: 'beta', description: '', transport: 'http', url: 'https://e/mcp', headers: { 'X-A': '1' }, createdAt: 100, updatedAt: 200 })) sub.push(`beta 应逐字段保留：${canon(out[1])}`);
  if (!eq(out[2], { id: 'id-3', name: 'gamma', description: '', transport: 'sse', url: 'https://e/sse', createdAt: 100, updatedAt: 200 })) sub.push(`gamma 应逐字段保留：${canon(out[2])}`);
  check('A1', 'sanitize：合法 stdio/http/sse 条目逐字段保留', sub.length === 0, sub.join('; '));
}

// A2 非法 name（中文/空格/斜杠/超 64/空）丢弃；64 字符合法边界保留。
{
  const sub: string[] = [];
  const badNames = ['服务器', 'my server', 'a/b', 'a'.repeat(65), ''];
  const badInput = badNames.map((n, i) => ({ id: `id-${i}`, name: n, transport: 'stdio', command: 'c' }));
  if (sanitizeMcpServersConfig(badInput).length !== 0) sub.push('中文/空格/斜杠/超64/空 name 均应丢弃');
  const edge = sanitizeMcpServersConfig([{ id: 'id-e', name: 'a'.repeat(64), transport: 'stdio', command: 'c' }]);
  if (edge.length !== 1) sub.push('64 字符 name（合法上界）应保留');
  check('A2', 'sanitize：非法 name（中文/空格/斜杠/超64/空）丢弃；64 字符边界保留', sub.length === 0, sub.join('; '));
}

// A3 重名保留第一条。
{
  const sub: string[] = [];
  const out = sanitizeMcpServersConfig([
    { id: 'first', name: 'dup', transport: 'stdio', command: 'c1' },
    { id: 'second', name: 'dup', transport: 'stdio', command: 'c2' },
  ]);
  if (out.length !== 1) sub.push(`重名应只保留 1 条，得到 ${out.length}`);
  else if (out[0].id !== 'first' || out[0].command !== 'c1') sub.push(`应保留第一条（id=first, command=c1）：${canon(out[0])}`);
  check('A3', 'sanitize：name 重复 → 保留第一条', sub.length === 0, sub.join('; '));
}

// A4 字段互斥归一（stdio 带 url/headers → 丢；http/sse 带 command/args/env → 丢）。
{
  const sub: string[] = [];
  const stdio = sanitizeMcpServersConfig([{ id: 's', name: 's1', transport: 'stdio', command: 'c', url: 'https://x', headers: { H: '1' } }])[0];
  if (!stdio || !('command' in stdio) || 'url' in stdio || 'headers' in stdio) sub.push('stdio 带 url/headers → url/headers 应被丢、command 保留');
  const http = sanitizeMcpServersConfig([{ id: 'h', name: 'h1', transport: 'http', url: 'https://x', command: 'c', args: ['a'], env: { E: '1' } }])[0];
  if (!http || !('url' in http) || 'command' in http || 'args' in http || 'env' in http) sub.push('http 带 command/args/env → command/args/env 应被丢、url 保留');
  check('A4', 'sanitize：字段互斥归一（stdio 丢 url/headers；http/sse 丢 command/args/env）', sub.length === 0, sub.join('; '));
}

// A5 transport 与必填不匹配 → 整条丢弃（空串同「无」）。
{
  const sub: string[] = [];
  const out = sanitizeMcpServersConfig([
    { id: 'a', name: 'n1', transport: 'stdio' },
    { id: 'b', name: 'n2', transport: 'stdio', command: '' },
    { id: 'c', name: 'n3', transport: 'http' },
    { id: 'd', name: 'n4', transport: 'sse', url: '' },
  ]);
  if (out.length !== 0) sub.push(`stdio 无 command / http·sse 无 url 均应丢弃，得到 ${out.length} 条`);
  check('A5', 'sanitize：transport 与必填不匹配（含空串）→ 整条丢弃', sub.length === 0, sub.join('; '));
}

// A6 时间戳非数字/缺失 → Date.now() 兜底。
{
  const sub: string[] = [];
  const before = Date.now();
  const out = sanitizeMcpServersConfig([
    { id: 'a', name: 't1', transport: 'stdio', command: 'c', createdAt: 'x', updatedAt: Number.NaN },
    { id: 'b', name: 't2', transport: 'http', url: 'https://u' },
  ]);
  const after = Date.now();
  for (const s of out) {
    for (const key of ['createdAt', 'updatedAt'] as const) {
      const v = s[key];
      if (!(typeof v === 'number' && Number.isFinite(v) && v >= before && v <= after)) sub.push(`${s.name}.${key} 应兜底为调用时刻 Date.now()：${String(v)}`);
    }
  }
  check('A6', 'sanitize：时间戳非数字（\'x\'/NaN/缺失）→ Date.now() 兜底', sub.length === 0, sub.join('; '));
}

// A7 非数组输入（undefined/null/标量/对象）→ []。
{
  const sub: string[] = [];
  for (const dirty of [undefined, null, 'x', 42, { a: 1 }] as unknown[]) {
    if (sanitizeMcpServersConfig(dirty).length !== 0) sub.push(`sanitize(${String(dirty)}) → 应为 []`);
  }
  check('A7', 'sanitize：undefined/null/标量/对象 → []（旧配置缺键不报错）', sub.length === 0, sub.join('; '));
}

// A8 override 脏值清洗 + Object.create(null) 载体（__proto__ 原型安全）。
{
  const sub: string[] = [];
  for (const dirty of [null, undefined, 'x', 42, [1]] as unknown[]) {
    if (!eq(sanitizeMcpOverridesConfig(dirty), {})) sub.push(`sanitizeMcpOverridesConfig(${String(dirty)}) → 应为 {}`);
  }
  if (!eq(sanitizeMcpOverridesConfig({ a: 'off', b: 'on', c: 1, d: null, e: { f: 'off' } }), { a: 'off' })) sub.push('仅值==="off" 的 string 键条目应保留');
  const plain = sanitizeMcpOverridesConfig({ a: 'off' });
  if (Object.getPrototypeOf(plain) !== null) sub.push('输出载体应为 Object.create(null)（null 原型，防 __proto__/constructor 污染）');
  // __proto__ 自有键输入（JSON.parse 可产出）：不抛错、载体仍 null 原型、合法键保留、不污染 Object.prototype。
  const dirty = JSON.parse('{"__proto__":"off","k":"off"}') as Record<string, unknown>;
  const pollutedProbe = {} as Record<string, unknown>;
  let out2: Record<string, 'off'> | null = null;
  try { out2 = sanitizeMcpOverridesConfig(dirty); } catch (e) { sub.push(`__proto__ 键输入抛错：${errMsg(e)}`); }
  if (out2) {
    if (Object.getPrototypeOf(out2) !== null) sub.push('__proto__ 键输入：输出载体仍应为 null 原型');
    if (!Object.prototype.hasOwnProperty.call(out2, 'k') || out2.k !== 'off') sub.push('__proto__ 键输入：合法键 k 应保留为 "off"');
  }
  if (pollutedProbe.k !== undefined) sub.push('Object.prototype 被污染（不应发生）');
  check('A8', 'sanitizeOverrides：非对象→{}；值非 "off" 丢弃；null 原型载体 + __proto__ 键不污染', sub.length === 0, sub.join('; '));
}

// A9 env/headers 值级清洗（R1）：值非 string（number/boolean/null/对象/数组）→ 仅丢该键；
// string 值保留（键序保持）；空串 '' 是合法 string 保留；全合法 env/headers 原样保留不回归。
{
  const sub: string[] = [];
  // a+c（混合法与非法）：env {A:'x',N:123,B:null,C:{}} → 仅 {A:'x'}；headers 同款 → 仅留 string。
  const mixedStdio = sanitizeMcpServersConfig([{ id: 'v1', name: 'v1', transport: 'stdio', command: 'c', env: { A: 'x', N: 123, B: null, C: {} } }])[0];
  if (!mixedStdio) sub.push('env 混合法/非法：stdio 条目本身不应被丢弃');
  else if (!eq(mixedStdio.env, { A: 'x' })) sub.push(`env 应仅保留 string 值 {A:'x'}：${canon(mixedStdio.env)}`);
  const mixedHttp = sanitizeMcpServersConfig([{ id: 'v2', name: 'v2', transport: 'http', url: 'https://x/mcp', headers: { H: 'v', N: 123, B: null, C: {} } }])[0];
  if (!mixedHttp) sub.push('headers 混合法/非法：http 条目本身不应被丢弃');
  else if (!eq(mixedHttp.headers, { H: 'v' })) sub.push(`headers 应仅保留 string 值 {H:'v'}：${canon(mixedHttp.headers)}`);
  // d（合法条目不回归）：env:{A:'x',B:'y'} / headers:{h:'v'} 原样保留。
  const legalStdio = sanitizeMcpServersConfig([{ id: 'v3', name: 'v3', transport: 'stdio', command: 'c', env: { A: 'x', B: 'y' } }])[0];
  if (!legalStdio || !eq(legalStdio.env, { A: 'x', B: 'y' })) sub.push(`全合法 env 应原样保留 {A:'x',B:'y'}：${legalStdio ? canon(legalStdio.env) : '条目丢失'}`);
  const legalHttp = sanitizeMcpServersConfig([{ id: 'v4', name: 'v4', transport: 'http', url: 'https://x/mcp', headers: { h: 'v' } }])[0];
  if (!legalHttp || !eq(legalHttp.headers, { h: 'v' })) sub.push(`全合法 headers 应原样保留 {h:'v'}：${legalHttp ? canon(legalHttp.headers) : '条目丢失'}`);
  // e（空串值边界）：'' 是合法 string，保留。
  const emptyStr = sanitizeMcpServersConfig([{ id: 'v5', name: 'v5', transport: 'stdio', command: 'c', env: { E: '', A: 'x' } }])[0];
  if (!emptyStr || !eq(emptyStr.env, { E: '', A: 'x' })) sub.push(`空串值 '' 是合法 string 应保留：${emptyStr ? canon(emptyStr.env) : '条目丢失'}`);
  check('A9', 'sanitize：env/headers 值级清洗——非 string 值仅丢该键，string（含空串）保留，全合法原样', sub.length === 0, sub.join('; '));
}

// A10 env/headers 值全部非法 → 该字段整体消失（不输出空对象）；条目本身不丢。
{
  const sub: string[] = [];
  const stdio = sanitizeMcpServersConfig([{ id: 'v6', name: 'v6', transport: 'stdio', command: 'c', env: { N: 1, B: null } }])[0];
  if (!stdio) sub.push('env 全非法：stdio 条目本身应保留');
  else if ('env' in stdio) sub.push(`env 全非法值 → env 字段应消失（不得是空对象）：${canon(stdio.env)}`);
  const http = sanitizeMcpServersConfig([{ id: 'v7', name: 'v7', transport: 'http', url: 'https://x/mcp', headers: { N: 1, B: null } }])[0];
  if (!http) sub.push('headers 全非法：http 条目本身应保留');
  else if ('headers' in http) sub.push(`headers 全非法值 → headers 字段应消失（不得是空对象）：${canon(http.headers)}`);
  check('A10', 'sanitize：env/headers 全部值非法 → 字段消失（非空对象），条目保留', sub.length === 0, sub.join('; '));
}

// ── B. parseMcpServersJson 组（P2 桩——RED 阶段按 not implemented 转 FAIL）──

console.log('\n=== B. parseMcpServersJson 组（三形态 / transport 判定 / 失败形态） ===');

// B1 三种导入形态。
{
  const sub: string[] = [];
  const r1 = call(() => parseMcpServersJson(JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'mcp-fs'] } } })));
  if (!r1.ok) sub.push(`形态① {"mcpServers":{...}}：${throwDetail(r1)}`);
  else if (!r1.value.ok) sub.push(`形态① 应 ok:true：${r1.value.error}`);
  else {
    const e = r1.value.servers[0];
    if (r1.value.servers.length !== 1 || !e || e.name !== 'fs' || e.transport !== 'stdio' || e.command !== 'npx' || !eq(e.args, ['-y', 'mcp-fs'])) sub.push(`形态① 条目不符：${canon(r1.value.servers)}`);
  }
  const r2 = call(() => parseMcpServersJson(JSON.stringify({ git: { url: 'https://x/mcp' } })));
  if (!r2.ok) sub.push(`形态② 裸 map：${throwDetail(r2)}`);
  else if (!r2.value.ok) sub.push(`形态② 应 ok:true：${r2.value.error}`);
  else {
    const e = r2.value.servers[0];
    if (r2.value.servers.length !== 1 || !e || e.name !== 'git' || e.transport !== 'http' || e.url !== 'https://x/mcp') sub.push(`形态② 条目不符：${canon(r2.value.servers)}`);
  }
  const r3 = call(() => parseMcpServersJson(JSON.stringify({ servers: { vs: { url: 'https://x/sse' } } })));
  if (!r3.ok) sub.push(`形态③ {"servers":{...}}：${throwDetail(r3)}`);
  else if (!r3.value.ok) sub.push(`形态③ 应 ok:true：${r3.value.error}`);
  else {
    const e = r3.value.servers[0];
    if (r3.value.servers.length !== 1 || !e || e.name !== 'vs' || e.transport !== 'sse') sub.push(`形态③ 条目不符：${canon(r3.value.servers)}`);
  }
  check('B1', '三形态：{"mcpServers"} / 裸 map / {"servers"} 均可解析且 name 取 map 键', sub.length === 0, sub.join('; '));
}

// B2 transport 判定（显式 type 优先，streamable-http→http；无 type：command→stdio，url /sse 后缀→sse 否则 http）。
{
  const sub: string[] = [];
  const cases: Array<{ label: string; key: string; cfg: Record<string, unknown>; want: 'stdio' | 'http' | 'sse' }> = [
    { label: '显式 type streamable-http → http（优先于 /sse 后缀）', key: 't1', cfg: { type: 'streamable-http', url: 'https://x/sse' }, want: 'http' },
    { label: '显式 type sse', key: 't2', cfg: { type: 'sse', url: 'https://x/rpc' }, want: 'sse' },
    { label: '显式 type http', key: 't3', cfg: { type: 'http', url: 'https://x/mcp' }, want: 'http' },
    { label: '显式 type stdio 优先（带 url 也判 stdio）', key: 't4', cfg: { type: 'stdio', command: 'npx', url: 'https://x/sse' }, want: 'stdio' },
    { label: '无 type 有 command → stdio（优先于 url）', key: 't5', cfg: { command: 'uvx', url: 'https://x/sse' }, want: 'stdio' },
    { label: '无 type url 以 /sse 结尾 → sse', key: 't6', cfg: { url: 'https://x/sse' }, want: 'sse' },
    { label: '无 type url 非 /sse → http', key: 't7', cfg: { url: 'https://x/mcp' }, want: 'http' },
  ];
  for (const c of cases) {
    const r = call(() => parseMcpServersJson(JSON.stringify({ [c.key]: c.cfg })));
    if (!r.ok) { sub.push(`${c.label}：${throwDetail(r)}`); continue; }
    if (!r.value.ok) { sub.push(`${c.label}：应 ok:true，得到 ok:false（${r.value.error}）`); continue; }
    const e = r.value.servers[0];
    if (!e || e.name !== c.key || e.transport !== c.want) sub.push(`${c.label}：实际 ${e ? `${e.name}/${e.transport}` : '空'}`);
  }
  check('B2', 'transport 判定：显式 type 优先（streamable-http→http）；command→stdio；url /sse 后缀→sse 否则 http', sub.length === 0, sub.join('; '));
}

// B3 失败形态 → ok:false + 非空中文 error。
{
  const sub: string[] = [];
  const badCases: Array<{ label: string; text: string }> = [
    { label: '坏 JSON', text: '{not-json' },
    { label: '根为数组', text: '[1,2]' },
    { label: '根为字符串', text: '"str"' },
    { label: '根为 null', text: 'null' },
    { label: 'servers 非对象', text: JSON.stringify({ mcpServers: 'oops' }) },
  ];
  for (const c of badCases) {
    const r = call(() => parseMcpServersJson(c.text));
    if (!r.ok) { sub.push(`${c.label}：${throwDetail(r)}`); continue; }
    if (r.value.ok) { sub.push(`${c.label}：应 ok:false`); continue; }
    if (typeof r.value.error !== 'string' || r.value.error.length === 0 || !/[\u4e00-\u9fff]/.test(r.value.error)) sub.push(`${c.label}：error 应为非空中文消息：${canon(r.value.error)}`);
  }
  check('B3', '失败形态（坏 JSON/根非对象/servers 非对象）→ ok:false 且中文 error', sub.length === 0, sub.join('; '));
}

// ── C. toSdkMcpServerConfig 组（P2 桩——RED 阶段同上）────────────────────────

console.log('\n=== C. toSdkMcpServerConfig 组（stdio/http/sse 三形） ===');

// C1 stdio 全字段透传。
{
  const r = call(() => toSdkMcpServerConfig({ transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' } }));
  const sub: string[] = [];
  if (!r.ok) sub.push(throwDetail(r));
  else if (!eq(r.value, { type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' } })) sub.push(`stdio 形不符：${canon(r.value)}`);
  check('C1', 'stdio 形：type/command/args/env 透传', sub.length === 0, sub.join('; '));
}

// C2 stdio：env 未提供/空对象 → env 键省略。
{
  const sub: string[] = [];
  const r1 = call(() => toSdkMcpServerConfig({ transport: 'stdio', command: 'npx' }));
  if (!r1.ok) sub.push(`env 未提供：${throwDetail(r1)}`);
  else if (!eq(r1.value, { type: 'stdio', command: 'npx' }) || 'env' in r1.value) sub.push(`env 未提供时应省略 env 键：${canon(r1.value)}`);
  const r2 = call(() => toSdkMcpServerConfig({ transport: 'stdio', command: 'npx', env: {} }));
  if (!r2.ok) sub.push(`env 为 {}：${throwDetail(r2)}`);
  else if (!eq(r2.value, { type: 'stdio', command: 'npx' }) || 'env' in r2.value) sub.push(`env 为空对象时应省略 env 键：${canon(r2.value)}`);
  check('C2', 'stdio 形：env 未提供/空对象 → env 键省略', sub.length === 0, sub.join('; '));
}

// C3 http 形。
{
  const r = call(() => toSdkMcpServerConfig({ transport: 'http', url: 'https://e/mcp', headers: { Authorization: 'Bearer t' } }));
  const sub: string[] = [];
  if (!r.ok) sub.push(throwDetail(r));
  else if (!eq(r.value, { type: 'http', url: 'https://e/mcp', headers: { Authorization: 'Bearer t' } })) sub.push(`http 形不符：${canon(r.value)}`);
  check('C3', 'http 形：type/url/headers 透传（headers key 不做大小写变换）', sub.length === 0, sub.join('; '));
}

// C4 sse 形：headers 未提供 → 键省略；提供 → 透传。
{
  const sub: string[] = [];
  const r1 = call(() => toSdkMcpServerConfig({ transport: 'sse', url: 'https://e/sse' }));
  if (!r1.ok) sub.push(`sse 无 headers：${throwDetail(r1)}`);
  else if (!eq(r1.value, { type: 'sse', url: 'https://e/sse' }) || 'headers' in r1.value) sub.push(`sse 无 headers 时应省略 headers 键：${canon(r1.value)}`);
  const r2 = call(() => toSdkMcpServerConfig({ transport: 'sse', url: 'https://e/sse2', headers: { H: 'v' } }));
  if (!r2.ok) sub.push(`sse 带 headers：${throwDetail(r2)}`);
  else if (!eq(r2.value, { type: 'sse', url: 'https://e/sse2', headers: { H: 'v' } })) sub.push(`sse 带 headers 应透传：${canon(r2.value)}`);
  check('C4', 'sse 形：headers 未提供 → 键省略；提供 → 透传', sub.length === 0, sub.join('; '));
}

// ── D. mergeMcpServersForSession 组（P2 桩——RED 阶段同上）───────────────────

console.log('\n=== D. mergeMcpServersForSession 组（三层合并 / override 禁用 / projectDirKey） ===');

// D1 同名覆盖顺序 managed > project > user（先放 user，再 project 覆盖，最后 managed 覆盖）。
{
  const sub: string[] = [];
  const r = call(() => mergeMcpServersForSession({
    managed: [mkManaged('srv', 'stdio', { command: 'managed-cmd' })],
    userServers: { srv: { name: 'srv', transport: 'http', url: 'https://user' }, u2: { name: 'u2', transport: 'http', url: 'https://user-u2' } },
    projectServers: { srv: { name: 'srv', transport: 'sse', url: 'https://project/sse' } },
    overrides: {},
    projectDirKey: 'd1',
  }));
  if (!r.ok) sub.push(throwDetail(r));
  else {
    if (!eq(r.value.srv, { type: 'stdio', command: 'managed-cmd' })) sub.push(`同名 srv 应取 managed 定义：${canon(r.value.srv)}`);
    if (!eq(r.value.u2, { type: 'http', url: 'https://user-u2' })) sub.push(`无同名 user 条目应保留：${canon(r.value.u2)}`);
  }
  check('D1', '三层合并同名覆盖顺序：managed > project > user', sub.length === 0, sub.join('; '));
}

// D2 override 禁用 user:/project:<dirKey>:/managed: 前缀键各自生效；值非 'off' 不禁用。
{
  const sub: string[] = [];
  const r = call(() => mergeMcpServersForSession({
    managed: [mkManaged('m1', 'stdio', { command: 'mc1' }), mkManaged('m2', 'stdio', { command: 'mc2' })],
    userServers: { u1: { name: 'u1', transport: 'http', url: 'https://user-u1' }, u2: { name: 'u2', transport: 'sse', url: 'https://user-u2/sse' } },
    projectServers: { p1: { name: 'p1', transport: 'sse', url: 'https://proj/sse' } },
    overrides: { 'user:u1': 'off', 'project:d1:p1': 'off', 'managed:m1': 'off' },
    projectDirKey: 'd1',
  }));
  if (!r.ok) sub.push(throwDetail(r));
  else if (!eq(Object.keys(r.value).sort(), ['m2', 'u2'])) sub.push(`被禁用的 u1/p1/m1 应缺席，仅剩 m2/u2：${canon(Object.keys(r.value).sort())}`);
  const r2 = call(() => mergeMcpServersForSession({
    managed: [],
    userServers: { u1: { name: 'u1', transport: 'http', url: 'https://user-u1' } },
    projectServers: {},
    overrides: { 'user:u1': 'on' } as unknown as Record<string, 'off'>,
    projectDirKey: 'd1',
  }));
  if (!r2.ok) sub.push(`值非 'off'：${throwDetail(r2)}`);
  else if (!eq(Object.keys(r2.value), ['u1'])) sub.push(`override 值非 'off'（'on'）不应禁用：${canon(Object.keys(r2.value))}`);
  check('D2', 'override 禁用：user:/project:<dirKey>:/managed: 前缀键各自生效；值非 "off" 不禁用', sub.length === 0, sub.join('; '));
}

// D3 projectDirKey=null → 项目级整体不参与（user/managed 照常）。
{
  const sub: string[] = [];
  const r = call(() => mergeMcpServersForSession({
    managed: [mkManaged('m1', 'stdio', { command: 'mc1' })],
    userServers: { u1: { name: 'u1', transport: 'http', url: 'https://user-u1' } },
    projectServers: { p1: { name: 'p1', transport: 'sse', url: 'https://proj/sse' } },
    overrides: {},
    projectDirKey: null,
  }));
  if (!r.ok) sub.push(throwDetail(r));
  else if (!eq(Object.keys(r.value).sort(), ['m1', 'u1'])) sub.push(`projectDirKey=null 时项目级 p1 应缺席，仅剩 m1/u1：${canon(Object.keys(r.value).sort())}`);
  check('D3', 'projectDirKey=null → 项目级整体不参与', sub.length === 0, sub.join('; '));
}

// D4 三层全空 → 结果 {}。
{
  const sub: string[] = [];
  const r = call(() => mergeMcpServersForSession({ managed: [], userServers: {}, projectServers: {}, overrides: {}, projectDirKey: 'd1' }));
  if (!r.ok) sub.push(throwDetail(r));
  else if (!eq(r.value, {}) || Object.keys(r.value).length !== 0) sub.push(`全空输入应得 {}：${canon(r.value)}`);
  check('D4', '三层全空 → 结果 {}（空配置不注入的源头）', sub.length === 0, sub.join('; '));
}

// D5 项目级 override 仅与 projectDirKey 一致的目录键生效（跨目录 override 不误伤）。
{
  const sub: string[] = [];
  const rKeep = call(() => mergeMcpServersForSession({
    managed: [],
    userServers: {},
    projectServers: { p1: { name: 'p1', transport: 'sse', url: 'https://proj/sse' } },
    overrides: { 'project:d2:p1': 'off' },
    projectDirKey: 'd1',
  }));
  if (!rKeep.ok) sub.push(`跨目录键：${throwDetail(rKeep)}`);
  else if (!eq(Object.keys(rKeep.value), ['p1'])) sub.push(`project:d2:p1（目录键 d2≠d1）不应禁用 p1：${canon(Object.keys(rKeep.value))}`);
  const rOff = call(() => mergeMcpServersForSession({
    managed: [],
    userServers: {},
    projectServers: { p1: { name: 'p1', transport: 'sse', url: 'https://proj/sse' } },
    overrides: { 'project:d1:p1': 'off' },
    projectDirKey: 'd1',
  }));
  if (!rOff.ok) sub.push(`同目录键：${throwDetail(rOff)}`);
  else if (Object.keys(rOff.value).length !== 0) sub.push(`project:d1:p1（目录键一致）应禁用 p1：${canon(Object.keys(rOff.value))}`);
  check('D5', '项目级 override 仅 projectDirKey 与来源目录键一致时生效（跨目录不误伤）', sub.length === 0, sub.join('; '));
}

// ── E. sdk-mcp 组（P5 桩——RED 阶段同上）─────────────────────────────────────

console.log('\n=== E. sdk-mcp 组（buildSessionMcpOverridesForPin / parseSessionMcpOverrides / mergeMcpServersIntoSettings） ===');

const M1_MANAGED = mkManaged('m1', 'stdio', { command: 'managed-m1-cmd' });
const M1_SDK = { type: 'stdio', command: 'managed-m1-cmd' };
const U1_ENTRY: ParsedMcpEntry = { name: 'u1', transport: 'http', url: 'https://user-u1' };
const U2_ENTRY: ParsedMcpEntry = { name: 'u2', transport: 'sse', url: 'https://user-u2/sse' };
const U1_SDK = { type: 'http', url: 'https://user-u1' };
const U2_SDK = { type: 'sse', url: 'https://user-u2/sse' };

// E1 buildSessionMcpOverridesForPin：空 → null（无需落库）；非空 → 原样。
{
  const sub: string[] = [];
  const r1 = call(() => buildSessionMcpOverridesForPin({}));
  if (!r1.ok) sub.push(`pin({})：${throwDetail(r1)}`);
  else if (r1.value !== null) sub.push(`pin({}) 应为 null：${canon(r1.value)}`);
  const r2 = call(() => buildSessionMcpOverridesForPin({ a: 'off' }));
  if (!r2.ok) sub.push(`pin({a:off})：${throwDetail(r2)}`);
  else if (!eq(r2.value, { a: 'off' })) sub.push(`pin({a:off}) 应原样：${canon(r2.value)}`);
  const r3 = call(() => buildSessionMcpOverridesForPin({ a: 'off', b: 'off' }));
  if (!r3.ok) sub.push(`pin({a,b})：${throwDetail(r3)}`);
  else if (!eq(r3.value, { a: 'off', b: 'off' })) sub.push(`pin({a:off,b:off}) 应原样：${canon(r3.value)}`);
  check('E1', 'buildSessionMcpOverridesForPin：{} → null；非空 → 原样返回', sub.length === 0, sub.join('; '));
}

// E2 parseSessionMcpOverrides：null/undefined/非对象/无合法条目 → null；合法 → 清洗副本。
// （注：raw 为 JSON 字符串时的行为此处不钉——p5 实现取「对象入参」或「string 兼容」皆可，
//   若做 string 兼容需回补本组断言。）
{
  const sub: string[] = [];
  const dirtyRaws: unknown[] = [null, undefined, 'x', 42, true, [1], { a: 'on' }, { a: 1 }, { a: null }, {}];
  for (const raw of dirtyRaws) {
    const r = call(() => parseSessionMcpOverrides(raw));
    if (!r.ok) { sub.push(`parse(${canon(raw)})：${throwDetail(r)}`); continue; }
    if (r.value !== null) sub.push(`parse(${canon(raw)}) 应为 null：${canon(r.value)}`);
  }
  const ok1 = call(() => parseSessionMcpOverrides({ a: 'off' }));
  if (!ok1.ok) sub.push(`parse({a:off})：${throwDetail(ok1)}`);
  else if (!eq(ok1.value, { a: 'off' })) sub.push(`parse({a:off}) 应等值：${canon(ok1.value)}`);
  const ok2 = call(() => parseSessionMcpOverrides({ a: 'off', b: 'on' }));
  if (!ok2.ok) sub.push(`parse({a:off,b:on})：${throwDetail(ok2)}`);
  else if (!eq(ok2.value, { a: 'off' })) sub.push(`parse({a:off,b:on}) 应仅保留合法键：${canon(ok2.value)}`);
  check('E2', 'parseSessionMcpOverrides：null/undefined/非对象/无合法条目 → null；合法 → 清洗副本', sub.length === 0, sub.join('; '));
}

// E3a 空配置 + io 返回空 → out 无 mcpServers 键且 JSON.stringify 逐字节相等。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [], mcpOverrides: {} };
  const out: Record<string, unknown> = { model: 'claude-x', permissions: { allow: ['Bash'] } };
  const before = JSON.stringify(out);
  // p5 申报修复：p9a 原稿 mergeCall 恒传全新空 out，本断言的播种 out（before 的来源）从未进
  // 被测函数，「字节级一致」子断言对任何合规实现恒假（'{}' ≠ before）。按计划 §5 T1 语义
  //（「输出对象无 mcpServers 键，字节级断言 JSON.stringify 相等」——输出对象=传入的 settings 块）
  // 经 mergeCall 新增可选 seed 参把播种 out 传入；断言本身一字未改。
  const r = mergeCall(cfg, null, ioOf(EMPTY_PROJECT), out);
  if (!r.ok) sub.push(throwDetail(r));
  else {
    if ('mcpServers' in r.value) sub.push('空配置不应写入 mcpServers 键');
    if (JSON.stringify(r.value) !== before) sub.push(`空配置 settings 块应字节级一致：${before} → ${JSON.stringify(r.value)}`);
  }
  check('E3a', '空配置 + io 空 → out 无 mcpServers 键且 JSON.stringify 逐字节相等', sub.length === 0, sub.join('; '));
}

// E3b 非空配置 → out.mcpServers 为预期合并结果（user + managed；io.readProject 空）。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [M1_MANAGED], mcpOverrides: {} };
  const r = mergeCall(cfg, null, ioOf({ u1: U1_ENTRY }));
  if (!r.ok) sub.push(throwDetail(r));
  else if (!('mcpServers' in r.value)) sub.push('非空合并结果应写入 out.mcpServers');
  else if (!eq(r.value.mcpServers, { u1: U1_SDK, m1: M1_SDK })) sub.push(`合并结果不符：${canon(r.value.mcpServers)}`);
  check('E3b', '非空配置 → out.mcpServers 含 user+managed 预期合并结果', sub.length === 0, sub.join('; '));
}

// E3c 会话钉住优先：sessionRow.mcpOverrides 非空时【取代】config.mcpOverrides（非并集）。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [M1_MANAGED], mcpOverrides: { 'user:u2': 'off' } };
  const row = { mcpOverrides: { 'user:u1': 'off' } as Record<string, 'off'> | null };
  const r = mergeCall(cfg, row, ioOf({ u1: U1_ENTRY, u2: U2_ENTRY }));
  if (!r.ok) sub.push(throwDetail(r));
  else if (!('mcpServers' in r.value)) sub.push('应仍有存活服务器可注入');
  else if (!eq(r.value.mcpServers, { u2: U2_SDK, m1: M1_SDK })) sub.push(`会话钉住应取代全局（u1 禁用、全局对 u2 的 off 被忽略）：${canon(r.value.mcpServers)}`);
  check('E3c', 'sessionRow.mcpOverrides 非空 → 取代 config.mcpOverrides（钉住值优先）', sub.length === 0, sub.join('; '));
}

// E3d sessionRow=null → 用 config.mcpOverrides。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [M1_MANAGED], mcpOverrides: { 'user:u1': 'off' } };
  const r = mergeCall(cfg, null, ioOf({ u1: U1_ENTRY, u2: U2_ENTRY }));
  if (!r.ok) sub.push(throwDetail(r));
  else if (!('mcpServers' in r.value)) sub.push('应仍有存活服务器可注入');
  else if (!eq(r.value.mcpServers, { u2: U2_SDK, m1: M1_SDK })) sub.push(`sessionRow=null 应用全局 override（u1 禁用）：${canon(r.value.mcpServers)}`);
  check('E3d', 'sessionRow=null → 用 config.mcpOverrides', sub.length === 0, sub.join('; '));
}

// E3e 存量会话（row 非 null 但 mcpOverrides=null）→ 回退当前全局 override（§3.14）。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [M1_MANAGED], mcpOverrides: { 'user:u1': 'off' } };
  const row = { mcpOverrides: null };
  const r = mergeCall(cfg, row, ioOf({ u1: U1_ENTRY, u2: U2_ENTRY }));
  if (!r.ok) sub.push(throwDetail(r));
  else if (!('mcpServers' in r.value)) sub.push('应仍有存活服务器可注入');
  else if (!eq(r.value.mcpServers, { u2: U2_SDK, m1: M1_SDK })) sub.push(`mcpOverrides=null 应回退全局（u1 禁用）：${canon(r.value.mcpServers)}`);
  check('E3e', '存量会话 mcpOverrides=null → 回退当前全局 mcpOverrides', sub.length === 0, sub.join('; '));
}

// E3f 会话钉住含已删除同名服务器键（幽灵键）→ 跳过不崩，其余照常注入（§3.8）。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [M1_MANAGED], mcpOverrides: {} };
  const row = { mcpOverrides: { 'user:ghost': 'off', 'managed:ghost': 'off', 'project:dead:ghost': 'off' } as Record<string, 'off'> };
  const r = mergeCall(cfg, row, ioOf({ u1: U1_ENTRY }));
  if (!r.ok) sub.push(`幽灵键应跳过不崩：${throwDetail(r)}`);
  else if (!('mcpServers' in r.value)) sub.push('幽灵键之外的服务器应照常注入');
  else if (!eq(r.value.mcpServers, { u1: U1_SDK, m1: M1_SDK })) sub.push(`幽灵键跳过后合并结果不符：${canon(r.value.mcpServers)}`);
  check('E3f', '会话钉住含已删除同名服务器键 → 跳过不崩，其余照常注入', sub.length === 0, sub.join('; '));
}

// E3g 默认 io 坏目录负缓存·项目级（B-1，2026-10-16）：不带 readUser/readProject 覆盖（默认实现）
// 调 mergeMcpServersIntoSettings——合法 .mcp.json → 项目层注入；badDirCacheMark(dir)（与 Skill/
// 快照链同实例的共享负缓存，60s TTL 无清理导出——每个 tmpdir 仅消费一次，finally 清理）后再调 →
// 项目层缺席（结果等价「目录无 .mcp.json」）；第二个全新 tmpdir 作不标记对照。
// io 仅注入 userHome 钉到临时空目录（生产同形态 effectiveUserHome()），readUser/readProject 均
// 走默认实现——绝不触真实 ~/.claude.json（本文件纪律）。
{
  const sub: string[] = [];
  const e3gDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-mcp-selftest-e3g-proj-'));
  const e3gCtrl = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-mcp-selftest-e3g-ctrl-'));
  const e3gHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-mcp-selftest-e3g-home-'));
  const e3gJson = JSON.stringify({ mcpServers: { p3g: { command: 'npx', args: ['-y', 'e3g-one'] } } });
  const P3G_SDK = { type: 'stdio', command: 'npx', args: ['-y', 'e3g-one'] };
  try {
    fs.writeFileSync(path.join(e3gDir, '.mcp.json'), e3gJson, 'utf8');
    fs.writeFileSync(path.join(e3gCtrl, '.mcp.json'), e3gJson, 'utf8');
    const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [], mcpOverrides: {} };
    const e3gIo = { userHome: e3gHome }; // 只钉 userHome；readUser/readProject 走默认实现
    const r1 = call(() => {
      const out: Record<string, unknown> = {};
      mergeMcpServersIntoSettings(out, cfg, null, e3gDir, e3gIo);
      return out;
    });
    if (!r1.ok) sub.push(`默认 io 首调抛错：${errMsg(r1.error)}`);
    else if (!eq(r1.value.mcpServers, { p3g: P3G_SDK })) sub.push(`默认 io 应注入项目层 p3g：${canon(r1.value.mcpServers)}`);
    const m = call(() => badDirCacheMark(e3gDir));
    if (!m.ok) sub.push(`badDirCacheMark 抛错：${errMsg(m.error)}`);
    const r2 = call(() => {
      const out: Record<string, unknown> = {};
      mergeMcpServersIntoSettings(out, cfg, null, e3gDir, e3gIo);
      return out;
    });
    if (!r2.ok) sub.push(`标记后重调抛错：${errMsg(r2.error)}`);
    else if ('mcpServers' in r2.value) sub.push(`负缓存命中后项目层应缺席（等价目录无 .mcp.json）：${canon(r2.value.mcpServers)}`);
    const r3 = call(() => {
      const out: Record<string, unknown> = {};
      mergeMcpServersIntoSettings(out, cfg, null, e3gCtrl, e3gIo);
      return out;
    });
    if (!r3.ok) sub.push(`未标记对照抛错：${errMsg(r3.error)}`);
    else if (!eq(r3.value.mcpServers, { p3g: P3G_SDK })) sub.push(`未标记对照目录应照常注入 p3g：${canon(r3.value.mcpServers)}`);
    check('E3g', '默认 io 项目级负缓存：合法 .mcp.json 注入；badDirCacheMark 后缺席（等价无文件）；未标记对照照常', sub.length === 0, sub.join('; '));
  } finally {
    fs.rmSync(e3gDir, { recursive: true, force: true });
    fs.rmSync(e3gCtrl, { recursive: true, force: true });
    fs.rmSync(e3gHome, { recursive: true, force: true });
  }
}

// E3h 默认 io 坏目录负缓存·用户级（B-1）：键 mcp-user:<home>（命名空间隔离，绝不与项目目录键
// 碰撞）。tmpdir 伪造 .claude.json：默认 io readUser（userHome 钉临时目录）→ 用户层注入；
// badDirCacheMark(`mcp-user:<home>`) 后再调 → 用户层缺席；第二个全新 home 作不标记对照；
// 另钉隔离性子断言：标记前缀键后 badDirCacheHas(原始 home) 仍 false（前缀键不波及项目目录键）。
{
  const sub: string[] = [];
  const e3hHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-mcp-selftest-e3h-home-'));
  const e3hCtrl = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-mcp-selftest-e3h-ctrl-'));
  const e3hJson = JSON.stringify({ mcpServers: { u3h: { command: 'node' } } });
  const U3H_SDK = { type: 'stdio', command: 'node' };
  try {
    fs.writeFileSync(path.join(e3hHome, '.claude.json'), e3hJson, 'utf8');
    fs.writeFileSync(path.join(e3hCtrl, '.claude.json'), e3hJson, 'utf8');
    const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [], mcpOverrides: {} };
    const r1 = call(() => {
      const out: Record<string, unknown> = {};
      mergeMcpServersIntoSettings(out, cfg, null, null, { userHome: e3hHome });
      return out;
    });
    if (!r1.ok) sub.push(`默认 io 首调抛错：${errMsg(r1.error)}`);
    else if (!eq(r1.value.mcpServers, { u3h: U3H_SDK })) sub.push(`默认 io 应注入用户层 u3h：${canon(r1.value.mcpServers)}`);
    const m = call(() => badDirCacheMark(`mcp-user:${e3hHome}`));
    if (!m.ok) sub.push(`badDirCacheMark 抛错：${errMsg(m.error)}`);
    const r2 = call(() => {
      const out: Record<string, unknown> = {};
      mergeMcpServersIntoSettings(out, cfg, null, null, { userHome: e3hHome });
      return out;
    });
    if (!r2.ok) sub.push(`标记后重调抛错：${errMsg(r2.error)}`);
    else if ('mcpServers' in r2.value) sub.push(`负缓存命中后用户层应缺席：${canon(r2.value.mcpServers)}`);
    if (badDirCacheHas(e3hHome)) sub.push('隔离性违背：标记 mcp-user:<home> 前缀键后，原始 home 项目目录键不应命中负缓存');
    const r3 = call(() => {
      const out: Record<string, unknown> = {};
      mergeMcpServersIntoSettings(out, cfg, null, null, { userHome: e3hCtrl });
      return out;
    });
    if (!r3.ok) sub.push(`未标记对照抛错：${errMsg(r3.error)}`);
    else if (!eq(r3.value.mcpServers, { u3h: U3H_SDK })) sub.push(`未标记对照 home 应照常注入 u3h：${canon(r3.value.mcpServers)}`);
    check('E3h', '默认 io 用户级负缓存（mcp-user:<home> 键）：伪造 .claude.json 注入；标记后缺席；前缀键不波及原始 home 键；未标记对照照常', sub.length === 0, sub.join('; '));
  } finally {
    fs.rmSync(e3hHome, { recursive: true, force: true });
    fs.rmSync(e3hCtrl, { recursive: true, force: true });
  }
}

// E3i 默认 io 真实读失败自动 mark（round-002 修复 F2，2026-10-16）：E3g/E3h 只钉「手动 mark →
// 缺席」与未标记对照，本断言补「真实读失败（非 ENOENT）→ 默认 io 自动 mark + 60s 内短路」链路，
// 以及损坏/ENOENT 两反例不得 mark（scanner 三态分类：读异常非 ENOENT → readFailed=true；
// ENOENT=正常空态 / JSON 损坏 → readFailed=false，见 mcp-scanner readMcpServersFileSyncDetail）。
// ①目录形态 .mcp.json（mkdirSync 造目录，readFileSync 抛 EISDIR/EPERM 非 ENOENT）→ 默认 io
//   自动 badDirCacheMark → badDirCacheHas(dirA)=true；重调一次负缓存命中 → 产物无 mcpServers 键；
// ②损坏 JSON `{bad` → 不 mark；③ENOENT（空目录无 .mcp.json）→ 不 mark。
// 坑位：badDir 60s TTL 无清理导出——三个 tmpdir 互相独立、不与 E3g/E3h 复用，finally 清理。
{
  const sub: string[] = [];
  const e3iDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-mcp-selftest-e3i-dirA-'));
  const e3iDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-mcp-selftest-e3i-dirB-'));
  const e3iDirC = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-mcp-selftest-e3i-dirC-'));
  const e3iHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-mcp-selftest-e3i-home-'));
  try {
    fs.mkdirSync(path.join(e3iDirA, '.mcp.json')); // 目录形态：真实读失败（非 ENOENT）
    fs.writeFileSync(path.join(e3iDirB, '.mcp.json'), '{bad', 'utf8'); // 损坏：readFailed=false
    // e3iDirC 不写 .mcp.json：ENOENT 正常空态，readFailed=false
    const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [], mcpOverrides: {} };
    const e3iIo = { userHome: e3iHome }; // 只钉 userHome 到另一临时空目录（readUser 走 ENOENT 空态）；readUser/readProject 均默认实现
    const r1 = call(() => {
      const out: Record<string, unknown> = {};
      mergeMcpServersIntoSettings(out, cfg, null, e3iDirA, e3iIo);
      return out;
    });
    if (!r1.ok) sub.push(`①目录形态首调抛错（应静默空表不崩）：${errMsg(r1.error)}`);
    else if ('mcpServers' in r1.value) sub.push(`①读失败层应静默空表（不注入）：${canon(r1.value.mcpServers)}`);
    if (!badDirCacheHas(e3iDirA)) sub.push('①真实读失败（目录形态，非 ENOENT）后 badDirCacheHas(dirA) 应为 true——默认 io 未自动 mark');
    const r1b = call(() => {
      const out: Record<string, unknown> = {};
      mergeMcpServersIntoSettings(out, cfg, null, e3iDirA, e3iIo);
      return out;
    });
    if (!r1b.ok) sub.push(`①负缓存重调抛错：${errMsg(r1b.error)}`);
    else if ('mcpServers' in r1b.value) sub.push(`①负缓存短路重调产物应无 mcpServers 键：${canon(r1b.value.mcpServers)}`);
    const r2 = call(() => {
      const out: Record<string, unknown> = {};
      mergeMcpServersIntoSettings(out, cfg, null, e3iDirB, e3iIo);
      return out;
    });
    if (!r2.ok) sub.push(`②损坏 JSON 调用抛错（应静默空表不崩）：${errMsg(r2.error)}`);
    if (badDirCacheHas(e3iDirB)) sub.push('②损坏 JSON（{bad）不得触发 mark（readFailed=false：损坏不缓存）');
    const r3 = call(() => {
      const out: Record<string, unknown> = {};
      mergeMcpServersIntoSettings(out, cfg, null, e3iDirC, e3iIo);
      return out;
    });
    if (!r3.ok) sub.push(`③ENOENT 调用抛错（应静默空表不崩）：${errMsg(r3.error)}`);
    if (badDirCacheHas(e3iDirC)) sub.push('③ENOENT（无 .mcp.json 正常空态）不得触发 mark');
    check('E3i', '默认 io 真实读失败自动 mark（目录形态失败→mark+短路；损坏/ENOENT→不 mark）', sub.length === 0, sub.join('; '));
  } finally {
    fs.rmSync(e3iDirA, { recursive: true, force: true });
    fs.rmSync(e3iDirB, { recursive: true, force: true });
    fs.rmSync(e3iDirC, { recursive: true, force: true });
    fs.rmSync(e3iHome, { recursive: true, force: true });
  }
}

// ── F. §1.3 脱敏闭环组（r3 修复 F2：renderer 出口掩码 + managedSave 哨兵还原）──

console.log('\n=== F. §1.3 脱敏闭环组（maskMcpServersForRenderer / restoreMaskedMcpServers） ===');

// F1 mask：env/headers 值全变哨兵、键保留；入参不被变异（掩码产物深拷贝）；无 env/headers
// 字段的条目不添加该字段；非敏感字段原样保留。
{
  const sub: string[] = [];
  const input: McpManagedServer[] = [
    mkManaged('f1-stdio', 'stdio', { command: 'npx', args: ['-y', 'x'], env: { A: 'secret-a', B: 'secret-b' } }),
    mkManaged('f1-http', 'http', { url: 'https://e/mcp', headers: { Authorization: 'Bearer t', 'X-K': 'v' } }),
    mkManaged('f1-bare', 'sse', { url: 'https://e/sse' }),
  ];
  const snapshot = canon(input);
  const masked = call(() => maskMcpServersForRenderer(input));
  if (!masked.ok) sub.push(throwDetail(masked));
  else {
    const [m1, m2, m3] = masked.value;
    if (masked.value.length !== 3 || !m1 || !m2 || !m3) sub.push(`掩码产物应保持 3 条：${canon(masked.value)}`);
    else {
      if (!eq(m1.env, { A: MCP_MASK_SENTINEL, B: MCP_MASK_SENTINEL })) sub.push(`env 值应全变哨兵且键保留：${canon(m1.env)}`);
      if (!eq(m2.headers, { Authorization: MCP_MASK_SENTINEL, 'X-K': MCP_MASK_SENTINEL })) sub.push(`headers 值应全变哨兵且键保留：${canon(m2.headers)}`);
      if ('env' in m3 || 'headers' in m3) sub.push('无 env/headers 字段条目不应被添加该字段');
      if (m1.command !== 'npx' || !eq(m1.args, ['-y', 'x']) || m2.url !== 'https://e/mcp') sub.push('非敏感字段应原样保留');
      if (typeof m1.env?.A === 'string') m1.env.A = 'mutated';
      if (!eq(input[0].env, { A: 'secret-a', B: 'secret-b' })) sub.push('掩码产物应深拷贝（改写不波及入参）');
    }
  }
  if (canon(input) !== snapshot) sub.push('入参不可被变异');
  check('F1', 'mask：值全变哨兵且键保留；入参不变异（含深拷贝）；无该字段条目不添加', sub.length === 0, sub.join('; '));
}

// F2a restore：同键哨兵→还原原值；改名+hint→按已存原键还原；改名无 hint→丢该键；
// 非哨兵值→透传；瞬态字段不出现在输出。
{
  const sub: string[] = [];
  const stored: McpManagedServer[] = [
    mkManaged('f2-same', 'stdio', { command: 'c1', env: { A: 'orig-a', B: 'orig-b' } }),
    mkManaged('f2-rename', 'stdio', { command: 'c2', env: { OLD_K: 'orig-old' } }),
    mkManaged('f2-nohint', 'http', { url: 'https://e/no', headers: { H: 'orig-h' } }),
  ];
  const entrySame: McpManagedSaveEntry = { ...stored[0], env: { A: MCP_MASK_SENTINEL, B: MCP_MASK_SENTINEL, C: 'new-plain' } };
  const entryRename: McpManagedSaveEntry = { ...stored[1], env: { NEW_K: MCP_MASK_SENTINEL }, envRenameFrom: { NEW_K: 'OLD_K' } };
  const entryNoHint: McpManagedSaveEntry = { ...stored[2], headers: { H2: MCP_MASK_SENTINEL } }; // 键改名但无 hint
  const r = call(() => restoreMaskedMcpServers([entrySame, entryRename, entryNoHint], stored));
  if (!r.ok) sub.push(throwDetail(r));
  else {
    const [o1, o2, o3] = r.value;
    if (r.value.length !== 3 || !o1 || !o2 || !o3) sub.push(`还原产物应保持 3 条：${canon(r.value)}`);
    else {
      if (!eq(o1.env, { A: 'orig-a', B: 'orig-b', C: 'new-plain' })) sub.push(`同键哨兵应还原原值、非哨兵值应透传：${canon(o1.env)}`);
      if (!eq(o2.env, { NEW_K: 'orig-old' })) sub.push(`改名+hint 应按已存原键还原原值：${canon(o2.env)}`);
      if (!eq(o3.headers, {})) sub.push(`改名无 hint（原键不存在）应丢该键：${canon(o3.headers)}`);
      if ('envRenameFrom' in o2 || 'headersRenameFrom' in o2 || 'envRenameFrom' in o3 || 'headersRenameFrom' in o3) sub.push('瞬态字段不得出现在输出');
    }
  }
  check('F2a', 'restore：同键哨兵还原/改名 hint 还原/无 hint 丢键/非哨兵透传/瞬态字段剥离', sub.length === 0, sub.join('; '));
}

// F2b restore 对位：id 对位优先；id 缺失/对不上按 name 兜底。
{
  const sub: string[] = [];
  const stored: McpManagedServer[] = [
    mkManaged('alpha', 'stdio', { command: 'ca', env: { K: 'va' } }),
    mkManaged('beta', 'stdio', { command: 'cb', env: { K: 'vb' } }),
  ];
  // ① id 对位优先：id=alpha 条目的 id 但 name=beta → 按 id 取 alpha 的原值 va。
  const byId: McpManagedSaveEntry = { ...stored[1], id: stored[0].id, name: 'beta', env: { K: MCP_MASK_SENTINEL } };
  // ② id 对不上任何已存条目 → 按 name 兜底（beta → vb）。
  const byName: McpManagedSaveEntry = { ...stored[1], id: 'id-not-exist', env: { K: MCP_MASK_SENTINEL } };
  // ③ id 缺失 → 按 name 兜底（beta → vb）。
  const noId = { name: 'beta', env: { K: MCP_MASK_SENTINEL } } as unknown as McpManagedSaveEntry;
  const r = call(() => restoreMaskedMcpServers([byId, byName, noId], stored));
  if (!r.ok) sub.push(throwDetail(r));
  else {
    const [o1, o2, o3] = r.value;
    if (!o1 || !o2 || !o3) sub.push(`还原产物应保持 3 条：${canon(r.value)}`);
    else {
      if (!eq(o1.env, { K: 'va' })) sub.push(`id 对位应优先于 name（按 id=alpha 还原 va）：${canon(o1.env)}`);
      if (!eq(o2.env, { K: 'vb' })) sub.push(`id 对不上应按 name 兜底（beta→vb）：${canon(o2.env)}`);
      if (!eq(o3.env, { K: 'vb' })) sub.push(`id 缺失应按 name 兜底（beta→vb）：${canon(o3.env)}`);
    }
  }
  check('F2b', '对位：id 对位优先；id 缺失/对不上按 name 兜底', sub.length === 0, sub.join('; '));
}

// F3 端到端：mask→restore 往返后与原值 deepEqual（§1.3 编辑保存闭环等价性；空串值边界在内）。
{
  const sub: string[] = [];
  const original: McpManagedServer[] = [
    mkManaged('f3-stdio', 'stdio', { command: 'npx', args: ['-y', 'srv'], env: { A: 's3cret', EMPTY: '' } }),
    mkManaged('f3-http', 'http', { url: 'https://e/mcp', headers: { Authorization: 'Bearer tok', 'X-Empty': '' } }),
    mkManaged('f3-bare', 'sse', { url: 'https://e/sse' }),
  ];
  const masked = maskMcpServersForRenderer(original);
  const submitted: McpManagedSaveEntry[] = masked.map((s) => ({ ...s })); // 渲染层原样回传掩码产物
  const r = call(() => restoreMaskedMcpServers(submitted, original));
  if (!r.ok) sub.push(throwDetail(r));
  else if (!eq(r.value, original)) sub.push(`mask→restore 往返应与原值 deepEqual：${canon(r.value)}`);
  check('F3', '端到端：mask→restore 往返后与原值 deepEqual（含空串值边界）', sub.length === 0, sub.join('; '));
}

// ── G. R2 mtime 缓存组（readUserMcpServersRawSync 缓存 / clearMcpRawCache）──
// （P8a mcp-writer 未来落地时，writer 组从 H 顺延命名。）

console.log('\n=== G. R2 mtime 缓存组（readUserMcpServersRawSync mtime 缓存 / clearMcpRawCache） ===');

/** 同步忙等（selftest 为同步脚本无事件循环依赖；用于拉开两次写盘的 mtime 间隔——Windows mtime 粒度粗）。 */
function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy-wait */ }
}

// 临时 home：os.tmpdir() 下自建唯一目录模拟 userHome，finally 清理——绝不触真实 ~/.claude.json。
const gHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-mcp-selftest-g-'));
const gClaudeJson = path.join(gHome, '.claude.json');
/** 读临时 home 的用户级 mcpServers（call 包裹：R2 RED 阶段缺失导出/任何异常 → 断言 FAIL 而非脚本崩溃）。 */
const gRead = (): CallResult<Record<string, ParsedMcpEntry>> => call(() => readUserMcpServersRawSync(gHome));

try {
  // G1 (a) 初读：写含 1 个合法 stdio 条目的 .claude.json → raw 读取返回该条目（未脱敏归一表）。
  {
    const sub: string[] = [];
    fs.writeFileSync(gClaudeJson, JSON.stringify({ mcpServers: { g1srv: { command: 'npx', args: ['-y', 'g-one'] } } }), 'utf8');
    const r = gRead();
    if (!r.ok) sub.push(`初读抛错：${r.error.message}`);
    else if (!eq(r.value, { g1srv: { name: 'g1srv', transport: 'stdio', command: 'npx', args: ['-y', 'g-one'] } })) sub.push(`初读应返回 g1srv 条目：${canon(r.value)}`);
    check('G1', '初读：合法 .claude.json → readUserMcpServersRawSync 返回该条目', sub.length === 0, sub.join('; '));
  }

  // G2 (b) mtime 失效：改写内容（换 server 名、字节数不同 + 30ms 写间隔）→ 再读反映新内容
  //     （缓存因 mtime 变化失效；两次内容字节数不同是对粗粒度 mtime 的双保险）。
  {
    const sub: string[] = [];
    sleepSync(30);
    fs.writeFileSync(gClaudeJson, JSON.stringify({ mcpServers: { g2renamed: { command: 'node' } } }), 'utf8');
    const r = gRead();
    if (!r.ok) sub.push(`改写后重读抛错：${r.error.message}`);
    else if (!eq(r.value, { g2renamed: { name: 'g2renamed', transport: 'stdio', command: 'node' } })) sub.push(`mtime 变化后应读到新内容 g2renamed：${canon(r.value)}`);
    check('G2', '改写内容（mtime 变化）→ 再读反映新内容（缓存失效）', sub.length === 0, sub.join('; '));
  }

  // G3 (c) clearMcpRawCache() 后重读：结果与直读等价（清缓存是纯失效动作，不改变可观察结果）。
  {
    const sub: string[] = [];
    const c = call(() => clearMcpRawCache());
    if (!c.ok) sub.push(`clearMcpRawCache 抛错：${c.error.message}`);
    const r = gRead();
    if (!r.ok) sub.push(`清缓存后重读抛错：${r.error.message}`);
    else if (!eq(r.value, { g2renamed: { name: 'g2renamed', transport: 'stdio', command: 'node' } })) sub.push(`清缓存后重读应与直读等价：${canon(r.value)}`);
    check('G3', 'clearMcpRawCache() 后重读，结果与直读等价', sub.length === 0, sub.join('; '));
  }

  // G4 (d) 同 mtime 重复读两次：无异常且结果一致（缓存命中路径稳定）。
  {
    const sub: string[] = [];
    const r1 = gRead();
    const r2 = gRead();
    if (!r1.ok || !r2.ok) sub.push(`重复读抛错：${!r1.ok ? r1.error.message : r2.error.message}`);
    else if (!eq(r1.value, r2.value)) sub.push(`同 mtime 两次读结果应一致：${canon(r1.value)} vs ${canon(r2.value)}`);
    check('G4', '同 mtime 重复读两次：无异常且结果一致', sub.length === 0, sub.join('; '));
  }

  // G5 (e) 损坏不缓存：非法 JSON → 静默 {}（语义保持）；写回合法内容并把 mtime 钉回损坏时
  //     的同一值（整 2 秒对齐，规避 fs 粒度/浮点精度）后能读到新条目——若损坏 {} 被缓存
  //    （key=文件+mtime），此处同 mtime 重读必命中陈旧 {}，断言即抓出。
  {
    const sub: string[] = [];
    sleepSync(30);
    fs.writeFileSync(gClaudeJson, '{not-json', 'utf8');
    const pinned = new Date(Math.floor(Date.now() / 2000) * 2000); // 整 2 秒对齐：任何 fs mtime 粒度下均无损
    fs.utimesSync(gClaudeJson, pinned, pinned);
    const rBad = gRead();
    if (!rBad.ok) sub.push(`损坏读抛错：${rBad.error.message}`);
    else if (Object.keys(rBad.value).length !== 0) sub.push(`非法 JSON 应静默 {}：${canon(rBad.value)}`);
    fs.writeFileSync(gClaudeJson, JSON.stringify({ mcpServers: { g5back: { command: 'echo' } } }), 'utf8');
    fs.utimesSync(gClaudeJson, pinned, pinned); // 钉回同一 mtime：专测「损坏结果是否被缓存」
    const rBack = gRead();
    if (!rBack.ok) sub.push(`写回后重读抛错：${rBack.error.message}`);
    else if (!eq(rBack.value, { g5back: { name: 'g5back', transport: 'stdio', command: 'echo' } })) sub.push(`写回合法内容（同 mtime）应能读到（证明损坏 {} 未被缓存）：${canon(rBack.value)}`);
    check('G5', '损坏（非法 JSON）→ 静默 {}；写回合法内容能读到（损坏结果未被缓存）', sub.length === 0, sub.join('; '));
  }
} finally {
  fs.rmSync(gHome, { recursive: true, force: true });
}

// ── H. R5 三态文案组（McpSettings.vue 项目作用域空列表：正常空态/目录消失/快照失败占位）──
// 渲染层组件无纯函数可行为级断言（selftest 不依赖 Electron runtime），沿 tdd-bridge-ui-static-verify
// 先例读源码做静态钉；只读仓库内源文件，绝不触碰磁盘配置。

console.log('\n=== H. R5 三态文案组（McpSettings.vue 项目空态三态互斥） ===');

{
  const vueRel = path.join('src', 'renderer', 'components', 'config', 'McpSettings.vue');
  let src = '';
  try {
    src = fs.readFileSync(path.resolve(__dirname, '..', vueRel), 'utf8');
  } catch {
    // 缺文件/不可读：src 保持空串，下列断言全部走 FAIL 分支（不抛错、不崩脚本）。
  }
  const DISAPPEARED_TEXT = '该目录已不在最近工作区列表（可在聊天侧切换工作区后回到此处），其 .mcp.json 若仍存在仍会对指向该目录的会话生效';
  const NORMAL_TEXT = '该项目目录暂无 .mcp.json 或其中无 mcpServers';
  const GUARD = 'v-if="isProjectDirGone"';
  const GUARD_DEF = "activeScope.value.kind === 'project' && activeProjectDir.value === null";
  const LOADERROR_BRANCH = `v-else-if="loadError && activeScope.kind !== 'managed'"`;
  check('H1', '消失态文案逐字存在（该目录已不在最近工作区列表…仍会对指向该目录的会话生效）',
    src.includes(DISAPPEARED_TEXT), src === '' ? 'McpSettings.vue 不可读' : '文案缺失');
  check('H2', '正常空态文案保留（目录存在且无 .mcp.json 态不回归）', src.includes(NORMAL_TEXT), '文案缺失');
  check('H3', '消失态判定收敛 script 侧且含 project 作用域守卫（防误报管理库/user/未选目录态）',
    src.includes(GUARD_DEF), 'isProjectDirGone 判定缺失或缺 project 作用域守卫');
  check('H4', 'p4 快照失败占位分支先于空态块（三态互斥的 v-if 链序）',
    src.includes(LOADERROR_BRANCH) && src.indexOf(LOADERROR_BRANCH) < src.indexOf('v-if="visibleCards.length === 0"'),
    '占位分支缺失或顺序不对');
  // r2-F1 增补：正常空态分支钉为 <template v-else> 形态 + 空态文案前缀（防 v-if 链重排/文案换标签回归）。
  const NORMAL_VELSE = '<template v-else>该项目目录暂无 .mcp.json 或其中无 mcpServers';
  check('H5', '项目空态分支嵌套顺序：isProjectDirGone 守卫 → 消失态文案 → 正常空态文案（互斥呈现）；含 v-else 形态子断言（正常空态须为 <template v-else> 起始 + 文案前缀）',
    src.includes(GUARD) && src.includes(NORMAL_VELSE) && src.indexOf(GUARD) < src.indexOf(DISAPPEARED_TEXT) && src.indexOf(DISAPPEARED_TEXT) < src.indexOf(NORMAL_TEXT),
    '守卫/文案顺序不对，或正常空态非 v-else 形态');
  // p6 B-3（2026-10-16）：导入归一值级清洗同步钉——原钉渲染层副本 normalizeImportEntry/
  // pickStringRecordLocal 的值级过滤（与主进程 pickStringRecord 同语义：值非 string 整键
  // 丢弃、清洗后空→字段不设）+ env/headers 不得 `as Record<string, string>` 断言透传、
  // 不得裸透传（D6 round-003 补裸透传封堵；防渲染层/主进程「双处同步」再次漂移）。
  // 【2026-10-19 mcp-settings-plan-a 点6 改写，编排器裁定】点6 将导入解析收口主进程（删双
  // 副本），原钉对象（渲染层值级清洗副本）整体删除——本钉按保护意图迁移钉新架构，判定语义
  // 「防透传、防漂移」不变，断言对象随被钉对象删除而改写：
  //   ① analyzeImportText 区域含 claude.parseMcpJson( 桥调用（导入弹窗解析与 JSON 编辑器
  //     parseJsonDraft 同走主进程 parseMcpServersJson 统一管道）；
  //   ② function normalizeImportEntry / function pickStringRecordLocal 两副本函数定义全文件
  //     零出现（原「钉存在」反转为「钉缺失」——副本回潮即 FAIL，与 O1 同向）；
  //   ③ 原 H6 防透传负向形态保留并扩为全文件：as 断言透传与裸透传四形态零出现（四形态为
  //     副本专属写法，全文件口径无合法出现位，严于原区域口径）。
  const IMPORT_REGION = src.slice(src.indexOf('async function analyzeImportText'), src.indexOf('interface KvRow'));
  check('H6', '导入解析收口主进程（点6 改写）：analyzeImportText 区域走 claude.parseMcpJson 桥；normalizeImportEntry/pickStringRecordLocal 副本函数定义零出现；env/headers as 断言/裸透传四形态零出现',
    src.includes('async function analyzeImportText')
      && IMPORT_REGION.includes('claude.parseMcpJson(')
      && !src.includes('function normalizeImportEntry')
      && !src.includes('function pickStringRecordLocal')
      && !src.includes('entry.env = cfg.env as Record<string, string>')
      && !src.includes('entry.headers = cfg.headers as Record<string, string>')
      && !src.includes('entry.env = cfg.env')
      && !src.includes('entry.headers = cfg.headers'),
    src === '' ? 'McpSettings.vue 不可读' : '解析未走桥/副本函数回潮，或 env/headers 仍为 as 断言/裸透传');
  // H7（2026-10-29 clone 修复钉）：persistManaged 必须对 next 做 JSON 脱壳后再传 saveMcpManaged
  // ——managedServers 是深响应式 ref，map/filter/摊派出的元素是 Vue Proxy，contextBridge/ipcRenderer
  // 结构化克隆不接受 Proxy（"An object could not be cloned"，2026-10-27 用户报障活体复现）。
  // 钉形说明：脱壳是 saveMcpManaged 调用的实参（先于 IPC 交接求值），故钉「连续调用点形态」+
  // 「裸 next 直传旧形态零出现」双断言，任一漂移即 FAIL。
  const pmStart = src.indexOf('async function persistManaged');
  const pmEnd = src.indexOf('async function saveScopedForm');
  const pmBody = pmStart >= 0 && pmEnd > pmStart ? src.slice(pmStart, pmEnd) : '';
  check('H7', '管理库保存脱壳：persistManaged 传给 saveMcpManaged 的实参为 JSON.parse(JSON.stringify(next)) 脱壳产物，裸 next 直传零出现',
    pmBody !== ''
      && pmBody.includes('claude.saveMcpManaged(JSON.parse(JSON.stringify(next))')
      && !pmBody.includes('claude.saveMcpManaged(next)'),
    src === '' ? 'McpSettings.vue 不可读' : 'persistManaged 缺 JSON 脱壳或裸 next 直传回潮');
}

// ── I. D-V1-1 注入挂载组（options.mcpServers 顶层挂载 / 空配置零挂载 / strict 门控：挂载∨overrides 激活）──
// 缺陷语义（D-V1-1）：strictMcpConfig=true 下 SDK 只认顶层 Options.mcpServers（运行时等价
// --mcp-config 旗标），settings 块内 mcpServers 键被忽略——若核心工厂只把 settings 块放进
// Options.settings，所有会话 MCP 注入恒失效（会话内 /mcp 答「No MCP servers are configured」）。
// 断言全链真实构造：mergeMcpServersIntoSettings（io 内存 stub）产 settings 块 →
// buildNativeSdkOptionsCore 产 options——能抓住「只挂 settings 不挂顶层」的回归。

console.log('\n=== I. D-V1-1 注入挂载组（buildNativeSdkOptionsCore 顶层 mcpServers 挂载） ===');

/** 走真实 merge 链构造 settings 块（返回调用后的块），再经核心工厂产 options（call 包裹不崩脚本）。 */
function optionsFromMergedSettings(
  cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'>,
  io: MergeIo,
  seed: Record<string, unknown> = { model: 'claude-x', permissions: { allow: ['Bash'] } },
): CallResult<{ settings: Record<string, unknown>; options: ReturnType<typeof buildNativeSdkOptionsCore> }> {
  const out: Record<string, unknown> = { ...seed };
  const r = mergeCall(cfg, null, io, out);
  if (!r.ok) return { ok: false, error: r.error };
  const r2 = call(() => buildNativeSdkOptionsCore({ env: {}, settings: r.value }));
  if (!r2.ok) return { ok: false, error: r2.error };
  return { ok: true, value: { settings: r.value, options: r2.value } };
}

// I1 非空配置全链：settings.mcpServers 非空 → options.mcpServers 必须挂载，且为同一归一 map
//    （同源同值同引用——不得另起合并/拷贝）；settings 块内 mcpServers 键保留不动（SDK strict 下
//    忽略它，无害）；非空挂载态 strictMcpConfig=true（B-2 门控：挂载态保持压制引擎原生加载）。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [M1_MANAGED], mcpOverrides: {} };
  const r = optionsFromMergedSettings(cfg, ioOf({ u1: U1_ENTRY }));
  if (!r.ok) sub.push(`全链构造失败：${r.error.message}`);
  else {
    const { settings, options } = r.value;
    if (!('mcpServers' in settings)) sub.push('前置失败：settings 块应含非空 mcpServers（merge 未注入）');
    if (!('mcpServers' in options)) sub.push('D-V1-1 回归：settings.mcpServers 非空时 options.mcpServers 未挂载（仍只挂 settings 块，SDK strict 下注入恒失效）');
    if ('mcpServers' in options && 'mcpServers' in settings) {
      if (options.mcpServers !== settings.mcpServers) sub.push('挂载值应为 settings.mcpServers 同一引用（同源同值，不得另起合并/拷贝）');
      if (!eq(options.mcpServers, { u1: U1_SDK, m1: M1_SDK })) sub.push(`挂载 map 应为三层归一产物（user+managed）：${canon(options.mcpServers)}`);
    }
    if (options.strictMcpConfig !== true) sub.push(`strictMcpConfig 应为 true（非空挂载态）：${canon(options.strictMcpConfig)}`);
  }
  check('I1', '非空配置：options.mcpServers 挂载同一归一 map（同源同值）；settings 块键保留；strictMcpConfig 非空挂载时 true', sub.length === 0, sub.join('; '));
}

// I2 空配置零挂载：三层全空 / 全部被 override 禁用 / settings.mcpServers 为空对象（防御边界，
//    真实 merge 链不产出该形态）→ options 均不得出现 mcpServers 键（与「空 MCP 配置零注入」
//    及 SDK 空集不推 --mcp-config 的行为约束同口径）。
{
  const sub: string[] = [];
  const emptyCases: Array<{ label: string; cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'>; io: MergeIo }> = [
    { label: '三层全空', cfg: { mcpServers: [], mcpOverrides: {} }, io: ioOf(EMPTY_PROJECT) },
    {
      label: '全部被禁用',
      cfg: { mcpServers: [M1_MANAGED], mcpOverrides: { 'managed:m1': 'off', 'user:u1': 'off' } },
      io: ioOf({ u1: U1_ENTRY }),
    },
  ];
  for (const c of emptyCases) {
    const r = optionsFromMergedSettings(c.cfg, c.io);
    if (!r.ok) { sub.push(`${c.label}：全链构造失败：${r.error.message}`); continue; }
    if ('mcpServers' in r.value.settings) sub.push(`${c.label}：settings 块不应写入 mcpServers 键（空态字节级一致约束回归）`);
    if ('mcpServers' in r.value.options) sub.push(`${c.label}：options.mcpServers 应缺席（空配置零注入）`);
  }
  // 防御边界：settings.mcpServers 为空对象 → 不挂载（真实链不产出，工厂仍须守住）。
  const rEmptyObj = call(() => buildNativeSdkOptionsCore({ env: {}, settings: { mcpServers: {} } }));
  if (!rEmptyObj.ok) sub.push(`空对象防御边界：构造抛错：${rEmptyObj.error.message}`);
  else if ('mcpServers' in rEmptyObj.value) sub.push('settings.mcpServers 为空对象时 options.mcpServers 应缺席');
  check('I2', '空配置（三层全空/全禁用）与空对象边界：settings 与 options 均零挂载', sub.length === 0, sub.join('; '));
}

// I2b 数组形态防御边界（2026-10-13 mcp-followup round-005 M1 修复新增）：settings.mcpServers
//    为数组（如 ['a','b']）→ options 不得出现 mcpServers 键。真实 merge 链不产出该形态，工厂
//    仍须守住——数组 typeof==='object' 且 Object.keys 非零，旧守卫会放行挂载数组（与「空对象
//    防御边界」同口径，check 描述注明「空对象/数组防御边界」）。
{
  const sub: string[] = [];
  const rArray = call(() => buildNativeSdkOptionsCore({ env: {}, settings: { mcpServers: ['a', 'b'] } }));
  if (!rArray.ok) sub.push(`数组形态防御边界：构造抛错：${rArray.error.message}`);
  else if ('mcpServers' in rArray.value) sub.push('settings.mcpServers 为数组时 options.mcpServers 应缺席（空对象/数组防御边界）');
  check('I2b', '空对象/数组防御边界（数组形态）：settings.mcpServers 为数组 → options.mcpServers 缺席', sub.length === 0, sub.join('; '));
}

// I3 序列化兼容：挂载载体为 merge 产出的 null 原型对象，SDK 侧 --mcp-config 走 JSON.stringify
//    序列化——挂载 map 经 JSON 往返后必须与 settings.mcpServers deepEqual（无损）。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [M1_MANAGED], mcpOverrides: {} };
  const r = optionsFromMergedSettings(cfg, ioOf({ u1: U1_ENTRY, u2: U2_ENTRY }));
  if (!r.ok) sub.push(`全链构造失败：${r.error.message}`);
  else {
    const { settings, options } = r.value;
    if (!('mcpServers' in options)) sub.push('前置失败：options.mcpServers 未挂载');
    else {
      if (Object.getPrototypeOf(options.mcpServers) !== null) sub.push('挂载载体应为 merge 产出的 null 原型对象（不得中途换普通对象载体）');
      let round = '';
      try { round = JSON.stringify(options.mcpServers) ?? ''; } catch (e) { sub.push(`挂载 map JSON 序列化抛错：${errMsg(e)}`); }
      try {
        if (!eq(JSON.parse(round), settings.mcpServers)) sub.push(`JSON 往返后应与 settings.mcpServers deepEqual：${round.slice(0, 200)}`);
      } catch (e) {
        sub.push(`JSON 往返 parse 抛错：${errMsg(e)}`);
      }
    }
  }
  check('I3', '挂载载体（null 原型）可被 JSON 无损序列化（SDK --mcp-config 兼容）', sub.length === 0, sub.join('; '));
}

// I4 未接管空配置 strict 门控（B-2，2026-10-16 新增；2026-10-29 H2 收紧改写信号源）：三层 MCP
//    全空且 effective overrides 全空（= 用户完全未接管 MCP，overridesHitExisting=false）→
//    options.mcpServers 缺席（零注入不回归）且 options.strictMcpConfig === false——恢复引擎原生
//    加载（project .mcp.json/user settings/插件/frontmatter MCP），与 Claude Code 终端行为一致。
//    全链真实构造：merge（sessionRow=null 回退全局）→ core（mcpOverridesActive 消费 merge 返回
//    值 overridesHitExisting，与 sdk-backend 两处 core input 构造点同一信号源）。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [], mcpOverrides: {} };
  const sessionRow: { mcpOverrides: Record<string, 'off'> | null; workingDir?: string | null } | null = null;
  const out: Record<string, unknown> = { model: 'claude-x', permissions: { allow: ['Bash'] } };
  const before = JSON.stringify(out);
  const r = mergeCallWithResult(cfg, sessionRow, ioOf(EMPTY_PROJECT), null, out);
  if (!r.ok) sub.push(`全链构造失败（merge）：${r.error.message}`);
  else {
    // H2 收紧口径：mcpOverridesActive 消费 mergeMcpServersIntoSettings 返回的 overridesHitExisting
    //（effective overrides 全空 → false）。
    const hit = r.value.result?.overridesHitExisting === true;
    const r2 = call(() =>
      buildNativeSdkOptionsCore({
        env: {},
        settings: r.value.out,
        mcpOverridesActive: hit,
      }),
    );
    if (!r2.ok) sub.push(`全链构造失败（core）：${r2.error.message}`);
    else {
      const options = r2.value;
      if ('mcpServers' in options) sub.push('空配置零注入回归：options.mcpServers 应缺席');
      if (options.strictMcpConfig !== false) sub.push(`未接管空配置应 strictMcpConfig=false（恢复引擎原生加载）：${canon(options.strictMcpConfig)}`);
      if (JSON.stringify(r.value.out) !== before) sub.push('空配置 settings 块应字节级一致（E3a 硬约束联动回归）');
    }
  }
  check('I4', '未接管空配置（三层空+overrides 空，sessionRow=null）：options.mcpServers 缺席且 strictMcpConfig=false（恢复引擎原生加载）', sub.length === 0, sub.join('; '));
}

// I5 H2 收紧双场景（B-2 保底分支，2026-10-16 新增；2026-10-29 H2 收紧改写为双场景新口径）：
//    场景 a（孤儿键——H2 修复点）：merged 空 + 钉住 overrides 仅孤儿键（user:ghost，三层全空
//    无定义可命中）→ overridesHitExisting === false 且 strictMcpConfig === false：孤儿键不再
//    触发 strict、不再静默丢弃引擎原生 MCP 来源（云端 connectors/插件 MCP 恢复加载）；
//    场景 b（禁用保底不回退——I 组回归底线）：merged 空 + 钉住禁用键命中现存定义（user:u1
//    命中 io user 层 u1）→ overridesHitExisting === true 且 strictMcpConfig === true：钉住禁用
//    必须保持 strict 压制引擎原生拉起，否则「禁用」失效。两场景 mcpOverridesActive 均消费
//    mergeMcpServersIntoSettings 新返回值（与生产链同信号源）。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [], mcpOverrides: {} };
  // 场景 a：孤儿键（幽灵键跳过 merged 空，E3f 同款形态）。
  const rowA = { mcpOverrides: { 'user:ghost': 'off' } as Record<string, 'off'> | null };
  const rA = mergeCallWithResult(cfg, rowA, ioOf(EMPTY_PROJECT), null);
  if (!rA.ok) sub.push(`场景 a 构造失败（merge）：${rA.error.message}`);
  else {
    if ('mcpServers' in rA.value.out) sub.push('场景 a 前置失败：幽灵键跳过后 merged 应为空，settings 块不应写 mcpServers 键');
    if (rA.value.result?.overridesHitExisting !== false) sub.push(`场景 a：孤儿键不命中任何现存定义，overridesHitExisting 应为 false（H2 收紧）：${canon(rA.value.result?.overridesHitExisting)}`);
    const rA2 = call(() =>
      buildNativeSdkOptionsCore({
        env: {},
        settings: rA.value.out,
        mcpOverridesActive: rA.value.result?.overridesHitExisting === true,
      }),
    );
    if (!rA2.ok) sub.push(`场景 a 构造失败（core）：${rA2.error.message}`);
    else {
      const options = rA2.value;
      if ('mcpServers' in options) sub.push('场景 a：merged 空仍应零挂载，options.mcpServers 应缺席');
      if (options.strictMcpConfig !== false) sub.push(`场景 a：孤儿键不得触发 strict，strictMcpConfig 应为 false（H2 修复点）：${canon(options.strictMcpConfig)}`);
    }
  }
  // 场景 b：禁用键命中现存定义（io user 层含 u1）。
  const rowB = { mcpOverrides: { 'user:u1': 'off' } as Record<string, 'off'> | null };
  const rB = mergeCallWithResult(cfg, rowB, ioOf({ u1: U1_ENTRY }), null);
  if (!rB.ok) sub.push(`场景 b 构造失败（merge）：${rB.error.message}`);
  else {
    if ('mcpServers' in rB.value.out) sub.push('场景 b 前置失败：u1 被禁用后 merged 应为空，settings 块不应写 mcpServers 键');
    if (rB.value.result?.overridesHitExisting !== true) sub.push(`场景 b：禁用键命中现存定义，overridesHitExisting 应为 true（禁用生效保底）：${canon(rB.value.result?.overridesHitExisting)}`);
    const rB2 = call(() =>
      buildNativeSdkOptionsCore({
        env: {},
        settings: rB.value.out,
        mcpOverridesActive: rB.value.result?.overridesHitExisting === true,
      }),
    );
    if (!rB2.ok) sub.push(`场景 b 构造失败（core）：${rB2.error.message}`);
    else {
      const options = rB2.value;
      if ('mcpServers' in options) sub.push('场景 b：merged 空仍应零挂载，options.mcpServers 应缺席');
      if (options.strictMcpConfig !== true) sub.push(`场景 b：命中定义的禁用键应保持 strictMcpConfig=true 压制引擎原生加载（禁用生效，I 组回归底线）：${canon(options.strictMcpConfig)}`);
    }
  }
  check('I5', 'H2 收紧双场景：孤儿键（不命中现存定义）→ strict=false；禁用键命中现存定义 → strict=true 保底（merged 空均零挂载）', sub.length === 0, sub.join('; '));
}

// I6 sdk-backend 门控信号形态静态钉（round-002 修复 F1，2026-10-16；2026-10-29 H2 收紧重钉）：
//    I4/I5 在测试内消费 merge 返回值传 core，core 只消费布尔——生产侧 sdk-backend.ts 两构造点
//    （buildSdkOptions / buildProbeSdkOptions）的信号来源无行为级入口可断言（依赖 Electron
//    runtime），沿 H 组读源码静态钉先例：两函数体区域各含 ①三元解构形态
//    `const { settings, additionalDirectories, mcpOverridesActive } = buildClaudeLinkSettingsBlock(`
//    与 ②核心入参简写代码行（4 空格缩进的 `mcpOverridesActive,` 独立行，注释不含该形态——
//    信号源为 settings 块构造内 mergeMcpServersIntoSettings 返回的 overridesHitExisting）。
//    负向（全文件零出现，钉死不回退旧口径）：旧公式三元
//    `mcpOverridesActive: Object.keys(effectiveOverrides ?? {}).length > 0`、局部声明
//    `const effectiveOverrides = sessionRow?.mcpOverrides ?? config.mcpOverrides;`，并保留原
//    `mcpOverridesActive: Object.keys(config.mcpOverrides` 直判形态零出现（防退化回全局判定）。
// 区域切片锚点（读文件确定）：buildSdkOptions 起 → function buildProbeSdkOptions 止；
// buildProbeSdkOptions 起 → 其后第一个函数边界 function isCurrentProbe 止。
{
  const sdkBackendRel = path.join('src', 'main', 'modules', 'sdk-backend.ts');
  let src = '';
  try {
    src = fs.readFileSync(path.resolve(__dirname, '..', sdkBackendRel), 'utf8');
  } catch {
    // 缺文件/不可读：src 保持空串，下列断言走 FAIL 分支（不抛错、不崩脚本）。
  }
  const DESTRUCT_FORM = 'const { settings, additionalDirectories, mcpOverridesActive } = buildClaudeLinkSettingsBlock(';
  const ACTIVE_SHORTHAND = '    mcpOverridesActive,'; // 4 空格缩进的独立代码行（core input 简写传参），注释不含该形态
  const OLD_ACTIVE = 'mcpOverridesActive: Object.keys(effectiveOverrides ?? {}).length > 0';
  const OLD_FORMULA = 'const effectiveOverrides = sessionRow?.mcpOverrides ?? config.mcpOverrides;';
  const DIRECT_FORM = 'mcpOverridesActive: Object.keys(config.mcpOverrides';
  const buildStart = src.indexOf('function buildSdkOptions');
  const probeStart = src.indexOf('function buildProbeSdkOptions');
  const probeEnd = src.indexOf('function isCurrentProbe');
  const buildRegion = buildStart >= 0 && probeStart > buildStart ? src.slice(buildStart, probeStart) : '';
  const probeRegion = probeStart >= 0 && probeEnd > probeStart ? src.slice(probeStart, probeEnd) : '';
  check('I6', 'sdk-backend 门控信号形态静态钉（两构造点各含三元解构+简写传参；旧公式/直判形态全文件零出现）',
    buildRegion.includes(DESTRUCT_FORM)
    && buildRegion.includes(ACTIVE_SHORTHAND)
    && probeRegion.includes(DESTRUCT_FORM)
    && probeRegion.includes(ACTIVE_SHORTHAND)
    && !src.includes(OLD_ACTIVE)
    && !src.includes(OLD_FORMULA)
    && !src.includes(DIRECT_FORM),
    src === '' ? 'sdk-backend.ts 不可读' : '解构/简写形态缺失（两构造点须各含）或旧公式/config 直判形态残留');
}

// I7 overridesHitExisting 直测（2026-10-29 H2 收紧新增）：mergeMcpServersIntoSettings 返回值
//    直测（io 内存 stub 复用 ioOf 形态）——effective overrides 中至少一个值==='off' 的键命中
//    三层现存定义（managed:<name> / user:<name> / project:<projectDirKey>:<name>，project 仅
//    会话目录键）才 true；孤儿键（外部删除后残留）/ 跨目录 project 键（D5 语义：跨目录不生效）/
//    非 'off' 脏值键（与 merge 应用侧 val==='off' 同口径）均 false。
{
  const sub: string[] = [];
  const cfgEmpty: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [], mcpOverrides: {} };
  const hitOf = (r: CallResult<{ out: Record<string, unknown>; result?: { overridesHitExisting: boolean } }>): unknown =>
    r.ok ? r.value.result?.overridesHitExisting : '调用失败';
  // ① 三层空 + 钉住孤儿键 user:ghost → false（无任何现存定义可命中）。
  const r1 = mergeCallWithResult(cfgEmpty, { mcpOverrides: { 'user:ghost': 'off' } }, ioOf(EMPTY_PROJECT), null);
  if (hitOf(r1) !== false) sub.push(`① 三层空+孤儿键应 false：${canon(hitOf(r1))}`);
  // ② user 层有 u1 + 钉住 user:u1:off → true（命中现存定义的禁用键）。
  const r2 = mergeCallWithResult(cfgEmpty, { mcpOverrides: { 'user:u1': 'off' } }, ioOf({ u1: U1_ENTRY }), null);
  if (hitOf(r2) !== true) sub.push(`② 禁用键命中 user 层现存定义应 true：${canon(hitOf(r2))}`);
  if (r2.ok && 'mcpServers' in r2.value.out) sub.push('② u1 被禁用后 merged 应为空：settings 块不应写 mcpServers 键');
  // ③ 跨目录 project 键（钉 project:d2:p1，会话 projectDirKey='d1'，D5 形态）→ false。
  const projIo: MergeIo = {
    readUser: () => ({}),
    readProject: () => ({ p1: { name: 'p1', transport: 'sse', url: 'https://proj/sse' } }),
  };
  const r3 = mergeCallWithResult(cfgEmpty, { mcpOverrides: { 'project:d2:p1': 'off' } }, projIo, 'd1');
  if (hitOf(r3) !== false) sub.push(`③ 跨目录 project 键应 false（D5：跨目录不生效）：${canon(hitOf(r3))}`);
  // ④ managed 层有 m1 + 钉住 managed:m1:off → true。
  const r4 = mergeCallWithResult({ mcpServers: [M1_MANAGED], mcpOverrides: {} }, { mcpOverrides: { 'managed:m1': 'off' } }, ioOf(EMPTY_PROJECT), null);
  if (hitOf(r4) !== true) sub.push(`④ 禁用键命中 managed 层现存定义应 true：${canon(hitOf(r4))}`);
  // ⑤ 非 'off' 脏值键（钉 user:u1:'on'，user 层有 u1）→ false（与 merge 应用侧同口径：值非 'off' 不算激活）。
  const r5 = mergeCallWithResult(cfgEmpty, { mcpOverrides: { 'user:u1': 'on' } as unknown as Record<string, 'off'> }, ioOf({ u1: U1_ENTRY }), null);
  if (hitOf(r5) !== false) sub.push(`⑤ 非 'off' 脏值键应 false：${canon(hitOf(r5))}`);
  check('I7', 'overridesHitExisting 直测：孤儿键/跨目录键/非 off 脏值键 → false；user/managed 命中禁用键 → true', sub.length === 0, sub.join('; '));
}

// I8 不可观测定义层保守判定（2026-10-29 B-M1 加固新增）：默认 io（不注入 readUser/readProject，
//    只有 userHome 钉临时空目录）下，读失败层/负缓存短路层视为「定义未知」——effective overrides
//    中存在任意值==='off' 的键即保守置 overridesHitExisting=true：该层真实被禁用的键唯一定义恰在
//    脏层里（definitionKeys 空），不保守则 strictMcpConfig=false 放行引擎原生拉起，破坏用户显式
//    'off' 的禁用语义。反例（不保守，保持既有三态分类口径）：ENOENT 正常空态 / JSON 损坏（
//    readFailed=false，层可观测即「确实无定义」）/ overrides 无 'off' 键（H2「未接管恢复原生加载」
//    不回归）/ 非 'off' 脏值键。
//     坑位：坏目录负缓存 60s TTL 无清理导出——各 tmpdir 只消费一次，finally 清理；
//     i8DirBad 在 ①② 后被 mark，⑤⑥ 复用它即等价「负缓存短路层 + 无禁用意图 / 脏值」。
{
  const sub: string[] = [];
  const i8DirBad = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-mcp-selftest-i8-bad-'));
  const i8DirMissing = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-mcp-selftest-i8-missing-'));
  const i8DirCorrupt = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-mcp-selftest-i8-corrupt-'));
  const i8Home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-mcp-selftest-i8-home-'));
  try {
    fs.mkdirSync(path.join(i8DirBad, '.mcp.json')); // 目录形态：真实读失败（EISDIR/EPERM，非 ENOENT）
    fs.writeFileSync(path.join(i8DirCorrupt, '.mcp.json'), '{bad', 'utf8'); // JSON 损坏：readFailed=false
    // i8DirMissing 不写 .mcp.json：ENOENT 正常空态；i8Home 为空 home（readUser 走 ENOENT 空态）
    const badKey = `project:${normalizeDirKey(i8DirBad)}:p1`;
    const missingKey = `project:${normalizeDirKey(i8DirMissing)}:p1`;
    const corruptKey = `project:${normalizeDirKey(i8DirCorrupt)}:p1`;
    const i8Io = { userHome: i8Home }; // 只钉 userHome；readUser/readProject 走默认实现
    const hitOf = (c: CallResult<{ overridesHitExisting: boolean }>): unknown =>
      c.ok ? c.value.overridesHitExisting : '调用失败';
    const merge = (
      overrides: Record<string, 'off'>,
      workingDir: string,
    ): CallResult<{ overridesHitExisting: boolean }> => {
      const out: Record<string, unknown> = {};
      return call(() => mergeMcpServersIntoSettings(out, { mcpServers: [], mcpOverrides: overrides }, null, workingDir, i8Io));
    };
    // ① RED 主场景：读失败层 + 真实禁用键 → 保守 true。
    const r1 = merge({ [badKey]: 'off' }, i8DirBad);
    if (hitOf(r1) !== true) sub.push(`① 读失败层+禁用键应保守 true：${canon(hitOf(r1))}`);
    // ② 负缓存窗口：同一 60s TTL 内立刻重调（readFailed 已观测不到，靠短路分支兜住）→ 仍 true。
    if (!badDirCacheHas(i8DirBad)) sub.push('② 前置失败：i8DirBad 应已被 ① 自动 mark（真实读失败）');
    const r2 = merge({ [badKey]: 'off' }, i8DirBad);
    if (hitOf(r2) !== true) sub.push(`② 负缓存短路窗口内重调应仍 true：${canon(hitOf(r2))}`);
    // ③ ENOENT 正常空态（可观测：确实无定义）→ 不保守 false。
    const r3 = merge({ [missingKey]: 'off' }, i8DirMissing);
    if (hitOf(r3) !== false) sub.push(`③ ENOENT 层不应保守（应 false）：${canon(hitOf(r3))}`);
    // ④ JSON 损坏（readFailed=false，层可观测）→ 不保守 false。
    const r4 = merge({ [corruptKey]: 'off' }, i8DirCorrupt);
    if (hitOf(r4) !== false) sub.push(`④ JSON 损坏层不应保守（应 false）：${canon(hitOf(r4))}`);
    // ⑤ 无禁用意图：负缓存短路层 + overrides 空 → false（H2 未接管恢复原生加载不回归）。
    const r5 = merge({}, i8DirBad);
    if (hitOf(r5) !== false) sub.push(`⑤ 无 'off' 键时不应保守（H2 不回归，应 false）：${canon(hitOf(r5))}`);
    // ⑥ 非 'off' 脏值：负缓存短路层 + 'on' 脏值 → false（与 merge 应用侧同口径）。
    const r6 = merge({ [badKey]: 'on' } as unknown as Record<string, 'off'>, i8DirBad);
    if (hitOf(r6) !== false) sub.push(`⑥ 非 'off' 脏值不应保守（应 false）：${canon(hitOf(r6))}`);
    check(
      'I8',
      '不可观测定义层保守判定：读失败层+禁用键→true（①② 含负缓存短路窗口）；ENOENT/JSON 损坏/无 off 键/非 off 脏值→false（③④⑤⑥）',
      sub.length === 0,
      sub.join('; '),
    );
  } finally {
    fs.rmSync(i8DirBad, { recursive: true, force: true });
    fs.rmSync(i8DirMissing, { recursive: true, force: true });
    fs.rmSync(i8DirCorrupt, { recursive: true, force: true });
    fs.rmSync(i8Home, { recursive: true, force: true });
  }
}

// ── J. timeoutMs 全链组（2026-10-19 mcp-settings-plan-a 点1）────────────────
// 口径：配置侧合法=Number.isInteger 且 1..120000（isValidMcpTimeoutMs，非法静默丢字段、
// 条目其余字段完好——与 env/headers 值级清洗容错口径一致）；探活运行时侧
// resolveProbeTimeoutMs：>=1 整数封顶 120000 生效，undefined/非法一律默认 30000
//（p2 探活超时对齐 2026-10-27：默认 10000 → 30000，对齐 Claude Code CLI / ZCode 30s 口径）。
// 硬约束（计划 §1.2/§6）：timeoutMs 绝不注入 SDK 会话（J6 防漏钉）。

console.log('\n=== J. timeoutMs 全链组（sanitize 透传 / 导出 / probe 超时 / 注入防漏钉 / 解析 / 视图） ===');

// J1 sanitize：合法整数（30000、1、120000 边界）保留；0/-5/1.5/'30000'/120001/undefined →
// 字段被静默丢弃且条目其余字段完好（不整条丢弃、不报错）。
{
  const sub: string[] = [];
  for (const v of [30000, 1, 120000]) {
    const out = sanitizeMcpServersConfig([{ id: 'j1a', name: 'j1a', transport: 'stdio', command: 'c', timeoutMs: v }]);
    if (out.length !== 1) { sub.push(`timeoutMs=${v}：合法值条目不应被丢弃`); continue; }
    if (out[0].timeoutMs !== v) sub.push(`timeoutMs=${v}（合法整数）应保留：${canon(out[0].timeoutMs)}`);
    if (out[0].command !== 'c') sub.push(`timeoutMs=${v}：条目其余字段应完好`);
  }
  for (const bad of [0, -5, 1.5, '30000', 120001, undefined]) {
    const raw = { id: 'j1b', name: 'j1b', transport: 'http', url: 'https://x/mcp', timeoutMs: bad } as Record<string, unknown>;
    const out = sanitizeMcpServersConfig([raw])[0];
    if (!out) { sub.push(`timeoutMs=${String(bad)}：条目不应被整条丢弃（仅丢字段）`); continue; }
    if ('timeoutMs' in out) sub.push(`timeoutMs=${String(bad)}（非法）应被静默丢弃（字段消失）`);
    if (out.url !== 'https://x/mcp') sub.push(`timeoutMs=${String(bad)}：丢弃时条目其余字段应完好`);
  }
  check('J1', 'sanitize：合法整数（30000/1/120000 边界）保留；0/-5/1.5/"30000"/120001/undefined → 丢字段且条目完好', sub.length === 0, sub.join('; '));
}

// J2 writer：断言归位 scripts/selftest-mcp-writer.ts [12]（writeScopedMcpServer 为异步驱动 +
// 内存 io stub，属该脚本契约域）：ScopedMcpEntry 带 timeoutMs → 写出 JSON 条目含
// "timeoutMs": 30000；不带 → 无该键。本组不重复（见文件头 J 组说明）。

// J4 导出：buildMcpServersExportJson 输出条目含 timeoutMs（合法才写键）；无值不写键。
// （镜像断言另见 scripts/selftest-mcp-export.ts A9。）
{
  const sub: string[] = [];
  const r = call(() => buildMcpServersExportJson({
    j4a: { transport: 'stdio', command: 'npx', timeoutMs: 30000 },
    j4b: { transport: 'http', url: 'https://x/mcp' },
  }));
  if (!r.ok) sub.push(throwDetail(r));
  else {
    const parsed = JSON.parse(r.value) as { mcpServers: Record<string, Record<string, unknown>> };
    if (parsed.mcpServers.j4a?.timeoutMs !== 30000) sub.push(`含合法 timeoutMs 应导出 "timeoutMs": 30000：${canon(parsed.mcpServers.j4a)}`);
    if (parsed.mcpServers.j4a?.command !== 'npx') sub.push(`导出条目其余字段应完好：${canon(parsed.mcpServers.j4a)}`);
    if (parsed.mcpServers.j4b === undefined || 'timeoutMs' in parsed.mcpServers.j4b) sub.push(`无 timeoutMs 不得写键：${canon(parsed.mcpServers.j4b)}`);
  }
  check('J4', '导出：条目含合法 timeoutMs → 输出含 "timeoutMs": 30000；无值 → 无该键', sub.length === 0, sub.join('; '));
}

// J5 probe 超时参数化：resolveProbeTimeoutMs 纯函数直测（直接 import mcp-probe.ts，
// 该文件仅 import node:child_process，selftest 可纯 node 运行）：
// undefined/缺省/非法（0/负/小数/字符串/null）→ 30000；5000→5000；1/120000 边界保留；999999→120000 封顶。
{
  const sub: string[] = [];
  const cases: Array<{ label: string; entry: { timeoutMs?: unknown } | undefined; want: number }> = [
    { label: 'undefined 入参 → 30000', entry: undefined, want: 30000 },
    { label: '空对象（缺字段）→ 30000', entry: {}, want: 30000 },
    { label: '字段 undefined → 30000', entry: { timeoutMs: undefined }, want: 30000 },
    { label: '5000 → 5000', entry: { timeoutMs: 5000 }, want: 5000 },
    { label: '边界 1 → 1', entry: { timeoutMs: 1 }, want: 1 },
    { label: '边界 120000 → 120000', entry: { timeoutMs: 120000 }, want: 120000 },
    { label: '999999 封顶 → 120000', entry: { timeoutMs: 999999 }, want: 120000 },
    { label: '0 → 30000', entry: { timeoutMs: 0 }, want: 30000 },
    { label: '-5 → 30000', entry: { timeoutMs: -5 }, want: 30000 },
    { label: '1.5（小数）→ 30000', entry: { timeoutMs: 1.5 }, want: 30000 },
    { label: "'x'（字符串）→ 30000", entry: { timeoutMs: 'x' }, want: 30000 },
    { label: 'null → 30000', entry: { timeoutMs: null }, want: 30000 },
  ];
  for (const c of cases) {
    const r = call(() => resolveProbeTimeoutMs(c.entry));
    if (!r.ok) { sub.push(`${c.label}：${throwDetail(r)}`); continue; }
    if (r.value !== c.want) sub.push(`${c.label}：应 ${c.want}，得到 ${String(r.value)}`);
  }
  check('J5', 'resolveProbeTimeoutMs：undefined/缺省/非法（0/负/小数/字符串/null）→ 30000；5000→5000；1..120000 边界保留；999999 封顶 120000', sub.length === 0, sub.join('; '));
}

// J6 注入链防漏钉（计划 §1.2/§6 硬约束，实现前即应 PASS 的守卫断言）：带 timeoutMs 的条目
// 经 toSdkMcpServerConfig 序列化输出不含 timeoutMs 键（stdio/http 两形），mergeMcpServersForSession
// 全链产物同钉——会话行为零变化。
{
  const sub: string[] = [];
  const j6stdio: { transport: 'stdio' | 'http' | 'sse'; command?: string; timeoutMs?: number } = { transport: 'stdio', command: 'x', timeoutMs: 30000 };
  const r1 = call(() => toSdkMcpServerConfig(j6stdio));
  if (!r1.ok) sub.push(`stdio 形：${throwDetail(r1)}`);
  else if ('timeoutMs' in r1.value || !eq(r1.value, { type: 'stdio', command: 'x' })) sub.push(`stdio 形输出不得含 timeoutMs：${canon(r1.value)}`);
  const j6http: { transport: 'stdio' | 'http' | 'sse'; url?: string; timeoutMs?: number } = { transport: 'http', url: 'https://x/mcp', timeoutMs: 30000 };
  const r2 = call(() => toSdkMcpServerConfig(j6http));
  if (!r2.ok) sub.push(`http 形：${throwDetail(r2)}`);
  else if ('timeoutMs' in r2.value || !eq(r2.value, { type: 'http', url: 'https://x/mcp' })) sub.push(`http 形输出不得含 timeoutMs：${canon(r2.value)}`);
  const r3 = call(() => mergeMcpServersForSession({
    managed: [mkManaged('j6m', 'stdio', { command: 'c', timeoutMs: 30000 })],
    userServers: {},
    projectServers: {},
    overrides: {},
    projectDirKey: null,
  }));
  if (!r3.ok) sub.push(`merge 全链：${throwDetail(r3)}`);
  else if (!eq(r3.value.j6m, { type: 'stdio', command: 'c' })) sub.push(`注入链产物不得含 timeoutMs：${canon(r3.value.j6m)}`);
  check('J6', '注入链防漏钉：带 timeoutMs 条目经 toSdkMcpServerConfig（stdio/http）/ mergeMcpServersForSession 输出均不含 timeoutMs（会话行为零变化）', sub.length === 0, sub.join('; '));
}

// J7 解析透传：parseMcpServersJson 对 timeoutMs 合法值透传进条目（点5 JSON 模式回填数据源）；
// 非法值（"timeoutMs":"3万"）→ 条目无 timeoutMs 但其余字段完好（条目级容错，不跳条不报错）。
{
  const sub: string[] = [];
  const r1 = call(() => parseMcpServersJson('{"a":{"type":"stdio","command":"x","timeoutMs":30000}}'));
  if (!r1.ok) sub.push(`合法值：${throwDetail(r1)}`);
  else if (!r1.value.ok) sub.push(`合法值应 ok:true：${r1.value.error}`);
  else if (r1.value.servers.length !== 1 || r1.value.servers[0]?.timeoutMs !== 30000) sub.push(`servers[0].timeoutMs 应为 30000：${canon(r1.value.servers)}`);
  const r2 = call(() => parseMcpServersJson('{"b":{"type":"stdio","command":"y","timeoutMs":"3万"}}'));
  if (!r2.ok) sub.push(`非法值：${throwDetail(r2)}`);
  else if (!r2.value.ok) sub.push(`非法值应 ok:true（条目级容错）：${r2.value.error}`);
  else {
    const e = r2.value.servers[0];
    if (!e || e.name !== 'b') sub.push(`非法值：条目本身不应被跳过：${canon(r2.value.servers)}`);
    else if ('timeoutMs' in e || e.command !== 'y') sub.push(`非法 timeoutMs 应丢字段且其余字段完好：${canon(e)}`);
  }
  check('J7', '解析透传：timeoutMs 合法（30000）→ 条目携带；非法（"3万"）→ 条目无该键但其余字段完好', sub.length === 0, sub.join('; '));
}

// J3 scanner 视图透传（异步，本组最后执行；其 promise 链收尾调用 finish() 输出汇总与退出码）：
// 临时目录构造 user ~/.claude.json + project .mcp.json（沿 G 组惯例：os.tmpdir() 自建唯一目录、
// 跑完清理，绝不触真实 ~/.claude.json；badDir 负缓存注入 no-op stub，不污染共享实例）。断言：
// 条目含合法 timeoutMs → McpScopedServerView 携带该键（编辑回填数据源）；无键 → 视图无键。
{
  const j3Home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-mcp-selftest-j3-home-'));
  const j3Proj = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-mcp-selftest-j3-proj-'));
  const cleanup = (): void => {
    fs.rmSync(j3Home, { recursive: true, force: true });
    fs.rmSync(j3Proj, { recursive: true, force: true });
  };
  fs.writeFileSync(
    path.join(j3Home, '.claude.json'),
    JSON.stringify({ mcpServers: { ju: { command: 'npx', timeoutMs: 30000 }, ju2: { command: 'node' } } }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(j3Proj, '.mcp.json'),
    JSON.stringify({ mcpServers: { jp: { command: 'uvx', timeoutMs: 5000 } } }),
    'utf8',
  );
  collectMcpSnapshot({
    userHome: j3Home,
    isDefaultDir: () => false,
    recentWorkspaces: [j3Proj],
    defaultWorkingDir: null,
    listWorkingDirCounts: () => new Map<string, number>(),
    badDirHas: () => false,
    badDirMark: () => {},
  }).then(
    (snapshot) => {
      const sub: string[] = [];
      const ju = snapshot.userServers.find((s) => s.name === 'ju');
      const ju2 = snapshot.userServers.find((s) => s.name === 'ju2');
      if (!ju) sub.push(`user 视图应含 ju：${canon(snapshot.userServers)}`);
      else if (ju.timeoutMs !== 30000) sub.push(`user 视图 ju 应携带 timeoutMs=30000：${canon(ju)}`);
      if (!ju2) sub.push('user 视图应含 ju2');
      else if ('timeoutMs' in ju2) sub.push(`user 视图无键条目 ju2 不得出现 timeoutMs：${canon(ju2)}`);
      if (snapshot.projectDirs.length !== 1) sub.push(`project 目录视图应恰 1 个：${canon(snapshot.projectDirs)}`);
      else {
        const jp = snapshot.projectDirs[0]?.servers.find((s) => s.name === 'jp');
        if (!jp) sub.push(`project 视图应含 jp：${canon(snapshot.projectDirs)}`);
        else if (jp.timeoutMs !== 5000) sub.push(`project 视图 jp 应携带 timeoutMs=5000：${canon(jp)}`);
      }
      check('J3', 'scanner 视图透传：user/project 条目含合法 timeoutMs → 视图携带（编辑回填）；无键 → 视图无键（临时目录已清理）', sub.length === 0, sub.join('; '));
      cleanup();
      finish();
    },
    (e: unknown) => {
      check('J3', 'scanner 视图透传（collectMcpSnapshot）', false, `调用抛错：${errMsg(e)}`);
      cleanup();
      finish();
    },
  );
}

// ── K. 单服务器导出 JSON 组（2026-10-19 mcp-settings-plan-a 点2：src/shared/mcp-json.ts）──
// 表单⇄JSON 双模式的「表单 → JSON」方向供料：单服务器导出形态 {"<name>":{…}}、2 空格缩进 +
// 尾换行、字段序固定（type,command,args,env,url,headers,timeoutMs）、空 args/env/headers 省略键、
// description 一律不导出、数组/嵌套对象（env/headers）单行紧凑（K1 字面比对为准绳）。
// K5 哨兵序列化后经主进程 parseMcpServersJson（selftest 直接 import，既有先例）回读往返一致
// ——JSON 模式可回填的解析侧契约（点 5 反方向经 mcp:parseMcpJson 通道走同一函数）。

console.log('\n=== K. 单服务器导出 JSON 组（buildSingleServerExportJson） ===');

// K1 stdio 全字段字面比对（准绳）：顶层 {"context7":{…}}、2 空格缩进、字段序
// type→command→args→env→timeoutMs、args/env 单行紧凑（", " 分隔、括号内带空格）、末尾换行。
{
  const sub: string[] = [];
  const K1_EXPECTED = '{\n  "context7": {\n    "type": "stdio",\n    "command": "npx",\n    "args": ["-y", "@upstash/context7"],\n    "env": { "K": "••••••••" },\n    "timeoutMs": 30000\n  }\n}\n';
  const r = call(() => buildSingleServerExportJson({
    name: 'context7',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7'],
    env: { K: MCP_MASK_SENTINEL },
    timeoutMs: 30000,
  }));
  if (!r.ok) sub.push(throwDetail(r));
  else if (r.value !== K1_EXPECTED) sub.push(`字面不符——得到 ${JSON.stringify(r.value)}，期望 ${JSON.stringify(K1_EXPECTED)}`);
  check('K1', 'stdio 全字段：输出恰为字面形态（2 空格缩进+尾换行+字段序固定+args/env 单行紧凑）', sub.length === 0, sub.join('; '));
}

// K2 http 形：含 url/headers 键；无 command/args/env 键（字段互斥；结构断言走 JSON.parse）。
{
  const sub: string[] = [];
  const r = call(() => buildSingleServerExportJson({
    name: 'edge-http',
    transport: 'http',
    url: 'https://e/mcp',
    headers: { Authorization: 'Bearer t' },
    timeoutMs: 5000,
  }));
  if (!r.ok) sub.push(throwDetail(r));
  else {
    let parsed: Record<string, Record<string, unknown>> | null = null;
    try { parsed = JSON.parse(r.value) as Record<string, Record<string, unknown>>; }
    catch (e) { sub.push(`输出应可 JSON.parse：${errMsg(e)}`); }
    if (parsed) {
      const entry = parsed['edge-http'];
      if (!entry) sub.push(`顶层键应为 "edge-http"：${JSON.stringify(r.value.slice(0, 80))}`);
      else {
        if (entry.type !== 'http') sub.push(`type 应为 "http"：${canon(entry)}`);
        if (entry.url !== 'https://e/mcp') sub.push(`http 形应含 url 键：${canon(entry)}`);
        if (!eq(entry.headers, { Authorization: 'Bearer t' })) sub.push(`http 形应含 headers 键：${canon(entry)}`);
        for (const absent of ['command', 'args', 'env']) {
          if (absent in entry) sub.push(`http 形不得含 ${absent} 键：${canon(entry)}`);
        }
      }
    }
  }
  check('K2', 'http 形：输出含 url/headers 键，无 command/args/env 键（transport 字段互斥）', sub.length === 0, sub.join('; '));
}

// K3 空对象省略：args:[] / env:{} / headers:{} → 对应键不出现（其余字段完好）。
{
  const sub: string[] = [];
  const r1 = call(() => buildSingleServerExportJson({ name: 'k3-stdio', transport: 'stdio', command: 'npx', args: [], env: {} }));
  if (!r1.ok) sub.push(`stdio 空参数：${throwDetail(r1)}`);
  else {
    const entry = (JSON.parse(r1.value) as Record<string, Record<string, unknown>>)['k3-stdio'];
    if (!entry) sub.push(`stdio 空参数：顶层键缺失：${JSON.stringify(r1.value.slice(0, 80))}`);
    else {
      for (const absent of ['args', 'env', 'timeoutMs']) {
        if (absent in entry) sub.push(`空 ${absent} → 键不应出现：${canon(entry)}`);
      }
      if (entry.type !== 'stdio' || entry.command !== 'npx') sub.push(`空参数时其余字段应完好：${canon(entry)}`);
    }
  }
  const r2 = call(() => buildSingleServerExportJson({ name: 'k3-http', transport: 'http', url: 'https://e/mcp', headers: {} }));
  if (!r2.ok) sub.push(`headers 为 {}：${throwDetail(r2)}`);
  else {
    const entry = (JSON.parse(r2.value) as Record<string, Record<string, unknown>>)['k3-http'];
    if (!entry) sub.push('headers 为 {}：顶层键缺失');
    else if ('headers' in entry) sub.push(`headers 为 {} → 键不应出现：${canon(entry)}`);
    else if (entry.url !== 'https://e/mcp') sub.push(`headers 为 {}：url 应完好：${canon(entry)}`);
  }
  check('K3', '空对象省略：args:[]/env:{}/headers:{} → 对应键不出现（其余字段完好）', sub.length === 0, sub.join('; '));
}

// K4 name 含特殊字符（'a-b_2'）原样包裹为顶层键（单键 map；JSON.stringify 转义保证键合法）。
{
  const sub: string[] = [];
  const r = call(() => buildSingleServerExportJson({ name: 'a-b_2', transport: 'stdio', command: 'node' }));
  if (!r.ok) sub.push(throwDetail(r));
  else {
    if (!r.value.startsWith('{\n  "a-b_2": {\n')) sub.push(`name 应原样包裹为顶层键：${JSON.stringify(r.value.slice(0, 40))}`);
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(r.value) as Record<string, unknown>; }
    catch (e) { sub.push(`输出应可 JSON.parse：${errMsg(e)}`); }
    if (parsed && !eq(Object.keys(parsed), ['a-b_2'])) sub.push(`顶层应恰一个键 a-b_2：${canon(Object.keys(parsed))}`);
    const entry = (parsed?.['a-b_2'] ?? null) as Record<string, unknown> | null;
    if (!entry || entry.command !== 'node' || entry.type !== 'stdio') sub.push('条目字段应完好（type/command）');
  }
  check('K4', 'name 含特殊字符（a-b_2）原样包裹为顶层键（单键 map）', sub.length === 0, sub.join('; '));
}

// K5 哨兵原样往返（JSON 模式可回填契约）：env 值 •••••••• 序列化输出后经主进程
// parseMcpServersJson（selftest 直接 import）回读 ok:true 且 env 值仍为 ••••••••（明文新值同钉）。
{
  const sub: string[] = [];
  const r = call(() => buildSingleServerExportJson({
    name: 'k5-roundtrip',
    transport: 'stdio',
    command: 'npx',
    env: { SECRET: MCP_MASK_SENTINEL, PLAIN: 'plain-v' },
  }));
  if (!r.ok) sub.push(throwDetail(r));
  else {
    const p = call(() => parseMcpServersJson(r.value));
    if (!p.ok) sub.push(`parseMcpServersJson 调用抛错：${throwDetail(p)}`);
    else if (!p.value.ok) sub.push(`回读应 ok:true：${p.value.error}`);
    else {
      const e = p.value.servers[0];
      if (p.value.servers.length !== 1 || !e || e.name !== 'k5-roundtrip') sub.push(`回读应恰 1 条同名条目：${canon(p.value.servers)}`);
      else if (!eq(e.env, { SECRET: MCP_MASK_SENTINEL, PLAIN: 'plain-v' })) sub.push(`哨兵/明文值应往返一致：${canon(e.env)}`);
    }
  }
  check('K5', '哨兵原样往返：env 值 •••••••• 序列化 → parseMcpServersJson 回读 ok:true 且值仍为哨兵', sub.length === 0, sub.join('; '));
}

// K6（round-002 F6）description 一律不导出（防漏钉，沿 J6 先例——实现本就不输出该键，写断言
// 即 PASS，钉住「输入带 description 也不出现」的契约）：导出仅连接语义字段（对齐 ZCode），
// description 仅入库展示（SingleServerExportInput 可携带，但序列化恒丢弃）。
{
  const sub: string[] = [];
  const r = call(() => buildSingleServerExportJson({ name: 'k6-desc', transport: 'stdio', command: 'npx', description: 'x' }));
  if (!r.ok) sub.push(throwDetail(r));
  else {
    if (r.value.includes('description')) sub.push(`输出文本不得含 description 键：${JSON.stringify(r.value)}`);
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(r.value) as Record<string, unknown>; }
    catch (e) { sub.push(`输出应可 JSON.parse：${errMsg(e)}`); }
    const entry = (parsed?.['k6-desc'] ?? null) as Record<string, unknown> | null;
    if (!entry) sub.push('顶层键 k6-desc 缺失');
    else if ('description' in entry) sub.push(`解析产物不得含 description 键：${canon(entry)}`);
  }
  check('K6', 'description 不导出：输入带 description:"x" → 输出文本与解析产物均无 description 键', sub.length === 0, sub.join('; '));
}

// K7（P3 跟进 R4）保留键名包裹形：name 为 'mcpServers'/'servers' 时裸 map 会被
// parseMcpServersJson 保留键分支吞掉（ok:true, servers:[]）→ 序列化改用
// {"mcpServers":{"<name>":{…}}} 包裹形且回读得同名单条目；其余名字维持裸 map（K1 回归）。
{
  const sub: string[] = [];
  for (const reserved of ['mcpServers', 'servers'] as const) {
    const text = buildSingleServerExportJson({ name: reserved, transport: 'stdio', command: 'npx' });
    if (!text.includes('"mcpServers"') || !text.includes(`"${reserved}"`)) sub.push(`${reserved}：缺包裹键/同名键`);
    const back = parseMcpServersJson(text);
    if (!back.ok || back.servers.length !== 1 || back.servers[0]?.name !== reserved) {
      sub.push(`${reserved}：回读不符 ${back.ok ? JSON.stringify(back.servers.map((s) => s.name)) : back.error}`);
    }
  }
  check('K7', '保留键名（mcpServers/servers）→ mcpServers 包裹形 + parseMcpServersJson 回读同名单条目', sub.length === 0, sub.join('; '));
}

// ── L. 方案 A 列表卡片化组（2026-10-19 mcp-settings-plan-a 点3：McpSettings.vue 条目卡片静态钉）──
// 沿 H 组读源码静态钉先例：条目区改为原型 .mxA-card 同构卡片（36px 图标块+右下状态点 / 中性传输
// 标签 / 合并工具·状态行 / 右列操作+开关）后——L1 钉新类存在 + 旧结构三字符串零出现（左状态色条
// inset 3px 0 0、实底传输徽章 mcp-tchip、每卡作用域徽章 mcp-scope-badge）；L3 钉 busy spinner
// 带 prefers-reduced-motion 停用规则（两字符串同断言 + 停用关系邻近性正则）。
// L2 无新断言：空态三态文案由 H 组既有 R5 钉（H1-H5）回归确认保持 PASS，本组注释留痕不计 check。

console.log('\n=== L. 方案 A 列表卡片化组（McpSettings.vue 条目卡片静态钉） ===');

{
  const vueRel = path.join('src', 'renderer', 'components', 'config', 'McpSettings.vue');
  let src = '';
  try {
    src = fs.readFileSync(path.resolve(__dirname, '..', vueRel), 'utf8');
  } catch {
    // 缺文件/不可读：src 保持空串，下列断言全部走 FAIL 分支（不抛错、不崩脚本）。
  }
  // L1 状态点四色映射修饰类（实际采用类名集）：ok→--ok / fail→--fail / busy→--busy / 其余
  //（disabled·未探测·未连接·sse 中性态）→--off。
  const ST_MODIFIERS = ['row__st--ok', 'row__st--fail', 'row__st--busy', 'row__st--off'];
  const missingSt = ST_MODIFIERS.filter((c) => !src.includes(c));
  const legacyLeft = ['mcp-tchip', 'mcp-scope-badge', 'inset 3px 0 0'].filter((s) => src.includes(s));
  check(
    'L1',
    '卡片结构钉：row__ic/row__st 类存在；状态点四色修饰类齐（row__st--ok/--fail/--busy/--off）；mcp-tchip、mcp-scope-badge、inset 3px 0 0 三者源码零出现',
    src.includes('row__ic') && src.includes('row__st') && missingSt.length === 0 && legacyLeft.length === 0,
    src === '' ? 'McpSettings.vue 不可读' : [missingSt.length > 0 ? `缺修饰类：${missingSt.join(',')}` : '', legacyLeft.length > 0 ? `旧结构残留：${legacyLeft.join(',')}` : ''].filter(Boolean).join('; ') || '缺 row__ic/row__st',
  );
  // L2：无新断言——三态文案钉由 H 组 H1-H5 回归确认（上方注释留痕）。
  // L3 spinner：row__spin 类存在，且 prefers-reduced-motion 块内（邻近性 ≤200 字符）对
  // .row__spin 写 animation:none（两字符串同时断言 + 停用关系成立）。
  check(
    'L3',
    'busy spinner：row__spin 类存在且同文件含 prefers-reduced-motion 停用规则（.row__spin → animation:none）',
    src.includes('row__spin') && /prefers-reduced-motion[\s\S]{0,200}\.row__spin\s*\{[^}]*animation:\s*none/.test(src),
    src === '' ? 'McpSettings.vue 不可读' : '缺 row__spin，或 prefers-reduced-motion 未停用其动画',
  );
}

// ── M. 方案 A 编辑器页内化组（2026-10-19 mcp-settings-plan-a 点4：McpSettings.vue 双视图静态钉）──
// 沿 H/L 组读源码静态钉先例：编辑/新建从 Teleport 弹窗（useDialogShell 拖拽缩放壳）改为主区
// 第二视图（v-show 常挂——表单 state 常驻防丢草稿）后钉四条——M1 editorView ref + 双视图
// v-show 结构；M2 编辑弹窗壳移除（mcp-modal 类零出现，编辑壳 refs 零出现）且导入弹窗壳仍在；
// M3 面包屑「返回列表」；M4 页内 Esc（@keydown.escape 绑定 + editorView==='edit' 守卫，
// 不再入全局 esc 栈）。表单字段集/校验/touched/保存链零改动不在本组断言域（无行为级入口）。

console.log('\n=== M. 编辑器页内化组（McpSettings.vue 双视图静态钉） ===');

{
  const vueRel = path.join('src', 'renderer', 'components', 'config', 'McpSettings.vue');
  let src = '';
  try {
    src = fs.readFileSync(path.resolve(__dirname, '..', vueRel), 'utf8');
  } catch {
    // 缺文件/不可读：src 保持空串，下列断言全部走 FAIL 分支（不抛错、不崩脚本）。
  }
  // M1 editorView ref 定义（'list'|'edit'，初值 'list'）+ 主区双视图 v-show 结构
  //（v-show 而非 v-if：表单 state 常驻，切视图不丢草稿）。
  check(
    'M1',
    "editorView ref（'list'|'edit'，初值 'list'）存在；主区双视图 v-show（list/edit 两处）存在",
    src.includes("const editorView = ref<'list' | 'edit'>('list')")
      && src.includes(`v-show="editorView === 'list'"`)
      && src.includes(`v-show="editorView === 'edit'"`),
    src === '' ? 'McpSettings.vue 不可读' : '缺 editorView ref 定义或 v-show 双视图结构',
  );
  // M2 编辑弹窗壳移除：mcp-modal 类源码零出现（原为编辑/导入两弹窗共用类——编辑壳移除后
  // 导入壳类名同步改名为 mcp-import-modal，该字符串不含 "mcp-modal" 子串）；编辑壳标识
  //（editCardRef/editShell/showEditDialog）零出现；导入弹窗壳仍在（importCardRef/importShell）。
  check(
    'M2',
    '编辑弹窗壳移除：mcp-modal 类源码零出现（共用类改名 mcp-import-modal）；editCardRef/editShell/showEditDialog 零出现；导入弹窗壳仍在（importCardRef/importShell）',
    !src.includes('mcp-modal')
      && !src.includes('editCardRef')
      && !src.includes('editShell')
      && !src.includes('showEditDialog')
      && src.includes('importCardRef')
      && src.includes('importShell'),
    src === '' ? 'McpSettings.vue 不可读' : 'mcp-modal 或编辑壳标识残留，或导入弹窗壳标识缺失',
  );
  // M3 面包屑「返回列表」链接钮文案存在（回 list 的五条路径之一，页内常驻可见）。
  check(
    'M3',
    '编辑器面包屑「返回列表」文案存在',
    src.includes('返回列表'),
    src === '' ? 'McpSettings.vue 不可读' : '文案缺失',
  );
  // M4 页内 Esc：@keydown.escape 绑定（组件根）存在，且处理器含 editorView==='edit' 守卫
  // （仅编辑视图回 list；list 视图 Esc 无操作、连续 Esc 无副作用；不入全局 esc 栈）。
  check(
    'M4',
    "页内 Esc：@keydown.escape 绑定存在且处理器含 editorView==='edit' 守卫（回 list）",
    src.includes('@keydown.escape')
      && src.includes("if (editorView.value === 'edit') editorView.value = 'list';"),
    src === '' ? 'McpSettings.vue 不可读' : '缺 @keydown.escape 绑定或 editorView 守卫语句',
  );
  // M5（2026-10-19 round-3 T3）编辑器「删除」语义分裂门控：条目原作用域按 dialogMode.id 前缀
  // 判定（startsWith('user:')/startsWith('project:') → user/project；无前缀 → managed），与
  // formLocation（保存位置）不一致 → toast「删除不可用」拦截并 return（替换正向删不到条目的
  // 静默 return / 反向误删原作用域条目）；footer 删除钮 :disabled 同条件绑定（新 computed
  // deleteBlockedInEditor，saving || deleteBlockedInEditor）。
  // RED 依据：现状无 id 前缀原作用域判定、无「删除不可用」文案、无 deleteBlockedInEditor、
  // 删除钮仅 :disabled="saving"。
  check(
    'M5',
    '编辑器删除门控：id 前缀原作用域判定 + 「删除不可用」toast + footer 删除钮 deleteBlockedInEditor disabled 绑定',
    src.includes("mode.id.startsWith('user:')")
      && src.includes("mode.id.startsWith('project:')")
      && src.includes('删除不可用')
      && src.includes('const deleteBlockedInEditor = computed')
      && src.includes(':disabled="saving || deleteBlockedInEditor"'),
    src === '' ? 'McpSettings.vue 不可读' : '缺 id 前缀原作用域判定/「删除不可用」toast/deleteBlockedInEditor disabled 绑定',
  );
}

// ── N. 方案 A 表单⇄JSON 双模式 + 超时字段组（2026-10-19 mcp-settings-plan-a 点5）──
// 沿 H/L/M 组读源码静态钉先例：编辑器「表单 | JSON」双模式（切 JSON 序列化 / 切回表单解析
// 回填 / JSON 模式保存）与三作用域共用超时字段落地后钉六条——渲染层组件无纯函数可行为级
// 断言（selftest 不依赖 Electron runtime），只读仓库内源文件，绝不触碰磁盘配置。

console.log('\n=== N. 表单⇄JSON 双模式 + 超时字段组（McpSettings.vue 静态钉） ===');

{
  const vueRel = path.join('src', 'renderer', 'components', 'config', 'McpSettings.vue');
  let src = '';
  try {
    src = fs.readFileSync(path.resolve(__dirname, '..', vueRel), 'utf8');
  } catch {
    // 缺文件/不可读：src 保持空串，下列断言全部走 FAIL 分支（不抛错、不崩脚本）。
  }
  // N1 双模式状态定义存在（指令点1 四件套：editMode/jsonText/jsonError/jsonParsing）。
  check(
    'N1',
    "双模式状态定义存在：editMode = ref<'form' | 'json'>('form')、jsonText/jsonError/jsonParsing ref",
    src.includes("const editMode = ref<'form' | 'json'>('form')")
      && src.includes("const jsonText = ref('')")
      && src.includes("const jsonError = ref('')")
      && src.includes('const jsonParsing = ref(false)'),
    src === '' ? 'McpSettings.vue 不可读' : '缺 editMode/jsonText/jsonError/jsonParsing 状态定义',
  );
  // N2 分段胶囊「表单」「JSON」两项文案存在（可切换实装形态）。
  check(
    'N2',
    '分段胶囊「表单」「JSON」两项文案存在',
    src.includes('表单</button>') && src.includes('JSON</button>'),
    src === '' ? 'McpSettings.vue 不可读' : '分段胶囊两项文案缺失',
  );
  // N3 两条 jsonError 文案字面存在（servers>1 / 编辑态改名守卫）。
  check(
    'N3',
    'jsonError 文案字面存在：一次只支持一台 / 编辑态不可改名',
    src.includes('JSON 模式一次只支持编辑一台服务器')
      && src.includes('编辑态不可改名：JSON 键名必须与当前服务器名称一致'),
    src === '' ? 'McpSettings.vue 不可读' : 'jsonError 文案缺失',
  );
  // N4（2026-10-19 验收 review R3 改钉）「复制 JSON」按钮本体钉：@click="copyJson"（全文唯一）
  // + toast 文案钉 pushToast('已复制 JSON')（文案钉保留，并入本条 check）。原
  // src.includes('复制 JSON') 假通通道移除（该子串同时存在于 toast 文案与注释）。
  check(
    'N4',
    '「复制 JSON」按钮本体钉：@click="copyJson" + toast 字面 pushToast(\'已复制 JSON\')',
    src.includes('@click="copyJson"') && src.includes("pushToast('已复制 JSON')"),
    src === '' ? 'McpSettings.vue 不可读' : '缺 @click="copyJson" 按钮绑定或已复制 toast 字面',
  );
  // N5 超时校验文案字面存在（1–120000 为 en-dash U+2013，与计划/指令逐字一致）。
  check(
    'N5',
    '超时校验文案字面存在（超时须为 1–120000 的整数（毫秒），en-dash）',
    src.includes('超时须为 1–120000 的整数（毫秒）'),
    src === '' ? 'McpSettings.vue 不可读' : '超时校验文案缺失',
  );
  // N6 提示条文案字面存在（由当前表单配置实时生成）。
  check(
    'N6',
    'JSON 提示条文案字面存在（由当前表单配置实时生成）',
    src.includes('由当前表单配置实时生成'),
    src === '' ? 'McpSettings.vue 不可读' : '提示条文案缺失',
  );
  // N7（round-002 F1 修复）JSON 往返键改名 hint 快照闭环：切 JSON 前 jsonRenameHints 快照
  // 当前 KV 行改名映射（renameFrom 不进 JSON 文本，经快照跨 JSON 模式存活）；parseJsonDraft
  // 回填时哨兵行 sentinelfor = hints[当前键] ?? 当前键（JSON 内二次改名维持无 hint 现状）；
  // openEditor/resetForm 清空快照（防跨条目污染）。静态钉五类 token：定义 / 快照赋值 /
  // 回填入参（env+headers 两路）/ 哨兵行回退式。
  check(
    'N7',
    'JSON 往返改名 hint 快照闭环：jsonRenameHints 定义 + 切 JSON 快照 + kvRowsFromParsed 回填入参 + 哨兵行 hints 回退',
    src.includes('const jsonRenameHints = ref')
      && src.includes('jsonRenameHints.value = { env: kvRowsRenameHints(formEnvRows.value), headers: kvRowsRenameHints(formHeaderRows.value) }')
      && src.includes('kvRowsFromParsed(server.env, jsonRenameHints.value.env)')
      && src.includes('kvRowsFromParsed(server.headers, jsonRenameHints.value.headers)')
      && src.includes('sentinelfor: hints?.[k] ?? k'),
    src === '' ? 'McpSettings.vue 不可读' : 'jsonRenameHints 快照/回填 token 缺失',
  );
  // N8（2026-10-19 验收 review R1）跨作用域另存撞名防线：nameError 重名分支去掉 !isEditMode
  // 豁免、必须含 id 豁免比对（编辑管理库自身条目豁免自己；user:/project: 前缀 id 不豁免）；
  // saveForm 双保险——user/project 条目另存为管理库且撞名时 toast 失败并 return（不进新增
  // push；主进程 sanitize 保留第一条会静默丢条）。RED 依据：现状缺 `s.id !==` 与该 toast 字面。
  check(
    'N8',
    '跨作用域另存撞名防线：nameError 重名分支 id 豁免比对 + saveForm 撞名失败 toast',
    src.includes('s.name === name') && src.includes('s.id !==') && src.includes('保存失败：与现有服务器重名（管理库内名称唯一）'),
    src === '' ? 'McpSettings.vue 不可读' : '缺 id 豁免比对 token 或撞名失败 toast 字面',
  );
  // N9（2026-10-19 验收 review R2）JSON 保存停留契约：saveForm 体内 editMode.value = 'form'
  // 必须出现在 formValid 判定之后（校验失败停留 JSON 侧红条，不翻表单侧）；红条字面
  // 「表单校验未通过：」存在。静态顺序断言：取 saveForm 函数体切片（至下一函数
  // handleDelete 起点），体内首个 formValid 代码判定 `if (!formValid.value)` 出现位置必须
  // 先于 editMode 赋值语句（注释文字不算命中；2026-10-19 round-002 F1 收窄 token，
  // 防裸 formValid 被切片内注释先命中）。
  {
    const n9Start = src.indexOf('async function saveForm');
    const n9End = src.indexOf('function handleDelete', n9Start);
    const n9Body = n9Start >= 0 && n9End > n9Start ? src.slice(n9Start, n9End) : '';
    const n9Valid = n9Body.indexOf('if (!formValid.value)');
    const n9Switch = n9Body.indexOf("editMode.value = 'form'");
    check(
      'N9',
      'JSON 保存停留契约：saveForm 先 formValid 判定后 editMode 翻回表单侧（失败停留 JSON 侧红条）',
      n9Body !== '' && n9Valid >= 0 && n9Switch > n9Valid && src.includes('表单校验未通过：'),
      src === '' ? 'McpSettings.vue 不可读' : '缺 formValid 判定/「表单校验未通过：」红条字面，或语句顺序不符',
    );
  }
  // N10（P3 跟进 R9）JSON 非法超时反馈：parseJsonDraft 对原始 JSON 条目内非法 timeoutMs
  //（非 1..120000 整数）红条「超时须为 1–120000 的整数（毫秒）：JSON 中的 timeoutMs 未生效」
  // 停留 JSON 侧（主进程 normalize 静默丢字段，此前保存成功但超时未生效零提示）。
  check(
    'N10',
    'JSON 非法超时红条字面存在（超时须为 1–120000 的整数（毫秒）：JSON 中的 timeoutMs 未生效）',
    src.includes('超时须为 1–120000 的整数（毫秒）：JSON 中的 timeoutMs 未生效'),
    src === '' ? 'McpSettings.vue 不可读' : 'JSON 非法超时红条文案缺失',
  );
  // N11（2026-10-19 round-3 T2）JSON 保存取消后 editMode 残留负向钉：saveForm 函数体「落盘链
  // 之前」区段（async function saveForm → saving.value = true）内 editMode.value = 'form' 零
  // 出现——editMode 翻回表单侧只允许发生在保存成功点（saveScopedForm 成功块 / managed 成功块，
  // 均在落盘链之后），JSON 分支的校验失败红条与覆盖确认「取消」路径必须停留 JSON 侧（R2 停留
  // 契约邻接缺口）。切片取落盘链起点 saving.value = true 为界：成功块内的翻转在界后不计。
  // RED 依据：现状翻转语句位于 JSON 分支内（:1023 附近，先于落盘链）。
  {
    const n11Start = src.indexOf('async function saveForm');
    const n11End = src.indexOf('saving.value = true', n11Start);
    const n11Body = n11Start >= 0 && n11End > n11Start ? src.slice(n11Start, n11End) : '';
    check(
      'N11',
      "JSON 保存取消后 editMode 残留负向钉：saveForm 落盘链之前区段 editMode.value = 'form' 零出现",
      n11Body !== '' && !n11Body.includes("editMode.value = 'form'"),
      src === '' ? 'McpSettings.vue 不可读' : 'saveForm 落盘链之前区段仍存在 editMode 翻转语句（先于落盘链）',
    );
  }
  // N12（2026-10-19 round-3 T1，仿 N9 切片顺序法；2026-10-29 P3-A 改钉兜底 toast 字面）P2 陈旧
  // 快照覆盖：saveScopedForm 函数体切片（async function saveScopedForm → async function saveForm）
  // 内首个 await refresh() 必须先于 hasSameName 覆盖确认预查（保存时刻拉新快照，编辑器长开期间
  // 外部并发写入的同名条目不再被陈旧快照静默放行）；且体内含 res.overwrote 消费与兜底 toast
  // 字面「已覆盖同名条目（列表可能未及时刷新）」（兜底告知中性化，H4——预查快照负缓存盲区下
  // 不归因外部写入，防零提示；toast 时长 3200ms 与中文括号全角形态按字面钉）。
  // RED 依据（历史）：现状 await refresh() 仅存在于写入成功后（先于判定不成立）、res.overwrote 零消费。
  {
    const n12Start = src.indexOf('async function saveScopedForm');
    const n12End = src.indexOf('async function saveForm', n12Start);
    const n12Body = n12Start >= 0 && n12End > n12Start ? src.slice(n12Start, n12End) : '';
    const n12Refresh = n12Body.indexOf('await refresh()');
    const n12Same = n12Body.indexOf('hasSameName');
    check(
      'N12',
      'P2 陈旧快照覆盖修复：saveScopedForm 内 await refresh() 先于 hasSameName 预查 + 消费 res.overwrote + 兜底 toast 字面',
      n12Body !== ''
        && n12Refresh >= 0 && n12Same >= 0 && n12Refresh < n12Same
        && n12Body.includes('res.overwrote')
        && n12Body.includes('已覆盖同名条目（列表可能未及时刷新）'),
      src === '' ? 'McpSettings.vue 不可读' : 'await refresh() 未先于 hasSameName 预查，或缺 res.overwrote 消费/兜底 toast 字面',
    );
  }
}

// ── O. 导入解析收口主进程组（2026-10-19 mcp-settings-plan-a 点6：McpSettings.vue 删双副本）──
// 沿 H/L/M/N 组读源码静态钉先例：导入解析管道收口主进程（window.claudeLink.parseMcpJson 桥）
// 后钉四条——O1 渲染层导入归一副本函数 normalizeImportEntry 源码零出现；O2 哨兵常量名
// mask_sentinel（大小写不敏感子串，含主进程名 MCP_MASK_SENTINEL 变体，注释提及同算）在
// src/renderer 全部 .ts/.vue 零出现（渲染层唯一合法引用为 shared 的 MCP_VALUE_MASK）；O3
// 渲染层不再有哨兵字面量定义形态（UI 展示文本中的 •••••••• 不属定义、不算命中）且 shared
// 模块 mcp-json.ts 恰一处字面定义（全仓唯一字面来源）；O4（2026-10-19 验收 review R7 追加）
// mcp:parseMcpJson 通道四点接线钉（常量→注册→桥→调用，回归钉、四点现状均在、首跑即 PASS）。
// 点6 RED：O1/O2/O3 因副本仍在而 FAIL；实现后全 PASS。

console.log('\n=== O. 导入解析收口主进程组（McpSettings.vue 删双副本静态钉） ===');

{
  // O1 导入归一副本清零：normalizeImportEntry 在 McpSettings.vue 源码零出现（含注释——
  // 副本连同其文档块一并删除）。
  const oVueRel = path.join('src', 'renderer', 'components', 'config', 'McpSettings.vue');
  let oVueSrc = '';
  try {
    oVueSrc = fs.readFileSync(path.resolve(__dirname, '..', oVueRel), 'utf8');
  } catch {
    // 缺文件/不可读：保持空串，O1 走 FAIL 分支（不抛错、不崩脚本）。
  }
  check('O1', '导入归一副本清零：normalizeImportEntry 在 McpSettings.vue 源码零出现',
    oVueSrc !== '' && !oVueSrc.includes('normalizeImportEntry'),
    oVueSrc === '' ? 'McpSettings.vue 不可读' : 'normalizeImportEntry 残留');

  // O2/O3 共用：node fs 递归遍历 src/renderer 全部 .ts/.vue 源码（沿静态钉先例只读仓库
  // 源码；结果仅存内存、跑完即弃，不留任何临时文件）。
  let rendererSources: Array<{ file: string; src: string }> = [];
  try {
    const collect = (dir: string): Array<{ file: string; src: string }> => {
      const out: Array<{ file: string; src: string }> = [];
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) out.push(...collect(p));
        else if (ent.isFile() && (ent.name.endsWith('.ts') || ent.name.endsWith('.vue'))) {
          out.push({ file: p, src: fs.readFileSync(p, 'utf8') });
        }
      }
      return out;
    };
    rendererSources = collect(path.resolve(__dirname, '..', 'src', 'renderer'));
  } catch {
    // 目录不可读：保持空数组，O2/O3 走 FAIL 分支。
  }
  const rendererRoot = path.resolve(__dirname, '..', 'src', 'renderer');
  const relOf = (p: string): string => path.relative(rendererRoot, p);

  // O2 哨兵常量名渲染层零出现：mask_sentinel 子串（大小写不敏感——本地副本名 MASK_SENTINEL
  // 与主进程名变体 MCP_MASK_SENTINEL 一并封禁，注释提及同样算命中）；渲染层唯一合法引用是
  // shared 的 MCP_VALUE_MASK（该名不含 mask_sentinel 子串）。
  const o2Hits = rendererSources.filter((s) => /mask_sentinel/i.test(s.src)).map((s) => relOf(s.file));
  check('O2', '哨兵常量名渲染层零出现：src/renderer 全部 .ts/.vue 无 mask_sentinel 子串（大小写不敏感，含 MCP_MASK_SENTINEL 变体与注释提及）',
    rendererSources.length > 0 && o2Hits.length === 0,
    o2Hits.length > 0 ? `残留文件：${o2Hits.join(', ')}` : 'src/renderer 不可读/为空');

  // O3 哨兵字面量渲染层无定义：赋值/常量定义形态 `= '••••••••'` 零出现——UI 文案/注释中的
  // 展示性 ••••••••（如点5 JSON 注释行「已存密钥以 •••••••• 脱敏显示」）不匹配该定义形态、
  // 不算命中；且 src/shared/mcp-json.ts 中 '••••••••'（带引号字面）恰 1 处（唯一字面定义；
  // 主进程 mcp-config.ts:MCP_MASK_SENTINEL 为其 re-export，两名字一常量）。
  const o3DefineHits = rendererSources.filter((s) => /=\s*'•{8}'/.test(s.src)).map((s) => relOf(s.file));
  let o3SharedCount = -1;
  try {
    o3SharedCount = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'shared', 'mcp-json.ts'), 'utf8').split("'••••••••'").length - 1;
  } catch {
    // 不可读：保持 -1 → 走 FAIL 分支。
  }
  check('O3', "哨兵字面量渲染层无定义形态（= '••••••••' 零出现，展示性文案不算命中）且 shared/mcp-json.ts 恰 1 处 '••••••••' 字面定义",
    rendererSources.length > 0 && o3DefineHits.length === 0 && o3SharedCount === 1,
    o3DefineHits.length > 0 ? `定义残留：${o3DefineHits.join(', ')}` : `shared 字面计数=${o3SharedCount}（应恰 1）`);

  // O4（2026-10-19 验收 review R7）mcp:parseMcpJson 通道接线钉：常量定义（types/ipc.ts）→
  // ipcMain.handle 注册（ipc-handlers.ts）→ preload 桥（api.ts）→ 渲染层调用
  // （McpSettings.vue），四点任一缺失 FAIL（防通道拼错/注册丢失无测试可捕）。preload 断言
  // 钉桥实现形态（ipcRenderer.invoke 该通道），类型/注释命中不算（2026-10-19 round-002
  // M1 收紧）。属回归钉：
  // 四点接线现状均在，预期首跑即 PASS（编排器裁定：RED-first 适用于 N8/N9 行为变更项；
  // O4 钉既有接线，无法对现状 RED，报告中申报即可）。
  {
    const o4Read = (rel: string): string => {
      try {
        return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
      } catch {
        return '';
      }
    };
    const o4IpcTypes = o4Read(path.join('src', 'shared', 'types', 'ipc.ts'));
    const o4Handlers = o4Read(path.join('src', 'main', 'ipc-handlers.ts'));
    const o4Preload = o4Read(path.join('src', 'preload', 'api.ts'));
    const o4Missing: string[] = [];
    if (!o4IpcTypes.includes("MCP_PARSE_JSON: 'mcp:parseMcpJson'")) o4Missing.push('ipc.ts 常量');
    if (!o4Handlers.includes('regInvokeHandler(IPC_CHANNELS.MCP_PARSE_JSON')) o4Missing.push('ipc-handlers 注册');
    if (!o4Preload.includes('ipcRenderer.invoke(IPC_CHANNELS.MCP_PARSE_JSON')) o4Missing.push('preload 桥');
    if (!(oVueSrc !== '' && oVueSrc.includes('claude.parseMcpJson('))) o4Missing.push('vue 调用');
    check(
      'O4',
      'mcp:parseMcpJson 通道四点接线：常量 → 注册 → 桥 → 调用',
      o4Missing.length === 0,
      o4Missing.length > 0 ? `缺：${o4Missing.join('、')}` : '四点文件不可读',
    );
  }

  // O5（2026-10-19 round-3 T4）导入哨兵回导过滤钉：confirmImport 函数体切片
  //（async function confirmImport → const importCardRef）入库前过滤哨兵值键
  //（filter(([, v]) => v !== MCP_VALUE_MASK)，env/headers 同款），且旧「原样入库」形态
  //（item.env = parsed.env / item.headers = parsed.headers）零出现——防「复制 JSON」产出的
  // 哨兵文本经导入弹窗回导为字面密钥静默入库。正负两向：含过滤形态、不含旧形态。
  // RED 依据：现状 confirmImport 无过滤、parsed.env/parsed.headers 原样赋值入库两处。
  {
    const o5Start = oVueSrc.indexOf('async function confirmImport');
    const o5End = oVueSrc.indexOf('const importCardRef', o5Start);
    const o5Body = o5Start >= 0 && o5End > o5Start ? oVueSrc.slice(o5Start, o5End) : '';
    check(
      'O5',
      '导入哨兵回导过滤：confirmImport 切片含 !== MCP_VALUE_MASK 过滤形态且旧「原样入库」形态零出现',
      o5Body !== ''
        && o5Body.includes('!== MCP_VALUE_MASK')
        && !o5Body.includes('item.env = parsed.env')
        && !o5Body.includes('item.headers = parsed.headers'),
      oVueSrc === '' ? 'McpSettings.vue 不可读' : 'confirmImport 缺哨兵过滤形态或残留原样入库旧形态',
    );
  }
}

// ── P. 保存位置联动组（2026-10-29 mcp-scope-misplacement-fix P1-A：R1/R2/H3；P1-B 补 P4：H1；P3-A 补 P5：H5；2026-10-29 mcp-import-scope-and-segment-lock 改动点 C：P3 改写 + P6 新增）──
// 沿 H/L/M/N 组读源码静态钉先例：openAdd 保存位置三态无条件随入口 rail 联动 + resetForm 去预填
// + 保存位置段位锁定恒态 + 导入作用域跟随栏位。缺陷背景（docs/plans/2026-10-29-mcp-scope-misplacement-review-report.md
// R1/R2/H3）：openAdd 不设 formLocation 且仅 formHasContent()===false 才 resetForm()——上次编辑
// user/project 条目或手动切段位后取消，从管理库 rail 再点「添加服务器」时保存位置残留「项目级×
// 上次目录」，保存写进错误目录的 .mcp.json；另 resetForm 恒预填 projectDirs[0]，使
// switchLocation('project') 的空值预选分支成死代码。P5（P3-A 补，H5）：MCP_WRITE_SCOPED 白名单
// 拒绝文案补「最近工作区上限」说明——ipc-handlers.ts 拒绝错误改为含 ${MAX_ENTRIES} 插值的模板串
//（上限随常量演进，不与实际上限漂移），MAX_ENTRIES 经 workspace-history import 引入，旧
// 文案整串（三种引号形态）零出现。
// 改动点 C（2026-10-29 mcp-import-scope-and-segment-lock）：段位切换器整体退化为只读指示
//（switchLocation 删除，P3 改钉锁定恒态）；导入目标作用域跟随 entry rail（P6 新增钉，对
// 改动点 B 前的旧实现判 FAIL）。

console.log('\n=== P. 保存位置联动组（openAdd 联动 / resetForm 去预填 / 段位锁定恒态 / 导入作用域跟随） ===');

{
  const pVueRel = path.join('src', 'renderer', 'components', 'config', 'McpSettings.vue');
  let pSrc = '';
  try {
    pSrc = fs.readFileSync(path.resolve(__dirname, '..', pVueRel), 'utf8');
  } catch {
    // 缺文件/不可读：src 保持空串，下列断言全部走 FAIL 分支（不抛错、不崩脚本）。
  }

  // P1 openAdd 联动：函数体切片（function openAdd → function openEdit）含 activeScope 取值与
  // formLocation 两条联动赋值（project rail 直取该目录 path / managed·user rail 取 scope.kind），
  // 且联动赋值出现在 resetForm() 调用之后（resetForm 亦写 formLocation='managed'，先联动会被
  // clobber）；负向：去行注释切片内 resetForm() 之后不得再出现 formHasContent（联动不得被
  // formHasContent 门控——钉「不依赖 formHasContent」语义；注释提及不算命中）。
  // round-001 F1/F2 加固：①两条联动赋值必须位于轨道 if/else 直下的一层嵌套缩进（现实现为
  // 4 空格，恰 2 行）——若被并进 if (!formHasContent()) 块内会整体再深一层缩进，计数归零即
  // FAIL；②formHasContent 守卫行必须是「if (!formHasContent()) resetForm();」无块单语句形态
  //（块化即联动有处可进，直接 FAIL）；③formProjectDir 两条联动赋值 token（project rail 直取
  // scope.path / 非 project rail 清空）缺一即 FAIL（防单删该行钉全绿）。
  {
    const p1Start = pSrc.indexOf('function openAdd');
    const p1End = pSrc.indexOf('function openEdit', p1Start);
    const p1Body = p1Start >= 0 && p1End > p1Start ? pSrc.slice(p1Start, p1End) : '';
    const p1Stripped = p1Body.replace(/\/\/[^\n]*/g, ''); // 去行注释：负向判定只认代码
    const p1Reset = p1Stripped.indexOf('resetForm()');
    const p1LocProject = p1Stripped.indexOf("formLocation.value = 'project'");
    const p1LocKind = p1Stripped.indexOf('formLocation.value = scope.kind');
    const p1GatedAfterReset = p1Reset >= 0 && p1Stripped.indexOf('formHasContent', p1Reset) !== -1;
    const p1IndentHits = (p1Stripped.match(/^ {4}formLocation\.value = /gm) ?? []).length;
    const p1GateLine = p1Stripped.split('\n').find((l) => l.includes('if (!formHasContent())')) ?? '';
    const p1GateBare = /if \(!formHasContent\(\)\) resetForm\(\);\s*$/.test(p1GateLine);
    check(
      'P1',
      'openAdd 保存位置三态无条件随入口 rail 联动（activeScope 取值 + project/managed·user 双分支赋值，联动在 resetForm() 之后、不受 formHasContent 门控、两条 formLocation 联动赋值位于轨道 if/else 直下一层缩进、守卫行为无块单语句、formProjectDir 双 token 在位）',
      p1Body !== ''
        && p1Stripped.includes('activeScope.value')
        && p1LocProject >= 0 && p1LocKind >= 0
        && p1Reset >= 0 && p1Reset < p1LocProject && p1Reset < p1LocKind
        && !p1GatedAfterReset
        && p1IndentHits === 2
        && p1GateBare
        && p1Stripped.includes('formProjectDir.value = scope.path')
        && p1Stripped.includes("formProjectDir.value = ''"),
      pSrc === '' ? 'McpSettings.vue 不可读' : 'openAdd 缺 rail 联动赋值、联动先于 resetForm()（会被 clobber）、联动被 formHasContent 门控或并入其 if 块、formProjectDir 联动赋值缺失',
    );
  }

  // P2 resetForm 去预填：函数体切片（function resetForm → /** 表单是否含用户已填内容）恰含
  // 一次 formProjectDir.value = ''（清空而非预填；project 目录仅由 openAdd 按入口 rail 联动写入，
  // 空值由 formValid 的非空判定拦截保存），且切片不再含 projectDirs.value[0] 子串
  //（projectDirs 为空数组时 formValid 的 formProjectDir 非空判定拦截保存，既有「暂无已知项目
  // 目录」hint 兜底）。
  // 2026-10-29 改动点 C：措辞同步（段位切换器已退化为只读指示、switchLocation 预选分支随函数
  // 一并删除，本钉原引用的「预选改由 switchLocation('project') 预选 projectDirs[0] 承担」表述
  // 已失效）；断言主体一字未改。
  {
    const p2Start = pSrc.indexOf('function resetForm');
    const p2End = pSrc.indexOf('/** 表单是否含用户已填内容', p2Start);
    const p2Body = p2Start >= 0 && p2End > p2Start ? pSrc.slice(p2Start, p2End) : '';
    const p2AssignCount = p2Body.split("formProjectDir.value = '';").length - 1;
    // round-001 F4：负向子断言改用去行注释切片（先例：P1 p1Stripped）——注释含 projectDirs.value[0]
    // 字样不再误报；正向清空赋值计数维持 p2Body 判定（计数语义：真实代码恰一处）。
    const p2Stripped = p2Body.replace(/\/\/[^\n]*/g, '');
    check(
      'P2',
      "resetForm 去预填：切片恰含一次 formProjectDir.value = '' 且不再含 projectDirs.value[0]",
      p2Body !== '' && p2AssignCount === 1 && !p2Stripped.includes('projectDirs.value[0]'),
      pSrc === '' ? 'McpSettings.vue 不可读' : `resetForm 仍预填 projectDirs[0] 或清空赋值形态不符（计数=${p2AssignCount}）`,
    );
  }

  // P3 保存位置段位锁定恒态（2026-10-29 mcp-import-scope-and-segment-lock 改动点 C 改写）：
  // 原钉「编辑态锁定」（:disabled="isEditMode" + switchLocation 首行 isEditMode 守卫）升级为
  // 「锁定恒态（编辑态与新建态均锁定）」——段位切换器退化为只读指示，仅指示保存位置，入口 rail
  // 是唯一决定落点的手段（计划 §1.3/§3.A）。三段子断言：
  //   ① 模板 mcp-seg 区（保存位置 role="group" 的 .mcp-seg 开标签 → 副标题 hint 之间，
  //      防误匹配他处同 token）内 v-for="loc in LOCATION_ORDER" 仍在（三段指示本体未删）；
  //   ② 负向：该区内无 @click="switchLocation(loc)"，且任何 switchLocation( 调用绑定零出现
  //      （段位不再可交互）；
  //   ③ 按钮为静态 disabled 属性（出现 disabled、不出现 :disabled= 动态绑定形态——恒只读，
  //      不随 isEditMode 开关）；
  //   ④ 负向（全文件）：switchLocation 零出现——函数定义（含旧 projectDirs[0] 预选分支）与
  //      全部引用一并删除，防「删了点击绑定但函数留着」的回退半态。
  {
    const p3SegStart = pSrc.indexOf('class="mcp-seg" role="group" aria-label="保存位置"');
    const p3SegEnd = pSrc.indexOf('{{ locationHint }}', p3SegStart);
    const p3Seg = p3SegStart >= 0 && p3SegEnd > p3SegStart ? pSrc.slice(p3SegStart, p3SegEnd) : '';
    const p3NoClick = !p3Seg.includes('@click="switchLocation(loc)"') && !/switchLocation\s*\(/.test(p3Seg);
    // 静态 disabled 属性：裸 `disabled` 或 `disabled="disabled"` 皆可（后随空白/`>`/`=`）；
    // 前导 `\s` 保证不误命中 `:disabled`（其前一字符为冒号，非空白），动态形态另由下方排除。
    const p3StaticDisabled = /\sdisabled(?=[\s>=])/.test(p3Seg) && !p3Seg.includes(':disabled=');
    check(
      'P3',
      '保存位置段位锁定恒态（编辑态与新建态均锁定，退化为只读指示）：LOCATION_ORDER 按钮保留 + 无 @click/switchLocation 绑定 + 静态 disabled（无 :disabled= 动态形态）+ 全文件 switchLocation 零出现',
      p3Seg !== ''
        && p3Seg.includes('v-for="loc in LOCATION_ORDER"')
        && p3NoClick
        && p3StaticDisabled
        && !pSrc.includes('switchLocation'),
      pSrc === '' ? 'McpSettings.vue 不可读' : '段位按钮仍有 @click/switchLocation 绑定、仍是 :disabled 动态形态、或全文件仍残留 switchLocation（函数定义/引用）',
    );
  }

  // P4 新增态哨兵 KV 行拦截（P1-B，H1；V2 载体分化）：saveForm 函数体切片（async function
  // saveForm → function handleDelete）含 !isEditMode.value 门控（编辑态哨兵照传由主进程还原，
  // 行为零改动）与 r.value === MCP_VALUE_MASK 行判定形态（仅拦键非空的哨兵行）；拦截提示字面
  // 「检测到残留的加密占位值，请清空对应行后重新填写」落在模块级常量 SENTINEL_BLOCK_MSG
  // 定义处（位于 saveForm 切片之外，故用 pSrc 断言），切片内两种载体均消费该常量：
  //   · JSON 模式（V2）：jsonError.value = `表单校验未通过：${SENTINEL_BLOCK_MSG}` + return，
  //     提示载体与既有 JSON 校验失败（表单校验未通过：前缀）同形，停留 JSON 侧（不 toast、
  //     不翻 editMode、不置 submitAttempted，与 N9/N11 停留契约统一）；门控 editMode.value === 'json'；
  //   · 表单模式：pushToast(SENTINEL_BLOCK_MSG) + return（与既有保存失败 toast 形态一致）。
  // 两种载体均必须以 return 收束（只提示不 return 会继续落盘、静默丢 env 哨兵行），且均先于
  // 切片内 saving.value = true（挪到落盘链之后即失效；本分支不清表单、不翻 editMode、不翻
  // 转 saving 态）。
  // RED 依据：现状 saveForm 无该拦截分支，env/headers 哨兵行在新增态被主进程
  // restoreMaskedMcpServers 按「无已存条目」静默丢弃，保存谎报成功。
  // V2 RED 依据：现状两种载体未分化（JSON 模式也在走 toast），无 SENTINEL_BLOCK_MSG 常量。
  {
    const p4Start = pSrc.indexOf('async function saveForm');
    const p4End = pSrc.indexOf('function handleDelete', p4Start);
    const p4Body = p4Start >= 0 && p4End > p4Start ? pSrc.slice(p4Start, p4End) : '';
    const p4MsgUse = p4Body.indexOf('SENTINEL_BLOCK_MSG');
    const p4Save = p4Body.indexOf('saving.value = true');
    // 字面落在模块级常量定义处（saveForm 切片之外）→ 用整份源码断言。
    const p4Literal = pSrc.includes('检测到残留的加密占位值，请清空对应行后重新填写');
    // 表单模式载体：pushToast(SENTINEL_BLOCK_MSG) 后紧跟 return;（\s* 覆盖 CRLF 与缩进）。
    const p4FormCarrier = /pushToast\(SENTINEL_BLOCK_MSG\);\s*\n\s*return;/.test(p4Body);
    // JSON 模式载体：jsonError.value = `表单校验未通过：${SENTINEL_BLOCK_MSG}`; 后紧跟 return;
    // （\$\{ 匹配字面 ${，非正则分组）。
    const p4JsonCarrier = /jsonError\.value = `表单校验未通过：\$\{SENTINEL_BLOCK_MSG\}`;\s*\n\s*return;/.test(p4Body);
    check(
      'P4',
      '新增态哨兵 KV 行拦截两种载体：JSON 模式 jsonError 红条（表单校验未通过：前缀，门控 editMode.value === \'json\'）+ 表单模式 toast，共用 SENTINEL_BLOCK_MSG 常量；均以 return 收束且先于 saving.value = true；含 !isEditMode 门控 + 值===MCP_VALUE_MASK 行判定',
      p4Body !== ''
        && p4Literal
        && p4Body.includes('!isEditMode.value')
        && p4Body.includes('r.value === MCP_VALUE_MASK')
        && p4Body.includes('SENTINEL_BLOCK_MSG')
        && p4Body.includes("editMode.value === 'json'")
        && p4FormCarrier
        && p4JsonCarrier
        && p4Save >= 0 && p4MsgUse >= 0 && p4MsgUse < p4Save,
      pSrc === '' ? 'McpSettings.vue 不可读' : 'saveForm 缺新增态哨兵行拦截分支、缺 V2 载体分化（JSON→jsonError 红条 / 表单→toast，共用 SENTINEL_BLOCK_MSG）、拦截未以 return 退出，或拦截位于落盘链 saving.value = true 之后（失效）',
    );
  }

  // P5（2026-10-29 mcp-scope-misplacement-fix P3-A，H5）WRITE 白名单拒绝文案补「最近工作区上限」
  // 说明：ipc-handlers.ts MCP_WRITE_SCOPED 拒绝路径为模板串「目标目录不在已知项目目录集中，已拒绝
  // 写入：该目录已不在最近工作区（上限 ${MAX_ENTRIES} 条），在对应目录重新打开会话后重试」（上限
  // 随常量演进，不与实际上限漂移）；MAX_ENTRIES 经 workspace-history import 行引入；负向：
  // 旧文案整串（'目标目录不在已知项目目录集中，已拒绝写入'）零出现（防只留半句旧文案；新模板串
  // 以旧文案为前缀但呈反引号模板形态，前缀后随全角冒号不误伤）。round-001 F6：负向放宽为三种
  // 引号形态（'/"/`）整串零出现的正则——旧文案无论用哪种引号还原为独立整串都 FAIL。
  // MCP_EXPORT_SCOPED 同款文案
  //（「已拒绝导出」）按计划边界不改，不在本钉范围。
  {
    const p5Rel = path.join('src', 'main', 'ipc-handlers.ts');
    let p5Src = '';
    try {
      p5Src = fs.readFileSync(path.resolve(__dirname, '..', p5Rel), 'utf8');
    } catch {
      // 缺文件/不可读：保持空串，P5 走 FAIL 分支（不抛错、不崩脚本）。
    }
    const p5ImportLine = p5Src.split('\n').find((l) => l.includes("from './modules/workspace-history'")) ?? '';
    check(
      'P5',
      'WRITE 白名单拒绝文案补「最近工作区上限」说明：MCP_WRITE_SCOPED 拒绝为含 ${MAX_ENTRIES} 插值模板串 + workspace-history import 引入 MAX_ENTRIES + 旧文案整串（三种引号形态）零出现',
      p5Src !== ''
        && p5Src.includes('该目录已不在最近工作区（上限 ${MAX_ENTRIES} 条）')
        && /MAX_ENTRIES\s*[,}]/.test(p5ImportLine)
        && !/['"`]目标目录不在已知项目目录集中，已拒绝写入['"`]/.test(p5Src),
      p5Src === '' ? 'ipc-handlers.ts 不可读' : 'MCP_WRITE_SCOPED 拒绝文案未补上限说明、缺 MAX_ENTRIES import 或旧文案整串残留',
    );
  }

  // P6 导入作用域跟随栏位（2026-10-29 mcp-import-scope-and-segment-lock 改动点 C 新增；计划
  // §3.B 改动点 B 的静态契约钉）：导入目标不再恒为管理库，改为跟随当前入口 rail——
  // managed 栏走既有 persistManaged（零改动回归底线）、user/project 栏走 writeMcpScoped 逐条
  // 落盘。三组子断言：
  //   ① confirmImport 函数体切片（async function confirmImport → const importCardRef，与 O5 同源
  //      切片）含 writeMcpScoped 调用 + importTargetList.value 消费（预览同名判定换源）+
  //      activeProjectDir.value === null 前置判定（project 栏目录消失态拦截，不触盘）+ overwrote
  //      覆盖计数消费（负缓存陈旧快照下预览漏标同名 → upsert 覆盖 → 透明计数）；
  //   ② 负向：预览侧切片（function openImport → const selectedImportableCount，含 openImport /
  //      closeImportDialog / parseImportPreview——预览解析的第二参就在其中）与 confirmImport 切片
  //      中旧形态 analyzeImportText(importText.value, managedServers.value) 零出现（第二参统一
  //      改传 importTargetList.value）；预览侧另正向钉 importTargetList.value 在位；
  //   ③ 模板区（根 <template> → 末个 </template>）含「将导入到：」前缀文案与三形态目标位置字面
  //      （Claude Link 管理（全局生效）/ 用户级 ~/.claude.json（Claude Code 全局共享）/ 项目级 …
  //      .mcp.json（仅该目录会话）；项目形态中目录路径为插值，故断言其后半段字面）。
  // RED 依据（本点前的现状）：confirmImport 恒构造 McpManagedServer[] + persistManaged 写管理库、
  // 无 writeMcpScoped/importTargetList/activeProjectDir 判定/overwrote 计数，预览第二参恒
  // managedServers.value，弹窗无目标位置文案 —— 本钉应 FAIL。
  {
    const p6BodyStart = pSrc.indexOf('async function confirmImport');
    const p6BodyEnd = pSrc.indexOf('const importCardRef', p6BodyStart);
    const p6Body = p6BodyStart >= 0 && p6BodyEnd > p6BodyStart ? pSrc.slice(p6BodyStart, p6BodyEnd) : '';
    const p6PrevStart = pSrc.indexOf('function openImport');
    const p6PrevEnd = pSrc.indexOf('const selectedImportableCount', p6PrevStart);
    const p6Prev = p6PrevStart >= 0 && p6PrevEnd > p6PrevStart ? pSrc.slice(p6PrevStart, p6PrevEnd) : '';
    const p6OldSecondArg = 'analyzeImportText(importText.value, managedServers.value)';
    const p6TplStart = pSrc.search(/^<template>[ \t\r]*$/m);
    const p6TplEnd = pSrc.lastIndexOf('</template>');
    const p6Tpl = p6TplStart >= 0 && p6TplEnd > p6TplStart ? pSrc.slice(p6TplStart, p6TplEnd) : '';
    check(
      'P6',
      '导入作用域跟随栏位：confirmImport 切片含 writeMcpScoped 调用 + importTargetList.value + activeProjectDir.value === null 前置判定 + overwrote 覆盖计数；预览/确认切片旧第二参 managedServers.value 零出现；模板区含「将导入到：」三形态目标位置文案',
      p6Body !== ''
        && p6Prev !== ''
        && p6Body.includes('writeMcpScoped')
        && p6Body.includes('importTargetList.value')
        && p6Body.includes('activeProjectDir.value === null')
        && p6Body.includes('overwrote')
        && p6Prev.includes('importTargetList.value')
        && !p6Prev.includes(p6OldSecondArg)
        && !p6Body.includes(p6OldSecondArg)
        && p6Tpl !== ''
        && p6Tpl.includes('将导入到：')
        && p6Tpl.includes('Claude Link 管理（全局生效）')
        && p6Tpl.includes('用户级 ~/.claude.json（Claude Code 全局共享）')
        && p6Tpl.includes('.mcp.json（仅该目录会话）'),
      pSrc === '' ? 'McpSettings.vue 不可读' : 'confirmImport 仍恒写管理库（缺 writeMcpScoped/importTargetList/activeProjectDir 判定/overwrote 计数）、预览仍传 managedServers.value 旧第二参，或弹窗缺「将导入到：」三形态目标位置文案',
    );
  }
}

// ── Q. MCP 探活扩展用户级/项目级组（2026-10-29 mcp-probe-all-scopes-plan 点 p1：RED 钉先行）──
// 计划 docs/plans/2026-10-29-mcp-probe-all-scopes-plan.md §1.C。RED 是本点预期产物：Q1/Q2
// 断言的 scoped 分支、raw 读取消费、scope·dirKey 实参形态、UI 放开形态均未落地 → Q1/Q2 FAIL、
// Q3（all 分支负向现状钉）PASS；对应实现（下一实现点）落地后转全 PASS。

console.log('\n=== Q. MCP 探活扩展组（MCP_PROBE 三作用域取源 / UI 测试入口放开 / all 分支负向） ===');

{
  // Q1：ipc-handlers.ts MCP_PROBE handler 切片（IPC_CHANNELS.MCP_PROBE 注册行 → MCP_WRITE_SCOPED
  // 注册行）；若按计划 §1.A.2 抽出 resolveProbeSource 辅助（位于 handler 注册区之外），其函数体
  // 并入「取源区域」参与 raw 读取 / mcpProbeKey 形态 / 白名单 / 负缓存前置断言。
  const q1Rel = path.join('src', 'main', 'ipc-handlers.ts');
  let q1Src = '';
  try {
    q1Src = fs.readFileSync(path.resolve(__dirname, '..', q1Rel), 'utf8');
  } catch {
    // 缺文件/不可读：保持空串，Q1 走 FAIL 分支（不抛错、不崩脚本）。
  }
  const q1Start = q1Src.indexOf('IPC_CHANNELS.MCP_PROBE');
  const q1End = q1Src.indexOf('IPC_CHANNELS.MCP_WRITE_SCOPED', q1Start);
  const q1Body = q1Start >= 0 && q1End > q1Start ? q1Src.slice(q1Start, q1End) : '';
  const q1HelperStart = q1Src.search(/(?:async function|function|const) resolveProbeSource\b/);
  const q1HelperEnd = q1HelperStart >= 0 ? q1Src.indexOf('regInvokeHandler(', q1HelperStart) : -1;
  const q1Helper = q1HelperStart >= 0 && q1HelperEnd > q1HelperStart ? q1Src.slice(q1HelperStart, q1HelperEnd) : '';
  const q1Region = q1Body + q1Helper;
  const q1ScopedBranch = /target\s*===\s*'scoped'/.test(q1Body);
  const q1UserRaw = q1Region.includes('readUserMcpServersRawSync(');
  const q1ProjectRaw = q1Region.includes('readProjectMcpServersRawSync(');
  // mcpProbeKey( 调用形态：首实参为 scope 标识符（非 'managed' 字面量）且第二实参内联
  // normalizeDirKey(（计划 §1.A.2 cacheKey：mcpProbeKey(scope, scope==='project' ?
  // normalizeDirKey(dir) : null, name)；[^,)]* 容忍三元条件与空格写法差异）。
  const q1KeyShape = /mcpProbeKey\(\s*scope\s*,\s*[^,)]*normalizeDirKey\(/.test(q1Region);
  const q1Whitelist = q1Region.includes('mergeProjectDirs(') && q1Region.includes('normalizeDirKey(');
  const q1BadIdx = q1Region.indexOf('badDirCacheHas(');
  const q1ProjRawIdx = q1Region.indexOf('readProjectMcpServersRawSync(');
  const q1BadBefore = q1BadIdx >= 0 && q1ProjRawIdx >= 0 && q1BadIdx < q1ProjRawIdx;
  const q1Subs: string[] = [];
  if (!q1ScopedBranch) q1Subs.push("缺 target === 'scoped' 分支");
  if (!(q1UserRaw && q1ProjectRaw)) q1Subs.push('未消费 readUserMcpServersRawSync(/readProjectMcpServersRawSync(');
  if (!q1KeyShape) q1Subs.push('mcpProbeKey( 缺 scope 实参 + normalizeDirKey( dirKey 实参形态');
  if (!q1Whitelist) q1Subs.push('project 白名单（mergeProjectDirs/normalizeDirKey）不在探活取源路径');
  if (!q1BadBefore) q1Subs.push('badDirCacheHas( 未前置于 project 读盘');
  check(
    'Q1',
    'MCP_PROBE handler 三作用域取源（计划 §1.A）：切片含 target === \'scoped\' 分支 + 取源区域消费 readUserMcpServersRawSync(/readProjectMcpServersRawSync( + mcpProbeKey( 含 scope 实参与 normalizeDirKey( dirKey 实参 + project 白名单（mergeProjectDirs/normalizeDirKey）在取源路径 + badDirCacheHas( 前置于 project 读盘',
    q1Body !== '' && q1ScopedBranch && q1UserRaw && q1ProjectRaw && q1KeyShape && q1Whitelist && q1BadBefore,
    q1Src === '' ? 'ipc-handlers.ts 不可读' : `MCP_PROBE 取源扩展未落地（RED 预期）：${q1Subs.join('；')}`,
  );

  // Q2：McpSettings.vue 三形态——①测试连接按钮放开（不再仅管理库）；②probeAllInView 分流；
  // ③saveScopedForm 成功块 single 现探。
  const q2Rel = path.join('src', 'renderer', 'components', 'config', 'McpSettings.vue');
  let q2Src = '';
  try {
    q2Src = fs.readFileSync(path.resolve(__dirname, '..', q2Rel), 'utf8');
  } catch {
    // 缺文件/不可读：保持空串，Q2 走 FAIL 分支（不抛错、不崩脚本）。
  }
  // ① 卡片操作区（class="row__acts" → </section>）内 probe 点击绑定（handleProbe(card)）不得被
  //   「仅管理库」<template v-if="activeScope.kind === 'managed'"> 先行限定：门消失 / 门在按钮
  //   之后（按钮上移三作用域共用区）/ managed 门闭合后的 else 分支亦渲染按钮（三作用域各一枚）
  //   三形态均可；负向：旧限定注释「仍仅管理库」全文件零出现。
  const q2ActsStart = q2Src.indexOf('class="row__acts"');
  const q2ActsEnd = q2Src.indexOf('</section>', q2ActsStart);
  const q2Acts = q2ActsStart >= 0 && q2ActsEnd > q2ActsStart ? q2Src.slice(q2ActsStart, q2ActsEnd) : '';
  const q2ProbeIdx = q2Acts.indexOf('handleProbe(card)');
  const q2GateIdx = q2Acts.indexOf('<template v-if="activeScope.kind === \'managed\'">');
  const q2GateClose = q2GateIdx >= 0 ? q2Acts.indexOf('</template>', q2GateIdx) : -1;
  const q2Ungated = q2ProbeIdx >= 0
    && (q2GateIdx < 0
      || q2ProbeIdx < q2GateIdx
      || (q2GateClose > q2GateIdx && q2Acts.lastIndexOf('handleProbe(card)') > q2GateClose));
  const q2NoOldComment = q2Src !== '' && !q2Src.includes('仍仅管理库');
  // handleProbe 切片（async function handleProbe → function managedCardOf）含 scope 实参
  //  （scope/dir 由 card.key 前缀与 activeScope 推导，计划 §1.B.1——否则 user/project 卡单探
  //   仍落 managed 查找，必报「未找到该服务器」）。
  const q2HpStart = q2Src.indexOf('async function handleProbe');
  const q2HpEnd = q2Src.indexOf('function managedCardOf', q2HpStart);
  const q2Hp = q2HpStart >= 0 && q2HpEnd > q2HpStart ? q2Src.slice(q2HpStart, q2HpEnd) : '';
  const q2HpScope = q2Hp !== '' && /\bscope\b/.test(q2Hp);
  // ② probeAllInView 切片（async function probeAllInView → function probeReportOf）：按
  //   activeScope 分流 + scoped/user/project 形态在位 + managed 栏 target:'all' 现状保留。
  const q2PavStart = q2Src.indexOf('async function probeAllInView');
  const q2PavEnd = q2Src.indexOf('function probeReportOf', q2PavStart);
  const q2Pav = q2PavStart >= 0 && q2PavEnd > q2PavStart ? q2Src.slice(q2PavStart, q2PavEnd) : '';
  const q2PavOk = q2Pav !== ''
    && q2Pav.includes('activeScope')
    && /target:\s*'scoped'/.test(q2Pav)
    && /scope:\s*'user'/.test(q2Pav)
    && /scope:\s*'project'/.test(q2Pav)
    && /target:\s*'all'/.test(q2Pav);
  // ③ saveScopedForm 成功块（await claude.writeMcpScoped(payload) → } catch 之间）含 single
  //   现探（probeMcpServers({ target:'single' … }) 且带 scope 实参，计划 §1.B.3）。
  const q2SsfStart = q2Src.indexOf('async function saveScopedForm');
  const q2SsfEnd = q2Src.indexOf('async function saveForm', q2SsfStart);
  const q2Ssf = q2SsfStart >= 0 && q2SsfEnd > q2SsfStart ? q2Src.slice(q2SsfStart, q2SsfEnd) : '';
  const q2OkStart = q2Ssf.indexOf('await claude.writeMcpScoped(payload)');
  const q2OkEnd = q2Ssf.indexOf('} catch (e) {', q2OkStart);
  const q2Ok = q2OkStart >= 0 && q2OkEnd > q2OkStart ? q2Ssf.slice(q2OkStart, q2OkEnd) : '';
  const q2OkSingle = /probeMcpServers\(\{[^}]*target:\s*'single'/.test(q2Ok) && /\bscope\b/.test(q2Ok);
  const q2Subs: string[] = [];
  if (!(q2Acts !== '' && q2Ungated)) q2Subs.push('测试连接按钮仍被仅管理库门先行限定');
  if (!q2NoOldComment) q2Subs.push('旧限定注释「仍仅管理库」残留');
  if (!q2HpScope) q2Subs.push('handleProbe 切片缺 scope 实参');
  if (!q2PavOk) q2Subs.push("probeAllInView 缺 scoped 分流（target:'scoped' + scope:'user'/'project'）");
  if (!q2OkSingle) q2Subs.push("saveScopedForm 成功块缺 single 现探（target: 'single'）");
  check(
    'Q2',
    'UI 测试入口放开（计划 §1.B）：①测试连接按钮不再被仅管理库 v-if 先行限定（上移共用区/门消失/else 分支亦渲染均可）+ 旧限定注释「仍仅管理库」零出现 + handleProbe 含 scope 实参；②probeAllInView 按 activeScope 分流含 target:\'scoped\' + scope:\'user\'/\'project\'（managed 栏 target:\'all\' 保留）；③saveScopedForm 成功块含 probeMcpServers({ target:\'single\' … scope … }) 现探',
    q2Src !== '' && q2Ungated && q2NoOldComment && q2HpScope && q2PavOk && q2OkSingle,
    q2Src === '' ? 'McpSettings.vue 不可读' : `UI 探活扩展未落地（RED 预期）：${q2Subs.join('；')}`,
  );

  // Q3：负向现状钉（本点即 PASS，防后续误改）：all 分支（req.target !== 'all' 校验行起）仍只
  //   遍历管理库 config.mcpServers——user/project raw 读取与 'scoped' 分支零混入。all 分支终点
  //   为 handler 切片收尾；若 resolveProbeSource 定义楔在 all 分支之后、MCP_WRITE_SCOPED 之前
  //  （q1Body 内部），在其定义处截断（辅助函数体不算 all 分支内容）。
  const q3AllIdx = q1Body.indexOf("req.target !== 'all'");
  const q3HelperInBody = q1HelperStart >= 0 && q1HelperStart > q1Start && q1HelperStart < q1End;
  const q3HelperOff = q3HelperInBody ? q1HelperStart - q1Start : q1Body.length;
  const q3End = q3HelperOff > q3AllIdx ? q3HelperOff : q1Body.length;
  const q3Body = q3AllIdx >= 0 && q3End > q3AllIdx ? q1Body.slice(q3AllIdx, q3End) : '';
  check(
    'Q3',
    "all 分支负向现状钉（防误改）：仍只遍历 getConfig().mcpServers（管理库 enabledServers 过滤形态在位），user/project raw 读取与 'scoped' 分支零混入",
    q3Body !== ''
      && q3Body.includes('getConfig().mcpServers')
      && !q3Body.includes('readUserMcpServersRawSync')
      && !q3Body.includes('readProjectMcpServersRawSync')
      && !q3Body.includes("'scoped'"),
    q1Body === '' ? 'ipc-handlers.ts 不可读或 MCP_PROBE 切片缺失' : "all 分支被混入 user/project raw 读取或 scoped 分支（计划 §1.A.3：target:'all' 保持现状）",
  );

  // Q4（round-001 review 修复钉，2026-10-29 fix-probe 点；①语义 2026-10-29 round-4 F1 反转
  //   改写，RED→GREEN）——
  // ① connModeOf sse 中性门零出现（反转钉）：connModeOf 切片不含任何 card.transport === 'sse'
  //   返回门（无限定形零出现；旧 managed∧sse 合取形全文件零出现）；ConnMode 类型行不含 'sse'
  //   成员；「会话内自动协商」「SSE 传输暂不支持探测」文案全文件零出现（row__stat 与按钮
  //   title 一并覆盖）。拆除依据：探活器 mcp-probe.ts 已实现 sse POST 两步握手（4xx 附专属
  //   提示），round-001 P2-1「sse 探测必失败属误报」前提不成立（review round-4 F1）；
  // ② probeAllInView scoped 回写竞态闭环（P2-2）：切片含 dispatchAt 捕获
  //   （const dispatchAt = Date.now()）+ dropOwnPrefix fresh 保留（probedAt > dispatchAt）+
  //   批量回填 probedAt 仲裁（prev.probedAt <= r.probedAt）；
  // ③ confirmImport 覆盖同名条目补 single 现探（m4）：切片含 target: 'single'；
  // ④ 渲染层 cast 收口（m3）：全文件 claude.probeMcpServers as cast 形态零出现
  //   （载荷契约镜像已上移 preload McpProbeTarget）。
  const q4CmStart = q2Src.indexOf('function connModeOf');
  const q4CmEnd = q2Src.indexOf('function enabledCountOf', q4CmStart);
  const q4Cm = q4CmStart >= 0 && q4CmEnd > q4CmStart ? q2Src.slice(q4CmStart, q4CmEnd) : '';
  const q4NoSseGate = q2Src !== '' && q4Cm !== ''
    && !/card\.transport\s*===\s*'sse'/.test(q4Cm)
    && !/activeScope\.value\.kind\s*===\s*'managed'\s*&&\s*card\.transport\s*===\s*'sse'/.test(q2Src);
  const q4TypeM = q2Src.match(/type ConnMode = [^;]*;/);
  const q4TypeNoSse = q4TypeM !== null && !q4TypeM[0].includes("'sse'");
  const q4NoSseCopy = q2Src !== '' && !q2Src.includes('会话内自动协商') && !q2Src.includes('SSE 传输暂不支持探测');
  const q4PavDispatch = /const dispatchAt = Date\.now\(\)/.test(q2Pav);
  const q4PavFresh = /probedAt\s*>\s*dispatchAt/.test(q2Pav);
  const q4PavArb = /prev\.probedAt\s*<=\s*r\.probedAt/.test(q2Pav);
  const q4CiStart = q2Src.indexOf('async function confirmImport');
  const q4CiEnd = q2Src.indexOf('const importCardRef', q4CiStart);
  const q4Ci = q4CiStart >= 0 && q4CiEnd > q4CiStart ? q2Src.slice(q4CiStart, q4CiEnd) : '';
  const q4CiSingle = q4Ci.includes("target: 'single'");
  const q4NoCast = q2Src !== '' && !q2Src.includes('claude.probeMcpServers as');
  const q4Subs: string[] = [];
  if (!q4NoSseGate) q4Subs.push("connModeOf 仍含 sse 中性门（card.transport === 'sse' 返回门或旧 managed∧sse 形残留）");
  if (!q4TypeNoSse) q4Subs.push("ConnMode 类型行仍含 'sse' 成员");
  if (!q4NoSseCopy) q4Subs.push('「会话内自动协商」「SSE 传输暂不支持探测」文案残留');
  if (!(q4PavDispatch && q4PavFresh && q4PavArb)) q4Subs.push('probeAllInView 缺 dispatchAt 捕获 / dropOwnPrefix fresh 保留 / 回填 probedAt 仲裁');
  if (!q4CiSingle) q4Subs.push("confirmImport 缺覆盖同名条目 single 现探（target: 'single'）");
  if (!q4NoCast) q4Subs.push('claude.probeMcpServers as cast 残留');
  check(
    'Q4',
    "round-001 修复钉（① round-4 F1 反转改写）：①connModeOf sse 中性门零出现（切片不含 card.transport === 'sse' 返回门，旧 managed∧sse 形全文件零出现）+ ConnMode 类型行不含 'sse' 成员 + 「会话内自动协商」「SSE 传输暂不支持探测」文案全文件零出现；②probeAllInView 含 dispatchAt 捕获 + dropOwnPrefix fresh 保留（probedAt > dispatchAt）+ 回填 probedAt 仲裁（prev.probedAt <= r.probedAt）；③confirmImport 切片含 target: 'single' 现探；④全文件 claude.probeMcpServers as cast 零出现",
    q2Src !== '' && q4NoSseGate && q4TypeNoSse && q4NoSseCopy && q4PavDispatch && q4PavFresh && q4PavArb && q4CiSingle && q4NoCast,
    q2Src === '' ? 'McpSettings.vue 不可读' : `修复落位形态未齐（RED 预期）：${q4Subs.join('；')}`,
  );

  // Q4b（round-002 复审备忘-2 负向现状钉，2026-10-29，本点即 PASS 沿 Q3 先例，防后续误改）：
  //   managed 分支回填保持无仲裁形态（计划硬约束「管理库探活行为零变化」）。managed 切片 =
  //   probeAllInView 函数体起点 → scoped 分支分界（scoped 首行代码 scope.kind === 'user'
  //   首现处止）：managed 早退/回填/catch/finally 全覆盖；scoped 分支（dispatchAt/dropOwnPrefix/
  //   prev.probedAt <= r.probedAt 仲裁）不得落入切片——其仲裁形态属预期，混入即钉失效。
  const q4bScopedStart = q2Pav.indexOf("scope.kind === 'user'");
  const q4bManaged = q4bScopedStart > 0 ? q2Pav.slice(0, q4bScopedStart) : '';
  check(
    'Q4b',
    'managed 分支负向现状钉（防误改）：probeAllInView managed 切片保持无仲裁回填形态——prev.probedAt / probedAt <= 仲裁形零出现 + next[r.key] = r; 现状回填在位',
    q2Src !== ''
      && q4bManaged !== ''
      && !q4bManaged.includes('prev.probedAt')
      && !/probedAt\s*<=/.test(q4bManaged)
      && q4bManaged.includes('next[r.key] = r;'),
    q2Src === ''
      ? 'McpSettings.vue 不可读'
      : 'managed 分支被混入 probedAt 仲裁或现状无仲裁回填形态消失（计划硬约束：管理库探活行为零变化）',
  );
}

// ── 汇总与退出码 ─────────────────────────────────────────────────────────────
// J3（2026-10-19 点1 起）为异步断言：汇总移入 finish()，由 J3 的 promise 链收尾调用一次
//（同步断言全部先于其执行完毕，计数完整后再打印；退出码约定不变）。
function finish(): void {
  console.log(`\n===== selftest-mcp-settings: ${pass} pass / ${fail} fail =====`);
  if (fail > 0) {
    console.log('（存在 FAIL 项：请按失败详情对照当前计划核验归因）');
    process.exit(1);
  }
  console.log('selftest-mcp-settings: OK');
  process.exit(0);
}
