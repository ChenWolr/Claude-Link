// 假 MCP stdio server（p2 探活契约测试 fixture，2026-10-27 五问题计划 §3.4）：
// 行缓冲 ndjson JSON-RPC，行为与 mcp-probe.ts probeStdioServer 的握手对齐（执行前已读其实现）：
//   initialize(id:1)   → 应答 result{ protocolVersion/capabilities/serverInfo }（探活器不校验
//                        协议版本回显，按其 MCP_PROTOCOL_VERSION='2025-06-18' 同款回显最真实）；
//   notifications/initialized（通知）→ 不回包；
//   tools/list(id:2)   → 应答 result.tools = [echo, ping]（探活断言 toolCount=2 的数据源）。
// env FAKE_MCP_DELAY_MS（毫秒）：每条应答前 sleep 该时长（C 组超时用例：8000ms > 探活 1500ms）。
import { createInterface } from 'node:readline';

const delayMs = Number.parseInt(process.env.FAKE_MCP_DELAY_MS ?? '0', 10) || 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const t = line.trim();
  if (t === '') return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  if (msg?.method === 'initialize') {
    if (delayMs > 0) await sleep(delayMs);
    write({
      jsonrpc: '2.0',
      id: msg.id ?? 1,
      result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-mcp', version: '0.0.1' } },
    });
    return;
  }
  if (msg?.method === 'notifications/initialized') return; // 通知不回包
  if (msg?.method === 'tools/list') {
    if (delayMs > 0) await sleep(delayMs);
    write({
      jsonrpc: '2.0',
      id: msg.id ?? 2,
      result: {
        tools: [
          { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
          { name: 'ping', description: 'ping', inputSchema: { type: 'object' } },
        ],
      },
    });
  }
});
