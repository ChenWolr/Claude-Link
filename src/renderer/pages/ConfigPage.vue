<script setup lang="ts">
// ConfigPage.vue — 设置页。
// 结构：标题/标签/工作区同宽一列（宽 = min(100%, --chat-bottom-max-width)，与聊天/会话页同一 800px 契约），
// 列在页面水平居中；工作区 flex:1 填满剩余高度，连接页=供应商列表+详情复合面板，行为/外观共用同一 solo 卡片。
// 行为/外观页内部排版严格保留原字段顺序/文案/控件（r9：仅装入统一面板，禁止重排）。
// 所有滚动发生在面板内部；尺寸除 Skill 双栏区（.skill-md-rail 264px 定宽、滚动条 8px）外全部 rem（随 fontScale 等比缩放）。
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useConfigStore, lastSaveFailed } from '../stores/config-store';
import { useCommandStore } from '../stores/command-store';
import ProviderManager from '../components/providers/ProviderManager.vue';
import ThemeSelector from '../components/config/ThemeSelector.vue';
import BridgeSettings from '../components/config/BridgeSettings.vue';
import { THEME_PALETTES, FONT_SCALE_SIZES } from '../../shared/constants';
import { sanitizeTaskDelayMinutes } from '../../shared/queue-config';
import { sanitizeMaxTurns } from '../../shared/max-turns';
import { attachUserSkillDirNames, findStaleSkillKeys, isStaleKeyScanReady, loadSkillProjectDirs, normalizeDirKey } from '../../shared/project-skills';
import { useInteractionStore } from '../stores/interaction-store';
import type { ProjectDirEntry, SdkCommand } from '../../shared/types/command';

const store = useConfigStore();
const commandStore = useCommandStore();
const interactionStore = useInteractionStore();
const router = useRouter();
const toast = ref<string | null>(null);
const toastType = ref<'success' | 'error'>('success');

// 分类标签页：连接（供应商/模型可选项库）/ 行为 / 外观 / Skill（Skill 管理独立设置页）。
type TabId = 'connection' | 'behavior' | 'appearance' | 'skill';
const activeTab = ref<TabId>('connection');

// 自动保存：监听所有用户可编辑的持久化字段，700ms 防抖落盘，确保所有配置都永久保存。
// 用快照字符串比对建立基线，避免 saveConfig 回写 config 时触发死循环；
// cliPath/cliVersion/workingDirectory 由系统维护（自动检测/未开放编辑），不纳入快照。
const PERSISTED_FIELDS = [
  'provider', 'providerName', 'providerNote', 'apiKey', 'apiBaseUrl',
  'defaultModel', 'advancedJson', 'permissionMode', 'maxTurns', 'queueEnabled', 'taskDelayMinutes', 'themePaletteId', 'fontScale', 'contextWindowByAlias', 'defaultThinkingLevel', 'disableAutoMemory', 'disableBackgroundTasks', 'disableCron', 'disableFeedbackSurvey', 'disableTelemetry', 'disableNonessentialTraffic',
  'notifyOnLeave', 'minimizeToTray', 'skillOverrides',
] as const;

// hb10-CFG-04：'projection-failed' = 保存本身成功但 settings.local.json 投影失败（可见性）。
const saveStatus = ref<'idle' | 'saving' | 'saved' | 'error' | 'projection-failed'>('idle');
let initialized = false;
let lastSavedSnapshot = '';
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let savedIndicatorTimer: ReturnType<typeof setTimeout> | null = null;

function configSnapshot(): string {
  return JSON.stringify(PERSISTED_FIELDS.map((f) => store.config[f]));
}

function scheduleAutoSave(): void {
  saveStatus.value = 'saving';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!initialized) return;
    try {
      // P2-1：撞在途保存（{saved:false}）时基线不动并显式重排防抖——watch 对不变的快照
      // 不会自行再触发，链式补存必须在这里递一程；仅真实落定（saved=true）才前移基线。
      const r = await store.saveConfig();
      if (!r.saved) {
        scheduleAutoSave();
        return;
      }
      lastSavedSnapshot = configSnapshot();
      // hb10-CFG-04：投影失败可见——「已保存（投影失败）」徽标。
      saveStatus.value = store.config.projectionOk === false ? 'projection-failed' : 'saved';
      if (savedIndicatorTimer) clearTimeout(savedIndicatorTimer);
      savedIndicatorTimer = setTimeout(() => { saveStatus.value = 'idle'; }, 2000);
    } catch {
      saveStatus.value = 'error';
    }
  }, 700);
}

// P2-1：有界重试直至真实落定——撞在途保存（{saved:false}）时轮询重试，供手动保存与卸载
// flush 共用；40×150ms=6s 上限防永久挂起（超限返回 false，由调用方置 error 态不前移基线）。
async function saveUntilSettled(maxTries = 40): Promise<boolean> {
  let r = await store.saveConfig();
  for (let i = 1; !r.saved && i < maxTries; i++) {
    await new Promise((res) => setTimeout(res, 150));
    r = await store.saveConfig();
  }
  return r.saved;
}

watch(configSnapshot, (snap) => {
  if (!initialized) return; // 初次加载期间不自动保存
  if (snap === lastSavedSnapshot) return; // 回写或无变化不触发
  scheduleAutoSave();
});

async function refreshNativeSettingsDiagnostic(workingDir: string | null): Promise<void> {
  if (!workingDir) {
    store.invalidateNativeSettingsDiagnostic();
    return;
  }
  await store.loadNativeSettingsDiagnostic(workingDir);
}

async function performInit() {
  // H1（F5 重做）：上次保存失败（含卸载 flush 失败）时，先用手头内存值重存一次——
  // config-store 失败时不清内存 config，此刻仍是失败时的编辑值；一旦下方 loadConfig()
  // 用主进程旧值覆写，失败编辑就永久丢失。成功结局的清标志由 config-store saveConfig
  // 成功路径完成；失败结局进 catch 同样清标志（A1 边沿饥饿，见 catch 内注释）。
  // 两种结局都不阻塞页面初始化（页面照常显示主进程值）。
  if (lastSaveFailed.value) {
    try {
      await store.saveConfig();
    } catch {
      // A1（契约普查 2026-09-08）：重存失败时下方 loadConfig() 马上会用主进程旧值覆写
      // 内存 config，「内存值仍是失败编辑」的标志语义已死；若保持 true，后续一切新失败
      // 停在 true→true（无 false→true 边沿，全局 toast 不再弹），退回 F5 原静默丢失形态。
      // 清标志恢复边沿：此后任何新失败 App.vue 都可再次触达。
      lastSaveFailed.value = false;
    }
  }
  await store.loadConfig();
  await store.detectCli();
  await store.loadStorageInfo();
  await refreshNativeSettingsDiagnostic(store.config.workingDirectory);
  // 建立基线：此后任何字段变化才视为"用户改动"触发自动保存。
  lastSavedSnapshot = configSnapshot();
  initialized = true;
}

onMounted(performInit);

// ── 布局：内容列宽统一为 min(100%, --chat-bottom-max-width)（与聊天页/会话页同一 800px 契约）。
// 工作区不再锁定 3:2 比例、不再用 ResizeObserver 实测舞台尺寸——改为 flex:1 填满舞台剩余高度，
// 高度自然跟随窗口，消除「最大化(宽窗)左右 letterboxing / 还原(窄窗)底部大留白」两态不一致。

// 工作目录可能由自动检测、工作区切换或主进程配置流程更新；诊断必须跟随当前 cwd，
// 不得继续展示旧目录的 settings 来源和 CLAUDE.md candidates。
watch(
  () => store.config.workingDirectory,
  (workingDir) => {
    if (!initialized) return;
    void refreshNativeSettingsDiagnostic(workingDir);
  },
);

// 切页卸载时立即落盘 pending 的自动保存：原 700ms 防抖期间若用户填完即切走（去会话发消息），
// pending 保存不保证在发消息前执行，导致"填了没生效、需手动点保存"。卸载时强制 flush 修复此时序缺陷。
// F5：flush 顺序收口——保存成功（.then）后才前移 lastSavedSnapshot 基线；失败进 .catch 置
// error 态且不前移基线。原先「基线先行 + fire-and-forget」在保存失败时会被 watch 的
// 「无变化」短路吞掉且组件已卸载无从重试（纯静默丢失）。卸载后无 toast 展示位，失败至少留状态标记。
onBeforeUnmount(() => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    // P2-1：卸载 flush 有界重试至真实落定；仅真实保存完成才前移基线（失败/超限置 error
    // 态不前移，跨卸载可感知走 H1 lastSaveFailed 链）。
    void saveUntilSettled()
      .then((saved) => {
        if (saved) lastSavedSnapshot = configSnapshot();
        else saveStatus.value = 'error';
      })
      .catch(() => {
        saveStatus.value = 'error';
      });
  }
});

// 高级 JSON 编辑器已随多供应商化移除；advancedJson（全局 permissions/hooks/env）暂无 UI
// 维护入口——settings.json 导入/自动检测死链路已于 2026-09-20 整链删除，
// advancedJson 只能手改存储文件或经 SDK settings 生效。

function showToast(message: string, type: 'success' | 'error' = 'success'): void {
  toastType.value = type;
  toast.value = message;
  setTimeout(() => {
    toast.value = null;
  }, 3000);
}

async function handleSave() {
  // 立即落盘（不等防抖）。URL 尾斜杠修正为多供应商化前的残留：仅当库为空（无投影源覆盖）时
  // 才会留存，库非空时会被 projectLegacyFields 用档案权威值覆盖。
  const baseUrl = store.config.apiBaseUrl?.trim();
  if (baseUrl && baseUrl.endsWith('/') && !baseUrl.endsWith('/v1/')) {
    store.config.apiBaseUrl = baseUrl.slice(0, -1);
  }
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    // P2-1：撞在途保存时有界重试至真实落定，再报「保存成功」并前移基线。
    const saved = await saveUntilSettled();
    if (!saved) {
      saveStatus.value = 'error';
      showToast('保存仍在进行中，未确认落盘，请稍后重试', 'error');
      return;
    }
    lastSavedSnapshot = configSnapshot();
    saveStatus.value = 'saved';
    if (savedIndicatorTimer) clearTimeout(savedIndicatorTimer);
    savedIndicatorTimer = setTimeout(() => { saveStatus.value = 'idle'; }, 2000);
  } catch {
    saveStatus.value = 'error';
    showToast(store.error ?? '保存失败', 'error');
  }
}

function handleThemeSelect(paletteId: string) {
  store.config.themePaletteId = paletteId;
  applyTheme(paletteId);
}

function applyTheme(paletteId: string) {
  const palette = THEME_PALETTES.find((p) => p.id === paletteId);
  if (!palette) return;
  const root = document.documentElement;
  root.style.setProperty('--color-bg', palette.colors.bg);
  root.style.setProperty('--color-panel', palette.colors.panel);
  root.style.setProperty('--color-panel-soft', palette.colors.panelSoft);
  root.style.setProperty('--color-border', palette.colors.border);
  root.style.setProperty('--color-text', palette.colors.text);
  root.style.setProperty('--color-text-muted', palette.colors.textMuted);
  root.style.setProperty('--color-accent', palette.colors.accent);
  root.style.setProperty('--color-accent-strong', palette.colors.accentStrong);
  root.style.setProperty('--color-on-accent', palette.colors.onAccent);
  root.style.setProperty('--color-danger', palette.colors.danger);
  root.style.colorScheme = palette.isDark ? 'dark' : 'light';
}

function applyFontScale(scale: string) {
  const root = document.documentElement;
  root.style.setProperty('--font-size-base', FONT_SCALE_SIZES[scale] ?? '16px');
}

function handleFontScaleChange(e: Event) {
  const scale = (e.target as HTMLSelectElement).value;
  store.config.fontScale = scale as typeof store.config.fontScale;
  applyFontScale(scale);
}

// 默认思考强度：写 config.defaultThinkingLevel，走 PERSISTED_FIELDS 自动保存（700ms 防抖）。
function handleThinkingLevelChange(e: Event) {
  const level = (e.target as HTMLSelectElement).value;
  store.config.defaultThinkingLevel = level as typeof store.config.defaultThinkingLevel;
}

// 默认权限：写 config.permissionMode（全局默认；会话内可各自覆盖）。走 PERSISTED_FIELDS 自动保存。
function handlePermissionModeChange(e: Event) {
  const mode = (e.target as HTMLSelectElement).value;
  store.config.permissionMode = mode as typeof store.config.permissionMode;
}

// 队列间隔输入夹取：失焦时把越界/非法值收敛到 1-60（NaN/空回落默认 5），与主进程清洗同源。
function clampTaskDelayMinutes(): void {
  store.config.taskDelayMinutes = sanitizeTaskDelayMinutes(store.config.taskDelayMinutes);
}

// 最大轮次输入夹取（F2）：失焦时把清空/非正数/小数收敛为正整数（非法回落默认 200），
// 与主进程 sanitizeMaxTurns 同源——防止 v-model.number 的空串/0 经自动保存入库后，
// sdk-command-options 的 >0 守卫静默丢旗标（=会话无轮次上限运行）。
function clampMaxTurns(): void {
  store.config.maxTurns = sanitizeMaxTurns(store.config.maxTurns);
}

// ── Skill 管理（B2 独立设置页）────────────────────────────────────────────
// 数据源：commandStore.globalSnapshot（引擎全局探测的未过滤快照，App.vue 全局订阅回写）。
// v1 只列 user-skill 来源，按 name 排序；项目/插件来源不进本页（边界见计划 §3.1）。
type SkillFilterId = 'all' | 'on' | 'off';
const skillSearch = ref('');
const skillFilter = ref<SkillFilterId>('all');

// S2-P2-2：null（无快照）与 status==='loading'（探测在飞/启动空窗回填）同属「探测中」——
// 状态条走同一占位；统计三卡与空态网格在该态不渲染（0/0/0 + 「无匹配的 Skill」是误导空态）。
const skillProbePending = computed(() => {
  const snapshot = commandStore.globalSnapshot;
  return !snapshot || snapshot.status === 'loading';
});

// 冷启动自愈（2026-09-15）：globalSnapshot 的广播可能早于 App.vue 订阅注册而永久丢失，本页
// 纯被动消费会永停「正在探测」——Skill tab 激活时按需拉一次。幂等在 ensureGlobalSnapshot 内
// （非 loading 快照直接返回 + in-flight 锁），反复切 tab 不产生拉取风暴。
// 项目目录同拍现查（2026-09-17 方案 B）：新目录自然纳入、被删目录自然消失（窗口 = 一次进 tab）。
watch(activeTab, (tab) => {
  if (tab === 'skill') { void commandStore.ensureGlobalSnapshot(); void ensureProjectDirs(); }
});

// ── 项目级 Skill 管理（方案 B 双栏 master-detail，2026-09-17）─────────────────
// 作用域状态：'global' = 用户级（~/.claude/skills，快照 user-skill 子集）；
// 'project' = 某历史目录（主进程直读 <dir>\.claude\skills 的磁盘全集，不经引擎探测）。
type SkillScope = { kind: 'global' } | { kind: 'project'; path: string };
const skillScope = ref<SkillScope>({ kind: 'global' });
const projectDirs = ref<ProjectDirEntry[]>([]);

// C-4（review 2026-09-18 §3-6）：请求代际守卫（先例 config-store.nativeSettingsDiagnosticRequestId
// 同款）——慢旧响应乱序返回时不得覆盖新请求结果（坏目录场景旧响应可拖秒级）；与 P2-4 的
// in-flight 共享叠加（共享消并发、代卫消串行乱序）。
let projectDirsRequestId = 0;

// C-5（review 2026-09-18 §3-7）：装载状态——首拍 rail 不再误显「0 个目录」；reject 不再静默
// 永久退化（错误可见 + rail 重试入口）。失败仍保留旧值不抛页面（B9 语义不变）。
const projectDirsPending = ref(false);
const projectDirsError = ref<string | null>(null);
// X-1/X-2（2026-09-19 独立评审 §2）：fm 名→目录名映射「至少成功装载一次」旗标（首访前 false）。
// 未装载时全局开关键集不可信（fm≠dir 条目回退 slash 名键）：D-1 清理入口不列失效键（X-1）、
// 全局卡片开关禁用 + title 提示（X-2「键名映射读取中」；W-2 超时态分化「键名映射读取超时」）；
// 项目条目 dirName 恒来自磁盘枚举不受门控。
// 空映射 ≠ 未装载：真零用户级 skill 的合法空在首次成功装载后旗标即为 true（二者以此区分）。
const userSkillDirNamesReady = ref(false);
// Y-1（2026-09-19 X-123 批评审 §2）：用户根枚举超时态（载荷 userSkillDirNamesTimedOut）——映射
// 内容不可信时不覆盖槽/不置就绪旗标（X-1/X-2 门控自然兜住），rail 以独立轻提示呈现（不写
// projectDirsError：项目目录与用户根两源独立）；每次装载前复位，不跨拍残留。
const userDirNamesTimedOut = ref(false);

// 每次进 tab 现查（覆盖式更新）。E-7：经 shared 装载状态机（桩可测），resolve 写目录 /
// reject 写 projectDirsError，catch 不再吞到无形；代际失守（C-4）直接作废，不动 pending——
// 更新中的请求会在自身落定时收敛状态。
async function ensureProjectDirs(): Promise<void> {
  const requestId = ++projectDirsRequestId;
  projectDirsPending.value = true;
  projectDirsError.value = null;
  userDirNamesTimedOut.value = false;
  const r = await loadSkillProjectDirs(() => window.claudeLink.getSkillProjectDirs());
  if (requestId !== projectDirsRequestId) return;
  if (r.ok) {
    projectDirs.value = r.dirs;
    // Y-1：用户根枚举超时（载荷标记）与「合法空」区分——超时映射内容不可信：不覆盖映射槽、
    // 不置就绪旗标（首访超时 ready 保持 false，X-1 清理门控与 X-2 开关禁用自然兜住；曾装载过
    // 则保留旧映射，消费旧值为已申报残面）；不写 projectDirsError（两源独立），rail 独立超时提示。
    if (r.userSkillDirNamesTimedOut) {
      userDirNamesTimedOut.value = true;
    } else {
      // R-1：同拍载荷携带全局 fm 名→目录名映射 → 写 commandStore.userSkillDirNames 槽
      //（ChatInput '/' 菜单过滤同源消费）；代卫失守早退时同样不写（与 projectDirs 同生命周期）。
      commandStore.userSkillDirNames = r.userSkillDirNames;
      // X-1/X-2：映射就绪旗标与映射槽同拍写入（X-1 清理入口门控 / X-2 全局开关禁用共用）。
      userSkillDirNamesReady.value = true;
    }
  } else {
    projectDirsError.value = r.error;
  }
  projectDirsPending.value = false;
}

// R-3 幽灵作用域回退：现查刷新后选中目录已不在清单（被删/淘汰）→ 自动回全局作用域。
// A-2/D-10（review 2026-09-18）：比较改 normalizeDirKey 相等——原 path 原串全等在同键不同写法
//（recent 淘汰换幸存串：大小写/斜杠/尾分隔符）时误判「不在清单」→ 误回退全局；用户停在全局
// 时不触发。已知限制（登记不实施）：realpath 级等价类（映射盘↔UNC/8.3/\\?\）不在归一范围。
watch(projectDirs, (dirs) => {
  const scope = skillScope.value;
  if (scope.kind === 'project' && !dirs.some((d) => normalizeDirKey(d.path) === normalizeDirKey(scope.path))) skillScope.value = { kind: 'global' };
});

// 当前选中的项目目录条目（全局作用域 / 目录已被现查淘汰 → null）；匹配同走归一键（A-2/D-10）。
const activeProjectDir = computed(() =>
  skillScope.value.kind === 'project'
    ? projectDirs.value.find((d) => normalizeDirKey(d.path) === normalizeDirKey((skillScope.value as { kind: 'project'; path: string }).path)) ?? null
    : null,
);

// 作用域全集：全局 = userSkills（origin==='user-skill'，条目经 attachUserSkillDirNames 补
// dirName——R-1 起全局与项目同口径）；项目 = 目录 skills。开关键经 skillKey 取值（P2-3 键名
// 口径：一律目录名）。目录匹配同走归一键（A-2/D-10，与幽灵回退/activeProjectDir 同口径）。
const scopeItems = computed<Array<{ name: string; dirName?: string; description: string }>>(() =>
  skillScope.value.kind === 'global'
    ? userSkills.value
    : (projectDirs.value.find((d) => normalizeDirKey(d.path) === normalizeDirKey((skillScope.value as { path: string }).path))?.skills ?? []),
);

// 同名联动徽章判定（R-2 按作用域计数，计划 §3.3 口径）：名字出现于 ≥2 个「作用域」
// （'global' / `project:<path>`）的全集才徽章——单目录同名已由主进程去重，逐条计数会把
// 同目录两条同名误判为「跨作用域」。开关按 Skill 名全局生效（config.skillOverrides），
// 同名跨作用域必然联动——徽章只提示事实。
const dupSkillNames = computed(() => {
  const scopesByName = new Map<string, Set<string>>();
  const record = (name: string, scope: string) => {
    let set = scopesByName.get(name);
    if (!set) { set = new Set<string>(); scopesByName.set(name, set); }
    set.add(scope);
  };
  for (const s of userSkills.value) record(s.name, 'global');
  for (const dir of projectDirs.value) {
    for (const s of dir.skills) record(s.name, `project:${dir.path}`);
  }
  return new Set([...scopesByName].filter(([, set]) => set.size >= 2).map(([name]) => name));
});

// 左栏每行 meta 的已启用计数（零后端，按 skillOverrides 现值派生）。
// R-1：全局行改按 skillKey（目录名口径）与开关/统计卡同键——旧 s.name 口径对 fm≠dir 条目
// 读无效键，计数与卡片开关态相悖。
const globalEnabledCount = computed(() => userSkills.value.filter((s) => isSkillEnabled(skillKey(s))).length);
function projectEnabledCount(dir: ProjectDirEntry): number {
  return dir.skills.filter((s) => isSkillEnabled(skillKey(s))).length;
}

// 全局作用域条目 = 引擎快照 user-skill 子集（显示名 = slash 名 = frontmatter 名，快照无目录名）。
// R-1（review 2026-09-18 验收 §3）：按 commandStore.userSkillDirNames（ConfigPage 现查
// SKILL_PROJECT_DIRS_GET 载荷同源写入）为每条补 dirName——下游 skillKey（dirName ?? name）/
// 开关/统计/可见性过滤/D-1 全集统一到目录名口径；映射未命中（fm==dir 公共形态或未进过 Skill 页）
// dirName 缺省，skillKey 回退 slash 名（与收口前行为一致）。
const userSkills = computed<Array<SdkCommand & { dirName?: string }>>(() => {
  const snapshot = commandStore.globalSnapshot;
  if (!snapshot) return [];
  return attachUserSkillDirNames(
    snapshot.commands
      .filter((c) => c.origin === 'user-skill')
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name)),
    commandStore.userSkillDirNames,
  );
});

// 开关语义：checked = 启用。启用 = 未禁用（键缺失或值非 'off' 均视为启用）；?. 防御存量存储缺键形态。
function isSkillEnabled(name: string): boolean {
  return store.config.skillOverrides?.[name] !== 'off';
}

// P2-3 键名口径（2026-09-18 Phase 0-2 实验裁决，单键定案）：引擎 skillOverrides 只认目录名
// （模型清单过滤与键入拦截都在目录名层，frontmatter 名键全链零效果）——开关键一律取目录名。
// 项目条目带 dirName（真实子目录名）；user-skill 快照项无该字段，回退 name（快照名=目录名公共形态）。
function skillKey(s: { name: string; dirName?: string }): string {
  return s.dirName ?? s.name;
}

// 拨开 → 删除该键（不落 'on' 残值，空配置在主进程不加 settings 键）；拨关 → 置 'off'。
// 整体替换对象触发 PERSISTED_FIELDS 快照比对 → 既有 700ms 防抖自动保存（卸载 flush 兜底）。
// B-2（review 2026-09-18 §3-11）：next 改 null 原型对象——旧展开字面量形态下 `next['__proto__']`
// 走 Object.prototype setter 静默 no-op（该名 skill 开关无效）；null 原型让赋值/删除都落在自有
// 属性语义（saveConfig 的 JSON 往返归一为普通对象，IPC 安全）。
function setSkillEnabled(name: string, enabled: boolean): void {
  const next: Record<string, 'off'> = Object.assign(Object.create(null), store.config.skillOverrides ?? {});
  if (enabled) delete next[name];
  else next[name] = 'off';
  store.config.skillOverrides = next;
}

// 双栏后项目条目非 SdkCommand，按结构最小宽度取 { name, dirName? }（开关只消费开关键 skillKey，
// 按目录名全局生效——键名口径见 skillKey 注释）。
function handleSkillToggle(skill: { name: string; dirName?: string }, e: Event): void {
  setSkillEnabled(skillKey(skill), (e.target as HTMLInputElement).checked);
}

// 统计随开关实时重算（当前作用域全集：全局 user-skill / 项目磁盘全集）；无障碍播报见模板 sr-only。
const skillEnabledCount = computed(() => scopeItems.value.filter((s) => isSkillEnabled(skillKey(s))).length);
const skillDisabledCount = computed(() => scopeItems.value.length - skillEnabledCount.value);

// 纯前端过滤：搜索（名称+描述，大小写不敏感）× 状态 chips（全部/已启用/已禁用）——作用于当前作用域。
const visibleSkills = computed(() => {
  const q = skillSearch.value.trim().toLowerCase();
  return scopeItems.value.filter((s) => {
    const enabled = isSkillEnabled(skillKey(s));
    const matchQuery = !q || `${s.name} ${s.description}`.toLowerCase().includes(q);
    const matchFilter = skillFilter.value === 'all' || (skillFilter.value === 'on' ? enabled : !enabled);
    return matchQuery && matchFilter;
  });
});

// 右栏标题路径：全局 = ~/.claude/skills；项目 = <path>\.claude\skills（引擎加载 project skill 的同款目录约定）。
const scopePathText = computed(() =>
  skillScope.value.kind === 'global'
    ? '~/.claude/skills'
    : `${activeProjectDir.value?.path ?? ''}\\.claude\\skills`,
);

// C-8（review 2026-09-18 §3-10）：stale 提示臂与 snapshotAgeText 已删——globalSnapshot 的写入者
// （setGlobalFallback 只产 ready/empty；load() 回填只产 loading/degraded/cache 副本）不产 stale，
// 该臂不可达；stale 仅存在于 per-session 快照（commands-get 指纹比对），不在本页数据链上。

// B-1（review 2026-09-18）：degraded/error 态显式重试入口——ensureGlobalSnapshot 守卫收窄后对
// 失败态放行重拉，本函数即 Skill 页的自愈通道（Skill 页无「重开菜单」旁路，degraded 文案已
// 在 commands-get 同步修正；幂等与 in-flight 锁复用 ensure 自身）。
function retryGlobalSnapshot(): void {
  void commandStore.ensureGlobalSnapshot();
}

// D-1（review 2026-09-18 §3-3）+ R-1：死键识别——键 ∈ skillOverrides 但 ∉（全局 userSkills 经
// skillKey 的键集（目录名口径，含 dirName——收口前写入的无效 fm 名键不再被误认有效，可被标出
// 清理）∪ 当前已枚举项目目录 skills 的 skillKey 全集）者列为「疑似失效」；未挂载项目目录的键
// 不在全集、也会被列出（防误删由清理入口的确认步骤兜底），不做自动清理。
const staleSkillKeys = computed<string[]>(() => {
  // X-1（2026-09-19 独立评审 §2）：三「假失效」窗口（快照非 ready / 目录 pending / 目录 error /
  // 映射未就绪）下已知全集不完整——恒返回 []（skill-stale-row 的 v-if 长度判定与
  // cleanupStaleSkillKeys 同以此为一道闸门），防确认弹窗诱导误删有效禁用键。
  if (!isStaleKeyScanReady({
    snapshotStatus: commandStore.globalSnapshot?.status,
    projectDirsPending: projectDirsPending.value,
    projectDirsError: projectDirsError.value,
    userSkillDirNamesReady: userSkillDirNamesReady.value,
  })) return [];
  const dirKeys: string[] = [];
  for (const dir of projectDirs.value) {
    for (const s of dir.skills) dirKeys.push(skillKey(s));
  }
  return findStaleSkillKeys(store.config.skillOverrides, userSkills.value.map((s) => skillKey(s)), dirKeys);
});

// D-1 清理写路径：requestConfirm 确认后逐键 delete、整体替换触发自动保存（与开关拨动同链落盘）。
async function cleanupStaleSkillKeys(): Promise<void> {
  const keys = staleSkillKeys.value;
  if (keys.length === 0) return;
  const ok = await interactionStore.requestConfirm({
    title: '清理失效 Skill 开关键',
    message: `以下 ${keys.length} 个开关键不属于当前可见的任何 Skill（对应 Skill 可能已删除或改名）：${keys.join('、')}。确认从配置移除？`,
    confirmText: '清理',
    cancelText: '取消',
    danger: false,
  });
  if (!ok) return;
  const next: Record<string, 'off'> = { ...(store.config.skillOverrides ?? {}) };
  for (const k of keys) delete next[k];
  store.config.skillOverrides = next;
}
</script>

<template>
  <section class="settings">
    <div class="settings-inner" :style="{ '--col-w': 'min(100%, var(--chat-bottom-max-width))' }">
    <header class="page-head">
      <button class="back-button" type="button" @click="router.push('/')">← 返回会话</button>
    </header>

    <!-- CLI Status Banner -->
    <div v-if="store.detectingCli" class="banner banner--info">正在检测 Claude Code CLI...</div>
    <div v-else-if="store.cliStatus?.installed" class="banner banner--ok">
      ✅ Claude Code CLI 已安装 — {{ store.cliStatus.version }} ({{ store.cliStatus.path }})
    </div>
    <div v-else class="banner banner--warn">
      ⚠️ 未检测到 Claude Code CLI。请先安装：npm install -g @anthropic-ai/claude-code
    </div>

    <div v-if="toast" :class="['toast', `toast--${toastType}`]">{{ toast }}</div>
    <div v-if="store.error && !toast" class="toast toast--error">{{ store.error }}</div>

    <!-- 配置/数据存储目录（点 4：让用户知道配置信息存在哪）-->
    <details v-if="store.storageInfo" class="storage-info">
      <summary>配置与数据存储目录</summary>
      <div class="storage-info__body">
        <div><span>根目录</span><code>{{ store.storageInfo.userData }}</code></div>
        <div><span>配置文件</span><code>{{ store.storageInfo.config }}</code></div>
        <div><span>工作空间历史</span><code>{{ store.storageInfo.workspaces }}</code></div>
        <div><span>会话数据库</span><code>{{ store.storageInfo.db }}</code></div>
      </div>
    </details>

    <details v-if="store.nativeSettingsDiagnostic" class="storage-info native-settings-diagnostic">
      <summary>Claude Code 原生 settings 诊断</summary>
      <div class="storage-info__body">
        <div><span>工作目录</span><code>{{ store.nativeSettingsDiagnostic.cwd }}</code></div>
        <div><span>生效键名</span><code>{{ store.nativeSettingsDiagnostic.effectiveKeys.join(', ') || '（无）' }}</code></div>
        <!-- G2 警示：原生层敏感 env 键名（只显键名，值零泄露）；三层全空整块不渲染。 -->
        <template v-if="store.nativeSettingsDiagnostic.envKeysBySource.length > 0">
          <div>
            <span>env 警示</span>
            <code>原生 settings env 影响连接的键（值不显示）：原生层优先级 managed &lt; user &lt; project &lt; local &lt; Claude Link 显式注入，下列键会参与会话连接</code>
          </div>
          <div v-for="entry in store.nativeSettingsDiagnostic.envKeysBySource" :key="entry.source + entry.path">
            <span>{{ entry.source }} 层</span>
            <code>{{ entry.path }}：{{ entry.envKeys.join('、') }}</code>
          </div>
        </template>
        <div><span>CLAUDE.md 候选</span><code>{{ store.nativeSettingsDiagnostic.claudeMdCandidates.join(', ') || '（无）' }}</code></div>
        <div>
          <span>settings 来源</span>
          <code>{{ store.nativeSettingsDiagnostic.sources.map((source) => source.source + (source.path ? ` (${source.path})` : '')).join(' → ') || '（无）' }}</code>
        </div>
      </div>
    </details>

    <!-- 高级 JSON 编辑器已随多供应商化移除（连接配置由供应商库维护；
         config.advancedJson 仍承载全局 permissions/hooks/env，暂无 UI 维护入口）-->

    <!-- 分类标签页与保存状态同行，保存反馈靠右对齐 -->
    <div class="tabs-row">
      <nav class="tabs" aria-label="设置分类">
        <button type="button" :class="['tab', { 'tab--active': activeTab === 'connection' }]" @click="activeTab = 'connection'">连接</button>
        <button type="button" :class="['tab', { 'tab--active': activeTab === 'behavior' }]" @click="activeTab = 'behavior'">行为</button>
        <button type="button" :class="['tab', { 'tab--active': activeTab === 'appearance' }]" @click="activeTab = 'appearance'">外观</button>
        <button type="button" :class="['tab', { 'tab--active': activeTab === 'skill' }]" @click="activeTab = 'skill'">Skill</button>
      </nav>
      <div class="save-actions">
        <span v-if="saveStatus !== 'idle'" :class="['save-badge', `save-badge--${saveStatus === 'projection-failed' ? 'saved' : saveStatus}`]">
          <span v-if="saveStatus === 'saving'" class="save-badge__dot" />
          {{ saveStatus === 'saving' ? '保存中…' : saveStatus === 'saved' ? '保存成功' : saveStatus === 'projection-failed' ? '已保存（投影失败）' : '保存失败' }}
        </span>
        <button type="button" class="test-btn" @click="handleSave">立即保存</button>
      </div>
    </div>

    <!-- 舞台：剩余全部空间；工作区填满高度并水平居中（与标题/标签同宽一列） -->
    <div class="stage">
      <div class="workbench" :class="{ 'workbench--solo': activeTab !== 'connection' }">
        <!-- 连接：供应商/模型可选项库（列表 + 详情复合面板，内部滚动；测试在模型行内） -->
        <div v-show="activeTab === 'connection'" class="wb-connection">
          <ProviderManager />
        </div>

        <!-- 行为：轮次 / 队列间隔 / 默认思考强度（内部排版沿用原字段，仅装入统一面板） -->
        <div v-show="activeTab === 'behavior'" class="solo-card">
          <div class="mscroll">
            <div class="section">
              <h3 class="section-title">行为</h3>
              <label class="field">
                <span class="field-label">最大轮次</span>
                <span class="field-desc">单次会话最大工具调用轮数（<code>--max-turns</code>）。</span>
                <input v-model.number="store.config.maxTurns" type="number" min="1" @blur="clampMaxTurns" />
              </label>
              <label class="field field--toggle">
                <span class="field-label">开启队列任务</span>
                <span class="field-desc">开启后：回复生成中可在会话框继续输入并发送，消息与附件自动加入队列，当前回复结束后按下方间隔自动逐个执行。关闭后：回复生成中禁止发送，队列不自动执行（仍可在队列面板手动「开始」）。</span>
                <input v-model="store.config.queueEnabled" type="checkbox" />
              </label>
              <label class="field">
                <span class="field-label">队列任务间隔（分钟）</span>
                <span class="field-desc">回复结束 / 上一队列任务完成后，等待多少分钟执行下一个队列任务。手填 1-60，最低 1 分钟。</span>
                <input
                  v-model.number="store.config.taskDelayMinutes"
                  type="number"
                  min="1"
                  max="60"
                  @blur="clampTaskDelayMinutes"
                />
              </label>
              <label class="field">
                <span class="field-label">默认思考强度</span>
                <span class="field-desc">新会话默认档；「工作流」档成本最高（Beta）。会话内可单独调整。</span>
                <select :value="store.config.defaultThinkingLevel" @change="handleThinkingLevelChange">
                  <option value="low">低（快速响应）</option>
                  <option value="medium">中（平衡，默认）</option>
                  <option value="high">高（深入分析）</option>
                  <option value="xhigh">超高（复杂推理）</option>
                  <option value="max">极限（最高强度，成本最高）</option>
                  <option value="ultracode">工作流（xhigh + 动态工作流，Beta）</option>
                </select>
              </label>
              <label class="field">
                <span class="field-label">默认权限</span>
                <span class="field-desc">新会话默认档；会话内可单独调整。</span>
                <select :value="store.config.permissionMode" @change="handlePermissionModeChange">
                  <option value="default">默认模式（需手动确认危险操作）</option>
                  <option value="plan">规划模式（只规划，审批后执行）</option>
                  <option value="acceptEdits">代理模式（自动提交文件编辑）</option>
                  <option value="bypassPermissions">自动模式（越过所有权限检查，谨慎使用）</option>
                </select>
              </label>
              <label class="field field--toggle">
                <span class="field-label">离开会话后通知</span>
                <span class="field-desc">窗口失焦时，任务完成/网络中断弹系统通知。</span>
                <input v-model="store.config.notifyOnLeave" type="checkbox" />
              </label>
              <label class="field field--toggle">
                <span class="field-label">后台运行</span>
                <span class="field-desc">开启后托盘图标常驻右下角；关闭窗口最小化到托盘，右键托盘「退出」才结束程序。</span>
                <input v-model="store.config.minimizeToTray" type="checkbox" />
              </label>
            </div>
          </div>
        </div>

        <!-- 外观：主题（ThemeSelector 9 卡网格）+ 字号（r9：原有内容原样保留） -->
        <div v-show="activeTab === 'appearance'" class="solo-card">
          <div class="mscroll">
            <div class="section">
              <h3 class="section-title">外观</h3>
              <ThemeSelector :selected-id="store.config.themePaletteId" @select="handleThemeSelect" />
              <label class="field">
                <span class="field-label">字号</span>
                <span class="field-desc">小/中/大三档，全局缩放所有文字与间距</span>
                <select :value="store.config.fontScale" @change="handleFontScaleChange">
                  <option value="small">小</option>
                  <option value="medium">中</option>
                  <option value="large">大</option>
                </select>
              </label>
            </div>
          </div>
        </div>

        <!-- IM 机器人（飞书/微信 bridge）：凭据掩码读写、状态总览、扫码登录、绑定管理。
             保存语义=字段 blur/开关 change 即 bridgeSaveConfig；掩码/加密在主进程处理。 -->
        <div class="section">
          <h3 class="section-title">IM 机器人</h3>
          <BridgeSettings />
        </div>

        <!-- Skill：方案 B 双栏 master-detail（左=作用域清单 rail，右=作用域详情 main）。
             全局作用域数据源 = commandStore.globalSnapshot（引擎全局探测快照）的 user-skill 子集；
             项目作用域 = 主进程直读 <dir>\.claude\skills 的磁盘全集（SKILL_PROJECT_DIRS_GET 每次进 tab 现查）。
             开关 checked = 启用，写 config.skillOverrides（键='off' 即禁用，按 Skill 名全局生效），走自动保存。 -->
        <div v-show="activeTab === 'skill'" class="solo-card">
          <div class="skill-md-body" data-testid="skill-manage-section">
            <!-- 左栏：作用域清单（全局 + 项目目录；目录 = 最近工作区 ∪ 默认工作区，已删除的不显示） -->
            <nav class="skill-md-rail" aria-label="Skill 作用域">
              <div class="skill-md-rail__head"><span>作用域</span><span>{{ projectDirs.length }} 个目录</span></div>
              <button
                type="button"
                :class="['skill-md-item', { 'skill-md-item--active': skillScope.kind === 'global' }]"
                :aria-current="skillScope.kind === 'global' ? 'true' : 'false'"
                @click="skillScope = { kind: 'global' }"
              >
                <span class="skill-md-item__top">
                  <span class="skill-md-item__dot"></span>
                  <span class="skill-md-item__name">全局 Skill</span>
                </span>
                <span class="skill-md-item__path">~/.claude/skills</span>
                <span class="skill-md-item__meta">
                  <!-- C-6：探测中显「…」占位，与统计卡同门控（不再误显 共0·0 启用） -->
                  <template v-if="skillProbePending">共 … · … 启用</template>
                  <template v-else>共 {{ userSkills.length }} · {{ globalEnabledCount }} 启用</template>
                </span>
              </button>
              <!-- C-5：项目目录装载状态行（pending 占位 / error 显错+重试，重调 ensureProjectDirs） -->
              <div v-if="projectDirsPending" class="skill-md-rail__status">项目目录读取中…</div>
              <div v-else-if="projectDirsError" class="skill-md-rail__status skill-md-rail__status--error">
                <span class="skill-md-rail__status-text">{{ projectDirsError }}</span>
                <button type="button" class="skill-md-rail__status-retry" @click="ensureProjectDirs()">重试</button>
              </div>
              <!-- Y-1（2026-09-19 X-123 批评审 §2）：用户根枚举超时第三态——独立轻提示（不写
                   projectDirsError，项目目录与用户根两源独立）；重试同走 ensureProjectDirs。
                   Z-1（2026-09-19 Y-1 批独立评审 §2）：文案按 userSkillDirNamesReady 分化——
                   「曾装载成功后超时」（ready=true）态开关 :disabled 只看 !ready、实际可拨，
                   改述「正在使用上次成功读取的映射」；首访（ready=false）开关真禁用（X-2 门控），
                   维持「暂不可用」 -->
              <div v-else-if="userDirNamesTimedOut" class="skill-md-rail__status skill-md-rail__status--warn">
                <span class="skill-md-rail__status-text">{{ userSkillDirNamesReady ? '用户级 Skill 键名映射读取超时，正在使用上次成功读取的映射' : '用户级 Skill 键名映射读取超时，全局开关暂不可用' }}</span>
                <button type="button" class="skill-md-rail__status-retry" @click="ensureProjectDirs()">重试</button>
              </div>
              <div class="skill-md-rail__head">
                <span>项目目录 · 来自最近工作区</span><span>{{ projectDirs.length }} 个</span>
              </div>
              <button
                v-for="dir in projectDirs"
                :key="dir.path"
                type="button"
                :class="['skill-md-item', 'skill-md-item--project', { 'skill-md-item--active': skillScope.kind === 'project' && skillScope.path === dir.path }]"
                :aria-current="skillScope.kind === 'project' && skillScope.path === dir.path ? 'true' : 'false'"
                :title="dir.path"
                @click="skillScope = { kind: 'project', path: dir.path }"
              >
                <span class="skill-md-item__top">
                  <span class="skill-md-item__dot skill-md-item__dot--project"></span>
                  <span class="skill-md-item__name">{{ dir.name }}</span>
                  <span v-if="dir.isDefault" class="skill-md-tag">默认</span>
                </span>
                <span class="skill-md-item__path">{{ dir.path }}</span>
                <span class="skill-md-item__meta">共 {{ dir.skills.length }} · {{ projectEnabledCount(dir) }} 启用 · {{ dir.sessionCount }} 会话</span>
              </button>
              <div class="skill-md-rail__foot">目录自动来自最近工作区并集与默认工作区；已删除的目录不再显示。开关按 Skill 名全局生效。</div>
            </nav>

            <!-- 右栏：所选作用域详情 -->
            <div class="skill-md-main">
              <div class="skill-md-main__head">
                <div class="skill-md-title">
                  <span class="skill-md-title__name">
                    <span :class="['skill-md-title__dot', { 'skill-md-title__dot--project': skillScope.kind === 'project' }]"></span>
                    {{ skillScope.kind === 'global' ? '全局 Skill' : activeProjectDir?.name }}
                  </span>
                  <span class="skill-md-title__path">{{ scopePathText }}</span>
                </div>
                <div class="skill-md-title__meta">
                  <template v-if="skillScope.kind === 'global'">对所有项目的会话可用</template>
                  <template v-else-if="activeProjectDir">{{ activeProjectDir.sessionCount }} 个会话在使用 · {{ activeProjectDir.isDefault ? '默认工作区' : '最近目录' }}</template>
                </div>

                <!-- 快照状态条（页面级 v-if 链）：探测中（null/loading 同占位）/ degraded+error（B-1 附显式重试）；
                     仅全局作用域渲染（项目直读与快照无关）。ready 整条隐藏；stale 臂已删（C-8：写入者不产 stale） -->
                <template v-if="skillScope.kind === 'global'">
                  <div v-if="skillProbePending" class="snap-status snap-status--neutral" role="status">
                    正在从 Claude Code 引擎探测已加载的 Skill…
                  </div>
                  <!-- 首臂 skillProbePending（computed）不向 vue-tsc 传递非空收窄，后续臂用 ?. 取值
                       （实际不可达 null：这些臂仅在 skillProbePending=false 即快照非空时求值） -->
                  <div
                    v-else-if="commandStore.globalSnapshot?.status === 'degraded' || commandStore.globalSnapshot?.status === 'error'"
                    class="snap-status"
                    role="status"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path>
                    </svg>
                    <span>{{ commandStore.globalSnapshot?.error || '命令读取异常，可继续输入或发送' }}</span>
                    <button type="button" class="snap-status__retry" @click="retryGlobalSnapshot">重试</button>
                  </div>
                </template>

                <!-- 统计三卡（随开关实时重算，作用于当前作用域）+ 无障碍播报；「探测中」不渲染（0/0/0 是误导空态，S2-P2-2） -->
                <div v-if="!skillProbePending" class="stat-grid">
                  <div class="stat-card">
                    <span class="stat-card__num">{{ scopeItems.length }}</span>
                    <span class="stat-card__label">{{ skillScope.kind === 'global' ? '用户 Skill 总数' : '项目 Skill' }}</span>
                  </div>
                  <div class="stat-card stat-card--on">
                    <span class="stat-card__num">{{ skillEnabledCount }}</span>
                    <span class="stat-card__label">已启用</span>
                  </div>
                  <div class="stat-card stat-card--off">
                    <span class="stat-card__num">{{ skillDisabledCount }}</span>
                    <span class="stat-card__label">已禁用</span>
                  </div>
                </div>
                <span v-if="!skillProbePending" class="sr-only" aria-live="polite">已禁用 {{ skillDisabledCount }} 个，共 {{ scopeItems.length }} 个{{ skillScope.kind === 'global' ? '用户' : '项目' }} Skill</span>

                <!-- 工具行：搜索 + 状态过滤 chips -->
                <div class="skill-toolbar">
                  <input
                    v-model="skillSearch"
                    class="skill-search"
                    type="text"
                    placeholder="搜索 Skill 名称或描述…"
                    aria-label="搜索 Skill"
                  />
                  <div class="chips" role="group" aria-label="过滤">
                    <button type="button" :class="['chip', { 'chip--active': skillFilter === 'all' }]" @click="skillFilter = 'all'">全部</button>
                    <button type="button" :class="['chip', { 'chip--active': skillFilter === 'on' }]" @click="skillFilter = 'on'">已启用</button>
                    <button type="button" :class="['chip', { 'chip--active': skillFilter === 'off' }]" @click="skillFilter = 'off'">已禁用</button>
                  </div>
                </div>
              </div>
              <div class="skill-md-main__scroll">
                <!-- 探测占位（B8：pending 时双作用域同门——探测同一调用也验证 CLI 在位，进 tab 即触发通常亚秒） -->
                <div v-if="skillProbePending" class="skill-md-probe">正在从 Claude Code 引擎探测已加载的 Skill…</div>
                <template v-else>
                  <!-- 卡片网格：2 列（窄视口 ≤46rem 单列，见样式区断点）；徽章用 v-if 控制（避免类 display 盖过 [hidden] 的 UA 样式坑） -->
                  <div class="skill-grid">
                    <div
                      v-for="skill in visibleSkills"
                      :key="skill.name"
                      :class="['skill-card', { 'skill-card--off': !isSkillEnabled(skillKey(skill)) }]"
                    >
                      <div class="skill-card__head">
                        <span class="skill-card__name">{{ skill.name }}</span>
                        <!-- R-1：fm≠dir 条目「键名=目录名」小字提示（开关键口径=目录名；fm==dir 不显示） -->
                        <span
                          v-if="skill.dirName !== undefined && skill.dirName !== skill.name"
                          class="skill-card__keyhint"
                          title="该 Skill 的 frontmatter 名与目录名不一致；开关键（skillOverrides 键）使用目录名"
                        >键名 {{ skill.dirName }}</span>
                        <span :class="['scope-badge', { 'scope-badge--project': skillScope.kind === 'project' }]">{{ skillScope.kind === 'project' ? '项目' : '全局' }}</span>
                        <span v-if="dupSkillNames.has(skill.name)" class="dup-badge" title="该名称同时存在于多个作用域，开关按名全局生效">同名 · 联动</span>
                        <span v-if="!isSkillEnabled(skillKey(skill))" class="skill-card__badge">已禁用</span>
                      </div>
                      <div class="skill-card__desc" :title="skill.description">{{ skill.description }}</div>
                      <div class="skill-card__foot">
                        <span :class="['skill-card__state', { 'skill-card__state--on': isSkillEnabled(skillKey(skill)) }]">
                          {{ isSkillEnabled(skillKey(skill)) ? '新会话可用' : '新会话不加载' }}
                        </span>
                        <!-- X-2（2026-09-19 独立评审 §2）：映射未就绪时全局开关键集不可信（fm≠dir
                             条目 skillKey 回退 slash 名，拨开关写无效 fm 名键且载荷落地后回弹）——
                             禁用 + title 提示；项目条目 dirName 恒来自磁盘枚举，不受门控。
                             W-2（2026-09-19 Z-1 批独立评审 §2）：首访超时拍（ready=false+timedOut=true）
                             装载已落定为超时非进行中，title 按 userDirNamesTimedOut 分化出
                             「键名映射读取超时」，与 rail 同拍措辞对齐。 -->
                        <input
                          type="checkbox"
                          class="switch"
                          :checked="isSkillEnabled(skillKey(skill))"
                          :disabled="skillScope.kind === 'global' && !userSkillDirNamesReady"
                          :title="skillScope.kind === 'global' && !userSkillDirNamesReady ? (userDirNamesTimedOut ? '键名映射读取超时' : '键名映射读取中') : undefined"
                          :aria-label="`启用 skill ${skill.name}`"
                          @change="handleSkillToggle(skill, $event)"
                        />
                      </div>
                    </div>
                    <!-- 「探测中」不显示空态（loading 且 commands 为空 ≠ 无匹配，S2-P2-2）；真零 Skill（ready 且 0 个）仍显示 -->
                    <div v-if="!skillProbePending && visibleSkills.length === 0" class="skill-empty">
                      <!-- C-7：全局分支三态区分——真零（引导放置）/筛选零（原文案）；探测中由外层门控承担 -->
                      <template v-if="skillScope.kind === 'global'">
                        <template v-if="userSkills.length === 0">还没有全局 Skill<br /><code>~/.claude/skills/&lt;名称&gt;\SKILL.md</code> 放置后自动出现在这里</template>
                        <template v-else>当前筛选下无匹配的全局 Skill</template>
                      </template>
                      <template v-else-if="scopeItems.length === 0">该项目还没有项目级 Skill<br /><code>{{ activeProjectDir?.path }}\.claude\skills\&lt;名称&gt;\SKILL.md</code> 放置后自动出现在这里</template>
                      <template v-else>当前筛选下无匹配的项目 Skill</template>
                    </div>
                  </div>

                  <p class="skill-note">项目目录自动来自最近工作区与默认工作区（已删除的目录不再显示）；开关按 Skill 名全局生效，同名 Skill 跨作用域联动。禁用仅对 Claude Link 内新建的会话生效；开关即刻保存，新会话即刻生效。</p>

                  <!-- D-1：死键清理入口（手动确认式，不做自动清理；确认弹窗列出疑似键明细） -->
                  <div v-if="staleSkillKeys.length > 0" class="skill-stale-row">
                    <span class="skill-stale-row__text">发现 {{ staleSkillKeys.length }} 个失效开关键（对应 Skill 已不存在或已改名）</span>
                    <button type="button" class="skill-stale-row__btn" @click="cleanupStaleSkillKeys()">清理失效键</button>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </div>
  </section>
</template>

<style scoped>
/* r6-r9：设置页不再整页滚动——页头/标签常驻，滚动全部发生在工作区面板内部。 */
.settings {
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
  display: flex;
  overflow: hidden;
}

.settings-inner {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 1.5rem 2rem 1.75rem;
}

/* 标题/标签/工作区同宽一列（宽=var(--col-w)），列在页面水平居中；列内左缘同一条竖线。 */
.page-head {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  margin-bottom: 1rem;
  flex: none;
  width: var(--col-w);
  margin-inline: auto;
}

.back-button {
  margin-left: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  padding: 0.5rem 1rem;
  font-size: 0.8125rem;
  cursor: pointer;
  transition: background 0.15s, transform var(--duration-fast) var(--ease-out);
}

.back-button:hover {
  background: var(--color-panel-soft);
}

/* 家具块（横幅/toast/存储信息/操作条）与标题/标签/工作区同宽一列（用户反馈：
   这几块此前通栏偏长，须与整体列宽对齐并水平居中）。 */
.banner,
.toast,
.storage-info {
  width: var(--col-w);
  max-width: 100%;
  margin-inline: auto;
  flex: none;
}

.banner {
  border-radius: var(--radius-md);
  padding: 0.75rem 1rem;
  margin-bottom: 1.25rem;
  font-size: 0.8125rem;
}

.banner--ok {
  border: 1px solid var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  color: var(--color-accent-strong);
}

.banner--warn {
  border: 1px solid var(--color-warn-strong);
  background: color-mix(in srgb, var(--color-warn) 12%, transparent);
  color: var(--color-warn-strong);
}

.banner--info {
  border: 1px solid var(--color-border);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
}

.toast {
  border-radius: var(--radius-md);
  padding: 0.625rem 0.875rem;
  margin-bottom: 1rem;
  font-size: 0.8125rem;
}

.toast--success {
  border: 1px solid var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  color: var(--color-accent-strong);
}

.toast--error {
  border: 1px solid var(--color-fail-strong);
  background: color-mix(in srgb, var(--color-fail) 12%, transparent);
  color: var(--color-fail-strong);
}

.tabs-row {
  width: var(--col-w);
  max-width: 100%;
  margin-inline: auto;
  margin-bottom: 1.25rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border-bottom: 1px solid var(--color-border);
}

.tabs-row .tabs {
  width: auto;
  margin: 0;
  border-bottom: 0;
}

.save-actions {
  display: inline-flex;
  align-items: center;
  gap: 0.625rem;
  margin-left: auto;
  padding-bottom: 0.25rem;
}

@media (max-width: 42rem) {
  .tabs-row {
    align-items: flex-end;
  }

  .save-actions {
    flex-wrap: wrap;
    justify-content: flex-end;
  }
}

.test-btn {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0.5rem 0.875rem;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.test-btn:disabled {
  cursor: wait;
  opacity: 0.6;
}

.tabs {
  display: flex;
  gap: 0.25rem;
  margin-bottom: 1.25rem;
  border-bottom: 1px solid var(--color-border);
  flex: none;
  width: var(--col-w);
  margin-inline: auto;
}

.tab {
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  padding: 0.625rem 1rem;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color 0.15s, border-color 0.15s, transform var(--duration-fast) var(--ease-out);
}

.tab:hover {
  color: var(--color-text);
}

.tab--active {
  color: var(--color-accent-strong);
  border-bottom-color: var(--color-accent);
}

.save-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.625rem;
  border-radius: var(--radius-md);
  font-size: 0.75rem;
}

.save-badge--saving {
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
}

.save-badge--saved {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  color: var(--color-accent-strong);
}

.save-badge--error {
  background: color-mix(in srgb, var(--color-fail) 12%, transparent);
  color: var(--color-fail-strong);
}

.save-badge__dot {
  width: 8px;
  height: 8px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  opacity: 0.7;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.storage-info {
  margin-bottom: 1.25rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  padding: 0.625rem 0.875rem;
  font-size: 0.75rem;
  box-shadow: var(--ring-light), var(--elevation-1);
}

.storage-info summary {
  cursor: pointer;
  color: var(--color-text-muted);
}

.storage-info__body {
  display: grid;
  gap: 0.25rem;
  margin-top: 0.625rem;
}

.storage-info__body div {
  display: flex;
  gap: 0.625rem;
  align-items: baseline;
}

.storage-info__body span {
  color: var(--color-text-muted);
  min-width: 6rem;
  flex-shrink: 0;
}

.storage-info__body code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.75rem;
  color: var(--color-text);
  word-break: break-all;
}

/* ── 舞台与工作区（内容列统一 800px 上限，高度自然填满）── */
.stage {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.workbench {
  flex: 1;
  display: flex;
  align-items: stretch;
  width: var(--col-w);
  margin-inline: auto;
  /* flex:1 填满 .stage（flex column）剩余高度；min-height:0 解除 flex item 的自动最小尺寸钳制，
     内容超高出面板内部滚动兜底（不再锁 3:2 比例）。 */
  min-height: 0;
}

.wb-connection {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  /* 容器查询锚点：ProviderManager 的 @container(max-width:460px) 以它为参考，
     按 workbench 实际宽度（而非视口）决定「列表+详情」双栏/堆叠。 */
  container-type: inline-size;
}

/* 行为/外观：整卡表单（solo 卡，内部滚动，全圆角）。
   必须保持 flex 布局：display:block 会让 flex:1 在 height 撑满的子元素下失效，
   工作区被内容撑破、溢出被 .settings 裁掉（字号「大」时内容超高，底部看不到）。 */
.workbench--solo {
  display: flex;
  flex-direction: column;
}

.solo-card {
  flex: 1;
  min-width: 0;
  min-height: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--ring-light), var(--elevation-1);
  overflow: hidden;
}

.solo-card .mscroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

/* 设置页表单滚动容器：内容溢出时常驻低对比度滚动条（全局 overlay 滚动条 hover 才显现，
   表单溢出时无任何提示，用户误以为「下面没内容」；此处改常驻、hover 加深，仍保持细条风格）。 */
.solo-card .mscroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text-muted) 28%, transparent);
}

.solo-card .mscroll::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-muted);
}

/* 统一面板内部分组表单：字段间 hairline 分隔，标签/描述分层，控件精致化。 */
.section {
  display: flex;
  flex-direction: column;
  padding: 1.5rem;
}

.section-title {
  margin: 0 0 1.125rem;
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-text);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* 标题前 accent 竖条：给分组一个视觉锚点（不改变文案与结构）。 */
.section-title::before {
  content: '';
  width: 0.25rem;
  height: 1rem;
  border-radius: var(--radius-pill);
  background: var(--color-accent);
}

.field {
  display: grid;
  gap: 0.5rem;
  padding: 0.875rem 0;
}

/* 连续字段之间用 hairline 分隔（外观页单个字段无内部分隔线）。 */
.field + .field {
  border-top: 1px solid var(--color-border);
}

.field-label {
  color: var(--color-text);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.4;
}

.field-desc {
  color: var(--color-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.field-desc code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  color: var(--color-accent-strong);
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  padding: 0.1rem 0.35rem;
  border-radius: var(--radius-xs);
}

select,
input[type='text'],
input[type='number'] {
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0.5625rem 0.75rem;
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
  transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}

select:hover,
input[type='text']:hover,
input[type='number']:hover {
  border-color: var(--color-border-strong);
}

/* 主题网格与下方字号字段之间也补一条 hairline（与行为页字段节奏一致）。 */
.section .theme-selector {
  margin-bottom: 0.875rem;
}

.section .theme-selector + .field {
  border-top: 1px solid var(--color-border);
}

/* 布尔开关项：标题与描述在左（竖直堆叠同一列）、开关在右跨两行居中。
   原生 checkbox 用 CSS 重塑为 switch，保留 <input type="checkbox"> 与 v-model 绑定不变
   （可访问性不损失）。 */
.field--toggle {
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 0.5rem 1.5rem;
}

.field--toggle .field-label,
.field--toggle .field-desc {
  grid-column: 1;
}

.field--toggle input[type='checkbox'] {
  grid-column: 2;
  grid-row: 1 / span 2;
  align-self: center;
}

.field--toggle input[type='checkbox'] {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  width: 2.75rem;
  height: 1.5rem;
  margin: 0;
  border-radius: var(--radius-pill);
  background: var(--color-border);
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--duration-base) var(--ease-out);
}

.field--toggle input[type='checkbox']::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 0.1875rem;
  width: 1.125rem;
  height: 1.125rem;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transform: translateY(-50%);
  transition: transform var(--duration-base) var(--ease-spring);
}

.field--toggle input[type='checkbox']:checked {
  background: var(--color-accent);
}

.field--toggle input[type='checkbox']:checked::before {
  transform: translateY(-50%) translateX(1.25rem);
}

.field--toggle input[type='checkbox']:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

/* ── Skill 管理（B2 独立设置页，视觉基准 docs/prototypes/skill-management/option-b2-standalone-tab.html）── */

/* 快照状态条：页面级，v-if 链（探测中=neutral / degraded+error=warn 附 B-1 重试 / ready=不渲染；
   C-8：stale 臂已删，写入者不产 stale）。 */
.snap-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid color-mix(in srgb, var(--color-warn) 55%, transparent);
  background: color-mix(in srgb, var(--color-warn) 12%, transparent);
  color: var(--color-warn-strong);
  border-radius: var(--radius-sm);
  padding: 0.4375rem 0.75rem;
  font-size: 0.75rem;
  margin: 1rem 0 0;
}

.snap-status svg {
  width: 0.875rem;
  height: 0.875rem;
  flex-shrink: 0;
}

.snap-status--neutral {
  border-color: var(--color-border);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
}

/* B-1：degraded/error 臂的显式重试按钮（Skill 页无「重开菜单」旁路，自愈通道可视化）。 */
.snap-status__retry {
  margin-left: auto;
  flex-shrink: 0;
  border: 1px solid color-mix(in srgb, var(--color-warn-strong) 50%, transparent);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--color-warn-strong);
  padding: 0.1875rem 0.625rem;
  font-size: 0.6875rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: background var(--duration-fast) var(--ease-out);
}

.snap-status__retry:hover {
  background: color-mix(in srgb, var(--color-warn) 16%, transparent);
}

/* 统计三卡（总数 / 已启用 / 已禁用），数字随开关实时重算。 */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.625rem;
  margin: 1.125rem 0 1rem;
}

.stat-card {
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.75rem 0.875rem;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.stat-card__num {
  font-size: 1.375rem;
  font-weight: 700;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  color: var(--color-text);
}

.stat-card--on .stat-card__num {
  color: var(--color-accent-strong);
}

.stat-card--off .stat-card__num {
  color: var(--color-fail-strong);
}

.stat-card__label {
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

/* 工具行：搜索框 + 状态过滤 chips。 */
.skill-toolbar {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}

/* input.skill-search：双类选择器压过上方 input[type='text'] 通用规则（特异性 0,1,1 同级靠后生效）。 */
input.skill-search {
  flex: 1;
  min-width: 12rem;
  width: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
  transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}

input.skill-search:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 18%, transparent);
}

.chips {
  display: inline-flex;
  gap: 0.375rem;
}

.chip {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
  padding: 0.3125rem 0.75rem;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out);
}

.chip:hover {
  color: var(--color-text);
  border-color: var(--color-border-strong);
}

.chip--active {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  border-color: var(--color-accent);
  color: var(--color-accent-strong);
}

/* 卡片网格：2 列（窄视口单列，原型同款断点）。 */
.skill-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.625rem;
  margin: 0 -0.25rem;
}

@media (max-width: 46rem) {
  .skill-grid {
    grid-template-columns: 1fr;
  }
}

.skill-card {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 0.75rem 0.875rem;
  transition: box-shadow var(--duration-base) var(--ease-out), border-color var(--duration-base) var(--ease-out), opacity var(--duration-base) var(--ease-out);
}

.skill-card:hover {
  box-shadow: var(--elevation-2);
  border-color: var(--color-border-strong);
}

/* 禁用卡整体降不透明度 + 背景透明化，hover 恢复（启用态不动）。 */
.skill-card--off {
  opacity: 0.66;
  background: transparent;
}

.skill-card--off:hover {
  opacity: 0.85;
}

.skill-card__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.skill-card__name {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-text);
  word-break: break-all;
}

/* R-1：fm≠dir 条目的「键名=目录名」小字提示（开关键口径在卡片上可见，避免键名歧义）。 */
.skill-card__keyhint {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  word-break: break-all;
}

.skill-card__badge {
  flex-shrink: 0;
  margin-left: auto;
  padding: 0.0625rem 0.4375rem;
  border-radius: var(--radius-xs);
  font-size: 0.6875rem;
  font-weight: 600;
  border: 1px solid color-mix(in srgb, var(--color-fail) 45%, transparent);
  background: color-mix(in srgb, var(--color-fail) 12%, transparent);
  color: var(--color-fail-strong);
}

.skill-card__desc {
  color: var(--color-text-muted);
  font-size: 0.75rem;
  line-height: 1.45;
  min-height: 2.175rem;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.skill-card__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.skill-card__state {
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.skill-card__state--on {
  color: var(--color-accent-strong);
  font-weight: 600;
}

.skill-empty {
  grid-column: 1 / -1;
  padding: 1.75rem;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
}

.skill-note {
  margin: 1rem 0 0;
  padding-top: 0.75rem;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: 0.75rem;
  line-height: 1.55;
}

/* D-1：死键清理入口行（skill-note 之下，疑似键存在时才渲染）。 */
.skill-stale-row {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  margin-top: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px dashed color-mix(in srgb, var(--color-warn-strong) 45%, transparent);
  border-radius: var(--radius-md);
  font-size: 0.75rem;
  color: var(--color-warn-strong);
}

.skill-stale-row__text {
  flex: 1;
  min-width: 0;
}

.skill-stale-row__btn {
  flex-shrink: 0;
  border: 1px solid color-mix(in srgb, var(--color-warn-strong) 50%, transparent);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--color-warn-strong);
  padding: 0.1875rem 0.625rem;
  font-size: 0.6875rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: background var(--duration-fast) var(--ease-out);
}

.skill-stale-row__btn:hover {
  background: color-mix(in srgb, var(--color-warn) 16%, transparent);
}

/* 无障碍播报（统计 aria-live）：视觉隐藏。 */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* Skill 卡开关：独立 .switch（与 .field--toggle 同款 pill 形态，on=启用；卡片场景非表单行）。 */
.switch {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  width: 2.75rem;
  height: 1.5rem;
  margin: 0;
  border-radius: var(--radius-pill);
  background: var(--color-border);
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--duration-base) var(--ease-out);
}

.switch::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 0.1875rem;
  width: 1.125rem;
  height: 1.125rem;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transform: translateY(-50%);
  transition: transform var(--duration-base) var(--ease-spring);
}

.switch:checked {
  background: var(--color-accent);
}

.switch:checked::before {
  transform: translateY(-50%) translateX(1.25rem);
}

.switch:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

/* Y-3（2026-09-19 X-123 批评审 §2，OPT）：X-2 禁用态视觉形态——映射装载期间开关灰显 +
   not-allowed 光标，不再「看似可点实则不可点」（原仅 title 兜底）。 */
.switch:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* ── Skill 管理双栏 master-detail（方案 B，视觉基准 docs/prototypes/skill-management/proj-b-master-detail.html）──
   既有类名（snap-status/stat-grid/skill-toolbar/skill-search/chips/chip/skill-grid/skill-card 全家族/
   skill-empty/skill-note/switch）一律不改不删；新增 skill-md-* 前缀类与效果图 md-* 一一对应。
   项目紫直接写字面 #7C5CFC（hover 深 #5F3DC4），不新增全局 token（避免动 variables.css 影响面）。 */

.skill-md-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* 左栏：作用域清单（全局 + 项目目录），自有滚动。 */
.skill-md-rail {
  width: 264px;
  flex: none;
  border-right: 1px solid var(--color-border);
  background: var(--color-panel);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.skill-md-rail::-webkit-scrollbar {
  width: 8px;
}

.skill-md-rail::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text-muted) 28%, transparent);
  border-radius: var(--radius-pill);
}

.skill-md-rail__head {
  padding: 0.875rem 1rem 0.4375rem;
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.skill-md-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.125rem;
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  padding: 0.5625rem 0.875rem 0.5625rem 1rem;
  cursor: pointer;
  font-family: inherit;
  border-left: 2px solid transparent;
  transition: background var(--duration-fast) var(--ease-out);
}

.skill-md-item:hover {
  background: var(--color-panel-soft);
}

.skill-md-item--active {
  background: var(--color-panel-soft);
  border-left-color: var(--color-accent);
}

/* active 左侧 2px 竖条：全局=accent 蓝、项目=紫。 */
.skill-md-item--project.skill-md-item--active {
  border-left-color: #7C5CFC;
}

.skill-md-item__top {
  display: flex;
  align-items: center;
  gap: 0.4375rem;
  min-width: 0;
}

.skill-md-item__dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--color-accent);
  flex-shrink: 0;
}

.skill-md-item__dot--project {
  background: #7C5CFC;
}

.skill-md-item__name {
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-md-item__path {
  font-family: var(--font-mono);
  font-size: 0.6563rem;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 0.9375rem;
}

.skill-md-item__meta {
  display: flex;
  gap: 0.375rem;
  align-items: center;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  padding-left: 0.9375rem;
  flex-wrap: wrap;
}

/* rail 行内小 tag（「默认」）。 */
.skill-md-tag {
  flex-shrink: 0;
  font-size: 0.625rem;
  font-weight: 700;
  padding: 0.0625rem 0.375rem;
  border-radius: var(--radius-xs);
  background: color-mix(in srgb, var(--color-accent) 14%, transparent);
  color: var(--color-accent-strong);
}

/* C-5：项目目录装载状态行（pending 占位 / error 显错+重试），置于全局行与项目分组之间。 */
.skill-md-rail__status {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.4375rem 0.875rem;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}

/* Y-1：超时第三态与错误行同色系（warn 系），语义由文字区分（超时=可自愈的降态，非硬错误）。 */
.skill-md-rail__status--error,
.skill-md-rail__status--warn {
  color: var(--color-warn-strong);
  flex-wrap: wrap;
}

.skill-md-rail__status-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.skill-md-rail__status-retry {
  flex-shrink: 0;
  border: 1px solid color-mix(in srgb, var(--color-warn-strong) 50%, transparent);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--color-warn-strong);
  padding: 0.125rem 0.5rem;
  font-size: 0.625rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: background var(--duration-fast) var(--ease-out);
}

.skill-md-rail__status-retry:hover {
  background: color-mix(in srgb, var(--color-warn) 16%, transparent);
}

.skill-md-rail__foot {
  margin-top: auto;
  padding: 0.75rem 1rem 0.875rem;
  border-top: 1px dashed var(--color-border);
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  line-height: 1.55;
}

/* 右栏：所选作用域详情（头部固定不滚 + 滚动区）。 */
.skill-md-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.skill-md-main__head {
  flex: none;
  padding: 1rem 1.25rem 0.875rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-panel);
}

.skill-md-title {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.skill-md-title__name {
  font-size: 0.9375rem;
  font-weight: 700;
  color: var(--color-text);
  display: inline-flex;
  align-items: center;
  gap: 0.4375rem;
}

.skill-md-title__dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--color-accent);
}

.skill-md-title__dot--project {
  background: #7C5CFC;
}

.skill-md-title__path {
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}

.skill-md-title__meta {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin: 0.25rem 0 0;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}

.skill-md-main__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem 1.25rem 1.25rem;
}

.skill-md-main__scroll::-webkit-scrollbar {
  width: 8px;
}

.skill-md-main__scroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text-muted) 28%, transparent);
  border-radius: var(--radius-pill);
}

/* 探测占位行（pending 时双作用域同门，替代网格与统计渲染）。 */
.skill-md-probe {
  padding: 1.75rem;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
}

/* 作用域徽章（全局=蓝/项目=紫）与「同名 · 联动」虚线徽章（开关键空间按名全局生效的提示）。 */
.scope-badge {
  flex-shrink: 0;
  padding: 0.0625rem 0.4375rem;
  border-radius: var(--radius-pill);
  font-size: 0.625rem;
  font-weight: 700;
  border: 1px solid color-mix(in srgb, var(--color-accent) 45%, transparent);
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  color: var(--color-accent-strong);
}

.scope-badge--project {
  border-color: color-mix(in srgb, #7C5CFC 45%, transparent);
  background: color-mix(in srgb, #7C5CFC 10%, transparent);
  color: #5F3DC4;
}

.dup-badge {
  flex-shrink: 0;
  padding: 0.0625rem 0.4375rem;
  border-radius: var(--radius-pill);
  font-size: 0.625rem;
  font-weight: 700;
  border: 1px dashed color-mix(in srgb, var(--color-warn-strong) 50%, transparent);
  color: var(--color-warn-strong);
}

/* 空态引导里的路径 code（项目零 Skill 时提示放置位置）。 */
.skill-empty code {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--color-accent-strong);
  overflow-wrap: anywhere;
}

</style>
