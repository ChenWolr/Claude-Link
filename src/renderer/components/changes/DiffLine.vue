<script setup lang="ts">
// DiffLine —— 单行渲染。
// split 变体：行号(sticky 左) + code（contrast 风格：行号回各 pane 左侧，背景色区分增删，无 +/- sign）。
// inline 变体：行号(sticky 左) + 符号(+/-/~) + code（cc-haha 风格）。
// 行内容静态（line 对象 identity 不变即不重渲），DiffBody 用 v-memo 跳过 curChange 等外层状态变化（大 diff 性能）。
// 词级 segs 与整行文本两种模式，空行/空段渲染单空格（white-space:pre 下空 <code> 会塌陷）。
// null 占位侧由 DiffBody 直接渲染 .line--placeholder，不走本组件（保留「行内容静态」契约）。
import { computed } from 'vue';
import type { DiffLine as ParsedDiffLine } from '../../utils/diff-parser';
import { highlightLineToTokens, mergeTokensWithDiff, type MergedToken } from '../../utils/diff-highlight';
import {
  applySearchRanges,
  type DiffSearchRange,
  type SearchableToken,
} from '../../utils/diff-search';

const props = defineProps<{
  line: ParsedDiffLine;
  /** ctx / add / del / modl / modr / ws */
  kind: string;
  variant: 'split' | 'inline';
  /** split 用：左右栏标记（配色微调保留） */
  side?: 'left' | 'right';
  /** split 语法高亮用：hljs language，由 DiffBody 按扩展名推断下传 */
  language?: string;
  searchRanges?: DiffSearchRange[];
  currentSearchMatchId?: string | null;
}>();

// white-space:pre 下空 <code> 会塌陷成 0 高度 → 空行/空段一律渲染单空格保高。
function space(x: string): string {
  return x === '' ? ' ' : x;
}
const sign = computed(() =>
  props.kind === 'add' ? '+' : props.kind === 'del' ? '−' : props.kind === 'modl' || props.kind === 'modr' || props.kind === 'ws' ? '~' : '',
);

// split + 有 language → 语法高亮（与词级 diff 叠加）；否则用原整行/segs 渲染。
// 字符级叠加：语法 token × 该行词级 segs（mod/modl/modr 行有 segs；add/del 无 segs → 全 eq，
// 仅靠行背景色 + 语法色，符合预期）。mod 行 segs → 字符级 wd-del/wd-ins 叠加在语法色上。
const baseTokens = computed<SearchableToken[]>(() => {
  if (props.variant === 'split' && props.language) {
    const tokens = highlightLineToTokens(props.line.t, props.language);
    return mergeTokensWithDiff(tokens, props.line.segs);
  }
  if (props.line.segs) {
    return props.line.segs.map<MergedToken>((seg) => ({ text: seg.x, cls: '', diff: seg.s }));
  }
  return [{ text: props.line.t, cls: '', diff: 'eq' }];
});

const renderedTokens = computed(() =>
  applySearchRanges(baseTokens.value, props.searchRanges ?? [], props.currentSearchMatchId ?? null),
);
</script>

<template>
  <div :class="['line', `line--${kind}`]">
    <span class="ln">{{ line.n ?? '' }}</span>
    <span v-if="variant === 'inline'" class="sign">{{ sign }}</span>
    <code>
      <span
        v-for="(tok, i) in renderedTokens"
        :key="i"
        :class="[
          tok.cls,
          {
            'wd wd-del': tok.diff === 'del',
            'wd wd-ins': tok.diff === 'ins',
            'search-hit': tok.matchId,
            'search-hit--current': tok.current,
          },
        ]"
        :data-search-match="tok.matchId"
      >{{ space(tok.text) }}</span>
    </code>
  </div>
</template>

<style scoped>
.line {
  display: flex;
  align-items: stretch;
  width: 100%;
  height: var(--diff-line-h);
  line-height: var(--diff-line-h);
  font-family: var(--font-mono);
  font-size: var(--diff-font);
  white-space: pre;
}
.line .ln {
  flex: 0 0 46px;
  min-width: 46px;
  padding: 0 8px;
  text-align: right;
  color: var(--color-text-muted);
  opacity: 0.75;
  user-select: none;
  font-size: 11px;
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--color-panel-soft);
}
.line .sign {
  flex: 0 0 18px;
  text-align: center;
  user-select: none;
  opacity: 0.55;
}
.line code {
  flex: 0 0 auto;
  padding: 0 14px 0 6px;
  color: var(--color-text);
}

/* 三档色：行 bg（最浅） < gutter（行号槽） < word（词级，最深） */
.line--add { background: var(--add-bg); }
.line--add .ln { background: var(--add-gutter); color: var(--add-text); opacity: 1; }
.line--add .sign { color: var(--add-text); opacity: 1; }

.line--del { background: var(--del-bg); }
.line--del .ln { background: var(--del-gutter); color: var(--del-text); opacity: 1; }
.line--del .sign { color: var(--del-text); opacity: 1; }

.line--modl { background: var(--del-bg); }
.line--modl .ln { background: var(--del-gutter); color: var(--del-text); opacity: 1; }
.line--modl .sign { color: var(--del-text); opacity: 0.9; }

.line--modr { background: var(--add-bg); }
.line--modr .ln { background: var(--add-gutter); color: var(--add-text); opacity: 1; }
.line--modr .sign { color: var(--add-text); opacity: 0.9; }

.line--ws { background: var(--mod-bg); }
.line--ws .sign { color: var(--mod-edge); opacity: 0.9; }

/* 词级内联高亮（最深 word 档） */
.wd { border-radius: 3px; padding: 1px 0; }
.wd-del {
  background: var(--del-word);
  color: var(--del-text);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--color-danger) 55%, transparent);
}
.wd-ins {
  background: var(--add-word);
  color: var(--add-text);
  font-weight: 600;
}

.search-hit {
  background: color-mix(in srgb, var(--color-warn) 28%, transparent);
}
.search-hit--current {
  background: color-mix(in srgb, var(--color-warn) 52%, transparent);
  outline: 1px solid var(--color-warn-strong);
  outline-offset: -1px;
}
</style>
