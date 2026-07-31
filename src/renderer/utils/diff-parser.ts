// diff-parser.ts
// unified diff → 结构化分组的纯解析器（无 DOM / Vue 依赖，可被 tsx selftest 直接 import）。
//
// 视觉/行为真相源：prototypes/diff-viewer.html。渲染器（DiffBody）只消费这里输出的
// ParsedDiffFile，二者经数据契约解耦：解析器负责把 git unified diff 拆成
//   ctx 未改动 / mod 1:1 修改(词级 segs) / add 纯增 / del 纯删 / ws 仅空白
// 五类组，渲染器负责排版与中缝标记。
//
// 依赖 jsdiff：parsePatch 取 hunks（行号从 oldStart/newStart 起算）；词级差异由本地 LCS
// 引擎 diff-words.ts 提供（自写 Uint16Array DP + 三道护栏，比 jsdiff 的词级实现更贴合代码）。
//
// 不变量（渲染器依赖，selftest 钉死）：
//   - mod/ws 组恒为 1:1（L.length===1 && R.length===1）—— renderSplit 用 pad=max(L,R)，
//     mod 必须 pad=1 才能让中缝双三角对齐。不等长 M:N 退化为 del+add（牺牲词级，文档化）。
//   - ctx 组 L.length===R.length；L[i].n 是旧行号、R[i].n 是新行号（未改动段二者常相等，
//     但前置增删不等量时会错位，故分别取 oldN/newN）。
//   - add 组 L=[]、del 组 R=[]。
//   - 词级 segs：L 侧只 eq+del，R 侧只 eq+ins（同一次 diffWordsOrFlat 拆出）。

import { parsePatch } from 'diff';
import { diffWordsOrFlat } from './diff-words';

export type DiffSegKind = 'eq' | 'del' | 'ins';

export interface DiffSeg {
  s: DiffSegKind;
  x: string;
}

export type DiffGroupKind = 'ctx' | 'mod' | 'add' | 'del' | 'ws';

/**
 * Diff 行。**不可变契约**：DiffBody 用 v-memo 锁 line 对象 identity 来跳过重渲，
 * 故 line 一经产出不得就地修改 —— 改 t/segs 必须换新对象，否则 v-memo 不触发、DiffLine 静默不更新。
 */
export interface DiffLine {
  /** 旧行号（L 侧）/ 新行号（R 侧）；纯增的 L、纯删的 R 无意义但保留对应侧编号。 */
  n: number | null;
  /** 行原文（含前导空白）；空文本行渲染为单空格，避免 white-space:pre 下空 <code> 塌陷。 */
  t: string;
  /** 仅 mod/ws 组的行带词级 segs；ctx/add/del 用整行 t。 */
  segs?: DiffSeg[];
}

export interface DiffGroup {
  k: DiffGroupKind;
  L: DiffLine[];
  R: DiffLine[];
}

export interface ParsedDiffFile {
  path: string;
  groups: DiffGroup[];
  binary: boolean;
}

// git 二进制标记：整行 meta（无 +/- 前缀），文本 diff 内容行（如 +Binary files…）不会命中。
const BINARY_RE = /(?:^Binary files .+ differ$|^GIT binary patch$)/m;

// unified diff 文件头取路径：newFileName 形如 'b/src/x.ts'，删除文件时为 '/dev/null'。
// 去 a// b// 前缀还原仓库根相对路径；newFileName 缺失/为 /dev/null 时退回 oldFileName。
function extractPath(newFileName: string | undefined, oldFileName: string | undefined): string {
  let p = newFileName;
  if (!p || p === '/dev/null') p = oldFileName;
  if (!p || p === '/dev/null') return '';
  return p.replace(/^[ab]\//, '');
}

// 把等长的一对 del/add 行合成为 mod(或 ws) 组：词级 segs + 单行不变量。
// d=a 侧（旧行号）、a=b 侧（新行号）。
function makeModGroup(d: DiffLine, a: DiffLine): DiffGroup {
  // trim 后相等但原文不同 → 纯空白差异 → ws（渲染器用 mod 配色，标记色更暗）。
  const isWs = d.t.trim() === a.t.trim() && d.t !== a.t;
  // 词级差异走本地 LCS 引擎（diff-words.ts）：三道护栏命中时降级为整行单 eq 段——
  // segs 恒非空，避免 DiffLine 的 v-if="line.segs" 配空数组导致 <code> 塌陷。
  const { left: Lsegs, right: Rsegs } = diffWordsOrFlat(d.t, a.t);
  return {
    k: isWs ? 'ws' : 'mod',
    L: [{ n: d.n, t: d.t, segs: Lsegs }],
    R: [{ n: a.n, t: a.t, segs: Rsegs }],
  };
}

// 一段连续非 ctx 行（del+add run）→ 一到多个组。
//   只 del → del；只 add → add；
//   等长 M:M → M 个 mod/ws 组（逐对，保 1:1 不变量 + 词级）；
//   不等长 M:N → 退化成 del 组 + add 组（保序，该段牺牲词级，可接受）。
function classifyRun(dels: DiffLine[], adds: DiffLine[]): DiffGroup[] {
  if (dels.length && !adds.length) return [{ k: 'del', L: dels, R: [] }];
  if (!dels.length && adds.length) return [{ k: 'add', L: [], R: adds }];
  if (dels.length === adds.length) {
    const out: DiffGroup[] = [];
    for (let i = 0; i < dels.length; i++) out.push(makeModGroup(dels[i], adds[i]));
    return out;
  }
  return [{ k: 'del', L: dels, R: [] }, { k: 'add', L: [], R: adds }];
}

/**
 * 解析 unified diff 文本为结构化 ParsedDiffFile。
 * - 空输入 / 非 diff 文本 → null。
 * - 无 hunk 且含二进制标记 → { binary: true }（防御；生产路径已由 getChangeDiff 提前置 binary）。
 * - 多文件 patch 只取首个（changes 面板按单文件 diff 调用）。
 */
export function parseUnifiedDiff(text: string): ParsedDiffFile | null {
  if (!text || !text.trim()) return null;

  let patches: ReturnType<typeof parsePatch>;
  try {
    patches = parsePatch(text);
  } catch {
    return null; // 残缺输入：parsePatch 偶发抛错时降级为「无法解析」
  }
  if (!patches.length) {
    return BINARY_RE.test(text) ? { path: '', groups: [], binary: true } : null;
  }
  const head = patches[0];
  const filePath = extractPath(head.newFileName, head.oldFileName);
  if (!head.hunks || !head.hunks.length) {
    return BINARY_RE.test(text) ? { path: filePath, groups: [], binary: true } : null;
  }

  const groups: DiffGroup[] = [];
  for (const hunk of head.hunks) {
    // oldStart/newStart 是该 hunk 首行的旧行号/新行号（1-based，jsdiff 已解析）。
    let oldN = hunk.oldStart;
    let newN = hunk.newStart;
    let delRun: DiffLine[] = [];
    let addRun: DiffLine[] = [];
    let curCtx: { L: DiffLine[]; R: DiffLine[] } = { L: [], R: [] };

    const flushCtx = (): void => {
      if (curCtx.L.length) {
        groups.push({ k: 'ctx', L: curCtx.L, R: curCtx.R });
        curCtx = { L: [], R: [] };
      }
    };
    const flushRun = (): void => {
      if (!delRun.length && !addRun.length) return;
      flushCtx(); // run 前先收尾已攒的 ctx，保证 ctx → 改动段 的输出顺序
      for (const g of classifyRun(delRun, addRun)) groups.push(g);
      delRun = [];
      addRun = [];
    };

    for (const raw of hunk.lines) {
      const c = raw[0];
      if (c === '\\') continue; // 「\ No newline at end of file」标记，跳过不输出、不推进行号
      const t = raw.slice(1);
      if (c === ' ') {
        flushRun(); // 进入 ctx 前收尾上一段改动
        curCtx.L.push({ n: oldN, t });
        curCtx.R.push({ n: newN, t });
        oldN++;
        newN++;
      } else if (c === '-') {
        flushCtx(); // 进入改动段前收尾 ctx（连续 -/+ 同属一个 run，不再互相打断）
        delRun.push({ n: oldN, t });
        oldN++;
      } else if (c === '+') {
        flushCtx();
        addRun.push({ n: newN, t });
        newN++;
      }
      // 其它前缀（理论上不存在于标准 unified diff）忽略
    }
    flushRun();
    flushCtx();
  }

  return { path: filePath, groups, binary: false };
}
