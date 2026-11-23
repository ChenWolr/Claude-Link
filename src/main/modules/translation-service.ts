// 【连接面声明】本模块是 AI 回复翻译的主进程编排层：自身零 HTTP 直连（第三轮 R6 起）——段翻译
// 全部经 translation-engines.ts 的 WebMtEngineGroup 引擎组（连接面白名单成员，头声明见该文件；
// regression-tests 断言 B 白名单已随 R6 同步）。AI 回复翻译：主进程状态机 + 会话级段缓存 +
// 引擎组降级链。引擎组零凭据零配置（免费网页 MT 引擎组，出厂种子 DEFAULT_TRANSLATION_ENGINES）；
// 聊天主链（chat-backend/sdk-backend 除会话删除清理钩子一行外）零交叉；聊天 provider 解析链
//（会话模型解析 / api-url 构建 / session 仓库）已随 R6 引擎层置换彻底删除。
//
// 状态机（01 §5.2）：idle(无 entry) ─START→ translating ─全部段 done→ done / ─某段全组耗尽失败→
// error / ─STOP→ stopped（缓存与已译段保留）；done/error/stopped ─再 START（同 target）→
// translating（缓存全命中直达 done 零 HTTP）；error ─RETRY→ translating（仅失败段，重新走组）。
//
// 内存三表（translations / bySession / segmentCache），不落库——翻译是伴随功能，进程生命周期内
// 有效；App 重启缓存清零、重新翻译重新请求（默认通道零费用，01 §5.6 申报边界）。流式定稿规则：
// 除末段全部视为定稿即译；末段仅迁移 START（target kind message/thinking，落库全文）或末段自身
// 被 1200 硬切拆分（source.length ≥ 1200，回退增长由段缓存兜底零重复请求）时才译——每段恰好
// 请求一次。代码块段（Segment.codeBlock）零送翻：译文=原文、照常入缓存与进度（01 §5.2 规则 5）。
//
// 引擎粘性（01 §5.2.1）：entry.engineId 生命周期内固定首选引擎；粘性引擎连续失败 2 段或处于
// 429 冷却 → 换组内下一可用引擎并回写；探测重排后的新 order 只影响下一批 START 的初始粘性
// 选择（进行中 entry 不打断——START 仅在 entry 非 running 时重建引擎组）。
// engineCooldown 表（kind → 冷却截止戳）：429 写 60s，冷却期内该引擎直接跳过；翻译与探测共享。
//
// 推送节流：每 translationId 80ms trailing 合帧（delta 合并为最新段文本一帧；done/error/stopped
// 直发，终态前先 flush 挂起 delta 保证渲染层最后一帧段文本先于终态到达）。第三轮起网页 MT 无
// 流式：段完成即一帧 delta=整段译文，payload 形态与渲染层消费逻辑零变化（01 §5.2.5）。发射一律
// pushToMainWindow(IPC_CHANNELS.TRANSLATION_EVENT, payload)——本模块不出现 webContents.send 字面
// （wiring-verify §③ 断言：该字面只许出现在 push-bus.ts）。
//
// 测试 seam（03 裁决 R3，01 §5.2.7 引擎尝试契约）：__setTranslationTransportForTest 注入
// transport 替换真实引擎 HTTP（转发 translation-engines 的安装点；先例 sdk-backend.ts
// __setSdkQueryFactoryForTest）；生产代码永不调用，仅测试入口安装。
import { randomUUID } from 'node:crypto';
import { getConfig, saveConfig } from './config-manager';
import { logger } from '../utils/logger';
import { pushToMainWindow } from './push-bus';
import { IPC_CHANNELS } from '../../shared/constants';
import {
  segmentSourceText,
  hashSegment,
  isValidTranslationTarget,
  DEFAULT_TRANSLATION_ENGINES,
  TRANSLATION_PROBE_TEXT,
  TRANSLATION_CONCURRENCY,
  TRANSLATION_SEGMENT_TIMEOUT_MS,
  TRANSLATION_PUSH_THROTTLE_MS,
  TRANSLATION_CACHE_MAX_SEGMENTS,
  TRANSLATION_SEGMENT_MAX_CHARS,
  TRANSLATION_PROBE_TIMEOUT_MS,
  TRANSLATION_ENGINE_429_COOLDOWN_MS,
  type TranslationTarget,
  type TranslationStatus,
  type TranslationStateView,
  type TranslationStartResult,
  type TranslationEventPayload,
  type TranslationProbeResult,
  type TranslationProbeEngineResult,
} from '../../shared/translation-core';
import type { TranslationConfig } from '../../shared/types/config';
import {
  createWebMtEngineGroup,
  __setTranslationEnginesTransportForTest,
  type WebMtEngineGroup,
  type TranslationTransport,
} from './translation-engines';

export type { TranslationTransport, TranslationTransportRequest } from './translation-engines';

// ── 内存三表 + 引擎冷却表 ──

interface Segment {
  index: number;
  source: string;
  translated: string | null;
  status: 'pending' | 'translating' | 'done' | 'failed';
  /** 规则 5：``` 围栏代码块段——零送翻（不发引擎请求）、译文=原文、照常入缓存与进度。 */
  codeBlock: boolean;
}

interface TranslationEntry {
  id: string;
  sessionId: string;
  target: TranslationTarget;
  status: TranslationStatus;
  sourceText: string;
  segments: Segment[];
  /** 已判定「定稿」的段边界（index < settledUpto 可译；末段不定稿不译——01 §5.2）。 */
  settledUpto: number;
  error?: string;
  /** 扩展循环在飞（并发 START 去重守卫）。 */
  running: boolean;
  /** 每段在飞请求一个（STOP/clear 统一 abort）。 */
  controllers: Set<AbortController>;
  /** 引擎粘性（01 §5.2.1）：entry 生命周期内固定首选引擎 id；undefined=下次按配置序取首个
   *  非冷却引擎。 */
  engineId?: string;
  /** 粘性引擎连续失败段数（≥2 → 换组内下一可用引擎并回写 engineId）。 */
  stickyFailStreak: number;
  /** 本 entry 的引擎组（START 时按当前配置构建；running 期间不重建——进行中 entry 不打断）。 */
  group: WebMtEngineGroup;
  /** 80ms trailing 合帧：挂起 delta 帧（按段 index 合帧——同窗多段完成各保各帧，flush 逐帧
   *  发送；p5c 修正前为单帧 last-wins，同窗完成的段先到帧被覆盖丢弃 → 渲染层缺段）+ 定时器句柄。 */
  pendingDelta: Map<number, TranslationEventPayload> | null;
  deltaTimer: NodeJS.Timeout | null;
}

const translations = new Map<string, TranslationEntry>();
const bySession = new Map<string, Set<string>>();
/** 会话级全局段缓存（不按 translationId 隔离——流式→落库迁移与重开不重复请求的关键）：
 *  sessionId → (segHash → 译文)，LRU（命中 delete+set 刷新顺序，超 2000 段逐最旧淘汰）。 */
const segmentCache = new Map<string, Map<string, string>>();
/** 引擎冷却表（kind → 冷却截止时间戳）：任一引擎收到 429 即写入 60s 冷却（kind 级共享表），期内直接跳过；
 *  到期自动回队。翻译与探测共享同一张表（探测 429 同样入冷却）。 */
const engineCooldown = new Map<string, number>();

/** 引擎组工厂（读路径 sanitize 保证 translation 节存在；缺键兜底出厂种子——零配置开箱双保险）。 */
function buildEngineGroup(): WebMtEngineGroup {
  const translationConfig = getConfig().translation ?? {
    engines: DEFAULT_TRANSLATION_ENGINES.map((e) => ({ ...e })),
  };
  return createWebMtEngineGroup(translationConfig, { cooldown: engineCooldown });
}

// ── R3 测试 seam：引擎尝试契约（转发 translation-engines 安装点） ──

/** @internal test-only — 注入 fake transport 覆盖真实引擎 HTTP；传 null 恢复默认。生产永不调用。 */
export function __setTranslationTransportForTest(transport: TranslationTransport | null): void {
  __setTranslationEnginesTransportForTest(transport);
}

// ── 启动期 env stub 钩子（02 §0 stub 纪律 + 03 R3：E2E/CDP 场景禁发真实网络请求）──
// CLAUDE_LINK_TRANSLATE_STUB=1 时模块加载即注入内置 stub transport（等价 __setTranslationTransportForTest
// 语义；不经手动注入，桌面/网页 CDP 冷启动场景经 spawn env 直达）。stub：每段延迟 ~80ms 返回确定性
// 译文「【译】」+ 源文本；CLAUDE_LINK_TRANSLATE_STUB_LOG 指定路径时逐请求追加一行 JSON（时间戳/
// source 长度/engineKind）供场景核对请求计数（未设则跳过日志）。env 未开启时零行为变化；
// typeof 守卫兼容无 process 的 vm 装载环境（tdd-message-translate-verify 行为卷）。fs 取用走
// process.getBuiltinModule（Node22+，免 require/import——bundler 与 vm 垫片两侧零触碰）。
if (typeof process !== 'undefined' && process.env?.CLAUDE_LINK_TRANSLATE_STUB === '1') {
  const stubLogPath = process.env.CLAUDE_LINK_TRANSLATE_STUB_LOG;
  __setTranslationEnginesTransportForTest((req) =>
    new Promise<{ ok: true; text: string }>((resolve, reject) => {
      const onAbort = (): void => reject(new Error('translation stub aborted'));
      if (req.signal.aborted) return onAbort();
      req.signal.addEventListener('abort', onAbort, { once: true });
      setTimeout(() => {
        req.signal.removeEventListener('abort', onAbort);
        if (req.signal.aborted) return onAbort();
        resolve({ ok: true, text: `【译】${req.segment}` });
        if (stubLogPath) {
          try {
            const fs = process.getBuiltinModule('node:fs');
            fs.appendFileSync(
              stubLogPath,
              `${JSON.stringify({ ts: new Date().toISOString(), sourceLen: req.segment.length, engineKind: req.engineKind })}\n`,
            );
          } catch {
            /* 日志失败不影响 stub 回包 */
          }
        }
      }, 80);
    }),
  );
}

// ── 段缓存（会话级 + LRU 2000 段） ──

function getSegmentCache(sessionId: string, hash: string): string | undefined {
  const bucket = segmentCache.get(sessionId);
  if (!bucket) return undefined;
  const hit = bucket.get(hash);
  if (hit !== undefined) {
    bucket.delete(hash);
    bucket.set(hash, hit); // LRU 命中刷新顺序
  }
  return hit;
}

function putSegmentCache(sessionId: string, hash: string, text: string): void {
  let bucket = segmentCache.get(sessionId);
  if (!bucket) {
    bucket = new Map();
    segmentCache.set(sessionId, bucket);
  }
  if (bucket.has(hash)) bucket.delete(hash);
  bucket.set(hash, text);
  while (bucket.size > TRANSLATION_CACHE_MAX_SEGMENTS) {
    const oldest = bucket.keys().next().value;
    if (oldest === undefined) break;
    bucket.delete(oldest);
  }
}

// ── target 幂等索引 ──

function targetKey(target: TranslationTarget): string {
  switch (target.kind) {
    case 'message':
      return `msg:${target.messageId}`;
    case 'thinking':
      return `think:${target.messageId}`;
    case 'stream':
      return 'stream';
    case 'thinking-stream':
      return 'think-stream';
  }
}

function findEntryByTarget(sessionId: string, key: string): TranslationEntry | undefined {
  const ids = bySession.get(sessionId);
  if (!ids) return undefined;
  for (const id of ids) {
    const entry = translations.get(id);
    if (entry && targetKey(entry.target) === key) return entry;
  }
  return undefined;
}

// ── 切段装载（身份保全合并：同 hash 段保留原对象——在飞请求闭包在重切后仍指回 live 段） ──

/** 返回本次填充新近完成的代码块段（START 后 emitStarted 再补 delta 帧——started 先于 delta 到达）。 */
function fillSegments(entry: TranslationEntry, sources: Array<{ text: string; codeBlock: boolean }>): Segment[] {
  const oldByHash = new Map(entry.segments.map((s) => [hashSegment(s.source), s] as const));
  const newlyDone: Segment[] = [];
  const next: Segment[] = sources.map((src, i) => {
    const hash = hashSegment(src.text);
    const old = oldByHash.get(hash);
    if (old) return old;
    if (src.codeBlock) {
      // 规则 5：代码块段零送翻——译文=原文，照常入缓存（重开零请求同样成立）与进度。
      const seg: Segment = { index: i, source: src.text, translated: src.text, status: 'done', codeBlock: true };
      putSegmentCache(entry.sessionId, hash, src.text);
      newlyDone.push(seg);
      return seg;
    }
    const cached = getSegmentCache(entry.sessionId, hash);
    return {
      index: i,
      source: src.text,
      translated: cached ?? null,
      status: cached !== undefined ? 'done' : 'pending',
      codeBlock: false,
    };
  });
  next.forEach((s, i) => {
    s.index = i;
  });
  entry.segments = next;
  entry.settledUpto = computeSettledUpto(entry);
  return newlyDone;
}

/** 流式定稿规则：message/thinking 全部定稿（迁移 START 携带落库全文）；stream/thinking-stream
 *  除末段外全部定稿，末段仅在自身被 1200 硬切拆分（length ≥ 1200）时定稿——若该末段后续增长，
 *  重切后同前缀段经缓存命中零重复请求。 */
function computeSettledUpto(entry: TranslationEntry): number {
  const n = entry.segments.length;
  if (entry.target.kind === 'message' || entry.target.kind === 'thinking') return n;
  if (n > 0 && (entry.segments[n - 1]?.source.length ?? 0) >= TRANSLATION_SEGMENT_MAX_CHARS) return n;
  return Math.max(0, n - 1);
}

// ── 推送（80ms trailing 合帧） ──

function translatedCount(entry: TranslationEntry): number {
  return entry.segments.filter((s) => s.status === 'done').length;
}

function pushDelta(entry: TranslationEntry, seg: Segment, accText: string): void {
  // 合帧按段 index 各保各帧（p5c 修正，2026-11-20）：修正前单帧 last-wins——同一 80ms 窗内
  // 完成的多段（如代码块段瞬时定稿 + 并发段同 tick 回包）先到帧被覆盖丢弃，渲染层译文视口
  // 永久缺段（UI5P P5-T27 首跑实测：3 明文段全到而 2 代码块段帧被吞）。帧契约不变：
  // 单帧仍 = 单段累计文本（段内全量替换幂等）；合帧 = 一窗多帧、index 升序逐帧发送，
  // 节流预算不变（仍一窗一批，渲染层 50ms throttle 既有契约不受影响）。
  const frame: TranslationEventPayload = {
    translationId: entry.id,
    sessionId: entry.sessionId,
    target: entry.target,
    kind: 'delta',
    segmentIndex: seg.index,
    text: accText,
    translatedSegments: translatedCount(entry),
    totalSegments: entry.segments.length,
  };
  if (entry.pendingDelta === null) entry.pendingDelta = new Map();
  entry.pendingDelta.set(seg.index, frame);
  if (entry.deltaTimer !== null) return;
  entry.deltaTimer = setTimeout(() => {
    entry.deltaTimer = null;
    flushPendingDelta(entry);
  }, TRANSLATION_PUSH_THROTTLE_MS);
}

/** 挂起 delta 冲洗（终态直发前亦调用：段文本帧先于终态到达渲染层，防尾段文本丢失）——
 *  挂起帧按 index 升序逐帧发送（同窗多段不丢帧，见 pushDelta 修正注）。 */
function flushPendingDelta(entry: TranslationEntry): void {
  if (entry.deltaTimer !== null) {
    clearTimeout(entry.deltaTimer);
    entry.deltaTimer = null;
  }
  const pending = entry.pendingDelta;
  entry.pendingDelta = null;
  if (pending) {
    for (const idx of [...pending.keys()].sort((a, b) => a - b)) {
      pushToMainWindow(IPC_CHANNELS.TRANSLATION_EVENT, pending.get(idx)!);
    }
  }
}

function emitTerminal(entry: TranslationEntry, kind: 'done' | 'error' | 'stopped', error?: string): void {
  flushPendingDelta(entry);
  const payload: TranslationEventPayload = {
    translationId: entry.id,
    sessionId: entry.sessionId,
    target: entry.target,
    kind,
    translatedSegments: translatedCount(entry),
    totalSegments: entry.segments.length,
  };
  if (error !== undefined) payload.error = error;
  pushToMainWindow(IPC_CHANNELS.TRANSLATION_EVENT, payload);
}

function emitStarted(entry: TranslationEntry): void {
  pushToMainWindow(IPC_CHANNELS.TRANSLATION_EVENT, {
    translationId: entry.id,
    sessionId: entry.sessionId,
    target: entry.target,
    kind: 'started',
    translatedSegments: translatedCount(entry),
    totalSegments: entry.segments.length,
  });
}

// ── 段翻译 = 引擎组调用（第三轮核心置换；原 LLM/SSE 路径整段删除） ──

/** STOP/clear 排水判定：独立函数取值——绕开 TS 对 entry.status 的跨 await 字面量窄化。 */
function isStopped(entry: TranslationEntry): boolean {
  return entry.status === 'stopped';
}

async function translateSegmentWithGroup(entry: TranslationEntry, seg: Segment): Promise<void> {
  seg.status = 'translating';
  const controller = new AbortController();
  entry.controllers.add(controller);
  // 段级总 deadline（全组串联封顶 60s；STOP/清理的外部 abort 经同一 controller 即时生效）。
  const deadline = setTimeout(() => controller.abort(), TRANSLATION_SEGMENT_TIMEOUT_MS);
  try {
    const res = await entry.group.translateSegment(seg.source, controller.signal, entry.engineId);
    if (isStopped(entry)) {
      // STOP/clear 触发的 abort：段标记回 pending（缓存与已译段保留），不进失败分类。
      seg.status = 'pending';
      seg.translated = null;
      return;
    }
    if (res.ok && res.text !== undefined && res.engineId !== undefined) {
      // 粘性引擎记账（01 §5.2.1）：首成功定粘；粘性失败降级接管 → 连败计数；
      // 连败 ≥2 或粘性被 429 冷却跳过 → 换成功引擎并回写。
      if (entry.engineId === undefined) {
        entry.engineId = res.engineId;
        entry.stickyFailStreak = 0;
      } else if (res.engineId !== entry.engineId) {
        entry.stickyFailStreak += 1;
        if (entry.stickyFailStreak >= 2 || res.stickySkipped) {
          entry.engineId = res.engineId;
          entry.stickyFailStreak = 0;
        }
      } else {
        entry.stickyFailStreak = 0;
      }
      // 缓存先落（重开/迁移/收起再开零请求的机制点）；段完成即一帧 delta=整段译文。
      putSegmentCache(entry.sessionId, hashSegment(seg.source), res.text);
      seg.translated = res.text;
      seg.status = 'done';
      pushDelta(entry, seg, res.text);
    } else {
      seg.status = 'failed';
      entry.stickyFailStreak += 1;
      if (entry.error === undefined) {
        entry.error = `第 ${seg.index + 1} 段翻译失败：${res.error ?? '引擎不可用'}`;
      }
    }
  } catch (err) {
    // 防御路径（组实现不 throw；到达即实现缺陷）：按失败处理不悬挂。
    seg.status = 'failed';
    if (entry.error === undefined) {
      entry.error = `第 ${seg.index + 1} 段翻译失败：${err instanceof Error ? err.message : String(err)}`;
    }
    logger.error('translateSegment unexpected error', err);
  } finally {
    clearTimeout(deadline);
    entry.controllers.delete(controller);
  }
}

async function runTranslation(entry: TranslationEntry): Promise<void> {
  if (entry.running) return;
  entry.running = true;
  try {
    while (true) {
      if (entry.status === 'stopped') return; // STOP/clear 排水
      const ready = entry.segments.filter((s) => s.status === 'pending' && s.index < entry.settledUpto);
      if (ready.length === 0) break;
      const batch = ready.slice(0, TRANSLATION_CONCURRENCY);
      await Promise.allSettled(batch.map((seg) => translateSegmentWithGroup(entry, seg)));
      if (isStopped(entry)) return; // 排水（abort 的段已由 translateSegmentWithGroup 标回 pending）
      // 第三轮口径：失败 = 全组耗尽（组内逐引擎降级吸收单引擎失败）；任一段耗尽失败 →
      // entry error（已译段保留）。无自动重试（原「重试 1 次」语义收编为组内逐引擎尝试）。
      if (batch.some((seg) => seg.status === 'failed')) {
        entry.status = 'error';
        emitTerminal(entry, 'error', entry.error);
        return;
      }
    }
    if (entry.segments.length > 0 && entry.segments.every((s) => s.status === 'done')) {
      entry.status = 'done';
      emitTerminal(entry, 'done');
    }
    // 流式 target：已定稿段全部译完但末段未定稿 → 维持 translating（等流式增长/迁移补齐）。
  } finally {
    entry.running = false;
  }
  // 排水后拾遗：排水期间并发 START 扩展了新定稿段（running 守卫吞掉了那次 runTranslation
  // 触发）→ 竞态补跑一轮（仅当确有可译段，天然有界不空转）。
  if (entry.status === 'translating') {
    const hasReady = entry.segments.some((s) => s.status === 'pending' && s.index < entry.settledUpto);
    if (hasReady) void runTranslation(entry);
  }
}

// ── 导出面（IPC 直转 + 会话删除清理钩子 + 一键探测） ──

/** START：立即返回（invoke 不携带长任务——译文增量走 TRANSLATION_EVENT 推送，规避 web 桥 60s
 *  超时）。幂等扩展语义：同 target 重复 START = 更新源文本续译（流式增长）/缓存全命中即完成
 *  （重开）。空文本/超长/未启用引擎 fail-fast 返回 {ok:false}，零 HTTP。 */
export async function startTranslation(
  sessionId: string,
  target: TranslationTarget,
  sourceText: string,
): Promise<TranslationStartResult> {
  if (!isValidTranslationTarget(target)) {
    return { ok: false, error: '无效的翻译目标' };
  }
  if (typeof sourceText !== 'string' || !sourceText.trim()) {
    return { ok: false, error: '消息没有可翻译的文本' };
  }
  const sources = segmentSourceText(sourceText);
  if (sources === null || sources.length === 0) {
    return { ok: false, error: '消息过长，暂不支持翻译（上限 10 万字符）' };
  }
  // 引擎组 fail-fast 在 entry 构建之前：未启用任何引擎一律拒绝（01 §5.7 边界表口径：零 HTTP）。
  const group = buildEngineGroup();
  if (group.engines.length === 0) {
    return { ok: false, error: '未启用任何翻译引擎，请在设置中启用' };
  }
  const key = targetKey(target);
  let entry = findEntryByTarget(sessionId, key);
  let newlyDone: Segment[] = [];
  if (!entry) {
    entry = {
      id: randomUUID(),
      sessionId,
      target,
      status: 'translating',
      sourceText,
      segments: [],
      settledUpto: 0,
      running: false,
      controllers: new Set(),
      engineId: undefined,
      stickyFailStreak: 0,
      group,
      pendingDelta: null,
      deltaTimer: null,
    };
    translations.set(entry.id, entry);
    let ids = bySession.get(sessionId);
    if (!ids) {
      ids = new Set();
      bySession.set(sessionId, ids);
    }
    ids.add(entry.id);
    newlyDone = fillSegments(entry, sources);
  } else {
    // 幂等扩展：更新源文本/目标载荷，重切段（同 hash 段身份保全，缓存命中直达）。
    // 引擎组仅在 entry 非 running 时重建（探测重排/配置变更不打断进行中 entry——01 §5.2.1）。
    entry.sourceText = sourceText;
    entry.target = target;
    if (!entry.running) entry.group = group;
    newlyDone = fillSegments(entry, sources);
    entry.error = undefined;
  }
  entry.status = 'translating';
  emitStarted(entry);
  for (const seg of newlyDone) {
    if (seg.translated !== null) pushDelta(entry, seg, seg.translated);
  }
  void runTranslation(entry);
  return { ok: true, translationId: entry.id };
}

/** STOP：收起译文 + abort 在飞段请求（缓存与已译段保留；再 START 从缓存续）。 */
export function stopTranslation(translationId: string): boolean {
  const entry = translations.get(translationId);
  if (!entry) return false;
  entry.status = 'stopped';
  entry.error = undefined;
  if (entry.deltaTimer !== null) {
    clearTimeout(entry.deltaTimer);
    entry.deltaTimer = null;
    entry.pendingDelta = null;
  }
  for (const controller of entry.controllers) controller.abort();
  emitTerminal(entry, 'stopped');
  return true;
}

/** RETRY：仅重译失败段（已完成段走缓存不重复请求）；重试 = 重新走组——粘性复位从优先序首位
 *  重选（02 P5-T7 口径），此时冷却/粘性已更新，常可落到健康引擎。非 error 态条目无重试面。 */
export function retryTranslation(translationId: string): boolean {
  const entry = translations.get(translationId);
  if (!entry || entry.status !== 'error') return false;
  for (const seg of entry.segments) {
    if (seg.status === 'failed') {
      seg.status = 'pending';
    }
  }
  entry.error = undefined;
  entry.engineId = undefined;
  entry.stickyFailStreak = 0;
  if (!entry.running) entry.group = buildEngineGroup();
  entry.status = 'translating';
  emitStarted(entry);
  void runTranslation(entry);
  return true;
}

/** GET_STATE：刷新/重连后重挂载（状态源在主进程，渲染层只是投影缓存）。 */
export function getTranslationStates(sessionId: string): TranslationStateView[] {
  const ids = bySession.get(sessionId);
  if (!ids) return [];
  const views: TranslationStateView[] = [];
  for (const id of ids) {
    const entry = translations.get(id);
    if (!entry) continue;
    const translated = entry.segments.filter(
      (s): s is Segment & { translated: string } => s.translated !== null,
    );
    views.push({
      translationId: entry.id,
      sessionId: entry.sessionId,
      target: entry.target,
      status: entry.status,
      segments: translated.map((s) => ({ index: s.index, translated: s.translated })),
      totalSegments: entry.segments.length,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    });
  }
  return views;
}

/** 最近一次探测结果缓存（评审 P2-2，2026-11-22 扩容批次 p8 并入）：probeEngines 全量探测后记录
 *  {at, results}；apply=true 且缓存新鲜（< PROBE_CACHE_TTL_MS）时直接按缓存落盘重排、不再全量
 *  重探——设置页「检查连通性 → 按结果应用」连击零重复请求。手动探测（apply=false）恒全量并刷新
 *  缓存；缓存过期/缺席照旧全量重探。零 IPC 变更（通道载荷与 appliedOrder 语义不变）。 */
const PROBE_CACHE_TTL_MS = 5 * 60_000;
let lastProbeResults: { at: number; results: TranslationProbeEngineResult[] } | null = null;

/** 探测结果 apply 落盘：ok 引擎按 latencyMs 升序重排 order、失败引擎保序殿后且不自动禁用，
 *  经 saveConfig 落盘（读路径 sanitize 兜底脏值）并返回 appliedOrder。 */
function applyProbeResults(results: TranslationProbeEngineResult[]): TranslationProbeResult {
  const translationConfig: TranslationConfig = getConfig().translation ?? {
    engines: DEFAULT_TRANSLATION_ENGINES.map((e) => ({ ...e })),
  };
  const okSorted = results.filter((r) => r.ok).sort((a, b) => a.latencyMs - b.latencyMs);
  const failed = results.filter((r) => !r.ok); // 保持原相对序殿后；不自动禁用
  const disabled = translationConfig.engines
    .filter((e) => !e.enabled)
    .map((e) => e.id);
  const finalOrder: string[] = [
    ...okSorted.map((r) => r.id),
    ...failed.map((r) => r.id),
    ...disabled,
  ];
  const engines = translationConfig.engines.map((e) => ({
    ...e,
    order: finalOrder.indexOf(e.id) >= 0 ? finalOrder.indexOf(e.id) : e.order,
  }));
  // P1-B 代理面回撤（p8/W4）：translation 节整体覆盖载荷仅含 engines——出站代理地址字段已删，
  // 无透传面（存量键经 sanitize 读路径剥离）。
  saveConfig({ translation: { engines } });
  return { ok: true, engines: results, appliedOrder: finalOrder };
}

/** 一键探测（01 §5.2.4；TRANSLATE_PROBE 通道接线属 p5b）：对启用引擎逐个串行发固定短测试文本；
 *  不建 translationId、不写段缓存；每引擎独立计时与 8s 超时；429 同样入冷却表；
 *  apply=true 时 ok 引擎按 latencyMs 升序重排 order、失败引擎保序殿后且不自动禁用，
 *  经 saveConfig 落盘并返回 appliedOrder（最近一次探测结果新鲜时直接复用，见 P2-2 缓存）。 */
export async function probeEngines(apply: boolean): Promise<TranslationProbeResult> {
  if (apply && lastProbeResults !== null && Date.now() - lastProbeResults.at < PROBE_CACHE_TTL_MS) {
    return applyProbeResults(lastProbeResults.results);
  }
  const group = buildEngineGroup();
  const results: TranslationProbeEngineResult[] = [];
  for (const engine of group.engines) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TRANSLATION_PROBE_TIMEOUT_MS);
    const startedAt = Date.now();
    let attempt: { ok: true; text: string } | { ok: false; error: string };
    try {
      const r = await engine.translate(TRANSLATION_PROBE_TEXT, ac.signal);
      attempt = r.ok ? r : { ok: false, error: r.error };
      if (!r.ok && r.kind === 'rate-limit') {
        engineCooldown.set(engine.kind, Date.now() + TRANSLATION_ENGINE_429_COOLDOWN_MS);
      }
    } catch (err) {
      attempt = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
    results.push({
      id: engine.id,
      kind: engine.kind,
      ok: attempt.ok,
      latencyMs: Date.now() - startedAt,
      ...(attempt.ok ? {} : { error: attempt.error }),
    });
  }
  // 不可用条目（评审 P2-7 休眠面：付费通道/模板引擎删除后零 reachable 来源，机械面保留）：
  // 零请求呈现失败行（不阻塞组）。
  for (const u of group.unavailable) {
    results.push({ id: u.id, kind: u.kind, ok: false, latencyMs: 0, error: u.error });
  }
  lastProbeResults = { at: Date.now(), results };
  if (!apply) return { ok: true, engines: results };
  return applyProbeResults(results);
}

/** 会话删除清理钩子（sdk-backend markSessionDeleted 清理族收口）：abort 在飞 + 三表该会话键全清。
 *  清理后的终态不推送（entry 已摘除，渲染层经 SESSIONS_CHANGED 链路自行回落原文态）。 */
export function clearSessionTranslations(sessionId: string): void {
  const ids = bySession.get(sessionId);
  if (ids) {
    for (const id of ids) {
      const entry = translations.get(id);
      if (!entry) continue;
      entry.status = 'stopped';
      if (entry.deltaTimer !== null) {
        clearTimeout(entry.deltaTimer);
        entry.deltaTimer = null;
        entry.pendingDelta = null;
      }
      for (const controller of entry.controllers) controller.abort();
      entry.controllers.clear();
      translations.delete(id);
    }
    bySession.delete(sessionId);
  }
  segmentCache.delete(sessionId);
}
