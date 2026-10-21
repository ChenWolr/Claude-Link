// web-access-probe.ts
// 「网页访问（局域网）」P3 探针（手动/CI 用，**不进 selftest 链**——需真实 app 运行中且网页
// 访问开关已开启；由编排器在 P5 整链验证时亲自跑）：
//
//   npx tsx scripts/web-access-probe.ts --url ws://127.0.0.1:8790/ws --token <t> [--origin http://192.168.1.5:8790]
//
// 断言（计划 §3-P3-6，最小化三项 + 可选浏览器路径回归）：
//   ⓪ --origin 提供时：带该 Origin 头的对 token 升级 → welcome（浏览器路径行为级回归——
//      Node ws 客户端默认不发 Origin，不加此断言时 Origin 分支无行为级覆盖）；
//   ① 错 token → 收 {v:1,kind:'bye',reason:'bad-token'} 且 close code 4001；
//   ② 对 token → welcome（含 appVersion/buildRev 字符串）；
//   ③ invoke('config:get') → resolve ok:true 且结果含 webAccess 键。
// exit 0 为过。注意：①会计入服务端限速表（每 IP 10 分钟窗口 5 次失败 → 429），连续多次运行
// 本探针会被限速拒绝——属预期安全行为，间隔或重启 app 后再试。

import WebSocket from 'ws';

interface ProbeArgs {
  url: string;
  token: string;
  origin: string;
}

type Frame = Record<string, unknown>;

const STEP_TIMEOUT_MS = 10_000;
const BAD_TOKEN = 'definitely-wrong-probe-token';

function parseArgs(argv: string[]): ProbeArgs {
  let url = '';
  let token = '';
  let origin = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') url = argv[i + 1] ?? '';
    if (argv[i] === '--token') token = argv[i + 1] ?? '';
    if (argv[i] === '--origin') origin = argv[i + 1] ?? '';
  }
  if (!url || !token) {
    console.error('用法：npx tsx scripts/web-access-probe.ts --url ws://127.0.0.1:8790/ws --token <t> [--origin http://192.168.1.5:8790]');
    process.exit(2);
  }
  return { url, token, origin };
}

function withTimeout<T>(label: string, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${STEP_TIMEOUT_MS}ms）`)), STEP_TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function withToken(rawUrl: string, token: string): string {
  return rawUrl.includes('?') ? `${rawUrl}&token=${encodeURIComponent(token)}` : `${rawUrl}?token=${encodeURIComponent(token)}`;
}

/** 断言 ⓪（--origin 提供时）：带该 Origin 头的对 token 升级 → welcome（浏览器路径回归）。 */
async function expectOriginWelcome(rawUrl: string, token: string, origin: string): Promise<void> {
  const result = await withTimeout(
    '带 Origin 对 token 探测',
    new Promise<{ welcome: Frame | null }>((resolve, reject) => {
      const ws = new WebSocket(withToken(rawUrl, token), { headers: { Origin: origin } });
      let welcome: Frame | null = null;
      ws.on('message', (data) => {
        try {
          const frame = JSON.parse(String(data)) as Frame;
          if (frame.kind === 'welcome' && !welcome) welcome = frame;
        } catch {
          /* 非法帧忽略 */
        }
      });
      ws.on('open', () => {
        // welcome 应在升级完成前/握手后立刻到达；open 后稍候读帧，避免竞态早退
        setTimeout(() => resolve({ welcome }), 300);
      });
      ws.on('close', (code) => {
        if (!welcome) reject(new Error(`带 Origin 升级被拒绝（close code=${code}）——Origin 判定回归`));
      });
      ws.on('error', (err) => reject(err));
    }),
  );
  const welcome = result.welcome as Frame | null;
  if (!welcome || typeof welcome.appVersion !== 'string' || typeof welcome.buildRev !== 'string') {
    throw new Error(`带 Origin 升级未收到有效 welcome：${JSON.stringify(result.welcome)}`);
  }
  console.log(`  ✅ Origin=${origin} → 升级放行且收到 welcome（appVersion=${String(welcome.appVersion)}）`);
}

/** 断言 ①：错 token → bye(bad-token) 帧 + close 4001。 */
async function expectBadTokenRejected(rawUrl: string): Promise<void> {
  const result = await withTimeout(
    '错 token 探测',
    new Promise<{ bye: Frame | null; closeCode: number }>((resolve, reject) => {
      const ws = new WebSocket(withToken(rawUrl, BAD_TOKEN));
      let bye: Frame | null = null;
      ws.on('message', (data) => {
        try {
          bye = JSON.parse(String(data)) as Frame;
        } catch {
          /* 非法帧忽略 */
        }
      });
      ws.on('close', (code) => resolve({ bye, closeCode: code }));
      ws.on('error', (err) => reject(err));
    }),
  );
  const bye = result.bye;
  if (!bye || bye.kind !== 'bye' || bye.reason !== 'bad-token') {
    throw new Error(`错 token 未收到 bye(bad-token) 帧：${JSON.stringify(result.bye)}`);
  }
  if (result.closeCode !== 4001) {
    throw new Error(`错 token close code 期望 4001，实际 ${result.closeCode}`);
  }
  console.log('  ✅ 错 token → bye(bad-token) + close 4001');
}

/** 断言 ②③：对 token → welcome（appVersion/buildRev）；invoke('config:get') → ok 且含 webAccess。 */
async function expectAuthedFlow(rawUrl: string, token: string): Promise<void> {
  await withTimeout(
    '对 token 探测',
    new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(withToken(rawUrl, token));
      let invited = false;
      let invoked = false;
      ws.on('message', (data) => {
        let frame: Frame;
        try {
          frame = JSON.parse(String(data)) as Frame;
        } catch {
          return;
        }
        if (!invited) {
          if (frame.kind !== 'welcome') {
            reject(new Error(`期望 welcome，实际 ${JSON.stringify(frame).slice(0, 200)}`));
            ws.close();
            return;
          }
          if (typeof frame.appVersion !== 'string' || typeof frame.buildRev !== 'string') {
            reject(new Error(`welcome 缺 appVersion/buildRev：${JSON.stringify(frame).slice(0, 200)}`));
            ws.close();
            return;
          }
          console.log(`  ✅ 对 token → welcome（appVersion=${String(frame.appVersion)}, buildRev=${String(frame.buildRev)}）`);
          invited = true;
          ws.send(JSON.stringify({ v: 1, kind: 'invoke', id: 'probe-config-get', channel: 'config:get', args: [] }));
          return;
        }
        if (!invoked && frame.kind === 'resolve' && frame.id === 'probe-config-get') {
          invoked = true;
          const result = frame.result as Record<string, unknown> | undefined;
          if (frame.ok !== true || !result || !('webAccess' in result)) {
            reject(new Error(`config:get 回包异常：${JSON.stringify(frame).slice(0, 300)}`));
            ws.close();
            return;
          }
          console.log('  ✅ invoke(config:get) → ok:true 且结果含 webAccess');
          ws.close(1000);
          resolve();
        }
      });
      ws.on('close', (code) => {
        if (!invited || !invoked) reject(new Error(`连接提前关闭（code=${code}）`));
      });
      ws.on('error', (err) => reject(err));
    }),
  );
}

async function main(): Promise<void> {
  const { url, token, origin } = parseArgs(process.argv.slice(2));
  console.log(`[web-access-probe] url=${url}${origin ? ` origin=${origin}` : ''}`);
  if (origin) await expectOriginWelcome(url, token, origin);
  await expectBadTokenRejected(url);
  await expectAuthedFlow(url, token);
  console.log('[web-access-probe] 全部断言通过');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`[web-access-probe] 失败：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
