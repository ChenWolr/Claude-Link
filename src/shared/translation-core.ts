// translation-core.ts
// AI 回复翻译（2026-11-19 UI 五点批次 P5；2026-11-20 第三轮 R6 免费网页 MT 引擎组终稿）的纯逻辑层：
// 载荷类型 + 既有 9 常量与第三轮引擎组 4 常量 + 出厂端点/引擎种子（单一真相源）+ 切段（含
// 代码块判定）/哈希/translation 节 sanitize 纯函数。
// 先例 shared/topic-analyzer-core.ts 纯函数三端共用——主进程（translation-service /
// translation-engines 消费）、契约脚本（tdd-translation-core-verify / tdd-message-translate-verify
// 直跑单测）、渲染层（preload/web-bridge 类型引用）三方同一份实现，零运行时依赖。
//
// R6 置换（01 §5.2.6）：删 LLM/SSE 四件套（Anthropic 请求体构造 / SSE text_delta 解析 /
// message_stop 流结束判定 / system 翻译提示词），增出厂种子、引擎常量；hashSegment 与既有
// TRANSLATION_* 常量数值不动。
// 2026-11-22 扩容批次 p6/W5：注册/付费层（官方 API 付费引擎）与模板引擎整链移除——kind 白名单
// 收窄、付费引擎节流常量与官方端点常量删除、模板 DSL 的 body 渲染/responsePath 取值/模板校验
// 纯函数与凭据读路径视图随消费面整链移除（全链删净、删后零死引用）。
// 2026-11-22 扩容批次 p7/W4：baidu-web 死引擎清理 + google-gtx 用户裁决剔除（「谷歌先剔除掉」）
// ——kind 白名单收窄至五 kind 终态、出厂种子重排五元终序（bing→alibaba→qq→sogou→youdao，P3-4
// 直书）、两死端点常量删除、sanitize 增 W4 配置迁移三规则（死种子剔除/规范种子补齐/endpoint
// 剥离）。p8：P1-B 代理面回撤——translation 节出站代理地址字段删除、存量键 sanitize 剥离
// （T-迁-7）；useProxy 透传保留（机械休眠面，评审 P3-7：无出厂/UI 入口消费者，机械保留原样）。
//
// 目标语言固定简体中文（03-实施计划.md 假设标注 #1：不引设置项，最小影响面；各内置引擎
// 适配器各自映射本引擎的简中字面）。
// 翻译对象 target 四元判别联合（kind 唯一判别——不用「同 kind 可选 messageId」形态，
// 可选字段的判别不唯一，幂等索引键会歧义，01 §5.1 修订说明）。

import type {
  TranslationConfig,
  TranslationEngineConfig,
  TranslationEngineKind,
} from './types/config';

// ── 载荷类型（ipc.ts 只放通道字面量，类型真相源在本文件） ──

/** 翻译对象：流式中正文=stream、流式中思考=thinking-stream；回合落库后由渲染层以
 *  message/thinking + messageId 重建（迁移）——同文段命中缓存零重译零重复请求。 */
export type TranslationTarget =
  | { kind: 'message'; messageId: string }
  | { kind: 'thinking'; messageId: string }
  | { kind: 'stream' }
  | { kind: 'thinking-stream' };

export type TranslationStatus = 'translating' | 'done' | 'error' | 'stopped';

/** GET_STATE 视图（刷新/重连后重挂载；状态源在主进程）。 */
export interface TranslationStateView {
  translationId: string;
  sessionId: string;
  target: TranslationTarget;
  status: TranslationStatus;
  /** 已译段（未译段缺席；段内全量替换语义）。 */
  segments: Array<{ index: number; translated: string | null }>;
  /** 当前切段总数（流式时随原文增长）。 */
  totalSegments: number;
  error?: string;
}

export type TranslationStartResult = { ok: true; translationId: string } | { ok: false; error: string };

/** 主→渲染推送载荷（TRANSLATION_EVENT，携 sessionId 供渲染层过滤）。 */
export interface TranslationEventPayload {
  translationId: string;
  sessionId: string;
  target: TranslationTarget;
  kind: 'started' | 'delta' | 'done' | 'error' | 'stopped';
  /** delta 所属段。 */
  segmentIndex?: number;
  /** delta：该段累计译文（段内全量替换，幂等）。第三轮起网页 MT 无流式：段完成即一帧
   *  delta=整段译文，payload 形态与消费端不变（01 §5.2.5）。 */
  text?: string;
  /** 进度（done/error/stopped 亦携带终值）。 */
  translatedSegments?: number;
  totalSegments?: number;
  error?: string;
}

// ── 一键探测（2026-11-20 第三轮 R6；TRANSLATE_PROBE 返回，通道本体属 p5b wiring 点） ──

/** 探测结果行：engines 按探测时配置序返回；latencyMs 非负毫秒；error=中文摘要供结果表直显。 */
export interface TranslationProbeEngineResult {
  id: string;
  kind: string; // TranslationEngineKind（类型定义在 shared/types/config.ts）
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface TranslationProbeResult {
  ok: true;
  engines: TranslationProbeEngineResult[];
  /** 仅 apply=true 时携带：重排后的引擎 id 序列（UI 直接展示新序）。 */
  appliedOrder?: string[];
}

// ── 常量（单一真相源，主进程消费；渲染层只读 TRANSLATION_PUSH_THROTTLE_MS 作注释对照） ──

/** 源文本上限（≈12.5 万字极限拒绝线）。 */
export const TRANSLATION_MAX_SOURCE_CHARS = 100_000;
/** 单段上限（超长段硬切；仅对非代码块段生效——代码块段零送翻无引擎长度风险，§5.2 规则 5）。 */
export const TRANSLATION_SEGMENT_MAX_CHARS = 1_200;
/** 尾部碎段并入前段阈值。 */
export const TRANSLATION_MIN_TAIL_CHARS = 40;
/** 段数上限（防御性，先于 100k 字触发即拒）。 */
export const TRANSLATION_MAX_SEGMENTS = 400;
/** 每会话段缓存上限（LRU 淘汰）。 */
export const TRANSLATION_CACHE_MAX_SEGMENTS = 2_000;
/** 每会话在飞段请求数（引擎组礼貌限频第一层）。 */
export const TRANSLATION_CONCURRENCY = 2;
/** 段级总 deadline（跨引擎串联尝试封顶；5 引擎 × 10s = 50s < 60s，正常组不触顶）。 */
export const TRANSLATION_SEGMENT_TIMEOUT_MS = 60_000;
/** 单段响应累积上限。 */
export const TRANSLATION_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
/** 主进程 delta 推送节流（trailing 合帧）。 */
export const TRANSLATION_PUSH_THROTTLE_MS = 80;

// ── 第三轮（R6）引擎组常量（01 §5.1 常量块） ──

/** 单引擎单段尝试超时（网页接口快；5 引擎串联 50s < 段总 deadline 60s）。 */
export const TRANSLATION_ENGINE_TRY_TIMEOUT_MS = 10_000;
/** 单引擎探测超时（比段尝试略紧）。 */
export const TRANSLATION_PROBE_TIMEOUT_MS = 8_000;
/** 引擎 429 冷却（IP 级限频短期不恢复，冷却期内直接跳过该引擎；翻译与探测共享同表）。 */
export const TRANSLATION_ENGINE_429_COOLDOWN_MS = 60_000;
/** 探测固定短文本（en→zh，不写段缓存）。 */
export const TRANSLATION_PROBE_TEXT = 'Hello, world. This is a connectivity check.';

// ── 出厂端点种子（§5.2.3 各适配器端点；引擎条目 endpoint 缺省即用此值，端点数据化的种子真相源。
//  p7/W4 起 bing-web 为唯一可配端点（域名口径）；google/baidu 两端点常量随死引擎整链删除。 ──

/** bing-web：域名口径（cn.bing.com ↔ www.bing.com 可换；页面/接口 URL 由适配器按域名拼装）。 */
export const DEFAULT_BING_WEB_DOMAIN = 'cn.bing.com';

/** 出厂引擎种子（零配置开箱即译的组定义；p7/W4 终态五元序——bing 直连 LLM 形态打头，五个
 *  免费网页引擎全直连零代理依赖）。出卷清单 P3-4 直书五元序。
 *  id 用稳定可读字面（非随机 uuid）：种子需确定性，契约脚本与渲染层 defaultConfig 共用同份。 */
export const DEFAULT_TRANSLATION_ENGINES: TranslationEngineConfig[] = [
  { id: 'seed-bing-web', kind: 'bing-web', enabled: true, order: 0 },
  { id: 'seed-alibaba-web', kind: 'alibaba-web', enabled: true, order: 1 },
  { id: 'seed-qq-transmart', kind: 'qq-transmart', enabled: true, order: 2 },
  { id: 'seed-sogou-web', kind: 'sogou-web', enabled: true, order: 3 },
  { id: 'seed-youdao-web', kind: 'youdao-web', enabled: true, order: 4 },
];

// ── 纯函数：切段（第三轮返回形态 Array<{text, codeBlock}>，01 §5.2 规则 1~5） ──

const SENTENCE_SPLIT_RE = /(?<=[.!?。！？；;])/;

/** 规则 5：段落（行）以 ``` 开头即视为围栏开线；围栏闭线 = 以 ``` 开头的下一行；
 *  至文末未闭合防御性同判为代码（01 §5.2 规则 5）。 */
function isFenceOpen(trimmed: string): boolean {
  return trimmed.startsWith('```');
}

/**
 * 切段（第三轮引擎形态；段数/总长超限返回 null 由 service 映射「消息过长」拒绝）：
 * 1. 先按段落切——`\n\n` 与单个 `\n` 均作段落界（聊天消息少见严格空行），空白行滤除；
 * 2. 规则 5：``` 开头行开启围栏，吸收后续行直到 ``` 闭线（或文末防御性闭合）——整段标记
 *    codeBlock:true：不硬切、不发引擎请求（译文=原文）、照常入缓存与进度；行内代码
 *    （`foo` span）不做特殊处理；表格段送翻（codeBlock:false）；
 * 3. 非代码块段长 > SEGMENT_MAX(1200) 的，按句末标点二次切；仍超长的硬切 1200；
 * 4. 尾部 < MIN_TAIL(40) 的碎段并入前段——任何一侧为代码块段时不并入（围栏边界不因合并破坏）；
 * 5. 段数 > MAX_SEGMENTS(400) 或总长 > MAX_SOURCE_CHARS(100k) → null。
 * 空/纯空白 → []（service 侧空白拒绝的前置防御层）。
 */
export function segmentSourceText(source: string): Array<{ text: string; codeBlock: boolean }> | null {
  if (source.length > TRANSLATION_MAX_SOURCE_CHARS) return null;
  // 行级分组：围栏块吸收多行；普通行即段落（trim 滤空行）。
  const lines = source.split(/\r?\n/);
  interface RawBlock {
    text: string;
    codeBlock: boolean;
  }
  const blocks: RawBlock[] = [];
  let fenceBuf: string[] | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (fenceBuf !== null) {
      fenceBuf.push(line);
      if (isFenceOpen(trimmed)) {
        // 闭线（防御口径：任何 ``` 开头行都视为闭线）——围栏块定稿，内部行原样保全。
        blocks.push({ text: fenceBuf.join('\n').trim(), codeBlock: true });
        fenceBuf = null;
      }
      continue;
    }
    if (isFenceOpen(trimmed)) {
      fenceBuf = [trimmed];
      continue;
    }
    if (trimmed.length > 0) blocks.push({ text: trimmed, codeBlock: false });
  }
  if (fenceBuf !== null) {
    // 未闭合围栏防御性同判为代码（零送翻）。
    blocks.push({ text: fenceBuf.join('\n').trim(), codeBlock: true });
  }
  if (blocks.length === 0) return [];
  // 尾部碎段并入前段（阈值严格小于：恰 40 不并入；围栏块两侧均不并入）。
  if (blocks.length >= 2) {
    const last = blocks[blocks.length - 1];
    const prev = blocks[blocks.length - 2];
    if (
      last !== undefined &&
      prev !== undefined &&
      !last.codeBlock &&
      !prev.codeBlock &&
      last.text.length < TRANSLATION_MIN_TAIL_CHARS
    ) {
      blocks[blocks.length - 2] = { text: `${prev.text}\n\n${last.text}`, codeBlock: false };
      blocks.pop();
    }
  }
  const segments: Array<{ text: string; codeBlock: boolean }> = [];
  for (const block of blocks) {
    if (block.codeBlock) {
      // 规则 5：代码块段不硬切不二次切（零送翻无引擎长度风险）。
      segments.push({ text: block.text, codeBlock: true });
      continue;
    }
    if (block.text.length <= TRANSLATION_SEGMENT_MAX_CHARS) {
      segments.push({ text: block.text, codeBlock: false });
      continue;
    }
    // 句末标点二次切；切后仍超长的硬切 1200。
    for (const piece of block.text.split(SENTENCE_SPLIT_RE)) {
      if (piece.length === 0) continue;
      if (piece.length <= TRANSLATION_SEGMENT_MAX_CHARS) {
        segments.push({ text: piece, codeBlock: false });
        continue;
      }
      for (let i = 0; i < piece.length; i += TRANSLATION_SEGMENT_MAX_CHARS) {
        segments.push({ text: piece.slice(i, i + TRANSLATION_SEGMENT_MAX_CHARS), codeBlock: false });
      }
    }
  }
  if (segments.length > TRANSLATION_MAX_SEGMENTS) return null;
  return segments;
}

/** 缓存键：段原文的 FNV-1a 32 位 hex（确定性、无依赖、纯函数可单测；第三轮不动）。 */
export function hashSegment(source: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ── 纯函数：端点模板占位渲染（{text}/{source}/{target} 三占位） ──
// 2026-11-22 扩容批次 p7/W4 后零消费面（唯一消费者 google-gtx 适配器已整链剔除）：机械保留
// 休眠——与 P1-B「代理传输机械保留」同口径（先剔除语义下将来引擎加回即恢复消费；通用纯
// 函数零副作用，无运行时开销面）。模板引擎的 body 渲染/responsePath 取值/模板合法性校验
// 已随 W5 p6 整链移除（零死引用）。

export interface TemplateRenderValues {
  /** {text} 实参：URL 侧强制 encodeURIComponent。 */
  text: string;
  /** {source} 实参：缺省 'en'。 */
  source?: string;
  /** {target} 实参：缺省 'zh-CN'。 */
  target?: string;
}

const PLACEHOLDER_RE = /\{(text|source|target)\}/g;

/**
 * URL 模板渲染：{text}/{source}/{target} 三占位单遍替换（{text} 走 encodeURIComponent，
 * 保留字不泄漏进 URL；占位外字符一律字面，未知花括号 token 原样保留）。
 */
export function renderTemplateUrl(template: string, values: TemplateRenderValues): string {
  return template.replace(PLACEHOLDER_RE, (_m, name: string) => {
    if (name === 'text') return encodeURIComponent(values.text);
    if (name === 'source') return values.source ?? 'en';
    return values.target ?? 'zh-CN';
  });
}

// ── 纯函数：translation 节读路径 sanitize（§5.2.2 纪律；config-manager 消费，契约可单测） ──

// 2026-11-22 扩容批次 p7/W4 终态五 kind（google-gtx/baidu-web 已随死引擎清理移出联合类型）。
const ENGINE_KIND_WHITELIST: readonly TranslationEngineKind[] = [
  'bing-web',
  'alibaba-web',
  'qq-transmart',
  'sogou-web',
  'youdao-web',
];

/** W4 配置迁移规则①（契约钉死，评审 P1-5/P1-6）：已删除引擎的出厂种子 id——存量配置含这两
 *  id 的条目整条剔除（kind 白名单外已覆盖其正常形态；此规则兜「同 seed id 配越集/漂移 kind」
 *  的存量残留）；seed-youdao-web 保留（kind 存活、走 V2 重写后协议）。用户自定义 id 不受影响。 */
const DEAD_SEED_IDS: readonly string[] = ['seed-google-gtx', 'seed-baidu-web'];

/** W4 配置迁移规则③（评审 P1-5）：endpoint 不消费面——四 kind 固定多主机协议，endpoint 一律
 *  剥离（含存量 youdao V1 脏值）；bing-web（域名口径）保留。 */
const ENDPOINT_STRIP_KINDS: ReadonlySet<TranslationEngineKind> = new Set<TranslationEngineKind>([
  'alibaba-web',
  'qq-transmart',
  'sogou-web',
  'youdao-web',
]);

/**
 * translation 节 sanitize（读路径恒产出该键；写路径不清洗；旧配置缺键读出种子不报错、
 * 不迁移不升版）：
 * 1. kind 白名单外丢弃（越集 kind 条目静默剔除——p7/W4 起白名单五 kind 终态，存量付费通道/
 *    模板引擎/google/baidu 条目随此剔除）；enabled 非 boolean → true；order 非有限整数 →
 *    按数组序重排赋值；
 * 2. W4 规则①：id ∈ DEAD_SEED_IDS 的条目整条剔除；
 * 3. W4 规则②规范种子补齐：五规范种子凡 config 中缺席者（按 id 判定，缺 id 才补）自动追加，
 *    order =（在场条目最大 order + 1）起递增殿后（评审 P1-6 读法 B 钉：存量 bing(1)/youdao(2)
 *    的存量配置补齐终序 [bing,youdao,alibaba,qq,sogou] 且 order 单调无撞号）；在场条目的
 *    启停/排序不覆盖（用户显式 enabled:false 的种子仅缺 id 时补）；
 * 4. W4 规则③：ENDPOINT_STRIP_KINDS 四 kind 的 endpoint 一律剥离（含存量 V1 脏值），
 *    bing-web endpoint 保留；
 * 5. useProxy 透传保留（机械休眠面，评审 P3-7 口径：无出厂/UI 入口消费者，机械保留原样，
 *    将来引擎加回即恢复消费）；
 * 6. P1-B 代理面回撤（p8/W4）：存量出站代理地址键一律剥离（任意值型——字段已删，它存在的
 *    唯一理由是 google，google 已剔除；出站代理仅剩 env > 系统代理链）。
 */
export function sanitizeTranslationConfig(raw: unknown): TranslationConfig {
  const rawEngines =
    typeof raw === 'object' && raw !== null && Array.isArray((raw as { engines?: unknown }).engines)
      ? ((raw as { engines: unknown[] }).engines)
      : null;
  const engines: TranslationEngineConfig[] = [];
  if (rawEngines) {
    for (const item of rawEngines) {
      if (typeof item !== 'object' || item === null) continue;
      const e = item as Partial<TranslationEngineConfig>;
      if (typeof e.kind !== 'string' || !ENGINE_KIND_WHITELIST.includes(e.kind as TranslationEngineKind)) continue;
      const kind = e.kind as TranslationEngineKind;
      const id = typeof e.id === 'string' && e.id.trim() !== '' ? e.id : `${kind}-${engines.length}`;
      // W4 规则①：已删除引擎的种子 id 整条剔除（seed-youdao-web 不在列，保留走 V2 协议）。
      if (DEAD_SEED_IDS.includes(id)) continue;
      const enabled = typeof e.enabled === 'boolean' ? e.enabled : true;
      const order = typeof e.order === 'number' && Number.isFinite(e.order) && Number.isInteger(e.order)
        ? e.order
        : engines.length;
      // W4 规则③：四 kind 不消费 endpoint，一律剥离（空值兜底语义不变；bing-web 保留）。
      const endpoint =
        !ENDPOINT_STRIP_KINDS.has(kind) && typeof e.endpoint === 'string' && e.endpoint.trim() !== ''
          ? e.endpoint.trim()
          : undefined;
      const useProxy = typeof e.useProxy === 'boolean' ? e.useProxy : undefined;
      engines.push({
        id,
        kind,
        enabled,
        order,
        ...(endpoint !== undefined ? { endpoint } : {}),
        ...(useProxy !== undefined ? { useProxy } : {}),
      });
    }
  } else {
    // 缺键 → 出厂种子（深拷贝防调用方就地改写污染单一真相源）。
    for (const seed of DEFAULT_TRANSLATION_ENGINES) engines.push({ ...seed });
  }
  // W4 规则②规范种子补齐：按 id 判定缺席者自动追加（缺 id 才补、不覆盖在场条目；全在册时
  // 本步零操作）——order = 在场条目最大 order + 1 起递增殿后（零在场条目时从 0 起，等价种子
  // 缺省形态）。
  const presentIds = new Set(engines.map((e) => e.id));
  let nextOrder = engines.reduce((max, e) => (e.order > max ? e.order : max), -1) + 1;
  for (const seed of DEFAULT_TRANSLATION_ENGINES) {
    if (presentIds.has(seed.id)) continue;
    engines.push({ ...seed, order: nextOrder++ });
  }
  // P1-B 代理面回撤（p8/W4）：translation 节的出站代理地址字段整链删除——它存在的唯一理由是
  // google（已剔除）。存量键不透传（任意值型一律剥，重构造产物天然剥离）；评审 P3-7 口径：
  // 无出厂/UI 入口消费者，机械保留原样。useProxy 透传保留（上方字段面注释）。
  return { engines };
}

/** target 形状判别（kind 唯一判别 + 消息类 target 的 messageId 非空串）——IPC 入口与 service 双保险。 */
export function isValidTranslationTarget(value: unknown): value is TranslationTarget {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as { kind?: unknown; messageId?: unknown };
  if (t.kind === 'message' || t.kind === 'thinking') {
    return typeof t.messageId === 'string' && t.messageId.trim() !== '';
  }
  return t.kind === 'stream' || t.kind === 'thinking-stream';
}
