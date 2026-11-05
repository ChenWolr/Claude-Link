// text-decode.ts
// BOM 感知文本解码纯函数（计划 docs/plans/2026-11-05-turn-diff-quality-encoding-reconstruct-plan.md §2.1）。
// 无 Node API import，Buffer 为全局类型（shared 下 export-image.ts 同款用法，typecheck 三端均过）。
//
// 残留（计划 §1 否决清单，明确不转码）：无 BOM 的 UTF-16（按 binary 处理）、UTF-32（仅 BOM 识别
// 为 binary）、GBK/GB18030（无证据，不引编码探测依赖）。

export type TextBom = 'utf16le' | 'utf16be' | null;
export type TextDecodeResult =
  | { binary: true; bom: TextBom }
  | { binary: false; bom: TextBom; text: string };

/**
 * BOM 感知文本解码：
 * - UTF-32 BOM（FF FE 00 00 / 00 00 FE FF）→ binary（残留，极罕见）；
 * - FF FE → utf16le：剥 2 字节 BOM，剩余按偶数字节截齐（奇数尾字节丢弃，TextDecoder fatal=false
 *   同款宽容）后 toString('utf16le')；
 * - FE FF → utf16be：剥 BOM 后 copy 一份再 swap16（swap16 原地改，不得污染入参 Buffer）同 LE 解码；
 * - 其余 → toString('utf8')，含 \0 → binary（与既有 readFile utf-8 + includes('\0') 判定逐字节等价）；
 * - UTF-8 BOM（EF BB BF）→ 保留 \uFEFF 于 text 头（与现行为一致，不动）；
 * - 解码出的 text 含 '\0'（UTF-16 文件里真有 U+0000）→ binary；
 * - 空文件 / BOM-only → text:''。
 */
export function decodeTextBuffer(buf: Buffer): TextDecodeResult {
  // ① UTF-32 BOM 判定先于 UTF-16（FF FE 00 00 的前两字节与 UTF-16LE BOM 重叠，须先看 4 字节）。
  if (buf.length >= 4) {
    if (
      (buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0x00 && buf[3] === 0x00)
      || (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0xfe && buf[3] === 0xff)
    ) {
      return { binary: true, bom: null };
    }
  }
  // ② UTF-16LE BOM。
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    const body = buf.subarray(2);
    const even = body.length - (body.length % 2);
    const text = body.subarray(0, even).toString('utf16le');
    if (text.includes('\0')) return { binary: true, bom: 'utf16le' };
    return { binary: false, bom: 'utf16le', text };
  }
  // ③ UTF-16BE BOM：swap16 原地改，必须 copy（Buffer.from 复制字节）后再翻转，不污染入参。
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.subarray(2);
    const even = body.length - (body.length % 2);
    const swapped = Buffer.from(body.subarray(0, even));
    swapped.swap16();
    const text = swapped.toString('utf16le');
    if (text.includes('\0')) return { binary: true, bom: 'utf16be' };
    return { binary: false, bom: 'utf16be', text };
  }
  // ④ 无 BOM → utf-8 解码（含 UTF-8 BOM 保留 \uFEFF，与现行为一致）。
  const text = buf.toString('utf8');
  if (text.includes('\0')) return { binary: true, bom: null };
  return { binary: false, bom: null, text };
}
