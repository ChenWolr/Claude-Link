// 会话导出长图纯逻辑验证（v3 第 15 节契约）。
// 覆盖：文件名、turn/分页、像素预算、尾段裁剪、进度/结果。
// 确定种子随机用例验证分页 ID 与物理像素区间不丢、不重、能收敛。
// 运行：npx tsx scripts/export-image-verify.ts（由 npm run selftest 串联）。

import { strict as assert } from 'node:assert';
import {
  buildExportFilename,
  buildStableUnits,
  checkPixelBudget,
  checkSnapshotBudget,
  computeProgressPercent,
  computeSegmentHeight,
  DEFAULT_EXPORT_BUDGET,
  deriveMaxPageHeightCss,
  estimateMessageWeight,
  ExportResults,
  flattenPageUnitIds,
  isStaleEvent,
  paginate,
  planInitialPages,
  placeSegment,
  sanitizeSessionName,
  splitTurnIndices,
  toRenderable,
  verifyPagePlan,
  verifyStableUnitIds,
} from '../src/shared/export-image';
import type {
  ExportImagePhase,
  PageRange,
  PaginationBudget,
  RenderableMessage,
  StableUnit,
  StableUnitInput,
} from '../src/shared/types/export-image';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// 确定性 RNG（mulberry32），保证可复现。
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function msg(id: string, partial: Partial<RenderableMessage>): RenderableMessage {
  return {
    id,
    sessionId: 's1',
    role: 'user',
    content: '',
    eventType: null,
    costUsd: null,
    durationMs: null,
    processKind: null,
    parentAgentId: null,
    toolUseId: null,
    title: null,
    isError: false,
    createdAt: '2026-07-20T00:00:00.000Z',
    ...partial,
  };
}

function unitInput(kind: 'message' | 'fold', msgs: RenderableMessage[]): StableUnitInput {
  return { kind, firstMessageId: msgs[0].id, messages: msgs };
}

// =====================================================================
console.log('\n=== 1) 文件名净化 ===');
{
  check('去掉非法字符 <>:"/\\|?*', sanitizeSessionName('a<b>:"c/d\\e|f?g*h') === 'abcdefgh');
  check('收拢连续空白', sanitizeSessionName('a   b\t\tc') === 'a b c');
  check('删除首尾点号空格', sanitizeSessionName(' .abc. ') === 'abc');
  check('空名回退 session', sanitizeSessionName('   ...   ') === 'session');
  check('全非法回退 session', sanitizeSessionName('<>:*?') === 'session');
  check('Windows 保留名 CON 加后缀', sanitizeSessionName('CON') === 'CON_');
  check('Windows 保留名 PRN.txt', sanitizeSessionName('PRN.txt') === 'PRN.txt_');
  check('普通名不变', sanitizeSessionName('我的会话') === '我的会话');
  // 中文 + emoji code point 截断（按码点非 UTF-16 单元）
  const longName = '会话'.repeat(50); // 100 码点
  const cut = sanitizeSessionName(longName);
  check('超长名截断到 80 码点', Array.from(cut).length === 80, `got ${Array.from(cut).length}`);
  const emojiName = '😀'.repeat(90); // 90 码点 emoji
  const emojiCut = sanitizeSessionName(emojiName);
  check('emoji 名按码点截断到 80', Array.from(emojiCut).length === 80, `got ${Array.from(emojiCut).length}`);
}
{
  check('单张文件名', buildExportFilename('我的会话', '20260720-153012') === '我的会话-20260720-153012.jpg');
  check('多张 01-of-03（两位宽）', buildExportFilename('s', '20260720-153012', 1, 3) === 's-20260720-153012-01-of-03.jpg');
  check('多张 totalPages=1 退化为单张', buildExportFilename('s', '20260720-153012', 1, 1) === 's-20260720-153012.jpg');
  check('多张 10-of-12（两位宽）', buildExportFilename('s', '20260720-153012', 10, 12) === 's-20260720-153012-10-of-12.jpg');
  let threw = false;
  try { buildExportFilename('s', 'bad-ts'); } catch { threw = true; }
  check('非法时间戳抛错', threw);
}

// =====================================================================
console.log('\n=== 2) turn 划分 + 可见权重 ===');
{
  // 第一条不是 user → prelude 归 turn 0
  const ms = [
    msg('m1', { role: 'system' }),
    msg('m2', { role: 'user', content: 'hello' }),
    msg('m3', { role: 'assistant', content: 'hi' }),
    msg('m4', { role: 'user', content: 'again' }),
    msg('m5', { role: 'assistant', content: 'ans' }),
  ];
  const turns = splitTurnIndices(ms);
  check('首条非 user 归 turn 0', turns[0] === 0);
  check('首条 user 开启 turn 1', turns[1] === 1);
  check('assistant 跟随当前 turn', turns[2] === 1);
  check('第二个 user 开启 turn 2', turns[3] === 2);
  check('turn 数正确', turns.join(',') === '0,1,1,2,2');
}
{
  check('纯文本权重 = 字符数', estimateMessageWeight(msg('x', { content: 'abcde' }), 6000) === 5);
  check('图片按 imageWeight 计', estimateMessageWeight(msg('x', { content: '![](http://a.png)![](b)' }), 6000) === 6000 * 2);
  check('空内容权重 0', estimateMessageWeight(msg('x', {}), 6000) === 0);
}

// =====================================================================
console.log('\n=== 3) 稳定单元 + 分页不变量 ===');
{
  // 构造 3 轮，每轮 1 个 user message + 1 个 assistant message（各自独立 message 单元）。
  const items: StableUnitInput[] = [];
  for (let t = 0; t < 3; t++) {
    items.push(unitInput('message', [msg(`u${t}`, { role: 'user', content: 'q'.repeat(100) })]));
    items.push(unitInput('message', [msg(`a${t}`, { role: 'assistant', content: 'a'.repeat(100) })]));
  }
  const { units, duplicateIds } = buildStableUnits(items, DEFAULT_EXPORT_BUDGET);
  check('稳定单元数 == 输入项数', units.length === items.length);
  check('无重复 ID', duplicateIds.length === 0);
  check('稳定 ID 带前缀', units[0].stableId === 'msg:u0' && units[1].stableId === 'msg:a0');
  check('verifyStableUnitIds 通过', verifyStableUnitIds(units).ok === true);
  check('turnIndex 正确（u0/a0=0, u1/a1=1）', units[0].turnIndex === 0 && units[2].turnIndex === 1);

  // 初始贪心：总权重 600（远小于 10000）→ 应合并尽可能多轮；目标 10000，6 单元 ×100 = 600 < 10000 → 单页。
  const initial = planInitialPages(units, DEFAULT_EXPORT_BUDGET);
  check('权重远小于目标 → 初始单页', initial.length === 1 && initial[0].startUnitIndex === 0 && initial[0].endUnitIndex === 6);

  // 确定性 measure：height = 权重 / 2。设 maxPageHeightCss=80 → 每单元 50px，两单元一页。
  const budget: PaginationBudget = { ...DEFAULT_EXPORT_BUDGET, maxPageHeightCss: 80 };
  const measure = (r: PageRange) => {
    let w = 0;
    for (let i = r.startUnitIndex; i < r.endUnitIndex; i++) w += units[i].weight;
    return w / 2;
  };
  const res = paginate(units, measure, budget);
  check('paginate ok', res.ok === true);
  if (res.ok) {
    const inv = verifyPagePlan(res.pages, units.length);
    check('分页不变量通过', inv.ok === true, inv.reason);
    check('每页 ≤ 2 单元（80px/50px）', res.pages.every((p) => p.endUnitIndex - p.startUnitIndex <= 2));
    check('扁平化 ID == 源 ID 序列', JSON.stringify(flattenPageUnitIds(res.pages, units)) === JSON.stringify(units.map((u) => u.stableId)));
  }
}
{
  // 单轮多单元 + 超预算 → 必须退到原子单元边界（无轮边界可切）。
  const items: StableUnitInput[] = [
    unitInput('message', [msg('u0', { role: 'user', content: 'x'.repeat(100) })]),
    unitInput('message', [msg('a0', { role: 'assistant', content: 'y'.repeat(100) })]),
    unitInput('message', [msg('a1', { role: 'assistant', content: 'z'.repeat(100) })]),
  ];
  const { units } = buildStableUnits(items, DEFAULT_EXPORT_BUDGET);
  const budget: PaginationBudget = { ...DEFAULT_EXPORT_BUDGET, maxPageHeightCss: 80 };
  const measure = (r: PageRange) => units.slice(r.startUnitIndex, r.endUnitIndex).reduce((s, u) => s + u.weight, 0) / 2;
  const res = paginate(units, measure, budget);
  check('单轮多单元超预算 → 按原子单元边界拆分', res.ok === true);
  if (res.ok) {
    check('拆分后无原子单元超限', res.pages.every((p) => p.endUnitIndex - p.startUnitIndex <= 2));
    check('不变量通过', verifyPagePlan(res.pages, units.length).ok);
  }
}
{
  // 单个原子单元超限 → 明确失败
  const items: StableUnitInput[] = [unitInput('message', [msg('u0', { role: 'user', content: 'x'.repeat(100) })])];
  const { units } = buildStableUnits(items, DEFAULT_EXPORT_BUDGET);
  const budget: PaginationBudget = { ...DEFAULT_EXPORT_BUDGET, maxPageHeightCss: 10 };
  const measure = () => 999; // 永远超
  const res = paginate(units, measure, budget);
  check('单个原子单元超限 → atomic-unit-over-budget', !res.ok && res.code === 'atomic-unit-over-budget' && res.unitStableId === 'msg:u0', JSON.stringify(res));
}
{
  // 超过 100 页 → too-many-pages（带 expectedPages）
  const items: StableUnitInput[] = [];
  for (let i = 0; i < 250; i++) items.push(unitInput('message', [msg(`u${i}`, { role: i % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(50) })]));
  const { units } = buildStableUnits(items, { ...DEFAULT_EXPORT_BUDGET, maxPageCount: 100 });
  // 每单元 25px，maxPageHeightCss=30 → 每页 1 单元 → 250 页
  const budget: PaginationBudget = { ...DEFAULT_EXPORT_BUDGET, maxPageHeightCss: 30, maxPageCount: 100 };
  const measure = (r: PageRange) => (r.endUnitIndex - r.startUnitIndex) * 25;
  const res = paginate(units, measure, budget);
  check('250 单元每页 1 → too-many-pages', !res.ok && res.code === 'too-many-pages' && res.expectedPages === 250, JSON.stringify(res));
}

// =====================================================================
console.log('\n=== 4) 像素预算 ===');
{
  // 100/125/150/200% 比例输入（contentWidth 896）
  for (const [label, scale] of [['100%', 1.0], ['125%', 1.25], ['150%', 1.5], ['200%', 2.0]] as const) {
    const w = Math.round(896 * scale);
    const h = 1000;
    const r = checkPixelBudget({ physicalWidth: w, physicalHeight: h, segmentCount: 4, maxSegmentRgbaBytes: 10 * 1024 * 1024 });
    check(`${label} 比例正常通过`, r.ok, r.reason);
  }
}
{
  // 高度上限触发
  const r = checkPixelBudget({ physicalWidth: 896, physicalHeight: 31000, segmentCount: 4, maxSegmentRgbaBytes: 1024 });
  check('物理高超 30000 触发', !r.ok && /物理宽或高/.test(r.reason || ''));
}
{
  // 总像素上限触发（896 × 30000 = 26.88M > 24M）
  const r = checkPixelBudget({ physicalWidth: 896, physicalHeight: 30000, segmentCount: 4, maxSegmentRgbaBytes: 1024 });
  check('总像素超 24M 触发', !r.ok && /总像素/.test(r.reason || ''), r.reason);
}
{
  // 工作集上限触发：pixelCount*10 + maxSegRgba 超 256MiB
  const r = checkPixelBudget({ physicalWidth: 4000, physicalHeight: 4000, segmentCount: 4, maxSegmentRgbaBytes: 200 * 1024 * 1024 });
  check('工作集超 256MiB 触发', !r.ok && /工作集/.test(r.reason || ''), r.reason);
}
{
  // 分段数上限触发（检查原始值，不 clamp）
  const r = checkPixelBudget({ physicalWidth: 896, physicalHeight: 1000, segmentCount: 121, maxSegmentRgbaBytes: 1024 });
  check('分段数 121 超 120 触发', !r.ok && /分段数/.test(r.reason || ''));
  const ok = checkPixelBudget({ physicalWidth: 896, physicalHeight: 1000, segmentCount: 120, maxSegmentRgbaBytes: 1024 });
  check('分段数 120 通过（不 clamp）', ok.ok);
}
{
  // deriveMaxPageHeightCss：1.5x、896 宽 → physicalWidth 1344，24M/1344 ≈ 17857
  const h = deriveMaxPageHeightCss(1.5, 896);
  check('deriveMaxPageHeightCss 1.5x', h > 10000 && h < 18000, `got ${h}`);
}

// =====================================================================
console.log('\n=== 5) 快照预算 ===');
{
  check('正常通过', checkSnapshotBudget({ messageCount: 2, messageUtf8Bytes: [10, 20], imageCount: 1 }).ok);
  check('消息数超限', !checkSnapshotBudget({ messageCount: 50001, messageUtf8Bytes: [], imageCount: 0 }).ok);
  check('单条字节超限', !checkSnapshotBudget({ messageCount: 1, messageUtf8Bytes: [17 * 1024 * 1024], imageCount: 0 }).ok);
  check('总字节超限', !checkSnapshotBudget({ messageCount: 2, messageUtf8Bytes: [33 * 1024 * 1024, 32 * 1024 * 1024], imageCount: 0 }).ok);
  check('图片数超限', !checkSnapshotBudget({ messageCount: 1, messageUtf8Bytes: [10], imageCount: 2001 }).ok);
  check('utf8 长度不一致', !checkSnapshotBudget({ messageCount: 2, messageUtf8Bytes: [10], imageCount: 0 }).ok);
}

// =====================================================================
console.log('\n=== 6) 单段几何（尾段裁剪）===');
{
  // 保守段高
  const big = computeSegmentHeight({ workAreaHeightCss: 2000 });
  check('workArea 2000 → 段高 1904', big.segmentHeightCss === 1904, `${big.segmentHeightCss}`);
  const small = computeSegmentHeight({ workAreaHeightCss: 500 });
  check('workArea 500 → 段高 404 夹到 480', small.segmentHeightCss === 480, `${small.segmentHeightCss}`);
  const huge = computeSegmentHeight({ workAreaHeightCss: 99999 });
  check('超大 workArea → 段高夹到 4000', huge.segmentHeightCss === 4000);
}
{
  // 首段顶对齐：cursor 0, scrollY 0
  const r = placeSegment({ cursorCss: 0, actualScrollYCss: 0, viewportWidthCss: 896, viewportHeightCss: 800, totalHeightCss: 2000, bitmapWidthPx: 896, bitmapHeightPx: 800 });
  check('首段顶对齐 ok', r.ok);
  check('首段 drawHeightCss=800', r.ok && r.drawHeightCss === 800);
  check('首段 destStartPx=0', r.ok && r.destStartPx === 0);
  check('首段 destEndPx=800', r.ok && r.destEndPx === 800);
  check('首段 sourceStartPx=0', r.ok && r.sourceStartPx === 0);
}
{
  // 短页面无法滚动：totalHeight < viewport → scrollY 恒 0，单段画完
  const r = placeSegment({ cursorCss: 0, actualScrollYCss: 0, viewportWidthCss: 896, viewportHeightCss: 800, totalHeightCss: 300, bitmapWidthPx: 896, bitmapHeightPx: 800 });
  check('短页面 drawHeightCss = totalHeight', r.ok && r.drawHeightCss === 300);
  check('短页面 nextCursor = totalHeight', r.ok && r.nextCursorCss === 300);
}
{
  // contentStart 非零：cursor 在视口中部
  const r = placeSegment({ cursorCss: 500, actualScrollYCss: 500, viewportWidthCss: 896, viewportHeightCss: 800, totalHeightCss: 3000, bitmapWidthPx: 896, bitmapHeightPx: 800 });
  check('contentStart 非零 sourceOffsetCss=0', r.ok && r.sourceOffsetCss === 0);
}
{
  // nextCursor <= cursor → 错误（drawHeightCss<=0）
  const r = placeSegment({ cursorCss: 3000, actualScrollYCss: 0, viewportWidthCss: 896, viewportHeightCss: 800, totalHeightCss: 3000, bitmapWidthPx: 896, bitmapHeightPx: 800 });
  check('末尾 cursor==totalHeight → 无可绘制 → 错误', !r.ok && /nextCursor/.test(r.reason || ''));
}
{
  // 非整数倍率：scaleY=1.25
  const r = placeSegment({ cursorCss: 0, actualScrollYCss: 0, viewportWidthCss: 896, viewportHeightCss: 800, totalHeightCss: 2000, bitmapWidthPx: 1120, bitmapHeightPx: 1000 });
  check('1.25x scaleY=1.25', r.ok && Math.abs(r.scaleY - 1.25) < 1e-6);
  check('1.25x destEndPx=1000', r.ok && r.destEndPx === 1000);
}
{
  // 确定种子随机：模拟顺序捕获，验证物理区间连续 + 末段边界精确。
  const rand = rng(20260720);
  let assertCount = 0;
  for (let trial = 0; trial < 200; trial++) {
    const total = Math.round(400 + rand() * 20000);
    const vp = Math.round(400 + rand() * 1200);
    const scale = 1 + rand() * 1.5; // 1.0–2.5
    const bitmapH = Math.round(vp * scale);
    const bitmapW = Math.round(896 * scale);
    const maxScroll = Math.max(0, total - vp);
    let cursor = 0;
    let prevDestEnd = 0;
    let lastDestEnd = 0;
    let guard = 0;
    let failed: string | null = null;
    while (cursor < total && guard++ < 500) {
      const actualScroll = Math.min(cursor, maxScroll);
      const r = placeSegment({ cursorCss: cursor, actualScrollYCss: actualScroll, viewportWidthCss: 896, viewportHeightCss: vp, totalHeightCss: total, bitmapWidthPx: bitmapW, bitmapHeightPx: bitmapH });
      if (!r.ok) { failed = `placeSegment failed at cursor ${cursor}: ${r.reason}`; break; }
      if (r.destStartPx !== prevDestEnd) { failed = `gap/overlap: prevDestEnd ${prevDestEnd} != destStart ${r.destStartPx} (cursor ${cursor})`; break; }
      if (r.drawHeightPx <= 0) { failed = `non-positive drawHeightPx at cursor ${cursor}`; break; }
      prevDestEnd = r.destEndPx;
      lastDestEnd = r.destEndPx;
      cursor = r.nextCursorCss;
    }
    const expectedFinal = Math.round(total * (bitmapH / vp));
    if (failed) { check(`随机 trial ${trial} 连续`, false, failed); assertCount++; if (assertCount > 3) break; continue; }
    if (lastDestEnd !== expectedFinal) {
      check(`随机 trial ${trial} 末段边界`, false, `lastDestEnd ${lastDestEnd} != expected ${expectedFinal} (total ${total}, scale ${scale.toFixed(3)})`);
      assertCount++;
      if (assertCount > 3) break;
      continue;
    }
  }
  check('200 次随机顺序捕获：区间连续 + 末段精确', assertCount === 0, `${assertCount} 次断言失败`);
}

// =====================================================================
console.log('\n=== 7) 进度 + 结果联合 ===');
{
  check('planning 不确定 → -1', computeProgressPercent('planning', 5, 10) === -1);
  check('preparing 不确定 → -1', computeProgressPercent('preparing', 0, 0) === -1);
  check('capturing 百分比', computeProgressPercent('capturing', 5, 10) === 50);
  check('百分比限定 0–100', computeProgressPercent('capturing', -5, 10) === 0 && computeProgressPercent('capturing', 99, 10) === 100);
  check('totalSteps<=0 → 0', computeProgressPercent('capturing', 5, 0) === 0);
  // 单调性：随 completedSteps 递增不倒退
  let prev = -1;
  let monotonic = true;
  for (let s = 0; s <= 100; s++) {
    const p = computeProgressPercent('capturing', s, 100);
    if (p < prev) monotonic = false;
    prev = p;
  }
  check('capturing 百分比单调', monotonic);
}
{
  check('迟到 jobId 丢弃', isStaleEvent('job-A', 'job-B') === true);
  check('当前 jobId 接受', isStaleEvent('job-A', 'job-A') === false);
  check('无当前 job → 丢弃', isStaleEvent('job-A', null) === true);
}
{
  const saved = ExportResults.saved(['/a.jpg']);
  const cancelled = ExportResults.cancelled();
  const failed = ExportResults.failed('write', 'disk full');
  check('saved 判别', saved.status === 'saved' && saved.paths.length === 1);
  check('cancelled 判别', cancelled.status === 'cancelled');
  check('failed 判别', failed.status === 'failed' && failed.code === 'write');
  check('三种结果互不混淆', saved.status !== cancelled.status && cancelled.status !== failed.status);
}
{
  // toRenderable 剥离 rawEvent/parentTaskId
  const full = { ...msg('x', { content: 'hi' }), rawEvent: '{}', parentTaskId: 't1' } as never;
  const r = toRenderable(full);
  check('toRenderable 保留 content', r.content === 'hi');
  check('toRenderable 无 rawEvent', !('rawEvent' in r));
  check('toRenderable 无 parentTaskId', !('parentTaskId' in r));
}

console.log(`\n=== export-image-verify 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) process.exit(1);
