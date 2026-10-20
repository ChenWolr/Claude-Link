// web-access-protocol.ts
// 「网页访问（局域网）」共享协议纯函数（docs/plans/2026-10-20-web-access-plan.md §3-P1）。
//
// 全部为纯函数且**零环境依赖**：不 import 任何 node:/electron 模块、不用宿主内置 Base64
// 快捷 API 与 Node 二进制/路径类型——主进程（HTTP 静态服务 + WS 编解码）、渲染层（web 桥
// 编解码）、selftest（tsx 直跑）三方共用的前提。该约束由
// scripts/selftest-web-access-protocol.ts 的静态断言钉住：断言按子串匹配四个禁用标识符与
// node:/electron 导入字面量，故**本文件任何行（含注释）都不得出现这些字面量**。
//
// 范围（P1 纯增量，不接线）：端口常量、WebAccessConfig 清洗、wire 值编解码（Uint8Array ⇄
// base64 信封）、Host 白名单判定、静态路径解析、静态 MIME 表。

import type { WebAccessConfig } from './types/config';

/** 网页访问默认端口（计划定案：8790，已核实全仓无占用）。 */
export const WEB_ACCESS_DEFAULT_PORT = 8790;

/** 二进制信封键：任何层级的 Uint8Array ⇄ { [WIRE_U8_KEY]: '<base64>' }（WS JSON 文本帧承载二进制的唯一形态）。 */
export const WIRE_U8_KEY = '__cl_u8';

/** allowedHosts 条目上限（超出截断，保留前 8 条去重后的结果）。 */
const ALLOWED_HOSTS_LIMIT = 8;

// ── base64（Uint8Array + 自写编码表循环实现，约 30 行，主进程与浏览器两端可用）────────

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i += 1) table[B64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const fullEnd = bytes.length - (bytes.length % 3);
  for (let i = 0; i < fullEnd; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      B64_ALPHABET[(n >>> 18) & 63] +
      B64_ALPHABET[(n >>> 12) & 63] +
      B64_ALPHABET[(n >>> 6) & 63] +
      B64_ALPHABET[n & 63];
  }
  const rem = bytes.length - fullEnd;
  if (rem === 1) {
    const n = bytes[fullEnd] << 16;
    out += B64_ALPHABET[(n >>> 18) & 63] + B64_ALPHABET[(n >>> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[fullEnd] << 16) | (bytes[fullEnd + 1] << 8);
    out +=
      B64_ALPHABET[(n >>> 18) & 63] +
      B64_ALPHABET[(n >>> 12) & 63] +
      B64_ALPHABET[(n >>> 6) & 63] +
      '=';
  }
  return out;
}

function base64ToBytes(text: string): Uint8Array {
  // 严格校验：长度为 4 的倍数、padding 最多 2 个且只在末尾、其余字符必须在编码表内。
  // 非法输入 fail-fast 抛错（调用方 P3 的 invoke 分发把异常归一为 error 响应，不崩进程）。
  if (text.length % 4 !== 0) throw new Error('wire: 非法 base64（长度非 4 的倍数）');
  let dataEnd = text.length;
  let padCount = 0;
  while (dataEnd > 0 && text[dataEnd - 1] === '=') {
    dataEnd -= 1;
    padCount += 1;
  }
  if (padCount > 2) throw new Error('wire: 非法 base64（padding 超限）');
  const out = new Uint8Array((text.length / 4) * 3 - padCount);
  let o = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < dataEnd; i += 1) {
    const code = text.charCodeAt(i);
    const v = code < 128 ? B64_LOOKUP[code] : -1;
    if (v < 0) throw new Error('wire: 非法 base64 字符');
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o] = (buffer >>> bits) & 0xff;
      o += 1;
    }
  }
  return out;
}

// ── wire 值编解码（深遍历；Uint8Array ⇄ { [WIRE_U8_KEY]: '<base64>' } 信封）────────
// 约定：① 信封是「含 WIRE_U8_KEY 字符串值的普通对象」，decode 遇到即按二进制还原（该键为
// 保留键，业务载荷不得使用）；② 非字符串值的 WIRE_U8_KEY 键不是信封，原样穿透（encode 也
// 永远不会产出该形态，往返对称）；③ 循环引用不在契约内（wire 载荷来自 JSON 文本帧 /
// structured-clone 兼容数据，天然无环）。

function isPlainRecord(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function encodeWireValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [WIRE_U8_KEY]: bytesToBase64(value) };
  }
  if (Array.isArray(value)) {
    return value.map((item) => encodeWireValue(item));
  }
  if (value !== null && typeof value === 'object' && isPlainRecord(value)) {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src)) {
      out[key] = encodeWireValue(src[key]);
    }
    return out;
  }
  // 原始值与其它宿主对象（Date/Map/Set 等，契约外）原样透传。
  return value;
}

export function decodeWireValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => decodeWireValue(item));
  }
  if (value !== null && typeof value === 'object' && isPlainRecord(value)) {
    const rec = value as Record<string, unknown>;
    const envelope = rec[WIRE_U8_KEY];
    if (typeof envelope === 'string') {
      return base64ToBytes(envelope);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec)) {
      out[key] = decodeWireValue(rec[key]);
    }
    return out;
  }
  return value;
}

// ── Host 白名单（防 DNS rebinding；HTTP 与 WS 升级共用）────────────────────────────

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4Literal(host: string): boolean {
  const m = IPV4_RE.exec(host);
  if (!m) return false;
  return m[1] !== undefined && Number(m[1]) <= 255 && Number(m[2]) <= 255 &&
    Number(m[3]) <= 255 && Number(m[4]) <= 255;
}

// 简化结构校验（足够拒绝「伪 IPv6 名字」与畸形 Host，不做 RFC 全量合法性）：
// 仅 hex 段与 ':'；'::' 至多一次且不连续三连；无压缩时恰好 8 段；压缩时两侧非空段合计 ≤ 7。
function isValidIpv6Literal(host: string): boolean {
  if (!host || !host.includes(':')) return false;
  if (!/^[0-9a-fA-F:]+$/.test(host)) return false;
  if (host.includes(':::')) return false;
  for (const g of host.split(':')) {
    if (g !== '' && !/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
  }
  const halves = host.split('::');
  if (halves.length > 2) return false;
  if (halves.length === 2) {
    const left = halves[0] === '' ? 0 : halves[0].split(':').length;
    const right = halves[1] === '' ? 0 : halves[1].split(':').length;
    return left + right <= 7;
  }
  return host.split(':').length === 8;
}

// 剥端口：IPv6 取 '[...]' 括号内（括号后只允许空串或 ':数字'）；其余取最后一个 ':' 且其后
// 必须是合法端口形态（1-5 位数字且 ≤65535）、且冒号前部分**不含冒号**才剥——含冒号的多段
// 形态是裸 IPv6（如 '::1'，Host 头裸 v6 不允许带端口）或畸形输入，不剥、整体交后续判定
//（否则会把 '::1' 误剥成 ':'、把 9 段畸形误判成合法 IPv6）。所有不匹配路径 fail-closed。
function stripHostPort(hostHeader: string): string | null {
  const trimmed = hostHeader.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close < 0) return null;
    const rest = trimmed.slice(close + 1);
    if (rest !== '' && !/^:\d{1,5}$/.test(rest)) return null;
    return trimmed.slice(1, close);
  }
  const lastColon = trimmed.lastIndexOf(':');
  if (
    lastColon > 0 &&
    !trimmed.slice(0, lastColon).includes(':') &&
    /^\d{1,5}$/.test(trimmed.slice(lastColon + 1)) &&
    Number(trimmed.slice(lastColon + 1)) <= 65535
  ) {
    return trimmed.slice(0, lastColon);
  }
  return trimmed;
}

/** Host 头是否放行：localhost / IPv4 字面量 / IPv6 字面量（可带端口、v6 取括号内）/ allowedHosts（小写化比对）。 */
export function isAllowedHost(hostHeader: string | undefined, allowedHosts: string[]): boolean {
  if (typeof hostHeader !== 'string') return false;
  const stripped = stripHostPort(hostHeader);
  if (!stripped) return false;
  const host = stripped.toLowerCase();
  if (host === 'localhost') return true;
  if (isIpv4Literal(host)) return true;
  if (isValidIpv6Literal(host)) return true;
  return (allowedHosts ?? []).some(
    (entry) => String(entry ?? '').trim().toLowerCase() === host,
  );
}

// ── 静态资源：扩展名白名单 / MIME 表 / 路径解析 ──────────────────────────────────
// 放行扩展名单一真相源 = STATIC_MIME 键集（新增扩展名只改这张表）。

export const STATIC_MIME: Record<string, string> = {
  html: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  map: 'application/json',
  json: 'application/json',
  txt: 'text/plain',
};

const ALLOWED_EXTENSIONS = new Set(Object.keys(STATIC_MIME));

/**
 * 把 URL 路径解析为 rootDir 内的静态文件路径；任何不可信形态一律返回 null（调用方 404）。
 * 安全序：decodeURIComponent（单层）→ 拒 NUL / 反斜杠 / '..' 完整段 → 白名单扩展名 →
 * 按 rootDir 分隔符风格拼接。'..' 段被整段拒绝 + 不接受相对路径 ⇒ 归一结果恒在 rootDir 内。
 * Windows 语义：rootDir 含 '\\'（win 原生路径）时结果用 '\\' 拼接；纯正斜杠 win 路径按
 * posix 拼接（Node fs 在 Windows 两样都认）。
 */
export function resolveStaticPath(rootDir: string, urlPath: string): string | null {
  if (typeof rootDir !== 'string' || !rootDir) return null;
  if (typeof urlPath !== 'string' || !urlPath) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // 非法百分号编码（如 %zz）
  }
  if (decoded.includes('\0')) return null;
  if (decoded.includes('\\')) return null;
  if (!decoded.startsWith('/')) return null;
  const relParts: string[] = [];
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null; // 上级段一律拒绝（%2e%2e 解码后同样落此分支）
    relParts.push(seg);
  }
  if (relParts.length === 0) relParts.push('index.html'); // '/' → <root>/index.html
  const fileName = relParts[relParts.length - 1];
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return null; // 无扩展名
  if (!ALLOWED_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase())) return null; // 白名单外
  const sep = rootDir.includes('\\') ? '\\' : '/';
  let root = rootDir;
  while (root.length > 1 && (root.endsWith('/') || root.endsWith('\\'))) root = root.slice(0, -1);
  const rel = relParts.join(sep);
  return root === '/' ? '/' + rel : root + sep + rel;
}

// ── WebAccessConfig 清洗（读路径兜底；写路径不清洗，同 mcpServers 先例）──────────────

/**
 * 脏值清洗：enabled 取布尔真值；port 仅收「有限整数 ∈ [1024, 65535]」，否则回落
 * WEB_ACCESS_DEFAULT_PORT；allowedHosts 逐项 String().trim() → 剔空串 → 小写化 → 去重
 * （大小写不敏感）→ 上限 8 条截断。raw 为 null/undefined/非对象时返回全默认值，不抛错。
 */
export function sanitizeWebAccessConfig(raw: unknown): WebAccessConfig {
  const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const enabled = Boolean(obj?.enabled);
  const rawPort = obj?.port;
  const port =
    typeof rawPort === 'number' &&
    Number.isInteger(rawPort) &&
    rawPort >= 1024 &&
    rawPort <= 65535
      ? rawPort
      : WEB_ACCESS_DEFAULT_PORT;
  const allowedHosts: string[] = [];
  const rawHosts = obj?.allowedHosts;
  if (Array.isArray(rawHosts)) {
    for (const item of rawHosts) {
      const host = String(item ?? '').trim().toLowerCase();
      if (!host || allowedHosts.includes(host)) continue;
      if (allowedHosts.length >= ALLOWED_HOSTS_LIMIT) break;
      allowedHosts.push(host);
    }
  }
  return { enabled, port, allowedHosts };
}
