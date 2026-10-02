// safe-cut.ts — UTF-16 代理对安全切点（纯函数）。
// B12（D12-F1）：按 code unit 计数切分长文本（微信 4000 分段 / 飞书 100_000 入站截断）时，
// 切点可能落在星体字符（emoji/扩展汉字）的代理对中间，产生孤立高/低代理（JSON.stringify 出
// 未配对转义，iLink 可拒收整段、接收端乱码）。切点两侧恰为高/低代理时回退 1 个 code unit；
// 纯 ASCII/BMP 文本切点永不命中代理对，行为不变。

/**
 * 计算从 text[start,) 起取 want 个 code unit 的安全切宽：
 * 切点（start+want）前一单元是高代理且切点处是其低代理时回退 1，否则原样返回 want。
 * want ≤ 1、start < 0 或切点不在文本内部（start+want ≥ text.length）时不调整。
 */
export function safeCutWidth(text: string, start: number, want: number): number {
  if (want <= 1 || start < 0) return want;
  const end = start + want;
  if (end <= start || end >= text.length) return want;
  const prev = text.charCodeAt(end - 1);
  if (prev < 0xd800 || prev > 0xdbff) return want;
  const next = text.charCodeAt(end);
  return next >= 0xdc00 && next <= 0xdfff ? want - 1 : want;
}
