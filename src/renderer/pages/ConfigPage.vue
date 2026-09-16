<script setup lang="ts">
// ConfigPage.vue — 设置页。
// 结构：标题/标签/工作区同宽一列（宽 = min(100%, --chat-bottom-max-width)，与聊天/会话页同一 800px 契约），
// 列在页面水平居中；工作区 flex:1 填满剩余高度，连接页=供应商列表+详情复合面板，行为/外观共用同一 solo 卡片。
// 行为/外观页内部排版严格保留原字段顺序/文案/控件（r9：仅装入统一面板，禁止重排）。
// 所有滚动发生在面板内部；尺寸全部 rem（随 fontScale 等比缩放）。
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useConfigStore, lastSaveFailed } from '../stores/config-store';
import { useCommandStore } from '../stores/command-store';
import ProviderManager from '../components/providers/ProviderManager.vue';
import ThemeSelector from '../components/config/ThemeSelector.vue';
import { THEME_PALETTES, FONT_SCALE_SIZES } from '../../shared/constants';
import { sanitizeTaskDelayMinutes } from '../../shared/queue-config';
import { sanitizeMaxTurns } from '../../shared/max-turns';
import type { SdkCommand } from '../../shared/types/command';

const store = useConfigStore();
const commandStore = useCommandStore();
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
      await store.saveConfig();
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
    void store
      .saveConfig()
      .then(() => {
        lastSavedSnapshot = configSnapshot();
      })
      .catch(() => {
        saveStatus.value = 'error';
      });
  }
});

// 高级 JSON 编辑器已随多供应商化移除；advancedJson（全局 permissions/hooks/env）暂无 UI
// 维护入口（config-store 的 importSettings/autoDetectClaudeConfig/fillFromAdvancedJson 均无
// 调用方，仅存档），只能手改存储文件或经 SDK settings 生效。

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
    await store.saveConfig();
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
watch(activeTab, (tab) => {
  if (tab === 'skill') void commandStore.ensureGlobalSnapshot();
});

const userSkills = computed<SdkCommand[]>(() => {
  const snapshot = commandStore.globalSnapshot;
  if (!snapshot) return [];
  return snapshot.commands
    .filter((c) => c.origin === 'user-skill')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
});

// 开关语义：checked = 启用。启用 = 未禁用（键缺失或值非 'off' 均视为启用）；?. 防御存量存储缺键形态。
function isSkillEnabled(name: string): boolean {
  return store.config.skillOverrides?.[name] !== 'off';
}

// 拨开 → 删除该键（不落 'on' 残值，空配置在主进程不加 settings 键）；拨关 → 置 'off'。
// 整体替换对象触发 PERSISTED_FIELDS 快照比对 → 既有 700ms 防抖自动保存（卸载 flush 兜底）。
function setSkillEnabled(name: string, enabled: boolean): void {
  const next: Record<string, 'off'> = { ...(store.config.skillOverrides ?? {}) };
  if (enabled) delete next[name];
  else next[name] = 'off';
  store.config.skillOverrides = next;
}

function handleSkillToggle(skill: SdkCommand, e: Event): void {
  setSkillEnabled(skill.name, (e.target as HTMLInputElement).checked);
}

// 统计随开关实时重算；无障碍播报见模板 sr-only[aria-live]。
const skillEnabledCount = computed(() => userSkills.value.filter((s) => isSkillEnabled(s.name)).length);
const skillDisabledCount = computed(() => userSkills.value.length - skillEnabledCount.value);

// 纯前端过滤：搜索（名称+描述，大小写不敏感）× 状态 chips（全部/已启用/已禁用）。
const visibleSkills = computed(() => {
  const q = skillSearch.value.trim().toLowerCase();
  return userSkills.value.filter((s) => {
    const enabled = isSkillEnabled(s.name);
    const matchQuery = !q || `${s.name} ${s.description}`.toLowerCase().includes(q);
    const matchFilter = skillFilter.value === 'all' || (skillFilter.value === 'on' ? enabled : !enabled);
    return matchQuery && matchFilter;
  });
});

// stale 提示条的「上次引擎探测于 N 分钟前」短语：快照 updatedAt 缺失/非法时省略该短语。
const snapshotAgeText = computed(() => {
  const updatedAt = commandStore.globalSnapshot?.updatedAt;
  if (!updatedAt) return '';
  const elapsedMs = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return '';
  return `上次引擎探测于 ${Math.max(1, Math.round(elapsedMs / 60000))} 分钟前`;
});
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

        <!-- Skill：B2 独立设置页（快照状态条 + 统计三卡 + 搜索/chips + 卡片网格 + 说明）。
             数据源 = commandStore.globalSnapshot（引擎全局探测快照）的 user-skill 子集；
             开关 checked = 启用，写 config.skillOverrides（键='off' 即禁用），走自动保存。 -->
        <div v-show="activeTab === 'skill'" class="solo-card">
          <div class="mscroll">
            <div class="section" data-testid="skill-manage-section">
              <h3 class="section-title">Skill 管理</h3>

              <!-- 快照状态条（页面级 v-if 链）：探测中（null/loading 同占位）/ stale / degraded+error；ready 整条隐藏 -->
              <div v-if="skillProbePending" class="snap-status snap-status--neutral" role="status">
                正在从 Claude Code 引擎探测已加载的 Skill…
              </div>
              <!-- 首臂 skillProbePending（computed）不向 vue-tsc 传递非空收窄，后续臂用 ?. 取值
                   （实际不可达 null：这些臂仅在 skillProbePending=false 即快照非空时求值） -->
              <div v-else-if="commandStore.globalSnapshot?.status === 'stale'" class="snap-status" role="status">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path>
                </svg>
                <span>命令快照可能不是最新{{ snapshotAgeText ? ` — ${snapshotAgeText}` : '' }}；磁盘上的 Skill 变更会自动热刷新</span>
              </div>
              <div
                v-else-if="commandStore.globalSnapshot?.status === 'degraded' || commandStore.globalSnapshot?.status === 'error'"
                class="snap-status"
                role="status"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path>
                </svg>
                <span>{{ commandStore.globalSnapshot?.error || '命令读取异常，可继续输入或发送' }}</span>
              </div>

              <!-- 统计三卡（随开关实时重算）+ 无障碍播报；「探测中」不渲染（0/0/0 是误导空态，S2-P2-2） -->
              <div v-if="!skillProbePending" class="stat-grid">
                <div class="stat-card">
                  <span class="stat-card__num">{{ userSkills.length }}</span>
                  <span class="stat-card__label">用户 Skill 总数</span>
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
              <span v-if="!skillProbePending" class="sr-only" aria-live="polite">已禁用 {{ skillDisabledCount }} 个，共 {{ userSkills.length }} 个用户 Skill</span>

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

              <!-- 卡片网格：2 列（窄容器单列）；徽章用 v-if 控制（避免类 display 盖过 [hidden] 的 UA 样式坑） -->
              <div class="skill-grid">
                <div
                  v-for="skill in visibleSkills"
                  :key="skill.name"
                  :class="['skill-card', { 'skill-card--off': !isSkillEnabled(skill.name) }]"
                >
                  <div class="skill-card__head">
                    <span class="skill-card__name">{{ skill.name }}</span>
                    <span v-if="!isSkillEnabled(skill.name)" class="skill-card__badge">已禁用</span>
                  </div>
                  <div class="skill-card__desc" :title="skill.description">{{ skill.description }}</div>
                  <div class="skill-card__foot">
                    <span :class="['skill-card__state', { 'skill-card__state--on': isSkillEnabled(skill.name) }]">
                      {{ isSkillEnabled(skill.name) ? '新会话可用' : '新会话不加载' }}
                    </span>
                    <input
                      type="checkbox"
                      class="switch"
                      :checked="isSkillEnabled(skill.name)"
                      :aria-label="`启用 skill ${skill.name}`"
                      @change="handleSkillToggle(skill, $event)"
                    />
                  </div>
                </div>
                <!-- 「探测中」不显示空态（loading 且 commands 为空 ≠ 无匹配，S2-P2-2）；真零 Skill（ready 且 0 个）仍显示 -->
                <div v-if="!skillProbePending && visibleSkills.length === 0" class="skill-empty">当前筛选下无匹配的 Skill</div>
              </div>

              <p class="skill-note">禁用仅对 Claude Link 内新建的会话生效；已有会话不受影响。开关即刻保存，新会话即刻生效。</p>
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
.storage-info,
.autodetect-bar {
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

.autodetect-bar {
  display: none;
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

.autodetect-btn {
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: var(--color-on-accent);
  padding: 0.5rem 0.875rem;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  box-shadow: var(--ring-light-accent);
}

.autodetect-info {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
  flex-basis: 100%;
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

.field .required {
  color: var(--color-danger);
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

/* 快照状态条：页面级，v-if 链（探测中=neutral / stale、degraded+error=warn / ready=不渲染）。 */
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

</style>
