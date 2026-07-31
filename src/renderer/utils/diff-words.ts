// diff-words.ts
// 词级 diff 引擎（移植自 cc-haha workspaceDiffHighlighter.ts 的 diffWordRanges）。
// 纯函数、无 Vue/DOM 依赖，可被 tsx selftest 直接 import。
//
// 给一对「旧行文本 / 新行文本」，产出两侧词级分段（L 侧只 eq+del，R 侧只 eq+ins），
// 与 diff-parser 的 DiffSeg 契约一致。三道护栏命中时 diffWordRanges 返回 null；
// diffWordsOrFlat 降级为整行单 eq 段（无词级高亮、仅行背景色），segs 恒非空——
// 避免 DiffLine 的 v-if="line.segs" 配空数组导致 <code> 塌陷。
//
// 算法：分词正则（空白/标识符/符号三类）→ LCS 动态规划（Uint16Array 反向填表）→
//       回溯标记匹配段 → 未匹配段标 del/ins。
// 三道护栏（任一命中放弃词级，宁可整行纯背景也别高亮错）：
//   - 单行 > DIFF_WORD_MAX_LINE_LENGTH 字符（防 Uint16Array 在超长行爆内存）
//   - 单行分段 > DIFF_WORD_MAX_SEGMENTS
//   - 相似度 < DIFF_WORD_MIN_SIMILARITY（公式 2*matched/(old+new)，仅计非空白段）

import type { DiffSeg } from './diff-parser';

export const DIFF_WORD_MAX_LINE_LENGTH = 1000;
export const DIFF_WORD_MAX_SEGMENTS = 240;
export const DIFF_WORD_MIN_SIMILARITY = 0.6;

export interface DiffWordResult {
  /** 重组回 oldText；只含 eq + del */
  left: DiffSeg[];
  /** 重组回 newText；只含 eq + ins */
  right: DiffSeg[];
}

// 分词：空白 / 标识符([\p{L}\p{N}_$]+) / 符号 三类（与 cc-haha 一致，比 jsdiff 贴合代码——把符号单独切出）。
const TOKEN_RE = /\s+|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]+/gu;

interface WordToken {
  text: string;
  ws: boolean; // 是否纯空白段（空白段恒 eq，不参与词级高亮，仅用于重建原文）
}

function tokenize(text: string): WordToken[] {
  const out: WordToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text))) {
    const t = m[0];
    out.push({ text: t, ws: /\s/.test(t[0]) });
  }
  return out;
}

// LCS DP：Uint16Array 反向填表（省内存），回溯标 matchedOld/matchedNew。
function lcsMatches(oldToks: WordToken[], newToks: WordToken[]): [Set<number>, Set<number>] {
  const n = oldToks.length;
  const m = newToks.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        oldToks[i]!.text === newToks[j]!.text
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const matchedOld = new Set<number>();
  const matchedNew = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldToks[i]!.text === newToks[j]!.text) {
      matchedOld.add(i);
      matchedNew.add(j);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return [matchedOld, matchedNew];
}

// segs 输出：合并相邻同类段防碎片；空白段恒 eq。
function emitSegs(toks: WordToken[], matched: Set<number>, changed: 'del' | 'ins'): DiffSeg[] {
  const out: DiffSeg[] = [];
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k]!;
    const kind: DiffSeg['s'] = tok.ws || matched.has(k) ? 'eq' : changed;
    const last = out[out.length - 1];
    if (last && last.s === kind) last.x += tok.text;
    else out.push({ s: kind, x: tok.text });
  }
  return out;
}

/**
 * 词级 diff：返回 {left:eq+del, right:eq+ins}；三道护栏命中或无意义时返回 null。
 * left 重组回 oldText、right 重组回 newText。
 */
export function diffWordRanges(oldText: string, newText: string): DiffWordResult | null {
  // 完全相同 → 无差异，返回 null（diffWordsOrFlat 降级为整行单 eq，渲染无词级高亮）
  if (oldText === newText) return null;
  // 护栏 1：单行字符上限
  if (oldText.length > DIFF_WORD_MAX_LINE_LENGTH || newText.length > DIFF_WORD_MAX_LINE_LENGTH) return null;
  const oldToks = tokenize(oldText);
  const newToks = tokenize(newText);
  // 护栏 2：段数上限
  if (oldToks.length > DIFF_WORD_MAX_SEGMENTS || newToks.length > DIFF_WORD_MAX_SEGMENTS) return null;

  const [matchedOld, matchedNew] = lcsMatches(oldToks, newToks);

  // 护栏 3：相似度（仅计非空白段）
  const oldMeaningful = oldToks.reduce((a, t) => a + (t.ws ? 0 : 1), 0);
  const newMeaningful = newToks.reduce((a, t) => a + (t.ws ? 0 : 1), 0);
  const matchedMeaningful = [...matchedOld].filter((k) => !oldToks[k]!.ws).length;
  const denom = oldMeaningful + newMeaningful;
  const sim = denom === 0 ? 1 : (2 * matchedMeaningful) / denom;
  if (sim < DIFF_WORD_MIN_SIMILARITY) return null;

  return { left: emitSegs(oldToks, matchedOld, 'del'), right: emitSegs(newToks, matchedNew, 'ins') };
}

/**
 * 带降级的便捷入口：护栏命中 → 整行单 eq 段（无词级高亮、仅行背景色）。
 * 永不返回 null，segs 恒非空（调用方无需判空，且避免空数组导致渲染塌陷）。
 */
export function diffWordsOrFlat(oldText: string, newText: string): DiffWordResult {
  return (
    diffWordRanges(oldText, newText) ?? {
      left: [{ s: 'eq', x: oldText }],
      right: [{ s: 'eq', x: newText }],
    }
  );
}
