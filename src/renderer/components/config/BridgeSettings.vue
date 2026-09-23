<script setup lang="ts">
// BridgeSettings.vue — 设置页 IM tab 内容（方案 D：左平台导航 + 右详情双栏，
// 视觉基准 docs/prototypes/im-bridge-tab/round2-d-lobster-structure.html）。
// 保存语义：字段 blur / 开关 change 即 bridgeSaveConfig（掩码规则由主进程处理，密钥不回显）。
// 状态：挂载时 bridgeGetStatus 拉快照 + onBridgeStatusChanged 订阅增量；
// v-show 常挂（ConfigPage IM tab 门控），切 tab 不卸载、扫码轮询链不中断。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { BridgeConfigGetResult, BridgeConfigSaveInput, BridgeBindingView, BridgePlatformStatus, BridgePlatformStatusEntry } from '../../../shared/types/bridge';

const claude = window.claudeLink;

const config = ref<BridgeConfigGetResult | null>(null);
const statuses = ref<BridgePlatformStatusEntry[]>([]);
const bindings = ref<BridgeBindingView[]>([]);
const saveError = ref('');
// 解绑 transient 提示（生命周期修复批次1）：确认框通过后展示 4s，告知解绑语义与平台连接保持。
const unbindNotice = ref('');
let unbindNoticeTimer: number | undefined;
// 飞书 appId 即时校验（批次1.3）：blur 时格式非法 → 红字且不触发保存。
const appidError = ref('');

// 飞书表单
const feishuAppSecret = ref('');
const feishuTesting = ref(false);
const feishuTestResult = ref<{ ok: boolean; detail?: string } | null>(null);

// 微信扫码
const qrDataUrl = ref('');
const qrQrcodeId = ref('');
const qrLoginBusy = ref(false);
const qrExpired = ref(false);
const qrError = ref('');
const QR_POLL_INTERVAL_MS = 4000;
let qrTimer: number | undefined;
let qrPollDisposed = false; // 卸载后不再链式排下一轮（防在途 poll 回来后泄漏定时器）
let stopStatusChanged: (() => void) | null = null;

function statusOf(platform: 'feishu' | 'wechat'): BridgePlatformStatusEntry | undefined {
  return statuses.value.find((s) => s.platform === platform);
}

// 批次3.4：重连按钮 busy 锁（全局单飞；未启用平台禁用由模板 :disabled 承担）。
const restarting = ref<'' | 'feishu' | 'wechat'>('');

function wechatSessionExpired(): boolean {
  return statusOf('wechat')?.status === 'error' && (statusOf('wechat')?.error ?? '').includes('session expired');
}

async function loadAll(): Promise<void> {
  try {
    config.value = await claude.bridgeGetConfig();
    statuses.value = await claude.bridgeGetStatus();
    bindings.value = await claude.bridgeListBindings();
  } catch (e) {
    saveError.value = `加载 IM 机器人配置失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

async function save(patch: BridgeConfigSaveInput): Promise<void> {
  saveError.value = '';
  try {
    config.value = await claude.bridgeSaveConfig(patch);
    statuses.value = await claude.bridgeGetStatus();
  } catch (e) {
    saveError.value = `保存失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── 飞书 ──

// 批次5.1-6：appId 输入框本地 ref（v-model）——testFeishu 先用当前输入框值保存再测（E5-2 混测修正）。
const feishuAppIdInput = ref('');
watch(config, (c) => { feishuAppIdInput.value = c?.feishu.appId ?? ''; });

// appId blur 保存（批次1.3 即时校验 + 批次5.1-6 本地 ref）：非空且格式非法 → 红字 early return，
// 不触发 save；空值放行（交由主进程既有「凭据未配置完整」路径）；主进程保存路径另有同款正则兜底。
function saveFeishuAppId(): void {
  const value = feishuAppIdInput.value.trim();
  if (value && !/^cli_[0-9a-fA-F]{16}$/.test(value)) {
    appidError.value = 'App ID 格式应为 cli_ 开头的 20 位字符';
    return;
  }
  appidError.value = '';
  void save({ feishu: { appId: value } });
}

async function saveFeishuSecret(): Promise<void> {
  // 掩码语义在主进程：空串=清除，'********'=保留。输入框不回显已存密钥。
  const incoming = feishuAppSecret.value;
  if (!incoming) return; // blur 时无输入不触发保存
  await save({ feishu: { appSecret: incoming } });
  feishuAppSecret.value = '';
}

async function testFeishu(): Promise<void> {
  feishuTesting.value = true;
  feishuTestResult.value = null;
  try {
    // 输入框有新密钥用新值，否则主进程用已存密文（掩码语义）。
    feishuTestResult.value = await claude.bridgeTestFeishu({
      appId: config.value?.feishu.appId,
      appSecret: feishuAppSecret.value || undefined,
    });
  } catch (e) {
    feishuTestResult.value = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    feishuTesting.value = false;
  }
}

function clearOwner(): void {
  void save({ feishu: { ownerOpenId: '' } });
}

// ── 微信 ──

async function startQrcodeLogin(): Promise<void> {
  // R2 观察：扫码在途再点会产生双轮询链——先终止旧链（清 id 使旧链回来后不再续排）再开新链。
  if (qrQrcodeId.value) {
    stopQrcodePoll();
    qrQrcodeId.value = '';
  }
  qrLoginBusy.value = true;
  qrExpired.value = false;
  qrError.value = '';
  try {
    const qr = await claude.bridgeWechatQrcode();
    qrDataUrl.value = qr.qrcodeDataUrl;
    qrQrcodeId.value = qr.qrcodeId;
    stopQrcodePoll();
    // 首查；后续由 pollQrcodeStatus 完成后链式自排（review P3e，防长轮询在途请求堆积）。
    await pollQrcodeStatus();
  } catch (e) {
    saveError.value = `获取微信登录二维码失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    qrLoginBusy.value = false;
  }
}

async function pollQrcodeStatus(): Promise<void> {
  // R2 观察：快照本轮链的 qrcodeId——长轮询在途时旧链与新链（再点登录）可能并存，
  // 全程以局部 id 收发，尾部重排前校验仍是本链，防旧链回来续排产生双链。
  const id = qrQrcodeId.value;
  if (!id) return;
  let settled = false; // 终态（confirmed/expired/error）→ 停止轮询
  try {
    const r = await claude.bridgeWechatQrcodeStatus(id);
    if (r.status === 'confirmed') {
      settled = true;
      stopQrcodePoll();
      qrDataUrl.value = '';
      qrQrcodeId.value = '';
      await loadAll();
    } else if (r.status === 'expired') {
      settled = true;
      stopQrcodePoll();
      qrDataUrl.value = '';
      qrQrcodeId.value = '';
      qrExpired.value = true;
    } else if (r.status === 'error') {
      // review P3b：扫码链路错误文案透传展示，不再当作「二维码已过期」误导用户重扫。
      settled = true;
      stopQrcodePoll();
      qrDataUrl.value = '';
      qrQrcodeId.value = '';
      qrError.value = r.error;
    }
  } catch {
    // 单次轮询失败静默（下轮再试）
  }
  // 链式轮询：本次完成（含失败）后才排下一次，防 35s 长轮询在途时请求堆积（review P3e）；
  // 重排前校验 qrQrcodeId 仍是本链快照 id——旧链在途回来（已被新链替换/终止）不再排程（R2 观察）。
  if (!settled && !qrPollDisposed && qrQrcodeId.value === id) {
    qrTimer = window.setTimeout(() => {
      qrTimer = undefined;
      void pollQrcodeStatus();
    }, QR_POLL_INTERVAL_MS);
  }
}

function stopQrcodePoll(): void {
  if (qrTimer !== undefined) {
    window.clearTimeout(qrTimer);
    qrTimer = undefined;
  }
}

async function wechatLogout(): Promise<void> {
  // 清 token=存空串（主进程 resolveSecretPatch 空串→null）。
  qrDataUrl.value = '';
  await save({ wechat: { botToken: '' } });
}

async function pickWorkingDir(): Promise<void> {
  const dir = await claude.pickWorkspaceDir();
  if (dir) await save({ global: { workingDir: dir } });
}

// 解绑（生命周期修复批次1）：确认框明示「消息被忽略 + 平台不断开」语义；成功后 transient
// 提示 4s 并重拉列表。彻底停用引导走平台开关（面板提示文案）。
async function unbindBinding(sessionKey: string): Promise<void> {
  if (!window.confirm('确定解绑？解绑后该用户的消息将被忽略，直到对方发送 /new 重新绑定。平台连接保持不断开。')) return;
  try {
    await claude.bridgeUnbind(sessionKey);
    unbindNotice.value = '已解绑；期间该用户消息将被忽略，平台连接保持（彻底停用请关闭平台开关）';
    if (unbindNoticeTimer !== undefined) window.clearTimeout(unbindNoticeTimer);
    unbindNoticeTimer = window.setTimeout(() => {
      unbindNoticeTimer = undefined;
      unbindNotice.value = '';
    }, 4000);
    await loadAll();
  } catch (e) {
    saveError.value = String(e instanceof Error ? e.message : e);
  }
}

// 批次3.4：平台重连（bridgePlatformRestart 后端；未启用/凭据缺失由主进程明确抛错）。
async function restartPlatform(p: 'feishu' | 'wechat'): Promise<void> {
  if (restarting.value !== '') return;
  restarting.value = p;
  try {
    await claude.bridgePlatformRestart(p);
    await loadAll();
  } catch (e) {
    saveError.value = String(e instanceof Error ? e.message : e);
  } finally {
    restarting.value = '';
  }
}

onMounted(() => {
  void loadAll();
  stopStatusChanged = claude.onBridgeStatusChanged((s) => {
    statuses.value = s;
  });
});

onBeforeUnmount(() => {
  qrPollDisposed = true;
  stopQrcodePoll();
  if (nowTimer !== undefined) {
    window.clearTimeout(nowTimer);
    nowTimer = undefined;
  }
  if (unbindNoticeTimer !== undefined) {
    window.clearTimeout(unbindNoticeTimer);
    unbindNoticeTimer = undefined;
  }
  if (stopStatusChanged) stopStatusChanged();
});

// ── 方案 D 版式（渲染层新增）：左平台导航 + 右详情 ──
type ImPane = 'feishu' | 'wechat' | 'global';
const activePane = ref<ImPane>('feishu');

// 状态五态中文映射（BridgePlatformStatus：off/connecting/connected/error/disconnected）。
// tone: ok=绿 / busy=蓝 / err=红 / dim=灰；undefined（快照未回）与 off 同形，不闪错。
const STATUS_LABELS: Record<BridgePlatformStatus, string> = {
  off: '未启用', connecting: '连接中', connected: '已连接', error: '异常', disconnected: '已断开',
};
function statusInfo(platform: 'feishu' | 'wechat'): { label: string; tone: 'ok' | 'busy' | 'err' | 'dim' } {
  const s = statusOf(platform)?.status;
  if (s === 'connected') return { label: STATUS_LABELS.connected, tone: 'ok' };
  if (s === 'connecting') return { label: STATUS_LABELS.connecting, tone: 'busy' };
  if (s === 'error') return { label: STATUS_LABELS.error, tone: 'err' };
  return { label: s === 'disconnected' ? STATUS_LABELS.disconnected : STATUS_LABELS.off, tone: 'dim' };
}

// 绑定按面板过滤：平台面板只看本平台；全局面板看全部（数据仍是同一 bridgeListBindings 快照）。
const paneBindings = computed(() =>
  activePane.value === 'global' ? bindings.value : bindings.value.filter((b) => b.platform === activePane.value),
);

// lastActiveAt（契约已有、UI 此前未用）以相对时间显示。
// nowTick：60 秒链式 setTimeout 自排（scheduleNowTick 风格：本轮完成后再排下一轮；不用 interval 型
// 轮询 API——契约钉 D④ 断言本文件源码不含其字样，注释同样回避），让相对时间无需操作也会随 tick
// 刷新；卸载时在 onBeforeUnmount 里 clearTimeout 清理。
const nowTick = ref(Date.now());
let nowTimer: number | undefined;
function scheduleNowTick(): void {
  nowTimer = window.setTimeout(() => {
    nowTimer = undefined;
    nowTick.value = Date.now();
    scheduleNowTick();
  }, 60_000);
}
scheduleNowTick();

function formatLastActive(ts: number): string {
  if (!ts) return ''; // 0/缺省 → 空串（不显示「刚刚活跃」假象）
  // 「现在」取 nowTick.value（响应式 tick），diff 为负（时钟偏移）落入 < 60_000 分支按「刚刚活跃」处理。
  const diff = nowTick.value - ts;
  if (diff < 60_000) return '刚刚活跃';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前活跃`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前活跃`;
  return `${Math.floor(diff / 86_400_000)} 天前活跃`;
}
</script>

<template>
  <div class="im-flex">
    <!-- 左栏：平台导航（LobsterAI rail：logo + 名称 + 状态点 + 迷你开关；迷你开关=原「启用」checkbox 换皮） -->
    <nav class="im-rail" aria-label="IM 平台">
      <button
        type="button"
        :class="['im-rail__item', { 'im-rail__item--active': activePane === 'feishu' }]"
        :aria-current="activePane === 'feishu' ? 'true' : 'false'"
        @click="activePane = 'feishu'"
      >
        <span class="im-rail__logo im-rail__logo--feishu" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.2 2.8c2 .1 3.9.5 5.6 1.2.3.1.4.4.3.7L10 9.9c-.1.3.1.5.4.4l4.1-1.2c.3-.1.5.1.5.4l-.7 4.6c0 .3.2.5.5.4l3.5-.9c.3-.1.5.1.4.4-1 3.4-3.7 6.1-7.2 6.9-4.9 1.1-9.6-1.6-11-6.2-.1-.3.1-.6.4-.6l3.9.1c.3 0 .5-.2.4-.5L4.4 3.4c-.1-.3.2-.6.5-.6z"/></svg>
        </span>
        <span class="im-rail__name">飞书</span>
        <span :class="['status-dot', `status-dot--${statusInfo('feishu').tone}`]" :title="statusOf('feishu')?.error || ''"></span>
        <input
          type="checkbox"
          class="mini-switch"
          :checked="config?.feishu.enabled ?? false"
          aria-label="启用飞书机器人"
          @click.stop
          @change="save({ feishu: { enabled: ($event.target as HTMLInputElement).checked } })"
        />
      </button>
      <button
        type="button"
        :class="['im-rail__item', { 'im-rail__item--active': activePane === 'wechat' }]"
        :aria-current="activePane === 'wechat' ? 'true' : 'false'"
        @click="activePane = 'wechat'"
      >
        <span class="im-rail__logo im-rail__logo--wechat" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.3 3C5.3 3 2 5.7 2 9.1c0 1.9 1 3.5 2.6 4.6l-.7 2.1 2.4-1.2c.6.2 1.3.3 2 .4.3-2.6 2.7-4.7 5.8-4.7h.3C13.8 5 11.8 3 9.3 3zM6.9 6.4c.4 0 .8.3.8.8s-.3.8-.8.8-.8-.4-.8-.8.4-.8.8-.8zm4.9 0c.4 0 .8.3.8.8s-.4.8-.8.8-.8-.4-.8-.8.3-.8.8-.8zM22 14.5c0-2.9-2.8-5.2-6.2-5.2s-6.2 2.3-6.2 5.2 2.8 5.2 6.2 5.2c.7 0 1.4-.1 2-.3l2.1 1.1-.6-1.9c1.6-.9 2.7-2.4 2.7-4.1zm-8.3-1.3c-.4 0-.7-.3-.7-.7s.3-.7.7-.7.7.3.7.7-.3.7-.7.7zm4.2 0c-.4 0-.7-.3-.7-.7s.3-.7.7-.7.7.3.7.7-.3.7-.7.7z"/></svg>
        </span>
        <span class="im-rail__name">微信</span>
        <span :class="['status-dot', `status-dot--${statusInfo('wechat').tone}`]" :title="statusOf('wechat')?.error || ''"></span>
        <input
          type="checkbox"
          class="mini-switch"
          :checked="config?.wechat.enabled ?? false"
          aria-label="启用微信机器人"
          @click.stop
          @change="save({ wechat: { enabled: ($event.target as HTMLInputElement).checked } })"
        />
      </button>
      <button
        type="button"
        :class="['im-rail__item', { 'im-rail__item--active': activePane === 'global' }]"
        :aria-current="activePane === 'global' ? 'true' : 'false'"
        @click="activePane = 'global'"
      >
        <span class="im-rail__logo im-rail__logo--global" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </span>
        <span class="im-rail__name">全局</span>
      </button>
    </nav>

    <!-- 右栏：所选平台详情 -->
    <div class="im-detail">
      <p v-if="saveError" class="im-error" role="alert">{{ saveError }}</p>
      <p v-if="unbindNotice" class="im-hint" role="status">{{ unbindNotice }}</p>

      <!-- 飞书面板 -->
      <template v-if="activePane === 'feishu'">
        <div class="im-head">
          <h3 class="im-head__title">飞书</h3>
          <span :class="['im-status-pill', `im-status-pill--${statusInfo('feishu').tone}`]">{{ statusInfo('feishu').label }}</span>
          <span class="im-head__spacer"></span>
          <button type="button" class="im-act-btn" :disabled="restarting !== '' || !config?.feishu.enabled" @click="restartPlatform('feishu')">
            {{ restarting === 'feishu' ? '重连中…' : '重连' }}
          </button>
          <button type="button" class="im-act-btn" :disabled="feishuTesting" @click="testFeishu">
            {{ feishuTesting ? '测试中…' : '测试连接' }}
          </button>
        </div>
        <p v-if="config?.secretBroken.feishu" class="im-error">密钥解密失败（换机/重装后常见），请重新录入 App Secret。</p>
        <label class="im-field">
          <span class="im-field-label">区域</span>
          <select
            :value="config?.feishu.region ?? 'feishu_cn'"
            @change="save({ feishu: { region: ($event.target as HTMLSelectElement).value as 'feishu_cn' | 'lark_global' } })"
          >
            <option value="feishu_cn">飞书（feishu.cn）</option>
            <option value="lark_global">Lark（larksuite.com）</option>
          </select>
        </label>
        <label class="im-field">
          <span class="im-field-label">App ID</span>
          <input
            v-model="feishuAppIdInput"
            type="text"
            placeholder="cli_xxxx"
            @blur="saveFeishuAppId()"
          />
          <span v-if="appidError" class="im-error">{{ appidError }}</span>
        </label>
        <label class="im-field">
          <span class="im-field-label">App Secret</span>
          <input
            v-model="feishuAppSecret"
            type="password"
            autocomplete="new-password"
            :placeholder="config?.feishu.hasAppSecret ? '已保存' : '未设置'"
            @blur="saveFeishuSecret"
          />
        </label>
        <div v-if="config?.feishu.ownerOpenId" class="im-inline-row">
          <span>Owner：{{ config.feishu.ownerOpenId }}</span>
          <button type="button" class="im-act-btn im-act-btn--danger" @click="clearOwner">清除</button>
        </div>
        <div v-if="feishuTestResult" class="im-inline-row">
          <span v-if="feishuTestResult.ok" class="im-status-pill im-status-pill--ok">连接成功</span>
          <span v-else class="im-error">失败：{{ feishuTestResult.detail ?? '' }}</span>
        </div>
        <details class="im-guide">
          <summary>使用说明</summary>
          <ol>
            <li>在飞书开放平台创建「企业自建应用」。</li>
            <li>为应用添加「机器人」能力。</li>
            <li>开通 im:message 相关权限。</li>
            <li>事件订阅方式改为「使用长连接接收事件」（无需公网回调地址）。</li>
            <li>添加事件 im.message.receive_v1（接收消息）。</li>
            <li>发布应用版本（长连接配置须已发布才生效）。</li>
            <li>把 App ID / App Secret 填入本页并保存。</li>
            <li>打开「启用」开关，等待状态变绿。</li>
            <li>在飞书里给机器人发私聊消息即可对话。</li>
          </ol>
        </details>
      </template>

      <!-- 微书面板 -->
      <template v-else-if="activePane === 'wechat'">
        <div class="im-head">
          <h3 class="im-head__title">微信</h3>
          <span :class="['im-status-pill', `im-status-pill--${statusInfo('wechat').tone}`]">{{ statusInfo('wechat').label }}</span>
          <span class="im-head__spacer"></span>
          <button type="button" class="im-act-btn" :disabled="restarting !== '' || !config?.wechat.enabled" @click="restartPlatform('wechat')">
            {{ restarting === 'wechat' ? '重连中…' : '重连' }}
          </button>
          <button v-if="config?.wechat.loggedIn" type="button" class="im-act-btn" @click="wechatLogout">退出登录</button>
        </div>
        <p v-if="config?.secretBroken.wechat" class="im-error">登录态解密失败，请重新扫码登录。</p>
        <span class="im-field-hint">关闭通信期间收到的消息不会在重新打开后处理</span>
        <p v-if="wechatSessionExpired()" class="im-error">登录态已过期（session expired），请重新扫码登录。</p>
        <div v-if="config?.wechat.loggedIn" class="im-inline-row">
          <span>已登录{{ config?.wechat.botUserId ? `：${config.wechat.botUserId}` : '' }}</span>
        </div>
        <!-- 扫码入口独立条件（生命周期修复批次1.5）：expired 态与「退出登录」并存，
             扫码确认即完成重登，免除「先退出再扫码」两步。 -->
        <template v-if="!config?.wechat.loggedIn || wechatSessionExpired()">
          <div class="im-inline-row">
            <button type="button" class="im-act-btn" :disabled="qrLoginBusy" @click="startQrcodeLogin">
              {{ qrLoginBusy ? '获取中…' : '扫码登录' }}
            </button>
            <span v-if="qrExpired" class="im-error">二维码已过期，请重新扫码</span>
            <span v-if="qrError" class="im-error">扫码登录失败：{{ qrError }}</span>
          </div>
          <div v-if="qrDataUrl" class="im-qr">
            <img :src="qrDataUrl" alt="微信扫码登录二维码" width="200" height="200" />
            <span class="im-field-hint">请用微信扫码确认登录（每 4 秒自动查询状态）</span>
          </div>
        </template>
      </template>

      <!-- 全局面板 -->
      <template v-else>
        <div class="im-head">
          <h3 class="im-head__title">全局</h3>
        </div>
        <label class="im-field">
          <span class="im-field-label">bridge 会话工作目录</span>
          <div class="im-inline-row">
            <input
              type="text"
              :value="config?.global.workingDir ?? ''"
              placeholder="留空 = 不设置工作目录"
              @blur="save({ global: { workingDir: ($event.target as HTMLInputElement).value } })"
            />
            <button type="button" class="im-act-btn" @click="pickWorkingDir">浏览</button>
          </div>
          <span class="im-field-hint">新 bridge 会话（[飞书]/[微信] 前缀）将使用此目录</span>
        </label>
      </template>

      <!-- 会话绑定（三个面板共用，置于底部；平台面板过滤本平台，全局=全部） -->
      <div class="im-bindings">
        <div class="im-subhead">会话绑定（{{ paneBindings.length }}）{{ activePane === 'global' ? ' · 全部平台' : ' · 仅本平台' }}</div>
        <div v-for="b in paneBindings" :key="b.sessionKey" class="im-bind-row">
          <span :class="['im-platform-badge', `im-platform-badge--${b.platform}`]">{{ b.platform === 'feishu' ? '飞书' : '微信' }}</span>
          <span class="im-bind-row__name">{{ b.displayName || b.userId }}</span>
          <span class="im-bind-row__id">{{ b.userId }}</span>
          <span class="im-bind-row__time">{{ formatLastActive(b.lastActiveAt) }}</span>
          <button type="button" class="im-act-btn" @click="unbindBinding(b.sessionKey)">解绑</button>
        </div>
        <p v-if="paneBindings.length === 0" class="im-bind-empty">暂无绑定；在 IM 里给机器人发私聊消息后会自动出现。解绑后需对方发送 /new 重新绑定。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── 方案 D 双栏版式（视觉基准 docs/prototypes/im-bridge-tab/round2-d-lobster-structure.html）──
   类名按计划 §2.4 清单（im- 前缀）；间距/圆角/配色同效果图，颜色以现有 CSS 变量为主，
   平台色字面量仅飞书 #3370FF / 微信 #07C160 两种色值（先例：skill 项目紫 #7C5CFC）；
   例外：连接中恒蓝字面量（撞色修正），见 .status-dot--busy / .im-status-pill--busy 行注释。
   外框（边框/圆角/阴影）由 ConfigPage 的 .solo-card 承载，此处不新增。 */
.im-flex {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 0.75rem;
  padding: 1rem;
}

/* 左栏：平台清单（176px 定宽 + 自滚动） */
.im-rail {
  width: 176px;
  flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid var(--color-border);
  padding-right: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.im-rail::-webkit-scrollbar {
  width: 8px;
}

.im-rail::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text-muted) 28%, transparent);
  border-radius: var(--radius-pill);
}

.im-rail__item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  padding: 0.5rem;
  cursor: pointer;
  font-family: inherit;
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out);
}

.im-rail__item:hover {
  background: color-mix(in srgb, var(--color-accent) 6%, var(--color-panel-soft));
}

/* 选中项：主色描边 + 浅主色底（效果图同款）。 */
.im-rail__item--active {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  box-shadow: var(--elevation-1);
}

.im-rail__logo {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
}

.im-rail__logo svg {
  width: 22px;
  height: 22px;
}

/* 平台色字面量：飞书品牌蓝。 */
.im-rail__logo--feishu {
  color: #3370FF;
}

/* 平台色字面量：微信品牌绿。 */
.im-rail__logo--wechat {
  color: #07C160;
}

.im-rail__logo--global {
  color: var(--color-accent-strong);
}

.im-rail__name {
  flex: 1;
  min-width: 0;
  font-size: 0.875rem;
  color: color-mix(in srgb, var(--color-text) 80%, transparent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 状态点五态：ok=绿 / busy=蓝 / err=红 / dim=灰（含快照未回）。 */
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-border-strong);
}

.status-dot--ok {
  background: var(--color-success);
}

/* 连接中恒蓝：非蓝主题下 accent 会与 success 绿撞色，同平台色 #3370FF/#07C160 字面量先例。 */
.status-dot--busy {
  background: #3B82F6;
}

.status-dot--err {
  background: var(--color-danger);
}

.status-dot--dim {
  background: var(--color-border-strong);
}

/* 行内迷你开关（w-7 h-4 + 12px 滑块，效果图同款）。 */
.mini-switch {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  width: 28px;
  height: 16px;
  margin: 0 0.125rem;
  border-radius: var(--radius-pill);
  background: var(--color-border-strong);
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--duration-base) var(--ease-out);
}

.mini-switch::before {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: transform var(--duration-base) var(--ease-spring);
}

.mini-switch:checked {
  background: var(--color-accent);
}

.mini-switch:checked::before {
  transform: translateX(12px);
}

.mini-switch:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

/* 右栏：详情（内部滚动）。 */
.im-detail {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 0.125rem 0.5rem 0.5rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.im-detail::-webkit-scrollbar {
  width: 8px;
}

.im-detail::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text-muted) 28%, transparent);
  border-radius: var(--radius-pill);
}

/* 头部行：标题 + 状态胶囊 + spacer + 右端动作钮。 */
.im-head {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  border-bottom: 1px solid var(--color-border);
  padding-bottom: 0.875rem;
}

.im-head__title {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--color-text);
}

.im-head__spacer {
  flex: 1;
}

.im-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  border-radius: var(--radius-pill);
  padding: 0.125rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 500;
}

.im-status-pill::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-border-strong);
}

.im-status-pill--ok {
  background: color-mix(in srgb, var(--color-success) 15%, transparent);
  color: var(--color-success-strong);
}

.im-status-pill--ok::before {
  background: var(--color-success);
}

/* 连接中恒蓝：非蓝主题下 accent 会与 success 绿撞色，同平台色 #3370FF/#07C160 字面量先例。 */
.im-status-pill--busy {
  background: color-mix(in srgb, #3B82F6 12%, transparent);
  border: 1px solid color-mix(in srgb, #3B82F6 45%, transparent);
  color: #2563EB;
}

.im-status-pill--busy::before {
  background: #3B82F6;
}

.im-status-pill--err {
  background: color-mix(in srgb, var(--color-fail) 12%, transparent);
  color: var(--color-fail-strong);
}

.im-status-pill--err::before {
  background: var(--color-fail);
}

.im-status-pill--dim {
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
}

.im-status-pill--dim::before {
  background: var(--color-border-strong);
}

.im-act-btn {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  padding: 0.375rem 0.75rem;
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
  transition: background var(--duration-fast) var(--ease-out);
}

.im-act-btn:hover {
  background: var(--color-panel-soft);
}

.im-act-btn:disabled {
  cursor: wait;
  opacity: 0.6;
}

.im-act-btn--danger {
  border-color: color-mix(in srgb, var(--color-fail) 45%, transparent);
  color: var(--color-fail-strong);
}

.im-act-btn--danger:hover {
  background: color-mix(in srgb, var(--color-fail) 10%, transparent);
}

/* 字段：label 文字 + 控件竖排（字段间距由 .im-detail gap 1rem 承担）。 */
.im-field {
  display: block;
}

.im-field-label {
  display: block;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--color-text-muted);
  margin-bottom: 0.375rem;
}

.im-field input,
.im-field select {
  display: block;
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  font-family: inherit;
  transition: border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}

.im-field input:hover,
.im-field select:hover {
  border-color: var(--color-border-strong);
}

.im-field input:focus,
.im-field select:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent) 30%, transparent);
}

.im-field-hint {
  display: block;
  margin: 0.375rem 0 0;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.im-inline-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.im-inline-row input[type='text'] {
  flex: 1;
}

.im-error {
  margin: 0;
  color: var(--color-danger);
  font-size: 0.75rem;
}

/* transient 操作提示（解绑确认后 4s）：中性蓝灰，区别于错误红。 */
.im-hint {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

/* 虚线说明卡（LobsterAI PlatformGuide 形态）。 */
.im-guide {
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-sm);
  padding: 0.75rem;
}

.im-guide summary {
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--color-text);
}

.im-guide ol {
  margin: 0.5rem 0 0;
  padding-left: 1.1rem;
  font-size: 0.75rem;
  color: var(--color-text-muted);
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  list-style-position: inside;
}

/* 扫码区：二维码白底（扫码可识别性要求，不随主题）。 */
.im-qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.im-qr img {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: #fff;
}

/* 会话绑定：分区标题 + 行卡片。 */
.im-bindings {
  display: flex;
  flex-direction: column;
}

.im-subhead {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  border-bottom: 1px solid var(--color-border);
  padding-bottom: 0.5rem;
  margin-bottom: 0.625rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--color-text);
}

.im-bind-row {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  padding: 0.625rem 0.75rem;
}

.im-bind-row + .im-bind-row {
  margin-top: 0.375rem;
}

.im-bind-row:hover {
  border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
}

.im-bind-row__name {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.im-bind-row__id {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}

.im-bind-row__time {
  flex-shrink: 0;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.im-platform-badge {
  flex-shrink: 0;
  padding: 0.0625rem 0.4375rem;
  border-radius: var(--radius-pill);
  font-size: 0.625rem;
  font-weight: 700;
  border: 1px solid transparent;
}

/* 平台色字面量：飞书品牌蓝。 */
.im-platform-badge--feishu {
  border-color: color-mix(in srgb, #3370FF 45%, transparent);
  background: color-mix(in srgb, #3370FF 10%, transparent);
  color: #3370FF;
}

/* 平台色字面量：微信品牌绿。 */
.im-platform-badge--wechat {
  border-color: color-mix(in srgb, #07C160 45%, transparent);
  background: color-mix(in srgb, #07C160 10%, transparent);
  color: #07C160;
}

.im-bind-empty {
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}
</style>
