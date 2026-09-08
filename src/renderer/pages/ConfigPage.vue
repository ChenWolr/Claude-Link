<script setup lang="ts">
// ConfigPage.vue — 设置页。
// 结构：标题/标签/工作区同宽一列（宽 = min(100%, --chat-bottom-max-width)，与聊天/会话页同一 800px 契约），
// 列在页面水平居中；工作区 flex:1 填满剩余高度，连接页=供应商列表+详情复合面板，行为/外观共用同一 solo 卡片。
// 行为/外观页内部排版严格保留原字段顺序/文案/控件（r9：仅装入统一面板，禁止重排）。
// 所有滚动发生在面板内部；尺寸全部 rem（随 fontScale 等比缩放）。
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useConfigStore, lastSaveFailed } from '../stores/config-store';
import ProviderManager from '../components/providers/ProviderManager.vue';
import ThemeSelector from '../components/config/ThemeSelector.vue';
import { THEME_PALETTES, FONT_SCALE_SIZES } from '../../shared/constants';
import { sanitizeTaskDelayMinutes } from '../../shared/queue-config';
import { sanitizeMaxTurns } from '../../shared/max-turns';

const store = useConfigStore();
const router = useRouter();
const toast = ref<string | null>(null);
const toastType = ref<'success' | 'error'>('success');

// 分类标签页：连接（供应商/模型可选项库）/ 行为 / 外观。
type TabId = 'connection' | 'behavior' | 'appearance';
const activeTab = ref<TabId>('connection');

// 自动保存：监听所有用户可编辑的持久化字段，700ms 防抖落盘，确保所有配置都永久保存。
// 用快照字符串比对建立基线，避免 saveConfig 回写 config 时触发死循环；
// cliPath/cliVersion/workingDirectory 由系统维护（自动检测/未开放编辑），不纳入快照。
const PERSISTED_FIELDS = [
  'provider', 'providerName', 'providerNote', 'apiKey', 'apiBaseUrl',
  'defaultModel', 'advancedJson', 'permissionMode', 'maxTurns', 'queueEnabled', 'taskDelayMinutes', 'themePaletteId', 'fontScale', 'contextWindowByAlias', 'defaultThinkingLevel', 'disableAutoMemory', 'disableBackgroundTasks', 'disableCron', 'disableFeedbackSurvey', 'disableTelemetry', 'disableNonessentialTraffic',
  'notifyOnLeave', 'minimizeToTray',
] as const;

const saveStatus = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
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
      saveStatus.value = 'saved';
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

// 高级 JSON 编辑器已随多供应商化移除：连接配置由供应商库维护，
// config.advancedJson（全局 permissions/hooks/env）仍经「自动检测配置」导入维护。

function showToast(message: string, type: 'success' | 'error' = 'success'): void {
  toastType.value = type;
  toast.value = message;
  setTimeout(() => {
    toast.value = null;
  }, 3000);
}

async function handleSave() {
  // 立即落盘（不等防抖），并修正 URL 尾部斜杠
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
         config.advancedJson 仍承载全局 permissions/hooks/env，经「自动检测配置」导入）-->

    <!-- 分类标签页与保存状态同行，保存反馈靠右对齐 -->
    <div class="tabs-row">
      <nav class="tabs" aria-label="设置分类">
        <button type="button" :class="['tab', { 'tab--active': activeTab === 'connection' }]" @click="activeTab = 'connection'">连接</button>
        <button type="button" :class="['tab', { 'tab--active': activeTab === 'behavior' }]" @click="activeTab = 'behavior'">行为</button>
        <button type="button" :class="['tab', { 'tab--active': activeTab === 'appearance' }]" @click="activeTab = 'appearance'">外观</button>
      </nav>
      <div class="save-actions">
        <span v-if="saveStatus !== 'idle'" :class="['save-badge', `save-badge--${saveStatus}`]">
          <span v-if="saveStatus === 'saving'" class="save-badge__dot" />
          {{ saveStatus === 'saving' ? '保存中…' : saveStatus === 'saved' ? '保存成功' : '保存失败' }}
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
</style>
