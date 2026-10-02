// tdd-bridge-surrogate-safe-cut-verify.ts
// 计划 docs/plans/2026-09-30-feature-optimization-plan.md B12 契约钉（域发现 D12-F1，复核 CONFIRMED）：
//   微信 4000 字分段硬切与飞书 100_000 入站截断均按 UTF-16 code unit 计数，切点落在星体字符
//   （emoji/扩展汉字）代理对中间会产生孤立高/低代理（JSON.stringify 出未配对 \uD8xx，iLink 可能
//   拒收整段、接收端乱码）。修复：共用 safe-cut 工具，切点两侧恰为高/低代理时回退 1 个 code unit。
//   A. splitWechatText 行为矩阵：星体构造的超长消息分段后每段无孤立代理且拼接无损（可独立解码）；
//      对齐边界/换行回退/纯 ASCII/BMP/恰等上限/空串行为不变。
//   B. safeCutWidth 纯函数单位直测（切点中间回退 1；非中间原样；start 游标；越界不调整）。
//   C. 飞书入站 100_000 截断同修（createFeishuAdapter + fake lark，行为级）。
//   D. 结构契约：两处调用面使用 safeCutWidth（源码形态钉）。
// RED 预期（未改树）：safe-cut 模块不存在（B/D FAIL）；A①②④、C① 检出孤立代理 FAIL。
// 运行：npx tsx scripts/tdd-bridge-surrogate-safe-cut-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { splitWechatText } from '../src/shared/bridge/wechat-outbound';
import { createFeishuAdapter, type FeishuAdapterOptions } from '../src/main/modules/bridge/feishu-adapter';
import type { BridgeInboundMessage } from '../src/shared/types/bridge';

let pass = 0;
let fail = 0;
function check(group: string, no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ [${group}] ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ [${group}] ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 孤立代理检测：高代理后无低代理、或低代理前无高代理，即该字符串不可无损独立解码。 */
function hasIsolatedSurrogate(s: string): boolean {
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(k + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      const p = s.charCodeAt(k - 1);
      if (!(p >= 0xd800 && p <= 0xdbff)) return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  // B 组被测纯函数经动态 import 引入（RED 期模块未建时整组 FAIL 而不炸脚本）。
  let safeCutWidth: ((text: string, start: number, want: number) => number) | null = null;
  try {
    ({ safeCutWidth } = await import('../src/shared/bridge/safe-cut'));
  } catch {
    safeCutWidth = null;
  }

  // ── A. splitWechatText 代理对安全矩阵 ──
  {
    const EMOJI = '\u{1F600}'; // 😀 高+低双代理
    const CJK_EXT_B = '\u{20000}'; // 𠀀 扩展汉字（星体）
    const t1 = 'a'.repeat(3999) + EMOJI.repeat(2); // 4003 单元：硬切点 4000 落第一对中间
    const c1 = splitWechatText(t1);
    check('A', '①', `'a'×3999+😀×2 → 2 段且 [0]='a'×3999、[1]='😀😀'（硬切回退 1 不带走高代理）`,
      c1.length === 2 && c1[0] === 'a'.repeat(3999) && c1[1] === EMOJI.repeat(2),
      `实际=${c1.length} 段，[0]长=${c1[0]?.length}，[0]尾孤立=${c1[0] ? hasIsolatedSurrogate(c1[0]) : '?'}`);

    const matrix: Array<[string, string]> = [
      ['ASCII+emoji 硬切', t1],
      ['纯 emoji 超长', EMOJI.repeat(2500)], // 5000 单元，切点 4000 对齐（2k 偶数位起对）
      ['BMP+扩展汉字', '字'.repeat(2000) + CJK_EXT_B.repeat(1500)], // 2000+3000，切点对齐
      ['奇数偏移星体串', '字' + CJK_EXT_B.repeat(2500)], // 1+5000，切点 4000 落对中间
      ['emoji+换行回退', (EMOJI + '\n').repeat(1400)], // 4200 单元，走换行回退路径
    ];
    const matrixOk = matrix.every(([label, t]) => {
      const chunks = splitWechatText(t);
      const noIso = chunks.every((c) => !hasIsolatedSurrogate(c));
      const lossless = chunks.join('') === t;
      if (!noIso || !lossless) console.log(`      （${label}：孤立=${!noIso} 无损=${lossless}）`);
      return noIso && lossless;
    });
    check('A', '②', '星体矩阵：全部用例分段后每段无孤立代理且拼接无损（每段可独立解码）', matrixOk);

    const alignEmoji = splitWechatText(EMOJI.repeat(2500));
    const alignBmp = splitWechatText('字'.repeat(2000) + CJK_EXT_B.repeat(1500));
    check('A', '③', '对齐边界不过度回退：纯 emoji 5000 → [0].length===4000；BMP+星体 → [0].length===4000',
      alignEmoji.length === 2 && alignEmoji[0]!.length === 4000
      && alignBmp.length === 2 && alignBmp[0]!.length === 4000,
      `emoji[0]=${alignEmoji[0]?.length}，bmp[0]=${alignBmp[0]?.length}`);

    const odd = splitWechatText('字' + CJK_EXT_B.repeat(2500));
    check('A', '④', `'字'+𠀀×2500 → [0]='字'+𠀀×1999（3999 单元），[1]=𠀀×501`,
      odd.length === 2 && odd[0] === '字' + CJK_EXT_B.repeat(1999) && odd[1] === CJK_EXT_B.repeat(501),
      `实际=${odd.length} 段，[0]长=${odd[0]?.length}，[0]尾孤立=${odd[0] ? hasIsolatedSurrogate(odd[0]) : '?'}`);

    const exact = splitWechatText(EMOJI.repeat(2000)); // 恰 4000 单元
    check('A', '⑤', '恰等上限：😀×2000（恰 4000 单元）→ 1 段原样',
      exact.length === 1 && exact[0] === EMOJI.repeat(2000) && !hasIsolatedSurrogate(exact[0] ?? ''),
      `实际=${exact.length} 段`);

    const nl = splitWechatText((EMOJI + '\n').repeat(1400));
    check('A', '⑥', '换行回退路径不受影响：非末段段尾含 \\n 且无孤立代理',
      nl.length === 2 && nl[0]!.endsWith('\n') && nl.every((c) => !hasIsolatedSurrogate(c)),
      `段数=${nl.length}`);

    check('A', '⑦', '空串/短星体不变：\'\'→[]；\'😀\'→[\'😀\']',
      splitWechatText('').length === 0
      && splitWechatText(EMOJI).length === 1 && splitWechatText(EMOJI)[0] === EMOJI,
      `空=${splitWechatText('').length}`);
  }

  // ── B. safeCutWidth 纯函数单位直测 ──
  {
    const f = safeCutWidth;
    check('B', '①', "切点落高/低代理中间 → 回退 1：safeCutWidth('a😀b',0,2)===1",
      !!f && f('a\u{1F600}b', 0, 2) === 1, f ? `实际=${f('a\u{1F600}b', 0, 2)}` : 'safe-cut 模块未建');
    check('B', '②', "切点非代理对中间 → 原样：safeCutWidth('ab😀',0,2)===2",
      !!f && f('ab\u{1F600}', 0, 2) === 2, f ? `实际=${f('ab\u{1F600}', 0, 2)}` : 'safe-cut 模块未建');
    check('B', '③', 'start 游标生效：x😀y😀z 起点 3 取 2 → 1（end=5 落对中间）；起点 1 取 2 → 2',
      !!f && f('x\u{1F600}y\u{1F600}z', 3, 2) === 1 && f('x\u{1F600}y\u{1F600}z', 1, 2) === 2,
      f ? `实际=${f('x\u{1F600}y\u{1F600}z', 3, 2)}/${f('x\u{1F600}y\u{1F600}z', 1, 2)}` : 'safe-cut 模块未建');
    check('B', '④', '边界不调整：want 越文本末尾原样（\'ab\',0,5→5）；want≤1 原样（\'😀\',0,1→1）',
      !!f && f('ab', 0, 5) === 5 && f('\u{1F600}', 0, 1) === 1,
      f ? `实际=${f('ab', 0, 5)}/${f('\u{1F600}', 0, 1)}` : 'safe-cut 模块未建');
  }

  // ── C. 飞书入站 100_000 截断同修（fake lark，行为级）──
  {
    const state = {
      dispatcherRegistry: {} as Record<string, (data: unknown) => Promise<void> | void>,
    };
    const fakeLark = {
      Client: class {
        contact = {
          user: { get: async () => ({ data: { user: { nickname: '阿明' } } }) },
        };
      },
      WSClient: class {
        wsConfig: { wsInstance?: { readyState: number } | null } = { wsInstance: { readyState: 1 } };
        async start(): Promise<void> { /* noop */ }
        close(): void { /* noop */ }
      },
      EventDispatcher: class {
        register(handlers: Record<string, (data: unknown) => Promise<void> | void>): void {
          Object.assign(state.dispatcherRegistry, handlers);
        }
      },
      Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
      LoggerLevel: { warn: 'warn' },
    };
    const received: BridgeInboundMessage[] = [];
    const adapter = createFeishuAdapter({
      appId: 'cli_b12',
      appSecret: 's',
      region: 'feishu_cn',
      onMessage: (m) => received.push(m),
      onStatus: () => {},
      __loadSdkForTest: async () => fakeLark,
      __intervalsForTest: { initialPollMs: 1, healthIntervalMs: 5 },
    } as FeishuAdapterOptions);
    await adapter.start();
    const handler = state.dispatcherRegistry['im.message.receive_v1'];
    if (!handler) throw new Error('事件处理器未注册（fake lark 形态不符）');
    const send = async (text: string): Promise<void> => {
      await handler({
        message: { message_type: 'text', chat_type: 'p2p', chat_id: 'oc_b12', content: JSON.stringify({ text }) },
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_b12' } },
      });
    };
    try {
      // 切点 100_000 落第一对 emoji 中间：裸 slice 产生尾孤立高代理。
      const tCut = 'a'.repeat(99_999) + '\u{1F600}'.repeat(2); // 100_003 单元
      await send(tCut);
      const m1 = received[received.length - 1]!;
      check('C', '①', `入站 100_003 单元（切点落代理对中间）→ 截断后长 99_999、全 'a'、无孤立代理`,
        m1.text === 'a'.repeat(99_999) && !hasIsolatedSurrogate(m1.text),
        `实际长=${m1.text.length}，孤立=${hasIsolatedSurrogate(m1.text)}`);

      // 对齐边界：偶数位起对，切点 100_000 前是完整字符 → 不回退，恰 100_000。
      const tAlign = '\u{1F600}'.repeat(50_001); // 100_002 单元
      await send(tAlign);
      const m2 = received[received.length - 1]!;
      check('C', '②', `入站对齐边界 100_002 单元 → 截断后恰 100_000（50_000 对）且无孤立代理`,
        m2.text === '\u{1F600}'.repeat(50_000) && !hasIsolatedSurrogate(m2.text),
        `实际长=${m2.text.length}，孤立=${hasIsolatedSurrogate(m2.text)}`);

      await send('你好\u{1F600}');
      const m3 = received[received.length - 1]!;
      check('C', '③', '短消息不经截断路径：\'你好😀\' 原样透传',
        m3.text === '你好\u{1F600}', `实际=${JSON.stringify(m3.text)}`);
    } finally {
      await adapter.stop();
    }
  }

  // ── D. 结构契约：两处调用面使用 safeCutWidth（源码形态钉）──
  {
    const outboundSrc = fs.readFileSync(path.join(__dirname, '../src/shared/bridge/wechat-outbound.ts'), 'utf8');
    check('D', '①', 'wechat-outbound.ts 满段切分调用 safeCutWidth', /safeCutWidth\(/.test(outboundSrc),
      '未找到 safeCutWidth 调用');
    const adapterSrc = fs.readFileSync(path.join(__dirname, '../src/main/modules/bridge/feishu-adapter.ts'), 'utf8');
    check('D', '②', 'feishu-adapter.ts 100_000 截断处为 slice(0, safeCutWidth(text, 0, MAX_MSG_SIZE))',
      /text\.slice\(0,\s*safeCutWidth\(text,\s*0,\s*MAX_MSG_SIZE\)\)/.test(adapterSrc),
      '截断处未走 safeCutWidth');
  }

  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
