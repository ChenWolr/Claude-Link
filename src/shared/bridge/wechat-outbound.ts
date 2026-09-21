// wechat-outbound.ts — 微信出站长文本分段（纯函数）。
// 移植自 openhanako (Apache-2.0) lib/bridge/wechat-adapter.ts:54,613-617 的 MSG_CHUNK_LIMIT
// 分段循环，抽出为纯函数；分段策略：从左到右贪心，每段 ≤4000 字，段内含换行时优先回退到
// 段内最后一个 '\n'（把换行留在段尾，下一段从行首开始）；单行超限（无换行可回退）按 4000 硬切。
// 不做 block 流式——iLink 对连续发消息有速率限制，batch 一次性分段发完更稳（openhanako :627 注释）。

export const WECHAT_MSG_CHUNK_LIMIT = 4000;

/**
 * 把长文本切成每段 ≤ WECHAT_MSG_CHUNK_LIMIT 的分段。
 * 空串返回 []（调用方据此不发任何消息）。
 */
export function splitWechatText(text: string): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const raw = text.slice(i, i + WECHAT_MSG_CHUNK_LIMIT);
    if (raw.length < WECHAT_MSG_CHUNK_LIMIT) {
      chunks.push(raw);
      break;
    }
    // 满段：优先回退到段内最后一个换行（含换行符留在本段尾部，下一段从行首开始）。
    const lastNewline = raw.lastIndexOf('\n');
    const cut = lastNewline > 0 ? lastNewline + 1 : WECHAT_MSG_CHUNK_LIMIT;
    chunks.push(text.slice(i, i + cut));
    i += cut;
  }
  return chunks;
}
