// aux-traffic-proxy.mjs — 引擎后台请求取证记流代理（Phase A 工具，计划 §3.8）。
//
// 用法：node scripts/aux-traffic-proxy.mjs --upstream http://127.0.0.1:6183 --port 16884 --out <日志路径>
//
// 每请求：收 body → 解析 JSON 提取 stream/model/max_tokens/system 首行前 120 字符/
// metadata.user_id 前 40 字符 → 连同时间戳、方法、路径、x-api-key 前 12 字符写 JSONL 日志
// → 原样转发 upstream（保留 headers，仅改 host）→ 回传响应流。
// 无 body 请求（HEAD/GET /api/hello 等）同样记录（方法+路径）。
// 红线：不写完整 body、不写完整密钥。SIGINT 退出（未决请求按 aborted 落盘）。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = { upstream: null, port: null, out: null, dump: null, dumpMax: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--upstream') args.upstream = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    // 取证专用：把前 N 个 mt=1 请求 body 原样落盘到目录（本地分析用，绝不写进 --out 日志）。
    else if (a === '--dump') args.dump = argv[++i];
    else if (a === '--dump-max') args.dumpMax = Number(argv[++i]);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.upstream || !args.port || !args.out) {
  console.log('用法: node scripts/aux-traffic-proxy.mjs --upstream <url> --port <n> --out <file>');
  console.log('示例: node scripts/aux-traffic-proxy.mjs --upstream http://100.64.0.1:6183 --port 16884 --out D:/tmp/proxy.jsonl');
  if (!args.help && !args.upstream) process.exit(1);
  process.exit(0);
}

let upstream;
try {
  upstream = new URL(args.upstream);
} catch {
  console.error(`--upstream 不是合法 URL: ${args.upstream}`);
  process.exit(1);
}
if (upstream.protocol !== 'http:') {
  console.error('仅支持 http:// upstream（引擎网关为本机/内网 http 端点）');
  process.exit(1);
}

const outPath = path.resolve(args.out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const logStream = fs.createWriteStream(outPath, { flags: 'a' });

let seq = 0;
let dumpCount = 0;
const pending = new Set();

function writeLine(entry) {
  try {
    logStream.write(JSON.stringify(entry) + '\n');
  } catch {
    /* 日志写失败不影响转发 */
  }
}

// system 字段兼容 string 与 [{type:'text',text}] 块数组：取首个文本的首行前 120 字符。
function extractSystemHead(system) {
  let first = '';
  if (typeof system === 'string') {
    first = system;
  } else if (Array.isArray(system)) {
    for (const block of system) {
      if (block && typeof block === 'object' && typeof block.text === 'string' && block.text.trim()) {
        first = block.text;
        break;
      }
    }
  }
  return first.split('\n')[0].slice(0, 120);
}

function extractFromBody(raw, id) {
  const base = { stream: null, model: null, max_tokens: null, sys_head: null, user_id_head: null, effort: null, tools_count: null, messages_len: null, first_user_head: null };
  try {
    const body = JSON.parse(raw.toString('utf8'));
    base.stream = typeof body.stream === 'boolean' ? body.stream : null;
    base.model = typeof body.model === 'string' ? body.model : null;
    base.max_tokens = typeof body.max_tokens === 'number' ? body.max_tokens : null;
    base.sys_head = body.system !== undefined ? extractSystemHead(body.system) : null;
    base.user_id_head = typeof body.metadata?.user_id === 'string' ? body.metadata.user_id.slice(0, 100) : null;
    // effort：顶层 reasoning_effort 优先（引擎实际发送字段），thinking.effort 兜底。
    base.effort = typeof body.reasoning_effort === 'string'
      ? body.reasoning_effort
      : (typeof body.thinking?.effort === 'string' ? body.thinking.effort : null);
    base.tools_count = Array.isArray(body.tools) ? body.tools.length : null;
    base.messages_len = Array.isArray(body.messages) ? body.messages.length : null;
    base.first_user_head = extractFirstUserHead(body.messages);
    // mt=1 探针深挖：首条 user 文本前 400 字符（定位 querySource 用，仍非全文）。
    if (base.max_tokens === 1) {
      base.user_msg_head_400 = extractUserMsgHead(body.messages, 400);
      // 取证专用：前 dumpMax 个 mt=1 请求 body 落盘（本地分析）。
      if (args.dump && dumpCount < args.dumpMax) {
        dumpCount += 1;
        try {
          fs.mkdirSync(args.dump, { recursive: true });
          fs.writeFileSync(path.join(args.dump, `mt1-${String(dumpCount).padStart(3, '0')}-id${id}.json`), raw);
        } catch { /* 落盘失败不影响转发 */ }
      }
    }
  } catch {
    /* 非 JSON body：只记长度 */
  }
  return base;
}

// 首条 user 消息文本首行前 80 字符（aux 小请求无 system 头，靠消息内容判别 querySource）。
function extractFirstUserHead(messages) {
  const text = firstUserText(messages);
  if (text === null) return '(无user消息)';
  const head = text.split('\n')[0].slice(0, 80);
  return head || '(user消息无文本)';
}

// 指定长度的首条 user 文本头（跨行，保留换行转义）。
function extractUserMsgHead(messages, len) {
  const text = firstUserText(messages);
  if (text === null) return null;
  return text.slice(0, len);
}

function firstUserText(messages) {
  if (!Array.isArray(messages)) return null;
  for (const m of messages) {
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block && typeof block === 'object' && typeof block.text === 'string' && block.text.trim()) {
          return block.text;
        }
      }
      return null; // user 消息但无文本块（tool_result 等）
    }
  }
  return null;
}

const server = http.createServer((req, res) => {
  const id = ++seq;
  const startedAt = new Date().toISOString();
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('error', () => { /* 客户端中断：finishing 时不转发 */ });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const keyHeader = req.headers['x-api-key'] || req.headers['authorization'] || '';
    const entry = {
      id,
      t: startedAt,
      method: req.method,
      path: req.url,
      key12: typeof keyHeader === 'string' ? keyHeader.slice(0, 12) : '',
      ua: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 80) : '',
      body_len: body.length,
      ...(body.length > 0 ? extractFromBody(body, id) : {}),
      status: null,
      duration_ms: null,
    };
    pending.add(id);

    const headers = { ...req.headers };
    headers.host = upstream.host;
    const upstreamReq = http.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers,
      },
      (upstreamRes) => {
        entry.status = upstreamRes.statusCode;
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        upstreamRes.on('end', () => {
          entry.duration_ms = Date.now() - Date.parse(startedAt);
          writeLine(entry);
          pending.delete(id);
        });
        upstreamRes.on('error', () => {
          entry.status = entry.status ?? 'upstream_error';
          entry.duration_ms = Date.now() - Date.parse(startedAt);
          writeLine(entry);
          pending.delete(id);
          res.destroy();
        });
      },
    );
    upstreamReq.on('error', (err) => {
      entry.status = `forward_error:${err.code ?? err.message}`;
      entry.duration_ms = Date.now() - Date.parse(startedAt);
      writeLine(entry);
      pending.delete(id);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'proxy_forward_error', message: String(err.code ?? err.message) } }));
    });
    if (body.length > 0) upstreamReq.write(body);
    upstreamReq.end();
  });
});

server.listen(args.port, '127.0.0.1', () => {
  console.log(`[aux-traffic-proxy] listening http://127.0.0.1:${args.port} -> ${args.upstream}`);
  console.log(`[aux-traffic-proxy] log: ${outPath}`);
});

function shutdown() {
  for (const id of pending) writeLine({ id, t: new Date().toISOString(), status: 'aborted_on_shutdown' });
  server.close(() => {
    logStream.end(() => process.exit(0));
  });
  // 兜底：1s 后强制退出（close 回调在有活跃 keep-alive 连接时可能不来）。
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
