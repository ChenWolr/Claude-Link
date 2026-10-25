// web-bridge.ts
// 「网页访问（局域网）」P4：渲染层 web 桥（docs/plans/2026-10-20-web-access-plan.md §3-P4）。
// 浏览器（局域网设备）无 preload——本模块经 WebSocket 把 window.claudeLink 的全部 108 方法
// 代理到主进程 WS RPC（invoke 分发 + 全量事件广播客户端本地过滤），并负责：
//   - token 读取：location.hash #token=（扫码/复制链接入口）→ localStorage.clWebToken →
//     history.replaceState 清除地址栏 hash（token 不进任何 HTTP 请求行，仅 WS 升级 query）；
//   - 登录浮层（纯 DOM，无 token 时）/ 重连浮层（断线退避重连，1/2/4/8/15s 封顶）；
//   - close 4001（令牌无效或已更换）→ 清 stored token → 回登录浮层；
//   - 移动端生命周期加速：online / visibilitychange(visible) 立即重试、跳过当次退避等待；
//   - 断线期间所有 invoke reject new Error('Web 桥未连接')；
//   - 重连 welcome 后执行状态对齐序列（loadSessions / switchSession 重入 /
//     interaction reconcile 重水合 / update-store 幂等重拉，见 runRealignSequence 注）。
// 仅在无 window.claudeLink 的浏览器环境由 main.ts 动态 import 触发（Electron 路径本 chunk 不加载）。

import type { ClaudeLinkAPI } from '../../preload/api';
import { IPC_CHANNELS } from '../../shared/constants';
import { encodeWireValue, decodeWireValue } from '../../shared/web-access-protocol';

// ── WS 协议 v1 帧形状（与服务端 src/main/modules/web-access/web-access-server.ts 对齐）──

// 客户端 → 服务端 invoke 帧内联构造于 invokeOverWire：{ v:1, kind:'invoke', id, channel, args }。

type WireServerFrame =
  | { v: 1; kind: 'welcome'; appVersion: string; buildRev: string }
  | { v: 1; kind: 'resolve'; id: string; ok: true; result: unknown }
  | { v: 1; kind: 'resolve'; id: string; ok: false; error: string }
  | { v: 1; kind: 'event'; channel: string; args: unknown[] }
  | { v: 1; kind: 'bye'; reason: string };

interface PendingInvoke {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface BridgeConnection {
  ws: WebSocket;
  /** welcome 到达即 resolve；close 先到则按 close code reject（4001 → WebBridgeAuthError）。 */
  welcome: Promise<void>;
  /** 连接关闭恒 resolve（携 close code），供已连接后的断线判定，无 unhandled rejection。 */
  closed: Promise<number>;
}

/** close code 4001：令牌无效/已更换/被踢——与「网络断开」区分的唯一信号（计划 §2）。 */
class WebBridgeAuthError extends Error {}

const TOKEN_STORAGE_KEY = 'clWebToken';
/** 重连退避表：1/2/4/8/15s，15s 封顶（计划 §3-P4-2）。 */
const BACKOFF_SCHEDULE_MS = [1000, 2000, 4000, 8000, 15000];

// ── 模块级状态（订阅/待决 invoke 跨重连存活——重连不重建 api 对象，App.vue 持有的
//    反注册闭包在重连后仍然有效）──

/** on* 订阅：channel → 回调集（服务端全量广播，客户端按 channel 本地过滤）。 */
const eventSubscribers = new Map<string, Set<(payload: unknown) => void>>();
const pendingInvokes = new Map<string, PendingInvoke>();
let currentSocket: WebSocket | null = null;
let apiInstalled = false;
let reconnectAttempt = 0;
let cancelBackoffWait: (() => void) | null = null;
let lifecycleBound = false;
let installPromise: Promise<void> | null = null;

// ── 全量通道表：键集 === ClaudeLinkAPI 成员集（Record<keyof, string> 由 TS 强制完备，
//    值全部引用 IPC_CHANNELS 常量；键集对等契约由 scripts/tdd-web-access-wiring-verify.ts
//    §11.2 与 preload/api.ts 双向比对钉死）。通道对应关系逐一对照 preload/api.ts createApi。 ──
const WEB_CHANNEL_TABLE: Record<keyof ClaudeLinkAPI, string> = {
  detectCli: IPC_CHANNELS.CLI_DETECT,
  getCliStatus: IPC_CHANNELS.CLI_GET_STATUS,
  getConfig: IPC_CHANNELS.CONFIG_GET,
  saveConfig: IPC_CHANNELS.CONFIG_SAVE,
  clearConfig: IPC_CHANNELS.CONFIG_CLEAR,
  getStorageInfo: IPC_CHANNELS.CONFIG_STORAGE_INFO,
  getUpdateInfo: IPC_CHANNELS.APP_UPDATE_GET_INFO,
  checkForAppUpdate: IPC_CHANNELS.APP_UPDATE_CHECK,
  installAppUpdate: IPC_CHANNELS.APP_UPDATE_INSTALL,
  onUpdateStateChanged: IPC_CHANNELS.APP_UPDATE_STATE_CHANGED,
  removeUpdateStateListener: IPC_CHANNELS.APP_UPDATE_STATE_CHANGED,
  listRecentWorkspaces: IPC_CHANNELS.WORKSPACE_LIST_RECENT,
  addRecentWorkspace: IPC_CHANNELS.WORKSPACE_ADD_RECENT,
  removeRecentWorkspace: IPC_CHANNELS.WORKSPACE_REMOVE_RECENT,
  // P2 目录历史跨端同步：WORKSPACES_CHANGED 信号（on* 本地订阅 / remove*Listener 清订阅由
  // createWebApi 泛型分派处理，与 onSessionsChanged 同一机制；空载荷 {}，渲染层收到重拉列表）。
  onWorkspacesChanged: IPC_CHANNELS.WORKSPACES_CHANGED,
  removeWorkspacesListener: IPC_CHANNELS.WORKSPACES_CHANGED,
  listProviders: IPC_CHANNELS.PROVIDER_LIST,
  saveProvider: IPC_CHANNELS.PROVIDER_SAVE,
  deleteProvider: IPC_CHANNELS.PROVIDER_DELETE,
  restoreProvider: IPC_CHANNELS.PROVIDER_RESTORE,
  queryProviderModels: IPC_CHANNELS.PROVIDER_QUERY_MODELS,
  testProviderModel: IPC_CHANNELS.PROVIDER_TEST_MODEL,
  onProvidersChanged: IPC_CHANNELS.PROVIDERS_CHANGED,
  removeProvidersListener: IPC_CHANNELS.PROVIDERS_CHANGED,
  listSessions: IPC_CHANNELS.SESSION_LIST,
  createSession: IPC_CHANNELS.SESSION_CREATE,
  getSession: IPC_CHANNELS.SESSION_GET,
  getSessionMessages: IPC_CHANNELS.MESSAGE_GET_BY_SESSION,
  deleteSession: IPC_CHANNELS.SESSION_DELETE,
  updateSession: IPC_CHANNELS.SESSION_UPDATE,
  // P2 会话置顶（点 S4）：网页端与桌面同能力（键集完备性契约由 tdd-web-access-wiring-verify §11.2 钉死）。
  setSessionPinned: IPC_CHANNELS.SESSION_SET_PINNED,
  recordTurnMeta: IPC_CHANNELS.SESSION_RECORD_TURN_META,
  searchSessions: IPC_CHANNELS.SESSION_SEARCH,
  analyzeTopic: IPC_CHANNELS.SESSION_ANALYZE_TOPIC,
  sendMessage: IPC_CHANNELS.CHAT_SEND,
  abortChat: IPC_CHANNELS.CHAT_ABORT,
  setRunningPermissionMode: IPC_CHANNELS.CHAT_SET_PERMISSION_MODE,
  // SA-2（回合投影只读查询）：快照/概览两通道（值直引 IPC_CHANNELS 常量）。
  getRuntimeSnapshot: IPC_CHANNELS.CHAT_RUNTIME_SNAPSHOT,
  getRunningOverview: IPC_CHANNELS.CHAT_RUNNING_OVERVIEW,
  onChatEvent: IPC_CHANNELS.CHAT_EVENT,
  removeChatListener: IPC_CHANNELS.CHAT_EVENT,
  onInteractionRequest: IPC_CHANNELS.INTERACTION_REQUEST,
  onInteractionCancel: IPC_CHANNELS.INTERACTION_CANCEL,
  getPendingInteractions: IPC_CHANNELS.INTERACTION_GET_PENDING,
  respondInteraction: IPC_CHANNELS.INTERACTION_RESPOND,
  getInteractionHistory: IPC_CHANNELS.INTERACTION_HISTORY_GET,
  recordInteractionHistory: IPC_CHANNELS.INTERACTION_HISTORY_RECORD,
  onContextUpdate: IPC_CHANNELS.CONTEXT_UPDATE,
  removeContextListener: IPC_CHANNELS.CONTEXT_UPDATE,
  listChanges: IPC_CHANNELS.CHANGES_LIST,
  getChangeDiff: IPC_CHANNELS.CHANGES_DIFF,
  openChangeFile: IPC_CHANNELS.CHANGES_OPEN_FILE,
  addTask: IPC_CHANNELS.TASK_ADD,
  removeTask: IPC_CHANNELS.TASK_REMOVE,
  readTaskOutput: IPC_CHANNELS.TASK_OUTPUT_READ,
  getTasks: IPC_CHANNELS.TASK_GET_ALL,
  reorderTasks: IPC_CHANNELS.TASK_REORDER,
  setTaskPaused: IPC_CHANNELS.TASK_SET_PAUSED,
  runTaskNow: IPC_CHANNELS.TASK_RUN_NOW,
  resumeAllQueue: IPC_CHANNELS.QUEUE_RESUME_ALL,
  getQueueOverview: IPC_CHANNELS.QUEUE_GET_OVERVIEW,
  getClaudePlanState: IPC_CHANNELS.CLAUDE_PLAN_GET,
  stageAttachmentPaths: IPC_CHANNELS.ATTACHMENT_STAGE_PATHS,
  stageAttachmentBytes: IPC_CHANNELS.ATTACHMENT_STAGE_BYTES,
  getAttachmentPreview: IPC_CHANNELS.ATTACHMENT_PREVIEW,
  removeDraftAttachment: IPC_CHANNELS.ATTACHMENT_REMOVE_DRAFT,
  cloneMessageAttachments: IPC_CHANNELS.ATTACHMENT_CLONE_MESSAGE,
  onQueueEvent: IPC_CHANNELS.QUEUE_EVENT,
  removeQueueListener: IPC_CHANNELS.QUEUE_EVENT,
  startImageExport: IPC_CHANNELS.EXPORT_IMAGE_START,
  onImageExportProgress: IPC_CHANNELS.EXPORT_IMAGE_PROGRESS,
  cancelImageExport: IPC_CHANNELS.EXPORT_IMAGE_CANCEL,
  getSessionCommands: IPC_CHANNELS.COMMANDS_GET,
  onCommandChanged: IPC_CHANNELS.COMMANDS_CHANGED,
  removeCommandListener: IPC_CHANNELS.COMMANDS_CHANGED,
  onGlobalCommandsChanged: IPC_CHANNELS.COMMANDS_GLOBAL_CHANGED,
  // S5：Skill 页「立即刷新」（绕过节流重探全局兜底快照；键集完备性契约由 tdd-web-access-wiring-verify §11.2 钉死）。
  refreshGlobalCommands: IPC_CHANNELS.COMMANDS_REFRESH_GLOBAL,
  getNativeSettingsDiagnostic: IPC_CHANNELS.SETTINGS_GET_DIAGNOSTIC,
  getCommandDiagnostics: IPC_CHANNELS.COMMANDS_GET_DIAGNOSTIC,
  getSkillProjectDirs: IPC_CHANNELS.SKILL_PROJECT_DIRS_GET,
  getMcpSnapshot: IPC_CHANNELS.MCP_SNAPSHOT_GET,
  saveMcpManaged: IPC_CHANNELS.MCP_MANAGED_SAVE,
  setMcpOverride: IPC_CHANNELS.MCP_OVERRIDE_SET,
  probeMcpServers: IPC_CHANNELS.MCP_PROBE,
  writeMcpScoped: IPC_CHANNELS.MCP_WRITE_SCOPED,
  exportMcpScoped: IPC_CHANNELS.MCP_EXPORT_SCOPED,
  parseMcpJson: IPC_CHANNELS.MCP_PARSE_JSON,
  bridgeGetConfig: IPC_CHANNELS.BRIDGE_CONFIG_GET,
  bridgeSaveConfig: IPC_CHANNELS.BRIDGE_CONFIG_SAVE,
  bridgeGetStatus: IPC_CHANNELS.BRIDGE_STATUS_GET,
  bridgeTestFeishu: IPC_CHANNELS.BRIDGE_FEISHU_TEST,
  bridgeWechatQrcode: IPC_CHANNELS.BRIDGE_WECHAT_QRCODE,
  bridgeWechatQrcodeStatus: IPC_CHANNELS.BRIDGE_WECHAT_QRCODE_STATUS,
  bridgeListBindings: IPC_CHANNELS.BRIDGE_BINDING_LIST,
  bridgePlatformRestart: IPC_CHANNELS.BRIDGE_PLATFORM_RESTART,
  onBridgeStatusChanged: IPC_CHANNELS.BRIDGE_STATUS_CHANGED,
  onBridgeSessionsUpserted: IPC_CHANNELS.BRIDGE_SESSIONS_UPSERTED,
  onSessionsChanged: IPC_CHANNELS.SESSIONS_CHANGED,
  webAccessGetInfo: IPC_CHANNELS.WEB_ACCESS_GET_INFO,
  webAccessRegenerateToken: IPC_CHANNELS.WEB_ACCESS_REGENERATE_TOKEN,
  webAccessCopyLink: IPC_CHANNELS.WEB_ACCESS_COPY_LINK,
  fsListRoots: IPC_CHANNELS.FS_LIST_ROOTS,
  fsListDir: IPC_CHANNELS.FS_LIST_DIR,
  fsMkdir: IPC_CHANNELS.FS_MKDIR,
  fsStat: IPC_CHANNELS.FS_STAT,
  fsRename: IPC_CHANNELS.FS_RENAME,
  fsTrash: IPC_CHANNELS.FS_TRASH,
  fsShowInExplorer: IPC_CHANNELS.FS_SHOW_IN_EXPLORER,
  resolveExportTarget: IPC_CHANNELS.EXPORT_RESOLVE_TARGET,
  onExportTargetRequested: IPC_CHANNELS.EXPORT_REQUEST_TARGET,
};

// ── token 读取 ──

/** ① location.hash 中 #token=…（扫码/复制链接入口）：读出即 history.replaceState 清除地址栏
 *  hash（token 不随任何后续 HTTP 请求行发送），由调用方存入 localStorage。 */
function takeTokenFromHash(): string | null {
  if (!location.hash.startsWith('#token=')) return null;
  const raw = location.hash.slice('#token='.length);
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const token = decodeURIComponent(raw).trim();
    return token || null;
  } catch {
    return null;
  }
}

/** ② 已存的 localStorage.clWebToken（上次扫码/登录持久化）。 */
function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

// ── WS 连接（单次）──

function isSocketOpen(): boolean {
  return currentSocket !== null && currentSocket.readyState === WebSocket.OPEN;
}

/** 服务端帧分发：resolve → 待决 invoke；event → 本地按 channel 过滤派发（cb 收 args[0]）；
 *  bye 仅告示，连接终止以 close 事件为准。 */
function dispatchServerFrame(frame: WireServerFrame): void {
  if (frame.kind === 'resolve') {
    const pending = pendingInvokes.get(frame.id);
    if (!pending) return;
    pendingInvokes.delete(frame.id);
    if (frame.ok) pending.resolve(decodeWireValue(frame.result));
    else pending.reject(new Error(frame.error));
    return;
  }
  if (frame.kind === 'event') {
    const set = eventSubscribers.get(frame.channel);
    if (!set || set.size === 0) return;
    const args = decodeWireValue(frame.args) as unknown[];
    const payload = args[0];
    for (const cb of [...set]) cb(payload);
  }
}

function failAllPendingInvokes(): void {
  for (const pending of pendingInvokes.values()) pending.reject(new Error('Web 桥未连接'));
  pendingInvokes.clear();
}

function openConnection(token: string): BridgeConnection {
  // 隧道 HTTPS 场景自动 wss；WS 升级 query 是 token 进入网络请求行的唯一位置（计划 §2）。
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  let settled = false;
  let resolveWelcome!: () => void;
  let rejectWelcome!: (error: Error) => void;
  const welcome = new Promise<void>((resolve, reject) => {
    resolveWelcome = resolve;
    rejectWelcome = reject;
  });
  let resolveClosed!: (code: number) => void;
  const closed = new Promise<number>((resolve) => {
    resolveClosed = resolve;
  });
  ws.onmessage = (ev: MessageEvent) => {
    let frame: WireServerFrame;
    try {
      frame = JSON.parse(String(ev.data)) as WireServerFrame;
    } catch {
      return; // 非 JSON 帧（理论不可达）忽略
    }
    if (frame.kind === 'welcome') {
      if (!settled) {
        settled = true;
        resolveWelcome();
      }
      return;
    }
    dispatchServerFrame(frame);
  };
  ws.onclose = (ev: CloseEvent) => {
    if (currentSocket === ws) currentSocket = null;
    failAllPendingInvokes();
    if (!settled) {
      settled = true;
      rejectWelcome(
        ev.code === 4001
          ? new WebBridgeAuthError('令牌无效或已更换')
          : new Error(`连接关闭（code ${ev.code}）`),
      );
    }
    resolveClosed(ev.code);
  };
  ws.onerror = () => {
    // close 事件随后必然到达，统一在 onclose 收口，此处不重复处理
  };
  return { ws, welcome, closed };
}

// ── invoke 通道 ──

function newInvokeId(): string {
  // http 局域网 IP 非安全上下文时 crypto.randomUUID 可能缺席，回退时间戳+随机串（服务端不校验格式）
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function invokeOverWire(channel: string, args: unknown[]): Promise<unknown> {
  const ws = currentSocket;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Web 桥未连接'));
  }
  const id = newInvokeId();
  return new Promise<unknown>((resolve, reject) => {
    pendingInvokes.set(id, { resolve, reject });
    try {
      // encodeWireValue 对数组整体编解码（返回 unknown；此处入参恒为数组，断言回数组形状）
      ws.send(JSON.stringify({
        v: 1,
        kind: 'invoke',
        id,
        channel,
        args: encodeWireValue(args) as unknown[],
      }));
    } catch (error) {
      pendingInvokes.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// ── window.claudeLink 全量代理构建 ──

function createWebApi(): ClaudeLinkAPI {
  // P1-5：web 形态标记——渲染层（session-store）据此判定 web 模式（sessionStorage 恢复
  // active 会话）；本文件仅网页端加载（桌面 Electron 路径不含本 chunk），桌面恒无此标记。
  ;(window as any).__claudeLinkWebBridge = true;
  const api: Record<string, unknown> = {};
  for (const key of Object.keys(WEB_CHANNEL_TABLE) as Array<keyof ClaudeLinkAPI>) {
    const channel = WEB_CHANNEL_TABLE[key];
    if (key.startsWith('on')) {
      // on* → 本地订阅注册 + 返回反注册函数（cb 收 args[0]）；订阅无需通知服务端（全量广播本地过滤）
      api[key] = (callback: (payload: unknown) => void): (() => void) => {
        let set = eventSubscribers.get(channel);
        if (!set) {
          set = new Set();
          eventSubscribers.set(channel, set);
        }
        set.add(callback);
        return () => {
          set.delete(callback);
        };
      };
    } else if (key.startsWith('remove') && key.endsWith('Listener')) {
      // remove*Listener → 清空对应 channel 全部本地回调（对齐 preload removeAllListeners 语义）。
      // 注意仅限 *Listener 后缀：removeTask / removeRecentWorkspace / removeDraftAttachment 是
      // 普通 invoke（若按「remove 前缀一律清订阅」分派会静默吞掉这三个业务调用）。
      api[key] = (): void => {
        eventSubscribers.delete(channel);
      };
    } else {
      // 其余 → invoke(channel, [...args])（Promise，经 wire codec 双向编解码）
      api[key] = (...args: unknown[]): Promise<unknown> => invokeOverWire(channel, args);
    }
  }
  return api as unknown as ClaudeLinkAPI;
}

// ── 浮层（纯 DOM，样式内联贴近应用 warm-paper 主题；此时应用主题 CSS 尚未挂载）──

interface OverlayRefs {
  root: HTMLDivElement;
  msg: HTMLDivElement;
  err: HTMLDivElement;
  input: HTMLInputElement;
  btn: HTMLButtonElement;
}

let overlayRefs: OverlayRefs | null = null;

function ensureOverlay(): OverlayRefs {
  if (overlayRefs) return overlayRefs;
  const root = document.createElement('div');
  const panel = document.createElement('div');
  const brand = document.createElement('div');
  const msg = document.createElement('div');
  const input = document.createElement('input');
  const btn = document.createElement('button');
  const err = document.createElement('div');
  const setStyle = (el: HTMLElement, styles: Partial<CSSStyleDeclaration>): void => {
    Object.assign(el.style, styles);
  };
  setStyle(root, {
    position: 'fixed', inset: '0', zIndex: '99999', display: 'none',
    alignItems: 'center', justifyContent: 'center',
    background: 'rgba(248,244,237,0.96)', fontFamily: 'system-ui, -apple-system, sans-serif',
  });
  setStyle(panel, {
    background: '#F4F0EA', border: '1px solid rgba(122,96,88,0.18)', borderRadius: '12px',
    padding: '28px 32px', width: 'min(360px, 88vw)', boxSizing: 'border-box',
    boxShadow: '0 8px 32px rgba(59,61,63,0.14)',
  });
  setStyle(brand, { fontSize: '18px', fontWeight: '600', color: '#3B3D3F', marginBottom: '10px' });
  brand.textContent = 'Claude Link';
  setStyle(msg, { fontSize: '13px', color: '#6A6C70', lineHeight: '1.5' });
  setStyle(input, {
    display: 'block', width: '100%', padding: '8px 10px', marginTop: '12px',
    border: '1px solid rgba(122,96,88,0.28)', borderRadius: '8px', fontSize: '14px',
    background: '#FCFAF5', color: '#3B3D3F', boxSizing: 'border-box',
  });
  input.type = 'password';
  input.placeholder = '访问令牌';
  setStyle(btn, {
    display: 'block', width: '100%', padding: '9px 0', marginTop: '12px',
    background: '#537D96', color: '#FFFFFF', border: 'none', borderRadius: '8px',
    fontSize: '14px', cursor: 'pointer',
  });
  btn.textContent = '连接';
  setStyle(err, { fontSize: '12px', color: '#8B3A3A', minHeight: '16px', marginTop: '8px' });
  panel.append(brand, msg, input, btn, err);
  root.append(panel);
  document.body.append(root);
  overlayRefs = { root, msg, err, input, btn };
  return overlayRefs;
}

/** 登录浮层（纯 DOM）：品牌名 + 令牌输入框 + 连接按钮 + 错误行。用户提交后 resolve(token)。 */
function showLoginOverlay(errorMessage: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const ui = ensureOverlay();
    ui.msg.textContent = '请输入访问令牌';
    ui.err.textContent = errorMessage;
    ui.input.value = '';
    ui.input.disabled = false;
    ui.btn.disabled = false;
    ui.input.style.display = 'block';
    ui.btn.style.display = 'block';
    ui.root.style.display = 'flex';
    const submit = (): void => {
      const value = ui.input.value.trim();
      if (!value) {
        ui.err.textContent = '请输入令牌';
        return;
      }
      ui.input.disabled = true;
      ui.btn.disabled = true;
      resolve(value);
    };
    ui.btn.onclick = (): void => submit();
    ui.input.onkeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Enter') submit();
    };
    ui.input.focus();
  });
}

/** 重连浮层：已安装后断线「连接已断开，正在重连…（第 N 次）」；首次安装期连不上「无法连接服务器，
 *  正在重试…（第 N 次）」。隐藏输入行（重试无需用户输入）。 */
function showReconnectOverlay(attempt: number, installed: boolean): void {
  const ui = ensureOverlay();
  ui.msg.textContent = installed
    ? `连接已断开，正在重连…（第 ${attempt} 次）`
    : `无法连接服务器，正在重试…（第 ${attempt} 次）`;
  ui.err.textContent = '';
  ui.input.style.display = 'none';
  ui.btn.style.display = 'none';
  ui.root.style.display = 'flex';
}

function hideOverlay(): void {
  if (overlayRefs) overlayRefs.root.style.display = 'none';
}

// ── 移动端生命周期加速：online / visibilitychange(visible) → 立即重试、跳过当次退避等待 ──

function ensureLifecycleRetryListeners(): void {
  if (lifecycleBound) return;
  lifecycleBound = true;
  window.addEventListener('online', () => {
    if (!isSocketOpen()) cancelBackoffWait?.();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !isSocketOpen()) cancelBackoffWait?.();
  });
}

function backoffWait(): Promise<void> {
  const delay = BACKOFF_SCHEDULE_MS[Math.min(reconnectAttempt, BACKOFF_SCHEDULE_MS.length) - 1] ?? 15000;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      cancelBackoffWait = null;
      resolve();
    }, delay);
    cancelBackoffWait = (): void => {
      clearTimeout(timer);
      cancelBackoffWait = null;
      resolve();
    };
  });
}

// ── 重连成功（welcome）后的状态对齐序列 ──

/** 计划 §3-P4-2 补充：断线期间推送事件不补推，重连 welcome 后立即执行——
 *  ① sessionStore.loadSessions() 重拉列表；
 *  ② 当前活动会话为持久会话时重入 switchSession（复用既有「DB 重载 + 流式快照恢复」路径，
 *     不新写合并逻辑；列表内取最新对象，缺失时退回当前对象）；
 *  ③ interaction-store.reconcile() 重水合待决交互弹窗——该 action 即启动水合逻辑的可重入形态，
 *     内部经 getPendingInteractions 对账（主进程仍挂起的补挂、已答复/取消的本地移除）；
 *  ④ update-store 经 getUpdateInfo 幂等重拉当前态（applyState 幂等应用）。
 *  执行形态：stores 经动态 import 于真实调用时求值——本模块在引导早期（pinia 挂载前）运行，
 *  但对齐只发生在重连 welcome 后；installWebBridge resolve 后 boot 同步 mount（其后再无 await），
 *  任何后续 WS 事件必然晚于 pinia 安装，store 访问安全。整体 try/catch 兜底，对齐失败由
 *  后续广播与既有对账机制自愈。 */
async function runRealignSequence(): Promise<void> {
  try {
    const { useSessionStore } = await import('../stores/session-store');
    const { useInteractionStore } = await import('../stores/interaction-store');
    const { useUpdateStore } = await import('../stores/update-store');
    const sessionStore = useSessionStore();
    await sessionStore.loadSessions();
    const active = sessionStore.activeSession;
    if (active && !active.transient) {
      const fresh = sessionStore.sessions.find((s) => s.id === active.id) ?? active;
      await sessionStore.switchSession(fresh);
    }
    // SA-4（P5 恢复接线）追加①：running 概览重对齐——断线期间开始的回合在重连后恢复侧栏
    // 黄灯/计时（无 running 会话时 overview=[] 为 no-op；已在 runningSessions 的会话由
    // action 内部跳过，不重复 markRunning）。追加②：active 为持久会话且在 running 清单内时
    // 拉细快照灌流式累加器与瞬态（applyRuntimeSnapshot 按长度规则采用，终态快照内部自拒）。
    // 顺序：先订阅（App.vue 挂载（先于 loadConfig/恢复接线）注册 CHAT_EVENT 订阅，断线不注销）→ 后拉快照，与 SA-3
    // 竞态协议一致。独立 try/catch：投影对齐失败静默，不阻断后续 reconcile/updateInfo 步骤。
    try {
      const overview = await window.claudeLink.getRunningOverview();
      sessionStore.applyRunningOverview(overview);
      const current = sessionStore.activeSession;
      if (current && !current.transient && overview.some((e) => e.sessionId === current.id)) {
        const snap = await window.claudeLink.getRuntimeSnapshot(current.id);
        if (snap) sessionStore.applyRuntimeSnapshot(snap);
      }
    } catch {
      // 概览/快照对齐失败不致命
    }
    void useInteractionStore().reconcile();
    const info = await window.claudeLink.getUpdateInfo();
    useUpdateStore().applyState(info.state);
  } catch {
    // 对齐失败不致命
  }
}

// ── 安装入口 ──

/** 引导入口（main.ts 在 !window.claudeLink 时动态 import 调用）：读取 token → 建立 WS →
 *  首个 welcome 赋值 window.claudeLink 并 resolve（boot 继续 mount）；此后断线在本模块内
 *  自愈重连（重连浮层 + 退避 + 生命周期加速 + 对齐序列），仅 4001 清 token 回登录浮层。 */
export async function installWebBridge(): Promise<void> {
  if (installPromise) return installPromise;
  installPromise = runBridgeLifecycle();
  return installPromise;
}

async function runBridgeLifecycle(): Promise<void> {
  const webApi = createWebApi();
  // token 读取顺序：① hash（扫码/复制链接入口，读后即清地址栏）→ 存 localStorage；② 已存值。
  const hashToken = takeTokenFromHash();
  if (hashToken) {
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, hashToken);
    } catch {
      // 持久化失败不阻断本次连接（隐私模式等），仅失去刷新免登录
    }
  }
  let token: string | null = hashToken ?? readStoredToken();
  let firstConnectDone = false;
  let loginError = '';
  let resolveBootGate!: () => void;
  const bootGate = new Promise<void>((resolve) => {
    resolveBootGate = resolve;
  });
  // 移动端生命周期加速（round-008 R1-F5 自 welcome 分支上移）：主循环开始前绑定一次——首连
  // 失败期 online/visibilitychange 也能跳过当次退避等待。回调内 isSocketOpen() 判定 +
  // cancelBackoffWait?.() 空安全，登录浮层等待期触发为 no-op，无副作用。
  ensureLifecycleRetryListeners();
  // 主生命周期循环：连接 → 断线 → 退避重连 → …；仅 close 4001 回登录浮层。
  void (async () => {
    for (;;) {
      if (!token) token = await showLoginOverlay(loginError);
      reconnectAttempt += 1;
      const conn = openConnection(token);
      currentSocket = conn.ws;
      let authFail = false;
      let connectFailed = false;
      try {
        await conn.welcome;
      } catch (error) {
        if (error instanceof WebBridgeAuthError) authFail = true;
        else connectFailed = true;
      }
      if (!authFail && !connectFailed) {
        // P0-3：welcome 成功即 token 已被服务端验证有效——手输令牌同样回写 localStorage
        //（刷新免重输）。与 4001 分支不冲突（有效才存、无效即清）；hash 入口的写入逻辑
        // 在上方保留不动。
        try {
          localStorage.setItem(TOKEN_STORAGE_KEY, token);
        } catch {
          // 隐私模式等持久化失败不阻断连接,仅失去刷新免登录
        }
        // welcome：赋值 window.claudeLink（仅首次；订阅/待决表模块级跨重连存活）→ 收起浮层
        hideOverlay();
        if (!apiInstalled) {
          apiInstalled = true;
          window.claudeLink = webApi;
        } else {
          void runRealignSequence();
        }
        reconnectAttempt = 0;
        if (!firstConnectDone) {
          firstConnectDone = true;
          resolveBootGate();
        }
        const code = await conn.closed;
        if (code === 4001) authFail = true;
        else connectFailed = true;
      }
      if (authFail) {
        // 令牌无效或已更换：清 stored token → 回登录浮层
        try {
          localStorage.removeItem(TOKEN_STORAGE_KEY);
        } catch {
          // 清理失败不阻断登录流程
        }
        token = null;
        loginError = '令牌无效或已更换';
        reconnectAttempt = 0;
        continue;
      }
      // 断线/连接失败：重连浮层 + 退避（online/visible 立即重试跳过等待）
      showReconnectOverlay(reconnectAttempt, firstConnectDone);
      await backoffWait();
    }
  })();
  return bootGate;
}
