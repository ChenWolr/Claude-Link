// use-translation-display.ts
// 翻译译文的渲染层独立节流（P5 渲染层，2026-11-19 UI 五点批次）。01 §5.4②：
// **独立节流 ref，不共用 displayContent**——模块级 Map<translationId, throttle>，工厂 =
// use-stream 的 makeThrottle（50ms 同口径）；entry.segments 按 index 排序 join('\n\n') 经节流
// 写入 displayTranslation: Ref<string>。正文与思考各自实例化本 composable（同一工厂、各自
// ref——互不串流）；节流频率与主进程 80ms 合帧叠加为双层（01 §5.5）。
//
// 除节流后的拼接全文（displayTranslation）外，同时给出段级快照 blocks（同一次节流内派生）：
// 「本次新增的已译段」为渐显单位需要按段渲染（TranslationViewport / ThinkingBlock 的
// .fade-seg 以段为 key 挂载即动画），拼接串无法承载段身份。blocks 与 displayTranslation
// 出自同一节流写入，二者恒一致。
import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { makeThrottle } from './use-stream';
import { useTranslationStore } from '../stores/translation-store';

/** 段级渲染快照：key = `${translationId}:${index}`（段身份——新段挂载即 fadeIn，已译段就地
 *  更新文本不重放动画）；text = 段译文（未译段缺席）。 */
export interface TranslationDisplayBlock {
  key: string;
  index: number;
  text: string;
}

interface TranslationSnapshot {
  text: string;
  blocks: TranslationDisplayBlock[];
}

const EMPTY_SNAPSHOT: TranslationSnapshot = { text: '', blocks: [] };

/** 模块级节流表（按 translationId 复用；translationId 数量有界——每会话至多 4 个 target）。 */
const throttles = new Map<string, (v: string) => void>();

/**
 * 取某 translationId 的节流显示态。入参为 translationId 的响应式源（Ref/computed，可为
 * undefined——视口未绑定条目时清空显示）。
 */
export function useTranslationDisplay(translationId: Ref<string | undefined>): {
  displayTranslation: Ref<string>;
  blocks: Ref<TranslationDisplayBlock[]>;
} {
  const store = useTranslationStore();
  const displayTranslation = ref('');
  const blocks = ref<TranslationDisplayBlock[]>([]);

  // 本实例创建过的节流器（tid → throttle 引用）。模块级 Map 条目的寿命 = 消费实例寿命：
  // 实例卸载时按创建记录回收——否则视口重挂载（v-if/v-else-if 卸载→重建）会复用绑定「死实例
  // 闭包」的旧节流器，迟到帧全部写进死实例 refs、新视口 blocks 恒空（P5-T21/T9 回归根因）。
  // identity 复核防误删后来实例的同名条目（同一 tid 同时至多一个视口，v-if 互斥；此处只防御）。
  const owned = new Map<string, (v: string) => void>();

  function throttleFor(tid: string): (v: string) => void {
    const existing = throttles.get(tid);
    if (existing) return existing;
    const throttle = makeThrottle((v: string) => {
      // translationId 已切换/卸载后的迟到帧：丢弃，不串写新目标（互不串流守卫）。
      if (translationId.value !== tid) return;
      let snap: TranslationSnapshot;
      try {
        snap = JSON.parse(v) as TranslationSnapshot;
      } catch {
        return;
      }
      displayTranslation.value = snap.text;
      blocks.value = snap.blocks;
    });
    throttles.set(tid, throttle);
    owned.set(tid, throttle);
    return throttle;
  }

  onScopeDispose(() => {
    for (const [tid, throttle] of owned) {
      if (throttles.get(tid) === throttle) throttles.delete(tid);
    }
    owned.clear();
  });

  // 段快照（未节流——节流写入发生在 watch 侧）：已译段按 index 排序，translated null 滤除。
  const snapshot = computed<TranslationSnapshot>(() => {
    const entry = translationId.value ? store.byId[translationId.value] : undefined;
    if (!entry) return EMPTY_SNAPSHOT;
    const segments = [...entry.segments].sort((a, b) => a.index - b.index);
    const out: TranslationDisplayBlock[] = [];
    const texts: string[] = [];
    for (const seg of segments) {
      const text = seg.translated;
      if (text === null || text === '') continue;
      texts.push(text);
      out.push({ key: `${entry.translationId}:${seg.index}`, index: seg.index, text });
    }
    return { text: texts.join('\n\n'), blocks: out };
  });

  // 快照 → JSON 串作为节流载荷（同一节流帧内 text/blocks 恒一致；JSON 开销：段≤1200 字符、
  // 50ms 一帧，量级与 use-stream 上屏同档）。
  watch(
    () => JSON.stringify(snapshot.value),
    (json) => {
      const tid = translationId.value;
      if (!tid) {
        displayTranslation.value = '';
        blocks.value = [];
        return;
      }
      throttleFor(tid)(json);
    },
    { immediate: true },
  );

  return { displayTranslation, blocks };
}
