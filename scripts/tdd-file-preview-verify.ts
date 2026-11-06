// tdd-file-preview-verify.ts
// 文件预览面板（2026-11-04 计划 round-001 p1）主进程 FS_READ_PREVIEW 分发表契约钉：
//   ① 上限常量值钉（MAX_TEXT/IMAGE/MEDIA/PDF/DOCX/XLSX/PPTX，计算式断言不写字面串）；
//   ② EXT_CATEGORY 分发表全量钉（扩展名 → category/mime）；
//   ③ isProbablyBinary 启发式（前 8KB 含 0x00）；
//   ④ previewFile 行为组（mkdtemp fixture，测完清理）：文本/256KB 截断与多字节 UTF-8 边界
//      （尾部不残留 U+FFFD）/NUL 拒绝/0 字节/missing/目录/边界外 fail-closed/大小写归一/
//      .doc .ppt 旧版拒绝/超大 blob 拒绝/入参形状守卫；round-002 补钉：恰满 MAX_TEXT 不截/
//      小 PNG blob 分发与 base64 还原/pptx·mp4 超限文案/根内 symlink→根外拒绝（F1 containment
//      realpath 规范化，Windows 无特权时跳过）/根内普通文件对照放行。
// 仅 node:* + 被测模块导入，不 import electron（主进程模块 tsx 直测前提）。
// 运行：npx tsx scripts/tdd-file-preview-verify.ts（已登记 scripts/selftest-static-list.txt）

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EXT_CATEGORY,
  MAX_TEXT,
  MAX_IMAGE,
  MAX_MEDIA,
  MAX_PDF,
  MAX_DOCX,
  MAX_XLSX,
  MAX_PPTX,
  isProbablyBinary,
  previewFile,
} from '../src/main/modules/fs-preview';
import { previewFormatInfo, extOfPath, base64ToUint8Array } from '../src/renderer/utils/preview-format';
import { resolveFileLinkHref, isAbsolutePathForm } from '../src/renderer/utils/file-link';
import { renderMarkdown, setFileLinkWorkspaceRoot } from '../src/renderer/utils/markdown';

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

/** 跳过哨兵：需特权的场景（symlink）创建失败时内部抛出，该检查既不计 pass 也不计 fail。 */
const SKIP = '__skip__';
async function checkAsyncSkippable(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) {
    if ((e as Error)?.message === SKIP) {
      console.log(`  ⏭ ${name} — [skip] symlink 创建失败（无特权），本项人工环境验证`);
      return;
    }
    fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
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

/** 断言 ok:false 且 message 含指定子串。 */
function expectFail(r: unknown, msgContains: string): void {
  const o = r as Record<string, unknown>;
  assert.strictEqual(o?.ok, false, `期待 ok:false，实际 ${summarize(r)}`);
  assert.ok(String(o?.message ?? '').includes(msgContains), `message 应含「${msgContains}」，实际：${String(o?.message)}`);
}

void (async (): Promise<void> => {
  console.log('\n=== ① 上限常量值钉（计算式） ===');
  check('MAX_TEXT === 256*1024', () => assert.strictEqual(MAX_TEXT, 256 * 1024));
  check('MAX_IMAGE === 8*1024*1024', () => assert.strictEqual(MAX_IMAGE, 8 * 1024 * 1024));
  check('MAX_MEDIA === 8*1024*1024', () => assert.strictEqual(MAX_MEDIA, 8 * 1024 * 1024));
  check('MAX_PDF === 24*1024*1024', () => assert.strictEqual(MAX_PDF, 24 * 1024 * 1024));
  check('MAX_DOCX === 8*1024*1024', () => assert.strictEqual(MAX_DOCX, 8 * 1024 * 1024));
  check('MAX_XLSX === 8*1024*1024', () => assert.strictEqual(MAX_XLSX, 8 * 1024 * 1024));
  check('MAX_PPTX === 30*1024*1024', () => assert.strictEqual(MAX_PPTX, 30 * 1024 * 1024));

  console.log('\n=== ② EXT_CATEGORY 分发表全量钉 ===');
  const EXPECTED_EXT: Array<[string, string, string]> = [
    ['png', 'image', 'image/png'],
    ['jpg', 'image', 'image/jpeg'],
    ['jpeg', 'image', 'image/jpeg'],
    ['gif', 'image', 'image/gif'],
    ['webp', 'image', 'image/webp'],
    ['bmp', 'image', 'image/bmp'],
    ['ico', 'image', 'image/x-icon'],
    ['mp4', 'media', 'video/mp4'],
    ['webm', 'media', 'video/webm'],
    ['mov', 'media', 'video/quicktime'],
    ['mp3', 'media', 'audio/mpeg'],
    ['wav', 'media', 'audio/wav'],
    ['flac', 'media', 'audio/flac'],
    ['ogg', 'media', 'audio/ogg'],
    ['m4a', 'media', 'audio/mp4'],
    ['weba', 'media', 'audio/webm'],
    ['pdf', 'pdf', 'application/pdf'],
    ['docx', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['xlsx', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['xls', 'xlsx', 'application/vnd.ms-excel'],
    ['pptx', 'pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ];
  check(`EXT_CATEGORY 恰含 ${EXPECTED_EXT.length} 个扩展名且逐项 category/mime 正确`, () => {
    assert.strictEqual(Object.keys(EXT_CATEGORY).length, EXPECTED_EXT.length,
      `实际键数 ${Object.keys(EXT_CATEGORY).length}，键集：${Object.keys(EXT_CATEGORY).join(',')}`);
    for (const [ext, category, mime] of EXPECTED_EXT) {
      const hit = EXT_CATEGORY[ext];
      assert.ok(hit, `缺扩展名 ${ext}`);
      assert.strictEqual(hit.category, category, `${ext} category 应为 ${category}`);
      assert.strictEqual(hit.mime, mime, `${ext} mime 应为 ${mime}`);
    }
  });

  console.log('\n=== ③ isProbablyBinary 启发式 ===');
  check('前 8KB 内含 0x00 → true', () => {
    const buf = Buffer.alloc(1024, 0x61);
    buf[100] = 0;
    assert.strictEqual(isProbablyBinary(buf), true);
  });
  check('纯可打印文本（无 0x00）→ false', () => {
    assert.strictEqual(isProbablyBinary(Buffer.from('plain text file\nsecond line', 'utf8')), false);
  });
  check('0x00 落在 8KB 窗口之外（offset 9000）→ false', () => {
    const buf = Buffer.alloc(10000, 0x61);
    buf[9000] = 0;
    assert.strictEqual(isProbablyBinary(buf), false);
  });

  console.log('\n=== ④ previewFile 行为组 ===');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-preview-test-'));
  try {
    await checkAsync('入参形状守卫：非字符串 / 相对路径 → ok:false「路径无效」', async () => {
      expectFail(await previewFile(null, { roots: [fixtureRoot] }), '路径无效');
      expectFail(await previewFile(undefined, { roots: [fixtureRoot] }), '路径无效');
      expectFail(await previewFile('relative/path.txt', { roots: [fixtureRoot] }), '路径无效');
    });
    await checkAsync('workspace 内 txt → ok:true kind:text truncated:false（内容原样、size=字节数）', async () => {
      const file = path.join(fixtureRoot, 'hello.txt');
      const content = '你好，Claude Link\nsecond line\n';
      fs.writeFileSync(file, content, 'utf8');
      const r = expectText(await previewFile(file, { roots: [fixtureRoot] }));
      assert.strictEqual(r.truncated, false);
      assert.strictEqual(r.content, content);
      assert.strictEqual(r.size, Buffer.byteLength(content, 'utf8'));
    });
    await checkAsync('>256KB 纯 ASCII → truncated:true，content 恰 256*1024 字符且无 U+FFFD', async () => {
      const file = path.join(fixtureRoot, 'ascii-over.txt');
      fs.writeFileSync(file, 'a'.repeat(MAX_TEXT + 1), 'utf8');
      const r = expectText(await previewFile(file, { roots: [fixtureRoot] }));
      assert.strictEqual(r.truncated, true);
      assert.strictEqual(r.content.length, MAX_TEXT);
      assert.ok(!r.content.includes('\uFFFD'), 'ASCII 边界不应产生 U+FFFD');
    });
    await checkAsync('多字节 UTF-8 恰跨 256KB 边界 → 无尾部 U+FFFD 残留（content = MAX_TEXT-1 字符）', async () => {
      const file = path.join(fixtureRoot, 'mb-boundary.txt');
      // 'a'×(MAX_TEXT-1) + '水'（3 字节）：总字节 MAX_TEXT+2 > MAX_TEXT；前 MAX_TEXT 字节恰含
      // 「水」的首字节 → 非致命解码尾部产生一个 U+FFFD，实现须去掉恰好一个。
      const content = 'a'.repeat(MAX_TEXT - 1) + '水';
      fs.writeFileSync(file, content, 'utf8');
      const r = expectText(await previewFile(file, { roots: [fixtureRoot] }));
      assert.strictEqual(r.truncated, true);
      assert.strictEqual(r.content, content.slice(0, MAX_TEXT - 1), '截断应落在完整字符边界');
      assert.ok(!r.content.endsWith('\uFFFD'), '尾部不得残留 U+FFFD');
    });
    await checkAsync('含 NUL 的 .txt → ok:false 且 message 含「二进制」', async () => {
      const file = path.join(fixtureRoot, 'nul.txt');
      fs.writeFileSync(file, Buffer.from([0x61, 0x00, 0x62]));
      expectFail(await previewFile(file, { roots: [fixtureRoot] }), '二进制');
    });
    await checkAsync('0 字节文件 → ok:true content===\'\' truncated:false', async () => {
      const file = path.join(fixtureRoot, 'empty.txt');
      fs.writeFileSync(file, Buffer.alloc(0));
      const r = expectText(await previewFile(file, { roots: [fixtureRoot] }));
      assert.strictEqual(r.content, '');
      assert.strictEqual(r.size, 0);
      assert.strictEqual(r.truncated, false);
    });
    await checkAsync('不存在的路径 → ok:true kind:missing', async () => {
      const r = await previewFile(path.join(fixtureRoot, 'no-such-file.txt'), { roots: [fixtureRoot] });
      const o = r as Record<string, unknown>;
      assert.strictEqual(o?.ok, true, `期待 ok:true，实际 ${summarize(r)}`);
      assert.strictEqual(o?.kind, 'missing', `期待 kind:missing，实际 ${summarize(r)}`);
    });
    await checkAsync('目录 → ok:false（目录不支持预览）', async () => {
      const dir = path.join(fixtureRoot, 'subdir');
      fs.mkdirSync(dir);
      expectFail(await previewFile(dir, { roots: [fixtureRoot] }), '目录');
    });
    await checkAsync('roots 外路径 → ok:false 且 message 含「不在工作区内」（fail-closed 红线）', async () => {
      const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-preview-other-'));
      try {
        const file = path.join(otherRoot, 'secret.txt');
        fs.writeFileSync(file, 'outside', 'utf8');
        expectFail(await previewFile(file, { roots: [fixtureRoot] }), '不在工作区内');
      } finally {
        fs.rmSync(otherRoot, { recursive: true, force: true });
      }
    });
    await checkAsync('根下名为 ..foo.txt 的合法文件 → 通过 containment（rel=\'..foo.txt\' 非「..」或「..+sep」前缀，R1 退回回归钉）', async () => {
      const file = path.join(fixtureRoot, '..foo.txt');
      fs.writeFileSync(file, 'dotdot-name-ok', 'utf8');
      const r = expectText(await previewFile(file, { roots: [fixtureRoot] }));
      assert.strictEqual(r.truncated, false);
      assert.strictEqual(r.content, 'dotdot-name-ok');
    });
    await checkAsync('root 同级兄弟目录（basename+_bar，不以 root+sep 前缀）→ 仍拒绝「不在工作区内」（防修复放开逃逸口）', async () => {
      const siblingRoot = path.join(path.dirname(fixtureRoot), `${path.basename(fixtureRoot)}_bar`);
      fs.mkdirSync(siblingRoot, { recursive: true });
      try {
        const file = path.join(siblingRoot, 'x.txt');
        fs.writeFileSync(file, 'sibling', 'utf8');
        expectFail(await previewFile(file, { roots: [fixtureRoot] }), '不在工作区内');
      } finally {
        fs.rmSync(siblingRoot, { recursive: true, force: true });
      }
    });
    await checkAsync('roots 大小写不同（root 传小写盘段）→ 可通过（win 路径大小写归一）', async () => {
      const first = fixtureRoot.charAt(0);
      assert.ok(first === first.toUpperCase() && first !== first.toLowerCase(),
        `fixture 应为大写盘符路径，实际 ${fixtureRoot}`);
      const lowerRoot = first.toLowerCase() + fixtureRoot.slice(1);
      const file = path.join(fixtureRoot, 'case.txt');
      fs.writeFileSync(file, 'case-ok', 'utf8');
      const r = await previewFile(file, { roots: [lowerRoot] });
      const o = r as Record<string, unknown>;
      assert.strictEqual(o?.ok, true, `小写盘段 root 应命中，实际 ${summarize(r)}`);
    });
    await checkAsync('.doc 与 .ppt → ok:false 且 message 含「旧版」', async () => {
      const doc = path.join(fixtureRoot, 'legacy.doc');
      const ppt = path.join(fixtureRoot, 'legacy.ppt');
      fs.writeFileSync(doc, 'fake', 'utf8');
      fs.writeFileSync(ppt, 'fake', 'utf8');
      expectFail(await previewFile(doc, { roots: [fixtureRoot] }), '旧版');
      expectFail(await previewFile(ppt, { roots: [fixtureRoot] }), '旧版');
    });
    await checkAsync('>24MB 假 pdf → ok:false 且 message 含「过大」（blob 上限截停）', async () => {
      const file = path.join(fixtureRoot, 'huge.pdf');
      fs.writeFileSync(file, Buffer.alloc(MAX_PDF + 1));
      expectFail(await previewFile(file, { roots: [fixtureRoot] }), '过大');
    });
    // —— round-002 F2 契约补钉 ——
    await checkAsync('恰 MAX_TEXT 字节纯 ASCII 文本 → truncated:false 且 content 字符数与写入完全一致（F2①）', async () => {
      const file = path.join(fixtureRoot, 'ascii-exact.txt');
      const content = 'a'.repeat(MAX_TEXT); // 1 字节/字符 → 文件恰 MAX_TEXT 字节，不越截断线
      fs.writeFileSync(file, content, 'utf8');
      const r = expectText(await previewFile(file, { roots: [fixtureRoot] }));
      assert.strictEqual(r.truncated, false);
      assert.strictEqual(r.content, content);
      assert.strictEqual(r.size, MAX_TEXT);
    });
    await checkAsync('小 PNG（合法 8 字节魔数+随意字节）→ kind:blob category image mime image/png size 正确 base64 还原一致（F2②）', async () => {
      const file = path.join(fixtureRoot, 'tiny.png');
      const buf = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG 魔数
        Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]), // 随意字节（分类按扩展名，不验内容）
      ]);
      fs.writeFileSync(file, buf);
      const r = await previewFile(file, { roots: [fixtureRoot] });
      const o = r as Record<string, unknown>;
      assert.strictEqual(o?.ok, true, `期待 ok:true，实际 ${summarize(r)}`);
      assert.strictEqual(o?.kind, 'blob', `期待 kind:blob，实际 ${summarize(r)}`);
      assert.strictEqual(o?.category, 'image', `category 应为 image，实际 ${String(o?.category)}`);
      assert.strictEqual(o?.mime, 'image/png', `mime 应为 image/png，实际 ${String(o?.mime)}`);
      assert.strictEqual(o?.size, buf.length, `size 应为 ${buf.length}，实际 ${String(o?.size)}`);
      assert.ok(Buffer.from(String(o?.base64), 'base64').equals(buf), 'base64 解回字节应与写入一致');
    });
    await checkAsync('>30MB 假 pptx → ok:false 且 message 含「过大（>30 MB）」（F2③）', async () => {
      const file = path.join(fixtureRoot, 'huge.pptx');
      fs.writeFileSync(file, Buffer.alloc(MAX_PPTX + 1));
      expectFail(await previewFile(file, { roots: [fixtureRoot] }), '过大（>30 MB）');
    });
    await checkAsync('>8MB 假 mp4 → ok:false 且 message 含「过大」（F2④）', async () => {
      const file = path.join(fixtureRoot, 'huge.mp4');
      fs.writeFileSync(file, Buffer.alloc(MAX_MEDIA + 1));
      expectFail(await previewFile(file, { roots: [fixtureRoot] }), '过大');
    });
    // —— round-002 F1 containment realpath 规范化钉 ——
    await checkAsyncSkippable('根内 symlink 指向根外文件 → ok:false「不在工作区内」（F1 realpath 规范化，防符号链接逃逸）', async () => {
      const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-preview-outside-'));
      try {
        const secret = path.join(outsideRoot, 'secret.txt');
        fs.writeFileSync(secret, 'outside-secret', 'utf8');
        const link = path.join(fixtureRoot, 'evil-link.txt');
        try {
          fs.symlinkSync(secret, link, 'file');
        } catch {
          throw new Error(SKIP); // Windows 无符号链接特权 → 本项跳过，不红不绿不计失败
        }
        expectFail(await previewFile(link, { roots: [fixtureRoot] }), '不在工作区内');
      } finally {
        fs.rmSync(outsideRoot, { recursive: true, force: true });
      }
    });
    await checkAsync('根内普通文件 → 仍放行（F1 realpath 规范化对照钉，防规范化误伤正常路径）', async () => {
      const file = path.join(fixtureRoot, 'normal-control.txt');
      fs.writeFileSync(file, 'normal-control-ok', 'utf8');
      const r = expectText(await previewFile(file, { roots: [fixtureRoot] }));
      assert.strictEqual(r.truncated, false);
      assert.strictEqual(r.content, 'normal-control-ok');
    });
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }

  console.log('\n=== ⑤ selftest 清单登记 ===');
  check('selftest-static-list.txt 已登记本脚本', () => {
    const list = fs.readFileSync(new URL('selftest-static-list.txt', import.meta.url), 'utf8');
    assert.ok(list.includes('scripts/tdd-file-preview-verify.ts'), '清单未登记');
  });

  console.log('\n=== ⑥ 渲染层 preview-format（p2） ===');
  check("previewFormatInfo('md', null) → ['preview','source'] / 'preview'", () => {
    const info = previewFormatInfo('md', null);
    assert.deepStrictEqual(info.modes, ['preview', 'source']);
    assert.strictEqual(info.defaultMode, 'preview');
  });
  check("previewFormatInfo('html'/'htm', null) → ['web','code'] / 'web'", () => {
    for (const ext of ['html', 'htm']) {
      const info = previewFormatInfo(ext, null);
      assert.deepStrictEqual(info.modes, ['web', 'code'], `${ext} modes 不符`);
      assert.strictEqual(info.defaultMode, 'web', `${ext} defaultMode 不符`);
    }
  });
  check("previewFormatInfo('svg', null) → ['preview','source'] / 'preview'", () => {
    const info = previewFormatInfo('svg', null);
    assert.deepStrictEqual(info.modes, ['preview', 'source']);
    assert.strictEqual(info.defaultMode, 'preview');
  });
  check("previewFormatInfo('mmd', null) → ['graph','source'] / 'graph'", () => {
    const info = previewFormatInfo('mmd', null);
    assert.deepStrictEqual(info.modes, ['graph', 'source']);
    assert.strictEqual(info.defaultMode, 'graph');
  });
  check("previewFormatInfo('txt', null) → 单态（modes 空 / default null）", () => {
    const info = previewFormatInfo('txt', null);
    assert.deepStrictEqual(info.modes, []);
    assert.strictEqual(info.defaultMode, null);
  });
  check("category 非空优先单态：previewFormatInfo('md', 'pdf') → modes 空", () => {
    const info = previewFormatInfo('md', 'pdf');
    assert.deepStrictEqual(info.modes, []);
    assert.strictEqual(info.defaultMode, null);
  });
  check("大写 'PNG' → 与 'png' 同判（单态；函数内 toLowerCase 兜底）", () => {
    const lower = previewFormatInfo('png', null);
    const upper = previewFormatInfo('PNG', null);
    assert.deepStrictEqual(lower.modes, [], 'png 本身应为单态');
    assert.deepStrictEqual(upper.modes, lower.modes);
    assert.strictEqual(upper.defaultMode, lower.defaultMode);
    assert.strictEqual(upper.defaultMode, null);
  });
  check("extOfPath('D:\\\\a\\\\b\\\\c.TXT') → 'txt'（反斜杠分隔 + 小写归一）", () => {
    assert.strictEqual(extOfPath('D:\\a\\b\\c.TXT'), 'txt');
  });
  check("extOfPath：无点 → ''；点在末尾 → ''", () => {
    assert.strictEqual(extOfPath('/x/y/noext'), '');
    assert.strictEqual(extOfPath('a.b.'), '');
  });
  check("base64ToUint8Array('AAECAw==') → [0,1,2,3]", () => {
    assert.deepStrictEqual(Array.from(base64ToUint8Array('AAECAw==')), [0, 1, 2, 3]);
  });
  check('结构钉：use-esc-stack.ts 含 filePreviewDrawer: 1040', () => {
    const src = fs.readFileSync(new URL('../src/renderer/composables/use-esc-stack.ts', import.meta.url), 'utf8');
    assert.ok(src.includes('filePreviewDrawer: 1040'), 'use-esc-stack.ts 未登记 filePreviewDrawer: 1040');
  });
  check('结构钉：App.vue 挂载 <FilePreviewDrawer />（全局单例）', () => {
    const src = fs.readFileSync(new URL('../src/renderer/App.vue', import.meta.url), 'utf8');
    assert.ok(src.includes('<FilePreviewDrawer />'), 'App.vue 未挂载 FilePreviewDrawer');
  });
  check("结构钉：preview-store.ts 实际调用 defineStore('filePreview', {（id 字面含于调用形状；P3-E 删自证式注释钉）", () => {
    const src = fs.readFileSync(new URL('../src/renderer/stores/preview-store.ts', import.meta.url), 'utf8');
    assert.ok(src.includes("defineStore('filePreview', {"), "preview-store.ts 实际调用不是 defineStore('filePreview', { ... }");
  });
  check('结构钉：FilePreviewDrawer.vue 含 pushEscLayer 与 revoke 字面（Esc 层 + blob 释放接线）', () => {
    const src = fs.readFileSync(new URL('../src/renderer/components/preview/FilePreviewDrawer.vue', import.meta.url), 'utf8');
    assert.ok(src.includes('pushEscLayer'), 'FilePreviewDrawer.vue 未接 pushEscLayer');
    assert.ok(src.includes('revoke'), 'FilePreviewDrawer.vue 未做 blobUrl revoke');
  });

  console.log('\n=== ⑦ 文件链接解析（p3） ===');
  check("相对命中：resolveFileLinkHref('aaa.txt', 'D:\\\\ws') → { path:'D:\\\\ws\\\\aaa.txt', label:'aaa.txt' }", () => {
    assert.deepStrictEqual(resolveFileLinkHref('aaa.txt', 'D:\\ws'), { path: 'D:\\ws\\aaa.txt', label: 'aaa.txt' });
  });
  check("带子目录相对：'docs/x.md' → 'D:\\\\ws\\\\docs\\\\x.md'，label 'x.md'", () => {
    assert.deepStrictEqual(resolveFileLinkHref('docs/x.md', 'D:\\ws'), { path: 'D:\\ws\\docs\\x.md', label: 'x.md' });
  });
  check("'./' 前缀：'./y.ts' → 'D:\\\\ws\\\\y.ts'（label 'y.ts'）", () => {
    assert.deepStrictEqual(resolveFileLinkHref('./y.ts', 'D:\\ws'), { path: 'D:\\ws\\y.ts', label: 'y.ts' });
  });
  check("绝对命中：'D:\\\\ws\\\\b.md' → path 原样（反斜杠已归一）、label 'b.md'", () => {
    assert.deepStrictEqual(resolveFileLinkHref('D:\\ws\\b.md', 'D:\\other'), { path: 'D:\\ws\\b.md', label: 'b.md' });
  });
  check("正斜杠绝对：'D:/ws/b.md' → 归一反斜杠 'D:\\\\ws\\\\b.md'", () => {
    assert.deepStrictEqual(resolveFileLinkHref('D:/ws/b.md', null), { path: 'D:\\ws\\b.md', label: 'b.md' });
  });
  check("file:/// 命中：'file:///D:/ws/c.txt' → 'D:\\\\ws\\\\c.txt'", () => {
    assert.deepStrictEqual(resolveFileLinkHref('file:///D:/ws/c.txt', null), { path: 'D:\\ws\\c.txt', label: 'c.txt' });
  });
  check("file:/// 含 %20 解码：'file:///D:/ws/my%20file.txt' → 'D:\\\\ws\\\\my file.txt'", () => {
    assert.deepStrictEqual(resolveFileLinkHref('file:///D:/ws/my%20file.txt', null), { path: 'D:\\ws\\my file.txt', label: 'my file.txt' });
  });
  check("'..' 词法拒绝（B7）：'..\\\\secret.txt' / 'a/../../b' / 绝对含 '..' 全 null", () => {
    assert.strictEqual(resolveFileLinkHref('..\\secret.txt', 'D:\\ws'), null);
    assert.strictEqual(resolveFileLinkHref('a/../../b', 'D:\\ws'), null);
    assert.strictEqual(resolveFileLinkHref('D:\\ws\\..\\evil.txt', null), null);
  });
  check("scheme 拒绝：http/https/mailto/javascript 全 null", () => {
    assert.strictEqual(resolveFileLinkHref('http://x.com/a', 'D:\\ws'), null);
    assert.strictEqual(resolveFileLinkHref('https://x.com', 'D:\\ws'), null);
    assert.strictEqual(resolveFileLinkHref('mailto:a@b.c', 'D:\\ws'), null);
    assert.strictEqual(resolveFileLinkHref('javascript:alert(1)', 'D:\\ws'), null);
  });
  check("锚点拒绝：'#section' → null", () => {
    assert.strictEqual(resolveFileLinkHref('#section', 'D:\\ws'), null);
  });
  check("workspaceRoot null + 相对 → null（导出窗口未 set 天然不可点）", () => {
    assert.strictEqual(resolveFileLinkHref('aaa.txt', null), null);
    assert.strictEqual(resolveFileLinkHref('aaa.txt', '   '), null);
  });
  check("正斜杠相对：'sub/x.txt' → 归一反斜杠 'D:\\\\ws\\\\sub\\\\x.txt'", () => {
    assert.deepStrictEqual(resolveFileLinkHref('sub/x.txt', 'D:\\ws'), { path: 'D:\\ws\\sub\\x.txt', label: 'x.txt' });
  });
  check("file:/// 非法百分号编码（%ZZ）→ null（decode 失败拒绝）", () => {
    assert.strictEqual(resolveFileLinkHref('file:///D:/ws/%ZZ.txt', null), null);
  });
  check("空 href / 纯空白 → null；尾斜杠目录形态 label 空 → null", () => {
    assert.strictEqual(resolveFileLinkHref('', 'D:\\ws'), null);
    assert.strictEqual(resolveFileLinkHref('   ', 'D:\\ws'), null);
    assert.strictEqual(resolveFileLinkHref('docs/', 'D:\\ws'), null);
  });
  check('结构钉：markdown.ts link_open 覆盖（base 规则捕获 + md-file-link/data-clip-path/javascript:void(0) + setFileLinkWorkspaceRoot 导出）', () => {
    const src = fs.readFileSync(new URL('../src/renderer/utils/markdown.ts', import.meta.url), 'utf8');
    assert.ok(src.includes('md.renderer.rules.link_open'), 'markdown.ts 未覆盖 md.renderer.rules.link_open');
    assert.ok(src.includes('data-clip-path'), 'markdown.ts 未设置 data-clip-path');
    assert.ok(src.includes("javascript:void(0)"), 'markdown.ts 未将 href 置 javascript:void(0)');
    assert.ok(src.includes('setFileLinkWorkspaceRoot'), 'markdown.ts 未导出 setFileLinkWorkspaceRoot');
  });
  check('结构钉：MessageBubble.vue 含 onContentClick / closest?.(.md-file-link) / useFilePreview（点击委托）', () => {
    const src = fs.readFileSync(new URL('../src/renderer/components/chat/MessageBubble.vue', import.meta.url), 'utf8');
    assert.ok(src.includes('onContentClick'), 'MessageBubble.vue 未实现 onContentClick');
    assert.ok(src.includes("closest?.('.md-file-link')"), "MessageBubble.vue 未用 closest?.('.md-file-link') 委托");
    assert.ok(src.includes('useFilePreview'), 'MessageBubble.vue 未接 useFilePreview');
    assert.ok(src.includes('bubble__content :deep(.md-file-link)'), 'MessageBubble.vue 缺 md-file-link 样式（:deep 穿透）');
  });
  check('结构钉：ChatPage.vue 含 setFileLinkWorkspaceRoot（workspaceRoot 接线）', () => {
    const src = fs.readFileSync(new URL('../src/renderer/pages/ChatPage.vue', import.meta.url), 'utf8');
    assert.ok(src.includes('setFileLinkWorkspaceRoot'), 'ChatPage.vue 未接线 setFileLinkWorkspaceRoot');
  });

  console.log('\n=== ⑧ ToolCallBlock chip（p4） ===');
  {
    const src = fs.readFileSync(new URL('../src/renderer/components/chat/ToolCallBlock.vue', import.meta.url), 'utf8');
    check('chip 单击=预览："useFilePreview().open(filePath)" 字面存在（含 @click.stop 完整绑定）', () => {
      assert.ok(src.includes('@click.stop="!exportMode && useFilePreview().open(filePath)"'),
        'chip @click.stop 未改为 useFilePreview().open(filePath) 预览（宽松断言：新字面必须存在，即旧菜单切换已从 chip 移走）');
    });
    check('chip enter/space 键盘路径同步为预览（恰 2 处 keydown → useFilePreview().open）', () => {
      const hits = src.match(/@keydown\.(?:enter|space)\.stop\.prevent="!exportMode && useFilePreview\(\)\.open\(filePath\)"/g) ?? [];
      assert.strictEqual(hits.length, 2, `应恰有 2 处 keydown 预览（enter/space），实际 ${hits.length}`);
    });
    check('▾ span 存在：class="tool-row__filemore" 且该行含 role="button" 与 tabindex="0"（span 非 button，不破「恰 2 button」钉）', () => {
      const line = src.split('\n').find((l) => l.includes('class="tool-row__filemore"'));
      assert.ok(line, '未找到 tool-row__filemore 元素');
      assert.ok(line.includes('role="button"'), '▾ 行缺 role="button"');
      assert.ok(line.includes('tabindex="0"'), '▾ 行缺 tabindex="0"');
    });
    check('@contextmenu.prevent 至少两处（chip 右键 + ▾ 右键均接菜单）', () => {
      const hits = src.match(/@contextmenu\.prevent/g) ?? [];
      assert.ok(hits.length >= 2, `应至少 2 处 @contextmenu.prevent，实际 ${hits.length}`);
    });
    check('菜单链路零删改：async function openGeneratedFile 与 fsOpenPath 字面仍在', () => {
      assert.ok(src.includes('async function openGeneratedFile'), 'openGeneratedFile 函数丢失');
      assert.ok(src.includes('fsOpenPath'), 'fsOpenPath 调用丢失');
    });
    check('菜单 DOM 两项字面仍在：「用默认程序打开」「选择打开方式…」', () => {
      assert.ok(src.includes('用默认程序打开'), '缺「用默认程序打开」菜单项');
      assert.ok(src.includes('选择打开方式…'), '缺「选择打开方式…」菜单项');
    });
  }

  console.log('\n=== ⑨ PdfPreview（p5） ===');
  {
    const compPath = new URL('../src/renderer/components/preview/PdfPreview.vue', import.meta.url);
    const exists = fs.existsSync(compPath);
    // 文件缺失时 src 为空串：其余结构钉各自 ❌ 而非脚本整体 ENOENT 中断。
    const src = exists ? fs.readFileSync(compPath, 'utf8') : '';
    check('文件存在：src/renderer/components/preview/PdfPreview.vue', () => {
      assert.ok(exists, 'PdfPreview.vue 不存在');
    });
    check('含 pdf worker ?url 导入字面（pdfjs-dist/legacy/build/pdf.worker.min.mjs?url，R1 toHex 兼容走 legacy 构建）', () => {
      assert.ok(src.includes('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'), '缺 legacy worker ?url 资产导入');
    });
    check("含 'GlobalWorkerOptions' 字面（workerSrc 设置）", () => {
      assert.ok(src.includes('GlobalWorkerOptions'), '缺 GlobalWorkerOptions');
    });
    check("含 'PasswordException' 字面（加密分支判定）", () => {
      assert.ok(src.includes('PasswordException'), '缺 PasswordException 加密分支');
    });
    check('含「加密文件不支持预览」与「文件损坏或格式异常」两文案字面（B23/B22）', () => {
      assert.ok(src.includes('加密文件不支持预览'), '缺加密文件文案（B23）');
      assert.ok(src.includes('文件损坏或格式异常'), '缺损坏/异常文案（B22）');
    });
    check("含 'getDocument' 字面（pdfjs v6 文档加载入口）", () => {
      assert.ok(src.includes('getDocument'), '缺 getDocument 调用');
    });
  }

  console.log('\n=== ⑩ DocxPreview（p6） ===');
  {
    const compPath = new URL('../src/renderer/components/preview/DocxPreview.vue', import.meta.url);
    const exists = fs.existsSync(compPath);
    // 文件缺失时 src 为空串：其余结构钉各自 ❌ 而非脚本整体 ENOENT 中断。
    const src = exists ? fs.readFileSync(compPath, 'utf8') : '';
    check('文件存在：src/renderer/components/preview/DocxPreview.vue', () => {
      assert.ok(exists, 'DocxPreview.vue 不存在');
    });
    check("含 \"import('docx-preview')\" 动态导入字面（防主包膨胀）", () => {
      assert.ok(src.includes("import('docx-preview')"), "缺 import('docx-preview') 动态导入");
    });
    check("含 'renderAsync' 字面（docx-preview 渲染入口）", () => {
      assert.ok(src.includes('renderAsync'), '缺 renderAsync 调用');
    });
    check('含「文件损坏或格式异常」错误态字面（B22 伪扩展/损坏/加密统一落点）', () => {
      assert.ok(src.includes('文件损坏或格式异常'), '缺损坏/异常文案（B22）');
    });
    check("含 'inWrapper' 字面（显式 options，不依赖库默认值）", () => {
      assert.ok(src.includes('inWrapper'), '缺 inWrapper 显式 options');
    });
  }

  console.log('\n=== ⑪ XlsxPreview（p7） ===');
  {
    const compPath = new URL('../src/renderer/components/preview/XlsxPreview.vue', import.meta.url);
    const exists = fs.existsSync(compPath);
    // 文件缺失时 src 为空串：其余结构钉各自 ❌ 而非脚本整体 ENOENT 中断。
    const src = exists ? fs.readFileSync(compPath, 'utf8') : '';
    check('文件存在：src/renderer/components/preview/XlsxPreview.vue', () => {
      assert.ok(exists, 'XlsxPreview.vue 不存在');
    });
    check("含 \"import('xlsx')\" 动态导入字面（防主包膨胀）", () => {
      assert.ok(src.includes("import('xlsx')"), "缺 import('xlsx') 动态导入");
    });
    check("含 'sheet_to_json' 字面（SheetJS 行提取入口）", () => {
      assert.ok(src.includes('sheet_to_json'), '缺 sheet_to_json 调用');
    });
    check('MAX_ROWS 渲染上限常量值为 500（正则断言 MAX_ROWS = 500）', () => {
      assert.ok(/MAX_ROWS\s*=\s*500/.test(src), '缺 MAX_ROWS = 500 渲染上限常量');
    });
    check('含「仅显示前 500 行」截断注明文案字面（B20）', () => {
      assert.ok(src.includes('仅显示前 500 行'), '缺 500 行截断注明文案（B20）');
    });
    check('含「文件损坏或格式异常」错误态字面（B22 损坏/伪扩展/加密统一落点）', () => {
      assert.ok(src.includes('文件损坏或格式异常'), '缺损坏/异常文案（B22）');
    });
  }

  console.log('\n=== ⑫ PptxPreview（p8） ===');
  {
    const compPath = new URL('../src/renderer/components/preview/PptxPreview.vue', import.meta.url);
    const exists = fs.existsSync(compPath);
    // 文件缺失时 src 为空串：其余结构钉各自 ❌ 而非脚本整体 ENOENT 中断。
    const src = exists ? fs.readFileSync(compPath, 'utf8') : '';
    check('文件存在：src/renderer/components/preview/PptxPreview.vue', () => {
      assert.ok(exists, 'PptxPreview.vue 不存在');
    });
    check("含 \"import('@aiden0z/pptx-renderer')\" 动态导入字面（防主包膨胀）", () => {
      assert.ok(src.includes("import('@aiden0z/pptx-renderer')"), "缺 import('@aiden0z/pptx-renderer') 动态导入");
    });
    check('含「文件损坏或格式异常」错误态字面（B22 损坏/伪扩展/加密统一落点）', () => {
      assert.ok(src.includes('文件损坏或格式异常'), '缺损坏/异常文案（B22）');
    });
    check("含 'loadToken' 竞态守卫字面（换文件/快速重载防串页）", () => {
      assert.ok(src.includes('loadToken'), '缺 loadToken 竞态守卫');
    });
  }

  console.log('\n=== ⑬ 分发表集成（p9） ===');
  {
    const compPath = new URL('../src/renderer/components/preview/FilePreviewDrawer.vue', import.meta.url);
    const exists = fs.existsSync(compPath);
    // 文件缺失时 src 为空串：其余结构钉各自 ❌ 而非脚本整体 ENOENT 中断。
    const src = exists ? fs.readFileSync(compPath, 'utf8') : '';
    check('文件存在：src/renderer/components/preview/FilePreviewDrawer.vue', () => {
      assert.ok(exists, 'FilePreviewDrawer.vue 不存在');
    });
    check("含 'sandbox=\"allow-scripts allow-forms\"' 字面（iframe 静态钉：隔离沙箱运行脚本与表单、不授同源，B9·A3 更新）", () => {
      assert.ok(src.includes('sandbox="allow-scripts allow-forms"'), 'iframe 缺 sandbox="allow-scripts allow-forms" 静态钉（B9·A3）');
    });
    check('源码不含 allow-same-origin 字面（opaque origin 隔离：预览页不可触达宿主 DOM/存储/cookie，宿主读 contentDocument 仍被拒，B9·A3）', () => {
      assert.ok(!src.includes('allow-same-origin'), '源码出现 allow-same-origin，B9 隔离红线被破坏');
    });
    check('含四重组件 import 字面（PdfPreview/DocxPreview/XlsxPreview/PptxPreview）', () => {
      assert.ok(src.includes("import PdfPreview from './PdfPreview.vue'"), '缺 PdfPreview import 行');
      assert.ok(src.includes("import DocxPreview from './DocxPreview.vue'"), '缺 DocxPreview import 行');
      assert.ok(src.includes("import XlsxPreview from './XlsxPreview.vue'"), '缺 XlsxPreview import 行');
      assert.ok(src.includes("import PptxPreview from './PptxPreview.vue'"), '缺 PptxPreview import 行');
    });
    check('含 renderMarkdown 与 enrichMarkdown 接线字面（md preview 分发）', () => {
      assert.ok(src.includes('renderMarkdown'), '缺 renderMarkdown 接线');
      assert.ok(src.includes('enrichMarkdown'), '缺 enrichMarkdown（v-enrich）接线');
    });
    check("含 'mermaid-block__source' 字面（mmd graph 复用 mermaid 渲染管线）", () => {
      assert.ok(src.includes('mermaid-block__source'), '缺 mermaid-block__source 占位结构');
    });
    check("含 'text/html' 与 'image/svg+xml' 字面（text→blob 转换 mime）", () => {
      assert.ok(src.includes('text/html'), "缺 'text/html' mime");
      assert.ok(src.includes('image/svg+xml'), "缺 'image/svg+xml' mime");
    });
    check('含「网页预览在隔离沙箱中运行脚本」字面（B10 foot 注记·A3 更新）', () => {
      assert.ok(src.includes('网页预览在隔离沙箱中运行脚本'), '缺 B10 网页预览注记（A3 新文案）');
    });
    check('含 :size= 传参字面（重组件 props 契约 { base64, size }）', () => {
      assert.ok(src.includes(':size='), '缺重组件 :size= 传参字面');
    });
  }

  console.log('\n=== ⑭ Esc 让位与 token（p10） ===');
  {
    // ChatPage 让位：escConsumerOpen 内含 filePreviewStore.open 检查且接 return true（预览抽屉
    // 打开时 Esc 归抽屉关闭，不触发会话急停；函数体边界取 escConsumerOpen → onGlobalKeydown 之间）。
    const chatPath = new URL('../src/renderer/pages/ChatPage.vue', import.meta.url);
    const chatSrc = fs.readFileSync(chatPath, 'utf8');
    check("ChatPage.vue escConsumerOpen 内含 'filePreviewStore.open' 让位检查（→ return true）", () => {
      const start = chatSrc.indexOf('function escConsumerOpen');
      assert.ok(start >= 0, 'ChatPage.vue 未找到 escConsumerOpen 函数');
      const end = chatSrc.indexOf('function onGlobalKeydown', start);
      assert.ok(end > start, 'ChatPage.vue 未找到 escConsumerOpen 的函数体右边界（onGlobalKeydown）');
      const body = chatSrc.slice(start, end);
      assert.ok(body.includes('filePreviewStore.open'), 'escConsumerOpen 未含 filePreviewStore.open 让位检查');
      assert.ok(/filePreviewStore\.open\s*\)\s*return\s+true/.test(body), 'filePreviewStore.open 检查未接 return true（让位语义缺失）');
    });
    // Esc 层闭环：注册/出栈/顶层裁决三字面齐全（release 幂等 + onBeforeUnmount 兜底为 p2 已接线）。
    const drawerPath = new URL('../src/renderer/components/preview/FilePreviewDrawer.vue', import.meta.url);
    const drawerSrc = fs.readFileSync(drawerPath, 'utf8');
    check('FilePreviewDrawer.vue Esc 层闭环：pushEscLayer / release / isTopmost 三字面齐全', () => {
      assert.ok(drawerSrc.includes('pushEscLayer'), '缺 pushEscLayer（注册 Esc 层）');
      assert.ok(drawerSrc.includes('release'), '缺 release（出栈）');
      assert.ok(drawerSrc.includes('isTopmost'), '缺 isTopmost（顶层裁决）');
    });
    check('FilePreviewDrawer.vue 含 prefers-reduced-motion 降级块且作用于 .fpreview-drawer/.fpreview-mask', () => {
      const m = drawerSrc.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
      assert.ok(m, '缺 @media (prefers-reduced-motion: reduce) 降级块');
      assert.ok(m[1].includes('.fpreview-drawer'), 'reduced-motion 块未作用于 .fpreview-drawer');
      assert.ok(m[1].includes('.fpreview-mask'), 'reduced-motion 块未作用于 .fpreview-mask');
    });
    // token 核查（p10③）：六个整文件源码硬编码十六进制色值逐文件断言 0 命中（全 0 最干净，
    // 实现若真有命中会红，按指令处理掉再转绿）。ToolCallBlock 新增段（.tool-row__filemore）
    // 已全 token 化，但文件级扫描会命中既有注释「openhanako #786」，故不入本断言。
    const tokenFiles: Array<[string, URL]> = [
      ['FilePreviewDrawer.vue', new URL('../src/renderer/components/preview/FilePreviewDrawer.vue', import.meta.url)],
      ['PdfPreview.vue', new URL('../src/renderer/components/preview/PdfPreview.vue', import.meta.url)],
      ['DocxPreview.vue', new URL('../src/renderer/components/preview/DocxPreview.vue', import.meta.url)],
      ['XlsxPreview.vue', new URL('../src/renderer/components/preview/XlsxPreview.vue', import.meta.url)],
      ['PptxPreview.vue', new URL('../src/renderer/components/preview/PptxPreview.vue', import.meta.url)],
      ['MessageBubble.vue', new URL('../src/renderer/components/chat/MessageBubble.vue', import.meta.url)],
    ];
    for (const [name, url] of tokenFiles) {
      check(`token 核查：${name} 硬编码十六进制色值命中数 === 0`, () => {
        const src = fs.readFileSync(url, 'utf8');
        const hits = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
        assert.strictEqual(hits.length, 0, `${name} 存在硬编码色值：${hits.join(', ')}`);
      });
    }
  }

  console.log('\n=== ⑮ 链接管线（fix-2） ===');
  {
    // 真管线断言（markdown-it 14）：normalizeLink 在 renderer 之前对 href percent-encode
    //（中文→%E4…、空格→%20），renderAttrs 渲染属性时对值做一次 escapeHtml（& < > "）。
    // 断言一律取 data-clip-path 后做「HTML 实体解码语义比较」（把 &amp; 解回 & 再比），
    // 不把转义层当业务结果。setFileLinkWorkspaceRoot 模块级单例：本组统一设根。
    setFileLinkWorkspaceRoot('D:\\tmp-ws');

    /** HTML 属性值实体解码（仅语义比较用；&amp; 放最后防二次吞并）。 */
    const decodeAttrEntities = (html: string): string =>
      html
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
    /** 取首个 data-clip-path 属性值并解码实体；链接未按钮化 → null。 */
    const clipOf = (html: string): string | null => {
      const m = html.match(/data-clip-path="([^"]*)"/);
      return m ? decodeAttrEntities(m[1]) : null;
    };

    check("①相对中文路径：'[周报](docs/中文文档.md)' → clip=='D:\\\\tmp-ws\\\\docs\\\\中文文档.md'（normalizeLink 编码须被恰好一次解码，F1）", () => {
      const html = renderMarkdown('[周报](docs/中文文档.md)');
      assert.strictEqual(clipOf(html), 'D:\\tmp-ws\\docs\\中文文档.md');
    });
    check("②尖括号空格：'[r](<my file.md>)' → clip 为含空格路径（%20 解码，F1）", () => {
      const html = renderMarkdown('[r](<my file.md>)');
      const p = clipOf(html);
      assert.ok(p !== null && p.includes(' '), `clip 应含空格，实际 ${String(p)}`);
    });
    check("③& 单层转义：'[x](<R&D/a.md>)' → 解码语义 clip 含 'R&D' 且 HTML 无双重转义（F2）", () => {
      const html = renderMarkdown('[x](<R&D/a.md>)');
      const p = clipOf(html);
      assert.ok(p !== null && p.includes('R&D'), `clip 解码语义应含 R&D，实际 ${String(p)}`);
      assert.ok(!html.includes('&amp;amp;'), `HTML 不得出现双重转义 &amp;amp;，实际 ${html}`);
    });
    check("④单引号路径：\"[y](it's/a.md)\" → 解码语义 clip 含 \"it's\"", () => {
      const html = renderMarkdown("[y](it's/a.md)");
      const p = clipOf(html);
      assert.ok(p !== null && p.includes("it's"), `clip 应含 it's，实际 ${String(p)}`);
    });
    check("⑤file:/// 放行（F3）：'[o](file:///D:/tmp-ws/docs/ok.md)' → 有 md-file-link 且 clip=='D:\\\\tmp-ws\\\\docs\\\\ok.md'", () => {
      const html = renderMarkdown('[o](file:///D:/tmp-ws/docs/ok.md)');
      assert.ok(html.includes('md-file-link'), 'file:/// 链接应按钮化（validateLink 覆盖后不再硬拦 file:）');
      assert.strictEqual(clipOf(html), 'D:\\tmp-ws\\docs\\ok.md');
    });
    check("⑥javascript 仍拦（F3 反向）：'[j](javascript:alert(1))' → 无 md-file-link 且无 <a href=\"javascript", () => {
      const html = renderMarkdown('[j](javascript:alert(1))');
      assert.ok(!html.includes('md-file-link'), 'javascript: 不应按钮化');
      assert.ok(!html.includes('<a href="javascript'), 'javascript: 不应产出 <a>（validateLink 仍拦）');
    });
    check("⑦data:text/html 仍拦（F3 反向）：'[d](data:text/html;base64,xx)' → 无 md-file-link 且无 <a", () => {
      const html = renderMarkdown('[d](data:text/html;base64,xx)');
      assert.ok(!html.includes('md-file-link'), 'data:text/html 不应按钮化');
      assert.ok(!html.includes('<a'), 'data:text/html 不应产出 <a>（validateLink 仍拦）');
    });
    check("⑧尾缀剥离（F4）：'[f](docs/a.md#frag)' → clip=='D:\\\\tmp-ws\\\\docs\\\\a.md'", () => {
      const html = renderMarkdown('[f](docs/a.md#frag)');
      assert.strictEqual(clipOf(html), 'D:\\tmp-ws\\docs\\a.md');
    });
    check("⑨'..' 越界管线级（B7）：'[e](..\\evil.md)' → 无 md-file-link", () => {
      const html = renderMarkdown('[e](..\\evil.md)');
      assert.ok(!html.includes('md-file-link'), "'..' 越界链接不应按钮化（解码后词法检查仍生效）");
    });
    check("⑩外链管线级（B15）：'[w](https://x.com/f.txt)' → 无 md-file-link 且 target=\"_blank\"", () => {
      const html = renderMarkdown('[w](https://x.com/f.txt)');
      assert.ok(!html.includes('md-file-link'), 'http 外链不应按钮化');
      assert.ok(html.includes('target="_blank"'), '外链应保留 target=_blank');
    });
  }

  console.log('\n=== ⑯ round-002 fix-3 修复钉（B13/B3/备忘-1/C-F5/D-F2） ===');
  {
    const drawerPath = new URL('../src/renderer/components/preview/FilePreviewDrawer.vue', import.meta.url);
    const drawerSrc = fs.readFileSync(drawerPath, 'utf8');
    check('B13：含 @media (max-width: 900px) 块且块内作用于 .fpreview-drawer（窄窗近似全宽）', () => {
      const m = drawerSrc.match(/@media\s*\(max-width:\s*900px\)\s*\{([\s\S]*?)\n\}/);
      assert.ok(m, '缺 @media (max-width: 900px) 媒体查询块');
      assert.ok(m[1].includes('.fpreview-drawer'), '窄窗媒体查询块未作用于 .fpreview-drawer');
    });
    check('B3：含「（空文件）」空态文案字面（0 字节文件不渲染空源码视图）', () => {
      assert.ok(drawerSrc.includes('（空文件）'), '缺（空文件）空态文案（B3）');
    });
    check('备忘-1：close() 函数体内含 reqSeq++（关闭使在途响应序号过期，blob URL 不滞留）', () => {
      const m = drawerSrc.match(/function close\(\): void \{[^}]*\}/);
      assert.ok(m, '未匹配到 close 函数体');
      assert.ok(m[0].includes('reqSeq++'), 'close() 未递增 reqSeq（备忘-1）');
    });
    check("C-F5：.fpreview-md 文件链接委托接线（closest('.md-file-link') + useFilePreview + :deep 两组样式）", () => {
      assert.ok(drawerSrc.includes("closest('.md-file-link')"), "缺 closest('.md-file-link') 委托字面（C-F5）");
      assert.ok(drawerSrc.includes('useFilePreview'), '缺 useFilePreview 接线（C-F5）');
      assert.ok(drawerSrc.includes(':deep(.md-file-link)'), '缺 :deep(.md-file-link) 样式（C-F5）');
      assert.ok(drawerSrc.includes(':deep(.md-file-link:hover)'), '缺 :deep(.md-file-link:hover) 样式（C-F5）');
    });
    const xlsxPath = new URL('../src/renderer/components/preview/XlsxPreview.vue', import.meta.url);
    const xlsxSrc = fs.readFileSync(xlsxPath, 'utf8');
    check('D-F2：XlsxPreview 含「数据可能位于更后方」注记提示字面', () => {
      assert.ok(xlsxSrc.includes('数据可能位于更后方'), '缺 D-F2 注记提示文案');
    });
    check('D-F2：XlsxPreview isBlankSheet 含 totalRows > EXTRACT_ROWS_CAP 守卫（>5000 行截取段全空不判空表）', () => {
      const start = xlsxSrc.indexOf('isBlankSheet');
      assert.ok(start >= 0, '未找到 isBlankSheet');
      const end = xlsxSrc.indexOf('\n});', start);
      assert.ok(end > start, '未找到 isBlankSheet 计算体结束');
      const body = xlsxSrc.slice(start, end);
      assert.ok(body.includes('totalRows > EXTRACT_ROWS_CAP'), 'isBlankSheet 缺 totalRows > EXTRACT_ROWS_CAP 守卫');
    });
  }

  console.log('\n=== ⑰ A2 行为组扩充节（2026-11-06 文件点击打开链路计划·反引号路径链接化，RED 先行） ===');
  {
    // 行为级断言（函数级 renderMarkdown）。A2 实现落盘前：正例（A2-1~A2-5、A2-9）预期红；
    // 负样本/流式中途态/围栏守卫（A2-6/A2-6b/A2-7）现状即绿，属对照性质，防实现后误链接化。
    // A2-8（既有链接管线回归）为引用性质：由既有 ⑮ 组 ①—⑩ 与 ⑦ resolve 矩阵承接，本节零新增。
    // fileLinkWorkspaceRoot 为模块级单例（⑮ 遗留 'D:\\tmp-ws'）：本节每小节显式 set 再断言，收尾归零。
    const decodeAttrEntities17 = (html: string): string =>
      html
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
    const clipOf17 = (html: string): string | null => {
      const m = html.match(/data-clip-path="([^"]*)"/);
      return m ? decodeAttrEntities17(m[1]) : null;
    };
    // 临时目录形态根（脱敏：2026-11-05 F3 同款纪律，不硬编码本机盘符路径；词法 join 无需真实存在）。
    const TMP_ROOT = fs.realpathSync(os.tmpdir()).replace(/[\\/]+$/, '');
    /** 反引号路径正例断言：md-file-link 产出 + clip 为期望归一路径。 */
    const expectCodeLink = (text: string, expectedClip: string): void => {
      const html = renderMarkdown(text);
      assert.ok(html.includes('md-file-link'), `应渲染为 .md-file-link（RED：A2 未实施），实际：${html}`);
      assert.strictEqual(clipOf17(html), expectedClip, `data-clip-path 应为 ${expectedClip}`);
    };

    // —— A2-1 盘符绝对路径四形态（未设根 setFileLinkWorkspaceRoot(null) 亦命中） ——
    setFileLinkWorkspaceRoot(null);
    check('A2-1a 反引号反斜杠字面绝对路径（`C:\\Users\\demo\\Desktop\\cccc.html`）→ 链接化，clip 归一', () => {
      expectCodeLink('已创建 `C:\\Users\\demo\\Desktop\\cccc.html`，已测试', 'C:\\Users\\demo\\Desktop\\cccc.html');
    });
    check('A2-1b 反引号正斜杠字面绝对路径（`C:/Users/demo/Desktop/cccc.html`）→ 链接化，clip 归一反斜杠', () => {
      expectCodeLink('已创建 `C:/Users/demo/Desktop/cccc.html`，已测试', 'C:\\Users\\demo\\Desktop\\cccc.html');
    });
    check('A2-1c 含空格绝对路径（`C:/Users/demo/Desktop/my file.html`）→ 链接化，原文透传', () => {
      expectCodeLink('已创建 `C:/Users/demo/Desktop/my file.html`，已测试', 'C:\\Users\\demo\\Desktop\\my file.html');
    });
    check('A2-1d 含中文绝对路径（`C:/Users/demo/Desktop/中文文件.html`）→ 链接化，原文透传', () => {
      expectCodeLink('已创建 `C:/Users/demo/Desktop/中文文件.html`，已测试', 'C:\\Users\\demo\\Desktop\\中文文件.html');
    });
    // A2-1e/f（round-002 fix-1 F1）：尖括号包裹形态。头部剥 '<' 后原配平尾 '>' 转未配平，须在第 2
    // 轮尾剥（与 '(C:\\x.md)' 同机制）；对照 A2-1f 钉平衡 HTML 形态不被误链接化。
    check('A2-1e 反引号尖括号包裹绝对路径（`<C:\\x\\a.md>`）→ 链接化且 data-clip-path 恰为 C:\\x\\a.md（尾 > 剥净）', () => {
      expectCodeLink('已创建 `<C:\\x\\a.md>`，已测试', 'C:\\x\\a.md');
    });
    check('A2-1f 对照：平衡尖括号形态（`<div>`）不产出路径链接（保持纯 <code>，不被链接化）', () => {
      const html = renderMarkdown('路径 `<div>` 结束');
      assert.ok(!html.includes('md-file-link'), `平衡 <div> 形态不应链接化，实际：${html}`);
      assert.ok(!html.includes('data-clip-path'), '平衡 <div> 形态不应产出 data-clip-path');
      assert.ok(html.includes('<code>&lt;div&gt;</code>'), `平衡 <div> 应保持纯 <code> 形态，实际：${html}`);
    });

    // —— A2-2 UNC ——
    check('A2-2 反引号 UNC（`\\\\server\\share\\x.md`）→ 链接化，clip 保留 UNC 形态', () => {
      expectCodeLink('已创建 `\\\\server\\share\\x.md`，已测试', '\\\\server\\share\\x.md');
    });

    // —— A2-3 file:/// ——
    check('A2-3 反引号 file:///（`file:///C:/Users/demo/Desktop/cccc.html`）→ 链接化，clip 去前缀归一', () => {
      expectCodeLink('已创建 `file:///C:/Users/demo/Desktop/cccc.html`，已测试', 'C:\\Users\\demo\\Desktop\\cccc.html');
    });

    // —— A2-4 已设根（临时目录形态根）相对形态四例 ——
    setFileLinkWorkspaceRoot(TMP_ROOT);
    check('A2-4a 已设根：含分隔无扩展（`src/main.ts`）→ 链接化，clip=根拼接', () => {
      expectCodeLink('入口在 `src/main.ts`，已测试', `${TMP_ROOT}\\src\\main.ts`);
    });
    check('A2-4b 已设根：裸名+可预览扩展（`readme.md`）→ 链接化，clip=根拼接', () => {
      expectCodeLink('说明在 `readme.md`，已测试', `${TMP_ROOT}\\readme.md`);
    });
    check('A2-4c 已设根：深嵌套（`a/b/c.ts`）→ 链接化，clip=根拼接', () => {
      expectCodeLink('样例在 `a/b/c.ts`，已测试', `${TMP_ROOT}\\a\\b\\c.ts`);
    });
    check('A2-4d 已设根：带空格（`my file.md`）→ 链接化，clip=根拼接原文', () => {
      expectCodeLink('说明在 `my file.md`，已测试', `${TMP_ROOT}\\my file.md`);
    });

    // —— A2-5 未设根：相对与裸名不链接化（纯 <code>），绝对仍可点 ——
    setFileLinkWorkspaceRoot(null);
    check('A2-5a 未设根：相对（`src/main.ts`）与裸名（`readme.md`）不链接化，保持纯 <code>', () => {
      const rel = renderMarkdown('入口在 `src/main.ts`，已测试');
      const bare = renderMarkdown('说明在 `readme.md`，已测试');
      const cases: Array<[string, string]> = [[rel, 'src/main.ts'], [bare, 'readme.md']];
      for (const [html, name] of cases) {
        assert.ok(!html.includes('md-file-link'), `未设根时 ${name} 不应链接化，实际：${html}`);
        assert.ok(!html.includes('data-clip-path'), `未设根时 ${name} 不应产出 data-clip-path`);
        assert.ok(html.includes(`<code>${name}</code>`), `未设根时 ${name} 应保持纯 <code> 形态，实际：${html}`);
      }
    });
    check('A2-5b 未设根：绝对路径（`C:/Users/demo/Desktop/cccc.html`）仍可点', () => {
      expectCodeLink('已创建 `C:/Users/demo/Desktop/cccc.html`，已测试', 'C:\\Users\\demo\\Desktop\\cccc.html');
    });

    // —— A2-6 负样本表 15 形态全不链接化（未设根；相对三例依赖 A2-5 语义，scheme/POSIX 根无关） ——
    const NEG_SAMPLES: readonly string[] = [
      'https://x.com/a.md',
      'mailto:user@example.com',
      'javascript:void(0)',
      '/etc/hosts',
      '/D:/x.md',
      '../a.md',
      'a/../b.md',
      './a.md',
      'Makefile',
      'foo_bar',
      '123',
      'npm run test',
      'foo()',
      'v1.2.3',
      'data.unknownext',
    ];
    NEG_SAMPLES.forEach((sample, i) => {
      check(`A2-6[${i + 1}/15] 负样本「${sample}」不链接化（保持纯 <code>）`, () => {
        const html = renderMarkdown('路径 `' + sample + '` 结束');
        assert.ok(!html.includes('md-file-link'), `负样本 ${sample} 不应链接化，实际：${html}`);
        assert.ok(!html.includes('data-clip-path'), `负样本 ${sample} 不应产出 data-clip-path，实际：${html}`);
        assert.ok(html.includes(`<code>${sample}</code>`), `负样本 ${sample} 应保持纯 <code> 形态，实际：${html}`);
      });
    });

    // —— A2-6b 围栏代码块内路径不链接化（裁决补充；fence 不走 inline renderer） ——
    check('A2-6b 围栏代码块内路径不链接化（``` 包裹 C:\\Users\\demo\\Desktop\\cccc.html）', () => {
      const html = renderMarkdown('```\nC:\\Users\\demo\\Desktop\\cccc.html\n```');
      assert.ok(!html.includes('md-file-link'), '围栏内路径不应链接化，实际：' + html);
      assert.ok(!html.includes('data-clip-path'), '围栏内路径不应产出 data-clip-path');
      assert.ok(html.includes('C:\\Users\\demo\\Desktop\\cccc.html'), '围栏内容应原样保留');
    });

    // —— A2-7 未闭合反引号整体纯文本（流式中途态） ——
    check('A2-7 未闭合反引号整体纯文本，无链接产出（流式中途态安全）', () => {
      const html = renderMarkdown('已创建 `C:/Users/demo/Desktop/cccc.html 并已在浏览器中测试通过');
      assert.ok(!html.includes('md-file-link'), '未闭合反引号不得链接化，实际：' + html);
      assert.ok(!html.includes('data-clip-path'), '未闭合反引号不得产出 data-clip-path');
      assert.ok(html.includes('`C:/Users/demo/Desktop/cccc.html'), '未闭合反引号应按纯文本原样保留（含反引号字符）');
    });

    // —— A2-9 export 与 rich 同形（裁决补充；导出面观测） ——
    check("A2-9 renderMarkdown(text,'export') 与 'rich' 对反引号绝对路径输出同形且均链接化", () => {
      const text = '已创建 `C:/Users/demo/Desktop/cccc.html`，测试通过';
      const rich = renderMarkdown(text, 'rich');
      const exported = renderMarkdown(text, 'export');
      assert.ok(rich.includes('md-file-link'), 'rich 未产出文件链接（RED：A2 未实施），实际：' + rich);
      assert.ok(exported.includes('md-file-link'), 'export 未产出文件链接（导出面丢失链接化），实际：' + exported);
      assert.strictEqual(exported, rich, 'export 与 rich 输出应逐字节同形');
    });

    setFileLinkWorkspaceRoot(null); // 收尾归零：不向后续分组遗留根状态
  }

  console.log('\n=== ⑱ A4 死链反馈组（2026-11-06 file linkify 计划·点击失败可见反馈，RED 先行） ===');
  {
    // 唯一静默死链 = 「相对 href + 未设工作区根」：resolveFileLinkHref 相对分支因无根返回
    // null，基线 <a> 保留相对 href、点击被导航守卫静默吞。A4 落盘前：死链形态正例（A4-1~
    // A4-3、A4-6a）与结构钉（A4-8）预期红；负样本/对照（A4-4/A4-5/A4-6b/A4-7）现状即绿，
    // 防实现后误进死链通道。root 单例沿用 ⑰ 收尾 null；本节显式 set 并收尾归零。
    const decodeAttrEntities18 = (html: string): string =>
      html
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
    const clipOf18 = (html: string): string | null => {
      const m = html.match(/data-clip-path="([^"]*)"/);
      return m ? decodeAttrEntities18(m[1]) : null;
    };

    // —— A4-1~A4-3 未设根：相对 markdown 链接 → 死链形态（RED：A4 未实施） ——
    setFileLinkWorkspaceRoot(null);
    check('A4-1 未设根：相对链接 [r](docs/a.md) → md-file-link--dead + clip==原始相对路径 + href=javascript:void(0)', () => {
      const html = renderMarkdown('[r](docs/a.md)');
      assert.ok(html.includes('md-file-link--dead'), `应渲染死链形态（RED：A4 未实施），实际：${html}`);
      assert.ok(html.includes('class="md-file-link md-file-link--dead"'), `类应为 md-file-link md-file-link--dead 组合，实际：${html}`);
      assert.strictEqual(clipOf18(html), 'docs/a.md', 'data-clip-path 应存解码去尾 #? 的原始相对路径（非根拼接）');
      assert.ok(html.includes('href="javascript:void(0)"'), '死链 href 应置 javascript:void(0)（点击走委托不开导航）');
    });
    check('A4-2 未设根 + 尾缀：[f](docs/a.md#frag) → dead 且 clip 去尾片段', () => {
      const html = renderMarkdown('[f](docs/a.md#frag)');
      assert.ok(html.includes('md-file-link--dead'), `应渲染死链形态，实际：${html}`);
      assert.strictEqual(clipOf18(html), 'docs/a.md', 'data-clip-path 应为剥掉 #frag 后的原始相对路径');
    });
    check('A4-3 未设根 + 编码态：[c](<docs/中文 文档.md>) → dead 且 clip 为解码后原文（%20/中文还原）', () => {
      const html = renderMarkdown('[c](<docs/中文 文档.md>)');
      assert.ok(html.includes('md-file-link--dead'), `应渲染死链形态，实际：${html}`);
      assert.strictEqual(clipOf18(html), 'docs/中文 文档.md', 'data-clip-path 应为恰好一次解码的原始相对路径');
    });

    // —— A4-4~A4-6 未设根负样本：不进死链通道（现状即绿，防误捕获） ——
    check("A4-4 未设根 + '..' 越界：[e](../evil.md) → 无 md-file-link（不进死链通道，保持普通 <a>）", () => {
      const html = renderMarkdown('[e](../evil.md)');
      assert.ok(!html.includes('md-file-link'), `含 '..' 的 href 不应进死链通道，实际：${html}`);
      assert.ok(!html.includes('data-clip-path'), "含 '..' 的 href 不应产出 data-clip-path");
    });
    check('A4-5 未设根 + scheme：[w](https://x.com/f.txt) → 无 md-file-link 且 target=_blank 保留（外链照旧）', () => {
      const html = renderMarkdown('[w](https://x.com/f.txt)');
      assert.ok(!html.includes('md-file-link'), 'scheme href 不应进死链通道');
      assert.ok(!html.includes('data-clip-path'), 'scheme href 不应产出 data-clip-path');
      assert.ok(html.includes('target="_blank"'), '外链应保留 target=_blank');
    });
    check('A4-6a 未设根 + %ZZ href：normalizeLink 重编码为 %25ZZ、解码不抛 → 进死链通道且 clip 还原 %ZZ 原文', () => {
      const html = renderMarkdown('[z](docs/%ZZ.md)');
      assert.ok(html.includes('md-file-link--dead'), `%ZZ 经 %25ZZ 重编码解码不抛，应进死链通道，实际：${html}`);
      assert.strictEqual(clipOf18(html), 'docs/%ZZ.md', 'data-clip-path 应为解码还原的原始相对路径');
    });
    check('A4-6b 未设根 + 不完整 UTF-8 转义（%E4%B8）：decodeURIComponent 抛 URIError → 不进死链通道（保持普通 <a>，不崩溃）', () => {
      const html = renderMarkdown('[z2](docs/%E4%B8.md)');
      assert.ok(!html.includes('md-file-link'), `解码失败不应进死链通道（回退基线 <a>），实际：${html}`);
      assert.ok(!html.includes('data-clip-path'), '解码失败不应产出 data-clip-path');
    });

    // —— A4-7 有根对照：相对链接正常解析，绝不带 --dead 类 ——
    const TMP_ROOT_18 = fs.realpathSync(os.tmpdir()).replace(/[\\/]+$/, '');
    check('A4-7 有根对照：[r](docs/a.md) → 正常 md-file-link（无 --dead）且 clip=根拼接', () => {
      setFileLinkWorkspaceRoot(TMP_ROOT_18);
      const html = renderMarkdown('[r](docs/a.md)');
      assert.ok(html.includes('md-file-link'), '有根相对链接应正常按钮化');
      assert.ok(!html.includes('md-file-link--dead'), '有根解析成功不得带死链类');
      assert.strictEqual(clipOf18(html), `${TMP_ROOT_18}\\docs\\a.md`);
      setFileLinkWorkspaceRoot(null); // 对照后即归零，不向后续检查遗留根状态
    });

    // —— A4-8b 未设根 + 编码态 '..'（round-002 fix-1 F2 对照钉，现状即绿）：%2e%2e 经
    // isPathLikeRelativeHref 词面判定按相对形态进死链通道、clip 解码还原 '../a.md'——设计决定：
    // 可见反馈优先（2026-11-06 审查裁定），此处钉死防回归 ——
    check("A4-8b 未设根 + 编码态 '..'：[x](%2e%2e/a.md) → 进死链通道（md-file-link--dead）且 clip === '../a.md'（设计决定：编码态 .. 视同相对死链，可见反馈优先（2026-11-06 审查裁定））", () => {
      setFileLinkWorkspaceRoot(null);
      const html = renderMarkdown('[x](%2e%2e/a.md)');
      assert.ok(html.includes('md-file-link--dead'), `编码态 '..' 应进死链通道（对照钉，现状即绿），实际：${html}`);
      assert.strictEqual(clipOf18(html), '../a.md', "data-clip-path 应为解码还原的 '../a.md'");
    });

    // —— A4-8 结构钉：markdown.ts 死链分支 + 抽屉预检接线（RED：A4 未实施） ——
    check('结构钉：markdown.ts 死链分支（md-file-link--dead / isPathLikeRelativeHref 接线）', () => {
      const src = fs.readFileSync(new URL('../src/renderer/utils/markdown.ts', import.meta.url), 'utf8');
      assert.ok(src.includes('md-file-link--dead'), 'markdown.ts 缺 md-file-link--dead 死链类');
      assert.ok(src.includes('isPathLikeRelativeHref'), 'markdown.ts 未接线 isPathLikeRelativeHref');
    });
    check('结构钉：FilePreviewDrawer.vue load() 预检（isAbsolutePathForm + 未设根错误文案）', () => {
      const src = fs.readFileSync(new URL('../src/renderer/components/preview/FilePreviewDrawer.vue', import.meta.url), 'utf8');
      assert.ok(src.includes('isAbsolutePathForm'), 'FilePreviewDrawer.vue 未接线 isAbsolutePathForm 预检');
      assert.ok(src.includes('无法定位文件：当前会话未设置工作区根，相对路径无法解析'), 'FilePreviewDrawer.vue 缺未设根预检错误文案');
    });
    // —— round-002 fix-3 F5 结构钉 2 检：getter 导出 + 预检文案按根状态条件化 ——
    check('结构钉：markdown.ts 导出 getFileLinkWorkspaceRoot（round-002 fix-3 F5）', () => {
      const src = fs.readFileSync(new URL('../src/renderer/utils/markdown.ts', import.meta.url), 'utf8');
      assert.ok(src.includes('export function getFileLinkWorkspaceRoot'), 'markdown.ts 缺 getFileLinkWorkspaceRoot 导出（F5 文案条件化依赖）');
    });
    check('结构钉：FilePreviewDrawer.vue 预检双文案并存（未设根文案 + 已设根相对路径文案，round-002 fix-3 F5）', () => {
      const src = fs.readFileSync(new URL('../src/renderer/components/preview/FilePreviewDrawer.vue', import.meta.url), 'utf8');
      assert.ok(src.includes('当前会话未设置工作区根'), 'FilePreviewDrawer.vue 缺未设根文案字面');
      assert.ok(src.includes('预览目标需要绝对路径'), 'FilePreviewDrawer.vue 缺已设根相对路径文案字面');
    });

    setFileLinkWorkspaceRoot(null); // 收尾归零：不向后续分组遗留根状态
  }

  console.log('\n=== ⑲ A4 抽屉预检形态判定（isAbsolutePathForm 单元组） ===');
  check('绝对四形态：盘符反斜杠 / 盘符正斜杠 / UNC / POSIX 根 → true', () => {
    assert.strictEqual(isAbsolutePathForm('C:\\ws\\a.md'), true);
    assert.strictEqual(isAbsolutePathForm('C:/ws/a.md'), true);
    assert.strictEqual(isAbsolutePathForm('\\\\srv\\share\\a.md'), true);
    assert.strictEqual(isAbsolutePathForm('/usr/local/a.md'), true);
  });
  check('相对形态：子目录 / ./ 前缀 / 裸名 / 盘符相对（C:foo）→ false（主进程无法独立定位）', () => {
    assert.strictEqual(isAbsolutePathForm('docs/a.md'), false);
    assert.strictEqual(isAbsolutePathForm('./a.md'), false);
    assert.strictEqual(isAbsolutePathForm('a.md'), false);
    assert.strictEqual(isAbsolutePathForm('C:foo.md'), false);
  });
  check('空值边界：空串 / 纯空白 → false', () => {
    assert.strictEqual(isAbsolutePathForm(''), false);
    assert.strictEqual(isAbsolutePathForm('   '), false);
  });
  check('首尾空白容错：\' C:\\ws\\a.md \' → true（trim 后判定，同 store.path 消费侧宽松度）', () => {
    assert.strictEqual(isAbsolutePathForm(' C:\\ws\\a.md '), true);
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
})().catch((e: unknown) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
