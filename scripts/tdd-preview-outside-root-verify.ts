// tdd-preview-outside-root-verify.ts
// 工作区外路径「确认后预览」（2026-11-06 两缺陷修复计划 round-001 p0a，TDD RED 阶段契约脚本）：
//   测试用例正本 = docs/plans/2026-11-06-two-bugs-test-cases.md §1（P1-01～P1-12 逐条转写，
//   断言期望值以该文档为准，不增删用例、不改期望值）。
//   · P1-01～P1-10 previewFile 行为组（mkdtemp fixture：rootA=允许根 / rootB=roots 外根，测完清理）；
//   · P1-11 桌面/网页通道三处同步结构钉（ipc.ts 通道字面+confirmOutsideRoot 注记 / preload api.ts
//     confirmOutsideRoot 签名与实现 / web-bridge.ts readFilePreview 表项 / ipc-handlers.ts
//     confirmOutsideRoot === true 严格归一字面）；期望③（既有
//     tdd-web-access-wiring-verify.ts 回归全绿）由外层命令组覆盖，不入本脚本；
//   · P1-12 UI 层「仍然预览」结构钉（FilePreviewDrawer.vue：文案字面 / readFilePreview( 恰 1 处 /
//     双参调用字面 readFilePreview(store.path, outsideRootConfirmed) / result.code ===
//     'outside-root' 唯一耦合字面 / .fpreview-empty__action 样式字面 / watch( 接线 +
//     outsideRootConfirmed = false 复位赋值实质钉）。
//   · 负向钉（round-002 F1-g）：P1-05 两形态与 P1-06 五子形态的失败返回不得携带 code 字段
//     （code 仅限 outside-root 拒绝形态，防误扩散导致按钮误挂）；selftest 清单登记自检置尾。
//   · P1-13（既有消费方契约链回归：tdd-file-preview-verify / tdd-code-inline-fileref-verify /
//     tdd-chat-file-open-verify 全绿）属外层回归链，不转写为脚本内用例。
//   P1-08 平台分叉（2026-11-06 计划会话裁决）：win32 断言 ok:true kind:'missing'（本机实测
//   stat 穿越文件型段抛 ENOENT → ⑦ 归一 missing）；POSIX 断言 ok:false「无法读取文件」
//  （ENOTDIR 口径）；两分支共同断言：调用不抛未捕获异常、返回为归一形态（非裸错误对象）。
// 形态对齐 tdd-file-preview-verify.ts：check/checkAsync、mkdtemp fixture 测完清理、头注释、
// `结果：N 通过 / M 失败` 末行、fail>0 则 process.exit(1)。
// RED 态类型桥接：实现落盘前 previewFile 签名尚无 confirmOutsideRoot 参，运行时忽略多余字段
// ——这正是新行为正例红的机制；经 unknown 双跳断言保证 RED 态 typecheck 通过（GREEN 态类型
// 自动对齐，届时可去桥接）。禁改被测模块源码。
// 仅 import node:* + 被测模块 + shared 类型，不 import electron（主进程模块 tsx 直测前提）。
// 运行：npx tsx scripts/tdd-preview-outside-root-verify.ts（已登记 scripts/selftest-static-list.txt）

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_PDF, MAX_TEXT, previewFile } from '../src/main/modules/fs-preview';
import type { FsPreviewResult } from '../src/shared/types/ipc';

type PreviewFn = (
  absPath: unknown,
  opts: { roots: string[]; confirmOutsideRoot?: boolean },
) => Promise<FsPreviewResult>;
// RED 态桥接：现状签名无 confirmOutsideRoot，多余字段被运行时忽略——新行为正例（携带确认仍被
// containment 拒）由此变红；GREEN 态被测签名对齐后本断言转型仍成立。
const preview = previewFile as unknown as PreviewFn;

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

/** 结果摘要（不 stringify content，防大载荷刷屏）。 */
function summarize(r: unknown): string {
  const o = r as Record<string, unknown>;
  return `ok=${String(o?.ok)} kind=${String(o?.kind)} message=${String(o?.message ?? '')} size=${String(o?.size ?? '')}`;
}

/** 断言 ok:true + kind:text 并取出可断言字段。 */
function expectText(r: unknown): { content: string; size: number; truncated: boolean } {
  const o = r as Record<string, unknown>;
  assert.strictEqual(o?.ok, true, `期待 ok:true，实际 ${summarize(r)}`);
  assert.strictEqual(o?.kind, 'text', `期待 kind:text，实际 ${summarize(r)}`);
  return { content: String(o.content), size: Number(o.size), truncated: Boolean(o.truncated) };
}

/** 断言 ok:false 且 message 含指定子串；noCode=true 时附加「不得携带 code 字段」负向钉。 */
function expectFail(r: unknown, msgContains: string, noCode = false): void {
  const o = r as Record<string, unknown>;
  assert.strictEqual(o?.ok, false, `期待 ok:false，实际 ${summarize(r)}`);
  assert.ok(String(o?.message ?? '').includes(msgContains), `message 应含「${msgContains}」，实际：${String(o?.message)}`);
  if (noCode) {
    assert.ok(!('code' in o), `失败形态不应携带 code 字段（code 仅限 outside-root 拒绝形态，误扩散会使按钮错挂），实际 code=${String(o?.code)}`);
  }
}

void (async (): Promise<void> => {
  console.log('\n=== P1 行为组（fixture：rootA=允许根 / rootB=roots 外根） ===');
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-preview-in-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-preview-out-'));
  try {
    // —— P1-01【正常】不携带确认语义 + roots 内路径 → 与修复前基线逐字节一致 ——
    await checkAsync('P1-01 不携带确认 + roots 内路径 → 与修复前基线值 deepEqual（ok:true/kind:text/内容原样/size=字节数/truncated:false）', async () => {
      const content = '你好，Claude Link\nsecond line\n';
      const file = path.join(rootA, 'hello.txt');
      fs.writeFileSync(file, content, 'utf8');
      const r = await preview(file, { roots: [rootA] });
      assert.deepStrictEqual(r, { ok: true, kind: 'text', content, size: Buffer.byteLength(content, 'utf8'), truncated: false });
    });

    // —— P1-02【正常】携带确认 + roots 内路径 → 与不携带 deepEqual（roots 内对确认参零敏感） ——
    await checkAsync('P1-02 携带确认(严格 true) + roots 内路径 → 与不携带返回 deepEqual（不出现确认步骤、不出现新文案、结果零差异）', async () => {
      const content = '确认参不敏感对照\nline2\n';
      const file = path.join(rootA, 'hello-confirm.txt');
      fs.writeFileSync(file, content, 'utf8');
      const rPlain = await preview(file, { roots: [rootA] });
      const rConfirm = await preview(file, { roots: [rootA], confirmOutsideRoot: true });
      assert.deepStrictEqual(rConfirm, rPlain);
    });

    // —— P1-03【异常】roots 外 + 不携带确认 → 拒绝且结果不含任何内容字段（A8 可观测等价） ——
    await checkAsync('P1-03 roots 外 + 不携带确认 → ok:false「不在工作区内」且结果对象不含 content/base64 字段（fail-closed 红线）', async () => {
      const file = path.join(rootB, 'secret.txt');
      fs.writeFileSync(file, 'outside', 'utf8');
      const r = await preview(file, { roots: [rootA] });
      expectFail(r, '不在工作区内');
      const o = r as Record<string, unknown>;
      assert.ok(!('content' in o), '拒绝结果不得含 content 字段（未读取内容的可观测等价）');
      assert.ok(!('base64' in o), '拒绝结果不得含 base64 字段（未读取内容的可观测等价）');
      assert.strictEqual(o.code, 'outside-root', 'containment 拒绝应携带 code:"outside-root"（抽屉「仍然预览」按钮渲染唯一耦合字段，实现漏写时按钮永不渲染而全链仍绿）');
    });

    // —— P1-04【正常】携带确认 + roots 外可读文件 → 按既有全部规则成功（文本与 blob 双形态） ——
    await checkAsync('P1-04 携带确认 + roots 外可读文件 → txt/blob 双形态按既有规则成功，与 roots 内同规则逐项同形', async () => {
      const textContent = '确认后预览全文\nline2\n';
      fs.writeFileSync(path.join(rootA, 'twin.txt'), textContent, 'utf8');
      fs.writeFileSync(path.join(rootB, 'confirmed.txt'), textContent, 'utf8');
      const rTxt = await preview(path.join(rootB, 'confirmed.txt'), { roots: [rootA], confirmOutsideRoot: true });
      const t = expectText(rTxt);
      assert.strictEqual(t.content, textContent, 'content 应为全文');
      assert.strictEqual(t.truncated, false, '短文本不截断');
      assert.strictEqual(t.size, Buffer.byteLength(textContent, 'utf8'), 'size=字节数');
      // 与 roots 内同规则逐项同形（结果对象不含路径信息 → 整体 deepEqual）
      const twinTxt = await preview(path.join(rootA, 'twin.txt'), { roots: [rootA] });
      assert.deepStrictEqual(rTxt, twinTxt);

      const pngBuf = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG 魔数
        Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]), // 随意字节（分类按扩展名，不验内容）
      ]);
      fs.writeFileSync(path.join(rootA, 'twin.png'), pngBuf);
      fs.writeFileSync(path.join(rootB, 'confirmed.png'), pngBuf);
      const rPng = await preview(path.join(rootB, 'confirmed.png'), { roots: [rootA], confirmOutsideRoot: true });
      const oPng = rPng as Record<string, unknown>;
      assert.strictEqual(oPng?.ok, true, `期待 ok:true，实际 ${summarize(rPng)}`);
      assert.strictEqual(oPng?.kind, 'blob', `期待 kind:blob，实际 ${summarize(rPng)}`);
      assert.strictEqual(oPng?.category, 'image', `category 应为 image，实际 ${String(oPng?.category)}`);
      assert.strictEqual(oPng?.mime, 'image/png', `mime 应为 image/png，实际 ${String(oPng?.mime)}`);
      assert.strictEqual(oPng?.size, pngBuf.length, `size 应为 ${pngBuf.length}，实际 ${String(oPng?.size)}`);
      assert.ok(Buffer.from(String(oPng?.base64), 'base64').equals(pngBuf), 'base64 解回字节应与写入一致');
      const twinPng = await preview(path.join(rootA, 'twin.png'), { roots: [rootA] });
      assert.deepStrictEqual(rPng, twinPng);
    });

    // —— P1-05【边界】确认不豁免入参守卫：非字符串 / 相对路径 + 确认 → 仍「路径无效」 ——
    await checkAsync('P1-05 确认不豁免入参守卫：null / 相对路径 + 确认 → 仍 ok:false「路径无效」', async () => {
      expectFail(await preview(null, { roots: [rootA], confirmOutsideRoot: true }), '路径无效', true);
      expectFail(await preview('relative/path.txt', { roots: [rootA], confirmOutsideRoot: true }), '路径无效', true);
    });

    // —— P1-06【边界】确认不豁免其他校验组（参数化 5 子形态，各自独立报告） ——
    await checkAsync('P1-06-1 确认 + roots 外目录 → ok:false message 含「目录」（目录分流保留，不被确认改道）', async () => {
      const dir = path.join(rootB, 'subdir');
      fs.mkdirSync(dir);
      expectFail(await preview(dir, { roots: [rootA], confirmOutsideRoot: true }), '目录', true);
    });
    await checkAsync('P1-06-2 确认 + roots 外不存在路径 → ok:true kind:missing（missing 语义保留，不被确认改道）', async () => {
      const r = await preview(path.join(rootB, 'no-such-file.txt'), { roots: [rootA], confirmOutsideRoot: true });
      const o = r as Record<string, unknown>;
      assert.strictEqual(o?.ok, true, `期待 ok:true，实际 ${summarize(r)}`);
      assert.strictEqual(o?.kind, 'missing', `期待 kind:missing，实际 ${summarize(r)}`);
      assert.ok(!('code' in o), 'missing 形态不应携带 code 字段（code 仅限 outside-root 拒绝形态）');
    });
    await checkAsync('P1-06-3 确认 + roots 外 .doc 与 .ppt → ok:false message 含「旧版」（扩展分流保留）', async () => {
      const doc = path.join(rootB, 'legacy.doc');
      const ppt = path.join(rootB, 'legacy.ppt');
      fs.writeFileSync(doc, 'fake', 'utf8');
      fs.writeFileSync(ppt, 'fake', 'utf8');
      expectFail(await preview(doc, { roots: [rootA], confirmOutsideRoot: true }), '旧版', true);
      expectFail(await preview(ppt, { roots: [rootA], confirmOutsideRoot: true }), '旧版', true);
    });
    await checkAsync('P1-06-4 确认 + roots 外 >24MB 假 pdf → ok:false message 含「过大」（大小上限保留）', async () => {
      const file = path.join(rootB, 'huge.pdf');
      fs.writeFileSync(file, Buffer.alloc(MAX_PDF + 1));
      expectFail(await preview(file, { roots: [rootA], confirmOutsideRoot: true }), '过大', true);
    });
    await checkAsync('P1-06-5 确认 + roots 外含 NUL 的 .txt → ok:false message 含「二进制」（二进制启发保留）', async () => {
      const file = path.join(rootB, 'nul.txt');
      fs.writeFileSync(file, Buffer.from([0x61, 0x00, 0x62]));
      expectFail(await preview(file, { roots: [rootA], confirmOutsideRoot: true }), '二进制', true);
    });

    // —— P1-07【边界】确认 + roots 外 >256KB 文本 → 截断纪律原样（ASCII + 多字节恰跨边界） ——
    await checkAsync('P1-07 确认 + roots 外 >256KB 文本 → truncated:true / content 恰 256*1024 字符无 U+FFFD / 多字节恰跨边界落完整字符', async () => {
      const ascii = path.join(rootB, 'ascii-over.txt');
      fs.writeFileSync(ascii, 'a'.repeat(MAX_TEXT + 1), 'utf8');
      const ra = expectText(await preview(ascii, { roots: [rootA], confirmOutsideRoot: true }));
      assert.strictEqual(ra.truncated, true);
      assert.strictEqual(ra.content.length, MAX_TEXT);
      assert.ok(!ra.content.includes('\uFFFD'), 'ASCII 边界不应产生 U+FFFD');

      const mb = path.join(rootB, 'mb-boundary.txt');
      // 'a'×(MAX_TEXT-1) + '水'（3 字节）：总字节 MAX_TEXT+2 > MAX_TEXT；前 MAX_TEXT 字节恰含
      // 「水」的首字节 → 非致命解码尾部产生一个 U+FFFD，实现须去掉恰好一个（同既有 F2 钉口径）。
      const mbContent = 'a'.repeat(MAX_TEXT - 1) + '水';
      fs.writeFileSync(mb, mbContent, 'utf8');
      const rm = expectText(await preview(mb, { roots: [rootA], confirmOutsideRoot: true }));
      assert.strictEqual(rm.truncated, true);
      assert.strictEqual(rm.content, mbContent.slice(0, MAX_TEXT - 1), '截断应落在完整字符边界');
      assert.ok(!rm.content.endsWith('\uFFFD'), '尾部不得残留 U+FFFD');
    });

    // —— P1-08【异常】确认 + 路径某段为文件（穿越 file 型段）→ 走 fs 异常归一出口，不裸抛 ——
    await checkAsync('P1-08 确认 + 穿越文件型段（<rootB>\\file.txt\\sub.txt）→ 归一出口不裸抛（win32: ok:true kind:missing / POSIX: ok:false「无法读取文件」）', async () => {
      fs.writeFileSync(path.join(rootB, 'file.txt'), 'plain', 'utf8');
      const through = path.join(rootB, 'file.txt', 'sub.txt');
      const r = await preview(through, { roots: [rootA], confirmOutsideRoot: true });
      // 公共不变式：调用不抛未捕获异常（抛出即本检查失败）；返回为归一出口（非裸错误对象）。
      assert.ok(r !== null && typeof r === 'object' && !(r instanceof Error), `返回应为归一形态对象，实际 ${summarize(r)}`);
      assert.ok('ok' in (r as object), '归一形态应含 ok 判别字段');
      if (process.platform === 'win32') {
        const o = r as Record<string, unknown>;
        assert.strictEqual(o?.ok, true, `期待 ok:true，实际 ${summarize(r)}`);
        assert.strictEqual(o?.kind, 'missing', `期待 kind:missing（本机实测 stat 穿越文件型段抛 ENOENT → ⑦ 归一），实际 ${summarize(r)}`);
      } else {
        expectFail(r, '无法读取文件');
      }
    });

    // —— P1-09【并发/状态】确认按请求生效、不留模块级放行态（顺序残留 + 并发互扰双断言） ——
    const fileA = path.join(rootB, 'state-a.txt');
    const fileB = path.join(rootB, 'state-b.txt');
    fs.writeFileSync(fileA, 'outside-A', 'utf8');
    fs.writeFileSync(fileB, 'outside-B', 'utf8');
    await checkAsync('P1-09-1 携带确认读 A 成功 → 紧接不携带确认再读 A → 仍 ok:false「不在工作区内」（无顺序残留放行态）', async () => {
      const ok = expectText(await preview(fileA, { roots: [rootA], confirmOutsideRoot: true }));
      assert.strictEqual(ok.content, 'outside-A');
      expectFail(await preview(fileA, { roots: [rootA] }), '不在工作区内');
    });
    await checkAsync('P1-09-2 携带确认读 A 成功后 → 不携带确认读 roots 外文件 B → 仍拒绝（确认不跨文件泄漏）', async () => {
      expectText(await preview(fileA, { roots: [rootA], confirmOutsideRoot: true }));
      expectFail(await preview(fileB, { roots: [rootA] }), '不在工作区内');
    });
    await checkAsync('P1-09-3 Promise.all 并发混合（确认 A / 不确认 B / 不确认 A）→ 三者互不串扰，仅携带者成功', async () => {
      const [ra, rb1, rb2] = await Promise.all([
        preview(fileA, { roots: [rootA], confirmOutsideRoot: true }),
        preview(fileB, { roots: [rootA] }),
        preview(fileA, { roots: [rootA] }),
      ]);
      const oa = expectText(ra);
      assert.strictEqual(oa.content, 'outside-A');
      expectFail(rb1, '不在工作区内');
      expectFail(rb2, '不在工作区内');
    });

    // —— P1-10【边界】脏值确认参不放行：'true' / 1 / null / 缺省 → 一律视为未确认（A2 严格判） ——
    await checkAsync("P1-10 脏值确认参不放行：'true' / 1 / null / 缺省 → 全部 ok:false「不在工作区内」（仅严格 true 生效）", async () => {
      expectFail(await preview(fileA, { roots: [rootA], confirmOutsideRoot: 'true' as unknown as boolean }), '不在工作区内');
      expectFail(await preview(fileA, { roots: [rootA], confirmOutsideRoot: 1 as unknown as boolean }), '不在工作区内');
      expectFail(await preview(fileA, { roots: [rootA], confirmOutsideRoot: null as unknown as boolean }), '不在工作区内');
      expectFail(await preview(fileA, { roots: [rootA] }), '不在工作区内');
    });
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }

  console.log('\n=== P1 结构钉 ===');
  // —— P1-11【结构钉】桌面网页同形：FS_READ_PREVIEW 通道三处同步核验 ——
  check('P1-11 通道三处同步：ipc.ts 含 FS_READ_PREVIEW 通道字面+confirmOutsideRoot 注记字面 / preload api.ts 含 confirmOutsideRoot（签名与实现 ≥2 处）/ web-bridge.ts 含 readFilePreview 表项字面', () => {
    const ipcSrc = fs.readFileSync(new URL('../src/shared/types/ipc.ts', import.meta.url), 'utf8');
    assert.ok(ipcSrc.includes('FS_READ_PREVIEW'), 'ipc.ts 缺 FS_READ_PREVIEW 通道字面');
    assert.ok(ipcSrc.includes('confirmOutsideRoot'), 'ipc.ts 缺 confirmOutsideRoot 载荷注记字面（RED：确认语义未入通道载荷，现状注记为「invoke 直传 path 字符串」）');
    const apiSrc = fs.readFileSync(new URL('../src/preload/api.ts', import.meta.url), 'utf8');
    const apiHits = apiSrc.match(/confirmOutsideRoot/g) ?? [];
    assert.ok(apiHits.length >= 2, `preload/api.ts 应含 confirmOutsideRoot 字面（签名与实现两处同步），实际命中 ${apiHits.length} 处`);
    assert.ok(apiSrc.includes('confirmOutsideRoot === true'), 'preload/api.ts 缺 confirmOutsideRoot === true 实现字面（实现须恒发布尔透传第 2 参，回退单参则桌面确认语义静默失效）');
    // 行级锚定（round-004 M1 修复）：归一逻辑必须与形参声明同在一条实现行内。仅整文件 includes 不设防于
    // 「注释里保留该字面、实现回退单参」的对抗形态（该形态下本组前一条 includes 断言仍绿、类型闸门对
    // 可选参回退亦不拦，桌面确认语义已静默失效却全链绿）；注释行不含实现行前缀，此钉将其封死。
    const implLineAnchored = apiSrc.split(/\r?\n/).some((line) => line.includes('readFilePreview: (path, confirmOutsideRoot)') && line.includes('confirmOutsideRoot === true'));
    assert.ok(implLineAnchored, 'preload/api.ts 行级锚定失败：不存在同时含「readFilePreview: (path, confirmOutsideRoot)」实现行前缀与「confirmOutsideRoot === true」归一字面的实现行——归一逻辑与形参声明必须同在一条实现行内（防「注释保留该字面、实现回退单参」对抗形态：该形态整文件 includes 断言仍绿而桌面确认语义已静默失效，类型闸门对可选参回退亦不拦）');
    const bridgeSrc = fs.readFileSync(new URL('../src/renderer/web/web-bridge.ts', import.meta.url), 'utf8');
    assert.ok(bridgeSrc.includes('readFilePreview'), 'web-bridge.ts 缺 readFilePreview 表项字面');
    const handlerSrc = fs.readFileSync(new URL('../src/main/ipc-handlers.ts', import.meta.url), 'utf8');
    assert.ok(handlerSrc.includes('confirmOutsideRoot === true'), 'ipc-handlers.ts 缺 confirmOutsideRoot === true 归一字面（handler 须把确认参严格归一后传 previewFile，脏值不放行）');
  });

  // —— P1-12【结构钉】UI 层「仍然预览」操作存在且与 containment 形态唯一耦合 ——
  check('P1-12 FilePreviewDrawer.vue「仍然预览」字面 / readFilePreview( 恰 1 处（确认重试复用 load 链路不旁路直调 IPC）/ watch 与确认复位语义字面同现', () => {
    const src = fs.readFileSync(new URL('../src/renderer/components/preview/FilePreviewDrawer.vue', import.meta.url), 'utf8');
    assert.ok(src.includes('仍然预览'), '缺「仍然预览」操作文案字面（RED：UI 无确认后预览出路）');
    const callHits = src.match(/readFilePreview\(/g) ?? [];
    assert.strictEqual(callHits.length, 1, `readFilePreview( 应恰出现 1 次（确认重试复用 load 链路、不旁路直调 IPC），实际 ${callHits.length} 处`);
    assert.ok(src.includes('watch'), '缺 watch 字面（确认态复位接线）');
    // 宽松钉：确认复位语义取确认载荷字段名同现（实现传递 IPC 确认参必然引用该字段名；
    // watch 复位该确认态 → 两字面同现即接线成立，不钉内部变量名）。
    assert.ok(src.includes('confirmOutsideRoot'), '缺确认复位语义字面 confirmOutsideRoot（应与 watch 同现）');
    // 实质钉（round-002 F1-c/f）：双参调用字面防回退单参（可选参类型闸门不拦）；
    // 复位赋值字面 + watch( 接线同现，防 confirmOutsideRoot 仅命中函数名而复位行被删仍绿。
    assert.ok(src.includes('readFilePreview(store.path, outsideRootConfirmed)'), '缺双参调用字面 readFilePreview(store.path, outsideRootConfirmed)（确认参须随 load 链路传入）');
    assert.ok(src.includes("result.code === 'outside-root'"), '缺 result.code === \'outside-root\' 字面（「仍然预览」按钮与 containment 拒绝形态唯一耦合）');
    assert.ok(src.includes('.fpreview-empty__action'), '缺 .fpreview-empty__action 样式类字面（行动钮样式存在钉）');
    assert.ok(src.includes('outsideRootConfirmed = false'), '缺确认态复位赋值字面 outsideRootConfirmed = false（换文件/重开抽屉须复位确认位）');
    assert.ok(src.includes('watch('), '缺 watch( 接线字面（确认态复位须挂在 watch 上）');
  });

  console.log('\n=== selftest 清单登记 ===');
  check('selftest-static-list.txt 已登记本脚本', () => {
    const list = fs.readFileSync(new URL('selftest-static-list.txt', import.meta.url), 'utf8');
    const registered = list
      .split(/\r?\n/)
      .map((l) => l.trim())
      .includes('scripts/tdd-preview-outside-root-verify.ts');
    assert.ok(registered, '清单未登记 scripts/tdd-preview-outside-root-verify.ts');
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
})().catch((e: unknown) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
