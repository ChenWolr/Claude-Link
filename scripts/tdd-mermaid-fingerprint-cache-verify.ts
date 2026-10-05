// tdd-mermaid-fingerprint-cache-verify.ts
// A8（D05-F2，P2）契约钉：enrich-markdown 对 .mermaid 块增加内容指纹缓存。
//
// 根因：流式期间 v-html 每 50ms 整树替换（StreamRenderer 全量重渲），新 .mermaid-block 无任何
// dataset 状态——enrich-markdown 去重状态机（data-mermaid-state/-source/error-source 早退）失效：
// 已完成图每帧「闪回源码→重渲 SVG」，未完成图每帧重 parse。CPU 随图数×帧数膨胀。
//
// 修复语义：模块级 LRU 缓存（键 = 主题 id + 内容指纹，值 = 已渲染 SVG 字符串）。渲染前命中
// 则同步注入缓存 SVG（在置 loading 态之前——mounted/updated 到注入全程微任务内，不产生源码帧），
// 并重盖唯一 aria title id；未命中走既有渲染路径，成功后写入缓存。失败态不缓存（防毒化）；
// 未完成图 parse 必失败同样不入缓存；缓存上限 64（LRU 命中刷新 recency）；键含主题，
// 主题切换（未来接入）强制全量重渲。串行队列/生命周期守卫/无障碍契约不动。
//
// P3-13 追加（2026-10-02 对抗 review）：缓存命中路径的 addMermaidSvgAccessibility 复用
// 未自增的 renderCounter（只有 fresh 渲染路径自增），同批多图命中（或与仍在 DOM 的上次
// 渲染）撞同一 title id → aria-labelledby 指错图题。修复：title id 的自增收敛到
// addMermaidSvgAccessibility 内部（两条路径统一唯一化）。
//
// 运行：npx tsx scripts/tdd-mermaid-fingerprint-cache-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { MermaidSvgCache, mermaidCacheKey } from '../src/renderer/directives/enrich-markdown';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const src = readFileSync(new URL('../src/renderer/directives/enrich-markdown.ts', import.meta.url), 'utf8');

console.log('\n=== A8-①：LRU 缓存行为（容量上限 + 命中刷新 recency） ===');
check('容量上限 64：超出淘汰最旧条目', () => {
  const cache = new MermaidSvgCache(64);
  for (let i = 0; i < 64; i++) cache.set(`k${i}`, `svg${i}`);
  assert.equal(cache.size, 64);
  cache.set('k64', 'svg64'); // 挤出 k0
  assert.equal(cache.size, 64);
  assert.equal(cache.get('k0'), null, '最旧条目未被淘汰');
  assert.equal(cache.get('k64'), 'svg64');
});
check('get 命中刷新 recency：近期命中者不因新写入被淘汰', () => {
  const cache = new MermaidSvgCache(2);
  cache.set('a', '1');
  cache.set('b', '2');
  assert.equal(cache.get('a'), '1'); // a 刷新为最新
  cache.set('c', '3'); // 淘汰 b（最旧），保留 a
  assert.equal(cache.get('a'), '1');
  assert.equal(cache.get('b'), null);
});
check('键不存在返回 null（与缓存值空串语义区分）', () => {
  const cache = new MermaidSvgCache(4);
  assert.equal(cache.get('missing'), null);
});

console.log('\n=== A8-②：内容指纹键（主题 + hash） ===');
check('同内容同主题键稳定；不同内容/不同主题键不同', () => {
  const raw = 'graph TD; A-->B;';
  assert.equal(mermaidCacheKey(raw, 'neutral'), mermaidCacheKey(raw, 'neutral'));
  assert.notEqual(mermaidCacheKey(raw, 'neutral'), mermaidCacheKey(raw + ' ', 'neutral'), '不同内容键碰撞');
  assert.notEqual(mermaidCacheKey(raw, 'neutral'), mermaidCacheKey(raw, 'dark'), '键须含主题（主题切换强制重渲）');
});
check('键对多字节内容区分（中文/emoji 不与 ASCII 碰撞）', () => {
  assert.notEqual(mermaidCacheKey('图表甲', 't'), mermaidCacheKey('图表乙', 't'));
  assert.notEqual(mermaidCacheKey('😀'.repeat(3), 't'), mermaidCacheKey('😀'.repeat(4), 't'));
});

console.log('\n=== A8-③：指令集成形态（同步命中注入 + 失败不缓存 + 串行队列不动） ===');
check('缓存命中路径先于 loading 态（同步注入，不产生源码回退帧）', () => {
  const fnIdx = src.indexOf('async function renderOneMermaidBlock');
  const body = src.slice(fnIdx, src.indexOf('function renderMermaidBlocks', fnIdx));
  const hitIdx = body.indexOf('mermaidSvgCache.get(');
  const loadingIdx = body.indexOf("block.dataset.mermaidState = 'loading'");
  assert.ok(hitIdx > -1, '缺缓存命中查询');
  assert.ok(loadingIdx > -1 && hitIdx < loadingIdx, '命中查询必须先于 loading 态置位（同步注入语义）');
  assert.match(body, /mermaidSvgCache\.set\(\s*mermaidCacheKey\(raw, MERMAID_THEME_ID\)/, '渲染成功后未写入缓存');
});
check('失败态不缓存（防毒化）：catch 分支无 cache.set', () => {
  const fnIdx = src.indexOf('async function renderOneMermaidBlock');
  const body = src.slice(fnIdx, src.indexOf('function renderMermaidBlocks', fnIdx));
  const catchIdx = body.indexOf('} catch {');
  const catchBody = body.slice(catchIdx);
  assert.ok(!catchBody.includes('mermaidSvgCache.set'), '错误分支不得写缓存');
});
check('缓存键含主题且与 initialize 主题同源（MERMAID_THEME_ID 单源）', () => {
  assert.match(src, /const MERMAID_THEME_ID = 'neutral'/, '缺主题单源常量');
  assert.match(src, /theme: MERMAID_THEME_ID/, 'initialize 未用单源主题');
  assert.match(src, /mermaidCacheKey\(raw, MERMAID_THEME_ID\)/, '缓存键未含单源主题');
});
check('既有契约不回退：模块级串行队列 / for..of 串行 / aria 接线保留', () => {
  assert.match(src, /let\s+mermaidQueue/, '串行队列被破坏');
  assert.match(src, /mermaidQueue\s*=\s*mermaidQueue\.then/, '队列链式串行被破坏');
  assert.match(src, /for\s*\(\s*const\s+block\s+of\s+blocks/, 'for..of 串行被破坏');
  assert.match(src, /setAttribute\('aria-labelledby'/, 'aria 接线被破坏');
});

console.log('\n=== P3-13（2026-10-02 对抗 review）：缓存命中路径 aria title id 唯一化 ===');
check('title id 生成处（addMermaidSvgAccessibility）自增 renderCounter——命中路径不复用旧值', () => {
  const fnIdx = src.indexOf('function addMermaidSvgAccessibility');
  assert.ok(fnIdx > -1, '缺 addMermaidSvgAccessibility');
  const body = src.slice(fnIdx, src.indexOf('\n}', fnIdx));
  const titleTplIdx = body.indexOf('mermaid-svg-title-');
  assert.ok(titleTplIdx > -1, '缺 title id 模板');
  assert.ok(
    /renderCounter\s*\+=|renderCounter\+\+|\+\+renderCounter/.test(body.slice(0, titleTplIdx)),
    'title id 模板之前须自增 renderCounter（缓存命中路径原先复用未自增值，同批多图撞 id、aria-labelledby 指错图题）',
  );
});
check('两路径统一经 addMermaidSvgAccessibility（fresh 渲染 + 缓存命中同步注入）', () => {
  const fnIdx = src.indexOf('async function renderOneMermaidBlock');
  const body = src.slice(fnIdx, src.indexOf('function renderMermaidBlocks', fnIdx));
  const calls = body.split('addMermaidSvgAccessibility(block, raw)').length - 1;
  assert.ok(calls >= 2, `renderOneMermaidBlock 须在 fresh 与命中两路径各调用一次（当前 ${calls}）`);
  const hitIdx = body.indexOf('mermaidSvgCache.get(');
  const loadingIdx = body.indexOf("block.dataset.mermaidState = 'loading'");
  const hitCallIdx = body.indexOf('addMermaidSvgAccessibility(block, raw)', hitIdx);
  assert.ok(hitIdx > -1 && hitCallIdx > -1 && hitCallIdx < loadingIdx, '命中路径的调用须在命中分支内（loading 态之前）');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
