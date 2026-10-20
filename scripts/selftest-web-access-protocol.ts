// selftest-web-access-protocol.ts
// 「网页访问（局域网）」P1 契约钉：共享协议纯函数（src/shared/web-access-protocol.ts）。
//
// 覆盖（docs/plans/2026-10-20-web-access-plan.md §3-P1-5 全部用例）：
//   - codec：嵌套对象/数组内 Uint8Array 往返逐字节相等、普通 JSON 值原样、空 Uint8Array、
//     4KiB 随机字节、信封形态与非字符串键穿透、非法 base64 拒绝；
//   - isAllowedHost：localhost / localhost:8790 / 127.0.0.1 / 192.168.1.5:8790 / [::1]:8790
//     通过；evil.example.com 拒；allowedHosts 命中（含大写 Host 混写）通过；Host 缺省拒；
//   - sanitizeWebAccessConfig：端口 80/70000/'abc'/undefined → 8790；1024/65535 边界保留；
//     allowedHosts 空串剔除/去重/小写化/超 8 条截断；null/undefined/非对象输入不崩；
//   - resolveStaticPath：'/' → index.html、/assets/a.js 命中、/../main/index.js、/..%2f..%2f、
//     /\、/etc/passwd、/a.exe → null；win/posix rootDir 归一拼接均正确；
//   - STATIC_MIME：白名单扩展名→MIME 逐项 + 放行扩展名键集与 STATIC_MIME 一致；
//   - 静态断言：共享文件禁宿主内置 Base64 API 与 Node 二进制类型、零 node:/electron 依赖
//     （主进程/渲染层/selftest 三方共用的前提）。
//
// 运行：npx tsx scripts/selftest-web-access-protocol.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as assert from 'node:assert';
import {
  WEB_ACCESS_DEFAULT_PORT,
  WIRE_U8_KEY,
  STATIC_MIME,
  sanitizeWebAccessConfig,
  encodeWireValue,
  decodeWireValue,
  isAllowedHost,
  resolveStaticPath,
} from '../src/shared/web-access-protocol';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  check(name, ok, ok ? '' : `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function main(): void {
  // ── A 组：wire codec 往返 ────────────────────────────────────────────
  console.log('\n[A] encodeWireValue / decodeWireValue');

  const nested = {
    a: 1,
    list: ['x', { bin: new Uint8Array([1, 2, 3]) }],
    deep: { arr: [new Uint8Array([9, 8, 7, 6]), null] },
  };
  const encNested = encodeWireValue(nested) as Record<string, unknown>;
  const encListBin = (encNested.list as Array<Record<string, unknown>>)[1].bin as Record<string, string>;
  const encDeepArr = (encNested.deep as Record<string, unknown>).arr as Array<unknown>;
  eq('encode：嵌套 Uint8Array → 信封 base64（[1,2,3]→AQID）', encListBin[WIRE_U8_KEY], 'AQID');
  eq('encode：深层 Uint8Array → 信封 base64（[9,8,7,6]→CQgHBg==，Node 权威值）',
    (encDeepArr[0] as Record<string, string>)[WIRE_U8_KEY], 'CQgHBg==');
  check('encode 输出无残留 Uint8Array（JSON-safe）',
    !JSON.stringify(encNested).includes('Uint8Array') && JSON.stringify(encNested).length > 0);
  assert.deepStrictEqual(decodeWireValue(encNested), nested);
  check('decode(encode(嵌套)) 逐字节相等', true);

  const plainJson = { n: 1, s: 'x', b: false, nil: null, arr: [1, 'a', true, { k: 'v' }], deep: { z: 0 } };
  assert.deepStrictEqual(decodeWireValue(encodeWireValue(plainJson)), plainJson);
  check('普通 JSON 值原样（深相等）', true);

  const encEmpty = encodeWireValue(new Uint8Array(0)) as Record<string, string>;
  eq('encode：空 Uint8Array → 空串信封', encEmpty[WIRE_U8_KEY], '');
  assert.deepStrictEqual(decodeWireValue(encEmpty), new Uint8Array(0));
  check('空 Uint8Array 往返（length 0）', true);

  const big = new Uint8Array(randomBytes(4096));
  const bigRt = decodeWireValue(encodeWireValue(big));
  check('4KiB 随机字节往返逐字节相等', bigRt instanceof Uint8Array && bytesEqual(big, bigRt as Uint8Array));

  const ascii = new Uint8Array([104, 105]);
  eq("encode：[104,105]（'hi'）→ aGk=", (encodeWireValue(ascii) as Record<string, string>)[WIRE_U8_KEY], 'aGk=');

  const nonStringSentinel = { [WIRE_U8_KEY]: 5 };
  assert.deepStrictEqual(decodeWireValue(nonStringSentinel), nonStringSentinel);
  check('decode：__cl_u8 非字符串不视为信封（原样穿透）', true);

  check('decode：非法 base64 信封抛错（fail fast）',
    throws(() => decodeWireValue({ [WIRE_U8_KEY]: 'not*base64!' })));
  check('decode：错误 padding（' + WIRE_U8_KEY + ":'QQ==='）抛错",
    throws(() => decodeWireValue({ [WIRE_U8_KEY]: 'QQ===' })));

  // ── B 组：isAllowedHost 矩阵 ─────────────────────────────────────────
  console.log('\n[B] isAllowedHost');
  const allowed = ['mytunnel.example.top', 'link.example.top'];
  check("'localhost' 通过", isAllowedHost('localhost', allowed) === true);
  check("'localhost:8790' 通过（剥端口）", isAllowedHost('localhost:8790', allowed) === true);
  check("'LOCALHOST:8790' 通过（大小写）", isAllowedHost('LOCALHOST:8790', allowed) === true);
  check("'127.0.0.1' 通过（IPv4 字面量）", isAllowedHost('127.0.0.1', allowed) === true);
  check("'192.168.1.5:8790' 通过（IPv4+端口）", isAllowedHost('192.168.1.5:8790', allowed) === true);
  check("'[::1]:8790' 通过（IPv6 括号形态）", isAllowedHost('[::1]:8790', allowed) === true);
  check("'::1' 通过（IPv6 裸形态）", isAllowedHost('::1', allowed) === true);
  check("'fe80::1' 通过（IPv6 压缩形态）", isAllowedHost('fe80::1', allowed) === true);
  check("'mytunnel.example.top' 通过（allowedHosts 命中）",
    isAllowedHost('mytunnel.example.top', allowed) === true);
  check("'MyTunnel.Example.top' 通过（allowedHosts 大写 Host 混写）",
    isAllowedHost('MyTunnel.Example.top', allowed) === true);
  check("'LINK.EXAMPLE.TOP:443' 通过（allowedHosts 大写+端口）",
    isAllowedHost('LINK.EXAMPLE.TOP:443', allowed) === true);
  check('undefined 拒（Host 缺省）', isAllowedHost(undefined, allowed) === false);
  check("'' 拒（空 Host）", isAllowedHost('', allowed) === false);
  check("'evil.example.com' 拒", isAllowedHost('evil.example.com', allowed) === false);
  check("'localhost.evil.com' 拒（前缀伪装非 localhost）",
    isAllowedHost('localhost.evil.com', allowed) === false);
  check("'999.1.1.1' 拒（IPv4 段越界）", isAllowedHost('999.1.1.1', allowed) === false);
  check("'1.2.3' 拒（三段非 IPv4）", isAllowedHost('1.2.3', allowed) === false);
  check("'192.168.1.5:abc' 拒（端口非数字不剥、整体不命中）",
    isAllowedHost('192.168.1.5:abc', allowed) === false);
  check("'127.0.0.1:65536' 拒（端口越界）", isAllowedHost('127.0.0.1:65536', allowed) === false);
  check("'[::1]:abc' 拒（括号后非合法端口形态）", isAllowedHost('[::1]:abc', allowed) === false);
  check("'1:2:3:4:5:6:7:8:9' 拒（9 段非 IPv6）", isAllowedHost('1:2:3:4:5:6:7:8:9', allowed) === false);
  check("'dead' 拒（hex 形单标签非 IPv6/localhost）", isAllowedHost('dead', allowed) === false);
  check("allowedHosts 为 undefined 兜底（仅 localhost/IP 字面量）",
    isAllowedHost('localhost', undefined as unknown as string[]) === true);

  // ── C 组：sanitizeWebAccessConfig ────────────────────────────────────
  console.log('\n[C] sanitizeWebAccessConfig');
  assert.deepStrictEqual(sanitizeWebAccessConfig({ enabled: 1, port: 80, allowedHosts: [] }),
    { enabled: true, port: WEB_ACCESS_DEFAULT_PORT, allowedHosts: [] });
  check('端口 80 → 8790、enabled 真值 → true', true);
  eq('端口 70000 → 8790', sanitizeWebAccessConfig({ enabled: true, port: 70000 }).port,
    WEB_ACCESS_DEFAULT_PORT);
  eq("端口 'abc' → 8790", sanitizeWebAccessConfig({ port: 'abc' }).port, WEB_ACCESS_DEFAULT_PORT);
  eq('端口 undefined → 8790', sanitizeWebAccessConfig({}).port, WEB_ACCESS_DEFAULT_PORT);
  eq('端口 80.5（非整数）→ 8790', sanitizeWebAccessConfig({ port: 80.5 }).port, WEB_ACCESS_DEFAULT_PORT);
  eq('端口 NaN → 8790', sanitizeWebAccessConfig({ port: Number.NaN }).port, WEB_ACCESS_DEFAULT_PORT);
  eq('端口 1023（下界-1）→ 8790', sanitizeWebAccessConfig({ port: 1023 }).port, WEB_ACCESS_DEFAULT_PORT);
  eq('端口 1024（下界）保留', sanitizeWebAccessConfig({ port: 1024 }).port, 1024);
  eq('端口 65535（上界）保留', sanitizeWebAccessConfig({ port: 65535 }).port, 65535);
  eq('端口 65536（上界+1）→ 8790', sanitizeWebAccessConfig({ port: 65536 }).port, WEB_ACCESS_DEFAULT_PORT);
  eq("enabled 'yes' → true", sanitizeWebAccessConfig({ enabled: 'yes' }).enabled, true);
  eq('enabled 0 → false', sanitizeWebAccessConfig({ enabled: 0 }).enabled, false);
  eq('enabled 缺省 → false', sanitizeWebAccessConfig({ port: 8790 }).enabled, false);

  assert.deepStrictEqual(sanitizeWebAccessConfig({ allowedHosts: [' A.com ', '', 'a.com', 'B.COM'] }),
    { enabled: false, port: WEB_ACCESS_DEFAULT_PORT, allowedHosts: ['a.com', 'b.com'] });
  check('allowedHosts：trim + 空串剔除 + 去重（大小写不敏感）+ 小写化', true);

  const ten = ['h1.example', 'h2.example', 'h3.example', 'h4.example', 'h5.example',
    'h6.example', 'h7.example', 'h8.example', 'h9.example', 'h10.example'];
  const capped = sanitizeWebAccessConfig({ allowedHosts: ten });
  eq('allowedHosts 超 8 条截断为 8', capped.allowedHosts.length, 8);
  eq('截断保留前 8 条（顺序）', capped.allowedHosts[7], 'h8.example');

  const fallback = { enabled: false, port: WEB_ACCESS_DEFAULT_PORT, allowedHosts: [] as string[] };
  assert.deepStrictEqual(sanitizeWebAccessConfig(null), fallback);
  assert.deepStrictEqual(sanitizeWebAccessConfig(undefined), fallback);
  assert.deepStrictEqual(sanitizeWebAccessConfig('x'), fallback);
  assert.deepStrictEqual(sanitizeWebAccessConfig(42), fallback);
  assert.deepStrictEqual(sanitizeWebAccessConfig({ allowedHosts: 'x' }), fallback);
  check('sanitize(null/undefined/非对象/allowedHosts 非数组) 不崩且回落默认', true);

  // ── D 组：resolveStaticPath ──────────────────────────────────────────
  console.log('\n[D] resolveStaticPath');
  const posixRoot = '/srv/cl/out/renderer';
  eq("'/' → index.html", resolveStaticPath(posixRoot, '/'), posixRoot + '/index.html');
  eq("'/index.html' 命中", resolveStaticPath(posixRoot, '/index.html'), posixRoot + '/index.html');
  eq("'/assets/a.js' 命中", resolveStaticPath(posixRoot, '/assets/a.js'), posixRoot + '/assets/a.js');
  check("'/../main/index.js' 拒", resolveStaticPath(posixRoot, '/../main/index.js') === null);
  check("'//etc/passwd' 拒（无白名单扩展名）", resolveStaticPath(posixRoot, '/etc/passwd') === null);
  check("'/a.exe' 拒（白名单外扩展名）", resolveStaticPath(posixRoot, '/a.exe') === null);
  check("'/assets/' 拒（目录段无扩展名）", resolveStaticPath(posixRoot, '/assets/') === null);
  check("'/a.JS' 放行（扩展名大小写不敏感）", resolveStaticPath(posixRoot, '/a.JS') === posixRoot + '/a.JS');
  check("'a.b/index.html' 命中（多级段）",
    resolveStaticPath(posixRoot, '/a.b/c/index.html') === posixRoot + '/a.b/c/index.html');
  check("'a..b/index.html' 放行（'..' 仅作完整段才拒）",
    resolveStaticPath(posixRoot, '/a..b/index.html') === posixRoot + '/a..b/index.html');

  // 路径穿越/编码攻击矩阵
  check("'/%2e%2e/secrets.json' 拒（%2e%2e 解码为 ..）",
    resolveStaticPath(posixRoot, '/%2e%2e/secrets.json') === null);
  check("'/%252e%252e/x.js' 放行（双重编码仅解一层 → 字面段，非穿越）",
    resolveStaticPath(posixRoot, '/%252e%252e/x.js') !== null);
  check("'/%zz' 拒（非法百分号编码）", resolveStaticPath(posixRoot, '/%zz') === null);
  check("'/%00.txt' 拒（NUL）", resolveStaticPath(posixRoot, '/%00.txt') === null);
  check("'/..%2f..%2f' 拒（解码为 /../../）", resolveStaticPath(posixRoot, '/..%2f..%2f') === null);
  check("'/a%5Cb.js' 拒（%5C 解码为反斜杠）", resolveStaticPath(posixRoot, '/a%5Cb.js') === null);
  check("'x' 拒（非绝对路径）", resolveStaticPath(posixRoot, 'x') === null);
  check("'' 拒（空路径）", resolveStaticPath(posixRoot, '') === null);
  check("rootDir 空串拒", resolveStaticPath('', '/index.html') === null);

  // Windows rootDir：归一拼接保持反斜杠
  const winRoot = 'D:\\cl\\out\\renderer';
  eq("win rootDir '/' → index.html", resolveStaticPath(winRoot, '/'), winRoot + '\\index.html');
  eq("win rootDir '/assets/a.js' 拼接反斜杠",
    resolveStaticPath(winRoot, '/assets/a.js'), winRoot + '\\assets\\a.js');
  check("win rootDir '/..%2f..%2f' 拒", resolveStaticPath(winRoot, '/..%2f..%2f') === null);
  check("win rootDir 尾分隔符归一",
    resolveStaticPath(winRoot + '\\', '/index.html') === winRoot + '\\index.html');

  // ── E 组：STATIC_MIME / 放行扩展名键集一致 ───────────────────────────
  console.log('\n[E] STATIC_MIME');
  eq('js → text/javascript', STATIC_MIME.js, 'text/javascript');
  eq('mjs → text/javascript', STATIC_MIME.mjs, 'text/javascript');
  eq('css → text/css', STATIC_MIME.css, 'text/css');
  eq('html → text/html', STATIC_MIME.html, 'text/html');
  eq('json → application/json', STATIC_MIME.json, 'application/json');
  eq('svg → image/svg+xml', STATIC_MIME.svg, 'image/svg+xml');
  eq('png → image/png', STATIC_MIME.png, 'image/png');
  eq('jpg → image/jpeg', STATIC_MIME.jpg, 'image/jpeg');
  eq('jpeg → image/jpeg', STATIC_MIME.jpeg, 'image/jpeg');
  eq('ico → image/x-icon', STATIC_MIME.ico, 'image/x-icon');
  eq('woff → font/woff', STATIC_MIME.woff, 'font/woff');
  eq('woff2 → font/woff2', STATIC_MIME.woff2, 'font/woff2');
  eq('map → application/json', STATIC_MIME.map, 'application/json');
  eq('txt → text/plain', STATIC_MIME.txt, 'text/plain');
  eq('白名单扩展名共 14 个', Object.keys(STATIC_MIME).length, 14);
  let mimeSetOk = true;
  for (const ext of Object.keys(STATIC_MIME)) {
    if (resolveStaticPath(posixRoot, `/f.${ext}`) !== `${posixRoot}/f.${ext}`) {
      mimeSetOk = false;
      console.log(`    ↳ 放行扩展名 ${ext} 未命中`);
    }
  }
  check('放行扩展名键集 === STATIC_MIME 键集（逐一命中）', mimeSetOk);
  eq('WEB_ACCESS_DEFAULT_PORT = 8790', WEB_ACCESS_DEFAULT_PORT, 8790);

  // ── F 组：静态断言（共享文件零环境依赖） ─────────────────────────────
  console.log('\n[F] 静态断言（三方共用前提）');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'shared', 'web-access-protocol.ts'),
    'utf8',
  );
  check('不含 btoa（禁用宿主内置 Base64 API）', !src.includes('btoa'));
  check('不含 atob（禁用宿主内置 Base64 API）', !src.includes('atob'));
  check('不含 Buffer（禁用 Node 二进制类型）', !src.includes('Buffer'));
  check("不含 from 'node: / require('node:（零 Node 专属模块）",
    !/from ['"]node:/.test(src) && !src.includes("require('node:"));
  check("不含 from 'electron'（零 Electron 依赖）", !src.includes("'electron'"));

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
