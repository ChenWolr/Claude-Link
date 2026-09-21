<script setup lang="ts">
// BridgeSettings.vue — 设置页「IM 机器人」区块（飞书 + 微信）。
// 保存语义：字段 blur / 开关 change 即 bridgeSaveConfig（掩码规则由主进程处理，密钥不回显）。
// 状态：挂载时 bridgeGetStatus 拉快照 + onBridgeStatusChanged 订阅增量。
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { BridgeConfigGetResult, BridgeConfigSaveInput, BridgeBindingView, BridgePlatformStatusEntry } from '../../../shared/types/bridge';

const claude = window.claudeLink;

const config = ref<BridgeConfigGetResult | null>(null);
const statuses = ref<BridgePlatformStatusEntry[]>([]);
const bindings = ref<BridgeBindingView[]>([]);
const saveError = ref('');

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

function dotClass(platform: 'feishu' | 'wechat'): string {
  const s = statusOf(platform)?.status;
  if (s === 'connected') return 'bridge-dot bridge-dot--ok';
  if (s === 'error') return 'bridge-dot bridge-dot--err';
  return 'bridge-dot';
}

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

onMounted(() => {
  void loadAll();
  stopStatusChanged = claude.onBridgeStatusChanged((s) => {
    statuses.value = s;
  });
});

onBeforeUnmount(() => {
  qrPollDisposed = true;
  stopQrcodePoll();
  if (stopStatusChanged) stopStatusChanged();
});
</script>

<template>
  <div class="bridge-settings">
    <!-- 状态总览：绿=connected / 灰=其他 / 红=error（tooltip 显示错误） -->
    <div class="bridge-status-row" :title="statusOf('feishu')?.error || ''">
      <span :class="dotClass('feishu')"></span>
      <span class="bridge-status-label">飞书：{{ statusOf('feishu')?.status || 'off' }}</span>
      <span :class="dotClass('wechat')" :title="statusOf('wechat')?.error || ''"></span>
      <span class="bridge-status-label">微信：{{ statusOf('wechat')?.status || 'off' }}</span>
    </div>
    <p v-if="saveError" class="bridge-error">{{ saveError }}</p>

    <!-- 飞书卡 -->
    <div class="bridge-card">
      <div class="bridge-card-head">
        <h4>飞书</h4>
        <label class="bridge-toggle">
          <input
            type="checkbox"
            :checked="config?.feishu.enabled ?? false"
            @change="save({ feishu: { enabled: ($event.target as HTMLInputElement).checked } })"
          />
          <span>启用</span>
        </label>
      </div>
      <p v-if="config?.secretBroken.feishu" class="bridge-error">密钥解密失败（换机/重装后常见），请重新录入 App Secret。</p>
      <label class="bridge-field">
        <span class="bridge-field-label">区域</span>
        <select
          :value="config?.feishu.region ?? 'feishu_cn'"
          @change="save({ feishu: { region: ($event.target as HTMLSelectElement).value as 'feishu_cn' | 'lark_global' } })"
        >
          <option value="feishu_cn">飞书（feishu.cn）</option>
          <option value="lark_global">Lark（larksuite.com）</option>
        </select>
      </label>
      <label class="bridge-field">
        <span class="bridge-field-label">App ID</span>
        <input
          type="text"
          :value="config?.feishu.appId ?? ''"
          placeholder="cli_xxxx"
          @blur="save({ feishu: { appId: ($event.target as HTMLInputElement).value } })"
        />
      </label>
      <label class="bridge-field">
        <span class="bridge-field-label">App Secret</span>
        <input
          v-model="feishuAppSecret"
          type="password"
          autocomplete="new-password"
          :placeholder="config?.feishu.hasAppSecret ? '已保存' : '未设置'"
          @blur="saveFeishuSecret"
        />
      </label>
      <div class="bridge-row">
        <button type="button" :disabled="feishuTesting" @click="testFeishu">
          {{ feishuTesting ? '测试中…' : '测试连接' }}
        </button>
        <span v-if="feishuTestResult" :class="feishuTestResult.ok ? 'bridge-ok-text' : 'bridge-error'">
          {{ feishuTestResult.ok ? '连接成功' : `失败：${feishuTestResult.detail ?? ''}` }}
        </span>
      </div>
      <div v-if="config?.feishu.ownerOpenId" class="bridge-row">
        <span class="bridge-field-label">Owner：{{ config.feishu.ownerOpenId }}</span>
        <button type="button" @click="clearOwner">清除</button>
      </div>
      <details class="bridge-guide">
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
    </div>

    <!-- 微信卡 -->
    <div class="bridge-card">
      <div class="bridge-card-head">
        <h4>微信</h4>
        <label class="bridge-toggle">
          <input
            type="checkbox"
            :checked="config?.wechat.enabled ?? false"
            @change="save({ wechat: { enabled: ($event.target as HTMLInputElement).checked } })"
          />
          <span>启用</span>
        </label>
      </div>
      <p v-if="config?.secretBroken.wechat" class="bridge-error">登录态解密失败，请重新扫码登录。</p>
      <p v-if="wechatSessionExpired()" class="bridge-error">登录态已过期（session expired），请重新扫码登录。</p>
      <div v-if="config?.wechat.loggedIn" class="bridge-row">
        <span class="bridge-ok-text">已登录{{ config?.wechat.botUserId ? `：${config.wechat.botUserId}` : '' }}</span>
        <button type="button" @click="wechatLogout">退出登录</button>
      </div>
      <div v-else class="bridge-row">
        <button type="button" :disabled="qrLoginBusy" @click="startQrcodeLogin">
          {{ qrLoginBusy ? '获取中…' : '扫码登录' }}
        </button>
        <span v-if="qrExpired" class="bridge-error">二维码已过期，请重新扫码</span>
        <span v-if="qrError" class="bridge-error">扫码登录失败：{{ qrError }}</span>
      </div>
      <div v-if="qrDataUrl" class="bridge-qr-wrap">
        <img :src="qrDataUrl" alt="微信扫码登录二维码" width="200" height="200" />
        <span class="bridge-field-label">请用微信扫码确认登录（每 4 秒自动查询状态）</span>
      </div>

      <div v-if="bindings.length > 0" class="bridge-bindings">
        <span class="bridge-field-label">会话绑定（{{ bindings.length }}）</span>
        <div v-for="b in bindings" :key="b.sessionKey" class="bridge-row">
          <span>{{ b.platform === 'feishu' ? '[飞书]' : '[微信]' }} {{ b.displayName || b.userId }}</span>
          <button type="button" @click="claude.bridgeUnbind(b.sessionKey).then(loadAll)">解绑</button>
        </div>
      </div>
    </div>

    <!-- 全局 -->
    <div class="bridge-card">
      <h4>全局</h4>
      <label class="bridge-field">
        <span class="bridge-field-label">bridge 会话工作目录</span>
        <div class="bridge-row">
          <input
            type="text"
            :value="config?.global.workingDir ?? ''"
            placeholder="留空 = 不设置工作目录"
            @blur="save({ global: { workingDir: ($event.target as HTMLInputElement).value } })"
          />
          <button type="button" @click="pickWorkingDir">浏览</button>
        </div>
        <span class="bridge-field-desc">新 bridge 会话（[飞书]/[微信] 前缀）将使用此目录</span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.bridge-settings {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.bridge-status-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.bridge-status-label {
  font-size: 0.85rem;
  color: var(--color-text-muted);
  margin-right: 0.75rem;
}
.bridge-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--color-border);
  display: inline-block;
}
.bridge-dot--ok {
  background: #3f9b6e;
}
.bridge-dot--err {
  background: var(--color-danger);
}
.bridge-card {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.bridge-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.bridge-card h4 {
  margin: 0;
  font-size: 0.95rem;
  color: var(--color-text);
}
.bridge-toggle {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.85rem;
  color: var(--color-text-muted);
}
.bridge-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.bridge-field-label {
  font-size: 0.8rem;
  color: var(--color-text-muted);
}
.bridge-field-desc {
  font-size: 0.75rem;
  color: var(--color-text-muted);
}
.bridge-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.bridge-row input[type='text'] {
  flex: 1;
}
.bridge-error {
  margin: 0;
  color: var(--color-danger);
  font-size: 0.8rem;
}
.bridge-ok-text {
  color: #3f9b6e;
  font-size: 0.85rem;
}
.bridge-guide summary {
  cursor: pointer;
  font-size: 0.85rem;
  color: var(--color-text-muted);
}
.bridge-guide ol {
  margin: 0.5rem 0 0;
  padding-left: 1.25rem;
  font-size: 0.8rem;
  color: var(--color-text-muted);
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.bridge-qr-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}
.bridge-bindings {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  border-top: 1px solid var(--color-border);
  padding-top: 0.5rem;
}
</style>
