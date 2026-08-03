import type { DiffLine, ParsedDiffFile } from './diff-parser';

export type DiffSearchSide = 'left' | 'right' | 'both';

export interface DiffSearchMatch {
  id: string;
  side: DiffSearchSide;
  oldLine: number | null;
  newLine: number | null;
  lineKey: string;
  start: number;
  end: number;
  occurrence: number;
}

export interface DiffSearchRange {
  matchId: string;
  start: number;
  end: number;
}

export interface DiffSearchLineIndex {
  left: Map<string, DiffSearchRange[]>;
  right: Map<string, DiffSearchRange[]>;
}

export interface SearchableToken {
  text: string;
  cls: string;
  diff: 'eq' | 'del' | 'ins';
}

export interface SearchMarkedToken extends SearchableToken {
  matchId?: string;
  current?: boolean;
}

export function applySearchRanges(
  tokens: SearchableToken[],
  ranges: DiffSearchRange[],
  currentMatchId: string | null,
): SearchMarkedToken[] {
  if (ranges.length === 0) return tokens;

  const textLength = tokens.reduce((length, token) => length + token.text.length, 0);
  const normalizedRanges = ranges
    .map((range) => ({
      ...range,
      start: Math.max(0, Math.min(textLength, range.start)),
      end: Math.max(0, Math.min(textLength, range.end)),
    }))
    .filter((range) => range.start < range.end)
    .sort((a, b) => a.start - b.start);
  if (normalizedRanges.length === 0) return tokens;

  const marked: SearchMarkedToken[] = [];
  let tokenStart = 0;
  let rangeIndex = 0;
  for (const token of tokens) {
    const tokenEnd = tokenStart + token.text.length;
    if (token.text.length === 0) {
      marked.push(token);
      continue;
    }

    let position = tokenStart;
    while (position < tokenEnd) {
      while (rangeIndex < normalizedRanges.length && normalizedRanges[rangeIndex]!.end <= position) {
        rangeIndex++;
      }
      const range = normalizedRanges[rangeIndex];
      if (!range || range.start >= tokenEnd) {
        marked.push({ ...token, text: token.text.slice(position - tokenStart) });
        break;
      }
      if (range.start > position) {
        const end = Math.min(tokenEnd, range.start);
        marked.push({ ...token, text: token.text.slice(position - tokenStart, end - tokenStart) });
        position = end;
        continue;
      }
      const end = Math.min(tokenEnd, range.end);
      marked.push({
        ...token,
        text: token.text.slice(position - tokenStart, end - tokenStart),
        matchId: range.matchId,
        current: range.matchId === currentMatchId,
      });
      position = end;
    }
    tokenStart = tokenEnd;
  }
  return marked;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendLineMatches(
  matches: DiffSearchMatch[],
  line: DiffLine,
  query: string,
  side: DiffSearchSide,
  oldLine: number | null,
  newLine: number | null,
  lineKey: string,
): void {
  const pattern = new RegExp(escapeRegExp(query), 'giu');
  let occurrence = 0;
  for (const match of line.t.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    matches.push({
      id: `${lineKey}:${side}:${start}:${end}:${occurrence}`,
      side,
      oldLine,
      newLine,
      lineKey,
      start,
      end,
      occurrence,
    });
    occurrence++;
  }
}

export function buildDiffSearchMatches(file: ParsedDiffFile | null, query: string): DiffSearchMatch[] {
  if (!file || query === '') return [];

  const matches: DiffSearchMatch[] = [];
  file.groups.forEach((group, groupIndex) => {
    if (group.k === 'skip') return;

    const lineCount = Math.max(group.L.length, group.R.length);
    for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
      const left = group.L[lineIndex];
      const right = group.R[lineIndex];
      const lineKey = `${groupIndex}:${lineIndex}`;

      if (group.k === 'ctx') {
        const line = right ?? left;
        if (line) {
          appendLineMatches(matches, line, query, 'both', left?.n ?? null, right?.n ?? null, lineKey);
        }
      } else if (group.k === 'add') {
        if (right) appendLineMatches(matches, right, query, 'right', null, right.n, lineKey);
      } else if (group.k === 'del') {
        if (left) appendLineMatches(matches, left, query, 'left', left.n, null, lineKey);
      } else {
        if (left) appendLineMatches(matches, left, query, 'left', left.n, right?.n ?? null, lineKey);
        if (right) appendLineMatches(matches, right, query, 'right', left?.n ?? null, right.n, lineKey);
      }
    }
  });
  return matches;
}

export function groupSearchMatchesByLine(matches: DiffSearchMatch[]): DiffSearchLineIndex {
  const index: DiffSearchLineIndex = { left: new Map(), right: new Map() };
  for (const match of matches) {
    const range = { matchId: match.id, start: match.start, end: match.end };
    if ((match.side === 'left' || match.side === 'both') && match.oldLine != null) {
      const key = `old:${match.oldLine}`;
      const ranges = index.left.get(key) ?? [];
      ranges.push(range);
      index.left.set(key, ranges);
    }
    if ((match.side === 'right' || match.side === 'both') && match.newLine != null) {
      const key = `new:${match.newLine}`;
      const ranges = index.right.get(key) ?? [];
      ranges.push(range);
      index.right.set(key, ranges);
    }
  }
  return index;
}

export function moveSearchIndex(current: number, delta: number, total: number): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return delta < 0 ? total - 1 : 0;
  return ((current + delta) % total + total) % total;
}
